import { Observation } from "./observation";
import { UserIntent, MemoryResult } from "./context-service";

export type DecisionAction =
  | { type: "respond"; message: string }
  | { type: "store"; message: string }
  | { type: "remind"; message: string }
  | { type: "ignore" };

/**
 * DecisionEngine — determines whether to respond, store, remind, or ignore
 */
export interface DecisionEngine {
  /** Decide what action to take based on observation and context */
  decide(
    observation: Observation,
    intent: UserIntent,
    relatedMemories: MemoryResult[]
  ): Promise<DecisionAction>;
}
