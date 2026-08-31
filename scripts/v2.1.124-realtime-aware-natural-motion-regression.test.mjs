import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 124);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 124);

const conversation = read("src/store/conversation.ts");
assert.match(conversation, /isUserSpeaking: boolean/);
assert.match(conversation, /setUserSpeaking: \(speaking: boolean\) => void/);
assert.match(conversation, /isUserSpeaking: false/);

const pcm = read("src/voice/realtime-pcm-conversation.ts");
const speechStarted = pcm.slice(
  pcm.indexOf('if (type === "input_audio_buffer.speech_started")'),
  pcm.indexOf('if (type === "input_audio_buffer.speech_stopped")')
);
const speechStopped = pcm.slice(
  pcm.indexOf('if (type === "input_audio_buffer.speech_stopped")'),
  pcm.indexOf('if (type === "conversation.item.input_audio_transcription.completed")')
);
assert.match(speechStarted, /markRobotInteraction\("realtime-pcm-speech-start"\)/, "actual speech must immediately preempt natural motion");
assert.match(speechStarted, /store\.setUserSpeaking\(true\)/, "server VAD speech_started must mark actual human speech");
assert.match(speechStopped, /store\.setUserSpeaking\(false\)/, "server VAD speech_stopped must clear actual human speech");
assert.match(pcm, /captureRequested: "VOICE_COMMUNICATION\/16000\/mono\/pcm16\/explicit-platform-aec"/);
assert.match(pcm, /audioSource !== "VOICE_COMMUNICATION"/);
assert.match(pcm, /captureSampleRate !== 16_000/);

const ambient = read("src/core/ambient-motion.ts");
assert.match(ambient, /if \(conversation\.isUserSpeaking\) return "user-speaking"/);
assert.doesNotMatch(ambient, /conversation\.isListening \|\|/, "passive Realtime listening must not block idle motion");
assert.doesNotMatch(ambient, /voiceState !== "sleeping"/, "Realtime waiting state must not block ambient motion");
assert.match(ambient, /lively: \[1_800, 3_200\]/, "lively mode should visibly start within a few seconds");
assert.match(ambient, /lively: \[2_500, 5_500\]/, "lively idle cadence should be much quicker than v2.1.123");
assert.match(ambient, /context === "processing"/);
assert.match(ambient, /context === "speaking"/);
assert.match(ambient, /performLooiHeadGesture\("thinking"\)/);
assert.match(ambient, /performLooiHeadGesture\("speaking_soft"\)/);
assert.match(ambient, /"ambient-motion-blocked"/);
assert.match(ambient, /performLooiAmbientPivot\(direction, durationMs\)/);
assert.doesNotMatch(ambient, /startLooiMotion|turnLooi|moveLooi/);

const robot = read("src/device-tools/looi-robot.ts");
assert.match(robot, /case "thinking":/);
assert.match(robot, /case "speaking_soft":/);

const user = read("src/store/user.ts");
assert.match(user, /AmbientMotionLevel = "off" \| "subtle" \| "normal" \| "lively"/);
const storedVersion = Number(user.match(/stored\.version !== (\d+)/)?.[1]);
const savedVersion = Number(user.match(/version: (\d+), preferences/)?.[1]);
assert.ok(storedVersion >= 8);
assert.ok(savedVersion >= 8);

const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /ambientMotionLevel === "lively"/);
assert.match(settings, /ambientMotionLevel: "lively"/);

const strings = read("src/i18n/ui-strings.ts");
assert.equal((strings.match(/"settings\.ambientMotionLively":/g) ?? []).length, 3);

console.log("v2.1.124 realtime-aware natural motion regression: PASS");
