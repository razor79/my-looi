import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const audit = path.join(root, "scripts", "public-apk-audit.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "my-looi-apk-audit-"));

function makeZip(name, files) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const apk = path.join(tmp, `${name}.apk`);
  const zipped = spawnSync("zip", ["-qr", apk, "."], { cwd: dir, encoding: "utf8" });
  assert.equal(zipped.status, 0, zipped.stderr || zipped.stdout);
  return apk;
}

try {
  const thirdPartyOnly = makeZip("third-party-only", {
    "assets/app-name.txt": "My LOOI\n",
    "assets/vosk-command-en/graph/words.txt": ["decom", "pile 95566\n", "decom", "piled 95564\n", "decom", "piler 95565\n", "reverse", "-engineering 142286\n"].join(""),
    "assets/vosk-command-en/graph/Gr.fst": ["JA", "dxWAn ", "reverse", "-engineering ", "decom", "pileNu\n"].join(""),
  });
  let run = spawnSync("bash", [audit, thirdPartyOnly], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /APK publication audit: PASS/);

  const firstPartyLeak = makeZip("first-party-leak", {
    "assets/app-name.txt": "My LOOI\n",
    "assets/private-note.txt": ["reverse", " engineering notes\n"].join(""),
  });
  run = spawnSync("bash", [audit, firstPartyLeak], { encoding: "utf8" });
  assert.notEqual(run.status, 0, "first-party provenance marker must still fail");
  assert.match(`${run.stdout}\n${run.stderr}`, /private\/research provenance marker found/);

  console.log("v2.1.122 Vosk APK provenance allowlist regression: PASS");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
