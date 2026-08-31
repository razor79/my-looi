import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 134);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 134);

const realtime = read("src/voice/realtime-config.ts");
const threshold = Number(realtime.match(/type: "server_vad"[\s\S]*?threshold: (0\.\d+),/)?.[1]);
assert.ok(Number.isFinite(threshold) && threshold <= 0.15, "far-field VAD threshold must not regress above the v2.1.134 value");
assert.match(realtime, /type: "server_vad"[\s\S]*prefix_padding_ms: 500,[\s\S]*silence_duration_ms: 1000,/);
assert.doesNotMatch(realtime, /threshold: 0\.20,/);
assert.match(realtime, /noise_reduction: \{ type: "far_field" \}/);
assert.match(realtime, /REALTIME_SOURCE_PCM_RATE = 16_000/);
assert.match(realtime, /REALTIME_PCM_RATE = 24_000/);
assert.match(realtime, /“Спасибо, Луи”/);
assert.match(realtime, /“Луи, как дела\?”/);
assert.match(realtime, /“Привет, Бобик”/);
assert.match(realtime, /“Макс, ты меня слышишь\?”/);
assert.match(realtime, /Never address the human as Луи, LOOI, Луї, Бобик, Макс, Max, Робот, Robot/);
assert.match(realtime, /Never invent a human personal name from an address token/);
assert.match(realtime, /Use a personal name for the human only when that human name is explicitly and reliably known/);
assert.match(realtime, /vocative robot addresses, not evidence of the human user's name/);

const social = read("src/core/social-attention.ts");
assert.match(social, /BODY_POST_MOTION_SETTLE_MS = 1_300/);
assert.match(social, /SEARCH_REARM_LOST_MS = 4_500/);
assert.doesNotMatch(social, /moveLooi\("forward"|moveLooi\("back/);

console.log("v2.1.134 far-field VAD + robot/human identity regression: PASS");
