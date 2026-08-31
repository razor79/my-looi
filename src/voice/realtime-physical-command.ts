import { enterRobotSleepMode } from "../core/sleep-mode";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import {
  moveLooi,
  performLooiDance,
  performLooiHeadGesture,
  stopLooiMotion,
  turnLooi,
} from "../device-tools/looi-robot";
import { useUserStore, type UserPreferences } from "../store/user";
import {
  containsEmergencyStopWord,
  parseExplicitRobotCommand,
  type ExplicitRobotCommand,
} from "./explicit-robot-command";

export type RealtimePhysicalCommand =
  | { kind: "emergency-stop" }
  | { kind: "explicit"; command: ExplicitRobotCommand };

export type RealtimePhysicalCommandResult = {
  handled: true;
  ok: boolean;
  acknowledgement: string;
  commandKind: string;
};

type VoiceCommandPreferences = Pick<UserPreferences,
  "robotName" | "robotAddressAliases" | "robotAddressRecognitionAliases" | "listeningLanguage" | "customVoiceCommands"
>;

export function parseRealtimePhysicalCommand(
  transcript: string,
  preferenceSnapshot?: VoiceCommandPreferences
): RealtimePhysicalCommand | null {
  const preferences = preferenceSnapshot ?? useUserStore.getState().preferences;
  const config = {
    robotName: preferences.robotName,
    robotAddressAliases: preferences.robotAddressAliases,
    robotAddressRecognitionAliases: preferences.robotAddressRecognitionAliases,
    listeningLanguage: preferences.listeningLanguage,
    customVoiceCommands: preferences.customVoiceCommands,
  };
  if (containsEmergencyStopWord(transcript, config)) return { kind: "emergency-stop" };
  const command = parseExplicitRobotCommand(transcript, config);
  return command ? { kind: "explicit", command } : null;
}

function responseLanguage(): "ru" | "uk" | "en" {
  const language = useUserStore.getState().preferences.language;
  return language === "uk" || language === "en" ? language : "ru";
}

function acknowledgementFor(command: RealtimePhysicalCommand, ok: boolean): string {
  const language = responseLanguage();
  if (!ok) {
    return language === "en" ? "I couldn't do that." : language === "uk" ? "Не вдалося це зробити." : "Не получилось это сделать.";
  }
  if (command.kind === "emergency-stop") {
    return language === "en" ? "Stopped." : language === "uk" ? "Зупинився." : "Остановился.";
  }
  const value = command.command;
  if (value.kind === "sleep") {
    return language === "en" ? "Good night." : language === "uk" ? "На добраніч." : "Спокойной ночи.";
  }
  if (value.kind === "gesture") {
    if (language === "en") return value.count > 1 ? `Nodded ${value.count} times.` : "Nodded.";
    if (language === "uk") return value.count > 1 ? `Кивнув ${value.count} рази.` : "Кивнув.";
    return value.count > 1 ? `Кивнул ${value.count} раза.` : "Кивнул.";
  }
  if (value.kind === "dance") {
    return language === "en" ? "Done!" : language === "uk" ? "Готово!" : "Готово!";
  }
  if (value.kind === "turn") {
    if (language === "en") return value.degrees === 180 ? "Turned around." : value.direction === "left" ? "Turned left." : "Turned right.";
    if (language === "uk") return value.degrees === 180 ? "Розвернувся." : value.direction === "left" ? "Повернув ліворуч." : "Повернув праворуч.";
    return value.degrees === 180 ? "Развернулся." : value.direction === "left" ? "Повернул налево." : "Повернул направо.";
  }
  if (value.direction === "stop") {
    return language === "en" ? "Stopped." : language === "uk" ? "Зупинився." : "Остановился.";
  }
  if (language === "en") return value.direction === "forward" ? "Moved forward." : "Moved backward.";
  if (language === "uk") return value.direction === "forward" ? "Проїхав уперед." : "Проїхав назад.";
  return value.direction === "forward" ? "Проехал вперёд." : "Проехал назад.";
}

/**
 * Execute only deterministic, explicitly addressed physical commands intercepted
 * from the Realtime input transcription. Realtime itself receives no movement
 * tool. Forward/backward motion is deliberately bounded so PCM can retain the
 * microphone without depending on a second local driving recognizer for STOP.
 */
export async function executeRealtimePhysicalCommand(
  parsed: RealtimePhysicalCommand,
  transcript: string
): Promise<RealtimePhysicalCommandResult> {
  const commandKind = parsed.kind === "emergency-stop" ? "emergency-stop" : parsed.command.kind;
  recordDiagnosticEvent("robot", "realtime-physical-command", {
    commandKind,
    transcriptLength: transcript.length,
    bounded: parsed.kind === "explicit" && parsed.command.kind === "move" && parsed.command.direction !== "stop",
  });

  try {
    if (parsed.kind === "emergency-stop") {
      await stopLooiMotion("realtime-pcm-emergency-transcript");
    } else {
      const command = parsed.command;
      if (command.kind === "sleep") {
        await enterRobotSleepMode("voice");
      } else if (command.kind === "gesture") {
        await performLooiHeadGesture(command.gesture, command.count);
      } else if (command.kind === "dance") {
        await performLooiDance("random");
      } else if (command.kind === "turn") {
        await turnLooi(command.direction, command.degrees);
      } else if (command.direction === "stop") {
        await stopLooiMotion("realtime-pcm-explicit-stop");
      } else {
        // Keep Realtime PCM as the sole microphone owner. A short bounded move
        // preserves the existing cliff/TOF interlocks and avoids continuous
        // motion that would require handing the microphone to local STOP ASR.
        await moveLooi(command.direction);
      }
    }
    const acknowledgement = acknowledgementFor(parsed, true);
    recordDiagnosticEvent("robot", "realtime-physical-command-finished", { commandKind, ok: true });
    return { handled: true, ok: true, acknowledgement, commandKind };
  } catch (error) {
    recordDiagnosticEvent("robot", "realtime-physical-command-finished", {
      commandKind,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return { handled: true, ok: false, acknowledgement: acknowledgementFor(parsed, false), commandKind };
  }
}
