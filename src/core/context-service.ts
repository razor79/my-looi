import { Observation, MemoryCategory } from "./observation";
import type { ResponseLanguage } from "../language/response-language";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  intent?: UserIntent;
  memories?: MemoryResult[];
  evidenceUri?: string;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  endedAt?: string | null;
  summary?: string | null;
  status?: "active" | "closed" | string;
  messageCount: number;
  costUsd?: number;
  sttCostUsd?: number;
  llmCostUsd?: number;
  ttsCostUsd?: number;
  usageEventCount?: number;
  hasEstimatedCost?: boolean;
}

export interface MemoryResult {
  id: string;
  memory: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: {
    category?: MemoryCategory;
    source?: string;
    timestamp?: string;
    evidenceUri?: string;
    description?: string;
    placementFact?: string;
  };
  score?: number;
}

export type UserIntent = "store" | "search" | "remind" | "chat";

/** Local long-term memory interface. */
export interface ContextService {
  /** Store an observation as memory */
  remember(messages: Message[], metadata: Observation["metadata"]): Promise<void>;

  /** Semantic search for memories */
  search(query: string, filters?: { category?: MemoryCategory }): Promise<MemoryResult[]>;

  /** Get all memories with optional category filter */
  getAll(filters?: { category?: MemoryCategory }): Promise<MemoryResult[]>;
}
