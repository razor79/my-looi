import type { TtsStyleId } from "./tts-voices";

export type PreparedTtsAudio = {
  text: string;
  audioUrl: string;
};

type TTSOptions = {
  text: string;
  voiceId?: string;
  styleId?: TtsStyleId;
  speed?: number;
  onPlaybackStart?: () => void;
};

/**
 * Fail-closed compatibility surface for unreachable response code that is still
 * entangled with the shared wake/microphone state machine. It performs no network I/O.
 */
class RetiredClassicTtsService {
  async stop(): Promise<void> {
    // No legacy player can exist in the PCM-first runtime.
  }

  async speak(_options: TTSOptions): Promise<void> {
    throw new Error("Inactive response path; use Realtime PCM");
  }

  async prepareAudioUrl(options: { text: string; audioUrl: string }): Promise<PreparedTtsAudio> {
    if (!options.text.trim() || !options.audioUrl.trim()) {
      throw new Error("TTS audio URL and text are required");
    }
    throw new Error("Inactive response path; use Realtime PCM");
  }

  async playPreparedAudio(
    _prepared: PreparedTtsAudio,
    _onPlaybackStart?: () => void
  ): Promise<void> {
    throw new Error("Inactive response path; use Realtime PCM");
  }

  releasePreparedAudio(_prepared: PreparedTtsAudio): void {
    // Nothing is allocated by the retired compatibility surface.
  }
}

export const ttsService = new RetiredClassicTtsService();
