import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
const helper = fs.readFileSync("scripts/build-my-looi.sh", "utf8");
const projectBuild = fs.readFileSync("scripts/build-android-apk.sh", "utf8");
const configureSigning = fs.readFileSync("scripts/configure-release-signing.sh", "utf8");
const keygen = fs.readFileSync("scripts/create-release-keystore.sh", "utf8");
const building = fs.readFileSync("BUILDING.md", "utf8");

assert.equal(app.expo.version, pkg.version);
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 118, "v2.1.118 build-helper regression must remain active in later releases");
assert.ok(app.expo.android.versionCode >= 118);

// The public helper must preserve only ROOT generated android/, never nested
// native module Android source. Anchored rsync exclusions protect this rule.
assert.match(helper, /--exclude '\/android\/'/);
assert.doesNotMatch(helper, /--exclude 'android\/'/);
assert.match(helper, /modules\/\*\/android\/build/);
assert.match(helper, /sync_authoritative_source/);
assert.match(helper, /rsync -a --checksum --delete/);
assert.match(helper, /cp -a --reflink=auto/);
assert.match(helper, /MY_LOOI_INCREMENTAL_BUILD=1/);
assert.match(helper, /--fresh/);
assert.match(helper, /release\.env/);
assert.match(helper, /\.looi-build\.env/);

// Direct builds remain clean by default; only the generic helper opts into
// incremental Expo prebuild after it has carried safe generated state forward.
assert.match(projectBuild, /MY_LOOI_INCREMENTAL_BUILD/);
assert.match(projectBuild, /expo prebuild --platform android --clean/);
assert.match(projectBuild, /expo prebuild --platform android\n/);
assert.match(projectBuild, /--build-cache/);
assert.match(projectBuild, /\.config\/my-looi\/signing\/release\.env/);
assert.match(projectBuild, /find "\$signing_env" -perm \/077/);

// One-time local signing setup stores secrets outside the repository with
// private permissions and supports the one-password keystore created here.
assert.match(configureSigning, /\.config\/my-looi\/signing\/release\.env/);
assert.match(configureSigning, /chmod 600/);
assert.match(configureSigning, /press Enter to use the same password/);
assert.match(configureSigning, /key_password="\$store_password"/);
assert.match(configureSigning, /printf 'MY_LOOI_RELEASE_STORE_PASSWORD=%q/);
assert.match(keygen, /configure-release-signing\.sh/);

assert.match(building, /scripts\/build-my-looi\.sh/);
assert.match(building, /\.\/build-my-looi\.sh --fresh/);
assert.match(building, /configure-release-signing\.sh/);
assert.match(building, /release\.env/);

console.log("v2.1.118 incremental build/signing helper regression: PASS");
