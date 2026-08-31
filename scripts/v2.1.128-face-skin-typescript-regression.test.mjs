import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 128);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 128);

const face = read("src/ui/RobotFace.tsx");
assert.doesNotMatch(face, /\bEYE_COLOR\b/, "removed legacy EYE_COLOR constant must not be referenced");
assert.match(face, /backgroundColor:\s*renderedMouth === "smile" \? "transparent" : (?:skin|palette)\.mouthColor/);
assert.match(face, /borderBottomColor:\s*(?:skin|palette)\.mouthColor/);
assert.ok(/FACE_SKINS/.test(face) || /FACE_STYLES/.test(face));

// This patch is deliberately build-only: do not touch protected movement/audio paths.
const pcm = read("src/voice/realtime-pcm-conversation.ts");
const robot = read("src/device-tools/looi-robot.ts");
assert.ok(pcm.includes("VOICE_COMMUNICATION") || read("modules/realtime-pcm-audio/android/src/main/java/com/superlooi/realtimepcmaudio/RealtimePcmAudioModule.kt").includes("VOICE_COMMUNICATION"));
assert.match(robot, /ambientMotion: true/);

console.log("v2.1.128 face-skin TypeScript build regression: PASS");
