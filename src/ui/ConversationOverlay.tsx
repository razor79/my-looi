import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useConversationStore } from "@/src/store/conversation";
import { isRealtimeConversationMode, useUserStore, type ConversationMode } from "@/src/store/user";
import { looiTheme } from "@/src/ui/looi-theme";

const IDLE_HIDE_DELAY_MS = 3000;

export function ConversationOverlay() {
  const currentTranscript = useConversationStore((state) => state.currentTranscript);
  const streamingText = useConversationStore((state) => state.streamingText);
  const overlayVisible = useConversationStore((state) => state.overlayVisible);
  const isListening = useConversationStore((state) => state.isListening);
  const isProcessing = useConversationStore((state) => state.isProcessing);
  const isSpeaking = useConversationStore((state) => state.isSpeaking);
  const realtimeReadiness = useConversationStore((state) => state.realtimeReadiness);
  const conversationMode = useUserStore((state) => state.preferences.conversationMode);
  const setOverlayVisible = useConversationStore((state) => state.setOverlayVisible);
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(-8);

  const shouldShow = overlayVisible || isListening || isProcessing || isSpeaking;

  useEffect(() => {
    opacity.value = withTiming(shouldShow ? 1 : 0, { duration: shouldShow ? 160 : 220 });
    translateY.value = withTiming(shouldShow ? 0 : -8, { duration: shouldShow ? 160 : 220 });
  }, [opacity, shouldShow, translateY]);

  useEffect(() => {
    const realtimeStartupVisible =
      isRealtimeConversationMode(conversationMode) &&
      (realtimeReadiness === "preparing-microphone" || realtimeReadiness === "connecting");
    if (isListening || isProcessing || isSpeaking || realtimeStartupVisible || !shouldShow) return;
    const timer = setTimeout(() => setOverlayVisible(false), IDLE_HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [conversationMode, isListening, isProcessing, isSpeaking, realtimeReadiness, setOverlayVisible, shouldShow]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const status = getStatusLabel({
    isListening,
    isProcessing,
    isSpeaking,
    conversationMode,
    realtimeReadiness,
  });
  const assistantText = streamingText || getFallbackAssistantText({
    isListening,
    isProcessing,
    conversationMode,
    realtimeReadiness,
  });

  return (
    <Animated.View pointerEvents="none" style={[styles.overlay, animatedStyle]}>
      <View style={styles.panel}>
        <View style={styles.statusRow}>
          <View style={styles.liveDot} />
          <Text style={styles.statusText}>{status}</Text>
        </View>
        {currentTranscript ? (
          <Text numberOfLines={2} style={styles.userText}>
            {currentTranscript}
          </Text>
        ) : null}
        {assistantText ? (
          <Text numberOfLines={3} style={styles.assistantText}>
            {assistantText}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

function getStatusLabel({
  isListening,
  isProcessing,
  isSpeaking,
  conversationMode,
  realtimeReadiness,
}: {
  isListening: boolean;
  isProcessing: boolean;
  isSpeaking: boolean;
  conversationMode: ConversationMode;
  realtimeReadiness: "idle" | "preparing-microphone" | "connecting" | "ready" | "microphone-error" | "error";
}): string {
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "preparing-microphone") return "Подготовка микрофона…";
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "connecting") return "Подключаюсь…";
  if (isProcessing) return "Думаю";
  if (isSpeaking) return "LOOI";
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "ready" && isListening) return "Готов · слушаю";
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "microphone-error") return "Микрофон не готов";
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "error") return "Нет связи";
  if (isListening) return "Слушаю";
  return "Диалог";
}

function getFallbackAssistantText({
  isListening,
  isProcessing,
  conversationMode,
  realtimeReadiness,
}: {
  isListening: boolean;
  isProcessing: boolean;
  conversationMode: ConversationMode;
  realtimeReadiness: "idle" | "preparing-microphone" | "connecting" | "ready" | "microphone-error" | "error";
}): string {
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "preparing-microphone") {
    return "Подготавливаю микрофон… Говори только после «Готов · слушаю».";
  }
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "connecting") {
    return "Подключаю Realtime… Подожди, пока появится «Готов · слушаю».";
  }
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "microphone-error") {
    return "Микрофон не подготовился. Коснись меня, чтобы попробовать снова.";
  }
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "error") {
    return "Realtime не подключился. Коснись меня, чтобы попробовать снова.";
  }
  if (isRealtimeConversationMode(conversationMode) && realtimeReadiness === "idle") {
    return "Коснись меня, чтобы начать Realtime.";
  }
  if (isListening) return isRealtimeConversationMode(conversationMode) ? "Готов. Говори, я слушаю." : "Говори, я слушаю.";
  if (isProcessing) return "…";
  return "";
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 14,
    top: 14,
    width: "36%",
    minWidth: 220,
    maxWidth: 300,
    alignItems: "flex-start",
    zIndex: 7,
  },
  panel: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(84, 220, 242, 0.28)",
    backgroundColor: "rgba(2, 8, 14, 0.66)",
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  liveDot: {
    width: 5,
    height: 5,
    borderRadius: 999,
    backgroundColor: looiTheme.cyan,
  },
  statusText: {
    color: looiTheme.muted,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  userText: {
    color: "rgba(237, 247, 255, 0.58)",
    fontSize: 10,
    lineHeight: 13,
    marginBottom: 4,
  },
  assistantText: {
    color: looiTheme.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
    textAlign: "left",
  },
});
