import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import {
  matchWakePhrase,
  type WakePhraseId,
  type WakePhraseMatch,
} from "./wake-phrases";
import type { WhisperLanguageHint } from "./sherpa-adapter";
import { useUserStore } from "../store/user";

export type WakePhraseRecognitionAttempt = {
  language: "auto" | "ru" | "uk" | "en";
  transcript: string;
  matched: boolean;
};

export type WakePhraseRecognition = {
  match: WakePhraseMatch | null;
  transcript: string;
  language: WakePhraseRecognitionAttempt["language"];
  attempts: WakePhraseRecognitionAttempt[];
};

const LANGUAGE_BY_PHRASE: Record<WakePhraseId, Exclude<WhisperLanguageHint, "">> = {
  ru: "ru",
  uk: "uk",
  en: "en",
};

function languageCandidates(expectedId?: WakePhraseId): WhisperLanguageHint[] {
  if (expectedId) return [LANGUAGE_BY_PHRASE[expectedId]];

  // The listening-language toggle is authoritative. Wake recognition runs only
  // in the selected language; never add an automatic-language retry that can
  // stall the microphone for several seconds on every miss.
  const selected = useUserStore.getState().preferences.listeningLanguage;
  return [selected];
}

export async function recognizeWakePhraseSamples(
  samples: number[],
  sampleRate: number,
  expectedId?: WakePhraseId
): Promise<WakePhraseRecognition> {
  const { sherpaVoiceAdapter } = await import("./sherpa-adapter");
  const attempts: WakePhraseRecognitionAttempt[] = [];

  for (const language of languageCandidates(expectedId)) {
    const transcript = await sherpaVoiceAdapter.transcribeSamplesWithLanguage(
      samples,
      sampleRate,
      language
    );
    const match = matchWakePhrase(transcript, expectedId);
    const label = language || "auto";
    attempts.push({ language: label, transcript, matched: Boolean(match) });
    recordDiagnosticEvent("whisper", "wake-attempt", {
      language: label,
      transcript: transcript || "(empty)",
      expectedPhrase: expectedId ?? "any",
      matched: Boolean(match),
    });
    if (match) {
      return { match, transcript, language: label, attempts };
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    match: null,
    transcript: last?.transcript ?? "",
    language: last?.language ?? "auto",
    attempts,
  };
}

export function formatWakeRecognitionAttempts(
  attempts: WakePhraseRecognitionAttempt[]
): string {
  return attempts
    .map((attempt) => `${attempt.language}:${attempt.transcript || "(empty)"}`)
    .join("; ");
}
