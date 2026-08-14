import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { MARKET_UNIVERSE } from "../../config/market-universe";
import * as envelope from "../../lib/server/crypto/envelope";
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import { appendEvent } from "../../lib/server/events/store";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  createFinnhubHttpClient,
  pollFinnhubWindow,
} from "../../lib/server/market-data/finnhub";
import {
  loadLatestMarket,
  materializeMarketObservation,
  storeLatestMarketWindow,
} from "../../lib/server/market-data/latest";
import {
  createMarketWindowPlan,
  marketWindowId,
  type PersistableMarketPollWindow,
} from "../../lib/server/market-data/session";
import {
  persistMarketPollWindow,
  reserveMarketPollWindow,
  runMarketPollWindow,
  writeMarketHeartbeat,
} from "../../worker/hybrid/market-poller";
import { createConversationFixture } from "../helpers/postgres";

const EXPECTED_STOCKS = "AAPL, MSFT, NVDA, AMZN, GOOGL, GOOG, META, TSLA, BRK.B, AVGO, JPM, LLY, V, XOM, MA, UNH, COST, WMT, NFLX, ORCL, HD, PG, JNJ, BAC, ABBV, KO, CRM, CVX, MRK, AMD, PLTR, CSCO, ACN, MCD, IBM, GE, CAT, GS, MS, AXP, BX, TMO, ISRG, LIN, ABT, DIS, NOW, QCOM, TXN, AMGN, DHR, PEP, PM, INTU, BKNG, RTX, AMAT, SPGI, NEE, LOW, UPS, HON, PFE, C, MU, SBUX, COP, SCHW, GILD, ADP, DE, BLK, PANW, LRCX, KLAC".split(", ");
const EXPECTED_ETFS = "SPY, QQQ, DIA, IWM, VTI, VO, VB, VOO, IVV, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, ARKK".split(", ");

function jsonHttpResponse(payload: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return new Response(bytes, {
    status,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

const AAPL_SUCCESS = Object.freeze({
  symbol: "AAPL",
  kind: "STOCK" as const,
  status: "SUCCESS" as const,
  price: "225.10",
  sourceObservedAt: "2026-08-13T13:30:00.000Z",
  safeCode: null,
});

async function databaseMarketWindowIds(database: EventDatabase): Promise<{
  readonly current: string;
  readonly past: string;
  readonly future: string;
}> {
  return database.one(
    `with database_clock as (
       select clock_timestamp() database_now
     ), current_window as (
       select date_bin(
         interval '5 minutes',database_now,timestamptz '1970-01-01 00:00:00+00'
       ) window_started_at
       from database_clock
     )
     select
       to_char(window_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI"Z"') current,
       to_char((window_started_at-interval '5 minutes') at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI"Z"') past,
       to_char((window_started_at+interval '5 minutes') at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI"Z"') future
     from current_window`,
  );
}

function observedDatabase(
  database: EventDatabase,
  observed: string[],
  failOn?: RegExp,
): EventDatabase {
  const wrap = (inner: EventDatabase): EventDatabase => ({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row[]> {
      observed.push(sql);
      if (failOn?.test(sql)) throw new Error("INJECTED_MARKET_WRITE_FAILURE");
      return inner.query<Row>(sql, parameters);
    },
    async one<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row> {
      observed.push(sql);
      if (failOn?.test(sql)) throw new Error("INJECTED_MARKET_WRITE_FAILURE");
      return inner.one<Row>(sql, parameters);
    },
    transaction: async <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      inner.transaction((transaction) => work(wrap(transaction)))
    ),
  });
  return wrap(database);
}

function databaseWithTransactionRole(
  database: EventDatabase,
  role: "gustavo_market_materializer",
): EventDatabase {
  return {
    query: (sql, parameters) => database.query(sql, parameters),
    one: (sql, parameters) => database.one(sql, parameters),
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      database.transaction(async (transaction) => {
        await transaction.query(`set local role ${role}`);
        return work(transaction);
      })
    ),
  };
}

function materializerContext(
  context: { readonly accountId: string; readonly db: EventDatabase },
  database: EventDatabase = context.db,
): { readonly accountId: string; readonly db: EventDatabase } {
  return {
    accountId: context.accountId,
    db: databaseWithTransactionRole(database, "gustavo_market_materializer"),
  };
}

function pauseAfterQuery(database: EventDatabase, marker: string): {
  readonly db: EventDatabase;
  readonly reached: Promise<void>;
  readonly release: () => void;
} {
  let reached!: () => void;
  let release!: () => void;
  let paused = false;
  const queryReached = new Promise<void>((resolve) => { reached = resolve; });
  const queryReleased = new Promise<void>((resolve) => { release = resolve; });
  const wrap = (inner: EventDatabase): EventDatabase => ({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row[]> {
      const rows = await inner.query<Row>(sql, parameters);
      if (!paused && sql.includes(marker)) {
        paused = true;
        reached();
        await queryReleased;
      }
      return rows;
    },
    one: (sql, parameters) => inner.one(sql, parameters),
    transaction: (work) => inner.transaction((transaction) => work(wrap(transaction))),
  });
  return { db: wrap(database), reached: queryReached, release };
}

function bypassQuery(database: EventDatabase, marker: string): EventDatabase {
  const wrap = (inner: EventDatabase): EventDatabase => ({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row[]> => sql.includes(marker)
      ? Promise.resolve([{} as Row])
      : inner.query<Row>(sql, parameters),
    one: (sql, parameters) => inner.one(sql, parameters),
    transaction: (work) => inner.transaction((transaction) => work(wrap(transaction))),
  });
  return wrap(database);
}

function signalBeforeQuery(database: EventDatabase, marker: string): {
  readonly db: EventDatabase;
  readonly reached: Promise<void>;
} {
  let reached!: () => void;
  let signaled = false;
  const queryReached = new Promise<void>((resolve) => { reached = resolve; });
  const wrap = (inner: EventDatabase): EventDatabase => ({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row[]> => {
      if (!signaled && sql.includes(marker)) {
        signaled = true;
        reached();
      }
      return inner.query<Row>(sql, parameters);
    },
    one: (sql, parameters) => inner.one(sql, parameters),
    transaction: (work) => inner.transaction((transaction) => work(wrap(transaction))),
  });
  return { db: wrap(database), reached: queryReached };
}

async function appendConsumptionCommand(
  fixture: Awaited<ReturnType<typeof createConversationFixture>>,
  symbol: string,
  latestContextDigest: string,
  suffix: string,
  overrides: {
    readonly accountId?: string;
    readonly aggregateId?: string;
    readonly actorId?: string;
    readonly body?: Record<string, string>;
    readonly type?: string;
    readonly visibility?: "PRIVATE_ACCOUNT" | "OPERATOR";
  } = {},
): Promise<string> {
  const body = overrides.body ?? { symbol, latestContextDigest };
  const bodyDigest = canonicalContentDigest(body);
  const event = await appendEvent(fixture.db, {
    aggregateId: overrides.aggregateId ?? `market-latest:${fixture.accountId}`,
    accountId: overrides.accountId ?? fixture.accountId,
    actor: { type: "SYSTEM", id: overrides.actorId ?? "gustavo-decision-orchestrator" },
    type: overrides.type ?? "market.observation.consumption.requested",
    visibility: overrides.visibility ?? "PRIVATE_ACCOUNT",
    body,
    idempotencyKey: `market-consumption-command:${suffix}:${bodyDigest}`,
    policyVersion: "decision-window-policy-v1",
  });
  return event.id;
}

describe("latest market projection", () => {
  it("upserts exactly one encrypted row per symbol and creates no observation until consumption", async () => {
    const fixture = await createConversationFixture("latest-market");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:35Z",
      items: [{
        ...AAPL_SUCCESS,
        price: "226.20",
        sourceObservedAt: "2026-08-13T13:35:00.000Z",
      }],
    });

    const raw = await fixture.db.query<Record<string, unknown>>(
      "select * from market_latest_quotes where account_id=$1 and symbol='AAPL'",
      [fixture.accountId],
    );
    const observations = await fixture.db.query("select id from market_observations");
    const latest = await loadLatestMarket(fixture, ["AAPL"]);

    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw[0])).not.toContain("226.20");
    expect(observations).toHaveLength(0);
    expect(latest[0]).toMatchObject({
      symbol: "AAPL",
      status: "SUCCESS",
      price: "226.20",
      windowId: "2026-08-13T13:35Z",
    });
  }, 30_000);

  it("stores the exact bounded 95-row topology including body-free unavailable states", async () => {
    const fixture = await createConversationFixture("latest-market-topology");
    const items = MARKET_UNIVERSE.map((catalog, index) => index === 0
      ? AAPL_SUCCESS
      : Object.freeze({
        ...catalog,
        status: "UNAVAILABLE" as const,
        price: null,
        sourceObservedAt: null,
        safeCode: "SYMBOL_UNAVAILABLE" as const,
      }));

    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items,
    });
    const rows = await fixture.db.query<{
      readonly symbol: string;
      readonly status: string;
      readonly data_key_id: string | null;
      readonly ciphertext: Buffer | null;
    }>(
      `select symbol,status,data_key_id,ciphertext from market_latest_quotes
        where account_id=$1 order by symbol`,
      [fixture.accountId],
    );
    const pollWindows = await fixture.db.query<Record<string, unknown>>(
      "select * from market_poll_windows where window_id='2026-08-13T13:30Z'",
    );

    expect(rows).toHaveLength(95);
    expect(rows.filter(({ status }) => status === "SUCCESS")).toHaveLength(1);
    expect(rows.filter(({ status }) => status === "UNAVAILABLE")).toHaveLength(94);
    expect(rows.filter(({ status }) => status !== "SUCCESS").every((row) => (
      row.data_key_id === null && row.ciphertext === null
    ))).toBe(true);
    expect(pollWindows).toHaveLength(1);
    expect(JSON.stringify({ rows, pollWindows })).not.toMatch(/225\.10|FINNHUB_API_KEY|raw.*provider/iu);
  }, 30_000);

  it("rejects stale and conflicting equal-window writes while replaying exact content", async () => {
    const fixture = await createConversationFixture("latest-market-monotonic");
    const newer = {
      ...AAPL_SUCCESS,
      price: "226.20",
      sourceObservedAt: "2026-08-13T13:35:00.000Z",
    };
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:35Z",
      items: [newer],
    });
    await expect(storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:35Z",
      items: [newer],
    })).resolves.toBeUndefined();
    await expect(storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:35Z",
      items: [{ ...newer, price: "999.99" }],
    })).rejects.toThrow("MARKET_LATEST_WINDOW_CONFLICT");
    await expect(storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    })).rejects.toThrow("MARKET_LATEST_STALE");

    expect(await loadLatestMarket(fixture, ["AAPL"])).toMatchObject([
      { price: "226.20", windowId: "2026-08-13T13:35Z" },
    ]);
  }, 30_000);

  it("serializes same-version races and leaves the newest monotonic row authoritative", async () => {
    const fixture = await createConversationFixture("latest-market-race");
    const first = storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const conflicting = storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [{ ...AAPL_SUCCESS, price: "225.11" }],
    });
    const outcomes = await Promise.allSettled([first, conflicting]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);

    await Promise.allSettled([
      storeLatestMarketWindow(fixture, {
        windowId: "2026-08-13T13:35Z",
        items: [{ ...AAPL_SUCCESS, price: "226.20", sourceObservedAt: "2026-08-13T13:35:00.000Z" }],
      }),
      storeLatestMarketWindow(fixture, {
        windowId: "2026-08-13T13:30Z",
        items: [AAPL_SUCCESS],
      }),
    ]);
    expect(await loadLatestMarket(fixture, ["AAPL"])).toMatchObject([
      { price: "226.20", windowId: "2026-08-13T13:35Z" },
    ]);
  }, 30_000);

  it("shares the canonical aggregate-key serializer with a concurrent first event append", async () => {
    const fixture = await createConversationFixture("latest-market-key-creation-race");
    const paused = pauseAfterQuery(fixture.db, "market-latest-body-lock");
    const storing = storeLatestMarketWindow({ ...fixture, db: paused.db }, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    await paused.reached;

    const aggregateId = `market-latest:${fixture.accountId}`;
    const signaled = signalBeforeQuery(fixture.db, "insert into aggregate_data_keys");
    const appending = appendEvent(signaled.db, {
      aggregateId,
      accountId: fixture.accountId,
      actor: { type: "SYSTEM", id: "market-key-race-test" },
      type: "market.key.race.tested",
      visibility: "PRIVATE_ACCOUNT",
      body: { purpose: "share-one-key" },
      idempotencyKey: `market-key-race:${randomUUID()}`,
    });
    await Promise.race([
      signaled.reached,
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    paused.release();

    const outcomes = await Promise.allSettled([storing, appending]);
    expect(outcomes.every(({ status }) => status === "fulfilled")).toBe(true);
    const keys = await fixture.db.query<{ readonly id: string } & Record<string, unknown>>(
      "select id::text from aggregate_data_keys where aggregate_id=$1",
      [aggregateId],
    );
    const references = await fixture.db.one<{
      readonly latest_key_id: string;
      readonly event_key_id: string;
    } & Record<string, unknown>>(
      `select latest.data_key_id::text latest_key_id,body.data_key_id::text event_key_id
         from market_latest_quotes latest
         join encrypted_event_bodies body on body.event_id=$2
        where latest.account_id=$1 and latest.symbol='AAPL'`,
      [fixture.accountId, outcomes[1].status === "fulfilled" ? outcomes[1].value.id : randomUUID()],
    );
    expect(keys).toHaveLength(1);
    expect(references.latest_key_id).toBe(keys[0].id);
    expect(references.event_key_id).toBe(keys[0].id);
  }, 30_000);

  it("zeroes a newly generated plaintext key when its durable insert rejects", async () => {
    const fixture = await createConversationFixture("latest-market-key-insert-failure");
    const aggregateId = `market-latest:${fixture.accountId}`;
    const generated = envelope.createAndWrapDataKey(aggregateId);
    const creation = vi.spyOn(envelope, "createAndWrapDataKey").mockReturnValue(generated);
    try {
      await expect(storeLatestMarketWindow({
        ...fixture,
        db: observedDatabase(fixture.db, [], /insert into aggregate_data_keys/iu),
      }, {
        windowId: "2026-08-13T13:30Z",
        items: [AAPL_SUCCESS],
      })).rejects.toThrow("INJECTED_MARKET_WRITE_FAILURE");
      expect([...generated.dataKey].every((byte) => byte === 0)).toBe(true);
    } finally {
      creation.mockRestore();
      generated.dataKey.fill(0);
    }
  }, 30_000);

  it("authorizes the account before key and body locks and never exposes a foreign latest row", async () => {
    const owner = await createConversationFixture("latest-market-owner");
    const other = await createConversationFixture("latest-market-other", owner.db);
    await storeLatestMarketWindow(owner, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });

    const observed: string[] = [];
    const loaded = await loadLatestMarket({
      ...owner,
      db: observedDatabase(owner.db, observed),
    }, ["AAPL"]);
    const authorization = observed.findIndex((sql) => sql.includes("market-account-authority"));
    const key = observed.findIndex((sql) => sql.includes("market-latest-key-lock"));
    const body = observed.findIndex((sql) => sql.includes("market-latest-body-lock"));
    expect(loaded[0]?.price).toBe("225.10");
    expect(authorization).toBeGreaterThanOrEqual(0);
    expect(key).toBeGreaterThan(authorization);
    expect(body).toBeGreaterThan(key);
    expect(observed[authorization]).toMatch(/account\.status='ACTIVE'/u);
    expect(observed[authorization]).toMatch(/entitlement\.expires_at is null/u);
    expect(observed[authorization]).toMatch(/for share of account,entitlement/u);
    expect(await loadLatestMarket(other, ["AAPL"])).toEqual([]);

    await owner.db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [owner.accountId]);
    await expect(loadLatestMarket(owner, ["AAPL"])).rejects.toThrow("MARKET_ACCOUNT_FORBIDDEN");
  }, 30_000);

  it.each([
    ["account suspension", "update accounts set status='SUSPENDED' where id=$1"],
    ["entitlement revocation", "update entitlements set revoked_at=clock_timestamp() where account_id=$1"],
  ])("holds both authority rows so a concurrent %s fails before protected reads", async (
    _label,
    mutationSql,
  ) => {
    const fixture = await createConversationFixture(`latest-authority-race-${_label}`);
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    let mutationReady!: () => void;
    let releaseMutation!: () => void;
    const ready = new Promise<void>((resolve) => { mutationReady = resolve; });
    const released = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutation = fixture.db.transaction(async (transaction) => {
      await transaction.query(mutationSql, [fixture.accountId]);
      mutationReady();
      await released;
    });
    await ready;

    const observed: string[] = [];
    const paused = pauseAfterQuery(
      observedDatabase(fixture.db, observed),
      "market-account-authority",
    );
    const reading = loadLatestMarket({ ...fixture, db: paused.db }, ["AAPL"]);
    const crossedAuthority = await Promise.race([
      paused.reached.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseMutation();
    await mutation;
    if (!crossedAuthority) await paused.reached;
    paused.release();

    await expect(reading).rejects.toThrow("MARKET_ACCOUNT_FORBIDDEN");
    expect(observed.some((sql) => sql.includes("market-latest-key-lock"))).toBe(false);
    expect(observed.some((sql) => sql.includes("market-latest-body-lock"))).toBe(false);
  }, 30_000);

  it("rechecks database-clock entitlement expiry after authorization and before protected reads", async () => {
    const fixture = await createConversationFixture("latest-authority-expiry-race");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    await fixture.db.query(
      `update entitlements
          set expires_at=clock_timestamp()+interval '150 milliseconds'
        where account_id=$1`,
      [fixture.accountId],
    );
    const observed: string[] = [];
    const paused = pauseAfterQuery(
      observedDatabase(fixture.db, observed),
      "market-account-authority",
    );
    const reading = loadLatestMarket({ ...fixture, db: paused.db }, ["AAPL"]);
    await paused.reached;
    await new Promise((resolve) => setTimeout(resolve, 250));
    paused.release();

    await expect(reading).rejects.toThrow("MARKET_ACCOUNT_FORBIDDEN");
    expect(observed.some((sql) => sql.includes("market-latest-key-lock"))).toBe(false);
    expect(observed.some((sql) => sql.includes("market-latest-body-lock"))).toBe(false);
  }, 30_000);

  it("rejects a metadata/body version skew caused by a concurrent newer success", async () => {
    const fixture = await createConversationFixture("latest-market-read-version-race");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const paused = pauseAfterQuery(fixture.db, "market-latest-metadata");
    const reading = loadLatestMarket({ ...fixture, db: paused.db }, ["AAPL"]);
    await paused.reached;
    await storeLatestMarketWindow({
      ...fixture,
      db: bypassQuery(fixture.db, "market-account-authority"),
    }, {
      windowId: "2026-08-13T13:35Z",
      items: [{
        ...AAPL_SUCCESS,
        price: "226.20",
        sourceObservedAt: "2026-08-13T13:35:00.000Z",
      }],
    });
    paused.release();

    await expect(reading).rejects.toThrow("MARKET_LATEST_VERSION_CHANGED");
    await expect(loadLatestMarket(fixture, ["AAPL"])).resolves.toMatchObject([
      { price: "226.20", windowId: "2026-08-13T13:35Z" },
    ]);
  }, 30_000);

  it("rejects direct SUCCESS inserts without a scoped data key", async () => {
    const fixture = await createConversationFixture("latest-null-key-insert");
    const windowId = "2026-08-13T13:30Z";
    await fixture.db.query(
      "insert into market_poll_windows (window_id,window_started_at) values ($1,$2)",
      [windowId, "2026-08-13T13:30:00.000Z"],
    );
    const contextDigest = canonicalContentDigest({
      accountId: fixture.accountId,
      provider: "FINNHUB",
      symbol: "AAPL",
      windowId,
    });
    await expect(fixture.db.query(
      `insert into market_latest_quotes (
         account_id,symbol,window_id,provider,status,source_observed_at,received_at,
         data_key_id,ciphertext,envelope_iv,envelope_auth_tag,envelope_encoding,
         context_digest,safe_code
       ) values ($1,'AAPL',$2,'FINNHUB','SUCCESS',$3,$3,null,
         decode('01','hex'),decode(repeat('00',12),'hex'),
         decode(repeat('00',16),'hex'),'canonical-json-v1',$4,null)`,
      [fixture.accountId, windowId, "2026-08-13T13:30:00.000Z", contextDigest],
    )).rejects.toThrow("MARKET_LATEST_KEY_REQUIRED");
  }, 30_000);

  it("permits cryptographic erasure after readers release privacy-compatible key locks", async () => {
    const fixture = await createConversationFixture("latest-market-erasure");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    await expect(loadLatestMarket(fixture, ["AAPL"])).resolves.toHaveLength(1);

    await expect(fixture.db.query(
      `update market_latest_quotes set data_key_id=null
        where account_id=$1 and symbol='AAPL'`,
      [fixture.accountId],
    )).rejects.toThrow("MARKET_LATEST_KEY_REQUIRED");

    await expect(fixture.db.query(
      "delete from aggregate_data_keys where aggregate_id=$1",
      [`market-latest:${fixture.accountId}`],
    )).resolves.toHaveLength(0);
    const erased = await fixture.db.one<{
      readonly data_key_id: string | null;
      readonly ciphertext: Buffer;
    }>(
      "select data_key_id::text,ciphertext from market_latest_quotes where account_id=$1 and symbol='AAPL'",
      [fixture.accountId],
    );
    expect(erased.data_key_id).toBeNull();
    expect(JSON.stringify(erased)).not.toContain("225.10");
    await expect(loadLatestMarket(fixture, ["AAPL"]))
      .rejects.toThrow("MARKET_LATEST_KEY_UNAVAILABLE");
  }, 30_000);

  it("rejects an unrelated nested trigger that imitates a key-erasure update", async () => {
    const fixture = await createConversationFixture("latest-market-nested-erasure");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    await fixture.db.query("create table market_latest_erasure_probe (account_id uuid not null)");
    await fixture.db.query(
      `create function imitate_market_latest_key_erasure() returns trigger
       language plpgsql as $$
       begin
         update market_latest_quotes set data_key_id=null
          where account_id=new.account_id and symbol='AAPL';
         return new;
       end;
       $$`,
    );
    await fixture.db.query(
      `create trigger market_latest_erasure_probe_nested
       after insert on market_latest_erasure_probe
       for each row execute function imitate_market_latest_key_erasure()`,
    );

    await expect(fixture.db.query(
      "insert into market_latest_erasure_probe (account_id) values ($1)",
      [fixture.accountId],
    )).rejects.toThrow("MARKET_LATEST_KEY_REQUIRED");
    const row = await fixture.db.one<{ readonly data_key_id: string } & Record<string, unknown>>(
      "select data_key_id::text from market_latest_quotes where account_id=$1 and symbol='AAPL'",
      [fixture.accountId],
    );
    expect(row.data_key_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await fixture.db.query(
      "select id from aggregate_data_keys where id=$1",
      [row.data_key_id],
    )).toHaveLength(1);
  }, 30_000);

  it("materializes exactly one canonical observation from an exact encrypted decision command", async () => {
    const fixture = await createConversationFixture("latest-market-consumption");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "exact",
    );

    const first = await materializeMarketObservation(
      materializerContext(fixture), { commandEventId },
    );
    const replay = await materializeMarketObservation(
      materializerContext(fixture), { commandEventId },
    );
    const observations = await fixture.db.query<Record<string, unknown>>(
      "select * from market_observations where id=$1",
      [first.observationId],
    );
    const bindings = await fixture.db.query<Record<string, unknown>>(
      "select * from market_observation_consumptions where command_event_id=$1",
      [commandEventId],
    );
    const commandAuthority = await fixture.db.one<{
      readonly topic: string;
      readonly payload: Record<string, string>;
      readonly body_digest: string;
    }>(
      `select outbox.topic,outbox.payload,body.body_digest
         from events event
         join encrypted_event_bodies body on body.event_id=event.id
         join transactional_outbox outbox on outbox.event_id=event.id
        where event.id=$1`,
      [commandEventId],
    );

    expect(replay).toEqual(first);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      id: first.observationId,
      symbol: "AAPL",
      asset_class: "US_STOCK",
      price: "225.10",
      provider: "finnhub",
      redistribution: "ACCOUNT_ONLY",
      account_id: fixture.accountId,
      decision_command_event_id: commandEventId,
      latest_context_digest: latest!.latestContextDigest,
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      latest_window_id: "2026-08-13T13:30Z",
      latest_data_key_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      latest_source_observed_at: new Date("2026-08-13T13:30:00.000Z"),
      latest_received_at: new Date("2026-08-13T13:30:00.000Z"),
    });
    expect(bindings[0]).not.toHaveProperty("observation_digest");
    expect(commandAuthority.topic).toBe("market.observation.consumption.requested");
    expect(commandAuthority.payload).toEqual({ eventId: commandEventId });
    expect(commandAuthority.body_digest).toBe(canonicalContentDigest({
      symbol: "AAPL",
      latestContextDigest: latest!.latestContextDigest,
    }));
    expect(JSON.stringify(bindings)).not.toContain("225.10");
  }, 30_000);

  it("permits only the separate materializer role to bind an exact consumed latest version", async () => {
    const fixture = await createConversationFixture("latest-market-role-boundary");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "role-boundary",
    );
    const roleAuthority = await fixture.db.one<{
      readonly canReadAccounts: boolean;
      readonly canUseSchema: boolean;
      readonly canWriteBinding: boolean;
      readonly canLogin: boolean;
      readonly inheritsPrivileges: boolean;
    } & Record<string, unknown>>(
      `select
         has_table_privilege('gustavo_market_materializer','accounts','SELECT') "canReadAccounts",
         has_schema_privilege('gustavo_market_materializer',current_schema(),'USAGE') "canUseSchema",
         has_table_privilege(
           'gustavo_market_materializer','market_observation_consumptions','INSERT'
         ) "canWriteBinding",
         role.rolcanlogin "canLogin",role.rolinherit "inheritsPrivileges"
       from pg_roles role where role.rolname='gustavo_market_materializer'`,
    );
    expect(roleAuthority).toEqual({
      canReadAccounts: true,
      canUseSchema: true,
      canWriteBinding: true,
      canLogin: false,
      inheritsPrivileges: false,
    });

    await expect(materializeMarketObservation({
      accountId: fixture.accountId,
      db: undefined as never,
    }, { commandEventId })).rejects.toThrow("MARKET_MATERIALIZER_ROLE_REQUIRED");
    await expect(materializeMarketObservation(fixture, { commandEventId }))
      .rejects.toThrow("MARKET_MATERIALIZER_ROLE_REQUIRED");
    await expect(materializeMarketObservation({
      ...fixture,
      db: databaseWithTransactionRole(fixture.db, "gustavo_market_materializer"),
    }, { commandEventId })).resolves.toMatchObject({
      commandEventId,
      symbol: "AAPL",
      latestContextDigest: latest!.latestContextDigest,
    });
  }, 30_000);

  it("normalizes every dangerous attribute on an existing materializer role", async () => {
    const fixture = await createConversationFixture("latest-materializer-hostile-attributes");
    await fixture.db.query(
      `alter role gustavo_market_materializer
       with login inherit superuser createdb createrole replication bypassrls`,
    );
    try {
      const normalized = await createConversationFixture("latest-materializer-normalized");
      const role = await normalized.db.one<{
        readonly rolbypassrls: boolean;
        readonly rolcanlogin: boolean;
        readonly rolcreatedb: boolean;
        readonly rolcreaterole: boolean;
        readonly rolinherit: boolean;
        readonly rolreplication: boolean;
        readonly rolsuper: boolean;
      } & Record<string, unknown>>(
        `select rolbypassrls,rolcanlogin,rolcreatedb,rolcreaterole,rolinherit,
                rolreplication,rolsuper
           from pg_roles where rolname='gustavo_market_materializer'`,
      );
      expect(role).toEqual({
        rolbypassrls: false,
        rolcanlogin: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolsuper: false,
      });
    } finally {
      await fixture.db.query(
        `alter role gustavo_market_materializer
         with nologin noinherit nosuperuser nocreatedb nocreaterole
              noreplication nobypassrls`,
      );
    }
  }, 30_000);

  it("rejects an existing materializer role that belongs to another role", async () => {
    const fixture = await createConversationFixture("latest-materializer-outgoing-membership");
    const parentRole = `gustavo_materializer_parent_${randomUUID().replaceAll("-", "")}`;
    await fixture.db.query(`create role ${parentRole} nologin`);
    await fixture.db.query(`grant ${parentRole} to gustavo_market_materializer`);
    try {
      await expect(createConversationFixture("latest-materializer-membership-rejected"))
        .rejects.toThrow("MARKET_MATERIALIZER_ROLE_MEMBERSHIP_INVALID");
    } finally {
      await fixture.db.query(`revoke ${parentRole} from gustavo_market_materializer`);
      await fixture.db.query(`drop role ${parentRole}`);
    }
  }, 30_000);

  it("preserves an inbound local-login membership while normalizing the permission role", async () => {
    const fixture = await createConversationFixture("latest-materializer-inbound-membership");
    const loginRole = `gustavo_materializer_login_${randomUUID().replaceAll("-", "")}`;
    await fixture.db.query(`create role ${loginRole} login`);
    await fixture.db.query(`grant gustavo_market_materializer to ${loginRole}`);
    try {
      await expect(createConversationFixture("latest-materializer-inbound-preserved"))
        .resolves.toMatchObject({ accountId: expect.any(String) });
      const membership = await fixture.db.one<{
        readonly inherited: boolean;
      } & Record<string, unknown>>(
        `select pg_has_role($1,'gustavo_market_materializer','MEMBER') inherited`,
        [loginRole],
      );
      expect(membership.inherited).toBe(true);
    } finally {
      await fixture.db.query(`revoke gustavo_market_materializer from ${loginRole}`);
      await fixture.db.query(`drop role ${loginRole}`);
    }
  }, 30_000);

  it("applies materializer write scope to an inbound login using inherited privileges", async () => {
    const fixture = await createConversationFixture("latest-materializer-inherited-scope");
    const loginRole = `gustavo_materializer_inherited_${randomUUID().replaceAll("-", "")}`;
    await fixture.db.query(`create role ${loginRole} login inherit`);
    await fixture.db.query(`grant gustavo_market_materializer to ${loginRole}`);
    try {
      await expect(fixture.db.transaction(async (transaction) => {
        await transaction.query(`set local role ${loginRole}`);
        await transaction.query(
          `insert into market_data_sources (provider,license_id,licensed,redistribution)
           values ('inherited-forged','inherited-forged',true,'ACCOUNT_ONLY')`,
        );
      })).rejects.toThrow("MARKET_MATERIALIZER_WRITE_SCOPE_INVALID");
    } finally {
      await fixture.db.query(`revoke gustavo_market_materializer from ${loginRole}`);
      await fixture.db.query(`drop role ${loginRole}`);
    }
  }, 30_000);

  it("exposes only the exact materializer write and lock ACL without PUBLIC grants", async () => {
    const fixture = await createConversationFixture("latest-materializer-exact-acl");
    const tableWrites = await fixture.db.query<{
      readonly privilege_type: string;
      readonly table_name: string;
    }>(
      `select table_name,privilege_type
         from information_schema.role_table_grants
        where table_schema=current_schema()
          and grantee='gustavo_market_materializer'
          and privilege_type<>'SELECT'
        order by table_name,privilege_type`,
    );
    const columnUpdates = await fixture.db.query<{
      readonly column_name: string;
      readonly table_name: string;
    }>(
      `select table_name,column_name
         from information_schema.role_column_grants
        where table_schema=current_schema()
          and grantee='gustavo_market_materializer'
          and privilege_type='UPDATE'
        order by table_name,column_name`,
    );
    const publicGrants = await fixture.db.query(
      `select table_name,privilege_type
         from information_schema.table_privileges
        where table_schema=current_schema() and grantee='PUBLIC'
          and table_name=any($1::text[])`,
      [[
        "market_data_sources",
        "market_instrument_allowlist",
        "market_observation_consumptions",
        "market_observations",
      ]],
    );
    const schemaAuthority = await fixture.db.one<{
      readonly canCreate: boolean;
      readonly canUse: boolean;
    } & Record<string, unknown>>(
      `select
         has_schema_privilege('gustavo_market_materializer',current_schema(),'CREATE') "canCreate",
         has_schema_privilege('gustavo_market_materializer',current_schema(),'USAGE') "canUse"`,
    );

    expect(tableWrites).toEqual([
      { table_name: "market_data_sources", privilege_type: "INSERT" },
      { table_name: "market_instrument_allowlist", privilege_type: "INSERT" },
      { table_name: "market_observation_consumptions", privilege_type: "INSERT" },
      { table_name: "market_observations", privilege_type: "INSERT" },
    ]);
    expect(columnUpdates).toEqual([
      { table_name: "accounts", column_name: "id" },
      { table_name: "aggregate_data_keys", column_name: "id" },
      { table_name: "entitlements", column_name: "id" },
      { table_name: "market_latest_quotes", column_name: "updated_at" },
      { table_name: "market_observation_consumptions", column_name: "command_event_id" },
    ]);
    expect(publicGrants).toEqual([]);
    expect(schemaAuthority).toEqual({ canCreate: false, canUse: true });
  }, 30_000);

  it("rejects a materializer-scoped allowlist insert outside the fixed catalog", async () => {
    const fixture = await createConversationFixture("latest-materializer-catalog-scope");
    await expect(databaseWithTransactionRole(
      fixture.db, "gustavo_market_materializer",
    ).transaction((transaction) => transaction.query(
      `insert into market_instrument_allowlist (symbol,asset_class,enabled)
       values ('NOTCATALOG','US_STOCK',true)`,
    ))).rejects.toThrow("MARKET_MATERIALIZER_WRITE_SCOPE_INVALID");
  }, 30_000);

  it("rejects a materializer-scoped market source outside fixed Finnhub authority", async () => {
    const fixture = await createConversationFixture("latest-materializer-source-scope");
    await expect(databaseWithTransactionRole(
      fixture.db, "gustavo_market_materializer",
    ).transaction((transaction) => transaction.query(
      `insert into market_data_sources (provider,license_id,licensed,redistribution)
       values ('forged-provider','forged-license',true,'ACCOUNT_ONLY')`,
    ))).rejects.toThrow("MARKET_MATERIALIZER_WRITE_SCOPE_INVALID");
  }, 30_000);

  it("rejects an unbound non-Finnhub observation from the materializer role", async () => {
    const fixture = await createConversationFixture("latest-materializer-observation-scope");
    await fixture.db.query(
      `insert into market_instrument_allowlist (symbol,asset_class,enabled)
       values ('AAPL','US_STOCK',true)`,
    );
    await fixture.db.query(
      `insert into market_data_sources (provider,license_id,licensed,redistribution)
       values ('legacy-feed','legacy-license',true,'INTERNAL_ONLY')`,
    );
    await expect(databaseWithTransactionRole(
      fixture.db, "gustavo_market_materializer",
    ).transaction((transaction) => transaction.query(
      `insert into market_observations (
         id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
         raw_source_ref,feed_status,delay_seconds,redistribution,session_state
       ) values ($1,'AAPL','US_STOCK','225.10',$2,$2,'legacy-feed',
                 'legacy-license',$3,'REALTIME',0,'INTERNAL_ONLY','OPEN')`,
      [randomUUID(), "2026-08-13T13:30:00.000Z", `legacy:${randomUUID()}`],
    ))).rejects.toThrow("MARKET_MATERIALIZER_WRITE_SCOPE_INVALID");
  }, 30_000);

  it("rejects an ordinary writer forging a matching binding and observation together", async () => {
    const fixture = await createConversationFixture("latest-market-role-forgery");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "role-forgery",
    );
    const observationId = randomUUID();

    await expect(fixture.db.transaction(async (transaction) => {
      await transaction.query(
        "insert into market_instrument_allowlist (symbol,asset_class,enabled) values ('AAPL','US_STOCK',true)",
      );
      await transaction.query(
        `insert into market_data_sources (provider,license_id,licensed,redistribution)
         values ('finnhub','finnhub-free-personal',true,'ACCOUNT_ONLY')`,
      );
      await transaction.query(
        `insert into market_observation_consumptions (
           command_event_id,account_id,symbol,latest_context_digest,observation_id
         ) values ($1,$2,'AAPL',$3::text,$4)`,
        [commandEventId, fixture.accountId, latest!.latestContextDigest, observationId],
      );
      await transaction.query(
        `insert into market_observations (
           id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
           raw_source_ref,feed_status,delay_seconds,redistribution,session_state,
           account_id,latest_context_digest,decision_command_event_id
         ) values ($1,'AAPL','US_STOCK','999.99',$2,$2,'finnhub',
                   'finnhub-free-personal',$3,'REALTIME',0,'ACCOUNT_ONLY','OPEN',$4,$5,$6)`,
        [observationId, "2026-08-13T13:30:00.000Z",
          `latest:${latest!.latestContextDigest}`, fixture.accountId,
          latest!.latestContextDigest, commandEventId],
      );
    })).rejects.toThrow("MARKET_MATERIALIZER_ROLE_REQUIRED");
  }, 30_000);

  it("rejects sub-millisecond T13 observation authority", async () => {
    const fixture = await createConversationFixture("latest-market-timestamp-precision");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "timestamp-precision",
    );
    const observationId = randomUUID();

    await expect(databaseWithTransactionRole(
      fixture.db, "gustavo_market_materializer",
    ).transaction(async (transaction) => {
      await transaction.query(
        "insert into market_instrument_allowlist (symbol,asset_class,enabled) values ('AAPL','US_STOCK',true)",
      );
      await transaction.query(
        `insert into market_data_sources (provider,license_id,licensed,redistribution)
         values ('finnhub','finnhub-free-personal',true,'ACCOUNT_ONLY')`,
      );
      await transaction.query(
        `insert into market_observation_consumptions (
           command_event_id,account_id,symbol,latest_context_digest,observation_id
         ) values ($1,$2,'AAPL',$3::text,$4)`,
        [commandEventId, fixture.accountId, latest!.latestContextDigest, observationId],
      );
      await transaction.query(
        `insert into market_observations (
           id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
           raw_source_ref,feed_status,delay_seconds,redistribution,session_state,
           account_id,latest_context_digest,decision_command_event_id
         ) values ($1,'AAPL','US_STOCK','225.10',$2,$2,'finnhub',
                   'finnhub-free-personal',$3,'REALTIME',0,'ACCOUNT_ONLY','OPEN',$4,$5,$6)`,
        [observationId, "2026-08-13T13:30:00.000002Z",
          `latest:${latest!.latestContextDigest}`, fixture.accountId,
          latest!.latestContextDigest, commandEventId],
      );
    })).rejects.toThrow("MARKET_OBSERVATION_TIMESTAMP_PRECISION_INVALID");
  }, 30_000);

  it.each([
    ["timestamps", {
      observedAt: "2026-08-13T13:31:00.000Z",
      receivedAt: "2026-08-13T13:31:00.000Z",
    }, "finnhub-free-personal", "ACCOUNT_ONLY"],
    ["license and raw reference", {
      licenseId: "finnhub-forged-personal",
      rawSourceRef: `latest:${"f".repeat(64)}`,
    }, "finnhub-forged-personal", "ACCOUNT_ONLY"],
    ["feed delay and session", {
      feedStatus: "DELAYED",
      delaySeconds: 60,
      sessionState: "AFTER_HOURS",
    }, "finnhub-free-personal", "ACCOUNT_ONLY"],
    ["redistribution", { redistribution: "INTERNAL_ONLY" },
      "finnhub-free-personal", "INTERNAL_ONLY"],
  ] as const)("rejects a direct observation forged in the %s semantic group", async (
    _label,
    overrides,
    sourceLicenseId,
    sourceRedistribution,
  ) => {
    const fixture = await createConversationFixture(`latest-observation-forgery-${_label}`);
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      `forged-${_label.replaceAll(" ", "-")}`,
    );
    const observationId = randomUUID();
    const canonical = {
      price: "225.10",
      observedAt: "2026-08-13T13:30:00.000Z",
      receivedAt: "2026-08-13T13:30:00.000Z",
      licenseId: "finnhub-free-personal",
      rawSourceRef: `latest:${latest!.latestContextDigest}`,
      feedStatus: "REALTIME",
      delaySeconds: 0,
      redistribution: "ACCOUNT_ONLY",
      sessionState: "OPEN",
      ...overrides,
    };
    await fixture.db.query(
      "insert into market_instrument_allowlist (symbol,asset_class,enabled) values ('AAPL','US_STOCK',true)",
    );
    await fixture.db.query(
      `insert into market_data_sources (provider,license_id,licensed,redistribution)
       values ('finnhub',$1,true,$2)`,
      [sourceLicenseId, sourceRedistribution],
    );
    await expect(databaseWithTransactionRole(
      fixture.db, "gustavo_market_materializer",
    ).transaction(async (transaction) => {
      await transaction.query(
        `insert into market_observation_consumptions (
           command_event_id,account_id,symbol,latest_context_digest,observation_id
         ) values ($1,$2,'AAPL',$3::text,$4)`,
        [commandEventId, fixture.accountId, latest!.latestContextDigest, observationId],
      );
      await transaction.query(
        `insert into market_observations (
           id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
           raw_source_ref,feed_status,delay_seconds,redistribution,session_state,
           account_id,latest_context_digest,decision_command_event_id
         ) values ($1,'AAPL','US_STOCK',$2,$3,$4,'finnhub',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [observationId, canonical.price, canonical.observedAt, canonical.receivedAt,
          canonical.licenseId, canonical.rawSourceRef, canonical.feedStatus,
          canonical.delaySeconds, canonical.redistribution, canonical.sessionState,
          fixture.accountId, latest!.latestContextDigest, commandEventId],
      );
    })).rejects.toThrow("MARKET_OBSERVATION_SEMANTICS_INVALID");
  }, 30_000);

  it("rejects replay when a stored observation no longer matches its bound price and version", async () => {
    const fixture = await createConversationFixture("latest-observation-replay-semantics");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "replay-semantics",
    );
    const materialized = await materializeMarketObservation(
      materializerContext(fixture), { commandEventId },
    );
    try {
      await fixture.db.query(
        "alter table market_observations disable trigger market_observations_immutable",
      );
      await fixture.db.query(
        "update market_observations set price='999.99' where id=$1",
        [materialized.observationId],
      );
    } finally {
      await fixture.db.query(
        "alter table market_observations enable trigger market_observations_immutable",
      );
    }
    const observed: string[] = [];
    await expect(materializeMarketObservation(materializerContext(
      fixture,
      observedDatabase(fixture.db, observed),
    ), { commandEventId }))
      .rejects.toThrow("MARKET_CONSUMPTION_REPLAY_INVALID");
    expect(observed.some((sql) => sql.includes("market-latest-key-lock"))).toBe(true);
    expect(observed.some((sql) => sql.includes("market-latest-body-lock"))).toBe(true);
  }, 30_000);

  it("rejects replay after the mutable latest row advances past the bound version", async () => {
    const fixture = await createConversationFixture("latest-observation-replay-advanced");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "replay-advanced",
    );
    const materialized = await materializeMarketObservation(
      materializerContext(fixture), { commandEventId },
    );
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:35Z",
      items: [{
        ...AAPL_SUCCESS,
        price: "226.20",
        sourceObservedAt: "2026-08-13T13:35:00.000Z",
      }],
    });

    await expect(materializeMarketObservation(
      materializerContext(fixture), { commandEventId },
    )).rejects.toThrow("MARKET_LATEST_VERSION_UNAVAILABLE");
    expect(await fixture.db.query(
      "select id from market_observations where decision_command_event_id=$1",
      [commandEventId],
    )).toEqual([{ id: materialized.observationId }]);
  }, 30_000);

  it("permits cryptographic erasure of a consumed latest binding without mutable replay", async () => {
    const fixture = await createConversationFixture("latest-consumption-erasure");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "consumption-erasure",
    );
    const materialized = await materializeMarketObservation(
      materializerContext(fixture), { commandEventId },
    );
    const key = await fixture.db.one<{ readonly id: string } & Record<string, unknown>>(
      "select id::text from aggregate_data_keys where aggregate_id=$1",
      [`market-latest:${fixture.accountId}`],
    );

    await expect(fixture.db.query(
      `update market_observation_consumptions set latest_data_key_id=null
        where command_event_id=$1`,
      [commandEventId],
    )).rejects.toThrow("IMMUTABLE_MARKET_OBSERVATION_CONSUMPTION");
    await fixture.db.query("delete from aggregate_data_keys where id=$1", [key.id]);

    const binding = await fixture.db.one<{
      readonly latest_data_key_id: string | null;
    } & Record<string, unknown>>(
      `select latest_data_key_id::text from market_observation_consumptions
        where command_event_id=$1`,
      [commandEventId],
    );
    expect(binding.latest_data_key_id).toBeNull();
    expect(await fixture.db.query(
      "select id from market_observations where id=$1",
      [materialized.observationId],
    )).toHaveLength(1);
    await expect(materializeMarketObservation(
      materializerContext(fixture), { commandEventId },
    )).rejects.toThrow("MARKET_CONSUMPTION_COMMAND_INVALID");
  }, 30_000);

  it("serializes concurrent consumption replay to one durable observation", async () => {
    const fixture = await createConversationFixture("latest-market-consumption-race");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "race",
    );

    const paused = pauseAfterQuery(fixture.db, "from market_observation_consumptions");
    const firstPromise = materializeMarketObservation(
      materializerContext(fixture, paused.db),
      { commandEventId },
    );
    await paused.reached;
    let second: Awaited<ReturnType<typeof materializeMarketObservation>>;
    try {
      second = await materializeMarketObservation(
        materializerContext(fixture), { commandEventId },
      );
    } finally {
      paused.release();
    }
    const first = await firstPromise;
    expect(second).toEqual(first);
    expect(await fixture.db.query(
      "select id from market_observations where decision_command_event_id=$1",
      [commandEventId],
    )).toHaveLength(1);
    expect(await fixture.db.query(
      "select command_event_id from market_observation_consumptions where command_event_id=$1",
      [commandEventId],
    )).toHaveLength(1);
  }, 30_000);

  it("returns a stable conflict for concurrent commands consuming one latest version", async () => {
    const fixture = await createConversationFixture("latest-market-distinct-command-race");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const firstCommandEventId = await appendConsumptionCommand(
      fixture, "AAPL", latest!.latestContextDigest, "distinct-race-first",
    );
    const secondCommandEventId = await appendConsumptionCommand(
      fixture, "AAPL", latest!.latestContextDigest, "distinct-race-second",
    );
    const paused = pauseAfterQuery(fixture.db, "from market_observation_consumptions");
    const firstResult = materializeMarketObservation(
      materializerContext(fixture, paused.db),
      { commandEventId: firstCommandEventId },
    ).then(
      () => ({ message: "resolved" }),
      (error: unknown) => ({ message: error instanceof Error ? error.message : "unknown" }),
    );
    await paused.reached;
    const second = await materializeMarketObservation(
      materializerContext(fixture), { commandEventId: secondCommandEventId },
    );
    paused.release();

    await expect(firstResult).resolves.toEqual({
      message: "MARKET_LATEST_VERSION_ALREADY_CONSUMED",
    });
    expect(await fixture.db.query(
      "select command_event_id::text from market_observation_consumptions",
    )).toEqual([{ command_event_id: secondCommandEventId }]);
    expect(await fixture.db.query(
      "select id::text from market_observations where id=$1",
      [second.observationId],
    )).toHaveLength(1);
  }, 30_000);

  it("rejects malformed, extra-field, foreign-account, and stale-version consumption authority", async () => {
    const owner = await createConversationFixture("latest-consumption-owner");
    const other = await createConversationFixture("latest-consumption-other", owner.db);
    await storeLatestMarketWindow(owner, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(owner, ["AAPL"]);
    const malformed = await appendConsumptionCommand(
      owner,
      "AAPL",
      latest!.latestContextDigest,
      "extra",
      { body: { symbol: "AAPL", latestContextDigest: latest!.latestContextDigest, extra: "forbidden" } },
    );
    const stale = await appendConsumptionCommand(
      owner,
      "AAPL",
      "f".repeat(64),
      "stale",
    );
    const foreign = await appendConsumptionCommand(
      other,
      "AAPL",
      latest!.latestContextDigest,
      "foreign",
    );

    await expect(materializeMarketObservation(
      materializerContext(owner), { commandEventId: malformed },
    ))
      .rejects.toThrow("MARKET_CONSUMPTION_COMMAND_INVALID");
    await expect(materializeMarketObservation(
      materializerContext(owner), { commandEventId: stale },
    ))
      .rejects.toThrow("MARKET_LATEST_VERSION_UNAVAILABLE");
    await expect(materializeMarketObservation(
      materializerContext(owner), { commandEventId: foreign },
    ))
      .rejects.toThrow("MARKET_CONSUMPTION_COMMAND_INVALID");
    expect(await owner.db.query("select id from market_observations")).toHaveLength(0);
  }, 30_000);

  it("rejects direct observations without consumption provenance and rolls back partial writes", async () => {
    const fixture = await createConversationFixture("latest-consumption-rollback");
    await storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [AAPL_SUCCESS],
    });
    const [latest] = await loadLatestMarket(fixture, ["AAPL"]);
    const commandEventId = await appendConsumptionCommand(
      fixture,
      "AAPL",
      latest!.latestContextDigest,
      "rollback",
    );

    await expect(fixture.db.query(
      `insert into market_observations (
         id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
         raw_source_ref,feed_status,delay_seconds,redistribution,session_state
       ) values ($1,'AAPL','US_STOCK','225.10','2026-08-13T13:30:00Z',
         '2026-08-13T13:30:00Z','finnhub','finnhub-free-personal',$2,
         'REALTIME',0,'ACCOUNT_ONLY','OPEN')`,
      [randomUUID(), `forged:${randomUUID()}`],
    )).rejects.toThrow("MARKET_OBSERVATION_PROVENANCE_REQUIRED");

    const observed: string[] = [];
    await expect(materializeMarketObservation(materializerContext(
      fixture,
      observedDatabase(fixture.db, observed, /insert into market_observations/iu),
    ), { commandEventId })).rejects.toThrow("INJECTED_MARKET_WRITE_FAILURE");
    expect(await fixture.db.query(
      "select * from market_observation_consumptions where command_event_id=$1",
      [commandEventId],
    )).toHaveLength(0);
    expect(await fixture.db.query("select id from market_observations")).toHaveLength(0);
  }, 30_000);

  it("keeps provider keys, raw responses, and hostile values out of rows and safe errors", async () => {
    const fixture = await createConversationFixture("latest-market-safe-errors");
    const privateValue = "provider-key-private-813";
    await expect(storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [{ ...AAPL_SUCCESS, price: privateValue }],
    })).rejects.toThrow("MARKET_LATEST_INPUT_INVALID");
    await expect(storeLatestMarketWindow(fixture, {
      windowId: "2026-08-13T13:30Z",
      items: [{
        ...AAPL_SUCCESS,
        status: "PROVIDER_ERROR" as const,
        price: null,
        sourceObservedAt: null,
        safeCode: privateValue as never,
      }],
    })).rejects.toThrow("MARKET_LATEST_INPUT_INVALID");
    const rows = await fixture.db.query<Record<string, unknown>>(
      "select * from market_latest_quotes where account_id=$1",
      [fixture.accountId],
    );
    expect(JSON.stringify(rows)).not.toContain(privateValue);
  }, 30_000);
});

describe("Finnhub market window", () => {
  it("freezes the approved 75 stocks and 20 ETFs within 96 calls and 300 seconds", () => {
    const plan = createMarketWindowPlan(new Date("2026-08-13T13:30:00.000Z"));
    const stocks = MARKET_UNIVERSE.filter((item) => item.kind === "STOCK");
    const etfs = MARKET_UNIVERSE.filter((item) => item.kind === "ETF");

    expect(MARKET_UNIVERSE).toHaveLength(95);
    expect(stocks).toHaveLength(75);
    expect(etfs).toHaveLength(20);
    expect(stocks.map((item) => item.symbol)).toEqual(EXPECTED_STOCKS);
    expect(etfs.map((item) => item.symbol)).toEqual(EXPECTED_ETFS);
    expect(new Set(MARKET_UNIVERSE.map((item) => item.symbol)).size).toBe(95);
    expect(MARKET_UNIVERSE[0]?.symbol).toBe("AAPL");
    expect(MARKET_UNIVERSE.at(-1)?.symbol).toBe("ARKK");

    expect(plan.marketOpen).toBe(true);
    expect(plan.totalCalls).toBe(96);
    expect(plan.resultCount).toBe(95);
    expect(plan.marketStatusStart.toISOString()).toBe("2026-08-13T13:30:00.000Z");
    expect(plan.windowEndsAt.getTime() - plan.windowStartsAt.getTime()).toBe(300_000);
    expect(plan.quoteStarts).toHaveLength(95);
    expect(plan.quoteStarts[0]!.getTime() - plan.windowStartsAt.getTime()).toBe(3_000);
    expect(plan.quoteStarts.at(-1)!.getTime() - plan.windowStartsAt.getTime()).toBe(285_000);
    expect(plan.quoteStarts.at(-1)!.getTime() - plan.quoteStarts[0]!.getTime()).toBe(282_000);
    expect(plan.quoteStarts.every((time, index, all) => (
      index === 0 || time.getTime() - all[index - 1]!.getTime() >= 3_000
    ))).toBe(true);
  });

  it("contains no duplicate, malformed, unsupported, or mutable catalog entries", () => {
    const approved = [...EXPECTED_STOCKS, ...EXPECTED_ETFS];
    expect(MARKET_UNIVERSE.map((item) => item.symbol)).toEqual(approved);
    expect(MARKET_UNIVERSE.every((item) => /^[A-Z][A-Z0-9.]*$/.test(item.symbol))).toBe(true);
    expect(MARKET_UNIVERSE.every((item) => item.symbol === item.symbol.trim())).toBe(true);
    expect(MARKET_UNIVERSE.every((item) => (
      Object.keys(item).sort().join(",") === "kind,symbol"
    ))).toBe(true);
    expect(Object.isFrozen(MARKET_UNIVERSE)).toBe(true);
    expect(MARKET_UNIVERSE.every(Object.isFrozen)).toBe(true);

    const first = MARKET_UNIVERSE[0]!;
    expect(Reflect.set(first, "symbol", "TSLA")).toBe(false);
    expect(Reflect.set(MARKET_UNIVERSE, MARKET_UNIVERSE.length, {
      symbol: "BTCUSD",
      kind: "STOCK",
    })).toBe(false);
    expect(MARKET_UNIVERSE[0]).toEqual({ symbol: "AAPL", kind: "STOCK" });
    expect(MARKET_UNIVERSE).toHaveLength(95);

    expectTypeOf(MARKET_UNIVERSE).toMatchTypeOf<
      readonly Readonly<{ readonly symbol: string; readonly kind: "STOCK" | "ETF" }>[]
    >();
    if (false) {
      // @ts-expect-error the exported catalog cannot be extended
      MARKET_UNIVERSE.push({ symbol: "BTCUSD", kind: "STOCK" });
      // @ts-expect-error catalog entries are read-only
      MARKET_UNIVERSE[0].symbol = "TSLA";
    }
  });

  it("returns an explicit no-quote plan outside the regular US session", () => {
    for (const instant of [
      "2026-08-13T13:29:59.999Z", // 09:29:59.999 EDT
      "2026-08-13T20:00:00.000Z", // 16:00 EDT
      "2026-08-15T14:00:00.000Z", // Saturday
    ]) {
      const plan = createMarketWindowPlan(new Date(instant));
      expect(plan.marketOpen).toBe(false);
      expect(plan.totalCalls).toBe(1);
      expect(plan.resultCount).toBe(95);
      expect(plan.quoteStarts).toEqual([]);
      expect(plan.marketStatusStart.toISOString()).toBe(instant);
    }
  });

  it("uses New York clock boundaries across daylight-saving changes", () => {
    const summerOpen = createMarketWindowPlan(new Date("2026-08-13T13:30:00.000Z"));
    const winterOpen = createMarketWindowPlan(new Date("2026-01-05T14:30:00.000Z"));
    const summerLastMoment = createMarketWindowPlan(new Date("2026-08-13T19:59:59.999Z"));
    const winterLastMoment = createMarketWindowPlan(new Date("2026-01-05T20:59:59.999Z"));

    expect([summerOpen, winterOpen, summerLastMoment, winterLastMoment]
      .every((plan) => plan.marketOpen)).toBe(true);
    expect(createMarketWindowPlan(new Date("2026-01-05T21:00:00.000Z")).marketOpen).toBe(false);
  });

  it("rejects invalid clocks and does not mutate its input or leak mutable schedule state", () => {
    expect(() => createMarketWindowPlan(new Date(Number.NaN))).toThrow("MARKET_WINDOW_START_INVALID");

    const input = new Date("2026-08-13T13:30:00.000Z");
    const plan = createMarketWindowPlan(input);
    input.setTime(0);
    const returnedStarts = plan.quoteStarts;
    returnedStarts[0]!.setTime(0);

    expect(plan.windowStartsAt.toISOString()).toBe("2026-08-13T13:30:00.000Z");
    expect(plan.quoteStarts[0]!.toISOString()).toBe("2026-08-13T13:30:03.000Z");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.quoteStarts)).toBe(true);
  });
});

describe("Finnhub adapter", () => {
  it("returns exactly 95 bounded results and never starts call 97", async () => {
    const starts: number[] = [];
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string) => {
      starts.push(now);
      return symbol === "BRK.B"
        ? { status: 429 as const }
        : { status: 200 as const, json: { c: 100.25, t: 1_776_089_600 } };
    });
    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      timeoutMs: 2_500,
    });

    expect(result.items).toHaveLength(95);
    expect(fetchQuote).toHaveBeenCalledTimes(95);
    expect(starts.every((value, index) => index === 0 || value - starts[index - 1]! >= 3_000)).toBe(true);
    expect(result.items.find((item) => item.symbol === "BRK.B")?.status).toBe("RATE_LIMITED");
    expect(result.callsUsed).toBe(96);
  });

  it("returns the fixed ordered catalog and uses only the market-status call when closed", async () => {
    const fetchQuote = vi.fn();
    const sleep = vi.fn();

    const result = await pollFinnhubWindow({
      marketOpen: false,
      fetchQuote,
      sleep,
      now: () => 0,
      timeoutMs: 2_500,
    });

    expect(result.callsUsed).toBe(1);
    expect(result.items.map((item) => item.symbol)).toEqual(
      MARKET_UNIVERSE.map((item) => item.symbol),
    );
    expect(result.items).toHaveLength(95);
    expect(result.items.every((item) => (
      item.status === "UNAVAILABLE"
      && item.price === null
      && item.sourceObservedAt === null
      && item.safeCode === "MARKET_CLOSED"
    ))).toBe(true);
    expect(fetchQuote).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("paces all starts at least three seconds apart and aborts a quote below three seconds", async () => {
    let now = 0;
    const starts: number[] = [];
    const signals: AbortSignal[] = [];
    const fetchQuote = vi.fn((symbol: string, signal: AbortSignal) => {
      starts.push(now);
      signals.push(signal);
      if (symbol !== "AAPL") {
        return Promise.resolve({ status: 200, json: { c: 10, t: 1_776_089_600 } });
      }
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("private timeout detail")), {
          once: true,
        });
      });
    });

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 5,
    });

    expect(fetchQuote).toHaveBeenCalledTimes(95);
    expect(starts[0]).toBeGreaterThanOrEqual(3_000);
    expect(starts.every((value, index) => (
      index === 0 || value - starts[index - 1]! >= 3_000
    ))).toBe(true);
    expect(signals).toHaveLength(95);
    expect(signals[0]?.aborted).toBe(true);
    expect(result.items[0]).toMatchObject({
      symbol: "AAPL",
      status: "PROVIDER_ERROR",
      safeCode: "PROVIDER_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain("private timeout detail");
  });

  it("maps unavailable, stale, rate-limited, malformed, and network results without dropping symbols", async () => {
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string) => {
      switch (symbol) {
        case "AAPL": return { status: 200, json: { c: 225.1, t: 200 } };
        case "MSFT": return { status: 200, json: { c: 0, t: 200 } };
        case "NVDA": return { status: 200, json: { t: 200 } };
        case "AMZN": return { status: 200, json: { c: 10, t: 99 } };
        case "GOOGL": return { status: 404, json: { error: "unknown symbol" } };
        case "GOOG": return { status: 429, json: { error: "limit" } };
        case "META": return { status: 200, json: "not-json-object" };
        case "TSLA": return { status: 200, malformed: true };
        case "BRK.B": throw new Error("network url token=private-key");
        case "AVGO": return { status: 200, json: { c: 0.000_000_001, t: 200 } };
        default: return { status: 503, json: { error: "downstream detail" } };
      }
    });

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 2_500,
      minimumSourceTimestampSeconds: 100,
    });

    expect(result.items).toHaveLength(95);
    expect(result.items.map((item) => item.symbol)).toEqual(
      MARKET_UNIVERSE.map((item) => item.symbol),
    );
    expect(result.items[0]).toMatchObject({
      symbol: "AAPL",
      kind: "STOCK",
      status: "SUCCESS",
      price: "225.1",
      sourceObservedAt: "1970-01-01T00:03:20.000Z",
      safeCode: null,
    });
    for (const symbol of ["MSFT", "NVDA", "GOOGL"]) {
      expect(result.items.find((item) => item.symbol === symbol)).toMatchObject({
        status: "UNAVAILABLE",
        safeCode: "SYMBOL_UNAVAILABLE",
      });
    }
    expect(result.items.find((item) => item.symbol === "AMZN")).toMatchObject({
      status: "UNAVAILABLE",
      safeCode: "STALE_QUOTE",
    });
    expect(result.items.find((item) => item.symbol === "GOOG")).toMatchObject({
      status: "RATE_LIMITED",
      safeCode: "RATE_LIMITED",
    });
    for (const symbol of ["META", "TSLA", "AVGO"]) {
      expect(result.items.find((item) => item.symbol === symbol)).toMatchObject({
        status: "PROVIDER_ERROR",
        safeCode: "MALFORMED_RESPONSE",
      });
    }
    expect(result.items.find((item) => item.symbol === "BRK.B")).toMatchObject({
      status: "PROVIDER_ERROR",
      safeCode: "PROVIDER_ERROR",
    });
    expect(JSON.stringify(result)).not.toMatch(/private-key|downstream detail|unknown symbol/);
  });

  it("finalizes every missing symbol after a pacing failure without spending unmade calls", async () => {
    let now = 0;
    let sleepCount = 0;
    const fetchQuote = vi.fn(async () => ({
      status: 200,
      json: { c: 10, t: 1_776_089_600 },
    }));

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => {
        sleepCount += 1;
        if (sleepCount === 3) throw new Error("scheduler private detail");
        now += milliseconds;
      },
      now: () => now,
      wallNow: () => 1_776_089_600_000,
      timeoutMs: 2_500,
    });

    expect(result.items).toHaveLength(95);
    expect(result.items.map((item) => item.symbol)).toEqual(
      MARKET_UNIVERSE.map((item) => item.symbol),
    );
    expect(fetchQuote).toHaveBeenCalledTimes(2);
    expect(result.callsUsed).toBe(3);
    expect(result.items.slice(0, 2).every((item) => item.status === "SUCCESS")).toBe(true);
    expect(result.items.slice(2).every((item) => (
      item.status === "PROVIDER_ERROR" && item.safeCode === "PROVIDER_ERROR"
    ))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("scheduler private detail");
  });

  it("does not start a quote after the fixed five-minute window deadline", async () => {
    let now = 0;
    const fetchQuote = vi.fn(async () => ({
      status: 200,
      json: { c: 10, t: 1_776_089_600 },
    }));

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds + 300_000; },
      now: () => now,
      timeoutMs: 2_500,
    });

    expect(fetchQuote).not.toHaveBeenCalled();
    expect(result.callsUsed).toBe(1);
    expect(result.items).toHaveLength(95);
    expect(result.items.every((item) => (
      item.status === "PROVIDER_ERROR" && item.safeCode === "PROVIDER_ERROR"
    ))).toBe(true);
  });

  it("maps an injected provider status call before deciding whether quotes may start", async () => {
    let now = 0;
    const fetchMarketStatus = vi.fn(async () => ({
      status: 200,
      json: { isOpen: false },
    }));
    const fetchQuote = vi.fn();

    const result = await pollFinnhubWindow({
      fetchMarketStatus,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 2_500,
    });

    expect(fetchMarketStatus).toHaveBeenCalledOnce();
    expect(fetchQuote).not.toHaveBeenCalled();
    expect(result.callsUsed).toBe(1);
    expect(result.items.every((item) => item.safeCode === "MARKET_CLOSED")).toBe(true);
  });

  it("accepts only bounded future skew within the active window", async () => {
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string) => {
      if (symbol === "AAPL") return { status: 200, json: { c: 10, t: 8 } };
      if (symbol === "MSFT") return { status: 200, json: { c: 10, t: 12 } };
      return { status: 200, json: { c: 10, t: Math.floor(now / 1_000) } };
    });

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      wallNow: () => now,
      timeoutMs: 2_500,
    });

    expect(result.items.find((item) => item.symbol === "AAPL")).toMatchObject({
      status: "SUCCESS",
      sourceObservedAt: "1970-01-01T00:00:08.000Z",
      safeCode: null,
    });
    expect(result.items.find((item) => item.symbol === "MSFT")).toMatchObject({
      status: "PROVIDER_ERROR",
      sourceObservedAt: null,
      safeCode: "MALFORMED_RESPONSE",
    });
  });

  it("defaults the stale floor to the source window while preserving an explicit override", async () => {
    let pacingNow = 0;
    const sourceWindowStartedAt = 100_000;
    const fetchQuote = vi.fn(async (symbol: string) => ({
      status: 200,
      json: { c: 10, t: symbol === "AAPL" ? 99 : 100 },
    }));

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { pacingNow += milliseconds; },
      now: () => pacingNow,
      wallNow: () => sourceWindowStartedAt,
      timeoutMs: 2_500,
    });

    expect(result.items.find((item) => item.symbol === "AAPL")).toMatchObject({
      status: "UNAVAILABLE",
      sourceObservedAt: null,
      safeCode: "STALE_QUOTE",
    });
    expect(result.items.find((item) => item.symbol === "MSFT")).toMatchObject({
      status: "SUCCESS",
      sourceObservedAt: "1970-01-01T00:01:40.000Z",
      safeCode: null,
    });

    const overridden = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { pacingNow += milliseconds; },
      now: () => pacingNow,
      wallNow: () => sourceWindowStartedAt,
      timeoutMs: 2_500,
      minimumSourceTimestampSeconds: 99,
    });
    expect(overridden.items.find((item) => item.symbol === "AAPL")?.status).toBe("SUCCESS");
  });

  it("contains hostile fulfilled provider values as safe malformed results", async () => {
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string): Promise<unknown> => {
      if (symbol === "AAPL") return null;
      if (symbol === "MSFT") return 7;
      if (symbol === "NVDA") {
        return Object.defineProperty({}, "status", {
          get() { throw new Error("private status getter detail"); },
        });
      }
      if (symbol === "AMZN") {
        return Object.defineProperty({ status: 200 }, "json", {
          get() { throw new Error("private json getter detail"); },
        });
      }
      if (symbol === "GOOGL") {
        return new Proxy({}, {
          getPrototypeOf() { throw new Error("private proxy detail"); },
        });
      }
      if (symbol === "GOOG") {
        return {
          status: 200,
          json: new Proxy({}, {
            getOwnPropertyDescriptor() { throw new Error("private nested proxy detail"); },
          }),
        };
      }
      return { status: 200, json: { c: 10, t: Math.floor(now / 1_000) } };
    });

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 2_500,
    });

    for (const symbol of ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG"]) {
      expect(result.items.find((item) => item.symbol === symbol)).toMatchObject({
        status: "PROVIDER_ERROR",
        price: null,
        sourceObservedAt: null,
        safeCode: "MALFORMED_RESPONSE",
      });
    }
    expect(JSON.stringify(result)).not.toMatch(/private status|private json|private (?:nested )?proxy/);

    const statusResult = await pollFinnhubWindow({
      fetchMarketStatus: async () => new Proxy({}, {
        getPrototypeOf() { throw new Error("private status proxy detail"); },
      }),
      fetchQuote: vi.fn(),
      sleep: async () => undefined,
      now: () => 0,
      timeoutMs: 2_500,
    });
    expect(statusResult.items.every((item) => (
      item.status === "PROVIDER_ERROR" && item.safeCode === "MALFORMED_RESPONSE"
    ))).toBe(true);
  });

  it("bounds streamed HTTP JSON and cancels every rejected body exactly once", async () => {
    const encoder = new TextEncoder();
    const makeStreamResponse = (
      chunks: readonly Uint8Array[],
      headers: HeadersInit,
      status = 200,
    ) => {
      let index = 0;
      const cancel = vi.fn(async () => undefined);
      const read = vi.fn(async () => (
        index < chunks.length
          ? { done: false as const, value: chunks[index++]! }
          : { done: true as const, value: undefined }
      ));
      const body = {
        cancel,
        getReader: () => ({ read, cancel, releaseLock: vi.fn() }),
      };
      return {
        cancel,
        response: {
          status,
          headers: new Headers(headers),
          body,
          get json(): never { throw new Error("response.json must not be called"); },
        } as unknown as Response,
      };
    };

    const successBytes = encoder.encode('{"c":12.5,"t":200}');
    const success = makeStreamResponse(
      [successBytes],
      { "content-length": String(successBytes.byteLength) },
    );
    const noLength = makeStreamResponse([encoder.encode("{}")], {});
    const chunked = makeStreamResponse(
      [encoder.encode("{}")],
      { "content-length": "2", "transfer-encoding": "chunked" },
    );
    const oversizedHeader = makeStreamResponse(
      [encoder.encode("{}")],
      { "content-length": "5000" },
    );
    const oversizedActual = makeStreamResponse(
      [new Uint8Array(5_000)],
      { "content-length": "2" },
    );
    const invalidUtf8 = makeStreamResponse(
      [Uint8Array.of(0xff)],
      { "content-length": "1" },
    );
    const invalidJson = makeStreamResponse(
      [encoder.encode("{")],
      { "content-length": "1" },
    );
    const nonSuccess = makeStreamResponse(
      [encoder.encode("provider private detail")],
      {},
      429,
    );
    const queued = [
      success,
      noLength,
      chunked,
      oversizedHeader,
      oversizedActual,
      invalidUtf8,
      invalidJson,
      nonSuccess,
    ];
    const client = createFinnhubHttpClient({
      fetch: vi.fn(async () => queued.shift()!.response),
      readApiKey: () => "bounded-private-key",
    });

    await expect(client.fetchQuote("AAPL")).resolves.toEqual({
      status: 200,
      json: { c: 12.5, t: 200 },
    });
    for (const symbol of ["MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META"]) {
      await expect(client.fetchQuote(symbol)).resolves.toEqual({
        status: 200,
        malformed: true,
      });
    }
    await expect(client.fetchQuote("TSLA")).resolves.toEqual({ status: 429 });

    expect(success.cancel).not.toHaveBeenCalled();
    for (const rejected of [
      noLength,
      chunked,
      oversizedHeader,
      oversizedActual,
      invalidUtf8,
      invalidJson,
      nonSuccess,
    ]) {
      expect(rejected.cancel).toHaveBeenCalledOnce();
    }
  });

  it("reads the API key at request time and keeps it out of URLs, results, and provider errors", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const keys = ["first-private-key", "second-private-key", "third-private-key"];
    let keyIndex = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (requests.length === 3) throw new Error(`provider leaked ${keys[2]}`);
      return jsonHttpResponse(requests.length === 1 ? { isOpen: true } : { c: 12.5, t: 200 });
    });
    const client = createFinnhubHttpClient({
      fetch: fetchImpl,
      readApiKey: () => keys[keyIndex++] ?? keys.at(-1),
    });

    const status = await client.fetchMarketStatus();
    const quote = await client.fetchQuote("AAPL");
    const failure = await client.fetchQuote("MSFT");

    expect(requests.map((request) => request.url)).toEqual([
      "https://finnhub.io/api/v1/stock/market-status?exchange=US",
      "https://finnhub.io/api/v1/quote?symbol=AAPL",
      "https://finnhub.io/api/v1/quote?symbol=MSFT",
    ]);
    expect(requests.map((request) => new Headers(request.init?.headers).get("X-Finnhub-Token")))
      .toEqual(keys);
    expect(JSON.stringify({ status, quote, failure, requests: requests.map(({ url }) => url) }))
      .not.toMatch(/first-private-key|second-private-key|third-private-key/);
    expect(failure).toEqual({ status: 0 });

    const callsBeforeInvalidSymbol = fetchImpl.mock.calls.length;
    await expect(client.fetchQuote("AAPL&token=exfiltrate")).resolves.toEqual({ status: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(callsBeforeInvalidSymbol);
    expect(Object.keys(client).sort()).toEqual(["fetchMarketStatus", "fetchQuote"]);
  });

  it("rejects unsafe bounds and returns immutable result snapshots without fallback configuration", async () => {
    const fetchQuote = vi.fn(async () => ({
      status: 200,
      json: { c: 10, t: 1_776_089_600 },
    }));
    const common = {
      marketOpen: true as const,
      fetchQuote,
      sleep: async () => undefined,
      now: () => 1_000_000,
    };

    for (const timeoutMs of [0, 3_000, Number.NaN, 2_500.5]) {
      await expect(pollFinnhubWindow({ ...common, timeoutMs })).rejects.toThrow(
        "FINNHUB_POLL_CONFIG_INVALID",
      );
    }
    await expect(pollFinnhubWindow({
      ...common,
      timeoutMs: 2_500,
      minimumSourceTimestampSeconds: -1,
    })).rejects.toThrow("FINNHUB_POLL_CONFIG_INVALID");

    let now = 0;
    const result = await pollFinnhubWindow({
      ...common,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 2_500,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(result, "callsUsed", 97)).toBe(false);
    expect(Reflect.set(result.items[0]!, "symbol", "BTCUSD")).toBe(false);
    expect(fetchQuote).toHaveBeenCalledTimes(95);
  });
});

describe("local market poller", () => {
  it("opens Neon only after all provider calls and persists one complete bounded window", async () => {
    const order: string[] = [];
    let databaseOpen = false;
    let databaseCycles = 0;
    let persisted: PersistableMarketPollWindow | undefined;
    const poll = vi.fn(async (windowId: string) => {
      expect(databaseOpen).toBe(false);
      order.push("provider:start", "provider:finish");
      return {
        windowId,
        callsUsed: 96,
        items: MARKET_UNIVERSE.map(({ symbol, kind }) => ({
          symbol,
          kind,
          status: "PROVIDER_ERROR" as const,
          price: null,
          sourceObservedAt: null,
          safeCode: "PROVIDER_ERROR" as const,
        })),
      };
    });
    const withDatabase = async <Result>(
      work: (database: { readonly marker: "db" }) => Promise<Result>,
    ): Promise<Result> => {
      databaseCycles += 1;
      expect(databaseOpen).toBe(false);
      databaseOpen = true;
      order.push("db:open");
      try {
        return await work({ marker: "db" });
      } finally {
        databaseOpen = false;
        order.push("db:close");
      }
    };
    const reserve = vi.fn(async () => {
      order.push("db:reserve");
      return {
        disposition: "POLL" as const,
        windowId: "2026-08-13T13:30Z",
      };
    });
    const store = vi.fn(async (
      _database: { readonly marker: "db" },
      window: PersistableMarketPollWindow,
    ) => {
      persisted = window;
      order.push("db:store");
    });
    const heartbeat = vi.fn(async () => { order.push("db:heartbeat"); });

    await runMarketPollWindow({ poll, withDatabase, reserve, store, heartbeat });

    expect(order).toEqual([
      "db:open", "db:reserve", "db:close",
      "provider:start", "provider:finish",
      "db:open", "db:store", "db:heartbeat", "db:close",
    ]);
    expect(databaseCycles).toBe(2);
    expect(store).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({
        callsUsed: 96,
        windowId: "2026-08-13T13:30Z",
      }),
    );
    expect(persisted).toBeDefined();
    expect(persisted!.items).toHaveLength(95);
  });

  it("recovers an incomplete reservation without polling the same window twice", async () => {
    const poll = vi.fn();
    let persisted: PersistableMarketPollWindow | undefined;
    const store = vi.fn(async (
      _database: { readonly marker: "db" },
      window: PersistableMarketPollWindow,
    ) => { persisted = window; });
    const heartbeat = vi.fn(async () => undefined);
    const withDatabase = async <Result>(
      work: (database: { readonly marker: "db" }) => Promise<Result>,
    ): Promise<Result> => work({ marker: "db" });

    await runMarketPollWindow({
      withDatabase,
      reserve: vi.fn(async () => ({
        disposition: "RECOVER" as const,
        windowId: "2026-08-13T13:30Z",
        callsUsed: 12,
      })),
      poll,
      store,
      heartbeat,
    });

    expect(poll).not.toHaveBeenCalled();
    expect(store).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({
        callsUsed: 12,
        mutateLatest: false,
        resultCount: 0,
        safeCode: "PROVIDER_ERROR",
        status: "FAILED",
      }),
    );
    expect(persisted).toBeDefined();
    expect(persisted!.items).toHaveLength(95);
    expect(persisted!.items.map(({ symbol }) => symbol)).toEqual(
      MARKET_UNIVERSE.map(({ symbol }) => symbol),
    );
    expect(heartbeat).toHaveBeenCalledWith(
      { marker: "db" },
      { status: "DEGRADED", safeCode: "PROVIDER_UNAVAILABLE" },
    );
  });

  it("fills missing catalog results but fails the summary without mutating latest rows", async () => {
    let persisted: PersistableMarketPollWindow | undefined;
    const store = vi.fn(async (
      _database: { readonly marker: "db" },
      window: PersistableMarketPollWindow,
    ) => { persisted = window; });
    const heartbeat = vi.fn(async () => undefined);
    const pollItems = MARKET_UNIVERSE.slice(0, 94).map(({ symbol, kind }) => ({
      symbol,
      kind,
      status: "PROVIDER_ERROR" as const,
      price: null,
      sourceObservedAt: null,
      safeCode: "PROVIDER_ERROR" as const,
    }));

    await runMarketPollWindow({
      withDatabase: async (work) => work({ marker: "db" }),
      reserve: async () => ({
        disposition: "POLL" as const,
        windowId: "2026-08-13T13:30Z",
      }),
      poll: async (windowId) => ({ windowId, callsUsed: 96, items: pollItems }),
      store,
      heartbeat,
    });

    expect(persisted).toMatchObject({
      callsUsed: 96,
      mutateLatest: false,
      resultCount: 94,
      safeCode: "RESULT_COUNT_INVALID",
      status: "FAILED",
    });
    expect(persisted).toBeDefined();
    expect(persisted!.items).toHaveLength(95);
    expect(persisted!.items[94]).toEqual({
      ...MARKET_UNIVERSE[94],
      status: "PROVIDER_ERROR",
      price: null,
      sourceObservedAt: null,
      safeCode: "PROVIDER_ERROR",
    });
    expect(heartbeat).toHaveBeenCalledWith(
      { marker: "db" },
      { status: "DEGRADED", safeCode: "PROVIDER_UNAVAILABLE" },
    );
  });

  it("contains a call-limit breach as a failed body-free window", async () => {
    const store = vi.fn(async () => undefined);
    const items = MARKET_UNIVERSE.map(({ symbol, kind }) => ({
      symbol,
      kind,
      status: "PROVIDER_ERROR" as const,
      price: null,
      sourceObservedAt: null,
      safeCode: "PROVIDER_ERROR" as const,
    }));

    await runMarketPollWindow({
      withDatabase: async (work) => work({ marker: "db" }),
      reserve: async () => ({
        disposition: "POLL" as const,
        windowId: "2026-08-13T13:30Z",
      }),
      poll: async (windowId) => ({ windowId, callsUsed: 97, items }),
      store,
      heartbeat: async () => undefined,
    });

    expect(store).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({
        callsUsed: 96,
        mutateLatest: false,
        safeCode: "CALL_LIMIT_EXCEEDED",
        status: "FAILED",
      }),
    );
  });

  it("rejects invalid status and safe-code pairs before latest-row mutation", async () => {
    const store = vi.fn(async (
      _database: { readonly marker: "db" },
      _window: PersistableMarketPollWindow,
    ) => undefined);
    const invalidItems = MARKET_UNIVERSE.map(({ symbol, kind }) => ({
      symbol,
      kind,
      status: "UNAVAILABLE" as const,
      price: null,
      sourceObservedAt: null,
      safeCode: "PROVIDER_ERROR" as const,
    }));

    await runMarketPollWindow({
      withDatabase: async (work) => work({ marker: "db" }),
      reserve: async () => ({
        disposition: "POLL" as const,
        windowId: "2026-08-13T13:30Z",
      }),
      poll: async (windowId) => ({ windowId, callsUsed: 96, items: invalidItems }),
      store,
      heartbeat: async () => undefined,
    });

    expect(store).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({
        mutateLatest: false,
        safeCode: "RESULT_COUNT_INVALID",
        status: "FAILED",
      }),
    );
  });

  it("defers rate-limit recovery to the next five-minute window", async () => {
    const poll = vi.fn(async (windowId: string) => ({
      windowId,
      callsUsed: 1,
      items: MARKET_UNIVERSE.map(({ symbol, kind }) => ({
        symbol,
        kind,
        status: "RATE_LIMITED" as const,
        price: null,
        sourceObservedAt: null,
        safeCode: "RATE_LIMITED" as const,
      })),
    }));
    const store = vi.fn(async () => undefined);

    await runMarketPollWindow({
      withDatabase: async (work) => work({ marker: "db" }),
      reserve: async () => ({
        disposition: "POLL" as const,
        windowId: "2026-08-13T13:30Z",
      }),
      poll,
      store,
      heartbeat: async () => undefined,
    });

    expect(poll).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledWith(
      { marker: "db" },
      expect.objectContaining({
        mutateLatest: false,
        nextWindowPending: true,
        safeCode: "RATE_LIMITED",
        status: "FAILED",
      }),
    );
  });

  it("contains provider exceptions without exposing raw errors or retaining a database handle", async () => {
    const order: string[] = [];
    const store = vi.fn(async () => undefined);
    const withDatabase = async <Result>(
      work: (database: { readonly marker: "db" }) => Promise<Result>,
    ): Promise<Result> => {
      order.push("open");
      try {
        return await work({ marker: "db" });
      } finally {
        order.push("close");
      }
    };

    await expect(runMarketPollWindow({
      withDatabase,
      reserve: async () => ({
        disposition: "POLL" as const,
        windowId: "2026-08-13T13:30Z",
      }),
      poll: async () => {
        throw new Error("FINNHUB_API_KEY=private-provider-secret raw response");
      },
      store,
      heartbeat: async () => undefined,
    })).resolves.toMatchObject({ status: "FAILED", safeCode: "PROVIDER_ERROR" });

    expect(order).toEqual(["open", "close", "open", "close"]);
    expect(JSON.stringify(store.mock.calls)).not.toMatch(/private-provider-secret|FINNHUB_API_KEY/iu);
  });

  it("skips terminal replays and fails closed before provider work when quota is unavailable", async () => {
    const poll = vi.fn();
    const store = vi.fn();
    const heartbeat = vi.fn(async () => undefined);
    const withDatabase = async <Result>(
      work: (database: { readonly marker: "db" }) => Promise<Result>,
    ): Promise<Result> => work({ marker: "db" });

    await expect(runMarketPollWindow({
      withDatabase,
      reserve: async () => ({
        disposition: "SKIP" as const,
        windowId: "2026-08-13T13:30Z",
      }),
      poll,
      store,
      heartbeat,
    })).resolves.toEqual({ disposition: "SKIPPED", windowId: "2026-08-13T13:30Z" });
    await expect(runMarketPollWindow({
      withDatabase,
      reserve: async () => ({
        disposition: "REJECT" as const,
        windowId: "2026-08-13T13:35Z",
        safeCode: "QUOTA_EXHAUSTED" as const,
      }),
      poll,
      store,
      heartbeat,
    })).resolves.toEqual({
      disposition: "REJECTED",
      safeCode: "QUOTA_EXHAUSTED",
      windowId: "2026-08-13T13:35Z",
    });

    expect(poll).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(heartbeat).toHaveBeenCalledWith(
      { marker: "db" },
      { status: "DEGRADED", safeCode: "QUOTA_EXHAUSTED" },
    );
  });

  it("accepts only the exact database-clock window without charging adjacent buckets", async () => {
    const fixture = await createConversationFixture("market-poller-database-bucket");
    const initialIds = await databaseMarketWindowIds(fixture.db);
    const poll = vi.fn(async (windowId: string) => ({
      windowId,
      callsUsed: 96,
      items: MARKET_UNIVERSE.map(({ symbol, kind }) => ({
        symbol,
        kind,
        status: "PROVIDER_ERROR" as const,
        price: null,
        sourceObservedAt: null,
        safeCode: "PROVIDER_ERROR" as const,
      })),
    }));
    const store = vi.fn((database: EventDatabase, window: PersistableMarketPollWindow) => (
      persistMarketPollWindow(database, fixture.accountId, window)
    ));
    const run = (windowId: string) => runMarketPollWindow({
      withDatabase: <Result>(work: (database: EventDatabase) => Promise<Result>) => (
        fixture.db.transaction(work)
      ),
      reserve: (database: EventDatabase) => reserveMarketPollWindow(database, windowId),
      poll,
      store,
      heartbeat: writeMarketHeartbeat,
    });

    await expect(run(initialIds.past)).resolves.toEqual({
      disposition: "SKIPPED",
      windowId: initialIds.past,
    });
    await expect(run(initialIds.future)).resolves.toEqual({
      disposition: "SKIPPED",
      windowId: initialIds.future,
    });
    expect(poll).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(await fixture.db.query(
      "select bucket_date,used_count from deployment_quota_counters where quota_name='FINNHUB_CALLS'",
    )).toEqual([]);
    expect(await fixture.db.query(
      "select symbol from market_latest_quotes where account_id=$1",
      [fixture.accountId],
    )).toEqual([]);

    const currentId = (await databaseMarketWindowIds(fixture.db)).current;
    await expect(run(currentId)).resolves.toMatchObject({
      status: "COMPLETED",
      windowId: currentId,
    });
    expect(poll).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledOnce();
    expect(await fixture.db.one<{ readonly used_count: number }>(
      "select used_count from deployment_quota_counters where quota_name='FINNHUB_CALLS'",
    )).toEqual({ used_count: 96 });
    expect(await fixture.db.query(
      "select symbol from market_latest_quotes where account_id=$1",
      [fixture.accountId],
    )).toHaveLength(95);
  }, 30_000);

  it("rolls back an old bucket when database time advances across a blocked quota reservation", async () => {
    const fixture = await createConversationFixture("market-poller-quota-boundary");
    const windowId = (await databaseMarketWindowIds(fixture.db)).current;
    const windowStartedAt = new Date(`${windowId.slice(0, -1)}:00.000Z`);
    const bucketDate = windowId.slice(0, 10);
    await fixture.db.query("create sequence market_poll_test_clock_sequence");
    await fixture.db.query(
      `create table market_poll_test_clock_values (
         ordinal integer primary key,
         observed_at timestamptz not null
       )`,
    );
    await fixture.db.query(
      `insert into market_poll_test_clock_values (ordinal,observed_at)
       values (1,$1),(2,$2)`,
      [
        new Date(windowStartedAt.getTime() + 60_000),
        new Date(windowStartedAt.getTime() + 6 * 60_000),
      ],
    );
    await fixture.db.query(
      `create or replace function market_poll_reservation_now() returns timestamptz
       language sql volatile as $$
         select observed_at
           from market_poll_test_clock_values
          where ordinal=least(nextval('market_poll_test_clock_sequence')::integer,2)
       $$`,
    );

    let quotaLocked!: () => void;
    let releaseQuota!: () => void;
    const lockHeld = new Promise<void>((resolve) => { quotaLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseQuota = resolve; });
    const blocker = fixture.db.transaction(async (database) => {
      await database.query(
        `insert into deployment_quota_counters (
           quota_name,bucket_date,used_count,limit_count
         ) values ('FINNHUB_CALLS',$1,0,27648)`,
        [bucketDate],
      );
      quotaLocked();
      await release;
    });
    await lockHeld;

    let quotaAttempted!: () => void;
    const atQuota = new Promise<void>((resolve) => { quotaAttempted = resolve; });
    const poll = vi.fn(async () => ({
      windowId,
      callsUsed: 96,
      items: MARKET_UNIVERSE.slice(0, 94).map(({ symbol, kind }) => ({
        symbol,
        kind,
        status: "PROVIDER_ERROR" as const,
        price: null,
        sourceObservedAt: null,
        safeCode: "PROVIDER_ERROR" as const,
      })),
    }));
    const store = vi.fn((database: EventDatabase, window: PersistableMarketPollWindow) => (
      persistMarketPollWindow(database, fixture.accountId, window)
    ));
    const heartbeat = vi.fn(writeMarketHeartbeat);
    const run = runMarketPollWindow({
      withDatabase: <Result>(work: (database: EventDatabase) => Promise<Result>) => (
        fixture.db.transaction((database) => work({
          query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            parameters: readonly unknown[] = [],
          ): Promise<Row[]> => {
            if (sql.includes("insert into deployment_quota_counters")) quotaAttempted();
            return database.query<Row>(sql, parameters);
          },
          one: <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            parameters: readonly unknown[] = [],
          ) => database.one<Row>(sql, parameters),
          transaction: database.transaction,
        }))
      ),
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll,
      store,
      heartbeat,
    });
    await atQuota;
    releaseQuota();
    await blocker;

    await expect(run).resolves.toEqual({ disposition: "SKIPPED", windowId });
    expect(poll).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(await fixture.db.one<{ readonly used_count: number }>(
      `select used_count from deployment_quota_counters
        where quota_name='FINNHUB_CALLS' and bucket_date=$1`,
      [bucketDate],
    )).toEqual({ used_count: 0 });
    expect(await fixture.db.query(
      "select window_id from market_poll_windows where window_id=$1",
      [windowId],
    )).toEqual([]);
    expect(await fixture.db.query(
      "select symbol from market_latest_quotes where account_id=$1",
      [fixture.accountId],
    )).toEqual([]);
  }, 30_000);

  it("enforces the canonical failed-window matrix in direct SQL", async () => {
    const fixture = await createConversationFixture("market-poller-failed-matrix");
    const currentId = (await databaseMarketWindowIds(fixture.db)).current;
    const currentStart = new Date(`${currentId.slice(0, -1)}:00.000Z`);
    let offset = 1;
    const insertPending = async (): Promise<string> => {
      const windowStartedAt = new Date(currentStart.getTime() - offset++ * 5 * 60_000);
      const windowId = marketWindowId(windowStartedAt);
      await fixture.db.query(
        `insert into market_poll_windows (window_id,window_started_at)
         values ($1,$2)`,
        [windowId, windowStartedAt],
      );
      return windowId;
    };
    const terminalize = (
      windowId: string,
      providerStatus: string,
      callsUsed: number,
      resultCount: number,
      safeCode: string,
    ) => fixture.db.query(
      `update market_poll_windows
          set status='FAILED',provider_status=$2,calls_used=$3,
              result_count=$4,safe_code=$5
        where window_id=$1`,
      [windowId, providerStatus, callsUsed, resultCount, safeCode],
    );

    for (const [providerStatus, callsUsed, resultCount, safeCode] of [
      ["CLOSED", 1, 95, "MARKET_CLOSED"],
      ["OPEN", 12, 95, "PROVIDER_ERROR"],
      ["ERROR", 12, 95, "MARKET_CLOSED"],
    ] as const) {
      const windowId = await insertPending();
      await expect(terminalize(
        windowId, providerStatus, callsUsed, resultCount, safeCode,
      ))
        .rejects.toThrow(/MARKET_POLL_WINDOW_TRANSITION_INVALID/u);
    }

    for (const [providerStatus, callsUsed, resultCount, safeCode] of [
      ["ERROR", 0, 0, "PROVIDER_ERROR"],
      ["ERROR", 12, 95, "PROVIDER_ERROR"],
      ["ERROR", 1, 95, "RATE_LIMITED"],
      ["ERROR", 96, 95, "CALL_LIMIT_EXCEEDED"],
      ["ERROR", 96, 94, "RESULT_COUNT_INVALID"],
      ["ERROR", 0, 95, "WINDOW_CONFLICT"],
    ] as const) {
      const windowId = await insertPending();
      await expect(terminalize(
        windowId, providerStatus, callsUsed, resultCount, safeCode,
      )).resolves.toHaveLength(0);
    }
  }, 30_000);

  it("reserves one durable quota window and commits all results with its heartbeat atomically", async () => {
    const fixture = await createConversationFixture("market-poller-durable-window");
    const windowId = (await databaseMarketWindowIds(fixture.db)).current;
    const poll = vi.fn(async () => ({
      windowId,
      callsUsed: 96,
      items: MARKET_UNIVERSE.map(({ symbol, kind }) => ({
        symbol,
        kind,
        status: "PROVIDER_ERROR" as const,
        price: null,
        sourceObservedAt: null,
        safeCode: "PROVIDER_ERROR" as const,
      })),
    }));
    const options = {
      withDatabase: <Result>(work: (database: EventDatabase) => Promise<Result>) => (
        fixture.db.transaction(work)
      ),
      reserve: (database: EventDatabase) => reserveMarketPollWindow(database, windowId),
      poll,
      store: (database: EventDatabase, window: PersistableMarketPollWindow) => (
        persistMarketPollWindow(database, fixture.accountId, window)
      ),
      heartbeat: writeMarketHeartbeat,
    };

    await expect(runMarketPollWindow(options)).resolves.toMatchObject({
      status: "COMPLETED",
      callsUsed: 96,
      resultCount: 95,
    });
    await expect(runMarketPollWindow(options)).resolves.toEqual({
      disposition: "SKIPPED",
      windowId,
    });

    const summary = await fixture.db.one<{
      readonly status: string;
      readonly calls_used: number;
      readonly result_count: number;
    }>("select status,calls_used,result_count from market_poll_windows where window_id=$1", [windowId]);
    const quota = await fixture.db.one<{ readonly used_count: number }>(
      `select used_count from deployment_quota_counters
        where quota_name='FINNHUB_CALLS' and bucket_date=$1`,
      [windowId.slice(0, 10)],
    );
    const latest = await fixture.db.query(
      "select symbol from market_latest_quotes where account_id=$1",
      [fixture.accountId],
    );
    const heartbeat = await fixture.db.one<{ readonly status: string; readonly safe_code: string | null }>(
      "select status,safe_code from hybrid_worker_heartbeats where component='MARKET'",
    );

    expect(poll).toHaveBeenCalledOnce();
    expect(summary).toEqual({ status: "COMPLETED", calls_used: 96, result_count: 95 });
    expect(quota.used_count).toBe(96);
    expect(latest).toHaveLength(95);
    expect(heartbeat).toEqual({ status: "HEALTHY", safe_code: null });
  }, 30_000);

  it("keeps a duplicate wake for the active database window from terminalizing provider work", async () => {
    const fixture = await createConversationFixture("market-poller-concurrent-wake");
    const windowId = (await databaseMarketWindowIds(fixture.db)).current;
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const firstPoll = vi.fn(async () => {
      providerStarted();
      await released;
      return {
        windowId,
        callsUsed: 96,
        items: MARKET_UNIVERSE.map(({ symbol, kind }) => ({
          symbol,
          kind,
          status: "PROVIDER_ERROR" as const,
          price: null,
          sourceObservedAt: null,
          safeCode: "PROVIDER_ERROR" as const,
        })),
      };
    });
    const firstStore = vi.fn((database: EventDatabase, window: PersistableMarketPollWindow) => (
      persistMarketPollWindow(database, fixture.accountId, window)
    ));
    const secondPoll = vi.fn();
    const secondStore = vi.fn((database: EventDatabase, window: PersistableMarketPollWindow) => (
      persistMarketPollWindow(database, fixture.accountId, window)
    ));
    const secondHeartbeat = vi.fn(writeMarketHeartbeat);
    const withDatabase = <Result>(work: (database: EventDatabase) => Promise<Result>) => (
      fixture.db.transaction(work)
    );
    const first = runMarketPollWindow({
      withDatabase,
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll: firstPoll,
      store: firstStore,
      heartbeat: writeMarketHeartbeat,
    });
    await started;

    const second = await runMarketPollWindow({
      withDatabase,
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll: secondPoll,
      store: secondStore,
      heartbeat: secondHeartbeat,
    });
    releaseProvider();
    const firstResult = await Promise.allSettled([first]);

    expect(second).toEqual({ disposition: "SKIPPED", windowId });
    expect(secondPoll).not.toHaveBeenCalled();
    expect(secondStore).not.toHaveBeenCalled();
    expect(secondHeartbeat).not.toHaveBeenCalled();
    expect(firstResult[0]).toMatchObject({
      status: "fulfilled",
      value: { status: "COMPLETED", windowId },
    });
    expect(firstPoll).toHaveBeenCalledOnce();
    expect(firstStore).toHaveBeenCalledOnce();
    expect(await fixture.db.one<{ readonly used_count: number }>(
      "select used_count from deployment_quota_counters where quota_name='FINNHUB_CALLS'",
    )).toEqual({ used_count: 96 });
    expect(await fixture.db.query(
      "select symbol from market_latest_quotes where account_id=$1",
      [fixture.accountId],
    )).toHaveLength(95);
  }, 30_000);

  it("skips a current pending reservation as active without recovering it", async () => {
    const fixture = await createConversationFixture("market-poller-recovery");
    const windowId = (await databaseMarketWindowIds(fixture.db)).current;
    await fixture.db.transaction((database) => reserveMarketPollWindow(database, windowId));
    const poll = vi.fn();
    const store = vi.fn((database: EventDatabase, window: PersistableMarketPollWindow) => (
      persistMarketPollWindow(database, fixture.accountId, window)
    ));
    const heartbeat = vi.fn(writeMarketHeartbeat);

    await expect(runMarketPollWindow({
      withDatabase: <Result>(work: (database: EventDatabase) => Promise<Result>) => (
        fixture.db.transaction(work)
      ),
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll,
      store,
      heartbeat,
    })).resolves.toEqual({ disposition: "SKIPPED", windowId });

    const summary = await fixture.db.one<{ readonly status: string; readonly safe_code: string | null }>(
      "select status,safe_code from market_poll_windows where window_id=$1",
      [windowId],
    );
    const latest = await fixture.db.query(
      "select symbol from market_latest_quotes where account_id=$1",
      [fixture.accountId],
    );
    expect(poll).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(summary).toEqual({ status: "PENDING", safe_code: null });
    expect(latest).toEqual([]);
  }, 30_000);

  it("finalizes a prior-window crash as failed during reconnect recovery", async () => {
    const fixture = await createConversationFixture("market-poller-late-recovery");
    const windowId = marketWindowId(new Date(Date.now() - 10 * 60_000));
    const windowStartedAt = new Date(`${windowId.slice(0, -1)}:00.000Z`);
    const bucketDate = windowStartedAt.toISOString().slice(0, 10);
    await fixture.db.query(
      `insert into market_poll_windows (window_id,window_started_at)
       values ($1,$2)`,
      [windowId, windowStartedAt],
    );
    await fixture.db.query(
      `insert into deployment_quota_counters (
         quota_name,bucket_date,used_count,limit_count
       ) values ('FINNHUB_CALLS',$1,96,27648)`,
      [bucketDate],
    );
    const poll = vi.fn();

    await expect(runMarketPollWindow({
      withDatabase: <Result>(work: (database: EventDatabase) => Promise<Result>) => (
        fixture.db.transaction(work)
      ),
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll,
      store: (database, window) => persistMarketPollWindow(
        database, fixture.accountId, window,
      ),
      heartbeat: writeMarketHeartbeat,
    })).resolves.toMatchObject({
      status: "FAILED",
      safeCode: "PROVIDER_ERROR",
      resultCount: 0,
      mutateLatest: false,
    });

    expect(poll).not.toHaveBeenCalled();
    expect(await fixture.db.one<{ readonly status: string; readonly safe_code: string }>(
      "select status,safe_code from market_poll_windows where window_id=$1",
      [windowId],
    )).toEqual({ status: "FAILED", safe_code: "PROVIDER_ERROR" });
    await expect(fixture.db.query(
      `update market_poll_windows set calls_used=1 where window_id=$1`,
      [windowId],
    )).rejects.toThrow(/MARKET_POLL_WINDOW_TRANSITION_INVALID/u);
    expect(await fixture.db.one<{ readonly used_count: number }>(
      `select used_count from deployment_quota_counters
        where quota_name='FINNHUB_CALLS' and bucket_date=$1`,
      [bucketDate],
    )).toEqual({ used_count: 96 });
  }, 30_000);

  it("cleans an expired pending window without repolling or reserving quota again", async () => {
    const fixture = await createConversationFixture("market-poller-prune-boundary");
    const windowId = marketWindowId(new Date(Date.now() - 8 * 24 * 60 * 60_000));
    const windowStartedAt = new Date(`${windowId.slice(0, -1)}:00.000Z`);
    const createdAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const pruneAfter = new Date(createdAt.getTime() + 7 * 24 * 60 * 60_000);
    const bucketDate = windowStartedAt.toISOString().slice(0, 10);
    await fixture.db.query(
      `insert into market_poll_windows (
         window_id,window_started_at,created_at,updated_at,prune_after
       ) values ($1,$2,$3,$3,$4)`,
      [windowId, windowStartedAt, createdAt, pruneAfter],
    );
    await fixture.db.query(
      `insert into deployment_quota_counters (
         quota_name,bucket_date,used_count,limit_count
       ) values ('FINNHUB_CALLS',$1,96,27648)`,
      [bucketDate],
    );
    await expect(fixture.db.query(
      `update market_poll_windows
          set status='COMPLETED',provider_status='OPEN',calls_used=96,
              result_count=95,completed_at=clock_timestamp(),updated_at=clock_timestamp()
        where window_id=$1`,
      [windowId],
    )).rejects.toThrow(/market_poll_windows_check3/u);
    const poll = vi.fn();
    const store = vi.fn();

    await expect(runMarketPollWindow({
      withDatabase: <Result>(work: (database: EventDatabase) => Promise<Result>) => (
        fixture.db.transaction(work)
      ),
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll,
      store,
      heartbeat: writeMarketHeartbeat,
    })).resolves.toEqual({ disposition: "SKIPPED", windowId });

    expect(poll).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(await fixture.db.query(
      "select window_id from market_poll_windows where window_id=$1",
      [windowId],
    )).toEqual([]);
    expect(await fixture.db.one<{ readonly used_count: number }>(
      `select used_count from deployment_quota_counters
        where quota_name='FINNHUB_CALLS' and bucket_date=$1`,
      [bucketDate],
    )).toEqual({ used_count: 96 });
  }, 30_000);

  it("switches from retained recovery to cleanup when prune expires between transactions", async () => {
    const fixture = await createConversationFixture("market-poller-prune-race");
    const windowId = marketWindowId(new Date(Date.now() - 7 * 24 * 60 * 60_000));
    const windowStartedAt = new Date(`${windowId.slice(0, -1)}:00.000Z`);
    const pruneAfter = new Date(Date.now() + 2_000);
    const createdAt = new Date(pruneAfter.getTime() - 7 * 24 * 60 * 60_000);
    await fixture.db.query(
      `insert into market_poll_windows (
         window_id,window_started_at,created_at,updated_at,prune_after
       ) values ($1,$2,$3,$3,$4)`,
      [windowId, windowStartedAt, createdAt, pruneAfter],
    );
    const poll = vi.fn();
    let databaseCycle = 0;

    await expect(runMarketPollWindow({
      withDatabase: async <Result>(
        work: (database: EventDatabase) => Promise<Result>,
      ): Promise<Result> => {
        databaseCycle += 1;
        if (databaseCycle === 2) {
          const remaining = pruneAfter.getTime() - Date.now();
          if (remaining >= 0) {
            await new Promise((resolve) => setTimeout(resolve, remaining + 25));
          }
        }
        return fixture.db.transaction(work);
      },
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll,
      store: (database, window) => persistMarketPollWindow(
        database, fixture.accountId, window,
      ),
      heartbeat: writeMarketHeartbeat,
    })).resolves.toEqual({ disposition: "SKIPPED", windowId });

    expect(poll).not.toHaveBeenCalled();
    expect(await fixture.db.query(
      "select window_id from market_poll_windows where window_id=$1",
      [windowId],
    )).toEqual([]);
  }, 30_000);

  it("reserves no window and starts no provider call after the daily hard ceiling", async () => {
    const fixture = await createConversationFixture("market-poller-quota-ceiling");
    const windowId = (await databaseMarketWindowIds(fixture.db)).current;
    const bucketDate = windowId.slice(0, 10);
    await fixture.db.query(
      `insert into deployment_quota_counters (
         quota_name,bucket_date,used_count,limit_count
       ) values ('FINNHUB_CALLS',$1,27600,27648)`,
      [bucketDate],
    );
    const poll = vi.fn();

    await expect(runMarketPollWindow({
      withDatabase: <Result>(work: (database: EventDatabase) => Promise<Result>) => (
        fixture.db.transaction(work)
      ),
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll,
      store: (database, window) => persistMarketPollWindow(
        database, fixture.accountId, window,
      ),
      heartbeat: writeMarketHeartbeat,
    })).resolves.toEqual({
      disposition: "REJECTED",
      safeCode: "QUOTA_EXHAUSTED",
      windowId,
    });

    expect(poll).not.toHaveBeenCalled();
    expect(await fixture.db.query(
      "select window_id from market_poll_windows where window_id=$1",
      [windowId],
    )).toEqual([]);
    expect(await fixture.db.one<{ readonly used_count: number }>(
      `select used_count from deployment_quota_counters
        where quota_name='FINNHUB_CALLS' and bucket_date=$1`,
      [bucketDate],
    )).toEqual({ used_count: 27600 });
  }, 30_000);
});
