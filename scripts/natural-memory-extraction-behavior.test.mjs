import assert from "node:assert/strict";
import fs from "node:fs";

const memoryService = fs.readFileSync("src/memory/memory-service.ts", "utf8");
const localDb = fs.readFileSync("src/memory/local-memory-database.ts", "utf8");
const pcm = fs.readFileSync("src/voice/realtime-pcm-conversation.ts", "utf8");

assert.equal(memoryService.includes("serverMemoryService"), false);
assert.equal(memoryService.includes("scheduleNaturalMemoryExtraction"), false);
assert.equal(localDb.includes("importServerMemories"), false);
assert.equal(localDb.includes("syncServerMemoriesSnapshot"), false);
assert.ok(memoryService.includes("localMemoryDatabase.remember"));
assert.ok(memoryService.includes("localMemoryDatabase.search"));
assert.ok(pcm.includes('name === "remember"'));
assert.ok(pcm.includes('name === "search_memory"'));

const combined = `${memoryService}\n${localDb}`.toLowerCase();
for (const forbidden of ["favorite_color", "favorite_food", "любимый цвет", "любимое блюдо", "как меня зовут"]) {
  assert.equal(combined.includes(forbidden), false, `domain-specific extraction rule leaked in: ${forbidden}`);
}

console.log("Local-only durable memory behavior: PASS");
