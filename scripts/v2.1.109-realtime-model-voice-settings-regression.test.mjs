import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  module._compile(output, filename);
};

function compileTs(file) {
  const source = readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, require, module, file, path.dirname(file)
  );
  return module.exports;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const app = JSON.parse(readFileSync("app.json", "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
assert.equal(major, 2);
assert.equal(minor, 1);
assert.ok(patch >= 109, "v2.1.109 model/voice behavior must remain protected in later releases");
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 109);

const models = compileTs("src/openai/realtime-models.ts");
assert.equal(models.DEFAULT_REALTIME_MODEL_ID, "gpt-realtime-2.1-mini");
assert.equal(models.estimateRealtimeConversationCost("gpt-realtime-2.1-mini").usdPerMinute, 0.015);
assert.equal(models.estimateRealtimeConversationCost("gpt-realtime-2.1").usdPerMinute, 0.048);
assert.equal(models.estimateRealtimeConversationCost("gpt-realtime-1.5").usdPerMinute, 0.048);
assert.equal(models.estimateRealtimeConversationCost("gpt-realtime-2").usdPerMinute, 0.048);
assert.equal(models.estimateRealtimeConversationCost("gpt-realtime").usdPerMinute, 0.048);
assert.equal(models.estimateRealtimeConversationCost("gpt-realtime-3"), null, "unknown future pricing must never be guessed");
assert.equal(models.formatConversationCostPerMinute("gpt-realtime-2.1-mini"), "≈ $0.02/мин разговора");
assert.equal(models.formatConversationCostPerMinute("gpt-realtime-2.1"), "≈ $0.05/мин разговора");
const deduped = models.preferRealtimeModelAliases([
  { id: "gpt-realtime-2.1", created: null, ownedBy: null },
  { id: "gpt-realtime-2.1-2026-08-01", created: null, ownedBy: null },
  { id: "gpt-realtime-1.5-2026-01-01", created: null, ownedBy: null },
]);
assert.deepEqual(deduped.map((model) => model.id), ["gpt-realtime-2.1", "gpt-realtime-1.5-2026-01-01"]);

const store = readFileSync("src/store/user.ts", "utf8");
assert.match(store, /realtimeModelId: string/);
assert.match(store, /version: 1 \| 2 \| 3 \| 4 \| 5/);
assert.match(store, /realtimeModelId: DEFAULT_REALTIME_MODEL_ID/);
assert.match(store, /isSupportedRealtimeVoiceId/);

const keySource = readFileSync("src/openai/openai-api-key.ts", "utf8");
assert.match(keySource, /https:\/\/api\.openai\.com\/v1\/models/);
assert.match(keySource, /listOpenAiRealtimeModels/);
assert.match(keySource, /Authorization: `Bearer \$\{key\}`/);
assert.match(keySource, /isRealtimeConversationModelId/);

const preview = readFileSync("src/openai/openai-voice-preview.ts", "utf8");
assert.match(preview, /https:\/\/api\.openai\.com\/v1\/audio\/speech/);
assert.match(preview, /gpt-4o-mini-tts/);
assert.match(preview, /response_format: "wav"/);
assert.match(preview, /voice: voiceId/);
assert.match(preview, /createAudioPlayer/);

const voices = readFileSync("src/voice/tts-voices.ts", "utf8");
for (const voice of ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]) {
  assert.match(voices, new RegExp(`\\b${voice}\\b`));
}
const realtimeVoiceIdsBlock = voices.match(/REALTIME_VOICE_IDS = \[([\s\S]*?)\] as const/)?.[1] ?? "";
for (const unsupported of ["fable", "nova", "onyx"]) assert.doesNotMatch(realtimeVoiceIdsBlock, new RegExp(`\\b${unsupported}\\b`));

const settings = readFileSync("app/(tabs)/settings.tsx", "utf8");
const uiStrings = readFileSync("src/i18n/ui-strings.ts", "utf8");
assert.match(settings, /listOpenAiRealtimeModels/);
assert.match(settings, /formatConversationCostPerMinute/);
assert.match(settings, /t\("settings\.refreshModels"\)/);
assert.match(settings, /t\("settings\.modelsHelp"\)/);
assert.match(settings, /t\("common\.preview"\)/);
assert.match(uiStrings, /"settings\.refreshModels": "Refresh models"/);
assert.match(uiStrings, /30 секунд говорит человек и 30 секунд LOOI|30 сек говорит человек и 30 сек LOOI/);
assert.match(settings, /playOpenAiRealtimeVoicePreview/);
assert.match(settings, /setWakewordFeedingEnabled\(false\)/);
assert.match(settings, /updatePreferences\(\{ realtimeModelId: model\.id \}\)/);
assert.match(settings, /updatePreferences\(\{ ttsVoiceId: voice\.id \}\)/);

for (const file of ["src/voice/realtime-pcm-conversation.ts", "src/voice/realtime-conversation.ts"]) {
  const source = readFileSync(file, "utf8");
  assert.match(source, /preferences\.realtimeModelId/);
  assert.match(source, /this\.sessionModel/);
}
const config = readFileSync("src/voice/realtime-config.ts", "utf8");
assert.match(config, /model = normalizeRealtimeModelId\(preferences\.realtimeModelId\)/);
assert.match(config, /supportsRealtimeReasoning\(model\)/, "accepted 2.x reasoning behavior must remain guarded for older models");

console.log("v2.1.109 Realtime model/voice settings regression: PASS");
