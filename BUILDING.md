# Building My LOOI

## Toolchain

- Node.js 22
- pnpm 10 via Corepack
- JDK 17
- Android SDK 36
- Android build-tools 36.0.0

## Install and validate

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm exec tsc --noEmit
corepack pnpm test
corepack pnpm run motion:safety-test
corepack pnpm run ble:lifecycle-test
corepack pnpm run vosk:emergency-stop-test
corepack pnpm run motion:cliff-test
corepack pnpm run realtime:pcm-types-test
```

## Android release build

The build script stages the required Vosk command models, runs Expo prebuild, and assembles an ARM64 release APK:

```bash
bash scripts/build-android-apk.sh
```

Expected output:

```text
output/android/my-looi-arm64.apk
```

A release is not considered Android-build verified until Gradle exits with code 0 and prints `BUILD SUCCESSFUL`.

## Generated native projects

Do not commit generated `/android` or `/ios` trees. Native configuration belongs in `app.json`, local native modules, or Expo config plugins.

## API key

The OpenAI API key is configured inside the running app and stored with Android SecureStore. `.env` is only for optional development overrides and must never contain a production API key.
