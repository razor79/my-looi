import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

for (const retiredPath of [
  "server",
  "src/server-api",
  "docker-compose.yml",
  `docker-compose.${["syn", "ology"].join("")}.yml`,
  `.env.${["syn", "ology"].join("")}.example`,
  `scripts/deploy-${["syn", "ology"].join("")}-server.sh`,
  "src/voice/local-realtime-asr.ts",
  "src/voice/local-gigaam-russian-model.ts",
  "src/voice/local-asr-response-pause.ts",
]) {
  assert.equal(existsSync(retiredPath), false, `${retiredPath} must stay retired`);
}

const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /Realtime PCM/);
assert.match(settings, /Realtime WebRTC \(legacy A\/B\)/);
assert.doesNotMatch(settings, /Realtime \+ Local ASR|GigaAM/);

const home = read("app/(tabs)/index.tsx");
assert.match(home, /gearshape\.fill/);
assert.match(home, /applyLiveRealtimePreferences/);
assert.doesNotMatch(home, /quickPanelVisible|quickActions|quickPanel:/);

const store = read("src/store/user.ts");
assert.match(store, /conversationMode: "realtime_pcm"/);
assert.doesNotMatch(store, /realtime_local_asr|localAsrResponsePause/);

const runtime = read("src/perceivers/voice-runtime.ts");
assert.match(runtime, /applyLiveRealtimePreferences/);
assert.match(runtime, /applySessionPreferences/);

const pcm = read("src/voice/realtime-pcm-conversation.ts");
assert.match(pcm, /pcm-session-preferences-updated/);
assert.match(pcm, /sessionMemoryContext/);
assert.match(pcm, /buildRealtimeSessionUpdate\(preferences, undefined, this\.sessionMemoryContext\)/);

const webrtc = read("src/voice/realtime-conversation.ts");
assert.match(webrtc, /webrtc-session-preferences-updated/);
assert.doesNotMatch(webrtc, /localRealtimeAsrService|localTextInputMode|GigaAM/);

const nativeCapture = read("modules/local-realtime-audio-capture/android/src/main/java/com/superlooi/localrealtimecapture/RealtimePcmAudioModule.kt");
const startRecording = nativeCapture.indexOf("audioRecord.startRecording()") >= 0
  ? nativeCapture.indexOf("audioRecord.startRecording()")
  : nativeCapture.indexOf("currentRecord.startRecording()");
const attachAec = nativeCapture.indexOf("AcousticEchoCanceler.create");
assert.ok(startRecording >= 0, "AudioRecord.startRecording must exist");
assert.ok(attachAec > startRecording, "hardware AEC must attach after recording starts");

const bootstrap = read("src/core/app-bootstrap.ts");
assert.doesNotMatch(bootstrap, /startAuthenticatedNetworkConnections/);
assert.match(bootstrap, /perceiverManager\.register\(voiceRuntime\)/);

const envExample = read(".env.example");
assert.doesNotMatch(envExample, /API_KEY\s*=\s*\S+/);
assert.doesNotMatch(envExample, /DATABASE_URL|VISION_SERVER_URL/);

console.log("Current runtime anti-regression: PASS");
