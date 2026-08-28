import assert from "node:assert/strict";
import fs from "node:fs";

const pcm = fs.readFileSync("src/voice/realtime-pcm-conversation.ts", "utf8");
const helper = fs.readFileSync("src/voice/realtime-physical-command.ts", "utf8");
const config = fs.readFileSync("src/voice/realtime-config.ts", "utf8");

assert.ok(pcm.includes('parseRealtimePhysicalCommand(transcript)'), "PCM transcript must be checked for deterministic physical commands");
assert.ok(pcm.includes('executeRealtimePhysicalCommand(physicalCommand, transcript)'), "PCM must execute intercepted physical commands locally");
assert.ok(pcm.includes('type: "response.cancel"'), "Realtime response must be cancellable when a local physical command is intercepted");
assert.ok(pcm.includes('pcm-response-suppressed-for-physical-command'), "late response.created events must be suppressed during local physical execution");
assert.ok(pcm.includes('if (this.localPhysicalCommandInFlight) return;'), "generated model audio/transcript must not leak through while a local command is executing");

assert.ok(helper.includes('parseExplicitRobotCommand(transcript)'), "Realtime routing must reuse the deterministic addressed-command parser");
assert.ok(helper.includes('containsEmergencyStopWord(transcript)'), "standalone STOP must remain an absolute safety command");
assert.ok(helper.includes('await moveLooi(command.direction)'), "Realtime forward/backward movement must use the bounded motion primitive");
assert.equal(helper.includes('startLooiMotion('), false, "Realtime PCM must not start continuous translation without the local STOP microphone path");
assert.ok(helper.includes('await turnLooi(command.direction, command.degrees)'), "turns must use calibrated bounded motion");
assert.ok(helper.includes('await performLooiHeadGesture(command.gesture, command.count)'), "head gestures must remain available");
assert.ok(helper.includes('await performLooiDance("random")'), "bounded dance remains available through the safety controller");

assert.ok(config.includes("You have no physical movement tool yourself"), "LLM must not be granted autonomous movement tools");
assert.ok(config.includes("intercepted and executed deterministically by the local app"), "Realtime instructions must describe the local deterministic handoff");

console.log("Realtime PCM physical command routing regression: PASS");
