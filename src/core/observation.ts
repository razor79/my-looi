/**
 * Observation Source — each Perceiver corresponds to a source type
 */
export type ObservationSource =
  | "voice"
  | "camera"
  | "voice+camera"
  | "calendar"
  | "system";

/**
 * Memory category tags — used for Mem0 metadata filters and local memory metadata.
 *
 * The built-in tags are recommendations produced by our own classifiers, not a
 * closed schema. Server/AI memory may legitimately create additional semantic
 * tags (for example `english_learning`), so persisted categories must remain
 * opaque strings end-to-end.
 */
export type KnownMemoryCategory =
  | "placement"
  | "preference"
  | "reminder"
  | "scene"
  | "note"
  | "calendar";

export type MemoryCategory = string;

/**
 * Observation metadata
 */
export interface ObservationMetadata {
  category: MemoryCategory;
  source: ObservationSource;
  timestamp: string; // ISO 8601
  confidence?: number; // 0-1
  location?: string;
  evidenceUri?: string;
}

/**
 * Unified Observation model — output of all Perceivers
 */
export interface Observation {
  /** Text content: voice transcript or vision description */
  content: string;

  /** Evidence URI (local server HTTP path) */
  evidenceUri?: string;

  /** Metadata */
  metadata: ObservationMetadata;
}

/**
 * Create an Observation with defaults
 */
export function createObservation(
  content: string,
  source: ObservationSource,
  category: MemoryCategory,
  options?: {
    evidenceUri?: string;
    confidence?: number;
    location?: string;
  }
): Observation {
  return {
    content,
    evidenceUri: options?.evidenceUri,
    metadata: {
      category,
      source,
      timestamp: new Date().toISOString(),
      confidence: options?.confidence,
      location: options?.location,
      evidenceUri: options?.evidenceUri,
    },
  };
}
