import { NativeModule, requireNativeModule } from "expo";

export type VoskCommandEvent = {
  text: string;
  partial: boolean;
  sequence: number;
  processingMs: number;
  sessionId: number;
  resetGeneration: number;
  samplesSinceReset: number;
  queuedChunks: number;
  droppedChunks: number;
  endpoint: boolean;
  rms16: number;
};

export type VoskEmergencyStopEvent = {
  text: string;
  partial: boolean;
  processingMs: number;
  sessionId: number;
  samplesSinceEmergencyReset: number;
  queuedChunks: number;
  rms16: number;
};

export type VoskEmergencyUnknownEvent = VoskEmergencyStopEvent;

export type VoskEmergencyHealthEvent = {
  armed: boolean;
  armGeneration: number;
  partialText: string;
  endpoint: boolean;
  processingMs: number;
  sessionId: number;
  samplesSinceEmergencyReset: number;
  queuedChunks: number;
  rms16: number;
};

export type VoskModelReadyEvent = {
  language: string;
  assetDir: string;
  loadMs: number;
  cached: boolean;
  sessionId: number;
  resetGeneration: number;
};

export type VoskErrorEvent = {
  stage: string;
  message: string;
};

export type VoskRecognizerStateEvent = {
  state: string;
  reason: string;
  sessionId: number;
  resetGeneration: number;
  resetCount: number;
  queuedChunks: number;
  droppedChunks: number;
  samplesSinceReset: number;
  emergencySamplesSinceReset: number;
  emergencyArmed: boolean;
  emergencyArmGeneration: number;
  emergencyReset: boolean;
  processingMs: number;
};

type VoskCommandRecognizerEvents = {
  onCommandResult(event: VoskCommandEvent): void;
  onEmergencyStop(event: VoskEmergencyStopEvent): void;
  onEmergencyUnknown(event: VoskEmergencyUnknownEvent): void;
  onEmergencyHealth(event: VoskEmergencyHealthEvent): void;
  onModelReady(event: VoskModelReadyEvent): void;
  onRecognizerError(event: VoskErrorEvent): void;
  onRecognizerState(event: VoskRecognizerStateEvent): void;
};

export type VoskCommandRecognizerStatus = {
  ready: boolean;
  language: string;
  queuedChunks: number;
  sessionId: number;
  resetGeneration: number;
  resetCount: number;
  droppedChunks: number;
  samplesSinceReset: number;
  emergencySamplesSinceReset: number;
  emergencyArmed: boolean;
  emergencyArmGeneration: number;
};

declare class VoskCommandRecognizerModule extends NativeModule<VoskCommandRecognizerEvents> {
  prepare(language: string, assetDir: string, grammarJson: string, emergencyGrammarJson: string): Promise<void>;
  setGrammar(grammarJson: string): Promise<void>;
  feedSamples(samples: number[]): void;
  armEmergency(reason: string): Promise<boolean>;
  disarmEmergency(reason: string): Promise<void>;
  reset(reason: string, resetEmergency: boolean): number;
  unload(): void;
  getStatus(): VoskCommandRecognizerStatus;
}

export default requireNativeModule<VoskCommandRecognizerModule>("VoskCommandRecognizer");
