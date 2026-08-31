import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 133);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 133);

const attention = read("src/core/social-attention.ts");
assert.match(attention, /CAMERA_WARMUP_ONLY_SOURCE = "realtime-pcm-speech-start"/);
assert.match(attention, /motionArmed/);
assert.match(attention, /conversationMotionConfirmed/);
assert.match(attention, /return useConversationStore\.getState\(\)\.isSpeaking/);
assert.match(attention, /BODY_POST_MOTION_SETTLE_MS = 1_300/);
assert.match(attention, /BODY_CORRECTION_COOLDOWN_MS = 2_200/);
assert.match(attention, /BODY_STABLE_FRAMES = 4/);
assert.match(attention, /HEAD_STABLE_FRAMES = 4/);
assert.match(attention, /lastSocialBodyMotionAt/);
assert.match(attention, /bodySettleUntil/);
assert.match(attention, /smoothedFace = null/);
assert.match(attention, /SEARCH_REARM_LOST_MS = 4_500/);
assert.match(attention, /searchRearmUsed/);
assert.match(attention, /faceSeenSinceSearch/);
assert.match(attention, /SEARCH_SEQUENCE[^]*direction: "left", durationMs: 100[^]*direction: "right", durationMs: 180/);
assert.doesNotMatch(attention, /direction: "left", durationMs: 90/);
assert.match(attention, /performSocialBodyPivot\("search"/);
assert.match(attention, /performSocialBodyPivot\("recenter"/);
assert.match(attention, /social-attention-pivot/);
assert.match(attention, /reason,\s*direction,\s*durationMs,\s*rawX:/);
assert.match(attention, /smoothedX:/);
assert.match(attention, /stableFrames/);
assert.match(attention, /faceAgeMs/);
assert.match(attention, /getAmbientMotionControllerState\(\)\.actionInFlight/);
assert.match(attention, /holdAmbientMotionFor\(/);
assert.doesNotMatch(attention, /startLooiMotion\(|moveLooi\("forward"|moveLooi\("back/);

const ambient = read("src/core/ambient-motion.ts");
assert.match(ambient, /coordinationHoldUntil/);
assert.match(ambient, /holdAmbientMotionFor/);
assert.match(ambient, /coordination-hold/);
assert.doesNotMatch(ambient, /faceVisible|social-attention|SocialAttention/,
  "ambient coordination must remain generic and must not globally depend on camera-attention state");

console.log("v2.1.133 social-attention coordination regression: PASS");
