import { createHash, randomUUID } from "node:crypto";
import { canonicalContentDigest } from "../events/integrity";
import { appendEvent, readEventBodies } from "../events/store";
import type { EventDatabase } from "../events/types";
import type { ExtractedMemoryBase, ExtractedMemorySet, MemoryType } from "./types";
import {
  createMemoryWorkerContext,
  processMemoryEvent,
} from "../../../worker/consolidation/process-event";
import {
  createMemoryGraphWriterContext,
  versionMemoryGraph,
} from "../consolidation/graph";
import {
  authorizePrivacyTopology,
  type MemoryControlContext,
  type PrivacyActor,
} from "./controls";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_STEP_RECORDS = 500;

const CORE_FORGET_PROJECTION_REGISTRY = Object.freeze([
  { projection_type: "CONSOLIDATION_RUN", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "MEMORY_RECORD", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "MEMORY_SOURCE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "MEMORY_INDEX", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "MEMORY_VECTOR", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "MEMORY_EMBEDDING", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "EPISODE_SUMMARY", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "DOSSIER_REFRESH", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "MEMORY_CHECKPOINT", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "MEMORY_EQUIVALENCE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "RECALL_TRACE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "RECALL_TRACE_SOURCE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "RECALL_CONTEXT", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "GRAPH_NODE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "GRAPH_NODE_SOURCE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "GRAPH_EDGE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "GRAPH_EDGE_SOURCE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "GRAPH_CURRENT_HEAD", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "GRAPH_CONFLICT", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "GRAPH_JOB", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "GRAPH_RECONCILIATION", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "HANDOFF_PACKET", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "HANDOFF_CHECKPOINT", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "HANDOFF_JOB", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "CACHE_PROJECTION", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "CACHE_JOB", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "CACHE_AUTHORITY", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "CHAT_IMPORT", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "IMPORT_MEMORY", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "IMPORT_LIFECYCLE", forget_behavior: "FORGET", rebuild_behavior: "REBUILD" },
  { projection_type: "FORGET_TOMBSTONE", forget_behavior: "RETAIN_TOMBSTONE",
    rebuild_behavior: "RETAIN_TOMBSTONE" },
] as const);

const ESTABLISHED_PROJECTION_RELATIONS = Object.freeze([
  "thought_records", "thought_claims", "thought_references", "recall_actor_authorities",
  "memory_extraction_runs", "memory_records", "memory_sources", "memory_semantic_facts",
  "memory_episodes", "memory_procedures", "memory_goals", "memory_embeddings",
  "memory_index_terms", "memory_equivalence_sets", "memory_equivalence_links",
  "memory_supersession_authorizations", "memory_retrieval_stats",
  "memory_projection_checkpoints", "memory_dossier_refreshes", "memory_vector_buckets",
  "memory_vector_backfill_checkpoints", "memory_graph_edges", "recall_traces",
  "recall_trace_plan_steps", "recall_trace_candidates", "recall_trace_sources",
  "recall_trace_context_entries", "chat_source_authorizations", "chat_sources",
  "chat_source_imports", "imported_chat_conversations",
  "imported_chat_conversation_versions", "imported_chat_message_versions",
  "chat_import_quarantine", "chat_source_cursors", "chat_import_conversation_occurrences",
  "chat_import_item_occurrences", "chat_import_quarantine_occurrences",
  "chat_source_event_manifests", "memory_graph_reconciliation_runs",
  "memory_graph_idempotency_keys", "memory_graph_entities", "memory_graph_entity_versions",
  "memory_graph_run_entities", "memory_graph_entity_aliases", "memory_graph_run_aliases",
  "memory_graph_alias_sources", "memory_graph_nodes", "memory_graph_run_candidates",
  "memory_graph_node_sources", "memory_graph_current_claims",
  "memory_graph_legacy_edge_backfills", "memory_graph_run_edges",
  "memory_graph_edge_sources", "memory_conflicts", "memory_graph_run_conflicts",
  "memory_conflict_sources", "memory_graph_background_jobs",
  "memory_graph_reconciliation_jobs", "memory_graph_reconciliation_job_idempotency_keys",
  "memory_graph_reconciliation_job_entities", "memory_graph_reconciliation_job_aliases",
  "memory_graph_reconciliation_job_sources", "memory_graph_reconciliation_job_source_sets",
  "memory_graph_reconciliation_job_candidates", "memory_graph_reconciliation_job_manifests",
  "memory_graph_reconciliation_job_transitions",
  "memory_graph_reconciliation_job_transition_manifests", "memory_graph_event_manifests",
  "memory_graph_head_versions", "memory_graph_background_job_transitions",
  "memory_graph_job_transition_manifests", "memory_graph_worker_authorities",
  "handoff_packets", "handoff_packet_keys",
  "handoff_packet_ideas", "handoff_packet_manifests", "handoff_refresh_checkpoints",
  "handoff_refresh_checkpoint_keys", "handoff_refresh_checkpoint_manifests",
  "handoff_key_registry", "handoff_refresh_jobs", "handoff_refresh_job_keys",
  "handoff_refresh_job_transitions", "handoff_refresh_job_manifests",
  "handoff_refresh_job_transition_manifests", "cache_projection_jobs",
  "cache_outbox_staging", "cache_outbox_backfill_state", "cache_authority_changes",
  "cache_authority_staging", "cache_main_state_sources", "cache_projection_versions",
  "cache_rebuild_runs", "cache_rebuild_category_checks", "cache_metric_observations",
  "import_manifests", "import_source_items", "import_memory_projections",
  "import_review_queue_entries", "import_lifecycle_commands",
  "import_lifecycle_idempotency_aliases", "import_item_lifecycle_events",
  "import_verification_receipts", "import_event_authorities",
  "proposal_disclosure_authorizations", "proposal_disclosure_revocations",
  "proposal_operation_idempotency", "proposals", "proposal_evidence_links",
  "proposal_status_transitions", "proposal_turns", "proposal_turn_evidence_links",
] as const);

const FORGET_CATALOG_RELATIONS = new Set<string>([
  "thought_records", "thought_claims", "thought_references",
  "proposal_disclosure_authorizations", "proposals", "proposal_evidence_links",
  "proposal_status_transitions", "proposal_turns", "proposal_turn_evidence_links",
]);
const TOMBSTONE_CATALOG_RELATIONS = new Set<string>([
  "chat_source_authorizations", "chat_sources", "recall_actor_authorities",
  "memory_graph_worker_authorities", "proposal_disclosure_revocations",
  "proposal_operation_idempotency",
]);

const coreRelations = new Set(CORE_FORGET_PROJECTION_REGISTRY.map((item) => {
  const relationByType: Record<string, string> = {
    CONSOLIDATION_RUN: "memory_extraction_runs", MEMORY_RECORD: "memory_records",
    MEMORY_SOURCE: "memory_sources", MEMORY_INDEX: "memory_index_terms",
    MEMORY_VECTOR: "memory_vector_buckets", MEMORY_EMBEDDING: "memory_embeddings",
    EPISODE_SUMMARY: "memory_episodes", DOSSIER_REFRESH: "memory_dossier_refreshes",
    MEMORY_CHECKPOINT: "memory_projection_checkpoints",
    MEMORY_EQUIVALENCE: "memory_equivalence_sets", RECALL_TRACE: "recall_traces",
    RECALL_TRACE_SOURCE: "recall_trace_sources",
    RECALL_CONTEXT: "recall_trace_context_entries", GRAPH_NODE: "memory_graph_nodes",
    GRAPH_NODE_SOURCE: "memory_graph_node_sources", GRAPH_EDGE: "memory_graph_edges",
    GRAPH_EDGE_SOURCE: "memory_graph_edge_sources",
    GRAPH_CURRENT_HEAD: "memory_graph_head_versions", GRAPH_CONFLICT: "memory_conflicts",
    GRAPH_JOB: "memory_graph_background_jobs",
    GRAPH_RECONCILIATION: "memory_graph_reconciliation_jobs",
    HANDOFF_PACKET: "handoff_packets", HANDOFF_CHECKPOINT: "handoff_refresh_checkpoints",
    HANDOFF_JOB: "handoff_refresh_jobs", CACHE_PROJECTION: "cache_projection_versions",
    CACHE_JOB: "cache_projection_jobs", CACHE_AUTHORITY: "cache_authority_changes",
    CHAT_IMPORT: "chat_source_imports", IMPORT_MEMORY: "import_memory_projections",
    IMPORT_LIFECYCLE: "import_item_lifecycle_events", FORGET_TOMBSTONE: "audit_events",
  };
  return relationByType[item.projection_type]!;
}));

export const FORGET_PROJECTION_REGISTRY = Object.freeze([
  ...CORE_FORGET_PROJECTION_REGISTRY.map((item) => (
    item.projection_type === "MEMORY_RECORD" || item.projection_type === "GRAPH_EDGE"
      || item.projection_type === "FORGET_TOMBSTONE"
      ? item : { ...item, rebuild_behavior: "RETAIN" as const }
  )),
  ...ESTABLISHED_PROJECTION_RELATIONS.flatMap((relation, index) => (
    coreRelations.has(relation) ? [] : [{
      projection_type: `CATALOG_${String(index + 1).padStart(3, "0")}`,
      forget_behavior: FORGET_CATALOG_RELATIONS.has(relation) ? "FORGET" as const
        : TOMBSTONE_CATALOG_RELATIONS.has(relation)
          ? "RETAIN_TOMBSTONE" as const : "RETAIN" as const,
      rebuild_behavior: TOMBSTONE_CATALOG_RELATIONS.has(relation)
          ? "RETAIN_TOMBSTONE" as const : "RETAIN" as const,
    }]
  )),
]);

const catalogRelationByType = new Map(ESTABLISHED_PROJECTION_RELATIONS.map((relation, index) => [
  `CATALOG_${String(index + 1).padStart(3, "0")}`, relation,
]));

type ProjectionType = typeof FORGET_PROJECTION_REGISTRY[number]["projection_type"];

interface ForgetRequestRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly node_brain_id: string;
  readonly conversation_id: string;
  readonly request_digest: string;
  readonly created_at: Date;
}

interface ClaimedStep {
  readonly requestId: string;
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly projectionType: ProjectionType;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
  readonly transitionOrdinal: number;
}

interface ClaimedRebuild {
  readonly rebuildJobId: number;
  readonly requestId: string;
  readonly accountId: string;
  readonly projectionType: "MEMORY_RECORD" | "GRAPH_EDGE";
  readonly recordId: string;
  readonly remainingSourceIds: readonly string[];
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
  readonly transitionOrdinal: number;
}

export interface ForgetStatus {
  readonly requestId: string;
  readonly status: "PENDING" | "RUNNING" | "FAILED" | "COMPLETED";
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly failedSteps: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

function uuid(value: string, error: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(error);
  return value;
}

function bounded(value: string, maximum: number, error: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(error);
  }
  return value;
}

function deterministicUuid(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  const compact = digest.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${
    compact.slice(16, 20)}-${compact.slice(20)}`;
}

async function statusFor(
  database: EventDatabase,
  request: ForgetRequestRow,
): Promise<ForgetStatus> {
  const row = await database.one<{
    total: number; completed: number; failed: number; running: number;
    completed_at: Date | null;
  } & Record<string, unknown>>(
    `with current as (
       select transition.to_status,transition.lease_until,transition.created_at
       from privacy_forget_steps step
       left join lateral (
         select item.to_status,item.lease_until,item.created_at
         from privacy_forget_step_transitions item
         where item.request_id=step.request_id
           and item.projection_type=step.projection_type
         order by item.transition_ordinal desc limit 1
       ) transition on true
       where step.request_id=$1
       union all
       select transition.to_status,transition.lease_until,transition.created_at
       from privacy_projection_rebuild_jobs job
       left join lateral (
         select item.to_status,item.lease_until,item.created_at
         from privacy_projection_rebuild_job_transitions item
         where item.rebuild_job_id=job.id
         order by item.transition_ordinal desc limit 1
       ) transition on true
       where job.request_id=$1
     ) select count(*)::int total,
              count(*) filter (where to_status='COMPLETED')::int completed,
              count(*) filter (where to_status='FAILED')::int failed,
              count(*) filter (where to_status='CLAIMED' and lease_until>clock_timestamp())::int running,
              max(created_at) filter (where to_status='COMPLETED') completed_at
       from current`,
    [request.id],
  );
  const status = row.total > 0 && row.completed === row.total ? "COMPLETED" as const
    : row.failed > 0 ? "FAILED" as const : row.running > 0 ? "RUNNING" as const : "PENDING" as const;
  return Object.freeze({ requestId: request.id, status, completedSteps: row.completed,
    totalSteps: row.total, failedSteps: row.failed,
    createdAt: new Date(request.created_at).toISOString(),
    completedAt: status === "COMPLETED" && row.completed_at
      ? new Date(row.completed_at).toISOString() : null });
}

export async function forgetConversation(
  context: MemoryControlContext,
  input: {
    readonly actor: PrivacyActor;
    readonly accountId: string;
    readonly conversationId: string;
    readonly idempotencyKey: string;
  },
): Promise<ForgetStatus> {
  uuid(input.accountId, "FORBIDDEN");
  uuid(input.conversationId, "FORBIDDEN");
  const idempotencyKey = bounded(input.idempotencyKey, 200, "INVALID_IDEMPOTENCY_KEY");
  return context.db.transaction(async (db) => {
    const topology = await authorizePrivacyTopology(
      db, input.actor, "FORGET_CONVERSATION", input.conversationId, "UPDATE",
    );
    if (topology.accountId !== input.accountId) throw new Error("FORBIDDEN");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `privacy-cache-publication:${topology.conversationId}`,
    ]);
    const commandKey = `privacy-forget:${canonicalContentDigest({
      action: "FORGET_CONVERSATION",
      accountId: topology.accountId,
      conversationId: topology.conversationId,
      idempotencyKey,
    })}`;
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `privacy-forget:${topology.conversationId}`,
    ]);
    const requestDigest = canonicalContentDigest({ action: "FORGET_CONVERSATION",
      accountId: topology.accountId, conversationId: topology.conversationId });
    const existing = (await db.query<ForgetRequestRow>(
      `select id::text,account_id::text,node_brain_id::text,conversation_id::text,
              request_digest,created_at from privacy_forget_requests where conversation_id=$1`,
      [topology.conversationId],
    ))[0];
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("IDEMPOTENCY_KEY_REUSED");
      await db.query(
        `insert into privacy_forget_request_aliases
           (idempotency_key,request_id,request_digest) values ($1,$2,$3)
         on conflict (idempotency_key) do nothing`,
        [commandKey, existing.id, requestDigest],
      );
      const alias = await db.one<{ request_id: string; request_digest: string } & Record<string, unknown>>(
        `select request_id::text,request_digest from privacy_forget_request_aliases
         where idempotency_key=$1`,
        [commandKey],
      );
      if (alias.request_id !== existing.id || alias.request_digest !== requestDigest) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return statusFor(db, existing);
    }
    const keyRows = await db.query<{ id: string } & Record<string, unknown>>(
      `/* privacy-forget-key-lock */
       select id::text from aggregate_data_keys where aggregate_id=$1 for update`,
      [topology.conversationId],
    );
    if (keyRows.length > 1) throw new Error("EVENT_KEY_UNAVAILABLE");
    if (keyRows.length === 0) {
      const protectedBodies = await db.query(
        `select 1 from encrypted_event_bodies body
         join events event on event.id=body.event_id
         where event.aggregate_id=$1::text limit 1`,
        [topology.conversationId],
      );
      if (protectedBodies.length > 0) throw new Error("EVENT_KEY_UNAVAILABLE");
    }
    // Lock every independently encrypted aggregate already derived from this
    // conversation.  The deferred schema fence rejects a proposal that races
    // this transaction and attempts to commit after the forget barrier.
    await db.query(
      `select key.id from aggregate_data_keys key where key.aggregate_id in (
         select proposal.id::text from proposals proposal
         where proposal.account_id=$2 and (
           proposal.conversation_id=$1 or exists (
             select 1 from events source_event
             where proposal.source_event_ids ? source_event.id::text
               and source_event.account_id=$2::text and source_event.aggregate_id=$1::text
           )
         )
         union
         select disclosure.id::text from proposal_disclosure_authorizations disclosure
         where disclosure.account_id=$2 and (
           disclosure.conversation_id=$1 or exists (
             select 1 from events source_event
             where disclosure.source_event_ids ? source_event.id::text
               and source_event.account_id=$2::text and source_event.aggregate_id=$1::text
           )
         )
       ) for update`,
      [topology.conversationId, topology.accountId],
    );
    const requestId = randomUUID();
    const event = await appendEvent(db, {
      aggregateId: `privacy-forget:${requestId}`, accountId: topology.accountId,
      actor: topology.authorityKind === "ACCOUNT_OWNER"
        ? { type: "USER", id: topology.actorId }
        : { type: "OPERATOR", id: topology.actorId },
      type: "content.forgotten", visibility: "PRIVATE_ACCOUNT",
      body: { requestId, status: "PENDING" },
      idempotencyKey: `content-forgotten:${requestId}`,
    });
    await db.query(
      `insert into privacy_forget_requests (
         id,account_id,node_brain_id,conversation_id,event_id,authority_kind,
         actor_id,authority_reference,capability,idempotency_key,request_digest,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'FORGET_CONVERSATION',$9,$10,$11)`,
      [requestId, topology.accountId, topology.nodeBrainId, topology.conversationId,
        event.id, topology.authorityKind, topology.actorId, topology.authorityReference,
        commandKey, requestDigest, event.occurredAt],
    );
    await db.query(
      `insert into privacy_forget_request_aliases
         (idempotency_key,request_id,request_digest) values ($1,$2,$3)`,
      [commandKey, requestId, requestDigest],
    );
    await db.query(
      `insert into privacy_forget_barriers
         (conversation_id,account_id,node_brain_id,request_id,established_at,key_destroyed_at)
       values ($1,$2,$3,$4,transaction_timestamp(),$5)`,
      [topology.conversationId, topology.accountId, topology.nodeBrainId,
        requestId, event.occurredAt],
    );
    await db.query(
      `insert into account_export_snapshot_retirements
         (snapshot_id,account_id,reason)
       select distinct snapshot.id,snapshot.account_id,'CONTENT_FORGOTTEN'
       from account_export_snapshots snapshot
       where snapshot.account_id=$1 and snapshot.expires_at>clock_timestamp()
         and not exists (
           select 1 from account_export_snapshot_retirements retirement
           where retirement.snapshot_id=snapshot.id
         )
       on conflict (snapshot_id) do nothing`,
      [topology.accountId],
    );
    for (let pass = 0; pass < 4; pass += 1) {
      await db.query("select prune_account_export_snapshot_memberships($1,100000)", [
        topology.accountId,
      ]);
    }
    await db.query(
      `insert into privacy_erased_aggregate_keys
         (aggregate_id,request_id,account_id,conversation_id,aggregate_kind)
       select dependent.aggregate_id,$3,$2,$1,dependent.aggregate_kind from (
         select proposal.id::text aggregate_id,'PROPOSAL'::text aggregate_kind
         from proposals proposal where proposal.account_id=$2 and (
           proposal.conversation_id=$1 or exists (
             select 1 from events source_event
             where proposal.source_event_ids ? source_event.id::text
               and source_event.account_id=$2::text and source_event.aggregate_id=$1::text
           )
         )
         union
         select disclosure.id::text,'PROPOSAL_DISCLOSURE'::text
         from proposal_disclosure_authorizations disclosure
         where disclosure.account_id=$2 and (
           disclosure.conversation_id=$1 or exists (
             select 1 from events source_event
             where disclosure.source_event_ids ? source_event.id::text
               and source_event.account_id=$2::text and source_event.aggregate_id=$1::text
           )
         )
       ) dependent
       on conflict (aggregate_id) do nothing`,
      [topology.conversationId, topology.accountId, requestId],
    );
    await db.query(
      `insert into privacy_forget_steps (request_id,projection_type,ordinal)
       select $1,projection_type,ordinal from privacy_projection_registry order by ordinal`,
      [requestId],
    );
    await db.query(
      `insert into audit_events
         (id,event_id,aggregate_id,account_id,type,actor_kind,actor_id,metadata)
       values ($1,$2,$3,$4,'content.forgotten',$5,$6,$7)`,
      [randomUUID(), event.id, topology.conversationId, topology.accountId,
        topology.authorityKind, topology.actorId,
        JSON.stringify({ requestId, status: "PENDING" })],
    );
    await db.query(
      `update cache_projection_jobs job
       set status='FAILED',worker_id=null,lease_token=null,lease_until=null,
           available_at=clock_timestamp(),completed_at=null,error_code='PRIVACY_FORGET_BARRIER'
       where job.status in ('PENDING','CLAIMED','RETRY_SCHEDULED') and (
         exists (select 1 from events source where source.id=job.event_id
           and source.aggregate_id=$1::text)
         or exists (select 1 from cache_authority_changes authority
           where authority.event_id=job.event_id and authority.conversation_id=($1::text)::uuid)
       )`,
      [topology.conversationId],
    );
    await db.query(
      `update cache_outbox_staging staged set processed_at=clock_timestamp()
       where staged.processed_at is null and exists (
         select 1 from events source where source.id=staged.event_id
           and source.aggregate_id=$1::text
       )`,
      [topology.conversationId],
    );
    await db.query(
      `update cache_authority_staging staged set processed_at=clock_timestamp()
       where staged.processed_at is null and exists (
         select 1 from cache_authority_changes authority
         where authority.event_id=staged.authority_event_id
           and authority.conversation_id=($1::text)::uuid
       )`,
      [topology.conversationId],
    );
    await db.query("update conversations set status='ARCHIVED' where id=$1", [topology.conversationId]);
    await db.query(
      `delete from aggregate_data_keys key using privacy_erased_aggregate_keys erased
       where erased.request_id=$1 and key.aggregate_id=erased.aggregate_id`,
      [requestId],
    );
    if (keyRows[0]) {
      await db.query("delete from aggregate_data_keys where id=$1", [keyRows[0].id]);
    }
    if (context.cache) {
      await context.cache.purgeConversation({ accountId: topology.accountId,
        nodeBrainId: topology.nodeBrainId, conversationId: topology.conversationId });
    }
    return statusFor(db, { id: requestId, account_id: topology.accountId,
      node_brain_id: topology.nodeBrainId, conversation_id: topology.conversationId,
      request_digest: requestDigest, created_at: event.occurredAt });
  });
}

export async function getForgetStatus(
  context: MemoryControlContext,
  input: { readonly actor: PrivacyActor; readonly requestId: string },
): Promise<ForgetStatus> {
  uuid(input.requestId, "INVALID_FORGET_REQUEST_ID");
  const metadata = await context.db.query<ForgetRequestRow>(
    `select id::text,account_id::text,node_brain_id::text,conversation_id::text,
            request_digest,created_at from privacy_forget_requests where id=$1`,
    [input.requestId],
  );
  if (metadata.length !== 1) throw new Error("FORBIDDEN");
  const request = metadata[0]!;
  const topology = await authorizePrivacyTopology(
    context.db, input.actor, "FORGET_CONVERSATION", request.conversation_id,
  );
  if (topology.accountId !== request.account_id || topology.nodeBrainId !== request.node_brain_id) {
    throw new Error("FORBIDDEN");
  }
  return statusFor(context.db, request);
}

function projectionRecordSql(type: ProjectionType): string {
  if (type.startsWith("CATALOG_")) {
    if (!FORGET_PROJECTION_REGISTRY.some(({ projection_type }) => projection_type === type)) {
      throw new Error("PRIVACY_PROJECTION_HANDLER_UNKNOWN");
    }
    const relation = catalogRelationByType.get(type);
    const thoughtDependency = `(thought.aggregate_id=$1::text or exists (
      select 1 from thought_references reference join events event
        on reference.kind='EVENT' and reference.reference_id=event.id::text
      where reference.thought_id=thought.id and event.aggregate_id=$1::text
    ))`;
    if (relation === "thought_records") {
      return `select thought.id::text record_id from thought_records thought
        where ${thoughtDependency}`;
    }
    if (relation === "thought_claims") {
      return `select claim.thought_id::text||':'||claim.ordinal::text record_id
        from thought_claims claim join thought_records thought on thought.id=claim.thought_id
        where ${thoughtDependency}`;
    }
    if (relation === "thought_references") {
      return `select reference.thought_id::text||':'||reference.role||':'||reference.ordinal::text record_id
        from thought_references reference join thought_records thought on thought.id=reference.thought_id
        where ${thoughtDependency}`;
    }
    const proposalDependency = `(proposal.conversation_id=($1::text)::uuid or exists (
      select 1 from events source_event
      where proposal.source_event_ids ? source_event.id::text
        and source_event.aggregate_id=$1::text
    ))`;
    if (relation === "proposal_disclosure_authorizations") {
      return `select disclosure.id::text record_id
        from proposal_disclosure_authorizations disclosure
        where disclosure.conversation_id=($1::text)::uuid or exists (
          select 1 from events source_event
          where disclosure.source_event_ids ? source_event.id::text
            and source_event.aggregate_id=$1::text
        )`;
    }
    if (relation === "proposals") {
      return `select proposal.id::text record_id from proposals proposal
        where ${proposalDependency}`;
    }
    if (relation === "proposal_evidence_links") {
      return `select evidence.proposal_id::text||':'||evidence.polarity||':'||
          evidence.ordinal::text record_id
        from proposal_evidence_links evidence join proposals proposal
          on proposal.id=evidence.proposal_id where ${proposalDependency}`;
    }
    if (relation === "proposal_status_transitions") {
      return `select transition.id::text record_id
        from proposal_status_transitions transition join proposals proposal
          on proposal.id=transition.proposal_id where ${proposalDependency}`;
    }
    if (relation === "proposal_turns") {
      return `select turn.id::text record_id from proposal_turns turn
        join proposals proposal on proposal.id=turn.proposal_id
        where ${proposalDependency}`;
    }
    if (relation === "proposal_turn_evidence_links") {
      return `select evidence.turn_id::text||':'||evidence.ordinal::text record_id
        from proposal_turn_evidence_links evidence join proposal_turns turn
          on turn.id=evidence.turn_id join proposals proposal on proposal.id=turn.proposal_id
        where ${proposalDependency}`;
    }
    return "select null::text record_id where $1::text is null and false";
  }
  const memoryDependency = `(
    memory.conversation_id=($1::text)::uuid or exists (
      select 1 from memory_sources source join events event on event.id=source.source_event_id
      where source.memory_id=memory.id and event.aggregate_id=$1::text
    )
  )`;
  switch (type) {
    case "CONSOLIDATION_RUN": return `select run.id::text record_id from memory_extraction_runs run
      where (run.conversation_id=($1::text)::uuid or exists (select 1 from events event
        where event.id=run.source_event_id and event.aggregate_id=$1::text))`;
    case "MEMORY_RECORD": return `select memory.id::text record_id,
        (select count(*)::int from memory_sources retained
          join events retained_event on retained_event.id=retained.source_event_id
          join encrypted_event_bodies retained_body on retained_body.event_id=retained_event.id
            and retained_body.data_key_id is not null
          where retained.memory_id=memory.id and retained_event.aggregate_id<>$1::text)
          retained_source_count,
        array(select retained.source_event_id::text from memory_sources retained
          join events retained_event on retained_event.id=retained.source_event_id
          join encrypted_event_bodies retained_body on retained_body.event_id=retained_event.id
            and retained_body.data_key_id is not null
          where retained.memory_id=memory.id and retained_event.aggregate_id<>$1::text
          order by retained.ordinal) remaining_source_ids
      from memory_records memory where ${memoryDependency}`;
    case "MEMORY_SOURCE": return `select source.memory_id::text||':'||source.ordinal::text record_id
      from memory_sources source join events event on event.id=source.source_event_id
      where event.aggregate_id=$1::text`;
    case "MEMORY_INDEX": return `select term.memory_id::text||':'||term.kind||':'||term.ordinal::text record_id
      from memory_index_terms term join memory_records memory on memory.id=term.memory_id
      where ${memoryDependency}`;
    case "MEMORY_VECTOR": return `select bucket.memory_id::text||':'||bucket.ordinal::text record_id
      from memory_vector_buckets bucket join memory_records memory on memory.id=bucket.memory_id
      where ${memoryDependency}`;
    case "MEMORY_EMBEDDING": return `select embedding.memory_id::text record_id
      from memory_embeddings embedding join memory_records memory on memory.id=embedding.memory_id
      where ${memoryDependency} and embedding.active`;
    case "EPISODE_SUMMARY": return `select episode.memory_id::text record_id
      from memory_episodes episode join memory_records memory on memory.id=episode.memory_id
      where ${memoryDependency}`;
    case "DOSSIER_REFRESH": return `select dossier.extraction_run_id::text record_id
      from memory_dossier_refreshes dossier join memory_extraction_runs run
        on run.id=dossier.extraction_run_id where run.conversation_id=($1::text)::uuid`;
    case "MEMORY_CHECKPOINT": return `select checkpoint.projection_key record_id
      from memory_projection_checkpoints checkpoint where checkpoint.conversation_id=($1::text)::uuid`;
    case "MEMORY_EQUIVALENCE": return `select equivalence.id::text record_id
      from memory_equivalence_sets equivalence join memory_records memory
        on memory.id=equivalence.canonical_memory_id where ${memoryDependency}`;
    case "RECALL_TRACE": return `select trace.id::text record_id from recall_traces trace
      where trace.conversation_id=($1::text)::uuid or exists (select 1 from recall_trace_sources source
        join events event on event.id=source.source_event_id
        where source.trace_id=trace.id and event.aggregate_id=$1::text)`;
    case "RECALL_TRACE_SOURCE": return `select source.trace_id::text||':'||source.memory_id::text||':'||
        source.ordinal::text record_id from recall_trace_sources source
      join events event on event.id=source.source_event_id where event.aggregate_id=$1::text`;
    case "RECALL_CONTEXT": return `select context.trace_id::text||':'||context.ordinal::text record_id
      from recall_trace_context_entries context join recall_traces trace on trace.id=context.trace_id
      where trace.conversation_id=($1::text)::uuid`;
    case "GRAPH_NODE": return `select node.memory_id::text record_id from memory_graph_nodes node
      join memory_records memory on memory.id=node.memory_id where ${memoryDependency}`;
    case "GRAPH_NODE_SOURCE": return `select source.memory_id::text||':'||source.ordinal::text record_id
      from memory_graph_node_sources source join events event on event.id=source.source_event_id
      where event.aggregate_id=$1::text`;
    case "GRAPH_EDGE": return `select edge.id::text record_id,
        (select count(*)::int from memory_graph_edge_sources retained
          join events retained_event on retained_event.id=retained.source_event_id
          join encrypted_event_bodies retained_body on retained_body.event_id=retained_event.id
            and retained_body.data_key_id is not null
          where retained.edge_id=edge.id and retained_event.aggregate_id<>$1::text)
          retained_source_count,
        array(select retained.source_event_id::text from memory_graph_edge_sources retained
          join events retained_event on retained_event.id=retained.source_event_id
          join encrypted_event_bodies retained_body on retained_body.event_id=retained_event.id
            and retained_body.data_key_id is not null
          where retained.edge_id=edge.id and retained_event.aggregate_id<>$1::text
          order by retained.ordinal) remaining_source_ids
      from memory_graph_edges edge
      where edge.conversation_id=($1::text)::uuid or exists (select 1 from memory_graph_edge_sources source
        join events event on event.id=source.source_event_id where source.edge_id=edge.id
          and event.aggregate_id=$1::text)`;
    case "GRAPH_EDGE_SOURCE": return `select source.edge_id::text||':'||source.ordinal::text record_id
      from memory_graph_edge_sources source join events event on event.id=source.source_event_id
      where event.aggregate_id=$1::text`;
    case "GRAPH_CURRENT_HEAD": return `select head.id::text record_id from memory_graph_head_versions head
      join memory_records memory on memory.id=head.memory_id where ${memoryDependency}`;
    case "GRAPH_CONFLICT": return `select conflict.id::text record_id from memory_conflicts conflict
      where conflict.conversation_id=($1::text)::uuid or exists (select 1 from memory_conflict_sources source
        join events event on event.id=source.source_event_id where source.conflict_id=conflict.id
          and event.aggregate_id=$1::text)`;
    case "GRAPH_JOB": return `select job.id::text record_id from memory_graph_background_jobs job
      where job.conversation_id=($1::text)::uuid`;
    case "GRAPH_RECONCILIATION": return `select job.id::text record_id
      from memory_graph_reconciliation_jobs job where job.conversation_id=($1::text)::uuid`;
    case "HANDOFF_PACKET": return `select packet.id::text record_id from handoff_packets packet
      where packet.conversation_id=($1::text)::uuid`;
    case "HANDOFF_CHECKPOINT": return `select checkpoint.id::text record_id
      from handoff_refresh_checkpoints checkpoint where checkpoint.conversation_id=($1::text)::uuid`;
    case "HANDOFF_JOB": return `select job.id::text record_id from handoff_refresh_jobs job
      where job.conversation_id=($1::text)::uuid`;
    case "CACHE_PROJECTION": return `select projection.id::text record_id
      from cache_projection_versions projection where projection.entity_id=$1::text
        or exists (select 1 from events event where event.id=projection.source_event_id
          and event.aggregate_id=$1::text)
        or exists (select 1 from cache_projection_jobs job
          left join cache_authority_changes authority on authority.event_id=job.event_id
          left join events event on event.id=job.event_id
          where job.id=projection.job_id and (
            authority.conversation_id=($1::text)::uuid or event.aggregate_id=$1::text
          ))`;
    case "CACHE_JOB": return `select job.id::text record_id from cache_projection_jobs job
      left join cache_authority_changes authority on authority.event_id=job.event_id
      left join events event on event.id=job.event_id
      where authority.conversation_id=($1::text)::uuid or event.aggregate_id=$1::text`;
    case "CACHE_AUTHORITY": return `select authority.event_id::text record_id
      from cache_authority_changes authority where authority.conversation_id=($1::text)::uuid`;
    case "CHAT_IMPORT": return `select imported.id::text record_id from chat_source_imports imported
      where exists (select 1 from imported_chat_conversation_versions version
          where version.import_id=imported.id
            and version.imported_conversation_id=($1::text)::uuid)
        or exists (select 1 from imported_chat_message_versions version
          where version.import_id=imported.id
            and version.imported_conversation_id=($1::text)::uuid)`;
    case "IMPORT_MEMORY": return `select imported.item_id::text record_id
      from import_memory_projections imported join memory_records memory on memory.id=imported.memory_id
      where ${memoryDependency}`;
    case "IMPORT_LIFECYCLE": return `select lifecycle.id::text record_id
      from import_item_lifecycle_events lifecycle join events event on event.id=lifecycle.event_id
      where event.aggregate_id=$1::text`;
    case "FORGET_TOMBSTONE": return "select null::text record_id where $1::text is null and false";
  }
  throw new Error("PRIVACY_PROJECTION_HANDLER_UNKNOWN");
}

async function projectionRecords(
  database: EventDatabase,
  step: ClaimedStep,
): Promise<readonly {
  readonly recordId: string;
  readonly retainedSourceCount: number;
  readonly remainingSourceIds: readonly string[];
}[]> {
  const base = projectionRecordSql(step.projectionType);
  let rows: ({ record_id: string; retained_source_count?: number;
    remaining_source_ids?: string[] } & Record<string, unknown>)[];
  try {
    rows = await database.query<{ record_id: string; retained_source_count?: number;
      remaining_source_ids?: string[] } & Record<string, unknown>>(
      `/* select candidate.record_id: bounded projection page */
       select candidate.* from (${base}) candidate
       where candidate.record_id is not null and not exists (
         select 1 from privacy_projection_deactivations deactivation
         where deactivation.request_id=($2::text)::uuid and deactivation.projection_type=$3
           and deactivation.record_id=candidate.record_id
       ) order by candidate.record_id limit ${MAX_STEP_RECORDS + 1}`,
      [step.conversationId, step.requestId, step.projectionType],
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    throw new Error(`PRIVACY_PROJECTION_QUERY_FAILED:${step.projectionType}:${code}`);
  }
  return Object.freeze(rows.map((row) => Object.freeze({
    recordId: row.record_id,
    retainedSourceCount: row.retained_source_count ?? 0,
    remainingSourceIds: Object.freeze(row.remaining_source_ids ?? []),
  })));
}

async function appendTransition(
  database: EventDatabase,
  step: Omit<ClaimedStep, "leaseToken" | "leaseUntil" | "transitionOrdinal"> & {
    readonly leaseToken: string | null;
    readonly leaseUntil: Date | null;
    readonly transitionOrdinal: number;
  },
  status: "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED",
  details: { readonly affectedCount?: number; readonly errorCode?: string;
    readonly retryAt?: Date } = {},
): Promise<void> {
  const eventType = status === "CLAIMED" ? "content.forget.step.claimed"
    : status === "COMPLETED" ? "content.forget.step.completed"
      : status === "RETRY_SCHEDULED" ? "content.forget.step.retry_scheduled"
        : "content.forget.step.failed";
  const event = await appendEvent(database, {
    aggregateId: `privacy-forget:${step.requestId}`, accountId: step.accountId,
    actor: { type: "SYSTEM", id: step.workerId }, type: eventType,
    visibility: "PRIVATE_ACCOUNT", body: {
      requestId: step.requestId, projectionType: step.projectionType, status,
      transitionOrdinal: step.transitionOrdinal,
      affectedCount: details.affectedCount ?? null,
      errorCode: details.errorCode ?? null,
    },
    idempotencyKey: `privacy-forget-transition:${step.requestId}:${step.projectionType}:${step.transitionOrdinal}`,
  });
  await database.query(
    `insert into privacy_forget_step_transitions (
       id,event_id,request_id,projection_type,transition_ordinal,to_status,worker_id,
       lease_token,lease_until,retry_at,affected_count,error_code
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), event.id, step.requestId, step.projectionType, step.transitionOrdinal,
      status, step.workerId, step.leaseToken, status === "CLAIMED" ? step.leaseUntil : null,
      details.retryAt ?? null, details.affectedCount ?? null, details.errorCode ?? null],
  );
}

async function claimStep(
  database: EventDatabase,
  workerId: string,
  leaseMilliseconds: number,
): Promise<ClaimedStep | null> {
  return database.transaction(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended('privacy-forget-worker',0))");
    const candidates = await db.query<{
      request_id: string; account_id: string; node_brain_id: string; conversation_id: string;
      projection_type: ProjectionType; next_ordinal: number;
    } & Record<string, unknown>>(
      `select step.request_id::text,request.account_id::text,request.node_brain_id::text,
              request.conversation_id::text,step.projection_type,
              coalesce(latest.transition_ordinal,0)+1 next_ordinal
       from privacy_forget_steps step
       join privacy_forget_requests request on request.id=step.request_id
       left join lateral (
         select transition_ordinal,to_status,lease_until,retry_at
         from privacy_forget_step_transitions transition
         where transition.request_id=step.request_id
           and transition.projection_type=step.projection_type
         order by transition_ordinal desc limit 1
       ) latest on true
       where (
         latest.transition_ordinal is null
         or (latest.to_status='RETRY_SCHEDULED' and latest.retry_at<=clock_timestamp())
         or (latest.to_status='CLAIMED' and latest.lease_until<=clock_timestamp())
       ) and (step.projection_type<>'FORGET_TOMBSTONE' or (
         not exists (
           select 1 from privacy_forget_steps dependency
           left join lateral (
             select dependency_transition.to_status
             from privacy_forget_step_transitions dependency_transition
             where dependency_transition.request_id=dependency.request_id
               and dependency_transition.projection_type=dependency.projection_type
             order by dependency_transition.transition_ordinal desc limit 1
           ) dependency_latest on true
           where dependency.request_id=step.request_id
             and dependency.projection_type<>'FORGET_TOMBSTONE'
             and dependency_latest.to_status is distinct from 'COMPLETED'
         ) and not exists (
           select 1 from privacy_projection_rebuild_jobs rebuild
           left join lateral (
             select rebuild_transition.to_status
             from privacy_projection_rebuild_job_transitions rebuild_transition
             where rebuild_transition.rebuild_job_id=rebuild.id
             order by rebuild_transition.transition_ordinal desc limit 1
           ) rebuild_latest on true
           where rebuild.request_id=step.request_id
             and rebuild_latest.to_status is distinct from 'COMPLETED'
         )
       ))
       order by request.created_at,step.ordinal limit 1`,
    );
    if (candidates.length === 0) return null;
    const candidate = candidates[0]!;
    const clock = await db.one<{ now: Date; lease_until: Date } & Record<string, unknown>>(
      `select clock_timestamp() now,
              clock_timestamp()+($1::int*interval '1 millisecond') lease_until`,
      [leaseMilliseconds],
    );
    const step: ClaimedStep = Object.freeze({ requestId: candidate.request_id,
      accountId: candidate.account_id, nodeBrainId: candidate.node_brain_id,
      conversationId: candidate.conversation_id, projectionType: candidate.projection_type,
      workerId, leaseToken: randomUUID(), leaseUntil: new Date(clock.lease_until),
      transitionOrdinal: candidate.next_ordinal });
    await appendTransition(db, step, "CLAIMED");
    return step;
  });
}

async function completeStep(context: MemoryControlContext, step: ClaimedStep): Promise<boolean> {
  if (step.projectionType === "CACHE_PROJECTION") {
    if (!context.cache) throw new Error("PRIVACY_CACHE_PURGER_UNAVAILABLE");
    await context.cache.purgeConversation({
      accountId: step.accountId,
      nodeBrainId: step.nodeBrainId,
      conversationId: step.conversationId,
    });
  }
  return context.db.transaction(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `privacy-forget-step:${step.requestId}:${step.projectionType}`,
    ]);
    const current = await db.query<{ exact: boolean } & Record<string, unknown>>(
      `select transition.to_status='CLAIMED' and transition.worker_id=$3
              and transition.lease_token=$4 and transition.lease_until>clock_timestamp() exact
       from privacy_forget_step_transitions transition
       where transition.request_id=$1 and transition.projection_type=$2
       order by transition.transition_ordinal desc limit 1`,
      [step.requestId, step.projectionType, step.workerId, step.leaseToken],
    );
    if (current.length !== 1 || !current[0]!.exact) throw new Error("PRIVACY_FORGET_STEP_LEASE_LOST");
    const records = await projectionRecords(db, step);
    const selected = records.slice(0, MAX_STEP_RECORDS);
    if (selected.length > 0) {
      await db.query(
        `insert into privacy_projection_deactivations
           (request_id,projection_type,record_id,retained_source_count)
         select $1,$2,item.record_id,item.retained_source_count
         from jsonb_to_recordset($3::jsonb)
           item(record_id text,retained_source_count integer,remaining_source_ids uuid[])
         on conflict (request_id,projection_type,record_id) do nothing`,
        [step.requestId, step.projectionType, JSON.stringify(selected.map((record) => ({
          record_id: record.recordId,
          retained_source_count: record.retainedSourceCount,
          remaining_source_ids: record.remainingSourceIds,
        })))],
      );
      if (step.projectionType === "MEMORY_RECORD" || step.projectionType === "GRAPH_EDGE") {
        await db.query(
          `insert into privacy_projection_rebuild_jobs
             (request_id,projection_type,record_id,remaining_source_ids)
           select $1,$2,item.record_id,item.remaining_source_ids
           from jsonb_to_recordset($3::jsonb)
             item(record_id text,retained_source_count integer,remaining_source_ids uuid[])
           where item.retained_source_count>0
           on conflict (request_id,projection_type,record_id) do nothing`,
          [step.requestId, step.projectionType, JSON.stringify(selected.map((record) => ({
            record_id: record.recordId,
            retained_source_count: record.retainedSourceCount,
            remaining_source_ids: record.remainingSourceIds,
          })))],
        );
      }
      const selectedIds = selected.map(({ recordId }) => recordId);
      if (step.projectionType === "MEMORY_INDEX") {
        await db.query(
          `delete from memory_index_terms term where
           (term.memory_id::text||':'||term.kind||':'||term.ordinal::text)=any($1::text[])`,
          [selectedIds],
        );
      } else if (step.projectionType === "MEMORY_EMBEDDING") {
        await db.query("update memory_embeddings set active=false where memory_id=any($1::uuid[]) and active",
          [selectedIds]);
      } else if (step.projectionType === "GRAPH_EDGE") {
        await db.query(
          `update memory_graph_edges edge set valid_to=barrier.established_at
           from privacy_forget_barriers barrier where barrier.request_id=$2
             and edge.id=any($1::uuid[]) and edge.valid_to is null`,
          [selectedIds, step.requestId],
        );
      }
    }
    if (records.length > MAX_STEP_RECORDS) {
      const retry = await db.one<{ retry_at: Date } & Record<string, unknown>>(
        "select clock_timestamp() retry_at",
      );
      await appendTransition(db, { ...step, transitionOrdinal: step.transitionOrdinal + 1 },
        "RETRY_SCHEDULED", { errorCode: "MORE_WORK", retryAt: retry.retry_at });
      return false;
    }
    const count = await db.one<{ count: number } & Record<string, unknown>>(
      `select count(*)::int count from privacy_projection_deactivations
       where request_id=$1 and projection_type=$2`,
      [step.requestId, step.projectionType],
    );
    if (step.projectionType === "FORGET_TOMBSTONE") {
      const publish = () => appendCompletionEvent(db, step.requestId);
      if (context.publishForgetCompletion) await context.publishForgetCompletion(publish);
      else await publish();
    }
    await appendTransition(db, { ...step, transitionOrdinal: step.transitionOrdinal + 1 },
      "COMPLETED", { affectedCount: count.count });
    return true;
  });
}

async function recordStepFailure(
  database: EventDatabase,
  step: ClaimedStep,
): Promise<void> {
  await database.transaction(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `privacy-forget-step:${step.requestId}:${step.projectionType}`,
    ]);
    const state = await db.query<{
      exact: boolean; attempts: number; retry_at: Date;
    } & Record<string, unknown>>(
      `select latest.to_status='CLAIMED' and latest.worker_id=$3
              and latest.lease_token=$4 and latest.lease_until>clock_timestamp() exact,
              (select count(*)::int from privacy_forget_step_transitions attempt
               where attempt.request_id=$1 and attempt.projection_type=$2
                 and attempt.to_status='CLAIMED') attempts,
              clock_timestamp()+(
                least(5000,250*power(2,greatest(0,
                  (select count(*)::int from privacy_forget_step_transitions attempt
                   where attempt.request_id=$1 and attempt.projection_type=$2
                     and attempt.to_status='CLAIMED')-1)))::int
                *interval '1 millisecond'
              ) retry_at
       from privacy_forget_step_transitions latest
       where latest.request_id=$1 and latest.projection_type=$2
       order by latest.transition_ordinal desc limit 1`,
      [step.requestId, step.projectionType, step.workerId, step.leaseToken],
    );
    if (state.length !== 1 || !state[0]!.exact) return;
    const failed = state[0]!.attempts >= 3;
    await appendTransition(db, { ...step, transitionOrdinal: step.transitionOrdinal + 1 },
      failed ? "FAILED" : "RETRY_SCHEDULED", {
        errorCode: "PROJECTION_PROCESSING_FAILED",
        ...(failed ? {} : { retryAt: state[0]!.retry_at }),
      });
  });
}

function rebuildSourceText(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("PRIVACY_REBUILD_SOURCE_BODY_INVALID");
  }
  const record = body as Record<string, unknown>;
  for (const key of ["text", "completion", "content", "summary"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  throw new Error("PRIVACY_REBUILD_SOURCE_BODY_INVALID");
}

function rebuildMemorySet(
  type: MemoryType,
  memory: ExtractedMemoryBase,
  procedureVersion: string | null,
  goalStatus: "OPEN" | "BLOCKED" | "COMPLETED" | "CANCELLED" | null,
): ExtractedMemorySet {
  if (type === "SEMANTIC") return { facts: [memory] };
  if (type === "EPISODIC") return { episodes: [memory] };
  if (type === "PROCEDURAL") {
    return { procedures: [{ ...memory,
      procedureVersion: procedureVersion ?? "privacy-rebuild-v1" }] };
  }
  return { goals: [{ ...memory, status: goalStatus ?? "OPEN" }] };
}

async function appendRebuildTransition(
  database: EventDatabase,
  rebuild: ClaimedRebuild,
  status: "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED",
  details: { readonly affectedCount?: number; readonly errorCode?: string;
    readonly retryAt?: Date } = {},
): Promise<void> {
  const eventType = status === "CLAIMED" ? "content.forget.rebuild.claimed"
    : status === "COMPLETED" ? "content.forget.rebuild.completed"
      : status === "RETRY_SCHEDULED" ? "content.forget.rebuild.retry_scheduled"
        : "content.forget.rebuild.failed";
  const event = await appendEvent(database, {
    aggregateId: `privacy-forget:${rebuild.requestId}`, accountId: rebuild.accountId,
    actor: { type: "SYSTEM", id: rebuild.workerId }, type: eventType,
    visibility: "PRIVATE_ACCOUNT", body: {
      requestId: rebuild.requestId, rebuildJobId: rebuild.rebuildJobId,
      projectionType: rebuild.projectionType, status,
      transitionOrdinal: rebuild.transitionOrdinal,
      affectedCount: details.affectedCount ?? null,
      errorCode: details.errorCode ?? null,
    },
    idempotencyKey: `privacy-rebuild-transition:${rebuild.rebuildJobId}:${rebuild.transitionOrdinal}`,
  });
  await database.query(
    `insert into privacy_projection_rebuild_job_transitions (
       id,event_id,rebuild_job_id,transition_ordinal,to_status,worker_id,
       lease_token,lease_until,retry_at,affected_count,error_code
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), event.id, rebuild.rebuildJobId, rebuild.transitionOrdinal, status,
      rebuild.workerId, rebuild.leaseToken, status === "CLAIMED" ? rebuild.leaseUntil : null,
      details.retryAt ?? null, details.affectedCount ?? null, details.errorCode ?? null],
  );
}

async function claimRebuild(
  database: EventDatabase,
  workerId: string,
  leaseMilliseconds: number,
): Promise<ClaimedRebuild | null> {
  return database.transaction(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended('privacy-rebuild-worker',0))");
    const rows = await db.query<{
      id: number; request_id: string; account_id: string;
      projection_type: "MEMORY_RECORD" | "GRAPH_EDGE"; record_id: string;
      remaining_source_ids: string[]; next_ordinal: number;
    } & Record<string, unknown>>(
      `select job.id,job.request_id::text,request.account_id::text,job.projection_type,
              job.record_id,job.remaining_source_ids::text[],
              coalesce(latest.transition_ordinal,0)+1 next_ordinal
       from privacy_projection_rebuild_jobs job
       join privacy_forget_requests request on request.id=job.request_id
       left join lateral (
         select transition_ordinal,to_status,lease_until,retry_at
         from privacy_projection_rebuild_job_transitions transition
         where transition.rebuild_job_id=job.id
         order by transition.transition_ordinal desc limit 1
       ) latest on true
       where latest.transition_ordinal is null
          or (latest.to_status='RETRY_SCHEDULED' and latest.retry_at<=clock_timestamp())
          or (latest.to_status='CLAIMED' and latest.lease_until<=clock_timestamp())
       order by job.created_at,job.id limit 1`,
    );
    if (!rows[0]) return null;
    const clock = await db.one<{ lease_until: Date } & Record<string, unknown>>(
      "select clock_timestamp()+($1::int*interval '1 millisecond') lease_until",
      [leaseMilliseconds],
    );
    const row = rows[0];
    const rebuild: ClaimedRebuild = Object.freeze({ rebuildJobId: row.id,
      requestId: row.request_id, accountId: row.account_id,
      projectionType: row.projection_type, recordId: row.record_id,
      remainingSourceIds: Object.freeze(row.remaining_source_ids), workerId,
      leaseToken: randomUUID(), leaseUntil: new Date(clock.lease_until),
      transitionOrdinal: row.next_ordinal });
    await appendRebuildTransition(db, rebuild, "CLAIMED");
    return rebuild;
  });
}

async function completeGraphRebuild(
  context: MemoryControlContext,
  rebuild: ClaimedRebuild,
): Promise<string> {
  const endpoints = await context.db.query<{
    role: "SOURCE" | "TARGET"; old_memory_id: string; replacement_memory_id: string;
    valid_from: Date; source_ids: string[]; keywords: string[]; entities: string[];
  } & Record<string, unknown>>(
    `with edge as (
       select source_memory_id,target_memory_id from memory_graph_edges where id=$1
     ), endpoint(role,old_memory_id) as (
       select 'SOURCE'::text,source_memory_id from edge union all
       select 'TARGET'::text,target_memory_id from edge
     )
     select endpoint.role,endpoint.old_memory_id::text,
            result.replacement_record_id replacement_memory_id,memory.valid_from,
            memory.public_keyword_terms keywords,memory.public_entity_terms entities,
            array_agg(source.source_event_id::text order by source.ordinal) source_ids
     from endpoint
     join privacy_projection_rebuild_jobs job on job.request_id=$2
       and job.projection_type='MEMORY_RECORD' and job.record_id=endpoint.old_memory_id::text
     join privacy_projection_rebuild_results result on result.rebuild_job_id=job.id
     join memory_records memory on memory.id=result.replacement_record_id::uuid
       and memory.scope='PUBLIC' and memory.valid_to is null
     join memory_sources source on source.memory_id=memory.id
     group by endpoint.role,endpoint.old_memory_id,result.replacement_record_id,memory.valid_from,
              memory.public_keyword_terms,memory.public_entity_terms
     order by endpoint.role`,
    [rebuild.recordId, rebuild.requestId],
  );
  if (endpoints.length !== 2) throw new Error("PRIVACY_GRAPH_REBUILD_ENDPOINT_PENDING");
  const allSources = new Set(endpoints.flatMap(({ source_ids }) => source_ids));
  if (allSources.size !== rebuild.remainingSourceIds.length
      || rebuild.remainingSourceIds.some((sourceId) => !allSources.has(sourceId))) {
    throw new Error("PRIVACY_GRAPH_REBUILD_SOURCE_MISMATCH");
  }
  const replacementMemoryIds = endpoints.map(({ replacement_memory_id }) => replacement_memory_id);
  const existingEdges = await context.db.query<{
    id: string; source_ids: string[];
  } & Record<string, unknown>>(
    `select edge.id::text,array_agg(source.source_event_id::text order by source.ordinal) source_ids
     from memory_graph_edges edge join memory_graph_edge_sources source on source.edge_id=edge.id
     where edge.scope='PUBLIC' and edge.valid_to is null
       and edge.source_memory_id=any($1::uuid[]) and edge.target_memory_id=any($1::uuid[])
     group by edge.id order by edge.id`,
    [replacementMemoryIds],
  );
  const existingEdge = existingEdges.find(({ source_ids }) => (
    source_ids.length === rebuild.remainingSourceIds.length
    && source_ids.every((sourceId) => rebuild.remainingSourceIds.includes(sourceId))
  ));
  if (existingEdge) return existingEdge.id;
  const graphClock = await context.db.one<{ now: Date } & Record<string, unknown>>(
    "select clock_timestamp() now",
  );
  const observedAt = new Date(Math.max(graphClock.now.getTime(),
    Math.max(...endpoints.map(({ valid_from }) => valid_from.getTime())) + 1)).toISOString();
  const commonPredicate = endpoints[0]!.keywords.find((term) => (
    endpoints[1]!.keywords.includes(term)
  ));
  const label = endpoints[0]!.entities[0];
  if (!label || !commonPredicate) throw new Error("PRIVACY_GRAPH_REBUILD_TERMS_MISSING");
  const entity = Object.freeze({
    id: deterministicUuid(`privacy-rebuild-entity:${rebuild.rebuildJobId}`),
    type: "METHOD" as const, canonicalName: label,
    validFrom: new Date(Math.min(...endpoints.map(({ valid_from }) => valid_from.getTime())))
      .toISOString(),
    aliases: [{ alias: label, validFrom: new Date(endpoints[0]!.valid_from).toISOString(),
      sourceIds: endpoints[0]!.source_ids }],
  });
  const graph = await versionMemoryGraph(createMemoryGraphWriterContext(context.db), {
    scope: "PUBLIC", idempotencyKey: `privacy-rebuild-graph:${rebuild.rebuildJobId}`,
    reconcilerVersion: "privacy-rebuild-v1", observedAt, entities: [entity],
    claims: endpoints.map((endpoint) => ({
      memoryId: endpoint.replacement_memory_id, entityId: entity.id,
      nodeType: "FACT", predicate: commonPredicate,
      value: [...endpoint.keywords].reverse().find((term) => term !== commonPredicate)
        ?? commonPredicate,
      approved: true,
      validFrom: new Date(endpoint.valid_from).toISOString(), sourceIds: endpoint.source_ids,
    })),
  });
  if (graph.status !== "COMPLETED" || graph.edges.length === 0) {
    throw new Error("PRIVACY_GRAPH_REBUILD_NO_SAFE_EDGE");
  }
  const candidates = await context.db.query<{ id: string; source_ids: string[] } & Record<string, unknown>>(
    `select edge.id::text,array_agg(source.source_event_id::text order by source.ordinal) source_ids
     from memory_graph_edges edge join memory_graph_edge_sources source on source.edge_id=edge.id
     where edge.id=any($1::uuid[]) group by edge.id order by edge.id`,
    [graph.edges.map(({ id }) => id)],
  );
  const replacement = candidates.find(({ source_ids }) => (
    source_ids.length === rebuild.remainingSourceIds.length
    && source_ids.every((sourceId) => rebuild.remainingSourceIds.includes(sourceId))
  ));
  if (!replacement) throw new Error("PRIVACY_GRAPH_REBUILD_SOURCE_MISMATCH");
  return replacement.id;
}

async function completeRebuild(
  context: MemoryControlContext,
  rebuild: ClaimedRebuild,
): Promise<void> {
  if (rebuild.projectionType === "GRAPH_EDGE") {
    const replacementRecordId = await completeGraphRebuild(context, rebuild);
    await context.db.transaction(async (db) => {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `privacy-rebuild-job:${rebuild.rebuildJobId}`,
      ]);
      await db.query(
        `insert into privacy_projection_rebuild_results
           (rebuild_job_id,replacement_record_id,source_manifest)
         values ($1,$2,$3) on conflict (rebuild_job_id) do nothing`,
        [rebuild.rebuildJobId, replacementRecordId, rebuild.remainingSourceIds],
      );
      await appendRebuildTransition(db, { ...rebuild,
        transitionOrdinal: rebuild.transitionOrdinal + 1 }, "COMPLETED", { affectedCount: 1 });
    });
    return;
  }
  const sourceRows = await context.db.query<{
    id: string; aggregate_id: string; occurred_at: Date; visibility: string;
    account_id: string | null;
  } & Record<string, unknown>>(
    `select event.id::text,event.aggregate_id,event.occurred_at,event.visibility,event.account_id
     from events event join encrypted_event_bodies body on body.event_id=event.id
       and body.data_key_id is not null
     where event.id=any($1::uuid[]) order by event.ingested_sequence,event.id`,
    [rebuild.remainingSourceIds],
  );
  if (sourceRows.length !== rebuild.remainingSourceIds.length
      || sourceRows.some((source) => source.visibility !== "PUBLIC"
        || source.account_id !== null || source.aggregate_id !== sourceRows[0]!.aggregate_id)) {
    throw new Error("PRIVACY_REBUILD_SOURCE_SCOPE_UNSUPPORTED");
  }
  const bodyRows = await readEventBodies(context.db, sourceRows.map(({ id }) => id), {
    actor: { role: "SYSTEM" },
  });
  const bodyById = new Map(bodyRows.map(({ eventId, body }) => [eventId, body]));
  const events = sourceRows.map((source) => Object.freeze({ id: source.id,
    at: new Date(source.occurred_at).toISOString(),
    text: rebuildSourceText(bodyById.get(source.id)) }));
  const text = events.map((event) => event.text).join("\n");
  const keywords = Object.freeze([...new Set(text.toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,119}/gu) ?? [])].slice(0, 20));
  if (keywords.length === 0) throw new Error("PRIVACY_REBUILD_SOURCE_TEXT_INVALID");
  const prior = await context.db.one<{
    type: MemoryType; procedure_version: string | null;
    goal_status: "OPEN" | "BLOCKED" | "COMPLETED" | "CANCELLED" | null;
  } & Record<string, unknown>>(
    `select type,procedure_version,goal_status from memory_records where id=$1`,
    [rebuild.recordId],
  );
  const databaseClock = await context.db.one<{ now: Date } & Record<string, unknown>>(
    "select clock_timestamp() now",
  );
  const memory: ExtractedMemoryBase = Object.freeze({ text,
    sourceIds: Object.freeze(sourceRows.map(({ id }) => id)), keywords,
    entities: Object.freeze([keywords.at(-1)!]),
    confidence: 1, importance: 1 });
  const projected = await processMemoryEvent(createMemoryWorkerContext(context.db), {
    scope: "PUBLIC", sourceEventId: sourceRows[0]!.id, events,
    extracted: rebuildMemorySet(prior.type, memory, prior.procedure_version, prior.goal_status),
    versions: { promptVersion: "privacy-rebuild-v1", modelVersion: "none",
      extractorVersion: "privacy-rebuild-v1", embeddingVersion: "none" },
    observedAt: new Date(Math.max(databaseClock.now.getTime(),
      Math.max(...sourceRows.map(({ occurred_at }) => occurred_at.getTime())) + 1)).toISOString(),
    idempotencyKey: `privacy-rebuild:${rebuild.rebuildJobId}`,
  });
  await context.db.transaction(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `privacy-rebuild-job:${rebuild.rebuildJobId}`,
    ]);
    await db.query(
      `insert into privacy_projection_rebuild_results
         (rebuild_job_id,replacement_record_id,source_manifest)
       values ($1,$2,$3) on conflict (rebuild_job_id) do nothing`,
      [rebuild.rebuildJobId, projected.memories[0]!.id, rebuild.remainingSourceIds],
    );
    await appendRebuildTransition(db, { ...rebuild,
      transitionOrdinal: rebuild.transitionOrdinal + 1 }, "COMPLETED", { affectedCount: 1 });
  });
}

async function recordRebuildFailure(
  database: EventDatabase,
  rebuild: ClaimedRebuild,
): Promise<void> {
  await database.transaction(async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `privacy-rebuild-job:${rebuild.rebuildJobId}`,
    ]);
    const state = await db.query<{ exact: boolean; attempts: number; retry_at: Date } & Record<string, unknown>>(
      `select latest.to_status='CLAIMED' and latest.worker_id=$2
              and latest.lease_token=$3 and latest.lease_until>clock_timestamp() exact,
              (select count(*)::int from privacy_projection_rebuild_job_transitions attempt
               where attempt.rebuild_job_id=$1 and attempt.to_status='CLAIMED') attempts,
              clock_timestamp()+(least(5000,250*power(2,greatest(0,
                (select count(*)::int from privacy_projection_rebuild_job_transitions attempt
                 where attempt.rebuild_job_id=$1 and attempt.to_status='CLAIMED')-1)))::int
                *interval '1 millisecond') retry_at
       from privacy_projection_rebuild_job_transitions latest
       where latest.rebuild_job_id=$1 order by latest.transition_ordinal desc limit 1`,
      [rebuild.rebuildJobId, rebuild.workerId, rebuild.leaseToken],
    );
    if (!state[0]?.exact) return;
    const failed = state[0].attempts >= 3;
    await appendRebuildTransition(db, { ...rebuild,
      transitionOrdinal: rebuild.transitionOrdinal + 1 },
    failed ? "FAILED" : "RETRY_SCHEDULED", {
      errorCode: "PROJECTION_REBUILD_FAILED",
      ...(failed ? {} : { retryAt: state[0].retry_at }),
    });
  });
}

async function appendCompletionEvent(database: EventDatabase, requestId: string): Promise<void> {
  await database.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `privacy-forget-completion:${requestId}`,
  ]);
  const request = await database.one<ForgetRequestRow>(
    `select id::text,account_id::text,node_brain_id::text,conversation_id::text,
            request_digest,created_at from privacy_forget_requests where id=$1`,
    [requestId],
  );
  await appendEvent(database, {
    aggregateId: `privacy-forget:${requestId}`, accountId: request.account_id,
    actor: { type: "SYSTEM", id: "privacy-forget-worker" },
    type: "content.forget_propagated", visibility: "PRIVATE_ACCOUNT",
    body: { requestId, status: "COMPLETED" },
    idempotencyKey: `privacy-forget-completed:${requestId}`,
  });
}

export async function processForgetPropagation(
  context: MemoryControlContext,
  input: { readonly workerId: string; readonly maximumSteps?: number;
    readonly leaseMilliseconds?: number },
): Promise<{ readonly processedSteps: number }> {
  const workerId = bounded(input.workerId, 128, "INVALID_PRIVACY_WORKER_ID");
  const maximumSteps = input.maximumSteps ?? 8;
  const leaseMilliseconds = input.leaseMilliseconds ?? 5_000;
  if (!Number.isSafeInteger(maximumSteps) || maximumSteps < 1 || maximumSteps > 50) {
    throw new Error("INVALID_PRIVACY_WORK_LIMIT");
  }
  if (!Number.isSafeInteger(leaseMilliseconds)
      || leaseMilliseconds < 1_000 || leaseMilliseconds > 60_000) {
    throw new Error("INVALID_PRIVACY_LEASE");
  }
  const authority = await context.db.query(
    `select 1 from privacy_forget_worker_authorities authority
     where authority.worker_id=$1 and authority.active and not exists (
       select 1 from privacy_forget_worker_revocations revocation
       where revocation.worker_id=authority.worker_id
     )`,
    [workerId],
  );
  if (authority.length !== 1) throw new Error("PRIVACY_WORKER_FORBIDDEN");
  let processedSteps = 0;
  for (let index = 0; index < maximumSteps; index += 1) {
    const step = await claimStep(context.db, workerId, leaseMilliseconds);
    if (step) {
      try {
        await completeStep(context, step);
      } catch {
        await recordStepFailure(context.db, step);
      }
      processedSteps += 1;
      continue;
    }
    const rebuild = await claimRebuild(context.db, workerId, leaseMilliseconds);
    if (!rebuild) break;
    try {
      await completeRebuild(context, rebuild);
    } catch {
      await recordRebuildFailure(context.db, rebuild);
    }
    processedSteps += 1;
  }
  return Object.freeze({ processedSteps });
}

export interface ForgetPropagationWorkerController {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export function startForgetPropagationWorker(input: MemoryControlContext & {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly maximumSteps?: number;
  readonly leaseMilliseconds?: number;
}): ForgetPropagationWorkerController {
  if (!Number.isSafeInteger(input.pollIntervalMs)
      || input.pollIntervalMs < 1 || input.pollIntervalMs > 60_000) {
    throw new Error("PRIVACY_WORKER_POLL_INTERVAL_INVALID");
  }
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const wait = (milliseconds: number) => new Promise<void>((resolve) => {
    wake = resolve;
    timer = setTimeout(() => {
      timer = null;
      wake = null;
      resolve();
    }, milliseconds);
    timer.unref?.();
  });
  const done = (async () => {
    while (!stopping) {
      try {
        const result = await processForgetPropagation(input, {
          workerId: input.workerId,
          maximumSteps: input.maximumSteps,
          leaseMilliseconds: input.leaseMilliseconds,
        });
        if (!stopping) await wait(result.processedSteps === 0 ? input.pollIntervalMs : 1);
      } catch {
        if (!stopping) await wait(Math.min(1_000, input.pollIntervalMs * 2));
      }
    }
  })();
  return Object.freeze({
    done,
    async stop() {
      stopping = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      wake?.();
      wake = null;
      await done;
    },
  });
}
