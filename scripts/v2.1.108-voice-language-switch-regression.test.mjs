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
  const localRequire = createRequire(path.resolve(file));
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports, localRequire, module, file, path.dirname(file)
  );
  return module.exports;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const app = JSON.parse(readFileSync("app.json", "utf8"));
assert.ok(pkg.version >= "2.1.108");
assert.ok(app.expo.version >= "2.1.108");
assert.ok(app.expo.android.versionCode >= 108);

const realtime = compileTs("src/voice/realtime-config.ts");
const update = realtime.buildRealtimeSessionUpdate({
  language: "ru",
  listeningLanguage: "ru",
  ttsVoiceId: "cedar",
  ttsSpeed: 1,
});
const tools = new Map(update.session.tools.map((tool) => [tool.name, tool]));
assert.equal(tools.has("set_language_preferences"), true);
const languageTool = tools.get("set_language_preferences");
assert.deepEqual(languageTool.parameters.properties.response_language.enum, ["ru", "uk", "en"]);
assert.deepEqual(languageTool.parameters.properties.listening_language.enum, ["ru", "uk", "en"]);
assert.deepEqual(languageTool.parameters.required, ["response_language"]);
assert.match(languageTool.description, /Never use this for a one-off translation/i);

const instructions = update.session.instructions;
assert.match(instructions, /default language for normal replies: Russian/);
assert.match(instructions, /Language-learning requests are an explicit exception/);
assert.match(instructions, /translation, pronunciation, correction, comparison, example/);
assert.match(instructions, /MUST call set_language_preferences/);
assert.match(instructions, /set both response_language and listening_language/);
assert.match(instructions, /Never call set_language_preferences for a one-off translation/);
assert.doesNotMatch(instructions, /always reply in Russian/);

for (const file of ["src/voice/realtime-pcm-conversation.ts", "src/voice/realtime-conversation.ts"]) {
  const source = readFileSync(file, "utf8");
  assert.match(source, /name === "set_language_preferences"/);
  assert.match(source, /updatePreferences\(\{[\s\S]*language: responseLanguage/);
  assert.match(source, /listeningLanguage: requestedListeningLanguage/);
  assert.match(source, /applySessionPreferences\("realtime-language-tool"\)/);
  assert.match(source, /source: "realtime-tool"/);
  assert.match(source, /next_reply_language:/);
  assert.match(source, /Acknowledge the change and continue in next_reply_language/);
  assert.match(source, /persistent: true/);
}

const home = readFileSync("app/(tabs)/index.tsx", "utf8");
assert.match(home, /useUserStore\(\(state\) => state\.preferences\.language\)/);
assert.match(home, /useUserStore\(\(state\) => state\.preferences\.listeningLanguage\)/);

console.log("v2.1.108 voice language switching regression: PASS");
