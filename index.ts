import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolve } from "node:path";
import { KokoroRuntime, type VoiceId } from "./src/runtime.ts";

const VOICES = ["sveta", "masha", "dima"] as const;
const DEFAULT_VOICE = "sveta";
const TEXT_LIMIT = 15_000;
const SAY_USAGE = "Использование: /say-ru [--voice sveta|masha|dima] <текст>";

type ReplyKey = { timestamp: number; responseId: string | undefined };
type Candidate = { key: ReplyKey; text: string };

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function validText(text: string): boolean { return text.length <= TEXT_LIMIT && text.trim().length > 0; }
function isVoice(voice: string): voice is VoiceId { return VOICES.some(id => id === voice); }

function parseSay(args: string): { text: string; voice: VoiceId } {
  const input = args.trimStart();
  if (!/^--voice(?:\s|$)/.test(input)) {
    if (!validText(args)) throw new Error(SAY_USAGE);
    return { text: args, voice: DEFAULT_VOICE };
  }
  const match = /^--voice\s+(\S+)\s+([\s\S]+)$/.exec(input);
  if (!match || !isVoice(match[1]) || !validText(match[2])) throw new Error(SAY_USAGE);
  return { voice: match[1], text: match[2] };
}

function matchesReply(key: ReplyKey, message: { timestamp: number; responseId?: string }): boolean {
  return key.timestamp === message.timestamp && key.responseId === message.responseId;
}

function limitSpeech(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  const high = text.charCodeAt(TEXT_LIMIT - 1);
  const low = text.charCodeAt(TEXT_LIMIT);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return text.slice(0, splitsPair ? TEXT_LIMIT - 1 : TEXT_LIMIT);
}

export default function activate(pi: ExtensionAPI): void {
  const runtime = new KokoroRuntime();
  const { z } = pi.zod;
  let auto = false;
  let fresh: ReplyKey | undefined;
  let candidate: Candidate | undefined;

  const clearReply = () => {
    fresh = undefined;
    candidate = undefined;
  };

  pi.registerCommand("say-ru", {
    description: "Озвучить русский текст локально через Kokoro-ru",
    async handler(args, ctx) {
      try {
        const { text, voice } = parseSay(args);
        const result = runtime.play(text, voice, "manual");
        ctx.ui.notify(`Kokoro-ru: озвучиваю (${voice})`, "info");
        void result.then(status => {
          if (status === "played") ctx.ui.notify("Kokoro-ru: воспроизведение завершено", "info");
        }, error => ctx.ui.notify(errorText(error), "error"));
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("speech-ru", {
    description: "Управлять автоозвучкой Kokoro-ru: on, off, status, stop",
    async handler(args, ctx) {
      try {
        switch (args.trim()) {
          case "on":
            if (ctx.mode !== "tui") throw new Error("Kokoro-ru: автоозвучка доступна только в интерактивном OMP");
            runtime.assertReady();
            auto = true;
            break;
          case "off":
            auto = false;
            candidate = undefined;
            runtime.stop("auto");
            break;
          case "status":
          case "":
            break;
          case "stop":
            ctx.ui.notify(runtime.stop()
              ? "Kokoro-ru: воспроизведение остановлено"
              : "Kokoro-ru: нет активного воспроизведения", "info");
            return;
          default:
            throw new Error("Использование: /speech-ru on|off|status|stop");
        }
        ctx.ui.notify(`Kokoro-ru: автоозвучка ${auto ? "включена" : "выключена"}`, "info");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "tts_ru",
    label: "Kokoro-ru TTS",
    description: "Локально синтезирует русский текст в mono PCM16 WAV (24 кГц) без проигрывания. Родительский каталог должен существовать. Голос по умолчанию: sveta.",
    approval: "write",
    loadMode: "essential",
    parameters: z.object({ text: z.string(), output_path: z.string(), voice_id: z.enum(VOICES).optional() }),
    async execute(_toolCallId, { text, output_path, voice_id = DEFAULT_VOICE }, signal, _onUpdate, ctx) {
      if (!validText(text)) throw new Error("Kokoro-ru: text должен содержать от 1 до 15000 единиц UTF-16 и не быть пустым");
      if (!isVoice(voice_id)) throw new Error("Kokoro-ru: неизвестный голос");
      if (!output_path.trim() || !output_path.toLowerCase().endsWith(".wav")) throw new Error("Kokoro-ru: output_path должен оканчиваться на .wav");
      const path = resolve(ctx.cwd, output_path);
      const bytes = await runtime.save(text, voice_id, path, signal);
      return {
        content: [{ type: "text", text: `Kokoro-ru: сохранено ${path} (${voice_id}, ${bytes} байт)` }],
        details: { path, voiceId: voice_id, bytes, sampleRate: 24000 },
      };
    },
  });

  pi.on("agent_start", () => {
    clearReply();
    runtime.stop("auto");
  });

  pi.on("turn_end", ({ message }) => {
    fresh = message.role === "assistant"
      ? { timestamp: message.timestamp, responseId: message.responseId }
      : undefined;
  });

  pi.on("session_stop", (event, ctx) => {
    candidate = undefined;
    if (!auto || ctx.mode !== "tui" || !fresh || event.signal.aborted ||
        event.session_id !== ctx.sessionManager.getSessionId()) return;
    const message = event.last_assistant_message;
    if (message?.role !== "assistant" || message.stopReason !== "stop" || !matchesReply(fresh, message)) return;
    const blocks: string[] = [];
    for (const block of message.content) {
      if (block.type === "toolCall") return;
      if (block.type === "text" && block.text.trim()) blocks.push(block.text);
    }
    if (blocks.length) candidate = { key: fresh, text: limitSpeech(blocks.join("\n\n")) };
  });

  pi.on("agent_end", (event, ctx) => {
    const reply = candidate;
    clearReply();
    if (!auto || ctx.mode !== "tui" || !reply || event.willContinue || event.awaitingAsyncWork) return;
    const last = event.messages.findLast(message => message.role === "assistant");
    if (!last || !matchesReply(reply.key, last)) return;

    const failure = (error: unknown) => {
      pi.logger.warn("Kokoro-ru: ошибка автоозвучки");
      ctx.ui.notify(errorText(error), "error");
    };
    try {
      void runtime.play(reply.text, DEFAULT_VOICE, "auto").catch(failure);
    } catch (error) {
      failure(error);
    }
  });

  pi.on("session_switch", () => {
    auto = false;
    clearReply();
    runtime.reset();
  });
  pi.on("session_clear", () => {
    clearReply();
    runtime.reset();
  });
  pi.on("session_shutdown", () => {
    clearReply();
    return runtime.shutdown();
  });
}
