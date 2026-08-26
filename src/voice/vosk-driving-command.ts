import { Platform } from "react-native";
import VoskCommandRecognizer, {
  type VoskCommandEvent,
  type VoskEmergencyStopEvent,
  type VoskEmergencyUnknownEvent,
  type VoskEmergencyHealthEvent,
  type VoskErrorEvent,
  type VoskModelReadyEvent,
  type VoskRecognizerStateEvent,
} from "../../modules/vosk-command-recognizer";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import type { ListeningLanguage } from "../language/listening-language";
import { useUserStore } from "../store/user";
import { parseDrivingCommandTranscript, type DrivingCommand } from "./driving-command";
import {
  buildDrivingCommandGrammar,
  normalizeDrivingGrammarResult,
  type DrivingGrammarBundle,
} from "./driving-command-grammar";
import {
  getDrivingControlSessionRemainingMs,
  isDrivingControlSessionActive,
  refreshDrivingControlSession,
} from "./driving-control-session";
import { getLooiRobotRuntimeState } from "../device-tools/looi-robot";

type CommandHandler = (command: DrivingCommand, transcript: string) => void;

const MODEL_ASSET_DIR: Record<ListeningLanguage, string> = {
  ru: "vosk-command-ru",
  uk: "vosk-command-uk",
  en: "vosk-command-en",
};

const EMERGENCY_STOP_GRAMMAR: Record<ListeningLanguage, string[]> = {
  ru: [
    "стоп", "стой", "остановись", "останови", "тормози", "замри", "хватит",
    "достаточно", "не надо", "стій", "зупинись", "зупини", "гальмуй", "досить",
    "stop", "halt", "brake", "freeze", "hold", "enough", "[unk]",
  ],
  uk: [
    "стій", "стоп", "зупинись", "зупини", "гальмуй", "завмри", "досить",
    "не треба", "стой", "остановись", "тормози", "хватит",
    "stop", "halt", "brake", "freeze", "hold", "enough", "[unk]",
  ],
  en: [
    "stop", "halt", "brake", "freeze", "hold", "enough", "stop moving", "stop now",
    "стоп", "стой", "стій", "тормози", "гальмуй", "[unk]",
  ],
};

class VoskDrivingCommandRecognizer {
  private readyLanguage: ListeningLanguage | null = null;
  private preparingLanguage: ListeningLanguage | null = null;
  private preparePromise: Promise<boolean> | null = null;
  private grammarByLanguage = new Map<ListeningLanguage, DrivingGrammarBundle>();
  private commandHandler: CommandHandler | null = null;
  private listenersInstalled = false;
  private lastExecutedSequence = 0;
  private lastPartialStopText = "";
  private lastStopExecutedAt = 0;
  private speechAttemptStartedAt = 0;
  private speechAttemptSessionId = 0;
  private speechAttemptResetGeneration = 0;
  private failed = false;
  private failedAt = 0;
  private emergencyAutoDisarmTimer: ReturnType<typeof setTimeout> | null = null;
  private emergencyArmSerial = 0;
  private emergencyArmedAt = 0;

  constructor() {
    this.installListeners();
  }

  setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  async prewarm(language: ListeningLanguage): Promise<boolean> {
    if (Platform.OS !== "android") return false;
    // A transient model-copy/load error must not permanently disable physical
    // control for the lifetime of the process. Retry after a short cooldown.
    if (this.failed && Date.now() - this.failedAt < 5_000) return false;
    if (this.failed) this.failed = false;
    if (this.readyLanguage === language) return true;
    if (this.preparePromise && this.preparingLanguage === language) return this.preparePromise;

    const bundle = this.getBundle(language);
    const startedAt = Date.now();
    this.preparingLanguage = language;
    const promise = VoskCommandRecognizer.prepare(
      language,
      MODEL_ASSET_DIR[language],
      JSON.stringify(bundle.phrases),
      JSON.stringify(EMERGENCY_STOP_GRAMMAR[language])
    )
      .then(() => {
        this.readyLanguage = language;
        this.failed = false;
        this.failedAt = 0;
        this.lastExecutedSequence = 0;
        this.lastPartialStopText = "";
        this.lastStopExecutedAt = 0;
        this.speechAttemptStartedAt = 0;
        this.speechAttemptSessionId = 0;
        this.speechAttemptResetGeneration = 0;
        recordDiagnosticEvent("runtime", "vosk-driving-prewarm-ready", {
          language,
          grammarPhrases: bundle.phrases.length,
          durationMs: Date.now() - startedAt,
        });
        return true;
      })
      .catch((error) => {
        this.failed = true;
        this.failedAt = Date.now();
        recordDiagnosticEvent("runtime", "vosk-driving-prewarm-failed", {
          language,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      })
      .finally(() => {
        if (this.preparePromise === promise) {
          this.preparePromise = null;
          this.preparingLanguage = null;
        }
      });

    this.preparePromise = promise;
    return promise;
  }

  async ensureReadyForCurrentLanguage(): Promise<boolean> {
    return this.prewarm(useUserStore.getState().preferences.listeningLanguage);
  }

  acceptSamples(samples: number[], sampleRate: number): boolean {
    if (sampleRate !== 16000 || samples.length === 0 || Platform.OS !== "android") return false;
    const language = useUserStore.getState().preferences.listeningLanguage;
    if (this.readyLanguage !== language || this.failed) {
      void this.prewarm(language);
      return false;
    }

    try {
      const status = VoskCommandRecognizer.getStatus();
      if (!status.ready || status.language !== language) return false;
      if (status.queuedChunks >= 5) {
        recordDiagnosticEvent("runtime", "vosk-driving-feed-backpressure", {
          queuedChunks: status.queuedChunks,
        });
        return true;
      }
      VoskCommandRecognizer.feedSamples(samples);
      return true;
    } catch (error) {
      recordDiagnosticEvent("runtime", "vosk-driving-feed-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async armEmergencyForMotion(reason: string, autoDisarmMs = 8_000): Promise<boolean> {
    if (Platform.OS !== "android") return false;
    const language = useUserStore.getState().preferences.listeningLanguage;
    if (!(await this.prewarm(language))) return false;
    this.clearEmergencyAutoDisarmTimer();
    const armSerial = ++this.emergencyArmSerial;
    try {
      const armed = await VoskCommandRecognizer.armEmergency(reason);
      if (!armed) {
        recordDiagnosticEvent("runtime", "vosk-emergency-arm-failed", { reason, cause: "native-not-ready" });
        return false;
      }
      this.emergencyArmedAt = Date.now();
      const status = VoskCommandRecognizer.getStatus();
      recordDiagnosticEvent("runtime", "vosk-emergency-armed", {
        reason,
        emergencyArmed: status.emergencyArmed,
        emergencyArmGeneration: status.emergencyArmGeneration,
        queuedChunks: status.queuedChunks,
        autoDisarmMs,
      });
      this.emergencyAutoDisarmTimer = setTimeout(() => {
        if (this.emergencyArmSerial !== armSerial) return;
        void this.disarmEmergency(`auto-timeout:${reason}`);
      }, Math.max(1_000, autoDisarmMs));
      return true;
    } catch (error) {
      recordDiagnosticEvent("runtime", "vosk-emergency-arm-failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async disarmEmergency(reason: string): Promise<void> {
    this.clearEmergencyAutoDisarmTimer();
    this.emergencyArmSerial += 1;
    this.emergencyArmedAt = 0;
    if (Platform.OS !== "android") return;
    try {
      await VoskCommandRecognizer.disarmEmergency(reason);
      recordDiagnosticEvent("runtime", "vosk-emergency-disarmed", { reason });
    } catch (error) {
      recordDiagnosticEvent("runtime", "vosk-emergency-disarm-failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private clearEmergencyAutoDisarmTimer(): void {
    if (this.emergencyAutoDisarmTimer) {
      clearTimeout(this.emergencyAutoDisarmTimer);
      this.emergencyAutoDisarmTimer = null;
    }
  }

  reset(reason = "unspecified", resetEmergency = true): void {
    this.lastPartialStopText = "";
    if (resetEmergency) {
      this.clearEmergencyAutoDisarmTimer();
      this.emergencyArmSerial += 1;
      this.emergencyArmedAt = 0;
    }
    if (this.speechAttemptStartedAt > 0) {
      recordDiagnosticEvent("runtime", "vosk-driving-speech-attempt-end", {
        reason: `reset:${reason}`,
        sessionId: this.speechAttemptSessionId,
        resetGeneration: this.speechAttemptResetGeneration,
        durationMs: Date.now() - this.speechAttemptStartedAt,
      });
      this.speechAttemptStartedAt = 0;
      this.speechAttemptSessionId = 0;
      this.speechAttemptResetGeneration = 0;
    }
    try {
      const resetGeneration = VoskCommandRecognizer.reset(reason, resetEmergency);
      recordDiagnosticEvent("runtime", "vosk-driving-reset-requested", {
        reason,
        resetGeneration,
        resetEmergency,
      });
    } catch {
      // Optional local recognizer must never destabilize the main voice runtime.
    }
  }

  async switchLanguage(language: ListeningLanguage): Promise<boolean> {
    this.readyLanguage = null;
    this.failed = false;
    this.failedAt = 0;
    return this.prewarm(language);
  }

  private getBundle(language: ListeningLanguage): DrivingGrammarBundle {
    let bundle = this.grammarByLanguage.get(language);
    if (!bundle) {
      bundle = buildDrivingCommandGrammar(language);
      this.grammarByLanguage.set(language, bundle);
    }
    return bundle;
  }

  private installListeners(): void {
    if (this.listenersInstalled || Platform.OS !== "android") return;
    this.listenersInstalled = true;

    VoskCommandRecognizer.addListener("onModelReady", (event: VoskModelReadyEvent) => {
      recordDiagnosticEvent("runtime", "vosk-driving-model-ready", {
        language: event.language,
        assetDir: event.assetDir,
        loadMs: event.loadMs,
        cached: event.cached,
        sessionId: event.sessionId,
        resetGeneration: event.resetGeneration,
      });
    });

    VoskCommandRecognizer.addListener("onRecognizerError", (event: VoskErrorEvent) => {
      recordDiagnosticEvent("runtime", "vosk-driving-native-error", {
        stage: event.stage,
        error: event.message,
      });
    });

    VoskCommandRecognizer.addListener("onRecognizerState", (event: VoskRecognizerStateEvent) => {
      recordDiagnosticEvent("runtime", "vosk-driving-native-state", {
        state: event.state,
        reason: event.reason,
        sessionId: event.sessionId,
        resetGeneration: event.resetGeneration,
        resetCount: event.resetCount,
        queuedChunks: event.queuedChunks,
        droppedChunks: event.droppedChunks,
        samplesSinceReset: event.samplesSinceReset,
        emergencySamplesSinceReset: event.emergencySamplesSinceReset,
        emergencyArmed: event.emergencyArmed,
        emergencyArmGeneration: event.emergencyArmGeneration,
        emergencyReset: event.emergencyReset,
        processingMs: event.processingMs,
      });
    });

    VoskCommandRecognizer.addListener("onEmergencyStop", (event: VoskEmergencyStopEvent) => {
      this.handleEmergencyStop(event);
    });

    VoskCommandRecognizer.addListener("onEmergencyUnknown", (event: VoskEmergencyUnknownEvent) => {
      this.handleEmergencyUnknown(event);
    });

    VoskCommandRecognizer.addListener("onEmergencyHealth", (event: VoskEmergencyHealthEvent) => {
      this.handleEmergencyHealth(event);
    });

    VoskCommandRecognizer.addListener("onCommandResult", (event: VoskCommandEvent) => {
      this.handleResult(event);
    });
  }

  private handleEmergencyHealth(event: VoskEmergencyHealthEvent): void {
    const motion = getLooiRobotRuntimeState();
    recordDiagnosticEvent("runtime", "vosk-emergency-health", {
      armed: event.armed,
      armGeneration: event.armGeneration,
      partialText: event.partialText || "(empty)",
      endpoint: event.endpoint,
      processingMs: event.processingMs,
      sessionId: event.sessionId,
      samplesSinceEmergencyReset: event.samplesSinceEmergencyReset,
      queuedChunks: event.queuedChunks,
      rms16: Math.round(event.rms16),
      motionActive: motion.motionActive,
      activeDirection: motion.activeDirection ?? "none",
    });
    // Deadman/sensor/turn completion can stop motion outside the Vosk command
    // handler. The next health tick notices that and tears the emergency decoder
    // down, so it does not accumulate unrelated speech for the rest of the session.
    if (
      event.armed &&
      !motion.motionActive &&
      this.emergencyArmedAt > 0 &&
      Date.now() - this.emergencyArmedAt >= 1_500
    ) {
      void this.disarmEmergency("motion-inactive-health");
    }
  }

  private handleEmergencyUnknown(event: VoskEmergencyUnknownEvent): void {
    if (!isDrivingControlSessionActive() && !getLooiRobotRuntimeState().motionActive) return;
    const language = useUserStore.getState().preferences.listeningLanguage;
    if (this.readyLanguage !== language) return;

    recordDiagnosticEvent("runtime", "vosk-emergency-unknown", {
      language,
      transcript: event.text,
      partial: event.partial,
      processingMs: event.processingMs,
      sessionId: event.sessionId,
      samplesSinceEmergencyReset: event.samplesSinceEmergencyReset,
      queuedChunks: event.queuedChunks,
      rms16: Math.round(event.rms16),
      drivingSessionRemainingMs: getDrivingControlSessionRemainingMs(),
    });
  }

  private handleEmergencyStop(event: VoskEmergencyStopEvent): void {
    if (!isDrivingControlSessionActive() && !getLooiRobotRuntimeState().motionActive) return;
    const language = useUserStore.getState().preferences.listeningLanguage;
    if (this.readyLanguage !== language) return;

    const normalized = normalizeDrivingGrammarResult(event.text);
    const parsed = parseDrivingCommandTranscript(normalized, language);
    if (!normalized || parsed?.kind !== "stop") return;

    // The normal wide recognizer may emit the same STOP shortly afterwards.
    // One physical stop is enough; keep a short dedupe window shared by both paths.
    const now = Date.now();
    if (now - this.lastStopExecutedAt < 800) return;
    this.lastStopExecutedAt = now;
    this.lastPartialStopText = normalized;

    recordDiagnosticEvent("runtime", "vosk-emergency-stop", {
      language,
      transcript: normalized,
      partial: event.partial,
      processingMs: event.processingMs,
      sessionId: event.sessionId,
      samplesSinceEmergencyReset: event.samplesSinceEmergencyReset,
      queuedChunks: event.queuedChunks,
      rms16: Math.round(event.rms16),
      drivingSessionRemainingMs: getDrivingControlSessionRemainingMs(),
    });

    this.commandHandler?.({ kind: "stop" }, normalized);
  }

  private handleResult(event: VoskCommandEvent): void {
    if (!isDrivingControlSessionActive()) return;
    const language = useUserStore.getState().preferences.listeningLanguage;
    if (this.readyLanguage !== language) return;

    const normalized = normalizeDrivingGrammarResult(event.text);
    if (!normalized) return;

    const isNewSpeechAttempt =
      this.speechAttemptStartedAt === 0 ||
      this.speechAttemptSessionId !== event.sessionId ||
      this.speechAttemptResetGeneration !== event.resetGeneration;
    if (isNewSpeechAttempt) {
      this.speechAttemptStartedAt = Date.now();
      this.speechAttemptSessionId = event.sessionId;
      this.speechAttemptResetGeneration = event.resetGeneration;
      recordDiagnosticEvent("runtime", "vosk-driving-speech-attempt-start", {
        transcript: normalized,
        partial: event.partial,
        sessionId: event.sessionId,
        resetGeneration: event.resetGeneration,
        samplesSinceReset: event.samplesSinceReset,
        queuedChunks: event.queuedChunks,
        droppedChunks: event.droppedChunks,
        rms16: Math.round(event.rms16),
        drivingSessionRemainingMs: getDrivingControlSessionRemainingMs(),
      });
    }

    // Any real local speech attempt keeps the physical-control session alive.
    // This prevents several recognition misses from expiring the control window.
    if (!event.partial || normalized === "[unk]") {
      refreshDrivingControlSession("vosk-speech-attempt");
    }

    const bundle = this.getBundle(language);
    const exact = bundle.commandByPhrase.get(normalized) ?? null;
    const fallback = exact ?? parseDrivingCommandTranscript(normalized, language);

    recordDiagnosticEvent("runtime", event.partial ? "vosk-driving-partial" : "vosk-driving-result", {
      language,
      transcript: normalized,
      matched: Boolean(fallback),
      command: fallback?.kind ?? "none",
      sequence: event.sequence,
      processingMs: event.processingMs,
      sessionId: event.sessionId,
      resetGeneration: event.resetGeneration,
      samplesSinceReset: event.samplesSinceReset,
      queuedChunks: event.queuedChunks,
      droppedChunks: event.droppedChunks,
      endpoint: event.endpoint,
      rms16: Math.round(event.rms16),
      drivingSessionRemainingMs: getDrivingControlSessionRemainingMs(),
    });

    if (!event.partial && this.speechAttemptStartedAt > 0) {
      recordDiagnosticEvent("runtime", "vosk-driving-speech-attempt-end", {
        reason: "endpoint",
        transcript: normalized,
        matched: Boolean(fallback),
        command: fallback?.kind ?? "none",
        sessionId: event.sessionId,
        resetGeneration: event.resetGeneration,
        samplesSinceReset: event.samplesSinceReset,
        queuedChunks: event.queuedChunks,
        droppedChunks: event.droppedChunks,
        rms16: Math.round(event.rms16),
        durationMs: Date.now() - this.speechAttemptStartedAt,
      });
      this.speechAttemptStartedAt = 0;
      this.speechAttemptSessionId = 0;
      this.speechAttemptResetGeneration = 0;
    }

    if (!fallback) return;

    // Partial results are executed only for STOP. This gives emergency stopping
    // the shortest path while keeping direction/gesture commands endpoint-safe.
    if (event.partial) {
      if (fallback.kind !== "stop" || normalized === this.lastPartialStopText) return;
      if (Date.now() - this.lastStopExecutedAt < 800) return;
      this.lastPartialStopText = normalized;
    } else {
      this.lastPartialStopText = "";
      if (event.sequence <= this.lastExecutedSequence) return;
      // A final STOP often follows the partial STOP that already halted wheels.
      // Suppress that duplicate while retaining a fresh repeated STOP later.
      if (fallback.kind === "stop" && Date.now() - this.lastStopExecutedAt < 1_200) {
        this.lastExecutedSequence = Math.max(this.lastExecutedSequence, event.sequence);
        return;
      }
    }

    this.lastExecutedSequence = Math.max(this.lastExecutedSequence, event.sequence);
    if (fallback.kind === "stop") this.lastStopExecutedAt = Date.now();
    this.commandHandler?.(fallback, normalized);
  }
}

export const voskDrivingCommandRecognizer = new VoskDrivingCommandRecognizer();
