import { Image } from "expo-image";
import { View, Text, StyleSheet } from "react-native";
import { ChatMessage } from "../store/conversation";
import { looiTheme } from "./looi-theme";

interface ChatBubbleProps {
  message: ChatMessage;
  isDark: boolean;
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <View style={[styles.container, isUser ? styles.userContainer : styles.assistantContainer]}>
      <View style={[styles.marker, isUser ? styles.userMarker : styles.assistantMarker]} />
      <View style={[styles.panel, isUser ? styles.userPanel : styles.assistantPanel]}>
        <View style={styles.header}>
          <Text style={styles.roleLabel}>{isUser ? "Вы" : "LOOI"}</Text>
          <Text style={styles.timestamp}>
            {new Date(message.timestamp).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        </View>
        <Text style={[styles.text, isUser && styles.userText]}>{message.content}</Text>
        {message.evidenceUri && (
          <Image source={{ uri: message.evidenceUri }} style={styles.evidenceImage} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    flexDirection: "row",
    alignItems: "stretch",
    gap: 10,
  },
  userContainer: {
    opacity: 0.72,
  },
  assistantContainer: {
    opacity: 1,
  },
  marker: {
    width: 3,
    borderRadius: 999,
  },
  userMarker: {
    backgroundColor: "rgba(140, 155, 173, 0.4)",
  },
  assistantMarker: {
    backgroundColor: looiTheme.cyan,
  },
  panel: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  userPanel: {
    borderColor: "rgba(140, 155, 173, 0.18)",
    backgroundColor: "rgba(237, 247, 255, 0.04)",
  },
  assistantPanel: {
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.surface,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
    gap: 12,
  },
  roleLabel: {
    color: looiTheme.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  timestamp: {
    color: "rgba(140, 155, 173, 0.72)",
    fontSize: 11,
  },
  text: {
    color: looiTheme.text,
    fontSize: 16,
    lineHeight: 24,
  },
  userText: {
    color: "rgba(237, 247, 255, 0.78)",
    fontSize: 14,
  },
  evidenceImage: {
    width: "100%",
    height: 190,
    borderRadius: 14,
    marginTop: 12,
    backgroundColor: looiTheme.bgRaised,
  },
});
