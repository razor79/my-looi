import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { triggerCharacterReaction } from "../character/character-reaction";
import {
  getLooiRobotRuntimeState,
  performLooiDance,
  performLooiHeadGesture,
  setLooiLight,
  startLooiMotion,
  stopLooiMotion,
  turnLooi,
} from "../device-tools/looi-robot";
import { drivingCommandFallback } from "./driving-command-fallback";
import { voskDrivingCommandRecognizer } from "./vosk-driving-command";
import type { DrivingCommand } from "./driving-command";
import {
  enterDrivingControlSession,
  exitDrivingControlSession,
  getDrivingControlSessionRemainingMs,
  isDrivingControlSessionActive,
  refreshDrivingControlSession,
} from "./driving-control-session";

export type WakewordState = "idle" | "listening" | "detected" | "unavailable";

export type WakewordDetection = {
  source: "kws" | "whisper" | "manual";
  keyword?: string;
  phraseId?: "ru" | "uk" | "en";
  wakeSegmentSamples?: number[];
  commandPrerollSamples?: number[];
  hasCommandSuffix?: boolean;
  sampleRate?: number;
};

type WakewordCallback = (detection: WakewordDetection) => void;

const DETECTION_COOLDOWN_MS = 3500;

async function getSherpaVoiceAdapter() {
  const { sherpaVoiceAdapter } = await import("./sherpa-adapter");
  return sherpaVoiceAdapter;
}

export class WakewordService {
  private listeners: WakewordCallback[] = [];
  private listening = false;
  private _state: WakewordState = "idle";
  private lastDetectionAt = 0;
  private nativeKwsAvailable = false;
  private loggedNativeKwsFeedResult = false;
  private nativeKwsInitialization: Promise<void> | null = null;
  private nativeKwsInvalidation: Promise<void> | null = null;
  private nativeOnlyMode = false;
  private speakingBargeInMode = false;
  private drivingCommandExecution: Promise<void> | null = null;

  async start(): Promise<void> {
    if (!this.listening) {
      const { wakePhraseFallback } = await import("./wake-phrase-fallback");
      wakePhraseFallback.start();
      this.listening = true;
      this._state = "listening";
      recordDiagnosticEvent("runtime", "wakeword-started");
    }

    // v1.1.35: preload the selected offline command model while the user is
    // conversing so the first physical command does not pay model-load latency.
    void voskDrivingCommandRecognizer.ensureReadyForCurrentLanguage();

    // The multilingual Whisper fallback is a complete wake path. Native KWS
    // is an acceleration path and can be retried by every explicit runtime
    // start/sync without taking fallback listening down with it.
    this.scheduleNativeKwsInitialization();
  }

  async stop(): Promise<void> {
    this.listening = false;
    this.nativeKwsAvailable = false;
    this.loggedNativeKwsFeedResult = false;
    this.lastDetectionAt = 0;
    this.nativeOnlyMode = false;
    this.speakingBargeInMode = false;
    this.drivingCommandExecution = null;
    drivingCommandFallback.reset();
    voskDrivingCommandRecognizer.reset("wakeword-stop");
    exitDrivingControlSession("wakeword-stop");
    this._state = "idle";
    const { wakePhraseFallback } = await import("./wake-phrase-fallback");
    wakePhraseFallback.setSpeakingMode(false);
    wakePhraseFallback.stop();
    recordDiagnosticEvent("runtime", "wakeword-stopped");
  }

  async acceptSamples(samples: number[], sampleRate = 16000): Promise<void> {
    const motionActive = getLooiRobotRuntimeState().motionActive;
    const drivingSessionActive = isDrivingControlSessionActive();
    const localDrivingControlActive = motionActive || drivingSessionActive;
    if (!this.listening && !localDrivingControlActive) return;

    // During an active Driving Control Session, speech is handled fully on-device
    // even while the robot is stationary after STOP. Vosk gets first priority;
    // the previous Sherpa/Whisper command recognizer remains only as a fallback
    // if the selected Vosk model is still loading or unavailable.
    if (localDrivingControlActive) {
      const acceptedByVosk = voskDrivingCommandRecognizer.acceptSamples(samples, sampleRate);
      if (!acceptedByVosk) {
        drivingCommandFallback.acceptSamples(samples, sampleRate, (command, transcript) => {
          void this.handleDrivingCommand(command, transcript);
        });
      }
    } else if (this.listening && !this.nativeOnlyMode) {
      const { wakePhraseFallback } = await import("./wake-phrase-fallback");
      wakePhraseFallback.acceptSamples(samples, sampleRate, (detection) => {
        this.notifyDetected({
          source: "whisper",
          phraseId: detection.phraseId,
          wakeSegmentSamples: detection.wakeSegmentSamples,
          commandPrerollSamples: detection.commandPrerollSamples,
          hasCommandSuffix: detection.hasCommandSuffix,
          sampleRate: detection.sampleRate,
        });
      });
    }

    if (!this.nativeKwsAvailable) return;

    try {
      const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
      const result = await sherpaVoiceAdapter.acceptKwsSamples(samples, sampleRate);
      if (result.detected || !this.loggedNativeKwsFeedResult) {
        this.loggedNativeKwsFeedResult = true;
        recordDiagnosticEvent("kws", "feed-result", {
          detected: result.detected,
          keyword: result.keyword || "(empty)",
          sampleRate,
          motionActive,
          drivingSessionActive,
        });
      }

      const keyword = String(result.keyword || "").trim().replace(/^@/, "").toUpperCase();
      if (result.detected && keyword === "STOP") {
        const detectedAt = Date.now();
        recordDiagnosticEvent("robot", "emergency-stop-kws-detected", {
          keyword: result.keyword || "STOP",
          motionActive: getLooiRobotRuntimeState().motionActive,
        });
        await stopLooiMotion("voice-emergency-kws").catch((error) => {
          recordDiagnosticEvent("robot", "emergency-stop-kws-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        if (motionActive || drivingSessionActive) {
          refreshDrivingControlSession("native-stop");
        }
        await sherpaVoiceAdapter.resetKwsStream().catch(() => undefined);
        recordDiagnosticEvent("robot", "emergency-stop-kws-finished", {
          totalStopLatencyMs: Date.now() - detectedAt,
        });
        return;
      }

      // Physical-control session owns the microphone semantics. Native LOOI KWS
      // must not open a conversational turn for the same utterance Vosk is
      // decoding as a local command. Only emergency STOP is honored above.
      if (drivingSessionActive || motionActive) return;

      if (!this.listening || !result.detected) return;

      const { kwsAudioFeeder } = await import("./kws-audio-feeder");
      const recentSamples = kwsAudioFeeder.getRecentSamples(2500);
      const currentChunkSamples = Math.min(samples.length, recentSamples.length);
      const commandPrerollStart = recentSamples.length - currentChunkSamples;
      this.notifyDetected({
        source: "kws",
        keyword: result.keyword,
        wakeSegmentSamples: recentSamples.slice(0, commandPrerollStart),
        commandPrerollSamples: recentSamples.slice(commandPrerollStart),
        sampleRate,
      }, this.nativeOnlyMode);
    } catch (error) {
      this.nativeKwsAvailable = false;
      console.warn("[Wakeword] Native KWS feed failed; selected-language Whisper fallback remains active:", error);
      this.invalidateNativeKws();
      recordDiagnosticEvent("kws", "feed-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }


  private async handleDrivingCommand(command: DrivingCommand, transcript: string): Promise<void> {
    const detectedAt = Date.now();
    recordDiagnosticEvent("robot", "driving-command-detected", {
      command: command.kind,
      direction: "direction" in command ? command.direction : "none",
      degrees: command.kind === "turn" ? command.degrees : 0,
      gesture: command.kind === "gesture" ? command.gesture : "none",
      count: command.kind === "gesture" ? command.count : 0,
      lightEnabled: command.kind === "light" ? command.enabled : "n/a",
      transcript: transcript || "(empty)",
      sessionRemainingMs: getDrivingControlSessionRemainingMs(),
    });

    if (command.kind === "exit") {
      if (getLooiRobotRuntimeState().motionActive) {
        await stopLooiMotion("driving-session-exit").catch(() => undefined);
      }
      drivingCommandFallback.reset();
      voskDrivingCommandRecognizer.reset("driving-exit");
      exitDrivingControlSession("local-exit-command");
      recordDiagnosticEvent("robot", "driving-command-finished", {
        command: "exit",
        totalLatencyMs: Date.now() - detectedAt,
      });
      // Exit phrases such as "поговорим / normal mode" hand control back to
      // conversation immediately; the next utterance does not need another wake.
      this.notifyDetected({ source: "manual" }, true);
      return;
    }

    // STOP is deliberately never serialized behind another local command.
    // Its first action clears motion state synchronously inside stopLooiMotion().
    if (command.kind === "stop") {
      drivingCommandFallback.reset();
      voskDrivingCommandRecognizer.reset("driving-stop");
      await stopLooiMotion("driving-local-stop").catch((error) => {
        recordDiagnosticEvent("robot", "driving-command-failed", {
          command: "stop",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      refreshDrivingControlSession("local-stop");
      const adapter = await getSherpaVoiceAdapter().catch(() => null);
      await adapter?.resetKwsStream().catch(() => undefined);
      recordDiagnosticEvent("robot", "driving-command-finished", {
        command: "stop",
        totalLatencyMs: Date.now() - detectedAt,
      });
      return;
    }

    // Lightweight head/light actions are allowed while translation continues.
    // They do not steal the driving command channel or send speech remotely.
    if (command.kind === "gesture") {
      void performLooiHeadGesture(command.gesture, command.count)
        .then(() => {
          refreshDrivingControlSession("local-gesture");
          recordDiagnosticEvent("robot", "driving-command-finished", {
            command: "gesture",
            gesture: command.gesture,
            count: command.count,
            totalLatencyMs: Date.now() - detectedAt,
          });
        })
        .catch((error) => {
          recordDiagnosticEvent("robot", "driving-command-failed", {
            command: "gesture",
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (command.kind === "light") {
      void setLooiLight(command.enabled)
        .then(() => {
          refreshDrivingControlSession("local-light");
          recordDiagnosticEvent("robot", "driving-command-finished", {
            command: "light",
            enabled: command.enabled,
            totalLatencyMs: Date.now() - detectedAt,
          });
        })
        .catch((error) => {
          recordDiagnosticEvent("robot", "driving-command-failed", {
            command: "light",
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (this.drivingCommandExecution) {
      recordDiagnosticEvent("robot", "driving-command-skipped", {
        reason: "command-busy",
        command: command.kind,
      });
      return;
    }

    const execution = (async () => {
      try {
        if (command.kind === "move") {
          // Arm a fresh tiny STOP decoder before the very first motor frame.
          // It remains armed until STOP/deadman/sensor-stop (health teardown)
          // rather than accumulating speech across the whole driving session.
          await voskDrivingCommandRecognizer.armEmergencyForMotion("local-move", 8_000);
          try {
            await startLooiMotion(command.direction);
          } catch (error) {
            await voskDrivingCommandRecognizer.disarmEmergency("local-move-start-failed");
            throw error;
          }
        } else if (command.kind === "turn") {
          await voskDrivingCommandRecognizer.armEmergencyForMotion(`local-turn-${command.degrees}`, 3_000);
          try {
            await turnLooi(command.direction, command.degrees);
          } finally {
            await voskDrivingCommandRecognizer.disarmEmergency("local-turn-finished");
          }
        } else if (command.kind === "dance") {
          triggerCharacterReaction("victory", { durationMs: 5_000, source: "voice-dance" });
          await voskDrivingCommandRecognizer.armEmergencyForMotion("local-dance", 10_000);
          try {
            await performLooiDance();
          } finally {
            await voskDrivingCommandRecognizer.disarmEmergency("local-dance-finished");
          }
        } else if (command.kind === "sleep") {
          await stopLooiMotion("driving-sleep").catch(() => undefined);
          exitDrivingControlSession("local-sleep");
          const { enterRobotSleepMode } = await import("../core/sleep-mode");
          await enterRobotSleepMode("voice");
        }
        if (command.kind !== "sleep") {
          refreshDrivingControlSession(`local-${command.kind}`);
        }
        recordDiagnosticEvent("robot", "driving-command-finished", {
          command: command.kind,
          direction: "direction" in command ? command.direction : "none",
          degrees: command.kind === "turn" ? command.degrees : 0,
          totalLatencyMs: Date.now() - detectedAt,
        });
      } catch (error) {
        recordDiagnosticEvent("robot", "driving-command-failed", {
          command: command.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        drivingCommandFallback.reset();
        // Wide-command cleanup remains independent from the per-motion STOP
        // decoder. Translation keeps its emergency arm until STOP/deadman/sensor
        // teardown; bounded turn/dance explicitly disarm above.
        voskDrivingCommandRecognizer.reset(`driving-${command.kind}-finished`, command.kind === "sleep");
      }
    })();
    this.drivingCommandExecution = execution;
    await execution.finally(() => {
      if (this.drivingCommandExecution === execution) this.drivingCommandExecution = null;
    });
  }

  enterDrivingControlSession(reason: string): void {
    enterDrivingControlSession(reason);
    drivingCommandFallback.reset();
    // Addressed forward/back now arms the per-motion emergency decoder before
    // the first motor frame. Preserve that active arm when the local session is
    // opened a few milliseconds later; stationary session entry resets it.
    voskDrivingCommandRecognizer.reset(
      `driving-session-enter:${reason}`,
      !getLooiRobotRuntimeState().motionActive
    );
    voskDrivingCommandRecognizer.setCommandHandler((command, transcript) => {
      void this.handleDrivingCommand(command, transcript);
    });
    void voskDrivingCommandRecognizer.ensureReadyForCurrentLanguage();
  }

  exitDrivingControlSession(reason: string): void {
    drivingCommandFallback.reset();
    voskDrivingCommandRecognizer.reset(`driving-session-exit:${reason}`);
    exitDrivingControlSession(reason);
  }

  async prepareDrivingControl(): Promise<boolean> {
    voskDrivingCommandRecognizer.setCommandHandler((command, transcript) => {
      void this.handleDrivingCommand(command, transcript);
    });
    return voskDrivingCommandRecognizer.ensureReadyForCurrentLanguage();
  }

  get isDrivingControlSessionActive(): boolean {
    return isDrivingControlSessionActive();
  }

  async setSpeakingBargeInMode(enabled: boolean): Promise<void> {
    if (this.speakingBargeInMode === enabled) return;
    this.speakingBargeInMode = enabled;
    if (enabled) {
      // The original wake that opened this turn must not suppress an immediate
      // "Луи, ..." interruption of the answer through the normal idle cooldown.
      this.lastDetectionAt = 0;
    }
    const { wakePhraseFallback } = await import("./wake-phrase-fallback");
    wakePhraseFallback.setSpeakingMode(enabled);
    if (this.nativeKwsAvailable) {
      const adapter = await getSherpaVoiceAdapter();
      await adapter.resetKwsStream().catch(() => undefined);
    }
    recordDiagnosticEvent("runtime", "wakeword-speaking-barge-in-mode", { enabled });
  }

  setNativeOnlyMode(enabled: boolean): void {
    if (this.nativeOnlyMode === enabled) return;
    this.nativeOnlyMode = enabled;
    recordDiagnosticEvent("runtime", "wakeword-native-only-mode", { enabled });
    if (enabled) {
      void import("./wake-phrase-fallback").then(({ wakePhraseFallback }) => {
        wakePhraseFallback.reset();
      });
    }
  }

  trigger(): void {
    this.notifyDetected({ source: "manual" }, true);
  }

  onWakeword(callback: WakewordCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== callback);
    };
  }

  async waitForFallbackIdle(): Promise<void> {
    const { wakePhraseFallback } = await import("./wake-phrase-fallback");
    await wakePhraseFallback.waitForIdle();
  }

  async resetFallback(): Promise<void> {
    const { wakePhraseFallback } = await import("./wake-phrase-fallback");
    wakePhraseFallback.reset();
    // Listening-language toggles are authoritative for both wake recognition
    // and the local Vosk physical-command grammar.
    void voskDrivingCommandRecognizer.ensureReadyForCurrentLanguage();
  }

  private notifyDetected(detection: WakewordDetection, bypassCooldown = false): void {
    if (!this.listening && detection.source !== "manual") return;
    const now = Date.now();
    if (!bypassCooldown && !this.speakingBargeInMode && now - this.lastDetectionAt < DETECTION_COOLDOWN_MS) {
      return;
    }

    this.lastDetectionAt = now;
    this._state = "detected";
    void import("./wake-phrase-fallback").then(({ wakePhraseFallback }) => {
      wakePhraseFallback.reset();
    });
    if (this.nativeKwsAvailable) {
      void getSherpaVoiceAdapter()
        .then((adapter) => adapter.resetKwsStream())
        .catch((error) => {
          this.nativeKwsAvailable = false;
          console.warn("[Wakeword] Native KWS reset failed; fallback remains active:", error);
          this.invalidateNativeKws();
        });
    }
    for (const listener of this.listeners) {
      listener(detection);
    }
    recordDiagnosticEvent("runtime", "wake-detected", {
      source: detection.source,
      phraseId: detection.phraseId ?? "unknown",
      keyword: detection.keyword || "(empty)",
      hasCommandSuffix: Boolean(detection.hasCommandSuffix),
    });
    this._state = this.listening ? "listening" : "idle";
  }

  get state(): WakewordState {
    return this._state;
  }

  get isNativeKwsAvailable(): boolean {
    return this.nativeKwsAvailable;
  }

  get isListening(): boolean {
    return this.listening;
  }

  private async tryInitializeNativeKws(): Promise<void> {
    try {
      await this.nativeKwsInvalidation;
      const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
      await sherpaVoiceAdapter.initializeKws();
      this.nativeKwsAvailable = this.listening;
      this.loggedNativeKwsFeedResult = false;
      recordDiagnosticEvent("kws", "native-ready", {
        listening: this.listening,
      });
    } catch (error) {
      this.nativeKwsAvailable = false;
      console.warn("[Wakeword] Native KWS unavailable; fallback remains active:", error);
      recordDiagnosticEvent("kws", "native-unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleNativeKwsInitialization(): void {
    if (this.nativeKwsAvailable || this.nativeKwsInitialization) return;

    const initialization = this.tryInitializeNativeKws();
    this.nativeKwsInitialization = initialization;
    void initialization.finally(() => {
      if (this.nativeKwsInitialization === initialization) {
        this.nativeKwsInitialization = null;
      }
    });
  }

  private invalidateNativeKws(): void {
    if (this.nativeKwsInvalidation) return;

    const invalidation = getSherpaVoiceAdapter()
      .then((adapter) => adapter.releaseKws())
      .catch(() => undefined);
    this.nativeKwsInvalidation = invalidation;
    void invalidation.finally(() => {
      if (this.nativeKwsInvalidation === invalidation) {
        this.nativeKwsInvalidation = null;
      }
    });
  }
}

export const wakewordService = new WakewordService();
