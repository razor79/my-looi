import {
  AudioModule,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { useUserStore } from "../store/user";
import { useConversationStore } from "../store/conversation";
import { getRuntimeProfile } from "../core/runtime-profile";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";

const SHERPA_RECORDING_OPTIONS: RecordingOptions = {
  extension: ".wav",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 256000,
  android: {
    extension: ".wav",
    outputFormat: "default",
    audioEncoder: "default",
  },
  ios: {
    extension: ".wav",
    outputFormat: "lpcm",
    audioQuality: 0x7f,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/wav",
    bitsPerSecond: 256000,
  },
};

async function getKwsAudioFeeder() {
  const { kwsAudioFeeder } = await import("./kws-audio-feeder");
  return kwsAudioFeeder;
}

async function getSherpaVoiceAdapter() {
  const { sherpaVoiceAdapter } = await import("./sherpa-adapter");
  return sherpaVoiceAdapter;
}

async function resetWakePhraseFallback() {
  const { wakewordService } = await import("./wakeword");
  await wakewordService.resetFallback();
}

/**
 * Local speech-to-text support for wake/command handling.
 * Realtime conversation audio bypasses this service and uses the active Realtime
 * transport directly; this path remains for local wake/command fallback only.
 */
export class STTService {
  private recording: AudioRecorder | null = null;
  private isRecording = false;
  private pausedWakewordFeeder = false;

  async startRecording(): Promise<void> {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Microphone permission denied");
      }

      await this.pauseWakewordFeeder();
      await resetWakePhraseFallback();

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      const recording = new AudioModule.AudioRecorder(SHERPA_RECORDING_OPTIONS);
      await recording.prepareToRecordAsync();
      recording.record();

      this.recording = recording;
      this.isRecording = true;
    } catch (error) {
      await this.resumeWakewordFeederIfNeeded();
      console.error("[STT] Failed to start recording:", error);
      throw error;
    }
  }

  async stopAndTranscribe(): Promise<string> {
    const uri = await this.stopRecording();
    return await this.transcribeFile(uri);
  }

  async stopRecording(): Promise<string> {
    if (!this.recording) {
      throw new Error("No active recording");
    }

    try {
      await this.recording.stop();
      this.isRecording = false;

      const uri = this.recording.uri;
      this.recording = null;

      if (!uri) {
        throw new Error("No recording URI");
      }

      return uri;
    } catch (error) {
      this.isRecording = false;
      this.recording = null;
      console.error("[STT] Failed to stop recording:", error);
      throw error;
    }
  }

  async cancel(options: { resumeWakeword?: boolean } = {}): Promise<void> {
    if (this.recording) {
      try {
        await this.recording.stop();
      } catch {
        // Ignore
      }
      this.recording = null;
      this.isRecording = false;
    }

    if (options.resumeWakeword === false) {
      this.pausedWakewordFeeder = false;
      return;
    }

    await this.resumeWakewordFeederIfPaused();
  }

  get recording_active(): boolean {
    return this.isRecording;
  }

  async transcribeFile(audioUri: string): Promise<string> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    return sherpaVoiceAdapter.transcribeFile(audioUri);
  }

  async initialize(): Promise<void> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    await sherpaVoiceAdapter.initializeAsr();
  }

  async transcribeSamples(samples: number[], sampleRate = 16000): Promise<string> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    return sherpaVoiceAdapter.transcribeSamples(samples, sampleRate);
  }

  async transcribeCommandSamples(
    samples: number[],
    sampleRate = 16000,
    externalSignal?: AbortSignal,
    _usage?: { turnId?: string }
  ): Promise<string> {
    if (samples.length === 0) return "";
    if (externalSignal?.aborted) throw new Error("Voice turn interrupted");

    const startedAt = Date.now();
    const audioDurationMs = Math.round((samples.length / sampleRate) * 1000);
    const listeningLanguage = useUserStore.getState().preferences.listeningLanguage;
    recordDiagnosticEvent("stt", "local-command-start", {
      audioDurationMs,
      sampleRate,
      listeningLanguage,
    });

    try {
      const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
      const transcript = (await sherpaVoiceAdapter.transcribeSamplesWithLanguage(
        samples,
        sampleRate,
        listeningLanguage
      )).trim();
      if (externalSignal?.aborted) throw new Error("Voice turn interrupted");
      recordDiagnosticEvent("stt", "local-command-finished", {
        durationMs: Date.now() - startedAt,
        transcript: transcript || "(empty)",
      });
      return transcript;
    } catch (error) {
      if (externalSignal?.aborted) {
        recordDiagnosticEvent("stt", "local-command-interrupted", {
          durationMs: Date.now() - startedAt,
        });
        throw new Error("Voice turn interrupted");
      }
      recordDiagnosticEvent("stt", "local-command-failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  }

  async resumeWakewordFeederIfPaused(): Promise<void> {
    await this.resumeWakewordFeederIfNeeded();
  }

  private async pauseWakewordFeeder(): Promise<void> {
    const kwsAudioFeeder = await getKwsAudioFeeder();
    if (!kwsAudioFeeder.isRunning) {
      return;
    }

    await kwsAudioFeeder.stop();
    this.pausedWakewordFeeder = true;
    console.log("[STT] Paused KWS feeder for recording");
  }

  private async resumeWakewordFeederIfNeeded(): Promise<void> {
    if (!this.pausedWakewordFeeder) {
      return;
    }

    this.pausedWakewordFeeder = false;
    if (!useUserStore.getState().preferences.wakeWordEnabled) {
      return;
    }
    if (!getRuntimeProfile().allowsWakewordAutostart) {
      return;
    }

    const kwsAudioFeeder = await getKwsAudioFeeder();
    await resetWakePhraseFallback();
    await kwsAudioFeeder.start();
    console.log("[STT] Resumed KWS feeder after recording");
  }
}

export const sttService = new STTService();
