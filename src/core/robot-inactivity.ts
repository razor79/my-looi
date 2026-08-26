import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { useUserStore } from "../store/user";

export const ROBOT_AUTO_SLEEP_MS = 15 * 60 * 1000;

let lastInteractionAt = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function startRobotInactivityTimer(): void {
  started = true;
  lastInteractionAt = Date.now();
  schedule();
}

export function stopRobotInactivityTimer(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function markRobotInteraction(_source: string): void {
  if (useUserStore.getState().robotSleeping) return;
  lastInteractionAt = Date.now();
  if (started) schedule();
}

export function getRobotInactivityState() {
  return {
    started,
    lastInteractionAt,
    autoSleepMs: ROBOT_AUTO_SLEEP_MS,
    remainingMs: Math.max(0, ROBOT_AUTO_SLEEP_MS - (Date.now() - lastInteractionAt)),
  };
}

function schedule(): void {
  if (!started) return;
  if (timer) clearTimeout(timer);

  if (useUserStore.getState().robotSleeping) {
    timer = null;
    return;
  }

  const remaining = Math.max(0, ROBOT_AUTO_SLEEP_MS - (Date.now() - lastInteractionAt));
  timer = setTimeout(() => {
    timer = null;
    void maybeAutoSleep();
  }, remaining || 1);
}

async function maybeAutoSleep(): Promise<void> {
  if (!started || useUserStore.getState().robotSleeping) return;

  const idleMs = Date.now() - lastInteractionAt;
  if (idleMs < ROBOT_AUTO_SLEEP_MS) {
    schedule();
    return;
  }

  recordDiagnosticEvent("app", "inactivity-auto-sleep", {
    idleMs,
    thresholdMs: ROBOT_AUTO_SLEEP_MS,
  });
  const { enterRobotSleepMode } = await import("./sleep-mode");
  await enterRobotSleepMode("inactivity");
}
