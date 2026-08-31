import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 131);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 131);

const kotlin = read("modules/local-face-attention/android/src/main/java/com/superlooi/localfaceattention/LocalFaceAttentionModule.kt");
assert.match(kotlin, /AsyncFunction\("start"\) Coroutine ::startCamera/);
assert.match(kotlin, /AsyncFunction\("stop"\) Coroutine ::stopCameraAndStatus/);
assert.match(kotlin, /AsyncFunction\("getStatus"\) Coroutine ::status/);
assert.match(kotlin, /private fun stopCameraAndStatus\(\): Map<String, Any\?>/);
assert.doesNotMatch(kotlin, /AsyncFunction\("(?:start|stop|getStatus)"\) Coroutine \{/);

console.log("v2.1.131 local face-attention Kotlin build regression: PASS");
