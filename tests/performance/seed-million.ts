import { appendEvent } from "../../lib/server/events/store";
import { buildHandoff } from "../../lib/server/handoffs/build";
import { cacheKey } from "../../lib/server/cache/keys";
import { scopedCache, type CacheJson } from "../../lib/server/cache/store";
import type { PerformanceRecallFixture } from "../../lib/server/observability/metrics";
import { createMemoryWorkerContext, processMemoryEvent } from "../../worker/consolidation/process-event";
import { createConversationFixture } from "../helpers/postgres";

const FIXTURE_VERSION = "performance-million-v1";
const EMBEDDING_VERSION = "performance-embedding-v1";
const VERSIONS = Object.freeze({
  embeddingVersion: EMBEDDING_VERSION,
  extractorVersion: "performance-extractor-v1",
  modelVersion: "deterministic-performance-fixture-v1",
  promptVersion: "performance-prompt-v1",
});

function reportMillionFixturePhase(phase: string): void {
  if (process.env.GUSTAVO_RUN_MILLION_BENCHMARK === "1") {
    console.info("T34_MILLION_FIXTURE_PHASE", phase);
  }
}

async function projectFact(input: {
  readonly fixture: Awaited<ReturnType<typeof createConversationFixture>>;
  readonly label: string;
  readonly text: string;
  readonly sourceAt: string;
  readonly observedAt: string;
  readonly validTo?: string;
  readonly conflictState?: "CURRENT" | "SUPERSEDED";
  readonly supersedesMemoryId?: string;
}) {
  const source = await appendEvent(input.fixture.db, {
    aggregateId: input.fixture.conversationId,
    accountId: input.fixture.accountId,
    actor: { type: "USER", id: input.fixture.accountId },
    type: "participant.message.created",
    visibility: "PRIVATE_ACCOUNT",
    body: { text: input.text },
    occurredAt: new Date(input.sourceAt),
    idempotencyKey: `${FIXTURE_VERSION}:${input.label}:source`,
    policyVersion: "performance-policy-v1",
  });
  const projected = await processMemoryEvent(createMemoryWorkerContext(input.fixture.db), {
    scope: "PRIVATE_ACCOUNT",
    accountId: input.fixture.accountId,
    nodeBrainId: input.fixture.nodeBrainId,
    conversationId: input.fixture.conversationId,
    sourceEventId: source.id,
    events: [{ id: source.id, at: input.sourceAt, text: input.text }],
    extracted: { facts: [{
      text: input.text,
      sourceIds: [source.id],
      keywords: ["benchmark", "known-answer", "current", "policy"],
      entities: ["PERF_ENTITY"],
      confidence: 1,
      importance: 1,
      validFrom: input.sourceAt,
      ...(input.validTo ? { validTo: input.validTo } : {}),
      ...(input.conflictState ? { conflictState: input.conflictState } : {}),
      ...(input.supersedesMemoryId ? {
        supersedesMemoryId: input.supersedesMemoryId,
        correctionState: "USER_CORRECTED" as const,
      } : {}),
    }] },
    versions: VERSIONS,
    observedAt: input.observedAt,
    idempotencyKey: `${FIXTURE_VERSION}:${input.label}:projection`,
  });
  return Object.freeze({ source, memory: projected.memories[0]! });
}

async function seedSourceVolume(
  fixture: Awaited<ReturnType<typeof createConversationFixture>>,
  sourceEventCount: number,
): Promise<void> {
  await fixture.db.query(
    `insert into events (
       id,aggregate_id,account_id,actor_type,actor_id,type,visibility,occurred_at,
       causation_id,correlation_id,prompt_version,model_version,policy_version,
       idempotency_key,request_hash,integrity_hash
     )
     select (
       substr(digest,1,8)||'-'||substr(digest,9,4)||'-4'||substr(digest,14,3)||
       '-8'||substr(digest,18,3)||'-'||substr(digest,21,12)
     )::uuid,
       'performance-fixture-v1',null,'SYSTEM','performance-fixture',
       'performance.fixture.source','PUBLIC',
       timestamptz '2026-01-01T00:00:00.000Z'+(ordinal||' milliseconds')::interval,
       null,'00000000-0000-4000-8000-000000000034',null,null,'performance-policy-v1',
       $2||':'||ordinal,md5($2||':request:'||ordinal)||md5($2||':request-tail:'||ordinal),
       md5($2||':integrity:'||ordinal)||md5($2||':integrity-tail:'||ordinal)
     from (
       select ordinal,md5($2||':id:'||ordinal) digest from generate_series(1,$1::integer) ordinal
     ) generated
     on conflict (idempotency_key) do nothing`,
    [sourceEventCount, FIXTURE_VERSION],
  );
}

async function seedProjectedVolume(input: {
  readonly fixture: Awaited<ReturnType<typeof createConversationFixture>>;
  readonly projectedMemoryCount: number;
  readonly bodyTemplateMemoryId: string;
}): Promise<void> {
  const runCount = Math.ceil(input.projectedMemoryCount / 400);
  const uuidExpression = (digest: string) => `(
    substr(${digest},1,8)||'-'||substr(${digest},9,4)||'-4'||substr(${digest},14,3)||
    '-8'||substr(${digest},18,3)||'-'||substr(${digest},21,12)
  )::uuid`;
  const runDigest = `md5($2||':projection-run:'||ordinal)`;
  const eventDigest = `md5($2||':projection-event:'||ordinal)`;
  const sourceDigest = `md5($2||':projection-source')`;
  const memoryDigest = `md5($2||':projection-memory:'||ordinal)`;
  const hash64 = (label: string) => (
    `md5($2||':${label}:'||ordinal)||md5($2||':${label}-tail:'||ordinal)`
  );

  await input.fixture.db.transaction(async (database) => {
  await database.query(
    `insert into aggregate_data_keys (
       id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
     ) values (
       ${uuidExpression(`md5($1||':audit-search-key')`)},'memory-retrieval:audit:v1',1,
       decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex')
     ) on conflict (aggregate_id) do nothing`,
    [FIXTURE_VERSION],
  );
  await database.query(
    `insert into aggregate_data_keys (
       id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
     ) values (
       ${uuidExpression(`md5($1||':audit-body-key')`)},'performance-projection-audit-v1',1,
       decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex')
     ) on conflict (aggregate_id) do nothing`,
    [FIXTURE_VERSION],
  );
  await database.query(
    `insert into events (
       id,aggregate_id,account_id,actor_type,actor_id,type,visibility,occurred_at,
       causation_id,correlation_id,prompt_version,model_version,policy_version,
       idempotency_key,request_hash,integrity_hash
     ) values (
       ${uuidExpression(sourceDigest.replaceAll("$2", "$1"))},'performance-projection-audit-v1',null,'SYSTEM',
       'performance-fixture','performance.fixture.source','OPERATOR',
       timestamptz '2025-01-01T00:00:00.000Z',null,
       '00000000-0000-4000-8000-000000000034',null,null,'performance-policy-v1',
       $1||':projection-source',
       md5($1||':projection-source-request')||md5($1||':projection-source-request-tail'),
       md5($1||':projection-source-integrity')||md5($1||':projection-source-integrity-tail')
     )`,
    [FIXTURE_VERSION],
  );
  await database.query(
    `insert into encrypted_event_bodies (
       event_id,aggregate_id,data_key_id,ciphertext,body_iv,body_auth_tag,body_encoding
     ) select ${uuidExpression(sourceDigest.replaceAll("$2", "$1"))},
              'performance-projection-audit-v1',key.id,
              template.ciphertext,template.body_iv,template.body_auth_tag,template.body_encoding
       from aggregate_data_keys key
       cross join lateral (
         select body.ciphertext,body.body_iv,body.body_auth_tag,body.body_encoding
         from memory_records memory join encrypted_event_bodies body on body.event_id=memory.body_event_id
         where memory.id=$2::uuid
       ) template where key.aggregate_id='performance-projection-audit-v1'`,
    [FIXTURE_VERSION, input.bodyTemplateMemoryId],
  );
  await database.query(
    `insert into events (
       id,aggregate_id,account_id,actor_type,actor_id,type,visibility,occurred_at,
       causation_id,correlation_id,prompt_version,model_version,policy_version,
       idempotency_key,request_hash,integrity_hash
     ) select ${uuidExpression(eventDigest)},'performance-projection-audit-v1',null,
       'SYSTEM','memory-consolidator','memory.consolidation.completed','OPERATOR',
       timestamptz '2025-01-02T00:00:00.000Z'+(ordinal||' milliseconds')::interval,
       ${uuidExpression(sourceDigest)},'00000000-0000-4000-8000-000000000034',
       'performance-prompt-v1','deterministic-performance-fixture-v1','performance-extractor-v1',
       $2||':projection-event:'||ordinal,
       ${hash64("projection-event-request")},${hash64("projection-event-integrity")}
     from generate_series(1,$1::integer) ordinal`,
    [runCount, FIXTURE_VERSION],
  );
  await database.query(
    `insert into encrypted_event_bodies (
       event_id,aggregate_id,data_key_id,ciphertext,body_iv,body_auth_tag,body_encoding
     ) select ${uuidExpression(eventDigest)},'performance-projection-audit-v1',key.id,
              template.ciphertext,
              template.body_iv,template.body_auth_tag,template.body_encoding
       from generate_series(1,$1::integer) ordinal
       cross join lateral (
         select id from aggregate_data_keys where aggregate_id='performance-projection-audit-v1'
       ) key
       cross join lateral (
         select body.ciphertext,body.body_iv,body.body_auth_tag,body.body_encoding
         from memory_records memory join encrypted_event_bodies body on body.event_id=memory.body_event_id
         where memory.id=$3::uuid
       ) template`,
    [runCount, FIXTURE_VERSION, input.bodyTemplateMemoryId],
  );
  await database.query(
    `insert into memory_extraction_runs (
       id,source_event_id,source_ingested_sequence,consolidation_event_id,scope,
       account_id,node_brain_id,conversation_id,projection_key,operation_key,
       source_from,source_to,prompt_version,model_version,extractor_version,
       embedding_version,idempotency_key,request_digest,memory_count,status,completed_at
     ) select ${uuidExpression(runDigest)},${uuidExpression(sourceDigest)},source.ingested_sequence,
       ${uuidExpression(eventDigest)},'AUDIT_ONLY',null,null,null,
       'audit_only:performance-projection-audit-v1',${hash64("projection-operation")},
       timestamptz '2025-01-01T00:00:00.000Z',timestamptz '2025-01-01T00:00:00.000Z',
       'performance-prompt-v1','deterministic-performance-fixture-v1',
       'performance-extractor-v1','performance-embedding-v1',
       $2||':projection-run:'||ordinal,${hash64("projection-request")},
       least(400,$3::integer-((ordinal-1)*400)),'COMPLETED',
       timestamptz '2025-01-02T00:00:00.000Z'+(ordinal||' milliseconds')::interval
     from generate_series(1,$1::integer) ordinal
     cross join lateral (
       select ingested_sequence from events where id=${uuidExpression(sourceDigest)}
     ) source`,
    [runCount, FIXTURE_VERSION, input.projectedMemoryCount],
  );
  await database.query(
    `insert into memory_records (
       id,extraction_run_id,body_event_id,ordinal,source_count,type,scope,account_id,node_brain_id,
       conversation_id,search_key_id,content_digest,equivalence_digest,keywords_digest,
       entities_digest,keyword_index_digests,entity_index_digests,public_keyword_terms,
       public_entity_terms,keyword_count,entity_count,has_embedding,embedding_digest,
       embedding_dimension,search_embedding_manifest,source_from,source_to,confidence,
       importance,freshness,prompt_version,model_version,extractor_version,embedding_version,
       valid_from,valid_to,supersedes_memory_id,conflict_state,correction_state,
       procedure_version,goal_status,created_at
     ) select ${uuidExpression(memoryDigest)},${uuidExpression(`md5($2||':projection-run:'||(((ordinal-1)/400)+1))`)},
       ${uuidExpression(`md5($2||':projection-event:'||(((ordinal-1)/400)+1))`)},
       ((ordinal-1)%400)::integer,1,'SEMANTIC','AUDIT_ONLY',null,null,null,
       template.search_key_id,${hash64("projection-content")},${hash64("projection-equivalence")},
       ${hash64("projection-keywords")},${hash64("projection-entities")},
       array[(${hash64("projection-term")})::char(64)],array[]::char(64)[],null,null,1,0,
       false,null,0,null,timestamptz '2025-01-01T00:00:00.000Z',
       timestamptz '2025-01-01T00:00:00.000Z',0.5,0.01,0.01,
       'performance-prompt-v1','deterministic-performance-fixture-v1',
       'performance-extractor-v1','performance-embedding-v1',
       timestamptz '2025-01-01T00:00:00.000Z',null,null,'CURRENT','NONE',null,null,
       timestamptz '2025-01-02T00:00:00.000Z'
         +((((ordinal-1)/400)+1)||' milliseconds')::interval
     from generate_series(1,$1::integer) ordinal
     cross join lateral (
       select id search_key_id from aggregate_data_keys
       where aggregate_id='memory-retrieval:audit:v1'
     ) template`,
    [input.projectedMemoryCount, FIXTURE_VERSION],
  );
  await database.query(
    `insert into memory_sources (memory_id,ordinal,source_event_id,source_ingested_sequence,source_at)
     select ${uuidExpression(memoryDigest)},0,${uuidExpression(sourceDigest)},
            source.ingested_sequence,source.occurred_at
     from generate_series(1,$1::integer) ordinal
     cross join lateral (
       select ingested_sequence,occurred_at from events where id=${uuidExpression(sourceDigest)}
     ) source`,
    [input.projectedMemoryCount, FIXTURE_VERSION],
  );
  await database.query(
    `insert into memory_semantic_facts (memory_id,fact_digest)
     select ${uuidExpression(memoryDigest)},${hash64("projection-content")}
     from generate_series(1,$1::integer) ordinal`,
    [input.projectedMemoryCount, FIXTURE_VERSION],
  );
  await database.query(
    `insert into memory_index_terms (
       memory_id,ordinal,kind,scope,account_id,node_brain_id,conversation_id,search_key_id,
       term_text,term_digest,set_digest,prompt_version,model_version,extractor_version
     ) select ${uuidExpression(memoryDigest)},0,'KEYWORD','AUDIT_ONLY',null,null,null,
       template.search_key_id,null,${hash64("projection-term")},${hash64("projection-keywords")},
       'performance-prompt-v1','deterministic-performance-fixture-v1','performance-extractor-v1'
     from generate_series(1,$1::integer) ordinal
     cross join lateral (
       select id search_key_id from aggregate_data_keys
       where aggregate_id='memory-retrieval:audit:v1'
     ) template`,
    [input.projectedMemoryCount, FIXTURE_VERSION],
  );
  await database.query(
    `insert into memory_retrieval_stats (memory_id)
     select ${uuidExpression(memoryDigest)} from generate_series(1,$1::integer) ordinal`,
    [input.projectedMemoryCount, FIXTURE_VERSION],
  );
  await database.query(
    `insert into memory_equivalence_sets (
       id,scope,account_id,node_brain_id,conversation_id,type,equivalence_digest,
       canonical_memory_id,created_at
     ) select ${uuidExpression(`md5($2||':projection-equivalence-set:'||ordinal)`)},
       'AUDIT_ONLY',null,null,null,'SEMANTIC',${hash64("projection-equivalence")},
       ${uuidExpression(memoryDigest)},
       timestamptz '2025-01-02T00:00:00.000Z'
         +((((ordinal-1)/400)+1)||' milliseconds')::interval
     from generate_series(1,$1::integer) ordinal`,
    [input.projectedMemoryCount, FIXTURE_VERSION],
  );
  await database.query(
    `insert into transactional_outbox (
       id,event_id,topic,payload,status,attempts,available_at,published_at,created_at
     ) select ${uuidExpression(`md5($2||':projection-outbox:'||ordinal)`)},
       ${uuidExpression(eventDigest)},'memory.consolidation.completed','{}'::jsonb,
       'PUBLISHED',1,
       timestamptz '2025-01-02T00:00:00.000Z'+(ordinal||' milliseconds')::interval,
       timestamptz '2025-01-02T00:00:00.000Z'+(ordinal||' milliseconds')::interval,
       timestamptz '2025-01-02T00:00:00.000Z'+(ordinal||' milliseconds')::interval
     from generate_series(1,$1::integer) ordinal`,
    [runCount, FIXTURE_VERSION],
  );
  await database.query(
    `insert into memory_dossier_refreshes (
       extraction_run_id,target_kind,target_key,source_event_id,status,created_at
     ) select ${uuidExpression(runDigest)},'AUDIT','audit_only:performance-projection-audit-v1',
       ${uuidExpression(sourceDigest)},'COMPLETED',
       timestamptz '2025-01-02T00:00:00.000Z'+(ordinal||' milliseconds')::interval
     from generate_series(1,$1::integer) ordinal`,
    [runCount, FIXTURE_VERSION],
  );
  });
}

/**
 * Builds a deterministic, isolated fixture. Set GUSTAVO_RUN_MILLION_BENCHMARK=1
 * through the caller to request the full one-million source-event calibration;
 * ordinary test runs use the same schema and known answers at a smaller volume.
 */
export async function seedMillionMemoryFixture(options: {
  readonly sourceEventCount?: number;
} = {}): Promise<PerformanceRecallFixture> {
  const sourceEventCount = options.sourceEventCount ?? 1_000_000;
  if (!Number.isSafeInteger(sourceEventCount) || sourceEventCount < 1_000
      || sourceEventCount > 1_000_000) {
    throw new Error("PERFORMANCE_FIXTURE_EVENT_COUNT_INVALID");
  }
  const owner = await createConversationFixture("Performance fixture owner");
  const foreign = await createConversationFixture("Performance fixture foreign", owner.db);
  const base = Date.now() - 10_000;
  const oldAt = new Date(base).toISOString();
  const oldObservedAt = new Date(base + 1).toISOString();
  const currentAt = new Date(base + 2).toISOString();
  const currentObservedAt = new Date(base + 3).toISOString();
  const foreignAt = new Date(base + 4).toISOString();

  const old = await projectFact({
    fixture: owner,
    label: "owner-old",
    text: "The benchmark known-answer old policy is superseded.",
    sourceAt: oldAt,
    observedAt: oldObservedAt,
    validTo: currentAt,
    conflictState: "SUPERSEDED",
  });
  const current = await projectFact({
    fixture: owner,
    label: "owner-current",
    text: "The benchmark known-answer current policy requires completed evidence.",
    sourceAt: currentAt,
    observedAt: currentObservedAt,
    supersedesMemoryId: old.memory.id,
  });
  const foreignMemory = await projectFact({
    fixture: foreign,
    label: "foreign-private",
    text: "Foreign private benchmark known-answer must never cross the account boundary.",
    sourceAt: foreignAt,
    observedAt: new Date(base + 5).toISOString(),
  });

  await seedSourceVolume(owner, sourceEventCount);
  reportMillionFixturePhase("source-events-seeded");
  await seedProjectedVolume({
    fixture: owner,
    projectedMemoryCount: sourceEventCount,
    bodyTemplateMemoryId: current.memory.id,
  });
  reportMillionFixturePhase("projected-memories-seeded-and-validated");
  await owner.db.query(
    `analyze events,memory_extraction_runs,memory_records,memory_sources,
       memory_index_terms,memory_embeddings,memory_vector_buckets`,
  );
  reportMillionFixturePhase("tables-analyzed");

  const cache = scopedCache({ processLruEntries: 8, random: () => 0.5 });
  const packet = buildHandoff({
    nodeBrainId: owner.nodeBrainId,
    highWaterMark: String(sourceEventCount),
    memories: [{
      id: current.memory.id,
      scope: "MAIN_SHARED",
      transmitted: true,
      kind: "THESIS",
      text: "Completed evidence remains the current benchmark thesis.",
      sourceIds: [current.source.id],
      version: "1",
    }],
  });
  const handoffKey = cacheKey({
    namespace: "handoff",
    scope: "SHARED",
    entityId: "performance-handoff",
    sourceHighWater: String(sourceEventCount),
    stateVersion: 1,
    policyVersion: "performance-policy-v1",
    schemaVersion: 1,
  });
  await cache.set(handoffKey, packet as unknown as CacheJson, { ttlSeconds: 600 });
  let cleaned = false;
  return Object.freeze({
    db: owner.db,
    accountId: owner.accountId,
    sourceEventCountFloor: sourceEventCount,
    projectedMemoryCountFloor: sourceEventCount,
    knownAnswerMemoryId: current.memory.id,
    supersededMemoryId: old.memory.id,
    foreignMemoryId: foreignMemory.memory.id,
    temporalFrom: currentAt,
    temporalTo: new Date(base + 60_000).toISOString(),
    readCachedHandoff: () => cache.get(handoffKey),
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      cache.destroy();
      // The test PostgreSQL helper owns and drops this isolated schema in its
      // registered afterAll cleanup, including failure paths.
    },
  });
}
