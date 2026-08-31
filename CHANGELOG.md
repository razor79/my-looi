# Changelog

## 2.1.136 — 2026-08-31

- Rolled the OpenAI Realtime server-VAD threshold back from the aggressive 0.10 experiment to 0.15 after physical testing showed 0.10 still did not provide reliable far-field conversation. The protected 500 ms prefix padding, 1000 ms silence duration and `far_field` input noise reduction remain unchanged.
- Added a controlled 2× digital gain only on the app-owned Realtime uplink after the existing Android `VOICE_COMMUNICATION` / platform-AEC capture, with hard clipping protection and clipped-sample diagnostics. Native 16 kHz capture, AEC, 16→24 kHz resampling topology, 24 kHz `AudioTrack`, local wake/STT, barge-in and microphone ownership remain unchanged.
- Made Camera Attention eye gaze visibly stronger so small face offsets can be acknowledged on-screen before head/body correction thresholds are reached.
- Added head-channel ownership between Camera Attention and low-priority ambient character gestures: while a face is actively tracked, new ambient head gestures are held, while safe ambient body peeks remain available. Existing bounded face-search/recenter and no-forward policy are unchanged.
- Replaced the legacy Fringe visual with a playful Cap while retaining the stored preference ID for migration compatibility, and added Cowboy and Bandana face styles with more varied eye/mouth geometry.
- Made the Custom phrases settings block collapsed by default, with its configured phrase count in the summary; per-command phrase editors and the non-moving parser test remain available inside it.

## 2.1.135 — 2026-08-31

- Lowered only the OpenAI Realtime server-VAD threshold from 0.15 to 0.10 after repeated fresh-launch distance tests showed clearly audible uplink energy could still fail to open a speech turn at roughly 1–1.5 m.
- Added 500 ms aggregate uplink diagnostics (`windowRms`, `maxChunkRms`, frame/chunk counts and sequence range) so future physical tests capture the actual speech-energy window instead of a single sampled 40 ms chunk.
- Kept the protected 500 ms VAD prefix padding, 1000 ms silence duration, far-field input noise reduction, VOICE_COMMUNICATION capture, platform AEC, 16→24 kHz PCM resampling, AudioTrack playback, barge-in, BLE and movement safety behavior unchanged.
- Did not add a cold-start microphone recycle: a later clean-launch test reproduced the distance problem after normal first-attempt audio stabilization, so lifecycle recovery is no longer the leading explanation.
- Camera Attention remains unchanged from v2.1.133.

## 2.1.134 — 2026-08-31

- Lowered only the OpenAI Realtime server-VAD threshold from 0.20 to 0.15 after a controlled far-field test showed quiet speech around 1–1.5 m could remain below activation while closer speech remained reliable.
- Strengthened robot-vs-human identity instructions with explicit vocative examples so robot names/aliases such as Луи, LOOI, Бобик, Макс/Max and Робот/Robot are never treated as the human user's name.
- Kept the protected 500 ms VAD prefix padding, 1000 ms silence duration, far-field input noise reduction, VOICE_COMMUNICATION capture, platform AEC, 16→24 kHz PCM resampling, AudioTrack playback, barge-in, BLE and movement safety behavior unchanged.
- Camera Attention remains unchanged from v2.1.133.

Notable public changes to My LOOI are recorded here. Internal development-only iterations are intentionally omitted.

## 2.1.133 — 2026-08-31

- Coordinated Camera Attention search/recenter with ambient head motion so low-priority conversational gestures no longer start during a bounded social correction.
- Added a shared social-body cooldown and a post-pivot settle window; face smoothing is re-seeded after the camera physically moves instead of blending stale pre-turn coordinates into the new pose.
- Reduced face search to at most two calm bounded pivots per attempt, biased toward the last known face direction, and prevented immediate re-search after a transient face loss.
- Raw Realtime VAD can warm the local camera and visual gaze, but physical search/recenter now waits for a confirmed interaction turn rather than reacting to arbitrary nearby speech.
- Added structured local diagnostics for social pivots/head corrections (reason, normalized face coordinates, stable-frame count and face age only; no frames/images).
- Existing idle ambient motion, protected Realtime PCM/AEC, emergency STOP, BLE, cliff and deadman behavior remain unchanged.

## 2.1.132 — 2026-08-31

- Stabilized local Camera Attention after physical/ADB testing: native camera start is now single-flight and stale async starts cannot re-open the camera after a stop.
- Reduced camera load on supported devices by requesting a 15 fps analysis stream while keeping the verified 640×480 local YUV path.
- Tightened native cleanup: stopped camera sessions close their ML Kit detector, terminate the camera thread, and preserve ownership of any in-flight image until ML Kit completion.
- Replaced rapid face-search/recenter motion with a three-step bounded search, smoothed face coordinates, stable-frame requirements, wider hysteresis and much longer body/head cooldowns.
- Head correction no longer queues commands while the robot is disconnected and no longer repeatedly re-sends the same non-center position.
- Existing ambient motion remains independent; Camera Attention still activates only around social interaction and never adds autonomous forward/backward travel.
- No intentional changes to the protected Realtime PCM/AEC, emergency STOP, BLE, cliff or deadman paths.

## 2.1.131 — 2026-08-31

- Fixed Android Kotlin compilation for the new local face-attention Expo module by using unambiguous coroutine function references for zero-argument async functions.
- No Camera Attention behavior, motion policy, privacy behavior, or protected Realtime/BLE/safety path was changed.

## 2.1.130 — 2026-08-30

- Added opt-in local-only Camera Attention, disabled by default and permission-gated in Settings.
- During an active voice interaction, the front camera uses a bundled on-device ML Kit face detector; frames stay in memory and are never saved, uploaded, or included in diagnostics.
- Added social gaze so the on-screen eyes can follow a visible face while preserving the existing face styles, palettes, blinking, and conversational animation.
- Added small bounded body recentering and up/center/down head correction while LOOI is responding, plus a finite left/right search sweep when an addressed interaction begins but no face is initially visible.
- Social body corrections reuse the existing calibrated cliff/near-edge interlocks and bounded BLE movement primitive; no autonomous forward/backward translation is added.
- Existing ambient motion is intentionally preserved: Camera Attention only corrects when needed and does not turn LOOI into a permanent face-tracking mode.
- Camera capture stops when the interaction grace period ends, the feature is disabled, the robot sleeps, or the app backgrounds.

## 2.1.129 — 2026-08-30

- Reworked face personalization after physical feedback: removed the large oval face glow/silhouette that made some skins feel uncanny.
- Split appearance into independent Face Style and Color Palette controls so any geometry can use any offered palette.
- Added five face styles: Classic, Soft, Playful, Fringe and Sharp, varying eye proportions/tilt, mouth shape, lashes, brows and a light three-stroke fringe.
- Added five palettes: Cyan, Rose, Lime, Amber and Violet, with compact color swatches in Settings.
- Kept appearance controls collapsed/accordion-style to avoid another long Settings wall.
- Added migration from the v2.1.127-v2.1.128 combined faceSkin presets to equivalent style/palette choices.
- No intentional changes to Realtime PCM/AEC, BLE, deterministic physical commands, natural-motion scheduling, cliff/deadman safety, sleep/wake or custom robot-name behavior.

## 2.1.128 — 2026-08-30

- Fixed the v2.1.127 TypeScript build failure in `RobotFace`: the selected skin already supplies the mouth color dynamically, so the stale removed `EYE_COLOR` style reference was deleted.
- Added a regression preventing the legacy undefined `EYE_COLOR` reference from returning.
- No intended runtime changes to Realtime PCM/AEC, BLE, movement, cliff/deadman safety, sleep, custom commands or skin behavior.

## 2.1.127 — 2026-08-30

- Fixed robot-name identity handling in Realtime: normal aliases and hidden STT recognition variants are explicitly names of the robot, never the user, and the assistant must not correct an accepted alias back to the primary name unless asked about naming.
- Added recognition aliases to the Realtime transcription prompt so custom names such as “Бобик” are expected by STT as robot addresses.
- Added four selectable face skins — Classic, Soft, Pixel and Spark — with different eye shapes, mouth styling and color palettes; the setting is collapsed and affects presentation only.
- Made deterministic custom-phrase parsing use the live preference snapshot explicitly in Settings and Realtime PCM, with an unambiguous cross-language fallback for exact addressed user phrases.
- Added addressed “спать / спати” as natural sleep wording while preserving the explicit-address requirement and the existing sleep execution path.
- Preserved the accepted Realtime PCM/AEC, BLE, movement, cliff, deadman and emergency STOP execution paths.

## 2.1.126 — 2026-08-29

- Fixed a stale historical Realtime physical-command regression that rejected the v2.1.125 configured deterministic parser solely because it now receives a second configuration argument.
- Made the v2.1.125 feature regression forward-compatible with later patch releases while preserving all physical-command safety assertions.
- No runtime movement, audio, BLE, sleep, or voice-command behavior changed from v2.1.125.

## 2.1.125 — 2026-08-29

- Added a collapsible Voice Commands settings section with a user-defined primary robot name, normal address aliases and tucked-away STT recognition variants.
- Added per-language custom deterministic phrases for emergency stop, forward/backward movement, left/right turns, turn-around, nod, dance and sleep.
- Preserved the proven movement parser/execution path: custom wheel commands still require an utterance-initial robot address, while built-in STOP / стоп remain universal emergency aliases.
- Added conflict/basic-safety checks and a non-executing parser test in Settings so command matching can be checked without moving the robot.
- Collapsed the long named-voice list behind the currently selected voice.
- Increased idle body micro-pivot calibration from the ineffective ~90–130 ms range to 180–230 ms while retaining the existing cliff/near-edge interlocks and bounded-motion primitive.
- Made deep sleep visually explicit with closed eyes + Zzz state and changed manual wake to a single face tap.
- Kept legacy LOOI / Луи / Луї / Макс / Max / Robot address compatibility to avoid breaking established physical-command habits.

## 2.1.124 — 2026-08-29

- Fixed natural motion being permanently blocked by Realtime PCM's passive `isListening` state; server VAD now exposes a separate actual-user-speech flag.
- Added a faster Lively motion level with first idle gestures typically within about 2–3 seconds and a noticeably denser cadence.
- Added conservative head-only conversational motion while LOOI is processing and speaking; no wheel/body motion runs while the user is speaking.
- Added explicit ambient-motion blocked/context diagnostics for physical tuning without changing the protected PCM/AEC capture profile.
- Preserved safety-bounded body pivots only for idle motion and kept explicit movement/driving/character reactions higher priority.

## 2.1.123 — 2026-08-29

- Added natural active-idle micro-movements inspired by natural physical LOOI behavior observed on-device.
- Added Off / Subtle / Normal controls: Subtle uses head-only motion; Normal also adds occasional tiny safety-bounded body pivots.
- Ambient motion runs only while LOOI is awake, connected, on the main face screen and not in a conversation, explicit motion, driving-control session or character reaction.
- Real user interaction preempts the ambient scheduler; Realtime PCM transcripts now also reset the inactivity/ambient-interaction timer.
- Ambient wheel primitives reuse the existing cliff/near-edge interlocks and never use continuous autonomous translation.

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
