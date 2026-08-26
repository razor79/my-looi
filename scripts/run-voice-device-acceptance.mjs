#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const rootDir = process.cwd();
const outputDir = join(rootDir, "output", "voice-device-acceptance");
mkdirSync(outputDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = join(outputDir, `${timestamp}.log`);
const logStream = createWriteStream(logPath, { flags: "a" });

const deviceName = process.env.LOOI_ACCEPTANCE_DEVICE || process.argv.slice(2).join(" ");
const repeat = process.env.LOOI_ACCEPTANCE_REPEAT || "3";
const enrollOnBoot = process.env.LOOI_ACCEPTANCE_ENROLL_ON_BOOT === "1";

function log(line = "") {
  const text = `${line}\n`;
  process.stdout.write(text);
  logStream.write(text);
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function listPhysicalDevices() {
  const result = runCapture("xcrun", ["xctrace", "list", "devices"]);
  if (result.status !== 0) {
    throw new Error(`Unable to list iOS devices:\n${result.stderr || result.stdout}`);
  }

  const lines = result.stdout.split(/\r?\n/);
  const devices = [];
  let section = "";
  for (const line of lines) {
    if (line.startsWith("== ")) {
      section = line;
      continue;
    }
    if (section !== "== Devices ==") continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("MacBook") || trimmed.includes("Mac ")) continue;
    devices.push(trimmed);
  }
  return devices;
}

function spawnLogged(label, command, args, options = {}) {
  log(`\n[${label}] ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: rootDir,
    env: options.env || process.env,
    shell: false,
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    logStream.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    logStream.write(text);
  });

  return child;
}

function waitForServerReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for server to listen on port 8080"));
    }, 30_000);

    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes("Server listening") || text.includes("LOOI Server running")) {
        clearTimeout(timeout);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before becoming ready: ${code}`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command exited with code ${code}`));
    });
    child.once("error", reject);
  });
}

function stopChild(child) {
  if (!child || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGINT");
  });
}

function printUsageAndExit(devices) {
  log("No physical iOS device was selected.");
  log("");
  log("Connect a device, trust this Mac, then run one of:");
  log("  pnpm voice:accept-device -- \"<physical device name>\"");
  log("  LOOI_ACCEPTANCE_DEVICE=\"<physical device name>\" pnpm voice:accept-device");
  log("");
  if (devices.length > 0) {
    log("Detected physical devices:");
    for (const device of devices) {
      log(`  - ${device}`);
    }
  } else {
    log("Detected physical devices: none");
  }
  log("");
  log(`Log file: ${logPath}`);
  process.exit(2);
}

async function main() {
  log(`# Voice Device Acceptance ${new Date().toISOString()}`);
  log(`Log file: ${logPath}`);

  const devices = listPhysicalDevices();
  if (!deviceName) {
    printUsageAndExit(devices);
  }

  if (!devices.some((device) => device.includes(deviceName))) {
    log(`Selected device was not found: ${deviceName}`);
    printUsageAndExit(devices);
  }

  let server;
  try {
    server = spawnLogged("server", "pnpm", ["--dir", "server", "dev"]);
    await waitForServerReady(server);

    const env = {
      ...process.env,
      EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE: "1",
      EXPO_PUBLIC_LOOI_RUN_LIVE_VOICE_ACCEPTANCE_ON_BOOT: "1",
      EXPO_PUBLIC_LOOI_LIVE_VOICE_ACCEPTANCE_REPEAT: repeat,
    };
    if (enrollOnBoot) {
      env.EXPO_PUBLIC_LOOI_ENROLL_OWNER_ON_BOOT = "1";
    }

    log("");
    log("Speak a short normal request after each live acceptance prompt.");
    log("Acceptance requires each trace to end with assistant and cleanup.");
    log("");

    const expo = spawnLogged(
      "expo",
      "pnpm",
      ["exec", "expo", "run:ios", "--device", deviceName],
      { env }
    );
    await waitForExit(expo);
  } finally {
    await stopChild(server);
    const portCheck = runCapture("lsof", ["-nP", "-iTCP:8080", "-sTCP:LISTEN"]);
    if (portCheck.stdout.trim()) {
      log("\nPort 8080 still has a listener:");
      log(portCheck.stdout.trim());
    } else {
      log("\nPort 8080 is clear.");
    }
    logStream.end();
  }
}

main().catch((error) => {
  log("");
  log(error instanceof Error ? error.message : String(error));
  logStream.end();
  process.exitCode = 1;
});
