# Changelog

Notable public changes to My LOOI are recorded here. Internal development-only iterations are intentionally omitted.

## 2.1.122 — 2026-08-28

- Fixed the public APK audit so bundled third-party Vosk graph vocabulary/FST data does not trigger false private-provenance failures.
- Kept secret, absolute-path, and first-party provenance checks strict.

## 2.1.121 — 2026-08-28

- Added a localized Android interface in Ukrainian, English and Russian.
- Added an independent interface-language selector to onboarding and Settings; listening and response languages remain separate preferences.
- Added locale-aware dates/times and localized navigation, status overlays, history, memory, diagnostics, updates, model/voice settings and primary setup flows.
- Removed unused Expo template UI that was not part of My LOOI.
- Preserved the accepted Realtime PCM audio, BLE, robot-command, memory, diagnostics Share and update behavior.

## 2.1.120 — 2026-08-28

- Finalized the standalone Android identity `io.github.razor79.mylooi` and permanent release-signing workflow.
- Kept diagnostics export through native Android Share and local SAF folders; removed the experimental direct Google Drive folder integration.
- Added verified GitHub Releases update/install support while preserving Android package/signature checks.
- Improved incremental Android builds and fixed cleanup of native modules retired by newer source releases.
