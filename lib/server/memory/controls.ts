import { randomUUID } from "node:crypto";
import { canonicalContentDigest } from "../events/integrity";
import { appendEvent, readEventBodies, readEventBody } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "../history/cursor";
import type {
  ExtractedMemoryBase,
  ExtractedMemorySet,
  MemoryGoalStatus,
  MemoryType,
} from "./types";
import {
  createMemoryWorkerContext,
  processMemoryEvent,
} from "../../../worker/consolidation/process-event";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

export type PrivacyCapability =
  | "INSPECT_MEMORY"
  | "CORRECT_MEMORY"
  | "ARCHIVE_CONVERSATION"
  | "EXPORT_DATA"
  | "FORGET_CONVERSATION";

export type PrivacyActor =
  | {
      readonly kind: "ACCOUNT_OWNER";
      readonly accountId: string;
      readonly sessionId: string;
      readonly capability: PrivacyCapability;
    }
  | {
      readonly kind: "LEGAL";
      readonly actorId: string;
      readonly accountId: string;
      readonly authorityId: string;
      readonly legalRole: "PRIVACY_OFFICER";
      readonly capability: "FORGET_CONVERSATION" | "EXPORT_DATA";
    };

export interface PrivacyCachePurger {
  purgeConversation(input: {
    readonly accountId: string;
    readonly nodeBrainId: string;
    readonly conversationId: string;
  }): Promise<void>;
}

export interface MemoryControlContext {
  readonly db: EventDatabase;
  readonly cache?: PrivacyCachePurger;
  /** Test/host fault boundary around the atomic final propagation publication. */
  readonly publishForgetCompletion?: (publish: () => Promise<void>) => Promise<void>;
  readonly exportSnapshotLifetimeSeconds?: number;
}

interface AuthorizedTopology {
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly status: "OPEN" | "ARCHIVED";
  readonly actorId: string;
  readonly authorityKind: "ACCOUNT_OWNER" | "LEGAL";
  readonly authorityReference: string;
}

interface MemoryRow extends Record<string, unknown> {
  readonly id: string;
  readonly body_event_id: string;
  readonly type: MemoryType;
  readonly scope: string;
  readonly source_event_ids: string[];
  readonly created_at: Date;
  readonly supersedes_memory_id: string | null;
  readonly correction_state: string;
}

function uuid(value: string, error = "FORBIDDEN"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(error);
  return value;
}

function boundedText(value: string, maximum: number, error: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(error);
  }
  return value;
}

function scopedCommandKey(
  kind: "CORRECT" | "ARCHIVE" | "RESTORE",
  accountId: string,
  conversationId: string,
  idempotencyKey: string,
): string {
  return `privacy-${kind.toLowerCase()}:${canonicalContentDigest({
    kind, accountId, conversationId, idempotencyKey,
  })}`;
}

function pageSize(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error("INVALID_PRIVACY_PAGE_LIMIT");
  }
  return limit;
}

function assertCapability(actor: PrivacyActor, capability: PrivacyCapability): void {
  if (!actor || typeof actor !== "object" || actor.capability !== capability) {
    throw new Error("FORBIDDEN");
  }
}

async function authorizeAccount(
  database: EventDatabase,
  actor: PrivacyActor,
  capability: PrivacyCapability,
): Promise<{ readonly accountId: string; readonly actorId: string;
  readonly authorityKind: "ACCOUNT_OWNER" | "LEGAL"; readonly authorityReference: string }> {
  assertCapability(actor, capability);
  uuid(actor.accountId);
  if (actor.kind === "ACCOUNT_OWNER") {
    uuid(actor.sessionId);
    const rows = await database.query<{ account_id: string } & Record<string, unknown>>(
      `/* privacy-account-owner-authority */
       select account.id::text account_id
       from accounts account
       join entitlements entitlement on entitlement.account_id=account.id
         and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
         and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
       join sessions session on session.account_id=account.id and session.id=$2
         and session.revoked_at is null and session.expires_at>clock_timestamp()
       where account.id=$1 and account.status='ACTIVE'`,
      [actor.accountId, actor.sessionId],
    );
    if (rows.length !== 1) throw new Error("FORBIDDEN");
    return Object.freeze({ accountId: actor.accountId, actorId: actor.accountId,
      authorityKind: "ACCOUNT_OWNER" as const, authorityReference: actor.sessionId });
  }
  if (actor.legalRole !== "PRIVACY_OFFICER") throw new Error("FORBIDDEN");
  boundedText(actor.actorId, 200, "FORBIDDEN");
  boundedText(actor.authorityId, 240, "FORBIDDEN");
  const rows = await database.query<{ id: string } & Record<string, unknown>>(
    `/* privacy-legal-authority */
     select id from privacy_legal_authorities
     where id=$1 and account_id=$2 and actor_id=$3 and legal_role='PRIVACY_OFFICER'
       and capability=$4 and active and (expires_at is null or expires_at>clock_timestamp())
       and not exists (select 1 from privacy_legal_authority_revocations revocation
         where revocation.authority_id=privacy_legal_authorities.id)`,
    [actor.authorityId, actor.accountId, actor.actorId, capability],
  );
  if (rows.length !== 1) throw new Error("FORBIDDEN");
  return Object.freeze({ accountId: actor.accountId, actorId: actor.actorId,
    authorityKind: "LEGAL" as const, authorityReference: actor.authorityId });
}

export async function authorizePrivacyTopology(
  database: EventDatabase,
  actor: PrivacyActor,
  capability: PrivacyCapability,
  conversationId: string,
  lock: "NONE" | "SHARE" | "UPDATE" = "NONE",
): Promise<AuthorizedTopology> {
  uuid(conversationId);
  const authority = await authorizeAccount(database, actor, capability);
  // Every privacy writer locks the conversation first.  Foreign-key checks may
  // subsequently lock account rows while appending events, so locking joined
  // account/entitlement rows here would invert the export lock order.
  const lockSql = lock === "SHARE" ? "for share of conversation"
    : lock === "UPDATE" ? "for update of conversation" : "";
  const rows = await database.query<{
    account_id: string; node_brain_id: string; conversation_id: string;
    status: "OPEN" | "ARCHIVED";
  } & Record<string, unknown>>(
    `/* privacy-conversation-topology */
     select account.id::text account_id,node.id::text node_brain_id,
            conversation.id::text conversation_id,conversation.status
     from accounts account
     join entitlements entitlement on entitlement.account_id=account.id
       and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
       and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
     join node_brains node on node.account_id=account.id and node.status='ACTIVE'
     join conversations conversation on conversation.account_id=account.id
       and conversation.node_brain_id=node.id
     where account.id=$1 and account.status='ACTIVE' and conversation.id=$2
     ${lockSql}`,
    [authority.accountId, conversationId],
  );
  if (rows.length !== 1) throw new Error("FORBIDDEN");
  return Object.freeze({ accountId: rows[0]!.account_id,
    nodeBrainId: rows[0]!.node_brain_id, conversationId: rows[0]!.conversation_id,
    status: rows[0]!.status, actorId: authority.actorId,
    authorityKind: authority.authorityKind, authorityReference: authority.authorityReference });
}

async function assertNotForgotten(database: EventDatabase, conversationId: string): Promise<void> {
  const rows = await database.query(
    "select 1 from privacy_forget_barriers where conversation_id=$1",
    [conversationId],
  );
  if (rows.length > 0) throw new Error("CONTENT_FORGOTTEN");
}

function memoryText(body: JsonValue, memoryId: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.memories)) {
    throw new Error("INVALID_MEMORY_BODY");
  }
  const memory = body.memories.find((candidate) => (
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    && candidate.id === memoryId
  ));
  if (!memory || typeof memory !== "object" || Array.isArray(memory)
      || typeof memory.text !== "string") throw new Error("INVALID_MEMORY_BODY");
  return memory.text;
}

function inspectionCursor(accountId: string, conversationId: string, afterId: string): string {
  return encodeOpaqueCursor({ kind: "memory-inspection", version: 1,
    accountId, conversationId, afterId });
}

function parseInspectionCursor(
  cursor: string | undefined,
  accountId: string,
  conversationId: string,
): string | null {
  if (cursor === undefined) return null;
  const decoded = decodeOpaqueCursor(cursor);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("INVALID_CURSOR");
  }
  const value = decoded as Record<string, unknown>;
  if (value.kind !== "memory-inspection" || value.version !== 1
      || value.accountId !== accountId || value.conversationId !== conversationId
      || typeof value.afterId !== "string" || !UUID_PATTERN.test(value.afterId)) {
    throw new Error("INVALID_CURSOR_SCOPE");
  }
  return value.afterId;
}

export interface InspectedMemory {
  readonly id: string;
  readonly type: MemoryType;
  readonly scope: string;
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly createdAt: string;
  readonly supersedesMemoryId: string | null;
  readonly correctionState: string;
}

export async function listAccountMemories(
  context: MemoryControlContext,
  input: {
    readonly actor: PrivacyActor;
    readonly conversationId: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): Promise<{ readonly items: readonly InspectedMemory[]; readonly nextCursor: string | null }> {
  const limit = pageSize(input.limit);
  return context.db.transaction(async (db) => {
    const topology = await authorizePrivacyTopology(
      db, input.actor, "INSPECT_MEMORY", input.conversationId, "SHARE",
    );
    await assertNotForgotten(db, topology.conversationId);
    const afterId = parseInspectionCursor(input.cursor, topology.accountId, topology.conversationId);
    const rows = await db.query<MemoryRow>(
      `select memory.id::text,memory.body_event_id::text,memory.type,memory.scope,
              memory.created_at,memory.supersedes_memory_id::text,memory.correction_state,
              array_agg(source.source_event_id::text order by source.ordinal) source_event_ids
       from memory_records memory
       join memory_sources source on source.memory_id=memory.id
       join encrypted_event_bodies memory_body on memory_body.event_id=memory.body_event_id
         and memory_body.data_key_id is not null
       where memory.account_id=$1 and memory.node_brain_id=$2 and memory.conversation_id=$3
         and memory.id>coalesce($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
         and not exists (
           select 1 from memory_sources unavailable
           left join encrypted_event_bodies source_body on source_body.event_id=unavailable.source_event_id
           where unavailable.memory_id=memory.id and source_body.data_key_id is null
         )
       group by memory.id order by memory.id limit $5`,
      [topology.accountId, topology.nodeBrainId, topology.conversationId, afterId, limit + 1],
    );
    const selected = rows.slice(0, limit);
    const bodies = selected.length === 0 ? [] : await readEventBodies(
      db, [...new Set(selected.map(({ body_event_id }) => body_event_id))],
      { actor: { role: "ACCOUNT", accountId: topology.accountId } },
    );
    const byId = new Map(bodies.map(({ eventId, body }) => [eventId, body]));
    const items = selected.map((row) => Object.freeze({
      id: row.id, type: row.type, scope: row.scope,
      text: memoryText(byId.get(row.body_event_id)!, row.id),
      sourceEventIds: Object.freeze([...row.source_event_ids]),
      createdAt: new Date(row.created_at).toISOString(),
      supersedesMemoryId: row.supersedes_memory_id,
      correctionState: row.correction_state,
    }));
    return Object.freeze({ items: Object.freeze(items), nextCursor: rows.length > limit
      ? inspectionCursor(topology.accountId, topology.conversationId, selected.at(-1)!.id) : null });
  });
}

const MAX_INSPECTION_BODY_BYTES = 131_072;
const SOURCE_PROJECTION_KEYS = Object.freeze([
  "text", "role", "title", "summary", "thesis", "proposalId", "status", "action", "kind",
  "sourceEventIds", "memoryIds", "throughEventId", "participants", "at", "completion",
] as const);

function boundedSourceValue(value: JsonValue, depth = 0): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > 100_000) throw new Error("MEMORY_SOURCE_PROJECTION_TOO_LARGE");
    return value;
  }
  if (depth >= 3) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => boundedSourceValue(item, depth + 1));
  }
  const projected: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of ["id", "kind", "role", "type", "text", "confidence", "version", "label"] as const) {
    if (value[key] !== undefined) projected[key] = boundedSourceValue(value[key]!, depth + 1);
  }
  return projected;
}

function sourceProjection(type: string, body: JsonValue): {
  readonly data: JsonValue;
  readonly sourceEventIds: readonly string[];
  readonly text?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const data = boundedSourceValue(body);
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_INSPECTION_BODY_BYTES) {
      throw new Error("MEMORY_SOURCE_PROJECTION_TOO_LARGE");
    }
    return Object.freeze({ data, sourceEventIds: Object.freeze([]),
      ...(typeof body === "string" ? { text: body } : {}) });
  }
  const projected: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  if (type === "thought.recorded") {
    for (const key of ["thoughtId", "type", "scope", "claims", "evidence", "counterevidence",
      "sourceEventIds", "stateReference", "uncertainty", "validFrom", "validUntil",
      "supersedesThoughtId"] as const) {
      if (body[key] !== undefined) projected[key] = boundedSourceValue(body[key]!);
    }
  } else {
    for (const key of SOURCE_PROJECTION_KEYS) {
      if (body[key] !== undefined) projected[key] = boundedSourceValue(body[key]!);
    }
  }
  const serialized = JSON.stringify(projected);
  if (Buffer.byteLength(serialized, "utf8") > MAX_INSPECTION_BODY_BYTES) {
    throw new Error("MEMORY_SOURCE_PROJECTION_TOO_LARGE");
  }
  const sourceEventIds = Array.isArray(body.sourceEventIds)
    ? body.sourceEventIds.filter((value): value is string => (
      typeof value === "string" && UUID_PATTERN.test(value)
    )).slice(0, 100) : [];
  return Object.freeze({ data: projected, sourceEventIds: Object.freeze(sourceEventIds),
    ...(typeof body.text === "string" ? { text: body.text } : {}) });
}

export async function inspectMemorySource(
  context: MemoryControlContext,
  input: {
    readonly actor: PrivacyActor;
    readonly conversationId: string;
    readonly memoryId: string;
    readonly sourceEventId: string;
  },
): Promise<{ readonly contentKind: "ORIGINAL_EVENT"; readonly sourceEventId: string;
  readonly occurredAt: string; readonly type: string; readonly data: JsonValue;
  readonly provenance: JsonValue; readonly text?: string }> {
  uuid(input.memoryId, "INVALID_MEMORY_ID");
  uuid(input.sourceEventId, "INVALID_MEMORY_SOURCE_ID");
  return context.db.transaction(async (db) => {
    const topology = await authorizePrivacyTopology(
      db, input.actor, "INSPECT_MEMORY", input.conversationId, "SHARE",
    );
    await assertNotForgotten(db, topology.conversationId);
    const rows = await db.query<{
      source_event_id: string; occurred_at: Date; type: string; actor_type: string;
      actor_id: string; visibility: string; prompt_version: string | null;
      model_version: string | null; policy_version: string | null;
    } & Record<string, unknown>>(
      `select source.source_event_id::text,event.occurred_at,event.type,event.actor_type,
              event.actor_id,event.visibility,event.prompt_version,event.model_version,
              event.policy_version
       from memory_records memory
       join memory_sources source on source.memory_id=memory.id
       join events event on event.id=source.source_event_id
       where memory.id=$1 and source.source_event_id=$2 and memory.account_id=$3
         and memory.node_brain_id=$4 and memory.conversation_id=$5`,
      [input.memoryId, input.sourceEventId, topology.accountId,
        topology.nodeBrainId, topology.conversationId],
    );
    if (rows.length !== 1) throw new Error("FORBIDDEN");
    const body = await readEventBody(db, input.sourceEventId, {
      actor: { role: "ACCOUNT", accountId: topology.accountId },
    });
    const projection = sourceProjection(rows[0]!.type, body);
    return Object.freeze({ contentKind: "ORIGINAL_EVENT" as const,
      sourceEventId: input.sourceEventId,
      occurredAt: new Date(rows[0]!.occurred_at).toISOString(), type: rows[0]!.type,
      data: projection.data,
      provenance: Object.freeze({ sourceEventIds: [...projection.sourceEventIds],
        actorType: rows[0]!.actor_type, actorId: rows[0]!.actor_id,
        visibility: rows[0]!.visibility, promptVersion: rows[0]!.prompt_version,
        modelVersion: rows[0]!.model_version, policyVersion: rows[0]!.policy_version }),
      ...(projection.text === undefined ? {} : { text: projection.text }) });
  });
}

type CorrectionMemory = ExtractedMemoryBase & {
  readonly procedureVersion?: string;
  readonly status?: MemoryGoalStatus;
};

function correctionSet(type: MemoryType, item: CorrectionMemory): ExtractedMemorySet {
  if (type === "SEMANTIC") return { facts: [item] };
  if (type === "EPISODIC") return { episodes: [item] };
  if (type === "PROCEDURAL") return { procedures: [item] };
  return { goals: [{ ...item, status: item.status ?? "OPEN" }] };
}

export async function correctMemory(
  context: MemoryControlContext,
  input: {
    readonly actor: PrivacyActor;
    readonly conversationId: string;
    readonly memoryId: string;
    readonly correctedText: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  },
): Promise<{ readonly memoryId: string; readonly sourceEventId: string;
  readonly supersedesMemoryId: string }> {
  uuid(input.memoryId, "INVALID_MEMORY_ID");
  const correctedText = boundedText(input.correctedText, 100_000, "INVALID_CORRECTION_TEXT");
  const reason = boundedText(input.reason, 1_000, "INVALID_CORRECTION_REASON");
  const idempotencyKey = boundedText(input.idempotencyKey, 200, "INVALID_IDEMPOTENCY_KEY");
  return context.db.transaction(async (db) => {
    const topology = await authorizePrivacyTopology(
      db, input.actor, "CORRECT_MEMORY", input.conversationId, "UPDATE",
    );
    await assertNotForgotten(db, topology.conversationId);
    const rows = await db.query<{
      id: string; type: MemoryType; procedure_version: string | null;
      goal_status: MemoryGoalStatus | null;
    } & Record<string, unknown>>(
      `select id::text,type,procedure_version,goal_status from memory_records
       where id=$1 and account_id=$2 and node_brain_id=$3 and conversation_id=$4`,
      [input.memoryId, topology.accountId, topology.nodeBrainId, topology.conversationId],
    );
    if (rows.length !== 1) throw new Error("FORBIDDEN");
    const prior = rows[0]!;
    const commandKey = scopedCommandKey(
      "CORRECT", topology.accountId, topology.conversationId, idempotencyKey,
    );
    const correction = await appendEvent(db, {
      aggregateId: topology.conversationId, accountId: topology.accountId,
      actor: { type: "USER", id: topology.accountId }, type: "memory.correction.appended",
      visibility: "PRIVATE_ACCOUNT", idempotencyKey: commandKey,
      body: { text: correctedText, reason, supersedesMemoryId: prior.id },
    });
    const extracted: CorrectionMemory = {
      text: correctedText, sourceIds: [correction.id], supersedesMemoryId: prior.id,
      correctionState: "USER_CORRECTED",
      ...(prior.type === "PROCEDURAL"
        ? { procedureVersion: prior.procedure_version ?? "account-correction-v1" } : {}),
      ...(prior.type === "GOAL" ? { status: prior.goal_status ?? "OPEN" } : {}),
    };
    const projected = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: topology.accountId,
      nodeBrainId: topology.nodeBrainId, conversationId: topology.conversationId,
      sourceEventId: correction.id,
      events: [{ id: correction.id, at: correction.occurredAt.toISOString(), text: correctedText }],
      extracted: correctionSet(prior.type, extracted),
      versions: { promptVersion: "owner-correction-v1", modelVersion: "none",
        extractorVersion: "owner-correction-v1", embeddingVersion: "memory-embedding-v1" },
      observedAt: correction.occurredAt.toISOString(),
      idempotencyKey: commandKey,
    });
    return Object.freeze({ memoryId: projected.memories[0]!.id,
      sourceEventId: correction.id, supersedesMemoryId: prior.id });
  });
}

export async function archiveConversation(
  context: MemoryControlContext,
  input: { readonly actor: PrivacyActor; readonly conversationId: string;
    readonly archived: boolean; readonly idempotencyKey: string },
): Promise<{ readonly conversationId: string; readonly eventId: string;
  readonly commandStatus: "OPEN" | "ARCHIVED"; readonly currentStatus: "OPEN" | "ARCHIVED";
  /** Backward-compatible alias for currentStatus. */ readonly status: "OPEN" | "ARCHIVED" }> {
  if (typeof input.archived !== "boolean") throw new Error("INVALID_ARCHIVE_STATE");
  const idempotencyKey = boundedText(input.idempotencyKey, 200, "INVALID_IDEMPOTENCY_KEY");
  return context.db.transaction(async (db) => {
    const topology = await authorizePrivacyTopology(
      db, input.actor, "ARCHIVE_CONVERSATION", input.conversationId, "UPDATE",
    );
    await assertNotForgotten(db, topology.conversationId);
    const type = input.archived ? "conversation.archived" : "conversation.restored";
    const status = input.archived ? "ARCHIVED" as const : "OPEN" as const;
    const commandKey = scopedCommandKey(
      input.archived ? "ARCHIVE" : "RESTORE",
      topology.accountId,
      topology.conversationId,
      idempotencyKey,
    );
    const requestDigest = canonicalContentDigest({ accountId: topology.accountId,
      conversationId: topology.conversationId, archived: input.archived });
    const priorCommand = await db.query<{
      request_digest: string; event_id: string; archived: boolean;
    } & Record<string, unknown>>(
      `select request_digest,event_id::text,archived
       from conversation_archive_commands where idempotency_key=$1`,
      [commandKey],
    );
    if (priorCommand.length > 0) {
      if (priorCommand[0]!.request_digest !== requestDigest) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      const commandStatus = priorCommand[0]!.archived ? "ARCHIVED" as const : "OPEN" as const;
      return Object.freeze({ conversationId: topology.conversationId,
        eventId: priorCommand[0]!.event_id, commandStatus, currentStatus: topology.status,
        status: topology.status });
    }
    const event = await appendEvent(db, {
      aggregateId: topology.conversationId, accountId: topology.accountId,
      actor: { type: "USER", id: topology.accountId }, type,
      visibility: "PRIVATE_ACCOUNT", body: { archived: input.archived },
      idempotencyKey: commandKey,
    });
    await db.query(
      `insert into conversation_archive_commands
         (id,event_id,account_id,conversation_id,archived,authority_kind,actor_id,
          authority_reference,capability,idempotency_key,request_digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'ARCHIVE_CONVERSATION',$9,$10)
       on conflict (idempotency_key) do nothing`,
      [randomUUID(), event.id, topology.accountId, topology.conversationId,
        input.archived, topology.authorityKind, topology.actorId, topology.authorityReference,
        commandKey, requestDigest],
    );
    const command = await db.one<{
      request_digest: string; event_id: string; archived: boolean;
    } & Record<string, unknown>>(
      `select request_digest,event_id::text,archived
       from conversation_archive_commands where idempotency_key=$1`,
      [commandKey],
    );
    if (command.request_digest !== requestDigest) throw new Error("IDEMPOTENCY_KEY_REUSED");
    if (topology.status !== status) {
      await db.query("update conversations set status=$2 where id=$1", [topology.conversationId, status]);
    }
    await db.query(
      `insert into audit_events
         (id,event_id,aggregate_id,account_id,type,actor_kind,actor_id,metadata)
       values ($1,$2,$3,($4::text)::uuid,$5,'ACCOUNT_OWNER',$4::text,$6)
       on conflict (event_id) do nothing`,
      [randomUUID(), event.id, topology.conversationId, topology.accountId, type,
        JSON.stringify({ archived: input.archived })],
    );
    return Object.freeze({ conversationId: topology.conversationId, eventId: command.event_id,
      commandStatus: command.archived ? "ARCHIVED" : "OPEN", currentStatus: status,
      status });
  });
}

interface ExportCursor {
  readonly kind: "account-data-export";
  readonly version: 1;
  readonly accountId: string;
  readonly snapshotId: string;
  readonly afterOrdinal: number;
}

function parseExportCursor(cursor: string, accountId: string): ExportCursor {
  const decoded = decodeOpaqueCursor(cursor);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("INVALID_CURSOR");
  }
  const value = decoded as unknown as ExportCursor;
  if (value.kind !== "account-data-export" || value.version !== 1
      || value.accountId !== accountId || !UUID_PATTERN.test(value.snapshotId)
      || !Number.isSafeInteger(value.afterOrdinal)
      || value.afterOrdinal < 0 || value.afterOrdinal > 100_000) {
    throw new Error("INVALID_CURSOR_SCOPE");
  }
  return value;
}

function exportCursor(value: ExportCursor): string {
  return encodeOpaqueCursor({ ...value });
}

function sanitizeExportBody(type: string, body: JsonValue): JsonValue {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (type === "memory.consolidation.completed") {
    const memories = Array.isArray(body.memories) ? body.memories.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
      return { id: candidate.id ?? null, type: candidate.type ?? null, scope: candidate.scope ?? null,
        text: candidate.text ?? null, sourceEventIds: candidate.sourceIds ?? [],
        createdAt: candidate.validFrom ?? null, supersedesMemoryId: candidate.supersedesMemoryId ?? null };
    }).filter((value) => value !== null) : [];
    return { memories } as JsonValue;
  }
  if (type === "thought.recorded") {
    return {
      thoughtId: body.thoughtId ?? null,
      type: body.type ?? null,
      scope: body.scope ?? null,
      rationale: body.rationale ?? null,
      claims: body.claims ?? [],
      evidence: body.evidence ?? [],
      counterevidence: body.counterevidence ?? [],
      sourceEventIds: body.sourceEventIds ?? [],
      stateReference: body.stateReference ?? null,
      uncertainty: body.uncertainty ?? null,
      validFrom: body.validFrom ?? null,
      validUntil: body.validUntil ?? null,
      supersedesThoughtId: body.supersedesThoughtId ?? null,
    } as JsonValue;
  }
  const safe: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of ["text", "role", "completion", "reason", "supersedesMemoryId",
    "externalConversationId", "externalMessageId", "participants", "at", "action",
    "kind", "status", "archived", "conversationId", "requestId", "projectionType",
    "sourceEventIds", "memoryIds", "throughEventId", "snapshotId", "accountRecordCount",
    "format"]) {
    const value = body[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

export interface AccountExportRecord {
  readonly ordinal: number;
  readonly type: string;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly accountId: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly visibility: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly promptVersion: string | null;
  readonly modelVersion: string | null;
  readonly policyVersion: string | null;
  readonly contentKind: "ORIGINAL_EVENT" | "DERIVED_MEMORY" | "TOMBSTONE";
  readonly data: JsonValue;
  readonly provenance: JsonValue;
}

function exportProvenance(data: JsonValue): JsonValue {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const body = data as Record<string, JsonValue>;
  const provenance: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of ["sourceEventIds", "memoryIds", "throughEventId", "supersedesMemoryId",
    "externalConversationId", "externalMessageId", "requestId"]) {
    if (body[key] !== undefined) provenance[key] = body[key]!;
  }
  return provenance;
}

const MAX_EXPORT_SNAPSHOT_RECORDS = 100_000;
const MAX_EXPORT_CONVERSATIONS = 10_000;
const MAX_ACTIVE_EXPORT_SNAPSHOTS = 4;
const DEFAULT_EXPORT_SNAPSHOT_LIFETIME_SECONDS = 900;

function eligibleExportEventsSql(accountParameter: string, excludedEventParameter?: string): string {
  const exclusion = excludedEventParameter === undefined
    ? "" : `and event.id<>${excludedEventParameter}::uuid`;
  return `
    select event.id event_id,event.ingested_sequence source_sequence,false tombstone
    from events event join transactional_outbox outbox on outbox.event_id=event.id
    where event.account_id=${accountParameter}::text ${exclusion}
      and event.visibility='PRIVATE_ACCOUNT'
      and event.type not in ('content.forgotten','account.export.started')
      and event.type !~* '(^|\\.)(order|trade|fill|position|execution)(\\.|$)'
      and not exists (select 1 from privacy_forget_barriers barrier
        where barrier.conversation_id::text=event.aggregate_id)
      and not exists (select 1 from privacy_erased_aggregate_keys erased
        where erased.aggregate_id=event.aggregate_id)
      and not exists (select 1 from thought_records thought
        join privacy_projection_deactivations deactivation
          on deactivation.projection_type='CATALOG_001'
         and deactivation.record_id=thought.id::text where thought.event_id=event.id)
      and not exists (select 1 from memory_records memory
        join privacy_projection_deactivations deactivation
          on deactivation.projection_type='MEMORY_RECORD'
         and deactivation.record_id=memory.id::text where memory.body_event_id=event.id)
      and not exists (select 1 from recall_traces trace
        join privacy_projection_deactivations deactivation
          on deactivation.projection_type='RECALL_TRACE'
         and deactivation.record_id=trace.id::text where trace.event_id=event.id)
    union all
    select event.id,event.ingested_sequence,true
    from audit_events audit join events event on event.id=audit.event_id
    where audit.account_id=(${accountParameter}::text)::uuid
      and audit.type='content.forgotten' ${exclusion}`;
}

export async function exportAccountData(
  context: MemoryControlContext,
  input: { readonly actor: PrivacyActor; readonly limit?: number; readonly cursor?: string },
): Promise<{ readonly manifest: { readonly format: "gustavo-account-data-export-v1";
    readonly accountId: string; readonly snapshotId: string; readonly accountRecordCount: number };
  readonly records: readonly AccountExportRecord[]; readonly nextCursor: string | null }> {
  const limit = pageSize(input.limit);
  return context.db.transaction(async (db) => {
    await db.query("set transaction isolation level repeatable read");
    const authority = await authorizeAccount(db, input.actor, "EXPORT_DATA");
    const conversations = await db.query<{
      id: string; node_brain_id: string; forgotten: boolean;
    } & Record<string, unknown>>(
      `/* privacy-export-conversation-lock */
       select conversation.id::text,conversation.node_brain_id::text,
              (barrier.conversation_id is not null) forgotten
       from conversations conversation
       left join privacy_forget_barriers barrier on barrier.conversation_id=conversation.id
       where conversation.account_id=$1 order by conversation.id
       limit ${MAX_EXPORT_CONVERSATIONS + 1} for share of conversation`,
      [authority.accountId],
    );
    if (conversations.length > MAX_EXPORT_CONVERSATIONS) {
      throw new Error("ACCOUNT_EXPORT_CONVERSATION_BOUND_EXCEEDED");
    }
    const availableConversationIds = conversations.filter(({ forgotten }) => !forgotten)
      .map(({ id }) => id);
    if (availableConversationIds.length > 0) {
      await db.query(
        `/* privacy-export-key-lock */
         select id::text from aggregate_data_keys
         where aggregate_id=any($1::text[]) order by id for key share`,
        [availableConversationIds],
      );
    } else {
      await db.query("/* privacy-export-key-lock */ select null where false");
    }

    let cursor: ExportCursor;
    let accountRecordCount: number;
    if (input.cursor === undefined) {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `account-export-snapshot:${authority.accountId}`,
      ]);
      const lifetimeSeconds = context.exportSnapshotLifetimeSeconds
        ?? DEFAULT_EXPORT_SNAPSHOT_LIFETIME_SECONDS;
      if (!Number.isSafeInteger(lifetimeSeconds)
          || lifetimeSeconds < 1 || lifetimeSeconds > 3_600) {
        throw new Error("ACCOUNT_EXPORT_SNAPSHOT_LIFETIME_INVALID");
      }
      for (let pass = 0; pass < MAX_ACTIVE_EXPORT_SNAPSHOTS; pass += 1) {
        await db.query("select prune_account_export_snapshot_memberships($1,$2)", [
          authority.accountId, MAX_EXPORT_SNAPSHOT_RECORDS,
        ]);
      }
      const membership = await db.one<{
        count: number; source_high_water: string; membership_digest: string;
      } & Record<string, unknown>>(
        `with bounded as (
           select eligible.* from (${eligibleExportEventsSql("$1")}) eligible
           order by eligible.source_sequence,eligible.event_id
           limit ${MAX_EXPORT_SNAPSHOT_RECORDS + 1}
         )
         select count(*)::int count,
                recall_manifest_digest(coalesce((
                  select jsonb_build_object('eventId',latest.event_id::text,
                    'sourceSequence',latest.source_sequence::text)
                  from bounded latest order by latest.source_sequence desc,latest.event_id desc
                  limit 1
                ),'{}'::jsonb)) source_high_water,
                recall_manifest_digest(coalesce(jsonb_agg(jsonb_build_object(
                  'eventId',bounded.event_id::text,
                  'sourceSequence',bounded.source_sequence::text,
                  'tombstone',bounded.tombstone
                ) order by bounded.source_sequence,bounded.event_id),'[]'::jsonb))
                  membership_digest
         from bounded`,
        [authority.accountId],
      );
      if (membership.count > MAX_EXPORT_SNAPSHOT_RECORDS) {
        throw new Error("ACCOUNT_EXPORT_SNAPSHOT_BOUND_EXCEEDED");
      }
      accountRecordCount = membership.count;
      const reusable = await db.query<{
        id: string; record_count: number;
      } & Record<string, unknown>>(
        `select snapshot.id::text,snapshot.record_count
         from account_export_snapshots snapshot
         where snapshot.account_id=$1 and snapshot.expires_at>clock_timestamp()
           and snapshot.source_high_water=$2 and snapshot.membership_digest=$3
           and snapshot.record_count=$4
           and not exists (select 1 from account_export_snapshot_retirements retirement
             where retirement.snapshot_id=snapshot.id)
         order by snapshot.created_at desc,snapshot.id desc limit 1`,
        [authority.accountId, membership.source_high_water,
          membership.membership_digest, membership.count],
      );
      if (reusable[0]) {
        cursor = { kind: "account-data-export", version: 1, accountId: authority.accountId,
          snapshotId: reusable[0].id, afterOrdinal: 0 };
      } else {
        const active = await db.one<{ count: number } & Record<string, unknown>>(
          `select count(*)::int count from account_export_snapshots snapshot
           where snapshot.account_id=$1 and snapshot.expires_at>clock_timestamp()
             and not exists (select 1 from account_export_snapshot_retirements retirement
               where retirement.snapshot_id=snapshot.id)`,
          [authority.accountId],
        );
        if (active.count >= MAX_ACTIVE_EXPORT_SNAPSHOTS) {
          throw new Error("ACCOUNT_EXPORT_ACTIVE_SNAPSHOT_BOUND_EXCEEDED");
        }
      const snapshotId = randomUUID();
      const snapshotClock = await db.one<{ expires_at: Date } & Record<string, unknown>>(
        `select transaction_timestamp()+($1::int*interval '1 second') expires_at`,
        [lifetimeSeconds],
      );
      const expiresAt = new Date(snapshotClock.expires_at).toISOString();
      const event = await appendEvent(db, {
        aggregateId: `account-export:${snapshotId}`, accountId: authority.accountId,
        actor: authority.authorityKind === "ACCOUNT_OWNER"
          ? { type: "USER", id: authority.actorId }
          : { type: "OPERATOR", id: authority.actorId },
        type: "account.export.started", visibility: "PRIVATE_ACCOUNT",
        body: { snapshotId, accountRecordCount,
          sourceHighWater: membership.source_high_water,
          membershipDigest: membership.membership_digest, expiresAt,
          format: "gustavo-account-data-export-v1" },
        idempotencyKey: `account-export:${snapshotId}`,
      });
      await db.query(
        `insert into account_export_snapshots
           (id,event_id,account_id,authority_kind,actor_id,authority_reference,capability,
            record_count,source_high_water,membership_digest,expires_at)
         values ($1,$2,$3,$4,$5,$6,'EXPORT_DATA',$7,$8,$9,$10)`,
        [snapshotId, event.id, authority.accountId, authority.authorityKind,
          authority.actorId, authority.authorityReference, accountRecordCount,
          membership.source_high_water, membership.membership_digest, snapshotClock.expires_at],
      );
      await db.query(
        `insert into account_export_snapshot_records
           (snapshot_id,ordinal,event_id,source_sequence,tombstone)
         select $1,row_number() over (order by eligible.source_sequence,eligible.event_id)::int,
                eligible.event_id,eligible.source_sequence,eligible.tombstone
         from (${eligibleExportEventsSql("$2", "$3")}) eligible
         order by eligible.source_sequence,eligible.event_id`,
        [snapshotId, authority.accountId, event.id],
      );
      const storedMembership = await db.one<{ count: number } & Record<string, unknown>>(
        "select count(*)::int count from account_export_snapshot_records where snapshot_id=$1",
        [snapshotId],
      );
      if (storedMembership.count !== accountRecordCount) {
        throw new Error("ACCOUNT_EXPORT_SNAPSHOT_MEMBERSHIP_CHANGED");
      }
      await db.query(
        `insert into audit_events
           (id,event_id,aggregate_id,account_id,type,actor_kind,actor_id,metadata)
         values ($1,$2,$3,$4,'account.export.started',$5,$6,$7)`,
        [randomUUID(), event.id, snapshotId, authority.accountId, authority.authorityKind,
          authority.actorId, JSON.stringify({ snapshotId, accountRecordCount,
            sourceHighWater: membership.source_high_water,
            membershipDigest: membership.membership_digest, expiresAt,
            format: "gustavo-account-data-export-v1" })],
      );
      await db.query(
        `insert into account_export_snapshot_retirements
           (snapshot_id,account_id,reason)
         select prior.id,prior.account_id,'CONTENT_CHANGED'
         from account_export_snapshots prior
         where prior.account_id=$1 and prior.id<>$2
           and prior.expires_at>clock_timestamp()
           and prior.membership_digest<>$3
           and not exists (select 1 from account_export_snapshot_retirements retirement
             where retirement.snapshot_id=prior.id)
         on conflict (snapshot_id) do nothing`,
        [authority.accountId, snapshotId, membership.membership_digest],
      );
      for (let pass = 0; pass < MAX_ACTIVE_EXPORT_SNAPSHOTS; pass += 1) {
        await db.query("select prune_account_export_snapshot_memberships($1,$2)", [
          authority.accountId, MAX_EXPORT_SNAPSHOT_RECORDS,
        ]);
      }
      cursor = { kind: "account-data-export", version: 1, accountId: authority.accountId,
        snapshotId, afterOrdinal: 0 };
      }
    } else {
      cursor = parseExportCursor(input.cursor, authority.accountId);
      const snapshot = await db.query<{
        record_count: number; expired: boolean;
      } & Record<string, unknown>>(
        `select snapshot.record_count,
                snapshot.expires_at<=clock_timestamp() or exists (
                  select 1 from account_export_snapshot_retirements retirement
                  where retirement.snapshot_id=snapshot.id
                ) expired
         from account_export_snapshots snapshot where snapshot.id=$1 and snapshot.account_id=$2`,
        [cursor.snapshotId, authority.accountId],
      );
      if (snapshot.length !== 1) throw new Error("INVALID_CURSOR_SCOPE");
      if (snapshot[0]!.expired) throw new Error("EXPORT_SNAPSHOT_EXPIRED");
      accountRecordCount = snapshot[0]!.record_count;
    }

    const rows = await db.query<{
      event_id: string; ordinal: number; type: string; occurred_at: Date; tombstone: boolean;
      created_at: Date; aggregate_id: string; account_id: string; actor_type: string;
      actor_id: string; visibility: string; causation_id: string | null; correlation_id: string;
      prompt_version: string | null; model_version: string | null; policy_version: string | null;
      metadata: JsonValue | null;
    } & Record<string, unknown>>(
      `select record.ordinal,event.id::text event_id,event.type,event.occurred_at,
              case when record.tombstone then audit.created_at else outbox.created_at end created_at,
              event.aggregate_id,event.account_id,event.actor_type,event.actor_id,event.visibility,
              event.causation_id::text,event.correlation_id::text,event.prompt_version,
              event.model_version,event.policy_version,record.tombstone,audit.metadata
       from account_export_snapshot_records record
       join events event on event.id=record.event_id
       join transactional_outbox outbox on outbox.event_id=event.id
       left join audit_events audit on audit.event_id=event.id and record.tombstone
       where record.snapshot_id=$1 and record.ordinal>$2
         and (record.tombstone or (
           exists (select 1 from encrypted_event_bodies body
             where body.event_id=event.id and body.data_key_id is not null)
           and not exists (select 1 from privacy_forget_barriers barrier
             where barrier.conversation_id::text=event.aggregate_id)
           and not exists (select 1 from privacy_erased_aggregate_keys erased
             where erased.aggregate_id=event.aggregate_id)
           and not exists (select 1 from thought_records thought
             join privacy_projection_deactivations deactivation
               on deactivation.projection_type='CATALOG_001'
              and deactivation.record_id=thought.id::text where thought.event_id=event.id)
           and not exists (select 1 from memory_records memory
             join privacy_projection_deactivations deactivation
               on deactivation.projection_type='MEMORY_RECORD'
              and deactivation.record_id=memory.id::text where memory.body_event_id=event.id)
           and not exists (select 1 from recall_traces trace
             join privacy_projection_deactivations deactivation
               on deactivation.projection_type='RECALL_TRACE'
              and deactivation.record_id=trace.id::text where trace.event_id=event.id)
         )) order by record.ordinal limit $3`,
      [cursor.snapshotId, cursor.afterOrdinal, limit + 1],
    );
    const selected = rows.slice(0, limit);
    const bodyRows = selected.filter(({ tombstone }) => !tombstone);
    const bodies = bodyRows.length === 0 ? [] : await readEventBodies(
      db, bodyRows.map(({ event_id }) => event_id),
      { actor: { role: "ACCOUNT", accountId: authority.accountId } },
    );
    const bodyByEvent = new Map(bodies.map(({ eventId, body }) => [eventId, body]));
    const records = selected.map((row): AccountExportRecord => {
      const data = row.tombstone ? row.metadata ?? {} : sanitizeExportBody(
        row.type, bodyByEvent.get(row.event_id)!,
      );
      return Object.freeze({
      ordinal: row.ordinal, type: row.type, eventId: row.event_id,
      aggregateId: row.aggregate_id, accountId: row.account_id,
      actorType: row.actor_type, actorId: row.actor_id, visibility: row.visibility,
      occurredAt: new Date(row.occurred_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(), causationId: row.causation_id,
      correlationId: row.correlation_id, promptVersion: row.prompt_version,
      modelVersion: row.model_version, policyVersion: row.policy_version,
      contentKind: row.tombstone ? "TOMBSTONE"
        : row.type === "memory.consolidation.completed" ? "DERIVED_MEMORY" : "ORIGINAL_EVENT",
      data, provenance: exportProvenance(data),
    });
    });
    const nextCursor = rows.length > limit ? exportCursor({ ...cursor,
      afterOrdinal: selected.at(-1)!.ordinal }) : null;
    return Object.freeze({ manifest: Object.freeze({
      format: "gustavo-account-data-export-v1" as const, accountId: authority.accountId,
      snapshotId: cursor.snapshotId, accountRecordCount,
    }), records: Object.freeze(records), nextCursor });
  });
}
