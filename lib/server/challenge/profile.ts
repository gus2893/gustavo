export type BasisPointRounding = "DOWN" | "UP";
export type ChallengeAssetClass = "US_STOCK" | "US_ETF";

const BASIS_POINT_DENOMINATOR = 10_000n;
const STAGE_LADDER_CENTS = Object.freeze([
  250_000n,
  500_000n,
  1_000_000n,
  2_000_000n,
  4_000_000n,
  8_000_000n,
  16_000_000n,
  32_000_000n,
  64_000_000n,
  100_000_000n,
] as const);

const ALLOWED_ASSET_CLASSES = Object.freeze([
  "US_STOCK",
  "US_ETF",
] as const satisfies readonly ChallengeAssetClass[]);

export const INITIAL_PROFILE = Object.freeze({
  challengePortfolioId: "00000000-0000-4000-8000-000000001200",
  profileVersionId: "00000000-0000-4000-8000-000000001201",
  version: 1,
  baseCurrency: "USD",
  profitObjectiveBps: 1_000,
  overallDrawdownType: "STATIC",
  overallLossLimitBps: 600,
  trailingOverallDrawdown: false,
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
  allowedAssetClasses: ALLOWED_ASSET_CLASSES,
  costPolicyVersion: "stock-etf-cost-v1",
  initialLifecycleState: "ACTIVE",
} as const);

/**
 * Applies integer basis points without introducing floating-point money.
 * DOWN is used for exposure/loss allowances; UP is used for costs and
 * minimum required amounts so a fractional cent never makes a rule looser.
 */
export function basisPointAmount(
  amountCents: bigint,
  basisPoints: number,
  rounding: BasisPointRounding,
): bigint {
  if (typeof amountCents !== "bigint" || amountCents < 0n) {
    throw new Error("CHALLENGE_AMOUNT_INVALID");
  }
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 1_000_000) {
    throw new Error("CHALLENGE_BASIS_POINTS_INVALID");
  }
  if (rounding !== "DOWN" && rounding !== "UP") {
    throw new Error("CHALLENGE_ROUNDING_INVALID");
  }

  const numerator = amountCents * BigInt(basisPoints);
  const wholeCents = numerator / BASIS_POINT_DENOMINATOR;
  return rounding === "UP" && numerator % BASIS_POINT_DENOMINATOR !== 0n
    ? wholeCents + 1n
    : wholeCents;
}

export function stageValues(startingBalanceCents: bigint): {
  readonly targetEquityCents: bigint;
  readonly overallFloorCents: bigint;
  readonly dailyLossLimitCents: bigint;
  readonly portfolioRiskLimitCents: bigint;
  readonly positionRiskLimitCents: bigint;
  readonly qualifyingRiskCents: bigint;
} {
  if (typeof startingBalanceCents !== "bigint" || startingBalanceCents <= 0n) {
    throw new Error("CHALLENGE_STARTING_BALANCE_INVALID");
  }

  const overallLossAllowance = basisPointAmount(
    startingBalanceCents,
    INITIAL_PROFILE.overallLossLimitBps,
    "DOWN",
  );
  return Object.freeze({
    targetEquityCents: startingBalanceCents + basisPointAmount(
      startingBalanceCents,
      INITIAL_PROFILE.profitObjectiveBps,
      "UP",
    ),
    overallFloorCents: startingBalanceCents - overallLossAllowance,
    dailyLossLimitCents: basisPointAmount(
      startingBalanceCents,
      INITIAL_PROFILE.dailyLossLimitBps,
      "DOWN",
    ),
    portfolioRiskLimitCents: basisPointAmount(
      startingBalanceCents,
      INITIAL_PROFILE.portfolioRiskLimitBps,
      "DOWN",
    ),
    positionRiskLimitCents: basisPointAmount(
      startingBalanceCents,
      INITIAL_PROFILE.positionRiskLimitBps,
      "DOWN",
    ),
    qualifyingRiskCents: basisPointAmount(
      startingBalanceCents,
      INITIAL_PROFILE.qualifyingRiskBps,
      "UP",
    ),
  });
}

export function stageLadderCents(): readonly bigint[] {
  return [...STAGE_LADDER_CENTS];
}

export function stageLadder(): readonly number[] {
  return STAGE_LADDER_CENTS.map((amount) => Number(amount / 100n));
}
