import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const forbiddenPaths = [
  "server",
  "src/server-api",
  "docker-compose.yml",
  `docker-compose.${["syn", "ology"].join("")}.yml`,
  `.env.${["syn", "ology"].join("")}.example`,
  "AGENTS.md",
  "CLAUDE.md",
  "progress.md",
  "todo.md",
  "pre-progress.md",
  "pre-todo.md",
  "looi-mvp-spec.md",
  "demo.jpg",
  "design",
  "assets/diagnostics",
];
for (const path of forbiddenPaths) assert.equal(existsSync(join(root, path)), false, `${path} must not be in the public tree`);

const allowLocalBuildEnv = process.env.MY_LOOI_BUILD_ALLOW_LOCAL_ENV === "1";
for (const name of readdirSync(root)) {
  if (name === ".env.example") continue;
  if (name === ".env" && allowLocalBuildEnv) continue;
  assert.equal(/^\.env(?:\.|$)/.test(name), false, `${name} is a local environment file and must not be public`);
}

const skipDirs = new Set(["node_modules", ".git", ".expo", "android", "ios", "output", ".build-assets"]);
const textExt = /\.(?:md|txt|json|js|mjs|cjs|ts|tsx|kt|java|sh|yml|yaml|toml|properties|gradle)$/i;
const forbiddenTermPatterns = [
  new RegExp(`\\b${["N", "AS"].join("")}\\b`, "i"),
  new RegExp(["Syn", "ology"].join(""), "i"),
  new RegExp(["JA", "DX"].join(""), "i"),
  new RegExp(["decom", "pil"].join(""), "i"),
  new RegExp(["reverse", "engineering"].join("[ -]"), "i"),
  new RegExp(["official", "LOOI"].join(" "), "i"),
  new RegExp(["original", "LOOI"].join(" "), "i"),
  new RegExp(["Tangible", "Future"].join(""), "i"),
  new RegExp(["sooper", "chargeforbots"].join(""), "i"),
  new RegExp(["splatty", "doesstuff"].join(""), "i"),
];
const secretLike = /\bsk-[A-Za-z0-9_-]{20,}\b/;
const absoluteUserPath = /(?:^|["'\s])(?:\/home\/[^/\s"']+|\/Users\/[^/\s"']+)/m;
const emailLike = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const ipv4Like = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const macLike = /\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi;
const suspiciousVersionMarker = ["2", "9", "0"].join(".");
const publicEnglishDocs = new Set([
  "README.md",
  "FEATURES.md",
  "BUILDING.md",
  "PRIVACY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/architecture.md",
  "docs/robot-ble.md",
  "docs/ui.md",
  "packages/looi-sdk/README.md",
]);

function isAllowedVersionMarkerOccurrence(rel, line) {
  if (rel !== "pnpm-lock.yaml") return false;
  return /(?:yaml@2\.9\.0|yaml:\s*2\.9\.0|yaml\(.*2\.9\.0)/.test(line);
}

function isAllowedIpv4(value) {
  return value === "127.0.0.1" || value === "0.0.0.0";
}

function isAllowedMac(value) {
  return value.toUpperCase() === "02:00:00:00:00:01";
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) { walk(path); continue; }
    if (!textExt.test(name) && name !== ".env.example" && name !== ".gitignore") continue;
    const rel = relative(root, path);
    const content = readFileSync(path, "utf8");
    for (const pattern of forbiddenTermPatterns) {
      assert.doesNotMatch(content, pattern, `${rel} contains retired/private provenance term`);
    }
    if (content.includes(suspiciousVersionMarker)) {
      const badLine = content
        .split(/\r?\n/)
        .find((line) => line.includes(suspiciousVersionMarker) && !isAllowedVersionMarkerOccurrence(rel, line));
      assert.equal(badLine, undefined, `${rel} contains suspicious private provenance version marker ${suspiciousVersionMarker}`);
    }
    assert.doesNotMatch(content, secretLike, `${rel} contains a secret-like key literal`);
    assert.doesNotMatch(content, absoluteUserPath, `${rel} contains a user-specific absolute path`);
    assert.doesNotMatch(content, emailLike, `${rel} contains an email address; review before publication`);
    const ipv4 = content.match(ipv4Like) ?? [];
    const badIpv4 = ipv4.find((value) => !isAllowedIpv4(value));
    assert.equal(badIpv4, undefined, `${rel} contains a non-loopback IPv4 address: ${badIpv4}`);
    const macs = content.match(macLike) ?? [];
    const badMac = macs.find((value) => !isAllowedMac(value));
    assert.equal(badMac, undefined, `${rel} contains a device-specific MAC address: ${badMac}`);
    if (publicEnglishDocs.has(rel)) {
      assert.doesNotMatch(content, /[\u0400-\u04ff\u4e00-\u9fff]/u, `${rel} must remain English-only public documentation`);
    }
  }
}
walk(root);
console.log("Public repository audit: PASS");
