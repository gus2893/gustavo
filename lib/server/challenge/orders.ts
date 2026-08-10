import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import Decimal from "decimal.js";
import { readEventBody } from "../events/store";
import type { EventDatabase } from "../events/types";
import { assertChallengeObservation } from "../market-data/policy";
import { createTrustedSourceRegistry } from "../market-data/types";
import { appendChallengeLedgerEvent } from "./ledger";
import { calculateCommission, calculatePriceFill } from "./costs";
import { INITIAL_PROFILE } from "./profile";
import { replayStoredLedgerEvents, type StoredReplayLedgerEvent } from "./projection";
import { evaluateRisk } from "./risk";
import {
  createStageLifecycleContext,
  evaluateStoredStage,
} from "./stages";

const OrderDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTENT_KEYS = Object.freeze([
  "desiredRisk", "direction", "entry", "evaluatedAt", "exitRule",
  "expiresAt", "idempotencyKey", "sourceDecisionId", "stop", "symbol",
]);
const EXIT_RULE_KEYS = Object.freeze(["price", "type"]);
const RISK_POLICY_VERSION = "challenge-risk-v1";

const mainOrderContexts = new WeakSet<object>();

export interface MainPaperOrderContext {
  readonly db: EventDatabase;
}

export function createMainPaperOrderContext(db: EventDatabase): MainPaperOrderContext {
  if (!db || typeof db !== "object" || typeof db.transaction !== "function") {
    throw new Error("PAPER_INTENT_DATABASE_INVALID");
  }
  const context = Object.freeze({ db });
  mainOrderContexts.add(context);
  return context;
}

export interface SubmitPaperIntentInput {
  readonly sourceDecisionId: string;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly entry: string;
  readonly stop: string;
  readonly exitRule: { readonly type: "TARGET"; readonly price: string };
  readonly desiredRisk: string;
  readonly expiresAt: string;
  readonly evaluatedAt: string;
  readonly idempotencyKey: string;
}

export interface PaperIntentResult {
  readonly status: "ORDER_CREATED" | "REJECTED";
  readonly accepted: boolean;
  readonly intentId: string;
  readonly evaluationId: string;
  readonly orderId: string | null;
  readonly reasons: readonly string[];
  readonly quantity: string | null;
}

interface CapturedIntent {
  readonly sourceDecisionId: string;
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly side: "BUY" | "SELL";
  readonly ledgerDirection: "PAPER_LONG" | "PAPER_SHORT";
  readonly entry: string;
  readonly stop: string;
  readonly target: string;
  readonly desiredRisk: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly evaluatedAt: string;
  readonly geometryComplete: boolean;
  readonly quantity: string | null;
  readonly proposedStopRisk: string | null;
  readonly proposedNotional: string | null;
  readonly entryCommission: string | null;
  readonly requestDigest: string;
}

interface StageRow extends Record<string, unknown> {
  readonly stage_id: string;
  readonly challenge_portfolio_id: string;
  readonly profile_version_id: string;
  readonly starting_balance_cents: string;
}

interface DecisionRow extends Record<string, unknown> {
  readonly eligible_instruments: readonly string[];
  readonly market_observation_ids: readonly string[];
  readonly stage_profile_version: string;
  readonly result: "MAIN" | "CONTENDER" | "NO_PAPER_TRADE";
  readonly selected_candidate_id: string | null;
  readonly evaluator_run_id: string;
  readonly selection_event_id: string;
  readonly candidate_event_id: string | null;
  readonly candidate_commitment_digest: string | null;
  readonly total_score: number | null;
  readonly evidence_fresh: boolean | null;
  readonly session_valid: boolean | null;
  readonly geometry_complete: boolean | null;
  readonly non_duplicate: boolean | null;
  readonly authorized: boolean | null;
}

interface SelectedPaperThesis {
  readonly symbol: string;
  readonly direction: "LONG" | "SHORT";
  readonly entry: string;
  readonly stop: string;
  readonly target: string;
  readonly desiredRisk: string;
  readonly expiresAt: string;
}

interface ObservationRow extends Record<string, unknown> {
  readonly id: string;
  readonly symbol: string;
  readonly asset_class: "US_STOCK" | "US_ETF";
  readonly price: string;
  readonly observed_at: Date;
  readonly received_at: Date;
  readonly provider: string;
  readonly license_id: string;
  readonly raw_source_ref: string;
  readonly feed_status: "REALTIME" | "DELAYED";
  readonly delay_seconds: number;
  readonly redistribution: "PUBLIC" | "ACCOUNT_ONLY" | "INTERNAL_ONLY" | "PROHIBITED";
  readonly session_state: "OPEN" | "CLOSED" | "PRE_MARKET" | "AFTER_HOURS" | "HALTED";
  readonly licensed: boolean;
  readonly source_redistribution: "PUBLIC" | "ACCOUNT_ONLY" | "INTERNAL_ONLY" | "PROHIBITED";
  readonly enabled: boolean;
  readonly provisional: boolean;
  readonly completed: boolean;
}

interface ExistingIntentRow extends Record<string, unknown> {
  readonly request_digest: string | null;
  readonly intent_id: string;
  readonly evaluation_id: string;
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly order_id: string | null;
  readonly quantity: string | null;
}

interface ActiveOrderRow extends Record<string, unknown> {
  readonly symbol: string;
  readonly quantity: string;
  readonly entry_price: string;
  readonly desired_risk: string;
  readonly stop_price: string;
  readonly side: "BUY" | "SELL";
  readonly filled_quantity: string;
  readonly closed_quantity: string;
  readonly cancelled: boolean;
  readonly fill_price: string | null;
  readonly position_id: string | null;
  readonly mark_price: string | null;
}

function invalid(code: string): never {
  throw new Error(`PAPER_INTENT_${code}`);
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalid(code);
  return value.toLowerCase();
}

function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return invalid(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return invalid(code);
  return value;
}

function decimal(value: unknown, code: string): InstanceType<typeof OrderDecimal> {
  if (typeof value !== "string" || value.length > 64 || !DECIMAL_PATTERN.test(value)) {
    return invalid(code);
  }
  const parsed = new OrderDecimal(value);
  if (!parsed.isFinite() || parsed.lessThanOrEqualTo(0)) return invalid(code);
  return parsed;
}

function boundedDecimal(value: InstanceType<typeof OrderDecimal>): string {
  return value.toDecimalPlaces(8, Decimal.ROUND_DOWN).toFixed(8).replace(/\.?0+$/u, "");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function plainDataSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || utilTypes.isProxy(value)) return invalid("INPUT_INVALID");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid("INPUT_INVALID");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string")) {
    return invalid("INPUT_INVALID");
  }
  const sortedKeys = [...keys].sort();
  if (stable(sortedKeys) !== stable(expectedKeys)) return invalid("INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
      || descriptor.get !== undefined || descriptor.set !== undefined) {
      return invalid("INPUT_INVALID");
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function costedStopAssumptions(
  direction: "LONG" | "SHORT",
  entry: InstanceType<typeof OrderDecimal>,
  stop: InstanceType<typeof OrderDecimal>,
): Readonly<{
  entryFill: InstanceType<typeof OrderDecimal>;
  lossPerShare: InstanceType<typeof OrderDecimal>;
}> | undefined {
  const entrySide = direction === "LONG" ? "BUY" : "SELL";
  const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
  const entryFill = new OrderDecimal(calculatePriceFill({
    side: entrySide,
    reference: entry.toFixed(),
  }).result);
  const stopFill = new OrderDecimal(calculatePriceFill({
    side: exitSide,
    reference: stop.toFixed(),
  }).result);
  const lossPerShare = direction === "LONG"
    ? entryFill.minus(stopFill)
    : stopFill.minus(entryFill);
  if (lossPerShare.lessThanOrEqualTo(0)) return undefined;
  return Object.freeze({ entryFill, lossPerShare });
}

function stopRiskForQuantity(
  assumptions: Readonly<{
    entryFill: InstanceType<typeof OrderDecimal>;
    lossPerShare: InstanceType<typeof OrderDecimal>;
  }>,
  quantity: InstanceType<typeof OrderDecimal>,
): InstanceType<typeof OrderDecimal> {
  const boundedQuantity = quantity.toDecimalPlaces(8, Decimal.ROUND_DOWN);
  const commission = new OrderDecimal(
    calculateCommission(boundedQuantity.toFixed(8)).result,
  );
  return assumptions.lossPerShare.mul(boundedQuantity).plus(commission.mul(2));
}

function costedGeometry(
  direction: "LONG" | "SHORT",
  entry: InstanceType<typeof OrderDecimal>,
  stop: InstanceType<typeof OrderDecimal>,
  desiredRisk: InstanceType<typeof OrderDecimal>,
): Readonly<{
  quantity: string;
  stopRisk: string;
  notional: string;
  entryCommission: string;
}> | undefined {
  const assumptions = costedStopAssumptions(direction, entry, stop);
  if (!assumptions) return undefined;
  const totalLoss = (quantity: InstanceType<typeof OrderDecimal>) => {
    return stopRiskForQuantity(assumptions, quantity);
  };
  let low = new OrderDecimal(0);
  let high = desiredRisk.div(assumptions.lossPerShare);
  for (let index = 0; index < 128; index += 1) {
    const midpoint = low.plus(high).div(2);
    if (totalLoss(midpoint).lessThanOrEqualTo(desiredRisk)) low = midpoint;
    else high = midpoint;
  }
  const quantity = low.toDecimalPlaces(8, Decimal.ROUND_DOWN);
  if (quantity.lessThanOrEqualTo(0)) return undefined;
  const entryCommission = calculateCommission(quantity.toFixed()).result;
  return Object.freeze({
    quantity: boundedDecimal(quantity),
    stopRisk: boundedDecimal(totalLoss(quantity)),
    notional: boundedDecimal(assumptions.entryFill.mul(quantity)),
    entryCommission,
  });
}

function captureIntent(input: SubmitPaperIntentInput): Readonly<CapturedIntent> {
  const raw = plainDataSnapshot(input, INTENT_KEYS);
  const rawExitRule = plainDataSnapshot(raw.exitRule, EXIT_RULE_KEYS);
  const captured = {
    sourceDecisionId: raw.sourceDecisionId,
    symbol: raw.symbol,
    direction: raw.direction,
    entry: raw.entry,
    stop: raw.stop,
    exitRule: Object.freeze({ type: rawExitRule.type, price: rawExitRule.price }),
    desiredRisk: raw.desiredRisk,
    expiresAt: raw.expiresAt,
    evaluatedAt: raw.evaluatedAt,
    idempotencyKey: raw.idempotencyKey,
  };
  const sourceDecisionId = uuid(captured.sourceDecisionId, "DECISION_INVALID");
  if (typeof captured.symbol !== "string" || !SYMBOL_PATTERN.test(captured.symbol)) {
    return invalid("SYMBOL_INVALID");
  }
  const rawDirection = captured.direction;
  if (rawDirection !== "LONG" && rawDirection !== "SHORT") {
    return invalid("DIRECTION_INVALID");
  }
  const direction: "LONG" | "SHORT" = rawDirection;
  if (!captured.exitRule || typeof captured.exitRule !== "object"
    || captured.exitRule.type !== "TARGET") return invalid("GEOMETRY_INVALID");
  const entryValue = decimal(captured.entry, "GEOMETRY_INVALID");
  const stopValue = decimal(captured.stop, "GEOMETRY_INVALID");
  const targetValue = decimal(captured.exitRule.price, "GEOMETRY_INVALID");
  const desiredRiskValue = decimal(captured.desiredRisk, "RISK_INVALID");
  const entry = captured.entry as string;
  const stop = captured.stop as string;
  const target = captured.exitRule.price as string;
  const desiredRisk = captured.desiredRisk as string;
  const geometryComplete = direction === "LONG"
    ? stopValue.lessThan(entryValue) && targetValue.greaterThan(entryValue)
    : stopValue.greaterThan(entryValue) && targetValue.lessThan(entryValue);
  const expiresAt = timestamp(captured.expiresAt, "EXPIRY_INVALID");
  const evaluatedAt = timestamp(captured.evaluatedAt, "EVALUATED_AT_INVALID");
  if (typeof captured.idempotencyKey !== "string" || !KEY_PATTERN.test(captured.idempotencyKey)) {
    return invalid("IDEMPOTENCY_KEY_INVALID");
  }
  const costed = geometryComplete
    ? costedGeometry(direction, entryValue, stopValue, desiredRiskValue)
    : undefined;
  const normalized = {
    sourceDecisionId,
    symbol: captured.symbol,
    direction,
    entry,
    stop,
    target,
    desiredRisk,
    expiresAt,
    evaluatedAt,
    idempotencyKey: captured.idempotencyKey,
    geometryComplete: geometryComplete && costed !== undefined,
    quantity: costed?.quantity ?? null,
    proposedStopRisk: costed?.stopRisk ?? null,
    proposedNotional: costed?.notional ?? null,
    entryCommission: costed?.entryCommission ?? null,
  };
  return Object.freeze({
    ...normalized,
    side: direction === "LONG" ? "BUY" : "SELL",
    ledgerDirection: direction === "LONG" ? "PAPER_LONG" : "PAPER_SHORT",
    requestDigest: digest(normalized),
  });
}

function frozenResult(row: ExistingIntentRow): Readonly<PaperIntentResult> {
  const reasons = Object.freeze([...(row.reasons ?? [])]);
  return Object.freeze({
    status: row.accepted ? "ORDER_CREATED" : "REJECTED",
    accepted: row.accepted,
    intentId: row.intent_id,
    evaluationId: row.evaluation_id,
    orderId: row.order_id,
    reasons,
    quantity: row.quantity,
  });
}

async function existingIntent(
  database: EventDatabase,
  challengePortfolioId: string,
  key: string,
): Promise<ExistingIntentRow | undefined> {
  const rows = await database.query<ExistingIntentRow>(
    `select event.payload->>'requestDigest' as request_digest,
            intent.id::text as intent_id,
            evaluation.id::text as evaluation_id,
            evaluation.accepted,
            evaluation.reasons,
            paper_order.id::text as order_id,
            paper_order.quantity
       from challenge_ledger_events event
       join challenge_intents intent on intent.ledger_event_id=event.id
       join challenge_rule_evaluations evaluation on evaluation.intent_id=intent.id
       left join challenge_orders paper_order on paper_order.intent_id=intent.id
      where event.challenge_portfolio_id=$1 and event.idempotency_key=$2`,
    [challengePortfolioId, `paper-intent:${key}`],
  );
  return rows[0];
}

async function currentStage(database: EventDatabase): Promise<StageRow> {
  const rows = await database.query<StageRow>(
    `select stage.id::text as stage_id,
            stage.challenge_portfolio_id::text,
            stage.profile_version_id::text,
            stage_profile.starting_balance_cents::text
       from challenge_stages stage
       join challenge_stage_profiles stage_profile on stage_profile.id=stage.stage_profile_id
       join challenge_profile_publications publication
         on publication.profile_version_id=stage.profile_version_id
       join challenge_profile_versions profile on profile.id=stage.profile_version_id
      where profile.initial_lifecycle_state='ACTIVE'
        and exists (
          select 1 from challenge_ledger_events started
           where started.stage_id=stage.id and started.type='stage.started'
        )
        and not exists (
          select 1 from challenge_ledger_events terminal
           where terminal.stage_id=stage.id
             and terminal.type in ('stage.passed','stage.failed')
        )
        and not exists (
          select 1 from challenge_ledger_events terminal
           where terminal.challenge_portfolio_id=stage.challenge_portfolio_id
             and terminal.type in (
               'challenge.paused','challenge.passed','challenge.failed','challenge.archived'
             )
        )
      order by stage.ordinal desc`,
  );
  if (rows.length !== 1) throw new Error("PAPER_INTENT_CURRENT_STAGE_INVALID");
  return rows[0]!;
}

async function decisionRow(database: EventDatabase, decisionId: string): Promise<DecisionRow | undefined> {
  const rows = await database.query<DecisionRow>(
    `select decision_window.eligible_instruments,
            decision_window.market_observation_ids,
            decision_window.stage_profile_version::text,
            selection.result,
            selection.selected_candidate_id,
            selection.evaluator_run_id::text,
            selection.selection_event_id::text,
            candidate.candidate_event_id::text,
            candidate.commitment_digest as candidate_commitment_digest,
            score.total_score,
            score.evidence_fresh,
            score.session_valid,
            score.geometry_complete,
            score.non_duplicate,
            score.authorized
       from decision_windows decision_window
       join decision_selections selection on selection.window_id=decision_window.id
       left join decision_candidates candidate
         on candidate.window_id=decision_window.id
        and candidate.candidate_id=selection.selected_candidate_id
       left join decision_evaluation_scores score
         on score.window_id=decision_window.id
        and score.candidate_id=selection.selected_candidate_id
      where decision_window.id=$1`,
    [decisionId],
  );
  return rows[0];
}

function selectedPaperThesis(body: unknown): SelectedPaperThesis | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const thesis = (body as Record<string, unknown>).thesis;
  if (typeof thesis !== "string" || thesis.length > 4_096) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(thesis);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (stable(keys) !== stable([
    "desiredRisk", "direction", "entry", "expiresAt", "stop", "symbol", "target",
  ])) return undefined;
  if (typeof value.symbol !== "string" || !SYMBOL_PATTERN.test(value.symbol)
    || (value.direction !== "LONG" && value.direction !== "SHORT")
    || typeof value.entry !== "string" || typeof value.stop !== "string"
    || typeof value.target !== "string" || typeof value.desiredRisk !== "string"
    || typeof value.expiresAt !== "string") return undefined;
  try {
    decimal(value.entry, "SELECTED_THESIS_INVALID");
    decimal(value.stop, "SELECTED_THESIS_INVALID");
    decimal(value.target, "SELECTED_THESIS_INVALID");
    decimal(value.desiredRisk, "SELECTED_THESIS_INVALID");
    timestamp(value.expiresAt, "SELECTED_THESIS_INVALID");
  } catch {
    return undefined;
  }
  return Object.freeze({
    symbol: value.symbol,
    direction: value.direction,
    entry: value.entry,
    stop: value.stop,
    target: value.target,
    desiredRisk: value.desiredRisk,
    expiresAt: value.expiresAt,
  });
}

async function selectedGeometry(
  database: EventDatabase,
  decision: DecisionRow | undefined,
): Promise<SelectedPaperThesis | undefined> {
  if (!decision?.candidate_event_id) return undefined;
  const body = await readEventBody(database, decision.candidate_event_id, {
    actor: { role: "SYSTEM" },
  });
  return selectedPaperThesis(body);
}

async function selectedObservation(
  database: EventDatabase,
  decisionId: string,
  symbol: string,
): Promise<ObservationRow | undefined> {
  const rows = await database.query<ObservationRow>(
    `select observation.id::text, observation.symbol, observation.asset_class,
            observation.price, observation.observed_at, observation.received_at,
            observation.provider, observation.license_id, observation.raw_source_ref,
            observation.feed_status, observation.delay_seconds,
            observation.redistribution, observation.session_state,
            source.licensed, source.redistribution as source_redistribution,
            instrument.enabled,
            exists (
              select 1 from market_bars bar
               where bar.source_observation_id=observation.id and not bar.completed
            ) as provisional,
            exists (
              select 1 from market_bars bar
               where bar.source_observation_id=observation.id and bar.completed
            ) as completed
       from decision_windows decision_window
       cross join lateral jsonb_array_elements_text(decision_window.market_observation_ids) frozen(id)
       join market_observations observation on observation.id::text=frozen.id
       join market_data_sources source
         on source.provider=observation.provider and source.license_id=observation.license_id
       join market_instrument_allowlist instrument
         on instrument.symbol=observation.symbol and instrument.asset_class=observation.asset_class
      where decision_window.id=$1 and observation.symbol=$2`,
    [decisionId, symbol],
  );
  if (rows.length > 1) throw new Error("PAPER_INTENT_OBSERVATION_AMBIGUOUS");
  return rows[0];
}

function observationRejection(
  row: ObservationRow | undefined,
  evaluatedAt: string,
): string | undefined {
  if (!row) return "MARKET_OBSERVATION_REQUIRED";
  if (!row.enabled) return "MARKET_NOT_ALLOWED";
  if (!row.licensed) return "MARKET_SOURCE_UNLICENSED";
  if (row.source_redistribution !== row.redistribution) return "MARKET_RIGHTS_MISMATCH";
  if (row.redistribution === "PROHIBITED") return "MARKET_REDISTRIBUTION_FORBIDDEN";
  if (row.session_state !== "OPEN") return "MARKET_SESSION_CLOSED";
  if (row.provisional) return "MARKET_EVIDENCE_PROVISIONAL";
  if (!row.completed) return "MARKET_COMPLETED_EVIDENCE_REQUIRED";
  try {
    const registry = createTrustedSourceRegistry([{
      provider: row.provider,
      licenseId: row.license_id,
      active: row.licensed,
      redistribution: row.source_redistribution,
    }]);
    assertChallengeObservation({
      symbol: row.symbol,
      assetClass: row.asset_class,
      price: row.price,
      observedAt: row.observed_at.toISOString(),
      receivedAt: row.received_at.toISOString(),
      provider: row.provider,
      feedStatus: row.feed_status,
      delaySeconds: row.delay_seconds,
      redistribution: row.redistribution,
      sessionState: row.session_state,
      licenseStatus: "LICENSED",
      licenseId: row.license_id,
      rawSourceRef: row.raw_source_ref,
    }, {
      asOf: evaluatedAt,
      maxReceiptAgeSeconds: 300,
      allowlist: new Map([[row.symbol, row.asset_class]]),
      sourceRegistry: registry,
    });
  } catch (error) {
    return error instanceof Error ? error.message : "MARKET_OBSERVATION_INVALID";
  }
  return undefined;
}

type TimedStoredReplayLedgerEvent = StoredReplayLedgerEvent & {
  readonly occurredAt: string;
};

async function storedEvents(
  database: EventDatabase,
  stageId: string,
): Promise<TimedStoredReplayLedgerEvent[]> {
  const rows = await database.query<StoredReplayLedgerEvent & Record<string, unknown> & {
    readonly occurred_at: Date;
  }>(
    `select id::text, sequence::text, type, profile_version_id::text as "profileVersionId", payload,
            occurred_at
       from challenge_ledger_events
      where stage_id=$1
      order by challenge_ledger_events.sequence, challenge_ledger_events.id`,
    [stageId],
  );
  return rows.map((row) => ({ ...row, occurredAt: row.occurred_at.toISOString() }));
}

async function checkpoint(database: EventDatabase, stage: StageRow): Promise<void> {
  const events = await storedEvents(database, stage.stage_id);
  const highWater = events.at(-1);
  if (!highWater) throw new Error("PAPER_INTENT_LEDGER_EMPTY");
  const projection = replayStoredLedgerEvents(events);
  await database.query(
    `insert into challenge_projection_checkpoints (
       stage_id, profile_version_id, high_water_event_id,
       high_water_sequence, projection, rebuilt_at
     ) values ($1,$2,$3,$4,$5,clock_timestamp())
     on conflict (stage_id) do update set
       profile_version_id=excluded.profile_version_id,
       high_water_event_id=excluded.high_water_event_id,
       high_water_sequence=excluded.high_water_sequence,
       projection=excluded.projection,
       rebuilt_at=excluded.rebuilt_at
     where challenge_projection_checkpoints.high_water_sequence<excluded.high_water_sequence`,
    [stage.stage_id, stage.profile_version_id, highWater.id, highWater.sequence, projection],
  );
}

function moneyFromCents(cents: string): string {
  return new OrderDecimal(cents).div(100).toFixed(2);
}

async function activeOrders(database: EventDatabase, stageId: string): Promise<ActiveOrderRow[]> {
  return database.query<ActiveOrderRow>(
    `select paper_order.symbol, paper_order.quantity,
            intent.entry_price, intent.stop_price, intent.desired_risk,
            paper_order.side,
            coalesce(fill.total_quantity,0)::text as filled_quantity,
            coalesce(closure.total_quantity,0)::text as closed_quantity,
            fill.average_price::text as fill_price,
            fill.position_id::text,
            mark.price::text as mark_price,
            exists (
              select 1 from challenge_ledger_events cancelled
               where cancelled.stage_id=paper_order.stage_id
                 and cancelled.type='paper.order.cancelled'
                 and cancelled.payload->>'orderId'=paper_order.id::text
            ) as cancelled
       from challenge_orders paper_order
       join challenge_intents intent on intent.id=paper_order.intent_id
       left join lateral (
         select sum(quantity::numeric) as total_quantity,
                sum(quantity::numeric*price::numeric)/sum(quantity::numeric) as average_price,
                min(position_id::text)::uuid as position_id
            from challenge_fills where order_id=paper_order.id
       ) fill on true
       left join lateral (
         select price
           from challenge_price_marks
          where position_id=fill.position_id
          order by observed_at desc, id desc limit 1
       ) mark on true
       left join lateral (
         select sum(coalesce(closure.quantity::numeric, filled.position_quantity))
                  as total_quantity
           from challenge_position_closures closure
           join (
             select position_id, sum(quantity::numeric) as position_quantity
               from challenge_fills
              where order_id=paper_order.id
              group by position_id
           ) filled on filled.position_id=closure.position_id
       ) closure on true
      where paper_order.stage_id=$1`,
    [stageId],
  );
}

function orderStopRisk(order: ActiveOrderRow): InstanceType<typeof OrderDecimal> {
  const quantity = new OrderDecimal(order.quantity);
  const entry = new OrderDecimal(order.entry_price);
  const stop = new OrderDecimal(order.stop_price);
  const direction = order.side === "BUY" ? "LONG" : "SHORT";
  const pending = new OrderDecimal(order.filled_quantity).isZero();
  if (pending) {
    const assumptions = costedStopAssumptions(
      direction,
      entry,
      stop,
    );
    if (!assumptions) throw new Error("PAPER_INTENT_ACTIVE_ORDER_GEOMETRY_INVALID");
    return stopRiskForQuantity(assumptions, quantity);
  }
  if (order.mark_price === null) throw new Error("PAPER_INTENT_ACTIVE_MARK_REQUIRED");
  const exitSide = order.side === "BUY" ? "SELL" : "BUY";
  const stopFill = new OrderDecimal(calculatePriceFill({
    side: exitSide,
    reference: stop.toFixed(),
  }).result);
  const mark = new OrderDecimal(order.mark_price);
  const remainingQuantity = new OrderDecimal(order.filled_quantity)
    .minus(order.closed_quantity);
  const remainingMove = order.side === "BUY"
    ? mark.minus(stopFill)
    : stopFill.minus(mark);
  return OrderDecimal.max(remainingMove, 0).mul(remainingQuantity)
    .plus(new OrderDecimal(calculateCommission(remainingQuantity.toFixed()).result));
}

function orderOpenLoss(order: ActiveOrderRow): InstanceType<typeof OrderDecimal> {
  if (order.fill_price === null || order.mark_price === null) return new OrderDecimal(0);
  const remainingQuantity = new OrderDecimal(order.filled_quantity)
    .minus(order.closed_quantity);
  if (remainingQuantity.lessThanOrEqualTo(0)) return new OrderDecimal(0);
  const move = new OrderDecimal(order.mark_price).minus(order.fill_price)
    .mul(remainingQuantity);
  const pnl = order.side === "BUY" ? move : move.negated();
  return OrderDecimal.max(pnl.negated(), 0);
}

function orderGrossNotional(order: ActiveOrderRow): InstanceType<typeof OrderDecimal> {
  const pending = new OrderDecimal(order.filled_quantity).isZero();
  if (pending) {
    const fill = calculatePriceFill({ side: order.side, reference: order.entry_price }).result;
    return new OrderDecimal(fill).mul(order.quantity);
  }
  if (order.mark_price === null) throw new Error("PAPER_INTENT_ACTIVE_MARK_REQUIRED");
  return new OrderDecimal(order.mark_price)
    .mul(new OrderDecimal(order.filled_quantity).minus(order.closed_quantity));
}

/**
 * Converts one selected Main/council decision into an immutable paper intent,
 * deterministic rule evaluation, and either one pending simulated order or a rejection.
 */
export async function submitPaperIntent(
  context: MainPaperOrderContext,
  input: SubmitPaperIntentInput,
): Promise<Readonly<PaperIntentResult>> {
  if (!context || typeof context !== "object" || !context.db
    || !mainOrderContexts.has(context)) {
    throw new Error("PAPER_INTENT_CONTEXT_INVALID");
  }
  const captured = captureIntent(input);
  return context.db.transaction(async (transaction) => {
    await transaction.query(
      "select pg_advisory_xact_lock(hashtextextended('gustavo:shared-challenge:paper-intent',0))",
    );
    const stage = await currentStage(transaction);
    await transaction.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [`challenge-stage:${stage.stage_id}`],
    );
    await transaction.one(
      "select id from challenge_stages where id=$1 for update",
      [stage.stage_id],
    );
    const lockedStage = await currentStage(transaction);
    if (lockedStage.stage_id !== stage.stage_id) {
      throw new Error("PAPER_INTENT_CURRENT_STAGE_INVALID");
    }
    const duplicate = await existingIntent(
      transaction,
      stage.challenge_portfolio_id,
      captured.idempotencyKey,
    );
    if (duplicate) {
      if (duplicate.request_digest !== captured.requestDigest) {
        throw new Error("PAPER_INTENT_IDEMPOTENCY_CONFLICT");
      }
      return frozenResult(duplicate);
    }

    const decision = await decisionRow(transaction, captured.sourceDecisionId);
    const observation = await selectedObservation(
      transaction,
      captured.sourceDecisionId,
      captured.symbol,
    );
    const selected = await selectedGeometry(transaction, decision);
    const preRiskReasons: string[] = [];
    if (!decision || decision.result === "NO_PAPER_TRADE" || !decision.selected_candidate_id) {
      preRiskReasons.push("DECISION_NOT_ACTIONABLE");
    } else {
      if (decision.stage_profile_version !== stage.profile_version_id) {
        preRiskReasons.push("DECISION_PROFILE_MISMATCH");
      }
      if (!decision.eligible_instruments.includes(captured.symbol)) {
        preRiskReasons.push("DECISION_SYMBOL_NOT_ELIGIBLE");
      }
      if (decision.total_score === null || decision.total_score < 80
        || !decision.evidence_fresh || !decision.session_valid
        || !decision.geometry_complete || !decision.non_duplicate || !decision.authorized) {
        preRiskReasons.push("DECISION_EVALUATION_NOT_ACTIONABLE");
      }
    }
    if (!captured.geometryComplete) preRiskReasons.push("GEOMETRY_INCOMPLETE");
    if (captured.evaluatedAt >= captured.expiresAt) preRiskReasons.push("INTENT_EXPIRED");
    if (!selected) {
      preRiskReasons.push("SELECTED_THESIS_GEOMETRY_REQUIRED");
    } else if (stable(selected) !== stable({
      symbol: captured.symbol,
      direction: captured.direction,
      entry: captured.entry,
      stop: captured.stop,
      target: captured.target,
      desiredRisk: captured.desiredRisk,
      expiresAt: captured.expiresAt,
    })) {
      preRiskReasons.push("SELECTED_THESIS_GEOMETRY_MISMATCH");
    }
    const marketReason = observationRejection(observation, captured.evaluatedAt);
    if (marketReason) preRiskReasons.push(marketReason);

    const eventsBefore = await storedEvents(transaction, stage.stage_id);
    const highWater = eventsBefore.at(-1);
    if (!highWater) throw new Error("PAPER_INTENT_LEDGER_EMPTY");
    const projection = replayStoredLedgerEvents(eventsBefore);
    const currentOrders = await activeOrders(transaction, stage.stage_id);
    let existingStopRisk = new OrderDecimal(0);
    let existingGrossNotional = new OrderDecimal(0);
    let currentOpenLoss = new OrderDecimal(0);
    let pendingOpenCount = 0;
    let symbolAlreadyActive = false;
    for (const order of currentOrders) {
      const filled = new OrderDecimal(order.filled_quantity);
      const closed = new OrderDecimal(order.closed_quantity);
      const pending = filled.isZero() && !order.cancelled;
      const open = filled.greaterThan(closed);
      if (!pending && !open) continue;
      pendingOpenCount += 1;
      symbolAlreadyActive ||= order.symbol === captured.symbol;
      existingStopRisk = existingStopRisk.plus(orderStopRisk(order));
      existingGrossNotional = existingGrossNotional.plus(orderGrossNotional(order));
      currentOpenLoss = currentOpenLoss.plus(orderOpenLoss(order));
    }
    const evaluatedAt = new Date(captured.evaluatedAt);
    const dayStartAt = Date.UTC(
      evaluatedAt.getUTCFullYear(),
      evaluatedAt.getUTCMonth(),
      evaluatedAt.getUTCDate(),
    );
    const priorDayEvents = eventsBefore.filter(
      (event) => Date.parse(event.occurredAt) < dayStartAt,
    );
    const dayStartProjection = priorDayEvents.some((event) => event.type === "stage.started")
      ? replayStoredLedgerEvents(priorDayEvents)
      : undefined;
    const dayStartEquity = dayStartProjection?.equity
      ?? moneyFromCents(stage.starting_balance_cents);
    const dayStartBalance = dayStartProjection?.balance
      ?? moneyFromCents(stage.starting_balance_cents);
    const realizedDayLoss = OrderDecimal.max(
      new OrderDecimal(dayStartBalance).minus(projection.balance),
      0,
    );
    const proposedStopRisk = captured.proposedStopRisk ?? "0";
    const proposedNotional = captured.proposedNotional ?? "0";
    const postEntryEquity = new OrderDecimal(projection.equity)
      .minus(captured.entryCommission ?? "0");
    if (existingGrossNotional.plus(proposedNotional).greaterThan(postEntryEquity)) {
      preRiskReasons.push("GROSS_NOTIONAL_LIMIT");
    }
    const riskSnapshot = Object.freeze({
      actorType: "MAIN_BRAIN",
      startingBalance: moneyFromCents(stage.starting_balance_cents),
      currentEquity: projection.equity,
      dayStartEquity,
      realizedDayLoss: boundedDecimal(realizedDayLoss),
      openLoss: boundedDecimal(currentOpenLoss),
      existingStopRisk: boundedDecimal(existingStopRisk),
      proposedStopRisk,
      existingGrossNotional: boundedDecimal(existingGrossNotional),
      proposedNotional,
      entryCommission: captured.entryCommission ?? "0",
      postEntryEquity: boundedDecimal(postEntryEquity),
      pendingOpenCount,
      symbolAlreadyActive,
      profileVersionId: stage.profile_version_id,
      ledgerHighWaterId: highWater.id,
    });
    const risk = evaluateRisk(riskSnapshot);
    const reasons = Object.freeze([...new Set([...preRiskReasons, ...risk.reasons])]);
    const accepted = reasons.length === 0;
    const latestTime = await transaction.one<{ occurred_at: Date }>(
      `select occurred_at from challenge_ledger_events
        where id=$1 and stage_id=$2`,
      [highWater.id, stage.stage_id],
    );
    const evidenceTime = observation?.received_at ?? latestTime.occurred_at;
    const occurredAt = new Date(Math.max(
      Date.parse(captured.evaluatedAt),
      evidenceTime.getTime(),
      latestTime.occurred_at.getTime(),
    )).toISOString();
    const intentId = randomUUID();
    const intentEventId = randomUUID();
    const intentEvent = await appendChallengeLedgerEvent({ db: transaction }, {
      id: intentEventId,
      challengePortfolioId: stage.challenge_portfolio_id,
      stageId: stage.stage_id,
      profileVersionId: stage.profile_version_id,
      type: accepted ? "paper.intent.proposed" : "paper.intent.rejected",
      payload: {
        intentId,
        direction: captured.ledgerDirection,
        symbol: captured.symbol,
        entryPrice: captured.entry,
        stopPrice: captured.stop,
        targetPrice: captured.target,
        desiredRisk: captured.desiredRisk,
        expiresAt: captured.expiresAt,
        evaluatedAt: captured.evaluatedAt,
        initialStatus: accepted ? "PROPOSED" : "REJECTED",
        createdAt: occurredAt,
        sourceDecisionId: captured.sourceDecisionId,
        selectionEventId: decision?.selection_event_id ?? null,
        marketObservationId: observation?.id ?? null,
        requestDigest: captured.requestDigest,
      },
      occurredAt,
      actorType: "SYSTEM",
      actorId: "challenge-order-gate",
      idempotencyKey: `paper-intent:${captured.idempotencyKey}`,
    });
    await transaction.query(
      `insert into challenge_intents (
         id, stage_id, profile_version_id, ledger_event_id, symbol, direction,
         entry_price, stop_price, target_price, desired_risk, expires_at,
         initial_status, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [intentId, stage.stage_id, stage.profile_version_id, intentEvent.id,
        captured.symbol, captured.ledgerDirection, captured.entry, captured.stop,
        captured.target, captured.desiredRisk, captured.expiresAt,
        accepted ? "PROPOSED" : "REJECTED", occurredAt],
    );

    const evaluationId = randomUUID();
    const evaluationEvent = await appendChallengeLedgerEvent({ db: transaction }, {
      id: randomUUID(),
      challengePortfolioId: stage.challenge_portfolio_id,
      stageId: stage.stage_id,
      profileVersionId: stage.profile_version_id,
      type: "rule.evaluated",
      payload: {
        evaluationId,
        intentId,
        evaluatedLedgerHighWaterId: highWater.id,
        accepted,
        reasons,
        evaluatedAt: occurredAt,
        profileVersionId: stage.profile_version_id,
        requestDigest: captured.requestDigest,
        riskPolicyVersion: RISK_POLICY_VERSION,
        riskSnapshot,
        decisionProvenance: {
          decisionWindowId: captured.sourceDecisionId,
          selectionEventId: decision?.selection_event_id ?? null,
          selectedCandidateId: decision?.selected_candidate_id ?? null,
          evaluatorRunId: decision?.evaluator_run_id ?? null,
          selectedCandidateEventId: decision?.candidate_event_id ?? null,
          selectedCandidateCommitmentDigest: decision?.candidate_commitment_digest ?? null,
          marketObservationId: observation?.id ?? null,
          marketObservationIds: decision?.market_observation_ids ?? [],
          selectedGeometry: selected ? { ...selected } : null,
        },
      },
      occurredAt,
      actorType: "SYSTEM",
      actorId: "challenge-risk-v1",
      causationId: intentEvent.id,
      correlationId: intentEvent.id,
      idempotencyKey: `paper-risk:${captured.idempotencyKey}`,
    });
    await transaction.query(
      `insert into challenge_rule_evaluations (
         id, stage_id, profile_version_id, ledger_event_id, intent_id,
         evaluated_ledger_high_water_id, accepted, reasons, evaluated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [evaluationId, stage.stage_id, stage.profile_version_id, evaluationEvent.id,
        intentId, highWater.id, accepted, JSON.stringify(reasons), occurredAt],
    );

    let orderId: string | null = null;
    if (accepted) {
      const gate = await transaction.one<{ accepted: boolean }>(
        `select accepted from challenge_rule_evaluations
          where id=$1 and intent_id=$2 and ledger_event_id=$3`,
        [evaluationId, intentId, evaluationEvent.id],
      );
      if (!gate.accepted) throw new Error("PAPER_ORDER_RISK_GATE_REQUIRED");
      orderId = randomUUID();
      const orderEvent = await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(),
        challengePortfolioId: stage.challenge_portfolio_id,
        stageId: stage.stage_id,
        profileVersionId: stage.profile_version_id,
        type: "paper.order.created",
        payload: {
          orderId,
          intentId,
          symbol: captured.symbol,
          side: captured.side,
          quantity: captured.quantity!,
          initialStatus: "PENDING",
          createdAt: occurredAt,
          acceptedRiskEvaluationId: evaluationId,
          requestDigest: captured.requestDigest,
        },
        occurredAt,
        actorType: "SYSTEM",
        actorId: "paper-simulation-worker",
        causationId: evaluationEvent.id,
        correlationId: intentEvent.id,
        idempotencyKey: `paper-order:${captured.idempotencyKey}`,
      });
      await transaction.query(
        `insert into challenge_orders (
           id, intent_id, stage_id, profile_version_id, ledger_event_id,
           symbol, side, quantity, initial_status, created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9)`,
        [orderId, intentId, stage.stage_id, stage.profile_version_id,
          orderEvent.id, captured.symbol, captured.side, captured.quantity!, occurredAt],
      );
    }
    await checkpoint(transaction, stage);
    const result = Object.freeze({
      status: accepted ? "ORDER_CREATED" : "REJECTED",
      accepted,
      intentId,
      evaluationId,
      orderId,
      reasons,
      quantity: accepted ? captured.quantity! : null,
    });
    await evaluateStoredStage(createStageLifecycleContext(transaction), {
      stageId: stage.stage_id,
      evaluatedAt: occurredAt,
    });
    return result;
  });
}

export {
  createPaperWorkerContext,
  processPaperOrder,
  transitionPaperOrder,
} from "../../../worker/challenge/process-order";
export type {
  PaperLifecycleResult,
  PaperWorkerContext,
  ProcessPaperOrderInput,
} from "../../../worker/challenge/process-order";
