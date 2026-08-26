import { getRecordingPermissionsAsync } from "expo-audio";

import { getLooiRobotRuntimeState } from "@/src/device-tools/looi-robot";
import { getSavedLooiRobot } from "@/src/device-tools/looi-robot-autoconnect";
import { hasOpenAiApiKey } from "@/src/openai/openai-api-key";
import { checkAllSherpaModelReadiness, type SherpaModelCheck } from "@/src/voice/sherpa-models";
import { getSetupStorageState, type SetupSkipState } from "./setup-storage";

export type SetupStep = "openai" | "models" | "permissions" | "done";

export type SetupModelReadiness = {
  asr: SherpaModelCheck;
  kws: SherpaModelCheck;
  speaker: SherpaModelCheck;
  vad: SherpaModelCheck;
};

export type SetupReadiness = {
  openAiKeyConfigured: boolean;
  modelsReady: boolean;
  modelStatus: SetupModelReadiness | null;
  microphoneReady: boolean;
  robotReady: boolean;
  skipped: SetupSkipState;
  onboardingCompleted: boolean;
  requiredReady: boolean;
  nextStep: SetupStep;
};

export function areSherpaModelsReady(status: SetupModelReadiness): boolean {
  return Boolean(status.asr.ready && status.kws.ready && status.vad.ready);
}

export async function computeSetupReadiness(): Promise<SetupReadiness> {
  const storageState = getSetupStorageState();
  const [openAiKeyConfigured, modelResult, microphoneReady, robotReady] = await Promise.all([
    hasOpenAiApiKey(),
    checkAllSherpaModelReadiness().catch((error) => {
      console.warn("[Setup] Failed to check Sherpa model readiness:", error);
      return null;
    }),
    getMicrophoneReady(),
    getRobotReady(),
  ]);

  const modelsReady = modelResult ? areSherpaModelsReady(modelResult) : false;
  const requiredReady = openAiKeyConfigured && modelsReady && microphoneReady;

  return {
    openAiKeyConfigured,
    modelsReady,
    modelStatus: modelResult,
    microphoneReady,
    robotReady,
    skipped: storageState.skipped,
    onboardingCompleted: storageState.onboardingCompleted,
    requiredReady,
    nextStep: getNextSetupStep({ openAiKeyConfigured, modelsReady, microphoneReady }),
  };
}

function getNextSetupStep(state: {
  openAiKeyConfigured: boolean;
  modelsReady: boolean;
  microphoneReady: boolean;
}): SetupStep {
  if (!state.openAiKeyConfigured) return "openai";
  if (!state.modelsReady) return "models";
  if (!state.microphoneReady) return "permissions";
  return "done";
}

async function getMicrophoneReady(): Promise<boolean> {
  try {
    const permission = await getRecordingPermissionsAsync();
    return Boolean(permission.granted);
  } catch (error) {
    console.warn("[Setup] Failed to check microphone permission:", error);
    return false;
  }
}

async function getRobotReady(): Promise<boolean> {
  try {
    const runtimeState = getLooiRobotRuntimeState();
    if (runtimeState.connected) return true;
    return Boolean(await getSavedLooiRobot());
  } catch (error) {
    console.warn("[Setup] Failed to check robot readiness:", error);
    return false;
  }
}
