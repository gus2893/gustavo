import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import Decimal from "decimal.js";
import type { EventDatabase } from "../events/types";
import { appendChallengeLedgerEvent } from "./ledger";
import { INITIAL_PROFILE, stageLadderCents, stageValues } from "./profile";
import {
  replayStoredLedgerEvents,
  type StoredReplayLedgerEvent,
} from "./projection";

const StageDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_QUALIFYING_DAYS = 3_660;
const stageLifecycleContexts = new WeakSet<object>();

export type StageEvaluationStatus = "ACTIVE" | "PASSED" | "FAILED";

export interface EvaluateStageInput {
  readonly startingBalance: string;
  readonly equity: string;
  readonly dayStartEquity?: string;
  readonly qualifyingDays: readonly string[];
}

export interface StageEvaluation {
  readonly status: StageEvaluationStatus;
  readonly uniqueQualifyingDays: number;
  readonly targetEquity: string;
  readonly overallFloor: string;
  readonly dailyLossLimit: string;
}

export interface QualifiesTradingDayInput {
  readonly startingBalance: string;
  readonly initialStopRisk: string;
}

export interface StageLifecycleContext {
  readonly db: EventDatabase;
}

export interface EvaluateStoredStageInput {
  readonly stageId: string;
  readonly evaluatedAt: string;
}

export interface StoredStageEvaluation {
  readonly status: StageEvaluationStatus | "COMPLETED";
  readonly stageId: string;
  readonly startingBalance: string;
  readonly equity: string;
  readonly qualifyingDays: number;
  readonly nextStageId: string | null;
  readonly nextStartingBalance: string | null;
}

interface StageRow extends Record<string, unknown> {
  readonly stage_id: string;
  readonly challenge_portfolio_id: string;
  readonly profile_version_id: string;
  readonly stage_profile_id: string;
  readonly ordinal: number;
  readonly starting_balance_cents: string;
  readonly target_equity_cents: string;
  readonly overall_floor_cents: string;
  readonly daily_loss_limit_cents: string;
  readonly qualifying_risk_cents: string;
  readonly minimum_trading_days: number;
}

interface TimedLedgerRow extends StoredReplayLedgerEvent, Record<string, unknown> {
  readonly occurred_at: Date;
}

function invalid(code: string): never {
  throw new Error(`CHALLENGE_STAGE_${code}_INVALID`);
}

function dataSnapshot(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || utilTypes.isProxy(value)) return invalid("INPUT");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid("INPUT");
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (keys.length < requiredKeys.length || keys.length > allowedKeys.size
      || keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      return invalid("INPUT");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of requiredKeys) {
      if (!keys.includes(key)) return invalid("INPUT");
    }
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalid("INPUT");
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof Error && error.message === "CHALLENGE_STAGE_INPUT_INVALID") {
      throw error;
    }
    return invalid("INPUT");
  }
}

function dataArraySnapshot(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) return invalid("INPUT");
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const rawLength = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (!lengthDescriptor || !("value" in lengthDescriptor)
      || typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0
      || rawLength > MAX_QUALIFYING_DAYS) return invalid("INPUT");
    const length = rawLength;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")
      || keys.some((key) => typeof key !== "string"
        || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)))) {
      return invalid("INPUT");
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalid("INPUT");
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof Error && error.message === "CHALLENGE_STAGE_INPUT_INVALID") {
      throw error;
    }
    return invalid("INPUT");
  }
}

function decimal(value: unknown, field: string, allowZero = false): InstanceType<typeof StageDecimal> {
  if (typeof value !== "string" || value.length > 64 || !DECIMAL_PATTERN.test(value)) {
    return invalid(field);
  }
  const parsed = new StageDecimal(value);
  if (!parsed.isFinite() || parsed.isNegative() || (!allowZero && parsed.isZero())) {
    return invalid(field);
  }
  return parsed;
}

function money(value: InstanceType<typeof StageDecimal>): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalid("ID");
  return value.toLowerCase();
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return invalid("TIME");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return invalid("TIME");
  return value;
}

function utcDate(value: unknown): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return invalid("TRADING_DAY");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return invalid("TRADING_DAY");
  }
  return value;
}

export function qualifiesTradingDay(input: QualifiesTradingDayInput): boolean {
  const captured = dataSnapshot(input, ["initialStopRisk", "startingBalance"]);
  const startingBalance = decimal(captured.startingBalance, "STARTING_BALANCE");
  const initialStopRisk = decimal(captured.initialStopRisk, "INITIAL_STOP_RISK", true);
  const values = stageValues(BigInt(startingBalance.mul(100).toFixed(0)));
  return initialStopRisk.greaterThanOrEqualTo(
    new StageDecimal(values.qualifyingRiskCents.toString()).div(100),
  );
}

export function evaluateStage(input: EvaluateStageInput): Readonly<StageEvaluation> {
  const captured = dataSnapshot(
    input,
    ["equity", "qualifyingDays", "startingBalance"],
    ["dayStartEquity"],
  );
  const capturedDays = dataArraySnapshot(captured.qualifyingDays);
  const startingBalance = decimal(captured.startingBalance, "STARTING_BALANCE");
  const equity = decimal(captured.equity, "EQUITY", true);
  const dayStartEquity = captured.dayStartEquity === undefined
    ? startingBalance
    : decimal(captured.dayStartEquity, "DAY_START_EQUITY", true);
  const uniqueDays = new Set(capturedDays.map(utcDate)).size;
  const values = stageValues(BigInt(startingBalance.mul(100).toFixed(0)));
  const targetEquity = new StageDecimal(values.targetEquityCents.toString()).div(100);
  const overallFloor = new StageDecimal(values.overallFloorCents.toString()).div(100);
  const dailyLossLimit = new StageDecimal(values.dailyLossLimitCents.toString()).div(100);
  const failed = equity.lessThanOrEqualTo(overallFloor)
    || StageDecimal.max(dayStartEquity.minus(equity), 0).greaterThanOrEqualTo(dailyLossLimit);
  const status: StageEvaluationStatus = failed
    ? "FAILED"
    : equity.greaterThanOrEqualTo(targetEquity)
        && uniqueDays >= INITIAL_PROFILE.minimumTradingDays
      ? "PASSED"
      : "ACTIVE";
  return Object.freeze({
    status,
    uniqueQualifyingDays: uniqueDays,
    targetEquity: money(targetEquity),
    overallFloor: money(overallFloor),
    dailyLossLimit: money(dailyLossLimit),
  });
}

export function nextStartingBalance(startingBalance: string): string | null {
  const parsed = decimal(startingBalance, "STARTING_BALANCE");
  if (!parsed.mul(100).isInteger()) return invalid("STARTING_BALANCE");
  const ladder = stageLadderCents();
  const index = ladder.indexOf(BigInt(parsed.mul(100).toFixed(0)));
  if (index < 0) return invalid("STARTING_BALANCE");
  const next = ladder[index + 1];
  return next === undefined ? null : money(new StageDecimal(next.toString()).div(100));
}

export function createStageLifecycleContext(db: EventDatabase): StageLifecycleContext {
  if (!db || typeof db !== "object" || typeof db.transaction !== "function") {
    throw new Error("CHALLENGE_STAGE_CONTEXT_INVALID");
  }
  const context = Object.freeze({ db });
  stageLifecycleContexts.add(context);
  return context;
}

async function stageRow(database: EventDatabase, stageId: string): Promise<StageRow> {
  return database.one<StageRow>(
    `select stage.id::text as stage_id, stage.challenge_portfolio_id::text,
            stage.profile_version_id::text, stage.stage_profile_id::text,
            stage.ordinal, stage_profile.starting_balance_cents::text,
            stage_profile.target_equity_cents::text,
            stage_profile.overall_floor_cents::text,
            stage_profile.daily_loss_limit_cents::text,
            stage_profile.qualifying_risk_cents::text,
            profile.minimum_trading_days
       from challenge_stages stage
       join challenge_stage_profiles stage_profile on stage_profile.id=stage.stage_profile_id
       join challenge_profile_versions profile on profile.id=stage.profile_version_id
      where stage.id=$1`,
    [stageId],
  );
}

async function ledgerPrefix(
  database: EventDatabase,
  stageId: string,
): Promise<readonly TimedLedgerRow[]> {
  return database.query<TimedLedgerRow>(
    `select id::text,sequence::text,type,
            profile_version_id::text as "profileVersionId",payload,occurred_at
       from challenge_ledger_events
      where stage_id=$1
      order by challenge_ledger_events.sequence,challenge_ledger_events.id`,
    [stageId],
  );
}

async function qualifyingDays(
  database: EventDatabase,
  stage: StageRow,
  evaluatedAt: string,
): Promise<readonly string[]> {
  const rows = await database.query<{ day: string } & Record<string, unknown>>(
    `select distinct to_char(fill.filled_at at time zone 'UTC','YYYY-MM-DD') as day
       from challenge_fills fill
       join challenge_positions position
         on position.id=fill.position_id
        and position.opening_ledger_event_id=fill.ledger_event_id
       join challenge_orders paper_order on paper_order.id=fill.order_id
       join challenge_ledger_events order_event on order_event.id=paper_order.ledger_event_id
       join challenge_rule_evaluations evaluation
         on evaluation.ledger_event_id=order_event.causation_id and evaluation.accepted
       join challenge_ledger_events evaluation_event on evaluation_event.id=evaluation.ledger_event_id
      where fill.stage_id=$1 and fill.filled_at<=$2
        and evaluation_event.payload->'riskSnapshot'->>'proposedStopRisk'
              ~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{1,8})?$'
        and (evaluation_event.payload->'riskSnapshot'->>'proposedStopRisk')::numeric
              >=$3::numeric/100
      order by day`,
    [stage.stage_id, evaluatedAt, stage.qualifying_risk_cents],
  );
  return Object.freeze(rows.map((row) => row.day));
}

async function hasPendingOrder(
  database: EventDatabase,
  stageId: string,
): Promise<boolean> {
  const row = await database.one<{ pending: boolean }>(
    `select exists (
       select 1
         from challenge_orders paper_order
        where paper_order.stage_id=$1
          and not exists (
            select 1 from challenge_fills fill where fill.order_id=paper_order.id
          )
          and not exists (
            select 1 from challenge_ledger_events cancelled
             where cancelled.stage_id=paper_order.stage_id
               and cancelled.type='paper.order.cancelled'
               and cancelled.causation_id=paper_order.ledger_event_id
          )
     ) as pending`,
    [stageId],
  );
  return row.pending;
}

function evaluateStoredThresholds(
  stage: StageRow,
  equityValue: string,
  dayStartEquityValue: string,
  days: readonly string[],
): Readonly<StageEvaluation> {
  const equity = decimal(equityValue, "EQUITY", true);
  const dayStartEquity = decimal(dayStartEquityValue, "DAY_START_EQUITY", true);
  const uniqueDays = new Set(days.map(utcDate)).size;
  const targetEquity = new StageDecimal(stage.target_equity_cents).div(100);
  const overallFloor = new StageDecimal(stage.overall_floor_cents).div(100);
  const dailyLossLimit = new StageDecimal(stage.daily_loss_limit_cents).div(100);
  const failed = equity.lessThanOrEqualTo(overallFloor)
    || StageDecimal.max(dayStartEquity.minus(equity), 0)
      .greaterThanOrEqualTo(dailyLossLimit);
  const status: StageEvaluationStatus = failed
    ? "FAILED"
    : equity.greaterThanOrEqualTo(targetEquity)
        && uniqueDays >= stage.minimum_trading_days
      ? "PASSED"
      : "ACTIVE";
  return Object.freeze({
    status,
    uniqueQualifyingDays: uniqueDays,
    targetEquity: money(targetEquity),
    overallFloor: money(overallFloor),
    dailyLossLimit: money(dailyLossLimit),
  });
}

async function existingTerminalResult(
  database: EventDatabase,
  stage: StageRow,
): Promise<Readonly<StoredStageEvaluation> | undefined> {
  const terminals = await database.query<{ type: "stage.passed" | "stage.failed" } & Record<string, unknown>>(
    `select type from challenge_ledger_events
      where stage_id=$1 and type in ('stage.passed','stage.failed')
      order by sequence`,
    [stage.stage_id],
  );
  if (!terminals[0]) return undefined;
  const events = await database.query<TimedLedgerRow>(
    `select id::text,sequence::text,type,
            profile_version_id::text as "profileVersionId",payload,occurred_at
       from challenge_ledger_events where stage_id=$1
       order by challenge_ledger_events.sequence,challenge_ledger_events.id`,
    [stage.stage_id],
  );
  const projection = replayStoredLedgerEvents(events);
  const days = await qualifyingDays(database, stage, "9999-12-31T23:59:59.999Z");
  const successor = await database.query<{ stage_id: string; starting_balance_cents: string } & Record<string, unknown>>(
    `select successor.id::text as stage_id,profile.starting_balance_cents::text
       from challenge_stages successor
       join challenge_stage_profiles profile on profile.id=successor.stage_profile_id
      where successor.challenge_portfolio_id=$1 and successor.ordinal=$2`,
    [stage.challenge_portfolio_id, stage.ordinal + 1],
  );
  const completed = terminals[0].type === "stage.passed"
    && stage.ordinal === stageLadderCents().length;
  return Object.freeze({
    status: terminals[0].type === "stage.failed" ? "FAILED" : completed ? "COMPLETED" : "PASSED",
    stageId: stage.stage_id,
    startingBalance: money(new StageDecimal(stage.starting_balance_cents).div(100)),
    equity: projection.equity,
    qualifyingDays: days.length,
    nextStageId: successor[0]?.stage_id ?? null,
    nextStartingBalance: successor[0]
      ? money(new StageDecimal(successor[0].starting_balance_cents).div(100))
      : null,
  });
}

export async function evaluateStoredStage(
  context: StageLifecycleContext,
  rawInput: EvaluateStoredStageInput,
): Promise<Readonly<StoredStageEvaluation>> {
  if (!context || typeof context !== "object" || !stageLifecycleContexts.has(context)) {
    throw new Error("CHALLENGE_STAGE_CONTEXT_INVALID");
  }
  const captured = dataSnapshot(rawInput, ["evaluatedAt", "stageId"]);
  const stageId = uuid(captured.stageId);
  const evaluatedAt = timestamp(captured.evaluatedAt);
  const database = context.db;
  return database.transaction(async (transaction) => {
    await transaction.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [`challenge-stage:${stageId}`],
    );
    await transaction.one("select id from challenge_stages where id=$1 for update", [stageId]);
    const stage = await stageRow(transaction, stageId);
    const stored = await existingTerminalResult(transaction, stage);
    if (stored) return stored;
    const latest = await transaction.one<{ occurred_at: Date }>(
      `select max(occurred_at) as occurred_at from challenge_ledger_events
        where stage_id=$1`,
      [stageId],
    );
    if (latest.occurred_at.getTime() > Date.parse(evaluatedAt)) {
      throw new Error("CHALLENGE_STAGE_EVALUATION_OUT_OF_ORDER");
    }
    const events = await ledgerPrefix(transaction, stageId);
    if (events.length === 0) throw new Error("CHALLENGE_STAGE_LEDGER_EMPTY");
    const projection = replayStoredLedgerEvents(events);
    const boundary = new Date(evaluatedAt);
    boundary.setUTCHours(0, 0, 0, 0);
    const firstCurrentDayEvent = events.findIndex((event) => event.occurred_at >= boundary);
    const priorDayEvents = firstCurrentDayEvent < 0
      ? events
      : events.slice(0, firstCurrentDayEvent);
    const dayStartEquity = priorDayEvents.some((event) => event.type === "stage.started")
      ? replayStoredLedgerEvents(priorDayEvents).equity
      : money(new StageDecimal(stage.starting_balance_cents).div(100));
    const days = await qualifyingDays(transaction, stage, evaluatedAt);
    const evaluation = evaluateStoredThresholds(
      stage,
      projection.equity,
      dayStartEquity,
      days,
    );
    const passDeferred = evaluation.status === "PASSED"
      && (projection.openPositions > 0 || await hasPendingOrder(transaction, stageId));
    if (evaluation.status === "ACTIVE" || passDeferred) {
      return Object.freeze({
        status: "ACTIVE", stageId, startingBalance: money(
          new StageDecimal(stage.starting_balance_cents).div(100),
        ), equity: projection.equity, qualifyingDays: days.length,
        nextStageId: null, nextStartingBalance: null,
      });
    }
    const terminalType = evaluation.status === "FAILED" ? "stage.failed" : "stage.passed";
    const terminal = await appendChallengeLedgerEvent({ db: transaction }, {
      id: randomUUID(), challengePortfolioId: stage.challenge_portfolio_id,
      stageId, profileVersionId: stage.profile_version_id, type: terminalType,
      payload: {
        stageId, equity: projection.equity, qualifyingDays: days.length,
        evaluatedAt, targetEquity: evaluation.targetEquity,
        overallFloor: evaluation.overallFloor, dailyLossLimit: evaluation.dailyLossLimit,
      },
      occurredAt: evaluatedAt, actorType: "SYSTEM", actorId: "challenge-stage-lifecycle",
      idempotencyKey: `challenge-stage-terminal:${stageId}`,
    });
    if (evaluation.status === "FAILED") {
      await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(), challengePortfolioId: stage.challenge_portfolio_id,
        stageId, profileVersionId: stage.profile_version_id, type: "challenge.failed",
        payload: { stageId, failedAt: evaluatedAt }, occurredAt: evaluatedAt,
        actorType: "SYSTEM", actorId: "challenge-stage-lifecycle",
        causationId: terminal.id, idempotencyKey: `challenge-failed:${stageId}`,
      });
      return (await existingTerminalResult(transaction, stage))!;
    }
    const nextBalance = nextStartingBalance(
      money(new StageDecimal(stage.starting_balance_cents).div(100)),
    );
    if (nextBalance === null) {
      await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(), challengePortfolioId: stage.challenge_portfolio_id,
        stageId, profileVersionId: stage.profile_version_id, type: "challenge.passed",
        payload: { stageId, completedAt: evaluatedAt }, occurredAt: evaluatedAt,
        actorType: "SYSTEM", actorId: "challenge-stage-lifecycle",
        causationId: terminal.id, idempotencyKey: `challenge-passed:${stageId}`,
      });
      return (await existingTerminalResult(transaction, stage))!;
    }
    const nextStageId = randomUUID();
    const advanced = await appendChallengeLedgerEvent({ db: transaction }, {
      id: randomUUID(), challengePortfolioId: stage.challenge_portfolio_id,
      stageId, profileVersionId: stage.profile_version_id, type: "stage.advanced",
      payload: { stageId, nextStageId, nextStartingBalance: nextBalance },
      occurredAt: evaluatedAt, actorType: "SYSTEM", actorId: "challenge-stage-lifecycle",
      causationId: terminal.id, idempotencyKey: `challenge-stage-advanced:${stageId}`,
    });
    const successorProfile = await transaction.one<{ id: string }>(
      `select id::text from challenge_stage_profiles
        where profile_version_id=$1 and ordinal=$2`,
      [stage.profile_version_id, stage.ordinal + 1],
    );
    await transaction.query(
      `insert into challenge_stages (
         id,challenge_portfolio_id,profile_version_id,stage_profile_id,ordinal,created_at
       ) values ($1,$2,$3,$4,$5,$6)`,
      [nextStageId, stage.challenge_portfolio_id, stage.profile_version_id,
        successorProfile.id, stage.ordinal + 1, evaluatedAt],
    );
    const created = await appendChallengeLedgerEvent({ db: transaction }, {
      id: randomUUID(), challengePortfolioId: stage.challenge_portfolio_id,
      stageId: nextStageId, profileVersionId: stage.profile_version_id, type: "stage.created",
      payload: {
        stageId: nextStageId, predecessorStageId: stageId,
        ordinal: stage.ordinal + 1, startingBalance: nextBalance,
      },
      occurredAt: evaluatedAt, actorType: "SYSTEM", actorId: "challenge-stage-lifecycle",
      causationId: advanced.id, idempotencyKey: `challenge-stage-created:${nextStageId}`,
    });
    await appendChallengeLedgerEvent({ db: transaction }, {
      id: randomUUID(), challengePortfolioId: stage.challenge_portfolio_id,
      stageId: nextStageId, profileVersionId: stage.profile_version_id, type: "stage.started",
      payload: { amount: nextBalance }, occurredAt: evaluatedAt,
      actorType: "SYSTEM", actorId: "challenge-stage-lifecycle",
      causationId: created.id, idempotencyKey: `challenge-stage-started:${nextStageId}`,
    });
    return (await existingTerminalResult(transaction, stage))!;
  });
}
