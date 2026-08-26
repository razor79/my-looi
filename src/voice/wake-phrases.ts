export type WakePhraseId = "ru" | "uk" | "en";

export type WakePhraseDefinition = {
  id: WakePhraseId;
  displayText: string;
  keywordLabel: string;
  keywordAliases: readonly string[];
};

export type WakePhraseMatch = {
  id: WakePhraseId;
  displayText: string;
  commandSuffix: string;
  hasCommandSuffix: boolean;
};

/**
 * LOOI uses one spoken wake name across languages. The separate IDs are kept
 * for language-specific diagnostics and Whisper recovery attempts.
 */
export const WAKE_PHRASES: readonly WakePhraseDefinition[] = [
  {
    id: "ru",
    displayText: "Луи",
    keywordLabel: "LOOI",
    keywordAliases: ["LOOI_PALATALIZED"],
  },
  {
    id: "uk",
    displayText: "Луї",
    keywordLabel: "LOOI",
    keywordAliases: ["LOOI_PALATALIZED"],
  },
  {
    id: "en",
    displayText: "LOOI",
    keywordLabel: "LOOI",
    keywordAliases: ["LOOI_PALATALIZED"],
  },
] as const;

const PHRASE_PATTERNS: Record<WakePhraseId, RegExp> = {
  // Include common short-utterance Whisper confusions observed with short noisy device utterances.
  ru: /(?:^|\s)(?:луи|луин|луй|лу\s+и|луе|лує|лоуи|руи|уи|уй|макс|max|робот|louie|loui|looi|louis|wooi|wui)(?=\s|$)/u,
  uk: /(?:^|\s)(?:луї|луїн|луі|луин|луй|лу\s+и|лує|луе|лоуї|луи|уи|уй|макс|max|робот|louie|loui|looi|louis|wooi|wui)(?=\s|$)/u,
  en: /(?:^|\s)(?:looi|louie|loui|louis|wooi|wui|луи|луин|луй|лу\s+и|луї|луі|лує|луе|уи|уй|макс|max|робот)(?=\s|$)/u,
};

export function normalizeWakePhraseTranscript(transcript: string): string {
  return transcript
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/ё/g, "е")
    .replace(/[’'`]/g, "")
    .replace(/[^a-zа-яіїєґ\s]/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchWakePhrase(
  transcript: string,
  expectedId?: WakePhraseId
): WakePhraseMatch | null {
  const normalized = normalizeWakePhraseTranscript(transcript);
  const phrases = expectedId
    ? WAKE_PHRASES.filter((phrase) => phrase.id === expectedId)
    : WAKE_PHRASES;

  for (const phrase of phrases) {
    const match = PHRASE_PATTERNS[phrase.id].exec(normalized);
    if (match) {
      const commandSuffix = normalized.slice(match.index + match[0].length).trim();
      return {
        id: phrase.id,
        displayText: phrase.displayText,
        commandSuffix,
        hasCommandSuffix: commandSuffix.length > 0,
      };
    }
  }

  return null;
}

export function matchesWakePhraseKeyword(
  phraseId: WakePhraseId,
  keyword: string
): boolean {
  const normalized = keyword.trim().replace(/^@/, "");
  const phrase = WAKE_PHRASES.find((item) => item.id === phraseId);
  return Boolean(
    phrase &&
      (normalized === phrase.keywordLabel || phrase.keywordAliases.includes(normalized))
  );
}
