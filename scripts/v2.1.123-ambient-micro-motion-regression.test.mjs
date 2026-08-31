import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));
const patchVersion = Number(pkg.version.split(".")[2]);

assert.ok(Number.isInteger(patchVersion) && patchVersion >= 123, "ambient-motion regression must remain active in later releases");
assert.equal(app.expo.android.versionCode >= 123, true);

const ambient = read("src/core/ambient-motion.ts");
assert.match(ambient, /isMainScreenFocused\(\)/, "ambient motion must be limited to the face/main screen");
assert.match(ambient, /conversation\.isUserSpeaking/, "ambient motion must yield while the human is actually speaking");
assert.doesNotMatch(ambient, /conversation\.isListening \|\|/, "passive Realtime listening must not block idle motion");
assert.match(ambient, /isDrivingControlSessionActive\(\)/, "ambient motion must yield to deterministic driving control");
assert.match(ambient, /robot\.motionActive/, "ambient motion must not start over real robot motion");
assert.match(ambient, /INTERACTION_COOLDOWN_MS/, "ambient motion must have a user-interaction cooldown");
assert.match(ambient, /performLooiHeadGesture\("curious"\)/);
assert.match(ambient, /performLooiHeadGesture\("sleepy"\)/);
assert.match(ambient, /performLooiAmbientPivot\(direction, durationMs\)/);
assert.match(ambient, /performLooiAmbientPivot\(returnDirection, durationMs\)/);
assert.doesNotMatch(ambient, /startLooiMotion|turnLooi|moveLooi/, "ambient controller must not use continuous/full-turn motion APIs");

const robot = read("src/device-tools/looi-robot.ts");
assert.match(robot, /export async function performLooiAmbientPivot/);
assert.match(robot, /Math\.max\(80, Math\.min\((?:180|240)/);
assert.match(robot, /runBoundedMotion\(direction, boundedDurationMs, "manual-bounded"/);
assert.match(robot, /ambientMotion: true/);

const userStore = read("src/store/user.ts");
assert.match(userStore, /export type AmbientMotionLevel = "off" \| "subtle" \| "normal" \| "lively"/);
assert.match(userStore, /ambientMotionLevel: "normal"/);
const storedVersion = Number(userStore.match(/stored\.version !== (\d+)/)?.[1]);
const savedVersion = Number(userStore.match(/version: (\d+), preferences/)?.[1]);
assert.ok(storedVersion >= 8);
assert.ok(savedVersion >= 8);

const bootstrap = read("src/core/app-bootstrap.ts");
assert.match(bootstrap, /startAmbientMotionController\("bootstrap"\)/);
assert.match(bootstrap, /stopAmbientMotionController\(reason\)/);
assert.match(bootstrap, /startAmbientMotionController\("foreground-resume"\)/);

const inactivity = read("src/core/robot-inactivity.ts");
assert.match(inactivity, /noteAmbientMotionInteraction\(source\)/, "touch/classic interactions must preempt ambient scheduling");

const pcm = read("src/voice/realtime-pcm-conversation.ts");
assert.match(pcm, /markRobotInteraction\("realtime-pcm-transcript"\)/, "Realtime PCM transcripts must preempt ambient scheduling and reset inactivity");

const settings = read("app/(tabs)/settings.tsx");
for (const level of ["off", "subtle", "normal", "lively"]) {
  assert.match(settings, new RegExp(`ambientMotionLevel === "${level}"`));
  assert.match(settings, new RegExp(`ambientMotionLevel: "${level}"`));
}

const strings = read("src/i18n/ui-strings.ts");
assert.equal((strings.match(/"settings\.ambientMotion":/g) ?? []).length, 3);
assert.equal((strings.match(/"settings\.ambientMotionHelp":/g) ?? []).length, 3);
assert.equal((strings.match(/"settings\.ambientMotionOff":/g) ?? []).length, 3);
assert.equal((strings.match(/"settings\.ambientMotionSubtle":/g) ?? []).length, 3);
assert.equal((strings.match(/"settings\.ambientMotionNormal":/g) ?? []).length, 3);
assert.equal((strings.match(/"settings\.ambientMotionLively":/g) ?? []).length, 3);

console.log("v2.1.123 ambient micro-motion regression: PASS");
