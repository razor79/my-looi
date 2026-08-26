import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type RealtimeAudioRouteStatus = {
  supported: boolean;
  active: boolean;
  sdkInt: number;
  mode: number;
  modeName: string;
  modeMatchesCommunication: boolean;
  modeChangedByModule: boolean;
  modeBeforeActivation?: number | null;
  modeBeforeActivationName?: string | null;
  modeRestoreApplied?: boolean | null;
  routeStrategy: string;
  routeRequestAccepted?: boolean | null;
  speakerSelected: boolean;
  speakerphoneOn: boolean;
  communicationDeviceType?: number | null;
  communicationDeviceTypeName?: string | null;
  communicationDeviceName?: string | null;
  speakerDeviceAvailable: boolean;
  availableCommunicationDeviceTypes: string;

  routeOwnershipMismatch: boolean;
  activeRouteMismatch: boolean;
  deviceMutationSequence: number;
  lastDeviceMutation?: string | null;
  lastDeviceMutationAtMs?: number | null;
  lastDeviceBeforeMutation?: number | null;
  lastDeviceBeforeMutationName?: string | null;
  lastDeviceAfterMutation?: number | null;
  lastDeviceAfterMutationName?: string | null;
  modeMutationSequence: number;
  lastModeMutation?: string | null;
  lastModeMutationAtMs?: number | null;
  lastModeBeforeMutation?: number | null;
  lastModeBeforeMutationName?: string | null;
  lastModeAfterMutation?: number | null;
  lastModeAfterMutationName?: string | null;
  activeRecordingCount: number;
  voiceCommunicationRecordingCount: number;
  recordingConfigSummary: string;
  primaryRecordingSessionId?: number | null;
  primaryClientAudioSource?: number | null;
  primaryClientAudioSourceName?: string | null;
  primaryAudioSource?: number | null;
  primaryAudioSourceName?: string | null;
  primaryInputDeviceType?: number | null;
  primaryInputDeviceTypeName?: string | null;
  primaryInputDeviceName?: string | null;
  primaryClientSilenced?: boolean | null;
  primaryClientFormat?: string | null;
  primaryDeviceFormat?: string | null;
  primaryClientEffects: string;
  primaryStreamEffects: string;
  primaryClientHasAec: boolean;
  primaryStreamHasAec: boolean;
  primaryClientHasNs: boolean;
  primaryStreamHasNs: boolean;
  primaryClientHasAgc: boolean;
  primaryStreamHasAgc: boolean;
  platformAecAvailable: boolean;
  platformNsAvailable: boolean;
  platformAgcAvailable: boolean;
  platformPreprocessorCatalog: string;
};

declare class RealtimeAudioRouteNativeModule extends NativeModule {
  activateSpeakerRoute(): Promise<RealtimeAudioRouteStatus>;
  ensureSpeakerRoute(): Promise<RealtimeAudioRouteStatus>;
  deactivateSpeakerRoute(): Promise<RealtimeAudioRouteStatus>;
  getStatus(): Promise<RealtimeAudioRouteStatus>;
}

let cachedModule: RealtimeAudioRouteNativeModule | null = null;

function getNativeModule(): RealtimeAudioRouteNativeModule | null {
  if (Platform.OS !== "android") return null;
  cachedModule ??= requireNativeModule<RealtimeAudioRouteNativeModule>("RealtimeAudioRoute");
  return cachedModule;
}

const unsupportedStatus: RealtimeAudioRouteStatus = {
  supported: false,
  active: false,
  sdkInt: 0,
  mode: 0,
  modeName: "unsupported",
  modeMatchesCommunication: false,
  modeChangedByModule: false,
  modeBeforeActivation: null,
  modeBeforeActivationName: null,
  modeRestoreApplied: null,
  routeStrategy: "unsupported",
  routeRequestAccepted: null,
  speakerSelected: false,
  speakerphoneOn: false,
  communicationDeviceType: null,
  communicationDeviceTypeName: null,
  communicationDeviceName: null,
  speakerDeviceAvailable: false,
  availableCommunicationDeviceTypes: "",
  routeOwnershipMismatch: false,
  activeRouteMismatch: false,
  deviceMutationSequence: 0,
  lastDeviceMutation: null,
  lastDeviceMutationAtMs: null,
  lastDeviceBeforeMutation: null,
  lastDeviceBeforeMutationName: null,
  lastDeviceAfterMutation: null,
  lastDeviceAfterMutationName: null,
  modeMutationSequence: 0,
  lastModeMutation: null,
  lastModeMutationAtMs: null,
  lastModeBeforeMutation: null,
  lastModeBeforeMutationName: null,
  lastModeAfterMutation: null,
  lastModeAfterMutationName: null,
  activeRecordingCount: 0,
  voiceCommunicationRecordingCount: 0,
  recordingConfigSummary: "",
  primaryRecordingSessionId: null,
  primaryClientAudioSource: null,
  primaryClientAudioSourceName: null,
  primaryAudioSource: null,
  primaryAudioSourceName: null,
  primaryInputDeviceType: null,
  primaryInputDeviceTypeName: null,
  primaryInputDeviceName: null,
  primaryClientSilenced: null,
  primaryClientFormat: null,
  primaryDeviceFormat: null,
  primaryClientEffects: "",
  primaryStreamEffects: "",
  primaryClientHasAec: false,
  primaryStreamHasAec: false,
  primaryClientHasNs: false,
  primaryStreamHasNs: false,
  primaryClientHasAgc: false,
  primaryStreamHasAgc: false,
  platformAecAvailable: false,
  platformNsAvailable: false,
  platformAgcAvailable: false,
  platformPreprocessorCatalog: "",
};

export async function activateRealtimeSpeakerRoute(): Promise<RealtimeAudioRouteStatus> {
  return (await getNativeModule()?.activateSpeakerRoute()) ?? unsupportedStatus;
}

export async function ensureRealtimeSpeakerRoute(): Promise<RealtimeAudioRouteStatus> {
  return (await getNativeModule()?.ensureSpeakerRoute()) ?? unsupportedStatus;
}

export async function deactivateRealtimeSpeakerRoute(): Promise<RealtimeAudioRouteStatus> {
  return (await getNativeModule()?.deactivateSpeakerRoute()) ?? unsupportedStatus;
}

export async function getRealtimeAudioRouteStatus(): Promise<RealtimeAudioRouteStatus> {
  return (await getNativeModule()?.getStatus()) ?? unsupportedStatus;
}
