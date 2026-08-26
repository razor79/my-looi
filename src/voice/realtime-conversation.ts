import { AppState, Platform } from "react-native";
import { setIsAudioActiveAsync } from "expo-audio";
import { RTCPeerConnection, RTCSessionDescription, mediaDevices } from "react-native-webrtc";


import { createObservation } from "../core/observation";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import {
  createOpenAiRealtimeClientSecret,
  exchangeOpenAiRealtimeSdp,
} from "../openai/openai-api-key";
import { localMemoryDatabase } from "../memory/local-memory-database";
import { mirrorSessionMessage, mirrorSessionTouch } from "../memory/memory-service";
import { isMainScreenFocused } from "../core/main-screen-presence";
import { useConversationStore } from "../store/conversation";
import { isPcmRealtimeMode, useUserStore } from "../store/user";
import { kwsAudioFeeder } from "./kws-audio-feeder";
import {
  activateRealtimeSpeakerRoute,
  deactivateRealtimeSpeakerRoute,
  ensureRealtimeSpeakerRoute,
  getRealtimeAudioRouteStatus,
  type RealtimeAudioRouteStatus,
} from "../../modules/realtime-audio-route";
import { wakewordService, type WakewordDetection } from "./wakeword";
import {
  buildRealtimeSessionUpdate,
  bytesToBase64,
  floatSamplesToPcm16Bytes,
  REALTIME_MODEL,
  resample16kTo24k,
} from "./realtime-config";
import { realtimePcmConversationService } from "./realtime-pcm-conversation";

const DATA_CHANNEL_OPEN_TIMEOUT_MS = 9_000;
const STARTUP_PREROLL_RECENT_MS = 900;
const STARTUP_PREROLL_MAX_MS = 6_000;
const WEBRTC_CAPTURE_RELEASE_SETTLE_MS = 220;
const WEBRTC_COMMUNICATION_ROUTE_SETTLE_MS = 200;
const WEBRTC_MEDIA_TEARDOWN_SETTLE_MS = 250;
const VAD_HEALTH_MIN_SILENCE_MS = 12_000;
const VAD_HEALTH_PROBE_GRACE_MS = 5_000;
const VAD_HEALTH_PROBE_MAX_AGE_MS = 12_000;
const VAD_HEALTH_POST_PLAYBACK_GUARD_MS = 3_000;
const VAD_HEALTH_AUDIO_LEVEL = 0.004;
const VAD_HEALTH_ENERGY_DELTA = 0.001;
const VAD_HEALTH_VOICE_SAMPLES_REQUIRED = 2;
const VAD_HEALTH_POST_PROBE_VOICE_SAMPLES_REQUIRED = 2;
const BARGE_IN_ASSIST_ENABLED = false;
const BARGE_IN_ASSIST_POLL_MS = 300;
const BARGE_IN_ASSIST_AUDIO_LEVEL = 0.006;
const BARGE_IN_ASSIST_SAMPLES_REQUIRED = 2;
const BARGE_IN_ASSIST_MIN_PLAYBACK_AGE_MS = 450;
const BARGE_IN_ASSIST_MAX_MUTE_MS = 1_600;
const BARGE_IN_ASSIST_COOLDOWN_MS = 2_500;
const WEBRTC_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

type RealtimeEvent = Record<string, any> & { type?: string };
type LoosePeerConnection = RTCPeerConnection & Record<string, any>;
type LooseDataChannel = Record<string, any> & {
  readyState?: string;
  send?: (value: string) => void;
  close?: () => void;
};

function makeLocalRealtimeSessionId(): string {
  return `realtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeJsonParse(value: unknown): RealtimeEvent | null {
  try {
    const raw = typeof value === "string" ? value : String(value ?? "");
    return JSON.parse(raw) as RealtimeEvent;
  } catch {
    return null;
  }
}

function waitMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class RealtimeConversationService {
  private peerConnection: LoosePeerConnection | null = null;
  private dataChannel: LooseDataChannel | null = null;
  private localStream: any = null;
  private remoteTracks: any[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private bargeInAssistTimer: ReturnType<typeof setInterval> | null = null;
  private bargeInAssistRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private configured = false;
  private generationActive = false;
  private playbackActive = false;
  private playbackResponseId: string | null = null;
  private playbackTerminal: "stopped" | "cleared" | "interrupted" | null = null;
  private playbackInterrupted = false;
  private remotePlaybackMuted = false;
  private pendingAssistantCompletion: {
    transcript: string;
    status: string;
    totalTokens: number | null;
  } | null = null;
  private stopping = false;
  private sessionId: string | null = null;
  private assistantTranscript = "";
  private userTranscriptItems = new Set<string>();
  private handledToolCalls = new Set<string>();
  private toolCallsInFlight = 0;
  private pendingPreroll: { samples: number[]; sampleRate: number; source: "wake-command" | "startup" } | null = null;
  private startupPrerollSamples: number[] = [];
  private startupPrerollUnsubscribe: (() => void) | null = null;
  private lastOutputClearAt = 0;
  private lastOutputClearSource: "tap" | "wakeword" | null = null;
  private stopPromise: Promise<void> | null = null;
  private lastStopReason: string | null = null;
  private configuredAt = 0;
  private lastServerSpeechAt = 0;
  private lastStatsPacketsSent: number | null = null;
  private lastStatsTotalAudioEnergy: number | null = null;
  private vadHealthProbeSentAt = 0;
  private vadHealthProbeAcknowledgedAt = 0;
  private vadHealthSpeechBaseline = 0;
  private vadHealthRecoveryInFlight = false;
  private vadHealthRecoveryAttempts = 0;
  private vadHealthVoiceStreak = 0;
  private vadHealthPostProbeVoiceStreak = 0;
  private lastPlaybackEndedAt = 0;
  private playbackStartedAt = 0;
  private bargeInAssistVoiceStreak = 0;
  private bargeInAssistMuted = false;
  private bargeInAssistStatsInFlight = false;
  private lastBargeInAssistAt = 0;
  private lastWebRtcMediaTeardownAt = 0;
  private speakerRouteActive = false;
  private speakerRouteRestorePromise: Promise<void> | null = null;
  private sessionModel = REALTIME_MODEL;

  get isActive(): boolean {
    return this.active;
  }

  async start(detection?: WakewordDetection): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.speakerRouteRestorePromise) await this.speakerRouteRestorePromise;
    if (this.active || this.stopping) return;
    if (this.lastStopReason !== "vad-health-recovery") {
      this.vadHealthRecoveryAttempts = 0;
    }
    this.lastStopReason = null;
    this.active = true;
    this.configured = false;
    this.generationActive = false;
    this.playbackActive = false;
    this.playbackResponseId = null;
    this.playbackTerminal = null;
    this.playbackInterrupted = false;
    this.remotePlaybackMuted = false;
    this.pendingAssistantCompletion = null;
    this.assistantTranscript = "";
    this.userTranscriptItems.clear();
    this.handledToolCalls.clear();
    this.toolCallsInFlight = 0;
    this.remoteTracks = [];
    this.configuredAt = 0;
    this.lastServerSpeechAt = 0;
    this.lastStatsPacketsSent = null;
    this.lastStatsTotalAudioEnergy = null;
    this.vadHealthProbeSentAt = 0;
    this.vadHealthProbeAcknowledgedAt = 0;
    this.vadHealthSpeechBaseline = 0;
    this.vadHealthVoiceStreak = 0;
    this.vadHealthPostProbeVoiceStreak = 0;
    this.lastPlaybackEndedAt = 0;
    this.playbackStartedAt = 0;
    this.bargeInAssistVoiceStreak = 0;
    this.bargeInAssistMuted = false;
    this.bargeInAssistStatsInFlight = false;
    this.lastBargeInAssistAt = 0;
    this.speakerRouteActive = false;
    this.sessionModel = useUserStore.getState().preferences.realtimeModelId;
    this.pendingPreroll = detection?.hasCommandSuffix && detection.commandPrerollSamples?.length
      ? {
          samples: detection.commandPrerollSamples.slice(),
          sampleRate: detection.sampleRate ?? 16_000,
          source: "wake-command",
        }
      : null;

    const conversationStore = useConversationStore.getState();
    conversationStore.setListening(true);
    conversationStore.setProcessing(false);
    conversationStore.setSpeaking(false);
    conversationStore.setCurrentTranscript("");
    conversationStore.setStreamingText("");
    conversationStore.setOverlayVisible(true);
    conversationStore.setRealtimeReadiness("connecting");
    useUserStore.getState().setVoiceState("listening");

    // The main screen becomes visible before WebRTC/SDP/ICE are ready. Keep a
    // short one-shot copy of the untouched Classic PCM during that startup gap
    // so a user who speaks immediately is not silently discarded. Live audio
    // still switches to the native WebRTC track; this buffer is seeded once.
    if (!this.pendingPreroll) this.startStartupPrerollCapture();

    recordDiagnosticEvent("realtime", "session-start", {
      transport: "direct-openai-webrtc",
      model: this.sessionModel,
      source: detection?.source ?? "manual",
      hasCommandSuffix: detection?.hasCommandSuffix ?? false,
      inputMode: "webrtc-audio",
    });

    try {
      if (AppState.currentState !== "active" || useUserStore.getState().robotSleeping) {
        throw new Error("Realtime can start only while LOOI is active in the foreground");
      }

      // Realtime gets its own native WebRTC audio path. The Classic recorder is
      // deliberately not modified: we release it before getUserMedia(), then
      // restore the exact same feeder when Realtime ends.
      const gateWasClosed = !kwsAudioFeeder.diagnosticStatus.appCaptureAllowed;
      await setIsAudioActiveAsync(true);
      kwsAudioFeeder.setAppCaptureAllowed(true);
      if (gateWasClosed) {
        recordDiagnosticEvent("realtime", "foreground-audio-gate-recovered");
      }

      const localSessionId = makeLocalRealtimeSessionId();
      this.sessionId = localSessionId;
      conversationStore.setActiveSession(localSessionId);
      mirrorSessionTouch(localSessionId, "realtime");

      const sessionUpdate = buildRealtimeSessionUpdate(useUserStore.getState().preferences);
      const sessionConfig = (sessionUpdate.session ?? {}) as Record<string, unknown>;

      // BYOK: the owner's standard key stays in SecureStore. It is used only to
      // mint an ephemeral Realtime client secret; SDP then authenticates with
      // that short-lived secret. No intermediary application backend participates.
      const clientSecret = await createOpenAiRealtimeClientSecret(sessionConfig);
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "ephemeral-secret-created", {
        expiresAt: clientSecret.expiresAt,
        persisted: false,
      });

      // A repeated Settings -> Main test in 2.1.85 showed a selected-language
      // Whisper wake inference completing after Classic capture had already been
      // released and immediately before the second WebRTC AudioRecord was
      // created. Quiesce the COMPLETE local wake path while Classic capture is
      // still alive: first stop feeding new wake PCM, then invalidate/stop the
      // fallback and wait for any already-running inference to finish. Only
      // after that barrier do we freeze the startup preroll and release the
      // recorder. This keeps the WebRTC/AEC topology unchanged.
      const wakeQuiesceStartedAt = Date.now();
      recordDiagnosticEvent("realtime", "entry-wake-quiesce-start", {
        wakewordListening: wakewordService.isListening,
        feederRunning: kwsAudioFeeder.isRunning,
        pcmFlowing: kwsAudioFeeder.diagnosticStatus.pcmFlowing,
      });
      kwsAudioFeeder.setWakewordFeedingEnabled(false);
      await wakewordService.stop();
      if (!this.active) return;
      const fallbackIdleStartedAt = Date.now();
      await wakewordService.waitForFallbackIdle();
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "entry-wake-quiesce-finished", {
        durationMs: Date.now() - wakeQuiesceStartedAt,
        fallbackIdleWaitMs: Date.now() - fallbackIdleStartedAt,
        wakewordListening: wakewordService.isListening,
        feederRunning: kwsAudioFeeder.isRunning,
        pcmFlowing: kwsAudioFeeder.diagnosticStatus.pcmFlowing,
      });

      this.finalizeStartupPrerollCapture();
      await kwsAudioFeeder.stop();
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "classic-capture-released", {
        feederRunning: kwsAudioFeeder.isRunning,
        wakewordListening: wakewordService.isListening,
      });

      // AudioRecord/WebRTC share native capture resources on Android. Device
      // logs showed that a second WebRTC session could report a live track and
      // send RTP while carrying an abnormally weak signal. Give the previous
      // Classic capture a short, deterministic release barrier before asking
      // WebRTC to acquire the microphone again.
      await waitMs(WEBRTC_CAPTURE_RELEASE_SETTLE_MS);
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "webrtc-capture-acquire-settled", {
        delayMs: WEBRTC_CAPTURE_RELEASE_SETTLE_MS,
        feederRunning: kwsAudioFeeder.isRunning,
      });

      // Do not park stop() behind a JavaScript timer while Android may already
      // be backgrounding the app. Native tracks/PC are closed synchronously in
      // performStop(); any remaining ADM settle time is paid here, immediately
      // before the next getUserMedia() acquisition.
      if (this.lastWebRtcMediaTeardownAt > 0) {
        const elapsedMs = Math.max(0, Date.now() - this.lastWebRtcMediaTeardownAt);
        const remainingMs = Math.max(0, WEBRTC_MEDIA_TEARDOWN_SETTLE_MS - elapsedMs);
        if (remainingMs > 0) await waitMs(remainingMs);
        if (!this.active) return;
        recordDiagnosticEvent("realtime", "webrtc-media-teardown-settle-before-start", {
          elapsedBeforeWaitMs: elapsedMs,
          waitedMs: remainingMs,
          requiredMs: WEBRTC_MEDIA_TEARDOWN_SETTLE_MS,
        });
      }

      // v2.1.82 A/B: establish the COMPLETE Android communication topology
      // before WebRTC creates its AudioRecord/capture path. Both
      // MODE_IN_COMMUNICATION and the built-in speaker are selected first,
      // then left untouched while PeerConnection/getUserMedia creates the
      // default react-native-webrtc VOICE_COMMUNICATION + AEC/NS path.
      // This is the last routing-order A/B before instrumenting actual AEC.
      if (Platform.OS === "android") {
        const beforeRoute = await getRealtimeAudioRouteStatus();
        if (!this.active) return;
        this.recordAudioRoute("before-activation", beforeRoute, "before-get-user-media");

        if (beforeRoute.supported) {
          const preparedRoute = await activateRealtimeSpeakerRoute();
          if (!this.active) return;
          this.speakerRouteActive = preparedRoute.active && preparedRoute.speakerSelected;
          this.recordAudioRoute("activated", preparedRoute, "before-get-user-media");
          if (!preparedRoute.modeMatchesCommunication || !preparedRoute.speakerSelected) {
            throw new Error(
              "Android communication mode + built-in speaker were not established before WebRTC capture"
            );
          }

          await waitMs(WEBRTC_COMMUNICATION_ROUTE_SETTLE_MS);
          if (!this.active) return;
          const settledRoute = await getRealtimeAudioRouteStatus();
          if (!this.active) return;
          this.speakerRouteActive = settledRoute.active && settledRoute.speakerSelected;
          this.recordAudioRoute("verified", settledRoute, "before-get-user-media-settled");
          recordDiagnosticEvent("realtime", "webrtc-communication-speaker-route-settled", {
            delayMs: WEBRTC_COMMUNICATION_ROUTE_SETTLE_MS,
            mode: settledRoute.modeName,
            speakerSelected: settledRoute.speakerSelected,
            communicationDeviceType:
              settledRoute.communicationDeviceTypeName ?? settledRoute.communicationDeviceType ?? null,
          });
          if (!settledRoute.modeMatchesCommunication || !settledRoute.speakerSelected) {
            throw new Error(
              "Android communication route did not remain stable before WebRTC capture"
            );
          }
        } else {
          recordDiagnosticEvent("realtime", "webrtc-pre-capture-speaker-route-unsupported", {
            sdkInt: beforeRoute.sdkInt,
            fallback: "default-webrtc-communication-route",
          });
        }
      }

      const peerConnection = new RTCPeerConnection({}) as LoosePeerConnection;
      this.peerConnection = peerConnection;
      this.bindPeerConnection(peerConnection);

      const localStream = await mediaDevices.getUserMedia({
        audio: WEBRTC_AUDIO_CONSTRAINTS as any,
        video: false,
      });
      if (!this.active) {
        for (const track of localStream.getTracks()) track.stop();
        return;
      }
      this.localStream = localStream;
      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length === 0) throw new Error("WebRTC microphone returned no audio track");
      for (const track of audioTracks) {
        track.enabled = true;
        peerConnection.addTrack(track, localStream);
      }
      recordDiagnosticEvent("realtime", "webrtc-local-audio-ready", {
        audioTracks: audioTracks.length,
        echoCancellationRequested: true,
        noiseSuppressionRequested: true,
        autoGainControlRequested: true,
      });
      recordDiagnosticEvent("realtime", "webrtc-audio-device-config", {
        outputUsage: "VOICE_COMMUNICATION(default)",
        contentType: "SPEECH(default)",
        routeOwner: "react-native-webrtc-default-audio-device-module",
        androidAudioSource: "VOICE_COMMUNICATION(default)",
        customAudioDeviceModule: false,
        hardwareAcousticEchoCancelerOverride: "default",
        hardwareNoiseSuppressorOverride: "default",
        echoCancellationRequested: true,
        localBargeInAssistEnabled: BARGE_IN_ASSIST_ENABLED,
        outputRouteExperiment: "communication-mode-plus-built-in-speaker-before-capture",
      });

      // v2.1.82 intentionally performs no route mutation here. Read the route
      // back after capture creation to prove WebRTC did not silently replace
      // the pre-selected communication speaker while its AudioRecord/AEC path
      // was being created. A supported Android route drift fails this A/B
      // rather than repairing the route after capture and changing topology.
      if (Platform.OS === "android") {
        const postCaptureRoute = await getRealtimeAudioRouteStatus();
        if (!this.active) return;
        this.recordAudioRoute("verified", postCaptureRoute, "local-audio-ready-read-only");
        if (
          postCaptureRoute.supported &&
          (!postCaptureRoute.modeMatchesCommunication || !postCaptureRoute.speakerSelected)
        ) {
          throw new Error(
            "Android communication speaker route changed while WebRTC capture was created"
          );
        }
      }

      const dataChannel = peerConnection.createDataChannel("oai-events") as unknown as LooseDataChannel;
      this.dataChannel = dataChannel;
      this.bindDataChannel(dataChannel);

      const offer = await peerConnection.createOffer();
      const offerSdp = String(offer.sdp ?? "");
      recordDiagnosticEvent("realtime", "webrtc-offer-created", {
        sdpLength: offerSdp.length,
      });
      await peerConnection.setLocalDescription(offer);
      recordDiagnosticEvent("realtime", "webrtc-local-description-set", {
        signalingState: String(peerConnection.signalingState ?? "unknown"),
      });

      // Match the OpenAI WebRTC flow exactly: POST the SDP generated by
      // createOffer(), preserve the returned SDP byte-for-byte, and wrap the
      // answer in react-native-webrtc's native RTCSessionDescription object.
      const answerSdp = await exchangeOpenAiRealtimeSdp(clientSecret.value, offerSdp);
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "webrtc-answer-received", {
        sdpLength: answerSdp.length,
        endsWithCrLf: answerSdp.endsWith("\r\n"),
        endsWithLf: answerSdp.endsWith("\n"),
      });
      const remoteAnswer = new RTCSessionDescription({ type: "answer", sdp: answerSdp });
      await peerConnection.setRemoteDescription(remoteAnswer);
      recordDiagnosticEvent("realtime", "webrtc-remote-description-set", {
        signalingState: String(peerConnection.signalingState ?? "unknown"),
      });

      await this.waitForDataChannelOpen(dataChannel);
      if (!this.active) return;
      await this.ensureSpeakerRoute("data-channel-open");
      if (!this.active) return;

      // The client secret was minted with this configuration already. Updating
      // once more after the data channel opens gives us an explicit
      // session.updated barrier before seeding any captured wake-command tail.
      this.send(sessionUpdate);
      recordDiagnosticEvent("realtime", "openai-connected", {
        transport: "direct-openai-webrtc",
        model: this.sessionModel,
        audioPath: "native-webrtc-default-communication-adm",
        inputMode: "webrtc-audio",
      });
      this.startWebRtcAudioStats();
    } catch (error) {
      recordDiagnosticEvent("realtime", "session-start-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.stop("start-failed");
      throw error;
    }
  }

  applySessionPreferences(source: string): void {
    if (!this.active) return;
    const preferences = useUserStore.getState().preferences;
    this.send(buildRealtimeSessionUpdate(preferences));
    recordDiagnosticEvent("realtime", "webrtc-session-preferences-updated", {
      source,
      listeningLanguage: preferences.listeningLanguage,
      responseLanguage: preferences.language,
      voice: preferences.ttsVoiceId,
      speed: preferences.ttsSpeed,
    });
  }

  async interruptAndListen(source = "tap"): Promise<void> {
    if (!this.active) return;
    recordDiagnosticEvent("realtime", "interaction-interrupt", {
      source,
      transport: "webrtc",
    });
    if (this.generationActive) this.send({ type: "response.cancel" });
    if (this.playbackActive) this.setRemotePlaybackMuted(true, "tap-interrupt");
    // In WebRTC OpenAI owns the remote output buffer. Clearing it is the native
    // way to stop unplayed model audio and truncate the conversation at the
    // interruption point; there is no local WAV/PCM player to tear down.
    this.send({ type: "output_audio_buffer.clear" });
    this.lastOutputClearAt = Date.now();
    this.lastOutputClearSource = source === "wakeword" ? "wakeword" : "tap";
    this.playbackActive = false;
    this.playbackTerminal = "cleared";
    const store = useConversationStore.getState();
    store.setSpeaking(false);
    store.setProcessing(false);
    store.setListening(true);
    store.setStreamingText("");
    useUserStore.getState().setVoiceState("listening");
  }

  async stop(reason = "explicit"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.active && !this.peerConnection && !this.dataChannel) return;
    const stopPromise = this.performStop(reason);
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }
  }

  private async performStop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.lastStopReason = reason;
    this.active = false;
    this.configured = false;
    this.generationActive = false;
    this.playbackActive = false;
    this.playbackResponseId = null;
    this.playbackTerminal = null;
    this.playbackInterrupted = false;
    this.pendingAssistantCompletion = null;
    this.pendingPreroll = null;
    this.stopStartupPrerollCapture();
    this.lastOutputClearAt = 0;
    this.lastOutputClearSource = null;
    this.clearWebRtcAudioStats();
    this.stopBargeInAssistMonitor("session-stop");
    recordDiagnosticEvent("realtime", "webrtc-media-teardown-start", {
      reason,
      localTracks: this.localStream?.getTracks?.()?.length ?? 0,
      remoteTracks: this.remoteTracks.length,
      hasPeerConnection: Boolean(this.peerConnection),
      hasDataChannel: Boolean(this.dataChannel),
    });

    const dataChannel = this.dataChannel;
    this.dataChannel = null;
    if (dataChannel) {
      try { dataChannel.onopen = null; } catch {}
      try { dataChannel.onmessage = null; } catch {}
      try { dataChannel.onerror = null; } catch {}
      try { dataChannel.onclose = null; } catch {}
      try { dataChannel.close?.(); } catch {}
    }

    const localStream = this.localStream;
    this.localStream = null;
    if (localStream) {
      try {
        for (const track of localStream.getTracks()) track.stop();
      } catch {}
    }
    for (const track of this.remoteTracks.splice(0)) {
      try { track.stop?.(); } catch {}
    }
    this.remotePlaybackMuted = false;

    const peerConnection = this.peerConnection;
    this.peerConnection = null;
    if (peerConnection) {
      try { peerConnection.ontrack = null; } catch {}
      try { peerConnection.onconnectionstatechange = null; } catch {}
      try { peerConnection.oniceconnectionstatechange = null; } catch {}
      try { peerConnection.close(); } catch {}
    }

    // Native media resources are already closed above. Record that instant and
    // defer the small ADM settle barrier to the next Realtime start. Waiting
    // here is unsafe because Android can freeze JS timers as the app enters the
    // background, making stop() appear hung for minutes even though native
    // tracks were already stopped.
    this.lastWebRtcMediaTeardownAt = Date.now();
    recordDiagnosticEvent("realtime", "webrtc-media-teardown-finished", {
      reason,
      waitedMs: 0,
      settleDeferredToNextStart: true,
      settleRequiredMs: WEBRTC_MEDIA_TEARDOWN_SETTLE_MS,
    });

    // Restore only the communication-device selection. Never let this native
    // housekeeping operation reintroduce the old background stop hang: Settings
    // navigation (foreground) waits before Classic returns; background/deep
    // sleep lets the restore finish asynchronously and the next Realtime start
    // waits for it before acquiring media again.
    const routeRestorePromise = this.beginSpeakerRouteRestore(reason);
    const canRestartClassic = AppState.currentState === "active" && !useUserStore.getState().robotSleeping;
    if (canRestartClassic) {
      await routeRestorePromise;
    } else {
      recordDiagnosticEvent("realtime", "audio-route-restore-deferred", { reason });
    }

    // Re-arm the untouched Classic capture only when the normal foreground
    // lifecycle permits microphone ownership. Background/deep sleep keeps the
    // existing hard-off semantics.
    kwsAudioFeeder.setWakewordFeedingEnabled(true);
    if (canRestartClassic) {
      await wakewordService.start().catch((error) => {
        recordDiagnosticEvent("realtime", "classic-wakeword-restore-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await kwsAudioFeeder.start().catch((error) => {
        recordDiagnosticEvent("realtime", "classic-capture-restore-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      recordDiagnosticEvent("realtime", "classic-capture-restored", {
        feederRunning: kwsAudioFeeder.isRunning,
        wakewordListening: wakewordService.isListening,
      });
      void this.recordAndroidAudioDiagnosticSnapshot("classic-capture-restored");
    }

    const store = useConversationStore.getState();
    store.setListening(false);
    store.setProcessing(false);
    store.setSpeaking(false);
    store.setRealtimeReadiness("idle");
    store.setOverlayVisible(false);
    useUserStore.getState().setVoiceState("sleeping");
    recordDiagnosticEvent("realtime", "session-stopped", {
      reason,
      transport: "webrtc",
      inputMode: "webrtc-audio",
    });
    this.stopping = false;
  }

  private recordAudioRoute(
    event: "prepared-before-capture" | "before-activation" | "activated" | "verified" | "restored",
    status: RealtimeAudioRouteStatus,
    reason: string
  ): void {
    recordDiagnosticEvent("realtime", `audio-route-${event}`, {
      reason,
      supported: status.supported,
      active: status.active,
      sdkInt: status.sdkInt,
      mode: status.modeName,
      modeRaw: status.mode,
      modeMatchesCommunication: status.modeMatchesCommunication,
      modeChangedByModule: status.modeChangedByModule,
      modeBeforeActivation: status.modeBeforeActivationName ?? status.modeBeforeActivation ?? null,
      modeRestoreApplied: status.modeRestoreApplied ?? null,
      routeStrategy: status.routeStrategy,
      routeRequestAccepted: status.routeRequestAccepted ?? null,
      speakerSelected: status.speakerSelected,
      speakerphoneOn: status.speakerphoneOn,
      communicationDeviceType: status.communicationDeviceTypeName ?? status.communicationDeviceType ?? null,
      communicationDeviceName: status.communicationDeviceName ?? null,
      speakerDeviceAvailable: status.speakerDeviceAvailable,
      availableCommunicationDeviceTypes: status.availableCommunicationDeviceTypes,
      routeOwnershipMismatch: status.routeOwnershipMismatch,
      activeRouteMismatch: status.activeRouteMismatch,
      deviceMutationSequence: status.deviceMutationSequence,
      lastDeviceMutation: status.lastDeviceMutation ?? null,
      lastDeviceMutationAtMs: status.lastDeviceMutationAtMs ?? null,
      lastDeviceBeforeMutation: status.lastDeviceBeforeMutationName ?? status.lastDeviceBeforeMutation ?? null,
      lastDeviceAfterMutation: status.lastDeviceAfterMutationName ?? status.lastDeviceAfterMutation ?? null,
      modeMutationSequence: status.modeMutationSequence,
      lastModeMutation: status.lastModeMutation ?? null,
      lastModeMutationAtMs: status.lastModeMutationAtMs ?? null,
      lastModeBeforeMutation: status.lastModeBeforeMutationName ?? status.lastModeBeforeMutation ?? null,
      lastModeAfterMutation: status.lastModeAfterMutationName ?? status.lastModeAfterMutation ?? null,
      activeRecordingCount: status.activeRecordingCount,
      voiceCommunicationRecordingCount: status.voiceCommunicationRecordingCount,
      recordingConfigSummary: status.recordingConfigSummary,
      primaryRecordingSessionId: status.primaryRecordingSessionId ?? null,
      primaryClientAudioSource: status.primaryClientAudioSourceName ?? status.primaryClientAudioSource ?? null,
      primaryAudioSource: status.primaryAudioSourceName ?? status.primaryAudioSource ?? null,
      primaryInputDevice: status.primaryInputDeviceTypeName ?? status.primaryInputDeviceType ?? null,
      primaryInputDeviceName: status.primaryInputDeviceName ?? null,
      primaryClientSilenced: status.primaryClientSilenced ?? null,
      primaryClientFormat: status.primaryClientFormat ?? null,
      primaryDeviceFormat: status.primaryDeviceFormat ?? null,
      primaryClientEffects: status.primaryClientEffects,
      primaryStreamEffects: status.primaryStreamEffects,
      primaryClientHasAec: status.primaryClientHasAec,
      primaryStreamHasAec: status.primaryStreamHasAec,
      primaryClientHasNs: status.primaryClientHasNs,
      primaryStreamHasNs: status.primaryStreamHasNs,
      primaryClientHasAgc: status.primaryClientHasAgc,
      primaryStreamHasAgc: status.primaryStreamHasAgc,
      platformAecAvailable: status.platformAecAvailable,
      platformNsAvailable: status.platformNsAvailable,
      platformAgcAvailable: status.platformAgcAvailable,
      platformPreprocessorCatalog: status.platformPreprocessorCatalog,
    });
  }

  private async recordAndroidAudioDiagnosticSnapshot(reason: string): Promise<void> {
    if (Platform.OS !== "android") return;
    try {
      const status = await getRealtimeAudioRouteStatus();
      recordDiagnosticEvent("realtime", "android-audio-capture-diagnostics", {
        reason,
        active: status.active,
        mode: status.modeName,
        speakerSelected: status.speakerSelected,
        communicationDeviceType: status.communicationDeviceTypeName ?? status.communicationDeviceType ?? null,
        routeOwnershipMismatch: status.routeOwnershipMismatch,
        activeRouteMismatch: status.activeRouteMismatch,
        deviceMutationSequence: status.deviceMutationSequence,
        lastDeviceMutation: status.lastDeviceMutation ?? null,
        lastDeviceMutationAtMs: status.lastDeviceMutationAtMs ?? null,
        lastDeviceBeforeMutation: status.lastDeviceBeforeMutationName ?? status.lastDeviceBeforeMutation ?? null,
        lastDeviceAfterMutation: status.lastDeviceAfterMutationName ?? status.lastDeviceAfterMutation ?? null,
        modeMutationSequence: status.modeMutationSequence,
        lastModeMutation: status.lastModeMutation ?? null,
        lastModeBeforeMutation: status.lastModeBeforeMutationName ?? status.lastModeBeforeMutation ?? null,
        lastModeAfterMutation: status.lastModeAfterMutationName ?? status.lastModeAfterMutation ?? null,
        activeRecordingCount: status.activeRecordingCount,
        voiceCommunicationRecordingCount: status.voiceCommunicationRecordingCount,
        recordingConfigSummary: status.recordingConfigSummary,
        primaryRecordingSessionId: status.primaryRecordingSessionId ?? null,
        primaryClientAudioSource: status.primaryClientAudioSourceName ?? status.primaryClientAudioSource ?? null,
        primaryAudioSource: status.primaryAudioSourceName ?? status.primaryAudioSource ?? null,
        primaryInputDevice: status.primaryInputDeviceTypeName ?? status.primaryInputDeviceType ?? null,
        primaryInputDeviceName: status.primaryInputDeviceName ?? null,
        primaryClientSilenced: status.primaryClientSilenced ?? null,
        primaryClientFormat: status.primaryClientFormat ?? null,
        primaryDeviceFormat: status.primaryDeviceFormat ?? null,
        primaryClientEffects: status.primaryClientEffects,
        primaryStreamEffects: status.primaryStreamEffects,
        primaryClientHasAec: status.primaryClientHasAec,
        primaryStreamHasAec: status.primaryStreamHasAec,
        primaryClientHasNs: status.primaryClientHasNs,
        primaryStreamHasNs: status.primaryStreamHasNs,
        primaryClientHasAgc: status.primaryClientHasAgc,
        primaryStreamHasAgc: status.primaryStreamHasAgc,
        platformAecAvailable: status.platformAecAvailable,
        platformNsAvailable: status.platformNsAvailable,
        platformAgcAvailable: status.platformAgcAvailable,
        platformPreprocessorCatalog: status.platformPreprocessorCatalog,
      });
    } catch (error) {
      recordDiagnosticEvent("realtime", "android-audio-capture-diagnostics-failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async activateSpeakerRoute(reason: string): Promise<void> {
    if (!this.active) return;
    try {
      const before = await getRealtimeAudioRouteStatus();
      if (!this.active) return;
      this.recordAudioRoute("before-activation", before, reason);
      const status = await activateRealtimeSpeakerRoute();
      if (!this.active) return;
      this.speakerRouteActive = status.supported && status.active;
      this.recordAudioRoute("activated", status, reason);
      if (status.supported && !status.speakerSelected) {
        recordDiagnosticEvent("realtime", "audio-route-speaker-lost", {
          reason,
          stage: "activate-immediate",
          mode: status.modeName,
          routeRequestAccepted: status.routeRequestAccepted ?? null,
          communicationDeviceType: status.communicationDeviceTypeName ?? null,
        });
      }
      // Android can accept setCommunicationDevice() before communicationDevice
      // reflects the new route. Verify asynchronously; never block WebRTC start
      // or alter capture/AEC timing just for routing diagnostics.
      if (this.speakerRouteActive) {
        void (async () => {
          await waitMs(250);
          if (!this.active || !this.speakerRouteActive) return;
          await this.ensureSpeakerRoute(`${reason}-delayed-250ms`);
        })();
      }
    } catch (error) {
      this.speakerRouteActive = false;
      recordDiagnosticEvent("realtime", "audio-route-activation-failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
        fallback: "v2.1.74-default-communication-route",
      });
    }
  }

  private async ensureSpeakerRoute(reason: string): Promise<void> {
    if (!this.active) return;
    if (!this.speakerRouteActive) {
      await this.activateSpeakerRoute(reason);
      return;
    }
    try {
      const status = await ensureRealtimeSpeakerRoute();
      if (!this.active) return;
      this.speakerRouteActive = status.supported && status.active;
      this.recordAudioRoute("verified", status, reason);
      if (status.supported && !status.speakerSelected) {
        recordDiagnosticEvent("realtime", "audio-route-speaker-lost", {
          reason,
          stage: "verify",
          mode: status.modeName,
          routeRequestAccepted: status.routeRequestAccepted ?? null,
          communicationDeviceType: status.communicationDeviceTypeName ?? null,
        });
      }
    } catch (error) {
      this.speakerRouteActive = false;
      recordDiagnosticEvent("realtime", "audio-route-verify-failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
        fallback: "v2.1.74-default-communication-route",
      });
    }
  }

  private beginSpeakerRouteRestore(reason: string): Promise<void> {
    if (this.speakerRouteRestorePromise) return this.speakerRouteRestorePromise;
    const promise = this.restoreSpeakerRoute(reason);
    this.speakerRouteRestorePromise = promise;
    void promise.finally(() => {
      if (this.speakerRouteRestorePromise === promise) this.speakerRouteRestorePromise = null;
    });
    return promise;
  }

  private async restoreSpeakerRoute(reason: string): Promise<void> {
    try {
      const status = await deactivateRealtimeSpeakerRoute();
      if (status.supported) this.recordAudioRoute("restored", status, reason);
    } catch (error) {
      recordDiagnosticEvent("realtime", "audio-route-restore-failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.speakerRouteActive = false;
    }
  }

  private bindPeerConnection(peerConnection: LoosePeerConnection): void {
    peerConnection.ontrack = (event: any) => {
      if (!this.active) return;
      const tracks = event?.streams?.[0]?.getAudioTracks?.() ?? (event?.track ? [event.track] : []);
      for (const track of tracks) {
        try { track.enabled = true; } catch {}
        if (!this.remoteTracks.includes(track)) this.remoteTracks.push(track);
        if (this.remotePlaybackMuted) {
          try {
            if (typeof track?._setVolume === "function") track._setVolume(0);
            else track.enabled = false;
          } catch {}
        }
      }
      recordDiagnosticEvent("realtime", "webrtc-remote-audio-track", {
        tracks: tracks.length,
        kind: event?.track?.kind ?? "unknown",
      });
      void this.ensureSpeakerRoute("remote-audio-track");
    };
    peerConnection.onconnectionstatechange = () => {
      if (!this.active) return;
      const state = String(peerConnection.connectionState ?? "unknown");
      recordDiagnosticEvent("realtime", "webrtc-connection-state", { state });
      if (state === "connected") void this.ensureSpeakerRoute("connection-connected");
      if (state === "failed" || state === "closed") void this.stop(`webrtc-${state}`);
    };
    peerConnection.oniceconnectionstatechange = () => {
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "webrtc-ice-state", {
        state: String(peerConnection.iceConnectionState ?? "unknown"),
      });
    };
  }

  private bindDataChannel(dataChannel: LooseDataChannel): void {
    dataChannel.onmessage = (message: any) => {
      const event = safeJsonParse(message?.data);
      if (!event || !this.active) return;
      void this.handleEvent(event);
    };
    dataChannel.onerror = () => {
      if (!this.active) return;
      recordDiagnosticEvent("realtime", "data-channel-error");
    };
    dataChannel.onclose = () => {
      if (!this.active || this.stopping) return;
      recordDiagnosticEvent("realtime", "data-channel-closed");
      void this.stop("data-channel-closed");
    };
  }

  private async waitForDataChannelOpen(dataChannel: LooseDataChannel): Promise<void> {
    if (dataChannel.readyState === "open") return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`OpenAI Realtime WebRTC data channel did not open within ${DATA_CHANNEL_OPEN_TIMEOUT_MS}ms`));
      }, DATA_CHANNEL_OPEN_TIMEOUT_MS);
      const previousOpen = dataChannel.onopen;
      const previousError = dataChannel.onerror;
      dataChannel.onopen = (event: any) => {
        previousOpen?.(event);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        recordDiagnosticEvent("realtime", "webrtc-data-channel-open");
        resolve();
      };
      dataChannel.onerror = (event: any) => {
        previousError?.(event);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error("OpenAI Realtime WebRTC data channel failed to open"));
      };
    });
  }

  private async handleEvent(event: RealtimeEvent): Promise<void> {
    const type = String(event.type ?? "");
    if (type === "session.created") {
      recordDiagnosticEvent("realtime", "openai-session-created", {
        model: event.session?.model ?? this.sessionModel,
        transport: "webrtc",
      });
      return;
    }
    if (type === "session.updated") {
      const now = Date.now();
      if (this.vadHealthProbeSentAt > 0) {
        this.vadHealthProbeAcknowledgedAt = now;
        recordDiagnosticEvent("realtime", "vad-health-probe-ack", {
          latencyMs: Math.max(0, now - this.vadHealthProbeSentAt),
          speechSinceProbe: this.lastServerSpeechAt > this.vadHealthSpeechBaseline,
        });
      }
      this.configured = true;
      if (this.configuredAt === 0) this.configuredAt = now;
      const preroll = this.pendingPreroll;
      this.pendingPreroll = null;
      if (preroll) {
        this.appendPreroll(preroll.samples, preroll.sampleRate, preroll.source);
        recordDiagnosticEvent(
          "realtime",
          preroll.source === "startup" ? "startup-preroll-seeded" : "wake-preroll-seeded",
          {
            durationMs: Math.round((preroll.samples.length / preroll.sampleRate) * 1000),
            transport: "webrtc-data-channel-once",
          }
        );
      }
      useConversationStore.getState().setRealtimeReadiness("ready");
      recordDiagnosticEvent("realtime", "readiness-ready", {
        barrier: "session-updated",
        localTrackReadyState: this.localStream?.getAudioTracks?.()?.[0]?.readyState ?? null,
      });
      void this.recordAndroidAudioDiagnosticSnapshot("session-ready");
      recordDiagnosticEvent("realtime", "session-configured", {
        model: event.session?.model ?? this.sessionModel,
        voice: event.session?.audio?.output?.voice ?? "unknown",
        interruptResponse: event.session?.audio?.input?.turn_detection?.interrupt_response ?? true,
        turnDetectionType: event.session?.audio?.input?.turn_detection?.type ?? "unknown",
        vadThreshold: event.session?.audio?.input?.turn_detection?.threshold ?? null,
        prefixPaddingMs: event.session?.audio?.input?.turn_detection?.prefix_padding_ms ?? null,
        silenceDurationMs: event.session?.audio?.input?.turn_detection?.silence_duration_ms ?? null,
        noiseReductionType: event.session?.audio?.input?.noise_reduction?.type ?? null,
        transcriptionLanguage: event.session?.audio?.input?.transcription?.language ?? null,
        listeningLanguageSetting: useUserStore.getState().preferences.listeningLanguage,
        responseLanguageSetting: useUserStore.getState().preferences.language,
      });
      return;
    }
    if (type === "error") {
      recordDiagnosticEvent("realtime", "openai-error", {
        code: event.error?.code ?? "unknown",
        message: event.error?.message ?? "unknown",
      });
      return;
    }
    if (type === "response.created") {
      this.generationActive = true;
      this.playbackTerminal = null;
      this.pendingAssistantCompletion = null;
      recordDiagnosticEvent("realtime", "response-generation-started", {
        responseId: event.response?.id ?? null,
      });
      return;
    }
    if (type === "output_audio_buffer.started") {
      this.markPlaybackStarted(event);
      return;
    }
    if (type === "output_audio_buffer.stopped") {
      const playbackOutcome = this.playbackInterrupted ? "interrupted" : "stopped";
      this.stopBargeInAssistMonitor("playback-stopped");
      this.playbackActive = false;
      this.playbackResponseId = null;
      this.playbackTerminal = playbackOutcome;
      this.lastPlaybackEndedAt = Date.now();
      this.setRemotePlaybackMuted(false, "playback-stopped");
      recordDiagnosticEvent("realtime", "output-playback-stopped", {
        responseId: event.response_id ?? null,
        interrupted: this.playbackInterrupted,
      });
      this.playbackInterrupted = false;
      await this.finalizeAssistantTurnIfReady(playbackOutcome);
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      const wasOutputActive = this.playbackActive;
      this.lastServerSpeechAt = Date.now();
      this.vadHealthProbeSentAt = 0;
      this.vadHealthProbeAcknowledgedAt = 0;
      this.vadHealthSpeechBaseline = this.lastServerSpeechAt;
      this.vadHealthRecoveryAttempts = 0;
      this.vadHealthVoiceStreak = 0;
      this.vadHealthPostProbeVoiceStreak = 0;
      if (this.bargeInAssistMuted) {
        this.clearBargeInAssistRestoreTimer();
        recordDiagnosticEvent("realtime", "barge-in-local-assist-confirmed", {
          mutedBeforeServerSpeech: true,
          assistToSpeechMs: Math.max(0, Date.now() - this.lastBargeInAssistAt),
        });
      }
      if (wasOutputActive) {
        // Keep OpenAI's automatic WebRTC interruption semantics authoritative.
        // Do not send output_audio_buffer.clear/response.cancel from the voice
        // VAD path: physical tests showed that the first manual clear could be
        // followed by a session that kept sending RTP but stopped producing
        // server speech events. Instead, mute the already-received remote track
        // locally so the physical speaker stops immediately while
        // interrupt_response=true handles conversation truncation server-side.
        this.playbackInterrupted = true;
        this.setRemotePlaybackMuted(true, "voice-barge-in");
        recordDiagnosticEvent("realtime", "voice-barge-in", {
          automatic: true,
          serverManagedTruncation: true,
          generationActive: this.generationActive,
          localOutputMuted: true,
          manualOutputClearSent: false,
          manualResponseCancelSent: false,
        });
      }
      const store = useConversationStore.getState();
      if (wasOutputActive) store.setStreamingText("");
      store.setSpeaking(false);
      store.setProcessing(false);
      store.setListening(true);
      useUserStore.getState().setVoiceState("listening");
      recordDiagnosticEvent("realtime", "speech-started", { duringOutput: wasOutputActive });
      void this.recordAndroidAudioDiagnosticSnapshot(
        wasOutputActive ? "server-speech-started-during-output" : "server-speech-started"
      );
      return;
    }
    if (type === "output_audio_buffer.cleared") {
      this.stopBargeInAssistMonitor("buffer-cleared");
      const sentAt = this.lastOutputClearAt;
      const clearSource = this.lastOutputClearSource;
      this.playbackActive = false;
      this.playbackResponseId = null;
      this.playbackTerminal = "cleared";
      this.playbackInterrupted = false;
      this.lastPlaybackEndedAt = Date.now();
      this.setRemotePlaybackMuted(false, "buffer-cleared");
      recordDiagnosticEvent("realtime", "output-buffer-cleared", {
        source: clearSource ?? "other",
        responseId: event.response_id ?? null,
        clearAckLatencyMs: sentAt > 0 ? Math.max(0, Date.now() - sentAt) : null,
      });
      this.lastOutputClearAt = 0;
      this.lastOutputClearSource = null;
      await this.finalizeAssistantTurnIfReady("cleared");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      const store = useConversationStore.getState();
      store.setListening(false);
      store.setProcessing(true);
      useUserStore.getState().setVoiceState("processing");
      recordDiagnosticEvent("realtime", "speech-stopped");
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(event.transcript ?? "").trim();
      const itemId = String(event.item_id ?? `unknown-${Date.now()}`);
      if (transcript && !this.userTranscriptItems.has(itemId)) {
        this.userTranscriptItems.add(itemId);
        const store = useConversationStore.getState();
        store.setCurrentTranscript(transcript);
        store.addMessage({ role: "user", content: transcript });
        if (this.sessionId) {
          mirrorSessionMessage(this.sessionId, { role: "user", content: transcript });
        }
        recordDiagnosticEvent("realtime", "input-transcript", {
          length: transcript.length,
          recognizedText: transcript,
          languages: Array.isArray(event.languages) ? event.languages.map((x: any) => x?.code).filter(Boolean).join(",") : "unknown",
        });
      }
      return;
    }
    if (type === "response.output_audio.delta") {
      // WebRTC consumes model audio as a native remote media track. Audio deltas
      // show generation progress only; audible speaking state comes from the
      // WebRTC-specific output_audio_buffer.started/stopped events.
      this.markGenerationStarted();
      return;
    }
    if (type === "response.output_audio_transcript.delta") {
      this.markGenerationStarted();
      const delta = String(event.delta ?? "");
      this.assistantTranscript += delta;
      useConversationStore.getState().setStreamingText(this.assistantTranscript);
      return;
    }
    if (type === "response.output_audio_transcript.done") {
      const transcript = String(event.transcript ?? "").trim();
      if (transcript) this.assistantTranscript = transcript;
      useConversationStore.getState().setStreamingText(this.assistantTranscript);
      return;
    }
    if (type === "response.output_item.done" && event.item?.type === "function_call") {
      void this.executeToolCall(event.item);
      return;
    }
    if (type === "response.done") {
      this.generationActive = false;
      const hasFunctionCall = Array.isArray(event.response?.output) &&
        event.response.output.some((item: any) => item?.type === "function_call");
      if (hasFunctionCall || this.toolCallsInFlight > 0) return;
      await this.finishAssistantTurn(event);
      return;
    }
  }

  private markGenerationStarted(): void {
    if (this.generationActive) return;
    this.generationActive = true;
    recordDiagnosticEvent("realtime", "response-generation-started", {
      source: "audio-delta-fallback",
    });
  }

  private markPlaybackStarted(event?: RealtimeEvent): void {
    const responseId = String(event?.response_id ?? "").trim() || null;
    if (this.playbackActive && (!responseId || responseId === this.playbackResponseId)) return;
    this.setRemotePlaybackMuted(false, "playback-started");
    this.playbackInterrupted = false;
    this.playbackActive = true;
    this.playbackResponseId = responseId;
    this.playbackStartedAt = Date.now();
    this.bargeInAssistVoiceStreak = 0;
    this.bargeInAssistMuted = false;
    this.startBargeInAssistMonitor();
    this.playbackTerminal = null;
    const store = useConversationStore.getState();
    store.setListening(false);
    store.setProcessing(false);
    store.setSpeaking(true);
    useUserStore.getState().setVoiceState("speaking");
    recordDiagnosticEvent("realtime", "output-start", {
      inputMuted: false,
      audioPath: "native-webrtc-default-communication-adm",
      bargeInEnabled: true,
      playbackStateSource: "output_audio_buffer.started",
      responseId: event?.response_id ?? null,
    });
    void this.recordAndroidAudioDiagnosticSnapshot("output-start-before-route-verify");
    void this.ensureSpeakerRoute("output-start");
  }

  private async finishAssistantTurn(event: RealtimeEvent): Promise<void> {
    if (!this.active) return;
    const transcript = this.assistantTranscript.trim();
    const status = String(event.response?.status ?? "unknown");
    this.pendingAssistantCompletion = {
      transcript,
      status,
      totalTokens: typeof event.response?.usage?.total_tokens === "number"
        ? event.response.usage.total_tokens
        : null,
    };
    recordDiagnosticEvent("realtime", "response-finished", {
      transcriptLength: transcript.length,
      inputUnmuted: true,
      status,
      totalTokens: this.pendingAssistantCompletion.totalTokens,
      playback: "server-managed-webrtc",
      generationActive: this.generationActive,
      playbackActive: this.playbackActive,
      playbackTerminal: this.playbackTerminal,
    });

    // WebRTC may still be audibly draining model audio after response.done.
    // Do not mark LOOI as listening, and do not persist the full transcript,
    // until output_audio_buffer.stopped confirms the user actually heard it.
    // If playback was cleared, the unheard tail must not enter local history.
    if (this.playbackTerminal) {
      await this.finalizeAssistantTurnIfReady(this.playbackTerminal);
    } else if (!this.playbackActive && status !== "completed") {
      await this.finalizeAssistantTurnIfReady("cleared");
    } else if (!this.playbackActive) {
      // Defensive fallback for a response that produced no WebRTC playback.
      await this.finalizeAssistantTurnIfReady("stopped");
    }
  }

  private async finalizeAssistantTurnIfReady(
    playbackOutcome: "stopped" | "cleared" | "interrupted"
  ): Promise<void> {
    if (!this.active) return;
    const completion = this.pendingAssistantCompletion;
    if (!completion) {
      const store = useConversationStore.getState();
      store.setSpeaking(false);
      store.setProcessing(false);
      store.setListening(true);
      useUserStore.getState().setVoiceState("listening");
      return;
    }

    if (completion.transcript && completion.status === "completed" && playbackOutcome === "stopped") {
      useConversationStore.getState().addMessage({ role: "assistant", content: completion.transcript });
      if (this.sessionId) {
        mirrorSessionMessage(this.sessionId, { role: "assistant", content: completion.transcript });
      }
    }

    recordDiagnosticEvent("realtime", "assistant-turn-finalized", {
      status: completion.status,
      transcriptLength: completion.transcript.length,
      playbackOutcome,
      persisted: Boolean(
        completion.transcript && completion.status === "completed" && playbackOutcome === "stopped"
      ),
    });

    this.pendingAssistantCompletion = null;
    this.assistantTranscript = "";
    this.playbackTerminal = null;
    this.playbackActive = false;
    const store = useConversationStore.getState();
    store.setSpeaking(false);
    store.setProcessing(false);
    store.setListening(true);
    if (playbackOutcome !== "stopped") store.setStreamingText("");
    useUserStore.getState().setVoiceState("listening");
  }

  private setRemotePlaybackMuted(muted: boolean, reason: string): void {
    if (this.remotePlaybackMuted === muted && this.remoteTracks.length > 0) return;
    let volumeTracks = 0;
    let enabledFallbackTracks = 0;
    let failedTracks = 0;
    for (const track of this.remoteTracks) {
      try {
        if (typeof track?._setVolume === "function") {
          track._setVolume(muted ? 0 : 1);
          volumeTracks += 1;
        } else {
          track.enabled = !muted;
          enabledFallbackTracks += 1;
        }
      } catch {
        failedTracks += 1;
      }
    }
    this.remotePlaybackMuted = muted;
    recordDiagnosticEvent("realtime", muted ? "remote-playback-muted" : "remote-playback-restored", {
      reason,
      tracks: this.remoteTracks.length,
      volumeTracks,
      enabledFallbackTracks,
      failedTracks,
    });
  }

  private startBargeInAssistMonitor(): void {
    this.stopBargeInAssistMonitor("restart", false);
    // 2.1.71 proved this post-AEC sender level is not a valid detector for
    // missed double-talk: on the physical Mi MIX 2S the user's voice collapsed
    // near the noise floor while remote playback was active. Keep the code only
    // as dormant diagnostics while 2.1.72 A/B tests WebRTC software AEC.
    if (!BARGE_IN_ASSIST_ENABLED) return;
    if (!this.active || !this.playbackActive) return;
    const sample = () => { void this.sampleBargeInAssist(); };
    this.bargeInAssistTimer = setInterval(sample, BARGE_IN_ASSIST_POLL_MS);
  }

  private stopBargeInAssistMonitor(reason: string, restore = false): void {
    if (this.bargeInAssistTimer) {
      clearInterval(this.bargeInAssistTimer);
      this.bargeInAssistTimer = null;
    }
    this.clearBargeInAssistRestoreTimer();
    this.bargeInAssistVoiceStreak = 0;
    this.bargeInAssistStatsInFlight = false;
    if (restore && this.bargeInAssistMuted) {
      this.setRemotePlaybackMuted(false, reason);
    }
    this.bargeInAssistMuted = false;
  }

  private clearBargeInAssistRestoreTimer(): void {
    if (!this.bargeInAssistRestoreTimer) return;
    clearTimeout(this.bargeInAssistRestoreTimer);
    this.bargeInAssistRestoreTimer = null;
  }

  private async sampleBargeInAssist(): Promise<void> {
    const peerConnection = this.peerConnection;
    if (
      !this.active ||
      !this.playbackActive ||
      this.bargeInAssistMuted ||
      this.bargeInAssistStatsInFlight ||
      !peerConnection ||
      typeof peerConnection.getStats !== "function" ||
      Date.now() - this.playbackStartedAt < BARGE_IN_ASSIST_MIN_PLAYBACK_AGE_MS ||
      Date.now() - this.lastBargeInAssistAt < BARGE_IN_ASSIST_COOLDOWN_MS
    ) {
      return;
    }
    this.bargeInAssistStatsInFlight = true;
    try {
      const report = await peerConnection.getStats();
      if (!this.active || !this.playbackActive) return;
      const rows: any[] = [];
      if (report && typeof report.forEach === "function") {
        report.forEach((value: any) => rows.push(value));
      } else if (Array.isArray(report)) {
        rows.push(...report);
      } else if (report && typeof report === "object") {
        rows.push(...Object.values(report));
      }
      const source = rows.find((row) =>
        row?.type === "media-source" && (row?.kind === "audio" || row?.mediaType === "audio")
      );
      const audioLevel = typeof source?.audioLevel === "number" ? source.audioLevel : 0;
      if (audioLevel >= BARGE_IN_ASSIST_AUDIO_LEVEL) this.bargeInAssistVoiceStreak += 1;
      else this.bargeInAssistVoiceStreak = 0;

      if (this.bargeInAssistVoiceStreak < BARGE_IN_ASSIST_SAMPLES_REQUIRED) return;
      this.bargeInAssistVoiceStreak = 0;
      this.bargeInAssistMuted = true;
      this.playbackInterrupted = true;
      this.lastBargeInAssistAt = Date.now();
      this.setRemotePlaybackMuted(true, "barge-in-local-assist");
      recordDiagnosticEvent("realtime", "barge-in-local-assist-muted", {
        audioLevel,
        samplesRequired: BARGE_IN_ASSIST_SAMPLES_REQUIRED,
        threshold: BARGE_IN_ASSIST_AUDIO_LEVEL,
        serverSpeechAlreadyStarted: false,
      });
      this.clearBargeInAssistRestoreTimer();
      this.bargeInAssistRestoreTimer = setTimeout(() => {
        this.bargeInAssistRestoreTimer = null;
        if (!this.active || !this.playbackActive || !this.bargeInAssistMuted) return;
        this.bargeInAssistMuted = false;
        this.setRemotePlaybackMuted(false, "barge-in-local-assist-expired");
        recordDiagnosticEvent("realtime", "barge-in-local-assist-expired", {
          muteDurationMs: BARGE_IN_ASSIST_MAX_MUTE_MS,
          serverSpeechObserved: false,
        });
      }, BARGE_IN_ASSIST_MAX_MUTE_MS);
    } catch (error) {
      recordDiagnosticEvent("realtime", "barge-in-local-assist-stats-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.bargeInAssistStatsInFlight = false;
    }
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
      recordDiagnosticEvent("realtime", "tool-finished", { name, ok: true });
    } catch (error) {
      output = { ok: false, error: error instanceof Error ? error.message : String(error) };
      recordDiagnosticEvent("realtime", "tool-finished", { name, ok: false });
    } finally {
      this.toolCallsInFlight = Math.max(0, this.toolCallsInFlight - 1);
    }

    if (!this.active) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    this.send({ type: "response.create" });
  }

  private startStartupPrerollCapture(): void {
    this.stopStartupPrerollCapture();
    const sampleRate = 16_000;
    const maxSamples = Math.round((sampleRate * STARTUP_PREROLL_MAX_MS) / 1000);
    this.startupPrerollSamples = kwsAudioFeeder.getRecentSamples(STARTUP_PREROLL_RECENT_MS);
    if (this.startupPrerollSamples.length > maxSamples) {
      this.startupPrerollSamples = this.startupPrerollSamples.slice(-maxSamples);
    }
    this.startupPrerollUnsubscribe = kwsAudioFeeder.subscribeSamples((samples, incomingRate) => {
      if (!this.active || incomingRate !== sampleRate || samples.length === 0) return;
      this.startupPrerollSamples.push(...samples);
      if (this.startupPrerollSamples.length > maxSamples) {
        this.startupPrerollSamples.splice(0, this.startupPrerollSamples.length - maxSamples);
      }
    });
    recordDiagnosticEvent("realtime", "startup-preroll-capture-started", {
      recentDurationMs: Math.round((this.startupPrerollSamples.length / sampleRate) * 1000),
      maxDurationMs: STARTUP_PREROLL_MAX_MS,
    });
  }

  private finalizeStartupPrerollCapture(): void {
    const sampleRate = 16_000;
    const samples = this.startupPrerollSamples.slice();
    this.stopStartupPrerollCapture();
    if (!this.active || this.pendingPreroll || samples.length === 0) return;
    this.pendingPreroll = { samples, sampleRate, source: "startup" };
    let sumSquares = 0;
    let peak = 0;
    for (const sample of samples) {
      const value = Number(sample) || 0;
      sumSquares += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    recordDiagnosticEvent("realtime", "startup-preroll-capture-finished", {
      durationMs: Math.round((samples.length / sampleRate) * 1000),
      rms: Math.sqrt(sumSquares / Math.max(1, samples.length)),
      peak,
    });
  }

  private stopStartupPrerollCapture(): void {
    const unsubscribe = this.startupPrerollUnsubscribe;
    this.startupPrerollUnsubscribe = null;
    if (unsubscribe) {
      try { unsubscribe(); } catch {}
    }
    this.startupPrerollSamples = [];
  }

  private appendPreroll(
    samples: readonly number[],
    sampleRate: number,
    source: "wake-command" | "startup"
  ): void {
    if (!this.active || !this.configured || samples.length === 0) return;
    if (sampleRate !== 16_000) {
      recordDiagnosticEvent("realtime", "unsupported-input-rate", {
        sampleRate,
        source,
      });
      return;
    }
    const resampled = resample16kTo24k(samples);
    const audio = bytesToBase64(floatSamplesToPcm16Bytes(resampled));
    this.send({ type: "input_audio_buffer.append", audio });
  }

  private startWebRtcAudioStats(): void {
    this.clearWebRtcAudioStats();
    const sample = () => { void this.recordWebRtcAudioStats(); };
    sample();
    this.statsTimer = setInterval(sample, 5_000);
  }

  private clearWebRtcAudioStats(): void {
    if (!this.statsTimer) return;
    clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private async recordWebRtcAudioStats(): Promise<void> {
    const peerConnection = this.peerConnection;
    if (!this.active || !peerConnection || typeof peerConnection.getStats !== "function") return;
    try {
      const report = await peerConnection.getStats();
      if (!this.active) return;
      const rows: any[] = [];
      if (report && typeof report.forEach === "function") {
        report.forEach((value: any) => rows.push(value));
      } else if (Array.isArray(report)) {
        rows.push(...report);
      } else if (report && typeof report === "object") {
        rows.push(...Object.values(report));
      }
      const outbound = rows.find((row) =>
        row?.type === "outbound-rtp" && (row?.kind === "audio" || row?.mediaType === "audio")
      );
      const source = rows.find((row) =>
        row?.type === "media-source" && (row?.kind === "audio" || row?.mediaType === "audio")
      );
      const localTrack = this.localStream?.getAudioTracks?.()?.[0] ?? null;
      recordDiagnosticEvent("realtime", "webrtc-audio-stats", {
        localTrackEnabled: localTrack?.enabled ?? null,
        localTrackMuted: localTrack?.muted ?? null,
        localTrackReadyState: localTrack?.readyState ?? null,
        packetsSent: outbound?.packetsSent ?? null,
        bytesSent: outbound?.bytesSent ?? null,
        audioLevel: source?.audioLevel ?? null,
        totalAudioEnergy: source?.totalAudioEnergy ?? null,
      });
      this.evaluateVadHealth({
        packetsSent: typeof outbound?.packetsSent === "number" ? outbound.packetsSent : null,
        audioLevel: typeof source?.audioLevel === "number" ? source.audioLevel : null,
        totalAudioEnergy: typeof source?.totalAudioEnergy === "number" ? source.totalAudioEnergy : null,
      });
    } catch (error) {
      recordDiagnosticEvent("realtime", "webrtc-audio-stats-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private evaluateVadHealth(stats: {
    packetsSent: number | null;
    audioLevel: number | null;
    totalAudioEnergy: number | null;
  }): void {
    const now = Date.now();
    const previousPackets = this.lastStatsPacketsSent;
    const previousEnergy = this.lastStatsTotalAudioEnergy;
    this.lastStatsPacketsSent = stats.packetsSent;
    this.lastStatsTotalAudioEnergy = stats.totalAudioEnergy;

    if (
      !this.active ||
      !this.configured ||
      this.generationActive ||
      this.playbackActive ||
      this.vadHealthRecoveryInFlight ||
      !isMainScreenFocused() ||
      AppState.currentState !== "active" ||
      useUserStore.getState().robotSleeping
    ) {
      this.vadHealthVoiceStreak = 0;
      this.vadHealthPostProbeVoiceStreak = 0;
      return;
    }

    if (this.lastPlaybackEndedAt > 0 && now - this.lastPlaybackEndedAt < VAD_HEALTH_POST_PLAYBACK_GUARD_MS) {
      this.vadHealthVoiceStreak = 0;
      return;
    }

    const sinceServerSpeechMs = now - (this.lastServerSpeechAt || this.configuredAt || now);
    if (sinceServerSpeechMs < VAD_HEALTH_MIN_SILENCE_MS) {
      this.vadHealthVoiceStreak = 0;
      return;
    }

    const packetsAdvanced =
      stats.packetsSent !== null && previousPackets !== null && stats.packetsSent > previousPackets;
    const energyDelta =
      stats.totalAudioEnergy !== null && previousEnergy !== null
        ? Math.max(0, stats.totalAudioEnergy - previousEnergy)
        : 0;
    const probableVoice =
      (stats.audioLevel ?? 0) >= VAD_HEALTH_AUDIO_LEVEL || energyDelta >= VAD_HEALTH_ENERGY_DELTA;
    if (!packetsAdvanced) {
      this.vadHealthVoiceStreak = 0;
      this.vadHealthPostProbeVoiceStreak = 0;
      return;
    }

    if (this.vadHealthProbeSentAt === 0) {
      this.vadHealthVoiceStreak = probableVoice ? this.vadHealthVoiceStreak + 1 : 0;
      if (this.vadHealthVoiceStreak < VAD_HEALTH_VOICE_SAMPLES_REQUIRED) return;
      this.vadHealthVoiceStreak = 0;
      this.vadHealthPostProbeVoiceStreak = 0;
      this.vadHealthProbeSentAt = now;
      this.vadHealthProbeAcknowledgedAt = 0;
      this.vadHealthSpeechBaseline = this.lastServerSpeechAt;
      this.send(buildRealtimeSessionUpdate(useUserStore.getState().preferences));
      recordDiagnosticEvent("realtime", "vad-health-probe-sent", {
        sinceServerSpeechMs,
        packetsSent: stats.packetsSent,
        audioLevel: stats.audioLevel,
        energyDelta,
        sustainedVoiceSamples: VAD_HEALTH_VOICE_SAMPLES_REQUIRED,
      });
      return;
    }

    const probeAgeMs = now - this.vadHealthProbeSentAt;
    if (probableVoice) this.vadHealthPostProbeVoiceStreak += 1;
    else this.vadHealthPostProbeVoiceStreak = 0;

    if (
      probeAgeMs >= VAD_HEALTH_PROBE_GRACE_MS &&
      this.lastServerSpeechAt <= this.vadHealthSpeechBaseline &&
      this.vadHealthPostProbeVoiceStreak >= VAD_HEALTH_POST_PROBE_VOICE_SAMPLES_REQUIRED
    ) {
      this.vadHealthPostProbeVoiceStreak = 0;
      void this.recoverVadCapture({
        sinceServerSpeechMs,
        packetsSent: stats.packetsSent,
        audioLevel: stats.audioLevel,
        energyDelta,
        probeAcknowledged: this.vadHealthProbeAcknowledgedAt > 0,
      });
      return;
    }

    if (probeAgeMs >= VAD_HEALTH_PROBE_MAX_AGE_MS && this.vadHealthPostProbeVoiceStreak === 0) {
      recordDiagnosticEvent("realtime", "vad-health-probe-cancelled", {
        reason: "post-probe-audio-quiet",
        probeAgeMs,
        sinceServerSpeechMs,
        packetsSent: stats.packetsSent,
        audioLevel: stats.audioLevel,
        energyDelta,
      });
      this.vadHealthProbeSentAt = 0;
      this.vadHealthProbeAcknowledgedAt = 0;
      this.vadHealthSpeechBaseline = this.lastServerSpeechAt;
      this.vadHealthPostProbeVoiceStreak = 0;
    }
  }

  private async recoverVadCapture(evidence: {
    sinceServerSpeechMs: number;
    packetsSent: number | null;
    audioLevel: number | null;
    energyDelta: number;
    probeAcknowledged: boolean;
  }): Promise<void> {
    if (
      this.vadHealthRecoveryInFlight ||
      !this.active ||
      !isMainScreenFocused() ||
      AppState.currentState !== "active" ||
      useUserStore.getState().robotSleeping ||
      useUserStore.getState().preferences.conversationMode !== "realtime"
    ) {
      return;
    }
    if (this.vadHealthRecoveryAttempts >= 1) {
      recordDiagnosticEvent("realtime", "vad-health-recovery-skipped", {
        reason: "attempt-budget-exhausted",
        ...evidence,
      });
      return;
    }

    this.vadHealthRecoveryInFlight = true;
    this.vadHealthRecoveryAttempts += 1;
    useConversationStore.getState().setRealtimeReadiness("connecting");
    recordDiagnosticEvent("realtime", "vad-health-recovery-start", {
      attempt: this.vadHealthRecoveryAttempts,
      ...evidence,
    });

    try {
      await this.stop("vad-health-recovery");
      if (
        AppState.currentState !== "active" ||
        !isMainScreenFocused() ||
        useUserStore.getState().robotSleeping ||
        useUserStore.getState().preferences.conversationMode !== "realtime"
      ) {
        recordDiagnosticEvent("realtime", "vad-health-recovery-aborted", {
          reason: "lifecycle-changed",
        });
        return;
      }
      await this.start();
      recordDiagnosticEvent("realtime", "vad-health-recovery-restarted", {
        attempt: this.vadHealthRecoveryAttempts,
      });
    } catch (error) {
      recordDiagnosticEvent("realtime", "vad-health-recovery-failed", {
        attempt: this.vadHealthRecoveryAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.vadHealthRecoveryInFlight = false;
    }
  }

  private send(event: Record<string, unknown>): void {
    const dataChannel = this.dataChannel;
    if (!dataChannel || dataChannel.readyState !== "open" || typeof dataChannel.send !== "function") return;
    try {
      dataChannel.send(JSON.stringify(event));
    } catch (error) {
      recordDiagnosticEvent("realtime", "send-failed", {
        eventType: String(event.type ?? "unknown"),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

}

const webRtcRealtimeConversationService = new RealtimeConversationService();

class RealtimeConversationRouterService {
  get isActive(): boolean {
    return webRtcRealtimeConversationService.isActive || realtimePcmConversationService.isActive;
  }

  async start(detection?: WakewordDetection): Promise<void> {
    const mode = useUserStore.getState().preferences.conversationMode;
    if (isPcmRealtimeMode(mode)) {
      return realtimePcmConversationService.start(detection);
    }
    return webRtcRealtimeConversationService.start(detection);
  }

  async interruptAndListen(source = "tap"): Promise<void> {
    if (realtimePcmConversationService.isActive) {
      return realtimePcmConversationService.interruptAndListen(source);
    }
    return webRtcRealtimeConversationService.interruptAndListen(source);
  }

  applySessionPreferences(source: string): void {
    if (realtimePcmConversationService.isActive) {
      realtimePcmConversationService.applySessionPreferences(source);
      return;
    }
    if (webRtcRealtimeConversationService.isActive) {
      webRtcRealtimeConversationService.applySessionPreferences(source);
    }
  }

  async stop(reason = "explicit"): Promise<void> {
    if (realtimePcmConversationService.isActive) {
      await realtimePcmConversationService.stop(reason);
    }
    if (webRtcRealtimeConversationService.isActive) {
      await webRtcRealtimeConversationService.stop(reason);
    }
  }
}

export const realtimeConversationService = new RealtimeConversationRouterService();
