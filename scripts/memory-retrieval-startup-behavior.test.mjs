import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function compileTs(file, mocks = {}) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
    return require(specifier);
  };
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    localRequire,
    module,
    file,
    path.dirname(file)
  );
  return module.exports;
}

const address = compileTs("src/voice/conversation-address.ts");
assert.deepEqual(address.normalizeConversationTranscriptForAssistant("Макс, я Лёша."), {
  transcript: "я Лёша.",
  stripped: true,
  alias: "max",
});
assert.deepEqual(address.normalizeConversationTranscriptForAssistant("Max, what is my favorite food?"), {
  transcript: "what is my favorite food?",
  stripped: true,
  alias: "max",
});
assert.deepEqual(address.normalizeConversationTranscriptForAssistant("Луи, расскажи сказку"), {
  transcript: "расскажи сказку",
  stripped: true,
  alias: "looi",
});

const search = compileTs("src/memory/local-memory-search.ts");
assert.equal(search.normalizeMemorySearchText("  Мою дочку зовут Алеся!  "), "мою дочку зовут алеся");
assert.equal(search.buildMemoryFtsQuery("Какой у меня любимый цвет?"), '"любимый"* OR "цвет"*');
assert.equal(search.buildMemoryFtsQuery("Какое у меня любимое блюдо?"), '"любимое"* OR "блюдо"*');
assert.equal(search.buildMemoryFtsQuery("What food do I like most?"), '"food"* OR "like"* OR "most"*');
assert.equal(search.buildMemoryFtsQuery("! ?"), null);

// The query builder must stay domain-agnostic: no special bridges for name,
// relatives, food, colors, or any other individual memory question.
const searchSource = fs.readFileSync("src/memory/local-memory-search.ts", "utf8");
for (const forbidden of ["как\\s+меня\\s+зовут", "пользователь\", \"имя", "дочк|дочер", "favorite.*color"]) {
  assert.ok(!searchSource.includes(forbidden), `question-specific memory bridge leaked into FTS: ${forbidden}`);
}

const context = compileTs("src/memory/conversation-memory-context.ts", {
  "./local-memory-search": search,
});
const arbitraryFacts = [
  { id: "1", memory: "Conversation summary: Пользователь любит синий цвет." },
  { id: "2", memory: "Любимое блюдо пользователя — хачапури." },
  { id: "3", memory: "Пользователь собирается поехать в Альпы зимой." },
];
const fullContext = context.buildBoundedFullMemoryContext(arbitraryFacts);
assert.equal(fullContext.length, 3, "small memory must be supplied as bounded complete context");
assert.equal(fullContext[0].memory, "Пользователь любит синий цвет.");
assert.equal(fullContext[1].memory, "Любимое блюдо пользователя — хачапури.");
assert.equal(fullContext[2].memory, "Пользователь собирается поехать в Альпы зимой.");

const memoryServiceSource = fs.readFileSync("src/memory/memory-service.ts", "utf8");
assert.ok(memoryServiceSource.includes('mode?: "ambient" | "relevant"'));
assert.ok(memoryServiceSource.includes('strategy: "bounded-full-local"'));
assert.ok(memoryServiceSource.includes('strategy: "local-fts"'));
assert.equal(memoryServiceSource.includes("serverMemoryService"), false);
assert.ok(memoryServiceSource.includes("canUseBoundedFullMemoryContext(allLocal)"));

const voiceSource = fs.readFileSync("src/perceivers/voice-perceiver.ts", "utf8");
assert.ok(voiceSource.includes("normalizeConversationTranscriptForAssistant(transcript)"));
assert.ok(voiceSource.includes("retrieveConversationMemories(assistantTranscript"));
assert.ok(voiceSource.includes('mode: intent === "search" ? "relevant" : "ambient"'));
assert.ok(voiceSource.includes('recordDiagnosticEvent("memory", "turn-memory-retrieval"'));
assert.ok(voiceSource.includes('intent === "search" && facts.length > 0 ? "chat" : intent'));
assert.equal(voiceSource.includes('preferences.memoryBackend'), false);

const bootstrapSource = fs.readFileSync("src/core/app-bootstrap.ts", "utf8");
assert.ok(bootstrapSource.includes("conversationOwnsVoiceRuntime"));
assert.ok(bootstrapSource.includes('foreground-voice-repair-deferred'));
assert.match(
  bootstrapSource,
  /!conversationOwnsVoiceRuntime\(\)[\s\S]{0,180}!status\.running \|\| !wakewordService\.isListening \|\| !status\.pcmFlowing/
);

console.log("Generic memory retrieval + startup race behavior: PASS");
