import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import {
  canRequestPackageInstalls,
  installVerifiedUpdateApk,
  openInstallPermissionSettings,
  verifyUpdateApk,
  type VerifiedUpdateApk,
} from "../../modules/app-update-installer";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";

export const UPDATE_REPOSITORY = "razor79/my-looi";
const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  size?: number;
  digest?: string | null;
  state?: string;
};

type GitHubReleaseResponse = {
  tag_name: string;
  html_url?: string;
  name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  assets?: GitHubReleaseAsset[];
};

export type UpdateRelease = {
  currentVersion: string;
  version: string;
  tagName: string;
  releaseUrl?: string;
  publishedAt?: string;
  apk: GitHubReleaseAsset;
  checksumAsset?: GitHubReleaseAsset;
  advertisedSha256?: string;
  updateAvailable: boolean;
};

export type DownloadedUpdate = {
  release: UpdateRelease;
  fileUri: string;
  expectedSha256: string;
  verified: VerifiedUpdateApk;
};

function currentVersion(): string {
  return Constants.expoConfig?.version?.trim() || "0.0.0";
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`Unsupported release version: ${!left ? a : b}`);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function sanitizeAssetName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9._+-]{1,180}$/.test(name) || name.includes("..")) {
    throw new Error("GitHub release contains an unsafe APK asset name");
  }
  return name;
}

function parseSha256Text(value: string): string {
  const match = /(?:^|\s)([0-9a-fA-F]{64})(?:\s|$)/.exec(value.trim());
  if (!match) throw new Error("GitHub checksum asset does not contain a valid SHA-256");
  return match[1].toLowerCase();
}

function digestSha256(asset: GitHubReleaseAsset): string | undefined {
  const match = /^sha256:([0-9a-fA-F]{64})$/.exec(asset.digest?.trim() || "");
  return match?.[1].toLowerCase();
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `My-LOOI/${currentVersion()}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForMyLooiUpdate(): Promise<UpdateRelease> {
  const response = await fetchWithTimeout(LATEST_RELEASE_API);
  if (response.status === 404) throw new Error("В GitHub пока нет опубликованного My LOOI release");
  if (!response.ok) throw new Error(`GitHub update check failed: HTTP ${response.status}`);

  const release = (await response.json()) as GitHubReleaseResponse;
  if (release.draft || release.prerelease) throw new Error("GitHub latest release is not a stable public release");
  const versionTuple = parseSemver(release.tag_name);
  if (!versionTuple) throw new Error(`Неизвестный формат версии GitHub release: ${release.tag_name}`);
  const version = versionTuple.join(".");

  const assets = (release.assets ?? []).filter((asset) => asset.state !== "new");
  const versionHint = version.replaceAll(".", "\\.");
  const versionAssetPattern = new RegExp(`(?:^|[-_])v?${versionHint}(?:[-_.]|$)`, "i");
  const apks = assets.filter((asset) => /\.apk$/i.test(asset.name));
  const apk = apks.find((asset) => versionAssetPattern.test(asset.name)) ?? (apks.length === 1 ? apks[0] : undefined);
  if (!apk) throw new Error("GitHub release не содержит однозначный APK asset");
  sanitizeAssetName(apk.name);

  const checksumAsset = assets.find((asset) => asset.name === `${apk.name}.sha256`)
    ?? assets.find((asset) => /\.apk\.sha256$/i.test(asset.name));
  if (checksumAsset) sanitizeAssetName(checksumAsset.name);

  const advertisedSha256 = digestSha256(apk);
  if (!advertisedSha256 && !checksumAsset) {
    throw new Error("GitHub release не содержит SHA-256 для APK");
  }

  const installed = currentVersion();
  const result: UpdateRelease = {
    currentVersion: installed,
    version,
    tagName: release.tag_name,
    releaseUrl: release.html_url,
    publishedAt: release.published_at ?? undefined,
    apk,
    checksumAsset,
    advertisedSha256,
    updateAvailable: compareSemver(version, installed) > 0,
  };
  recordDiagnosticEvent("update", "github-release-checked", {
    currentVersion: installed,
    latestVersion: version,
    updateAvailable: result.updateAvailable,
    hasAssetDigest: Boolean(advertisedSha256),
    hasChecksumAsset: Boolean(checksumAsset),
  });
  return result;
}

async function resolveReleaseSha256(release: UpdateRelease): Promise<string> {
  if (release.advertisedSha256) return release.advertisedSha256;
  if (!release.checksumAsset) throw new Error("SHA-256 asset is unavailable");
  const response = await fetchWithTimeout(release.checksumAsset.browser_download_url);
  if (!response.ok) throw new Error(`SHA-256 download failed: HTTP ${response.status}`);
  return parseSha256Text(await response.text());
}

export async function downloadAndVerifyMyLooiUpdate(release: UpdateRelease): Promise<DownloadedUpdate> {
  if (!release.updateAvailable) throw new Error("Новая версия My LOOI не найдена");
  const cacheRoot = FileSystem.cacheDirectory;
  if (!cacheRoot) throw new Error("Android update cache is unavailable");

  const expectedSha256 = await resolveReleaseSha256(release);
  const updatesDir = `${cacheRoot}updates/`;
  const destination = `${updatesDir}${sanitizeAssetName(release.apk.name)}`;
  await FileSystem.makeDirectoryAsync(updatesDir, { intermediates: true });
  await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);

  const download = await FileSystem.downloadAsync(release.apk.browser_download_url, destination, {
    headers: { Accept: "application/octet-stream" },
  });
  if (download.status < 200 || download.status >= 300) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
    throw new Error(`APK download failed: HTTP ${download.status}`);
  }

  try {
    const verified = await verifyUpdateApk(download.uri, expectedSha256);
    recordDiagnosticEvent("update", "apk-downloaded-verified", {
      versionCode: verified.versionCode,
      installedVersionCode: verified.installedVersionCode,
      sha256Matched: true,
      signerMatchedInstalledApp: true,
    });
    return { release, fileUri: download.uri, expectedSha256, verified };
  } catch (error) {
    await FileSystem.deleteAsync(download.uri, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}

export async function canInstallMyLooiUpdate(): Promise<boolean> {
  return canRequestPackageInstalls();
}

export async function openMyLooiInstallPermissionSettings(): Promise<void> {
  await openInstallPermissionSettings();
}

export async function installDownloadedMyLooiUpdate(update: DownloadedUpdate): Promise<VerifiedUpdateApk> {
  const result = await installVerifiedUpdateApk(update.fileUri, update.expectedSha256);
  recordDiagnosticEvent("update", "package-installer-opened", {
    versionCode: result.versionCode,
  });
  return result;
}
