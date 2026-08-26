type VoiceModule = typeof import("../perceivers/voice-perceiver");
type SttModule = typeof import("./stt");
type TtsModule = typeof import("./tts");

let voiceModulePromise: Promise<VoiceModule> | null = null;
let sttModulePromise: Promise<SttModule> | null = null;
let ttsModulePromise: Promise<TtsModule> | null = null;

export function getVoiceModule(): Promise<VoiceModule> {
  voiceModulePromise ??= import("../perceivers/voice-perceiver");
  return voiceModulePromise;
}

export function getSttModule(): Promise<SttModule> {
  sttModulePromise ??= import("./stt");
  return sttModulePromise;
}

export function getTtsModule(): Promise<TtsModule> {
  ttsModulePromise ??= import("./tts");
  return ttsModulePromise;
}

export function getLoadedSttModule(): Promise<SttModule> | null {
  return sttModulePromise;
}

export function getLoadedTtsModule(): Promise<TtsModule> | null {
  return ttsModulePromise;
}
