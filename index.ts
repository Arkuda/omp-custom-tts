import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { join, resolve } from "node:path";
import { DEFAULT_SETTINGS, readSettings, SETTINGS_FILE, writeSettings, type SpeechSettings } from "./src/settings.ts";
import { isVoice, KokoroRuntime, VOICES, type VoiceId } from "./src/runtime.ts";

const VOICE_LABELS: Record<VoiceId, string> = {
  sveta: "Света — женский",
  masha: "Маша — женский",
  dima: "Дима — мужской",
};
const SPEECH_ACTIONS = [
  { value: "voice", label: "voice", description: "Выбрать голос" },
  { value: "on", label: "on", description: "Включить автоозвучку" },
  { value: "off", label: "off", description: "Выключить автоозвучку" },
  { value: "status", label: "status", description: "Показать состояние и голос" },
  { value: "stop", label: "stop", description: "Остановить озвучку" },
  { value: "help", label: "help", description: "Показать команды и примеры" },
];
const TEXT_LIMIT = 15_000;
const SAY_USAGE = "Использование: /say-ru [--voice sveta|masha|dima] <текст>. Сменить голос: /speech-ru voice";
const SPEECH_USAGE = "Использование: /speech-ru [on|off|status|stop|voice [sveta|masha|dima]|help]";

type ReplyKey = { timestamp: number; responseId: string | undefined };
type Candidate = { key: ReplyKey; text: string };

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function validText(text: string): boolean { return text.length <= TEXT_LIMIT && text.trim().length > 0; }

function parseSay(args: string, selectedVoice: VoiceId): { text: string; voice: VoiceId } {
  const input = args.trimStart();
  if (!/^--voice(?:\s|$)/.test(input)) {
    if (!validText(args)) throw new Error(SAY_USAGE);
    return { text: args, voice: selectedVoice };
  }
  const match = /^--voice\s+(\S+)\s+([\s\S]+)$/.exec(input);
  if (!match || !isVoice(match[1]) || !validText(match[2])) throw new Error(SAY_USAGE);
  return { voice: match[1], text: match[2] };
}

function voiceCompletions(command: "voice" | "--voice", prefix: string) {
  return VOICES.filter(voice => voice.startsWith(prefix)).map(voice => ({
    value: `${command} ${voice}${command === "--voice" ? " " : ""}`,
    label: voice,
    description: VOICE_LABELS[voice],
  }));
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
  let auto = DEFAULT_SETTINGS.auto;
  let selectedVoice: VoiceId = DEFAULT_SETTINGS.voice;
  let fresh: ReplyKey | undefined;
  let candidate: Candidate | undefined;

  const clearReply = () => {
    fresh = undefined;
    candidate = undefined;
  };

  // Автоозвучка и голос — глобальные настройки в каталоге агента: они переживают
  // смену сессии и перезапуск OMP. Путь ленивый, чтобы не трогать каталог агента
  // до первого обращения к настройкам.
  const loadSettings = async (ctx: ExtensionContext): Promise<void> => {
    let settings: SpeechSettings;
    try {
      settings = await readSettings(join(pi.pi.getAgentDir(), SETTINGS_FILE));
    } catch (error) {
      settings = DEFAULT_SETTINGS;
      ctx.ui.notify(`${errorText(error)} — применены значения по умолчанию`, "warning");
    }
    auto = settings.auto;
    selectedVoice = settings.voice;
  };

  const saveSettings = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await writeSettings(join(pi.pi.getAgentDir(), SETTINGS_FILE), { auto, voice: selectedVoice });
    } catch (error) {
      ctx.ui.notify(`Kokoro-ru: в текущей сессии применено, но не сохранено: ${errorText(error)}`, "error");
    }
  };

  pi.registerCommand("say-ru", {
    description: "Озвучить текст: /say-ru [--voice <голос>] <текст>",
    getArgumentCompletions(prefix) {
      const input = prefix.trimStart();
      if (input === "--voice") return voiceCompletions("--voice", "");
      const voice = /^--voice\s+(\S*)$/.exec(input);
      if (voice) return voiceCompletions("--voice", voice[1]);
      return "--voice".startsWith(input)
        ? [{ value: "--voice ", label: "--voice", description: "Выбрать голос для этой фразы" }]
        : null;
    },
    async handler(args, ctx) {
      try {
        const { text, voice } = parseSay(args, selectedVoice);
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
    description: "Меню Kokoro-ru: автоозвучка, выбор голоса и справка",
    getArgumentCompletions(prefix) {
      const input = prefix.trimStart();
      const voice = /^voice\s+(\S*)$/.exec(input);
      return voice
        ? voiceCompletions("voice", voice[1])
        : SPEECH_ACTIONS.filter(action => action.value.startsWith(input)).map(action =>
          action.value === "voice" ? { ...action, value: "voice " } : action);
    },
    async handler(args, ctx) {
      try {
        let command = args.trim();
        if (!command && ctx.mode === "tui") {
          const choice = await ctx.ui.select(
            `Kokoro-ru: автоозвучка ${auto ? "включена" : "выключена"} · голос ${selectedVoice}`,
            SPEECH_ACTIONS.map(({ label, description }) => ({ label, description })),
          );
          if (!choice) return;
          command = choice;
        }
        const voice = /^voice(?:\s+(\S+))?$/.exec(command);
        if (voice) {
          let choice = voice[1];
          if (!choice && ctx.mode === "tui") {
            const picked = await ctx.ui.select(
              `Голос Kokoro-ru (сейчас ${selectedVoice})`,
              VOICES.map(label => ({ label, description: `${VOICE_LABELS[label]}${label === selectedVoice ? " · выбран" : ""}` })),
            );
            if (!picked) return;
            choice = picked;
          }
          if (!choice || !isVoice(choice)) throw new Error("Использование: /speech-ru voice sveta|masha|dima");
          selectedVoice = choice;
          await saveSettings(ctx);
          ctx.ui.notify(`Kokoro-ru: голос ${selectedVoice} (${VOICE_LABELS[selectedVoice]})`, "info");
          return;
        }
        switch (command) {
          case "on":
            if (ctx.mode !== "tui") throw new Error("Kokoro-ru: автоозвучка доступна только в интерактивном OMP");
            runtime.assertReady();
            auto = true;
            await saveSettings(ctx);
            break;
          case "off":
            auto = false;
            candidate = undefined;
            runtime.stop("auto");
            await saveSettings(ctx);
            break;
          case "status":
          case "":
            break;
          case "stop":
            ctx.ui.notify(runtime.stop()
              ? "Kokoro-ru: воспроизведение остановлено"
              : "Kokoro-ru: нет активного воспроизведения", "info");
            return;
          case "help":
            ctx.ui.notify(`${SPEECH_USAGE}\n${SAY_USAGE}\nПример: /say-ru --voice dima Привет, мир!`, "info");
            return;
          default:
            throw new Error(SPEECH_USAGE);
        }
        ctx.ui.notify(`Kokoro-ru: автоозвучка ${auto ? "включена" : "выключена"} · голос ${selectedVoice}`, "info");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "tts_ru",
    label: "Kokoro-ru TTS",
    description: "Локально синтезирует русский текст в mono PCM16 WAV (24 кГц) без проигрывания. Родительский каталог должен существовать. Без voice_id используется голос текущей сессии (изначально sveta).",
    approval: "write",
    loadMode: "essential",
    strict: false, // OpenAI strict schemas make voice_id required.
    parameters: z.object({ text: z.string(), output_path: z.string(), voice_id: z.enum(VOICES).optional() }),
    async execute(_toolCallId, { text, output_path, voice_id = selectedVoice }, signal, _onUpdate, ctx) {
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
      void runtime.play(reply.text, selectedVoice, "auto").catch(failure);
    } catch (error) {
      failure(error);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    await loadSettings(ctx);
  });
  pi.on("session_switch", async (_event, ctx) => {
    // Голос и автоозвучка — глобальные настройки: перечитываем файл вместо сброса
    // на дефолты. Останавливается только активный синтез прошлой сессии.
    clearReply();
    runtime.reset();
    await loadSettings(ctx);
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
