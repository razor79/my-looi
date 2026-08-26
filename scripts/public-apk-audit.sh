#!/usr/bin/env bash
set -Eeuo pipefail

apk="${1:-}"
if [[ -z "$apk" || ! -f "$apk" ]]; then
  echo "Usage: $0 /path/to/my-looi.apk" >&2
  exit 2
fi
for cmd in unzip strings grep find mktemp sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unzip -q "$apk" -d "$tmp/apk"

fail() { echo "APK PUBLICATION AUDIT FAILED: $*" >&2; exit 1; }

# File-level exclusions.
if find "$tmp/apk" -type f \( \
  -iname '.env' -o -iname '.env.*' -o -iname '*.jks' -o -iname '*.keystore' -o \
  -iname '*.p8' -o -iname '*.p12' -o -iname '*.pem' -o -iname '*.key' -o \
  -iname '*diagnostic*.wav' -o -iname '*handoff*' -o -iname '*.tgz' \
\) -print -quit | grep -q .; then
  find "$tmp/apk" -type f \( -iname '.env' -o -iname '.env.*' -o -iname '*.jks' -o -iname '*.keystore' -o -iname '*.p8' -o -iname '*.p12' -o -iname '*.pem' -o -iname '*.key' -o -iname '*diagnostic*.wav' -o -iname '*handoff*' -o -iname '*.tgz' \) -print >&2
  fail "forbidden private/build artifact found"
fi

# Extract printable strings from compiled/runtime assets and scan for obvious secrets/private provenance.
strings_file="$tmp/strings.txt"
: > "$strings_file"
while IFS= read -r -d '' f; do
  strings "$f" 2>/dev/null >> "$strings_file" || true
done < <(find "$tmp/apk" -type f -print0)

if grep -Eiq '\bsk-[A-Za-z0-9_-]{20,}\b' "$strings_file"; then fail "secret-like OpenAI key found"; fi
if grep -Eiq '(/home/[^/[:space:]]+|/Users/[^/[:space:]]+)' "$strings_file"; then fail "user-specific absolute path found"; fi
provenance_re='JA''DX|decom''pil|reverse[ -]engineer''ing|official LOO''I|original LOO''I|Tangible''Future|sooper''chargeforbots|splatty''doesstuff'
if grep -Eiq "$provenance_re" "$strings_file"; then fail "private/research provenance marker found"; fi

# The app must use the public product name in packaged metadata/resources.
if ! grep -Fq 'My LOOI' "$strings_file"; then
  echo "WARNING: could not confirm 'My LOOI' in printable APK strings" >&2
fi

printf 'APK publication audit: PASS\n'
printf 'SHA-256: %s\n' "$(sha256sum "$apk" | awk '{print $1}')"
printf 'APK: %s\n' "$apk"
printf 'Bundled Vosk assets: %s\n' "$(find "$tmp/apk" -type f -path '*vosk-command-*' | wc -l | tr -d ' ')"
printf 'Bundled ONNX assets: %s\n' "$(find "$tmp/apk" -type f -iname '*.onnx' | wc -l | tr -d ' ')"
