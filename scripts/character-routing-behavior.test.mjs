import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadTsCommonJs(path) {
  const source = fs.readFileSync(path, "utf8");
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    require,
    module,
    path,
    process.cwd()
  );
  return module.exports;
}

const explicit = loadTsCommonJs("src/voice/explicit-robot-command.ts");
assert.deepEqual(explicit.parseExplicitRobotCommand("Луи, потанцуй."), { kind: "dance" });
assert.deepEqual(explicit.parseExplicitRobotCommand("Робот, станцуй!"), { kind: "dance" });
assert.deepEqual(explicit.parseExplicitRobotCommand("Луї, потанцюй."), { kind: "dance" });
assert.deepEqual(explicit.parseExplicitRobotCommand("Looi, dance!"), { kind: "dance" });
assert.deepEqual(explicit.parseExplicitRobotCommand("Макс, потанцуй!"), { kind: "dance" });
assert.deepEqual(explicit.parseExplicitRobotCommand("Max, dance!"), { kind: "dance" });
assert.equal(explicit.parseExplicitRobotCommand("Давай, Луи, потанцуй"), null, "address must remain utterance-initial");

const routing = loadTsCommonJs("src/character/face-tap-routing.ts");
const base = {
  motionActive: false,
  drivingSessionActive: false,
  conversationProcessing: false,
  conversationSpeaking: false,
  voiceState: "sleeping",
};
assert.equal(routing.classifyFaceTapImmediateRoute(base), "burst");
assert.equal(routing.classifyFaceTapImmediateRoute({ ...base, voiceState: "listening" }), "burst", "passive listening must not swallow a multi-tap burst");
assert.equal(routing.classifyFaceTapImmediateRoute({ ...base, voiceState: "attention" }), "burst");
assert.equal(routing.classifyFaceTapImmediateRoute({ ...base, motionActive: true }), "driving-stop");
assert.equal(routing.classifyFaceTapImmediateRoute({ ...base, drivingSessionActive: true }), "driving-session-exit");
assert.equal(routing.classifyFaceTapImmediateRoute({ ...base, voiceState: "speaking" }), "classic-interrupt");
assert.equal(routing.classifyFaceTapImmediateRoute({ ...base, conversationProcessing: true }), "classic-interrupt");
assert.equal(routing.classifyFaceTapImmediateRoute({ ...base, voiceState: "verifying" }), "classic-interrupt");

const homeSource = fs.readFileSync("app/(tabs)/index.tsx", "utf8");
assert.ok(homeSource.includes("prepareIdleCharacterReaction"));
assert.ok(homeSource.includes('"face-tap-routed"'));
assert.equal(homeSource.includes('voiceState !== "sleeping"'), false, "old broad tap gate must stay removed");

const perceiverSource = fs.readFileSync("src/perceivers/voice-perceiver.ts", "utf8");
assert.ok(perceiverSource.includes('performLooiDance("random")'), "addressed dance must execute local bounded dance engine");
assert.ok(perceiverSource.includes('armEmergencyForMotion("addressed-dance", 10_000)'), "addressed dance must preserve emergency STOP arming");
assert.ok(perceiverSource.includes('"passive-listening-released"'), "passive listening release should be diagnostic");

console.log("Character routing behavioral tests passed");
