import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  module._compile(output, filename);
};

function compileTs(file) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(path.resolve(file));
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    localRequire,
    module,
    file,
    path.dirname(file)
  );
  return module.exports;
}

const realtime = compileTs("src/voice/realtime-config.ts");
const update = realtime.buildRealtimeSessionUpdate({
  language: "ru",
  listeningLanguage: "ru",
  ttsVoiceId: "fable",
  ttsSpeed: 1.15,
}, "Пользователь любит роботов.");

assert.equal(update.type, "session.update");
assert.equal(update.session.type, "realtime");
assert.equal(update.session.model, "gpt-realtime-2.1-mini");
assert.deepEqual(update.session.reasoning, { effort: "low" });
assert.deepEqual(update.session.output_modalities, ["audio"]);
assert.equal(update.session.audio.input.format.type, "audio/pcm");
assert.equal(update.session.audio.input.format.rate, 24000);
assert.equal(update.session.audio.output.format.type, "audio/pcm");
assert.equal(update.session.audio.output.format.rate, 24000);
assert.equal(update.session.audio.output.voice, "cedar", "unsupported Classic voice should fall back safely");
assert.equal(update.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
assert.equal(update.session.audio.input.transcription.language, "ru");
assert.ok(update.session.audio.input.transcription.prompt.includes("Russian"));
assert.ok(update.session.audio.input.transcription.prompt.includes("Макс"));
assert.ok(update.session.audio.input.transcription.prompt.includes("Max"));
assert.equal(update.session.audio.input.turn_detection.type, "server_vad");
assert.equal(update.session.audio.input.turn_detection.create_response, true);
assert.equal(update.session.audio.input.turn_detection.interrupt_response, true);
assert.ok(update.session.instructions.includes("default language for normal replies: Russian"));
assert.ok(update.session.instructions.includes("expected input/listening language is Russian"));
assert.ok(update.session.instructions.includes("Realtime does not control physical movement"));
assert.ok(update.session.instructions.includes("accepted nickname"));
assert.ok(update.session.instructions.includes("Пользователь любит роботов."));

const toolNames = update.session.tools.map((tool) => tool.name).sort();
assert.deepEqual(toolNames, ["remember", "search_memory", "set_language_preferences"]);
assert.equal(toolNames.some((name) => /move|drive|turn|sleep|robot/i.test(name)), false, "Realtime must expose no physical robot tools");

const source = Array.from({ length: 1600 }, (_, i) => Math.sin(i / 20) * 0.4);
const resampled = realtime.resample16kTo24k(source);
assert.equal(resampled.length, 2400, "16k -> 24k resampling must preserve duration");
const pcm = realtime.floatSamplesToPcm16Bytes(resampled);
assert.equal(pcm.length, 4800);
assert.ok(realtime.pcm16ToWavDataUri(pcm).startsWith("data:audio/wav;base64,"));

const serviceSource = fs.readFileSync("src/voice/realtime-conversation.ts", "utf8");
assert.ok(serviceSource.includes("direct-openai-webrtc"));
assert.ok(serviceSource.includes("RTCPeerConnection"));
assert.ok(serviceSource.includes("mediaDevices.getUserMedia"));
assert.ok(serviceSource.includes('createDataChannel("oai-events")'));
assert.ok(serviceSource.includes("createOpenAiRealtimeClientSecret"));
assert.ok(serviceSource.includes("exchangeOpenAiRealtimeSdp"));
assert.ok(serviceSource.includes('type: "input_audio_buffer.append"'), "wake-command preroll may be seeded once over the data channel");
assert.ok(serviceSource.includes('inputMuted: false'), "WebRTC microphone must stay live while model audio plays");
assert.ok(serviceSource.includes('voice-barge-in'), "speech interruption must be observable");
assert.ok(serviceSource.includes('type: "response.cancel"'), "tap interruption must cancel the active Realtime response");
assert.ok(serviceSource.includes('type: "output_audio_buffer.clear"'), "tap interruption must clear unplayed WebRTC output");
assert.ok(serviceSource.includes('localMemoryDatabase.search'));
assert.ok(serviceSource.includes('localMemoryDatabase.remember'));
assert.ok(serviceSource.includes('foreground-audio-gate-recovered'));
assert.ok(serviceSource.includes('classic-capture-released'));
assert.ok(serviceSource.includes('classic-capture-restored'));
assert.equal(serviceSource.includes("RealtimePcmPlayer"), false, "active WebRTC path must not use the old chunked WAV player");
assert.equal(serviceSource.includes("createOpenAiRealtimeWebSocket("), false, "active WebRTC path must not use the old direct WebSocket helper");
assert.equal(serviceSource.includes("/api/realtime/ws"), false, "Realtime client must not use an application proxy");
assert.equal(serviceSource.includes("sessionService"), false, "Realtime session history must be local-only");

const keySource = fs.readFileSync("src/openai/openai-api-key.ts", "utf8");
assert.ok(keySource.includes("SecureStore.setItemAsync"));
assert.ok(keySource.includes("SecureStore.getItemAsync"));
assert.ok(keySource.includes("/v1/realtime/client_secrets"));
assert.ok(keySource.includes("/v1/realtime/calls"));
assert.ok(keySource.includes("Authorization: `Bearer ${key}`"));
assert.ok(keySource.includes("Authorization: `Bearer ${secret}`"));

const storeSource = fs.readFileSync("src/store/user.ts", "utf8");
assert.ok(storeSource.includes('conversationMode: "realtime_pcm"'), "accepted PCM must be the default mode");
assert.ok(storeSource.includes('export type ConversationMode = "realtime" | "realtime_pcm"'), "current mode type must exclude retired Classic");
assert.ok(storeSource.includes('return mode === "realtime" ? "realtime" : "realtime_pcm"'), "unknown/older persisted mode values must normalize to PCM");

const explicit = compileTs("src/voice/explicit-robot-command.ts");
assert.deepEqual(explicit.parseExplicitRobotCommand("Макс, вперед"), { kind: "move", direction: "forward" });
assert.deepEqual(explicit.parseExplicitRobotCommand("Max, dance"), { kind: "dance" });
assert.equal(explicit.parseExplicitRobotCommand("Давай, Макс, вперед"), null, "address must remain utterance-initial");

const wake = compileTs("src/voice/wake-phrases.ts");
assert.deepEqual(wake.matchWakePhrase("Макс, направо", "ru"), {
  id: "ru", displayText: "Луи", commandSuffix: "направо", hasCommandSuffix: true,
});
assert.deepEqual(wake.matchWakePhrase("Max, dance", "en"), {
  id: "en", displayText: "LOOI", commandSuffix: "dance", hasCommandSuffix: true,
});

console.log("Realtime mode + Max alias behavior: PASS");
