#!/usr/bin/env bash
set -euo pipefail

# Build a standalone ARM64 Android release APK for My LOOI.
#
# Direct invocation is conservative and regenerates the root Android project.
# The generic scripts/build-my-looi.sh helper sets MY_LOOI_INCREMENTAL_BUILD=1
# after carrying safe generated state forward from the previous worktree.

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

required_signing_vars=(
  MY_LOOI_RELEASE_KEYSTORE
  MY_LOOI_RELEASE_STORE_PASSWORD
  MY_LOOI_RELEASE_KEY_ALIAS
  MY_LOOI_RELEASE_KEY_PASSWORD
)

# Prefer explicitly exported values. If any signing value is missing, load the
# persistent private signing environment created once on the build machine.
signing_env="${MY_LOOI_SIGNING_ENV:-$HOME/.config/my-looi/signing/release.env}"
missing_signing=0
for signing_var in "${required_signing_vars[@]}"; do
  if [[ -z "${!signing_var:-}" ]]; then
    missing_signing=1
    break
  fi
done
if (( missing_signing )) && [[ -f "$signing_env" ]]; then
  if find "$signing_env" -perm /077 -print -quit 2>/dev/null | grep -q .; then
    echo "Signing environment has insecure permissions: $signing_env" >&2
    echo "Run: chmod 600 '$signing_env'" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$signing_env"
  set +a
fi

for signing_var in "${required_signing_vars[@]}"; do
  if [[ -z "${!signing_var:-}" ]]; then
    echo "Missing required release-signing variable: $signing_var" >&2
    echo "Configure the permanent My LOOI release key once with:" >&2
    echo "  bash scripts/configure-release-signing.sh" >&2
    echo "or export the variables manually. See BUILDING.md." >&2
    exit 1
  fi
done

if [[ "$MY_LOOI_RELEASE_KEYSTORE" != /* ]]; then
  echo "MY_LOOI_RELEASE_KEYSTORE must be an absolute path." >&2
  exit 1
fi
if [[ ! -f "$MY_LOOI_RELEASE_KEYSTORE" ]]; then
  echo "Release keystore not found: $MY_LOOI_RELEASE_KEYSTORE" >&2
  exit 1
fi

node scripts/pnpm-lock-graph-audit.mjs
corepack pnpm install --frozen-lockfile
corepack pnpm exec tsc --noEmit
MY_LOOI_BUILD_ALLOW_LOCAL_ENV=1 corepack pnpm test

# Stage offline Vosk command models before Expo prebuild copies them into Android
# assets. Downloads are cached under ~/.cache/my-looi.
bash scripts/download-vosk-command-models.sh

incremental_build="${MY_LOOI_INCREMENTAL_BUILD:-0}"
if [[ "$incremental_build" == "1" && -d android && -f android/gradlew ]]; then
  echo "==> Expo prebuild: incremental (preserving root android/ build state)"
  corepack pnpm exec expo prebuild --platform android
else
  echo "==> Expo prebuild: clean"
  corepack pnpm exec expo prebuild --platform android --clean
fi

node scripts/apply-android-release-signing.mjs android/app/build.gradle

cd android
if [[ "$incremental_build" == "1" ]]; then
  ./gradlew --no-daemon --build-cache :app:assembleRelease
else
  ./gradlew --no-daemon :app:assembleRelease
fi
cd "$repo_dir"

mkdir -p output/android
version="$(node -p 'require("./package.json").version')"
generic_apk="output/android/my-looi-arm64.apk"
versioned_apk="output/android/my-looi-v${version}.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$generic_apk"
cp "$generic_apk" "$versioned_apk"
( cd output/android && sha256sum "$(basename "$versioned_apk")" > "$(basename "$versioned_apk").sha256" )

echo "APK: $repo_dir/$generic_apk"
echo "Release APK: $repo_dir/$versioned_apk"
echo "SHA-256: $repo_dir/${versioned_apk}.sha256"

apksigner="$(find "$android_sdk_dir/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner -print 2>/dev/null | sort -V | tail -1)"
if [[ -z "$apksigner" ]]; then
  echo "apksigner not found; refusing to publish an unverifiable release APK." >&2
  exit 1
fi

signer_output="$("$apksigner" verify --print-certs "$versioned_apk")"
if grep -Fq 'CN=Android Debug' <<<"$signer_output"; then
  echo "Release APK is still signed by Android Debug; refusing the build artifact." >&2
  exit 1
fi

echo "Signing certificate:"
printf '%s\n' "$signer_output" | sed -n \
  -e '/Signer #1 certificate DN:/p' \
  -e '/Signer #1 certificate SHA-256 digest:/p' \
  -e '/Signer #1 certificate SHA-1 digest:/p'
