import * as FileSystem from "expo-file-system/legacy";
import SherpaOnnx, {
  type AsrModelConfig,
  type KWSModelConfig,
  type SpeakerIdModelConfig,
} from "@siteed/sherpa-onnx.rn";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import {
  DEFAULT_ASR_DECODER_FILE,
  DEFAULT_ASR_ENCODER_FILE,
  DEFAULT_ASR_MODEL_DIR,
  DEFAULT_ASR_TOKENS_FILE,
  DEFAULT_KEYWORDS_FILE,
  DEFAULT_KWS_DECODER_FILE,
  DEFAULT_KWS_ENCODER_FILE,
  DEFAULT_KWS_JOINER_FILE,
  DEFAULT_KWS_MODEL_DIR,
  DEFAULT_KWS_TOKENS_FILE,
  DEFAULT_SPEAKER_MODEL_DIR,
  DEFAULT_SPEAKER_MODEL_FILE,
  checkAllSherpaModelReadiness,
  checkSherpaModelFiles,
  formatSherpaModelError,
  formatSherpaModelUserMessage,
  resolveSherpaModelDir,
  type SherpaModelKind,
} from "./sherpa-models";
import { KWS_KEYWORDS } from "./kws-keywords";

const DEFAULT_SAMPLE_RATE = 16000;

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function withResolvedModelDir<T extends { modelDir: string }>(config: T): T {
  return { ...config, modelDir: resolveSherpaModelDir(config.modelDir) };
}

async function ensureManagedKwsKeywords(modelDir: string, keywordsFile: string): Promise<void> {
  // Respect an explicitly configured external keywords file. The default file
  // is app-managed so upgrades can add safety keywords without making the user
  // redownload the large acoustic model.
  if (process.env.EXPO_PUBLIC_SHERPA_KEYWORDS_FILE) return;
  const modelDirInfo = await FileSystem.getInfoAsync(modelDir);
  if (!modelDirInfo.exists) return;
  const destination = `${modelDir}${keywordsFile}`;
  let current = "";
  try {
    current = await FileSystem.readAsStringAsync(destination);
  } catch {
    // Missing keywords file is repaired below; model readiness validates the rest.
  }
  if (current === KWS_KEYWORDS) return;
  await FileSystem.writeAsStringAsync(destination, KWS_KEYWORDS);
  recordDiagnosticEvent("kws", "keywords-updated", {
    keywordsFile,
    includesEmergencyStop: true,
  });
}

export type WhisperLanguageHint = "" | "ru" | "uk" | "en";

export function getSherpaAsrConfig(languageOverride?: WhisperLanguageHint): AsrModelConfig {
  return {
    modelDir: env("EXPO_PUBLIC_SHERPA_ASR_MODEL_DIR", DEFAULT_ASR_MODEL_DIR),
    modelType: "whisper",
    streaming: false,
    language: languageOverride ?? env("EXPO_PUBLIC_SHERPA_STT_LANGUAGE", ""),
    task: "transcribe",
    numThreads: parseIntEnv("EXPO_PUBLIC_SHERPA_NUM_THREADS", 2),
    decodingMethod: "greedy_search",
    modelFiles: {
      encoder: env("EXPO_PUBLIC_SHERPA_ASR_ENCODER_FILE", DEFAULT_ASR_ENCODER_FILE),
      decoder: env("EXPO_PUBLIC_SHERPA_ASR_DECODER_FILE", DEFAULT_ASR_DECODER_FILE),
      tokens: env("EXPO_PUBLIC_SHERPA_ASR_TOKENS_FILE", DEFAULT_ASR_TOKENS_FILE),
    },
    provider: "cpu",
  };
}

export function getSherpaKwsConfig(): KWSModelConfig {
  return {
    modelDir: env("EXPO_PUBLIC_SHERPA_KWS_MODEL_DIR", DEFAULT_KWS_MODEL_DIR),
    keywordsFile: env("EXPO_PUBLIC_SHERPA_KEYWORDS_FILE", DEFAULT_KEYWORDS_FILE),
    modelType: env("EXPO_PUBLIC_SHERPA_KWS_MODEL_TYPE", "zipformer2"),
    numThreads: parseIntEnv("EXPO_PUBLIC_SHERPA_NUM_THREADS", 2),
    provider: "cpu",
    maxActivePaths: parseIntEnv("EXPO_PUBLIC_SHERPA_KWS_MAX_ACTIVE_PATHS", 4),
    keywordsScore: parseFloatEnv("EXPO_PUBLIC_SHERPA_KWS_SCORE", 1.8),
    keywordsThreshold: parseFloatEnv("EXPO_PUBLIC_SHERPA_KWS_THRESHOLD", 0.2),
    numTrailingBlanks: parseIntEnv("EXPO_PUBLIC_SHERPA_KWS_TRAILING_BLANKS", 2),
    modelFiles: {
      encoder: env("EXPO_PUBLIC_SHERPA_KWS_ENCODER_FILE", DEFAULT_KWS_ENCODER_FILE),
      decoder: env("EXPO_PUBLIC_SHERPA_KWS_DECODER_FILE", DEFAULT_KWS_DECODER_FILE),
      joiner: env("EXPO_PUBLIC_SHERPA_KWS_JOINER_FILE", DEFAULT_KWS_JOINER_FILE),
      tokens: env("EXPO_PUBLIC_SHERPA_KWS_TOKENS_FILE", DEFAULT_KWS_TOKENS_FILE),
    },
  };
}

export function getSherpaSpeakerConfig(): SpeakerIdModelConfig {
  return {
    modelDir: env("EXPO_PUBLIC_SHERPA_SPEAKER_MODEL_DIR", DEFAULT_SPEAKER_MODEL_DIR),
    modelFile: env("EXPO_PUBLIC_SHERPA_SPEAKER_MODEL_FILE", DEFAULT_SPEAKER_MODEL_FILE),
    sampleRate: DEFAULT_SAMPLE_RATE,
    numThreads: parseIntEnv("EXPO_PUBLIC_SHERPA_NUM_THREADS", 2),
    provider: "cpu",
  };
}

export class SherpaVoiceAdapter {
  private asrReady = false;
  private kwsReady = false;
  private speakerReady = false;
  private asrConfigKey: string | null = null;
  private asrOperationTail: Promise<void> = Promise.resolve();
  private kwsInitializing: Promise<void> | null = null;

  async initializeAsr(config: AsrModelConfig = getSherpaAsrConfig()): Promise<void> {
    await this.runAsrExclusive(() => this.ensureAsrReady(config));
  }

  private async ensureAsrReady(config: AsrModelConfig): Promise<void> {
    const nativeConfig = withResolvedModelDir(config);
    const configKey = JSON.stringify(nativeConfig);
    if (this.asrReady && this.asrConfigKey === configKey) return;

    if (this.asrReady) {
      await SherpaOnnx.ASR.release().catch(() => ({ released: false }));
      this.asrReady = false;
      this.asrConfigKey = null;
    }

    const modelFiles = (nativeConfig.modelFiles ?? {}) as Record<string, string | undefined>;
    const requiredFiles = nativeConfig.modelType === "nemo_ctc"
      ? [modelFiles.model || "model.onnx", modelFiles.tokens || "tokens.txt"]
      : [
          modelFiles.encoder || DEFAULT_ASR_ENCODER_FILE,
          modelFiles.decoder || DEFAULT_ASR_DECODER_FILE,
          modelFiles.tokens || DEFAULT_ASR_TOKENS_FILE,
        ];
    await this.assertModelFilesReady("asr", nativeConfig.modelDir, requiredFiles);
    const result = await SherpaOnnx.ASR.initialize(nativeConfig);
    if (!result.success) {
      throw new Error(result.error || "Sherpa ASR initialization failed");
    }
    this.asrReady = true;
    this.asrConfigKey = configKey;
    recordDiagnosticEvent("whisper", "initialized", {
      language: nativeConfig.language || "auto",
      modelType: nativeConfig.modelType,
    });
  }

  async transcribeSamples(samples: number[], sampleRate = DEFAULT_SAMPLE_RATE): Promise<string> {
    if (samples.length === 0) return "";
    return this.transcribeSamplesWithLanguage(samples, sampleRate);
  }

  async transcribeSamplesWithLanguage(
    samples: number[],
    sampleRate = DEFAULT_SAMPLE_RATE,
    language?: WhisperLanguageHint
  ): Promise<string> {
    if (samples.length === 0) return "";
    return this.runAsrExclusive(async () => {
      const config = getSherpaAsrConfig(language);
      await this.ensureAsrReady(config);
      const result = await SherpaOnnx.ASR.recognizeFromSamples(sampleRate, samples);
      if (!result.success) {
        throw new Error(result.error || "Sherpa ASR recognition failed");
      }
      const transcript = result.text?.trim() || "";
      recordDiagnosticEvent("whisper", "recognition", {
        input: "samples",
        language: config.language || "auto",
        transcript: transcript || "(empty)",
        sampleRate,
        durationMs: Math.round((samples.length / sampleRate) * 1000),
      });
      return transcript;
    });
  }


  async transcribeFile(fileUri: string): Promise<string> {
    return this.runAsrExclusive(async () => {
      await this.ensureAsrReady(getSherpaAsrConfig());
      const result = await SherpaOnnx.ASR.recognizeFromFile(fileUri);
      if (!result.success) {
        throw new Error(result.error || "Sherpa ASR recognition failed");
      }
      const transcript = result.text?.trim() || "";
      recordDiagnosticEvent("whisper", "recognition", {
        input: "file",
        language: "auto",
        transcript: transcript || "(empty)",
      });
      return transcript;
    });
  }

  async releaseAsr(): Promise<void> {
    await this.runAsrExclusive(async () => {
      if (!this.asrReady) return;
      try {
        await SherpaOnnx.ASR.release();
      } finally {
        this.asrReady = false;
        this.asrConfigKey = null;
      }
    });
  }

  async initializeKws(config: KWSModelConfig = getSherpaKwsConfig()): Promise<void> {
    if (this.kwsReady) return;
    if (this.kwsInitializing) return this.kwsInitializing;
    this.kwsInitializing = this.initializeKwsInternal(config);
    try {
      await this.kwsInitializing;
    } finally {
      this.kwsInitializing = null;
    }
  }

  private async initializeKwsInternal(config: KWSModelConfig): Promise<void> {
    const nativeConfig = withResolvedModelDir(config);
    const modelFiles = nativeConfig.modelFiles ?? {};
    await ensureManagedKwsKeywords(
      nativeConfig.modelDir,
      nativeConfig.keywordsFile || DEFAULT_KEYWORDS_FILE
    );
    await this.assertModelFilesReady("kws", nativeConfig.modelDir, [
      modelFiles.encoder || DEFAULT_KWS_ENCODER_FILE,
      modelFiles.decoder || DEFAULT_KWS_DECODER_FILE,
      modelFiles.joiner || DEFAULT_KWS_JOINER_FILE,
      modelFiles.tokens || DEFAULT_KWS_TOKENS_FILE,
      nativeConfig.keywordsFile || DEFAULT_KEYWORDS_FILE,
    ]);
    const result = await SherpaOnnx.KWS.init(nativeConfig);
    if (!result.success) throw new Error(result.error || "Sherpa KWS initialization failed");
    this.kwsReady = true;
  }

  async acceptKwsSamples(samples: number[], sampleRate = DEFAULT_SAMPLE_RATE) {
    await this.initializeKws();
    const result = await SherpaOnnx.KWS.acceptWaveform(sampleRate, samples);
    if (!result.success) {
      throw new Error(result.error || "Sherpa KWS waveform processing failed");
    }
    return result;
  }

  async resetKwsStream(): Promise<void> {
    await this.initializeKws();
    const result = await SherpaOnnx.KWS.resetStream();
    if (!result.success) throw new Error("Sherpa KWS stream reset failed");
  }

  async releaseKws(): Promise<void> {
    await this.kwsInitializing?.catch(() => undefined);
    try {
      const result = await SherpaOnnx.KWS.release();
      if (!result.released) {
        console.warn("[SherpaVoiceAdapter] Native KWS release reported no active instance");
      }
    } finally {
      // Files/configuration can change immediately after release. Never retain
      // a stale ready bit even when the native release call itself rejects.
      this.kwsReady = false;
    }
  }

  async initializeSpeaker(config: SpeakerIdModelConfig = getSherpaSpeakerConfig()): Promise<void> {
    if (this.speakerReady) return;
    const nativeConfig = withResolvedModelDir(config);
    await this.assertModelFilesReady("speaker", nativeConfig.modelDir, [
      nativeConfig.modelFile || DEFAULT_SPEAKER_MODEL_FILE,
    ]);
    const result = await SherpaOnnx.SpeakerId.init(nativeConfig);
    if (!result.success) throw new Error(result.error || "Sherpa Speaker ID initialization failed");
    this.speakerReady = true;
  }

  async computeSpeakerEmbedding(samples: number[], sampleRate = DEFAULT_SAMPLE_RATE): Promise<number[]> {
    await this.initializeSpeaker();
    await SherpaOnnx.SpeakerId.resetStream().catch(() => undefined);
    try {
      const processResult = await SherpaOnnx.SpeakerId.processSamples(sampleRate, samples);
      if (!processResult.success) throw new Error(processResult.error || "Sherpa speaker sample processing failed");
      const embedding = await SherpaOnnx.SpeakerId.computeEmbedding();
      if (!embedding.success) throw new Error(embedding.error || "Sherpa speaker embedding failed");
      return embedding.embedding;
    } finally {
      await SherpaOnnx.SpeakerId.resetStream().catch(() => undefined);
    }
  }

  async computeSpeakerFileEmbedding(fileUri: string): Promise<number[]> {
    await this.initializeSpeaker();
    const result = await SherpaOnnx.SpeakerId.processFile(fileUri);
    if (!result.success) throw new Error(result.error || "Sherpa speaker file processing failed");
    return result.embedding;
  }

  async registerSpeaker(name: string, embedding: number[]): Promise<void> {
    await this.initializeSpeaker();
    const speakers = await SherpaOnnx.SpeakerId.getSpeakers();
    if (!speakers.success) throw new Error(speakers.error || "Sherpa speaker list failed");
    if (speakers.speakers.includes(name)) {
      const removed = await SherpaOnnx.SpeakerId.removeSpeaker(name);
      if (!removed.success) throw new Error(removed.error || "Sherpa speaker removal failed");
    }
    const result = await SherpaOnnx.SpeakerId.registerSpeaker(name, embedding);
    if (!result.success) throw new Error(result.error || "Sherpa speaker registration failed");
  }

  async hasSpeaker(name: string): Promise<boolean> {
    await this.initializeSpeaker();
    const result = await SherpaOnnx.SpeakerId.getSpeakers();
    if (!result.success) throw new Error(result.error || "Sherpa speaker list failed");
    return result.speakers.includes(name);
  }

  async removeSpeaker(name: string): Promise<void> {
    await this.initializeSpeaker();
    const result = await SherpaOnnx.SpeakerId.removeSpeaker(name);
    if (!result.success) throw new Error(result.error || "Sherpa speaker removal failed");
  }

  async verifySpeaker(name: string, embedding: number[], threshold: number): Promise<boolean> {
    await this.initializeSpeaker();
    const result = await SherpaOnnx.SpeakerId.verifySpeaker(name, embedding, threshold);
    if (!result.success) throw new Error(result.error || "Sherpa speaker verification failed");
    return result.verified;
  }

  async checkModelReadiness() {
    return checkAllSherpaModelReadiness();
  }

  private async assertModelFilesReady(
    kind: SherpaModelKind,
    modelDir: string,
    requiredFiles: string[]
  ): Promise<void> {
    const check = await checkSherpaModelFiles(kind, modelDir, requiredFiles);
    if (!check.ready) {
      console.warn(formatSherpaModelError(check));
      throw new Error(formatSherpaModelUserMessage(check));
    }
  }

  private async runAsrExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.asrOperationTail;
    let release: () => void = () => undefined;
    this.asrOperationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const sherpaVoiceAdapter = new SherpaVoiceAdapter();
