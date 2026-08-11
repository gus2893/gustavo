import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createAndWrapDataKey,
  unwrapDataKey,
  type WrappedDataKey,
} from "../../lib/server/crypto/envelope";
import {
  captureMemoryInput,
  consolidateEvents,
} from "../../lib/server/consolidation/consolidate";
import {
  appendEvent,
  lockAvailableMemorySourceBodies,
  readEventBodies,
  readEventBody,
} from "../../lib/server/events/store";
import { canonicalContentDigest, canonicalJson } from "../../lib/server/events/integrity";
import type { EventVisibility, JsonValue } from "../../lib/server/events/types";
import type {
  ConsolidatedMemory,
  MemoryVectorRankingInput,
  MemorySearchTermInput,
  RankedMemoryEmbedding,
  MemoryScope,
  ProcessedMemoryEvent,
  ProcessMemoryEventContext,
  ProcessMemoryEventInput,
} from "../../lib/server/memory/types";
import { memoryVectorBucketDigests } from "../../lib/server/memory/vector-index";

interface SourceEventRow extends Record<string, unknown> {
  id: string;
  aggregate_id: string;
  account_id: string | null;
  type: string;
  visibility: EventVisibility;
  actor_type: string;
  actor_id: string;
  occurred_at: Date;
  ingested_sequence: string;
  correlation_id: string;
}

interface ExistingRunRow extends Record<string, unknown> {
  id: string;
  consolidation_event_id: string;
  request_digest: string;
  operation_key: string;
}

interface CheckpointRow extends Record<string, unknown> {
  source_event_id: string;
  source_occurred_at: Date;
  source_ingested_sequence: string;
}

interface AggregateKeyRow extends Record<string, unknown> {
  id: string;
  root_key_version: number;
  wrapped_key: Buffer;
  wrap_iv: Buffer;
  wrap_auth_tag: Buffer;
}

type SupersessionAuthorityKind = "USER" | "OPERATOR" | "MAIN" | "CHALLENGE";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function required(value: string, code: string, maximum = 240): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(code);
  }
  return value;
}

function requiredUuid(value: string | undefined, code: string): string {
  const captured = required(value ?? "", code);
  if (!UUID_PATTERN.test(captured)) throw new Error(code);
  return captured;
}

function eventVisibility(scope: MemoryScope): EventVisibility {
  if (scope === "PRIVATE_ACCOUNT" || scope === "NODE_BRANCH") return "PRIVATE_ACCOUNT";
  if (scope === "MAIN_SHARED" || scope === "CHALLENGE_SHARED") return "SHARED";
  if (scope === "PUBLIC") return "PUBLIC";
  return "OPERATOR";
}

function targetKind(scope: MemoryScope): "NODE" | "MAIN" | "CHALLENGE" | "PUBLIC" | "AUDIT" {
  if (scope === "PRIVATE_ACCOUNT" || scope === "NODE_BRANCH") return "NODE";
  if (scope === "MAIN_SHARED") return "MAIN";
  if (scope === "CHALLENGE_SHARED") return "CHALLENGE";
  if (scope === "PUBLIC") return "PUBLIC";
  return "AUDIT";
}

function projectionKey(input: ProcessMemoryEventInput, source: SourceEventRow): string {
  if (input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH") {
    return `${input.scope.toLowerCase()}:conversation:${input.conversationId!}`;
  }
  return `${input.scope.toLowerCase()}:${source.aggregate_id}`;
}

function sourceScopeMatches(input: ProcessMemoryEventInput, source: SourceEventRow): boolean {
  if (input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH") {
    return source.visibility === "PRIVATE_ACCOUNT"
      && source.account_id === input.accountId
      && source.aggregate_id === input.conversationId
      && !(source.actor_type === "USER" && source.actor_id !== input.accountId)
      && !(source.actor_type === "NODE_BRAIN" && source.actor_id !== input.nodeBrainId);
  }
  if (input.scope === "MAIN_SHARED" || input.scope === "CHALLENGE_SHARED") {
    return source.visibility === "SHARED" && source.account_id === null;
  }
  if (input.scope === "PUBLIC") return source.visibility === "PUBLIC";
  return source.visibility === "OPERATOR";
}

function derivedMemoryEventType(type: string): boolean {
  return type === "memory.consolidation.completed" || type === "memory.edge.versioned"
    || type.startsWith("memory.graph.");
}

function bodyFor(
  memories: readonly ConsolidatedMemory[],
  digestSalt: string,
  requestDigest: string,
): JsonValue {
  return JSON.parse(JSON.stringify({
    digestSalt,
    requestDigest,
    memories,
  })) as JsonValue;
}

function keyedDigest(salt: Buffer, value: unknown): string {
  return createHmac("sha256", salt).update(canonicalContentDigest(value)).digest("hex");
}

function uuidFromSafeDigest(digest: string): string {
  const characters = digest.slice(0, 32).split("");
  characters[12] = "5";
  characters[16] = ((Number.parseInt(characters[16], 16) & 0x3) | 0x8).toString(16);
  const value = characters.join("");
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)]
    .join("-");
}

function protectedScope(scope: MemoryScope): boolean {
  return scope !== "PUBLIC";
}

function persistableMemories(
  memories: readonly ConsolidatedMemory[],
  salt: Buffer,
  indexKey: Buffer | null,
): readonly ConsolidatedMemory[] {
  return Object.freeze(memories.map((memory) => {
    if (!protectedScope(memory.scope)) return memory;
    if (indexKey === null) throw new Error("EVENT_KEY_UNAVAILABLE");
    const contentDigest = keyedDigest(salt, { kind: "content", text: memory.text });
    const identityDigest = keyedDigest(salt, {
      kind: "identity", originalId: memory.id, contentDigest, sourceIds: memory.sourceIds,
    });
    return Object.freeze({
      ...memory,
      id: uuidFromSafeDigest(identityDigest),
      contentDigest,
      equivalenceDigest: keyedDigest(indexKey, {
        domain: "gustavo:memory-equivalence:v1", digest: memory.equivalenceDigest,
      }),
      keywordIndexDigests: Object.freeze(memory.keywords.map((term) => keyedDigest(indexKey, {
        domain: "gustavo:memory-search:v1", kind: "KEYWORD", scope: memory.scope, term,
      }))),
      entityIndexDigests: Object.freeze(memory.entities.map((term) => keyedDigest(indexKey, {
        domain: "gustavo:memory-search:v1", kind: "ENTITY", scope: memory.scope, term,
      }))),
      keywordsDigest: keyedDigest(salt, { kind: "keywords", terms: memory.keywords }),
      entitiesDigest: keyedDigest(salt, { kind: "entities", terms: memory.entities }),
      embeddingDigest: memory.embedding === null ? null : keyedDigest(salt, {
        kind: "embedding", vector: memory.embedding, version: memory.embeddingVersion,
      }),
    });
  }));
}

interface ProtectedConsolidationBody {
  readonly digestSalt: string;
  readonly requestDigest: string;
  readonly memories?: readonly unknown[];
}

function protectedBodyHeader(value: JsonValue): ProtectedConsolidationBody {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("INVALID_MEMORY_CONSOLIDATION_BODY");
  }
  const digestSalt = value.digestSalt;
  const requestDigest = value.requestDigest;
  if (typeof digestSalt !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(digestSalt)
      || typeof requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(requestDigest)) {
    throw new Error("INVALID_MEMORY_CONSOLIDATION_BODY");
  }
  return { digestSalt, requestDigest,
    memories: Array.isArray(value.memories) ? value.memories : undefined };
}

const memoryWorkerContexts = new WeakSet<object>();

export function createMemoryWorkerContext(
  db: ProcessMemoryEventContext["db"],
): ProcessMemoryEventContext {
  const context: ProcessMemoryEventContext = Object.freeze({ db });
  memoryWorkerContexts.add(context);
  return context;
}

function retrievalKeyDomain(
  input: Pick<MemorySearchTermInput, "scope" | "conversationId">,
): string | null {
  if (input.scope === "PUBLIC") return null;
  if (input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH") {
    return required(input.conversationId ?? "", "MEMORY_CONVERSATION_REQUIRED");
  }
  if (input.scope === "MAIN_SHARED") return "memory-retrieval:main:v1";
  if (input.scope === "CHALLENGE_SHARED") return "memory-retrieval:challenge:v1";
  return "memory-retrieval:audit:v1";
}

async function loadRetrievalKey(
  db: ProcessMemoryEventContext["db"],
  input: Pick<MemorySearchTermInput, "scope" | "conversationId">,
  createIfMissing: boolean,
): Promise<{ readonly id: string; readonly dataKey: Buffer } | null> {
  const domain = retrievalKeyDomain(input);
  if (domain === null) return null;
  let row = (await db.query<AggregateKeyRow>(
    `select id::text,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
     from aggregate_data_keys where aggregate_id=$1 for key share`,
    [domain],
  ))[0];
  let createdDataKey: Buffer | null = null;
  if (!row && createIfMissing && input.scope !== "PRIVATE_ACCOUNT" && input.scope !== "NODE_BRANCH") {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-retrieval-key:${domain}`,
    ]);
    row = (await db.query<AggregateKeyRow>(
      `select id::text,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
       from aggregate_data_keys where aggregate_id=$1 for key share`,
      [domain],
    ))[0];
  }
  if (!row && createIfMissing && input.scope !== "PRIVATE_ACCOUNT" && input.scope !== "NODE_BRANCH") {
    const created = createAndWrapDataKey(domain);
    createdDataKey = created.dataKey;
    row = {
      id: randomUUID(), root_key_version: created.wrapped.rootKeyVersion,
      wrapped_key: created.wrapped.wrappedKey, wrap_iv: created.wrapped.iv,
      wrap_auth_tag: created.wrapped.authTag,
    };
    await db.query(
      `insert into aggregate_data_keys
         (id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag)
       values ($1,$2,$3,$4,$5,$6)`,
      [row.id, domain, row.root_key_version, row.wrapped_key, row.wrap_iv, row.wrap_auth_tag],
    );
  }
  if (!row) throw new Error("EVENT_KEY_UNAVAILABLE");
  const wrapped: WrappedDataKey = {
    rootKeyVersion: row.root_key_version,
    wrappedKey: row.wrapped_key,
    iv: row.wrap_iv,
    authTag: row.wrap_auth_tag,
  };
  return { id: row.id, dataKey: createdDataKey ?? unwrapDataKey(domain, wrapped) };
}

function deriveIndexHmacKey(dataKey: Buffer): Buffer {
  return createHmac("sha256", dataKey).update("gustavo:memory-search-key:v1").digest();
}

export interface MemoryVectorBackfillDomain {
  readonly scope: MemoryScope;
  readonly accountId: string | null;
  readonly nodeBrainId: string | null;
  readonly conversationId: string | null;
}

interface MemoryVectorBackfillRow extends Record<string, unknown> {
  readonly id: string;
  readonly body_event_id: string;
  readonly body_key_id: string;
  readonly scope: MemoryScope;
  readonly account_id: string | null;
  readonly node_brain_id: string | null;
  readonly conversation_id: string | null;
  readonly search_key_id: string | null;
  readonly embedding_version: string;
  readonly embedding_digest: string;
  readonly embedding_dimension: number;
  readonly search_embedding: number[] | null;
}

interface MemoryVectorBackfillCheckpointRow extends Record<string, unknown> {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly account_id: string | null;
  readonly node_brain_id: string | null;
  readonly conversation_id: string | null;
  readonly last_memory_id: string | null;
}

const MEMORY_VECTOR_BACKFILL_LIMIT = 100;

export async function backfillHistoricalMemoryVectorBuckets(
  context: ProcessMemoryEventContext,
  domains: readonly MemoryVectorBackfillDomain[],
  embeddingVersion: string,
): Promise<number> {
  if (!context || typeof context !== "object" || !memoryWorkerContexts.has(context)) {
    throw new Error("MEMORY_WORKER_CONTEXT_INVALID");
  }
  required(embeddingVersion, "MEMORY_EMBEDDING_VERSION_REQUIRED", 200);
  if (!Array.isArray(domains) || domains.length === 0 || domains.length > 6) return 0;
  const acquired = await context.db.one<{ acquired: boolean }>(
    "select pg_try_advisory_xact_lock(hashtextextended('memory-vector-backfill:v1',0)) acquired",
  );
  if (!acquired.acquired) return 0;
  const domainJson = domains.map((domain) => ({
    scope: domain.scope,
    accountId: domain.accountId,
    nodeBrainId: domain.nodeBrainId,
    conversationId: domain.conversationId,
  }));
  await context.db.query(
    `/* memory-vector-backfill-checkpoints */
     insert into memory_vector_backfill_checkpoints (
       scope,account_id,node_brain_id,conversation_id,embedding_version
     )
     select domain.value->>'scope',(domain.value->>'accountId')::uuid,
            (domain.value->>'nodeBrainId')::uuid,(domain.value->>'conversationId')::uuid,$2
     from jsonb_array_elements($1::jsonb) domain(value)
     on conflict (scope,account_id,node_brain_id,conversation_id,embedding_version)
       do nothing`,
    [JSON.stringify(domainJson), embeddingVersion],
  );
  await context.db.query(
    `/* memory-vector-backfill-complete-empty */
     update memory_vector_backfill_checkpoints checkpoint
        set completed=true,updated_at=clock_timestamp()
     from jsonb_array_elements($1::jsonb) domain(value)
     where not checkpoint.completed and checkpoint.embedding_version=$2
       and checkpoint.scope=domain.value->>'scope'
       and checkpoint.account_id is not distinct from (domain.value->>'accountId')::uuid
       and checkpoint.node_brain_id is not distinct from (domain.value->>'nodeBrainId')::uuid
       and checkpoint.conversation_id is not distinct from (domain.value->>'conversationId')::uuid
       and not exists (
         select 1 from memory_records memory
         where memory.has_embedding and memory.embedding_version=checkpoint.embedding_version
           and memory.scope=checkpoint.scope
           and memory.account_id is not distinct from checkpoint.account_id
           and memory.node_brain_id is not distinct from checkpoint.node_brain_id
           and memory.conversation_id is not distinct from checkpoint.conversation_id
           and memory.id>coalesce(checkpoint.last_memory_id,
             '00000000-0000-0000-0000-000000000000'::uuid)
       )`,
    [JSON.stringify(domainJson), embeddingVersion],
  );
  const checkpoints = await context.db.query<MemoryVectorBackfillCheckpointRow>(
    `/* memory-vector-backfill-checkpoint */
     select checkpoint.id::text,checkpoint.scope,checkpoint.account_id::text,
            checkpoint.node_brain_id::text,checkpoint.conversation_id::text,
            checkpoint.last_memory_id::text
     from jsonb_array_elements($1::jsonb) with ordinality domain(value,ordinal)
     join memory_vector_backfill_checkpoints checkpoint
       on checkpoint.scope=domain.value->>'scope'
      and checkpoint.account_id is not distinct from (domain.value->>'accountId')::uuid
      and checkpoint.node_brain_id is not distinct from (domain.value->>'nodeBrainId')::uuid
      and checkpoint.conversation_id is not distinct from (domain.value->>'conversationId')::uuid
      and checkpoint.embedding_version=$2
     where not checkpoint.completed
     order by domain.ordinal
     limit 1 for update of checkpoint`,
    [JSON.stringify(domainJson), embeddingVersion],
  );
  const checkpoint = checkpoints[0];
  if (!checkpoint) return 0;
  const privateDomain = checkpoint.scope === "PRIVATE_ACCOUNT" || checkpoint.scope === "NODE_BRANCH";
  const scanIdentity = privateDomain
    ? `memory.account_id=$2::uuid and memory.node_brain_id=$3::uuid
       and memory.conversation_id=$4::uuid`
    : `memory.account_id is null and $2::uuid is null
       and memory.node_brain_id is null and $3::uuid is null
       and memory.conversation_id is null and $4::uuid is null`;
  const scanned = await context.db.query<{ id: string } & Record<string, unknown>>(
    `/* memory-vector-backfill-scan */
     select memory.id::text
     from memory_records memory
     where memory.scope=$1
       and ${scanIdentity}
       and memory.embedding_version=$5 and memory.has_embedding
       and memory.id>coalesce($6::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
     order by memory.id
     limit 100`,
    [checkpoint.scope, checkpoint.account_id, checkpoint.node_brain_id,
      checkpoint.conversation_id, embeddingVersion, checkpoint.last_memory_id],
  );
  if (scanned.length === 0) {
    await context.db.query(
      `/* memory-vector-backfill-checkpoint-finished */
       update memory_vector_backfill_checkpoints
       set completed=true,updated_at=clock_timestamp() where id=$1::bigint`,
      [checkpoint.id],
    );
    return 0;
  }
  await context.db.query(
    `/* memory-vector-backfill-checkpoint-advance */
     update memory_vector_backfill_checkpoints
     set last_memory_id=$2,scanned_count=scanned_count+$3,
         completed=$4,updated_at=clock_timestamp()
     where id=$1::bigint`,
    [checkpoint.id, scanned[scanned.length - 1]!.id, scanned.length,
      scanned.length < MEMORY_VECTOR_BACKFILL_LIMIT],
  );
  const rows = await context.db.query<MemoryVectorBackfillRow>(
    `/* memory-vector-backfill-eligible */
     select memory.id::text,memory.body_event_id::text,body.data_key_id::text body_key_id,
            memory.scope,memory.account_id::text,memory.node_brain_id::text,
            memory.conversation_id::text,memory.search_key_id::text,memory.embedding_version,
            memory.embedding_digest,memory.embedding_dimension,
            embedding.search_embedding
     from memory_records memory
     join encrypted_event_bodies body on body.event_id=memory.body_event_id
       and body.data_key_id is not null
     join aggregate_data_keys body_key on body_key.id=body.data_key_id
     left join memory_embeddings embedding on embedding.memory_id=memory.id
       and embedding.active and embedding.embedding_version=memory.embedding_version
     where memory.id=any($1::uuid[]) and memory.has_embedding and memory.embedding_version=$3
       and (memory.scope='PUBLIC' and embedding.memory_id is not null
         or memory.scope<>'PUBLIC' and exists (
           select 1 from aggregate_data_keys search_key where search_key.id=memory.search_key_id
         ))
       and (select count(*) from memory_vector_buckets bucket
            where bucket.memory_id=memory.id)<6
       and exists (
         select 1 from jsonb_array_elements($2::jsonb) domain
         where domain->>'scope'=memory.scope
           and (memory.scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') or (
             memory.account_id::text=domain->>'accountId'
             and memory.node_brain_id::text=domain->>'nodeBrainId'
             and memory.conversation_id::text=domain->>'conversationId'
           ))
       )
       and not exists (
         select 1 from memory_records sibling
         where sibling.body_event_id=memory.body_event_id and not exists (
           select 1 from jsonb_array_elements($2::jsonb) domain
           where domain->>'scope'=sibling.scope
             and (sibling.scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') or (
               sibling.account_id::text=domain->>'accountId'
               and sibling.node_brain_id::text=domain->>'nodeBrainId'
               and sibling.conversation_id::text=domain->>'conversationId'
             ))
         )
       )
     order by memory.id
     limit ${MEMORY_VECTOR_BACKFILL_LIMIT}`,
    [scanned.map(({ id }) => id), JSON.stringify(domainJson), embeddingVersion],
  );
  if (rows.length === 0) return 0;
  const lockedBodyEventIds = new Set(await lockAvailableMemorySourceBodies(
    context.db, [...new Set(rows.map(({ body_event_id }) => body_event_id))],
  ));
  const availableRows = rows.filter(({ body_event_id }) => lockedBodyEventIds.has(body_event_id));
  if (availableRows.length === 0) return 0;
  const protectedRows = availableRows.filter(({ scope }) => scope !== "PUBLIC");
  const bodyEventIds = [...new Set(protectedRows.map(({ body_event_id }) => body_event_id))];
  const bodies = bodyEventIds.length === 0 ? [] : await readEventBodies(
    context.db, bodyEventIds, { actor: { role: "SYSTEM" } },
  );
  const memoriesByBody = new Map(bodies.map(({ eventId, body }) => {
    const header = protectedBodyHeader(body);
    if (!header.memories) throw new Error("INVALID_MEMORY_CONSOLIDATION_BODY");
    return [eventId, captureMemoryInput(header.memories)] as const;
  }));
  const searchKeyIds = [...new Set(protectedRows.map(({ search_key_id }) => search_key_id)
    .filter((id): id is string => id !== null))];
  const keyRows = searchKeyIds.length === 0 ? [] : await context.db.query<
    AggregateKeyRow & { readonly aggregate_id: string }
  >(
    `select id::text,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
     from aggregate_data_keys where id=any($1::uuid[]) order by id for key share`,
    [searchKeyIds],
  );
  if (keyRows.length !== searchKeyIds.length) throw new Error("EVENT_KEY_UNAVAILABLE");
  const indexKeys = new Map<string, Buffer>();
  const dataKeys: Buffer[] = [];
  try {
    for (const keyRow of keyRows) {
      const dataKey = unwrapDataKey(keyRow.aggregate_id, {
        rootKeyVersion: keyRow.root_key_version, wrappedKey: keyRow.wrapped_key,
        iv: keyRow.wrap_iv, authTag: keyRow.wrap_auth_tag,
      });
      dataKeys.push(dataKey);
      indexKeys.set(keyRow.id, deriveIndexHmacKey(dataKey));
    }
    const bucketRows = availableRows.map((row) => {
      let vector: readonly number[];
      if (row.scope === "PUBLIC") {
        if (!row.search_embedding) throw new Error("INVALID_MEMORY_SEARCH_EMBEDDING");
        vector = row.search_embedding;
      } else {
        const memoryValue = memoriesByBody.get(row.body_event_id)?.find((item) => (
          item !== null && typeof item === "object" && !Array.isArray(item)
          && "id" in item && item.id === row.id
        ));
        if (!memoryValue || typeof memoryValue !== "object" || Array.isArray(memoryValue)) {
          throw new Error("MEMORY_REPLAY_BODY_MISMATCH");
        }
        const memory = memoryValue as unknown as Record<string, unknown>;
        if (memory.scope !== row.scope || memory.accountId !== row.account_id
            || memory.nodeBrainId !== row.node_brain_id
            || memory.conversationId !== row.conversation_id
            || memory.embeddingVersion !== row.embedding_version
            || memory.embeddingDigest !== row.embedding_digest
            || !Array.isArray(memory.embedding)
            || memory.embedding.length !== row.embedding_dimension) {
          throw new Error("MEMORY_REPLAY_BODY_MISMATCH");
        }
        vector = memory.embedding.map((component) => {
          if (typeof component !== "number") throw new Error("INVALID_MEMORY_SEARCH_EMBEDDING");
          return component;
        });
      }
      const indexKey = row.search_key_id === null ? null : indexKeys.get(row.search_key_id);
      if (row.scope !== "PUBLIC" && !indexKey) throw new Error("EVENT_KEY_UNAVAILABLE");
      return Object.freeze({ ...row, digests: memoryVectorBucketDigests({
        vector, scope: row.scope, embeddingVersion: row.embedding_version,
        indexKey: indexKey ?? null,
      }) });
    });
    await context.db.query(
      `insert into memory_vector_buckets (
         memory_id,ordinal,scope,account_id,node_brain_id,conversation_id,search_key_id,
         body_key_id,embedding_version,bucket_digest
       ) select (item->>'id')::uuid,(bucket.ordinal-1)::integer,item->>'scope',
                (item->>'account_id')::uuid,(item->>'node_brain_id')::uuid,
                (item->>'conversation_id')::uuid,(item->>'search_key_id')::uuid,
                (item->>'body_key_id')::uuid,item->>'embedding_version',bucket.digest
         from jsonb_array_elements($1::jsonb) item
         cross join lateral jsonb_array_elements_text(item->'digests')
           with ordinality bucket(digest,ordinal)
       on conflict do nothing`,
      [JSON.stringify(bucketRows)],
    );
  } finally {
    for (const key of indexKeys.values()) key.fill(0);
    for (const key of dataKeys) key.fill(0);
  }
  return availableRows.length;
}

function validatedSearchVector(value: readonly number[]): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8_192
      || value.some((component) => typeof component !== "number" || !Number.isFinite(component)
        || Math.abs(component) > 3.4e38)) {
    throw new Error("INVALID_MEMORY_SEARCH_EMBEDDING");
  }
  const normSquared = value.reduce((sum, component) => sum + component * component, 0);
  if (!Number.isFinite(normSquared) || normSquared === 0) {
    throw new Error("INVALID_MEMORY_SEARCH_EMBEDDING");
  }
  return value;
}

function extractionRequestDocument(input: ProcessMemoryEventInput): unknown {
  return {
    accountId: input.accountId ?? null,
    conversationId: input.conversationId ?? null,
    events: input.events,
    extracted: input.extracted,
    idleBoundaryMinutes: input.idleBoundaryMinutes ?? null,
    nodeBrainId: input.nodeBrainId ?? null,
    observedAt: input.observedAt,
    scope: input.scope,
    sourceEventId: input.sourceEventId,
    versions: input.versions,
  };
}

function sourceText(body: JsonValue): string {
  const directText = body && !Array.isArray(body) && typeof body === "object"
    ? body.text : undefined;
  const text = typeof directText === "string" ? directText : canonicalJson(body);
  if (text.length === 0 || text.length > 100_000) {
    throw new Error("MEMORY_SOURCE_TEXT_UNAVAILABLE");
  }
  return text;
}

async function validatePrivateTopology(
  db: ProcessMemoryEventContext["db"],
  input: Pick<ProcessMemoryEventInput, "scope" | "accountId" | "nodeBrainId" | "conversationId">,
): Promise<void> {
  if (input.scope !== "PRIVATE_ACCOUNT" && input.scope !== "NODE_BRANCH") return;
  const nodeRows = await db.query<{ id: string }>(
    "select id::text from node_brains where id=$1 and account_id=$2 and status='ACTIVE'",
    [input.nodeBrainId, input.accountId],
  );
  if (nodeRows.length !== 1) throw new Error("MEMORY_NODE_AUTHORITY_MISMATCH");
  const conversationRows = await db.query<{ id: string }>(
    `select id::text from conversations
     where id=$1 and account_id=$2 and node_brain_id=$3 and status='OPEN'`,
    [input.conversationId, input.accountId, input.nodeBrainId],
  );
  if (conversationRows.length !== 1) throw new Error("MEMORY_CONVERSATION_AUTHORITY_MISMATCH");
}

export async function deriveMemorySearchTermDigest(
  context: ProcessMemoryEventContext,
  input: MemorySearchTermInput,
): Promise<string> {
  return (await deriveMemorySearchTermDigests(context, [input]))[0]!;
}

export async function deriveMemorySearchTermDigests(
  context: ProcessMemoryEventContext,
  inputs: readonly MemorySearchTermInput[],
): Promise<readonly string[]> {
  if (!memoryWorkerContexts.has(context)) throw new Error("MEMORY_WORKER_CONTEXT_REQUIRED");
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 2_200) {
    throw new Error("MEMORY_SEARCH_TERM_BATCH_LIMIT");
  }
  const captured = inputs.map((input) => captureMemoryInput(input));
  const authority = captured[0]!;
  if (captured.some((item) => (item.kind !== "KEYWORD" && item.kind !== "ENTITY")
    || item.scope !== authority.scope || item.accountId !== authority.accountId
    || item.nodeBrainId !== authority.nodeBrainId
    || item.conversationId !== authority.conversationId
    || item.aggregateId !== authority.aggregateId)) {
    throw new Error("MEMORY_SEARCH_TERM_BATCH_AUTHORITY_MISMATCH");
  }
  const terms = captured.map((item) => required(
    item.term, "INVALID_MEMORY_SEARCH_TERM", 120,
  ).trim().toLowerCase());
  if (authority.scope === "PUBLIC") {
    return Object.freeze(captured.map((item, index) => canonicalContentDigest({
      kind: item.kind, term: terms[index]!,
    })));
  }
  await validatePrivateTopology(context.db, authority);
  const retrieval = await loadRetrievalKey(context.db, authority, false);
  if (!retrieval) throw new Error("MEMORY_RETRIEVAL_KEY_REQUIRED");
  const key = deriveIndexHmacKey(retrieval.dataKey);
  try {
    return Object.freeze(captured.map((item, index) => keyedDigest(key, {
      domain: "gustavo:memory-search:v1", kind: item.kind, scope: item.scope,
      term: terms[index]!,
    })));
  } finally {
    key.fill(0);
    retrieval.dataKey.fill(0);
  }
}

export async function rankAuthorizedMemoryEmbeddings(
  context: ProcessMemoryEventContext,
  input: MemoryVectorRankingInput,
): Promise<readonly RankedMemoryEmbedding[]> {
  if (!memoryWorkerContexts.has(context)) throw new Error("MEMORY_WORKER_CONTEXT_REQUIRED");
  const captured = captureMemoryInput(input);
  if (!Array.isArray(captured.candidateIds) || captured.candidateIds.length === 0
      || captured.candidateIds.length > 100) throw new Error("MEMORY_VECTOR_CANDIDATE_LIMIT");
  const candidateIds = [...new Set(captured.candidateIds.map((id) => requiredUuid(
    id, "INVALID_MEMORY_CANDIDATE_ID",
  )))];
  const queryVector = validatedSearchVector(captured.queryVector);
  const embeddingVersion = required(
    captured.embeddingVersion, "INVALID_MEMORY_EMBEDDING_VERSION", 200,
  );
  const limit = captured.limit ?? candidateIds.length;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("MEMORY_VECTOR_RESULT_LIMIT");
  }
  await validatePrivateTopology(context.db, captured);
  const rows = await context.db.query<{ id: string; body_event_id: string }>(
    `select id::text,body_event_id::text from memory_records
     where id=any($1::uuid[]) and scope=$2
       and account_id is not distinct from $3
       and node_brain_id is not distinct from $4
       and conversation_id is not distinct from $5
       and embedding_version=$6
       and has_embedding
     order by id limit 101`,
    [candidateIds, captured.scope, captured.accountId ?? null,
      captured.nodeBrainId ?? null, captured.conversationId ?? null, embeddingVersion],
  );
  if (rows.length !== candidateIds.length) {
    throw new Error("MEMORY_VECTOR_CANDIDATE_AUTHORITY_MISMATCH");
  }
  const bodyEventIds = [...new Set(rows.map((row) => row.body_event_id))];
  const bodyResults = await readEventBodies(context.db, bodyEventIds, {
    actor: captured.scope === "PRIVATE_ACCOUNT" || captured.scope === "NODE_BRANCH"
      ? { role: "ACCOUNT", accountId: captured.accountId! }
      : { role: "SYSTEM" },
  });
  const bodies = new Map(bodyResults.map((result) => [result.eventId, result.body]));
  const ranked: RankedMemoryEmbedding[] = [];
  for (const row of rows) {
    const body = bodies.get(row.body_event_id)!;
    const header = protectedBodyHeader(body);
    const memory = header.memories?.find((candidate) => (
      candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as { id?: unknown }).id === row.id
    )) as { embedding?: unknown; embeddingVersion?: unknown } | undefined;
    if (!memory || memory.embeddingVersion !== embeddingVersion || !Array.isArray(memory.embedding)) {
      throw new Error("MEMORY_VECTOR_BODY_MISMATCH");
    }
    const embedding = validatedSearchVector(memory.embedding as number[]);
    if (embedding.length !== queryVector.length) throw new Error("MEMORY_VECTOR_DIMENSION_MISMATCH");
    const dot = embedding.reduce((sum, value, index) => sum + value * queryVector[index], 0);
    const leftNorm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    const rightNorm = Math.sqrt(queryVector.reduce((sum, value) => sum + value * value, 0));
    const calculated = dot / (leftNorm * rightNorm);
    const similarity = Math.abs(calculated - 1) < 1e-12 ? 1 : calculated;
    ranked.push(Object.freeze({ memoryId: row.id, similarity }));
  }
  return Object.freeze(ranked.sort((left, right) => right.similarity - left.similarity
    || left.memoryId.localeCompare(right.memoryId)).slice(0, limit));
}

async function persistableForScope(
  db: ProcessMemoryEventContext["db"],
  input: ProcessMemoryEventInput,
  memories: readonly ConsolidatedMemory[],
  salt: Buffer,
): Promise<{
  readonly memories: readonly ConsolidatedMemory[];
  readonly searchKeyId: string | null;
  readonly vectorBucketDigests: ReadonlyMap<string, readonly string[]>;
}> {
  if (!protectedScope(input.scope)) {
    const persisted = persistableMemories(memories, salt, null);
    return {
      memories: persisted,
      searchKeyId: null,
      vectorBucketDigests: new Map(persisted.map((memory) => [memory.id,
        memory.embedding === null ? Object.freeze([]) : memoryVectorBucketDigests({
          vector: memory.embedding, scope: memory.scope,
          embeddingVersion: memory.embeddingVersion, indexKey: null,
        })])),
    };
  }
  const retrieval = await loadRetrievalKey(db, input, true);
  if (!retrieval) throw new Error("MEMORY_RETRIEVAL_KEY_REQUIRED");
  const indexKey = deriveIndexHmacKey(retrieval.dataKey);
  try {
    const persisted = persistableMemories(memories, salt, indexKey);
    return {
      memories: persisted,
      searchKeyId: retrieval.id,
      vectorBucketDigests: new Map(persisted.map((memory) => [memory.id,
        memory.embedding === null ? Object.freeze([]) : memoryVectorBucketDigests({
          vector: memory.embedding, scope: memory.scope,
          embeddingVersion: memory.embeddingVersion, indexKey,
        })])),
    };
  } finally {
    indexKey.fill(0);
    retrieval.dataKey.fill(0);
  }
}

async function hydratePersistedMemories(
  db: ProcessMemoryEventContext["db"],
  runId: string,
  header: ProtectedConsolidationBody,
): Promise<readonly ConsolidatedMemory[]> {
  if (!header.memories) throw new Error("INVALID_MEMORY_CONSOLIDATION_BODY");
  const memories = captureMemoryInput(header.memories);
  const rows = await db.query<{
    id: string; ordinal: number; type: string; scope: string;
    account_id: string | null; node_brain_id: string | null; conversation_id: string | null;
    content_digest: string; equivalence_digest: string; keywords_digest: string;
    entities_digest: string; embedding_digest: string | null; prompt_version: string;
    model_version: string; extractor_version: string; embedding_version: string;
    source_ids: string[];
  }>(
    `select memory.id::text,memory.ordinal,memory.type,memory.scope,
            memory.account_id::text,memory.node_brain_id::text,memory.conversation_id::text,
            memory.content_digest,memory.equivalence_digest,memory.keywords_digest,
            memory.entities_digest,memory.embedding_digest,memory.prompt_version,
            memory.model_version,memory.extractor_version,memory.embedding_version,
            array_agg(source.source_event_id::text order by source.ordinal) source_ids
     from memory_records memory
     join memory_sources source on source.memory_id=memory.id
     where memory.extraction_run_id=$1
     group by memory.id
     order by memory.ordinal`,
    [runId],
  );
  if (rows.length !== memories.length) throw new Error("MEMORY_REPLAY_BODY_MISMATCH");
  for (const [ordinal, value] of memories.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("MEMORY_REPLAY_BODY_MISMATCH");
    }
    const memory = value as unknown as Record<string, unknown>;
    const row = rows[ordinal];
    if (memory.id !== row.id || memory.ordinal !== row.ordinal || memory.type !== row.type
        || memory.scope !== row.scope || memory.accountId !== row.account_id
        || memory.nodeBrainId !== row.node_brain_id || memory.conversationId !== row.conversation_id
        || memory.contentDigest !== row.content_digest
        || memory.equivalenceDigest !== row.equivalence_digest
        || memory.keywordsDigest !== row.keywords_digest
        || memory.entitiesDigest !== row.entities_digest
        || memory.embeddingDigest !== row.embedding_digest
        || memory.promptVersion !== row.prompt_version || memory.modelVersion !== row.model_version
        || memory.extractorVersion !== row.extractor_version
        || memory.embeddingVersion !== row.embedding_version
        || canonicalJson(memory.sourceIds) !== canonicalJson(row.source_ids)) {
      throw new Error("MEMORY_REPLAY_BODY_MISMATCH");
    }
  }
  return memories as readonly ConsolidatedMemory[];
}

function compareSource(left: SourceEventRow, right: SourceEventRow): number {
  const comparison = BigInt(left.ingested_sequence) - BigInt(right.ingested_sequence);
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function supersessionAuthority(
  memory: ConsolidatedMemory,
  sourceById: ReadonlyMap<string, SourceEventRow>,
): { readonly sourceEventId: string; readonly kind: SupersessionAuthorityKind } | null {
  if (memory.supersedesMemoryId === null) return null;
  const sources = memory.sourceIds.map((id) => sourceById.get(id)!);
  if (memory.correctionState === "USER_CORRECTED") {
    const source = sources.find((candidate) => candidate.actor_type === "USER"
      && candidate.actor_id === memory.accountId);
    if (!source || (memory.scope !== "PRIVATE_ACCOUNT" && memory.scope !== "NODE_BRANCH")) {
      throw new Error("MEMORY_CORRECTION_AUTHORITY_MISMATCH");
    }
    return { sourceEventId: source.id, kind: "USER" };
  }
  if (memory.correctionState === "OPERATOR_CORRECTED") {
    const source = sources.find((candidate) => candidate.actor_type === "OPERATOR");
    if (!source) throw new Error("MEMORY_CORRECTION_AUTHORITY_MISMATCH");
    return { sourceEventId: source.id, kind: "OPERATOR" };
  }
  if (memory.scope === "MAIN_SHARED" || memory.scope === "PUBLIC") {
    const source = sources.find((candidate) => candidate.actor_type === "MAIN_BRAIN"
      && candidate.actor_id === "gustavo-main"
      && ["winner.selected", "main.broadcast.committed", "commentary.published"].includes(candidate.type));
    if (!source) throw new Error("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");
    return { sourceEventId: source.id, kind: "MAIN" };
  }
  if (memory.scope === "CHALLENGE_SHARED") {
    const source = sources.find((candidate) => (
      (candidate.actor_type === "MAIN_BRAIN" && candidate.actor_id === "gustavo-main"
        && candidate.type === "winner.selected")
      || (candidate.actor_type === "SYSTEM" && candidate.actor_id === "challenge-stage-lifecycle"
        && ["challenge.passed", "challenge.failed"].includes(candidate.type))
    ));
    if (!source) throw new Error("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");
    return { sourceEventId: source.id, kind: "CHALLENGE" };
  }
  throw new Error("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");
}

async function attachMemoryEquivalence(
  db: ProcessMemoryEventContext["db"],
  memory: ConsolidatedMemory,
  createdAt: string,
): Promise<void> {
  await db.query(
    `insert into memory_equivalence_sets (
       id,scope,account_id,node_brain_id,conversation_id,type,equivalence_digest,
       canonical_memory_id,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict do nothing`,
    [randomUUID(), memory.scope, memory.accountId, memory.nodeBrainId, memory.conversationId,
      memory.type, memory.equivalenceDigest, memory.id, createdAt],
  );
  const set = await db.one<{ canonical_memory_id: string }>(
    `select canonical_memory_id::text from memory_equivalence_sets
     where scope=$1 and account_id is not distinct from $2
       and node_brain_id is not distinct from $3
       and conversation_id is not distinct from $4
       and type=$5 and equivalence_digest=$6`,
    [memory.scope, memory.accountId, memory.nodeBrainId, memory.conversationId,
      memory.type, memory.equivalenceDigest],
  );
  if (set.canonical_memory_id !== memory.id) {
    await db.query(
      `insert into memory_equivalence_links
         (memory_id,equivalent_memory_id,created_at) values ($1,$2,$3)`,
      [memory.id, set.canonical_memory_id, createdAt],
    );
  }
}

async function insertMemory(
  db: ProcessMemoryEventContext["db"],
  runId: string,
  bodyEventId: string,
  completedAt: string,
  memory: ConsolidatedMemory,
  sourceTimes: ReadonlyMap<string, string>,
  sourceSequences: ReadonlyMap<string, string>,
  sourceById: ReadonlyMap<string, SourceEventRow>,
  searchKeyId: string | null,
  vectorBucketDigests: readonly string[],
): Promise<void> {
  const authority = supersessionAuthority(memory, sourceById);
  await db.query(
    `insert into memory_records (
       id,extraction_run_id,body_event_id,ordinal,source_count,type,scope,account_id,node_brain_id,
       conversation_id,search_key_id,content_digest,equivalence_digest,keywords_digest,entities_digest,
       keyword_index_digests,entity_index_digests,public_keyword_terms,public_entity_terms,
       keyword_count,entity_count,has_embedding,embedding_digest,embedding_dimension,
       search_embedding_manifest,source_from,source_to,
       confidence,importance,freshness,prompt_version,model_version,
       extractor_version,embedding_version,valid_from,valid_to,supersedes_memory_id,
       conflict_state,correction_state,procedure_version,goal_status,created_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42
     )`,
    [memory.id, runId, bodyEventId, memory.ordinal, memory.sourceIds.length, memory.type, memory.scope,
      memory.accountId, memory.nodeBrainId, memory.conversationId, searchKeyId, memory.contentDigest,
      memory.equivalenceDigest,
      memory.keywordsDigest, memory.entitiesDigest, [...memory.keywordIndexDigests],
      [...memory.entityIndexDigests], memory.scope === "PUBLIC" ? [...memory.keywords] : null,
      memory.scope === "PUBLIC" ? [...memory.entities] : null,
      memory.keywords.length, memory.entities.length,
      memory.embedding !== null, memory.embeddingDigest, memory.embeddingDimension,
      memory.scope === "PUBLIC" && memory.embedding !== null ? [...memory.embedding] : null,
      memory.sourceFrom, memory.sourceTo,
      memory.confidence, memory.importance, memory.freshness, memory.promptVersion,
      memory.modelVersion, memory.extractorVersion, memory.embeddingVersion, memory.validFrom,
      memory.validTo, memory.supersedesMemoryId, memory.conflictState, memory.correctionState,
      memory.procedureVersion, memory.goalStatus, completedAt],
  );
  for (const [ordinal, sourceId] of memory.sourceIds.entries()) {
    await db.query(
      `insert into memory_sources (
         memory_id,ordinal,source_event_id,source_ingested_sequence,source_at
       ) values ($1,$2,$3,$4,$5)`,
      [memory.id, ordinal, sourceId, sourceSequences.get(sourceId), sourceTimes.get(sourceId)],
    );
  }
  if (memory.type === "SEMANTIC") {
    await db.query("insert into memory_semantic_facts (memory_id,fact_digest) values ($1,$2)",
      [memory.id, memory.contentDigest]);
  } else if (memory.type === "EPISODIC") {
    await db.query(
      "insert into memory_episodes (memory_id,episode_from,episode_to) values ($1,$2,$3)",
      [memory.id, memory.sourceFrom, memory.sourceTo],
    );
  } else if (memory.type === "PROCEDURAL") {
    await db.query(
      `insert into memory_procedures (memory_id,procedure_version,procedure_digest)
       values ($1,$2,$3)`,
      [memory.id, memory.procedureVersion, memory.contentDigest],
    );
  } else {
    await db.query("insert into memory_goals (memory_id,status,goal_digest) values ($1,$2,$3)",
      [memory.id, memory.goalStatus, memory.contentDigest]);
  }
  for (const [ordinal, term] of memory.keywords.entries()) {
    await db.query(
      `insert into memory_index_terms (
         memory_id,ordinal,kind,scope,account_id,node_brain_id,conversation_id,search_key_id,
         term_text,term_digest,set_digest,prompt_version,model_version,extractor_version
       ) values ($1,$2,'KEYWORD',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [memory.id, ordinal, memory.scope, memory.accountId, memory.nodeBrainId,
        memory.conversationId, searchKeyId, memory.scope === "PUBLIC" ? term : null,
        memory.keywordIndexDigests[ordinal], memory.keywordsDigest, memory.promptVersion,
        memory.modelVersion, memory.extractorVersion],
    );
  }
  for (const [ordinal, term] of memory.entities.entries()) {
    await db.query(
      `insert into memory_index_terms (
         memory_id,ordinal,kind,scope,account_id,node_brain_id,conversation_id,search_key_id,
         term_text,term_digest,set_digest,prompt_version,model_version,extractor_version
       ) values ($1,$2,'ENTITY',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [memory.id, ordinal, memory.scope, memory.accountId, memory.nodeBrainId,
        memory.conversationId, searchKeyId, memory.scope === "PUBLIC" ? term : null,
        memory.entityIndexDigests[ordinal], memory.entitiesDigest, memory.promptVersion,
        memory.modelVersion, memory.extractorVersion],
    );
  }
  if (memory.scope === "PUBLIC" && memory.embedding !== null) {
    await db.query(
      `insert into memory_embeddings (
         memory_id,account_id,node_brain_id,conversation_id,scope,embedding_version,
         embedding_digest,dimension,search_embedding
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [memory.id, memory.accountId, memory.nodeBrainId, memory.conversationId, memory.scope,
        memory.embeddingVersion, memory.embeddingDigest, memory.embeddingDimension,
        memory.embedding],
    );
  }
  if (memory.embedding !== null) {
    await db.query(
      `insert into memory_vector_buckets (
         memory_id,ordinal,scope,account_id,node_brain_id,conversation_id,search_key_id,
         body_key_id,embedding_version,bucket_digest
       ) select $1,(bucket.ordinal-1)::int,$2,$3,$4,$5,$6,body.data_key_id,$7,bucket.digest
           from encrypted_event_bodies body
           cross join unnest($8::text[]) with ordinality bucket(digest,ordinal)
           where body.event_id=$9 and body.data_key_id is not null`,
      [memory.id, memory.scope, memory.accountId, memory.nodeBrainId, memory.conversationId,
        searchKeyId, memory.embeddingVersion, vectorBucketDigests, bodyEventId],
    );
  }
  if (authority) {
    await db.query(
      `insert into memory_supersession_authorizations
         (memory_id,source_event_id,authority_kind) values ($1,$2,$3)`,
      [memory.id, authority.sourceEventId, authority.kind],
    );
  }
  await attachMemoryEquivalence(db, memory, completedAt);
  await db.query("insert into memory_retrieval_stats (memory_id) values ($1)", [memory.id]);
}

export async function processMemoryEvent(
  context: ProcessMemoryEventContext,
  input: ProcessMemoryEventInput,
): Promise<ProcessedMemoryEvent> {
  if (!memoryWorkerContexts.has(context)) {
    throw new Error("MEMORY_WORKER_CONTEXT_REQUIRED");
  }
  input = captureMemoryInput(input);
  requiredUuid(input.sourceEventId, "INVALID_MEMORY_SOURCE_EVENT_ID");
  required(input.idempotencyKey, "INVALID_MEMORY_IDEMPOTENCY_KEY");
  input.events.forEach((event) => requiredUuid(event.id, "INVALID_MEMORY_SOURCE_EVENT_ID"));
  if (input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH") {
    requiredUuid(input.accountId, "INVALID_MEMORY_ACCOUNT_ID");
    requiredUuid(input.nodeBrainId, "INVALID_MEMORY_NODE_ID");
    requiredUuid(input.conversationId, "INVALID_MEMORY_CONVERSATION_ID");
  }
  return context.db.transaction(async (transaction) => {
    // Resolve and authorize source metadata before any protected source body could be loaded.
    const leadRows = await transaction.query<SourceEventRow>(
      `select id::text,aggregate_id,account_id,type,visibility,actor_type,actor_id,
              occurred_at,ingested_sequence::text,correlation_id::text
       from events where id=$1`,
      [input.sourceEventId],
    );
    const lead = leadRows[0];
    if (!lead) throw new Error("MEMORY_SOURCE_EVENT_REQUIRED");
    if (derivedMemoryEventType(lead.type)) {
      throw new Error("MEMORY_DERIVED_EVENT_NOT_SOURCE");
    }
    if (lead.visibility === "PRIVATE_ACCOUNT"
        && input.scope !== "PRIVATE_ACCOUNT" && input.scope !== "NODE_BRANCH") {
      throw new Error("MEMORY_SCOPE_BROADENING_FORBIDDEN");
    }
    if ((input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH")
        && lead.account_id !== input.accountId) {
      throw new Error("MEMORY_SOURCE_SCOPE_MISMATCH");
    }
    await validatePrivateTopology(transaction, input);
    const key = projectionKey(input, lead);
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-projection:${key}`,
    ]);
    const consolidated = consolidateEvents(input);
    if (!input.events.some((event) => event.id === input.sourceEventId)) {
      throw new Error("MEMORY_HIGH_WATER_NOT_IN_BATCH");
    }
    const eventIds = input.events.map((event) => event.id);
    const sourceRows = await transaction.query<SourceEventRow>(
      `select id::text,aggregate_id,account_id,type,visibility,actor_type,actor_id,
              occurred_at,ingested_sequence::text,correlation_id::text
       from events where id=any($1::uuid[])`,
      [eventIds],
    );
    if (sourceRows.length !== eventIds.length) throw new Error("MEMORY_SOURCE_EVENT_REQUIRED");
    const sourceById = new Map(sourceRows.map((source) => [source.id, source]));
    if (sourceRows.some((source) => derivedMemoryEventType(source.type))) {
      throw new Error("MEMORY_DERIVED_EVENT_NOT_SOURCE");
    }
    if (sourceRows.some((source) => source.aggregate_id !== lead.aggregate_id)) {
      throw new Error("MEMORY_SOURCE_AGGREGATE_MISMATCH");
    }
    const maximumSource = [...sourceRows].sort(compareSource).at(-1)!;
    if (maximumSource.id !== lead.id) throw new Error("MEMORY_LEAD_NOT_BATCH_MAXIMUM");
    const sourceTimes = new Map<string, string>();
    const sourceSequences = new Map<string, string>();
    for (const event of input.events) {
      const source = sourceById.get(event.id);
      if (!source || !sourceScopeMatches(input, source)) {
        throw new Error("MEMORY_SOURCE_SCOPE_MISMATCH");
      }
      const persistedAt = source.occurred_at.toISOString();
      if (persistedAt !== new Date(event.at).toISOString()) {
        throw new Error("MEMORY_SOURCE_TIME_MISMATCH");
      }
      sourceTimes.set(event.id, persistedAt);
      sourceSequences.set(event.id, source.ingested_sequence);
    }
    const operationKey = canonicalContentDigest({
      embeddingVersion: input.versions.embeddingVersion,
      extractorVersion: input.versions.extractorVersion,
      modelVersion: input.versions.modelVersion,
      projectionKey: key,
      promptVersion: input.versions.promptVersion,
      sourceEventId: input.sourceEventId,
    });
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `memory-operation:${operationKey}`,
    ]);
    const callerExisting = (await transaction.query<ExistingRunRow>(
      `select id::text,consolidation_event_id::text,request_digest,operation_key
       from memory_extraction_runs
       where scope=$1 and account_id is not distinct from $2
         and node_brain_id is not distinct from $3
         and conversation_id is not distinct from $4
         and projection_key=$5 and idempotency_key=$6`,
      [input.scope, input.accountId ?? null, input.nodeBrainId ?? null,
        input.conversationId ?? null, key, input.idempotencyKey],
    ))[0];
    if (callerExisting && callerExisting.operation_key !== operationKey) {
      throw new Error("MEMORY_IDEMPOTENCY_KEY_REUSED");
    }
    const existing = callerExisting ?? (await transaction.query<ExistingRunRow>(
      `select id::text,consolidation_event_id::text,request_digest,operation_key
       from memory_extraction_runs where operation_key=$1`,
      [operationKey],
    ))[0];
    if (!existing) {
      const checkpoint = (await transaction.query<CheckpointRow>(
        `select source_event_id::text,source_occurred_at,source_ingested_sequence::text
         from memory_projection_checkpoints where projection_key=$1`,
        [key],
      ))[0];
      if (checkpoint) {
        const leadSequence = BigInt(lead.ingested_sequence);
        const checkpointSequence = BigInt(checkpoint.source_ingested_sequence);
        if (leadSequence < checkpointSequence) {
          throw new Error("MEMORY_SOURCE_BEHIND_CHECKPOINT");
        }
        if (leadSequence === checkpointSequence) {
          const fullBatch = await transaction.query<{ id: string }>(
            `select event.id::text
             from events event
             join transactional_outbox outbox on outbox.event_id=event.id
             where event.type not in ('memory.consolidation.completed','memory.edge.versioned')
               and event.type not like 'memory.graph.%'
               and event.ingested_sequence<=$1::bigint
               and (
                 ($2 in ('PRIVATE_ACCOUNT','NODE_BRANCH') and event.visibility='PRIVATE_ACCOUNT'
                   and event.account_id=$3 and event.aggregate_id=$4)
                 or ($2 in ('MAIN_SHARED','CHALLENGE_SHARED') and event.visibility='SHARED'
                   and event.account_id is null and event.aggregate_id=$5)
                 or ($2='PUBLIC' and event.visibility='PUBLIC' and event.aggregate_id=$5)
                 or ($2='AUDIT_ONLY' and event.visibility='OPERATOR' and event.aggregate_id=$5)
               )
             order by event.ingested_sequence limit 501`,
            [lead.ingested_sequence, input.scope, input.accountId ?? null,
              input.conversationId ?? null, lead.aggregate_id],
          );
          if (fullBatch.length > 500) throw new Error("MEMORY_PROJECTION_WINDOW_EXCEEDED");
          const supplied = new Set(eventIds);
          if (fullBatch.length !== supplied.size
              || fullBatch.some((event) => !supplied.has(event.id))) {
            throw new Error("MEMORY_VERSION_REEXTRACTION_REQUIRES_FULL_BATCH");
          }
        }
      }
      const isAhead = !checkpoint
        || BigInt(lead.ingested_sequence) > BigInt(checkpoint.source_ingested_sequence);
      if (isAhead) {
        if (checkpoint && sourceRows.some((source) => (
          BigInt(source.ingested_sequence) <= BigInt(checkpoint.source_ingested_sequence)
        ))) {
          throw new Error("MEMORY_PROJECTION_OVERLAP");
        }
        const eligible = await transaction.query<{ id: string }>(
          `select event.id::text
           from events event
           join transactional_outbox outbox on outbox.event_id=event.id
            where event.type not in ('memory.consolidation.completed','memory.edge.versioned')
             and event.type not like 'memory.graph.%'
             and event.ingested_sequence<=$1::bigint
             and ($2::bigint is null or event.ingested_sequence>$2::bigint)
             and (
               ($3 in ('PRIVATE_ACCOUNT','NODE_BRANCH') and event.visibility='PRIVATE_ACCOUNT'
                 and event.account_id=$4 and event.aggregate_id=$5)
               or ($3 in ('MAIN_SHARED','CHALLENGE_SHARED') and event.visibility='SHARED'
                 and event.account_id is null and event.aggregate_id=$6)
               or ($3='PUBLIC' and event.visibility='PUBLIC' and event.aggregate_id=$6)
               or ($3='AUDIT_ONLY' and event.visibility='OPERATOR' and event.aggregate_id=$6)
             )
           order by event.ingested_sequence limit 501`,
          [lead.ingested_sequence, checkpoint?.source_ingested_sequence ?? null,
            input.scope, input.accountId ?? null,
            input.conversationId ?? null, lead.aggregate_id],
        );
        if (eligible.length > 500) throw new Error("MEMORY_PROJECTION_WINDOW_EXCEEDED");
        const supplied = new Set(eventIds);
        if (eligible.some((event) => !supplied.has(event.id))) {
          throw new Error("MEMORY_PROJECTION_GAP");
        }
      }
    }
    for (const event of input.events) {
      const source = sourceById.get(event.id)!;
      const body = await readEventBody(transaction, source.id, {
        actor: source.visibility === "PRIVATE_ACCOUNT"
          ? { role: "ACCOUNT", accountId: input.accountId! }
          : { role: "SYSTEM" },
      });
      if (sourceText(body) !== event.text) {
        throw new Error("MEMORY_SOURCE_TEXT_MISMATCH");
      }
    }
    if (existing) {
      const encryptedBody = await readEventBody(transaction, existing.consolidation_event_id, {
        actor: { role: "SYSTEM" },
      });
      const header = protectedBodyHeader(encryptedBody);
      const digestSalt = Buffer.from(header.digestSalt, "base64");
      const requestDigest = keyedDigest(digestSalt, {
        kind: "request", input: extractionRequestDocument(input),
      });
      if (existing.request_digest !== requestDigest || header.requestDigest !== requestDigest) {
        throw new Error(callerExisting
          ? "MEMORY_IDEMPOTENCY_KEY_REUSED"
          : "MEMORY_OPERATION_PAYLOAD_CONFLICT");
      }
      const memories = await hydratePersistedMemories(transaction, existing.id, header);
      const checkpoint = await transaction.one<CheckpointRow>(
        `select source_event_id::text,source_occurred_at,source_ingested_sequence::text
         from memory_projection_checkpoints where projection_key=$1`,
        [key],
      );
      return Object.freeze({ ...consolidated, memories,
        consolidationEventId: existing.consolidation_event_id,
        extractionRunId: existing.id, highWaterEventId: checkpoint.source_event_id });
    }
    const digestSaltBuffer = randomBytes(32);
    const digestSalt = digestSaltBuffer.toString("base64");
    const requestDigest = keyedDigest(digestSaltBuffer, {
      kind: "request", input: extractionRequestDocument(input),
    });
    const persistedMemory = await persistableForScope(
      transaction, input, consolidated.memories, digestSaltBuffer,
    );
    const memories = persistedMemory.memories;
    const persisted = Object.freeze({ ...consolidated, memories });
    const completedAt = new Date(input.observedAt).toISOString();
    const derived = await appendEvent(transaction, {
      aggregateId: input.scope === "PRIVATE_ACCOUNT" || input.scope === "NODE_BRANCH"
        ? input.conversationId! : lead.aggregate_id,
      accountId: input.accountId,
      actor: { type: "SYSTEM", id: "memory-consolidator" },
      type: "memory.consolidation.completed",
      visibility: eventVisibility(input.scope),
      body: bodyFor(memories, digestSalt, requestDigest),
      causationId: lead.id,
      correlationId: lead.correlation_id,
      occurredAt: new Date(completedAt),
      promptVersion: input.versions.promptVersion,
      modelVersion: input.versions.modelVersion,
      policyVersion: input.versions.extractorVersion,
      idempotencyKey: `memory-event:${operationKey}`,
    });
    const runId = randomUUID();
    await transaction.query(
      `insert into memory_extraction_runs (
         id,source_event_id,source_ingested_sequence,consolidation_event_id,scope,account_id,node_brain_id,
         conversation_id,projection_key,operation_key,source_from,source_to,prompt_version,
         model_version,extractor_version,embedding_version,idempotency_key,request_digest,
         memory_count,completed_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [runId, input.sourceEventId, lead.ingested_sequence, derived.id, input.scope, input.accountId ?? null,
        input.nodeBrainId ?? null, input.conversationId ?? null, key, operationKey,
        consolidated.sourceFrom, consolidated.sourceTo, input.versions.promptVersion, input.versions.modelVersion,
        input.versions.extractorVersion, input.versions.embeddingVersion, input.idempotencyKey,
        requestDigest, memories.length, completedAt],
    );
    for (const memory of memories) {
      await insertMemory(transaction, runId, derived.id, completedAt, memory, sourceTimes,
        sourceSequences, sourceById, persistedMemory.searchKeyId,
        persistedMemory.vectorBucketDigests.get(memory.id) ?? Object.freeze([]));
    }
    await transaction.query(
      `insert into memory_dossier_refreshes (
         extraction_run_id,target_kind,target_key,source_event_id,created_at
       ) values ($1,$2,$3,$4,$5)`,
      [runId, targetKind(input.scope), key, input.sourceEventId, completedAt],
    );
    await transaction.query(
      `insert into memory_projection_checkpoints (
         projection_key,scope,account_id,node_brain_id,conversation_id,source_event_id,
         source_occurred_at,source_ingested_sequence,extraction_run_id,memory_version,updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)
       on conflict (projection_key) do update set
         scope=excluded.scope, account_id=excluded.account_id,
         node_brain_id=excluded.node_brain_id, conversation_id=excluded.conversation_id,
         source_event_id=excluded.source_event_id,
         source_occurred_at=excluded.source_occurred_at,
         source_ingested_sequence=excluded.source_ingested_sequence,
         extraction_run_id=excluded.extraction_run_id,
         memory_version=memory_projection_checkpoints.memory_version+1,
         updated_at=excluded.updated_at
       where excluded.source_ingested_sequence
          >memory_projection_checkpoints.source_ingested_sequence`,
      [key, input.scope, input.accountId ?? null, input.nodeBrainId ?? null,
        input.conversationId ?? null, input.sourceEventId, lead.occurred_at,
        lead.ingested_sequence, runId, completedAt],
    );
    const updated = await transaction.one<CheckpointRow>(
      `select source_event_id::text,source_occurred_at,source_ingested_sequence::text
       from memory_projection_checkpoints where projection_key=$1`,
      [key],
    );
    const outbox = await transaction.query(
      `update transactional_outbox set status='PUBLISHED',published_at=coalesce(published_at,$2)
       where event_id=any($1::uuid[]) returning id`,
      [eventIds, completedAt],
    );
    if (outbox.length !== eventIds.length) throw new Error("MEMORY_SOURCE_OUTBOX_REQUIRED");
    return Object.freeze({ ...persisted, consolidationEventId: derived.id,
      extractionRunId: runId, highWaterEventId: updated.source_event_id });
  });
}
