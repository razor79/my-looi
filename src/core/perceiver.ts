import { Observation } from "./observation";

/**
 * Unified Perceiver interface — all perceivers output Observations
 */
export interface Perceiver {
  /** Perceiver name (e.g., "voice", "camera", "calendar") */
  name: string;

  /** Whether this perceiver is currently active */
  isActive: boolean;

  /** Start perceiving */
  start(): Promise<void>;

  /** Stop perceiving */
  stop(): Promise<void>;

  /** Subscribe to observation events */
  onObservation(handler: (observation: Observation) => void): () => void;
}

/**
 * Base class for Perceivers with common event handling
 */
export abstract class BasePerceiver implements Perceiver {
  abstract name: string;
  isActive = false;

  private handlers: Array<(observation: Observation) => void> = [];

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  onObservation(handler: (observation: Observation) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  protected emit(observation: Observation): void {
    for (const handler of this.handlers) {
      handler(observation);
    }
  }
}
