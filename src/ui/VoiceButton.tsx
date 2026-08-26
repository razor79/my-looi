import { useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useConversationStore } from "../store/conversation";
import { useUserStore } from "../store/user";
import { looiTheme } from "./looi-theme";

async function getVoicePerceiver() {
  const { voiceRuntime } = await import("../perceivers/voice-runtime");
  return voiceRuntime;
}

export function VoiceButton() {
  const isListening = useConversationStore((s) => s.isListening);
  const isProcessing = useConversationStore((s) => s.isProcessing);
  const voiceState = useUserStore((s) => s.voiceState);
  const scale = useSharedValue(1);
  const pressTriggeredVoiceRef = useRef(false);

  const disabled = isProcessing || voiceState === "speaking";
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    if (disabled || useConversationStore.getState().isListening) {
      console.log("[VoiceButton] Ignored press in", {
        disabled,
        isListening: useConversationStore.getState().isListening,
        voiceState,
      });
      return;
    }

    console.log("[VoiceButton] Press in: trigger voice");
    pressTriggeredVoiceRef.current = true;
    scale.value = withSpring(0.94);

    // Trigger voice perceiver
    getVoicePerceiver()
      .then((voicePerceiver) => voicePerceiver.trigger())
      .catch(console.error);
  };

  const handlePressOut = () => {
    const shouldFinish = pressTriggeredVoiceRef.current;
    pressTriggeredVoiceRef.current = false;

    scale.value = withSpring(1);

    if (shouldFinish) {
      console.log("[VoiceButton] Press out: finish voice");
      // Stop listening and process
      getVoicePerceiver()
        .then((voicePerceiver) => voicePerceiver.finishListening())
        .catch(console.error);
    }
  };

  const label = getLabel(isListening, isProcessing, voiceState);
  const active = isListening || isProcessing;

  return (
    <View style={styles.container}>
      <Animated.View style={animatedStyle}>
        <Pressable
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          disabled={disabled}
          style={[
            styles.button,
            active && styles.buttonActive,
            disabled && styles.disabledButton,
          ]}
        >
          <View style={styles.innerRing}>
            <View style={[styles.micStem, isListening && styles.micStemHot]} />
            <View style={[styles.micHead, isListening && styles.micHeadHot]} />
            <View style={styles.micBase} />
          </View>
        </Pressable>
      </Animated.View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

function getLabel(isListening: boolean, isProcessing: boolean, voiceState: string) {
  if (isListening) return "Отпусти, чтобы закончить";
  if (isProcessing) return "Обрабатываю…";
  if (voiceState === "speaking") return "LOOI говорит…";
  return "Удерживай и говори";
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: 10,
  },
  button: {
    width: 86,
    height: 86,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: looiTheme.lineActive,
    backgroundColor: "rgba(40, 213, 255, 0.08)",
    boxShadow: "0 0 22px rgba(40, 213, 255, 0.36)",
  },
  buttonActive: {
    backgroundColor: "rgba(40, 213, 255, 0.18)",
    borderColor: looiTheme.cyan,
  },
  disabledButton: {
    opacity: 0.55,
  },
  innerRing: {
    width: 58,
    height: 58,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: looiTheme.line,
    alignItems: "center",
    justifyContent: "center",
  },
  micHead: {
    position: "absolute",
    top: 13,
    width: 18,
    height: 24,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: looiTheme.cyan,
  },
  micHeadHot: {
    borderColor: looiTheme.danger,
  },
  micStem: {
    position: "absolute",
    top: 31,
    width: 2,
    height: 12,
    borderRadius: 999,
    backgroundColor: looiTheme.cyan,
  },
  micStemHot: {
    backgroundColor: looiTheme.danger,
  },
  micBase: {
    position: "absolute",
    bottom: 11,
    width: 24,
    height: 2,
    borderRadius: 999,
    backgroundColor: "rgba(237, 247, 255, 0.5)",
  },
  label: {
    color: looiTheme.muted,
    fontSize: 13,
    fontWeight: "600",
  },
});
