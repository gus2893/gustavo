import { types as utilTypes } from "node:util";
import { canonicalContentDigest } from "../events/integrity";
import {
  MEMORY_CONFLICT_STATES,
  MEMORY_CORRECTION_STATES,
  MEMORY_SCOPES,
  type ConsolidatedMemory,
  type ConsolidateEventsInput,
  type ConsolidationResult,
  type ExtractedMemoryBase,
  type MemoryConflictState,
  type MemoryCorrectionState,
  type MemoryGoalStatus,
  type MemoryType,
} from "../memory/types";

const MAX_EVENTS = 500;
const MAX_CANDIDATES_PER_TYPE = 100;
const MAX_TEXT_LENGTH = 8_000;
const MAX_TAGS = 100;
const MAX_EMBEDDING_DIMENSION = 8_192;
const MAX_POSTGRES_REAL_MAGNITUDE = 3.4e38;
const DEFAULT_IDLE_BOUNDARY_MINUTES = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface CaptureBudget {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function captureValue(value: unknown, depth: number, budget: CaptureBudget): unknown {
  if (value === null || value === undefined || typeof value === "string"
      || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value !== "object") throw new Error("INVALID_MEMORY_INPUT_VALUE");
  if (utilTypes.isProxy(value)) throw new Error("MEMORY_INPUT_PROXY_FORBIDDEN");
  if (depth > 12 || budget.nodes++ > 10_000) throw new Error("MEMORY_INPUT_TOO_COMPLEX");
  if (budget.seen.has(value)) throw new Error("MEMORY_INPUT_CYCLE_FORBIDDEN");
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 10_000) throw new Error("MEMORY_INPUT_TOO_COMPLEX");
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("MEMORY_INPUT_ACCESSOR_FORBIDDEN");
        }
        clone.push(captureValue(descriptor.value, depth + 1, budget));
      }
      const extraKeys = Reflect.ownKeys(value).filter((key) => (
        key !== "length" && !(typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key))
      ));
      if (extraKeys.length > 0) throw new Error("INVALID_MEMORY_INPUT_PROPERTY");
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("INVALID_MEMORY_INPUT_OBJECT");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 500 || keys.some((key) => typeof key !== "string")) {
      throw new Error("MEMORY_INPUT_TOO_COMPLEX");
    }
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("MEMORY_INPUT_ACCESSOR_FORBIDDEN");
      }
      clone[key] = captureValue(descriptor.value, depth + 1, budget);
    }
    return Object.freeze(clone);
  } finally {
    budget.seen.delete(value);
  }
}

export function captureMemoryInput<Input>(input: Input): Input {
  return captureValue(input, 0, { nodes: 0, seen: new WeakSet<object>() }) as Input;
}

function requiredText(value: unknown, code: string, maximum = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(code);
  }
  return value;
}

function exactTime(value: unknown, code: string): string {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new Error(code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(code);
  }
  const canonical = parsed.toISOString();
  const expected = value.includes(".") ? value : `${value.slice(0, -1)}.000Z`;
  if (canonical !== expected) {
    throw new Error(code);
  }
  return canonical;
}

function boundedScore(value: unknown, fallback: number, code: string): number {
  const score = value === undefined ? fallback : value;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(code);
  }
  return score;
}

function uuidFromDigest(digest: string): string {
  const hexadecimal = digest.slice(0, 32).split("");
  hexadecimal[12] = "5";
  hexadecimal[16] = ((Number.parseInt(hexadecimal[16], 16) & 0x3) | 0x8).toString(16);
  const value = hexadecimal.join("");
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)]
    .join("-");
}

function checkedArray<T>(value: readonly T[] | undefined, code: string): readonly T[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES_PER_TYPE) {
    throw new Error(code);
  }
  return value;
}

function normalizedTags(value: readonly string[] | undefined, code: string): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new Error(code);
  }
  const normalized = value.map((tag) => requiredText(tag, code, 120).trim().toLowerCase());
  return Object.freeze([...new Set(normalized)].sort());
}

function embeddingDigest(value: readonly number[] | undefined, contentDigest: string, version: string) {
  if (value !== undefined && (!Array.isArray(value) || value.length === 0
      || value.length > MAX_EMBEDDING_DIMENSION)) {
    throw new Error("INVALID_MEMORY_EMBEDDING");
  }
  const vector = value ?? [];
  if (vector.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
    throw new Error("INVALID_MEMORY_EMBEDDING");
  }
  if (vector.some((component) => Math.abs(component) > MAX_POSTGRES_REAL_MAGNITUDE)) {
    throw new Error("INVALID_MEMORY_EMBEDDING");
  }
  if (value !== undefined && vector.every((component) => component === 0)) {
    throw new Error("INVALID_MEMORY_EMBEDDING");
  }
  return Object.freeze({
    digest: value === undefined ? null : canonicalContentDigest({ contentDigest, vector, version }),
    dimension: vector.length,
    vector: value === undefined ? null : Object.freeze([...vector]),
  });
}

function freshness(sourceTo: string, observedAt: string): number {
  const age = Math.max(0, new Date(observedAt).getTime() - new Date(sourceTo).getTime());
  return Number(Math.exp(-age / (30 * 24 * 60 * 60 * 1_000)).toFixed(6));
}

function assertScopeAuthority(input: ConsolidateEventsInput): void {
  if (!MEMORY_SCOPES.includes(input.scope)) {
    throw new Error("INVALID_MEMORY_SCOPE");
  }
  const privateScope = input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH";
  if (privateScope) {
    requiredText(input.accountId, "MEMORY_ACCOUNT_REQUIRED");
    requiredText(input.nodeBrainId, "MEMORY_NODE_REQUIRED");
    requiredText(input.conversationId, "MEMORY_CONVERSATION_REQUIRED");
    return;
  }
  if (input.accountId !== undefined || input.nodeBrainId !== undefined || input.conversationId !== undefined) {
    throw new Error("MEMORY_SHARED_AUTHORITY_MISMATCH");
  }
}

function assertEpisodeCoherent(
  sourceIds: readonly string[],
  eventTimes: ReadonlyMap<string, string>,
  idleBoundaryMs: number,
): void {
  const sorted = sourceIds.map((id) => eventTimes.get(id)!).sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (new Date(sorted[index]).getTime() - new Date(sorted[index - 1]).getTime() > idleBoundaryMs) {
      throw new Error("EPISODE_SPANS_IDLE_BOUNDARY");
    }
  }
}

interface CandidateOptions {
  readonly type: MemoryType;
  readonly goalStatus?: MemoryGoalStatus;
  readonly procedureVersion?: string;
}

interface PreparedCandidate {
  readonly item: ExtractedMemoryBase;
  readonly options: CandidateOptions;
}

function duplicateMetadata(candidate: PreparedCandidate): unknown {
  return {
    conflictState: candidate.item.conflictState ?? "CURRENT",
    correctionState: candidate.item.correctionState ?? "NONE",
    goalStatus: candidate.options.goalStatus ?? null,
    procedureVersion: candidate.options.procedureVersion ?? null,
    supersedesMemoryId: candidate.item.supersedesMemoryId ?? null,
    validFrom: candidate.item.validFrom ?? null,
    validTo: candidate.item.validTo ?? null,
  };
}

function sameVector(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function mergePreparedCandidates(
  candidates: readonly PreparedCandidate[],
  eventTimes: ReadonlyMap<string, string>,
): readonly PreparedCandidate[] {
  const grouped = new Map<string, PreparedCandidate>();
  for (const current of candidates) {
    const text = requiredText(current.item.text, "INVALID_MEMORY_TEXT", MAX_TEXT_LENGTH).trim();
    const key = `${current.options.type}:${canonicalContentDigest({ text })}`;
    const prior = grouped.get(key);
    if (!prior) {
      grouped.set(key, Object.freeze({
        item: Object.freeze({ ...current.item, text }),
        options: current.options,
      }));
      continue;
    }
    if (canonicalContentDigest(duplicateMetadata(prior))
        !== canonicalContentDigest(duplicateMetadata(current))) {
      throw new Error("MEMORY_DUPLICATE_METADATA_CONFLICT");
    }
    const leftEmbedding = prior.item.embedding;
    const rightEmbedding = current.item.embedding;
    if (leftEmbedding !== undefined && rightEmbedding !== undefined
        && !sameVector(leftEmbedding, rightEmbedding)) {
      throw new Error("MEMORY_DUPLICATE_METADATA_CONFLICT");
    }
    const sourceIds = [...new Set([...prior.item.sourceIds, ...current.item.sourceIds])]
      .sort((left, right) => {
        const leftAt = eventTimes.get(left);
        const rightAt = eventTimes.get(right);
        if (!leftAt || !rightAt) throw new Error("MEMORY_SOURCE_NOT_IN_BATCH");
        return leftAt.localeCompare(rightAt) || left.localeCompare(right);
      });
    const keywords = [...new Set([
      ...normalizedTags(prior.item.keywords, "INVALID_MEMORY_KEYWORDS"),
      ...normalizedTags(current.item.keywords, "INVALID_MEMORY_KEYWORDS"),
    ])].sort();
    const entities = [...new Set([
      ...normalizedTags(prior.item.entities, "INVALID_MEMORY_ENTITIES"),
      ...normalizedTags(current.item.entities, "INVALID_MEMORY_ENTITIES"),
    ])].sort();
    if (keywords.length > MAX_TAGS) throw new Error("INVALID_MEMORY_KEYWORD_UNION");
    if (entities.length > MAX_TAGS) throw new Error("INVALID_MEMORY_ENTITY_UNION");
    grouped.set(key, Object.freeze({
      options: prior.options,
      item: Object.freeze({
        ...prior.item,
        text,
        sourceIds: Object.freeze(sourceIds),
        confidence: Math.max(
          boundedScore(prior.item.confidence, 1, "INVALID_MEMORY_CONFIDENCE"),
          boundedScore(current.item.confidence, 1, "INVALID_MEMORY_CONFIDENCE"),
        ),
        importance: Math.max(
          boundedScore(prior.item.importance, 0.5, "INVALID_MEMORY_IMPORTANCE"),
          boundedScore(current.item.importance, 0.5, "INVALID_MEMORY_IMPORTANCE"),
        ),
        keywords: Object.freeze(keywords),
        entities: Object.freeze(entities),
        embedding: leftEmbedding ?? rightEmbedding,
      }),
    }));
  }
  const typeOrder: Readonly<Record<MemoryType, number>> = {
    SEMANTIC: 0, PROCEDURAL: 1, GOAL: 2, EPISODIC: 3,
  };
  return Object.freeze([...grouped.values()].sort((left, right) => (
    typeOrder[left.options.type] - typeOrder[right.options.type]
    || left.item.text.localeCompare(right.item.text)
  )));
}

function candidate(
  input: ConsolidateEventsInput,
  item: ExtractedMemoryBase,
  options: CandidateOptions,
  ordinal: number,
  eventTimes: ReadonlyMap<string, string>,
  observedAt: string,
  idleBoundaryMs: number,
): ConsolidatedMemory {
  const text = requiredText(item.text, "INVALID_MEMORY_TEXT", MAX_TEXT_LENGTH).trim();
  if (!Array.isArray(item.sourceIds) || item.sourceIds.length === 0 || item.sourceIds.length > MAX_EVENTS) {
    throw new Error("MEMORY_SOURCE_REQUIRED");
  }
  const sourceIds = Object.freeze([...new Set(item.sourceIds.map((id) => requiredText(id, "INVALID_MEMORY_SOURCE_ID")))]);
  if (sourceIds.length !== item.sourceIds.length) {
    throw new Error("DUPLICATE_MEMORY_SOURCE_ID");
  }
  const sourceTimes = sourceIds.map((id) => {
    const at = eventTimes.get(id);
    if (!at) {
      throw new Error("MEMORY_SOURCE_NOT_IN_BATCH");
    }
    return at;
  }).sort();
  if (options.type === "EPISODIC") {
    assertEpisodeCoherent(sourceIds, eventTimes, idleBoundaryMs);
  }
  const sourceFrom = sourceTimes[0];
  const sourceTo = sourceTimes[sourceTimes.length - 1];
  const validFrom = item.validFrom === undefined ? sourceFrom : exactTime(item.validFrom, "INVALID_MEMORY_VALID_FROM");
  const validTo = item.validTo === undefined ? null : exactTime(item.validTo, "INVALID_MEMORY_VALID_TO");
  if (validTo !== null && validTo <= validFrom) {
    throw new Error("INVALID_MEMORY_VALIDITY");
  }
  const conflictState: MemoryConflictState = item.conflictState ?? "CURRENT";
  if (!MEMORY_CONFLICT_STATES.includes(conflictState)) {
    throw new Error("INVALID_MEMORY_CONFLICT_STATE");
  }
  const correctionState: MemoryCorrectionState = item.correctionState ?? "NONE";
  if (!MEMORY_CORRECTION_STATES.includes(correctionState)) {
    throw new Error("INVALID_MEMORY_CORRECTION_STATE");
  }
  const supersedesMemoryId = item.supersedesMemoryId === undefined
    ? null : requiredText(item.supersedesMemoryId, "INVALID_MEMORY_SUPERSESSION");
  if (supersedesMemoryId !== null && !UUID_PATTERN.test(supersedesMemoryId)) {
    throw new Error("INVALID_MEMORY_SUPERSESSION");
  }
  if ((conflictState === "SUPERSEDED") !== (validTo !== null)) {
    throw new Error("INVALID_MEMORY_SUPERSESSION_STATE");
  }
  const keywords = normalizedTags(item.keywords, "INVALID_MEMORY_KEYWORDS");
  const entities = normalizedTags(item.entities, "INVALID_MEMORY_ENTITIES");
  const contentDigest = canonicalContentDigest({ text });
  const equivalenceDigest = canonicalContentDigest({
    goalStatus: options.goalStatus ?? null,
    procedureVersion: options.procedureVersion ?? null,
    text, type: options.type,
  });
  const embedding = embeddingDigest(item.embedding, contentDigest, input.versions.embeddingVersion);
  const identityDigest = canonicalContentDigest({
    accountId: input.accountId ?? null,
    conflictState,
    contentDigest,
    equivalenceDigest,
    conversationId: input.conversationId ?? null,
    correctionState,
    embeddingVersion: input.versions.embeddingVersion,
    extractorVersion: input.versions.extractorVersion,
    modelVersion: input.versions.modelVersion,
    nodeBrainId: input.nodeBrainId ?? null,
    promptVersion: input.versions.promptVersion,
    scope: input.scope,
    sourceIds,
    type: options.type,
    validFrom,
  });
  return Object.freeze({
    id: uuidFromDigest(identityDigest),
    ordinal,
    type: options.type,
    scope: input.scope,
    accountId: input.accountId ?? null,
    nodeBrainId: input.nodeBrainId ?? null,
    conversationId: input.conversationId ?? null,
    text,
    contentDigest,
    equivalenceDigest,
    keywords,
    entities,
    embedding: embedding.vector,
    keywordIndexDigests: Object.freeze(keywords.map((term) => canonicalContentDigest({
      kind: "KEYWORD", term,
    }))),
    entityIndexDigests: Object.freeze(entities.map((term) => canonicalContentDigest({
      kind: "ENTITY", term,
    }))),
    keywordsDigest: canonicalContentDigest({ keywords }),
    entitiesDigest: canonicalContentDigest({ entities }),
    embeddingDigest: embedding.digest,
    embeddingDimension: embedding.dimension,
    sourceIds,
    sourceFrom,
    sourceTo,
    confidence: boundedScore(item.confidence, 1, "INVALID_MEMORY_CONFIDENCE"),
    importance: boundedScore(item.importance, 0.5, "INVALID_MEMORY_IMPORTANCE"),
    freshness: freshness(sourceTo, observedAt),
    retrievalUseCount: 0,
    promptVersion: requiredText(input.versions.promptVersion, "INVALID_MEMORY_PROMPT_VERSION"),
    modelVersion: requiredText(input.versions.modelVersion, "INVALID_MEMORY_MODEL_VERSION"),
    extractorVersion: requiredText(input.versions.extractorVersion, "INVALID_MEMORY_EXTRACTOR_VERSION"),
    embeddingVersion: requiredText(input.versions.embeddingVersion, "INVALID_MEMORY_EMBEDDING_VERSION"),
    validFrom,
    validTo,
    supersedesMemoryId,
    conflictState,
    correctionState,
    goalStatus: options.goalStatus ?? null,
    procedureVersion: options.procedureVersion ?? null,
  });
}

function consolidateCaptured(input: ConsolidateEventsInput): ConsolidationResult {
  assertScopeAuthority(input);
  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > MAX_EVENTS) {
    throw new Error("INVALID_MEMORY_EVENT_BATCH");
  }
  if (!input.extracted || typeof input.extracted !== "object") {
    throw new Error("INVALID_MEMORY_EXTRACTION");
  }
  const observedAt = exactTime(input.observedAt, "INVALID_MEMORY_OBSERVED_AT");
  const idleBoundaryMinutes = input.idleBoundaryMinutes ?? DEFAULT_IDLE_BOUNDARY_MINUTES;
  if (!Number.isFinite(idleBoundaryMinutes) || idleBoundaryMinutes <= 0 || idleBoundaryMinutes > 24 * 60) {
    throw new Error("INVALID_MEMORY_IDLE_BOUNDARY");
  }
  const eventTimes = new Map<string, string>();
  for (const event of input.events) {
    const id = requiredText(event.id, "INVALID_MEMORY_EVENT_ID");
    if (eventTimes.has(id)) {
      throw new Error("DUPLICATE_MEMORY_EVENT_ID");
    }
    requiredText(event.text, "INVALID_MEMORY_EVENT_TEXT", 100_000);
    eventTimes.set(id, exactTime(event.at, "INVALID_MEMORY_EVENT_AT"));
  }
  const eventRange = [...eventTimes.values()].sort();
  if (eventRange[eventRange.length - 1] > observedAt) {
    throw new Error("MEMORY_OBSERVED_BEFORE_SOURCE");
  }

  const facts = checkedArray(input.extracted.facts, "INVALID_MEMORY_FACTS");
  const procedures = checkedArray(input.extracted.procedures, "INVALID_MEMORY_PROCEDURES");
  const goals = checkedArray(input.extracted.goals, "INVALID_MEMORY_GOALS");
  const episodes = checkedArray(
    input.extracted.episodes ?? (input.extracted.episode ? [input.extracted.episode] : undefined),
    "INVALID_MEMORY_EPISODES",
  );
  const prepared: PreparedCandidate[] = [];
  const add = (item: ExtractedMemoryBase, options: CandidateOptions) => {
    prepared.push(Object.freeze({ item, options: Object.freeze(options) }));
  };
  facts.forEach((item) => add(item, { type: "SEMANTIC" }));
  procedures.forEach((item) => add(item, {
    type: "PROCEDURAL",
    procedureVersion: requiredText(item.procedureVersion ?? input.versions.extractorVersion,
      "INVALID_MEMORY_PROCEDURE_VERSION"),
  }));
  goals.forEach((item) => {
    if (!["OPEN", "BLOCKED", "COMPLETED", "CANCELLED"].includes(item.status)) {
      throw new Error("INVALID_MEMORY_GOAL_STATUS");
    }
    add(item, { type: "GOAL", goalStatus: item.status });
  });
  episodes.forEach((item) => add(item, { type: "EPISODIC" }));
  if (prepared.length === 0) {
    throw new Error("MEMORY_EXTRACTION_EMPTY");
  }
  const merged = mergePreparedCandidates(prepared, eventTimes);
  const memories = merged.map(({ item, options }, ordinal) => candidate(
    input, item, options, ordinal, eventTimes, observedAt,
    idleBoundaryMinutes * 60 * 1_000,
  ));
  const memoryIds = new Set<string>();
  for (const memory of memories) {
    if (memoryIds.has(memory.id)) {
      throw new Error("DUPLICATE_MEMORY_PROJECTION");
    }
    memoryIds.add(memory.id);
  }
  return Object.freeze({
    memories: Object.freeze(memories),
    deletedSourceEventIds: Object.freeze([]),
    sourceFrom: eventRange[0],
    sourceTo: eventRange[eventRange.length - 1],
  });
}

export function consolidateEvents(input: ConsolidateEventsInput): ConsolidationResult {
  return consolidateCaptured(captureMemoryInput(input));
}
