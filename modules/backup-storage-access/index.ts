import { NativeModule, requireNativeModule } from "expo";

export type BackupStorageFolder = {
  uri: string;
  displayName?: string;
  providerName?: string;
  canRead: boolean;
  canWrite: boolean;
};

export type BackupStorageFile = {
  uri: string;
  name: string;
  modifiedTime?: number;
  size?: number;
};

export type BackupStorageReadResult = {
  file: BackupStorageFile;
  content: string;
  bytes: number;
};

declare class BackupStorageAccessModule extends NativeModule {
  selectFolder(): Promise<BackupStorageFolder>;
  inspectFolder(treeUri: string): Promise<BackupStorageFolder>;
  inspectFile(treeUri: string, fileName: string): Promise<BackupStorageFile | null>;
  writeTextFile(treeUri: string, fileName: string, content: string): Promise<BackupStorageFile>;
  writePrivateFile(
    treeUri: string,
    fileName: string,
    mimeType: string,
    sourceFileUri: string
  ): Promise<BackupStorageFile>;
  readTextFile(treeUri: string, fileName: string, maxBytes: number): Promise<BackupStorageReadResult>;
  releaseFolder(treeUri: string): Promise<void>;
}

export default requireNativeModule<BackupStorageAccessModule>("BackupStorageAccess");
