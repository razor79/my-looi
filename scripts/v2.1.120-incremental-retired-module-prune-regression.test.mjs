import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
const helper = fs.readFileSync("scripts/build-my-looi.sh", "utf8");

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 120, "v2.1.120 prune regression must remain active in later releases");
assert.equal(app.expo.version, pkg.version);
assert.ok(Number(app.expo.android.versionCode) >= 120);
assert.match(helper, /prune_removed_source_modules/);
assert.match(helper, /Removing retired source module/);
assert.match(helper, /rm -rf -- "\$target_module"/);
assert.match(helper, /prune_removed_source_modules "\$snapshot" "\$target"/);

// Reproduce the v2.1.119 failure mode: the previous worktree contains a module
// that is gone from the new source, but its excluded Android build cache would
// normally be protected by rsync --delete. The helper must remove the entire
// retired source-owned module before the rsync refresh.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "looi-retired-module-"));
try {
  const snapshot = path.join(root, "snapshot");
  const target = path.join(root, "target");
  fs.mkdirSync(path.join(snapshot, "modules", "kept-module", "android"), { recursive: true });
  fs.writeFileSync(path.join(snapshot, "modules", "kept-module", "package.json"), "{}\n");
  fs.mkdirSync(path.join(target, "modules", "kept-module", "android", "build"), { recursive: true });
  fs.writeFileSync(path.join(target, "modules", "kept-module", "android", "build", "cache.bin"), "cache\n");
  fs.mkdirSync(path.join(target, "modules", "retired-module", "android", "build"), { recursive: true });
  fs.writeFileSync(path.join(target, "modules", "retired-module", "package.json"), "{}\n");
  fs.writeFileSync(path.join(target, "modules", "retired-module", "android", "build", "cache.bin"), "stale\n");

  const functionText = helper.match(/prune_removed_source_modules\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionText, "helper prune function must be extractable for behavior test");
  const run = spawnSync("bash", ["-c", `${functionText}\nprune_removed_source_modules "$1" "$2"`, "bash", snapshot, target], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(fs.existsSync(path.join(target, "modules", "retired-module")), false);
  assert.equal(fs.existsSync(path.join(target, "modules", "kept-module", "android", "build", "cache.bin")), true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("v2.1.120 incremental retired-module prune regression: PASS");
