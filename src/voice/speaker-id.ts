import * as SecureStore from "expo-secure-store";
import { createMMKV } from "react-native-mmkv";
import { recordDiagnosticEvent } from "../diagnostics/diagnostic-log";

const OWNER_SPEAKER_NAME = "owner";
const OWNER_EMBEDDING_MMKV_KEY = "owner_speaker_embedding";
const OWNER_SCORE_TRACE_MMKV_KEY = "owner_speaker_verification_traces";
const OWNER_EMBEDDING_META_KEY = "looi.owner_speaker_embedding.meta";
const OWNER_EMBEDDING_CHUNK_KEY_PREFIX = "looi.owner_speaker_embedding.chunk.";
const OWNER_EMBEDDING_CHUNK_SIZE = 1800;
const MAX_OWNER_TEMPLATES = 8;
const MAX_SCORE_TRACES = 100;
const DEFAULT_SAMPLE_RATE = 16000;
const speakerStorage = createMMKV({
  id: "looi.voice.speaker-id",
});

export type SpeakerEnrollmentSource = "onboarding" | "settings-append" | "migration";

export type SpeakerEnrollmentQuality = {
  ok: boolean;
  durationMs: number;
  energyMean?: number;
  reason?: "too-short" | "too-quiet" | "low-confidence";
};

export interface StoredSpeakerTemplate {
  id: string;
  embedding: number[];
  createdAt: string;
  source: SpeakerEnrollmentSource;
  durationMs: number;
  quality: SpeakerEnrollmentQuality;
  promptId?: string;
  lastMatchedAt?: string;
  matchCount?: number;
}

export interface StoredSpeakerEmbedding {
  version: 2;
  speakerName: string;
  templates: StoredSpeakerTemplate[];
  centroid: number[];
  createdAt: string;
  updatedAt: string;
}

interface StoredSpeakerEmbeddingV1 {
  version: 1;
  speakerName: string;
  embedding: number[];
  createdAt: string;
}

type StoredSpeakerPayload = StoredSpeakerEmbedding | StoredSpeakerEmbeddingV1;

export type SpeakerVerificationTraceSource =
  | "live"
  | "diagnostic-owner"
  | "settings-check";

export interface SpeakerVerificationTrace {
  id: string;
  createdAt: string;
  verified: boolean;
  threshold: number;
  score: number;
  centroidScore: number;
  bestTemplateScore: number;
  bestTemplateId?: string;
  sampleDurationMs: number;
  source: SpeakerVerificationTraceSource;
}

export type SpeakerEnrollmentSampleInput =
  | number[]
  | {
      samples: number[];
      promptId?: string;
      durationMs?: number;
      quality?: Partial<SpeakerEnrollmentQuality>;
    };

export interface SpeakerEnrollmentOptions {
  source?: SpeakerEnrollmentSource;
  promptId?: string;
  durationMs?: number;
  quality?: Partial<SpeakerEnrollmentQuality>;
}

export interface SpeakerEnrollmentSummary {
  enrolled: boolean;
  version: 2 | null;
  sampleCount: number;
  templates: Array<Omit<StoredSpeakerTemplate, "embedding">>;
  createdAt?: string;
  updatedAt?: string;
  threshold: number;
  templateLimit: number;
  traceCount: number;
}

export interface AppendEnrollmentResult {
  action: "appended" | "replaced";
  templateCount: number;
  templateId: string;
  replacedTemplateId?: string;
  reason: string;
}

interface NormalizedEnrollmentSample {
  samples: number[];
  promptId?: string;
  durationMs?: number;
  quality?: Partial<SpeakerEnrollmentQuality>;
}

interface LocalVerificationResult {
  verified: boolean;
  score: number;
  centroidScore: number;
  bestTemplateScore: number;
  bestTemplateId?: string;
}

async function getSherpaVoiceAdapter() {
  const { sherpaVoiceAdapter } = await import("./sherpa-adapter");
  return sherpaVoiceAdapter;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => Number.isFinite(item));
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / norm);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function computeCentroid(templates: StoredSpeakerTemplate[]): number[] {
  const firstTemplate = templates[0];
  if (!firstTemplate) {
    return [];
  }

  const dimensions = firstTemplate.embedding.length;
  const sums = new Array<number>(dimensions).fill(0);
  let included = 0;
  for (const template of templates) {
    if (template.embedding.length !== dimensions) {
      continue;
    }
    const normalized = normalizeVector(template.embedding);
    for (let index = 0; index < dimensions; index += 1) {
      sums[index] += normalized[index];
    }
    included += 1;
  }

  if (included === 0) {
    return [];
  }

  return normalizeVector(sums.map((value) => value / included));
}

function calculateSamplesDurationMs(samples: number[]): number {
  return Math.round((samples.length / DEFAULT_SAMPLE_RATE) * 1000);
}

function buildQuality(
  samples: number[] | null,
  durationMs: number | undefined,
  quality: Partial<SpeakerEnrollmentQuality> | undefined
): SpeakerEnrollmentQuality {
  const resolvedDurationMs = quality?.durationMs ?? durationMs ?? (samples ? calculateSamplesDurationMs(samples) : 0);
  return {
    ok: quality?.ok ?? true,
    durationMs: resolvedDurationMs,
    energyMean: quality?.energyMean,
    reason: quality?.reason,
  };
}

function normalizeEnrollmentSamples(
  input: number[] | SpeakerEnrollmentSampleInput[],
  options: SpeakerEnrollmentOptions
): NormalizedEnrollmentSample[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [];
  }

  if (typeof input[0] === "number") {
    return [
      {
        samples: input as number[],
        promptId: options.promptId,
        durationMs: options.durationMs,
        quality: options.quality,
      },
    ];
  }

  return (input as SpeakerEnrollmentSampleInput[]).map((sample) => {
    if (Array.isArray(sample)) {
      return {
        samples: sample,
        promptId: options.promptId,
        durationMs: options.durationMs,
        quality: options.quality,
      };
    }

    return {
      samples: sample.samples,
      promptId: sample.promptId ?? options.promptId,
      durationMs: sample.durationMs ?? options.durationMs,
      quality: {
        ...options.quality,
        ...sample.quality,
      },
    };
  });
}

function isStoredSpeakerEmbeddingV1(value: unknown): value is StoredSpeakerEmbeddingV1 {
  const stored = value as StoredSpeakerEmbeddingV1;
  return (
    stored?.version === 1 &&
    stored.speakerName === OWNER_SPEAKER_NAME &&
    isFiniteNumberArray(stored.embedding) &&
    typeof stored.createdAt === "string"
  );
}

function isStoredSpeakerTemplate(value: unknown): value is StoredSpeakerTemplate {
  const template = value as StoredSpeakerTemplate;
  return (
    typeof template?.id === "string" &&
    isFiniteNumberArray(template.embedding) &&
    typeof template.createdAt === "string" &&
    (template.source === "onboarding" ||
      template.source === "settings-append" ||
      template.source === "migration") &&
    typeof template.durationMs === "number" &&
    typeof template.quality?.ok === "boolean" &&
    typeof template.quality.durationMs === "number"
  );
}

function isStoredSpeakerEmbeddingV2(value: unknown): value is StoredSpeakerEmbedding {
  const stored = value as StoredSpeakerEmbedding;
  return (
    stored?.version === 2 &&
    stored.speakerName === OWNER_SPEAKER_NAME &&
    Array.isArray(stored.templates) &&
    stored.templates.length > 0 &&
    stored.templates.every(isStoredSpeakerTemplate) &&
    isFiniteNumberArray(stored.centroid) &&
    typeof stored.createdAt === "string" &&
    typeof stored.updatedAt === "string"
  );
}

function migrateV1ToV2(stored: StoredSpeakerEmbeddingV1): StoredSpeakerEmbedding {
  const createdAt = stored.createdAt || new Date().toISOString();
  const template: StoredSpeakerTemplate = {
    id: createId("speaker-template-migration"),
    embedding: stored.embedding,
    createdAt,
    source: "migration",
    durationMs: 0,
    quality: {
      ok: true,
      durationMs: 0,
    },
  };

  return {
    version: 2,
    speakerName: OWNER_SPEAKER_NAME,
    templates: [template],
    centroid: computeCentroid([template]),
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function evaluateEmbedding(
  stored: StoredSpeakerEmbedding,
  embedding: number[],
  threshold: number
): LocalVerificationResult {
  const centroidScore = cosineSimilarity(embedding, stored.centroid);
  let bestTemplateScore = 0;
  let bestTemplateId: string | undefined;

  for (const template of stored.templates) {
    const score = cosineSimilarity(embedding, template.embedding);
    if (score > bestTemplateScore || !bestTemplateId) {
      bestTemplateScore = score;
      bestTemplateId = template.id;
    }
  }

  const score = Math.max(centroidScore, bestTemplateScore);
  return {
    verified: score >= threshold,
    score,
    centroidScore,
    bestTemplateScore,
    bestTemplateId,
  };
}

function compareTemplateQuality(left: StoredSpeakerTemplate, right: StoredSpeakerTemplate): number {
  if (left.quality.ok !== right.quality.ok) {
    return left.quality.ok ? 1 : -1;
  }

  if (left.quality.durationMs !== right.quality.durationMs) {
    return left.quality.durationMs - right.quality.durationMs;
  }

  return (left.quality.energyMean ?? 0) - (right.quality.energyMean ?? 0);
}

function hasEquivalentTemplateQuality(
  left: StoredSpeakerTemplate,
  right: StoredSpeakerTemplate
): boolean {
  return (
    left.quality.ok === right.quality.ok &&
    left.quality.durationMs === right.quality.durationMs &&
    (left.quality.energyMean ?? 0) === (right.quality.energyMean ?? 0)
  );
}

function selectTemplateForReplacement(templates: StoredSpeakerTemplate[]): {
  index: number;
  reason: string;
} {
  const qualityRanked = templates
    .map((template, index) => ({ template, index }))
    .sort((left, right) => compareTemplateQuality(left.template, right.template));
  const lowestQuality = qualityRanked[0];
  const highestQuality = qualityRanked[qualityRanked.length - 1];
  if (
    lowestQuality &&
    highestQuality &&
    !hasEquivalentTemplateQuality(lowestQuality.template, highestQuality.template)
  ) {
    return {
      index: lowestQuality.index,
      reason: `replaced lowest-quality template ${lowestQuality.template.id}`,
    };
  }

  if (templates.length > 1) {
    let redundantIndex = -1;
    let redundantScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < templates.length; index += 1) {
      let total = 0;
      let comparisons = 0;
      for (let otherIndex = 0; otherIndex < templates.length; otherIndex += 1) {
        if (index === otherIndex) {
          continue;
        }
        total += cosineSimilarity(templates[index].embedding, templates[otherIndex].embedding);
        comparisons += 1;
      }
      const averageScore = comparisons > 0 ? total / comparisons : Number.NEGATIVE_INFINITY;
      if (averageScore > redundantScore) {
        redundantScore = averageScore;
        redundantIndex = index;
      }
    }

    if (redundantIndex >= 0) {
      return {
        index: redundantIndex,
        reason: `replaced redundant template ${templates[redundantIndex].id}`,
      };
    }
  }

  let oldestIndex = 0;
  for (let index = 1; index < templates.length; index += 1) {
    const template = templates[index];
    const oldest = templates[oldestIndex];
    const templateLastMatched = template.lastMatchedAt ? Date.parse(template.lastMatchedAt) : 0;
    const oldestLastMatched = oldest.lastMatchedAt ? Date.parse(oldest.lastMatchedAt) : 0;
    const templateCreated = Date.parse(template.createdAt);
    const oldestCreated = Date.parse(oldest.createdAt);
    if (templateLastMatched < oldestLastMatched) {
      oldestIndex = index;
    } else if (templateLastMatched === oldestLastMatched && templateCreated < oldestCreated) {
      oldestIndex = index;
    }
  }

  return {
    index: oldestIndex,
    reason: `replaced oldest template ${templates[oldestIndex].id}`,
  };
}

export class SpeakerIdService {
  private enrolled = false;
  private readonly verificationThreshold = 0.35;

  async getStoredEnrollmentStatus(): Promise<boolean> {
    if (this.enrolled) return true;
    const stored = await this.readOwnerEmbedding();
    this.enrolled = Boolean(stored);
    return this.enrolled;
  }

  async getEnrollmentSummary(): Promise<SpeakerEnrollmentSummary> {
    const stored = await this.readOwnerEmbedding();
    const traces = this.readScoreTraces();
    return {
      enrolled: Boolean(stored),
      version: stored ? 2 : null,
      sampleCount: stored?.templates.length ?? 0,
      templates:
        stored?.templates.map(({ embedding: _embedding, ...template }) => ({
          ...template,
        })) ?? [],
      createdAt: stored?.createdAt,
      updatedAt: stored?.updatedAt,
      threshold: this.verificationThreshold,
      templateLimit: MAX_OWNER_TEMPLATES,
      traceCount: traces.length,
    };
  }

  async getScoreTraces(): Promise<SpeakerVerificationTrace[]> {
    return this.readScoreTraces();
  }

  async refreshEnrollmentStatus(): Promise<boolean> {
    const stored = await this.readOwnerEmbedding();
    if (!stored) {
      this.enrolled = false;
      console.log("[SpeakerId] Enrollment status refreshed: enrolled=false");
      return false;
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    if (!(await sherpaVoiceAdapter.hasSpeaker(OWNER_SPEAKER_NAME))) {
      await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, stored.centroid);
    }
    this.enrolled = true;
    console.log(`[SpeakerId] Enrollment status refreshed: enrolled=${this.enrolled}`);
    return this.enrolled;
  }

  get isEnrolled(): boolean {
    return this.enrolled;
  }

  async enroll(
    audioSamples: number[] | SpeakerEnrollmentSampleInput[] = [],
    options: SpeakerEnrollmentOptions = {}
  ): Promise<void> {
    const samples = normalizeEnrollmentSamples(audioSamples, options);
    if (samples.length === 0) {
      throw new Error("Speaker enrollment requires audio samples");
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const templates: StoredSpeakerTemplate[] = [];
    const now = new Date().toISOString();
    for (const sample of samples) {
      if (!isFiniteNumberArray(sample.samples)) {
        throw new Error("Speaker enrollment sample must be a non-empty finite number array");
      }
      const embedding = await sherpaVoiceAdapter.computeSpeakerEmbedding(sample.samples);
      templates.push(
        this.buildTemplate(embedding, {
          source: options.source ?? "onboarding",
          promptId: sample.promptId,
          durationMs: sample.durationMs,
          quality: buildQuality(sample.samples, sample.durationMs, sample.quality),
        })
      );
    }

    const stored = this.buildStoredEmbedding(templates, now);
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, stored.centroid);
    await this.storeOwnerEmbedding(stored);
    this.enrolled = true;
  }

  async enrollFromFile(audioUri: string, options: SpeakerEnrollmentOptions = {}): Promise<void> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerFileEmbedding(audioUri);
    const now = new Date().toISOString();
    const template = this.buildTemplate(embedding, {
      source: options.source ?? "onboarding",
      promptId: options.promptId,
      durationMs: options.durationMs,
      quality: buildQuality(null, options.durationMs, options.quality),
    });
    const stored = this.buildStoredEmbedding([template], now);
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, stored.centroid);
    await this.storeOwnerEmbedding(stored);
    this.enrolled = true;
  }

  async appendEnrollmentSample(
    audioSample: SpeakerEnrollmentSampleInput,
    options: Omit<SpeakerEnrollmentOptions, "source"> = {}
  ): Promise<AppendEnrollmentResult> {
    const stored = await this.readOwnerEmbedding();
    if (!stored) {
      throw new Error("Speaker enrollment must exist before appending a sample");
    }

    const [sample] = normalizeEnrollmentSamples([audioSample], {
      ...options,
      source: "settings-append",
    });
    if (!sample || !isFiniteNumberArray(sample.samples)) {
      throw new Error("Speaker append enrollment sample must be a non-empty finite number array");
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerEmbedding(sample.samples);
    return this.appendOwnerTemplate(
      stored,
      this.buildTemplate(embedding, {
        source: "settings-append",
        promptId: sample.promptId,
        durationMs: sample.durationMs,
        quality: buildQuality(sample.samples, sample.durationMs, sample.quality),
      })
    );
  }

  async appendEnrollmentFile(
    audioUri: string,
    options: Omit<SpeakerEnrollmentOptions, "source"> = {}
  ): Promise<AppendEnrollmentResult> {
    const stored = await this.readOwnerEmbedding();
    if (!stored) {
      throw new Error("Speaker enrollment must exist before appending a sample");
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerFileEmbedding(audioUri);
    return this.appendOwnerTemplate(
      stored,
      this.buildTemplate(embedding, {
        source: "settings-append",
        promptId: options.promptId,
        durationMs: options.durationMs,
        quality: buildQuality(null, options.durationMs, options.quality),
      })
    );
  }

  async clearEnrollment(): Promise<void> {
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    try {
      if (await sherpaVoiceAdapter.hasSpeaker(OWNER_SPEAKER_NAME)) {
        await sherpaVoiceAdapter.removeSpeaker(OWNER_SPEAKER_NAME);
      }
    } catch (error) {
      console.warn("[SpeakerId] Failed to clear native owner speaker:", error);
    }

    speakerStorage.remove(OWNER_EMBEDDING_MMKV_KEY);
    speakerStorage.remove(OWNER_SCORE_TRACE_MMKV_KEY);
    await this.clearLegacySecureStoreOwnerEmbedding();
    this.enrolled = false;
    console.log("[SpeakerId] Owner enrollment cleared");
  }

  async verifySamples(
    audioSamples: number[],
    source: SpeakerVerificationTraceSource = "live"
  ): Promise<boolean> {
    const stored = await this.ensureOwnerRegistered();
    if (!stored || audioSamples.length === 0) {
      return false;
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerEmbedding(audioSamples);
    return this.verifyOwnerEmbedding(stored, embedding, calculateSamplesDurationMs(audioSamples), source);
  }

  async verifyFile(
    audioUri: string,
    source: SpeakerVerificationTraceSource = "settings-check"
  ): Promise<boolean> {
    const stored = await this.ensureOwnerRegistered();
    if (!stored) {
      return false;
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    const embedding = await sherpaVoiceAdapter.computeSpeakerFileEmbedding(audioUri);
    return this.verifyOwnerEmbedding(stored, embedding, 0, source);
  }

  async verifyDiagnosticOwnerSamples(audioSamples: number[]): Promise<boolean> {
    return this.verifySamples(audioSamples, "diagnostic-owner");
  }

  async verifyDiagnosticOwnerFile(audioUri: string): Promise<boolean> {
    return this.verifyFile(audioUri, "diagnostic-owner");
  }


  async verify(): Promise<boolean> {
    return this.verifySamples([]);
  }

  get threshold(): number {
    return this.verificationThreshold;
  }

  private buildTemplate(
    embedding: number[],
    metadata: {
      source: SpeakerEnrollmentSource;
      promptId?: string;
      durationMs?: number;
      quality: SpeakerEnrollmentQuality;
    }
  ): StoredSpeakerTemplate {
    if (!isFiniteNumberArray(embedding)) {
      throw new Error("Speaker embedding must be a non-empty finite number array");
    }

    const createdAt = new Date().toISOString();
    return {
      id: createId("speaker-template"),
      embedding,
      createdAt,
      source: metadata.source,
      durationMs: metadata.quality.durationMs || metadata.durationMs || 0,
      quality: metadata.quality,
      promptId: metadata.promptId,
    };
  }

  private buildStoredEmbedding(templates: StoredSpeakerTemplate[], now: string): StoredSpeakerEmbedding {
    const centroid = computeCentroid(templates);
    if (centroid.length === 0) {
      throw new Error("Speaker enrollment requires at least one valid template");
    }

    return {
      version: 2,
      speakerName: OWNER_SPEAKER_NAME,
      templates,
      centroid,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async appendOwnerTemplate(
    stored: StoredSpeakerEmbedding,
    template: StoredSpeakerTemplate
  ): Promise<AppendEnrollmentResult> {
    const now = new Date().toISOString();
    let action: AppendEnrollmentResult["action"] = "appended";
    let replacedTemplateId: string | undefined;
    let reason = "appended template below limit";
    let templates = [...stored.templates, template];

    if (stored.templates.length >= MAX_OWNER_TEMPLATES) {
      const replacement = selectTemplateForReplacement(stored.templates);
      replacedTemplateId = stored.templates[replacement.index].id;
      templates = stored.templates.map((existing, index) =>
        index === replacement.index ? template : existing
      );
      action = "replaced";
      reason = replacement.reason;
    }

    const updated: StoredSpeakerEmbedding = {
      ...stored,
      templates,
      centroid: computeCentroid(templates),
      updatedAt: now,
    };
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, updated.centroid);
    await this.storeOwnerEmbedding(updated);
    this.enrolled = true;

    console.log(
      `[SpeakerId] Appended owner enrollment sample: action=${action}, template=${template.id}, reason=${reason}`
    );
    return {
      action,
      templateCount: templates.length,
      templateId: template.id,
      replacedTemplateId,
      reason,
    };
  }

  private async restoreOwnerEmbedding(): Promise<boolean> {
    const stored = await this.readOwnerEmbedding();
    if (!stored) {
      console.log("[SpeakerId] No stored owner embedding to restore");
      return false;
    }

    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, stored.centroid);
    console.log(
      `[SpeakerId] Restored owner embedding from MMKV: dims=${stored.centroid.length}, templates=${stored.templates.length}`
    );
    return true;
  }

  private async ensureOwnerRegistered(): Promise<StoredSpeakerEmbedding | null> {
    const stored = await this.readOwnerEmbedding();
    if (!stored) {
      this.enrolled = false;
      return null;
    }

    this.enrolled = true;
    const sherpaVoiceAdapter = await getSherpaVoiceAdapter();
    if (!(await sherpaVoiceAdapter.hasSpeaker(OWNER_SPEAKER_NAME))) {
      console.warn("[SpeakerId] Owner missing in native registry; restoring from MMKV");
      await sherpaVoiceAdapter.registerSpeaker(OWNER_SPEAKER_NAME, stored.centroid);
    }

    return stored;
  }

  private async verifyOwnerEmbedding(
    stored: StoredSpeakerEmbedding,
    embedding: number[],
    sampleDurationMs: number,
    source: SpeakerVerificationTraceSource
  ): Promise<boolean> {
    const result = evaluateEmbedding(stored, embedding, this.verificationThreshold);
    this.recordScoreTrace({
      id: createId("speaker-trace"),
      createdAt: new Date().toISOString(),
      verified: result.verified,
      threshold: this.verificationThreshold,
      score: result.score,
      centroidScore: result.centroidScore,
      bestTemplateScore: result.bestTemplateScore,
      bestTemplateId: result.bestTemplateId,
      sampleDurationMs,
      source,
    });
    recordDiagnosticEvent("speaker", "verification", {
      source,
      verified: result.verified,
      score: Number(result.score.toFixed(4)),
      threshold: this.verificationThreshold,
      centroidScore: Number(result.centroidScore.toFixed(4)),
      bestTemplateScore: Number(result.bestTemplateScore.toFixed(4)),
      durationMs: sampleDurationMs,
    });
    console.log(
      `[SpeakerId] Local verification: source=${source}, verified=${result.verified}, score=${result.score.toFixed(
        3
      )}, centroid=${result.centroidScore.toFixed(3)}, bestTemplate=${result.bestTemplateScore.toFixed(
        3
      )}`
    );
    return result.verified;
  }

  private async storeOwnerEmbedding(payload: StoredSpeakerEmbedding): Promise<void> {
    speakerStorage.set(OWNER_EMBEDDING_MMKV_KEY, JSON.stringify(payload));
    await this.clearLegacySecureStoreOwnerEmbedding();
  }

  private async readOwnerEmbedding(): Promise<StoredSpeakerEmbedding | null> {
    const storedFromMmkv = this.readOwnerEmbeddingFromMmkv();
    if (storedFromMmkv) {
      return storedFromMmkv;
    }

    const legacyStored = await this.readLegacySecureStoreOwnerEmbedding();
    if (!legacyStored) {
      return null;
    }

    speakerStorage.set(OWNER_EMBEDDING_MMKV_KEY, JSON.stringify(legacyStored));
    await this.clearLegacySecureStoreOwnerEmbedding();
    console.log("[SpeakerId] Migrated owner embedding from SecureStore to MMKV");
    return legacyStored;
  }

  private readOwnerEmbeddingFromMmkv(): StoredSpeakerEmbedding | null {
    const serialized = speakerStorage.getString(OWNER_EMBEDDING_MMKV_KEY);
    if (!serialized) {
      return null;
    }

    try {
      const parsed = JSON.parse(serialized) as StoredSpeakerPayload;
      const stored = this.normalizeStoredEmbedding(parsed);
      if (!stored) {
        speakerStorage.remove(OWNER_EMBEDDING_MMKV_KEY);
        return null;
      }
      if (parsed.version === 1) {
        speakerStorage.set(OWNER_EMBEDDING_MMKV_KEY, JSON.stringify(stored));
        console.log("[SpeakerId] Migrated owner embedding from MMKV v1 to v2");
      }
      return stored;
    } catch {
      speakerStorage.remove(OWNER_EMBEDDING_MMKV_KEY);
      return null;
    }
  }

  private async readLegacySecureStoreOwnerEmbedding(): Promise<StoredSpeakerEmbedding | null> {
    const metaValue = await SecureStore.getItemAsync(OWNER_EMBEDDING_META_KEY);
    if (!metaValue) {
      return null;
    }

    let meta: { version?: number; chunks?: number };
    try {
      meta = JSON.parse(metaValue);
    } catch {
      await this.clearLegacySecureStoreOwnerEmbedding();
      return null;
    }

    if (meta.version !== 1 || !meta.chunks || meta.chunks < 1) {
      await this.clearLegacySecureStoreOwnerEmbedding();
      return null;
    }

    const chunks: string[] = [];
    for (let index = 0; index < meta.chunks; index += 1) {
      const chunk = await SecureStore.getItemAsync(`${OWNER_EMBEDDING_CHUNK_KEY_PREFIX}${index}`);
      if (!chunk) {
        await this.clearLegacySecureStoreOwnerEmbedding();
        return null;
      }
      chunks.push(chunk);
    }

    try {
      const parsed = JSON.parse(chunks.join("")) as StoredSpeakerPayload;
      const stored = this.normalizeStoredEmbedding(parsed);
      if (!stored) {
        await this.clearLegacySecureStoreOwnerEmbedding(meta.chunks);
        return null;
      }
      return stored;
    } catch {
      await this.clearLegacySecureStoreOwnerEmbedding(meta.chunks);
      return null;
    }
  }

  private normalizeStoredEmbedding(payload: StoredSpeakerPayload): StoredSpeakerEmbedding | null {
    if (isStoredSpeakerEmbeddingV2(payload)) {
      const centroid = computeCentroid(payload.templates);
      if (centroid.length === 0) {
        return null;
      }
      return {
        ...payload,
        centroid,
      };
    }

    if (isStoredSpeakerEmbeddingV1(payload)) {
      return migrateV1ToV2(payload);
    }

    return null;
  }

  private readScoreTraces(): SpeakerVerificationTrace[] {
    const serialized = speakerStorage.getString(OWNER_SCORE_TRACE_MMKV_KEY);
    if (!serialized) {
      return [];
    }

    try {
      const traces = JSON.parse(serialized) as SpeakerVerificationTrace[];
      if (!Array.isArray(traces)) {
        speakerStorage.remove(OWNER_SCORE_TRACE_MMKV_KEY);
        return [];
      }
      return traces
        .filter((trace) => typeof trace?.id === "string" && typeof trace.score === "number")
        .slice(-MAX_SCORE_TRACES);
    } catch {
      speakerStorage.remove(OWNER_SCORE_TRACE_MMKV_KEY);
      return [];
    }
  }

  private recordScoreTrace(trace: SpeakerVerificationTrace): void {
    const traces = [...this.readScoreTraces(), trace].slice(-MAX_SCORE_TRACES);
    speakerStorage.set(OWNER_SCORE_TRACE_MMKV_KEY, JSON.stringify(traces));
  }

  private async clearLegacySecureStoreOwnerEmbedding(chunkCount?: number): Promise<void> {
    const metaValue = await SecureStore.getItemAsync(OWNER_EMBEDDING_META_KEY);
    let chunks = chunkCount || 0;
    if (!chunks && metaValue) {
      try {
        const meta = JSON.parse(metaValue) as { chunks?: number };
        chunks = meta.chunks || 0;
      } catch {
        chunks = 0;
      }
    }

    await SecureStore.deleteItemAsync(OWNER_EMBEDDING_META_KEY);
    for (let index = 0; index < chunks; index += 1) {
      await SecureStore.deleteItemAsync(`${OWNER_EMBEDDING_CHUNK_KEY_PREFIX}${index}`);
    }
  }
}

export const speakerIdService = new SpeakerIdService();
