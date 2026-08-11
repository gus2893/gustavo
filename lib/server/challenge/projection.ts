import Decimal from "decimal.js";
import { INITIAL_PROFILE } from "./profile";

const LedgerDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_DECIMAL_CHARACTERS = 64;
const MAX_INTEGER_DIGITS = 30;
const MAX_DECIMAL_PLACES = 8;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ZERO = new LedgerDecimal(0);

interface LedgerEventBase {
  readonly id: string;
  readonly profileVersionId?: string;
}

export interface StageStartedEvent extends LedgerEventBase {
  readonly type: "stage.started";
  readonly amount: string;
}

export interface PaperFillCreatedEvent extends LedgerEventBase {
  readonly type: "paper.fill.created";
  readonly positionId: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: string;
  readonly price: string;
  readonly commission: string;
}

export interface PriceMarkRecordedEvent extends LedgerEventBase {
  readonly type: "price.mark.recorded";
  readonly positionId: string;
  readonly price: string;
}

export interface PaperPositionClosedEvent extends LedgerEventBase {
  readonly type: "paper.position.closed";
  readonly positionId: string;
  readonly quantity?: string;
  readonly price: string;
  readonly commission: string;
}

export interface FeeRecordedEvent extends LedgerEventBase {
  readonly type: "fee.recorded";
  readonly amount: string;
}

export interface FinancingRecordedEvent extends LedgerEventBase {
  readonly type: "financing.recorded";
  readonly amount: string;
}

export const REPLAY_NOOP_EVENT_TYPES = Object.freeze([
  "challenge.created",
  "challenge.profile.versioned",
  "challenge.started",
  "challenge.paused",
  "challenge.passed",
  "challenge.failed",
  "challenge.archived",
  "stage.created",
  "stage.passed",
  "stage.failed",
  "stage.advanced",
  "paper.intent.proposed",
  "paper.intent.rejected",
  "paper.order.created",
  "paper.order.cancelled",
  "decision.window.opened",
  "main.baseline.committed",
  "contender.submitted",
  "contender.rejected",
  "review.turn.created",
  "evaluation.scored",
  "decision.selected",
  "pnl.realized",
  "pnl.unrealized.marked",
  "rule.evaluated",
] as const);
const REPLAY_NOOP_EVENT_TYPE_SET: ReadonlySet<string> = new Set(REPLAY_NOOP_EVENT_TYPES);
const REPLAY_PRE_STAGE_EVENT_TYPE_SET: ReadonlySet<string> = new Set([
  "challenge.created",
  "challenge.profile.versioned",
  "challenge.started",
  "stage.created",
]);

export type ReplayNoopEventType = typeof REPLAY_NOOP_EVENT_TYPES[number];

export interface ReplayNoopEvent extends LedgerEventBase {
  readonly type: ReplayNoopEventType;
}

export type ChallengeLedgerEvent =
  | StageStartedEvent
  | PaperFillCreatedEvent
  | PriceMarkRecordedEvent
  | PaperPositionClosedEvent
  | FeeRecordedEvent
  | FinancingRecordedEvent
  | ReplayNoopEvent;

export interface StoredReplayLedgerEvent {
  readonly id: string;
  readonly sequence: string;
  readonly type: string;
  readonly profileVersionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ChallengePositionProjection {
  readonly positionId: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: string;
  readonly averagePrice: string;
  readonly markPrice: string;
  readonly unrealizedPnl: string;
  readonly grossExposure: string;
  readonly netExposure: string;
}

export interface ChallengeProjection {
  readonly balance: string;
  readonly equity: string;
  readonly realizedPnl: string;
  readonly unrealizedPnl: string;
  readonly peakEquity: string;
  readonly grossExposure: string;
  readonly netExposure: string;
  readonly drawdown: string;
  readonly drawdownBps: string;
  readonly openPositions: number;
  readonly highWaterId: string;
  readonly profileVersionId: string;
  readonly positions: readonly ChallengePositionProjection[];
}

interface MutablePosition {
  readonly positionId: string;
  readonly side: "BUY" | "SELL";
  quantity: InstanceType<typeof LedgerDecimal>;
  averagePrice: InstanceType<typeof LedgerDecimal>;
  markPrice: InstanceType<typeof LedgerDecimal>;
}

function invalid(field: string): never {
  throw new Error(`LEDGER_${field}_INVALID`);
}

function decimal(
  raw: string,
  field: string,
  options: { readonly allowZero: boolean },
): InstanceType<typeof LedgerDecimal> {
  if (
    typeof raw !== "string"
    || raw.length > MAX_DECIMAL_CHARACTERS
    || !DECIMAL_PATTERN.test(raw)
  ) {
    return invalid(field);
  }
  const [integerPart, fractionPart = ""] = raw.split(".");
  const integerDigits = integerPart.replace(/^0+/, "").length || 1;
  if (integerDigits > MAX_INTEGER_DIGITS || fractionPart.length > MAX_DECIMAL_PLACES) {
    return invalid(field);
  }
  const parsed = new LedgerDecimal(raw);
  if (!parsed.isFinite() || parsed.isNegative() || (!options.allowZero && parsed.isZero())) {
    return invalid(field);
  }
  return parsed;
}

function eventIdentity(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return invalid("EVENT_ID");
  }
  return value;
}

function positionIdentity(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return invalid("POSITION_ID");
  }
  return value;
}

function money(value: InstanceType<typeof LedgerDecimal>): string {
  const rounded = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return rounded.isZero() ? "0.00" : rounded.toFixed(2);
}

function quantity(value: InstanceType<typeof LedgerDecimal>): string {
  return value.toFixed();
}

function basisPoints(
  amount: InstanceType<typeof LedgerDecimal>,
  base: InstanceType<typeof LedgerDecimal>,
): string {
  if (base.isZero()) return "0.000000000";
  const result = amount.mul(10_000).div(base).toDecimalPlaces(9, Decimal.ROUND_HALF_UP);
  return result.isZero() ? "0.000000000" : result.toFixed(9);
}

function signedPnl(position: MutablePosition, exitOrMarkPrice: InstanceType<typeof LedgerDecimal>) {
  const move = exitOrMarkPrice.minus(position.averagePrice).mul(position.quantity);
  return position.side === "BUY" ? move : move.negated();
}

function profileVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalid("PROFILE_VERSION_ID");
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) return invalid("PROFILE_VERSION_ID");
  return normalized;
}

function storedPayloadString(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  optional = false,
): string | undefined {
  const value = payload[key];
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== "string") throw new Error(`LEDGER_STORED_PAYLOAD_${key.toUpperCase()}_INVALID`);
  return value;
}

function storedReplayEvent(event: StoredReplayLedgerEvent): ChallengeLedgerEvent {
  const id = eventIdentity(event.id);
  const type = event.type;
  const profileVersionId = profileVersion(event.profileVersionId);
  if (profileVersionId === undefined) return invalid("PROFILE_VERSION_ID");
  const common = { id, profileVersionId } as const;

  switch (type) {
    case "stage.started":
      return { ...common, type, amount: storedPayloadString(event.payload, "amount")! };
    case "paper.fill.created": {
      const side = storedPayloadString(event.payload, "side");
      if (side !== "BUY" && side !== "SELL") return invalid("SIDE");
      return {
        ...common,
        type,
        positionId: storedPayloadString(event.payload, "positionId")!,
        side,
        quantity: storedPayloadString(event.payload, "quantity")!,
        price: storedPayloadString(event.payload, "price")!,
        commission: storedPayloadString(event.payload, "commission")!,
      };
    }
    case "price.mark.recorded":
      return {
        ...common,
        type,
        positionId: storedPayloadString(event.payload, "positionId")!,
        price: storedPayloadString(event.payload, "price")!,
      };
    case "paper.position.closed":
      return {
        ...common,
        type,
        positionId: storedPayloadString(event.payload, "positionId")!,
        quantity: storedPayloadString(event.payload, "quantity", true),
        price: storedPayloadString(event.payload, "price")!,
        commission: storedPayloadString(event.payload, "commission")!,
      };
    case "fee.recorded":
    case "financing.recorded":
      return { ...common, type, amount: storedPayloadString(event.payload, "amount")! };
    default:
      if (REPLAY_NOOP_EVENT_TYPE_SET.has(type)) {
        return { ...common, type: type as ReplayNoopEventType };
      }
      throw new Error(`LEDGER_EVENT_TYPE_UNSUPPORTED:${type}`);
  }
}

/** Validates ordered stored envelopes, then replays their canonical payloads. */
export function replayStoredLedgerEvents(
  events: readonly StoredReplayLedgerEvent[],
): ChallengeProjection {
  if (!Array.isArray(events)) throw new Error("LEDGER_EVENTS_INVALID");
  const converted = events.map((event, index) => {
    if (event === null || typeof event !== "object") throw new Error("LEDGER_EVENT_INVALID");
    if (event.sequence !== String(index + 1)) {
      throw new Error("LEDGER_STORED_SEQUENCE_INVALID");
    }
    return storedReplayEvent(event);
  });
  return replayLedger(converted);
}

/**
 * Rebuilds one stage projection solely from already-ordered immutable events.
 * The reducer performs no I/O and retains exact decimal values until its
 * presentation boundary, where USD values are rounded to cents.
 */
export function replayLedger(events: readonly ChallengeLedgerEvent[]): ChallengeProjection {
  if (!Array.isArray(events)) throw new Error("LEDGER_EVENTS_INVALID");

  const seenIds = new Set<string>();
  const positions = new Map<string, MutablePosition>();
  let started = false;
  let startingBalance = ZERO;
  let balance = ZERO;
  let peakEquity = ZERO;
  let highWaterId = "";
  let activeProfileVersionId: string = INITIAL_PROFILE.profileVersionId;
  let preStageProfileVersionId: string | undefined;

  const metrics = () => {
    let unrealizedPnl = ZERO;
    let grossExposure = ZERO;
    let netExposure = ZERO;
    for (const position of positions.values()) {
      const markedNotional = position.markPrice.mul(position.quantity);
      const positionPnl = signedPnl(position, position.markPrice);
      unrealizedPnl = unrealizedPnl.plus(positionPnl);
      grossExposure = grossExposure.plus(markedNotional);
      netExposure = position.side === "BUY"
        ? netExposure.plus(markedNotional)
        : netExposure.minus(markedNotional);
    }
    return { unrealizedPnl, grossExposure, netExposure, equity: balance.plus(unrealizedPnl) };
  };

  for (const event of events) {
    if (event === null || typeof event !== "object") throw new Error("LEDGER_EVENT_INVALID");
    const id = eventIdentity(event.id);
    const type = event.type;
    const eventProfileVersionId = profileVersion(event.profileVersionId);
    if (seenIds.has(id)) throw new Error("LEDGER_EVENT_DUPLICATE");
    seenIds.add(id);
    if (!started) {
      if (eventProfileVersionId !== undefined) {
        if (
          preStageProfileVersionId !== undefined
          && preStageProfileVersionId !== eventProfileVersionId
        ) {
          throw new Error("LEDGER_PROFILE_VERSION_MISMATCH");
        }
        preStageProfileVersionId = eventProfileVersionId;
      }
      if (type === "stage.started") {
        activeProfileVersionId = eventProfileVersionId
          ?? preStageProfileVersionId
          ?? INITIAL_PROFILE.profileVersionId;
      }
    } else if (
      eventProfileVersionId !== undefined
      && eventProfileVersionId !== activeProfileVersionId
    ) {
      throw new Error("LEDGER_PROFILE_VERSION_MISMATCH");
    }

    if (
      !started
      && type !== "stage.started"
      && !REPLAY_PRE_STAGE_EVENT_TYPE_SET.has(type)
    ) {
      throw new Error("LEDGER_STAGE_NOT_STARTED");
    }

    switch (type) {
      case "stage.started": {
        if (started) throw new Error("LEDGER_STAGE_ALREADY_STARTED");
        startingBalance = decimal(event.amount, "AMOUNT", { allowZero: false });
        balance = startingBalance;
        peakEquity = startingBalance;
        started = true;
        break;
      }
      case "paper.fill.created": {
        const positionId = positionIdentity(event.positionId);
        const side = event.side;
        if (side !== "BUY" && side !== "SELL") return invalid("SIDE");
        const fillQuantity = decimal(event.quantity, "QUANTITY", { allowZero: false });
        const price = decimal(event.price, "PRICE", { allowZero: false });
        const commission = decimal(event.commission, "COMMISSION", { allowZero: true });
        const existing = positions.get(positionId);
        if (existing && existing.side !== side) {
          throw new Error("LEDGER_POSITION_SIDE_MISMATCH");
        }
        if (existing) {
          const totalQuantity = existing.quantity.plus(fillQuantity);
          existing.averagePrice = existing.averagePrice.mul(existing.quantity)
            .plus(price.mul(fillQuantity))
            .div(totalQuantity);
          existing.quantity = totalQuantity;
          existing.markPrice = price;
        } else {
          positions.set(positionId, {
            positionId,
            side,
            quantity: fillQuantity,
            averagePrice: price,
            markPrice: price,
          });
        }
        balance = balance.minus(commission);
        break;
      }
      case "price.mark.recorded": {
        const position = positions.get(positionIdentity(event.positionId));
        if (!position) throw new Error("LEDGER_POSITION_NOT_FOUND");
        position.markPrice = decimal(event.price, "PRICE", { allowZero: false });
        break;
      }
      case "paper.position.closed": {
        const positionId = positionIdentity(event.positionId);
        const position = positions.get(positionId);
        if (!position) throw new Error("LEDGER_POSITION_NOT_FOUND");
        const closePrice = decimal(event.price, "PRICE", { allowZero: false });
        const commission = decimal(event.commission, "COMMISSION", { allowZero: true });
        const closeQuantity = event.quantity === undefined
          ? position.quantity
          : decimal(event.quantity, "QUANTITY", { allowZero: false });
        if (closeQuantity.greaterThan(position.quantity)) {
          throw new Error("LEDGER_CLOSE_QUANTITY_EXCEEDS_POSITION");
        }
        const priceMove = closePrice.minus(position.averagePrice).mul(closeQuantity);
        const grossRealized = position.side === "BUY" ? priceMove : priceMove.negated();
        balance = balance.plus(grossRealized).minus(commission);
        position.quantity = position.quantity.minus(closeQuantity);
        position.markPrice = closePrice;
        if (position.quantity.isZero()) positions.delete(positionId);
        break;
      }
      case "fee.recorded":
      case "financing.recorded": {
        balance = balance.minus(decimal(event.amount, "AMOUNT", { allowZero: false }));
        break;
      }
      default: {
        if (!REPLAY_NOOP_EVENT_TYPE_SET.has(type)) {
          throw new Error(`LEDGER_EVENT_TYPE_UNSUPPORTED:${String(type)}`);
        }
      }
    }

    const current = metrics();
    if (current.equity.greaterThan(peakEquity)) peakEquity = current.equity;
    highWaterId = id;
  }

  if (!started) throw new Error("LEDGER_STAGE_NOT_STARTED");
  const current = metrics();
  const realizedPnl = balance.minus(startingBalance);
  const drawdown = LedgerDecimal.max(peakEquity.minus(current.equity), ZERO);
  const projectedPositions = [...positions.values()]
    .sort((left, right) => left.positionId.localeCompare(right.positionId))
    .map((position) => {
      const markedNotional = position.markPrice.mul(position.quantity);
      const unrealizedPnl = signedPnl(position, position.markPrice);
      return Object.freeze({
        positionId: position.positionId,
        side: position.side,
        quantity: quantity(position.quantity),
        averagePrice: money(position.averagePrice),
        markPrice: money(position.markPrice),
        unrealizedPnl: money(unrealizedPnl),
        grossExposure: money(markedNotional),
        netExposure: money(position.side === "BUY" ? markedNotional : markedNotional.negated()),
      });
    });

  return Object.freeze({
    balance: money(balance),
    equity: money(current.equity),
    realizedPnl: money(realizedPnl),
    unrealizedPnl: money(current.unrealizedPnl),
    peakEquity: money(peakEquity),
    grossExposure: money(current.grossExposure),
    netExposure: money(current.netExposure),
    drawdown: money(drawdown),
    drawdownBps: basisPoints(drawdown, peakEquity),
    openPositions: positions.size,
    highWaterId,
    profileVersionId: activeProfileVersionId,
    positions: Object.freeze(projectedPositions),
  });
}
