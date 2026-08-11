import { normalizeObservation } from "./policy";
import type {
  LicensedMarketDataProvider,
  LicensedProviderConfig,
  MarketAllowlist,
  MarketObservation,
  TrustedMarketSourceRegistry,
} from "./types";
import { trustedSourceAuthority } from "./types";

/**
 * Builds a pure server-side adapter. Fetching and provider-specific payloads stay
 * outside the canonical market-data layer; only the mapped source reference is retained.
 */
export function createLicensedProvider<Raw>(
  config: LicensedProviderConfig<Raw>,
  registry: TrustedMarketSourceRegistry,
): LicensedMarketDataProvider<Raw> {
  if (!config || typeof config !== "object" || typeof config.map !== "function") {
    throw new Error("MARKET_PROVIDER_INVALID");
  }
  const provider = config.provider;
  const configuredLicenseId = config.licenseId;
  const authority = trustedSourceAuthority(registry, provider, configuredLicenseId);
  if (!authority?.active) throw new Error("MARKET_SOURCE_UNLICENSED");
  if (authority.redistribution === "PROHIBITED") {
    throw new Error("MARKET_RIGHTS_MISMATCH");
  }
  const licenseId = authority.licenseId;
  const redistribution = authority.redistribution;
  const map = config.map;
  return Object.freeze({
    provider,
    normalize(raw: Raw, allowlist: MarketAllowlist): MarketObservation {
      const mapped = map(raw);
      if (!mapped || typeof mapped !== "object") throw new Error("MARKET_PROVIDER_INVALID");
      return normalizeObservation({
        ...mapped,
        provider,
        redistribution,
        licenseStatus: "LICENSED",
        licenseId,
      }, allowlist);
    },
  });
}
