import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  reconcileMemories,
  resolveMemoryEntityAlias,
} from "../../lib/server/consolidation/conflicts";
import {
  authorizeMemoryGraphTraversal,
  createMemoryGraphWriterContext,
  graphTraversalContract,
  traverseMemoryGraph,
  versionMemoryGraph,
} from "../../lib/server/consolidation/graph";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import { canonicalContentDigest, canonicalJson } from "../../lib/server/events/integrity";
import type { EventDatabase } from "../../lib/server/events/types";
import { appendMessage } from "../../lib/server/history/messages";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import { createProposal, transitionProposal } from "../../lib/server/orchestration/proposals";
import {
  createMemoryWorkerContext,
  deriveMemorySearchTermDigest,
  processMemoryEvent,
} from "../../worker/consolidation/process-event";
import {
  createConversationFixture,
  testContext,
  type TestDatabase,
} from "../helpers/postgres";

const VERSIONS = Object.freeze({
  promptVersion: "memory-graph-prompt-v1",
  modelVersion: "deterministic-test-provider-v1",
  extractorVersion: "memory-extractor-v1",
  embeddingVersion: "memory-embedding-v1",
});

const OLD_AT = "2026-08-01T10:00:00.000Z";
const NEW_AT = "2026-08-09T10:00:00.000Z";

function digest(value: string): string {
  return canonicalContentDigest({ value });
}

async function databaseFuture(db: EventDatabase, milliseconds: number): Promise<string> {
  const { now } = await db.one<{ now: Date }>("select clock_timestamp() now");
  return new Date(now.getTime() + milliseconds).toISOString();
}

async function seedPrivateGraphMemories(db: TestDatabase, label: string) {
  const identity = await createConversationFixture(`Graph ${label}`, db);
  const oldSource = await appendEvent(db, {
    aggregateId: identity.conversationId,
    accountId: identity.accountId,
    actor: { type: "USER", id: identity.accountId },
    type: "message.completed",
    visibility: "PRIVATE_ACCOUNT",
    body: { text: "My AAPL bias is bullish." },
    occurredAt: new Date(OLD_AT),
    idempotencyKey: `memory-graph-source:${label}:old`,
  });
  const newSource = await appendEvent(db, {
    aggregateId: identity.conversationId,
    accountId: identity.accountId,
    actor: { type: "USER", id: identity.accountId },
    type: "message.completed",
    visibility: "PRIVATE_ACCOUNT",
    body: { text: "My AAPL bias is now neutral." },
    occurredAt: new Date(NEW_AT),
    idempotencyKey: `memory-graph-source:${label}:new`,
  });
  const projected = await processMemoryEvent(createMemoryWorkerContext(db), {
    scope: "PRIVATE_ACCOUNT",
    accountId: identity.accountId,
    nodeBrainId: identity.nodeBrainId,
    conversationId: identity.conversationId,
    sourceEventId: newSource.id,
    events: [
      { id: oldSource.id, at: OLD_AT, text: "My AAPL bias is bullish." },
      { id: newSource.id, at: NEW_AT, text: "My AAPL bias is now neutral." },
    ],
    extracted: { facts: [
      {
        text: "AAPL bias is bullish", sourceIds: [oldSource.id],
        entities: ["AAPL", "Apple Inc."], keywords: ["bias", "bullish"],
        validFrom: OLD_AT, validTo: "2026-08-20T10:00:00.000Z",
        conflictState: "SUPERSEDED" as const,
      },
      {
        text: "AAPL bias is neutral", sourceIds: [newSource.id],
        entities: ["AAPL"], keywords: ["bias", "neutral"], validFrom: NEW_AT,
      },
    ] },
    versions: VERSIONS,
    observedAt: "2026-08-09T10:01:00.000Z",
    idempotencyKey: `memory-graph-consolidation:${label}`,
  });
  const memories = [...projected.memories].sort((left, right) => (
    left.validFrom.localeCompare(right.validFrom)
  ));
  return Object.freeze({ ...identity, oldSource, newSource, memories });
}

function graphInput(
  fixture: Awaited<ReturnType<typeof seedPrivateGraphMemories>>,
  label: string,
) {
  return rawGraphInput(fixture, label);
}

function rawGraphInput(
  fixture: Awaited<ReturnType<typeof seedPrivateGraphMemories>>,
  label: string,
  entityId = randomUUID(),
) {
  return Object.freeze({
    scope: "PRIVATE_ACCOUNT" as const,
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    idempotencyKey: `memory-graph-raw:${label}`,
    reconcilerVersion: "temporal-memory-graph-v2",
    observedAt: "2026-08-09T10:02:00.000Z",
    entities: Object.freeze([{
      id: entityId,
      type: "INSTRUMENT" as const,
      canonicalName: "AAPL",
      validFrom: OLD_AT,
      aliases: Object.freeze([
        {
          alias: "AAPL", validFrom: OLD_AT,
          sourceIds: Object.freeze([fixture.oldSource.id, fixture.newSource.id]),
        },
        {
          alias: "Apple Inc.", validFrom: OLD_AT,
          sourceIds: Object.freeze([fixture.oldSource.id]),
        },
      ]),
    }]),
    claims: Object.freeze([
      {
        memoryId: fixture.memories[0]!.id,
        entityId,
        nodeType: "BELIEF" as const,
        predicate: "bias",
        value: "bullish",
        approved: true,
        validFrom: OLD_AT,
        validTo: fixture.memories[0]!.validTo!,
        sourceIds: Object.freeze([fixture.oldSource.id]),
      },
      {
        memoryId: fixture.memories[1]!.id,
        entityId,
        nodeType: "BELIEF" as const,
        predicate: "bias",
        value: "neutral",
        approved: true,
        validFrom: NEW_AT,
        sourceIds: Object.freeze([fixture.newSource.id]),
      },
    ]),
  });
}

async function appendGraphMemory(
  fixture: Awaited<ReturnType<typeof seedPrivateGraphMemories>>,
  label: string,
  value: string,
  at: string,
) {
  const source = await appendEvent(fixture.db, {
    aggregateId: fixture.conversationId,
    accountId: fixture.accountId,
    actor: { type: "USER", id: fixture.accountId },
    type: "message.completed",
    visibility: "PRIVATE_ACCOUNT",
    body: { text: `My AAPL bias is now ${value}.` },
    occurredAt: new Date(at),
    idempotencyKey: `memory-graph-source:${label}`,
  });
  const projected = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
    scope: "PRIVATE_ACCOUNT",
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventId: source.id,
    events: [{ id: source.id, at, text: `My AAPL bias is now ${value}.` }],
    extracted: { facts: [{
      text: `AAPL bias is ${value}`, sourceIds: [source.id], entities: ["AAPL"],
      keywords: ["bias", value], validFrom: at,
    }] },
    versions: VERSIONS,
    observedAt: new Date(new Date(at).getTime() + 60_000).toISOString(),
    idempotencyKey: `memory-graph-consolidation:${label}`,
  });
  return Object.freeze({ source, memory: projected.memories[0]! });
}

async function appendManyGraphMemories(
  fixture: Awaited<ReturnType<typeof seedPrivateGraphMemories>>,
  label: string,
  phase: "old" | "new",
  at: string,
  extraSource = false,
) {
  const content = Array.from({ length: 100 }, (_, index) => (
    `AAPL predicate-${index} is ${phase}-${index}.`
  )).join(" ");
  const additional = extraSource ? await appendEvent(fixture.db, {
    aggregateId: fixture.conversationId,
    accountId: fixture.accountId,
    actor: { type: "USER", id: fixture.accountId },
    type: "message.completed",
    visibility: "PRIVATE_ACCOUNT",
    body: { text: content },
    occurredAt: new Date(new Date(at).getTime() - 1),
    idempotencyKey: `memory-graph-many-source:${label}:${phase}:additional`,
  }) : null;
  const source = await appendEvent(fixture.db, {
    aggregateId: fixture.conversationId,
    accountId: fixture.accountId,
    actor: { type: "USER", id: fixture.accountId },
    type: "message.completed",
    visibility: "PRIVATE_ACCOUNT",
    body: { text: content },
    occurredAt: new Date(at),
    idempotencyKey: `memory-graph-many-source:${label}:${phase}`,
  });
  const sourceIds = [...(additional === null ? [] : [additional.id]), source.id];
  const facts = Array.from({ length: 100 }, (_, index) => ({
    text: `AAPL predicate-${index} is ${phase}-${index} with shared-predicate shared-value`,
    sourceIds,
    entities: ["AAPL"],
      keywords: ["shared-predicate", "shared-value", `predicate-${index}`, `${phase}-${index}`],
    validFrom: at,
  }));
  const projected = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
    scope: "PRIVATE_ACCOUNT",
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventId: source.id,
    events: [...(additional === null ? [] : [{ id: additional.id,
      at: additional.occurredAt.toISOString(), text: content }]),
      { id: source.id, at, text: content }],
    extracted: { facts },
    versions: VERSIONS,
    observedAt: new Date(new Date(at).getTime() + 60_000).toISOString(),
    idempotencyKey: `memory-graph-many-consolidation:${label}:${phase}`,
  });
  return Object.freeze({ source, additional, memories: projected.memories });
}

async function queueAccountNullGraph(
  db: TestDatabase,
  scope: "PUBLIC" | "MAIN_SHARED" | "CHALLENGE_SHARED",
) {
  const label = scope.toLowerCase();
  const at = "2026-08-26T10:00:00.000Z";
  const source = await appendEvent(db, {
    aggregateId: `memory-graph-account-null:${label}`,
    actor: scope === "CHALLENGE_SHARED"
      ? { type: "SYSTEM" as const, id: "challenge-stage-lifecycle" }
      : { type: "MAIN_BRAIN" as const, id: "gustavo-main" },
    type: scope === "PUBLIC" ? "commentary.published"
      : scope === "MAIN_SHARED" ? "main.broadcast.committed" : "challenge.passed",
    visibility: scope === "PUBLIC" ? "PUBLIC" : "SHARED",
    body: { text: `Account-null ${scope} graph authority.` },
    occurredAt: new Date(at), idempotencyKey: `memory-graph-account-null:${label}:source`,
  });
  const projected = await processMemoryEvent(createMemoryWorkerContext(db), {
    scope, sourceEventId: source.id,
    events: [{ id: source.id, at, text: `Account-null ${scope} graph authority.` }],
    extracted: { facts: Array.from({ length: 100 }, (_, index) => ({
      text: `Account-null fact ${index}`, sourceIds: [source.id],
      entities: [`account-null-${label}`],
      keywords: ["shared-predicate", "shared-value", `fact-${index}`], validFrom: at,
    })) },
    versions: VERSIONS, observedAt: "2026-08-26T10:01:00.000Z",
    idempotencyKey: `memory-graph-account-null:${label}:consolidation`,
  });
  const entityId = randomUUID();
  return versionMemoryGraph(createMemoryGraphWriterContext(db), {
    scope, idempotencyKey: `memory-graph-account-null:${label}:graph`,
    reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-26T10:02:00.000Z",
    entities: [{ id: entityId, type: "INSTRUMENT" as const,
      canonicalName: `account-null-${label}`, validFrom: at,
      aliases: [{ alias: `account-null-${label}`, validFrom: at, sourceIds: [source.id] }] }],
    claims: projected.memories.map((memory) => ({ memoryId: memory.id, entityId,
      nodeType: "FACT" as const, predicate: "shared-predicate", value: "shared-value",
      approved: true, validFrom: at, sourceIds: [source.id] })),
  });
}

function queryCountingDatabase(db: EventDatabase) {
  let count = 0;
  const wrap = (delegate: EventDatabase): EventDatabase => ({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ) => {
      count += 1;
      return delegate.query<Row>(sql, parameters);
    },
    one: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ) => {
      count += 1;
      return delegate.one<Row>(sql, parameters);
    },
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      delegate.transaction((transaction) => work(wrap(transaction)))
    ),
  });
  return Object.freeze({ db: wrap(db), queries: () => count });
}

function transactionPidDatabase(db: TestDatabase) {
  const pids: number[] = [];
  const observed: EventDatabase = {
    query: (sql, parameters) => db.query(sql, parameters),
    one: (sql, parameters) => db.one(sql, parameters),
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      db.transaction(async (transaction) => {
        pids.push((await transaction.one<{ pid: number }>("select pg_backend_pid() pid")).pid);
        return work(transaction);
      })
    ),
  };
  return Object.freeze({ db: observed as TestDatabase, pids,
    clear: () => { pids.length = 0; } });
}

function transactionGate(db: TestDatabase, marker: string) {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const pauseAtMarker = async <Row extends Record<string, unknown>>(
    sql: string,
    run: () => Promise<Row[]>,
  ): Promise<Row[]> => {
    const rows = await run();
    if (sql.includes(marker)) {
      entered();
      await blocked;
    }
    return rows;
  };
  const observed: EventDatabase = {
    query: (sql: string, parameters?: readonly unknown[]) => db.query(sql, parameters),
    one: (sql: string, parameters?: readonly unknown[]) => db.one(sql, parameters),
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      db.transaction((transaction) => {
        const wrapped: EventDatabase = {
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<Row[]> => pauseAtMarker(sql, () => transaction.query<Row>(sql, parameters)),
          one: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<Row> => (await pauseAtMarker(sql, async () => [
            await transaction.one<Row>(sql, parameters),
          ]))[0]!,
          transaction: <Nested>(nested: (inner: typeof wrapped) => Promise<Nested>) => nested(wrapped),
        };
        return work(wrapped as typeof observed);
      })
    ),
  };
  return { observed: observed as TestDatabase, reached, release };
}

describe("temporal memory conflict policy", () => {
  it("keeps both sourced claims and prefers the current approved version", () => {
    const result = reconcileMemories([
      {
        id: "old", entityId: "e-aapl", predicate: "BIAS", value: "BULLISH",
        validFrom: "2026-08-01T00:00:00Z", approved: true, sourceIds: ["s1"],
      },
      {
        id: "new", entityId: "e-aapl", predicate: "BIAS", value: "NEUTRAL",
        validFrom: "2026-08-09T00:00:00Z", approved: true, sourceIds: ["s2"],
      },
    ]);
    expect(result.current.id).toBe("new");
    expect(result.edges).toContainEqual({ from: "new", type: "CONTRADICTS", to: "old" });
    expect(result.edges).toContainEqual({ from: "new", type: "SUPERSEDES", to: "old" });
    expect(result.preserved.map((memory) => memory.id)).toEqual(["old", "new"]);
    expect(result.conflicts).toEqual([{
      newer: "new", older: "old", preferred: "new", sourceIds: ["s1", "s2"],
    }]);
  });

  it("does not let a newer unapproved claim displace approved state", () => {
    const result = reconcileMemories([
      {
        id: "approved", entityId: "entity", predicate: "METHOD", value: "ONE",
        validFrom: "2026-08-01T00:00:00.000Z", approved: true, sourceIds: ["one"],
      },
      {
        id: "candidate", entityId: "entity", predicate: "METHOD", value: "TWO",
        validFrom: "2026-08-02T00:00:00.000Z", approved: false, sourceIds: ["two"],
      },
    ]);
    expect(result.current.id).toBe("approved");
    expect(result.edges).toEqual([{
      from: "candidate", type: "CONTRADICTS", to: "approved",
    }]);
    expect(result.conflicts[0]?.preferred).toBe("approved");
  });

  it("uses half-open validity intervals and does not silently blend equal claims", () => {
    const nonOverlapping = reconcileMemories([
      {
        id: "historical", entityId: "entity", predicate: "STATE", value: "OLD",
        validFrom: "2026-08-01T00:00:00.000Z", validTo: "2026-08-02T00:00:00.000Z",
        approved: true, sourceIds: ["one"],
      },
      {
        id: "current", entityId: "entity", predicate: "STATE", value: "NEW",
        validFrom: "2026-08-02T00:00:00.000Z", approved: true, sourceIds: ["two"],
      },
    ]);
    expect(nonOverlapping.edges).toEqual([{
      from: "current", type: "SUPERSEDES", to: "historical",
    }]);
    expect(nonOverlapping.conflicts).toEqual([]);

    const equal = reconcileMemories([
      {
        id: "one", entityId: "entity", predicate: "STATE", value: "SAME",
        validFrom: "2026-08-01T00:00:00.000Z", approved: true, sourceIds: ["one"],
      },
      {
        id: "two", entityId: "entity", predicate: "STATE", value: "SAME",
        validFrom: "2026-08-02T00:00:00.000Z", approved: true, sourceIds: ["two"],
      },
    ]);
    expect(equal.current.id).toBe("two");
    expect(equal.edges).toEqual([]);
    expect(equal.preserved).toHaveLength(2);
  });

  it("reconciles the exact 101-claim incremental group maximum without dropping conflicts", () => {
    const claims = Array.from({ length: 101 }, (_, index) => ({
      id: `claim-${String(index).padStart(3, "0")}`, entityId: "entity",
      predicate: "STATE", value: `VALUE-${index}`,
      validFrom: "2026-08-09T00:00:00.000Z", approved: true,
      sourceIds: [`source-${index}`],
    }));
    const result = reconcileMemories(claims);
    expect(result.preserved).toHaveLength(101);
    expect(result.conflicts).toHaveLength(5_050);
    expect(result.edges.filter(({ type }) => type === "CONTRADICTS")).toHaveLength(5_050);
    expect(result.edges.filter(({ type }) => type === "SUPERSEDES")).toHaveLength(100);
    expect(result.edges).toHaveLength(5_150);
    expect(() => reconcileMemories([...claims, { ...claims[0]!, id: "claim-101" }]))
      .toThrow("MEMORY_CONFLICT_LIMIT_EXCEEDED");
  });

  it("publishes mathematically complete durable graph maxima without topology truncation", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    expect(graphModule).toHaveProperty("memoryGraphCapacityContract");
    expect((graphModule as unknown as { memoryGraphCapacityContract: () => unknown })
      .memoryGraphCapacityContract()).toEqual({
      maximumRequestedClaims: 100,
      maximumEntities: 50,
      maximumIncrementalCandidates: 200,
      maximumReconciliationGroup: 101,
      maximumConflicts: 5_050,
      maximumRequiredGeneratedEdges: 5_150,
      maximumTypedRelationships: 437_800,
      maximumDerivedEdgesAtFullIncrement: 358_200,
      maximumDurableEdges: 358_400,
      maximumSynchronousEdges: 5_150,
      maximumSynchronousEdgeSources: 10_300,
      maximumSynchronousMaterializationRows: 100_000,
      maximumNormalizedJobSources: 100_000,
      maximumNormalizedJobSourceSets: 1_200,
      oversizedWork: "ENCRYPTED_RESUMABLE_JOB",
    });
    const maximumGroupsAcrossFiftyEntities = 50 * 2;
    const fullIncrementCandidates = 100 + maximumGroupsAcrossFiftyEntities;
    expect(9 * fullIncrementCandidates * (fullIncrementCandidates - 1)).toBe(358_200);
    expect(358_200 + maximumGroupsAcrossFiftyEntities * 2).toBe(358_400);
    const [graph, migration] = await Promise.all([
      readFile("lib/server/consolidation/graph.ts", "utf8"),
      readFile("db/migrations/0016_memory_graph.sql", "utf8"),
    ]);
    expect(graph).not.toMatch(/unique\.values\(\)\]\.slice/iu);
    expect(migration).toMatch(/edge_count integer[^\n]+358400/iu);
    expect(migration).toMatch(/conflict_count integer[^\n]+5050/iu);
    expect(migration).toMatch(/relation_count integer[^\n]+358400/iu);
    expect(migration).toMatch(
      /memory_graph_reconciliation_job_transitions[\s\S]+edge_offset[\s\S]+edge_source_offset/iu,
    );
    expect(migration).toMatch(
      /source_event_ids uuid\[\][^\n]+cardinality\(source_event_ids\) between 1 and 100000/iu,
    );
    expect(migration).toMatch(
      /memory_graph_reconciliation_job_source_sets[\s\S]+ordinal between 0 and 1199/iu,
    );
  });

  it("publishes the resumable reconciliation and total-work authority envelope", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    for (const api of [
      "claimMemoryGraphReconciliationJob",
      "progressMemoryGraphReconciliationJob",
      "completeMemoryGraphReconciliationJob",
      "failMemoryGraphReconciliationJob",
    ]) expect(graphModule).toHaveProperty(api);
    expect((graphModule as unknown as { memoryGraphCapacityContract: () => Record<string, unknown> })
      .memoryGraphCapacityContract()).toMatchObject({
      maximumSynchronousMaterializationRows: 100_000,
      oversizedWork: "ENCRYPTED_RESUMABLE_JOB",
    });
    const maximumMaterializationRows = 50 * 3 + 50 * 20 * (2 + 500)
      + 100 * (2 + 500) + 100 * 2;
    expect(maximumMaterializationRows).toBe(552_550);
    const [graph, migration] = await Promise.all([
      readFile("lib/server/consolidation/graph.ts", "utf8"),
      readFile("db/migrations/0016_memory_graph.sql", "utf8"),
    ]);
    for (const table of [
      "memory_graph_reconciliation_job_entities",
      "memory_graph_reconciliation_job_aliases",
      "memory_graph_reconciliation_job_sources",
      "memory_graph_reconciliation_job_source_sets",
      "memory_graph_reconciliation_job_candidates",
      "memory_graph_reconciliation_job_transitions",
      "memory_graph_reconciliation_job_transition_manifests",
    ]) expect(migration).toContain(`create table ${table}`);
    expect(migration).toMatch(/memory_graph_expected_reconciliation_job_body_digest/iu);
    expect(migration).toMatch(/prior\.to_status='CLAIMED'[\s\S]+prior\.lease_until<=clock_timestamp\(\)[\s\S]+new\.to_status='CLAIMED'/iu);
    for (const relation of ["memory_graph_entities", "memory_graph_entity_aliases",
      "memory_graph_alias_sources", "memory_graph_nodes", "memory_graph_node_sources"]) {
      expect(graph).toMatch(new RegExp(`jsonb_to_recordset[\\s\\S]+insert into ${relation}`, "iu"));
    }
  });

  it("resolves temporal aliases independently and rejects ambiguous alias eras", () => {
    const aliases = [
      {
        alias: "AAPL", entityId: "e-aapl", validFrom: "2020-01-01T00:00:00.000Z",
      },
      {
        alias: "Apple Inc.", entityId: "e-aapl", validFrom: "2020-01-01T00:00:00.000Z",
      },
    ];
    expect(resolveMemoryEntityAlias(" aapl ", aliases, NEW_AT)).toBe("e-aapl");
    const reconciled = reconcileMemories([
      {
        id: "old", entityId: "Apple Inc.", predicate: "BIAS", value: "BULLISH",
        validFrom: OLD_AT, approved: true, sourceIds: ["one"],
      },
      {
        id: "new", entityId: "AAPL", predicate: "BIAS", value: "NEUTRAL",
        validFrom: NEW_AT, approved: true, sourceIds: ["two"],
      },
    ], { aliases });
    expect(reconciled.current.entityId).toBe("e-aapl");
    expect(reconciled.preserved.map(({ entityId }) => entityId)).toEqual(["e-aapl", "e-aapl"]);
    expect(() => resolveMemoryEntityAlias("AAPL", [
      ...aliases,
      { alias: "aapl", entityId: "other", validFrom: "2021-01-01T00:00:00.000Z" },
    ], NEW_AT)).toThrow("MEMORY_ALIAS_AMBIGUOUS");
  });

  it("copies and freezes source-bearing output and rejects malformed or hostile input", () => {
    const sourceIds = ["source"];
    const claims = [{
      id: "one", entityId: "entity", predicate: "STATE", value: "ONE",
      validFrom: OLD_AT, approved: true, sourceIds,
    }];
    const result = reconcileMemories(claims);
    sourceIds.push("late");
    expect(result.current.sourceIds).toEqual(["source"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.current)).toBe(true);
    expect(Object.isFrozen(result.current.sourceIds)).toBe(true);
    expect(() => reconcileMemories([{ ...claims[0], sourceIds: [] }]))
      .toThrow("MEMORY_CONFLICT_SOURCE_REQUIRED");
    expect(() => reconcileMemories([{ ...claims[0], validTo: OLD_AT }]))
      .toThrow("MEMORY_CONFLICT_VALIDITY_INVALID");
    expect(() => reconcileMemories([
      claims[0], { ...claims[0], id: "two", predicate: "OTHER" },
    ])).toThrow("MEMORY_CONFLICT_GROUP_MISMATCH");
    const getter = vi.fn(() => claims);
    const accessor = Object.defineProperty({}, "0", { get: getter, enumerable: true });
    expect(() => reconcileMemories(accessor)).toThrow("MEMORY_CONFLICT_INPUT_INVALID");
    expect(getter).not.toHaveBeenCalled();
    expect(() => reconcileMemories(new Proxy(claims, {})))
      .toThrow("MEMORY_CONFLICT_INPUT_INVALID");
    expect(() => reconcileMemories(Array.from({ length: 102 }, (_, index) => ({
      ...claims[0], id: `claim-${index}`,
    })))).toThrow("MEMORY_CONFLICT_LIMIT_EXCEEDED");
  });
});

describe("PostgreSQL temporal memory graph authority", () => {
  it("persists entities, temporal aliases, nodes, sources, conflicts, and versioned edges", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "authority");
    const input = graphInput(fixture, "authority");
    const result = await versionMemoryGraph(createMemoryGraphWriterContext(db), input);
    expect(result.currentMemoryIds).toEqual([fixture.memories[1]!.id]);
    expect(result.edges.map(({ type }) => type).sort()).toEqual(["CONTRADICTS", "SUPERSEDES"]);
    expect(result.conflicts).toHaveLength(1);
    expect(await db.one<Record<string, number>>(`select
      (select count(*)::int from memory_graph_reconciliation_runs) runs,
      (select count(*)::int from memory_graph_entities) entities,
      (select count(*)::int from memory_graph_entity_aliases) aliases,
      (select count(*)::int from memory_graph_nodes) nodes,
      (select count(*)::int from memory_graph_node_sources) node_sources,
      (select count(*)::int from memory_graph_edges) edges,
      (select count(*)::int from memory_graph_edge_sources) edge_sources,
      (select count(*)::int from memory_conflicts) conflicts,
      (select count(*)::int from memory_conflict_sources) conflict_sources`)).toEqual({
        runs: 1, entities: 1, aliases: 2, nodes: 2, node_sources: 2,
        edges: 2, edge_sources: 4, conflicts: 1, conflict_sources: 2,
      });
    const rows = await db.query<{
      public_label: string | null; public_alias: string | null;
      public_predicate: string | null; public_value: string | null;
    }>(`select entity.public_label,alias.public_alias,node.public_predicate,node.public_value
        from memory_graph_entities entity
        join memory_graph_entity_aliases alias on alias.entity_id=entity.id
        join memory_graph_nodes node on node.entity_id=entity.id`);
    expect(rows.every((row) => row.public_label === null && row.public_alias === null
      && row.public_predicate === null && row.public_value === null)).toBe(true);
    expect(JSON.stringify(await db.query(
      `select to_jsonb(entity) entity from memory_graph_entities entity`,
    ))).not.toContain("AAPL");
  }, 20_000);

  it("is operation-idempotent under replay and concurrency and rejects key reuse", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "idempotency");
    const input = graphInput(fixture, "idempotency");
    const [left, right] = await Promise.all([
      versionMemoryGraph(createMemoryGraphWriterContext(db), input),
      versionMemoryGraph(createMemoryGraphWriterContext(db), input),
    ]);
    expect(right).toEqual(left);
    expect(await versionMemoryGraph(createMemoryGraphWriterContext(db), input)).toEqual(left);
    const alternateKey = { ...input, idempotencyKey: "memory-graph:idempotency-alternate" };
    expect(await versionMemoryGraph(createMemoryGraphWriterContext(db), alternateKey)).toEqual(left);
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...alternateKey,
      claims: alternateKey.claims.map((claim, index) => (
        index === 1 ? { ...claim, approved: false } : claim
      )),
    })).rejects.toThrow("MEMORY_GRAPH_IDEMPOTENCY_KEY_REUSED");
    expect(await db.one<{ runs: number; edges: number }>(
      `select (select count(*)::int from memory_graph_reconciliation_runs) runs,
              (select count(*)::int from memory_graph_edges) edges`,
    )).toEqual({ runs: 1, edges: 2 });
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...input,
      claims: input.claims.map((claim, index) => (
        index === 1 ? { ...claim, approved: false } : claim
      )),
    })).rejects.toThrow("MEMORY_GRAPH_IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects cross-account topology and direct-SQL source or approval forgery", async () => {
    const { db } = await testContext();
    const owner = await seedPrivateGraphMemories(db, "owner");
    const foreign = await seedPrivateGraphMemories(db, "foreign");
    const input = graphInput(owner, "scope");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), input);
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...input,
      idempotencyKey: "memory-graph:foreign-memory",
      entities: input.entities.map((entity) => ({
        ...entity,
        aliases: entity.aliases.map((alias) => ({
          ...alias, sourceIds: [foreign.oldSource.id],
        })),
      })),
      claims: [{
        ...input.claims[0], memoryId: foreign.memories[0]!.id,
        sourceIds: [foreign.oldSource.id],
      }],
    })).rejects.toThrow("MEMORY_GRAPH_MEMORY_AUTHORITY_INVALID");
    await expect(db.query(
      `insert into memory_graph_node_sources(memory_id,ordinal,source_event_id)
       values ($1,99,$2)`,
      [owner.memories[0]!.id, owner.newSource.id],
    )).rejects.toThrow("MEMORY_GRAPH_NODE_SOURCE_INVALID");
    await expect(db.query(
      `update memory_graph_nodes set approved=false where memory_id=$1`,
      [owner.memories[0]!.id],
    )).rejects.toThrow("IMMUTABLE_MEMORY_GRAPH");
    await expect(db.query(
      `update memory_graph_edges set valid_to=clock_timestamp() where id=$1`,
      [(await db.one<{ id: string }>("select id::text from memory_graph_edges limit 1")).id],
    )).rejects.toThrow("IMMUTABLE_RECALL_TRACE");
  }, 20_000);

  it("fails incomplete direct-SQL graph runs at the transaction boundary", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "incomplete");
    await expect(db.transaction(async (transaction) => {
      await transaction.query(
        `insert into memory_graph_reconciliation_runs (
          id,operation_key,idempotency_key,request_digest,scope,account_id,node_brain_id,
          conversation_id,reconciler_version,observed_at,candidate_count,entity_count,
          alias_count,edge_count,conflict_count,created_at
        ) values ($1,$2,$3,$4,'PRIVATE_ACCOUNT',$5,$6,$7,'forged-v1',$8,1,1,0,0,0,$8)`,
        [randomUUID(), digest("operation"), "forged-incomplete", digest("request"),
          fixture.accountId, fixture.nodeBrainId, fixture.conversationId, NEW_AT],
      );
    })).rejects.toThrow("INCOMPLETE_MEMORY_GRAPH_RECONCILIATION");

    const input = graphInput(fixture, "deterministic-policy");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), input);
    await expect(db.transaction(async (transaction) => {
      const runId = randomUUID();
      const operationKey = digest("forged-policy-operation");
      const requestDigest = digest("forged-policy-request");
      await transaction.query(
        `insert into memory_graph_reconciliation_runs (
          id,operation_key,idempotency_key,request_digest,scope,account_id,node_brain_id,
          conversation_id,reconciler_version,observed_at,candidate_count,entity_count,
          alias_count,edge_count,conflict_count,current_count,created_at
        ) values ($1,$2,'forged-policy',$3,'PRIVATE_ACCOUNT',$4,$5,$6,
          'forged-v1',$7,2,1,0,0,0,1,$7)`,
        [runId, operationKey, requestDigest, fixture.accountId, fixture.nodeBrainId,
          fixture.conversationId, "2026-08-09T10:03:00.000Z"],
      );
      await transaction.query(
        `insert into memory_graph_idempotency_keys (
          idempotency_key,reconciliation_run_id,operation_key,request_digest,
          request_shape_digest,created_at
        ) values ('forged-policy',$1,$2,$3,$4,$5)`,
        [runId, operationKey, requestDigest, digest("forged-policy-shape"),
          "2026-08-09T10:03:00.000Z"],
      );
      await transaction.query(
        `insert into memory_graph_run_entities(
           reconciliation_run_id,entity_id,entity_version_id,ordinal
         ) select $1,$2,id,0 from memory_graph_entity_versions
           where entity_id=$2 order by created_at desc,id desc limit 1`,
        [runId, input.entities[0]!.id],
      );
      for (const [ordinal, memory] of fixture.memories.entries()) {
        await transaction.query(
          `insert into memory_graph_run_candidates(reconciliation_run_id,memory_id,ordinal)
           values ($1,$2,$3)`,
          [runId, memory.id, ordinal],
        );
      }
      const storedPredicate = await transaction.one<{ predicate_digest: string }>(
        "select predicate_digest from memory_graph_nodes where memory_id=$1",
        [fixture.memories[0]!.id],
      );
      await transaction.query(
        `insert into memory_graph_current_claims (
          reconciliation_run_id,memory_id,entity_id,predicate_digest
         ) values ($1,$2,$3,$4)`,
        [runId, fixture.memories[0]!.id, input.entities[0]!.id, storedPredicate.predicate_digest],
      );
    })).rejects.toThrow("INCOMPLETE_MEMORY_GRAPH_RECONCILIATION");
  }, 20_000);

  it("rejects an actual-digest arbitrary graph body before a direct-SQL manifest rebind", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "graph-body-forgery");
    const stored = await versionMemoryGraph(
      createMemoryGraphWriterContext(db), graphInput(fixture, "graph-body-forgery"),
    );
    const binding = await db.one<{
      graph_event_id: string; body_digest: string; expected_digest: string;
    }>(
      `select run.graph_event_id::text,body.body_digest,
              memory_graph_expected_event_body_digest(run.id) expected_digest
       from memory_graph_reconciliation_runs run
       join encrypted_event_bodies body on body.event_id=run.graph_event_id
       where run.id=$1`, [stored.reconciliationRunId],
    );
    expect(binding.body_digest).toBe(binding.expected_digest);
    await expect(db.transaction(async (transaction) => {
      const forged = await appendEvent(transaction, {
        aggregateId: fixture.conversationId, accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "memory-graph-reconciler" },
        type: "memory.edge.versioned", visibility: "PRIVATE_ACCOUNT",
        body: { arbitrary: "attacker-chosen-graph-body" },
        occurredAt: new Date(NEW_AT), idempotencyKey: "graph-body-forgery:event",
        policyVersion: "temporal-memory-graph-v2",
      });
      expect(await transaction.one<{ body_digest: string }>(
        "select body_digest from encrypted_event_bodies where event_id=$1", [forged.id],
      )).toEqual({ body_digest: canonicalContentDigest({ arbitrary: "attacker-chosen-graph-body" }) });
      await transaction.query(
        `insert into memory_graph_event_manifests (
           graph_event_id,reconciliation_run_id,memory_ids,source_event_ids,semantic_digest,
           relation_count,relation_digest,event_request_hash,event_integrity_hash,created_at
         ) select $1,manifest.reconciliation_run_id,manifest.memory_ids,manifest.source_event_ids,
                  manifest.semantic_digest,manifest.relation_count,manifest.relation_digest,
                  event.request_hash,event.integrity_hash,manifest.created_at
           from memory_graph_event_manifests manifest
           join events event on event.id=$1 where manifest.reconciliation_run_id=$2`,
        [forged.id, stored.reconciliationRunId],
      );
    })).rejects.toThrow("MEMORY_GRAPH_EVENT_BODY_INVALID");
  }, 30_000);

  it("rejects exact-body direct-SQL graph runs with any mismatched event envelope field", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "graph-envelope-forgery");
    const valid = await versionMemoryGraph(
      createMemoryGraphWriterContext(db), graphInput(fixture, "graph-envelope-forgery"),
    );
    const claim = await db.one<{
      memoryId: string; entityId: string; sourceIds: string[];
      validFrom: Date; validTo: Date | null;
    }>(
      `select current.memory_id::text "memoryId",current.entity_id::text "entityId",
              array_agg(source.source_event_id::text order by source.ordinal) "sourceIds",
              version.valid_from "validFrom",version.valid_to "validTo"
       from memory_graph_current_claims current
       join memory_graph_node_sources source on source.memory_id=current.memory_id
       join memory_graph_run_entities member on member.reconciliation_run_id=current.reconciliation_run_id
        and member.entity_id=current.entity_id
       join memory_graph_entity_versions version on version.id=member.entity_version_id
       where current.reconciliation_run_id=$1
       group by current.memory_id,current.entity_id,version.valid_from,version.valid_to`,
      [valid.reconciliationRunId],
    );
    const currentId = claim.memoryId;
    const observedAt = "2026-08-09T11:00:00.000Z";
    const variants = ["aggregate_id", "account_id", "visibility", "occurred_at",
      "policy_version", "idempotency_key"] as const;
    for (const field of variants) {
      await expect(db.transaction(async (transaction) => {
        const runId = randomUUID();
        const operationKey = canonicalContentDigest({ runId, field, authority: "server-derived" });
        const runIdempotencyKey = `graph-envelope-run:${field}`;
        const eventBody = {
          run: { id: runId, operationKey, scope: "PRIVATE_ACCOUNT",
            accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
            conversationId: fixture.conversationId,
            reconcilerVersion: "temporal-memory-graph-v2", observedAt },
          counts: { candidates: 1, entities: 1, aliases: 0, relationships: 0,
            conflicts: 0, current: 1 },
          digests: { candidates: canonicalContentDigest([currentId]),
            sources: canonicalContentDigest([...claim.sourceIds].sort()),
            current: canonicalContentDigest([currentId]),
            relationships: canonicalContentDigest([]), conflicts: canonicalContentDigest([]) },
        };
        const expectedEventKey = `memory-graph-event:${operationKey}`;
        const event = await appendEvent(transaction, {
          aggregateId: field === "aggregate_id" ? `forged:${runId}` : fixture.conversationId,
          accountId: field === "account_id" ? randomUUID() : fixture.accountId,
          actor: { type: "SYSTEM", id: "memory-graph-reconciler" },
          type: "memory.edge.versioned",
          visibility: field === "visibility" ? "SHARED" : "PRIVATE_ACCOUNT",
          body: eventBody as never,
          occurredAt: new Date(field === "occurred_at"
            ? "2026-08-09T11:00:00.001Z" : observedAt),
          idempotencyKey: field === "idempotency_key"
            ? `forged-memory-graph-event:${operationKey}` : expectedEventKey,
          policyVersion: field === "policy_version" ? "forged-policy" : "memory-graph-v1",
        });
        const header = await transaction.one<{
          request_hash: string; integrity_hash: string; body_digest: string;
        }>(
          `select event.request_hash,event.integrity_hash,body.body_digest
           from events event join encrypted_event_bodies body on body.event_id=event.id
           where event.id=$1`, [event.id],
        );
        await transaction.query(
          `insert into memory_graph_reconciliation_runs (
             id,operation_key,idempotency_key,request_digest,scope,account_id,node_brain_id,
             conversation_id,reconciler_version,observed_at,candidate_count,entity_count,
             alias_count,edge_count,conflict_count,current_count,graph_event_id,
             graph_event_request_hash,graph_event_integrity_hash,created_at
           ) values ($1,$2,$3,$4,'PRIVATE_ACCOUNT',$5,$6,$7,'temporal-memory-graph-v2',
             $8,1,1,0,0,0,1,$9,$10,$11,$8)`,
          [runId, operationKey, runIdempotencyKey,
            canonicalContentDigest({ operationKey, idempotencyKey: runIdempotencyKey }),
            fixture.accountId, fixture.nodeBrainId, fixture.conversationId, observedAt,
            event.id, header.request_hash, header.integrity_hash],
        );
        await transaction.query(
          `insert into memory_graph_idempotency_keys (
             idempotency_key,reconciliation_run_id,operation_key,request_digest,
             request_shape_digest,created_at
           ) values ($1,$2,$3,$4,$5,$6)`,
          [runIdempotencyKey, runId, operationKey,
            canonicalContentDigest({ operationKey, idempotencyKey: runIdempotencyKey }),
            canonicalContentDigest({ runId, shape: "one-current-claim" }), observedAt],
        );
        const priorVersion = await transaction.one<{ id: string }>(
          `select id::text from memory_graph_entity_versions where entity_id=$1
           order by append_ordinal desc limit 1`, [claim.entityId],
        );
        const entityVersionId = randomUUID();
        await transaction.query(
          `insert into memory_graph_entity_versions (
             id,entity_id,reconciliation_run_id,valid_from,valid_to,
             supersedes_entity_version_id,created_at
           ) values ($1,$2,$3,$4,$5,$6,$7)`,
          [entityVersionId, claim.entityId, runId, claim.validFrom,
            claim.validTo, priorVersion.id, observedAt],
        );
        await transaction.query(
          `insert into memory_graph_run_entities (
             reconciliation_run_id,entity_id,entity_version_id,ordinal
           ) values ($1,$2,$3,0)`, [runId, claim.entityId, entityVersionId],
        );
        await transaction.query(
          `insert into memory_graph_run_candidates(reconciliation_run_id,memory_id,ordinal)
           values ($1,$2,0)`, [runId, currentId],
        );
        await transaction.query(
          `insert into memory_graph_current_claims (
             reconciliation_run_id,memory_id,entity_id,predicate_digest
           ) select $1,node.memory_id,node.entity_id,node.predicate_digest
             from memory_graph_nodes node where node.memory_id=$2`, [runId, currentId],
        );
        const priorHead = await transaction.one<{ id: string }>(
          `select head.id::text from memory_graph_current_heads head
           join memory_graph_nodes node on node.memory_id=$1
           where head.entity_id=node.entity_id and head.predicate_digest=node.predicate_digest`,
          [currentId],
        );
        await transaction.query(
          `insert into memory_graph_head_versions (
             id,reconciliation_run_id,entity_id,predicate_digest,memory_id,
             supersedes_head_version_id,created_at
           ) select $1,$2,node.entity_id,node.predicate_digest,node.memory_id,$3,$4
             from memory_graph_nodes node where node.memory_id=$5`,
          [randomUUID(), runId, priorHead.id, observedAt, currentId],
        );
        expect(await transaction.one<{ exact: boolean }>(
          `select body.body_digest=memory_graph_expected_event_body_digest($1) exact
           from encrypted_event_bodies body where body.event_id=$2`, [runId, event.id],
        )).toEqual({ exact: true });
        await transaction.query(
          `insert into memory_graph_event_manifests (
             graph_event_id,reconciliation_run_id,memory_ids,source_event_ids,semantic_digest,
             relation_count,relation_digest,body_digest,event_request_hash,
             event_integrity_hash,created_at
           ) values ($1,$2,array[$3]::uuid[],$4,$5,0,memory_graph_relation_digest($2),
             $6,$7,$8,$9)`,
          [event.id, runId, currentId, claim.sourceIds, operationKey, header.body_digest,
            header.request_hash, header.integrity_hash, observedAt],
        );
      })).rejects.toThrow("MEMORY_GRAPH_EVENT_ENVELOPE_INVALID");
    }
  }, 60_000);

  it("rejects actual-digest arbitrary bodies for every direct-SQL job transition rebind", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "job-body-forgery");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), graphInput(fixture, "job-body-forgery"));
    const traversal = await authorizeMemoryGraphTraversal(db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const worker = await graphModule.authorizeMemoryGraphJobWorker(db, {
      actorId: "memory-graph-worker", purpose: "DEEP_RESEARCH",
    });
    const completedJob = await traverseMemoryGraph(traversal, {
      seedMemoryIds: [fixture.memories[0]!.id], requestedDepth: 8, candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "job-body-forgery:completed",
    });
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: completedJob.backgroundJobId, workerId: "body-worker",
      at: "2026-08-10T00:01:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "job-body-forgery:complete:claim",
    });
    await graphModule.completeMemoryGraphBackgroundJob(worker, {
      jobId: completedJob.backgroundJobId, workerId: "body-worker",
      resultMemoryIds: [fixture.memories[0]!.id], at: "2026-08-10T00:02:00.000Z",
      idempotencyKey: "job-body-forgery:complete",
    });
    const failedJob = await traverseMemoryGraph(traversal, {
      seedMemoryIds: [fixture.memories[1]!.id], requestedDepth: 8, candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "job-body-forgery:failed",
    });
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: failedJob.backgroundJobId, workerId: "body-worker",
      at: "2026-08-10T00:01:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "job-body-forgery:retry:claim",
    });
    await graphModule.failMemoryGraphBackgroundJob(worker, {
      jobId: failedJob.backgroundJobId, workerId: "body-worker", errorCode: "TRANSIENT",
      retryAt: await databaseFuture(db, 50), at: "2026-08-10T00:02:00.000Z",
      idempotencyKey: "job-body-forgery:retry",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: failedJob.backgroundJobId, workerId: "body-worker",
      at: "2026-08-10T00:03:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "job-body-forgery:retry:reclaim",
    });
    await graphModule.failMemoryGraphBackgroundJob(worker, {
      jobId: failedJob.backgroundJobId, workerId: "body-worker", errorCode: "TERMINAL",
      at: "2026-08-10T00:04:00.000Z", idempotencyKey: "job-body-forgery:terminal",
    });
    const transitions = await db.query<{
      id: string; job_id: string; to_status: string; transition_event_id: string;
      body_digest: string; expected_digest: string; created_at: Date;
    }>(
      `select distinct on (transition.to_status) transition.id::text,transition.job_id::text,
              transition.to_status,transition.transition_event_id::text,body.body_digest,
              memory_graph_expected_job_transition_body_digest(transition.id) expected_digest,
              transition.created_at
       from memory_graph_background_job_transitions transition
       join encrypted_event_bodies body on body.event_id=transition.transition_event_id
       where transition.job_id=any($1::uuid[])
       order by transition.to_status,transition.ordinal`,
      [[completedJob.backgroundJobId, failedJob.backgroundJobId]],
    );
    expect(transitions.map(({ to_status }) => to_status).sort()).toEqual(
      ["CLAIMED", "COMPLETED", "FAILED", "PENDING", "RETRY_SCHEDULED"],
    );
    expect(transitions.every(({ body_digest, expected_digest }) => body_digest === expected_digest))
      .toBe(true);
    const eventType = {
      PENDING: "memory.graph.background.queued", CLAIMED: "memory.graph.background.claimed",
      COMPLETED: "memory.graph.background.completed", FAILED: "memory.graph.background.failed",
      RETRY_SCHEDULED: "memory.graph.background.retry_scheduled",
    } as const;
    for (const transition of transitions) {
      const arbitraryBody = { arbitrary: `attacker-chosen-${transition.to_status}` };
      await expect(db.transaction(async (transaction) => {
        const forged = await appendEvent(transaction, {
          aggregateId: `memory-graph-job:${transition.job_id}`, accountId: fixture.accountId,
          actor: { type: "SYSTEM", id: transition.to_status === "PENDING"
            ? "memory-graph-scheduler" : "memory-graph-worker" },
          type: eventType[transition.to_status as keyof typeof eventType],
          visibility: "PRIVATE_ACCOUNT", body: arbitraryBody,
          occurredAt: transition.created_at,
          idempotencyKey: `job-body-forgery:event:${transition.to_status}`,
        });
        expect(await transaction.one<{ body_digest: string }>(
          "select body_digest from encrypted_event_bodies where event_id=$1", [forged.id],
        )).toEqual({ body_digest: canonicalContentDigest(arbitraryBody) });
        await transaction.query(
          `insert into memory_graph_job_transition_manifests (
             transition_id,job_id,transition_event_id,operation_digest,event_request_hash,
             event_integrity_hash,created_at
           ) select manifest.transition_id,manifest.job_id,$1,manifest.operation_digest,
                    event.request_hash,event.integrity_hash,manifest.created_at
             from memory_graph_job_transition_manifests manifest
             join events event on event.id=$1 where manifest.transition_id=$2`,
          [forged.id, transition.id],
        );
      })).rejects.toThrow("MEMORY_GRAPH_JOB_EVENT_BODY_INVALID");
    }
  }, 60_000);

  it("seals exact graph and job outbox payloads against direct writes and mutation", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "outbox-authority");
    const graph = await versionMemoryGraph(
      createMemoryGraphWriterContext(db), graphInput(fixture, "outbox-authority"),
    );
    const traversal = await authorizeMemoryGraphTraversal(db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const worker = await graphModule.authorizeMemoryGraphJobWorker(db, {
      actorId: "memory-graph-worker", purpose: "DEEP_RESEARCH",
    });
    const completedJob = await traverseMemoryGraph(traversal, {
      seedMemoryIds: [fixture.memories[0]!.id], requestedDepth: 8, candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "outbox-authority:completed",
    });
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: completedJob.backgroundJobId, workerId: "outbox-worker",
      at: "2026-08-10T00:01:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "outbox-authority:complete:claim",
    });
    await graphModule.completeMemoryGraphBackgroundJob(worker, {
      jobId: completedJob.backgroundJobId, workerId: "outbox-worker",
      resultMemoryIds: [fixture.memories[0]!.id], at: "2026-08-10T00:02:00.000Z",
      idempotencyKey: "outbox-authority:complete",
    });
    const failedJob = await traverseMemoryGraph(traversal, {
      seedMemoryIds: [fixture.memories[1]!.id], requestedDepth: 8, candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "outbox-authority:failed",
    });
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: failedJob.backgroundJobId, workerId: "outbox-worker",
      at: "2026-08-10T00:01:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "outbox-authority:retry:claim",
    });
    await graphModule.failMemoryGraphBackgroundJob(worker, {
      jobId: failedJob.backgroundJobId, workerId: "outbox-worker", errorCode: "TRANSIENT",
      retryAt: await databaseFuture(db, 50), at: "2026-08-10T00:02:00.000Z",
      idempotencyKey: "outbox-authority:retry",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: failedJob.backgroundJobId, workerId: "outbox-worker",
      at: "2026-08-10T00:03:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "outbox-authority:retry:reclaim",
    });
    await graphModule.failMemoryGraphBackgroundJob(worker, {
      jobId: failedJob.backgroundJobId, workerId: "outbox-worker", errorCode: "TERMINAL",
      at: "2026-08-10T00:04:00.000Z", idempotencyKey: "outbox-authority:terminal",
    });
    const graphEvent = await db.one<{ id: string }>(
      "select graph_event_id::text id from memory_graph_reconciliation_runs where id=$1",
      [graph.reconciliationRunId],
    );
    const rows = await db.query<{ id: string; event_id: string; topic: string; payload: unknown }>(
      `select distinct on (event.type) outbox.id::text,outbox.event_id::text,outbox.topic,outbox.payload
       from transactional_outbox outbox join events event on event.id=outbox.event_id
       where event.id=$1 or event.aggregate_id=any($2::text[])
       order by event.type,event.occurred_at,event.id`,
      [graphEvent.id, [`memory-graph-job:${completedJob.backgroundJobId}`,
        `memory-graph-job:${failedJob.backgroundJobId}`]],
    );
    expect(rows.map(({ topic }) => topic).sort()).toEqual([
      "memory.edge.versioned", "memory.graph.background.claimed",
      "memory.graph.background.completed", "memory.graph.background.failed",
      "memory.graph.background.queued", "memory.graph.background.retry_scheduled",
    ]);
    for (const row of rows) {
      expect(row.payload).toEqual({ eventId: row.event_id });
      await expect(db.query(
        `insert into transactional_outbox(id,event_id,topic,payload)
         values ($1,$2,$3,'{"eventId":"attacker","extra":true}'::jsonb)`,
        [randomUUID(), row.event_id, row.topic],
      )).rejects.toThrow("MEMORY_GRAPH_OUTBOX_INVALID");
      await expect(db.transaction(async (transaction) => {
        await transaction.query("delete from transactional_outbox where id=$1", [row.id]);
        await transaction.query(
          `insert into transactional_outbox(id,event_id,topic,payload)
           values ($1,$2,$3,'{"eventId":"attacker","replacement":true}'::jsonb)`,
          [randomUUID(), row.event_id, row.topic],
        );
      })).rejects.toThrow("IMMUTABLE_MEMORY_GRAPH_OUTBOX");
      for (const mutation of [
        ["update transactional_outbox set topic='attacker.topic' where id=$1", [row.id]],
        ["update transactional_outbox set payload='{}'::jsonb where id=$1", [row.id]],
        ["delete from transactional_outbox where id=$1", [row.id]],
      ] as const) {
        await expect(db.transaction(async (transaction) => {
          await transaction.query(mutation[0], mutation[1]);
          throw new Error("OUTBOX_MUTATION_ACCEPTED");
        })).rejects.toThrow("IMMUTABLE_MEMORY_GRAPH_OUTBOX");
      }
    }
    const ordinary = await appendEvent(db, {
      aggregateId: "outbox-authority:ordinary", actor: { type: "SYSTEM", id: "ordinary" },
      type: "ordinary.outbox.mutable", visibility: "PUBLIC", body: { ordinary: true },
      idempotencyKey: "outbox-authority:ordinary",
    });
    const escalationOutcomes: string[] = [];
    for (const canonicalTopic of rows.map(({ topic }) => topic)) {
      try {
        await db.transaction(async (transaction) => {
          await transaction.query(
            "update transactional_outbox set topic=$1 where event_id=$2",
            [canonicalTopic, ordinary.id],
          );
          throw new Error("ORDINARY_TO_T22_TOPIC_ACCEPTED");
        });
      } catch (error) {
        escalationOutcomes.push(error instanceof Error ? error.message : "UNKNOWN");
      }
    }
    let publisherOutcome = "RESOLVED";
    try {
      await db.transaction(async (transaction) => {
        await transaction.query(
          `update transactional_outbox set status='LEASED',attempts=attempts+1,
             leased_until='2026-08-10T00:10:00.000Z'
           where id=$1`, [rows[0]!.id],
        );
        await transaction.query(
          `update transactional_outbox set status='PUBLISHED',leased_until=null,
             published_at='2026-08-10T00:11:00.000Z'
           where id=$1`, [rows[0]!.id],
        );
        throw new Error("T22_OUTBOX_PUBLISHER_LIFECYCLE_ALLOWED");
      });
    } catch (error) {
      publisherOutcome = error instanceof Error ? error.message : "UNKNOWN";
    }
    expect({ escalationOutcomes, publisherOutcome }).toEqual({
      escalationOutcomes: rows.map(() => "MEMORY_GRAPH_OUTBOX_INVALID"),
      publisherOutcome: "T22_OUTBOX_PUBLISHER_LIFECYCLE_ALLOWED",
    });
    const reassignmentOutcomes: string[] = [];
    for (const canonical of rows) {
      try {
        await db.transaction(async (transaction) => {
          const canonicalEventId = randomUUID();
          await transaction.query(
            `insert into events (
               id,aggregate_id,account_id,actor_type,actor_id,type,visibility,occurred_at,
               causation_id,correlation_id,prompt_version,model_version,policy_version,
               idempotency_key,request_hash,integrity_hash
             ) select $1::uuid,event.aggregate_id,event.account_id,event.actor_type,event.actor_id,
                      event.type,event.visibility,event.occurred_at,null,$1::uuid,event.prompt_version,
                      event.model_version,event.policy_version,$2,event.request_hash,event.integrity_hash
               from events event where event.id=$3::uuid`,
            [canonicalEventId, `outbox-reassignment:${canonicalEventId}`, canonical.event_id],
          );
          await transaction.query(
            `update transactional_outbox set event_id=$1::uuid,topic=$2,
               payload=jsonb_build_object('eventId',$1::text)
             where event_id=$3::uuid`,
            [canonicalEventId, canonical.topic, ordinary.id],
          );
          throw new Error("ORDINARY_TO_EXACT_T22_TUPLE_ACCEPTED");
        });
      } catch (error) {
        reassignmentOutcomes.push(error instanceof Error ? error.message : "UNKNOWN");
      }
    }
    expect(reassignmentOutcomes).toEqual(rows.map(() => "MEMORY_GRAPH_OUTBOX_INVALID"));
    await expect(db.transaction(async (transaction) => {
      await transaction.query(
        `update transactional_outbox set topic='ordinary.outbox.changed',payload='{}'::jsonb
         where event_id=$1`, [ordinary.id],
      );
      await transaction.query("delete from transactional_outbox where event_id=$1", [ordinary.id]);
      throw new Error("NON_T22_OUTBOX_MUTATION_ALLOWED");
    })).rejects.toThrow("NON_T22_OUTBOX_MUTATION_ALLOWED");
  }, 90_000);

  it("bounds authorized traversal and durably hands deeper work to the background", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "traversal");
    const input = graphInput(fixture, "traversal");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), input);
    const context = await authorizeMemoryGraphTraversal(db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const bounded = await traverseMemoryGraph(context, {
      seedMemoryIds: [fixture.memories[0]!.id],
      requestedDepth: 8,
      candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z",
      idempotencyKey: "memory-graph-traversal:deep",
    });
    expect(bounded.memoryIds).toEqual([fixture.memories[0]!.id]);
    expect(bounded.maximumDepthApplied).toBe(2);
    expect(bounded.truncated).toBe(true);
    expect(bounded.backgroundJobId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await db.one<{ jobs: number }>(
      "select count(*)::int jobs from memory_graph_background_jobs",
    )).toEqual({ jobs: 1 });
    expect(graphTraversalContract()).toEqual({
      maximumDepth: 2,
      maximumCandidates: 100,
      maximumSeeds: 20,
      maximumAdjacencyQueries: 2,
      deeperWork: "BACKGROUND_JOB",
    });

    const foreign = await seedPrivateGraphMemories(db, "traversal-foreign");
    await expect(traverseMemoryGraph(context, {
      seedMemoryIds: [foreign.memories[0]!.id],
      requestedDepth: 1,
      candidateLimit: 10,
      asOf: "2026-08-10T00:00:00.000Z",
      idempotencyKey: "memory-graph-traversal:foreign",
    })).rejects.toThrow("MEMORY_GRAPH_SEED_FORBIDDEN");
  }, 20_000);

  it("rejects unbranded contexts and hostile traversal structures before database access", async () => {
    const query = vi.fn(async () => []);
    const fakeDb = {
      query,
      one: vi.fn(),
      transaction: vi.fn(),
    };
    await expect(traverseMemoryGraph({ db: fakeDb } as never, {
      seedMemoryIds: [randomUUID()], requestedDepth: 1, candidateLimit: 10,
      asOf: NEW_AT, idempotencyKey: "unbranded",
    })).rejects.toThrow("MEMORY_GRAPH_CONTEXT_INVALID");
    expect(query).not.toHaveBeenCalled();
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(fakeDb as never),
      new Proxy({}, {}) as never)).rejects.toThrow("MEMORY_GRAPH_INPUT_INVALID");
    expect(query).not.toHaveBeenCalled();
  });

  it("contains no model, network, child-process, broker, or external execution path", async () => {
    const [conflicts, graph] = await Promise.all([
      readFile("lib/server/consolidation/conflicts.ts", "utf8"),
      readFile("lib/server/consolidation/graph.ts", "utf8"),
    ]);
    const source = `${conflicts}\n${graph}`;
    expect(source).not.toMatch(/fetch\s*\(|node:(?:net|http|https|child_process)|WebSocket|broker|exchange/i);
    expect(source).not.toMatch(/openai|anthropic|model[_-]?provider|spawn\s*\(|execFile\s*\(/i);
  });
});

describe("Stage A temporal graph authority closure", () => {
  it("derives erasable domain-separated protected digests and binds semantics to an encrypted event manifest", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "keyed-manifest");
    const input = rawGraphInput(fixture, "keyed-manifest");
    const entityBase = await deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, kind: "ENTITY", term: "AAPL",
    });
    const predicateBase = await deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, kind: "KEYWORD", term: "bias",
    });
    const valueBase = await deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, kind: "KEYWORD", term: "neutral",
    });
    const result = await versionMemoryGraph(createMemoryGraphWriterContext(db), input);
    const stored = await db.one<{
      canonical_digest: string; alias_digest: string; predicate_digest: string;
      value_digest: string; graph_event_id: string;
    }>(
      `select entity.canonical_digest,alias.alias_digest,node.predicate_digest,node.value_digest,
              run.graph_event_id::text
       from memory_graph_reconciliation_runs run
       join memory_graph_run_entities member on member.reconciliation_run_id=run.id
       join memory_graph_entities entity on entity.id=member.entity_id
       join memory_graph_run_aliases run_alias on run_alias.reconciliation_run_id=run.id
       join memory_graph_entity_aliases alias on alias.id=run_alias.alias_id
         and alias.source_count=2
       join memory_graph_nodes node on node.memory_id=$2
       where run.id=$1 limit 1`,
      [result.reconciliationRunId, fixture.memories[1]!.id],
    );
    expect(stored.canonical_digest).toBe(canonicalContentDigest({
      domain: "gustavo:memory-graph:entity:v1", termDigest: entityBase,
    }));
    expect(stored.alias_digest).toBe(canonicalContentDigest({
      domain: "gustavo:memory-graph:alias:v1", termDigest: entityBase,
    }));
    expect(stored.predicate_digest).toBe(canonicalContentDigest({
      domain: "gustavo:memory-graph:predicate:v1", termDigest: predicateBase,
    }));
    expect(stored.value_digest).toBe(canonicalContentDigest({
      domain: "gustavo:memory-graph:value:v1", termDigest: valueBase,
    }));
    expect(new Set([
      stored.canonical_digest, stored.alias_digest, stored.predicate_digest, stored.value_digest,
    ]).size).toBe(4);
    expect(Object.values(stored)).not.toContain(digest("AAPL"));
    const graphEvent = await db.one<{
      type: string; actor_type: string; actor_id: string; visibility: string;
      bodies: number; manifests: number; outboxes: number;
    }>(
      `select event.type,event.actor_type,event.actor_id,event.visibility,
        (select count(*)::int from encrypted_event_bodies body
         where body.event_id=event.id and body.data_key_id is not null) bodies,
        (select count(*)::int from memory_graph_event_manifests manifest
         where manifest.graph_event_id=event.id) manifests,
        (select count(*)::int from transactional_outbox outbox
         where outbox.event_id=event.id and outbox.topic='memory.edge.versioned') outboxes
       from events event where event.id=$1`,
      [stored.graph_event_id],
    );
    expect(graphEvent).toEqual({
      type: "memory.edge.versioned", actor_type: "SYSTEM",
      actor_id: "memory-graph-reconciler", visibility: "PRIVATE_ACCOUNT",
      bodies: 1, manifests: 1, outboxes: 1,
    });
    const body = await readEventBody(db, stored.graph_event_id, { actor: { role: "SYSTEM" } });
    expect(JSON.stringify(body)).not.toContain('"canonicalName":"AAPL"');
    expect(JSON.stringify(body)).not.toContain('"predicate":"bias"');
    expect(JSON.stringify(body)).not.toContain(stored.canonical_digest);
    expect(JSON.stringify(body)).not.toContain(stored.predicate_digest);
    expect(body).toMatchObject({ counts: { candidates: 2, entities: 1, aliases: 2,
      relationships: 2, conflicts: 1, current: 1 }, digests: {
      relationships: expect.stringMatching(/^[a-f0-9]{64}$/u),
      conflicts: expect.stringMatching(/^[a-f0-9]{64}$/u),
    } });
    expect(await db.one<{ exact: boolean }>(
      `select body.body_digest=memory_graph_expected_event_body_digest(run.id) exact
       from memory_graph_reconciliation_runs run
       join encrypted_event_bodies body on body.event_id=run.graph_event_id
       where run.id=$1`, [result.reconciliationRunId],
    )).toEqual({ exact: true });
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...input,
      idempotencyKey: "memory-graph-raw:fabricated-semantics",
      claims: input.claims.map((claim, index) => (
        index === 1 ? { ...claim, value: "fabricated-secret-claim" } : claim
      )),
    })).rejects.toThrow("MEMORY_GRAPH_SEMANTIC_NOT_SOURCE_GROUNDED");
    await db.query("delete from aggregate_data_keys where aggregate_id=$1", [fixture.conversationId]);
    await expect(deriveMemorySearchTermDigest(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, kind: "ENTITY", term: "AAPL",
    })).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
  }, 30_000);

  it("reconciles incrementally against one global head with exact conflict time", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "global-head");
    const entityId = randomUUID();
    const first = rawGraphInput(fixture, "global-head-first", entityId);
    const firstResult = await versionMemoryGraph(createMemoryGraphWriterContext(db), first);
    expect(firstResult.edges.map(({ type }) => type).sort()).toEqual([
      "CONTRADICTS", "SUPERSEDES",
    ]);
    expect(firstResult.edges.find(({ type }) => type === "CONTRADICTS")).toMatchObject({
      validFrom: NEW_AT,
      validTo: fixture.memories[0]!.validTo,
    });
    const laterAt = "2026-08-10T10:00:00.000Z";
    const later = await appendGraphMemory(fixture, "global-head-later", "bearish", laterAt);
    const second = await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const,
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      idempotencyKey: "memory-graph-raw:global-head-second",
      reconcilerVersion: "temporal-memory-graph-v2",
      observedAt: "2026-08-10T10:02:00.000Z",
      entities: [{
        id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: OLD_AT,
        aliases: [{ alias: "AAPL", validFrom: laterAt, sourceIds: [later.source.id] }],
      }],
      claims: [{
        memoryId: later.memory.id, entityId, nodeType: "BELIEF" as const,
        predicate: "bias", value: "bearish", approved: true,
        validFrom: laterAt, sourceIds: [later.source.id],
      }],
    });
    expect(second.currentMemoryIds).toEqual([later.memory.id]);
    expect(await db.one<{ candidates: number; heads: number; current_heads: number }>(
      `select
        (select count(*)::int from memory_graph_run_candidates
         where reconciliation_run_id=$1) candidates,
        (select count(*)::int from memory_graph_head_versions
         where entity_id=$2 and predicate_digest=(
           select predicate_digest from memory_graph_nodes where memory_id=$3
         )) heads,
        (select count(*)::int from memory_graph_current_heads
         where entity_id=$2) current_heads`,
      [second.reconciliationRunId, entityId, later.memory.id],
    )).toEqual({ candidates: 2, heads: 2, current_heads: 1 });
  }, 30_000);

  it("revalidates and locks traversal authority before expansion and job replay", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "traversal-revalidation");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), graphInput(fixture, "revalidation"));
    const request = {
      seedMemoryIds: [fixture.memories[0]!.id], requestedDepth: 8, candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "graph-revalidation-job",
    };
    const stale = await authorizeMemoryGraphTraversal(db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    expect((await traverseMemoryGraph(stale, request)).backgroundJobId).not.toBeNull();
    await db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [
      fixture.accountId,
    ]);
    await expect(traverseMemoryGraph(stale, request)).rejects.toThrow("MEMORY_GRAPH_ACTOR_FORBIDDEN");

    const race = await seedPrivateGraphMemories(db, "traversal-race");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), graphInput(race, "revalidation-race"));
    const gate = transactionGate(db, "memory-graph-authority-lock");
    const locked = await authorizeMemoryGraphTraversal(gate.observed, {
      role: "ACCOUNT", accountId: race.accountId,
    });
    const traversal = traverseMemoryGraph(locked, {
      seedMemoryIds: [race.memories[0]!.id], requestedDepth: 1, candidateLimit: 10,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "graph-revalidation-race",
    });
    const reached = await Promise.race([
      gate.reached.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    if (!reached) gate.release();
    expect(reached).toBe(true);
    let revoked = false;
    const revocation = db.query(
      "update entitlements set revoked_at=clock_timestamp() where account_id=$1",
      [race.accountId],
    ).then(() => { revoked = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(revoked).toBe(false);
    gate.release();
    await traversal;
    await revocation;

    await db.query(
      `insert into recall_actor_authorities(role,actor_id,scopes)
       values ('OPERATOR','graph-operator',array['PUBLIC']::text[])`,
    );
    const operator = await authorizeMemoryGraphTraversal(db, {
      role: "OPERATOR", actorId: "graph-operator", purpose: "GRAPH_AUDIT", scopes: ["PUBLIC"],
    });
    await db.query(
      `update recall_actor_authorities set active=false
       where role='OPERATOR' and actor_id='graph-operator'`,
    );
    await expect(traverseMemoryGraph(operator, {
      seedMemoryIds: [race.memories[0]!.id], requestedDepth: 1, candidateLimit: 10,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "graph-operator-revoked",
    })).rejects.toThrow("MEMORY_GRAPH_ACTOR_FORBIDDEN");
  }, 30_000);

  it("records an idempotent concurrent deep-job lifecycle as immutable event-backed transitions", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    expect(graphModule).toHaveProperty("authorizeMemoryGraphJobWorker");
    expect(graphModule).toHaveProperty("claimMemoryGraphBackgroundJob");
    expect(graphModule).toHaveProperty("completeMemoryGraphBackgroundJob");
    expect(graphModule).toHaveProperty("failMemoryGraphBackgroundJob");
    const api = graphModule as unknown as {
      authorizeMemoryGraphJobWorker: (db: TestDatabase, input: unknown) => Promise<unknown>;
      claimMemoryGraphBackgroundJob: (context: unknown, input: unknown) => Promise<{ status: string }>;
      completeMemoryGraphBackgroundJob: (context: unknown, input: unknown) => Promise<{ status: string }>;
      failMemoryGraphBackgroundJob: (context: unknown, input: unknown) => Promise<{ status: string }>;
    };
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "job-lifecycle");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), graphInput(fixture, "job-lifecycle"));
    const traversal = await authorizeMemoryGraphTraversal(db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const queued = await traverseMemoryGraph(traversal, {
      seedMemoryIds: [fixture.memories[0]!.id], requestedDepth: 8, candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "graph-job-lifecycle",
    });
    const worker = await api.authorizeMemoryGraphJobWorker(db, {
      actorId: "memory-graph-worker", purpose: "DEEP_RESEARCH",
    });
    const claimInput = {
      jobId: queued.backgroundJobId, workerId: "worker-1",
      at: "2026-08-10T00:01:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "graph-job-claim",
    };
    const settled = await Promise.allSettled([
      api.claimMemoryGraphBackgroundJob(worker, claimInput),
      api.claimMemoryGraphBackgroundJob(worker, { ...claimInput, idempotencyKey: "graph-job-claim-race" }),
    ]);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(await api.claimMemoryGraphBackgroundJob(worker, claimInput)).toMatchObject({ status: "CLAIMED" });
    expect(await api.completeMemoryGraphBackgroundJob(worker, {
      jobId: queued.backgroundJobId, workerId: "worker-1",
      resultMemoryIds: [fixture.memories[0]!.id], at: "2026-08-10T00:02:00.000Z",
      idempotencyKey: "graph-job-complete",
    })).toMatchObject({ status: "COMPLETED" });

    const retryQueued = await traverseMemoryGraph(traversal, {
      seedMemoryIds: [fixture.memories[1]!.id], requestedDepth: 8, candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: "graph-job-retry-lifecycle",
    });
    expect(await api.claimMemoryGraphBackgroundJob(worker, {
      ...claimInput, jobId: retryQueued.backgroundJobId,
      idempotencyKey: "graph-job-retry-claim",
    })).toMatchObject({ status: "CLAIMED" });
    expect(await api.failMemoryGraphBackgroundJob(worker, {
      jobId: retryQueued.backgroundJobId, workerId: "worker-1",
      errorCode: "TRANSIENT_SOURCE", retryAt: await databaseFuture(db, 50),
      at: "2026-08-10T00:02:00.000Z", idempotencyKey: "graph-job-retry",
    })).toMatchObject({ status: "RETRY_SCHEDULED" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await api.claimMemoryGraphBackgroundJob(worker, {
      ...claimInput, jobId: retryQueued.backgroundJobId,
      at: "2026-08-10T00:03:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "graph-job-retry-reclaim",
    })).toMatchObject({ status: "CLAIMED" });
    expect(await api.failMemoryGraphBackgroundJob(worker, {
      jobId: retryQueued.backgroundJobId, workerId: "worker-1",
      errorCode: "TERMINAL_SOURCE", at: "2026-08-10T00:04:00.000Z",
      idempotencyKey: "graph-job-terminal-failure",
    })).toMatchObject({ status: "FAILED" });
    expect(await db.one<{ transitions: number; events: number; outboxes: number; manifests: number }>(
      `select
        (select count(*)::int from memory_graph_background_job_transitions
         where job_id=$1) transitions,
        (select count(*)::int from events event
         where event.aggregate_id='memory-graph-job:'||$1::text) events,
        (select count(*)::int from transactional_outbox outbox
         join events event on event.id=outbox.event_id
         where event.aggregate_id='memory-graph-job:'||$1::text) outboxes,
        (select count(*)::int from memory_graph_job_transition_manifests manifest
         where manifest.job_id=$1) manifests`,
      [retryQueued.backgroundJobId],
    )).toEqual({ transitions: 5, events: 5, outboxes: 5, manifests: 5 });
    expect(await db.one<{ transitions: number; events: number; outboxes: number; manifests: number }>(
      `select
        (select count(*)::int from memory_graph_background_job_transitions
         where job_id=$1) transitions,
        (select count(*)::int from events event
         where event.aggregate_id='memory-graph-job:'||$1::text) events,
        (select count(*)::int from transactional_outbox outbox
         join events event on event.id=outbox.event_id
         where event.aggregate_id='memory-graph-job:'||$1::text) outboxes,
        (select count(*)::int from memory_graph_job_transition_manifests manifest
         where manifest.job_id=$1) manifests`,
      [queued.backgroundJobId],
    )).toEqual({ transitions: 3, events: 3, outboxes: 3, manifests: 3 });
    await expect(db.query(
      `update memory_graph_background_job_transitions set to_status='FAILED'
       where job_id=$1 and to_status='COMPLETED'`,
      [queued.backgroundJobId],
    )).rejects.toThrow("IMMUTABLE_MEMORY_GRAPH");
  }, 30_000);

  it("publishes usable current/historical adjacency indexes and bounded query plans", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "index-contract");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), graphInput(fixture, "index-contract"));
    const definitions = (await db.query<{ indexname: string; indexdef: string }>(
      `select indexname,indexdef from pg_indexes
       where schemaname=current_schema() and tablename='memory_graph_edges'
       order by indexname`,
    )).map(({ indexname, indexdef }) => `${indexname}:${indexdef}`).join("\n");
    expect(definitions).toMatch(/memory_graph_edges_source_temporal_idx.*source_memory_id.*valid_from.*valid_to/iu);
    expect(definitions).toMatch(/memory_graph_edges_target_temporal_idx.*target_memory_id.*valid_from.*valid_to/iu);
    const plans = await db.transaction(async (transaction) => {
      await transaction.query("set local enable_seqscan=off");
      return Promise.all([
        transaction.query<{ "QUERY PLAN": string }>(
          `explain select target_memory_id from memory_graph_edges
           where scope='PRIVATE_ACCOUNT' and account_id=$1 and node_brain_id=$2
             and conversation_id=$3 and source_memory_id=$4
             and valid_from<=$5 and (valid_to is null or valid_to>$5)
           order by valid_from desc limit 100`,
          [fixture.accountId, fixture.nodeBrainId, fixture.conversationId,
            fixture.memories[1]!.id, "2026-08-10T00:00:00.000Z"],
        ),
        transaction.query<{ "QUERY PLAN": string }>(
          `explain select source_memory_id from memory_graph_edges
           where scope='PRIVATE_ACCOUNT' and account_id=$1 and node_brain_id=$2
             and conversation_id=$3 and target_memory_id=$4
             and valid_from<=$5 and (valid_to is null or valid_to>$5)
           order by valid_from desc limit 100`,
          [fixture.accountId, fixture.nodeBrainId, fixture.conversationId,
            fixture.memories[0]!.id, "2026-08-10T00:00:00.000Z"],
        ),
      ]);
    });
    expect(plans[0].map((row) => row["QUERY PLAN"]).join(" "))
      .toContain("memory_graph_edges_source_temporal_idx");
    expect(plans[1].map((row) => row["QUERY PLAN"]).join(" "))
      .toContain("memory_graph_edges_target_temporal_idx");
    expect(graphTraversalContract()).toMatchObject({
      maximumDepth: 2, maximumCandidates: 100, maximumSeeds: 20,
      maximumAdjacencyQueries: 2,
    });
  }, 30_000);

  it("marks pre-0016 edges as legacy without a NOT NULL migration trap", async () => {
    const migration = await readFile("db/migrations/0016_memory_graph.sql", "utf8");
    expect(migration).toMatch(/provenance_kind[^;]+default 'LEGACY_0015'/isu);
    expect(migration).toMatch(/alter column provenance_kind set default 'RECONCILED'/isu);
    expect(migration).toMatch(/insert into memory_graph_legacy_edge_backfills[^;]+from memory_graph_edges/isu);
    expect(migration).not.toMatch(/add column first_reconciliation_run_id uuid not null/iu);
    const { db } = await testContext();
    expect(await db.one<{ backfill_table: string | null }>(
      `select to_regclass(current_schema()||'.memory_graph_legacy_edge_backfills')::text backfill_table`,
    )).toEqual({ backfill_table: "memory_graph_legacy_edge_backfills" });
  });

  it("appends entity and alias close/reopen versions without mutating prior eras", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "entity-eras");
    const entityId = randomUUID();
    const initial = rawGraphInput(fixture, "entity-eras-open", entityId);
    await versionMemoryGraph(createMemoryGraphWriterContext(db), initial);
    await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...initial,
      idempotencyKey: "memory-graph-raw:entity-eras-close",
      observedAt: "2026-08-09T10:03:00.000Z",
      entities: initial.entities.map((entity) => ({
        ...entity,
        validTo: "2026-08-20T10:00:00.000Z",
        aliases: entity.aliases.map((alias) => ({
          ...alias, validTo: "2026-08-20T10:00:00.000Z",
        })),
      })),
    });
    const reopenedAt = "2026-08-21T10:00:00.000Z";
    const reopened = await appendGraphMemory(fixture, "entity-eras-reopen", "bullish", reopenedAt);
    await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const,
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      idempotencyKey: "memory-graph-raw:entity-eras-reopen",
      reconcilerVersion: "temporal-memory-graph-v2",
      observedAt: "2026-08-21T10:02:00.000Z",
      entities: [{
        id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: reopenedAt,
        aliases: [{ alias: "AAPL", validFrom: reopenedAt, sourceIds: [reopened.source.id] }],
      }],
      claims: [{
        memoryId: reopened.memory.id, entityId, nodeType: "BELIEF" as const,
        predicate: "bias", value: "bullish", approved: true,
        validFrom: reopenedAt, sourceIds: [reopened.source.id],
      }],
    });
    expect(await db.one<{ entities: number; versions: number; aliases: number; closed: number; open: number }>(
      `select
        (select count(*)::int from memory_graph_entities where id=$1) entities,
        (select count(*)::int from memory_graph_entity_versions where entity_id=$1) versions,
        (select count(*)::int from memory_graph_entity_aliases where entity_id=$1) aliases,
        (select count(*)::int from memory_graph_entity_aliases
         where entity_id=$1 and valid_to is not null) closed,
        (select count(*)::int from memory_graph_entity_aliases
         where entity_id=$1 and valid_to is null and id not in (
           select supersedes_alias_id from memory_graph_entity_aliases
           where entity_id=$1 and supersedes_alias_id is not null
         )) open`,
      [entityId],
    )).toEqual({ entities: 1, versions: 3, aliases: 5, closed: 2, open: 1 });
    const chains = await db.query<{ supersedes_entity_version_id: string | null }>(
      `select supersedes_entity_version_id::text from memory_graph_entity_versions
       where entity_id=$1 order by created_at,id`,
      [entityId],
    );
    expect(chains.map(({ supersedes_entity_version_id }) => supersedes_entity_version_id === null))
      .toEqual([true, false, false]);
  }, 30_000);
});

describe("Stage A replay, append-order, and typed-authority closure", () => {
  it("replays the frozen raw request before dynamic heads or erased keys and revalidates authority", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "frozen-replay");
    const entityId = randomUUID();
    const firstInput = rawGraphInput(fixture, "frozen-replay:first", entityId);
    const first = await versionMemoryGraph(createMemoryGraphWriterContext(db), firstInput);
    const laterAt = "2026-08-21T10:00:00.000Z";
    const later = await appendGraphMemory(fixture, "frozen-replay:later", "bearish", laterAt);
    await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const,
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      idempotencyKey: "memory-graph-raw:frozen-replay:later",
      reconcilerVersion: "temporal-memory-graph-v2",
      observedAt: "2026-08-21T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: laterAt, aliases: [{ alias: "AAPL", validFrom: laterAt,
          sourceIds: [later.source.id] }] }],
      claims: [{ memoryId: later.memory.id, entityId, nodeType: "BELIEF" as const,
        predicate: "bias", value: "bearish", approved: true, validFrom: laterAt,
        sourceIds: [later.source.id] }],
    });
    expect(await versionMemoryGraph(createMemoryGraphWriterContext(db), firstInput)).toEqual(first);
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...firstInput,
      claims: firstInput.claims.map((claim, index) => (
        index === 1 ? { ...claim, approved: false } : claim
      )),
    })).rejects.toThrow("MEMORY_GRAPH_IDEMPOTENCY_KEY_REUSED");
    await db.query("delete from aggregate_data_keys where aggregate_id=$1", [fixture.conversationId]);
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), firstInput))
      .rejects.toThrow("MEMORY_GRAPH_REPLAY_UNAVAILABLE");
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...firstInput,
      claims: firstInput.claims.map((claim, index) => (
        index === 1 ? { ...claim, value: "changed-private-semantic" } : claim
      )),
    })).rejects.toThrow("MEMORY_GRAPH_REPLAY_UNAVAILABLE");
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...firstInput,
      claims: firstInput.claims.map((claim, index) => (
        index === 1 ? { ...claim, approved: false } : claim
      )),
    })).rejects.toThrow("MEMORY_GRAPH_IDEMPOTENCY_KEY_REUSED");
    await db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [
      fixture.accountId,
    ]);
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), firstInput))
      .rejects.toThrow("MEMORY_GRAPH_ACTOR_FORBIDDEN");
  }, 40_000);

  it("uses database append ordinals for backdated and equal-time version heads without branches", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "append-ordinals");
    const entityId = randomUUID();
    const initial = rawGraphInput(fixture, "append-ordinals:initial", entityId);
    await versionMemoryGraph(createMemoryGraphWriterContext(db), initial);
    const laterAt = "2026-08-21T10:00:00.000Z";
    const later = await appendGraphMemory(fixture, "append-ordinals:later", "bearish", laterAt);
    await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const,
      accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      idempotencyKey: "memory-graph-raw:append-ordinals:later",
      reconcilerVersion: "temporal-memory-graph-v2",
      observedAt: "2026-08-21T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: laterAt, aliases: [{ alias: "AAPL", validFrom: laterAt,
          sourceIds: [later.source.id] }] }],
      claims: [{ memoryId: later.memory.id, entityId, nodeType: "BELIEF" as const,
        predicate: "bias", value: "bearish", approved: true, validFrom: laterAt,
        sourceIds: [later.source.id] }],
    });
    const backdated = await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...initial,
      idempotencyKey: "memory-graph-raw:append-ordinals:backdated",
      entities: initial.entities.map((entity) => ({ ...entity,
        validTo: "2026-08-20T10:00:00.000Z",
        aliases: entity.aliases.map((alias) => ({ ...alias,
          validTo: "2026-08-20T10:00:00.000Z" })) })),
    });
    const versions = await db.query<{
      append_ordinal: string; reconciliation_run_id: string;
    }>(`select append_ordinal::text,reconciliation_run_id::text
        from memory_graph_head_versions where entity_id=$1 order by append_ordinal`, [entityId]);
    expect(versions.map(({ append_ordinal }) => Number(append_ordinal))).toEqual([1, 2, 3]);
    expect(await db.one<{ reconciliation_run_id: string }>(
      `select reconciliation_run_id::text from memory_graph_current_heads where entity_id=$1`,
      [entityId],
    )).toEqual({ reconciliation_run_id: backdated.reconciliationRunId });
    const entityOrdinals = await db.query<{ append_ordinal: string }>(
      `select append_ordinal::text from memory_graph_entity_versions
       where entity_id=$1 order by append_ordinal`, [entityId],
    );
    expect(entityOrdinals.map(({ append_ordinal }) => Number(append_ordinal))).toEqual([1, 2, 3]);
    await expect(db.query(
      `insert into memory_graph_head_versions (
         id,reconciliation_run_id,entity_id,predicate_digest,memory_id,
         supersedes_head_version_id,created_at
       ) select $1,reconciliation_run_id,entity_id,predicate_digest,memory_id,null,created_at
         from memory_graph_current_heads where entity_id=$2`,
      [randomUUID(), entityId],
    )).rejects.toThrow("MEMORY_GRAPH_HEAD_AUTHORITY_INVALID");
  }, 40_000);

  it("keeps a valid 100-claim incremental request within a durable 200-candidate bound", async () => {
    const { db } = await testContext();
    const base = await seedPrivateGraphMemories(db, "candidate-bound");
    const entityId = randomUUID();
    const old = await appendManyGraphMemories(base, "candidate-bound", "old", "2026-08-22T10:00:00.000Z");
    const makeInput = (phase: "old" | "new", sourceId: string,
      memories: readonly { id: string; keywords: readonly string[] }[], at: string) => ({
      scope: "PRIVATE_ACCOUNT" as const,
      accountId: base.accountId, nodeBrainId: base.nodeBrainId, conversationId: base.conversationId,
      idempotencyKey: `memory-graph-many:${phase}`,
      reconcilerVersion: "temporal-memory-graph-v2",
      observedAt: new Date(new Date(at).getTime() + 120_000).toISOString(),
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: at, aliases: [{ alias: "AAPL", validFrom: at, sourceIds: [sourceId] }] }],
      claims: memories.map((memory) => ({ memoryId: memory.id, entityId,
        nodeType: "BELIEF" as const,
        predicate: memory.keywords.find((keyword) => keyword.startsWith("predicate-"))!,
        value: memory.keywords.find((keyword) => keyword.startsWith(`${phase}-`))!,
        approved: true, validFrom: at, sourceIds: [sourceId] })),
    });
    await versionMemoryGraph(createMemoryGraphWriterContext(db),
      makeInput("old", old.source.id, old.memories, "2026-08-22T10:00:00.000Z"));
    const newer = await appendManyGraphMemories(base, "candidate-bound", "new", "2026-08-23T10:00:00.000Z");
    const result = await versionMemoryGraph(createMemoryGraphWriterContext(db),
      makeInput("new", newer.source.id, newer.memories, "2026-08-23T10:00:00.000Z"));
    expect(await db.one<{ candidates: number; manifest_memories: number }>(
      `select run.candidate_count candidates,cardinality(manifest.memory_ids) manifest_memories
       from memory_graph_reconciliation_runs run
       join memory_graph_event_manifests manifest on manifest.reconciliation_run_id=run.id
       where run.id=$1`, [result.reconciliationRunId],
    )).toEqual({ candidates: 200, manifest_memories: 200 });
  }, 80_000);

  it("persists all 5,050 conflicts and 5,150 required edges for 100 requested plus one head", async () => {
    const { db } = await testContext();
    const base = await seedPrivateGraphMemories(db, "same-group-maximum");
    const entityId = randomUUID();
    const priorBatch = await appendManyGraphMemories(
      base, "same-group-maximum", "old", "2026-08-22T10:00:00.000Z",
    );
    const prior = priorBatch.memories[0]!;
    await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: base.accountId,
      nodeBrainId: base.nodeBrainId, conversationId: base.conversationId,
      idempotencyKey: "memory-graph:same-group-maximum:prior",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-22T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: "2026-08-22T10:00:00.000Z", aliases: [{ alias: "AAPL",
          validFrom: "2026-08-22T10:00:00.000Z", sourceIds: [priorBatch.source.id] }] }],
      claims: [{ memoryId: prior.id, entityId, nodeType: "BELIEF" as const,
        predicate: "shared-predicate", value: "old-0", approved: true,
        validFrom: "2026-08-22T10:00:00.000Z", sourceIds: [priorBatch.source.id] }],
    });
    const requested = await appendManyGraphMemories(
      base, "same-group-maximum", "new", "2026-08-23T10:00:00.000Z",
    );
    const counted = queryCountingDatabase(db);
    const run = await versionMemoryGraph(createMemoryGraphWriterContext(counted.db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: base.accountId,
      nodeBrainId: base.nodeBrainId, conversationId: base.conversationId,
      idempotencyKey: "memory-graph:same-group-maximum:requested",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-23T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: "2026-08-22T10:00:00.000Z", aliases: [{ alias: "AAPL",
          validFrom: "2026-08-23T10:00:00.000Z", sourceIds: [requested.source.id] }] }],
      claims: requested.memories.map((memory) => ({ memoryId: memory.id, entityId,
        nodeType: "BELIEF" as const, predicate: "shared-predicate",
        value: memory.keywords.find((keyword) => keyword.startsWith("new-"))!,
        approved: true, validFrom: "2026-08-23T10:00:00.000Z",
        sourceIds: [requested.source.id] })),
    });
    expect(await db.one<{
      candidates: number; conflicts: number; edges: number; manifest_relations: number;
    }>(
      `select run.candidate_count candidates,run.conflict_count conflicts,run.edge_count edges,
              manifest.relation_count manifest_relations
       from memory_graph_reconciliation_runs run
       join memory_graph_event_manifests manifest on manifest.reconciliation_run_id=run.id
       where run.id=$1`, [run.reconciliationRunId],
    )).toEqual({ candidates: 101, conflicts: 5_050, edges: 5_150, manifest_relations: 5_150 });
    expect(run.conflicts).toHaveLength(5_050);
    expect(run.edges).toHaveLength(5_150);
    expect(counted.queries()).toBeLessThanOrEqual(500);
    const binding = await db.one<{ event_id: string; ciphertext_bytes: number }>(
      `select run.graph_event_id::text event_id,octet_length(body.ciphertext)::int ciphertext_bytes
       from memory_graph_reconciliation_runs run
       join encrypted_event_bodies body on body.event_id=run.graph_event_id
       where run.id=$1`, [run.reconciliationRunId],
    );
    expect(binding.ciphertext_bytes).toBeLessThanOrEqual(8_192);
    expect(JSON.stringify(await readEventBody(db, binding.event_id,
      { actor: { role: "SYSTEM" } })).length).toBeLessThanOrEqual(8_192);
  }, 180_000);

  it("queues source-only overflow at 5,150 edges without dropping required topology", async () => {
    const { db } = await testContext();
    const base = await seedPrivateGraphMemories(db, "edge-source-work-budget");
    const entityId = randomUUID();
    const priorBatch = await appendManyGraphMemories(
      base, "edge-source-work-budget", "old", "2026-08-22T10:00:00.000Z",
    );
    await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: base.accountId,
      nodeBrainId: base.nodeBrainId, conversationId: base.conversationId,
      idempotencyKey: "memory-graph:edge-source-work-budget:prior",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-22T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: "2026-08-22T10:00:00.000Z", aliases: [{ alias: "AAPL",
          validFrom: "2026-08-22T10:00:00.000Z", sourceIds: [priorBatch.source.id] }] }],
      claims: [{ memoryId: priorBatch.memories[0]!.id, entityId,
        nodeType: "BELIEF" as const, predicate: "shared-predicate", value: "old-0",
        approved: true, validFrom: "2026-08-22T10:00:00.000Z",
        sourceIds: [priorBatch.source.id] }],
    });
    const requested = await appendManyGraphMemories(
      base, "edge-source-work-budget", "new", "2026-08-23T10:00:00.000Z", true,
    );
    const queued = await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: base.accountId,
      nodeBrainId: base.nodeBrainId, conversationId: base.conversationId,
      idempotencyKey: "memory-graph:edge-source-work-budget:requested",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-23T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: "2026-08-22T10:00:00.000Z", aliases: [{ alias: "AAPL",
          validFrom: "2026-08-23T10:00:00.000Z",
          sourceIds: requested.memories[0]!.sourceIds }] }],
      claims: requested.memories.map((memory) => ({ memoryId: memory.id, entityId,
        nodeType: "BELIEF" as const, predicate: "shared-predicate",
        value: memory.keywords.find((keyword) => keyword.startsWith("new-"))!,
        approved: true, validFrom: "2026-08-23T10:00:00.000Z",
        sourceIds: memory.sourceIds })),
    });
    expect(queued).toMatchObject({ status: "QUEUED", reconciliationRunId: null,
      edges: [], conflicts: [] });
    expect(await db.one<{ estimated_edge_count: number; estimated_edge_source_count: number }>(
      `select estimated_edge_count,estimated_edge_source_count
       from memory_graph_reconciliation_jobs where id=$1`, [queued.backgroundJobId],
    )).toEqual({ estimated_edge_count: 5_150, estimated_edge_source_count: 10_401 });
    expect(await db.one<{ edges: number; conflicts: number }>(
      `select (select count(*)::int from memory_graph_edges
               where first_reconciliation_run_id is null) edges,
              (select count(*)::int from memory_conflicts
               where first_reconciliation_run_id is null) conflicts`,
    )).toEqual({ edges: 0, conflicts: 0 });
  }, 180_000);

  it("queues zero-edge 552,550-row node, alias, member, and source work set-wise", async () => {
    const { db } = await testContext();
    const identity = await createConversationFixture("Graph maximum materialization", db);
    const at = "2026-08-24T10:00:00.000Z";
    const sources = [] as Array<{ id: string; occurredAt: Date }>;
    for (let index = 0; index < 500; index += 1) {
      sources.push(await appendEvent(db, {
        aggregateId: identity.conversationId, accountId: identity.accountId,
        actor: { type: "USER", id: identity.accountId }, type: "message.completed",
        visibility: "PRIVATE_ACCOUNT", body: { text: `Authority source ${index}.` },
        occurredAt: new Date(at), idempotencyKey: `memory-graph-max-work-source:${index}`,
      }));
    }
    const entityTerms = Array.from({ length: 50 }, (_, entityIndex) => ({
      canonical: `entity-${entityIndex}`,
      aliases: Array.from({ length: 20 }, (__, aliasIndex) => (
        `entity-${entityIndex}-alias-${aliasIndex}`
      )),
    }));
    const sourceIds = sources.map(({ id }) => id);
    const facts = Array.from({ length: 100 }, (_, index) => {
      const entity = entityTerms[index % 50]!;
      return { text: `Fact ${index} for ${entity.canonical}.`, sourceIds,
        entities: [entity.canonical, ...entity.aliases],
        keywords: [`predicate-${index}`, `value-${index}`], validFrom: at };
    });
    const projected = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: identity.accountId,
      nodeBrainId: identity.nodeBrainId, conversationId: identity.conversationId,
      sourceEventId: sources.at(-1)!.id,
      events: sources.map((source, index) => ({ id: source.id,
        at: source.occurredAt.toISOString(), text: `Authority source ${index}.` })),
      extracted: { facts }, versions: VERSIONS,
      observedAt: "2026-08-24T10:01:00.000Z",
      idempotencyKey: "memory-graph-max-work-consolidation",
    });
    const projectedMemories = [...projected.memories];
    const syntheticRuns = projectedMemories.map((memory) => {
      const predicate = memory.keywords.find((keyword) => keyword.startsWith("predicate-"))!;
      const index = Number(predicate.slice("predicate-".length));
      return { memoryId: memory.id, extractionRunId: `00000000-0000-4000-8000-${String(
        (index % 50) + 1,
      ).padStart(12, "0")}` };
    });
    await db.transaction(async (transaction) => {
      await transaction.query("set local session_replication_role='replica'");
      await transaction.query(
        `with input as (select * from jsonb_to_recordset($1::jsonb)
           as item("memoryId" uuid,"extractionRunId" uuid))
         update memory_records memory set extraction_run_id=input."extractionRunId"
         from input where memory.id=input."memoryId"`, [JSON.stringify(syntheticRuns)],
      );
    });
    const entityIds = entityTerms.map(() => randomUUID());
    const counted = queryCountingDatabase(db);
    const queued = await versionMemoryGraph(createMemoryGraphWriterContext(counted.db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: identity.accountId,
      nodeBrainId: identity.nodeBrainId, conversationId: identity.conversationId,
      idempotencyKey: "memory-graph-max-work-queue",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-24T10:02:00.000Z",
      entities: entityTerms.map((entity, index) => ({ id: entityIds[index]!,
        type: "INSTRUMENT" as const, canonicalName: entity.canonical, validFrom: at,
        aliases: entity.aliases.map((alias) => ({ alias, validFrom: at,
          sourceIds })) })),
      claims: projectedMemories.map((memory) => {
        const predicate = memory.keywords.find((keyword) => keyword.startsWith("predicate-"))!;
        const index = Number(predicate.slice("predicate-".length));
        return { memoryId: memory.id, entityId: entityIds[index % 50]!,
          nodeType: "FACT" as const, predicate, value: `value-${index}`,
          approved: true, validFrom: at, sourceIds: memory.sourceIds };
      }),
    });
    expect(queued).toMatchObject({ status: "QUEUED", reconciliationRunId: null,
      edges: [], conflicts: [] });
    expect(counted.queries()).toBeLessThanOrEqual(60);
    expect(await db.one<{
      estimated_edge_count: number; estimated_edge_source_count: number;
      estimated_materialization_rows: number; normalized_rows: number;
    }>(
      `select job.estimated_edge_count,job.estimated_edge_source_count,
              job.estimated_materialization_rows,
              (select count(*)::int from memory_graph_reconciliation_job_sources source
                where source.job_id=job.id)
              +(select count(*)::int from memory_graph_reconciliation_job_source_sets source_set
                where source_set.job_id=job.id)
              +(select count(*)::int from memory_graph_reconciliation_job_entities entity
                where entity.job_id=job.id)
              +(select count(*)::int from memory_graph_reconciliation_job_aliases alias
                where alias.job_id=job.id)
              +(select count(*)::int from memory_graph_reconciliation_job_candidates candidate
                where candidate.job_id=job.id) normalized_rows
       from memory_graph_reconciliation_jobs job where job.id=$1`, [queued.backgroundJobId],
    )).toEqual({ estimated_edge_count: 0, estimated_edge_source_count: 0,
      estimated_materialization_rows: 552_550, normalized_rows: 1_651 });
    expect(await db.one<{ entities: number; nodes: number }>(
      `select (select count(*)::int from memory_graph_entities
               where id=any($1::uuid[])) entities,
              (select count(*)::int from memory_graph_nodes
               where memory_id=any($2::uuid[])) nodes`,
      [entityIds, projectedMemories.map(({ id }) => id)],
    )).toEqual({ entities: 0, nodes: 0 });
  }, 300_000);

  it("persists synchronous node, alias, member, and source rows in fixed query groups", async () => {
    const { db } = await testContext();
    const identity = await createConversationFixture("Graph set-wise materialization", db);
    const at = "2026-08-25T10:00:00.000Z";
    const aliases = Array.from({ length: 20 }, (_, index) => `material-alias-${index}`);
    const events = [] as Array<{ id: string; occurredAt: Date }>;
    for (let index = 0; index < 100; index += 1) {
      events.push(await appendEvent(db, {
        aggregateId: identity.conversationId, accountId: identity.accountId,
        actor: { type: "USER", id: identity.accountId }, type: "message.completed",
        visibility: "PRIVATE_ACCOUNT", body: { text: `Material source ${index}.` },
        occurredAt: new Date(at), idempotencyKey: `memory-graph-material-source:${index}`,
      }));
    }
    const sourceIds = events.map(({ id }) => id);
    const projected = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: identity.accountId,
      nodeBrainId: identity.nodeBrainId, conversationId: identity.conversationId,
      sourceEventId: events.at(-1)!.id,
      events: events.map((event, index) => ({ id: event.id,
        at: event.occurredAt.toISOString(), text: `Material source ${index}.` })),
      extracted: { facts: [{ text: "Material canonical fact", sourceIds,
        entities: ["material-canonical", ...aliases], keywords: ["material-key", "material-value"],
        validFrom: at }] }, versions: VERSIONS, observedAt: "2026-08-25T10:01:00.000Z",
      idempotencyKey: "memory-graph-material-consolidation",
    });
    const counted = queryCountingDatabase(db);
    const entityId = randomUUID();
    const result = await versionMemoryGraph(createMemoryGraphWriterContext(counted.db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: identity.accountId,
      nodeBrainId: identity.nodeBrainId, conversationId: identity.conversationId,
      idempotencyKey: "memory-graph-material-version", reconcilerVersion: "temporal-memory-graph-v2",
      observedAt: "2026-08-25T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const,
        canonicalName: "material-canonical", validFrom: at,
        aliases: aliases.map((alias) => ({ alias, validFrom: at, sourceIds })) }],
      claims: [{ memoryId: projected.memories[0]!.id,
        entityId, nodeType: "FACT" as const,
        predicate: "material-key", value: "material-value", approved: true,
        validFrom: at, sourceIds }],
    });
    expect(result.status).toBe("COMPLETED");
    expect(counted.queries()).toBeLessThanOrEqual(80);
  }, 90_000);

  it("revalidates current job ownership before idempotent action replay", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "job-owner-replay");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), graphInput(fixture, "job-owner-replay"));
    const traversal = await authorizeMemoryGraphTraversal(db, { role: "ACCOUNT",
      accountId: fixture.accountId });
    const queued = await traverseMemoryGraph(traversal, { seedMemoryIds: [fixture.memories[0]!.id],
      requestedDepth: 8, candidateLimit: 1, asOf: "2026-08-10T00:00:00.000Z",
      idempotencyKey: "job-owner-replay" });
    const worker = await graphModule.authorizeMemoryGraphJobWorker(db, {
      actorId: "memory-graph-worker", purpose: "DEEP_RESEARCH",
    });
    const claim = { jobId: queued.backgroundJobId, workerId: "worker-owner",
      at: "2026-08-10T00:01:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "job-owner-replay:claim" };
    await graphModule.claimMemoryGraphBackgroundJob(worker, claim);
    await db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [
      fixture.accountId,
    ]);
    await expect(graphModule.claimMemoryGraphBackgroundJob(worker, claim))
      .rejects.toThrow("MEMORY_GRAPH_ACTOR_FORBIDDEN");
  }, 30_000);

  it("rejects a direct job transition after owner revocation before accepting event-backed state", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "job-direct-owner");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), graphInput(fixture, "job-direct-owner"));
    const traversal = await authorizeMemoryGraphTraversal(db, { role: "ACCOUNT",
      accountId: fixture.accountId });
    const queued = await traverseMemoryGraph(traversal, { seedMemoryIds: [fixture.memories[0]!.id],
      requestedDepth: 8, candidateLimit: 1, asOf: "2026-08-10T00:00:00.000Z",
      idempotencyKey: "job-direct-owner" });
    const worker = await graphModule.authorizeMemoryGraphJobWorker(db, {
      actorId: "memory-graph-worker", purpose: "DEEP_RESEARCH",
    });
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: queued.backgroundJobId, workerId: "worker-direct",
      at: "2026-08-10T00:01:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "job-direct-owner:claim",
    });
    const unboundOperation = canonicalContentDigest({ action: "FAIL",
      jobId: queued.backgroundJobId, workerId: "worker-direct",
      errorCode: "UNBOUND", retryAt: null });
    await expect(db.transaction(async (transaction) => {
      const createdAt = (await transaction.one<{ at: Date }>(
        "select date_trunc('milliseconds',transaction_timestamp()) at",
      )).at;
      const unboundEvent = await appendEvent(transaction, {
        aggregateId: `memory-graph-job:${queued.backgroundJobId}`,
        accountId: fixture.accountId, actor: { type: "SYSTEM", id: "memory-graph-worker" },
        type: "memory.graph.background.failed", visibility: "PRIVATE_ACCOUNT",
        body: { jobId: queued.backgroundJobId, fromStatus: "CLAIMED", toStatus: "FAILED",
          workerId: "worker-direct", errorCode: "UNBOUND" }, occurredAt: createdAt,
        idempotencyKey: `memory-graph-job-event:job-direct-owner:unbound:${unboundOperation}`,
      });
      await transaction.query(
        `insert into memory_graph_background_job_transitions (
           id,job_id,ordinal,from_status,to_status,worker_id,error_code,transition_event_id,
           idempotency_key,operation_digest,created_at
         ) select $1,$2,max(ordinal)+1,'CLAIMED','FAILED','worker-direct','UNBOUND',$3,$4,$5,$6
           from memory_graph_background_job_transitions where job_id=$2`,
        [randomUUID(), queued.backgroundJobId, unboundEvent.id, "job-direct-owner:unbound",
          unboundOperation, createdAt],
      );
    })).rejects.toThrow("INCOMPLETE_MEMORY_GRAPH_EVENT");
    await db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [
      fixture.accountId,
    ]);
    await expect(db.transaction(async (transaction) => {
      const createdAt = (await transaction.one<{ at: Date }>(
        "select date_trunc('milliseconds',transaction_timestamp()) at",
      )).at;
      const forgedEvent = await appendEvent(transaction, {
        aggregateId: `memory-graph-job:${queued.backgroundJobId}`,
        accountId: fixture.accountId, actor: { type: "SYSTEM", id: "memory-graph-worker" },
        type: "memory.graph.background.failed", visibility: "PRIVATE_ACCOUNT",
        body: { jobId: queued.backgroundJobId, fromStatus: "CLAIMED", toStatus: "FAILED",
          workerId: "worker-direct", errorCode: "FORGED" }, occurredAt: createdAt,
        idempotencyKey: "job-direct-owner:forged-event",
      });
      await transaction.query(
        `insert into memory_graph_background_job_transitions (
           id,job_id,ordinal,from_status,to_status,worker_id,error_code,transition_event_id,
           idempotency_key,operation_digest,created_at
         ) select $1,$2,max(ordinal)+1,'CLAIMED','FAILED','worker-direct','FORGED',$3,$4,$5,$6
           from memory_graph_background_job_transitions where job_id=$2`,
        [randomUUID(), queued.backgroundJobId, forgedEvent.id, "job-direct-owner:forged",
          digest("forged-job-operation"), createdAt],
      );
    })).rejects.toThrow("MEMORY_GRAPH_JOB_OWNER_FORBIDDEN");
  }, 30_000);

  it("forbids caller relations and direct SQL edges without kind-specific durable authority", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    expect(graphModule).toHaveProperty("memoryGraphRelationPolicy");
    expect((graphModule as unknown as { memoryGraphRelationPolicy: () => unknown }).memoryGraphRelationPolicy())
      .toEqual({
        MENTIONS: "SOURCE_ENTITY", SUPPORTS: "MATCHING_APPROVED_CLAIM",
        CONTRADICTS: "AUTO_CONFLICT", SUPERSEDES: "AUTO_CURRENT",
        DERIVED_FROM: "MEMORY_DERIVATION", PROPOSED_BY: "PROPOSAL_CREATED_ANY_STATUS",
        ACCEPTED_INTO: "PROPOSAL_ACCEPTED", AFFECTED: "PROPOSAL_AFFECTED_STATE",
        RESULTED_IN: "EVENT_CAUSATION", SIMILAR_TO: "MEMORY_EQUIVALENCE",
        PART_OF: "EXTRACTION_EPISODE",
      });
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "relation-forgery");
    const input = rawGraphInput(fixture, "relation-forgery");
    const allKinds = ["MENTIONS", "SUPPORTS", "CONTRADICTS", "SUPERSEDES", "DERIVED_FROM",
      "PROPOSED_BY", "ACCEPTED_INTO", "AFFECTED", "RESULTED_IN", "SIMILAR_TO", "PART_OF"];
    await expect(versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...input,
      relationships: allKinds.map((type) => ({ from: fixture.memories[1]!.id, type,
        to: fixture.memories[0]!.id, validFrom: NEW_AT,
        validTo: fixture.memories[0]!.validTo!,
        sourceIds: [fixture.oldSource.id, fixture.newSource.id].sort() })),
    })).rejects.toThrow("MEMORY_GRAPH_RELATIONSHIP_INPUT_FORBIDDEN");
    const run = await versionMemoryGraph(createMemoryGraphWriterContext(db), input);
    const forgedKinds = allKinds.filter((type) => type !== "CONTRADICTS" && type !== "SUPERSEDES");
    const outcomes = await Promise.all(forgedKinds.map(async (type) => {
      try {
        await db.query(
          `insert into memory_graph_edges (
             id,source_memory_id,target_memory_id,type,scope,account_id,node_brain_id,
             conversation_id,valid_from,valid_to,created_at,first_reconciliation_run_id,source_count
           ) values ($1,$2,$3,$4,'PRIVATE_ACCOUNT',$5,$6,$7,$8,$9,$10,$11,2)`,
          [randomUUID(), fixture.memories[1]!.id, fixture.memories[0]!.id, type,
            fixture.accountId, fixture.nodeBrainId, fixture.conversationId, NEW_AT,
            fixture.memories[0]!.validTo, "2026-08-09T10:02:00.000Z", run.reconciliationRunId],
        );
        return "ACCEPTED";
      } catch (error) {
        return error instanceof Error ? error.message : "UNKNOWN";
      }
    }));
    expect(outcomes).toEqual(forgedKinds.map(() => "MEMORY_GRAPH_EDGE_AUTHORITY_INVALID"));
  }, 30_000);

  it("derives positive typed relations from durable extraction/equivalence authority and binds them", async () => {
    const { db } = await testContext();
    const supportFixture = await seedPrivateGraphMemories(db, "relation-positive-support");
    const repeatedAt = "2026-08-10T10:00:00.000Z";
    const repeated = await appendGraphMemory(
      supportFixture, "relation-positive-support:repeated", "bullish", repeatedAt,
    );
    const supportEntityId = randomUUID();
    const supported = await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const,
      accountId: supportFixture.accountId, nodeBrainId: supportFixture.nodeBrainId,
      conversationId: supportFixture.conversationId,
      idempotencyKey: "memory-graph-raw:relation-positive-support",
      reconcilerVersion: "temporal-memory-graph-v2",
      observedAt: "2026-08-10T10:02:00.000Z",
      entities: [{ id: supportEntityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: OLD_AT, aliases: [{ alias: "AAPL", validFrom: OLD_AT,
          sourceIds: [supportFixture.oldSource.id, repeated.source.id].sort() }] }],
      claims: [
        { memoryId: supportFixture.memories[0]!.id, entityId: supportEntityId,
          nodeType: "BELIEF" as const, predicate: "bias", value: "bullish", approved: true,
          validFrom: OLD_AT, validTo: supportFixture.memories[0]!.validTo!,
          sourceIds: [supportFixture.oldSource.id] },
        { memoryId: repeated.memory.id, entityId: supportEntityId, nodeType: "BELIEF" as const,
          predicate: "bias", value: "bullish", approved: true, validFrom: repeatedAt,
          sourceIds: [repeated.source.id] },
      ],
    });
    expect(new Set(supported.edges.map(({ type }) => type))).toEqual(
      new Set(["SUPPORTS", "SIMILAR_TO"]),
    );
    const manifest = await db.one<{ relation_count: number; relation_digest: string }>(
      `select manifest.relation_count,manifest.relation_digest
       from memory_graph_event_manifests manifest where manifest.reconciliation_run_id=$1`,
      [supported.reconciliationRunId],
    );
    expect(manifest.relation_count).toBe(supported.edges.length);
    expect(manifest.relation_digest).toBe(await db.one<{ digest: string }>(
      "select memory_graph_relation_digest($1) digest", [supported.reconciliationRunId],
    ).then(({ digest }) => digest));
    const graphEventId = await db.one<{ id: string }>(
      "select graph_event_id::text id from memory_graph_reconciliation_runs where id=$1",
      [supported.reconciliationRunId],
    );
    const body = await readEventBody(db, graphEventId.id, { actor: { role: "SYSTEM" } }) as {
      counts: { relationships: number }; digests: { relationships: string };
    };
    expect(body.counts.relationships).toBe(supported.edges.length);
    expect(body.digests.relationships).toBe(manifest.relation_digest);

    const mentionFixture = await seedPrivateGraphMemories(db, "relation-positive-mentions");
    const appleId = randomUUID();
    const tickerId = randomUUID();
    const mentioned = await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const,
      accountId: mentionFixture.accountId, nodeBrainId: mentionFixture.nodeBrainId,
      conversationId: mentionFixture.conversationId,
      idempotencyKey: "memory-graph-raw:relation-positive-mentions",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-09T10:02:00.000Z",
      entities: [
        { id: appleId, type: "INSTRUMENT" as const, canonicalName: "Apple Inc.",
          validFrom: OLD_AT, aliases: [{ alias: "Apple Inc.", validFrom: OLD_AT,
            sourceIds: [mentionFixture.oldSource.id] }] },
        { id: tickerId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
          validFrom: NEW_AT, aliases: [{ alias: "AAPL", validFrom: NEW_AT,
            sourceIds: [mentionFixture.newSource.id] }] },
      ],
      claims: [
        { memoryId: mentionFixture.memories[0]!.id, entityId: appleId,
          nodeType: "BELIEF" as const, predicate: "bias", value: "bullish", approved: true,
          validFrom: OLD_AT, validTo: mentionFixture.memories[0]!.validTo!,
          sourceIds: [mentionFixture.oldSource.id] },
        { memoryId: mentionFixture.memories[1]!.id, entityId: tickerId,
          nodeType: "BELIEF" as const, predicate: "bias", value: "neutral", approved: true,
          validFrom: NEW_AT, sourceIds: [mentionFixture.newSource.id] },
      ],
    });
    expect(mentioned.edges.map(({ type }) => type)).toEqual(["MENTIONS", "MENTIONS"]);

    const migration = await readFile("db/migrations/0016_memory_graph.sql", "utf8");
    for (const authority of ["memory_records", "proposals", "proposal_status_transitions",
      "events", "memory_equivalence_links", "EPISODIC"]) {
      expect(migration).toContain(authority);
    }
  }, 40_000);

  it("derives correction and episode relations from exact durable typed records", async () => {
    const { db } = await testContext();
    const correctionFixture = await seedPrivateGraphMemories(db, "relation-positive-correction");
    const correctionAt = "2026-08-10T10:00:00.000Z";
    const correctionSource = await appendEvent(db, {
      aggregateId: correctionFixture.conversationId, accountId: correctionFixture.accountId,
      actor: { type: "USER", id: correctionFixture.accountId }, type: "message.completed",
      visibility: "PRIVATE_ACCOUNT", body: { text: "My AAPL bias is now bearish." },
      occurredAt: new Date(correctionAt), idempotencyKey: "memory-source:graph-derived-correction",
    });
    const correctionProjection = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: correctionFixture.accountId,
      nodeBrainId: correctionFixture.nodeBrainId, conversationId: correctionFixture.conversationId,
      sourceEventId: correctionSource.id,
      events: [{ id: correctionSource.id, at: correctionAt, text: "My AAPL bias is now bearish." }],
      extracted: { facts: [{ text: "AAPL bias is bearish", sourceIds: [correctionSource.id],
        entities: ["AAPL"], keywords: ["bias", "bearish"], validFrom: correctionAt,
        supersedesMemoryId: correctionFixture.memories[0]!.id,
        correctionState: "USER_CORRECTED" as const }] },
      versions: VERSIONS, observedAt: "2026-08-10T10:01:00.000Z",
      idempotencyKey: "memory-consolidation:graph-derived-correction",
    });
    const corrected = correctionProjection.memories[0]!;
    const correctionEntityId = randomUUID();
    const correctionRun = await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: correctionFixture.accountId,
      nodeBrainId: correctionFixture.nodeBrainId, conversationId: correctionFixture.conversationId,
      idempotencyKey: "memory-graph-raw:relation-positive-correction",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-10T10:02:00.000Z",
      entities: [{ id: correctionEntityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: OLD_AT, aliases: [{ alias: "AAPL", validFrom: OLD_AT,
          sourceIds: [correctionFixture.oldSource.id, correctionSource.id].sort() }] }],
      claims: [
        { memoryId: correctionFixture.memories[0]!.id, entityId: correctionEntityId,
          nodeType: "BELIEF" as const, predicate: "bias", value: "bullish", approved: true,
          validFrom: OLD_AT, validTo: correctionFixture.memories[0]!.validTo!,
          sourceIds: [correctionFixture.oldSource.id] },
        { memoryId: corrected.id, entityId: correctionEntityId, nodeType: "BELIEF" as const,
          predicate: "bias", value: "bearish", approved: true, validFrom: correctionAt,
          sourceIds: [correctionSource.id] },
      ],
    });
    expect(correctionRun.edges).toContainEqual(expect.objectContaining({
      from: corrected.id, type: "DERIVED_FROM", to: correctionFixture.memories[0]!.id,
      validFrom: correctionAt, validTo: correctionFixture.memories[0]!.validTo,
    }));

    const episodeFixture = await createConversationFixture("Graph relation episode", db);
    const episodeAt = "2026-08-11T10:00:00.000Z";
    const episodeSource = await appendEvent(db, {
      aggregateId: episodeFixture.conversationId, accountId: episodeFixture.accountId,
      actor: { type: "USER", id: episodeFixture.accountId }, type: "message.completed",
      visibility: "PRIVATE_ACCOUNT", body: { text: "AAPL was bullish during the session." },
      occurredAt: new Date(episodeAt), idempotencyKey: "memory-source:graph-part-of",
    });
    const episodeProjection = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: episodeFixture.accountId,
      nodeBrainId: episodeFixture.nodeBrainId, conversationId: episodeFixture.conversationId,
      sourceEventId: episodeSource.id,
      events: [{ id: episodeSource.id, at: episodeAt, text: "AAPL was bullish during the session." }],
      extracted: {
        facts: [{ text: "AAPL was bullish", sourceIds: [episodeSource.id],
          entities: ["AAPL"], keywords: ["fact", "bullish"] }],
        episodes: [{ text: "AAPL bullish session", sourceIds: [episodeSource.id],
          entities: ["AAPL"], keywords: ["episode", "session"] }],
      },
      versions: VERSIONS, observedAt: "2026-08-11T10:01:00.000Z",
      idempotencyKey: "memory-consolidation:graph-part-of",
    });
    const fact = episodeProjection.memories.find(({ type }) => type === "SEMANTIC")!;
    const episode = episodeProjection.memories.find(({ type }) => type === "EPISODIC")!;
    const episodeEntityId = randomUUID();
    const episodeRun = await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: episodeFixture.accountId,
      nodeBrainId: episodeFixture.nodeBrainId, conversationId: episodeFixture.conversationId,
      idempotencyKey: "memory-graph-raw:relation-positive-part-of",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-11T10:02:00.000Z",
      entities: [{ id: episodeEntityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: fact.validFrom, aliases: [{ alias: "AAPL", validFrom: fact.validFrom,
          sourceIds: [episodeSource.id] }] }],
      claims: [
        { memoryId: fact.id, entityId: episodeEntityId, nodeType: "FACT" as const,
          predicate: "fact", value: "bullish", approved: true, validFrom: fact.validFrom,
          sourceIds: [episodeSource.id] },
        { memoryId: episode.id, entityId: episodeEntityId, nodeType: "EPISODE" as const,
          predicate: "episode", value: "session", approved: true, validFrom: episode.validFrom,
          sourceIds: [episodeSource.id] },
      ],
    });
    expect(episodeRun.edges).toContainEqual(expect.objectContaining({
      from: fact.id, type: "PART_OF", to: episode.id,
    }));
  }, 40_000);

  it("derives pending and accepted proposal, affected-state, and causation relations end to end", async () => {
    vi.stubEnv("GUSTAVO_COUNCIL_PSEUDONYM_KEY", randomBytes(32).toString("base64"));
    const { db } = await testContext();
    const fixture = await createConversationFixture("Graph relation proposal", db);
    const source = await appendMessage(fixture, {
      idempotencyKey: "graph-relation-proposal-source", role: "USER",
      text: "AAPL rejection should update the method.",
    });
    const state = await db.one<{ version: string }>(
      `insert into main_state_versions(version,author_type,author_id,status)
       values ((select coalesce(max(version),0)+1 from main_state_versions),
         'MAIN_BRAIN','gustavo-main','COMMITTED') returning version::text`,
    );
    const route = await routeNodeReply({
      db, accountId: fixture.accountId, conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId, userMessageEventId: source.eventId,
      coveredByMain: false, contradiction: true, materialEvidence: true, confidence: 0.95,
      mainStateVersion: state.version, sourceIds: [source.eventId],
    }, async () => undefined);
    const proposal = await createProposal({ db }, {
      accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, sourceEventIds: [source.eventId],
      routeEventId: route.routingEventId, affectedMainStateIds: [state.version],
      privacyScope: "PROPOSAL_SUMMARY", proposedChange: "Update the rejection method.",
      evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }], counterevidence: [],
      uncertainty: "Confirmation remains pending.", idempotencyKey: "graph-relation-proposal",
    });
    const proposalRow = await db.one<{ created_event_id: string }>(
      "select created_event_id::text from proposals where id=$1", [proposal.id],
    );
    const sourceEvents = await db.query<{ id: string; occurred_at: Date }>(
      `select id::text,occurred_at from events where id=any($1::uuid[]) order by occurred_at,id`,
      [[source.eventId, route.routingEventId]],
    );
    const sourceTextById = new Map(await Promise.all(sourceEvents.map(async (event) => {
      const body = await readEventBody(db, event.id, { actor: { role: "SYSTEM" } });
      const direct = body && !Array.isArray(body) && typeof body === "object" ? body.text : undefined;
      return [event.id, typeof direct === "string" ? direct : canonicalJson(body)] as const;
    })));
    const proposalProjection = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, sourceEventId: route.routingEventId,
      events: sourceEvents.map((event) => ({ id: event.id, at: event.occurred_at.toISOString(),
        text: sourceTextById.get(event.id)! })),
      extracted: { facts: [
        { text: "AAPL rejection source", sourceIds: [source.eventId], entities: ["AAPL"],
          keywords: ["source", "message"] },
        { text: "Routing proposal decision", sourceIds: [route.routingEventId], entities: ["Proposal"],
          keywords: ["proposal", "decision"] },
      ] },
      versions: VERSIONS,
      observedAt: new Date(Math.max(...sourceEvents.map(({ occurred_at }) => occurred_at.getTime()))
        + 60_000).toISOString(),
      idempotencyKey: "memory-consolidation:graph-relation-proposal",
    });
    const bySource = new Map(proposalProjection.memories.map((memory) => [memory.sourceIds[0], memory]));
    const sourceMemory = bySource.get(source.eventId)!;
    const proposalMemory = bySource.get(route.routingEventId)!;
    const entityByMemory = new Map([
      [sourceMemory.id, { id: randomUUID(), label: "AAPL", predicate: "source", value: "message" }],
      [proposalMemory.id, { id: randomUUID(), label: "Proposal", predicate: "proposal", value: "decision" }],
    ]);
    const graphRequest = (idempotencyKey: string, observedAt: string) => ({
      scope: "PRIVATE_ACCOUNT" as const, accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      idempotencyKey, reconcilerVersion: "temporal-memory-graph-v2", observedAt,
      entities: [sourceMemory, proposalMemory].map((memory) => {
        const entity = entityByMemory.get(memory.id)!;
        return { id: entity.id, type: "METHOD" as const, canonicalName: entity.label,
          validFrom: memory.validFrom, aliases: [{ alias: entity.label, validFrom: memory.validFrom,
            sourceIds: [...memory.sourceIds] }] };
      }),
      claims: [sourceMemory, proposalMemory].map((memory) => {
        const entity = entityByMemory.get(memory.id)!;
        return { memoryId: memory.id, entityId: entity.id, nodeType: "FACT" as const,
          predicate: entity.predicate, value: entity.value,
          approved: memory.id === sourceMemory.id, validFrom: memory.validFrom,
          sourceIds: [...memory.sourceIds] };
      }),
    });
    const pendingObservedAt = new Date(Math.max(...sourceEvents.map(({ occurred_at }) => (
      occurred_at.getTime()
    ))) + 120_000).toISOString();
    const pending = await versionMemoryGraph(createMemoryGraphWriterContext(db),
      graphRequest("memory-graph-raw:relation-proposal-pending", pendingObservedAt));
    const pendingProposalEdge = pending.edges.find(({ type }) => type === "PROPOSED_BY")!;
    expect(pendingProposalEdge).toEqual(expect.objectContaining({
      from: proposalMemory.id, type: "PROPOSED_BY", to: sourceMemory.id,
      validFrom: proposalMemory.validFrom, validTo: null,
    }));
    expect(pending.edges).toContainEqual(expect.objectContaining({
      from: proposalMemory.id, type: "AFFECTED", to: sourceMemory.id,
    }));
    expect(pending.edges).toContainEqual(expect.objectContaining({
      from: proposalMemory.id, type: "RESULTED_IN", to: sourceMemory.id,
    }));
    expect(pending.edges.some(({ type }) => type === "ACCEPTED_INTO")).toBe(false);
    expect(await db.one<{ source_ids: string[] }>(
      `select array_agg(source.source_event_id::text order by source.source_event_id) source_ids
       from memory_graph_edges edge join memory_graph_edge_sources source on source.edge_id=edge.id
       where edge.source_memory_id=$1 and edge.target_memory_id=$2 and edge.type='PROPOSED_BY'`,
      [proposalMemory.id, sourceMemory.id],
    )).toEqual({ source_ids: [source.eventId, route.routingEventId].sort() });
    const pendingBinding = await db.one<{
      event_id: string; relation_digest: string; derived_digest: string;
    }>(
      `select run.graph_event_id::text event_id,manifest.relation_digest,
              memory_graph_relation_digest(run.id) derived_digest
       from memory_graph_reconciliation_runs run
       join memory_graph_event_manifests manifest on manifest.reconciliation_run_id=run.id
       where run.id=$1`, [pending.reconciliationRunId],
    );
    expect(pendingBinding.relation_digest).toBe(pendingBinding.derived_digest);
    const pendingBody = await readEventBody(db, pendingBinding.event_id,
      { actor: { role: "SYSTEM" } }) as {
      counts: { relationships: number }; digests: { relationships: string };
    };
    expect(pendingBody.counts.relationships).toBe(pending.edges.length);
    expect(pendingBody.digests.relationships).toBe(pendingBinding.relation_digest);

    await transitionProposal({ db }, { proposalId: proposal.id,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" }, toStatus: "UNDER_REVIEW",
      reason: "Review started.", idempotencyKey: "graph-relation-proposal-under-review" });
    const evaluatorId = randomUUID();
    await db.query(
      `insert into model_runs (
         id,role,provider,model,prompt_version,policy_version,correlation_id,causation_id,
         input_tokens,output_tokens,max_input_tokens,max_output_tokens,completion_status,completed_at
       ) values ($1,'EVALUATOR','test-provider','test-evaluator','proposal-review-v1',$2,$3,$4,
         1,1,1024,256,'COMPLETED',clock_timestamp())`,
      [evaluatorId, "graph-relation-evaluator", randomUUID(), proposalRow.created_event_id],
    );
    await transitionProposal({ db }, { proposalId: proposal.id,
      actor: { type: "EVALUATOR", id: evaluatorId }, toStatus: "QUEUED_FOR_DECISION",
      reason: "Review complete.", idempotencyKey: "graph-relation-proposal-queued" });
    await transitionProposal({ db }, { proposalId: proposal.id,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" }, toStatus: "ACCEPTED",
      reason: "Accepted.", idempotencyKey: "graph-relation-proposal-accepted" });
    const acceptedAt = await db.one<{ at: Date }>(
      `select created_at at from proposal_status_transitions where proposal_id=$1
       order by ordinal desc limit 1`, [proposal.id],
    );
    const accepted = await versionMemoryGraph(createMemoryGraphWriterContext(db), graphRequest(
      "memory-graph-raw:relation-proposal-accepted",
      new Date(acceptedAt.at.getTime() + 60_000).toISOString(),
    ));
    expect(accepted.edges).toContainEqual(expect.objectContaining({
      from: proposalMemory.id, type: "ACCEPTED_INTO", to: sourceMemory.id,
    }));
    vi.unstubAllEnvs();
  }, 60_000);

  it("rejects orphan canonical graph/job events but permits event-first authoritative backfill", async () => {
    const { db } = await testContext();
    const canonical = [
      "memory.edge.versioned",
      "memory.graph.reconciliation.queued",
      "memory.graph.background.queued",
      "memory.graph.background.claimed",
      "memory.graph.background.retry_scheduled",
      "memory.graph.background.completed",
      "memory.graph.background.failed",
    ] as const;
    const outcomes = await Promise.allSettled(canonical.map((type) => appendEvent(db, {
      aggregateId: `memory-graph-orphan:${type}`,
      actor: { type: "SYSTEM", id: type === "memory.edge.versioned"
        ? "memory-graph-reconciler" : "memory-graph-worker" },
      type,
      visibility: "OPERATOR",
      body: { orphan: true, type },
      idempotencyKey: `memory-graph-orphan:${type}`,
      ...(type === "memory.edge.versioned" ? { policyVersion: "memory-graph-v1" } : {}),
    })));
    expect(outcomes).toHaveLength(canonical.length);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect(outcome.status === "rejected" ? String(outcome.reason) : "")
        .toContain("INCOMPLETE_MEMORY_GRAPH_EVENT");
    }

    const fixture = await seedPrivateGraphMemories(db, "event-side-backfill");
    const run = await versionMemoryGraph(createMemoryGraphWriterContext(db),
      graphInput(fixture, "event-side-backfill"));
    expect(await db.one<{ events: number; runs: number; manifests: number }>(
      `select
         (select count(*)::int from events where id=graph.graph_event_id) events,
         (select count(*)::int from memory_graph_reconciliation_runs
          where graph_event_id=graph.graph_event_id) runs,
         (select count(*)::int from memory_graph_event_manifests
          where graph_event_id=graph.graph_event_id) manifests
       from memory_graph_reconciliation_runs graph where graph.id=$1`,
      [run.reconciliationRunId],
    )).toEqual({ events: 1, runs: 1, manifests: 1 });
  }, 40_000);

  it("queues an encrypted resumable reconciliation before materializing over-budget topology", async () => {
    const { db } = await testContext();
    const base = await seedPrivateGraphMemories(db, "reconciliation-work-budget");
    const entityId = randomUUID();
    const priorBatch = await appendManyGraphMemories(
      base, "reconciliation-work-budget", "old", "2026-08-22T10:00:00.000Z",
    );
    await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      scope: "PRIVATE_ACCOUNT" as const, accountId: base.accountId,
      nodeBrainId: base.nodeBrainId, conversationId: base.conversationId,
      idempotencyKey: "memory-graph:reconciliation-work-budget:prior",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-22T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: "2026-08-22T10:00:00.000Z", aliases: [{ alias: "AAPL",
          validFrom: "2026-08-22T10:00:00.000Z", sourceIds: [priorBatch.source.id] }] }],
      claims: [{ memoryId: priorBatch.memories[0]!.id, entityId,
        nodeType: "BELIEF" as const, predicate: "shared-predicate", value: "shared-value",
        approved: true, validFrom: "2026-08-22T10:00:00.000Z",
        sourceIds: [priorBatch.source.id] }],
    });
    const requested = await appendManyGraphMemories(
      base, "reconciliation-work-budget", "new", "2026-08-23T10:00:00.000Z",
    );
    const counted = queryCountingDatabase(db);
    const oversizedRequest = {
      scope: "PRIVATE_ACCOUNT" as const, accountId: base.accountId,
      nodeBrainId: base.nodeBrainId, conversationId: base.conversationId,
      idempotencyKey: "memory-graph:reconciliation-work-budget:oversized",
      reconcilerVersion: "temporal-memory-graph-v2", observedAt: "2026-08-23T10:02:00.000Z",
      entities: [{ id: entityId, type: "INSTRUMENT" as const, canonicalName: "AAPL",
        validFrom: "2026-08-22T10:00:00.000Z", aliases: [{ alias: "AAPL",
          validFrom: "2026-08-23T10:00:00.000Z", sourceIds: [requested.source.id] }] }],
      claims: requested.memories.map((memory) => ({ memoryId: memory.id, entityId,
        nodeType: "BELIEF" as const, predicate: "shared-predicate", value: "shared-value",
        approved: true, validFrom: "2026-08-23T10:00:00.000Z",
        sourceIds: [requested.source.id] })),
    };
    const queued = await versionMemoryGraph(
      createMemoryGraphWriterContext(counted.db), oversizedRequest,
    ) as unknown as {
      status: string; reconciliationRunId: string | null; backgroundJobId: string | null;
      edges: readonly unknown[]; conflicts: readonly unknown[];
    };
    expect(queued).toMatchObject({ status: "QUEUED", reconciliationRunId: null,
      edges: [], conflicts: [] });
    expect(queued.backgroundJobId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(counted.queries()).toBeLessThanOrEqual(50);
    const stored = await db.one<{
      status: string; candidate_count: number; estimated_edge_count: number;
      estimated_edge_source_count: number; resume_cursor: Record<string, unknown>;
      request_event_id: string; ciphertext_bytes: number;
    }>(
      `select current.status,job.candidate_count,job.estimated_edge_count,
              job.estimated_edge_source_count,
              jsonb_build_object('edgeOffset',current.edge_offset,
                'edgeSourceOffset',current.edge_source_offset) resume_cursor,
              job.request_event_id::text,octet_length(body.ciphertext)::int ciphertext_bytes
       from memory_graph_reconciliation_jobs job
       join memory_graph_reconciliation_job_current current on current.job_id=job.id
       join encrypted_event_bodies body on body.event_id=job.request_event_id
       where job.id=$1`, [queued.backgroundJobId],
    );
    expect(stored).toMatchObject({ status: "PENDING", candidate_count: 101,
      estimated_edge_count: 10_100, estimated_edge_source_count: 10_300,
      resume_cursor: { edgeOffset: 0, edgeSourceOffset: 0 } });
    expect(stored.ciphertext_bytes).toBeLessThanOrEqual(131_072);

    const jobId = queued.backgroundJobId!;
    const alternate = await versionMemoryGraph(createMemoryGraphWriterContext(db), {
      ...oversizedRequest,
      idempotencyKey: "memory-graph:reconciliation-work-budget:alternate-key",
    });
    expect(alternate.backgroundJobId).toBe(jobId);
    expect(await db.one<{
      aliases: number; candidates: number; sources: number; source_sets: number;
      keys: number; body_exact: boolean;
    }>(
      `select
         (select count(*)::int from memory_graph_reconciliation_job_aliases
          where job_id=job.id) aliases,
         (select count(*)::int from memory_graph_reconciliation_job_candidates
          where job_id=job.id) candidates,
         (select count(*)::int from memory_graph_reconciliation_job_sources
          where job_id=job.id) sources,
         (select count(*)::int from memory_graph_reconciliation_job_source_sets
          where job_id=job.id) source_sets,
         (select count(*)::int from memory_graph_reconciliation_job_idempotency_keys
          where job_id=job.id) keys,
         body.body_digest=memory_graph_expected_reconciliation_job_body_digest(job.id) body_exact
       from memory_graph_reconciliation_jobs job
       join encrypted_event_bodies body on body.event_id=job.request_event_id where job.id=$1`,
      [jobId],
    )).toEqual({ aliases: 1, candidates: 101, sources: 2, source_sets: 2,
      keys: 2, body_exact: true });
    const queuedBody = await readEventBody(db, stored.request_event_id,
      { actor: { role: "SYSTEM" } });
    expect(JSON.stringify(queuedBody)).not.toMatch(/AAPL|shared-predicate|shared-value/iu);

    const foreign = await seedPrivateGraphMemories(db, "reconciliation-post-seal-foreign");
    const sealedInsertAttempts = [
      {
        name: "source",
        sql: `insert into memory_graph_reconciliation_job_sources(job_id,ordinal,source_event_id)
              values ($1,2,$2)`,
        parameters: [jobId, base.oldSource.id],
      },
      {
        name: "entity",
        sql: `insert into memory_graph_reconciliation_job_entities (
                job_id,ordinal,entity_id,type,canonical_digest,public_label,valid_from,valid_to
              ) select job_id,1,$2,'INSTRUMENT',$3,null,valid_from,valid_to
                from memory_graph_reconciliation_job_entities where job_id=$1 limit 1`,
        parameters: [jobId, randomUUID(), digest("post-seal-entity")],
      },
      {
        name: "alias",
        sql: `insert into memory_graph_reconciliation_job_aliases (
                job_id,ordinal,entity_id,alias_digest,public_alias,valid_from,valid_to,
                source_set_ordinal,source_count
              ) select job_id,1,entity_id,$2,null,valid_from,valid_to,
                       source_set_ordinal,source_count
                from memory_graph_reconciliation_job_aliases where job_id=$1 limit 1`,
        parameters: [jobId, digest("post-seal-alias")],
      },
      {
        name: "source-set",
        sql: `insert into memory_graph_reconciliation_job_source_sets (
                job_id,ordinal,source_ordinals,source_count,source_digest
              ) values ($1,2,array[0,1],2,$2)`,
        parameters: [jobId, digest("post-seal-source-set")],
      },
      {
        name: "cross-scope-candidate",
        sql: `insert into memory_graph_reconciliation_job_candidates (
                job_id,ordinal,memory_id,entity_id,node_type,predicate_digest,value_digest,
                public_predicate,public_value,approved,valid_from,valid_to,
                source_set_ordinal,source_count
              ) select $1,101,$2,entity.entity_id,'FACT',$3,$4,null,null,false,
                       memory.valid_from,memory.valid_to,0,1
                from memory_records memory
                cross join lateral (select entity_id
                  from memory_graph_reconciliation_job_entities where job_id=$1 limit 1) entity
                where memory.id=$2`,
        parameters: [jobId, foreign.memories[0]!.id,
          digest("post-seal-predicate"), digest("post-seal-value")],
      },
      {
        name: "member",
        sql: `insert into memory_graph_reconciliation_job_idempotency_keys (
                idempotency_key,job_id,operation_key,request_digest,request_shape_digest,created_at
              ) select 'post-seal-forged-member',id,operation_key,$2,$3,clock_timestamp()
                from memory_graph_reconciliation_jobs where id=$1`,
        parameters: [jobId, digest("post-seal-request"), digest("post-seal-shape")],
      },
    ];
    const sealedMessages: string[] = [];
    for (const attempt of sealedInsertAttempts) {
      try {
        await db.transaction(async (transaction) => {
          await transaction.query(attempt.sql, attempt.parameters);
          throw new Error(`POST_SEAL_INSERT_ACCEPTED:${attempt.name}`);
        });
      } catch (error) {
        sealedMessages.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(sealedMessages.slice(0, 5)).toEqual(Array(5)
      .fill("MEMORY_GRAPH_RECONCILIATION_JOB_SEALED"));
    expect(sealedMessages[5]).toBe("MEMORY_GRAPH_RECONCILIATION_MEMBER_INVALID");

    const graphModule = await import("../../lib/server/consolidation/graph");
    await expect(db.transaction(async (transaction) => {
      await transaction.query("set local session_replication_role='replica'");
      await transaction.query(
        `insert into memory_graph_reconciliation_job_sources(job_id,ordinal,source_event_id)
         values ($1,2,$2)`, [jobId, base.oldSource.id],
      );
      await transaction.query("set local session_replication_role='origin'");
      const tamperedWorker = await graphModule.authorizeMemoryGraphJobWorker(transaction, {
        actorId: "memory-graph-worker", purpose: "RECONCILIATION",
      });
      await graphModule.claimMemoryGraphReconciliationJob(tamperedWorker, {
        jobId, workerId: "tamper-probe", at: "1900-01-01T00:00:00.000Z",
        leaseUntil: await databaseFuture(transaction, 60_000),
        idempotencyKey: "memory-graph:reconciliation:tampered-claim",
      });
      throw new Error("TAMPERED_RECONCILIATION_CLAIM_ACCEPTED");
    })).rejects.toThrow("MEMORY_GRAPH_RECONCILIATION_EVENT_BODY_INVALID");

    const worker = await graphModule.authorizeMemoryGraphJobWorker(db, {
      actorId: "memory-graph-worker", purpose: "RECONCILIATION",
    });
    const claimInput = { jobId, workerId: "reconciliation-worker",
      at: "1900-01-01T00:00:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "memory-graph:reconciliation:claim" };
    const claims = await Promise.all([
      graphModule.claimMemoryGraphReconciliationJob(worker, claimInput),
      graphModule.claimMemoryGraphReconciliationJob(worker, claimInput),
    ]);
    expect(claims[0]).toEqual(claims[1]);
    expect(await graphModule.progressMemoryGraphReconciliationJob(worker, {
      jobId, workerId: "reconciliation-worker", at: "2099-01-01T00:00:00.000Z",
      edgeOffset: 5_050, edgeSourceOffset: 5_150,
      idempotencyKey: "memory-graph:reconciliation:progress-half",
    })).toMatchObject({ status: "CLAIMED",
      cursor: { edgeOffset: 5_050, edgeSourceOffset: 5_150 } });
    const retryAt = await databaseFuture(db, 500);
    expect(await graphModule.failMemoryGraphReconciliationJob(worker, {
      jobId, workerId: "reconciliation-worker", at: "2099-01-01T00:00:00.000Z",
      errorCode: "TRANSIENT", retryAt,
      idempotencyKey: "memory-graph:reconciliation:retry",
    })).toMatchObject({ status: "RETRY_SCHEDULED" });
    await expect(graphModule.claimMemoryGraphReconciliationJob(worker, {
      ...claimInput, leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "memory-graph:reconciliation:early-reclaim",
    })).rejects.toThrow("MEMORY_GRAPH_RECONCILIATION_JOB_NOT_CLAIMABLE");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await graphModule.claimMemoryGraphReconciliationJob(worker, {
      ...claimInput, leaseUntil: await databaseFuture(db, 60_000),
      idempotencyKey: "memory-graph:reconciliation:reclaim",
    });
    await graphModule.progressMemoryGraphReconciliationJob(worker, {
      jobId, workerId: "reconciliation-worker", at: "1900-01-01T00:00:00.000Z",
      edgeOffset: stored.estimated_edge_count,
      edgeSourceOffset: stored.estimated_edge_source_count,
      idempotencyKey: "memory-graph:reconciliation:progress-final",
    });
    const completion = { jobId, workerId: "reconciliation-worker",
      at: "1900-01-01T00:00:00.000Z",
      idempotencyKey: "memory-graph:reconciliation:complete" };
    const completed = await Promise.all([
      graphModule.completeMemoryGraphReconciliationJob(worker, completion),
      graphModule.completeMemoryGraphReconciliationJob(worker, completion),
    ]);
    expect(completed[0]).toEqual(completed[1]);
    expect(completed[0]).toMatchObject({ status: "COMPLETED",
      cursor: { edgeOffset: 10_100, edgeSourceOffset: 10_300 } });
    expect(await db.one<{ status: string; transitions: number; exact: boolean }>(
      `select current.status,
         (select count(*)::int from memory_graph_reconciliation_job_transitions
          where job_id=current.job_id) transitions,
         not exists (select 1 from memory_graph_reconciliation_job_transitions transition
           join memory_graph_reconciliation_job_transition_manifests manifest
             on manifest.transition_id=transition.id
           join encrypted_event_bodies body on body.event_id=transition.transition_event_id
           where transition.job_id=current.job_id and body.body_digest<>
             memory_graph_expected_reconciliation_job_transition_body_digest(transition.id)) exact
       from memory_graph_reconciliation_job_current current where current.job_id=$1`, [jobId],
    )).toEqual({ status: "COMPLETED", transitions: 7, exact: true });

    await expect(db.transaction(async (transaction) => {
      const forgedJobId = randomUUID();
      const forgedOperation = canonicalContentDigest({ forgedJobId });
      const forgedKey = "memory-graph:reconciliation:actual-digest-forgery";
      const original = await transaction.one<{ created_at: Date }>(
        "select created_at from memory_graph_reconciliation_jobs where id=$1", [jobId],
      );
      const forgedEvent = await appendEvent(transaction, {
        aggregateId: base.conversationId, accountId: base.accountId,
        actor: { type: "SYSTEM", id: "memory-graph-reconciler" },
        type: "memory.graph.reconciliation.queued", visibility: "PRIVATE_ACCOUNT",
        body: { arbitrary: "attacker-selected-body-with-actual-digest" },
        idempotencyKey: `memory-graph-reconciliation-job:${forgedOperation}`,
        occurredAt: original.created_at, policyVersion: "memory-graph-v1",
      });
      await transaction.query(
        `insert into memory_graph_reconciliation_jobs (
           id,operation_key,idempotency_key,request_digest,request_shape_digest,
           reconciler_version,scope,account_id,node_brain_id,conversation_id,
           candidate_memory_ids,source_event_ids,candidate_count,estimated_edge_count,
           estimated_edge_source_count,estimated_materialization_rows,request_event_id,created_at
         ) select $1,$2,$3,$2,request_shape_digest,reconciler_version,scope,account_id,
                  node_brain_id,conversation_id,candidate_memory_ids,source_event_ids,
                  candidate_count,estimated_edge_count,estimated_edge_source_count,
                  estimated_materialization_rows,$4,created_at
           from memory_graph_reconciliation_jobs where id=$5`,
        [forgedJobId, forgedOperation, forgedKey, forgedEvent.id, jobId],
      );
      await transaction.query(
        `insert into memory_graph_reconciliation_job_idempotency_keys
         select $1,$2,$3,$3,request_shape_digest,created_at
         from memory_graph_reconciliation_job_idempotency_keys where job_id=$4 limit 1`,
        [forgedKey, forgedJobId, forgedOperation, jobId],
      );
      for (const [table, columns] of [
        ["memory_graph_reconciliation_job_sources",
          "ordinal,source_event_id"],
        ["memory_graph_reconciliation_job_source_sets",
          "ordinal,source_ordinals,source_count,source_digest"],
        ["memory_graph_reconciliation_job_entities",
          "ordinal,entity_id,type,canonical_digest,public_label,valid_from,valid_to"],
        ["memory_graph_reconciliation_job_aliases",
          "ordinal,entity_id,alias_digest,public_alias,valid_from,valid_to,source_set_ordinal,source_count"],
        ["memory_graph_reconciliation_job_candidates",
          "ordinal,memory_id,entity_id,node_type,predicate_digest,value_digest,public_predicate,public_value,approved,valid_from,valid_to,source_set_ordinal,source_count"],
      ] as const) {
        await transaction.query(
          `insert into ${table}(job_id,${columns})
           select $1,${columns} from ${table} where job_id=$2`, [forgedJobId, jobId],
        );
      }
      await transaction.query(
        `insert into memory_graph_reconciliation_job_transitions (
           id,job_id,ordinal,action,from_status,to_status,worker_id,lease_until,retry_at,error_code,
           edge_offset,edge_source_offset,transition_event_id,idempotency_key,operation_digest,created_at
         ) values ($1,$2,0,'QUEUE',null,'PENDING',null,null,null,null,0,0,$3,$4,$5,$6)`,
        [randomUUID(), forgedJobId, forgedEvent.id, forgedKey, forgedOperation,
          original.created_at],
      );
    })).rejects.toThrow("MEMORY_GRAPH_RECONCILIATION_MEMBER_INVALID");
  }, 180_000);

  it("queues and claims PUBLIC and shared oversized graphs with scope-exact envelopes", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    const { db } = await testContext();
    const worker = await graphModule.authorizeMemoryGraphJobWorker(db, {
      actorId: "memory-graph-worker", purpose: "RECONCILIATION",
    });
    for (const [scope, visibility] of [
      ["PUBLIC", "PUBLIC"], ["MAIN_SHARED", "SHARED"], ["CHALLENGE_SHARED", "SHARED"],
    ] as const) {
      const queued = await queueAccountNullGraph(db, scope);
      expect(queued).toMatchObject({ status: "QUEUED", reconciliationRunId: null });
      const jobId = queued.backgroundJobId!;
      expect(await db.one<{ scope: string; queue_visibility: string }>(
        `select job.scope,event.visibility queue_visibility
         from memory_graph_reconciliation_jobs job
         join events event on event.id=job.request_event_id where job.id=$1`, [jobId],
      )).toEqual({ scope, queue_visibility: visibility });
      expect(await graphModule.claimMemoryGraphReconciliationJob(worker, {
        jobId, workerId: `account-null-${scope.toLowerCase()}`,
        at: "1900-01-01T00:00:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
        idempotencyKey: `memory-graph-account-null:${scope.toLowerCase()}:claim`,
      })).toMatchObject({ status: "CLAIMED" });
      expect(await db.one<{ visibility: string }>(
        `select event.visibility from memory_graph_reconciliation_job_transitions transition
         join events event on event.id=transition.transition_event_id
         where transition.job_id=$1 and transition.ordinal=1`, [jobId],
      )).toEqual({ visibility });
    }
  }, 120_000);

  it("uses database time and lease ownership for all job transitions despite forged caller time", async () => {
    const graphModule = await import("../../lib/server/consolidation/graph");
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "job-database-clock");
    await versionMemoryGraph(createMemoryGraphWriterContext(db),
      graphInput(fixture, "job-database-clock"));
    const traversal = await authorizeMemoryGraphTraversal(db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const queue = async (label: string, seedMemoryId: string) => traverseMemoryGraph(traversal, {
      seedMemoryIds: [seedMemoryId], requestedDepth: 8, candidateLimit: 1,
      asOf: "2026-08-10T00:00:00.000Z", idempotencyKey: `job-database-clock:${label}`,
    });
    const worker = await graphModule.authorizeMemoryGraphJobWorker(db, {
      actorId: "memory-graph-worker", purpose: "DEEP_RESEARCH",
    });
    const now = (await db.one<{ now: Date }>("select clock_timestamp() now")).now;
    const first = await queue("retry", fixture.memories[0]!.id);
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: first.backgroundJobId, workerId: "clock-worker",
      at: "2099-01-01T00:00:00.000Z",
      leaseUntil: new Date(now.getTime() + 60_000).toISOString(),
      idempotencyKey: "job-database-clock:claim",
    });
    const claimedAt = await db.one<{ created_at: Date }>(
      `select created_at from memory_graph_background_job_transitions
       where job_id=$1 and to_status='CLAIMED'`, [first.backgroundJobId],
    );
    expect(Math.abs(claimedAt.created_at.getTime() - Date.now())).toBeLessThan(5_000);
    await expect(graphModule.completeMemoryGraphBackgroundJob(worker, {
      jobId: first.backgroundJobId, workerId: "wrong-worker",
      resultMemoryIds: [fixture.memories[0]!.id], at: "1900-01-01T00:00:00.000Z",
      idempotencyKey: "job-database-clock:wrong-worker",
    })).rejects.toThrow("MEMORY_GRAPH_JOB_NOT_OWNED");

    await expect(db.transaction(async (transaction) => {
      const createdAt = "2099-01-01T00:00:00.000Z";
      const operationDigest = canonicalContentDigest({ action: "COMPLETE",
        jobId: first.backgroundJobId, workerId: "clock-worker",
        resultMemoryIds: [fixture.memories[0]!.id] });
      const idempotencyKey = "job-database-clock:sql-time-forgery";
      const event = await appendEvent(transaction, {
        aggregateId: `memory-graph-job:${first.backgroundJobId}`,
        accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "memory-graph-worker" },
        type: "memory.graph.background.completed", visibility: "PRIVATE_ACCOUNT",
        body: { jobId: first.backgroundJobId, fromStatus: "CLAIMED", toStatus: "COMPLETED",
          workerId: "clock-worker", resultMemoryIds: [fixture.memories[0]!.id] },
        occurredAt: new Date(createdAt),
        idempotencyKey: `memory-graph-job-event:${idempotencyKey}:${operationDigest}`,
      });
      const transitionId = randomUUID();
      await transaction.query(
        `insert into memory_graph_background_job_transitions (
           id,job_id,ordinal,from_status,to_status,worker_id,result_memory_ids,
           transition_event_id,idempotency_key,operation_digest,created_at
         ) select $1,$2,max(ordinal)+1,'CLAIMED','COMPLETED','clock-worker',$3::uuid[],
                  $4,$5,$6,$7
           from memory_graph_background_job_transitions where job_id=$2`,
        [transitionId, first.backgroundJobId, [fixture.memories[0]!.id], event.id,
          idempotencyKey, operationDigest, createdAt],
      );
      const header = await transaction.one<{
        request_hash: string; integrity_hash: string; body_digest: string;
      }>(
        `select event.request_hash,event.integrity_hash,body.body_digest
         from events event join encrypted_event_bodies body on body.event_id=event.id
         where event.id=$1`, [event.id],
      );
      await transaction.query(
        `insert into memory_graph_job_transition_manifests (
           transition_id,job_id,transition_event_id,operation_digest,body_digest,
           event_request_hash,event_integrity_hash,created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [transitionId, first.backgroundJobId, event.id, operationDigest, header.body_digest,
          header.request_hash, header.integrity_hash, createdAt],
      );
      throw new Error("ROLLBACK_TIMESTAMP_FORGERY_ACCEPTED");
    })).rejects.toThrow("MEMORY_GRAPH_JOB_CLOCK_INVALID");

    const retryAt = new Date(now.getTime() + 120_000).toISOString();
    await graphModule.failMemoryGraphBackgroundJob(worker, {
      jobId: first.backgroundJobId, workerId: "clock-worker", errorCode: "RETRY_LATER",
      retryAt, at: "1900-01-01T00:00:00.000Z",
      idempotencyKey: "job-database-clock:retry-transition",
    });
    await expect(graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: first.backgroundJobId, workerId: "clock-worker",
      at: "2099-01-01T00:00:00.000Z",
      leaseUntil: new Date(now.getTime() + 180_000).toISOString(),
      idempotencyKey: "job-database-clock:early-reclaim",
    })).rejects.toThrow("MEMORY_GRAPH_JOB_NOT_CLAIMABLE");

    const second = await queue("expiry", fixture.memories[1]!.id);
    const secondNow = (await db.one<{ now: Date }>("select clock_timestamp() now")).now;
    await graphModule.claimMemoryGraphBackgroundJob(worker, {
      jobId: second.backgroundJobId, workerId: "clock-worker",
      at: "1900-01-01T00:00:00.000Z",
      leaseUntil: new Date(secondNow.getTime() + 250).toISOString(),
      idempotencyKey: "job-database-clock:short-claim",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(graphModule.completeMemoryGraphBackgroundJob(worker, {
      jobId: second.backgroundJobId, workerId: "clock-worker",
      resultMemoryIds: [fixture.memories[1]!.id], at: "1900-01-01T00:00:00.000Z",
      idempotencyKey: "job-database-clock:expired-complete",
    })).rejects.toThrow("MEMORY_GRAPH_JOB_NOT_OWNED");

    const takeoverDb = transactionPidDatabase(db);
    const takeoverWorker = await graphModule.authorizeMemoryGraphJobWorker(takeoverDb.db, {
      actorId: "memory-graph-worker", purpose: "DEEP_RESEARCH",
    });
    takeoverDb.clear();
    await db.transaction(async (crashedWorkerConnection) => {
      const crashedPid = (await crashedWorkerConnection.one<{ pid: number }>(
        "select pg_backend_pid() pid",
      )).pid;
      expect(await graphModule.claimMemoryGraphBackgroundJob(takeoverWorker, {
        jobId: second.backgroundJobId, workerId: "crash-recovery-worker",
        at: "2099-01-01T00:00:00.000Z", leaseUntil: await databaseFuture(db, 60_000),
        idempotencyKey: "job-database-clock:expired-takeover",
      })).toEqual({ jobId: second.backgroundJobId, status: "CLAIMED" });
      expect(takeoverDb.pids).toHaveLength(1);
      expect(takeoverDb.pids[0]).not.toBe(crashedPid);
    });

    const third = await queue("lease-expires-inside-transaction", fixture.memories[1]!.id);
    const gate = transactionGate(db,
      "select clock_timestamp() now,date_trunc('milliseconds',transaction_timestamp()) transition_at");
    const gatedWorker = await graphModule.authorizeMemoryGraphJobWorker(gate.observed, {
      actorId: "memory-graph-worker", purpose: "DEEP_RESEARCH",
    });
    const nearNow = (await db.one<{ now: Date }>("select clock_timestamp() now")).now;
    const shortClaim = graphModule.claimMemoryGraphBackgroundJob(gatedWorker, {
      jobId: third.backgroundJobId, workerId: "short-lease-worker",
      at: "1900-01-01T00:00:00.000Z",
      leaseUntil: new Date(nearNow.getTime() + 300).toISOString(),
      idempotencyKey: "job-database-clock:already-expired-at-insert",
    });
    await gate.reached;
    await new Promise((resolve) => setTimeout(resolve, 500));
    gate.release();
    await expect(shortClaim).rejects.toThrow("MEMORY_GRAPH_JOB_TRANSITION_INVALID");
  }, 60_000);

  it("uses endpoint-leading indexes and UNION ALL traversal for shared-scope actors", async () => {
    const { db } = await testContext();
    const fixture = await seedPrivateGraphMemories(db, "endpoint-leading");
    await versionMemoryGraph(createMemoryGraphWriterContext(db), graphInput(fixture, "endpoint-leading"));
    const definitions = (await db.query<{ indexname: string; indexdef: string }>(
      `select indexname,indexdef from pg_indexes where schemaname=current_schema()
       and tablename='memory_graph_edges' order by indexname`,
    )).map(({ indexname, indexdef }) => `${indexname}:${indexdef}`).join("\n");
    expect(definitions).toMatch(/memory_graph_edges_source_leading_idx.*\(source_memory_id, scope, valid_from/iu);
    expect(definitions).toMatch(/memory_graph_edges_target_leading_idx.*\(target_memory_id, scope, valid_from/iu);
    const plan = await db.transaction(async (transaction) => {
      await transaction.query("set local enable_seqscan=off");
      return transaction.query<{ "QUERY PLAN": string }>(
        `explain select source_memory_id,target_memory_id from (
           select source_memory_id,target_memory_id,valid_from,id from memory_graph_edges
           where source_memory_id=any($1::uuid[]) and scope=any($2::text[])
             and valid_from<=$3 and (valid_to is null or valid_to>$3)
           union all
           select source_memory_id,target_memory_id,valid_from,id from memory_graph_edges
           where target_memory_id=any($1::uuid[]) and scope=any($2::text[])
             and valid_from<=$3 and (valid_to is null or valid_to>$3)
         ) adjacency order by valid_from desc,id limit 100`,
        [[fixture.memories[0]!.id], ["MAIN_SHARED", "CHALLENGE_SHARED", "PUBLIC"],
          "2026-08-10T00:00:00.000Z"],
      );
    });
    const textPlan = plan.map((row) => row["QUERY PLAN"]).join(" ");
    expect(textPlan).toContain("memory_graph_edges_source_leading_idx");
    expect(textPlan).toContain("memory_graph_edges_target_leading_idx");
    expect(await readFile("lib/server/consolidation/graph.ts", "utf8"))
      .toMatch(/from memory_graph_edges edge[\s\S]+union all[\s\S]+from memory_graph_edges edge/iu);
  }, 30_000);
});
