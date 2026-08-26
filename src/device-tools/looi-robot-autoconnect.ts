import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import {
  connectLooiRobot,
  configureLooiRobotTransport,
  disconnectLooiRobot,
  getLooiRobotRuntimeState,
  handleLooiRobotTransportDisconnected,
  markLooiDriveControlNeedsRevalidation,
  stopLooiMotion,
} from "./looi-robot";

export type SavedLooiRobot = {
  id: string;
  name: string;
};

export type LooiRobotCandidate = {
  id: string;
  name: string;
  rssi: number | null;
  selected: boolean;
};

type AutoConnectionResult = { ok: true; connected: true } | { ok: false; skipped: true; reason?: string };

const SAVED_ROBOT_KEY = "looi.robot.selected.v1";
const FOREGROUND_RETRY_DELAY_MS = 1_000;

let connectionPromise: Promise<AutoConnectionResult> | null = null;
let motionSafetySubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let disconnectReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let autoConnectionSuspended = false;

function clearReconnectTimer(): void {
  if (!disconnectReconnectTimer) return;
  clearTimeout(disconnectReconnectTimer);
  disconnectReconnectTimer = null;
}

function scheduleForegroundReconnectRetry(reason: string, error?: unknown): void {
  if (autoConnectionSuspended || AppState.currentState !== "active" || disconnectReconnectTimer) return;
  disconnectReconnectTimer = setTimeout(() => {
    disconnectReconnectTimer = null;
    if (autoConnectionSuspended || AppState.currentState !== "active" || getLooiRobotRuntimeState().connected) return;
    recordDiagnosticEvent("robot", "ble-foreground-reconnect-retry-start", { reason });
    void startLooiRobotAutoConnection()
      .then((result) => {
        recordDiagnosticEvent("robot", "ble-foreground-reconnect-retry-finished", {
          reason,
          ok: result.ok,
          skipped: "skipped" in result ? result.skipped : false,
          skipReason: "reason" in result ? result.reason ?? "none" : "none",
        });
      })
      .catch((retryError) => {
        recordDiagnosticEvent("robot", "ble-foreground-reconnect-retry-failed", {
          reason,
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
      });
  }, FOREGROUND_RETRY_DELAY_MS);
  recordDiagnosticEvent("robot", "ble-foreground-reconnect-retry-scheduled", {
    reason,
    delayMs: FOREGROUND_RETRY_DELAY_MS,
    error: error instanceof Error ? error.message : error ? String(error) : "none",
  });
}

function ensureMotionSafetyLifecycle(): void {
  if (motionSafetySubscription || Platform.OS === "web") return;
  motionSafetySubscription = AppState.addEventListener("change", (nextState) => {
    if (nextState === "active") return;
    // Mark reconnect suspended synchronously, before the async app lifecycle has
    // time to release audio/BLE. This closes the link-loss auto-reconnect race.
    autoConnectionSuspended = true;
    clearReconnectTimer();
    connectionPromise = null;
    void stopLooiMotion("app-background").catch((error) => {
      console.warn("[LOOI BLE] Emergency stop on app background failed", error);
    });
  });
}

export function startLooiRobotAutoConnection(): Promise<AutoConnectionResult> {
  ensureMotionSafetyLifecycle();
  if (process.env.EXPO_PUBLIC_LOOI_DISABLE_ROBOT_AUTOCONNECT === "1" || Platform.OS === "web") {
    return Promise.resolve({ ok: false, skipped: true, reason: "disabled" });
  }
  if (autoConnectionSuspended || AppState.currentState !== "active") {
    return Promise.resolve({ ok: false, skipped: true, reason: "background-suspended" });
  }

  const runtimeState = getLooiRobotRuntimeState();
  if (runtimeState.connected) {
    return Promise.resolve({ ok: true, connected: true });
  }

  if (!connectionPromise) {
    const attempt = connectSavedRobot();
    connectionPromise = attempt;
    const releaseAttempt = () => {
      // v1.1.37 retained the resolved promise forever. After an explicit BLE
      // disconnect a later auto-connect could therefore return stale success
      // without starting a new connection. Always release completed attempts.
      if (connectionPromise === attempt) connectionPromise = null;
    };
    void attempt.then(releaseAttempt, releaseAttempt);
  }

  return connectionPromise;
}

/** Hard lifecycle suspend used for screen-off/background and explicit robot sleep. */
export async function suspendLooiRobotAutoConnection(reason = "background"): Promise<void> {
  ensureMotionSafetyLifecycle();
  autoConnectionSuspended = true;
  clearReconnectTimer();
  connectionPromise = null;
  recordDiagnosticEvent("robot", "ble-autoconnect-suspended", { reason });
  markLooiDriveControlNeedsRevalidation(`lifecycle-${reason}`);
  await disconnectLooiRobot();
  recordDiagnosticEvent("robot", "ble-background-disconnect-complete", { reason });
}

/** Foreground resume: allow and immediately attempt reconnect of the saved robot. */
export async function resumeLooiRobotAutoConnection(reason = "foreground"): Promise<AutoConnectionResult> {
  ensureMotionSafetyLifecycle();
  if (Platform.OS === "web" || AppState.currentState !== "active") {
    return { ok: false, skipped: true, reason: "not-active" };
  }
  autoConnectionSuspended = false;
  recordDiagnosticEvent("robot", "ble-autoconnect-resumed", { reason });
  try {
    return await startLooiRobotAutoConnection();
  } catch (error) {
    // Android occasionally returns a transient "Operation was cancelled" on the
    // first reconnect after deep sleep even though a manual retry works seconds
    // later. Keep voice readiness independent from BLE, but schedule one clean
    // foreground-only retry instead of requiring the user to tap reconnect.
    scheduleForegroundReconnectRetry(reason, error);
    throw error;
  }
}

/** Main-screen recovery control: discard stale state and reconnect the saved robot now. */
export async function forceReconnectSavedLooiRobot(): Promise<AutoConnectionResult> {
  ensureMotionSafetyLifecycle();
  if (Platform.OS === "web") return { ok: false, skipped: true, reason: "web" };
  if (AppState.currentState !== "active") return { ok: false, skipped: true, reason: "not-active" };
  const saved = await getSavedLooiRobot();
  if (!saved) return { ok: false, skipped: true, reason: "no-saved-robot" };

  // Main-screen status is authoritative now. If BLE is already connected, a
  // recovery tap must not tear down a healthy GATT session and reconnect it.
  if (getLooiRobotRuntimeState().connected) {
    recordDiagnosticEvent("robot", "ble-force-reconnect-skipped", { reason: "already-connected" });
    return { ok: true, connected: true };
  }

  clearReconnectTimer();
  connectionPromise = null;
  // Prevent the intentional disconnect below from arming the link-loss retry.
  autoConnectionSuspended = true;
  recordDiagnosticEvent("robot", "ble-force-reconnect-start", { robotId: saved.id });
  markLooiDriveControlNeedsRevalidation("force-reconnect");
  try {
    await disconnectLooiRobot();
  } finally {
    autoConnectionSuspended = false;
  }

  const result = await configureAndConnect(saved);
  recordDiagnosticEvent("robot", "ble-force-reconnect-finished", { robotId: saved.id });
  return result;
}

export async function scanLooiRobotCandidates(): Promise<LooiRobotCandidate[]> {
  if (Platform.OS === "web") return [];

  const [{ scanLooiRobotCandidates }, saved] = await Promise.all([
    import("./react-native-ble-transport"),
    getSavedLooiRobot(),
  ]);
  const candidates = await scanLooiRobotCandidates();
  return candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    rssi: candidate.rssi,
    selected: candidate.id === saved?.id,
  }));
}

export async function connectSelectedLooiRobot(robot: SavedLooiRobot): Promise<{
  ok: true;
  connected: true;
  robot: SavedLooiRobot;
}> {
  ensureMotionSafetyLifecycle();
  autoConnectionSuspended = false;
  clearReconnectTimer();
  connectionPromise = null;
  const result = await configureAndConnect(robot);
  await saveSelectedLooiRobot(robot);
  return { ...result, robot };
}

export async function getSavedLooiRobot(): Promise<SavedLooiRobot | null> {
  const raw = await SecureStore.getItemAsync(SAVED_ROBOT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedLooiRobot>;
    if (!parsed.id || !parsed.name) return null;
    return { id: parsed.id, name: parsed.name };
  } catch {
    return null;
  }
}

export async function clearSavedLooiRobot(): Promise<void> {
  await SecureStore.deleteItemAsync(SAVED_ROBOT_KEY);
  connectionPromise = null;
  clearReconnectTimer();
  await disconnectLooiRobot();
}

async function connectSavedRobot(): Promise<AutoConnectionResult> {
  const saved = await getSavedLooiRobot();
  if (!saved) return { ok: false, skipped: true, reason: "no-saved-robot" };
  return configureAndConnect(saved);
}

async function configureAndConnect(robot: SavedLooiRobot): Promise<{ ok: true; connected: true }> {
  const { ReactNativeBleLooiTransport } = await import("./react-native-ble-transport");
  await disconnectLooiRobot();
  configureLooiRobotTransport(new ReactNativeBleLooiTransport({
    deviceId: robot.id,
    robotName: robot.name,
    onDisconnected: (error) => {
      handleLooiRobotTransportDisconnected(error);
      connectionPromise = null;
      clearReconnectTimer();
      // A real BLE link loss invalidates GATT and sensor state. Retry only while
      // the app is foregrounded and lifecycle reconnects are explicitly enabled.
      if (!autoConnectionSuspended && AppState.currentState === "active") {
        disconnectReconnectTimer = setTimeout(() => {
          disconnectReconnectTimer = null;
          void startLooiRobotAutoConnection().catch((reconnectError) => {
            console.warn("[LOOI BLE] Automatic reconnect after link loss failed", reconnectError);
          });
        }, 700);
      }
    },
  }));

  console.log(`[LOOI BLE] Connecting selected robot ${robot.name} (${robot.id})`);
  const result = await connectLooiRobot({
    onDock: ({ docked }) => {
      console.log(`[LOOI BLE] Dock state changed: ${docked ? "docked" : "undocked"}`);
    },
    onRawNotify: ({ characteristic, hex }) => {
      console.log(`[LOOI BLE] Notify ${characteristic}: ${hex}`);
    },
  });
  console.log("[LOOI BLE] Robot connected and handshake complete");
  return result;
}

async function saveSelectedLooiRobot(robot: SavedLooiRobot): Promise<void> {
  await SecureStore.setItemAsync(SAVED_ROBOT_KEY, JSON.stringify(robot));
}
