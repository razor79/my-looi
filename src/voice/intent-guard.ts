import type { UserIntent } from "../core/context-service";

const MEMORY_SEARCH_RE = /(?:(?:ты\s+)?помнишь(?:\s+ли)?|вспомни|(?:где|куда)\s+(?:я\s+)?(?:положил(?:а)?|оставил(?:а)?|спрятал(?:а)?)|где\s+(?:(?:лежит|стоит)\s+)?(?:мой|моя|моё|мои)|не\s+могу\s+найти\s+(?:мой|мою|моё|мои|свой|свою|свои)|(?:ти\s+)?пам['’]?ятаєш(?:\s+чи)?|згадай|(?:де|куди)\s+(?:я\s+)?(?:поклав|поклала|залишив|залишила|сховав|сховала)|де\s+(?:(?:лежить|стоїть)\s+)?(?:мій|моя|моє|мої)|не\s+можу\s+знайти\s+(?:мій|мою|моє|мої|свій|свою|свої)|\bdo\s+you\s+remember\b|\bwhat\s+did\s+i\s+(?:say|tell\s+you|put|place|leave)\b|\bwhere\s+did\s+i\s+(?:put|place|leave)\b|\bwhere\s+(?:is|are)\s+my\b|\b(?:can['’]?t|cannot)\s+find\s+my\b)/i;

const MEMORY_STORE_RE = /(?:^|[.!?]\s*)(?:(?:looi|louie|loui|луи|луї)\s*[,!]?\s*)?(?:(?:пожалуйста|будь\s+ласка|please)\s+)?(?:запомни|запам['’]?ятай|remember\s+(?:this|that)|save\s+(?:this|that)|keep\s+(?:this|that)\s+in\s+mind)|я\s+(?:положил(?:а)?|оставил(?:а)?|спрятал(?:а)?)|я\s+(?:поклав|поклала|залишив|залишила|сховав|сховала)|\bi\s+(?:put|placed|left)\b|(?:мой|моя|моё|мои|мій|моя|моє|мої).{0,80}(?:лежит|стоит|находится|лежить|стоїть|знаходиться)/i;

export type GuardedVoiceIntent = {
  intent: UserIntent;
  corrected: boolean;
  reason?: "non-explicit-memory-search" | "non-explicit-memory-store";
};

export function guardVoiceIntent(transcript: string, intent: UserIntent): GuardedVoiceIntent {
  if (intent === "search" && !MEMORY_SEARCH_RE.test(transcript)) {
    return { intent: "chat", corrected: true, reason: "non-explicit-memory-search" };
  }
  if (intent === "store" && !MEMORY_STORE_RE.test(transcript)) {
    return { intent: "chat", corrected: true, reason: "non-explicit-memory-store" };
  }
  return { intent, corrected: false };
}
