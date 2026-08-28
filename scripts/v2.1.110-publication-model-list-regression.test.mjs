import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const app = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
const models = readFileSync(join(root, "src/openai/realtime-models.ts"), "utf8");
const settings = readFileSync(join(root, "app/(tabs)/settings.tsx"), "utf8");
const uiStrings = readFileSync(join(root, "src/i18n/ui-strings.ts"), "utf8");
const build = readFileSync(join(root, "scripts/build-android-apk.sh"), "utf8");

assert.equal(pkg.name, "my-looi");
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 110, `expected My LOOI 2.1.110+ release, got ${pkg.version}`);
assert.equal(app.expo.name, "My LOOI");
assert.equal(app.expo.slug, "my-looi");
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 110, "public My LOOI release must retain monotonically increasing Android versionCode");
// v2.1.116 intentionally resets the Android identity before broad distribution so
// future public releases no longer inherit the old Expo/Super LOOI package name.
if (patchVersion >= 116) {
  assert.equal(app.expo.android.package, "io.github.razor79.mylooi");
} else {
  assert.equal(app.expo.android.package, "com.anonymous.superlooiapp");
}

assert.match(models, /OFFICIALLY_DEPRECATED_REALTIME_MODEL_BASES[\s\S]*"gpt-realtime-mini"[\s\S]*"gpt-realtime"/);
assert.match(models, /PREVIOUS_SUPPORTED_REALTIME_MODEL_BASES[\s\S]*"gpt-realtime-2"[\s\S]*"gpt-realtime-1\.5"/);
assert.match(settings, /filter\(\(model\) => !isOfficiallyDeprecatedRealtimeModelId\(model\.id\)\)/);
assert.match(settings, /t\("settings\.previousModels"\)/);
assert.match(settings, /t\("settings\.modelRecommended"\)/);
assert.match(settings, /t\("settings\.modelQuality"\)/);
assert.match(uiStrings, /"settings\.previousModels": "Previous models"/);
assert.match(uiStrings, /"settings\.modelRecommended": "Recommended · Best value"/);
assert.match(uiStrings, /"settings\.modelQuality": "Highest quality"/);
assert.match(settings, /choiceRecommended/);
assert.match(settings, /choiceQuality/);
assert.match(settings, /choicePrevious/);

for (const file of ["README.md", "FEATURES.md", "BUILDING.md", "PRIVACY.md", "THIRD_PARTY_NOTICES.md"]) {
  assert.equal(existsSync(join(root, file)), true, `${file} must be present in the public repository`);
}
assert.equal(existsSync(join(root, "demo.jpg")), false, "private/home demo photo must not be public");
assert.equal(existsSync(join(root, "assets/diagnostics")), false, "unknown diagnostic voice fixtures must not be public");
assert.match(build, /my-looi-arm64\.apk/);

console.log("Publication/model-list regression: PASS");
