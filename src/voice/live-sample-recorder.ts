import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { kwsAudioFeeder } from "./kws-audio-feeder";

const MIN_SPEAKER_SAMPLES = 16000;
const EDGE_PADDING_SAMPLES = 4000;
const ENERGY_THRESHOLD = 0.01;
const SAMPLE_RATE = 16000;

/**
 * Records a diagnostic/enrollment sample from the shared microphone feeder.
 * Reusing the already-running feeder avoids a visible microphone restart gap
 * when the user presses and immediately starts speaking.
 */
export class LiveSampleRecorder {
  private unsubscribe: (() => void) | null = null;
  private samples: number[] = [];
  private feederWasRunning = false;
  private startedFeederForRecording = false;
  private recordingReadyAt = 0;

  async start(): Promise<void> {
    await this.stop();
    const { wakewordService } = await import("./wakeword");
    await wakewordService.resetFallback();

    this.samples = [];
    this.feederWasRunning = kwsAudioFeeder.isRunning;
    this.startedFeederForRecording = !this.feederWasRunning;
    kwsAudioFeeder.setWakewordFeedingEnabled(false);
    this.unsubscribe = kwsAudioFeeder.subscribeSamples((samples) => {
      this.samples.push(...samples);
    });

    try {
      if (!kwsAudioFeeder.isRunning) {
        await kwsAudioFeeder.start();
      }
      this.recordingReadyAt = Date.now();
      recordDiagnosticEvent("microphone", "live-recorder-ready", {
        reusedFeeder: this.feederWasRunning,
        feederRunning: kwsAudioFeeder.isRunning,
      });
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      kwsAudioFeeder.setWakewordFeedingEnabled(true);
      if (this.startedFeederForRecording) {
        await kwsAudioFeeder.stop().catch(() => undefined);
      }
      this.startedFeederForRecording = false;
      this.feederWasRunning = false;
      throw error;
    }
  }

  async stop(): Promise<number[]> {
    if (!this.unsubscribe) {
      this.samples = [];
      return [];
    }

    this.unsubscribe();
    this.unsubscribe = null;
    kwsAudioFeeder.setWakewordFeedingEnabled(true);

    if (this.startedFeederForRecording) {
      await kwsAudioFeeder.stop().catch(() => undefined);
    }

    const captured = this.samples;
    const recorded = this.trimLowEnergyEdges(captured);
    const durationMs = Math.round((recorded.length / SAMPLE_RATE) * 1000);
    recordDiagnosticEvent("microphone", "live-recorder-stopped", {
      durationMs,
      rawDurationMs: Math.round((captured.length / SAMPLE_RATE) * 1000),
      readyForMs: this.recordingReadyAt > 0 ? Date.now() - this.recordingReadyAt : 0,
      reusedFeeder: this.feederWasRunning,
    });

    this.samples = [];
    this.recordingReadyAt = 0;
    this.startedFeederForRecording = false;
    this.feederWasRunning = false;
    return recorded;
  }

  async cancel(): Promise<void> {
    await this.stop();
  }

  get isRecording(): boolean {
    return Boolean(this.unsubscribe);
  }

  private trimLowEnergyEdges(samples: number[]): number[] {
    if (samples.length <= MIN_SPEAKER_SAMPLES) return samples;

    let start = 0;
    let end = samples.length;
    while (start < end && Math.abs(samples[start]) < ENERGY_THRESHOLD) {
      start += 1;
    }
    while (end > start && Math.abs(samples[end - 1]) < ENERGY_THRESHOLD) {
      end -= 1;
    }

    start = Math.max(0, start - EDGE_PADDING_SAMPLES);
    end = Math.min(samples.length, end + EDGE_PADDING_SAMPLES);
    const trimmed = samples.slice(start, end);
    return trimmed.length >= MIN_SPEAKER_SAMPLES ? trimmed : samples;
  }
}

export const liveSampleRecorder = new LiveSampleRecorder();
