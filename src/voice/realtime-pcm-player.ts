import { createAudioPlayer, type AudioPlayer, type AudioStatus } from "expo-audio";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";
import { base64ToBytes, pcm16ToWavDataUri, REALTIME_PCM_RATE } from "./realtime-config";

const TARGET_PCM_BYTES = Math.round(REALTIME_PCM_RATE * 2 * 0.45);
const PLAYBACK_TIMEOUT_MS = 8_000;

// TypedArrays preserve their backing-buffer type in current TypeScript. Realtime
// PCM chunks are always copied into buffers owned by this player, so keep that
// contract explicit instead of widening them to ArrayBufferLike.
type OwnedPcmBytes = Uint8Array<ArrayBuffer>;

function concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): OwnedPcmBytes {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

export class RealtimePcmPlayer {
  private pending: OwnedPcmBytes = new Uint8Array(0);
  private queue: OwnedPcmBytes[] = [];
  private player: AudioPlayer | null = null;
  private pumping = false;
  private stoppedGeneration = 0;
  private drainWaiters: Array<() => void> = [];
  private onPlaybackState?: (playing: boolean) => void;

  constructor(onPlaybackState?: (playing: boolean) => void) {
    this.onPlaybackState = onPlaybackState;
  }

  enqueueBase64(delta: string): void {
    if (!delta) return;
    this.pending = concatBytes(this.pending, base64ToBytes(delta));
    while (this.pending.length >= TARGET_PCM_BYTES) {
      const chunk = this.pending.slice(0, TARGET_PCM_BYTES);
      this.pending = this.pending.slice(TARGET_PCM_BYTES);
      this.queue.push(chunk);
    }
    void this.pump();
  }

  flush(): void {
    if (this.pending.length > 0) {
      this.queue.push(this.pending);
      this.pending = new Uint8Array(0);
    }
    void this.pump();
  }

  async drain(): Promise<void> {
    this.flush();
    if (!this.pumping && this.queue.length === 0 && !this.player) return;
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  async stop(): Promise<void> {
    this.stoppedGeneration += 1;
    this.pending = new Uint8Array(0);
    this.queue = [];
    const player = this.player;
    this.player = null;
    if (player) {
      try { player.pause(); } catch {}
      try { player.remove(); } catch {}
    }
    this.pumping = false;
    this.onPlaybackState?.(false);
    this.resolveDrainWaiters();
    recordDiagnosticEvent("realtime", "audio-playback-stopped");
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const generation = this.stoppedGeneration;
    try {
      while (this.queue.length > 0 && generation === this.stoppedGeneration) {
        const chunk = this.queue.shift()!;
        await this.playChunk(chunk, generation);
      }
    } finally {
      if (generation === this.stoppedGeneration) {
        this.pumping = false;
        if (this.queue.length === 0 && this.pending.length === 0) {
          this.onPlaybackState?.(false);
          this.resolveDrainWaiters();
        }
      }
    }
  }

  private async playChunk(bytes: OwnedPcmBytes, generation: number): Promise<void> {
    if (generation !== this.stoppedGeneration || bytes.length === 0) return;
    const uri = pcm16ToWavDataUri(bytes);
    const player = createAudioPlayer({ uri }, { updateInterval: 80 });
    this.player = player;
    this.onPlaybackState?.(true);
    const chunkDurationMs = Math.round((bytes.length / 2 / REALTIME_PCM_RATE) * 1000);
    recordDiagnosticEvent("realtime", "audio-chunk-play-start", {
      bytes: bytes.length,
      chunkDurationMs,
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      let subscription: { remove: () => void } | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription?.remove();
        try { player.remove(); } catch {}
        if (this.player === player) this.player = null;
        resolve();
      };
      const handleStatus = (status: AudioStatus) => {
        if (status.error || status.didJustFinish) finish();
      };
      subscription = player.addListener("playbackStatusUpdate", handleStatus);
      const timer = setTimeout(finish, Math.max(PLAYBACK_TIMEOUT_MS, chunkDurationMs + 2500));
      player.play();
    });
  }

  private resolveDrainWaiters(): void {
    const waiters = this.drainWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}
