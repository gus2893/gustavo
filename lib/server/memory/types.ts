import type { EventDatabase } from "../events/types";

export const MEMORY_TYPES = Object.freeze([
  "SEMANTIC", "EPISODIC", "PROCEDURAL", "GOAL",
] as const);

export const MEMORY_SCOPES = Object.freeze([
  "PRIVATE_ACCOUNT", "NODE_BRANCH", "MAIN_SHARED", "CHALLENGE_SHARED", "PUBLIC", "AUDIT_ONLY",
] as const);

export const MEMORY_CONFLICT_STATES = Object.freeze([
  "CURRENT", "CONFLICTED", "CORRECTED", "SUPERSEDED",
] as const);

export const MEMORY_CORRECTION_STATES = Object.freeze([
  "NONE", "USER_CORRECTED", "OPERATOR_CORRECTED",
] as const);

export type MemoryType = typeof MEMORY_TYPES[number];
export type MemoryScope = typeof MEMORY_SCOPES[number];
export type MemoryConflictState = typeof MEMORY_CONFLICT_STATES[number];
export type MemoryCorrectionState = typeof MEMORY_CORRECTION_STATES[number];
export type MemoryGoalStatus = "OPEN" | "BLOCKED" | "COMPLETED" | "CANCELLED";

export interface MemorySourceEventInput {
  readonly id: string;
  readonly at: string;
  /** Provider output may inspect source text, but persistence must encrypt it. */
  readonly text: string;
}

export interface ExtractedMemoryBase {
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly confidence?: number;
  readonly importance?: number;
  readonly keywords?: readonly string[];
  readonly entities?: readonly string[];
  readonly embedding?: readonly number[];
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersedesMemoryId?: string;
  readonly conflictState?: MemoryConflictState;
  readonly correctionState?: MemoryCorrectionState;
}

export interface ExtractedFact extends ExtractedMemoryBase {}
export interface ExtractedProcedure extends ExtractedMemoryBase {
  readonly procedureVersion?: string;
}
export interface ExtractedGoal extends ExtractedMemoryBase {
  readonly status: MemoryGoalStatus;
}
export interface ExtractedEpisode extends ExtractedMemoryBase {}

export interface ExtractedMemorySet {
  readonly facts?: readonly ExtractedFact[];
  readonly procedures?: readonly ExtractedProcedure[];
  readonly goals?: readonly ExtractedGoal[];
  readonly episodes?: readonly ExtractedEpisode[];
  /** Compatibility with the approved plan's singular episode sketch. */
  readonly episode?: ExtractedEpisode;
}

export interface MemoryExtractionVersions {
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly extractorVersion: string;
  readonly embeddingVersion: string;
}

export interface ConsolidateEventsInput {
  readonly scope: MemoryScope;
  readonly accountId?: string;
  readonly nodeBrainId?: string;
  readonly conversationId?: string;
  readonly events: readonly MemorySourceEventInput[];
  readonly extracted: ExtractedMemorySet;
  readonly versions: MemoryExtractionVersions;
  readonly observedAt: string;
  readonly idleBoundaryMinutes?: number;
}

export interface ConsolidatedMemory {
  readonly id: string;
  readonly ordinal: number;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly accountId: string | null;
  readonly nodeBrainId: string | null;
  readonly conversationId: string | null;
  readonly text: string;
  readonly contentDigest: string;
  readonly equivalenceDigest: string;
  readonly keywords: readonly string[];
  readonly entities: readonly string[];
  readonly embedding: readonly number[] | null;
  readonly keywordIndexDigests: readonly string[];
  readonly entityIndexDigests: readonly string[];
  readonly keywordsDigest: string;
  readonly entitiesDigest: string;
  readonly embeddingDigest: string | null;
  readonly embeddingDimension: number;
  readonly sourceIds: readonly string[];
  readonly sourceFrom: string;
  readonly sourceTo: string;
  readonly confidence: number;
  readonly importance: number;
  readonly freshness: number;
  readonly retrievalUseCount: 0;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly extractorVersion: string;
  readonly embeddingVersion: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly supersedesMemoryId: string | null;
  readonly conflictState: MemoryConflictState;
  readonly correctionState: MemoryCorrectionState;
  readonly goalStatus: MemoryGoalStatus | null;
  readonly procedureVersion: string | null;
}

export interface ConsolidationResult {
  readonly memories: readonly ConsolidatedMemory[];
  readonly deletedSourceEventIds: readonly never[];
  readonly sourceFrom: string;
  readonly sourceTo: string;
}

export interface ProcessMemoryEventInput extends ConsolidateEventsInput {
  readonly sourceEventId: string;
  readonly idempotencyKey: string;
}

export interface ProcessMemoryEventContext {
  readonly db: EventDatabase;
}

export interface MemorySearchTermInput {
  readonly scope: MemoryScope;
  readonly accountId?: string;
  readonly nodeBrainId?: string;
  readonly conversationId?: string;
  readonly aggregateId?: string;
  readonly kind: "KEYWORD" | "ENTITY";
  readonly term: string;
}

export interface MemoryVectorRankingInput {
  readonly scope: Exclude<MemoryScope, "PUBLIC">;
  readonly accountId?: string;
  readonly nodeBrainId?: string;
  readonly conversationId?: string;
  readonly candidateIds: readonly string[];
  readonly embeddingVersion: string;
  readonly queryVector: readonly number[];
  readonly limit?: number;
}

export interface RankedMemoryEmbedding {
  readonly memoryId: string;
  readonly similarity: number;
}

export interface ProcessedMemoryEvent extends ConsolidationResult {
  readonly consolidationEventId: string;
  readonly extractionRunId: string;
  readonly highWaterEventId: string;
}
