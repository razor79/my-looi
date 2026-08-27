# Runtime architecture

## Voice

The primary conversation path is Realtime PCM:

```text
Android AudioRecord (16 kHz mono PCM16)
  -> app-owned capture + platform AEC
  -> 16 -> 24 kHz resampling
  -> OpenAI Realtime WebSocket
  -> 24 kHz PCM16 output
  -> app-owned Android AudioTrack
```

Server VAD is authoritative for conversational turn detection. The app owns physical playback, so interruption stops local playback immediately and truncates the assistant item to the amount actually heard.

Completed Realtime input transcriptions are also checked by a narrow deterministic parser for explicitly addressed physical commands (for example, `LOOI, move back` or `LOOI, nod`). Those commands are executed locally through the existing robot safety controller; the Realtime model is not given autonomous movement tools. Forward/backward motion is time-bounded while Realtime retains sole microphone ownership.

Realtime WebRTC is retained only as an Advanced fallback/A-B path.

## Memory

Conversation history and durable facts are stored locally in SQLite. Realtime sessions receive a bounded local-memory context and can also use the local memory search tool for targeted retrieval.

## Wake and safety

The wake/command pipeline remains local. Shared microphone handoff is deliberately serialized before Realtime capture begins. Screen-off/background transitions stop sensitive runtime activity.

Robot movement always retains STOP, deadman, BLE lifecycle, and directional cliff-safety guardrails.

## Robot transport

The physical robot is controlled locally over BLE through the local workspace BLE SDK. First-time robot selection is performed in Settings; saved-device reconnect is attempted when the foreground runtime resumes.
