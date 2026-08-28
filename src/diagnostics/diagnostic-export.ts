import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import BackupStorageAccess, {
  type BackupStorageFile,
  type BackupStorageFolder,
} from "../../modules/backup-storage-access";
import { createDiagnosticZip } from "../../modules/diagnostic-archive";
import { getBackupStorageLocalSettings } from "../backup/backup-storage-settings";
import { withExternalActivityLease } from "../core/background-process-exit";
import { buildDiagnosticLogText, recordDiagnosticEvent } from "./diagnostic-log";
import {
  getDiagnosticStorageSettings,
  saveDiagnosticStorageFolder,
} from "./diagnostic-storage-settings";

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function fileNameFromUri(uri: string): string {
  const value = uri.split("/").pop()?.trim();
  return value || `looi-diagnostics-${safeTimestamp()}.zip`;
}

export async function writeCombinedDiagnosticExport(): Promise<string> {
  const cacheRoot = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!cacheRoot) throw new Error("Diagnostic export directory is unavailable");

  const exportId = `looi-diagnostics-${safeTimestamp()}`;
  const stagingRoot = `${cacheRoot}${exportId}/`;
  const outputUri = `${cacheRoot}${exportId}.zip`;

  await FileSystem.deleteAsync(stagingRoot, { idempotent: true }).catch(() => undefined);
  await FileSystem.makeDirectoryAsync(stagingRoot, { intermediates: true });
  await FileSystem.writeAsStringAsync(`${stagingRoot}looi-diagnostic.log`, buildDiagnosticLogText());
  await FileSystem.writeAsStringAsync(
    `${stagingRoot}README.txt`,
    [
      "LOOI diagnostic package",
      `exportedAt=${new Date().toISOString()}`,
      "",
      "looi-diagnostic.log: sanitized application diagnostic log.",
      "Local-ASR microphone WAV capture was retired in v2.1.105 and is no longer collected.",
      "API keys, tokens and passwords are not intentionally included.",
      "",
    ].join("\n")
  );

  try {
    const result = await createDiagnosticZip(stagingRoot, outputUri);
    recordDiagnosticEvent("diagnostic", "combined-export-created", {
      entries: result.entries,
      uncompressedBytes: result.uncompressedBytes,
      microphoneAudioIncluded: false,
    });
    return result.outputUri;
  } finally {
    await FileSystem.deleteAsync(stagingRoot, { idempotent: true }).catch(() => undefined);
  }
}

export function getDiagnosticExportFolder(): BackupStorageFolder | null {
  return getDiagnosticStorageSettings().folder;
}

export async function chooseDiagnosticExportFolder(): Promise<BackupStorageFolder> {
  const previous = getDiagnosticStorageSettings().folder;
  const folder = await withExternalActivityLease("diagnostic-folder-picker", () =>
    BackupStorageAccess.selectFolder()
  );
  if (!folder.canRead || !folder.canWrite) {
    throw new Error("Выбранная папка не дала My LOOI постоянный доступ на чтение и запись");
  }
  saveDiagnosticStorageFolder(folder);

  const backupFolderUri = getBackupStorageLocalSettings().folder?.uri;
  if (previous && previous.uri !== folder.uri && previous.uri !== backupFolderUri) {
    void BackupStorageAccess.releaseFolder(previous.uri).catch(() => undefined);
  }

  recordDiagnosticEvent("diagnostic", "export-folder-selected", {
    hasDisplayName: Boolean(folder.displayName),
    hasProviderName: Boolean(folder.providerName),
    canRead: folder.canRead,
    canWrite: folder.canWrite,
  });
  return folder;
}

function requireDiagnosticExportFolder(): BackupStorageFolder {
  const folder = getDiagnosticStorageSettings().folder;
  if (!folder) throw new Error("Сначала выбери папку для диагностики");
  return folder;
}

export async function saveCombinedDiagnosticExportToSelectedFolder(): Promise<BackupStorageFile> {
  const folder = requireDiagnosticExportFolder();
  const uri = await writeCombinedDiagnosticExport();
  const fileName = fileNameFromUri(uri);
  try {
    const file = await BackupStorageAccess.writePrivateFile(
      folder.uri,
      fileName,
      "application/zip",
      uri
    );
    recordDiagnosticEvent("diagnostic", "combined-export-saved-folder", {
      bytes: file.size,
      hasDisplayName: Boolean(file.name),
      hasProviderName: Boolean(folder.providerName),
    });
    return file;
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}


export async function shareCombinedDiagnosticExport(dialogTitle = "Share My LOOI diagnostics"): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Android sharing is unavailable on this device");
  }
  const uri = await writeCombinedDiagnosticExport();
  try {
    await Sharing.shareAsync(uri, {
      mimeType: "application/zip",
      dialogTitle,
      UTI: "public.zip-archive",
    });
    recordDiagnosticEvent("diagnostic", "combined-export-shared");
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}
