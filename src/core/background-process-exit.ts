import {
  cancelBackgroundProcessExit as cancelNativeBackgroundProcessExit,
  consumePreviousBackgroundProcessExit,
  getBackgroundProcessExitStatus,
  scheduleBackgroundProcessExit as scheduleNativeBackgroundProcessExit,
  type BackgroundProcessExitStatus,
} from "../../modules/background-process-exit";

export const BACKGROUND_PROCESS_EXIT_DELAY_MS = 5_000;

let externalActivityLeaseDepth = 0;
const externalActivityLeaseReasons = new Set<string>();

export function hasExternalActivityLease(): boolean {
  return externalActivityLeaseDepth > 0;
}

export async function acquireExternalActivityLease(reason: string): Promise<void> {
  externalActivityLeaseDepth += 1;
  externalActivityLeaseReasons.add(reason);
  // If an external Android Activity is intentionally being launched while an
  // exit was already armed, cancel it before yielding control to that Activity.
  await cancelNativeBackgroundProcessExit();
}

export function releaseExternalActivityLease(reason: string): void {
  externalActivityLeaseDepth = Math.max(0, externalActivityLeaseDepth - 1);
  externalActivityLeaseReasons.delete(reason);
}

export async function withExternalActivityLease<T>(
  reason: string,
  task: () => Promise<T>
): Promise<T> {
  await acquireExternalActivityLease(reason);
  try {
    return await task();
  } finally {
    releaseExternalActivityLease(reason);
  }
}

export async function scheduleBackgroundHardExit(): Promise<
  BackgroundProcessExitStatus & { skippedForExternalActivity: boolean; leaseReasons: string }
> {
  if (hasExternalActivityLease()) {
    const status = await getBackgroundProcessExitStatus();
    return {
      ...status,
      skippedForExternalActivity: true,
      leaseReasons: Array.from(externalActivityLeaseReasons).join(","),
    };
  }
  const status = await scheduleNativeBackgroundProcessExit(BACKGROUND_PROCESS_EXIT_DELAY_MS);
  return { ...status, skippedForExternalActivity: false, leaseReasons: "" };
}

export async function cancelBackgroundHardExit(): Promise<BackgroundProcessExitStatus> {
  return cancelNativeBackgroundProcessExit();
}

export { consumePreviousBackgroundProcessExit };
