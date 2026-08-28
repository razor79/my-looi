# Privacy

My LOOI is designed as a local-first companion app.

## Stored on the device

- conversation history;
- durable memory/facts;
- selected robot information;
- language, model, and voice preferences;
- the user's OpenAI API key, stored through Android SecureStore;
- diagnostic events until the user clears them.

## Sent to OpenAI

During an active Realtime conversation, microphone audio and conversation context required for that session are sent directly to the OpenAI API using the user's API key. Tool results needed for the conversation may also be included in the session.

My LOOI does not require a separate project-operated backend for normal voice conversation or memory storage.

## Background and screen-off behavior

When the app enters the background or the device enters the app's sleep/screen-off path, sensitive microphone/camera runtime is stopped. The app does not intentionally continue normal Realtime conversation capture in the background.

## Diagnostics

Diagnostic export is user-triggered. Normal diagnostic logging does not retain microphone WAV recordings. A diagnostic ZIP can be sent through the Android share sheet (for example to Google Drive when that app is installed) or written to a local folder explicitly granted through Android Documents/SAF. My LOOI does not request direct Google Drive authorization, does not store Google Drive tokens or folder IDs, and does not automatically or in the background upload diagnostics. Before sharing a diagnostic ZIP publicly, review it for device-specific or conversation-specific information.

## Update checks

My LOOI contacts the public GitHub Releases API only when the user explicitly checks for an update. Downloading an APK is also user-triggered. The updater does not use a GitHub account or token. A downloaded APK is verified locally before My LOOI hands it to the Android package installer.

## Backups

Memory backup is written only to a folder explicitly selected by the user through Android's storage access framework. Backup files can contain personal memories and conversation-derived facts and should be treated as private data.
