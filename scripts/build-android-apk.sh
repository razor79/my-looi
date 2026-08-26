#!/usr/bin/env bash
set -euo pipefail

# Build a standalone ARM64 Android release APK for My LOOI.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if ! command -v java >/dev/null 2>&1; then
  echo "Java is missing. Install JDK 17 before building." >&2
  exit 1
fi

java_major="$(java -version 2>&1 | sed -n '1s/.*version "\([0-9][0-9]*\).*/\1/p')"
if [[ "$java_major" != "17" ]]; then
  echo "JDK 17 is required; detected Java ${java_major:-unknown}." >&2
  exit 1
fi

android_sdk_dir="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
if [[ ! -d "$android_sdk_dir/platforms" ]] || [[ ! -d "$android_sdk_dir/build-tools" ]]; then
  echo "Android SDK is missing or incomplete at: $android_sdk_dir" >&2
  echo "Install Android Studio SDK components, then set ANDROID_SDK_ROOT or ANDROID_HOME." >&2
  exit 1
fi

export ANDROID_HOME="$android_sdk_dir"
export ANDROID_SDK_ROOT="$android_sdk_dir"

node scripts/pnpm-lock-graph-audit.mjs
corepack pnpm install --frozen-lockfile
corepack pnpm exec tsc --noEmit
corepack pnpm test

# v1.1.35: stage offline Vosk command models before Expo prebuild copies them
# into Android assets. Downloads are cached under ~/.cache/my-looi.
bash scripts/download-vosk-command-models.sh

corepack pnpm exec expo prebuild --platform android --clean

cd android
./gradlew --no-daemon :app:assembleRelease
cd "$repo_dir"

mkdir -p output/android
cp android/app/build/outputs/apk/release/app-release.apk output/android/my-looi-arm64.apk
echo "APK: $repo_dir/output/android/my-looi-arm64.apk"
