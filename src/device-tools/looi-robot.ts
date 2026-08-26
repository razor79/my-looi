import {
  LooiRobot,
  type LooiConnectOptions,
  type LooiMoveDirection,
  type LooiRawNotification,
  type LooiTransport,
} from "@sourcebug/looi-sdk";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import {
  decodeFed9SensorFrame,
  PROVISIONAL_TOF_OBSTACLE_MM,
  type Fed9CliffSensors,
} from "./fed9-sensors";

const DEFAULT_MOVE_DURATION_MS = 700;
const MAX_MOVE_DURATION_MS = 1_800;
const FED9_LOG_INTERVAL_MS = 2_000;
const BLE_DRIVE_START_TIMEOUT_MS = 1_800;
const BLE_STOP_TIMEOUT_MS = 900;
const SENSOR_CONNECT_WARMUP_MS = 700;
const DRIVE_REVALIDATION_SETTLE_MS = 120;
const SENSOR_WARMUP_POLL_MS = 25;
export const CLIFF_REARM_STABLE_MS = 250;
export const CLIFF_ESCAPE_CLEAR_MS = 650;
export const MANUAL_REPOSITION_SAFE_MS = 900;
export const CONTINUOUS_MOTION_DEADMAN_MS = 5_000;
/** Real captures occasionally space FED9 notifications ~5 s apart. */
/** First physical calibration estimates; Settings exposes dedicated test buttons. */
export const TURN_90_MS = 650;
export const TURN_180_MS = 1_560;
let lastFed9LoggedAt = 0;
let lastCliffLoggedAt = 0;
let lastCliffLoggedSafe: boolean | null = null;
let continuousMotionDeadmanTimer: ReturnType<typeof setTimeout> | null = null;
let frontNearEdgeClearTimer: ReturnType<typeof setTimeout> | null = null;
let rearNearEdgeClearTimer: ReturnType<typeof setTimeout> | null = null;
let motionSequenceAbortGeneration = 0;

type LooiSensorSnapshot = {
  lastFed9Hex: string | null;
  lastFed9At: number | null;
  docked: boolean | null;
  /** Raw five-bit FED9 binary frame retained for diagnostics/backward UI compatibility. */
  cliffGroundFlags: boolean[] | null;
  /** Calibrated 2026-08-16 directional downward sensors. */
  cliffSensors: Fed9CliffSensors | null;
  /** First binary FED9 byte; retained as an unknown marker/status bit only. */
  cliffMarker: boolean | null;
  /** Current raw all-four-safe state (re-arm stability is evaluated separately). */
  cliffSafe: boolean | null;
  /** Timestamp from which each sensor has continuously reported ground. */
  cliffSafeSince: Record<keyof Fed9CliffSensors, number | null>;
  /** Provisional FED9 decode of 0e + uint16le as front TOF millimetres. */
  tofDistanceMm: number | null;
  /** null means TOF has never been decoded; false with null distance means valid no-target. */
  obstacleNear: boolean | null;
};

export type LooiSafetyState = "safe" | "unsafe" | "unknown";

type NearEdgeLatch = {
  front: boolean;
  rear: boolean;
  frontSince: number | null;
  rearSince: number | null;
};

type LooiRuntimeState = {
  robot: LooiRobot | null;
  transport: LooiTransport | null;
  connected: boolean;
  connecting: Promise<LooiRobot> | null;
  lastError: string | null;
  motionGeneration: number;
  motionActive: boolean;
  activeDirection: LooiMoveDirection | null;
  sensors: LooiSensorSnapshot;
  nearEdge: NearEdgeLatch;
  lastSafetyStopReason: string | null;
  lastMotionBlockReason: string | null;
  driveControlRevalidationRequired: boolean;
  driveControlRevalidationReason: string | null;
};

function emptySensors(): LooiSensorSnapshot {
  return {
    lastFed9Hex: null,
    lastFed9At: null,
    docked: null,
    cliffGroundFlags: null,
    cliffSensors: null,
    cliffMarker: null,
    cliffSafe: null,
    cliffSafeSince: { frontLeft: null, frontRight: null, rearLeft: null, rearRight: null },
    tofDistanceMm: null,
    obstacleNear: null,
  };
}

function emptyNearEdgeLatch(): NearEdgeLatch {
  return { front: false, rear: false, frontSince: null, rearSince: null };
}


type LooiRuntimeStateListener = () => void;
const runtimeStateListeners = new Set<LooiRuntimeStateListener>();

function emitLooiRobotRuntimeStateChanged(): void {
  for (const listener of runtimeStateListeners) {
    try {
      listener();
    } catch {
      // UI/status observers must never interfere with BLE control.
    }
  }
}

export function subscribeLooiRobotRuntimeState(listener: LooiRuntimeStateListener): () => void {
  runtimeStateListeners.add(listener);
  return () => runtimeStateListeners.delete(listener);
}

const state: LooiRuntimeState = {
  robot: null,
  transport: null,
  connected: false,
  connecting: null,
  lastError: null,
  motionGeneration: 0,
  motionActive: false,
  activeDirection: null,
  sensors: emptySensors(),
  nearEdge: emptyNearEdgeLatch(),
  lastSafetyStopReason: null,
  lastMotionBlockReason: null,
  driveControlRevalidationRequired: false,
  driveControlRevalidationReason: null,
};

/** Bind the platform-specific LOOI BLE transport. */
export function configureLooiRobotTransport(transport: LooiTransport): void {
  state.transport = transport;
  state.robot = new LooiRobot(transport);
  state.connected = false;
  state.connecting = null;
  state.lastError = null;
  state.motionGeneration += 1;
  state.motionActive = false;
  state.activeDirection = null;
  state.sensors = emptySensors();
  state.nearEdge = emptyNearEdgeLatch();
  clearNearEdgeEscapeTimers();
  state.lastSafetyStopReason = null;
  state.lastMotionBlockReason = null;
  emitLooiRobotRuntimeStateChanged();
}

export function markLooiDriveControlNeedsRevalidation(reason: string): void {
  state.driveControlRevalidationRequired = true;
  state.driveControlRevalidationReason = reason;
  recordDiagnosticEvent("robot", "ble-drive-channel-revalidation-required", { reason });
  emitLooiRobotRuntimeStateChanged();
}

export function handleLooiRobotTransportDisconnected(error?: unknown): void {
  const message = error instanceof Error ? error.message : error ? String(error) : "BLE link disconnected";
  const previousDirection = state.activeDirection;
  state.driveControlRevalidationRequired = true;
  state.driveControlRevalidationReason = "transport-disconnected";
  state.motionGeneration += 1;
  state.robot?.stopMoveLoop({ writeStop: false });
  state.connected = false;
  state.connecting = null;
  state.lastError = message;
  state.motionActive = false;
  state.activeDirection = null;
  state.sensors = emptySensors();
  state.nearEdge = emptyNearEdgeLatch();
  clearNearEdgeEscapeTimers();
  lastFed9LoggedAt = 0;
  lastCliffLoggedAt = 0;
  lastCliffLoggedSafe = null;
  recordDiagnosticEvent("robot", "ble-disconnected", {
    error: message,
    previousDirection: previousDirection ?? "none",
  });
  recordDiagnosticEvent("robot", "ble-drive-channel-revalidation-required", {
    reason: "transport-disconnected",
  });
  emitLooiRobotRuntimeStateChanged();
}

export async function connectLooiRobot(options: LooiConnectOptions = {}): Promise<{
  ok: true;
  connected: true;
}> {
  await getRobot(options);
  return { ok: true, connected: true };
}

export async function disconnectLooiRobot(): Promise<void> {
  clearContinuousMotionDeadman();
  await stopLooiMotion("disconnect").catch(() => undefined);
  state.connecting = null;
  state.connected = false;
  state.lastError = null;
  state.sensors = emptySensors();
  state.nearEdge = emptyNearEdgeLatch();
  clearNearEdgeEscapeTimers();
  lastFed9LoggedAt = 0;
  lastCliffLoggedAt = 0;
  lastCliffLoggedSafe = null;
  emitLooiRobotRuntimeStateChanged();
  await state.robot?.disconnect();
}

function clearNearEdgeEscapeTimers(): void {
  if (frontNearEdgeClearTimer) clearTimeout(frontNearEdgeClearTimer);
  if (rearNearEdgeClearTimer) clearTimeout(rearNearEdgeClearTimer);
  frontNearEdgeClearTimer = null;
  rearNearEdgeClearTimer = null;
}

function allCliffSensorsSafe(): boolean {
  const sensors = state.sensors.cliffSensors;
  return Boolean(
    sensors &&
    sensors.frontLeft &&
    sensors.frontRight &&
    sensors.rearLeft &&
    sensors.rearRight
  );
}

function allCliffSensorsStableFor(minimumMs: number, now = Date.now()): boolean {
  if (!allCliffSensorsSafe()) return false;
  const safeSince = state.sensors.cliffSafeSince;
  return (Object.keys(safeSince) as Array<keyof Fed9CliffSensors>).every((key) => {
    const since = safeSince[key];
    return since !== null && now - since >= minimumMs;
  });
}

/**
 * Explicit recovery for the rare safety deadlock where a rear/front near-edge
 * latch and the opposite TOF obstacle leave no legal wheel direction. It never
 * moves the robot. The user must physically reposition LOOI, then explicitly
 * confirm recovery in Settings; all four downward sensors must have remained
 * SAFE for a conservative interval before the latch can be cleared.
 */
export function clearLooiNearEdgeAfterManualReposition() {
  if (state.motionActive) {
    throw new Error("Нельзя сбросить near-edge во время движения.");
  }
  if (!state.nearEdge.front && !state.nearEdge.rear) {
    return { ok: true, cleared: false, reason: "not-latched" as const };
  }
  if (!state.sensors.cliffSensors || !allCliffSensorsStableFor(MANUAL_REPOSITION_SAFE_MS)) {
    recordDiagnosticEvent("robot", "near-edge-manual-clear-blocked", {
      reason: state.sensors.cliffSensors ? "cliff-not-stable" : "cliff-unknown",
      requiredSafeMs: MANUAL_REPOSITION_SAFE_MS,
      front: state.nearEdge.front,
      rear: state.nearEdge.rear,
    });
    throw new Error(`Сначала переставьте Луи полностью на поверхность и подождите ${MANUAL_REPOSITION_SAFE_MS} мс.`);
  }
  const clearedFront = state.nearEdge.front;
  const clearedRear = state.nearEdge.rear;
  clearNearEdgeEscapeTimers();
  state.nearEdge = emptyNearEdgeLatch();
  state.lastMotionBlockReason = null;
  recordDiagnosticEvent("robot", "near-edge-manual-cleared", {
    front: clearedFront,
    rear: clearedRear,
    requiredSafeMs: MANUAL_REPOSITION_SAFE_MS,
  });
  emitLooiRobotRuntimeStateChanged();
  return { ok: true, cleared: true, front: clearedFront, rear: clearedRear };
}

function latchNearEdge(side: "front" | "rear", now: number, details: Record<string, unknown> = {}): void {
  const key = side === "front" ? "front" : "rear";
  const sinceKey = side === "front" ? "frontSince" : "rearSince";
  const wasLatched = state.nearEdge[key];
  state.nearEdge[key] = true;
  if (!wasLatched) state.nearEdge[sinceKey] = now;
  if (side === "front" && frontNearEdgeClearTimer) {
    clearTimeout(frontNearEdgeClearTimer);
    frontNearEdgeClearTimer = null;
  }
  if (side === "rear" && rearNearEdgeClearTimer) {
    clearTimeout(rearNearEdgeClearTimer);
    rearNearEdgeClearTimer = null;
  }
  if (!wasLatched) {
    recordDiagnosticEvent("robot", "near-edge-latched", {
      side,
      ...details,
    });
    emitLooiRobotRuntimeStateChanged();
  }
}

function maybeArmNearEdgeEscapeClear(source: string): void {
  if (!state.motionActive || !allCliffSensorsSafe()) return;
  const direction = state.activeDirection;

  if (state.nearEdge.front && direction === "back" && !frontNearEdgeClearTimer) {
    const generation = state.motionGeneration;
    const startedAt = Date.now();
    frontNearEdgeClearTimer = setTimeout(() => {
      frontNearEdgeClearTimer = null;
      if (
        generation !== state.motionGeneration ||
        !state.motionActive ||
        state.activeDirection !== "back" ||
        !state.nearEdge.front ||
        !allCliffSensorsSafe()
      ) return;
      state.nearEdge.front = false;
      state.nearEdge.frontSince = null;
      recordDiagnosticEvent("robot", "near-edge-cleared", {
        side: "front",
        escapeDirection: "back",
        source,
        escapeStableMs: Date.now() - startedAt,
      });
      emitLooiRobotRuntimeStateChanged();
    }, CLIFF_ESCAPE_CLEAR_MS);
    recordDiagnosticEvent("robot", "near-edge-escape-progress", {
      side: "front",
      direction: "back",
      source,
      requiredMs: CLIFF_ESCAPE_CLEAR_MS,
    });
  }

  if (state.nearEdge.rear && direction === "forward" && !rearNearEdgeClearTimer) {
    const generation = state.motionGeneration;
    const startedAt = Date.now();
    rearNearEdgeClearTimer = setTimeout(() => {
      rearNearEdgeClearTimer = null;
      if (
        generation !== state.motionGeneration ||
        !state.motionActive ||
        state.activeDirection !== "forward" ||
        !state.nearEdge.rear ||
        !allCliffSensorsSafe()
      ) return;
      state.nearEdge.rear = false;
      state.nearEdge.rearSince = null;
      recordDiagnosticEvent("robot", "near-edge-cleared", {
        side: "rear",
        escapeDirection: "forward",
        source,
        escapeStableMs: Date.now() - startedAt,
      });
      emitLooiRobotRuntimeStateChanged();
    }, CLIFF_ESCAPE_CLEAR_MS);
    recordDiagnosticEvent("robot", "near-edge-escape-progress", {
      side: "rear",
      direction: "forward",
      source,
      requiredMs: CLIFF_ESCAPE_CLEAR_MS,
    });
  }
}

function requiredCliffSensorKeys(direction?: LooiMoveDirection): Array<keyof Fed9CliffSensors> {
  if (direction === "forward") return ["frontLeft", "frontRight"];
  if (direction === "back") return ["rearLeft", "rearRight"];
  if (direction === "left" || direction === "right" || direction === undefined) {
    return ["frontLeft", "frontRight", "rearLeft", "rearRight"];
  }
  return [];
}

function cliffDirectionLabel(direction?: LooiMoveDirection): "front" | "rear" | "turn" | "all" | "none" {
  if (direction === "forward") return "front";
  if (direction === "back") return "rear";
  if (direction === "left" || direction === "right") return "turn";
  if (direction === undefined) return "all";
  return "none";
}

function areRequiredCliffSensorsStable(direction?: LooiMoveDirection, now = Date.now()): boolean {
  const sensors = state.sensors.cliffSensors;
  if (!sensors) return true;
  const keys = requiredCliffSensorKeys(direction);
  return keys.every((key) => {
    if (!sensors[key]) return false;
    const safeSince = state.sensors.cliffSafeSince[key];
    return safeSince !== null && now - safeSince >= CLIFF_REARM_STABLE_MS;
  });
}

function computeSafety(direction?: LooiMoveDirection) {
  const now = Date.now();
  const sensorAgeMs = state.sensors.lastFed9At === null ? null : now - state.sensors.lastFed9At;
  let safetyState: LooiSafetyState = "safe";
  let reason: string | null = null;

  // A cliff encountered while the robot is moving leaves a directional
  // near-edge latch. A transient SAFE frame alone does not remove it: risky
  // motion stays blocked until the robot has actually driven away from the edge
  // for a short, known interval. This avoids immediately rotating back onto the
  // same edge after a safety STOP.
  if ((direction === "left" || direction === "right") && (state.nearEdge.front || state.nearEdge.rear)) {
    safetyState = "unsafe";
    reason = "near-edge-turn";
  } else if (direction === "forward" && state.nearEdge.front) {
    safetyState = "unsafe";
    reason = "near-edge-front";
  } else if (direction === "back" && state.nearEdge.rear) {
    safetyState = "unsafe";
    reason = "near-edge-rear";
  }

  // FED9 behaves like an event stream, not a heartbeat. Once a directional
  // cliff state is observed it remains authoritative until a later notification
  // changes it or BLE resets. Firmware does not reliably emit a cliff frame on
  // every fresh connection, so before the first calibrated cliff frame we keep
  // the historical v1.1.41 policy: any FED9 traffic proves the stream exists.
  if (safetyState === "safe" && state.sensors.lastFed9At === null) {
    safetyState = "unknown";
    reason = "fed9-never-seen";
  } else if (safetyState === "safe" && state.sensors.cliffSensors) {
    const required = requiredCliffSensorKeys(direction);
    const unsafe = required.filter((key) => !state.sensors.cliffSensors?.[key]);
    if (unsafe.length > 0) {
      safetyState = "unsafe";
      reason = `cliff-${cliffDirectionLabel(direction)}`;
    } else if (required.length > 0 && !areRequiredCliffSensorsStable(direction, now)) {
      // Unsafe is immediate; re-enabling motion is intentionally debounced so a
      // single transient 11111 cannot immediately drive the robot back at an edge.
      safetyState = "unknown";
      reason = "cliff-rearming";
    }
  }

  if (safetyState === "safe" && direction === "forward" && state.sensors.obstacleNear === null) {
    safetyState = "unknown";
    reason = "tof-unknown";
  } else if (safetyState === "safe" && direction === "forward" && state.sensors.obstacleNear) {
    safetyState = "unsafe";
    reason = "obstacle";
  }

  return {
    state: safetyState,
    reason,
    streamFresh: state.sensors.lastFed9At !== null,
    sensorAgeMs,
    interlockArmed: safetyState === "safe",
    thresholdMm: PROVISIONAL_TOF_OBSTACLE_MM,
    cliffRearmStableMs: CLIFF_REARM_STABLE_MS,
    cliffEscapeClearMs: CLIFF_ESCAPE_CLEAR_MS,
    nearEdgeFront: state.nearEdge.front,
    nearEdgeRear: state.nearEdge.rear,
    cliffDirection: cliffDirectionLabel(direction),
    decoder: "calibrated-fed9-v2" as const,
  };
}

export function getLooiRobotRuntimeState() {
  const transportDiagnostics = state.transport as LooiTransport & {
    getGattSnapshot?: () => {
      deviceId: string | null;
      services: string[];
      characteristics: Array<{ serviceUuid: string; uuid: string; key: string | null }>;
      availableKeys: string[];
      legacyHandshakeAvailable: boolean;
    };
  } | null;
  return {
    configured: Boolean(state.robot),
    connected: state.connected,
    connecting: Boolean(state.connecting),
    lastError: state.lastError,
    motionActive: state.motionActive,
    activeDirection: state.activeDirection,
    driveControlReady: state.connected && !state.driveControlRevalidationRequired,
    driveControlRevalidationReason: state.driveControlRevalidationReason,
    sensors: { ...state.sensors },
    nearEdge: { ...state.nearEdge },
    safety: {
      ...computeSafety(state.activeDirection ?? undefined),
      lastSafetyStopReason: state.lastSafetyStopReason,
      lastMotionBlockReason: state.lastMotionBlockReason,
      provisionalCliffObserved: state.sensors.cliffSafe !== null,
    },
    gatt: transportDiagnostics?.getGattSnapshot?.() ?? null,
  };
}

async function getRobot(options: LooiConnectOptions = {}): Promise<LooiRobot> {
  if (!state.robot) {
    throw new Error("LOOI transport is not configured. Bind a LooiTransport before using robot tools.");
  }
  if (state.connected) return state.robot;
  if (!state.connecting) {
    const wrappedOptions: LooiConnectOptions = {
      ...options,
      onDock: (event) => {
        state.sensors.docked = event.docked;
        options.onDock?.(event);
      },
      onRawNotify: (event) => {
        rememberRawNotification(event);
        options.onRawNotify?.(event);
      },
    };
    const connecting = state.robot.connect(wrappedOptions)
      .then(async () => {
        if (state.driveControlRevalidationRequired) {
          const reason = state.driveControlRevalidationReason ?? "reconnect";
          const startedAt = Date.now();
          // Re-establish the already-known FED0 control path with the safest
          // possible frame: the existing STOP payload. No movement payloads,
          // timing, deadman, cliff logic or command grammar are changed.
          await withDeadline(
            (state.robot as LooiRobot).stop(),
            BLE_STOP_TIMEOUT_MS,
            `BLE drive channel revalidation timed out after ${BLE_STOP_TIMEOUT_MS}ms`
          );
          await delay(DRIVE_REVALIDATION_SETTLE_MS);
          state.driveControlRevalidationRequired = false;
          state.driveControlRevalidationReason = null;
          recordDiagnosticEvent("robot", "ble-drive-channel-revalidated", {
            reason,
            settleMs: DRIVE_REVALIDATION_SETTLE_MS,
            durationMs: Date.now() - startedAt,
            method: "existing-stop-frame",
          });
        }
        state.connected = true;
        state.lastError = null;
        emitLooiRobotRuntimeStateChanged();
        return state.robot as LooiRobot;
      })
      .catch((error) => {
        state.connected = false;
        state.lastError = error instanceof Error ? error.message : String(error);
        emitLooiRobotRuntimeStateChanged();
        throw error;
      })
      .finally(() => {
        if (state.connecting === connecting) state.connecting = null;
        emitLooiRobotRuntimeStateChanged();
      });
    state.connecting = connecting;
    emitLooiRobotRuntimeStateChanged();
  }
  return state.connecting;
}

async function waitForMovementSafetyReady(
  direction: Exclude<LooiMoveDirection, "stop">,
  source: string
): Promise<void> {
  // Immediately after a fresh BLE/GATT connect, FED9 can arrive a few tens of
  // milliseconds after connect() resolves. v1.1.31 evaluated safety in that tiny
  // window and rejected a perfectly valid first command as fed9-never-seen.
  // Wait only while state is UNKNOWN; known unsafe state still blocks immediately.
  const startedAt = Date.now();
  let safety = computeSafety(direction);
  if (safety.state !== "unknown") return;

  recordDiagnosticEvent("robot", "sensor-warmup-wait", {
    source,
    direction,
    reason: safety.reason ?? "unknown",
    timeoutMs: SENSOR_CONNECT_WARMUP_MS,
  });

  while (Date.now() - startedAt < SENSOR_CONNECT_WARMUP_MS) {
    await delay(SENSOR_WARMUP_POLL_MS);
    safety = computeSafety(direction);
    if (safety.state !== "unknown") {
      recordDiagnosticEvent("robot", "sensor-warmup-finished", {
        source,
        direction,
        safetyState: safety.state,
        reason: safety.reason ?? "none",
        waitMs: Date.now() - startedAt,
      });
      return;
    }
  }

  recordDiagnosticEvent("robot", "sensor-warmup-timeout", {
    source,
    direction,
    reason: safety.reason ?? "unknown",
    waitMs: Date.now() - startedAt,
  });
}

function assertMovementAllowed(direction: LooiMoveDirection, source: string): void {
  const safety = computeSafety(direction);
  if (safety.state === "safe") {
    state.lastMotionBlockReason = null;
    return;
  }

  const reason = safety.reason ?? safety.state;
  state.lastMotionBlockReason = reason;
  recordDiagnosticEvent("robot", "movement-blocked", {
    source,
    direction,
    safetyState: safety.state,
    reason,
    sensorAgeMs: safety.sensorAgeMs ?? "never",
    cliffSafe: state.sensors.cliffSafe ?? "unknown",
    obstacleNear: state.sensors.obstacleNear ?? "unknown",
    nearEdgeFront: state.nearEdge.front,
    nearEdgeRear: state.nearEdge.rear,
  });
  throw new Error(
    safety.state === "unknown"
      ? `Движение заблокировано: состояние датчиков неизвестно (${reason}).`
      : `Движение заблокировано системой безопасности (${reason}).`
  );
}

async function runBoundedMotion(
  direction: Exclude<LooiMoveDirection, "stop">,
  durationMs: number,
  mode: "manual-bounded" | "calibrated-turn",
  details: Record<string, unknown> = {}
) {
  const robot = await getRobot();
  await waitForMovementSafetyReady(direction, mode);
  assertMovementAllowed(direction, mode);
  const boundedDurationMs = clampDuration(durationMs);
  prepareMotionStart(robot, direction, mode);
  // No blocking BLE STOP is sent before an idle start. Re-check the cached
  // interlock immediately before the first actual drive frame.
  assertMovementAllowed(direction, mode);
  const generation = state.motionGeneration;
  let completed = false;
  state.motionActive = true;
  state.activeDirection = direction;
  recordDiagnosticEvent("robot", "move-start", { direction, durationMs: boundedDurationMs, mode, ...details });
  try {
    await startDriveWithDeadline(robot, direction, mode);
    recordDiagnosticEvent("robot", "ble-drive-first-write", { direction, mode, ok: true });
    maybeArmNearEdgeEscapeClear(mode);
    await delay(boundedDurationMs);
  } catch (error) {
    recordDiagnosticEvent("robot", "ble-drive-write-failed", {
      direction,
      mode,
      error: error instanceof Error ? error.message : String(error),
    });
    await recoverAfterBleFailure(robot, error, `${mode}-start`);
    throw error;
  } finally {
    if (generation === state.motionGeneration) {
      robot.stopMoveLoop({ writeStop: false });
      await stopRobotWithDeadline(robot, "duration-complete").catch(() => undefined);
      state.motionActive = false;
      state.activeDirection = null;
      state.lastSafetyStopReason = "duration-complete";
      completed = true;
      recordDiagnosticEvent("robot", "move-stop", { direction, reason: "duration-complete", mode, ...details });
    }
  }
  return { ok: true, direction, durationMs: boundedDurationMs, safetyBounded: true, mode, completed };
}

/** Time-bounded movement used by manual Settings tests. */
export async function moveLooi(direction: string, durationMs = DEFAULT_MOVE_DURATION_MS, _speed = 50) {
  const normalizedDirection = normalizeMoveDirection(direction);
  if (normalizedDirection === "stop") {
    await stopLooiMotion("manual-stop");
    return { ok: true, direction: normalizedDirection, durationMs: 0, safetyBounded: true };
  }
  if (normalizedDirection === "left" || normalizedDirection === "right") {
    recordDiagnosticEvent("robot", "manual-control-start", {
      direction: normalizedDirection,
      requestedDurationMs: durationMs,
      mode: "calibrated-turn-90",
    });
    return turnLooi(normalizedDirection, 90);
  }
  recordDiagnosticEvent("robot", "manual-control-start", { direction: normalizedDirection, durationMs });
  const result = await runBoundedMotion(normalizedDirection, durationMs, "manual-bounded");
  recordDiagnosticEvent("robot", "manual-control-finished", { direction: normalizedDirection, durationMs: result.durationMs });
  return result;
}

/** Calibrated bounded turn. First build uses time estimates that must be tuned on the real robot. */
export async function turnLooi(direction: "left" | "right", degrees: 90 | 180 = 90) {
  const robot = await getRobot();
  const durationMs = clampDuration(degrees === 180 ? TURN_180_MS : TURN_90_MS);
  const source = `turn-${degrees}`;
  await waitForMovementSafetyReady(direction, source);
  assertMovementAllowed(direction, source);
  prepareMotionStart(robot, direction, source);
  // Re-check immediately before wheel motion so a cliff event arriving during
  // command handling cannot slip through the turn interlock.
  assertMovementAllowed(direction, source);
  const generation = state.motionGeneration;
  let completed = false;
  state.motionActive = true;
  state.activeDirection = direction;
  recordDiagnosticEvent("robot", "move-start", {
    direction,
    durationMs,
    mode: "calibrated-turn",
    degrees,
    sensorGate: "calibrated-directional-cliff-v2",
  });
  try {
    await startDriveWithDeadline(robot, direction, "calibrated-turn");
    recordDiagnosticEvent("robot", "ble-drive-first-write", {
      direction,
      mode: "calibrated-turn",
      ok: true,
    });
    await delay(durationMs);
  } catch (error) {
    recordDiagnosticEvent("robot", "ble-drive-write-failed", {
      direction,
      mode: "calibrated-turn",
      error: error instanceof Error ? error.message : String(error),
    });
    await recoverAfterBleFailure(robot, error, "calibrated-turn-start");
    throw error;
  } finally {
    if (generation === state.motionGeneration) {
      robot.stopMoveLoop({ writeStop: false });
      await stopRobotWithDeadline(robot, "turn-duration-complete").catch(() => undefined);
      state.motionActive = false;
      state.activeDirection = null;
      state.lastSafetyStopReason = "duration-complete";
      completed = true;
      recordDiagnosticEvent("robot", "move-stop", {
        direction,
        reason: "duration-complete",
        mode: "calibrated-turn",
        degrees,
      });
    }
  }
  return { ok: true, direction, durationMs, degrees, safetyBounded: false, mode: "calibrated-turn" as const, completed };
}

/**
 * Start persistent translation. Only forward/backward may be continuous;
 * rotations are always bounded by turnLooi().
 */
export async function startLooiMotion(direction: string) {
  const robot = await getRobot();
  const normalizedDirection = normalizeMoveDirection(direction);
  if (normalizedDirection === "stop") {
    await stopLooiMotion("explicit-stop");
    return { ok: true, direction: normalizedDirection, continuous: false };
  }
  if (normalizedDirection === "left" || normalizedDirection === "right") {
    throw new Error("Continuous rotation is disabled; use turnLooi() for bounded turns.");
  }

  await waitForMovementSafetyReady(normalizedDirection, "continuous");
  assertMovementAllowed(normalizedDirection, "continuous");
  prepareMotionStart(robot, normalizedDirection, "continuous");
  assertMovementAllowed(normalizedDirection, "continuous");
  state.motionActive = true;
  state.activeDirection = normalizedDirection;
  try {
    await startDriveWithDeadline(robot, normalizedDirection, "continuous-until-stop");
    recordDiagnosticEvent("robot", "ble-drive-first-write", { direction: normalizedDirection, mode: "continuous-until-stop", ok: true });
    maybeArmNearEdgeEscapeClear("continuous");
  } catch (error) {
    state.motionActive = false;
    state.activeDirection = null;
    recordDiagnosticEvent("robot", "ble-drive-write-failed", {
      direction: normalizedDirection,
      mode: "continuous-until-stop",
      error: error instanceof Error ? error.message : String(error),
    });
    await recoverAfterBleFailure(robot, error, "continuous-start");
    throw error;
  }
  const generation = state.motionGeneration;
  armContinuousMotionDeadman(generation, normalizedDirection);
  recordDiagnosticEvent("robot", "move-start", {
    direction: normalizedDirection,
    mode: "continuous-until-stop",
    deadmanMs: CONTINUOUS_MOTION_DEADMAN_MS,
  });
  return {
    ok: true,
    direction: normalizedDirection,
    continuous: true,
    cliffInterlock: "calibrated-directional-fed9-v2",
    tofInterlock: "provisional-fed9",
  };
}

/** Immediate best-effort motor stop. Safe to call repeatedly. */
export async function stopLooiMotion(reason = "explicit"): Promise<void> {
  motionSequenceAbortGeneration += 1;
  clearContinuousMotionDeadman();
  clearNearEdgeEscapeTimers();
  state.motionGeneration += 1;
  const wasMoving = state.motionActive;
  const direction = state.activeDirection;
  state.motionActive = false;
  state.activeDirection = null;
  state.lastSafetyStopReason = reason;
  const robot = state.robot;
  if (!robot || !state.connected) return;
  robot.stopMoveLoop({ writeStop: false });
  const writeStartedAt = Date.now();
  try {
    await stopRobotWithDeadline(robot, reason);
    recordDiagnosticEvent("robot", "emergency-stop", {
      reason,
      wasMoving,
      direction: direction ?? "none",
      bleWriteMs: Date.now() - writeStartedAt,
    });
  } catch (error) {
    recordDiagnosticEvent("robot", "emergency-stop-write-failed", {
      reason,
      wasMoving,
      direction: direction ?? "none",
      durationMs: Date.now() - writeStartedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    await recoverAfterBleFailure(robot, error, `stop-${reason}`);
  }
}

export async function setLooiLight(enabled: boolean) {
  const robot = await getRobot();
  await robot.setLight(enabled);
  return { ok: true, enabled };
}

export async function setLooiHead(direction: string) {
  const robot = await getRobot();
  await robot.setHead(direction);
  return { ok: true, direction };
}

/** Head-only conversational gestures: no wheel movement. */
export async function performLooiHeadGesture(gesture: string, repetitions = 1) {
  const robot = await getRobot();
  const count = Math.max(1, Math.min(5, Math.round(Number(repetitions) || 1)));
  switch (gesture) {
    case "nod":
      for (let i = 0; i < count; i += 1) {
        await robot.setHead("up");
        await delay(280);
        await robot.setHead("down");
        await delay(390);
        await robot.setHead("center");
        await delay(i + 1 < count ? 240 : 140);
      }
      break;
    case "curious":
      await robot.setHead("up");
      await delay(420);
      await robot.setHead("center");
      break;
    case "happy_bob":
      await robot.setHead("up");
      await delay(180);
      await robot.setHead("down");
      await delay(180);
      await robot.setHead("up");
      await delay(180);
      await robot.setHead("center");
      break;
    case "sleepy":
      await robot.setHead("down");
      await delay(550);
      await robot.setHead("center");
      break;
    default:
      throw new Error(`Unsupported LOOI head gesture: ${gesture}`);
  }
  recordDiagnosticEvent("robot", "head-gesture", { gesture, count: gesture === "nod" ? count : 1 });
  return { ok: true, gesture, count: gesture === "nod" ? count : 1, wheelsUsed: false };
}

/** Character-layer body/head reaction names. No reaction may bypass the safety controller. */
export type LooiCharacterReaction = "startled" | "pleased" | "annoyed" | "angry" | "victory";

function assertMotionSequenceActive(token: number, sequence: string, step: string): void {
  if (token === motionSequenceAbortGeneration) return;
  recordDiagnosticEvent("character", "motion-sequence-cancelled", { sequence, step, reason: "stop-or-safety" });
  throw new Error(`LOOI ${sequence} interrupted during ${step}`);
}

function assertSequencePrimitiveCompleted(
  result: { completed?: boolean },
  token: number,
  sequence: string,
  step: string
): void {
  if (result.completed !== false && token === motionSequenceAbortGeneration) return;
  recordDiagnosticEvent("character", "motion-sequence-cancelled", { sequence, step, reason: "primitive-interrupted" });
  throw new Error(`LOOI ${sequence} interrupted during ${step}`);
}

/**
 * Safe physical accents for UI character reactions. Head-only reactions never
 * start the wheels. Angry/victory body wiggles use the same directional cliff
 * interlock as manual movement and abort the remaining sequence if STOP/cliff
 * interrupts any primitive.
 */
export async function performLooiCharacterReaction(reaction: LooiCharacterReaction) {
  const sequenceToken = motionSequenceAbortGeneration;
  recordDiagnosticEvent("character", "physical-reaction-started", { reaction });
  try {
    switch (reaction) {
      case "startled":
        await performLooiHeadGesture("curious");
        assertMotionSequenceActive(sequenceToken, "character-startled", "head");
        break;
      case "pleased":
        await performLooiHeadGesture("happy_bob");
        assertMotionSequenceActive(sequenceToken, "character-pleased", "head");
        break;
      case "annoyed": {
        const robot = await getRobot();
        await robot.setHead("down");
        await delay(300);
        await robot.setHead("center");
        assertMotionSequenceActive(sequenceToken, "character-annoyed", "head");
        break;
      }
      case "angry": {
        const a = await runBoundedMotion("left", 140, "manual-bounded", { characterReaction: reaction, step: 1 });
        assertSequencePrimitiveCompleted(a, sequenceToken, "character-angry", "left-1");
        const b = await runBoundedMotion("right", 280, "manual-bounded", { characterReaction: reaction, step: 2 });
        assertSequencePrimitiveCompleted(b, sequenceToken, "character-angry", "right");
        const c = await runBoundedMotion("left", 140, "manual-bounded", { characterReaction: reaction, step: 3 });
        assertSequencePrimitiveCompleted(c, sequenceToken, "character-angry", "left-2");
        await performLooiHeadGesture("nod", 1);
        assertMotionSequenceActive(sequenceToken, "character-angry", "head-finish");
        break;
      }
      case "victory": {
        await performLooiHeadGesture("happy_bob");
        assertMotionSequenceActive(sequenceToken, "character-victory", "head-start");
        const a = await runBoundedMotion("left", 180, "manual-bounded", { characterReaction: reaction, step: 1 });
        assertSequencePrimitiveCompleted(a, sequenceToken, "character-victory", "left");
        const b = await runBoundedMotion("right", 360, "manual-bounded", { characterReaction: reaction, step: 2 });
        assertSequencePrimitiveCompleted(b, sequenceToken, "character-victory", "right");
        const c = await runBoundedMotion("left", 180, "manual-bounded", { characterReaction: reaction, step: 3 });
        assertSequencePrimitiveCompleted(c, sequenceToken, "character-victory", "left-return");
        break;
      }
    }
    recordDiagnosticEvent("character", "physical-reaction-finished", { reaction });
    return { ok: true, reaction };
  } catch (error) {
    await stopLooiMotion(`character-${reaction}-failed`).catch(() => undefined);
    recordDiagnosticEvent("character", "physical-reaction-failed", {
      reaction,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export type LooiDanceStyle = "bounded-wiggle-v1" | "happy-sway-v1" | "silly-shake-v1";
const LOOI_DANCE_STYLES: readonly LooiDanceStyle[] = [
  "bounded-wiggle-v1",
  "happy-sway-v1",
  "silly-shake-v1",
] as const;

function pickDanceStyle(): LooiDanceStyle {
  return LOOI_DANCE_STYLES[Math.floor(Math.random() * LOOI_DANCE_STYLES.length)] ?? "bounded-wiggle-v1";
}

/**
 * Short bounded dances. No autonomous translation is used. Every wheel
 * primitive passes through the existing calibrated cliff/near-edge controller.
 * If STOP or a sensor interlock interrupts one primitive, later dance steps are
 * cancelled rather than re-starting the wheels.
 */
export async function performLooiDance(requestedStyle: LooiDanceStyle | "random" = "random") {
  await stopLooiMotion("dance-start").catch(() => undefined);
  const sequenceToken = motionSequenceAbortGeneration;
  const style = requestedStyle === "random" ? pickDanceStyle() : requestedStyle;
  recordDiagnosticEvent("robot", "dance-started", { style, requestedStyle });
  try {
    if (style === "bounded-wiggle-v1") {
      await performLooiHeadGesture("happy_bob");
      assertMotionSequenceActive(sequenceToken, style, "head-start");
      const a = await turnLooi("left", 90);
      assertSequencePrimitiveCompleted(a, sequenceToken, style, "left-90");
      await performLooiHeadGesture("nod", 1);
      const b = await turnLooi("right", 180);
      assertSequencePrimitiveCompleted(b, sequenceToken, style, "right-180");
      await performLooiHeadGesture("happy_bob");
      const c = await turnLooi("left", 90);
      assertSequencePrimitiveCompleted(c, sequenceToken, style, "left-return");
      await performLooiHeadGesture("nod", 2);
    } else if (style === "happy-sway-v1") {
      await performLooiHeadGesture("happy_bob");
      assertMotionSequenceActive(sequenceToken, style, "head-start");
      const a = await turnLooi("left", 90);
      assertSequencePrimitiveCompleted(a, sequenceToken, style, "left-90");
      const b = await turnLooi("right", 90);
      assertSequencePrimitiveCompleted(b, sequenceToken, style, "right-return");
      await performLooiHeadGesture("happy_bob");
      await performLooiHeadGesture("nod", 1);
    } else {
      await performLooiHeadGesture("curious");
      assertMotionSequenceActive(sequenceToken, style, "head-start");
      const a = await runBoundedMotion("left", 160, "manual-bounded", { danceStyle: style, step: 1 });
      assertSequencePrimitiveCompleted(a, sequenceToken, style, "left-1");
      const b = await runBoundedMotion("right", 320, "manual-bounded", { danceStyle: style, step: 2 });
      assertSequencePrimitiveCompleted(b, sequenceToken, style, "right");
      const c = await runBoundedMotion("left", 160, "manual-bounded", { danceStyle: style, step: 3 });
      assertSequencePrimitiveCompleted(c, sequenceToken, style, "left-2");
      await performLooiHeadGesture("happy_bob");
    }
    recordDiagnosticEvent("robot", "dance-finished", { style });
    return { ok: true, style, wheelsUsed: true, bounded: true, availableStyles: [...LOOI_DANCE_STYLES] };
  } catch (error) {
    await stopLooiMotion("dance-failed").catch(() => undefined);
    recordDiagnosticEvent("robot", "dance-failed", {
      style,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}


function rememberRawNotification(event: LooiRawNotification): void {
  if (event.characteristic !== "fed9") return;
  const now = Date.now();
  state.sensors.lastFed9Hex = event.hex;
  state.sensors.lastFed9At = now;

  if (now - lastFed9LoggedAt >= FED9_LOG_INTERVAL_MS) {
    lastFed9LoggedAt = now;
    recordDiagnosticEvent("robot", "fed9-notify", { hex: event.hex });
  }

  const decoded = decodeFed9SensorFrame(event.bytes);
  if (decoded.kind === "dock") {
    state.sensors.docked = decoded.docked;
    return;
  }

  if (decoded.kind === "cliff") {
    const previousRaw = state.sensors.cliffGroundFlags?.join("") ?? null;
    const nextRaw = decoded.rawFlags.map((value) => (value ? "1" : "0")).join("");
    const previousSensors = state.sensors.cliffSensors;
    const sensorKeys: Array<keyof Fed9CliffSensors> = ["frontLeft", "frontRight", "rearLeft", "rearRight"];

    for (const key of sensorKeys) {
      const wasSafe = previousSensors?.[key] ?? null;
      const isSafe = decoded.sensors[key];
      if (!isSafe) {
        state.sensors.cliffSafeSince[key] = null;
      } else if (wasSafe !== true || state.sensors.cliffSafeSince[key] === null) {
        state.sensors.cliffSafeSince[key] = now;
      }
    }

    state.sensors.cliffGroundFlags = decoded.rawFlags;
    state.sensors.cliffSensors = decoded.sensors;
    state.sensors.cliffMarker = decoded.marker;
    state.sensors.cliffSafe = decoded.safe;

    const safeChanged = lastCliffLoggedSafe !== decoded.safe;
    if (previousRaw !== nextRaw && (safeChanged || now - lastCliffLoggedAt >= FED9_LOG_INTERVAL_MS)) {
      lastCliffLoggedAt = now;
      lastCliffLoggedSafe = decoded.safe;
      recordDiagnosticEvent("robot", "cliff-state", {
        rawFlags: nextRaw,
        marker: decoded.marker,
        frontLeft: decoded.sensors.frontLeft,
        frontRight: decoded.sensors.frontRight,
        rearLeft: decoded.sensors.rearLeft,
        rearRight: decoded.sensors.rearRight,
        safe: decoded.safe,
        decoder: "calibrated-fed9-v2",
      });
    }

    const direction = state.activeDirection;
    if (state.motionActive && direction && direction !== "stop") {
      const frontUnsafe = !decoded.sensors.frontLeft || !decoded.sensors.frontRight;
      const rearUnsafe = !decoded.sensors.rearLeft || !decoded.sensors.rearRight;
      if (frontUnsafe) {
        latchNearEdge("front", now, {
          motionDirection: direction,
          rawFlags: nextRaw,
          unsafeSensors: [
            !decoded.sensors.frontLeft ? "frontLeft" : null,
            !decoded.sensors.frontRight ? "frontRight" : null,
          ].filter(Boolean).join(","),
        });
      }
      if (rearUnsafe) {
        latchNearEdge("rear", now, {
          motionDirection: direction,
          rawFlags: nextRaw,
          unsafeSensors: [
            !decoded.sensors.rearLeft ? "rearLeft" : null,
            !decoded.sensors.rearRight ? "rearRight" : null,
          ].filter(Boolean).join(","),
        });
      }

      const required = requiredCliffSensorKeys(direction);
      const unsafeSensors = required.filter((key) => !decoded.sensors[key]);
      if (unsafeSensors.length > 0) {
        triggerSensorSafetyStop("cliff", {
          rawFlags: nextRaw,
          cliffDirection: cliffDirectionLabel(direction),
          unsafeSensors: unsafeSensors.join(","),
        });
      }
    }
    if (decoded.safe) maybeArmNearEdgeEscapeClear("fed9-safe");
    return;
  }

  if (decoded.kind === "tof") {
    const previousNear = state.sensors.obstacleNear;
    state.sensors.tofDistanceMm = decoded.distanceMm;
    state.sensors.obstacleNear = decoded.obstacleNear;
    if (previousNear !== decoded.obstacleNear) {
      recordDiagnosticEvent("robot", "tof-state", {
        distanceMm: decoded.distanceMm ?? "no-target",
        obstacleNear: decoded.obstacleNear,
        thresholdMm: PROVISIONAL_TOF_OBSTACLE_MM,
        decoder: "provisional-fed9-v1",
      });
    }
    if (decoded.obstacleNear && state.activeDirection === "forward") {
      triggerSensorSafetyStop("obstacle", { distanceMm: decoded.distanceMm });
    }
  }
}

function triggerSensorSafetyStop(reason: "cliff" | "obstacle", details: Record<string, unknown>): void {
  if (!state.motionActive) return;
  motionSequenceAbortGeneration += 1;
  clearContinuousMotionDeadman();
  clearNearEdgeEscapeTimers();
  const direction = state.activeDirection;
  state.motionActive = false;
  state.activeDirection = null;
  state.motionGeneration += 1;
  state.lastSafetyStopReason = reason;
  const robot = state.robot;
  if (!robot || !state.connected) return;
  robot.stopMoveLoop({ writeStop: false });
  const writeStartedAt = Date.now();
  void stopRobotWithDeadline(robot, `sensor-${reason}`)
    .then(() => {
      recordDiagnosticEvent("robot", "sensor-safety-stop", {
        reason,
        direction: direction ?? "unknown",
        bleWriteMs: Date.now() - writeStartedAt,
        ...details,
      });
    })
    .catch(async (error) => {
      recordDiagnosticEvent("robot", "sensor-safety-stop-failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      await recoverAfterBleFailure(robot, error, `sensor-${reason}`);
    });
}


function clearContinuousMotionDeadman(): void {
  if (!continuousMotionDeadmanTimer) return;
  clearTimeout(continuousMotionDeadmanTimer);
  continuousMotionDeadmanTimer = null;
}

function armContinuousMotionDeadman(
  generation: number,
  direction: Exclude<LooiMoveDirection, "stop">
): void {
  clearContinuousMotionDeadman();
  continuousMotionDeadmanTimer = setTimeout(() => {
    continuousMotionDeadmanTimer = null;
    if (generation !== state.motionGeneration || !state.motionActive || state.activeDirection !== direction) return;
    recordDiagnosticEvent("robot", "continuous-motion-deadman-fired", {
      direction,
      timeoutMs: CONTINUOUS_MOTION_DEADMAN_MS,
    });
    void stopLooiMotion("continuous-deadman-timeout").catch((error) => {
      recordDiagnosticEvent("robot", "continuous-motion-deadman-stop-failed", {
        direction,
        timeoutMs: CONTINUOUS_MOTION_DEADMAN_MS,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, CONTINUOUS_MOTION_DEADMAN_MS);
}

function prepareMotionStart(
  robot: LooiRobot,
  nextDirection: Exclude<LooiMoveDirection, "stop">,
  source: string
): void {
  clearContinuousMotionDeadman();
  clearNearEdgeEscapeTimers();
  const previousDirection = state.activeDirection;
  const wasMoving = state.motionActive;
  state.motionGeneration += 1;
  robot.stopMoveLoop({ writeStop: false });
  state.motionActive = false;
  state.activeDirection = null;
  if (wasMoving) {
    recordDiagnosticEvent("robot", "motion-replaced", {
      source,
      previousDirection: previousDirection ?? "unknown",
      nextDirection,
      bleStopWrite: false,
    });
  }
}

async function startDriveWithDeadline(
  robot: LooiRobot,
  direction: Exclude<LooiMoveDirection, "stop">,
  mode: string
): Promise<void> {
  try {
    await withDeadline(
      robot.startMoveLoop(direction),
      BLE_DRIVE_START_TIMEOUT_MS,
      `BLE drive start timed out after ${BLE_DRIVE_START_TIMEOUT_MS}ms`
    );
  } catch (error) {
    // Invalidate the SDK generation so a delayed first write can never arm its
    // 110ms repeating timer after the caller has already failed the command.
    robot.stopMoveLoop({ writeStop: false });
    recordDiagnosticEvent("robot", "ble-drive-start-timeout-or-failure", {
      direction,
      mode,
      timeoutMs: BLE_DRIVE_START_TIMEOUT_MS,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function stopRobotWithDeadline(robot: LooiRobot, reason: string): Promise<void> {
  await withDeadline(
    robot.stop(),
    BLE_STOP_TIMEOUT_MS,
    `BLE stop timed out after ${BLE_STOP_TIMEOUT_MS}ms (${reason})`
  );
}

async function recoverAfterBleFailure(robot: LooiRobot, error: unknown, operation: string): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  handleLooiRobotTransportDisconnected(message);
  recordDiagnosticEvent("robot", "ble-recovery-requested", { operation, error: message });
  // LooiRobot.disconnect() also clears its internal handshake-complete state.
  // This makes the next getRobot() a real reconnect instead of reusing stale
  // GATT state after Android has already dropped the device.
  await robot.disconnect().catch(() => undefined);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeMoveDirection(direction: string): LooiMoveDirection {
  switch (direction) {
    case "forward":
    case "back":
    case "left":
    case "right":
    case "stop":
      return direction;
    case "backward":
      return "back";
    default:
      throw new Error(`Unsupported LOOI move direction: ${direction}`);
  }
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MOVE_DURATION_MS;
  return Math.max(80, Math.min(Math.round(value), MAX_MOVE_DURATION_MS));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
