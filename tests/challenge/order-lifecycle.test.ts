import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  processPaperOrder,
  submitPaperIntent,
  transitionPaperOrder,
} from "../../lib/server/challenge/orders";
import {
  appendChallengeLedgerEvent,
  loadChallengeLedgerEvents,
  loadProjectionCheckpoint,
} from "../../lib/server/challenge/ledger";
import { replayStoredLedgerEvents } from "../../lib/server/challenge/projection";
import { testChallengeContext } from "../helpers/postgres";

const paperLong = (decisionWindowId: string, idempotencyKey = "intent-1") => ({
  sourceDecisionId: decisionWindowId,
  symbol: "AAPL",
  direction: "LONG" as const,
  entry: "100.00",
  stop: "97.50",
  exitRule: { type: "TARGET" as const, price: "105.00" },
  desiredRisk: "25.00",
  expiresAt: "2026-08-09T20:00:00.000Z",
  evaluatedAt: "2026-08-09T15:01:00.000Z",
  idempotencyKey,
});

async function addObservation(
  ctx: Awaited<ReturnType<typeof testChallengeContext>>,
  price: string,
  observedAt: string,
): Promise<string> {
  const id = randomUUID();
  await ctx.db.query(
    `insert into market_observations (
       id, symbol, asset_class, price, observed_at, received_at,
       provider, license_id, raw_source_ref, feed_status, delay_seconds,
       redistribution, session_state, created_at
     ) values ($1,'AAPL','US_STOCK',$2,$3,$3,'licensed-feed','license-v1',
               $4,'REALTIME',0,'INTERNAL_ONLY','OPEN',$3)`,
    [id, price, observedAt, `fixture:${id}`],
  );
  const endedAt = new Date(observedAt);
  const startedAt = new Date(endedAt.getTime() - 15 * 60 * 1_000).toISOString();
  await ctx.db.query(
    `insert into market_bars (
       id, source_observation_id, symbol, asset_class, provider, timeframe,
       started_at, ended_at, open_price, high_price, low_price, close_price,
       completed, created_at
     ) values ($1,$2,'AAPL','US_STOCK','licensed-feed','15m',$3,$4,
               $5,$5,$5,$5,true,$4)`,
    [randomUUID(), id, startedAt, observedAt, price],
  );
  return id;
}

describe("paper order lifecycle", () => {
  it("creates one costed fill for sequential and concurrent processing of one intent", async () => {
    const ctx = await testChallengeContext();
    const intent = await submitPaperIntent(ctx.mainOrderContext, paperLong(ctx.decisionWindowId));

    expect(intent).toMatchObject({
      status: "ORDER_CREATED",
      accepted: true,
      quantity: "8.51851851",
    });
    const observation = {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:30.000Z",
    };
    const first = await processPaperOrder(ctx.paperWorkerContext, intent.orderId!, observation);
    const retries = await Promise.all([
      processPaperOrder(ctx.paperWorkerContext, intent.orderId!, observation),
      processPaperOrder(ctx.paperWorkerContext, intent.orderId!, observation),
    ]);

    expect(first).toMatchObject({ status: "OPEN", fillPrice: "100.10", commission: "1.00" });
    expect(retries).toEqual([first, first]);
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_fills where order_id=$1",
      [intent.orderId],
    )).toEqual({ count: 1 });
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_positions where id=$1",
      [first.positionId],
    )).toEqual({ count: 1 });
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_fees where order_id=$1",
      [intent.orderId],
    )).toEqual({ count: 1 });
    expect(await ctx.db.one(
      `select evaluation.accepted,
              order_event.causation_id=evaluation.ledger_event_id as caused_by_gate
         from challenge_orders paper_order
         join challenge_ledger_events order_event on order_event.id=paper_order.ledger_event_id
         join challenge_rule_evaluations evaluation
           on evaluation.intent_id=paper_order.intent_id
        where paper_order.id=$1`,
      [intent.orderId],
    )).toEqual({ accepted: true, caused_by_gate: true });
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_price_marks where position_id=$1",
      [first.positionId],
    )).toEqual({ count: 1 });
    expect(await ctx.db.one(
      `select count(*)::int as count
         from challenge_order_job_results result
         join challenge_order_jobs job on job.id=result.job_id
        where job.order_id=$1`,
      [intent.orderId],
    )).toEqual({ count: 1 });

    const events = await loadChallengeLedgerEvents(ctx, ctx.stageId);
    const replayed = replayStoredLedgerEvents(events);
    const checkpoint = await loadProjectionCheckpoint(ctx, ctx.stageId);
    expect(checkpoint?.projection).toEqual(replayed);
  }, 30_000);

  it("resolves sequential and concurrent intent retries exactly and rejects key conflicts", async () => {
    const ctx = await testChallengeContext();
    const input = paperLong(ctx.decisionWindowId, "same-intent");
    const [first, second] = await Promise.all([
      submitPaperIntent(ctx.mainOrderContext, input),
      submitPaperIntent(ctx.mainOrderContext, input),
    ]);

    expect(second).toEqual(first);
    expect(await submitPaperIntent(ctx.mainOrderContext, input)).toEqual(first);
    await expect(submitPaperIntent(ctx.mainOrderContext, { ...input, entry: "99.00" }))
      .rejects.toThrow("PAPER_INTENT_IDEMPOTENCY_CONFLICT");
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_intents",
    )).toEqual({ count: 1 });
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_orders",
    )).toEqual({ count: 1 });
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_rule_evaluations",
    )).toEqual({ count: 1 });
  }, 30_000);

  it("records immutable intent and rule rejection without an order when evidence is no longer licensed", async () => {
    const ctx = await testChallengeContext();
    await ctx.db.query(
      "update market_data_sources set licensed=false where provider='licensed-feed' and license_id='license-v1'",
    );

    const rejected = await submitPaperIntent(ctx.mainOrderContext, paperLong(ctx.decisionWindowId, "unlicensed"));
    expect(rejected).toMatchObject({
      status: "REJECTED",
      accepted: false,
      orderId: null,
      reasons: ["MARKET_SOURCE_UNLICENSED"],
    });
    expect(await ctx.db.one(
      `select
         (select count(*)::int from challenge_intents where initial_status='REJECTED') as intents,
         (select count(*)::int from challenge_rule_evaluations where not accepted) as evaluations,
         (select count(*)::int from challenge_orders) as orders`,
    )).toEqual({ intents: 1, evaluations: 1, orders: 0 });
  }, 30_000);

  it("enforces Main-only provenance, full geometry, and the current one-symbol risk snapshot", async () => {
    const incomplete = await testChallengeContext();
    const incompleteResult = await submitPaperIntent(incomplete.mainOrderContext, {
      ...paperLong(incomplete.decisionWindowId, "bad-geometry"),
      stop: "100.00",
    });
    expect(incompleteResult).toMatchObject({
      status: "REJECTED",
      accepted: false,
      orderId: null,
    });
    expect(incompleteResult.reasons).toContain("GEOMETRY_INCOMPLETE");

    const duplicate = await testChallengeContext();
    await submitPaperIntent(duplicate.mainOrderContext, paperLong(duplicate.decisionWindowId, "first-symbol"));
    const duplicateResult = await submitPaperIntent(
      duplicate.mainOrderContext,
      paperLong(duplicate.decisionWindowId, "second-symbol"),
    );
    expect(duplicateResult.reasons).toContain("SYMBOL_DUPLICATE");
    expect(await duplicate.db.one(
      "select count(*)::int as count from challenge_orders",
    )).toEqual({ count: 1 });

    const overRisk = await testChallengeContext();
    const riskRejected = await submitPaperIntent(overRisk.mainOrderContext, {
      ...paperLong(overRisk.decisionWindowId, "over-risk"),
      desiredRisk: "25.01",
    });
    expect(riskRejected.reasons).toContain("POSITION_RISK_LIMIT");
    expect(await overRisk.db.one(
      "select count(*)::int as count from challenge_orders",
    )).toEqual({ count: 0 });
  }, 30_000);

  it("marks and closes once at a target while retaining exact replay and cost provenance", async () => {
    const ctx = await testChallengeContext();
    const intent = await submitPaperIntent(ctx.mainOrderContext, paperLong(ctx.decisionWindowId, "target-close"));
    const opened = await processPaperOrder(ctx.paperWorkerContext, intent.orderId!, {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:30.000Z",
    });
    await addObservation(ctx, "105.00", "2026-08-09T15:05:00.000Z");
    const closeInput = {
      reference: "105.00",
      observedAt: "2026-08-09T15:05:00.000Z",
      evaluatedAt: "2026-08-09T15:05:30.000Z",
    };
    const [closed, retry] = await Promise.all([
      processPaperOrder(ctx.paperWorkerContext, intent.orderId!, closeInput),
      processPaperOrder(ctx.paperWorkerContext, intent.orderId!, closeInput),
    ]);

    expect(closed).toMatchObject({
      status: "CLOSED",
      positionId: opened.positionId,
      exitReason: "TARGET",
      fillPrice: "104.90",
      commission: "1.00",
    });
    expect(retry).toEqual(closed);
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_position_closures where position_id=$1",
      [opened.positionId],
    )).toEqual({ count: 1 });
    expect(await ctx.db.one(
      "select count(*)::int as count from challenge_fees where position_id=$1",
      [opened.positionId],
    )).toEqual({ count: 2 });
    const events = await loadChallengeLedgerEvents(ctx, ctx.stageId);
    expect((await loadProjectionCheckpoint(ctx, ctx.stageId))?.projection)
      .toEqual(replayStoredLedgerEvents(events));

    const next = await submitPaperIntent(ctx.mainOrderContext, paperLong(ctx.decisionWindowId, "after-close"));
    expect(next).toMatchObject({ accepted: true, status: "ORDER_CREATED" });
  }, 30_000);

  it("closes once at a structural stop and cancels an unfilled order at expiry", async () => {
    const stoppedCtx = await testChallengeContext();
    const stoppedIntent = await submitPaperIntent(
      stoppedCtx.mainOrderContext,
      paperLong(stoppedCtx.decisionWindowId, "stop-close"),
    );
    await processPaperOrder(stoppedCtx.paperWorkerContext, stoppedIntent.orderId!, {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:30.000Z",
    });
    await addObservation(stoppedCtx, "97.00", "2026-08-09T15:05:00.000Z");
    const stopped = await processPaperOrder(stoppedCtx.paperWorkerContext, stoppedIntent.orderId!, {
      reference: "97.00",
      observedAt: "2026-08-09T15:05:00.000Z",
      evaluatedAt: "2026-08-09T15:05:30.000Z",
    });
    expect(stopped).toMatchObject({
      status: "CLOSED",
      exitReason: "STOP",
      fillPrice: "96.90",
      commission: "1.00",
    });

    const expiredCtx = await testChallengeContext();
    const expiredIntent = await submitPaperIntent(
      expiredCtx.mainOrderContext,
      paperLong(expiredCtx.decisionWindowId, "pending-expiry"),
    );
    await addObservation(expiredCtx, "101.00", "2026-08-09T20:00:00.000Z");
    const expiryInput = {
      reference: "101.00",
      observedAt: "2026-08-09T20:00:00.000Z",
      evaluatedAt: "2026-08-09T20:00:00.000Z",
    };
    const expired = await processPaperOrder(expiredCtx.paperWorkerContext, expiredIntent.orderId!, expiryInput);
    expect(expired).toMatchObject({ status: "CANCELLED", positionId: null });
    expect(await processPaperOrder(expiredCtx.paperWorkerContext, expiredIntent.orderId!, expiryInput)).toEqual(expired);
    expect(await expiredCtx.db.one(
      `select count(*)::int as count from challenge_ledger_events
        where type='paper.order.cancelled'`,
    )).toEqual({ count: 1 });
  }, 30_000);

  it("accrues one exact UTC day of short financing idempotently", async () => {
    const ctx = await testChallengeContext({
      selectedThesis: JSON.stringify({
        direction: "SHORT",
        entry: "100.00",
        expiresAt: "2026-08-12T20:00:00.000Z",
        desiredRisk: "25.00",
        stop: "102.50",
        symbol: "AAPL",
        target: "95.00",
      }),
    });
    const shortIntent = await submitPaperIntent(ctx.mainOrderContext, {
      sourceDecisionId: ctx.decisionWindowId,
      symbol: "AAPL",
      direction: "SHORT",
      entry: "100.00",
      stop: "102.50",
      exitRule: { type: "TARGET", price: "95.00" },
      desiredRisk: "25.00",
      expiresAt: "2026-08-12T20:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:00.000Z",
      idempotencyKey: "short-financing",
    });
    await processPaperOrder(ctx.paperWorkerContext, shortIntent.orderId!, {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:30.000Z",
    });
    await addObservation(ctx, "99.00", "2026-08-10T15:00:00.000Z");
    const nextDay = {
      reference: "99.00",
      observedAt: "2026-08-10T15:00:00.000Z",
      evaluatedAt: "2026-08-10T15:00:30.000Z",
    };
    const first = await processPaperOrder(ctx.paperWorkerContext, shortIntent.orderId!, nextDay);
    const retry = await processPaperOrder(ctx.paperWorkerContext, shortIntent.orderId!, nextDay);
    expect(first).toMatchObject({ status: "OPEN" });
    expect(retry).toEqual(first);
    expect(await ctx.db.one(
      `select count(*)::int as count,
              min(amount) as amount,
              sum(utc_days)::int as days
         from challenge_financing`,
    )).toEqual({ count: 1, amount: "0.12", days: 1 });
  }, 30_000);

  it("binds the submitted geometry to a canonical selected thesis and requires completed current evidence", async () => {
    const absent = await testChallengeContext({
      selectedThesis: "AAPL looks constructive, but this is not canonical paper geometry.",
    });
    const absentResult = await submitPaperIntent(
      absent.mainOrderContext,
      paperLong(absent.decisionWindowId, "missing-selected-geometry"),
    );
    expect(absentResult.reasons).toContain("SELECTED_THESIS_GEOMETRY_REQUIRED");

    const mismatch = await testChallengeContext();
    const mismatchResult = await submitPaperIntent(mismatch.mainOrderContext, {
      ...paperLong(mismatch.decisionWindowId, "mismatched-selected-geometry"),
      exitRule: { type: "TARGET" as const, price: "106.00" },
    });
    expect(mismatchResult.reasons).toContain("SELECTED_THESIS_GEOMETRY_MISMATCH");

    const noCompletedBar = await testChallengeContext({ completedEvidence: false });
    const noCompletedResult = await submitPaperIntent(
      noCompletedBar.mainOrderContext,
      paperLong(noCompletedBar.decisionWindowId, "no-completed-evidence"),
    );
    expect(noCompletedResult.reasons).toContain("MARKET_COMPLETED_EVIDENCE_REQUIRED");

    const stale = await testChallengeContext();
    const staleResult = await submitPaperIntent(stale.mainOrderContext, {
      ...paperLong(stale.decisionWindowId, "current-as-of-stale"),
      evaluatedAt: "2026-08-09T15:05:00.001Z",
    });
    expect(staleResult.reasons).toContain("MARKET_OBSERVATION_STALE");
  }, 30_000);

  it("requires an opaque Main capability instead of trusting an omitted caller actor", async () => {
    const ctx = await testChallengeContext();
    await expect(submitPaperIntent(
      { db: ctx.db },
      paperLong(ctx.decisionWindowId, "forged-default-main"),
    )).rejects.toThrow("PAPER_INTENT_CONTEXT_INVALID");
  }, 30_000);

  it("rejects hostile intent descriptors without invoking accessors", async () => {
    const ctx = await testChallengeContext();
    let reads = 0;
    const accessorInput = { ...paperLong(ctx.decisionWindowId, "hostile-accessor") };
    Object.defineProperty(accessorInput, "exitRule", {
      enumerable: true,
      get: () => {
        reads += 1;
        return { type: "TARGET", price: "105.00" };
      },
    });
    await expect(submitPaperIntent(
      ctx.mainOrderContext,
      accessorInput as unknown as ReturnType<typeof paperLong>,
    )).rejects.toThrow("PAPER_INTENT_INPUT_INVALID");
    expect(reads).toBe(0);

    const base = paperLong(ctx.decisionWindowId, "hostile-plain-data");
    for (const hostileExitRule of [
      new Proxy({ type: "TARGET", price: "105.00" }, {}),
      Object.assign(Object.create({ inherited: true }), { type: "TARGET", price: "105.00" }),
      { type: "TARGET", price: "105.00", [Symbol("hidden")]: true },
    ]) {
      await expect(submitPaperIntent(ctx.mainOrderContext, {
        ...base,
        exitRule: hostileExitRule,
      } as unknown as ReturnType<typeof paperLong>)).rejects.toThrow("PAPER_INTENT_INPUT_INVALID");
    }
  }, 30_000);

  it("rejects a direct-SQL accepted risk evaluation without real decision provenance", async () => {
    const ctx = await testChallengeContext();
    const intentId = randomUUID();
    const evaluationId = randomUUID();
    const orderId = randomUUID();
    await expect(ctx.db.transaction(async (transaction) => {
      const intentEvent = await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(),
        challengePortfolioId: ctx.challengePortfolioId,
        stageId: ctx.stageId,
        profileVersionId: ctx.profileVersionId,
        type: "paper.intent.proposed",
        payload: {
          intentId, direction: "PAPER_LONG", symbol: "AAPL",
          entryPrice: "100.00", stopPrice: "97.50", targetPrice: "105.00",
          desiredRisk: "25.00", expiresAt: "2026-08-09T20:00:00.000Z",
          initialStatus: "PROPOSED", createdAt: "2026-08-09T15:01:00.000Z",
          sourceDecisionId: randomUUID(), selectionEventId: null,
          marketObservationId: ctx.observationId, requestDigest: "a".repeat(64),
        },
        occurredAt: "2026-08-09T15:01:00.000Z",
        actorType: "SYSTEM",
        actorId: "challenge-order-gate",
        idempotencyKey: `fabricated-intent:${intentId}`,
      });
      await transaction.query(
        `insert into challenge_intents (
           id,stage_id,profile_version_id,ledger_event_id,symbol,direction,
           entry_price,stop_price,target_price,desired_risk,expires_at,initial_status,created_at
         ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG','100.00','97.50','105.00','25.00',
                   $5,'PROPOSED',$6)`,
        [intentId, ctx.stageId, ctx.profileVersionId, intentEvent.id,
          "2026-08-09T20:00:00.000Z", "2026-08-09T15:01:00.000Z"],
      );
      const evaluationEvent = await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(), challengePortfolioId: ctx.challengePortfolioId,
        stageId: ctx.stageId, profileVersionId: ctx.profileVersionId,
        type: "rule.evaluated",
        payload: {
          evaluationId, intentId, evaluatedLedgerHighWaterId: ctx.stageStartedEventId,
          accepted: true, reasons: [], evaluatedAt: "2026-08-09T15:01:00.000Z",
        },
        occurredAt: "2026-08-09T15:01:00.000Z", actorType: "SYSTEM",
        actorId: "challenge-risk-v1", causationId: intentEvent.id,
        idempotencyKey: `fabricated-risk:${intentId}`,
      });
      await transaction.query(
        `insert into challenge_rule_evaluations (
           id,stage_id,profile_version_id,ledger_event_id,intent_id,
           evaluated_ledger_high_water_id,accepted,reasons,evaluated_at
         ) values ($1,$2,$3,$4,$5,$6,true,'[]'::jsonb,$7)`,
        [evaluationId, ctx.stageId, ctx.profileVersionId, evaluationEvent.id,
          intentId, ctx.stageStartedEventId, "2026-08-09T15:01:00.000Z"],
      );
      const orderEvent = await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(), challengePortfolioId: ctx.challengePortfolioId,
        stageId: ctx.stageId, profileVersionId: ctx.profileVersionId,
        type: "paper.order.created",
        payload: {
          orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "8.51851851",
          initialStatus: "PENDING", createdAt: "2026-08-09T15:01:00.000Z",
          acceptedRiskEvaluationId: evaluationId,
        },
        occurredAt: "2026-08-09T15:01:00.000Z", actorType: "SYSTEM",
        actorId: "paper-simulation-worker", causationId: evaluationEvent.id,
        idempotencyKey: `fabricated-order:${intentId}`,
      });
      await transaction.query(
        `insert into challenge_orders (
           id,intent_id,stage_id,profile_version_id,ledger_event_id,
           symbol,side,quantity,initial_status,created_at
         ) values ($1,$2,$3,$4,$5,'AAPL','BUY','8.51851851','PENDING',$6)`,
        [orderId, intentId, ctx.stageId, ctx.profileVersionId,
          orderEvent.id, "2026-08-09T15:01:00.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_ORDER_DECISION_PROVENANCE_REQUIRED");
  }, 30_000);

  it("rejects valid decision provenance with a forged favorable risk snapshot and quantity", async () => {
    const ctx = await testChallengeContext();
    const provenance = await ctx.db.one<{
      selection_event_id: string; selected_candidate_id: string;
      evaluator_run_id: string; candidate_event_id: string; commitment_digest: string;
      market_observation_ids: readonly string[];
    }>(
      `select selection.selection_event_id::text, selection.selected_candidate_id,
              selection.evaluator_run_id::text, candidate.candidate_event_id::text,
              candidate.commitment_digest, decision_window.market_observation_ids
         from decision_windows decision_window
         join decision_selections selection on selection.window_id=decision_window.id
         join decision_candidates candidate
           on candidate.window_id=decision_window.id
          and candidate.candidate_id=selection.selected_candidate_id
        where decision_window.id=$1`,
      [ctx.decisionWindowId],
    );
    const intentId = randomUUID();
    const evaluationId = randomUUID();
    const orderId = randomUUID();
    const geometry = {
      symbol: "AAPL", direction: "LONG", entry: "100.00", stop: "97.50",
      target: "105.00", desiredRisk: "25.00", expiresAt: "2026-08-09T20:00:00.000Z",
    };
    await expect(ctx.db.transaction(async (transaction) => {
      const intentEvent = await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(), challengePortfolioId: ctx.challengePortfolioId,
        stageId: ctx.stageId, profileVersionId: ctx.profileVersionId,
        type: "paper.intent.proposed", payload: {
          intentId, direction: "PAPER_LONG", symbol: "AAPL", entryPrice: geometry.entry,
          stopPrice: geometry.stop, targetPrice: geometry.target, desiredRisk: geometry.desiredRisk,
          expiresAt: geometry.expiresAt, initialStatus: "PROPOSED",
          createdAt: "2026-08-09T15:01:00.000Z", sourceDecisionId: ctx.decisionWindowId,
          selectionEventId: provenance.selection_event_id,
          marketObservationId: ctx.observationId,
        }, occurredAt: "2026-08-09T15:01:00.000Z", actorType: "SYSTEM",
        actorId: "challenge-order-gate", idempotencyKey: `forged-risk-intent:${intentId}`,
      });
      await transaction.query(
        `insert into challenge_intents (
           id,stage_id,profile_version_id,ledger_event_id,symbol,direction,
           entry_price,stop_price,target_price,desired_risk,expires_at,initial_status,created_at
         ) values ($1,$2,$3,$4,'AAPL','PAPER_LONG',$5,$6,$7,$8,$9,'PROPOSED',$10)`,
        [intentId, ctx.stageId, ctx.profileVersionId, intentEvent.id, geometry.entry,
          geometry.stop, geometry.target, geometry.desiredRisk, geometry.expiresAt,
          "2026-08-09T15:01:00.000Z"],
      );
      const evaluationEvent = await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(), challengePortfolioId: ctx.challengePortfolioId,
        stageId: ctx.stageId, profileVersionId: ctx.profileVersionId,
        type: "rule.evaluated", payload: {
          evaluationId, intentId, evaluatedLedgerHighWaterId: ctx.stageStartedEventId,
          accepted: true, reasons: [], evaluatedAt: "2026-08-09T15:01:00.000Z",
          riskPolicyVersion: "challenge-risk-v1",
          riskSnapshot: {
            actorType: "MAIN_BRAIN", startingBalance: "2500.00",
            currentEquity: "999999.00", dayStartEquity: "999999.00",
            realizedDayLoss: "0", openLoss: "0", existingStopRisk: "0",
            proposedStopRisk: "0.01", existingGrossNotional: "0",
            proposedNotional: "0.01", entryCommission: "0", postEntryEquity: "999999.00",
            pendingOpenCount: 0, symbolAlreadyActive: false,
            profileVersionId: ctx.profileVersionId, ledgerHighWaterId: ctx.stageStartedEventId,
          },
          decisionProvenance: {
            decisionWindowId: ctx.decisionWindowId,
            selectionEventId: provenance.selection_event_id,
            selectedCandidateId: provenance.selected_candidate_id,
            evaluatorRunId: provenance.evaluator_run_id,
            selectedCandidateEventId: provenance.candidate_event_id,
            selectedCandidateCommitmentDigest: provenance.commitment_digest,
            marketObservationId: ctx.observationId,
            marketObservationIds: provenance.market_observation_ids,
            selectedGeometry: geometry,
          },
        }, occurredAt: "2026-08-09T15:01:00.000Z", actorType: "SYSTEM",
        actorId: "challenge-risk-v1", causationId: intentEvent.id,
        correlationId: intentEvent.id, idempotencyKey: `forged-risk-eval:${intentId}`,
      });
      await transaction.query(
        `insert into challenge_rule_evaluations (
           id,stage_id,profile_version_id,ledger_event_id,intent_id,
           evaluated_ledger_high_water_id,accepted,reasons,evaluated_at
         ) values ($1,$2,$3,$4,$5,$6,true,'[]'::jsonb,$7)`,
        [evaluationId, ctx.stageId, ctx.profileVersionId, evaluationEvent.id,
          intentId, ctx.stageStartedEventId, "2026-08-09T15:01:00.000Z"],
      );
      const orderEvent = await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(), challengePortfolioId: ctx.challengePortfolioId,
        stageId: ctx.stageId, profileVersionId: ctx.profileVersionId,
        type: "paper.order.created", payload: {
          orderId, intentId, symbol: "AAPL", side: "BUY", quantity: "999",
          initialStatus: "PENDING", createdAt: "2026-08-09T15:01:00.000Z",
          acceptedRiskEvaluationId: evaluationId,
        }, occurredAt: "2026-08-09T15:01:00.000Z", actorType: "SYSTEM",
        actorId: "paper-simulation-worker", causationId: evaluationEvent.id,
        correlationId: intentEvent.id, idempotencyKey: `forged-risk-order:${intentId}`,
      });
      await transaction.query(
        `insert into challenge_orders (
           id,intent_id,stage_id,profile_version_id,ledger_event_id,
           symbol,side,quantity,initial_status,created_at
         ) values ($1,$2,$3,$4,$5,'AAPL','BUY','999','PENDING',$6)`,
        [orderId, intentId, ctx.stageId, ctx.profileVersionId, orderEvent.id,
          "2026-08-09T15:01:00.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_ORDER_RISK_SNAPSHOT_INVALID");
  }, 30_000);

  it("requires a matching durable result for an initially completed job", async () => {
    const ctx = await testChallengeContext();
    const intent = await submitPaperIntent(
      ctx.mainOrderContext,
      paperLong(ctx.decisionWindowId, "completed-without-result"),
    );
    const digest64 = () => randomUUID().replaceAll("-", "")
      + randomUUID().replaceAll("-", "");
    await expect(ctx.db.transaction(async (transaction) => {
      await transaction.query(
        `insert into challenge_order_jobs (
           id,order_id,market_observation_id,operation_key,request_digest,
           status,lease_owner,leased_until,attempts,created_at,updated_at
         ) values ($1,$2,$3,$4,$5,'COMPLETED','direct-sql-fixture',$6,1,$6,$6)`,
        [randomUUID(), intent.orderId, ctx.observationId, digest64(), digest64(),
          "2026-08-09T15:02:00.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_ORDER_JOB_RESULT_REQUIRED");
  }, 30_000);

  it("returns the exact stored result when an old operation retries after newer ledger activity", async () => {
    const ctx = await testChallengeContext();
    const intent = await submitPaperIntent(ctx.mainOrderContext, paperLong(ctx.decisionWindowId, "late-retry"));
    const openingInput = {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:30.000Z",
    };
    const opened = await processPaperOrder(ctx.paperWorkerContext, intent.orderId!, openingInput);
    await addObservation(ctx, "101.00", "2026-08-09T15:05:00.000Z");
    await processPaperOrder(ctx.paperWorkerContext, intent.orderId!, {
      reference: "101.00",
      observedAt: "2026-08-09T15:05:00.000Z",
      evaluatedAt: "2026-08-09T15:05:30.000Z",
    });
    await expect(processPaperOrder(ctx.paperWorkerContext, intent.orderId!, openingInput)).resolves.toEqual(opened);
  }, 30_000);

  it("returns a completed immutable result after source policy is later revoked", async () => {
    const ctx = await testChallengeContext();
    const intent = await submitPaperIntent(
      ctx.mainOrderContext,
      paperLong(ctx.decisionWindowId, "retry-after-source-revocation"),
    );
    const openingInput = {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:30.000Z",
    };
    const opened = await processPaperOrder(
      ctx.paperWorkerContext,
      intent.orderId!,
      openingInput,
    );
    const lifecycleCounts = () => ctx.db.one(
      `select
         (select count(*)::int from challenge_ledger_events) as events,
         (select count(*)::int from challenge_order_jobs) as jobs,
         (select count(*)::int from challenge_order_job_results) as results,
         (select count(*)::int from challenge_fills) as fills,
         (select count(*)::int from challenge_price_marks) as marks,
         (select count(*)::int from challenge_fees) as fees,
         (select count(*)::int from challenge_financing) as financing,
         (select count(*)::int from challenge_position_closures) as closures`,
    );
    const before = await lifecycleCounts();
    await addObservation(ctx, "101.00", "2026-08-09T15:05:00.000Z");
    await ctx.db.query(
      "update market_data_sources set licensed=false where provider='licensed-feed'",
    );
    await ctx.db.query(
      "update market_instrument_allowlist set enabled=false where symbol='AAPL'",
    );

    await expect(processPaperOrder(
      ctx.paperWorkerContext,
      intent.orderId!,
      openingInput,
    )).resolves.toEqual(opened);
    expect(await lifecycleCounts()).toEqual(before);

    await expect(processPaperOrder(ctx.paperWorkerContext, intent.orderId!, {
      reference: "101.00",
      observedAt: "2026-08-09T15:05:00.000Z",
      evaluatedAt: "2026-08-09T15:05:30.000Z",
    })).rejects.toThrow("PAPER_ORDER_MARKET_NOT_ALLOWED");
    expect(await lifecycleCounts()).toEqual(before);
  }, 30_000);

  it.each(["malformed", "lifecycle-mismatch"] as const)(
    "rejects a direct-SQL %s durable job result",
    async (scenario) => {
      const ctx = await testChallengeContext();
      const intent = await submitPaperIntent(
        ctx.mainOrderContext,
        paperLong(ctx.decisionWindowId, `job-result-${scenario}`),
      );
      const jobId = randomUUID();
      const digest64 = () => randomUUID().replaceAll("-", "")
        + randomUUID().replaceAll("-", "");
      const highWater = await ctx.db.one<{ id: string }>(
        `select id::text from challenge_ledger_events
          where stage_id=$1 order by sequence desc limit 1`,
        [ctx.stageId],
      );
      const result = scenario === "malformed"
        ? { status: "OPEN" }
        : {
            status: "OPEN",
            orderId: intent.orderId,
            positionId: randomUUID(),
            fillPrice: "100.10",
            commission: "1.00",
            exitReason: null,
          };
      await expect(ctx.db.transaction(async (transaction) => {
        await transaction.query(
          `insert into challenge_order_jobs (
             id,order_id,market_observation_id,operation_key,request_digest,
             status,lease_owner,leased_until,attempts,created_at,updated_at
           ) values ($1,$2,$3,$4,$5,'COMPLETED','direct-sql-fixture',$6,1,$6,$6)`,
          [jobId, intent.orderId, ctx.observationId, digest64(), digest64(),
            "2026-08-09T15:02:00.000Z"],
        );
        await transaction.query(
          `insert into challenge_order_job_results (
             job_id,order_id,market_observation_id,result,
             completed_high_water_event_id,completed_at
           ) values ($1,$2,$3,$4,$5,$6)`,
          [jobId, intent.orderId, ctx.observationId, result,
            highWater.id, "2026-08-09T15:02:00.000Z"],
        );
      })).rejects.toThrow("CHALLENGE_ORDER_JOB_RESULT_INVALID");
    },
    30_000,
  );

  it("rejects numeric JSON decimal scalars in an otherwise valid durable result", async () => {
    const ctx = await testChallengeContext();
    const intent = await submitPaperIntent(
      ctx.mainOrderContext,
      paperLong(ctx.decisionWindowId, "numeric-job-result-decimals"),
    );
    const opened = await processPaperOrder(ctx.paperWorkerContext, intent.orderId!, {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:30.000Z",
    });
    const observationId = await addObservation(ctx, "101.00", "2026-08-09T15:05:00.000Z");
    const highWater = await ctx.db.one<{ id: string }>(
      `select id::text from challenge_ledger_events
        where stage_id=$1 order by sequence desc limit 1`,
      [ctx.stageId],
    );
    const digest64 = () => randomUUID().replaceAll("-", "")
      + randomUUID().replaceAll("-", "");
    await expect(ctx.db.transaction(async (transaction) => {
      const jobId = randomUUID();
      await transaction.query(
        `insert into challenge_order_jobs (
           id,order_id,market_observation_id,operation_key,request_digest,
           status,lease_owner,leased_until,attempts,created_at,updated_at
         ) values ($1,$2,$3,$4,$5,'COMPLETED','direct-sql-fixture',$6,1,$6,$6)`,
        [jobId, intent.orderId, observationId, digest64(), digest64(),
          "2026-08-09T15:05:30.000Z"],
      );
      await transaction.query(
        `insert into challenge_order_job_results (
           job_id,order_id,market_observation_id,result,
           completed_high_water_event_id,completed_at
         ) values ($1::uuid,$2::uuid,$3::uuid,
           jsonb_build_object(
             'status','OPEN','orderId',$2::uuid::text,'positionId',$4::uuid::text,
             'fillPrice',100.10::numeric(12,2),'commission',1.00::numeric(12,2),
             'exitReason',null
           ),$5,$6)`,
        [jobId, intent.orderId, observationId, opened.positionId,
          highWater.id, "2026-08-09T15:05:30.000Z"],
      );
    })).rejects.toThrow("CHALLENGE_ORDER_JOB_RESULT_INVALID");
  }, 30_000);

  it("fails closed on stale worker evidence and resolves a gap through the stop in one operation", async () => {
    const staleCtx = await testChallengeContext();
    const staleIntent = await submitPaperIntent(
      staleCtx.mainOrderContext,
      paperLong(staleCtx.decisionWindowId, "stale-worker"),
    );
    await expect(processPaperOrder(staleCtx.paperWorkerContext, staleIntent.orderId!, {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:05:00.001Z",
    })).rejects.toThrow("PAPER_ORDER_MARKET_OBSERVATION_STALE");

    const gapCtx = await testChallengeContext();
    const gapIntent = await submitPaperIntent(gapCtx.mainOrderContext, paperLong(gapCtx.decisionWindowId, "gap-stop"));
    await addObservation(gapCtx, "97.00", "2026-08-09T15:02:00.000Z");
    const gap = await processPaperOrder(gapCtx.paperWorkerContext, gapIntent.orderId!, {
      reference: "97.00",
      observedAt: "2026-08-09T15:02:00.000Z",
      evaluatedAt: "2026-08-09T15:02:30.000Z",
    });
    expect(gap).toMatchObject({ status: "CLOSED", exitReason: "STOP" });
  }, 30_000);

  it("fails closed for stale-selected, closed-session, disabled, and provisional evidence", async () => {
    const stale = await testChallengeContext({ evidenceFresh: false });
    const staleResult = await submitPaperIntent(stale.mainOrderContext, paperLong(stale.decisionWindowId, "stale"));
    expect(staleResult.reasons).toContain("DECISION_NOT_ACTIONABLE");

    const closed = await testChallengeContext({ sessionState: "CLOSED" });
    const closedResult = await submitPaperIntent(closed.mainOrderContext, paperLong(closed.decisionWindowId, "closed"));
    expect(closedResult.reasons).toContain("MARKET_SESSION_CLOSED");

    const disabled = await testChallengeContext();
    await disabled.db.query(
      "update market_instrument_allowlist set enabled=false where symbol='AAPL'",
    );
    const disabledResult = await submitPaperIntent(
      disabled.mainOrderContext,
      paperLong(disabled.decisionWindowId, "disabled"),
    );
    expect(disabledResult.reasons).toContain("MARKET_NOT_ALLOWED");

    const provisional = await testChallengeContext({ completedEvidence: false });
    await provisional.db.query(
      `insert into market_bars (
         id, source_observation_id, symbol, asset_class, provider, timeframe,
         started_at, ended_at, open_price, high_price, low_price, close_price,
         completed, created_at
       ) values ($1,$2,'AAPL','US_STOCK','licensed-feed','15m',$3,$4,
                 '99.00','101.00','98.00','100.00',false,$4)`,
      [randomUUID(), provisional.observationId,
        "2026-08-09T14:45:00.000Z", "2026-08-09T15:00:00.000Z"],
    );
    const provisionalResult = await submitPaperIntent(
      provisional.mainOrderContext,
      paperLong(provisional.decisionWindowId, "provisional"),
    );
    expect(provisionalResult.reasons).toContain("MARKET_EVIDENCE_PROVISIONAL");
  }, 30_000);

  it("keeps transitions pure and contains no network, model, broker, credential, or export path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(transitionPaperOrder({
      status: "OPEN",
      side: "BUY",
      entry: "100.00",
      stop: "97.50",
      target: "105.00",
      expiresAt: "2026-08-09T20:00:00.000Z",
    }, {
      reference: "97.50",
      observedAt: "2026-08-09T15:05:00.000Z",
    })).toEqual({ action: "CLOSE", status: "CLOSED", reason: "STOP" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    const sources = await Promise.all([
      readFile("lib/server/challenge/orders.ts", "utf8"),
      readFile("worker/challenge/process-order.ts", "utf8"),
    ]);
    const source = sources.join("\n");
    expect(source).not.toMatch(/\bfetch\s*\(|node:(?:http|https|net)|from\s+["'][^"']*models/i);
    expect(source).not.toMatch(/broker|exchange|credential|order[-_ ]?export|trade\.cmd/i);
  });
});
