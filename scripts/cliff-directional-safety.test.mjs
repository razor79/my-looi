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
    .replace("export const CONTINUOUS_MOTION_DEADMAN_MS = 5_000;", "export const CONTINUOUS_MOTION_DEADMAN_MS = 600;")
    .replace("export const CLIFF_ESCAPE_CLEAR_MS = 650;", "export const CLIFF_ESCAPE_CLEAR_MS = 120;")
    .replace("export const MANUAL_REPOSITION_SAFE_MS = 900;", "export const MANUAL_REPOSITION_SAFE_MS = 120;")
    .replace("export const TURN_90_MS = 650;", "export const TURN_90_MS = 160;")
    .replace("export const TURN_180_MS = 1_560;", "export const TURN_180_MS = 320;")
);

const transport = {
  async connect() {},
  async disconnect() {},
  hasCharacteristic(key) {
    return key === "dockNotify" || key === "drive";
  },
  async startNotifications(key, callback) {
    if (key === "dockNotify") notifyFed9 = callback;
  },
  async write(key, payload, options) {
    writes.push({ at: Date.now(), key, payload, options });
  },
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

async function expectBlocked(fn, reasonPattern) {
  const beforeWrites = writes.length;
  await assert.rejects(fn, /Движение заблокировано/);
  assert.equal(writes.length, beforeWrites, "blocked motion must not emit a BLE drive write");
  const lastBlock = [...events].reverse().find((event) => event.event === "movement-blocked");
  assert.ok(lastBlock, "movement-blocked diagnostic must be emitted");
  assert.match(String(lastBlock.details.reason), reasonPattern);
}

robot.configureLooiRobotTransport(transport);
await robot.connectLooiRobot();
assert.ok(notifyFed9, "FED9 callback should be registered");

tofClear();
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));

// Controlled calibration mapping: marker, FL, FR, RL, RR.
const decoded = fed9.decodeFed9SensorFrame(new Uint8Array([1, 0, 1, 1, 1]));
assert.equal(decoded.kind, "cliff");
assert.deepEqual(decoded.sensors, { frontLeft: false, frontRight: true, rearLeft: true, rearRight: true });
assert.equal(decoded.marker, true);

// Front edge blocks forward/turn but must still allow backing away.
cliff([1, 0, 1, 1, 1]);
await expectBlocked(() => robot.startLooiMotion("forward"), /cliff-front/);
await expectBlocked(() => robot.turnLooi("left", 90), /cliff-turn/);
await robot.startLooiMotion("back");
assert.equal(robot.getLooiRobotRuntimeState().motionActive, true);
await robot.stopLooiMotion("test-back-away-front-edge");

// A safe frame re-arms only after the stability window; waitForMovementSafetyReady
// should hold the command instead of driving immediately.
cliff([1, 1, 1, 1, 1]);
const rearmStartedAt = Date.now();
await robot.startLooiMotion("forward");
assert.ok(Date.now() - rearmStartedAt >= 200, "safe re-arm should wait for stable cliff state");
await robot.stopLooiMotion("test-rearmed");

// Rear edge blocks reverse/turn but forward escape remains allowed.
cliff([1, 1, 1, 0, 1]);
await expectBlocked(() => robot.startLooiMotion("back"), /cliff-rear/);
await expectBlocked(() => robot.turnLooi("right", 90), /cliff-turn/);
await robot.startLooiMotion("forward");
assert.equal(robot.getLooiRobotRuntimeState().motionActive, true);
await robot.stopLooiMotion("test-forward-away-rear-edge");

// Active forward motion must stop immediately when a front sensor loses ground,
// and the incident must leave a persistent near-edge latch.
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
const beforeSafetyWrites = writes.length;
await robot.startLooiMotion("forward");
cliff([1, 0, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(robot.getLooiRobotRuntimeState().motionActive, false);
assert.equal(robot.getLooiRobotRuntimeState().nearEdge.front, true, "moving front cliff must latch near-edge FRONT");
assert.ok(writes.slice(beforeSafetyWrites).some((write) => write.payload === "0000"), "front cliff must emit STOP");
assert.ok(events.some((event) => event.event === "sensor-safety-stop" && event.details.cliffDirection === "front"));
assert.ok(events.some((event) => event.event === "near-edge-latched" && event.details.side === "front"));

// A later SAFE frame alone must NOT clear the incident. Risky motion remains
// blocked even after the old 250 ms raw-sensor debounce expires.
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
await expectBlocked(() => robot.startLooiMotion("forward"), /near-edge-front/);
await expectBlocked(() => robot.turnLooi("left", 90), /near-edge-turn/);
assert.equal(robot.getLooiRobotRuntimeState().nearEdge.front, true);

// Only actual movement away from the front edge clears the latch. In this test
// CLIFF_ESCAPE_CLEAR_MS is transformed to 120 ms so the suite stays fast.
await robot.startLooiMotion("back");
await new Promise((resolve) => setTimeout(resolve, 170));
assert.equal(robot.getLooiRobotRuntimeState().nearEdge.front, false, "stable backward escape must clear FRONT latch");
assert.equal(robot.getLooiRobotRuntimeState().motionActive, true);
await robot.stopLooiMotion("test-front-edge-cleared");
assert.ok(events.some((event) => event.event === "near-edge-cleared" && event.details.side === "front" && event.details.escapeDirection === "back"));

// Symmetric rear incident: reverse is stopped/latching, SAFE alone does not
// clear it, and forward movement is the only permitted escape.
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
await robot.startLooiMotion("back");
cliff([1, 1, 1, 0, 1]);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(robot.getLooiRobotRuntimeState().motionActive, false);
assert.equal(robot.getLooiRobotRuntimeState().nearEdge.rear, true, "moving rear cliff must latch near-edge REAR");
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
await expectBlocked(() => robot.startLooiMotion("back"), /near-edge-rear/);
await expectBlocked(() => robot.turnLooi("right", 90), /near-edge-turn/);
await robot.startLooiMotion("forward");
await new Promise((resolve) => setTimeout(resolve, 170));
assert.equal(robot.getLooiRobotRuntimeState().nearEdge.rear, false, "stable forward escape must clear REAR latch");
await robot.stopLooiMotion("test-rear-edge-cleared");

// Explicit manual-reposition recovery clears a latched edge without moving the
// robot, but only after all four calibrated sensors have stayed SAFE long enough.
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
await robot.startLooiMotion("forward");
cliff([1, 0, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(robot.getLooiRobotRuntimeState().nearEdge.front, true);
cliff([1, 1, 1, 1, 1]);
assert.throws(() => robot.clearLooiNearEdgeAfterManualReposition(), /переставьте|подождите/);
await new Promise((resolve) => setTimeout(resolve, 150));
const manualClear = robot.clearLooiNearEdgeAfterManualReposition();
assert.equal(manualClear.cleared, true);
assert.equal(robot.getLooiRobotRuntimeState().nearEdge.front, false);
assert.ok(events.some((event) => event.event === "near-edge-manual-cleared"));

// An opposite-side raw cliff is still allowed while already escaping from it;
// the relevant pair for the travel direction remains authoritative.
cliff([1, 1, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 280));
await robot.startLooiMotion("back");
cliff([1, 0, 1, 1, 1]);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(robot.getLooiRobotRuntimeState().motionActive, true, "front edge must allow backward escape");
await robot.stopLooiMotion("test-backward-escape");

await robot.disconnectLooiRobot();
console.log("Directional cliff safety behavioral tests passed");
