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
  const fn = new Function("exports", "require", "module", "__filename", "__dirname", output);
  fn(module.exports, customRequire, module, file, path.dirname(file));
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
    return { recordDiagnosticEvent: (category, event, details = {}) => events.push({ category, event, details }) };
  }
  return require(id);
};

const robotSource = fs.readFileSync("src/device-tools/looi-robot.ts", "utf8");
assert.match(robotSource, /CONTINUOUS_MOTION_DEADMAN_MS = 5_000/);

// Keep the behavioral test fast while exercising the exact same timer path.
const robot = compileTs("src/device-tools/looi-robot.ts", customRequire, (source) =>
  source.replace("export const CONTINUOUS_MOTION_DEADMAN_MS = 5_000;", "export const CONTINUOUS_MOTION_DEADMAN_MS = 120;")
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

robot.configureLooiRobotTransport(transport);
await robot.connectLooiRobot();
assert.ok(notifyFed9, "FED9 callback should be registered");

// Known-safe cliff state + front TOF > threshold.
notifyFed9({ characteristic: "dockNotify", hex: "0101010101", bytes: new Uint8Array([1, 1, 1, 1, 1]) });
notifyFed9({ characteristic: "dockNotify", hex: "0ee803", bytes: new Uint8Array([0x0e, 0xe8, 0x03]) });

async function expectDeadman(direction) {
  const beforeEventCount = events.length;
  const beforeWriteCount = writes.length;
  await robot.startLooiMotion(direction);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const newEvents = events.slice(beforeEventCount);
  const newWrites = writes.slice(beforeWriteCount);
  assert.ok(newEvents.some((event) => event.event === "continuous-motion-deadman-fired" && event.details.direction === direction));
  assert.ok(newWrites.some((write) => write.payload === "0000"), `${direction} should emit a deadman STOP write`);
  assert.equal(robot.getLooiRobotRuntimeState().motionActive, false);
}

await expectDeadman("forward");
await expectDeadman("back");

// An explicit STOP must cancel the pending deadman rather than fire later.
const beforeEarlyStopEvents = events.length;
await robot.startLooiMotion("forward");
await new Promise((resolve) => setTimeout(resolve, 30));
await robot.stopLooiMotion("test-explicit-stop");
await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(
  events.slice(beforeEarlyStopEvents).filter((event) => event.event === "continuous-motion-deadman-fired").length,
  0,
  "explicit STOP should cancel the continuous deadman"
);

await robot.disconnectLooiRobot();
console.log("Motion deadman behavioral tests passed");
