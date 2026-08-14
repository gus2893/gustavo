import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { appendChallengeLedgerEvent, loadChallengeLedgerEvents, replaceProjectionCheckpoint } from "../../lib/server/challenge/ledger";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";
import { replayStoredLedgerEvents } from "../../lib/server/challenge/projection";
import { appendMessage } from "../../lib/server/history/messages";
import { appendEvents } from "../../lib/server/events/store";
import type { EventDatabase } from "../../lib/server/events/types";
import { commitBroadcast } from "../../lib/server/main-brain/broadcasts";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import { NODE_ROUTING_POLICY_VERSION } from "../../lib/server/node-brains/router";
import { HANDOFF_POLICY_VERSION } from "../../lib/server/handoffs/build";
import { refreshHandoff } from "../../worker/handoffs/refresh";
import {
  createDisclosureAuthorization,
  createProposal,
  revokeDisclosureAuthorization,
} from "../../lib/server/orchestration/proposals";
import {
  createMemoryWorkerContext,
  processMemoryEvent,
} from "../../worker/consolidation/process-event";
import {
  MemoryCacheBackend,
  cacheKey,
  cachePointerKey,
  projectionCategoryManifests,
  projectionManifestHash,
  projectionValueHash,
  rebuildCriticalProjections,
  scopedCache,
  type CriticalProjectionManifest,
  type CriticalProjectionRecord,
  type CriticalProjectionSource,
} from "../../lib/server/cache/store";
import {
  CACHE_REQUIRED_CATEGORIES,
  createPostgresCacheJobRepository,
  createPostgresProjectionSource,
  recordPostgresCacheMetric,
  readPostgresCacheMetrics,
  synchronizeCanonicalCacheJobs,
} from "../../lib/server/cache/postgres";
import {
  prewarmPostgresCache,
  rebuildPostgresCache,
  runPostgresCacheWorkerOnce,
} from "../../lib/server/cache/runtime";
import { processNextCacheJob } from "../../worker/cache/invalidate";
import { createConversationFixture, openTestDb, type TestDatabase } from "../helpers/postgres";
import {
  deadlineBoundDatabase,
  recordMaintenanceDelivery,
  runBoundedMaintenance,
  settleStaleBridgeLeases,
  withMaintenanceLock,
} from "../../app/api/internal/maintenance/route";
import { claimNextBridgeJob } from "../../lib/server/bridge/jobs";
import { databaseFromPool } from "../../lib/server/db/postgres";

const CACHE_KEY = Buffer.alloc(32, 19);
const MAIN_STATE_VERSION = 8_240_001;

let db: TestDatabase;
let nodeBrainId: string;
let accountId: string;
let staleRoutingEventId: string;
let primaryEventRootKey: string;

const MEMORY_VERSIONS = Object.freeze({
  promptVersion: "cache-memory-prompt-v1",
  modelVersion: "cache-memory-model-v1",
  extractorVersion: "cache-memory-extractor-v1",
  embeddingVersion: "cache-memory-embedding-v1",
});

function observeSql(database: EventDatabase, statements: string[]): EventDatabase {
  return {
    query(sql, parameters) {
      statements.push(sql);
      return database.query(sql, parameters);
    },
    one(sql, parameters) {
      statements.push(sql);
      return database.one(sql, parameters);
    },
    transaction(work) {
      return database.transaction((transaction) => work(observeSql(transaction, statements)));
    },
  };
}

async function insertUnrelatedOutboxRows(
  database: EventDatabase,
  count: number,
  prefix: string,
): Promise<readonly string[]> {
  const eventIds = Array.from({ length: count }, () => randomUUID());
  const outboxIds = Array.from({ length: count }, () => randomUUID());
  await database.transaction(async (transaction) => {
    await transaction.query(
      `insert into events (
         id,aggregate_id,actor_type,actor_id,type,visibility,occurred_at,
         correlation_id,policy_version,idempotency_key,request_hash,integrity_hash
       )
       select source.id,concat($2::text,':',source.ordinality),'SYSTEM','cache-noise',
              'cache.test.unrelated','SHARED',clock_timestamp(),source.id,
              'cache-test-v1',concat($2::text,':',source.ordinality),repeat('0',64),repeat('1',64)
       from unnest($1::uuid[]) with ordinality source(id,ordinality)`,
      [eventIds, prefix],
    );
    await transaction.query(
      `insert into transactional_outbox(id,event_id,topic,payload)
       select source.outbox_id,source.event_id,'cache.test.unrelated',
              jsonb_build_object('eventId',source.event_id::text)
       from unnest($1::uuid[],$2::uuid[]) source(outbox_id,event_id)`,
      [outboxIds, eventIds],
    );
  });
  return Object.freeze(eventIds);
}

function snapshotProjectionSource(
  manifest: CriticalProjectionManifest,
  records: readonly CriticalProjectionRecord[],
): CriticalProjectionSource {
  const sorted = [...records].sort((left, right) => left.id.localeCompare(right.id));
  return {
    name: "POSTGRES",
    async readManifest(checkpoint) {
      return Object.freeze({ ...manifest, checkpoint });
    },
    async readPage({ afterId, limit }) {
      const remaining = sorted.filter((item) => afterId === null || item.id > afterId);
      const page = remaining.slice(0, limit);
      return Object.freeze({
        records: page,
        nextCursor: remaining.length > limit ? page.at(-1)!.id : null,
      });
    },
  };
}

function cacheFixtureUuid(prefix: string, index: number): string {
  return `${prefix.padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function seedMoreThanOnePageOfNodeAndHandoffSources() {
  const count = 101;
  const latestMain = await db.one<{ readonly version: string }>(
    "select version::text from main_state_versions order by version desc limit 1",
  );
  const accountIds = Array.from({ length: count }, (_, index) => cacheFixtureUuid("a1", index + 1));
  const entitlementIds = Array.from({ length: count }, (_, index) => cacheFixtureUuid("e1", index + 1));
  const nodeBrainIds = Array.from({ length: count }, (_, index) => cacheFixtureUuid("b1", index + 1));
  const conversationIds = Array.from({ length: count }, (_, index) => cacheFixtureUuid("c1", index + 1));
  await db.transaction(async (transaction) => {
    await transaction.query(
      `insert into accounts (id,display_name,created_at)
       select id::uuid,'Cache exact ' || ordinal,clock_timestamp()-interval '2 hours'
       from unnest($1::text[]) with ordinality source(id,ordinal)`,
      [accountIds],
    );
    await transaction.query(
      `insert into entitlements (id,account_id,active_from,created_at)
       select entitlement_id::uuid,account_id::uuid,clock_timestamp()-interval '1 hour',
              clock_timestamp()-interval '1 hour'
       from unnest($1::text[],$2::text[]) source(entitlement_id,account_id)`,
      [entitlementIds, accountIds],
    );
    await transaction.query(
      `insert into node_brains (id,account_id,name,created_at)
       select node_brain_id::uuid,account_id::uuid,'Cache exact Node',
              clock_timestamp()-interval '1 hour'
       from unnest($1::text[],$2::text[]) source(node_brain_id,account_id)`,
      [nodeBrainIds, accountIds],
    );
    await transaction.query(
      `insert into conversations (id,account_id,node_brain_id,created_at)
       select conversation_id::uuid,account_id::uuid,node_brain_id::uuid,
              clock_timestamp()-interval '1 hour'
       from unnest($1::text[],$2::text[],$3::text[])
         source(conversation_id,account_id,node_brain_id)`,
      [conversationIds, accountIds, nodeBrainIds],
    );
  });
  const routeInputs = conversationIds.map((conversationId, index) => ({
    aggregateId: conversationId,
    accountId: accountIds[index],
    actor: { type: "NODE_BRAIN" as const, id: nodeBrainIds[index]! },
    type: "node.reply.routed",
    visibility: "PRIVATE_ACCOUNT" as const,
    body: {
      classificationConfidence: 0.91,
      mainStateVersion: latestMain.version,
      mode: "MAIN_DEFAULT",
      policyVersion: NODE_ROUTING_POLICY_VERSION,
      reason: "MAIN_COVERED",
      response: { authority: "MAIN", canonical: true, label: "MAIN POSITION" },
      sourceIds: [randomUUID()],
    },
    idempotencyKey: `cache-exact-route:${index}`,
    policyVersion: NODE_ROUTING_POLICY_VERSION,
  }));
  const routes = [
    ...await appendEvents(db, routeInputs.slice(0, 100)),
    ...await appendEvents(db, routeInputs.slice(100)),
  ];
  const sequences = await db.query<{
    readonly id: string;
    readonly ingested_sequence: string;
  }>(
    "select id::text,ingested_sequence::text from events where id=any($1::uuid[])",
    [routes.map(({ id }) => id)],
  );
  const sequenceById = new Map(sequences.map((row) => [row.id, row.ingested_sequence]));
  const checkpoints: { readonly eventId: string; readonly index: number }[] = [];
  for (let offset = 0; offset < routes.length; offset += 10) {
    const results = await Promise.all(routes.slice(offset, offset + 10).map(async (route, localIndex) => {
      const index = offset + localIndex;
      const refreshed = await refreshHandoff({ db }, {
        accountId: accountIds[index]!,
        nodeBrainId: nodeBrainIds[index]!,
        conversationId: conversationIds[index]!,
        scope: "NODE_BRANCH",
        policyVersion: HANDOFF_POLICY_VERSION,
        nodeStateVersion: sequenceById.get(route.id)!,
        mainStateVersion: latestMain.version,
        throughEventId: route.id,
        idempotencyKey: `cache-exact-handoff:${index}`,
      });
      if (refreshed.status !== "EMPTY") throw new Error("CACHE_EXACT_FIXTURE_NOT_EMPTY");
      const checkpoint = await db.one<{ readonly event_id: string }>(
        "select checkpoint_event_id::text event_id from handoff_refresh_checkpoints where id=$1",
        [refreshed.checkpointId],
      );
      return Object.freeze({ eventId: checkpoint.event_id, index });
    }));
    checkpoints.push(...results);
  }
  return Object.freeze({
    accountIds,
    nodeBrainIds,
    conversationIds,
    routes,
    checkpoints,
    targetIndex: count - 1,
  });
}

async function createProtectedCacheProjectionFixture() {
  const fixtureKey = randomUUID();
  const fixture = await createConversationFixture(`Cache protected projections ${fixtureKey}`, db);
  const sourceText = "Private cache source: the completed close rejected resistance.";
  const source = await appendMessage(fixture, {
    role: "USER",
    text: sourceText,
    idempotencyKey: `cache-protected-source:${fixtureKey}`,
  });
  const memories = await processMemoryEvent(createMemoryWorkerContext(db), {
    scope: "NODE_BRANCH",
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventId: source.eventId,
    events: [{ id: source.eventId, at: source.occurredAt, text: sourceText }],
    extracted: { facts: [{
      text: "Completed close rejected resistance",
      sourceIds: [source.eventId],
      keywords: ["rejection"],
      entities: ["AAPL"],
    }] },
    versions: MEMORY_VERSIONS,
    observedAt: new Date().toISOString(),
    idempotencyKey: `cache-protected-memory:${fixtureKey}`,
  });
  const mainStateVersion = Number((await db.one<{ readonly version: string }>(
    "select coalesce(max(version),8240098)::text version from main_state_versions",
  )).version) + 1;
  await commitBroadcast({ db }, {
    mainStateVersion,
    body: "A protected-cache fixture records completed evidence without guaranteeing an outcome.",
    sourceIds: [`market:AAPL:cache-protected:${fixtureKey}`],
    idempotencyKey: `cache-protected-main:${fixtureKey}`,
  });
  const route = await routeNodeReply({
    db,
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    userMessageEventId: source.eventId,
    coveredByMain: false,
    contradiction: true,
    materialEvidence: true,
    confidence: 0.95,
    mainStateVersion: String(mainStateVersion),
    sourceIds: [source.eventId],
  }, async () => undefined);
  const disclosure = await createDisclosureAuthorization({ db }, {
    accountId: fixture.accountId,
    conversationId: fixture.conversationId,
    sourceEventIds: [source.eventId],
    disclosedText: sourceText,
    privacyScope: "PROPOSAL_RAW_TEXT",
    purpose: "MAIN_PROPOSAL_REVIEW",
    expiresAt: new Date(Date.now() + 300_000),
    idempotencyKey: `cache-protected-disclosure:${fixtureKey}`,
  });
  const proposal = await createProposal({ db }, {
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventIds: [source.eventId],
    routeEventId: route.routingEventId,
    affectedMainStateIds: [String(mainStateVersion)],
    privacyScope: "PROPOSAL_RAW_TEXT",
    proposedChange: sourceText,
    evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
    counterevidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
    uncertainty: sourceText,
    disclosureAuthorizationId: disclosure.id,
    rawPrivateText: sourceText,
    idempotencyKey: `cache-protected-proposal:${fixtureKey}`,
  });
  const routed = await db.one<{ readonly ingested_sequence: string }>(
    "select ingested_sequence::text from events where id=$1",
    [route.routingEventId],
  );
  const rawPrivate = await db.one<{ readonly event_id: string }>(
    "select raw_private_text_event_id::text event_id from proposals where id=$1",
    [proposal.id],
  );
  const refreshed = await refreshHandoff({ db }, {
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    scope: "NODE_BRANCH",
    policyVersion: HANDOFF_POLICY_VERSION,
    nodeStateVersion: routed.ingested_sequence,
    mainStateVersion: String(mainStateVersion),
    throughEventId: rawPrivate.event_id,
    idempotencyKey: `cache-protected-handoff:${fixtureKey}`,
  });
  if (refreshed.status !== "COMPLETED") throw new Error("CACHE_PROTECTED_FIXTURE_EMPTY");
  const packet = await db.one<{ readonly event_id: string }>(
    "select packet_event_id::text event_id from handoff_packets where id=$1",
    [refreshed.packet.id],
  );
  return Object.freeze({
    ...fixture,
    disclosure,
    memory: memories.memories[0]!,
    packetEventId: packet.event_id,
    proposal,
    routeEventId: route.routingEventId,
    source,
    sourceText,
  });
}

beforeAll(async () => {
  process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY = randomBytes(32).toString("base64");
  db = await openTestDb();
  primaryEventRootKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1!;
  const broadcast = await commitBroadcast({ db }, {
    mainStateVersion: MAIN_STATE_VERSION,
    body: "AAPL is testing completed support; no outcome is guaranteed.",
    sourceIds: ["market:AAPL:completed-bar"],
    idempotencyKey: "cache-postgres-broadcast",
  });

  const conversation = await createConversationFixture("Cache postgres", db);
  nodeBrainId = conversation.nodeBrainId;
  accountId = conversation.accountId;
  const userMessage = await appendMessage(conversation, {
    role: "USER",
    text: "AAPL completed a close near support.",
    idempotencyKey: "cache-postgres-user-message",
  });
  const route = await routeNodeReply({
    db,
    accountId,
    nodeBrainId,
    conversationId: conversation.conversationId,
    userMessageEventId: userMessage.eventId,
    coveredByMain: true,
    contradiction: false,
    materialEvidence: false,
    confidence: 0.9,
    mainStateVersion: String(MAIN_STATE_VERSION),
    sourceIds: [userMessage.eventId, broadcast.commitEventId],
  }, async () => undefined);
  staleRoutingEventId = route.routingEventId;
  const routed = await db.one<{ readonly ingested_sequence: string }>(
    "select ingested_sequence::text from events where id=$1",
    [route.routingEventId],
  );
  await refreshHandoff({ db }, {
    accountId,
    nodeBrainId,
    conversationId: conversation.conversationId,
    scope: "NODE_BRANCH",
    policyVersion: HANDOFF_POLICY_VERSION,
    nodeStateVersion: routed.ingested_sequence,
    mainStateVersion: String(MAIN_STATE_VERSION),
    throughEventId: route.routingEventId,
    idempotencyKey: "cache-postgres-empty-handoff",
  });
  const newerMessage = await appendMessage(conversation, {
    role: "USER",
    text: "AAPL completed another close after the handoff checkpoint.",
    idempotencyKey: "cache-postgres-newer-user-message",
  });
  await routeNodeReply({
    db,
    accountId,
    nodeBrainId,
    conversationId: conversation.conversationId,
    userMessageEventId: newerMessage.eventId,
    coveredByMain: true,
    contradiction: false,
    materialEvidence: false,
    confidence: 0.91,
    mainStateVersion: String(MAIN_STATE_VERSION),
    sourceIds: [newerMessage.eventId, broadcast.commitEventId],
  }, async () => undefined);

  const stageId = randomUUID();
  const stageEventId = randomUUID();
  await db.query(
    `insert into challenge_stages (
       id,challenge_portfolio_id,profile_version_id,stage_profile_id,ordinal,created_at
     ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
    [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
      "2026-08-11T00:00:00.000Z"],
  );
  await appendChallengeLedgerEvent({ db }, {
    id: stageEventId,
    challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
    stageId,
    profileVersionId: INITIAL_PROFILE.profileVersionId,
    type: "stage.started",
    payload: { amount: "2500.00" },
    occurredAt: "2026-08-11T00:00:00.000Z",
    actorType: "SYSTEM",
    actorId: "cache-projection-worker",
    idempotencyKey: "cache-postgres-stage-start",
  });
  const ledger = await loadChallengeLedgerEvents({ db }, stageId);
  await replaceProjectionCheckpoint({ db }, {
    stageId,
    profileVersionId: INITIAL_PROFILE.profileVersionId,
    highWaterEventId: stageEventId,
    highWaterSequence: "1",
    projection: replayStoredLedgerEvents(ledger),
  });
}, 40_000);

describe("PostgreSQL cache authority", { timeout: 40_000 }, () => {
  it("maintenance does not acquire a pooled client without connection headroom", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    const maintenanceDb = databaseFromPool(pool, {
      transactionBudget: {
        remainingMilliseconds: () => 5_000,
        expirationError: () => new Error("MAINTENANCE_DEADLINE_REACHED"),
        maximumConnectionMilliseconds: 5_000,
        maximumQueryMilliseconds: 5_000,
        minimumOperationHeadroomMilliseconds: 1,
      },
    });

    await expect(maintenanceDb.transaction(async () => "NEVER"))
      .rejects.toThrow("MAINTENANCE_DEADLINE_REACHED");
    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  it("maintenance bounds commit observation inside the route deadline", async () => {
    let monotonicNow = 1_000;
    let metricSettled = false;
    const clientQueries: Array<{ readonly text: string; readonly query_timeout?: number }> = [];
    const metricQueries: Array<{ readonly text: string; readonly query_timeout?: number }> = [];
    const client = {
      query: vi.fn(async (input: string | { readonly text: string; readonly query_timeout?: number }) => {
        const query = typeof input === "string" ? { text: input } : input;
        clientQueries.push(query);
        if (query.text === "commit") monotonicNow = 9_900;
        if (query.text.includes("database_commit_metric_buckets")) {
          await Promise.resolve();
          monotonicNow = 10_000;
          metricSettled = true;
          throw new Error("QUERY_TIMEOUT");
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (input: string | { readonly text: string; readonly query_timeout?: number }) => {
        const query = typeof input === "string" ? { text: input } : input;
        metricQueries.push(query);
        throw new Error("SECOND_POOL_ACQUISITION_FORBIDDEN");
      }),
    } as unknown as Pool;
    const maintenanceDb = databaseFromPool(pool, {
      transactionBudget: {
        remainingMilliseconds: () => 10_000 - monotonicNow,
        expirationError: () => new Error("MAINTENANCE_DEADLINE_REACHED"),
        maximumConnectionMilliseconds: 5_000,
        maximumQueryMilliseconds: 5_000,
        minimumOperationHeadroomMilliseconds: 1,
      },
    });

    await expect(runBoundedMaintenance({
      deadline: new Date(10_000),
      now: () => new Date(monotonicNow),
      verify: async () => undefined,
      withLock: async (work) => maintenanceDb.transaction(work),
      cache: async () => ({ processed: 0 }),
      privacy: async () => ({ processed: 0 }),
      stream: async () => ({ processed: 0 }),
      schedules: async () => ({ processed: 0 }),
      bridgeLeases: async () => ({ processed: 0 }),
    })).rejects.toThrow("MAINTENANCE_DEADLINE_REACHED");

    expect(clientQueries.map(({ text }) => text)).toEqual([
      "begin", "commit", expect.stringContaining("database_commit_metric_buckets"),
    ]);
    expect(clientQueries.every(({ query_timeout }) => (
      Number.isInteger(query_timeout) && query_timeout! > 0 && query_timeout! <= 5_000
    ))).toBe(true);
    expect(clientQueries[2]?.query_timeout).toBeGreaterThan(0);
    expect(clientQueries[2]?.query_timeout).toBeLessThan(100);
    expect(metricQueries).toHaveLength(0);
    expect(metricSettled).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("maintenance rechecks the route deadline after the locked transaction returns", async () => {
    let now = 1_000;
    const laterStep = vi.fn(async () => ({ processed: 0 }));
    await expect(runBoundedMaintenance({
      deadline: new Date(10_000),
      now: () => new Date(now),
      verify: async () => undefined,
      withLock: async (work) => {
        const result = await work();
        now = 10_000;
        return result;
      },
      cache: laterStep,
      privacy: laterStep,
      stream: laterStep,
      schedules: laterStep,
      bridgeLeases: laterStep,
    })).rejects.toThrow("MAINTENANCE_DEADLINE_REACHED");
    expect(laterStep).toHaveBeenCalledTimes(5);
  });

  it("maintenance treats a timed-out commit as ambiguous and never rolls it back", async () => {
    let now = 1_000;
    const commands: Array<{ readonly text: string; readonly query_timeout?: number }> = [];
    const client = {
      query: vi.fn(async (input: string | { readonly text: string; readonly query_timeout?: number }) => {
        const query = typeof input === "string" ? { text: input } : input;
        commands.push(query);
        if (query.text === "commit") {
          await Promise.resolve();
          now = 10_000;
          throw new Error("QUERY_TIMEOUT");
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    const maintenanceDb = databaseFromPool(pool, {
      transactionBudget: {
        remainingMilliseconds: () => 10_000 - now,
        expirationError: () => new Error("MAINTENANCE_DEADLINE_REACHED"),
        maximumConnectionMilliseconds: 5_000,
        maximumQueryMilliseconds: 5_000,
        minimumOperationHeadroomMilliseconds: 1,
      },
    });

    await expect(maintenanceDb.transaction(async () => "AMBIGUOUS"))
      .rejects.toThrow("MAINTENANCE_DEADLINE_REACHED");
    expect(commands.map(({ text }) => text)).toEqual(["begin", "commit"]);
    expect(commands[1]?.query_timeout).toBe(5_000);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("maintenance skips the observer when a successful commit reaches exact expiry", async () => {
    let now = 1_000;
    const commands: string[] = [];
    const client = {
      query: vi.fn(async (input: string | { readonly text: string }) => {
        const text = typeof input === "string" ? input : input.text;
        commands.push(text);
        if (text === "commit") now = 10_000;
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    const maintenanceDb = databaseFromPool(pool, {
      transactionBudget: {
        remainingMilliseconds: () => 10_000 - now,
        expirationError: () => new Error("MAINTENANCE_DEADLINE_REACHED"),
        maximumConnectionMilliseconds: 5_000,
        maximumQueryMilliseconds: 5_000,
        minimumOperationHeadroomMilliseconds: 1,
      },
    });

    await expect(maintenanceDb.transaction(async () => "COMMITTED"))
      .rejects.toThrow("MAINTENANCE_DEADLINE_REACHED");
    expect(commands).toEqual(["begin", "commit"]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("maintenance keeps bounded commit metrics best-effort before expiry", async () => {
    const run = async (metricFailure: boolean) => {
      const client = {
        query: vi.fn(async (input: string | { readonly text: string; readonly query_timeout?: number }) => {
          const query = typeof input === "string" ? { text: input } : input;
          if (metricFailure && query.text.includes("database_commit_metric_buckets")) {
            throw new Error("METRIC_UNAVAILABLE");
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const pool = {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => { throw new Error("SECOND_POOL_ACQUISITION_FORBIDDEN"); }),
      } as unknown as Pool;
      const maintenanceDb = databaseFromPool(pool, {
        transactionBudget: {
          remainingMilliseconds: () => 9_000,
          expirationError: () => new Error("MAINTENANCE_DEADLINE_REACHED"),
          maximumConnectionMilliseconds: 5_000,
          maximumQueryMilliseconds: 5_000,
          minimumOperationHeadroomMilliseconds: 1,
        },
      });
      await expect(maintenanceDb.transaction(async () => "COMMITTED"))
        .resolves.toBe("COMMITTED");
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(
        metricFailure ? expect.any(Error) : undefined,
      );
      expect(pool.query).not.toHaveBeenCalled();
      const metricQuery = vi.mocked(client.query).mock.calls[2]?.[0] as unknown as {
        readonly text: string;
        readonly query_timeout?: number;
      };
      expect(metricQuery.text).toContain("database_commit_metric_buckets");
      expect(metricQuery.query_timeout).toBe(5_000);
    };

    await run(false);
    await run(true);
  });

  it("maintenance observes a commit without a second pooled-client acquisition", async () => {
    let now = 1_000;
    let metricSettled = false;
    const clientQueries: Array<{ readonly text: string; readonly query_timeout?: number }> = [];
    const client = {
      query: vi.fn(async (input: string | { readonly text: string; readonly query_timeout?: number }) => {
        const query = typeof input === "string" ? { text: input } : input;
        clientQueries.push(query);
        if (query.text === "commit") now = 6_000;
        if (query.text.includes("database_commit_metric_buckets")) {
          now += query.query_timeout!;
          metricSettled = true;
          throw new Error("QUERY_TIMEOUT");
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (input: { readonly query_timeout?: number }) => {
        const staleQueryTimeout = input.query_timeout!;
        now += staleQueryTimeout;
        now += staleQueryTimeout;
        metricSettled = true;
        throw new Error("QUERY_TIMEOUT");
      }),
    } as unknown as Pool;
    const maintenanceDb = databaseFromPool(pool, {
      transactionBudget: {
        remainingMilliseconds: () => 10_000 - now,
        expirationError: () => new Error("MAINTENANCE_DEADLINE_REACHED"),
        maximumConnectionMilliseconds: 5_000,
        maximumQueryMilliseconds: 5_000,
        minimumOperationHeadroomMilliseconds: 1,
      },
    });

    const outcome = await maintenanceDb.transaction(async () => "COMMITTED")
      .catch((error: unknown) => error instanceof Error ? error.message : "UNKNOWN");

    expect(outcome).toBe("COMMITTED");
    expect(now).toBeLessThan(10_000);
    expect(pool.query).not.toHaveBeenCalled();
    expect(clientQueries.map(({ text }) => text)).toEqual([
      "begin", "commit", expect.stringContaining("database_commit_metric_buckets"),
    ]);
    expect(metricSettled).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("maintenance bounds rollback before returning an application failure", async () => {
    let now = 1_000;
    const commands: Array<{ readonly text: string; readonly query_timeout?: number }> = [];
    const client = {
      query: vi.fn(async (input: string | { readonly text: string; readonly query_timeout?: number }) => {
        const query = typeof input === "string" ? { text: input } : input;
        commands.push(query);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    const maintenanceDb = databaseFromPool(pool, {
      transactionBudget: {
        remainingMilliseconds: () => 10_000 - now,
        expirationError: () => new Error("MAINTENANCE_DEADLINE_REACHED"),
        maximumConnectionMilliseconds: 5_000,
        maximumQueryMilliseconds: 5_000,
        minimumOperationHeadroomMilliseconds: 1,
      },
    });

    await expect(maintenanceDb.transaction(async () => {
      now = 9_900;
      throw new Error("WORK_FAILED");
    })).rejects.toThrow("WORK_FAILED");
    expect(commands.map(({ text }) => text)).toEqual(["begin", "rollback"]);
    expect(commands[1]?.query_timeout).toBeGreaterThan(0);
    expect(commands[1]?.query_timeout).toBeLessThan(100);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("maintenance uses one non-blocking PostgreSQL overlap lock", async () => {
    let entered!: () => void;
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const first = withMaintenanceLock(db, async () => {
      entered();
      await released;
      return "FIRST";
    });
    await lockEntered;

    await expect(withMaintenanceLock(db, async () => "SECOND")).resolves.toBeNull();
    release();
    await expect(first).resolves.toBe("FIRST");
  });

  it("maintenance records replay once and terminalizes bounded exhausted leases", async () => {
    const retainedRootKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
    const maintenanceDb = await openTestDb();
    try {
      const fixture = await createConversationFixture(
        "cache-maintenance-stale-lease", maintenanceDb,
      );
      await appendMessage(fixture, {
        role: "USER", text: "maintenance lease", idempotencyKey: "maintenance-lease-source",
      });
      const expire = async (jobId: string) => {
        await maintenanceDb.transaction(async (transaction) => {
          await transaction.query(
            "alter table bridge_model_jobs disable trigger bridge_model_jobs_are_semantically_immutable",
          );
          await transaction.query(
            `update bridge_model_jobs set updated_at=created_at,
               lease_expires_at=created_at+interval '1 millisecond' where job_id=$1`,
            [jobId],
          );
          await transaction.query(
            "alter table bridge_model_jobs enable trigger bridge_model_jobs_are_semantically_immutable",
          );
        });
      };
      const first = await claimNextBridgeJob(maintenanceDb, {
        workerId: "maintenance-local-1", now: new Date(),
      });
      await expire(first!.jobId);
      const second = await claimNextBridgeJob(maintenanceDb, {
        workerId: "maintenance-local-2", now: new Date(),
      });
      await expire(second!.jobId);
      const third = await claimNextBridgeJob(maintenanceDb, {
        workerId: "maintenance-local-3", now: new Date(),
      });
      await expire(third!.jobId);

      const delivery = {
        messageId: "maintenance-replay-authority-1",
        bodyDigest: "a".repeat(64),
        publishedAt: new Date(),
      } as const;
      await expect(withMaintenanceLock(maintenanceDb, async (transaction) => {
        await recordMaintenanceDelivery(transaction, delivery);
        return settleStaleBridgeLeases(transaction, 8);
      })).resolves.toEqual({ processed: 1 });
      await expect(maintenanceDb.one(
        "select status,safe_code from bridge_model_jobs where job_id=$1", [third!.jobId],
      )).resolves.toEqual({ status: "FAILED", safe_code: "ATTEMPT_LIMIT_EXHAUSTED" });
      await expect(withMaintenanceLock(maintenanceDb, async (transaction) => {
        await recordMaintenanceDelivery(transaction, delivery);
        return settleStaleBridgeLeases(transaction, 8);
      })).rejects.toThrow("MAINTENANCE_REQUEST_REPLAYED");
      await expect(maintenanceDb.one<{ readonly used_count: number }>(
        `select used_count from deployment_quota_counters
          where quota_name='QSTASH_MESSAGES'
            and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
      )).resolves.toEqual({ used_count: 1 });
    } finally {
      if (retainedRootKey === undefined) delete process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
      else process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = retainedRootKey;
    }
  }, 60_000);

  it("maintenance deadline rejects deferred statements and rolls back receipt and quota", async () => {
    const retainedRootKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
    const deadlineDb = await openTestDb();
    let monotonicNow = 1_000;
    const delivery = {
      messageId: "maintenance-deadline-rollback-1",
      bodyDigest: "b".repeat(64),
      publishedAt: new Date(),
    } as const;
    try {
      await expect(withMaintenanceLock(deadlineDb, async (transaction) => {
        const bounded = deadlineBoundDatabase(transaction, {
          deadlineMonotonicMs: 2_000,
          monotonicNow: () => monotonicNow,
        });
        await recordMaintenanceDelivery(bounded, delivery);
        await bounded.transaction(async (nested) => {
          monotonicNow = 2_000;
          await settleStaleBridgeLeases(nested, 8);
        });
      })).rejects.toThrow("MAINTENANCE_DEADLINE_REACHED");
      await expect(deadlineDb.one<{ readonly receipts: number; readonly quota: number }>(
        `select
           (select count(*)::int from bridge_wake_receipts where message_id=$1) receipts,
           (select count(*)::int from deployment_quota_counters
             where quota_name='QSTASH_MESSAGES') quota`,
        [delivery.messageId],
      )).resolves.toEqual({ receipts: 0, quota: 0 });
    } finally {
      if (retainedRootKey === undefined) delete process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
      else process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = retainedRootKey;
    }
  }, 60_000);

  it("maintenance deadline rolls back when the final statement reaches expiry before commit", async () => {
    const retainedRootKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
    const finalStatementDb = await openTestDb();
    let monotonicNow = 3_000;
    const delivery = {
      messageId: "maintenance-final-statement-rollback-1",
      bodyDigest: "c".repeat(64),
      publishedAt: new Date(),
    } as const;
    try {
      const bounded = deadlineBoundDatabase(finalStatementDb, {
        deadlineMonotonicMs: 4_000,
        monotonicNow: () => monotonicNow,
      });
      await expect(withMaintenanceLock(bounded, async (transaction) => {
        await recordMaintenanceDelivery(transaction, delivery);
        await transaction.query("select 1 as final_statement");
        monotonicNow = 4_000;
        return "SHOULD_NOT_COMMIT";
      })).rejects.toThrow("MAINTENANCE_DEADLINE_REACHED");
      await expect(finalStatementDb.one<{ readonly receipts: number; readonly quota: number }>(
        `select
           (select count(*)::int from bridge_wake_receipts where message_id=$1) receipts,
           (select count(*)::int from deployment_quota_counters
             where quota_name='QSTASH_MESSAGES') quota`,
        [delivery.messageId],
      )).resolves.toEqual({ receipts: 0, quota: 0 });
    } finally {
      if (retainedRootKey === undefined) delete process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
      else process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = retainedRootKey;
    }
  }, 60_000);

  it("builds bounded source-linked records and independent required category manifests", async () => {
    const source = createPostgresProjectionSource(db);
    const manifest = await source.readManifest("CURRENT");
    expect(manifest.categories.map(({ category }) => category).sort()).toEqual(
      [...CACHE_REQUIRED_CATEGORIES].sort(),
    );
    expect(manifest.categories.every(({ recordCount, manifestHash, sourceHighWater }) => (
      recordCount > 0 && /^[a-f0-9]{64}$/.test(manifestHash) && sourceHighWater.length > 0
    ))).toBe(true);
    const page = await source.readPage({ checkpoint: "CURRENT", afterId: null, limit: 100 });
    expect(page.records.map(({ value }) => value.kind)).toEqual(expect.arrayContaining([
      "MAIN_STATE",
      "SCHEDULED_BROADCAST",
      "NODE_DOSSIER",
      "NODE_HANDOFF",
      "CHALLENGE_SNAPSHOT",
    ]));
    expect(page.records.every(({ value }) => (
      Array.isArray(value.sourceEventIds) && value.sourceEventIds.length > 0
    ))).toBe(true);
  });

  it("rebuilds and startup-prewarms all required categories with durable checks", async () => {
    const cache = scopedCache({
      backend: new MemoryCacheBackend(),
      encryptionKey: CACHE_KEY,
      authorize: () => true,
    });
    const rebuilt = await rebuildPostgresCache({ db, cache, checkpoint: "CURRENT" });
    expect(rebuilt).toMatchObject({ source: "POSTGRES", mainState: "rebuilt", challenge: "rebuilt" });
    const checks = await db.query<{
      readonly category: string;
      readonly status: string;
      readonly record_count: number;
      readonly high_water_count: number;
      readonly high_water_hash: string;
    }>(
      `select category,status,record_count,high_water_count,high_water_hash
       from cache_rebuild_category_checks order by category`,
    );
    expect(checks).toHaveLength(CACHE_REQUIRED_CATEGORIES.length);
    expect(checks.every(({ status, record_count, high_water_count, high_water_hash }) => (
      status === "VERIFIED" && record_count === high_water_count
      && /^[a-f0-9]{64}$/.test(high_water_hash)
    ))).toBe(true);

    await cache.flushAll();
    await prewarmPostgresCache({ db, cache, checkpoint: "CURRENT" });
    const source = createPostgresProjectionSource(db);
    const main = (await source.readPage({ checkpoint: "CURRENT", afterId: null, limit: 100 }))
      .records.find(({ value }) => value.kind === "MAIN_STATE")!;
    expect(await cache.getCurrent(cachePointerKey(main.key))).toMatchObject({
      kind: "MAIN_STATE",
      mainStateVersion: String(MAIN_STATE_VERSION),
    });
  });

  it("durably synchronizes canonical outbox/checkpoint work and atomically reclaims leases", async () => {
    const staleChange = await createPostgresProjectionSource(db).loadChange(staleRoutingEventId, {
      topic: "node.reply.routed",
      category: "NODE_DOSSIERS",
      maxRows: 1_000,
    });
    expect(staleChange).toMatchObject({
      action: "PREWARM",
      triggerEventId: staleRoutingEventId,
      record: { value: { kind: "NODE_DOSSIER", nodeBrainId } },
    });
    if (staleChange.action !== "PREWARM") throw new Error("CACHE_STALE_REFRESH_NOT_PREWARMED");
    expect((staleChange.record.value as { readonly sourceEventIds: readonly string[] }).sourceEventIds)
      .not.toContain(staleRoutingEventId);
    const firstSync = await synchronizeCanonicalCacheJobs(db, { limit: 1_000 });
    const secondSync = await synchronizeCanonicalCacheJobs(db, { limit: 1_000 });
    expect(firstSync.inserted).toBeGreaterThan(0);
    expect(secondSync.inserted).toBe(0);

    const challengeJobs = createPostgresCacheJobRepository(db, { categories: ["CHALLENGE"] });
    const first = await challengeJobs.claim("cache-worker-a", 25);
    expect(first).not.toBeNull();
    expect(await challengeJobs.claim("cache-worker-b", 25)).toBeNull();
    await db.query("select pg_sleep(0.04)");
    const restarted = createPostgresCacheJobRepository(db, { categories: ["CHALLENGE"] });
    const reclaimed = await restarted.claim("cache-worker-b", 1_000);
    expect(reclaimed?.jobId).toBe(first?.jobId);
    await expect(challengeJobs.complete(first!)).rejects.toThrow("CACHE_JOB_CLAIM_STALE");
    await restarted.retry(reclaimed!, "CACHE_TEST_RETRY");
    const state = await db.one<{ readonly status: string; readonly attempts: number }>(
      "select status,attempts from cache_projection_jobs where id=$1",
      [reclaimed!.jobId],
    );
    expect(state).toMatchObject({ status: "RETRY_SCHEDULED", attempts: 2 });
    await db.query(
      `update cache_projection_jobs set attempts=20,available_at=clock_timestamp()
       where id=$1`,
      [reclaimed!.jobId],
    );
    const repeatedlyReclaimed = await restarted.claim("cache-worker-after-many-crashes", 1_000);
    expect(repeatedlyReclaimed).toMatchObject({ jobId: reclaimed!.jobId, attempt: 21 });
    await restarted.fail(repeatedlyReclaimed!, "CACHE_TEST_MAX_PROCESSING_ATTEMPTS");
  });

  it("processes canonical changes after restart and persists worker/startup/rebuild metrics", async () => {
    await db.query(
      "update cache_projection_jobs set available_at=clock_timestamp() where status='RETRY_SCHEDULED'",
    );
    const cache = scopedCache({
      backend: new MemoryCacheBackend(),
      encryptionKey: CACHE_KEY,
      authorize: () => true,
    });
    const result = await runPostgresCacheWorkerOnce({
      db,
      cache,
      workerId: "cache-worker-after-restart",
      leaseMs: 5_000,
      maxAttempts: 3,
    });
    expect(["COMPLETED", "IDLE"]).toContain(result);
    const versions = await db.one<{ readonly count: number }>(
      "select count(*)::int count from cache_projection_versions",
    );
    expect(versions.count).toBeGreaterThan(0);
    const metrics = await readPostgresCacheMetrics(db);
    expect(metrics.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "cache.queue_lag_ms",
      "cache.prewarm_latency_ms",
      "cache.startup_prewarm_latency_ms",
      "cache.rebuild_latency_ms",
      "cache.freshness_lag_ms",
    ]));
  });

  it("rolls up more than one thousand metric samples with bounded latest-first retention", async () => {
    const retainedRootKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
    const metricDb = await openTestDb();
    if (retainedRootKey === undefined) delete process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
    else process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = retainedRootKey;
    await metricDb.query(
      `insert into cache_metric_observations (
         name,value,category,topology_version,bucket_start,sample_count,
         value_sum,value_max,observed_at
       )
       select 'cache.queue_lag_ms',sample::float8,null,'single-main-node-v1',
              date_trunc('minute',clock_timestamp())-(sample::text||' minutes')::interval,
              1,sample::float8,sample::float8,
              date_trunc('minute',clock_timestamp())-(sample::text||' minutes')::interval
       from generate_series(1,1100) sample`,
    );
    await metricDb.transaction(async (transaction) => {
      for (let sample = 0; sample < 1_005; sample += 1) {
        await recordPostgresCacheMetric(transaction, "cache.queue_lag_ms", sample);
      }
      await recordPostgresCacheMetric(transaction, "cache.freshness_lag_ms", 77);
      await recordPostgresCacheMetric(transaction, "cache.invalidation_latency_ms", 33);
    });

    const metrics = await readPostgresCacheMetrics(metricDb);
    expect(metrics).toHaveLength(1_000);
    expect(metrics.every((metric, index) => (
      index === 0 || metric.observedAt <= metrics[index - 1]!.observedAt
    ))).toBe(true);
    const current = new Map<string, (typeof metrics)[number]>();
    for (const metric of metrics) {
      if (!current.has(metric.name)) current.set(metric.name, metric);
    }
    expect(current.get("cache.queue_lag_ms")).toMatchObject({
      value: 1_004, sampleCount: 1_005, topologyVersion: "single-main-node-v1",
    });
    expect(current.get("cache.freshness_lag_ms")?.value).toBe(77);
    expect(current.get("cache.invalidation_latency_ms")?.value).toBe(33);
    expect((await metricDb.one<{ readonly count: number }>(
      "select count(*)::int count from cache_metric_observations where name='cache.queue_lag_ms'",
    )).count).toBeLessThanOrEqual(1_000);
  }, 60_000);

  it("continues refreshing canonical events committed after production startup", async () => {
    const runtimeModule = await import("../../lib/server/cache/runtime");
    expect(runtimeModule).toHaveProperty("startPostgresCacheWorker");
    const start = (runtimeModule as typeof runtimeModule & {
      readonly startPostgresCacheWorker: (input: {
        readonly db: TestDatabase;
        readonly cache: ReturnType<typeof scopedCache>;
        readonly workerId: string;
        readonly leaseMs: number;
        readonly maxAttempts: number;
        readonly pollIntervalMs: number;
      }) => { readonly stop: () => Promise<void>; readonly done: Promise<void> };
    }).startPostgresCacheWorker;
    const cache = scopedCache({
      backend: new MemoryCacheBackend(),
      encryptionKey: CACHE_KEY,
      authorize: () => true,
    });
    const worker = start({
      db,
      cache,
      workerId: "cache-continuous-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
      pollIntervalMs: 5,
    });
    try {
      const broadcast = await commitBroadcast({ db }, {
        mainStateVersion: 8_241_001,
        body: "MSFT completed resistance remains provisional.",
        sourceIds: ["market:MSFT:completed-bar"],
        idempotencyKey: "cache-continuous-broadcast",
      });
      const deadline = Date.now() + 8_000;
      let prewarmed = 0;
      while (Date.now() < deadline && prewarmed === 0) {
        prewarmed = (await db.one<{ readonly count: number }>(
          `select count(*)::int count from cache_projection_versions
           where category='BROADCASTS' and source_event_id=$1`,
          [broadcast.commitEventId],
        )).count;
        if (prewarmed === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(prewarmed).toBe(1);
    } finally {
      await worker.stop();
      await worker.done;
    }
  }, 40_000);

  it("publishes live authorized dossier and handoff contents, then writes nothing after revocation", async () => {
    const fixture = await createProtectedCacheProjectionFixture();
    const source = createPostgresProjectionSource(db);
    const dossier = await source.loadChange(fixture.routeEventId, {
      topic: "node.reply.routed",
      category: "NODE_DOSSIERS",
      maxRows: 1_000,
    });
    expect(dossier).toMatchObject({
      action: "PREWARM",
      record: {
        value: {
          kind: "NODE_DOSSIER",
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          route: {
            reason: "MATERIAL_IMPROVEMENT",
            sourceIds: [fixture.source.eventId],
          },
        },
      },
    });
    const handoff = await source.loadChange(fixture.packetEventId, {
      topic: "node.handoff.packet.refreshed",
      category: "NODE_HANDOFFS",
      maxRows: 1_000,
    });
    expect(handoff).toMatchObject({
      action: "PREWARM",
      record: {
        value: {
          kind: "NODE_HANDOFF",
          packetKind: "PACKET",
          accountId: fixture.accountId,
        },
      },
    });
    if (handoff.action !== "PREWARM"
        || !Array.isArray((handoff.record.value as { readonly items?: unknown }).items)) {
      throw new Error("CACHE_HANDOFF_TEST_PAYLOAD_MISSING");
    }
    expect((handoff.record.value as unknown as { readonly items: readonly unknown[] }).items).toEqual(
      expect.arrayContaining([expect.objectContaining({
        proposalId: fixture.proposal.id,
        sourceIds: [fixture.source.eventId],
        memoryVersions: expect.arrayContaining([
          expect.objectContaining({ memoryId: fixture.memory.id }),
        ]),
      })]),
    );
    expect(handoff.action === "PREWARM" && JSON.stringify(handoff.record.value))
      .toContain(fixture.sourceText);

    await revokeDisclosureAuthorization({ db }, {
      accountId: fixture.accountId,
      authorizationId: fixture.disclosure.id,
      idempotencyKey: "cache-protected-disclosure-revoke",
    });
    const revokedHandoff = await source.loadChange(fixture.packetEventId, {
      topic: "node.handoff.packet.refreshed",
      category: "NODE_HANDOFFS",
      maxRows: 1_000,
    });
    expect(revokedHandoff.action).toBe("INVALIDATE");
    const revokedHandoffBackend = new MemoryCacheBackend();
    if (revokedHandoff.action === "PREWARM") {
      await scopedCache({
        backend: revokedHandoffBackend,
        encryptionKey: CACHE_KEY,
        authorize: () => true,
      }).publish({
        pointerKey: cachePointerKey(revokedHandoff.record.key),
        versionKey: cacheKey(revokedHandoff.record.key),
        versionOrdinal: revokedHandoff.record.versionOrdinal,
        value: revokedHandoff.record.value,
        options: { ttlSeconds: 60, encrypted: true },
      });
    }
    expect(revokedHandoffBackend.stats().writes).toBe(0);

    await db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [fixture.accountId]);
    const revokedDossier = await source.loadChange(fixture.routeEventId, {
      topic: "node.reply.routed",
      category: "NODE_DOSSIERS",
      maxRows: 1_000,
    });
    expect(revokedDossier.action).toBe("INVALIDATE");
    const revokedDossierBackend = new MemoryCacheBackend();
    if (revokedDossier.action === "PREWARM") {
      await scopedCache({
        backend: revokedDossierBackend,
        encryptionKey: CACHE_KEY,
        authorize: () => true,
      }).publish({
        pointerKey: cachePointerKey(revokedDossier.record.key),
        versionKey: cacheKey(revokedDossier.record.key),
        versionOrdinal: revokedDossier.record.versionOrdinal,
        value: revokedDossier.record.value,
        options: { ttlSeconds: 60, encrypted: true },
      });
    }
    expect(revokedDossierBackend.stats().writes).toBe(0);
  }, 60_000);

  it("uses exact entity refresh outside the hottest 100 and bounded indexed startup branches", async () => {
    const fixture = await seedMoreThanOnePageOfNodeAndHandoffSources();
    const target = fixture.targetIndex;
    const targetRoute = fixture.routes[target]!;
    const targetCheckpoint = fixture.checkpoints.find(({ index }) => index === target)!;
    const source = createPostgresProjectionSource(db);
    await expect(source.loadChange(targetRoute.id, {
      topic: "node.reply.routed",
      category: "NODE_DOSSIERS",
      maxRows: 1_000,
    })).resolves.toMatchObject({
      action: "PREWARM",
      record: { value: {
        kind: "NODE_DOSSIER",
        accountId: fixture.accountIds[target],
        nodeBrainId: fixture.nodeBrainIds[target],
      } },
    });
    await expect(source.loadChange(targetCheckpoint.eventId, {
      topic: "node.handoff.checkpoint.advanced",
      category: "NODE_HANDOFFS",
      maxRows: 1_000,
    })).resolves.toMatchObject({
      action: "PREWARM",
      record: { value: {
        kind: "NODE_HANDOFF",
        accountId: fixture.accountIds[target],
        packetKind: "EMPTY_CHECKPOINT",
        items: [],
      } },
    });

    const hottestManifest = await source.readManifest("HOTTEST_EXACT_TEST");
    const records: Awaited<ReturnType<typeof source.readPage>>["records"][number][] = [];
    let cursor: string | null = null;
    do {
      const page = await source.readPage({
        checkpoint: "HOTTEST_EXACT_TEST",
        afterId: cursor,
        limit: 100,
      });
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(records.some(({ value }) => (
      Array.isArray((value as { readonly sourceEventIds?: unknown }).sourceEventIds)
      && (value as { readonly sourceEventIds: readonly string[] }).sourceEventIds.includes(targetRoute.id)
    ))).toBe(true);
    expect(records.some(({ value }) => (
      Array.isArray((value as { readonly sourceEventIds?: unknown }).sourceEventIds)
      && (value as { readonly sourceEventIds: readonly string[] }).sourceEventIds.includes(targetCheckpoint.eventId)
    ))).toBe(true);

    const repeatedManifest = await createPostgresProjectionSource(db)
      .readManifest("HOTTEST_EXACT_TEST_REPEAT");
    for (const categoryName of ["NODE_DOSSIERS", "NODE_HANDOFFS"] as const) {
      const first = hottestManifest.categories.find(({ category }) => category === categoryName) as
        CriticalProjectionManifest["categories"][number]
        & { readonly highWaterCount: number; readonly highWaterHash: string };
      const repeated = repeatedManifest.categories.find(({ category }) => category === categoryName) as
        typeof first;
      expect(first.recordCount).toBe(100);
      expect(first.highWaterCount).toBe(100);
      expect(first.highWaterHash).toMatch(/^[a-f0-9]{64}$/);
      expect(repeated).toEqual(first);
    }

    const prewarmCache = scopedCache({
      backend: new MemoryCacheBackend(),
      encryptionKey: CACHE_KEY,
      authorize: () => true,
    });
    await expect(prewarmPostgresCache({
      db,
      cache: prewarmCache,
      checkpoint: "HOTTEST_EXACT_PREWARM",
    })).resolves.toMatchObject({ source: "POSTGRES", handoffs: "rebuilt" });
    await prewarmCache.flushAll();
    await expect(rebuildPostgresCache({
      db,
      cache: prewarmCache,
      checkpoint: "HOTTEST_EXACT_REBUILD",
    })).resolves.toMatchObject({ source: "POSTGRES", handoffs: "rebuilt" });

    const originalNodeAuthority = hottestManifest.categories.find(
      ({ category }) => category === "NODE_DOSSIERS",
    ) as CriticalProjectionManifest["categories"][number]
      & { readonly highWaterCount: number; readonly highWaterHash: string };
    const mutableNode = records.find(({ value, id }) => (
      value.kind === "NODE_DOSSIER" && !id.endsWith(fixture.nodeBrainIds[target]!)
    ))!;
    const mutatedNode = Object.freeze({
      ...mutableNode,
      key: Object.freeze({ ...mutableNode.key, sourceHighWater: "e1" }),
      value: Object.freeze({ ...mutableNode.value, sourceHighWater: "e1" }),
      contentHash: projectionValueHash({ ...mutableNode.value, sourceHighWater: "e1" }),
    });
    const mutatedRecords = records.map((item) => item.id === mutableNode.id ? mutatedNode : item);
    const mutatedCategories = projectionCategoryManifests(mutatedRecords).map((category) => (
      category.category === "NODE_DOSSIERS"
        ? Object.freeze({
            ...category,
            highWaterCount: originalNodeAuthority.highWaterCount,
            highWaterHash: originalNodeAuthority.highWaterHash,
          })
        : category
    ));
    const mutatedManifest = Object.freeze({
      ...hottestManifest,
      manifestHash: projectionManifestHash(mutatedRecords),
      categories: mutatedCategories,
    });
    const mutatedBackend = new MemoryCacheBackend();
    await expect(rebuildCriticalProjections({
      cache: scopedCache({
        backend: mutatedBackend,
        encryptionKey: CACHE_KEY,
        authorize: () => true,
      }),
      source: snapshotProjectionSource(mutatedManifest, mutatedRecords),
      checkpoint: "HOTTEST_EXACT_MUTATED",
    })).rejects.toThrow("CACHE_REBUILD_CATEGORY_DIVERGED");
    expect(mutatedBackend.stats().writes).toBe(0);

    const missingRecords = records.filter((item) => item.id !== mutableNode.id);
    const missingActual = projectionCategoryManifests(missingRecords);
    const missingManifest = Object.freeze({
      ...hottestManifest,
      recordCount: missingRecords.length,
      manifestHash: projectionManifestHash(missingRecords),
      categories: missingActual.map((category) => category.category === "NODE_DOSSIERS"
        ? Object.freeze({
            ...category,
            highWaterCount: originalNodeAuthority.highWaterCount,
            highWaterHash: originalNodeAuthority.highWaterHash,
          })
        : category),
    });
    const missingBackend = new MemoryCacheBackend();
    await expect(rebuildCriticalProjections({
      cache: scopedCache({
        backend: missingBackend,
        encryptionKey: CACHE_KEY,
        authorize: () => true,
      }),
      source: snapshotProjectionSource(missingManifest, missingRecords),
      checkpoint: "HOTTEST_EXACT_MISSING",
    })).rejects.toThrow(/CACHE_REBUILD_CATEGORY_(?:MANIFEST_INVALID|DIVERGED)/);
    expect(missingBackend.stats().writes).toBe(0);

    const indexes = await db.query<{ readonly indexname: string; readonly indexdef: string }>(
      `select indexname,indexdef from pg_indexes
       where schemaname=current_schema() and tablename in (
         'transactional_outbox','cache_outbox_staging',
         'handoff_packets','handoff_refresh_checkpoints'
       )`,
    );
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        indexdef: expect.stringMatching(/transactional_outbox.*\(topic, created_at, id\).*INCLUDE \(event_id\)/i),
      }),
    ]));
    expect(indexes.map(({ indexname }) => indexname)).toEqual(expect.arrayContaining([
      "cache_handoff_packets_hottest_idx",
      "cache_handoff_packets_entity_latest_idx",
      "cache_handoff_checkpoints_hottest_idx",
      "cache_handoff_checkpoints_entity_latest_idx",
      "cache_outbox_staging_pending_idx",
    ]));
    const observedSql: string[] = [];
    await synchronizeCanonicalCacheJobs(observeSql(db, observedSql), { limit: 7 });
    const outboxPoll = observedSql.find((sql) => sql.includes("cache-canonical-outbox-poll"));
    expect(outboxPoll).toMatch(/from cache_outbox_staging staged[\s\S]*processed_at is null/iu);
    expect(outboxPoll).not.toMatch(/ingested_sequence\s*>/iu);
    expect(outboxPoll).not.toMatch(/row_number|rank\s*\(/i);
    await db.transaction(async (transaction) => {
      await transaction.query("set local enable_seqscan=off");
      const plan = await transaction.query<{ readonly "QUERY PLAN": unknown }>(
        `explain (format json)
         select event_id from transactional_outbox
         where topic='node.reply.routed'
         order by created_at,id limit 100`,
      );
      expect(JSON.stringify(plan)).toMatch(/cache_transactional_outbox_topic_created_idx/i);
    });
  }, 120_000);

  it("verifies deterministic empty categories on fresh and Main/broadcast-only databases", async () => {
    const fresh = await openTestDb();
    const freshSource = createPostgresProjectionSource(fresh);
    const first = await freshSource.readManifest("FRESH_EMPTY");
    const repeated = await createPostgresProjectionSource(fresh).readManifest("FRESH_EMPTY_REPEAT");
    expect(first).toMatchObject({ sourceHighWater: "e0", recordCount: 0 });
    expect(first.categories).toHaveLength(CACHE_REQUIRED_CATEGORIES.length);
    expect(first.categories.every((category) => (
      category.sourceHighWater === "e0"
      && category.recordCount === 0
      && category.highWaterCount === 0
      && /^[a-f0-9]{64}$/.test(category.manifestHash)
      && /^[a-f0-9]{64}$/.test(category.highWaterHash)
    ))).toBe(true);
    expect(repeated.categories).toEqual(first.categories);

    const emptyBackend = new MemoryCacheBackend();
    await expect(prewarmPostgresCache({
      db: fresh,
      cache: scopedCache({
        backend: emptyBackend,
        encryptionKey: CACHE_KEY,
        authorize: () => true,
      }),
      checkpoint: "FRESH_EMPTY_PREWARM",
    })).resolves.toMatchObject({ source: "POSTGRES", mainState: "rebuilt" });
    expect(emptyBackend.stats().writes).toBe(0);
    const emptyChecks = await fresh.query<{
      readonly source_high_water: string;
      readonly record_count: number;
      readonly high_water_count: number;
    }>(
      `select source_high_water,record_count,high_water_count
       from cache_rebuild_category_checks order by category`,
    );
    expect(emptyChecks).toHaveLength(CACHE_REQUIRED_CATEGORIES.length);
    expect(emptyChecks.every((row) => (
      row.source_high_water === "e0" && row.record_count === 0 && row.high_water_count === 0
    ))).toBe(true);

    const partial = await openTestDb();
    await commitBroadcast({ db: partial }, {
      mainStateVersion: 9_100_001,
      body: "A partial database has only canonical Main and broadcast authority.",
      sourceIds: ["market:AAPL:partial-cache"],
      idempotencyKey: "cache-partial-main-broadcast",
    });
    const partialManifest = await createPostgresProjectionSource(partial)
      .readManifest("PARTIAL_MAIN_BROADCAST");
    expect(partialManifest.categories.map((category) => ({
      category: category.category,
      count: category.recordCount,
      highWater: category.sourceHighWater,
    }))).toEqual([
      { category: "MAIN_STATE", count: 1, highWater: expect.stringMatching(/^e[1-9][0-9]*$/) },
      { category: "BROADCASTS", count: 1, highWater: expect.stringMatching(/^e[1-9][0-9]*$/) },
      { category: "NODE_DOSSIERS", count: 0, highWater: "e0" },
      { category: "NODE_HANDOFFS", count: 0, highWater: "e0" },
      { category: "CHALLENGE", count: 0, highWater: "e0" },
    ]);
    await expect(rebuildPostgresCache({
      db: partial,
      cache: scopedCache({
        backend: new MemoryCacheBackend(), encryptionKey: CACHE_KEY, authorize: () => true,
      }),
      checkpoint: "PARTIAL_MAIN_BROADCAST_REBUILD",
    })).resolves.toMatchObject({ source: "POSTGRES", mainState: "rebuilt" });
  }, 60_000);

  it("stages canonical ingestion atomically without idle history rescans", async () => {
    const cursorDb = await openTestDb();
    const canonicalFillers = Array.from({ length: 5 }, (_, index) => ({
      aggregateId: randomUUID(),
      actor: { type: "SYSTEM" as const, id: "cache-cursor-test" },
      type: "node.reply.routed",
      visibility: "SHARED" as const,
      body: { index },
      idempotencyKey: `cache-cursor-canonical:${index}`,
      policyVersion: "cache-test-v1",
    }));
    const fillerEvents = await appendEvents(cursorDb, canonicalFillers);
    const broadcast = await commitBroadcast({ db: cursorDb }, {
      mainStateVersion: 9_200_001,
      body: "Canonical cursor processing remains bounded and strictly keyset ordered.",
      sourceIds: ["market:MSFT:cache-cursor"],
      idempotencyKey: "cache-cursor-broadcast",
    });

    const first = await synchronizeCanonicalCacheJobs(cursorDb, { limit: 2 });
    expect(first).toMatchObject({ scanned: 2, backfilled: 0, backlog: true });
    let latest = first;
    while (latest.backlog) {
      latest = await synchronizeCanonicalCacheJobs(cursorDb, { limit: 2 });
    }
    expect((await cursorDb.one<{ readonly count: number }>(
      "select count(*)::int count from cache_outbox_staging where processed_at is not null",
    )).count).toBe(6);
    expect((await cursorDb.one<{ readonly count: number }>(
      `select count(*)::int count from cache_projection_jobs
       where source_kind='TRANSACTIONAL_OUTBOX' and event_id=$1`,
      [broadcast.commitEventId],
    )).count).toBe(2);

    const legacySequence = await cursorDb.one<{ readonly ingested_sequence: string }>(
      "select ingested_sequence::text from events where id=$1",
      [fillerEvents[0]!.id],
    );
    await cursorDb.query("delete from cache_outbox_staging where event_id=$1", [fillerEvents[0]!.id]);
    await cursorDb.query(
      `update cache_outbox_backfill_state
       set boundary_ingested_sequence=$1,last_ingested_sequence=$1::bigint-1,completed=false
       where singleton=true`,
      [legacySequence.ingested_sequence],
    );
    await expect(synchronizeCanonicalCacheJobs(cursorDb, { limit: 2 })).resolves.toMatchObject({
      inserted: 0, scanned: 1, backfilled: 1,
    });

    const idleSql: string[] = [];
    const idle = await synchronizeCanonicalCacheJobs(observeSql(cursorDb, idleSql), { limit: 2 }) as typeof latest;
    expect(idle).toMatchObject({ inserted: 0, scanned: 0, backlog: false });
    const poll = idleSql.find((sql) => sql.includes("cache-canonical-outbox-poll"));
    expect(poll).toMatch(/from cache_outbox_staging staged[\s\S]*processed_at is null/iu);
    expect(poll).not.toMatch(/ingested_sequence\s*>/iu);
    expect(idleSql.some((sql) => sql.includes("cache-canonical-outbox-backfill"))).toBe(false);

    const late = await commitBroadcast({ db: cursorDb }, {
      mainStateVersion: 9_200_002,
      body: "A late canonical row is processed strictly after the durable cursor.",
      sourceIds: ["market:MSFT:cache-cursor-late"],
      idempotencyKey: "cache-cursor-broadcast-late",
    });
    const lateSync = await synchronizeCanonicalCacheJobs(cursorDb, { limit: 2 }) as typeof latest;
    expect(lateSync).toMatchObject({ scanned: 1, inserted: 2, backlog: false });
    expect((await cursorDb.one<{ readonly count: number }>(
      "select count(*)::int count from cache_projection_jobs where event_id=$1",
      [late.commitEventId],
    )).count).toBe(2);

    const retry = await commitBroadcast({ db: cursorDb }, {
      mainStateVersion: 9_200_003,
      body: "A failed job insert must roll the canonical cursor back for an exact retry.",
      sourceIds: ["market:MSFT:cache-cursor-retry"],
      idempotencyKey: "cache-cursor-broadcast-retry",
    });
    await expect(synchronizeCanonicalCacheJobs({
      ...cursorDb,
      transaction: (work) => cursorDb.transaction(async (transaction) => work({
        ...transaction,
        async query(sql, parameters) {
          if (sql.includes("insert into cache_projection_jobs")) {
            throw new Error("CACHE_TEST_JOB_INSERT_FAILED");
          }
          return transaction.query(sql, parameters);
        },
      })),
    }, { limit: 2 })).rejects.toThrow("CACHE_TEST_JOB_INSERT_FAILED");
    expect((await cursorDb.one<{ readonly processed: boolean }>(
      "select processed_at is not null processed from cache_outbox_staging where event_id=$1",
      [retry.commitEventId],
    )).processed).toBe(false);
    await expect(synchronizeCanonicalCacheJobs(cursorDb, { limit: 2 })).resolves.toMatchObject({
      scanned: 1, inserted: 2, backlog: false,
    });
    expect((await cursorDb.one<{ readonly count: number }>(
      "select count(*)::int count from cache_projection_jobs where event_id=$1",
      [retry.commitEventId],
    )).count).toBe(2);

    await cursorDb.transaction(async (transaction) => {
      await transaction.query("set local enable_seqscan=off");
      const plan = await transaction.query<{ readonly "QUERY PLAN": unknown }>(
        `explain (format json)
         select outbox_id from cache_outbox_staging where processed_at is null
         order by event_ingested_sequence,outbox_id limit 100`,
      );
      expect(JSON.stringify(plan)).toMatch(/cache_outbox_staging_pending_idx/iu);
    });
  }, 60_000);

  it("keeps trusted publication separate from live actor-scoped protected reads and revocation", async () => {
    process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = primaryEventRootKey;
    const runtimeModule = await import("../../lib/server/cache/runtime");
    expect(runtimeModule).toHaveProperty("createPostgresCacheAccess");
    const createAccess = (runtimeModule as unknown as {
      readonly createPostgresCacheAccess: (input: {
        readonly db: TestDatabase;
        readonly backend: MemoryCacheBackend;
        readonly encryptionKey: Buffer;
      }) => {
        readonly publisher: ReturnType<typeof scopedCache>;
        readerFor(actor: {
          readonly accountId: string;
          readonly nodeBrainId: string;
          readonly conversationId: string;
        }): ReturnType<typeof scopedCache>;
      };
    }).createPostgresCacheAccess;
    const fixture = await createProtectedCacheProjectionFixture();
    const source = createPostgresProjectionSource(db);
    const handoff = await source.loadChange(fixture.packetEventId, {
      topic: "node.handoff.packet.refreshed", category: "NODE_HANDOFFS", maxRows: 1_000,
    });
    if (handoff.action !== "PREWARM") throw new Error("CACHE_PROTECTED_HANDOFF_NOT_PREWARMED");
    const dossier = await source.loadChange(fixture.routeEventId, {
      topic: "node.reply.routed", category: "NODE_DOSSIERS", maxRows: 1_000,
    });
    if (dossier.action !== "PREWARM") throw new Error("CACHE_PROTECTED_DOSSIER_NOT_PREWARMED");
    const unrelatedConversation = await db.one<{ readonly conversation_id: string }>(
      "select id::text conversation_id from conversations where account_id=$1",
      [accountId],
    );
    const unrelated = await source.loadChange(staleRoutingEventId, {
      topic: "node.reply.routed", category: "NODE_DOSSIERS", maxRows: 1_000,
    });
    if (unrelated.action !== "PREWARM") throw new Error("CACHE_UNRELATED_DOSSIER_NOT_PREWARMED");
    const backend = new MemoryCacheBackend();
    const access = createAccess({ db, backend, encryptionKey: CACHE_KEY });
    expect(access.publisher).not.toHaveProperty("getCurrent");
    for (const change of [handoff, dossier, unrelated]) {
      await access.publisher.publish({
        pointerKey: cachePointerKey(change.record.key),
        versionKey: cacheKey(change.record.key),
        versionOrdinal: change.record.versionOrdinal,
        value: change.record.value,
        options: { ttlSeconds: 60, encrypted: true },
      });
    }
    const owner = access.readerFor({
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
    });
    expect(owner).toHaveProperty("get");
    expect(owner).toHaveProperty("getCurrent");
    expect(owner).toHaveProperty("readThrough");
    expect(owner).toHaveProperty("metrics");
    for (const forbidden of ["set", "publish", "invalidate", "flushAll", "localSize"]) {
      expect(owner).not.toHaveProperty(forbidden);
    }
    await expect(owner.getCurrent(cachePointerKey(handoff.record.key))).resolves.toMatchObject({
      kind: "NODE_HANDOFF", accountId: fixture.accountId,
    });
    await expect(owner.getCurrent(cachePointerKey(dossier.record.key))).resolves.toMatchObject({
      kind: "NODE_DOSSIER", accountId: fixture.accountId,
    });

    await synchronizeCanonicalCacheJobs(db, { limit: 10_000 });
    await db.query(
      `update cache_projection_jobs set status='COMPLETED',completed_at=clock_timestamp()
       where status in ('PENDING','RETRY_SCHEDULED')`,
    );
    await revokeDisclosureAuthorization({ db }, {
      accountId: fixture.accountId,
      authorizationId: fixture.disclosure.id,
      idempotencyKey: "cache-runtime-reader-disclosure-revoke",
    });
    const synced = await synchronizeCanonicalCacheJobs(db, { limit: 10_000 }) as Readonly<{
      inserted: number;
    }>;
    expect(synced.inserted).toBeGreaterThan(0);
    const beforeDenied = backend.stats();
    await expect(owner.getCurrent(cachePointerKey(handoff.record.key))).resolves.toBeNull();
    expect(backend.stats().reads).toBe(beforeDenied.reads);

    let processed = 0;
    while (processed < 10) {
      const result = await runPostgresCacheWorkerOnce({
        db,
        cache: access.publisher,
        workerId: "cache-authority-invalidation",
        leaseMs: 5_000,
        maxAttempts: 3,
      });
      if (result === "IDLE") break;
      processed += 1;
    }
    expect((await db.one<{ readonly count: number }>(
      `select count(*)::int count from cache_projection_jobs
       where topic='proposal.disclosure.revoked' and category='NODE_HANDOFFS'
         and status='COMPLETED'`,
    )).count).toBeGreaterThan(0);

    await db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [fixture.accountId]);
    const authoritySync = await synchronizeCanonicalCacheJobs(db, { limit: 10_000 });
    expect(authoritySync.inserted).toBeGreaterThanOrEqual(2);
    const beforeAuthorityDenial = backend.stats();
    await expect(owner.getCurrent(cachePointerKey(dossier.record.key))).resolves.toBeNull();
    expect(backend.stats().reads).toBe(beforeAuthorityDenial.reads);
    processed = 0;
    while (processed < 10) {
      const result = await runPostgresCacheWorkerOnce({
        db,
        cache: access.publisher,
        workerId: "cache-live-authority-invalidation",
        leaseMs: 5_000,
        maxAttempts: 3,
      });
      if (result === "IDLE") break;
      processed += 1;
    }
    expect((await db.one<{ readonly count: number }>(
      `select count(*)::int count from cache_projection_jobs job
       join cache_authority_changes authority on authority.event_id=job.event_id
       where job.topic='cache.authority.entitlement.changed'
         and job.category in ('NODE_DOSSIERS','NODE_HANDOFFS') and job.status='COMPLETED'
         and authority.account_id=$1 and authority.node_brain_id=$2
         and authority.conversation_id=$3`,
      [fixture.accountId, fixture.nodeBrainId, fixture.conversationId],
    )).count).toBe(2);

    const unrelatedReader = access.readerFor({
      accountId,
      nodeBrainId,
      conversationId: unrelatedConversation.conversation_id,
    });
    await expect(unrelatedReader.getCurrent(cachePointerKey(unrelated.record.key)))
      .resolves.toMatchObject({ kind: "NODE_DOSSIER", accountId });

    await db.query("update accounts set status='SUSPENDED' where id=$1", [fixture.accountId]);
    await db.query("update node_brains set status='PAUSED' where id=$1", [fixture.nodeBrainId]);
    await db.query("update conversations set status='ARCHIVED' where id=$1", [fixture.conversationId]);
    const authorityTopics = await db.query<{ readonly topic: string }>(
      `select distinct topic from cache_authority_changes where account_id=$1 order by topic`,
      [fixture.accountId],
    );
    expect(authorityTopics.map(({ topic }) => topic)).toEqual(expect.arrayContaining([
      "cache.authority.account.changed",
      "cache.authority.entitlement.changed",
      "cache.authority.node.changed",
      "cache.authority.conversation.changed",
    ]));
  }, 90_000);

  it("resolves current Main by authoritative version across out-of-order events and total cache loss", async () => {
    const mainDb = await openTestDb();
    const newer = await commitBroadcast({ db: mainDb }, {
      mainStateVersion: 9_300_100,
      body: "Version one hundred is the current canonical Main state.",
      sourceIds: ["market:AAPL:main-v100"],
      idempotencyKey: "cache-main-out-of-order-v100",
    });
    const older = await commitBroadcast({ db: mainDb }, {
      mainStateVersion: 9_300_099,
      body: "Version ninety-nine arrived later but cannot roll Main back.",
      sourceIds: ["market:AAPL:main-v99"],
      idempotencyKey: "cache-main-out-of-order-v99",
    });
    const source = createPostgresProjectionSource(mainDb);
    const manifest = await source.readManifest("MAIN_OUT_OF_ORDER");
    const page = await source.readPage({ checkpoint: manifest.checkpoint, afterId: null, limit: 100 });
    const current = page.records.find(({ value }) => value.kind === "MAIN_STATE")!;
    expect(current.value).toMatchObject({
      kind: "MAIN_STATE",
      mainStateVersion: "9300100",
      sourceEventIds: [newer.commitEventId],
    });
    expect(current.versionOrdinal).toBe("9300100");

    const incremental = await source.loadChange(older.commitEventId, {
      topic: "main.broadcast.committed", category: "MAIN_STATE", maxRows: 1_000,
    });
    expect(incremental).toMatchObject({
      action: "PREWARM",
      record: { versionOrdinal: "9300100", value: { mainStateVersion: "9300100" } },
    });

    const backend = new MemoryCacheBackend();
    const cache = scopedCache({ backend, encryptionKey: CACHE_KEY, authorize: () => true });
    await cache.flushAll();
    await rebuildPostgresCache({ db: mainDb, cache, checkpoint: "MAIN_TOTAL_CACHE_LOSS" });
    await expect(cache.getCurrent(cachePointerKey(current.key))).resolves.toMatchObject({
      kind: "MAIN_STATE", mainStateVersion: "9300100",
    });
  }, 60_000);

  it("does not skip a low-ingestion outbox row that commits after a higher row is synchronized", async () => {
    const commitDb = await openTestDb();
    let releaseLow!: () => void;
    let lowReady!: () => void;
    const release = new Promise<void>((resolve) => { releaseLow = resolve; });
    const ready = new Promise<void>((resolve) => { lowReady = resolve; });
    let lowEventId = "";
    const lowCommit = commitDb.transaction(async (transaction) => {
      const low = await commitBroadcast({ db: transaction }, {
        mainStateVersion: 9_400_001,
        body: "The lower ingestion sequence remains durable across commit inversion.",
        sourceIds: ["market:AAPL:commit-inversion-low"],
        idempotencyKey: "cache-commit-inversion-low",
      });
      lowEventId = low.commitEventId;
      lowReady();
      await release;
    });
    await ready;
    const high = await commitBroadcast({ db: commitDb }, {
      mainStateVersion: 9_400_002,
      body: "The higher ingestion sequence commits while the lower transaction is held.",
      sourceIds: ["market:AAPL:commit-inversion-high"],
      idempotencyKey: "cache-commit-inversion-high",
    });
    await synchronizeCanonicalCacheJobs(commitDb, { limit: 100 });
    releaseLow();
    await lowCommit;
    await synchronizeCanonicalCacheJobs(commitDb, { limit: 100 });
    const counts = await commitDb.query<{ readonly event_id: string; readonly count: number }>(
      `select event_id::text,count(*)::int count from cache_projection_jobs
       where event_id=any($1::uuid[]) group by event_id order by event_id`,
      [[lowEventId, high.commitEventId]],
    );
    expect(new Map(counts.map((row) => [row.event_id, row.count]))).toEqual(new Map([
      [lowEventId, 2],
      [high.commitEventId, 2],
    ]));
  }, 60_000);

  it("excludes more than one thousand unrelated rows from commit inversion and legacy backfill", async () => {
    const canonicalDb = await openTestDb();
    let releaseLow!: () => void;
    let lowReady!: () => void;
    const release = new Promise<void>((resolve) => { releaseLow = resolve; });
    const ready = new Promise<void>((resolve) => { lowReady = resolve; });
    let lowEventId = "";
    const lowCommit = canonicalDb.transaction(async (transaction) => {
      const low = await commitBroadcast({ db: transaction }, {
        mainStateVersion: 9_410_001,
        body: "A held canonical event remains independent of unrelated outbox volume.",
        sourceIds: ["market:AAPL:canonical-filter-low"],
        idempotencyKey: "cache-canonical-filter-low",
      });
      lowEventId = low.commitEventId;
      lowReady();
      await release;
    });
    await ready;
    let high!: Awaited<ReturnType<typeof commitBroadcast>>;
    try {
      await insertUnrelatedOutboxRows(canonicalDb, 1_001, "cache-noise-between-commits");
      high = await commitBroadcast({ db: canonicalDb }, {
        mainStateVersion: 9_410_002,
        body: "The visible canonical event is not delayed by unrelated outbox rows.",
        sourceIds: ["market:AAPL:canonical-filter-high"],
        idempotencyKey: "cache-canonical-filter-high",
      });
      await expect(synchronizeCanonicalCacheJobs(canonicalDb, { limit: 1 })).resolves.toMatchObject({
        scanned: 1, inserted: 2, backfilled: 0, backlog: false,
      });
      expect((await canonicalDb.one<{ readonly count: number }>(
        "select count(*)::int count from cache_outbox_staging",
      )).count).toBe(1);
    } finally {
      releaseLow();
      await lowCommit;
    }
    await expect(synchronizeCanonicalCacheJobs(canonicalDb, { limit: 1 })).resolves.toMatchObject({
      scanned: 1, inserted: 2, backfilled: 0, backlog: false,
    });
    const highSequence = await canonicalDb.one<{ readonly sequence: string }>(
      "select ingested_sequence::text sequence from events where id=$1",
      [high.commitEventId],
    );

    await insertUnrelatedOutboxRows(canonicalDb, 1_001, "cache-noise-before-legacy");
    const legacyFirst = await commitBroadcast({ db: canonicalDb }, {
      mainStateVersion: 9_410_003,
      body: "The first legacy canonical event owns the bounded page.",
      sourceIds: ["market:AAPL:canonical-filter-legacy-first"],
      idempotencyKey: "cache-canonical-filter-legacy-first",
    });
    await insertUnrelatedOutboxRows(canonicalDb, 1_001, "cache-noise-between-legacy");
    const legacySecond = await commitBroadcast({ db: canonicalDb }, {
      mainStateVersion: 9_410_004,
      body: "The second legacy canonical event follows without unrelated scanning.",
      sourceIds: ["market:AAPL:canonical-filter-legacy-second"],
      idempotencyKey: "cache-canonical-filter-legacy-second",
    });
    const legacyBoundary = await canonicalDb.one<{ readonly sequence: string }>(
      "select ingested_sequence::text sequence from events where id=$1",
      [legacySecond.commitEventId],
    );
    await canonicalDb.query(
      `delete from cache_outbox_staging staged using events event
       where event.id=staged.event_id and event.ingested_sequence>$1`,
      [highSequence.sequence],
    );
    await canonicalDb.query(
      `update cache_outbox_backfill_state
       set boundary_ingested_sequence=$1,last_ingested_sequence=$2,completed=false
       where singleton=true`,
      [legacyBoundary.sequence, highSequence.sequence],
    );
    await expect(synchronizeCanonicalCacheJobs(canonicalDb, { limit: 1 })).resolves.toMatchObject({
      scanned: 1, inserted: 2, backfilled: 1, backlog: true,
    });
    await expect(synchronizeCanonicalCacheJobs(canonicalDb, { limit: 1 })).resolves.toMatchObject({
      scanned: 1, inserted: 2, backfilled: 1, backlog: false,
    });
    const staged = await canonicalDb.one<{
      readonly total: number; readonly unrelated: number;
    }>(
      `select count(*)::int total,
              count(*) filter (where topic='cache.test.unrelated')::int unrelated
       from cache_outbox_staging`,
    );
    expect(staged).toEqual({ total: 4, unrelated: 0 });
    const counts = await canonicalDb.query<{ readonly event_id: string; readonly count: number }>(
      `select event_id::text,count(*)::int count from cache_projection_jobs
       where event_id=any($1::uuid[]) group by event_id`,
      [[lowEventId, high.commitEventId, legacyFirst.commitEventId, legacySecond.commitEventId]],
    );
    expect(counts).toHaveLength(4);
    expect(counts.every(({ count }) => count === 2)).toBe(true);
  }, 60_000);

  it("does not skip an authority row whose transaction commits after a higher authority row", async () => {
    const authorityDb = await openTestDb();
    const main = await commitBroadcast({ db: authorityDb }, {
      mainStateVersion: 9_500_001,
      body: "Authority inversion uses two independent protected topologies.",
      sourceIds: ["market:AAPL:authority-inversion"],
      idempotencyKey: "cache-authority-inversion-main",
    });
    const low = await createConversationFixture("Authority inversion low", authorityDb);
    const high = await createConversationFixture("Authority inversion high", authorityDb);
    for (const [fixture, label] of [[low, "low"], [high, "high"]] as const) {
      const message = await appendMessage(fixture, {
        role: "USER",
        text: `Authority inversion ${label} completed evidence.`,
        idempotencyKey: `cache-authority-inversion-message:${label}`,
      });
      await routeNodeReply({
        db: authorityDb,
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId,
        userMessageEventId: message.eventId,
        coveredByMain: true,
        contradiction: false,
        materialEvidence: false,
        confidence: 0.9,
        mainStateVersion: String(main.mainStateVersion),
        sourceIds: [message.eventId, main.commitEventId],
      }, async () => undefined);
    }
    await synchronizeCanonicalCacheJobs(authorityDb, { limit: 1_000 });

    let releaseLow!: () => void;
    let lowReady!: () => void;
    const release = new Promise<void>((resolve) => { releaseLow = resolve; });
    const ready = new Promise<void>((resolve) => { lowReady = resolve; });
    const lowCommit = authorityDb.transaction(async (transaction) => {
      await transaction.query("update accounts set status='SUSPENDED' where id=$1", [low.accountId]);
      lowReady();
      await release;
    });
    await ready;
    await authorityDb.query("update accounts set status='SUSPENDED' where id=$1", [high.accountId]);
    await synchronizeCanonicalCacheJobs(authorityDb, { limit: 100 });
    releaseLow();
    await lowCommit;
    await synchronizeCanonicalCacheJobs(authorityDb, { limit: 100 });
    const counts = await authorityDb.query<{ readonly account_id: string; readonly count: number }>(
      `select authority.account_id::text,count(*)::int count
       from cache_projection_jobs job
       join cache_authority_changes authority on authority.event_id=job.event_id
       where authority.account_id=any($1::uuid[])
       group by authority.account_id order by authority.account_id`,
      [[low.accountId, high.accountId]],
    );
    expect(new Map(counts.map((row) => [row.account_id, row.count]))).toEqual(new Map([
      [low.accountId, 1],
      [high.accountId, 1],
    ]));
  }, 60_000);

  it("keeps canonical Main provenance stable and persists record source separately from its trigger", async () => {
    const provenanceDb = await openTestDb();
    const first = await commitBroadcast({ db: provenanceDb }, {
      mainStateVersion: 9_600_100,
      body: "The first canonical source for this Main version is stable.",
      sourceIds: ["market:AAPL:main-provenance-first"],
      idempotencyKey: "cache-main-provenance-first",
    });
    await commitBroadcast({ db: provenanceDb }, {
      mainStateVersion: 9_600_100,
      body: "A repeated broadcast cannot rewrite canonical Main provenance.",
      sourceIds: ["market:AAPL:main-provenance-repeat"],
      idempotencyKey: "cache-main-provenance-repeat",
    });
    const firstSource = createPostgresProjectionSource(provenanceDb);
    const firstManifest = await firstSource.readManifest("MAIN_PROVENANCE_FIRST");
    const firstPage = await firstSource.readPage({
      checkpoint: firstManifest.checkpoint, afterId: null, limit: 100,
    });
    expect(firstPage.records.find(({ value }) => value.kind === "MAIN_STATE")?.value)
      .toMatchObject({ sourceEventIds: [first.commitEventId] });
    const restarted = createPostgresProjectionSource(provenanceDb);
    const restartedManifest = await restarted.readManifest("MAIN_PROVENANCE_RESTARTED");
    const restartedPage = await restarted.readPage({
      checkpoint: restartedManifest.checkpoint, afterId: null, limit: 100,
    });
    expect(restartedPage.records.find(({ value }) => value.kind === "MAIN_STATE")?.value)
      .toMatchObject({ sourceEventIds: [first.commitEventId] });

    const current = await commitBroadcast({ db: provenanceDb }, {
      mainStateVersion: 9_600_101,
      body: "The newer Main version has its own stable canonical source.",
      sourceIds: ["market:AAPL:main-provenance-current"],
      idempotencyKey: "cache-main-provenance-current",
    });
    await synchronizeCanonicalCacheJobs(provenanceDb, { limit: 1_000 });
    const cache = scopedCache({
      backend: new MemoryCacheBackend(), encryptionKey: CACHE_KEY, authorize: () => true,
    });
    await expect(processNextCacheJob({
      repository: createPostgresCacheJobRepository(provenanceDb, { categories: ["MAIN_STATE"] }),
      source: createPostgresProjectionSource(provenanceDb),
      cache,
      workerId: "cache-main-provenance-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
    })).resolves.toBe("COMPLETED");
    const persisted = await provenanceDb.one<{
      readonly trigger_event_id: string;
      readonly record_source_event_id: string;
    }>(
      `select job.event_id::text trigger_event_id,
              version.source_event_id::text record_source_event_id
       from cache_projection_versions version
       join cache_projection_jobs job on job.id=version.job_id
       where version.category='MAIN_STATE' order by version.id limit 1`,
    );
    expect(persisted.trigger_event_id).not.toBe(current.commitEventId);
    expect(persisted.record_source_event_id).toBe(current.commitEventId);
  }, 60_000);
});
