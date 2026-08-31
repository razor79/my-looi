import { AppState, Platform } from "react-native";
import { setIsAudioActiveAsync } from "expo-audio";

import { createObservation } from "../core/observation";
import { markRobotInteraction } from "../core/robot-inactivity";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { localMemoryDatabase } from "../memory/local-memory-database";
import { mirrorSessionMessage, mirrorSessionTouch, retrieveConversationMemories } from "../memory/memory-service";
import {
  createOpenAiRealtimeClientSecret,
  createOpenAiRealtimeEphemeralWebSocket,
} from "../openai/openai-api-key";
import { useConversationStore } from "../store/conversation";
import { useUserStore } from "../store/user";
import {
  activateRealtimeSpeakerRoute,
  deactivateRealtimeSpeakerRoute,
  getRealtimeAudioRouteStatus,
} from "../../modules/realtime-audio-route";
import {
  getRealtimePcmAudioModule,
  type RealtimePcmAudioDataEvent,
  type RealtimePcmAudioStatus,
} from "../../modules/local-realtime-audio-capture/realtime-pcm";
import { kwsAudioFeeder } from "./kws-audio-feeder";
import {
  applyRealtimeUplinkGain,
  base64ToBytes,
  buildRealtimeSessionUpdate,
  bytesToBase64,
  floatSamplesToPcm16Bytes,
  REALTIME_MODEL,
  REALTIME_UPLINK_GAIN,
  resample16kTo24k,
} from "./realtime-config";
import { wakewordService, type WakewordDetection } from "./wakeword";
import {
  executeRealtimePhysicalCommand,
  parseRealtimePhysicalCommand,
  type RealtimePhysicalCommand,
} from "./realtime-physical-command";

const WS_OPEN_TIMEOUT_MS = 9_000;
const CAPTURE_RELEASE_SETTLE_MS = 220;
const COMMUNICATION_ROUTE_SETTLE_MS = 200;
const STARTUP_PREROLL_RECENT_MS = 900;
const UPLINK_LEVEL_WINDOW_MS = 500;

type RealtimeEvent = Record<string, any> & { type?: string };
type Subscription = { remove: () => void };

function makeSessionId(): string {
  return `realtime-pcm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function waitMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function pcm16Base64ToFloatSamples(base64: string): number[] {
  const bytes = base64ToBytes(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const samples = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}

export class RealtimePcmConversationService {
  private active = false;
  private stopping = false;
  private configured = false;
  private webSocket: WebSocket | null = null;
  private stopPromise: Promise<void> | null = null;
  private captureAudioSubscription: Subscription | null = null;
  private captureErrorSubscription: Subscription | null = null;
  private playbackDrainedSubscription: Subscription | null = null;
  private playbackErrorSubscription: Subscription | null = null;
  private sessionId: string | null = null;
  private assistantTranscript = "";
  private userTranscriptItems = new Set<string>();
  private handledToolCalls = new Set<string>();
  private toolCallsInFlight = 0;
  private localPhysicalCommandInFlight = false;
  private generationActive = false;
  private playbackActive = false;
  private playbackInterrupted = false;
  private assistantItemId: string | null = null;
  private assistantContentIndex = 0;
  private responseDone = false;
  private responseStatus = "unknown";
  private pendingPreroll: { samples: number[]; sampleRate: number } | null = null;
  private speakerRouteActive = false;
  private lastCaptureRmsLogAt = 0;
  private captureLevelWindowFrames = 0;
  private captureLevelWindowEnergy = 0;
  private captureLevelWindowMaxRms = 0;
  private captureLevelWindowChunks = 0;
  private captureLevelWindowGainClippedSamples = 0;
  private captureLevelWindowFirstSequence: number | null = null;
  private sessionMemoryContext: string | undefined;
  private sessionModel = REALTIME_MODEL;

  get isActive(): boolean {
    return this.active;
  }

  async start(detection?: WakewordDetection): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.active || this.stopping) return;
    if (Platform.OS !== "android") throw new Error("Realtime PCM experiment is Android-only");

    this.active = true;
    this.configured = false;
    this.generationActive = false;
    this.playbackActive = false;
    this.playbackInterrupted = false;
    this.assistantItemId = null;
    this.assistantContentIndex = 0;
    this.responseDone = false;
    this.responseStatus = "unknown";
    this.assistantTranscript = "";
    this.userTranscriptItems.clear();
    this.handledToolCalls.clear();
    this.toolCallsInFlight = 0;
    this.localPhysicalCommandInFlight = false;
    this.lastCaptureRmsLogAt = 0;
    this.captureLevelWindowFrames = 0;
    this.captureLevelWindowEnergy = 0;
    this.captureLevelWindowMaxRms = 0;
    this.captureLevelWindowChunks = 0;
    this.captureLevelWindowGainClippedSamples = 0;
    this.captureLevelWindowFirstSequence = null;
    this.sessionModel = useUserStore.getState().preferences.realtimeModelId;

    const store = useConversationStore.getState();
    store.setListening(true);
    store.setUserSpeaking(false);
    store.setProcessing(false);
    store.setSpeaking(false);
    store.setCurrentTranscript("");
    store.setStreamingText("");
    store.setOverlayVisible(true);
    store.setRealtimeReadiness("connecting");
    useUserStore.getState().setVoiceState("listening");

    recordDiagnosticEvent("realtime", "pcm-session-start", {
      transport: "openai-websocket-app-owned-pcm",
      model: this.sessionModel,
      source: detection?.source ?? "manual",
      captureRequested: "VOICE_COMMUNICATION/16000/mono/pcm16/explicit-platform-aec",
      playbackRequested: "USAGE_VOICE_COMMUNICATION/24000/mono/pcm16",
      explicitNoiseSuppressor: false,
    });

    try {
      if (AppState.currentState !== "active" || useUserStore.getState().robotSleeping) {
        throw new Error("Realtime PCM can start only while LOOI is active in the foreground");
      }

      const gateWasClosed = !kwsAudioFeeder.diagnosticStatus.appCaptureAllowed;
      await setIsAudioActiveAsync(true);
      kwsAudioFeeder.setAppCaptureAllowed(true);
      if (gateWasClosed) recordDiagnosticEvent("realtime", "foreground-audio-gate-recovered");

      const localSessionId = makeSessionId();
      this.sessionId = localSessionId;
      store.setActiveSession(localSessionId);
      mirrorSessionTouch(localSessionId, "realtime");

      const { facts: ambientMemories, strategy: memoryStrategy } = await retrieveConversationMemories("", { mode: "ambient" });
      if (!this.active) return;
      const memoryContext = ambientMemories
        .map((memory) => `- ${memory.memory.trim()}`)
        .filter((memory) => memory.length > 2)
        .join("\n");
      this.sessionMemoryContext = memoryContext || undefined;
      recordDiagnosticEvent("memory", "pcm-session-memory-preloaded", {
        strategy: memoryStrategy,
        facts: ambientMemories.length,
        chars: memoryContext.length,
      });

      const sessionUpdate = buildRealtimeSessionUpdate(
        useUserStore.getState().preferences,
        undefined,
        this.sessionMemoryContext
      );
      const sessionConfig = (sessionUpdate.session ?? {}) as Record<string, unknown>;
      const clientSecret = await createOpenAiRealtimeClientSecret(sessionConfig);
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "pcm-ephemeral-secret-created", {
        expiresAt: clientSecret.expiresAt,
        persisted: false,
      });

      // Preserve the proven v2.1.86 mic handoff guardrail. Quiesce the entire
      // wake/fallback path while Classic capture is still alive, then release
      // Classic before the app-owned VOICE_COMMUNICATION AudioRecord is made.
      kwsAudioFeeder.setWakewordFeedingEnabled(false);
      await wakewordService.stop();
      if (!this.active) return;
      await wakewordService.waitForFallbackIdle();
      if (!this.active) return;

      const detectionSamples = detection?.hasCommandSuffix && detection.commandPrerollSamples?.length
        ? detection.commandPrerollSamples.slice()
        : null;
      const recentSamples = detectionSamples ?? kwsAudioFeeder.getRecentSamples(STARTUP_PREROLL_RECENT_MS);
      this.pendingPreroll = recentSamples.length > 0
        ? { samples: recentSamples, sampleRate: detection?.sampleRate ?? 16_000 }
        : null;

      await kwsAudioFeeder.stop();
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "pcm-classic-capture-released", {
        feederRunning: kwsAudioFeeder.isRunning,
        wakewordListening: wakewordService.isListening,
      });

      await waitMs(CAPTURE_RELEASE_SETTLE_MS);
      if (!this.active) return;

      const beforeRoute = await getRealtimeAudioRouteStatus();
      if (beforeRoute.supported) {
        const prepared = await activateRealtimeSpeakerRoute();
        if (!this.active) return;
        this.speakerRouteActive = prepared.active && prepared.speakerSelected;
        if (!prepared.modeMatchesCommunication || !prepared.speakerSelected) {
          throw new Error("Realtime PCM could not establish Android communication speaker route");
        }
        await waitMs(COMMUNICATION_ROUTE_SETTLE_MS);
        const settled = await getRealtimeAudioRouteStatus();
        if (!settled.modeMatchesCommunication || !settled.speakerSelected) {
          throw new Error("Realtime PCM communication route did not remain stable before capture");
        }
      }

      this.bindNativeAudioEvents();

      const ws = createOpenAiRealtimeEphemeralWebSocket(clientSecret.value, this.sessionModel);
      this.webSocket = ws;
      this.bindWebSocket(ws);
      await this.waitForWebSocketOpen(ws);
      if (!this.active) return;
      this.send(sessionUpdate);
      recordDiagnosticEvent("realtime", "pcm-openai-connected", {
        transport: "websocket",
        auth: "ephemeral-subprotocol",
        model: this.sessionModel,
      });
    } catch (error) {
      recordDiagnosticEvent("realtime", "pcm-session-start-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.stop("start-failed");
      throw error;
    }
  }

  applySessionPreferences(source: string): void {
    if (!this.active || !this.webSocket) return;
    const preferences = useUserStore.getState().preferences;
    this.send(buildRealtimeSessionUpdate(preferences, undefined, this.sessionMemoryContext));
    recordDiagnosticEvent("realtime", "pcm-session-preferences-updated", {
      source,
      listeningLanguage: preferences.listeningLanguage,
      responseLanguage: preferences.language,
      voice: preferences.ttsVoiceId,
      speed: preferences.ttsSpeed,
    });
  }

  async interruptAndListen(source = "tap"): Promise<void> {
    if (!this.active) return;
    if (this.generationActive) this.send({ type: "response.cancel" });
    const playedDurationMs = this.stopAndTruncatePlayback(source);
    const store = useConversationStore.getState();
    store.setSpeaking(false);
    store.setProcessing(false);
    store.setUserSpeaking(false);
    store.setListening(true);
    store.setUserSpeaking(false);
    store.setStreamingText("");
    useUserStore.getState().setVoiceState("listening");
    recordDiagnosticEvent("realtime", "pcm-interaction-interrupt", {
      source,
      playedDurationMs,
      truncateSent: Boolean(this.assistantItemId),
    });
  }

  async stop(reason = "explicit"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.active && !this.webSocket) return;
    const promise = this.performStop(reason);
    this.stopPromise = promise;
    try {
      await promise;
    } finally {
      if (this.stopPromise === promise) this.stopPromise = null;
    }
  }

  private async performStop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.active = false;
    this.configured = false;
    this.generationActive = false;
    this.playbackActive = false;
    this.pendingPreroll = null;
    this.sessionMemoryContext = undefined;

    this.removeNativeAudioEvents();
    const audio = getRealtimePcmAudioModule();
    try { audio.stopPlayback(); } catch {}
    await audio.stopCapture().catch(() => undefined);

    const ws = this.webSocket;
    this.webSocket = null;
    if (ws) {
      try { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; } catch {}
      try { ws.close(); } catch {}
    }

    if (this.speakerRouteActive) {
      await deactivateRealtimeSpeakerRoute().catch(() => undefined);
      this.speakerRouteActive = false;
    }

    const canRestartClassic = AppState.currentState === "active" && !useUserStore.getState().robotSleeping;
    kwsAudioFeeder.setWakewordFeedingEnabled(true);
    if (canRestartClassic) {
      await wakewordService.start().catch((error) => {
        recordDiagnosticEvent("realtime", "pcm-classic-wakeword-restore-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await kwsAudioFeeder.start().catch((error) => {
        recordDiagnosticEvent("realtime", "pcm-classic-capture-restore-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const store = useConversationStore.getState();
    store.setListening(false);
    store.setUserSpeaking(false);
    store.setProcessing(false);
    store.setSpeaking(false);
    store.setRealtimeReadiness("idle");
    store.setOverlayVisible(false);
    useUserStore.getState().setVoiceState("sleeping");
    recordDiagnosticEvent("realtime", "pcm-session-stopped", {
      reason,
      classicRestored: canRestartClassic,
    });
    this.sessionId = null;
    this.stopping = false;
  }

  private bindNativeAudioEvents(): void {
    this.removeNativeAudioEvents();
    const audio = getRealtimePcmAudioModule();
    this.captureAudioSubscription = audio.addListener("onAudioData", (event: RealtimePcmAudioDataEvent) => {
      this.handleCapturedAudio(event);
    }) as Subscription;
    this.captureErrorSubscription = audio.addListener("onCaptureError", (event: { stage: string; message: string }) => {
      recordDiagnosticEvent("realtime", "pcm-capture-error", event);
      useConversationStore.getState().setRealtimeReadiness("microphone-error");
      void this.stop("capture-error");
    }) as Subscription;
    this.playbackDrainedSubscription = audio.addListener("onPlaybackDrained", (event: { playedDurationMs: number }) => {
      void this.handlePlaybackDrained(event.playedDurationMs);
    }) as Subscription;
    this.playbackErrorSubscription = audio.addListener("onPlaybackError", (event: { message: string }) => {
      recordDiagnosticEvent("realtime", "pcm-playback-error", event);
    }) as Subscription;
  }

  private removeNativeAudioEvents(): void {
    for (const subscription of [
      this.captureAudioSubscription,
      this.captureErrorSubscription,
      this.playbackDrainedSubscription,
      this.playbackErrorSubscription,
    ]) {
      try { subscription?.remove(); } catch {}
    }
    this.captureAudioSubscription = null;
    this.captureErrorSubscription = null;
    this.playbackDrainedSubscription = null;
    this.playbackErrorSubscription = null;
  }

  private handleCapturedAudio(event: RealtimePcmAudioDataEvent): void {
    if (!this.active || !this.configured || event.sampleRate !== 16_000 || !event.pcm16Base64) return;
    const samples = pcm16Base64ToFloatSamples(event.pcm16Base64);
    let gainClippedSamples = 0;
    for (const sample of samples) {
      if (Math.abs(sample) * REALTIME_UPLINK_GAIN > 1) gainClippedSamples += 1;
    }
    const gainedSamples = applyRealtimeUplinkGain(samples);
    const resampled = resample16kTo24k(gainedSamples);
    const audio = bytesToBase64(floatSamplesToPcm16Bytes(resampled));
    this.send({ type: "input_audio_buffer.append", audio });

    const frames = Number.isFinite(event.frames) && event.frames > 0 ? event.frames : 0;
    const rms = Number.isFinite(event.rms) && event.rms >= 0 ? event.rms : 0;
    if (this.captureLevelWindowFirstSequence === null) this.captureLevelWindowFirstSequence = event.sequence;
    this.captureLevelWindowFrames += frames;
    this.captureLevelWindowEnergy += rms * rms * frames;
    this.captureLevelWindowMaxRms = Math.max(this.captureLevelWindowMaxRms, rms);
    this.captureLevelWindowChunks += 1;
    this.captureLevelWindowGainClippedSamples += gainClippedSamples;

    const now = Date.now();
    if (this.lastCaptureRmsLogAt === 0) this.lastCaptureRmsLogAt = now;
    if (now - this.lastCaptureRmsLogAt >= UPLINK_LEVEL_WINDOW_MS) {
      const windowFrames = this.captureLevelWindowFrames;
      const windowRms = windowFrames > 0
        ? Math.sqrt(this.captureLevelWindowEnergy / windowFrames)
        : 0;
      recordDiagnosticEvent("realtime", "pcm-uplink-level", {
        rms,
        windowRms,
        maxChunkRms: this.captureLevelWindowMaxRms,
        uplinkGain: REALTIME_UPLINK_GAIN,
        gainClippedSamples: this.captureLevelWindowGainClippedSamples,
        windowMs: now - this.lastCaptureRmsLogAt,
        chunks: this.captureLevelWindowChunks,
        sourceRate: event.sampleRate,
        sourceFrames: event.frames,
        windowFrames,
        openAiRate: 24_000,
        firstSequence: this.captureLevelWindowFirstSequence,
        sequence: event.sequence,
      });
      this.lastCaptureRmsLogAt = now;
      this.captureLevelWindowFrames = 0;
      this.captureLevelWindowEnergy = 0;
      this.captureLevelWindowMaxRms = 0;
      this.captureLevelWindowChunks = 0;
      this.captureLevelWindowGainClippedSamples = 0;
      this.captureLevelWindowFirstSequence = null;
    }
  }

  private bindWebSocket(ws: WebSocket): void {
    ws.onmessage = (message) => {
      if (!this.active) return;
      try {
        const event = JSON.parse(String(message.data ?? "")) as RealtimeEvent;
        void this.handleEvent(event);
      } catch (error) {
        recordDiagnosticEvent("realtime", "pcm-ws-message-parse-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    ws.onerror = () => {
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "pcm-websocket-error");
    };
    ws.onclose = (event) => {
      if (!this.active || this.stopping) return;
      recordDiagnosticEvent("realtime", "pcm-websocket-closed", {
        code: event.code,
        reason: event.reason,
      });
      void this.stop("websocket-closed");
    };
  }

  private waitForWebSocketOpen(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`OpenAI Realtime PCM WebSocket did not open within ${WS_OPEN_TIMEOUT_MS}ms`)), WS_OPEN_TIMEOUT_MS);
      const previousOpen = ws.onopen;
      const previousError = ws.onerror;
      ws.onopen = (event) => {
        clearTimeout(timer);
        previousOpen?.call(ws, event);
        resolve();
      };
      ws.onerror = (event) => {
        clearTimeout(timer);
        previousError?.call(ws, event);
        reject(new Error("OpenAI Realtime PCM WebSocket failed to open"));
      };
    });
  }

  private async handleEvent(event: RealtimeEvent): Promise<void> {
    const type = String(event.type ?? "");
    if (type === "session.created") {
      recordDiagnosticEvent("realtime", "pcm-openai-session-created", {
        model: event.session?.model ?? this.sessionModel,
      });
      return;
    }
    if (type === "session.updated") {
      this.configured = true;
      const audio = getRealtimePcmAudioModule();
      let status: RealtimePcmAudioStatus;
      try {
        status = await audio.startCapture();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordDiagnosticEvent("realtime", "pcm-capture-start-failed", { error: message });
        useConversationStore.getState().setRealtimeReadiness("microphone-error");
        void this.stop("capture-start-failed");
        return;
      }
      if (!this.active) return;
      if (!status.aecEnabled || status.audioSource !== "VOICE_COMMUNICATION" || status.captureSampleRate !== 16_000) {
        recordDiagnosticEvent("realtime", "pcm-capture-profile-mismatch", {
          supported: status.supported,
          captureRunning: status.captureRunning,
          captureSampleRate: status.captureSampleRate,
          audioSource: status.audioSource,
          audioSessionId: status.audioSessionId,
          aecAvailable: status.aecAvailable,
          aecEnabled: status.aecEnabled,
          noiseSuppressorExplicit: status.noiseSuppressorExplicit,
          playbackRunning: status.playbackRunning,
          playbackSampleRate: status.playbackSampleRate,
        });
        void this.stop("capture-profile-mismatch");
        return;
      }
      const preroll = this.pendingPreroll;
      this.pendingPreroll = null;
      if (preroll && preroll.sampleRate === 16_000 && preroll.samples.length > 0) {
        const gainedPreroll = applyRealtimeUplinkGain(preroll.samples);
        const resampled = resample16kTo24k(gainedPreroll);
        this.send({ type: "input_audio_buffer.append", audio: bytesToBase64(floatSamplesToPcm16Bytes(resampled)) });
        recordDiagnosticEvent("realtime", "pcm-startup-preroll-seeded", {
          durationMs: Math.round((preroll.samples.length / preroll.sampleRate) * 1000),
          uplinkGain: REALTIME_UPLINK_GAIN,
        });
      }
      useConversationStore.getState().setRealtimeReadiness("ready");
      recordDiagnosticEvent("realtime", "pcm-readiness-ready", {
        barrier: "session-updated-plus-native-capture",
        captureSampleRate: status.captureSampleRate,
        playbackSampleRate: status.playbackSampleRate,
        audioSource: status.audioSource,
        audioSessionId: status.audioSessionId,
        aecEnabled: status.aecEnabled,
        explicitNoiseSuppressor: status.noiseSuppressorExplicit,
      });
      return;
    }
    if (type === "error") {
      recordDiagnosticEvent("realtime", "pcm-openai-error", {
        code: event.error?.code ?? "unknown",
        message: event.error?.message ?? "unknown",
      });
      return;
    }
    if (type === "response.created") {
      this.generationActive = true;
      this.responseDone = false;
      this.responseStatus = "unknown";
      this.playbackInterrupted = false;
      this.assistantTranscript = "";
      this.assistantItemId = null;
      this.assistantContentIndex = 0;
      if (this.localPhysicalCommandInFlight) {
        this.send({ type: "response.cancel" });
        recordDiagnosticEvent("realtime", "pcm-response-suppressed-for-physical-command");
        return;
      }
      try { getRealtimePcmAudioModule().beginPlayback(); } catch {}
      return;
    }
    if (type === "response.output_item.added") {
      const item = event.item;
      if (item?.type === "message" && item?.role === "assistant") {
        this.assistantItemId = String(item.id ?? "") || this.assistantItemId;
      }
      return;
    }
    if (type === "response.content_part.added") {
      const itemId = String(event.item_id ?? "").trim();
      if (itemId) this.assistantItemId = itemId;
      if (typeof event.content_index === "number") this.assistantContentIndex = event.content_index;
      return;
    }
    if (type === "response.output_audio.delta") {
      if (this.localPhysicalCommandInFlight) return;
      const delta = String(event.delta ?? "");
      if (!delta) return;
      const itemId = String(event.item_id ?? "").trim();
      if (itemId) this.assistantItemId = itemId;
      if (typeof event.content_index === "number") this.assistantContentIndex = event.content_index;
      if (!this.playbackActive) this.markPlaybackStarted();
      getRealtimePcmAudioModule().enqueuePlayback(delta);
      return;
    }
    if (type === "response.output_audio.done") {
      getRealtimePcmAudioModule().finishPlayback();
      return;
    }
    if (type === "response.output_audio_transcript.delta") {
      if (this.localPhysicalCommandInFlight) return;
      this.assistantTranscript += String(event.delta ?? "");
      useConversationStore.getState().setStreamingText(this.assistantTranscript);
      return;
    }
    if (type === "response.output_audio_transcript.done") {
      if (this.localPhysicalCommandInFlight) return;
      const transcript = String(event.transcript ?? "").trim();
      if (transcript) this.assistantTranscript = transcript;
      useConversationStore.getState().setStreamingText(this.assistantTranscript);
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      markRobotInteraction("realtime-pcm-speech-start");
      const duringOutput = this.playbackActive;
      if (duringOutput) {
        this.playbackInterrupted = true;
        const playedDurationMs = this.stopAndTruncatePlayback("server-vad");
        recordDiagnosticEvent("realtime", "pcm-voice-barge-in", {
          playedDurationMs,
          itemIdKnown: Boolean(this.assistantItemId),
          serverCancelsResponse: true,
        });
      }
      const store = useConversationStore.getState();
      if (duringOutput) store.setStreamingText("");
      store.setSpeaking(false);
      store.setProcessing(false);
      store.setListening(true);
      store.setUserSpeaking(true);
      useUserStore.getState().setVoiceState("listening");
      recordDiagnosticEvent("realtime", "pcm-speech-started", { duringOutput });
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      const store = useConversationStore.getState();
      store.setUserSpeaking(false);
      store.setListening(false);
      store.setProcessing(true);
      useUserStore.getState().setVoiceState("processing");
      recordDiagnosticEvent("realtime", "pcm-speech-stopped");
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(event.transcript ?? "").trim();
      const itemId = String(event.item_id ?? `unknown-${Date.now()}`);
      if (transcript && !this.userTranscriptItems.has(itemId)) {
        markRobotInteraction("realtime-pcm-transcript");
        this.userTranscriptItems.add(itemId);
        const store = useConversationStore.getState();
        store.setCurrentTranscript(transcript);
        store.addMessage({ role: "user", content: transcript });
        if (this.sessionId) mirrorSessionMessage(this.sessionId, { role: "user", content: transcript });
        recordDiagnosticEvent("realtime", "pcm-input-transcript", {
          length: transcript.length,
          recognizedText: transcript,
        });

        const physicalCommand = parseRealtimePhysicalCommand(transcript, useUserStore.getState().preferences);
        if (physicalCommand) {
          this.localPhysicalCommandInFlight = true;
          if (this.playbackActive) {
            this.playbackInterrupted = true;
            this.stopAndTruncatePlayback("local-physical-command");
          }
          if (this.generationActive) this.send({ type: "response.cancel" });
          store.setSpeaking(false);
          store.setListening(false);
          store.setProcessing(true);
          useUserStore.getState().setVoiceState("processing");
          void this.executeLocalPhysicalCommand(physicalCommand, transcript);
        }
      }
      return;
    }
    if (type === "response.output_item.done" && event.item?.type === "function_call") {
      void this.executeToolCall(event.item);
      return;
    }
    if (type === "response.done") {
      this.generationActive = false;
      this.responseDone = true;
      this.responseStatus = String(event.response?.status ?? "unknown");
      if (this.localPhysicalCommandInFlight) return;
      const hasFunctionCall = Array.isArray(event.response?.output) &&
        event.response.output.some((item: any) => item?.type === "function_call");
      if (hasFunctionCall || this.toolCallsInFlight > 0) return;
      if (!this.playbackActive) await this.finalizeAssistantTurn();
      return;
    }
  }

  private async executeLocalPhysicalCommand(physicalCommand: RealtimePhysicalCommand, transcript: string): Promise<void> {
    const result = await executeRealtimePhysicalCommand(physicalCommand, transcript);
    const store = useConversationStore.getState();
    if (result.acknowledgement) {
      store.addMessage({ role: "assistant", content: result.acknowledgement });
      if (this.sessionId) mirrorSessionMessage(this.sessionId, { role: "assistant", content: result.acknowledgement });
      store.setStreamingText(result.acknowledgement);
    }
    this.localPhysicalCommandInFlight = false;
    this.responseDone = false;
    this.responseStatus = "unknown";
    this.assistantTranscript = "";
    this.assistantItemId = null;
    this.assistantContentIndex = 0;
    store.setSpeaking(false);
    store.setProcessing(false);
    store.setUserSpeaking(false);
    store.setListening(this.active);
    useUserStore.getState().setVoiceState(this.active ? "listening" : "sleeping");
    recordDiagnosticEvent("realtime", "pcm-local-physical-command-finished", {
      commandKind: result.commandKind,
      ok: result.ok,
      sessionStillActive: this.active,
    });
  }

  private markPlaybackStarted(): void {
    this.playbackActive = true;
    const store = useConversationStore.getState();
    store.setUserSpeaking(false);
    store.setListening(false);
    store.setProcessing(false);
    store.setSpeaking(true);
    useUserStore.getState().setVoiceState("speaking");
    recordDiagnosticEvent("realtime", "pcm-output-start", {
      audioPath: "native-audiotrack-voice-communication",
      bargeInEnabled: true,
    });
  }

  private async handlePlaybackDrained(playedDurationMs: number): Promise<void> {
    if (!this.active || !this.playbackActive) return;
    this.playbackActive = false;
    recordDiagnosticEvent("realtime", "pcm-output-drained", {
      playedDurationMs,
      responseDone: this.responseDone,
      interrupted: this.playbackInterrupted,
    });
    if (this.responseDone) await this.finalizeAssistantTurn();
  }

  private async finalizeAssistantTurn(): Promise<void> {
    if (!this.active) return;
    const transcript = this.assistantTranscript.trim();
    if (!this.playbackInterrupted && transcript) {
      const store = useConversationStore.getState();
      store.addMessage({ role: "assistant", content: transcript });
      if (this.sessionId) mirrorSessionMessage(this.sessionId, { role: "assistant", content: transcript });
    }
    recordDiagnosticEvent("realtime", "pcm-response-finished", {
      transcriptLength: transcript.length,
      status: this.responseStatus,
      interrupted: this.playbackInterrupted,
    });
    const store = useConversationStore.getState();
    store.setSpeaking(false);
    store.setProcessing(false);
    store.setListening(true);
    store.setStreamingText("");
    useUserStore.getState().setVoiceState("listening");
    this.playbackInterrupted = false;
    this.responseDone = false;
    this.assistantItemId = null;
    this.assistantContentIndex = 0;
    this.assistantTranscript = "";
  }

  private stopAndTruncatePlayback(source: string): number {
    if (!this.playbackActive) return 0;
    let playedDurationMs = 0;
    try {
      playedDurationMs = Math.max(0, Number(getRealtimePcmAudioModule().stopPlayback().playedDurationMs) || 0);
    } catch {}
    this.playbackActive = false;
    if (this.assistantItemId) {
      this.send({
        type: "conversation.item.truncate",
        item_id: this.assistantItemId,
        content_index: this.assistantContentIndex,
        audio_end_ms: Math.round(playedDurationMs),
      });
    }
    recordDiagnosticEvent("realtime", "pcm-playback-truncated", {
      source,
      playedDurationMs,
      itemIdKnown: Boolean(this.assistantItemId),
      contentIndex: this.assistantContentIndex,
    });
    return playedDurationMs;
  }

  private async executeToolCall(item: any): Promise<void> {
    const callId = String(item.call_id ?? item.id ?? "");
    if (!callId || this.handledToolCalls.has(callId) || !this.active) return;
    this.handledToolCalls.add(callId);
    this.toolCallsInFlight += 1;
    const name = String(item.name ?? "");
    let output: Record<string, unknown>;
    try {
      const args = item.arguments ? JSON.parse(String(item.arguments)) : {};
      if (name === "search_memory") {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("query is required");
        const results = (await localMemoryDatabase.search(query)).slice(0, 6).map((result) => ({
          memory: result.memory,
          score: result.score,
          category: result.metadata?.category,
        }));
        output = { ok: true, results };
      } else if (name === "remember") {
        const note = String(args.note ?? "").trim();
        if (!note) throw new Error("note is required");
        await localMemoryDatabase.remember(
          [{ role: "user", content: note }],
          createObservation(note, "voice", "note").metadata
        );
        output = { ok: true, remembered: note };
      } else if (name === "set_language_preferences") {
        const responseLanguage = String(args.response_language ?? "").trim();
        if (responseLanguage !== "ru" && responseLanguage !== "uk" && responseLanguage !== "en") {
          throw new Error("response_language must be ru, uk, or en");
        }
        const requestedListeningLanguage = args.listening_language == null
          ? null
          : String(args.listening_language).trim();
        if (
          requestedListeningLanguage !== null &&
          requestedListeningLanguage !== "ru" &&
          requestedListeningLanguage !== "uk" &&
          requestedListeningLanguage !== "en"
        ) {
          throw new Error("listening_language must be ru, uk, or en when provided");
        }

        const before = useUserStore.getState().preferences;
        useUserStore.getState().updatePreferences({
          language: responseLanguage,
          ...(requestedListeningLanguage ? { listeningLanguage: requestedListeningLanguage } : {}),
        });
        const after = useUserStore.getState().preferences;
        this.applySessionPreferences("realtime-language-tool");
        if (before.language !== after.language) {
          recordDiagnosticEvent("runtime", "response-language-changed", {
            from: before.language,
            language: after.language,
            source: "realtime-tool",
          });
        }
        if (before.listeningLanguage !== after.listeningLanguage) {
          recordDiagnosticEvent("runtime", "listening-language-changed", {
            from: before.listeningLanguage,
            language: after.listeningLanguage,
            source: "realtime-tool",
          });
        }
        output = {
          ok: true,
          response_language: after.language,
          listening_language: after.listeningLanguage,
          next_reply_language: after.language === "en" ? "English" : after.language === "uk" ? "Ukrainian" : "Russian",
          instruction: "Acknowledge the change and continue in next_reply_language.",
          persistent: true,
        };
      } else {
        throw new Error(`Unsupported Realtime tool: ${name}`);
      }
      recordDiagnosticEvent("realtime", "pcm-tool-finished", { name, ok: true });
    } catch (error) {
      output = { ok: false, error: error instanceof Error ? error.message : String(error) };
      recordDiagnosticEvent("realtime", "pcm-tool-finished", { name, ok: false });
    } finally {
      this.toolCallsInFlight = Math.max(0, this.toolCallsInFlight - 1);
    }

    if (!this.active) return;
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    this.send({ type: "response.create" });
  }

  private send(event: Record<string, unknown>): void {
    const ws = this.webSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch (error) {
      recordDiagnosticEvent("realtime", "pcm-send-failed", {
        eventType: String(event.type ?? "unknown"),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const realtimePcmConversationService = new RealtimePcmConversationService();
