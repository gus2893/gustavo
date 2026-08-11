import { createHmac } from "node:crypto";
import { types as utilTypes } from "node:util";
import { unwrapDataKey } from "../crypto/envelope";
import { canonicalContentDigest } from "../events/integrity";
import { lockAvailableMemorySourceBodies, readEventBodies } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { MEMORY_CONFLICT_STATES, MEMORY_SCOPES, MEMORY_TYPES, type MemoryScope } from "../memory/types";
import { memoryVectorBucketDigests } from "../memory/vector-index";
import {
  fuseAndRankAuthorizedCandidates,
  fuseBoundedRecallChannels,
  type RecallCandidate,
  type RecallExcluded,
} from "./rank";
import {
  persistRecallTrace,
  lookupRecallTrace,
  RECALL_QUERY_KINDS,
  type RecallActor,
  type RecallQueryPlanStep,
  type RecallStateVersions,
  type RecallTraceDraft,
  type StoredRecallTrace,
} from "./trace";
import {
  backfillHistoricalMemoryVectorBuckets,
  createMemoryWorkerContext,
  type MemoryVectorBackfillDomain,
} from "../../../worker/consolidation/process-event";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_RAW_CANDIDATES = 200;
const MAX_DATABASE_CANDIDATES = 100;
const MAX_QUERY_CANDIDATES = 20;
const MAX_CONTEXT_MEMORIES = 24;
const MAX_TOKEN_BUDGET = 8_000;
const MAX_GRAPH_DEPTH = 2;
const MAX_RECALL_TIME_MILLISECONDS = 5_000;
const MAX_MEMORY_SOURCES = 500;
const MAX_RECENT_TURNS = 8;
const MAX_PROPOSAL_AUTHORIZATIONS = 100;
// readEventBodies authorizes a maximum of 100 event IDs as one set. Reserve ten
// slots for Main/Node plus eight native turns so authorization still precedes
// every ciphertext read in the worst case.
const MAX_HYDRATED_DATABASE_CANDIDATES = MAX_DATABASE_CANDIDATES - MAX_RECENT_TURNS - 2;
const contextBrands = new WeakSet<object>();

export interface RecallCache {
  readonly get: (key: string) => unknown | Promise<unknown>;
}

export type RecallActorInput =
  | { readonly role: "MAIN_BRAIN"; readonly actorId: string }
  | { readonly role: "ACCOUNT"; readonly accountId: string }
  | {
      readonly role: "SYSTEM" | "OPERATOR";
      readonly actorId: string;
      readonly purpose: string;
      readonly scopes: readonly MemoryScope[];
    };

export interface RecallAuthorizationContext {
  readonly db: EventDatabase;
  readonly actor: RecallActor;
  readonly scopes: readonly MemoryScope[];
  readonly cache?: RecallCache;
}

export interface RecallContextMemory {
  readonly id: string;
  readonly type: RecallCandidate["type"];
  readonly scope: RecallCandidate["scope"];
  readonly accountId: string | null;
  readonly nodeBrainId: string | null;
  readonly conversationId: string | null;
  readonly excerpt: string;
  readonly contentKind: "DERIVED_MEMORY";
  readonly sourceEventIds: readonly string[];
  readonly confidence: number;
  readonly createdAt: string;
  readonly conflictState: RecallCandidate["conflictState"];
  readonly supersedesMemoryId: string | null;
}

export interface RecallContextEntry {
  readonly kind: "MAIN_STATE" | "NODE_STATE" | "CHALLENGE_STATE" | "RECENT_TURN" | "DERIVED_MEMORY";
  readonly id: string;
  readonly scope: MemoryScope;
  readonly excerpt: string;
  readonly version: string | null;
  readonly sourceEventIds: readonly string[];
  readonly confidence: number | null;
  readonly createdAt: string;
  readonly supersedesMemoryId: string | null;
  readonly contentKind: "CANONICAL_STATE" | "ORIGINAL_EVENT" | "DERIVED_MEMORY";
}

export interface RecallPlanResult {
  readonly memories: readonly RecallCandidate[];
  readonly excluded: readonly RecallExcluded[];
  readonly contextPack: {
    readonly entries: readonly RecallContextEntry[];
    readonly memories: readonly RecallContextMemory[];
    readonly estimatedTokens: number;
  };
  readonly trace: RecallTraceDraft;
}

export interface RecallResult extends Omit<RecallPlanResult, "trace"> {
  readonly trace: StoredRecallTrace;
}

interface CandidateRow extends Record<string, unknown> {
  readonly id: string;
  readonly body_event_id: string;
  readonly scope: RecallCandidate["scope"];
  readonly type: RecallCandidate["type"];
  readonly account_id: string | null;
  readonly node_brain_id: string | null;
  readonly conversation_id: string | null;
  readonly source_ids: string[];
  readonly confidence: string | number;
  readonly importance: string | number;
  readonly freshness: string | number;
  readonly created_at: Date;
  readonly conflict_state: RecallCandidate["conflictState"];
  readonly equivalence_digest: string;
  readonly supersedes_memory_id: string | null;
  readonly current: boolean;
  readonly score: string | number;
  readonly proposal_authorized: boolean;
}

interface CapturedRecallInput {
  readonly actor: RecallActor;
  readonly query: string;
  readonly maxMemories: number;
  readonly tokenBudget: number;
  readonly candidates: readonly RecallCandidate[];
}

function invalid(code = "INPUT_INVALID"): never {
  throw new Error(`RECALL_${code}`);
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
    if (error instanceof Error && error.message.startsWith("RECALL_")) throw error;
    return invalid();
  }
}

function denseArray(value: unknown, maximum: number, limitCode = "INPUT_INVALID"): readonly unknown[] {
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
    if (error instanceof Error && error.message.startsWith("RECALL_")) throw error;
    return invalid();
  }
}

function boundedString(value: unknown, maximum: number, code = "INPUT_INVALID"): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1
    || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    return invalid(code);
  }
  return value;
}

function uuid(value: unknown): string {
  const captured = boundedString(value, 36);
  if (!UUID_PATTERN.test(captured)) return invalid();
  return captured.toLowerCase();
}

function timestamp(value: unknown): string {
  const captured = boundedString(value, 24);
  if (!TIMESTAMP_PATTERN.test(captured) || new Date(captured).toISOString() !== captured) {
    return invalid();
  }
  return captured;
}

function unit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return invalid();
  }
  return value;
}

function positiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return invalid();
  }
  return value as number;
}

function captureScopes(value: unknown): readonly MemoryScope[] {
  const scopes = denseArray(value, MEMORY_SCOPES.length).map((item) => {
    if (typeof item !== "string" || !MEMORY_SCOPES.includes(item as MemoryScope)) return invalid();
    return item as MemoryScope;
  });
  if (new Set(scopes).size !== scopes.length) return invalid();
  return Object.freeze([...scopes].sort());
}

function captureActor(value: unknown, durable = false): RecallActor {
  const base = plainRecord(value, ["role"], ["actorId", "accountId", "conversationId", "nodeBrainId", "purpose", "scopes"]);
  if (base.role === "MAIN_BRAIN") {
    const exact = plainRecord(value, ["actorId", "role"]);
    if (exact.actorId !== "gustavo-main") throw new Error("RECALL_MAIN_ACTOR_INVALID");
    return Object.freeze({ role: "MAIN_BRAIN", actorId: "gustavo-main" });
  }
  if (base.role === "ACCOUNT") {
    const exact = plainRecord(value, ["accountId", "role"], durable ? [] : ["conversationId", "nodeBrainId"]);
    const accountId = uuid(exact.accountId);
    if (durable) {
      return Object.freeze({
        role: "ACCOUNT", accountId,
        nodeBrainId: "00000000-0000-4000-8000-000000000000",
        conversationId: "00000000-0000-4000-8000-000000000000",
      });
    }
    return Object.freeze({
      role: "ACCOUNT", accountId,
      nodeBrainId: uuid(exact.nodeBrainId),
      conversationId: uuid(exact.conversationId),
    });
  }
  if (base.role === "SYSTEM" || base.role === "OPERATOR") {
    const exact = plainRecord(value, ["actorId", "purpose", "role", "scopes"]);
    return Object.freeze({
      role: base.role,
      actorId: boundedString(exact.actorId, 128),
      purpose: boundedString(exact.purpose, 256),
      scopes: captureScopes(exact.scopes),
    });
  }
  return invalid();
}

function captureCandidate(value: unknown): RecallCandidate {
  const input = plainRecord(
    value,
    ["confidence", "conflictState", "createdAt", "current", "equivalenceDigest", "freshness",
      "id", "importance", "score", "scope", "sourceIds", "text", "type"],
    ["accountId", "channels", "conversationId", "nodeBrainId", "proposalAuthorized", "supersedesMemoryId"],
  );
  if (typeof input.scope !== "string" || !MEMORY_SCOPES.includes(input.scope as MemoryScope)
    || typeof input.type !== "string" || !MEMORY_TYPES.includes(input.type as RecallCandidate["type"])
    || typeof input.conflictState !== "string"
    || !MEMORY_CONFLICT_STATES.includes(input.conflictState as RecallCandidate["conflictState"])) {
    return invalid();
  }
  const protectedPrivate = input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH";
  const accountId = input.accountId === undefined || input.accountId === null
    ? null : uuid(input.accountId);
  const nodeBrainId = input.nodeBrainId === undefined || input.nodeBrainId === null
    ? null : uuid(input.nodeBrainId);
  const conversationId = input.conversationId === undefined || input.conversationId === null
    ? null : uuid(input.conversationId);
  if ((protectedPrivate && accountId === null)
    || (!protectedPrivate && (accountId !== null || nodeBrainId !== null || conversationId !== null))
    || ((nodeBrainId === null) !== (conversationId === null))) {
    return invalid();
  }
  const sourceIds = denseArray(input.sourceIds, MAX_MEMORY_SOURCES).map(uuid);
  if (sourceIds.length === 0 || new Set(sourceIds).size !== sourceIds.length) return invalid();
  const channels = denseArray(input.channels ?? [], RECALL_QUERY_KINDS.length).map((item) => (
    boundedString(item, 32)
  ));
  if (new Set(channels).size !== channels.length) return invalid();
  if (typeof input.current !== "boolean" || typeof input.proposalAuthorized !== "undefined"
      && typeof input.proposalAuthorized !== "boolean") return invalid();
  const digest = boundedString(input.equivalenceDigest, 64);
  if (!DIGEST_PATTERN.test(digest)) return invalid();
  return Object.freeze({
    id: uuid(input.id),
    scope: input.scope as RecallCandidate["scope"],
    type: input.type as RecallCandidate["type"],
    accountId,
    nodeBrainId,
    conversationId,
    proposalAuthorized: input.proposalAuthorized === true,
    current: input.current,
    score: unit(input.score),
    sourceIds: Object.freeze(sourceIds),
    confidence: unit(input.confidence),
    importance: unit(input.importance),
    freshness: unit(input.freshness),
    createdAt: timestamp(input.createdAt),
    conflictState: input.conflictState as RecallCandidate["conflictState"],
    equivalenceDigest: digest,
    supersedesMemoryId: input.supersedesMemoryId === undefined || input.supersedesMemoryId === null
      ? null : uuid(input.supersedesMemoryId),
    text: boundedString(input.text, 8_000),
    channels: Object.freeze(channels),
  });
}

function capturePlanInput(value: unknown): CapturedRecallInput {
  const input = plainRecord(value, ["actor", "candidates", "maxMemories", "query"], ["tokenBudget"]);
  const candidates = denseArray(input.candidates, MAX_RAW_CANDIDATES, "CANDIDATE_LIMIT")
    .map(captureCandidate);
  if (new Set(candidates.map(({ id }) => id)).size !== candidates.length) return invalid();
  return Object.freeze({
    actor: captureActor(input.actor),
    query: boundedString(input.query, 4_000),
    maxMemories: positiveInteger(input.maxMemories, MAX_CONTEXT_MEMORIES),
    tokenBudget: input.tokenBudget === undefined
      ? MAX_TOKEN_BUDGET : positiveInteger(input.tokenBudget, MAX_TOKEN_BUDGET),
    candidates: Object.freeze(candidates),
  });
}

function scopeAllows(
  actor: RecallActor,
  candidate: RecallCandidate,
  allowDurableProposal: boolean,
): boolean {
  if (actor.role === "MAIN_BRAIN") {
    return ["MAIN_SHARED", "CHALLENGE_SHARED", "PUBLIC"].includes(candidate.scope)
      || (allowDurableProposal && candidate.scope === "PRIVATE_ACCOUNT"
        && candidate.proposalAuthorized);
  }
  if (actor.role === "ACCOUNT") {
    if (["MAIN_SHARED", "CHALLENGE_SHARED", "PUBLIC"].includes(candidate.scope)) return true;
    return ["PRIVATE_ACCOUNT", "NODE_BRANCH"].includes(candidate.scope)
      && candidate.accountId === actor.accountId
      && candidate.nodeBrainId === actor.nodeBrainId
      && candidate.conversationId === actor.conversationId;
  }
  return actor.scopes.includes(candidate.scope);
}

function contextPack(
  memories: readonly RecallCandidate[],
  entries: readonly RecallContextEntry[] = [],
) {
  const projected = Object.freeze(memories.map((memory) => Object.freeze({
      id: memory.id,
      type: memory.type,
      scope: memory.scope,
      accountId: memory.accountId,
      nodeBrainId: memory.nodeBrainId,
      conversationId: memory.conversationId,
      excerpt: memory.text,
      contentKind: "DERIVED_MEMORY" as const,
      sourceEventIds: memory.sourceIds,
      confidence: memory.confidence,
      createdAt: memory.createdAt,
      conflictState: memory.conflictState,
      supersedesMemoryId: memory.supersedesMemoryId,
    })));
  const frozenEntries = Object.freeze([...entries]);
  let estimatedTokens = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    estimatedTokens = Math.ceil(JSON.stringify({
      entries: frozenEntries, memories: projected, estimatedTokens,
    }).length / 4);
  }
  return Object.freeze({ entries: frozenEntries, memories: projected, estimatedTokens });
}

function requestIdentity(
  context: RecallAuthorizationContext,
  input: CapturedAuthorizedInput,
): JsonValue {
  return {
    actor: context.actor as unknown as JsonValue,
    authorizedScopes: [...context.scopes],
    query: input.query,
    entities: [...input.entities],
    from: input.from,
    to: input.to,
    maxMemories: input.maxMemories,
    tokenBudget: input.tokenBudget,
    graphDepth: input.graphDepth,
    responseId: input.responseId,
    occurredAt: input.occurredAt,
    policyVersion: input.policyVersion,
    modelVersion: input.modelVersion,
    plannerVersion: input.plannerVersion,
    embeddingVersion: input.embeddingVersion,
    queryVector: input.queryVector === null ? null : [...input.queryVector],
  };
}

function queryPlan(graphDepth = MAX_GRAPH_DEPTH): readonly RecallQueryPlanStep[] {
  return Object.freeze(RECALL_QUERY_KINDS.map((kind) => Object.freeze({
    kind,
    limit: MAX_QUERY_CANDIDATES,
    depth: kind === "GRAPH" ? graphDepth : 0,
  })));
}

function planCapturedRecall(
  input: CapturedRecallInput,
  allowDurableProposal: boolean,
  workingEntries: readonly RecallContextEntry[] = [],
): RecallPlanResult {
  const authorized: RecallCandidate[] = [];
  const forbidden: RecallExcluded[] = [];
  // This pass reads only scope/identity metadata. Scores and text are captured only after the
  // hostile-input boundary above, and no candidate reaches ranking before this authorization pass.
  for (const candidate of input.candidates) {
    if (scopeAllows(input.actor, candidate, allowDurableProposal)) authorized.push(candidate);
    else forbidden.push(Object.freeze({ id: candidate.id, reason: "SCOPE_FORBIDDEN" }));
  }
  const ranked = fuseAndRankAuthorizedCandidates(authorized, {
    maxMemories: input.maxMemories,
    tokenBudget: MAX_TOKEN_BUDGET,
  });
  const selected = [...ranked.selected];
  const tokenExcluded: RecallExcluded[] = [];
  let pack = contextPack(selected, workingEntries);
  while (pack.estimatedTokens > input.tokenBudget && selected.length > 0) {
    const removed = selected.pop()!;
    tokenExcluded.unshift(Object.freeze({ id: removed.id, reason: "TOKEN_LIMIT" }));
    pack = contextPack(selected, workingEntries);
  }
  if (pack.estimatedTokens > input.tokenBudget) throw new Error("RECALL_TOKEN_BUDGET_TOO_SMALL");
  const excluded = Object.freeze([...forbidden, ...ranked.excluded, ...tokenExcluded]);
  const plan = queryPlan();
  return Object.freeze({
    memories: Object.freeze(selected),
    excluded,
    contextPack: pack,
    trace: Object.freeze({
      queryPlan: plan,
      authorizedCandidateIds: Object.freeze(authorized.map(({ id }) => id).sort()),
      excluded,
      selectedMemoryIds: Object.freeze(selected.map(({ id }) => id)),
      selectedSourceIds: Object.freeze([...new Set(selected.flatMap(({ sourceIds }) => sourceIds))].sort()),
      cacheUse: "BYPASS",
    }),
  });
}

export async function planRecall(rawInput: unknown): Promise<RecallPlanResult> {
  return planCapturedRecall(capturePlanInput(rawInput), false);
}

export function recallBenchmarkContract() {
  return Object.freeze({
    fixtureSourceEvents: 1_000_000,
    warmP95Milliseconds: 250,
    cachedHandoffP95Milliseconds: 100,
    maximumCandidateQueries: 9,
    maximumCandidatesPerQuery: MAX_QUERY_CANDIDATES,
    maximumCandidatesBeforeRanking: MAX_DATABASE_CANDIDATES,
    maximumGraphDepth: MAX_GRAPH_DEPTH,
    maximumContextMemories: MAX_CONTEXT_MEMORIES,
  });
}

export async function authorizeRecall(
  db: EventDatabase,
  rawActor: RecallActorInput,
  options: { readonly cache?: RecallCache } = {},
): Promise<RecallAuthorizationContext> {
  if (!db || typeof db !== "object" || typeof db.query !== "function"
    || typeof db.transaction !== "function") throw new Error("RECALL_CONTEXT_INVALID");
  const actor = captureActor(rawActor, true);
  let resolved: RecallActor;
  let scopes: readonly MemoryScope[];
  if (actor.role === "ACCOUNT") {
    const rows = await db.query<{
      account_id: string; node_brain_id: string; conversation_id: string;
    } & Record<string, unknown>>(
      `select account.id::text account_id,node.id::text node_brain_id,
              conversation.id::text conversation_id
       from accounts account
       join entitlements entitlement on entitlement.account_id=account.id
         and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
         and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
       join node_brains node on node.account_id=account.id and node.status='ACTIVE'
       join conversations conversation on conversation.account_id=account.id
         and conversation.node_brain_id=node.id and conversation.status='OPEN'
       where account.id=$1 and account.status='ACTIVE'`,
      [actor.accountId],
    );
    if (rows.length !== 1) throw new Error("RECALL_ACCOUNT_FORBIDDEN");
    resolved = Object.freeze({
      role: "ACCOUNT",
      accountId: rows[0].account_id,
      nodeBrainId: rows[0].node_brain_id,
      conversationId: rows[0].conversation_id,
    });
    scopes = Object.freeze([
      "CHALLENGE_SHARED", "MAIN_SHARED", "NODE_BRANCH", "PRIVATE_ACCOUNT", "PUBLIC",
    ] as const);
  } else {
    const rows = await db.query<{
      role: RecallActor["role"]; actor_id: string; scopes: MemoryScope[];
    } & Record<string, unknown>>(
      `select role,actor_id,scopes from recall_actor_authorities
       where role=$1 and actor_id=$2 and active`,
      [actor.role, actor.actorId],
    );
    if (rows.length !== 1) {
      throw new Error(actor.role === "MAIN_BRAIN"
        ? "RECALL_MAIN_ACTOR_INVALID" : "RECALL_ACTOR_FORBIDDEN");
    }
    if (actor.role === "MAIN_BRAIN") {
      resolved = actor;
      scopes = Object.freeze(["CHALLENGE_SHARED", "MAIN_SHARED", "PUBLIC"] as const);
    } else {
      const allowed = new Set(rows[0].scopes);
      if (actor.scopes.some((scope) => !allowed.has(scope)
        || scope === "PRIVATE_ACCOUNT" || scope === "NODE_BRANCH")) {
        throw new Error("RECALL_SCOPE_FORBIDDEN");
      }
      resolved = actor;
      scopes = actor.scopes;
    }
  }
  const context = Object.freeze({ db, actor: resolved, scopes, ...(options.cache ? { cache: options.cache } : {}) });
  contextBrands.add(context);
  return context;
}

function authorizationSql(actor: RecallActor): { readonly clause: string; readonly parameters: readonly unknown[] } {
  if (actor.role === "ACCOUNT") {
    return {
      clause: `(
        m.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
        or (m.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and m.account_id=$1
          and m.node_brain_id=$2 and m.conversation_id=$3)
      )`,
      parameters: [actor.accountId, actor.nodeBrainId, actor.conversationId],
    };
  }
  if (actor.role === "MAIN_BRAIN") {
    return {
      clause: `(
        m.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
        or (m.scope='PRIVATE_ACCOUNT' and exists (
          select 1 from proposals proposal
          join proposal_status_transitions proposal_status on proposal_status.proposal_id=proposal.id
          left join proposal_disclosure_revocations revoked
            on revoked.authorization_id=proposal.disclosure_authorization_id
          left join proposal_disclosure_authorizations disclosure
            on disclosure.id=proposal.disclosure_authorization_id
          where proposal_status.ordinal=(select max(latest.ordinal)
              from proposal_status_transitions latest where latest.proposal_id=proposal.id)
            and proposal_status.to_status not in ('WITHDRAWN','REJECTED')
            and proposal.privacy_scope='PROPOSAL_RAW_TEXT'
            and revoked.authorization_id is null
            and disclosure.expires_at>clock_timestamp()
            and not exists (
              select 1 from memory_sources proposal_source
              where proposal_source.memory_id=m.id
                and not (proposal.source_event_ids ? proposal_source.source_event_id::text)
            )
        ))
      )`,
      parameters: [],
    };
  }
  return {
    clause: "m.scope=any($1::text[])",
    parameters: [actor.scopes],
  };
}

function vectorBackfillDomains(context: RecallAuthorizationContext): readonly MemoryVectorBackfillDomain[] {
  return Object.freeze(context.scopes.map((scope) => {
    const accountDomain = context.actor.role === "ACCOUNT"
      && (scope === "PRIVATE_ACCOUNT" || scope === "NODE_BRANCH");
    return Object.freeze({
      scope,
      accountId: accountDomain ? context.actor.accountId : null,
      nodeBrainId: accountDomain ? context.actor.nodeBrainId : null,
      conversationId: accountDomain ? context.actor.conversationId : null,
    });
  }));
}

const CANDIDATE_COLUMNS = `
  m.id::text,m.body_event_id::text,m.scope,m.type,m.account_id::text,m.node_brain_id::text,
  m.conversation_id::text,m.confidence,m.importance,m.freshness,m.created_at,
  m.conflict_state,m.equivalence_digest,m.supersedes_memory_id::text,
  (m.valid_to is null and m.conflict_state='CURRENT') current,
  coalesce(array_agg(source.source_event_id::text order by source.ordinal)
    filter (where source.source_event_id is not null),'{}'::text[]) source_ids,
  case when m.scope='PRIVATE_ACCOUNT' and exists (
    select 1 from proposals p
    join proposal_disclosure_authorizations disclosure
      on disclosure.id=p.disclosure_authorization_id
    left join proposal_disclosure_revocations revoked
      on revoked.authorization_id=disclosure.id
    join proposal_status_transitions status on status.proposal_id=p.id
    where p.privacy_scope='PROPOSAL_RAW_TEXT'
      and revoked.authorization_id is null and disclosure.expires_at>clock_timestamp()
      and status.ordinal=(select max(latest.ordinal) from proposal_status_transitions latest
        where latest.proposal_id=p.id)
      and status.to_status not in ('WITHDRAWN','REJECTED')
      and not exists (
        select 1 from memory_sources ps where ps.memory_id=m.id
          and not (p.source_event_ids ? ps.source_event_id::text)
      )
  ) then true else false end proposal_authorized
`;

function availableSourcesSql(): string {
  return `exists (
      select 1 from encrypted_event_bodies memory_body
      join aggregate_data_keys memory_key on memory_key.id=memory_body.data_key_id
      where memory_body.event_id=m.body_event_id
    ) and not exists (
      select 1 from memory_sources unavailable_source
      left join encrypted_event_bodies source_body
        on source_body.event_id=unavailable_source.source_event_id
      left join aggregate_data_keys source_key on source_key.id=source_body.data_key_id
      where unavailable_source.memory_id=m.id and source_key.id is null
    )`;
}

function sourceHighWaterSql(memoryAlias: string, parameter: number): string {
  return `not exists (
    select 1 from memory_sources high_water_source
    where high_water_source.memory_id=${memoryAlias}.id
      and high_water_source.source_ingested_sequence>$${parameter}::bigint
  )`;
}

function importedMemoryLifecycleSql(
  memoryAlias: string,
  historicalAllowed: boolean,
): string {
  return `(not exists (
      select 1 from import_memory_projections imported
      where imported.memory_id=${memoryAlias}.id
    ) or exists (
      select 1
      from import_memory_projections imported
      join import_source_items imported_item on imported_item.id=imported.item_id
      join lateral (
        select lifecycle.active
        from import_item_lifecycle_events lifecycle
        where lifecycle.item_id=imported.item_id
        order by lifecycle.authority_sequence desc,lifecycle.id desc limit 1
      ) imported_lifecycle on true
      where imported.memory_id=${memoryAlias}.id and imported_lifecycle.active
        and ((imported.lifecycle_class='CANONICAL'
              and imported.retrieval_profile='CURRENT_GENERAL'
              and imported_item.retrieval_mode='GENERAL')
          ${historicalAllowed ? `or (imported.lifecycle_class='HISTORICAL'
              and imported.retrieval_profile='HISTORICAL_SIMILARITY'
              and imported_item.retrieval_mode='SIMILARITY_ONLY')` : ""})
    ))`;
}

async function runCandidateChannel(
  db: EventDatabase,
  actor: RecallActor,
  kind: RecallQueryPlanStep["kind"],
  condition: string,
  conditionParameters: readonly unknown[],
  graphDepth: number,
  sourceHighWaterSequence: string,
  resultLimit = MAX_QUERY_CANDIDATES,
  replaySelection = false,
  historicalImportAllowed?: boolean,
): Promise<readonly CandidateRow[]> {
  const authorization = authorizationSql(actor);
  const offset = authorization.parameters.length;
  const shifted = condition.replace(/\$(\d+)/gu, (_, value: string) => `$${Number(value) + offset}`);
  const highWaterParameter = offset + conditionParameters.length + 1;
  const preselectionLimitParameter = highWaterParameter + 1;
  const resultLimitParameter = highWaterParameter + 2;
  const vectorParameter = offset + 1;
  const vectorBucketParameter = offset + 3;
  const proposalMembershipTerm = actor.role === "MAIN_BRAIN"
    ? `union
       select proposal_memory.id memory_id from memory_records proposal_memory
       where proposal_memory.scope='PRIVATE_ACCOUNT' and exists (
         select 1 ${ACTIVE_PROPOSAL_AUTHORITY_SQL}
         and not exists (
           select 1 from memory_sources proposal_source
           where proposal_source.memory_id=proposal_memory.id
             and not (proposal.source_event_ids ? proposal_source.source_event_id::text)
         )
       )`
    : "";
  const vectorJoin = kind === "VECTOR"
    ? `left join memory_embeddings vector_embedding on vector_embedding.memory_id=m.id
       left join lateral (
         select case when vector_embedding.memory_id is not null then
           (memory_cosine_similarity(vector_embedding.search_embedding,$${vectorParameter}::real[])+1)/2
         else null end vector_score
       ) vector_channel on true`
    : "";
  const termJoin = kind === "VECTOR"
    ? `join (
         select bucket.memory_id,count(*)::int bucket_matches
         from memory_vector_buckets bucket
         join aggregate_data_keys body_key on body_key.id=bucket.body_key_id
         left join aggregate_data_keys search_key on search_key.id=bucket.search_key_id
         where bucket.embedding_version=$${offset + 2}
           and bucket.bucket_digest=any($${vectorBucketParameter}::text[])
           and (bucket.scope='PUBLIC' or search_key.id is not null)
         group by bucket.memory_id
         order by count(*) desc,bucket.memory_id
         limit ${MAX_DATABASE_CANDIDATES}
       ) vector_match on vector_match.memory_id=m.id`
    : kind === "ENTITY"
    ? `join (
         select term.memory_id from memory_index_terms term
         where term.kind='ENTITY' and term.scope='PUBLIC'
           and term.term_text=any($${offset + 1}::text[])
         union
         select term.memory_id from memory_index_terms term
         where term.kind='ENTITY' and term.scope<>'PUBLIC'
           and term.term_digest=any($${offset + 2}::text[])
       ) channel_match on channel_match.memory_id=m.id`
    : kind === "FULL_TEXT"
      ? `join (
           select term.memory_id from memory_index_terms term
           where term.kind='KEYWORD' and term.scope='PUBLIC'
             and (term.term_text=any($${offset + 1}::text[])
               or to_tsvector('simple',term.term_text)
                 @@ plainto_tsquery('simple',$${offset + 3}))
           union
           select term.memory_id from memory_index_terms term
           where term.kind='KEYWORD' and term.scope<>'PUBLIC'
             and term.term_digest=any($${offset + 2}::text[])
           ${proposalMembershipTerm}
         ) channel_match on channel_match.memory_id=m.id`
      : "";
  const effectiveCondition = kind === "ENTITY" || kind === "FULL_TEXT" ? "true" : shifted;
  const historicalImportedMemoryAllowed = replaySelection
    || (historicalImportAllowed ?? ["ENTITY", "FULL_TEXT", "VECTOR"].includes(kind));
  const channelScore = kind === "VECTOR"
    ? "coalesce(vector_score,0)"
    : kind === "ENTITY" || kind === "FULL_TEXT"
      ? kind === "FULL_TEXT" && actor.role === "MAIN_BRAIN"
        ? "case when m.scope='PRIVATE_ACCOUNT' then 0 else 1 end"
        : "1"
      : kind === "CURRENT_STATE"
        ? "coalesce(m.importance,0)*0.75"
        : kind === "RECENT" || kind === "TIME"
        ? "coalesce(m.importance,0)*0.5"
        : "coalesce(m.importance,0)";
  const rows = await db.query<CandidateRow>(
    `/* recall-channel:${kind} */
     with bounded as materialized (
       select m.id
       from memory_records m
       ${termJoin}
       where ${authorization.clause} and ${availableSourcesSql()}
         and ${importedMemoryLifecycleSql("m", historicalImportedMemoryAllowed)}
         and ${sourceHighWaterSql("m", highWaterParameter)} and (${effectiveCondition})
       order by ${kind === "VECTOR" ? "vector_match.bucket_matches desc,"
        : kind === "CURRENT_STATE" ? "(m.valid_to is null and m.conflict_state='CURRENT') desc,"
        : kind === "RECENT" ? "m.created_at desc,"
          : kind === "TIME" ? "m.source_to desc," : ""}
         m.importance desc,m.created_at desc,m.id
       limit $${preselectionLimitParameter}
     )
     select ${CANDIDATE_COLUMNS},
       least(1::numeric,greatest(0::numeric,(${channelScore})::numeric)) score
     from bounded
     join memory_records m on m.id=bounded.id
     left join memory_sources source on source.memory_id=m.id
     ${vectorJoin}
     group by m.id${kind === "VECTOR" ? ",vector_score" : ""}
     order by ${kind === "CURRENT_STATE" ? "current desc,"
      : kind === "RECENT" ? "m.created_at desc,"
        : kind === "TIME" ? "m.source_to desc," : ""}
       score desc,m.created_at desc,m.id
     limit $${resultLimitParameter}`,
    [...authorization.parameters, ...conditionParameters, sourceHighWaterSequence,
      kind === "VECTOR" ? MAX_DATABASE_CANDIDATES : resultLimit,
      kind === "VECTOR" ? MAX_DATABASE_CANDIDATES : resultLimit],
  );
  void graphDepth;
  return rows;
}

async function runGraphChannel(
  db: EventDatabase,
  actor: RecallActor,
  anchorIds: readonly string[],
  depth: number,
  sourceHighWaterSequence: string,
): Promise<readonly CandidateRow[]> {
  const authorization = authorizationSql(actor);
  const anchorParameter = authorization.parameters.length + 1;
  const depthParameter = authorization.parameters.length + 2;
  const highWaterParameter = authorization.parameters.length + 3;
  const limitParameter = authorization.parameters.length + 4;
  const neighborAuthorization = authorization.clause.replaceAll("m.", "next_memory.");
  const neighborAvailability = availableSourcesSql().replaceAll("m.", "next_memory.");
  return db.query<CandidateRow>(
    `/* recall-channel:GRAPH */
     with recursive walk(memory_id,depth,path) as (
       select anchor.id,0,array[anchor.id]
       from unnest($${anchorParameter}::uuid[]) anchor(id)
       union all
       select neighbor.next_memory_id,walk.depth+1,walk.path||neighbor.next_memory_id
       from walk
       join lateral (
         select candidate.next_memory_id from (
           select edge.target_memory_id next_memory_id
           from memory_graph_edges edge
           where edge.source_memory_id=walk.memory_id and edge.valid_to is null
           union
           select edge.source_memory_id from memory_graph_edges edge
           where edge.target_memory_id=walk.memory_id and edge.valid_to is null
           union
           select link.equivalent_memory_id
           from memory_equivalence_links link
           where link.memory_id=walk.memory_id
           union
           select link.memory_id from memory_equivalence_links link
           where link.equivalent_memory_id=walk.memory_id
           union
           select memory.supersedes_memory_id
           from memory_records memory
           where memory.id=walk.memory_id and memory.supersedes_memory_id is not null
           union
           select memory.id from memory_records memory
           where memory.supersedes_memory_id=walk.memory_id
           union
           select sibling.memory_id
           from memory_sources current_source
           join memory_sources sibling using (source_event_id)
           where current_source.memory_id=walk.memory_id
             and sibling.memory_id<>walk.memory_id
         ) candidate
         where candidate.next_memory_id is not null
         order by candidate.next_memory_id
         limit 20
       ) neighbor on true
       join memory_records next_memory on next_memory.id=neighbor.next_memory_id
       where walk.depth<$${depthParameter}
         and not neighbor.next_memory_id=any(walk.path)
         and ${neighborAuthorization}
         and ${neighborAvailability}
         and ${importedMemoryLifecycleSql("next_memory", false)}
         and ${sourceHighWaterSql("next_memory", highWaterParameter)}
     ), discovered as (
       select memory_id,min(depth)::int depth from walk where depth>0
       group by memory_id order by min(depth),memory_id limit $${limitParameter}
     )
     select ${CANDIDATE_COLUMNS},
       (1::numeric/(discovered.depth+1)) score
     from discovered
     join memory_records m on m.id=discovered.memory_id
     left join memory_sources source on source.memory_id=m.id
     where ${authorization.clause} and ${availableSourcesSql()}
       and ${importedMemoryLifecycleSql("m", false)}
       and ${sourceHighWaterSql("m", highWaterParameter)}
     group by m.id,discovered.depth
     order by discovered.depth,m.importance desc,m.created_at desc,m.id`,
    [...authorization.parameters, anchorIds, depth, sourceHighWaterSequence, MAX_QUERY_CANDIDATES],
  );
}

function queryTerms(query: string): readonly string[] {
  return Object.freeze([...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,39}/gu) ?? [])]
    .slice(0, 12));
}

async function protectedTermDigests(
  context: RecallAuthorizationContext,
  groups: Readonly<Record<"KEYWORD" | "ENTITY", readonly string[]>>,
  queryVector: readonly number[] | null,
  embeddingVersion: string | null,
): Promise<Readonly<Record<"KEYWORD" | "ENTITY" | "VECTOR", readonly string[]>>> {
  interface RetrievalKeyRow extends Record<string, unknown> {
    readonly aggregate_id: string;
    readonly root_key_version: number;
    readonly wrapped_key: Buffer;
    readonly wrap_iv: Buffer;
    readonly wrap_auth_tag: Buffer;
  }
  const domainScopes = new Map<string, MemoryScope[]>();
  for (const scope of context.scopes) {
    if (scope === "PUBLIC") continue;
    const domain = scope === "PRIVATE_ACCOUNT" || scope === "NODE_BRANCH"
      ? context.actor.role === "ACCOUNT" ? context.actor.conversationId : null
      : scope === "MAIN_SHARED" ? "memory-retrieval:main:v1"
        : scope === "CHALLENGE_SHARED" ? "memory-retrieval:challenge:v1"
          : "memory-retrieval:audit:v1";
    if (domain) domainScopes.set(domain, [...(domainScopes.get(domain) ?? []), scope]);
  }
  const domains = [...domainScopes.keys()];
  if (domains.length === 0 || (groups.KEYWORD.length === 0 && groups.ENTITY.length === 0
      && (!queryVector || !embeddingVersion))) {
    return Object.freeze({ KEYWORD: Object.freeze([]), ENTITY: Object.freeze([]),
      VECTOR: Object.freeze([]) });
  }
  const rows = await context.db.query<RetrievalKeyRow>(
    `select aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
     from aggregate_data_keys where aggregate_id=any($1::text[])
     order by aggregate_id for key share`,
    [domains],
  );
  const results: Record<"KEYWORD" | "ENTITY" | "VECTOR", string[]> = {
    KEYWORD: [], ENTITY: [], VECTOR: [],
  };
  for (const row of rows) {
    const dataKey = unwrapDataKey(row.aggregate_id, {
      rootKeyVersion: row.root_key_version,
      wrappedKey: row.wrapped_key,
      iv: row.wrap_iv,
      authTag: row.wrap_auth_tag,
    });
    const indexKey = createHmac("sha256", dataKey)
      .update("gustavo:memory-search-key:v1").digest();
    try {
      for (const scope of domainScopes.get(row.aggregate_id) ?? []) {
        for (const kind of ["KEYWORD", "ENTITY"] as const) {
          for (const term of groups[kind]) {
            const documentDigest = canonicalContentDigest({
              domain: "gustavo:memory-search:v1",
              kind,
              scope,
              term: term.trim().toLowerCase(),
            });
            results[kind].push(createHmac("sha256", indexKey).update(documentDigest).digest("hex"));
          }
        }
        if (queryVector && embeddingVersion) {
          results.VECTOR.push(...memoryVectorBucketDigests({
            vector: queryVector, scope, embeddingVersion, indexKey,
          }));
        }
      }
    } finally {
      indexKey.fill(0);
      dataKey.fill(0);
    }
  }
  return Object.freeze({
    KEYWORD: Object.freeze([...new Set(results.KEYWORD)]),
    ENTITY: Object.freeze([...new Set(results.ENTITY)]),
    VECTOR: Object.freeze([...new Set(results.VECTOR)]),
  });
}

function rowCandidate(row: CandidateRow, channel: string): RecallCandidate {
  const numeric = (value: string | number) => Number(value);
  return Object.freeze({
    id: row.id,
    scope: row.scope,
    type: row.type,
    accountId: row.account_id,
    nodeBrainId: row.node_brain_id,
    conversationId: row.conversation_id,
    proposalAuthorized: row.proposal_authorized,
    current: row.current,
    score: numeric(row.score),
    sourceIds: Object.freeze([...row.source_ids]),
    confidence: numeric(row.confidence),
    importance: numeric(row.importance),
    freshness: numeric(row.freshness),
    createdAt: new Date(row.created_at).toISOString(),
    conflictState: row.conflict_state,
    equivalenceDigest: row.equivalence_digest,
    supersedesMemoryId: row.supersedes_memory_id,
    text: "pending authorized hydration",
    channels: Object.freeze([channel]),
  });
}

function parseMemoryBodies(
  candidates: readonly (RecallCandidate & { readonly bodyEventId: string })[],
  bodies: readonly { readonly eventId: string; readonly body: JsonValue }[],
): readonly RecallCandidate[] {
  const byEvent = new Map(bodies.map(({ eventId, body }) => [eventId, body]));
  return Object.freeze(candidates.map((candidate) => {
    const body = byEvent.get(candidate.bodyEventId);
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.memories)) {
      throw new Error("RECALL_MEMORY_BODY_INVALID");
    }
    const memory = body.memories.find((item) => item && typeof item === "object"
      && !Array.isArray(item) && item.id === candidate.id);
    if (!memory || typeof memory !== "object" || Array.isArray(memory)
      || typeof memory.text !== "string" || !Array.isArray(memory.sourceIds)
      || memory.sourceIds.some((id) => typeof id !== "string")) {
      throw new Error("RECALL_MEMORY_BODY_INVALID");
    }
    if (JSON.stringify(memory.sourceIds) !== JSON.stringify(candidate.sourceIds)) {
      throw new Error("RECALL_MEMORY_SOURCE_MISMATCH");
    }
    const { bodyEventId: _, ...metadata } = candidate;
    return Object.freeze({ ...metadata, text: boundedString(memory.text, 8_000) });
  }));
}

function exactProtectedVectorFusion(
  candidates: readonly (RecallCandidate & { readonly bodyEventId: string })[],
  bodies: readonly { readonly eventId: string; readonly body: JsonValue }[],
  queryVector: readonly number[] | null,
  embeddingVersion: string | null,
): readonly (RecallCandidate & { readonly bodyEventId: string })[] {
  if (!queryVector || !embeddingVersion) return candidates;
  const queryNorm = Math.sqrt(queryVector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(queryNorm) || queryNorm === 0) throw new Error("RECALL_QUERY_VECTOR_INVALID");
  const byEvent = new Map(bodies.map(({ eventId, body }) => [eventId, body]));
  const similarities = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.scope === "PUBLIC" || !candidate.channels.includes("VECTOR")) continue;
    const body = byEvent.get(candidate.bodyEventId);
    const memory = body && typeof body === "object" && !Array.isArray(body)
      && Array.isArray(body.memories)
      ? body.memories.find((item) => item && typeof item === "object"
        && !Array.isArray(item) && item.id === candidate.id)
      : null;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)
      || memory.embeddingVersion !== embeddingVersion || !Array.isArray(memory.embedding)
      || memory.embedding.length !== queryVector.length
      || memory.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("RECALL_MEMORY_VECTOR_INVALID");
    }
    const embedding = memory.embedding as number[];
    const embeddingNorm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(embeddingNorm) || embeddingNorm === 0) {
      throw new Error("RECALL_MEMORY_VECTOR_INVALID");
    }
    const dot = embedding.reduce((sum, value, index) => sum + value * queryVector[index], 0);
    const cosine = dot / (embeddingNorm * queryNorm);
    similarities.set(candidate.id, Math.max(0, Math.min(1, (cosine + 1) / 2)));
  }
  const selectedVectorIds = new Set([...similarities]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_QUERY_CANDIDATES).map(([id]) => id));
  const fused: (RecallCandidate & { readonly bodyEventId: string })[] = [];
  for (const candidate of candidates) {
    const similarity = similarities.get(candidate.id);
    if (similarity === undefined || selectedVectorIds.has(candidate.id)) {
      fused.push(Object.freeze({ ...candidate,
        ...(similarity === undefined ? {} : { score: Math.max(candidate.score, similarity) }),
      }));
      continue;
    }
    const channels = candidate.channels.filter((channel) => channel !== "VECTOR");
    if (channels.length > 0) fused.push(Object.freeze({ ...candidate, channels: Object.freeze(channels) }));
  }
  return Object.freeze(fused);
}

function exactProposalLexicalFusion(
  candidates: readonly (RecallCandidate & { readonly bodyEventId: string })[],
  bodies: readonly { readonly eventId: string; readonly body: JsonValue }[],
  terms: readonly string[],
  actor: RecallActor,
): readonly (RecallCandidate & { readonly bodyEventId: string })[] {
  if (actor.role !== "MAIN_BRAIN") return candidates;
  const byEvent = new Map(bodies.map(({ eventId, body }) => [eventId, body]));
  const fused: (RecallCandidate & { readonly bodyEventId: string })[] = [];
  for (const candidate of candidates) {
    if (candidate.scope !== "PRIVATE_ACCOUNT" || !candidate.channels.includes("FULL_TEXT")) {
      fused.push(candidate);
      continue;
    }
    const body = byEvent.get(candidate.bodyEventId);
    const memory = body && typeof body === "object" && !Array.isArray(body)
      && Array.isArray(body.memories)
      ? body.memories.find((item) => item && typeof item === "object"
        && !Array.isArray(item) && item.id === candidate.id)
      : null;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)
      || typeof memory.text !== "string") {
      throw new Error("RECALL_MEMORY_BODY_INVALID");
    }
    const normalized = memory.text.toLowerCase();
    if (terms.some((term) => normalized.includes(term))) {
      fused.push(Object.freeze({ ...candidate, score: Math.max(candidate.score, 1) }));
      continue;
    }
    const channels = candidate.channels.filter((channel) => channel !== "FULL_TEXT");
    if (channels.length > 0) {
      fused.push(Object.freeze({ ...candidate, channels: Object.freeze(channels) }));
    }
  }
  return Object.freeze(fused);
}

function version(value: unknown): string {
  const result = boundedString(value, 200);
  if (!VERSION_PATTERN.test(result)) return invalid();
  return result;
}

function key(value: unknown): string {
  const result = boundedString(value, 240);
  if (!KEY_PATTERN.test(result)) return invalid();
  return result;
}

interface CapturedAuthorizedInput {
  readonly query: string;
  readonly entities: readonly string[];
  readonly maxMemories: number;
  readonly tokenBudget: number;
  readonly graphDepth: number;
  readonly responseId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly policyVersion: string;
  readonly modelVersion: string;
  readonly plannerVersion: string;
  readonly embeddingVersion: string | null;
  readonly queryVector: readonly number[] | null;
  readonly from: string | null;
  readonly to: string | null;
}

function captureAuthorizedInput(value: unknown): CapturedAuthorizedInput {
  const input = plainRecord(
    value,
    ["idempotencyKey", "maxMemories", "modelVersion", "occurredAt", "plannerVersion",
      "policyVersion", "query", "responseId", "tokenBudget"],
    ["embeddingVersion", "entities", "from", "graphDepth", "queryVector", "to"],
  );
  const vector = input.queryVector === undefined
    ? null
    : denseArray(input.queryVector, 8_192).map((item) => {
        if (typeof item !== "number" || !Number.isFinite(item)) return invalid();
        return item;
      });
  if ((vector === null) !== (input.embeddingVersion === undefined)) return invalid();
  const entities = denseArray(input.entities ?? [], 20).map((item) => boundedString(item, 120));
  const from = input.from === undefined ? null : timestamp(input.from);
  const to = input.to === undefined ? null : timestamp(input.to);
  if (from && to && from > to) return invalid();
  return Object.freeze({
    query: boundedString(input.query, 4_000),
    entities: Object.freeze(entities),
    maxMemories: positiveInteger(input.maxMemories, MAX_CONTEXT_MEMORIES),
    tokenBudget: positiveInteger(input.tokenBudget, MAX_TOKEN_BUDGET),
    graphDepth: input.graphDepth === undefined ? MAX_GRAPH_DEPTH
      : positiveInteger(input.graphDepth, MAX_GRAPH_DEPTH),
    responseId: uuid(input.responseId),
    idempotencyKey: key(input.idempotencyKey),
    occurredAt: timestamp(input.occurredAt),
    policyVersion: version(input.policyVersion),
    modelVersion: version(input.modelVersion),
    plannerVersion: version(input.plannerVersion),
    embeddingVersion: input.embeddingVersion === undefined ? null : version(input.embeddingVersion),
    queryVector: vector === null ? null : Object.freeze(vector),
    from,
    to,
  });
}

async function revalidateActor(context: RecallAuthorizationContext): Promise<void> {
  if (context.actor.role === "ACCOUNT") {
    const rows = await context.db.query(
      `select 1 from accounts account
       join entitlements entitlement on entitlement.account_id=account.id
         and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
         and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
       join node_brains node on node.account_id=account.id and node.id=$2 and node.status='ACTIVE'
       join conversations conversation on conversation.account_id=account.id
         and conversation.node_brain_id=node.id and conversation.id=$3 and conversation.status='OPEN'
       where account.id=$1 and account.status='ACTIVE'
       for update of account,entitlement,node,conversation`,
      [context.actor.accountId, context.actor.nodeBrainId, context.actor.conversationId],
    );
    if (rows.length !== 1) throw new Error("RECALL_ACCOUNT_FORBIDDEN");
    return;
  }
  const rows = await context.db.query<{ scopes: MemoryScope[] } & Record<string, unknown>>(
    `select scopes from recall_actor_authorities where role=$1 and actor_id=$2 and active
     for update`,
    [context.actor.role, context.actor.actorId],
  );
  if (rows.length !== 1 || context.scopes.some((scope) => !rows[0].scopes.includes(scope))) {
    throw new Error("RECALL_ACTOR_FORBIDDEN");
  }
}

interface ProposalAuthorizationSnapshot extends Record<string, unknown> {
  readonly proposal_id: string;
  readonly disclosure_id: string;
  readonly conversation_id: string;
}

async function acquireProposalLocks(
  database: EventDatabase,
  rows: readonly ProposalAuthorizationSnapshot[],
): Promise<void> {
  if (rows.length === 0) return;
  const keys = [...new Set(rows.flatMap((row) => [
    `proposal-disclosure:${row.disclosure_id}`,
    `proposal-state:${row.proposal_id}`,
  ]))].sort();
  await database.query(
    `select pg_advisory_xact_lock(hashtextextended(item,0))
     from unnest($1::text[]) item order by item`,
    [keys],
  );
}

const ACTIVE_PROPOSAL_AUTHORITY_SQL = `
  from proposals proposal
  join proposal_disclosure_authorizations disclosure
    on disclosure.id=proposal.disclosure_authorization_id
  join lateral (
    select transition.to_status from proposal_status_transitions transition
    where transition.proposal_id=proposal.id
    order by transition.ordinal desc limit 1
  ) status on true
  left join proposal_disclosure_revocations revoked on revoked.authorization_id=disclosure.id
  where proposal.privacy_scope='PROPOSAL_RAW_TEXT'
    and revoked.authorization_id is null and disclosure.expires_at>clock_timestamp()
    and status.to_status not in ('WITHDRAWN','REJECTED')`;

async function lockProposalAuthorizations(
  context: RecallAuthorizationContext,
): Promise<readonly ProposalAuthorizationSnapshot[]> {
  if (context.actor.role !== "MAIN_BRAIN") return Object.freeze([]);
  const rows = await context.db.query<ProposalAuthorizationSnapshot>(
    `/* recall-proposal-authority-scan */
     select proposal.id::text proposal_id,disclosure.id::text disclosure_id,
            proposal.conversation_id::text conversation_id
     ${ACTIVE_PROPOSAL_AUTHORITY_SQL}
     order by disclosure_id,proposal_id limit ${MAX_PROPOSAL_AUTHORIZATIONS + 1}`,
  );
  if (rows.length > MAX_PROPOSAL_AUTHORIZATIONS) throw new Error("RECALL_PROPOSAL_AUTHORITY_LIMIT");
  await acquireProposalLocks(context.db, rows);
  if (rows.length === 0) return Object.freeze([]);
  const current = await context.db.query<ProposalAuthorizationSnapshot>(
    `select proposal.id::text proposal_id,disclosure.id::text disclosure_id,
            proposal.conversation_id::text conversation_id
     ${ACTIVE_PROPOSAL_AUTHORITY_SQL}
       and proposal.id=any($1::uuid[])
     order by disclosure.id,proposal.id`,
    [rows.map(({ proposal_id }) => proposal_id)],
  );
  return Object.freeze(current.map((row) => Object.freeze(row)));
}

async function revalidateCandidateBodies<T extends {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly bodyEventId: string;
}>(
  context: RecallAuthorizationContext,
  candidates: readonly T[],
  additionalEventIds: readonly string[] = [],
): Promise<readonly T[]> {
  const recallable = candidates.length === 0 ? [] : await context.db.query<{
    id: string;
  } & Record<string, unknown>>(
    `select memory.id::text from memory_records memory
      where memory.id=any($1::uuid[]) and ${importedMemoryLifecycleSql("memory", true)}
      order by memory.id`,
    [candidates.map(({ id }) => id)],
  );
  const recallableIds = new Set(recallable.map(({ id }) => id));
  const revalidatedCandidates = candidates.filter(({ id }) => recallableIds.has(id));
  const bodyEventIds = [...new Set(revalidatedCandidates.map(({ bodyEventId }) => bodyEventId))];
  if (bodyEventIds.length === 0) {
    if (additionalEventIds.length > 0) {
      await lockAvailableMemorySourceBodies(context.db, [], additionalEventIds);
    }
    return Object.freeze(revalidatedCandidates);
  }
  if (context.actor.role !== "MAIN_BRAIN") {
    const allowedClause = context.actor.role === "ACCOUNT"
      ? `(sibling.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
          or (sibling.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
            and sibling.account_id=$2 and sibling.node_brain_id=$3
            and sibling.conversation_id=$4))`
      : "sibling.scope=any($2::text[])";
    const parameters = context.actor.role === "ACCOUNT"
      ? [bodyEventIds, context.actor.accountId, context.actor.nodeBrainId,
          context.actor.conversationId]
      : [bodyEventIds, context.scopes];
    const authorized = await context.db.query<{ body_event_id: string } & Record<string, unknown>>(
      `/* recall-body-authority */
       select distinct body.body_event_id::text
       from memory_records body where body.body_event_id=any($1::uuid[])
         and not exists (
           select 1 from memory_records sibling where sibling.body_event_id=body.body_event_id
             and not ${allowedClause}
         )
       order by body_event_id`,
      parameters,
    );
    const authorizedBodyIds = authorized.map(({ body_event_id }) => body_event_id);
    const locked = authorizedBodyIds.length === 0 && additionalEventIds.length === 0
      ? [] : await lockAvailableMemorySourceBodies(
        context.db, authorizedBodyIds, additionalEventIds,
      );
    const allowed = new Set(locked);
    return Object.freeze(revalidatedCandidates.filter(({ bodyEventId }) => allowed.has(bodyEventId)));
  }
  const authorities = await context.db.query<ProposalAuthorizationSnapshot>(
    `/* recall-proposal-body-authority */
     select distinct proposal.id::text proposal_id,disclosure.id::text disclosure_id,
            proposal.conversation_id::text conversation_id
     ${ACTIVE_PROPOSAL_AUTHORITY_SQL}
       and exists (
         select 1 from memory_records memory where memory.body_event_id=any($1::uuid[])
           and memory.scope='PRIVATE_ACCOUNT'
           and not exists (
             select 1 from memory_sources source where source.memory_id=memory.id
               and not (proposal.source_event_ids ? source.source_event_id::text)
           )
       )
     order by disclosure_id,proposal_id limit ${MAX_PROPOSAL_AUTHORIZATIONS + 1}`,
    [bodyEventIds],
  );
  const boundedAuthorities = authorities.length > MAX_PROPOSAL_AUTHORIZATIONS
    ? Object.freeze([]) : authorities;
  await acquireProposalLocks(context.db, boundedAuthorities);
  const authorized = await context.db.query<{ body_event_id: string } & Record<string, unknown>>(
    `/* recall-body-authority */
     select distinct body.body_event_id::text
     from memory_records body where body.body_event_id=any($1::uuid[])
       and not exists (
         select 1 from memory_records sibling where sibling.body_event_id=body.body_event_id
           and sibling.scope not in ('PRIVATE_ACCOUNT','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
       )
       and (not exists (
         select 1 from memory_records private_sibling
         where private_sibling.body_event_id=body.body_event_id
           and private_sibling.scope='PRIVATE_ACCOUNT'
       ) or exists (
         select 1 ${ACTIVE_PROPOSAL_AUTHORITY_SQL}
           and proposal.id=any($2::uuid[])
           and not exists (
             select 1 from memory_records private_sibling
             join memory_sources source on source.memory_id=private_sibling.id
             where private_sibling.body_event_id=body.body_event_id
               and private_sibling.scope='PRIVATE_ACCOUNT'
               and not (proposal.source_event_ids ? source.source_event_id::text)
           )
       ))
     order by body_event_id`,
    [bodyEventIds, boundedAuthorities.map(({ proposal_id }) => proposal_id)],
  );
  const authorizedBodyIds = authorized.map(({ body_event_id }) => body_event_id);
  const locked = authorizedBodyIds.length === 0 && additionalEventIds.length === 0
    ? [] : await lockAvailableMemorySourceBodies(
      context.db, authorizedBodyIds, additionalEventIds,
    );
  const allowed = new Set(locked);
  return Object.freeze(revalidatedCandidates.filter(({ bodyEventId }) => allowed.has(bodyEventId)));
}

async function loadRecallSnapshot(context: RecallAuthorizationContext): Promise<{
  readonly stateVersions: RecallStateVersions;
  readonly highWaterSequence: string;
}> {
  const row = await context.db.one<{
    main_version: string | null;
    challenge_version: string | null;
    node_version: string | null;
    high_water_sequence: string;
  } & Record<string, unknown>>(
    `select
       (select max(version)::text from main_state_versions) main_version,
       (select concat(stage.id::text,':',checkpoint.high_water_sequence::text)
        from challenge_stages stage
        join challenge_projection_checkpoints checkpoint on checkpoint.stage_id=stage.id
        order by stage.ordinal desc,stage.created_at desc,stage.id desc limit 1) challenge_version,
       (select event.ingested_sequence::text from events event
          where $1::text is not null and event.aggregate_id=$1
            and event.account_id=$2 and event.type='node.reply.routed'
            and event.visibility='PRIVATE_ACCOUNT'
          order by event.ingested_sequence desc,event.id desc limit 1) node_version,
       (select coalesce(max(ingested_sequence),0)::text from events) high_water_sequence`,
    [context.actor.role === "ACCOUNT" ? context.actor.conversationId : null,
      context.actor.role === "ACCOUNT" ? context.actor.accountId : null],
  );
  return Object.freeze({
    stateVersions: Object.freeze({
      main: row.main_version,
      challenge: row.challenge_version,
      node: row.node_version,
    }),
    highWaterSequence: row.high_water_sequence,
  });
}

function workingEntry(
  kind: RecallContextEntry["kind"], id: string, scope: MemoryScope,
  excerpt: string, versionValue: string | null, createdAt: Date | string,
  contentKind: RecallContextEntry["contentKind"],
): RecallContextEntry {
  return Object.freeze({
    kind, id, scope, excerpt: excerpt.slice(0, 4_000), version: versionValue,
    sourceEventIds: Object.freeze([id]), confidence: null,
    createdAt: new Date(createdAt).toISOString(), supersedesMemoryId: null, contentKind,
  });
}

async function loadWorkingContext(
  context: RecallAuthorizationContext,
  additionalEventIds: readonly string[],
  snapshot: { readonly stateVersions: RecallStateVersions; readonly highWaterSequence: string },
  authorizeAdditionalEventIds?: (
    contextEventIds: readonly string[],
  ) => Promise<readonly string[]>,
): Promise<{
  readonly entries: readonly RecallContextEntry[];
  readonly bodies: readonly { readonly eventId: string; readonly body: JsonValue }[];
  readonly authorizedAdditionalEventIds: readonly string[];
}> {
  const main = await context.db.query<{
    event_id: string; version: string; created_at: Date;
  } & Record<string, unknown>>(
    `select broadcast.commit_event_id::text event_id,broadcast.main_state_version::text version,
            event.occurred_at created_at
     from broadcasts broadcast join events event on event.id=broadcast.commit_event_id
     where broadcast.main_state_version::text is not distinct from $1
     order by broadcast.committed_at desc,broadcast.id limit 1`,
    [snapshot.stateVersions.main],
  );
  const node = context.actor.role === "ACCOUNT" ? await context.db.query<{
    event_id: string; version: string; created_at: Date;
  } & Record<string, unknown>>(
    `select event.id::text event_id,event.ingested_sequence::text version,event.occurred_at created_at
     from events event where event.aggregate_id=$1 and event.account_id=$2
       and event.type='node.reply.routed' and event.visibility='PRIVATE_ACCOUNT'
       and event.ingested_sequence<=$3::bigint
     order by event.ingested_sequence desc,event.id desc limit 1`,
    [context.actor.conversationId, context.actor.accountId, snapshot.highWaterSequence],
  ) : [];
  const recent = context.actor.role === "ACCOUNT" ? await context.db.query<{
    event_id: string; role: string; created_at: Date;
  } & Record<string, unknown>>(
    `select message.event_id::text,message.role,message.occurred_at created_at
     from messages message join events source_event on source_event.id=message.event_id
     where message.conversation_id=$1 and message.account_id=$2
       and message.status='COMPLETED'
       and source_event.ingested_sequence<=$4::bigint
     order by message.occurred_at desc,message.event_id desc limit $3`,
    [context.actor.conversationId, context.actor.accountId, MAX_RECENT_TURNS,
      snapshot.highWaterSequence],
  ) : [];
  const challenge = await context.db.query<{
    id: string; version: string; type: string; projection: JsonValue; created_at: Date;
    stage_id: string; profile_version_id: string; high_water_sequence: string;
  } & Record<string, unknown>>(
    `select event.id::text,
            concat(stage.id::text,':',checkpoint.high_water_sequence::text) version,
            event.type,checkpoint.projection,event.occurred_at created_at,
            stage.id::text stage_id,stage.profile_version_id::text profile_version_id,
            checkpoint.high_water_sequence::text high_water_sequence
     from challenge_stages stage
     join challenge_projection_checkpoints checkpoint on checkpoint.stage_id=stage.id
     join challenge_ledger_events event on event.id=checkpoint.high_water_event_id
     where concat(stage.id::text,':',checkpoint.high_water_sequence::text) is not distinct from $1
     order by stage.ordinal desc,stage.created_at desc,stage.id desc limit 1`,
    [snapshot.stateVersions.challenge],
  );
  const contextEventIds = [...new Set(
    [...main, ...node, ...recent].map(({ event_id }) => event_id),
  )];
  const authorizedAdditionalEventIds = authorizeAdditionalEventIds
    ? await authorizeAdditionalEventIds(contextEventIds) : additionalEventIds;
  const eventIds = [...new Set([
    ...authorizedAdditionalEventIds,
    ...contextEventIds,
  ])];
  const bodies = eventIds.length === 0 ? [] : await readEventBodies(context.db, eventIds, {
    actor: context.actor.role === "ACCOUNT"
      ? { role: "ACCOUNT", accountId: context.actor.accountId }
      : context.actor.role === "OPERATOR"
        ? { role: "OPERATOR", purpose: context.actor.purpose }
        : { role: "SYSTEM" },
  });
  const byId = new Map(bodies.map(({ eventId, body }) => [eventId, body]));
  const text = (eventId: string, keyName: string) => {
    const body = byId.get(eventId);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof body[keyName] !== "string") throw new Error("RECALL_WORKING_CONTEXT_INVALID");
    return body[keyName];
  };
  const entries: RecallContextEntry[] = [];
  if (main[0]) entries.push(workingEntry(
    "MAIN_STATE", main[0].event_id, "MAIN_SHARED", text(main[0].event_id, "body"),
    main[0].version, main[0].created_at, "CANONICAL_STATE",
  ));
  if (node[0]) entries.push(workingEntry(
    "NODE_STATE", node[0].event_id, "NODE_BRANCH",
    JSON.stringify(byId.get(node[0].event_id)), node[0].version,
    node[0].created_at, "CANONICAL_STATE",
  ));
  if (challenge[0]) entries.push(workingEntry(
    "CHALLENGE_STATE", challenge[0].id, "CHALLENGE_SHARED",
    JSON.stringify({ type: challenge[0].type, stageId: challenge[0].stage_id,
      profileVersionId: challenge[0].profile_version_id,
      highWaterSequence: challenge[0].high_water_sequence,
      projection: challenge[0].projection }), challenge[0].version,
    challenge[0].created_at, "CANONICAL_STATE",
  ));
  for (const turn of recent) entries.push(workingEntry(
    "RECENT_TURN", turn.event_id, "PRIVATE_ACCOUNT", text(turn.event_id, "text"),
    null, turn.created_at, "ORIGINAL_EVENT",
  ));
  return Object.freeze({
    entries: Object.freeze(entries), bodies: Object.freeze(bodies),
    authorizedAdditionalEventIds: Object.freeze([...authorizedAdditionalEventIds]),
  });
}

async function recallAuthorizedCaptured(
  context: RecallAuthorizationContext,
  input: CapturedAuthorizedInput,
  startedAt: number,
): Promise<RecallResult> {
  await revalidateActor(context);
  await lockProposalAuthorizations(context);
  const snapshot = await loadRecallSnapshot(context);
  const identity = requestIdentity(context, input);
  const replay = await lookupRecallTrace(
    context.db, context.actor, input.idempotencyKey, identity,
  );
  if (replay) {
    const replayRows = replay.selectedMemoryIds.length === 0 ? [] : await runCandidateChannel(
      context.db, context.actor, "RECENT", "m.id=any($1::uuid[])",
      [replay.selectedMemoryIds], input.graphDepth, replay.highWaterSequence,
      MAX_CONTEXT_MEMORIES, true,
    );
    const byMemoryId = new Map(replayRows.map((row) => [row.id, row]));
    if (replay.selectedMemoryIds.some((id) => !byMemoryId.has(id))) {
      throw new Error("RECALL_REPLAY_UNAVAILABLE");
    }
    const metadata = replay.selectedMemoryIds.map((id) => {
      const row = byMemoryId.get(id)!;
      return Object.freeze({ ...rowCandidate(row, "RECENT"), bodyEventId: row.body_event_id });
    });
    const working = await loadWorkingContext(
      context, metadata.map(({ bodyEventId }) => bodyEventId), replay,
      async (contextEventIds) => (await revalidateCandidateBodies(
        context, metadata, contextEventIds,
      ))
        .map(({ bodyEventId }) => bodyEventId),
    );
    const authorizedBodyIds = new Set(working.authorizedAdditionalEventIds);
    const memories = parseMemoryBodies(
      metadata.filter(({ bodyEventId }) => authorizedBodyIds.has(bodyEventId)), working.bodies,
    );
    const pack = contextPack(memories, working.entries);
    if (pack.estimatedTokens > input.tokenBudget) {
      throw new Error("RECALL_TOKEN_BUDGET_TOO_SMALL");
    }
    if (performance.now() - startedAt > MAX_RECALL_TIME_MILLISECONDS) {
      throw new Error("RECALL_TIME_LIMIT");
    }
    return Object.freeze({ memories, excluded: replay.excluded, contextPack: pack, trace: replay });
  }
  const { stateVersions, highWaterSequence } = snapshot;
  const cacheKey = canonicalContentDigest({
    request: identity,
    stateVersions,
    highWaterSequence,
  });
  let cacheUse: "BYPASS" | "HIT" | "MISS" = "BYPASS";
  if (context.cache) {
    await context.cache.get(cacheKey);
    // Cached values are deliberately advisory until a versioned, authorization-aware
    // hydration format exists. They can never authorize access or be reported as a hit.
    cacheUse = "MISS";
  }
  if (input.queryVector && input.embeddingVersion) {
    await backfillHistoricalMemoryVectorBuckets(
      createMemoryWorkerContext(context.db), vectorBackfillDomains(context), input.embeddingVersion,
    );
  }
  const terms = queryTerms(input.query);
  const entityTerms = input.entities.length > 0 ? input.entities.map((item) => item.toLowerCase()) : terms;
  // Main never derives proposal-private term digests. Proposal lexical candidates
  // come from indexed source membership and are checked against plaintext only
  // after final authority revalidation. Shared scope digests remain available.
  const protectedDigests = await protectedTermDigests(
    context, { KEYWORD: terms, ENTITY: entityTerms }, input.queryVector, input.embeddingVersion,
  );
  const keywordDigests = protectedDigests.KEYWORD;
  const entityDigests = protectedDigests.ENTITY;
  const publicVectorDigests = input.queryVector && input.embeddingVersion
    ? memoryVectorBucketDigests({
      vector: input.queryVector, scope: "PUBLIC",
      embeddingVersion: input.embeddingVersion, indexKey: null,
    })
    : Object.freeze([]);
  const vectorDigests = Object.freeze([...new Set([
    ...publicVectorDigests, ...protectedDigests.VECTOR,
  ])]);
  const nonGraphChannels = await Promise.all([
    runCandidateChannel(context.db, context.actor, "CURRENT_STATE",
      "m.scope in ('MAIN_SHARED','CHALLENGE_SHARED') and m.valid_to is null and m.conflict_state='CURRENT'",
      [], input.graphDepth, highWaterSequence),
    runCandidateChannel(context.db, context.actor, "RECENT", "true", [], input.graphDepth,
      highWaterSequence),
    runCandidateChannel(context.db, context.actor, "ENTITY",
      `channel_term.kind='ENTITY'
        and ((channel_term.scope='PUBLIC' and channel_term.term_text=any($1::text[]))
          or (channel_term.scope<>'PUBLIC' and channel_term.term_digest=any($2::text[])))`,
      [entityTerms, entityDigests], input.graphDepth, highWaterSequence),
    runCandidateChannel(context.db, context.actor, "TIME",
      "m.source_to>=coalesce($1::timestamptz,'-infinity') and m.source_from<=coalesce($2::timestamptz,'infinity')",
      [input.from, input.to], input.graphDepth, highWaterSequence,
      MAX_QUERY_CANDIDATES, false, input.from !== null || input.to !== null),
    runCandidateChannel(context.db, context.actor, "FULL_TEXT",
      `channel_term.kind='KEYWORD'
        and ((channel_term.scope='PUBLIC' and (channel_term.term_text=any($1::text[])
          or to_tsvector('simple',channel_term.term_text) @@ plainto_tsquery('simple',$3)))
          or (channel_term.scope<>'PUBLIC' and channel_term.term_digest=any($2::text[])))`,
      [terms, keywordDigests, input.query], input.graphDepth, highWaterSequence),
    runCandidateChannel(context.db, context.actor, "VECTOR",
      "m.has_embedding and m.embedding_version=$2 and $1::real[] is not null and cardinality($3::text[])>0",
      [input.queryVector, input.embeddingVersion ?? "unavailable", vectorDigests], input.graphDepth,
      highWaterSequence),
    runCandidateChannel(context.db, context.actor, "PROCEDURE", "m.type='PROCEDURAL'", [],
      input.graphDepth, highWaterSequence),
    runCandidateChannel(context.db, context.actor, "GOAL", "m.type='GOAL' and m.goal_status='OPEN'", [],
      input.graphDepth, highWaterSequence),
  ]);
  const publicVectorRows = nonGraphChannels[5]
    .filter(({ scope }) => scope === "PUBLIC").slice(0, MAX_QUERY_CANDIDATES);
  const protectedVectorRows = nonGraphChannels[5]
    .filter(({ scope }) => scope !== "PUBLIC").slice(0, MAX_DATABASE_CANDIDATES);
  const boundedNonGraphChannels = nonGraphChannels.map((rows, index) => (
    index === 5 ? publicVectorRows : rows
  ));
  const graphAnchors = [...new Set([
    ...boundedNonGraphChannels[2], ...boundedNonGraphChannels[4],
    ...publicVectorRows, ...boundedNonGraphChannels[1],
  ].map(({ id }) => id))].slice(0, MAX_QUERY_CANDIDATES);
  const graphChannel = graphAnchors.length === 0 ? [] : await runGraphChannel(
    context.db, context.actor, graphAnchors, input.graphDepth, highWaterSequence,
  );
  const channels = [
    ...boundedNonGraphChannels.slice(0, 6), graphChannel, ...boundedNonGraphChannels.slice(6),
  ];
  const fused = fuseBoundedRecallChannels(channels.map((rows, index) => rows.map((row) => (
    Object.freeze({ ...rowCandidate(row, RECALL_QUERY_KINDS[index]), bodyEventId: row.body_event_id })
  ))), MAX_DATABASE_CANDIDATES);
  const protectedVectorCandidates = protectedVectorRows.map((row) => Object.freeze({
    ...rowCandidate(row, "VECTOR"), bodyEventId: row.body_event_id,
  }));
  const metadata = fuseBoundedRecallChannels(
    [fused, protectedVectorCandidates], MAX_HYDRATED_DATABASE_CANDIDATES,
  );
  const bodyEventIds = [...new Set(metadata.map(({ bodyEventId }) => bodyEventId))];
  const working = await loadWorkingContext(context, bodyEventIds, snapshot,
    async (contextEventIds) => (await revalidateCandidateBodies(
      context, metadata, contextEventIds,
    ))
      .map(({ bodyEventId }) => bodyEventId));
  const authorizedBodyIds = new Set(working.authorizedAdditionalEventIds);
  const authorizedMetadata = metadata.filter(({ bodyEventId }) => authorizedBodyIds.has(bodyEventId));
  const vectorFusedMetadata = exactProtectedVectorFusion(
    authorizedMetadata, working.bodies, input.queryVector, input.embeddingVersion,
  );
  const lexicalFusedMetadata = exactProposalLexicalFusion(
    vectorFusedMetadata, working.bodies, terms, context.actor,
  );
  const candidates = parseMemoryBodies(lexicalFusedMetadata, working.bodies);
  const workingEntries = working.entries;
  const plan = planCapturedRecall(capturePlanInput({
    actor: context.actor,
    query: input.query,
    maxMemories: input.maxMemories,
    tokenBudget: input.tokenBudget,
    candidates,
  }), true, workingEntries);
  const elapsed = performance.now() - startedAt;
  if (elapsed > MAX_RECALL_TIME_MILLISECONDS) throw new Error("RECALL_TIME_LIMIT");
  const latencyMilliseconds = Math.max(0, Math.round(elapsed * 1_000) / 1_000);
  const stored = await persistRecallTrace(context.db, {
    actor: context.actor,
    authorizedScopes: context.scopes,
    query: input.query,
    queryPlan: queryPlan(input.graphDepth),
    candidates,
    excluded: plan.excluded,
    selected: plan.memories,
    cacheUse,
    latencyMilliseconds,
    responseId: input.responseId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    policyVersion: input.policyVersion,
    modelVersion: input.modelVersion,
    plannerVersion: input.plannerVersion,
    stateVersions,
    highWaterSequence,
    requestIdentity: identity,
    contextEntries: workingEntries.filter(({ kind }) => kind !== "DERIVED_MEMORY") as readonly {
      readonly kind: "MAIN_STATE" | "NODE_STATE" | "CHALLENGE_STATE" | "RECENT_TURN";
      readonly id: string; readonly scope: MemoryScope; readonly version: string | null;
      readonly contentKind: "ORIGINAL_EVENT" | "CANONICAL_STATE";
      readonly excerpt: string; readonly createdAt: string;
    }[],
  });
  if (performance.now() - startedAt > MAX_RECALL_TIME_MILLISECONDS) {
    throw new Error("RECALL_TIME_LIMIT");
  }
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const storedSelection = stored.selectedMemoryIds.map((memoryId) => {
    const candidate = candidatesById.get(memoryId);
    if (!candidate) throw new Error("RECALL_REPLAY_UNAVAILABLE");
    return candidate;
  });
  const memories = Object.freeze(storedSelection);
  return Object.freeze({
    memories,
    excluded: stored.excluded,
    contextPack: contextPack(memories, workingEntries),
    trace: stored,
  });
}

export async function recallAuthorized(
  context: RecallAuthorizationContext,
  rawInput: unknown,
): Promise<RecallResult> {
  if (!context || typeof context !== "object" || !contextBrands.has(context)) {
    throw new Error("RECALL_CONTEXT_INVALID");
  }
  const input = captureAuthorizedInput(rawInput);
  return context.db.transaction(async (transaction) => {
    const startedAt = performance.now();
    await transaction.query("set local statement_timeout='1000ms'");
    const scoped = Object.freeze({ ...context, db: transaction });
    const result = await recallAuthorizedCaptured(scoped, input, startedAt);
    const remainingMilliseconds = MAX_RECALL_TIME_MILLISECONDS - (performance.now() - startedAt);
    if (remainingMilliseconds <= 0) throw new Error("RECALL_TIME_LIMIT");
    await transaction.query("select set_config('statement_timeout',$1,true)", [
      `${Math.max(1, Math.floor(remainingMilliseconds))}ms`,
    ]);
    if (performance.now() - startedAt > MAX_RECALL_TIME_MILLISECONDS) {
      throw new Error("RECALL_TIME_LIMIT");
    }
    return result;
  });
}
