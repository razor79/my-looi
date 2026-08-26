import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { useUserStore } from "../store/user";
import { parseDrivingCommandTranscript, type DrivingCommand } from "./driving-command";

const SAMPLE_RATE = 16000;
// v1.1.33: local physical commands need whole words, not ultra-short VAD
// fragments. The previous 110 ms endpoint produced 380-600 ms clips and
// Whisper hallucinations such as "Слой", "Сл" and "[см" for repeated STOP.
const PRE_ROLL_SAMPLES = Math.round(SAMPLE_RATE * 0.32);
const MIN_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * 0.48);
const END_SILENCE_SAMPLES = Math.round(SAMPLE_RATE * 0.30);
const RETAINED_TAIL_SAMPLES = Math.round(SAMPLE_RATE * 0.22);
const MAX_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * 2.2);
const MAX_DEFERRED_SAMPLES = Math.round(SAMPLE_RATE * 4.0);
const REPLAY_CHUNK_SAMPLES = Math.round(SAMPLE_RATE * 0.1);
const MIN_ENERGY_THRESHOLD = 0.012;
const MAX_ENERGY_THRESHOLD = 0.055;
const NOISE_MULTIPLIER = 3.1;

type DrivingCommandCallback = (command: DrivingCommand, transcript: string) => void;

/**
 * Bounded offline command recognizer used while LOOI is physically moving.
 * No network calls are made here. The selected listening language is the only
 * ASR language used, and non-whitelisted speech is discarded locally.
 */
class DrivingCommandFallback {
  private activeSegment = false;
  private segmentSamples: number[] = [];
  private preRollSamples: number[] = [];
  private trailingSilenceSamples = 0;
  private noiseRms = 0.006;
  private processingPromise: Promise<void> | null = null;
  private deferredSamples: number[] = [];
  private generation = 0;

  reset(): void {
    this.generation += 1;
    this.activeSegment = false;
    this.segmentSamples = [];
    this.preRollSamples = [];
    this.trailingSilenceSamples = 0;
    this.deferredSamples = [];
  }

  acceptSamples(samples: number[], sampleRate: number, onCommand: DrivingCommandCallback): void {
    if (sampleRate !== SAMPLE_RATE || samples.length === 0) return;

    if (this.processingPromise) {
      const remaining = MAX_DEFERRED_SAMPLES - this.deferredSamples.length;
      if (remaining > 0) this.deferredSamples.push(...samples.slice(0, remaining));
      return;
    }

    const rms = computeRms(samples);
    const threshold = Math.max(
      MIN_ENERGY_THRESHOLD,
      Math.min(MAX_ENERGY_THRESHOLD, this.noiseRms * NOISE_MULTIPLIER)
    );
    const isSpeech = rms >= threshold;

    if (!this.activeSegment) {
      if (!isSpeech) {
        this.noiseRms = this.noiseRms * 0.95 + rms * 0.05;
        this.preRollSamples = appendBounded(this.preRollSamples, samples, PRE_ROLL_SAMPLES);
        return;
      }
      this.activeSegment = true;
      this.segmentSamples = this.preRollSamples.concat(samples);
      this.preRollSamples = [];
      this.trailingSilenceSamples = 0;
    } else {
      this.segmentSamples.push(...samples);
      this.trailingSilenceSamples = isSpeech ? 0 : this.trailingSilenceSamples + samples.length;
    }

    if (
      this.segmentSamples.length >= MAX_SEGMENT_SAMPLES ||
      (this.segmentSamples.length >= MIN_SEGMENT_SAMPLES && this.trailingSilenceSamples >= END_SILENCE_SAMPLES)
    ) {
      this.finishSegment(onCommand);
    }
  }

  private finishSegment(onCommand: DrivingCommandCallback): void {
    const trim = Math.max(0, this.trailingSilenceSamples - RETAINED_TAIL_SAMPLES);
    const segment = this.segmentSamples.slice(0, Math.max(0, this.segmentSamples.length - trim));
    this.activeSegment = false;
    this.segmentSamples = [];
    this.preRollSamples = [];
    this.trailingSilenceSamples = 0;
    if (segment.length < MIN_SEGMENT_SAMPLES) return;

    const generation = this.generation;
    const startedAt = Date.now();
    const promise = this.processSegment(segment, generation, onCommand);
    this.processingPromise = promise;
    void promise.finally(() => {
      if (this.processingPromise !== promise) return;
      this.processingPromise = null;
      recordDiagnosticEvent("whisper", "driving-command-inference-finished", {
        durationMs: Date.now() - startedAt,
      });
      const deferred = this.deferredSamples;
      this.deferredSamples = [];
      if (deferred.length > 0 && generation === this.generation) {
        for (let offset = 0; offset < deferred.length; offset += REPLAY_CHUNK_SAMPLES) {
          this.acceptSamples(deferred.slice(offset, offset + REPLAY_CHUNK_SAMPLES), SAMPLE_RATE, onCommand);
        }
      }
    });
  }

  private async processSegment(
    samples: number[],
    generation: number,
    onCommand: DrivingCommandCallback
  ): Promise<void> {
    try {
      const { sherpaVoiceAdapter } = await import("./sherpa-adapter");
      const language = useUserStore.getState().preferences.listeningLanguage;
      const transcript = await sherpaVoiceAdapter.transcribeSamplesWithLanguage(samples, SAMPLE_RATE, language);
      if (generation !== this.generation) return;
      const command = parseDrivingCommandTranscript(transcript, language);
      recordDiagnosticEvent("whisper", "driving-command-local", {
        language,
        transcript: transcript || "(empty)",
        matched: Boolean(command),
        audioDurationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
      });
      if (command) onCommand(command, transcript);
    } catch (error) {
      recordDiagnosticEvent("whisper", "driving-command-local-error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function computeRms(samples: number[]): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function appendBounded(current: number[], next: number[], limit: number): number[] {
  if (next.length >= limit) return next.slice(-limit);
  const combined = current.concat(next);
  return combined.length > limit ? combined.slice(-limit) : combined;
}

export const drivingCommandFallback = new DrivingCommandFallback();
