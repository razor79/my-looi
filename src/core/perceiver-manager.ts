import { Perceiver } from "./perceiver";
import { Observation } from "./observation";

/**
 * PerceiverManager — manages lifecycle of multiple perceivers
 * and dispatches observations to a unified handler
 */
export class PerceiverManager {
  private perceivers: Map<string, Perceiver> = new Map();
  private unsubscribers: Map<string, () => void> = new Map();
  private handlers: Array<(observation: Observation) => void> = [];

  /** Register a perceiver */
  register(perceiver: Perceiver): void {
    if (this.perceivers.has(perceiver.name)) {
      console.warn(`Perceiver "${perceiver.name}" already registered, replacing.`);
      this.unregister(perceiver.name);
    }

    this.perceivers.set(perceiver.name, perceiver);

    const unsub = perceiver.onObservation((obs) => {
      for (const handler of this.handlers) {
        handler(obs);
      }
    });

    this.unsubscribers.set(perceiver.name, unsub);
  }

  /** Unregister a perceiver */
  unregister(name: string): void {
    const unsub = this.unsubscribers.get(name);
    if (unsub) unsub();
    this.unsubscribers.delete(name);

    const perceiver = this.perceivers.get(name);
    if (perceiver?.isActive) {
      perceiver.stop();
    }
    this.perceivers.delete(name);
  }

  /** Start all registered perceivers */
  async startAll(): Promise<void> {
    const promises = Array.from(this.perceivers.values()).map((p) => p.start());
    await Promise.all(promises);
  }

  /** Stop all registered perceivers */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.perceivers.values()).map((p) => p.stop());
    await Promise.all(promises);
  }

  /** Start a specific perceiver */
  async start(name: string): Promise<void> {
    const perceiver = this.perceivers.get(name);
    if (!perceiver) throw new Error(`Perceiver "${name}" not found`);
    await perceiver.start();
  }

  /** Stop a specific perceiver */
  async stop(name: string): Promise<void> {
    const perceiver = this.perceivers.get(name);
    if (!perceiver) throw new Error(`Perceiver "${name}" not found`);
    await perceiver.stop();
  }

  /** Subscribe to all observations from all perceivers */
  onObservation(handler: (observation: Observation) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Get a perceiver by name */
  get(name: string): Perceiver | undefined {
    return this.perceivers.get(name);
  }

  /** Get all registered perceiver names */
  getRegisteredNames(): string[] {
    return Array.from(this.perceivers.keys());
  }
}

/** Singleton instance */
export const perceiverManager = new PerceiverManager();
