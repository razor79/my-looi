import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Constants from "expo-constants";
import * as Sharing from "expo-sharing";
import { useFocusEffect } from "expo-router";

import { DeviceShell } from "@/src/ui/DeviceShell";
import { looiTheme } from "@/src/ui/looi-theme";
import { useUserStore, type ConversationMode } from "@/src/store/user";
import { voiceRuntime } from "@/src/perceivers/voice-runtime";
import { syncVoiceRuntime } from "@/src/core/app-bootstrap";
import { recordDiagnosticEvent, clearDiagnosticLog, getDiagnosticLogEntries } from "@/src/diagnostics/diagnostic-log";
import { writeCombinedDiagnosticExport } from "@/src/diagnostics/diagnostic-export";
import { withExternalActivityLease } from "@/src/core/background-process-exit";
import { RESPONSE_LANGUAGE_OPTIONS } from "@/src/language/response-language";
import { LISTENING_LANGUAGE_OPTIONS } from "@/src/language/listening-language";
import { REALTIME_VOICE_OPTIONS, TTS_SPEED_OPTIONS } from "@/src/voice/tts-voices";
import {
  clearOpenAiApiKey,
  hasOpenAiApiKey,
  listOpenAiRealtimeModels,
  saveOpenAiApiKey,
  validateOpenAiApiKey,
} from "@/src/openai/openai-api-key";
import {
  DEFAULT_REALTIME_MODEL_ID,
  formatConversationCostPerMinute,
  formatRealtimeModelName,
  isOfficiallyDeprecatedRealtimeModelId,
  isPreviousSupportedRealtimeModelId,
  type OpenAiRealtimeModel,
} from "@/src/openai/realtime-models";
import { playOpenAiRealtimeVoicePreview } from "@/src/openai/openai-voice-preview";
import { kwsAudioFeeder } from "@/src/voice/kws-audio-feeder";
import {
  checkAllSherpaModelReadiness,
  type SherpaModelCheck,
} from "@/src/voice/sherpa-models";
import {
  downloadMissingSherpaModels,
  type SherpaModelDownloadProgress,
} from "@/src/voice/sherpa-model-download";
import { getLocalMemoryStats } from "@/src/memory/memory-service";
import type { LocalMemoryStats } from "@/src/memory/local-memory-database";
import {
  backupLocalMemoryToSelectedFolder,
  chooseLocalBackupFolder,
  forgetLocalBackupFolder,
  getLocalBackupStorageSettings,
  restoreLocalMemoryFromSelectedFolder,
} from "@/src/backup/local-memory-backup-storage";
import {
  clearSavedLooiRobot,
  connectSelectedLooiRobot,
  forceReconnectSavedLooiRobot,
  getSavedLooiRobot,
  scanLooiRobotCandidates,
  type LooiRobotCandidate,
  type SavedLooiRobot,
} from "@/src/device-tools/looi-robot-autoconnect";
import {
  getLooiRobotRuntimeState,
  subscribeLooiRobotRuntimeState,
} from "@/src/device-tools/looi-robot";

const REALTIME_VOICE_ORDER = ["marin", "cedar", "coral", "verse", "sage", "shimmer", "alloy", "ash", "ballad", "echo"];
const CURATED_VOICES = [...REALTIME_VOICE_OPTIONS].sort(
  (a, b) => REALTIME_VOICE_ORDER.indexOf(a.id) - REALTIME_VOICE_ORDER.indexOf(b.id)
);

type SharedModelStatus = Awaited<ReturnType<typeof checkAllSherpaModelReadiness>>;

type RobotUiState = {
  saved: SavedLooiRobot | null;
  candidates: LooiRobotCandidate[];
  scanning: boolean;
  busy: boolean;
  result: string | null;
};

export default function SettingsScreen() {
  const { preferences, updatePreferences } = useUserStore();
  const [advanced, setAdvanced] = useState(false);
  const [openAiKeyConfigured, setOpenAiKeyConfigured] = useState(false);
  const [openAiKeyInput, setOpenAiKeyInput] = useState("");
  const [openAiKeyBusy, setOpenAiKeyBusy] = useState(false);
  const [openAiKeyResult, setOpenAiKeyResult] = useState<string | null>(null);
  const [openAiModels, setOpenAiModels] = useState<OpenAiRealtimeModel[]>([]);
  const [openAiModelsBusy, setOpenAiModelsBusy] = useState(false);
  const [openAiModelsResult, setOpenAiModelsResult] = useState<string | null>(null);
  const [voicePreviewBusy, setVoicePreviewBusy] = useState<string | null>(null);
  const [voicePreviewResult, setVoicePreviewResult] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<SharedModelStatus | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelProgress, setModelProgress] = useState<SherpaModelDownloadProgress | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [memoryStats, setMemoryStats] = useState<LocalMemoryStats | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupResult, setBackupResult] = useState<string | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<string | null>(null);
  const [robotUi, setRobotUi] = useState<RobotUiState>({ saved: null, candidates: [], scanning: false, busy: false, result: null });
  const [robotRuntime, setRobotRuntime] = useState(() => getLooiRobotRuntimeState());

  const refreshOpenAi = useCallback(() => {
    void hasOpenAiApiKey().then(setOpenAiKeyConfigured).catch(() => setOpenAiKeyConfigured(false));
  }, []);

  const refreshOpenAiModels = useCallback(async () => {
    setOpenAiModelsBusy(true);
    setOpenAiModelsResult(null);
    try {
      if (!(await hasOpenAiApiKey())) {
        setOpenAiModels([]);
        return;
      }
      const models = await listOpenAiRealtimeModels();
      const visibleModels = models.filter((model) => !isOfficiallyDeprecatedRealtimeModelId(model.id));
      setOpenAiModels(visibleModels);
      if (visibleModels.length === 0) {
        setOpenAiModelsResult("Для этого ключа поддерживаемые Realtime-модели не найдены");
        return;
      }
      const current = useUserStore.getState().preferences.realtimeModelId;
      if (!visibleModels.some((model) => model.id === current)) {
        const fallback = visibleModels.find((model) => model.id === DEFAULT_REALTIME_MODEL_ID) ?? visibleModels[0];
        updatePreferences({ realtimeModelId: fallback.id });
        setOpenAiModelsResult(`Выбрана доступная модель: ${formatRealtimeModelName(fallback.id)}`);
      } else {
        setOpenAiModelsResult(`Доступно моделей: ${visibleModels.length}`);
      }
    } catch (error) {
      setOpenAiModelsResult(`Ошибка списка моделей: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOpenAiModelsBusy(false);
    }
  }, [updatePreferences]);

  const refreshModels = useCallback(async () => {
    try {
      const next = await checkAllSherpaModelReadiness();
      setModelStatus(next);
      setModelError(null);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    }
  }, []);


  const refreshMemory = useCallback(async () => {
    try { setMemoryStats(await getLocalMemoryStats()); } catch { setMemoryStats(null); }
  }, []);


  const refreshRobot = useCallback(async () => {
    const saved = await getSavedLooiRobot().catch(() => null);
    setRobotUi((state) => ({ ...state, saved }));
    setRobotRuntime(getLooiRobotRuntimeState());
  }, []);

  useFocusEffect(useCallback(() => {
    recordDiagnosticEvent("navigation", "settings-focused");
    void voiceRuntime.suspendMainScreenConversation("settings-focused");
    refreshOpenAi();
    void refreshOpenAiModels();
    void refreshModels();
    void refreshMemory();
    void refreshRobot();
    return () => recordDiagnosticEvent("navigation", "settings-blurred");
  }, [refreshMemory, refreshModels, refreshOpenAi, refreshOpenAiModels, refreshRobot]));

  useEffect(() => subscribeLooiRobotRuntimeState(() => setRobotRuntime(getLooiRobotRuntimeState())), []);

  const selectConversationMode = useCallback((conversationMode: ConversationMode) => {
    updatePreferences({ conversationMode });
    recordDiagnosticEvent("runtime", "conversation-mode-selected", { conversationMode });
    void syncVoiceRuntime().catch((error) => recordDiagnosticEvent("runtime", "conversation-mode-sync-failed", {
      conversationMode,
      error: error instanceof Error ? error.message : String(error),
    }));
  }, [updatePreferences]);

  const saveKey = useCallback(async () => {
    if (openAiKeyBusy) return;
    setOpenAiKeyBusy(true);
    setOpenAiKeyResult(null);
    try {
      await saveOpenAiApiKey(validateOpenAiApiKey(openAiKeyInput));
      setOpenAiKeyInput("");
      setOpenAiKeyConfigured(true);
      setOpenAiKeyResult("✓ Ключ сохранён только на этом устройстве");
      void refreshOpenAiModels();
    } catch (error) {
      setOpenAiKeyResult(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setOpenAiKeyBusy(false); }
  }, [openAiKeyBusy, openAiKeyInput, refreshOpenAiModels]);

  const deleteKey = useCallback(() => {
    Alert.alert("Удалить OpenAI API key?", "Без него Realtime PCM не сможет начать разговор.", [
      { text: "Отмена", style: "cancel" },
      { text: "Удалить", style: "destructive", onPress: () => {
        setOpenAiKeyBusy(true);
        void clearOpenAiApiKey().then(() => {
          setOpenAiKeyConfigured(false);
          setOpenAiModels([]);
          setOpenAiModelsResult(null);
          setOpenAiKeyResult("Ключ удалён");
        }).finally(() => setOpenAiKeyBusy(false));
      } },
    ]);
  }, []);

  const previewVoice = useCallback(async (voiceId: string) => {
    if (voicePreviewBusy) return;
    if (!openAiKeyConfigured) {
      setVoicePreviewResult("Сначала сохраните OpenAI API key");
      return;
    }
    setVoicePreviewBusy(voiceId);
    setVoicePreviewResult(null);
    const wakewordFeedingWasEnabled = kwsAudioFeeder.diagnosticStatus.wakewordFeedingEnabled;
    kwsAudioFeeder.setWakewordFeedingEnabled(false);
    try {
      await playOpenAiRealtimeVoicePreview(voiceId, preferences.language);
      setVoicePreviewResult("✓ Preview воспроизведён");
    } catch (error) {
      setVoicePreviewResult(`Ошибка preview: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      kwsAudioFeeder.setWakewordFeedingEnabled(wakewordFeedingWasEnabled);
      setVoicePreviewBusy(null);
    }
  }, [openAiKeyConfigured, preferences.language, voicePreviewBusy]);

  const downloadModels = useCallback(async () => {
    if (modelBusy) return;
    setModelBusy(true); setModelError(null); setModelProgress(null);
    try {
      await downloadMissingSherpaModels(setModelProgress);
      await refreshModels();
      await syncVoiceRuntime();
    } catch (error) { setModelError(error instanceof Error ? error.message : String(error)); }
    finally { setModelBusy(false); }
  }, [modelBusy, refreshModels]);


  const scanRobot = useCallback(async () => {
    if (robotUi.scanning || robotUi.busy) return;
    setRobotUi((s) => ({ ...s, scanning: true, result: null }));
    try {
      const candidates = await scanLooiRobotCandidates();
      setRobotUi((s) => ({ ...s, candidates, result: candidates.length ? `Найдено: ${candidates.length}` : "LOOI не найден" }));
    } catch (error) {
      setRobotUi((s) => ({ ...s, result: error instanceof Error ? error.message : String(error) }));
    } finally { setRobotUi((s) => ({ ...s, scanning: false })); }
  }, [robotUi.busy, robotUi.scanning]);

  const connectRobot = useCallback(async (candidate?: LooiRobotCandidate) => {
    if (robotUi.busy) return;
    setRobotUi((s) => ({ ...s, busy: true, result: null }));
    try {
      if (candidate) await connectSelectedLooiRobot({ id: candidate.id, name: candidate.name });
      else await forceReconnectSavedLooiRobot();
      await refreshRobot();
      setRobotUi((s) => ({ ...s, result: "✓ LOOI подключён" }));
    } catch (error) {
      setRobotUi((s) => ({ ...s, result: error instanceof Error ? error.message : String(error) }));
    } finally { setRobotUi((s) => ({ ...s, busy: false })); }
  }, [refreshRobot, robotUi.busy]);

  const forgetRobot = useCallback(() => {
    Alert.alert("Забыть выбранного LOOI?", undefined, [
      { text: "Отмена", style: "cancel" },
      { text: "Удалить", style: "destructive", onPress: () => {
        setRobotUi((s) => ({ ...s, busy: true }));
        void clearSavedLooiRobot().then(refreshRobot).finally(() => setRobotUi((s) => ({ ...s, busy: false, candidates: [] })));
      } },
    ]);
  }, [refreshRobot]);

  const chooseBackup = useCallback(async () => {
    if (backupBusy) return;
    setBackupBusy(true); setBackupResult(null);
    try {
      const folder = await chooseLocalBackupFolder();
      setBackupResult(`Папка: ${folder.displayName || folder.providerName || "выбрана"}`);
    } catch (error) { setBackupResult(error instanceof Error ? error.message : String(error)); }
    finally { setBackupBusy(false); }
  }, [backupBusy]);

  const backupNow = useCallback(async () => {
    if (backupBusy) return;
    setBackupBusy(true); setBackupResult(null);
    try {
      const result = await backupLocalMemoryToSelectedFolder();
      setBackupResult(`✓ Backup: ${result.memoryCount} фактов · ${result.sessionCount} диалогов`);
    } catch (error) { setBackupResult(error instanceof Error ? error.message : String(error)); }
    finally { setBackupBusy(false); }
  }, [backupBusy]);

  const restoreNow = useCallback(() => {
    if (backupBusy) return;
    Alert.alert("Восстановить локальную память?", "Текущая локальная база будет объединена с backup.", [
      { text: "Отмена", style: "cancel" },
      { text: "Восстановить", onPress: () => {
        setBackupBusy(true); setBackupResult(null);
        void restoreLocalMemoryFromSelectedFolder().then(({ stats }) => {
          setBackupResult(`✓ Восстановлено: ${stats.memoryCount} фактов · ${stats.sessionCount} диалогов`);
          void refreshMemory();
        }).catch((error) => setBackupResult(error instanceof Error ? error.message : String(error))).finally(() => setBackupBusy(false));
      } },
    ]);
  }, [backupBusy, refreshMemory]);

  const forgetBackupFolder = useCallback(async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    try { await forgetLocalBackupFolder(); setBackupResult("Папка backup забыта"); }
    finally { setBackupBusy(false); }
  }, [backupBusy]);

  const exportDiagnostics = useCallback(async () => {
    if (diagnosticBusy) return;
    setDiagnosticBusy(true); setDiagnosticResult(null);
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error("Системное меню отправки недоступно");
      const uri = await writeCombinedDiagnosticExport();
      await withExternalActivityLease("diagnostic-package-share-sheet", () => Sharing.shareAsync(uri, { mimeType: "application/zip", dialogTitle: "Экспорт диагностики LOOI" }));
      setDiagnosticResult("ZIP подготовлен");
    } catch (error) { setDiagnosticResult(error instanceof Error ? error.message : String(error)); }
    finally { setDiagnosticBusy(false); }
  }, [diagnosticBusy]);

  const clearDiagnostics = useCallback(async () => {
    clearDiagnosticLog();
    setDiagnosticResult("Диагностика очищена");
  }, []);

  const backupFolder = getLocalBackupStorageSettings().folder;
  const sharedReady = Boolean(modelStatus?.asr.ready && modelStatus?.kws.ready && modelStatus?.vad.ready);
  const version = Constants.expoConfig?.version ?? "unknown";
  const curatedVoices = useMemo(() => CURATED_VOICES, []);
  const realtimeModels = useMemo(() => [...openAiModels].sort((a, b) => {
    const priority = (id: string) => id === DEFAULT_REALTIME_MODEL_ID ? 0 : id === "gpt-realtime-2.1" ? 1 : 2;
    return priority(a.id) - priority(b.id) || b.id.localeCompare(a.id, undefined, { numeric: true });
  }), [openAiModels]);
  const currentRealtimeModels = useMemo(
    () => realtimeModels.filter((model) => !isPreviousSupportedRealtimeModelId(model.id)),
    [realtimeModels]
  );
  const previousRealtimeModels = useMemo(
    () => realtimeModels.filter((model) => isPreviousSupportedRealtimeModelId(model.id)),
    [realtimeModels]
  );

  return (
    <DeviceShell title="Настройки" eyebrow="MY LOOI">
      <View style={styles.summaryGrid}>
        <Summary label="Режим" value={preferences.conversationMode === "realtime_pcm" ? "Realtime PCM" : preferences.conversationMode} ok={preferences.conversationMode === "realtime_pcm"} />
        <Summary label="OpenAI" value={openAiKeyConfigured ? "Ключ сохранён" : "Нужен ключ"} ok={openAiKeyConfigured} />
        <Summary label="Локальные" value={sharedReady ? "Готовы" : "Нужна проверка"} ok={sharedReady} />
        <Summary label="Робот" value={robotRuntime.connected ? "Подключён" : robotUi.saved ? "Сохранён" : "Не выбран"} ok={robotRuntime.connected} neutral={!robotRuntime.connected} />
      </View>

      <Section title="Разговор">
        <Text style={styles.help}>Realtime PCM — основной принятый тракт: app-owned AudioRecord → OpenAI WebSocket → app-owned PCM playback.</Text>
        <Choice selected={preferences.conversationMode === "realtime_pcm"} label="Realtime PCM" detail="Основной" onPress={() => selectConversationMode("realtime_pcm")} />
        <SwitchRow label="Обращение «LOOI / Макс»" value={preferences.wakeWordEnabled} onPress={() => updatePreferences({ wakeWordEnabled: !preferences.wakeWordEnabled })} />
      </Section>

      <Section title="Язык">
        <Text style={styles.label}>Что ожидаем услышать</Text>
        <ButtonRow>{LISTENING_LANGUAGE_OPTIONS.map((item) => <SmallChoice key={item.id} selected={preferences.listeningLanguage === item.id} label={item.shortLabel} onPress={() => updatePreferences({ listeningLanguage: item.id })} />)}</ButtonRow>
        <Text style={styles.label}>На каком языке отвечает LOOI</Text>
        <ButtonRow>{RESPONSE_LANGUAGE_OPTIONS.map((item) => <SmallChoice key={item.id} selected={preferences.language === item.id} label={item.shortLabel} onPress={() => updatePreferences({ language: item.id })} />)}</ButtonRow>
      </Section>

      <Section title="OpenAI">
        <Text style={styles.help}>Ключ хранится только в Android SecureStore и используется для прямого подключения к OpenAI Realtime.</Text>
        <TextInput value={openAiKeyInput} onChangeText={setOpenAiKeyInput} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder={openAiKeyConfigured ? "Новый OpenAI API key" : "OpenAI API key"} placeholderTextColor={looiTheme.muted} style={styles.input} />
        <ButtonRow>
          <Action label={openAiKeyBusy ? "Сохраняю…" : openAiKeyConfigured ? "Заменить" : "Сохранить"} onPress={saveKey} disabled={openAiKeyBusy || !openAiKeyInput.trim()} />
          {openAiKeyConfigured ? <Action label="Удалить" onPress={deleteKey} secondary /> : null}
        </ButtonRow>
        {openAiKeyResult ? <Text style={styles.result}>{openAiKeyResult}</Text> : null}
        <View style={styles.subCard}>
          <Text style={styles.label}>Realtime-модель</Text>
          <Text style={styles.help}>Список запрашивается у OpenAI для сохранённого API key. Цена — оценка минуты диалога: примерно 30 сек говорит человек и 30 сек LOOI.</Text>
          <Action label={openAiModelsBusy ? "Обновляю модели…" : "Обновить модели"} onPress={() => void refreshOpenAiModels()} disabled={openAiModelsBusy || !openAiKeyConfigured} secondary />
          {currentRealtimeModels.map((model) => {
            const cost = formatConversationCostPerMinute(model.id);
            const note = model.id === DEFAULT_REALTIME_MODEL_ID
              ? "Рекомендуем · Лучшее соотношение цены и качества"
              : model.id === "gpt-realtime-2.1"
                ? "Максимальное качество"
                : null;
            const tone = model.id === DEFAULT_REALTIME_MODEL_ID ? "recommended" : model.id === "gpt-realtime-2.1" ? "quality" : undefined;
            const detail = [cost ?? "Стоимость/мин пока неизвестна", note].filter(Boolean).join(" · ");
            return <Choice key={model.id} selected={preferences.realtimeModelId === model.id} label={formatRealtimeModelName(model.id)} detail={detail} tone={tone} onPress={() => updatePreferences({ realtimeModelId: model.id })} />;
          })}
          {previousRealtimeModels.length ? <View style={styles.previousModelsBox}>
            <Text style={styles.previousModelsTitle}>Предыдущие модели</Text>
            <Text style={styles.help}>Они всё ещё поддерживаются OpenAI, но относятся к предыдущему поколению. Можно выбрать для сравнения.</Text>
            {previousRealtimeModels.map((model) => {
              const cost = formatConversationCostPerMinute(model.id);
              const note = model.id === "gpt-realtime-2" ? "Предыдущая полная модель" : model.id === "gpt-realtime-1.5" ? "Предыдущая voice-модель" : null;
              const detail = [cost ?? "Стоимость/мин пока неизвестна", note].filter(Boolean).join(" · ");
              return <Choice key={model.id} selected={preferences.realtimeModelId === model.id} label={formatRealtimeModelName(model.id)} detail={detail} tone="previous" onPress={() => updatePreferences({ realtimeModelId: model.id })} />;
            })}
          </View> : null}
          {!openAiModelsBusy && openAiKeyConfigured && realtimeModels.length === 0 ? <Text style={styles.help}>Модели пока не загружены.</Text> : null}
          {openAiModelsResult ? <Text style={styles.result}>{openAiModelsResult}</Text> : null}
          <Text style={styles.help}>Фактическая стоимость зависит от соотношения речи, контекста и кэширования.</Text>
        </View>
      </Section>

      <Section title="Голос LOOI">
        <Text style={styles.help}>Выбор запоминается и применяется к новой Realtime-сессии. Preview использует тот же именованный OpenAI voice.</Text>
        {curatedVoices.map((voice) => <VoiceChoice key={voice.id} selected={preferences.ttsVoiceId === voice.id} label={voice.name} detail={`${voice.description}${voice.id === "marin" || voice.id === "cedar" ? " · рекомендуется OpenAI" : ""}`} onSelect={() => updatePreferences({ ttsVoiceId: voice.id })} onPreview={() => void previewVoice(voice.id)} previewing={voicePreviewBusy === voice.id} previewDisabled={Boolean(voicePreviewBusy) || !openAiKeyConfigured} />)}
        {voicePreviewResult ? <Text style={styles.result}>{voicePreviewResult}</Text> : null}
        <Text style={styles.label}>Скорость</Text>
        <ButtonRow>{TTS_SPEED_OPTIONS.map((speed) => <SmallChoice key={speed} selected={preferences.ttsSpeed === speed} label={`${speed}×`} onPress={() => updatePreferences({ ttsSpeed: speed })} />)}</ButtonRow>
      </Section>

      <Section title="Локальные модели">
        <ModelLine label="Shared STT" status={modelStatus?.asr} />
        <ModelLine label="Wake word" status={modelStatus?.kws} />
        <ModelLine label="VAD" status={modelStatus?.vad} />
        <ButtonRow><Action label={modelBusy ? "Загружаю…" : "Проверить"} onPress={() => void refreshModels()} disabled={modelBusy} secondary /><Action label="Скачать недостающее" onPress={downloadModels} disabled={modelBusy} /></ButtonRow>
        {modelProgress ? <Text style={styles.help}>{modelProgress.label} · {Math.round(modelProgress.progress * 100)}%</Text> : null}
        {modelError ? <Text style={styles.error}>{modelError}</Text> : null}
      </Section>

      <Section title="Робот LOOI">
        <Text style={styles.help}>{robotUi.saved ? `Сохранён: ${robotUi.saved.name}` : "Робот пока не выбран"} · BLE: {robotRuntime.connected ? "connected" : robotRuntime.connecting ? "connecting" : "offline"}</Text>
        <ButtonRow><Action label={robotUi.scanning ? "Ищу…" : "Найти LOOI"} onPress={scanRobot} disabled={robotUi.scanning || robotUi.busy} /><Action label="Переподключить" onPress={() => void connectRobot()} disabled={!robotUi.saved || robotUi.busy} secondary /></ButtonRow>
        {robotUi.candidates.map((candidate) => <Choice key={candidate.id} selected={candidate.selected} label={candidate.name} detail={`${candidate.rssi ?? "?"} dBm`} onPress={() => void connectRobot(candidate)} />)}
        {robotUi.saved ? <Action label="Забыть выбранного робота" onPress={forgetRobot} secondary /> : null}
        {robotUi.result ? <Text style={styles.result}>{robotUi.result}</Text> : null}
      </Section>

      <Section title="Память и backup">
        <Text style={styles.help}>{memoryStats ? `${memoryStats.memoryCount} фактов · ${memoryStats.sessionCount} диалогов · ${memoryStats.messageCount} сообщений` : "Считаю локальную базу…"}</Text>
        <Text style={styles.help}>Папка backup: {backupFolder?.displayName || backupFolder?.providerName || "не выбрана"}</Text>
        <ButtonRow><Action label="Выбрать папку" onPress={chooseBackup} disabled={backupBusy} secondary /><Action label="Backup сейчас" onPress={backupNow} disabled={backupBusy || !backupFolder} /><Action label="Восстановить" onPress={restoreNow} disabled={backupBusy || !backupFolder} secondary /></ButtonRow>
        {backupFolder ? <Action label="Забыть папку backup" onPress={forgetBackupFolder} disabled={backupBusy} secondary /> : null}
        {backupResult ? <Text style={styles.result}>{backupResult}</Text> : null}
      </Section>

      <View style={styles.sectionWide}>
        <Pressable onPress={() => setAdvanced(!advanced)} style={styles.advancedHeader}><Text style={styles.sectionTitle}>Advanced</Text><Text style={styles.value}>{advanced ? "Скрыть" : "Открыть"}</Text></Pressable>
        {advanced ? <View style={styles.card}>
          <Text style={styles.help}>WebRTC оставлен только как rollback/A-B. Он не является основным режимом.</Text>
          <Choice selected={preferences.conversationMode === "realtime"} label="Realtime WebRTC (legacy A/B)" detail="Fallback" onPress={() => selectConversationMode("realtime")} />
          <Text style={styles.help}>Диагностический журнал: {getDiagnosticLogEntries().length} записей. Микрофонные WAV больше не сохраняются.</Text>
          <ButtonRow><Action label={diagnosticBusy ? "Экспортирую…" : "Экспорт диагностики ZIP"} onPress={exportDiagnostics} disabled={diagnosticBusy} /><Action label="Очистить диагностику" onPress={() => void clearDiagnostics()} disabled={diagnosticBusy} secondary /></ButtonRow>
          {diagnosticResult ? <Text style={styles.result}>{diagnosticResult}</Text> : null}
        </View> : null}
      </View>

      <Text style={styles.version}>My LOOI {version} · local-first</Text>
    </DeviceShell>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><View style={styles.card}>{children}</View></View>; }
function Summary({ label, value, ok, neutral }: { label: string; value: string; ok: boolean; neutral?: boolean }) { return <View style={styles.summaryCard}><Text style={styles.summaryLabel}>{label}</Text><Text style={[styles.summaryValue, ok ? styles.ok : neutral ? styles.muted : styles.error]}>{value}</Text></View>; }
function Choice({ selected, label, detail, tone, onPress }: { selected: boolean; label: string; detail?: string; tone?: "recommended" | "quality" | "previous"; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.choice, tone === "recommended" && styles.choiceRecommended, tone === "quality" && styles.choiceQuality, tone === "previous" && styles.choicePrevious, selected && styles.choiceSelected]}><View style={styles.choiceDot}>{selected ? <View style={styles.choiceDotInner} /> : null}</View><View style={styles.choiceText}><Text style={styles.value}>{label}</Text>{detail ? <Text style={styles.help}>{detail}</Text> : null}</View></Pressable>; }
function VoiceChoice({ selected, label, detail, onSelect, onPreview, previewing, previewDisabled }: { selected: boolean; label: string; detail?: string; onSelect: () => void; onPreview: () => void; previewing: boolean; previewDisabled: boolean }) { return <View style={[styles.voiceChoice, selected && styles.choiceSelected]}><Pressable onPress={onSelect} style={styles.voiceSelect}><View style={styles.choiceDot}>{selected ? <View style={styles.choiceDotInner} /> : null}</View><View style={styles.choiceText}><Text style={styles.value}>{label}</Text>{detail ? <Text style={styles.help}>{detail}</Text> : null}</View></Pressable><Pressable onPress={onPreview} disabled={previewDisabled} style={[styles.previewButton, previewDisabled && styles.disabled]}><Text style={styles.previewText}>{previewing ? "…" : "▶ Preview"}</Text></Pressable></View>; }
function SmallChoice({ selected, label, onPress }: { selected: boolean; label: string; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.smallChoice, selected && styles.smallChoiceSelected]}><Text style={styles.value}>{selected ? `✓ ${label}` : label}</Text></Pressable>; }
function SwitchRow({ label, value, onPress }: { label: string; value: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={styles.switchRow}><Text style={styles.value}>{label}</Text><Text style={[styles.pill, value && styles.pillOn]}>{value ? "Вкл" : "Выкл"}</Text></Pressable>; }
function ButtonRow({ children }: { children: ReactNode }) { return <View style={styles.buttonRow}>{children}</View>; }
function Action({ label, onPress, disabled, secondary }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) { return <Pressable onPress={onPress} disabled={disabled} style={[styles.action, secondary && styles.actionSecondary, disabled && styles.disabled]}><Text style={secondary ? styles.actionSecondaryText : styles.actionText}>{label}</Text></Pressable>; }
function ModelLine({ label, status }: { label: string; status: SherpaModelCheck | null | undefined }) { return <View style={styles.modelLine}><Text style={styles.value}>{label}</Text><Text style={status?.ready ? styles.ok : styles.muted}>{status?.ready ? "Готово" : status ? "Не готово" : "Не проверено"}</Text></View>; }

const styles = StyleSheet.create({
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 12 },
  summaryCard: { flexGrow: 1, minWidth: 145, borderWidth: 1, borderColor: looiTheme.line, borderRadius: 18, backgroundColor: looiTheme.rail, padding: 14, gap: 4 },
  summaryLabel: { color: looiTheme.muted, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  summaryValue: { color: looiTheme.text, fontSize: 15, fontWeight: "800" },
  section: { marginBottom: 14 },
  sectionWide: { marginBottom: 14, borderWidth: 1, borderColor: looiTheme.line, borderRadius: 20, backgroundColor: looiTheme.rail, overflow: "hidden" },
  sectionTitle: { color: looiTheme.text, fontSize: 17, fontWeight: "800", marginBottom: 8 },
  card: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 20, backgroundColor: looiTheme.rail, padding: 14, gap: 10 },
  subCard: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: looiTheme.line, paddingTop: 12, gap: 10 },
  help: { color: looiTheme.muted, fontSize: 12, lineHeight: 17 },
  label: { color: looiTheme.muted, fontSize: 12, fontWeight: "700", marginTop: 4 },
  value: { color: looiTheme.text, fontSize: 13, fontWeight: "700" },
  choice: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: looiTheme.line, borderRadius: 14, padding: 11 },
  choiceRecommended: { borderColor: "rgba(77,231,180,0.62)", backgroundColor: "rgba(77,231,180,0.05)" },
  choiceQuality: { borderColor: "rgba(40,213,255,0.55)", backgroundColor: "rgba(40,213,255,0.045)" },
  choicePrevious: { borderColor: "rgba(255,209,102,0.24)" },
  previousModelsBox: { borderWidth: 1, borderColor: "rgba(255,209,102,0.35)", borderRadius: 16, padding: 10, gap: 8, backgroundColor: "rgba(255,209,102,0.025)" },
  previousModelsTitle: { color: looiTheme.warn, fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  voiceChoice: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: looiTheme.line, borderRadius: 14, overflow: "hidden" },
  voiceSelect: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, padding: 11 },
  previewButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: looiTheme.line },
  previewText: { color: looiTheme.cyan, fontSize: 12, fontWeight: "800" },
  choiceSelected: { borderColor: looiTheme.cyan, backgroundColor: "rgba(40,213,255,0.07)" },
  choiceDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: looiTheme.muted, alignItems: "center", justifyContent: "center" },
  choiceDotInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: looiTheme.cyan },
  choiceText: { flex: 1, gap: 2 },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  smallChoice: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  smallChoiceSelected: { borderColor: looiTheme.cyan, backgroundColor: "rgba(40,213,255,0.07)" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  pill: { color: looiTheme.muted, borderWidth: 1, borderColor: looiTheme.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, overflow: "hidden" },
  pillOn: { color: looiTheme.cyan, borderColor: looiTheme.cyan },
  input: { color: looiTheme.text, borderWidth: 1, borderColor: looiTheme.line, borderRadius: 14, backgroundColor: looiTheme.bg, paddingHorizontal: 12, paddingVertical: 10 },
  action: { borderRadius: 12, backgroundColor: looiTheme.cyan, paddingHorizontal: 13, paddingVertical: 9 },
  actionSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: looiTheme.line },
  actionText: { color: "#041319", fontWeight: "800", fontSize: 12 },
  actionSecondaryText: { color: looiTheme.text, fontWeight: "700", fontSize: 12 },
  disabled: { opacity: 0.35 },
  result: { color: looiTheme.text, fontSize: 12 },
  error: { color: looiTheme.danger },
  ok: { color: looiTheme.ok },
  muted: { color: looiTheme.muted },
  modelLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  advancedHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 14 },
  version: { color: looiTheme.muted, fontSize: 11, textAlign: "center", marginVertical: 12 },
});
