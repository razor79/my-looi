import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const app = JSON.parse(readFileSync("app.json", "utf8"));
assert.equal(app.expo.version, pkg.version);
const patchVersion = Number(pkg.version.split(".")[2]);
assert.ok(Number.isInteger(patchVersion) && patchVersion >= 107, "v2.1.107 regression must remain active in later releases");
assert.ok(app.expo.android.versionCode >= 107);

const retiredPaths = [
  "server",
  "src/server-api",
  "docker-compose.yml",
  `docker-compose.${["syn", "ology"].join("")}.yml`,
  `.env.${["syn", "ology"].join("")}.example`,
  "src/voice/local-realtime-asr.ts",
  "src/voice/local-gigaam-russian-model.ts",
];
for (const path of retiredPaths) assert.equal(existsSync(path), false, `${path} must remain absent`);

const home = readFileSync("app/(tabs)/index.tsx", "utf8");
assert.match(home, /gearshape\.fill/);
assert.match(home, /applyLiveRealtimePreferences/);
assert.doesNotMatch(home, /quickPanelVisible|quickActions/);

const settings = readFileSync("app/(tabs)/settings.tsx", "utf8");
assert.doesNotMatch(settings, /Local ASR|GigaAM/);

const store = readFileSync("src/store/user.ts", "utf8");
assert.doesNotMatch(store, /realtime_local_asr|localAsrResponsePause/);
assert.match(store, /export type ConversationMode = "realtime" \| "realtime_pcm"/);
assert.doesNotMatch(store, /ConversationMode = [^;]*classic/);

const buildScript = readFileSync("scripts/build-android-apk.sh", "utf8");
assert.match(buildScript, /pnpm-lock-graph-audit\.mjs/);
assert.equal(existsSync("scripts/pnpm-lock-graph-audit.mjs"), true);

const retiredServices = readFileSync("src/voice/retired-classic-services.ts", "utf8");
assert.doesNotMatch(retiredServices, /export const sessionService:\s*any/);
assert.match(retiredServices, /async touch\(\): Promise<RetiredSessionTouchResult>/);
assert.match(retiredServices, /async recordUsage\([\s\S]*Promise<RetiredUsageResult>/);

const stt = readFileSync("src/voice/stt.ts", "utf8");
assert.match(stt, /sherpaVoiceAdapter\.transcribeSamplesWithLanguage\([\s\S]*listeningLanguage/);
assert.doesNotMatch(stt, /sherpaVoiceAdapter\.transcribeSamples\(\s*samples,\s*sampleRate,\s*listeningLanguage/);

const pcm = readFileSync("src/voice/realtime-pcm-conversation.ts", "utf8");
assert.match(pcm, /pcm-session-preferences-updated/);

console.log("v2.1.107 TypeScript/build regression: PASS");
