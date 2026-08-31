import { BasePerceiver } from "../core/perceiver";
import type { MemoryResult, UserIntent } from "../core/context-service";
import { createObservation } from "../core/observation";
import { classifyCategory } from "../memory/metadata";
import { wakewordService, type WakewordDetection } from "../voice/wakeword";
import { voskDrivingCommandRecognizer } from "../voice/vosk-driving-command";
import { kwsAudioFeeder } from "../voice/kws-audio-feeder";
import { sttService } from "../voice/stt";
import { ttsService, type PreparedTtsAudio } from "../voice/tts";
import type { TtsStyleId } from "../voice/tts-voices";
import { vadService } from "../voice/vad-service";
import { voiceAcceptanceTrace } from "../voice/acceptance-trace";
import { isRealtimeConversationMode, useUserStore } from "../store/user";
import { useConversationStore } from "../store/conversation";
import { llmService, sessionService } from "../voice/retired-classic-services";
import {
  memoryService,
  retrieveConversationMemories,
  mirrorSessionMessage,
  mirrorSessionTouch,
} from "../memory/memory-service";
import { getRuntimeProfile } from "../core/runtime-profile";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { guardVoiceIntent } from "../voice/intent-guard";
import {
  detectLanguageSwitchCommand,
  getLanguageSwitchAcknowledgement,
} from "../language/response-language";
import {
  detectListeningLanguageSwitchCommand,
  getListeningLanguageSwitchAcknowledgement,
} from "../language/listening-language";
import { getVoiceResponseMessage } from "../language/response-messages";
import { containsEmergencyStopWord, hasExplicitRobotAddress, parseExplicitRobotCommand, type ExplicitRobotCommand } from "../voice/explicit-robot-command";
import { getLooiRobotRuntimeState, performLooiDance, performLooiHeadGesture, startLooiMotion, stopLooiMotion, turnLooi } from "../device-tools/looi-robot";
import { enterRobotSleepMode } from "../core/sleep-mode";
import { isMainScreenFocused } from "../core/main-screen-presence";
import { markRobotInteraction } from "../core/robot-inactivity";
import { triggerCharacterReaction } from "../character/character-reaction";
import { realtimeConversationService } from "../voice/realtime-conversation";
import { normalizeConversationTranscriptForAssistant } from "../voice/conversation-address";

const LISTENING_START_TIMEOUT_MS = 5000;
const MAX_LISTENING_DURATION_MS = 27_000;
const FOLLOW_UP_WINDOW_MS = 30_000;
const FOLLOW_UP_RESTART_SETTLE_MS = 60;
const ATTENTION_REACTION_MS = 140;
const PROCESSING_BARGE_IN_ARM_DELAY_MS = 750;
const PROCESSING_BARGE_IN_MIN_MS = 900;
const INTERACTION_AUDIO_RESTART_SETTLE_MS = 120;
const FRESH_LAUNCH_AUTO_LISTEN_DELAY_MS = 180;
const FRESH_LAUNCH_FEEDER_READY_TIMEOUT_MS = 2000;
const FRESH_LAUNCH_PCM_READY_TIMEOUT_MS = 1600;
const FRESH_LAUNCH_AUDIO_RECOVERY_SETTLE_MS = 120;
const FRESH_LAUNCH_HEALTH_POLL_MS = 80;
// Realtime startup preroll seeds the most recent 900 ms of Classic PCM. Keep
// the cold-start feeder healthy for >900 ms after first PCM so AudioStudio's
// first capture transient cannot be copied into the Realtime preroll.
const FRESH_LAUNCH_PCM_STABLE_MS = 1000;
const FRESH_LAUNCH_PCM_MAX_AGE_MS = 250;
const LONG_UTTERANCE_MIN_MS = 1800;
const LONG_UTTERANCE_ENDPOINT_GRACE_MS = 900;
const VERY_LONG_UTTERANCE_MIN_MS = 6000;
const VERY_LONG_UTTERANCE_ENDPOINT_GRACE_MS = 1600;
const SESSION_PERSISTENCE_BARRIER_MS = 350;
const SESSION_PERSISTENCE_REQUEST_TIMEOUT_MS = 5000;
const SPEAKER_SAMPLE_RATE = 16000;
const SPEAKER_SEGMENT_PADDING_SAMPLES = Math.round(SPEAKER_SAMPLE_RATE * 0.25);
const WAKEWORD_TRANSCRIPT_PREFIX_RE =
  /^(?:(?:привіт|привет|hey|hay)\s*[,!]?\s*)?(?:looi|louie|loui|louis|wooi|wui|луи|луй|лу\s*[,.;:\-–—]?\s*и|луї|луі|луе|лує|лоуи|лоуї|руи|уи|уй|макс|max|робот)[,.!?\s]*/i;

const SPEAKING_BARGE_IN_MAX_SAMPLES = Math.round(SPEAKER_SAMPLE_RATE * 12);

function containsWakeAddressToken(text: string): boolean {
  return /(?:^|[^a-zа-яіїєґ])(?:луи|луй|луї|looi|louie|макс|max|робот)(?=$|[^a-zа-яіїєґ])/iu.test(text);
}

type GenerateResponseResult = {
  response: string;
  evidenceUri?: string;
  audioHandled: boolean;
};

type SampleRange = {
  start: number;
  end: number;
};

type TtsStreamItem = {
  text: string;
  audioUrl: string;
  model?: string;
};

function applyTtsPreferencesToStreamItem(
  item: TtsStreamItem,
  preferences: { ttsVoiceId: string; ttsStyleId: TtsStyleId; ttsSpeed: number }
): TtsStreamItem {
  try {
    const url = new URL(item.audioUrl);
    url.searchParams.set("voiceId", preferences.ttsVoiceId);
    url.searchParams.set("styleId", preferences.ttsStyleId);
    url.searchParams.set("speed", String(preferences.ttsSpeed));
    return { ...item, audioUrl: url.toString() };
  } catch {
    return item;
  }
}

class AsyncTtsQueue implements AsyncIterable<TtsStreamItem> {
  private queue: TtsStreamItem[] = [];
  private resolvers: Array<(value: IteratorResult<TtsStreamItem>) => void> = [];
  private closed = false;

  push(item: TtsStreamItem): void {
    if (!item.text.trim() || !item.audioUrl.trim() || this.closed) return;

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<TtsStreamItem>> {
    const item = this.queue.shift();
    if (item) {
      return { value: item, done: false };
    }

    if (this.closed) {
      return { value: undefined, done: true };
    }

    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<TtsStreamItem> {
    return this;
  }
}

/**
 * VoicePerceiver — orchestrates the voice pipeline:
 * Wakeword → STT → Observation
 *
 * Also handles the response side: LLM → TTS
 */
export class VoicePerceiver extends BasePerceiver {
  name = "voice";
  private unsubWakeword: (() => void) | null = null;
  private unsubPreferences: (() => void) | null = null;
  private startListeningPromise: Promise<void> | null = null;
  private isFinishingListening = false;
  private cancelListeningAfterStart = false;
  private allowsWakewordAutostart = true;
  private unsubStreamingSamples: (() => void) | null = null;
  private vadHadSpeech = false;
  private vadSpeechStartedAtMs: number | null = null;
  private vadEndpointTimer: ReturnType<typeof setTimeout> | null = null;
  private vadAccepting = false;
  private vadQueuedSamples: number[] | null = null;
  private vadStartupSamples: number[] = [];
  private speechSamplesBuffer: number[] = [];
  private commandSamplesBuffer: number[] = [];
  private speechSampleRanges: SampleRange[] = [];
  private listeningTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingWakeSegmentSamples: number[] = [];
  private wakeSegmentSamplesForSpeaker: number[] = [];
  private pendingCommandPrerollSamples: number[] = [];
  private pendingHasCommandSuffix = false;
  private pendingWakeWasManual = false;
  private inlineWakeCommand = false;
  private followUpTurn = false;
  private turnAbortController: AbortController | null = null;
  private pendingManualRestart = false;
  private interactionInterruptPromise: Promise<void> | null = null;
  private turnSequence = 0;
  private activeTurnId = 0;
  private activeTurnSpeechEndedAt = 0;
  private activeTurnFirstAudioLogged = false;
  private activeSpeakingChunkHasWakeAddress = false;
  private turnCompletionWaiters: Array<() => void> = [];
  private processingBargeInUnsub: (() => void) | null = null;
  private processingBargeInSamples: number[] = [];
  private processingBargeInStartupSamples: number[] = [];
  private processingBargeInQueuedSamples: number[] | null = null;
  private processingBargeInVadAccepting = false;
  private processingBargeInVadReady = false;
  private processingBargeInGeneration = 0;
  private pendingBargeInSamples: number[] | null = null;
  private listeningGeneration = 0;
  private followUpPrewarmPromise: Promise<void> | null = null;
  private followUpCapturePrewarmed = false;
  private sessionPersistenceChain: Promise<void> = Promise.resolve();
  private freshLaunchAutoListenConsumed = false;
  private freshLaunchAutoListenTimer: ReturnType<typeof setTimeout> | null = null;

  async start(): Promise<void> {
    if (this.isActive) {
      return;
    }

    this.isActive = true;
    this.allowsWakewordAutostart = getRuntimeProfile().allowsWakewordAutostart;

    this.unsubWakeword = wakewordService.onWakeword((detection) => {
      this.handleWakeword(detection);
    });

    this.unsubPreferences = useUserStore.subscribe((state, previousState) => {
      const wakeChanged = state.preferences.wakeWordEnabled !== previousState.preferences.wakeWordEnabled;
      const modeChanged = state.preferences.conversationMode !== previousState.preferences.conversationMode;
      if (modeChanged) {
        void this.syncConversationMode();
      }
      if (wakeChanged) {
        void this.syncWakewordRuntime();
      }
    });

    if (this.shouldRunWakewordFeeder()) {
      await this.startWakewordFeeder();
    }

    // Opening the app is itself a strong attention signal. On the first active
    // launch of this process, enter ordinary conversation listening without
    // forcing wake-word recognition. Classic keeps the historical 180 ms path.
    // Realtime adds a cold-start-only PCM stability barrier: physical 2.1.83
    // tests showed that starting WebRTC while the Classic AudioStudio recorder
    // was still producing its first transient correlated with delayed/poor VAD.
    if (!this.freshLaunchAutoListenConsumed && !useUserStore.getState().robotSleeping) {
      this.freshLaunchAutoListenConsumed = true;
      this.freshLaunchAutoListenTimer = setTimeout(() => {
        this.freshLaunchAutoListenTimer = null;
        void this.runFreshLaunchAutoListen();
      }, FRESH_LAUNCH_AUTO_LISTEN_DELAY_MS);
    }
  }

  async stop(): Promise<void> {
    this.isActive = false;
    if (this.freshLaunchAutoListenTimer) {
      clearTimeout(this.freshLaunchAutoListenTimer);
      this.freshLaunchAutoListenTimer = null;
    }
    this.followUpTurn = false;
    this.pendingManualRestart = false;
    this.turnAbortController?.abort();
    this.turnAbortController = null;
    this.activeTurnId = 0;
    this.isFinishingListening = false;
    this.cancelListeningAfterStart = false;
    this.pendingBargeInSamples = null;
    this.activeSpeakingChunkHasWakeAddress = false;
    this.followUpCapturePrewarmed = false;
    this.clearVadEndpointTimer();
    recordDiagnosticEvent("runtime", "voice-stop-turn-ownership-reset");
    await realtimeConversationService.stop("voice-runtime-stop").catch(() => undefined);
    await this.stopProcessingBargeIn("runtime-stop");
    await wakewordService.setSpeakingBargeInMode(false);
    wakewordService.setNativeOnlyMode(false);
    await kwsAudioFeeder.stop();
    await wakewordService.stop();
    if (this.unsubWakeword) {
      this.unsubWakeword();
      this.unsubWakeword = null;
    }
    if (this.unsubPreferences) {
      this.unsubPreferences();
      this.unsubPreferences = null;
    }
    await this.stopListeningStreaming({ resetAsr: true });
    const conversationStore = useConversationStore.getState();
    conversationStore.setListening(false);
    conversationStore.setProcessing(false);
    conversationStore.setSpeaking(false);
    conversationStore.setOverlayVisible(false);
    useUserStore.getState().setVoiceState("sleeping");
    recordDiagnosticEvent("runtime", "voice-stop-state-reset");
  }

  /**
   * Manually attract LOOI's attention and start listening.
   */
  async trigger(): Promise<void> {
    // Physical safety fallback: while wheels are moving, a face tap is never
    // interpreted as "start a conversation". It is an immediate local STOP.
    // This gives the user a deterministic escape hatch if voice recognition
    // misses an emergency command.
    if (getLooiRobotRuntimeState().motionActive) {
      const startedAt = Date.now();
      recordDiagnosticEvent("robot", "driving-tap-emergency-stop", {
        direction: getLooiRobotRuntimeState().activeDirection ?? "unknown",
      });
      await stopLooiMotion("driving-tap-stop").catch((error) => {
        recordDiagnosticEvent("robot", "driving-tap-emergency-stop-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      wakewordService.enterDrivingControlSession("tap-stop");
      recordDiagnosticEvent("robot", "driving-tap-emergency-stop-finished", {
        totalStopLatencyMs: Date.now() - startedAt,
      });
      return;
    }

    if (wakewordService.isDrivingControlSessionActive) {
      wakewordService.exitDrivingControlSession("tap-to-conversation");
      recordDiagnosticEvent("runtime", "driving-control-session-tap-exit");
    }

    if (realtimeConversationService.isActive) {
      await realtimeConversationService.interruptAndListen("tap");
      return;
    }

    const triggerUserState = useUserStore.getState();
    const triggerConversationState = useConversationStore.getState();
    if (isRealtimeConversationMode(triggerUserState.preferences.conversationMode)) {
      if (triggerConversationState.realtimeReadiness === "preparing-microphone") {
        recordDiagnosticEvent("runtime", "realtime-microphone-preparation-tap-ignored");
        return;
      }
      if (triggerConversationState.realtimeReadiness === "microphone-error") {
        recordDiagnosticEvent("runtime", "realtime-microphone-preparation-manual-retry");
        await this.runFreshLaunchAutoListen("manual-retry");
        return;
      }
    }

    const voiceState = triggerUserState.voiceState;
    if (voiceState === "listening") {
      if (this.startListeningPromise) {
        recordDiagnosticEvent("runtime", "attention-tap-ignored", {
          reason: "listening-starting",
        });
        return;
      }
      await this.restartListeningFromTap();
      return;
    }
    if (
      voiceState === "processing" ||
      voiceState === "speaking" ||
      voiceState === "verifying" ||
      this.isFinishingListening
    ) {
      await this.interruptAndListen("tap");
      return;
    }

    await this.startAttentionThenListen();
  }

  /**
   * Prepare the voice runtime for an idle Character Layer reaction. Passive
   * speech-free listening (fresh-launch/follow-up) may be cancelled so a
   * double/triple face tap is not swallowed until navigation resets runtime.
   * Active speech/processing/speaking stays owned by Classic.
   */
  async prepareIdleCharacterReaction(): Promise<{ ok: boolean; reason: string }> {
    if (realtimeConversationService.isActive) return { ok: false, reason: "realtime-active" };
    if (getLooiRobotRuntimeState().motionActive) return { ok: false, reason: "motion-active" };
    if (wakewordService.isDrivingControlSessionActive) return { ok: false, reason: "driving-session" };

    const conversationStore = useConversationStore.getState();
    const voiceState = useUserStore.getState().voiceState;
    if (
      conversationStore.isProcessing ||
      conversationStore.isSpeaking ||
      voiceState === "processing" ||
      voiceState === "speaking" ||
      voiceState === "verifying" ||
      this.isFinishingListening ||
      this.activeTurnId !== 0
    ) {
      return { ok: false, reason: "classic-turn-active" };
    }

    if (this.vadHadSpeech || this.vadSpeechStartedAtMs !== null) {
      return { ok: false, reason: "speech-in-progress" };
    }

    const passiveListening =
      conversationStore.isListening ||
      voiceState === "listening" ||
      voiceState === "attention" ||
      Boolean(this.startListeningPromise);

    if (passiveListening) {
      // If capture startup is still in flight, fence its post-start continuation
      // before detaching the listener. This is a cancellation of an empty
      // listening window, not a Classic turn interruption.
      this.cancelListeningAfterStart = true;
      if (this.startListeningPromise) {
        await this.startListeningPromise.catch(() => undefined);
      }
      await this.stopListeningStreaming({ resetAsr: true });
      this.cancelListeningAfterStart = false;
      this.followUpTurn = false;
      const currentConversationStore = useConversationStore.getState();
      currentConversationStore.setListening(false);
      currentConversationStore.setProcessing(false);
      currentConversationStore.setSpeaking(false);
      currentConversationStore.setOverlayVisible(false);
      useUserStore.getState().setVoiceState("sleeping");
      await this.restartWakewordFeederIfNeeded();
      recordDiagnosticEvent("character", "passive-listening-released", {
        previousVoiceState: voiceState,
      });
    }

    return { ok: true, reason: passiveListening ? "passive-listening-released" : "idle" };
  }

  /**
   * Interrupt the current answer and switch back to listening.
   */
  async interruptAndListen(source: "tap" | "wakeword" = "tap"): Promise<void> {
    const conversationStore = useConversationStore.getState();
    if (conversationStore.isListening || useUserStore.getState().voiceState === "listening") {
      return;
    }

    if (this.interactionInterruptPromise) {
      recordDiagnosticEvent("runtime", "interrupt-coalesced", { source });
      await this.interactionInterruptPromise;
      return;
    }

    const interruptPromise = this.performInteractionInterrupt(source);
    this.interactionInterruptPromise = interruptPromise;
    try {
      await interruptPromise;
    } finally {
      if (this.interactionInterruptPromise === interruptPromise) {
        this.interactionInterruptPromise = null;
      }
    }
  }

  private async restartListeningFromTap(): Promise<void> {
    if (this.interactionInterruptPromise) {
      recordDiagnosticEvent("runtime", "interrupt-coalesced", {
        source: "tap",
        mode: "listening-restart",
      });
      await this.interactionInterruptPromise;
      return;
    }

    const restartPromise = this.performListeningRestart();
    this.interactionInterruptPromise = restartPromise;
    try {
      await restartPromise;
    } finally {
      if (this.interactionInterruptPromise === restartPromise) {
        this.interactionInterruptPromise = null;
      }
    }
  }

  private async performListeningRestart(): Promise<void> {
    this.pendingManualRestart = true;
    recordDiagnosticEvent("runtime", "listening-restart-requested", {
      feederRunning: kwsAudioFeeder.isRunning,
      streamingActive: Boolean(this.unsubStreamingSamples),
      listeningGeneration: this.listeningGeneration,
    });

    await this.resetAudioCaptureForInteraction("tap");
    if (!this.isActive) {
      this.pendingManualRestart = false;
      return;
    }

    const conversationStore = useConversationStore.getState();
    conversationStore.setListening(false);
    conversationStore.setProcessing(false);
    conversationStore.setSpeaking(false);
    useUserStore.getState().setVoiceState("sleeping");
    this.pendingManualRestart = false;
    recordDiagnosticEvent("runtime", "listening-restart-ready");
    await this.startAttentionThenListen();
  }

  private async performInteractionInterrupt(source: "tap" | "wakeword"): Promise<void> {
    const conversationStore = useConversationStore.getState();
    this.pendingManualRestart = true;
    this.pendingBargeInSamples = null;
    recordDiagnosticEvent("runtime", "interaction-interrupt", {
      source,
      voiceState: useUserStore.getState().voiceState,
      processing: conversationStore.isProcessing,
      speaking: conversationStore.isSpeaking,
      turnId: this.activeTurnId || null,
    });

    this.turnAbortController?.abort();
    await ttsService.stop().catch(() => undefined);
    await this.stopProcessingBargeIn("manual-interrupt");

    if (this.isFinishingListening) {
      recordDiagnosticEvent("runtime", "interrupt-waiting-cleanup", {
        source,
        turnId: this.activeTurnId || null,
      });
      await this.waitForCurrentTurnCompletion();
    }

    if (!this.isActive) {
      this.pendingManualRestart = false;
      return;
    }

    await this.resetAudioCaptureForInteraction(source);

    if (!this.isActive) {
      this.pendingManualRestart = false;
      return;
    }

    const currentConversationStore = useConversationStore.getState();
    currentConversationStore.setListening(false);
    currentConversationStore.setProcessing(false);
    currentConversationStore.setSpeaking(false);
    useUserStore.getState().setVoiceState("sleeping");
    this.pendingManualRestart = false;
    recordDiagnosticEvent("runtime", "interrupt-restart", { source, mode: "fresh-capture" });
    await this.startAttentionThenListen();
  }

  private async resetAudioCaptureForInteraction(source: "tap" | "wakeword"): Promise<void> {
    const startedAt = Date.now();
    recordDiagnosticEvent("runtime", "audio-restart-start", {
      source,
      feederRunning: kwsAudioFeeder.isRunning,
      listeningGeneration: this.listeningGeneration,
    });

    this.cancelListeningAfterStart = true;
    await wakewordService.setSpeakingBargeInMode(false);
    wakewordService.setNativeOnlyMode(false);
    await this.stopListeningStreaming({ resetAsr: true, keepFeederRunning: false });
    kwsAudioFeeder.setWakewordFeedingEnabled(false);
    await kwsAudioFeeder.stop().catch((error) => {
      console.warn("[VoicePerceiver] Failed to stop feeder for interaction restart:", error);
    });
    await wakewordService.stop().catch(() => undefined);

    this.cancelListeningAfterStart = false;
    this.pendingWakeSegmentSamples = [];
    this.wakeSegmentSamplesForSpeaker = [];
    this.pendingCommandPrerollSamples = [];
    this.pendingHasCommandSuffix = false;
    this.inlineWakeCommand = false;
    this.followUpTurn = false;

    await new Promise((resolve) => setTimeout(resolve, INTERACTION_AUDIO_RESTART_SETTLE_MS));
    recordDiagnosticEvent("runtime", "audio-restart-ready", {
      source,
      durationMs: Date.now() - startedAt,
      feederRunning: kwsAudioFeeder.isRunning,
      listeningGeneration: this.listeningGeneration,
    });
  }

  private async queueWakewordBargeIn(detection: WakewordDetection): Promise<boolean> {
    if (this.pendingBargeInSamples || !this.activeTurnId) return Boolean(this.pendingBargeInSamples);
    const sampleRate = detection.sampleRate ?? SPEAKER_SAMPLE_RATE;
    if (sampleRate !== SPEAKER_SAMPLE_RATE) return false;

    const captured = [
      ...(detection.wakeSegmentSamples ?? []),
      ...(detection.commandPrerollSamples ?? []),
    ];
    if (captured.length < Math.round(SPEAKER_SAMPLE_RATE * 0.3)) return false;

    // Preserve the entire addressed interruption, including the command after
    // "Луи". Bound only pathological buffers; never tail-trim ordinary turns.
    this.pendingBargeInSamples = captured.length > SPEAKING_BARGE_IN_MAX_SAMPLES
      ? captured.slice(-SPEAKING_BARGE_IN_MAX_SAMPLES)
      : captured;
    recordDiagnosticEvent("runtime", "wakeword-barge-in-captured", {
      turnId: this.activeTurnId,
      durationMs: Math.round((this.pendingBargeInSamples.length / SPEAKER_SAMPLE_RATE) * 1000),
      source: detection.source,
    });
    this.turnAbortController?.abort();
    await ttsService.stop().catch(() => undefined);
    return true;
  }

  private async startAttentionThenListen(): Promise<void> {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();
    if (
      conversationStore.isListening ||
      conversationStore.isProcessing ||
      this.startListeningPromise ||
      this.isFinishingListening
    ) {
      return;
    }

    userStore.setVoiceState("attention");
    recordDiagnosticEvent("runtime", "attention-tap");
    await new Promise((resolve) => setTimeout(resolve, ATTENTION_REACTION_MS));
    await this.handleWakeword();
  }

  private isFreshLaunchAutoListenStillEligible(): boolean {
    if (!this.isActive || useUserStore.getState().robotSleeping || !isMainScreenFocused()) return false;
    const conversation = useConversationStore.getState();
    const voiceState = useUserStore.getState().voiceState;
    return !(
      conversation.isListening ||
      conversation.isProcessing ||
      conversation.isSpeaking ||
      this.isFinishingListening ||
      this.startListeningPromise ||
      voiceState !== "sleeping"
    );
  }

  async resumeRealtimeConversationFromMain(
    source: "navigation-return" | "foreground-resume"
  ): Promise<void> {
    if (!isRealtimeConversationMode(useUserStore.getState().preferences.conversationMode)) {
      await this.trigger();
      return;
    }

    recordDiagnosticEvent("runtime", "realtime-entry-preparation-requested", {
      source,
      ...this.freshLaunchAudioStatusFields(),
    });
    await this.runFreshLaunchAutoListen(source);
  }

  private async runFreshLaunchAutoListen(
    triggerSource: "fresh-launch" | "manual-retry" | "navigation-return" | "foreground-resume" = "fresh-launch"
  ): Promise<void> {
    if (!this.isFreshLaunchAutoListenStillEligible()) return;

    const preferences = useUserStore.getState().preferences;
    let audioStabilized = false;
    let firstPcmWaitMs: number | null = null;
    let preparationAttempts = 0;

    // Do not alter Classic startup latency/ownership. The barrier exists only
    // for the Realtime cold-start handoff from AudioStudio -> WebRTC. Physical
    // 2.1.84 testing proved that treating `feederRunning=false` as a reason to
    // skip the barrier simply recreated the original race, so Realtime now
    // waits for (and, if necessary, explicitly starts) the Classic recorder.
    if (isRealtimeConversationMode(preferences.conversationMode)) {
      const conversationStore = useConversationStore.getState();
      conversationStore.setCurrentTranscript("");
      conversationStore.setStreamingText("");
      conversationStore.setOverlayVisible(true);
      conversationStore.setRealtimeReadiness("preparing-microphone");

      const initialStatus = kwsAudioFeeder.diagnosticStatus;
      recordDiagnosticEvent("runtime", "realtime-entry-audio-stability-wait-start", {
        source: triggerSource,
        feederRunning: initialStatus.running,
        pcmFlowing: initialStatus.pcmFlowing,
        pcmAgeMs: initialStatus.pcmAgeMs,
        recordingAgeMs: initialStatus.recordingAgeMs,
        stableWindowMs: FRESH_LAUNCH_PCM_STABLE_MS,
      });
      recordDiagnosticEvent("runtime", "fresh-launch-audio-stability-wait-start", {
        feederRunning: initialStatus.running,
        pcmFlowing: initialStatus.pcmFlowing,
        pcmAgeMs: initialStatus.pcmAgeMs,
        recordingAgeMs: initialStatus.recordingAgeMs,
        feederReadyTimeoutMs: FRESH_LAUNCH_FEEDER_READY_TIMEOUT_MS,
        pcmReadyTimeoutMs: FRESH_LAUNCH_PCM_READY_TIMEOUT_MS,
        stableWindowMs: FRESH_LAUNCH_PCM_STABLE_MS,
        maxAttempts: 2,
        triggerSource,
      });

      for (let attempt = 1; attempt <= 2 && !audioStabilized; attempt += 1) {
        preparationAttempts = attempt;
        const attemptStartedAt = Date.now();
        const attemptResult = await this.prepareFreshLaunchRealtimeMicrophone(attempt);
        firstPcmWaitMs = attemptResult.firstPcmWaitMs;
        audioStabilized = attemptResult.ok;

        if (audioStabilized) break;
        if (!this.isFreshLaunchAutoListenStillEligible()) {
          this.cancelFreshLaunchRealtimePreparation("eligibility-lost-after-attempt");
          return;
        }

        recordDiagnosticEvent("runtime", "fresh-launch-audio-preparation-attempt-failed", {
          attempt,
          stage: attemptResult.stage,
          durationMs: Date.now() - attemptStartedAt,
          ...this.freshLaunchAudioStatusFields(),
        });

        if (attempt === 1) {
          recordDiagnosticEvent("runtime", "fresh-launch-audio-recovery-start", {
            attempt,
            ...this.freshLaunchAudioStatusFields(),
          });
          await kwsAudioFeeder.stop().catch((error) => {
            recordDiagnosticEvent("runtime", "fresh-launch-audio-recovery-stop-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          if (!this.isFreshLaunchAutoListenStillEligible()) {
            this.cancelFreshLaunchRealtimePreparation("eligibility-lost-during-recovery");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, FRESH_LAUNCH_AUDIO_RECOVERY_SETTLE_MS));
          recordDiagnosticEvent("runtime", "fresh-launch-audio-recovery-ready", {
            settleMs: FRESH_LAUNCH_AUDIO_RECOVERY_SETTLE_MS,
            ...this.freshLaunchAudioStatusFields(),
          });
        }
      }

      if (!audioStabilized) {
        if (!this.isFreshLaunchAutoListenStillEligible()) {
          this.cancelFreshLaunchRealtimePreparation("eligibility-lost-before-failure-state");
          return;
        }
        useConversationStore.getState().setRealtimeReadiness("microphone-error");
        recordDiagnosticEvent("runtime", "fresh-launch-audio-preparation-failed", {
          attempts: preparationAttempts,
          triggerSource,
          ...this.freshLaunchAudioStatusFields(),
        });
        return;
      }
    }

    if (!this.isFreshLaunchAutoListenStillEligible()) {
      if (isRealtimeConversationMode(preferences.conversationMode)) {
        this.cancelFreshLaunchRealtimePreparation("eligibility-lost-before-auto-listen");
      }
      return;
    }
    const finalStatus = kwsAudioFeeder.diagnosticStatus;
    if (isRealtimeConversationMode(preferences.conversationMode)) {
      useConversationStore.getState().setRealtimeReadiness("connecting");
    }
    recordDiagnosticEvent("runtime", "realtime-entry-auto-listen", {
      source: triggerSource,
      audioStabilized: isRealtimeConversationMode(preferences.conversationMode) ? audioStabilized : null,
      preparationAttempts: isRealtimeConversationMode(preferences.conversationMode) ? preparationAttempts : null,
      feederRunning: finalStatus.running,
      pcmFlowing: finalStatus.pcmFlowing,
      pcmAgeMs: finalStatus.pcmAgeMs,
      recordingAgeMs: finalStatus.recordingAgeMs,
    });
    recordDiagnosticEvent("runtime", "fresh-launch-auto-listen", {
      listeningLanguage: useUserStore.getState().preferences.listeningLanguage,
      conversationMode: preferences.conversationMode,
      audioStabilized: isRealtimeConversationMode(preferences.conversationMode) ? audioStabilized : null,
      preparationAttempts: isRealtimeConversationMode(preferences.conversationMode) ? preparationAttempts : null,
      triggerSource,
      firstPcmWaitMs,
      feederRunning: finalStatus.running,
      pcmFlowing: finalStatus.pcmFlowing,
      pcmAgeMs: finalStatus.pcmAgeMs,
      recordingAgeMs: finalStatus.recordingAgeMs,
    });
    await this.handleWakeword();
  }

  private cancelFreshLaunchRealtimePreparation(reason: string): void {
    if (realtimeConversationService.isActive) return;
    const store = useConversationStore.getState();
    store.setRealtimeReadiness("idle");
    if (!store.isListening && !store.isProcessing && !store.isSpeaking) {
      store.setOverlayVisible(false);
    }
    recordDiagnosticEvent("runtime", "fresh-launch-audio-preparation-cancelled", {
      reason,
      mainScreenFocused: isMainScreenFocused(),
      ...this.freshLaunchAudioStatusFields(),
    });
  }

  private freshLaunchAudioStatusFields() {
    const status = kwsAudioFeeder.diagnosticStatus;
    return {
      feederRunning: status.running,
      feederDesiredRunning: status.desiredRunning,
      appCaptureAllowed: status.appCaptureAllowed,
      pcmFlowing: status.pcmFlowing,
      pcmAgeMs: status.pcmAgeMs,
      recordingAgeMs: status.recordingAgeMs,
    };
  }

  private async prepareFreshLaunchRealtimeMicrophone(
    attempt: number
  ): Promise<{ ok: boolean; stage: "feeder" | "first-pcm" | "stable-pcm" | "ready"; firstPcmWaitMs: number | null }> {
    if (!this.isFreshLaunchAutoListenStillEligible()) {
      return { ok: false, stage: "feeder", firstPcmWaitMs: null };
    }

    kwsAudioFeeder.setAppCaptureAllowed(true);
    recordDiagnosticEvent("runtime", "fresh-launch-feeder-wait-start", {
      attempt,
      timeoutMs: FRESH_LAUNCH_FEEDER_READY_TIMEOUT_MS,
      ...this.freshLaunchAudioStatusFields(),
    });

    // Start is idempotent and coalesces with an already in-flight feeder start.
    // Do not await it directly: readiness is bounded by the explicit polling
    // deadline below, and any rejection is captured diagnostically.
    void kwsAudioFeeder.start().catch((error) => {
      recordDiagnosticEvent("runtime", "fresh-launch-feeder-start-failed", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const feederWaitStartedAt = Date.now();
    while (Date.now() - feederWaitStartedAt < FRESH_LAUNCH_FEEDER_READY_TIMEOUT_MS) {
      if (!this.isFreshLaunchAutoListenStillEligible()) {
        return { ok: false, stage: "feeder", firstPcmWaitMs: null };
      }
      if (kwsAudioFeeder.diagnosticStatus.running) break;
      await new Promise((resolve) => setTimeout(resolve, FRESH_LAUNCH_HEALTH_POLL_MS));
    }

    const feederStatus = kwsAudioFeeder.diagnosticStatus;
    if (!feederStatus.running) {
      recordDiagnosticEvent("runtime", "fresh-launch-feeder-timeout", {
        attempt,
        waitMs: Date.now() - feederWaitStartedAt,
        ...this.freshLaunchAudioStatusFields(),
      });
      return { ok: false, stage: "feeder", firstPcmWaitMs: null };
    }

    recordDiagnosticEvent("runtime", "fresh-launch-feeder-ready", {
      attempt,
      waitMs: Date.now() - feederWaitStartedAt,
      ...this.freshLaunchAudioStatusFields(),
    });

    const firstPcmWaitStartedAt = Date.now();
    const firstPcmReady = await kwsAudioFeeder.waitForFreshPcm(FRESH_LAUNCH_PCM_READY_TIMEOUT_MS);
    const firstPcmWaitMs = Date.now() - firstPcmWaitStartedAt;
    if (!this.isFreshLaunchAutoListenStillEligible()) {
      return { ok: false, stage: "first-pcm", firstPcmWaitMs };
    }

    recordDiagnosticEvent(
      "runtime",
      firstPcmReady ? "fresh-launch-first-pcm-ready" : "fresh-launch-first-pcm-timeout",
      {
        attempt,
        waitMs: firstPcmWaitMs,
        ...this.freshLaunchAudioStatusFields(),
      }
    );
    if (!firstPcmReady) {
      return { ok: false, stage: "first-pcm", firstPcmWaitMs };
    }

    const stableStartedAt = Date.now();
    while (Date.now() - stableStartedAt < FRESH_LAUNCH_PCM_STABLE_MS) {
      if (!this.isFreshLaunchAutoListenStillEligible()) {
        return { ok: false, stage: "stable-pcm", firstPcmWaitMs };
      }
      const status = kwsAudioFeeder.diagnosticStatus;
      const healthy = Boolean(
        status.running &&
        status.pcmFlowing &&
        status.pcmAgeMs !== null &&
        status.pcmAgeMs <= FRESH_LAUNCH_PCM_MAX_AGE_MS
      );
      if (!healthy) {
        recordDiagnosticEvent("runtime", "fresh-launch-audio-stability-degraded", {
          attempt,
          elapsedStableMs: Date.now() - stableStartedAt,
          stableWindowMs: FRESH_LAUNCH_PCM_STABLE_MS,
          maxPcmAgeMs: FRESH_LAUNCH_PCM_MAX_AGE_MS,
          ...this.freshLaunchAudioStatusFields(),
        });
        return { ok: false, stage: "stable-pcm", firstPcmWaitMs };
      }
      await new Promise((resolve) => setTimeout(resolve, FRESH_LAUNCH_HEALTH_POLL_MS));
    }

    recordDiagnosticEvent("runtime", "fresh-launch-audio-stable", {
      attempt,
      stableWindowMs: FRESH_LAUNCH_PCM_STABLE_MS,
      maxPcmAgeMs: FRESH_LAUNCH_PCM_MAX_AGE_MS,
      ...this.freshLaunchAudioStatusFields(),
    });
    return { ok: true, stage: "ready", firstPcmWaitMs };
  }

  /**
   * Handle wakeword detection.
   */
  private async handleWakeword(detection?: WakewordDetection): Promise<void> {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    if (
      isRealtimeConversationMode(userStore.preferences.conversationMode) &&
      conversationStore.realtimeReadiness === "preparing-microphone"
    ) {
      recordDiagnosticEvent("runtime", "realtime-microphone-preparation-wake-ignored", {
        source: detection?.source ?? "manual",
        phraseId: detection?.phraseId ?? "unknown",
      });
      return;
    }

    if (
      detection &&
      (conversationStore.isProcessing || conversationStore.isSpeaking) &&
      (userStore.voiceState === "processing" || userStore.voiceState === "speaking")
    ) {
      // While TTS is playing we feed both native KWS and the selected-language
      // Whisper wake fallback. If the currently spoken assistant chunk itself
      // contains a wake address, ignore microphone wake detections for that chunk
      // so LOOI cannot interrupt itself by saying its own name.
      if (conversationStore.isSpeaking && this.activeSpeakingChunkHasWakeAddress) {
        recordDiagnosticEvent("runtime", "wakeword-barge-in-echo-guard", {
          source: detection.source,
          turnId: this.activeTurnId || null,
        });
        return;
      }

      recordDiagnosticEvent("runtime", "wakeword-barge-in", {
        source: detection.source,
        voiceState: userStore.voiceState,
        turnId: this.activeTurnId || null,
        capturedWakeMs: Math.round(((detection.wakeSegmentSamples?.length ?? 0) / SPEAKER_SAMPLE_RATE) * 1000),
        capturedTailMs: Math.round(((detection.commandPrerollSamples?.length ?? 0) / SPEAKER_SAMPLE_RATE) * 1000),
      });

      if (await this.queueWakewordBargeIn(detection)) {
        return;
      }

      // Manual/native detections without recoverable PCM still fall back to the
      // deterministic hard restart path.
      await this.interruptAndListen("wakeword");
      return;
    }

    const readyState = userStore.voiceState === "sleeping" || userStore.voiceState === "attention";
    if (
      conversationStore.isListening ||
      conversationStore.isProcessing ||
      !readyState ||
      this.startListeningPromise ||
      this.isFinishingListening
    ) {
      voiceAcceptanceTrace.mark("ignored", {
        isListening: conversationStore.isListening,
        isProcessing: conversationStore.isProcessing,
        voiceState: userStore.voiceState,
      });
      console.log("[VoicePerceiver] Ignored trigger", {
        isListening: conversationStore.isListening,
        isProcessing: conversationStore.isProcessing,
        voiceState: userStore.voiceState,
        hasStartListeningPromise: Boolean(this.startListeningPromise),
        isFinishingListening: this.isFinishingListening,
      });
      return;
    }

    if (isRealtimeConversationMode(userStore.preferences.conversationMode)) {
      recordDiagnosticEvent("runtime", "main-wake-accepted", {
        source: detection?.source ?? "manual",
        phraseId: detection?.phraseId ?? "unknown",
        keyword: detection?.keyword || "(empty)",
        conversationMode: userStore.preferences.conversationMode,
      });
      try {
        await realtimeConversationService.start(detection);
      } catch (error) {
        recordDiagnosticEvent("realtime", "activation-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.restartWakewordFeederIfNeeded();
      }
      return;
    }

    this.followUpTurn = false;
    this.pendingWakeSegmentSamples = detection?.wakeSegmentSamples ?? [];
    this.pendingCommandPrerollSamples = detection?.commandPrerollSamples ?? [];
    this.pendingHasCommandSuffix = detection?.hasCommandSuffix ?? false;
    this.pendingWakeWasManual = !detection;
    recordDiagnosticEvent("runtime", "main-wake-accepted", {
      source: detection?.source ?? "manual",
      phraseId: detection?.phraseId ?? "unknown",
      keyword: detection?.keyword || "(empty)",
    });

    voiceAcceptanceTrace.start();
    const t0 = Date.now();
    console.log("[VoicePerceiver] Listening started");
    // Step 1: Start listening. In the single-user runtime, an accepted wake/tap/follow-up
    // turn is trusted as the active profile; Speaker ID remains diagnostic-only.
    userStore.setVoiceState("listening");
    conversationStore.setListening(true);
    conversationStore.setCurrentTranscript("");
    conversationStore.setStreamingText("");
    conversationStore.setOverlayVisible(true);

    // Fire-and-forget: session ID doesn't affect recording/ASR,
    // only message attribution. Update store when result arrives.
    sessionService.touch().then((session) => {
      useConversationStore.getState().setActiveSession(session.sessionId);
      mirrorSessionTouch(session.sessionId, "classic");
      voiceAcceptanceTrace.mark("session", {
        sessionId: session.sessionId,
        isNew: session.isNew,
      });
      console.log("[VoicePerceiver] Session touched (async)", {
        sessionId: session.sessionId,
        isNew: session.isNew,
      });
    }).catch((error) => {
      console.warn("[VoicePerceiver] Session touch failed:", error);
    });

    const t1 = Date.now();
    const startListeningPromise = this.startStreamingForListening(t0, t1);
    this.startListeningPromise = startListeningPromise;

    try {
      await startListeningPromise;
    } finally {
      if (this.startListeningPromise === startListeningPromise) {
        this.startListeningPromise = null;
        if (
          this.inlineWakeCommand &&
          this.unsubStreamingSamples &&
          useUserStore.getState().voiceState === "listening"
        ) {
          // The fallback already heard a command suffix in the same speech
          // segment (for example: "Hey LOOI, what time is it?"). Its full
          // segment is in the STT buffer, so do not wait for another VAD turn.
          await this.finishListening();
        } else {
          await this.restartWakewordFeederIfNeeded();
        }
      }
    }
  }

  /**
   * Stop listening and process the speech
   * Called by UI when user releases the button or VAD detects silence
   */
  async finishListening(): Promise<void> {
    let userStore = useUserStore.getState();
    let conversationStore = useConversationStore.getState();

    if (isRealtimeConversationMode(userStore.preferences.conversationMode)) {
      recordDiagnosticEvent("runtime", "classic-finish-ignored-retired", {
        conversationMode: userStore.preferences.conversationMode,
      });
      return;
    }

    if (this.isFinishingListening) {
      console.log("[VoicePerceiver] Ignored finish: already finishing");
      return;
    }

    this.isFinishingListening = true;
    this.turnAbortController?.abort();
    const turnAbortController = new AbortController();
    this.turnAbortController = turnAbortController;
    const turnSignal = turnAbortController.signal;
    const turnId = ++this.turnSequence;
    const turnSpeechEndedAt = Date.now();
    this.activeTurnSpeechEndedAt = turnSpeechEndedAt;
    this.activeTurnFirstAudioLogged = false;
    this.activeTurnId = turnId;
    recordDiagnosticEvent("runtime", "turn-created", {
      turnId,
      listeningLanguage: userStore.preferences.listeningLanguage,
      responseLanguage: userStore.preferences.language,
    });
    const wasFollowUpTurn = this.followUpTurn;
    const wasManualActivation = this.pendingWakeWasManual;
    this.pendingWakeWasManual = false;
    this.followUpTurn = false;
    let shouldOpenFollowUp = false;
    const hadListeningRequest =
      conversationStore.isListening ||
      userStore.voiceState === "listening" ||
      Boolean(this.startListeningPromise) ||
      Boolean(this.unsubStreamingSamples);

    console.log("[VoicePerceiver] Finish requested", {
      hadListeningRequest,
      isListening: conversationStore.isListening,
      voiceState: userStore.voiceState,
      streamingActive: Boolean(this.unsubStreamingSamples),
      hasStartListeningPromise: Boolean(this.startListeningPromise),
    });
    voiceAcceptanceTrace.mark("finish-requested", {
      hadListeningRequest,
      streamingActive: Boolean(this.unsubStreamingSamples),
    });

    conversationStore.setListening(false);
    if (hadListeningRequest) {
      userStore.setVoiceState("processing");
      conversationStore.setProcessing(true);
    }

    try {
      if (!this.unsubStreamingSamples && this.startListeningPromise) {
        const listeningStarted = await this.waitForListeningStart(this.startListeningPromise);
        if (!listeningStarted) {
          this.cancelListeningAfterStart = true;
          console.warn("[VoicePerceiver] Listening start timed out; cancelling when ready");
          return;
        }
      }

      userStore = useUserStore.getState();
      conversationStore = useConversationStore.getState();

      if (!this.unsubStreamingSamples && this.speechSamplesBuffer.length === 0) {
        console.log("[VoicePerceiver] Finish stopped: no active streaming listener");
        if (userStore.voiceState === "listening") {
          userStore.setVoiceState("sleeping");
        }
        return;
      }

      userStore.setVoiceState("processing");
      conversationStore.setProcessing(true);

      await this.stopListeningStreaming({ resetAsr: false, keepFeederRunning: true });
      // Classic stability: do not run generic VAD barge-in while STT/LLM is processing.
      // The v1.1.31 detector produced false turns from tail noise and cancelled valid responses.
      recordDiagnosticEvent("speaker", "verification-skipped", {
        turnId,
        reason: wasFollowUpTurn ? "trusted-conversation-window" : "single-user-profile",
      });
      // Classic stability: VAD decides *when* a conversational turn ends, but it
      // does not get to cut words out of the STT payload. Preserve the complete
      // capture exactly as v1.1.19-style conversation did. This intentionally
      // prefers recognition reliability over shaving silence from follow-up audio.
      const sttSamples = this.speechSamplesBuffer.slice();
      if (wasFollowUpTurn) {
        recordDiagnosticEvent("stt", "follow-up-audio-preserved", {
          capturedDurationMs: Math.round((this.speechSamplesBuffer.length / SPEAKER_SAMPLE_RATE) * 1000),
          transcribedDurationMs: Math.round((sttSamples.length / SPEAKER_SAMPLE_RATE) * 1000),
          speechRangesObserved: this.speechSampleRanges.length,
        });
      }
      const sttStartedAt = Date.now();
      const rawTranscript = await sttService.transcribeCommandSamples(
        sttSamples,
        SPEAKER_SAMPLE_RATE,
        turnSignal,
        { turnId: `turn-${turnId}` }
      );
      recordDiagnosticEvent("latency", "stt-complete", {
        turnId,
        durationMs: Date.now() - sttStartedAt,
        sinceSpeechEndMs: Date.now() - turnSpeechEndedAt,
        listeningLanguage: useUserStore.getState().preferences.listeningLanguage,
      });
      this.throwIfTurnInterrupted(turnSignal);
      recordDiagnosticEvent("stt", "command-transcript", {
        transcript: rawTranscript || "(empty)",
      });
      console.log("[VoicePerceiver] Command STT finished", { transcript: rawTranscript });
      voiceAcceptanceTrace.mark("stt", { transcriptLength: rawTranscript.length });
      if (!rawTranscript.trim()) {
        if (wasFollowUpTurn) {
          shouldOpenFollowUp = true;
          recordDiagnosticEvent("runtime", "follow-up-empty-transcript");
          return;
        }
        const noSpeechMessage = getVoiceResponseMessage(
          userStore.preferences.language,
          "not-heard"
        );
        conversationStore.addMessage({
          role: "assistant",
          content: noSpeechMessage,
        });
        userStore.setVoiceState("sleeping");
        conversationStore.setProcessing(false);
        return;
      }

      markRobotInteraction("voice-transcript");

      const transcript = wasManualActivation
        ? rawTranscript.trim()
        : this.stripWakewordPrefix(rawTranscript);
      // Physical commands are intentionally deterministic and require an explicit
      // address at the start of the recognized utterance. Parse the raw STT text
      // before wakeword stripping so "Луи, спи" remains distinguishable from
      // ordinary conversational text such as "спи".
      const explicitCommandConfig = {
        robotName: userStore.preferences.robotName,
        robotAddressAliases: userStore.preferences.robotAddressAliases,
        robotAddressRecognitionAliases: userStore.preferences.robotAddressRecognitionAliases,
        listeningLanguage: userStore.preferences.listeningLanguage,
        customVoiceCommands: userStore.preferences.customVoiceCommands,
      };
      const explicitRobotCommand = parseExplicitRobotCommand(rawTranscript, explicitCommandConfig);
      const requestedListeningLanguage = detectListeningLanguageSwitchCommand(transcript);
      const requestedResponseLanguage = detectLanguageSwitchCommand(transcript);
      if (
        !explicitRobotCommand &&
        !requestedListeningLanguage &&
        !requestedResponseLanguage &&
        hasExplicitRobotAddress(rawTranscript, explicitCommandConfig)
      ) {
        recordDiagnosticEvent("robot", "explicit-voice-command-unmatched", {
          transcriptLength: rawTranscript.length,
          reason: "unsupported-or-ambiguous-action",
        });
      }

      // Single-user mode: once a turn is activated by wake word, tap, or the trusted
      // conversational window, it belongs to the currently active profile. Speaker ID is
      // intentionally not a gate because false negatives make the assistant unusable and
      // provide no value when the device has a single conversational user.
      voiceAcceptanceTrace.mark("speaker-verified", {
        isOwner: true,
        trusted: true,
        mode: "single-user",
      });
      this.throwIfTurnInterrupted(turnSignal);

      if (!transcript) {
        if (wasFollowUpTurn) {
          shouldOpenFollowUp = true;
          recordDiagnosticEvent("runtime", "follow-up-command-empty");
          return;
        }
        const missingCommand = getVoiceResponseMessage(
          userStore.preferences.language,
          "command-missing"
        );
        conversationStore.addMessage({
          role: "assistant",
          content: missingCommand,
        });
        return;
      }

      shouldOpenFollowUp = true;
      userStore.setVoiceState("processing");
      conversationStore.setCurrentTranscript(transcript);
      conversationStore.addMessage({ role: "user", content: transcript });

      // Absolute safety rule: the standalone word STOP never requires a robot
      // address and never reaches the LLM. False positives are preferable to a
      // delayed physical stop. Native KWS provides an even earlier parallel path.
      if (containsEmergencyStopWord(rawTranscript, explicitCommandConfig)) {
        const stopStartedAt = Date.now();
        await stopLooiMotion("voice-emergency-transcript");
        const responseLanguage = useUserStore.getState().preferences.language;
        const acknowledgement = responseLanguage === "en"
          ? "Stopped."
          : responseLanguage === "uk" ? "Зупинився." : "Остановился.";
        conversationStore.addMessage({ role: "assistant", content: acknowledgement });
        conversationStore.setStreamingText(acknowledgement);
        this.queueSessionTurnPersistence(transcript, acknowledgement);
        recordDiagnosticEvent("robot", "emergency-stop-transcript", {
          transcriptLength: rawTranscript.length,
          stopDispatchMs: Date.now() - stopStartedAt,
        });
        return;
      }

      if (explicitRobotCommand) {
        const result = await this.executeExplicitRobotCommand(explicitRobotCommand, rawTranscript);
        this.throwIfTurnInterrupted(turnSignal);
        if (explicitRobotCommand.kind === "sleep") {
          shouldOpenFollowUp = false;
          return;
        }

        const acknowledgement = result.ok ? result.message : `Не получилось: ${result.message}`;
        conversationStore.addMessage({ role: "assistant", content: acknowledgement });
        conversationStore.setStreamingText(acknowledgement);
        this.queueSessionTurnPersistence(transcript, acknowledgement);

        // Any successful addressed physical command opens a short local Driving
        // Control Session. STOP does not close it: for 30 seconds the user can
        // continue with bounded physical commands without repeating "Луи/Робот"
        // and without sending speech to remote STT/LLM.
        if (result.ok) {
          shouldOpenFollowUp = false;
          wakewordService.enterDrivingControlSession(`addressed-${explicitRobotCommand.kind}`);
          await this.armDrivingLocalCommandMode();
          recordDiagnosticEvent("runtime", "driving-command-mode-entered", {
            direction: getLooiRobotRuntimeState().activeDirection ?? "none",
            motionActive: getLooiRobotRuntimeState().motionActive,
            sessionActive: wakewordService.isDrivingControlSessionActive,
            localOnly: true,
          });
        }
        return;
      }

      if (requestedListeningLanguage) {
        const responseLanguage = useUserStore.getState().preferences.language;
        userStore.updatePreferences({ listeningLanguage: requestedListeningLanguage });
        await wakewordService.resetFallback().catch(() => undefined);
        const acknowledgement = getListeningLanguageSwitchAcknowledgement(
          requestedListeningLanguage,
          responseLanguage
        );
        conversationStore.addMessage({ role: "assistant", content: acknowledgement });
        this.queueSessionTurnPersistence(transcript, acknowledgement);
        conversationStore.setStreamingText(acknowledgement);
        recordDiagnosticEvent("runtime", "listening-language-changed", {
          language: requestedListeningLanguage,
          source: "voice-command",
        });
        if (useUserStore.getState().preferences.ttsEnabled) {
          const preferences = useUserStore.getState().preferences;
          await this.quiesceCaptureForSpeaking("assistant-speaking-listening-language-switch");
          userStore.setVoiceState("speaking");
          conversationStore.setSpeaking(true);
          await this.withSpeakingWakeEchoGuard(acknowledgement, () => ttsService.speak({
            text: acknowledgement,
            voiceId: preferences.ttsVoiceId,
            styleId: preferences.ttsStyleId,
            speed: preferences.ttsSpeed,
          })).catch((error) => {
            console.warn("[VoicePerceiver] Failed to speak listening-language acknowledgement:", error);
          });
        }
        return;
      }

      if (requestedResponseLanguage) {
        userStore.updatePreferences({ language: requestedResponseLanguage });
        const acknowledgement = getLanguageSwitchAcknowledgement(requestedResponseLanguage);
        conversationStore.addMessage({ role: "assistant", content: acknowledgement });
        this.queueSessionTurnPersistence(transcript, acknowledgement);
        conversationStore.setStreamingText(acknowledgement);
        recordDiagnosticEvent("runtime", "response-language-changed", {
          language: requestedResponseLanguage,
          source: "voice-command",
        });
        if (useUserStore.getState().preferences.ttsEnabled) {
          const preferences = useUserStore.getState().preferences;
          await this.quiesceCaptureForSpeaking("assistant-speaking-language-switch");
          userStore.setVoiceState("speaking");
          conversationStore.setSpeaking(true);
          await this.withSpeakingWakeEchoGuard(acknowledgement, () => ttsService.speak({
            text: acknowledgement,
            voiceId: preferences.ttsVoiceId,
            styleId: preferences.ttsStyleId,
            speed: preferences.ttsSpeed,
          })).catch((error) => {
            console.warn("[VoicePerceiver] Failed to speak language acknowledgement:", error);
          });
        }
        return;
      }

      const responseLanguage = useUserStore.getState().preferences.language;
      const conversationInput = normalizeConversationTranscriptForAssistant(transcript);
      const assistantTranscript = conversationInput.transcript || transcript;
      if (conversationInput.stripped) {
        recordDiagnosticEvent("runtime", "conversation-address-stripped", {
          alias: conversationInput.alias ?? "unknown",
          originalLength: transcript.length,
          normalizedLength: assistantTranscript.length,
        });
      }

      // Step 4: Emit observation. A conversational address (for example
      // "Макс, ...") is routing metadata, not part of the fact itself.
      const category = classifyCategory(assistantTranscript);
      const observation = createObservation(assistantTranscript, "voice", category);
      this.emit(observation);

      // Step 5: Process with LLM
      console.log("[VoicePerceiver] Classifying intent", { transcript: assistantTranscript });
      const intentStartedAt = Date.now();
      recordDiagnosticEvent("llm", "intent-start");
      const [classifiedIntent] = await Promise.all([
        llmService.classifyIntent(assistantTranscript),
        this.waitForSessionPersistence(turnId),
      ]);
      this.throwIfTurnInterrupted(turnSignal);
      const guardedIntent = guardVoiceIntent(assistantTranscript, classifiedIntent);
      const intent = guardedIntent.intent;
      if (guardedIntent.corrected) {
        recordDiagnosticEvent("llm", "intent-corrected", {
          from: classifiedIntent,
          to: intent,
          reason: guardedIntent.reason,
          transcriptLength: assistantTranscript.length,
        });
      }
      recordDiagnosticEvent("llm", "intent-finished", {
        durationMs: Date.now() - intentStartedAt,
        intent,
        classifiedIntent,
      });
      console.log("[VoicePerceiver] Intent classified", { intent, classifiedIntent });
      voiceAcceptanceTrace.mark("intent", { intent });

      let response: string;
      let evidenceUri: string | undefined;
      let audioHandled = false;

      if (intent === "store") {
        await memoryService.remember(
          [{ role: "user", content: assistantTranscript }],
          observation.metadata
        );
        console.log("[VoicePerceiver] Memory stored");
        const result = await this.generateResponseWithOverlay(intent, {
          facts: [],
          transcript: assistantTranscript,
          responseLanguage,
        }, turnSignal);
        response = result.response;
        evidenceUri = result.evidenceUri;
        audioHandled = result.audioHandled;
      } else {
        const retrievalStartedAt = Date.now();
        const retrieval = await retrieveConversationMemories(assistantTranscript, {
          mode: intent === "search" ? "relevant" : "ambient",
        });
        const facts = retrieval.facts;
        recordDiagnosticEvent("memory", "turn-memory-retrieval", {
          backend: "local",
          intent,
          attempted: true,
          strategy: retrieval.strategy,
          results: facts.length,
          durationMs: Date.now() - retrievalStartedAt,
        });
        console.log("[VoicePerceiver] Turn memory retrieval", {
          backend: "local",
          intent,
          strategy: retrieval.strategy,
          facts: facts.length,
        });

        const generationIntent: UserIntent =
          intent === "search" && facts.length > 0 ? "chat" : intent;

        const result = await this.generateResponseWithOverlay(generationIntent, {
          facts,
          transcript: assistantTranscript,
          responseLanguage,
        }, turnSignal);
        response = result.response;
        evidenceUri = facts.find((fact) => fact.metadata?.evidenceUri)?.metadata?.evidenceUri;
        evidenceUri = result.evidenceUri ?? evidenceUri;
        audioHandled = result.audioHandled;
      }

      this.throwIfTurnInterrupted(turnSignal);

      // Step 6: Add assistant response
      console.log("[VoicePerceiver] Assistant response generated", { response });
      voiceAcceptanceTrace.mark("assistant", {
        responseLength: response.length,
        audioHandled,
        hasEvidence: Boolean(evidenceUri),
      });
      conversationStore.addMessage({ role: "assistant", content: response, evidenceUri });
      this.queueSessionTurnPersistence(transcript, response, evidenceUri);
      if (evidenceUri) {
        conversationStore.showImageOverlay(evidenceUri);
      }

      // Step 7: TTS playback
      userStore.setVoiceState("speaking");
      conversationStore.setSpeaking(true);

      if (userStore.preferences.ttsEnabled && !audioHandled) {
        await this.quiesceCaptureForSpeaking("assistant-speaking-fallback");
        await this.withSpeakingWakeEchoGuard(response, () => ttsService.speak({
          text: response,
          voiceId: userStore.preferences.ttsVoiceId,
          styleId: userStore.preferences.ttsStyleId,
          speed: userStore.preferences.ttsSpeed,
          onPlaybackStart: () => {
            voiceAcceptanceTrace.mark("first-tts", { mode: "fallback" });
            if (!this.activeTurnFirstAudioLogged && this.activeTurnSpeechEndedAt > 0) {
              this.activeTurnFirstAudioLogged = true;
              recordDiagnosticEvent("latency", "first-audio", {
                turnId: this.activeTurnId || null,
                speechEndToAudioMs: Date.now() - this.activeTurnSpeechEndedAt,
                mode: "fallback",
              });
            }
            conversationStore.setStreamingText(response);
          },
        }));
      }
    } catch (error) {
      if (turnSignal.aborted) {
        recordDiagnosticEvent("runtime", "turn-interrupted", {
          pendingManualRestart: this.pendingManualRestart,
          pendingBargeIn: Boolean(this.pendingBargeInSamples),
          turnId,
        });
        console.log("[VoicePerceiver] Current turn interrupted");
      } else {
        console.warn("[VoicePerceiver] Processing stopped:", error);
        voiceAcceptanceTrace.mark("error", {
          message: error instanceof Error ? error.message : String(error),
        });
        const processingError = getVoiceResponseMessage(
          useUserStore.getState().preferences.language,
          "processing-failed"
        );
        await conversationStore.appendMessage({
          role: "assistant",
          content: processingError,
        });
      }
    } finally {
      this.activeSpeakingChunkHasWakeAddress = false;
      await wakewordService.setSpeakingBargeInMode(false);
      wakewordService.setNativeOnlyMode(false);
      await this.stopProcessingBargeIn("turn-finally");
      const isCurrentTurn = this.activeTurnId === turnId;
      const restartFromInteraction = this.pendingManualRestart && this.isActive;
      const queuedBargeIn =
        !restartFromInteraction && this.pendingBargeInSamples
          ? this.pendingBargeInSamples.slice()
          : null;
      if (queuedBargeIn) {
        this.pendingBargeInSamples = null;
        shouldOpenFollowUp = false;
      }
      if (restartFromInteraction) {
        shouldOpenFollowUp = false;
      }

      if (this.turnAbortController === turnAbortController) {
        this.turnAbortController = null;
      }

      if (isCurrentTurn) {
        useUserStore.getState().setVoiceState("sleeping");
        useConversationStore.getState().setListening(false);
        useConversationStore.getState().setProcessing(false);
        useConversationStore.getState().setSpeaking(false);
        this.isFinishingListening = false;
        this.activeTurnId = 0;
      } else {
        recordDiagnosticEvent("runtime", "stale-cleanup-skipped", {
          turnId,
          activeTurnId: this.activeTurnId || null,
        });
      }

      voiceAcceptanceTrace.finish({
        voiceState: useUserStore.getState().voiceState,
        isListening: useConversationStore.getState().isListening,
        isProcessing: useConversationStore.getState().isProcessing,
        interrupted: turnSignal.aborted,
      });

      try {
        if (!isCurrentTurn) {
          return;
        }
        if (restartFromInteraction) {
          recordDiagnosticEvent("runtime", "interrupt-restart-deferred", { turnId });
        } else if (queuedBargeIn && this.isActive) {
          recordDiagnosticEvent("runtime", "processing-barge-in-queued", {
            turnId,
            durationMs: Math.round((queuedBargeIn.length / SPEAKER_SAMPLE_RATE) * 1000),
          });
          void this.startCapturedFollowUp(queuedBargeIn);
        } else if (shouldOpenFollowUp && this.isActive) {
          await this.startFollowUpListening();
        } else {
          setTimeout(() => {
            useConversationStore.getState().setOverlayVisible(false);
          }, 3000);
          await this.restartWakewordFeederIfNeeded();
        }
      } finally {
        if (isCurrentTurn) {
          recordDiagnosticEvent("runtime", "turn-cleanup-complete", { turnId });
          this.notifyTurnCompletion();
        }
      }
    }
  }

  private async generateResponseWithOverlay(
    intent: UserIntent,
    context: {
      facts: MemoryResult[];
      transcript: string;
      responseLanguage: ReturnType<typeof useUserStore.getState>["preferences"]["language"];
    },
    signal: AbortSignal
  ): Promise<GenerateResponseResult> {
    const sessionId = useConversationStore.getState().activeSessionId;
    useConversationStore.getState().setStreamingText("");
    let streamedEvidenceUri: string | undefined;
    const generationStartedAt = Date.now();
    let firstTokenLogged = false;
    recordDiagnosticEvent("llm", "generation-start", {
      intent,
      facts: context.facts.length,
      responseLanguage: context.responseLanguage,
      listeningLanguage: useUserStore.getState().preferences.listeningLanguage,
    });

    this.throwIfTurnInterrupted(signal);

    if (llmService.generateResponseStream) {
      let streamedText = "";
      let spokenSubtitleText = "";
      const ttsQueue = new AsyncTtsQueue();
      const ttsPreferences = useUserStore.getState().preferences;
      const shouldSpeak = ttsPreferences.ttsEnabled;
      const ttsPromise = shouldSpeak
        ? this.playTtsStream(ttsQueue, ttsPreferences, (text) => {
            voiceAcceptanceTrace.mark("first-tts", { mode: "stream" });
            if (!this.activeTurnFirstAudioLogged && this.activeTurnSpeechEndedAt > 0) {
              this.activeTurnFirstAudioLogged = true;
              recordDiagnosticEvent("latency", "first-audio", {
                turnId: this.activeTurnId || null,
                speechEndToAudioMs: Date.now() - this.activeTurnSpeechEndedAt,
                mode: "stream",
              });
            }
            useUserStore.getState().setVoiceState("speaking");
            useConversationStore.getState().setSpeaking(true);
            spokenSubtitleText = this.appendAssistantSubtitle(spokenSubtitleText, text);
          }, signal)
        : Promise.resolve(0);

      try {
        for await (const event of llmService.generateResponseStream({
          sessionId,
          turnId: this.activeTurnId ? `turn-${this.activeTurnId}` : undefined,
          intent,
          facts: context.facts,
          transcript: context.transcript,
          responseLanguage: context.responseLanguage,
          ttsVoiceId: ttsPreferences.ttsVoiceId,
          ttsStyleId: ttsPreferences.ttsStyleId,
          ttsSpeed: ttsPreferences.ttsSpeed,
        }, { signal })) {
          this.throwIfTurnInterrupted(signal);
          if (event.type === "token") {
            voiceAcceptanceTrace.mark("first-token");
            if (!firstTokenLogged) {
              firstTokenLogged = true;
              recordDiagnosticEvent("llm", "first-token", {
                durationMs: Date.now() - generationStartedAt,
                speechEndToFirstTokenMs: this.activeTurnSpeechEndedAt > 0
                  ? Date.now() - this.activeTurnSpeechEndedAt
                  : "unknown",
              });
            }
            streamedText += event.text;
            if (!shouldSpeak) {
              useConversationStore.getState().appendStreamingText(event.text);
            }
          } else if (event.type === "tts") {
            if (shouldSpeak) {
              recordDiagnosticEvent("tts", "chunk-ready", {
                durationMs: Date.now() - generationStartedAt,
                textLength: event.text.length,
              });
              ttsQueue.push({ text: event.text, audioUrl: event.audioUrl, model: event.model });
            }
          } else if (event.type === "done") {
            const fullText = event.fullText || streamedText;
            voiceAcceptanceTrace.mark("stream-done", {
              responseLength: fullText.length,
              hasEvidence: Boolean(event.evidenceUri),
            });
            recordDiagnosticEvent("llm", "generation-finished", {
              durationMs: Date.now() - generationStartedAt,
              responseLength: fullText.length,
              hasEvidence: Boolean(event.evidenceUri),
              requestedResponseLanguage: context.responseLanguage,
              serverResponseLanguage: event.responseLanguage ?? "unknown",
              model: event.model ?? "unknown",
              inputTokens: event.usage?.inputTokens ?? "unknown",
              outputTokens: event.usage?.outputTokens ?? "unknown",
              cachedInputTokens: event.usage?.cachedInputTokens ?? "unknown",
            });
            streamedEvidenceUri = event.evidenceUri;
            ttsQueue.close();
            const playedTtsItems = await ttsPromise;
            this.throwIfTurnInterrupted(signal);
            useConversationStore.getState().setStreamingText(fullText);
            if (event.evidenceUri) {
              useConversationStore.getState().showImageOverlay(event.evidenceUri);
            }
            return {
              response: fullText,
              evidenceUri: event.evidenceUri,
              audioHandled: playedTtsItems > 0,
            };
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }

        ttsQueue.close();
        const playedTtsItems = await ttsPromise;
        this.throwIfTurnInterrupted(signal);
        if (streamedText) {
          return {
            response: streamedText,
            evidenceUri: streamedEvidenceUri,
            audioHandled: playedTtsItems > 0,
          };
        }
      } catch (error) {
        ttsQueue.close();
        await ttsService.stop().catch(() => undefined);
        await ttsPromise.catch(() => undefined);
        if (signal.aborted) {
          throw error;
        }
        console.warn("[VoicePerceiver] Streaming response failed; using fallback:", error);
        useConversationStore.getState().setStreamingText("");
      }
    }

    this.throwIfTurnInterrupted(signal);
    const response = await llmService.generateResponse(intent, context);
    this.throwIfTurnInterrupted(signal);
    recordDiagnosticEvent("llm", "generation-finished", {
      durationMs: Date.now() - generationStartedAt,
      responseLength: response.length,
      mode: "fallback",
    });
    if (!useUserStore.getState().preferences.ttsEnabled) {
      useConversationStore.getState().setStreamingText(response);
    }
    return { response, audioHandled: false };
  }

  private async playTtsStream(
    items: AsyncIterable<TtsStreamItem>,
    preferences: { ttsVoiceId: string; ttsStyleId: TtsStyleId; ttsSpeed: number },
    onPlaybackStart: (text: string) => void,
    signal: AbortSignal
  ): Promise<number> {
    let playedItems = 0;
    const iterator = items[Symbol.asyncIterator]();
    let currentResult = await iterator.next();
    let currentPrepared: PreparedTtsAudio | null = null;
    let captureQuiescePromise: Promise<void> | null = null;

    while (!currentResult.done) {
      if (signal.aborted && currentPrepared) {
        ttsService.releasePreparedAudio(currentPrepared);
        currentPrepared = null;
      }
      this.throwIfTurnInterrupted(signal);
      const item = applyTtsPreferencesToStreamItem(currentResult.value, preferences);
      let started = false;
      let playbackStartedAt = 0;
      const playbackRequestedAt = Date.now();
      recordDiagnosticEvent("playback", "request-start", {
        textLength: item.text.length,
        voiceId: preferences.ttsVoiceId,
        styleId: preferences.ttsStyleId,
        speed: preferences.ttsSpeed,
      });

      captureQuiescePromise ??= this.quiesceCaptureForSpeaking("assistant-speaking-stream");
      try {
        currentPrepared = currentPrepared ?? (await ttsService.prepareAudioUrl(item));
      } catch (error) {
        currentPrepared = null;
        console.warn("[VoicePerceiver] TTS prefetch failed:", error);
      }

      const followingPromise = iterator.next().then(async (result) => {
        if (result.done) {
          return { result, prepared: null as PreparedTtsAudio | null };
        }
        try {
          const prepared = await ttsService.prepareAudioUrl(
            applyTtsPreferencesToStreamItem(result.value, preferences)
          );
          return { result, prepared };
        } catch (error) {
          console.warn("[VoicePerceiver] Next TTS chunk prefetch failed:", error);
          return { result, prepared: null as PreparedTtsAudio | null };
        }
      });

      // Once the server tells us this is the final TTS chunk, pay the Android
      // recorder startup cost while the last audio is still playing. No VAD or
      // wakeword listener is attached yet, so captured assistant audio is discarded.
      void followingPromise.then(({ result }) => {
        if (!result.done || signal.aborted) return;
        captureQuiescePromise ??= this.quiesceCaptureForSpeaking("assistant-speaking-stream");
        void captureQuiescePromise
          .then(() => this.prewarmFollowUpCapture(signal))
          .catch(() => undefined);
      });

      try {
        await captureQuiescePromise;
        if (!currentPrepared) {
          throw new Error("TTS chunk was not prefetched");
        }
        await this.withSpeakingWakeEchoGuard(item.text, () => ttsService.playPreparedAudio(currentPrepared as PreparedTtsAudio, () => {
          started = true;
          playbackStartedAt = Date.now();
          playedItems += 1;
          recordDiagnosticEvent("playback", "started", {
            durationMs: Date.now() - playbackRequestedAt,
            mode: "prefetched-stream",
            textLength: item.text.length,
          });
          onPlaybackStart(item.text);
        }));
        const spokenDurationMs = playbackStartedAt > 0 ? Date.now() - playbackStartedAt : 0;
        recordDiagnosticEvent("playback", "finished", {
          durationMs: Date.now() - playbackRequestedAt,
          spokenDurationMs,
          mode: "prefetched-stream",
          textLength: item.text.length,
        });
        const usageSessionId = useConversationStore.getState().activeSessionId;
        if (usageSessionId && spokenDurationMs > 0 && item.model) {
          void sessionService.recordUsage(usageSessionId, {
            turnId: this.activeTurnId ? `turn-${this.activeTurnId}` : undefined,
            component: "tts",
            model: item.model,
            durationMs: spokenDurationMs,
            usageJson: { textLength: item.text.length, source: "played-audio-duration" },
          }).then((usage) => {
            recordDiagnosticEvent("cost", "usage-recorded", {
              component: "tts",
              model: item.model ?? "unknown",
              costUsd: usage.costUsd,
              estimated: usage.estimated,
            });
          }).catch((error) => {
            recordDiagnosticEvent("cost", "usage-record-failed", {
              component: "tts",
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } catch (error) {
        if (signal.aborted) {
          if (currentPrepared) {
            ttsService.releasePreparedAudio(currentPrepared);
            currentPrepared = null;
          }
          const following = await followingPromise.catch(() => null);
          if (following?.prepared) {
            ttsService.releasePreparedAudio(following.prepared);
          }
          throw error;
        }
        console.warn("[VoicePerceiver] Server TTS playback failed:", error);
        if (!started) {
          try {
            await this.withSpeakingWakeEchoGuard(item.text, () => ttsService.speak({
              text: item.text,
              voiceId: preferences.ttsVoiceId,
              styleId: preferences.ttsStyleId,
              speed: preferences.ttsSpeed,
              onPlaybackStart: () => {
                started = true;
                playedItems += 1;
                recordDiagnosticEvent("playback", "started", {
                  durationMs: Date.now() - playbackRequestedAt,
                  mode: "buffered-fallback",
                  textLength: item.text.length,
                });
                onPlaybackStart(item.text);
              },
            }));
          } catch (fallbackError) {
            if (signal.aborted) throw fallbackError;
            console.warn("[VoicePerceiver] Buffered TTS fallback failed:", fallbackError);
          }
        }
      }

      currentPrepared = null;
      const following = await followingPromise;
      currentResult = following.result;
      currentPrepared = following.prepared;
    }

    if (currentPrepared) {
      ttsService.releasePreparedAudio(currentPrepared);
    }
    return playedItems;
  }

  private async prewarmFollowUpCapture(signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.isActive || this.followUpCapturePrewarmed) return;
    if (this.followUpPrewarmPromise) {
      await this.followUpPrewarmPromise;
      return;
    }

    const startedAt = Date.now();
    const prewarmPromise = (async () => {
      // Do not disable wakeword feeding here: this runs while the final TTS
      // chunk may still be audible, and speaking barge-in must remain live.
      if (!this.processingBargeInUnsub) {
        await vadService.reset().catch(() => undefined);
      }
      if (signal.aborted || !this.isActive) return;
      // Never start a cold native recorder from speculative TTS prewarm. If capture
      // is unexpectedly down, the normal post-TTS clean-restart path is safer.
      if (!kwsAudioFeeder.isRunning) {
        this.followUpCapturePrewarmed = false;
        recordDiagnosticEvent("runtime", "follow-up-capture-prewarm-skipped", {
          reason: "feeder-not-running",
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      this.followUpCapturePrewarmed = true;
      recordDiagnosticEvent("runtime", "follow-up-capture-prewarmed", {
        feederRunning: true,
        durationMs: Date.now() - startedAt,
      });
    })().catch((error) => {
      this.followUpCapturePrewarmed = false;
      recordDiagnosticEvent("runtime", "follow-up-capture-prewarm-failed", {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    });

    this.followUpPrewarmPromise = prewarmPromise;
    try {
      await prewarmPromise;
    } finally {
      if (this.followUpPrewarmPromise === prewarmPromise) {
        this.followUpPrewarmPromise = null;
      }
    }
  }

  private async withSpeakingWakeEchoGuard<T>(text: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.activeSpeakingChunkHasWakeAddress;
    this.activeSpeakingChunkHasWakeAddress = containsWakeAddressToken(text);
    try {
      return await operation();
    } finally {
      this.activeSpeakingChunkHasWakeAddress = previous;
    }
  }

  private appendAssistantSubtitle(currentText: string, sentence: string): string {
    const nextText = `${currentText}${sentence}`;
    useConversationStore.getState().setStreamingText(nextText);
    return nextText;
  }

  private async executeExplicitRobotCommand(
    command: ExplicitRobotCommand,
    rawTranscript: string
  ): Promise<{ ok: boolean; message: string }> {
    recordDiagnosticEvent("robot", "explicit-voice-command", {
      kind: command.kind,
      direction: command.kind === "move" || command.kind === "turn" ? command.direction : undefined,
      degrees: command.kind === "turn" ? command.degrees : undefined,
      gesture: command.kind === "gesture" ? command.gesture : undefined,
      count: command.kind === "gesture" ? command.count : undefined,
      transcriptLength: rawTranscript.length,
    });

    try {
      if (command.kind === "sleep") {
        await enterRobotSleepMode("voice");
        return { ok: true, message: "Спокойной ночи." };
      }

      if (command.kind === "gesture") {
        await performLooiHeadGesture(command.gesture, command.count);
        return { ok: true, message: command.count > 1 ? `Киваю ${command.count} раза.` : "Киваю." };
      }

      if (command.kind === "dance") {
        triggerCharacterReaction("victory", { durationMs: 5_000, source: "explicit-voice-dance" });
        await wakewordService.prepareDrivingControl().catch(() => false);
        await voskDrivingCommandRecognizer.armEmergencyForMotion("addressed-dance", 10_000);
        try {
          await performLooiDance("random");
          return { ok: true, message: "Танцую!" };
        } finally {
          await voskDrivingCommandRecognizer.disarmEmergency("addressed-dance-finished");
        }
      }

      if (command.kind === "turn") {
        // Register the local STOP handler and arm a clean per-motion decoder
        // before any bounded wheel movement begins. The Driving Control Session
        // itself is opened after this addressed command completes.
        await wakewordService.prepareDrivingControl().catch(() => false);
        await voskDrivingCommandRecognizer.armEmergencyForMotion(`addressed-turn-${command.degrees}`, 3_000);
        try {
          await turnLooi(command.direction, command.degrees);
        } finally {
          await voskDrivingCommandRecognizer.disarmEmergency("addressed-turn-finished");
        }
        return {
          ok: true,
          message: command.degrees === 180
            ? "Развернулся."
            : command.direction === "left" ? "Повернул налево." : "Повернул направо.",
        };
      }

      if (command.direction === "stop") {
        await stopLooiMotion("explicit-voice-stop");
      } else {
        await wakewordService.prepareDrivingControl().catch(() => false);
        await voskDrivingCommandRecognizer.armEmergencyForMotion("addressed-move", 8_000);
        try {
          await startLooiMotion(command.direction);
        } catch (error) {
          await voskDrivingCommandRecognizer.disarmEmergency("addressed-move-start-failed");
          throw error;
        }
      }
      const labels: Record<typeof command.direction, string> = {
        forward: "Еду вперёд.",
        backward: "Еду назад.",
        stop: "Остановился.",
      };
      return { ok: true, message: labels[command.direction] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordDiagnosticEvent("robot", "explicit-voice-command-failed", {
        kind: command.kind,
        error: message,
      });
      return { ok: false, message };
    }
  }

  private stripWakewordPrefix(transcript: string): string {
    const normalized = transcript.trim();
    return normalized.replace(WAKEWORD_TRANSCRIPT_PREFIX_RE, "").trim();
  }

  private async startStreamingForListening(t0?: number, t1?: number): Promise<void> {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    try {
      await this.startListeningStreaming(t0, t1);
      voiceAcceptanceTrace.mark("recording-started");
      voiceAcceptanceTrace.mark("streaming-listening-started");
      if (this.cancelListeningAfterStart) {
        await this.stopListeningStreaming({ resetAsr: true });
        return;
      }
    } catch (error) {
      console.error("[VoicePerceiver] Failed to start streaming listener:", error);
      voiceAcceptanceTrace.mark("error", {
        message: error instanceof Error ? error.message : String(error),
      });
      userStore.setVoiceState("sleeping");
      conversationStore.setListening(false);
      await this.restartWakewordFeederIfNeeded();
      voiceAcceptanceTrace.finish({
        voiceState: useUserStore.getState().voiceState,
        isListening: useConversationStore.getState().isListening,
        isProcessing: useConversationStore.getState().isProcessing,
      });
    } finally {
      this.cancelListeningAfterStart = false;
    }
  }

  private async startListeningStreaming(t0?: number, t1?: number): Promise<void> {
    const tBase = t0 ?? Date.now();
    let vadResetPromise: Promise<void> = Promise.resolve();

    // Only run full stop if a previous streaming session is still active.
    // On normal wakeword path, unsubStreamingSamples is null — skip the
    // destructive stop that would wipe the ring buffer and restart the feeder.
    if (this.unsubStreamingSamples) {
      await this.stopListeningStreaming({ resetAsr: true });
      console.log(`[VoicePerceiver][TIMING] stopListeningStreaming: ${Date.now() - tBase}ms`);
    } else {
      // Begin the reset but subscribe to live PCM before awaiting it. This
      // closes the KWS -> command gap even when native VAD initialization is
      // slow on first use.
      if (this.listeningTimeout) {
        clearTimeout(this.listeningTimeout);
        this.listeningTimeout = null;
      }
      vadResetPromise = vadService.reset().catch(() => undefined);
    }

    const generation = ++this.listeningGeneration;
    this.vadHadSpeech = false;
    this.vadQueuedSamples = null;
    this.vadStartupSamples = [];
    this.speechSamplesBuffer = [];
    this.commandSamplesBuffer = [];
    this.speechSampleRanges = [];
    this.wakeSegmentSamplesForSpeaker = [];
    this.inlineWakeCommand = this.pendingHasCommandSuffix;
    this.pendingHasCommandSuffix = false;

    // Subscribe before a potential cold Whisper initialization so no command audio is lost.
    let vadReady = false;
    let firstListenerPcmLogged = false;
    this.unsubStreamingSamples = kwsAudioFeeder.subscribeSamples((samples, sampleRate) => {
      if (generation !== this.listeningGeneration) return;
      if (!firstListenerPcmLogged) {
        firstListenerPcmLogged = true;
        recordDiagnosticEvent("runtime", "listening-first-pcm", {
          generation,
          followUp: this.followUpTurn,
          sampleCount: samples.length,
        });
      }
      this.speechSamplesBuffer.push(...samples);
      this.commandSamplesBuffer.push(...samples);
      if (vadReady) {
        this.enqueueVadSamples(samples, sampleRate, generation);
      } else {
        this.vadStartupSamples.push(...samples);
      }
    });
    recordDiagnosticEvent("runtime", "listening-listener-attached", {
      generation,
      feederRunning: kwsAudioFeeder.isRunning,
    });
    kwsAudioFeeder.setWakewordFeedingEnabled(false);

    // Preserve the completed wake segment for a single-pass STT transcript,
    // but never feed it into command VAD. Only PCM captured after that segment
    // plus future live PCM belongs to the command VAD timeline.
    const wakeSegmentSamples = this.pendingWakeSegmentSamples;
    this.pendingWakeSegmentSamples = [];
    this.wakeSegmentSamplesForSpeaker = wakeSegmentSamples;
    const commandPrerollSamples = this.pendingCommandPrerollSamples;
    this.pendingCommandPrerollSamples = [];
    console.log(`[VoicePerceiver][TIMING] wake/command preroll: ${Date.now() - tBase}ms, wakeSamples: ${wakeSegmentSamples.length}, commandSamples: ${commandPrerollSamples.length}`);
    if (wakeSegmentSamples.length > 0) {
      this.speechSamplesBuffer.push(...wakeSegmentSamples);
    }
    if (commandPrerollSamples.length > 0) {
      voiceAcceptanceTrace.mark("audio-preroll", {
        durationMs: Math.round((commandPrerollSamples.length / SPEAKER_SAMPLE_RATE) * 1000),
      });
      this.speechSamplesBuffer.push(...commandPrerollSamples);
      this.commandSamplesBuffer.push(...commandPrerollSamples);
      this.vadStartupSamples.push(...commandPrerollSamples);
    }

    // Feeder should already be running (it was feeding wakeword).
    // Only start it if it somehow stopped.
    if (!kwsAudioFeeder.isRunning) {
      try {
        await kwsAudioFeeder.start();
      } catch (error) {
        console.warn("[VoicePerceiver] Failed to start audio feeder:", error);
      }
    }

    // Remote STT is the primary command recognizer, so do not block VAD readiness
    // on a local Whisper initialization. The on-device model is initialized only
    // if the server transcription path needs its fallback.
    try {
      await vadResetPromise.then(() =>
        vadService.start().catch((error) => {
          console.warn("[VoicePerceiver] VAD unavailable; using safety timeout only:", error);
        })
      );
    } catch (error) {
      await this.stopListeningStreaming({ resetAsr: true });
      throw error;
    }
    vadReady = true;
    recordDiagnosticEvent("runtime", "listening-vad-ready", {
      generation,
      followUp: this.followUpTurn,
      startupSamples: this.vadStartupSamples.length,
    });
    if (this.vadStartupSamples.length > 0) {
      const startupSamples = this.vadStartupSamples;
      this.vadStartupSamples = [];
      this.enqueueVadSamples(startupSamples, SPEAKER_SAMPLE_RATE, generation);
    }
    console.log(`[VoicePerceiver][TIMING] vad+stt parallel: ${Date.now() - tBase}ms`);

    const listeningTimeoutMs = this.followUpTurn
      ? FOLLOW_UP_WINDOW_MS
      : MAX_LISTENING_DURATION_MS;
    this.listeningTimeout = setTimeout(() => {
      if (this.followUpTurn && !this.vadHadSpeech) {
        void this.closeFollowUpListening("timeout");
        return;
      }
      console.log("[VoicePerceiver] Listening safety timeout reached");
      voiceAcceptanceTrace.mark("safety-timeout");
      void this.finishListening();
    }, listeningTimeoutMs);
  }

  private async quiesceCaptureForSpeaking(reason: string): Promise<void> {
    const startedAt = Date.now();
    const feederWasRunning = kwsAudioFeeder.isRunning;

    // Classic stability deliberately does not attempt full-duplex voice barge-in.
    // Without reliable echo cancellation, local ASR mostly hears LOOI's own TTS
    // and creates false/empty turns. Keep the recorder warm for fast follow-up,
    // but do not feed wakeword/Whisper while the speaker is active. Tap-to-interrupt
    // remains available; true speech barge-in belongs to the Realtime experiment.
    await this.stopProcessingBargeIn("assistant-speaking-classic-no-barge-in");
    await wakewordService.setSpeakingBargeInMode(false);
    wakewordService.setNativeOnlyMode(false);
    kwsAudioFeeder.setWakewordFeedingEnabled(false);
    if (!kwsAudioFeeder.isRunning) {
      await kwsAudioFeeder.start().catch(() => undefined);
    }
    recordDiagnosticEvent("runtime", "speaking-capture-quiesced", {
      reason,
      feederWasRunning,
      feederRunning: kwsAudioFeeder.isRunning,
      captureKeptWarm: kwsAudioFeeder.isRunning,
      bargeInMode: "disabled-classic",
      durationMs: Date.now() - startedAt,
    });
  }

  private async armDrivingLocalCommandMode(): Promise<void> {
    // While a Driving Control Session is active (including the stationary window
    // after STOP), the microphone is a local physical-control channel. This
    // bypasses normal wake-word gating and never opens remote STT/LLM turns.
    kwsAudioFeeder.setWakewordFeedingEnabled(true);
    const voskReady = await wakewordService.prepareDrivingControl().catch(() => false);
    await wakewordService.start().catch(() => undefined);
    if (!kwsAudioFeeder.isRunning) {
      await kwsAudioFeeder.start().catch(() => undefined);
    }
    recordDiagnosticEvent("runtime", "driving-local-listener-ready", {
      feederRunning: kwsAudioFeeder.isRunning,
      motionActive: getLooiRobotRuntimeState().motionActive,
      sessionActive: wakewordService.isDrivingControlSessionActive,
      listeningLanguage: useUserStore.getState().preferences.listeningLanguage,
      voskReady,
    });
  }

  private async startFollowUpListening(): Promise<void> {
    const rearmStartedAt = Date.now();
    if (!this.isActive || this.isFinishingListening) return;

    // v2.1.61 mode-boundary only: if Settings changed to Realtime while a
    // Classic turn was finishing, do not arm another Classic follow-up. This
    // does not alter Classic capture/VAD/STT/TTS when Classic remains selected.
    if (isRealtimeConversationMode(useUserStore.getState().preferences.conversationMode)) {
      recordDiagnosticEvent("realtime", "classic-follow-up-skipped-for-mode-switch");
      await this.syncConversationMode();

      // If the user selected Realtime while a real Classic turn was still
      // finishing, Main-screen auto-listen may have correctly skipped as busy.
      // Once this Classic turn reaches its cleanup boundary, hand ownership to
      // Realtime if the face is actually focused. Schedule on the next tick so
      // the current Classic turn's finally/cleanup completes first.
      if (isMainScreenFocused() && !realtimeConversationService.isActive) {
        recordDiagnosticEvent("realtime", "classic-to-realtime-handoff-scheduled", {
          reason: "classic-turn-finished",
        });
        setTimeout(() => {
          if (
            !this.isActive ||
            !isMainScreenFocused() ||
            useUserStore.getState().robotSleeping ||
            !isRealtimeConversationMode(useUserStore.getState().preferences.conversationMode) ||
            realtimeConversationService.isActive
          ) return;

          const conversation = useConversationStore.getState();
          if (conversation.isListening || conversation.isProcessing || conversation.isSpeaking) {
            recordDiagnosticEvent("realtime", "classic-to-realtime-handoff-skipped", {
              reason: "conversation-still-busy",
              listening: conversation.isListening,
              processing: conversation.isProcessing,
              speaking: conversation.isSpeaking,
            });
            return;
          }

          recordDiagnosticEvent("realtime", "classic-to-realtime-handoff-start");
          void this.trigger().catch((error) => {
            recordDiagnosticEvent("realtime", "classic-to-realtime-handoff-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 0);
      }
      return;
    }

    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();
    if (conversationStore.isProcessing || conversationStore.isSpeaking) return;

    await this.stopProcessingBargeIn("follow-up-rearm");
    await wakewordService.setSpeakingBargeInMode(false);
    wakewordService.setNativeOnlyMode(false);
    kwsAudioFeeder.setWakewordFeedingEnabled(false);
    if (this.followUpPrewarmPromise) {
      await this.followUpPrewarmPromise.catch(() => undefined);
    }

    const prewarmedCapture = this.followUpCapturePrewarmed && kwsAudioFeeder.isRunning;
    this.followUpCapturePrewarmed = false;
    let stoppedNow = false;
    if (!prewarmedCapture && kwsAudioFeeder.isRunning) {
      // Fallback to the proven clean-restart path if prewarm was unavailable.
      recordDiagnosticEvent("runtime", "follow-up-capture-restart", {
        phase: "stopping",
      });
      await kwsAudioFeeder.stop().catch((error) => {
        console.warn("[VoicePerceiver] Failed to stop feeder before follow-up:", error);
      });
      stoppedNow = true;
    }
    await vadService.reset().catch(() => undefined);
    if (stoppedNow) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_UP_RESTART_SETTLE_MS));
    }
    recordDiagnosticEvent("runtime", "follow-up-capture-selected", {
      mode: prewarmedCapture ? "prewarmed" : "clean-restart",
      feederRunning: kwsAudioFeeder.isRunning,
    });

    if (!this.isActive || this.isFinishingListening) return;

    this.followUpTurn = true;
    recordDiagnosticEvent("runtime", "follow-up-arming", {
      windowMs: FOLLOW_UP_WINDOW_MS,
      freshCapture: !prewarmedCapture,
      prewarmedCapture,
    });

    const startPromise = this.startStreamingForListening();
    this.startListeningPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startListeningPromise === startPromise) {
        this.startListeningPromise = null;
      }
    }

    if (!this.followUpTurn || !this.unsubStreamingSamples) return;
    useUserStore.getState().setVoiceState("listening");
    useConversationStore.getState().setListening(true);
    useConversationStore.getState().setCurrentTranscript("");
    useConversationStore.getState().setStreamingText("");
    useConversationStore.getState().setOverlayVisible(true);
    recordDiagnosticEvent("runtime", "follow-up-ready", {
      windowMs: FOLLOW_UP_WINDOW_MS,
      feederRunning: kwsAudioFeeder.isRunning,
      freshCapture: !prewarmedCapture,
      prewarmedCapture,
      rearmDurationMs: Date.now() - rearmStartedAt,
    });
  }

  private async closeFollowUpListening(reason: "timeout" | "cancelled"): Promise<void> {
    if (!this.followUpTurn) return;
    this.followUpTurn = false;
    await this.stopListeningStreaming({ resetAsr: true });
    useConversationStore.getState().setListening(false);
    useConversationStore.getState().setProcessing(false);
    useConversationStore.getState().setSpeaking(false);
    useUserStore.getState().setVoiceState("sleeping");
    useConversationStore.getState().setOverlayVisible(false);
    recordDiagnosticEvent("runtime", "follow-up-closed", { reason });
    await this.restartWakewordFeederIfNeeded();
  }

  private async stopListeningStreaming(options: {
    resetAsr: boolean;
    keepFeederRunning?: boolean;
  }): Promise<void> {
    const stoppedGeneration = this.listeningGeneration;
    this.listeningGeneration += 1;
    if (this.listeningTimeout) {
      clearTimeout(this.listeningTimeout);
      this.listeningTimeout = null;
    }

    if (this.unsubStreamingSamples) {
      this.unsubStreamingSamples();
      this.unsubStreamingSamples = null;
      recordDiagnosticEvent("runtime", "listening-listener-detached", {
        generation: stoppedGeneration,
        keepFeederRunning: Boolean(options.keepFeederRunning),
      });
    }

    this.vadQueuedSamples = null;
    this.vadStartupSamples = [];
    this.clearVadEndpointTimer();
    await this.waitForSampleDrains();
    this.vadHadSpeech = false;
    this.vadSpeechStartedAtMs = null;
    kwsAudioFeeder.setWakewordFeedingEnabled(!options.keepFeederRunning);

    if (
      !options.keepFeederRunning &&
      kwsAudioFeeder.isRunning &&
      !this.shouldRunWakewordFeeder()
    ) {
      await kwsAudioFeeder.stop();
    }

    await vadService.reset().catch(() => undefined);
    if (options.resetAsr) {
      this.speechSamplesBuffer = [];
      this.commandSamplesBuffer = [];
      this.speechSampleRanges = [];
      this.pendingWakeSegmentSamples = [];
      this.wakeSegmentSamplesForSpeaker = [];
      this.pendingCommandPrerollSamples = [];
      this.pendingHasCommandSuffix = false;
      this.pendingWakeWasManual = false;
      this.inlineWakeCommand = false;
    }
  }

  private enqueueVadSamples(
    samples: number[],
    sampleRate: number,
    generation = this.listeningGeneration
  ): void {
    if (generation !== this.listeningGeneration) return;
    this.vadQueuedSamples = this.vadQueuedSamples ? this.vadQueuedSamples.concat(samples) : samples;
    if (!this.vadAccepting) {
      void this.drainVadSamples(sampleRate, generation);
    }
  }

  private async drainVadSamples(sampleRate: number, generation: number): Promise<void> {
    this.vadAccepting = true;

    try {
      while (
        generation === this.listeningGeneration &&
        this.unsubStreamingSamples &&
        this.vadQueuedSamples
      ) {
        const samples = this.vadQueuedSamples;
        this.vadQueuedSamples = null;
        const result = await vadService.acceptSamples(samples, sampleRate);
        if (generation !== this.listeningGeneration) {
          recordDiagnosticEvent("runtime", "stale-vad-result-skipped", { generation });
          return;
        }
        const completedSegmentCount = result.segments?.length ?? 0;
        if (result.isSpeechDetected) {
          if (this.vadEndpointTimer) {
            this.clearVadEndpointTimer();
            recordDiagnosticEvent("runtime", "vad-speech-resumed");
          }
          if (!this.vadHadSpeech) {
            this.vadSpeechStartedAtMs = Date.now();
            voiceAcceptanceTrace.mark("vad-speech", {
              segments: completedSegmentCount,
            });
            recordDiagnosticEvent("runtime", "vad-speech-start");
          }
          this.vadHadSpeech = true;
          continue;
        }
        if (completedSegmentCount > 0) {
          this.recordVadSpeechSegments(result.segments ?? [], sampleRate);
          if (!this.vadHadSpeech) {
            this.vadSpeechStartedAtMs = Date.now();
            voiceAcceptanceTrace.mark("vad-speech", {
              segments: completedSegmentCount,
            });
            recordDiagnosticEvent("runtime", "vad-speech-start");
          }
          this.vadHadSpeech = true;
          const utteranceDurationMs = this.vadSpeechStartedAtMs
            ? Date.now() - this.vadSpeechStartedAtMs
            : 0;
          if (utteranceDurationMs >= LONG_UTTERANCE_MIN_MS) {
            if (!this.vadEndpointTimer) {
              this.scheduleVadEndpointGrace(
                generation,
                completedSegmentCount,
                utteranceDurationMs
              );
            }
            continue;
          }
          console.log("[VoicePerceiver] VAD detected speech end");
          voiceAcceptanceTrace.mark("vad-end");
          recordDiagnosticEvent("runtime", "vad-speech-end", {
            completedSegments: completedSegmentCount,
            endpointMode: "immediate",
            utteranceDurationMs,
          });
          void this.finishListening();
          break;
        }
      }
    } catch (error) {
      console.warn("[VoicePerceiver] Failed to process VAD samples:", error);
    } finally {
      this.vadAccepting = false;
      if (
        generation === this.listeningGeneration &&
        this.unsubStreamingSamples &&
        this.vadQueuedSamples
      ) {
        void this.drainVadSamples(sampleRate, generation);
      }
    }
  }

  private scheduleVadEndpointGrace(
    generation: number,
    completedSegmentCount: number,
    utteranceDurationMs: number
  ): void {
    this.clearVadEndpointTimer();
    const graceMs = utteranceDurationMs >= VERY_LONG_UTTERANCE_MIN_MS
      ? VERY_LONG_UTTERANCE_ENDPOINT_GRACE_MS
      : LONG_UTTERANCE_ENDPOINT_GRACE_MS;
    recordDiagnosticEvent("runtime", "vad-endpoint-grace-start", {
      generation,
      graceMs,
      utteranceDurationMs,
    });
    this.vadEndpointTimer = setTimeout(() => {
      this.vadEndpointTimer = null;
      if (
        generation !== this.listeningGeneration ||
        !this.unsubStreamingSamples ||
        !this.isActive ||
        this.isFinishingListening
      ) {
        return;
      }
      console.log("[VoicePerceiver] VAD endpoint grace expired");
      voiceAcceptanceTrace.mark("vad-end");
      recordDiagnosticEvent("runtime", "vad-speech-end", {
        completedSegments: completedSegmentCount,
        endpointMode: "long-utterance-grace",
        utteranceDurationMs: Date.now() - (this.vadSpeechStartedAtMs ?? Date.now()),
      });
      void this.finishListening();
    }, graceMs);
  }

  private clearVadEndpointTimer(): void {
    if (!this.vadEndpointTimer) return;
    clearTimeout(this.vadEndpointTimer);
    this.vadEndpointTimer = null;
  }

  private recordVadSpeechSegments(
    segments: Array<{ startTime?: number; endTime?: number }>,
    sampleRate: number
  ): void {
    for (const segment of segments) {
      if (segment.startTime === undefined || segment.endTime === undefined) {
        continue;
      }
      const start = Math.max(0, Math.floor(segment.startTime * sampleRate));
      const end = Math.min(
        this.commandSamplesBuffer.length,
        Math.ceil(segment.endTime * sampleRate)
      );
      if (end <= start) continue;
      const previous = this.speechSampleRanges[this.speechSampleRanges.length - 1];
      if (previous && start <= previous.end + SPEAKER_SEGMENT_PADDING_SAMPLES) {
        previous.end = Math.max(previous.end, end);
      } else {
        this.speechSampleRanges.push({ start, end });
      }
    }
  }

  private getSpeakerVerificationSamples(): number[] {
    if (this.inlineWakeCommand) {
      return this.trimLowEnergyEdges(this.speechSamplesBuffer);
    }

    const commandSamples: number[] = [];
    if (this.speechSampleRanges.length === 0) {
      commandSamples.push(...this.trimLowEnergyEdges(this.commandSamplesBuffer));
    } else {
      for (const range of this.speechSampleRanges) {
        const start = Math.max(0, range.start - SPEAKER_SEGMENT_PADDING_SAMPLES);
        const end = Math.min(
          this.commandSamplesBuffer.length,
          range.end + SPEAKER_SEGMENT_PADDING_SAMPLES
        );
        commandSamples.push(...this.commandSamplesBuffer.slice(start, end));
      }
    }

    // A short command ("what time?") often does not contain enough stable voice
    // for Speaker ID by itself. The completed wake phrase is clean owner
    // speech from the same turn, so verify against wake + command together.
    const wakeSamples = this.trimLowEnergyEdges(this.wakeSegmentSamplesForSpeaker);
    return this.trimLowEnergyEdges([
      ...wakeSamples,
      ...(commandSamples.length > 0
        ? commandSamples
        : this.trimLowEnergyEdges(this.commandSamplesBuffer)),
    ]);
  }

  private trimLowEnergyEdges(samples: number[]): number[] {
    if (samples.length === 0) return samples;
    const threshold = 0.01;
    let start = 0;
    let end = samples.length;

    while (start < end && Math.abs(samples[start]) < threshold) {
      start += 1;
    }
    while (end > start && Math.abs(samples[end - 1]) < threshold) {
      end -= 1;
    }

    start = Math.max(0, start - SPEAKER_SEGMENT_PADDING_SAMPLES);
    end = Math.min(samples.length, end + SPEAKER_SEGMENT_PADDING_SAMPLES);
    return samples.slice(start, end);
  }

  private async startProcessingBargeIn(turnId: number): Promise<void> {
    if (
      !this.isActive ||
      !this.isFinishingListening ||
      this.activeTurnId !== turnId ||
      this.pendingManualRestart
    ) {
      return;
    }

    await this.stopProcessingBargeIn("replace");

    // Do not mistake the tail/reverb of the just-finished user utterance for a
    // brand-new interruption while remote STT/LLM is starting.
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_BARGE_IN_ARM_DELAY_MS));
    if (
      !this.isActive ||
      !this.isFinishingListening ||
      this.activeTurnId !== turnId ||
      this.pendingManualRestart
    ) {
      return;
    }

    const generation = ++this.processingBargeInGeneration;
    this.processingBargeInSamples = [];
    this.processingBargeInStartupSamples = [];
    this.processingBargeInQueuedSamples = null;
    this.processingBargeInVadReady = false;

    this.processingBargeInUnsub = kwsAudioFeeder.subscribeSamples((samples, sampleRate) => {
      if (generation !== this.processingBargeInGeneration) return;
      this.processingBargeInSamples.push(...samples);
      if (this.processingBargeInVadReady) {
        this.enqueueProcessingBargeInVadSamples(samples, sampleRate, turnId, generation);
      } else {
        this.processingBargeInStartupSamples.push(...samples);
      }
    });
    kwsAudioFeeder.setWakewordFeedingEnabled(false);

    if (!kwsAudioFeeder.isRunning) {
      await kwsAudioFeeder.start().catch((error) => {
        console.warn("[VoicePerceiver] Failed to keep feeder alive for processing barge-in:", error);
      });
    }

    await vadService.reset().catch(() => undefined);
    await vadService.start().catch((error) => {
      console.warn("[VoicePerceiver] Processing barge-in VAD unavailable:", error);
    });

    if (generation !== this.processingBargeInGeneration || !this.processingBargeInUnsub) {
      return;
    }

    this.processingBargeInVadReady = true;
    if (this.processingBargeInStartupSamples.length > 0) {
      const startupSamples = this.processingBargeInStartupSamples;
      this.processingBargeInStartupSamples = [];
      this.enqueueProcessingBargeInVadSamples(
        startupSamples,
        SPEAKER_SAMPLE_RATE,
        turnId,
        generation
      );
    }
    recordDiagnosticEvent("runtime", "processing-listener-attached", {
      turnId,
      generation,
      feederRunning: kwsAudioFeeder.isRunning,
    });
  }

  private enqueueProcessingBargeInVadSamples(
    samples: number[],
    sampleRate: number,
    turnId: number,
    generation: number
  ): void {
    if (generation !== this.processingBargeInGeneration) return;
    this.processingBargeInQueuedSamples = this.processingBargeInQueuedSamples
      ? this.processingBargeInQueuedSamples.concat(samples)
      : samples;
    if (!this.processingBargeInVadAccepting) {
      void this.drainProcessingBargeInVadSamples(sampleRate, turnId, generation);
    }
  }

  private async drainProcessingBargeInVadSamples(
    sampleRate: number,
    turnId: number,
    generation: number
  ): Promise<void> {
    this.processingBargeInVadAccepting = true;

    try {
      while (
        generation === this.processingBargeInGeneration &&
        this.processingBargeInUnsub &&
        this.processingBargeInQueuedSamples
      ) {
        const samples = this.processingBargeInQueuedSamples;
        this.processingBargeInQueuedSamples = null;
        const result = await vadService.acceptSamples(samples, sampleRate);
        const segments = result.segments ?? [];
        if (segments.length === 0) continue;

        const captured = this.extractProcessingBargeInSamples(segments, sampleRate);
        const assistantSpeaking = useConversationStore.getState().isSpeaking;
        const minimumDurationSec = assistantSpeaking ? 0.45 : PROCESSING_BARGE_IN_MIN_MS / 1000;
        if (captured.length < Math.round(sampleRate * minimumDurationSec)) {
          continue;
        }

        const unsubscribe = this.processingBargeInUnsub;
        this.processingBargeInUnsub = null;
        unsubscribe?.();
        this.processingBargeInQueuedSamples = null;
        this.processingBargeInVadReady = false;

        if (
          generation !== this.processingBargeInGeneration ||
          this.activeTurnId !== turnId ||
          this.pendingManualRestart
        ) {
          recordDiagnosticEvent("runtime", "processing-barge-in-stale", { turnId, generation });
          return;
        }

        this.pendingBargeInSamples = captured;
        recordDiagnosticEvent("runtime", assistantSpeaking ? "speaking-barge-in-detected" : "processing-barge-in-detected", {
          turnId,
          generation,
          durationMs: Math.round((captured.length / sampleRate) * 1000),
          assistantSpeaking,
        });
        this.turnAbortController?.abort();
        await ttsService.stop().catch(() => undefined);
        return;
      }
    } catch (error) {
      if (generation === this.processingBargeInGeneration) {
        console.warn("[VoicePerceiver] Processing barge-in VAD failed:", error);
        recordDiagnosticEvent("runtime", "processing-barge-in-error", {
          turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.processingBargeInVadAccepting = false;
      if (
        generation === this.processingBargeInGeneration &&
        this.processingBargeInUnsub &&
        this.processingBargeInQueuedSamples
      ) {
        void this.drainProcessingBargeInVadSamples(sampleRate, turnId, generation);
      }
    }
  }

  private extractProcessingBargeInSamples(
    segments: Array<{ startTime?: number; endTime?: number }>,
    sampleRate: number
  ): number[] {
    const validSegments = segments.filter(
      (segment) => segment.startTime !== undefined && segment.endTime !== undefined
    );
    if (validSegments.length === 0) {
      return this.trimLowEnergyEdges(this.processingBargeInSamples);
    }

    const first = validSegments[0];
    const last = validSegments[validSegments.length - 1];
    const padding = Math.round(sampleRate * 0.3);
    const start = Math.max(0, Math.floor((first.startTime ?? 0) * sampleRate) - padding);
    const end = Math.min(
      this.processingBargeInSamples.length,
      Math.ceil((last.endTime ?? 0) * sampleRate) + padding
    );
    if (end <= start) {
      return this.trimLowEnergyEdges(this.processingBargeInSamples);
    }
    return this.processingBargeInSamples.slice(start, end);
  }

  private async stopProcessingBargeIn(reason: string): Promise<void> {
    const hadListener = Boolean(this.processingBargeInUnsub);
    const hadRuntimeState =
      hadListener ||
      this.processingBargeInVadAccepting ||
      this.processingBargeInVadReady ||
      Boolean(this.processingBargeInQueuedSamples) ||
      this.processingBargeInStartupSamples.length > 0;
    if (!hadRuntimeState) return;

    const previousGeneration = this.processingBargeInGeneration;
    this.processingBargeInGeneration += 1;
    if (this.processingBargeInUnsub) {
      this.processingBargeInUnsub();
      this.processingBargeInUnsub = null;
    }
    this.processingBargeInQueuedSamples = null;
    this.processingBargeInStartupSamples = [];
    this.processingBargeInSamples = [];
    this.processingBargeInVadReady = false;

    for (let attempt = 0; attempt < 20 && this.processingBargeInVadAccepting; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await vadService.reset().catch(() => undefined);

    if (hadListener) {
      recordDiagnosticEvent("runtime", "processing-listener-detached", {
        reason,
        generation: previousGeneration,
      });
    }
  }

  private async startCapturedFollowUp(samples: number[]): Promise<void> {
    if (!this.isActive || this.pendingManualRestart || samples.length === 0) return;

    this.followUpTurn = true;
    this.speechSamplesBuffer = samples.slice();
    this.commandSamplesBuffer = samples.slice();
    this.speechSampleRanges = [];
    this.wakeSegmentSamplesForSpeaker = [];
    this.pendingWakeSegmentSamples = [];
    this.pendingCommandPrerollSamples = [];
    this.pendingHasCommandSuffix = false;
    this.inlineWakeCommand = false;

    const conversationStore = useConversationStore.getState();
    conversationStore.setListening(true);
    conversationStore.setProcessing(false);
    conversationStore.setSpeaking(false);
    conversationStore.setCurrentTranscript("");
    conversationStore.setStreamingText("");
    conversationStore.setOverlayVisible(true);
    useUserStore.getState().setVoiceState("listening");
    recordDiagnosticEvent("runtime", "processing-barge-in-promoted", {
      durationMs: Math.round((samples.length / SPEAKER_SAMPLE_RATE) * 1000),
    });

    await this.finishListening();
  }

  private queueSessionTurnPersistence(
    userText: string,
    assistantText: string,
    evidenceUri?: string
  ): void {
    const sessionId = useConversationStore.getState().activeSessionId;
    if (!sessionId) {
      recordDiagnosticEvent("runtime", "session-persistence-skipped", {
        reason: "no-active-session",
      });
      return;
    }

    const queuedAt = Date.now();
    const previous = this.sessionPersistenceChain;
    this.sessionPersistenceChain = previous.then(async () => {
      const startedAt = Date.now();
      recordDiagnosticEvent("runtime", "session-persistence-start", {
        queueDelayMs: startedAt - queuedAt,
      });
      mirrorSessionMessage(sessionId, { role: "user", content: userText });
      await this.withSessionPersistenceDeadline(
        sessionService.addMessage(sessionId, {
          role: "user",
          content: userText,
        }),
        "user"
      );
      mirrorSessionMessage(sessionId, { role: "assistant", content: assistantText, evidenceUri });
      await this.withSessionPersistenceDeadline(
        sessionService.addMessage(sessionId, {
          role: "assistant",
          content: assistantText,
          evidenceUri,
        }),
        "assistant"
      );
      recordDiagnosticEvent("runtime", "session-persistence-finished", {
        durationMs: Date.now() - startedAt,
      });
    }).catch((error) => {
      console.warn("[VoicePerceiver] Deferred session persistence failed:", error);
      recordDiagnosticEvent("runtime", "session-persistence-error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async withSessionPersistenceDeadline<T>(
    request: Promise<T>,
    role: "user" | "assistant"
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        request.then(() => undefined),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Session ${role} persistence timeout`));
          }, SESSION_PERSISTENCE_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async waitForSessionPersistence(turnId: number): Promise<void> {
    const pending = this.sessionPersistenceChain;
    const startedAt = Date.now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, SESSION_PERSISTENCE_BARRIER_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    recordDiagnosticEvent("runtime", "session-persistence-barrier", {
      turnId,
      durationMs,
      timedOut,
    });
  }

  private waitForCurrentTurnCompletion(): Promise<void> {
    if (!this.isFinishingListening) return Promise.resolve();
    return new Promise((resolve) => {
      this.turnCompletionWaiters.push(resolve);
    });
  }

  private notifyTurnCompletion(): void {
    const waiters = this.turnCompletionWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private throwIfTurnInterrupted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error("Voice turn interrupted");
    }
  }

  private async waitForSampleDrains(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!this.vadAccepting) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async waitForListeningStart(startListeningPromise: Promise<void>): Promise<boolean> {
    return Promise.race([
      startListeningPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), LISTENING_START_TIMEOUT_MS);
      }),
    ]);
  }

  private suppressClassicCaptureRearmWhileRealtime(reason: string): boolean {
    if (!realtimeConversationService.isActive) return false;

    // RealtimeConversationService is the only owner allowed to transition the
    // native recorder at this point. Generic Settings/navigation/runtime sync
    // paths must be side-effect free while WebRTC is active: stopping either
    // Classic wakeword or its recorder here can race Android's
    // WebRTC AudioRecord even when the Classic feeder already appears stopped.
    // The explicit Realtime start path releases Classic capture before
    // getUserMedia(), and these guards only prevent later re-arm attempts.
    recordDiagnosticEvent("realtime", "classic-capture-rearm-suppressed", {
      reason,
      feederWasRunning: kwsAudioFeeder.isRunning,
      feederRunning: kwsAudioFeeder.isRunning,
      realtimeActive: true,
      sideEffectFree: true,
    });
    return true;
  }

  private async startWakewordFeeder(): Promise<void> {
    if (this.suppressClassicCaptureRearmWhileRealtime("start-wakeword-feeder")) return;
    try {
      kwsAudioFeeder.setWakewordFeedingEnabled(true);
      await wakewordService.start();
      await kwsAudioFeeder.start();
    } catch (error) {
      console.warn("[VoicePerceiver] Wakeword audio feeder unavailable:", error);
    }
  }

  async rearmWakewordAfterNavigation(): Promise<void> {
    if (this.suppressClassicCaptureRearmWhileRealtime("navigation-rearm")) return;
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();
    if (
      !this.isActive ||
      userStore.robotSleeping ||
      conversationStore.isListening ||
      conversationStore.isProcessing ||
      conversationStore.isSpeaking ||
      this.isFinishingListening ||
      this.unsubStreamingSamples ||
      this.processingBargeInUnsub
    ) {
      await this.syncWakewordRuntime();
      return;
    }

    recordDiagnosticEvent("runtime", "wakeword-navigation-rearm-start");
    kwsAudioFeeder.setWakewordFeedingEnabled(false);
    await wakewordService.stop().catch(() => undefined);
    await kwsAudioFeeder.stop().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (this.shouldRunWakewordFeeder()) {
      await this.startWakewordFeeder();
    }
    recordDiagnosticEvent("runtime", "wakeword-navigation-rearm-finished", {
      feederRunning: kwsAudioFeeder.isRunning,
      wakewordListening: wakewordService.isListening,
    });
  }

  async syncConversationMode(): Promise<void> {
    const mode = useUserStore.getState().preferences.conversationMode;
    recordDiagnosticEvent("runtime", "conversation-mode-sync", { mode });

    // An already active WebRTC session exclusively owns Android communication
    // audio. Settings sync/navigation must never reinterpret its `listening`
    // UI state as an idle Classic listener and restart the Classic AudioRecord.
    if (this.suppressClassicCaptureRearmWhileRealtime("conversation-mode-sync")) return;

    // Switching Settings to Realtime must not leave the fresh-launch/passive
    // Classic listener owning the UI forever. Only release speech-free idle
    // listening; a real Classic turn is allowed to finish undisturbed.
    const conversationStore = useConversationStore.getState();
    const voiceState = useUserStore.getState().voiceState;
    const classicTurnActive =
      this.activeTurnId !== 0 || this.isFinishingListening || this.vadHadSpeech ||
      conversationStore.isProcessing || conversationStore.isSpeaking ||
      voiceState === "processing" || voiceState === "speaking" || voiceState === "verifying";
    if (!classicTurnActive && (conversationStore.isListening || voiceState === "listening" || voiceState === "attention" || this.startListeningPromise)) {
      this.cancelListeningAfterStart = true;
      if (this.startListeningPromise) await this.startListeningPromise.catch(() => undefined);
      await this.stopListeningStreaming({ resetAsr: true });
      this.cancelListeningAfterStart = false;
      conversationStore.setListening(false);
      conversationStore.setProcessing(false);
      conversationStore.setSpeaking(false);
      conversationStore.setOverlayVisible(false);
      useUserStore.getState().setVoiceState("sleeping");
      recordDiagnosticEvent("realtime", "classic-passive-listener-released");
    }
    await this.restartWakewordFeederIfNeeded();
  }

  async syncWakewordRuntime(): Promise<void> {
    if (this.suppressClassicCaptureRearmWhileRealtime("wakeword-runtime-sync")) return;

    if (
      this.isFinishingListening &&
      !this.turnAbortController &&
      !this.unsubStreamingSamples &&
      !this.processingBargeInUnsub
    ) {
      this.isFinishingListening = false;
      this.activeTurnId = 0;
      recordDiagnosticEvent("runtime", "wakeword-stale-finishing-reset");
    }

    if (this.shouldRunWakewordFeeder()) {
      await this.startWakewordFeeder();
      return;
    }

    const conversationStore = useConversationStore.getState();
    const preserveSharedFeeder =
      Boolean(this.unsubStreamingSamples) ||
      this.isFinishingListening ||
      Boolean(this.processingBargeInUnsub);

    if (preserveSharedFeeder) {
      kwsAudioFeeder.setWakewordFeedingEnabled(false);
      await wakewordService.stop().catch(() => undefined);
      recordDiagnosticEvent("runtime", "wakeword-sync-preserved-feeder", {
        isListening: conversationStore.isListening,
        isProcessing: conversationStore.isProcessing,
        isFinishingListening: this.isFinishingListening,
        streamingActive: Boolean(this.unsubStreamingSamples),
        processingListenerActive: Boolean(this.processingBargeInUnsub),
      });
      return;
    }

    await kwsAudioFeeder.stop().catch((error) => {
      console.warn("[VoicePerceiver] Failed to stop wakeword audio feeder:", error);
    });
    await wakewordService.stop().catch(() => undefined);
  }

  private async restartWakewordFeederIfNeeded(): Promise<void> {
    if (!this.shouldRunWakewordFeeder()) {
      return;
    }

    await this.startWakewordFeeder();
  }

  private shouldRunWakewordFeeder(): boolean {
    const userStore = useUserStore.getState();
    const conversationStore = useConversationStore.getState();

    const motionActive = getLooiRobotRuntimeState().motionActive;
    const drivingSessionActive = wakewordService.isDrivingControlSessionActive;
    return (
      this.isActive &&
      !realtimeConversationService.isActive &&
      (
        motionActive ||
        drivingSessionActive ||
        (this.allowsWakewordAutostart && userStore.preferences.wakeWordEnabled)
      ) &&
      userStore.voiceState === "sleeping" &&
      !conversationStore.isListening &&
      !conversationStore.isProcessing &&
      !this.startListeningPromise &&
      !this.isFinishingListening
    );
  }

}

export const voicePerceiver = new VoicePerceiver();
