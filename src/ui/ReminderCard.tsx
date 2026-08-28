import { View, Text, StyleSheet, useColorScheme } from "react-native";
import { useUiText } from "@/src/i18n/use-ui-text";

interface ReminderCardProps {
  title: string;
  body: string;
  time?: string;
  relatedMemory?: string;
}

export function ReminderCard({ title, body, time, relatedMemory }: ReminderCardProps) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const { t } = useUiText();

  return (
    <View style={[styles.card, { backgroundColor: isDark ? "#1E1B4B" : "#EDE9FE" }]}>
      <View style={styles.header}>
        <Text style={styles.icon}>🔔</Text>
        <Text style={[styles.title, { color: isDark ? "#F9FAFB" : "#1F2937" }]}>{title}</Text>
      </View>
      <Text style={[styles.body, { color: isDark ? "#D1D5DB" : "#4B5563" }]}>{body}</Text>
      {time && (
        <Text style={[styles.time, { color: isDark ? "#9CA3AF" : "#6B7280" }]}>⏰ {time}</Text>
      )}
      {relatedMemory && (
        <View style={[styles.relatedBox, { backgroundColor: isDark ? "#312E81" : "#DDD6FE" }]}>
          <Text style={[styles.relatedLabel, { color: isDark ? "#A5B4FC" : "#5B21B6" }]}>
            {t("memory.related")}
          </Text>
          <Text style={[styles.relatedText, { color: isDark ? "#E0E7FF" : "#3730A3" }]}>
            {relatedMemory}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 14,
    marginVertical: 6,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  icon: { fontSize: 16 },
  title: { fontSize: 15, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 20 },
  time: { fontSize: 12, marginTop: 8 },
  relatedBox: { marginTop: 10, padding: 10, borderRadius: 8 },
  relatedLabel: { fontSize: 11, fontWeight: "600", marginBottom: 2 },
  relatedText: { fontSize: 13 },
});
