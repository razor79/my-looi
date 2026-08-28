import { NativeModule, requireNativeModule } from "expo";
import { Platform } from "react-native";

export type VerifiedUpdateApk = {
  packageName: string;
  versionName?: string;
  versionCode: number;
  installedVersionCode: number;
  sha256: string;
  signerSha256: string;
};

declare class AppUpdateInstallerNativeModule extends NativeModule {
  canRequestPackageInstalls(): Promise<boolean>;
  openInstallPermissionSettings(): Promise<void>;
  verifyUpdateApk(fileUri: string, expectedSha256: string): Promise<VerifiedUpdateApk>;
  installVerifiedUpdateApk(fileUri: string, expectedSha256: string): Promise<VerifiedUpdateApk>;
}

let cached: AppUpdateInstallerNativeModule | null = null;

function getModule(): AppUpdateInstallerNativeModule {
  if (Platform.OS !== "android") throw new Error("My LOOI self-update is available on Android only");
  cached ??= requireNativeModule<AppUpdateInstallerNativeModule>("AppUpdateInstaller");
  return cached;
}

export async function canRequestPackageInstalls(): Promise<boolean> {
  return getModule().canRequestPackageInstalls();
}

export async function openInstallPermissionSettings(): Promise<void> {
  return getModule().openInstallPermissionSettings();
}

export async function verifyUpdateApk(fileUri: string, expectedSha256: string): Promise<VerifiedUpdateApk> {
  return getModule().verifyUpdateApk(fileUri, expectedSha256);
}

export async function installVerifiedUpdateApk(fileUri: string, expectedSha256: string): Promise<VerifiedUpdateApk> {
  return getModule().installVerifiedUpdateApk(fileUri, expectedSha256);
}
