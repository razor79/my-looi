import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type LocalRealtimeAudioDataEvent = {
  pcm16Base64: string;
  sampleRate: number;
  frames: number;
  rms: number;
  sequence: number;
  timestampMs: number;
};

export type LocalRealtimeCaptureErrorEvent = {
  stage: string;
  message: string;
};

export type LocalRealtimeCaptureStatus = {
  supported: boolean;
  running: boolean;
  sampleRate: number;
  audioSource: string;
  audioSessionId: number | null;
  aecAvailable: boolean;
  aecEnabled: boolean;
  nsAvailable: boolean;
  nsEnabled: boolean;
  chunksEmitted: number;
  framesCaptured: number;
};

type Events = {
  onAudioData(event: LocalRealtimeAudioDataEvent): void;
  onCaptureError(event: LocalRealtimeCaptureErrorEvent): void;
};

declare class LocalRealtimeAudioCaptureNativeModule extends NativeModule<Events> {
  start(): Promise<LocalRealtimeCaptureStatus>;
  stop(): Promise<LocalRealtimeCaptureStatus>;
  getStatus(): Promise<LocalRealtimeCaptureStatus>;
}

let cached: LocalRealtimeAudioCaptureNativeModule | null = null;
function getModule(): LocalRealtimeAudioCaptureNativeModule {
  if (Platform.OS !== "android") throw new Error("Realtime PCM capture is available on Android only");
  cached ??= requireNativeModule<LocalRealtimeAudioCaptureNativeModule>("LocalRealtimeAudioCapture");
  return cached;
}

export function getLocalRealtimeAudioCaptureModule(): LocalRealtimeAudioCaptureNativeModule {
  return getModule();
}
