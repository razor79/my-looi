import type { ResponseLanguage } from "./response-language";

export type ListeningLanguage = "ru" | "uk" | "en";

export const DEFAULT_LISTENING_LANGUAGE: ListeningLanguage = "ru";

export const LISTENING_LANGUAGE_OPTIONS: ReadonlyArray<{
  id: ListeningLanguage;
  shortLabel: string;
  label: string;
}> = [
  { id: "ru", shortLabel: "RU", label: "Русский" },
  { id: "uk", shortLabel: "UA", label: "Українська" },
  { id: "en", shortLabel: "EN", label: "English" },
];

export function normalizeListeningLanguage(value: unknown): ListeningLanguage {
  return value === "uk" || value === "en" || value === "ru"
    ? value
    : DEFAULT_LISTENING_LANGUAGE;
}

const LANGUAGE_TARGETS: Array<{ language: ListeningLanguage; pattern: RegExp }> = [
  { language: "ru", pattern: /(?:русск(?:ий|ом|ого)|російськ(?:у|ою)|russian)/u },
  { language: "uk", pattern: /(?:украинск(?:ий|ом|ого)|українськ(?:у|ою)|ukrainian)/u },
  { language: "en", pattern: /(?:английск(?:ий|ом|ого)|англійськ(?:у|ою)|english)/u },
];

/**
 * Change the language LOOI expects from the user. This intentionally does not
 * change the language used for responses.
 */
export function detectListeningLanguageSwitchCommand(transcript: string): ListeningLanguage | null {
  const normalized = transcript
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const isListeningCommand =
    /^(?:(?:пожалуйста|будь\s+ласка|please)\s+)?(?:переключи|смени|поменяй|выбери|установи|зміни|перемкни|обери|change|switch|set)\s+(?:язык|мову|language)(?!\s+(?:ответов|відповідей|response))(?:\s+(?:распознавания|ввода|слушания|розпізнавання|вводу|listening|input))?(?=$|\s)/u.test(normalized) ||
    /^(?:(?:пожалуйста|будь\s+ласка|please)\s+)?(?:перейди|перейти|switch)\s+(?:на|to)(?=$|\s)/u.test(normalized) ||
    /^(?:(?:пожалуйста|будь\s+ласка|please)\s+)?(?:слушай|слухай|понимай|розпізнавай|распознавай|listen|understand)(?=$|\s)/u.test(normalized) ||
    /^(?:(?:язык|мова|language)\s+(?:ввода|слушания|распознавания|вводу|розпізнавання|input|listening)(?=$|\s))/u.test(normalized);

  if (!isListeningCommand) return null;
  return LANGUAGE_TARGETS.find(({ pattern }) => pattern.test(normalized))?.language ?? null;
}

export function getListeningLanguageSwitchAcknowledgement(
  listeningLanguage: ListeningLanguage,
  responseLanguage: ResponseLanguage
): string {
  const target = listeningLanguage === "uk"
    ? responseLanguage === "en" ? "Ukrainian" : responseLanguage === "uk" ? "українську" : "украинский"
    : listeningLanguage === "en"
      ? responseLanguage === "en" ? "English" : responseLanguage === "uk" ? "англійську" : "английский"
      : responseLanguage === "en" ? "Russian" : responseLanguage === "uk" ? "російську" : "русский";

  if (responseLanguage === "en") return `Okay, I'll listen for ${target}.`;
  if (responseLanguage === "uk") return `Добре, тепер слухаю ${target}.`;
  return `Хорошо, теперь слушаю ${target}.`;
}
