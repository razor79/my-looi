import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

assert.equal(app.expo.version, pkg.version);
const [, , patchVersionText] = pkg.version.split(".");
const patchVersion = Number.parseInt(patchVersionText, 10);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 121);
assert.ok(app.expo.android.versionCode >= 121);
assert.equal(app.expo.android.package, "io.github.razor79.mylooi");

const languageSource = read("src/i18n/ui-language.ts");
assert.match(languageSource, /type InterfaceLanguage = "uk" \| "en" \| "ru"/);
assert.match(languageSource, /id: "uk"[\s\S]*id: "en"[\s\S]*id: "ru"/);
assert.match(languageSource, /uk:\s*"uk-UA"/);
assert.match(languageSource, /en:\s*"en-US"/);
assert.match(languageSource, /ru:\s*"ru-RU"/);
assert.match(languageSource, /startsWith\("uk-"\)/);
assert.match(languageSource, /startsWith\("ru-"\)/);

const store = read("src/store/user.ts");
assert.match(store, /interfaceLanguage:\s*InterfaceLanguage/);
assert.match(store, /interfaceLanguage:\s*detectSystemInterfaceLanguage\(\)/);
assert.match(store, /version:\s*1 \| 2 \| 3 \| 4 \| 5 \| 6/);
const savedPreferencesVersion = Number(store.match(/version:\s*(\d+),\s*preferences/)?.[1]);
assert.ok(Number.isInteger(savedPreferencesVersion) && savedPreferencesVersion >= 6);

const strings = read("src/i18n/ui-strings.ts");
assert.match(strings, /const en = \{/);
assert.match(strings, /const uk: TranslationTable = \{/);
assert.match(strings, /const ru: TranslationTable = \{/);
assert.match(strings, /"settings\.interfaceLanguage"/);
assert.match(strings, /"onboarding\.interfaceLanguage"/);
assert.match(strings, /"nav\.settings"/);
assert.match(strings, /"history\.heading"/);
assert.match(strings, /"memory\.savedFacts"/);
assert.match(strings, /getLocalizedModelDownloadStage/);

const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /INTERFACE_LANGUAGE_OPTIONS\.map/);
assert.match(settings, /interfaceLanguage:\s*(?:item|option)\.id/);
assert.match(settings, /LISTENING_LANGUAGE_OPTIONS\.map/);
assert.match(settings, /RESPONSE_LANGUAGE_OPTIONS\.map/);
assert.match(settings, /formatConversationCostPerMinute\(model\.id, interfaceLanguage\)/);

const onboarding = read("app/onboarding.tsx");
assert.match(onboarding, /INTERFACE_LANGUAGE_OPTIONS\.map/);
assert.match(onboarding, /interfaceLanguage:\s*(?:item|option)\.id/);

for (const file of [
  "app/(tabs)/index.tsx",
  "app/(tabs)/conversation.tsx",
  "app/(tabs)/memories.tsx",
  "app/(tabs)/settings.tsx",
  "app/onboarding.tsx",
  "app/+not-found.tsx",
  "src/ui/DeviceShell.tsx",
  "src/ui/ConversationOverlay.tsx",
  "src/ui/RobotFace.tsx",
  "src/ui/VoiceButton.tsx",
]) {
  assert.match(read(file), /useUiText/ , `${file} must use localized UI text`);
}

const userFacing = [
  "app/(tabs)/conversation.tsx",
  "app/(tabs)/memories.tsx",
  "src/ui/ChatBubble.tsx",
  "src/ui/MemoryCard.tsx",
];
for (const file of userFacing) {
  assert.doesNotMatch(read(file), /toLocale(?:Date|Time)String\("ru-RU"/);
}

assert.equal(fs.existsSync(path.join(root, "app/modal.tsx")), false, "unused Expo template modal must stay removed");
assert.equal(fs.existsSync(path.join(root, "components/EditScreenInfo.tsx")), false, "unused Expo template screen must stay removed");

for (const file of ["README.md", "FEATURES.md", "CHANGELOG.md"]) {
  const doc = read(file);
  assert.match(doc, /Ukrainian, English and Russian/);
}
assert.ok(fs.existsSync(path.join(root, "CHANGELOG.md")));

console.log("v2.1.121 UI localization regression: PASS");
