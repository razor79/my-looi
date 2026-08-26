import type { MemoryResult } from "../core/context-service";
import { normalizeMemorySearchText } from "./local-memory-search";

export const SMALL_MEMORY_FULL_CONTEXT_MAX_FACTS = 48;
export const SMALL_MEMORY_FULL_CONTEXT_MAX_CHARS = 12_000;
export const LARGE_MEMORY_CONTEXT_MAX_FACTS = 10;
export const LARGE_MEMORY_CONTEXT_MAX_CHARS = 8_000;

const LEGACY_SUMMARY_PREFIX = /^\s*(?:conversation\s+summary|summary|краткое\s+содержание\s+разговора|резюме\s+разговора)\s*:\s*/iu;

export function cleanMemoryForConversation(memory: MemoryResult): MemoryResult {
  const cleaned = memory.memory.replace(LEGACY_SUMMARY_PREFIX, "").trim();
  return cleaned === memory.memory
    ? memory
    : { ...memory, memory: cleaned };
}

function memoryDedupeKey(memory: MemoryResult): string {
  return normalizeMemorySearchText(memory.memory);
}

export function mergeMemoryCandidates(
  primary: MemoryResult[],
  secondary: MemoryResult[],
  maxFacts = LARGE_MEMORY_CONTEXT_MAX_FACTS,
  maxChars = LARGE_MEMORY_CONTEXT_MAX_CHARS
): MemoryResult[] {
  const merged: MemoryResult[] = [];
  const seen = new Set<string>();
  let chars = 0;

  for (const raw of [...primary, ...secondary]) {
    const memory = cleanMemoryForConversation(raw);
    if (!memory.memory) continue;
    const key = memoryDedupeKey(memory);
    if (!key || seen.has(key)) continue;
    if (merged.length >= maxFacts) break;
    if (merged.length > 0 && chars + memory.memory.length > maxChars) continue;
    seen.add(key);
    chars += memory.memory.length;
    merged.push(memory);
  }

  return merged;
}

export function canUseBoundedFullMemoryContext(memories: MemoryResult[]): boolean {
  if (memories.length > SMALL_MEMORY_FULL_CONTEXT_MAX_FACTS) return false;
  const chars = memories.reduce((sum, memory) => sum + memory.memory.length, 0);
  return chars <= SMALL_MEMORY_FULL_CONTEXT_MAX_CHARS;
}

export function buildBoundedFullMemoryContext(memories: MemoryResult[]): MemoryResult[] {
  if (!canUseBoundedFullMemoryContext(memories)) return [];
  return mergeMemoryCandidates(
    memories,
    [],
    SMALL_MEMORY_FULL_CONTEXT_MAX_FACTS,
    SMALL_MEMORY_FULL_CONTEXT_MAX_CHARS
  );
}
