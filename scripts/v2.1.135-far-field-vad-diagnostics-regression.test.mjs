import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 135);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 135);

const realtime = read("src/voice/realtime-config.ts");
assert.match(realtime, /type: "server_vad"[\s\S]*threshold: 0\.(?:10|15),[\s\S]*prefix_padding_ms: 500,[\s\S]*silence_duration_ms: 1000,/);
assert.match(realtime, /noise_reduction: \{ type: "far_field" \}/);
assert.match(realtime, /REALTIME_SOURCE_PCM_RATE = 16_000/);
assert.match(realtime, /REALTIME_PCM_RATE = 24_000/);

const pcmConversation = read("src/voice/realtime-pcm-conversation.ts");
assert.match(pcmConversation, /UPLINK_LEVEL_WINDOW_MS = 500/);
assert.match(pcmConversation, /captureLevelWindowEnergy/);
assert.match(pcmConversation, /windowRms/);
assert.match(pcmConversation, /maxChunkRms/);
assert.match(pcmConversation, /windowFrames/);
assert.match(pcmConversation, /firstSequence/);
assert.match(pcmConversation, /input_audio_buffer\.append/);

const nativePcm = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
assert.match(nativePcm, /CAPTURE_RATE = 16_000/);
assert.match(nativePcm, /PLAYBACK_RATE = 24_000/);
assert.match(nativePcm, /MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
assert.match(nativePcm, /AcousticEchoCanceler\.create/);
assert.match(nativePcm, /echo\.enabled = true/);
assert.doesNotMatch(nativePcm, /NoiseSuppressor\.create/);
assert.doesNotMatch(nativePcm, /AutomaticGainControl\.create/);

const social = read("src/core/social-attention.ts");
assert.match(social, /BODY_POST_MOTION_SETTLE_MS = 1_300/);
assert.match(social, /SEARCH_REARM_LOST_MS = 4_500/);
assert.doesNotMatch(social, /moveLooi\("forward"|moveLooi\("back/);

console.log("v2.1.135 far-field VAD + uplink diagnostics regression: PASS");
