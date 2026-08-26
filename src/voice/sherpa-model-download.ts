import SherpaOnnx from "@siteed/sherpa-onnx.rn";
import * as FileSystem from "expo-file-system/legacy";
import {
  DEFAULT_ASR_DECODER_FILE,
  DEFAULT_ASR_ENCODER_FILE,
  DEFAULT_ASR_TOKENS_FILE,
  DEFAULT_KWS_DECODER_FILE,
  DEFAULT_KWS_ENCODER_FILE,
  DEFAULT_KWS_JOINER_FILE,
  DEFAULT_KWS_MODEL_DIR,
  DEFAULT_KWS_TOKENS_FILE,
  DEFAULT_KEYWORDS_FILE,
  DEFAULT_VAD_MODEL_FILE,
  checkAllSherpaModelReadiness,
  minimumSherpaModelFileBytes,
  resolveSherpaModelDir,
  type SherpaModelCheck,
} from "./sherpa-models";
import { installBundledSherpaModels } from "./sherpa-bundled-models";
import type { SherpaVoiceAdapter } from "./sherpa-adapter";
import { shouldDeleteManagedModelDir } from "./model-dir-guard";
import { KWS_KEYWORDS } from "./kws-keywords";

type DownloadStage =
  | "checking"
  | "asr-archive"
  | "asr-extract"
  | "asr-copy"
  | "kws-archive"
  | "kws-extract"
  | "kws-copy"
  | "vad"
  | "cleanup"
  | "verifying";

export type SherpaModelDownloadProgress = {
  stage: DownloadStage;
  label: string;
  progress: number;
};

type ProgressCallback = (progress: SherpaModelDownloadProgress) => void;

const DOWNLOAD_ROOT = `${
  FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ""
}sherpa-onnx-download-v3/`;
const ASR_ARCHIVE_PATH = `${DOWNLOAD_ROOT}sherpa-onnx-whisper-tiny.tar.bz2`;
const ASR_EXTRACT_ROOT = `${DOWNLOAD_ROOT}whisper/`;
const KWS_ARCHIVE_PATH = `${DOWNLOAD_ROOT}sherpa-onnx-kws-looi-en.tar.bz2`;
const KWS_EXTRACT_ROOT = `${DOWNLOAD_ROOT}kws/`;

const ASR_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2";
const KWS_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2";
const VAD_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";

// Keyword content is shared with runtime KWS migration.
function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const ASR_FILES = [
  {
    source: DEFAULT_ASR_ENCODER_FILE,
    destination: env("EXPO_PUBLIC_SHERPA_ASR_ENCODER_FILE", DEFAULT_ASR_ENCODER_FILE),
  },
  {
    source: DEFAULT_ASR_DECODER_FILE,
    destination: env("EXPO_PUBLIC_SHERPA_ASR_DECODER_FILE", DEFAULT_ASR_DECODER_FILE),
  },
  {
    source: DEFAULT_ASR_TOKENS_FILE,
    destination: env("EXPO_PUBLIC_SHERPA_ASR_TOKENS_FILE", DEFAULT_ASR_TOKENS_FILE),
  },
] as const;
const KWS_FILES = [
  {
    source: DEFAULT_KWS_ENCODER_FILE,
    destination: env("EXPO_PUBLIC_SHERPA_KWS_ENCODER_FILE", DEFAULT_KWS_ENCODER_FILE),
  },
  {
    source: DEFAULT_KWS_DECODER_FILE,
    destination: env("EXPO_PUBLIC_SHERPA_KWS_DECODER_FILE", DEFAULT_KWS_DECODER_FILE),
  },
  {
    source: DEFAULT_KWS_JOINER_FILE,
    destination: env("EXPO_PUBLIC_SHERPA_KWS_JOINER_FILE", DEFAULT_KWS_JOINER_FILE),
  },
  {
    source: DEFAULT_KWS_TOKENS_FILE,
    destination: env("EXPO_PUBLIC_SHERPA_KWS_TOKENS_FILE", DEFAULT_KWS_TOKENS_FILE),
  },
] as const;
const KWS_KEYWORDS_FILE = env("EXPO_PUBLIC_SHERPA_KEYWORDS_FILE", DEFAULT_KEYWORDS_FILE);

function emit(
  onProgress: ProgressCallback | undefined,
  stage: DownloadStage,
  label: string,
  progress: number
) {
  onProgress?.({ stage, label, progress: Math.max(0, Math.min(1, progress)) });
}

async function ensureDir(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
}

async function fileReady(uri: string, minimumBytes = 1): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  return Boolean(info.exists && (info.size ?? 0) >= minimumBytes);
}

async function downloadFile(
  url: string,
  destination: string,
  onProgress: ProgressCallback | undefined,
  stage: DownloadStage,
  label: string,
  force = false
): Promise<void> {
  if (!force && await fileReady(destination, minimumSherpaModelFileBytes(destination))) {
    emit(onProgress, stage, label, 1);
    return;
  }

  await ensureDir(destination.slice(0, destination.lastIndexOf("/") + 1));
  const partialDestination = `${destination}.part`;
  await FileSystem.deleteAsync(partialDestination, { idempotent: true });
  if (force) {
    await FileSystem.deleteAsync(destination, { idempotent: true });
  }
  const download = FileSystem.createDownloadResumable(
    url,
    partialDestination,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (totalBytesExpectedToWrite > 0) {
        emit(onProgress, stage, label, totalBytesWritten / totalBytesExpectedToWrite);
      }
    }
  );
  try {
    const result = await download.downloadAsync();
    if (!result?.uri || !(await fileReady(result.uri))) {
      throw new Error(`Не удалось скачать: ${label}`);
    }
    await FileSystem.deleteAsync(destination, { idempotent: true });
    await FileSystem.moveAsync({ from: result.uri, to: destination });
  } catch (error) {
    await FileSystem.deleteAsync(partialDestination, { idempotent: true }).catch(() => undefined);
    throw error;
  }
  emit(onProgress, stage, label, 1);
}

function withTrailingSlash(uri: string): string {
  return uri.endsWith("/") ? uri : `${uri}/`;
}

async function findExtractedFile(
  rootDir: string,
  filename: string,
  depth = 0
): Promise<string | null> {
  if (depth > 6) return null;
  const root = withTrailingSlash(rootDir);
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(root);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const uri = `${root}${entry}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) continue;
    const isDirectory = "isDirectory" in info && info.isDirectory;
    if (!isDirectory && entry === filename && (info.size ?? 0) > 0) return uri;
    if (isDirectory) {
      const found = await findExtractedFile(uri, filename, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function extractArchive(
  archivePath: string,
  extractRoot: string,
  stage: "asr-extract" | "kws-extract",
  label: string,
  onProgress?: ProgressCallback
): Promise<void> {
  await FileSystem.deleteAsync(extractRoot, { idempotent: true });
  await ensureDir(extractRoot);
  emit(onProgress, stage, label, 0.05);
  const result = await SherpaOnnx.Archive.extractTarBz2(archivePath, extractRoot);
  if (!result.success) throw new Error(result.message || `Не удалось распаковать: ${label}`);
  emit(onProgress, stage, label, 1);
}

async function installExtractedFiles(
  check: SherpaModelCheck,
  extractRoot: string,
  files: ReadonlyArray<{ source: string; destination: string }>,
  stage: "asr-copy" | "kws-copy",
  label: string,
  onProgress?: ProgressCallback
): Promise<void> {
  await ensureDir(check.absoluteModelDir);
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const destination = `${check.absoluteModelDir}${file.destination}`;
    if (!(await fileReady(destination, minimumSherpaModelFileBytes(file.destination)))) {
      const source = await findExtractedFile(extractRoot, file.source);
      if (!source) throw new Error(`${label}: в архиве нет ${file.source}`);
      await FileSystem.copyAsync({ from: source, to: destination });
    }
    emit(onProgress, stage, label, (index + 1) / files.length);
  }
}

async function downloadAsr(check: SherpaModelCheck, onProgress?: ProgressCallback) {
  if (check.ready) return;
  await ensureDir(DOWNLOAD_ROOT);
  await downloadFile(ASR_ARCHIVE_URL, ASR_ARCHIVE_PATH, onProgress, "asr-archive", "Whisper Tiny Multilingual", true);
  await extractArchive(ASR_ARCHIVE_PATH, ASR_EXTRACT_ROOT, "asr-extract", "Whisper Tiny Multilingual", onProgress);
  await installExtractedFiles(check, ASR_EXTRACT_ROOT, ASR_FILES, "asr-copy", "Установка Whisper", onProgress);
}

async function downloadKws(check: SherpaModelCheck, onProgress?: ProgressCallback) {
  const modelFilesMissing = check.missingFiles.some((file) => file !== KWS_KEYWORDS_FILE);
  if (modelFilesMissing) {
    await ensureDir(DOWNLOAD_ROOT);
    await downloadFile(KWS_ARCHIVE_URL, KWS_ARCHIVE_PATH, onProgress, "kws-archive", "Модель имени LOOI", true);
    await extractArchive(KWS_ARCHIVE_PATH, KWS_EXTRACT_ROOT, "kws-extract", "Модель имени LOOI", onProgress);
    await installExtractedFiles(check, KWS_EXTRACT_ROOT, KWS_FILES, "kws-copy", "Установка модели LOOI", onProgress);
  }
  await ensureDir(check.absoluteModelDir);
  await replaceTextFileAtomically(
    `${check.absoluteModelDir}${KWS_KEYWORDS_FILE}`,
    KWS_KEYWORDS
  );
}

async function replaceTextFileAtomically(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.new`;
  const backup = `${destination}.previous`;
  await FileSystem.deleteAsync(temporary, { idempotent: true });
  await FileSystem.deleteAsync(backup, { idempotent: true });
  await FileSystem.writeAsStringAsync(temporary, content);

  const current = await FileSystem.getInfoAsync(destination);
  if (current.exists) {
    await FileSystem.moveAsync({ from: destination, to: backup });
  }

  try {
    await FileSystem.moveAsync({ from: temporary, to: destination });
    await FileSystem.deleteAsync(backup, { idempotent: true });
  } catch (error) {
    if (current.exists) {
      await FileSystem.moveAsync({ from: backup, to: destination }).catch(() => undefined);
    }
    throw error;
  } finally {
    await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
  }
}

async function downloadSingleModel(
  check: SherpaModelCheck,
  url: string,
  filename: string,
  stage: "vad",
  label: string,
  onProgress?: ProgressCallback
) {
  if (check.ready) return;
  await ensureDir(check.absoluteModelDir);
  await downloadFile(url, `${check.absoluteModelDir}${filename}`, onProgress, stage, label);
}

async function cleanupManagedLegacyModels(
  activeKwsDir: string,
  onProgress?: ProgressCallback
): Promise<void> {
  emit(onProgress, "cleanup", "Удаление старых голосовых моделей", 0);
  const legacyDirs = [
    "sherpa-onnx/asr/streaming-paraformer",
    "sherpa-onnx/asr/sensevoice",
    "sherpa-onnx/punctuation",
    "sherpa-onnx/kws/looi",
    "sherpa-onnx/kws/looi-en-v1",
  ];
  for (let index = 0; index < legacyDirs.length; index += 1) {
    const legacyDir = resolveSherpaModelDir(legacyDirs[index]);
    if (!shouldDeleteManagedModelDir(legacyDir, activeKwsDir)) {
      console.log("[SherpaModels] Keeping active KWS directory during legacy cleanup", {
        activeKwsDir,
      });
    } else {
      await FileSystem.deleteAsync(legacyDir, {
        idempotent: true,
      }).catch(() => undefined);
    }
    emit(onProgress, "cleanup", "Удаление старых голосовых моделей", (index + 1) / legacyDirs.length);
  }
}

async function validateInstalledKws(
  sherpaVoiceAdapter: SherpaVoiceAdapter
): Promise<void> {
  try {
    await sherpaVoiceAdapter.initializeKws();
    await sherpaVoiceAdapter.resetKwsStream();
  } catch (error) {
    await sherpaVoiceAdapter.releaseKws().catch(() => undefined);
    throw error;
  }
  await sherpaVoiceAdapter.releaseKws();
}

export async function downloadMissingSherpaModels(onProgress?: ProgressCallback) {
  const [{ sherpaVoiceAdapter }, { kwsAudioFeeder }, { wakewordService }] = await Promise.all([
    import("./sherpa-adapter"),
    import("./kws-audio-feeder"),
    import("./wakeword"),
  ]);
  const restoreFeeder = kwsAudioFeeder.isRunning;
  await kwsAudioFeeder.stop().catch(() => undefined);
  await wakewordService.stop().catch(() => undefined);
  await sherpaVoiceAdapter.releaseKws().catch(() => undefined);

  try {
    emit(onProgress, "checking", "Проверка моделей", 0);
    await installBundledSherpaModels();
    const before = await checkAllSherpaModelReadiness();
    emit(onProgress, "checking", "Проверка моделей", 1);

    await downloadAsr(before.asr, onProgress);
    await downloadKws(before.kws, onProgress);
    // A non-empty file check is insufficient for keywords syntax or token
    // compatibility. Native init/reset is the acceptance gate for the newly
    // rewritten keywords file.
    await validateInstalledKws(sherpaVoiceAdapter);
    await downloadSingleModel(
      before.vad,
      VAD_MODEL_URL,
      env("EXPO_PUBLIC_SHERPA_VAD_MODEL_FILE", DEFAULT_VAD_MODEL_FILE),
      "vad",
      "Модель конца фразы",
      onProgress
    );

    emit(onProgress, "verifying", "Проверка установленных файлов", 0);
    const after = await checkAllSherpaModelReadiness();
    const stillMissing = [after.asr, after.kws, after.vad].filter(
      (item) => !item.ready
    );
    if (stillMissing.length > 0) {
      throw new Error(
        stillMissing.map((item) => `${item.kind}: ${item.missingFiles.join(", ")}`).join("; ")
      );
    }
    emit(onProgress, "verifying", "Проверка установленных файлов", 1);

    const activeKwsDir = resolveSherpaModelDir(
      env("EXPO_PUBLIC_SHERPA_KWS_MODEL_DIR", DEFAULT_KWS_MODEL_DIR)
    );
    await cleanupManagedLegacyModels(activeKwsDir, onProgress);
    await FileSystem.deleteAsync(DOWNLOAD_ROOT, { idempotent: true }).catch(() => undefined);
    return after;
  } finally {
    if (restoreFeeder) {
      await wakewordService.start().catch(() => undefined);
      await kwsAudioFeeder.start().catch((error) => {
        console.warn("[SherpaModels] Failed to restore wakeword feeder:", error);
      });
    }
  }
}
