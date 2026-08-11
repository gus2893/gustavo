import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendEvent } from "../../lib/server/events/store";
import {
  INITIAL_PROFILE,
  basisPointAmount,
  stageLadder,
  stageLadderCents,
  stageValues,
} from "../../lib/server/challenge/profile";
import {
  DECISION_POLICY_VERSION,
  openDecisionWindow,
} from "../../lib/server/orchestration/decision-window";
import { testContext, type TestDatabase } from "../helpers/postgres";

async function insertDirectDecisionWindow(
  db: TestDatabase,
  profileVersionId: string,
  key: string,
  legacyProfileLabel: string | null = null,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const id = randomUUID();
    const digest = "0".repeat(64);
    const event = await appendEvent(transaction, {
      aggregateId: id,
      actor: { type: "SYSTEM", id: "gustavo-decision-orchestrator" },
      type: "decision.window.opened",
      visibility: "OPERATOR",
      body: {},
      idempotencyKey: `direct-event:${key}`,
      policyVersion: DECISION_POLICY_VERSION,
    });
    await transaction.query(
      `insert into decision_windows (
         id, market_observation_ids, evidence_count, portfolio_snapshot_digest,
         cost_model_snapshot_digest, legacy_stage_profile_label,
         stage_profile_version, eligible_instruments,
         snapshot_digest, opened_event_id, policy_version,
         idempotency_key, request_digest, created_at
       ) values ($1,$2::jsonb,1,$3,$3,$4,$5,$6::jsonb,$3,$7,$8,$9,$3,$10)`,
      [id, JSON.stringify([`observation-${key}`]), digest, legacyProfileLabel,
        profileVersionId, JSON.stringify(["AAPL"]), event.id,
        DECISION_POLICY_VERSION, key, event.occurredAt],
    );
  });
}

describe("Challenge profile v1", () => {
  it("derives the approved target, floor, and risk limits", () => {
    expect(stageValues(250_000n)).toEqual({
      targetEquityCents: 275_000n,
      overallFloorCents: 235_000n,
      dailyLossLimitCents: 10_000n,
      portfolioRiskLimitCents: 7_500n,
      positionRiskLimitCents: 2_500n,
      qualifyingRiskCents: 625n,
    });
    expect(INITIAL_PROFILE).toMatchObject({
      version: 1,
      baseCurrency: "USD",
      profitObjectiveBps: 1_000,
      overallDrawdownType: "STATIC",
      overallLossLimitBps: 600,
      dailyLossType: "DAY_START_EQUITY",
      dailyLossLimitBps: 400,
      portfolioRiskLimitBps: 300,
      positionRiskLimitBps: 100,
      qualifyingRiskBps: 25,
      resetTimezone: "UTC",
      resetBoundary: "00:00",
      minimumTradingDays: 3,
      deadline: null,
      maxGrossLeverage: "1.0",
      maxGrossLeverageBps: 10_000,
      maximumPositions: 3,
      maximumPositionsPerSymbol: 1,
      allowedAssetClasses: ["US_STOCK", "US_ETF"],
      costPolicyVersion: "stock-etf-cost-v1",
    });
    expect(Object.isFrozen(INITIAL_PROFILE)).toBe(true);
    expect(Object.isFrozen(INITIAL_PROFILE.allowedAssetClasses)).toBe(true);
  });

  it("rounds explicitly toward lower exposure or a higher required amount", () => {
    expect(basisPointAmount(10_001n, 25, "DOWN")).toBe(25n);
    expect(basisPointAmount(10_001n, 25, "UP")).toBe(26n);
    expect(stageValues(10_001n)).toEqual({
      targetEquityCents: 11_002n,
      overallFloorCents: 9_401n,
      dailyLossLimitCents: 400n,
      portfolioRiskLimitCents: 300n,
      positionRiskLimitCents: 100n,
      qualifyingRiskCents: 26n,
    });
  });

  it("caps the last stage at one million dollars", () => {
    expect(stageLadder()).toEqual([
      2_500, 5_000, 10_000, 20_000, 40_000,
      80_000, 160_000, 320_000, 640_000, 1_000_000,
    ]);
    expect(stageLadderCents()).toEqual([
      250_000n, 500_000n, 1_000_000n, 2_000_000n, 4_000_000n,
      8_000_000n, 16_000_000n, 32_000_000n, 64_000_000n, 100_000_000n,
    ]);
  });

  it("persists the one Main-owned Challenge and its complete v1 stage snapshots", async () => {
    const { db } = await testContext();
    expect(await db.one(
      `select count(*)::int as count,
              min(owner_type) as owner_type
         from challenge_portfolios`,
    )).toEqual({ count: 1, owner_type: "MAIN_BRAIN" });
    expect(await db.one(
      `select count(*)::int as count
         from information_schema.columns
        where table_schema=current_schema()
          and table_name like 'challenge_%'
          and column_name='account_id'`,
    )).toEqual({ count: 0 });
    expect(await db.one(
      `select data_type
         from information_schema.columns
        where table_schema=current_schema()
          and table_name='decision_windows'
          and column_name='stage_profile_version'`,
    )).toEqual({ data_type: "uuid" });
    expect(await db.one(
      `select data_type, is_nullable
         from information_schema.columns
        where table_schema=current_schema()
          and table_name='decision_windows'
          and column_name='legacy_stage_profile_label'`,
    )).toEqual({ data_type: "text", is_nullable: "YES" });
    expect(await db.one(
      `select count(*)::int as count
         from pg_constraint constraint_record
         join pg_class table_record on table_record.oid=constraint_record.conrelid
        where table_record.relname='decision_windows'
          and constraint_record.contype='f'
          and pg_get_constraintdef(constraint_record.oid)
              like '%(stage_profile_version) REFERENCES challenge_profile_versions(id)%'`,
    )).toEqual({ count: 1 });

    expect(await db.one(
      `select version, base_currency, profit_objective_bps,
              overall_drawdown_type, overall_loss_limit_bps,
              daily_loss_type, daily_loss_limit_bps,
              portfolio_risk_limit_bps, position_risk_limit_bps,
              qualifying_risk_bps, reset_timezone, reset_boundary,
              minimum_trading_days, deadline_days,
              max_gross_leverage_bps, maximum_positions,
              maximum_positions_per_symbol, allowed_asset_classes,
              cost_policy_version
         from challenge_profile_versions`,
    )).toEqual({
      version: 1,
      base_currency: "USD",
      profit_objective_bps: 1_000,
      overall_drawdown_type: "STATIC",
      overall_loss_limit_bps: 600,
      daily_loss_type: "DAY_START_EQUITY",
      daily_loss_limit_bps: 400,
      portfolio_risk_limit_bps: 300,
      position_risk_limit_bps: 100,
      qualifying_risk_bps: 25,
      reset_timezone: "UTC",
      reset_boundary: "00:00",
      minimum_trading_days: 3,
      deadline_days: null,
      max_gross_leverage_bps: 10_000,
      maximum_positions: 3,
      maximum_positions_per_symbol: 1,
      allowed_asset_classes: ["US_STOCK", "US_ETF"],
      cost_policy_version: "stock-etf-cost-v1",
    });

    expect(await db.query<{
      readonly ordinal: number;
      readonly starting_balance_cents: string;
      readonly target_equity_cents: string;
    }>(
      `select ordinal, starting_balance_cents::text, target_equity_cents::text
         from challenge_stage_profiles order by ordinal`,
    )).toEqual(stageLadderCents().map((startingBalanceCents, index) => ({
      ordinal: index + 1,
      starting_balance_cents: startingBalanceCents.toString(),
      target_equity_cents: stageValues(startingBalanceCents).targetEquityCents.toString(),
    })));
    expect(await db.one(
      `select count(*)::int as count
         from challenge_profile_publications where profile_version_id=$1`,
      [INITIAL_PROFILE.profileVersionId],
    )).toEqual({ count: 1 });
  }, 30_000);

  it("rejects a null or stale predecessor after the initial profile version", async () => {
    const { db } = await testContext();
    const initial = await db.one<{
      readonly id: string;
      readonly challenge_portfolio_id: string;
      readonly version: number;
      readonly supersedes_profile_version_id: string | null;
    }>(
      `select id, challenge_portfolio_id, version, supersedes_profile_version_id
         from challenge_profile_versions where version=1`,
    );
    expect(initial).toMatchObject({
      version: 1,
      supersedes_profile_version_id: null,
    });

    const insertVersion = (
      id: string,
      version: number,
      supersedesProfileVersionId: string | null,
      effectiveOffset: string,
    ) => db.query(
      `insert into challenge_profile_versions (
         id, challenge_portfolio_id, version, supersedes_profile_version_id,
         base_currency, profit_objective_bps, overall_drawdown_type,
         overall_loss_limit_bps, trailing_overall_drawdown,
         daily_loss_type, daily_loss_limit_bps, reset_timezone, reset_boundary,
         minimum_trading_days, deadline_days, portfolio_risk_limit_bps,
         position_risk_limit_bps, qualifying_risk_bps, max_gross_leverage_bps,
         maximum_positions, maximum_positions_per_symbol, allowed_asset_classes,
         cost_policy_version, initial_lifecycle_state, effective_at, created_by, change_reason
       )
       select $1, challenge_portfolio_id, $2, $3::uuid,
              base_currency, profit_objective_bps, overall_drawdown_type,
              overall_loss_limit_bps, trailing_overall_drawdown,
              daily_loss_type, daily_loss_limit_bps, reset_timezone, reset_boundary,
              minimum_trading_days, deadline_days, portfolio_risk_limit_bps,
              position_risk_limit_bps, qualifying_risk_bps, max_gross_leverage_bps,
              maximum_positions, maximum_positions_per_symbol, allowed_asset_classes,
              cost_policy_version, initial_lifecycle_state,
              effective_at + $4::interval, 'test-operator', 'version-chain regression'
         from challenge_profile_versions where id=$5`,
      [id, version, supersedesProfileVersionId, effectiveOffset, initial.id],
    );

    await expect(insertVersion(randomUUID(), 2, null, "1 day"))
      .rejects.toThrow("CHALLENGE_PROFILE_VERSION_SEQUENCE_INVALID");

    const secondId = randomUUID();
    await expect(insertVersion(secondId, 2, initial.id, "1 day")).resolves.toEqual([]);
    await expect(insertVersion(randomUUID(), 3, initial.id, "2 days"))
      .rejects.toThrow("CHALLENGE_PROFILE_VERSION_SEQUENCE_INVALID");
  }, 30_000);

  it("appends rule versions while historical stage profiles retain their version id", async () => {
    const { db } = await testContext();
    const initial = await db.one<{
      readonly id: string;
      readonly challenge_portfolio_id: string;
    }>("select id, challenge_portfolio_id from challenge_profile_versions where version=1");
    const initialStage = await db.one<{ readonly id: string; readonly profile_version_id: string }>(
      "select id, profile_version_id from challenge_stage_profiles where ordinal=1",
    );
    const window = await openDecisionWindow(
      { db },
      {
        marketObservationIds: ["observation-profile-retention"],
        evidence: [{ kind: "SOURCE_EVENT", referenceId: randomUUID() }],
        portfolioSnapshot: { cashCents: "250000", positions: [] },
        costModelSnapshot: { policyVersion: INITIAL_PROFILE.costPolicyVersion },
        stageProfileVersion: INITIAL_PROFILE.profileVersionId,
        eligibleInstruments: ["AAPL"],
        idempotencyKey: "decision-profile-retention",
      },
    );
    const nextId = randomUUID();

    await db.query(
      `insert into challenge_profile_versions (
         id, challenge_portfolio_id, version, supersedes_profile_version_id,
         base_currency, profit_objective_bps, overall_drawdown_type,
         overall_loss_limit_bps, trailing_overall_drawdown,
         daily_loss_type, daily_loss_limit_bps, reset_timezone, reset_boundary,
         minimum_trading_days, deadline_days, portfolio_risk_limit_bps,
         position_risk_limit_bps, qualifying_risk_bps, max_gross_leverage_bps,
         maximum_positions, maximum_positions_per_symbol, allowed_asset_classes,
         cost_policy_version, initial_lifecycle_state, effective_at, created_by, change_reason
       )
       select $1, challenge_portfolio_id, 2, id,
              base_currency, profit_objective_bps, overall_drawdown_type,
              overall_loss_limit_bps, trailing_overall_drawdown,
              daily_loss_type, daily_loss_limit_bps, reset_timezone, reset_boundary,
              minimum_trading_days, deadline_days, portfolio_risk_limit_bps,
              position_risk_limit_bps, qualifying_risk_bps, max_gross_leverage_bps,
              maximum_positions, maximum_positions_per_symbol, allowed_asset_classes,
              cost_policy_version, initial_lifecycle_state,
              effective_at + interval '1 day', 'test-operator', 'approved test version'
         from challenge_profile_versions where id=$2`,
      [nextId, initial.id],
    );

    const draftWindowInput = {
      marketObservationIds: ["observation-profile-v2-draft"],
      evidence: [{ kind: "SOURCE_EVENT" as const, referenceId: randomUUID() }],
      portfolioSnapshot: { cashCents: "250000", positions: [] },
      costModelSnapshot: { policyVersion: INITIAL_PROFILE.costPolicyVersion },
      stageProfileVersion: nextId,
      eligibleInstruments: ["AAPL"],
      idempotencyKey: "decision-profile-v2-draft",
    };
    await expect(openDecisionWindow({ db }, draftWindowInput))
      .rejects.toThrow("DECISION_PROFILE_VERSION_NOT_PUBLISHED");
    await expect(insertDirectDecisionWindow(db, nextId, "decision-profile-v2-direct-draft"))
      .rejects.toThrow("DECISION_PROFILE_VERSION_NOT_PUBLISHED");
    await expect(insertDirectDecisionWindow(
      db,
      INITIAL_PROFILE.profileVersionId,
      "decision-profile-new-legacy-direct",
      "profile-production-blue",
    )).rejects.toThrow("DECISION_LEGACY_PROFILE_FORBIDDEN");
    await expect(db.query(
      `insert into challenge_profile_publications (
         profile_version_id, published_at, published_by, publication_reason
       ) values ($1,clock_timestamp(),'test-operator','premature publication')`,
      [nextId],
    )).rejects.toThrow("CHALLENGE_PROFILE_PUBLICATION_INCOMPLETE");

    for (const [index, startingBalanceCents] of stageLadderCents().entries()) {
      const values = stageValues(startingBalanceCents);
      await db.query(
        `insert into challenge_stage_profiles (
           id, profile_version_id, ordinal, starting_balance_cents,
           target_equity_cents, overall_floor_cents, daily_loss_limit_cents,
           portfolio_risk_limit_cents, position_risk_limit_cents,
           qualifying_risk_cents, created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())`,
        [randomUUID(), nextId, index + 1, startingBalanceCents.toString(),
          values.targetEquityCents.toString(), values.overallFloorCents.toString(),
          values.dailyLossLimitCents.toString(), values.portfolioRiskLimitCents.toString(),
          values.positionRiskLimitCents.toString(), values.qualifyingRiskCents.toString()],
      );
    }
    await db.query(
      `insert into challenge_profile_publications (
         profile_version_id, published_at, published_by, publication_reason
       ) values ($1,clock_timestamp(),'test-operator','complete approved profile')`,
      [nextId],
    );
    await expect(openDecisionWindow(
      { db },
      { ...draftWindowInput, idempotencyKey: "decision-profile-v2-published" },
    )).resolves.toMatchObject({ stageProfileVersion: nextId });
    const firstBalance = stageLadderCents()[0]!;
    const firstValues = stageValues(firstBalance);
    await expect(db.query(
      `insert into challenge_stage_profiles (
         id, profile_version_id, ordinal, starting_balance_cents,
         target_equity_cents, overall_floor_cents, daily_loss_limit_cents,
         portfolio_risk_limit_cents, position_risk_limit_cents,
         qualifying_risk_cents, created_at
       ) values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,
      [randomUUID(), nextId, firstBalance.toString(),
        firstValues.targetEquityCents.toString(), firstValues.overallFloorCents.toString(),
        firstValues.dailyLossLimitCents.toString(), firstValues.portfolioRiskLimitCents.toString(),
        firstValues.positionRiskLimitCents.toString(), firstValues.qualifyingRiskCents.toString()],
    )).rejects.toThrow("CHALLENGE_PROFILE_ALREADY_PUBLISHED");

    expect(await db.query(
      "select id, version from challenge_profile_versions order by version",
    )).toEqual([
      { id: initial.id, version: 1 },
      { id: nextId, version: 2 },
    ]);
    expect(await db.one(
      "select id, profile_version_id from challenge_stage_profiles where id=$1",
      [initialStage.id],
    )).toEqual(initialStage);
    expect(await db.one(
      "select stage_profile_version::text as profile_id from decision_windows where id=$1",
      [window.id],
    )).toEqual({ profile_id: INITIAL_PROFILE.profileVersionId });
    await expect(db.query(
      "update challenge_stage_profiles set profile_version_id=$2 where id=$1",
      [initialStage.id, nextId],
    )).rejects.toThrow("IMMUTABLE_CHALLENGE_STAGE_PROFILE");
    await expect(db.query(
      "update challenge_profile_versions set profit_objective_bps=1200 where id=$1",
      [initial.id],
    )).rejects.toThrow("IMMUTABLE_CHALLENGE_PROFILE_VERSION");
  }, 30_000);
});
