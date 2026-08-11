import { randomUUID } from "node:crypto";
import { appendEvent } from "../../lib/server/events/store";
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import type { EventDatabase, JsonValue, StoredEvent } from "../../lib/server/events/types";
import {
  HANDOFF_POLICY_VERSION,
  MAX_HANDOFF_IDEAS,
  MAX_HANDOFF_SERIALIZED_BYTES,
  handoffProposalPayloadBytes,
  loadHandoff,
  proposalHandoffContentDigest,
  type DurableHandoffPacket,
  type HandoffContext,
} from "../../lib/server/handoffs/build";
import { getProposal } from "../../lib/server/orchestration/proposals";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/;

export interface RefreshHandoffInput {
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly scope: "NODE_BRANCH";
  readonly policyVersion: string;
  readonly nodeStateVersion: string;
  readonly mainStateVersion: string;
  readonly throughEventId: string;
  readonly idempotencyKey: string;
}

export type HandoffRefreshResult =
  | { readonly status: "EMPTY"; readonly highWaterSequence: string; readonly checkpointId: string }
  | { readonly status: "COMPLETED"; readonly packet: DurableHandoffPacket };

export interface HandoffRefreshJob {
  readonly id: string;
  readonly eventId: string;
  readonly status: "PENDING" | "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED";
  readonly highWaterSequence: string;
  readonly estimatedDeltaCount: number;
}

export interface HandoffRefreshJobClaim {
  readonly jobId: string;
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly scope: "NODE_BRANCH";
  readonly policyVersion: string;
  readonly nodeStateVersion: string;
  readonly mainStateVersion: string;
  readonly throughEventId: string;
  readonly workerId: string;
  readonly leaseUntil: string;
  readonly transitionEventId: string;
}

interface SnapshotRow extends Record<string, unknown> {
  readonly ingested_sequence: string;
  readonly node_state_version: string | null;
  readonly main_state_version: string | null;
}

interface CandidateRow extends Record<string, unknown> {
  readonly proposal_id: string;
  readonly proposal_event_id: string;
  readonly proposal_status_event_id: string;
  readonly proposal_status_ordinal: number;
  readonly disclosure_authorization_id: string | null;
  readonly disclosure_revocation_event_id: string | null;
  readonly source_event_ids: string[];
}

interface MemoryVersionRow extends Record<string, unknown> {
  readonly memory_id: string;
  readonly memory_version: string;
}

interface PreviousPacketRow extends Record<string, unknown> {
  readonly id: string;
  readonly packet_version: string;
}

interface ExistingPacketRow extends Record<string, unknown> {
  readonly id: string;
  readonly request_digest: string;
}

interface PacketIdeaAuthority {
  readonly ordinal: number;
  readonly proposalId: string;
  readonly proposalEventId: string;
  readonly proposalStatusEventId: string;
  readonly proposalStatusOrdinal: number;
  readonly disclosureAuthorizationId: string | null;
  readonly disclosureRevocationEventId: string | null;
  readonly sourceEventIds: readonly string[];
  readonly memoryIds: readonly string[];
  readonly memoryVersions: readonly string[];
  readonly contentDigest: string;
}

interface CurrentJobRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly node_brain_id: string;
  readonly conversation_id: string;
  readonly scope: "NODE_BRANCH";
  readonly policy_version: string;
  readonly node_state_version: string;
  readonly main_state_version: string;
  readonly requested_high_water_sequence: string;
  readonly through_event_id: string;
  readonly operation_key: string;
  readonly request_digest: string;
  readonly request_event_id: string;
  readonly estimated_delta_count: number;
  readonly ordinal: number;
  readonly status: "PENDING" | "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED";
  readonly worker_id: string | null;
  readonly lease_until: Date | null;
  readonly retry_at: Date | null;
  readonly transition_id: string;
  readonly transition_event_id: string;
}

interface TransitionDraft {
  readonly id: string;
  readonly jobId: string;
  readonly ordinal: number;
  readonly action: "CLAIM" | "RETRY" | "COMPLETE" | "FAIL";
  readonly fromStatus: "PENDING" | "CLAIMED" | "RETRY_SCHEDULED";
  readonly toStatus: "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED";
  readonly workerId: string | null;
  readonly leaseUntil: string | null;
  readonly retryAt: string | null;
  readonly packetId: string | null;
  readonly checkpointId: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function bounded(value: unknown, code: string, maximum = 200): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value !== value.trim() || value.includes("\u0000")) throw new Error(code);
  return value;
}

function key(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new Error("HANDOFF_IDEMPOTENCY_KEY_INVALID");
  }
  return value;
}

function stateVersion(value: unknown): string {
  const result = bounded(value, "HANDOFF_INPUT_INVALID");
  if (!/^[1-9][0-9]*$/.test(result) || BigInt(result) > 9_223_372_036_854_775_807n) {
    throw new Error("HANDOFF_INPUT_INVALID");
  }
  return result;
}

function validateInput(input: RefreshHandoffInput): RefreshHandoffInput {
  if (!input || typeof input !== "object") throw new Error("HANDOFF_INPUT_INVALID");
  const policyVersion = bounded(input.policyVersion, "HANDOFF_INPUT_INVALID");
  if (policyVersion !== HANDOFF_POLICY_VERSION) throw new Error("HANDOFF_POLICY_UNSUPPORTED");
  if (input.scope !== "NODE_BRANCH") throw new Error("HANDOFF_SCOPE_INVALID");
  return Object.freeze({
    accountId: uuid(input.accountId, "HANDOFF_INPUT_INVALID"),
    nodeBrainId: uuid(input.nodeBrainId, "HANDOFF_INPUT_INVALID"),
    conversationId: uuid(input.conversationId, "HANDOFF_INPUT_INVALID"),
    scope: input.scope,
    policyVersion,
    nodeStateVersion: stateVersion(input.nodeStateVersion),
    mainStateVersion: stateVersion(input.mainStateVersion),
    throughEventId: uuid(input.throughEventId, "HANDOFF_INPUT_INVALID"),
    idempotencyKey: key(input.idempotencyKey),
  });
}

function loadInput(input: RefreshHandoffInput, packetId: string) {
  return Object.freeze({
    packetId,
    accountId: input.accountId,
    nodeBrainId: input.nodeBrainId,
    conversationId: input.conversationId,
    scope: input.scope,
    policyVersion: input.policyVersion,
    nodeStateVersion: input.nodeStateVersion,
    mainStateVersion: input.mainStateVersion,
  });
}

function operationKeyFor(input: RefreshHandoffInput, highWaterSequence: string): string {
  return canonicalContentDigest({
    accountId: input.accountId,
    conversationId: input.conversationId,
    highWaterSequence,
    nodeBrainId: input.nodeBrainId,
    nodeStateVersion: input.nodeStateVersion,
    mainStateVersion: input.mainStateVersion,
    policyVersion: input.policyVersion,
    scope: input.scope,
  });
}

function refreshRequestDigest(input: RefreshHandoffInput, highWaterSequence: string): string {
  return canonicalContentDigest({
    accountId: input.accountId,
    conversationId: input.conversationId,
    nodeBrainId: input.nodeBrainId,
    nodeStateVersion: input.nodeStateVersion,
    mainStateVersion: input.mainStateVersion,
    policyVersion: input.policyVersion,
    scope: input.scope,
    throughEventId: input.throughEventId,
    highWaterSequence,
  });
}

function jobRequestDigest(
  input: RefreshHandoffInput,
  highWaterSequence: string,
  estimatedDeltaCount: number,
): string {
  return canonicalContentDigest({
    accountId: input.accountId,
    conversationId: input.conversationId,
    estimatedDeltaCount,
    highWaterSequence,
    nodeBrainId: input.nodeBrainId,
    nodeStateVersion: input.nodeStateVersion,
    mainStateVersion: input.mainStateVersion,
    policyVersion: input.policyVersion,
    scope: input.scope,
    throughEventId: input.throughEventId,
  });
}

function jobBody(input: {
  readonly jobId: string;
  readonly request: RefreshHandoffInput;
  readonly highWaterSequence: string;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly estimatedDeltaCount: number;
  readonly createdAt: string;
}): JsonValue {
  return {
    jobId: input.jobId,
    accountId: input.request.accountId,
    nodeBrainId: input.request.nodeBrainId,
    conversationId: input.request.conversationId,
    scope: input.request.scope,
    policyVersion: input.request.policyVersion,
    nodeStateVersion: input.request.nodeStateVersion,
    mainStateVersion: input.request.mainStateVersion,
    requestedHighWaterSequence: input.highWaterSequence,
    throughEventId: input.request.throughEventId,
    operationKey: input.operationKey,
    requestDigest: input.requestDigest,
    estimatedDeltaCount: input.estimatedDeltaCount,
    createdAt: input.createdAt,
  };
}

function transitionOperationDigest(draft: TransitionDraft): string {
  return canonicalContentDigest({
    jobId: draft.jobId,
    ordinal: draft.ordinal,
    action: draft.action,
    fromStatus: draft.fromStatus,
    toStatus: draft.toStatus,
    workerId: draft.workerId,
    leaseUntil: draft.leaseUntil,
    retryAt: draft.retryAt,
    packetId: draft.packetId,
    checkpointId: draft.checkpointId,
    errorCode: draft.errorCode,
  });
}

function transitionBody(draft: TransitionDraft, operationDigest: string): JsonValue {
  return {
    transitionId: draft.id,
    jobId: draft.jobId,
    ordinal: draft.ordinal,
    action: draft.action,
    fromStatus: draft.fromStatus,
    toStatus: draft.toStatus,
    workerId: draft.workerId,
    leaseUntil: draft.leaseUntil,
    retryAt: draft.retryAt,
    packetId: draft.packetId,
    checkpointId: draft.checkpointId,
    errorCode: draft.errorCode,
    operationDigest,
    createdAt: draft.createdAt,
  };
}

function currentJobColumns(): string {
  return `job.id::text,job.account_id::text,job.node_brain_id::text,
    job.conversation_id::text,job.scope,job.policy_version,job.node_state_version,
    job.main_state_version::text,
    job.requested_high_water_sequence::text,job.through_event_id::text,
    job.operation_key,job.request_digest,job.request_event_id::text,
    job.estimated_delta_count,current.ordinal,current.status,current.worker_id,
    current.lease_until,current.retry_at,current.transition_id::text,
    transition.transition_event_id::text`;
}

async function currentJob(database: EventDatabase, jobId: string): Promise<CurrentJobRow> {
  const rows = await database.query<CurrentJobRow>(
    `select ${currentJobColumns()}
     from handoff_refresh_jobs job
     join handoff_refresh_job_current current on current.id=job.id
     join handoff_refresh_job_transitions transition on transition.id=current.transition_id
     where job.id=$1 for share of job,transition`,
    [jobId],
  );
  if (rows.length !== 1) throw new Error("HANDOFF_JOB_NOT_FOUND");
  return rows[0]!;
}

async function appendJobTransition(
  database: EventDatabase,
  job: CurrentJobRow,
  draft: TransitionDraft,
): Promise<StoredEvent> {
  const operationDigest = transitionOperationDigest(draft);
  const body = transitionBody(draft, operationDigest);
  const bodyDigest = canonicalContentDigest(body);
  const event = await appendEvent(database, {
    aggregateId: `node-handoff-job:${job.id}`,
    accountId: job.account_id,
    actor: { type: "SYSTEM", id: "handoff-refresher" },
    type: draft.action === "CLAIM" ? "node.handoff.refresh.claimed"
      : draft.action === "RETRY" ? "node.handoff.refresh.retry_scheduled"
        : draft.action === "COMPLETE" ? "node.handoff.refresh.completed"
          : "node.handoff.refresh.failed",
    visibility: "PRIVATE_ACCOUNT",
    body,
    idempotencyKey: `node-handoff-transition:${operationDigest}`,
    causationId: job.transition_event_id,
    correlationId: job.id,
    occurredAt: new Date(draft.createdAt),
    policyVersion: job.policy_version,
  });
  await database.query(
    `insert into handoff_refresh_job_transitions (
       id,job_id,ordinal,action,from_status,to_status,worker_id,lease_until,retry_at,
       packet_id,checkpoint_id,error_code,transition_event_id,idempotency_key,operation_digest,
       body_digest,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [draft.id, draft.jobId, draft.ordinal, draft.action, draft.fromStatus, draft.toStatus,
      draft.workerId, draft.leaseUntil, draft.retryAt, draft.packetId, draft.checkpointId,
      draft.errorCode,
      event.id, `handoff-transition:${operationDigest}`, operationDigest, bodyDigest,
      event.occurredAt],
  );
  await database.query(
    `insert into handoff_refresh_job_transition_manifests (
       transition_id,job_id,transition_event_id,operation_digest,body_digest,
       event_request_hash,event_integrity_hash,created_at
     ) select $1,$2,event.id,$3,$4,event.request_hash,event.integrity_hash,$5
       from events event where event.id=$6`,
    [draft.id, draft.jobId, operationDigest, bodyDigest, event.occurredAt, event.id],
  );
  return event;
}

async function authorizeSnapshot(
  database: EventDatabase,
  input: RefreshHandoffInput,
): Promise<string> {
  const rows = await database.query<SnapshotRow>(
    `/* handoff-refresh-authority-metadata */
     select source.ingested_sequence::text,
            routed.ingested_sequence::text node_state_version,
            main.version::text main_state_version
     from accounts account
     join entitlements entitlement on entitlement.account_id=account.id
       and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
       and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
     join node_brains node on node.account_id=account.id and node.id=$2 and node.status='ACTIVE'
     join conversations conversation on conversation.account_id=account.id
       and conversation.id=$3 and conversation.node_brain_id=node.id and conversation.status='OPEN'
      join events source on source.id=$4 and source.account_id=account.id::text
      join lateral (select event.* from events event
        where event.aggregate_id=conversation.id::text
          and event.account_id=account.id::text
          and event.actor_type='NODE_BRAIN' and event.actor_id=node.id::text
          and event.type='node.reply.routed' and event.visibility='PRIVATE_ACCOUNT'
          and event.ingested_sequence<=source.ingested_sequence
        order by event.ingested_sequence desc,event.id desc limit 1) routed on true
      join lateral (select state.* from main_state_versions state
        order by state.version desc limit 1) main on true
      where account.id=$1 and account.status='ACTIVE'
      for share of account,entitlement,node,conversation,source`,
    [input.accountId, input.nodeBrainId, input.conversationId, input.throughEventId],
  );
  if (rows.length !== 1) throw new Error("HANDOFF_FORBIDDEN");
  if (rows[0]!.node_state_version !== input.nodeStateVersion
      || rows[0]!.main_state_version !== input.mainStateVersion) {
    throw new Error("HANDOFF_STATE_STALE");
  }
  return rows[0]!.ingested_sequence;
}

async function candidateRows(
  database: EventDatabase,
  input: RefreshHandoffInput,
  highWaterSequence: string,
): Promise<readonly CandidateRow[]> {
  return database.query<CandidateRow>(
    `/* handoff-bounded-current-proposals */
     select proposal.id::text proposal_id,proposal.created_event_id::text proposal_event_id,
            status.transition_event_id::text proposal_status_event_id,
            status.ordinal proposal_status_ordinal,
            proposal.disclosure_authorization_id::text disclosure_authorization_id,
            revoked.revoked_event_id::text disclosure_revocation_event_id,
            array(select value from jsonb_array_elements_text(proposal.source_event_ids) value
              order by value)::uuid[]::text[] source_event_ids
     from proposals proposal
      join events proposal_event on proposal_event.id=proposal.created_event_id
        and proposal_event.ingested_sequence<=$4::bigint
      left join events raw_private_event on raw_private_event.id=proposal.raw_private_text_event_id
        and raw_private_event.ingested_sequence<=$4::bigint
     join lateral (select transition.* from proposal_status_transitions transition
       join events transition_event on transition_event.id=transition.transition_event_id
       where transition.proposal_id=proposal.id
       order by transition.ordinal desc limit 1) status on status.to_status not in ('WITHDRAWN','REJECTED')
     join events status_event on status_event.id=status.transition_event_id
       and status_event.ingested_sequence<=$4::bigint
     left join proposal_disclosure_authorizations disclosure
       on disclosure.id=proposal.disclosure_authorization_id
       and disclosure.expires_at>clock_timestamp()
     left join proposal_disclosure_revocations revoked
       on revoked.authorization_id=disclosure.id
      where proposal.account_id=$1 and proposal.node_brain_id=$2 and proposal.conversation_id=$3
        and proposal.affected_main_state_ids ? $5
        and (proposal.privacy_scope<>'PROPOSAL_RAW_TEXT' or raw_private_event.id is not null)
       and ((proposal.privacy_scope='PROPOSAL_SUMMARY' and proposal.disclosure_authorization_id is null)
         or (proposal.privacy_scope='PROPOSAL_RAW_TEXT' and disclosure.id is not null
           and revoked.authorization_id is null))
       and exists (
         select 1 from memory_records memory
         join events memory_event on memory_event.id=memory.body_event_id
         where memory.scope='NODE_BRANCH' and memory.account_id=proposal.account_id
           and memory.node_brain_id=proposal.node_brain_id
           and memory.conversation_id=proposal.conversation_id
           and memory.valid_to is null and memory.conflict_state<>'SUPERSEDED'
           and memory_event.ingested_sequence<=$4::bigint
           and exists (select 1 from memory_sources source where source.memory_id=memory.id)
           and not exists (select 1 from memory_sources source where source.memory_id=memory.id
             and not (proposal.source_event_ids ? source.source_event_id::text)))
     order by greatest(proposal_event.ingested_sequence,status_event.ingested_sequence) desc,
              proposal.id
     limit ${MAX_HANDOFF_IDEAS + 1}`,
    [input.accountId, input.nodeBrainId, input.conversationId, highWaterSequence,
      input.mainStateVersion],
  );
}

async function memoryVersions(
  database: EventDatabase,
  input: RefreshHandoffInput,
  proposalId: string,
  highWaterSequence: string,
): Promise<readonly MemoryVersionRow[]> {
  const rows = await database.query<MemoryVersionRow>(
    `select memory.id::text memory_id,
            memory.body_event_id::text||':'||memory.conflict_state memory_version
     from proposals proposal
     join memory_records memory on memory.scope='NODE_BRANCH'
       and memory.account_id=proposal.account_id and memory.node_brain_id=proposal.node_brain_id
       and memory.conversation_id=proposal.conversation_id
       and memory.valid_to is null and memory.conflict_state<>'SUPERSEDED'
     join events memory_event on memory_event.id=memory.body_event_id
       and memory_event.ingested_sequence<=$5::bigint
     where proposal.id=$4 and proposal.account_id=$1 and proposal.node_brain_id=$2
       and proposal.conversation_id=$3
       and exists (select 1 from memory_sources source where source.memory_id=memory.id)
       and not exists (select 1 from memory_sources source where source.memory_id=memory.id
         and not (proposal.source_event_ids ? source.source_event_id::text))
     order by memory.id limit 61`,
    [input.accountId, input.nodeBrainId, input.conversationId, proposalId, highWaterSequence],
  );
  if (rows.length < 1 || rows.length > 60) throw new Error("HANDOFF_MEMORY_VERSION_LIMIT");
  return rows;
}

async function acquireCandidateLocks(
  database: EventDatabase,
  candidates: readonly CandidateRow[],
): Promise<void> {
  const locks = candidates.flatMap((candidate) => [
    `proposal-state:${candidate.proposal_id}`,
    ...(candidate.disclosure_authorization_id === null
      ? [] : [`proposal-disclosure:${candidate.disclosure_authorization_id}`]),
  ]).sort();
  if (locks.length > 0) {
    await database.query(
      "select pg_advisory_xact_lock(hashtextextended(item,0)) from unnest($1::text[]) item order by item",
      [locks],
    );
  }
}

function ideaBody(idea: PacketIdeaAuthority): JsonValue {
  return {
    ordinal: idea.ordinal,
    proposalId: idea.proposalId,
    proposalEventId: idea.proposalEventId,
    proposalStatusEventId: idea.proposalStatusEventId,
    proposalStatusOrdinal: idea.proposalStatusOrdinal,
    disclosureAuthorizationId: idea.disclosureAuthorizationId,
    disclosureRevocationEventId: idea.disclosureRevocationEventId,
    sourceEventIds: [...idea.sourceEventIds],
    memoryIds: [...idea.memoryIds],
    memoryVersions: [...idea.memoryVersions],
    contentDigest: idea.contentDigest,
  };
}

function packetBody(input: {
  readonly packetId: string;
  readonly request: RefreshHandoffInput;
  readonly packetVersion: string;
  readonly previousPacketId: string | null;
  readonly highWaterSequence: string;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly ideas: readonly PacketIdeaAuthority[];
  readonly createdAt: string;
}): JsonValue {
  return {
    packetId: input.packetId,
    accountId: input.request.accountId,
    nodeBrainId: input.request.nodeBrainId,
    conversationId: input.request.conversationId,
    scope: input.request.scope,
    policyVersion: input.request.policyVersion,
    nodeStateVersion: input.request.nodeStateVersion,
    mainStateVersion: input.request.mainStateVersion,
    packetVersion: input.packetVersion,
    previousPacketId: input.previousPacketId,
    highWaterSequence: input.highWaterSequence,
    throughEventId: input.request.throughEventId,
    operationKey: input.operationKey,
    requestDigest: input.requestDigest,
    ideas: input.ideas.map(ideaBody),
    createdAt: input.createdAt,
  };
}

async function bindPacketKey(
  database: EventDatabase,
  input: RefreshHandoffInput,
  packetId: string,
  operationKey: string,
  requestDigest: string,
  highWaterSequence: string,
  createdAt: Date,
): Promise<void> {
  const existing = await database.query<{
    readonly packet_id: string;
    readonly operation_key: string;
    readonly request_digest: string;
  } & Record<string, unknown>>(
    `select packet_id::text,operation_key,request_digest
     from handoff_packet_keys where idempotency_key=$1`,
    [input.idempotencyKey],
  );
  if (existing[0]) {
    if (existing[0].packet_id !== packetId || existing[0].operation_key !== operationKey
        || existing[0].request_digest !== requestDigest) {
      throw new Error("HANDOFF_IDEMPOTENCY_KEY_REUSED");
    }
    return;
  }
  await database.query(
    `insert into handoff_packet_keys
       (idempotency_key,packet_id,operation_key,request_digest,source_high_water_sequence,
        key_digest,created_at)
     values ($1,$2,$3,$4,$5,handoff_packet_key_digest($1,$2),$6)`,
    [input.idempotencyKey, packetId, operationKey, requestDigest, highWaterSequence, createdAt],
  );
}

async function appendPacketAuthority(
  database: EventDatabase,
  input: {
    readonly request: RefreshHandoffInput;
    readonly packetId: string;
    readonly packetVersion: string;
    readonly previousPacketId: string | null;
    readonly highWaterSequence: string;
    readonly operationKey: string;
    readonly requestDigest: string;
    readonly ideas: readonly PacketIdeaAuthority[];
  },
): Promise<StoredEvent> {
  const createdAt = new Date();
  const body = packetBody({ ...input, createdAt: createdAt.toISOString() });
  const bodyDigest = canonicalContentDigest(body);
  const event = await appendEvent(database, {
    aggregateId: `node-handoff:${input.request.nodeBrainId}`,
    accountId: input.request.accountId,
    actor: { type: "SYSTEM", id: "handoff-refresher" },
    type: "node.handoff.packet.refreshed",
    visibility: "PRIVATE_ACCOUNT",
    body,
    idempotencyKey: `node-handoff-packet:${input.operationKey}`,
    causationId: input.request.throughEventId,
    correlationId: input.packetId,
    occurredAt: createdAt,
    policyVersion: input.request.policyVersion,
  });
  const sourceIds = [...new Set(input.ideas.flatMap(({ sourceEventIds }) => sourceEventIds))];
  await database.query(
    `insert into handoff_packets (
       id,account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
       main_state_version,
       packet_version,previous_packet_id,source_high_water_sequence,through_event_id,operation_key,
       idempotency_key,request_digest,packet_event_id,idea_count,source_count,body_digest,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [input.packetId, input.request.accountId, input.request.nodeBrainId,
      input.request.conversationId, input.request.scope, input.request.policyVersion,
      input.request.nodeStateVersion, input.request.mainStateVersion,
      input.packetVersion, input.previousPacketId,
      input.highWaterSequence, input.request.throughEventId, input.operationKey,
      input.request.idempotencyKey, input.requestDigest, event.id, input.ideas.length,
      sourceIds.length, bodyDigest,
      event.occurredAt],
  );
  if (input.ideas.length > 0) {
    const parameters: unknown[] = [];
    const values = input.ideas.map((idea, row) => {
      const base = row * 12;
      parameters.push(input.packetId, idea.ordinal, idea.proposalId, idea.proposalEventId,
        idea.proposalStatusEventId, idea.proposalStatusOrdinal,
        idea.disclosureAuthorizationId, idea.disclosureRevocationEventId,
        [...idea.sourceEventIds], [...idea.memoryIds], [...idea.memoryVersions],
        idea.contentDigest);
      return `(${Array.from({ length: 12 }, (_, column) => `$${base + column + 1}`).join(",")})`;
    });
    await database.query(
      `insert into handoff_packet_ideas (
         packet_id,ordinal,proposal_id,proposal_event_id,proposal_status_event_id,
         proposal_status_ordinal,disclosure_authorization_id,disclosure_revocation_event_id,
         source_event_ids,memory_ids,memory_versions,content_digest
       ) values ${values.join(",")}`,
      parameters,
    );
  }
  await database.query(
    `insert into handoff_packet_manifests (
       packet_id,packet_event_id,operation_key,body_digest,event_request_hash,
       event_integrity_hash,created_at
     ) select $1,event.id,$2,$3,event.request_hash,event.integrity_hash,$4
       from events event where event.id=$5`,
    [input.packetId, input.operationKey, bodyDigest, event.occurredAt, event.id],
  );
  await bindPacketKey(database, input.request, input.packetId, input.operationKey,
    input.requestDigest, input.highWaterSequence, event.occurredAt);
  return event;
}

function checkpointBody(input: {
  readonly checkpointId: string;
  readonly request: RefreshHandoffInput;
  readonly checkpointVersion: string;
  readonly previousCheckpointId: string | null;
  readonly highWaterSequence: string;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}): JsonValue {
  return {
    checkpointId: input.checkpointId,
    accountId: input.request.accountId,
    nodeBrainId: input.request.nodeBrainId,
    conversationId: input.request.conversationId,
    scope: input.request.scope,
    policyVersion: input.request.policyVersion,
    nodeStateVersion: input.request.nodeStateVersion,
    mainStateVersion: input.request.mainStateVersion,
    checkpointVersion: input.checkpointVersion,
    previousCheckpointId: input.previousCheckpointId,
    highWaterSequence: input.highWaterSequence,
    throughEventId: input.request.throughEventId,
    operationKey: input.operationKey,
    requestDigest: input.requestDigest,
    result: "EMPTY",
    createdAt: input.createdAt,
  };
}

async function bindCheckpointKey(
  database: EventDatabase,
  input: RefreshHandoffInput,
  checkpointId: string,
  operationKey: string,
  requestDigest: string,
  highWaterSequence: string,
  createdAt: Date,
): Promise<void> {
  const existing = await database.query<{
    readonly checkpoint_id: string;
    readonly operation_key: string;
    readonly request_digest: string;
  } & Record<string, unknown>>(
    `select checkpoint_id::text,operation_key,request_digest
       from handoff_refresh_checkpoint_keys where idempotency_key=$1`,
    [input.idempotencyKey],
  );
  if (existing[0]) {
    if (existing[0].checkpoint_id !== checkpointId
        || existing[0].operation_key !== operationKey
        || existing[0].request_digest !== requestDigest) {
      throw new Error("HANDOFF_IDEMPOTENCY_KEY_REUSED");
    }
    return;
  }
  await database.query(
    `insert into handoff_refresh_checkpoint_keys (
       idempotency_key,checkpoint_id,operation_key,request_digest,
       source_high_water_sequence,key_digest,created_at
     ) values ($1,$2,$3,$4,$5,handoff_refresh_checkpoint_key_digest($1,$2),$6)`,
    [input.idempotencyKey, checkpointId, operationKey, requestDigest,
      highWaterSequence, createdAt],
  );
}

async function assertCheckpointAvailable(
  database: EventDatabase,
  checkpointId: string,
): Promise<{ readonly request_digest: string; readonly created_at: Date }> {
  const rows = await database.query<{
    readonly request_digest: string;
    readonly created_at: Date;
  } & Record<string, unknown>>(
    `select checkpoint.request_digest,checkpoint.created_at
       from handoff_refresh_checkpoints checkpoint
       join handoff_refresh_checkpoint_manifests manifest
         on manifest.checkpoint_id=checkpoint.id
        and manifest.checkpoint_event_id=checkpoint.checkpoint_event_id
        and manifest.operation_key=checkpoint.operation_key
        and manifest.body_digest=checkpoint.body_digest
        and manifest.created_at=checkpoint.created_at
       join events event on event.id=checkpoint.checkpoint_event_id
        and event.request_hash=manifest.event_request_hash
        and event.integrity_hash=manifest.event_integrity_hash
       join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
        and body.body_digest=checkpoint.body_digest
        and body.body_digest=recall_manifest_digest(
          handoff_refresh_checkpoint_event_body(checkpoint.id))
       join aggregate_data_keys data_key on data_key.id=body.data_key_id
       join transactional_outbox outbox on outbox.event_id=event.id
        and outbox.topic=event.type
        and outbox.payload=jsonb_build_object('eventId',event.id::text)
      where checkpoint.id=$1
      for share of data_key`,
    [checkpointId],
  );
  if (rows.length !== 1) throw new Error("HANDOFF_CHECKPOINT_UNAVAILABLE");
  return rows[0]!;
}

async function appendCheckpointAuthority(
  database: EventDatabase,
  input: {
    readonly request: RefreshHandoffInput;
    readonly checkpointId: string;
    readonly checkpointVersion: string;
    readonly previousCheckpointId: string | null;
    readonly highWaterSequence: string;
    readonly operationKey: string;
    readonly requestDigest: string;
  },
): Promise<StoredEvent> {
  const createdAt = new Date();
  const body = checkpointBody({ ...input, createdAt: createdAt.toISOString() });
  const bodyDigest = canonicalContentDigest(body);
  const event = await appendEvent(database, {
    aggregateId: `node-handoff-checkpoint:${input.request.nodeBrainId}`,
    accountId: input.request.accountId,
    actor: { type: "SYSTEM", id: "handoff-refresher" },
    type: "node.handoff.checkpoint.advanced",
    visibility: "PRIVATE_ACCOUNT",
    body,
    idempotencyKey: `node-handoff-checkpoint:${input.operationKey}`,
    causationId: input.request.throughEventId,
    correlationId: input.checkpointId,
    occurredAt: createdAt,
    policyVersion: input.request.policyVersion,
  });
  await database.query(
    `insert into handoff_refresh_checkpoints (
       id,account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
       main_state_version,checkpoint_version,previous_checkpoint_id,
       source_high_water_sequence,through_event_id,operation_key,idempotency_key,
       request_digest,checkpoint_event_id,body_digest,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [input.checkpointId, input.request.accountId, input.request.nodeBrainId,
      input.request.conversationId, input.request.scope, input.request.policyVersion,
      input.request.nodeStateVersion, input.request.mainStateVersion, input.checkpointVersion,
      input.previousCheckpointId, input.highWaterSequence, input.request.throughEventId,
      input.operationKey, input.request.idempotencyKey, input.requestDigest, event.id,
      bodyDigest, event.occurredAt],
  );
  await database.query(
    `insert into handoff_refresh_checkpoint_manifests (
       checkpoint_id,checkpoint_event_id,operation_key,body_digest,event_request_hash,
       event_integrity_hash,created_at
     ) select $1,event.id,$2,$3,event.request_hash,event.integrity_hash,$4
         from events event where event.id=$5`,
    [input.checkpointId, input.operationKey, bodyDigest, event.occurredAt, event.id],
  );
  await bindCheckpointKey(database, input.request, input.checkpointId,
    input.operationKey, input.requestDigest, input.highWaterSequence, event.occurredAt);
  return event;
}

export async function refreshHandoff(
  context: HandoffContext,
  rawInput: RefreshHandoffInput,
): Promise<HandoffRefreshResult> {
  if (!context || typeof context !== "object" || !context.db) {
    throw new Error("HANDOFF_CONTEXT_INVALID");
  }
  const input = validateInput(rawInput);
  let packetId: string | null = null;
  let checkpointId: string | null = null;
  let highWaterSequence = "0";
  await context.db.transaction(async (transaction) => {
    highWaterSequence = await authorizeSnapshot(transaction, input);
    const requestDigest = refreshRequestDigest(input, highWaterSequence);
    const operationKey = operationKeyFor(input, highWaterSequence);
    await transaction.query(
      "select pg_advisory_xact_lock(hashtextextended(item,0)) from unnest($1::text[]) item order by item",
      [[
        `handoff-identity:${input.accountId}:${input.nodeBrainId}:${input.conversationId}:${input.scope}:${input.policyVersion}:${input.nodeStateVersion}:${input.mainStateVersion}`,
        `handoff-operation:${operationKey}`,
        `handoff-idempotency:${input.idempotencyKey}`,
      ].sort()],
    );
    const keyRows = await transaction.query<{
      readonly packet_id: string;
      readonly operation_key: string;
      readonly request_digest: string;
    } & Record<string, unknown>>(
      `select packet_id::text,operation_key,request_digest from handoff_packet_keys
       where idempotency_key=$1`,
      [input.idempotencyKey],
    );
    if (keyRows[0]) {
      if (keyRows[0].operation_key !== operationKey || keyRows[0].request_digest !== requestDigest) {
        throw new Error("HANDOFF_IDEMPOTENCY_KEY_REUSED");
      }
      packetId = keyRows[0].packet_id;
      return;
    }
    const checkpointKeyRows = await transaction.query<{
      readonly checkpoint_id: string;
      readonly operation_key: string;
      readonly request_digest: string;
    } & Record<string, unknown>>(
      `select key.checkpoint_id::text,key.operation_key,key.request_digest
         from handoff_refresh_checkpoint_keys key
         join handoff_refresh_checkpoints checkpoint on checkpoint.id=key.checkpoint_id
          and checkpoint.operation_key=key.operation_key
          and checkpoint.request_digest=key.request_digest
          and checkpoint.source_high_water_sequence=key.source_high_water_sequence
          and checkpoint.created_at=key.created_at
          and key.key_digest=handoff_refresh_checkpoint_key_digest(
            key.idempotency_key,checkpoint.id)
        where key.idempotency_key=$1`,
      [input.idempotencyKey],
    );
    if (checkpointKeyRows[0]) {
      if (checkpointKeyRows[0].operation_key !== operationKey
          || checkpointKeyRows[0].request_digest !== requestDigest) {
        throw new Error("HANDOFF_IDEMPOTENCY_KEY_REUSED");
      }
      await assertCheckpointAvailable(transaction, checkpointKeyRows[0].checkpoint_id);
      checkpointId = checkpointKeyRows[0].checkpoint_id;
      return;
    }
    const existing = await transaction.query<ExistingPacketRow>(
      "select id::text,request_digest from handoff_packets where operation_key=$1",
      [operationKey],
    );
    if (existing[0]) {
      if (existing[0].request_digest !== requestDigest) throw new Error("HANDOFF_OPERATION_REUSED");
      packetId = existing[0].id;
      const row = await transaction.one<{ readonly created_at: Date }>(
        "select created_at from handoff_packets where id=$1", [packetId],
      );
       await bindPacketKey(transaction, input, packetId, operationKey, requestDigest,
         highWaterSequence, row.created_at);
      return;
    }
    const existingCheckpoint = await transaction.query<ExistingPacketRow>(
      `select id::text,request_digest from handoff_refresh_checkpoints
        where operation_key=$1`,
      [operationKey],
    );
    if (existingCheckpoint[0]) {
      if (existingCheckpoint[0].request_digest !== requestDigest) {
        throw new Error("HANDOFF_OPERATION_REUSED");
      }
      checkpointId = existingCheckpoint[0].id;
      const available = await assertCheckpointAvailable(transaction, checkpointId);
      await bindCheckpointKey(transaction, input, checkpointId, operationKey, requestDigest,
        highWaterSequence, available.created_at);
      return;
    }
    let candidates = await candidateRows(transaction, input, highWaterSequence);
    if (candidates.length > MAX_HANDOFF_IDEAS) candidates = candidates.slice(0, MAX_HANDOFF_IDEAS);
    if (candidates.length === 0) {
      const previous = await transaction.query<PreviousPacketRow>(
        `select id::text,checkpoint_version::text packet_version
           from handoff_refresh_checkpoints
          where account_id=$1 and node_brain_id=$2 and conversation_id=$3 and scope=$4
            and policy_version=$5 and node_state_version=$6 and main_state_version=$7::bigint
          order by source_high_water_sequence desc,checkpoint_version desc limit 1 for share`,
        [input.accountId, input.nodeBrainId, input.conversationId, input.scope,
          input.policyVersion, input.nodeStateVersion, input.mainStateVersion],
      );
      checkpointId = randomUUID();
      await appendCheckpointAuthority(transaction, {
        request: input,
        checkpointId,
        checkpointVersion: String(previous[0] ? BigInt(previous[0].packet_version) + 1n : 1n),
        previousCheckpointId: previous[0]?.id ?? null,
        highWaterSequence,
        operationKey,
        requestDigest,
      });
      return;
    }
    await acquireCandidateLocks(transaction, candidates);
    const lockedCandidates = await candidateRows(transaction, input, highWaterSequence);
    if (lockedCandidates.length < candidates.length
        || lockedCandidates.slice(0, candidates.length).some((candidate, index) => (
          candidate.proposal_id !== candidates[index]!.proposal_id
          || candidate.proposal_status_event_id !== candidates[index]!.proposal_status_event_id
          || candidate.disclosure_authorization_id !== candidates[index]!.disclosure_authorization_id
        ))) {
      throw new Error("HANDOFF_AUTHORITY_CHANGED");
    }
    candidates = lockedCandidates.slice(0, MAX_HANDOFF_IDEAS);
    const ideas: PacketIdeaAuthority[] = [];
    let serializedBytes = 0;
    for (const [ordinal, candidate] of candidates.entries()) {
      const versions = await memoryVersions(
        transaction, input, candidate.proposal_id, highWaterSequence,
      );
      const proposal = await getProposal({ db: transaction }, {
        accountId: input.accountId,
        proposalId: candidate.proposal_id,
      });
      const versionPointers = versions.map(({ memory_id, memory_version }) => ({
        memoryId: memory_id,
        version: memory_version,
      }));
      const proposalBytes = handoffProposalPayloadBytes(proposal, versionPointers);
      if (proposalBytes > MAX_HANDOFF_SERIALIZED_BYTES) {
        throw new Error("HANDOFF_PROPOSAL_SIZE_LIMIT");
      }
      if (ideas.length > 0 && serializedBytes + proposalBytes > MAX_HANDOFF_SERIALIZED_BYTES) break;
      serializedBytes += proposalBytes;
      ideas.push(Object.freeze({
        ordinal,
        proposalId: candidate.proposal_id,
        proposalEventId: candidate.proposal_event_id,
        proposalStatusEventId: candidate.proposal_status_event_id,
        proposalStatusOrdinal: candidate.proposal_status_ordinal,
        disclosureAuthorizationId: candidate.disclosure_authorization_id,
        disclosureRevocationEventId: candidate.disclosure_revocation_event_id,
        sourceEventIds: Object.freeze([...candidate.source_event_ids]),
        memoryIds: Object.freeze(versions.map(({ memory_id }) => memory_id)),
        memoryVersions: Object.freeze(versions.map(({ memory_version }) => memory_version)),
        contentDigest: proposalHandoffContentDigest(proposal),
      }));
    }
    const previous = await transaction.query<PreviousPacketRow>(
      `select id::text,packet_version::text from handoff_packets
        where account_id=$1 and node_brain_id=$2 and conversation_id=$3 and scope=$4
          and policy_version=$5 and node_state_version=$6 and main_state_version=$7::bigint
       order by source_high_water_sequence desc,packet_version desc limit 1 for share`,
      [input.accountId, input.nodeBrainId, input.conversationId, input.scope,
        input.policyVersion, input.nodeStateVersion, input.mainStateVersion],
    );
    packetId = randomUUID();
    await appendPacketAuthority(transaction, {
      request: input,
      packetId,
      packetVersion: String(previous[0] ? BigInt(previous[0].packet_version) + 1n : 1n),
      previousPacketId: previous[0]?.id ?? null,
      highWaterSequence,
      operationKey,
      requestDigest,
      ideas,
    });
  });
  if (packetId === null) {
    if (checkpointId === null) throw new Error("HANDOFF_CHECKPOINT_MISSING");
    return Object.freeze({ status: "EMPTY", highWaterSequence, checkpointId });
  }
  return Object.freeze({
    status: "COMPLETED",
    packet: await loadHandoff(context, loadInput(input, packetId)),
  });
}

export const refreshNodeHandoff = refreshHandoff;

export async function refreshHandoffIncrementally(
  context: HandoffContext,
  rawInput: RefreshHandoffInput,
): Promise<HandoffRefreshResult | { readonly status: "QUEUED"; readonly job: HandoffRefreshJob }> {
  if (!context || typeof context !== "object" || !context.db) {
    throw new Error("HANDOFF_CONTEXT_INVALID");
  }
  const input = validateInput(rawInput);
  const deltaCount = await context.db.transaction(async (transaction) => {
    const highWaterSequence = await authorizeSnapshot(transaction, input);
    const previous = await transaction.query<{ readonly source_high_water_sequence: string }>(
      `select max(authority.source_high_water_sequence)::text source_high_water_sequence
         from (
           select packet.source_high_water_sequence from handoff_packets packet
            where packet.account_id=$1 and packet.node_brain_id=$2
              and packet.conversation_id=$3 and packet.scope=$4
              and packet.policy_version=$5 and packet.node_state_version=$6
              and packet.main_state_version=$7::bigint
           union all
           select checkpoint.source_high_water_sequence from handoff_refresh_checkpoints checkpoint
            where checkpoint.account_id=$1 and checkpoint.node_brain_id=$2
              and checkpoint.conversation_id=$3 and checkpoint.scope=$4
              and checkpoint.policy_version=$5 and checkpoint.node_state_version=$6
              and checkpoint.main_state_version=$7::bigint
         ) authority`,
      [input.accountId, input.nodeBrainId, input.conversationId, input.scope,
        input.policyVersion, input.nodeStateVersion, input.mainStateVersion],
    );
    const from = previous[0]?.source_high_water_sequence ?? "0";
    const rows = await transaction.query<{ readonly ingested_sequence: string }>(
      `select distinct relevant.ingested_sequence from (
         select event.ingested_sequence from proposals proposal
         join events event on event.id=proposal.created_event_id
         where proposal.account_id=$1 and proposal.node_brain_id=$2
           and proposal.conversation_id=$3
         union all
         select event.ingested_sequence from proposals proposal
         join events event on event.id=proposal.raw_private_text_event_id
         where proposal.account_id=$1 and proposal.node_brain_id=$2
           and proposal.conversation_id=$3
         union all
         select event.ingested_sequence from proposals proposal
         join proposal_status_transitions transition on transition.proposal_id=proposal.id
         join events event on event.id=transition.transition_event_id
         where proposal.account_id=$1 and proposal.node_brain_id=$2
           and proposal.conversation_id=$3
         union all
         select event.ingested_sequence from memory_extraction_runs run
         join events event on event.id=run.consolidation_event_id
         where run.scope='NODE_BRANCH' and run.account_id=$1 and run.node_brain_id=$2
           and run.conversation_id=$3
         union all
         select event.ingested_sequence from proposals proposal
         join proposal_disclosure_revocations revoked
           on revoked.authorization_id=proposal.disclosure_authorization_id
         join events event on event.id=revoked.revoked_event_id
         where proposal.account_id=$1 and proposal.node_brain_id=$2
           and proposal.conversation_id=$3
       ) relevant
       where relevant.ingested_sequence>$4::bigint and relevant.ingested_sequence<=$5::bigint
       order by relevant.ingested_sequence limit 9`,
      [input.accountId, input.nodeBrainId, input.conversationId, from, highWaterSequence],
    );
    return rows.length;
  });
  if (deltaCount <= 8) return refreshHandoff(context, input);
  return Object.freeze({
    status: "QUEUED" as const,
    job: await enqueueHandoffRefresh(context, input, { estimatedDeltaCount: deltaCount }),
  });
}

export async function enqueueHandoffRefresh(
  context: HandoffContext,
  rawInput: RefreshHandoffInput,
  options: { readonly estimatedDeltaCount: number },
): Promise<HandoffRefreshJob> {
  if (!context || typeof context !== "object" || !context.db) {
    throw new Error("HANDOFF_CONTEXT_INVALID");
  }
  const input = validateInput(rawInput);
  const estimatedDeltaCount = options?.estimatedDeltaCount;
  if (!Number.isSafeInteger(estimatedDeltaCount)
      || estimatedDeltaCount < 9 || estimatedDeltaCount > 1_000_000) {
    throw new Error("HANDOFF_JOB_DELTA_INVALID");
  }
  return context.db.transaction(async (transaction) => {
    const highWaterSequence = await authorizeSnapshot(transaction, input);
    const operationKey = operationKeyFor(input, highWaterSequence);
    const requestDigest = jobRequestDigest(input, highWaterSequence, estimatedDeltaCount);
    await transaction.query(
      "select pg_advisory_xact_lock(hashtextextended(item,0)) from unnest($1::text[]) item order by item",
      [[`handoff-job-operation:${operationKey}`, `handoff-job-key:${input.idempotencyKey}`].sort()],
    );
    const keyed = await transaction.query<{
      readonly job_id: string; readonly operation_key: string; readonly request_digest: string;
    } & Record<string, unknown>>(
      `select job_id::text,operation_key,request_digest from handoff_refresh_job_keys
       where idempotency_key=$1`,
      [input.idempotencyKey],
    );
    if (keyed[0]) {
      if (keyed[0].operation_key !== operationKey || keyed[0].request_digest !== requestDigest) {
        throw new Error("HANDOFF_IDEMPOTENCY_KEY_REUSED");
      }
      const existing = await transaction.one<{
        readonly request_event_id: string;
        readonly status: HandoffRefreshJob["status"];
      }>(
        `select job.request_event_id::text,current.status from handoff_refresh_jobs job
         join handoff_refresh_job_current current on current.id=job.id where job.id=$1`,
        [keyed[0].job_id],
      );
      return Object.freeze({
        id: keyed[0].job_id,
        eventId: existing.request_event_id,
        status: existing.status,
        highWaterSequence,
        estimatedDeltaCount,
      });
    }
    const byOperation = await transaction.query<{
      readonly id: string; readonly request_digest: string; readonly request_event_id: string;
      readonly status: HandoffRefreshJob["status"];
    } & Record<string, unknown>>(
      `select job.id::text,job.request_digest,job.request_event_id::text,current.status
       from handoff_refresh_jobs job join handoff_refresh_job_current current on current.id=job.id
       where job.operation_key=$1`,
      [operationKey],
    );
    if (byOperation[0]) {
      if (byOperation[0].request_digest !== requestDigest) throw new Error("HANDOFF_OPERATION_REUSED");
      const created = await transaction.one<{ readonly created_at: Date }>(
        "select created_at from handoff_refresh_jobs where id=$1", [byOperation[0].id],
      );
      await transaction.query(
        `insert into handoff_refresh_job_keys
           (idempotency_key,job_id,operation_key,request_digest,created_at)
         values ($1,$2,$3,$4,$5)`,
        [input.idempotencyKey, byOperation[0].id, operationKey, requestDigest, created.created_at],
      );
      return Object.freeze({
        id: byOperation[0].id,
        eventId: byOperation[0].request_event_id,
        status: byOperation[0].status,
        highWaterSequence,
        estimatedDeltaCount,
      });
    }
    const jobId = randomUUID();
    const transitionId = randomUUID();
    const createdAt = new Date();
    const queueOperationDigest = canonicalContentDigest({
      jobId, ordinal: 0, action: "QUEUE", fromStatus: null, toStatus: "PENDING",
      workerId: null, leaseUntil: null, retryAt: null, packetId: null,
      checkpointId: null, errorCode: null,
    });
    const body = jobBody({
      jobId, request: input, highWaterSequence, operationKey, requestDigest,
      estimatedDeltaCount, createdAt: createdAt.toISOString(),
    });
    const bodyDigest = canonicalContentDigest(body);
    const event = await appendEvent(transaction, {
      aggregateId: `node-handoff-job:${jobId}`,
      accountId: input.accountId,
      actor: { type: "SYSTEM", id: "handoff-refresher" },
      type: "node.handoff.refresh.queued",
      visibility: "PRIVATE_ACCOUNT",
      body,
      idempotencyKey: `node-handoff-job:${operationKey}`,
      causationId: input.throughEventId,
      correlationId: jobId,
      occurredAt: createdAt,
      policyVersion: input.policyVersion,
    });
    await transaction.query(
      `insert into handoff_refresh_jobs (
         id,account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
         main_state_version,
         requested_high_water_sequence,through_event_id,operation_key,request_digest,
         request_event_id,estimated_delta_count,body_digest,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [jobId, input.accountId, input.nodeBrainId, input.conversationId, input.scope,
        input.policyVersion, input.nodeStateVersion, input.mainStateVersion,
        highWaterSequence, input.throughEventId,
        operationKey, requestDigest, event.id, estimatedDeltaCount, bodyDigest, event.occurredAt],
    );
    await transaction.query(
      `insert into handoff_refresh_job_keys
         (idempotency_key,job_id,operation_key,request_digest,created_at)
       values ($1,$2,$3,$4,$5)`,
      [input.idempotencyKey, jobId, operationKey, requestDigest, event.occurredAt],
    );
    await transaction.query(
      `insert into handoff_refresh_job_transitions (
         id,job_id,ordinal,action,from_status,to_status,worker_id,lease_until,retry_at,
         packet_id,checkpoint_id,error_code,transition_event_id,idempotency_key,operation_digest,
         body_digest,created_at
       ) values ($1,$2,0,'QUEUE',null,'PENDING',null,null,null,null,null,null,$3,$4,$5,$6,$7)`,
      [transitionId, jobId, event.id, `handoff-queue:${operationKey}`,
        queueOperationDigest, bodyDigest, event.occurredAt],
    );
    await transaction.query(
      `insert into handoff_refresh_job_manifests (
         job_id,request_event_id,operation_key,body_digest,event_request_hash,
         event_integrity_hash,created_at
       ) select $1,event.id,$2,$3,event.request_hash,event.integrity_hash,$4
         from events event where event.id=$5`,
      [jobId, operationKey, bodyDigest, event.occurredAt, event.id],
    );
    await transaction.query(
      `insert into handoff_refresh_job_transition_manifests (
         transition_id,job_id,transition_event_id,operation_digest,body_digest,
         event_request_hash,event_integrity_hash,created_at
       ) select $1,$2,event.id,$3,$4,event.request_hash,event.integrity_hash,$5
         from events event where event.id=$6`,
      [transitionId, jobId, queueOperationDigest, bodyDigest, event.occurredAt, event.id],
    );
    return Object.freeze({
      id: jobId,
      eventId: event.id,
      status: "PENDING" as const,
      highWaterSequence,
      estimatedDeltaCount,
    });
  });
}

export async function claimHandoffRefreshJob(
  context: HandoffContext,
  input: { readonly jobId: string; readonly workerId: string; readonly leaseMilliseconds: number },
): Promise<HandoffRefreshJobClaim> {
  if (!context || typeof context !== "object" || !context.db) throw new Error("HANDOFF_CONTEXT_INVALID");
  const jobId = uuid(input?.jobId, "HANDOFF_JOB_INPUT_INVALID");
  const workerId = bounded(input?.workerId, "HANDOFF_JOB_INPUT_INVALID");
  if (!Number.isSafeInteger(input?.leaseMilliseconds)
      || input.leaseMilliseconds < 1_000 || input.leaseMilliseconds > 300_000) {
    throw new Error("HANDOFF_JOB_LEASE_INVALID");
  }
  return context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `handoff-job:${jobId}`,
    ]);
    const job = await currentJob(transaction, jobId);
    const clock = await transaction.one<{ readonly now: Date; readonly lease_until: Date }>(
      `with clock as (select clock_timestamp() now)
       select now,now+($1::integer*interval '1 millisecond') lease_until from clock`,
      [input.leaseMilliseconds],
    );
    const available = job.status === "PENDING"
      || (job.status === "RETRY_SCHEDULED" && job.retry_at !== null && job.retry_at <= clock.now)
      || (job.status === "CLAIMED" && job.lease_until !== null && job.lease_until <= clock.now);
    if (!available) throw new Error("HANDOFF_JOB_UNAVAILABLE");
    const draft: TransitionDraft = {
      id: randomUUID(), jobId, ordinal: job.ordinal + 1, action: "CLAIM",
      fromStatus: job.status as "PENDING" | "CLAIMED" | "RETRY_SCHEDULED",
      toStatus: "CLAIMED", workerId, leaseUntil: clock.lease_until.toISOString(),
      retryAt: null, packetId: null, checkpointId: null, errorCode: null,
      createdAt: clock.now.toISOString(),
    };
    const event = await appendJobTransition(transaction, job, draft);
    return Object.freeze({
      jobId,
      accountId: job.account_id,
      nodeBrainId: job.node_brain_id,
      conversationId: job.conversation_id,
      scope: job.scope,
      policyVersion: job.policy_version,
      nodeStateVersion: job.node_state_version,
      mainStateVersion: job.main_state_version,
      throughEventId: job.through_event_id,
      workerId,
      leaseUntil: clock.lease_until.toISOString(),
      transitionEventId: event.id,
    });
  });
}

async function completeHandoffRefreshJob(
  context: HandoffContext,
  claim: HandoffRefreshJobClaim,
  result: { readonly packetId: string | null; readonly checkpointId: string | null },
): Promise<void> {
  await context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `handoff-job:${claim.jobId}`,
    ]);
    await authorizeSnapshot(transaction, {
      accountId: claim.accountId,
      nodeBrainId: claim.nodeBrainId,
      conversationId: claim.conversationId,
      scope: claim.scope,
      policyVersion: claim.policyVersion,
      nodeStateVersion: claim.nodeStateVersion,
      mainStateVersion: claim.mainStateVersion,
      throughEventId: claim.throughEventId,
      idempotencyKey: `handoff-job-complete:${claim.jobId}`,
    });
    if (result.checkpointId !== null) {
      await assertCheckpointAvailable(transaction, result.checkpointId);
    }
    const job = await currentJob(transaction, claim.jobId);
    const clock = await transaction.one<{ readonly now: Date }>("select clock_timestamp() now");
    if (job.status !== "CLAIMED" || job.worker_id !== claim.workerId
        || job.transition_event_id !== claim.transitionEventId
        || job.lease_until === null || job.lease_until <= clock.now) {
      throw new Error("HANDOFF_JOB_LEASE_LOST");
    }
    await appendJobTransition(transaction, job, {
      id: randomUUID(), jobId: claim.jobId, ordinal: job.ordinal + 1,
      action: "COMPLETE", fromStatus: "CLAIMED", toStatus: "COMPLETED",
      workerId: claim.workerId, leaseUntil: null, retryAt: null,
      packetId: result.packetId, checkpointId: result.checkpointId,
      errorCode: null, createdAt: clock.now.toISOString(),
    });
  });
}

export async function processHandoffRefreshJob(
  context: HandoffContext,
  claim: HandoffRefreshJobClaim,
): Promise<{
  readonly status: "COMPLETED";
  readonly packet: DurableHandoffPacket | null;
  readonly checkpointId: string | null;
}> {
  const durable = await context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `handoff-job:${claim.jobId}`,
    ]);
    const job = await currentJob(transaction, claim.jobId);
    const now = await transaction.one<{ readonly now: Date }>("select clock_timestamp() now");
    if (job.status !== "CLAIMED" || job.worker_id !== claim.workerId
        || job.transition_event_id !== claim.transitionEventId
        || job.lease_until === null || job.lease_until <= now.now) {
      throw new Error("HANDOFF_JOB_LEASE_LOST");
    }
    return Object.freeze({
      accountId: job.account_id,
      nodeBrainId: job.node_brain_id,
      conversationId: job.conversation_id,
      scope: job.scope,
      policyVersion: job.policy_version,
      nodeStateVersion: job.node_state_version,
      mainStateVersion: job.main_state_version,
      throughEventId: job.through_event_id,
    });
  });
  const refreshed = await refreshHandoff(context, {
    ...durable,
    idempotencyKey: `handoff-job-packet:${claim.jobId}`,
  });
  if (refreshed.status === "COMPLETED") {
    await completeHandoffRefreshJob(context, claim, {
      packetId: refreshed.packet.id,
      checkpointId: null,
    });
    return Object.freeze({ status: "COMPLETED" as const,
      packet: refreshed.packet, checkpointId: null });
  }
  await completeHandoffRefreshJob(context, claim, {
    packetId: null,
    checkpointId: refreshed.checkpointId,
  });
  return Object.freeze({ status: "COMPLETED" as const,
    packet: null, checkpointId: refreshed.checkpointId });
}

export async function retryHandoffRefreshJob(
  context: HandoffContext,
  claim: HandoffRefreshJobClaim,
  input: { readonly retryDelayMilliseconds: number; readonly errorCode: string },
): Promise<{ readonly status: "RETRY_SCHEDULED"; readonly retryAt: string }> {
  if (!Number.isSafeInteger(input?.retryDelayMilliseconds)
      || input.retryDelayMilliseconds < 1_000 || input.retryDelayMilliseconds > 3_600_000
      || typeof input.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,119}$/.test(input.errorCode)) {
    throw new Error("HANDOFF_JOB_RETRY_INVALID");
  }
  return context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `handoff-job:${claim.jobId}`,
    ]);
    const job = await currentJob(transaction, claim.jobId);
    const clock = await transaction.one<{ readonly now: Date; readonly retry_at: Date }>(
      `with clock as (select clock_timestamp() now)
       select now,now+($1::integer*interval '1 millisecond') retry_at from clock`,
      [input.retryDelayMilliseconds],
    );
    if (job.status !== "CLAIMED" || job.worker_id !== claim.workerId
        || job.transition_event_id !== claim.transitionEventId
        || job.lease_until === null || job.lease_until <= clock.now) {
      throw new Error("HANDOFF_JOB_LEASE_LOST");
    }
    await appendJobTransition(transaction, job, {
      id: randomUUID(), jobId: claim.jobId, ordinal: job.ordinal + 1,
      action: "RETRY", fromStatus: "CLAIMED", toStatus: "RETRY_SCHEDULED",
      workerId: claim.workerId, leaseUntil: null, retryAt: clock.retry_at.toISOString(),
      packetId: null, checkpointId: null, errorCode: input.errorCode,
      createdAt: clock.now.toISOString(),
    });
    return Object.freeze({ status: "RETRY_SCHEDULED" as const,
      retryAt: clock.retry_at.toISOString() });
  });
}

export async function failHandoffRefreshJob(
  context: HandoffContext,
  claim: HandoffRefreshJobClaim,
  input: { readonly errorCode: string },
): Promise<{ readonly status: "FAILED" }> {
  if (typeof input?.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,119}$/.test(input.errorCode)) {
    throw new Error("HANDOFF_JOB_FAILURE_INVALID");
  }
  return context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `handoff-job:${claim.jobId}`,
    ]);
    const job = await currentJob(transaction, claim.jobId);
    const clock = await transaction.one<{ readonly now: Date }>("select clock_timestamp() now");
    if (job.status !== "CLAIMED" || job.worker_id !== claim.workerId
        || job.transition_event_id !== claim.transitionEventId
        || job.lease_until === null || job.lease_until <= clock.now) {
      throw new Error("HANDOFF_JOB_LEASE_LOST");
    }
    await appendJobTransition(transaction, job, {
      id: randomUUID(), jobId: claim.jobId, ordinal: job.ordinal + 1,
      action: "FAIL", fromStatus: "CLAIMED", toStatus: "FAILED",
      workerId: claim.workerId, leaseUntil: null, retryAt: null,
      packetId: null, checkpointId: null, errorCode: input.errorCode,
      createdAt: clock.now.toISOString(),
    });
    return Object.freeze({ status: "FAILED" as const });
  });
}
