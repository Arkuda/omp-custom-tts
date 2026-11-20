import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type VoiceId = "sveta" | "masha" | "dima";
type PlayKind = "manual" | "auto";
type JobKind = PlayKind | "save";
type Job = { kind: JobKind; controller: AbortController; done?: Promise<unknown> };
type Install = { root: string; python: string; windows: boolean };
type Synthesis = { text: string; voice: VoiceId; format: "plain" | "markdown"; output_path: string };
type WorkerReply = { ok: true; bytes: number } | { ok: true; skipped: true } | { ok: false; error: string };
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(PACKAGE, "kokoro_ru.py");
const WINSOUND = "import sys, winsound; winsound.PlaySound(sys.argv[1], winsound.SND_FILENAME | winsound.SND_NODEFAULT)";
const STDERR_LIMIT = 8192;
const CANCEL_GRACE_MS = 500;
const REQUEST_TIMEOUT_MS = 300_000;
const BUSY = "Kokoro-ru: другой запрос уже выполняется";

function installation(): Install {
  const windows = process.platform === "win32" && process.arch === "x64";
  const mac = process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64") &&
    Number.parseInt(release(), 10) >= 22;
  if (!windows && !mac) throw new Error("Kokoro-ru: требуется Windows x64 или macOS 13+ (Apple Silicon / Intel)");
  const variable = windows ? "LOCALAPPDATA" : "HOME";
  const base = process.env[variable];
  if (!base?.trim()) throw new Error(`Kokoro-ru: не задана переменная ${variable}`);
  const root = windows ? resolve(base, "omp-kokoro-ru") : resolve(base, "Library", "Application Support", "omp-kokoro-ru");
  const python = windows ? join(root, ".venv", "Scripts", "python.exe") : join(root, ".venv", "bin", "python");
  if (!existsSync(join(root, "ready-v1")) || !existsSync(python)) {
    const setup = join(PACKAGE, windows ? "setup.ps1" : "setup.sh");
    const command = windows
      ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${setup.replaceAll("'", "''")}'`
      : `sh '${setup.replaceAll("'", "'\\''")}'`;
    throw new Error(`Kokoro-ru: синтезатор не установлен. Запусти ${command}`);
  }
  return { root, python, windows };
}

class ManagedChild {
  readonly done: Promise<Exit>;
  #tail = Buffer.alloc(0);
  #exited = false;
  #killTimer?: NodeJS.Timeout;

  constructor(private readonly child: ChildProcess) {
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#tail = chunk.length >= STDERR_LIMIT
        ? Buffer.from(chunk.subarray(-STDERR_LIMIT))
        : Buffer.concat([this.#tail.subarray(Math.max(0, this.#tail.length + chunk.length - STDERR_LIMIT)), chunk]);
    });
    const { promise, resolve } = Promise.withResolvers<Exit>();
    this.done = promise;
    let error: Error | undefined;
    child.on("error", cause => { error = cause; });
    child.once("close", (code, signal) => {
      this.#exited = true;
      clearTimeout(this.#killTimer);
      resolve({ code, signal, error });
    });
  }

  stop(): void {
    if (this.#exited || this.#killTimer) return;
    this.child.kill("SIGTERM");
    this.#killTimer = setTimeout(() => this.child.kill("SIGKILL"), CANCEL_GRACE_MS);
  }

  diagnostic(label: string, exit?: Exit): Error {
    const status = exit?.error?.message ?? exit?.signal ?? exit?.code;
    const tail = this.#tail.toString("utf8").trim();
    return new Error(`${label}${status != null ? ` (${status})` : ""}${tail ? `: ${tail}` : ""}`);
  }
}

function decode(line: string): WorkerReply | undefined {
  const value = JSON.parse(line) as Partial<{ ok: boolean; error: string; bytes: number; skipped: boolean }> | null;
  if (!value || typeof value !== "object" || Object.keys(value).length !== 2) return;
  if (value.ok === false && typeof value.error === "string" && value.error) return { ok: false, error: value.error };
  if (value.ok === true && value.skipped === true) return { ok: true, skipped: true };
  if (value.ok === true && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes > 0) {
    return { ok: true, bytes: value.bytes };
  }
}

class WorkerClient {
  readonly #child;
  readonly #process: ManagedChild;
  #dead = false;
  #pending?: { receive: (reply: WorkerReply) => void; reject: (error: unknown) => void; markdown: boolean };

  constructor(install: Install) {
    this.#child = spawn(install.python, ["-X", "utf8", "-u", SCRIPT, "worker", install.root], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = new ManagedChild(this.#child);
    const lines = createInterface({ input: this.#child.stdout, terminal: false, crlfDelay: Infinity });
    lines.on("line", line => {
      if (this.#dead) return;
      let reply: WorkerReply | undefined;
      try { reply = decode(line); } catch { /* Invalid JSONL ends the connection. */ }
      const pending = this.#pending;
      if (!pending || !reply || (reply.ok && "skipped" in reply && !pending.markdown)) {
        this.#fail("Kokoro-ru: неожиданный ответ Python worker");
      } else {
        pending.receive(reply);
      }
    });
    lines.on("error", () => this.#fail("Kokoro-ru: ошибка чтения Python worker"));
    lines.on("close", () => {
      if (this.#child.pid !== undefined) this.#fail("Kokoro-ru: закрыт вывод Python worker");
    });
    this.#child.stdin.on("error", () => this.#fail("Kokoro-ru: обрыв канала Python worker"));
    void this.#process.done.then(exit => this.#fail("Kokoro-ru: Python worker завершился", exit));
  }

  get usable(): boolean { return !this.#dead; }

  request(message: Synthesis, signal: AbortSignal): Promise<WorkerReply> {
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<WorkerReply>();
    const timer = setTimeout(() => this.#fail("Kokoro-ru: таймаут синтеза (300 с)"), REQUEST_TIMEOUT_MS);
    const finish = () => {
      this.#pending = undefined;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => { void this.stop(signal.reason); };
    this.#pending = {
      markdown: message.format === "markdown",
      receive: reply => { finish(); resolve(reply); },
      reject: error => { finish(); void this.#process.done.then(() => reject(error)); },
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.#fail("Kokoro-ru: ошибка записи в Python worker");
    }
    return promise;
  }

  stop(reason: unknown): Promise<Exit> {
    if (!this.#dead) {
      this.#dead = true;
      this.#pending?.reject(reason);
      this.#process.stop();
    }
    return this.#process.done;
  }

  #fail(label: string, exit?: Exit): void {
    if (!this.#dead) void this.stop(this.#process.diagnostic(label, exit));
  }
}

async function playWav(install: Install, path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const executable = install.windows ? install.python : "/usr/bin/afplay";
  const args = install.windows ? ["-X", "utf8", "-c", WINSOUND, path] : [path];
  const player = new ManagedChild(spawn(executable, args, {
    shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
  }));
  const stop = () => player.stop();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const exit = await player.done;
    signal.throwIfAborted();
    if (exit.code !== 0 || exit.error) throw player.diagnostic("Kokoro-ru: ошибка проигрывания", exit);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export class KokoroRuntime {
  #worker?: WorkerClient;
  #active?: Job;
  #closed = false;

  assertReady(): void { this.#ready(); }

  play(text: string, voice: VoiceId, kind: PlayKind): Promise<"played" | "skipped"> {
    if (this.#active) {
      if (kind === "auto") return Promise.resolve("skipped");
      throw new Error(BUSY);
    }
    const install = this.#ready();
    return this.#run(kind, async signal => {
      try {
        const result = await this.#withStaging<"played" | "skipped">(tmpdir(), async path => {
          const reply = await this.#render(install, {
            text, voice, format: kind === "auto" ? "markdown" : "plain", output_path: path,
          }, signal);
          if ("skipped" in reply) return "skipped";
          await playWav(install, path, signal);
          return "played";
        });
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (signal.aborted) return "skipped";
        throw error;
      }
    });
  }

  save(text: string, voice: VoiceId, target: string, external?: AbortSignal): Promise<number> {
    if (this.#active) throw new Error(BUSY);
    external?.throwIfAborted();
    const install = this.#ready();
    return this.#run("save", ownSignal => {
      const signal = external ? AbortSignal.any([external, ownSignal]) : ownSignal;
      return this.#withStaging(dirname(target), async path => {
        const reply = await this.#render(install, { text, voice, format: "plain", output_path: path }, signal);
        if (!("bytes" in reply)) throw new Error("Kokoro-ru: синтез не вернул WAV");
        signal.throwIfAborted();
        await rename(path, target);
        return reply.bytes;
      });
    });
  }

  stop(kind?: PlayKind): boolean {
    const job = this.#active;
    if (!job || job.kind === "save" || (kind !== undefined && job.kind !== kind) || job.controller.signal.aborted) return false;
    job.controller.abort();
    return true;
  }

  reset(): void { this.#active?.controller.abort(); }

  async shutdown(): Promise<void> {
    this.#closed = true;
    this.reset();
    const worker = this.#worker;
    this.#worker = undefined;
    await Promise.allSettled([worker?.stop(new Error("Kokoro-ru: сессия завершена")), this.#active?.done]);
  }

  #ready(): Install {
    if (this.#closed) throw new Error("Kokoro-ru: сессия завершена");
    return installation();
  }

  #run<T>(kind: JobKind, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const job: Job = { kind, controller: new AbortController() };
    this.#active = job;
    const done = work(job.controller.signal).finally(() => { this.#active = undefined; });
    job.done = done;
    return done;
  }

  async #withStaging<T>(parent: string, work: (stagedPath: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(parent, "omp-kokoro-ru-"));
    try { return await work(join(dir, "speech.wav")); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }

  async #render(install: Install, message: Synthesis, signal: AbortSignal): Promise<Exclude<WorkerReply, { ok: false }>> {
    signal.throwIfAborted();
    if (!this.#worker?.usable) this.#worker = new WorkerClient(install);
    const reply = await this.#worker.request(message, signal);
    signal.throwIfAborted();
    if (!reply.ok) throw new Error(reply.error);
    return reply;
  }
}
