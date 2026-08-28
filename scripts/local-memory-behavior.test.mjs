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

const search = compileTs("src/memory/local-memory-search.ts");
assert.equal(search.normalizeMemorySearchText("  Мою дочку зовут Алеся!  "), "мою дочку зовут алеся");
assert.equal(search.normalizeMemorySearchText("Max's robot"), "max s robot");
assert.equal(search.buildMemoryFtsQuery("Как зовут мою дочку?"), '"зовут"* OR "дочку"*');
assert.equal(search.buildMemoryFtsQuery("Какое у меня любимое блюдо?"), '"любимое"* OR "блюдо"*');
assert.equal(search.buildMemoryFtsQuery("! ?"), null);

const dbSource = fs.readFileSync("src/memory/local-memory-database.ts", "utf8");
assert.ok(dbSource.includes('const DATABASE_NAME = "looi-memory-v2.db"'));
assert.ok(dbSource.includes("PRAGMA journal_mode = WAL"));
assert.ok(dbSource.includes("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5"));
assert.ok(dbSource.includes("CREATE TABLE IF NOT EXISTS conversation_sessions"));
assert.ok(dbSource.includes("CREATE TABLE IF NOT EXISTS conversation_messages"));
assert.ok(dbSource.includes("CREATE TABLE IF NOT EXISTS profile_state"));
assert.ok(dbSource.includes('sync_state TEXT NOT NULL DEFAULT \'local-only\''));
assert.ok(dbSource.includes('format: "super-looi-local-memory"'), "Drive-ready backup snapshot contract must exist");

const routerSource = fs.readFileSync("src/memory/memory-service.ts", "utf8");
assert.ok(routerSource.includes("localMemoryDatabase.remember"), "local memory must write SQLite");
assert.ok(routerSource.includes('backend: "local"'));
assert.ok(routerSource.includes("mirrorSessionMessage"));
assert.equal(routerSource.includes("serverMemoryService"), false, "memory service must not contact a remote memory backend");
assert.equal(routerSource.includes("shadowRememberToServer"), false, "server shadow writes are retired");
assert.equal(routerSource.includes("migrateServerMemoryToLocal"), false, "remote migration switch must remain absent");

const storeSource = fs.readFileSync("src/store/user.ts", "utf8");
assert.ok(storeSource.includes('conversationMode: "realtime_pcm"'), "fresh install must default to accepted PCM");
assert.equal(storeSource.includes('export type MemoryBackend = "server" | "local"'), false);
assert.ok(storeSource.includes('Object.prototype.hasOwnProperty.call(preferences, "memoryBackend")'), "old backend preference must be removed on upgrade");

const conversationStoreSource = fs.readFileSync("src/store/conversation.ts", "utf8");
assert.equal(conversationStoreSource.includes("sessionService"), false, "conversation store must not persist to a remote session backend");
assert.ok(conversationStoreSource.includes("mirrorSessionMessage"));

const realtimeSource = fs.readFileSync("src/voice/realtime-conversation.ts", "utf8");
assert.ok(realtimeSource.includes('mirrorSessionTouch(localSessionId, "realtime")'));
assert.ok(realtimeSource.includes('mirrorSessionMessage(this.sessionId, { role: "user", content: transcript })'));

const settingsSource = fs.readFileSync("app/(tabs)/settings.tsx", "utf8");
assert.equal(settingsSource.includes("Скопировать server memory → Local SQLite"), false);
assert.equal(settingsSource.includes("Вернуться на Server legacy"), false);
assert.ok(settingsSource.includes('t("settings.localFirst")'));
const uiStringsSource = fs.readFileSync("src/i18n/ui-strings.ts", "utf8");
assert.ok(uiStringsSource.includes('"settings.localFirst": "local-first"'));


console.log("Local memory 2.x behavior: PASS");
