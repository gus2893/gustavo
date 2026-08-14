import { readFileSync } from "node:fs";
import type { EventDatabase, JsonValue } from "../../lib/server/events/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROADCAST_EVALUATOR_RUBRIC,
  BRIDGE_JOB_RETENTION_DAYS,
  BRIDGE_JOB_LEASE_MINUTES,
  BRIDGE_JOB_KINDS,
  BRIDGE_JOB_ROLES,
  BRIDGE_JOB_STATUSES,
  BRIDGE_ROLE_PRIORITIES,
  BRIDGE_SAFE_TERMINAL_CODES,
  claimNextBridgeJob,
  commitAcceptedEvaluatorBridgeJob,
  completeBridgeJob,
  DEPLOYMENT_QUOTA_NAMES,
  HYBRID_WORKER_COMPONENTS,
  HYBRID_WORKER_SAFE_CODES,
  HYBRID_WORKER_STATUSES,
  MARKET_PROVIDER_STATUSES,
  MARKET_QUOTE_SAFE_CODES,
  MARKET_QUOTE_STATUSES,
  MARKET_SYMBOL_KINDS,
  MARKET_WINDOW_SAFE_CODES,
  MARKET_WINDOW_STATUSES,
  failBridgeJob,
  stageMainCandidateAndEvaluator,
  validateMainGenerationAuthority,
  type BridgeCallerFailureCode,
  type MarketLatestQuoteRow,
  type MarketPollWindowRow,
  type HybridWorkerHeartbeatRow,
} from "../../lib/server/bridge/jobs";
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import {
  appendEvent,
  readEventBody,
  rewrapAggregateDataKey,
} from "../../lib/server/events/store";
import { appendMessage, listMessages } from "../../lib/server/history/messages";
import { forgetConversation } from "../../lib/server/memory/forget";
import type {
  ModelGenerationRequest,
  ModelGenerationResult,
} from "../../lib/server/models/types";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import { openDueBroadcastCycles } from "../../lib/server/main-brain/schedules";
import {
  executeEvaluatorBridgeJob,
  executeMainBridgeJob,
  parseHybridModelJsonOutput,
} from "../../worker/hybrid/runtime";
import { createConversationFixture, type ConversationFixture } from "../helpers/postgres";

const routeState = vi.hoisted(() => ({
  db: undefined as EventDatabase | undefined,
  clientConfigs: [] as unknown[],
  publishJSON: vi.fn(),
}));

vi.mock("../../lib/server/db/postgres", () => ({
  getDatabase(): EventDatabase {
    if (!routeState.db) throw new Error("TEST_DATABASE_NOT_READY");
    return routeState.db;
  },
}));

vi.mock("@upstash/qstash", async (importOriginal) => {
  const original = await importOriginal<typeof import("@upstash/qstash")>();
  return {
    ...original,
    Client: class {
      constructor(config: unknown) {
        routeState.clientConfigs.push(config);
      }

      publishJSON(input: unknown): Promise<unknown> {
        return routeState.publishJSON(input) as Promise<unknown>;
      }
    },
  };
});

import { POST } from "../../app/api/conversations/[conversationId]/messages/route";

const EXPECTED_STOCKS = "AAPL, MSFT, NVDA, AMZN, GOOGL, GOOG, META, TSLA, BRK.B, AVGO, JPM, LLY, V, XOM, MA, UNH, COST, WMT, NFLX, ORCL, HD, PG, JNJ, BAC, ABBV, KO, CRM, CVX, MRK, AMD, PLTR, CSCO, ACN, MCD, IBM, GE, CAT, GS, MS, AXP, BX, TMO, ISRG, LIN, ABT, DIS, NOW, QCOM, TXN, AMGN, DHR, PEP, PM, INTU, BKNG, RTX, AMAT, SPGI, NEE, LOW, UPS, HON, PFE, C, MU, SBUX, COP, SCHW, GILD, ADP, DE, BLK, PANW, LRCX, KLAC".split(", ");
const EXPECTED_ETFS = "SPY, QQQ, DIA, IWM, VTI, VO, VB, VOO, IVV, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, ARKK".split(", ");
const FORBIDDEN_JOB_FIELDS = ["prompt", "body", "output", "ciphertext"] as const;
const FORBIDDEN_MARKET_FIELDS = ["price", "quote", "body", "plaintext"] as const;

afterEach(() => {
  vi.useRealTimers();
  routeState.db = undefined;
  routeState.clientConfigs.length = 0;
  routeState.publishJSON.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function forbiddenFieldIntersection(
  row: Readonly<Record<string, unknown>>,
  forbidden: readonly string[],
): readonly string[] {
  return Object.freeze(Object.keys(row).filter((key) => forbidden.includes(key)).sort());
}

function generationResult(output: string): ModelGenerationResult {
  return {
    runId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    output,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostMicrousd: 1n,
      providerMetering: {
        status: "REPORTED",
        inputTokens: 1,
        outputTokens: 1,
      },
    },
  };
}

function evaluatorAuthority(
  candidateEventId = "candidate-event",
): {
  readonly cycleId: string;
  readonly candidateEventId: string;
  readonly prompt: string;
  readonly rubricVersion: typeof BROADCAST_EVALUATOR_RUBRIC.version;
  readonly rubricDigest: string;
  readonly rubricCriteria: readonly string[];
} {
  return {
    cycleId: "cycle-1",
    candidateEventId,
    prompt: "authorized rubric",
    rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
    rubricDigest: BROADCAST_EVALUATOR_RUBRIC.digest,
    rubricCriteria: BROADCAST_EVALUATOR_RUBRIC.criteria,
  };
}

async function createForgedCandidateStateFixture(
  id: string,
  mainStateVersion = 2,
  insertEvaluator = true,
) {
  const fixture = await createConversationFixture(`bridge-forged-candidate-${id}`);
  const scheduleId = `bridge-forged-state-${id}`;
  await fixture.db.query(
    `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
     values ($1,'0 14 * * *','UTC',true,$2)`,
    [scheduleId, "2026-08-13T13:59:00.000Z"],
  );
  const [cycle] = await openDueBroadcastCycles(
    { db: fixture.db },
    new Date("2026-08-13T14:00:00.000Z"),
  );
  if (!cycle) throw new Error("EXPECTED_BROADCAST_CYCLE");
  const generation = await fixture.db.one<{
    readonly correlation_id: string;
    readonly integrity_hash: string;
    readonly policy_version: string;
    readonly request_hash: string;
  }>(
    `select correlation_id::text,integrity_hash::text,policy_version,request_hash::text
     from events where id=$1`,
    [cycle.openEventId],
  );
  const candidate = await appendEvent(fixture.db, {
    aggregateId: cycle.id,
    actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
    type: "main.broadcast.candidate.generated",
    visibility: "SHARED",
    body: {
      candidate: "AAPL is testing completed support.",
      cycleId: cycle.id,
      editorialPolicyVersion: generation.policy_version,
      generationEventId: cycle.openEventId,
      generationIntegrityHash: generation.integrity_hash,
      generationRequestHash: generation.request_hash,
      mainStateVersion,
      policyVersion: generation.policy_version,
      snapshotDigest: canonicalContentDigest(cycle.snapshot),
      sourceIds: cycle.snapshot.marketData.highWaterId === null
        ? [] : [cycle.snapshot.marketData.highWaterId],
    },
    idempotencyKey: `forged-candidate-state-${id}`,
    causationId: cycle.openEventId,
    correlationId: generation.correlation_id,
    policyVersion: generation.policy_version,
  });
  if (insertEvaluator) {
    const parent = await claimNextBridgeJob(fixture.db, {
      workerId: `forged-parent-${id}`,
      now: new Date(),
    });
    if (!parent || parent.role !== "MAIN") throw new Error("EXPECTED_PARENT_MAIN_JOB");
    await fixture.db.query(
      `update bridge_model_jobs
       set status='COMPLETED',lease_owner=null,lease_expires_at=null,
           output_event_id=$2,safe_code=null
       where job_id=$1 and status='CLAIMED'`,
      [parent.jobId, candidate.id],
    );
    await fixture.db.query(
      `insert into bridge_model_jobs (
         source_event_id,cycle_id,candidate_event_id,parent_main_job_id,
         role,kind,priority,request_digest
       ) values (
         $1,$2,$1,$3,'EVALUATOR','EVALUATOR_REVIEW',10,
         bridge_model_job_request_digest($1,'EVALUATOR','EVALUATOR_REVIEW')
       )`,
      [candidate.id, cycle.id, parent.jobId],
    );
  }
  return { fixture, cycle, candidate };
}

async function createNoncanonicalGenerationFixture(id: string) {
  const fixture = await createConversationFixture(`bridge-forged-generation-${id}`);
  const cycleId = crypto.randomUUID();
  const scheduleId = `bridge-forged-generation-${id}`;
  const slotAt = "2026-08-13T14:00:00.000Z";
  const snapshot = {
    mainStateVersion: null,
    policyVersion: "main-broadcast-policy-v1",
    marketData: { highWaterId: null, observedAt: null },
  };
  await fixture.db.query(
    `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
     values ($1,'0 14 * * *','UTC',true,$2)`,
    [scheduleId, "2026-08-13T13:59:00.000Z"],
  );
  const generation = await appendEvent(fixture.db, {
    aggregateId: cycleId,
    actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
    type: "main.broadcast.generation.requested",
    visibility: "SHARED",
    body: {
      author: { type: "MAIN_BRAIN", id: "gustavo-main" },
      scheduleId,
      scheduleVersion: 1,
      slotAt,
      snapshot,
      unexpected: "must reject",
    },
    idempotencyKey: `forged-generation-body-${id}`,
    occurredAt: new Date(slotAt),
    policyVersion: "main-broadcast-policy-v1",
  });
  await fixture.db.query(
    `insert into broadcast_cycles (
       id,schedule_id,schedule_version,slot_at,author_type,author_id,
       main_state_version,policy_version,snapshot,open_event_id,opened_at
     ) values (
       $1,$2,1,$3,'MAIN_BRAIN','gustavo-main',
       null,'main-broadcast-policy-v1',$4::jsonb,$5,$6
     )`,
    [cycleId, scheduleId, slotAt, JSON.stringify(snapshot), generation.id, generation.occurredAt],
  );
  return { fixture, cycleId };
}

function observeHybridTransactionScopes(
  database: EventDatabase,
  sourceEventId: string,
): {
  readonly db: EventDatabase;
  readonly authorityScopes: Array<number | null>;
  readonly bodyScopes: Array<number | null>;
} {
  const authorityScopes: Array<number | null> = [];
  const bodyScopes: Array<number | null> = [];
  let nextScope = 0;
  const wrap = (current: EventDatabase, scope: number | null): EventDatabase => ({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> {
      if (sql.includes("hybrid-node-hydration-authority")) authorityScopes.push(scope);
      if (
        sql.includes("from events where id=any($1::uuid[])")
        && Array.isArray(parameters?.[0])
        && parameters[0].includes(sourceEventId)
      ) {
        bodyScopes.push(scope);
      }
      return current.query<Row>(sql, parameters);
    },
    one: (sql, parameters) => current.one(sql, parameters),
    transaction: (work) => current.transaction((transaction) => {
      const transactionScope = scope ?? ++nextScope;
      return work(wrap(transaction, transactionScope));
    }),
  });
  return { db: wrap(database, null), authorityScopes, bodyScopes };
}

function observeHybridAuthorityTransactions(database: EventDatabase): {
  readonly db: EventDatabase;
  readonly steps: string[];
  readonly outputEventScopes: Array<number | null>;
  readonly completionScopes: Array<number | null>;
} {
  const steps: string[] = [];
  const outputEventScopes: Array<number | null> = [];
  const completionScopes: Array<number | null> = [];
  let nextScope = 0;
  const markers = [
    "hybrid-node-hydration-authority",
    "hybrid-source-key-lock",
    "hybrid-source-body-lock",
    "hybrid-node-hydration-revalidate",
    "hybrid-node-output-authority",
    "hybrid-output-key-lock",
    "hybrid-output-body-lock",
    "hybrid-node-output-revalidate",
  ];
  const wrap = (current: EventDatabase, scope: number | null): EventDatabase => ({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> {
      for (const marker of markers) {
        if (sql.includes(marker)) steps.push(marker);
      }
      if (
        sql.includes("insert into transactional_outbox")
        && parameters?.includes("brain.response.completed")
      ) {
        outputEventScopes.push(scope);
      }
      if (
        sql.includes("update bridge_model_jobs")
        && sql.includes("set status='COMPLETED'")
      ) {
        completionScopes.push(scope);
      }
      return current.query<Row>(sql, parameters);
    },
    one: (sql, parameters) => current.one(sql, parameters),
    transaction: (work) => current.transaction((transaction) => {
      const transactionScope = scope ?? ++nextScope;
      return work(wrap(transaction, transactionScope));
    }),
  });
  return {
    db: wrap(database, null),
    steps,
    outputEventScopes,
    completionScopes,
  };
}

function pauseAfterStatement(database: EventDatabase, marker: string): {
  readonly db: EventDatabase;
  readonly reached: Promise<void>;
  readonly release: () => void;
} {
  let reached!: () => void;
  let release!: () => void;
  let paused = false;
  const atStatement = new Promise<void>((resolve) => { reached = resolve; });
  const continueStatement = new Promise<void>((resolve) => { release = resolve; });
  const wrap = (current: EventDatabase): EventDatabase => ({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> {
      const rows = await current.query<Row>(sql, parameters);
      if (!paused && sql.includes(marker)) {
        paused = true;
        reached();
        await continueStatement;
      }
      return rows;
    },
    one: (sql, parameters) => current.one(sql, parameters),
    transaction: (work) => current.transaction((transaction) => work(wrap(transaction))),
  });
  return { db: wrap(database), reached: atStatement, release };
}

function signalBeforeStatement(database: EventDatabase, marker: string): {
  readonly db: EventDatabase;
  readonly reached: Promise<void>;
} {
  let reached!: () => void;
  let signaled = false;
  const atStatement = new Promise<void>((resolve) => { reached = resolve; });
  const wrap = (current: EventDatabase): EventDatabase => ({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> => {
      if (!signaled && sql.includes(marker)) {
        signaled = true;
        reached();
      }
      return current.query<Row>(sql, parameters);
    },
    one: (sql, parameters) => current.one(sql, parameters),
    transaction: (work) => current.transaction((transaction) => work(wrap(transaction))),
  });
  return { db: wrap(database), reached: atStatement };
}

async function bounded<T>(promise: Promise<T>, milliseconds = 8_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("BOUNDED_CONCURRENCY_TIMEOUT")), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function forgetOwner(fixture: ConversationFixture) {
  return {
    kind: "ACCOUNT_OWNER" as const,
    accountId: fixture.accountId,
    sessionId: fixture.sessionId,
    capability: "FORGET_CONVERSATION" as const,
  };
}

async function expireClaimedBridgeLease(
  db: ConversationFixture["db"],
  jobId: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.query(
      "alter table bridge_model_jobs disable trigger bridge_model_jobs_are_semantically_immutable",
    );
    await transaction.query(
      `update bridge_model_jobs
          set updated_at=created_at,
              lease_expires_at=created_at+interval '1 millisecond'
        where job_id=$1`,
      [jobId],
    );
    await transaction.query(
      "alter table bridge_model_jobs enable trigger bridge_model_jobs_are_semantically_immutable",
    );
  });
}

const MARKET_POLL_WINDOW_ROW_CONTRACT = {
  windowId: "2026-08-13T13:30Z",
  windowStartedAt: "2026-08-13T13:30:00.000Z",
  provider: "FINNHUB",
  status: "COMPLETED",
  providerStatus: "OPEN",
  callsUsed: 96,
  resultCount: 95,
  safeCode: null,
  completedAt: "2026-08-13T13:34:45.000Z",
  createdAt: "2026-08-13T13:30:00.000Z",
  updatedAt: "2026-08-13T13:34:45.000Z",
  pruneAfter: "2026-08-20T13:30:00.000Z",
} as const satisfies MarketPollWindowRow;

const MARKET_LATEST_QUOTE_ROW_CONTRACT = {
  accountId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f",
  symbol: "AAPL",
  windowId: "2026-08-13T13:30Z",
  provider: "FINNHUB",
  status: "SUCCESS",
  sourceObservedAt: "2026-08-13T13:30:00.000Z",
  receivedAt: "2026-08-13T13:30:01.000Z",
  dataKeyId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e70",
  ciphertext: new Uint8Array([1]),
  envelopeIv: new Uint8Array(12),
  envelopeAuthTag: new Uint8Array(16),
  envelopeEncoding: "canonical-json-v1",
  contextDigest: "0".repeat(64),
  safeCode: null,
  updatedAt: "2026-08-13T13:30:01.000Z",
} as const satisfies MarketLatestQuoteRow;

const HYBRID_WORKER_HEARTBEAT_ROW_CONTRACT = {
  component: "MARKET",
  status: "DEGRADED",
  safeCode: "RATE_LIMITED",
  observedAt: "2026-08-13T15:30:00.000Z",
  updatedAt: "2026-08-13T15:30:00.000Z",
} as const satisfies HybridWorkerHeartbeatRow;

describe("bridge job authority", () => {
  it("enqueues one body-free Node job for a completed USER message", async () => {
    const fixture = await createConversationFixture("bridge-node-authority");
    const message = await appendMessage(fixture, {
      idempotencyKey: "bridge-user-1",
      role: "USER",
      text: "private operator prompt",
    });
    const jobs = await fixture.db.query<Record<string, unknown>>(
      "select * from bridge_model_jobs where source_event_id=$1",
      [message.eventId],
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ role: "NODE", priority: 0, status: "PENDING" });
    expect(forbiddenFieldIntersection(jobs[0]!, FORBIDDEN_JOB_FIELDS)).toEqual([]);
    await expect(fixture.db.query(
      "update bridge_model_jobs set source_event_id=gen_random_uuid() where source_event_id=$1",
      [message.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_IMMUTABLE/);
  }, 30_000);

  it("stages only completed USER authority and rejects duplicate or forged sources", async () => {
    const fixture = await createConversationFixture("bridge-source-authority");
    const user = await appendMessage(fixture, {
      idempotencyKey: "bridge-source-user",
      role: "USER",
      text: "one durable source",
    });
    await appendMessage(fixture, {
      idempotencyKey: "bridge-source-user",
      role: "USER",
      text: "one durable source",
    });
    const node = await appendMessage(fixture, {
      idempotencyKey: "bridge-source-node",
      role: "NODE",
      text: "not a trigger source",
    });
    const aborted = await appendMessage(fixture, {
      idempotencyKey: "bridge-source-aborted",
      role: "USER",
      text: "not completed",
      completion: {
        status: "ABORTED",
        at: new Date("2026-08-13T12:00:00.000Z"),
        reason: "CANCELLED",
      },
    });

    const jobs = await fixture.db.query<{ readonly source_event_id: string }>(
      "select source_event_id::text from bridge_model_jobs order by created_at,job_id",
    );
    expect(jobs).toEqual([{ source_event_id: user.eventId }]);
    expect(jobs.some(({ source_event_id }) => source_event_id === node.eventId)).toBe(false);
    expect(jobs.some(({ source_event_id }) => source_event_id === aborted.eventId)).toBe(false);

    await expect(fixture.db.query(
      `insert into bridge_model_jobs (
         source_event_id,role,kind,priority,request_digest
       ) select source_event_id,role,kind,priority,request_digest
           from bridge_model_jobs where source_event_id=$1`,
      [user.eventId],
    )).rejects.toThrow(/duplicate key/u);
    await expect(fixture.db.query(
      `insert into bridge_model_jobs (
         source_event_id,role,kind,priority,request_digest
       ) values ($1,'NODE','NODE_REPLY',0,
                 bridge_model_job_request_digest($1,'NODE','NODE_REPLY'))`,
      [aborted.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_SOURCE_AUTHORITY_INVALID/u);
  }, 30_000);

  it("permits only bounded lifecycle fields while preserving job semantics", async () => {
    const fixture = await createConversationFixture("bridge-semantic-immutability");
    const message = await appendMessage(fixture, {
      idempotencyKey: "bridge-semantic-user",
      role: "USER",
      text: "immutable authority",
    });

    await fixture.db.query(
      `update bridge_model_jobs
          set status='CLAIMED',attempt_count=1,lease_owner='local-worker-v1',
              lease_expires_at=clock_timestamp()+interval '5 minutes',
              updated_at=clock_timestamp()
        where source_event_id=$1`,
      [message.eventId],
    );
    await expect(fixture.db.query(
      "update bridge_model_jobs set priority=20 where source_event_id=$1",
      [message.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_IMMUTABLE/u);
    await expect(fixture.db.query(
      "update bridge_model_jobs set request_digest=repeat('0',64) where source_event_id=$1",
      [message.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_IMMUTABLE/u);
    await expect(fixture.db.query(
      "update bridge_model_jobs set status='UNBOUNDED' where source_event_id=$1",
      [message.eventId],
    )).rejects.toThrow();
    await expect(fixture.db.query(
      "delete from bridge_model_jobs where source_event_id=$1",
      [message.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_IMMUTABLE/u);
  }, 30_000);

  it("bounds every claimed lease to fifteen minutes", async () => {
    const fixture = await createConversationFixture("bridge-lease-bound");
    const tooLong = await appendMessage(fixture, {
      idempotencyKey: "bridge-lease-too-long",
      role: "USER",
      text: "reject a lease beyond the bound",
    });

    await expect(fixture.db.query(
      `update bridge_model_jobs job
          set status='CLAIMED',attempt_count=1,lease_owner='local-v1',
              updated_at=transition.at,
              lease_expires_at=transition.at+interval '15 minutes 1 second'
         from (select clock_timestamp() as at) transition
        where job.source_event_id=$1`,
      [tooLong.eventId],
    )).rejects.toThrow(/(?:BRIDGE_JOB_TRANSITION_INVALID|bridge_model_jobs_check)/u);

    const expired = await appendMessage(fixture, {
      idempotencyKey: "bridge-lease-expired",
      role: "USER",
      text: "reject an already expired lease",
    });
    await expect(fixture.db.query(
      `update bridge_model_jobs job
          set status='CLAIMED',attempt_count=1,lease_owner='local-v1',
              updated_at=transition.at,
              lease_expires_at=transition.at-interval '1 second'
         from (select clock_timestamp() as at) transition
        where job.source_event_id=$1`,
      [expired.eventId],
    )).rejects.toThrow(/(?:BRIDGE_JOB_TRANSITION_INVALID|bridge_model_jobs_check)/u);

    const boundary = await appendMessage(fixture, {
      idempotencyKey: "bridge-lease-boundary",
      role: "USER",
      text: "accept the exact lease boundary",
    });
    await expect(fixture.db.query(
      `update bridge_model_jobs job
          set status='CLAIMED',attempt_count=1,lease_owner='local-v1',
              updated_at=transition.at,
              lease_expires_at=transition.at+interval '15 minutes'
         from (select clock_timestamp() as at) transition
        where job.source_event_id=$1`,
      [boundary.eventId],
    )).resolves.toHaveLength(0);

    const beforeNoOp = await fixture.db.one<{ readonly updated_at: Date }>(
      "select updated_at from bridge_model_jobs where source_event_id=$1",
      [boundary.eventId],
    );
    const afterNoOp = await fixture.db.one<{ readonly updated_at: Date }>(
      `update bridge_model_jobs set status=status where source_event_id=$1
       returning updated_at`,
      [boundary.eventId],
    );
    expect(afterNoOp.updated_at.getTime()).toBe(beforeNoOp.updated_at.getTime());

    const terminal = await fixture.db.one<{
      readonly updated_at: Date;
      readonly database_now: Date;
    }>(
      `update bridge_model_jobs
          set status='FAILED',lease_owner=null,lease_expires_at=null,
              safe_code='CODEX_PROCESS_FAILED',updated_at='2099-01-01T00:00:00Z'
        where source_event_id=$1
       returning updated_at,clock_timestamp() database_now`,
      [boundary.eventId],
    );
    expect(terminal.updated_at.getTime()).toBeLessThanOrEqual(terminal.database_now.getTime());

    const retry = await appendMessage(fixture, {
      idempotencyKey: "bridge-lease-retry",
      role: "USER",
      text: "database time owns retry transitions",
    });
    await fixture.db.query(
      `update bridge_model_jobs
          set status='CLAIMED',attempt_count=1,lease_owner='local-v1',
              lease_expires_at=clock_timestamp()+interval '25 milliseconds'
        where source_event_id=$1`,
      [retry.eventId],
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const retried = await fixture.db.one<{
      readonly updated_at: Date;
      readonly database_now: Date;
    }>(
      `update bridge_model_jobs
          set status='CLAIMED',attempt_count=2,lease_owner='local-v2',
              lease_expires_at=clock_timestamp()+interval '5 minutes',
              updated_at='2099-01-01T00:00:00Z'
        where source_event_id=$1
       returning updated_at,clock_timestamp() database_now`,
      [retry.eventId],
    );
    expect(retried.updated_at.getTime()).toBeLessThanOrEqual(retried.database_now.getTime());
  }, 30_000);

  it("rejects a caller-shifted transition timestamp that extends the lease", async () => {
    const fixture = await createConversationFixture("bridge-lease-caller-clock");
    const message = await appendMessage(fixture, {
      idempotencyKey: "bridge-lease-caller-clock",
      role: "USER",
      text: "database time owns the lease",
    });

    await expect(fixture.db.query(
      `update bridge_model_jobs job
          set status='CLAIMED',attempt_count=1,lease_owner='local-v1',
              updated_at=transition.at+interval '1 minute',
              lease_expires_at=transition.at+interval '16 minutes'
         from (select clock_timestamp() as at) transition
        where job.source_event_id=$1`,
      [message.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_TRANSITION_INVALID/u);
  }, 30_000);

  it("prevents terminal market-window rollback and counter decreases", async () => {
    const fixture = await createConversationFixture("bridge-window-lifecycle");
    const window = await fixture.db.one<{ readonly window_id: string }>(
      `with timing as (
         select date_trunc('hour',clock_timestamp())
              + floor(extract(minute from clock_timestamp())/5)*interval '5 minutes'
                window_started_at
       )
       insert into market_poll_windows (window_id,window_started_at)
       select to_char(window_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI"Z"'),
              window_started_at
         from timing
       returning window_id`,
    );
    const progress = await fixture.db.one<{
      readonly updated_at: Date;
      readonly database_now: Date;
    }>(
      `update market_poll_windows
          set status='PENDING',provider_status='OPEN',calls_used=2,
              result_count=1,updated_at='2099-01-01T00:00:00Z'
        where window_id=$1
       returning updated_at,clock_timestamp() database_now`,
      [window.window_id],
    );
    expect(progress.updated_at.getTime()).toBeLessThanOrEqual(progress.database_now.getTime());
    await expect(fixture.db.query(
      `update market_poll_windows set calls_used=1 where window_id=$1`,
      [window.window_id],
    )).rejects.toThrow(/MARKET_POLL_WINDOW_TRANSITION_INVALID/u);
    await fixture.db.query(
      `update market_poll_windows
          set status='COMPLETED',provider_status='OPEN',calls_used=96,
              result_count=95,completed_at=clock_timestamp(),updated_at=clock_timestamp()
        where window_id=$1`,
      [window.window_id],
    );

    await expect(fixture.db.query(
      `update market_poll_windows
          set status='PENDING',provider_status='UNKNOWN',calls_used=0,
              result_count=0,safe_code=null,completed_at=null,
              updated_at=clock_timestamp()
        where window_id=$1`,
      [window.window_id],
    )).rejects.toThrow(/MARKET_POLL_WINDOW_TRANSITION_INVALID/u);
  }, 30_000);

  it("defines bounded terminal bridge-job pruning without weakening live jobs", async () => {
    const fixture = await createConversationFixture("bridge-job-pruning");
    const eligibility = await fixture.db.one<{
      readonly old_terminal: boolean;
      readonly recent_terminal: boolean;
      readonly old_pending: boolean;
    }>(
      `select
         bridge_model_job_is_prunable(
           'COMPLETED',timestamptz '2026-08-01T00:00:00Z',
           timestamptz '2026-08-09T00:00:00Z'
         ) old_terminal,
         bridge_model_job_is_prunable(
           'FAILED',timestamptz '2026-08-08T00:00:00Z',
           timestamptz '2026-08-09T00:00:00Z'
         ) recent_terminal,
         bridge_model_job_is_prunable(
           'PENDING',timestamptz '2026-08-01T00:00:00Z',
           timestamptz '2026-08-09T00:00:00Z'
         ) old_pending`,
    );
    expect(eligibility).toEqual({
      old_terminal: true,
      recent_terminal: false,
      old_pending: false,
    });
    const indexes = await fixture.db.query<{ readonly indexname: string }>(
      `select indexname from pg_indexes
        where schemaname=current_schema() and tablename='bridge_model_jobs'`,
    );
    expect(indexes.map(({ indexname }) => indexname)).toContain(
      "bridge_model_jobs_terminal_retention_idx",
    );

    const pending = await appendMessage(fixture, {
      idempotencyKey: "bridge-prune-pending",
      role: "USER",
      text: "pending rows are retained",
    });
    await expect(fixture.db.query(
      "delete from bridge_model_jobs where source_event_id=$1",
      [pending.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_IMMUTABLE/u);

    const recent = await appendMessage(fixture, {
      idempotencyKey: "bridge-prune-recent",
      role: "USER",
      text: "recent terminal rows are retained",
    });
    await fixture.db.query(
      `update bridge_model_jobs
          set status='CLAIMED',attempt_count=1,lease_owner='local-v1',
              lease_expires_at=clock_timestamp()+interval '5 minutes'
        where source_event_id=$1`,
      [recent.eventId],
    );
    await fixture.db.query(
      `update bridge_model_jobs
          set status='FAILED',lease_owner=null,lease_expires_at=null,
              safe_code='CODEX_PROCESS_FAILED'
        where source_event_id=$1`,
      [recent.eventId],
    );
    await expect(fixture.db.query(
      "delete from bridge_model_jobs where source_event_id=$1",
      [recent.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_IMMUTABLE/u);
  }, 30_000);

  it("keeps catalog, heartbeat, quota, and latest-quote authority bounded", async () => {
    const fixture = await createConversationFixture("bridge-bounded-authority");
    const bridgeColumns = await fixture.db.query<{ readonly column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema=current_schema() and table_name='bridge_model_jobs'`,
    );
    const latestColumns = await fixture.db.query<{ readonly column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema=current_schema() and table_name='market_latest_quotes'`,
    );
    const catalog = await fixture.db.query<{ readonly symbol: string; readonly kind: string }>(
      "select symbol,kind from market_symbol_catalog order by ordinal",
    );
    const authorityTables = await fixture.db.query<{ readonly table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema=current_schema() and table_name=any($1::text[])
        order by table_name`,
      [[
        "bridge_model_jobs",
        "bridge_wake_receipts",
        "deployment_quota_counters",
        "hybrid_worker_heartbeats",
        "market_latest_quotes",
        "market_poll_windows",
        "market_symbol_catalog",
      ]],
    );

    expect(bridgeColumns.map(({ column_name }) => column_name)).not.toEqual(
      expect.arrayContaining(["prompt", "body", "output", "ciphertext"]),
    );
    const latestColumnRecord = Object.fromEntries(
      latestColumns.map(({ column_name }) => [column_name, null]),
    );
    expect(forbiddenFieldIntersection(latestColumnRecord, FORBIDDEN_MARKET_FIELDS)).toEqual([]);
    expect(catalog).toHaveLength(95);
    expect(catalog.filter(({ kind }) => kind === "STOCK").map(({ symbol }) => symbol))
      .toEqual(EXPECTED_STOCKS);
    expect(catalog.filter(({ kind }) => kind === "ETF").map(({ symbol }) => symbol))
      .toEqual(EXPECTED_ETFS);
    expect(authorityTables.map(({ table_name }) => table_name)).toEqual([
      "bridge_model_jobs",
      "bridge_wake_receipts",
      "deployment_quota_counters",
      "hybrid_worker_heartbeats",
      "market_latest_quotes",
      "market_poll_windows",
      "market_symbol_catalog",
    ]);

    await expect(fixture.db.query(
      "insert into hybrid_worker_heartbeats(component,status) values ('HOSTNAME','HEALTHY')",
    )).rejects.toThrow();
    await expect(fixture.db.query(
      "insert into hybrid_worker_heartbeats(component,status) values ('CODEX','UNBOUNDED')",
    )).rejects.toThrow();
    await expect(fixture.db.query(
      `insert into deployment_quota_counters
         (quota_name,bucket_date,used_count,limit_count)
       values ('PAID_FALLBACK',(clock_timestamp() at time zone 'UTC')::date,0,1)`,
    )).rejects.toThrow();
    await expect(fixture.db.query(
      `insert into deployment_quota_counters
         (quota_name,bucket_date,used_count,limit_count)
       values ('CODEX_JOBS',(clock_timestamp() at time zone 'UTC')::date,0,101)`,
    )).rejects.toThrow();
    await expect(fixture.db.query(
      "insert into market_symbol_catalog(ordinal,symbol,kind) values (96,'PAYW','STOCK')",
    )).rejects.toThrow(/IMMUTABLE_MARKET_SYMBOL_CATALOG/u);

    await fixture.db.query(
      `insert into market_poll_windows (
         window_id,window_started_at,status,provider_status,calls_used,
         result_count,completed_at,safe_code
       ) values (
         '2026-08-13T13:30Z','2026-08-13T13:30:00Z','COMPLETED','CLOSED',
         1,95,'2026-08-13T13:30:01Z','MARKET_CLOSED'
       )`,
    );
    await expect(fixture.db.query(
      `insert into market_latest_quotes (
         account_id,symbol,window_id,provider,status,received_at,context_digest,safe_code
       ) values (
         $1,'PAYW','2026-08-13T13:30Z','FINNHUB','UNAVAILABLE',
         '2026-08-13T13:30:01Z',
         market_latest_context_digest($1,'PAYW','2026-08-13T13:30Z','FINNHUB'),
         'SYMBOL_UNAVAILABLE'
       )`,
      [fixture.accountId],
    )).rejects.toThrow();
  }, 30_000);

  it("keeps every deployment authority row free of forbidden plaintext fields", async () => {
    const fixture = await createConversationFixture("bridge-row-leakage");
    const message = await appendMessage(fixture, {
      idempotencyKey: "bridge-row-leakage",
      role: "USER",
      text: "protected source text",
    });
    await fixture.db.query(
      `insert into bridge_wake_receipts (
         message_id,body_digest,published_at
       ) values ('wake-row-leakage',repeat('0',64),clock_timestamp()-interval '1 second')`,
    );
    await fixture.db.query(
      "insert into hybrid_worker_heartbeats (component,status) values ('TUNNEL','HEALTHY')",
    );
    const poll = await fixture.db.one<{ readonly window_id: string }>(
      `with timing as (
         select date_trunc('hour',clock_timestamp())
              + floor(extract(minute from clock_timestamp())/5)*interval '5 minutes'
                window_started_at
       )
       insert into market_poll_windows (
         window_id,window_started_at,status,provider_status,calls_used,
         result_count,safe_code,completed_at
       ) select
         to_char(window_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI"Z"'),
         window_started_at,'COMPLETED','CLOSED',1,95,'MARKET_CLOSED',
         clock_timestamp()
       from timing
       returning window_id`,
    );
    await fixture.db.query(
      `insert into market_latest_quotes (
         account_id,symbol,window_id,provider,status,received_at,context_digest,safe_code
       ) values (
         $1,'AAPL',$2,'FINNHUB','UNAVAILABLE',clock_timestamp(),
         market_latest_context_digest($1,'AAPL',$2,'FINNHUB'),'MARKET_CLOSED'
       )`,
      [fixture.accountId, poll.window_id],
    );
    await fixture.db.query(
      `insert into deployment_quota_counters (
         quota_name,bucket_date,used_count,limit_count
       ) values ('CODEX_JOBS',(clock_timestamp() at time zone 'UTC')::date,0,100)`,
    );

    const rows = [
      [await fixture.db.one<Record<string, unknown>>(
        "select * from bridge_model_jobs where source_event_id=$1",
        [message.eventId],
      ), FORBIDDEN_JOB_FIELDS],
      [await fixture.db.one<Record<string, unknown>>(
        "select * from bridge_wake_receipts where message_id='wake-row-leakage'",
      ), [...FORBIDDEN_JOB_FIELDS, ...FORBIDDEN_MARKET_FIELDS]],
      [await fixture.db.one<Record<string, unknown>>(
        "select * from hybrid_worker_heartbeats where component='TUNNEL'",
      ), [...FORBIDDEN_JOB_FIELDS, ...FORBIDDEN_MARKET_FIELDS]],
      [await fixture.db.one<Record<string, unknown>>(
        "select * from market_poll_windows where window_id=$1",
        [poll.window_id],
      ), [...FORBIDDEN_JOB_FIELDS, ...FORBIDDEN_MARKET_FIELDS]],
      [await fixture.db.one<Record<string, unknown>>(
        "select * from market_latest_quotes where account_id=$1 and symbol='AAPL'",
        [fixture.accountId],
      ), FORBIDDEN_MARKET_FIELDS],
      [await fixture.db.one<Record<string, unknown>>(
        `select * from deployment_quota_counters
          where quota_name='CODEX_JOBS'
            and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
      ), [...FORBIDDEN_JOB_FIELDS, ...FORBIDDEN_MARKET_FIELDS]],
      [await fixture.db.one<Record<string, unknown>>(
        "select * from market_symbol_catalog where symbol='AAPL'",
      ), [...FORBIDDEN_JOB_FIELDS, ...FORBIDDEN_MARKET_FIELDS]],
    ] as const;
    for (const [row, forbidden] of rows) {
      expect(forbiddenFieldIntersection(row, forbidden)).toEqual([]);
    }
    expect(forbiddenFieldIntersection(
      { ciphertext: new Uint8Array([1]) },
      FORBIDDEN_JOB_FIELDS,
    )).toEqual(["ciphertext"]);
  }, 30_000);

  it("bounds latest quote encrypted payloads", async () => {
    const fixture = await createConversationFixture("bridge-envelope-bound");
    const marketKeyId = crypto.randomUUID();
    await fixture.db.query(
      `insert into aggregate_data_keys (
         id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
       ) values (
         $1,'market-latest:'||$2::text,1,decode('00','hex'),
         decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex')
       )`,
      [marketKeyId, fixture.accountId],
    );
    await fixture.db.query(
      `insert into market_poll_windows (
         window_id,window_started_at,status,provider_status,calls_used,
         result_count,completed_at
       ) values (
         '2026-08-13T15:30Z','2026-08-13T15:30:00Z','COMPLETED','OPEN',
         96,95,'2026-08-13T15:34:45Z'
       )`,
    );

    await expect(fixture.db.query(
      `insert into market_latest_quotes (
         account_id,symbol,window_id,provider,status,source_observed_at,received_at,
         data_key_id,ciphertext,envelope_iv,envelope_auth_tag,envelope_encoding,
         context_digest
       ) values (
         $1,'AAPL','2026-08-13T15:30Z','FINNHUB','SUCCESS',
         '2026-08-13T15:30:00Z','2026-08-13T15:30:01Z',$2,
         decode(repeat('00',65537),'hex'),decode(repeat('00',12),'hex'),
         decode(repeat('00',16),'hex'),'canonical-json-v1',
         market_latest_context_digest($1,'AAPL','2026-08-13T15:30Z','FINNHUB')
       )`,
      [fixture.accountId, marketKeyId],
    )).rejects.toThrow();
  }, 30_000);

  it("prevents catalog truncation", async () => {
    const fixture = await createConversationFixture("bridge-catalog-truncate");
    await expect(fixture.db.query(
      "truncate market_symbol_catalog cascade",
    )).rejects.toThrow(/IMMUTABLE_MARKET_SYMBOL_CATALOG/u);
  }, 30_000);

  it("prevents truncation of every mutable deployment authority table", async () => {
    const fixture = await createConversationFixture("bridge-authority-truncate");
    const statements = [
      "truncate bridge_model_jobs",
      "truncate bridge_wake_receipts",
      "truncate deployment_quota_counters",
      "truncate hybrid_worker_heartbeats",
      "truncate market_latest_quotes",
      "truncate market_latest_quotes,market_poll_windows",
    ] as const;

    for (const sql of statements) {
      await expect(fixture.db.query(sql)).rejects.toThrow(
        /IMMUTABLE_DEPLOYMENT_AUTHORITY/u,
      );
    }
  }, 30_000);

  it("uses database receipt time for heartbeats", async () => {
    const fixture = await createConversationFixture("bridge-heartbeat-time");
    const stored = await fixture.db.one<{
      readonly observed_at: Date;
      readonly updated_at: Date;
      readonly database_now: Date;
    }>(
      `insert into hybrid_worker_heartbeats (
         component,status,safe_code,observed_at
       ) values (
         'CODEX','DEGRADED','QUOTA_EXHAUSTED',clock_timestamp()+interval '5 minutes'
       ) returning observed_at,updated_at,clock_timestamp() database_now`,
    );
    expect(stored.observed_at.getTime()).toBeLessThanOrEqual(stored.database_now.getTime());
    expect(stored.database_now.getTime() - stored.observed_at.getTime()).toBeLessThan(2_000);
    expect(stored.updated_at.getTime()).toBe(stored.observed_at.getTime());
  }, 30_000);

  it("accepts RATE_LIMITED as a safe heartbeat state", async () => {
    const fixture = await createConversationFixture("bridge-heartbeat-rate-limited");
    await expect(fixture.db.query(
      `insert into hybrid_worker_heartbeats (component,status,safe_code)
       values ('MARKET','DEGRADED','RATE_LIMITED')`,
    )).resolves.toHaveLength(0);
  }, 30_000);

  it("does not create a redundant exact latest-quote index", async () => {
    const fixture = await createConversationFixture("bridge-index-authority");
    const indexes = await fixture.db.query<{ readonly indexname: string }>(
      `select indexname from pg_indexes
        where schemaname=current_schema() and tablename='market_latest_quotes'`,
    );
    expect(indexes.map(({ indexname }) => indexname)).not.toContain(
      "market_latest_quotes_lookup_idx",
    );
  }, 30_000);

  it("rejects a latest-quote envelope key from another authority", async () => {
    const owner = await createConversationFixture("bridge-latest-owner");
    const other = await createConversationFixture("bridge-latest-other", owner.db);
    await appendMessage(other, {
      idempotencyKey: "bridge-latest-key-source",
      role: "USER",
      text: "create another aggregate key",
    });
    const otherKey = await owner.db.one<{ readonly id: string }>(
      "select id::text from aggregate_data_keys where aggregate_id=$1",
      [other.conversationId],
    );
    await owner.db.query(
      `insert into market_poll_windows (
         window_id,window_started_at,status,provider_status,calls_used,
         result_count,completed_at
       ) values (
         '2026-08-13T14:00Z','2026-08-13T14:00:00Z','COMPLETED','OPEN',
         96,95,'2026-08-13T14:04:45Z'
       )`,
    );

    await expect(owner.db.query(
      `insert into market_latest_quotes (
         account_id,symbol,window_id,provider,status,source_observed_at,received_at,
         data_key_id,ciphertext,envelope_iv,envelope_auth_tag,context_digest
       ) values (
         $1,'AAPL','2026-08-13T14:00Z','FINNHUB','SUCCESS',
         '2026-08-13T14:00:00Z','2026-08-13T14:00:01Z',$2,
         decode('00','hex'),decode(repeat('00',12),'hex'),
         decode(repeat('00',16),'hex'),
         market_latest_context_digest($1,'AAPL','2026-08-13T14:00Z','FINNHUB')
       )`,
      [owner.accountId, otherKey.id],
    )).rejects.toThrow(/MARKET_LATEST_KEY_SCOPE_INVALID/u);
  }, 30_000);

  it("exports frozen SQL-domain mirrors", () => {
    for (const value of [
      BRIDGE_JOB_ROLES,
      BRIDGE_JOB_KINDS,
      BRIDGE_JOB_STATUSES,
      BRIDGE_SAFE_TERMINAL_CODES,
      HYBRID_WORKER_COMPONENTS,
      HYBRID_WORKER_SAFE_CODES,
      HYBRID_WORKER_STATUSES,
      MARKET_WINDOW_STATUSES,
      MARKET_PROVIDER_STATUSES,
      MARKET_WINDOW_SAFE_CODES,
      MARKET_QUOTE_STATUSES,
      MARKET_QUOTE_SAFE_CODES,
      MARKET_SYMBOL_KINDS,
      DEPLOYMENT_QUOTA_NAMES,
      BRIDGE_ROLE_PRIORITIES,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(BRIDGE_ROLE_PRIORITIES).toEqual({ NODE: 0, EVALUATOR: 10, MAIN: 20 });
    expect(BRIDGE_JOB_RETENTION_DAYS).toBe(7);
    expect(BRIDGE_JOB_LEASE_MINUTES).toBe(15);
    expect(HYBRID_WORKER_SAFE_CODES).toEqual([
      "AUTH_REQUIRED",
      "QUOTA_EXHAUSTED",
      "PROVIDER_UNAVAILABLE",
      "RATE_LIMITED",
      "DATABASE_UNAVAILABLE",
      "TUNNEL_UNAVAILABLE",
      "WORKER_OFFLINE",
    ]);
    expect(MARKET_WINDOW_STATUSES).toEqual(["PENDING", "COMPLETED", "FAILED"]);
    expect(HYBRID_WORKER_HEARTBEAT_ROW_CONTRACT.updatedAt)
      .toBe(HYBRID_WORKER_HEARTBEAT_ROW_CONTRACT.observedAt);
    expect(MARKET_POLL_WINDOW_ROW_CONTRACT).toMatchObject({
      provider: "FINNHUB",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(MARKET_LATEST_QUOTE_ROW_CONTRACT.envelopeEncoding)
      .toBe("canonical-json-v1");
  });

  it("mirrors every exported SQL tuple in database constraints", async () => {
    const fixture = await createConversationFixture("bridge-domain-mirrors");
    const definitions = await fixture.db.query<{
      readonly table_name: string;
      readonly definition: string;
    }>(
      `select relation.relname table_name,pg_get_constraintdef(con.oid) definition
         from pg_constraint con
         join pg_class relation on relation.oid=con.conrelid
        where con.connamespace=current_schema()::regnamespace
          and con.conrelid=any($1::regclass[])`,
      [[
        "bridge_model_jobs",
        "deployment_quota_counters",
        "hybrid_worker_heartbeats",
        "market_latest_quotes",
        "market_poll_windows",
        "market_symbol_catalog",
      ]],
    );
    const constraintsFor = (tableName: string): string => definitions
      .filter(({ table_name }) => table_name === tableName)
      .map(({ definition }) => definition)
      .join("\n");
    const domains = [
      ["bridge_model_jobs", [
        BRIDGE_JOB_ROLES,
        BRIDGE_JOB_KINDS,
        BRIDGE_JOB_STATUSES,
        BRIDGE_SAFE_TERMINAL_CODES,
      ]],
      ["hybrid_worker_heartbeats", [
        HYBRID_WORKER_COMPONENTS,
        HYBRID_WORKER_STATUSES,
        HYBRID_WORKER_SAFE_CODES,
      ]],
      ["market_poll_windows", [
        MARKET_WINDOW_STATUSES,
        MARKET_PROVIDER_STATUSES,
        MARKET_WINDOW_SAFE_CODES,
      ]],
      ["market_latest_quotes", [MARKET_QUOTE_STATUSES, MARKET_QUOTE_SAFE_CODES]],
      ["market_symbol_catalog", [MARKET_SYMBOL_KINDS]],
      ["deployment_quota_counters", [DEPLOYMENT_QUOTA_NAMES]],
    ] as const;
    for (const [tableName, tuples] of domains) {
      const sqlDomain = constraintsFor(tableName);
      for (const tuple of tuples) {
        for (const value of tuple) expect(sqlDomain).toContain(`'${value}'`);
      }
    }
  }, 30_000);
});

describe("bridge claiming", () => {
  it("serializes one active job, orders Node/Evaluator/Main, and rejects job 101", async () => {
    const fixture = await createConversationFixture("bridge-claim-order");
    await appendMessage(fixture, { idempotencyKey: "claim-1", role: "USER", text: "one" });
    await appendMessage(fixture, { idempotencyKey: "claim-2", role: "USER", text: "two" });

    expect(BRIDGE_ROLE_PRIORITIES).toEqual({ NODE: 0, EVALUATOR: 10, MAIN: 20 });
    const first = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    const overlapping = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v2",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    expect(first?.role).toBe("NODE");
    expect(overlapping).toBeNull();
    await expect(fixture.db.one(
      `select used_count
         from deployment_quota_counters
        where quota_name='CODEX_JOBS'
          and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    )).resolves.toEqual({ used_count: 1 });

    const capped = await createConversationFixture("bridge-claim-cap");
    await appendMessage(capped, { idempotencyKey: "cap-1", role: "USER", text: "capped" });
    await capped.db.query(
      `insert into deployment_quota_counters (quota_name,bucket_date,used_count,limit_count)
       values ('CODEX_JOBS',(clock_timestamp() at time zone 'UTC')::date,100,100)
       on conflict (quota_name,bucket_date) do update set used_count=100,limit_count=100`,
    );
    const bucket = await capped.db.one<{
      readonly bucket_date: string;
      readonly database_bucket: string;
    }>(
      `select to_char(bucket_date,'YYYY-MM-DD') bucket_date,
              to_char((clock_timestamp() at time zone 'UTC')::date,'YYYY-MM-DD') database_bucket
         from deployment_quota_counters
        where quota_name='CODEX_JOBS'
          and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    );
    expect(bucket.bucket_date).toBe(bucket.database_bucket);
    await expect(claimNextBridgeJob(capped.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:01:00Z"),
    })).rejects.toThrow("CODEX_DAILY_QUOTA_EXHAUSTED");
    await expect(capped.db.one(
      `select status,attempt_count,used_count
         from bridge_model_jobs
         cross join deployment_quota_counters
        where quota_name='CODEX_JOBS'
          and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    )).resolves.toEqual({ status: "PENDING", attempt_count: 0, used_count: 100 });
  }, 30_000);

  it("claims all roles by priority and preserves identity on expired recovery", async () => {
    const fixture = await createConversationFixture("bridge-priority-recovery");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-priority-evaluator','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [evaluatorCycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const parent = await claimNextBridgeJob(fixture.db, {
      workerId: "priority-parent-main",
      now: new Date("2026-08-13T14:00:00.000Z"),
    });
    const evaluator = await stageMainCandidateAndEvaluator(fixture.db, {
      jobId: parent!.jobId,
      workerId: "priority-parent-main",
      attemptCount: parent!.attemptCount,
      cycleId: evaluatorCycle!.id,
      candidate: "AAPL remains near completed support.",
    });
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-priority-main','1 14 * * *','UTC',true,$1)`,
      ["2026-08-13T14:00:00.000Z"],
    );
    const [mainCycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:01:00.000Z"),
    );
    const node = await appendMessage(fixture, {
      idempotencyKey: "priority-node",
      role: "USER",
      text: "node",
    });

    const first = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    expect(first).toMatchObject({ sourceEventId: node.eventId, role: "NODE", attemptCount: 1 });
    await failBridgeJob(fixture.db, {
      jobId: first!.jobId,
      workerId: "local-v1",
      attemptCount: first!.attemptCount,
      safeCode: "CODEX_PROCESS_FAILED",
    });
    const second = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:01:00Z"),
    });
    expect(second).toMatchObject({
      sourceEventId: evaluator.candidateEventId,
      role: "EVALUATOR",
    });
    await failBridgeJob(fixture.db, {
      jobId: second!.jobId,
      workerId: "local-v1",
      attemptCount: second!.attemptCount,
      safeCode: "CODEX_PROCESS_FAILED",
    });
    const third = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:02:00Z"),
    });
    expect(third).toMatchObject({ sourceEventId: mainCycle!.openEventId, role: "MAIN" });
    await failBridgeJob(fixture.db, {
      jobId: third!.jobId,
      workerId: "local-v1",
      attemptCount: third!.attemptCount,
      safeCode: "CODEX_PROCESS_FAILED",
    });

    const recoveryFixture = await createConversationFixture("bridge-expired-recovery");
    const source = await appendMessage(recoveryFixture, {
      idempotencyKey: "recovery-source",
      role: "USER",
      text: "recover",
    });
    const original = await recoveryFixture.db.one<{
      readonly job_id: string;
      readonly request_digest: string;
    }>(
      "select job_id::text,request_digest::text from bridge_model_jobs where source_event_id=$1",
      [source.eventId],
    );
    await recoveryFixture.db.query(
      `update bridge_model_jobs job
          set status='CLAIMED',attempt_count=1,lease_owner='expired-v1',
              updated_at=transition.at,
              lease_expires_at=transition.at+interval '25 milliseconds'
         from (select clock_timestamp() as at) transition
        where job.source_event_id=$1`,
      [source.eventId],
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    const recovered = await claimNextBridgeJob(recoveryFixture.db, {
      workerId: "local-v2",
      now: new Date("2026-08-13T12:03:00Z"),
    });
    expect(recovered).toMatchObject({
      jobId: original.job_id,
      requestDigest: original.request_digest,
      attemptCount: 2,
      leaseOwner: "local-v2",
    });
  }, 30_000);

  it("binds completion to the routed output and replays terminal transitions safely", async () => {
    const fixture = await createConversationFixture("bridge-completion-binding");
    const source = await appendMessage(fixture, {
      idempotencyKey: "completion-source",
      role: "USER",
      text: "source",
    });
    const claim = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    const unbound = await appendMessage(fixture, {
      idempotencyKey: "unbound-output",
      role: "NODE",
      text: "unbound",
    });
    await expect(completeBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      outputEventId: unbound.eventId,
    })).rejects.toThrow("OUTPUT_AUTHORITY_INVALID");

    const routed = await routeNodeReply({
      db: fixture.db,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      userMessageEventId: source.eventId,
      coveredByMain: false,
      contradiction: false,
      materialEvidence: false,
      confidence: 0.9,
      mainStateVersion: "bridge-test-main-v1",
      sourceIds: [source.eventId],
    }, async () => "generated");
    const sourceAuthority = await fixture.db.one<{ readonly correlation_id: string }>(
      "select correlation_id::text from events where id=$1",
      [source.eventId],
    );
    const outputEvent = await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId,
      accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
      type: "brain.response.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: { text: "bound", role: "NODE", completion: { status: "COMPLETED", reason: null } },
      idempotencyKey: "bridge-canonical-bound-output",
      causationId: routed.routingEventId,
      correlationId: sourceAuthority.correlation_id,
    });
    await fixture.db.query(
      `insert into messages (
         event_id,conversation_id,account_id,role,idempotency_key,status,
         occurred_at,completed_at,aborted_at,abort_reason
       ) values ($1,$2,$3,'NODE','bound-output','COMPLETED',$4,$4,null,null)`,
      [outputEvent.id, fixture.conversationId, fixture.accountId, outputEvent.occurredAt],
    );
    const output = { eventId: outputEvent.id } as const;
    const completed = await completeBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      outputEventId: output.eventId,
    });
    expect(completed).toMatchObject({ status: "COMPLETED", outputEventId: output.eventId });
    await expect(completeBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      outputEventId: output.eventId,
    })).resolves.toEqual(completed);
    await expect(completeBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      outputEventId: unbound.eventId,
    })).rejects.toThrow("OUTPUT_AUTHORITY_INVALID");

    const failureFixture = await createConversationFixture("bridge-failure-replay");
    await appendMessage(failureFixture, {
      idempotencyKey: "failure-source",
      role: "USER",
      text: "failure",
    });
    const failureClaim = await claimNextBridgeJob(failureFixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    const failed = await failBridgeJob(failureFixture.db, {
      jobId: failureClaim!.jobId,
      workerId: "local-v1",
      attemptCount: failureClaim!.attemptCount,
      safeCode: "CODEX_TIMEOUT",
    });
    expect(failed).toMatchObject({ status: "FAILED", safeCode: "CODEX_TIMEOUT" });
    await expect(failBridgeJob(failureFixture.db, {
      jobId: failureClaim!.jobId,
      workerId: "local-v1",
      attemptCount: failureClaim!.attemptCount,
      safeCode: "CODEX_TIMEOUT",
    })).resolves.toEqual(failed);
    await expect(failBridgeJob(failureFixture.db, {
      jobId: failureClaim!.jobId,
      workerId: "local-v1",
      attemptCount: failureClaim!.attemptCount,
      safeCode: "SECRET_DATABASE_FAILURE" as BridgeCallerFailureCode,
    })).rejects.toThrow("BRIDGE_SAFE_CODE_INVALID");
  }, 30_000);

  it("rejects routed Node output with a mismatched source correlation", async () => {
    const fixture = await createConversationFixture("bridge-correlation-binding");
    const source = await appendMessage(fixture, {
      idempotencyKey: "correlation-source",
      role: "USER",
      text: "source",
    });
    const claim = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    const routed = await routeNodeReply({
      db: fixture.db,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      userMessageEventId: source.eventId,
      coveredByMain: false,
      contradiction: false,
      materialEvidence: false,
      confidence: 0.9,
      mainStateVersion: "bridge-test-main-v1",
      sourceIds: [source.eventId],
    }, async () => "generated");
    const mismatched = await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId,
      accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
      type: "brain.response.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: {
        text: "wrong correlation",
        role: "NODE",
        completion: { status: "COMPLETED", reason: null },
      },
      idempotencyKey: "bridge-mismatched-correlation-output",
      causationId: routed.routingEventId,
      correlationId: crypto.randomUUID(),
    });
    await fixture.db.query(
      `insert into messages (
         event_id,conversation_id,account_id,role,idempotency_key,status,
         occurred_at,completed_at,aborted_at,abort_reason
       ) values ($1,$2,$3,'NODE','mismatched-correlation-output','COMPLETED',$4,$4,null,null)`,
      [mismatched.id, fixture.conversationId, fixture.accountId, mismatched.occurredAt],
    );

    await expect(completeBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      outputEventId: mismatched.id,
    })).rejects.toThrow("OUTPUT_AUTHORITY_INVALID");
  }, 30_000);

  it.each([
    ["MAIN", "MAIN_GENERATION", 20, "MAIN_BRAIN", "gustavo-main"],
    ["EVALUATOR", "EVALUATOR_REVIEW", 10, "EVALUATOR", "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f"],
  ] as const)("fails %s completion closed until its exact authority exists", async (
    role,
    kind,
    priority,
    actorType,
    actorId,
  ) => {
    const fixture = await createConversationFixture(`bridge-${role.toLowerCase()}-closed`);
    const scheduleId = `bridge-${role.toLowerCase()}-closed`;
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ($1,'0 14 * * *','UTC',true,$2)`,
      [scheduleId, "2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    let claim = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T14:00:00Z"),
    });
    if (role === "EVALUATOR") {
      await stageMainCandidateAndEvaluator(fixture.db, {
        jobId: claim!.jobId,
        workerId: "local-v1",
        attemptCount: claim!.attemptCount,
        cycleId: cycle!.id,
        candidate: "AAPL remains near completed support.",
      });
      claim = await claimNextBridgeJob(fixture.db, {
        workerId: "local-v1",
        now: new Date("2026-08-13T14:01:00Z"),
      });
    }
    expect(claim).toMatchObject({ role, kind, priority });
    const sourceAuthority = await fixture.db.one<{
      readonly aggregate_id: string;
      readonly account_id: string | null;
      readonly correlation_id: string;
    }>(
      "select aggregate_id,account_id,correlation_id::text from events where id=$1",
      [claim!.sourceEventId],
    );
    const output = await appendEvent(fixture.db, {
      aggregateId: sourceAuthority.aggregate_id,
      actor: { type: actorType, id: actorId },
      type: role === "MAIN" ? "bridge.main.output" : "bridge.evaluator.output",
      visibility: "SHARED",
      body: { protected: true },
      idempotencyKey: `bridge-${role.toLowerCase()}-permissive-output`,
      causationId: claim!.sourceEventId,
      correlationId: sourceAuthority.correlation_id,
    });

    await expect(completeBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      outputEventId: output.id,
    })).rejects.toThrow("OUTPUT_AUTHORITY_INVALID");
  }, 30_000);

  it("terminalizes an expired third attempt without charging a fourth job", async () => {
    const fixture = await createConversationFixture("bridge-attempt-exhaustion");
    await appendMessage(fixture, {
      idempotencyKey: "attempt-source",
      role: "USER",
      text: "source",
    });
    const first = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    await expireClaimedBridgeLease(fixture.db, first!.jobId);
    const second = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v2",
      now: new Date("2026-08-13T12:01:00Z"),
    });
    expect(second).toMatchObject({ jobId: first!.jobId, attemptCount: 2 });
    await expireClaimedBridgeLease(fixture.db, second!.jobId);
    const third = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v3",
      now: new Date("2026-08-13T12:02:00Z"),
    });
    expect(third).toMatchObject({ jobId: first!.jobId, attemptCount: 3 });
    await expireClaimedBridgeLease(fixture.db, third!.jobId);

    await expect(claimNextBridgeJob(fixture.db, {
      workerId: "local-v4",
      now: new Date("2026-08-13T12:03:00Z"),
    })).resolves.toBeNull();
    await expect(fixture.db.one(
      `select job.status,job.attempt_count,job.safe_code,quota.used_count
         from bridge_model_jobs job
         join deployment_quota_counters quota
           on quota.quota_name='CODEX_JOBS'
          and quota.bucket_date=(clock_timestamp() at time zone 'UTC')::date
        where job.job_id=$1`,
      [third!.jobId],
    )).resolves.toEqual({
      status: "FAILED",
      attempt_count: 3,
      safe_code: "ATTEMPT_LIMIT_EXHAUSTED",
      used_count: 3,
    });
  }, 30_000);

  it("commits attempt-three exhaustion before a later pending job hits the daily cap", async () => {
    const fixture = await createConversationFixture("bridge-exhaustion-quota-rollback");
    await appendMessage(fixture, {
      idempotencyKey: "exhaustion-first",
      role: "USER",
      text: "first",
    });
    await appendMessage(fixture, {
      idempotencyKey: "exhaustion-second",
      role: "USER",
      text: "second",
    });
    const first = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    await expireClaimedBridgeLease(fixture.db, first!.jobId);
    const secondAttempt = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v2",
      now: new Date("2026-08-13T12:01:00Z"),
    });
    await expireClaimedBridgeLease(fixture.db, secondAttempt!.jobId);
    const thirdAttempt = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v3",
      now: new Date("2026-08-13T12:02:00Z"),
    });
    await expireClaimedBridgeLease(fixture.db, thirdAttempt!.jobId);
    await fixture.db.query(
      `update deployment_quota_counters
          set used_count=100,updated_at=clock_timestamp()
        where quota_name='CODEX_JOBS'
          and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    );

    await expect(claimNextBridgeJob(fixture.db, {
      workerId: "local-v4",
      now: new Date("2026-08-13T12:03:00Z"),
    })).rejects.toThrow("CODEX_DAILY_QUOTA_EXHAUSTED");
    await expect(fixture.db.one(
      `select status,attempt_count,safe_code
         from bridge_model_jobs where job_id=$1`,
      [thirdAttempt!.jobId],
    )).resolves.toEqual({
      status: "FAILED",
      attempt_count: 3,
      safe_code: "ATTEMPT_LIMIT_EXHAUSTED",
    });
    await expect(fixture.db.one(
      `select status,attempt_count
         from bridge_model_jobs
        where job_id<>$1
        order by created_at,job_id limit 1`,
      [thirdAttempt!.jobId],
    )).resolves.toEqual({ status: "PENDING", attempt_count: 0 });
  }, 30_000);

  it("continues once after exhaustion cleanup and claims the next pending job", async () => {
    const fixture = await createConversationFixture("bridge-exhaustion-continues");
    await appendMessage(fixture, {
      idempotencyKey: "cleanup-first",
      role: "USER",
      text: "first",
    });
    const pending = await appendMessage(fixture, {
      idempotencyKey: "cleanup-second",
      role: "USER",
      text: "second",
    });
    const first = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    await expireClaimedBridgeLease(fixture.db, first!.jobId);
    const secondAttempt = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v2",
      now: new Date("2026-08-13T12:01:00Z"),
    });
    await expireClaimedBridgeLease(fixture.db, secondAttempt!.jobId);
    const thirdAttempt = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v3",
      now: new Date("2026-08-13T12:02:00Z"),
    });
    await expireClaimedBridgeLease(fixture.db, thirdAttempt!.jobId);

    const next = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v4",
      now: new Date("2026-08-13T12:03:00Z"),
    });
    expect(next).toMatchObject({
      sourceEventId: pending.eventId,
      attemptCount: 1,
      leaseOwner: "local-v4",
    });
    await expect(fixture.db.one(
      `select status,attempt_count,safe_code
         from bridge_model_jobs where job_id=$1`,
      [thirdAttempt!.jobId],
    )).resolves.toEqual({
      status: "FAILED",
      attempt_count: 3,
      safe_code: "ATTEMPT_LIMIT_EXHAUSTED",
    });
    await expect(fixture.db.one(
      `select used_count
         from deployment_quota_counters
        where quota_name='CODEX_JOBS'
          and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    )).resolves.toEqual({ used_count: 4 });
  }, 30_000);

  it("rejects a forged Node actor outside the source conversation authority", async () => {
    const fixture = await createConversationFixture("bridge-forged-node-actor");
    const source = await appendMessage(fixture, {
      idempotencyKey: "forged-actor-source",
      role: "USER",
      text: "source",
    });
    const claim = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    const sourceAuthority = await fixture.db.one<{ readonly correlation_id: string }>(
      "select correlation_id::text from events where id=$1",
      [source.eventId],
    );
    const forgedNodeId = "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f";
    const forgedRoute = await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId,
      accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: forgedNodeId },
      type: "node.reply.routed",
      visibility: "PRIVATE_ACCOUNT",
      body: { forged: true },
      idempotencyKey: "bridge-forged-node-route",
      causationId: source.eventId,
      correlationId: sourceAuthority.correlation_id,
    });
    const forgedOutput = await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId,
      accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: forgedNodeId },
      type: "brain.response.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: { text: "forged", role: "NODE", completion: { status: "COMPLETED", reason: null } },
      idempotencyKey: "bridge-forged-node-output",
      causationId: forgedRoute.id,
      correlationId: sourceAuthority.correlation_id,
    });
    await fixture.db.query(
      `insert into messages (
         event_id,conversation_id,account_id,role,idempotency_key,status,
         occurred_at,completed_at,aborted_at,abort_reason
       ) values ($1,$2,$3,'NODE','forged-node-output','COMPLETED',$4,$4,null,null)`,
      [forgedOutput.id, fixture.conversationId, fixture.accountId, forgedOutput.occurredAt],
    );

    await expect(completeBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      outputEventId: forgedOutput.id,
    })).rejects.toThrow("OUTPUT_AUTHORITY_INVALID");
  }, 30_000);

  it("reserves attempt-limit exhaustion for expired attempt-three recovery", async () => {
    const fixture = await createConversationFixture("bridge-reserved-exhaustion-code");
    await appendMessage(fixture, {
      idempotencyKey: "reserved-exhaustion-source",
      role: "USER",
      text: "source",
    });
    const claim = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });

    await expect(failBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      safeCode: "ATTEMPT_LIMIT_EXHAUSTED" as BridgeCallerFailureCode,
    })).rejects.toThrow("BRIDGE_SAFE_CODE_INVALID");
    await expect(fixture.db.one(
      "select status,attempt_count,safe_code from bridge_model_jobs where job_id=$1",
      [claim!.jobId],
    )).resolves.toEqual({ status: "CLAIMED", attempt_count: 1, safe_code: null });
  }, 30_000);
});

describe("Main and Evaluator bridge execution", () => {
  it("parses bounded nested JSON with distinct object-local keys", () => {
    expect(parseHybridModelJsonOutput(generationResult(
      '{"left":{"value":1},"right":{"value":2}}',
    ))).toEqual({ left: { value: 1 }, right: { value: 2 } });
  });

  it("rejects model JSON beyond the bounded nesting depth", () => {
    const nested = `${"[".repeat(66)}null${"]".repeat(66)}`;
    expect(() => parseHybridModelJsonOutput(generationResult(nested)))
      .toThrow("HYBRID_MODEL_OUTPUT_INVALID");
  });

  it("rejects model JSON beyond the UTF-8 byte bound", () => {
    const oversized = JSON.stringify({ candidate: "😀".repeat(30_000) });
    expect(oversized.length).toBeLessThan(100_000);
    expect(() => parseHybridModelJsonOutput(generationResult(oversized)))
      .toThrow("HYBRID_MODEL_OUTPUT_INVALID");
  });

  it("fails Main model output with a duplicate candidate key before persistence", async () => {
    const fixture = await createConversationFixture("bridge-main-duplicate-json-key");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-main-duplicate-json-key','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );

    await expect((await import("../../worker/hybrid/runtime")).runOneHybridJob({
      db: fixture.db,
      workerId: "main-duplicate-json-worker",
      generate: vi.fn().mockResolvedValue(generationResult(
        '{"candidate":"first","candidate":"second"}',
      )),
    })).resolves.toMatchObject({
      role: "MAIN",
      status: "FAILED",
      safeCode: "CODEX_OUTPUT_INVALID",
    });
    await expect(fixture.db.one(
      `select count(*)::int count from events
        where aggregate_id=$1 and type='main.broadcast.candidate.generated'`,
      [cycle!.id],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("fails Main model output with an escaped-equivalent candidate key", async () => {
    const fixture = await createConversationFixture("bridge-main-escaped-duplicate-json-key");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-main-escaped-duplicate-json-key','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );

    await expect((await import("../../worker/hybrid/runtime")).runOneHybridJob({
      db: fixture.db,
      workerId: "main-escaped-duplicate-json-worker",
      generate: vi.fn().mockResolvedValue(generationResult(
        '{"candidate":"first","cand\\u0069date":"second"}',
      )),
    })).resolves.toMatchObject({
      role: "MAIN",
      status: "FAILED",
      safeCode: "CODEX_OUTPUT_INVALID",
    });
    await expect(fixture.db.one(
      `select count(*)::int count from events
        where aggregate_id=$1 and type='main.broadcast.candidate.generated'`,
      [cycle!.id],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("fails Evaluator model output with a duplicate decision key before broadcast", async () => {
    const fixture = await createConversationFixture("bridge-evaluator-duplicate-json-key");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-evaluator-duplicate-json-key','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const runtime = await import("../../worker/hybrid/runtime");
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-duplicate-main-worker",
      generate: vi.fn().mockResolvedValue(generationResult(
        JSON.stringify({ candidate: "AAPL remains near completed support." }),
      )),
    });

    await expect(runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-duplicate-json-worker",
      generate: vi.fn().mockResolvedValue(generationResult(
        '{"decision":"REJECT","decision":"ACCEPT","rationaleCode":"SUPPORTED",'
          + `"rubricVersion":"${BROADCAST_EVALUATOR_RUBRIC.version}"}`,
      )),
    })).resolves.toMatchObject({
      role: "EVALUATOR",
      status: "FAILED",
      safeCode: "CODEX_OUTPUT_INVALID",
    });
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle!.id}`],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("fails Evaluator model output with an escaped-equivalent decision key", async () => {
    const fixture = await createConversationFixture(
      "bridge-evaluator-escaped-duplicate-json-key",
    );
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-evaluator-escaped-duplicate-json-key','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const runtime = await import("../../worker/hybrid/runtime");
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-escaped-duplicate-main-worker",
      generate: vi.fn().mockResolvedValue(generationResult(
        JSON.stringify({ candidate: "AAPL remains near completed support." }),
      )),
    });

    await expect(runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-escaped-duplicate-json-worker",
      generate: vi.fn().mockResolvedValue(generationResult(
        '{"decision":"REJECT","dec\\u0069sion":"ACCEPT","rationaleCode":"SUPPORTED",'
          + `"rubricVersion":"${BROADCAST_EVALUATOR_RUBRIC.version}"}`,
      )),
    })).resolves.toMatchObject({
      role: "EVALUATOR",
      status: "FAILED",
      safeCode: "CODEX_OUTPUT_INVALID",
    });
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle!.id}`],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("stages Main through a concurrent cycle-key rewrap without lock inversion", async () => {
    const fixture = await createConversationFixture("bridge-main-rewrap-concurrency");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-main-rewrap-concurrency','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const claimed = await claimNextBridgeJob(fixture.db, {
      workerId: "main-rewrap-worker",
      now: new Date(),
    });
    expect(claimed).toMatchObject({ role: "MAIN", cycleId: cycle!.id });
    const gated = pauseAfterStatement(
      fixture.db,
      "bridge-cycle-key-lock",
    );
    const staging = stageMainCandidateAndEvaluator(gated.db, {
      jobId: claimed!.jobId,
      workerId: "main-rewrap-worker",
      attemptCount: claimed!.attemptCount,
      cycleId: cycle!.id,
      candidate: "AAPL remains near completed support.",
    });
    void staging.catch(() => undefined);
    try {
      await bounded(gated.reached);
      const rewrapping = rewrapAggregateDataKey(fixture.db, cycle!.id, 1);
      void rewrapping.catch(() => undefined);
      const rewrapState = await Promise.race([
        rewrapping.then(() => "completed" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);
      expect(rewrapState).toBe("blocked");
      gated.release();
      const [staged] = await bounded(Promise.all([staging, rewrapping]));
      expect(staged).toEqual({
        candidateEventId: expect.any(String),
        evaluatorJobId: expect.any(String),
      });
    } finally {
      gated.release();
    }
  }, 30_000);

  it("commits Evaluator ACCEPT before concurrent cycle-key deletion without deadlock", async () => {
    const fixture = await createConversationFixture("bridge-evaluator-key-delete-concurrency");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-evaluator-key-delete-concurrency','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const runtime = await import("../../worker/hybrid/runtime");
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-key-delete-main-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({
        candidate: "AAPL remains near completed support.",
      }))),
    });
    const evaluator = await claimNextBridgeJob(fixture.db, {
      workerId: "evaluator-key-delete-worker",
      now: new Date(),
    });
    expect(evaluator).toMatchObject({ role: "EVALUATOR", cycleId: cycle!.id });
    const gated = pauseAfterStatement(fixture.db, "bridge-cycle-key-lock");
    const accepting = commitAcceptedEvaluatorBridgeJob(gated.db, {
      jobId: evaluator!.jobId,
      workerId: "evaluator-key-delete-worker",
      attemptCount: evaluator!.attemptCount,
      cycleId: cycle!.id,
      candidateEventId: evaluator!.candidateEventId!,
      decision: "ACCEPT",
      rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      rubricDigest: BROADCAST_EVALUATOR_RUBRIC.digest,
      rubricCriteria: BROADCAST_EVALUATOR_RUBRIC.criteria,
      rationaleCode: "SUPPORTED",
    });
    void accepting.catch(() => undefined);
    try {
      await bounded(gated.reached);
      const deleting = fixture.db.query(
        "delete from aggregate_data_keys where aggregate_id=$1",
        [cycle!.id],
      );
      void deleting.catch(() => undefined);
      const deletionState = await Promise.race([
        deleting.then(() => "completed" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);
      expect(deletionState).toBe("blocked");
      gated.release();
      const [accepted] = await bounded(Promise.all([accepting, deleting]));
      expect(accepted).toEqual({
        broadcastId: expect.any(String),
        reviewEventId: expect.any(String),
      });
    } finally {
      gated.release();
    }
  }, 30_000);

  it("fails Main staging closed when the cycle key was removed first", async () => {
    const fixture = await createConversationFixture("bridge-main-removed-cycle-key");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-main-removed-cycle-key','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const main = await claimNextBridgeJob(fixture.db, {
      workerId: "main-removed-cycle-key-worker",
      now: new Date(),
    });
    expect(main).toMatchObject({ role: "MAIN", cycleId: cycle!.id });
    await fixture.db.query(
      "delete from aggregate_data_keys where aggregate_id=$1",
      [cycle!.id],
    );

    await expect(stageMainCandidateAndEvaluator(fixture.db, {
      jobId: main!.jobId,
      workerId: "main-removed-cycle-key-worker",
      attemptCount: main!.attemptCount,
      cycleId: cycle!.id,
      candidate: "AAPL remains near completed support.",
    })).rejects.toThrow("MAIN_AUTHORITY_REVOKED");
    await expect(fixture.db.one(
      `select count(*)::int count from events
        where aggregate_id=$1 and type='main.broadcast.candidate.generated'`,
      [cycle!.id],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("fails completed Evaluator replay closed after cycle-key removal", async () => {
    const fixture = await createConversationFixture("bridge-evaluator-replay-removed-cycle-key");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-evaluator-replay-removed-cycle-key','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const runtime = await import("../../worker/hybrid/runtime");
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-replay-key-main-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({
        candidate: "AAPL remains near completed support.",
      }))),
    });
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-replay-key-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({
        decision: "ACCEPT",
        rationaleCode: "SUPPORTED",
        rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      }))),
    });
    const completed = await fixture.db.one<{
      readonly attempt_count: number;
      readonly candidate_event_id: string;
      readonly evaluator_job_id: string;
    }>(
      `select evaluator.attempt_count,
              evaluator.candidate_event_id::text candidate_event_id,
              evaluator.job_id::text evaluator_job_id
         from bridge_model_jobs evaluator
        where evaluator.cycle_id=$1 and evaluator.role='EVALUATOR'`,
      [cycle!.id],
    );
    await fixture.db.query(
      "delete from aggregate_data_keys where aggregate_id=$1",
      [cycle!.id],
    );

    await expect(commitAcceptedEvaluatorBridgeJob(fixture.db, {
      jobId: completed.evaluator_job_id,
      workerId: "evaluator-replay-key-worker",
      attemptCount: completed.attempt_count,
      cycleId: cycle!.id,
      candidateEventId: completed.candidate_event_id,
      decision: "ACCEPT",
      rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      rubricDigest: BROADCAST_EVALUATOR_RUBRIC.digest,
      rubricCriteria: BROADCAST_EVALUATOR_RUBRIC.criteria,
      rationaleCode: "SUPPORTED",
    })).rejects.toThrow("EVALUATOR_REPLAY_CONFLICT");
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle!.id}`],
    )).resolves.toEqual({ count: 1 });
  }, 30_000);

  it("rejects a metadata-valid candidate without exact completed parent Main authority", async () => {
    const { fixture, cycle, candidate } = await createForgedCandidateStateFixture(
      "valid-parentless",
      1,
      false,
    );
    const pendingMain = await fixture.db.one<{ readonly job_id: string }>(
      `select job_id::text from bridge_model_jobs
       where cycle_id=$1 and role='MAIN' and status='PENDING'`,
      [cycle.id],
    );

    let inserted = true;
    try {
      await fixture.db.query(
        `insert into bridge_model_jobs (
           source_event_id,cycle_id,candidate_event_id,parent_main_job_id,
           role,kind,priority,request_digest
         ) values (
           $1,$2,$1,$3,'EVALUATOR','EVALUATOR_REVIEW',10,
           bridge_model_job_request_digest($1,'EVALUATOR','EVALUATOR_REVIEW')
         )`,
        [candidate.id, cycle.id, pendingMain.job_id],
      );
    } catch {
      inserted = false;
    }
    const main = await claimNextBridgeJob(fixture.db, {
      workerId: "parentless-main-worker",
      now: new Date(),
    });
    expect(main).toMatchObject({ role: "MAIN", cycleId: cycle.id });
    await failBridgeJob(fixture.db, {
      jobId: main!.jobId,
      workerId: "parentless-main-worker",
      attemptCount: main!.attemptCount,
      safeCode: "SOURCE_AUTHORITY_REVOKED",
    });
    const generate = vi.fn().mockResolvedValue(generationResult(JSON.stringify({
      decision: "ACCEPT",
      rationaleCode: "SUPPORTED",
      rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
    })));
    const runtime = await (await import("../../worker/hybrid/runtime")).runOneHybridJob({
      db: fixture.db,
      workerId: "parentless-evaluator-worker",
      generate,
    });

    expect(inserted).toBe(false);
    expect(runtime).toEqual({ status: "IDLE" });
    expect(generate).not.toHaveBeenCalled();
    await expect(fixture.db.one(
      `select count(*)::int count from bridge_model_jobs
       where role='EVALUATOR' and candidate_event_id=$1`,
      [candidate.id],
    )).resolves.toEqual({ count: 0 });
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle.id}`],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("rejects a forged candidate state before Evaluator generation or broadcast", async () => {
    const { fixture, cycle } = await createForgedCandidateStateFixture("runtime");
    const generate = vi.fn().mockResolvedValue(generationResult(JSON.stringify({
      decision: "ACCEPT",
      rationaleCode: "SUPPORTED",
    })));

    await expect((await import("../../worker/hybrid/runtime")).runOneHybridJob({
      db: fixture.db,
      workerId: "forged-state-worker",
      generate,
    })).resolves.toMatchObject({
      role: "EVALUATOR",
      status: "FAILED",
      safeCode: "SOURCE_AUTHORITY_REVOKED",
    });
    expect(generate).not.toHaveBeenCalled();
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle.id}`],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("revalidates the exact next candidate state inside the ACCEPT transaction", async () => {
    const { fixture, cycle, candidate } = await createForgedCandidateStateFixture("accept-tx");
    const claimed = await claimNextBridgeJob(fixture.db, {
      workerId: "forged-state-accept-worker",
      now: new Date(),
    });
    expect(claimed).toMatchObject({ role: "EVALUATOR", candidateEventId: candidate.id });
    await expect(commitAcceptedEvaluatorBridgeJob(fixture.db, {
      jobId: claimed!.jobId,
      workerId: "forged-state-accept-worker",
      attemptCount: claimed!.attemptCount,
      cycleId: cycle.id,
      candidateEventId: candidate.id,
      decision: "ACCEPT",
      rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      rubricDigest: BROADCAST_EVALUATOR_RUBRIC.digest,
      rubricCriteria: BROADCAST_EVALUATOR_RUBRIC.criteria,
      rationaleCode: "SUPPORTED",
    })).rejects.toThrow("EVALUATOR_CANDIDATE_INVALID");
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle.id}`],
    )).resolves.toEqual({ count: 0 });
    await expect(failBridgeJob(fixture.db, {
      jobId: claimed!.jobId,
      workerId: "forged-state-accept-worker",
      attemptCount: claimed!.attemptCount,
      safeCode: "SOURCE_AUTHORITY_REVOKED",
    })).resolves.toMatchObject({ status: "FAILED", safeCode: "SOURCE_AUTHORITY_REVOKED" });
  }, 30_000);

  it("rejects a noncanonical generation body before Main generation", async () => {
    const { fixture } = await createNoncanonicalGenerationFixture("runtime");
    const generate = vi.fn().mockResolvedValue(generationResult(JSON.stringify({
      candidate: "AAPL is testing completed support.",
    })));

    await expect((await import("../../worker/hybrid/runtime")).runOneHybridJob({
      db: fixture.db,
      workerId: "forged-generation-worker",
      generate,
    })).resolves.toMatchObject({
      role: "MAIN",
      status: "FAILED",
      safeCode: "SOURCE_AUTHORITY_REVOKED",
    });
    expect(generate).not.toHaveBeenCalled();
  }, 30_000);

  it("revalidates the exact generation body inside candidate commit", async () => {
    const { fixture, cycleId } = await createNoncanonicalGenerationFixture("candidate-tx");
    const claimed = await claimNextBridgeJob(fixture.db, {
      workerId: "forged-generation-stage-worker",
      now: new Date(),
    });
    expect(claimed).toMatchObject({ role: "MAIN", cycleId });
    await expect(stageMainCandidateAndEvaluator(fixture.db, {
      jobId: claimed!.jobId,
      workerId: "forged-generation-stage-worker",
      attemptCount: claimed!.attemptCount,
      cycleId,
      candidate: "AAPL is testing completed support.",
    })).rejects.toThrow("MAIN_GENERATION_BODY_INVALID");
    await expect(fixture.db.one(
      `select count(*)::int count from events
       where aggregate_id=$1 and type='main.broadcast.candidate.generated'`,
      [cycleId],
    )).resolves.toEqual({ count: 0 });
    await expect(failBridgeJob(fixture.db, {
      jobId: claimed!.jobId,
      workerId: "forged-generation-stage-worker",
      attemptCount: claimed!.attemptCount,
      safeCode: "SOURCE_AUTHORITY_REVOKED",
    })).resolves.toMatchObject({ status: "FAILED", safeCode: "SOURCE_AUTHORITY_REVOKED" });
  }, 30_000);

  it("binds every canonical generation field and derives exactly the next safe state", () => {
    const snapshot = {
      mainStateVersion: 7,
      policyVersion: "main-broadcast-policy-v1",
      marketData: {
        highWaterId: "market-high-water",
        observedAt: "2026-08-13T13:59:00.000Z",
      },
    };
    const body = {
      author: { type: "MAIN_BRAIN", id: "gustavo-main" },
      scheduleId: "bridge-exact-generation",
      scheduleVersion: 3,
      slotAt: "2026-08-13T14:00:00.000Z",
      snapshot,
    };
    const authority = {
      cycleId: crypto.randomUUID(),
      scheduleId: body.scheduleId,
      scheduleVersion: body.scheduleVersion,
      slotAt: new Date(body.slotAt),
      snapshot,
      currentMainStateVersion: 7,
      policyVersion: "main-broadcast-policy-v1",
      sourceEventId: crypto.randomUUID(),
      sourceRequestHash: "a".repeat(64),
      sourceIntegrityHash: "b".repeat(64),
    };

    expect(validateMainGenerationAuthority(body, authority)).toMatchObject({
      currentMainStateVersion: 7,
      nextMainStateVersion: 8,
      editorialPolicyVersion: "main-broadcast-policy-v1",
      snapshotDigest: canonicalContentDigest(snapshot),
      sourceIds: ["market-high-water"],
    });

    const invalidBodies: readonly JsonValue[] = [
      { ...body, unexpected: true },
      {
        author: body.author,
        scheduleVersion: body.scheduleVersion,
        slotAt: body.slotAt,
        snapshot,
      },
      { ...body, scheduleId: "different" },
      { ...body, scheduleVersion: 4 },
      { ...body, slotAt: "2026-08-13T14:00:00Z" },
      { ...body, snapshot: { ...snapshot, unexpected: true } },
      { ...body, snapshot: { ...snapshot, mainStateVersion: 6 } },
      { ...body, snapshot: { ...snapshot, mainStateVersion: "7" } },
    ];
    for (const invalid of invalidBodies) {
      expect(() => validateMainGenerationAuthority(invalid, authority))
        .toThrow("MAIN_GENERATION_BODY_INVALID");
    }
    const maximumSnapshot = { ...snapshot, mainStateVersion: Number.MAX_SAFE_INTEGER };
    expect(() => validateMainGenerationAuthority({
      ...body,
      snapshot: maximumSnapshot,
    }, {
      ...authority,
      snapshot: maximumSnapshot,
      currentMainStateVersion: Number.MAX_SAFE_INTEGER,
    })).toThrow("MAIN_STATE_AUTHORITY_INVALID");
  });

  it("freezes exact bounded Evaluator rubric criteria and rejects output without its authority", async () => {
    expect(Object.isFrozen(BROADCAST_EVALUATOR_RUBRIC)).toBe(true);
    expect(Object.isFrozen(BROADCAST_EVALUATOR_RUBRIC.criteria)).toBe(true);
    expect(BROADCAST_EVALUATOR_RUBRIC).toMatchObject({
      version: "broadcast-evaluator-v1",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      criteria: expect.arrayContaining([
        expect.stringMatching(/support/iu),
        expect.stringMatching(/educational/iu),
        expect.stringMatching(/provenance/iu),
        expect.stringMatching(/fresh/iu),
      ]),
    });
    const commitBroadcast = vi.fn();
    const result = await executeEvaluatorBridgeJob({
      jobId: "evaluator-job",
      loadAuthority: vi.fn().mockResolvedValue(evaluatorAuthority()),
      generate: vi.fn().mockResolvedValue({
        decision: "ACCEPT",
        rationaleCode: "SUPPORTED",
      }),
      commitBroadcast,
    });
    expect(result).toEqual({ decision: "MALFORMED" });
    expect(commitBroadcast).not.toHaveBeenCalled();
  });

  it.each([
    ["version", { ...evaluatorAuthority(), rubricVersion: "broadcast-evaluator-v2" }],
    ["digest", { ...evaluatorAuthority(), rubricDigest: "0".repeat(64) }],
    ["content", { ...evaluatorAuthority(), rubricCriteria: ["different criterion"] }],
    ["missing", {
      cycleId: "cycle-1",
      candidateEventId: "candidate-event",
      prompt: "authorized rubric",
    }],
  ])("rejects mismatched or %s Evaluator rubric authority before generation", async (_, authority) => {
    const generate = vi.fn();
    const commitBroadcast = vi.fn();
    await expect(executeEvaluatorBridgeJob({
      jobId: "evaluator-job",
      loadAuthority: vi.fn().mockResolvedValue(authority),
      generate,
      commitBroadcast,
    })).rejects.toThrow("EVALUATOR_AUTHORITY_REVOKED");
    expect(generate).not.toHaveBeenCalled();
    expect(commitBroadcast).not.toHaveBeenCalled();
  });

  it("stages exactly one body-free Main job per durable generation cycle", async () => {
    const fixture = await createConversationFixture("bridge-main-cycle-stage");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-main-cycle','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );

    await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );

    const jobs = await fixture.db.query<Record<string, unknown>>(
      `select job.* from bridge_model_jobs job
       join broadcast_cycles cycle on cycle.id=job.cycle_id
       where cycle.schedule_id='bridge-main-cycle'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      role: "MAIN",
      kind: "MAIN_GENERATION",
      priority: 20,
      status: "PENDING",
      candidate_event_id: null,
    });
    expect(forbiddenFieldIntersection(jobs[0]!, FORBIDDEN_JOB_FIELDS)).toEqual([]);
  }, 30_000);

  it("replays only an identical completed Main candidate without changing durable state", async () => {
    const fixture = await createConversationFixture("bridge-main-exact-replay");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-main-replay','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const candidate = "AAPL remains near completed support.";
    await (await import("../../worker/hybrid/runtime")).runOneHybridJob({
      db: fixture.db,
      workerId: "main-replay-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({ candidate }))),
    });
    const completed = await fixture.db.one<{
      readonly attempt_count: number;
      readonly candidate_event_id: string;
      readonly evaluator_job_id: string;
      readonly main_job_id: string;
    }>(
      `select main.attempt_count,main.output_event_id::text candidate_event_id,
              main.job_id::text main_job_id,evaluator.job_id::text evaluator_job_id
       from bridge_model_jobs main
       join bridge_model_jobs evaluator on evaluator.candidate_event_id=main.output_event_id
       where main.cycle_id=$1 and main.role='MAIN' and main.status='COMPLETED'`,
      [cycle!.id],
    );
    const before = await fixture.db.one<{ readonly jobs: number; readonly candidates: number }>(
      `select
         (select count(*)::int from bridge_model_jobs where cycle_id=$1::uuid) jobs,
         (select count(*)::int from events
           where aggregate_id=$1::text and type='main.broadcast.candidate.generated') candidates`,
      [cycle!.id],
    );

    await expect(stageMainCandidateAndEvaluator(fixture.db, {
      jobId: completed.main_job_id,
      workerId: "main-replay-worker",
      attemptCount: completed.attempt_count,
      cycleId: cycle!.id,
      candidate,
    })).resolves.toEqual({
      candidateEventId: completed.candidate_event_id,
      evaluatorJobId: completed.evaluator_job_id,
    });
    await expect(stageMainCandidateAndEvaluator(fixture.db, {
      jobId: completed.main_job_id,
      workerId: "main-replay-worker",
      attemptCount: completed.attempt_count,
      cycleId: cycle!.id,
      candidate: "Conflicting candidate replay.",
    })).rejects.toThrow("MAIN_REPLAY_CONFLICT");
    await expect(fixture.db.one(
      `select
         (select count(*)::int from bridge_model_jobs where cycle_id=$1::uuid) jobs,
         (select count(*)::int from events
           where aggregate_id=$1::text and type='main.broadcast.candidate.generated') candidates`,
      [cycle!.id],
    )).resolves.toEqual(before);
  }, 30_000);

  it("creates Evaluator from Main and publishes only an accepted exact review", async () => {
    const appendCandidate = vi.fn().mockResolvedValue({ candidateEventId: "candidate-event" });
    const stageEvaluator = vi.fn().mockResolvedValue({ jobId: "evaluator-job" });
    const main = await executeMainBridgeJob({
      jobId: "main-job",
      loadAuthority: vi.fn().mockResolvedValue({
        cycleId: "cycle-1",
        prompt: "authorized grounding",
      }),
      generate: vi.fn().mockResolvedValue({ candidate: "bounded candidate" }),
      appendCandidate,
      stageEvaluator,
    });
    const commitBroadcast = vi.fn().mockResolvedValue({ broadcastId: "broadcast-1" });
    const evaluation = await executeEvaluatorBridgeJob({
      jobId: "evaluator-job",
      loadAuthority: vi.fn().mockResolvedValue(evaluatorAuthority()),
      generate: vi.fn().mockResolvedValue({
        decision: "ACCEPT",
        rationaleCode: "SUPPORTED",
        rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      }),
      commitBroadcast,
    });

    expect(main).toEqual({
      candidateEventId: "candidate-event",
      evaluatorJobId: "evaluator-job",
    });
    expect(stageEvaluator).toHaveBeenCalledWith(expect.objectContaining({
      candidateEventId: "candidate-event",
    }));
    expect(evaluation).toEqual({ broadcastId: "broadcast-1", decision: "ACCEPT" });
    expect(commitBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      cycleId: "cycle-1",
      candidateEventId: "candidate-event",
    }));
    const migration = readFileSync("db/migrations/0022_hybrid_deployment.sql", "utf8");
    expect(migration).toMatch(/main\.broadcast\.generation\.requested[\s\S]+bridge_model_jobs/);
    expect(migration).toMatch(/candidate_event_id[\s\S]+EVALUATOR/);
  });

  it("re-authorizes the exact Main cycle before candidate persistence", async () => {
    const appendCandidate = vi.fn();
    const stageEvaluator = vi.fn();
    const loadAuthority = vi.fn()
      .mockResolvedValueOnce({ cycleId: "cycle-1", prompt: "authorized grounding" })
      .mockResolvedValueOnce({ cycleId: "cycle-2", prompt: "authorized grounding" });

    await expect(executeMainBridgeJob({
      jobId: "main-job",
      loadAuthority,
      generate: vi.fn().mockResolvedValue({ candidate: "bounded candidate" }),
      appendCandidate,
      stageEvaluator,
    })).rejects.toThrow("MAIN_AUTHORITY_REVOKED");
    expect(appendCandidate).not.toHaveBeenCalled();
    expect(stageEvaluator).not.toHaveBeenCalled();
  });

  it.each([
    [{
      decision: "REJECT",
      rationaleCode: "UNSUPPORTED",
      rubricVersion: "broadcast-evaluator-v1",
    }, "REJECT"],
    [{
      decision: "ACCEPT",
      rationaleCode: "SUPPORTED",
      rubricVersion: "broadcast-evaluator-v1",
      plaintext: "leak",
    }, "MALFORMED"],
    [{
      decision: "ACCEPT",
      rationaleCode: "SUPPORTED",
      rubricVersion: "broadcast-evaluator-v2",
    }, "MALFORMED"],
    ["not-json", "MALFORMED"],
  ] as const)("publishes no broadcast for %s evaluator output", async (output, expected) => {
    const commitBroadcast = vi.fn();
    const result = await executeEvaluatorBridgeJob({
      jobId: "evaluator-job",
      loadAuthority: vi.fn().mockResolvedValue(evaluatorAuthority()),
      generate: vi.fn().mockResolvedValue(output),
      commitBroadcast,
    });

    expect(result).toMatchObject({ decision: expected });
    expect(commitBroadcast).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/authorized rubric|bounded candidate/iu);
  });

  it("fails closed when exact Evaluator candidate, cycle, or rubric authority changes", async () => {
    const commitBroadcast = vi.fn();
    const loadAuthority = vi.fn()
      .mockResolvedValueOnce(evaluatorAuthority())
      .mockResolvedValueOnce(evaluatorAuthority("different-candidate"));

    await expect(executeEvaluatorBridgeJob({
      jobId: "evaluator-job",
      loadAuthority,
      generate: vi.fn().mockResolvedValue({
        decision: "ACCEPT",
        rationaleCode: "SUPPORTED",
        rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      }),
      commitBroadcast,
    })).rejects.toThrow("EVALUATOR_AUTHORITY_REVOKED");
    expect(commitBroadcast).not.toHaveBeenCalled();
  });

  it("encrypts the Main candidate, atomically stages Evaluator, and commits exact ACCEPT provenance once", async () => {
    const fixture = await createConversationFixture("bridge-main-evaluator-accept");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-accept','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const candidateText = "AAPL is testing completed support.";

    await expect((await import("../../worker/hybrid/runtime")).runOneHybridJob({
      db: fixture.db,
      workerId: "main-accept-worker",
      generate: vi.fn().mockResolvedValue(
        generationResult(JSON.stringify({ candidate: candidateText })),
      ),
    })).resolves.toMatchObject({ role: "MAIN", status: "COMPLETED" });

    const staged = await fixture.db.one<{
      readonly candidate_event_id: string;
      readonly evaluator_job_id: string;
      readonly evaluator_status: string;
      readonly main_job_id: string;
      readonly parent_main_job_id: string;
      readonly ciphertext: Buffer;
    }>(
      `select main.job_id::text main_job_id,main.output_event_id::text candidate_event_id,
              evaluator.job_id::text evaluator_job_id,
              evaluator.parent_main_job_id::text parent_main_job_id,
              evaluator.status evaluator_status,body.ciphertext
       from bridge_model_jobs main
       join bridge_model_jobs evaluator on evaluator.candidate_event_id=main.output_event_id
       join encrypted_event_bodies body on body.event_id=main.output_event_id
       where main.cycle_id=$1 and main.role='MAIN' and evaluator.role='EVALUATOR'`,
      [cycle!.id],
    );
    expect(staged.evaluator_status).toBe("PENDING");
    expect(staged.parent_main_job_id).toBe(staged.main_job_id);
    expect(staged.ciphertext.toString("utf8")).not.toContain(candidateText);
    expect(JSON.stringify(await fixture.db.query(
      "select * from bridge_model_jobs where cycle_id=$1 order by priority",
      [cycle!.id],
    ))).not.toContain(candidateText);
    expect(await readEventBody(fixture.db, staged.candidate_event_id, {
      actor: { role: "SYSTEM" },
    })).toMatchObject({ candidate: candidateText, cycleId: cycle!.id });

    const evaluatorGenerate = vi.fn().mockImplementation(
      (request: ModelGenerationRequest) => {
        const input = JSON.parse(request.input) as Record<string, unknown>;
        expect(input.rubric).toEqual({
          version: BROADCAST_EVALUATOR_RUBRIC.version,
          digest: BROADCAST_EVALUATOR_RUBRIC.digest,
          criteria: [...BROADCAST_EVALUATOR_RUBRIC.criteria],
        });
        return Promise.resolve(generationResult(JSON.stringify({
          decision: "ACCEPT",
          rationaleCode: "SUPPORTED",
          rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
        })));
      },
    );
    const evaluation = await (await import("../../worker/hybrid/runtime")).runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-accept-worker",
      generate: evaluatorGenerate,
    });
    expect(evaluatorGenerate).toHaveBeenCalledOnce();
    if (evaluation.status !== "COMPLETED") {
      throw new Error(`EXPECTED_EVALUATOR_COMPLETION:${JSON.stringify(evaluation)}`);
    }
    expect(evaluation).toMatchObject({ role: "EVALUATOR", status: "COMPLETED" });
    expect(await readEventBody(fixture.db, evaluation.outputEventId, {
      actor: { role: "SYSTEM" },
    })).toMatchObject({
      candidateEventId: staged.candidate_event_id,
      cycleId: cycle!.id,
      decision: "ACCEPT",
      rationaleCode: "SUPPORTED",
      rubricVersion: "broadcast-evaluator-v1",
      rubricDigest: BROADCAST_EVALUATOR_RUBRIC.digest,
    });

    const provenance = await fixture.db.one<{
      readonly count: number;
      readonly source_ids: string[];
    }>(
      `select count(*) over()::int count,source_ids
       from broadcasts where idempotency_key=$1 limit 1`,
      [`bridge-broadcast:${cycle!.id}`],
    );
    expect(provenance.count).toBe(1);
    expect(provenance.source_ids).toEqual([
      cycle!.id,
      staged.candidate_event_id,
      evaluation.outputEventId,
    ].sort());
    await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    await expect(fixture.db.one(
      "select count(*)::int count from bridge_model_jobs where cycle_id=$1",
      [cycle!.id],
    )).resolves.toEqual({ count: 2 });
  }, 30_000);

  it("replays only an identical completed Evaluator review and exact broadcast provenance", async () => {
    const fixture = await createConversationFixture("bridge-evaluator-exact-replay");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-evaluator-replay','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const runtime = await import("../../worker/hybrid/runtime");
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-replay-main-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({
        candidate: "AAPL remains near completed support.",
      }))),
    });
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-replay-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({
        decision: "ACCEPT",
        rationaleCode: "SUPPORTED",
        rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      }))),
    });
    const completed = await fixture.db.one<{
      readonly attempt_count: number;
      readonly broadcast_id: string;
      readonly candidate_event_id: string;
      readonly evaluator_job_id: string;
      readonly review_event_id: string;
    }>(
      `select evaluator.attempt_count,broadcast.id::text broadcast_id,
              evaluator.candidate_event_id::text candidate_event_id,
              evaluator.job_id::text evaluator_job_id,
              evaluator.output_event_id::text review_event_id
       from bridge_model_jobs evaluator
       join broadcasts broadcast on broadcast.idempotency_key='bridge-broadcast:'||$1::text
       where evaluator.cycle_id=$1::uuid and evaluator.role='EVALUATOR'
         and evaluator.status='COMPLETED'`,
      [cycle!.id],
    );
    const before = await fixture.db.one<{ readonly broadcasts: number; readonly reviews: number }>(
      `select
         (select count(*)::int from broadcasts where idempotency_key=$1) broadcasts,
         (select count(*)::int from events
           where aggregate_id=$2 and type='main.broadcast.evaluation.completed') reviews`,
      [`bridge-broadcast:${cycle!.id}`, cycle!.id],
    );
    const exact = {
      jobId: completed.evaluator_job_id,
      workerId: "evaluator-replay-worker",
      attemptCount: completed.attempt_count,
      cycleId: cycle!.id,
      candidateEventId: completed.candidate_event_id,
      decision: "ACCEPT" as const,
      rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      rubricDigest: BROADCAST_EVALUATOR_RUBRIC.digest,
      rubricCriteria: BROADCAST_EVALUATOR_RUBRIC.criteria,
      rationaleCode: "SUPPORTED",
    };

    await expect(commitAcceptedEvaluatorBridgeJob(fixture.db, exact)).resolves.toEqual({
      broadcastId: completed.broadcast_id,
      reviewEventId: completed.review_event_id,
    });
    await expect(commitAcceptedEvaluatorBridgeJob(fixture.db, {
      ...exact,
      rationaleCode: "CONFLICTING_REPLAY",
    })).rejects.toThrow("EVALUATOR_REPLAY_CONFLICT");
    await expect(fixture.db.one(
      `select
         (select count(*)::int from broadcasts where idempotency_key=$1) broadcasts,
         (select count(*)::int from events
           where aggregate_id=$2 and type='main.broadcast.evaluation.completed') reviews`,
      [`bridge-broadcast:${cycle!.id}`, cycle!.id],
    )).resolves.toEqual(before);
  }, 30_000);

  it.each([
    [JSON.stringify({
      decision: "REJECT",
      rationaleCode: "UNSUPPORTED",
      rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
    }), "EVALUATOR_REJECTED"],
    ["not-json", "CODEX_OUTPUT_INVALID"],
  ])("terminalizes %s without a broadcast", async (evaluation, safeCode) => {
    const fixture = await createConversationFixture(`bridge-evaluator-${safeCode.toLowerCase()}`);
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-reject','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const runtime = await import("../../worker/hybrid/runtime");
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "main-reject-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({
        candidate: "AAPL remains below completed resistance.",
      }))),
    });
    await expect(runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-reject-worker",
      generate: vi.fn().mockResolvedValue(generationResult(evaluation)),
    })).resolves.toMatchObject({ role: "EVALUATOR", status: "FAILED", safeCode });
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle!.id}`],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it.each([
    [new Error("PROVIDER_RATE_LIMITED"), "CODEX_DAILY_QUOTA_EXHAUSTED"],
    [new Error("MODEL_UNAVAILABLE"), "CODEX_MODEL_UNAVAILABLE"],
  ])("terminalizes provider failure without broadcasting", async (providerError, safeCode) => {
    const fixture = await createConversationFixture(`bridge-evaluator-${safeCode.toLowerCase()}`);
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-provider','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const runtime = await import("../../worker/hybrid/runtime");
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "main-provider-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({
        candidate: "SPY is retesting a completed level.",
      }))),
    });
    await expect(runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-provider-worker",
      generate: vi.fn().mockRejectedValue(providerError),
    })).resolves.toMatchObject({ role: "EVALUATOR", status: "FAILED", safeCode });
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle!.id}`],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("terminalizes revoked candidate authority before Evaluator generation", async () => {
    const fixture = await createConversationFixture("bridge-evaluator-revoked");
    await fixture.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('bridge-revoked','0 14 * * *','UTC',true,$1)`,
      ["2026-08-13T13:59:00.000Z"],
    );
    const [cycle] = await openDueBroadcastCycles(
      { db: fixture.db },
      new Date("2026-08-13T14:00:00.000Z"),
    );
    const runtime = await import("../../worker/hybrid/runtime");
    await runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "main-revoked-worker",
      generate: vi.fn().mockResolvedValue(generationResult(JSON.stringify({
        candidate: "IWM is testing a confirmed level.",
      }))),
    });
    vi.stubEnv("GUSTAVO_EVENT_ROOT_KEY_V1", Buffer.alloc(32, 9).toString("base64"));
    const generate = vi.fn();

    await expect(runtime.runOneHybridJob({
      db: fixture.db,
      workerId: "evaluator-revoked-worker",
      generate,
    })).resolves.toMatchObject({
      role: "EVALUATOR",
      status: "FAILED",
      safeCode: "SOURCE_AUTHORITY_REVOKED",
    });
    expect(generate).not.toHaveBeenCalled();
    await expect(fixture.db.one(
      "select count(*)::int count from broadcasts where idempotency_key=$1",
      [`bridge-broadcast:${cycle!.id}`],
    )).resolves.toEqual({ count: 0 });
  }, 30_000);
});

describe("Node bridge execution", () => {
  it("re-authorizes the source and commits one routed Node reply after the USER message", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-run");
    await appendMessage(fixture, {
      idempotencyKey: "node-source-1",
      role: "USER",
      text: "explain today's simulation",
    });
    const generate = vi.fn().mockResolvedValue(generationResult("Node private reply"));

    const result = await runOneHybridJob({
      db: fixture.db,
      workerId: "local-worker-v1",
      generate,
    });
    expect(result).toMatchObject({ role: "NODE", status: "COMPLETED" });

    const history = await listMessages(fixture, { limit: 10 });
    expect(history.items.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "USER", text: "explain today's simulation" },
      { role: "NODE", text: "Node private reply" },
    ]);
    expect(generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("explain today's simulation");
    expect(JSON.stringify(result)).not.toContain("Node private reply");
  }, 30_000);

  it("hydrates exact source plaintext under the same transaction as live authority locks", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-atomic-hydration");
    const source = await appendMessage(fixture, {
      idempotencyKey: "node-atomic-hydration-source",
      role: "USER",
      text: "private atomic hydration source",
    });
    const observed = observeHybridTransactionScopes(fixture.db, source.eventId);

    await expect(runOneHybridJob({
      db: observed.db,
      workerId: "local-worker-v1",
      generate: vi.fn().mockResolvedValue(generationResult("atomic reply")),
    })).resolves.toMatchObject({ role: "NODE", status: "COMPLETED" });

    expect(observed.authorityScopes[0]).toEqual(expect.any(Number));
    expect(observed.bodyScopes[0]).toBe(observed.authorityScopes[0]);
  }, 30_000);

  it("locks conversation authority before keys and bodies, then revalidates exact source and output identity", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-lock-order");
    await appendMessage(fixture, {
      idempotencyKey: "node-lock-order-source",
      role: "USER",
      text: "private lock order source",
    });
    const observed = observeHybridAuthorityTransactions(fixture.db);

    await expect(runOneHybridJob({
      db: observed.db,
      workerId: "local-worker-v1",
      generate: vi.fn().mockResolvedValue(generationResult("lock order reply")),
    })).resolves.toMatchObject({ role: "NODE", status: "COMPLETED" });

    expect(observed.steps).toEqual([
      "hybrid-node-hydration-authority",
      "hybrid-source-key-lock",
      "hybrid-source-body-lock",
      "hybrid-node-hydration-revalidate",
      "hybrid-node-output-authority",
      "hybrid-output-key-lock",
      "hybrid-output-body-lock",
      "hybrid-node-output-revalidate",
    ]);
  }, 30_000);

  it("serializes production forget behind hydration authority without a lock cycle or plaintext generation after forget", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-forget-hydration-race");
    await appendMessage(fixture, {
      idempotencyKey: "node-forget-hydration-source",
      role: "USER",
      text: "private forget hydration source",
    });
    const gated = pauseAfterStatement(fixture.db, "hybrid-source-body-lock");
    let generationStarted!: () => void;
    const started = new Promise<void>((resolve) => { generationStarted = resolve; });
    let releaseGeneration!: (result: ModelGenerationResult) => void;
    const generated = new Promise<ModelGenerationResult>((resolve) => {
      releaseGeneration = resolve;
    });
    const generate = vi.fn().mockImplementation(() => {
      generationStarted();
      return generated;
    });
    const running = runOneHybridJob({
      db: gated.db,
      workerId: "local-worker-v1",
      generate,
    });
    void running.catch(() => undefined);
    await bounded(gated.reached);

    const forgetSignal = signalBeforeStatement(fixture.db, "privacy-forget-key-lock");
    const forgetting = forgetConversation({ db: forgetSignal.db }, {
      actor: forgetOwner(fixture),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-during-node-hydration",
    });
    void forgetting.catch(() => undefined);
    const beforeRelease = await Promise.race([
      forgetSignal.reached.then(() => "forget-reached-key" as const),
      new Promise<"forget-blocked-on-authority">((resolve) => setTimeout(
        () => resolve("forget-blocked-on-authority"), 250,
      )),
    ]);
    gated.release();

    const forgetOutcome = await bounded(forgetting.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ));
    releaseGeneration(generationResult("must not commit after forget"));
    const result = await bounded(running);

    expect(beforeRelease).toBe("forget-blocked-on-authority");
    expect(forgetOutcome).toMatchObject({ ok: true });
    await expect(bounded(started)).resolves.toBeUndefined();
    expect(generate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      role: "NODE",
      status: "FAILED",
      outputEventId: null,
      safeCode: "OUTPUT_AUTHORITY_INVALID",
    });
    await expect(fixture.db.one(
      `select count(*) filter (where type='brain.response.completed')::int as outputs
         from events where aggregate_id=$1::text`,
      [fixture.conversationId],
    )).resolves.toEqual({ outputs: 0 });
  }, 30_000);

  it("serializes production forget behind atomic output without a lock cycle or unbound completion", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-forget-output-race");
    await appendMessage(fixture, {
      idempotencyKey: "node-forget-output-source",
      role: "USER",
      text: "private forget output source",
    });
    const gated = pauseAfterStatement(fixture.db, "hybrid-output-body-lock");
    const running = runOneHybridJob({
      db: gated.db,
      workerId: "local-worker-v1",
      generate: vi.fn().mockResolvedValue(generationResult("atomic output before forget")),
    });
    void running.catch(() => undefined);
    await bounded(gated.reached);

    const forgetSignal = signalBeforeStatement(fixture.db, "privacy-forget-key-lock");
    const forgetting = forgetConversation({ db: forgetSignal.db }, {
      actor: forgetOwner(fixture),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-during-node-output",
    });
    void forgetting.catch(() => undefined);
    const beforeRelease = await Promise.race([
      forgetSignal.reached.then(() => "forget-reached-key" as const),
      new Promise<"forget-blocked-on-authority">((resolve) => setTimeout(
        () => resolve("forget-blocked-on-authority"), 250,
      )),
    ]);
    gated.release();
    const [runOutcome, forgetOutcome] = await bounded(Promise.all([
      running.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      forgetting.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]));

    expect(beforeRelease).toBe("forget-blocked-on-authority");
    expect(runOutcome).toMatchObject({ ok: true, value: { role: "NODE", status: "COMPLETED" } });
    expect(forgetOutcome).toMatchObject({ ok: true });
    await expect(fixture.db.one(
      `select job.status,job.output_event_id is not null as bound,
              count(output.id)::int as outputs
         from bridge_model_jobs job
         left join events output on output.id=job.output_event_id
        group by job.status,job.output_event_id`,
    )).resolves.toEqual({ status: "COMPLETED", bound: true, outputs: 1 });
  }, 30_000);

  it("finishes output commit and concurrent key deletion without a lock-order deadlock", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-key-delete-concurrency");
    await appendMessage(fixture, {
      idempotencyKey: "node-key-delete-concurrency-source",
      role: "USER",
      text: "private concurrent deletion source",
    });
    const gated = pauseAfterStatement(fixture.db, "hybrid-output-key-lock");
    const running = runOneHybridJob({
      db: gated.db,
      workerId: "local-worker-v1",
      generate: vi.fn().mockResolvedValue(generationResult("concurrent deletion reply")),
    });
    await gated.reached;
    const deleting = fixture.db.query(
      "delete from aggregate_data_keys where aggregate_id=$1",
      [fixture.conversationId],
    );
    const deletionState = await Promise.race([
      deleting.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(deletionState).toBe("blocked");
    gated.release();
    const [result] = await Promise.all([running, deleting]);

    expect(result).toMatchObject({ role: "NODE", status: "COMPLETED" });
    await expect(fixture.db.one(
      `select job.status,job.output_event_id is not null as bound,
              count(*) filter (where body.data_key_id is null)::int as erased
         from bridge_model_jobs job
         join encrypted_event_bodies body
           on body.event_id in (job.source_event_id,job.output_event_id)
        group by job.status,job.output_event_id`,
    )).resolves.toEqual({ status: "COMPLETED", bound: true, erased: 2 });
  }, 30_000);

  it("commits the encrypted Node output and exact job binding in one transaction", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-atomic-output-binding");
    await appendMessage(fixture, {
      idempotencyKey: "node-atomic-output-source",
      role: "USER",
      text: "private atomic output source",
    });
    const observed = observeHybridAuthorityTransactions(fixture.db);

    await expect(runOneHybridJob({
      db: observed.db,
      workerId: "local-worker-v1",
      generate: vi.fn().mockResolvedValue(generationResult("atomic output reply")),
    })).resolves.toMatchObject({ role: "NODE", status: "COMPLETED" });

    expect(observed.outputEventScopes).toEqual([expect.any(Number)]);
    expect(observed.completionScopes).toEqual(observed.outputEventScopes);
  }, 30_000);

  it("keeps the exact bound output terminal on retry without a second model call", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-bound-output-retry");
    const source = await appendMessage(fixture, {
      idempotencyKey: "node-bound-output-retry-source",
      role: "USER",
      text: "private bound output retry source",
    });
    const boundJob = await fixture.db.one<{ readonly job_id: string }>(
      "select job_id::text from bridge_model_jobs where source_event_id=$1",
      [source.eventId],
    );
    const firstGenerate = vi.fn().mockResolvedValue(generationResult("bound output reply"));
    const first = await runOneHybridJob({
      db: fixture.db,
      workerId: "local-worker-v1",
      generate: firstGenerate,
    });
    const retryGenerate = vi.fn().mockResolvedValue(generationResult("duplicate output reply"));

    await expect(runOneHybridJob({
      db: fixture.db,
      workerId: "retry-worker-v1",
      generate: retryGenerate,
    })).resolves.toEqual({ status: "IDLE" });
    expect(firstGenerate).toHaveBeenCalledOnce();
    expect(retryGenerate).not.toHaveBeenCalled();
    await expect(fixture.db.one(
      `select job.status,job.output_event_id::text as output_event_id,
              output.id::text as exact_output_id
         from bridge_model_jobs job
         join events output on output.id=job.output_event_id
        where job.job_id=$1`,
      [boundJob.job_id],
    )).resolves.toEqual({
      status: "COMPLETED",
      output_event_id: "outputEventId" in first ? first.outputEventId : null,
      exact_output_id: "outputEventId" in first ? first.outputEventId : null,
    });
  }, 30_000);

  it.each([
    ["source event", async (fixture: ConversationFixture, sourceEventId: string) => {
      await fixture.db.query(
        "update encrypted_event_bodies set data_key_id=null where event_id=$1",
        [sourceEventId],
      );
    }],
    ["account", async (fixture: ConversationFixture) => {
      await fixture.db.query("update accounts set status='SUSPENDED' where id=$1", [fixture.accountId]);
    }],
    ["conversation", async (fixture: ConversationFixture) => {
      await fixture.db.query("update conversations set status='ARCHIVED' where id=$1", [fixture.conversationId]);
    }],
    ["Node", async (fixture: ConversationFixture) => {
      await fixture.db.query("update node_brains set status='PAUSED' where id=$1", [fixture.nodeBrainId]);
    }],
    ["encryption key", async (fixture: ConversationFixture) => {
      await fixture.db.query("delete from aggregate_data_keys where aggregate_id=$1", [fixture.conversationId]);
    }],
  ])("fails the claimed job safely when the exact %s authority is revoked", async (_label, revoke) => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture(`bridge-node-revoked-${_label}`);
    const source = await appendMessage(fixture, {
      idempotencyKey: "node-revoked-source",
      role: "USER",
      text: "private revoked source",
    });
    await revoke(fixture, source.eventId);
    const generate = vi.fn().mockResolvedValue(generationResult("must not run"));

    const result = await runOneHybridJob({
      db: fixture.db,
      workerId: "local-worker-v1",
      generate,
    });

    expect(result).toMatchObject({
      role: "NODE",
      status: "FAILED",
      safeCode: "SOURCE_AUTHORITY_REVOKED",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private revoked source");
  }, 30_000);

  it("terminalizes a revoked routing boundary without starting the model", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-routing-revoked");
    await appendMessage(fixture, {
      idempotencyKey: "node-routing-revoked-source",
      role: "USER",
      text: "private routing source",
    });
    await fixture.db.query(`
      create function reject_hybrid_node_route_outbox() returns trigger language plpgsql as $$
      begin
        if new.topic='node.reply.routed' then
          raise exception 'TEST_ROUTING_AUTHORITY_REVOKED';
        end if;
        return new;
      end;
      $$;
      create trigger reject_hybrid_node_route_outbox before insert on transactional_outbox
      for each row execute function reject_hybrid_node_route_outbox();
    `);
    const generate = vi.fn().mockResolvedValue(generationResult("must not run"));

    await expect(runOneHybridJob({
      db: fixture.db,
      workerId: "local-worker-v1",
      generate,
    })).resolves.toMatchObject({
      role: "NODE",
      status: "FAILED",
      safeCode: "ROUTING_AUTHORITY_REVOKED",
    });
    expect(generate).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects a canonical Node event that has no durable job output binding", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-output-replay");
    const source = await appendMessage(fixture, {
      idempotencyKey: "node-output-replay-source",
      role: "USER",
      text: "private replay source",
    });
    const firstClaim = await claimNextBridgeJob(fixture.db, {
      workerId: "interrupted-worker",
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    const routed = await routeNodeReply({
      db: fixture.db,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      userMessageEventId: source.eventId,
      coveredByMain: false,
      contradiction: false,
      materialEvidence: false,
      confidence: 1,
      mainStateVersion: "bridge-node-v1",
      sourceIds: [source.eventId],
    }, async () => undefined);
    await appendMessage(fixture, {
      idempotencyKey: `bridge-node:${firstClaim!.jobId}`,
      role: "NODE",
      text: "already committed reply",
      routingEventId: routed.routingEventId,
    });
    await expireClaimedBridgeLease(fixture.db, firstClaim!.jobId);
    const generate = vi.fn().mockResolvedValue(generationResult("duplicate reply"));

    await expect(runOneHybridJob({
      db: fixture.db,
      workerId: "recovery-worker",
      generate,
    })).resolves.toMatchObject({
      role: "NODE",
      status: "FAILED",
      safeCode: "OUTPUT_AUTHORITY_INVALID",
    });
    expect(generate).not.toHaveBeenCalled();
    await expect(fixture.db.one(
      "select status,output_event_id from bridge_model_jobs where job_id=$1",
      [firstClaim!.jobId],
    )).resolves.toEqual({ status: "FAILED", output_event_id: null });
  }, 30_000);

  it("classifies a conflicting replay output as output authority failure", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-conflicting-output-replay");
    await appendMessage(fixture, {
      idempotencyKey: "node-conflicting-output-source",
      role: "USER",
      text: "private conflicting output source",
    });
    const claim = await claimNextBridgeJob(fixture.db, {
      workerId: "interrupted-worker",
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId,
      accountId: fixture.accountId,
      actor: { type: "SYSTEM", id: "forged-output" },
      type: "brain.response.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: { text: "forged replay body" },
      idempotencyKey: `message:${fixture.conversationId}:bridge-node:${claim!.jobId}`,
    });
    await expireClaimedBridgeLease(fixture.db, claim!.jobId);
    const generate = vi.fn().mockResolvedValue(generationResult("must not run"));

    await expect(runOneHybridJob({
      db: fixture.db,
      workerId: "recovery-worker",
      generate,
    })).resolves.toMatchObject({
      role: "NODE",
      status: "FAILED",
      safeCode: "OUTPUT_AUTHORITY_INVALID",
    });
    expect(generate).not.toHaveBeenCalled();
  }, 30_000);

  it.each([
    ["account", async (fixture: ConversationFixture) => {
      await fixture.db.query("update accounts set status='SUSPENDED' where id=$1", [fixture.accountId]);
    }],
    ["conversation", async (fixture: ConversationFixture) => {
      await fixture.db.query("update conversations set status='ARCHIVED' where id=$1", [fixture.conversationId]);
    }],
    ["Node", async (fixture: ConversationFixture) => {
      await fixture.db.query("update node_brains set status='PAUSED' where id=$1", [fixture.nodeBrainId]);
    }],
    ["entitlement", async (fixture: ConversationFixture) => {
      await fixture.db.query(
        "update entitlements set revoked_at=clock_timestamp() where account_id=$1",
        [fixture.accountId],
      );
    }],
    ["source event", async (fixture: ConversationFixture, sourceEventId: string) => {
      await fixture.db.query(
        "update encrypted_event_bodies set data_key_id=null where event_id=$1",
        [sourceEventId],
      );
    }],
    ["encryption key", async (fixture: ConversationFixture) => {
      await fixture.db.query("delete from aggregate_data_keys where aggregate_id=$1", [fixture.conversationId]);
    }],
    ["claimed job", async (fixture: ConversationFixture, _sourceEventId: string, jobId: string) => {
      await expireClaimedBridgeLease(fixture.db, jobId);
    }],
  ])("revalidates deferred output against current %s authority before any Node event", async (
    label,
    revoke,
  ) => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture(`bridge-node-deferred-${label}`);
    const source = await appendMessage(fixture, {
      idempotencyKey: "node-deferred-source",
      role: "USER",
      text: "private deferred source",
    });
    const sourceJob = await fixture.db.one<{ readonly job_id: string }>(
      "select job_id::text from bridge_model_jobs where source_event_id=$1",
      [source.eventId],
    );
    let generationStarted!: () => void;
    let releaseGeneration!: () => void;
    const atGeneration = new Promise<void>((resolve) => { generationStarted = resolve; });
    const heldGeneration = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const generate = vi.fn(async () => {
      generationStarted();
      await heldGeneration;
      return generationResult("deferred private reply");
    });
    const running = runOneHybridJob({
      db: fixture.db,
      workerId: "local-worker-v1",
      generate,
    });
    await atGeneration;
    await revoke(fixture, source.eventId, sourceJob.job_id);
    releaseGeneration();
    const outcome = await running.then(
      (value) => value,
      (error: unknown) => error,
    );

    await expect(fixture.db.one(
      "select count(*)::int as count from events where type='brain.response.completed'",
    )).resolves.toEqual({ count: 0 });
    const job = await fixture.db.one<{ readonly status: string; readonly output_event_id: string | null }>(
      "select status,output_event_id::text from bridge_model_jobs where job_id=$1",
      [sourceJob.job_id],
    );
    expect(job.status).not.toBe("COMPLETED");
    expect(job.output_event_id).toBeNull();
    expect(JSON.stringify(outcome)).not.toMatch(/private deferred source|deferred private reply/iu);
  }, 30_000);

  it("never completes the job when the routed Node event cannot commit", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-output-rollback");
    await appendMessage(fixture, {
      idempotencyKey: "node-output-rollback-source",
      role: "USER",
      text: "private output rollback source",
    });
    await fixture.db.query(`
      create function reject_hybrid_node_output_outbox() returns trigger language plpgsql as $$
      begin
        if new.topic='brain.response.completed' then
          raise exception 'TEST_NODE_OUTPUT_COMMIT_FAILED';
        end if;
        return new;
      end;
      $$;
      create trigger reject_hybrid_node_output_outbox before insert on transactional_outbox
      for each row execute function reject_hybrid_node_output_outbox();
    `);

    await expect(runOneHybridJob({
      db: fixture.db,
      workerId: "local-worker-v1",
      generate: vi.fn().mockResolvedValue(generationResult("uncommitted reply")),
    })).resolves.toMatchObject({ role: "NODE", status: "FAILED" });
    await expect(fixture.db.one(
      "select status,output_event_id from bridge_model_jobs",
    )).resolves.toEqual({ status: "FAILED", output_event_id: null });
    await expect(fixture.db.one(
      "select count(*)::int as count from events where type='brain.response.completed'",
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("maps an unavailable model to the explicit safe terminal code", async () => {
    const { runOneHybridJob } = await import("../../worker/hybrid/runtime");
    const fixture = await createConversationFixture("bridge-node-model-unavailable");
    await appendMessage(fixture, {
      idempotencyKey: "node-model-unavailable-source",
      role: "USER",
      text: "private unavailable model source",
    });

    await expect(runOneHybridJob({
      db: fixture.db,
      workerId: "local-worker-v1",
      generate: vi.fn().mockRejectedValue(new Error("CODEX_MODEL_UNAVAILABLE")),
    })).resolves.toMatchObject({
      role: "NODE",
      status: "FAILED",
      safeCode: "CODEX_MODEL_UNAVAILABLE",
    });
  }, 30_000);

  it("publishes only an opaque wake after commit and returns 202 when QStash is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUSTAVO_HYBRID_BRIDGE_ENABLED", "true");
    vi.stubEnv("GUSTAVO_HYBRID_WAKE_URL", "https://worker.tailnet.ts.net/wake");
    vi.stubEnv("QSTASH_TOKEN", "qstash-secret-token-canary");
    const fixture = await createConversationFixture("bridge-node-route-wake");
    routeState.db = fixture.db;
    routeState.publishJSON.mockImplementation(async (input: unknown) => {
      const persisted = await fixture.db.one<{ readonly count: number }>(
        `select count(*)::int as count
           from messages message
           join bridge_model_jobs job on job.source_event_id=message.event_id
          where message.idempotency_key='route-wake-source'`,
      );
      expect(persisted).toEqual({ count: 1 });
      expect(input).toEqual({
        url: "https://worker.tailnet.ts.net/wake",
        body: { jobId: expect.any(String) },
      });
      expect(JSON.stringify(input)).not.toContain("private route wake text");
      throw new Error("qstash-secret-error-canary");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = new Request(
      `https://gustavo.lol/api/conversations/${fixture.conversationId}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-gustavo-session=${fixture.sessionToken}`,
          origin: "https://gustavo.lol",
        },
        body: JSON.stringify({
          idempotencyKey: "route-wake-source",
          text: "private route wake text",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ conversationId: fixture.conversationId }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(202);
    expect(JSON.parse(responseText)).toMatchObject({
      eventId: expect.any(String),
      status: "COMPLETED",
      queued: true,
    });
    expect(routeState.publishJSON).toHaveBeenCalledOnce();
    expect(routeState.clientConfigs).toEqual([{ token: "qstash-secret-token-canary" }]);
    expect(`${responseText}${JSON.stringify(log.mock.calls)}${JSON.stringify(error.mock.calls)}`)
      .not.toMatch(/private route wake text|qstash-secret|worker\.tailnet\.ts\.net/iu);
  }, 30_000);

  it("bounds the QStash publish await and handles a late rejection without leaking", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUSTAVO_HYBRID_BRIDGE_ENABLED", "true");
    vi.stubEnv("GUSTAVO_HYBRID_WAKE_URL", "https://worker.tailnet.ts.net/wake");
    vi.stubEnv("QSTASH_TOKEN", "qstash-late-rejection-token");
    const fixture = await createConversationFixture("bridge-wake-timeout");
    routeState.db = fixture.db;
    let rejectPublish!: (error: Error) => void;
    let publishStarted!: () => void;
    const atPublish = new Promise<void>((resolve) => { publishStarted = resolve; });
    routeState.publishJSON.mockReturnValue(new Promise((_resolve, reject) => {
      rejectPublish = reject;
      publishStarted();
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const request = new Request(
      `https://gustavo.lol/api/conversations/${fixture.conversationId}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-gustavo-session=${fixture.sessionToken}`,
          origin: "https://gustavo.lol",
        },
        body: JSON.stringify({
          idempotencyKey: "bounded-wake-source",
          text: "private bounded wake text",
        }),
      },
    );

    const nativeSetTimeout = globalThis.setTimeout;
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation((
      (callback: (...arguments_: unknown[]) => void, milliseconds?: number, ...arguments_: unknown[]) =>
        nativeSetTimeout(callback, milliseconds === 2_000 ? 0 : milliseconds, ...arguments_)
    ) as typeof setTimeout);
    const pendingResponse = POST(request, {
      params: Promise.resolve({ conversationId: fixture.conversationId }),
    });
    await atPublish;
    const response = await pendingResponse;
    expect(response.status).toBe(202);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 2_000);
    rejectPublish(new Error("qstash-late-rejection-canary"));
    await Promise.resolve();
    const responseText = await response.text();
    expect(`${responseText}${JSON.stringify(log.mock.calls)}${JSON.stringify(error.mock.calls)}`)
      .not.toMatch(/private bounded wake text|qstash-late-rejection|worker\.tailnet\.ts\.net/iu);
  }, 30_000);

  it("replays a committed USER response after terminal job pruning without republishing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUSTAVO_HYBRID_BRIDGE_ENABLED", "true");
    vi.stubEnv("GUSTAVO_HYBRID_WAKE_URL", "https://worker.tailnet.ts.net/wake");
    vi.stubEnv("QSTASH_TOKEN", "qstash-pruned-replay-token");
    const fixture = await createConversationFixture("bridge-user-pruned-replay");
    routeState.db = fixture.db;
    routeState.publishJSON.mockResolvedValue({ messageId: "published-once" });
    const request = (text: string) => new Request(
      `https://gustavo.lol/api/conversations/${fixture.conversationId}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-gustavo-session=${fixture.sessionToken}`,
          origin: "https://gustavo.lol",
        },
        body: JSON.stringify({
          idempotencyKey: "pruned-user-replay-source",
          text,
        }),
      },
    );

    const first = await POST(request("private pruned replay text"), {
      params: Promise.resolve({ conversationId: fixture.conversationId }),
    });
    expect(first.status).toBe(201);
    const job = await claimNextBridgeJob(fixture.db, {
      workerId: "pruned-replay-worker",
      now: new Date(),
    });
    await failBridgeJob(fixture.db, {
      jobId: job!.jobId,
      workerId: "pruned-replay-worker",
      attemptCount: job!.attemptCount,
      safeCode: "CODEX_PROCESS_FAILED",
    });
    await fixture.db.transaction(async (transaction) => {
      await transaction.query(
        "alter table bridge_model_jobs disable trigger bridge_model_jobs_are_semantically_immutable",
      );
      await transaction.query(
        `update bridge_model_jobs
            set created_at=created_at-interval '8 days',
                updated_at=updated_at-interval '8 days'
          where job_id=$1`,
        [job!.jobId],
      );
      await transaction.query(
        "alter table bridge_model_jobs enable trigger bridge_model_jobs_are_semantically_immutable",
      );
      await transaction.query("delete from bridge_model_jobs where job_id=$1", [job!.jobId]);
    });

    const replay = await POST(request("private pruned replay text"), {
      params: Promise.resolve({ conversationId: fixture.conversationId }),
    });
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({
      eventId: (await first.json()).eventId,
      status: "COMPLETED",
    });
    expect(routeState.publishJSON).toHaveBeenCalledOnce();

    const conflicting = await POST(request("different private replay text"), {
      params: Promise.resolve({ conversationId: fixture.conversationId }),
    });
    expect(conflicting.status).toBe(409);
    expect(routeState.publishJSON).toHaveBeenCalledOnce();
  }, 30_000);

  it.each([
    ["attacker host", "https://attacker.example/wake"],
    ["suffix lookalike", "https://worker.tailnet.ts.net.attacker.example/wake"],
    ["missing tailnet label", "https://worker.ts.net/wake"],
    ["bare suffix", "https://ts.net/wake"],
    ["hostile label", "https://worker_bad.tailnet.ts.net/wake"],
    ["credentials", "https://user:secret@worker.tailnet.ts.net/wake"],
    ["query", "https://worker.tailnet.ts.net/wake?redirect=attacker"],
    ["fragment", "https://worker.tailnet.ts.net/wake#secret"],
    ["nondefault port", "https://worker.tailnet.ts.net:8443/wake"],
    ["wrong path", "https://worker.tailnet.ts.net/not-wake"],
    ["trailing slash", "https://worker.tailnet.ts.net/wake/"],
  ])("fails closed for a noncanonical Funnel %s without publishing", async (_label, wakeUrl) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUSTAVO_HYBRID_BRIDGE_ENABLED", "true");
    vi.stubEnv("GUSTAVO_HYBRID_WAKE_URL", wakeUrl);
    vi.stubEnv("QSTASH_TOKEN", "qstash-hostile-url-token");
    const fixture = await createConversationFixture(`bridge-hostile-funnel-${_label}`);
    routeState.db = fixture.db;
    routeState.publishJSON.mockResolvedValue({ messageId: "must-not-publish" });
    const request = new Request(
      `https://gustavo.lol/api/conversations/${fixture.conversationId}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `__Host-gustavo-session=${fixture.sessionToken}`,
          origin: "https://gustavo.lol",
        },
        body: JSON.stringify({
          idempotencyKey: `hostile-funnel-${_label}`,
          text: "private hostile Funnel text",
        }),
      },
    );

    const response = await POST(request, {
      params: Promise.resolve({ conversationId: fixture.conversationId }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(202);
    expect(JSON.parse(responseText)).toMatchObject({ queued: true });
    expect(routeState.publishJSON).not.toHaveBeenCalled();
    expect(responseText).not.toContain(wakeUrl);
    expect(responseText).not.toMatch(/qstash-hostile-url-token|private hostile Funnel text/iu);
  }, 30_000);
});
