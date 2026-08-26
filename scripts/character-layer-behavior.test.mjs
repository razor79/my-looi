import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function compileTs(file, customRequire = require, transformSource = (source) => source) {
  const source = transformSource(fs.readFileSync(file, "utf8"));
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    customRequire,
    module,
    file,
    path.dirname(file)
  );
  return module.exports;
}

const sdk = compileTs("packages/looi-sdk/src/index.ts");
const fed9 = compileTs("src/device-tools/fed9-sensors.ts");
const events = [];
const writes = [];
let notifyFed9 = null;

const customRequire = (id) => {
  if (id === "@sourcebug/looi-sdk") return sdk;
  if (id === "./fed9-sensors") return fed9;
  if (id === "../diagnostics/diagnostic-log") {
    return { recordDiagnosticEvent: (category, event, details = {}) => events.push({ category, event, details, at: Date.now() }) };
  }
  return require(id);
};

const robot = compileTs("src/device-tools/looi-robot.ts", customRequire, (source) =>
  source
    .replace("export const TURN_90_MS = 650;", "export const TURN_90_MS = 80;")
    .replace("export const TURN_180_MS = 1_560;", "export const TURN_180_MS = 160;")
);

const transport = {
  async connect() {},
  async disconnect() {},
  hasCharacteristic(key) { return key === "dockNotify" || key === "drive" || key === "head"; },
  async startNotifications(key, callback) { if (key === "dockNotify") notifyFed9 = callback; },
  async write(key, payload, options) { writes.push({ at: Date.now(), key, payload, options }); },
};

function cliff(bytes) {
  notifyFed9({
    characteristic: "dockNotify",
    hex: Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join(""),
    bytes: new Uint8Array(bytes),
  });
}
function tofClear() {
  notifyFed9({ characteristic: "dockNotify", hex: "0ee803", bytes: new Uint8Array([0x0e, 0xe8, 0x03]) });
}

robot.configureLooiRobotTransport(transport);
await robot.connectLooiRobot();
tofClear();
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));

const beforeAngry = writes.length;
const angry = await robot.performLooiCharacterReaction("angry");
assert.equal(angry.ok, true);
const angryWrites = writes.slice(beforeAngry).filter((write) => write.key === "drive");
assert.ok(angryWrites.some((write) => write.payload === "047a"), "angry reaction should include a bounded left body accent");
assert.ok(angryWrites.some((write) => write.payload === "0082"), "angry reaction should include a bounded right body accent");
assert.ok(events.some((event) => event.category === "character" && event.event === "physical-reaction-finished" && event.details.reaction === "angry"));

// A cliff/STOP inside the first body primitive must cancel all later primitives.
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
const cancellationStart = writes.length;
const pending = robot.performLooiCharacterReaction("angry");
await new Promise((resolve) => setTimeout(resolve, 45));
cliff([1, 0, 1, 1, 1]);
await assert.rejects(pending, /interrupted|blocked|failed/i);
const cancelledWrites = writes.slice(cancellationStart).filter((write) => write.key === "drive");
const stopIndex = cancelledWrites.findIndex((write) => write.payload === "0000");
assert.ok(stopIndex >= 0, "cliff must STOP the active character primitive");
assert.equal(cancelledWrites.slice(stopIndex + 1).some((write) => write.payload === "0082"), false, "character sequence must not start the next right primitive after STOP");
assert.ok(events.some((event) => event.category === "character" && event.event === "motion-sequence-cancelled"));

// STOP during a head-only opening beat must cancel the dance before any wheel
// primitive begins. This guards against a composite sequence re-starting motion
// after the user has already stopped it.
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
const headStopStart = writes.length;
const headStopDance = robot.performLooiDance("happy-sway-v1");
await new Promise((resolve) => setTimeout(resolve, 100));
await robot.stopLooiMotion("test-stop-during-dance-head");
await assert.rejects(headStopDance, /interrupted/i);
const headStopWrites = writes.slice(headStopStart).filter((write) => write.key === "drive");
assert.equal(headStopWrites.some((write) => write.payload === "047a" || write.payload === "0082"), false, "STOP during head gesture must prevent later dance wheel motion");

// Restore safe state and verify an explicit alternate dance style is bounded.
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
// The cancelled reaction leaves a front near-edge latch; explicitly move away long
// enough using the production safety path before trying a dance.
await robot.startLooiMotion("back");
await new Promise((resolve) => setTimeout(resolve, 700));
await robot.stopLooiMotion("character-test-escape");
const dance = await robot.performLooiDance("silly-shake-v1");
assert.equal(dance.style, "silly-shake-v1");
assert.equal(dance.bounded, true);
assert.ok(dance.availableStyles.includes("bounded-wiggle-v1"));
assert.ok(dance.availableStyles.includes("happy-sway-v1"));
assert.ok(dance.availableStyles.includes("silly-shake-v1"));

await robot.disconnectLooiRobot();
console.log("Character layer behavioral tests passed");
