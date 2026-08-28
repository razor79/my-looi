import { create } from "zustand";
import { createMMKV } from "react-native-mmkv";
import {
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_STYLE_ID,
  DEFAULT_TTS_VOICE_ID,
  isSupportedTtsStyleId,
  isSupportedRealtimeVoiceId,
  normalizeTtsSpeed,
  type TtsStyleId,
} from "../voice/tts-voices";
import {
  DEFAULT_RESPONSE_LANGUAGE,
  normalizeResponseLanguage,
  type ResponseLanguage,
} from "../language/response-language";
import { DEFAULT_REALTIME_MODEL_ID, normalizeRealtimeModelId } from "../openai/realtime-models";
import {
  DEFAULT_LISTENING_LANGUAGE,
  normalizeListeningLanguage,
  type ListeningLanguage,
} from "../language/listening-language";
import {
  detectSystemInterfaceLanguage,
  normalizeInterfaceLanguage,
  type InterfaceLanguage,
} from "../i18n/ui-language";

export type VoiceState =
  | "sleeping"
  | "attention"
  | "verifying"
  | "listening"
  | "processing"
  | "speaking";

export type ConversationMode = "realtime" | "realtime_pcm";

export function isRealtimeConversationMode(mode: ConversationMode): boolean {
  return mode === "realtime" || mode === "realtime_pcm";
}


export function isPcmRealtimeMode(mode: ConversationMode): boolean {
  return mode === "realtime_pcm";
}

export type UserPreferences = {
  /** Language used by the local application interface. Independent from voice I/O. */
  interfaceLanguage: InterfaceLanguage;
  /** Language expected from the user by wake fallback and remote STT. */
  listeningLanguage: ListeningLanguage;
  /** Language used by LOOI for replies and system messages. */
  language: ResponseLanguage;
  ttsEnabled: boolean;
  /** OpenAI Realtime conversation model selected for new sessions. */
  realtimeModelId: string;
  ttsVoiceId: string;
  ttsStyleId: TtsStyleId;
  ttsSpeed: number;
  wakeWordEnabled: boolean;
  /** Selectable conversation transport. Older persisted values normalize to Realtime PCM. */
  conversationMode: ConversationMode;
};

interface UserState {
  /** User profile ID */
  profileId: string | null;

  /** User display name */
  name: string;

  /** Whether voice enrollment is complete */
  voiceEnrolled: boolean;

  /** Current voice pipeline state */
  voiceState: VoiceState;

  /** Explicit deep-sleep mode: microphone/runtime stay off until manual face wake. */
  robotSleeping: boolean;

  /** User preferences */
  preferences: UserPreferences;

  // Actions
  setProfile: (id: string, name: string) => void;
  setVoiceEnrolled: (enrolled: boolean) => void;
  setVoiceState: (state: VoiceState) => void;
  setRobotSleeping: (sleeping: boolean) => void;
  updatePreferences: (prefs: Partial<UserState["preferences"]>) => void;
}

type StoredPreferences = {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  preferences: UserPreferences;
};

const USER_PREFERENCES_KEY = "looi.user-preferences.v1";
const ROBOT_SLEEPING_KEY = "looi.robot-sleeping.v1";
const preferencesStorage = createMMKV({ id: "looi.user-preferences" });
const DEFAULT_PREFERENCES: UserPreferences = {
  interfaceLanguage: detectSystemInterfaceLanguage(),
  listeningLanguage: DEFAULT_LISTENING_LANGUAGE,
  language: DEFAULT_RESPONSE_LANGUAGE,
  ttsEnabled: true,
  realtimeModelId: DEFAULT_REALTIME_MODEL_ID,
  ttsVoiceId: DEFAULT_TTS_VOICE_ID,
  ttsStyleId: DEFAULT_TTS_STYLE_ID,
  ttsSpeed: DEFAULT_TTS_SPEED,
  wakeWordEnabled: true,
  conversationMode: "realtime_pcm",
};

function loadPreferences(): UserPreferences {
  const raw = preferencesStorage.getString(USER_PREFERENCES_KEY);
  if (!raw) return DEFAULT_PREFERENCES;

  try {
    const stored = JSON.parse(raw) as Partial<StoredPreferences>;
    const preferences = stored.preferences;
    if (!preferences) return DEFAULT_PREFERENCES;
    const normalized: UserPreferences = {
      // v2.1.121 introduces an independent UI language. Existing installs use
      // the Android/system locale when this preference is absent.
      interfaceLanguage: normalizeInterfaceLanguage(
        (preferences as Partial<UserPreferences>).interfaceLanguage
      ),
      // v1.1.27 splits input/listening language from response language. Existing
      // installs migrate to the old response language so both remain equal.
      listeningLanguage: normalizeListeningLanguage(
        (preferences as Partial<UserPreferences>).listeningLanguage ?? preferences.language
      ),
      // v1.1.0 stored `auto`; migrate it and every missing/invalid value to RU.
      language: normalizeResponseLanguage(preferences.language),
      ttsEnabled: preferences.ttsEnabled !== false,
      realtimeModelId: normalizeRealtimeModelId((preferences as Partial<UserPreferences>).realtimeModelId),
      ttsVoiceId:
        typeof preferences.ttsVoiceId === "string" &&
        isSupportedRealtimeVoiceId(preferences.ttsVoiceId)
          ? preferences.ttsVoiceId
          : DEFAULT_TTS_VOICE_ID,
      ttsStyleId:
        typeof preferences.ttsStyleId === "string" &&
        isSupportedTtsStyleId(preferences.ttsStyleId)
          ? preferences.ttsStyleId
          : DEFAULT_TTS_STYLE_ID,
      ttsSpeed: normalizeTtsSpeed(Number(preferences.ttsSpeed)),
      wakeWordEnabled: preferences.wakeWordEnabled !== false,
      conversationMode: (() => {
        const mode = (preferences as { conversationMode?: unknown }).conversationMode;
        return mode === "realtime" ? "realtime" : "realtime_pcm";
      })(),
    };
    if (
      (preferences as Partial<UserPreferences>).interfaceLanguage !== normalized.interfaceLanguage ||
      (preferences as Partial<UserPreferences>).listeningLanguage !== normalized.listeningLanguage ||
      (preferences as Partial<UserPreferences>).realtimeModelId !== normalized.realtimeModelId ||
      preferences.ttsVoiceId !== normalized.ttsVoiceId ||
      preferences.ttsStyleId !== normalized.ttsStyleId ||
      stored.version !== 6 ||
      (preferences as Partial<UserPreferences>).conversationMode !== normalized.conversationMode ||
      Object.prototype.hasOwnProperty.call(preferences, "memoryBackend") ||
      Object.prototype.hasOwnProperty.call(preferences, "cameraEnabled") ||
      Object.prototype.hasOwnProperty.call(preferences, "calendarEnabled")
    ) {
      savePreferences(normalized);
    }
    return normalized;
  } catch {
    preferencesStorage.remove(USER_PREFERENCES_KEY);
    return DEFAULT_PREFERENCES;
  }
}

function savePreferences(preferences: UserPreferences): void {
  const payload: StoredPreferences = { version: 6, preferences };
  preferencesStorage.set(USER_PREFERENCES_KEY, JSON.stringify(payload));
}

function loadRobotSleeping(): boolean {
  return preferencesStorage.getBoolean(ROBOT_SLEEPING_KEY) === true;
}

function saveRobotSleeping(sleeping: boolean): void {
  preferencesStorage.set(ROBOT_SLEEPING_KEY, sleeping);
}

export const useUserStore = create<UserState>((set) => ({
  profileId: null,
  name: "Владелец",
  voiceEnrolled: false,
  voiceState: "sleeping",
  robotSleeping: loadRobotSleeping(),
  preferences: loadPreferences(),

  setProfile: (profileId, name) => set({ profileId, name }),
  setVoiceEnrolled: (voiceEnrolled) => set({ voiceEnrolled }),
  setVoiceState: (voiceState) => set({ voiceState }),
  setRobotSleeping: (robotSleeping) => {
    saveRobotSleeping(robotSleeping);
    set({ robotSleeping });
  },
  updatePreferences: (prefs) =>
    set((state) => {
      const normalizedPrefs: Partial<UserState["preferences"]> = { ...prefs };
      const preferences = {
        ...state.preferences,
        ...normalizedPrefs,
        realtimeModelId:
          prefs.realtimeModelId === undefined
            ? state.preferences.realtimeModelId
            : normalizeRealtimeModelId(prefs.realtimeModelId),
        ttsSpeed:
          prefs.ttsSpeed === undefined
            ? state.preferences.ttsSpeed
            : normalizeTtsSpeed(prefs.ttsSpeed),
        ttsVoiceId:
          prefs.ttsVoiceId && isSupportedRealtimeVoiceId(prefs.ttsVoiceId)
            ? prefs.ttsVoiceId
            : state.preferences.ttsVoiceId,
        ttsStyleId:
          prefs.ttsStyleId && isSupportedTtsStyleId(prefs.ttsStyleId)
            ? prefs.ttsStyleId
            : state.preferences.ttsStyleId,
      };
      savePreferences(preferences);
      return { preferences };
    }),
}));
