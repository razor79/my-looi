import type { InterfaceLanguage } from "../i18n/ui-language";
export const DEFAULT_REALTIME_MODEL_ID = "gpt-realtime-2.1-mini";

export type OpenAiRealtimeModel = {
  id: string;
  created: number | null;
  ownedBy: string | null;
};

export type RealtimeConversationCostEstimate = {
  usdPerMinute: number;
  audioInputUsdPerMillion: number;
  audioOutputUsdPerMillion: number;
};

const DATED_SNAPSHOT_RE = /-\d{4}-\d{2}-\d{2}$/;

const OFFICIALLY_DEPRECATED_REALTIME_MODEL_BASES = [
  "gpt-realtime-mini",
  "gpt-realtime",
] as const;

const PREVIOUS_SUPPORTED_REALTIME_MODEL_BASES = [
  "gpt-realtime-2",
  "gpt-realtime-1.5",
] as const;

export function isRealtimeConversationModelId(value: string): boolean {
  const id = value.trim().toLowerCase();
  return id.startsWith("gpt-realtime") &&
    !id.includes("translate") &&
    !id.includes("transcrib") &&
    !id.includes("whisper");
}

function matchesModelBaseOrDatedSnapshot(id: string, base: string): boolean {
  const normalized = id.trim().toLowerCase();
  return normalized === base || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}$`).test(normalized);
}

export function isOfficiallyDeprecatedRealtimeModelId(value: string): boolean {
  return OFFICIALLY_DEPRECATED_REALTIME_MODEL_BASES.some((base) => matchesModelBaseOrDatedSnapshot(value, base));
}

export function isPreviousSupportedRealtimeModelId(value: string): boolean {
  return PREVIOUS_SUPPORTED_REALTIME_MODEL_BASES.some((base) => matchesModelBaseOrDatedSnapshot(value, base));
}

export function normalizeRealtimeModelId(value: unknown): string {
  return typeof value === "string" && isRealtimeConversationModelId(value)
    ? value.trim()
    : DEFAULT_REALTIME_MODEL_ID;
}

export function preferRealtimeModelAliases(models: readonly OpenAiRealtimeModel[]): OpenAiRealtimeModel[] {
  const ids = new Set(models.map((model) => model.id));
  return models.filter((model) => {
    if (!DATED_SNAPSHOT_RE.test(model.id)) return true;
    const alias = model.id.replace(DATED_SNAPSHOT_RE, "");
    return !ids.has(alias);
  });
}

export function formatRealtimeModelName(id: string): string {
  const normalized = id.toLowerCase();
  if (normalized === "gpt-realtime-2.1-mini") return "GPT Realtime 2.1 Mini";
  if (normalized === "gpt-realtime-2.1") return "GPT Realtime 2.1";
  if (normalized === "gpt-realtime-2") return "GPT Realtime 2";
  if (normalized === "gpt-realtime-1.5") return "GPT Realtime 1.5";
  if (normalized === "gpt-realtime-mini") return "GPT Realtime Mini";
  if (normalized === "gpt-realtime") return "GPT Realtime";
  return id;
}

export function supportsRealtimeReasoning(id: string): boolean {
  return /^gpt-realtime-2(?:\.|-|$)/i.test(id);
}

/**
 * Approximate audio-only cost for one minute of balanced conversation:
 * 30 s user speech + 30 s LOOI speech. OpenAI's published Realtime conversion
 * is approximately 10 audio tokens/s for input and 20 audio tokens/s for output.
 * Pricing itself is not returned by GET /v1/models, so only model families with
 * an explicitly known official rate get an estimate.
 */
export function estimateRealtimeConversationCost(id: string): RealtimeConversationCostEstimate | null {
  const pricing = getKnownAudioPricing(id);
  if (!pricing) return null;
  const inputTokens = 30 * 10;
  const outputTokens = 30 * 20;
  return {
    ...pricing,
    usdPerMinute:
      (inputTokens * pricing.audioInputUsdPerMillion + outputTokens * pricing.audioOutputUsdPerMillion) / 1_000_000,
  };
}

function getKnownAudioPricing(id: string): Omit<RealtimeConversationCostEstimate, "usdPerMinute"> | null {
  const normalized = id.trim().toLowerCase();
  const isExactOrDatedSnapshot = (base: string) => matchesModelBaseOrDatedSnapshot(normalized, base);

  if (isExactOrDatedSnapshot("gpt-realtime-2.1-mini")) {
    return { audioInputUsdPerMillion: 10, audioOutputUsdPerMillion: 20 };
  }
  if (
    isExactOrDatedSnapshot("gpt-realtime-2.1") ||
    isExactOrDatedSnapshot("gpt-realtime-2") ||
    isExactOrDatedSnapshot("gpt-realtime-1.5") ||
    isExactOrDatedSnapshot("gpt-realtime")
  ) {
    return { audioInputUsdPerMillion: 32, audioOutputUsdPerMillion: 64 };
  }
  return null;
}

export function formatConversationCostPerMinute(
  id: string,
  language: InterfaceLanguage = "ru"
): string | null {
  const estimate = estimateRealtimeConversationCost(id);
  if (!estimate) return null;
  const roundedCents = Math.round(estimate.usdPerMinute * 100 + 1e-9) / 100;
  const suffix = language === "uk" ? "хв розмови" : language === "en" ? "min conversation" : "мин разговора";
  return `≈ $${roundedCents.toFixed(2)}/${suffix}`;
}
