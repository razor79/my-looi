import { create } from "zustand";

import {
  getLocalFaceAttentionModule,
  type LocalFaceFrameEvent,
} from "../../modules/local-face-attention";
import {
  getLooiRobotRuntimeState,
  performLooiSocialAttentionPivot,
  setLooiHead,
} from "../device-tools/looi-robot";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { useConversationStore } from "../store/conversation";
import { useUserStore } from "../store/user";
import { isDrivingControlSessionActive } from "../voice/driving-control-session";
import { getAmbientMotionControllerState, holdAmbientHeadMotionFor, holdAmbientMotionFor } from "./ambient-motion";
import { isMainScreenFocused, subscribeMainScreenFocused } from "./main-screen-presence";

const RELEASE_GRACE_MS = 5_000;
const NOTE_ONLY_HOLD_MS = 8_000;
const FACE_STALE_MS = 900;
const FACE_SEARCH_START_MS = 1_400;
const FACE_SMOOTHING_ALPHA = 0.28;
const BODY_CORRECTION_COOLDOWN_MS = 2_200;
const BODY_POST_MOTION_SETTLE_MS = 1_300;
const BODY_DEAD_ZONE = 0.20;
const BODY_STRONG_ERROR = 0.36;
const BODY_STABLE_FRAMES = 4;
const HEAD_COOLDOWN_MS = 1_500;
const HEAD_STABLE_FRAMES = 4;
const HEAD_UP_ENTER = 0.29;
const HEAD_DOWN_ENTER = 0.71;
const HEAD_UP_RELEASE = 0.38;
const HEAD_DOWN_RELEASE = 0.62;
const HEAD_AMBIENT_HOLD_MS = 900;
const SEARCH_SETTLE_MS = 1_250;
const SEARCH_MOTION_WAIT_MS = 3_000;
const SEARCH_MOTION_POLL_MS = 120;
const SEARCH_REARM_LOST_MS = 4_500;
const SEARCH_SEQUENCE: readonly { direction: "left" | "right"; durationMs: number }[] = [
  { direction: "left", durationMs: 100 },
  { direction: "right", durationMs: 180 },
];
const CAMERA_WARMUP_ONLY_SOURCE = "realtime-pcm-speech-start";

export type SocialAttentionVisualState = {
  active: boolean;
  faceVisible: boolean;
  gazeX: number;
  gazeY: number;
};

export const useSocialAttentionStore = create<SocialAttentionVisualState>(() => ({
  active: false,
  faceVisible: false,
  gazeX: 0,
  gazeY: 0,
}));

type Subscription = { remove(): void };
type FacePoint = { centerX: number; centerY: number };
type BodyDirection = "left" | "right";
type BodyPivotReason = "search" | "recenter";

let running = false;
let attentionActive = false;
let motionArmed = false;
let nativeStarted = false;
let nativeStartPromise: Promise<void> | null = null;
let nativeLifecycleGeneration = 0;
let faceSubscription: Subscription | null = null;
let errorSubscription: Subscription | null = null;
let unsubscribeConversation: (() => void) | null = null;
let unsubscribeUser: (() => void) | null = null;
let unsubscribeMainScreen: (() => void) | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let noteHoldTimer: ReturnType<typeof setTimeout> | null = null;
let lastRawFace: FacePoint | null = null;
let lastFace: FacePoint | null = null;
let smoothedFace: FacePoint | null = null;
let lastFaceAt = 0;
let lastKnownHorizontalDirection: BodyDirection | null = null;
let lastSocialBodyMotionAt = 0;
let bodySettleUntil = 0;
let bodyMotionInFlight = false;
let bodyCandidateDirection: BodyDirection | null = null;
let bodyCandidateFrames = 0;
let lastHeadCommandAt = 0;
let lastHeadPosition: "up" | "center" | "down" = "center";
let headCandidatePosition: "up" | "center" | "down" | null = null;
let headCandidateFrames = 0;
let headCommandInFlight = false;
let searchGeneration = 0;
let searchInFlight = false;
let searchAttempted = false;
let searchAttemptedAt = 0;
let searchRearmUsed = false;
let faceSeenSinceSearch = false;

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer);
}

function setVisual(next: Partial<SocialAttentionVisualState>): void {
  useSocialAttentionStore.setState(next);
}

function normalizedGaze(centerX: number, centerY: number): { x: number; y: number } {
  // The front camera observes the user while the display faces them. Horizontal
  // screen-space is mirrored relative to the robot's steering frame, hence -X.
  const x = Math.max(-1, Math.min(1, -((centerX - 0.5) / 0.32)));
  const y = Math.max(-1, Math.min(1, (centerY - 0.5) / 0.34));
  return { x, y };
}

function interactionStateActive(): boolean {
  const conversation = useConversationStore.getState();
  return conversation.isUserSpeaking || conversation.isProcessing || conversation.isSpeaking;
}

function conversationMotionConfirmed(): boolean {
  // `isProcessing` flips immediately on server-VAD speech_stopped, before the
  // transcript is accepted. Only assistant speech is independently strong
  // enough to arm motion; transcript paths arm it explicitly below.
  return useConversationStore.getState().isSpeaking;
}

function canUseAttention(): boolean {
  const user = useUserStore.getState();
  return running &&
    user.preferences.cameraAttentionEnabled &&
    !user.robotSleeping &&
    isMainScreenFocused();
}

async function ensureNativeStarted(): Promise<void> {
  if (!canUseAttention() || nativeStarted) return;
  if (nativeStartPromise) {
    await nativeStartPromise;
    return;
  }

  const module = getLocalFaceAttentionModule();
  if (!module) {
    recordDiagnosticEvent("character", "social-attention-unavailable", { reason: "native-module-unavailable" });
    return;
  }

  faceSubscription ??= module.addListener("onFaceFrame", handleFaceFrame);
  errorSubscription ??= module.addListener("onFaceAttentionError", (event) => {
    recordDiagnosticEvent("character", "social-attention-camera-error", {
      stage: event.stage,
      message: event.message,
    });
  });

  const generation = nativeLifecycleGeneration;
  const startPromise = (async () => {
    try {
      const status = await module.start();
      if (generation !== nativeLifecycleGeneration || !attentionActive || !canUseAttention()) {
        if (status.running) await module.stop().catch(() => undefined);
        return;
      }
      nativeStarted = status.running;
      recordDiagnosticEvent("character", "social-attention-camera-started", {
        running: status.running,
        permissionGranted: status.permissionGranted,
        lensFacing: status.lensFacing,
      });
    } catch (error) {
      if (generation !== nativeLifecycleGeneration) return;
      nativeStarted = false;
      recordDiagnosticEvent("character", "social-attention-camera-start-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  nativeStartPromise = startPromise;
  try {
    await startPromise;
  } finally {
    if (nativeStartPromise === startPromise) nativeStartPromise = null;
  }
}

function resetSearchBudget(): void {
  searchGeneration += 1;
  searchInFlight = false;
  searchAttempted = false;
  searchAttemptedAt = 0;
  searchRearmUsed = false;
  faceSeenSinceSearch = false;
}

function resetTrackingState(): void {
  resetSearchBudget();
  motionArmed = false;
  lastRawFace = null;
  lastFace = null;
  smoothedFace = null;
  lastFaceAt = 0;
  lastKnownHorizontalDirection = null;
  lastSocialBodyMotionAt = 0;
  bodySettleUntil = 0;
  bodyMotionInFlight = false;
  bodyCandidateDirection = null;
  bodyCandidateFrames = 0;
  headCandidatePosition = null;
  headCandidateFrames = 0;
  setVisual({ active: false, faceVisible: false, gazeX: 0, gazeY: 0 });
}

async function stopNative(reason: string): Promise<void> {
  nativeLifecycleGeneration += 1;
  resetTrackingState();

  if (lastHeadPosition !== "center") {
    lastHeadPosition = "center";
    headCommandInFlight = false;
    const robot = getLooiRobotRuntimeState();
    if (robot.connected && robot.driveControlReady) {
      void setLooiHead("center").catch(() => undefined);
    }
  }

  const hadNativeWork = nativeStarted || nativeStartPromise !== null;
  nativeStarted = false;
  if (!hadNativeWork) return;

  const module = getLocalFaceAttentionModule();
  try {
    await module?.stop();
    recordDiagnosticEvent("character", "social-attention-camera-stopped", { reason });
  } catch (error) {
    recordDiagnosticEvent("character", "social-attention-camera-stop-failed", {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function scheduleRelease(delayMs = RELEASE_GRACE_MS): void {
  clearTimer(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (interactionStateActive()) return;
    attentionActive = false;
    void stopNative("interaction-grace-finished");
  }, delayMs);
}

function armMotion(source: string, resetSearchForInteraction: boolean): void {
  if (resetSearchForInteraction) resetSearchBudget();
  if (motionArmed) return;
  motionArmed = true;
  recordDiagnosticEvent("character", "social-attention-motion-armed", { source });
}

function activate(source: string, allowMotion: boolean, resetSearchForInteraction = false): void {
  if (!canUseAttention()) return;
  const wasActive = attentionActive;
  attentionActive = true;
  if (!wasActive) resetSearchBudget();
  if (allowMotion) armMotion(source, resetSearchForInteraction);
  clearTimer(releaseTimer);
  setVisual({ active: true });
  void ensureNativeStarted();
  if (!wasActive) recordDiagnosticEvent("character", "social-attention-activated", { source });
}

export function noteSocialAttentionInteraction(source: string): void {
  if (!canUseAttention()) return;
  const warmCameraOnly = source === CAMERA_WARMUP_ONLY_SOURCE;
  activate(source, !warmCameraOnly, !warmCameraOnly);
  clearTimer(noteHoldTimer);
  noteHoldTimer = setTimeout(() => {
    noteHoldTimer = null;
    if (!interactionStateActive()) scheduleRelease();
  }, NOTE_ONLY_HOLD_MS);
}

function handleConversationChange(): void {
  if (!running) return;
  if (!canUseAttention()) {
    if (attentionActive || nativeStarted) {
      attentionActive = false;
      void stopNative("disabled-or-not-main");
    }
    return;
  }

  if (interactionStateActive()) {
    // Raw server VAD may come from nearby speech or a TV. It may warm the local
    // camera so visual gaze is ready, but physical correction waits for an
    // accepted transcript or for assistant speech that confirms a real turn.
    activate("conversation-state", conversationMotionConfirmed());
  } else if (attentionActive) {
    scheduleRelease();
  }
}

function handleMainScreenFocus(focused: boolean): void {
  if (!running) return;
  if (!focused) {
    attentionActive = false;
    void stopNative("main-screen-blurred");
    return;
  }
  if (interactionStateActive()) {
    activate("main-screen-focused-during-conversation", conversationMotionConfirmed());
  }
}

function handlePreferenceChange(): void {
  if (!running) return;
  if (!canUseAttention()) {
    attentionActive = false;
    void stopNative("preference-or-sleep");
  } else if (interactionStateActive()) {
    activate("preference-enabled-during-conversation", conversationMotionConfirmed());
  }
}

function clearCorrectionCandidates(): void {
  bodyCandidateDirection = null;
  bodyCandidateFrames = 0;
  headCandidatePosition = null;
  headCandidateFrames = 0;
}

function maybeRearmSearch(now: number): void {
  if (!searchAttempted || searchRearmUsed || !faceSeenSinceSearch || !lastFaceAt) return;
  if (now - lastFaceAt < SEARCH_REARM_LOST_MS) return;
  if (now - searchAttemptedAt < SEARCH_REARM_LOST_MS) return;
  searchAttempted = false;
  searchRearmUsed = true;
  faceSeenSinceSearch = false;
  recordDiagnosticEvent("character", "social-attention-search-rearmed", {
    lostMs: now - lastFaceAt,
  });
}

function handleFaceFrame(event: LocalFaceFrameEvent): void {
  if (!attentionActive || !canUseAttention()) return;
  const now = Date.now();
  const primary = event.primary;

  if (!primary) {
    if (now < bodySettleUntil) {
      setVisual({ faceVisible: false, gazeX: 0, gazeY: 0 });
      return;
    }
    if (now - lastFaceAt > FACE_STALE_MS) {
      lastRawFace = null;
      lastFace = null;
      smoothedFace = null;
      clearCorrectionCandidates();
      setVisual({ faceVisible: false, gazeX: 0, gazeY: 0 });
      maybeRearmSearch(now);
      maybeStartFaceSearch();
    }
    return;
  }

  const observed = { centerX: primary.centerX, centerY: primary.centerY };
  // Face frames continuously reserve only the ambient head channel. This keeps
  // the eyes/head visually coherent without disabling Lively body motion.
  holdAmbientHeadMotionFor(FACE_STALE_MS + 350, "attention-face-tracked");
  lastRawFace = observed;
  lastFaceAt = now;
  if (searchAttempted) faceSeenSinceSearch = true;

  const rawErrorX = observed.centerX - 0.5;
  if (Math.abs(rawErrorX) > BODY_DEAD_ZONE) {
    lastKnownHorizontalDirection = rawErrorX < 0 ? "left" : "right";
  }

  searchGeneration += 1;

  if (now < bodySettleUntil) {
    // The camera itself just moved. Do not blend pre-pivot coordinates into the
    // new camera pose; let the first post-settle frame seed smoothing afresh.
    lastFace = observed;
    smoothedFace = null;
    clearCorrectionCandidates();
    const gaze = normalizedGaze(observed.centerX, observed.centerY);
    setVisual({ active: true, faceVisible: true, gazeX: gaze.x, gazeY: gaze.y });
    return;
  }

  smoothedFace = smoothedFace
    ? {
        centerX: smoothedFace.centerX + (observed.centerX - smoothedFace.centerX) * FACE_SMOOTHING_ALPHA,
        centerY: smoothedFace.centerY + (observed.centerY - smoothedFace.centerY) * FACE_SMOOTHING_ALPHA,
      }
    : observed;
  lastFace = smoothedFace;
  const gaze = normalizedGaze(smoothedFace.centerX, smoothedFace.centerY);
  setVisual({ active: true, faceVisible: true, gazeX: gaze.x, gazeY: gaze.y });
  maybeCorrectTowardFace(observed, smoothedFace);
}

function motionCorrectionAllowed(): boolean {
  if (!attentionActive || !motionArmed || !canUseAttention()) return false;
  if (Date.now() < bodySettleUntil) return false;
  if (bodyMotionInFlight) return false;
  if (useConversationStore.getState().isUserSpeaking) return false;
  if (isDrivingControlSessionActive()) return false;
  if (getAmbientMotionControllerState().actionInFlight) return false;
  const robot = getLooiRobotRuntimeState();
  return robot.connected && robot.driveControlReady && !robot.motionActive;
}

function desiredHeadPosition(centerY: number): "up" | "center" | "down" {
  if (lastHeadPosition === "up") return centerY <= HEAD_UP_RELEASE ? "up" : "center";
  if (lastHeadPosition === "down") return centerY >= HEAD_DOWN_RELEASE ? "down" : "center";
  if (centerY < HEAD_UP_ENTER) return "up";
  if (centerY > HEAD_DOWN_ENTER) return "down";
  return "center";
}

async function performSocialBodyPivot(
  reason: BodyPivotReason,
  direction: BodyDirection,
  durationMs: number,
  stableFrames: number,
): Promise<boolean> {
  if (!motionCorrectionAllowed()) return false;

  const startedAt = Date.now();
  bodyMotionInFlight = true;
  lastSocialBodyMotionAt = startedAt;
  clearCorrectionCandidates();
  holdAmbientMotionFor(durationMs + BODY_POST_MOTION_SETTLE_MS + 350, "attention-body-correction");

  recordDiagnosticEvent("character", "social-attention-pivot", {
    reason,
    direction,
    durationMs,
    rawX: lastRawFace?.centerX ?? null,
    smoothedX: smoothedFace?.centerX ?? null,
    stableFrames,
    faceAgeMs: lastFaceAt ? Math.max(0, startedAt - lastFaceAt) : null,
  });

  try {
    const result = await performLooiSocialAttentionPivot(direction, durationMs);
    return result.completed !== false;
  } catch (error) {
    recordDiagnosticEvent("character", "social-attention-pivot-skipped", {
      reason,
      direction,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    bodyMotionInFlight = false;
    lastSocialBodyMotionAt = Date.now();
    bodySettleUntil = Date.now() + BODY_POST_MOTION_SETTLE_MS;
    smoothedFace = null;
    clearCorrectionCandidates();
  }
}

function maybeCorrectTowardFace(rawFace: FacePoint, filteredFace: FacePoint): void {
  const now = Date.now();
  const correctionAllowed = motionCorrectionAllowed();
  const errorX = filteredFace.centerX - 0.5;
  let bodyCorrectionStarted = false;

  if (Math.abs(errorX) <= BODY_DEAD_ZONE) {
    bodyCandidateDirection = null;
    bodyCandidateFrames = 0;
  } else {
    const direction: BodyDirection = errorX < 0 ? "left" : "right";
    if (bodyCandidateDirection === direction) bodyCandidateFrames += 1;
    else {
      bodyCandidateDirection = direction;
      bodyCandidateFrames = 1;
    }

    if (correctionAllowed &&
        bodyCandidateFrames >= BODY_STABLE_FRAMES &&
        now - lastSocialBodyMotionAt >= BODY_CORRECTION_COOLDOWN_MS) {
      const stableFrames = bodyCandidateFrames;
      const duration = Math.abs(errorX) > BODY_STRONG_ERROR ? 150 : 110;
      bodyCorrectionStarted = true;
      void performSocialBodyPivot("recenter", direction, duration, stableFrames);
    }
  }

  if (bodyCorrectionStarted) return;

  const desired = desiredHeadPosition(filteredFace.centerY);
  if (desired === lastHeadPosition) {
    headCandidatePosition = null;
    headCandidateFrames = 0;
    return;
  }

  if (headCandidatePosition === desired) headCandidateFrames += 1;
  else {
    headCandidatePosition = desired;
    headCandidateFrames = 1;
  }

  if (!correctionAllowed ||
      headCommandInFlight ||
      headCandidateFrames < HEAD_STABLE_FRAMES ||
      now - lastHeadCommandAt < HEAD_COOLDOWN_MS) return;

  const target = desired;
  const stableFrames = headCandidateFrames;
  headCandidatePosition = null;
  headCandidateFrames = 0;
  lastHeadCommandAt = now;
  headCommandInFlight = true;
  holdAmbientMotionFor(HEAD_AMBIENT_HOLD_MS, "attention-head-correction");
  holdAmbientHeadMotionFor(HEAD_COOLDOWN_MS + FACE_STALE_MS, "attention-head-correction");
  recordDiagnosticEvent("character", "social-attention-head-command", {
    target,
    rawY: rawFace.centerY,
    smoothedY: filteredFace.centerY,
    stableFrames,
  });
  void setLooiHead(target)
    .then(() => {
      lastHeadPosition = target;
    })
    .catch((error) => {
      recordDiagnosticEvent("character", "social-attention-head-skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      headCommandInFlight = false;
    });
}

function maybeStartFaceSearch(): void {
  if (!motionArmed || searchInFlight || searchAttempted || !attentionActive || !canUseAttention()) return;
  if (Date.now() < bodySettleUntil) return;
  const robot = getLooiRobotRuntimeState();
  if (!robot.connected || !robot.driveControlReady) return;
  const generation = ++searchGeneration;
  searchAttempted = true;
  searchAttemptedAt = Date.now();
  faceSeenSinceSearch = false;
  searchInFlight = true;
  void runFaceSearch(generation).finally(() => {
    searchInFlight = false;
  });
}

async function waitForSearchMotion(generation: number): Promise<boolean> {
  const deadline = Date.now() + SEARCH_MOTION_WAIT_MS;
  while (searchStillNeeded(generation)) {
    const cooldownReady = Date.now() - lastSocialBodyMotionAt >= BODY_CORRECTION_COOLDOWN_MS;
    if (cooldownReady && motionCorrectionAllowed()) return true;
    if (Date.now() >= deadline) return false;
    await delay(SEARCH_MOTION_POLL_MS);
  }
  return false;
}

function searchSequenceForCurrentContext(): readonly { direction: BodyDirection; durationMs: number }[] {
  if (!lastKnownHorizontalDirection || lastKnownHorizontalDirection === "left") return SEARCH_SEQUENCE;
  return [
    { direction: "right", durationMs: SEARCH_SEQUENCE[0].durationMs },
    { direction: "left", durationMs: SEARCH_SEQUENCE[1].durationMs },
  ];
}

async function runFaceSearch(generation: number): Promise<void> {
  await delay(FACE_SEARCH_START_MS);
  if (!searchStillNeeded(generation)) return;

  for (const step of searchSequenceForCurrentContext()) {
    if (!await waitForSearchMotion(generation)) return;
    const completed = await performSocialBodyPivot("search", step.direction, step.durationMs, 0);
    if (!completed || !searchStillNeeded(generation)) return;
    const remainingSettleMs = Math.max(0, bodySettleUntil - Date.now());
    await delay(Math.max(SEARCH_SETTLE_MS, remainingSettleMs));
  }
}

function searchStillNeeded(generation: number): boolean {
  return generation === searchGeneration &&
    attentionActive &&
    motionArmed &&
    canUseAttention() &&
    (!lastFace || Date.now() - lastFaceAt > FACE_STALE_MS);
}

export function startSocialAttentionController(source = "runtime"): void {
  if (running) return;
  running = true;
  unsubscribeConversation = useConversationStore.subscribe(handleConversationChange);
  unsubscribeUser = useUserStore.subscribe(handlePreferenceChange);
  unsubscribeMainScreen = subscribeMainScreenFocused(handleMainScreenFocus);
  recordDiagnosticEvent("character", "social-attention-controller-started", { source });
  handleConversationChange();
}

export async function stopSocialAttentionController(reason = "runtime"): Promise<void> {
  if (!running && !nativeStarted) return;
  running = false;
  attentionActive = false;
  clearTimer(releaseTimer);
  clearTimer(noteHoldTimer);
  releaseTimer = null;
  noteHoldTimer = null;
  searchGeneration += 1;
  unsubscribeConversation?.();
  unsubscribeConversation = null;
  unsubscribeUser?.();
  unsubscribeUser = null;
  unsubscribeMainScreen?.();
  unsubscribeMainScreen = null;
  faceSubscription?.remove();
  faceSubscription = null;
  errorSubscription?.remove();
  errorSubscription = null;
  await stopNative(reason);
  recordDiagnosticEvent("character", "social-attention-controller-stopped", { reason });
}

export function getSocialAttentionControllerState() {
  return {
    running,
    attentionActive,
    motionArmed,
    nativeStarted,
    faceVisible: useSocialAttentionStore.getState().faceVisible,
    searchInFlight,
    searchAttempted,
    bodyMotionInFlight,
    bodySettleRemainingMs: Math.max(0, bodySettleUntil - Date.now()),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
