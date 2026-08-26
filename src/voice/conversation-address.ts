export type ConversationAddressAlias = "looi" | "max" | "robot";

export type ConversationAddressNormalization = {
  transcript: string;
  stripped: boolean;
  alias?: ConversationAddressAlias;
};

const ADDRESS_PREFIX_RE = /^\s*(?:(?:привет|привіт|hey|hi)\s*[,!]?\s*)?(?<address>луи|луй|луї|луі|лу\s*[,.;:\-–—]?\s*и|looi|louie|loui|макс|max|робот|robot)(?=$|[\s,.!?;:\-–—])\s*[,!?.;:\-–—]?\s*(?<rest>.+?)\s*$/iu;

function classifyAlias(address: string): ConversationAddressAlias {
  const normalized = address
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-zа-яіїєґ]+/giu, "");

  if (normalized === "макс" || normalized === "max") return "max";
  if (normalized === "робот" || normalized === "robot") return "robot";
  return "looi";
}

/**
 * Conversational wake/address names are routing aliases, not user content.
 * Strip a leading address before memory retrieval / intent / LLM generation so
 * "Макс, я Лёша" cannot accidentally teach the model that Max is a separate
 * assistant identity. Deterministic physical-command parsing runs before this.
 */
export function normalizeConversationTranscriptForAssistant(
  transcript: string
): ConversationAddressNormalization {
  const trimmed = transcript.trim();
  const match = ADDRESS_PREFIX_RE.exec(trimmed);
  const rest = match?.groups?.rest?.trim();
  if (!match?.groups?.address || !rest) {
    return { transcript: trimmed, stripped: false };
  }

  return {
    transcript: rest,
    stripped: true,
    alias: classifyAlias(match.groups.address),
  };
}
