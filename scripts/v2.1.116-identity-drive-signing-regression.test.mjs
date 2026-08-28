import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
const diagnosticTs = fs.readFileSync("src/diagnostics/diagnostic-export.ts", "utf8");
const ui = fs.readFileSync("app/(tabs)/settings.tsx", "utf8");
const uiStrings = fs.readFileSync("src/i18n/ui-strings.ts", "utf8");
const localStorageNative = fs.readFileSync(
  "modules/backup-storage-access/android/src/main/java/com/superlooi/backupstorageaccess/BackupStorageAccessModule.kt",
  "utf8"
);
const build = fs.readFileSync("scripts/build-android-apk.sh", "utf8");
const signingPatch = fs.readFileSync("scripts/apply-android-release-signing.mjs", "utf8");
const keygen = fs.readFileSync("scripts/create-release-keystore.sh", "utf8");
const gitignore = fs.readFileSync(".gitignore", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const features = fs.readFileSync("FEATURES.md", "utf8");
const privacy = fs.readFileSync("PRIVACY.md", "utf8");
const building = fs.readFileSync("BUILDING.md", "utf8");

assert.equal(app.expo.version, pkg.version);
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 116, "v2.1.116 identity/Drive/signing regression must remain active in later releases");
assert.ok(app.expo.android.versionCode >= 116);
assert.equal(app.expo.name, "My LOOI");
assert.equal(app.expo.slug, "my-looi");
assert.equal(app.expo.scheme, "mylooi");
assert.equal(app.expo.android.package, "io.github.razor79.mylooi");
assert.equal(app.expo.ios.bundleIdentifier, "io.github.razor79.mylooi");
assert.notEqual(app.expo.android.package, "com.anonymous.superlooiapp");

if (patchVersion < 119) {
  const driveGradle = fs.readFileSync("modules/google-drive-storage/android/build.gradle", "utf8");
  const driveNative = fs.readFileSync(
    "modules/google-drive-storage/android/src/main/java/io/github/razor79/mylooi/googledrivestorage/GoogleDriveStorageModule.kt",
    "utf8"
  );
  const driveTs = fs.readFileSync("modules/google-drive-storage/index.ts", "utf8");
  assert.match(driveGradle, /play-services-auth:21\.6\.0/);
  assert.match(driveTs, /requireNativeModule<GoogleDriveStorageModule>\("GoogleDriveStorage"\)/);
  assert.match(driveNative, /Identity\.getAuthorizationClient/);
  assert.match(driveNative, /Scope\(Scopes\.DRIVE_FILE\)/);
  assert.match(driveNative, /PICKER_ALLOW_FOLDER_SELECTION/);
  assert.match(diagnosticTs, /GoogleDriveStorage\.selectFolder/);
  assert.match(ui, /Сохранить в Google Drive/);
} else {
  assert.equal(fs.existsSync("modules/google-drive-storage"), false);
  assert.equal(fs.existsSync("src/diagnostics/diagnostic-drive-settings.ts"), false);
  assert.doesNotMatch(diagnosticTs, /GoogleDriveStorage|chooseDiagnosticDriveFolder|saveCombinedDiagnosticExportToDrive/);
  assert.doesNotMatch(ui, /Выбрать папку Google Drive|Сохранить в Google Drive|Забыть папку Google Drive/);
}
assert.match(ui, /t\("settings\.chooseLocalFolder"\)/);
assert.match(ui, /t\("settings\.diagnosticsHelp"/);
assert.match(uiStrings, /"settings\.chooseLocalFolder": "Choose local folder"/);
assert.match(uiStrings, /no automatic upload/);
assert.match(localStorageNative, /Intent\.ACTION_OPEN_DOCUMENT_TREE/);

for (const variable of [
  "MY_LOOI_RELEASE_KEYSTORE",
  "MY_LOOI_RELEASE_STORE_PASSWORD",
  "MY_LOOI_RELEASE_KEY_ALIAS",
  "MY_LOOI_RELEASE_KEY_PASSWORD",
]) {
  assert.match(build, new RegExp(variable));
  assert.match(signingPatch, new RegExp(variable));
}
assert.match(build, /apply-android-release-signing\.mjs/);
assert.match(build, /CN=Android Debug/);
assert.match(build, /apksigner/);
assert.match(signingPatch, /myLooiRelease/);
assert.match(keygen, /keytool -genkeypair/);
assert.match(keygen, /my-looi-release\.keystore/);
assert.match(gitignore, /\*\.keystore/);
assert.match(gitignore, /\*\.jks/);

for (const doc of [readme, features, privacy]) {
  assert.match(doc, /Google Drive/);
  if (patchVersion >= 119) assert.doesNotMatch(doc, /drive\.file|Google Picker API|Google Drive API/);
}
assert.match(building, /io\.github\.razor79\.mylooi/);
assert.match(building, /create-release-keystore\.sh/);
assert.match(building, /MY_LOOI_RELEASE_KEYSTORE/);
if (patchVersion >= 119) assert.doesNotMatch(building, /Google Picker API|Google Drive API|drive\.file/);

console.log("v2.1.116 identity/Drive/signing regression: PASS");
