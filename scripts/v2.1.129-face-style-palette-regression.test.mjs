import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 129);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 129);

const user = read("src/store/user.ts");
assert.match(user, /FaceStyleId = "classic" \| "soft" \| "playful" \| "fringe" \| "sharp"/);
assert.match(user, /FacePaletteId = "cyan" \| "rose" \| "lime" \| "amber" \| "violet"/);
assert.match(user, /faceStyle: FaceStyleId/);
assert.match(user, /facePalette: FacePaletteId/);
const storedVersion = Number(user.match(/stored\.version !== (\d+)/)?.[1]);
const savedVersion = Number(user.match(/version: (\d+), preferences/)?.[1]);
assert.ok(storedVersion >= 11);
assert.ok(savedVersion >= 11);
assert.match(user, /normalizeFaceStyleId[\s\S]*legacySkin/);
assert.match(user, /normalizeFacePaletteId[\s\S]*legacySkin/);

const face = read("src/ui/RobotFace.tsx");
assert.match(face, /const FACE_STYLES: Record<FaceStyleId, FaceStyleVisual>/);
assert.match(face, /const FACE_PALETTES: Record<FacePaletteId, FacePaletteVisual>/);
for (const id of ["classic", "soft", "playful", "fringe", "sharp"]) assert.match(face, new RegExp(`\\n  ${id}: \\{`));
for (const id of ["cyan", "rose", "lime", "amber", "violet"]) assert.match(face, new RegExp(`\\n  ${id}: \\{`));
assert.doesNotMatch(face, /styles\.skinGlow|styles\.avatarSkinGlow/, "full-face oval/glow must stay removed");
assert.doesNotMatch(face, /width:\s*380[\s\S]{0,80}height:\s*230[\s\S]{0,80}borderRadius:\s*999/, "old oval face silhouette must not return");
assert.match(face, /decor: "fringe"/);
assert.match(face, /decor: "lashes"/);
assert.match(face, /decor: "brows"/);
assert.match(face, /idleMouth: "dot"/);
assert.match(face, /palette\.eyeColor/);
assert.match(face, /palette\.mouthColor/);

const settings = read("app/(tabs)/settings.tsx");
assert.match(settings, /FACE_STYLE_OPTIONS: FaceStyleId\[\]/);
assert.match(settings, /FACE_PALETTE_OPTIONS: FacePaletteId\[\]/);
assert.match(settings, /updatePreferences\(\{ faceStyle: style \}\)/);
assert.match(settings, /updatePreferences\(\{ facePalette: palette \}\)/);
assert.match(settings, /PaletteChoice/);

const strings = read("src/i18n/ui-strings.ts");
for (const key of ["settings.faceAppearanceSelected", "settings.faceStyle.fringe", "settings.faceStyle.playful", "settings.facePalette.cyan", "settings.facePalette.violet"]) {
  assert.equal((strings.match(new RegExp(`"${key.replaceAll(".", "\\.")}":`, "g")) ?? []).length, 3, `${key} must exist in all UI languages`);
}

// Appearance remains presentation-only; do not alter accepted PCM/movement safety paths.
const pcm = read("src/voice/realtime-pcm-conversation.ts");
const robot = read("src/device-tools/looi-robot.ts");
assert.ok(pcm.includes("VOICE_COMMUNICATION") || read("modules/realtime-pcm-audio/android/src/main/java/com/superlooi/realtimepcmaudio/RealtimePcmAudioModule.kt").includes("VOICE_COMMUNICATION"));
assert.match(robot, /ambientMotion: true/);

console.log("v2.1.129 independent face style + palette regression: PASS");
