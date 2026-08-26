import { perceiverManager } from "./perceiver-manager";
import { voiceRuntime } from "../perceivers/voice-runtime";
import { isRealtimeConversationMode, useUserStore } from "../store/user";
import { useConversationStore } from "../store/conversation";
import { getRuntimeProfile } from "./runtime-profile";
import {
  getLoadedSttModule,
  getLoadedTtsModule,
} from "../voice/lazy-services";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { setIsAudioActiveAsync } from "expo-audio";
import { isMainScreenFocused } from "./main-screen-presence";
import {
  resumeLooiRobotAutoConnection,
  suspendLooiRobotAutoConnection,
} from "../device-tools/looi-robot-autoconnect";
import { removeRetiredExperimentalVoiceAssets } from "../voice/retired-experimental-voice-assets";
import { retireLegacyNetworkCredentials } from "./legacy-network-credentials-retirement";

let bootstrapped = false;
let paused = false;
let desiredForegroundActive = true;
let runtimeLifecycleQueue: Promise<void> = Promise.resolve();
let ownerEnrollmentPromise: Promise<void> | null = null;

const VOICE_PCM_STARTUP_TIMEOUT_MS = 1200;
const VOICE_PCM_RETRY_TIMEOUT_MS = 800;

/**
 * Initialize all perceivers and wire observation events.
 * Called once at app startup.
 */
export async function bootstrapApp(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  // v2.1.105 removes the Local-ASR experiment. Cleanup is best-effort and
  // deliberately preserves shared wake/command Whisper Tiny, KWS and VAD.
  void removeRetiredExperimentalVoiceAssets().catch((error) => {
    recordDiagnosticEvent("runtime", "retired-experimental-voice-assets-cleanup-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Voice is the only active perceiver. Camera and calendar/reminder pipelines
  // stay disabled until rebuilt as explicit local-first features.
  perceiverManager.register(voiceRuntime);

  void retireLegacyNetworkCredentials().catch((error) => {
    recordDiagnosticEvent("app", "legacy-network-credential-retirement-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const bootSleeping = useUserStore.getState().robotSleeping;
  if (bootSleeping) {
    paused = true;
    desiredForegroundActive = false;
    useUserStore.getState().setVoiceState("sleeping");
    recordDiagnosticEvent("app", "sleep-mode-restored-on-boot");
  } else {
    try {
      await setIsAudioActiveAsync(true);
      recordDiagnosticEvent("audio", "subsystem-activated-bootstrap");
    } catch (error) {
      console.warn("[Bootstrap] Failed to activate audio subsystem on boot:", error);
      recordDiagnosticEvent("audio", "subsystem-activate-bootstrap-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await startRuntimePerceivers();

    // Prewarm STT model so first wakeword doesn't pay 1.2s cold-start penalty.
    prewarmOfflineStt();
  }

  console.log("[Bootstrap] App initialized. Active perceivers:", perceiverManager.getRegisteredNames());
  recordDiagnosticEvent("app", "bootstrapped", {
    perceivers: perceiverManager.getRegisteredNames().join(","),
  });

  runOptInOwnerEnrollmentOnBoot();
  runOptInLiveVoiceAcceptanceOnBoot();
}

export async function pauseAppRuntime(reason: "background" | "sleep" = "background"): Promise<void> {
  if (!bootstrapped) return;
  desiredForegroundActive = false;

  return enqueueRuntimeLifecycle(async () => {
    if (desiredForegroundActive || paused) return;
    paused = true;

    recordDiagnosticEvent("app", reason === "sleep" ? "sleep-runtime-pause-start" : "background-entered");
    const sttModule = getLoadedSttModule();
    const ttsModule = getLoadedTtsModule();
    const { kwsAudioFeeder } = await import("../voice/kws-audio-feeder");

    kwsAudioFeeder.setAppCaptureAllowed(false);
    recordDiagnosticEvent("audio", "capture-release-start", {
      feederRunning: kwsAudioFeeder.isRunning,
    });

    await Promise.allSettled([
      // Screen-off/background is a hard suspend: stop motion and release the BLE
      // link so LOOI is free to idle/sleep and no reconnect can occur off-screen.
      suspendLooiRobotAutoConnection(reason),
      perceiverManager.stopAll(),
      kwsAudioFeeder.stop(),
      sttModule?.then(({ sttService }) => sttService.cancel({ resumeWakeword: false })),
      ttsModule?.then(({ ttsService }) => ttsService.stop()),
    ].filter(Boolean));

    recordDiagnosticEvent("audio", "capture-release-finished", {
      feederRunning: kwsAudioFeeder.isRunning,
      feederDesired: kwsAudioFeeder.diagnosticStatus.desiredRunning,
    });

    try {
      await setIsAudioActiveAsync(false);
      recordDiagnosticEvent("audio", "subsystem-deactivated");
    } catch (error) {
      console.warn("[Bootstrap] Failed to deactivate audio subsystem:", error);
      recordDiagnosticEvent("audio", "subsystem-deactivate-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    useUserStore.getState().setVoiceState("sleeping");
    console.log("[Bootstrap] App runtime paused");
    recordDiagnosticEvent("app", "runtime-paused");
  });
}

export async function resumeAppRuntime(): Promise<void> {
  if (!bootstrapped) return;
  if (useUserStore.getState().robotSleeping) {
    desiredForegroundActive = false;
    recordDiagnosticEvent("app", "runtime-resume-blocked-by-sleep");
    return;
  }
  desiredForegroundActive = true;

  return enqueueRuntimeLifecycle(async () => {
    if (!desiredForegroundActive || !paused || useUserStore.getState().robotSleeping) return;

    try {
      await setIsAudioActiveAsync(true);
      recordDiagnosticEvent("audio", "subsystem-activated");
    } catch (error) {
      console.warn("[Bootstrap] Failed to activate audio subsystem:", error);
      recordDiagnosticEvent("audio", "subsystem-activate-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const { kwsAudioFeeder } = await import("../voice/kws-audio-feeder");
    kwsAudioFeeder.setAppCaptureAllowed(true);
    paused = false;

    await startRuntimePerceivers();

    // Do not make voice readiness wait on BLE. Reconnect the saved robot in
    // parallel once the app is definitely foreground-active again.
    void resumeLooiRobotAutoConnection("foreground-runtime-resume").catch((error) => {
      console.warn("[Bootstrap] Failed to resume LOOI BLE auto-connection:", error);
      recordDiagnosticEvent("robot", "ble-foreground-reconnect-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    console.log("[Bootstrap] App runtime resumed");
    recordDiagnosticEvent("app", "runtime-resumed");

    if (isMainScreenFocused()) {
      // A true Android foreground resume is distinct from Main <-> Settings
      // navigation. If the face is still the focused route, returning to the app
      // is an attention signal and should open a fresh conversation immediately.
      void voiceRuntime.resumeMainScreenConversation("foreground-resume").catch((error) => {
        recordDiagnosticEvent("navigation", "main-foreground-auto-listen-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
}

function enqueueRuntimeLifecycle(task: () => Promise<void>): Promise<void> {
  const queued = runtimeLifecycleQueue.then(task, task);
  runtimeLifecycleQueue = queued.catch(() => undefined);
  return queued;
}

/** Retry wakeword startup after setup changed models or microphone access. */
export async function syncVoiceRuntime(): Promise<void> {
  if (!bootstrapped || paused || useUserStore.getState().robotSleeping) return;
  await voiceRuntime.sync();
  const [{ kwsAudioFeeder }, { wakewordService }] = await Promise.all([
    import("../voice/kws-audio-feeder"),
    import("../voice/wakeword"),
  ]);
  const status = kwsAudioFeeder.diagnosticStatus;
  recordDiagnosticEvent("runtime", "voice-sync", {
    feederRunning: status.running,
    feederDesired: status.desiredRunning,
    wakewordFeeding: status.wakewordFeedingEnabled,
    wakewordListening: wakewordService.isListening,
    nativeKwsAvailable: wakewordService.isNativeKwsAvailable,
    wakewordState: wakewordService.state,
  });
}

async function startRuntimePerceivers(): Promise<void> {
  try {
    await perceiverManager.start("voice");
    // A foreground resume must restore the actual wakeword pipeline, not only
    // mark the facade active. sync() is idempotent and repairs a stopped native
    // feeder/wakeword service after lifecycle races.
    await voiceRuntime.sync();

    const profile = getRuntimeProfile();
    const prefs = useUserStore.getState().preferences;
    const [{ kwsAudioFeeder }, { wakewordService }, { realtimeConversationService }] = await Promise.all([
      import("../voice/kws-audio-feeder"),
      import("../voice/wakeword"),
      import("../voice/realtime-conversation"),
    ]);
    const expectedWakeword = profile.allowsWakewordAutostart && prefs.wakeWordEnabled;
    let status = kwsAudioFeeder.diagnosticStatus;
    const conversationStore = useConversationStore.getState();
    const realtimeOwnsVoiceRuntime = () => {
      if (realtimeConversationService.isActive) return true;
      // Fresh-launch/manual Realtime activation can overlap this foreground
      // watchdog. Treat the selected Realtime mode plus an already-owned
      // conversation state as authoritative even if native startup is between
      // async phases, so the watchdog never hard-restarts voice underneath it.
      const conversation = useConversationStore.getState();
      return isRealtimeConversationMode(prefs.conversationMode) &&
        (conversation.isListening || conversation.isProcessing || conversation.isSpeaking);
    };
    const conversationOwnsVoiceRuntime = () => {
      if (realtimeOwnsVoiceRuntime()) return true;
      const conversation = useConversationStore.getState();
      return conversation.isListening || conversation.isProcessing || conversation.isSpeaking;
    };
    if (expectedWakeword && !realtimeOwnsVoiceRuntime() && conversationStore.isListening && !status.running) {
      conversationStore.setListening(false);
      conversationStore.setProcessing(false);
      conversationStore.setSpeaking(false);
      conversationStore.setOverlayVisible(false);
      useUserStore.getState().setVoiceState("sleeping");
      recordDiagnosticEvent("runtime", "foreground-stale-listening-reset");
      await voiceRuntime.sync();
      status = kwsAudioFeeder.diagnosticStatus;
    }

    if (
      expectedWakeword &&
      !conversationOwnsVoiceRuntime() &&
      status.running &&
      wakewordService.isListening &&
      !status.pcmFlowing
    ) {
      const pcmReady = await kwsAudioFeeder.waitForFreshPcm(VOICE_PCM_STARTUP_TIMEOUT_MS);
      status = kwsAudioFeeder.diagnosticStatus;
      recordDiagnosticEvent("runtime", "voice-readiness-watchdog", {
        pcmReady,
        feederRunning: status.running,
        pcmFlowing: status.pcmFlowing,
        pcmAgeMs: status.pcmAgeMs,
        recordingAgeMs: status.recordingAgeMs,
      });
    }

    recordDiagnosticEvent("runtime", "foreground-voice-state", {
      expectedWakeword,
      feederRunning: status.running,
      feederDesired: status.desiredRunning,
      pcmFlowing: status.pcmFlowing,
      pcmAgeMs: status.pcmAgeMs,
      wakewordFeeding: status.wakewordFeedingEnabled,
      wakewordListening: wakewordService.isListening,
      wakewordState: wakewordService.state,
    });

    if (expectedWakeword && conversationOwnsVoiceRuntime()) {
      const activeConversation = useConversationStore.getState();
      recordDiagnosticEvent("runtime", "foreground-voice-repair-deferred", {
        reason: "conversation-owns-runtime",
        listening: activeConversation.isListening,
        processing: activeConversation.isProcessing,
        speaking: activeConversation.isSpeaking,
        feederRunning: status.running,
        pcmFlowing: status.pcmFlowing,
        wakewordListening: wakewordService.isListening,
      });
    }

    if (
      expectedWakeword &&
      !conversationOwnsVoiceRuntime() &&
      (!status.running || !wakewordService.isListening || !status.pcmFlowing)
    ) {
      recordDiagnosticEvent("runtime", "foreground-voice-retry", {
        feederRunning: status.running,
        pcmFlowing: status.pcmFlowing,
        wakewordListening: wakewordService.isListening,
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await voiceRuntime.sync();
      if (kwsAudioFeeder.isRunning) {
        await kwsAudioFeeder.waitForFreshPcm(VOICE_PCM_RETRY_TIMEOUT_MS);
      }
      status = kwsAudioFeeder.diagnosticStatus;
      recordDiagnosticEvent("runtime", "foreground-voice-retry-finished", {
        feederRunning: status.running,
        feederDesired: status.desiredRunning,
        pcmFlowing: status.pcmFlowing,
        pcmAgeMs: status.pcmAgeMs,
        wakewordFeeding: status.wakewordFeedingEnabled,
        wakewordListening: wakewordService.isListening,
        wakewordState: wakewordService.state,
      });
    }

    if (
      expectedWakeword &&
      !conversationOwnsVoiceRuntime() &&
      (!status.running || !wakewordService.isListening || !status.pcmFlowing)
    ) {
      recordDiagnosticEvent("runtime", "foreground-voice-hard-restart", {
        feederRunning: status.running,
        pcmFlowing: status.pcmFlowing,
        wakewordListening: wakewordService.isListening,
      });
      await voiceRuntime.stop();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await voiceRuntime.start();
      await voiceRuntime.sync();
      if (kwsAudioFeeder.isRunning) {
        await kwsAudioFeeder.waitForFreshPcm(VOICE_PCM_STARTUP_TIMEOUT_MS);
      }
      status = kwsAudioFeeder.diagnosticStatus;
      recordDiagnosticEvent("runtime", "foreground-voice-hard-restart-finished", {
        feederRunning: status.running,
        feederDesired: status.desiredRunning,
        pcmFlowing: status.pcmFlowing,
        pcmAgeMs: status.pcmAgeMs,
        wakewordFeeding: status.wakewordFeedingEnabled,
        wakewordListening: wakewordService.isListening,
        wakewordState: wakewordService.state,
      });
      if (!status.running || !status.pcmFlowing || !wakewordService.isListening) {
        recordDiagnosticEvent("runtime", "foreground-voice-readiness-failed", {
          feederRunning: status.running,
          pcmFlowing: status.pcmFlowing,
          pcmAgeMs: status.pcmAgeMs,
          wakewordListening: wakewordService.isListening,
        });
      }
    }
  } catch (error) {
    console.warn("[Bootstrap] Failed to start voice perceiver:", error);
    recordDiagnosticEvent("runtime", "foreground-voice-start-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function prewarmOfflineStt(): void {
  void import("../voice/stt")
    .then(({ sttService }) => sttService.initialize())
    .then(() => {
      console.log("[Bootstrap] Offline Whisper prewarmed");
    })
    .catch((error) => {
      console.warn("[Bootstrap] STT prewarm failed (will retry on first use):", error);
    });
}


function runOptInLiveVoiceAcceptanceOnBoot(): void {
  if (process.env.EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT !== "1") return;

  void runLiveVoiceAcceptanceSequence().catch((error) => {
    console.error("[Diagnostics] Live voice acceptance failed:", error);
  });
}

function runOptInOwnerEnrollmentOnBoot(): void {
  if (process.env.EXPO_PUBLIC_LOOI_ENROLL_OWNER_ON_BOOT !== "1") return;

  ownerEnrollmentPromise = runOwnerEnrollmentSequence().catch((error) => {
    console.error("[Diagnostics] Owner enrollment failed:", error);
  });
}

async function runOwnerEnrollmentSequence(): Promise<void> {
  const delayMs = getOwnerEnrollmentStartDelayMs();
  const durationMs = getOwnerEnrollmentDurationMs();
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const { sttService } = await import("../voice/stt");
  const { speakerIdService } = await import("../voice/speaker-id");

  console.log(
    `[Diagnostics] Owner enrollment: speak after this log; recording ${durationMs}ms for owner voice.`
  );
  useUserStore.getState().setVoiceState("listening");
  await sttService.startRecording();

  try {
    await sleep(durationMs);
    useUserStore.getState().setVoiceState("verifying");
    const audioUri = await sttService.stopRecording();
    await speakerIdService.enrollFromFile(audioUri);
    useUserStore.getState().setVoiceEnrolled(true);
    console.log(`[Diagnostics] Owner enrollment succeeded: audioUri=${audioUri}`);
  } finally {
    await sttService.resumeWakewordFeederIfPaused();
    useUserStore.getState().setVoiceState("sleeping");
  }
}

async function runLiveVoiceAcceptanceSequence(): Promise<void> {
  await ownerEnrollmentPromise;
  const repeat = getLiveVoiceAcceptanceRepeatCount();
  const delayMs = getLiveVoiceAcceptanceStartDelayMs();

  for (let index = 0; index < repeat; index += 1) {
    await waitForVoiceIdle();
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    console.log(
      `[Diagnostics] Live voice acceptance ${index + 1}/${repeat}: ` +
        "speak after this log; VAD should finish the recording automatically."
    );
    await voiceRuntime.trigger();
    await waitForVoiceIdle();
  }
}

function getLiveVoiceAcceptanceRepeatCount(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_REPEAT;
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(parsed, 5));
}

function getLiveVoiceAcceptanceStartDelayMs(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_START_DELAY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 5000;
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(0, Math.min(parsed, 30_000));
}

function getOwnerEnrollmentStartDelayMs(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_OWNER_ENROLLMENT_START_DELAY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 5000;
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(0, Math.min(parsed, 30_000));
}

function getOwnerEnrollmentDurationMs(): number {
  const raw = process.env.EXPO_PUBLIC_LOOI_OWNER_ENROLLMENT_DURATION_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 3000;
  if (!Number.isFinite(parsed)) return 3000;
  return Math.max(1000, Math.min(parsed, 10_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForVoiceIdle(timeoutMs = 45_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const userState = useUserStore.getState();
    if (userState.voiceState === "sleeping") {
      return;
    }
    await sleep(500);
  }
  throw new Error("Live voice acceptance timed out waiting for the voice pipeline to return idle");
}
