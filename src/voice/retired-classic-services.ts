function inactiveResponsePath(): never {
  throw new Error("Inactive response path; use Realtime PCM");
}

/**
 * Compile-time compatibility only for unreachable response code still entangled
 * with the shared wake/microphone state machine. These objects perform no network
 * requests and fail closed if that inactive branch is ever reached.
 */
export const llmService: any = {
  classifyIntent: async () => inactiveResponsePath(),
  generateResponse: async () => inactiveResponsePath(),
  generateResponseStream: async function* () {
    inactiveResponsePath();
  },
};

export const observeService: any = {
  voiceVisual: async () => inactiveResponsePath(),
};

type RetiredSessionTouchResult = {
  sessionId: string;
  isNew: boolean;
  previousSummary?: string;
};

type RetiredSessionUsage = {
  turnId?: string;
  component: "stt" | "llm" | "tts";
  model: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  usageJson?: Record<string, unknown>;
};

type RetiredUsageResult = {
  costUsd: number;
  estimated: boolean;
  pricingKnown: boolean;
};

export const sessionService = {
  async touch(): Promise<RetiredSessionTouchResult> {
    return inactiveResponsePath();
  },
  async addMessage(
    _sessionId: string,
    _message: { role: "user" | "assistant"; content: string; evidenceUri?: string }
  ): Promise<{ messageId: string }> {
    return inactiveResponsePath();
  },
  async recordUsage(
    _sessionId: string,
    _usage: RetiredSessionUsage
  ): Promise<RetiredUsageResult> {
    return inactiveResponsePath();
  },
};
