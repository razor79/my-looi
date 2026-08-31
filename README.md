# My LOOI

**My LOOI** is an unofficial, local-first Android companion app for the LOOI robot. It focuses on natural realtime voice conversation, local memory, multilingual interaction, and reliable BLE robot control.

The project is community-developed and is not affiliated with or endorsed by the robot manufacturer.

## Highlights

- **Realtime PCM voice** with app-owned microphone capture and playback.
- **Natural interruption / barge-in**: speaking while LOOI talks stops playback and truncates the unheard response correctly.
- **Localized Android interface** in Ukrainian, English and Russian, with an independent interface-language preference.
- **Multilingual conversation** in Ukrainian, English and Russian, including independent listening/response preferences, voice-requested language switching, and one-off translation/pronunciation requests.
- **Dynamic OpenAI Realtime model selection** based on the models available to the user's API key.
- **Realtime voice selection with preview**, persisted locally.
- **Local memory and conversation history** stored in SQLite on the Android device.
- **Local wake and safety command pipeline** for hands-free use.
- **BLE reconnect and deterministic robot control** with voice-addressed movement and safety guardrails.
- **Natural idle and conversational micro-movements** with four intensity levels, conservative head gestures while processing/speaking, and optional tiny safety-bounded idle body pivots; actual user speech and explicit commands always take priority.
- **Hard privacy suspend** when the app is backgrounded or the screen is off.
- **No companion backend required** for normal operation.
- **Manual diagnostics export** through the Android share sheet (including Google Drive when installed) or a persistently selected local Android Documents/SAF folder. My LOOI does not request direct Google Drive access.
- **Manual GitHub Releases update flow** with APK checksum/package/version/signing-certificate verification before Android installation.

See [USER_GUIDE.md](USER_GUIDE.md) for setup, built-in voice-command examples and everyday use, [FEATURES.md](FEATURES.md) for a fuller feature list, [CHANGELOG.md](CHANGELOG.md) for release notes, and [docs/architecture.md](docs/architecture.md) for the runtime architecture.

## Requirements

- Node.js 22
- pnpm 10 via Corepack
- JDK 17
- Android SDK 36
- Android build-tools 36.0.0
- ARM64 Android device for final device acceptance
- OpenAI API key for Realtime conversation

## Quick start

```bash
corepack enable
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm exec tsc --noEmit
corepack pnpm test
```

For an Android release build, see [BUILDING.md](BUILDING.md). Repeated archive builds can use the reusable `scripts/build-my-looi.sh` helper; normal mode preserves safe incremental state and `--fresh` performs a clean control build. Before publishing source or APK files, follow [docs/releasing.md](docs/releasing.md).

The OpenAI API key is entered inside the app and stored with Android SecureStore. Do not place API keys in `.env` or source files. The Android application ID for the standalone My LOOI app is `io.github.razor79.mylooi`.

## Repository structure

```text
app/        Expo Router screens
src/        application runtime
modules/    local native Expo modules
packages/   local workspace packages
plugins/    Expo config plugins
scripts/    build, audit, and regression tooling
docs/       public architecture and device documentation
```

## Privacy

My LOOI keeps conversation history and durable memory locally. Audio is sent to OpenAI only while a Realtime conversation is active. Screen-off/background transitions stop sensitive runtime activity. See [PRIVACY.md](PRIVACY.md).

## Safety

Robot movement code includes emergency STOP handling, movement deadman protection, BLE lifecycle checks, and directional cliff-safety guardrails. Idle body micro-movements use the same bounded movement/sensor interlocks and never use continuous autonomous translation. Conversational motion is head-only and is suppressed while the user is speaking. Any changes to movement or BLE behavior should run the dedicated safety regressions before release.

## Origins and evolution

My LOOI began as a fork of [GrinZero/super-looi](https://github.com/GrinZero/super-looi), an experimental LOOI Robot project that combined a React Native / Expo app, a local backend, memory and perception services, and an early TypeScript BLE SDK.

Since then, the project has diverged substantially through repeated development and testing on a physical LOOI robot. The application gradually moved away from the original client/server architecture toward a standalone Android companion focused on reliable realtime interaction.

Major steps in that evolution included:

- moving normal conversation to direct OpenAI Realtime;
- replacing the main voice path with app-owned PCM microphone capture and playback, with interruption and barge-in support;
- moving persistent memory and conversation history onto the Android device with SQLite;
- removing the required companion backend from normal operation;
- developing local wake, emergency-command, BLE reconnect, movement safety, and privacy lifecycle behavior;
- adding Ukrainian, English and Russian interface localization and conversation, independent persistent UI/listening/response language preferences, selectable Realtime models, and selectable voices.

Because the current architecture and product goals differ substantially from the original fork, My LOOI is now maintained as a standalone project with a new public Git history, while preserving acknowledgement of the projects that helped it get started.

## License and acknowledgements

My LOOI is released under the MIT License.

It originated from the MIT-licensed [GrinZero/super-looi](https://github.com/GrinZero/super-looi) project.

Third-party components and model assets retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
