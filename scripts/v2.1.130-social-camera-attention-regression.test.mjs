import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 130);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 130);

const user = read("src/store/user.ts");
assert.match(user, /cameraAttentionEnabled: boolean/);
assert.match(user, /cameraAttentionEnabled: false/);
assert.match(user, /cameraAttentionEnabled: .*=== true/);
assert.match(user, /Do not migrate the retired experimental `cameraEnabled` flag/);
assert.match(user, /stored\.version !== 12/);
assert.match(user, /version: 12, preferences/);

const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /PermissionsAndroid\.PERMISSIONS\.CAMERA/);
assert.match(settings, /updatePreferences\(\{ cameraAttentionEnabled: true \}\)/);
assert.match(settings, /updatePreferences\(\{ cameraAttentionEnabled: false \}\)/);
assert.match(settings, /settings\.cameraAttentionHelp/);

const moduleBuild = read("modules/local-face-attention/android/build.gradle");
const moduleKotlin = read("modules/local-face-attention/android/src/main/java/com/superlooi/localfaceattention/LocalFaceAttentionModule.kt");
const moduleManifest = read("modules/local-face-attention/android/src/main/AndroidManifest.xml");
assert.match(moduleBuild, /com\.google\.mlkit:face-detection:16\.1\.7/);
assert.doesNotMatch(moduleBuild, /play-services-mlkit-face-detection/);
assert.match(moduleManifest, /android\.permission\.CAMERA/);
assert.match(moduleKotlin, /ImageFormat\.YUV_420_888/);
assert.match(moduleKotlin, /InputImage\.fromMediaImage/);
assert.match(moduleKotlin, /PERFORMANCE_MODE_FAST/);
assert.match(moduleKotlin, /sendEvent\("onFaceFrame"/);
assert.doesNotMatch(moduleKotlin, /FileOutputStream|BitmapFactory|compress\(|writeBytes|openConnection|HttpURLConnection|OkHttp|Retrofit/);

const attention = read("src/core/social-attention.ts");
assert.match(attention, /interactionStateActive/);
assert.match(attention, /isUserSpeaking \|\| conversation\.isProcessing \|\| conversation\.isSpeaking/);
assert.match(attention, /performLooiSocialAttentionPivot/);
assert.match(attention, /SEARCH_SEQUENCE/);
assert.match(attention, /BODY_DEAD_ZONE/);
assert.match(attention, /if \(useConversationStore\.getState\(\)\.isUserSpeaking\) return false/);
assert.match(attention, /cameraAttentionEnabled/);
assert.match(attention, /isMainScreenFocused\(\)/);
assert.doesNotMatch(attention, /startLooiMotion\(|moveLooi\("forward"|moveLooi\("back/);

const robot = read("src/device-tools/looi-robot.ts");
assert.match(robot, /performLooiSocialAttentionPivot/);
assert.match(robot, /runBoundedMotion\(direction, boundedDurationMs, "manual-bounded"/);
assert.match(robot, /socialAttentionPrimitive: "face-recenter-pivot"/);
assert.match(robot, /ambientMotion: true/);

const ambient = read("src/core/ambient-motion.ts");
assert.doesNotMatch(ambient, /faceVisible|social-attention|SocialAttention/, "camera attention must not globally suppress ambient character motion");

const face = read("src/ui/RobotFace.tsx");
assert.match(face, /useSocialAttentionStore/);
assert.match(face, /socialAttentionActive && socialFaceVisible/);
assert.match(face, /socialGazeX/);
assert.match(face, /socialGazeY/);

const bootstrap = read("src/core/app-bootstrap.ts");
assert.match(bootstrap, /startSocialAttentionController\("bootstrap"\)/);
assert.match(bootstrap, /await stopSocialAttentionController\(reason\)/);
assert.match(bootstrap, /startSocialAttentionController\("foreground-resume"\)/);

const privacy = read("PRIVACY.md");
assert.match(privacy, /Camera attention is optional and off by default/);
assert.match(privacy, /are not written to files or diagnostics/);
assert.match(privacy, /are not sent to OpenAI or any other network service/);

console.log("v2.1.130 local social camera attention regression: PASS");
