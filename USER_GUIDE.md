# My LOOI User Guide

This guide covers the public **My LOOI v2.1.136** Android release.

My LOOI is an unofficial, community-developed Android companion for the LOOI robot. It combines realtime voice conversation, local memory, multilingual interaction, configurable robot commands, local-only camera attention, and safety-bounded BLE control.

## 1. What you need

- A compatible Android phone mounted on or used with the LOOI robot.
- The My LOOI APK.
- Bluetooth enabled.
- An OpenAI API key for Realtime conversation.
- Microphone permission. Camera permission is optional and is requested only if Camera Attention is enabled.

The OpenAI API key is entered inside the app and stored with Android SecureStore. Do not put API keys into source files or share them in diagnostics.

## 2. First setup

1. Open **Settings**.
2. Choose the **Interface language**, **Listening language**, and **Response language**. They are independent.
3. Enter and save your **OpenAI API key**.
4. Refresh the available Realtime models and choose a model.
5. Choose a Realtime voice and use the preview button if desired.
6. In **Robot**, scan for your LOOI and save/connect it.
7. Optionally configure the robot name, voice-command aliases, appearance, natural motion, Camera Attention, backup folder, and custom phrases.

The interface, listening, and response languages support **Ukrainian, English and Russian**.

## 3. Normal conversation

The primary conversation mode is **Realtime PCM**. My LOOI owns microphone capture and playback directly and supports natural interruption: if you start speaking while the assistant is talking, playback can be interrupted and the unheard portion of the reply is truncated from the conversation state.

You can talk naturally, ask follow-up questions, request translations or pronunciation, and ask the assistant to switch the default response language. Ordinary conversation does not use the deterministic movement-command parser described below.

Speech recognition quality depends on the phone, room acoustics, distance, background noise, and speaking level. If quiet far-field speech is missed, move closer or speak a little louder and use **Settings → Diagnostics** to export a diagnostic ZIP when reporting a reproducible problem.

## 4. Robot name and addressing

The robot has a configurable **primary spoken name**. You can also add normal address aliases and speech-recognition aliases in **Settings → Voice Commands**.

For compatibility, common built-in robot addresses include forms such as **LOOI / Луи / Луї / Макс / Max / Robot / Робот**. Configured aliases are names of the robot, not names of the human user.

For safety, deterministic physical commands normally require the robot address **at the beginning of the utterance**. For example:

- `Луи, поверни налево.`
- `Бобик, кивни три раза.` — if `Бобик` is configured as a robot name/alias.
- `LOOI, move forward.`

The exception is the emergency STOP keyword, described below.

## 5. Built-in physical voice commands

The examples below are representative built-in phrases; several natural variants are accepted. Except for emergency STOP, start the command with the robot name or an accepted robot alias.

| Action | Russian examples | Ukrainian examples | English examples |
| --- | --- | --- | --- |
| Emergency stop | `Стоп`, `Луи, остановись` | `Стоп`, `Луї, зупинись` | `Stop`, `LOOI, halt` |
| Move forward | `Луи, вперёд`, `Луи, езжай прямо` | `Луї, вперед`, `Луї, рухайся вперед` | `LOOI, forward`, `LOOI, move ahead` |
| Move backward | `Луи, назад`, `Луи, езжай обратно` | `Луї, назад` | `LOOI, backward`, `LOOI, reverse` |
| Turn left | `Луи, налево`, `Луи, поверни влево` | `Луї, ліворуч`, `Луї, поверни вліво` | `LOOI, left`, `LOOI, turn left` |
| Turn right | `Луи, направо`, `Луи, поверни вправо` | `Луї, праворуч` | `LOOI, right`, `LOOI, turn right` |
| Turn around | `Луи, развернись`, `Луи, 180 градусов` | `Луї, розвернись`, `Луї, 180 градусів` | `LOOI, turn around`, `LOOI, U-turn` |
| Nod | `Луи, кивни`, `Луи, кивни три раза` | `Луї, зроби кивок` | `LOOI, nod`, `LOOI, nod your head` |
| Dance | `Луи, потанцуй` | `Луї, потанцюй` | `LOOI, dance`, `LOOI, do a dance` |
| Sleep | `Луи, спи`, `Луи, иди спать` | `Луї, спати`, `Луї, іди спати` | `LOOI, sleep`, `LOOI, go to sleep` |

### Emergency STOP

**`Стоп` / `Stop` is a universal safety command and does not require the robot name.** It is intentionally handled differently from ordinary movement commands.

### Movement safety

Forward/backward movement is deliberately bounded. Movement execution retains BLE lifecycle checks, deadman protection, and directional cliff/near-edge safety interlocks. Custom phrases do not bypass these protections.

## 6. Custom voice phrases

Open **Settings → Voice Commands → Custom phrases**. The section is collapsed by default and shows the number of configured phrases in its summary.

You can add custom phrases for:

- Emergency stop
- Forward
- Backward
- Left
- Right
- Turn around
- Nod
- Dance
- Sleep

Each custom phrase can be tagged as **UK**, **EN**, or **RU**. Exact custom phrases are routed through the same deterministic parser and protected movement executor as the built-in commands.

Important rules:

- Wheel movement, turns, dance, nod and sleep still require the robot address at the start of the utterance.
- Emergency-stop custom phrases are the safety exception and do not require an address.
- Very short/generic phrases such as simple yes/no/OK-style words are rejected for safety.
- Conflicting phrases are rejected.
- Use **Voice Commands → Test phrase** to check how a phrase parses. The test does **not** move the robot.

## 7. Sleep and wake

An addressed sleep command puts LOOI into the app's sleep state with a visibly sleeping face. Manual wake uses a **single tap on the face**.

## 8. Natural motion

In **Settings → Robot → Natural motion**, choose one of four levels:

- **Off** — no ambient motion.
- **Subtle** — conservative head-only idle behavior.
- **Normal** — natural head behavior plus occasional small safety-bounded body pivots.
- **Lively** — denser, more active idle/conversation behavior.

User speech and explicit commands take priority. Ambient body motion uses the same bounded safety interlocks and is not continuous autonomous driving.

## 9. Camera Attention

**Camera Attention** is optional and off by default. Enable it in **Settings → Robot → Camera Attention**. Android asks for camera permission only when the feature is enabled.

During an active interaction, Camera Attention can:

- detect a visible face locally on the phone;
- direct the on-screen eyes toward the face even for small offsets;
- make bounded head corrections when needed;
- make small bounded body recentering corrections;
- perform a finite search if an interaction begins and no face is initially visible.

It is intentionally **not permanent face-following**. It does not autonomously drive forward toward a person. When a face is tracked, Camera Attention temporarily owns the head channel so low-priority ambient head gestures do not fight the tracking motion.

Camera frames are processed locally in memory, are not saved, are not uploaded by My LOOI, and are not included in diagnostic exports.

## 10. Face appearance

Open **Settings → Appearance** to choose a face style and color palette independently.

Current styles include:

- Classic
- Soft
- Playful
- Cap
- Cowboy
- Bandana
- Sharp

Current palettes include:

- Cyan
- Rose
- Lime
- Amber
- Violet

Appearance changes presentation only; they do not change movement or safety behavior.

## 11. Memory and history

Conversation history and durable extracted facts are stored locally in SQLite on the Android device. Realtime sessions can preload a bounded amount of relevant memory and perform targeted local memory search when deeper recall is needed.

My LOOI does not require a companion backend for normal operation.

## 12. Backup and restore

In **Settings → Memory backup**, select a folder using Android's system document picker. You can then:

- create a backup;
- restore from the selected folder;
- forget/change the selected folder.

The app uses the Android system folder-access mechanism rather than requesting direct access to a Google Drive account.

## 13. Diagnostics

In **Settings → Diagnostics** you can:

- share a diagnostic ZIP through the Android share sheet;
- choose a persistent local Android Documents/SAF folder and save diagnostics there;
- clear stored diagnostic events.

Normal diagnostics do not retain microphone WAV recordings. Camera frames are not included.

When reporting a voice or movement issue, a diagnostic ZIP recorded immediately after a reproducible test is especially useful.

## 14. Updates

My LOOI can check GitHub Releases for updates from **Settings → Updates**. The release flow verifies the expected package/version/checksum/signing identity before handing the APK to Android for installation.

If Android blocks an APK installation, use the provided **Install settings** shortcut and allow installation from the relevant source only if you trust the release you downloaded.

## 15. Privacy summary

- OpenAI Realtime audio is sent to OpenAI only while a Realtime conversation is active.
- The OpenAI API key is stored in Android SecureStore.
- Conversation history and durable memory are local by default.
- Backgrounding the app or turning the screen off triggers a hard sensitive-runtime suspend.
- Camera Attention processing is local-only and does not retain frames.
- Diagnostic export is manual and user-triggered.

See `PRIVACY.md` in the project repository for the detailed privacy policy.

## 16. Safety summary

- Say **`Стоп` / `Stop`** at any time to use the emergency STOP path.
- Address ordinary physical commands to the robot explicitly.
- Do not use overly broad custom movement phrases.
- Movement remains bounded and protected by BLE/deadman/cliff checks.
- Camera Attention never adds autonomous forward/backward person-following.
- The custom-phrase test checks parsing only and never moves the robot.

## 17. Useful first things to try

After setup, a simple acceptance sequence is:

1. Have a short normal conversation.
2. Interrupt LOOI while it is speaking to test barge-in.
3. Say `Стоп` and verify an immediate emergency stop response.
4. Say an addressed command such as `Луи, кивни` or `LOOI, turn left`.
5. Enable Camera Attention and move slightly left/right to see the eyes follow before physical recentering is necessary.
6. Try a different face style/palette.
7. Add one custom deterministic phrase and verify it with the non-moving phrase tester.
8. Select a backup folder and create a memory backup.

---

My LOOI is community-developed and is not affiliated with or endorsed by the LOOI robot manufacturer.
