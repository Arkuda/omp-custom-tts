import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const VOICES = ["sveta", "masha", "dima"] as const;
export type VoiceId = typeof VOICES[number];
export const DEFAULT_VOICE: VoiceId = "sveta";

export function isVoice(voice: string): voice is VoiceId {
  return (VOICES as readonly string[]).includes(voice);
}

type PlayKind = "manual" | "auto";
type JobKind = PlayKind | "save";
type Job = { kind: JobKind; controller: AbortController; done?: Promise<unknown> };
type Install = { root: string; python: string };
type SpeechRequest = { text: string; voice: VoiceId } & ({ kind: PlayKind } | { kind: "save"; target: string });
type Reply = { ok: true; played: true } | { ok: true; skipped: true } | { ok: true; bytes: number } | { ok: false; error: string };
type Endpoint = { port: number; key: string };

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const DAEMON = join(PACKAGE, "kokoro_daemon.py");
const DAEMON_START_MS = 8_000;
const CANCEL_WAIT_MS = 1_000;
const LINE_LIMIT = 128 * 1024;
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
  return { root, python };
}

async function endpoint(root: string): Promise<Endpoint | undefined> {
  try {
    const state = JSON.parse(await readFile(join(root, "daemon-v1.json"), "utf8")) as Partial<Endpoint> | null;
    if (typeof state?.port === "number" && Number.isInteger(state.port) && state.port > 0 && state.port <= 65535 &&
        typeof state.key === "string" && /^[0-9a-f]{64}$/.test(state.key)) {
      return { port: state.port, key: state.key };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function decode(line: string): Reply | undefined {
  const value = JSON.parse(line) as Partial<{ ok: boolean; error: string; bytes: number; skipped: boolean; played: boolean }> | null;
  if (!value || typeof value !== "object" || Object.keys(value).length !== 2) return;
  if (value.ok === false && typeof value.error === "string" && value.error) return { ok: false, error: value.error };
  if (value.ok !== true) return;
  if (value.skipped === true) return { ok: true, skipped: true };
  if (value.played === true) return { ok: true, played: true };
  if (typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes > 0) {
    return { ok: true, bytes: value.bytes };
  }
}

function exchange(state: Endpoint, request: SpeechRequest, signal: AbortSignal): Promise<Reply | undefined> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<Reply | undefined>();
  const key = Buffer.from(state.key, "hex");
  const nonce = randomBytes(16).toString("hex");
  const proof = (role: "client" | "server") => createHmac("sha256", key).update(`${role}:${nonce}`).digest("hex");
  const socket = createConnection({ host: "127.0.0.1", port: state.port });
  let sentRequest = false;
  let done = false;
  let buffer = "";
  let timer = setTimeout(() => finish(), 500);
  function finish(reply?: Reply, error?: unknown): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    socket.destroy();
    if (signal.aborted) reject(signal.reason);
    else if (error || (!reply && sentRequest)) reject(error ?? new Error("Kokoro-ru: связь с демоном прервана"));
    else resolve(reply);
  }
  function cancel(): void {
    if (!sentRequest) finish();
    else {
      socket.write("!");
      timer = setTimeout(() => finish(), CANCEL_WAIT_MS);
    }
  }
  signal.addEventListener("abort", cancel, { once: true });
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(`${JSON.stringify({ nonce, auth: proof("client") })}\n`));
  socket.on("error", error => finish(undefined, sentRequest ? error : undefined));
  socket.on("close", () => finish());
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > LINE_LIMIT) {
      finish(undefined, sentRequest ? new Error("Kokoro-ru: слишком большой ответ демона") : undefined);
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      if (sentRequest) {
        const reply = decode(line);
        finish(reply, reply ? undefined : new Error("Kokoro-ru: неверный ответ демона"));
      } else if (JSON.parse(line)?.proof === proof("server")) {
        clearTimeout(timer);
        sentRequest = true;
        socket.write(`${JSON.stringify(request)}\n`);
      } else {
        finish();
      }
    } catch {
      finish(undefined, sentRequest ? new Error("Kokoro-ru: неверный ответ демона") : undefined);
    }
  });
  return promise;
}

async function submit(install: Install, request: SpeechRequest, signal: AbortSignal): Promise<Exclude<Reply, { ok: false }>> {
  const deadline = Date.now() + DAEMON_START_MS;
  let launched = false;
  let launchError: Error | undefined;
  do {
    signal.throwIfAborted();
    const state = await endpoint(install.root);
    if (state) {
      const reply = await exchange(state, request, signal);
      if (reply) {
        if (!reply.ok) throw new Error(reply.error);
        return reply;
      }
    }
    signal.throwIfAborted();
    if (!launched) {
      launched = true;
      const child = spawn(install.python, ["-X", "utf8", "-u", DAEMON, install.root], {
        cwd: install.root,
        detached: true, shell: false, windowsHide: true, stdio: "ignore",
      });
      child.once("error", error => { launchError = error; });
      child.unref();
    }
    if (launchError) throw new Error(`Kokoro-ru: не удалось запустить демон: ${launchError.message}`);
    await delay(80, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error("Kokoro-ru: демон не ответил при запуске");
}

export class KokoroRuntime {
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
        const reply = await submit(install, { text, voice, kind }, signal);
        if ("skipped" in reply) return "skipped";
        if (!("played" in reply)) throw new Error("Kokoro-ru: демон не подтвердил проигрывание");
        return "played";
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
    return this.#run("save", async ownSignal => {
      const signal = external ? AbortSignal.any([external, ownSignal]) : ownSignal;
      const reply = await submit(install, { text, voice, kind: "save", target }, signal);
      if (!("bytes" in reply)) throw new Error("Kokoro-ru: синтез не вернул WAV");
      return reply.bytes;
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
    await this.#active?.done?.catch(() => {});
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
}
