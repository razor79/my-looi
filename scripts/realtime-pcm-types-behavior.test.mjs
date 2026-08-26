import fs from "node:fs";
import assert from "node:assert/strict";

const player = fs.readFileSync("src/voice/realtime-pcm-player.ts", "utf8");
const config = fs.readFileSync("src/voice/realtime-config.ts", "utf8");
assert.match(player, /type OwnedPcmBytes = Uint8Array<ArrayBuffer>/, "Realtime PCM owned chunks must keep an explicit ArrayBuffer backing type");
assert.match(player, /function concatBytes\(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>\): OwnedPcmBytes/, "concat must accept compatible views but return owned ArrayBuffer bytes");
assert.match(player, /private pending: OwnedPcmBytes/, "pending PCM must use the owned backing-buffer type");
assert.match(player, /private queue: OwnedPcmBytes\[\]/, "queued PCM must use the owned backing-buffer type");
assert.match(config, /base64ToBytes\(value: string\): Uint8Array<ArrayBuffer>/, "base64 decoder allocates and must advertise ArrayBuffer-backed bytes");
console.log("Realtime PCM typed-array backing-buffer regression: PASS");
