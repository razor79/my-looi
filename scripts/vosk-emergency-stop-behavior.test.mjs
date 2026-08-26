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

const listeners = new Map();
const diagnostics = [];
let prepareArgs = null;
const commandCalls = [];
const resetCalls = [];
const armCalls = [];
const disarmCalls = [];
let emergencyArmed = false;
let emergencyArmGeneration = 0;
let motionActive = true;

const native = {
  addListener(name, fn) { listeners.set(name, fn); return { remove() {} }; },
  async prepare(...args) { prepareArgs = args; emergencyArmed = false; },
  getStatus() {
    return {
      ready: true,
      language: "ru",
      queuedChunks: 0,
      sessionId: 1,
      resetGeneration: 0,
      resetCount: 0,
      droppedChunks: 0,
      samplesSinceReset: 0,
      emergencySamplesSinceReset: 0,
      emergencyArmed,
      emergencyArmGeneration,
    };
  },
  feedSamples() {},
  async armEmergency(reason) {
    armCalls.push(reason);
    emergencyArmed = true;
    emergencyArmGeneration += 1;
    return true;
  },
  async disarmEmergency(reason) {
    disarmCalls.push(reason);
    emergencyArmed = false;
    emergencyArmGeneration += 1;
  },
  reset(reason, resetEmergency) {
    resetCalls.push({ reason, resetEmergency });
    if (resetEmergency) {
      emergencyArmed = false;
      emergencyArmGeneration += 1;
    }
    return resetCalls.length;
  },
};

const customRequire = (id) => {
  if (id === "react-native") return { Platform: { OS: "android" } };
  if (id === "../../modules/vosk-command-recognizer") return { __esModule: true, default: native };
  if (id === "../diagnostics/diagnostic-log") return { recordDiagnosticEvent: (category, event, details = {}) => diagnostics.push({ category, event, details }) };
  if (id === "../store/user") return { useUserStore: { getState: () => ({ preferences: { listeningLanguage: "ru" } }) } };
  if (id === "../device-tools/looi-robot") {
    return { getLooiRobotRuntimeState: () => ({ motionActive, activeDirection: motionActive ? "forward" : null }) };
  }
  if (id === "./driving-command") {
    return {
      parseDrivingCommandTranscript: (text) => /^(стоп|стой)$/.test(text) ? { kind: "stop" } : null,
    };
  }
  if (id === "./driving-command-grammar") {
    return {
      buildDrivingCommandGrammar: () => ({ phrases: ["стоп", "стой", "вперёд", "[unk]"], commandByPhrase: new Map([["стоп", { kind: "stop" }], ["стой", { kind: "stop" }]]) }),
      normalizeDrivingGrammarResult: (text) => text.trim().toLowerCase(),
    };
  }
  if (id === "./driving-control-session") {
    return {
      getDrivingControlSessionRemainingMs: () => 20_000,
      isDrivingControlSessionActive: () => true,
      refreshDrivingControlSession() {},
    };
  }
  return require(id);
};

const { voskDrivingCommandRecognizer } = compileTs("src/voice/vosk-driving-command.ts", customRequire);
voskDrivingCommandRecognizer.setCommandHandler((command, transcript) => commandCalls.push({ command, transcript }));

assert.equal(await voskDrivingCommandRecognizer.prewarm("ru"), true);
assert.ok(prepareArgs, "native prepare must be called");
assert.equal(prepareArgs.length, 4, "prepare must receive normal + emergency grammars");
const emergencyGrammar = JSON.parse(prepareArgs[3]);
assert.ok(emergencyGrammar.includes("[unk]"), "emergency grammar must keep an unknown sink");
assert.ok(emergencyGrammar.includes("стоп"));
assert.ok(emergencyGrammar.includes("стой"));
assert.ok(emergencyGrammar.length < 32, "emergency grammar should remain tiny");

const emergency = listeners.get("onEmergencyStop");
const emergencyUnknown = listeners.get("onEmergencyUnknown");
const emergencyHealth = listeners.get("onEmergencyHealth");
const normal = listeners.get("onCommandResult");
assert.equal(typeof emergency, "function");
assert.equal(typeof emergencyUnknown, "function");
assert.equal(typeof emergencyHealth, "function");
assert.equal(typeof normal, "function");

// v1.1.41: every physical motion gets a fresh emergency decoder arm before BLE motion.
assert.equal(await voskDrivingCommandRecognizer.armEmergencyForMotion("test-motion", 60_000), true);
assert.deepEqual(armCalls, ["test-motion"]);
assert.equal(emergencyArmed, true);
assert.ok(diagnostics.some((event) => event.event === "vosk-emergency-armed"));

// Normal wide-command cleanup must not erase an active per-motion STOP decoder.
voskDrivingCommandRecognizer.reset("driving-move-finished", false);
assert.deepEqual(resetCalls.at(-1), { reason: "driving-move-finished", resetEmergency: false });
assert.equal(emergencyArmed, true);

emergencyHealth({ armed: true, armGeneration: emergencyArmGeneration, partialText: "", endpoint: false, processingMs: 3, sessionId: 1, samplesSinceEmergencyReset: 8000, queuedChunks: 1, rms16: 180 });
assert.ok(diagnostics.some((event) => event.event === "vosk-emergency-health"));

emergencyUnknown({ text: "[unk]", partial: true, processingMs: 5, sessionId: 1, samplesSinceEmergencyReset: 12000, queuedChunks: 1, rms16: 250 });
assert.equal(commandCalls.length, 0, "emergency unknown telemetry must never execute motion");
assert.ok(diagnostics.some((event) => event.event === "vosk-emergency-unknown"));

emergency({ text: "стой", partial: true, processingMs: 8, sessionId: 1, samplesSinceEmergencyReset: 16000, queuedChunks: 1, rms16: 300 });
assert.equal(commandCalls.length, 1);
assert.deepEqual(commandCalls[0], { command: { kind: "stop" }, transcript: "стой" });
assert.ok(diagnostics.some((event) => event.event === "vosk-emergency-stop"));

// Actual STOP/session-boundary reset still disarms both recognizers.
voskDrivingCommandRecognizer.reset("driving-stop");
assert.deepEqual(resetCalls.at(-1), { reason: "driving-stop", resetEmergency: true });
assert.equal(emergencyArmed, false);

// The normal wide recognizer may report the same STOP a few milliseconds later;
// it must not execute a duplicate physical STOP.
normal({ text: "стоп", partial: true, sequence: 2, processingMs: 30, sessionId: 1, resetGeneration: 0, samplesSinceReset: 17000, queuedChunks: 1, droppedChunks: 0, endpoint: false, rms16: 280 });
assert.equal(commandCalls.length, 1, "normal partial STOP must be deduped after emergency STOP");

// Deadman/sensor/turn completion can stop motion outside the command handler.
// A health tick while stationary must tear the per-motion emergency decoder down.
await voskDrivingCommandRecognizer.armEmergencyForMotion("test-motion-2", 60_000);
motionActive = false;
await new Promise((resolve) => setTimeout(resolve, 1_550));
emergencyHealth({ armed: true, armGeneration: emergencyArmGeneration, partialText: "", endpoint: false, processingMs: 3, sessionId: 1, samplesSinceEmergencyReset: 9000, queuedChunks: 1, rms16: 90 });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(disarmCalls.includes("motion-inactive-health"));
assert.equal(emergencyArmed, false);

// Source-order guard: fresh emergency arm must be awaited before wheel APIs.
const wakewordSource = fs.readFileSync("src/voice/wakeword.ts", "utf8");
const localMoveArm = wakewordSource.indexOf('await voskDrivingCommandRecognizer.armEmergencyForMotion("local-move", 8_000)');
const localMoveStart = wakewordSource.indexOf("await startLooiMotion(command.direction)", localMoveArm);
assert.ok(localMoveArm >= 0 && localMoveStart > localMoveArm, "local move must arm emergency before motor start");

const perceiverSource = fs.readFileSync("src/perceivers/voice-perceiver.ts", "utf8");
const addressedMoveArm = perceiverSource.indexOf('await voskDrivingCommandRecognizer.armEmergencyForMotion("addressed-move", 8_000)');
const addressedMoveStart = perceiverSource.indexOf("await startLooiMotion(command.direction)", addressedMoveArm);
assert.ok(addressedMoveArm >= 0 && addressedMoveStart > addressedMoveArm, "addressed move must arm emergency before motor start");

const nativeSource = fs.readFileSync("modules/vosk-command-recognizer/android/src/main/java/com/superlooi/voskcommand/VoskCommandRecognizerModule.kt", "utf8");
assert.match(nativeSource, /feedEmergencyGeneration = if \(emergencyArmed\) emergencyArmGeneration\.get\(\) else 0/);
assert.match(nativeSource, /feedEmergencyGeneration == emergencyArmGeneration\.get\(\)/);

console.log("Vosk per-motion emergency STOP behavioral tests passed");
