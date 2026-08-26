import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function compileTs(file, customRequire, transformSource = (source) => source) {
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

const appState = {
  currentState: "active",
  addEventListener() { return { remove() {} }; },
};
let savedRaw = JSON.stringify({ id: "02:00:00:00:00:01", name: "LOOI Robot" });
let connected = false;
let connectCalls = 0;
let failNextConnect = false;
const events = [];

const robotMock = {
  async connectLooiRobot() {
    connectCalls += 1;
    if (failNextConnect) {
      failNextConnect = false;
      throw new Error("Operation was cancelled");
    }
    connected = true;
    return { ok: true, connected: true };
  },
  configureLooiRobotTransport() {},
  async disconnectLooiRobot() { connected = false; },
  getLooiRobotRuntimeState() { return { connected }; },
  markLooiDriveControlNeedsRevalidation() {},
  handleLooiRobotTransportDisconnected() { connected = false; },
  async stopLooiMotion() {},
};

class FakeTransport { constructor(options) { this.options = options; } }

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

const auto = compileTs("src/device-tools/looi-robot-autoconnect.ts", customRequire, (source) =>
  source.replace("const FOREGROUND_RETRY_DELAY_MS = 1_000;", "const FOREGROUND_RETRY_DELAY_MS = 40;")
);

await auto.startLooiRobotAutoConnection();
assert.equal(connectCalls, 1);
await auto.suspendLooiRobotAutoConnection("sleep");
assert.equal(connected, false);

failNextConnect = true;
await assert.rejects(auto.resumeLooiRobotAutoConnection("wake-from-sleep"), /Operation was cancelled/);
assert.equal(connectCalls, 2, "first foreground reconnect should be attempted immediately");
assert.ok(events.some((event) => event.event === "ble-foreground-reconnect-retry-scheduled"));

await new Promise((resolve) => setTimeout(resolve, 90));
assert.equal(connectCalls, 3, "transient foreground failure should trigger one clean retry");
assert.equal(connected, true, "scheduled retry should restore the BLE link");
assert.ok(events.some((event) => event.event === "ble-foreground-reconnect-retry-start"));
assert.ok(events.some((event) => event.event === "ble-foreground-reconnect-retry-finished" && event.details.ok === true));

// A later background transition must cancel any pending retry and keep BLE quiet.
appState.currentState = "background";
await auto.suspendLooiRobotAutoConnection("background");
const callsBefore = connectCalls;
await new Promise((resolve) => setTimeout(resolve, 70));
assert.equal(connectCalls, callsBefore, "background must not run a foreground retry");

console.log("BLE foreground retry behavioral tests passed");
