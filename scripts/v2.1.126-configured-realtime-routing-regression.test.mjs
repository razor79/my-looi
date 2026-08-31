import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const pkg = JSON.parse(read("package.json"));
const app = JSON.parse(read("app.json"));

const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(patchVersion >= 126);
assert.equal(app.expo.version, pkg.version);
assert.ok(app.expo.android.versionCode >= 126);

const helper = read("src/voice/realtime-physical-command.ts");
const explicit = read("src/voice/explicit-robot-command.ts");

// v2.1.125 intentionally passes the user's configured robot name/aliases and
// custom phrases into the same deterministic parser. The historical v2.1.111
// regression must not reject that safe extension merely because a second
// configuration argument is now present.
assert.match(helper, /containsEmergencyStopWord\(\s*transcript\s*,\s*config\s*\)/);
assert.match(helper, /parseExplicitRobotCommand\(\s*transcript\s*,\s*config\s*\)/);
assert.match(explicit, /export function parseExplicitRobotCommand\(text: string, config\?: ExplicitRobotCommandConfig\)/);

// Preserve the proven bounded local execution path; personalization must not
// grant the Realtime model autonomous movement tools or continuous drive.
assert.match(helper, /await moveLooi\(command\.direction\)/);
assert.match(helper, /await turnLooi\(command\.direction, command\.degrees\)/);
assert.match(helper, /await performLooiHeadGesture\(command\.gesture, command\.count\)/);
assert.match(helper, /await performLooiDance\("random"\)/);
assert.equal(helper.includes("startLooiMotion("), false);

console.log("v2.1.126 configured Realtime physical-command routing regression: PASS");
