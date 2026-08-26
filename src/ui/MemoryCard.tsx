import { Image } from "expo-image";
import { View, Text, StyleSheet } from "react-native";
import { MemoryResult } from "../core/context-service";
import { looiTheme } from "./looi-theme";

interface MemoryCardProps {
  memory: MemoryResult;
  isDark: boolean;
}

export function MemoryCard({ memory }: MemoryCardProps) {
  const categoryLabel = getCategoryLabel(memory.metadata?.category);
  const sourceLabel = getSourceLabel(memory.metadata?.source);
  const timeStr = formatMemoryTime(memory);

  return (
    <View style={styles.card}>
      <View style={styles.copy}>
        <View style={styles.header}>
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryText}>{categoryLabel}</Text>
          </View>
          <Text style={styles.time}>{timeStr}</Text>
        </View>
        <Text style={styles.content}>{memory.memory}</Text>
        <Text style={styles.meta}>{sourceLabel}</Text>
      </View>
      {memory.metadata?.evidenceUri && (
        <Image source={{ uri: memory.metadata.evidenceUri }} style={styles.evidenceImage} />
      )}
    </View>
  );
}

function formatMemoryTime(memory: MemoryResult): string {
  const raw = memory.createdAt || memory.metadata?.timestamp;
  if (!raw) return "Время неизвестно";
  return new Date(raw).toLocaleString("ru-RU", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getCategoryLabel(category?: string): string {
  switch (category) {
    case "placement":
      return "Вещи";
    case "preference":
      return "Предпочтения";
    case "reminder":
      return "Напоминания";
    case "scene":
      return "Сцены";
    case "calendar":
      return "Календарь";
    default:
      return "Заметки";
  }
}

function getSourceLabel(source?: string): string {
  switch (source) {
    case "voice+camera":
      return "Голос + камера";
    case "voice":
      return "Голос";
    case "camera":
      return "Камера";
    case "calendar":
      return "Календарь";
    default:
      return "Система";
  }
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: 14,
    borderRadius: 22,
    padding: 16,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.surface,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  categoryBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: looiTheme.lineActive,
    backgroundColor: "rgba(40, 213, 255, 0.08)",
  },
  categoryText: {
    color: looiTheme.cyan,
    fontSize: 12,
    fontWeight: "700",
  },
  time: {
    color: looiTheme.muted,
    fontSize: 12,
  },
  content: {
    color: looiTheme.text,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: "600",
  },
  meta: {
    color: looiTheme.muted,
    fontSize: 12,
    marginTop: 10,
  },
  evidenceImage: {
    width: 168,
    minHeight: 126,
    borderRadius: 16,
    backgroundColor: looiTheme.bgRaised,
  },
});
