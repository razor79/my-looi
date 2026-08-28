import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const app = JSON.parse(fs.readFileSync("app.json", "utf8"));
const layout = fs.readFileSync("app/_layout.tsx", "utf8");

assert.equal(app.expo.version, pkg.version);
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 117, "v2.1.117 font regression must remain active in later releases");
assert.ok(app.expo.android.versionCode >= 117);

// v2.1.116 accidentally removed the useFonts declaration and bundled font while
// leaving the old `if (!loaded)` gate, causing TS2304. Restore the accepted
// v2.1.115 font/splash lifecycle instead of weakening the gate.
assert.match(layout, /import \{ useFonts \} from ['"]expo-font['"]/);
assert.match(layout, /const \[loaded, error\] = useFonts\(/);
assert.match(layout, /SpaceMono-Regular\.ttf/);
assert.match(layout, /if \(!loaded\)/);
assert.ok(fs.existsSync("assets/fonts/SpaceMono-Regular.ttf"), "SpaceMono font asset must exist");

console.log("v2.1.117 root-layout TypeScript/font regression: PASS");
