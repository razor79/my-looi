# Building My LOOI

## Toolchain

- Node.js 22
- pnpm 10 via Corepack
- JDK 17
- Android SDK 36
- Android build-tools 36.0.0

The standalone Android application ID is `io.github.razor79.mylooi`.

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

## Permanent Android release signing

Public/update-compatible My LOOI APKs must use one permanent private release key. The build intentionally refuses to produce a release artifact when the release-signing environment is missing, and it rejects an APK that is still signed with `CN=Android Debug`.

Create the key once on a trusted build machine:

```bash
bash scripts/create-release-keystore.sh
```

The default location is outside the repository:

```text
~/.config/my-looi/signing/my-looi-release.keystore
```

Back up this keystore and its passwords securely. **Never commit the keystore or passwords.** Losing or replacing the key prevents normal Android updates of installations signed with the original key.

For convenient local builds, save the signing configuration once outside the repository:

```bash
bash scripts/configure-release-signing.sh
```

The helper prompts for the keystore password without echoing it and writes:

```text
~/.config/my-looi/signing/release.env
```

with mode `0600`. The generated keystore normally uses the same password for the store and key, so pressing Enter at the separate key-password prompt reuses the store password. The build automatically loads this private file when the signing variables are not already exported. Explicit environment variables still work and are useful for CI or ephemeral build shells.

The values are injected into the generated Android project only after Expo prebuild. They are never source configuration and the private signing environment must never be committed.

To print the certificate fingerprints:

```bash
keytool -list -v \
  -keystore "$MY_LOOI_RELEASE_KEYSTORE" \
  -alias "$MY_LOOI_RELEASE_KEY_ALIAS"
```

Record both SHA-1 and SHA-256. These fingerprints identify the permanent release signing certificate and must remain stable for normal Android upgrades.

## Android release build

### Recommended archive helper

For repeated local builds, use `scripts/build-my-looi.sh` as the generic helper. Copy it once beside the versioned source archives (or invoke it from the source tree):

```bash
cp scripts/build-my-looi.sh ../build-my-looi.sh
cd ..
./build-my-looi.sh
```

Normal mode selects the newest source archive, verifies its checksum, carries forward safe generated state from the previous worktree, refreshes authoritative source from the archive, loads the private signing configuration, performs an incremental Expo prebuild, and reuses Gradle build outputs/cache where safe. Root `/android/` is generated state; nested `modules/*/android/` remains authoritative source and is always refreshed.

Use the clean control path when validating a release from regenerated native state:

```bash
./build-my-looi.sh --fresh
```

The helper keeps the worktree after success, copies the versioned APK and SHA-256 beside the source archives, and saves a full build log.

### Direct project build

`build-android-apk.sh` remains available directly. Direct invocation is conservative and uses clean Expo prebuild unless `MY_LOOI_INCREMENTAL_BUILD=1` is deliberately supplied:

```bash
bash scripts/build-android-apk.sh
```

Expected outputs include:

```text
output/android/my-looi-arm64.apk
output/android/my-looi-v<version>.apk
output/android/my-looi-v<version>.apk.sha256
```

The script verifies the final APK with Android `apksigner` and prints the signer DN, SHA-256, and SHA-1 fingerprints. A release is not considered Android-build verified until Gradle exits with code 0 and prints `BUILD SUCCESSFUL`.

## Generated native projects

Do not commit generated `/android` or `/ios` trees. Native configuration belongs in `app.json`, local native modules, or Expo config plugins.

## API key

The OpenAI API key is configured inside the running app and stored with Android SecureStore. `.env` is only for optional development overrides and must never contain a production API key.

### Incremental source deletion safety (v2.1.120)

Incremental builds preserve generated native caches only for modules that still
exist in the selected authoritative source archive. If a native module was
removed by a newer release, the helper removes that stale module directory
before the rsync refresh so excluded `android/build` or `.cxx` caches cannot
keep retired source visible in the next worktree.
