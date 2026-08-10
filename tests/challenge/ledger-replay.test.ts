import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  appendChallengeLedgerEvent,
  loadChallengeLedgerEvents,
  loadProjectionCheckpoint,
  replaceProjectionCheckpoint,
} from "../../lib/server/challenge/ledger";
import {
  REPLAY_NOOP_EVENT_TYPES,
  replayLedger,
  replayStoredLedgerEvents,
  type ChallengeLedgerEvent,
} from "../../lib/server/challenge/projection";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";
import { testContext } from "../helpers/postgres";

const stageStarted = {
  id: "1",
  type: "stage.started",
  amount: "2500.00",
  profileVersionId: INITIAL_PROFILE.profileVersionId,
} as const;

async function dependencyStage() {
  const { db } = await testContext();
  const stageId = randomUUID();
  await db.query(
    `insert into challenge_stages (
       id, challenge_portfolio_id, profile_version_id, stage_profile_id,
       ordinal, created_at
     ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
    [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
      "2026-08-09T00:00:00.000Z"],
  );
  await db.query(
    `insert into challenge_ledger_events (
       id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
       type, payload, occurred_at, actor_type, actor_id, idempotency_key
     ) values ($1,$2,$3,$4,1,'stage.started',$5,$6,'SYSTEM','dependency-test',$7)`,
    [randomUUID(), INITIAL_PROFILE.challengePortfolioId, stageId,
      INITIAL_PROFILE.profileVersionId, { amount: "2500.00" },
      "2026-08-09T00:00:01.000Z", `dependency-stage-${stageId}`],
  );
  const insertEvent = (
    transaction: typeof db,
    sequence: number,
    id: string,
    type: string,
    payload: object,
    key: string,
  ) => transaction.query(
    `insert into challenge_ledger_events (
       id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
       type, payload, occurred_at, actor_type, actor_id, idempotency_key
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'SYSTEM','dependency-test',$9)`,
    [id, INITIAL_PROFILE.challengePortfolioId, stageId,
      INITIAL_PROFILE.profileVersionId, sequence, type, payload,
      `2026-08-09T00:00:${String(sequence).padStart(2, "0")}.000Z`, key],
  );
  return { db, stageId, insertEvent };
}

async function activePositionStage() {
  const context = await dependencyStage();
  const { db, stageId, insertEvent } = context;
  const intentId = randomUUID();
  const orderId = randomUUID();
  const positionId = randomUUID();
  const intentEventId = randomUUID();
  const orderEventId = randomUUID();
  const openingEventId = randomUUID();
  const openingFillId = randomUUID();
  await db.transaction(async (transaction) => {
    await insertEvent(transaction as typeof db, 2, intentEventId, "paper.intent.proposed", {
      intentId, direction: "PAPER_LONG", symbol: "AAPL", entryPrice: "100.00",
      stopPrice: "95.00", targetPrice: "110.00", desiredRisk: "25.00",
      expiresAt: "2026-08-09T01:00:00.000Z", initialStatus: "PROPOSED",
      createdAt: "2026-08-09T00:00:02.000Z",
    }, `active-intent-${stageId}`);
    await insertEvent(transaction as typeof db, 3, orderEventId, "paper.order.created", {
      orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "2",
      initialStatus: "PENDING", createdAt: "2026-08-09T00:00:03.000Z",
    }, `active-order-${stageId}`);
    await insertEvent(transaction as typeof db, 4, openingEventId, "paper.fill.created", {
      fillId: openingFillId, orderId, positionId, symbol: "AAPL", side: "BUY",
      quantity: "1", price: "100.00", commission: "0.00",
      openedAt: "2026-08-09T00:00:04.000Z", filledAt: "2026-08-09T00:00:04.000Z",
    }, `active-opening-fill-${stageId}`);
    await transaction.query(
      `insert into challenge_intents (
         id,stage_id,profile_version_id,ledger_event_id,symbol,direction,
         entry_price,stop_price,target_price,desired_risk,expires_at,initial_status,created_at
       ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','95.00','110.00','25.00',
                 $5,'PROPOSED',$6)`,
      [intentId, stageId, INITIAL_PROFILE.profileVersionId, intentEventId,
        "2026-08-09T01:00:00.000Z", "2026-08-09T00:00:02.000Z"],
    );
    await transaction.query(
      `insert into challenge_orders (
         id,intent_id,stage_id,profile_version_id,ledger_event_id,
         symbol,side,quantity,initial_status,created_at
       ) values ($1,$2,$3,$4,$5,'AAPL','BUY','2','PENDING',$6)`,
      [orderId, intentId, stageId, INITIAL_PROFILE.profileVersionId,
        orderEventId, "2026-08-09T00:00:03.000Z"],
    );
    await transaction.query(
      `insert into challenge_positions (
         id,stage_id,profile_version_id,opening_ledger_event_id,symbol,side,opened_at
       ) values ($1,$2,$3,$4,'AAPL','BUY',$5)`,
      [positionId, stageId, INITIAL_PROFILE.profileVersionId,
        openingEventId, "2026-08-09T00:00:04.000Z"],
    );
    await transaction.query(
      `insert into challenge_fills (
         id,order_id,position_id,stage_id,profile_version_id,ledger_event_id,
         side,quantity,price,commission,filled_at
       ) values ($1,$2,$3,$4,$5,$6,'BUY','1','100.00','0.00',$7)`,
      [openingFillId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
        openingEventId, "2026-08-09T00:00:04.000Z"],
    );
  });
  return { ...context, intentId, orderId, positionId };
}

describe("Challenge ledger replay", () => {
  it("derives the same state from the same ordered events", () => {
    const events = [
      stageStarted,
      { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "10", price: "100.00", commission: "1.00" },
      { id: "3", type: "price.mark.recorded", positionId: "p1", price: "105.00" },
      { id: "4", type: "paper.position.closed", positionId: "p1", price: "105.00", commission: "1.00" },
    ] as const;

    const first = replayLedger(events);
    const second = replayLedger(events);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      balance: "2548.00",
      equity: "2548.00",
      realizedPnl: "48.00",
      unrealizedPnl: "0.00",
      peakEquity: "2549.00",
      grossExposure: "0.00",
      netExposure: "0.00",
      drawdown: "1.00",
      drawdownBps: "3.923107101",
      openPositions: 0,
      highWaterId: "4",
      profileVersionId: INITIAL_PROFILE.profileVersionId,
    });
  });

  it("replays long and short positions, fractional quantities, fees, and financing exactly", () => {
    const events = [
      stageStarted,
      { id: "2", type: "paper.fill.created", positionId: "long", side: "BUY", quantity: "0.25", price: "100.10", commission: "1.00" },
      { id: "3", type: "paper.fill.created", positionId: "short", side: "SELL", quantity: "2", price: "50.00", commission: "1.00" },
      { id: "4", type: "price.mark.recorded", positionId: "long", price: "101.10" },
      { id: "5", type: "price.mark.recorded", positionId: "short", price: "48.00" },
      { id: "6", type: "fee.recorded", amount: "0.25" },
      { id: "7", type: "financing.recorded", amount: "0.10" },
    ] as const;

    expect(replayLedger(events)).toMatchObject({
      balance: "2497.65",
      equity: "2501.90",
      realizedPnl: "-2.35",
      unrealizedPnl: "4.25",
      grossExposure: "121.28",
      netExposure: "-70.73",
      openPositions: 2,
      highWaterId: "7",
    });
  });

  it("supports additive fills and deterministic partial closes without floating point drift", () => {
    const events = [
      stageStarted,
      { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "0.1", price: "10.10", commission: "0.10" },
      { id: "3", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "0.2", price: "10.20", commission: "0.10" },
      { id: "4", type: "price.mark.recorded", positionId: "p1", price: "10.30" },
      { id: "5", type: "paper.position.closed", positionId: "p1", quantity: "0.1", price: "10.30", commission: "0.10" },
    ] as const;

    expect(replayLedger(events)).toMatchObject({
      balance: "2499.71",
      equity: "2499.74",
      realizedPnl: "-0.29",
      unrealizedPnl: "0.03",
      grossExposure: "2.06",
      netExposure: "2.06",
      openPositions: 1,
    });
  });

  it.each([
    ["missing stage", [{ id: "1", type: "fee.recorded", amount: "1.00" }], "LEDGER_STAGE_NOT_STARTED"],
    ["duplicate event", [stageStarted, { ...stageStarted }], "LEDGER_EVENT_DUPLICATE"],
    ["second stage", [stageStarted, { ...stageStarted, id: "2" }], "LEDGER_STAGE_ALREADY_STARTED"],
    ["unknown position mark", [stageStarted, { id: "2", type: "price.mark.recorded", positionId: "missing", price: "1.00" }], "LEDGER_POSITION_NOT_FOUND"],
    ["opposite fill", [stageStarted, { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "1", price: "1.00", commission: "0.00" }, { id: "3", type: "paper.fill.created", positionId: "p1", side: "SELL", quantity: "1", price: "1.00", commission: "0.00" }], "LEDGER_POSITION_SIDE_MISMATCH"],
    ["over-close", [stageStarted, { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "1", price: "1.00", commission: "0.00" }, { id: "3", type: "paper.position.closed", positionId: "p1", quantity: "2", price: "1.00", commission: "0.00" }], "LEDGER_CLOSE_QUANTITY_EXCEEDS_POSITION"],
  ] as const)("rejects invalid replay: %s", (_name, events, error) => {
    expect(() => replayLedger(events as readonly ChallengeLedgerEvent[])).toThrowError(error);
  });

  it.each([
    ["amount", { ...stageStarted, amount: "1e3" }, "LEDGER_AMOUNT_INVALID"],
    ["quantity", { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "0", price: "1.00", commission: "0.00" }, "LEDGER_QUANTITY_INVALID"],
    ["price", { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "1", price: "NaN", commission: "0.00" }, "LEDGER_PRICE_INVALID"],
    ["commission", { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "1", price: "1.00", commission: "-1" }, "LEDGER_COMMISSION_INVALID"],
    ["fee", { id: "2", type: "fee.recorded", amount: "0.000000001" }, "LEDGER_AMOUNT_INVALID"],
  ] as const)("fails closed for invalid %s decimals", (_name, event, error) => {
    const events = event.type === "stage.started" ? [event] : [stageStarted, event];
    expect(() => replayLedger(events as readonly ChallengeLedgerEvent[])).toThrowError(error);
  });

  it("binds all stage events to the T12 profile and returns a deeply immutable snapshot", () => {
    const futureProfileVersionId = randomUUID();
    expect(replayLedger([
      { ...stageStarted, profileVersionId: futureProfileVersionId },
    ])).toMatchObject({ profileVersionId: futureProfileVersionId });
    expect(() => replayLedger([
      stageStarted,
      { id: "2", type: "fee.recorded", amount: "1.00", profileVersionId: futureProfileVersionId },
    ])).toThrowError("LEDGER_PROFILE_VERSION_MISMATCH");

    const events: ChallengeLedgerEvent[] = [
      { ...stageStarted },
      { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "1", price: "10.00", commission: "0.00" },
    ];
    const result = replayLedger(events);
    events[0] = { ...stageStarted, amount: "9999.00" };

    expect(result.balance).toBe("2500.00");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.positions)).toBe(true);
    expect(Object.isFrozen(result.positions[0])).toBe(true);
    expect(() => (result.positions as unknown as unknown[]).push({})).toThrow();
  });

  it("is a pure reducer with no database, clock, random, network, or model calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dateSpy = vi.spyOn(Date, "now");
    const randomSpy = vi.spyOn(Math, "random");
    replayLedger([stageStarted]);
    const source = await readFile("lib/server/challenge/projection.ts", "utf8");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dateSpy).not.toHaveBeenCalled();
    expect(randomSpy).not.toHaveBeenCalled();
    expect(source).not.toMatch(/\b(?:fetch|Date\.now|Math\.random)\s*\(/);
    expect(source).not.toMatch(/from\s+["'](?:pg|node:(?:http|https|net)|[^"']*\/models(?:\/[^"']*)?)["']/i);
    fetchSpy.mockRestore();
    dateSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it("advances high-water deterministically across every canonical non-accounting event", () => {
    const events: ChallengeLedgerEvent[] = [stageStarted];
    for (const [index, type] of REPLAY_NOOP_EVENT_TYPES.entries()) {
      events.push({
        id: `noop-${index + 1}`,
        type,
        profileVersionId: INITIAL_PROFILE.profileVersionId,
      });
    }
    expect(replayLedger(events)).toMatchObject({
      balance: "2500.00",
      equity: "2500.00",
      realizedPnl: "0.00",
      unrealizedPnl: "0.00",
      openPositions: 0,
      highWaterId: `noop-${REPLAY_NOOP_EVENT_TYPES.length}`,
    });
  });

  it("accepts the canonical lifecycle prelude before exactly one stage start", () => {
    const prelude = [
      "challenge.created",
      "challenge.profile.versioned",
      "challenge.started",
      "stage.created",
    ].map((type, index) => ({
      id: `prelude-${index + 1}`,
      type,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
    })) as ChallengeLedgerEvent[];
    const events = [
      ...prelude,
      { ...stageStarted, id: "stage-start" },
      {
        id: "fee-after-start",
        type: "fee.recorded",
        amount: "1.00",
        profileVersionId: INITIAL_PROFILE.profileVersionId,
      },
    ] as ChallengeLedgerEvent[];

    expect(replayLedger(events)).toMatchObject({
      balance: "2499.00",
      highWaterId: "fee-after-start",
      profileVersionId: INITIAL_PROFILE.profileVersionId,
    });
    expect(() => replayLedger([
      prelude[0]!,
      { id: "fee-too-early", type: "fee.recorded", amount: "1.00" },
    ])).toThrow("LEDGER_STAGE_NOT_STARTED");
    expect(() => replayLedger([
      ...prelude,
      stageStarted,
      { ...stageStarted, id: "second-stage-start" },
    ])).toThrow("LEDGER_STAGE_ALREADY_STARTED");
  });

  it("binds a future published profile across prelude, start, no-op, and accounting", () => {
    const futureProfileVersionId = randomUUID();
    const events = [
      {
        id: "future-profile-prelude",
        type: "challenge.profile.versioned",
        profileVersionId: futureProfileVersionId,
      },
      {
        id: "future-stage-created",
        type: "stage.created",
        profileVersionId: futureProfileVersionId,
      },
      {
        id: "future-stage-started",
        type: "stage.started",
        amount: "5000.00",
        profileVersionId: futureProfileVersionId,
      },
      {
        id: "future-noop",
        type: "challenge.paused",
        profileVersionId: futureProfileVersionId,
      },
      {
        id: "future-fee",
        type: "fee.recorded",
        amount: "1.00",
        profileVersionId: futureProfileVersionId,
      },
    ] as ChallengeLedgerEvent[];

    expect(replayLedger(events)).toMatchObject({
      balance: "4999.00",
      profileVersionId: futureProfileVersionId,
      highWaterId: "future-fee",
    });
  });
});

describe("Challenge ledger persistence", () => {
  it("creates every append-only Challenge structure and rejects source-history mutation", async () => {
    const { db } = await testContext();
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema=current_schema() and table_name like 'challenge_%'
       order by table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      "challenge_portfolios",
      "challenge_stages",
      "challenge_intents",
      "challenge_orders",
      "challenge_fills",
      "challenge_positions",
      "challenge_position_closures",
      "challenge_price_marks",
      "challenge_fees",
      "challenge_financing",
      "challenge_rule_evaluations",
      "challenge_ledger_events",
      "challenge_projection_checkpoints",
    ]));
    const immutableSourceTables = [
      "challenge_stages",
      "challenge_ledger_events",
      "challenge_intents",
      "challenge_orders",
      "challenge_positions",
      "challenge_position_closures",
      "challenge_fills",
      "challenge_price_marks",
      "challenge_fees",
      "challenge_financing",
      "challenge_rule_evaluations",
    ];
    const immutableTriggers = await db.query<{
      table_name: string;
      enabled: string;
      definition: string;
    }>(
      `select relation.relname as table_name, trigger.tgenabled as enabled,
              pg_get_triggerdef(trigger.oid) as definition
         from pg_trigger trigger
         join pg_class relation on relation.oid=trigger.tgrelid
        where not trigger.tgisinternal
          and trigger.tgname like 'challenge_%_immutable'
          and relation.relname=any($1::text[])
        order by relation.relname`,
      [immutableSourceTables],
    );
    expect(immutableTriggers.map((row) => row.table_name)).toEqual([
      "challenge_fees",
      "challenge_fills",
      "challenge_financing",
      "challenge_intents",
      "challenge_ledger_events",
      "challenge_orders",
      "challenge_position_closures",
      "challenge_positions",
      "challenge_price_marks",
      "challenge_rule_evaluations",
      "challenge_stages",
    ]);
    for (const trigger of immutableTriggers) {
      expect(trigger.enabled).toBe("O");
      expect(trigger.definition).toContain("BEFORE");
      expect(trigger.definition).toContain("UPDATE");
      expect(trigger.definition).toContain("DELETE");
    }

    const stageId = randomUUID();
    const stageProfileId = "00000000-0000-4000-8000-000000001211";
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,$4,1,$5)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        stageProfileId, "2026-08-09T00:00:00.000Z"],
    );
    const eventId = randomUUID();
    await db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,1,'stage.started',$5,$6,'SYSTEM','test-ledger','stage-start')`,
      [eventId, INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, { amount: "2500.00" },
        "2026-08-09T00:00:00.000Z"],
    );

    await expect(db.query(
      "update challenge_ledger_events set payload='{}'::jsonb where id=$1",
      [eventId],
    )).rejects.toThrow("IMMUTABLE_CHALLENGE_LEDGER_EVENT");
    await expect(db.query(
      "delete from challenge_ledger_events where id=$1",
      [eventId],
    )).rejects.toThrow("IMMUTABLE_CHALLENGE_LEDGER_EVENT");
    await expect(db.query(
      "update challenge_stages set ordinal=2 where id=$1",
      [stageId],
    )).rejects.toThrow("IMMUTABLE_CHALLENGE_STAGE");
    await expect(db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,$4,2,$5)`,
      [randomUUID(), INITIAL_PROFILE.challengePortfolioId, randomUUID(),
        "00000000-0000-4000-8000-000000001212", "2026-08-09T00:00:01.000Z"],
    )).rejects.toThrow("CHALLENGE_STAGE_PROFILE_BINDING_INVALID");
  }, 30_000);

  it("allocates sequences under one stage lock and resolves exact idempotent retries", async () => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    const baseInput = {
      challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      occurredAt: "2026-08-09T00:00:00.000Z",
      actorType: "SYSTEM",
      actorId: "challenge-replay-test",
    } as const;
    await appendChallengeLedgerEvent({ db }, {
      ...baseInput,
      id: randomUUID(),
      type: "stage.started",
      payload: { amount: "2500.00" },
      idempotencyKey: "append-stage-started",
    });
    const firstSystemEvent = {
      ...baseInput,
      id: randomUUID(),
      type: "challenge.started",
      payload: { evidence: { source: "test", nested: ["one", { confidence: "known" }] } },
      idempotencyKey: "append-system-1",
    } as const;
    const secondSystemEvent = {
      ...baseInput,
      id: randomUUID(),
      type: "challenge.paused",
      payload: { reason: "deterministic test" },
      idempotencyKey: "append-system-2",
    } as const;
    const concurrent = await Promise.all([
      appendChallengeLedgerEvent({ db }, firstSystemEvent),
      appendChallengeLedgerEvent({ db }, secondSystemEvent),
    ]);
    expect(concurrent.map((event) => event.sequence).sort()).toEqual(["2", "3"]);

    const retry = await appendChallengeLedgerEvent({ db }, firstSystemEvent);
    expect(retry).toEqual(concurrent.find((event) => event.id === firstSystemEvent.id));
    const secondsOnlyRetry = await appendChallengeLedgerEvent({ db }, {
      ...firstSystemEvent,
      occurredAt: "2026-08-09T00:00:00Z",
    });
    expect(secondsOnlyRetry).toEqual(retry);
    await expect(appendChallengeLedgerEvent({ db }, {
      ...firstSystemEvent,
      payload: { evidence: { source: "conflict" } },
    })).rejects.toThrow("CHALLENGE_LEDGER_IDEMPOTENCY_CONFLICT");
    await expect(appendChallengeLedgerEvent({ db }, {
      ...baseInput,
      id: randomUUID(),
      type: "challenge.paused",
      payload: { reason: "impossible calendar date" },
      occurredAt: "2027-02-30T00:00:00Z",
      idempotencyKey: "append-impossible-calendar-date",
    })).rejects.toThrow("CHALLENGE_LEDGER_OCCURRED_AT_INVALID");
    await expect(appendChallengeLedgerEvent({ db }, {
      ...baseInput,
      id: randomUUID(),
      type: "challenge.started",
      payload: { amount: undefined } as unknown as { readonly amount: string },
      idempotencyKey: "append-invalid-json",
    })).rejects.toThrow("CHALLENGE_LEDGER_PAYLOAD_INVALID");
    const oversizedPayload = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, index) => [`key${index}`, "value"]),
    );
    await expect(appendChallengeLedgerEvent({ db }, {
      ...baseInput,
      id: randomUUID(),
      type: "challenge.paused",
      payload: oversizedPayload,
      idempotencyKey: "append-oversized-json",
    })).rejects.toThrow("CHALLENGE_LEDGER_PAYLOAD_INVALID");

    const causalEventId = randomUUID();
    const correlationId = randomUUID();
    await appendChallengeLedgerEvent({ db }, {
      ...baseInput,
      id: causalEventId,
      type: "challenge.passed",
      payload: { reason: "causal provenance" },
      causationId: firstSystemEvent.id,
      correlationId,
      idempotencyKey: "append-causal-event",
    });
    await expect(appendChallengeLedgerEvent({ db }, {
      ...baseInput,
      id: randomUUID(),
      type: "challenge.failed",
      payload: {},
      causationId: randomUUID(),
      idempotencyKey: "append-future-causation",
    })).rejects.toThrow();
    const selfCausedId = randomUUID();
    await expect(appendChallengeLedgerEvent({ db }, {
      ...baseInput,
      id: selfCausedId,
      type: "challenge.failed",
      payload: {},
      causationId: selfCausedId,
      idempotencyKey: "append-self-causation",
    })).rejects.toThrow("CHALLENGE_LEDGER_CAUSATION_INVALID");
    expect(await db.query(
      `select sequence::text, idempotency_key from challenge_ledger_events
        where stage_id=$1 order by sequence`,
      [stageId],
    )).toEqual([
      { sequence: "1", idempotency_key: "append-stage-started" },
      expect.objectContaining({ sequence: "2" }),
      expect.objectContaining({ sequence: "3" }),
      { sequence: "4", idempotency_key: "append-causal-event" },
    ]);
    const loaded = await loadChallengeLedgerEvents({ db }, stageId);
    expect(loaded.map((event) => event.sequence)).toEqual(["1", "2", "3", "4"]);
    expect(loaded[3]).toMatchObject({
      causationId: firstSystemEvent.id,
      correlationId,
    });
    const replayed = replayStoredLedgerEvents(loaded);
    expect(replayed).toMatchObject({
      balance: "2500.00",
      equity: "2500.00",
      highWaterId: loaded[3]!.id,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
    });
  }, 30_000);

  it.each([
    ["array hole", () => new Array(1)],
    ["custom array property", () => {
      const value = ["safe"];
      Object.defineProperty(value, "extra", { enumerable: true, value: "unsafe" });
      return value;
    }],
    ["symbol array property", () => {
      const value = ["safe"];
      Object.defineProperty(value, Symbol("unsafe"), { enumerable: true, value: "unsafe" });
      return value;
    }],
    ["custom array prototype", () => {
      const value = ["safe"];
      Object.setPrototypeOf(value, Object.create(Array.prototype));
      return value;
    }],
    ["huge sparse array", () => {
      const backing: unknown[] = [];
      backing.length = 1_000_000;
      return new Proxy(backing, {
        has: () => {
          throw new Error("SPARSE_ARRAY_ITERATED");
        },
      });
    }],
  ] as const)("rejects a hostile payload %s before persistence", async (_name, makeArray) => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );

    await expect(appendChallengeLedgerEvent({ db }, {
      id: randomUUID(),
      challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      type: "challenge.created",
      payload: { hostile: makeArray() } as never,
      occurredAt: "2026-08-09T00:00:00.000Z",
      actorType: "SYSTEM",
      actorId: "payload-snapshot-test",
      idempotencyKey: `hostile-array-${_name}`,
    })).rejects.toThrow("CHALLENGE_LEDGER_PAYLOAD_INVALID");
  }, 30_000);

  it("snapshots an own __proto__ payload key without mutating the clone prototype", async () => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    const rawPayload: Record<string, unknown> = {};
    Object.defineProperty(rawPayload, "__proto__", {
      enumerable: true,
      value: { safe: true },
    });

    const stored = await appendChallengeLedgerEvent({ db }, {
      id: randomUUID(),
      challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      type: "challenge.created",
      payload: rawPayload as never,
      occurredAt: "2026-08-09T00:00:00.000Z",
      actorType: "SYSTEM",
      actorId: "payload-snapshot-test",
      idempotencyKey: "own-proto-payload",
    });

    expect(Object.hasOwn(stored.payload, "__proto__")).toBe(true);
    expect(stored.payload.__proto__).toEqual({ safe: true });
  }, 30_000);

  it("permits only stage.advanced causation into the successor stage.created event", async () => {
    const { db } = await testContext();
    const firstStageId = randomUUID();
    const successorStageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values
       ($1,$3,$4,'00000000-0000-4000-8000-000000001211',1,$5),
       ($2,$3,$4,'00000000-0000-4000-8000-000000001212',2,$5)`,
      [firstStageId, successorStageId, INITIAL_PROFILE.challengePortfolioId,
        INITIAL_PROFILE.profileVersionId, "2026-08-09T00:00:00.000Z"],
    );
    const common = {
      challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      actorType: "SYSTEM",
      actorId: "challenge-lifecycle",
    } as const;
    await appendChallengeLedgerEvent({ db }, {
      ...common,
      id: randomUUID(),
      stageId: firstStageId,
      type: "stage.started",
      payload: { amount: "2500.00" },
      occurredAt: "2026-08-09T00:00:00.000Z",
      idempotencyKey: "causal-first-stage-start",
    });
    const advancedId = randomUUID();
    await appendChallengeLedgerEvent({ db }, {
      ...common,
      id: advancedId,
      stageId: firstStageId,
      type: "stage.advanced",
      payload: {},
      occurredAt: "2026-08-09T00:01:00.000Z",
      idempotencyKey: "causal-stage-advanced",
    });
    const successorCreated = await appendChallengeLedgerEvent({ db }, {
      ...common,
      id: randomUUID(),
      stageId: successorStageId,
      type: "stage.created",
      payload: {},
      occurredAt: "2026-08-09T00:01:00.000Z",
      causationId: advancedId,
      idempotencyKey: "causal-successor-stage-created",
    });
    expect(successorCreated).toMatchObject({ sequence: "1", causationId: advancedId });
    await expect(appendChallengeLedgerEvent({ db }, {
      ...common,
      id: randomUUID(),
      stageId: successorStageId,
      type: "challenge.created",
      payload: {},
      occurredAt: "2026-08-09T00:01:01.000Z",
      causationId: advancedId,
      idempotencyKey: "causal-invalid-cross-stage-event",
    })).rejects.toThrow("CHALLENGE_LEDGER_CAUSATION_INVALID");
  }, 30_000);

  it("persists and replays the canonical lifecycle prelude before accounting", async () => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    const base = {
      challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      payload: {},
      actorType: "SYSTEM",
      actorId: "challenge-lifecycle",
    } as const;
    for (const [index, type] of [
      "challenge.created",
      "challenge.profile.versioned",
      "challenge.started",
      "stage.created",
    ].entries()) {
      await appendChallengeLedgerEvent({ db }, {
        ...base,
        id: randomUUID(),
        type,
        occurredAt: `2026-08-09T00:00:0${index}.000Z`,
        idempotencyKey: `lifecycle-prelude-${index}`,
      });
    }
    const stageStartId = randomUUID();
    await appendChallengeLedgerEvent({ db }, {
      ...base,
      id: stageStartId,
      type: "stage.started",
      payload: { amount: "2500.00" },
      occurredAt: "2026-08-09T00:00:04.000Z",
      idempotencyKey: "lifecycle-stage-start",
    });
    const feeEventId = randomUUID();
    const feeId = randomUUID();
    await db.transaction(async (transaction) => {
      await transaction.query(
        `insert into challenge_ledger_events (
           id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
           type, payload, occurred_at, actor_type, actor_id, idempotency_key
         ) values ($1,$2,$3,$4,6,'fee.recorded',$5,$6,'SYSTEM','challenge-lifecycle',$7)`,
        [feeEventId, INITIAL_PROFILE.challengePortfolioId, stageId,
          INITIAL_PROFILE.profileVersionId, {
            feeId, positionId: null, orderId: null, amount: "1.00",
            category: "COMMISSION", recordedAt: "2026-08-09T00:00:05.000Z",
          }, "2026-08-09T00:00:05.000Z", "lifecycle-fee"],
      );
      await transaction.query(
        `insert into challenge_fees (
           id, stage_id, profile_version_id, ledger_event_id, position_id,
           order_id, amount, category, recorded_at
         ) values ($1,$2,$3,$4,null,null,'1.00','COMMISSION',$5)`,
        [feeId, stageId, INITIAL_PROFILE.profileVersionId, feeEventId,
          "2026-08-09T00:00:05.000Z"],
      );
    });

    const loaded = await loadChallengeLedgerEvents({ db }, stageId);
    expect(loaded.map((event) => event.sequence)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(replayStoredLedgerEvents(loaded)).toMatchObject({
      balance: "2499.00",
      highWaterId: feeEventId,
    });

    const invalidStageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001212',2,$4)`,
      [invalidStageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    await expect(db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,1,'fee.recorded',$5,$6,'SYSTEM','challenge-lifecycle',$7)`,
      [randomUUID(), INITIAL_PROFILE.challengePortfolioId, invalidStageId,
        INITIAL_PROFILE.profileVersionId, { amount: "1.00" },
        "2026-08-09T00:00:00.000Z", "lifecycle-accounting-too-early"],
    )).rejects.toThrow("CHALLENGE_LEDGER_STAGE_START_REQUIRED");
    await expect(db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,7,'stage.started',$5,$6,'SYSTEM','challenge-lifecycle',$7)`,
      [randomUUID(), INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, { amount: "2500.00" },
        "2026-08-09T00:00:06.000Z", "lifecycle-duplicate-stage-start"],
    )).rejects.toThrow("CHALLENGE_LEDGER_STAGE_ALREADY_STARTED");
  }, 30_000);

  it("enforces the bound stage balance and authoritative Main actor in app and SQL", async () => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    const common = {
      challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      occurredAt: "2026-08-09T00:00:00.000Z",
      type: "stage.started",
      payload: { amount: "2500.01" },
      actorType: "SYSTEM",
      actorId: "challenge-engine",
    } as const;
    await expect(appendChallengeLedgerEvent({ db }, {
      ...common,
      id: randomUUID(),
      idempotencyKey: "wrong-bound-stage-balance-app",
    })).rejects.toThrow("CHALLENGE_STAGE_START_AMOUNT_INVALID");
    await expect(appendChallengeLedgerEvent({ db }, {
      ...common,
      id: randomUUID(),
      payload: { amount: 2500 },
      idempotencyKey: "numeric-bound-stage-balance-app",
    })).rejects.toThrow("CHALLENGE_STAGE_START_AMOUNT_INVALID");
    await expect(db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,1,'stage.started',$5,$6,'SYSTEM','challenge-engine',$7)`,
      [randomUUID(), INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, { amount: "2499.99" },
        "2026-08-09T00:00:00.000Z", "wrong-bound-stage-balance-sql"],
    )).rejects.toThrow("CHALLENGE_STAGE_START_AMOUNT_INVALID");
    await expect(db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,1,'stage.started',$5,$6,'SYSTEM','challenge-engine',$7)`,
      [randomUUID(), INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, { amount: 2500 },
        "2026-08-09T00:00:00.000Z", "numeric-bound-stage-balance-sql"],
    )).rejects.toThrow("CHALLENGE_STAGE_START_AMOUNT_INVALID");
    await expect(appendChallengeLedgerEvent({ db }, {
      ...common,
      id: randomUUID(),
      payload: { amount: "2500.00" },
      actorType: "MAIN_BRAIN",
      actorId: "not-gustavo-main",
      idempotencyKey: "unauthorized-main-app",
    })).rejects.toThrow("CHALLENGE_LEDGER_ACTOR_ID_INVALID");
    await expect(db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,1,'stage.started',$5,$6,'MAIN_BRAIN','not-gustavo-main',$7)`,
      [randomUUID(), INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, { amount: "2500.00" },
        "2026-08-09T00:00:00.000Z", "unauthorized-main-sql"],
    )).rejects.toThrow();
  }, 30_000);

  it("rejects orphan and mismatched typed events, then rebuilds exactly from immutable source", async () => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    const insertEvent = async (
      transaction: typeof db,
      event: { readonly id: string; readonly sequence: number; readonly type: string; readonly payload: object; readonly key: string },
    ) => transaction.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'SYSTEM','challenge-engine',$9)`,
      [event.id, INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, event.sequence, event.type, event.payload,
        `2026-08-09T00:00:0${event.sequence}.000Z`, event.key],
    );
    const stageEventId = randomUUID();
    await insertEvent(db, {
      id: stageEventId, sequence: 1, type: "stage.started",
      payload: { amount: "2500.00" }, key: "rebuild-stage-start",
    });
    const nestedEventId = randomUUID();
    await insertEvent(db, {
      id: nestedEventId, sequence: 2, type: "challenge.started",
      payload: { evidence: { providers: ["licensed-test"], detail: { complete: true } } },
      key: "rebuild-nested-noop",
    });

    await expect(db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, {
        id: randomUUID(), sequence: 3, type: "fee.recorded",
        payload: {
          feeId: randomUUID(), positionId: null, orderId: null,
          amount: "1.00", category: "COMMISSION",
        },
        key: "orphan-fee",
      });
    })).rejects.toThrow("CHALLENGE_LEDGER_TYPED_SOURCE_MISSING");

    const mismatchEventId = randomUUID();
    const mismatchFeeId = randomUUID();
    await expect(db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, {
        id: mismatchEventId, sequence: 3, type: "fee.recorded",
        payload: {
          feeId: mismatchFeeId, positionId: null, orderId: null,
          amount: "1.00", category: "COMMISSION",
        },
        key: "mismatch-fee",
      });
      await transaction.query(
        `insert into challenge_fees (
           id, stage_id, profile_version_id, ledger_event_id, amount, category, recorded_at
         ) values ($1,$2,$3,$4,'2.00','COMMISSION',$5)`,
        [mismatchFeeId, stageId, INITIAL_PROFILE.profileVersionId,
          mismatchEventId, "2026-08-09T00:00:03.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_SOURCE_PAYLOAD_MISMATCH");

    const feeEventId = randomUUID();
    const feeId = randomUUID();
    await db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, {
        id: feeEventId, sequence: 3, type: "fee.recorded",
        payload: {
          feeId, positionId: null, orderId: null,
          amount: "1.00", category: "COMMISSION",
          recordedAt: "2026-08-09T00:00:03Z",
        },
        key: "valid-fee",
      });
      await transaction.query(
        `insert into challenge_fees (
           id, stage_id, profile_version_id, ledger_event_id, amount, category, recorded_at
         ) values ($1,$2,$3,$4,'1.00','COMMISSION',$5)`,
        [feeId, stageId, INITIAL_PROFILE.profileVersionId,
          feeEventId, "2026-08-09T00:00:03.000Z"],
      );
    });
    const loaded = await loadChallengeLedgerEvents({ db }, stageId);
    const rebuilt = replayStoredLedgerEvents(loaded);
    expect(rebuilt).toMatchObject({
      balance: "2499.00",
      equity: "2499.00",
      realizedPnl: "-1.00",
      highWaterId: feeEventId,
    });

    await replaceProjectionCheckpoint({ db }, {
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: feeEventId,
      highWaterSequence: "3",
      projection: rebuilt,
    });
    const saved = await loadProjectionCheckpoint({ db }, stageId);
    await db.query("delete from challenge_projection_checkpoints where stage_id=$1", [stageId]);
    const rebuiltAfterDelete = replayStoredLedgerEvents(
      await loadChallengeLedgerEvents({ db }, stageId),
    );
    expect(rebuiltAfterDelete).toEqual(saved?.projection);
    expect(rebuiltAfterDelete).toEqual(rebuilt);
  }, 30_000);

  it.each([
    ["entryPrice", "101.00", undefined],
    ["stopPrice", "94.00", undefined],
    ["targetPrice", "111.00", undefined],
    ["desiredRisk", "26.00", undefined],
    ["expiresAt", "2026-08-09T02:00:00.000Z", undefined],
    ["entryPrice", "100", 100],
    ["stopPrice", "95", 95],
    ["targetPrice", "110", 110],
    ["desiredRisk", "25", 25],
  ] as const)("rejects intent source mismatch or numeric payload for %s", async (
    field,
    mismatchedValue,
    numericPayload,
  ) => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    await db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,1,'stage.started',$5,$6,'SYSTEM','challenge-engine',$7)`,
      [randomUUID(), INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, { amount: "2500.00" },
        "2026-08-09T00:00:00.000Z", `intent-mismatch-stage-${field}`],
    );
    const intentId = randomUUID();
    const eventId = randomUUID();
    const canonical = {
      entryPrice: "100.00",
      stopPrice: "95.00",
      targetPrice: "110.00",
      desiredRisk: "25.00",
      expiresAt: "2026-08-09T01:00:00.000Z",
    };
    const row = { ...canonical, [field]: mismatchedValue };
    await expect(db.transaction(async (transaction) => {
      await transaction.query(
        `insert into challenge_ledger_events (
           id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
           type, payload, occurred_at, actor_type, actor_id, idempotency_key
         ) values ($1,$2,$3,$4,2,'paper.intent.proposed',$5,$6,'MAIN_BRAIN','gustavo-main',$7)`,
        [eventId, INITIAL_PROFILE.challengePortfolioId, stageId,
          INITIAL_PROFILE.profileVersionId, {
            intentId, direction: "PAPER_LONG", symbol: "AAPL", initialStatus: "PROPOSED",
            ...canonical,
            createdAt: "2026-08-09T00:00:01.000Z",
            ...(numericPayload === undefined ? {} : { [field]: numericPayload }),
          }, "2026-08-09T00:00:01.000Z", `intent-mismatch-${field}`],
      );
      await transaction.query(
        `insert into challenge_intents (
           id, stage_id, profile_version_id, ledger_event_id, symbol, direction,
           entry_price, stop_price, target_price, desired_risk, expires_at,
           initial_status, created_at
         ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG',$5,$6,$7,$8,$9,
                   'PROPOSED',$10)`,
        [intentId, stageId, INITIAL_PROFILE.profileVersionId, eventId,
          row.entryPrice, row.stopPrice, row.targetPrice, row.desiredRisk,
          row.expiresAt, "2026-08-09T00:00:01.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_SOURCE_PAYLOAD_MISMATCH");
  }, 30_000);

  it("serializes fill and close quantities so every committed stream replays", async () => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    await db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,1,'stage.started',$5,$6,'SYSTEM','stream-test',$7)`,
      [randomUUID(), INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, { amount: "2500.00" },
        "2026-08-09T00:00:00.000Z", "stream-stage-start"],
    );
    const intentId = randomUUID();
    const orderId = randomUUID();
    const positionId = randomUUID();
    const initialFillId = randomUUID();
    await db.transaction(async (transaction) => {
      const intentEventId = randomUUID();
      await transaction.query(
        `insert into challenge_ledger_events (
           id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
           type, payload, occurred_at, actor_type, actor_id, idempotency_key
         ) values ($1,$2,$3,$4,2,'paper.intent.proposed',$5,$6,'MAIN_BRAIN','gustavo-main',$7)`,
        [intentEventId, INITIAL_PROFILE.challengePortfolioId, stageId,
          INITIAL_PROFILE.profileVersionId, {
            intentId, direction: "PAPER_LONG", symbol: "AAPL",
            entryPrice: "100.00", stopPrice: "95.00", targetPrice: "110.00",
            desiredRisk: "25.00", expiresAt: "2026-08-09T01:00:00.000Z",
            initialStatus: "PROPOSED", createdAt: "2026-08-09T00:00:01.000Z",
          }, "2026-08-09T00:00:01.000Z", "stream-intent"],
      );
      await transaction.query(
        `insert into challenge_intents (
           id, stage_id, profile_version_id, ledger_event_id, symbol, direction,
           entry_price, stop_price, target_price, desired_risk, expires_at,
           initial_status, created_at
         ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','95.00','110.00',
                   '25.00',$5,'PROPOSED',$6)`,
        [intentId, stageId, INITIAL_PROFILE.profileVersionId, intentEventId,
          "2026-08-09T01:00:00.000Z", "2026-08-09T00:00:01.000Z"],
      );
      const orderEventId = randomUUID();
      await transaction.query(
        `insert into challenge_ledger_events (
           id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
           type, payload, occurred_at, actor_type, actor_id, idempotency_key
         ) values ($1,$2,$3,$4,3,'paper.order.created',$5,$6,'SYSTEM','stream-test',$7)`,
        [orderEventId, INITIAL_PROFILE.challengePortfolioId, stageId,
          INITIAL_PROFILE.profileVersionId, {
            orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "2",
            initialStatus: "PENDING", createdAt: "2026-08-09T00:00:02.000Z",
          }, "2026-08-09T00:00:02.000Z", "stream-order"],
      );
      await transaction.query(
        `insert into challenge_orders (
           id, intent_id, stage_id, profile_version_id, ledger_event_id,
           symbol, side, quantity, initial_status, created_at
         ) values ($1,$2,$3,$4,$5,'AAPL','BUY','2','PENDING',$6)`,
        [orderId, intentId, stageId, INITIAL_PROFILE.profileVersionId,
          orderEventId, "2026-08-09T00:00:02.000Z"],
      );
      const fillEventId = randomUUID();
      await transaction.query(
        `insert into challenge_ledger_events (
           id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
           type, payload, occurred_at, actor_type, actor_id, idempotency_key
         ) values ($1,$2,$3,$4,4,'paper.fill.created',$5,$6,'SYSTEM','stream-test',$7)`,
        [fillEventId, INITIAL_PROFILE.challengePortfolioId, stageId,
          INITIAL_PROFILE.profileVersionId, {
             fillId: initialFillId, orderId, positionId, symbol: "AAPL", side: "BUY",
             quantity: "1", price: "100.00", commission: "0.00",
             openedAt: "2026-08-09T00:00:03.000Z",
             filledAt: "2026-08-09T00:00:03.000Z",
          }, "2026-08-09T00:00:03.000Z", "stream-opening-fill"],
      );
      await transaction.query(
        `insert into challenge_positions (
           id, stage_id, profile_version_id, opening_ledger_event_id,
           symbol, side, opened_at
         ) values ($1,$2,$3,$4,'AAPL','BUY',$5)`,
        [positionId, stageId, INITIAL_PROFILE.profileVersionId, fillEventId,
          "2026-08-09T00:00:03.000Z"],
      );
      await transaction.query(
        `insert into challenge_fills (
           id, order_id, position_id, stage_id, profile_version_id,
           ledger_event_id, side, quantity, price, commission, filled_at
         ) values ($1,$2,$3,$4,$5,$6,'BUY','1','100.00','0.00',$7)`,
        [initialFillId, orderId, positionId, stageId,
          INITIAL_PROFILE.profileVersionId, fillEventId, "2026-08-09T00:00:03.000Z"],
      );
    });

    const appendNext = async (
      transaction: typeof db,
      type: string,
      payload: object,
      key: string,
    ): Promise<string> => {
      await transaction.query("select id from challenge_stages where id=$1 for update", [stageId]);
      const [{ sequence }] = await transaction.query<{ sequence: string }>(
        "select (coalesce(max(sequence),0)+1)::text as sequence from challenge_ledger_events where stage_id=$1",
        [stageId],
      );
      const eventId = randomUUID();
      await transaction.query(
        `insert into challenge_ledger_events (
           id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
           type, payload, occurred_at, actor_type, actor_id, idempotency_key
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,'SYSTEM','stream-test',$9)`,
        [eventId, INITIAL_PROFILE.challengePortfolioId, stageId,
          INITIAL_PROFILE.profileVersionId, sequence, type, payload,
          "2026-08-09T00:00:10.000Z", key],
      );
      return eventId;
    };
    const insertFill = (quantity: string, side: "BUY" | "SELL", key: string) =>
      db.transaction(async (transaction) => {
        const fillId = randomUUID();
        const filledAt = "2026-08-09T00:00:10.000Z";
        const eventId = await appendNext(transaction as typeof db, "paper.fill.created", {
          fillId, orderId, positionId, symbol: "AAPL", side, quantity,
          price: "100.00", commission: "0.00", filledAt,
        }, key);
        await transaction.query(
          `insert into challenge_fills (
             id, order_id, position_id, stage_id, profile_version_id,
             ledger_event_id, side, quantity, price, commission, filled_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,'100.00','0.00',$9)`,
          [fillId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
            eventId, side, quantity, filledAt],
        );
      });

    await expect(insertFill("0.25", "SELL", "stream-wrong-side"))
      .rejects.toThrow("CHALLENGE_FILL_STREAM_INVALID");
    await expect(insertFill("1.01", "BUY", "stream-overfill"))
      .rejects.toThrow("CHALLENGE_FILL_QUANTITY_EXCEEDS_ORDER");
    const fillResults = await Promise.allSettled([
      insertFill("0.75", "BUY", "stream-concurrent-fill-a"),
      insertFill("0.75", "BUY", "stream-concurrent-fill-b"),
    ]);
    expect(fillResults.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((fillResults.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ message: expect.stringContaining("CHALLENGE_FILL_QUANTITY_EXCEEDS_ORDER") });

    await expect(db.transaction(async (transaction) => {
      const earlierClosureId = randomUUID();
      const laterClosureId = randomUUID();
      const closedAt = "2026-08-09T00:00:10.000Z";
      const earlierEventId = await appendNext(
        transaction as typeof db,
        "paper.position.closed",
        {
          closureId: earlierClosureId, positionId, quantity: "1", price: "100.00",
          commission: "0.00", closedAt,
        },
        "stream-deferred-close-earlier",
      );
      const laterEventId = await appendNext(
        transaction as typeof db,
        "paper.position.closed",
        {
          closureId: laterClosureId, positionId, quantity: "1", price: "100.00",
          commission: "0.00", closedAt,
        },
        "stream-deferred-close-later",
      );
      const insertClosure = (closureId: string, eventId: string) => transaction.query(
        `insert into challenge_position_closures (
           id,position_id,stage_id,profile_version_id,ledger_event_id,
           quantity,price,commission,closed_at
         ) values ($1,$2,$3,$4,$5,'1','100.00','0.00',$6)`,
        [closureId, positionId, stageId, INITIAL_PROFILE.profileVersionId, eventId, closedAt],
      );
      await insertClosure(laterClosureId, laterEventId);
      await insertClosure(earlierClosureId, earlierEventId);
    })).rejects.toThrow("CHALLENGE_CLOSE_QUANTITY_EXCEEDS_POSITION");

    const insertClose = (quantity: string | null, key: string) =>
      db.transaction(async (transaction) => {
        const closureId = randomUUID();
        const closedAt = "2026-08-09T00:00:10.000Z";
        const eventId = await appendNext(transaction as typeof db, "paper.position.closed", {
          closureId, positionId, quantity, price: "100.00", commission: "0.00", closedAt,
        }, key);
        await transaction.query(
          `insert into challenge_position_closures (
             id, position_id, stage_id, profile_version_id, ledger_event_id,
             quantity, price, commission, closed_at
           ) values ($1,$2,$3,$4,$5,$6,'100.00','0.00',$7)`,
          [closureId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
            eventId, quantity, closedAt],
        );
      });
    const closeResults = await Promise.allSettled([
      insertClose("1.25", "stream-concurrent-close-a"),
      insertClose("1.25", "stream-concurrent-close-b"),
    ]);
    expect(closeResults.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((closeResults.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ message: expect.stringContaining("CHALLENGE_CLOSE_QUANTITY_EXCEEDS_POSITION") });
    await insertClose(null, "stream-full-close");
    await expect(insertClose("0.01", "stream-close-after-full"))
      .rejects.toThrow("CHALLENGE_POSITION_ALREADY_CLOSED");

    const loaded = await loadChallengeLedgerEvents({ db }, stageId);
    expect(replayStoredLedgerEvents(loaded)).toMatchObject({
      balance: "2500.00",
      equity: "2500.00",
      openPositions: 0,
      highWaterId: loaded.at(-1)!.id,
    });
  }, 30_000);

  it("rejects an order whose referenced intent event occurs later in the stage", async () => {
    const { db, stageId, insertEvent } = await dependencyStage();
    const intentId = randomUUID();
    const orderId = randomUUID();
    const orderEventId = randomUUID();
    const intentEventId = randomUUID();

    await expect(db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, 2, orderEventId, "paper.order.created", {
        orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "1",
        initialStatus: "PENDING", createdAt: "2026-08-09T00:00:02.000Z",
      }, "dependency-order-before-intent");
      await insertEvent(transaction as typeof db, 3, intentEventId, "paper.intent.proposed", {
        intentId, direction: "PAPER_LONG", symbol: "AAPL", entryPrice: "100.00",
        stopPrice: "95.00", targetPrice: "110.00", desiredRisk: "25.00",
        expiresAt: "2026-08-09T01:00:00.000Z", initialStatus: "PROPOSED",
        createdAt: "2026-08-09T00:00:03.000Z",
      }, "dependency-later-intent");
      await transaction.query(
        `insert into challenge_intents (
           id, stage_id, profile_version_id, ledger_event_id, symbol, direction,
           entry_price, stop_price, target_price, desired_risk, expires_at,
           initial_status, created_at
         ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','95.00','110.00',
                   '25.00',$5,'PROPOSED',$6)`,
        [intentId, stageId, INITIAL_PROFILE.profileVersionId, intentEventId,
          "2026-08-09T01:00:00.000Z", "2026-08-09T00:00:03.000Z"],
      );
      await transaction.query(
        `insert into challenge_orders (
           id, intent_id, stage_id, profile_version_id, ledger_event_id,
           symbol, side, quantity, initial_status, created_at
         ) values ($1,$2,$3,$4,$5,'AAPL','BUY','1','PENDING',$6)`,
        [orderId, intentId, stageId, INITIAL_PROFILE.profileVersionId,
          orderEventId, "2026-08-09T00:00:02.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID");
  }, 30_000);

  it.each(["order", "opening"] as const)(
    "rejects a fill whose %s dependency event is later",
    async (dependency) => {
      const { db, stageId, insertEvent } = await dependencyStage();
      const intentId = randomUUID();
      const orderId = randomUUID();
      const positionId = randomUUID();
      const intentEventId = randomUUID();
      const orderEventId = randomUUID();
      const openingEventId = randomUUID();
      const openingFillId = randomUUID();
      const earlierFillEventId = dependency === "opening" ? randomUUID() : openingEventId;
      const earlierFillId = dependency === "opening" ? randomUUID() : openingFillId;
      const intentSequence = dependency === "order" ? 3 : 2;
      const orderSequence = dependency === "order" ? 4 : 3;
      const earlierFillSequence = dependency === "order" ? 2 : 4;
      const openingSequence = dependency === "order" ? 2 : 5;

      await expect(db.transaction(async (transaction) => {
        const events = [
          { sequence: earlierFillSequence, id: earlierFillEventId, type: "paper.fill.created", payload: {
            fillId: earlierFillId, orderId, positionId, symbol: "AAPL", side: "BUY",
            quantity: "1", price: "100.00", commission: "0.00",
            ...(dependency === "order" ? { openedAt: "2026-08-09T00:00:02.000Z" } : {}),
            filledAt: `2026-08-09T00:00:${String(earlierFillSequence).padStart(2, "0")}.000Z`,
          } },
          { sequence: intentSequence, id: intentEventId, type: "paper.intent.proposed", payload: {
            intentId, direction: "PAPER_LONG", symbol: "AAPL", entryPrice: "100.00",
            stopPrice: "95.00", targetPrice: "110.00", desiredRisk: "25.00",
            expiresAt: "2026-08-09T01:00:00.000Z", initialStatus: "PROPOSED",
            createdAt: `2026-08-09T00:00:${String(intentSequence).padStart(2, "0")}.000Z`,
          } },
          { sequence: orderSequence, id: orderEventId, type: "paper.order.created", payload: {
            orderId, intentId, symbol: "AAPL", side: "BUY", quantity: dependency === "opening" ? "2" : "1",
            initialStatus: "PENDING",
            createdAt: `2026-08-09T00:00:${String(orderSequence).padStart(2, "0")}.000Z`,
          } },
          ...(dependency === "opening" ? [{
            sequence: openingSequence, id: openingEventId, type: "paper.fill.created", payload: {
              fillId: openingFillId, orderId, positionId, symbol: "AAPL", side: "BUY",
              quantity: "1", price: "100.00", commission: "0.00",
              openedAt: "2026-08-09T00:00:05.000Z",
              filledAt: "2026-08-09T00:00:05.000Z",
            },
          }] : []),
        ].sort((left, right) => left.sequence - right.sequence);
        for (const event of events) {
          await insertEvent(transaction as typeof db, event.sequence, event.id, event.type,
            event.payload, `dependency-${dependency}-${event.sequence}`);
        }
        await transaction.query(
          `insert into challenge_intents (
             id, stage_id, profile_version_id, ledger_event_id, symbol, direction,
             entry_price, stop_price, target_price, desired_risk, expires_at,
             initial_status, created_at
           ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','95.00','110.00',
                     '25.00',$5,'PROPOSED',$6)`,
          [intentId, stageId, INITIAL_PROFILE.profileVersionId, intentEventId,
            "2026-08-09T01:00:00.000Z",
            `2026-08-09T00:00:${String(intentSequence).padStart(2, "0")}.000Z`],
        );
        await transaction.query(
          `insert into challenge_orders (
             id, intent_id, stage_id, profile_version_id, ledger_event_id,
             symbol, side, quantity, initial_status, created_at
           ) values ($1,$2,$3,$4,$5,'AAPL','BUY',$6,'PENDING',$7)`,
          [orderId, intentId, stageId, INITIAL_PROFILE.profileVersionId, orderEventId,
            dependency === "opening" ? "2" : "1",
            `2026-08-09T00:00:${String(orderSequence).padStart(2, "0")}.000Z`],
        );
        await transaction.query(
          `insert into challenge_positions (
             id, stage_id, profile_version_id, opening_ledger_event_id,
             symbol, side, opened_at
           ) values ($1,$2,$3,$4,'AAPL','BUY',$5)`,
          [positionId, stageId, INITIAL_PROFILE.profileVersionId, openingEventId,
            `2026-08-09T00:00:${String(openingSequence).padStart(2, "0")}.000Z`],
        );
        const insertFillRow = (fillId: string, eventId: string, sequence: number) =>
          transaction.query(
            `insert into challenge_fills (
               id, order_id, position_id, stage_id, profile_version_id,
               ledger_event_id, side, quantity, price, commission, filled_at
             ) values ($1,$2,$3,$4,$5,$6,'BUY','1','100.00','0.00',$7)`,
            [fillId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
              eventId, `2026-08-09T00:00:${String(sequence).padStart(2, "0")}.000Z`],
          );
        if (dependency === "opening") {
          await insertFillRow(openingFillId, openingEventId, openingSequence);
        }
        await insertFillRow(earlierFillId, earlierFillEventId, earlierFillSequence);
      })).rejects.toThrow("CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID");
    },
    30_000,
  );

  it.each(["mark", "close", "financing", "fee"] as const)(
    "rejects a %s source event that precedes its referenced immutable source",
    async (dependency) => {
      const { db, stageId, insertEvent } = await dependencyStage();
      const intentId = randomUUID();
      const orderId = randomUUID();
      const positionId = randomUUID();
      const intentEventId = randomUUID();
      const orderEventId = randomUUID();
      const openingEventId = randomUUID();
      const fillId = randomUUID();
      const dependentEventId = randomUUID();
      const dependentSourceId = randomUUID();
      const dependentSequence = dependency === "fee" ? 2 : 4;
      const intentSequence = dependency === "fee" ? 3 : 2;
      const orderSequence = dependency === "fee" ? 4 : 3;
      const openingSequence = 5;
      let observationId: string | undefined;
      if (dependency === "mark") {
        await db.query(
          "insert into market_instrument_allowlist(symbol,asset_class,enabled) values ('AAPL','US_STOCK',true)",
        );
        await db.query(
          `insert into market_data_sources(provider,license_id,licensed,redistribution)
           values ('dependency-feed','dependency-v1',true,'ACCOUNT_ONLY')`,
        );
        observationId = randomUUID();
        await db.query(
          `insert into market_observations (
             id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
             raw_source_ref,feed_status,delay_seconds,redistribution,session_state
           ) values ($1,'AAPL','US_STOCK','100.00',$2,$2,'dependency-feed','dependency-v1',
                     'dependency-mark','REALTIME',0,'ACCOUNT_ONLY','OPEN')`,
          [observationId, "2026-08-09T00:00:04.000Z"],
        );
      }

      await expect(db.transaction(async (transaction) => {
        const dependent = dependency === "mark" ? {
          type: "price.mark.recorded",
          payload: {
            markId: dependentSourceId, positionId, marketObservationId: observationId,
            price: "100.00", observedAt: "2026-08-09T00:00:04.000Z",
            recordedAt: "2026-08-09T00:00:04.000Z",
          },
        } : dependency === "close" ? {
          type: "paper.position.closed",
          payload: {
            closureId: dependentSourceId, positionId, quantity: null,
            price: "100.00", commission: "0.00", closedAt: "2026-08-09T00:00:04.000Z",
          },
        } : dependency === "financing" ? {
          type: "financing.recorded",
          payload: {
            financingId: dependentSourceId, positionId, amount: "1.00", utcDays: 1,
            policyVersion: "dependency-v1", recordedAt: "2026-08-09T00:00:04.000Z",
          },
        } : {
          type: "fee.recorded",
          payload: {
            feeId: dependentSourceId, positionId, orderId, amount: "1.00",
            category: "COMMISSION", recordedAt: "2026-08-09T00:00:02.000Z",
          },
        };
        const events = [
          { sequence: dependentSequence, id: dependentEventId, ...dependent },
          { sequence: intentSequence, id: intentEventId, type: "paper.intent.proposed", payload: {
            intentId, direction: "PAPER_LONG", symbol: "AAPL", entryPrice: "100.00",
            stopPrice: "95.00", targetPrice: "110.00", desiredRisk: "25.00",
            expiresAt: "2026-08-09T01:00:00.000Z", initialStatus: "PROPOSED",
            createdAt: `2026-08-09T00:00:${String(intentSequence).padStart(2, "0")}.000Z`,
          } },
          { sequence: orderSequence, id: orderEventId, type: "paper.order.created", payload: {
            orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "1",
            initialStatus: "PENDING",
            createdAt: `2026-08-09T00:00:${String(orderSequence).padStart(2, "0")}.000Z`,
          } },
          { sequence: openingSequence, id: openingEventId, type: "paper.fill.created", payload: {
            fillId, orderId, positionId, symbol: "AAPL", side: "BUY", quantity: "1",
            price: "100.00", commission: "0.00", openedAt: "2026-08-09T00:00:05.000Z",
            filledAt: "2026-08-09T00:00:05.000Z",
          } },
        ].sort((left, right) => left.sequence - right.sequence);
        for (const event of events) {
          await insertEvent(transaction as typeof db, event.sequence, event.id, event.type,
            event.payload, `dependency-${dependency}-${event.sequence}`);
        }
        await transaction.query(
          `insert into challenge_intents (
             id,stage_id,profile_version_id,ledger_event_id,symbol,direction,
             entry_price,stop_price,target_price,desired_risk,expires_at,initial_status,created_at
           ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','95.00','110.00','25.00',
                     $5,'PROPOSED',$6)`,
          [intentId, stageId, INITIAL_PROFILE.profileVersionId, intentEventId,
            "2026-08-09T01:00:00.000Z",
            `2026-08-09T00:00:${String(intentSequence).padStart(2, "0")}.000Z`],
        );
        await transaction.query(
          `insert into challenge_orders (
             id,intent_id,stage_id,profile_version_id,ledger_event_id,
             symbol,side,quantity,initial_status,created_at
           ) values ($1,$2,$3,$4,$5,'AAPL','BUY','1','PENDING',$6)`,
          [orderId, intentId, stageId, INITIAL_PROFILE.profileVersionId, orderEventId,
            `2026-08-09T00:00:${String(orderSequence).padStart(2, "0")}.000Z`],
        );
        await transaction.query(
          `insert into challenge_positions (
             id,stage_id,profile_version_id,opening_ledger_event_id,symbol,side,opened_at
           ) values ($1,$2,$3,$4,'AAPL','BUY',$5)`,
          [positionId, stageId, INITIAL_PROFILE.profileVersionId, openingEventId,
            "2026-08-09T00:00:05.000Z"],
        );
        await transaction.query(
          `insert into challenge_fills (
             id,order_id,position_id,stage_id,profile_version_id,ledger_event_id,
             side,quantity,price,commission,filled_at
           ) values ($1,$2,$3,$4,$5,$6,'BUY','1','100.00','0.00',$7)`,
          [fillId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
            openingEventId, "2026-08-09T00:00:05.000Z"],
        );
        if (dependency === "mark") {
          await transaction.query(
            `insert into challenge_price_marks (
               id,position_id,stage_id,profile_version_id,ledger_event_id,
               market_observation_id,price,observed_at,recorded_at
             ) values ($1,$2,$3,$4,$5,$6,'100.00',$7,$7)`,
            [dependentSourceId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
              dependentEventId, observationId, "2026-08-09T00:00:04.000Z"],
          );
        } else if (dependency === "close") {
          await transaction.query(
            `insert into challenge_position_closures (
               id,position_id,stage_id,profile_version_id,ledger_event_id,
               quantity,price,commission,closed_at
             ) values ($1,$2,$3,$4,$5,null,'100.00','0.00',$6)`,
            [dependentSourceId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
              dependentEventId, "2026-08-09T00:00:04.000Z"],
          );
        } else if (dependency === "financing") {
          await transaction.query(
            `insert into challenge_financing (
               id,stage_id,profile_version_id,ledger_event_id,position_id,
               amount,utc_days,policy_version,recorded_at
             ) values ($1,$2,$3,$4,$5,'1.00',1,'dependency-v1',$6)`,
            [dependentSourceId, stageId, INITIAL_PROFILE.profileVersionId,
              dependentEventId, positionId, "2026-08-09T00:00:04.000Z"],
          );
        } else {
          await transaction.query(
            `insert into challenge_fees (
               id,stage_id,profile_version_id,ledger_event_id,position_id,
               order_id,amount,category,recorded_at
             ) values ($1,$2,$3,$4,$5,$6,'1.00','COMMISSION',$7)`,
            [dependentSourceId, stageId, INITIAL_PROFILE.profileVersionId,
              dependentEventId, positionId, orderId, "2026-08-09T00:00:02.000Z"],
          );
        }
      })).rejects.toThrow("CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID");
    },
    30_000,
  );

  it("rejects a rule evaluation whose intent and high-water events occur later", async () => {
    const { db, stageId, insertEvent } = await dependencyStage();
    const evaluationId = randomUUID();
    const evaluationEventId = randomUUID();
    const intentId = randomUUID();
    const intentEventId = randomUUID();
    await expect(db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, 2, evaluationEventId, "rule.evaluated", {
        evaluationId, intentId, evaluatedLedgerHighWaterId: intentEventId,
        accepted: false, reasons: ["later dependency"],
        evaluatedAt: "2026-08-09T00:00:02.000Z",
      }, "dependency-rule-before-intent");
      await insertEvent(transaction as typeof db, 3, intentEventId, "paper.intent.rejected", {
        intentId, direction: "NO_SIMULATED_POSITION", symbol: null, entryPrice: null,
        stopPrice: null, targetPrice: null, desiredRisk: null, expiresAt: null,
        initialStatus: "REJECTED", createdAt: "2026-08-09T00:00:03.000Z",
      }, "dependency-rule-later-intent");
      await transaction.query(
        `insert into challenge_intents (
           id,stage_id,profile_version_id,ledger_event_id,symbol,direction,
           entry_price,stop_price,target_price,desired_risk,expires_at,initial_status,created_at
         ) values ($1,$2,$3,$4,null,'NO_SIMULATED_POSITION',null,null,null,null,null,'REJECTED',$5)`,
        [intentId, stageId, INITIAL_PROFILE.profileVersionId, intentEventId,
          "2026-08-09T00:00:03.000Z"],
      );
      await transaction.query(
        `insert into challenge_rule_evaluations (
           id,stage_id,profile_version_id,ledger_event_id,intent_id,
           evaluated_ledger_high_water_id,accepted,reasons,evaluated_at
         ) values ($1,$2,$3,$4,$5,$6,false,$7,$8)`,
        [evaluationId, stageId, INITIAL_PROFILE.profileVersionId, evaluationEventId,
          intentId, intentEventId, JSON.stringify(["later dependency"]),
          "2026-08-09T00:00:02.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID");
  }, 30_000);

  it("allows a mark after a partial close and rejects one after explicit flattening", async () => {
    const { db, stageId, positionId, insertEvent } = await activePositionStage();
    await db.query(
      "insert into market_instrument_allowlist(symbol,asset_class,enabled) values ('AAPL','US_STOCK',true)",
    );
    await db.query(
      `insert into market_data_sources(provider,license_id,licensed,redistribution)
       values ('active-feed','active-v1',true,'ACCOUNT_ONLY')`,
    );
    const observationId = randomUUID();
    await db.query(
      `insert into market_observations (
         id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
         raw_source_ref,feed_status,delay_seconds,redistribution,session_state
       ) values ($1,'AAPL','US_STOCK','105.00',$2,$2,'active-feed','active-v1',
                 'active-mark','REALTIME',0,'ACCOUNT_ONLY','OPEN')`,
      [observationId, "2026-08-09T00:00:06.000Z"],
    );
    const partialClosureId = randomUUID();
    const partialEventId = randomUUID();
    await db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, 5, partialEventId, "paper.position.closed", {
        closureId: partialClosureId, positionId, quantity: "0.5", price: "105.00",
        commission: "0.00", closedAt: "2026-08-09T00:00:05.000Z",
      }, "active-partial-close");
      await transaction.query(
        `insert into challenge_position_closures (
           id,position_id,stage_id,profile_version_id,ledger_event_id,
           quantity,price,commission,closed_at
         ) values ($1,$2,$3,$4,$5,'0.5','105.00','0.00',$6)`,
        [partialClosureId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          partialEventId, "2026-08-09T00:00:05.000Z"],
      );
    });
    const validMarkId = randomUUID();
    const validMarkEventId = randomUUID();
    await db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, 6, validMarkEventId, "price.mark.recorded", {
        markId: validMarkId, positionId, marketObservationId: observationId,
        price: "105.00", observedAt: "2026-08-09T00:00:06.000Z",
        recordedAt: "2026-08-09T00:00:06.000Z",
      }, "active-mark-after-partial");
      await transaction.query(
        `insert into challenge_price_marks (
           id,position_id,stage_id,profile_version_id,ledger_event_id,
           market_observation_id,price,observed_at,recorded_at
         ) values ($1,$2,$3,$4,$5,$6,'105.00',$7,$7)`,
        [validMarkId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          validMarkEventId, observationId, "2026-08-09T00:00:06.000Z"],
      );
    });
    const flattenClosureId = randomUUID();
    const flattenEventId = randomUUID();
    await db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, 7, flattenEventId, "paper.position.closed", {
        closureId: flattenClosureId, positionId, quantity: "0.5", price: "105.00",
        commission: "0.00", closedAt: "2026-08-09T00:00:07.000Z",
      }, "active-explicit-flatten");
      await transaction.query(
        `insert into challenge_position_closures (
           id,position_id,stage_id,profile_version_id,ledger_event_id,
           quantity,price,commission,closed_at
         ) values ($1,$2,$3,$4,$5,'0.5','105.00','0.00',$6)`,
        [flattenClosureId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          flattenEventId, "2026-08-09T00:00:07.000Z"],
      );
    });
    await expect(db.transaction(async (transaction) => {
      const markId = randomUUID();
      const eventId = randomUUID();
      await insertEvent(transaction as typeof db, 8, eventId, "price.mark.recorded", {
        markId, positionId, marketObservationId: observationId, price: "105.00",
        observedAt: "2026-08-09T00:00:06.000Z", recordedAt: "2026-08-09T00:00:08.000Z",
      }, "active-mark-after-flat");
      await transaction.query(
        `insert into challenge_price_marks (
           id,position_id,stage_id,profile_version_id,ledger_event_id,
           market_observation_id,price,observed_at,recorded_at
         ) values ($1,$2,$3,$4,$5,$6,'105.00',$7,$8)`,
        [markId, positionId, stageId, INITIAL_PROFILE.profileVersionId, eventId,
          observationId, "2026-08-09T00:00:06.000Z", "2026-08-09T00:00:08.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_POSITION_NOT_ACTIVE");
    expect(replayStoredLedgerEvents(await loadChallengeLedgerEvents({ db }, stageId)))
      .toMatchObject({ openPositions: 0, balance: "2505.00", highWaterId: flattenEventId });
  }, 30_000);

  it("rejects an additive fill after an explicit full close of the immutable position", async () => {
    const { db, stageId, intentId, positionId, insertEvent } = await activePositionStage();
    const closureId = randomUUID();
    const closeEventId = randomUUID();
    await db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, 5, closeEventId, "paper.position.closed", {
        closureId, positionId, quantity: "1", price: "100.00", commission: "0.00",
        closedAt: "2026-08-09T00:00:05.000Z",
      }, "active-full-explicit-close");
      await transaction.query(
        `insert into challenge_position_closures (
           id,position_id,stage_id,profile_version_id,ledger_event_id,
           quantity,price,commission,closed_at
         ) values ($1,$2,$3,$4,$5,'1','100.00','0.00',$6)`,
        [closureId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          closeEventId, "2026-08-09T00:00:05.000Z"],
      );
    });
    await expect(db.transaction(async (transaction) => {
      const orderId = randomUUID();
      const orderEventId = randomUUID();
      await insertEvent(transaction as typeof db, 6, orderEventId, "paper.order.created", {
        orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "1",
        initialStatus: "PENDING", createdAt: "2026-08-09T00:00:06.000Z",
      }, "active-order-after-flat");
      await transaction.query(
        `insert into challenge_orders (
           id,intent_id,stage_id,profile_version_id,ledger_event_id,
           symbol,side,quantity,initial_status,created_at
         ) values ($1,$2,$3,$4,$5,'AAPL','BUY','1','PENDING',$6)`,
        [orderId, intentId, stageId, INITIAL_PROFILE.profileVersionId,
          orderEventId, "2026-08-09T00:00:06.000Z"],
      );
      const fillId = randomUUID();
      const fillEventId = randomUUID();
      await insertEvent(transaction as typeof db, 7, fillEventId, "paper.fill.created", {
        fillId, orderId, positionId, symbol: "AAPL", side: "BUY", quantity: "0.25",
        price: "100.00", commission: "0.00", filledAt: "2026-08-09T00:00:07.000Z",
      }, "active-fill-after-flat");
      await transaction.query(
        `insert into challenge_fills (
           id,order_id,position_id,stage_id,profile_version_id,ledger_event_id,
           side,quantity,price,commission,filled_at
         ) values ($1,$2,$3,$4,$5,$6,'BUY','0.25','100.00','0.00',$7)`,
        [fillId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          fillEventId, "2026-08-09T00:00:07.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_POSITION_NOT_ACTIVE");
  }, 30_000);

  it.each(["mark-after-explicit-flat", "fill-after-null"] as const)(
    "deferred validation rejects later-inserted earlier terminal source: %s",
    async (scenario) => {
      const { db, stageId, orderId, positionId, insertEvent } = await activePositionStage();
      let observationId: string | undefined;
      if (scenario === "mark-after-explicit-flat") {
        await db.query(
          "insert into market_instrument_allowlist(symbol,asset_class,enabled) values ('AAPL','US_STOCK',true)",
        );
        await db.query(
          `insert into market_data_sources(provider,license_id,licensed,redistribution)
           values ('deferred-active-feed','deferred-active-v1',true,'ACCOUNT_ONLY')`,
        );
        observationId = randomUUID();
        await db.query(
          `insert into market_observations (
             id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
             raw_source_ref,feed_status,delay_seconds,redistribution,session_state
           ) values ($1,'AAPL','US_STOCK','100.00',$2,$2,
                     'deferred-active-feed','deferred-active-v1','deferred-active-mark',
                     'REALTIME',0,'ACCOUNT_ONLY','OPEN')`,
          [observationId, "2026-08-09T00:00:06.000Z"],
        );
      }
      await expect(db.transaction(async (transaction) => {
        const closureId = randomUUID();
        const closeEventId = randomUUID();
        await insertEvent(transaction as typeof db, 5, closeEventId, "paper.position.closed", {
          closureId, positionId,
          quantity: scenario === "mark-after-explicit-flat" ? "1" : null,
          price: "100.00", commission: "0.00", closedAt: "2026-08-09T00:00:05.000Z",
        }, `active-deferred-close-${scenario}`);
        const dependentSourceId = randomUUID();
        const dependentEventId = randomUUID();
        if (scenario === "mark-after-explicit-flat") {
          await insertEvent(transaction as typeof db, 6, dependentEventId, "price.mark.recorded", {
            markId: dependentSourceId, positionId, marketObservationId: observationId,
            price: "100.00", observedAt: "2026-08-09T00:00:06.000Z",
            recordedAt: "2026-08-09T00:00:06.000Z",
          }, "active-deferred-mark");
          await transaction.query(
            `insert into challenge_price_marks (
               id,position_id,stage_id,profile_version_id,ledger_event_id,
               market_observation_id,price,observed_at,recorded_at
             ) values ($1,$2,$3,$4,$5,$6,'100.00',$7,$7)`,
            [dependentSourceId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
              dependentEventId, observationId, "2026-08-09T00:00:06.000Z"],
          );
        } else {
          await insertEvent(transaction as typeof db, 6, dependentEventId, "paper.fill.created", {
            fillId: dependentSourceId, orderId, positionId, symbol: "AAPL", side: "BUY",
            quantity: "0.25", price: "100.00", commission: "0.00",
            filledAt: "2026-08-09T00:00:06.000Z",
          }, "active-deferred-fill");
          await transaction.query(
            `insert into challenge_fills (
               id,order_id,position_id,stage_id,profile_version_id,ledger_event_id,
               side,quantity,price,commission,filled_at
             ) values ($1,$2,$3,$4,$5,$6,'BUY','0.25','100.00','0.00',$7)`,
            [dependentSourceId, orderId, positionId, stageId,
              INITIAL_PROFILE.profileVersionId, dependentEventId,
              "2026-08-09T00:00:06.000Z"],
          );
        }
        await transaction.query(
          `insert into challenge_position_closures (
             id,position_id,stage_id,profile_version_id,ledger_event_id,
             quantity,price,commission,closed_at
           ) values ($1,$2,$3,$4,$5,$6,'100.00','0.00',$7)`,
          [closureId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
            closeEventId, scenario === "mark-after-explicit-flat" ? "1" : null,
            "2026-08-09T00:00:05.000Z"],
        );
      })).rejects.toThrow("CHALLENGE_POSITION_NOT_ACTIVE");
    },
    30_000,
  );

  it("commits a valid mark when its earlier opening-fill source row is inserted later", async () => {
    const { db, stageId, insertEvent } = await dependencyStage();
    await db.query(
      "insert into market_instrument_allowlist(symbol,asset_class,enabled) values ('AAPL','US_STOCK',true)",
    );
    await db.query(
      `insert into market_data_sources(provider,license_id,licensed,redistribution)
       values ('ordered-active-feed','ordered-active-v1',true,'ACCOUNT_ONLY')`,
    );
    const observationId = randomUUID();
    await db.query(
      `insert into market_observations (
         id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
         raw_source_ref,feed_status,delay_seconds,redistribution,session_state
       ) values ($1,'AAPL','US_STOCK','101.00',$2,$2,
                 'ordered-active-feed','ordered-active-v1','ordered-active-mark',
                 'REALTIME',0,'ACCOUNT_ONLY','OPEN')`,
      [observationId, "2026-08-09T00:00:05.000Z"],
    );
    const intentId = randomUUID();
    const orderId = randomUUID();
    const positionId = randomUUID();
    const intentEventId = randomUUID();
    const orderEventId = randomUUID();
    const fillEventId = randomUUID();
    const fillId = randomUUID();
    const markEventId = randomUUID();
    const markId = randomUUID();
    await db.transaction(async (transaction) => {
      await insertEvent(transaction as typeof db, 2, intentEventId, "paper.intent.proposed", {
        intentId, direction: "PAPER_LONG", symbol: "AAPL", entryPrice: "100.00",
        stopPrice: "95.00", targetPrice: "110.00", desiredRisk: "25.00",
        expiresAt: "2026-08-09T01:00:00.000Z", initialStatus: "PROPOSED",
        createdAt: "2026-08-09T00:00:02.000Z",
      }, "ordered-active-intent");
      await insertEvent(transaction as typeof db, 3, orderEventId, "paper.order.created", {
        orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "1",
        initialStatus: "PENDING", createdAt: "2026-08-09T00:00:03.000Z",
      }, "ordered-active-order");
      await insertEvent(transaction as typeof db, 4, fillEventId, "paper.fill.created", {
        fillId, orderId, positionId, symbol: "AAPL", side: "BUY", quantity: "1",
        price: "100.00", commission: "0.00", openedAt: "2026-08-09T00:00:04.000Z",
        filledAt: "2026-08-09T00:00:04.000Z",
      }, "ordered-active-fill");
      await insertEvent(transaction as typeof db, 5, markEventId, "price.mark.recorded", {
        markId, positionId, marketObservationId: observationId, price: "101.00",
        observedAt: "2026-08-09T00:00:05.000Z", recordedAt: "2026-08-09T00:00:05.000Z",
      }, "ordered-active-mark");
      await transaction.query(
        `insert into challenge_intents (
           id,stage_id,profile_version_id,ledger_event_id,symbol,direction,
           entry_price,stop_price,target_price,desired_risk,expires_at,initial_status,created_at
         ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','95.00','110.00','25.00',
                   $5,'PROPOSED',$6)`,
        [intentId, stageId, INITIAL_PROFILE.profileVersionId, intentEventId,
          "2026-08-09T01:00:00.000Z", "2026-08-09T00:00:02.000Z"],
      );
      await transaction.query(
        `insert into challenge_orders (
           id,intent_id,stage_id,profile_version_id,ledger_event_id,
           symbol,side,quantity,initial_status,created_at
         ) values ($1,$2,$3,$4,$5,'AAPL','BUY','1','PENDING',$6)`,
        [orderId, intentId, stageId, INITIAL_PROFILE.profileVersionId,
          orderEventId, "2026-08-09T00:00:03.000Z"],
      );
      await transaction.query(
        `insert into challenge_positions (
           id,stage_id,profile_version_id,opening_ledger_event_id,symbol,side,opened_at
         ) values ($1,$2,$3,$4,'AAPL','BUY',$5)`,
        [positionId, stageId, INITIAL_PROFILE.profileVersionId,
          fillEventId, "2026-08-09T00:00:04.000Z"],
      );
      await transaction.query(
        `insert into challenge_price_marks (
           id,position_id,stage_id,profile_version_id,ledger_event_id,
           market_observation_id,price,observed_at,recorded_at
         ) values ($1,$2,$3,$4,$5,$6,'101.00',$7,$7)`,
        [markId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          markEventId, observationId, "2026-08-09T00:00:05.000Z"],
      );
      await transaction.query(
        `insert into challenge_fills (
           id,order_id,position_id,stage_id,profile_version_id,ledger_event_id,
           side,quantity,price,commission,filled_at
         ) values ($1,$2,$3,$4,$5,$6,'BUY','1','100.00','0.00',$7)`,
        [fillId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          fillEventId, "2026-08-09T00:00:04.000Z"],
      );
    });
    expect(replayStoredLedgerEvents(await loadChallengeLedgerEvents({ db }, stageId)))
      .toMatchObject({ openPositions: 1, unrealizedPnl: "1.00", highWaterId: markEventId });
  }, 30_000);

  it("serializes a concurrent terminal close before an additive fill", async () => {
    const { db, stageId, orderId, positionId } = await activePositionStage();
    let reportCloseLock!: () => void;
    let releaseClose!: () => void;
    let reportFillAttempt!: () => void;
    const closeLocked = new Promise<void>((resolve) => { reportCloseLock = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const fillAttempted = new Promise<void>((resolve) => { reportFillAttempt = resolve; });
    const appendNext = async (
      transaction: typeof db,
      id: string,
      type: string,
      payload: object,
      key: string,
    ) => {
      const [{ sequence }] = await transaction.query<{ sequence: string }>(
        "select (coalesce(max(sequence),0)+1)::text as sequence from challenge_ledger_events where stage_id=$1",
        [stageId],
      );
      await transaction.query(
        `insert into challenge_ledger_events (
           id,challenge_portfolio_id,stage_id,profile_version_id,sequence,
           type,payload,occurred_at,actor_type,actor_id,idempotency_key
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,'SYSTEM','active-concurrency',$9)`,
        [id, INITIAL_PROFILE.challengePortfolioId, stageId,
          INITIAL_PROFILE.profileVersionId, sequence, type, payload,
          `2026-08-09T00:00:0${sequence}.000Z`, key],
      );
    };
    const closePromise = db.transaction(async (transaction) => {
      await transaction.query("select id from challenge_stages where id=$1 for update", [stageId]);
      reportCloseLock();
      await closeGate;
      const closureId = randomUUID();
      const eventId = randomUUID();
      await appendNext(transaction as typeof db, eventId, "paper.position.closed", {
        closureId, positionId, quantity: null, price: "100.00", commission: "0.00",
        closedAt: "2026-08-09T00:00:05.000Z",
      }, "active-concurrent-close");
      await transaction.query(
        `insert into challenge_position_closures (
           id,position_id,stage_id,profile_version_id,ledger_event_id,
           quantity,price,commission,closed_at
         ) values ($1,$2,$3,$4,$5,null,'100.00','0.00',$6)`,
        [closureId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          eventId, "2026-08-09T00:00:05.000Z"],
      );
    });
    await closeLocked;
    const fillPromise = db.transaction(async (transaction) => {
      reportFillAttempt();
      await transaction.query("select id from challenge_stages where id=$1 for update", [stageId]);
      const fillId = randomUUID();
      const eventId = randomUUID();
      await appendNext(transaction as typeof db, eventId, "paper.fill.created", {
        fillId, orderId, positionId, symbol: "AAPL", side: "BUY", quantity: "0.25",
        price: "100.00", commission: "0.00", filledAt: "2026-08-09T00:00:06.000Z",
      }, "active-concurrent-fill");
      await transaction.query(
        `insert into challenge_fills (
           id,order_id,position_id,stage_id,profile_version_id,ledger_event_id,
           side,quantity,price,commission,filled_at
         ) values ($1,$2,$3,$4,$5,$6,'BUY','0.25','100.00','0.00',$7)`,
        [fillId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          eventId, "2026-08-09T00:00:06.000Z"],
      );
    });
    await fillAttempted;
    releaseClose();
    const [closeResult, fillResult] = await Promise.allSettled([closePromise, fillPromise]);
    expect(closeResult.status).toBe("fulfilled");
    expect(fillResult).toMatchObject({
      status: "rejected",
      reason: { message: expect.stringContaining("CHALLENGE_POSITION_NOT_ACTIVE") },
    });
    expect(replayStoredLedgerEvents(await loadChallengeLedgerEvents({ db }, stageId)))
      .toMatchObject({ openPositions: 0 });
  }, 30_000);

  it("requires an immutable typed close source and replays only a valid existing-position close", async () => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    const append = (
      transaction: typeof db,
      sequence: number,
      id: string,
      type: string,
      payload: object,
      key: string,
    ) => transaction.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'SYSTEM','challenge-engine',$9)`,
      [id, INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, sequence, type, payload,
        `2026-08-09T00:00:0${sequence}.000Z`, key],
    );
    await append(db, 1, randomUUID(), "stage.started", { amount: "2500.00" }, "close-stage");
    const intentId = randomUUID();
    const orderId = randomUUID();
    const positionId = randomUUID();
    const intentEventId = randomUUID();
    const orderEventId = randomUUID();
    const fillEventId = randomUUID();
    const fillId = randomUUID();
    await db.transaction(async (transaction) => {
      await append(transaction as typeof db, 2, intentEventId, "paper.intent.proposed", {
        intentId, direction: "PAPER_LONG", symbol: "AAPL", initialStatus: "PROPOSED",
        entryPrice: "100.00", stopPrice: "95.00", targetPrice: "110.00",
        desiredRisk: "25.00", expiresAt: "2026-08-09T01:00:00.000Z",
        createdAt: "2026-08-09T00:00:02.000Z",
      }, "close-intent");
      await transaction.query(
        `insert into challenge_intents (
           id, stage_id, profile_version_id, ledger_event_id, symbol, direction,
           entry_price, stop_price, target_price, desired_risk, expires_at,
           initial_status, created_at
         ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','95.00','110.00',
                   '25.00',$5,'PROPOSED',$6)`,
        [intentId, stageId, INITIAL_PROFILE.profileVersionId, intentEventId,
          "2026-08-09T01:00:00.000Z", "2026-08-09T00:00:02.000Z"],
      );
      await append(transaction as typeof db, 3, orderEventId, "paper.order.created", {
        orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "1",
        initialStatus: "PENDING", createdAt: "2026-08-09T00:00:03.000Z",
      }, "close-order");
      await transaction.query(
        `insert into challenge_orders (
           id, intent_id, stage_id, profile_version_id, ledger_event_id,
           symbol, side, quantity, initial_status, created_at
         ) values ($1,$2,$3,$4,$5,'AAPL','BUY','1','PENDING',$6)`,
        [orderId, intentId, stageId, INITIAL_PROFILE.profileVersionId,
          orderEventId, "2026-08-09T00:00:03.000Z"],
      );
      await append(transaction as typeof db, 4, fillEventId, "paper.fill.created", {
        fillId, orderId, positionId, symbol: "AAPL", side: "BUY",
        quantity: "1", price: "100.00", commission: "1.00",
        openedAt: "2026-08-09T00:00:04.000Z",
        filledAt: "2026-08-09T00:00:04.000Z",
      }, "close-fill");
      await transaction.query(
        `insert into challenge_positions (
           id, stage_id, profile_version_id, opening_ledger_event_id,
           symbol, side, opened_at
         ) values ($1,$2,$3,$4,'AAPL','BUY',$5)`,
        [positionId, stageId, INITIAL_PROFILE.profileVersionId,
          fillEventId, "2026-08-09T00:00:04.000Z"],
      );
      await transaction.query(
        `insert into challenge_fills (
           id, order_id, position_id, stage_id, profile_version_id,
           ledger_event_id, side, quantity, price, commission, filled_at
         ) values ($1,$2,$3,$4,$5,$6,'BUY','1','100.00','1.00',$7)`,
        [fillId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          fillEventId, "2026-08-09T00:00:04.000Z"],
      );
    });

    await db.query(
      `insert into market_instrument_allowlist(symbol, asset_class, enabled)
       values ('AAPL','US_STOCK',true),('SPY','US_ETF',true)`,
    );
    await db.query(
      `insert into market_data_sources(provider, license_id, licensed, redistribution)
       values ('ledger-test-feed','ledger-test-v1',true,'ACCOUNT_ONLY')`,
    );
    const aaplObservationId = randomUUID();
    const spyObservationId = randomUUID();
    await db.query(
      `insert into market_observations (
         id, symbol, asset_class, price, observed_at, received_at, provider,
         license_id, raw_source_ref, feed_status, delay_seconds,
         redistribution, session_state
       ) values
       ($1,'AAPL','US_STOCK','100.00',$3,$3,'ledger-test-feed','ledger-test-v1',
        'ledger-aapl','REALTIME',0,'ACCOUNT_ONLY','OPEN'),
       ($2,'SPY','US_ETF','100.00',$3,$3,'ledger-test-feed','ledger-test-v1',
        'ledger-spy','REALTIME',0,'ACCOUNT_ONLY','OPEN')`,
      [aaplObservationId, spyObservationId, "2026-08-09T00:00:05.000Z"],
    );

    const wrongMarkId = randomUUID();
    const wrongMarkEventId = randomUUID();
    await expect(db.transaction(async (transaction) => {
      await append(transaction as typeof db, 5, wrongMarkEventId, "price.mark.recorded", {
        markId: wrongMarkId, positionId, marketObservationId: spyObservationId,
        price: "100.00", observedAt: "2026-08-09T00:00:05.000Z",
        recordedAt: "2026-08-09T00:00:05.000Z",
      }, "mark-wrong-symbol");
      await transaction.query(
        `insert into challenge_price_marks (
           id, position_id, stage_id, profile_version_id, ledger_event_id,
           market_observation_id, price, observed_at, recorded_at
         ) values ($1,$2,$3,$4,$5,$6,'100.00',$7,$7)`,
        [wrongMarkId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          wrongMarkEventId, spyObservationId, "2026-08-09T00:00:05.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_MARK_OBSERVATION_INVALID");

    const markId = randomUUID();
    const markEventId = randomUUID();
    await db.transaction(async (transaction) => {
      await append(transaction as typeof db, 5, markEventId, "price.mark.recorded", {
        markId, positionId, marketObservationId: aaplObservationId,
        price: "100.00", observedAt: "2026-08-09T00:00:05.000Z",
        recordedAt: "2026-08-09T00:00:05.000Z",
      }, "mark-valid-observation");
      await transaction.query(
        `insert into challenge_price_marks (
           id, position_id, stage_id, profile_version_id, ledger_event_id,
           market_observation_id, price, observed_at, recorded_at
         ) values ($1,$2,$3,$4,$5,$6,'100.00',$7,$7)`,
        [markId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          markEventId, aaplObservationId, "2026-08-09T00:00:05.000Z"],
      );
    });

    const mismatchTime = "2026-08-09T00:00:07.000Z";
    const sourceTime = "2026-08-09T00:00:06.000Z";
    const timeMismatchCases: readonly {
      readonly name: string;
      readonly run: () => Promise<unknown>;
    }[] = [
      {
        name: "intent-createdAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "paper.intent.proposed", {
            intentId: sourceId, direction: "PAPER_LONG", symbol: "AAPL",
            entryPrice: "100.00", stopPrice: "95.00", targetPrice: "110.00",
            desiredRisk: "25.00", expiresAt: "2026-08-09T01:00:00.000Z",
            initialStatus: "PROPOSED", createdAt: mismatchTime,
          }, "fidelity-intent-time");
          await transaction.query(
            `insert into challenge_intents (
               id, stage_id, profile_version_id, ledger_event_id, symbol, direction,
               entry_price, stop_price, target_price, desired_risk, expires_at,
               initial_status, created_at
             ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','95.00','110.00',
                       '25.00',$5,'PROPOSED',$6)`,
            [sourceId, stageId, INITIAL_PROFILE.profileVersionId, eventId,
              "2026-08-09T01:00:00.000Z", sourceTime],
          );
        }),
      },
      {
        name: "order-createdAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "paper.order.created", {
            orderId: sourceId, intentId, symbol: "AAPL", side: "BUY", quantity: "1",
            initialStatus: "PENDING", createdAt: mismatchTime,
          }, "fidelity-order-time");
          await transaction.query(
            `insert into challenge_orders (
               id, intent_id, stage_id, profile_version_id, ledger_event_id,
               symbol, side, quantity, initial_status, created_at
             ) values ($1,$2,$3,$4,$5,'AAPL','BUY','1','PENDING',$6)`,
            [sourceId, intentId, stageId, INITIAL_PROFILE.profileVersionId, eventId, sourceTime],
          );
        }),
      },
      {
        name: "position-openedAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "paper.fill.created", {
            positionId: sourceId, symbol: "AAPL", side: "BUY", openedAt: mismatchTime,
          }, "fidelity-position-time");
          await transaction.query(
            `insert into challenge_positions (
               id, stage_id, profile_version_id, opening_ledger_event_id,
               symbol, side, opened_at
             ) values ($1,$2,$3,$4,'AAPL','BUY',$5)`,
            [sourceId, stageId, INITIAL_PROFILE.profileVersionId, eventId, sourceTime],
          );
        }),
      },
      {
        name: "fill-filledAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "paper.fill.created", {
            fillId: sourceId, orderId, positionId, symbol: "AAPL", side: "BUY",
            quantity: "0.01", price: "100.00", commission: "0.00", filledAt: mismatchTime,
          }, "fidelity-fill-time");
          await transaction.query(
            `insert into challenge_fills (
               id, order_id, position_id, stage_id, profile_version_id,
               ledger_event_id, side, quantity, price, commission, filled_at
             ) values ($1,$2,$3,$4,$5,$6,'BUY','0.01','100.00','0.00',$7)`,
            [sourceId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
              eventId, sourceTime],
          );
        }),
      },
      {
        name: "closure-closedAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "paper.position.closed", {
            closureId: sourceId, positionId, quantity: "0.01", price: "100.00",
            commission: "0.00", closedAt: mismatchTime,
          }, "fidelity-close-time");
          await transaction.query(
            `insert into challenge_position_closures (
               id, position_id, stage_id, profile_version_id, ledger_event_id,
               quantity, price, commission, closed_at
             ) values ($1,$2,$3,$4,$5,'0.01','100.00','0.00',$6)`,
            [sourceId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
              eventId, sourceTime],
          );
        }),
      },
      {
        name: "mark-recordedAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "price.mark.recorded", {
            markId: sourceId, positionId, marketObservationId: aaplObservationId,
            price: "100.00", observedAt: "2026-08-09T00:00:05.000Z",
            recordedAt: mismatchTime,
          }, "fidelity-mark-time");
          await transaction.query(
            `insert into challenge_price_marks (
               id, position_id, stage_id, profile_version_id, ledger_event_id,
               market_observation_id, price, observed_at, recorded_at
             ) values ($1,$2,$3,$4,$5,$6,'100.00',$7,$8)`,
            [sourceId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
              eventId, aaplObservationId, "2026-08-09T00:00:05.000Z", sourceTime],
          );
        }),
      },
      {
        name: "fee-recordedAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "fee.recorded", {
            feeId: sourceId, positionId, orderId: null, amount: "1.00",
            category: "COMMISSION", recordedAt: mismatchTime,
          }, "fidelity-fee-time");
          await transaction.query(
            `insert into challenge_fees (
               id, stage_id, profile_version_id, ledger_event_id, position_id,
               order_id, amount, category, recorded_at
             ) values ($1,$2,$3,$4,$5,null,'1.00','COMMISSION',$6)`,
            [sourceId, stageId, INITIAL_PROFILE.profileVersionId, eventId,
              positionId, sourceTime],
          );
        }),
      },
      {
        name: "financing-recordedAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "financing.recorded", {
            financingId: sourceId, positionId, amount: "1.00", utcDays: 1,
            policyVersion: "stock-etf-cost-v1", recordedAt: mismatchTime,
          }, "fidelity-financing-time");
          await transaction.query(
            `insert into challenge_financing (
               id, stage_id, profile_version_id, ledger_event_id, position_id,
               amount, utc_days, policy_version, recorded_at
             ) values ($1,$2,$3,$4,$5,'1.00',1,'stock-etf-cost-v1',$6)`,
            [sourceId, stageId, INITIAL_PROFILE.profileVersionId, eventId,
              positionId, sourceTime],
          );
        }),
      },
      {
        name: "rule-evaluatedAt",
        run: () => db.transaction(async (transaction) => {
          const sourceId = randomUUID();
          const eventId = randomUUID();
          await append(transaction as typeof db, 6, eventId, "rule.evaluated", {
            evaluationId: sourceId, intentId, evaluatedLedgerHighWaterId: markEventId,
            accepted: true, reasons: [], evaluatedAt: mismatchTime,
          }, "fidelity-rule-time");
          await transaction.query(
            `insert into challenge_rule_evaluations (
               id, stage_id, profile_version_id, ledger_event_id, intent_id,
               evaluated_ledger_high_water_id, accepted, reasons, evaluated_at
             ) values ($1,$2,$3,$4,$5,$6,true,'[]'::jsonb,$7)`,
            [sourceId, stageId, INITIAL_PROFILE.profileVersionId, eventId,
              intentId, markEventId, sourceTime],
          );
        }),
      },
    ];
    for (const mismatch of timeMismatchCases) {
      await expect(mismatch.run(), mismatch.name)
        .rejects.toThrow("CHALLENGE_SOURCE_PAYLOAD_MISMATCH");
    }

    for (const [name, payloadTime, storedTime] of [
      ["noncanonical", "2026-08-09 00:00:06+00", "2026-08-09T00:00:06.000Z"],
      ["impossible", "2027-02-30T00:00:00Z", "2027-03-02T00:00:00.000Z"],
    ] as const) {
      await expect(db.transaction(async (transaction) => {
        const sourceId = randomUUID();
        const eventId = randomUUID();
        await append(transaction as typeof db, 6, eventId, "fee.recorded", {
          feeId: sourceId, positionId: null, orderId: null, amount: "1.00",
          category: "COMMISSION", recordedAt: payloadTime,
        }, `fidelity-fee-${name}-timestamp`);
        await transaction.query(
          `insert into challenge_fees (
             id, stage_id, profile_version_id, ledger_event_id,
             position_id, order_id, amount, category, recorded_at
           ) values ($1,$2,$3,$4,null,null,'1.00','COMMISSION',$5)`,
          [sourceId, stageId, INITIAL_PROFILE.profileVersionId, eventId, storedTime],
        );
      }), `${name} payload timestamp`).rejects.toThrow("CHALLENGE_SOURCE_PAYLOAD_MISMATCH");
    }

    const numericCases: readonly {
      readonly name: string;
      readonly type: string;
      readonly payload: (sourceId: string, eventId: string) => object;
      readonly insertSource: (transaction: typeof db, sourceId: string, eventId: string) => Promise<unknown>;
    }[] = [
      ...(["quantity", "price", "commission"] as const).map((field) => ({
        name: `fill-${field}`,
        type: "paper.fill.created",
        payload: (sourceId: string) => ({
          fillId: sourceId, orderId, positionId, symbol: "AAPL", side: "BUY",
          quantity: field === "quantity" ? 1 : "1",
          price: field === "price" ? 100 : "100",
          commission: field === "commission" ? 1 : "1",
          filledAt: "2026-08-09T00:00:06.000Z",
        }),
        insertSource: (transaction: typeof db, sourceId: string, eventId: string) => transaction.query(
          `insert into challenge_fills (
             id, order_id, position_id, stage_id, profile_version_id,
             ledger_event_id, side, quantity, price, commission, filled_at
           ) values ($1,$2,$3,$4,$5,$6,'BUY','1','100','1',$7)`,
          [sourceId, orderId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
            eventId, "2026-08-09T00:00:06.000Z"],
        ),
      })),
      ...(["quantity", "price", "commission"] as const).map((field) => ({
        name: `close-${field}`,
        type: "paper.position.closed",
        payload: (sourceId: string) => ({
          closureId: sourceId, positionId,
          quantity: field === "quantity" ? 1 : null,
          price: field === "price" ? 105 : "105",
          commission: field === "commission" ? 1 : "1",
          closedAt: "2026-08-09T00:00:05.000Z",
        }),
        insertSource: (transaction: typeof db, sourceId: string, eventId: string) => transaction.query(
          `insert into challenge_position_closures (
             id, position_id, stage_id, profile_version_id, ledger_event_id,
             quantity, price, commission, closed_at
           ) values ($1,$2,$3,$4,$5,$6,'105','1',$7)`,
          [sourceId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
            eventId, field === "quantity" ? "1" : null,
            "2026-08-09T00:00:05.000Z"],
        ),
      })),
      {
        name: "mark-price",
        type: "price.mark.recorded",
        payload: (sourceId) => ({
          markId: sourceId, positionId, marketObservationId: aaplObservationId,
          price: 105, observedAt: "2026-08-09T00:00:05.000Z",
          recordedAt: "2026-08-09T00:00:06.000Z",
        }),
        insertSource: (transaction, sourceId, eventId) => transaction.query(
          `insert into challenge_price_marks (
             id, position_id, stage_id, profile_version_id, ledger_event_id,
             market_observation_id, price, observed_at, recorded_at
           ) values ($1,$2,$3,$4,$5,$6,'105',$7,$8)`,
          [sourceId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
            eventId, aaplObservationId, "2026-08-09T00:00:05.000Z",
            "2026-08-09T00:00:06.000Z"],
        ),
      },
      {
        name: "fee-amount",
        type: "fee.recorded",
        payload: (sourceId) => ({
          feeId: sourceId, positionId: null, orderId: null,
          amount: 1, category: "COMMISSION", recordedAt: "2026-08-09T00:00:06.000Z",
        }),
        insertSource: (transaction, sourceId, eventId) => transaction.query(
          `insert into challenge_fees (
             id, stage_id, profile_version_id, ledger_event_id,
             position_id, order_id, amount, category, recorded_at
           ) values ($1,$2,$3,$4,null,null,'1','COMMISSION',$5)`,
          [sourceId, stageId, INITIAL_PROFILE.profileVersionId,
            eventId, "2026-08-09T00:00:05.000Z"],
        ),
      },
      {
        name: "financing-amount",
        type: "financing.recorded",
        payload: (sourceId) => ({
          financingId: sourceId, positionId, amount: 1,
          utcDays: 1, policyVersion: "stock-etf-cost-v1",
          recordedAt: "2026-08-09T00:00:06.000Z",
        }),
        insertSource: (transaction, sourceId, eventId) => transaction.query(
          `insert into challenge_financing (
             id, stage_id, profile_version_id, ledger_event_id, position_id,
             amount, utc_days, policy_version, recorded_at
           ) values ($1,$2,$3,$4,$5,'1',1,'stock-etf-cost-v1',$6)`,
          [sourceId, stageId, INITIAL_PROFILE.profileVersionId,
            eventId, positionId, "2026-08-09T00:00:05.000Z"],
        ),
      },
    ];
    for (const numericCase of numericCases) {
      const sourceId = randomUUID();
      const eventId = randomUUID();
      await expect(db.transaction(async (transaction) => {
        await append(
          transaction as typeof db,
          6,
          eventId,
          numericCase.type,
          numericCase.payload(sourceId, eventId),
          `numeric-${numericCase.name}`,
        );
        await numericCase.insertSource(transaction as typeof db, sourceId, eventId);
      })).rejects.toThrow("CHALLENGE_SOURCE_PAYLOAD_MISMATCH");
    }

    await expect(db.transaction(async (transaction) => {
      await append(transaction as typeof db, 6, randomUUID(), "paper.position.closed", {
        positionId, price: "105.00", commission: "1.00",
        closedAt: "2026-08-09T00:00:05.000Z",
      }, "close-orphan");
    })).rejects.toThrow("CHALLENGE_LEDGER_TYPED_SOURCE_MISSING");
    await expect(db.transaction(async (transaction) => {
      await append(transaction as typeof db, 6, randomUUID(), "paper.position.closed", {}, "close-empty");
    })).rejects.toThrow("CHALLENGE_LEDGER_TYPED_SOURCE_MISSING");

    const missingPositionId = randomUUID();
    const missingClosureId = randomUUID();
    const missingEventId = randomUUID();
    await expect(db.transaction(async (transaction) => {
      await append(transaction as typeof db, 6, missingEventId, "paper.position.closed", {
        closureId: missingClosureId, positionId: missingPositionId,
        price: "105.00", commission: "1.00", closedAt: "2026-08-09T00:00:05.000Z",
      }, "close-missing-position");
      await transaction.query(
        `insert into challenge_position_closures (
           id, position_id, stage_id, profile_version_id, ledger_event_id,
           quantity, price, commission, closed_at
         ) values ($1,$2,$3,$4,$5,null,'105.00','1.00',$6)`,
        [missingClosureId, missingPositionId, stageId, INITIAL_PROFILE.profileVersionId,
          missingEventId, "2026-08-09T00:00:05.000Z"],
      );
    })).rejects.toThrow();

    const closureId = randomUUID();
    const closeEventId = randomUUID();
    await db.transaction(async (transaction) => {
      await append(transaction as typeof db, 6, closeEventId, "paper.position.closed", {
        closureId, positionId, quantity: null, price: "105.00", commission: "1.00",
        closedAt: "2026-08-09T00:00:05.000Z",
      }, "close-valid");
      await transaction.query(
        `insert into challenge_position_closures (
           id, position_id, stage_id, profile_version_id, ledger_event_id,
           quantity, price, commission, closed_at
         ) values ($1,$2,$3,$4,$5,null,'105.00','1.00',$6)`,
        [closureId, positionId, stageId, INITIAL_PROFILE.profileVersionId,
          closeEventId, "2026-08-09T00:00:05.000Z"],
      );
    });
    expect(replayStoredLedgerEvents(await loadChallengeLedgerEvents({ db }, stageId)))
      .toMatchObject({
        balance: "2503.00",
        equity: "2503.00",
        realizedPnl: "3.00",
        openPositions: 0,
        highWaterId: closeEventId,
      });
    await expect(db.query(
      "update challenge_position_closures set commission='2.00' where id=$1",
      [closureId],
    )).rejects.toThrow("IMMUTABLE_CHALLENGE_POSITION_CLOSURE");
  }, 30_000);

  it("stores replaceable checkpoints that can be discarded and rebuilt from immutable events", async () => {
    const { db } = await testContext();
    const stageId = randomUUID();
    await db.query(
      `insert into challenge_stages (
         id, challenge_portfolio_id, profile_version_id, stage_profile_id,
         ordinal, created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        "2026-08-09T00:00:00.000Z"],
    );
    const eventId = randomUUID();
    await db.query(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, idempotency_key
       ) values ($1,$2,$3,$4,1,'stage.started',$5,$6,'SYSTEM','test-ledger','checkpoint-stage-start')`,
      [eventId, INITIAL_PROFILE.challengePortfolioId, stageId,
        INITIAL_PROFILE.profileVersionId, { amount: "2500.00" },
        "2026-08-09T00:00:00.000Z"],
    );
    const projection = replayLedger([{ ...stageStarted, id: eventId }]);

    let profileReads = 0;
    const hostileProjection = { ...projection } as Record<string, unknown>;
    Object.defineProperty(hostileProjection, "profileVersionId", {
      enumerable: true,
      get: () => {
        profileReads += 1;
        if (profileReads > 1) throw new Error("HOSTILE_GETTER_REUSED");
        return INITIAL_PROFILE.profileVersionId;
      },
    });
    await replaceProjectionCheckpoint({ db }, {
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: eventId,
      highWaterSequence: "1",
      projection: hostileProjection as unknown as typeof projection,
    });
    expect(profileReads).toBe(1);

    const cyclicProjection = { ...projection, positions: [] as unknown[] };
    cyclicProjection.positions.push(cyclicProjection);
    await expect(replaceProjectionCheckpoint({ db }, {
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: eventId,
      highWaterSequence: "1",
      projection: cyclicProjection as unknown as typeof projection,
    })).rejects.toThrow("CHALLENGE_LEDGER_CHECKPOINT_INVALID");

    await expect(replaceProjectionCheckpoint({ db }, {
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: eventId,
      highWaterSequence: "1",
      projection: { ...projection, balance: "999999.00" },
    })).rejects.toThrow("CHALLENGE_LEDGER_CHECKPOINT_PROJECTION_MISMATCH");

    await replaceProjectionCheckpoint({ db }, {
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: eventId,
      highWaterSequence: "1",
      projection,
    });
    expect(await loadProjectionCheckpoint({ db }, stageId)).toEqual({
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: eventId,
      highWaterSequence: "1",
      projection,
    });

    const feeEventId = randomUUID();
    const feeId = randomUUID();
    await db.transaction(async (transaction) => {
      await transaction.query(
        `insert into challenge_ledger_events (
           id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
           type, payload, occurred_at, actor_type, actor_id, idempotency_key
         ) values ($1,$2,$3,$4,2,'fee.recorded',$5,$6,'SYSTEM','test-ledger',$7)`,
        [feeEventId, INITIAL_PROFILE.challengePortfolioId, stageId,
          INITIAL_PROFILE.profileVersionId, {
            feeId, positionId: null, orderId: null, amount: "1.00",
            category: "COMMISSION", recordedAt: "2026-08-09T00:00:01.000Z",
          }, "2026-08-09T00:00:01.000Z", "checkpoint-fee"],
      );
      await transaction.query(
        `insert into challenge_fees (
           id, stage_id, profile_version_id, ledger_event_id, position_id,
           order_id, amount, category, recorded_at
         ) values ($1,$2,$3,$4,null,null,'1.00','COMMISSION',$5)`,
        [feeId, stageId, INITIAL_PROFILE.profileVersionId, feeEventId,
          "2026-08-09T00:00:01.000Z"],
      );
    });
    const newerProjection = replayStoredLedgerEvents(
      await loadChallengeLedgerEvents({ db }, stageId),
    );
    await Promise.all([
      replaceProjectionCheckpoint({ db }, {
        stageId,
        profileVersionId: INITIAL_PROFILE.profileVersionId,
        highWaterEventId: feeEventId,
        highWaterSequence: "2",
        projection: newerProjection,
      }),
      replaceProjectionCheckpoint({ db }, {
        stageId,
        profileVersionId: INITIAL_PROFILE.profileVersionId,
        highWaterEventId: eventId,
        highWaterSequence: "1",
        projection,
      }),
    ]);
    await replaceProjectionCheckpoint({ db }, {
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: eventId,
      highWaterSequence: "1",
      projection,
    });
    expect(await loadProjectionCheckpoint({ db }, stageId)).toMatchObject({
      highWaterEventId: feeEventId,
      highWaterSequence: "2",
      projection: newerProjection,
    });

    await db.query("delete from challenge_projection_checkpoints where stage_id=$1", [stageId]);
    expect(await db.query("select count(*)::int as count from challenge_ledger_events where stage_id=$1", [stageId]))
      .toEqual([{ count: 2 }]);
    expect(await loadProjectionCheckpoint({ db }, stageId)).toBeNull();
    await expect(replaceProjectionCheckpoint({ db }, {
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: eventId,
      highWaterSequence: "1",
      projection: replayLedger([stageStarted]),
    })).rejects.toThrow("CHALLENGE_LEDGER_CHECKPOINT_HIGH_WATER_MISMATCH");
  }, 30_000);
});
