type TraceFields = Record<string, string | number | boolean | undefined>;

type VoiceAcceptanceTraceEvent =
  | "wakeword"
  | "ignored"
  | "session"
  | "audio-preroll"
  | "recording-started"
  | "streaming-listening-started"
  | "vad-speech"
  | "vad-end"
  | "safety-timeout"
  | "finish-requested"
  | "recording-stopped"
  | "speaker-verified"
  | "stt"
  | "intent"
  | "first-token"
  | "first-tts"
  | "stream-done"
  | "assistant"
  | "cleanup"
  | "error";

export class VoiceAcceptanceTrace {
  private readonly enabled = process.env.EXPO_PUBLIC_LOOI_TRACE_LIVE_VOICE_ACCEPTANCE === "1";
  private readonly logOnceEvents = new Set<VoiceAcceptanceTraceEvent>([
    "wakeword",
    "recording-started",
    "streaming-listening-started",
    "vad-speech",
    "vad-end",
    "recording-stopped",
    "speaker-verified",
    "stt",
    "intent",
    "first-token",
    "first-tts",
    "stream-done",
    "assistant",
    "cleanup",
  ]);
  private active:
    | {
        id: string;
        startedAt: number;
        marks: Partial<Record<VoiceAcceptanceTraceEvent, number>>;
      }
    | null = null;
  private nextId = 1;

  start(): string | undefined {
    if (!this.enabled) return undefined;

    const id = `live-${this.nextId}`;
    this.nextId += 1;
    this.active = { id, startedAt: Date.now(), marks: {} };
    this.mark("wakeword", { id });
    return id;
  }

  mark(event: VoiceAcceptanceTraceEvent, fields: TraceFields = {}): void {
    if (!this.enabled) return;

    const trace = this.active;
    const elapsedMs = trace ? Date.now() - trace.startedAt : 0;
    const alreadyMarked = trace?.marks[event] !== undefined;
    if (trace && !alreadyMarked) {
      trace.marks[event] = elapsedMs;
    }
    if (alreadyMarked && this.logOnceEvents.has(event)) {
      return;
    }
    const id = trace?.id ?? fields.id ?? "none";
    const detail = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    console.log(
      `[Acceptance] live voice ${event} id=${id} elapsedMs=${elapsedMs}` +
        (detail ? ` ${detail}` : "")
    );
  }

  finish(fields: TraceFields = {}): void {
    if (!this.enabled) return;

    const trace = this.active;
    if (!trace) return;

    const marks = trace.marks;
    const totalMs = Date.now() - trace.startedAt;
    const vadEndAfterSpeechMs =
      marks["vad-end"] !== undefined && marks["vad-speech"] !== undefined
        ? marks["vad-end"] - marks["vad-speech"]
        : undefined;
    const firstTokenAfterSttMs =
      marks["first-token"] !== undefined && marks.stt !== undefined
        ? marks["first-token"] - marks.stt
        : undefined;
    const firstTtsAfterTokenMs =
      marks["first-tts"] !== undefined && marks["first-token"] !== undefined
        ? marks["first-tts"] - marks["first-token"]
        : undefined;

    this.mark("cleanup", {
      ...fields,
      totalMs,
      vadEndAfterSpeechMs,
      firstTokenAfterSttMs,
      firstTtsAfterTokenMs,
    });
    this.active = null;
  }
}

export const voiceAcceptanceTrace = new VoiceAcceptanceTrace();
