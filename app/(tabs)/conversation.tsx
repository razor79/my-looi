import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ChatMessage, SessionSummary } from "@/src/core/context-service";
import {
  getLocalConversationMessages,
  listLocalConversationSessions,
} from "@/src/memory/memory-service";
import { useConversationStore } from "@/src/store/conversation";
import { ChatBubble } from "@/src/ui/ChatBubble";
import { DeviceShell, DeviceShellHeader } from "@/src/ui/DeviceShell";
import { looiTheme } from "@/src/ui/looi-theme";
import { useUiText } from "@/src/i18n/use-ui-text";

type LoadedMessages = Record<string, ChatMessage[]>;

type HistoryState = {
  sessions: SessionSummary[];
  expandedSessionId: string | null;
  loadedMessages: LoadedMessages;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
};

type HistoryAction =
  | { type: "load:start"; refresh: boolean }
  | { type: "load:success"; sessions: SessionSummary[] }
  | { type: "load:error"; error: string }
  | { type: "messages:success"; sessionId: string; messages: ChatMessage[] }
  | { type: "messages:error"; error: string }
  | { type: "toggle"; sessionId: string };

const initialHistoryState: HistoryState = {
  sessions: [],
  expandedSessionId: null,
  loadedMessages: {},
  loading: true,
  refreshing: false,
  error: null,
};

const EMPTY_SESSIONS: SessionSummary[] = [];

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "load:start":
      return {
        ...state,
        loading: !action.refresh,
        refreshing: action.refresh,
        error: null,
      };
    case "load:success":
      return {
        ...state,
        sessions: action.sessions,
        loading: false,
        refreshing: false,
      };
    case "load:error":
      return {
        ...state,
        loading: false,
        refreshing: false,
        error: action.error,
      };
    case "messages:success":
      return {
        ...state,
        loadedMessages: {
          ...state.loadedMessages,
          [action.sessionId]: action.messages,
        },
      };
    case "messages:error":
      return { ...state, error: action.error };
    case "toggle":
      return {
        ...state,
        expandedSessionId:
          state.expandedSessionId === action.sessionId ? null : action.sessionId,
      };
    default:
      return state;
  }
}

export default function ConversationScreen() {
  const router = useRouter();
  const activeSessionId = useConversationStore((state) => state.activeSessionId);
  const activeMessages = useConversationStore((state) => state.messages);
  const [state, dispatch] = useReducer(historyReducer, initialHistoryState);
  const { locale, t } = useUiText();
  const { sessions, expandedSessionId, loadedMessages, loading, refreshing, error } = state;

  const orderedSessions = useMemo(() => {
    const activeSession = activeSessionId
      ? sessions.find((session) => session.id === activeSessionId)
      : undefined;
    const rest = sessions.filter((session) => session.id !== activeSessionId);
    return activeSession ? [activeSession, ...rest] : rest;
  }, [activeSessionId, sessions]);

  const loadSessions = useCallback(async (isRefresh = false) => {
    dispatch({ type: "load:start", refresh: isRefresh });

    try {
      const sessions = await listLocalConversationSessions({ limit: 40 });
      dispatch({ type: "load:success", sessions });
    } catch (loadError) {
      console.warn("[ConversationScreen] Failed to load sessions:", loadError);
      dispatch({ type: "load:error", error: t("history.loadError") });
    }
  }, [t]);

  const loadMessages = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId && activeMessages.length > 0) {
        dispatch({ type: "messages:success", sessionId, messages: activeMessages });
        return;
      }

      if (loadedMessages[sessionId]) {
        return;
      }

      try {
        const messages = await getLocalConversationMessages(sessionId);
        dispatch({ type: "messages:success", sessionId, messages });
      } catch (loadError) {
        console.warn("[ConversationScreen] Failed to load messages:", loadError);
        dispatch({ type: "messages:error", error: t("history.messagesLoadError") });
      }
    },
    [activeMessages, activeSessionId, loadedMessages, t]
  );

  const toggleSession = useCallback(
    (sessionId: string) => {
      const nextId = expandedSessionId === sessionId ? null : sessionId;
      dispatch({ type: "toggle", sessionId });
      if (nextId) {
        loadMessages(nextId);
      }
    },
    [expandedSessionId, loadMessages]
  );

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (activeSessionId) {
      dispatch({ type: "messages:success", sessionId: activeSessionId, messages: activeMessages });
    }
  }, [activeMessages, activeSessionId]);

  const renderSession = useCallback(
    ({ item }: { item: SessionSummary }) => {
      const isExpanded = expandedSessionId === item.id;
      const isActive = item.id === activeSessionId;
      const messages = loadedMessages[item.id] ?? [];

      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => toggleSession(item.id)}
          style={[styles.sessionCard, isActive && styles.activeSessionCard]}
        >
          <View style={styles.sessionHeader}>
            <View style={styles.sessionTitleGroup}>
              <View style={styles.sessionTitleRow}>
                <Text style={styles.sessionTitle}>{formatSessionTitle(item, locale, t("history.untitled"))}</Text>
                {isActive ? <Text style={styles.activeBadge}>{t("history.active")}</Text> : null}
              </View>
              <Text style={styles.sessionMeta}>
                {formatTimeRange(item, isActive, locale, t("common.now"))} · {t("history.messages", { count: item.messageCount })}
                {(item.usageEventCount ?? 0) > 0
                  ? ` · 💰 ${item.hasEstimatedCost ? "~" : ""}$${(item.costUsd ?? 0).toFixed(4)}`
                  : ""}
              </Text>
              {(item.usageEventCount ?? 0) > 0 ? (
                <Text style={styles.costBreakdown}>
                  STT ${(item.sttCostUsd ?? 0).toFixed(4)} · LLM ${(item.llmCostUsd ?? 0).toFixed(4)} · TTS ~${(item.ttsCostUsd ?? 0).toFixed(4)}
                </Text>
              ) : null}
            </View>
            <Text style={styles.expandMark}>{isExpanded ? t("history.hide") : t("history.show")}</Text>
          </View>

          <Text numberOfLines={isExpanded ? 4 : 2} style={styles.summaryText}>
            {item.summary || (isActive ? t("history.activeSummary") : t("history.noSummary"))}
          </Text>

          {isExpanded ? (
            <View style={styles.messageList}>
              {messages.length > 0 ? (
                messages.map((message) => (
                  <ChatBubble key={message.id} message={message} isDark />
                ))
              ) : (
                <View style={styles.messagesLoading}>
                  <ActivityIndicator color={looiTheme.cyan} />
                  <Text style={styles.messagesLoadingText}>{t("history.loadingMessages")}</Text>
                </View>
              )}
            </View>
          ) : null}
        </Pressable>
      );
    },
    [activeSessionId, expandedSessionId, loadedMessages, locale, t, toggleSession]
  );

  const listHeader = (
    <>
      <DeviceShellHeader
        title={t("history.title")}
        eyebrow={t("history.eyebrow")}
        onReturnHome={() => router.replace("/")}
      />
      <View style={styles.headerBand}>
        <Text style={styles.headerLabel}>{t("history.heading")}</Text>
        <Text style={styles.headerValue}>
          {activeSessionId ? t("history.localActive") : t("history.localStored")}
        </Text>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </>
  );

  return (
    <DeviceShell
      title={t("history.title")}
      eyebrow={t("history.eyebrow")}
      scroll={false}
      onReturnHome={() => router.replace("/")}
    >
      <View style={styles.screen}>
        {loading ? (
          <FlatList
            data={EMPTY_SESSIONS}
            renderItem={null}
            ListHeaderComponent={listHeader}
            ListEmptyComponent={
              <View style={styles.loadingState}>
                <ActivityIndicator color={looiTheme.cyan} />
                <Text style={styles.loadingText}>{t("history.loading")}</Text>
              </View>
            }
            contentContainerStyle={[styles.listContent, styles.emptyListContent]}
            showsVerticalScrollIndicator={false}
          />
        ) : (
          <FlatList
            data={orderedSessions}
            keyExtractor={(item) => item.id}
            renderItem={renderSession}
            ListHeaderComponent={listHeader}
            contentContainerStyle={[
              styles.listContent,
              orderedSessions.length === 0 && styles.emptyListContent,
            ]}
            refreshing={refreshing}
            onRefresh={() => loadSessions(true)}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>{t("history.empty")}</Text>
                <Text style={styles.emptyBody}>{t("history.emptyHelp")}</Text>
              </View>
            }
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </DeviceShell>
  );
}

function formatSessionTitle(session: SessionSummary, locale: string, untitled: string): string {
  const date = new Date(session.startedAt);
  if (Number.isNaN(date.getTime())) {
    return untitled;
  }
  return date.toLocaleDateString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimeRange(session: SessionSummary, isActive: boolean, locale: string, nowLabel: string): string {
  const startedAt = formatClock(session.startedAt, locale);
  const endedAt = isActive ? nowLabel : session.endedAt ? formatClock(session.endedAt, locale) : "--:--";
  return `${startedAt} - ${endedAt}`;
}

function formatClock(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  headerBand: {
    minHeight: 76,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.surface,
    paddingHorizontal: 18,
    paddingVertical: 14,
    justifyContent: "center",
    marginBottom: 14,
  },
  headerLabel: {
    color: looiTheme.muted,
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 5,
  },
  headerValue: {
    color: looiTheme.text,
    fontSize: 20,
    fontWeight: "700",
  },
  errorText: {
    color: looiTheme.warn,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  loadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: {
    color: looiTheme.muted,
    fontSize: 14,
  },
  listContent: {
    paddingBottom: 18,
    gap: 12,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  sessionCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  activeSessionCard: {
    borderColor: looiTheme.lineActive,
    backgroundColor: looiTheme.surfaceStrong,
  },
  sessionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  sessionTitleGroup: {
    flex: 1,
    gap: 5,
  },
  sessionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  sessionTitle: {
    color: looiTheme.text,
    fontSize: 17,
    fontWeight: "800",
  },
  activeBadge: {
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: "rgba(77, 231, 180, 0.14)",
    color: looiTheme.ok,
    fontSize: 11,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  sessionMeta: {
    color: looiTheme.muted,
    fontSize: 12,
  },

  costBreakdown: {
    color: looiTheme.muted,
    fontSize: 10,
    marginTop: 3,
  },  expandMark: {
    color: looiTheme.cyan,
    fontSize: 13,
    fontWeight: "800",
  },
  summaryText: {
    color: "rgba(237, 247, 255, 0.76)",
    fontSize: 14,
    lineHeight: 21,
  },
  messageList: {
    borderTopWidth: 1,
    borderTopColor: looiTheme.line,
    paddingTop: 12,
    gap: 10,
  },
  messagesLoading: {
    minHeight: 72,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  messagesLoadingText: {
    color: looiTheme.muted,
    fontSize: 13,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    color: looiTheme.text,
    fontSize: 22,
    fontWeight: "800",
  },
  emptyBody: {
    color: looiTheme.muted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
});
