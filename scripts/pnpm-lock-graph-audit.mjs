import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = readFileSync("pnpm-lock.yaml", "utf8");

function unquoteKey(raw) {
  const key = raw.trim();
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1).replaceAll("''", "'");
  if (key.startsWith('"') && key.endsWith('"')) return JSON.parse(key);
  return key;
}

function collectSectionKeys(sectionName) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${sectionName}:`);
  assert.notEqual(start, -1, `pnpm-lock.yaml is missing ${sectionName}:`);

  const keys = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) break;
    if (!line.startsWith("  ") || line.startsWith("    ")) continue;

    const raw = line.slice(2);
    if (raw.startsWith("? ")) {
      keys.push(unquoteKey(raw.slice(2)));
      continue;
    }
    if (raw.startsWith(": ")) continue;
    const colon = raw.indexOf(":");
    if (colon <= 0) continue;
    keys.push(unquoteKey(raw.slice(0, colon)));
  }
  return keys;
}

const packageKeys = collectSectionKeys("packages");
const snapshotKeys = collectSectionKeys("snapshots");
const packageSet = new Set(packageKeys);
const packageKeysByLength = [...packageKeys].sort((a, b) => b.length - a.length);

const missing = snapshotKeys.filter((snapshotKey) => {
  if (packageSet.has(snapshotKey)) return false;
  return !packageKeysByLength.some((packageKey) => snapshotKey.startsWith(`${packageKey}(`));
});

assert.equal(
  missing.length,
  0,
  `pnpm-lock.yaml has ${missing.length} snapshot(s) without package metadata. First missing entries: ${missing.slice(0, 12).join(", ")}`,
);

console.log(`pnpm lock graph audit: PASS (${packageKeys.length} packages, ${snapshotKeys.length} snapshots)`);
