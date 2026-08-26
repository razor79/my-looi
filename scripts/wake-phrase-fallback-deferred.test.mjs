import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(import.meta.url);

if (typeof vm.SourceTextModule !== "function") {
  const child = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", scriptPath, "--vm-child"],
    { encoding: "utf8" }
  );
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sourcePath = fileURLToPath(
  new URL("../src/voice/wake-phrase-fallback.ts", import.meta.url)
);
const source = readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
}).outputText;

const diagnosticEvents = [];
let recognize = async () => noMatchRecognition();
const context = vm.createContext({
  console: {
    log() {},
    warn() {},
    error() {},
  },
  setTimeout,
  clearTimeout,
});

const diagnosticsModule = new vm.SyntheticModule(
  ["recordDiagnosticEvent"],
  function initializeDiagnosticsModule() {
    this.setExport("recordDiagnosticEvent", (category, event, details = {}) => {
      diagnosticEvents.push({ category, event, details });
    });
  },
  { context }
);
const recognizerModule = new vm.SyntheticModule(
  ["recognizeWakePhraseSamples"],
  function initializeRecognizerModule() {
    this.setExport("recognizeWakePhraseSamples", (...args) => recognize(...args));
  },
  { context }
);
const fallbackModule = new vm.SourceTextModule(transpiled, {
  context,
  identifier: sourcePath,
});

await fallbackModule.link((specifier) => {
  if (specifier === "../diagnostics/diagnostic-log") return diagnosticsModule;
  if (specifier === "./wake-phrase-recognizer") return recognizerModule;
  throw new Error(`Unexpected wake fallback test import: ${specifier}`);
});
await fallbackModule.evaluate();

const { WakePhraseFallback } = fallbackModule.namespace;

await testUnmatchedInferenceReplaysDeferredWake();
await testMatchedInferenceKeepsDeferredAudioAsCommandPreroll();
await testRuntimeResetDoesNotDropNewWake();
await testWaitForIdleIncludesDeferredReplay();

console.log("Wake phrase deferred PCM regression tests passed");

async function testUnmatchedInferenceReplaysDeferredWake() {
  diagnosticEvents.length = 0;
  const firstInference = createDeferred();
  let recognitionCalls = 0;
  recognize = async () => {
    recognitionCalls += 1;
    if (recognitionCalls === 1) {
      await firstInference.promise;
      return noMatchRecognition();
    }
    return matchedRecognition();
  };

  const fallback = new WakePhraseFallback();
  const detections = [];
  const onDetected = (detection) => detections.push(detection);
  fallback.start();
  feedSpeechSegment(fallback, onDetected, 0.08);
  await waitUntil(() => recognitionCalls === 1, "first fallback inference did not start");

  // This complete wake phrase arrives while Whisper is still busy with the
  // previous non-wake segment. It must be replayed after that miss.
  feedSpeechSegment(fallback, onDetected, 0.12);
  // Keep the wake at the beginning of more than six seconds of deferred PCM.
  // This guards against reusing the bounded command pre-roll as the replay
  // buffer and silently dropping an early deferred wake phrase.
  for (let index = 0; index < 70; index += 1) {
    fallback.acceptSamples(new Array(1600).fill(0), 16000, onDetected);
  }
  firstInference.resolve();

  await waitUntil(() => recognitionCalls === 2, "deferred PCM was not inferred");
  await waitUntil(() => detections.length === 1, "deferred wake was not detected");
  assert.equal(detections[0].phraseId, "ru");
  assert.ok(detections[0].wakeSegmentSamples.length > 0);
  assert.ok(
    diagnosticEvents.some(
      ({ event, details }) =>
        event === "wake-inference-finished" &&
        details.outcome === "unmatched" &&
        Number.isFinite(details.inferenceDurationMs) &&
        Number.isFinite(details.busyDurationMs) &&
        details.deferredDurationMs > 6000
    ),
    "busy, inference, and deferred durations were not logged"
  );
  assert.ok(
    diagnosticEvents.some(({ event }) => event === "wake-deferred-replay"),
    "deferred replay was not logged"
  );
  assertLogsContainNoRawAudio();
  fallback.stop();
}

async function testMatchedInferenceKeepsDeferredAudioAsCommandPreroll() {
  diagnosticEvents.length = 0;
  const inference = createDeferred();
  recognize = async () => {
    await inference.promise;
    return matchedRecognition();
  };

  const fallback = new WakePhraseFallback();
  const detections = [];
  const onDetected = (detection) => detections.push(detection);
  fallback.start();
  feedSpeechSegment(fallback, onDetected, 0.08);

  const commandPreroll = new Array(3200).fill(0.07);
  fallback.acceptSamples(commandPreroll, 16000, onDetected);
  inference.resolve();

  await waitUntil(() => detections.length === 1, "matched wake was not detected");
  assert.deepEqual(Array.from(detections[0].commandPrerollSamples), commandPreroll);
  assert.equal(
    diagnosticEvents.some(({ event }) => event === "wake-deferred-replay"),
    false,
    "matched inference must not replay command pre-roll as another wake segment"
  );
  assertLogsContainNoRawAudio();
  fallback.stop();
}

async function testRuntimeResetDoesNotDropNewWake() {
  diagnosticEvents.length = 0;
  const oldInference = createDeferred();
  let recognitionCalls = 0;
  recognize = async () => {
    recognitionCalls += 1;
    if (recognitionCalls === 1) {
      await oldInference.promise;
      return noMatchRecognition();
    }
    return matchedRecognition();
  };

  const fallback = new WakePhraseFallback();
  const detections = [];
  const onDetected = (detection) => detections.push(detection);
  fallback.start();
  feedSpeechSegment(fallback, onDetected, 0.08);
  await waitUntil(() => recognitionCalls === 1, "old inference did not start");

  // Diagnostics and app resume call start/reset while an old native inference
  // may still be leaving Whisper. New-generation microphone audio must wait
  // and replay instead of being discarded during that stale promise.
  fallback.start();
  feedSpeechSegment(fallback, onDetected, 0.12);
  oldInference.resolve();

  await waitUntil(() => recognitionCalls === 2, "post-reset wake was not inferred");
  await waitUntil(() => detections.length === 1, "post-reset wake was not detected");
  assert.ok(
    diagnosticEvents.some(
      ({ event, details }) =>
        event === "wake-inference-finished" && details.outcome === "stale"
    ),
    "stale inference outcome was not logged"
  );
  fallback.stop();
}

async function testWaitForIdleIncludesDeferredReplay() {
  const firstInference = createDeferred();
  const replayInference = createDeferred();
  let recognitionCalls = 0;
  recognize = async () => {
    recognitionCalls += 1;
    if (recognitionCalls === 1) await firstInference.promise;
    if (recognitionCalls === 2) await replayInference.promise;
    return noMatchRecognition();
  };

  const fallback = new WakePhraseFallback();
  const onDetected = () => undefined;
  fallback.start();
  feedSpeechSegment(fallback, onDetected, 0.08);
  await waitUntil(() => recognitionCalls === 1, "first idle-wait inference did not start");
  feedSpeechSegment(fallback, onDetected, 0.12);

  let idleResolved = false;
  const idlePromise = fallback.waitForIdle().then(() => {
    idleResolved = true;
  });
  firstInference.resolve();
  await waitUntil(() => recognitionCalls === 2, "idle wait did not include deferred replay");
  assert.equal(idleResolved, false, "waitForIdle returned while replay inference was active");
  replayInference.resolve();
  await idlePromise;
  assert.equal(idleResolved, true);
  fallback.stop();
}

function feedSpeechSegment(fallback, onDetected, amplitude) {
  const chunkSize = 1600;
  for (let index = 0; index < 6; index += 1) {
    fallback.acceptSamples(new Array(chunkSize).fill(amplitude), 16000, onDetected);
  }
  for (let index = 0; index < 6; index += 1) {
    fallback.acceptSamples(new Array(chunkSize).fill(0), 16000, onDetected);
  }
}

function noMatchRecognition() {
  return {
    match: null,
    transcript: "обычная речь",
    language: "ru",
    attempts: [{ language: "ru", transcript: "обычная речь", matched: false }],
  };
}

function matchedRecognition() {
  return {
    match: {
      id: "ru",
      displayText: "Привет, Луи",
      commandSuffix: "",
      hasCommandSuffix: false,
    },
    transcript: "Привет, Луи",
    language: "ru",
    attempts: [{ language: "ru", transcript: "Привет, Луи", matched: true }],
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate, failureMessage) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(failureMessage);
}

function assertLogsContainNoRawAudio() {
  for (const entry of diagnosticEvents) {
    for (const [key, value] of Object.entries(entry.details)) {
      assert.doesNotMatch(key, /sample|audio|pcm/i);
      assert.equal(Array.isArray(value), false, `${entry.event}.${key} logged an array`);
    }
  }
}
