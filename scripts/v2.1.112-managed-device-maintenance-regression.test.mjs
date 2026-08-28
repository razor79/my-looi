import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
const ui = fs.readFileSync("app/(tabs)/settings.tsx", "utf8");
const uiStrings = fs.readFileSync("src/i18n/ui-strings.ts", "utf8");
const diagnosticTs = fs.readFileSync("src/diagnostics/diagnostic-export.ts", "utf8");
const diagnosticStorage = fs.readFileSync("src/diagnostics/diagnostic-storage-settings.ts", "utf8");
const diagnosticNative = fs.readFileSync(
  "modules/diagnostic-archive/android/src/main/java/com/superlooi/diagnosticarchive/DiagnosticArchiveModule.kt",
  "utf8"
);
const storageNative = fs.readFileSync(
  "modules/backup-storage-access/android/src/main/java/com/superlooi/backupstorageaccess/BackupStorageAccessModule.kt",
  "utf8"
);
const updater = fs.readFileSync("src/updates/github-release-updater.ts", "utf8");
const installer = fs.readFileSync(
  "modules/app-update-installer/android/src/main/java/com/superlooi/appupdateinstaller/AppUpdateInstallerModule.kt",
  "utf8"
);
const installerManifest = fs.readFileSync("modules/app-update-installer/android/src/main/AndroidManifest.xml", "utf8");
const providerPaths = fs.readFileSync("modules/app-update-installer/android/src/main/res/xml/my_looi_update_file_paths.xml", "utf8");

assert.equal(app.expo.version, pkg.version);
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 112, "v2.1.112 maintenance regression must remain active in later releases");
assert.ok(app.expo.android.versionCode >= 112);

// Diagnostics remain entirely user-triggered. Share is retained and Android SAF
// remains available for a persistent local/document-provider destination. The
// experimental direct Google Drive Picker path existed in v2.1.116-v2.1.118 and
// was deliberately retired in v2.1.119 in favor of the native share sheet.
assert.match(diagnosticTs, /Sharing\.shareAsync/);
assert.match(diagnosticTs, /chooseDiagnosticExportFolder/);
assert.match(diagnosticTs, /BackupStorageAccess\.selectFolder/);
assert.match(diagnosticTs, /BackupStorageAccess\.writePrivateFile/);
assert.match(diagnosticStorage, /looi\.diagnostic-storage\.v1/);
assert.match(storageNative, /Intent\.ACTION_OPEN_DOCUMENT_TREE/);
assert.match(storageNative, /FLAG_GRANT_PERSISTABLE_URI_PERMISSION/);
assert.match(storageNative, /AsyncFunction\("writePrivateFile"\)/);
assert.match(storageNative, /openOutputStream\(target, "rwt"\)/);
assert.match(ui, /t\("settings\.shareZip"\)/);
assert.match(ui, /t\("settings\.chooseLocalFolder"\)/);
assert.match(ui, /t\("settings\.saveLocal"\)/);
assert.match(ui, /t\("settings\.diagnosticsHelp"/);
assert.match(uiStrings, /"settings\.shareZip": "Share ZIP"/);
assert.match(uiStrings, /no automatic upload/);

if (patchVersion >= 116 && patchVersion < 119) {
  const driveStorage = fs.readFileSync("src/diagnostics/diagnostic-drive-settings.ts", "utf8");
  const driveNative = fs.readFileSync(
    "modules/google-drive-storage/android/src/main/java/io/github/razor79/mylooi/googledrivestorage/GoogleDriveStorageModule.kt",
    "utf8"
  );
  assert.match(diagnosticTs, /chooseDiagnosticDriveFolder/);
  assert.match(diagnosticTs, /GoogleDriveStorage\.selectFolder/);
  assert.match(diagnosticTs, /GoogleDriveStorage\.uploadPrivateFile/);
  assert.match(driveStorage, /looi\.diagnostic-drive\.v1/);
  assert.match(driveNative, /Scope\(Scopes\.DRIVE_FILE\)/);
  assert.match(driveNative, /PICKER_OAUTH_TRIGGER/);
  assert.match(driveNative, /PICKER_ALLOW_FOLDER_SELECTION/);
  assert.match(ui, /Выбрать папку Google Drive/);
  assert.match(ui, /Сохранить в Google Drive/);
  assert.doesNotMatch(driveNative, /WorkManager|JobScheduler|AlarmManager|setRepeating/i);
}
if (patchVersion >= 119) {
  assert.equal(fs.existsSync("modules/google-drive-storage"), false);
  assert.equal(fs.existsSync("src/diagnostics/diagnostic-drive-settings.ts"), false);
  assert.doesNotMatch(diagnosticTs, /GoogleDriveStorage|drive\.file|PICKER_/i);
  assert.doesNotMatch(ui, /Выбрать папку Google Drive|Сохранить в Google Drive|Забыть папку Google Drive/);
}
assert.doesNotMatch(diagnosticTs, /BackgroundFetch|TaskManager|setInterval/i);

// Updates are explicit/manual, come only from the public My LOOI GitHub Releases endpoint,
// and are verified before handing the APK to Android's package installer.
assert.match(updater, /razor79\/my-looi/);
assert.match(updater, /releases\/latest/);
assert.match(updater, /\$\{apk\.name\}\.sha256/);
assert.match(updater, /sha256:/);
assert.match(updater, /verifyUpdateApk/);
assert.match(updater, /updateAvailable/);
assert.match(ui, /t\("settings\.checkUpdates"\)/);
assert.match(ui, /t\("settings\.downloadVersion"/);
assert.match(ui, /t\("settings\.installVersion"/);
assert.match(uiStrings, /"settings\.checkUpdates": "Check for updates"/);
assert.doesNotMatch(updater, /setInterval|BackgroundFetch|TaskManager|auto.?update/i);

assert.match(installerManifest, /REQUEST_INSTALL_PACKAGES/);
assert.match(installerManifest, /androidx\.core\.content\.FileProvider/);
assert.match(providerPaths, /<cache-path name="updates" path="updates\/"/);
assert.match(installer, /canRequestPackageInstalls/);
assert.match(installer, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
assert.match(installer, /ACTION_INSTALL_PACKAGE/);
assert.match(installer, /MessageDigest\.getInstance\("SHA-256"\)/);
assert.match(installer, /archiveSigners == installedSigners/);
assert.match(installer, /archiveVersionCode > installedVersionCode/);
assert.match(installer, /Downloaded APK package does not match/);
assert.match(installer, /Downloaded APK SHA-256 does not match/);

// No separate child-facing PIN/admin subsystem is introduced by this maintenance feature.
assert.doesNotMatch(ui, /parent.?pin|admin.?pin|unlock.?settings/i);

console.log("Managed child-device maintenance regression: PASS");
