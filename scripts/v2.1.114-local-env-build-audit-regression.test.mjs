import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
const audit = fs.readFileSync("scripts/public-repository-audit.mjs", "utf8");
const build = fs.readFileSync("scripts/build-android-apk.sh", "utf8");

assert.equal(app.expo.version, pkg.version);
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 114);
assert.ok(app.expo.android.versionCode >= 114);

// Publication/source audits stay strict unless the Android build explicitly opts in.
assert.match(audit, /MY_LOOI_BUILD_ALLOW_LOCAL_ENV/);
assert.match(audit, /name === "\.env" && allowLocalBuildEnv/);
assert.doesNotMatch(audit, /name\.startsWith\("\.env"\) && allowLocalBuildEnv/);
assert.match(build, /MY_LOOI_BUILD_ALLOW_LOCAL_ENV=1 corepack pnpm test/);

console.log("Local .env build/public-audit regression: PASS");
