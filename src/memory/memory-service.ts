import type { ChatMessage, ContextService, MemoryResult, SessionSummary } from "../core/context-service";
import type { MemoryCategory } from "../core/observation";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import {
  buildBoundedFullMemoryContext,
  canUseBoundedFullMemoryContext,
} from "./conversation-memory-context";
import {
  ensureLocalMemoryReady,
  localMemoryDatabase,
  type LocalMemoryBackupV1,
  type LocalMemoryRestoreStats,
  type LocalMemoryStats,
} from "./local-memory-database";

/**
 * v2.1.100: Local SQLite is the only long-term memory backend.
 *
 * The old remote shadow, migration switch and semantic bridge are retired.
 * Realtime/PCM stores durable facts through the local `remember` tool and reads
 * them through this service. No memory operation here performs network I/O.
 */
export const memoryService: ContextService = {
  async remember(messages, metadata) {
    await localMemoryDatabase.remember(messages, metadata);
  },

  async search(query, filters) {
    const results = await localMemoryDatabase.search(query, filters);
    recordDiagnosticEvent("memory", "memory-backend-search", {
      backend: "local",
      category: filters?.category ?? "all",
      results: results.length,
    });
    return results;
  },

  async getAll(filters) {
    return localMemoryDatabase.getAll(filters);
  },
};

/**
 * Build generic memory context for a conversational turn from Local SQLite.
 *
 * For a small memory set, ordinary chat gets the complete bounded fact set.
 * Explicit memory questions and larger stores use local FTS relevance search.
 * There is deliberately no remote semantic fallback anymore.
 */
export async function retrieveConversationMemories(
  query: string,
  options: {
    filters?: { category?: MemoryCategory };
    mode?: "ambient" | "relevant";
  } = {}
): Promise<{ facts: MemoryResult[]; strategy: string }> {
  const filters = options.filters;
  const mode = options.mode ?? "ambient";
  const allLocal = await localMemoryDatabase.getAll(filters);

  if (mode === "ambient" && canUseBoundedFullMemoryContext(allLocal)) {
    const facts = buildBoundedFullMemoryContext(allLocal);
    recordDiagnosticEvent("memory", "conversation-memory-context", {
      mode,
      strategy: "bounded-full-local",
      localCount: allLocal.length,
      results: facts.length,
    });
    return { facts, strategy: "bounded-full-local" };
  }

  const facts = await localMemoryDatabase.search(query, filters);
  recordDiagnosticEvent("memory", "conversation-memory-context", {
    mode,
    strategy: "local-fts",
    localCount: allLocal.length,
    results: facts.length,
  });
  return { facts, strategy: "local-fts" };
}

export async function getLocalMemoryStats(): Promise<LocalMemoryStats> {
  return ensureLocalMemoryReady();
}

export async function listLocalConversationSessions(
  options: { limit?: number; offset?: number } = {}
): Promise<SessionSummary[]> {
  await ensureLocalMemoryReady();
  return localMemoryDatabase.listConversationSessions(options);
}

export async function getLocalConversationMessages(sessionId: string): Promise<ChatMessage[]> {
  await ensureLocalMemoryReady();
  return localMemoryDatabase.getConversationMessages(sessionId);
}

export async function exportLocalMemoryBackup(): Promise<LocalMemoryBackupV1> {
  return localMemoryDatabase.exportBackup();
}

export async function restoreLocalMemoryBackup(value: unknown): Promise<LocalMemoryRestoreStats> {
  return localMemoryDatabase.restoreBackup(value);
}

export function mirrorSessionTouch(
  sessionId: string,
  source: "classic" | "realtime" | "system"
): void {
  void localMemoryDatabase.touchSession(sessionId, source).catch((error) => {
    recordDiagnosticEvent("memory", "local-history-touch-failed", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function mirrorSessionMessage(
  sessionId: string,
  message: { role: "user" | "assistant"; content: string; evidenceUri?: string }
): void {
  void localMemoryDatabase.addSessionMessage(sessionId, message).catch((error) => {
    recordDiagnosticEvent("memory", "local-history-message-failed", {
      role: message.role,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function searchLocalMemoryForDiagnostics(
  query: string,
  category?: MemoryCategory
): Promise<MemoryResult[]> {
  return localMemoryDatabase.search(query, category ? { category } : undefined);
}
