import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { EventDatabase } from "../../lib/server/events/types";
import { assertChallengeObservation } from "../../lib/server/market-data/policy";
import { createTrustedSourceRegistry } from "../../lib/server/market-data/types";
import {
  calculateCommission,
  calculatePriceFill,
  calculateShortBorrow,
  COST_POLICY_VERSION,
} from "../../lib/server/challenge/costs";
import { appendChallengeLedgerEvent } from "../../lib/server/challenge/ledger";
import {
  replayStoredLedgerEvents,
  type StoredReplayLedgerEvent,
} from "../../lib/server/challenge/projection";

const WorkerDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ProcessPaperOrderInput {
  readonly reference: string;
  readonly observedAt: string;
  readonly evaluatedAt: string;
}

export type PaperLifecycleStatus = "PENDING" | "OPEN" | "CLOSED" | "CANCELLED";
export type PaperExitReason = "TARGET" | "STOP" | "EXPIRED";

export interface PaperLifecycleState {
  readonly status: PaperLifecycleStatus;
  readonly side: "BUY" | "SELL";
  readonly entry: string;
  readonly stop: string;
  readonly target: string;
  readonly expiresAt: string;
}

export interface PaperLifecycleSignal {
  readonly reference: string;
  readonly observedAt: string;
}

export type PaperLifecycleTransition =
  | { readonly action: "NONE"; readonly status: PaperLifecycleStatus }
  | { readonly action: "FILL"; readonly status: "OPEN" }
  | { readonly action: "CANCEL"; readonly status: "CANCELLED" }
  | { readonly action: "CLOSE"; readonly status: "CLOSED"; readonly reason: PaperExitReason };

export interface PaperLifecycleResult {
  readonly status: PaperLifecycleStatus;
  readonly orderId: string;
  readonly positionId: string | null;
  readonly fillPrice: string | null;
  readonly commission: string | null;
  readonly exitReason: PaperExitReason | null;
}

const paperWorkerContexts = new WeakSet<object>();

export interface PaperWorkerContext {
  readonly db: EventDatabase;
  readonly workerId: string;
}

export function createPaperWorkerContext(
  db: EventDatabase,
  workerId = "paper-simulation-worker",
): PaperWorkerContext {
  if (!db || typeof db !== "object" || typeof db.transaction !== "function"
    || typeof workerId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(workerId)) {
    throw new Error("PAPER_ORDER_CONTEXT_INVALID");
  }
  const context = Object.freeze({ db, workerId });
  paperWorkerContexts.add(context);
  return context;
}

interface OrderRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly intent_id: string;
  readonly stage_id: string;
  readonly challenge_portfolio_id: string;
  readonly profile_version_id: string;
  readonly order_event_id: string;
  readonly symbol: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: string;
  readonly entry_price: string;
  readonly stop_price: string;
  readonly target_price: string;
  readonly expires_at: Date;
}

interface ObservationRow extends Record<string, unknown> {
  readonly id: string;
  readonly price: string;
  readonly observed_at: Date;
  readonly provider: string;
  readonly license_id: string;
  readonly licensed: boolean;
  readonly source_redistribution: string;
  readonly redistribution: string;
  readonly session_state: string;
  readonly symbol: string;
  readonly asset_class: "US_STOCK" | "US_ETF";
  readonly received_at: Date;
  readonly raw_source_ref: string;
  readonly feed_status: "REALTIME" | "DELAYED";
  readonly delay_seconds: number;
  readonly enabled: boolean;
  readonly provisional: boolean;
  readonly completed: boolean;
}

interface FillRow extends Record<string, unknown> {
  readonly fill_id: string;
  readonly position_id: string;
  readonly price: string;
  readonly quantity: string;
  readonly filled_at: Date;
  readonly commission: string | null;
}

interface CloseRow extends Record<string, unknown> {
  readonly position_id: string;
  readonly price: string;
  readonly closed_at: Date;
  readonly exit_reason: PaperExitReason | null;
  readonly commission: string | null;
}

interface JobRow extends Record<string, unknown> {
  readonly job_id: string;
  readonly request_digest: string;
  readonly status: "LEASED" | "COMPLETED";
  readonly lease_owner: string;
  readonly lease_active: boolean;
}

interface JobResultRow extends Record<string, unknown> {
  readonly result: PaperLifecycleResult;
  readonly order_id: string;
  readonly market_observation_id: string;
}

function invalid(code: string): never {
  throw new Error(`PAPER_ORDER_${code}`);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalid("ID_INVALID");
  return value.toLowerCase();
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    return invalid("OBSERVATION_TIME_INVALID");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid("OBSERVATION_TIME_INVALID");
  }
  return value;
}

function decimal(value: unknown, code: string): InstanceType<typeof WorkerDecimal> {
  if (typeof value !== "string" || value.length > 64 || !DECIMAL_PATTERN.test(value)) {
    return invalid(code);
  }
  const parsed = new WorkerDecimal(value);
  if (!parsed.isFinite() || parsed.lessThanOrEqualTo(0)) return invalid(code);
  return parsed;
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

function lifecycleResult(values: PaperLifecycleResult): Readonly<PaperLifecycleResult> {
  return Object.freeze({ ...values });
}

function storedLifecycleResult(
  value: unknown,
  expectedOrderId: string,
): Readonly<PaperLifecycleResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("JOB_RESULT_INVALID");
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (stable(keys) !== stable([
    "commission", "exitReason", "fillPrice", "orderId", "positionId", "status",
  ]) || row.orderId !== expectedOrderId
    || !["PENDING", "OPEN", "CLOSED", "CANCELLED"].includes(String(row.status))) {
    return invalid("JOB_RESULT_INVALID");
  }
  if (row.status === "PENDING" || row.status === "CANCELLED") {
    if (row.positionId !== null || row.fillPrice !== null
      || row.commission !== null || row.exitReason !== null) return invalid("JOB_RESULT_INVALID");
  } else {
    uuid(row.positionId);
    decimal(row.fillPrice, "JOB_RESULT_INVALID");
    decimal(row.commission, "JOB_RESULT_INVALID");
    if (row.status === "OPEN" ? row.exitReason !== null
      : !["TARGET", "STOP", "EXPIRED"].includes(String(row.exitReason))) {
      return invalid("JOB_RESULT_INVALID");
    }
  }
  return lifecycleResult(row as unknown as PaperLifecycleResult);
}

/** Pure state transition. Database locking, pricing, and event appends live in the handler below. */
export function transitionPaperOrder(
  state: PaperLifecycleState,
  signal: PaperLifecycleSignal,
): Readonly<PaperLifecycleTransition> {
  if (!state || typeof state !== "object" || !signal || typeof signal !== "object") {
    return invalid("LIFECYCLE_INPUT_INVALID");
  }
  if (!["PENDING", "OPEN", "CLOSED", "CANCELLED"].includes(state.status)
    || (state.side !== "BUY" && state.side !== "SELL")) {
    return invalid("LIFECYCLE_STATE_INVALID");
  }
  const entry = decimal(state.entry, "ENTRY_INVALID");
  const stop = decimal(state.stop, "STOP_INVALID");
  const target = decimal(state.target, "TARGET_INVALID");
  const reference = decimal(signal.reference, "REFERENCE_INVALID");
  const expiresAt = timestamp(state.expiresAt);
  const observedAt = timestamp(signal.observedAt);
  if (state.status === "CLOSED" || state.status === "CANCELLED") {
    return Object.freeze({ action: "NONE", status: state.status });
  }
  if (state.status === "PENDING") {
    if (observedAt >= expiresAt) {
      return Object.freeze({ action: "CANCEL", status: "CANCELLED" });
    }
    const fills = state.side === "BUY"
      ? reference.lessThanOrEqualTo(entry)
      : reference.greaterThanOrEqualTo(entry);
    return fills
      ? Object.freeze({ action: "FILL", status: "OPEN" })
      : Object.freeze({ action: "NONE", status: "PENDING" });
  }
  const stopped = state.side === "BUY"
    ? reference.lessThanOrEqualTo(stop)
    : reference.greaterThanOrEqualTo(stop);
  if (stopped) return Object.freeze({ action: "CLOSE", status: "CLOSED", reason: "STOP" });
  const targeted = state.side === "BUY"
    ? reference.greaterThanOrEqualTo(target)
    : reference.lessThanOrEqualTo(target);
  if (targeted) return Object.freeze({ action: "CLOSE", status: "CLOSED", reason: "TARGET" });
  if (observedAt >= expiresAt) {
    return Object.freeze({ action: "CLOSE", status: "CLOSED", reason: "EXPIRED" });
  }
  return Object.freeze({ action: "NONE", status: "OPEN" });
}

async function orderRow(database: EventDatabase, orderId: string): Promise<OrderRow> {
  const rows = await database.query<OrderRow>(
    `select paper_order.id::text as order_id,
            paper_order.intent_id::text,
            paper_order.stage_id::text,
            stage.challenge_portfolio_id::text,
            paper_order.profile_version_id::text,
            paper_order.ledger_event_id::text as order_event_id,
            paper_order.symbol, paper_order.side, paper_order.quantity,
            intent.entry_price, intent.stop_price, intent.target_price, intent.expires_at
       from challenge_orders paper_order
       join challenge_intents intent on intent.id=paper_order.intent_id
       join challenge_stages stage on stage.id=paper_order.stage_id
      where paper_order.id=$1`,
    [orderId],
  );
  if (!rows[0]) throw new Error("PAPER_ORDER_NOT_FOUND");
  return rows[0];
}

async function observationRow(
  database: EventDatabase,
  order: OrderRow,
  reference: string,
  observedAt: string,
  evaluatedAt: string,
): Promise<ObservationRow> {
  const rows = await database.query<ObservationRow>(
    `select observation.id::text, observation.symbol, observation.asset_class,
            observation.price, observation.observed_at, observation.received_at,
            observation.provider, observation.license_id,
            observation.raw_source_ref, observation.feed_status, observation.delay_seconds,
            source.licensed, source.redistribution as source_redistribution,
            observation.redistribution, observation.session_state,
            instrument.enabled,
            exists (
              select 1 from market_bars bar
               where bar.source_observation_id=observation.id and not bar.completed
            ) as provisional,
            exists (
              select 1 from market_bars bar
               where bar.source_observation_id=observation.id and bar.completed
            ) as completed
       from market_observations observation
       join market_data_sources source
         on source.provider=observation.provider and source.license_id=observation.license_id
       join market_instrument_allowlist instrument
         on instrument.symbol=observation.symbol and instrument.asset_class=observation.asset_class
      where observation.symbol=$1 and observation.price::numeric=$2::numeric
        and observation.observed_at=$3`,
    [order.symbol, reference, observedAt],
  );
  if (rows.length !== 1) throw new Error("PAPER_ORDER_OBSERVATION_INVALID");
  const row = rows[0]!;
  if (!row.enabled) throw new Error("PAPER_ORDER_MARKET_NOT_ALLOWED");
  if (!row.licensed) throw new Error("PAPER_ORDER_MARKET_SOURCE_UNLICENSED");
  if (row.redistribution === "PROHIBITED"
    || row.redistribution !== row.source_redistribution) {
    throw new Error("PAPER_ORDER_MARKET_RIGHTS_INVALID");
  }
  if (row.session_state !== "OPEN") throw new Error("PAPER_ORDER_MARKET_SESSION_CLOSED");
  if (row.provisional) throw new Error("PAPER_ORDER_MARKET_EVIDENCE_PROVISIONAL");
  if (!row.completed) throw new Error("PAPER_ORDER_MARKET_COMPLETED_EVIDENCE_REQUIRED");
  try {
    assertChallengeObservation({
      symbol: row.symbol,
      assetClass: row.asset_class,
      price: row.price,
      observedAt: row.observed_at.toISOString(),
      receivedAt: row.received_at.toISOString(),
      provider: row.provider,
      feedStatus: row.feed_status,
      delaySeconds: row.delay_seconds,
      redistribution: row.redistribution as "PUBLIC" | "ACCOUNT_ONLY" | "INTERNAL_ONLY",
      sessionState: "OPEN",
      licenseStatus: "LICENSED",
      licenseId: row.license_id,
      rawSourceRef: row.raw_source_ref,
    }, {
      asOf: evaluatedAt,
      maxReceiptAgeSeconds: 300,
      allowlist: new Map([[row.symbol, row.asset_class]]),
      sourceRegistry: createTrustedSourceRegistry([{
        provider: row.provider,
        licenseId: row.license_id,
        active: row.licensed,
        redistribution: row.source_redistribution as "PUBLIC" | "ACCOUNT_ONLY" | "INTERNAL_ONLY",
      }]),
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "MARKET_OBSERVATION_INVALID";
    throw new Error(`PAPER_ORDER_${code}`);
  }
  return row;
}

async function observationIdentity(
  database: EventDatabase,
  order: OrderRow,
  reference: string,
  observedAt: string,
): Promise<string> {
  const rows = await database.query<{ readonly id: string } & Record<string, unknown>>(
    `select id::text
       from market_observations
      where symbol=$1 and price::numeric=$2::numeric and observed_at=$3`,
    [order.symbol, reference, observedAt],
  );
  if (rows.length !== 1) throw new Error("PAPER_ORDER_OBSERVATION_INVALID");
  return rows[0]!.id;
}

async function claimJob(
  context: PaperWorkerContext,
  orderId: string,
  reference: string,
  observedAt: string,
  evaluatedAt: string,
): Promise<Readonly<{
  jobId: string;
  observationId: string;
  result?: Readonly<PaperLifecycleResult>;
}>> {
  return context.db.transaction(async (transaction) => {
    const order = await orderRow(transaction, orderId);
    const observationId = await observationIdentity(
      transaction,
      order,
      reference,
      observedAt,
    );
    const requestDigest = digest({ orderId, observationId, evaluatedAt });
    const operationKey = digest({ orderId, observationId });
    let jobs = await transaction.query<JobRow>(
      `select id::text as job_id, request_digest, status, lease_owner,
              leased_until>clock_timestamp() as lease_active
         from challenge_order_jobs
        where order_id=$1 and market_observation_id=$2
        for update`,
      [orderId, observationId],
    );
    let job = jobs[0];
    if (job) {
      if (job.request_digest !== requestDigest) {
        throw new Error("PAPER_ORDER_JOB_IDEMPOTENCY_CONFLICT");
      }
      const resultRows = await transaction.query<JobResultRow>(
        `select result, order_id::text, market_observation_id::text
           from challenge_order_job_results where job_id=$1`,
        [job.job_id],
      );
      if (resultRows[0]) {
        if (resultRows[0].order_id !== orderId
          || resultRows[0].market_observation_id !== observationId) invalid("JOB_RESULT_INVALID");
        return Object.freeze({
          jobId: job.job_id,
          observationId,
          result: storedLifecycleResult(resultRows[0].result, orderId),
        });
      }
    }

    await observationRow(transaction, order, reference, observedAt, evaluatedAt);
    if (!job) {
    const jobId = randomUUID();
      await transaction.query(
        `insert into challenge_order_jobs (
           id, order_id, market_observation_id, operation_key, request_digest,
           status, lease_owner, leased_until, attempts, created_at, updated_at
         ) values ($1,$2,$3,$4,$5,'LEASED',$6,clock_timestamp()+interval '1 minute',
                   1,clock_timestamp(),clock_timestamp())
         on conflict (order_id, market_observation_id) do nothing`,
        [jobId, orderId, observationId, operationKey, requestDigest, context.workerId],
      );
      jobs = await transaction.query<JobRow>(
        `select id::text as job_id, request_digest, status, lease_owner,
                leased_until>clock_timestamp() as lease_active
           from challenge_order_jobs
          where order_id=$1 and market_observation_id=$2
          for update`,
        [orderId, observationId],
      );
      job = jobs[0];
    }
    if (!job) throw new Error("PAPER_ORDER_JOB_CLAIM_FAILED");
    if (job.request_digest !== requestDigest) {
      throw new Error("PAPER_ORDER_JOB_IDEMPOTENCY_CONFLICT");
    }
    const resultRows = await transaction.query<JobResultRow>(
      `select result, order_id::text, market_observation_id::text
         from challenge_order_job_results where job_id=$1`,
      [job.job_id],
    );
    if (resultRows[0]) {
      if (resultRows[0].order_id !== orderId
        || resultRows[0].market_observation_id !== observationId) invalid("JOB_RESULT_INVALID");
      return Object.freeze({
        jobId: job.job_id,
        observationId,
        result: storedLifecycleResult(resultRows[0].result, orderId),
      });
    }
    if (job.lease_active && job.lease_owner !== context.workerId) {
      throw new Error("PAPER_ORDER_JOB_LEASED");
    }
    if (!job.lease_active) {
      await transaction.query(
        `update challenge_order_jobs
            set lease_owner=$2, leased_until=clock_timestamp()+interval '1 minute',
                attempts=attempts+1, updated_at=clock_timestamp()
          where id=$1`,
        [job.job_id, context.workerId],
      );
    }
    return Object.freeze({ jobId: job.job_id, observationId });
  });
}

async function completedJobResult(
  database: EventDatabase,
  jobId: string,
  orderId: string,
  observationId: string,
): Promise<Readonly<PaperLifecycleResult> | undefined> {
  const rows = await database.query<JobResultRow>(
    `select result, order_id::text, market_observation_id::text
       from challenge_order_job_results where job_id=$1`,
    [jobId],
  );
  if (!rows[0]) return undefined;
  if (rows[0].order_id !== orderId || rows[0].market_observation_id !== observationId) {
    return invalid("JOB_RESULT_INVALID");
  }
  return storedLifecycleResult(rows[0].result, orderId);
}

async function completeJob(
  database: EventDatabase,
  jobId: string,
  order: OrderRow,
  observationId: string,
  result: Readonly<PaperLifecycleResult>,
  completedAt: string,
): Promise<void> {
  const highWater = await database.one<{ id: string }>(
    `select id::text from challenge_ledger_events
      where stage_id=$1 order by sequence desc limit 1`,
    [order.stage_id],
  );
  await database.query(
    `insert into challenge_order_job_results (
       job_id, order_id, market_observation_id, result,
       completed_high_water_event_id, completed_at
     ) values ($1,$2,$3,$4,$5,$6)`,
    [jobId, order.order_id, observationId, result, highWater.id, completedAt],
  );
  await database.query(
    `update challenge_order_jobs
        set status='COMPLETED', updated_at=$2, leased_until=$2
      where id=$1 and status='LEASED'`,
    [jobId, completedAt],
  );
}

async function openingFill(database: EventDatabase, orderId: string): Promise<FillRow | undefined> {
  const rows = await database.query<FillRow>(
    `select fill.id::text as fill_id, fill.position_id::text,
            fill.price, fill.quantity, fill.filled_at,
            fee.amount as commission
       from challenge_fills fill
       left join challenge_fees fee on fee.order_id=fill.order_id
        and fee.position_id=fill.position_id and fee.category='COMMISSION'
       join challenge_ledger_events fee_event on fee_event.id=fee.ledger_event_id
        and fee_event.payload->>'phase'='ENTRY'
      where fill.order_id=$1`,
    [orderId],
  );
  if (rows.length > 1) throw new Error("PAPER_ORDER_FILL_STREAM_INVALID");
  return rows[0];
}

async function closeRow(database: EventDatabase, positionId: string): Promise<CloseRow | undefined> {
  const rows = await database.query<CloseRow>(
    `select closure.position_id::text, closure.price, closure.closed_at,
            close_event.payload->>'exitReason' as exit_reason,
            fee.amount as commission
       from challenge_position_closures closure
       join challenge_ledger_events close_event on close_event.id=closure.ledger_event_id
       left join challenge_fees fee on fee.position_id=closure.position_id
        and exists (
          select 1 from challenge_ledger_events fee_event
           where fee_event.id=fee.ledger_event_id
             and fee_event.payload->>'phase'='EXIT'
        )
      where closure.position_id=$1 and closure.quantity is null`,
    [positionId],
  );
  if (rows.length > 1) throw new Error("PAPER_ORDER_EXIT_STREAM_INVALID");
  return rows[0];
}

async function cancelled(database: EventDatabase, orderId: string): Promise<boolean> {
  const row = await database.one<{ cancelled: boolean }>(
    `select exists (
       select 1 from challenge_ledger_events
        where type='paper.order.cancelled' and payload->>'orderId'=$1
     ) as cancelled`,
    [orderId],
  );
  return row.cancelled;
}

async function appendMark(
  database: EventDatabase,
  order: OrderRow,
  positionId: string,
  observation: ObservationRow,
  observedAt: string,
): Promise<void> {
  const prior = await database.query(
    `select 1 from challenge_price_marks
      where position_id=$1 and market_observation_id=$2`,
    [positionId, observation.id],
  );
  if (prior[0]) return;
  const markId = randomUUID();
  const event = await appendChallengeLedgerEvent({ db: database }, {
    id: randomUUID(),
    challengePortfolioId: order.challenge_portfolio_id,
    stageId: order.stage_id,
    profileVersionId: order.profile_version_id,
    type: "price.mark.recorded",
    payload: {
      markId,
      positionId,
      marketObservationId: observation.id,
      price: observation.price,
      observedAt: observation.observed_at.toISOString(),
      recordedAt: observedAt,
      provider: observation.provider,
      licenseId: observation.license_id,
    },
    occurredAt: observedAt,
    actorType: "SYSTEM",
    actorId: "paper-simulation-worker",
    idempotencyKey: `paper-mark:${positionId}:${observation.id}`,
    correlationId: order.intent_id,
  });
  await database.query(
    `insert into challenge_price_marks (
       id, position_id, stage_id, profile_version_id, ledger_event_id,
       market_observation_id, price, observed_at, recorded_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [markId, positionId, order.stage_id, order.profile_version_id, event.id,
      observation.id, observation.price, observation.observed_at.toISOString(), observedAt],
  );
}

async function appendCommission(
  database: EventDatabase,
  order: OrderRow,
  positionId: string,
  amount: string,
  phase: "ENTRY" | "EXIT",
  observedAt: string,
  causeId: string,
): Promise<void> {
  const feeId = randomUUID();
  const event = await appendChallengeLedgerEvent({ db: database }, {
    id: randomUUID(),
    challengePortfolioId: order.challenge_portfolio_id,
    stageId: order.stage_id,
    profileVersionId: order.profile_version_id,
    type: "fee.recorded",
    payload: {
      feeId,
      positionId,
      orderId: order.order_id,
      amount,
      category: "COMMISSION",
      recordedAt: observedAt,
      phase,
      policyVersion: COST_POLICY_VERSION,
    },
    occurredAt: observedAt,
    actorType: "SYSTEM",
    actorId: "paper-simulation-worker",
    idempotencyKey: `paper-fee:${order.order_id}:${phase}`,
    causationId: causeId,
    correlationId: order.intent_id,
  });
  await database.query(
    `insert into challenge_fees (
       id, stage_id, profile_version_id, ledger_event_id,
       position_id, order_id, amount, category, recorded_at
     ) values ($1,$2,$3,$4,$5,$6,$7,'COMMISSION',$8)`,
    [feeId, order.stage_id, order.profile_version_id, event.id,
      positionId, order.order_id, amount, observedAt],
  );
}

function utcDay(value: Date): number {
  return Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / 86_400_000);
}

async function appendFinancing(
  database: EventDatabase,
  order: OrderRow,
  fill: FillRow,
  observedAt: string,
): Promise<void> {
  if (order.side !== "SELL") return;
  const prior = await database.one<{ days: number }>(
    `select coalesce(sum(utc_days),0)::int as days
       from challenge_financing where position_id=$1`,
    [fill.position_id],
  );
  const elapsed = Math.max(0, utcDay(new Date(observedAt)) - utcDay(fill.filled_at));
  const utcDays = elapsed - prior.days;
  if (utcDays <= 0) return;
  const shortNotional = new WorkerDecimal(fill.price)
    .mul(fill.quantity)
    .toDecimalPlaces(8, Decimal.ROUND_HALF_UP)
    .toFixed();
  const amount = calculateShortBorrow({
    shortNotional,
    utcDays,
  }).result;
  if (amount === "0.00") return;
  const financingId = randomUUID();
  const event = await appendChallengeLedgerEvent({ db: database }, {
    id: randomUUID(),
    challengePortfolioId: order.challenge_portfolio_id,
    stageId: order.stage_id,
    profileVersionId: order.profile_version_id,
    type: "financing.recorded",
    payload: {
      financingId,
      positionId: fill.position_id,
      amount,
      utcDays,
      policyVersion: COST_POLICY_VERSION,
      recordedAt: observedAt,
    },
    occurredAt: observedAt,
    actorType: "SYSTEM",
    actorId: "paper-simulation-worker",
    idempotencyKey: `paper-financing:${fill.position_id}:${elapsed}`,
    correlationId: order.intent_id,
  });
  await database.query(
    `insert into challenge_financing (
       id, stage_id, profile_version_id, ledger_event_id,
       position_id, amount, utc_days, policy_version, recorded_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [financingId, order.stage_id, order.profile_version_id, event.id,
      fill.position_id, amount, utcDays, COST_POLICY_VERSION, observedAt],
  );
}

async function checkpoint(database: EventDatabase, order: OrderRow): Promise<void> {
  const events = await database.query<StoredReplayLedgerEvent & Record<string, unknown>>(
    `select id::text, sequence::text, type,
            profile_version_id::text as "profileVersionId", payload
       from challenge_ledger_events
      where stage_id=$1
      order by challenge_ledger_events.sequence, challenge_ledger_events.id`,
    [order.stage_id],
  );
  const highWater = events.at(-1);
  if (!highWater) throw new Error("PAPER_ORDER_LEDGER_EMPTY");
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
    [order.stage_id, order.profile_version_id, highWater.id, highWater.sequence, projection],
  );
}

async function appendOpeningFill(
  database: EventDatabase,
  order: OrderRow,
  observation: ObservationRow,
  observedAt: string,
): Promise<FillRow> {
  const price = calculatePriceFill({ side: order.side, reference: observation.price });
  const commission = calculateCommission(order.quantity);
  const positionId = randomUUID();
  const fillId = randomUUID();
  const fillEvent = await appendChallengeLedgerEvent({ db: database }, {
    id: randomUUID(),
    challengePortfolioId: order.challenge_portfolio_id,
    stageId: order.stage_id,
    profileVersionId: order.profile_version_id,
    type: "paper.fill.created",
    payload: {
      fillId,
      orderId: order.order_id,
      positionId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: price.result,
      commission: "0.00",
      openedAt: observedAt,
      filledAt: observedAt,
      marketObservationId: observation.id,
      costPolicyVersion: price.policyVersion,
      spread: price.components.spread,
      slippage: price.components.slippage,
    },
    occurredAt: observedAt,
    actorType: "SYSTEM",
    actorId: "paper-simulation-worker",
    idempotencyKey: `paper-fill:${order.order_id}`,
    causationId: order.order_event_id,
    correlationId: order.intent_id,
  });
  await database.query(
    `insert into challenge_positions (
       id, stage_id, profile_version_id, opening_ledger_event_id,
       symbol, side, opened_at
     ) values ($1,$2,$3,$4,$5,$6,$7)`,
    [positionId, order.stage_id, order.profile_version_id,
      fillEvent.id, order.symbol, order.side, observedAt],
  );
  await database.query(
    `insert into challenge_fills (
       id, order_id, position_id, stage_id, profile_version_id,
       ledger_event_id, side, quantity, price, commission, filled_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'0.00',$10)`,
    [fillId, order.order_id, positionId, order.stage_id, order.profile_version_id,
      fillEvent.id, order.side, order.quantity, price.result, observedAt],
  );
  await appendMark(database, order, positionId, observation, observedAt);
  await appendCommission(
    database,
    order,
    positionId,
    commission.result,
    "ENTRY",
    observedAt,
    fillEvent.id,
  );
  return {
    fill_id: fillId,
    position_id: positionId,
    price: price.result,
    quantity: order.quantity,
    filled_at: new Date(observedAt),
    commission: commission.result,
  };
}

async function appendClose(
  database: EventDatabase,
  order: OrderRow,
  fill: FillRow,
  reason: PaperExitReason,
  observation: ObservationRow,
  observedAt: string,
): Promise<Readonly<PaperLifecycleResult>> {
  const exitSide = order.side === "BUY" ? "SELL" : "BUY";
  const price = calculatePriceFill({ side: exitSide, reference: observation.price });
  const commission = calculateCommission(fill.quantity);
  const closureId = randomUUID();
  const closeEvent = await appendChallengeLedgerEvent({ db: database }, {
    id: randomUUID(),
    challengePortfolioId: order.challenge_portfolio_id,
    stageId: order.stage_id,
    profileVersionId: order.profile_version_id,
    type: "paper.position.closed",
    payload: {
      closureId,
      positionId: fill.position_id,
      quantity: null,
      price: price.result,
      commission: "0.00",
      closedAt: observedAt,
      exitReason: reason,
      marketObservationId: observation.id,
      costPolicyVersion: price.policyVersion,
      spread: price.components.spread,
      slippage: price.components.slippage,
    },
    occurredAt: observedAt,
    actorType: "SYSTEM",
    actorId: "paper-simulation-worker",
    idempotencyKey: `paper-close:${order.order_id}`,
    correlationId: order.intent_id,
  });
  await database.query(
    `insert into challenge_position_closures (
       id, position_id, stage_id, profile_version_id, ledger_event_id,
       quantity, price, commission, closed_at
     ) values ($1,$2,$3,$4,$5,null,$6,'0.00',$7)`,
    [closureId, fill.position_id, order.stage_id, order.profile_version_id,
      closeEvent.id, price.result, observedAt],
  );
  await appendCommission(
    database,
    order,
    fill.position_id,
    commission.result,
    "EXIT",
    observedAt,
    closeEvent.id,
  );
  return lifecycleResult({
    status: "CLOSED",
    orderId: order.order_id,
    positionId: fill.position_id,
    fillPrice: price.result,
    commission: commission.result,
    exitReason: reason,
  });
}

/**
 * Local-only simulation worker. The stage/order locks are its lease; immutable
 * lifecycle keys and source-table constraints make every retry exact.
 */
export async function processPaperOrder(
  context: PaperWorkerContext,
  rawOrderId: string,
  input: ProcessPaperOrderInput,
): Promise<Readonly<PaperLifecycleResult>> {
  if (!context || typeof context !== "object" || !context.db
    || !paperWorkerContexts.has(context)
    || !input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("PAPER_ORDER_CONTEXT_INVALID");
  }
  const captured = {
    reference: input.reference,
    observedAt: input.observedAt,
    evaluatedAt: input.evaluatedAt,
  };
  const orderId = uuid(rawOrderId);
  const reference = decimal(captured.reference, "REFERENCE_INVALID").toFixed();
  const observedAt = timestamp(captured.observedAt);
  const evaluatedAt = timestamp(captured.evaluatedAt);
  const claimed = await claimJob(context, orderId, reference, observedAt, evaluatedAt);
  if (claimed.result) return claimed.result;
  return context.db.transaction(async (transaction) => {
    await transaction.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [`paper-order:${orderId}`],
    );
    const storedResult = await completedJobResult(
      transaction,
      claimed.jobId,
      orderId,
      claimed.observationId,
    );
    if (storedResult) return storedResult;
    const order = await orderRow(transaction, orderId);
    await transaction.one("select id from challenge_stages where id=$1 for update", [order.stage_id]);
    const observation = await observationRow(
      transaction,
      order,
      reference,
      observedAt,
      evaluatedAt,
    );
    const latest = await transaction.one<{ occurred_at: Date }>(
      `select occurred_at from challenge_ledger_events
        where stage_id=$1 order by sequence desc limit 1`,
      [order.stage_id],
    );
    if (latest.occurred_at.getTime() > Date.parse(evaluatedAt)) {
      throw new Error("PAPER_ORDER_OBSERVATION_OUT_OF_ORDER");
    }

    const priorFill = await openingFill(transaction, orderId);
    if (priorFill) {
      const priorClose = await closeRow(transaction, priorFill.position_id);
      if (priorClose) {
        const result = lifecycleResult({
          status: "CLOSED",
          orderId,
          positionId: priorFill.position_id,
          fillPrice: priorClose.price,
          commission: priorClose.commission,
          exitReason: priorClose.exit_reason,
        });
        await completeJob(
          transaction, claimed.jobId, order, claimed.observationId, result, evaluatedAt,
        );
        return result;
      }
    } else if (await cancelled(transaction, orderId)) {
      const result = lifecycleResult({
        status: "CANCELLED",
        orderId,
        positionId: null,
        fillPrice: null,
        commission: null,
        exitReason: null,
      });
      await completeJob(
        transaction, claimed.jobId, order, claimed.observationId, result, evaluatedAt,
      );
      return result;
    }

    const transition = transitionPaperOrder({
      status: priorFill ? "OPEN" : "PENDING",
      side: order.side,
      entry: order.entry_price,
      stop: order.stop_price,
      target: order.target_price,
      expiresAt: order.expires_at.toISOString(),
    }, { reference, observedAt: evaluatedAt });

    if (transition.action === "CANCEL") {
      await appendChallengeLedgerEvent({ db: transaction }, {
        id: randomUUID(),
        challengePortfolioId: order.challenge_portfolio_id,
        stageId: order.stage_id,
        profileVersionId: order.profile_version_id,
        type: "paper.order.cancelled",
        payload: { orderId, reason: "EXPIRED", cancelledAt: evaluatedAt },
        occurredAt: evaluatedAt,
        actorType: "SYSTEM",
        actorId: "paper-simulation-worker",
        idempotencyKey: `paper-cancel:${orderId}`,
        causationId: order.order_event_id,
        correlationId: order.intent_id,
      });
      await checkpoint(transaction, order);
      const result = lifecycleResult({
        status: "CANCELLED",
        orderId,
        positionId: null,
        fillPrice: null,
        commission: null,
        exitReason: null,
      });
      await completeJob(
        transaction, claimed.jobId, order, claimed.observationId, result, evaluatedAt,
      );
      return result;
    }

    if (!priorFill && transition.action === "NONE") {
      const result = lifecycleResult({
        status: "PENDING",
        orderId,
        positionId: null,
        fillPrice: null,
        commission: null,
        exitReason: null,
      });
      await completeJob(
        transaction, claimed.jobId, order, claimed.observationId, result, evaluatedAt,
      );
      return result;
    }

    const fill = priorFill ?? await appendOpeningFill(
      transaction,
      order,
      observation,
      evaluatedAt,
    );
    if (priorFill) {
      await appendMark(transaction, order, fill.position_id, observation, evaluatedAt);
      await appendFinancing(transaction, order, fill, evaluatedAt);
    }

    let result: Readonly<PaperLifecycleResult>;
    const openTransition = priorFill ? transition : transitionPaperOrder({
      status: "OPEN",
      side: order.side,
      entry: order.entry_price,
      stop: order.stop_price,
      target: order.target_price,
      expiresAt: order.expires_at.toISOString(),
    }, { reference, observedAt: evaluatedAt });
    if (openTransition.action === "CLOSE") {
      result = await appendClose(
        transaction,
        order,
        fill,
        openTransition.reason,
        observation,
        evaluatedAt,
      );
    } else {
      result = lifecycleResult({
        status: "OPEN",
        orderId,
        positionId: fill.position_id,
        fillPrice: fill.price,
        commission: fill.commission,
        exitReason: null,
      });
    }
    await checkpoint(transaction, order);
    await completeJob(
      transaction, claimed.jobId, order, claimed.observationId, result, evaluatedAt,
    );
    return result;
  });
}
