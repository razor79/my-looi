import assert from "node:assert/strict";
import fs from "node:fs";

const pcm = fs.readFileSync("src/voice/realtime-pcm-conversation.ts", "utf8");

assert.ok(pcm.includes("private suppressedResponseIds = new Set<string>()"), "suppression must follow response identity, not command duration");
assert.ok(pcm.includes("private awaitingTurnTranscript = false"), "PCM output must wait for transcript classification before becoming audible");
assert.ok(pcm.includes("this.startTranscriptPlaybackGate()"), "server-VAD turn completion must arm the transcript playback gate");
assert.ok(pcm.includes('this.pendingResponseAudio.push(delta)'), "audio generated before transcript classification must be buffered locally");
assert.ok(pcm.includes('this.discardTranscriptPlaybackGate("local-physical-command")'), "physical commands must discard all pre-transcript model audio");
assert.ok(pcm.includes('this.releaseTranscriptPlaybackGate("transcript-normal")'), "normal conversation must immediately release buffered audio after classification");
assert.ok(pcm.includes("this.suppressPhysicalCommandResponse()"), "physical commands must cancel and mark their model response as suppressed");
assert.ok(pcm.includes("if (this.isSuppressedResponseEvent(event)) return;"), "late events from a cancelled physical-command response must remain muted");
assert.ok(pcm.includes('pcm-suppressed-response-done'), "response suppression must remain active until the cancelled response reaches response.done");

const executeStart = pcm.indexOf("private async executeLocalPhysicalCommand");
const executeEnd = pcm.indexOf("private markPlaybackStarted", executeStart);
assert.ok(executeStart >= 0 && executeEnd > executeStart, "physical-command executor block must be present");
const executeBlock = pcm.slice(executeStart, executeEnd);
assert.equal(executeBlock.includes("suppressedResponseIds.clear"), false, "finishing robot motion must not release cancelled-response suppression");
assert.equal(executeBlock.includes("suppressResponseWithoutId = false"), false, "finishing robot motion must not release fallback suppression");

const responseDoneStart = pcm.indexOf('if (type === "response.done")');
const responseDoneEnd = pcm.indexOf("private responseIdFromEvent", responseDoneStart);
assert.ok(responseDoneStart >= 0 && responseDoneEnd > responseDoneStart, "response.done handler must be present");
const responseDoneBlock = pcm.slice(responseDoneStart, responseDoneEnd);
assert.ok(responseDoneBlock.includes("this.suppressedResponseIds.delete(responseId)"), "suppression should clear only when the matching response is done");

assert.equal(pcm.includes('if (this.localPhysicalCommandInFlight) return;\n      const delta'), false, "audio suppression must not depend only on robot-motion duration");

console.log("Realtime physical-command response suppression regression: PASS");
