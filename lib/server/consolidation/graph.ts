import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalContentDigest } from "../events/integrity";
import {
  appendEvent,
  lockAvailableMemorySourceBodies,
  readEventBodies,
  readEventBody,
} from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { MEMORY_SCOPES, type MemoryScope } from "../memory/types";
import {
  authorizeRecall,
  type RecallActorInput,
  type RecallAuthorizationContext,
} from "../recall/planner";
import { reconcileMemories } from "./conflicts";
import {
  createMemoryWorkerContext,
  deriveMemorySearchTermDigests,
} from "../../../worker/consolidation/process-event";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_ENTITIES = 50;
const MAX_ALIASES_PER_ENTITY = 20;
const MAX_CLAIMS = 100;
const MAX_SOURCES = 500;
const MAX_GRAPH_DEPTH = 2;
const MAX_GRAPH_CANDIDATES = 100;
const MAX_GRAPH_SEEDS = 20;
const MAX_RECONCILIATION_GROUP = 101;
const MAX_GRAPH_CONFLICTS = MAX_RECONCILIATION_GROUP * (MAX_RECONCILIATION_GROUP - 1) / 2;
const MAX_REQUIRED_GENERATED_EDGES = MAX_GRAPH_CONFLICTS + MAX_RECONCILIATION_GROUP - 1;
const MAX_TYPED_RELATIONSHIPS = 200 * 199 * 11;
const MAX_DERIVED_EDGES_AT_FULL_INCREMENT = 200 * 199 * 9;
// One prior head for each of 100 requested groups maximizes candidate-pair relations;
// each group can additionally require one CONTRADICTS and one SUPERSEDES edge.
const MAX_GRAPH_EDGES = MAX_DERIVED_EDGES_AT_FULL_INCREMENT + 2 * MAX_CLAIMS;
const MAX_SYNCHRONOUS_EDGES = MAX_REQUIRED_GENERATED_EDGES;
const MAX_SYNCHRONOUS_EDGE_SOURCES = MAX_REQUIRED_GENERATED_EDGES * 2;
const MAX_SYNCHRONOUS_MATERIALIZATION_ROWS = 100_000;
const MAX_NORMALIZED_JOB_SOURCES = 200 * MAX_SOURCES;
const MAX_NORMALIZED_JOB_SOURCE_SETS = MAX_ENTITIES * MAX_ALIASES_PER_ENTITY + 200;

const EDGE_TYPES = Object.freeze([
  "MENTIONS", "SUPPORTS", "CONTRADICTS", "SUPERSEDES", "DERIVED_FROM", "PROPOSED_BY",
  "ACCEPTED_INTO", "AFFECTED", "RESULTED_IN", "SIMILAR_TO", "PART_OF",
] as const);

const RELATION_POLICY = Object.freeze({
  MENTIONS: "SOURCE_ENTITY",
  SUPPORTS: "MATCHING_APPROVED_CLAIM",
  CONTRADICTS: "AUTO_CONFLICT",
  SUPERSEDES: "AUTO_CURRENT",
  DERIVED_FROM: "MEMORY_DERIVATION",
  PROPOSED_BY: "PROPOSAL_CREATED_ANY_STATUS",
  ACCEPTED_INTO: "PROPOSAL_ACCEPTED",
  AFFECTED: "PROPOSAL_AFFECTED_STATE",
  RESULTED_IN: "EVENT_CAUSATION",
  SIMILAR_TO: "MEMORY_EQUIVALENCE",
  PART_OF: "EXTRACTION_EPISODE",
} as const);

export function memoryGraphCapacityContract() {
  return Object.freeze({
    maximumRequestedClaims: MAX_CLAIMS,
    maximumEntities: MAX_ENTITIES,
    maximumIncrementalCandidates: 200,
    maximumReconciliationGroup: MAX_RECONCILIATION_GROUP,
    maximumConflicts: MAX_GRAPH_CONFLICTS,
    maximumRequiredGeneratedEdges: MAX_REQUIRED_GENERATED_EDGES,
    maximumTypedRelationships: MAX_TYPED_RELATIONSHIPS,
    maximumDerivedEdgesAtFullIncrement: MAX_DERIVED_EDGES_AT_FULL_INCREMENT,
    maximumDurableEdges: MAX_GRAPH_EDGES,
    maximumSynchronousEdges: MAX_SYNCHRONOUS_EDGES,
    maximumSynchronousEdgeSources: MAX_SYNCHRONOUS_EDGE_SOURCES,
    maximumSynchronousMaterializationRows: MAX_SYNCHRONOUS_MATERIALIZATION_ROWS,
    maximumNormalizedJobSources: MAX_NORMALIZED_JOB_SOURCES,
    maximumNormalizedJobSourceSets: MAX_NORMALIZED_JOB_SOURCE_SETS,
    oversizedWork: "ENCRYPTED_RESUMABLE_JOB" as const,
  });
}

const ENTITY_TYPES = Object.freeze([
  "PERSON", "ACCOUNT", "NODE_BRAIN", "MAIN_BRAIN", "INSTRUMENT", "MARKET_ZONE",
  "METHOD", "HYPOTHESIS", "EVIDENCE", "DECISION", "GOAL", "CHALLENGE", "TRADE",
  "EPISODE", "SOURCE_DOCUMENT",
] as const);

const NODE_TYPES = Object.freeze([
  "BELIEF", "FACT", "PROCEDURE", "GOAL", "EPISODE", "HYPOTHESIS", "EVIDENCE",
  "DECISION", "TRADE", "SOURCE_DOCUMENT",
] as const);

type MemoryGraphEntityType = typeof ENTITY_TYPES[number];
type MemoryGraphNodeType = typeof NODE_TYPES[number];
type MemoryGraphEdgeType = typeof EDGE_TYPES[number];

interface MemoryGraphAliasInput {
  readonly alias: string;
  readonly digest?: string;
  readonly publicAlias: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceIds: readonly string[];
}

interface MemoryGraphEntityInput {
  readonly id: string;
  readonly type: MemoryGraphEntityType;
  readonly canonicalName: string;
  readonly canonicalDigest?: string;
  readonly publicLabel: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly aliases: readonly MemoryGraphAliasInput[];
}

interface MemoryGraphClaimInput {
  readonly memoryId: string;
  readonly entityId: string;
  readonly nodeType: MemoryGraphNodeType;
  readonly predicate: string;
  readonly value: string;
  readonly predicateDigest?: string;
  readonly valueDigest?: string;
  readonly publicPredicate: string | null;
  readonly publicValue: string | null;
  readonly approved: boolean;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceIds: readonly string[];
}

interface MemoryGraphRelationshipInput {
  readonly from: string;
  readonly type: Exclude<MemoryGraphEdgeType, "CONTRADICTS" | "SUPERSEDES">;
  readonly to: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceIds: readonly string[];
}

interface CapturedMemoryGraphInput {
  readonly scope: MemoryScope;
  readonly accountId: string | null;
  readonly nodeBrainId: string | null;
  readonly conversationId: string | null;
  readonly idempotencyKey: string;
  readonly reconcilerVersion: string;
  readonly observedAt: string;
  readonly entities: readonly MemoryGraphEntityInput[];
  readonly claims: readonly MemoryGraphClaimInput[];
  readonly relationships: readonly MemoryGraphRelationshipInput[];
}

interface ResolvedMemoryGraphAlias extends MemoryGraphAliasInput {
  readonly digest: string;
}

interface ResolvedMemoryGraphEntity extends MemoryGraphEntityInput {
  readonly canonicalDigest: string;
  readonly aliases: readonly ResolvedMemoryGraphAlias[];
}

interface ResolvedMemoryGraphClaim extends MemoryGraphClaimInput {
  readonly predicateDigest: string;
  readonly valueDigest: string;
}

interface ResolvedMemoryGraphInput extends Omit<CapturedMemoryGraphInput, "entities" | "claims"> {
  readonly entities: readonly ResolvedMemoryGraphEntity[];
  readonly claims: readonly ResolvedMemoryGraphClaim[];
  readonly consolidationBodyEventIds: readonly string[];
}

export interface MemoryGraphWriterContext {
  readonly db: EventDatabase;
}

export interface VersionedMemoryGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly type: MemoryGraphEdgeType;
  readonly to: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface StoredMemoryConflict {
  readonly id: string;
  readonly newer: string;
  readonly older: string;
  readonly preferred: string;
  readonly sourceIds: readonly string[];
}

export interface CompletedMemoryGraphResult {
  readonly status: "COMPLETED";
  readonly reconciliationRunId: string;
  readonly backgroundJobId: null;
  readonly currentMemoryIds: readonly string[];
  readonly edges: readonly VersionedMemoryGraphEdge[];
  readonly conflicts: readonly StoredMemoryConflict[];
}

export interface QueuedMemoryGraphResult {
  readonly status: "QUEUED";
  readonly reconciliationRunId: null;
  readonly backgroundJobId: string;
  readonly currentMemoryIds: readonly string[];
  readonly edges: readonly VersionedMemoryGraphEdge[];
  readonly conflicts: readonly StoredMemoryConflict[];
}

export type VersionMemoryGraphResult = CompletedMemoryGraphResult | QueuedMemoryGraphResult;

export interface MemoryGraphTraversalContext {
  readonly db: EventDatabase;
  readonly authorization: RecallAuthorizationContext;
}

interface CapturedTraversalInput {
  readonly seedMemoryIds: readonly string[];
  readonly requestedDepth: number;
  readonly candidateLimit: number;
  readonly asOf: string;
  readonly idempotencyKey: string;
}

export interface MemoryGraphTraversalResult {
  readonly memoryIds: readonly string[];
  readonly maximumDepthApplied: number;
  readonly truncated: boolean;
  readonly backgroundJobId: string | null;
}

export interface MemoryGraphJobWorkerContext {
  readonly db: EventDatabase;
  readonly actorId: string;
  readonly purpose: string;
}

export interface MemoryGraphJobTransitionResult {
  readonly jobId: string;
  readonly status: "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED";
}

export interface MemoryGraphReconciliationJobTransitionResult {
  readonly jobId: string;
  readonly status: "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED";
  readonly cursor: Readonly<{ edgeOffset: number; edgeSourceOffset: number }>;
}

interface MemoryAuthorityRow extends Record<string, unknown> {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly account_id: string | null;
  readonly node_brain_id: string | null;
  readonly conversation_id: string | null;
  readonly valid_from: Date;
  readonly valid_to: Date | null;
  readonly source_ids: string[];
  readonly source_actors: string[];
  readonly body_event_id: string;
}

interface ExistingRunRow extends Record<string, unknown> {
  readonly id: string;
  readonly request_digest: string;
  readonly request_shape_digest: string;
}

const writerContexts = new WeakSet<object>();
const traversalContexts = new WeakSet<object>();
const jobWorkerContexts = new WeakSet<object>();

function invalid(code = "MEMORY_GRAPH_INPUT_INVALID"): never {
  throw new Error(code);
}

function plainRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (keys.length < required.length || keys.length > allowed.size
      || keys.some((key) => typeof key !== "string" || !allowed.has(key))) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of required) if (!keys.includes(key)) return invalid();
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined || descriptor.set !== undefined) return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MEMORY_GRAPH_")) throw error;
    return invalid();
  }
}

function denseArray(value: unknown, maximum: number, limitCode: string): readonly unknown[] {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0) return invalid();
    if (length > maximum) return invalid(limitCode);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined || descriptor.set !== undefined) return invalid();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MEMORY_GRAPH_")) throw error;
    return invalid();
  }
}

function text(value: unknown, maximum = 240): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}

function uuid(value: unknown): string {
  const captured = text(value, 36);
  if (!UUID_PATTERN.test(captured)) return invalid();
  return captured.toLowerCase();
}

function digest(value: unknown): string {
  const captured = text(value, 64);
  if (!DIGEST_PATTERN.test(captured)) return invalid();
  return captured;
}

function timestamp(value: unknown): string {
  const captured = text(value, 24);
  if (!TIMESTAMP_PATTERN.test(captured) || new Date(captured).toISOString() !== captured) return invalid();
  return captured;
}

function wholeNumber(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return invalid();
  }
  return value as number;
}

function optionalTimestamp(value: unknown): string | null {
  return value === undefined ? null : timestamp(value);
}

function validity(validFrom: string, validTo: string | null): void {
  if (validTo !== null && validTo <= validFrom) invalid("MEMORY_GRAPH_VALIDITY_INVALID");
}

function stringSet(value: unknown, maximum = MAX_SOURCES): readonly string[] {
  const captured = denseArray(value, maximum, "MEMORY_GRAPH_SOURCE_LIMIT_EXCEEDED").map(uuid);
  if (captured.length === 0) invalid("MEMORY_GRAPH_SOURCE_REQUIRED");
  if (new Set(captured).size !== captured.length) invalid("MEMORY_GRAPH_SOURCE_DUPLICATE");
  return Object.freeze(captured);
}

function enumValue<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  const captured = text(value, 40);
  if (!values.includes(captured)) return invalid();
  return captured as Values[number];
}

function publicText(value: unknown, scope: MemoryScope, code: string): string | null {
  if (scope === "PUBLIC") return text(value, 240);
  if (value !== undefined) invalid(code);
  return null;
}

function captureAlias(value: unknown, scope: MemoryScope): MemoryGraphAliasInput {
  const record = plainRecord(value, ["alias", "validFrom", "sourceIds"], ["validTo"]);
  const validFrom = timestamp(record.validFrom);
  const validTo = optionalTimestamp(record.validTo);
  validity(validFrom, validTo);
  const alias = text(record.alias, 120);
  return Object.freeze({
    alias,
    publicAlias: scope === "PUBLIC" ? alias : null,
    validFrom,
    validTo,
    sourceIds: stringSet(record.sourceIds),
  });
}

function captureEntity(value: unknown, scope: MemoryScope): MemoryGraphEntityInput {
  const record = plainRecord(
    value,
    ["id", "type", "canonicalName", "validFrom", "aliases"],
    ["validTo"],
  );
  const validFrom = timestamp(record.validFrom);
  const validTo = optionalTimestamp(record.validTo);
  validity(validFrom, validTo);
  const aliases = denseArray(record.aliases, MAX_ALIASES_PER_ENTITY, "MEMORY_GRAPH_ALIAS_LIMIT_EXCEEDED")
    .map((alias) => captureAlias(alias, scope));
  if (new Set(aliases.map((alias) => `${alias.alias.toLowerCase()}:${alias.validFrom}`)).size !== aliases.length) {
    invalid("MEMORY_GRAPH_ALIAS_DUPLICATE");
  }
  const canonicalName = text(record.canonicalName, 120);
  return Object.freeze({
    id: uuid(record.id),
    type: enumValue(record.type, ENTITY_TYPES),
    canonicalName,
    publicLabel: scope === "PUBLIC" ? canonicalName : null,
    validFrom,
    validTo,
    aliases: Object.freeze(aliases),
  });
}

function captureClaim(value: unknown, scope: MemoryScope): MemoryGraphClaimInput {
  const record = plainRecord(value, [
    "memoryId", "entityId", "nodeType", "predicate", "value", "approved",
    "validFrom", "sourceIds",
  ], ["validTo"]);
  if (typeof record.approved !== "boolean") return invalid();
  const validFrom = timestamp(record.validFrom);
  const validTo = optionalTimestamp(record.validTo);
  validity(validFrom, validTo);
  const predicate = text(record.predicate, 120);
  const valueText = text(record.value, 120);
  return Object.freeze({
    memoryId: uuid(record.memoryId),
    entityId: uuid(record.entityId),
    nodeType: enumValue(record.nodeType, NODE_TYPES),
    predicate,
    value: valueText,
    publicPredicate: scope === "PUBLIC" ? predicate : null,
    publicValue: scope === "PUBLIC" ? valueText : null,
    approved: record.approved,
    validFrom,
    validTo,
    sourceIds: stringSet(record.sourceIds),
  });
}

function captureGraphInput(value: unknown): CapturedMemoryGraphInput {
  const record = plainRecord(value, [
    "scope", "idempotencyKey", "reconcilerVersion", "observedAt", "entities", "claims",
  ], ["accountId", "nodeBrainId", "conversationId", "relationships"]);
  const scope = enumValue(record.scope, MEMORY_SCOPES);
  const privateScope = scope === "PRIVATE_ACCOUNT" || scope === "NODE_BRANCH";
  const accountId = privateScope ? uuid(record.accountId) : null;
  const nodeBrainId = privateScope ? uuid(record.nodeBrainId) : null;
  const conversationId = privateScope ? uuid(record.conversationId) : null;
  if (!privateScope && (record.accountId !== undefined || record.nodeBrainId !== undefined
    || record.conversationId !== undefined)) invalid("MEMORY_GRAPH_SCOPE_TOPOLOGY_INVALID");
  const entities = denseArray(record.entities, MAX_ENTITIES, "MEMORY_GRAPH_ENTITY_LIMIT_EXCEEDED")
    .map((entity) => captureEntity(entity, scope));
  const claims = denseArray(record.claims, MAX_CLAIMS, "MEMORY_GRAPH_CLAIM_LIMIT_EXCEEDED")
    .map((claim) => captureClaim(claim, scope));
  if (record.relationships !== undefined) {
    invalid("MEMORY_GRAPH_RELATIONSHIP_INPUT_FORBIDDEN");
  }
  const relationships: readonly MemoryGraphRelationshipInput[] = Object.freeze([]);
  if (entities.length === 0) invalid("MEMORY_GRAPH_ENTITY_REQUIRED");
  if (claims.length === 0) invalid("MEMORY_GRAPH_CLAIM_REQUIRED");
  if (new Set(entities.map(({ id }) => id)).size !== entities.length) {
    invalid("MEMORY_GRAPH_ENTITY_DUPLICATE");
  }
  if (new Set(claims.map(({ memoryId }) => memoryId)).size !== claims.length) {
    invalid("MEMORY_GRAPH_MEMORY_DUPLICATE");
  }
  const claimIds = new Set(claims.map(({ memoryId }) => memoryId));
  if (relationships.some(({ from, to }) => from === to || !claimIds.has(from) || !claimIds.has(to))) {
    invalid("MEMORY_GRAPH_RELATIONSHIP_NODE_INVALID");
  }
  const entityIds = new Set(entities.map(({ id }) => id));
  if (claims.some(({ entityId }) => !entityIds.has(entityId))) {
    invalid("MEMORY_GRAPH_ENTITY_UNKNOWN");
  }
  if (entities.some((entity) => !claims.some(({ entityId }) => entityId === entity.id))) {
    invalid("MEMORY_GRAPH_ENTITY_ORPHANED");
  }
  const sourcesByEntity = new Map<string, Set<string>>();
  for (const claim of claims) {
    const sources = sourcesByEntity.get(claim.entityId) ?? new Set<string>();
    claim.sourceIds.forEach((sourceId) => sources.add(sourceId));
    sourcesByEntity.set(claim.entityId, sources);
  }
  for (const entity of entities) {
    const allowed = sourcesByEntity.get(entity.id) ?? new Set<string>();
    if (entity.aliases.some((alias) => alias.sourceIds.some((sourceId) => !allowed.has(sourceId)))) {
      invalid("MEMORY_GRAPH_ALIAS_SOURCE_INVALID");
    }
  }
  const observedAt = timestamp(record.observedAt);
  if (claims.some(({ validFrom }) => validFrom > observedAt)
    || entities.some(({ validFrom }) => validFrom > observedAt)) {
    invalid("MEMORY_GRAPH_OBSERVED_BEFORE_VALIDITY");
  }
  return Object.freeze({
    scope,
    accountId,
    nodeBrainId,
    conversationId,
    idempotencyKey: text(record.idempotencyKey),
    reconcilerVersion: text(record.reconcilerVersion, 200),
    observedAt,
    entities: Object.freeze(entities),
    claims: Object.freeze(claims),
    relationships: Object.freeze(relationships),
  });
}

export function memoryGraphRelationPolicy() {
  return RELATION_POLICY;
}

function uuidFromDigest(value: string): string {
  const characters = value.slice(0, 32).split("");
  characters[12] = "5";
  characters[16] = ((Number.parseInt(characters[16]!, 16) & 0x3) | 0x8).toString(16);
  const compact = characters.join("");
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16),
    compact.slice(16, 20), compact.slice(20)].join("-");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function approvalIsAuthoritative(input: CapturedMemoryGraphInput, row: MemoryAuthorityRow): boolean {
  if (input.scope === "PRIVATE_ACCOUNT") {
    return row.source_actors.some((actor) => actor === `USER:${input.accountId}`);
  }
  if (input.scope === "NODE_BRANCH") {
    return row.source_actors.some((actor) => actor === `NODE_BRAIN:${input.nodeBrainId}`);
  }
  if (input.scope === "MAIN_SHARED" || input.scope === "PUBLIC") {
    return row.source_actors.includes("MAIN_BRAIN:gustavo-main");
  }
  if (input.scope === "CHALLENGE_SHARED") {
    return row.source_actors.some((actor) => actor === "MAIN_BRAIN:gustavo-main"
      || actor === "SYSTEM:challenge-stage-lifecycle");
  }
  return row.source_actors.some((actor) => actor.startsWith("OPERATOR:"));
}

async function assertMemoryAuthority(
  db: EventDatabase,
  input: CapturedMemoryGraphInput,
): Promise<readonly MemoryAuthorityRow[]> {
  const locked = await db.query<{ id: string } & Record<string, unknown>>(
    `select id::text from memory_records where id=any($1::uuid[])
     order by id for key share`,
    [input.claims.map(({ memoryId }) => memoryId)],
  );
  if (locked.length !== input.claims.length) {
    throw new Error("MEMORY_GRAPH_MEMORY_AUTHORITY_INVALID");
  }
  const rows = await db.query<MemoryAuthorityRow>(
    `select memory.id::text,memory.scope,memory.account_id::text,memory.node_brain_id::text,
            memory.conversation_id::text,memory.valid_from,memory.valid_to,
            array_agg(source.source_event_id::text order by source.ordinal) source_ids,
            array_agg(event.actor_type||':'||event.actor_id order by source.ordinal) source_actors,
            memory.body_event_id::text
     from memory_records memory
     join memory_sources source on source.memory_id=memory.id
     join events event on event.id=source.source_event_id
     where memory.id=any($1::uuid[])
     group by memory.id
     order by memory.id`,
    [input.claims.map(({ memoryId }) => memoryId)],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const claim of input.claims) {
    const row = byId.get(claim.memoryId);
    if (!row || row.scope !== input.scope || row.account_id !== input.accountId
      || row.node_brain_id !== input.nodeBrainId || row.conversation_id !== input.conversationId
      || row.valid_from.toISOString() !== claim.validFrom
      || (row.valid_to?.toISOString() ?? null) !== claim.validTo
      || !sameStrings(row.source_ids, claim.sourceIds)
      || (claim.approved && !approvalIsAuthoritative(input, row))) {
      throw new Error("MEMORY_GRAPH_MEMORY_AUTHORITY_INVALID");
    }
  }
  return Object.freeze(rows);
}

function normalizedTerm(value: string): string {
  return value.trim().toLowerCase();
}

function bodyMemory(body: JsonValue, memoryId: string): Readonly<Record<string, JsonValue>> {
  if (!body || Array.isArray(body) || typeof body !== "object" || !Array.isArray(body.memories)) {
    throw new Error("MEMORY_GRAPH_SOURCE_BODY_INVALID");
  }
  const matched = body.memories.filter((item): item is Record<string, JsonValue> => (
    !!item && !Array.isArray(item) && typeof item === "object" && item.id === memoryId
  ));
  if (matched.length !== 1) throw new Error("MEMORY_GRAPH_SOURCE_BODY_INVALID");
  return matched[0]!;
}

function jsonStringSet(value: JsonValue | undefined): ReadonlySet<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("MEMORY_GRAPH_SOURCE_BODY_INVALID");
  }
  return new Set((value as string[]).map(normalizedTerm));
}

async function resolveAuthoritativeInput(
  db: EventDatabase,
  input: CapturedMemoryGraphInput,
): Promise<ResolvedMemoryGraphInput> {
  const authority = await assertMemoryAuthority(db, input);
  const bodyEventIds = [...new Set(authority.map(({ body_event_id }) => body_event_id))].sort();
  const available = await lockAvailableMemorySourceBodies(db, bodyEventIds);
  if (!sameStrings(available, bodyEventIds)) throw new Error("EVENT_KEY_UNAVAILABLE");
  const bodies = await readEventBodies(db, bodyEventIds, { actor: { role: "SYSTEM" } });
  const bodyByEvent = new Map(bodies.map(({ eventId, body }) => [eventId, body]));
  const authorityById = new Map(authority.map((row) => [row.id, row]));
  const semanticTermsByMemory = new Map<string, Readonly<{
    keywords: ReadonlySet<string>; sources: ReadonlySet<string>; entities: ReadonlySet<string>;
  }>>();
  for (const claim of input.claims) {
    const row = authorityById.get(claim.memoryId)!;
    const semantic = bodyMemory(bodyByEvent.get(row.body_event_id)!, claim.memoryId);
    semanticTermsByMemory.set(claim.memoryId, Object.freeze({
      keywords: jsonStringSet(semantic.keywords), sources: jsonStringSet(semantic.sourceIds),
      entities: jsonStringSet(semantic.entities),
    }));
  }
  for (const claim of input.claims) {
    const { keywords, sources } = semanticTermsByMemory.get(claim.memoryId)!;
    if (!keywords.has(normalizedTerm(claim.predicate))
      || !keywords.has(normalizedTerm(claim.value))
      || !claim.sourceIds.every((sourceId) => sources.has(sourceId.toLowerCase()))) {
      throw new Error("MEMORY_GRAPH_SEMANTIC_NOT_SOURCE_GROUNDED");
    }
  }
  for (const entity of input.entities) {
    const claims = input.claims.filter(({ entityId }) => entityId === entity.id);
    const semantic = claims.map(({ memoryId }) => semanticTermsByMemory.get(memoryId)!);
    if (!semantic.some((memory) => memory.entities.has(normalizedTerm(entity.canonicalName)))) {
      throw new Error("MEMORY_GRAPH_SEMANTIC_NOT_SOURCE_GROUNDED");
    }
    for (const alias of entity.aliases) {
      if (!alias.sourceIds.every((sourceId) => semantic.some((memory) => (
        memory.entities.has(normalizedTerm(alias.alias))
          && memory.sources.has(sourceId.toLowerCase())
      )))) throw new Error("MEMORY_GRAPH_SEMANTIC_NOT_SOURCE_GROUNDED");
    }
  }
  const topology = {
    scope: input.scope,
    ...(input.accountId === null ? {} : { accountId: input.accountId }),
    ...(input.nodeBrainId === null ? {} : { nodeBrainId: input.nodeBrainId }),
    ...(input.conversationId === null ? {} : { conversationId: input.conversationId }),
  };
  const termRequests = [
    ...input.entities.flatMap((entity) => [
      { ...topology, kind: "ENTITY" as const, term: entity.canonicalName },
      ...entity.aliases.map((alias) => ({
        ...topology, kind: "ENTITY" as const, term: alias.alias,
      })),
    ]),
    ...input.claims.flatMap((claim) => [
      { ...topology, kind: "KEYWORD" as const, term: claim.predicate },
      { ...topology, kind: "KEYWORD" as const, term: claim.value },
    ]),
  ];
  const termDigests = await deriveMemorySearchTermDigests(
    createMemoryWorkerContext(db), termRequests,
  );
  let termIndex = 0;
  const entities = input.entities.map((entity) => {
    const canonicalTermDigest = termDigests[termIndex++]!;
    const aliases = entity.aliases.map((alias) => {
      const aliasTermDigest = termDigests[termIndex++]!;
      return Object.freeze({ ...alias, digest: canonicalContentDigest({
        domain: "gustavo:memory-graph:alias:v1", termDigest: aliasTermDigest,
      }) });
    });
    return Object.freeze({ ...entity, canonicalDigest: canonicalContentDigest({
      domain: "gustavo:memory-graph:entity:v1", termDigest: canonicalTermDigest,
    }), aliases: Object.freeze(aliases) });
  });
  const claims = input.claims.map((claim) => {
    const predicateTermDigest = termDigests[termIndex++]!;
    const valueTermDigest = termDigests[termIndex++]!;
    return Object.freeze({ ...claim,
      predicateDigest: canonicalContentDigest({
        domain: "gustavo:memory-graph:predicate:v1", termDigest: predicateTermDigest,
      }),
      valueDigest: canonicalContentDigest({
        domain: "gustavo:memory-graph:value:v1", termDigest: valueTermDigest,
      }),
    });
  });
  return Object.freeze({ ...input, entities: Object.freeze(entities), claims: Object.freeze(claims),
    consolidationBodyEventIds: Object.freeze(bodyEventIds) });
}

async function revalidateMemoryGraphWriteAuthority(
  db: EventDatabase,
  input: CapturedMemoryGraphInput,
): Promise<void> {
  if (input.scope !== "PRIVATE_ACCOUNT" && input.scope !== "NODE_BRANCH") return;
  const rows = await db.query(
    `/* memory-graph-writer-authority-lock */
     select 1 from accounts account
     join entitlements entitlement on entitlement.account_id=account.id
       and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
       and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
     join node_brains node on node.account_id=account.id and node.id=$2 and node.status='ACTIVE'
     join conversations conversation on conversation.account_id=account.id
       and conversation.node_brain_id=node.id and conversation.id=$3 and conversation.status='OPEN'
     where account.id=$1 and account.status='ACTIVE'
     for update of account,entitlement,node,conversation`,
    [input.accountId, input.nodeBrainId, input.conversationId],
  );
  if (rows.length !== 1) throw new Error("MEMORY_GRAPH_ACTOR_FORBIDDEN");
}

function graphOperationKey(input: ResolvedMemoryGraphInput): string {
  return canonicalContentDigest({
    scope: input.scope,
    accountId: input.accountId,
    nodeBrainId: input.nodeBrainId,
    conversationId: input.conversationId,
    reconcilerVersion: input.reconcilerVersion,
    observedAt: input.observedAt,
    entities: input.entities.map(({ canonicalName: _canonicalName, aliases, ...entity }) => ({
      ...entity,
      aliases: aliases.map(({ alias: _alias, ...item }) => item),
    })),
    claims: input.claims.map(({ predicate: _predicate, value: _value, ...claim }) => claim),
    relationships: input.relationships,
  });
}

function graphRequestShapeDigest(input: CapturedMemoryGraphInput): string {
  return canonicalContentDigest({
    scope: input.scope, accountId: input.accountId, nodeBrainId: input.nodeBrainId,
    conversationId: input.conversationId, reconcilerVersion: input.reconcilerVersion,
    observedAt: input.observedAt,
    entities: input.entities.map((entity) => ({ id: entity.id, type: entity.type,
      validFrom: entity.validFrom, validTo: entity.validTo,
      aliases: entity.aliases.map((alias) => ({ validFrom: alias.validFrom, validTo: alias.validTo,
        sourceIds: alias.sourceIds })) })),
    claims: input.claims.map((claim) => ({ memoryId: claim.memoryId, entityId: claim.entityId,
      nodeType: claim.nodeType, approved: claim.approved, validFrom: claim.validFrom,
      validTo: claim.validTo, sourceIds: claim.sourceIds })),
  });
}

function reconciliationGroups(input: ResolvedMemoryGraphInput) {
  const groups = new Map<string, ResolvedMemoryGraphClaim[]>();
  for (const claim of input.claims) {
    const key = `${claim.entityId}:${claim.predicateDigest}`;
    const group = groups.get(key) ?? [];
    group.push(claim);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, claims]) => {
    const result = reconcileMemories(claims.map((claim) => ({
      id: claim.memoryId,
      entityId: claim.entityId,
      predicate: claim.predicateDigest,
      value: claim.valueDigest,
      validFrom: claim.validFrom,
      ...(claim.validTo === null ? {} : { validTo: claim.validTo }),
      approved: claim.approved,
      sourceIds: claim.sourceIds,
    })));
    return Object.freeze({ key, claims: Object.freeze(claims), result });
  });
}

function intersectValidity(
  source: Pick<ResolvedMemoryGraphClaim, "validFrom" | "validTo">,
  target: Pick<ResolvedMemoryGraphClaim, "validFrom" | "validTo">,
): { readonly validFrom: string; readonly validTo: string | null } {
  const validFrom = source.validFrom > target.validFrom ? source.validFrom : target.validFrom;
  const finite = [source.validTo, target.validTo].filter((value): value is string => value !== null);
  const validTo = finite.length === 0 ? null : finite.sort()[0]!;
  if (validTo !== null && validTo <= validFrom) {
    throw new Error("MEMORY_GRAPH_RELATIONSHIP_VALIDITY_INVALID");
  }
  return Object.freeze({ validFrom, validTo });
}

async function deriveAuthoritativeRelationships(
  db: EventDatabase,
  input: ResolvedMemoryGraphInput,
) {
  const byId = new Map(input.claims.map((claim) => [claim.memoryId, claim]));
  const rows = await db.query<{
    source_memory_id: string; target_memory_id: string;
    type: Exclude<MemoryGraphEdgeType, "CONTRADICTS" | "SUPERSEDES" | "SUPPORTS" | "MENTIONS">;
  } & Record<string, unknown>>(
    `with candidate as (
       select memory.* from memory_records memory where memory.id=any($1::uuid[])
     )
     select source.id::text source_memory_id,target.id::text target_memory_id,relation.type
     from candidate source
     join candidate target on target.id<>source.id
     cross join lateral (
       select 'DERIVED_FROM'::text type where source.supersedes_memory_id=target.id
       union all select 'PROPOSED_BY' where exists (
         select 1 from proposals proposal
         join memory_sources proposed on proposed.memory_id=source.id
           and proposed.source_event_id=proposal.route_event_id
         join memory_sources cited on cited.memory_id=target.id
           and proposal.source_event_ids ? cited.source_event_id::text
       )
       union all select 'ACCEPTED_INTO' where exists (
         select 1 from proposals proposal
         join memory_sources proposed on proposed.memory_id=source.id
           and proposed.source_event_id=proposal.route_event_id
         join memory_sources cited on cited.memory_id=target.id
           and proposal.source_event_ids ? cited.source_event_id::text
         where (select transition.to_status from proposal_status_transitions transition
           where transition.proposal_id=proposal.id order by transition.ordinal desc limit 1)='ACCEPTED'
       )
       union all select 'AFFECTED' where exists (
         select 1 from proposals proposal
         join memory_sources proposed on proposed.memory_id=source.id
           and proposed.source_event_id=proposal.route_event_id
         join memory_sources affected_source on affected_source.memory_id=target.id
           and proposal.source_event_ids ? affected_source.source_event_id::text
         where jsonb_array_length(proposal.affected_main_state_ids)>0
       )
       union all select 'RESULTED_IN' where exists (
         select 1 from memory_sources result_source
         join events result_event on result_event.id=result_source.source_event_id
         join memory_sources cause_source on cause_source.memory_id=target.id
           and cause_source.source_event_id=result_event.causation_id
         where result_source.memory_id=source.id
       )
       union all select 'SIMILAR_TO' where exists (
         select 1 from memory_equivalence_links equivalent
         where (equivalent.memory_id=source.id and equivalent.equivalent_memory_id=target.id)
            or (equivalent.memory_id=target.id and equivalent.equivalent_memory_id=source.id)
       )
       union all select 'PART_OF' where source.extraction_run_id=target.extraction_run_id
         and target.type='EPISODIC'
     ) relation
     order by source.id,target.id,relation.type
     limit ${MAX_GRAPH_EDGES}`,
    [input.claims.map(({ memoryId }) => memoryId)],
  );
  const durable = rows.map((row) => ({
    source: byId.get(row.source_memory_id)!, target: byId.get(row.target_memory_id)!, type: row.type,
  }));
  const automatic: Array<{
    source: ResolvedMemoryGraphClaim; target: ResolvedMemoryGraphClaim;
    type: "MENTIONS" | "SUPPORTS";
  }> = [];
  for (const source of input.claims) for (const target of input.claims) {
    if (source.memoryId === target.memoryId) continue;
    if (source.approved && target.approved && source.entityId === target.entityId
      && source.predicateDigest === target.predicateDigest && source.valueDigest === target.valueDigest) {
      automatic.push({ source, target, type: "SUPPORTS" });
    }
  }
  const extractionRows = await db.query<{
    source_memory_id: string; target_memory_id: string;
  } & Record<string, unknown>>(
    `select source.id::text source_memory_id,target.id::text target_memory_id
     from memory_records source join memory_records target
       on target.extraction_run_id=source.extraction_run_id and target.id<>source.id
     where source.id=any($1::uuid[]) and target.id=any($1::uuid[])
     order by source.id,target.id`,
    [input.claims.map(({ memoryId }) => memoryId)],
  );
  for (const row of extractionRows) {
    const source = byId.get(row.source_memory_id)!;
    const target = byId.get(row.target_memory_id)!;
    if (source.entityId !== target.entityId) automatic.push({ source, target, type: "MENTIONS" });
  }
  const unique = new Map<string, typeof durable[number] | typeof automatic[number]>();
  for (const relation of [...durable, ...automatic]) {
    if (!relation.source || !relation.target) continue;
    unique.set(`${relation.source.memoryId}:${relation.type}:${relation.target.memoryId}`, relation);
  }
  return [...unique.values()].flatMap(({ source, target, type }) => {
    try {
      const interval = intersectValidity(source, target);
      const sourceIds = [...new Set([...source.sourceIds, ...target.sourceIds])].sort();
      return [Object.freeze({ edge: Object.freeze({
        from: source.memoryId, type, to: target.memoryId, ...interval,
      }), source, target, sourceIds: Object.freeze(sourceIds) })];
    } catch (error) {
      if (error instanceof Error && error.message === "MEMORY_GRAPH_RELATIONSHIP_VALIDITY_INVALID") {
        return [];
      }
      throw error;
    }
  });
}

async function estimateDurableRelationshipCount(
  db: EventDatabase,
  input: ResolvedMemoryGraphInput,
): Promise<number> {
  const result = await db.one<{ count: number } & Record<string, unknown>>(
    `with graph_input(memory_id,entity_id) as (
       select * from unnest($1::uuid[],$2::uuid[])
     ), candidate as (
       select memory.*,graph_input.entity_id graph_entity_id
       from graph_input join memory_records memory on memory.id=graph_input.memory_id
     ), durable as (
       select source.id source_memory_id,target.id target_memory_id,relation.type
       from candidate source
       join candidate target on target.id<>source.id
       cross join lateral (
         select 'DERIVED_FROM'::text type where source.supersedes_memory_id=target.id
         union all select 'PROPOSED_BY' where exists (
           select 1 from proposals proposal
           join memory_sources proposed on proposed.memory_id=source.id
             and proposed.source_event_id=proposal.route_event_id
           join memory_sources cited on cited.memory_id=target.id
             and proposal.source_event_ids ? cited.source_event_id::text
         )
         union all select 'ACCEPTED_INTO' where exists (
           select 1 from proposals proposal
           join memory_sources proposed on proposed.memory_id=source.id
             and proposed.source_event_id=proposal.route_event_id
           join memory_sources cited on cited.memory_id=target.id
             and proposal.source_event_ids ? cited.source_event_id::text
           where (select transition.to_status from proposal_status_transitions transition
             where transition.proposal_id=proposal.id order by transition.ordinal desc limit 1)='ACCEPTED'
         )
         union all select 'AFFECTED' where exists (
           select 1 from proposals proposal
           join memory_sources proposed on proposed.memory_id=source.id
             and proposed.source_event_id=proposal.route_event_id
           join memory_sources affected_source on affected_source.memory_id=target.id
             and proposal.source_event_ids ? affected_source.source_event_id::text
           where jsonb_array_length(proposal.affected_main_state_ids)>0
         )
         union all select 'RESULTED_IN' where exists (
           select 1 from memory_sources result_source
           join events result_event on result_event.id=result_source.source_event_id
           join memory_sources cause_source on cause_source.memory_id=target.id
             and cause_source.source_event_id=result_event.causation_id
           where result_source.memory_id=source.id
         )
         union all select 'SIMILAR_TO' where exists (
           select 1 from memory_equivalence_links equivalent
           where (equivalent.memory_id=source.id and equivalent.equivalent_memory_id=target.id)
              or (equivalent.memory_id=target.id and equivalent.equivalent_memory_id=source.id)
         )
         union all select 'PART_OF' where source.extraction_run_id=target.extraction_run_id
           and target.type='EPISODIC'
       ) relation
     ), mentions as (
       select source.id source_memory_id,target.id target_memory_id
       from candidate source join candidate target
         on target.extraction_run_id=source.extraction_run_id and target.id<>source.id
       where source.graph_entity_id<>target.graph_entity_id
     )
     select ((select count(*) from durable)+(select count(*) from mentions))::int count`,
    [input.claims.map(({ memoryId }) => memoryId), input.claims.map(({ entityId }) => entityId)],
  );
  return result.count;
}

function estimateSupportWork(input: ResolvedMemoryGraphInput) {
  let edges = 0;
  let sources = 0;
  for (const source of input.claims) for (const target of input.claims) {
    if (source.memoryId === target.memoryId || !source.approved || !target.approved
      || source.entityId !== target.entityId
      || source.predicateDigest !== target.predicateDigest
      || source.valueDigest !== target.valueDigest) continue;
    edges += 1;
    sources += new Set([...source.sourceIds, ...target.sourceIds]).size;
  }
  return Object.freeze({ edges, sources });
}

function maximumPairSourceCount(input: ResolvedMemoryGraphInput): number {
  let maximum = 0;
  for (const source of input.claims) for (const target of input.claims) {
    if (source.memoryId === target.memoryId) continue;
    maximum = Math.max(maximum, new Set([...source.sourceIds, ...target.sourceIds]).size);
  }
  return maximum;
}

function estimateMaterializationRows(
  input: ResolvedMemoryGraphInput,
  groupCount: number,
): number {
  const aliasCount = input.entities.reduce((count, entity) => count + entity.aliases.length, 0);
  const aliasSourceCount = input.entities.reduce((count, entity) => count
    + entity.aliases.reduce((sources, alias) => sources + alias.sourceIds.length, 0), 0);
  const candidateSourceCount = input.claims.reduce(
    (count, claim) => count + claim.sourceIds.length, 0,
  );
  return input.entities.length * 3 + aliasCount * 2 + aliasSourceCount
    + input.claims.length * 2 + candidateSourceCount + groupCount * 2;
}

export function createMemoryGraphWriterContext(db: EventDatabase): MemoryGraphWriterContext {
  if (!db || typeof db !== "object" || typeof db.query !== "function"
    || typeof db.transaction !== "function") throw new Error("MEMORY_GRAPH_CONTEXT_INVALID");
  const context = Object.freeze({ db });
  writerContexts.add(context);
  return context;
}

async function loadGraphRun(db: EventDatabase, runId: string): Promise<VersionMemoryGraphResult> {
  const binding = await db.query<{ exact: boolean } & Record<string, unknown>>(
    `select body.body_digest=memory_graph_expected_event_body_digest(run.id)
          and manifest.body_digest=body.body_digest
          and memory_graph_event_envelope_is_valid(run.id,run.graph_event_id) exact
     from memory_graph_reconciliation_runs run
     join encrypted_event_bodies body on body.event_id=run.graph_event_id
     join memory_graph_event_manifests manifest on manifest.reconciliation_run_id=run.id
     where run.id=$1`, [runId],
  );
  if (binding.length !== 1 || !binding[0]!.exact) {
    throw new Error("MEMORY_GRAPH_EVENT_BODY_INVALID");
  }
  const current = await db.query<{ memory_id: string } & Record<string, unknown>>(
    `select memory_id::text from memory_graph_current_claims where reconciliation_run_id=$1
     order by entity_id,predicate_digest,memory_id`,
    [runId],
  );
  const edges = await db.query<{
    id: string; source_memory_id: string; type: MemoryGraphEdgeType;
    target_memory_id: string; valid_from: Date; valid_to: Date | null;
  } & Record<string, unknown>>(
    `select edge.id::text,edge.source_memory_id::text,edge.type,edge.target_memory_id::text,
            edge.valid_from,edge.valid_to
     from memory_graph_run_edges member
     join memory_graph_edges edge on edge.id=member.edge_id
     where member.reconciliation_run_id=$1
     order by edge.valid_from,edge.source_memory_id,edge.type,edge.target_memory_id`,
    [runId],
  );
  const conflicts = await db.query<{
    id: string; newer_memory_id: string; older_memory_id: string; preferred_memory_id: string;
    source_ids: string[];
  } & Record<string, unknown>>(
    `select conflict.id::text,conflict.newer_memory_id::text,conflict.older_memory_id::text,
            conflict.preferred_memory_id::text,
            array_agg(source.source_event_id::text order by source.source_event_id) source_ids
     from memory_graph_run_conflicts member
     join memory_conflicts conflict on conflict.id=member.conflict_id
     join memory_conflict_sources source on source.conflict_id=conflict.id
     where member.reconciliation_run_id=$1
     group by conflict.id
     order by conflict.detected_at,conflict.id`,
    [runId],
  );
  return Object.freeze({
    status: "COMPLETED" as const,
    reconciliationRunId: runId,
    backgroundJobId: null,
    currentMemoryIds: Object.freeze(current.map(({ memory_id }) => memory_id)),
    edges: Object.freeze(edges.map((edge) => Object.freeze({
      id: edge.id,
      from: edge.source_memory_id,
      type: edge.type,
      to: edge.target_memory_id,
      validFrom: edge.valid_from.toISOString(),
      validTo: edge.valid_to?.toISOString() ?? null,
    }))),
    conflicts: Object.freeze(conflicts.map((conflict) => Object.freeze({
      id: conflict.id,
      newer: conflict.newer_memory_id,
      older: conflict.older_memory_id,
      preferred: conflict.preferred_memory_id,
      sourceIds: Object.freeze(conflict.source_ids),
    }))),
  });
}

async function enqueueMemoryGraphReconciliation(
  db: EventDatabase,
  input: ResolvedMemoryGraphInput,
  operationKey: string,
  requestDigest: string,
  requestShapeDigest: string,
  estimatedEdgeCount: number,
  estimatedEdgeSourceCount: number,
  estimatedMaterializationRows: number,
): Promise<QueuedMemoryGraphResult> {
  const jobId = randomUUID();
  const sourceEventIds = [...new Set(input.claims.flatMap(({ sourceIds }) => sourceIds))].sort();
  const sourceOrdinal = new Map(sourceEventIds.map((sourceId, ordinal) => [sourceId, ordinal]));
  const sourceSets: Array<{
    ordinal: number; sourceOrdinals: number[]; sourceCount: number; sourceDigest: string;
  }> = [];
  const sourceSetByDigest = new Map<string, number>();
  const sourceSetOrdinal = (sourceIds: readonly string[]) => {
    const sourceDigest = canonicalContentDigest({ sourceIds });
    const existing = sourceSetByDigest.get(sourceDigest);
    if (existing !== undefined) return existing;
    const ordinal = sourceSets.length;
    sourceSets.push({ ordinal, sourceOrdinals: sourceIds.map((id) => sourceOrdinal.get(id)!),
      sourceCount: sourceIds.length, sourceDigest });
    sourceSetByDigest.set(sourceDigest, ordinal);
    return ordinal;
  };
  const entities = input.entities.map((entity, ordinal) => ({
    ordinal, entityId: entity.id, type: entity.type, canonicalDigest: entity.canonicalDigest,
    publicLabel: entity.publicLabel, validFrom: entity.validFrom, validTo: entity.validTo,
  }));
  let aliasOrdinal = 0;
  const aliases = input.entities.flatMap((entity) => entity.aliases.map((alias) => ({
    ordinal: aliasOrdinal++, entityId: entity.id, aliasDigest: alias.digest,
    publicAlias: alias.publicAlias, validFrom: alias.validFrom, validTo: alias.validTo,
    sourceSetOrdinal: sourceSetOrdinal(alias.sourceIds), sourceCount: alias.sourceIds.length,
  })));
  const candidates = input.claims.map((claim, ordinal) => ({
    ordinal, memoryId: claim.memoryId, entityId: claim.entityId, nodeType: claim.nodeType,
    predicateDigest: claim.predicateDigest, valueDigest: claim.valueDigest,
    publicPredicate: claim.publicPredicate, publicValue: claim.publicValue,
    approved: claim.approved, validFrom: claim.validFrom, validTo: claim.validTo,
    sourceSetOrdinal: sourceSetOrdinal(claim.sourceIds), sourceCount: claim.sourceIds.length,
  }));
  const resumeCursor = Object.freeze({ edgeOffset: 0, edgeSourceOffset: 0 });
  const requestEvent = await appendEvent(db, {
    aggregateId: input.conversationId ?? `memory-graph:${input.scope}`,
    ...(input.accountId === null ? {} : { accountId: input.accountId }),
    actor: { type: "SYSTEM", id: "memory-graph-reconciler" },
    type: "memory.graph.reconciliation.queued",
    visibility: input.scope === "PUBLIC" ? "PUBLIC"
      : input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH"
        ? "PRIVATE_ACCOUNT" : input.scope === "AUDIT_ONLY" ? "OPERATOR" : "SHARED",
    body: JSON.parse(JSON.stringify({
      jobId, operationKey, requestDigest, requestShapeDigest,
      scope: input.scope, accountId: input.accountId, nodeBrainId: input.nodeBrainId,
      conversationId: input.conversationId, reconcilerVersion: input.reconcilerVersion,
      observedAt: input.observedAt,
      counts: { entities: entities.length, aliases: aliases.length, candidates: candidates.length,
        sources: sourceEventIds.length, sourceSets: sourceSets.length },
      estimates: { edges: estimatedEdgeCount, edgeSources: estimatedEdgeSourceCount,
        materializationRows: estimatedMaterializationRows },
      cursor: resumeCursor,
      digests: { entities: canonicalContentDigest(entities), aliases: canonicalContentDigest(aliases),
        candidates: canonicalContentDigest(candidates), sources: canonicalContentDigest(sourceEventIds),
        sourceSets: canonicalContentDigest(sourceSets) },
    })) as JsonValue,
    idempotencyKey: `memory-graph-reconciliation-job:${operationKey}`,
    occurredAt: new Date(input.observedAt),
    policyVersion: "memory-graph-v1",
  });
  const header = await db.one<{
    request_hash: string; integrity_hash: string; body_digest: string;
  } & Record<string, unknown>>(
    `select event.request_hash,event.integrity_hash,body.body_digest
     from events event join encrypted_event_bodies body on body.event_id=event.id
     where event.id=$1`, [requestEvent.id],
  );
  await db.query(
    `insert into memory_graph_reconciliation_jobs (
       id,operation_key,idempotency_key,request_digest,request_shape_digest,reconciler_version,scope,
       account_id,node_brain_id,conversation_id,candidate_memory_ids,source_event_ids,
       candidate_count,estimated_edge_count,estimated_edge_source_count,
       estimated_materialization_rows,request_event_id,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [jobId, operationKey, input.idempotencyKey, requestDigest, requestShapeDigest,
      input.reconcilerVersion, input.scope, input.accountId, input.nodeBrainId, input.conversationId,
      input.claims.map(({ memoryId }) => memoryId), sourceEventIds, input.claims.length,
      estimatedEdgeCount, estimatedEdgeSourceCount, estimatedMaterializationRows,
      requestEvent.id, input.observedAt],
  );
  await db.query(
    `insert into memory_graph_reconciliation_job_idempotency_keys (
       idempotency_key,job_id,operation_key,request_digest,request_shape_digest,created_at
     ) values ($1,$2,$3,$4,$5,$6)`,
    [input.idempotencyKey, jobId, operationKey, requestDigest, requestShapeDigest, input.observedAt],
  );
  await db.query(
    `with input as (select * from jsonb_to_recordset($1::jsonb)
       as item(ordinal int,"sourceEventId" uuid))
     insert into memory_graph_reconciliation_job_sources(job_id,ordinal,source_event_id)
     select $2,item.ordinal,item."sourceEventId" from input item`,
    [JSON.stringify(sourceEventIds.map((sourceEventId, ordinal) => ({ ordinal, sourceEventId }))),
      jobId],
  );
  await db.query(
    `with input as (select * from jsonb_to_recordset($1::jsonb)
       as item(ordinal int,"sourceOrdinals" int[],"sourceCount" int,"sourceDigest" text))
     insert into memory_graph_reconciliation_job_source_sets(
       job_id,ordinal,source_ordinals,source_count,source_digest
     ) select $2,item.ordinal,item."sourceOrdinals",item."sourceCount",item."sourceDigest"
       from input item`, [JSON.stringify(sourceSets), jobId],
  );
  await db.query(
    `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
       ordinal int,"entityId" uuid,type text,"canonicalDigest" text,"publicLabel" text,
       "validFrom" timestamptz,"validTo" timestamptz))
     insert into memory_graph_reconciliation_job_entities(
       job_id,ordinal,entity_id,type,canonical_digest,public_label,valid_from,valid_to
     ) select $2,item.ordinal,item."entityId",item.type,item."canonicalDigest",item."publicLabel",
              item."validFrom",item."validTo" from input item`, [JSON.stringify(entities), jobId],
  );
  if (aliases.length > 0) await db.query(
    `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
       ordinal int,"entityId" uuid,"aliasDigest" text,"publicAlias" text,
       "validFrom" timestamptz,"validTo" timestamptz,"sourceSetOrdinal" int,"sourceCount" int))
     insert into memory_graph_reconciliation_job_aliases(
       job_id,ordinal,entity_id,alias_digest,public_alias,valid_from,valid_to,
       source_set_ordinal,source_count
     ) select $2,item.ordinal,item."entityId",item."aliasDigest",item."publicAlias",
              item."validFrom",item."validTo",item."sourceSetOrdinal",item."sourceCount"
       from input item`, [JSON.stringify(aliases), jobId],
  );
  await db.query(
    `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
       ordinal int,"memoryId" uuid,"entityId" uuid,"nodeType" text,"predicateDigest" text,
       "valueDigest" text,"publicPredicate" text,"publicValue" text,approved boolean,
       "validFrom" timestamptz,"validTo" timestamptz,"sourceSetOrdinal" int,"sourceCount" int))
     insert into memory_graph_reconciliation_job_candidates(
       job_id,ordinal,memory_id,entity_id,node_type,predicate_digest,value_digest,
       public_predicate,public_value,approved,valid_from,valid_to,source_set_ordinal,source_count
     ) select $2,item.ordinal,item."memoryId",item."entityId",item."nodeType",
              item."predicateDigest",item."valueDigest",item."publicPredicate",item."publicValue",
              item.approved,item."validFrom",item."validTo",item."sourceSetOrdinal",
              item."sourceCount" from input item`, [JSON.stringify(candidates), jobId],
  );
  const transitionId = randomUUID();
  await db.query(
    `insert into memory_graph_reconciliation_job_transitions (
       id,job_id,ordinal,action,from_status,to_status,worker_id,lease_until,retry_at,error_code,
       edge_offset,edge_source_offset,transition_event_id,idempotency_key,operation_digest,created_at
     ) values ($1,$2,0,'QUEUE',null,'PENDING',null,null,null,null,0,0,$3,$4,$5,$6)`,
    [transitionId, jobId, requestEvent.id, input.idempotencyKey, operationKey, input.observedAt],
  );
  await db.query(
    `insert into memory_graph_reconciliation_job_manifests (
       job_id,request_event_id,operation_key,body_digest,event_request_hash,
       event_integrity_hash,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7)`,
    [jobId, requestEvent.id, operationKey, header.body_digest, header.request_hash,
      header.integrity_hash, input.observedAt],
  );
  await db.query(
    `insert into memory_graph_reconciliation_job_transition_manifests (
       transition_id,job_id,transition_event_id,operation_digest,body_digest,
       event_request_hash,event_integrity_hash,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [transitionId, jobId, requestEvent.id, operationKey, header.body_digest,
      header.request_hash, header.integrity_hash, input.observedAt],
  );
  return Object.freeze({ status: "QUEUED", reconciliationRunId: null,
    backgroundJobId: jobId, currentMemoryIds: Object.freeze([]),
    edges: Object.freeze([]), conflicts: Object.freeze([]) });
}

export async function versionMemoryGraph(
  context: MemoryGraphWriterContext,
  rawInput: unknown,
): Promise<VersionMemoryGraphResult> {
  if (!context || typeof context !== "object" || !writerContexts.has(context)) {
    throw new Error("MEMORY_GRAPH_CONTEXT_INVALID");
  }
  const captured = captureGraphInput(rawInput);
  return context.db.transaction(async (db) => {
    const requestShapeDigest = graphRequestShapeDigest(captured);
    await revalidateMemoryGraphWriteAuthority(db, captured);
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-graph-idempotency:${captured.idempotencyKey}`,
    ]);
    const byKey = (await db.query<ExistingRunRow>(
      `select run.id::text,key.request_digest,key.request_shape_digest
       from memory_graph_idempotency_keys key
       join memory_graph_reconciliation_runs run on run.id=key.reconciliation_run_id
       where key.idempotency_key=$1`,
      [captured.idempotencyKey],
    ))[0];
    if (byKey) {
      if (byKey.request_shape_digest !== requestShapeDigest) {
        throw new Error("MEMORY_GRAPH_IDEMPOTENCY_KEY_REUSED");
      }
      let replayResolved: ResolvedMemoryGraphInput;
      try {
        replayResolved = await resolveAuthoritativeInput(db, captured);
      } catch (error) {
        if (error instanceof Error && error.message === "EVENT_KEY_UNAVAILABLE") {
          throw new Error("MEMORY_GRAPH_REPLAY_UNAVAILABLE");
        }
        throw error;
      }
      const replayOperationKey = graphOperationKey(replayResolved);
      const replayRequestDigest = canonicalContentDigest({
        operationKey: replayOperationKey,
        idempotencyKey: replayResolved.idempotencyKey,
      });
      if (byKey.request_digest !== replayRequestDigest) {
        throw new Error("MEMORY_GRAPH_IDEMPOTENCY_KEY_REUSED");
      }
      return loadGraphRun(db, byKey.id);
    }
    const queuedByKey = (await db.query<{
      id: string; operation_key: string; request_shape_digest: string; request_digest: string;
    } & Record<string, unknown>>(
      `select job.id::text,key.operation_key,key.request_shape_digest,key.request_digest
       from memory_graph_reconciliation_job_idempotency_keys key
       join memory_graph_reconciliation_jobs job on job.id=key.job_id
       where key.idempotency_key=$1`,
      [captured.idempotencyKey],
    ))[0];
    if (queuedByKey) {
      if (queuedByKey.request_shape_digest !== requestShapeDigest) {
        throw new Error("MEMORY_GRAPH_IDEMPOTENCY_KEY_REUSED");
      }
      const queuedResolved = await resolveAuthoritativeInput(db, captured);
      const queuedOperationKey = graphOperationKey(queuedResolved);
      const queuedRequestDigest = canonicalContentDigest({
        operationKey: queuedOperationKey, idempotencyKey: queuedResolved.idempotencyKey,
      });
      if (queuedOperationKey !== queuedByKey.operation_key
        || queuedRequestDigest !== queuedByKey.request_digest) {
        throw new Error("MEMORY_GRAPH_IDEMPOTENCY_KEY_REUSED");
      }
      return loadQueuedMemoryGraphReconciliation(db, queuedByKey.id);
    }
    const resolved = await resolveAuthoritativeInput(db, captured);
    const operationKey = graphOperationKey(resolved);
    const requestDigest = canonicalContentDigest({
      operationKey,
      idempotencyKey: resolved.idempotencyKey,
    });
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-graph-operation:${operationKey}`,
    ]);
    const byOperation = (await db.query<ExistingRunRow>(
      `select id::text,request_digest from memory_graph_reconciliation_runs
       where operation_key=$1`,
      [operationKey],
    ))[0];
    if (byOperation) {
      await db.query(
        `insert into memory_graph_idempotency_keys (
           idempotency_key,reconciliation_run_id,operation_key,request_digest,
           request_shape_digest,created_at
         ) values ($1,$2,$3,$4,$5,clock_timestamp())`,
        [resolved.idempotencyKey, byOperation.id, operationKey, requestDigest, requestShapeDigest],
      );
      return loadGraphRun(db, byOperation.id);
    }
    const queuedByOperation = (await db.query<{ id: string } & Record<string, unknown>>(
      `select id::text from memory_graph_reconciliation_jobs where operation_key=$1`,
      [operationKey],
    ))[0];
    if (queuedByOperation) {
      await db.query(
        `insert into memory_graph_reconciliation_job_idempotency_keys (
         idempotency_key,job_id,operation_key,request_digest,request_shape_digest,created_at
         ) values ($1,$2,$3,$4,$5,date_trunc('milliseconds',transaction_timestamp()))`,
        [resolved.idempotencyKey, queuedByOperation.id, operationKey, requestDigest,
          requestShapeDigest],
      );
      return loadQueuedMemoryGraphReconciliation(db, queuedByOperation.id);
    }
    const groupKeys = [...new Set(resolved.claims.map(
      ({ entityId, predicateDigest }) => `${entityId}:${predicateDigest}`,
    ))].sort();
    await db.query(
      `select pg_advisory_xact_lock(hashtextextended(lock_key,0))
       from unnest($1::text[]) lock_key order by lock_key`,
      [groupKeys.map((key) => `memory-graph-head:${key}`)],
    );
    const storedHeads = groupKeys.length === 0 ? [] : await db.query<{
      memory_id: string; entity_id: string; node_type: MemoryGraphNodeType;
      predicate_digest: string; value_digest: string; public_predicate: string | null;
      public_value: string | null; approved: boolean; valid_from: Date; valid_to: Date | null;
      source_ids: string[];
    } & Record<string, unknown>>(
      `select node.memory_id::text,node.entity_id::text,node.node_type,node.predicate_digest,
              node.value_digest,node.public_predicate,node.public_value,node.approved,
              node.valid_from,node.valid_to,
              array_agg(source.source_event_id::text order by source.ordinal) source_ids
       from memory_graph_current_heads head
       join memory_graph_nodes node on node.memory_id=head.memory_id
       join memory_graph_node_sources source on source.memory_id=node.memory_id
       where node.entity_id=any($1::uuid[]) and node.predicate_digest=any($2::text[])
       group by node.memory_id,node.entity_id,node.node_type,node.predicate_digest,node.value_digest,
                node.public_predicate,node.public_value,node.approved,node.valid_from,node.valid_to
       order by node.entity_id,node.predicate_digest,node.memory_id`,
      [resolved.claims.map(({ entityId }) => entityId),
        resolved.claims.map(({ predicateDigest }) => predicateDigest)],
    );
    const requestedIds = new Set(resolved.claims.map(({ memoryId }) => memoryId));
    const priorClaims: ResolvedMemoryGraphClaim[] = storedHeads.filter((row) => (
      groupKeys.includes(`${row.entity_id}:${row.predicate_digest}`) && !requestedIds.has(row.memory_id)
    )).map((row) => Object.freeze({
      memoryId: row.memory_id, entityId: row.entity_id, nodeType: row.node_type,
      predicate: "[stored]", value: "[stored]", predicateDigest: row.predicate_digest,
      valueDigest: row.value_digest, publicPredicate: row.public_predicate,
      publicValue: row.public_value, approved: row.approved,
      validFrom: row.valid_from.toISOString(), validTo: row.valid_to?.toISOString() ?? null,
      sourceIds: Object.freeze(row.source_ids),
    }));
    const input: ResolvedMemoryGraphInput = Object.freeze({
      ...resolved, claims: Object.freeze([...priorClaims, ...resolved.claims]),
    });
    const groups = reconciliationGroups(input);

    const runId = randomUUID();
    const generatedEdgeDrafts = groups.flatMap(({ claims, result }) => result.edges.map((edge) => {
      const source = claims.find(({ memoryId }) => memoryId === edge.from)!;
      const target = claims.find(({ memoryId }) => memoryId === edge.to)!;
      const sourceIds = [...new Set([...source.sourceIds, ...target.sourceIds])].sort();
      const interval = edge.type === "CONTRADICTS"
        ? intersectValidity(source, target)
        : { validFrom: source.validFrom, validTo: source.validTo };
      return Object.freeze({ edge: { ...edge, ...interval }, source, target, sourceIds });
    }));
    const conflictDrafts = groups.flatMap(({ claims, result }) => result.conflicts.map((conflict) => {
      const newer = claims.find(({ memoryId }) => memoryId === conflict.newer)!;
      const older = claims.find(({ memoryId }) => memoryId === conflict.older)!;
      return Object.freeze({ conflict, newer, older });
    }));
    const supportWork = estimateSupportWork(input);
    const durableRelationshipCount = await estimateDurableRelationshipCount(db, input);
    const estimatedEdgeCount = generatedEdgeDrafts.length + supportWork.edges
      + durableRelationshipCount;
    const generatedSourceWork = generatedEdgeDrafts.reduce(
      (count, { sourceIds }) => count + sourceIds.length, 0,
    );
    const estimatedEdgeSourceCount = generatedSourceWork + supportWork.sources
      + durableRelationshipCount * maximumPairSourceCount(input);
    const estimatedMaterializationRows = estimateMaterializationRows(input, groups.length);
    if (estimatedEdgeCount > MAX_GRAPH_EDGES) {
      throw new Error("MEMORY_GRAPH_EDGE_LIMIT_EXCEEDED");
    }
    if (estimatedEdgeCount > MAX_SYNCHRONOUS_EDGES
      || estimatedEdgeSourceCount > MAX_SYNCHRONOUS_EDGE_SOURCES
      || estimatedMaterializationRows > MAX_SYNCHRONOUS_MATERIALIZATION_ROWS) {
      return enqueueMemoryGraphReconciliation(db, input, operationKey, requestDigest,
        requestShapeDigest, estimatedEdgeCount, estimatedEdgeSourceCount,
        estimatedMaterializationRows);
    }
    const derivedEdgeDrafts = await deriveAuthoritativeRelationships(db, input);
    const edgeDrafts = [...generatedEdgeDrafts, ...derivedEdgeDrafts];
    const aliasCount = input.entities.reduce((count, entity) => count + entity.aliases.length, 0);
    const currentMemoryIdSet = new Set(groups.map(({ result }) => result.current.id));
    const relationships = edgeDrafts.map((draft) => ({
      ...draft.edge, sourceIds: draft.sourceIds,
    })).sort((left, right) => (
      left.from.localeCompare(right.from) || left.type.localeCompare(right.type)
        || left.to.localeCompare(right.to) || left.validFrom.localeCompare(right.validFrom)
    ));
    const conflicts = conflictDrafts.map(({ conflict, newer }) => ({
      newer: conflict.newer, older: conflict.older, preferred: conflict.preferred,
      entityId: newer.entityId, predicateDigest: newer.predicateDigest,
      sourceIds: conflict.sourceIds,
    })).sort((left, right) => (
      left.newer.localeCompare(right.newer) || left.older.localeCompare(right.older)
        || left.predicateDigest.localeCompare(right.predicateDigest)
    ));
    const currentMemoryIds = input.claims
      .filter(({ memoryId }) => currentMemoryIdSet.has(memoryId)).map(({ memoryId }) => memoryId);
    const graphSourceIds = [...new Set(input.claims.flatMap(({ sourceIds }) => sourceIds))].sort();
    const graphEvent = await appendEvent(db, {
      aggregateId: input.conversationId ?? `memory-graph:${input.scope}`,
      ...(input.accountId === null ? {} : { accountId: input.accountId }),
      actor: { type: "SYSTEM", id: "memory-graph-reconciler" },
      type: "memory.edge.versioned",
      visibility: input.scope === "PUBLIC" ? "PUBLIC"
        : input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH"
          ? "PRIVATE_ACCOUNT" : input.scope === "AUDIT_ONLY" ? "OPERATOR" : "SHARED",
      body: JSON.parse(JSON.stringify({
        run: { id: runId, operationKey, scope: input.scope, accountId: input.accountId,
          nodeBrainId: input.nodeBrainId, conversationId: input.conversationId,
          reconcilerVersion: input.reconcilerVersion, observedAt: input.observedAt },
        counts: { candidates: input.claims.length, entities: input.entities.length,
          aliases: aliasCount, relationships: relationships.length, conflicts: conflicts.length,
          current: currentMemoryIds.length },
        digests: { candidates: canonicalContentDigest(input.claims.map(({ memoryId }) => memoryId)),
          sources: canonicalContentDigest(graphSourceIds),
          current: canonicalContentDigest(currentMemoryIds),
          relationships: canonicalContentDigest(relationships),
          conflicts: canonicalContentDigest(conflicts) },
      })) as JsonValue,
      idempotencyKey: `memory-graph-event:${operationKey}`,
      occurredAt: new Date(input.observedAt),
      policyVersion: "memory-graph-v1",
    });
    const graphEventHeader = await db.one<{
      request_hash: string; integrity_hash: string; body_digest: string;
    } & Record<string, unknown>>(
      `select event.request_hash,event.integrity_hash,body.body_digest
       from events event join encrypted_event_bodies body on body.event_id=event.id
       where event.id=$1`,
      [graphEvent.id],
    );
    await db.query(
      `insert into memory_graph_reconciliation_runs (
         id,operation_key,idempotency_key,request_digest,scope,account_id,node_brain_id,
         conversation_id,reconciler_version,observed_at,candidate_count,entity_count,
         alias_count,edge_count,conflict_count,current_count,graph_event_id,
         graph_event_request_hash,graph_event_integrity_hash,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$10)`,
      [runId, operationKey, input.idempotencyKey, requestDigest, input.scope, input.accountId,
        input.nodeBrainId, input.conversationId, input.reconcilerVersion, input.observedAt,
        input.claims.length, input.entities.length, aliasCount, edgeDrafts.length,
        conflictDrafts.length, groups.length, graphEvent.id, graphEventHeader.request_hash,
        graphEventHeader.integrity_hash],
    );
    await db.query(
      `insert into memory_graph_idempotency_keys (
         idempotency_key,reconciliation_run_id,operation_key,request_digest,
         request_shape_digest,created_at
       ) values ($1,$2,$3,$4,$5,$6)`,
      [input.idempotencyKey, runId, operationKey, requestDigest, requestShapeDigest, input.observedAt],
    );
    await db.query(
      `select pg_advisory_xact_lock(hashtextextended(lock_key,0))
       from unnest($1::text[]) lock_key order by lock_key`,
      [input.entities.map(({ id }) => `memory-graph-entity:${id}`).sort()],
    );
    const priorVersions = await db.query<{
      entity_id: string; id: string;
    } & Record<string, unknown>>(
      `select distinct on (entity_id) entity_id::text,id::text
       from memory_graph_entity_versions where entity_id=any($1::uuid[])
       order by entity_id,append_ordinal desc`, [input.entities.map(({ id }) => id)],
    );
    const priorVersionByEntity = new Map(priorVersions.map((row) => [row.entity_id, row.id]));
    const entityRows = input.entities.map((entity, ordinal) => ({
      ordinal, id: entity.id, type: entity.type, canonicalDigest: entity.canonicalDigest,
      publicLabel: entity.publicLabel, validFrom: entity.validFrom, validTo: entity.validTo,
      versionId: uuidFromDigest(canonicalContentDigest({ runId, entityId: entity.id,
        validFrom: entity.validFrom, validTo: entity.validTo })),
      supersedesVersionId: priorVersionByEntity.get(entity.id) ?? null,
    }));
    await db.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
         id uuid,type text,"canonicalDigest" text,"publicLabel" text))
       insert into memory_graph_entities (
         id,first_reconciliation_run_id,type,scope,account_id,node_brain_id,conversation_id,
         canonical_digest,public_label,created_at
       ) select item.id,$2,item.type,$3,$4,$5,$6,item."canonicalDigest",item."publicLabel",$7
         from input item on conflict (id) do nothing`,
      [JSON.stringify(entityRows), runId, input.scope, input.accountId, input.nodeBrainId,
        input.conversationId, input.observedAt],
    );
    const matchedEntities = await db.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
         id uuid,type text,"canonicalDigest" text,"publicLabel" text))
       select entity.id from input item join memory_graph_entities entity on entity.id=item.id
        and entity.type=item.type and entity.scope=$2
        and entity.account_id is not distinct from $3::uuid
        and entity.node_brain_id is not distinct from $4::uuid
        and entity.conversation_id is not distinct from $5::uuid
        and entity.canonical_digest=item."canonicalDigest"
        and entity.public_label is not distinct from item."publicLabel"`,
      [JSON.stringify(entityRows), input.scope, input.accountId, input.nodeBrainId,
        input.conversationId],
    );
    if (matchedEntities.length !== entityRows.length) {
      throw new Error("MEMORY_GRAPH_ENTITY_ID_CONFLICT");
    }
    await db.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
         ordinal int,id uuid,"versionId" uuid,"validFrom" timestamptz,"validTo" timestamptz,
         "supersedesVersionId" uuid))
       insert into memory_graph_entity_versions (
         id,entity_id,reconciliation_run_id,valid_from,valid_to,
         supersedes_entity_version_id,created_at
       ) select item."versionId",item.id,$2,item."validFrom",item."validTo",
                item."supersedesVersionId",$3 from input item`,
      [JSON.stringify(entityRows), runId, input.observedAt],
    );
    await db.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb)
         as item(ordinal int,id uuid,"versionId" uuid))
       insert into memory_graph_run_entities(reconciliation_run_id,entity_id,entity_version_id,ordinal)
       select $2,item.id,item."versionId",item.ordinal from input item`,
      [JSON.stringify(entityRows), runId],
    );
    const flatAliases = input.entities.flatMap((entity) => entity.aliases.map((alias) => ({
      entityId: entity.id, ...alias,
    })));
    const priorAliases = flatAliases.length === 0 ? [] : await db.query<{
      entity_id: string; alias_digest: string; id: string;
    } & Record<string, unknown>>(
      `select distinct on (entity_id,alias_digest) entity_id::text,alias_digest,id::text
       from memory_graph_entity_aliases
       where entity_id=any($1::uuid[]) and alias_digest=any($2::text[])
       order by entity_id,alias_digest,append_ordinal desc`,
      [input.entities.map(({ id }) => id), flatAliases.map(({ digest }) => digest)],
    );
    const priorAliasByKey = new Map(priorAliases.map((row) => (
      [`${row.entity_id}:${row.alias_digest}`, row.id]
    )));
    const aliasRows = flatAliases.map((alias, ordinal) => {
      const sourceDigest = canonicalContentDigest({ sourceIds: alias.sourceIds });
      const key = `${alias.entityId}:${alias.digest}`;
      const id = uuidFromDigest(canonicalContentDigest({ runId, entityId: alias.entityId,
        digest: alias.digest, validFrom: alias.validFrom, sourceDigest }));
      const row = { ordinal, id, entityId: alias.entityId, aliasDigest: alias.digest,
        sourceDigest, publicAlias: alias.publicAlias, validFrom: alias.validFrom,
        validTo: alias.validTo, sourceCount: alias.sourceIds.length,
        supersedesAliasId: priorAliasByKey.get(key) ?? null, sourceIds: alias.sourceIds };
      priorAliasByKey.set(key, id);
      return row;
    });
    if (aliasRows.length > 0) {
      await db.query(
        `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
           ordinal int,id uuid,"entityId" uuid,"aliasDigest" text,"sourceDigest" text,
           "publicAlias" text,"validFrom" timestamptz,"validTo" timestamptz,
           "sourceCount" int,"supersedesAliasId" uuid))
         insert into memory_graph_entity_aliases (
           id,first_reconciliation_run_id,entity_id,scope,account_id,node_brain_id,
           conversation_id,alias_digest,source_digest,public_alias,valid_from,valid_to,
           source_count,supersedes_alias_id,created_at
         ) select item.id,$2,item."entityId",$3,$4,$5,$6,item."aliasDigest",
                  item."sourceDigest",item."publicAlias",item."validFrom",item."validTo",
                  item."sourceCount",item."supersedesAliasId",$7 from input item`,
        [JSON.stringify(aliasRows), runId, input.scope, input.accountId, input.nodeBrainId,
          input.conversationId, input.observedAt],
      );
      await db.query(
        `with input as (select * from jsonb_to_recordset($1::jsonb)
           as item(ordinal int,id uuid))
         insert into memory_graph_run_aliases(reconciliation_run_id,alias_id,ordinal)
         select $2,item.id,item.ordinal from input item`, [JSON.stringify(aliasRows), runId],
      );
      await db.query(
        `with input as (select * from jsonb_to_recordset($1::jsonb)
           as item(id uuid,"sourceIds" jsonb))
         insert into memory_graph_alias_sources(alias_id,ordinal,source_event_id)
         select item.id,(source.position-1)::int,source.value::uuid from input item
         cross join lateral jsonb_array_elements_text(item."sourceIds")
           with ordinality source(value,position)
         on conflict (alias_id,source_event_id) do nothing`, [JSON.stringify(aliasRows)],
      );
    }
    const nodeRows = input.claims.map((claim, ordinal) => ({
      ordinal, memoryId: claim.memoryId, entityId: claim.entityId, nodeType: claim.nodeType,
      predicateDigest: claim.predicateDigest, valueDigest: claim.valueDigest,
      publicPredicate: claim.publicPredicate, publicValue: claim.publicValue,
      approved: claim.approved, validFrom: claim.validFrom, validTo: claim.validTo,
      sourceCount: claim.sourceIds.length, sourceIds: claim.sourceIds,
    }));
    await db.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
         ordinal int,"memoryId" uuid,"entityId" uuid,"nodeType" text,
         "predicateDigest" text,"valueDigest" text,"publicPredicate" text,
         "publicValue" text,approved boolean,"validFrom" timestamptz,"validTo" timestamptz,
         "sourceCount" int))
       insert into memory_graph_nodes (
         memory_id,first_reconciliation_run_id,entity_id,node_type,scope,account_id,node_brain_id,
         conversation_id,predicate_digest,value_digest,public_predicate,public_value,approved,
         valid_from,valid_to,source_count,created_at
       ) select item."memoryId",$2,item."entityId",item."nodeType",$3,$4,$5,$6,
                item."predicateDigest",item."valueDigest",item."publicPredicate",
                item."publicValue",item.approved,item."validFrom",item."validTo",
                item."sourceCount",$7 from input item on conflict (memory_id) do nothing`,
      [JSON.stringify(nodeRows), runId, input.scope, input.accountId, input.nodeBrainId,
        input.conversationId, input.observedAt],
    );
    const matchedNodes = await db.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb) as item(
         "memoryId" uuid,"entityId" uuid,"nodeType" text,"predicateDigest" text,
         "valueDigest" text,"publicPredicate" text,"publicValue" text,approved boolean,
         "validFrom" timestamptz,"validTo" timestamptz,"sourceCount" int))
       select node.memory_id from input item join memory_graph_nodes node
         on node.memory_id=item."memoryId" and node.entity_id=item."entityId"
        and node.node_type=item."nodeType" and node.scope=$2
        and node.account_id is not distinct from $3::uuid
        and node.node_brain_id is not distinct from $4::uuid
        and node.conversation_id is not distinct from $5::uuid
        and node.predicate_digest=item."predicateDigest" and node.value_digest=item."valueDigest"
        and node.public_predicate is not distinct from item."publicPredicate"
        and node.public_value is not distinct from item."publicValue"
        and node.approved=item.approved and node.valid_from=item."validFrom"
        and node.valid_to is not distinct from item."validTo"
        and node.source_count=item."sourceCount"`,
      [JSON.stringify(nodeRows), input.scope, input.accountId, input.nodeBrainId,
        input.conversationId],
    );
    if (matchedNodes.length !== nodeRows.length) throw new Error("MEMORY_GRAPH_NODE_ID_CONFLICT");
    await db.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb)
         as item(ordinal int,"memoryId" uuid))
       insert into memory_graph_run_candidates(reconciliation_run_id,memory_id,ordinal)
       select $2,item."memoryId",item.ordinal from input item`, [JSON.stringify(nodeRows), runId],
    );
    await db.query(
      `with input as (select * from jsonb_to_recordset($1::jsonb)
         as item("memoryId" uuid,"sourceIds" jsonb))
       insert into memory_graph_node_sources(memory_id,ordinal,source_event_id)
       select item."memoryId",(source.position-1)::int,source.value::uuid from input item
       cross join lateral jsonb_array_elements_text(item."sourceIds")
         with ordinality source(value,position)
       on conflict (memory_id,source_event_id) do nothing`, [JSON.stringify(nodeRows)],
    );

    for (const group of groups) {
      const claim = group.claims.find(({ memoryId }) => memoryId === group.result.current.id)!;
      await db.query(
        `insert into memory_graph_current_claims (
           reconciliation_run_id,memory_id,entity_id,predicate_digest
         ) values ($1,$2,$3,$4)`,
        [runId, claim.memoryId, claim.entityId, claim.predicateDigest],
      );
      const priorHead = (await db.query<{ id: string } & Record<string, unknown>>(
        `select id::text from memory_graph_current_heads
         where entity_id=$1 and predicate_digest=$2`,
        [claim.entityId, claim.predicateDigest],
      ))[0];
      const headId = uuidFromDigest(canonicalContentDigest({
        runId, entityId: claim.entityId, predicateDigest: claim.predicateDigest,
        memoryId: claim.memoryId,
      }));
      await db.query(
        `insert into memory_graph_head_versions (
           id,reconciliation_run_id,entity_id,predicate_digest,memory_id,
           supersedes_head_version_id,created_at
         ) values ($1,$2,$3,$4,$5,$6,$7)`,
        [headId, runId, claim.entityId, claim.predicateDigest, claim.memoryId,
          priorHead?.id ?? null, input.observedAt],
      );
    }

    const edgeRows = edgeDrafts.map((draft) => ({
      id: uuidFromDigest(canonicalContentDigest({
        from: draft.edge.from, type: draft.edge.type, to: draft.edge.to,
        validFrom: draft.edge.validFrom,
      })),
      sourceMemoryId: draft.edge.from, targetMemoryId: draft.edge.to, type: draft.edge.type,
      validFrom: draft.edge.validFrom, validTo: draft.edge.validTo,
      sourceIds: draft.sourceIds,
    }));
    if (edgeRows.length > 0) {
      await db.query(
        `with input as (
           select * from jsonb_to_recordset($1::jsonb) as item(
             id uuid,"sourceMemoryId" uuid,"targetMemoryId" uuid,type text,
             "validFrom" timestamptz,"validTo" timestamptz,"sourceIds" jsonb
           )
         ) insert into memory_graph_edges (
           id,source_memory_id,target_memory_id,type,scope,account_id,node_brain_id,
           conversation_id,valid_from,valid_to,created_at,first_reconciliation_run_id,source_count
         ) select item.id,item."sourceMemoryId",item."targetMemoryId",item.type,$2,$3,$4,$5,
                  item."validFrom",item."validTo",$6,$7,jsonb_array_length(item."sourceIds")
           from input item
         on conflict (source_memory_id,target_memory_id,type,valid_from) do nothing`,
        [JSON.stringify(edgeRows), input.scope, input.accountId, input.nodeBrainId,
          input.conversationId, input.observedAt, runId],
      );
      await db.query(
        `with input as (
           select * from jsonb_to_recordset($1::jsonb) as item(
             "sourceMemoryId" uuid,"targetMemoryId" uuid,type text,"validFrom" timestamptz
           )
         ) insert into memory_graph_run_edges(reconciliation_run_id,edge_id)
         select $2,edge.id from input item join memory_graph_edges edge
           on edge.source_memory_id=item."sourceMemoryId"
          and edge.target_memory_id=item."targetMemoryId" and edge.type=item.type
          and edge.valid_from=item."validFrom"
         on conflict do nothing`,
        [JSON.stringify(edgeRows), runId],
      );
      await db.query(
        `with input as (
           select * from jsonb_to_recordset($1::jsonb) as item(
             "sourceMemoryId" uuid,"targetMemoryId" uuid,type text,
             "validFrom" timestamptz,"sourceIds" jsonb
           )
         ) insert into memory_graph_edge_sources(edge_id,ordinal,source_event_id)
         select edge.id,(source.ordinality-1)::int,source.value::uuid
         from input item join memory_graph_edges edge
           on edge.source_memory_id=item."sourceMemoryId"
          and edge.target_memory_id=item."targetMemoryId" and edge.type=item.type
          and edge.valid_from=item."validFrom"
         cross join lateral jsonb_array_elements_text(item."sourceIds")
           with ordinality source(value,ordinality)
         on conflict (edge_id,source_event_id) do nothing`,
        [JSON.stringify(edgeRows)],
      );
    }

    const conflictRows = conflictDrafts.map((draft) => ({
      id: uuidFromDigest(canonicalContentDigest({
        newer: draft.conflict.newer,
        older: draft.conflict.older,
        predicateDigest: draft.newer.predicateDigest,
      })),
      newerMemoryId: draft.conflict.newer, olderMemoryId: draft.conflict.older,
      preferredMemoryId: draft.conflict.preferred, entityId: draft.newer.entityId,
      predicateDigest: draft.newer.predicateDigest, sourceIds: draft.conflict.sourceIds,
    }));
    if (conflictRows.length > 0) {
      await db.query(
        `with input as (
           select * from jsonb_to_recordset($1::jsonb) as item(
             id uuid,"newerMemoryId" uuid,"olderMemoryId" uuid,"preferredMemoryId" uuid,
             "entityId" uuid,"predicateDigest" text,"sourceIds" jsonb
           )
         ) insert into memory_conflicts (
           id,first_reconciliation_run_id,newer_memory_id,older_memory_id,preferred_memory_id,
           entity_id,predicate_digest,scope,account_id,node_brain_id,conversation_id,
           source_count,detected_at
         ) select item.id,$2,item."newerMemoryId",item."olderMemoryId",item."preferredMemoryId",
                  item."entityId",item."predicateDigest",$3,$4,$5,$6,
                  jsonb_array_length(item."sourceIds"),$7 from input item
         on conflict (newer_memory_id,older_memory_id,predicate_digest) do nothing`,
        [JSON.stringify(conflictRows), runId, input.scope, input.accountId, input.nodeBrainId,
          input.conversationId, input.observedAt],
      );
      await db.query(
        `with input as (
           select * from jsonb_to_recordset($1::jsonb) as item(
             "newerMemoryId" uuid,"olderMemoryId" uuid,"predicateDigest" text
           )
         ) insert into memory_graph_run_conflicts(reconciliation_run_id,conflict_id)
         select $2,conflict.id from input item join memory_conflicts conflict
           on conflict.newer_memory_id=item."newerMemoryId"
          and conflict.older_memory_id=item."olderMemoryId"
          and conflict.predicate_digest=item."predicateDigest"
         on conflict do nothing`,
        [JSON.stringify(conflictRows), runId],
      );
      await db.query(
        `with input as (
           select * from jsonb_to_recordset($1::jsonb) as item(
             "newerMemoryId" uuid,"olderMemoryId" uuid,"predicateDigest" text,"sourceIds" jsonb
           )
         ) insert into memory_conflict_sources(conflict_id,ordinal,source_event_id)
         select conflict.id,(source.ordinality-1)::int,source.value::uuid
         from input item join memory_conflicts conflict
           on conflict.newer_memory_id=item."newerMemoryId"
          and conflict.older_memory_id=item."olderMemoryId"
          and conflict.predicate_digest=item."predicateDigest"
         cross join lateral jsonb_array_elements_text(item."sourceIds")
           with ordinality source(value,ordinality)
         on conflict (conflict_id,source_event_id) do nothing`,
        [JSON.stringify(conflictRows)],
      );
    }
    const relationManifest = await db.one<{
      relation_count: number; relation_digest: string;
    } & Record<string, unknown>>(
      `select count(*)::int relation_count,
              memory_graph_relation_digest($1) relation_digest
       from memory_graph_run_edges where reconciliation_run_id=$1`,
      [runId],
    );
    await db.query(
      `insert into memory_graph_event_manifests (
         graph_event_id,reconciliation_run_id,memory_ids,source_event_ids,semantic_digest,
         relation_count,relation_digest,body_digest,event_request_hash,event_integrity_hash,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [graphEvent.id, runId, input.claims.map(({ memoryId }) => memoryId),
        graphSourceIds, operationKey,
        relationManifest.relation_count, relationManifest.relation_digest, graphEventHeader.body_digest,
        graphEventHeader.request_hash, graphEventHeader.integrity_hash, input.observedAt],
    );
    return loadGraphRun(db, runId);
  });
}

async function loadQueuedMemoryGraphReconciliation(
  db: EventDatabase,
  jobId: string,
): Promise<QueuedMemoryGraphResult> {
  const requestEventId = await assertMemoryGraphReconciliationJobEnvelope(db, jobId);
  try {
    await readEventBody(db, requestEventId, { actor: { role: "SYSTEM" } });
  } catch (error) {
    if (error instanceof Error && error.message === "EVENT_KEY_UNAVAILABLE") {
      throw new Error("MEMORY_GRAPH_REPLAY_UNAVAILABLE");
    }
    throw error;
  }
  return Object.freeze({ status: "QUEUED", reconciliationRunId: null,
    backgroundJobId: jobId, currentMemoryIds: Object.freeze([]),
    edges: Object.freeze([]), conflicts: Object.freeze([]) });
}

async function assertMemoryGraphReconciliationJobEnvelope(
  db: EventDatabase,
  jobId: string,
): Promise<string> {
  const rows = await db.query<{ request_event_id: string; exact: boolean } & Record<string, unknown>>(
    `select request_event_id::text,
            memory_graph_reconciliation_job_envelope_is_valid(id) exact
     from memory_graph_reconciliation_jobs where id=$1`, [jobId],
  );
  if (rows.length !== 1 || !rows[0]!.exact) {
    throw new Error("MEMORY_GRAPH_RECONCILIATION_EVENT_BODY_INVALID");
  }
  return rows[0]!.request_event_id;
}

export async function authorizeMemoryGraphTraversal(
  db: EventDatabase,
  actor: RecallActorInput,
): Promise<MemoryGraphTraversalContext> {
  const authorization = await authorizeRecall(db, actor);
  const context = Object.freeze({ db, authorization });
  traversalContexts.add(context);
  return context;
}

function captureTraversalInput(value: unknown): CapturedTraversalInput {
  const record = plainRecord(value, [
    "seedMemoryIds", "requestedDepth", "candidateLimit", "asOf", "idempotencyKey",
  ]);
  const seeds = denseArray(record.seedMemoryIds, MAX_GRAPH_SEEDS, "MEMORY_GRAPH_SEED_LIMIT_EXCEEDED")
    .map(uuid);
  if (seeds.length === 0 || new Set(seeds).size !== seeds.length) {
    invalid("MEMORY_GRAPH_SEED_INVALID");
  }
  if (!Number.isSafeInteger(record.requestedDepth) || (record.requestedDepth as number) < 1
    || (record.requestedDepth as number) > 32) invalid("MEMORY_GRAPH_DEPTH_INVALID");
  if (!Number.isSafeInteger(record.candidateLimit) || (record.candidateLimit as number) < 1
    || (record.candidateLimit as number) > MAX_GRAPH_CANDIDATES) {
    invalid("MEMORY_GRAPH_CANDIDATE_LIMIT_INVALID");
  }
  return Object.freeze({
    seedMemoryIds: Object.freeze(seeds),
    requestedDepth: record.requestedDepth as number,
    candidateLimit: record.candidateLimit as number,
    asOf: timestamp(record.asOf),
    idempotencyKey: text(record.idempotencyKey),
  });
}

function traversalAuthoritySql(context: RecallAuthorizationContext, alias: string) {
  const actor = context.actor;
  if (actor.role === "ACCOUNT") {
    return {
      clause: `(${alias}.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC') or
        (${alias}.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and ${alias}.account_id=$2
         and ${alias}.node_brain_id=$3 and ${alias}.conversation_id=$4))`,
      parameters: [actor.accountId, actor.nodeBrainId, actor.conversationId] as const,
    };
  }
  if (actor.role === "MAIN_BRAIN") {
    return {
      clause: `${alias}.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')`,
      parameters: [] as const,
    };
  }
  return {
    clause: `${alias}.scope=any($2::text[])`,
    parameters: [actor.scopes] as const,
  };
}

async function revalidateTraversalAuthority(
  db: EventDatabase,
  authorization: RecallAuthorizationContext,
): Promise<void> {
  const actor = authorization.actor;
  if (actor.role === "ACCOUNT") {
    const rows = await db.query(
      `/* memory-graph-authority-lock */
       select 1 from accounts account
       join entitlements entitlement on entitlement.account_id=account.id
         and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
         and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
       join node_brains node on node.account_id=account.id and node.id=$2 and node.status='ACTIVE'
       join conversations conversation on conversation.account_id=account.id
         and conversation.node_brain_id=node.id and conversation.id=$3 and conversation.status='OPEN'
       where account.id=$1 and account.status='ACTIVE'
       for update of account,entitlement,node,conversation`,
      [actor.accountId, actor.nodeBrainId, actor.conversationId],
    );
    if (rows.length !== 1) throw new Error("MEMORY_GRAPH_ACTOR_FORBIDDEN");
    return;
  }
  const rows = await db.query<{ scopes: MemoryScope[] } & Record<string, unknown>>(
    `/* memory-graph-authority-lock */
     select scopes from recall_actor_authorities
     where role=$1 and actor_id=$2 and active for update`,
    [actor.role, actor.actorId],
  );
  if (rows.length !== 1 || authorization.scopes.some((scope) => !rows[0]!.scopes.includes(scope))) {
    throw new Error("MEMORY_GRAPH_ACTOR_FORBIDDEN");
  }
}

export function graphTraversalContract() {
  return Object.freeze({
    maximumDepth: MAX_GRAPH_DEPTH,
    maximumCandidates: MAX_GRAPH_CANDIDATES,
    maximumSeeds: MAX_GRAPH_SEEDS,
    maximumAdjacencyQueries: MAX_GRAPH_DEPTH,
    deeperWork: "BACKGROUND_JOB" as const,
  });
}

export async function traverseMemoryGraph(
  context: MemoryGraphTraversalContext,
  rawInput: unknown,
): Promise<MemoryGraphTraversalResult> {
  if (!context || typeof context !== "object" || !traversalContexts.has(context)) {
    throw new Error("MEMORY_GRAPH_CONTEXT_INVALID");
  }
  const input = captureTraversalInput(rawInput);
  return context.db.transaction(async (db) => {
  await revalidateTraversalAuthority(db, context.authorization);
  const seedAuthority = traversalAuthoritySql(context.authorization, "memory");
  const seedRows = await db.query<{ id: string } & Record<string, unknown>>(
    `select memory.id::text from memory_records memory
     where memory.id=any($1::uuid[]) and ${seedAuthority.clause}
     order by memory.id`,
    [input.seedMemoryIds, ...seedAuthority.parameters],
  );
  if (seedRows.length !== input.seedMemoryIds.length) throw new Error("MEMORY_GRAPH_SEED_FORBIDDEN");
  const maximumDepthApplied = Math.min(input.requestedDepth, MAX_GRAPH_DEPTH);
  const edgeAuthority = traversalAuthoritySql(context.authorization, "edge");
  const visited = new Set(input.seedMemoryIds);
  const ordered = [...input.seedMemoryIds];
  let frontier = [...input.seedMemoryIds];
  let candidateOverflow = ordered.length > input.candidateLimit;
  const asOfPosition = 2 + edgeAuthority.parameters.length;
  const limitPosition = asOfPosition + 1;
  for (let depth = 1; depth <= maximumDepthApplied && frontier.length > 0
    && !candidateOverflow; depth += 1) {
    const adjacent = await db.query<{
      source_memory_id: string; target_memory_id: string;
    } & Record<string, unknown>>(
      `select source_memory_id::text,target_memory_id::text
       from (
         select edge.source_memory_id,edge.target_memory_id,edge.valid_from,edge.id
         from memory_graph_edges edge
         where edge.source_memory_id=any($1::uuid[])
           and edge.valid_from<=$${asOfPosition}::timestamptz
           and (edge.valid_to is null or edge.valid_to>$${asOfPosition}::timestamptz)
           and ${edgeAuthority.clause}
         union all
         select edge.source_memory_id,edge.target_memory_id,edge.valid_from,edge.id
         from memory_graph_edges edge
         where edge.target_memory_id=any($1::uuid[])
           and edge.valid_from<=$${asOfPosition}::timestamptz
           and (edge.valid_to is null or edge.valid_to>$${asOfPosition}::timestamptz)
           and ${edgeAuthority.clause}
       ) adjacency
       order by valid_from desc,id
       limit $${limitPosition}`,
      [frontier, ...edgeAuthority.parameters, input.asOf, input.candidateLimit + 1],
    );
    if (adjacent.length > input.candidateLimit) candidateOverflow = true;
    const frontierSet = new Set(frontier);
    const next: string[] = [];
    for (const edge of adjacent) {
      const candidates = [edge.source_memory_id, edge.target_memory_id]
        .filter((memoryId) => !frontierSet.has(memoryId));
      for (const memoryId of candidates) {
        if (visited.has(memoryId)) continue;
        if (ordered.length >= input.candidateLimit) {
          candidateOverflow = true;
          break;
        }
        visited.add(memoryId);
        ordered.push(memoryId);
        next.push(memoryId);
      }
      if (candidateOverflow) break;
    }
    frontier = next;
  }
  const depthOverflow = input.requestedDepth > MAX_GRAPH_DEPTH;
  const truncated = candidateOverflow || depthOverflow;
  const selected = Object.freeze(ordered.slice(0, input.candidateLimit));
  let backgroundJobId: string | null = null;
  if (truncated) {
    const actor = context.authorization.actor;
    const actorId = actor.role === "ACCOUNT" ? actor.accountId : actor.actorId;
    const accountId = actor.role === "ACCOUNT" ? actor.accountId : null;
    const nodeBrainId = actor.role === "ACCOUNT" ? actor.nodeBrainId : null;
    const conversationId = actor.role === "ACCOUNT" ? actor.conversationId : null;
    const operationKey = canonicalContentDigest({
      actor, scopes: context.authorization.scopes, input,
    });
    backgroundJobId = await db.transaction(async (db) => {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `memory-graph-background:${input.idempotencyKey}`,
      ]);
      const existing = (await db.query<{
        id: string; operation_key: string;
      } & Record<string, unknown>>(
        `select id::text,operation_key from memory_graph_background_jobs where idempotency_key=$1`,
        [input.idempotencyKey],
      ))[0];
      if (existing) {
        if (existing.operation_key !== operationKey) {
          throw new Error("MEMORY_GRAPH_BACKGROUND_IDEMPOTENCY_KEY_REUSED");
        }
        return existing.id;
      }
      const id = randomUUID();
      const transitionAt = (await db.one<{ at: Date } & Record<string, unknown>>(
        "select date_trunc('milliseconds',transaction_timestamp()) at",
      )).at;
      const queuedEvent = await appendEvent(db, {
        aggregateId: `memory-graph-job:${id}`,
        ...(accountId === null ? {} : { accountId }),
        actor: { type: "SYSTEM", id: "memory-graph-scheduler" },
        type: "memory.graph.background.queued",
        visibility: accountId === null ? "OPERATOR" : "PRIVATE_ACCOUNT",
        body: JSON.parse(JSON.stringify({
          jobId: id, operationKey, actorRole: actor.role, actorId, scopes: context.authorization.scopes,
          seedMemoryIds: input.seedMemoryIds, requestedDepth: input.requestedDepth,
          candidateLimit: input.candidateLimit, asOf: input.asOf,
        })) as JsonValue,
        idempotencyKey: `memory-graph-job-event:${input.idempotencyKey}:${operationKey}`,
        occurredAt: transitionAt,
      });
      await db.query(
        `insert into memory_graph_background_jobs (
           id,operation_key,idempotency_key,actor_role,actor_id,authorized_scopes,
           account_id,node_brain_id,conversation_id,seed_memory_ids,requested_depth,
           candidate_limit,as_of,reason,status,queued_event_id,created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PENDING',$15,$16)`,
        [id, operationKey, input.idempotencyKey, actor.role, actorId,
          context.authorization.scopes, accountId, nodeBrainId, conversationId,
          input.seedMemoryIds, input.requestedDepth, input.candidateLimit, input.asOf,
          candidateOverflow && depthOverflow ? "BOTH"
            : candidateOverflow ? "CANDIDATE_LIMIT" : "DEPTH_LIMIT", queuedEvent.id,
          transitionAt.toISOString()],
      );
      const pendingTransitionId = randomUUID();
      await db.query(
        `insert into memory_graph_background_job_transitions (
           id,job_id,ordinal,from_status,to_status,transition_event_id,
           idempotency_key,operation_digest,created_at
         ) values ($1,$2,0,null,'PENDING',$3,$4,$5,$6)`,
        [pendingTransitionId, id, queuedEvent.id, input.idempotencyKey, operationKey,
          transitionAt.toISOString()],
      );
      const queuedHeader = await db.one<{
        request_hash: string; integrity_hash: string; body_digest: string;
      } & Record<string, unknown>>(
        `select event.request_hash,event.integrity_hash,body.body_digest
         from events event join encrypted_event_bodies body on body.event_id=event.id
         where event.id=$1`, [queuedEvent.id],
      );
      await db.query(
        `insert into memory_graph_job_transition_manifests (
           transition_id,job_id,transition_event_id,operation_digest,body_digest,
           event_request_hash,event_integrity_hash,created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pendingTransitionId, id, queuedEvent.id, operationKey, queuedHeader.body_digest,
          queuedHeader.request_hash, queuedHeader.integrity_hash, transitionAt.toISOString()],
      );
      return id;
    });
  }
  return Object.freeze({
    memoryIds: selected,
    maximumDepthApplied,
    truncated,
    backgroundJobId,
  });
  });
}

interface BackgroundJobRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string | null;
  readonly node_brain_id: string | null;
  readonly conversation_id: string | null;
  readonly actor_role: "ACCOUNT" | "MAIN_BRAIN" | "SYSTEM" | "OPERATOR";
  readonly actor_id: string;
  readonly authorized_scopes: MemoryScope[];
}

interface JobTransitionRow extends Record<string, unknown> {
  readonly id: string;
  readonly ordinal: number;
  readonly to_status: "PENDING" | "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED";
  readonly worker_id: string | null;
  readonly lease_until: Date | null;
  readonly retry_at: Date | null;
  readonly operation_digest: string;
}

async function revalidateJobWorker(
  db: EventDatabase,
  context: MemoryGraphJobWorkerContext,
): Promise<void> {
  const rows = await db.query<{ purposes: string[] } & Record<string, unknown>>(
    `/* memory-graph-worker-authority-lock */
     select purposes from memory_graph_worker_authorities
     where actor_id=$1 and active for update`,
    [context.actorId],
  );
  if (rows.length !== 1 || !rows[0]!.purposes.includes(context.purpose)) {
    throw new Error("MEMORY_GRAPH_WORKER_FORBIDDEN");
  }
}

async function revalidateBackgroundJobActor(db: EventDatabase, job: BackgroundJobRow): Promise<void> {
  if (job.actor_role === "ACCOUNT") {
    const rows = await db.query(
      `/* memory-graph-job-actor-authority-lock */
       select 1 from accounts account
       join entitlements entitlement on entitlement.account_id=account.id
         and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
         and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
       join node_brains node on node.id=$2 and node.account_id=account.id and node.status='ACTIVE'
       join conversations conversation on conversation.id=$3 and conversation.account_id=account.id
         and conversation.node_brain_id=node.id and conversation.status='OPEN'
       where account.id=$1 and account.status='ACTIVE'
       for update of account,entitlement,node,conversation`,
      [job.account_id, job.node_brain_id, job.conversation_id],
    );
    if (rows.length !== 1) throw new Error("MEMORY_GRAPH_ACTOR_FORBIDDEN");
    return;
  }
  const rows = await db.query<{ scopes: MemoryScope[] } & Record<string, unknown>>(
    `/* memory-graph-job-actor-authority-lock */
     select scopes from recall_actor_authorities
     where role=$1 and actor_id=$2 and active for update`,
    [job.actor_role, job.actor_id],
  );
  if (rows.length !== 1 || job.authorized_scopes.some((scope) => !rows[0]!.scopes.includes(scope))) {
    throw new Error("MEMORY_GRAPH_ACTOR_FORBIDDEN");
  }
}

export async function authorizeMemoryGraphJobWorker(
  db: EventDatabase,
  rawInput: unknown,
): Promise<MemoryGraphJobWorkerContext> {
  const input = plainRecord(rawInput, ["actorId", "purpose"]);
  const context = Object.freeze({
    db,
    actorId: text(input.actorId, 128),
    purpose: text(input.purpose, 128),
  });
  await db.transaction((transaction) => revalidateJobWorker(transaction, context));
  jobWorkerContexts.add(context);
  return context;
}

function captureJobActionBase(rawInput: unknown, optional: readonly string[] = []) {
  const input = plainRecord(rawInput, ["jobId", "workerId", "at", "idempotencyKey"], optional);
  return Object.freeze({
    record: input,
    jobId: uuid(input.jobId),
    workerId: text(input.workerId, 128),
    at: timestamp(input.at),
    idempotencyKey: text(input.idempotencyKey),
  });
}

async function loadLockedJob(db: EventDatabase, jobId: string): Promise<BackgroundJobRow> {
  const rows = await db.query<BackgroundJobRow>(
    `select id::text,account_id::text,node_brain_id::text,conversation_id::text,
            actor_role,actor_id,authorized_scopes
     from memory_graph_background_jobs where id=$1 for update`,
    [jobId],
  );
  if (rows.length !== 1) throw new Error("MEMORY_GRAPH_JOB_NOT_FOUND");
  return rows[0]!;
}

async function latestJobTransition(db: EventDatabase, jobId: string): Promise<JobTransitionRow> {
  return db.one<JobTransitionRow>(
    `select id::text,ordinal,to_status,worker_id,lease_until,retry_at,operation_digest
     from memory_graph_background_job_transitions where job_id=$1
     order by ordinal desc limit 1 for update`,
    [jobId],
  );
}

async function replayedJobTransition(
  db: EventDatabase,
  idempotencyKey: string,
  operationDigest: string,
): Promise<MemoryGraphJobTransitionResult | null> {
  const rows = await db.query<{
    job_id: string; to_status: MemoryGraphJobTransitionResult["status"];
    operation_digest: string; body_exact: boolean;
  } & Record<string, unknown>>(
    `select transition.job_id::text,transition.to_status,transition.operation_digest,
            body.body_digest=memory_graph_expected_job_transition_body_digest(transition.id)
              and manifest.body_digest=body.body_digest body_exact
     from memory_graph_background_job_transitions transition
     join memory_graph_job_transition_manifests manifest on manifest.transition_id=transition.id
     join encrypted_event_bodies body on body.event_id=transition.transition_event_id
     where transition.idempotency_key=$1`,
    [idempotencyKey],
  );
  if (rows.length === 0) return null;
  if (!rows[0]!.body_exact) throw new Error("MEMORY_GRAPH_JOB_EVENT_BODY_INVALID");
  if (rows[0]!.operation_digest !== operationDigest) {
    throw new Error("MEMORY_GRAPH_JOB_IDEMPOTENCY_KEY_REUSED");
  }
  return Object.freeze({ jobId: rows[0]!.job_id, status: rows[0]!.to_status });
}

async function appendJobTransition(
  db: EventDatabase,
  context: MemoryGraphJobWorkerContext,
  job: BackgroundJobRow,
  prior: JobTransitionRow,
  input: {
    readonly workerId: string; readonly transitionAt: string; readonly idempotencyKey: string;
    readonly operationDigest: string;
  },
  status: MemoryGraphJobTransitionResult["status"],
  details: {
    readonly leaseUntil?: string; readonly retryAt?: string;
    readonly errorCode?: string; readonly resultMemoryIds?: readonly string[];
  } = {},
): Promise<MemoryGraphJobTransitionResult> {
  const event = await appendEvent(db, {
    aggregateId: `memory-graph-job:${job.id}`,
    ...(job.account_id === null ? {} : { accountId: job.account_id }),
    actor: { type: "SYSTEM", id: context.actorId },
    type: `memory.graph.background.${status.toLowerCase()}`,
    visibility: job.account_id === null ? "OPERATOR" : "PRIVATE_ACCOUNT",
    body: JSON.parse(JSON.stringify({
      jobId: job.id, fromStatus: prior.to_status, toStatus: status,
      workerId: input.workerId, ...details,
    })) as JsonValue,
    idempotencyKey: `memory-graph-job-event:${input.idempotencyKey}:${input.operationDigest}`,
    occurredAt: new Date(input.transitionAt),
  });
  const transitionId = randomUUID();
  await db.query(
    `insert into memory_graph_background_job_transitions (
       id,job_id,ordinal,from_status,to_status,worker_id,lease_until,retry_at,error_code,
       result_memory_ids,transition_event_id,idempotency_key,operation_digest,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [transitionId, job.id, prior.ordinal + 1, prior.to_status, status, input.workerId,
      details.leaseUntil ?? null, details.retryAt ?? null, details.errorCode ?? null,
      details.resultMemoryIds ?? null, event.id, input.idempotencyKey, input.operationDigest,
      input.transitionAt],
  );
  const header = await db.one<{
    request_hash: string; integrity_hash: string; body_digest: string;
  } & Record<string, unknown>>(
    `select event.request_hash,event.integrity_hash,body.body_digest
     from events event join encrypted_event_bodies body on body.event_id=event.id
     where event.id=$1`, [event.id],
  );
  await db.query(
    `insert into memory_graph_job_transition_manifests (
       transition_id,job_id,transition_event_id,operation_digest,body_digest,
       event_request_hash,event_integrity_hash,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [transitionId, job.id, event.id, input.operationDigest, header.body_digest,
      header.request_hash, header.integrity_hash, input.transitionAt],
  );
  return Object.freeze({ jobId: job.id, status });
}

async function assertJobResultAuthority(
  db: EventDatabase,
  job: BackgroundJobRow,
  memoryIds: readonly string[],
): Promise<void> {
  const rows = await db.query<{ id: string } & Record<string, unknown>>(
    `select id::text from memory_records memory where id=any($1::uuid[]) and (
       ($2::uuid is not null and (
         memory.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
         or (memory.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and memory.account_id=$2
           and memory.node_brain_id=$3 and memory.conversation_id=$4)
       ))
       or ($2::uuid is null and memory.scope=any($5::text[]))
     ) order by id`,
    [memoryIds, job.account_id, job.node_brain_id, job.conversation_id, job.authorized_scopes],
  );
  if (rows.length !== memoryIds.length) throw new Error("MEMORY_GRAPH_JOB_RESULT_FORBIDDEN");
}

export async function claimMemoryGraphBackgroundJob(
  context: MemoryGraphJobWorkerContext,
  rawInput: unknown,
): Promise<MemoryGraphJobTransitionResult> {
  if (!context || typeof context !== "object" || !jobWorkerContexts.has(context)) {
    throw new Error("MEMORY_GRAPH_WORKER_CONTEXT_INVALID");
  }
  const input = captureJobActionBase(rawInput, ["leaseUntil"]);
  const leaseUntil = timestamp(input.record.leaseUntil);
  const operationDigest = canonicalContentDigest({
    action: "CLAIM", jobId: input.jobId, workerId: input.workerId, leaseUntil,
  });
  return context.db.transaction(async (db) => {
    await revalidateJobWorker(db, context);
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-graph-job:${input.jobId}`,
    ]);
    const job = await loadLockedJob(db, input.jobId);
    await revalidateBackgroundJobActor(db, job);
    const replay = await replayedJobTransition(db, input.idempotencyKey, operationDigest);
    if (replay) return replay;
    const clock = await db.one<{ now: Date; transition_at: Date } & Record<string, unknown>>(
      "select clock_timestamp() now,date_trunc('milliseconds',transaction_timestamp()) transition_at",
    );
    if (new Date(leaseUntil) <= clock.now) invalid("MEMORY_GRAPH_JOB_LEASE_INVALID");
    const prior = await latestJobTransition(db, input.jobId);
    if (prior.to_status !== "PENDING"
      && !(prior.to_status === "RETRY_SCHEDULED"
        && prior.retry_at !== null && prior.retry_at <= clock.now)
      && !(prior.to_status === "CLAIMED"
        && prior.lease_until !== null && prior.lease_until <= clock.now)) {
      throw new Error("MEMORY_GRAPH_JOB_NOT_CLAIMABLE");
    }
    return appendJobTransition(db, context, job, prior,
      { ...input, transitionAt: clock.transition_at.toISOString(), operationDigest },
      "CLAIMED", { leaseUntil });
  });
}

export async function completeMemoryGraphBackgroundJob(
  context: MemoryGraphJobWorkerContext,
  rawInput: unknown,
): Promise<MemoryGraphJobTransitionResult> {
  if (!context || typeof context !== "object" || !jobWorkerContexts.has(context)) {
    throw new Error("MEMORY_GRAPH_WORKER_CONTEXT_INVALID");
  }
  const input = captureJobActionBase(rawInput, ["resultMemoryIds"]);
  const resultMemoryIds = stringSet(input.record.resultMemoryIds, MAX_GRAPH_CANDIDATES);
  const operationDigest = canonicalContentDigest({
    action: "COMPLETE", jobId: input.jobId, workerId: input.workerId, resultMemoryIds,
  });
  return context.db.transaction(async (db) => {
    await revalidateJobWorker(db, context);
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-graph-job:${input.jobId}`,
    ]);
    const job = await loadLockedJob(db, input.jobId);
    await revalidateBackgroundJobActor(db, job);
    const replay = await replayedJobTransition(db, input.idempotencyKey, operationDigest);
    if (replay) return replay;
    await assertJobResultAuthority(db, job, resultMemoryIds);
    const clock = await db.one<{ now: Date; transition_at: Date } & Record<string, unknown>>(
      "select clock_timestamp() now,date_trunc('milliseconds',transaction_timestamp()) transition_at",
    );
    const prior = await latestJobTransition(db, input.jobId);
    if (prior.to_status !== "CLAIMED" || prior.worker_id !== input.workerId
      || prior.lease_until === null || prior.lease_until <= clock.now) {
      throw new Error("MEMORY_GRAPH_JOB_NOT_OWNED");
    }
    return appendJobTransition(db, context, job, prior,
      { ...input, transitionAt: clock.transition_at.toISOString(), operationDigest },
      "COMPLETED", { resultMemoryIds });
  });
}

export async function failMemoryGraphBackgroundJob(
  context: MemoryGraphJobWorkerContext,
  rawInput: unknown,
): Promise<MemoryGraphJobTransitionResult> {
  if (!context || typeof context !== "object" || !jobWorkerContexts.has(context)) {
    throw new Error("MEMORY_GRAPH_WORKER_CONTEXT_INVALID");
  }
  const input = captureJobActionBase(rawInput, ["errorCode", "retryAt"]);
  const errorCode = text(input.record.errorCode, 128);
  const retryAt = input.record.retryAt === undefined ? undefined : timestamp(input.record.retryAt);
  const status = retryAt === undefined ? "FAILED" as const : "RETRY_SCHEDULED" as const;
  const operationDigest = canonicalContentDigest({
    action: "FAIL", jobId: input.jobId, workerId: input.workerId, errorCode,
    retryAt: retryAt ?? null,
  });
  return context.db.transaction(async (db) => {
    await revalidateJobWorker(db, context);
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-graph-job:${input.jobId}`,
    ]);
    const job = await loadLockedJob(db, input.jobId);
    await revalidateBackgroundJobActor(db, job);
    const replay = await replayedJobTransition(db, input.idempotencyKey, operationDigest);
    if (replay) return replay;
    const clock = await db.one<{ now: Date; transition_at: Date } & Record<string, unknown>>(
      "select clock_timestamp() now,date_trunc('milliseconds',transaction_timestamp()) transition_at",
    );
    if (retryAt !== undefined && new Date(retryAt) <= clock.now) {
      invalid("MEMORY_GRAPH_JOB_RETRY_INVALID");
    }
    const prior = await latestJobTransition(db, input.jobId);
    if (prior.to_status !== "CLAIMED" || prior.worker_id !== input.workerId
      || prior.lease_until === null || prior.lease_until <= clock.now) {
      throw new Error("MEMORY_GRAPH_JOB_NOT_OWNED");
    }
    return appendJobTransition(db, context, job, prior,
      { ...input, transitionAt: clock.transition_at.toISOString(), operationDigest },
      status, { errorCode, ...(retryAt ? { retryAt } : {}) });
  });
}

interface ReconciliationJobRow extends Record<string, unknown> {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly account_id: string | null;
  readonly node_brain_id: string | null;
  readonly conversation_id: string | null;
  readonly estimated_edge_count: number;
  readonly estimated_edge_source_count: number;
}

interface ReconciliationJobTransitionRow extends Record<string, unknown> {
  readonly ordinal: number;
  readonly to_status: "PENDING" | "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED";
  readonly worker_id: string | null;
  readonly lease_until: Date | null;
  readonly retry_at: Date | null;
  readonly edge_offset: number;
  readonly edge_source_offset: number;
}

async function loadLockedReconciliationJob(
  db: EventDatabase,
  jobId: string,
): Promise<ReconciliationJobRow> {
  const rows = await db.query<ReconciliationJobRow>(
    `select id::text,scope,account_id::text,node_brain_id::text,conversation_id::text,
            estimated_edge_count,estimated_edge_source_count
     from memory_graph_reconciliation_jobs where id=$1 for update`, [jobId],
  );
  if (rows.length !== 1) throw new Error("MEMORY_GRAPH_RECONCILIATION_JOB_NOT_FOUND");
  return rows[0]!;
}

async function revalidateReconciliationJobOwner(
  db: EventDatabase,
  job: ReconciliationJobRow,
): Promise<void> {
  if (job.account_id === null) return;
  const rows = await db.query(
    `select 1 from accounts account
     join entitlements entitlement on entitlement.account_id=account.id
       and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
       and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
     join node_brains node on node.id=$2 and node.account_id=account.id and node.status='ACTIVE'
     join conversations conversation on conversation.id=$3 and conversation.account_id=account.id
       and conversation.node_brain_id=node.id and conversation.status='OPEN'
     where account.id=$1 and account.status='ACTIVE'
     for update of account,entitlement,node,conversation`,
    [job.account_id, job.node_brain_id, job.conversation_id],
  );
  if (rows.length !== 1) throw new Error("MEMORY_GRAPH_RECONCILIATION_OWNER_FORBIDDEN");
}

async function latestReconciliationJobTransition(
  db: EventDatabase,
  jobId: string,
): Promise<ReconciliationJobTransitionRow> {
  return db.one<ReconciliationJobTransitionRow>(
    `select ordinal,to_status,worker_id,lease_until,retry_at,edge_offset,edge_source_offset
     from memory_graph_reconciliation_job_transitions where job_id=$1
     order by ordinal desc limit 1 for update`, [jobId],
  );
}

async function replayedReconciliationJobTransition(
  db: EventDatabase,
  idempotencyKey: string,
  operationDigest: string,
): Promise<MemoryGraphReconciliationJobTransitionResult | null> {
  const rows = await db.query<{
    job_id: string; to_status: MemoryGraphReconciliationJobTransitionResult["status"];
    operation_digest: string; edge_offset: number; edge_source_offset: number; exact: boolean;
  } & Record<string, unknown>>(
    `select transition.job_id::text,transition.to_status,transition.operation_digest,
            transition.edge_offset,transition.edge_source_offset,
            body.body_digest=memory_graph_expected_reconciliation_job_transition_body_digest(
              transition.id) and manifest.body_digest=body.body_digest exact
     from memory_graph_reconciliation_job_transitions transition
     join memory_graph_reconciliation_job_transition_manifests manifest
       on manifest.transition_id=transition.id
     join encrypted_event_bodies body on body.event_id=transition.transition_event_id
     where transition.idempotency_key=$1`, [idempotencyKey],
  );
  if (rows.length === 0) return null;
  if (!rows[0]!.exact) throw new Error("MEMORY_GRAPH_RECONCILIATION_EVENT_BODY_INVALID");
  if (rows[0]!.operation_digest !== operationDigest) {
    throw new Error("MEMORY_GRAPH_RECONCILIATION_IDEMPOTENCY_KEY_REUSED");
  }
  return Object.freeze({ jobId: rows[0]!.job_id, status: rows[0]!.to_status,
    cursor: Object.freeze({ edgeOffset: rows[0]!.edge_offset,
      edgeSourceOffset: rows[0]!.edge_source_offset }) });
}

async function appendReconciliationJobTransition(
  db: EventDatabase,
  context: MemoryGraphJobWorkerContext,
  job: ReconciliationJobRow,
  prior: ReconciliationJobTransitionRow,
  input: {
    readonly workerId: string; readonly idempotencyKey: string; readonly operationDigest: string;
    readonly transitionAt: string;
  },
  action: "CLAIM" | "PROGRESS" | "COMPLETE" | "FAIL",
  status: MemoryGraphReconciliationJobTransitionResult["status"],
  details: {
    readonly leaseUntil?: string; readonly retryAt?: string; readonly errorCode?: string;
    readonly edgeOffset: number; readonly edgeSourceOffset: number;
  },
): Promise<MemoryGraphReconciliationJobTransitionResult> {
  const body = action === "CLAIM" ? {
    jobId: job.id, fromStatus: prior.to_status, toStatus: status, workerId: input.workerId,
    leaseUntil: details.leaseUntil,
    cursor: { edgeOffset: details.edgeOffset, edgeSourceOffset: details.edgeSourceOffset },
  } : action === "FAIL" ? {
    jobId: job.id, fromStatus: prior.to_status, toStatus: status, workerId: input.workerId,
    errorCode: details.errorCode, retryAt: details.retryAt ?? null,
    cursor: { edgeOffset: details.edgeOffset, edgeSourceOffset: details.edgeSourceOffset },
  } : {
    jobId: job.id, fromStatus: prior.to_status, toStatus: status, workerId: input.workerId,
    cursor: { edgeOffset: details.edgeOffset, edgeSourceOffset: details.edgeSourceOffset },
  };
  const type = action === "CLAIM" ? "memory.graph.reconciliation.claimed"
    : action === "PROGRESS" ? "memory.graph.reconciliation.progressed"
      : action === "COMPLETE" ? "memory.graph.reconciliation.completed"
        : status === "RETRY_SCHEDULED" ? "memory.graph.reconciliation.retry_scheduled"
          : "memory.graph.reconciliation.failed";
  const event = await appendEvent(db, {
    aggregateId: job.conversation_id ?? `memory-graph:${job.scope}`,
    ...(job.account_id === null ? {} : { accountId: job.account_id }),
    actor: { type: "SYSTEM", id: context.actorId }, type,
    visibility: job.scope === "PUBLIC" ? "PUBLIC"
      : job.scope === "AUDIT_ONLY" ? "OPERATOR"
        : job.account_id === null ? "SHARED" : "PRIVATE_ACCOUNT",
    body: JSON.parse(JSON.stringify(body)) as JsonValue,
    idempotencyKey: `memory-graph-reconciliation-transition:${input.idempotencyKey}:${input.operationDigest}`,
    occurredAt: new Date(input.transitionAt),
  });
  const transitionId = randomUUID();
  await db.query(
    `insert into memory_graph_reconciliation_job_transitions (
       id,job_id,ordinal,action,from_status,to_status,worker_id,lease_until,retry_at,error_code,
       edge_offset,edge_source_offset,transition_event_id,idempotency_key,operation_digest,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [transitionId, job.id, prior.ordinal + 1, action, prior.to_status, status, input.workerId,
      details.leaseUntil ?? null, details.retryAt ?? null, details.errorCode ?? null,
      details.edgeOffset, details.edgeSourceOffset, event.id, input.idempotencyKey,
      input.operationDigest, input.transitionAt],
  );
  const header = await db.one<{
    request_hash: string; integrity_hash: string; body_digest: string;
  } & Record<string, unknown>>(
    `select event.request_hash,event.integrity_hash,body.body_digest
     from events event join encrypted_event_bodies body on body.event_id=event.id
     where event.id=$1`, [event.id],
  );
  await db.query(
    `insert into memory_graph_reconciliation_job_transition_manifests (
       transition_id,job_id,transition_event_id,operation_digest,body_digest,
       event_request_hash,event_integrity_hash,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [transitionId, job.id, event.id, input.operationDigest, header.body_digest,
      header.request_hash, header.integrity_hash, input.transitionAt],
  );
  return Object.freeze({ jobId: job.id, status, cursor: Object.freeze({
    edgeOffset: details.edgeOffset, edgeSourceOffset: details.edgeSourceOffset,
  }) });
}

function reconciliationJobActionBase(rawInput: unknown, optional: readonly string[] = []) {
  const record = plainRecord(rawInput, ["jobId", "workerId", "at", "idempotencyKey"], optional);
  return Object.freeze({ record, jobId: uuid(record.jobId), workerId: text(record.workerId, 128),
    at: timestamp(record.at), idempotencyKey: text(record.idempotencyKey) });
}

async function withLockedReconciliationJob<Result>(
  context: MemoryGraphJobWorkerContext,
  jobId: string,
  work: (db: EventDatabase, job: ReconciliationJobRow) => Promise<Result>,
): Promise<Result> {
  if (!context || typeof context !== "object" || !jobWorkerContexts.has(context)
    || context.purpose !== "RECONCILIATION") {
    throw new Error("MEMORY_GRAPH_WORKER_CONTEXT_INVALID");
  }
  return context.db.transaction(async (db) => {
    await revalidateJobWorker(db, context);
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-graph-reconciliation-job:${jobId}`,
    ]);
    const job = await loadLockedReconciliationJob(db, jobId);
    await revalidateReconciliationJobOwner(db, job);
    await assertMemoryGraphReconciliationJobEnvelope(db, job.id);
    return work(db, job);
  });
}

export async function claimMemoryGraphReconciliationJob(
  context: MemoryGraphJobWorkerContext,
  rawInput: unknown,
): Promise<MemoryGraphReconciliationJobTransitionResult> {
  const input = reconciliationJobActionBase(rawInput, ["leaseUntil"]);
  const leaseUntil = timestamp(input.record.leaseUntil);
  const operationDigest = canonicalContentDigest({ action: "CLAIM", jobId: input.jobId,
    workerId: input.workerId, leaseUntil });
  return withLockedReconciliationJob(context, input.jobId, async (db, job) => {
    const replay = await replayedReconciliationJobTransition(
      db, input.idempotencyKey, operationDigest,
    );
    if (replay) return replay;
    const clock = await db.one<{ now: Date; transition_at: Date } & Record<string, unknown>>(
      "select clock_timestamp() now,date_trunc('milliseconds',transaction_timestamp()) transition_at",
    );
    if (new Date(leaseUntil) <= clock.now) invalid("MEMORY_GRAPH_RECONCILIATION_LEASE_INVALID");
    const prior = await latestReconciliationJobTransition(db, job.id);
    if (prior.to_status !== "PENDING"
      && !(prior.to_status === "RETRY_SCHEDULED" && prior.retry_at !== null
        && prior.retry_at <= clock.now)
      && !(prior.to_status === "CLAIMED" && prior.lease_until !== null
        && prior.lease_until <= clock.now)) {
      throw new Error("MEMORY_GRAPH_RECONCILIATION_JOB_NOT_CLAIMABLE");
    }
    return appendReconciliationJobTransition(db, context, job, prior, {
      ...input, operationDigest, transitionAt: clock.transition_at.toISOString(),
    }, "CLAIM", "CLAIMED", { leaseUntil, edgeOffset: prior.edge_offset,
      edgeSourceOffset: prior.edge_source_offset });
  });
}

export async function progressMemoryGraphReconciliationJob(
  context: MemoryGraphJobWorkerContext,
  rawInput: unknown,
): Promise<MemoryGraphReconciliationJobTransitionResult> {
  const input = reconciliationJobActionBase(rawInput, ["edgeOffset", "edgeSourceOffset"]);
  const edgeOffset = wholeNumber(input.record.edgeOffset, MAX_GRAPH_EDGES);
  const edgeSourceOffset = wholeNumber(input.record.edgeSourceOffset, 358_400_000);
  const operationDigest = canonicalContentDigest({ action: "PROGRESS", jobId: input.jobId,
    workerId: input.workerId, edgeOffset, edgeSourceOffset });
  return withLockedReconciliationJob(context, input.jobId, async (db, job) => {
    const replay = await replayedReconciliationJobTransition(
      db, input.idempotencyKey, operationDigest,
    );
    if (replay) return replay;
    const clock = await db.one<{ now: Date; transition_at: Date } & Record<string, unknown>>(
      "select clock_timestamp() now,date_trunc('milliseconds',transaction_timestamp()) transition_at",
    );
    const prior = await latestReconciliationJobTransition(db, job.id);
    if (prior.to_status !== "CLAIMED" || prior.worker_id !== input.workerId
      || prior.lease_until === null || prior.lease_until <= clock.now
      || edgeOffset > job.estimated_edge_count
      || edgeSourceOffset > job.estimated_edge_source_count
      || (edgeOffset <= prior.edge_offset && edgeSourceOffset <= prior.edge_source_offset)) {
      throw new Error("MEMORY_GRAPH_RECONCILIATION_JOB_NOT_OWNED");
    }
    return appendReconciliationJobTransition(db, context, job, prior, {
      ...input, operationDigest, transitionAt: clock.transition_at.toISOString(),
    }, "PROGRESS", "CLAIMED", { leaseUntil: prior.lease_until.toISOString(),
      edgeOffset, edgeSourceOffset });
  });
}

export async function completeMemoryGraphReconciliationJob(
  context: MemoryGraphJobWorkerContext,
  rawInput: unknown,
): Promise<MemoryGraphReconciliationJobTransitionResult> {
  const input = reconciliationJobActionBase(rawInput);
  return withLockedReconciliationJob(context, input.jobId, async (db, job) => {
    const finalDigest = canonicalContentDigest({ action: "COMPLETE", jobId: input.jobId,
      workerId: input.workerId, edgeOffset: job.estimated_edge_count,
      edgeSourceOffset: job.estimated_edge_source_count });
    const replay = await replayedReconciliationJobTransition(db, input.idempotencyKey, finalDigest);
    if (replay) return replay;
    const clock = await db.one<{ now: Date; transition_at: Date } & Record<string, unknown>>(
      "select clock_timestamp() now,date_trunc('milliseconds',transaction_timestamp()) transition_at",
    );
    const prior = await latestReconciliationJobTransition(db, job.id);
    if (prior.to_status !== "CLAIMED" || prior.worker_id !== input.workerId
      || prior.lease_until === null || prior.lease_until <= clock.now
      || prior.edge_offset !== job.estimated_edge_count
      || prior.edge_source_offset !== job.estimated_edge_source_count) {
      throw new Error("MEMORY_GRAPH_RECONCILIATION_JOB_NOT_OWNED");
    }
    return appendReconciliationJobTransition(db, context, job, prior, {
      ...input, operationDigest: finalDigest, transitionAt: clock.transition_at.toISOString(),
    }, "COMPLETE", "COMPLETED", { edgeOffset: prior.edge_offset,
      edgeSourceOffset: prior.edge_source_offset });
  });
}

export async function failMemoryGraphReconciliationJob(
  context: MemoryGraphJobWorkerContext,
  rawInput: unknown,
): Promise<MemoryGraphReconciliationJobTransitionResult> {
  const input = reconciliationJobActionBase(rawInput, ["errorCode", "retryAt"]);
  const errorCode = text(input.record.errorCode, 128);
  const retryAt = input.record.retryAt === undefined ? undefined : timestamp(input.record.retryAt);
  const status = retryAt === undefined ? "FAILED" as const : "RETRY_SCHEDULED" as const;
  const operationDigest = canonicalContentDigest({ action: "FAIL", jobId: input.jobId,
    workerId: input.workerId, errorCode, retryAt: retryAt ?? null });
  return withLockedReconciliationJob(context, input.jobId, async (db, job) => {
    const replay = await replayedReconciliationJobTransition(
      db, input.idempotencyKey, operationDigest,
    );
    if (replay) return replay;
    const clock = await db.one<{ now: Date; transition_at: Date } & Record<string, unknown>>(
      "select clock_timestamp() now,date_trunc('milliseconds',transaction_timestamp()) transition_at",
    );
    if (retryAt !== undefined && new Date(retryAt) <= clock.now) {
      invalid("MEMORY_GRAPH_RECONCILIATION_RETRY_INVALID");
    }
    const prior = await latestReconciliationJobTransition(db, job.id);
    if (prior.to_status !== "CLAIMED" || prior.worker_id !== input.workerId
      || prior.lease_until === null || prior.lease_until <= clock.now) {
      throw new Error("MEMORY_GRAPH_RECONCILIATION_JOB_NOT_OWNED");
    }
    return appendReconciliationJobTransition(db, context, job, prior, {
      ...input, operationDigest, transitionAt: clock.transition_at.toISOString(),
    }, "FAIL", status, { errorCode, ...(retryAt ? { retryAt } : {}),
      edgeOffset: prior.edge_offset, edgeSourceOffset: prior.edge_source_offset });
  });
}
