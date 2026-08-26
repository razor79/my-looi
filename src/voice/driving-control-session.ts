import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";

export const DRIVING_CONTROL_SESSION_TTL_MS = 30_000;

let activeUntil = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function clearExpiryTimer(): void {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function scheduleExpiry(currentGeneration: number): void {
  clearExpiryTimer();
  const delay = Math.max(0, activeUntil - Date.now());
  expiryTimer = setTimeout(() => {
    if (generation !== currentGeneration) return;
    if (activeUntil <= 0 || Date.now() < activeUntil) return;
    activeUntil = 0;
    expiryTimer = null;
    recordDiagnosticEvent("runtime", "driving-control-session-expired", {
      ttlMs: DRIVING_CONTROL_SESSION_TTL_MS,
    });
  }, delay + 10);
}

export function enterDrivingControlSession(reason: string): void {
  const wasActive = isDrivingControlSessionActive();
  generation += 1;
  activeUntil = Date.now() + DRIVING_CONTROL_SESSION_TTL_MS;
  scheduleExpiry(generation);
  recordDiagnosticEvent("runtime", wasActive ? "driving-control-session-refreshed" : "driving-control-session-entered", {
    reason,
    ttlMs: DRIVING_CONTROL_SESSION_TTL_MS,
    remainingMs: DRIVING_CONTROL_SESSION_TTL_MS,
  });
}

export function refreshDrivingControlSession(reason: string): void {
  enterDrivingControlSession(reason);
}

export function exitDrivingControlSession(reason: string): void {
  const wasActive = activeUntil > Date.now();
  generation += 1;
  activeUntil = 0;
  clearExpiryTimer();
  if (wasActive) {
    recordDiagnosticEvent("runtime", "driving-control-session-exited", { reason });
  }
}

export function isDrivingControlSessionActive(): boolean {
  if (activeUntil <= 0) return false;
  if (Date.now() < activeUntil) return true;
  generation += 1;
  activeUntil = 0;
  clearExpiryTimer();
  recordDiagnosticEvent("runtime", "driving-control-session-expired", {
    ttlMs: DRIVING_CONTROL_SESSION_TTL_MS,
    source: "lazy-check",
  });
  return false;
}

export function getDrivingControlSessionRemainingMs(): number {
  if (!isDrivingControlSessionActive()) return 0;
  return Math.max(0, activeUntil - Date.now());
}
