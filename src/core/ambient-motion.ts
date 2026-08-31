import { useCharacterReactionStore } from "../character/character-reaction";
import {
  getLooiRobotRuntimeState,
  performLooiAmbientPivot,
  performLooiHeadGesture,
} from "../device-tools/looi-robot";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { useConversationStore } from "../store/conversation";
import { useUserStore, type AmbientMotionLevel } from "../store/user";
import { isDrivingControlSessionActive } from "../voice/driving-control-session";
import { isMainScreenFocused } from "./main-screen-presence";

const BLOCKED_RETRY_MS = 500;
const OFF_RETRY_MS = 12_000;
const BLOCK_LOG_REPEAT_MS = 10_000;

const INITIAL_DELAY_MS: Record<Exclude<AmbientMotionLevel, "off">, readonly [number, number]> = {
  subtle: [6_000, 9_000],
  normal: [3_500, 5_500],
  lively: [1_800, 3_200],
};

const IDLE_DELAY_MS: Record<Exclude<AmbientMotionLevel, "off">, readonly [number, number]> = {
  subtle: [9_000, 15_000],
  normal: [5_000, 9_000],
  lively: [2_500, 5_500],
};

const INTERACTION_COOLDOWN_MS: Record<Exclude<AmbientMotionLevel, "off">, number> = {
  subtle: 3_500,
  normal: 2_200,
  lively: 1_200,
};

const PROCESSING_DELAY_MS: Record<Exclude<AmbientMotionLevel, "off">, readonly [number, number]> = {
  subtle: [1_800, 2_800],
  normal: [1_100, 1_900],
  lively: [700, 1_300],
};

const SPEAKING_DELAY_MS: Record<Exclude<AmbientMotionLevel, "off">, readonly [number, number]> = {
  subtle: [5_000, 8_000],
  normal: [2_800, 5_000],
  lively: [1_700, 3_100],
};

const BODY_PIVOT_MIN_MS = 180;
const BODY_PIVOT_MAX_MS = 230;
const BODY_HOLD_MIN_MS = 320;
const BODY_HOLD_MAX_MS = 700;

type MotionContext = "idle" | "processing" | "speaking";
type AmbientAction =
  | "head-curious"
  | "head-settle"
  | "conversation-think"
  | "conversation-speak"
  | "body-left"
  | "body-right";

function isHeadAmbientAction(action: AmbientAction): boolean {
  return action !== "body-left" && action !== "body-right";
}

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let lastInteractionAt = Date.now();
let actionInFlight = false;
let lastBlockedReason = "";
let lastBlockedLoggedAt = 0;
let coordinationHoldUntil = 0;
let headCoordinationHoldUntil = 0;
let lastHeadCoordinationSource = "";

function randomBetween(minimum: number, maximum: number): number {
  return Math.round(minimum + Math.random() * (maximum - minimum));
}

function rangeDelay(range: readonly [number, number]): number {
  return randomBetween(range[0], range[1]);
}

function activeLevel(): Exclude<AmbientMotionLevel, "off"> | null {
  const level = useUserStore.getState().preferences.ambientMotionLevel;
  return level === "off" ? null : level;
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(delayMs: number): void {
  if (!running) return;
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    void runOneAmbientAction();
  }, Math.max(200, Math.round(delayMs)));
}

function scheduleForContext(level: Exclude<AmbientMotionLevel, "off">, context: MotionContext): void {
  if (context === "processing") {
    schedule(rangeDelay(PROCESSING_DELAY_MS[level]));
  } else if (context === "speaking") {
    schedule(rangeDelay(SPEAKING_DELAY_MS[level]));
  } else {
    schedule(rangeDelay(IDLE_DELAY_MS[level]));
  }
}

function motionContext(): MotionContext {
  const conversation = useConversationStore.getState();
  if (conversation.isProcessing) return "processing";
  if (conversation.isSpeaking) return "speaking";
  return "idle";
}

function commonBlockReason(): string | null {
  if (Date.now() < coordinationHoldUntil) return "coordination-hold";
  const user = useUserStore.getState();
  if (user.preferences.ambientMotionLevel === "off") return "disabled";
  if (user.robotSleeping) return "robot-sleeping";
  if (!isMainScreenFocused()) return "main-not-focused";
  if (useCharacterReactionStore.getState().mood) return "character-reaction";
  if (isDrivingControlSessionActive()) return "driving-control";

  const conversation = useConversationStore.getState();
  // Realtime PCM keeps isListening=true while it is merely waiting for speech.
  // Only the explicit server-VAD flag means the human is actually talking.
  if (conversation.isUserSpeaking) return "user-speaking";

  const robot = getLooiRobotRuntimeState();
  if (!robot.connected) return "robot-disconnected";
  if (robot.motionActive) return "motion-active";
  return null;
}

function idleBlockReason(level: Exclude<AmbientMotionLevel, "off">): string | null {
  if (Date.now() - lastInteractionAt < INTERACTION_COOLDOWN_MS[level]) return "recent-interaction";
  return null;
}

function logBlocked(reason: string, context: MotionContext): void {
  const now = Date.now();
  if (reason === lastBlockedReason && now - lastBlockedLoggedAt < BLOCK_LOG_REPEAT_MS) return;
  lastBlockedReason = reason;
  lastBlockedLoggedAt = now;
  recordDiagnosticEvent("character", "ambient-motion-blocked", { reason, context });
}

function pickIdleAction(level: Exclude<AmbientMotionLevel, "off">): AmbientAction {
  if (level === "subtle") {
    return Math.random() < 0.62 ? "head-curious" : "head-settle";
  }

  const bodyChance = level === "lively" ? 0.46 : 0.30;
  const roll = Math.random();
  if (roll < bodyChance) return Math.random() < 0.5 ? "body-left" : "body-right";
  return Math.random() < 0.58 ? "head-curious" : "head-settle";
}

function pickConversationAction(context: "processing" | "speaking"): AmbientAction {
  if (context === "processing") return "conversation-think";
  return Math.random() < 0.68 ? "conversation-speak" : "head-curious";
}

async function performBodyPeek(direction: "left" | "right", token: number): Promise<void> {
  const robot = getLooiRobotRuntimeState();
  if (!robot.driveControlReady) return;

  const durationMs = randomBetween(BODY_PIVOT_MIN_MS, BODY_PIVOT_MAX_MS);
  const holdMs = randomBetween(BODY_HOLD_MIN_MS, BODY_HOLD_MAX_MS);
  const outward = await performLooiAmbientPivot(direction, durationMs);
  if (outward.completed === false || token !== generation || !running) return;

  await delay(holdMs);
  if (token !== generation || !running || useUserStore.getState().robotSleeping) return;
  if (isDrivingControlSessionActive() || useConversationStore.getState().isUserSpeaking) return;

  const afterHold = getLooiRobotRuntimeState();
  if (!afterHold.connected || afterHold.motionActive) return;

  const returnDirection = direction === "left" ? "right" : "left";
  await performLooiAmbientPivot(returnDirection, durationMs);
}

async function runOneAmbientAction(): Promise<void> {
  if (!running || actionInFlight) return;

  const level = activeLevel();
  const context = motionContext();
  if (!level) {
    logBlocked("disabled", context);
    schedule(OFF_RETRY_MS);
    return;
  }

  const commonBlocked = commonBlockReason();
  if (commonBlocked) {
    logBlocked(commonBlocked, context);
    schedule(commonBlocked === "disabled" ? OFF_RETRY_MS : BLOCKED_RETRY_MS);
    return;
  }

  if (context === "idle") {
    const idleBlocked = idleBlockReason(level);
    if (idleBlocked) {
      logBlocked(idleBlocked, context);
      schedule(BLOCKED_RETRY_MS);
      return;
    }
  }

  lastBlockedReason = "";
  const action = context === "idle" ? pickIdleAction(level) : pickConversationAction(context);
  if (isHeadAmbientAction(action) && Date.now() < headCoordinationHoldUntil) {
    logBlocked("head-coordination-hold", context);
    schedule(Math.max(200, Math.min(BLOCKED_RETRY_MS, headCoordinationHoldUntil - Date.now())));
    return;
  }
  const token = generation;
  actionInFlight = true;
  recordDiagnosticEvent("character", "ambient-motion-started", { action, level, context, requestedDurationMs: action === "body-left" || action === "body-right" ? `${BODY_PIVOT_MIN_MS}-${BODY_PIVOT_MAX_MS}` : undefined });

  try {
    if (action === "head-curious") {
      await performLooiHeadGesture("curious");
    } else if (action === "head-settle") {
      await performLooiHeadGesture("sleepy");
    } else if (action === "conversation-think") {
      await performLooiHeadGesture("thinking");
    } else if (action === "conversation-speak") {
      await performLooiHeadGesture("speaking_soft");
    } else {
      await performBodyPeek(action === "body-left" ? "left" : "right", token);
    }
    recordDiagnosticEvent("character", "ambient-motion-finished", {
      action,
      level,
      context,
      interrupted: token !== generation,
    });
  } catch (error) {
    recordDiagnosticEvent("character", "ambient-motion-skipped", {
      action,
      level,
      context,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    actionInFlight = false;
    if (running && token === generation) {
      scheduleForContext(level, motionContext());
    }
  }
}

/**
 * Temporarily keep low-priority ambient actions from starting while another
 * motion controller performs a bounded correction. Existing ambient actions
 * are allowed to finish so body peeks can return to their starting pose.
 */
export function holdAmbientMotionFor(durationMs: number, source = "motion-coordination"): void {
  const safeDurationMs = Math.max(0, Math.round(durationMs));
  if (safeDurationMs <= 0) return;
  coordinationHoldUntil = Math.max(coordinationHoldUntil, Date.now() + safeDurationMs);
  recordDiagnosticEvent("character", "ambient-motion-held", {
    source,
    durationMs: safeDurationMs,
  });
  if (!running || actionInFlight) return;
  clearTimer();
  schedule(Math.max(200, coordinationHoldUntil - Date.now()));
}


/**
 * Reserve only the head channel for a higher-priority controller. Idle body
 * peeks remain eligible, preserving Lively behavior while Camera Attention owns
 * gaze/head pose. An ambient head gesture already in flight is allowed to finish.
 */
export function holdAmbientHeadMotionFor(durationMs: number, source = "head-coordination"): void {
  const safeDurationMs = Math.max(0, Math.round(durationMs));
  if (safeDurationMs <= 0) return;
  const now = Date.now();
  const wasHeld = now < headCoordinationHoldUntil;
  headCoordinationHoldUntil = Math.max(headCoordinationHoldUntil, now + safeDurationMs);
  if (!wasHeld || source !== lastHeadCoordinationSource) {
    recordDiagnosticEvent("character", "ambient-head-motion-held", {
      source,
      durationMs: safeDurationMs,
    });
  }
  lastHeadCoordinationSource = source;
}

/** Start low-priority natural motion. Actual wheel movement remains tiny and safety-bounded. */
export function startAmbientMotionController(source = "runtime"): void {
  if (running) return;
  running = true;
  generation += 1;
  coordinationHoldUntil = 0;
  headCoordinationHoldUntil = 0;
  lastHeadCoordinationSource = "";
  lastInteractionAt = Date.now();
  lastBlockedReason = "";
  recordDiagnosticEvent("character", "ambient-motion-controller-started", { source });
  const level = activeLevel();
  schedule(level ? rangeDelay(INITIAL_DELAY_MS[level]) : OFF_RETRY_MS);
}

/** Stop scheduling natural motion. Background/sleep teardown owns BLE stop itself. */
export function stopAmbientMotionController(reason = "runtime"): void {
  if (!running && !timer) return;
  running = false;
  generation += 1;
  coordinationHoldUntil = 0;
  headCoordinationHoldUntil = 0;
  lastHeadCoordinationSource = "";
  clearTimer();
  recordDiagnosticEvent("character", "ambient-motion-controller-stopped", { reason });
}

/**
 * Give real user activity priority over idle body motion. We re-check quickly
 * afterwards so a processing/speaking head gesture can still happen naturally;
 * idle motion remains protected by its level-specific cooldown.
 */
export function noteAmbientMotionInteraction(source: string): void {
  lastInteractionAt = Date.now();
  generation += 1;
  if (!running) return;
  clearTimer();
  recordDiagnosticEvent("character", "ambient-motion-interaction", { source });
  schedule(300);
}

export function getAmbientMotionControllerState() {
  return {
    running,
    actionInFlight,
    lastInteractionAt,
    interactionCooldownMs: activeLevel() ? INTERACTION_COOLDOWN_MS[activeLevel()!] : 0,
    context: motionContext(),
    coordinationHoldRemainingMs: Math.max(0, coordinationHoldUntil - Date.now()),
    headCoordinationHoldRemainingMs: Math.max(0, headCoordinationHoldUntil - Date.now()),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
