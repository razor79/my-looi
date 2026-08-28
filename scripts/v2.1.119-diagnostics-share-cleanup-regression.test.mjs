import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
const diagnosticTs = fs.readFileSync("src/diagnostics/diagnostic-export.ts", "utf8");
const ui = fs.readFileSync("app/(tabs)/settings.tsx", "utf8");
const uiStrings = fs.readFileSync("src/i18n/ui-strings.ts", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const features = fs.readFileSync("FEATURES.md", "utf8");
const privacy = fs.readFileSync("PRIVACY.md", "utf8");
const building = fs.readFileSync("BUILDING.md", "utf8");

assert.equal(app.expo.version, pkg.version);
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 119, "v2.1.119 diagnostics cleanup regression must remain active in later releases");
assert.ok(app.expo.android.versionCode >= 119);

// Product identity/signing continuity remains fixed after the v2.1.116 migration.
assert.equal(app.expo.name, "My LOOI");
assert.equal(app.expo.slug, "my-looi");
assert.equal(app.expo.scheme, "mylooi");
assert.equal(app.expo.android.package, "io.github.razor79.mylooi");
assert.equal(app.expo.ios.bundleIdentifier, "io.github.razor79.mylooi");

// Direct Google Drive OAuth/Picker integration was deliberately retired. The
// user can still choose Google Drive from Android's native Share sheet.
assert.equal(fs.existsSync("modules/google-drive-storage"), false);
assert.equal(fs.existsSync("src/diagnostics/diagnostic-drive-settings.ts"), false);
assert.doesNotMatch(diagnosticTs, /GoogleDriveStorage|drive\.file|PICKER_|googleapis\.com\/drive/i);
assert.doesNotMatch(ui, /Выбрать папку Google Drive|Сохранить в Google Drive|Забыть папку Google Drive/);
assert.doesNotMatch(building, /Google Picker API|Google Drive API|drive\.file/);
for (const doc of [readme, features, privacy]) {
  assert.doesNotMatch(doc, /drive\.file|Google Picker API|Google Drive API/);
}

// Keep both manual diagnostics paths that are useful on the child device.
assert.match(diagnosticTs, /Sharing\.shareAsync/);
assert.match(diagnosticTs, /BackupStorageAccess\.selectFolder/);
assert.match(diagnosticTs, /BackupStorageAccess\.writePrivateFile/);
assert.match(ui, /t\("settings\.shareZip"\)/);
assert.match(ui, /t\("settings\.diagnosticsHelp"/);
assert.match(ui, /t\("settings\.chooseLocalFolder"\)/);
assert.match(ui, /t\("settings\.saveLocal"\)/);
assert.match(uiStrings, /Google Drive, if installed/);
assert.match(uiStrings, /no automatic upload/);
assert.match(readme, /Android share sheet/);
assert.match(privacy, /does not request direct Google Drive authorization/);
assert.doesNotMatch(diagnosticTs, /BackgroundFetch|TaskManager|setInterval/i);

console.log("v2.1.119 diagnostics native-share cleanup regression: PASS");
