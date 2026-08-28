import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
const diagnosticLog = fs.readFileSync("src/diagnostics/diagnostic-log.ts", "utf8");
const updater = fs.readFileSync("src/updates/github-release-updater.ts", "utf8");

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 113, "v2.1.113 update diagnostic regression must remain active in later releases");
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 113);
assert.match(diagnosticLog, /\| "update"/);
assert.match(updater, /recordDiagnosticEvent\("update", "github-release-checked"/);
assert.match(updater, /recordDiagnosticEvent\("update", "apk-downloaded-verified"/);
assert.match(updater, /recordDiagnosticEvent\("update", "package-installer-opened"/);

console.log("Update diagnostic category regression: PASS");
