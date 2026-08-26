import BackupStorageAccess, {
  type BackupStorageFile,
  type BackupStorageFolder,
} from "../../modules/backup-storage-access";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { withExternalActivityLease } from "../core/background-process-exit";
import {
  exportLocalMemoryBackup,
  restoreLocalMemoryBackup,
} from "../memory/memory-service";
import type {
  LocalMemoryBackupV1,
  LocalMemoryRestoreStats,
} from "../memory/local-memory-database";
import {
  clearBackupStorageFolder,
  getBackupStorageLocalSettings,
  markBackupStorageBackupNow,
  markBackupStorageRestoreNow,
  saveBackupStorageFolder,
} from "./backup-storage-settings";

export const LOCAL_MEMORY_BACKUP_FILE_NAME = "super-looi-memory-backup-v1.json";
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;

export type LocalBackupResult = {
  file: BackupStorageFile;
  bytes: number;
  memoryCount: number;
  sessionCount: number;
  messageCount: number;
};

export type LocalRestoreResult = {
  file: BackupStorageFile;
  stats: LocalMemoryRestoreStats;
};

export function getLocalBackupStorageSettings() {
  return getBackupStorageLocalSettings();
}

export async function chooseLocalBackupFolder(): Promise<BackupStorageFolder> {
  const previous = getBackupStorageLocalSettings().folder;
  const folder = await withExternalActivityLease("backup-folder-picker", () =>
    BackupStorageAccess.selectFolder()
  );
  if (!folder.canRead || !folder.canWrite) {
    throw new Error("Выбранная папка не дала LOOI постоянный доступ на чтение и запись");
  }
  saveBackupStorageFolder(folder);
  if (previous && previous.uri !== folder.uri) {
    void BackupStorageAccess.releaseFolder(previous.uri).catch(() => undefined);
  }
  recordDiagnosticEvent("memory", "backup-storage-folder-selected", {
    hasDisplayName: Boolean(folder.displayName),
    hasProviderName: Boolean(folder.providerName),
    canRead: folder.canRead,
    canWrite: folder.canWrite,
  });
  return folder;
}

export async function refreshLocalBackupFolder(): Promise<BackupStorageFolder | null> {
  const current = getBackupStorageLocalSettings().folder;
  if (!current) return null;
  try {
    const folder = await BackupStorageAccess.inspectFolder(current.uri);
    saveBackupStorageFolder(folder);
    return folder;
  } catch (error) {
    recordDiagnosticEvent("memory", "backup-storage-folder-unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return current;
  }
}

export async function forgetLocalBackupFolder(): Promise<void> {
  const current = getBackupStorageLocalSettings().folder;
  try {
    if (current) await BackupStorageAccess.releaseFolder(current.uri);
  } finally {
    clearBackupStorageFolder();
  }
  recordDiagnosticEvent("memory", "backup-storage-folder-forgotten");
}

function requireFolder(): BackupStorageFolder {
  const folder = getBackupStorageLocalSettings().folder;
  if (!folder) throw new Error("Сначала выбери папку для резервных копий");
  return folder;
}

export async function inspectLatestLocalBackup(): Promise<BackupStorageFile | null> {
  const startedAt = Date.now();
  try {
    const folder = requireFolder();
    const file = await BackupStorageAccess.inspectFile(folder.uri, LOCAL_MEMORY_BACKUP_FILE_NAME);
    recordDiagnosticEvent("memory", "backup-storage-inspected", {
      durationMs: Date.now() - startedAt,
      found: Boolean(file),
    });
    return file;
  } catch (error) {
    recordDiagnosticEvent("memory", "backup-storage-inspect-failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function backupLocalMemoryToSelectedFolder(): Promise<LocalBackupResult> {
  const startedAt = Date.now();
  try {
    const folder = requireFolder();
    const backup: LocalMemoryBackupV1 = await exportLocalMemoryBackup();
    const json = JSON.stringify(backup);
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes <= 0 || bytes > MAX_BACKUP_BYTES) {
      throw new Error(`Некорректный размер резервной копии: ${bytes} bytes`);
    }
    const file = await BackupStorageAccess.writeTextFile(
      folder.uri,
      LOCAL_MEMORY_BACKUP_FILE_NAME,
      json
    );
    markBackupStorageBackupNow();
    recordDiagnosticEvent("memory", "backup-storage-written", {
      durationMs: Date.now() - startedAt,
      bytes,
      memoryCount: backup.memories.length,
      sessionCount: backup.sessions.length,
      messageCount: backup.messages.length,
    });
    return {
      file,
      bytes,
      memoryCount: backup.memories.length,
      sessionCount: backup.sessions.length,
      messageCount: backup.messages.length,
    };
  } catch (error) {
    recordDiagnosticEvent("memory", "backup-storage-write-failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function restoreLocalMemoryFromSelectedFolder(): Promise<LocalRestoreResult> {
  const startedAt = Date.now();
  try {
    const folder = requireFolder();
    const result = await BackupStorageAccess.readTextFile(
      folder.uri,
      LOCAL_MEMORY_BACKUP_FILE_NAME,
      MAX_BACKUP_BYTES
    );
    if (result.bytes <= 0 || result.bytes > MAX_BACKUP_BYTES) {
      throw new Error(`Некорректный размер резервной копии: ${result.bytes} bytes`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.content);
    } catch {
      throw new Error("Резервная копия содержит некорректный JSON");
    }
    const stats = await restoreLocalMemoryBackup(payload);
    markBackupStorageRestoreNow();
    recordDiagnosticEvent("memory", "backup-storage-restored", {
      durationMs: Date.now() - startedAt,
      bytes: result.bytes,
      memoryCount: stats.memoryCount,
      sessionCount: stats.sessionCount,
      messageCount: stats.messageCount,
    });
    return { file: result.file, stats };
  } catch (error) {
    recordDiagnosticEvent("memory", "backup-storage-restore-failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
