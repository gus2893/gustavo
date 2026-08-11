import Decimal from "decimal.js";
import { INITIAL_PROFILE } from "./profile";

const RiskDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});

const DECIMAL_INPUT_PATTERN = /^\d+(?:\.\d+)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_INPUT_CHARACTERS = 64;
const MAX_INTEGER_DIGITS = 30;
const MAX_DECIMAL_PLACES = 8;
const BASIS_POINT_DENOMINATOR = new RiskDecimal("10000");
const ZERO = new RiskDecimal(0);

export type ChallengeRiskActor = "MAIN_BRAIN" | "NODE_BRAIN";

export type RiskRejectionReason =
  | "UNAUTHORIZED_CHALLENGE_ACTOR"
  | "DAILY_LOSS_LIMIT"
  | "OVERALL_LOSS_LIMIT"
  | "POSITION_RISK_LIMIT"
  | "PORTFOLIO_RISK_LIMIT"
  | "GROSS_NOTIONAL_LIMIT"
  | "POSITION_COUNT_LIMIT"
  | "SYMBOL_DUPLICATE";

export interface RiskEvaluationInput {
  readonly actorType: ChallengeRiskActor;
  readonly startingBalance: string;
  readonly currentEquity: string;
  readonly dayStartEquity: string;
  readonly realizedDayLoss: string;
  readonly openLoss: string;
  readonly existingStopRisk: string;
  readonly proposedStopRisk: string;
  readonly existingGrossNotional: string;
  readonly proposedNotional: string;
  readonly pendingOpenCount: number;
  readonly symbolAlreadyActive: boolean;
  readonly profileVersionId?: string;
  readonly ledgerHighWaterId?: string;
}

export interface RiskEvaluationProvenance {
  readonly profileVersionId: string;
  readonly ledgerHighWaterId: string;
}

export interface RiskEvaluation {
  readonly accepted: boolean;
  readonly reasons: readonly RiskRejectionReason[];
  readonly provenance?: Readonly<RiskEvaluationProvenance>;
}

interface CapturedRiskInput {
  readonly actorType: unknown;
  readonly startingBalance: unknown;
  readonly currentEquity: unknown;
  readonly dayStartEquity: unknown;
  readonly realizedDayLoss: unknown;
  readonly openLoss: unknown;
  readonly existingStopRisk: unknown;
  readonly proposedStopRisk: unknown;
  readonly existingGrossNotional: unknown;
  readonly proposedNotional: unknown;
  readonly pendingOpenCount: unknown;
  readonly symbolAlreadyActive: unknown;
  readonly profileVersionId: unknown;
  readonly ledgerHighWaterId: unknown;
}

interface ParsedRiskSnapshot {
  readonly actorType: ChallengeRiskActor;
  readonly startingBalance: InstanceType<typeof RiskDecimal>;
  readonly currentEquity: InstanceType<typeof RiskDecimal>;
  readonly dayStartEquity: InstanceType<typeof RiskDecimal>;
  readonly realizedDayLoss: InstanceType<typeof RiskDecimal>;
  readonly openLoss: InstanceType<typeof RiskDecimal>;
  readonly existingStopRisk: InstanceType<typeof RiskDecimal>;
  readonly proposedStopRisk: InstanceType<typeof RiskDecimal>;
  readonly existingGrossNotional: InstanceType<typeof RiskDecimal>;
  readonly proposedNotional: InstanceType<typeof RiskDecimal>;
  readonly pendingOpenCount: number;
  readonly symbolAlreadyActive: boolean;
}

interface RiskLimits {
  readonly dailyLoss: InstanceType<typeof RiskDecimal>;
  readonly overallFloor: InstanceType<typeof RiskDecimal>;
  readonly positionRisk: InstanceType<typeof RiskDecimal>;
  readonly portfolioRisk: InstanceType<typeof RiskDecimal>;
  readonly grossNotional: InstanceType<typeof RiskDecimal>;
}

interface RiskPredicateContext {
  readonly snapshot: ParsedRiskSnapshot;
  readonly limits: RiskLimits;
}

interface NamedRiskPredicate {
  readonly reason: RiskRejectionReason;
  readonly rejects: (context: RiskPredicateContext) => boolean;
}

function invalidInput(field: string): never {
  throw new Error(`RISK_${field}_INVALID`);
}

function captureInput(input: RiskEvaluationInput): CapturedRiskInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalidInput("INPUT");
  }

  return Object.freeze({
    actorType: input.actorType,
    startingBalance: input.startingBalance,
    currentEquity: input.currentEquity,
    dayStartEquity: input.dayStartEquity,
    realizedDayLoss: input.realizedDayLoss,
    openLoss: input.openLoss,
    existingStopRisk: input.existingStopRisk,
    proposedStopRisk: input.proposedStopRisk,
    existingGrossNotional: input.existingGrossNotional,
    proposedNotional: input.proposedNotional,
    pendingOpenCount: input.pendingOpenCount,
    symbolAlreadyActive: input.symbolAlreadyActive,
    profileVersionId: input.profileVersionId,
    ledgerHighWaterId: input.ledgerHighWaterId,
  });
}

function parseDecimalInput(
  raw: unknown,
  field: string,
  allowZero: boolean,
): InstanceType<typeof RiskDecimal> {
  if (
    typeof raw !== "string"
    || raw.length > MAX_INPUT_CHARACTERS
    || !DECIMAL_INPUT_PATTERN.test(raw)
  ) {
    return invalidInput(field);
  }

  const [integerPart, fractionPart = ""] = raw.split(".");
  const significantIntegerDigits = integerPart.replace(/^0+/, "").length || 1;
  if (
    significantIntegerDigits > MAX_INTEGER_DIGITS
    || fractionPart.length > MAX_DECIMAL_PLACES
  ) {
    return invalidInput(field);
  }

  const value = new RiskDecimal(raw);
  if (!value.isFinite() || value.isNegative() || (!allowZero && value.isZero())) {
    return invalidInput(field);
  }
  return value;
}

function parseActor(value: unknown): ChallengeRiskActor {
  if (value !== "MAIN_BRAIN" && value !== "NODE_BRAIN") {
    return invalidInput("ACTOR_TYPE");
  }
  return value;
}

function parseCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidInput("POSITION_COUNT");
  }
  return value;
}

function parseSymbolActive(value: unknown): boolean {
  if (typeof value !== "boolean") {
    return invalidInput("SYMBOL_ACTIVE");
  }
  return value;
}

function normalizeUuid(value: unknown, field: string): string {
  if (typeof value !== "string") return invalidInput(field);
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) return invalidInput(field);
  return normalized;
}

function provenanceFrom(input: CapturedRiskInput): Readonly<RiskEvaluationProvenance> | undefined {
  const hasProfileVersion = input.profileVersionId !== undefined;
  const hasLedgerHighWater = input.ledgerHighWaterId !== undefined;
  if (!hasProfileVersion && !hasLedgerHighWater) return undefined;
  if (!hasProfileVersion || !hasLedgerHighWater) {
    throw new Error("RISK_PROVENANCE_INCOMPLETE");
  }

  const profileVersionId = normalizeUuid(input.profileVersionId, "PROFILE_VERSION_ID");
  const ledgerHighWaterId = normalizeUuid(input.ledgerHighWaterId, "LEDGER_HIGH_WATER_ID");
  if (profileVersionId !== INITIAL_PROFILE.profileVersionId) {
    throw new Error("RISK_PROFILE_VERSION_MISMATCH");
  }

  return Object.freeze({ profileVersionId, ledgerHighWaterId });
}

function parseSnapshot(input: CapturedRiskInput): ParsedRiskSnapshot {
  return Object.freeze({
    actorType: parseActor(input.actorType),
    startingBalance: parseDecimalInput(input.startingBalance, "STARTING_BALANCE", false),
    currentEquity: parseDecimalInput(input.currentEquity, "CURRENT_EQUITY", true),
    dayStartEquity: parseDecimalInput(input.dayStartEquity, "DAY_START_EQUITY", true),
    realizedDayLoss: parseDecimalInput(input.realizedDayLoss, "REALIZED_DAY_LOSS", true),
    openLoss: parseDecimalInput(input.openLoss, "OPEN_LOSS", true),
    existingStopRisk: parseDecimalInput(input.existingStopRisk, "EXISTING_STOP_RISK", true),
    proposedStopRisk: parseDecimalInput(input.proposedStopRisk, "PROPOSED_STOP_RISK", true),
    existingGrossNotional: parseDecimalInput(
      input.existingGrossNotional,
      "EXISTING_GROSS_NOTIONAL",
      true,
    ),
    proposedNotional: parseDecimalInput(input.proposedNotional, "PROPOSED_NOTIONAL", true),
    pendingOpenCount: parseCount(input.pendingOpenCount),
    symbolAlreadyActive: parseSymbolActive(input.symbolAlreadyActive),
  });
}

function validateSnapshotConsistency(snapshot: ParsedRiskSnapshot): void {
  if (
    snapshot.pendingOpenCount === 0
    && (
      snapshot.openLoss.greaterThan(ZERO)
      || snapshot.existingStopRisk.greaterThan(ZERO)
      || snapshot.existingGrossNotional.greaterThan(ZERO)
      || snapshot.symbolAlreadyActive
    )
  ) {
    throw new Error("RISK_SNAPSHOT_INCONSISTENT");
  }
}

function basisPointValue(
  value: InstanceType<typeof RiskDecimal>,
  basisPoints: number,
): InstanceType<typeof RiskDecimal> {
  return value.mul(new RiskDecimal(basisPoints.toString())).div(BASIS_POINT_DENOMINATOR);
}

function limitsFor(snapshot: ParsedRiskSnapshot): RiskLimits {
  return Object.freeze({
    dailyLoss: basisPointValue(snapshot.startingBalance, INITIAL_PROFILE.dailyLossLimitBps),
    overallFloor: snapshot.startingBalance.minus(
      basisPointValue(snapshot.startingBalance, INITIAL_PROFILE.overallLossLimitBps),
    ),
    positionRisk: basisPointValue(
      snapshot.startingBalance,
      INITIAL_PROFILE.positionRiskLimitBps,
    ),
    portfolioRisk: basisPointValue(
      snapshot.startingBalance,
      INITIAL_PROFILE.portfolioRiskLimitBps,
    ),
    grossNotional: basisPointValue(
      snapshot.currentEquity,
      INITIAL_PROFILE.maxGrossLeverageBps,
    ),
  });
}

function dailyLoss(snapshot: ParsedRiskSnapshot): InstanceType<typeof RiskDecimal> {
  return RiskDecimal.max(snapshot.dayStartEquity.minus(snapshot.currentEquity), ZERO);
}

function aggregateRisk(snapshot: ParsedRiskSnapshot): InstanceType<typeof RiskDecimal> {
  return snapshot.realizedDayLoss
    .plus(snapshot.openLoss)
    .plus(snapshot.existingStopRisk)
    .plus(snapshot.proposedStopRisk);
}

function aggregateGrossNotional(snapshot: ParsedRiskSnapshot): InstanceType<typeof RiskDecimal> {
  return snapshot.existingGrossNotional.plus(snapshot.proposedNotional);
}

function unauthorizedChallengeActor({ snapshot }: RiskPredicateContext): boolean {
  return snapshot.actorType !== "MAIN_BRAIN";
}

function dailyLossLimit({ snapshot, limits }: RiskPredicateContext): boolean {
  return dailyLoss(snapshot).greaterThanOrEqualTo(limits.dailyLoss);
}

function overallLossLimit({ snapshot, limits }: RiskPredicateContext): boolean {
  return snapshot.currentEquity.lessThanOrEqualTo(limits.overallFloor);
}

function positionRiskLimit({ snapshot, limits }: RiskPredicateContext): boolean {
  return snapshot.proposedStopRisk.greaterThan(limits.positionRisk);
}

function portfolioRiskLimit({ snapshot, limits }: RiskPredicateContext): boolean {
  return aggregateRisk(snapshot).greaterThan(limits.portfolioRisk);
}

function grossNotionalLimit({ snapshot, limits }: RiskPredicateContext): boolean {
  return aggregateGrossNotional(snapshot).greaterThan(limits.grossNotional);
}

function positionCountLimit({ snapshot }: RiskPredicateContext): boolean {
  return snapshot.pendingOpenCount >= INITIAL_PROFILE.maximumPositions;
}

function symbolDuplicate({ snapshot }: RiskPredicateContext): boolean {
  return snapshot.symbolAlreadyActive;
}

const RISK_PREDICATES = Object.freeze([
  { reason: "UNAUTHORIZED_CHALLENGE_ACTOR", rejects: unauthorizedChallengeActor },
  { reason: "DAILY_LOSS_LIMIT", rejects: dailyLossLimit },
  { reason: "OVERALL_LOSS_LIMIT", rejects: overallLossLimit },
  { reason: "POSITION_RISK_LIMIT", rejects: positionRiskLimit },
  { reason: "PORTFOLIO_RISK_LIMIT", rejects: portfolioRiskLimit },
  { reason: "GROSS_NOTIONAL_LIMIT", rejects: grossNotionalLimit },
  { reason: "POSITION_COUNT_LIMIT", rejects: positionCountLimit },
  { reason: "SYMBOL_DUPLICATE", rejects: symbolDuplicate },
] as const satisfies readonly NamedRiskPredicate[]);

/**
 * Evaluates the published Challenge v1 gates against one captured ledger snapshot.
 * Malformed trust-boundary inputs throw deterministic errors; valid policy failures
 * return every rejection reason and cannot be overridden by model-owned metadata.
 */
export function evaluateRisk(input: RiskEvaluationInput): Readonly<RiskEvaluation> {
  const captured = captureInput(input);
  const provenance = provenanceFrom(captured);
  const snapshot = parseSnapshot(captured);
  validateSnapshotConsistency(snapshot);
  const context = Object.freeze({ snapshot, limits: limitsFor(snapshot) });
  const reasons = Object.freeze(
    RISK_PREDICATES
      .filter((predicate) => predicate.rejects(context))
      .map((predicate) => predicate.reason),
  );

  return Object.freeze({
    accepted: reasons.length === 0,
    reasons,
    ...(provenance === undefined ? {} : { provenance }),
  });
}
