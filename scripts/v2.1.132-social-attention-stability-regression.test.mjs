import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 132);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 132);

const attention = read("src/core/social-attention.ts");
assert.match(attention, /nativeStartPromise: Promise<void> \| null/);
assert.match(attention, /nativeLifecycleGeneration/);
assert.match(attention, /if \(nativeStartPromise\)/);
assert.match(attention, /generation !== nativeLifecycleGeneration/);
assert.match(attention, /FACE_SMOOTHING_ALPHA/);
const bodyStableFrames = Number(attention.match(/BODY_STABLE_FRAMES = (\d+)/)?.[1]);
const bodyCooldownMs = Number(attention.match(/BODY_CORRECTION_COOLDOWN_MS = ([\d_]+)/)?.[1].replaceAll("_", ""));
const headStableFrames = Number(attention.match(/HEAD_STABLE_FRAMES = (\d+)/)?.[1]);
assert.ok(bodyStableFrames >= 3);
assert.ok(bodyCooldownMs >= 1_800);
assert.ok(headStableFrames >= 3);
assert.match(attention, /HEAD_UP_RELEASE/);
assert.match(attention, /HEAD_DOWN_RELEASE/);
assert.match(attention, /headCommandInFlight/);
assert.match(attention, /const correctionAllowed = motionCorrectionAllowed\(\)/);
assert.doesNotMatch(attention, /desired !== "center" && now - lastHeadCommandAt/);
assert.match(attention, /SEARCH_SEQUENCE/);
assert.match(attention, /direction: "left"/);
assert.match(attention, /direction: "right"/);
assert.doesNotMatch(attention, /"left", "left", "right", "right", "right", "right", "left", "left"/);
assert.doesNotMatch(attention, /startLooiMotion\(|moveLooi\("forward"|moveLooi\("back/);

const kotlin = read("modules/local-face-attention/android/src/main/java/com/superlooi/localfaceattention/LocalFaceAttentionModule.kt");
assert.match(kotlin, /CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES/);
assert.match(kotlin, /it\.lower == 15 && it\.upper == 15/);
assert.match(kotlin, /CONTROL_AE_TARGET_FPS_RANGE/);
assert.match(kotlin, /private var detector: FaceDetector\? = null/);
assert.match(kotlin, /pendingDetectorClose/);
assert.match(kotlin, /detectorToClose\.close\(\)/);
assert.match(kotlin, /thread\?\.quitSafely\(\)/);
assert.match(kotlin, /MIN_ANALYSIS_INTERVAL_MS = 140L/);
assert.doesNotMatch(kotlin, /detectorDelegate/);
assert.doesNotMatch(kotlin, /FileOutputStream|BitmapFactory|compress\(|writeBytes|openConnection|HttpURLConnection|OkHttp|Retrofit/);

console.log("v2.1.132 social-attention stability regression: PASS");
