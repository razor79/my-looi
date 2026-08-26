import * as FileSystem from "expo-file-system/legacy";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { resolveSherpaModelDir } from "./sherpa-models";

const RETIRED_MODEL_DIRS = [
  "sherpa-onnx/asr/realtime-nemo-fastconformer-multilingual-20k",
  "sherpa-onnx/asr/whisper-base-multilingual-int8-v1",
  "sherpa-onnx/asr/gigaam-v2-russian-ctc-int8-v1",
] as const;

const RETIRED_CACHE_DIRS = [
  "looi-local-realtime-asr-v1/",
  "looi-local-whisper-base-v1/",
  "looi-local-gigaam-russian-v1/",
] as const;

const RETIRED_DOCUMENT_DIRS = [
  "looi-local-asr-diagnostics-v1/",
] as const;

/**
 * Remove assets from retired Local-ASR experiments. Shared Whisper Tiny, KWS,
 * VAD and speaker models are deliberately preserved because wake/command
 * handling still uses them.
 */
export async function removeRetiredExperimentalVoiceAssets(): Promise<void> {
  let removed = 0;

  for (const modelDir of RETIRED_MODEL_DIRS) {
    const uri = resolveSherpaModelDir(modelDir);
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    if (!info?.exists) continue;
    await FileSystem.deleteAsync(uri, { idempotent: true });
    removed += 1;
  }

  const cacheRoot = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? "";
  for (const relative of RETIRED_CACHE_DIRS) {
    if (!cacheRoot) break;
    const uri = `${cacheRoot}${relative}`;
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    if (!info?.exists) continue;
    await FileSystem.deleteAsync(uri, { idempotent: true });
    removed += 1;
  }

  const documentRoot = FileSystem.documentDirectory ?? "";
  for (const relative of RETIRED_DOCUMENT_DIRS) {
    if (!documentRoot) break;
    const uri = `${documentRoot}${relative}`;
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    if (!info?.exists) continue;
    await FileSystem.deleteAsync(uri, { idempotent: true });
    removed += 1;
  }

  recordDiagnosticEvent("runtime", "retired-experimental-voice-assets-cleanup", {
    removed,
    retainedSharedTiny: true,
    retainedWakeModels: true,
  });
}
