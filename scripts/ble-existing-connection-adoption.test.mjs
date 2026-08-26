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

const sdk = compileTs("packages/looi-sdk/src/index.ts", require);
const events = [];
const permissions = {
  BLUETOOTH_SCAN: "scan",
  BLUETOOTH_CONNECT: "connect",
  ACCESS_FINE_LOCATION: "location",
};
const reactNative = {
  Platform: { OS: "android", Version: 35 },
  PermissionsAndroid: {
    PERMISSIONS: permissions,
    RESULTS: { GRANTED: "granted" },
    requestMultiple: async (requested) => Object.fromEntries(requested.map((item) => [item, "granted"])),
  },
};

const serviceUuid = "000000ff-0000-1000-8000-00805f9b34fb";
const device = { id: "02:00:00:00:00:01", name: "LOOI Robot", localName: "LOOI Robot", serviceUUIDs: [serviceUuid] };
const characteristics = [
  { uuid: "0000fed0-0000-1000-8000-00805f9b34fb", isReadable: false, isWritableWithResponse: true, isWritableWithoutResponse: true, isNotifiable: false, isIndicatable: false },
  { uuid: "0000fed9-0000-1000-8000-00805f9b34fb", isReadable: false, isWritableWithResponse: false, isWritableWithoutResponse: false, isNotifiable: true, isIndicatable: false },
  { uuid: "0000feda-0000-1000-8000-00805f9b34fb", isReadable: false, isWritableWithResponse: true, isWritableWithoutResponse: false, isNotifiable: false, isIndicatable: false },
];

function makeManager({ initiallyConnected, connectError = null }) {
  const calls = { connect: 0, discover: 0, monitor: 0, isConnected: 0 };
  let connected = initiallyConnected;
  const manager = {
    calls,
    async state() { return "PoweredOn"; },
    async isDeviceConnected(id) { calls.isConnected += 1; assert.equal(id, device.id); return connected; },
    async connectedDevices() { return connected ? [device] : []; },
    async devices() { return [device]; },
    async connectToDevice(id) {
      calls.connect += 1;
      assert.equal(id, device.id);
      if (connectError) throw new Error(connectError);
      connected = true;
      return device;
    },
    onDeviceDisconnected() { return { remove() {} }; },
    async discoverAllServicesAndCharacteristicsForDevice(id) { calls.discover += 1; assert.equal(id, device.id); return device; },
    async servicesForDevice() { return [{ uuid: serviceUuid }]; },
    async characteristicsForDevice() { return characteristics; },
    async requestMTUForDevice() {},
    monitorCharacteristicForDevice(_id, _service, _uuid, _callback) { calls.monitor += 1; return { remove() {} }; },
    async stopDeviceScan() {},
    async cancelDeviceConnection() { connected = false; },
  };
  return manager;
}

const customRequire = (id) => {
  if (id === "react-native") return reactNative;
  if (id === "react-native-ble-plx") {
    return { BleManager: class {}, ScanMode: { LowLatency: 2 }, State: { PoweredOn: "PoweredOn", PoweredOff: "PoweredOff" } };
  }
  if (id === "@sourcebug/looi-sdk") return sdk;
  if (id === "../diagnostics/diagnostic-log") {
    return { recordDiagnosticEvent: (category, event, details = {}) => events.push({ category, event, details }) };
  }
  return require(id);
};

const transportModule = compileTs("src/device-tools/react-native-ble-transport.ts", customRequire);

// Case 1: Android already reports the saved device connected. Do not call
// connectToDevice again; adopt it, rediscover GATT, then allow FED9 subscribe.
{
  const manager = makeManager({ initiallyConnected: true });
  const transport = new transportModule.ReactNativeBleLooiTransport({ manager, deviceId: device.id, robotName: device.name });
  await transport.connect();
  assert.equal(manager.calls.connect, 0, "existing GATT must be adopted without connectToDevice");
  assert.equal(manager.calls.discover, 1, "adopted GATT must be rediscovered");
  await transport.startNotifications("dockNotify", () => {});
  assert.equal(manager.calls.monitor, 1, "FED9 notification subscription must be restorable after adoption");
  assert.ok(events.some((event) => event.event === "ble-existing-connection-adopted" && event.details.reason === "manager-is-connected"));
  assert.ok(events.some((event) => event.event === "ble-existing-connection-gatt-restored"));
}

// Case 2: Android races: pre-check says disconnected but connectToDevice throws
// the exact stale-link symptom seen in the device log. Recovery must still adopt
// the link and continue into GATT discovery rather than fail foreground resume.
{
  const manager = makeManager({ initiallyConnected: false, connectError: "Device ? is already connected" });
  const transport = new transportModule.ReactNativeBleLooiTransport({ manager, deviceId: device.id, robotName: device.name });
  await transport.connect();
  assert.equal(manager.calls.connect, 1);
  assert.equal(manager.calls.discover, 1, "already-connected race must proceed to GATT rediscovery");
  assert.ok(events.some((event) => event.event === "ble-existing-connection-adopted" && event.details.reason === "already-connected-error"));
}

console.log("BLE existing-connection adoption tests passed");
