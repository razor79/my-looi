import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function compileTs(file) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    require,
    module,
    file,
    path.dirname(file)
  );
  return module.exports;
}

const { matchWakePhrase } = compileTs("src/voice/wake-phrases.ts");

assert.deepEqual(matchWakePhrase("Луин, направо", "ru"), {
  id: "ru", displayText: "Луи", commandSuffix: "направо", hasCommandSuffix: true,
});
assert.deepEqual(matchWakePhrase("ЛУИН!", "ru"), {
  id: "ru", displayText: "Луи", commandSuffix: "", hasCommandSuffix: false,
});
assert.deepEqual(matchWakePhrase("Луїн, праворуч", "uk"), {
  id: "uk", displayText: "Луї", commandSuffix: "праворуч", hasCommandSuffix: true,
});

assert.deepEqual(matchWakePhrase("Макс, направо", "ru"), {
  id: "ru", displayText: "Луи", commandSuffix: "направо", hasCommandSuffix: true,
});
assert.deepEqual(matchWakePhrase("Max, dance", "en"), {
  id: "en", displayText: "LOOI", commandSuffix: "dance", hasCommandSuffix: true,
});
assert.equal(matchWakePhrase("просто направо", "ru"), null);
console.log("wake alias behavior: PASS");
