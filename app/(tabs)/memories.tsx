import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { memoryService } from "@/src/memory/memory-service";
import { MemoryResult } from "@/src/core/context-service";
import { MemoryCard } from "@/src/ui/MemoryCard";
import { MemoryCategory } from "@/src/core/observation";
import { DeviceShell, DeviceShellHeader } from "@/src/ui/DeviceShell";
import { looiTheme } from "@/src/ui/looi-theme";

const CATEGORIES: { label: string; value: MemoryCategory | "all" }[] = [
  { label: "Все", value: "all" },
  { label: "Вещи", value: "placement" },
  { label: "Предпочтения", value: "preference" },
  { label: "Напоминания", value: "reminder" },
  { label: "Заметки", value: "note" },
  { label: "Календарь", value: "calendar" },
];

type MemorySection = {
  title: "Сегодня" | "Вчера" | "Раньше";
  data: MemoryResult[];
};

type MemoryViewState = {
  memories: MemoryResult[];
  refreshing: boolean;
  loading: boolean;
  loadError: string | null;
};

type MemoryViewAction =
  | { type: "load-start" }
  | { type: "refresh-start" }
  | { type: "load-success"; memories: MemoryResult[] }
  | { type: "load-failure"; message: string };

const initialMemoryViewState: MemoryViewState = {
  memories: [],
  refreshing: false,
  loading: true,
  loadError: null,
};

export default function MemoriesScreen() {
  const [{ memories, refreshing, loading, loadError }, dispatch] = useReducer(
    memoryViewReducer,
    initialMemoryViewState
  );
  const [selectedCategory, setSelectedCategory] = useState<MemoryCategory | "all">("all");

  const loadMemories = useCallback(async () => {
    dispatch({ type: "load-start" });

    try {
      const filters =
        selectedCategory === "all" ? undefined : { category: selectedCategory };
      const results = await memoryService.getAll(filters);
      dispatch({ type: "load-success", memories: results });
    } catch (error) {
      dispatch({
        type: "load-failure",
        message: getMemoryLoadErrorMessage(error),
      });
    }
  }, [selectedCategory]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const onRefresh = useCallback(() => {
    dispatch({ type: "refresh-start" });
    loadMemories();
  }, [loadMemories]);

  const sections = useMemo(() => groupMemories(memories), [memories]);
  const renderMemory = useCallback(
    ({ item }: { item: MemoryResult }) => <MemoryCard memory={item} isDark />,
    []
  );
  const refreshControl = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={looiTheme.cyan}
      />
    ),
    [onRefresh, refreshing]
  );
  const listHeader = (
    <>
      <DeviceShellHeader title="Память" eyebrow="ЗАПИСИ LOOI" />
      <View style={styles.headerPanel}>
        <View>
          <Text style={styles.headerLabel}>Сохранённые факты</Text>
          <Text style={styles.headerCopy}>
            {loadError ?? "Недавние факты и связанные изображения."}
          </Text>
        </View>
        <Text style={styles.countText}>{memories.length}</Text>
      </View>

      <View style={styles.filterRow}>
        {CATEGORIES.map((cat) => {
          const active = selectedCategory === cat.value;
          return (
            <Pressable
              key={cat.value}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setSelectedCategory(cat.value)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {cat.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </>
  );

  return (
    <DeviceShell title="Память" eyebrow="ЗАПИСИ LOOI" scroll={false}>
      <SectionList
        sections={sections}
        style={styles.list}
        keyExtractor={(item) => item.id}
        renderItem={renderMemory}
        ListHeaderComponent={listHeader}
        renderSectionHeader={({ section }) =>
          section.data.length > 0 ? (
            <Text style={styles.sectionTitle}>{section.title}</Text>
          ) : null
        }
        contentContainerStyle={[
          styles.listContent,
          sections.every((section) => section.data.length === 0) && styles.emptyListContent,
        ]}
        refreshControl={refreshControl}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>
              {loading ? "Загрузка…" : loadError ? "Память недоступна" : "Память пока пуста"}
            </Text>
            <Text style={styles.emptyText}>
              {loadError || "LOOI сохранит здесь полезные факты после подтверждения."}
            </Text>
          </View>
        }
      />
    </DeviceShell>
  );
}

function memoryViewReducer(
  state: MemoryViewState,
  action: MemoryViewAction
): MemoryViewState {
  switch (action.type) {
    case "load-start":
      return {
        ...state,
        loading: true,
        loadError: null,
      };
    case "refresh-start":
      return {
        ...state,
        refreshing: true,
      };
    case "load-success":
      return {
        memories: action.memories,
        refreshing: false,
        loading: false,
        loadError: null,
      };
    case "load-failure":
      return {
        memories: [],
        refreshing: false,
        loading: false,
        loadError: action.message,
      };
  }
}

function groupMemories(memories: MemoryResult[]): MemorySection[] {
  const sorted = [...memories].sort(compareMemoryByNewest);
  const groups: MemorySection[] = [
    { title: "Сегодня", data: [] },
    { title: "Вчера", data: [] },
    { title: "Раньше", data: [] },
  ];

  sorted.forEach((memory) => {
    const bucket = getMemoryBucket(memory);
    groups.find((group) => group.title === bucket)?.data.push(memory);
  });

  return groups.filter((group) => group.data.length > 0);
}

function getMemoryBucket(memory: MemoryResult): MemorySection["title"] {
  const time = getMemoryTime(memory);
  if (!time) return "Раньше";

  const date = new Date(time);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  if (date.getTime() >= todayStart) return "Сегодня";
  if (date.getTime() >= yesterdayStart) return "Вчера";
  return "Раньше";
}

function getMemoryTime(memory: MemoryResult): number {
  const rawTime = memory.createdAt || memory.metadata?.timestamp;
  return rawTime ? new Date(rawTime).getTime() : 0;
}

function compareMemoryByNewest(a: MemoryResult, b: MemoryResult): number {
  return getMemoryTime(b) - getMemoryTime(a);
}

function getMemoryLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("Failed to connect")) {
    return "Сервис памяти недоступен. Попробуй обновить страницу позже.";
  }

  return "Не удалось загрузить память. Попробуй обновить страницу позже.";
}

const styles = StyleSheet.create({
  headerPanel: {
    minHeight: 82,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.surface,
    paddingHorizontal: 18,
    paddingVertical: 14,
    marginBottom: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 18,
  },
  headerLabel: {
    color: looiTheme.text,
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 4,
  },
  headerCopy: {
    color: looiTheme.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  countText: {
    color: looiTheme.cyan,
    fontSize: 22,
    fontWeight: "700",
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 14,
  },
  chip: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: "rgba(237, 247, 255, 0.04)",
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: {
    borderColor: looiTheme.lineActive,
    backgroundColor: "rgba(40, 213, 255, 0.08)",
  },
  chipText: {
    color: looiTheme.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  chipTextActive: {
    color: looiTheme.cyan,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 28,
    gap: 12,
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: "center",
  },
  sectionTitle: {
    color: looiTheme.text,
    fontSize: 19,
    fontWeight: "700",
    marginTop: 4,
    marginBottom: 10,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 60,
  },
  emptyTitle: {
    color: looiTheme.text,
    fontSize: 22,
    fontWeight: "700",
  },
  emptyText: {
    color: looiTheme.muted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },
});
