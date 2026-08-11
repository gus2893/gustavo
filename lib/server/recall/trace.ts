import { randomUUID } from "node:crypto";
import { appendEvent, readEventBody } from "../events/store";
import { canonicalContentDigest } from "../events/integrity";
import type { EventActor, EventDatabase, EventVisibility, JsonValue } from "../events/types";
import type { MemoryScope } from "../memory/types";
import type { RecallCandidate, RecallExcluded } from "./rank";

export type RecallActor =
  | { readonly role: "MAIN_BRAIN"; readonly actorId: "gustavo-main" }
  | {
      readonly role: "ACCOUNT";
      readonly accountId: string;
      readonly nodeBrainId: string;
      readonly conversationId: string;
    }
  | {
      readonly role: "SYSTEM" | "OPERATOR";
      readonly actorId: string;
      readonly purpose: string;
      readonly scopes: readonly MemoryScope[];
    };

export const RECALL_QUERY_KINDS = Object.freeze([
  "CURRENT_STATE", "RECENT", "ENTITY", "TIME", "FULL_TEXT",
  "VECTOR", "GRAPH", "PROCEDURE", "GOAL",
] as const);
export type RecallQueryKind = typeof RECALL_QUERY_KINDS[number];

export interface RecallQueryPlanStep {
  readonly kind: RecallQueryKind;
  readonly limit: number;
  readonly depth: number;
}

export interface RecallTraceDraft {
  readonly queryPlan: readonly RecallQueryPlanStep[];
  readonly authorizedCandidateIds: readonly string[];
  readonly excluded: readonly RecallExcluded[];
  readonly selectedMemoryIds: readonly string[];
  readonly selectedSourceIds: readonly string[];
  readonly cacheUse: "BYPASS" | "HIT" | "MISS";
}

export interface RecallStateVersions {
  readonly main: string | null;
  readonly challenge: string | null;
  readonly node: string | null;
}

export interface StoredRecallTrace extends RecallTraceDraft {
  readonly id: string;
  readonly eventId: string;
  readonly responseId: string;
  readonly latencyMilliseconds: number;
  readonly highWaterSequence: string;
  readonly stateVersions: RecallStateVersions;
  readonly createdAt: string;
}

interface TraceRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_id: string;
  readonly response_id: string;
  readonly latency_ms: number;
  readonly high_water_sequence: string;
  readonly state_versions: unknown;
  readonly created_at: Date;
  readonly request_digest: string;
  readonly body_digest: string;
  readonly query_plan: unknown;
  readonly authorized_candidate_ids: unknown;
  readonly exclusions: unknown;
  readonly selected_memory_ids: unknown;
  readonly selected_source_ids: unknown;
  readonly cache_use: "BYPASS" | "HIT" | "MISS";
  readonly body_available: boolean;
}

export interface PersistRecallTraceInput {
  readonly actor: RecallActor;
  readonly authorizedScopes: readonly MemoryScope[];
  readonly query: string;
  readonly queryPlan: readonly RecallQueryPlanStep[];
  readonly candidates: readonly RecallCandidate[];
  readonly excluded: readonly RecallExcluded[];
  readonly selected: readonly RecallCandidate[];
  readonly cacheUse: "BYPASS" | "HIT" | "MISS";
  readonly latencyMilliseconds: number;
  readonly responseId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly policyVersion: string;
  readonly modelVersion: string;
  readonly plannerVersion: string;
  readonly stateVersions: RecallStateVersions;
  readonly highWaterSequence: string;
  readonly requestIdentity: JsonValue;
  readonly contextEntries: readonly {
    readonly kind: "MAIN_STATE" | "NODE_STATE" | "CHALLENGE_STATE" | "RECENT_TURN";
    readonly id: string;
    readonly scope: MemoryScope;
    readonly version: string | null;
    readonly contentKind: "ORIGINAL_EVENT" | "CANONICAL_STATE";
    readonly excerpt: string;
    readonly createdAt: string;
  }[];
}

function eventActor(actor: RecallActor): EventActor {
  if (actor.role === "MAIN_BRAIN") return { type: "MAIN_BRAIN", id: "gustavo-main" };
  if (actor.role === "ACCOUNT") return { type: "USER", id: actor.accountId };
  if (actor.role === "OPERATOR") return { type: "OPERATOR", id: actor.actorId };
  return { type: "SYSTEM", id: actor.actorId };
}

function eventVisibility(actor: RecallActor): EventVisibility {
  if (actor.role === "ACCOUNT") return "PRIVATE_ACCOUNT";
  if (actor.role === "MAIN_BRAIN") return "SHARED";
  return "OPERATOR";
}

function aggregateId(actor: RecallActor): string {
  if (actor.role === "ACCOUNT") return actor.conversationId;
  if (actor.role === "MAIN_BRAIN") return "gustavo-main";
  return `recall:${actor.role.toLowerCase()}:${actor.actorId}`;
}

function accountId(actor: RecallActor): string | null {
  return actor.role === "ACCOUNT" ? actor.accountId : null;
}

function jsonArray(value: unknown, error: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(error);
  }
  return Object.freeze([...value]);
}

function storedTrace(row: TraceRow): StoredRecallTrace {
  if (!row.body_available) throw new Error("RECALL_REPLAY_UNAVAILABLE");
  if (!Array.isArray(row.query_plan)) throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
  const queryPlan = Object.freeze(row.query_plan.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
    }
    const item = value as Record<string, unknown>;
    if (typeof item.kind !== "string" || typeof item.limit !== "number"
      || typeof item.depth !== "number") throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
    return Object.freeze({
      kind: item.kind as RecallQueryKind,
      limit: item.limit,
      depth: item.depth,
    });
  }));
  const exclusionsValue = row.exclusions;
  if (!Array.isArray(exclusionsValue)) throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
  const excluded = Object.freeze(exclusionsValue.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
    }
    const item = value as { id?: unknown; reason?: unknown };
    if (typeof item.id !== "string" || typeof item.reason !== "string") {
      throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
    }
    return Object.freeze({ id: item.id, reason: item.reason as RecallExcluded["reason"] });
  }));
  if (!row.state_versions || typeof row.state_versions !== "object"
    || Array.isArray(row.state_versions)) throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
  const state = row.state_versions as Record<string, unknown>;
  if (![state.main, state.challenge, state.node].every((value) => (
    value === null || typeof value === "string"
  ))) throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
  return Object.freeze({
    id: row.id,
    eventId: row.event_id,
    responseId: row.response_id,
    queryPlan,
    authorizedCandidateIds: jsonArray(row.authorized_candidate_ids, "RECALL_TRACE_INTEGRITY_FAILURE"),
    excluded,
    selectedMemoryIds: jsonArray(row.selected_memory_ids, "RECALL_TRACE_INTEGRITY_FAILURE"),
    selectedSourceIds: jsonArray(row.selected_source_ids, "RECALL_TRACE_INTEGRITY_FAILURE"),
    cacheUse: row.cache_use,
    latencyMilliseconds: row.latency_ms,
    highWaterSequence: row.high_water_sequence,
    stateVersions: Object.freeze({
      main: state.main as string | null,
      challenge: state.challenge as string | null,
      node: state.node as string | null,
    }),
    createdAt: new Date(row.created_at).toISOString(),
  });
}

const TRACE_COLUMNS = `
  trace.id::text,trace.event_id::text,trace.response_id::text,trace.latency_ms,
  trace.high_water_sequence::text,trace.state_versions,trace.created_at,
  trace.request_digest,trace.body_digest,trace.query_plan,trace.authorized_candidate_ids,trace.exclusions,
  trace.selected_memory_ids,trace.selected_source_ids,trace.cache_use,
  exists (select 1 from encrypted_event_bodies trace_body
    join aggregate_data_keys trace_key on trace_key.id=trace_body.data_key_id
    where trace_body.event_id=trace.event_id) body_available
`;

const TRACE_FROM = "recall_traces trace";

async function storedRequestDigest(
  database: EventDatabase,
  eventId: string,
  expectedBodyDigest: string,
): Promise<string> {
  const body = await readEventBody(database, eventId, { actor: { role: "SYSTEM" } });
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.requestDigest !== "string"
    || canonicalContentDigest(body) !== expectedBodyDigest) {
    throw new Error("RECALL_TRACE_INTEGRITY_FAILURE");
  }
  return body.requestDigest;
}

function traceActorId(actor: RecallActor): string {
  return actor.role === "ACCOUNT" ? actor.accountId : actor.actorId;
}

function traceScopeKey(actor: RecallActor, idempotencyKey: string): string {
  return canonicalContentDigest({ actor, key: idempotencyKey });
}

export async function lookupRecallTrace(
  database: EventDatabase,
  actor: RecallActor,
  idempotencyKey: string,
  requestIdentity: JsonValue,
): Promise<StoredRecallTrace | null> {
  const requestDigest = canonicalContentDigest(requestIdentity);
  const scopeKey = traceScopeKey(actor, idempotencyKey);
  await database.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `recall-idempotency:${scopeKey}`,
  ]);
  const duplicates = await database.query<TraceRow>(
    `select ${TRACE_COLUMNS} from ${TRACE_FROM}
     where trace.actor_role=$1 and trace.actor_id=$2 and trace.account_id is not distinct from $3
       and trace.idempotency_key=$4`,
    [actor.role, traceActorId(actor), accountId(actor), idempotencyKey],
  );
  if (!duplicates[0]) return null;
  const bodyRequestDigest = await storedRequestDigest(
    database, duplicates[0].event_id, duplicates[0].body_digest,
  );
  if (duplicates[0].request_digest !== requestDigest || bodyRequestDigest !== requestDigest) {
    throw new Error("RECALL_IDEMPOTENCY_CONFLICT");
  }
  return storedTrace(duplicates[0]);
}

export async function persistRecallTrace(
  database: EventDatabase,
  input: PersistRecallTraceInput,
): Promise<StoredRecallTrace> {
  const selectedSourceIds = [...new Set(input.selected.flatMap(({ sourceIds }) => sourceIds))].sort();
  const authorizedCandidateIds = input.candidates.map(({ id }) => id).sort();
  const selectedMemoryIds = input.selected.map(({ id }) => id);
  const candidateAuthority = input.candidates.map((candidate) => Object.freeze({
    id: candidate.id,
    scope: candidate.scope,
    channels: [...candidate.channels],
    score: Math.round(candidate.score * 1_000_000_000) / 1_000_000_000,
  }));
  const contextAuthority = input.contextEntries.map((entry, ordinal) => Object.freeze({
    ordinal,
    kind: entry.kind,
    sourceId: entry.id,
    scope: entry.scope,
    version: entry.version,
    contentKind: entry.contentKind,
    excerptDigest: canonicalContentDigest(entry.excerpt),
    createdAt: entry.createdAt,
  }));
  const excludedById = new Map(input.excluded.map((item) => [item.id, item]));
  const exclusions = input.candidates.filter(({ id }) => !selectedMemoryIds.includes(id)).map(({ id }) => {
    const excluded = excludedById.get(id);
    if (!excluded) throw new Error("RECALL_TRACE_EXCLUSION_MISSING");
    return excluded;
  });
  const requestDigest = canonicalContentDigest(input.requestIdentity);
  const scopeKey = traceScopeKey(input.actor, input.idempotencyKey);
  return database.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `recall-idempotency:${scopeKey}`,
    ]);
    const duplicates = await transaction.query<TraceRow>(
      `select ${TRACE_COLUMNS} from ${TRACE_FROM}
       where trace.actor_role=$1 and trace.actor_id=$2
         and trace.account_id is not distinct from $3 and trace.idempotency_key=$4`,
      [input.actor.role, traceActorId(input.actor),
        accountId(input.actor), input.idempotencyKey],
    );
    if (duplicates[0]) {
      const bodyRequestDigest = await storedRequestDigest(
        transaction, duplicates[0].event_id, duplicates[0].body_digest,
      );
      if (duplicates[0].request_digest !== requestDigest || bodyRequestDigest !== requestDigest) {
        throw new Error("RECALL_IDEMPOTENCY_CONFLICT");
      }
      return storedTrace(duplicates[0]);
    }
    const traceId = randomUUID();
    const queryDigest = canonicalContentDigest(input.query);
    const authorityManifest: JsonValue = {
      traceId,
      responseId: input.responseId,
      actorRole: input.actor.role,
      actorId: traceActorId(input.actor),
      accountId: accountId(input.actor),
      nodeBrainId: input.actor.role === "ACCOUNT" ? input.actor.nodeBrainId : null,
      conversationId: input.actor.role === "ACCOUNT" ? input.actor.conversationId : null,
      purpose: input.actor.role === "SYSTEM" || input.actor.role === "OPERATOR"
        ? input.actor.purpose : null,
      authorizedScopes: [...input.authorizedScopes],
      queryDigest,
      queryPlan: input.queryPlan.map((step) => ({ ...step })),
      authorizedCandidateIds,
      authorizedCandidates: candidateAuthority,
      contextEntries: contextAuthority,
      exclusions: exclusions.map((item) => ({ ...item })),
      selectedMemoryIds,
      selectedSourceIds,
      cacheUse: input.cacheUse,
      latencyMilliseconds: input.latencyMilliseconds,
      policyVersion: input.policyVersion,
      modelVersion: input.modelVersion,
      plannerVersion: input.plannerVersion,
      stateVersions: input.stateVersions as unknown as JsonValue,
      highWaterSequence: input.highWaterSequence,
      sourceHighWaterSequence: input.highWaterSequence,
      requestDigest,
      createdAt: input.occurredAt,
    };
    const authority = await transaction.one<{ digest: string }>(
      "select recall_manifest_digest($1::jsonb) digest", [JSON.stringify(authorityManifest)],
    );
    const body: JsonValue = {
      traceId,
      responseId: input.responseId,
      actor: input.actor as unknown as JsonValue,
      authorizedScopes: [...input.authorizedScopes],
      queryDigest,
      queryPlan: input.queryPlan.map((step) => ({ ...step })),
      authorizedCandidates: candidateAuthority,
      contextEntries: contextAuthority,
      exclusions: exclusions.map((item) => ({ ...item })),
      selectedMemoryIds,
      selectedSourceIds,
      cacheUse: input.cacheUse,
      measuredLatencyMilliseconds: input.latencyMilliseconds,
      policyVersion: input.policyVersion,
      modelVersion: input.modelVersion,
      plannerVersion: input.plannerVersion,
      stateVersions: input.stateVersions as unknown as JsonValue,
      highWaterSequence: input.highWaterSequence,
      sourceHighWaterSequence: input.highWaterSequence,
      requestDigest,
      authorityManifest,
      authorityDigest: authority.digest,
    };
    const bodyDigest = canonicalContentDigest(body);
    const event = await appendEvent(transaction, {
      aggregateId: aggregateId(input.actor),
      ...(accountId(input.actor) ? { accountId: accountId(input.actor)! } : {}),
      actor: eventActor(input.actor),
      type: "memory.recall.traced",
      visibility: eventVisibility(input.actor),
      body,
      idempotencyKey: `recall-trace:${scopeKey}:${bodyDigest}`,
      occurredAt: new Date(input.occurredAt),
      promptVersion: input.plannerVersion,
      modelVersion: input.modelVersion,
      policyVersion: input.policyVersion,
    });
    const eventAuthority = await transaction.one<{
      request_hash: string; integrity_hash: string; outbox_payload_digest: string;
    }>(
      `select event.request_hash,event.integrity_hash,
              recall_manifest_digest(outbox.payload) outbox_payload_digest
       from events event join transactional_outbox outbox on outbox.event_id=event.id
       where event.id=$1 and outbox.topic='memory.recall.traced'
         and outbox.payload=jsonb_build_object('eventId',event.id)`,
      [event.id],
    );
    await transaction.query(
      `insert into recall_traces (
         id,event_id,response_id,actor_role,actor_id,account_id,node_brain_id,conversation_id,
         purpose,authorized_scopes,query_digest,query_plan,authorized_candidate_ids,exclusions,
         selected_memory_ids,selected_source_ids,cache_use,latency_ms,policy_version,
         model_version,planner_version,state_versions,high_water_sequence,idempotency_key,
         request_digest,body_authority_manifest,body_authority_digest,body_digest,
         candidate_authority,context_entries,event_request_hash,event_integrity_hash,
         outbox_payload_digest,source_high_water_sequence,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,
                 $15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,
                 $26::jsonb,$27,$28,$29::jsonb,$30::jsonb,$31,$32,$33,$34,$35)`,
      [traceId, event.id, input.responseId, input.actor.role,
        input.actor.role === "ACCOUNT" ? input.actor.accountId : input.actor.actorId,
        accountId(input.actor), input.actor.role === "ACCOUNT" ? input.actor.nodeBrainId : null,
        input.actor.role === "ACCOUNT" ? input.actor.conversationId : null,
        input.actor.role === "SYSTEM" || input.actor.role === "OPERATOR" ? input.actor.purpose : null,
        input.authorizedScopes, queryDigest, JSON.stringify(input.queryPlan),
        JSON.stringify(authorizedCandidateIds), JSON.stringify(exclusions),
        JSON.stringify(selectedMemoryIds), JSON.stringify(selectedSourceIds), input.cacheUse,
        input.latencyMilliseconds, input.policyVersion, input.modelVersion, input.plannerVersion,
        JSON.stringify(input.stateVersions), input.highWaterSequence, input.idempotencyKey,
        requestDigest, JSON.stringify(authorityManifest), authority.digest, bodyDigest,
        JSON.stringify(candidateAuthority), JSON.stringify(contextAuthority),
        eventAuthority.request_hash, eventAuthority.integrity_hash,
        eventAuthority.outbox_payload_digest, input.highWaterSequence, input.occurredAt],
    );
    const candidateRows = input.candidates.map((candidate, ordinal) => {
      const excluded = input.excluded.find(({ id }) => id === candidate.id);
      const selectedOrdinal = selectedMemoryIds.indexOf(candidate.id);
      return Object.freeze({
        memoryId: candidate.id, ordinal,
        decision: selectedOrdinal >= 0 ? "SELECTED" : "EXCLUDED",
        selectedOrdinal: selectedOrdinal >= 0 ? selectedOrdinal : null,
        channels: [...candidate.channels],
        score: Math.round(candidate.score * 1_000_000_000) / 1_000_000_000,
        exclusionReason: excluded?.reason ?? null,
      });
    });
    await transaction.query(
      `insert into recall_trace_candidates (
         trace_id,memory_id,ordinal,decision,selected_ordinal,channels,score,exclusion_reason
       ) select $1,(item->>'memoryId')::uuid,(item->>'ordinal')::integer,
                item->>'decision',(item->>'selectedOrdinal')::integer,
                array(select jsonb_array_elements_text(item->'channels')),
                (item->>'score')::numeric,item->>'exclusionReason'
         from jsonb_array_elements($2::jsonb) item`,
      [traceId, JSON.stringify(candidateRows)],
    );
    const sourceRows = input.selected.flatMap((selected) => (
      selected.sourceIds.map((sourceId, ordinal) => Object.freeze({
        memoryId: selected.id, sourceId, ordinal,
      }))
    ));
    await transaction.query(
      `insert into recall_trace_sources (trace_id,memory_id,source_event_id,ordinal)
       select $1,(item->>'memoryId')::uuid,(item->>'sourceId')::uuid,
              (item->>'ordinal')::integer
       from jsonb_array_elements($2::jsonb) item`,
      [traceId, JSON.stringify(sourceRows)],
    );
    const planRows = input.queryPlan.map((step, ordinal) => Object.freeze({ ordinal, ...step }));
    await transaction.query(
      `insert into recall_trace_plan_steps (trace_id,ordinal,kind,result_limit,graph_depth)
       select $1,(item->>'ordinal')::integer,item->>'kind',(item->>'limit')::integer,
              (item->>'depth')::integer
       from jsonb_array_elements($2::jsonb) item`,
      [traceId, JSON.stringify(planRows)],
    );
    await transaction.query(
      `insert into recall_trace_context_entries (
         trace_id,ordinal,kind,source_id,scope,version,content_kind,excerpt_digest,created_at
       ) select $1,(item->>'ordinal')::integer,item->>'kind',(item->>'sourceId')::uuid,
                item->>'scope',item->>'version',item->>'contentKind',item->>'excerptDigest',
                (item->>'createdAt')::timestamptz
         from jsonb_array_elements($2::jsonb) item`,
      [traceId, JSON.stringify(contextAuthority)],
    );
    return storedTrace(await transaction.one<TraceRow>(
      `select ${TRACE_COLUMNS} from ${TRACE_FROM} where trace.id=$1`, [traceId],
    ));
  });
}
