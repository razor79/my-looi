import { createMMKV } from "react-native-mmkv";
import type { BackupStorageFolder } from "../../modules/backup-storage-access";

const storage = createMMKV({ id: "looi.diagnostic-storage.v1" });
const FOLDER_URI_KEY = "folder-uri";
const FOLDER_NAME_KEY = "folder-name";
const PROVIDER_NAME_KEY = "provider-name";

export type DiagnosticStorageSettings = {
  folder: BackupStorageFolder | null;
};

export function getDiagnosticStorageSettings(): DiagnosticStorageSettings {
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
  };
}

export function saveDiagnosticStorageFolder(folder: BackupStorageFolder): void {
  storage.set(FOLDER_URI_KEY, folder.uri);
  if (folder.displayName) storage.set(FOLDER_NAME_KEY, folder.displayName);
  else storage.remove(FOLDER_NAME_KEY);
  if (folder.providerName) storage.set(PROVIDER_NAME_KEY, folder.providerName);
  else storage.remove(PROVIDER_NAME_KEY);
}
