import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { consolidateEvents } from "../../lib/server/consolidation/consolidate";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import { canonicalContentDigest, canonicalJson } from "../../lib/server/events/integrity";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  createMemoryWorkerContext,
  deriveMemorySearchTermDigest,
  rankAuthorizedMemoryEmbeddings,
  processMemoryEvent,
} from "../../worker/consolidation/process-event";
import { testContext, type TestDatabase } from "../helpers/postgres";

const VERSIONS = Object.freeze({
  promptVersion: "memory-prompt-v1",
  modelVersion: "deterministic-test-provider-v1",
  extractorVersion: "memory-extractor-v1",
  embeddingVersion: "memory-embedding-v1",
});

function pureInput() {
  return {
    scope: "PRIVATE_ACCOUNT" as const,
    accountId: "acct-1",
    nodeBrainId: "node-1",
    conversationId: "conversation-1",
    events: [
      { id: "e1", at: "2026-08-09T10:00:00.000Z", text: "My preferred ticker is AAPL." },
      { id: "e2", at: "2026-08-09T10:01:00.000Z", text: "We still need to compare the completed close." },
    ],
    extracted: {
      facts: [{
        text: "Preferred ticker is AAPL", sourceIds: ["e1"], confidence: 0.98,
        importance: 0.8, keywords: ["preference", "AAPL"], entities: ["AAPL"],
        embedding: [0.125, -0.5, 0.75],
      }],
      procedures: [{ text: "Compare completed closes", sourceIds: ["e2"], confidence: 0.91 }],
      goals: [{ text: "Compare the completed close", sourceIds: ["e2"], status: "OPEN" as const }],
      episodes: [{
        text: "Preference and open market question", sourceIds: ["e1", "e2"],
        keywords: ["preference", "completed close"], entities: ["AAPL"],
      }],
    },
    versions: VERSIONS,
    observedAt: "2026-08-09T10:02:00.000Z",
  };
}

async function seedPrivateSource(db: TestDatabase, label: string) {
  const accountId = randomUUID();
  const nodeBrainId = randomUUID();
  const conversationId = randomUUID();
  await db.query("insert into accounts (id,display_name) values ($1,$2)",
    [accountId, `Account ${label}`]);
  await db.query("insert into node_brains (id,account_id,name) values ($1,$2,$3)",
    [nodeBrainId, accountId, `Node ${label}`]);
  await db.query("insert into conversations (id,account_id,node_brain_id) values ($1,$2,$3)",
    [conversationId, accountId, nodeBrainId]);
  const first = await appendEvent(db, {
    aggregateId: conversationId,
    accountId,
    actor: { type: "USER", id: accountId },
    type: "message.completed",
    visibility: "PRIVATE_ACCOUNT",
    body: { text: "My preferred ticker is AAPL." },
    occurredAt: new Date("2026-08-09T10:00:00.000Z"),
    idempotencyKey: `memory-source:${label}:1`,
  });
  const second = await appendEvent(db, {
    aggregateId: conversationId,
    accountId,
    actor: { type: "NODE_BRAIN", id: nodeBrainId },
    type: "node.response.completed",
    visibility: "PRIVATE_ACCOUNT",
    body: { text: "We still need to compare the completed close." },
    occurredAt: new Date("2026-08-09T10:01:00.000Z"),
    idempotencyKey: `memory-source:${label}:2`,
  });
  return { accountId, nodeBrainId, conversationId, first, second };
}

async function appendPrivateSource(
  db: TestDatabase,
  fixture: Awaited<ReturnType<typeof seedPrivateSource>>,
  label: string,
  text: string,
  occurredAt: string,
  actor: "USER" | "NODE" = "USER",
) {
  return appendEvent(db, {
    aggregateId: fixture.conversationId,
    accountId: fixture.accountId,
    actor: actor === "USER"
      ? { type: "USER", id: fixture.accountId }
      : { type: "NODE_BRAIN", id: fixture.nodeBrainId },
    type: actor === "USER" ? "message.completed" : "node.response.completed",
    visibility: "PRIVATE_ACCOUNT",
    body: { text },
    occurredAt: new Date(occurredAt),
    idempotencyKey: `memory-source:${label}`,
  });
}

function workerInput(fixture: Awaited<ReturnType<typeof seedPrivateSource>>, label: string) {
  const extracted = pureInput().extracted;
  return {
    scope: "PRIVATE_ACCOUNT" as const,
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventId: fixture.second.id,
    events: [
      { id: fixture.first.id, at: fixture.first.occurredAt.toISOString(), text: "My preferred ticker is AAPL." },
      { id: fixture.second.id, at: fixture.second.occurredAt.toISOString(), text: "We still need to compare the completed close." },
    ],
    extracted: {
      facts: extracted.facts.map((fact) => ({ ...fact, sourceIds: [fixture.first.id] })),
      procedures: extracted.procedures.map((procedure) => ({
        ...procedure, sourceIds: [fixture.second.id],
      })),
      goals: extracted.goals.map((goal) => ({ ...goal, sourceIds: [fixture.second.id] })),
      episodes: extracted.episodes.map((episode) => ({
        ...episode, sourceIds: [fixture.first.id, fixture.second.id],
      })),
    },
    versions: VERSIONS,
    observedAt: "2026-08-09T10:02:00.000Z",
    idempotencyKey: `memory-consolidation:${label}`,
  };
}

function gatedTransactions(
  db: TestDatabase,
  gate: (sql: string, run: () => Promise<Record<string, unknown>[]>) => Promise<Record<string, unknown>[]>,
): EventDatabase {
  return {
    query: (sql, parameters) => db.query(sql, parameters),
    one: (sql, parameters) => db.one(sql, parameters),
    transaction: (work) => db.transaction((transaction) => work({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => gate(
        sql, () => transaction.query<Record<string, unknown>>(sql, parameters),
      ) as Promise<Row[]>,
      one: (sql, parameters) => transaction.one(sql, parameters),
      transaction: (nested) => nested(transaction),
    })),
  };
}

describe("memory consolidation", () => {
  it("creates complete source-linked typed projections without replacing source messages", () => {
    const result = consolidateEvents(pureInput());
    expect(result.memories.map((memory) => memory.type)).toEqual([
      "SEMANTIC", "PROCEDURAL", "GOAL", "EPISODIC",
    ]);
    expect(result.memories.every((memory) => memory.sourceIds.length > 0)).toBe(true);
    expect(result.memories.every((memory) => memory.sourceFrom <= memory.sourceTo)).toBe(true);
    expect(result.memories.every((memory) => memory.contentDigest.length > 0)).toBe(true);
    expect(result.memories[0].keywords).toEqual(["aapl", "preference"]);
    expect(result.memories[0].entities).toEqual(["aapl"]);
    expect(result.memories[0].embedding).toEqual([0.125, -0.5, 0.75]);
    expect(result.memories.every((memory) => (
      memory.promptVersion === VERSIONS.promptVersion
      && memory.modelVersion === VERSIONS.modelVersion
      && memory.extractorVersion === VERSIONS.extractorVersion
      && memory.embeddingVersion === VERSIONS.embeddingVersion
    ))).toBe(true);
    expect(result.deletedSourceEventIds).toEqual([]);
  });

  it("validates extraction output, exact source membership, time, and idle episode boundaries", () => {
    expect(() => consolidateEvents({
      ...pureInput(),
      extracted: {
        ...pureInput().extracted,
        facts: [{ text: "Unsupported", sourceIds: ["missing"], confidence: 0.8 }],
      },
    })).toThrow("MEMORY_SOURCE_NOT_IN_BATCH");
    expect(() => consolidateEvents({
      ...pureInput(),
      observedAt: "2026-08-09T11:01:00.000Z",
      events: [
        pureInput().events[0],
        { ...pureInput().events[1], at: "2026-08-09T11:00:00.000Z" },
      ],
    })).toThrow("EPISODE_SPANS_IDLE_BOUNDARY");
    expect(() => consolidateEvents({
      ...pureInput(),
      events: [{ ...pureInput().events[0], at: "not-a-time" }, pureInput().events[1]],
    })).toThrow("INVALID_MEMORY_EVENT_AT");
    expect(() => consolidateEvents({
      ...pureInput(),
      extracted: {
        ...pureInput().extracted,
        goals: [{ text: "Invalid", sourceIds: ["e2"], status: "DONE" as "OPEN" }],
      },
    })).toThrow("INVALID_MEMORY_GOAL_STATUS");
    expect(() => consolidateEvents({
      ...pureInput(), observedAt: "2026-08-09T06:02:00-04:00",
    })).toThrow("INVALID_MEMORY_OBSERVED_AT");
    expect(() => consolidateEvents({
      ...pureInput(), events: [{ ...pureInput().events[0], at: "2026-02-30T10:00:00Z" }, pureInput().events[1]],
    })).toThrow("INVALID_MEMORY_EVENT_AT");
    expect(() => consolidateEvents({
      ...pureInput(),
      extracted: {
        ...pureInput().extracted,
        facts: [{ ...pureInput().extracted.facts[0], validFrom: "2026-08-09T10:00:00.1234Z" }],
      },
    })).toThrow("INVALID_MEMORY_VALID_FROM");
    expect(consolidateEvents({
      ...pureInput(), observedAt: "2026-08-09T10:02:00Z",
    }).sourceTo).toBe("2026-08-09T10:01:00.000Z");
  });

  it("rejects proxies, accessors, cycles, sparse arrays, and oversized batches without invoking them", () => {
    let trapTouched = false;
    const proxied = new Proxy(pureInput(), {
      get() {
        trapTouched = true;
        throw new Error("HOSTILE_PROXY_EXECUTED");
      },
    });
    expect(() => consolidateEvents(proxied)).toThrow("MEMORY_INPUT_PROXY_FORBIDDEN");
    expect(trapTouched).toBe(false);

    const accessor = { ...pureInput() } as Record<string, unknown>;
    Object.defineProperty(accessor, "events", {
      enumerable: true,
      get() {
        trapTouched = true;
        return pureInput().events;
      },
    });
    expect(() => consolidateEvents(accessor as unknown as ReturnType<typeof pureInput>))
      .toThrow("MEMORY_INPUT_ACCESSOR_FORBIDDEN");
    expect(trapTouched).toBe(false);

    const cyclic = { ...pureInput(), extra: null as unknown };
    cyclic.extra = cyclic;
    expect(() => consolidateEvents(cyclic)).toThrow("MEMORY_INPUT_CYCLE_FORBIDDEN");
    const sparse = new Array<ReturnType<typeof pureInput>["events"][number]>(2);
    sparse[0] = pureInput().events[0];
    expect(() => consolidateEvents({ ...pureInput(), events: sparse }))
      .toThrow("MEMORY_INPUT_ACCESSOR_FORBIDDEN");
    expect(() => consolidateEvents({
      ...pureInput(),
      events: Array.from({ length: 501 }, (_, index) => ({
        id: `e-${index}`, at: "2026-08-09T10:00:00.000Z", text: "bounded",
      })),
    })).toThrow("INVALID_MEMORY_EVENT_BATCH");
  });

  it("merges compatible duplicate candidates deterministically and rejects conflicting duplicates", () => {
    const input = pureInput();
    const merged = consolidateEvents({
      ...input,
      extracted: {
        facts: [
          { ...input.extracted.facts[0], sourceIds: ["e1"], confidence: 0.9,
            keywords: ["AAPL"], entities: ["AAPL"] },
          { ...input.extracted.facts[0], sourceIds: ["e2"], confidence: 0.98,
            keywords: ["preference"], entities: ["Apple"], importance: 0.9 },
        ],
        procedures: [], goals: [], episodes: [],
      },
    });
    expect(merged.memories).toHaveLength(1);
    expect(merged.memories[0]).toMatchObject({
      type: "SEMANTIC", sourceIds: ["e1", "e2"], confidence: 0.98, importance: 0.9,
      keywords: ["aapl", "preference"], entities: ["aapl", "apple"],
      embedding: [0.125, -0.5, 0.75],
    });
    expect(() => consolidateEvents({
      ...input,
      extracted: {
        facts: [
          input.extracted.facts[0],
          { ...input.extracted.facts[0], sourceIds: ["e2"], embedding: [0.1, 0.2] },
        ],
        procedures: [], goals: [], episodes: [],
      },
    })).toThrow("MEMORY_DUPLICATE_METADATA_CONFLICT");
  });

  it("bounds merged term unions and rejects empty or PostgreSQL-real-overflow embeddings", () => {
    const input = pureInput();
    const duplicate = (overrides: Record<string, unknown>) => ({
      ...input.extracted.facts[0], ...overrides,
    });
    expect(() => consolidateEvents({
      ...input,
      extracted: { facts: [
        duplicate({ sourceIds: ["e1"], keywords: Array.from({ length: 100 }, (_, index) => `k-${index}`) }),
        duplicate({ sourceIds: ["e2"], keywords: ["k-100"] }),
      ] },
    })).toThrow("INVALID_MEMORY_KEYWORD_UNION");
    expect(() => consolidateEvents({
      ...input,
      extracted: { facts: [
        duplicate({ sourceIds: ["e1"], entities: Array.from({ length: 100 }, (_, index) => `e-${index}`) }),
        duplicate({ sourceIds: ["e2"], entities: ["e-100"] }),
      ] },
    })).toThrow("INVALID_MEMORY_ENTITY_UNION");
    expect(() => consolidateEvents({
      ...input, extracted: { facts: [duplicate({ embedding: [] })] },
    })).toThrow("INVALID_MEMORY_EMBEDDING");
    expect(() => consolidateEvents({
      ...input, extracted: { facts: [duplicate({ embedding: [Number.MAX_VALUE] })] },
    })).toThrow("INVALID_MEMORY_EMBEDDING");
  });

  it("persists encrypted content, typed rows, extraction provenance, embeddings, and high-water atomically", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "atomic");
    const result = await processMemoryEvent(createMemoryWorkerContext(db), workerInput(fixture, "atomic"));
    expect(result.memories).toHaveLength(4);

    const counts = await db.one<{
      records: number; sources: number; semantic: number; procedures: number;
      goals: number; episodes: number; embeddings: number; runs: number;
      index_terms: number; checkpoints: number; source_events: number;
    }>(
      `select
         (select count(*)::int from memory_records) records,
         (select count(*)::int from memory_sources) sources,
         (select count(*)::int from memory_semantic_facts) semantic,
         (select count(*)::int from memory_procedures) procedures,
         (select count(*)::int from memory_goals) goals,
         (select count(*)::int from memory_episodes) episodes,
         (select count(*)::int from memory_embeddings) embeddings,
         (select count(*)::int from memory_index_terms) index_terms,
         (select count(*)::int from memory_extraction_runs) runs,
         (select count(*)::int from memory_projection_checkpoints) checkpoints,
         (select count(*)::int from events where id=any($1::uuid[])) source_events`,
      [[fixture.first.id, fixture.second.id]],
    );
    expect(counts).toEqual({
      records: 4, sources: 5, semantic: 1, procedures: 1, goals: 1,
      episodes: 1, embeddings: 0, index_terms: 6, runs: 1, checkpoints: 1, source_events: 2,
    });

    const rows = await db.query<{
      content_digest: string; body_event_id: string; body_key_id: string | null;
      account_id: string; node_brain_id: string; conversation_id: string;
      scope: string; source_from: Date; source_to: Date; conflict_state: string;
    }>(
      `select memory.content_digest, memory.body_event_id::text, body.data_key_id::text body_key_id,
              memory.account_id::text, memory.node_brain_id::text, memory.conversation_id::text,
              memory.scope, memory.source_from, memory.source_to, memory.conflict_state
       from memory_records memory
       join encrypted_event_bodies body on body.event_id=memory.body_event_id
       order by memory.ordinal`,
    );
    expect(rows.every((row) => row.body_key_id !== null)).toBe(true);
    expect(rows.every((row) => row.account_id === fixture.accountId)).toBe(true);
    expect(rows.every((row) => row.node_brain_id === fixture.nodeBrainId)).toBe(true);
    expect(rows.every((row) => row.conversation_id === fixture.conversationId)).toBe(true);
    expect(rows.every((row) => row.scope === "PRIVATE_ACCOUNT")).toBe(true);
    expect(rows.every((row) => row.conflict_state === "CURRENT")).toBe(true);
    const body = await readEventBody(db, result.consolidationEventId, { actor: { role: "SYSTEM" } });
    expect(JSON.stringify(body)).toContain("Preferred ticker is AAPL");
    expect(JSON.stringify(body)).toContain('"keywords":["aapl","preference"]');
    expect(JSON.stringify(body)).toContain('"embedding":[0.125,-0.5,0.75]');
    expect(await db.one<{ protected_plaintext: number }>(
      `select
         (select count(*)::int from memory_index_terms where term_text is not null) protected_plaintext`,
    )).toEqual({ protected_plaintext: 0 });
    const plaintextRows = await db.query<{ plaintext: string | null }>(
      `select to_jsonb(memory)::text plaintext from memory_records memory
       where to_jsonb(memory)::text like '%Preferred ticker is AAPL%'`,
    );
    expect(plaintextRows).toEqual([]);
  }, 20_000);

  it("is deterministic and idempotent under exact replay and concurrency, but rejects key reuse", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "idempotency");
    const input = workerInput(fixture, "idempotency");
    const [left, right] = await Promise.all([
      processMemoryEvent(createMemoryWorkerContext(db), input),
      processMemoryEvent(createMemoryWorkerContext(db), input),
    ]);
    expect(right).toEqual(left);
    expect(await processMemoryEvent(createMemoryWorkerContext(db), input)).toEqual(left);
    expect(await db.one<{ records: number; runs: number }>(
      `select (select count(*)::int from memory_records) records,
              (select count(*)::int from memory_extraction_runs) runs`,
    )).toEqual({ records: 4, runs: 1 });
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...input,
      extracted: { ...input.extracted, facts: [{ ...input.extracted.facts[0], text: "Changed" }] },
    })).rejects.toThrow("MEMORY_IDEMPOTENCY_KEY_REUSED");
  });

  it("deduplicates one source operation even when concurrent callers supply different keys", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "operation-key");
    const first = workerInput(fixture, "operation-key-a");
    const second = { ...first, idempotencyKey: "memory-consolidation:operation-key-b" };
    const [left, right] = await Promise.all([
      processMemoryEvent(createMemoryWorkerContext(db), first),
      processMemoryEvent(createMemoryWorkerContext(db), second),
    ]);
    expect(right).toEqual(left);
    expect(await db.one<{ runs: number; records: number }>(
      `select (select count(*)::int from memory_extraction_runs) runs,
              (select count(*)::int from memory_records) records`,
    )).toEqual({ runs: 1, records: 4 });
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...first,
      idempotencyKey: "memory-consolidation:operation-key-c",
      extracted: { ...first.extracted, facts: [{ ...first.extracted.facts[0], text: "Changed" }] },
    })).rejects.toThrow("MEMORY_OPERATION_PAYLOAD_CONFLICT");
  });

  it("creates a new versioned extraction when prompt or model provenance changes", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "versioned-extraction");
    const first = workerInput(fixture, "versioned-extraction-v1");
    const versionOne = await processMemoryEvent(createMemoryWorkerContext(db), first);
    const versionTwo = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...first,
      idempotencyKey: "memory-consolidation:versioned-extraction-v2",
      versions: {
        ...first.versions,
        promptVersion: "memory-prompt-v2",
        modelVersion: "deterministic-test-provider-v2",
      },
    });
    expect(versionTwo.extractionRunId).not.toBe(versionOne.extractionRunId);
    expect(await db.one<{ runs: number }>("select count(*)::int runs from memory_extraction_runs"))
      .toEqual({ runs: 2 });
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...first,
      events: [first.events[1]],
      extracted: { facts: [{
        ...first.extracted.facts[0], sourceIds: [fixture.second.id],
      }], procedures: [], goals: [], episodes: [] },
      versions: { ...first.versions, promptVersion: "memory-prompt-v3" },
      idempotencyKey: "memory-consolidation:versioned-extraction-v3-incomplete",
    })).rejects.toThrow("MEMORY_VERSION_REEXTRACTION_REQUIRES_FULL_BATCH");
  });

  it("links exact typed content across later sources in the continuous native conversation", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "cross-source-equivalence");
    const initial = await processMemoryEvent(
      createMemoryWorkerContext(db), workerInput(fixture, "cross-source-equivalence-initial"),
    );
    const initialFact = initial.memories.find((memory) => memory.type === "SEMANTIC")!;
    const later = await appendPrivateSource(
      db, fixture, "cross-source-equivalence:later",
      "I still prefer AAPL.", "2026-08-09T10:03:00.000Z",
    );
    const laterResult = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...workerInput(fixture, "cross-source-equivalence-later"),
      sourceEventId: later.id,
      events: [{ id: later.id, at: later.occurredAt.toISOString(), text: "I still prefer AAPL." }],
      extracted: { facts: [{
        text: "Preferred ticker is AAPL", sourceIds: [later.id], confidence: 0.99,
      }], procedures: [], goals: [], episodes: [] },
      observedAt: "2026-08-09T10:04:00.000Z",
    });
    expect(await db.one<{ equivalent_memory_id: string }>(
      "select equivalent_memory_id::text from memory_equivalence_links where memory_id=$1",
      [laterResult.memories[0].id],
    )).toEqual({ equivalent_memory_id: initialFact.id });

    expect(await db.one<{ links: number }>(
      "select count(*)::int links from memory_equivalence_links",
    )).toEqual({ links: 1 });
  });

  it("uses stable erasable scoped terms and authorization-first in-memory vector ranking", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "scoped-search");
    const first = workerInput(fixture, "scoped-search-v1");
    const firstResult = await processMemoryEvent(createMemoryWorkerContext(db), first);
    await processMemoryEvent(createMemoryWorkerContext(db), {
      ...first,
      versions: { ...first.versions, promptVersion: "memory-prompt-v2" },
      idempotencyKey: "memory-consolidation:scoped-search-v2",
    });
    const stored = await db.query<{ term_digest: string }>(
      `select term.term_digest
       from memory_index_terms term
       join memory_records memory on memory.id=term.memory_id
       where memory.type='SEMANTIC' and term.kind='KEYWORD' and term.ordinal=0
       order by memory.created_at,memory.id`,
    );
    expect(stored).toHaveLength(2);
    expect(stored[1].term_digest).toBe(stored[0].term_digest);
    const token = await deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, kind: "KEYWORD", term: "AAPL",
    });
    expect(token).toBe(stored[0].term_digest);
    const semanticId = firstResult.memories.find((memory) => memory.type === "SEMANTIC")!.id;
    expect(await db.one<{ embeddings: number; manifest: number }>(
      `select (select count(*)::int from memory_embeddings) embeddings,
              (select count(*)::int from memory_records
               where search_embedding_manifest is not null) manifest`,
    )).toEqual({ embeddings: 0, manifest: 0 });
    expect(await rankAuthorizedMemoryEmbeddings(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, candidateIds: [semanticId],
      embeddingVersion: VERSIONS.embeddingVersion,
      queryVector: [0.125, -0.5, 0.75], limit: 5,
    })).toEqual([{ memoryId: semanticId, similarity: 1 }]);

    const other = await seedPrivateSource(db, "scoped-search-other");
    await processMemoryEvent(createMemoryWorkerContext(db), workerInput(other, "scoped-search-other"));
    const otherToken = await deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: other.accountId, nodeBrainId: other.nodeBrainId,
      conversationId: other.conversationId, kind: "KEYWORD", term: "AAPL",
    });
    expect(otherToken).not.toBe(token);
    expect(await db.query<{ search_embedding: number[] }>(
      "select search_embedding from memory_embeddings",
    )).toEqual([]);
    await db.query("delete from aggregate_data_keys where aggregate_id=$1", [other.conversationId]);
    await expect(rankAuthorizedMemoryEmbeddings(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: other.accountId, nodeBrainId: other.nodeBrainId,
      conversationId: other.conversationId, candidateIds: [semanticId],
      embeddingVersion: VERSIONS.embeddingVersion,
      queryVector: [0.125, -0.5, 0.75],
    })).rejects.toThrow("MEMORY_VECTOR_CANDIDATE_AUTHORITY_MISMATCH");
    const otherEmbeddingVersion = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...first,
      versions: { ...first.versions, embeddingVersion: "memory-embedding-v2" },
      idempotencyKey: "memory-consolidation:scoped-search-embedding-v2",
    });
    const otherVersionSemantic = otherEmbeddingVersion.memories
      .find((memory) => memory.type === "SEMANTIC")!.id;
    await expect(rankAuthorizedMemoryEmbeddings(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      candidateIds: [semanticId, otherVersionSemantic], embeddingVersion: VERSIONS.embeddingVersion,
      queryVector: [0.125, -0.5, 0.75],
    })).rejects.toThrow("MEMORY_VECTOR_CANDIDATE_AUTHORITY_MISMATCH");
    await db.query("delete from aggregate_data_keys where aggregate_id=$1", [fixture.conversationId]);
    await expect(deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, kind: "KEYWORD", term: "AAPL",
    })).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
    await expect(rankAuthorizedMemoryEmbeddings(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, candidateIds: [semanticId],
      embeddingVersion: VERSIONS.embeddingVersion,
      queryVector: [0.125, -0.5, 0.75],
    })).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
    await expect(rankAuthorizedMemoryEmbeddings(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      candidateIds: Array.from({ length: 101 }, () => randomUUID()),
      embeddingVersion: VERSIONS.embeddingVersion,
      queryVector: [1],
    })).rejects.toThrow("MEMORY_VECTOR_CANDIDATE_LIMIT");
  });

  it("ranks one hundred protected candidates from one encrypted body in bounded query groups", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "vector-batch");
    const input = workerInput(fixture, "vector-batch");
    const processed = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...input,
      extracted: {
        facts: Array.from({ length: 100 }, (_, index) => ({
          text: `Vector fact ${index}`, sourceIds: [fixture.second.id],
          embedding: [1, index + 1], confidence: 0.9,
        })),
        procedures: [], goals: [], episodes: [],
      },
    });
    const queries: string[] = [];
    const counted: EventDatabase = {
      query: async (sql, parameters) => {
        queries.push(sql);
        return db.query(sql, parameters);
      },
      one: (sql, parameters) => db.one(sql, parameters),
      transaction: (work) => db.transaction(work),
    };
    const ranked = await rankAuthorizedMemoryEmbeddings(createMemoryWorkerContext(counted), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      candidateIds: processed.memories.map((memory) => memory.id),
      embeddingVersion: VERSIONS.embeddingVersion, queryVector: [1, 1], limit: 100,
    });
    expect(ranked).toHaveLength(100);
    expect(queries).toHaveLength(6);
    expect(queries.filter((sql) => sql.includes("encrypted_event_bodies"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("aggregate_data_keys"))).toHaveLength(1);
  }, 20_000);

  it("gives public projections distinct deterministic IDs across provenance versions", async () => {
    const { db } = await testContext();
    const source = await appendEvent(db, {
      aggregateId: "main-public-memory",
      actor: { type: "MAIN_BRAIN", id: "main-brain" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "AAPL remains inside the completed-close range." },
      occurredAt: new Date("2026-08-09T10:00:00.000Z"),
      idempotencyKey: "memory-source:public-versioning",
    });
    const first = {
      scope: "PUBLIC" as const,
      sourceEventId: source.id,
      events: [{ id: source.id, at: source.occurredAt.toISOString(), text: "AAPL remains inside the completed-close range." }],
      extracted: {
        facts: [{
          text: "AAPL is inside the completed-close range", sourceIds: [source.id], confidence: 0.9,
          keywords: ["AAPL", "completed close"], entities: ["AAPL"], embedding: [0.2, 0.4],
        }],
        procedures: [], goals: [], episodes: [],
      },
      versions: VERSIONS,
      observedAt: "2026-08-09T10:01:00.000Z",
      idempotencyKey: "memory-consolidation:public-versioning-v1",
    };
    const versionOne = await processMemoryEvent(createMemoryWorkerContext(db), first);
    const versionTwo = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...first,
      versions: { ...first.versions, promptVersion: "memory-prompt-v2", modelVersion: "public-model-v2" },
      idempotencyKey: "memory-consolidation:public-versioning-v2",
    });
    expect(versionTwo.extractionRunId).not.toBe(versionOne.extractionRunId);
    expect(versionTwo.memories[0].id).not.toBe(versionOne.memories[0].id);
    expect(await db.one<{ runs: number; records: number }>(
      `select (select count(*)::int from memory_extraction_runs) runs,
              (select count(*)::int from memory_records) records`,
    )).toEqual({ runs: 2, records: 2 });
    expect(await db.query<{ kind: string; term_text: string }>(
      `select kind,term_text from memory_index_terms order by memory_id,kind,ordinal`,
    )).toEqual(expect.arrayContaining([
      { kind: "ENTITY", term_text: "aapl" },
      { kind: "KEYWORD", term_text: "aapl" },
      { kind: "KEYWORD", term_text: "completed close" },
    ]));
    expect(await db.query<{ search_embedding: number[] }>(
      "select search_embedding from memory_embeddings order by memory_id",
    )).toEqual([{ search_embedding: [0.2, 0.4] }, { search_embedding: [0.2, 0.4] }]);
    expect(await db.one<{ links: number }>(
      "select count(*)::int links from memory_equivalence_links",
    )).toEqual({ links: 1 });
    const publicMemory = await db.one<{
      id: string; content_digest: string; keywords_digest: string;
      prompt_version: string; model_version: string; extractor_version: string;
      embedding_version: string; embedding_digest: string;
    }>(
      `select id::text,content_digest,keywords_digest,prompt_version,model_version,
              extractor_version,embedding_version,embedding_digest
       from memory_records order by created_at limit 1`,
    );
    const publicKeyword = await db.one<{ term_digest: string }>(
      `select term_digest from memory_index_terms
       where memory_id=$1 and kind='KEYWORD' order by ordinal limit 1`,
      [publicMemory.id],
    );
    const foreignAggregateSource = await appendEvent(db, {
      aggregateId: "foreign-public-memory", actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published", visibility: "PUBLIC",
      body: { text: "Foreign aggregate at the same instant." },
      occurredAt: new Date("2026-08-09T10:00:00.000Z"),
      idempotencyKey: "memory-source:public-versioning:foreign-aggregate",
    });
    await expect(db.query(
      `insert into memory_sources (
         memory_id,ordinal,source_event_id,source_ingested_sequence,source_at
       ) values ($1,0,$2,(select ingested_sequence from events where id=$2),$3)`,
      [publicMemory.id, foreignAggregateSource.id, foreignAggregateSource.occurredAt],
    )).rejects.toThrow("MEMORY_SOURCE_AGGREGATE_MISMATCH");
    await expect(db.query(
      `insert into memory_index_terms (
         memory_id,ordinal,kind,scope,account_id,node_brain_id,conversation_id,
         term_text,term_digest,set_digest,prompt_version,model_version,extractor_version
       ) values ($1,0,'KEYWORD','PUBLIC',null,null,null,'forged-public-term',$2,$3,$4,$5,$6)`,
      [publicMemory.id, publicKeyword.term_digest, publicMemory.keywords_digest,
        publicMemory.prompt_version, publicMemory.model_version, publicMemory.extractor_version],
    )).rejects.toThrow("MEMORY_INDEX_TOPOLOGY_MISMATCH");
    await expect(db.query(
      `insert into memory_embeddings (
         memory_id,account_id,node_brain_id,conversation_id,scope,embedding_version,
         embedding_digest,dimension,search_embedding
       ) values ($1,null,null,null,'PUBLIC',$2,$3,2,$4)`,
      [publicMemory.id, publicMemory.embedding_version, publicMemory.embedding_digest, [9, 9]],
    )).rejects.toThrow("MEMORY_EMBEDDING_TOPOLOGY_MISMATCH");
    const changed = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...first,
      extracted: { ...first.extracted, facts: [{
        ...first.extracted.facts[0], text: "AAPL moved outside the completed-close range",
      }] },
      versions: { ...first.versions, promptVersion: "memory-prompt-v3", modelVersion: "public-model-v3" },
      idempotencyKey: "memory-consolidation:public-versioning-v3-changed",
    });
    expect(await db.one<{ links: number }>(
      "select count(*)::int links from memory_equivalence_links",
    )).toEqual({ links: 1 });
    await expect(db.query(
      `insert into memory_equivalence_links (memory_id,equivalent_memory_id,created_at)
       values ($1,$2,$3)`,
      [changed.memories[0].id, versionOne.memories[0].id, "2026-08-09T10:03:00.000Z"],
    )).rejects.toThrow("MEMORY_EQUIVALENCE_FOREST_MISMATCH");
  });

  it("extracts a canonical source string from authorized structured Main events", async () => {
    const { db } = await testContext();
    const structuredBody = {
      disposition: "NO_PAPER_TRADE",
      evidenceIds: ["observation-aapl-completed-close"],
      uncertainty: "The active bar remains provisional.",
    };
    const source = await appendEvent(db, {
      aggregateId: "main-shared-memory",
      actor: { type: "MAIN_BRAIN", id: "main-brain" },
      type: "winner.selected",
      visibility: "SHARED",
      body: structuredBody,
      occurredAt: new Date("2026-08-09T10:00:00.000Z"),
      idempotencyKey: "memory-source:structured-main",
    });
    const result = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED",
      sourceEventId: source.id,
      events: [{ id: source.id, at: source.occurredAt.toISOString(), text: canonicalJson(structuredBody) }],
      extracted: {
        facts: [{ text: "Main selected no paper trade", sourceIds: [source.id], confidence: 1 }],
        procedures: [], goals: [], episodes: [],
      },
      versions: VERSIONS,
      observedAt: "2026-08-09T10:01:00.000Z",
      idempotencyKey: "memory-consolidation:structured-main",
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].scope).toBe("MAIN_SHARED");
  });

  it("rejects mixed aggregates before publishing outboxes, checkpointing, or indexing", async () => {
    const { db } = await testContext();
    const first = await appendEvent(db, {
      aggregateId: "public-aggregate-a", actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published", visibility: "PUBLIC", body: { text: "First aggregate." },
      occurredAt: new Date("2026-08-09T12:00:00.000Z"),
      idempotencyKey: "memory-source:mixed-aggregate:a",
    });
    const lead = await appendEvent(db, {
      aggregateId: "public-aggregate-b", actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published", visibility: "PUBLIC", body: { text: "Second aggregate." },
      occurredAt: new Date("2026-08-09T12:01:00.000Z"),
      idempotencyKey: "memory-source:mixed-aggregate:b",
    });
    const keysBefore = await db.query<{ aggregate_id: string; wrapped_key: Buffer }>(
      `select aggregate_id,wrapped_key from aggregate_data_keys
       where aggregate_id=any($1::text[]) order by aggregate_id`,
      [["public-aggregate-a", "public-aggregate-b"]],
    );
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "PUBLIC", sourceEventId: lead.id,
      events: [
        { id: first.id, at: first.occurredAt.toISOString(), text: "First aggregate." },
        { id: lead.id, at: lead.occurredAt.toISOString(), text: "Second aggregate." },
      ],
      extracted: { facts: [{ text: "Second aggregate fact", sourceIds: [lead.id], confidence: 1 }] },
      versions: VERSIONS, observedAt: "2026-08-09T12:02:00.000Z",
      idempotencyKey: "memory-consolidation:mixed-aggregate",
    })).rejects.toThrow("MEMORY_SOURCE_AGGREGATE_MISMATCH");
    expect(await db.query<{ event_id: string; status: string }>(
      `select event_id::text,status from transactional_outbox
       where event_id=any($1::uuid[]) order by event_id`,
      [[first.id, lead.id]],
    )).toEqual([
      { event_id: first.id, status: "PENDING" },
      { event_id: lead.id, status: "PENDING" },
    ].sort((left, right) => left.event_id.localeCompare(right.event_id)));
    expect(await db.one<{ checkpoints: number; records: number; terms: number }>(
      `select (select count(*)::int from memory_projection_checkpoints) checkpoints,
              (select count(*)::int from memory_records) records,
              (select count(*)::int from memory_index_terms) terms`,
    )).toEqual({ checkpoints: 0, records: 0, terms: 0 });
    const keysAfter = await db.query<{ aggregate_id: string; wrapped_key: Buffer }>(
      `select aggregate_id,wrapped_key from aggregate_data_keys
       where aggregate_id=any($1::text[]) order by aggregate_id`,
      [["public-aggregate-a", "public-aggregate-b"]],
    );
    expect(keysAfter.map((row) => [row.aggregate_id, row.wrapped_key.toString("base64")]))
      .toEqual(keysBefore.map((row) => [row.aggregate_id, row.wrapped_key.toString("base64")]));
  });

  it("isolates caller keys by projection even after another account's derived key is erased", async () => {
    const { db } = await testContext();
    const accountA = await seedPrivateSource(db, "tenant-a");
    const accountB = await seedPrivateSource(db, "tenant-b");
    const sharedCallerKey = "memory-consolidation:same-caller-key";
    const resultA = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...workerInput(accountA, "tenant-a"), idempotencyKey: sharedCallerKey,
    });
    await db.query("update encrypted_event_bodies set data_key_id=null where event_id=$1", [
      resultA.consolidationEventId,
    ]);
    const resultB = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...workerInput(accountB, "tenant-b"), idempotencyKey: sharedCallerKey,
    });
    expect(resultB.extractionRunId).not.toBe(resultA.extractionRunId);
    expect(await db.one<{ runs: number }>("select count(*)::int runs from memory_extraction_runs"))
      .toEqual({ runs: 2 });
  });

  it("matches extraction text to authorized encrypted sources and rejects unbranded callers", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "source-fidelity");
    const input = workerInput(fixture, "source-fidelity");
    await expect(processMemoryEvent({ db } as ReturnType<typeof createMemoryWorkerContext>, input))
      .rejects.toThrow("MEMORY_WORKER_CONTEXT_REQUIRED");
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...input,
      events: [{ ...input.events[0], text: "Fabricated source text." }, input.events[1]],
    })).rejects.toThrow("MEMORY_SOURCE_TEXT_MISMATCH");
    expect(await db.one<{ count: number }>("select count(*)::int count from memory_records"))
      .toEqual({ count: 0 });
    await db.query("update encrypted_event_bodies set data_key_id=null where event_id=$1", [
      fixture.first.id,
    ]);
    await expect(processMemoryEvent(createMemoryWorkerContext(db), input))
      .rejects.toThrow("EVENT_KEY_UNAVAILABLE");
  });

  it("uses erasure-safe protected digests and loses the salt with its encrypted body", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "erasure-safe");
    const input = workerInput(fixture, "erasure-safe");
    const unsalted = consolidateEvents(input);
    const result = await processMemoryEvent(createMemoryWorkerContext(db), input);
    const stored = await db.query<{ content_digest: string; request_digest: string }>(
      `select memory.content_digest,run.request_digest
       from memory_records memory join memory_extraction_runs run on run.id=memory.extraction_run_id
       order by memory.ordinal`,
    );
    expect(stored.map((row) => row.content_digest))
      .not.toEqual(unsalted.memories.map((memory) => memory.contentDigest));
    expect(stored.every((row) => row.request_digest !== canonicalContentDigest(input))).toBe(true);
    await db.query("update encrypted_event_bodies set data_key_id=null where event_id=$1", [
      result.consolidationEventId,
    ]);
    await expect(readEventBody(db, result.consolidationEventId, { actor: { role: "SYSTEM" } }))
      .rejects.toThrow("EVENT_KEY_UNAVAILABLE");
    expect(await db.one<{ count: number }>(
      "select count(*)::int count from memory_records where content_digest is not null",
    )).toEqual({ count: 4 });
  });

  it("enforces account, Node, conversation, scope, and source-event authority before projection", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "authority");
    const other = await seedPrivateSource(db, "authority-other");
    const input = workerInput(fixture, "authority");
    await expect(processMemoryEvent(createMemoryWorkerContext(db), { ...input, accountId: other.accountId }))
      .rejects.toThrow("MEMORY_SOURCE_SCOPE_MISMATCH");
    await expect(processMemoryEvent(createMemoryWorkerContext(db), { ...input, nodeBrainId: other.nodeBrainId }))
      .rejects.toThrow("MEMORY_NODE_AUTHORITY_MISMATCH");
    await expect(processMemoryEvent(createMemoryWorkerContext(db), { ...input, conversationId: other.conversationId }))
      .rejects.toThrow("MEMORY_CONVERSATION_AUTHORITY_MISMATCH");
    await expect(processMemoryEvent(createMemoryWorkerContext(db), { ...input, scope: "MAIN_SHARED" }))
      .rejects.toThrow("MEMORY_SCOPE_BROADENING_FORBIDDEN");
    expect(await db.one<{ count: number }>("select count(*)::int count from memory_records"))
      .toEqual({ count: 0 });
  });

  it("rolls back all derived state when checkpoint persistence fails and never deletes source events", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "rollback");
    await db.query(`
      create function reject_memory_checkpoint() returns trigger language plpgsql as $$
      begin raise exception 'TEST_REJECT_MEMORY_CHECKPOINT'; end; $$;
      create trigger reject_memory_checkpoint before insert on memory_projection_checkpoints
      for each row execute function reject_memory_checkpoint();
    `);
    await expect(processMemoryEvent(createMemoryWorkerContext(db), workerInput(fixture, "rollback")))
      .rejects.toThrow("TEST_REJECT_MEMORY_CHECKPOINT");
    expect(await db.one<{ records: number; runs: number; completed: number; sources: number }>(
      `select (select count(*)::int from memory_records) records,
              (select count(*)::int from memory_extraction_runs) runs,
              (select count(*)::int from events where type='memory.consolidation.completed') completed,
              (select count(*)::int from events where id=any($1::uuid[])) sources`,
      [[fixture.first.id, fixture.second.id]],
    )).toEqual({ records: 0, runs: 0, completed: 0, sources: 2 });
  });

  it("rejects a derived consolidation event anywhere in a mixed source batch", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "mixed-derived");
    const initial = await processMemoryEvent(
      createMemoryWorkerContext(db), workerInput(fixture, "mixed-derived-initial"),
    );
    const next = await appendPrivateSource(
      db, fixture, "mixed-derived:3", "A new eligible source.", "2026-08-09T10:03:00.000Z",
    );
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...workerInput(fixture, "mixed-derived-next"),
      sourceEventId: next.id,
      events: [
        { id: initial.consolidationEventId, at: "2026-08-09T10:02:00.000Z", text: "derived" },
        { id: next.id, at: next.occurredAt.toISOString(), text: "A new eligible source." },
      ],
      extracted: { facts: [{ text: "New source", sourceIds: [next.id], confidence: 1 }], procedures: [], goals: [], episodes: [] },
      observedAt: "2026-08-09T10:04:00.000Z",
    })).rejects.toThrow("MEMORY_DERIVED_EVENT_NOT_SOURCE");
  });

  it("rejects an orphan consolidation event so it cannot be backfilled after commit", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "orphan-event");
    await expect(appendEvent(db, {
      aggregateId: fixture.conversationId,
      accountId: fixture.accountId,
      actor: { type: "SYSTEM", id: "memory-consolidator" },
      type: "memory.consolidation.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: { digestSalt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", memories: [] },
      causationId: fixture.second.id,
      correlationId: fixture.second.correlationId,
      occurredAt: new Date("2026-08-09T10:02:00.000Z"),
      promptVersion: VERSIONS.promptVersion,
      modelVersion: VERSIONS.modelVersion,
      policyVersion: VERSIONS.extractorVersion,
      idempotencyKey: "memory-event:orphan",
    })).rejects.toThrow("MEMORY_EXTRACTION_RUN_REQUIRED");
    expect(await db.one<{ events: number; bodies: number; outbox: number }>(
      `select
         (select count(*)::int from events where idempotency_key='memory-event:orphan') events,
         (select count(*)::int from encrypted_event_bodies body join events event on event.id=body.event_id
            where event.idempotency_key='memory-event:orphan') bodies,
         (select count(*)::int from transactional_outbox outbox join events event on event.id=outbox.event_id
            where event.idempotency_key='memory-event:orphan') outbox`,
    )).toEqual({ events: 0, bodies: 0, outbox: 0 });
  });

  it("rejects derived and wrong-aggregate direct-SQL run anchors without moving high-water", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "run-authority");
    const initial = await processMemoryEvent(
      createMemoryWorkerContext(db), workerInput(fixture, "run-authority-initial"),
    );
    const checkpointBefore = await db.one<{ source_event_id: string }>(
      "select source_event_id::text from memory_projection_checkpoints where projection_key=$1",
      [`private_account:conversation:${fixture.conversationId}`],
    );
    const insertRun = async (
      transaction: EventDatabase,
      sourceEventId: string,
      derivedEventId: string,
      sourceFrom: string,
      sourceTo: string,
      label: string,
    ) => transaction.query(
      `insert into memory_extraction_runs (
         id,source_event_id,source_ingested_sequence,consolidation_event_id,scope,account_id,node_brain_id,
         conversation_id,projection_key,operation_key,source_from,source_to,prompt_version,
         model_version,extractor_version,embedding_version,idempotency_key,request_digest,
         memory_count,completed_at
       ) values ($1,$2,(select ingested_sequence from events where id=$2),$3,
         'PRIVATE_ACCOUNT',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17)`,
      [randomUUID(), sourceEventId, derivedEventId, fixture.accountId, fixture.nodeBrainId,
        fixture.conversationId, `private_account:conversation:${fixture.conversationId}`,
        canonicalContentDigest({ label, kind: "operation" }), sourceFrom, sourceTo,
        VERSIONS.promptVersion, VERSIONS.modelVersion, VERSIONS.extractorVersion,
        VERSIONS.embeddingVersion, `memory-consolidation:run-authority:${label}`,
        canonicalContentDigest({ label, kind: "request" }), "2026-08-09T10:04:00.000Z"],
    );
    await expect(db.transaction(async (transaction) => {
      const wrongAggregate = await appendEvent(transaction, {
        aggregateId: "foreign-private-aggregate", accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "memory-consolidator" },
        type: "memory.consolidation.completed", visibility: "PRIVATE_ACCOUNT",
        body: { digestSalt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", memories: [] },
        causationId: fixture.second.id, correlationId: fixture.second.correlationId,
        occurredAt: new Date("2026-08-09T10:03:00.000Z"),
        promptVersion: VERSIONS.promptVersion, modelVersion: VERSIONS.modelVersion,
        policyVersion: VERSIONS.extractorVersion,
        idempotencyKey: "memory-event:run-authority:wrong-aggregate",
      });
      await insertRun(transaction, fixture.second.id, wrongAggregate.id,
        fixture.first.occurredAt.toISOString(), fixture.second.occurredAt.toISOString(),
        "wrong-aggregate");
    })).rejects.toThrow("MEMORY_CONSOLIDATION_EVENT_MISMATCH");
    await expect(db.transaction(async (transaction) => {
      const derivedAnchor = await appendEvent(transaction, {
        aggregateId: fixture.conversationId, accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "memory-consolidator" },
        type: "memory.consolidation.completed", visibility: "PRIVATE_ACCOUNT",
        body: { digestSalt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", memories: [] },
        causationId: initial.consolidationEventId, correlationId: fixture.second.correlationId,
        occurredAt: new Date("2026-08-09T10:04:00.000Z"),
        promptVersion: VERSIONS.promptVersion, modelVersion: VERSIONS.modelVersion,
        policyVersion: VERSIONS.extractorVersion,
        idempotencyKey: "memory-event:run-authority:derived-anchor",
      });
      await insertRun(transaction, initial.consolidationEventId, derivedAnchor.id,
        "2026-08-09T10:02:00.000Z", "2026-08-09T10:02:00.000Z", "derived-anchor");
    })).rejects.toThrow("MEMORY_DERIVED_EVENT_NOT_SOURCE");
    expect(await db.one<{ source_event_id: string }>(
      "select source_event_id::text from memory_projection_checkpoints where projection_key=$1",
      [`private_account:conversation:${fixture.conversationId}`],
    )).toEqual(checkpointBefore);
    expect(await db.one<{ runs: number }>(
      "select count(*)::int runs from memory_extraction_runs",
    )).toEqual({ runs: 1 });
  });

  it("advances worker outbox state and the projection high-water without regressing it", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "high-water");
    const complete = workerInput(fixture, "high-water-second");
    const secondResult = await processMemoryEvent(createMemoryWorkerContext(db), complete);
    const olderOnly = {
      ...workerInput(fixture, "high-water-first"),
      sourceEventId: fixture.first.id,
      events: [workerInput(fixture, "high-water-first").events[0]],
      extracted: {
        facts: [workerInput(fixture, "high-water-first").extracted.facts[0]], procedures: [], goals: [], episodes: [],
      },
    };
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...olderOnly,
      versions: { ...olderOnly.versions, promptVersion: "memory-high-water-behind-v2" },
    })).rejects.toThrow("MEMORY_SOURCE_BEHIND_CHECKPOINT");
    const state = await db.one<{ source_event_id: string; status: string }>(
      `select checkpoint.source_event_id::text, outbox.status
       from memory_projection_checkpoints checkpoint
       join transactional_outbox outbox on outbox.event_id=$2
       where checkpoint.projection_key=$1`,
      [`private_account:conversation:${fixture.conversationId}`, fixture.second.id],
    );
    expect(state).toEqual({ source_event_id: fixture.second.id, status: "PUBLISHED" });
    expect(secondResult.highWaterEventId).toBe(fixture.second.id);
  });

  it("serializes projections, rejects gaps/behind leads, and publishes every cited source", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "gap-safe");
    const complete = workerInput(fixture, "gap-safe-complete");
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...complete, sourceEventId: fixture.first.id,
    })).rejects.toThrow("MEMORY_LEAD_NOT_BATCH_MAXIMUM");
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...complete,
      events: [complete.events[1]],
      extracted: { facts: [], procedures: [], goals: [complete.extracted.goals[0]], episodes: [] },
    })).rejects.toThrow("MEMORY_PROJECTION_GAP");
    await processMemoryEvent(createMemoryWorkerContext(db), complete);
    expect(await db.query<{ event_id: string; status: string }>(
      `select event_id::text,status from transactional_outbox
       where event_id=any($1::uuid[]) order by event_id`,
      [[fixture.first.id, fixture.second.id]],
    )).toEqual([
      { event_id: fixture.first.id, status: "PUBLISHED" },
      { event_id: fixture.second.id, status: "PUBLISHED" },
    ].sort((left, right) => left.event_id.localeCompare(right.event_id)));
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...complete,
      sourceEventId: fixture.first.id,
      events: [complete.events[0]],
      extracted: { facts: [complete.extracted.facts[0]], procedures: [], goals: [], episodes: [] },
      versions: { ...complete.versions, promptVersion: "memory-behind-v2" },
      idempotencyKey: "memory-consolidation:gap-safe-behind",
    })).rejects.toThrow("MEMORY_SOURCE_BEHIND_CHECKPOINT");

    const third = await appendPrivateSource(
      db, fixture, "gap-safe:3", "Third memory source.", "2026-08-09T10:03:00.000Z",
    );
    const fourth = await appendPrivateSource(
      db, fixture, "gap-safe:4", "Fourth memory source.", "2026-08-09T10:04:00.000Z",
    );
    const thirdInput = {
      ...complete,
      sourceEventId: third.id,
      events: [{ id: third.id, at: third.occurredAt.toISOString(), text: "Third memory source." }],
      extracted: { facts: [{ text: "Third source", sourceIds: [third.id], confidence: 1 }], procedures: [], goals: [], episodes: [] },
      observedAt: "2026-08-09T10:03:30.000Z",
      idempotencyKey: "memory-consolidation:gap-safe:3",
    };
    const fourthInput = {
      ...complete,
      sourceEventId: fourth.id,
      events: [
        { id: third.id, at: third.occurredAt.toISOString(), text: "Third memory source." },
        { id: fourth.id, at: fourth.occurredAt.toISOString(), text: "Fourth memory source." },
      ],
      extracted: { facts: [{ text: "Fourth source", sourceIds: [fourth.id], confidence: 1 }], procedures: [], goals: [], episodes: [] },
      observedAt: "2026-08-09T10:04:30.000Z",
      idempotencyKey: "memory-consolidation:gap-safe:4",
    };
    const concurrent = await Promise.allSettled([
      processMemoryEvent(createMemoryWorkerContext(db), fourthInput),
      processMemoryEvent(createMemoryWorkerContext(db), thirdInput),
    ]);
    expect(concurrent.some((result) => result.status === "fulfilled")).toBe(true);
    const afterConcurrent = await db.one<{ source_event_id: string }>(
      "select source_event_id::text from memory_projection_checkpoints where projection_key=$1",
      [`private_account:conversation:${fixture.conversationId}`],
    );
    if (afterConcurrent.source_event_id === third.id) {
      await processMemoryEvent(createMemoryWorkerContext(db), {
        ...fourthInput,
        events: [{ id: fourth.id, at: fourth.occurredAt.toISOString(), text: "Fourth memory source." }],
      });
    }
    expect((await db.one<{ source_event_id: string }>(
      "select source_event_id::text from memory_projection_checkpoints where projection_key=$1",
      [`private_account:conversation:${fixture.conversationId}`],
    )).source_event_id).toBe(fourth.id);
    expect(await db.query<{ status: string }>(
      "select status from transactional_outbox where event_id=any($1::uuid[]) order by event_id",
      [[third.id, fourth.id]],
    )).toEqual([{ status: "PUBLISHED" }, { status: "PUBLISHED" }]);
    const fifth = await appendPrivateSource(
      db, fixture, "gap-safe:5", "Fifth memory source.", "2026-08-09T10:05:00.000Z",
    );
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...complete,
      sourceEventId: fifth.id,
      events: [
        { id: fourth.id, at: fourth.occurredAt.toISOString(), text: "Fourth memory source." },
        { id: fifth.id, at: fifth.occurredAt.toISOString(), text: "Fifth memory source." },
      ],
      extracted: { facts: [{ text: "Fifth source", sourceIds: [fifth.id], confidence: 1 }], procedures: [], goals: [], episodes: [] },
      observedAt: "2026-08-09T10:05:30.000Z",
      idempotencyKey: "memory-consolidation:gap-safe:5",
    })).rejects.toThrow("MEMORY_PROJECTION_OVERLAP");
  });

  it("contains no model, broker, exchange, child-process, socket, or network execution path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sources = await Promise.all([
      readFile("lib/server/consolidation/consolidate.ts", "utf8"),
      readFile("worker/consolidation/process-event.ts", "utf8"),
    ]);
    const combined = sources.join("\n");
    expect(combined).not.toMatch(/from\s+["']node:(?:child_process|http|https|net|tls)["']/u);
    expect(combined).not.toMatch(/\bfetch\s*\(/u);
    expect(combined).not.toMatch(/broker|exchange|prop.?firm|order.?routing|model.?gateway/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("cannot mutate or delete source events through direct SQL", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "immutability");
    const input = workerInput(fixture, "immutability");
    await processMemoryEvent(createMemoryWorkerContext(db), input);
    await expect(db.query("delete from events where id=$1", [fixture.first.id]))
      .rejects.toThrow("IMMUTABLE_EVENT");
    await expect(db.query("update memory_records set confidence=0 where id=$1", [
      (await db.one<{ id: string }>("select id::text from memory_records limit 1")).id,
    ])).rejects.toThrow("IMMUTABLE_MEMORY_RECORD");
    const sealed = await db.one<{ id: string; source_count: number }>(
      "select id::text,source_count from memory_records order by ordinal limit 1",
    );
    await expect(db.query(
      `insert into memory_sources (
         memory_id,ordinal,source_event_id,source_ingested_sequence,source_at
       ) values ($1,$2,$3,(select ingested_sequence from events where id=$3),$4)`,
      [sealed.id, sealed.source_count, fixture.first.id, fixture.first.occurredAt],
    )).rejects.toThrow();
    const semantic = await db.one<{ id: string; body_event_id: string }>(
      "select id::text,body_event_id::text from memory_records where type='SEMANTIC'",
    );
    await expect(db.query(
      `insert into memory_index_terms (
         memory_id,ordinal,kind,scope,account_id,node_brain_id,conversation_id,
         term_text,term_digest,set_digest
       ) values ($1,0,'KEYWORD','PUBLIC',null,null,null,'forged',$2,$2)`,
      [semantic.id, "a".repeat(64)],
    )).rejects.toThrow("MEMORY_INDEX_TOPOLOGY_MISMATCH");
    const procedure = await db.one<{
      id: string; account_id: string; conversation_id: string;
    }>(
      `select id::text,account_id::text,conversation_id::text
       from memory_records where type='PROCEDURAL'`,
    );
    await expect(db.query(
      `insert into memory_embeddings (
         memory_id,account_id,conversation_id,scope,embedding_version,
         embedding_digest,dimension,search_embedding
       ) values ($1,$2,$3,'PRIVATE_ACCOUNT',$4,$5,2,null)`,
      [procedure.id, procedure.account_id, procedure.conversation_id,
        VERSIONS.embeddingVersion, "b".repeat(64)],
    )).rejects.toThrow("MEMORY_EMBEDDING_TOPOLOGY_MISMATCH");
    await expect(db.query(
      `insert into memory_sources (
         memory_id,ordinal,source_event_id,source_ingested_sequence,source_at
       ) values ($1,0,$2,(select ingested_sequence from events where id=$2),$3)`,
      [semantic.id, semantic.body_event_id, fixture.second.occurredAt],
    )).rejects.toThrow("MEMORY_DERIVED_EVENT_NOT_SOURCE");
  });

  it("appends scoped corrections and allows exactly one authoritative superseder", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "supersession");
    const initial = await processMemoryEvent(
      createMemoryWorkerContext(db), workerInput(fixture, "supersession-initial"),
    );
    const prior = initial.memories.find((memory) => memory.type === "SEMANTIC")!;

    const correction = await appendEvent(db, {
      aggregateId: fixture.conversationId,
      accountId: fixture.accountId,
      actor: { type: "USER", id: fixture.accountId },
      type: "message.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: { text: "My preferred ticker is now MSFT." },
      occurredAt: new Date("2026-08-09T10:03:00.000Z"),
      idempotencyKey: "memory-source:supersession:3",
    });
    const correctionInput = {
      ...workerInput(fixture, "supersession-correction"),
      sourceEventId: correction.id,
      events: [{ id: correction.id, at: correction.occurredAt.toISOString(), text: "My preferred ticker is now MSFT." }],
      extracted: {
        facts: [{
          text: "Preferred ticker is MSFT", sourceIds: [correction.id], confidence: 0.99,
          supersedesMemoryId: prior.id, correctionState: "USER_CORRECTED" as const,
        }],
        procedures: [], goals: [], episodes: [],
      },
      observedAt: "2026-08-09T10:04:00.000Z",
    };
    const corrected = await processMemoryEvent(createMemoryWorkerContext(db), correctionInput);
    expect(corrected.memories[0].supersedesMemoryId).toBe(prior.id);
    expect(await db.one<{ superseders: number }>(
      "select count(*)::int superseders from memory_records where supersedes_memory_id=$1",
      [prior.id],
    )).toEqual({ superseders: 1 });
    await expect(db.query(
      `insert into memory_supersession_authorizations
         (memory_id,source_event_id,authority_kind)
       values ($1,$2,'USER')`,
      [corrected.memories[0].id, fixture.second.id],
    )).rejects.toThrow("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");

    const duplicateCorrection = await appendEvent(db, {
      aggregateId: fixture.conversationId,
      accountId: fixture.accountId,
      actor: { type: "USER", id: fixture.accountId },
      type: "message.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: { text: "I repeat that MSFT is preferred." },
      occurredAt: new Date("2026-08-09T10:05:00.000Z"),
      idempotencyKey: "memory-source:supersession:4",
    });
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...correctionInput,
      sourceEventId: duplicateCorrection.id,
      events: [{ id: duplicateCorrection.id, at: duplicateCorrection.occurredAt.toISOString(), text: "I repeat that MSFT is preferred." }],
      extracted: {
        ...correctionInput.extracted,
        facts: [{ ...correctionInput.extracted.facts[0], sourceIds: [duplicateCorrection.id] }],
      },
      observedAt: "2026-08-09T10:06:00.000Z",
      idempotencyKey: "memory-consolidation:supersession-duplicate",
    })).rejects.toThrow();
    expect(await db.one<{ superseders: number }>(
      "select count(*)::int superseders from memory_records where supersedes_memory_id=$1",
      [prior.id],
    )).toEqual({ superseders: 1 });
  });

  it("derives correction and canonical supersession authority from durable cited actors", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "correction-authority");
    const initial = await processMemoryEvent(
      createMemoryWorkerContext(db), workerInput(fixture, "correction-authority-initial"),
    );
    const prior = initial.memories.find((memory) => memory.type === "SEMANTIC")!;
    const nodeSource = await appendPrivateSource(
      db, fixture, "correction-authority:node", "Node claims the user corrected this.",
      "2026-08-09T10:03:00.000Z", "NODE",
    );
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      ...workerInput(fixture, "correction-authority-node"),
      sourceEventId: nodeSource.id,
      events: [{ id: nodeSource.id, at: nodeSource.occurredAt.toISOString(), text: "Node claims the user corrected this." }],
      extracted: {
        facts: [{
          text: "Preferred ticker is MSFT", sourceIds: [nodeSource.id], confidence: 0.9,
          supersedesMemoryId: prior.id, correctionState: "USER_CORRECTED" as const,
        }],
        procedures: [], goals: [], episodes: [],
      },
      observedAt: "2026-08-09T10:04:00.000Z",
    })).rejects.toThrow("MEMORY_CORRECTION_AUTHORITY_MISMATCH");

    const mainSource = await appendEvent(db, {
      aggregateId: "main-canonical-authority",
      actor: { type: "MAIN_BRAIN", id: "main-brain" },
      type: "winner.selected",
      visibility: "SHARED",
      body: { text: "Main canonical view is neutral." },
      occurredAt: new Date("2026-08-09T11:00:00.000Z"),
      idempotencyKey: "memory-source:canonical-authority:main",
    });
    const canonical = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED",
      sourceEventId: mainSource.id,
      events: [{ id: mainSource.id, at: mainSource.occurredAt.toISOString(), text: "Main canonical view is neutral." }],
      extracted: { facts: [{ text: "Canonical view is neutral", sourceIds: [mainSource.id], confidence: 1 }], procedures: [], goals: [], episodes: [] },
      versions: VERSIONS,
      observedAt: "2026-08-09T11:01:00.000Z",
      idempotencyKey: "memory-consolidation:canonical-authority:main",
    });
    const nodeShared = await appendEvent(db, {
      aggregateId: "main-canonical-authority",
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
      type: "node.proposal.created",
      visibility: "SHARED",
      body: { text: "Node attempts to replace Main canonical view." },
      occurredAt: new Date("2026-08-09T11:02:00.000Z"),
      idempotencyKey: "memory-source:canonical-authority:node",
    });
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED",
      sourceEventId: nodeShared.id,
      events: [{ id: nodeShared.id, at: nodeShared.occurredAt.toISOString(), text: "Node attempts to replace Main canonical view." }],
      extracted: { facts: [{
        text: "Canonical view is bullish", sourceIds: [nodeShared.id], confidence: 0.8,
        supersedesMemoryId: canonical.memories[0].id,
      }], procedures: [], goals: [], episodes: [] },
      versions: VERSIONS,
      observedAt: "2026-08-09T11:03:00.000Z",
      idempotencyKey: "memory-consolidation:canonical-authority:node",
    })).rejects.toThrow("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");

    const wrongMain = await appendEvent(db, {
      aggregateId: "wrong-main-authority",
      actor: { type: "MAIN_BRAIN", id: "attacker-main" },
      type: "winner.selected", visibility: "SHARED",
      body: { text: "An unpinned Main identity tries to supersede memory." },
      occurredAt: new Date("2026-08-09T12:00:00.000Z"),
      idempotencyKey: "memory-source:canonical-authority:wrong-main",
    });
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", sourceEventId: wrongMain.id,
      events: [{ id: wrongMain.id, at: wrongMain.occurredAt.toISOString(), text: "An unpinned Main identity tries to supersede memory." }],
      extracted: { facts: [{
        text: "Unpinned Main view", sourceIds: [wrongMain.id], confidence: 1,
        supersedesMemoryId: canonical.memories[0].id,
      }] },
      versions: VERSIONS, observedAt: "2026-08-09T12:01:00.000Z",
      idempotencyKey: "memory-consolidation:canonical-authority:wrong-main",
    })).rejects.toThrow("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");

    const citedWrongMain = await appendEvent(db, {
      aggregateId: "pinned-main-authority",
      actor: { type: "MAIN_BRAIN", id: "attacker-main" },
      type: "winner.selected", visibility: "SHARED",
      body: { text: "Wrong Main is included but cannot authorize." },
      occurredAt: new Date("2026-08-09T12:02:00.000Z"),
      idempotencyKey: "memory-source:canonical-authority:cited-wrong-main",
    });
    const pinnedMain = await appendEvent(db, {
      aggregateId: "pinned-main-authority",
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "winner.selected", visibility: "SHARED",
      body: { text: "Pinned Main authorizes the supersession." },
      occurredAt: new Date("2026-08-09T12:03:00.000Z"),
      idempotencyKey: "memory-source:canonical-authority:pinned-main",
    });
    const pinned = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", sourceEventId: pinnedMain.id,
      events: [
        { id: citedWrongMain.id, at: citedWrongMain.occurredAt.toISOString(), text: "Wrong Main is included but cannot authorize." },
        { id: pinnedMain.id, at: pinnedMain.occurredAt.toISOString(), text: "Pinned Main authorizes the supersession." },
      ],
      extracted: { facts: [{
        text: "Pinned canonical view", sourceIds: [citedWrongMain.id, pinnedMain.id], confidence: 1,
        supersedesMemoryId: canonical.memories[0].id,
      }] },
      versions: VERSIONS, observedAt: "2026-08-09T12:04:00.000Z",
      idempotencyKey: "memory-consolidation:canonical-authority:pinned-main",
    });
    await expect(db.query(
      `insert into memory_supersession_authorizations
         (memory_id,source_event_id,authority_kind) values ($1,$2,'MAIN')`,
      [pinned.memories[0].id, citedWrongMain.id],
    )).rejects.toThrow("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");
  });

  it("pins Challenge supersession to accepted lifecycle authority app-side and in SQL", async () => {
    const { db } = await testContext();
    const originalSource = await appendEvent(db, {
      aggregateId: "challenge-authority-original",
      actor: { type: "SYSTEM", id: "challenge-stage-lifecycle" },
      type: "challenge.passed", visibility: "SHARED",
      body: { text: "The challenge stage passed." },
      occurredAt: new Date("2026-08-09T13:00:00.000Z"),
      idempotencyKey: "memory-source:challenge-authority:original",
    });
    const original = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "CHALLENGE_SHARED", sourceEventId: originalSource.id,
      events: [{ id: originalSource.id, at: originalSource.occurredAt.toISOString(), text: "The challenge stage passed." }],
      extracted: { facts: [{ text: "Challenge passed", sourceIds: [originalSource.id], confidence: 1 }] },
      versions: VERSIONS, observedAt: "2026-08-09T13:01:00.000Z",
      idempotencyKey: "memory-consolidation:challenge-authority:original",
    });
    const invalid = await appendEvent(db, {
      aggregateId: "challenge-authority-invalid",
      actor: { type: "SYSTEM", id: "untrusted-challenge-worker" },
      type: "challenge.paused", visibility: "SHARED",
      body: { text: "An untrusted worker tries to replace the challenge result." },
      occurredAt: new Date("2026-08-09T13:02:00.000Z"),
      idempotencyKey: "memory-source:challenge-authority:invalid",
    });
    await expect(processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "CHALLENGE_SHARED", sourceEventId: invalid.id,
      events: [{ id: invalid.id, at: invalid.occurredAt.toISOString(), text: "An untrusted worker tries to replace the challenge result." }],
      extracted: { facts: [{
        text: "Challenge paused", sourceIds: [invalid.id], confidence: 1,
        supersedesMemoryId: original.memories[0].id,
      }] },
      versions: VERSIONS, observedAt: "2026-08-09T13:03:00.000Z",
      idempotencyKey: "memory-consolidation:challenge-authority:invalid",
    })).rejects.toThrow("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");

    const citedInvalid = await appendEvent(db, {
      aggregateId: "challenge-authority-valid",
      actor: { type: "SYSTEM", id: "untrusted-challenge-worker" },
      type: "challenge.paused", visibility: "SHARED",
      body: { text: "Untrusted challenge source is only evidence." },
      occurredAt: new Date("2026-08-09T13:04:00.000Z"),
      idempotencyKey: "memory-source:challenge-authority:cited-invalid",
    });
    const valid = await appendEvent(db, {
      aggregateId: "challenge-authority-valid",
      actor: { type: "SYSTEM", id: "challenge-stage-lifecycle" },
      type: "challenge.failed", visibility: "SHARED",
      body: { text: "The accepted lifecycle reports challenge failure." },
      occurredAt: new Date("2026-08-09T13:05:00.000Z"),
      idempotencyKey: "memory-source:challenge-authority:valid",
    });
    const replaced = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "CHALLENGE_SHARED", sourceEventId: valid.id,
      events: [
        { id: citedInvalid.id, at: citedInvalid.occurredAt.toISOString(), text: "Untrusted challenge source is only evidence." },
        { id: valid.id, at: valid.occurredAt.toISOString(), text: "The accepted lifecycle reports challenge failure." },
      ],
      extracted: { facts: [{
        text: "Challenge failed", sourceIds: [citedInvalid.id, valid.id], confidence: 1,
        supersedesMemoryId: original.memories[0].id,
      }] },
      versions: VERSIONS, observedAt: "2026-08-09T13:06:00.000Z",
      idempotencyKey: "memory-consolidation:challenge-authority:valid",
    });
    await expect(db.query(
      `insert into memory_supersession_authorizations
         (memory_id,source_event_id,authority_kind) values ($1,$2,'CHALLENGE')`,
      [replaced.memories[0].id, citedInvalid.id],
    )).rejects.toThrow("MEMORY_SUPERSESSION_AUTHORITY_MISMATCH");
  });

  it("advances by immutable database ingestion sequence when a late import has older domain time", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "ingestion-sequence");
    await processMemoryEvent(
      createMemoryWorkerContext(db), workerInput(fixture, "ingestion-sequence-initial"),
    );
    const before = await db.one<{ ingested_sequence: string }>(
      `select source_ingested_sequence::text ingested_sequence
       from memory_projection_checkpoints where projection_key=$1`,
      [`private_account:conversation:${fixture.conversationId}`],
    );
    const late = await appendPrivateSource(
      db, fixture, "ingestion-sequence:late", "A late imported source.",
      "2026-08-08T09:00:00.000Z",
    );
    const result = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...workerInput(fixture, "ingestion-sequence-late"),
      sourceEventId: late.id,
      events: [{ id: late.id, at: late.occurredAt.toISOString(), text: "A late imported source." }],
      extracted: { facts: [{ text: "Late source imported", sourceIds: [late.id] }],
        procedures: [], goals: [], episodes: [] },
      observedAt: "2026-08-09T10:10:00.000Z",
    });
    expect(result.highWaterEventId).toBe(late.id);
    const after = await db.one<{ ingested_sequence: string }>(
      `select source_ingested_sequence::text ingested_sequence
       from memory_projection_checkpoints where projection_key=$1`,
      [`private_account:conversation:${fixture.conversationId}`],
    );
    expect(BigInt(after.ingested_sequence)).toBeGreaterThan(BigInt(before.ingested_sequence));
    await expect(db.query(
      "update events set ingested_sequence=ingested_sequence+1 where id=$1",
      [fixture.first.id],
    )).rejects.toThrow("IMMUTABLE_EVENT");
  });

  it("separates private-account and Node-branch projections for the same source and versions", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "scope-projection-key");
    const privateResult = await processMemoryEvent(
      createMemoryWorkerContext(db), workerInput(fixture, "scope-projection-private"),
    );
    const nodeResult = await processMemoryEvent(createMemoryWorkerContext(db), {
      ...workerInput(fixture, "scope-projection-node"), scope: "NODE_BRANCH",
      idempotencyKey: "memory-consolidation:scope-projection-node",
    });
    expect(nodeResult.extractionRunId).not.toBe(privateResult.extractionRunId);
    expect(await db.query<{ projection_key: string }>(
      "select projection_key from memory_projection_checkpoints order by projection_key",
    )).toEqual([
      { projection_key: `node_branch:conversation:${fixture.conversationId}` },
      { projection_key: `private_account:conversation:${fixture.conversationId}` },
    ]);
  });

  it("uses fixed erasable retrieval-key domains for shared search across source aggregates", async () => {
    const { db } = await testContext();
    const sharedInputs = new Map<string, Parameters<typeof processMemoryEvent>[1]>();
    const processShared = async (aggregateId: string, label: string, minute: number) => {
      const source = await appendEvent(db, {
        aggregateId, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        type: "main.broadcast.committed", visibility: "SHARED",
        body: { text: "AAPL remains the shared focus." },
        occurredAt: new Date(`2026-08-09T14:${String(minute).padStart(2, "0")}:00.000Z`),
        idempotencyKey: `memory-source:shared-domain:${label}`,
      });
      const input = {
        scope: "MAIN_SHARED", sourceEventId: source.id,
        events: [{ id: source.id, at: source.occurredAt.toISOString(), text: "AAPL remains the shared focus." }],
        extracted: { facts: [{ text: "AAPL is the shared focus", sourceIds: [source.id],
          keywords: ["AAPL"] }] }, versions: VERSIONS,
        observedAt: `2026-08-09T14:${String(minute).padStart(2, "0")}:30.000Z`,
        idempotencyKey: `memory-consolidation:shared-domain:${label}`,
      } as const;
      sharedInputs.set(label, input);
      return processMemoryEvent(createMemoryWorkerContext(db), input);
    };
    const firstEpoch = await processShared("shared-domain-a", "a", 10);
    await processShared("shared-domain-b", "b", 11);
    const terms = await db.query<{ term_digest: string; search_key_id: string }>(
      `select term_digest,search_key_id::text from memory_index_terms
       where scope='MAIN_SHARED' and kind='KEYWORD' order by memory_id`,
    );
    expect(terms).toHaveLength(2);
    expect(terms[1]).toEqual(terms[0]);
    expect(await deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", kind: "KEYWORD", term: "AAPL",
    })).toBe(terms[0].term_digest);
    expect(await db.one<{ keys: number }>(
      "select count(*)::int keys from aggregate_data_keys where aggregate_id='memory-retrieval:main:v1'",
    )).toEqual({ keys: 1 });
    await expect(db.transaction(async (transaction) => {
      const source = await appendEvent(transaction, {
        aggregateId: "shared-domain-forged-key",
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        type: "main.broadcast.committed", visibility: "SHARED",
        body: { text: "A forged search key must not attach." },
        occurredAt: new Date("2026-08-09T14:11:30.000Z"),
        idempotencyKey: "memory-source:shared-domain:forged-key",
      });
      const derived = await appendEvent(transaction, {
        aggregateId: source.aggregateId,
        actor: { type: "SYSTEM", id: "memory-consolidator" },
        type: "memory.consolidation.completed", visibility: "SHARED",
        body: { digestSalt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", memories: [] },
        causationId: source.id, correlationId: source.correlationId,
        occurredAt: new Date("2026-08-09T14:11:45.000Z"),
        promptVersion: VERSIONS.promptVersion, modelVersion: VERSIONS.modelVersion,
        policyVersion: VERSIONS.extractorVersion,
        idempotencyKey: "memory-event:shared-domain:forged-key",
      });
      const runId = randomUUID();
      await transaction.query(
        `insert into memory_extraction_runs (
           id,source_event_id,source_ingested_sequence,consolidation_event_id,scope,
           projection_key,operation_key,source_from,source_to,prompt_version,model_version,
           extractor_version,embedding_version,idempotency_key,request_digest,memory_count,completed_at
         ) values ($1,$2,(select ingested_sequence from events where id=$2),$3,'MAIN_SHARED',
           $4,$5,$6,$6,$7,$8,$9,$10,$11,$12,1,$13)`,
        [runId, source.id, derived.id, `main_shared:${source.aggregateId}`,
          canonicalContentDigest({ forged: "operation" }), source.occurredAt,
          VERSIONS.promptVersion, VERSIONS.modelVersion, VERSIONS.extractorVersion,
          VERSIONS.embeddingVersion, "memory-consolidation:shared-domain:forged-key",
          canonicalContentDigest({ forged: "request" }), derived.occurredAt],
      );
      await transaction.query(
        `insert into memory_records (
           id,extraction_run_id,body_event_id,ordinal,source_count,type,scope,search_key_id,
           content_digest,equivalence_digest,keywords_digest,entities_digest,
           keyword_index_digests,entity_index_digests,keyword_count,entity_count,has_embedding,
           embedding_dimension,source_from,source_to,confidence,importance,freshness,prompt_version,
           model_version,extractor_version,embedding_version,valid_from,conflict_state,
           correction_state,created_at
         ) values ($1,$2,$3,0,1,'SEMANTIC','MAIN_SHARED',$4,$5,$5,$6,$6,
           '{}','{}',0,0,false,0,$7,$7,1,1,1,$8,$9,$10,$11,$7,'CURRENT','NONE',$12)`,
        [randomUUID(), runId, derived.id, randomUUID(), "a".repeat(64), "b".repeat(64),
          source.occurredAt, VERSIONS.promptVersion, VERSIONS.modelVersion,
          VERSIONS.extractorVersion, VERSIONS.embeddingVersion, derived.occurredAt],
      );
    })).rejects.toThrow("MEMORY_SEARCH_KEY_AUTHORITY_MISMATCH");
    const oldSearchKeyId = terms[0].search_key_id;
    await db.query(
      "delete from aggregate_data_keys where aggregate_id='memory-retrieval:main:v1'",
    );
    await expect(deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", kind: "KEYWORD", term: "AAPL",
    })).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
    expect((await processMemoryEvent(
      createMemoryWorkerContext(db), sharedInputs.get("a")!,
    )).memories).toEqual(firstEpoch.memories);
    const newEpoch = await processShared("shared-domain-c", "c", 12);
    const newTerm = await db.one<{ term_digest: string; search_key_id: string }>(
      `select term_digest,search_key_id::text from memory_index_terms
       where memory_id=$1 and kind='KEYWORD'`,
      [newEpoch.memories[0].id],
    );
    expect(newTerm.search_key_id).not.toBe(oldSearchKeyId);
    expect(newTerm.term_digest).not.toBe(terms[0].term_digest);
    expect(await deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", kind: "KEYWORD", term: "AAPL",
    })).toBe(newTerm.term_digest);
    expect((await processMemoryEvent(
      createMemoryWorkerContext(db), sharedInputs.get("a")!,
    )).memories).toEqual(firstEpoch.memories);
    expect(await db.one<{ retained: number }>(
      "select count(*)::int retained from memory_index_terms where search_key_id=$1",
      [oldSearchKeyId],
    )).toEqual({ retained: 2 });
  }, 20_000);

  it("persists only keyed bounded vector buckets and erases them with either protected key", async () => {
    const { db } = await testContext();
    const source = await appendEvent(db, {
      aggregateId: "shared-vector-bucket-source",
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.broadcast.committed", visibility: "SHARED",
      body: { text: "AAPL vector bucket authority." },
      occurredAt: new Date("2026-08-09T14:19:00.000Z"),
      idempotencyKey: "memory-source:shared-vector-bucket",
    });
    const result = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", sourceEventId: source.id,
      events: [{ id: source.id, at: source.occurredAt.toISOString(),
        text: "AAPL vector bucket authority." }],
      extracted: { facts: [{
        text: "AAPL vector bucket authority", sourceIds: [source.id],
        keywords: ["AAPL"], embedding: [1, 0],
      }] }, versions: VERSIONS, observedAt: "2026-08-09T14:19:30.000Z",
      idempotencyKey: "memory-consolidation:shared-vector-bucket",
    });
    const buckets = await db.query<{
      bucket_digest: string; search_key_id: string; body_key_id: string;
    }>(
      `select bucket.bucket_digest,bucket.search_key_id::text,bucket.body_key_id::text
       from memory_vector_buckets bucket where bucket.memory_id=$1 order by bucket.ordinal`,
      [result.memories[0].id],
    );
    expect(buckets.length).toBeGreaterThanOrEqual(3);
    expect(buckets.length).toBeLessThanOrEqual(8);
    expect(buckets.every(({ bucket_digest }) => /^[a-f0-9]{64}$/u.test(bucket_digest))).toBe(true);
    expect(await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema=current_schema() and table_name='memory_vector_buckets'
         and column_name in ('embedding','search_embedding','vector')`,
    )).toHaveLength(0);
    await expect(db.query(
      `insert into memory_vector_buckets (
         memory_id,ordinal,scope,account_id,node_brain_id,conversation_id,search_key_id,
         body_key_id,embedding_version,bucket_digest
       ) select memory_id,7,scope,account_id,node_brain_id,conversation_id,$2,
                body_key_id,embedding_version,bucket_digest
           from memory_vector_buckets where memory_id=$1 order by ordinal limit 1`,
      [result.memories[0].id, randomUUID()],
    )).rejects.toThrow("MEMORY_VECTOR_BUCKET_AUTHORITY_MISMATCH");
    await expect(db.transaction(async (transaction) => {
      await transaction.query("delete from aggregate_data_keys where id=$1", [buckets[0].body_key_id]);
      expect(await transaction.one<{ count: number }>(
        "select count(*)::int count from memory_vector_buckets where memory_id=$1",
        [result.memories[0].id],
      )).toEqual({ count: 0 });
      throw new Error("ROLLBACK_VECTOR_BODY_KEY_ERASURE");
    })).rejects.toThrow("ROLLBACK_VECTOR_BODY_KEY_ERASURE");
    await db.query("delete from aggregate_data_keys where id=$1", [buckets[0].search_key_id]);
    expect(await db.one<{ count: number }>(
      "select count(*)::int count from memory_vector_buckets where memory_id=$1",
      [result.memories[0].id],
    )).toEqual({ count: 0 });
  }, 20_000);

  it("holds the retrieval key against concurrent deletion through memory-record commit", async () => {
    const { db } = await testContext();
    const initialSource = await appendEvent(db, {
      aggregateId: "retrieval-key-race-initial",
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.broadcast.committed", visibility: "SHARED",
      body: { text: "Initial shared memory." },
      occurredAt: new Date("2026-08-09T14:20:00.000Z"),
      idempotencyKey: "memory-source:retrieval-key-race:initial",
    });
    await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", sourceEventId: initialSource.id,
      events: [{ id: initialSource.id, at: initialSource.occurredAt.toISOString(), text: "Initial shared memory." }],
      extracted: { facts: [{ text: "Initial shared memory", sourceIds: [initialSource.id], keywords: ["shared"] }] },
      versions: VERSIONS, observedAt: "2026-08-09T14:20:30.000Z",
      idempotencyKey: "memory-consolidation:retrieval-key-race:initial",
    });
    const source = await appendEvent(db, {
      aggregateId: "retrieval-key-race-next",
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.broadcast.committed", visibility: "SHARED",
      body: { text: "Next shared memory." },
      occurredAt: new Date("2026-08-09T14:21:00.000Z"),
      idempotencyKey: "memory-source:retrieval-key-race:next",
    });
    let signalKeyRead!: () => void;
    const keyRead = new Promise<void>((resolve) => { signalKeyRead = resolve; });
    let releaseKey!: () => void;
    const keyRelease = new Promise<void>((resolve) => { releaseKey = resolve; });
    let gated = false;
    const database = gatedTransactions(db, async (sql, run) => {
      const rows = await run();
      if (!gated && sql.includes("from aggregate_data_keys where aggregate_id=$1")) {
        gated = true;
        signalKeyRead();
        await keyRelease;
      }
      return rows;
    });
    const processing = processMemoryEvent(createMemoryWorkerContext(database), {
      scope: "MAIN_SHARED", sourceEventId: source.id,
      events: [{ id: source.id, at: source.occurredAt.toISOString(), text: "Next shared memory." }],
      extracted: { facts: [{ text: "Next shared memory", sourceIds: [source.id], keywords: ["shared"] }] },
      versions: VERSIONS, observedAt: "2026-08-09T14:21:30.000Z",
      idempotencyKey: "memory-consolidation:retrieval-key-race:next",
    });
    await keyRead;
    const deletionOutcome = await db.transaction(async (transaction) => {
      await transaction.query("set local lock_timeout='200ms'");
      await transaction.query(
        "delete from aggregate_data_keys where aggregate_id='memory-retrieval:main:v1'",
      );
      return "DELETED";
    }).catch((error: unknown) => error instanceof Error ? error.message : String(error));
    releaseKey();
    const processingOutcome = await processing.then(() => "COMMITTED")
      .catch((error: unknown) => error instanceof Error ? error.message : String(error));
    expect(deletionOutcome).toMatch(/lock timeout/iu);
    expect(processingOutcome).toBe("COMMITTED");
    expect((await db.one<{ definition: string }>(
      `select pg_get_functiondef('validate_memory_record_authority'::regproc) definition`,
    )).definition.toLowerCase()).toContain("for key share");
  }, 20_000);

  it("serializes concurrent exact equivalence roots across Main and Public aggregates", async () => {
    for (const scope of ["MAIN_SHARED", "PUBLIC"] as const) {
      const { db } = await testContext();
      let arrivals = 0;
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let allArrived!: () => void;
      const arrived = new Promise<void>((resolve) => { allArrived = resolve; });
      const makeDatabase = () => {
        if (scope === "MAIN_SHARED") return db;
        let tripped = false;
        return gatedTransactions(db, async (sql, run) => {
          if (!tripped && sql.includes("insert into memory_records")) {
            tripped = true;
            arrivals += 1;
            if (arrivals === 2) allArrived();
            await released;
          }
          return run();
        });
      };
      const inputs = await Promise.all([0, 1].map(async (index) => {
        const source = await appendEvent(db, {
          aggregateId: `${scope.toLowerCase()}-equivalence-concurrent-${index}`,
          actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
          type: scope === "PUBLIC" ? "commentary.published" : "main.broadcast.committed",
          visibility: scope === "PUBLIC" ? "PUBLIC" : "SHARED",
          body: { text: "Concurrent exact fact." },
          occurredAt: new Date(`2026-08-09T14:3${index}:00.000Z`),
          idempotencyKey: `memory-source:equivalence-concurrent:${scope}:${index}`,
        });
        return {
          scope, sourceEventId: source.id,
          events: [{ id: source.id, at: source.occurredAt.toISOString(), text: "Concurrent exact fact." }],
          extracted: { facts: [{ text: "Concurrent exact fact", sourceIds: [source.id] }] },
          versions: VERSIONS, observedAt: `2026-08-09T14:3${index}:30.000Z`,
          idempotencyKey: `memory-consolidation:equivalence-concurrent:${scope}:${index}`,
        } as const;
      }));
      const first = processMemoryEvent(createMemoryWorkerContext(makeDatabase()), inputs[0]);
      const second = processMemoryEvent(createMemoryWorkerContext(makeDatabase()), inputs[1]);
      if (scope === "PUBLIC") {
        await arrived;
        release();
      }
      const results = await Promise.all([first, second]);
      expect(await db.one<{ sets: number; links: number }>(
        `select (select count(*)::int from memory_equivalence_sets) sets,
                (select count(*)::int from memory_equivalence_links) links`,
      )).toEqual({ sets: 1, links: 1 });
      const root = await db.one<{ canonical_memory_id: string }>(
        "select canonical_memory_id::text from memory_equivalence_sets",
      );
      expect(results.flatMap((result) => result.memories.map((memory) => memory.id)))
        .toContain(root.canonical_memory_id);
    }
  }, 30_000);

  it("keeps exact equivalence links as an older-rooted forest", async () => {
    const { db } = await testContext();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const source = await appendEvent(db, {
        aggregateId: "public-equivalence-forest", actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        type: "commentary.published", visibility: "PUBLIC", body: { text: "Same fact." },
        occurredAt: new Date(`2026-08-09T15:00:0${index}.000Z`),
        idempotencyKey: `memory-source:equivalence-forest:${index}`,
      });
      const processed = await processMemoryEvent(createMemoryWorkerContext(db), {
        scope: "PUBLIC", sourceEventId: source.id,
        events: [{ id: source.id, at: source.occurredAt.toISOString(), text: "Same fact." }],
        extracted: { facts: [{ text: "Same fact", sourceIds: [source.id] }] },
        versions: VERSIONS, observedAt: `2026-08-09T15:01:0${index}.000Z`,
        idempotencyKey: `memory-consolidation:equivalence-forest:${index}`,
      });
      ids.push(processed.memories[0].id);
    }
    expect(await db.query<{ memory_id: string; equivalent_memory_id: string }>(
      `select memory_id::text,equivalent_memory_id::text from memory_equivalence_links
       order by memory_id`,
    )).toHaveLength(2);
    await expect(db.query(
      `insert into memory_equivalence_links (memory_id,equivalent_memory_id,created_at)
       values ($1,$2,clock_timestamp())`, [ids[0], ids[1]],
    )).rejects.toThrow("MEMORY_EQUIVALENCE_FOREST_MISMATCH");
    await expect(db.query(
      `insert into memory_equivalence_links (memory_id,equivalent_memory_id,created_at)
       values ($1,$2,clock_timestamp())`, [ids[1], ids[2]],
    )).rejects.toThrow("MEMORY_EQUIVALENCE_FOREST_MISMATCH");
  });

  it("does not cap exact equivalence discovery after five hundred repeated facts", async () => {
    const { db } = await testContext();
    for (let index = 0; index < 502; index += 1) {
      const source = await appendEvent(db, {
        aggregateId: "public-equivalence-scale", actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        type: "commentary.published", visibility: "PUBLIC", body: { text: "Repeated fact." },
        occurredAt: new Date(1_786_270_000_000 + index * 1_000),
        idempotencyKey: `memory-source:equivalence-scale:${index}`,
      });
      await processMemoryEvent(createMemoryWorkerContext(db), {
        scope: "PUBLIC", sourceEventId: source.id,
        events: [{ id: source.id, at: source.occurredAt.toISOString(), text: "Repeated fact." }],
        extracted: { facts: [{ text: "Repeated fact", sourceIds: [source.id] }] },
        versions: VERSIONS, observedAt: new Date(1_786_270_700_000 + index * 1_000).toISOString(),
        idempotencyKey: `memory-consolidation:equivalence-scale:${index}`,
      });
    }
    expect(await db.one<{ records: number; links: number }>(
      `select (select count(*)::int from memory_records) records,
              (select count(*)::int from memory_equivalence_links) links`,
    )).toEqual({ records: 502, links: 501 });
  }, 180_000);

  it("rejects checkpoint deletion and preserves the monotonic cursor", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateSource(db, "checkpoint-delete");
    await processMemoryEvent(
      createMemoryWorkerContext(db), workerInput(fixture, "checkpoint-delete"),
    );
    const key = `private_account:conversation:${fixture.conversationId}`;
    const before = await db.one<{ source_event_id: string; source_ingested_sequence: string }>(
      `select source_event_id::text,source_ingested_sequence::text
       from memory_projection_checkpoints where projection_key=$1`, [key],
    );
    await expect(db.query(
      "delete from memory_projection_checkpoints where projection_key=$1", [key],
    )).rejects.toThrow("IMMUTABLE_MEMORY_CHECKPOINT");
    expect(await db.one<{ source_event_id: string; source_ingested_sequence: string }>(
      `select source_event_id::text,source_ingested_sequence::text
       from memory_projection_checkpoints where projection_key=$1`, [key],
    )).toEqual(before);
  });
});
