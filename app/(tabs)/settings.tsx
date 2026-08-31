import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Constants from "expo-constants";
import { useFocusEffect } from "expo-router";

import { DeviceShell } from "@/src/ui/DeviceShell";
import { looiTheme } from "@/src/ui/looi-theme";
import { useUserStore, type ConversationMode, type CustomVoiceCommandAction, type FacePaletteId, type FaceStyleId, type VoiceCommandLanguage } from "@/src/store/user";
import { voiceRuntime } from "@/src/perceivers/voice-runtime";
import { parseRealtimePhysicalCommand } from "@/src/voice/realtime-physical-command";
import { syncVoiceRuntime } from "@/src/core/app-bootstrap";
import { recordDiagnosticEvent, clearDiagnosticLog, getDiagnosticLogEntries } from "@/src/diagnostics/diagnostic-log";
import {
  chooseDiagnosticExportFolder,
  getDiagnosticExportFolder,
  saveCombinedDiagnosticExportToSelectedFolder,
  shareCombinedDiagnosticExport,
} from "@/src/diagnostics/diagnostic-export";
import { withExternalActivityLease } from "@/src/core/background-process-exit";
import { RESPONSE_LANGUAGE_OPTIONS } from "@/src/language/response-language";
import { LISTENING_LANGUAGE_OPTIONS } from "@/src/language/listening-language";
import { INTERFACE_LANGUAGE_OPTIONS } from "@/src/i18n/ui-language";
import { useUiText } from "@/src/i18n/use-ui-text";
import { getLocalizedModelDownloadStage, getLocalizedVoiceDescription } from "@/src/i18n/ui-strings";
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
import {
  canInstallMyLooiUpdate,
  checkForMyLooiUpdate,
  downloadAndVerifyMyLooiUpdate,
  installDownloadedMyLooiUpdate,
  openMyLooiInstallPermissionSettings,
  type DownloadedUpdate,
  type UpdateRelease,
} from "@/src/updates/github-release-updater";

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
  const { language: interfaceLanguage, t } = useUiText();
  const [advanced, setAdvanced] = useState(false);
  const [voicesExpanded, setVoicesExpanded] = useState(false);
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
  const [diagnosticFolder, setDiagnosticFolder] = useState(() => getDiagnosticExportFolder());
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateRelease, setUpdateRelease] = useState<UpdateRelease | null>(null);
  const [downloadedUpdate, setDownloadedUpdate] = useState<DownloadedUpdate | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [robotUi, setRobotUi] = useState<RobotUiState>({ saved: null, candidates: [], scanning: false, busy: false, result: null });
  const [robotRuntime, setRobotRuntime] = useState(() => getLooiRobotRuntimeState());

  const refreshOpenAi = useCallback(() => {
    void hasOpenAiApiKey().then(setOpenAiKeyConfigured).catch(() => setOpenAiKeyConfigured(false));
  }, [t]);

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
        setOpenAiModelsResult(t("settings.modelsNone"));
        return;
      }
      const current = useUserStore.getState().preferences.realtimeModelId;
      if (!visibleModels.some((model) => model.id === current)) {
        const fallback = visibleModels.find((model) => model.id === DEFAULT_REALTIME_MODEL_ID) ?? visibleModels[0];
        updatePreferences({ realtimeModelId: fallback.id });
        setOpenAiModelsResult(t("settings.modelsSelected", { model: formatRealtimeModelName(fallback.id) }));
      } else {
        setOpenAiModelsResult(t("settings.modelsAvailable", { count: visibleModels.length }));
      }
    } catch (error) {
      setOpenAiModelsResult(t("settings.modelsError", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setOpenAiModelsBusy(false);
    }
  }, [t, updatePreferences]);

  const refreshModels = useCallback(async () => {
    try {
      const next = await checkAllSherpaModelReadiness();
      setModelStatus(next);
      setModelError(null);
    } catch (error) {
      console.warn("[Settings] Local model readiness check failed:", error);
      setModelError(t("settings.modelsDownloadFailed"));
    }
  }, [t]);


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
      setOpenAiKeyResult(t("settings.keySavedLocal"));
      void refreshOpenAiModels();
    } catch (error) {
      setOpenAiKeyResult(t("common.error", { message: error instanceof Error ? error.message : String(error) }));
    } finally { setOpenAiKeyBusy(false); }
  }, [openAiKeyBusy, openAiKeyInput, refreshOpenAiModels, t]);

  const deleteKey = useCallback(() => {
    Alert.alert(t("settings.deleteKeyTitle"), t("settings.deleteKeyBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: () => {
        setOpenAiKeyBusy(true);
        void clearOpenAiApiKey().then(() => {
          setOpenAiKeyConfigured(false);
          setOpenAiModels([]);
          setOpenAiModelsResult(null);
          setOpenAiKeyResult(t("settings.keyDeleted"));
        }).finally(() => setOpenAiKeyBusy(false));
      } },
    ]);
  }, [t]);

  const previewVoice = useCallback(async (voiceId: string) => {
    if (voicePreviewBusy) return;
    if (!openAiKeyConfigured) {
      setVoicePreviewResult(t("settings.previewNeedKey"));
      return;
    }
    setVoicePreviewBusy(voiceId);
    setVoicePreviewResult(null);
    const wakewordFeedingWasEnabled = kwsAudioFeeder.diagnosticStatus.wakewordFeedingEnabled;
    kwsAudioFeeder.setWakewordFeedingEnabled(false);
    try {
      await playOpenAiRealtimeVoicePreview(voiceId, preferences.language);
      setVoicePreviewResult(t("settings.previewPlayed"));
    } catch (error) {
      setVoicePreviewResult(t("settings.previewError", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      kwsAudioFeeder.setWakewordFeedingEnabled(wakewordFeedingWasEnabled);
      setVoicePreviewBusy(null);
    }
  }, [openAiKeyConfigured, preferences.language, t, voicePreviewBusy]);

  const downloadModels = useCallback(async () => {
    if (modelBusy) return;
    setModelBusy(true); setModelError(null); setModelProgress(null);
    try {
      await downloadMissingSherpaModels(setModelProgress);
      await refreshModels();
      await syncVoiceRuntime();
    } catch (error) { console.warn("[Settings] Local model download failed:", error); setModelError(t("settings.modelsDownloadFailed")); }
    finally { setModelBusy(false); }
  }, [modelBusy, refreshModels, t]);


  const scanRobot = useCallback(async () => {
    if (robotUi.scanning || robotUi.busy) return;
    setRobotUi((s) => ({ ...s, scanning: true, result: null }));
    try {
      const candidates = await scanLooiRobotCandidates();
      setRobotUi((s) => ({ ...s, candidates, result: candidates.length ? t("settings.robotFound", { count: candidates.length }) : t("settings.robotNotFound") }));
    } catch (error) {
      setRobotUi((s) => ({ ...s, result: error instanceof Error ? error.message : String(error) }));
    } finally { setRobotUi((s) => ({ ...s, scanning: false })); }
  }, [robotUi.busy, robotUi.scanning, t]);

  const connectRobot = useCallback(async (candidate?: LooiRobotCandidate) => {
    if (robotUi.busy) return;
    setRobotUi((s) => ({ ...s, busy: true, result: null }));
    try {
      if (candidate) await connectSelectedLooiRobot({ id: candidate.id, name: candidate.name });
      else await forceReconnectSavedLooiRobot();
      await refreshRobot();
      setRobotUi((s) => ({ ...s, result: t("settings.robotConnected") }));
    } catch (error) {
      setRobotUi((s) => ({ ...s, result: error instanceof Error ? error.message : String(error) }));
    } finally { setRobotUi((s) => ({ ...s, busy: false })); }
  }, [refreshRobot, robotUi.busy, t]);

  const forgetRobot = useCallback(() => {
    Alert.alert(t("settings.forgetRobotTitle"), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: () => {
        setRobotUi((s) => ({ ...s, busy: true }));
        void clearSavedLooiRobot().then(refreshRobot).finally(() => setRobotUi((s) => ({ ...s, busy: false, candidates: [] })));
      } },
    ]);
  }, [refreshRobot, t]);

  const chooseBackup = useCallback(async () => {
    if (backupBusy) return;
    setBackupBusy(true); setBackupResult(null);
    try {
      const folder = await chooseLocalBackupFolder();
      setBackupResult(t("settings.backupFolderChosen", { folder: folder.displayName || folder.providerName || t("common.selected") }));
    } catch (error) { setBackupResult(error instanceof Error ? error.message : String(error)); }
    finally { setBackupBusy(false); }
  }, [backupBusy, t]);

  const backupNow = useCallback(async () => {
    if (backupBusy) return;
    setBackupBusy(true); setBackupResult(null);
    try {
      const result = await backupLocalMemoryToSelectedFolder();
      setBackupResult(t("settings.backupDone", { facts: result.memoryCount, sessions: result.sessionCount }));
    } catch (error) { setBackupResult(error instanceof Error ? error.message : String(error)); }
    finally { setBackupBusy(false); }
  }, [backupBusy, t]);

  const restoreNow = useCallback(() => {
    if (backupBusy) return;
    Alert.alert(t("settings.restoreLocalTitle"), t("settings.restoreLocalBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.restore"), onPress: () => {
        setBackupBusy(true); setBackupResult(null);
        void restoreLocalMemoryFromSelectedFolder().then(({ stats }) => {
          setBackupResult(t("settings.restoreDone", { facts: stats.memoryCount, sessions: stats.sessionCount }));
          void refreshMemory();
        }).catch((error) => setBackupResult(error instanceof Error ? error.message : String(error))).finally(() => setBackupBusy(false));
      } },
    ]);
  }, [backupBusy, refreshMemory, t]);

  const forgetBackupFolder = useCallback(async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    try { await forgetLocalBackupFolder(); setBackupResult(t("settings.backupFolderForgotten")); }
    finally { setBackupBusy(false); }
  }, [backupBusy, t]);

  const shareDiagnostics = useCallback(async () => {
    if (diagnosticBusy) return;
    setDiagnosticBusy(true); setDiagnosticResult(null);
    try {
      await withExternalActivityLease("diagnostic-package-share", () => shareCombinedDiagnosticExport(t("settings.shareDialogTitle")));
      setDiagnosticResult(t("settings.diagnosticsShared"));
    } catch (error) { setDiagnosticResult(error instanceof Error ? error.message : String(error)); }
    finally { setDiagnosticBusy(false); }
  }, [diagnosticBusy, t]);

  const chooseDiagnosticFolder = useCallback(async () => {
    if (diagnosticBusy) return;
    setDiagnosticBusy(true); setDiagnosticResult(null);
    try {
      const folder = await chooseDiagnosticExportFolder();
      setDiagnosticFolder(folder);
      setDiagnosticResult(t("settings.backupFolderChosen", { folder: folder.displayName || folder.providerName || t("common.selected") }));
    } catch (error) { setDiagnosticResult(error instanceof Error ? error.message : String(error)); }
    finally { setDiagnosticBusy(false); }
  }, [diagnosticBusy, t]);

  const saveDiagnosticsToFolder = useCallback(async () => {
    if (diagnosticBusy || !diagnosticFolder) return;
    setDiagnosticBusy(true); setDiagnosticResult(null);
    try {
      const file = await saveCombinedDiagnosticExportToSelectedFolder();
      setDiagnosticResult(t("settings.savedToFolder", { name: file.name }));
    } catch (error) { setDiagnosticResult(error instanceof Error ? error.message : String(error)); }
    finally { setDiagnosticBusy(false); }
  }, [diagnosticBusy, diagnosticFolder, t]);

  const clearDiagnostics = useCallback(async () => {
    clearDiagnosticLog();
    setDiagnosticResult(t("settings.diagnosticsCleared"));
  }, [t]);

  const checkUpdate = useCallback(async () => {
    if (updateBusy) return;
    setUpdateBusy(true); setUpdateResult(null); setDownloadedUpdate(null);
    try {
      const release = await checkForMyLooiUpdate();
      setUpdateRelease(release);
      setUpdateResult(release.updateAvailable
        ? t("settings.updateFound", { version: release.version })
        : t("settings.latestVersion", { version: release.currentVersion }));
    } catch (error) {
      setUpdateRelease(null);
      setUpdateResult(error instanceof Error ? error.message : String(error));
    } finally { setUpdateBusy(false); }
  }, [t, updateBusy]);

  const downloadUpdate = useCallback(async () => {
    if (updateBusy || !updateRelease?.updateAvailable) return;
    setUpdateBusy(true); setUpdateResult(t("settings.downloadingVersion", { version: updateRelease.version }));
    try {
      const update = await downloadAndVerifyMyLooiUpdate(updateRelease);
      setDownloadedUpdate(update);
      setUpdateResult(t("settings.updateVerified", { version: update.release.version }));
    } catch (error) {
      setDownloadedUpdate(null);
      setUpdateResult(error instanceof Error ? error.message : String(error));
    } finally { setUpdateBusy(false); }
  }, [t, updateBusy, updateRelease]);

  const installUpdate = useCallback(async () => {
    if (updateBusy || !downloadedUpdate) return;
    setUpdateBusy(true); setUpdateResult(null);
    try {
      if (!(await canInstallMyLooiUpdate())) {
        setUpdateResult(t("settings.installBlocked"));
        return;
      }
      await withExternalActivityLease("app-update-package-installer", () => installDownloadedMyLooiUpdate(downloadedUpdate));
      setUpdateResult(t("settings.installerOpened"));
    } catch (error) {
      setUpdateResult(error instanceof Error ? error.message : String(error));
    } finally { setUpdateBusy(false); }
  }, [downloadedUpdate, t, updateBusy]);

  const openInstallSettings = useCallback(async () => {
    try {
      await withExternalActivityLease("app-update-install-permission", () => openMyLooiInstallPermissionSettings());
    } catch (error) {
      setUpdateResult(error instanceof Error ? error.message : String(error));
    }
  }, [t]);

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

  const setCameraAttentionEnabled = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      updatePreferences({ cameraAttentionEnabled: false });
      return;
    }
    if (Platform.OS !== "android") {
      Alert.alert(t("settings.cameraAttentionPermissionTitle"), t("settings.cameraAttentionAndroidOnly"));
      return;
    }
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
    if (result === PermissionsAndroid.RESULTS.GRANTED) {
      updatePreferences({ cameraAttentionEnabled: true });
      return;
    }
    Alert.alert(t("settings.cameraAttentionPermissionTitle"), t("settings.cameraAttentionPermissionBody"));
  }, [t, updatePreferences]);

  return (
    <DeviceShell title={t("settings.title")} eyebrow="MY LOOI">
      <View style={styles.summaryGrid}>
        <Summary label={t("settings.summary.mode")} value={preferences.conversationMode === "realtime_pcm" ? "Realtime PCM" : preferences.conversationMode} ok={preferences.conversationMode === "realtime_pcm"} />
        <Summary label="OpenAI" value={openAiKeyConfigured ? t("settings.summary.keySaved") : t("settings.summary.keyNeeded")} ok={openAiKeyConfigured} />
        <Summary label={t("settings.summary.local")} value={sharedReady ? t("settings.summary.localReady") : t("settings.summary.localCheck")} ok={sharedReady} />
        <Summary label={t("settings.summary.robot")} value={robotRuntime.connected ? t("settings.summary.robotConnected") : robotUi.saved ? t("settings.summary.robotSaved") : t("settings.summary.robotNone")} ok={robotRuntime.connected} neutral={!robotRuntime.connected} />
      </View>

      <Section title={t("settings.conversation")}>
        <Text style={styles.help}>{t("settings.conversationHelp")}</Text>
        <Choice selected={preferences.conversationMode === "realtime_pcm"} label="Realtime PCM" detail={t("settings.primary")} onPress={() => selectConversationMode("realtime_pcm")} />
        <SwitchRow label={t("settings.addressWake")} value={preferences.wakeWordEnabled} onPress={() => updatePreferences({ wakeWordEnabled: !preferences.wakeWordEnabled })} />
      </Section>

      <Section title={t("settings.language")}>
        <Text style={styles.label}>{t("settings.interfaceLanguage")}</Text>
        <ButtonRow>{INTERFACE_LANGUAGE_OPTIONS.map((item) => <SmallChoice key={item.id} selected={preferences.interfaceLanguage === item.id} label={`${item.shortLabel} · ${item.label}`} onPress={() => updatePreferences({ interfaceLanguage: item.id })} />)}</ButtonRow>
        <Text style={styles.label}>{t("settings.listeningLanguage")}</Text>
        <ButtonRow>{LISTENING_LANGUAGE_OPTIONS.map((item) => <SmallChoice key={item.id} selected={preferences.listeningLanguage === item.id} label={item.shortLabel} onPress={() => updatePreferences({ listeningLanguage: item.id })} />)}</ButtonRow>
        <Text style={styles.label}>{t("settings.responseLanguage")}</Text>
        <ButtonRow>{RESPONSE_LANGUAGE_OPTIONS.map((item) => <SmallChoice key={item.id} selected={preferences.language === item.id} label={item.shortLabel} onPress={() => updatePreferences({ language: item.id })} />)}</ButtonRow>
      </Section>

      <Section title="OpenAI">
        <Text style={styles.help}>{t("settings.openAiHelp")}</Text>
        <TextInput value={openAiKeyInput} onChangeText={setOpenAiKeyInput} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder={openAiKeyConfigured ? t("settings.newKey") : "OpenAI API key"} placeholderTextColor={looiTheme.muted} style={styles.input} />
        <ButtonRow>
          <Action label={openAiKeyBusy ? t("settings.saving") : openAiKeyConfigured ? t("common.replace") : t("common.save")} onPress={saveKey} disabled={openAiKeyBusy || !openAiKeyInput.trim()} />
          {openAiKeyConfigured ? <Action label={t("common.delete")} onPress={deleteKey} secondary /> : null}
        </ButtonRow>
        {openAiKeyResult ? <Text style={styles.result}>{openAiKeyResult}</Text> : null}
        <View style={styles.subCard}>
          <Text style={styles.label}>{t("settings.model")}</Text>
          <Text style={styles.help}>{t("settings.modelsHelp")}</Text>
          <Action label={openAiModelsBusy ? t("settings.refreshingModels") : t("settings.refreshModels")} onPress={() => void refreshOpenAiModels()} disabled={openAiModelsBusy || !openAiKeyConfigured} secondary />
          {currentRealtimeModels.map((model) => {
            const cost = formatConversationCostPerMinute(model.id, interfaceLanguage);
            const note = model.id === DEFAULT_REALTIME_MODEL_ID
              ? t("settings.modelRecommended")
              : model.id === "gpt-realtime-2.1"
                ? t("settings.modelQuality")
                : null;
            const tone = model.id === DEFAULT_REALTIME_MODEL_ID ? "recommended" : model.id === "gpt-realtime-2.1" ? "quality" : undefined;
            const detail = [cost ?? t("settings.costUnknown"), note].filter(Boolean).join(" · ");
            return <Choice key={model.id} selected={preferences.realtimeModelId === model.id} label={formatRealtimeModelName(model.id)} detail={detail} tone={tone} onPress={() => updatePreferences({ realtimeModelId: model.id })} />;
          })}
          {previousRealtimeModels.length ? <View style={styles.previousModelsBox}>
            <Text style={styles.previousModelsTitle}>{t("settings.previousModels")}</Text>
            <Text style={styles.help}>{t("settings.previousModelsHelp")}</Text>
            {previousRealtimeModels.map((model) => {
              const cost = formatConversationCostPerMinute(model.id, interfaceLanguage);
              const note = model.id === "gpt-realtime-2" ? t("settings.previousFullModel") : model.id === "gpt-realtime-1.5" ? t("settings.previousVoiceModel") : null;
              const detail = [cost ?? t("settings.costUnknown"), note].filter(Boolean).join(" · ");
              return <Choice key={model.id} selected={preferences.realtimeModelId === model.id} label={formatRealtimeModelName(model.id)} detail={detail} tone="previous" onPress={() => updatePreferences({ realtimeModelId: model.id })} />;
            })}
          </View> : null}
          {!openAiModelsBusy && openAiKeyConfigured && realtimeModels.length === 0 ? <Text style={styles.help}>{t("settings.modelsNotLoaded")}</Text> : null}
          {openAiModelsResult ? <Text style={styles.result}>{openAiModelsResult}</Text> : null}
          <Text style={styles.help}>{t("settings.costDisclaimer")}</Text>
        </View>
      </Section>

      <Section title={t("settings.voice")}>
        <Text style={styles.help}>{t("settings.voiceHelp")}</Text>
        <DisclosureRow label={t("settings.voiceSelected", { voice: curatedVoices.find((voice) => voice.id === preferences.ttsVoiceId)?.name ?? preferences.ttsVoiceId })} expanded={voicesExpanded} onPress={() => setVoicesExpanded((value) => !value)} />
        {voicesExpanded ? <View style={styles.disclosureBody}>
          {curatedVoices.map((voice) => <VoiceChoice key={voice.id} selected={preferences.ttsVoiceId === voice.id} label={voice.name} detail={`${getLocalizedVoiceDescription(interfaceLanguage, voice.id, voice.description)}${voice.id === "marin" || voice.id === "cedar" ? ` · ${t("settings.voiceRecommended")}` : ""}`} onSelect={() => updatePreferences({ ttsVoiceId: voice.id })} onPreview={() => void previewVoice(voice.id)} previewing={voicePreviewBusy === voice.id} previewDisabled={Boolean(voicePreviewBusy) || !openAiKeyConfigured} />)}
          {voicePreviewResult ? <Text style={styles.result}>{voicePreviewResult}</Text> : null}
        </View> : null}
        <Text style={styles.label}>{t("settings.speed")}</Text>
        <ButtonRow>{TTS_SPEED_OPTIONS.map((speed) => <SmallChoice key={speed} selected={preferences.ttsSpeed === speed} label={`${speed}×`} onPress={() => updatePreferences({ ttsSpeed: speed })} />)}</ButtonRow>
      </Section>

      <VoiceCommandsSettings />
      <FaceAppearanceSettings />

      <Section title={t("settings.localModels")}>
        <ModelLine label={t("settings.sharedStt")} status={modelStatus?.asr} />
        <ModelLine label={t("settings.wakeWord")} status={modelStatus?.kws} />
        <ModelLine label={t("settings.vad")} status={modelStatus?.vad} />
        <ButtonRow><Action label={modelBusy ? t("onboarding.downloading") : t("settings.check")} onPress={() => void refreshModels()} disabled={modelBusy} secondary /><Action label={t("settings.downloadMissing")} onPress={downloadModels} disabled={modelBusy} /></ButtonRow>
        {modelProgress ? <Text style={styles.help}>{getLocalizedModelDownloadStage(interfaceLanguage, modelProgress.stage, modelProgress.label)} · {Math.round(modelProgress.progress * 100)}%</Text> : null}
        {modelError ? <Text style={styles.error}>{modelError}</Text> : null}
      </Section>

      <Section title={t("settings.robot")}>
        <Text style={styles.help}>{robotUi.saved ? t("settings.robotSaved", { name: robotUi.saved.name }) : t("settings.robotNotSelected")} · BLE: {robotRuntime.connected ? "connected" : robotRuntime.connecting ? "connecting" : "offline"}</Text>
        <ButtonRow><Action label={robotUi.scanning ? t("settings.searching") : t("settings.findLooi")} onPress={scanRobot} disabled={robotUi.scanning || robotUi.busy} /><Action label={t("settings.reconnect")} onPress={() => void connectRobot()} disabled={!robotUi.saved || robotUi.busy} secondary /></ButtonRow>
        <View style={styles.subCard}>
          <Text style={styles.label}>{t("settings.ambientMotion")}</Text>
          <Text style={styles.help}>{t("settings.ambientMotionHelp")}</Text>
          <ButtonRow>
            <SmallChoice selected={preferences.ambientMotionLevel === "off"} label={t("settings.ambientMotionOff")} onPress={() => updatePreferences({ ambientMotionLevel: "off" })} />
            <SmallChoice selected={preferences.ambientMotionLevel === "subtle"} label={t("settings.ambientMotionSubtle")} onPress={() => updatePreferences({ ambientMotionLevel: "subtle" })} />
            <SmallChoice selected={preferences.ambientMotionLevel === "normal"} label={t("settings.ambientMotionNormal")} onPress={() => updatePreferences({ ambientMotionLevel: "normal" })} />
            <SmallChoice selected={preferences.ambientMotionLevel === "lively"} label={t("settings.ambientMotionLively")} onPress={() => updatePreferences({ ambientMotionLevel: "lively" })} />
          </ButtonRow>
        </View>
        <View style={styles.subCard}>
          <Text style={styles.label}>{t("settings.cameraAttention")}</Text>
          <Text style={styles.help}>{t("settings.cameraAttentionHelp")}</Text>
          <ButtonRow>
            <SmallChoice selected={!preferences.cameraAttentionEnabled} label={t("common.off")} onPress={() => void setCameraAttentionEnabled(false)} />
            <SmallChoice selected={preferences.cameraAttentionEnabled} label={t("common.on")} onPress={() => void setCameraAttentionEnabled(true)} />
          </ButtonRow>
        </View>
        {robotUi.candidates.map((candidate) => <Choice key={candidate.id} selected={candidate.selected} label={candidate.name} detail={`${candidate.rssi ?? "?"} dBm`} onPress={() => void connectRobot(candidate)} />)}
        {robotUi.saved ? <Action label={t("settings.forgetRobot")} onPress={forgetRobot} secondary /> : null}
        {robotUi.result ? <Text style={styles.result}>{robotUi.result}</Text> : null}
      </Section>

      <Section title={t("settings.memoryBackup")}>
        <Text style={styles.help}>{memoryStats ? t("settings.memoryStats", { facts: memoryStats.memoryCount, sessions: memoryStats.sessionCount, messages: memoryStats.messageCount }) : t("settings.memoryCounting")}</Text>
        <Text style={styles.help}>{t("settings.backupFolder", { folder: backupFolder?.displayName || backupFolder?.providerName || t("common.notSelected") })}</Text>
        <ButtonRow><Action label={t("settings.chooseFolder")} onPress={chooseBackup} disabled={backupBusy} secondary /><Action label={t("settings.backupNow")} onPress={backupNow} disabled={backupBusy || !backupFolder} /><Action label={t("common.restore")} onPress={restoreNow} disabled={backupBusy || !backupFolder} secondary /></ButtonRow>
        {backupFolder ? <Action label={t("settings.forgetBackupFolder")} onPress={forgetBackupFolder} disabled={backupBusy} secondary /> : null}
        {backupResult ? <Text style={styles.result}>{backupResult}</Text> : null}
      </Section>

      <Section title={t("settings.diagnostics")}>
        <Text style={styles.help}>{t("settings.diagnosticsHelp", { count: getDiagnosticLogEntries().length })}</Text>
        <ButtonRow>
          <Action label={diagnosticBusy ? t("common.wait") : t("settings.shareZip")} onPress={() => void shareDiagnostics()} disabled={diagnosticBusy} />
        </ButtonRow>
        <Text style={styles.help}>{t("settings.localFolder", { folder: diagnosticFolder?.displayName || diagnosticFolder?.providerName || t("common.notSelected") })}</Text>
        <ButtonRow>
          <Action label={t("settings.chooseLocalFolder")} onPress={() => void chooseDiagnosticFolder()} disabled={diagnosticBusy} secondary />
          <Action label={t("settings.saveLocal")} onPress={() => void saveDiagnosticsToFolder()} disabled={diagnosticBusy || !diagnosticFolder} />
        </ButtonRow>
        <Action label={t("settings.clearDiagnostics")} onPress={() => void clearDiagnostics()} disabled={diagnosticBusy} secondary />
        {diagnosticResult ? <Text style={styles.result}>{diagnosticResult}</Text> : null}
      </Section>

      <Section title={t("settings.updates")}>
        <Text style={styles.help}>{t("settings.currentVersion", { version })}</Text>
        {updateRelease?.updateAvailable ? <Text style={styles.value}>{t("settings.updateAvailable", { version: updateRelease.version })}</Text> : null}
        <ButtonRow>
          <Action label={updateBusy ? t("common.wait") : t("settings.checkUpdates")} onPress={() => void checkUpdate()} disabled={updateBusy} secondary />
          {updateRelease?.updateAvailable && !downloadedUpdate ? <Action label={t("settings.downloadVersion", { version: updateRelease.version })} onPress={() => void downloadUpdate()} disabled={updateBusy} /> : null}
          {downloadedUpdate ? <Action label={t("settings.installVersion", { version: downloadedUpdate.release.version })} onPress={() => void installUpdate()} disabled={updateBusy} /> : null}
        </ButtonRow>
        {downloadedUpdate ? <Action label={t("settings.installSettings")} onPress={() => void openInstallSettings()} disabled={updateBusy} secondary /> : null}
        {updateResult ? <Text style={styles.result}>{updateResult}</Text> : null}
      </Section>

      <View style={styles.sectionWide}>
        <Pressable onPress={() => setAdvanced(!advanced)} style={styles.advancedHeader}><Text style={styles.sectionTitle}>{t("settings.advanced")}</Text><Text style={styles.value}>{advanced ? t("common.hide") : t("common.open")}</Text></Pressable>
        {advanced ? <View style={styles.card}>
          <Text style={styles.help}>{t("settings.webrtcHelp")}</Text>
          <Choice selected={preferences.conversationMode === "realtime"} label="Realtime WebRTC (legacy A/B)" detail={t("common.fallback")} onPress={() => selectConversationMode("realtime")} />
        </View> : null}
      </View>

      <Text style={styles.version}>My LOOI {version} · {t("settings.localFirst")}</Text>
    </DeviceShell>
  );
}


const FACE_STYLE_OPTIONS: FaceStyleId[] = ["classic", "soft", "playful", "fringe", "cowboy", "bandana", "sharp"];
const FACE_PALETTE_OPTIONS: FacePaletteId[] = ["cyan", "rose", "lime", "amber", "violet"];
const FACE_PALETTE_SWATCHES: Record<FacePaletteId, [string, string]> = {
  cyan: ["#54DCF2", "#4050E8"],
  rose: ["#FF8BD1", "#8D6BFF"],
  lime: ["#9EF06A", "#2C9CFF"],
  amber: ["#FFB454", "#FF5F6D"],
  violet: ["#B99AFF", "#596BFF"],
};

function FaceAppearanceSettings() {
  const { preferences, updatePreferences } = useUserStore();
  const { t } = useUiText();
  const [expanded, setExpanded] = useState(false);
  const [openPart, setOpenPart] = useState<"style" | "palette" | null>(null);
  const selectedStyle = t(`settings.faceStyle.${preferences.faceStyle}` as any);
  const selectedPalette = t(`settings.facePalette.${preferences.facePalette}` as any);

  return <Section title={t("settings.appearance")}>
    <Text style={styles.help}>{t("settings.appearanceHelp")}</Text>
    <DisclosureRow
      label={t("settings.faceAppearanceSelected", { style: selectedStyle, palette: selectedPalette })}
      expanded={expanded}
      onPress={() => { setExpanded((value) => !value); setOpenPart(null); }}
    />
    {expanded ? <View style={styles.disclosureBody}>
      <DisclosureRow
        label={t("settings.faceStyleSelected", { style: selectedStyle })}
        expanded={openPart === "style"}
        onPress={() => setOpenPart(openPart === "style" ? null : "style")}
        compact
      />
      {openPart === "style" ? <View style={styles.disclosureBody}>
        {FACE_STYLE_OPTIONS.map((style) => <Choice
          key={style}
          selected={preferences.faceStyle === style}
          label={t(`settings.faceStyle.${style}` as any)}
          detail={t(`settings.faceStyle.${style}.help` as any)}
          onPress={() => updatePreferences({ faceStyle: style })}
        />)}
      </View> : null}

      <DisclosureRow
        label={t("settings.facePaletteSelected", { palette: selectedPalette })}
        expanded={openPart === "palette"}
        onPress={() => setOpenPart(openPart === "palette" ? null : "palette")}
        compact
      />
      {openPart === "palette" ? <View style={styles.disclosureBody}>
        {FACE_PALETTE_OPTIONS.map((palette) => <PaletteChoice
          key={palette}
          selected={preferences.facePalette === palette}
          label={t(`settings.facePalette.${palette}` as any)}
          colors={FACE_PALETTE_SWATCHES[palette]}
          onPress={() => updatePreferences({ facePalette: palette })}
        />)}
      </View> : null}
      <Text style={styles.help}>{t("settings.faceAppearancePreviewHelp")}</Text>
    </View> : null}
  </Section>;
}

function PaletteChoice({ selected, label, colors, onPress }: { selected: boolean; label: string; colors: [string, string]; onPress: () => void }) {
  return <Pressable onPress={onPress} style={[styles.choice, selected && styles.choiceSelected]}>
    <View style={styles.paletteChoiceRow}>
      <View style={styles.paletteSwatches}>
        <View style={[styles.paletteSwatch, { backgroundColor: colors[0] }]} />
        <View style={[styles.paletteSwatch, styles.paletteSwatchOverlap, { backgroundColor: colors[1] }]} />
      </View>
      <Text style={styles.value}>{label}</Text>
    </View>
  </Pressable>;
}

const VOICE_COMMAND_ACTIONS: CustomVoiceCommandAction[] = [
  "emergency_stop", "forward", "backward", "left", "right", "turn_around", "nod", "dance", "sleep",
];

function VoiceCommandsSettings() {
  const { preferences, updatePreferences } = useUserStore();
  const { t } = useUiText();
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftLanguage, setDraftLanguage] = useState<VoiceCommandLanguage>(preferences.listeningLanguage);
  const [aliasDraft, setAliasDraft] = useState("");
  const [recognitionDraft, setRecognitionDraft] = useState("");
  const [recognitionExpanded, setRecognitionExpanded] = useState(false);
  const [customPhrasesExpanded, setCustomPhrasesExpanded] = useState(false);
  const [robotNameDraft, setRobotNameDraft] = useState(preferences.robotName);
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  const updateStringList = (key: "robotAddressAliases" | "robotAddressRecognitionAliases", next: string[]) => {
    updatePreferences({ [key]: next } as any);
  };

  const addAddress = (recognition: boolean) => {
    const value = (recognition ? recognitionDraft : aliasDraft).trim();
    if (value.length < 2) return;
    const key = recognition ? "robotAddressRecognitionAliases" : "robotAddressAliases";
    const current = preferences[key];
    if (!current.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase()) && value.toLocaleLowerCase() !== preferences.robotName.toLocaleLowerCase()) {
      updateStringList(key, [...current, value]);
    }
    recognition ? setRecognitionDraft("") : setAliasDraft("");
  };

  const phraseConflict = (text: string, action: CustomVoiceCommandAction): string | null => {
    const normalized = text.trim().toLocaleLowerCase();
    if (normalized.length < 3) return t("settings.voiceCommandsTooShort");
    if (["да", "нет", "ок", "okay", "yes", "no", "добре", "так"].includes(normalized)) return t("settings.voiceCommandsTooGeneric");
    for (const [otherAction, phrases] of Object.entries(preferences.customVoiceCommands)) {
      if (otherAction === action) continue;
      if (phrases.some((item) => item.language === draftLanguage && item.text.trim().toLocaleLowerCase() === normalized)) {
        return t("settings.voiceCommandsConflict", { action: t(`settings.voiceAction.${otherAction}` as any) });
      }
    }
    return null;
  };

  const addPhrase = (action: CustomVoiceCommandAction) => {
    const text = draft.trim();
    const conflict = phraseConflict(text, action);
    if (conflict) { Alert.alert(t("settings.voiceCommandsCannotAdd"), conflict); return; }
    const current = preferences.customVoiceCommands[action];
    if (current.some((item) => item.language === draftLanguage && item.text.toLocaleLowerCase() === text.toLocaleLowerCase())) return;
    updatePreferences({ customVoiceCommands: {
      ...preferences.customVoiceCommands,
      [action]: [...current, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, language: draftLanguage }],
    }});
    setDraft("");
  };

  const removePhrase = (action: CustomVoiceCommandAction, id: string) => {
    updatePreferences({ customVoiceCommands: {
      ...preferences.customVoiceCommands,
      [action]: preferences.customVoiceCommands[action].filter((item) => item.id !== id),
    }});
  };

  const customPhraseCount = VOICE_COMMAND_ACTIONS.reduce(
    (count, action) => count + preferences.customVoiceCommands[action].length,
    0
  );

  const runSafeTest = () => {
    const parsed = parseRealtimePhysicalCommand(testText, preferences);
    if (!parsed) { setTestResult(t("settings.voiceCommandsTestNoMatch")); return; }
    const result = parsed.kind === "emergency-stop" ? t("settings.voiceAction.emergency_stop") : parsed.command.kind === "move"
      ? parsed.command.direction === "forward" ? t("settings.voiceAction.forward") : parsed.command.direction === "backward" ? t("settings.voiceAction.backward") : t("settings.voiceAction.emergency_stop")
      : parsed.command.kind === "turn" ? parsed.command.degrees === 180 ? t("settings.voiceAction.turn_around") : parsed.command.direction === "left" ? t("settings.voiceAction.left") : t("settings.voiceAction.right")
      : parsed.command.kind === "gesture" ? t("settings.voiceAction.nod") : parsed.command.kind === "dance" ? t("settings.voiceAction.dance") : t("settings.voiceAction.sleep");
    setTestResult(t("settings.voiceCommandsTestMatched", { action: result }));
    recordDiagnosticEvent("runtime", "voice-command-safe-test", { matched: true, kind: parsed.kind });
  };

  return <Section title={t("settings.voiceCommands")}>
    <Text style={styles.help}>{t("settings.voiceCommandsHelp")}</Text>
    <DisclosureRow label={t("settings.robotNameRow", { name: preferences.robotName })} expanded={open === "name"} onPress={() => setOpen(open === "name" ? null : "name")} />
    {open === "name" ? <View style={styles.disclosureBody}>
      <Text style={styles.label}>{t("settings.robotPrimaryName")}</Text>
      <View style={styles.inlineInput}><TextInput value={robotNameDraft} onChangeText={setRobotNameDraft} placeholder="LOOI" placeholderTextColor={looiTheme.muted} style={[styles.input, styles.flexInput]} /><Action label={t("common.save")} onPress={() => { const value = robotNameDraft.trim(); if (value.length >= 2) updatePreferences({ robotName: value }); }} disabled={robotNameDraft.trim().length < 2} /></View>
      <Text style={styles.help}>{t("settings.robotNameSafetyHelp")}</Text>
      <Text style={styles.label}>{t("settings.robotOtherAddresses")}</Text>
      <View style={styles.tagWrap}>{preferences.robotAddressAliases.map((item) => <Pressable key={item} onPress={() => updateStringList("robotAddressAliases", preferences.robotAddressAliases.filter((value) => value !== item))} style={styles.tag}><Text style={styles.value}>{item} ×</Text></Pressable>)}</View>
      <View style={styles.inlineInput}><TextInput value={aliasDraft} onChangeText={setAliasDraft} placeholder={t("settings.addAddress")} placeholderTextColor={looiTheme.muted} style={[styles.input, styles.flexInput]} /><Action label="+" onPress={() => addAddress(false)} disabled={aliasDraft.trim().length < 2} /></View>
      <DisclosureRow label={t("settings.recognitionAliases")} expanded={recognitionExpanded} onPress={() => setRecognitionExpanded((value) => !value)} compact />
      {recognitionExpanded ? <View style={styles.disclosureBody}><Text style={styles.help}>{t("settings.recognitionAliasesHelp")}</Text><View style={styles.tagWrap}>{preferences.robotAddressRecognitionAliases.map((item) => <Pressable key={item} onPress={() => updateStringList("robotAddressRecognitionAliases", preferences.robotAddressRecognitionAliases.filter((value) => value !== item))} style={styles.tag}><Text style={styles.value}>{item} ×</Text></Pressable>)}</View><View style={styles.inlineInput}><TextInput value={recognitionDraft} onChangeText={setRecognitionDraft} placeholder={t("settings.addRecognitionAlias")} placeholderTextColor={looiTheme.muted} style={[styles.input, styles.flexInput]} /><Action label="+" onPress={() => addAddress(true)} disabled={recognitionDraft.trim().length < 2} /></View></View> : null}
    </View> : null}
    <DisclosureRow
      label={t("settings.customPhrasesSummary", { count: customPhraseCount })}
      expanded={customPhrasesExpanded}
      onPress={() => {
        setCustomPhrasesExpanded((value) => !value);
        setOpen(null);
        setDraft("");
        setTestResult(null);
      }}
    />
    {customPhrasesExpanded ? <View style={styles.disclosureBody}>
      <Text style={styles.help}>{t("settings.customPhrasesHelp")}</Text>
      {VOICE_COMMAND_ACTIONS.map((action) => {
        const phrases = preferences.customVoiceCommands[action];
        const expanded = open === action;
        return <View key={action}>
          <DisclosureRow label={`${t(`settings.voiceAction.${action}` as any)} · ${phrases.length}`} expanded={expanded} onPress={() => { setOpen(expanded ? null : action); setDraft(""); setDraftLanguage(preferences.listeningLanguage); }} compact />
          {expanded ? <View style={styles.disclosureBody}>
            <Text style={styles.help}>{action === "emergency_stop" ? t("settings.voiceCommandsEmergencyHelp") : t("settings.voiceCommandsAddressRequired", { name: preferences.robotName })}</Text>
            {phrases.map((phrase) => <View key={phrase.id} style={styles.phraseRow}><Text style={styles.value}>{phrase.text}</Text><Text style={styles.help}>{phrase.language.toUpperCase()}</Text><Pressable onPress={() => removePhrase(action, phrase.id)}><Text style={styles.deleteText}>×</Text></Pressable></View>)}
            <TextInput value={draft} onChangeText={setDraft} placeholder={t("settings.addPhrase")} placeholderTextColor={looiTheme.muted} style={styles.input} />
            <ButtonRow>{(["uk", "en", "ru"] as VoiceCommandLanguage[]).map((language) => <SmallChoice key={language} selected={draftLanguage === language} label={language.toUpperCase()} onPress={() => setDraftLanguage(language)} />)}<Action label={t("settings.addPhraseButton")} onPress={() => addPhrase(action)} disabled={draft.trim().length < 3} /></ButtonRow>
          </View> : null}
        </View>;
      })}
      <DisclosureRow label={t("settings.voiceCommandsTest")} expanded={open === "test"} onPress={() => { setOpen(open === "test" ? null : "test"); setTestResult(null); }} compact />
      {open === "test" ? <View style={styles.disclosureBody}>
        <Text style={styles.help}>{t("settings.voiceCommandsTestHelp")}</Text>
        <TextInput value={testText} onChangeText={setTestText} placeholder={t("settings.voiceCommandsTestPlaceholder", { name: preferences.robotName })} placeholderTextColor={looiTheme.muted} style={styles.input} />
        <Action label={t("settings.voiceCommandsTestButton")} onPress={runSafeTest} disabled={!testText.trim()} secondary />
        {testResult ? <Text style={styles.result}>{testResult}</Text> : null}
      </View> : null}
    </View> : null}
  </Section>;
}

function DisclosureRow({ label, expanded, onPress, compact }: { label: string; expanded: boolean; onPress: () => void; compact?: boolean }) {
  return <Pressable onPress={onPress} style={[styles.disclosureRow, compact && styles.disclosureCompact]}><Text style={styles.value}>{label}</Text><Text style={styles.disclosureChevron}>{expanded ? "▾" : "›"}</Text></Pressable>;
}

function Section({ title, children }: { title: string; children: ReactNode }) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><View style={styles.card}>{children}</View></View>; }
function Summary({ label, value, ok, neutral }: { label: string; value: string; ok: boolean; neutral?: boolean }) { return <View style={styles.summaryCard}><Text style={styles.summaryLabel}>{label}</Text><Text style={[styles.summaryValue, ok ? styles.ok : neutral ? styles.muted : styles.error]}>{value}</Text></View>; }
function Choice({ selected, label, detail, tone, onPress }: { selected: boolean; label: string; detail?: string; tone?: "recommended" | "quality" | "previous"; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.choice, tone === "recommended" && styles.choiceRecommended, tone === "quality" && styles.choiceQuality, tone === "previous" && styles.choicePrevious, selected && styles.choiceSelected]}><View style={styles.choiceDot}>{selected ? <View style={styles.choiceDotInner} /> : null}</View><View style={styles.choiceText}><Text style={styles.value}>{label}</Text>{detail ? <Text style={styles.help}>{detail}</Text> : null}</View></Pressable>; }
function VoiceChoice({ selected, label, detail, onSelect, onPreview, previewing, previewDisabled }: { selected: boolean; label: string; detail?: string; onSelect: () => void; onPreview: () => void; previewing: boolean; previewDisabled: boolean }) { const { t } = useUiText(); return <View style={[styles.voiceChoice, selected && styles.choiceSelected]}><Pressable onPress={onSelect} style={styles.voiceSelect}><View style={styles.choiceDot}>{selected ? <View style={styles.choiceDotInner} /> : null}</View><View style={styles.choiceText}><Text style={styles.value}>{label}</Text>{detail ? <Text style={styles.help}>{detail}</Text> : null}</View></Pressable><Pressable onPress={onPreview} disabled={previewDisabled} style={[styles.previewButton, previewDisabled && styles.disabled]}><Text style={styles.previewText}>{previewing ? "…" : `▶ ${t("common.preview")}`}</Text></Pressable></View>; }
function SmallChoice({ selected, label, onPress }: { selected: boolean; label: string; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.smallChoice, selected && styles.smallChoiceSelected]}><Text style={styles.value}>{selected ? `✓ ${label}` : label}</Text></Pressable>; }
function SwitchRow({ label, value, onPress }: { label: string; value: boolean; onPress: () => void }) { const { t } = useUiText(); return <Pressable onPress={onPress} style={styles.switchRow}><Text style={styles.value}>{label}</Text><Text style={[styles.pill, value && styles.pillOn]}>{value ? t("common.on") : t("common.off")}</Text></Pressable>; }
function ButtonRow({ children }: { children: ReactNode }) { return <View style={styles.buttonRow}>{children}</View>; }
function Action({ label, onPress, disabled, secondary }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) { return <Pressable onPress={onPress} disabled={disabled} style={[styles.action, secondary && styles.actionSecondary, disabled && styles.disabled]}><Text style={secondary ? styles.actionSecondaryText : styles.actionText}>{label}</Text></Pressable>; }
function ModelLine({ label, status }: { label: string; status: SherpaModelCheck | null | undefined }) { const { t } = useUiText(); return <View style={styles.modelLine}><Text style={styles.value}>{label}</Text><Text style={status?.ready ? styles.ok : styles.muted}>{status?.ready ? t("common.ready") : status ? t("common.notReady") : t("common.notChecked")}</Text></View>; }

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
  disclosureRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: looiTheme.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 11 },
  disclosureCompact: { marginTop: 2, paddingVertical: 8 },
  disclosureChevron: { color: looiTheme.cyan, fontSize: 18, fontWeight: "800" },
  disclosureBody: { gap: 9, paddingLeft: 4, paddingRight: 2, paddingBottom: 4 },
  paletteChoiceRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  paletteSwatches: { flexDirection: "row", alignItems: "center", width: 38 },
  paletteSwatch: { width: 24, height: 24, borderRadius: 999, borderWidth: 2, borderColor: "rgba(255,255,255,0.55)" },
  paletteSwatchOverlap: { marginLeft: -10 },
  tagWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  tag: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  inlineInput: { flexDirection: "row", alignItems: "center", gap: 8 },
  flexInput: { flex: 1 },
  phraseRow: { flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: looiTheme.line, paddingVertical: 7 },
  deleteText: { color: looiTheme.danger, fontSize: 22, lineHeight: 22, paddingHorizontal: 6 },
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
