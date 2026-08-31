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

export type AmbientMotionLevel = "off" | "subtle" | "normal" | "lively";

/** Legacy v2.1.127-v2.1.128 combined face preset; retained only for migration compatibility. */
export type FaceSkinId = "classic" | "soft" | "pixel" | "spark";
export type FaceStyleId = "classic" | "soft" | "playful" | "fringe" | "sharp" | "cowboy" | "bandana";
export type FacePaletteId = "cyan" | "rose" | "lime" | "amber" | "violet";

export function normalizeFaceSkinId(value: unknown): FaceSkinId {
  return value === "soft" || value === "pixel" || value === "spark" ? value : "classic";
}

export function normalizeFaceStyleId(value: unknown, legacySkin?: unknown): FaceStyleId {
  if (value === "soft" || value === "playful" || value === "fringe" || value === "sharp" || value === "cowboy" || value === "bandana") return value;
  if (value === "classic") return "classic";
  const legacy = normalizeFaceSkinId(legacySkin);
  if (legacy === "soft") return "soft";
  if (legacy === "pixel") return "sharp";
  if (legacy === "spark") return "playful";
  return "classic";
}

export function normalizeFacePaletteId(value: unknown, legacySkin?: unknown): FacePaletteId {
  if (value === "rose" || value === "lime" || value === "amber" || value === "violet") return value;
  if (value === "cyan") return "cyan";
  const legacy = normalizeFaceSkinId(legacySkin);
  if (legacy === "soft") return "rose";
  if (legacy === "pixel") return "lime";
  if (legacy === "spark") return "amber";
  return "cyan";
}

export type VoiceCommandLanguage = "ru" | "uk" | "en";
export type CustomVoiceCommandAction =
  | "emergency_stop"
  | "forward"
  | "backward"
  | "left"
  | "right"
  | "turn_around"
  | "nod"
  | "dance"
  | "sleep";

export type CustomVoiceCommandPhrase = {
  id: string;
  text: string;
  language: VoiceCommandLanguage;
};

export type CustomVoiceCommandMap = Record<CustomVoiceCommandAction, CustomVoiceCommandPhrase[]>;

export const EMPTY_CUSTOM_VOICE_COMMANDS: CustomVoiceCommandMap = {
  emergency_stop: [], forward: [], backward: [], left: [], right: [],
  turn_around: [], nod: [], dance: [], sleep: [],
};

function normalizePhraseList(value: unknown): CustomVoiceCommandPhrase[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CustomVoiceCommandPhrase[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<CustomVoiceCommandPhrase>;
    const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 80) : "";
    const language: VoiceCommandLanguage = raw.language === "uk" || raw.language === "en" ? raw.language : "ru";
    if (text.length < 2) continue;
    const key = `${language}:${text.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: typeof raw.id === "string" && raw.id ? raw.id : `${Date.now()}-${out.length}`, text, language });
  }
  return out.slice(0, 30);
}

function normalizeCustomVoiceCommands(value: unknown): CustomVoiceCommandMap {
  const src = value && typeof value === "object" ? value as Partial<CustomVoiceCommandMap> : {};
  return {
    emergency_stop: normalizePhraseList(src.emergency_stop),
    forward: normalizePhraseList(src.forward),
    backward: normalizePhraseList(src.backward),
    left: normalizePhraseList(src.left),
    right: normalizePhraseList(src.right),
    turn_around: normalizePhraseList(src.turn_around),
    nod: normalizePhraseList(src.nod),
    dance: normalizePhraseList(src.dance),
    sleep: normalizePhraseList(src.sleep),
  };
}

function normalizeRobotAddressList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    const text = typeof raw === "string" ? raw.trim().slice(0, 40) : "";
    if (text.length < 2) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); result.push(text);
  }
  return result.length ? result.slice(0, 12) : fallback;
}

export function normalizeAmbientMotionLevel(value: unknown): AmbientMotionLevel {
  return value === "off" || value === "subtle" || value === "normal" || value === "lively" ? value : "normal";
}

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
  /** Low-priority active-idle physical motion: off, head-only subtle, or normal with safe micro-pivots. */
  ambientMotionLevel: AmbientMotionLevel;
  /** Opt-in local-only face attention used only during active social interaction. */
  cameraAttentionEnabled: boolean;
  /** Legacy combined visual preset kept only so older installs migrate predictably. */
  faceSkin: FaceSkinId;
  /** Independent facial geometry/decor style. Pure presentation only. */
  faceStyle: FaceStyleId;
  /** Independent face color palette. Pure presentation only. */
  facePalette: FacePaletteId;
  /** User-visible primary robot name used for deterministic addressed commands and Realtime context. */
  robotName: string;
  /** Additional normal ways to address the robot. */
  robotAddressAliases: string[];
  /** Hidden STT recovery spellings/recognition variants. */
  robotAddressRecognitionAliases: string[];
  /** Per-action user-defined deterministic phrases, tagged by listening language. */
  customVoiceCommands: CustomVoiceCommandMap;
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
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
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
  ambientMotionLevel: "normal",
  cameraAttentionEnabled: false,
  faceSkin: "classic",
  faceStyle: "classic",
  facePalette: "cyan",
  robotName: "Луи",
  robotAddressAliases: ["LOOI", "Луї", "Робот", "Robot"],
  robotAddressRecognitionAliases: ["Луй", "Луни", "Луі", "Уи", "Уй"],
  customVoiceCommands: EMPTY_CUSTOM_VOICE_COMMANDS,
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
      ambientMotionLevel: normalizeAmbientMotionLevel(
        (preferences as Partial<UserPreferences>).ambientMotionLevel
      ),
      // Do not migrate the retired experimental `cameraEnabled` flag. The new
      // social camera feature is privacy-sensitive and must be explicitly enabled.
      cameraAttentionEnabled: (preferences as Partial<UserPreferences>).cameraAttentionEnabled === true,
      faceSkin: normalizeFaceSkinId((preferences as Partial<UserPreferences>).faceSkin),
      faceStyle: normalizeFaceStyleId(
        (preferences as Partial<UserPreferences>).faceStyle,
        (preferences as Partial<UserPreferences>).faceSkin
      ),
      facePalette: normalizeFacePaletteId(
        (preferences as Partial<UserPreferences>).facePalette,
        (preferences as Partial<UserPreferences>).faceSkin
      ),
      robotName: typeof (preferences as Partial<UserPreferences>).robotName === "string" && (preferences as Partial<UserPreferences>).robotName!.trim().length >= 2
        ? (preferences as Partial<UserPreferences>).robotName!.trim().slice(0, 40)
        : "Луи",
      robotAddressAliases: normalizeRobotAddressList((preferences as Partial<UserPreferences>).robotAddressAliases, ["LOOI", "Луї", "Робот", "Robot"]),
      robotAddressRecognitionAliases: normalizeRobotAddressList((preferences as Partial<UserPreferences>).robotAddressRecognitionAliases, ["Луй", "Луни", "Луі", "Уи", "Уй"]),
      customVoiceCommands: normalizeCustomVoiceCommands((preferences as Partial<UserPreferences>).customVoiceCommands),
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
      (preferences as Partial<UserPreferences>).ambientMotionLevel !== normalized.ambientMotionLevel ||
      (preferences as Partial<UserPreferences>).cameraAttentionEnabled !== normalized.cameraAttentionEnabled ||
      (preferences as Partial<UserPreferences>).faceSkin !== normalized.faceSkin ||
      (preferences as Partial<UserPreferences>).faceStyle !== normalized.faceStyle ||
      (preferences as Partial<UserPreferences>).facePalette !== normalized.facePalette ||
      stored.version !== 12 ||
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
  const payload: StoredPreferences = { version: 12, preferences };
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
        faceStyle:
          prefs.faceStyle === undefined
            ? state.preferences.faceStyle
            : normalizeFaceStyleId(prefs.faceStyle, state.preferences.faceSkin),
        facePalette:
          prefs.facePalette === undefined
            ? state.preferences.facePalette
            : normalizeFacePaletteId(prefs.facePalette, state.preferences.faceSkin),
      };
      savePreferences(preferences);
      return { preferences };
    }),
}));
