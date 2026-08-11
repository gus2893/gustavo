import {
  MARKET_ASSET_CLASSES,
  MARKET_FEED_STATUSES,
  MARKET_REDISTRIBUTION_CLASSES,
  MARKET_SESSION_STATES,
  trustedSourceAuthority,
  type ChallengeObservationPolicy,
  type ChallengeObservationEvaluation,
  type MarketAllowlist,
  type MarketAssetClass,
  type MarketFeedStatus,
  type MarketObservation,
  type MarketObservationInput,
  type MarketRedistribution,
  type MarketSessionState,
} from "./types";

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const FIXED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function member<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new Error(code);
  }
  return value as T;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) {
    throw new Error("MARKET_TIMESTAMP_INVALID");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error("MARKET_TIMESTAMP_INVALID");
  }
  return value;
}

function fixedDecimal(value: unknown): string {
  if (typeof value !== "string" || !FIXED_DECIMAL_PATTERN.test(value)) {
    throw new Error("MARKET_PRICE_INVALID");
  }
  const digits = value.replace(".", "");
  if (BigInt(digits) === 0n) {
    throw new Error("MARKET_PRICE_INVALID");
  }
  return value;
}

function sourceIdentifier(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID_PATTERN.test(value)) {
    throw new Error("MARKET_SOURCE_INVALID");
  }
  return value;
}

function rawSourceReference(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512
    || value !== value.trim() || value.includes("\u0000")) {
    throw new Error("MARKET_SOURCE_INVALID");
  }
  return value;
}

function allowedAssetClass(
  symbolValue: unknown,
  assetClassValue: unknown,
  allowlist: MarketAllowlist,
): { readonly symbol: string; readonly assetClass: MarketAssetClass } {
  if (typeof symbolValue !== "string" || !SYMBOL_PATTERN.test(symbolValue)
    || !allowlist || typeof allowlist.has !== "function" || !allowlist.has(symbolValue)
    || typeof assetClassValue !== "string"
    || !(MARKET_ASSET_CLASSES as readonly string[]).includes(assetClassValue)) {
    throw new Error("MARKET_NOT_ALLOWED");
  }
  const mapGet = (allowlist as Partial<ReadonlyMap<string, MarketAssetClass>>).get;
  if (typeof mapGet === "function" && mapGet.call(allowlist, symbolValue) !== assetClassValue) {
    throw new Error("MARKET_NOT_ALLOWED");
  }
  return { symbol: symbolValue, assetClass: assetClassValue as MarketAssetClass };
}

/**
 * Converts a provider-neutral boundary object to the single canonical observation shape.
 * Direct observations remain UNVERIFIED unless a licensed adapter supplies source provenance.
 */
export function normalizeObservation(
  input: MarketObservationInput,
  allowlist: MarketAllowlist,
): MarketObservation {
  if (!input || typeof input !== "object") throw new Error("MARKET_OBSERVATION_INVALID");
  const { symbol, assetClass } = allowedAssetClass(input.symbol, input.assetClass, allowlist);
  const observedAt = canonicalTimestamp(input.observedAt);
  const receivedAt = canonicalTimestamp(input.receivedAt ?? input.observedAt);
  if (receivedAt < observedAt) throw new Error("MARKET_TIMESTAMP_INVALID");
  const provider = sourceIdentifier(input.provider);
  const feedStatus = member(
    input.feedStatus,
    MARKET_FEED_STATUSES,
    "MARKET_DELAY_INVALID",
  ) as MarketFeedStatus;
  if (!Number.isSafeInteger(input.delaySeconds) || input.delaySeconds < 0
    || input.delaySeconds > 86_400
    || (feedStatus === "REALTIME" && input.delaySeconds !== 0)
    || (feedStatus === "DELAYED" && input.delaySeconds === 0)) {
    throw new Error("MARKET_DELAY_INVALID");
  }
  const redistribution = member(
    input.redistribution,
    MARKET_REDISTRIBUTION_CLASSES,
    "MARKET_RIGHTS_INVALID",
  ) as MarketRedistribution;
  const sessionState = member(
    input.sessionState,
    MARKET_SESSION_STATES,
    "MARKET_SESSION_INVALID",
  ) as MarketSessionState;

  const licenseStatus = input.licenseStatus ?? "UNVERIFIED";
  let licenseId: string | null = null;
  let rawSourceRef: string | null = null;
  if (licenseStatus === "LICENSED") {
    licenseId = sourceIdentifier(input.licenseId);
    rawSourceRef = rawSourceReference(input.rawSourceRef);
  } else if (licenseStatus !== "UNVERIFIED"
    || (input.licenseId !== undefined && input.licenseId !== null)
    || (input.rawSourceRef !== undefined && input.rawSourceRef !== null)) {
    throw new Error("MARKET_SOURCE_INVALID");
  }

  return Object.freeze({
    symbol,
    assetClass,
    price: fixedDecimal(input.price),
    observedAt,
    receivedAt,
    provider,
    feedStatus,
    delaySeconds: input.delaySeconds,
    redistribution,
    sessionState,
    licenseStatus,
    licenseId,
    rawSourceRef,
  });
}

export function assertChallengeObservation(
  observation: MarketObservation,
  policy: ChallengeObservationPolicy,
): ChallengeObservationEvaluation {
  if (!observation || typeof observation !== "object") {
    throw new Error("MARKET_OBSERVATION_INVALID");
  }
  if (!policy?.allowlist || typeof policy.allowlist.has !== "function"
    || typeof policy.allowlist.get !== "function") {
    throw new Error("MARKET_ALLOWLIST_INVALID");
  }
  const canonical = normalizeObservation(observation, policy?.allowlist);
  if (canonical.licenseStatus !== "LICENSED" || !canonical.licenseId
    || !canonical.rawSourceRef) {
    throw new Error("MARKET_SOURCE_UNLICENSED");
  }
  if (canonical.sessionState !== "OPEN") throw new Error("MARKET_SESSION_CLOSED");
  if (canonical.redistribution === "PROHIBITED") {
    throw new Error("MARKET_REDISTRIBUTION_FORBIDDEN");
  }
  const authority = trustedSourceAuthority(
    policy?.sourceRegistry,
    canonical.provider,
    canonical.licenseId,
  );
  if (!authority?.active || authority.licenseId !== canonical.licenseId) {
    throw new Error("MARKET_SOURCE_UNLICENSED");
  }
  if (authority.redistribution !== canonical.redistribution) {
    throw new Error("MARKET_RIGHTS_MISMATCH");
  }
  const asOf = canonicalTimestamp(policy?.asOf);
  if (!Number.isSafeInteger(policy?.maxReceiptAgeSeconds)
    || policy.maxReceiptAgeSeconds < 1 || policy.maxReceiptAgeSeconds > 86_400) {
    throw new Error("MARKET_FRESHNESS_POLICY_INVALID");
  }
  const receiptAgeMilliseconds = Date.parse(asOf) - Date.parse(canonical.receivedAt);
  const effectiveAgeMilliseconds = Date.parse(asOf) - Date.parse(canonical.observedAt);
  if (receiptAgeMilliseconds < 0 || effectiveAgeMilliseconds < 0) {
    throw new Error("MARKET_OBSERVATION_FROM_FUTURE");
  }
  if (receiptAgeMilliseconds > policy.maxReceiptAgeSeconds * 1_000
    || effectiveAgeMilliseconds
      > (canonical.delaySeconds + policy.maxReceiptAgeSeconds) * 1_000) {
    throw new Error("MARKET_OBSERVATION_STALE");
  }
  return Object.freeze({
    observation: canonical,
    evaluatedAsOf: asOf,
    receiptAgeSeconds: Math.ceil(receiptAgeMilliseconds / 1_000),
    effectiveAgeSeconds: Math.ceil(effectiveAgeMilliseconds / 1_000),
    freshness: "FRESH",
  });
}

interface JsonCloneState {
  count: number;
  readonly ancestors: Set<object>;
}

function immutableJsonClone(
  value: unknown,
  state: JsonCloneState,
  depth = 0,
): unknown {
  state.count += 1;
  if (state.count > 100_000 || depth > 32) throw new Error("MARKET_BAR_NOT_JSON");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 100_000 || value.includes("\u0000")) {
      throw new Error("MARKET_BAR_NOT_JSON");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MARKET_BAR_NOT_JSON");
    return value;
  }
  if (typeof value !== "object" || state.ancestors.has(value)) {
    throw new Error("MARKET_BAR_NOT_JSON");
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error("MARKET_BAR_NOT_JSON");
    state.ancestors.add(value);
    try {
      return Object.freeze(value.map((entry) => immutableJsonClone(entry, state, depth + 1)));
    } finally {
      state.ancestors.delete(value);
    }
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("MARKET_BAR_NOT_JSON");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 256 || Reflect.ownKeys(value).length !== keys.length) {
    throw new Error("MARKET_BAR_NOT_JSON");
  }
  state.ancestors.add(value);
  try {
    const clone: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("MARKET_BAR_NOT_JSON");
      }
      Object.defineProperty(clone, key, {
        value: immutableJsonClone(descriptor.value, state, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(clone);
  } finally {
    state.ancestors.delete(value);
  }
}

function immutableBar<Bar extends { readonly completed: boolean }>(
  bar: Bar,
  state: JsonCloneState,
): Readonly<Bar> {
  const clone = immutableJsonClone(bar, state);
  if (!clone || typeof clone !== "object"
    || typeof (clone as { readonly completed?: unknown }).completed !== "boolean") {
    throw new Error("MARKET_BAR_INVALID");
  }
  return clone as Readonly<Bar>;
}

export function splitBars<Bar extends { readonly completed: boolean }>(bars: readonly Bar[]): {
  readonly completed: readonly Readonly<Bar>[];
  readonly active?: Readonly<Bar>;
} {
  if (!Array.isArray(bars) || bars.length > 10_000) throw new Error("MARKET_BARS_INVALID");
  const state: JsonCloneState = { count: 0, ancestors: new Set<object>() };
  const completed: Readonly<Bar>[] = [];
  let active: Readonly<Bar> | undefined;
  for (const item of bars) {
    const bar = immutableBar(item, state);
    if (bar.completed) {
      completed.push(bar);
    } else if (active) {
      throw new Error("MARKET_MULTIPLE_ACTIVE_BARS");
    } else {
      active = bar;
    }
  }
  return Object.freeze({
    completed: Object.freeze(completed),
    ...(active ? { active } : {}),
  });
}
