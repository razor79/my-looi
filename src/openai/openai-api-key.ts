import * as SecureStore from "expo-secure-store";
import { isRealtimeConversationModelId, preferRealtimeModelAliases, type OpenAiRealtimeModel } from "./realtime-models";

const OPENAI_API_KEY_STORAGE_KEY = "looi.openai-api-key.v1";
const MIN_OPENAI_API_KEY_LENGTH = 20;
const OPENAI_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

let cachedKey: string | null | undefined;
let loadingKey: Promise<string | null> | null = null;

export class MissingOpenAiApiKeyError extends Error {
  constructor() {
    super("OpenAI API key is not configured");
    this.name = "MissingOpenAiApiKeyError";
  }
}

export type OpenAiRealtimeClientSecret = {
  value: string;
  expiresAt: number | null;
};

export function validateOpenAiApiKey(value: string): string {
  const key = normalizeOpenAiApiKey(value);
  if (!key || key.length < MIN_OPENAI_API_KEY_LENGTH) {
    throw new Error(`OpenAI API key must contain at least ${MIN_OPENAI_API_KEY_LENGTH} characters`);
  }
  return key;
}

export async function getOpenAiApiKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  if (!loadingKey) {
    loadingKey = SecureStore.getItemAsync(OPENAI_API_KEY_STORAGE_KEY)
      .then((value) => {
        cachedKey = normalizeOpenAiApiKey(value);
        return cachedKey;
      })
      .finally(() => {
        loadingKey = null;
      });
  }
  return loadingKey;
}

export async function hasOpenAiApiKey(): Promise<boolean> {
  return Boolean(await getOpenAiApiKey());
}

export async function saveOpenAiApiKey(value: string): Promise<void> {
  const key = validateOpenAiApiKey(value);
  await SecureStore.setItemAsync(OPENAI_API_KEY_STORAGE_KEY, key);
  cachedKey = key;
}

export async function clearOpenAiApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(OPENAI_API_KEY_STORAGE_KEY);
  cachedKey = null;
}

export async function listOpenAiRealtimeModels(): Promise<OpenAiRealtimeModel[]> {
  const key = await getOpenAiApiKey();
  if (!key) throw new MissingOpenAiApiKeyError();

  const response = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(await makeOpenAiHttpError("OpenAI model list", response));
  }
  const payload = await response.json() as { data?: Array<Record<string, unknown>> };
  const models = (payload.data ?? [])
    .map((item): OpenAiRealtimeModel | null => {
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id || !isRealtimeConversationModelId(id)) return null;
      return {
        id,
        created: typeof item.created === "number" && Number.isFinite(item.created) ? item.created : null,
        ownedBy: typeof item.owned_by === "string" ? item.owned_by : null,
      };
    })
    .filter((model): model is OpenAiRealtimeModel => model !== null)
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  return preferRealtimeModelAliases(models);
}

/**
 * BYOK Realtime bootstrap for the owner-controlled Android device.
 *
 * OpenAI's normal browser/mobile recommendation is to mint this secret on a
 * developer backend. My LOOI intentionally has no Realtime backend: the
 * user's own standard key stays in Android SecureStore and is used only for
 * this short REST request. The returned ephemeral secret authenticates the
 * WebRTC SDP exchange and is never persisted.
 */
export async function createOpenAiRealtimeClientSecret(
  session: Record<string, unknown>
): Promise<OpenAiRealtimeClientSecret> {
  const key = await getOpenAiApiKey();
  if (!key) throw new MissingOpenAiApiKeyError();

  const response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session }),
  });

  if (!response.ok) {
    throw new Error(await makeOpenAiHttpError("Realtime client secret", response));
  }

  const data = await response.json() as Record<string, unknown>;
  const value = typeof data.value === "string" ? data.value.trim() : "";
  if (!value) throw new Error("OpenAI Realtime client secret response did not contain a value");
  const expiresAt = typeof data.expires_at === "number" && Number.isFinite(data.expires_at)
    ? data.expires_at
    : null;
  return { value, expiresAt };
}

export async function exchangeOpenAiRealtimeSdp(
  ephemeralSecret: string,
  offerSdp: string
): Promise<string> {
  const secret = ephemeralSecret.trim();
  if (!secret) throw new Error("OpenAI Realtime ephemeral secret is empty");
  if (!offerSdp.trim()) throw new Error("OpenAI Realtime WebRTC offer SDP is empty");

  const response = await fetch(OPENAI_REALTIME_CALLS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/sdp",
    },
    body: offerSdp,
  });
  if (!response.ok) {
    throw new Error(await makeOpenAiHttpError("Realtime SDP exchange", response));
  }
  // SDP is line-oriented and native libwebrtc is stricter than browsers about
  // parsing. Preserve OpenAI's response exactly, including its final CRLF/LF;
  // only trim a copy for the empty-response check.
  const answerSdp = await response.text();
  if (!answerSdp.trim()) throw new Error("OpenAI Realtime SDP response was empty");
  return answerSdp;
}

export function createOpenAiRealtimeEphemeralWebSocket(
  ephemeralSecret: string,
  model: string
): WebSocket {
  const secret = ephemeralSecret.trim();
  if (!secret) throw new Error("OpenAI Realtime ephemeral secret is empty");
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  // Current OpenAI browser/client WebSocket guidance supports short-lived
  // Realtime tokens through WebSocket subprotocols. This keeps the owner's
  // standard API key in SecureStore and out of the long-lived socket.
  return new WebSocket(url, [
    "realtime",
    `openai-insecure-api-key.${secret}`,
  ]);
}

// Kept for the 2.1.59 rollback path/tests only. Active 2.1.60 Realtime does
// not call this helper and never uses the old manual PCM WebSocket transport.
export async function createOpenAiRealtimeWebSocket(model: string): Promise<WebSocket> {
  const key = await getOpenAiApiKey();
  if (!key) throw new MissingOpenAiApiKeyError();

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  type ReactNativeWebSocketConstructor = new (
    url: string,
    protocols?: string | string[] | null,
    options?: { headers?: Record<string, string> }
  ) => WebSocket;
  const ReactNativeWebSocket = WebSocket as unknown as ReactNativeWebSocketConstructor;
  return new ReactNativeWebSocket(url, null, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

async function makeOpenAiHttpError(label: string, response: Response): Promise<string> {
  let detail = "";
  try {
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    detail = text.slice(0, 280);
  } catch {
    detail = "";
  }
  return `${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
}

function normalizeOpenAiApiKey(value: string | null | undefined): string | null {
  const key = value?.trim();
  return key || null;
}
