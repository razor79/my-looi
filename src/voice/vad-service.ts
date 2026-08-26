import { VAD } from "@siteed/sherpa-onnx.rn";
import {
  DEFAULT_VAD_MODEL_DIR,
  DEFAULT_VAD_MODEL_FILE,
  formatSherpaModelError,
  resolveSherpaModelDir,
  checkSherpaModelFiles,
} from "./sherpa-models";

type VadSegment = {
  startTime?: number;
  endTime?: number;
};

type VadResult = {
  success?: boolean;
  isSpeechDetected: boolean;
  segments?: VadSegment[];
  error?: string;
};

const VAD_SAMPLE_RATE = 16000;

export class VadService {
  private initialized = false;
  private initializing: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.initialized) {
      await this.reset();
      return;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = this.init();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async acceptSamples(samples: number[], sampleRate = VAD_SAMPLE_RATE): Promise<VadResult> {
    if (!this.initialized || samples.length === 0) {
      return { isSpeechDetected: false, segments: [] };
    }

    const result = await VAD.acceptWaveform(sampleRate, samples);
    if (result.success === false) {
      throw new Error(result.error || "Sherpa VAD waveform processing failed");
    }

    return result;
  }

  async reset(): Promise<void> {
    await VAD.reset();
  }

  async stop(): Promise<void> {
    if (!this.initialized && !this.initializing) return;
    await this.initializing?.catch(() => undefined);
    await VAD.release();
    this.initialized = false;
  }

  private async init(): Promise<void> {
    const modelDir = process.env.EXPO_PUBLIC_SHERPA_VAD_MODEL_DIR || DEFAULT_VAD_MODEL_DIR;
    const modelFile = process.env.EXPO_PUBLIC_SHERPA_VAD_MODEL_FILE || DEFAULT_VAD_MODEL_FILE;
    const check = await checkSherpaModelFiles("vad", modelDir, [modelFile]);
    if (!check.ready) {
      throw new Error(formatSherpaModelError(check));
    }

    const result = await VAD.init({
      modelDir: resolveSherpaModelDir(modelDir),
      modelFile,
      threshold: 0.45,
      minSilenceDuration: 1.0,
      minSpeechDuration: 0.3,
      windowSize: 512,
    });

    if (!result.success) {
      throw new Error(result.error || "Sherpa VAD initialization failed");
    }

    this.initialized = true;
  }
}

export const vadService = new VadService();
