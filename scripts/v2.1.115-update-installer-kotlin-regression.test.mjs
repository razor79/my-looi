import assert from "node:assert/strict";
import fs from "node:fs";

const sourcePath =
  "modules/app-update-installer/android/src/main/java/com/superlooi/appupdateinstaller/AppUpdateInstallerModule.kt";
const source = fs.readFileSync(sourcePath, "utf8");

assert.match(
  source,
  /AsyncFunction\("canRequestPackageInstalls"\)\s+Coroutine\s+::canRequestInstalls/,
  "zero-argument Coroutine registration must use an unambiguous function reference"
);
assert.doesNotMatch(
  source,
  /AsyncFunction\("canRequestPackageInstalls"\)\s+Coroutine\s*\{/,
  "zero-argument Coroutine lambda is ambiguous with Expo Modules Kotlin overloads"
);
assert.match(
  source,
  /private fun canRequestInstalls\(\): Boolean/,
  "canRequestInstalls helper must remain a zero-argument Boolean function"
);

const appConfig = JSON.parse(fs.readFileSync("app.json", "utf8"));
const packageConfig = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.equal(appConfig.expo.version, packageConfig.version);
const patchVersion = Number(packageConfig.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 115, "v2.1.115 updater regression must remain active in later releases");
assert.ok(appConfig.expo.android.versionCode >= 115, "Android versionCode must remain at least v2.1.115");

console.log("Update installer Kotlin coroutine registration regression: PASS");
