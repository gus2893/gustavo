export const MARKET_ASSET_CLASSES = ["US_STOCK", "US_ETF"] as const;
export const MARKET_FEED_STATUSES = ["REALTIME", "DELAYED"] as const;
export const MARKET_REDISTRIBUTION_CLASSES = [
  "PUBLIC",
  "ACCOUNT_ONLY",
  "INTERNAL_ONLY",
  "PROHIBITED",
] as const;
export const MARKET_SESSION_STATES = [
  "OPEN",
  "CLOSED",
  "PRE_MARKET",
  "AFTER_HOURS",
  "HALTED",
] as const;

export type MarketAssetClass = typeof MARKET_ASSET_CLASSES[number];
export type MarketFeedStatus = typeof MARKET_FEED_STATUSES[number];
export type MarketRedistribution = typeof MARKET_REDISTRIBUTION_CLASSES[number];
export type MarketSessionState = typeof MARKET_SESSION_STATES[number];
export type MarketLicenseStatus = "LICENSED" | "UNVERIFIED";

export type MarketAllowlist =
  | ReadonlySet<string>
  | ReadonlyMap<string, MarketAssetClass>;

export type MarketAssetClassAllowlist = ReadonlyMap<string, MarketAssetClass>;

export interface MarketSourceAuthority {
  readonly provider: string;
  readonly licenseId: string;
  readonly active: boolean;
  readonly redistribution: MarketRedistribution;
}

export interface TrustedMarketSourceRegistry {
  readonly size: number;
  has(provider: string, licenseId: string): boolean;
  get(provider: string, licenseId: string): Readonly<MarketSourceAuthority> | undefined;
}

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const trustedRegistries = new WeakSet<object>();

function authorityKey(provider: string, licenseId: string): string {
  return `${provider}\u0000${licenseId}`;
}

export function createTrustedSourceRegistry(
  entries: readonly MarketSourceAuthority[],
): TrustedMarketSourceRegistry {
  if (!Array.isArray(entries) || entries.length > 256) {
    throw new Error("MARKET_SOURCE_REGISTRY_INVALID");
  }
  const authorities = new Map<string, Readonly<MarketSourceAuthority>>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object"
      || typeof entry.provider !== "string" || !SOURCE_ID_PATTERN.test(entry.provider)
      || typeof entry.licenseId !== "string" || !SOURCE_ID_PATTERN.test(entry.licenseId)
      || typeof entry.active !== "boolean"
      || !(MARKET_REDISTRIBUTION_CLASSES as readonly string[]).includes(entry.redistribution)
      || authorities.has(authorityKey(entry.provider, entry.licenseId))) {
      throw new Error("MARKET_SOURCE_REGISTRY_INVALID");
    }
    authorities.set(authorityKey(entry.provider, entry.licenseId), Object.freeze({
      provider: entry.provider,
      licenseId: entry.licenseId,
      active: entry.active,
      redistribution: entry.redistribution,
    }));
  }
  const registry: TrustedMarketSourceRegistry = Object.freeze({
    size: authorities.size,
    has(provider: string, licenseId: string): boolean {
      return authorities.has(authorityKey(provider, licenseId));
    },
    get(provider: string, licenseId: string): Readonly<MarketSourceAuthority> | undefined {
      return authorities.get(authorityKey(provider, licenseId));
    },
  });
  trustedRegistries.add(registry);
  return registry;
}

export function trustedSourceAuthority(
  registry: TrustedMarketSourceRegistry,
  provider: string,
  licenseId: string,
): Readonly<MarketSourceAuthority> | undefined {
  if (!registry || typeof registry !== "object" || !trustedRegistries.has(registry)) {
    throw new Error("MARKET_SOURCE_REGISTRY_INVALID");
  }
  return registry.get(provider, licenseId);
}

export interface MarketObservationInput {
  readonly symbol: string;
  readonly assetClass: string;
  readonly price: string;
  readonly observedAt: string;
  readonly receivedAt?: string;
  readonly provider: string;
  readonly feedStatus: string;
  readonly delaySeconds: number;
  readonly redistribution: string;
  readonly sessionState: string;
  readonly licenseStatus?: string;
  readonly licenseId?: string | null;
  readonly rawSourceRef?: string | null;
}

export interface MarketObservation {
  readonly symbol: string;
  readonly assetClass: MarketAssetClass;
  readonly price: string;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly provider: string;
  readonly feedStatus: MarketFeedStatus;
  readonly delaySeconds: number;
  readonly redistribution: MarketRedistribution;
  readonly sessionState: MarketSessionState;
  readonly licenseStatus: MarketLicenseStatus;
  readonly licenseId: string | null;
  readonly rawSourceRef: string | null;
}

export interface ChallengeObservationPolicy {
  readonly asOf: string;
  readonly maxReceiptAgeSeconds: number;
  readonly allowlist: MarketAssetClassAllowlist;
  readonly sourceRegistry: TrustedMarketSourceRegistry;
}

export interface ChallengeObservationEvaluation {
  readonly observation: MarketObservation;
  readonly evaluatedAsOf: string;
  readonly receiptAgeSeconds: number;
  readonly effectiveAgeSeconds: number;
  readonly freshness: "FRESH";
}

export interface ProviderMappedObservation {
  readonly symbol: string;
  readonly assetClass: MarketAssetClass;
  readonly price: string;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly feedStatus: MarketFeedStatus;
  readonly delaySeconds: number;
  readonly sessionState: MarketSessionState;
  readonly rawSourceRef: string;
}

export interface LicensedProviderConfig<Raw> {
  readonly provider: string;
  readonly licenseId: string;
  readonly map: (raw: Raw) => ProviderMappedObservation;
}

export interface LicensedMarketDataProvider<Raw> {
  readonly provider: string;
  normalize(raw: Raw, allowlist: MarketAllowlist): MarketObservation;
}
