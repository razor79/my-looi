import * as FileSystem from "expo-file-system/legacy";
import { createMMKV } from "react-native-mmkv";

export type DiagnosticCategory =
  | "app"
  | "audio"
  | "runtime"
  | "microphone"
  | "kws"
  | "whisper"
  | "stt"
  | "llm"
  | "tts"
  | "latency"
  | "cost"
  | "playback"
  | "speaker"
  | "notification"
  | "calendar"
  | "character"
  | "navigation"
  | "memory"
  | "realtime"
  | "robot"
  | "diagnostic";

export type DiagnosticValue = string | number | boolean | null | undefined;
export type DiagnosticDetails = Record<string, DiagnosticValue>;

export type DiagnosticLogEntry = {
  id: number;
  timestamp: string;
  category: DiagnosticCategory;
  event: string;
  details: Record<string, string | number | boolean | null>;
};

const STORAGE_KEY = "looi.diagnostic-log.v1";
const MAX_ENTRIES = 2000;
const MAX_STRING_LENGTH = 600;
const BLOCKED_KEY = /(token|secret|password|authorization|embedding|raw.?audio|audio.?samples)/i;
const diagnosticStorage = createMMKV({ id: "looi.diagnostic-log" });

let nextId = Date.now();

function sanitizeString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s|,;]+/gi,
      "$1[REDACTED]"
    )
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]*/gi, "$1[REDACTED]")
    .slice(0, MAX_STRING_LENGTH);
}

function sanitizeDetails(details: DiagnosticDetails): DiagnosticLogEntry["details"] {
  const sanitized: DiagnosticLogEntry["details"] = {};
  for (const [key, value] of Object.entries(details)) {
    if (BLOCKED_KEY.test(key) || value === undefined) continue;
    if (typeof value === "string") {
      sanitized[key] = sanitizeString(value);
    } else if (typeof value === "number") {
      sanitized[key] = Number.isFinite(value) ? value : String(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function readEntries(): DiagnosticLogEntry[] {
  const raw = diagnosticStorage.getString(STORAGE_KEY);
  if (!raw) return [];
  try {
    const entries = JSON.parse(raw) as DiagnosticLogEntry[];
    return Array.isArray(entries) ? entries.slice(-MAX_ENTRIES) : [];
  } catch {
    diagnosticStorage.remove(STORAGE_KEY);
    return [];
  }
}

export function recordDiagnosticEvent(
  category: DiagnosticCategory,
  event: string,
  details: DiagnosticDetails = {}
): void {
  try {
    const entries = readEntries();
    entries.push({
      id: nextId++,
      timestamp: new Date().toISOString(),
      category,
      event: event.slice(0, 120),
      details: sanitizeDetails(details),
    });
    diagnosticStorage.set(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch (error) {
    // Diagnostics must never break the voice runtime they are observing.
    console.warn("[DiagnosticLog] Failed to persist event:", error);
  }
}

export function getDiagnosticLogEntries(): DiagnosticLogEntry[] {
  return readEntries();
}

export function clearDiagnosticLog(): void {
  diagnosticStorage.remove(STORAGE_KEY);
}

export function buildDiagnosticLogText(entries = readEntries()): string {
  const header = [
    "LOOI diagnostic log",
    `exportedAt=${new Date().toISOString()}`,
    `entries=${entries.length}`,
    "privacy=diagnostic metadata plus Realtime recognized input text; no raw audio, embeddings, credentials or API tokens",
    "",
  ];
  const lines = entries.map((entry) => {
    const details = Object.entries(entry.details)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" | ");
    return `${entry.timestamp} | ${entry.category} | ${entry.event}${details ? ` | ${details}` : ""}`;
  });
  return header.concat(lines).join("\n");
}

export async function writeDiagnosticLogExport(): Promise<string> {
  const root = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!root) throw new Error("Diagnostic export directory is unavailable");
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uri = `${root}looi-diagnostic-${safeTimestamp}.log`;
  await FileSystem.writeAsStringAsync(uri, buildDiagnosticLogText());
  return uri;
}
