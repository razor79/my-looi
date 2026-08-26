import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function compileTs(file, customRequire) {
  const source = fs.readFileSync(file, "utf8");
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

const appState = {
  currentState: "active",
  addEventListener() {
    return { remove() {} };
  },
};
let savedRaw = JSON.stringify({ id: "02:00:00:00:00:01", name: "LOOI Robot" });
let connected = false;
let connectCalls = 0;
let disconnectCalls = 0;
const events = [];

const robotMock = {
  async connectLooiRobot() {
    connectCalls += 1;
    connected = true;
    return { ok: true, connected: true };
  },
  configureLooiRobotTransport() {},
  async disconnectLooiRobot() {
    disconnectCalls += 1;
    connected = false;
  },
  getLooiRobotRuntimeState() {
    return { connected };
  },
  markLooiDriveControlNeedsRevalidation() {},
  handleLooiRobotTransportDisconnected() {
    connected = false;
  },
  async stopLooiMotion() {},
};

class FakeTransport {
  constructor(options) {
    this.options = options;
  }
}

const customRequire = (id) => {
  if (id === "react-native") return { AppState: appState, Platform: { OS: "android" } };
  if (id === "expo-secure-store") {
    return {
      getItemAsync: async () => savedRaw,
      setItemAsync: async (_key, value) => { savedRaw = value; },
      deleteItemAsync: async () => { savedRaw = null; },
    };
  }
  if (id === "../diagnostics/diagnostic-log") {
    return { recordDiagnosticEvent: (category, event, details = {}) => events.push({ category, event, details }) };
  }
  if (id === "./looi-robot") return robotMock;
  if (id === "./react-native-ble-transport") {
    return { ReactNativeBleLooiTransport: FakeTransport, scanLooiRobotCandidates: async () => [] };
  }
  return require(id);
};

const auto = compileTs("src/device-tools/looi-robot-autoconnect.ts", customRequire);

const first = await auto.startLooiRobotAutoConnection();
assert.equal(first.ok, true);
assert.equal(connectCalls, 1);

// A completed connection promise must not be reused after a lifecycle disconnect.
await auto.suspendLooiRobotAutoConnection("test-background");
assert.equal(connected, false);
const resumed = await auto.resumeLooiRobotAutoConnection("test-foreground");
assert.equal(resumed.ok, true);
assert.equal(connectCalls, 2, "foreground resume must perform a fresh BLE connect");

const alreadyConnected = await auto.forceReconnectSavedLooiRobot();
assert.equal(alreadyConnected.ok, true);
assert.equal(connectCalls, 2, "healthy connected BLE must not be torn down/reconnected");
assert.ok(events.some((event) => event.event === "ble-force-reconnect-skipped" && event.details.reason === "already-connected"));

// Once BLE is genuinely disconnected, the same recovery control must connect again.
await robotMock.disconnectLooiRobot();
const forced = await auto.forceReconnectSavedLooiRobot();
assert.equal(forced.ok, true);
assert.equal(connectCalls, 3, "disconnected robot must perform a fresh BLE connect");
assert.ok(disconnectCalls >= 3);
assert.ok(events.some((event) => event.event === "ble-background-disconnect-complete"));
assert.ok(events.some((event) => event.event === "ble-force-reconnect-finished"));

appState.currentState = "background";
await auto.suspendLooiRobotAutoConnection("test-background-2");
const blocked = await auto.startLooiRobotAutoConnection();
assert.equal(blocked.ok, false);
assert.equal(blocked.reason, "background-suspended");
assert.equal(connectCalls, 3, "background must not reconnect BLE");

console.log("BLE autoconnect lifecycle behavioral tests passed");
