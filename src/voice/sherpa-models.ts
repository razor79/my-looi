import * as FileSystem from "expo-file-system/legacy";

export type SherpaModelKind = "asr" | "kws" | "speaker" | "vad";

export interface SherpaModelCheck {
  kind: SherpaModelKind;
  modelDir: string;
  absoluteModelDir: string;
  missingFiles: string[];
  ready: boolean;
}

const SHERPA_DOCUMENT_ROOT = `${FileSystem.documentDirectory ?? ""}sherpa-onnx/`;

export const DEFAULT_ASR_MODEL_DIR =
  "sherpa-onnx/asr/whisper-tiny-multilingual-int8-v1";
export const DEFAULT_ASR_ENCODER_FILE = "tiny-encoder.int8.onnx";
export const DEFAULT_ASR_DECODER_FILE = "tiny-decoder.int8.onnx";
export const DEFAULT_ASR_TOKENS_FILE = "tiny-tokens.txt";

export const DEFAULT_KWS_MODEL_DIR = "sherpa-onnx/kws/looi-multilingual-v2";
export const DEFAULT_KWS_ENCODER_FILE =
  "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx";
export const DEFAULT_KWS_DECODER_FILE =
  "decoder-epoch-13-avg-2-chunk-16-left-64.onnx";
export const DEFAULT_KWS_JOINER_FILE =
  "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx";
export const DEFAULT_KWS_TOKENS_FILE = "tokens.txt";
export const DEFAULT_KEYWORDS_FILE = "keywords.txt";

export const DEFAULT_SPEAKER_MODEL_DIR = "sherpa-onnx/speaker-id/looi";
export const DEFAULT_SPEAKER_MODEL_FILE = "model.onnx";
export const DEFAULT_VAD_MODEL_DIR = "sherpa-onnx/vad";
export const DEFAULT_VAD_MODEL_FILE = "silero_vad.onnx";

const SHERPA_MODEL_DOWNLOAD_HINT =
  "Открой настройки LOOI и скачай недостающие голосовые модели.";

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function resolveSherpaModelDir(modelDir: string): string {
  if (modelDir.startsWith("file://") || modelDir.startsWith("/")) {
    return modelDir.endsWith("/") ? modelDir : `${modelDir}/`;
  }

  const normalized = modelDir.replace(/^sherpa-onnx\//, "");
  return `${SHERPA_DOCUMENT_ROOT}${normalized.replace(/\/$/, "")}/`;
}

export function minimumSherpaModelFileBytes(filename: string): number {
  if (filename.endsWith(".onnx")) return 64 * 1024;
  if (filename.includes("token")) return 100;
  return 1;
}

export async function checkSherpaModelFiles(
  kind: SherpaModelKind,
  modelDir: string,
  requiredFiles: string[]
): Promise<SherpaModelCheck> {
  const absoluteModelDir = resolveSherpaModelDir(modelDir);
  const missingFiles: string[] = [];

  for (const filename of requiredFiles) {
    const info = await FileSystem.getInfoAsync(`${absoluteModelDir}${filename}`);
    if (!info.exists || (info.size ?? 0) < minimumSherpaModelFileBytes(filename)) {
      missingFiles.push(filename);
    }
  }

  return {
    kind,
    modelDir,
    absoluteModelDir,
    missingFiles,
    ready: missingFiles.length === 0,
  };
}

export function formatSherpaModelError(check: SherpaModelCheck): string {
  return [
    `Sherpa ${check.kind} model files are missing in ${check.absoluteModelDir}`,
    `Missing: ${check.missingFiles.join(", ")}`,
    SHERPA_MODEL_DOWNLOAD_HINT,
  ].join(". ");
}

export function formatSherpaModelUserMessage(check: SherpaModelCheck): string {
  const labelByKind: Record<SherpaModelKind, string> = {
    asr: "Распознавание речи",
    kws: "Распознавание имени LOOI",
    speaker: "Проверка голоса владельца",
    vad: "Определение конца фразы",
  };
  return `${labelByKind[check.kind]} недоступно. Скачай модели в настройках. Не хватает: ${check.missingFiles.join(", ")}`;
}

export async function checkAllSherpaModelReadiness(): Promise<{
  asr: SherpaModelCheck;
  kws: SherpaModelCheck;
  speaker: SherpaModelCheck;
  vad: SherpaModelCheck;
}> {
  const { installBundledSherpaModels } = await import("./sherpa-bundled-models");
  await installBundledSherpaModels().catch((error) => {
    console.warn("[SherpaModels] Failed to install bundled model assets:", error);
  });

  const asrModelDir = env("EXPO_PUBLIC_SHERPA_ASR_MODEL_DIR", DEFAULT_ASR_MODEL_DIR);
  const kwsModelDir = env("EXPO_PUBLIC_SHERPA_KWS_MODEL_DIR", DEFAULT_KWS_MODEL_DIR);
  const speakerModelDir = env(
    "EXPO_PUBLIC_SHERPA_SPEAKER_MODEL_DIR",
    DEFAULT_SPEAKER_MODEL_DIR
  );
  const vadModelDir = env("EXPO_PUBLIC_SHERPA_VAD_MODEL_DIR", DEFAULT_VAD_MODEL_DIR);

  return {
    asr: await checkSherpaModelFiles("asr", asrModelDir, [
      env("EXPO_PUBLIC_SHERPA_ASR_ENCODER_FILE", DEFAULT_ASR_ENCODER_FILE),
      env("EXPO_PUBLIC_SHERPA_ASR_DECODER_FILE", DEFAULT_ASR_DECODER_FILE),
      env("EXPO_PUBLIC_SHERPA_ASR_TOKENS_FILE", DEFAULT_ASR_TOKENS_FILE),
    ]),
    kws: await checkSherpaModelFiles("kws", kwsModelDir, [
      env("EXPO_PUBLIC_SHERPA_KWS_ENCODER_FILE", DEFAULT_KWS_ENCODER_FILE),
      env("EXPO_PUBLIC_SHERPA_KWS_DECODER_FILE", DEFAULT_KWS_DECODER_FILE),
      env("EXPO_PUBLIC_SHERPA_KWS_JOINER_FILE", DEFAULT_KWS_JOINER_FILE),
      env("EXPO_PUBLIC_SHERPA_KWS_TOKENS_FILE", DEFAULT_KWS_TOKENS_FILE),
      env("EXPO_PUBLIC_SHERPA_KEYWORDS_FILE", DEFAULT_KEYWORDS_FILE),
    ]),
    speaker: await checkSherpaModelFiles("speaker", speakerModelDir, [
      env("EXPO_PUBLIC_SHERPA_SPEAKER_MODEL_FILE", DEFAULT_SPEAKER_MODEL_FILE),
    ]),
    vad: await checkSherpaModelFiles("vad", vadModelDir, [
      env("EXPO_PUBLIC_SHERPA_VAD_MODEL_FILE", DEFAULT_VAD_MODEL_FILE),
    ]),
  };
}
