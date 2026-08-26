import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type RealtimePcmAudioDataEvent = {
  pcm16Base64: string;
  sampleRate: number;
  frames: number;
  rms: number;
  sequence: number;
  timestampMs: number;
};

export type RealtimePcmCaptureErrorEvent = {
  stage: string;
  message: string;
};

export type RealtimePcmPlaybackEvent = {
  playedDurationMs: number;
};

export type RealtimePcmPlaybackErrorEvent = {
  message: string;
};

export type RealtimePcmAudioStatus = {
  supported: boolean;
  captureRunning: boolean;
  captureSampleRate: number;
  audioSource: string;
  audioSessionId: number | null;
  aecAvailable: boolean;
  aecEnabled: boolean;
  noiseSuppressorExplicit: boolean;
  captureChunks: number;
  playbackRunning: boolean;
  playbackSampleRate: number;
  playedDurationMs: number;
  playbackQueuedChunks: number;
};

type Events = {
  onAudioData(event: RealtimePcmAudioDataEvent): void;
  onCaptureError(event: RealtimePcmCaptureErrorEvent): void;
  onPlaybackDrained(event: RealtimePcmPlaybackEvent): void;
  onPlaybackError(event: RealtimePcmPlaybackErrorEvent): void;
};

declare class RealtimePcmAudioNativeModule extends NativeModule<Events> {
  startCapture(): Promise<RealtimePcmAudioStatus>;
  stopCapture(): Promise<RealtimePcmAudioStatus>;
  getStatus(): Promise<RealtimePcmAudioStatus>;
  beginPlayback(): void;
  enqueuePlayback(pcm24Base64: string): void;
  finishPlayback(): void;
  stopPlayback(): { playedDurationMs: number };
  getPlayedDurationMs(): number;
}

let cached: RealtimePcmAudioNativeModule | null = null;

export function getRealtimePcmAudioModule(): RealtimePcmAudioNativeModule {
  if (Platform.OS !== "android") throw new Error("Realtime PCM experiment is available on Android only");
  cached ??= requireNativeModule<RealtimePcmAudioNativeModule>("RealtimePcmAudio");
  return cached;
}
