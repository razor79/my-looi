import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type BackgroundProcessExitStatus = {
  supported: boolean;
  pid: number | null;
  scheduled: boolean;
  scheduledDelayMs: number | null;
  remainingMs: number | null;
};

export type PreviousBackgroundProcessExit = {
  epochMs: number;
  pid: number;
};

declare class BackgroundProcessExitNativeModule extends NativeModule {
  scheduleExit(delayMs: number): Promise<BackgroundProcessExitStatus>;
  cancelExit(): Promise<BackgroundProcessExitStatus>;
  getStatus(): Promise<BackgroundProcessExitStatus>;
  consumePreviousExitMarker(): Promise<PreviousBackgroundProcessExit | null>;
}

let cachedModule: BackgroundProcessExitNativeModule | null | undefined;

function getNativeModule(): BackgroundProcessExitNativeModule | null {
  if (Platform.OS !== "android") return null;
  if (cachedModule !== undefined) return cachedModule;
  try {
    cachedModule = requireNativeModule<BackgroundProcessExitNativeModule>("BackgroundProcessExit");
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

const unsupportedStatus: BackgroundProcessExitStatus = {
  supported: false,
  pid: null,
  scheduled: false,
  scheduledDelayMs: null,
  remainingMs: null,
};

export async function scheduleBackgroundProcessExit(
  delayMs: number
): Promise<BackgroundProcessExitStatus> {
  return (await getNativeModule()?.scheduleExit(delayMs)) ?? unsupportedStatus;
}

export async function cancelBackgroundProcessExit(): Promise<BackgroundProcessExitStatus> {
  return (await getNativeModule()?.cancelExit()) ?? unsupportedStatus;
}

export async function getBackgroundProcessExitStatus(): Promise<BackgroundProcessExitStatus> {
  return (await getNativeModule()?.getStatus()) ?? unsupportedStatus;
}

export async function consumePreviousBackgroundProcessExit(): Promise<PreviousBackgroundProcessExit | null> {
  return (await getNativeModule()?.consumePreviousExitMarker()) ?? null;
}
