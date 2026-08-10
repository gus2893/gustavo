import Decimal from "decimal.js";
import { INITIAL_PROFILE } from "./profile";

const CostDecimal = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});

const DECIMAL_INPUT_PATTERN = /^\d+(?:\.\d+)?$/;
const MAX_INPUT_CHARACTERS = 64;
const MAX_INTEGER_DIGITS = 30;
const MAX_DECIMAL_PLACES = 8;
const COMMISSION_PER_SHARE = new CostDecimal("0.005");
const MINIMUM_COMMISSION = new CostDecimal("1.00");
const ADVERSE_HALF_SPREAD_RATE = new CostDecimal("0.0005");
const ADVERSE_SLIPPAGE_RATE = new CostDecimal("0.0005");
const ANNUAL_SHORT_BORROW_RATE = new CostDecimal("0.05");
const UTC_DAYS_PER_YEAR = new CostDecimal("365");
const ZERO_MONEY = "0.00";

export const COST_POLICY_VERSION = INITIAL_PROFILE.costPolicyVersion;

export type SimulationSide = "BUY" | "SELL";
export type CostCalculationKind = "COMMISSION" | "PRICE_FILL" | "SHORT_BORROW";
export type PriceQuoteSource = "OBSERVED_ASK" | "OBSERVED_BID" | "SYNTHETIC_HALF_SPREAD";

/**
 * Fixed two-decimal USD components. Commission and borrow are order/position
 * totals. Spread and slippage are per-share impacts for PRICE_FILL: spread is
 * signed (positive is adverse, negative is favorable), while slippage is
 * always nonnegative. Inapplicable components are represented as "0.00".
 */
export interface CostComponents {
  readonly commission: string;
  readonly spread: string;
  readonly slippage: string;
  readonly borrow: string;
}

export interface CommissionInputs {
  readonly shares: string;
}

export interface PriceFillInput {
  readonly side: SimulationSide;
  readonly reference: string;
  readonly ask?: string;
  readonly bid?: string;
}

export interface NormalizedPriceFillInputs {
  readonly side: SimulationSide;
  readonly reference: string;
  readonly ask: string | null;
  readonly bid: string | null;
}

export interface ShortBorrowInput {
  readonly shortNotional: string;
  readonly utcDays: number;
}

export interface NormalizedShortBorrowInputs {
  readonly shortNotional: string;
  readonly utcDays: number;
}

interface CostCalculation<
  Kind extends CostCalculationKind,
  Inputs extends object,
> {
  readonly policyVersion: typeof COST_POLICY_VERSION;
  readonly calculation: Kind;
  readonly inputs: Readonly<Inputs>;
  /** Total USD for commission/borrow, or the USD-per-share fill for PRICE_FILL. */
  readonly result: string;
  readonly components: Readonly<CostComponents>;
}

export type CommissionCalculation = CostCalculation<"COMMISSION", CommissionInputs>;
export type PriceFillCalculation = CostCalculation<"PRICE_FILL", NormalizedPriceFillInputs> & {
  readonly quoteSource: PriceQuoteSource;
};
export type ShortBorrowCalculation = CostCalculation<"SHORT_BORROW", NormalizedShortBorrowInputs>;

function invalidInput(field: string): never {
  throw new Error(`COST_${field}_INVALID`);
}

function parseDecimalInput(
  raw: string,
  field: string,
  options: { readonly allowZero: boolean },
): InstanceType<typeof CostDecimal> {
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

  const value = new CostDecimal(raw);
  if (!value.isFinite() || value.isNegative() || (!options.allowZero && value.isZero())) {
    return invalidInput(field);
  }
  return value;
}

function normalized(value: InstanceType<typeof CostDecimal>): string {
  return value.toFixed();
}

function money(value: InstanceType<typeof CostDecimal>): string {
  const rounded = value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return rounded.isZero() ? ZERO_MONEY : rounded.toFixed(2);
}

function requireCentPrecision(
  value: InstanceType<typeof CostDecimal>,
  field: string,
): void {
  if (value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).isZero()) {
    throw new Error(`COST_${field}_BELOW_CENT_PRECISION`);
  }
}

function costComponents(values: Partial<CostComponents> = {}): Readonly<CostComponents> {
  return Object.freeze({
    commission: values.commission ?? ZERO_MONEY,
    spread: values.spread ?? ZERO_MONEY,
    slippage: values.slippage ?? ZERO_MONEY,
    borrow: values.borrow ?? ZERO_MONEY,
  });
}

export function calculateCommission(shares: string): CommissionCalculation {
  const parsedShares = parseDecimalInput(shares, "SHARES", {
    allowZero: false,
  });
  const calculated = parsedShares.mul(COMMISSION_PER_SHARE);
  const result = money(calculated.lessThan(MINIMUM_COMMISSION) ? MINIMUM_COMMISSION : calculated);

  return Object.freeze({
    policyVersion: COST_POLICY_VERSION,
    calculation: "COMMISSION",
    inputs: Object.freeze({ shares: normalized(parsedShares) }),
    result,
    components: costComponents({ commission: result }),
  });
}

export function commission(shares: string): string {
  return calculateCommission(shares).result;
}

export function calculatePriceFill(input: PriceFillInput): PriceFillCalculation {
  if (input === null || typeof input !== "object") {
    return invalidInput("PRICE_FILL");
  }
  const side = input.side;
  const referenceInput = input.reference;
  const askInput = input.ask;
  const bidInput = input.bid;

  if (side !== "BUY" && side !== "SELL") {
    return invalidInput("SIDE");
  }

  const reference = parseDecimalInput(referenceInput, "REFERENCE_PRICE", {
    allowZero: false,
  });
  const ask = askInput === undefined
    ? null
    : parseDecimalInput(askInput, "ASK_PRICE", { allowZero: false });
  const bid = bidInput === undefined
    ? null
    : parseDecimalInput(bidInput, "BID_PRICE", { allowZero: false });

  requireCentPrecision(reference, "REFERENCE_PRICE");
  if (ask !== null) {
    requireCentPrecision(ask, "ASK_PRICE");
  }
  if (bid !== null) {
    requireCentPrecision(bid, "BID_PRICE");
  }

  const observedQuote = side === "BUY" ? ask : bid;
  const syntheticSpread = reference.mul(ADVERSE_HALF_SPREAD_RATE);
  const quote = observedQuote ?? (
    side === "BUY" ? reference.plus(syntheticSpread) : reference.minus(syntheticSpread)
  );
  const signedSpread = observedQuote === null
    ? syntheticSpread
    : side === "BUY" ? quote.minus(reference) : reference.minus(quote);
  const slippage = quote.mul(ADVERSE_SLIPPAGE_RATE);
  const unroundedFill = side === "BUY" ? quote.plus(slippage) : quote.minus(slippage);
  const roundedReference = reference.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const roundedFill = unroundedFill.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (roundedFill.isZero()) {
    throw new Error("COST_FILL_PRICE_BELOW_CENT_PRECISION");
  }
  const totalAdverseImpact = side === "BUY"
    ? roundedFill.minus(roundedReference)
    : roundedReference.minus(roundedFill);
  const independentlyRoundedSpread = signedSpread.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const roundedSpread = CostDecimal.min(independentlyRoundedSpread, totalAdverseImpact);
  const roundedSlippage = totalAdverseImpact.minus(roundedSpread);
  if (roundedSlippage.isNegative()) {
    throw new Error("COST_COMPONENT_RECONCILIATION_FAILED");
  }
  const quoteSource: PriceQuoteSource = observedQuote === null
    ? "SYNTHETIC_HALF_SPREAD"
    : side === "BUY" ? "OBSERVED_ASK" : "OBSERVED_BID";

  return Object.freeze({
    policyVersion: COST_POLICY_VERSION,
    calculation: "PRICE_FILL",
    quoteSource,
    inputs: Object.freeze({
      side,
      reference: normalized(reference),
      ask: ask === null ? null : normalized(ask),
      bid: bid === null ? null : normalized(bid),
    }),
    result: money(roundedFill),
    components: costComponents({
      spread: money(roundedSpread),
      slippage: money(roundedSlippage),
    }),
  });
}

export function priceFill(input: PriceFillInput): string {
  return calculatePriceFill(input).result;
}

export function calculateShortBorrow(input: ShortBorrowInput): ShortBorrowCalculation {
  if (input === null || typeof input !== "object") {
    return invalidInput("SHORT_BORROW");
  }
  const shortNotionalInput = input.shortNotional;
  const utcDays = input.utcDays;

  const shortNotional = parseDecimalInput(shortNotionalInput, "SHORT_NOTIONAL", {
    allowZero: false,
  });
  if (typeof utcDays !== "number" || !Number.isSafeInteger(utcDays) || utcDays < 0) {
    return invalidInput("UTC_DAYS");
  }

  const borrow = shortNotional
    .mul(ANNUAL_SHORT_BORROW_RATE)
    .mul(new CostDecimal(utcDays.toString()))
    .div(UTC_DAYS_PER_YEAR);
  const result = money(borrow);

  return Object.freeze({
    policyVersion: COST_POLICY_VERSION,
    calculation: "SHORT_BORROW",
    inputs: Object.freeze({
      shortNotional: normalized(shortNotional),
      utcDays,
    }),
    result,
    components: costComponents({ borrow: result }),
  });
}

export function shortBorrow(input: ShortBorrowInput): string {
  return calculateShortBorrow(input).result;
}
