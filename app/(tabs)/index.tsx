import {
  forceReconnectSavedLooiRobot,
  startLooiRobotAutoConnection,
} from "@/src/device-tools/looi-robot-autoconnect";
import {
  getLooiRobotRuntimeState,
  performLooiCharacterReaction,
  subscribeLooiRobotRuntimeState,
} from "@/src/device-tools/looi-robot";
import { voiceRuntime } from "@/src/perceivers/voice-runtime";
import {
  computeSetupReadiness,
  type SetupReadiness,
} from "@/src/setup/setup-readiness";
import { ConversationOverlay } from "@/src/ui/ConversationOverlay";
import { ImageOverlay } from "@/src/ui/ImageOverlay";
import { looiTheme } from "@/src/ui/looi-theme";
import { RobotFace } from "@/src/ui/RobotFace";
import { RESPONSE_LANGUAGE_OPTIONS, type ResponseLanguage } from "@/src/language/response-language";
import { LISTENING_LANGUAGE_OPTIONS, type ListeningLanguage } from "@/src/language/listening-language";
import { wakeRobotFromFace } from "@/src/core/sleep-mode";
import { setMainScreenFocused } from "@/src/core/main-screen-presence";
import { useUserStore } from "@/src/store/user";
import { useConversationStore } from "@/src/store/conversation";
import { useUiText } from "@/src/i18n/use-ui-text";
import { recordDiagnosticEvent } from "@/src/diagnostics/diagnostic-log";
import { triggerCharacterReaction } from "@/src/character/character-reaction";
import { classifyFaceTapImmediateRoute } from "@/src/character/face-tap-routing";
import { isDrivingControlSessionActive } from "@/src/voice/driving-control-session";
import { useFocusEffect, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import regularSymbolWeight from "expo-symbols/androidWeights/regular";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";



function shortLanguage(language: "ru" | "uk" | "en"): string {
  const option = [...LISTENING_LANGUAGE_OPTIONS, ...RESPONSE_LANGUAGE_OPTIONS].find((item) => item.id === language);
  return option?.shortLabel ?? language.toUpperCase();
}

export default function IndexScreen() {
  const router = useRouter();
  const [languageMenu, setLanguageMenu] = useState<"listening" | "response" | null>(null);
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const [robotRuntimeState, setRobotRuntimeState] = useState(() => getLooiRobotRuntimeState());
  const sleepTapAtRef = useRef(0);
  const idleTapCountRef = useRef(0);
  const idleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFocusedMainOnceRef = useRef(false);
  const robotSleeping = useUserStore((state) => state.robotSleeping);
  const listeningLanguage = useUserStore((state) => state.preferences.listeningLanguage);
  const responseLanguage = useUserStore((state) => state.preferences.language);
  const updatePreferences = useUserStore((state) => state.updatePreferences);
  const { t } = useUiText();

  useEffect(() => () => {
    if (idleTapTimerRef.current) clearTimeout(idleTapTimerRef.current);
    idleTapTimerRef.current = null;
  }, []);

  useEffect(() => {
    startLooiRobotAutoConnection().catch((error) => {
      console.warn("[Home] LOOI robot auto-connect failed:", error);
    });
  }, []);

  useEffect(() => {
    const syncRobotState = () => setRobotRuntimeState(getLooiRobotRuntimeState());
    syncRobotState();
    return subscribeLooiRobotRuntimeState(syncRobotState);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setMainScreenFocused(true);
      const returningFromNavigation = hasFocusedMainOnceRef.current;
      hasFocusedMainOnceRef.current = true;
      recordDiagnosticEvent("navigation", "main-focused", {
        reason: returningFromNavigation ? "navigation-return" : "initial",
      });

      if (!useUserStore.getState().robotSleeping) {
        if (returningFromNavigation) {
          // Returning from Settings/another in-app route is an attention signal
          // just like fresh launch. Do not require Луи/Макс or a face tap.
          void voiceRuntime.resumeMainScreenConversation("navigation-return").catch((error) => {
            console.warn("[Home] Failed to resume conversation on navigation return:", error);
          });
        } else {
          // Preserve the existing fresh-launch auto-listen timer; only make sure
          // we re-arm voice runtime on focus and its wakeword substrate is healthy.
          void voiceRuntime.rearmWakewordAfterNavigation().catch((error) => {
            console.warn("[Home] Failed to re-arm voice runtime on initial focus:", error);
          });
        }
      }

      return () => {
        setMainScreenFocused(false);
        recordDiagnosticEvent("navigation", "main-blurred");
        // Internal navigation is not Android background. It has its own explicit
        // Realtime ownership boundary so Settings never inherits a live session.
        void voiceRuntime.suspendMainScreenConversation("navigation-main-blur").catch((error) => {
          console.warn("[Home] Failed to suspend Realtime on main blur:", error);
        });
      };
    }, [])
  );

  useEffect(() => {
    let cancelled = false;
    computeSetupReadiness()
      .then((next) => {
        if (!cancelled) setReadiness(next);
      })
      .catch((error) => {
        console.warn("[Home] Failed to compute setup readiness:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const repairStep = readiness?.modelsReady === false ? "models" : null;

  const connectRobot = useCallback(async () => {
    const current = getLooiRobotRuntimeState();
    if (current.connected || current.connecting) return;
    try {
      const result = await forceReconnectSavedLooiRobot();
      if (!result.ok && result.reason === "no-saved-robot") {
        router.replace("/settings");
        return;
      }
      if (!result.ok) throw new Error(`Robot reconnect skipped: ${result.reason ?? "unknown"}`);
    } catch (error) {
      console.warn("[Home] LOOI connect failed:", error);
      recordDiagnosticEvent("robot", "ble-force-reconnect-ui-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Runtime state carries the authoritative BLE error; force a UI refresh in
      // case the transport rejected before publishing its own state change.
      setRobotRuntimeState(getLooiRobotRuntimeState());
    }
  }, [router]);

  const runIdlePhysicalReaction = useCallback((reaction: "annoyed" | "angry") => {
    const current = getLooiRobotRuntimeState();
    if (!current.connected || current.motionActive || isDrivingControlSessionActive()) return;
    void performLooiCharacterReaction(reaction).catch((error) => {
      recordDiagnosticEvent("character", "tap-physical-reaction-skipped", {
        reaction,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  const handleAwakeFaceTap = useCallback(() => {
    const current = getLooiRobotRuntimeState();
    const voiceState = useUserStore.getState().voiceState;
    const conversation = useConversationStore.getState();

    const immediateRoute = classifyFaceTapImmediateRoute({
      motionActive: current.motionActive,
      drivingSessionActive: isDrivingControlSessionActive(),
      conversationProcessing: conversation.isProcessing,
      conversationSpeaking: conversation.isSpeaking,
      voiceState,
    });

    // Hard safety/control ownership and real Classic output/processing states
    // always win immediately. Passive listening deliberately falls through to
    // the burst discriminator so 2+/3+ taps are not swallowed after launch.
    if (immediateRoute !== "burst") {
      recordDiagnosticEvent("character", "face-tap-routed", { route: immediateRoute, voiceState });
      void voiceRuntime.trigger().catch((error) => {
        console.warn("[Home] Face immediate trigger failed:", error);
      });
      return;
    }

    idleTapCountRef.current += 1;
    if (idleTapTimerRef.current) clearTimeout(idleTapTimerRef.current);
    idleTapTimerRef.current = setTimeout(() => {
      idleTapTimerRef.current = null;
      const taps = idleTapCountRef.current;
      idleTapCountRef.current = 0;
      if (taps <= 1) {
        recordDiagnosticEvent("character", "face-tap-routed", { route: "classic-attention", taps, voiceState });
        // Keep single tap = conversation, but give the face a quick startle
        // before the normal attention/listening state takes over. No motor/head
        // noise is generated here, so the microphone capture stays clean.
        triggerCharacterReaction("startled", { durationMs: 520, source: "single-face-tap" });
        void voiceRuntime.trigger().catch((error) => {
          console.warn("[Home] Face attention trigger failed:", error);
        });
        return;
      }

      void (async () => {
        const prepared = await voiceRuntime.prepareIdleCharacterReaction();
        if (!prepared.ok && prepared.reason === "realtime-active") {
          // Realtime listening/speaking must not swallow the Character Layer.
          // A burst first interrupts any current model output, then keeps the
          // same 2-tap annoyed / 3+-tap angry reaction used while Classic is idle.
          await voiceRuntime.trigger().catch((error) => {
            console.warn("[Home] Realtime face burst interrupt failed:", error);
          });
          if (taps === 2) {
            recordDiagnosticEvent("character", "face-tap-routed", { route: "character-annoyed", taps, prepared: "realtime-interrupted" });
            triggerCharacterReaction("annoyed", { durationMs: 1_050, source: "double-face-tap" });
            recordDiagnosticEvent("character", "face-tap-burst", { taps, reaction: "annoyed" });
            runIdlePhysicalReaction("annoyed");
          } else {
            recordDiagnosticEvent("character", "face-tap-routed", { route: "character-angry", taps, prepared: "realtime-interrupted" });
            triggerCharacterReaction("angry", { durationMs: 1_450, source: "repeated-face-tap" });
            recordDiagnosticEvent("character", "face-tap-burst", { taps, reaction: "angry" });
            runIdlePhysicalReaction("angry");
          }
          return;
        }
        if (!prepared.ok) {
          recordDiagnosticEvent("character", "face-tap-routed", {
            route: "classic-active-after-burst",
            taps,
            reason: prepared.reason,
          });
          await voiceRuntime.trigger().catch((error) => {
            console.warn("[Home] Face burst fallback trigger failed:", error);
          });
          return;
        }

        if (taps === 2) {
          recordDiagnosticEvent("character", "face-tap-routed", { route: "character-annoyed", taps, prepared: prepared.reason });
          triggerCharacterReaction("annoyed", { durationMs: 1_050, source: "double-face-tap" });
          recordDiagnosticEvent("character", "face-tap-burst", { taps, reaction: "annoyed" });
          runIdlePhysicalReaction("annoyed");
          return;
        }
        recordDiagnosticEvent("character", "face-tap-routed", { route: "character-angry", taps, prepared: prepared.reason });
        triggerCharacterReaction("angry", { durationMs: 1_450, source: "repeated-face-tap" });
        recordDiagnosticEvent("character", "face-tap-burst", { taps, reaction: "angry" });
        runIdlePhysicalReaction("angry");
      })();
    }, 280);
  }, [runIdlePhysicalReaction]);

  const robotConnectionMode = robotRuntimeState.connecting
    ? "connecting"
    : robotRuntimeState.connected
      ? "connected"
      : robotRuntimeState.lastError
        ? "error"
        : "disconnected";

  const robotConnectionLabel = robotConnectionMode === "connecting"
    ? t("home.robot.connecting")
    : robotConnectionMode === "connected"
      ? t("home.robot.connected")
      : robotConnectionMode === "error"
        ? t("home.robot.retry")
        : t("home.robot.connect");


  return (
    <SafeAreaView style={styles.home}>
      {!robotSleeping ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`LOOI Robot: ${robotConnectionLabel}`}
          disabled={robotConnectionMode === "connecting" || robotConnectionMode === "connected"}
          onPress={() => void connectRobot()}
          style={[
            styles.robotReconnectButton,
            robotConnectionMode === "connecting" && styles.robotReconnectButtonBusy,
            robotConnectionMode === "connected" && styles.robotReconnectButtonConnected,
            robotConnectionMode === "error" && styles.robotReconnectButtonError,
          ]}
        >
          <Text style={[
            styles.robotReconnectText,
            robotConnectionMode === "connected" && styles.robotReconnectTextConnected,
            robotConnectionMode === "error" && styles.robotReconnectTextError,
          ]}>
            🤖 {robotConnectionLabel}
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.languagePicker}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("home.listeningLanguageA11y", { language: listeningLanguage })}
          onPress={() => setLanguageMenu((value) => value === "listening" ? null : "listening")}
          style={styles.languageButton}
        >
          <Text style={styles.languageText}>🎙 {shortLanguage(listeningLanguage)} ▾</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("home.responseLanguageA11y", { language: responseLanguage })}
          onPress={() => setLanguageMenu((value) => value === "response" ? null : "response")}
          style={styles.languageButton}
        >
          <Text style={styles.languageText}>🔊 {shortLanguage(responseLanguage)} ▾</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("home.settingsA11y")}
          onPress={() => router.replace("/settings")}
          style={styles.settingsButton}
        >
          <SymbolView
            name={{ ios: "gearshape.fill", android: "settings" }}
            size={20}
            tintColor={looiTheme.cyan}
            weight={{ ios: "semibold", android: regularSymbolWeight }}
            fallback={<Text style={styles.settingsFallback}>⚙</Text>}
          />
        </Pressable>
        {languageMenu ? (
          <View style={styles.languageMenu}>
            {(languageMenu === "listening" ? LISTENING_LANGUAGE_OPTIONS : RESPONSE_LANGUAGE_OPTIONS).map((option) => {
              const selected = option.id === (languageMenu === "listening" ? listeningLanguage : responseLanguage);
              return (
                <Pressable
                  key={`${languageMenu}-${option.id}`}
                  accessibilityRole="button"
                  onPress={() => {
                    const menu = languageMenu;
                    if (menu === "listening") {
                      const from = listeningLanguage;
                      updatePreferences({ listeningLanguage: option.id as ListeningLanguage });
                      recordDiagnosticEvent("runtime", "listening-language-changed", { from, language: option.id, source: "home-ui" });
                    } else {
                      const from = responseLanguage;
                      updatePreferences({ language: option.id as ResponseLanguage });
                      recordDiagnosticEvent("runtime", "response-language-changed", { from, language: option.id, source: "home-ui" });
                    }
                    setLanguageMenu(null);
                    void voiceRuntime.applyLiveRealtimePreferences(`home-${menu ?? "unknown"}-language`).then((applied) => {
                      if (menu === "listening" && !applied) {
                        return voiceRuntime.rearmWakewordAfterNavigation();
                      }
                    }).catch((error) => {
                      recordDiagnosticEvent("runtime", "live-language-apply-failed", {
                        source: menu ?? "unknown",
                        error: error instanceof Error ? error.message : String(error),
                      });
                    });
                  }}
                  style={[styles.languageMenuItem, selected && styles.languageMenuItemSelected]}
                >
                  <Text style={[styles.languageMenuText, selected && styles.languageMenuTextSelected]}>
                    {option.shortLabel} · {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
      <View style={styles.faceStage}>
        {repairStep ? (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.replace(`/onboarding?step=${repairStep}` as never)
            }
            style={styles.repairBanner}
          >
            <Text style={styles.repairTitle}>
              {t("home.modelsNotReady")}
            </Text>
            <Text style={styles.repairText}>{t("home.repairModels")}</Text>
          </Pressable>
        ) : null}
        <RobotFace
          mode="fullscreen"
          labelVisible={false}
          onPress={() => {
                    if (robotSleeping) {
              sleepTapAtRef.current = 0;
              void wakeRobotFromFace().catch((error) => {
                console.warn("[Home] Failed to wake LOOI from face tap:", error);
              });
              return;
            }
            handleAwakeFaceTap();
          }}
        />
        {robotSleeping ? (
          <View pointerEvents="none" style={styles.sleepBadge}>
            <Text style={styles.sleepTitle}>Zzz</Text>
            <Text style={styles.sleepText}>{t("home.wakeFromSleep")}</Text>
          </View>
        ) : null}
      </View>
      {!robotSleeping ? <ConversationOverlay /> : null}
      {!robotSleeping ? <ImageOverlay /> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  home: {
    flex: 1,
    backgroundColor: looiTheme.bg,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  faceStage: {
    width: "100%",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  robotReconnectButton: {
    position: "absolute",
    bottom: 18,
    right: 18,
    zIndex: 8,
    minHeight: 44,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: "rgba(3, 13, 24, 0.84)",
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  robotReconnectButtonBusy: {
    opacity: 0.62,
  },
  robotReconnectButtonConnected: {
    borderColor: "rgba(77, 231, 180, 0.52)",
  },
  robotReconnectButtonError: {
    borderColor: "rgba(255, 92, 122, 0.54)",
  },
  robotReconnectText: {
    color: looiTheme.cyan,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  robotReconnectTextConnected: {
    color: looiTheme.ok,
  },
  robotReconnectTextError: {
    color: looiTheme.danger,
  },
  languagePicker: {
    position: "absolute",
    top: 18,
    right: 18,
    zIndex: 8,
    flexDirection: "row",
    gap: 6,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: "rgba(3, 13, 24, 0.84)",
    padding: 5,
  },
  settingsButton: {
    minWidth: 36,
    minHeight: 36,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  settingsFallback: {
    color: looiTheme.cyan,
    fontSize: 18,
  },
  languageMenu: {
    position: "absolute",
    top: 44,
    right: 0,
    minWidth: 180,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: looiTheme.lineActive,
    backgroundColor: "rgba(3, 13, 24, 0.97)",
    padding: 5,
    gap: 3,
  },
  languageMenuItem: {
    minHeight: 36,
    borderRadius: 10,
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  languageMenuItemSelected: {
    backgroundColor: "rgba(40, 213, 255, 0.16)",
  },
  languageMenuText: {
    color: looiTheme.muted,
    fontSize: 12,
    fontWeight: "700",
  },
  languageMenuTextSelected: {
    color: looiTheme.cyan,
  },
  languageButton: {
    minWidth: 64,
    height: 34,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  languageButtonSelected: {
    backgroundColor: looiTheme.cyan,
  },
  languageText: {
    color: looiTheme.muted,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  languageTextSelected: {
    color: looiTheme.bg,
  },
  sleepBadge: {
    position: "absolute",
    bottom: 34,
    alignSelf: "center",
    alignItems: "center",
    gap: 3,
    opacity: 0.62,
  },
  sleepTitle: {
    color: looiTheme.cyan,
    fontSize: 18,
    fontWeight: "800",
  },
  sleepText: {
    color: looiTheme.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  repairBanner: {
    position: "absolute",
    top: 34,
    alignSelf: "center",
    zIndex: 4,
    minWidth: 300,
    maxWidth: "86%",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: looiTheme.lineActive,
    backgroundColor: "rgba(3, 13, 24, 0.88)",
    paddingHorizontal: 18,
    paddingVertical: 12,
    alignItems: "center",
    gap: 4,
  },
  repairTitle: {
    color: looiTheme.text,
    fontSize: 15,
    fontWeight: "800",
  },
  repairText: {
    color: looiTheme.cyan,
    fontSize: 12,
    fontWeight: "700",
  },
});
