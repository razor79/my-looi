import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

assert.equal(pkg.version, "2.1.136");
assert.equal(app.expo.version, "2.1.136");
assert.equal(app.expo.android.versionCode, 136);

const realtime = read("src/voice/realtime-config.ts");
assert.match(realtime, /type: "server_vad"[\s\S]*threshold: 0\.15,[\s\S]*prefix_padding_ms: 500,[\s\S]*silence_duration_ms: 1000,/);
assert.match(realtime, /noise_reduction: \{ type: "far_field" \}/);
assert.match(realtime, /REALTIME_UPLINK_GAIN = 2\.0/);
assert.match(realtime, /export function applyRealtimeUplinkGain/);
assert.match(realtime, /Math\.max\(-1, Math\.min\(1, sample\)\)/);

const pcm = read("src/voice/realtime-pcm-conversation.ts");
assert.match(pcm, /const gainedSamples = applyRealtimeUplinkGain\(samples\);[\s\S]*resample16kTo24k\(gainedSamples\)/);
assert.match(pcm, /const gainedPreroll = applyRealtimeUplinkGain\(preroll\.samples\);[\s\S]*resample16kTo24k\(gainedPreroll\)/);
assert.match(pcm, /uplinkGain: REALTIME_UPLINK_GAIN/);
assert.match(pcm, /gainClippedSamples/);
assert.match(pcm, /input_audio_buffer\.append/);

const nativePcm = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
assert.match(nativePcm, /CAPTURE_RATE = 16_000/);
assert.match(nativePcm, /PLAYBACK_RATE = 24_000/);
assert.match(nativePcm, /MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
assert.match(nativePcm, /AcousticEchoCanceler\.create/);
assert.match(nativePcm, /echo\.enabled = true/);
assert.doesNotMatch(nativePcm, /NoiseSuppressor\.create/);
assert.doesNotMatch(nativePcm, /AutomaticGainControl\.create/);

const social = read("src/core/social-attention.ts");
const ambient = read("src/core/ambient-motion.ts");
assert.match(social, /holdAmbientHeadMotionFor\(FACE_STALE_MS \+ 350, "attention-face-tracked"\)/);
assert.match(social, /holdAmbientHeadMotionFor\(HEAD_COOLDOWN_MS \+ FACE_STALE_MS, "attention-head-correction"\)/);
assert.match(ambient, /export function holdAmbientHeadMotionFor/);
assert.match(ambient, /isHeadAmbientAction\(action\) && Date\.now\(\) < headCoordinationHoldUntil/);
assert.match(ambient, /return action !== "body-left" && action !== "body-right"/);
assert.doesNotMatch(social, /moveLooi\("forward"|moveLooi\("back/);

const face = read("src/ui/RobotFace.tsx");
assert.match(face, /gazeTravelX = isAvatar \? 4 : 26/);
assert.match(face, /gazeTravelY = isAvatar \? 3 : 15/);
assert.match(face, /cowboy: \{/);
assert.match(face, /bandana: \{/);
assert.match(face, /cowboyDecor/);
assert.match(face, /bandanaDecor/);
assert.match(face, /avatarBandanaTailOne/);
assert.match(face, /avatarBandanaTailTwo/);
assert.match(face, /capDecor/);
assert.doesNotMatch(face, /fringeStroke/);

const user = read("src/store/user.ts");
assert.match(user, /FaceStyleId = [^;]*"cowboy"[^;]*"bandana"/);

const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /FACE_STYLE_OPTIONS: FaceStyleId\[\] = \[[^\]]*"cowboy"[^\]]*"bandana"/);
assert.match(settings, /const \[customPhrasesExpanded, setCustomPhrasesExpanded\] = useState\(false\)/);
assert.match(settings, /settings\.customPhrasesSummary/);
assert.match(settings, /customPhrasesExpanded \? <View style=\{styles\.disclosureBody\}>/);
assert.match(settings, /parseRealtimePhysicalCommand\(testText, preferences\)/);

const strings = read("src/i18n/ui-strings.ts");
for (const key of ["settings.customPhrasesSummary", "settings.customPhrasesHelp", "settings.faceStyle.cowboy", "settings.faceStyle.bandana"]) {
  assert.equal((strings.match(new RegExp(`"${key.replaceAll(".", "\\.")}":`, "g")) ?? []).length, 3, `${key} must exist in all UI languages`);
}
assert.equal((strings.match(/"settings\.faceStyle\.fringe": "(?:Cap|Кепка)"/g) ?? []).length, 3, "legacy fringe option must render as a cap in all UI languages");

console.log("v2.1.136 uplink gain + social gaze/head ownership + compact custom phrases + face accessories regression: PASS");
