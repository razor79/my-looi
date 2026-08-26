import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { recognizeWakePhraseSamples } from "./wake-phrase-recognizer";
import type { WakePhraseId } from "./wake-phrases";

const SAMPLE_RATE = 16000;
const PRE_ROLL_SAMPLES = Math.round(SAMPLE_RATE * 0.4);
const MIN_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * 0.55);
const IDLE_END_SILENCE_SAMPLES = Math.round(SAMPLE_RATE * 0.6);
const SPEAKING_END_SILENCE_SAMPLES = Math.round(SAMPLE_RATE * 0.25);
const RETAINED_TAIL_SILENCE_SAMPLES = Math.round(SAMPLE_RATE * 0.25);
const IDLE_MAX_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * 4.0);
const SPEAKING_MAX_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * 1.6);
const MAX_COMMAND_PREROLL_SAMPLES = Math.round(SAMPLE_RATE * 6.0);
const MAX_DEFERRED_SAMPLES = Math.round(SAMPLE_RATE * 30.0);
const DEFERRED_REPLAY_CHUNK_SAMPLES = Math.round(SAMPLE_RATE * 0.1);
const MIN_ENERGY_THRESHOLD = 0.01;
const MAX_ENERGY_THRESHOLD = 0.035;
const NOISE_MULTIPLIER = 2.8;

type SegmentProcessOutcome = "matched" | "unmatched" | "stale";

export type WhisperWakePhraseDetection = {
  phraseId: WakePhraseId;
  transcript: string;
  wakeSegmentSamples: number[];
  commandPrerollSamples: number[];
  hasCommandSuffix: boolean;
  sampleRate: number;
};

type DetectionCallback = (detection: WhisperWakePhraseDetection) => void;

/**
 * Low-cost idle fallback for phrases the English/Chinese KWS acoustic model
 * cannot represent faithfully. Energy segmentation runs synchronously; the
 * expensive offline Whisper call is detached so native KWS feeding never waits
 * for it.
 */
export class WakePhraseFallback {
  private enabled = false;
  private activeSegment = false;
  private segmentSamples: number[] = [];
  private preRollSamples: number[] = [];
  private trailingSilenceSamples = 0;
  private noiseRms = 0.004;
  private processingPromise: Promise<SegmentProcessOutcome> | null = null;
  private processingGeneration = 0;
  private deferredSamples: number[] = [];
  private deferredStartedAt: number | null = null;
  private deferredTruncated = false;
  private generation = 0;
  private speakingMode = false;

  start(): void {
    this.enabled = true;
    this.reset();
    recordDiagnosticEvent("runtime", "whisper-fallback-started");
  }

  stop(): void {
    this.enabled = false;
    this.reset();
    recordDiagnosticEvent("runtime", "whisper-fallback-stopped");
  }

  setSpeakingMode(enabled: boolean): void {
    if (this.speakingMode === enabled) return;
    this.speakingMode = enabled;
    this.reset();
    recordDiagnosticEvent("runtime", "whisper-fallback-speaking-mode", { enabled });
  }

  reset(): void {
    this.generation += 1;
    this.activeSegment = false;
    this.segmentSamples = [];
    this.preRollSamples = [];
    this.trailingSilenceSamples = 0;
    this.deferredSamples = [];
    this.deferredStartedAt = null;
    this.deferredTruncated = false;
  }

  async waitForIdle(): Promise<void> {
    while (this.processingPromise) {
      const processingPromise = this.processingPromise;
      await processingPromise.catch(() => undefined);
      // The completion handler may synchronously replay deferred PCM and
      // create a new inference. Keep waiting until that replay is idle too.
      await Promise.resolve();
    }
  }

  acceptSamples(
    samples: number[],
    sampleRate: number,
    onDetected: DetectionCallback
  ): void {
    if (!this.enabled || samples.length === 0 || sampleRate !== SAMPLE_RATE) return;

    if (this.processingPromise) {
      this.deferredStartedAt ??= Date.now();
      const remainingCapacity = MAX_DEFERRED_SAMPLES - this.deferredSamples.length;
      if (remainingCapacity > 0) {
        this.deferredSamples.push(...samples.slice(0, remainingCapacity));
      }
      if (samples.length > remainingCapacity) {
        this.deferredTruncated = true;
      }
      return;
    }

    const rms = computeRms(samples);
    const energyThreshold = Math.max(
      MIN_ENERGY_THRESHOLD,
      Math.min(MAX_ENERGY_THRESHOLD, this.noiseRms * NOISE_MULTIPLIER)
    );
    const isSpeech = rms >= energyThreshold;

    if (!this.activeSegment) {
      if (!isSpeech) {
        this.noiseRms = this.noiseRms * 0.96 + rms * 0.04;
        this.preRollSamples = appendBounded(
          this.preRollSamples,
          samples,
          PRE_ROLL_SAMPLES
        );
        return;
      }

      this.activeSegment = true;
      this.segmentSamples = this.preRollSamples.concat(samples);
      this.preRollSamples = [];
      this.trailingSilenceSamples = 0;
    } else {
      this.segmentSamples.push(...samples);
      this.trailingSilenceSamples = isSpeech
        ? 0
        : this.trailingSilenceSamples + samples.length;
    }

    const maxSegmentSamples = this.speakingMode
      ? SPEAKING_MAX_SEGMENT_SAMPLES
      : IDLE_MAX_SEGMENT_SAMPLES;
    const endSilenceSamples = this.speakingMode
      ? SPEAKING_END_SILENCE_SAMPLES
      : IDLE_END_SILENCE_SAMPLES;

    if (
      this.segmentSamples.length >= maxSegmentSamples ||
      (this.segmentSamples.length >= MIN_SEGMENT_SAMPLES &&
        this.trailingSilenceSamples >= endSilenceSamples)
    ) {
      this.finishSegment(onDetected);
    }
  }

  private finishSegment(onDetected: DetectionCallback): void {
    const trimCount = Math.max(
      0,
      this.trailingSilenceSamples - RETAINED_TAIL_SILENCE_SAMPLES
    );
    const end = Math.max(0, this.segmentSamples.length - trimCount);
    const segment = this.segmentSamples.slice(0, end);
    this.activeSegment = false;
    this.segmentSamples = [];
    this.preRollSamples = [];
    this.trailingSilenceSamples = 0;

    if (segment.length < MIN_SEGMENT_SAMPLES) return;

    this.deferredSamples = [];
    this.deferredStartedAt = null;
    this.deferredTruncated = false;
    const generation = this.generation;
    this.processingGeneration = generation;
    const inferenceStartedAt = Date.now();
    const processingPromise = this.processSegment(segment, generation, onDetected);
    this.processingPromise = processingPromise;
    void processingPromise.then((outcome) => {
      if (this.processingPromise !== processingPromise) return;

      const deferredSamples = this.deferredSamples;
      const deferredStartedAt = this.deferredStartedAt;
      const deferredTruncated = this.deferredTruncated;
      this.processingPromise = null;
      this.deferredSamples = [];
      this.deferredStartedAt = null;
      this.deferredTruncated = false;
      const finishedAt = Date.now();
      const deferredDurationMs = samplesToDurationMs(deferredSamples.length);
      recordDiagnosticEvent("whisper", "wake-inference-finished", {
        outcome,
        inferenceDurationMs: finishedAt - inferenceStartedAt,
        busyDurationMs:
          deferredStartedAt === null ? 0 : finishedAt - deferredStartedAt,
        deferredDurationMs,
        deferredTruncated,
      });

      if (
        (outcome === "unmatched" || outcome === "stale") &&
        this.enabled &&
        deferredSamples.length > 0
      ) {
        this.replayDeferredSamples(deferredSamples, onDetected);
      }
    });
  }

  private async processSegment(
    samples: number[],
    generation: number,
    onDetected: DetectionCallback
  ): Promise<SegmentProcessOutcome> {
    let matched = false;
    try {
      const recognition = await recognizeWakePhraseSamples(samples, SAMPLE_RATE);
      if (!this.enabled || generation !== this.generation) return "stale";

      const phrase = recognition.match;
      if (!phrase) {
        console.log("[WakePhraseFallback] Speech did not match a wake phrase", {
          transcript: recognition.transcript,
        });
        recordDiagnosticEvent("whisper", "wake-not-matched", {
          language: recognition.language,
          transcript: recognition.transcript || "(empty)",
          attempts: recognition.attempts.length,
        });
        return "unmatched";
      }

      matched = true;
      const commandPrerollSamples = this.deferredSamples.slice(
        -MAX_COMMAND_PREROLL_SAMPLES
      );
      onDetected({
        phraseId: phrase.id,
        transcript: recognition.transcript,
        wakeSegmentSamples: [...samples],
        commandPrerollSamples,
        hasCommandSuffix: phrase.hasCommandSuffix,
        sampleRate: SAMPLE_RATE,
      });
      recordDiagnosticEvent("whisper", "wake-detected", {
        phraseId: phrase.id,
        language: recognition.language,
        transcript: recognition.transcript,
        hasCommandSuffix: phrase.hasCommandSuffix,
      });
      return "matched";
    } catch (error) {
      if (this.enabled && generation === this.generation) {
        console.warn("[WakePhraseFallback] Whisper wake check failed:", error);
      }
      return matched
        ? "matched"
        : generation === this.generation
          ? "unmatched"
          : "stale";
    }
  }

  private replayDeferredSamples(
    samples: number[],
    onDetected: DetectionCallback
  ): void {
    recordDiagnosticEvent("whisper", "wake-deferred-replay", {
      deferredDurationMs: samplesToDurationMs(samples.length),
    });
    for (
      let offset = 0;
      offset < samples.length;
      offset += DEFERRED_REPLAY_CHUNK_SAMPLES
    ) {
      this.acceptSamples(
        samples.slice(offset, offset + DEFERRED_REPLAY_CHUNK_SAMPLES),
        SAMPLE_RATE,
        onDetected
      );
    }
  }
}

function computeRms(samples: number[]): number {
  let squareSum = 0;
  for (const sample of samples) squareSum += sample * sample;
  return Math.sqrt(squareSum / samples.length);
}

function appendBounded(current: number[], next: number[], limit: number): number[] {
  if (next.length >= limit) return next.slice(-limit);
  const combined = current.concat(next);
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function samplesToDurationMs(sampleCount: number): number {
  return Math.round((sampleCount / SAMPLE_RATE) * 1000);
}

export const wakePhraseFallback = new WakePhraseFallback();
