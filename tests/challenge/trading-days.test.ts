import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createStageLifecycleContext,
  evaluateStage,
  evaluateStoredStage,
  nextStartingBalance,
  qualifiesTradingDay,
} from "../../lib/server/challenge/stages";
import {
  createStageBoundaryWorkerContext,
  processUtcStageBoundary,
} from "../../worker/challenge/process-stage";
import { appendChallengeLedgerEvent } from "../../lib/server/challenge/ledger";
import {
  createMainPaperOrderContext,
  createPaperWorkerContext,
  processPaperOrder,
  submitPaperIntent,
} from "../../lib/server/challenge/orders";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";
import {
  commitMainBaseline,
  openDecisionWindow,
  recordEvaluation,
} from "../../lib/server/orchestration/decision-window";
import { testContext } from "../helpers/postgres";

type TestDb = Awaited<ReturnType<typeof testContext>>["db"];

const PROFILE_ID = INITIAL_PROFILE.profileVersionId;
const PORTFOLIO_ID = INITIAL_PROFILE.challengePortfolioId;

function stageProfileId(ordinal: number): string {
  return ordinal === 10
    ? "00000000-0000-4000-8000-000000001220"
    : `00000000-0000-4000-8000-00000000121${ordinal}`;
}

async function seedStage(
  ordinal = 1,
  options: Readonly<{
    db?: TestDb;
    profileId?: string;
    stageProfileId?: string;
    startingBalance?: string;
  }> = {},
): Promise<Readonly<{ db: TestDb; stageId: string }>> {
  const db = options.db ?? (await testContext()).db;
  const stageId = randomUUID();
  const profileId = options.profileId ?? PROFILE_ID;
  const startingBalance = options.startingBalance
    ?? (ordinal === 10 ? "1000000.00" : "2500.00");
  await db.query(
    `insert into challenge_stages (
       id,challenge_portfolio_id,profile_version_id,stage_profile_id,ordinal,created_at
     ) values ($1,$2,$3,$4,$5,$6)`,
    [stageId, PORTFOLIO_ID, profileId,
      options.stageProfileId ?? stageProfileId(ordinal), ordinal,
      "2026-08-07T00:00:00.000Z"],
  );
  await appendChallengeLedgerEvent({ db }, {
    id: randomUUID(), challengePortfolioId: PORTFOLIO_ID, stageId,
    profileVersionId: profileId, type: "stage.started",
    payload: { amount: startingBalance }, occurredAt: "2026-08-07T00:00:00.000Z",
    actorType: "SYSTEM", actorId: "challenge-stage-lifecycle",
    idempotencyKey: `stage-fixture-start:${stageId}`,
  });
  await db.query(
    `insert into market_instrument_allowlist(symbol,asset_class,enabled,updated_at)
     values ('AAPL','US_STOCK',true,$1) on conflict (symbol) do nothing`,
    ["2026-08-07T00:00:00.000Z"],
  );
  await db.query(
    `insert into market_data_sources(
       provider,license_id,licensed,redistribution,created_at
     ) values ('stage-feed','stage-license',true,'INTERNAL_ONLY',$1)
     on conflict (provider,license_id) do nothing`,
    ["2026-08-07T00:00:00.000Z"],
  );
  return Object.freeze({ db, stageId });
}

async function addCompletedObservation(
  db: TestDb,
  price: string,
  observedAt: string,
): Promise<string> {
  const observationId = randomUUID();
  await db.query(
    `insert into market_observations (
       id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
       raw_source_ref,feed_status,delay_seconds,redistribution,session_state,created_at
     ) values ($1,'AAPL','US_STOCK',$2,$3,$3,'stage-feed','stage-license',$4,
               'REALTIME',0,'INTERNAL_ONLY','OPEN',$3)`,
    [observationId, price, observedAt, `stage:${observationId}`],
  );
  await db.query(
    `insert into market_bars (
       id,source_observation_id,symbol,asset_class,provider,timeframe,
       started_at,ended_at,open_price,high_price,low_price,close_price,completed,created_at
     ) values ($1,$2,'AAPL','US_STOCK','stage-feed','15m',$3,$4,$5,$5,$5,$5,true,$4)`,
    [randomUUID(), observationId,
      new Date(Date.parse(observedAt) - 15 * 60_000).toISOString(), observedAt, price],
  );
  return observationId;
}

async function runQualifyingTrade(
  db: TestDb,
  stageId: string,
  day: string,
  desiredRisk: string,
  closePosition = true,
): Promise<string> {
  const storedStage = await db.one<{ profile_version_id: string }>(
    "select profile_version_id::text from challenge_stages where id=$1",
    [stageId],
  );
  const observedAt = `${day}T15:00:00.000Z`;
  const observationId = await addCompletedObservation(db, "100.00", observedAt);
  const highWater = await db.one<{ id: string }>(
    `select id::text from challenge_ledger_events
      where stage_id=$1 order by sequence desc limit 1`,
    [stageId],
  );
  const evidence = [{ kind: "MARKET_EVENT" as const, referenceId: observationId }];
  const window = await openDecisionWindow({ db }, {
    marketObservationIds: [observationId], evidence,
    portfolioSnapshot: { equity: "2500.00", highWaterId: highWater.id },
    costModelSnapshot: { policyVersion: INITIAL_PROFILE.costPolicyVersion },
    stageProfileVersion: storedStage.profile_version_id, eligibleInstruments: ["AAPL"],
    idempotencyKey: `stage-window:${stageId}:${day}`,
  });
  const expiresAt = `${day}T20:00:00.000Z`;
  const main = await commitMainBaseline({ db }, {
    windowId: window.id, disposition: "THESIS",
    thesis: JSON.stringify({
      direction: "LONG", entry: "100.00", expiresAt, desiredRisk,
      stop: "95.00", symbol: "AAPL", target: "400.00",
    }),
    evidence, counterevidence: [], uncertainty: "The paper stop invalidates the thesis.",
    idempotencyKey: `stage-main:${stageId}:${day}`,
  });
  const evaluatorRunId = randomUUID();
  await db.query(
    `insert into model_runs (
       id,role,provider,model,prompt_version,policy_version,correlation_id,causation_id,
       input_tokens,output_tokens,max_input_tokens,max_output_tokens,completion_status,completed_at
     ) values ($1,'EVALUATOR','fake','stage-evaluator','stage-prompt','stage-policy',
               $2,$3,1,1,128,128,'COMPLETED',$4)`,
    [evaluatorRunId, randomUUID(), main.eventId, `${day}T15:00:30.000Z`],
  );
  await recordEvaluation({ db }, {
    windowId: window.id, evaluatorRunId,
    scores: [{
      candidateId: "main",
      components: {
        evidenceFreshness: 25, structuralClarity: 20, costAdjustedGeometry: 20,
        falsifiability: 15, uncertainty: 10, independence: 10,
      },
      hardGates: {
        evidenceFresh: true, sessionValid: true, geometryComplete: true,
        nonDuplicate: true, authorized: true,
      },
    }],
    idempotencyKey: `stage-evaluation:${stageId}:${day}`,
  });
  const order = await submitPaperIntent(createMainPaperOrderContext(db), {
    sourceDecisionId: window.id, symbol: "AAPL", direction: "LONG",
    entry: "100.00", stop: "95.00",
    exitRule: { type: "TARGET", price: "400.00" }, desiredRisk, expiresAt,
    evaluatedAt: `${day}T15:01:00.000Z`, idempotencyKey: `stage-intent:${stageId}:${day}`,
  });
  expect(order.status).toBe("ORDER_CREATED");
  const worker = createPaperWorkerContext(db, `stage-worker-${day}`);
  await processPaperOrder(worker, order.orderId!, {
    reference: "100.00", observedAt, evaluatedAt: `${day}T15:01:30.000Z`,
  });
  if (closePosition) {
    const targetAt = `${day}T15:05:00.000Z`;
    await addCompletedObservation(db, "400.00", targetAt);
    await processPaperOrder(worker, order.orderId!, {
      reference: "400.00", observedAt: targetAt, evaluatedAt: `${day}T15:05:30.000Z`,
    });
  }
  return order.orderId!;
}

async function appendAdverseMark(
  db: TestDb,
  stageId: string,
  orderId: string,
  observedAt: string,
): Promise<void> {
  const storedStage = await db.one<{ profile_version_id: string }>(
    "select profile_version_id::text from challenge_stages where id=$1",
    [stageId],
  );
  const observationId = await addCompletedObservation(db, "1.00", observedAt);
  const row = await db.one<{ position_id: string }>(
    "select position_id::text from challenge_fills where order_id=$1",
    [orderId],
  );
  const markId = randomUUID();
  await db.transaction(async (transaction) => {
    const event = await appendChallengeLedgerEvent({ db: transaction }, {
      id: randomUUID(), challengePortfolioId: PORTFOLIO_ID, stageId,
      profileVersionId: storedStage.profile_version_id, type: "price.mark.recorded",
      payload: {
        markId, positionId: row.position_id, marketObservationId: observationId,
        price: "1.00", observedAt, recordedAt: observedAt,
        provider: "stage-feed", licenseId: "stage-license",
      },
      occurredAt: observedAt, actorType: "SYSTEM", actorId: "challenge-stage-lifecycle",
      idempotencyKey: `stage-adverse-mark:${orderId}`,
    });
    await transaction.query(
      `insert into challenge_price_marks (
         id,position_id,stage_id,profile_version_id,ledger_event_id,
         market_observation_id,price,observed_at,recorded_at
       ) values ($1,$2,$3,$4,$5,$6,'1.00',$7,$7)`,
      [markId, row.position_id, stageId, storedStage.profile_version_id,
        event.id, observationId, observedAt],
    );
  });
}

async function appendStandaloneFee(
  db: TestDb,
  stageId: string,
  profileVersionId: string,
  amount: string,
  recordedAt: string,
): Promise<void> {
  const feeId = randomUUID();
  await db.transaction(async (transaction) => {
    const event = await appendChallengeLedgerEvent({ db: transaction }, {
      id: randomUUID(), challengePortfolioId: PORTFOLIO_ID, stageId,
      profileVersionId, type: "fee.recorded",
      payload: {
        feeId, positionId: null, orderId: null, amount,
        category: "OTHER_SIMULATED_FEE", recordedAt,
      },
      occurredAt: recordedAt, actorType: "SYSTEM",
      actorId: "challenge-stage-lifecycle",
      idempotencyKey: `stage-standalone-fee:${stageId}:${recordedAt}`,
    });
    await transaction.query(
      `insert into challenge_fees (
         id,stage_id,profile_version_id,ledger_event_id,position_id,order_id,
         amount,category,recorded_at
       ) values ($1,$2,$3,$4,null,null,$5,'OTHER_SIMULATED_FEE',$6)`,
      [feeId, stageId, profileVersionId, event.id, amount, recordedAt],
    );
  });
}

async function waitForAdvisoryWaiter(db: TestDb): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await db.one<{ count: number }>(
      "select count(*)::int as count from pg_locks where locktype='advisory' and not granted",
    );
    if (row.count > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("T17_ADVISORY_WAITER_NOT_OBSERVED");
}

async function customProfileStage(): Promise<Readonly<{ db: TestDb; stageId: string }>> {
  const { db } = await testContext();
  const profileId = randomUUID();
  await db.query(
    `insert into challenge_profile_versions (
       id,challenge_portfolio_id,version,supersedes_profile_version_id,
       base_currency,profit_objective_bps,overall_drawdown_type,overall_loss_limit_bps,
       trailing_overall_drawdown,daily_loss_type,daily_loss_limit_bps,reset_timezone,
       reset_boundary,minimum_trading_days,deadline_days,portfolio_risk_limit_bps,
       position_risk_limit_bps,qualifying_risk_bps,max_gross_leverage_bps,
       maximum_positions,maximum_positions_per_symbol,allowed_asset_classes,
       cost_policy_version,initial_lifecycle_state,effective_at,created_by,change_reason
     ) values ($1,$2,2,$3,'USD',500,'STATIC',100,false,'DAY_START_EQUITY',100,
               'UTC','00:00',1,null,300,100,25,10000,3,1,
               array['US_STOCK','US_ETF']::text[],'stock-etf-cost-v1','ACTIVE',
               $4,'stage-review-fixture','Stored thresholds regression')`,
    [profileId, PORTFOLIO_ID, PROFILE_ID, "2026-08-10T00:00:00.000Z"],
  );
  const balances = [
    250_000, 500_000, 1_000_000, 2_000_000, 4_000_000,
    8_000_000, 16_000_000, 32_000_000, 64_000_000, 100_000_000,
  ];
  let firstStageProfileId = "";
  for (const [index, starting] of balances.entries()) {
    const id = randomUUID();
    if (index === 0) firstStageProfileId = id;
    await db.query(
      `insert into challenge_stage_profiles (
         id,profile_version_id,ordinal,starting_balance_cents,target_equity_cents,
         overall_floor_cents,daily_loss_limit_cents,portfolio_risk_limit_cents,
         position_risk_limit_cents,qualifying_risk_cents,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, profileId, index + 1, starting,
        starting + Math.ceil(starting * 0.05),
        starting - Math.floor(starting * 0.01),
        Math.floor(starting * 0.01), Math.floor(starting * 0.03),
        Math.floor(starting * 0.01), Math.ceil(starting * 0.0025),
        "2026-08-10T00:00:00.000Z"],
    );
  }
  await db.query(
    `insert into challenge_profile_publications (
       profile_version_id,published_at,published_by,publication_reason
     ) values ($1,$2,'stage-review-fixture','Stored thresholds regression')`,
    [profileId, "2026-08-10T00:01:00.000Z"],
  );
  return seedStage(1, {
    db, profileId, stageProfileId: firstStageProfileId, startingBalance: "2500.00",
  });
}

const blockedIntent = (key: string) => ({
  sourceDecisionId: randomUUID(), symbol: "AAPL", direction: "LONG" as const,
  entry: "100.00", stop: "97.50",
  exitRule: { type: "TARGET" as const, price: "105.00" }, desiredRisk: "25.00",
  expiresAt: "2026-08-20T20:00:00.000Z", evaluatedAt: "2026-08-20T15:00:00.000Z",
  idempotencyKey: key,
});

describe("Challenge stage lifecycle", () => {
  it("requires three distinct qualifying UTC days at target equity", () => {
    expect(evaluateStage({
      startingBalance: "2500.00",
      equity: "2750.00",
      qualifyingDays: ["2026-08-07", "2026-08-07", "2026-08-08"],
    }).status).toBe("ACTIVE");
    expect(evaluateStage({
      startingBalance: "2500.00",
      equity: "2750.00",
      qualifyingDays: ["2026-08-07", "2026-08-08", "2026-08-09"],
    }).status).toBe("PASSED");
  });

  it("counts only new positions carrying at least 0.25 percent initial risk", () => {
    expect(qualifiesTradingDay({
      startingBalance: "2500.00",
      initialStopRisk: "6.24",
    })).toBe(false);
    expect(qualifiesTradingDay({
      startingBalance: "2500.00",
      initialStopRisk: "6.25",
    })).toBe(true);
  });

  it("fails permanently at either hard boundary and caps final advancement", () => {
    expect(evaluateStage({
      startingBalance: "2500.00",
      equity: "2350.00",
      dayStartEquity: "2500.00",
      qualifyingDays: [],
    }).status).toBe("FAILED");
    expect(evaluateStage({
      startingBalance: "2500.00",
      equity: "2400.00",
      dayStartEquity: "2500.00",
      qualifyingDays: [],
    }).status).toBe("FAILED");
    expect(nextStartingBalance("640000.00")).toBe("1000000.00");
    expect(nextStartingBalance("1000000.00")).toBeNull();
  });

  it("rejects pure-input accessors without invoking them", () => {
    let reads = 0;
    const hostile = {
      startingBalance: "2500.00",
      qualifyingDays: ["2026-08-07"],
    } as { startingBalance: string; equity: string; qualifyingDays: string[] };
    Object.defineProperty(hostile, "equity", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "2750.00";
      },
    });
    expect(() => evaluateStage(hostile)).toThrow("CHALLENGE_STAGE_INPUT_INVALID");
    expect(reads).toBe(0);
  });

  it("rejects pure-input proxies without invoking traps", () => {
    let reads = 0;
    const proxy = new Proxy({
      startingBalance: "2500.00",
      initialStopRisk: "6.25",
    }, {
      get: (target, property, receiver) => {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => qualifiesTradingDay(proxy)).toThrow("CHALLENGE_STAGE_INPUT_INVALID");
    expect(reads).toBe(0);
  });

  it("rejects custom-prototype pure inputs", () => {
    const custom = Object.assign(Object.create({ inherited: true }), {
      startingBalance: "2500.00",
      initialStopRisk: "6.25",
    }) as { startingBalance: string; initialStopRisk: string };
    expect(() => qualifiesTradingDay(custom)).toThrow("CHALLENGE_STAGE_INPUT_INVALID");
  });

  it("rejects oversized qualifying-day arrays", () => {
    expect(() => evaluateStage({
      startingBalance: "2500.00",
      equity: "2750.00",
      qualifyingDays: Array.from({ length: 3_661 }, () => "2026-08-07"),
    })).toThrow("CHALLENGE_STAGE_INPUT_INVALID");
  });

  it("rejects sparse qualifying-day arrays", () => {
    const sparse = ["2026-08-07"];
    sparse.length = 2;
    expect(() => evaluateStage({
      startingBalance: "2500.00",
      equity: "2750.00",
      qualifyingDays: sparse,
    })).toThrow("CHALLENGE_STAGE_INPUT_INVALID");
  });

  it("runs stage evaluation inside paper mutations and through the injected UTC worker", async () => {
    const passing = await seedStage();
    await runQualifyingTrade(passing.db, passing.stageId, "2026-08-07", "6.26");
    await runQualifyingTrade(passing.db, passing.stageId, "2026-08-08", "6.26");
    const finalOrderId = await runQualifyingTrade(
      passing.db, passing.stageId, "2026-08-09", "6.26",
    );
    expect(await passing.db.one(
      `select count(*)::int as count from challenge_ledger_events
        where stage_id=$1 and type='stage.passed'`,
      [passing.stageId],
    )).toEqual({ count: 1 });
    await processPaperOrder(
      createPaperWorkerContext(passing.db, "stage-auto-retry"),
      finalOrderId,
      {
        reference: "400.00", observedAt: "2026-08-09T15:05:00.000Z",
        evaluatedAt: "2026-08-09T15:05:30.000Z",
      },
    );
    expect(await passing.db.one(
      `select count(*)::int as count from challenge_ledger_events
        where stage_id=$1 and type in ('stage.passed','stage.failed')`,
      [passing.stageId],
    )).toEqual({ count: 1 });

    const submission = await seedStage();
    const riskyOrderId = await runQualifyingTrade(
      submission.db, submission.stageId, "2026-08-07", "25.00", false,
    );
    await appendAdverseMark(
      submission.db, submission.stageId, riskyOrderId, "2026-08-07T15:05:00.000Z",
    );
    await submitPaperIntent(
      createMainPaperOrderContext(submission.db),
      blockedIntent("auto-failure-after-submit"),
    );
    expect(await submission.db.one(
      `select count(*)::int as count from challenge_ledger_events
        where stage_id=$1 and type='stage.failed'`,
      [submission.stageId],
    )).toEqual({ count: 1 });

    const boundary = await seedStage();
    const boundaryOrderId = await runQualifyingTrade(
      boundary.db, boundary.stageId, "2026-08-07", "25.00", false,
    );
    await appendAdverseMark(
      boundary.db, boundary.stageId, boundaryOrderId, "2026-08-08T00:01:00.000Z",
    );
    await processUtcStageBoundary(
      createStageBoundaryWorkerContext(boundary.db, "stage-auto-boundary"), {
      evaluatedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(await boundary.db.one(
      `select count(*)::int as count from challenge_ledger_events
        where stage_id=$1 and type='stage.failed'`,
      [boundary.stageId],
    )).toEqual({ count: 1 });
  }, 120_000);

  it("revalidates current-stage selection after a concurrent terminal decision", async () => {
    const { db, stageId } = await seedStage();
    const orderId = await runQualifyingTrade(db, stageId, "2026-08-07", "25.00", false);
    await appendAdverseMark(db, stageId, orderId, "2026-08-07T15:05:00.000Z");
    const before = await db.one<{ count: number }>(
      "select count(*)::int as count from challenge_intents where stage_id=$1",
      [stageId],
    );
    let racingSubmission!: ReturnType<typeof submitPaperIntent>;
    await db.transaction(async (transaction) => {
      await transaction.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`challenge-stage:${stageId}`],
      );
      racingSubmission = submitPaperIntent(
        createMainPaperOrderContext(db),
        blockedIntent("concurrent-terminal-selection"),
      );
      await waitForAdvisoryWaiter(db);
      await evaluateStoredStage(createStageLifecycleContext(transaction), {
        stageId, evaluatedAt: "2026-08-08T00:00:00.000Z",
      });
    });
    await expect(racingSubmission).rejects.toThrow("PAPER_INTENT_CURRENT_STAGE_INVALID");
    expect(await db.one(
      "select count(*)::int as count from challenge_intents where stage_id=$1",
      [stageId],
    )).toEqual(before);
  }, 60_000);

  it("evaluates a later published stage from its stored thresholds", async () => {
    const { db, stageId } = await customProfileStage();
    const stage = await db.one<{ profile_version_id: string }>(
      "select profile_version_id::text from challenge_stages where id=$1",
      [stageId],
    );
    await appendStandaloneFee(
      db, stageId, stage.profile_version_id, "25.00", "2026-08-10T15:05:00.000Z",
    );
    const stored = await evaluateStoredStage(createStageLifecycleContext(db), {
      stageId, evaluatedAt: "2026-08-10T15:06:00.000Z",
    });
    expect(stored).toMatchObject({ status: "FAILED", qualifyingDays: 0 });
    expect(await db.one(
      `select payload->>'targetEquity' as target,
              payload->>'overallFloor' as floor,
              payload->>'dailyLossLimit' as daily
         from challenge_ledger_events where stage_id=$1 and type='stage.failed'`,
      [stageId],
    )).toEqual({ target: "2625.00", floor: "2475.00", daily: "25.00" });
  }, 60_000);

  it("binds qualification to the position opening event, never UUID fill ordering", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("lib/server/challenge/stages.ts", "utf8");
    expect(source).toMatch(/opening_ledger_event_id\s*=\s*fill\.ledger_event_id/u);
    expect(source).not.toMatch(/\(earlier\.filled_at,earlier\.id\)/u);
  });

  it("derives qualifying UTC days from opening fills and advances one fresh stage exactly once", async () => {
    const { db, stageId } = await seedStage();
    const context = createStageLifecycleContext(db);
    await runQualifyingTrade(db, stageId, "2026-08-07", "6.26");
    await runQualifyingTrade(db, stageId, "2026-08-08", "6.26");
    const beforeThirdDay = await evaluateStoredStage(context, {
      stageId, evaluatedAt: "2026-08-08T15:06:00.000Z",
    });
    expect(beforeThirdDay).toMatchObject({ status: "ACTIVE", qualifyingDays: 2 });
    await runQualifyingTrade(db, stageId, "2026-08-09", "6.26");

    expect(await db.one(
      `select count(*)::int as count from challenge_ledger_events
        where stage_id=$1 and type='stage.passed'`,
      [stageId],
    )).toEqual({ count: 1 });

    const [first, retry] = await Promise.all([
      evaluateStoredStage(context, {
        stageId, evaluatedAt: "2026-08-09T15:06:00.000Z",
      }),
      evaluateStoredStage(context, {
        stageId, evaluatedAt: "2026-08-09T15:06:00.000Z",
      }),
    ]);
    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      status: "PASSED", stageId, startingBalance: "2500.00",
      qualifyingDays: 3, nextStartingBalance: "5000.00",
    });
    expect(first.nextStageId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await db.one(
      `select
         count(*) filter (where type in ('stage.passed','stage.failed'))::int as terminals,
         count(*) filter (where type='stage.advanced')::int as advances
       from challenge_ledger_events where stage_id=$1`,
      [stageId],
    )).toEqual({ terminals: 1, advances: 1 });
    expect(await db.one(
      `select stage.ordinal,
              array_agg(event.type order by event.sequence) as event_types,
              count(paper_order.id)::int as orders,
              count(fill.id)::int as fills
         from challenge_stages stage
         join challenge_ledger_events event on event.stage_id=stage.id
         left join challenge_orders paper_order on paper_order.stage_id=stage.id
         left join challenge_fills fill on fill.stage_id=stage.id
        where stage.id=$1
        group by stage.ordinal`,
      [first.nextStageId],
    )).toEqual({
      ordinal: 2, event_types: ["stage.created", "stage.started"], orders: 0, fills: 0,
    });
    await expect(db.query(
      "update challenge_ledger_events set payload='{}'::jsonb where stage_id=$1 and type='stage.passed'",
      [stageId],
    )).rejects.toThrow("IMMUTABLE_CHALLENGE_LEDGER_EVENT");
  }, 60_000);

  it("makes failure permanent, rejects forged authority, and blocks later paper orders", async () => {
    const { db, stageId } = await seedStage();
    const context = createStageLifecycleContext(db);
    const orderId = await runQualifyingTrade(
      db, stageId, "2026-08-07", "25.00", false,
    );
    await appendAdverseMark(db, stageId, orderId, "2026-08-07T15:05:00.000Z");
    await processUtcStageBoundary(
      createStageBoundaryWorkerContext(db, "t17-boundary-worker"),
      { evaluatedAt: "2026-08-08T00:00:00.000Z" },
    );
    const failed = await evaluateStoredStage(context, {
      stageId, evaluatedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(failed).toMatchObject({ status: "FAILED", stageId });
    expect(await evaluateStoredStage(context, {
      stageId, evaluatedAt: "2026-08-08T00:00:00.000Z",
    })).toEqual(failed);
    await expect(evaluateStoredStage(
      { db },
      { stageId, evaluatedAt: "2026-08-08T00:00:00.000Z" },
    )).rejects.toThrow("CHALLENGE_STAGE_CONTEXT_INVALID");
    const terminalLedger = await db.one<{ count: number }>(
      "select count(*)::int as count from challenge_ledger_events where stage_id=$1",
      [stageId],
    );
    const terminalObservationAt = "2026-08-08T15:00:00.000Z";
    await addCompletedObservation(db, "1.00", terminalObservationAt);
    await expect(processPaperOrder(
      createPaperWorkerContext(db, "blocked-terminal-stage-worker"),
      orderId,
      {
        reference: "1.00", observedAt: terminalObservationAt,
        evaluatedAt: "2026-08-08T15:00:30.000Z",
      },
    )).rejects.toThrow("PAPER_ORDER_STAGE_TERMINAL");
    expect(await db.one(
      "select count(*)::int as count from challenge_ledger_events where stage_id=$1",
      [stageId],
    )).toEqual(terminalLedger);
    await expect(submitPaperIntent(
      createMainPaperOrderContext(db),
      blockedIntent("blocked-after-failure"),
    )).rejects.toThrow("PAPER_INTENT_CURRENT_STAGE_INVALID");
    expect(await db.one(
      `select count(*)::int as count from challenge_ledger_events
        where stage_id=$1 and type in ('stage.passed','stage.failed')`,
      [stageId],
    )).toEqual({ count: 1 });
  }, 60_000);

  it("completes at the one-million-dollar cap without a successor and blocks orders", async () => {
    const { db, stageId } = await seedStage(10);
    const context = createStageLifecycleContext(db);
    await runQualifyingTrade(db, stageId, "2026-08-07", "2501.00");
    await runQualifyingTrade(db, stageId, "2026-08-08", "2501.00");
    await runQualifyingTrade(db, stageId, "2026-08-09", "2501.00");
    const completed = await evaluateStoredStage(context, {
      stageId, evaluatedAt: "2026-08-09T15:06:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "COMPLETED", startingBalance: "1000000.00",
      nextStageId: null, nextStartingBalance: null, qualifyingDays: 3,
    });
    expect(await db.one(
      `select
         count(*) filter (where type='stage.passed')::int as stage_passed,
         count(*) filter (where type='challenge.passed')::int as challenge_passed,
         count(*) filter (where type='stage.advanced')::int as advanced
       from challenge_ledger_events where stage_id=$1`,
      [stageId],
    )).toEqual({ stage_passed: 1, challenge_passed: 1, advanced: 0 });
    expect(await db.one(
      "select count(*)::int as count from challenge_stages where challenge_portfolio_id=$1",
      [PORTFOLIO_ID],
    )).toEqual({ count: 1 });
    await expect(submitPaperIntent(
      createMainPaperOrderContext(db),
      blockedIntent("blocked-after-completion"),
    )).rejects.toThrow("PAPER_INTENT_CURRENT_STAGE_INVALID");
  }, 60_000);

  it("contains no network, model, broker, credential, export, or subprocess path", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => (
      readFile("lib/server/challenge/stages.ts", "utf8")
    ));
    expect(source).not.toMatch(/\bfetch\s*\(|node:(?:http|https|net)|from\s+["'][^"']*models/iu);
    expect(source).not.toMatch(/broker|exchange|credential|order[-_ ]?export|trade\.cmd|child_process/iu);
  });

  it("binds qualifying days to the authoritative position-opening fill", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => (
      readFile("lib/server/challenge/stages.ts", "utf8")
    ));
    expect(source).toMatch(
      /join\s+challenge_positions\s+position[\s\S]*position\.opening_ledger_event_id\s*=\s*fill\.ledger_event_id/iu,
    );
    expect(source).not.toMatch(/not\s+exists\s*\(\s*select\s+1\s+from\s+challenge_fills\s+earlier/iu);
  });
});
