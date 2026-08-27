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

- Ukrainian, English and Russian listening/response preferences.
- Change the default conversation language from the UI or by voice.
- Ask for a one-off translation or pronunciation without changing the default language.
- Use different input and response languages when desired.

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
