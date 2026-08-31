import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 127);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 127);

const user = read("src/store/user.ts");
assert.match(user, /export type FaceSkinId = "classic" \| "soft" \| "pixel" \| "spark"/);
assert.match(user, /faceSkin: FaceSkinId/);
assert.match(user, /faceSkin: "classic"/);
const storedVersion = Number(user.match(/stored\.version !== (\d+)/)?.[1]);
const savedVersion = Number(user.match(/version: (\d+), preferences/)?.[1]);
assert.ok(storedVersion >= 10);
assert.ok(savedVersion >= 10);

const realtime = read("src/voice/realtime-config.ts");
assert.match(realtime, /robotAddressRecognitionAliases/);
assert.match(realtime, /Every one of these names or recognition variants refers to YOU, the robot, never to the human user/);
assert.match(realtime, /Do not correct them back to/);
assert.match(realtime, /never infer that an alias is the user's name/);
assert.match(realtime, /likely STT variants may include/);

const explicit = read("src/voice/explicit-robot-command.ts");
assert.match(explicit, /matchingActions/);
assert.match(explicit, /new Set\(matchingActions\)\.size === 1/);
assert.match(explicit, /\(\?:спи\|спать\|засни/);
assert.match(explicit, /customActionFor\(command, config\)/);

const helper = read("src/voice/realtime-physical-command.ts");
assert.match(helper, /preferenceSnapshot\?: VoiceCommandPreferences/);
assert.match(helper, /preferenceSnapshot \?\? useUserStore\.getState\(\)\.preferences/);
const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /parseRealtimePhysicalCommand\(testText, preferences\)/);
assert.match(settings, /FaceAppearanceSettings/);
assert.ok(/FACE_SKIN_OPTIONS/.test(settings) || /FACE_STYLE_OPTIONS/.test(settings));
const pcm = read("src/voice/realtime-pcm-conversation.ts");
assert.match(pcm, /parseRealtimePhysicalCommand\(transcript, useUserStore\.getState\(\)\.preferences\)/);

const face = read("src/ui/RobotFace.tsx");
assert.ok(/FACE_SKINS/.test(face) || /FACE_STYLES/.test(face));
assert.match(face, /renderedMouth/);

const strings = read("src/i18n/ui-strings.ts");
assert.equal((strings.match(/"settings\.appearance":/g) ?? []).length, 3, "appearance must exist in all UI languages");

// Guard the accepted movement/audio architecture: this feature is UI/prompt/parser metadata only.
assert.equal(realtime.includes("movement tool"), true);
assert.equal(helper.includes("startLooiMotion("), false);

console.log("v2.1.127 robot identity + face skins + custom phrase regression: PASS");
