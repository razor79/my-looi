import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import {
  getLooiRobotRuntimeState,
  performLooiHeadGesture,
  stopLooiMotion,
} from "../device-tools/looi-robot";
import { useUserStore } from "../store/user";

export async function enterRobotSleepMode(source: "voice" | "manual" | "inactivity" = "manual") {
  const store = useUserStore.getState();
  if (store.robotSleeping) return { ok: true, sleeping: true, alreadySleeping: true };

  // Never leave the wheels moving while entering deep sleep.
  await stopLooiMotion().catch(() => undefined);
  if (getLooiRobotRuntimeState().connected) {
    await performLooiHeadGesture("sleepy").catch(() => undefined);
  }

  useUserStore.getState().setRobotSleeping(true);
  useUserStore.getState().setVoiceState("sleeping");
  recordDiagnosticEvent("app", "sleep-mode-entered", { source });
  const { pauseAppRuntime } = await import("./app-bootstrap");
  await pauseAppRuntime("sleep");
  return { ok: true, sleeping: true, wake: "single-tap-face" };
}

export async function wakeRobotFromFace() {
  if (!useUserStore.getState().robotSleeping) {
    return { ok: true, sleeping: false, alreadyAwake: true };
  }

  useUserStore.getState().setRobotSleeping(false);
  recordDiagnosticEvent("app", "sleep-mode-wake-by-face");
  const { resumeAppRuntime } = await import("./app-bootstrap");
  await resumeAppRuntime();
  const { markRobotInteraction } = await import("./robot-inactivity");
  markRobotInteraction("wake-face");
  return { ok: true, sleeping: false };
}
