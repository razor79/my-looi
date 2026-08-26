import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { getLooiRobotRuntimeState } from "../device-tools/looi-robot";
import { isDrivingControlSessionActive } from "./driving-control-session";

type EventSubscription = {
  remove: () => void;
};

type AudioDataPayload = {
  deltaSize?: number;
  pcmFloat32?: Float32Array | number[];
  buffer?: Float32Array;
};

type PermissionResponse = {
  granted?: boolean;
  status?: string;
};

type AudioStudioNativeModule = {
  getPermissionsAsync?: () => Promise<PermissionResponse>;
  addListener: (eventName: "AudioData", listener: (event: AudioDataPayload) => void) => EventSubscription;
  prepareRecording: (config: RecordingConfig) => Promise<unknown>;
  startRecording: (config: RecordingConfig) => Promise<unknown>;
  stopRecording: () => Promise<unknown>;
};

type RecordingConfig = {
  sampleRate: number;
  channels: number;
  encoding: "pcm_32bit";
  interval: number;
  streamFormat: "float32";
  keepAwake: boolean;
  output: {
    primary: { enabled: boolean };
  };
  ios: {
    audioSession: {
      category: "Record";
      mode: "Measurement";
    };
  };
  android: {
    audioFocusStrategy: "none";
  };
};

async function getAudioStudioModule(): Promise<AudioStudioNativeModule> {
  const { AudioStudioModule } = await import("@siteed/audio-studio");
  return AudioStudioModule as AudioStudioNativeModule;
}

async function getWakewordService() {
  const { wakewordService } = await import("./wakeword");
  return wakewordService;
}

const KWS_SAMPLE_RATE = 16000;
const MAX_QUEUED_SAMPLES = KWS_SAMPLE_RATE * 3;
const RECENT_SAMPLE_BUFFER_SIZE = Math.round(KWS_SAMPLE_RATE * 2.5);
const MAX_ACCEPT_CHUNK_SAMPLES = Math.round(KWS_SAMPLE_RATE * 0.5);
// Physical control benefits from lower chunk latency. Five 200 ms JSI calls/sec
// are cheap compared with waiting half a second before Vosk sees the command.
const MAX_DRIVING_ACCEPT_CHUNK_SAMPLES = Math.round(KWS_SAMPLE_RATE * 0.2);
const PCM_FRESHNESS_MS = 1500;
type SamplesListener = (samples: number[], sampleRate: number) => void;

const recordingConfig: RecordingConfig = {
  sampleRate: KWS_SAMPLE_RATE,
  channels: 1,
  encoding: "pcm_32bit",
  interval: 100,
  streamFormat: "float32",
  keepAwake: false,
  output: {
    primary: { enabled: false },
  },
  ios: {
    audioSession: {
      category: "Record",
      mode: "Measurement",
    },
  },
  android: {
    audioFocusStrategy: "none",
  },
};

export class KwsAudioFeeder {
  private desiredRunning = false;
  private appCaptureAllowed = true;
  private started = false;
  private listener: EventSubscription | null = null;
  private accepting = false;
  private queuedSamples: number[] | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private warnedMissingFloatPayload = false;
  private sampleListeners = new Set<SamplesListener>();
  private wakewordFeedingEnabled = true;
  private recentSamples: number[] = [];
  private lastBacklogTrimLogAt = 0;
  private recordingStartedAt = 0;
  private firstAudioEventLogged = false;
  private lastPcmAt = 0;

  async start(): Promise<void> {
    if (!this.appCaptureAllowed) {
      this.desiredRunning = false;
      recordDiagnosticEvent("microphone", "feeder-start-blocked", {
        reason: "app-audio-gate-closed",
      });
      return;
    }

    this.desiredRunning = true;
    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.started) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    if (!this.started) return;
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = this.stopInternal();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  get isRunning(): boolean {
    return this.started;
  }

  setAppCaptureAllowed(allowed: boolean): void {
    if (this.appCaptureAllowed === allowed) return;

    this.appCaptureAllowed = allowed;
    if (!allowed) {
      this.desiredRunning = false;
    }

    recordDiagnosticEvent("microphone", allowed ? "capture-gate-opened" : "capture-gate-closed", {
      running: this.started,
      desiredRunning: this.desiredRunning,
    });
  }

  get diagnosticStatus() {
    const now = Date.now();
    const pcmAgeMs = this.lastPcmAt > 0 ? now - this.lastPcmAt : null;
    return {
      desiredRunning: this.desiredRunning,
      running: this.started,
      appCaptureAllowed: this.appCaptureAllowed,
      wakewordFeedingEnabled: this.wakewordFeedingEnabled,
      sampleListeners: this.sampleListeners.size,
      pcmFlowing: this.started && pcmAgeMs !== null && pcmAgeMs <= PCM_FRESHNESS_MS,
      pcmAgeMs,
      recordingAgeMs: this.recordingStartedAt > 0 ? now - this.recordingStartedAt : null,
    };
  }

  async waitForFreshPcm(timeoutMs = 1200): Promise<boolean> {
    if (this.diagnosticStatus.pcmFlowing) return true;
    if (!this.started || timeoutMs <= 0) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      const finish = (healthy: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(healthy);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      unsubscribe = this.subscribeSamples((samples) => {
        if (samples.length > 0) finish(true);
      });

      // Close the tiny race between the initial health check and listener setup.
      if (this.diagnosticStatus.pcmFlowing) finish(true);
    });
  }

  subscribeSamples(listener: SamplesListener): () => void {
    this.sampleListeners.add(listener);
    return () => {
      this.sampleListeners.delete(listener);
    };
  }

  setWakewordFeedingEnabled(enabled: boolean): void {
    this.wakewordFeedingEnabled = enabled;
  }

  getRecentSamples(durationMs: number): number[] {
    if (durationMs <= 0 || this.recentSamples.length === 0) {
      return [];
    }

    const sampleCount = Math.min(
      this.recentSamples.length,
      Math.round((KWS_SAMPLE_RATE * durationMs) / 1000)
    );
    return this.recentSamples.slice(-sampleCount);
  }

  private async startInternal(): Promise<void> {
    const startRequestedAt = Date.now();
    try {
      if (!this.desiredRunning || !this.appCaptureAllowed) return;

      const AudioStudioModule = await getAudioStudioModule();
      const permissions = await AudioStudioModule.getPermissionsAsync?.() as
        | PermissionResponse
        | undefined;
      if (!permissions?.granted) {
        throw new Error("Microphone permission not granted; wakeword feeder not started");
      }
      if (!this.desiredRunning || !this.appCaptureAllowed) return;

      this.listener = AudioStudioModule.addListener(
        "AudioData",
        (event: AudioDataPayload) => {
          this.handleAudioEvent(event);
        }
      );

      await AudioStudioModule.prepareRecording(recordingConfig);
      if (!this.desiredRunning || !this.appCaptureAllowed) {
        this.listener?.remove();
        this.listener = null;
        return;
      }

      await AudioStudioModule.startRecording(recordingConfig);
      this.started = true;
      this.recordingStartedAt = Date.now();
      this.firstAudioEventLogged = false;
      this.lastPcmAt = 0;
      recordDiagnosticEvent("microphone", "feeder-started", {
        sampleRate: KWS_SAMPLE_RATE,
        wakewordFeedingEnabled: this.wakewordFeedingEnabled,
        audioFocusStrategy: recordingConfig.android.audioFocusStrategy,
        startLatencyMs: this.recordingStartedAt - startRequestedAt,
      });

      if (!this.desiredRunning || !this.appCaptureAllowed) {
        await this.stopInternal();
      }
    } catch (error) {
      this.listener?.remove();
      this.listener = null;
      this.started = false;
      console.warn("[KWS AudioFeeder] Failed to start:", error);
      recordDiagnosticEvent("microphone", "feeder-start-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    this.started = false;
    this.recordingStartedAt = 0;
    this.firstAudioEventLogged = false;
    this.lastPcmAt = 0;
    this.queuedSamples = null;
    this.recentSamples = [];

    this.listener?.remove();
    this.listener = null;

    try {
      const AudioStudioModule = await getAudioStudioModule();
      await AudioStudioModule.stopRecording();
      recordDiagnosticEvent("microphone", "feeder-stopped");
    } catch (error) {
      console.warn("[KWS AudioFeeder] Failed to stop:", error);
    }
  }

  private handleAudioEvent(event: AudioDataPayload): void {
    if (!this.started || event.deltaSize === 0) return;

    if (!this.firstAudioEventLogged) {
      this.firstAudioEventLogged = true;
      recordDiagnosticEvent("microphone", "first-pcm", {
        afterStartMs: this.recordingStartedAt > 0 ? Date.now() - this.recordingStartedAt : 0,
        deltaSize: event.deltaSize ?? 0,
      });
    }

    const audioData = event.pcmFloat32 ?? event.buffer;
    if (audioData == null) {
      if (!this.warnedMissingFloatPayload) {
        this.warnedMissingFloatPayload = true;
        console.warn("[KWS AudioFeeder] AudioData event did not include float PCM payload");
        recordDiagnosticEvent("microphone", "pcm-payload-missing");
      }
      return;
    }

    const samples = Array.isArray(audioData) ? audioData : Array.from(audioData);
    if (samples.length === 0) return;
    this.lastPcmAt = Date.now();
    this.rememberRecentSamples(samples);
    this.emitSamples(samples);
    this.enqueueSamples(samples);
  }

  private rememberRecentSamples(samples: number[]): void {
    if (samples.length >= RECENT_SAMPLE_BUFFER_SIZE) {
      this.recentSamples = samples.slice(-RECENT_SAMPLE_BUFFER_SIZE);
      return;
    }

    this.recentSamples = this.recentSamples.concat(samples);
    if (this.recentSamples.length > RECENT_SAMPLE_BUFFER_SIZE) {
      this.recentSamples = this.recentSamples.slice(-RECENT_SAMPLE_BUFFER_SIZE);
    }
  }

  private emitSamples(samples: number[]): void {
    if (this.sampleListeners.size === 0) return;

    for (const listener of this.sampleListeners) {
      try {
        listener(samples, KWS_SAMPLE_RATE);
      } catch (error) {
        console.warn("[KWS AudioFeeder] Sample listener failed:", error);
      }
    }
  }

  private enqueueSamples(samples: number[]): void {
    this.queuedSamples = this.queuedSamples ? this.queuedSamples.concat(samples) : samples;
    if (this.queuedSamples.length > MAX_QUEUED_SAMPLES) {
      const droppedSamples = this.queuedSamples.length - MAX_QUEUED_SAMPLES;
      this.queuedSamples = this.queuedSamples.slice(-MAX_QUEUED_SAMPLES);
      const now = Date.now();
      if (now - this.lastBacklogTrimLogAt >= 5000) {
        this.lastBacklogTrimLogAt = now;
        recordDiagnosticEvent("microphone", "wake-feed-backlog-trimmed", {
          droppedDurationMs: Math.round((droppedSamples / KWS_SAMPLE_RATE) * 1000),
          retainedDurationMs: Math.round((MAX_QUEUED_SAMPLES / KWS_SAMPLE_RATE) * 1000),
        });
      }
    }

    if (!this.accepting) {
      this.drainSamples();
    }
  }

  private async drainSamples(): Promise<void> {
    this.accepting = true;

    try {
      while (this.started && this.queuedSamples) {
        const samples = this.queuedSamples;
        this.queuedSamples = null;
        const emergencyMotionActive = getLooiRobotRuntimeState().motionActive;
        const drivingSessionActive = isDrivingControlSessionActive();
        if (!this.wakewordFeedingEnabled && !emergencyMotionActive && !drivingSessionActive) {
          continue;
        }
        const wakewordService = await getWakewordService();
        let offset = 0;
        while (offset < samples.length) {
          const drivingControlActive =
            getLooiRobotRuntimeState().motionActive || isDrivingControlSessionActive();
          const shouldFeed = this.started && (this.wakewordFeedingEnabled || drivingControlActive);
          if (!shouldFeed) break;
          const chunkSize = drivingControlActive
            ? MAX_DRIVING_ACCEPT_CHUNK_SAMPLES
            : MAX_ACCEPT_CHUNK_SAMPLES;
          const chunk = samples.slice(offset, offset + chunkSize);
          offset += chunk.length;
          await wakewordService.acceptSamples(chunk, KWS_SAMPLE_RATE);
        }
      }
    } catch (error) {
      console.warn("[KWS AudioFeeder] Failed to feed samples:", error);
    } finally {
      this.accepting = false;
      if (this.started && this.queuedSamples) {
        this.drainSamples();
      }
    }
  }
}

export const kwsAudioFeeder = new KwsAudioFeeder();
