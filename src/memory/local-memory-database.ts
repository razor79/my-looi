import * as SQLite from "expo-sqlite";
import type { ChatMessage, Message, MemoryResult, SessionSummary } from "../core/context-service";
import type { MemoryCategory, ObservationMetadata } from "../core/observation";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { buildMemoryFtsQuery, buildRelaxedMemoryFtsQuery, normalizeMemorySearchText } from "./local-memory-search";

const DATABASE_NAME = "looi-memory-v2.db";
const SCHEMA_VERSION = 1;
const MAX_SEARCH_RESULTS = 12;

export type LocalMemoryStats = {
  schemaVersion: number;
  memoryCount: number;
  sessionCount: number;
  messageCount: number;
};

export type LocalMemoryRestoreStats = {
  memoryCount: number;
  sessionCount: number;
  messageCount: number;
  profileCount: number;
};


export type LocalMemoryBackupV1 = {
  format: "super-looi-local-memory";
  version: 1;
  exportedAt: string;
  schemaVersion: number;
  memories: LocalMemoryBackupMemory[];
  sessions: LocalMemoryBackupSession[];
  messages: LocalMemoryBackupMessage[];
  profile: Record<string, string>;
};

type LocalMemoryBackupMemory = {
  id: string;
  memory: string;
  category: MemoryCategory;
  source: string;
  timestamp: string;
  createdAt: string;
  updatedAt: string;
  confidence?: number;
  location?: string;
  evidenceUri?: string;
  description?: string;
  placementFact?: string;
  serverId?: string;
  syncState: string;
};

type LocalMemoryBackupSession = {
  id: string;
  source: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  summary?: string;
};

type LocalMemoryBackupMessage = {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  evidenceUri?: string;
  createdAt: string;
};

type MemoryRow = {
  id: string;
  memory: string;
  normalized: string;
  category: MemoryCategory;
  source: string;
  timestamp: string;
  created_at: string;
  updated_at: string;
  confidence: number | null;
  location: string | null;
  evidence_uri: string | null;
  description: string | null;
  placement_fact: string | null;
  server_id: string | null;
  sync_state: string;
};

type CountRow = { count: number };

type SessionRow = {
  id: string;
  source: string;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  summary: string | null;
};

type MessageRow = {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  evidence_uri: string | null;
  created_at: string;
};

type LocalSessionSummaryRow = SessionRow & {
  message_count: number;
  derived_summary: string | null;
};

type ProfileRow = { key: string; value: string };

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = openAndMigrateDatabase().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function openAndMigrateDatabase(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY NOT NULL,
      memory TEXT NOT NULL,
      normalized TEXT NOT NULL,
      category TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      confidence REAL,
      location TEXT,
      evidence_uri TEXT,
      description TEXT,
      placement_fact TEXT,
      server_id TEXT UNIQUE,
      sync_state TEXT NOT NULL DEFAULT 'local-only'
    );

    CREATE INDEX IF NOT EXISTS memories_category_idx ON memories(category);
    CREATE INDEX IF NOT EXISTS memories_timestamp_idx ON memories(timestamp DESC);
    CREATE INDEX IF NOT EXISTS memories_server_id_idx ON memories(server_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      memory,
      normalized,
      content='memories',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, memory, normalized)
      VALUES (new.rowid, new.memory, new.normalized);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, memory, normalized)
      VALUES ('delete', old.rowid, old.memory, old.normalized);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, memory, normalized)
      VALUES ('delete', old.rowid, old.memory, old.normalized);
      INSERT INTO memories_fts(rowid, memory, normalized)
      VALUES (new.rowid, new.memory, new.normalized);
    END;

    CREATE TABLE IF NOT EXISTS conversation_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      evidence_uri TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS conversation_messages_session_idx
      ON conversation_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS profile_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await db.runAsync(
    "INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)",
    "schema_version",
    String(SCHEMA_VERSION)
  );
  recordDiagnosticEvent("memory", "local-db-ready", {
    database: DATABASE_NAME,
    schemaVersion: SCHEMA_VERSION,
  });
  return db;
}

function makeLocalId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function memoryTextFromMessages(messages: Message[]): string {
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  if (userMessages.length > 0) return userMessages.join("\n");
  return messages.map((message) => message.content.trim()).filter(Boolean).join("\n");
}

const MAX_BACKUP_CATEGORY_LENGTH = 128;
const BACKUP_CATEGORY_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Memory categories are semantic tags, not a closed enum. The AI/server may
 * create new tags at any time, so backup/restore must preserve a legitimate
 * category string unchanged instead of rewriting it into our built-in taxonomy.
 */
function validateBackupMemoryCategory(rawCategory: string, index?: number): MemoryCategory {
  const invalid =
    rawCategory.length > MAX_BACKUP_CATEGORY_LENGTH ||
    BACKUP_CATEGORY_CONTROL_CHARS.test(rawCategory);
  if (!invalid) return rawCategory as MemoryCategory;
  throw new Error(
    index === undefined
      ? `Invalid memory category: ${rawCategory}`
      : `Invalid memory category at index ${index}`
  );
}
const BACKUP_PROFILE_BLOCKED_KEY = /(api[_-]?key|token|secret|password|credential|authorization)/i;
const MAX_BACKUP_MEMORIES = 10_000;
const MAX_BACKUP_SESSIONS = 10_000;
const MAX_BACKUP_MESSAGES = 100_000;
const MAX_BACKUP_TEXT_LENGTH = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid local-memory backup: ${key} must be a non-empty string`);
  }
  if (value.length > MAX_BACKUP_TEXT_LENGTH) {
    throw new Error(`Invalid local-memory backup: ${key} is too large`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid local-memory backup: ${key} must be a string`);
  }
  if (value.length > MAX_BACKUP_TEXT_LENGTH) {
    throw new Error(`Invalid local-memory backup: ${key} is too large`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid local-memory backup: ${key} must be a finite number`);
  }
  return value;
}

export function validateLocalMemoryBackup(value: unknown): LocalMemoryBackupV1 {
  if (!isRecord(value)) throw new Error("Invalid local-memory backup: root must be an object");
  if (value.format !== "super-looi-local-memory" || value.version !== 1) {
    throw new Error("Unsupported local-memory backup format or version");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported local-memory schema version: ${String(value.schemaVersion)}`);
  }
  requiredString(value, "exportedAt");
  if (!Array.isArray(value.memories) || value.memories.length > MAX_BACKUP_MEMORIES) {
    throw new Error("Invalid local-memory backup: memories list is invalid or too large");
  }
  if (!Array.isArray(value.sessions) || value.sessions.length > MAX_BACKUP_SESSIONS) {
    throw new Error("Invalid local-memory backup: sessions list is invalid or too large");
  }
  if (!Array.isArray(value.messages) || value.messages.length > MAX_BACKUP_MESSAGES) {
    throw new Error("Invalid local-memory backup: messages list is invalid or too large");
  }
  if (!isRecord(value.profile)) {
    throw new Error("Invalid local-memory backup: profile must be an object");
  }

  const memories: LocalMemoryBackupMemory[] = value.memories.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Invalid memory row at index ${index}`);
    const category = validateBackupMemoryCategory(requiredString(raw, "category"), index);
    return {
      id: requiredString(raw, "id"),
      memory: requiredString(raw, "memory"),
      category,
      source: requiredString(raw, "source"),
      timestamp: requiredString(raw, "timestamp"),
      createdAt: requiredString(raw, "createdAt"),
      updatedAt: requiredString(raw, "updatedAt"),
      confidence: optionalNumber(raw, "confidence"),
      location: optionalString(raw, "location"),
      evidenceUri: optionalString(raw, "evidenceUri"),
      description: optionalString(raw, "description"),
      placementFact: optionalString(raw, "placementFact"),
      serverId: optionalString(raw, "serverId"),
      syncState: requiredString(raw, "syncState"),
    };
  });

  const sessions: LocalMemoryBackupSession[] = value.sessions.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Invalid session row at index ${index}`);
    return {
      id: requiredString(raw, "id"),
      source: requiredString(raw, "source"),
      startedAt: requiredString(raw, "startedAt"),
      updatedAt: requiredString(raw, "updatedAt"),
      endedAt: optionalString(raw, "endedAt"),
      summary: optionalString(raw, "summary"),
    };
  });
  const sessionIds = new Set(sessions.map((session) => session.id));

  const messages: LocalMemoryBackupMessage[] = value.messages.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`Invalid message row at index ${index}`);
    const id = raw.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid message id at index ${index}`);
    }
    const role = requiredString(raw, "role");
    if (role !== "user" && role !== "assistant") {
      throw new Error(`Invalid message role at index ${index}`);
    }
    const sessionId = requiredString(raw, "sessionId");
    if (!sessionIds.has(sessionId)) {
      throw new Error(`Message at index ${index} references a missing session`);
    }
    return {
      id,
      sessionId,
      role,
      content: requiredString(raw, "content"),
      evidenceUri: optionalString(raw, "evidenceUri"),
      createdAt: requiredString(raw, "createdAt"),
    };
  });

  const profile: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value.profile)) {
    if (!key || BACKUP_PROFILE_BLOCKED_KEY.test(key)) continue;
    if (typeof raw !== "string" || raw.length > MAX_BACKUP_TEXT_LENGTH) {
      throw new Error(`Invalid local-memory backup profile value for ${key}`);
    }
    profile[key] = raw;
  }

  return {
    format: "super-looi-local-memory",
    version: 1,
    exportedAt: value.exportedAt as string,
    schemaVersion: SCHEMA_VERSION,
    memories,
    sessions,
    messages,
    profile,
  };
}

function rowToMemory(row: MemoryRow, score?: number): MemoryResult {
  return {
    id: row.id,
    memory: row.memory,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: {
      category: row.category,
      source: row.source,
      timestamp: row.timestamp,
      evidenceUri: row.evidence_uri ?? undefined,
      description: row.description ?? undefined,
      placementFact: row.placement_fact ?? undefined,
    },
    score,
  };
}

async function touchSessionInternal(
  sessionId: string,
  source: "classic" | "realtime" | "system"
): Promise<void> {
  if (!sessionId) return;
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO conversation_sessions(id, source, started_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    sessionId,
    source,
    now,
    now
  );
}

export const localMemoryDatabase = {
  async remember(messages: Message[], metadata: ObservationMetadata): Promise<void> {
    const memory = memoryTextFromMessages(messages);
    if (!memory) throw new Error("Cannot store empty memory");
    const db = await getDatabase();
    const now = new Date().toISOString();
    const id = makeLocalId("mem");
    await db.runAsync(
      `INSERT INTO memories(
        id, memory, normalized, category, source, timestamp, created_at, updated_at,
        confidence, location, evidence_uri, sync_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      memory,
      normalizeMemorySearchText(memory),
      metadata.category,
      metadata.source,
      metadata.timestamp || now,
      now,
      now,
      metadata.confidence ?? null,
      metadata.location ?? null,
      metadata.evidenceUri ?? null,
      "local-only"
    );
    recordDiagnosticEvent("memory", "local-memory-stored", {
      id,
      category: metadata.category,
      source: metadata.source,
      length: memory.length,
    });
  },

  async search(query: string, filters?: { category?: MemoryCategory }): Promise<MemoryResult[]> {
    const db = await getDatabase();
    const ftsQuery = buildMemoryFtsQuery(query);
    if (!ftsQuery) return [];
    const category = filters?.category ?? null;
    const runFts = (matchQuery: string) => db.getAllAsync<MemoryRow & { rank: number }>(
      `SELECT m.*, bm25(memories_fts) AS rank
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
         AND (? IS NULL OR m.category = ?)
       ORDER BY rank ASC, m.timestamp DESC
       LIMIT ?`,
      matchQuery,
      category,
      category,
      MAX_SEARCH_RESULTS
    );

    let strategy = "fts-exact";
    let rows = await runFts(ftsQuery);
    if (rows.length === 0) {
      const relaxed = buildRelaxedMemoryFtsQuery(query);
      if (relaxed && relaxed !== ftsQuery) {
        rows = await runFts(relaxed);
        strategy = "fts-relaxed-prefix";
      }
    }

    let results = rows.map((row) => rowToMemory(row, Number.isFinite(row.rank) ? 1 / (1 + Math.max(0, row.rank)) : undefined));

    // For a small local memory store, zero lexical overlap should not mean
    // "no memory". The Realtime model can cheaply inspect the whole bounded
    // fact set and resolve semantic relations such as "favorite fruit" ->
    // "likes peaches" that FTS cannot infer. This fallback stays local and
    // is capped to the same small-store envelope used by conversation context.
    if (results.length === 0) {
      const stats = await db.getFirstAsync<{ count: number; chars: number }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(memory)), 0) AS chars
         FROM memories
         WHERE (? IS NULL OR category = ?)`,
        category,
        category
      );
      const count = Number(stats?.count ?? 0);
      const chars = Number(stats?.chars ?? 0);
      if (count > 0 && count <= 48 && chars <= 12_000) {
        const fallbackRows = await db.getAllAsync<MemoryRow>(
          `SELECT * FROM memories
           WHERE (? IS NULL OR category = ?)
           ORDER BY timestamp DESC
           LIMIT 48`,
          category,
          category
        );
        results = fallbackRows.map((row) => rowToMemory(row));
        strategy = "bounded-full-fallback";
      }
    }

    recordDiagnosticEvent("memory", "local-memory-searched", {
      queryLength: query.length,
      category: category ?? "all",
      strategy,
      results: results.length,
    });
    return results;
  },

  async getAll(filters?: { category?: MemoryCategory }): Promise<MemoryResult[]> {
    const db = await getDatabase();
    const category = filters?.category ?? null;
    const rows = await db.getAllAsync<MemoryRow>(
      `SELECT * FROM memories
       WHERE (? IS NULL OR category = ?)
       ORDER BY timestamp DESC`,
      category,
      category
    );
    return rows.map((row) => rowToMemory(row));
  },

  async getStats(): Promise<LocalMemoryStats> {
    const db = await getDatabase();
    const memoryCount = await db.getFirstAsync<CountRow>("SELECT COUNT(*) AS count FROM memories");
    const sessionCount = await db.getFirstAsync<CountRow>(
      "SELECT COUNT(*) AS count FROM conversation_sessions"
    );
    const messageCount = await db.getFirstAsync<CountRow>(
      "SELECT COUNT(*) AS count FROM conversation_messages"
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      memoryCount: Number(memoryCount?.count ?? 0),
      sessionCount: Number(sessionCount?.count ?? 0),
      messageCount: Number(messageCount?.count ?? 0),
    };
  },

  async listConversationSessions(options: { limit?: number; offset?: number } = {}): Promise<SessionSummary[]> {
    const db = await getDatabase();
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 40)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const rows = await db.getAllAsync<LocalSessionSummaryRow>(
      `SELECT s.*,
              COUNT(m.id) AS message_count,
              COALESCE(
                NULLIF(TRIM(s.summary), ''),
                (SELECT fm.content
                   FROM conversation_messages fm
                  WHERE fm.session_id = s.id
                  ORDER BY fm.id ASC
                  LIMIT 1)
              ) AS derived_summary
         FROM conversation_sessions s
         LEFT JOIN conversation_messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC, s.started_at DESC
        LIMIT ? OFFSET ?`,
      limit,
      offset
    );
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      // Local sessions currently do not have an explicit close event. The last
      // local update is the best historical end marker; the active session is
      // rendered as "сейчас" by the UI using activeSessionId.
      endedAt: row.ended_at ?? row.updated_at,
      summary: row.derived_summary,
      status: row.ended_at ? "closed" : "local",
      messageCount: Number(row.message_count ?? 0),
      usageEventCount: 0,
      hasEstimatedCost: false,
    }));
  },

  async getConversationMessages(sessionId: string): Promise<ChatMessage[]> {
    if (!sessionId) return [];
    const db = await getDatabase();
    const rows = await db.getAllAsync<MessageRow>(
      `SELECT *
         FROM conversation_messages
        WHERE session_id = ?
        ORDER BY id ASC`,
      sessionId
    );
    return rows.map((row) => ({
      id: `local-history-${row.id}`,
      role: row.role,
      content: row.content,
      timestamp: row.created_at,
      evidenceUri: row.evidence_uri ?? undefined,
    }));
  },

  async touchSession(sessionId: string, source: "classic" | "realtime" | "system"): Promise<void> {
    await touchSessionInternal(sessionId, source);
  },

  async addSessionMessage(
    sessionId: string,
    message: { role: "user" | "assistant"; content: string; evidenceUri?: string }
  ): Promise<void> {
    if (!sessionId || !message.content.trim()) return;
    const db = await getDatabase();
    await touchSessionInternal(sessionId, "system");
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO conversation_messages(session_id, role, content, evidence_uri, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      sessionId,
      message.role,
      message.content.trim(),
      message.evidenceUri ?? null,
      now
    );
    await db.runAsync(
      "UPDATE conversation_sessions SET updated_at = ? WHERE id = ?",
      now,
      sessionId
    );
  },

  async setProfileValue(key: string, value: string): Promise<void> {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO profile_state(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      new Date().toISOString()
    );
  },

  async restoreBackup(value: unknown): Promise<LocalMemoryRestoreStats> {
    const backup = validateLocalMemoryBackup(value);
    const db = await getDatabase();
    const restoredAt = new Date().toISOString();

    await db.withExclusiveTransactionAsync(async (txn) => {
      // Delete children before parents. FTS stays consistent because the normal
      // memories delete/insert triggers remain active inside this transaction.
      await txn.runAsync("DELETE FROM conversation_messages");
      await txn.runAsync("DELETE FROM conversation_sessions");
      await txn.runAsync("DELETE FROM memories");
      await txn.runAsync("DELETE FROM profile_state");

      for (const memory of backup.memories) {
        await txn.runAsync(
          `INSERT INTO memories(
            id, memory, normalized, category, source, timestamp, created_at, updated_at,
            confidence, location, evidence_uri, description, placement_fact, server_id, sync_state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          memory.id,
          memory.memory,
          normalizeMemorySearchText(memory.memory),
          memory.category,
          memory.source,
          memory.timestamp,
          memory.createdAt,
          memory.updatedAt,
          memory.confidence ?? null,
          memory.location ?? null,
          memory.evidenceUri ?? null,
          memory.description ?? null,
          memory.placementFact ?? null,
          memory.serverId ?? null,
          memory.syncState
        );
      }

      for (const session of backup.sessions) {
        await txn.runAsync(
          `INSERT INTO conversation_sessions(id, source, started_at, updated_at, ended_at, summary)
           VALUES (?, ?, ?, ?, ?, ?)`,
          session.id,
          session.source,
          session.startedAt,
          session.updatedAt,
          session.endedAt ?? null,
          session.summary ?? null
        );
      }

      for (const message of backup.messages) {
        await txn.runAsync(
          `INSERT INTO conversation_messages(id, session_id, role, content, evidence_uri, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          message.id,
          message.sessionId,
          message.role,
          message.content,
          message.evidenceUri ?? null,
          message.createdAt
        );
      }

      for (const [key, profileValue] of Object.entries(backup.profile)) {
        if (BACKUP_PROFILE_BLOCKED_KEY.test(key)) continue;
        await txn.runAsync(
          "INSERT INTO profile_state(key, value, updated_at) VALUES (?, ?, ?)",
          key,
          profileValue,
          restoredAt
        );
      }
    });

    const stats: LocalMemoryRestoreStats = {
      memoryCount: backup.memories.length,
      sessionCount: backup.sessions.length,
      messageCount: backup.messages.length,
      profileCount: Object.keys(backup.profile).length,
    };
    recordDiagnosticEvent("memory", "local-backup-restored", stats);
    return stats;
  },

  async exportBackup(): Promise<LocalMemoryBackupV1> {
    const db = await getDatabase();
    const memories = await db.getAllAsync<MemoryRow>("SELECT * FROM memories ORDER BY timestamp ASC");
    const sessions = await db.getAllAsync<SessionRow>(
      "SELECT * FROM conversation_sessions ORDER BY started_at ASC"
    );
    const messages = await db.getAllAsync<MessageRow>(
      "SELECT * FROM conversation_messages ORDER BY id ASC"
    );
    const profileRows = await db.getAllAsync<ProfileRow>("SELECT key, value FROM profile_state");
    return {
      format: "super-looi-local-memory",
      version: 1,
      exportedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      memories: memories.map((row) => ({
        id: row.id,
        memory: row.memory,
        category: validateBackupMemoryCategory(row.category),
        source: row.source,
        timestamp: row.timestamp,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        confidence: row.confidence ?? undefined,
        location: row.location ?? undefined,
        evidenceUri: row.evidence_uri ?? undefined,
        description: row.description ?? undefined,
        placementFact: row.placement_fact ?? undefined,
        serverId: row.server_id ?? undefined,
        syncState: row.sync_state,
      })),
      sessions: sessions.map((row) => ({
        id: row.id,
        source: row.source,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        endedAt: row.ended_at ?? undefined,
        summary: row.summary ?? undefined,
      })),
      messages: messages.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        evidenceUri: row.evidence_uri ?? undefined,
        createdAt: row.created_at,
      })),
      profile: Object.fromEntries(
        profileRows
          .filter((row) => !BACKUP_PROFILE_BLOCKED_KEY.test(row.key))
          .map((row) => [row.key, row.value])
      ),
    };
  },
};

export async function ensureLocalMemoryReady(): Promise<LocalMemoryStats> {
  await getDatabase();
  return localMemoryDatabase.getStats();
}
