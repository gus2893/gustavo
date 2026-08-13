import { describe, expect, it } from "vitest";
import {
  BRIDGE_JOB_RETENTION_DAYS,
  BRIDGE_JOB_LEASE_MINUTES,
  BRIDGE_JOB_KINDS,
  BRIDGE_JOB_ROLES,
  BRIDGE_JOB_STATUSES,
  BRIDGE_ROLE_PRIORITIES,
  BRIDGE_SAFE_TERMINAL_CODES,
  claimNextBridgeJob,
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
  type BridgeCallerFailureCode,
  type MarketLatestQuoteRow,
  type MarketPollWindowRow,
  type HybridWorkerHeartbeatRow,
} from "../../lib/server/bridge/jobs";
import { appendEvent } from "../../lib/server/events/store";
import { appendMessage } from "../../lib/server/history/messages";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import { createConversationFixture, type ConversationFixture } from "../helpers/postgres";

const EXPECTED_STOCKS = "AAPL, MSFT, NVDA, AMZN, GOOGL, GOOG, META, TSLA, BRK.B, AVGO, JPM, LLY, V, XOM, MA, UNH, COST, WMT, NFLX, ORCL, HD, PG, JNJ, BAC, ABBV, KO, CRM, CVX, MRK, AMD, PLTR, CSCO, ACN, MCD, IBM, GE, CAT, GS, MS, AXP, BX, TMO, ISRG, LIN, ABT, DIS, NOW, QCOM, TXN, AMGN, DHR, PEP, PM, INTU, BKNG, RTX, AMAT, SPGI, NEE, LOW, UPS, HON, PFE, C, MU, SBUX, COP, SCHW, GILD, ADP, DE, BLK, PANW, LRCX, KLAC".split(", ");
const EXPECTED_ETFS = "SPY, QQQ, DIA, IWM, VTI, VO, VB, VOO, IVV, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, ARKK".split(", ");
const FORBIDDEN_JOB_FIELDS = ["prompt", "body", "output", "ciphertext"] as const;
const FORBIDDEN_MARKET_FIELDS = ["price", "quote", "body", "plaintext"] as const;

function forbiddenFieldIntersection(
  row: Readonly<Record<string, unknown>>,
  forbidden: readonly string[],
): readonly string[] {
  return Object.freeze(Object.keys(row).filter((key) => forbidden.includes(key)).sort());
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
    const node = await appendMessage(fixture, {
      idempotencyKey: "priority-node",
      role: "USER",
      text: "node",
    });
    const evaluator = await appendMessage(fixture, {
      idempotencyKey: "priority-evaluator",
      role: "USER",
      text: "evaluator",
    });
    const main = await appendMessage(fixture, {
      idempotencyKey: "priority-main",
      role: "USER",
      text: "main",
    });
    await fixture.db.transaction(async (transaction) => {
      await transaction.query(
        "alter table bridge_model_jobs disable trigger bridge_model_jobs_are_semantically_immutable",
      );
      try {
        await transaction.query(
          `update bridge_model_jobs
              set role='EVALUATOR',kind='EVALUATOR_REVIEW',priority=10
            where source_event_id=$1`,
          [evaluator.eventId],
        );
        await transaction.query(
          `update bridge_model_jobs
              set role='MAIN',kind='MAIN_GENERATION',priority=20
            where source_event_id=$1`,
          [main.eventId],
        );
      } finally {
        await transaction.query(
          "alter table bridge_model_jobs enable trigger bridge_model_jobs_are_semantically_immutable",
        );
      }
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
    expect(second).toMatchObject({ sourceEventId: evaluator.eventId, role: "EVALUATOR" });
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
    expect(third).toMatchObject({ sourceEventId: main.eventId, role: "MAIN" });
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
    const mismatched = await appendMessage(fixture, {
      idempotencyKey: "mismatched-correlation-output",
      role: "NODE",
      text: "wrong correlation",
      routingEventId: routed.routingEventId,
    });

    await expect(completeBridgeJob(fixture.db, {
      jobId: claim!.jobId,
      workerId: "local-v1",
      attemptCount: claim!.attemptCount,
      outputEventId: mismatched.eventId,
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
    const source = await appendMessage(fixture, {
      idempotencyKey: `${role.toLowerCase()}-closed-source`,
      role: "USER",
      text: "source",
    });
    await fixture.db.transaction(async (transaction) => {
      await transaction.query(
        "alter table bridge_model_jobs disable trigger bridge_model_jobs_are_semantically_immutable",
      );
      try {
        await transaction.query(
          "update bridge_model_jobs set role=$2,kind=$3,priority=$4 where source_event_id=$1",
          [source.eventId, role, kind, priority],
        );
      } finally {
        await transaction.query(
          "alter table bridge_model_jobs enable trigger bridge_model_jobs_are_semantically_immutable",
        );
      }
    });
    const claim = await claimNextBridgeJob(fixture.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:00:00Z"),
    });
    const sourceAuthority = await fixture.db.one<{
      readonly aggregate_id: string;
      readonly account_id: string;
      readonly correlation_id: string;
    }>(
      "select aggregate_id,account_id,correlation_id::text from events where id=$1",
      [source.eventId],
    );
    const output = await appendEvent(fixture.db, {
      aggregateId: sourceAuthority.aggregate_id,
      accountId: sourceAuthority.account_id,
      actor: { type: actorType, id: actorId },
      type: role === "MAIN" ? "bridge.main.output" : "bridge.evaluator.output",
      visibility: "SHARED",
      body: { protected: true },
      idempotencyKey: `bridge-${role.toLowerCase()}-permissive-output`,
      causationId: source.eventId,
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
