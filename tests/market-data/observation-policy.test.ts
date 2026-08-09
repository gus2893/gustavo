import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertChallengeObservation,
  normalizeObservation,
  splitBars,
} from "../../lib/server/market-data/policy";
import { createLicensedProvider } from "../../lib/server/market-data/provider";
import { createTrustedSourceRegistry } from "../../lib/server/market-data/types";
import { openTestDb } from "../helpers/postgres";

const observationInput = {
  symbol: "AAPL",
  assetClass: "US_STOCK" as const,
  price: "225.10",
  observedAt: "2026-08-09T14:30:00.000Z",
  receivedAt: "2026-08-09T14:45:00.000Z",
  provider: "licensed-feed",
  feedStatus: "DELAYED" as const,
  delaySeconds: 900,
  redistribution: "ACCOUNT_ONLY" as const,
  sessionState: "OPEN" as const,
};

const sourceAuthority = {
  provider: "licensed-feed",
  licenseId: "us-equities-v1",
  active: true,
  redistribution: "ACCOUNT_ONLY" as const,
};

function activeSourceRegistry() {
  return createTrustedSourceRegistry([sourceAuthority]);
}

describe("market observation policy", () => {
  it("accepts allowlisted US stocks and preserves delay and rights metadata", () => {
    const value = normalizeObservation({
      symbol: "AAPL", assetClass: "US_STOCK", price: "225.10",
      observedAt: "2026-08-09T14:30:00.000Z", provider: "licensed-feed",
      feedStatus: "DELAYED", delaySeconds: 900, redistribution: "ACCOUNT_ONLY",
      sessionState: "OPEN",
    }, new Set(["AAPL", "SPY"]));
    expect(value).toMatchObject({
      symbol: "AAPL",
      price: "225.10",
      feedStatus: "DELAYED",
      delaySeconds: 900,
      redistribution: "ACCOUNT_ONLY",
      licenseStatus: "UNVERIFIED",
    });
    expect(() => normalizeObservation(
      { ...value, symbol: "BTC-USD", assetClass: "CRYPTO" },
      new Set(["AAPL"]),
    )).toThrow("MARKET_NOT_ALLOWED");
  });

  it("accepts only canonical positive fixed decimals within the storage range", () => {
    for (const price of ["0.00000001", "1", "225.10", "999999999999.99999999"]) {
      expect(normalizeObservation({ ...observationInput, price }, new Set(["AAPL"])).price)
        .toBe(price);
    }
    for (const price of [0, "0", "-1.00", "+1.00", "01.00", "1.", ".5", "1e3",
      "1.123456789", "1000000000000.00", " 1.00"] as readonly unknown[]) {
      expect(() => normalizeObservation(
        { ...observationInput, price } as never,
        new Set(["AAPL"]),
      )).toThrow("MARKET_PRICE_INVALID");
    }
  });

  it("requires canonical UTC millisecond timestamps and coherent receipt order", () => {
    expect(normalizeObservation(observationInput, new Set(["AAPL"]))).toMatchObject({
      observedAt: "2026-08-09T14:30:00.000Z",
      receivedAt: "2026-08-09T14:45:00.000Z",
    });
    for (const observedAt of [
      "2026-08-09T14:30:00Z",
      "2026-08-09T10:30:00.000-04:00",
      "2026-02-30T14:30:00.000Z",
      "2026-08-09 14:30:00.000Z",
    ]) {
      expect(() => normalizeObservation(
        { ...observationInput, observedAt },
        new Set(["AAPL"]),
      )).toThrow("MARKET_TIMESTAMP_INVALID");
    }
    expect(() => normalizeObservation({
      ...observationInput,
      receivedAt: "2026-08-09T14:29:59.999Z",
    }, new Set(["AAPL"]))).toThrow("MARKET_TIMESTAMP_INVALID");
    expect(normalizeObservation({
      ...observationInput,
      observedAt: "2026-08-09T14:29:59.999Z",
    }, new Set(["AAPL"])).observedAt).toBe("2026-08-09T14:29:59.999Z");
    expect(normalizeObservation({
      ...observationInput,
      feedStatus: "REALTIME",
      delaySeconds: 0,
    }, new Set(["AAPL"])).feedStatus).toBe("REALTIME");
  });

  it("enforces the exact operator asset-class allowlist", () => {
    const allowlist = new Map([
      ["AAPL", "US_STOCK"],
      ["SPY", "US_ETF"],
    ] as const);
    expect(normalizeObservation(observationInput, allowlist).assetClass).toBe("US_STOCK");
    expect(normalizeObservation({ ...observationInput, symbol: "SPY", assetClass: "US_ETF" }, allowlist).assetClass)
      .toBe("US_ETF");
    expect(() => normalizeObservation({
      ...observationInput,
      symbol: "SPY",
      assetClass: "US_STOCK",
    }, allowlist)).toThrow("MARKET_NOT_ALLOWED");
    expect(() => normalizeObservation({
      ...observationInput,
      symbol: "BTC-USD",
      assetClass: "CRYPTO",
    }, new Set(["BTC-USD"]))).toThrow("MARKET_NOT_ALLOWED");
  });

  it("adds licensed provider and raw-source provenance without provider-specific leakage", () => {
    const registry = createTrustedSourceRegistry([
      sourceAuthority,
      {
        ...sourceAuthority,
        licenseId: "us-equities-v2",
        redistribution: "PUBLIC",
      },
    ]);
    const provider = createLicensedProvider<{ readonly ticker: string; readonly last: string; readonly sequence: string }>({
      provider: "licensed-feed",
      licenseId: "us-equities-v1",
      map(raw) {
        return {
          symbol: raw.ticker,
          assetClass: "US_STOCK",
          price: raw.last,
          observedAt: "2026-08-09T14:30:00.000Z",
          receivedAt: "2026-08-09T14:45:00.000Z",
          feedStatus: "DELAYED",
          delaySeconds: 900,
          sessionState: "OPEN",
          rawSourceRef: `sequence:${raw.sequence}`,
        };
      },
    }, registry);
    const value = provider.normalize(
      { ticker: "AAPL", last: "225.10", sequence: "42" },
      new Map([["AAPL", "US_STOCK"]] as const),
    );
    expect(value).toEqual({
      ...observationInput,
      licenseStatus: "LICENSED",
      licenseId: "us-equities-v1",
      rawSourceRef: "sequence:42",
    });
    expect(value).not.toHaveProperty("sequence");
    expect(registry.size).toBe(2);
    expect(Object.isFrozen(registry.get("licensed-feed", "us-equities-v1"))).toBe(true);
    const alternateProvider = createLicensedProvider({
      provider: "licensed-feed",
      licenseId: "us-equities-v2",
      map: () => ({
        ...observationInput,
        rawSourceRef: "sequence:43",
      }),
    }, registry);
    expect(alternateProvider.normalize(observationInput, new Set(["AAPL"]))).toMatchObject({
      licenseId: "us-equities-v2",
      redistribution: "PUBLIC",
    });
    expect(() => createLicensedProvider({
      provider: "forged-feed",
      licenseId: "forged-license",
      map: () => ({
        ...observationInput,
        rawSourceRef: "forged:1",
      }),
    }, registry)).toThrow("MARKET_SOURCE_UNLICENSED");
  });

  it("validates feed delay, redistribution, session, and source identifiers", () => {
    for (const value of [
      { feedStatus: "REALTIME", delaySeconds: 1 },
      { feedStatus: "DELAYED", delaySeconds: 0 },
      { feedStatus: "DELAYED", delaySeconds: -1 },
      { feedStatus: "DELAYED", delaySeconds: 1.5 },
    ]) {
      expect(() => normalizeObservation(
        { ...observationInput, ...value } as never,
        new Set(["AAPL"]),
      )).toThrow("MARKET_DELAY_INVALID");
    }
    for (const change of [
      { provider: "bad provider" },
      { redistribution: "EVERYWHERE" },
      { sessionState: "WEEKEND" },
    ]) {
      expect(() => normalizeObservation(
        { ...observationInput, ...change } as never,
        new Set(["AAPL"]),
      )).toThrow(/MARKET_(SOURCE|RIGHTS|SESSION)_INVALID/);
    }
  });

  it("keeps at most one active bar out of immutable completed evidence", () => {
    const originalNested = { touches: ["first", "second"] };
    const bars = splitBars([
      { id: "b1", completed: true, close: "224.00", evidence: originalNested },
      { id: "b2", completed: false, close: "225.10" },
    ]);
    expect(bars).toEqual({
      completed: [{
        id: "b1",
        completed: true,
        close: "224.00",
        evidence: { touches: ["first", "second"] },
      }],
      active: { id: "b2", completed: false, close: "225.10" },
    });
    expect(Object.isFrozen(bars)).toBe(true);
    expect(Object.isFrozen(bars.completed)).toBe(true);
    expect(Object.isFrozen(bars.completed[0])).toBe(true);
    const returnedNested = bars.completed[0]?.evidence;
    expect(Object.isFrozen(returnedNested)).toBe(true);
    expect(Object.isFrozen(returnedNested?.touches)).toBe(true);
    originalNested.touches.push("third");
    expect(returnedNested?.touches).toEqual(["first", "second"]);
    expect(() => returnedNested?.touches.push("forbidden")).toThrow(TypeError);
    expect(() => splitBars([
      { id: "b1", completed: false },
      { id: "b2", completed: false },
    ])).toThrow("MARKET_MULTIPLE_ACTIVE_BARS");
    const cyclic: { completed: boolean; self?: unknown } = { completed: true };
    cyclic.self = cyclic;
    expect(() => splitBars([cyclic])).toThrow("MARKET_BAR_NOT_JSON");
    expect(() => splitBars([{ completed: true, invalid: new Date() }]))
      .toThrow("MARKET_BAR_NOT_JSON");
  });

  it("hard-gates unlicensed, stale, closed, prohibited, and future observations", () => {
    const registry = activeSourceRegistry();
    const provider = createLicensedProvider<typeof observationInput>({
      provider: "licensed-feed",
      licenseId: "us-equities-v1",
      map(raw) {
        return { ...raw, rawSourceRef: "sequence:42" };
      },
    }, registry);
    const observation = provider.normalize(observationInput, new Set(["AAPL"]));
    const allowlist = new Map([["AAPL", "US_STOCK"]] as const);
    const evaluation = assertChallengeObservation(observation, {
      asOf: "2026-08-09T14:46:00.000Z",
      maxReceiptAgeSeconds: 60,
      allowlist,
      sourceRegistry: registry,
    });
    expect(evaluation).toEqual({
      observation,
      evaluatedAsOf: "2026-08-09T14:46:00.000Z",
      receiptAgeSeconds: 60,
      effectiveAgeSeconds: 960,
      freshness: "FRESH",
    });
    expect(evaluation.observation).not.toBe(observation);
    expect(Object.isFrozen(evaluation)).toBe(true);
    expect(Object.isFrozen(evaluation.observation)).toBe(true);
    const realtimeWithTransportLatency = assertChallengeObservation({
      ...observation,
      observedAt: "2026-08-09T14:44:59.000Z",
      receivedAt: "2026-08-09T14:45:00.000Z",
      feedStatus: "REALTIME",
      delaySeconds: 0,
    }, {
      asOf: "2026-08-09T14:45:00.000Z",
      maxReceiptAgeSeconds: 60,
      allowlist,
      sourceRegistry: registry,
    });
    expect(realtimeWithTransportLatency).toMatchObject({
      receiptAgeSeconds: 0,
      effectiveAgeSeconds: 1,
      freshness: "FRESH",
    });
    expect(() => assertChallengeObservation(
      normalizeObservation(observationInput, new Set(["AAPL"])),
      {
        asOf: "2026-08-09T14:45:00.000Z", maxReceiptAgeSeconds: 60,
        allowlist, sourceRegistry: registry,
      },
    )).toThrow("MARKET_SOURCE_UNLICENSED");
    expect(() => assertChallengeObservation(observation, {
      asOf: "2026-08-09T14:46:00.001Z",
      maxReceiptAgeSeconds: 60,
      allowlist,
      sourceRegistry: registry,
    })).toThrow("MARKET_OBSERVATION_STALE");
    expect(() => assertChallengeObservation(
      { ...observation, sessionState: "CLOSED" },
      {
        asOf: "2026-08-09T14:45:00.000Z", maxReceiptAgeSeconds: 60,
        allowlist, sourceRegistry: registry,
      },
    )).toThrow("MARKET_SESSION_CLOSED");
    expect(() => assertChallengeObservation(
      { ...observation, redistribution: "PROHIBITED" },
      {
        asOf: "2026-08-09T14:45:00.000Z", maxReceiptAgeSeconds: 60,
        allowlist, sourceRegistry: registry,
      },
    )).toThrow("MARKET_REDISTRIBUTION_FORBIDDEN");
    expect(() => assertChallengeObservation(observation, {
      asOf: "2026-08-09T14:44:59.999Z",
      maxReceiptAgeSeconds: 60,
      allowlist,
      sourceRegistry: registry,
    })).toThrow("MARKET_OBSERVATION_FROM_FUTURE");
    expect(() => assertChallengeObservation(
      { ...observation, price: "NaN" },
      {
        asOf: "2026-08-09T14:45:00.000Z", maxReceiptAgeSeconds: 60,
        allowlist, sourceRegistry: registry,
      },
    )).toThrow("MARKET_PRICE_INVALID");
    expect(() => assertChallengeObservation(
      { ...observation, symbol: "MSFT" },
      {
        asOf: "2026-08-09T14:45:00.000Z", maxReceiptAgeSeconds: 60,
        allowlist, sourceRegistry: registry,
      },
    )).toThrow("MARKET_NOT_ALLOWED");
    expect(() => assertChallengeObservation(
      { ...observation, feedStatus: "REALTIME", delaySeconds: 900 },
      {
        asOf: "2026-08-09T14:45:00.000Z", maxReceiptAgeSeconds: 60,
        allowlist, sourceRegistry: registry,
      },
    )).toThrow("MARKET_DELAY_INVALID");
    expect(() => assertChallengeObservation(
      {
        ...observation,
        observedAt: "2026-08-09T10:45:00.000Z",
        receivedAt: "2026-08-09T14:45:00.000Z",
        delaySeconds: 900,
      },
      {
        asOf: "2026-08-09T14:45:00.000Z", maxReceiptAgeSeconds: 60,
        allowlist, sourceRegistry: registry,
      },
    )).toThrow("MARKET_OBSERVATION_STALE");
    expect(() => assertChallengeObservation(observation, {
      asOf: "2026-08-09T14:46:00.000Z",
      maxReceiptAgeSeconds: 59,
      allowlist,
      sourceRegistry: registry,
    })).toThrow("MARKET_OBSERVATION_STALE");

    const forged = normalizeObservation({
      ...observationInput,
      provider: "forged-feed",
      licenseStatus: "LICENSED",
      licenseId: "forged-license",
      rawSourceRef: "forged:1",
    }, allowlist);
    expect(() => assertChallengeObservation(forged, {
      asOf: "2026-08-09T14:45:00.000Z",
      maxReceiptAgeSeconds: 60,
      allowlist,
      sourceRegistry: registry,
    })).toThrow("MARKET_SOURCE_UNLICENSED");
    const revokedRegistry = createTrustedSourceRegistry([{ ...sourceAuthority, active: false }]);
    expect(() => assertChallengeObservation(observation, {
      asOf: "2026-08-09T14:45:00.000Z",
      maxReceiptAgeSeconds: 60,
      allowlist,
      sourceRegistry: revokedRegistry,
    })).toThrow("MARKET_SOURCE_UNLICENSED");
    const changedRightsRegistry = createTrustedSourceRegistry([{
      ...sourceAuthority,
      redistribution: "PUBLIC",
    }]);
    expect(() => assertChallengeObservation(observation, {
      asOf: "2026-08-09T14:45:00.000Z",
      maxReceiptAgeSeconds: 60,
      allowlist,
      sourceRegistry: changedRightsRegistry,
    })).toThrow("MARKET_RIGHTS_MISMATCH");
    expect(() => assertChallengeObservation(observation, {
      asOf: "2026-08-09T14:45:00.000Z",
      maxReceiptAgeSeconds: 60,
      allowlist: new Set(["AAPL"]) as never,
      sourceRegistry: registry,
    })).toThrow("MARKET_ALLOWLIST_INVALID");
    const spyAsStock = { ...observation, symbol: "SPY", assetClass: "US_STOCK" as const };
    expect(() => assertChallengeObservation(spyAsStock, {
      asOf: "2026-08-09T14:45:00.000Z",
      maxReceiptAgeSeconds: 60,
      allowlist: new Map([["SPY", "US_ETF"]] as const),
      sourceRegistry: registry,
    })).toThrow("MARKET_NOT_ALLOWED");
  });

  it("persists canonical licensed observations and immutable completed bars", async () => {
    const db = await openTestDb();
    await db.query(
      `insert into market_instrument_allowlist(symbol, asset_class, enabled)
       values ('AAPL', 'US_STOCK', true)`,
    );
    await db.query(
      `insert into market_data_sources(provider, license_id, licensed, redistribution)
       values ('licensed-feed', 'us-equities-v1', true, 'ACCOUNT_ONLY')`,
    );
    const observationId = randomUUID();
    await db.query(
      `insert into market_observations (
         id, symbol, asset_class, price, observed_at, received_at, provider,
         license_id, raw_source_ref, feed_status, delay_seconds,
         redistribution, session_state
       ) values ($1, 'AAPL', 'US_STOCK', '225.10',
         '2026-08-09T14:30:00.000Z', '2026-08-09T14:45:00.000Z',
         'licensed-feed', 'us-equities-v1', 'sequence:42', 'DELAYED', 900,
         'ACCOUNT_ONLY', 'OPEN')`,
      [observationId],
    );
    const laterObservationId = randomUUID();
    await db.query(
      `insert into market_observations (
         id, symbol, asset_class, price, observed_at, received_at, provider,
         license_id, raw_source_ref, feed_status, delay_seconds,
         redistribution, session_state
       ) values ($1, 'AAPL', 'US_STOCK', '225.10',
         '2026-08-09T14:45:00.000Z', '2026-08-09T15:00:00.000Z',
         'licensed-feed', 'us-equities-v1', 'sequence:43', 'DELAYED', 900,
         'ACCOUNT_ONLY', 'OPEN')`,
      [laterObservationId],
    );
    await expect(db.query(
      "update market_observations set price='225.11' where id=$1",
      [observationId],
    )).rejects.toThrow("IMMUTABLE_MARKET_OBSERVATION");

    const completedId = randomUUID();
    const activeId = randomUUID();
    await db.query(
      `insert into market_bars (
         id, source_observation_id, symbol, asset_class, provider, timeframe,
         started_at, ended_at, open_price, high_price, low_price, close_price, completed
       ) values
       ($1, $3, 'AAPL', 'US_STOCK', 'licensed-feed', '15m',
        '2026-08-09T14:15:00.000Z', '2026-08-09T14:30:00.000Z',
        '223.00', '225.00', '222.50', '224.50', true),
       ($2, $3, 'AAPL', 'US_STOCK', 'licensed-feed', '15m',
        '2026-08-09T14:30:00.000Z', '2026-08-09T14:45:00.000Z',
        '224.50', '225.20', '224.00', '225.10', false)`,
      [completedId, activeId, observationId],
    );
    await expect(db.query(
      `insert into market_bars (
         id, source_observation_id, symbol, asset_class, provider, timeframe,
         started_at, ended_at, open_price, high_price, low_price, close_price, completed
       ) values ($1, $2, 'AAPL', 'US_STOCK', 'licensed-feed', '15m',
         '2026-08-09T14:45:00.000Z', '2026-08-09T15:00:00.000Z',
         '225.10', '225.30', '224.90', '225.20', false)`,
      [randomUUID(), observationId],
    )).rejects.toThrow(/market_one_active_bar_idx/);
    await expect(db.query(
      `insert into market_bars (
         id, source_observation_id, symbol, asset_class, provider, timeframe,
         started_at, ended_at, open_price, high_price, low_price, close_price, completed
       ) values ($1, $2, 'AAPL', 'US_STOCK', 'licensed-feed', '1h',
         '2026-08-09T14:00:00.000Z', '2026-08-09T14:45:00.000Z',
         '223.00', '225.20', '222.50', '225.10', true)`,
      [randomUUID(), observationId],
    )).rejects.toThrow("MARKET_COMPLETED_BAR_SOURCE_UNCONFIRMED");
    await expect(db.query(
      "update market_bars set close_price='224.51' where id=$1",
      [completedId],
    )).rejects.toThrow("IMMUTABLE_COMPLETED_MARKET_BAR");
    await expect(db.query(
      "update market_bars set completed=true where id=$1",
      [activeId],
    )).rejects.toThrow("MARKET_COMPLETED_BAR_SOURCE_UNCONFIRMED");
    await db.query(
      "update market_bars set source_observation_id=$2, completed=true where id=$1",
      [activeId, laterObservationId],
    );
    await expect(db.query(
      "delete from market_bars where id=$1",
      [activeId],
    )).rejects.toThrow("IMMUTABLE_COMPLETED_MARKET_BAR");
  }, 15_000);
});
