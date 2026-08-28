# Features

## Voice conversation

- App-owned Android `AudioRecord` capture at 16 kHz mono PCM16.
- Platform acoustic echo cancellation when available.
- Direct OpenAI Realtime WebSocket conversation path.
- App-owned 24 kHz PCM playback through Android `AudioTrack`.
- Natural barge-in with playback stop and accurate conversation truncation.
- Server VAD for conversational turn detection.
- Advanced WebRTC fallback retained for A/B and rollback testing.

## Languages

- Localized Android interface in Ukrainian, English and Russian.
- Interface language is independent from listening and response language preferences.
- First-run interface language follows the Android locale for Ukrainian/Russian and otherwise defaults to English.
- Ukrainian, English and Russian listening/response preferences.
- Change the default conversation language from the UI or by voice.
- Ask for a one-off translation or pronunciation without changing the default language.
- Use different interface, input and response languages when desired.

## OpenAI models and voices

- API-key-specific Realtime model discovery through the OpenAI Models API.
- Deprecated Realtime models are hidden from the normal selector.
- Current models are shown first; older supported models are visually separated.
- Human-readable approximate conversation cost per minute for known pricing tiers.
- Standard Realtime voice selection with preview.
- Model and voice selections are remembered locally.

## Memory and history

- Local SQLite conversation history.
- Durable local facts extracted from conversation.
- Bounded memory preload for Realtime sessions.
- Targeted local memory search tool for deeper recall.
- User-selected local backup folder for memory backup/restore.

## Robot integration

- Local BLE robot discovery and saved-device reconnect.
- Movement, head position, light, dock-state, and low-level transport support.
- Deterministic addressed physical voice commands in the primary Realtime PCM path; forward/backward motion stays time-bounded while Realtime owns the microphone.
- Emergency STOP command path.
- Movement deadman protection.
- Directional cliff-safety checks.

## Wake and local speech support

- Local wake/command pipeline.
- Vosk command models for Ukrainian, English and Russian.
- Sherpa-based local components used by the wake/safety pipeline.
- Shared microphone handoff prevents competing microphone owners during Realtime conversation.

## Privacy and diagnostics

- No required My LOOI backend service.
- API key stored in Android SecureStore.
- Hard sensitive-runtime suspend on background/screen-off.
- Diagnostic export is explicit and user-triggered.
- Microphone WAV recordings are not retained by normal diagnostics.
- Diagnostic ZIPs can be shared manually through the Android share sheet (including Google Drive when installed) or written to a persistently selected local Android Documents/SAF folder. My LOOI does not request direct Google Drive access, and there is no automatic diagnostic upload.

## App maintenance

- Manual update checks against the public `razor79/my-looi` GitHub Releases feed.
- APK downloads remain user-triggered; there is no background auto-update.
- Downloaded APKs are checked against the release SHA-256, package ID, monotonic Android version code, and the signing certificate of the installed app before installation is offered.
- Installation is handed to the Android system package installer and therefore remains subject to Android/managed-device policy.
