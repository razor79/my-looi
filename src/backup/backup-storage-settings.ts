import { createMMKV } from "react-native-mmkv";
import type { BackupStorageFolder } from "../../modules/backup-storage-access";

const storage = createMMKV({ id: "looi.backup-storage.v1" });
const FOLDER_URI_KEY = "folder-uri";
const FOLDER_NAME_KEY = "folder-name";
const PROVIDER_NAME_KEY = "provider-name";
const LAST_BACKUP_AT_KEY = "last-backup-at";
const LAST_RESTORE_AT_KEY = "last-restore-at";

export type BackupStorageLocalSettings = {
  folder: BackupStorageFolder | null;
  lastBackupAt: string | null;
  lastRestoreAt: string | null;
};

export function getBackupStorageLocalSettings(): BackupStorageLocalSettings {
  const uri = storage.getString(FOLDER_URI_KEY)?.trim() ?? "";
  return {
    folder: uri
      ? {
          uri,
          displayName: storage.getString(FOLDER_NAME_KEY) || undefined,
          providerName: storage.getString(PROVIDER_NAME_KEY) || undefined,
          canRead: true,
          canWrite: true,
        }
      : null,
    lastBackupAt: storage.getString(LAST_BACKUP_AT_KEY) ?? null,
    lastRestoreAt: storage.getString(LAST_RESTORE_AT_KEY) ?? null,
  };
}

export function saveBackupStorageFolder(folder: BackupStorageFolder): void {
  storage.set(FOLDER_URI_KEY, folder.uri);
  if (folder.displayName) storage.set(FOLDER_NAME_KEY, folder.displayName);
  else storage.remove(FOLDER_NAME_KEY);
  if (folder.providerName) storage.set(PROVIDER_NAME_KEY, folder.providerName);
  else storage.remove(PROVIDER_NAME_KEY);
}

export function clearBackupStorageFolder(): void {
  storage.remove(FOLDER_URI_KEY);
  storage.remove(FOLDER_NAME_KEY);
  storage.remove(PROVIDER_NAME_KEY);
}

export function markBackupStorageBackupNow(timestamp = new Date().toISOString()): void {
  storage.set(LAST_BACKUP_AT_KEY, timestamp);
}

export function markBackupStorageRestoreNow(timestamp = new Date().toISOString()): void {
  storage.set(LAST_RESTORE_AT_KEY, timestamp);
}
