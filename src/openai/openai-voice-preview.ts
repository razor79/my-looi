import { createAudioPlayer, setIsAudioActiveAsync, type AudioStatus } from "expo-audio";

import { getOpenAiApiKey, MissingOpenAiApiKeyError } from "./openai-api-key";
import { getTtsPreviewText, isSupportedRealtimeVoiceId } from "../voice/tts-voices";
import type { ResponseLanguage } from "../language/response-language";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const PREVIEW_MODEL = "gpt-4o-mini-tts";
const REQUEST_TIMEOUT_MS = 20_000;
const PLAYBACK_TIMEOUT_MS = 15_000;

export async function playOpenAiRealtimeVoicePreview(
  voiceId: string,
  language: ResponseLanguage
): Promise<void> {
  if (!isSupportedRealtimeVoiceId(voiceId)) {
    throw new Error(`Unsupported Realtime voice: ${voiceId}`);
  }
  const key = await getOpenAiApiKey();
  if (!key) throw new MissingOpenAiApiKeyError();

  const controller = new AbortController();
  const requestTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PREVIEW_MODEL,
        voice: voiceId,
        input: getTtsPreviewText(language),
        response_format: "wav",
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Voice preview request timed out");
    throw error;
  } finally {
    clearTimeout(requestTimer);
  }

  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240); } catch {}
    throw new Error(`Voice preview failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Voice preview returned empty audio");
  const uri = `data:audio/wav;base64,${bytesToBase64(bytes)}`;

  await setIsAudioActiveAsync(true);
  const player = createAudioPlayer({ uri }, { updateInterval: 80 });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let subscription: { remove: () => void } | null = null;
      let playbackTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (playbackTimer) clearTimeout(playbackTimer);
        subscription?.remove();
        if (error) reject(error);
        else resolve();
      };
      subscription = player.addListener("playbackStatusUpdate", (status: AudioStatus) => {
        if (status.error) finish(new Error(`Voice preview playback failed: ${status.error}`));
        else if (status.didJustFinish) finish();
      });
      playbackTimer = setTimeout(
        () => finish(new Error("Voice preview playback timed out")),
        PLAYBACK_TIMEOUT_MS
      );
      player.play();
    });
  } finally {
    try { player.pause(); } catch {}
    try { player.remove(); } catch {}
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
