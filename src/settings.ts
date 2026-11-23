import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_VOICE, isVoice, type VoiceId } from "./runtime.ts";

/** Имя файла в каталоге агента: одно состояние на все сессии и инстансы OMP. */
export const SETTINGS_FILE = "kokoro-ru.json";

export type SpeechSettings = { auto: boolean; voice: VoiceId };

export const DEFAULT_SETTINGS: SpeechSettings = { auto: false, voice: DEFAULT_VOICE };

function invalidFile(filePath: string): Error {
  return new Error(`Kokoro-ru: некорректный файл настроек: ${filePath}`);
}

/**
 * ENOENT — единственный легальный случай «файла нет»: возвращаются дефолты.
 * Битый JSON, не-объект, неизвестный голос или не-булев `auto` — ошибка; чтение
 * файл не чинит. Неизвестные дополнительные поля игнорируются.
 */
export async function readSettings(filePath: string): Promise<SpeechSettings> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidFile(filePath);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalidFile(filePath);
  const { auto, voice } = parsed as Record<string, unknown>;
  if (typeof auto !== "boolean" || typeof voice !== "string" || !isVoice(voice)) throw invalidFile(filePath);
  return { auto, voice };
}

/**
 * Атомарная замена: уникальный соседний tmp-файл + rename. При ошибке удаляется
 * только собственный tmp; старый целевой файл остается нетронутым, исходная ошибка
 * пробрасывается без маскирования.
 */
export async function writeSettings(filePath: string, settings: SpeechSettings): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(settings)}\n`, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}
