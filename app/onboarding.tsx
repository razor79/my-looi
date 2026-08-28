import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";

import { RobotFace } from "@/src/ui/RobotFace";
import { looiTheme } from "@/src/ui/looi-theme";
import { downloadMissingSherpaModels, type SherpaModelDownloadProgress } from "@/src/voice/sherpa-model-download";
import {
  clearOpenAiApiKey,
  saveOpenAiApiKey,
  validateOpenAiApiKey,
} from "@/src/openai/openai-api-key";
import {
  computeSetupReadiness,
  type SetupReadiness,
  type SetupStep,
} from "@/src/setup/setup-readiness";
import { setOnboardingCompleted, setOptionalCapabilitySkipped } from "@/src/setup/setup-storage";
import { syncVoiceRuntime } from "@/src/core/app-bootstrap";
import { useUserStore } from "@/src/store/user";
import { useUiText } from "@/src/i18n/use-ui-text";
import { INTERFACE_LANGUAGE_OPTIONS } from "@/src/i18n/ui-language";
import { getLocalizedModelDownloadStage, type UiStringKey } from "@/src/i18n/ui-strings";

const setupSteps: { id: SetupStep; labelKey: UiStringKey | null }[] = [
  { id: "openai", labelKey: null },
  { id: "models", labelKey: "onboarding.step.models" },
  { id: "permissions", labelKey: "onboarding.step.permissions" },
  { id: "done", labelKey: "onboarding.step.done" },
];

const modelCapabilities = [
  { key: "asr", labelKey: null },
  { key: "kws", labelKey: "onboarding.addressModel" as UiStringKey },
  { key: "vad", labelKey: "onboarding.localVad" as UiStringKey },
] as const;

type AudioStudioPermissionModule = {
  getPermissionsAsync?: () => Promise<{ granted?: boolean; status?: string }>;
  requestPermissionsAsync?: () => Promise<{ granted?: boolean; status?: string }>;
};

async function requestMicrophoneAccess(deniedMessage: string): Promise<void> {
  const existing = await getRecordingPermissionsAsync();
  if (!existing.granted) {
    const next = await requestRecordingPermissionsAsync();
    if (!next.granted) throw new Error(deniedMessage);
  }

  const { AudioStudioModule } = await import("@siteed/audio-studio");
  const audioStudio = AudioStudioModule as AudioStudioPermissionModule;
  const studioExisting = await audioStudio.getPermissionsAsync?.();
  if (studioExisting && !studioExisting.granted) {
    const studioNext = await audioStudio.requestPermissionsAsync?.();
    if (!studioNext?.granted) throw new Error(deniedMessage);
  }
}

export default function OnboardingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ step?: string }>();
  const [activeStep, setActiveStep] = useState<SetupStep>(normalizeSetupStep(params.step));
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const [loadingReadiness, setLoadingReadiness] = useState(true);
  const [openAiKeyInput, setOpenAiKeyInput] = useState("");
  const [openAiBusy, setOpenAiBusy] = useState(false);
  const [openAiError, setOpenAiError] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<SherpaModelDownloadProgress | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const { language: interfaceLanguageForText, t } = useUiText();
  const interfaceLanguage = useUserStore((state) => state.preferences.interfaceLanguage);
  const updatePreferences = useUserStore((state) => state.updatePreferences);

  const refreshReadiness = useCallback(async () => {
    setLoadingReadiness(true);
    try {
      const next = await computeSetupReadiness();
      setReadiness(next);
      setActiveStep((current) => (current === "done" ? current : next.nextStep));
      return next;
    } finally {
      setLoadingReadiness(false);
    }
  }, []);

  useEffect(() => {
    refreshReadiness().catch((error) => {
      console.warn("[Onboarding] Failed to load setup readiness:", error);
      setLoadingReadiness(false);
    });
  }, [refreshReadiness]);

  useEffect(() => {
    setActiveStep(normalizeSetupStep(params.step));
  }, [params.step]);

  const goToStep = useCallback((step: SetupStep) => {
    setActiveStep(step);
    router.setParams({ step });
  }, [router]);

  const saveOpenAiKey = useCallback(async () => {
    if (openAiBusy) return;
    setOpenAiBusy(true);
    setOpenAiError(null);
    try {
      const key = validateOpenAiApiKey(openAiKeyInput);
      await saveOpenAiApiKey(key);
      setOpenAiKeyInput("");
      await refreshReadiness();
      goToStep("models");
    } catch (error) {
      setOpenAiError(error instanceof Error ? error.message : t("onboarding.keySaveFailed"));
    } finally {
      setOpenAiBusy(false);
    }
  }, [goToStep, openAiBusy, openAiKeyInput, refreshReadiness, t]);

  const replaceOpenAiKey = useCallback(async () => {
    await clearOpenAiApiKey();
    await refreshReadiness();
    setOpenAiError(null);
  }, [refreshReadiness]);

  const downloadModels = useCallback(async () => {
    if (modelBusy) return;
    setModelBusy(true);
    setModelError(null);
    setModelProgress(null);
    try {
      await downloadMissingSherpaModels(setModelProgress);
      await refreshReadiness();
      await syncVoiceRuntime().catch(() => undefined);
      goToStep("permissions");
    } catch (error) {
      console.warn("[Onboarding] Local model download failed:", error);
      setModelError(t("onboarding.modelsDownloadFailed"));
    } finally {
      setModelBusy(false);
    }
  }, [goToStep, modelBusy, refreshReadiness, t]);

  const requestMicrophone = useCallback(async () => {
    if (permissionBusy) return;
    setPermissionBusy(true);
    setPermissionError(null);
    try {
      await requestMicrophoneAccess(t("onboarding.micDenied"));
      await refreshReadiness();
      await syncVoiceRuntime().catch(() => undefined);
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : t("onboarding.micPermissionFailed"));
    } finally {
      setPermissionBusy(false);
    }
  }, [permissionBusy, refreshReadiness, t]);

  const skipRobot = useCallback(async () => {
    setOptionalCapabilitySkipped("robot", true);
    await refreshReadiness();
  }, [refreshReadiness]);

  const finishOnboarding = useCallback(async () => {
    const next = await refreshReadiness();
    if (!next.requiredReady) {
      goToStep(next.nextStep);
      return;
    }
    setOnboardingCompleted(true);
    await syncVoiceRuntime().catch(() => undefined);
    router.replace("/");
  }, [goToStep, refreshReadiness, router]);

  const canFinish = readiness?.requiredReady ?? false;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>MY LOOI</Text>
            <Text style={styles.title}>{t("onboarding.localSetup")}</Text>
            <Text style={styles.subtitle}>{t("onboarding.subtitle")}</Text>
          </View>
          <RobotFace mode="avatar" />
        </View>

        <View style={styles.interfaceLanguageRow}>
          <Text style={styles.interfaceLanguageLabel}>{t("onboarding.interfaceLanguage")}</Text>
          <View style={styles.interfaceLanguageChoices}>
            {INTERFACE_LANGUAGE_OPTIONS.map((option) => (
              <Pressable
                key={option.id}
                onPress={() => updatePreferences({ interfaceLanguage: option.id })}
                style={[styles.languageChoice, interfaceLanguage === option.id && styles.languageChoiceSelected]}
              >
                <Text style={[styles.languageChoiceText, interfaceLanguage === option.id && styles.languageChoiceTextSelected]}>
                  {option.shortLabel} · {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.steps}>
          {setupSteps.map((step) => {
            const active = step.id === activeStep;
            const complete = isStepComplete(step.id, readiness);
            return (
              <Pressable key={step.id} onPress={() => goToStep(step.id)} style={[styles.step, active && styles.stepActive]}>
                <Text style={[styles.stepText, active && styles.stepTextActive]}>{complete ? "✓ " : ""}{step.labelKey ? t(step.labelKey) : "OpenAI"}</Text>
              </Pressable>
            );
          })}
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {loadingReadiness && !readiness ? <ActivityIndicator /> : null}

          {activeStep === "openai" ? (
            <Section title="OpenAI Realtime">
              <Text style={styles.help}>{t("onboarding.apiHelp")}</Text>
              <StatusRow label={t("onboarding.key")} ready={Boolean(readiness?.openAiKeyConfigured)} readyText={t("onboarding.keySaved")} pendingText={t("onboarding.keyNeeded")} />
              <TextInput
                value={openAiKeyInput}
                onChangeText={setOpenAiKeyInput}
                placeholder={readiness?.openAiKeyConfigured ? t("onboarding.newKey") : "OpenAI API key"}
                placeholderTextColor={looiTheme.muted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              {openAiError ? <Text style={styles.error}>{openAiError}</Text> : null}
              <View style={styles.actions}>
                <PrimaryButton label={openAiBusy ? t("onboarding.saving") : readiness?.openAiKeyConfigured ? t("onboarding.replaceKey") : t("onboarding.saveKey")} onPress={saveOpenAiKey} disabled={openAiBusy || !openAiKeyInput.trim()} />
                {readiness?.openAiKeyConfigured ? <SecondaryButton label={t("onboarding.deleteKey")} onPress={replaceOpenAiKey} /> : null}
                {readiness?.openAiKeyConfigured ? <SecondaryButton label={t("common.continue")} onPress={() => goToStep("models")} /> : null}
              </View>
            </Section>
          ) : null}

          {activeStep === "models" ? (
            <Section title={t("onboarding.modelsTitle")}>
              <Text style={styles.help}>{t("onboarding.modelsHelp")}</Text>
              {modelCapabilities.map((capability) => (
                <StatusRow
                  key={capability.key}
                  label={capability.labelKey ? t(capability.labelKey) : t("onboarding.sharedStt")}
                  ready={Boolean(readiness?.modelStatus?.[capability.key].ready)}
                  readyText={t("common.ready")}
                  pendingText={t("onboarding.installNeeded")}
                />
              ))}
              {modelProgress ? <Text style={styles.help}>{getLocalizedModelDownloadStage(interfaceLanguageForText, modelProgress.stage, modelProgress.label)} · {Math.round(modelProgress.progress * 100)}%</Text> : null}
              {modelError ? <Text style={styles.error}>{modelError}</Text> : null}
              <View style={styles.actions}>
                {readiness?.modelsReady ? <PrimaryButton label={t("common.continue")} onPress={() => goToStep("permissions")} /> : <PrimaryButton label={modelBusy ? t("onboarding.downloading") : t("onboarding.downloadModels")} onPress={downloadModels} disabled={modelBusy} />}
              </View>
            </Section>
          ) : null}

          {activeStep === "permissions" ? (
            <Section title={t("onboarding.micRobot")}>
              <StatusRow label={t("onboarding.microphone")} ready={Boolean(readiness?.microphoneReady)} readyText={t("onboarding.micAllowed")} pendingText={t("onboarding.permissionNeeded")} />
              {!readiness?.microphoneReady ? <PrimaryButton label={permissionBusy ? t("common.wait") : t("onboarding.allowMic")} onPress={requestMicrophone} disabled={permissionBusy} /> : null}
              <StatusRow label={t("onboarding.robot")} ready={Boolean(readiness?.robotReady)} readyText={t("onboarding.robotConnectedSaved")} pendingText={readiness?.skipped.robot ? t("onboarding.setupLater") : t("onboarding.optional")} />
              {!readiness?.robotReady && !readiness?.skipped.robot ? <SecondaryButton label={t("onboarding.robotLater")} onPress={skipRobot} /> : null}
              {permissionError ? <Text style={styles.error}>{permissionError}</Text> : null}
              <View style={styles.actions}>
                <PrimaryButton label={t("common.continue")} onPress={() => goToStep("done")} disabled={!readiness?.microphoneReady} />
              </View>
            </Section>
          ) : null}

          {activeStep === "done" ? (
            <Section title={t("onboarding.doneTitle")}>
              <StatusRow label="OpenAI" ready={Boolean(readiness?.openAiKeyConfigured)} readyText={t("settings.summary.keySaved")} pendingText={t("onboarding.keyNotConfigured")} />
              <StatusRow label={t("onboarding.step.models")} ready={Boolean(readiness?.modelsReady)} readyText={t("onboarding.modelsReady")} pendingText={t("onboarding.modelsNotReady")} />
              <StatusRow label={t("onboarding.microphone")} ready={Boolean(readiness?.microphoneReady)} readyText={t("onboarding.micAllowed")} pendingText={t("onboarding.noAccess")} />
              <StatusRow label={t("settings.summary.robot")} ready={Boolean(readiness?.robotReady)} readyText={t("common.ready")} pendingText={t("onboarding.optional")} neutral />
              <View style={styles.actions}><PrimaryButton label={t("onboarding.openLooi")} onPress={finishOnboarding} disabled={!canFinish} /></View>
            </Section>
          ) : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function normalizeSetupStep(step?: string | string[]): SetupStep {
  const value = Array.isArray(step) ? step[0] : step;
  if (value === "openai" || value === "models" || value === "permissions" || value === "done") return value;
  // v2.1.100 and earlier used server/speaker setup steps.
  if (value === "server") return "openai";
  if (value === "speaker") return "models";
  return "openai";
}

function isStepComplete(step: SetupStep, readiness: SetupReadiness | null): boolean {
  if (!readiness) return false;
  if (step === "openai") return readiness.openAiKeyConfigured;
  if (step === "models") return readiness.modelsReady;
  if (step === "permissions") return readiness.microphoneReady;
  return readiness.requiredReady && readiness.onboardingCompleted;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

function StatusRow({ label, ready, readyText, pendingText, neutral }: { label: string; ready: boolean; readyText: string; pendingText: string; neutral?: boolean }) {
  return <View style={styles.statusRow}><Text style={styles.statusLabel}>{label}</Text><Text style={[styles.statusValue, ready ? styles.ok : neutral ? styles.neutral : styles.pending]}>{ready ? readyText : pendingText}</Text></View>;
}

function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} style={[styles.primaryButton, disabled && styles.disabled]}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: looiTheme.bg },
  page: { flex: 1, padding: 18, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 },
  eyebrow: { color: looiTheme.cyan, fontSize: 11, fontWeight: "800", letterSpacing: 1.8 },
  title: { color: looiTheme.text, fontSize: 28, fontWeight: "800", marginTop: 4 },
  subtitle: { color: looiTheme.muted, fontSize: 13, lineHeight: 19, maxWidth: 620, marginTop: 6 },
  interfaceLanguageRow: { gap: 8 },
  interfaceLanguageLabel: { color: looiTheme.muted, fontSize: 12, fontWeight: "700" },
  interfaceLanguageChoices: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  languageChoice: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  languageChoiceSelected: { borderColor: looiTheme.cyan, backgroundColor: "rgba(40,213,255,0.08)" },
  languageChoiceText: { color: looiTheme.muted, fontSize: 12, fontWeight: "700" },
  languageChoiceTextSelected: { color: looiTheme.text },
  steps: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  step: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8 },
  stepActive: { borderColor: looiTheme.cyan, backgroundColor: "rgba(40,213,255,0.08)" },
  stepText: { color: looiTheme.muted, fontSize: 12, fontWeight: "700" },
  stepTextActive: { color: looiTheme.text },
  content: { paddingBottom: 30 },
  section: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 22, backgroundColor: looiTheme.rail, padding: 18, gap: 14 },
  sectionTitle: { color: looiTheme.text, fontSize: 19, fontWeight: "800" },
  help: { color: looiTheme.muted, lineHeight: 19, fontSize: 13 },
  input: { color: looiTheme.text, borderWidth: 1, borderColor: looiTheme.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: looiTheme.bg },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: looiTheme.line, paddingVertical: 10 },
  statusLabel: { color: looiTheme.text, fontSize: 14, fontWeight: "600", flex: 1 },
  statusValue: { fontSize: 12, fontWeight: "700", textAlign: "right" },
  ok: { color: looiTheme.ok },
  pending: { color: looiTheme.danger },
  neutral: { color: looiTheme.muted },
  actions: { flexDirection: "row", gap: 10, flexWrap: "wrap", marginTop: 4 },
  primaryButton: { backgroundColor: looiTheme.cyan, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 11 },
  primaryButtonText: { color: "#041319", fontWeight: "800" },
  secondaryButton: { borderWidth: 1, borderColor: looiTheme.line, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 11 },
  secondaryButtonText: { color: looiTheme.text, fontWeight: "700" },
  disabled: { opacity: 0.4 },
  error: { color: looiTheme.danger, fontSize: 13 },
});
