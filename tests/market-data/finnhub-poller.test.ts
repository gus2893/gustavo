import { describe, expect, expectTypeOf, it } from "vitest";
import { MARKET_UNIVERSE } from "../../config/market-universe";
import { createMarketWindowPlan } from "../../lib/server/market-data/session";

const EXPECTED_STOCKS = "AAPL, MSFT, NVDA, AMZN, GOOGL, GOOG, META, TSLA, BRK.B, AVGO, JPM, LLY, V, XOM, MA, UNH, COST, WMT, NFLX, ORCL, HD, PG, JNJ, BAC, ABBV, KO, CRM, CVX, MRK, AMD, PLTR, CSCO, ACN, MCD, IBM, GE, CAT, GS, MS, AXP, BX, TMO, ISRG, LIN, ABT, DIS, NOW, QCOM, TXN, AMGN, DHR, PEP, PM, INTU, BKNG, RTX, AMAT, SPGI, NEE, LOW, UPS, HON, PFE, C, MU, SBUX, COP, SCHW, GILD, ADP, DE, BLK, PANW, LRCX, KLAC".split(", ");
const EXPECTED_ETFS = "SPY, QQQ, DIA, IWM, VTI, VO, VB, VOO, IVV, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, ARKK".split(", ");

describe("Finnhub market window", () => {
  it("freezes the approved 75 stocks and 20 ETFs within 96 calls and 300 seconds", () => {
    const plan = createMarketWindowPlan(new Date("2026-08-13T13:30:00.000Z"));
    const stocks = MARKET_UNIVERSE.filter((item) => item.kind === "STOCK");
    const etfs = MARKET_UNIVERSE.filter((item) => item.kind === "ETF");

    expect(MARKET_UNIVERSE).toHaveLength(95);
    expect(stocks).toHaveLength(75);
    expect(etfs).toHaveLength(20);
    expect(stocks.map((item) => item.symbol)).toEqual(EXPECTED_STOCKS);
    expect(etfs.map((item) => item.symbol)).toEqual(EXPECTED_ETFS);
    expect(new Set(MARKET_UNIVERSE.map((item) => item.symbol)).size).toBe(95);
    expect(MARKET_UNIVERSE[0]?.symbol).toBe("AAPL");
    expect(MARKET_UNIVERSE.at(-1)?.symbol).toBe("ARKK");

    expect(plan.marketOpen).toBe(true);
    expect(plan.totalCalls).toBe(96);
    expect(plan.resultCount).toBe(95);
    expect(plan.marketStatusStart.toISOString()).toBe("2026-08-13T13:30:00.000Z");
    expect(plan.windowEndsAt.getTime() - plan.windowStartsAt.getTime()).toBe(300_000);
    expect(plan.quoteStarts).toHaveLength(95);
    expect(plan.quoteStarts[0]!.getTime() - plan.windowStartsAt.getTime()).toBe(3_000);
    expect(plan.quoteStarts.at(-1)!.getTime() - plan.windowStartsAt.getTime()).toBe(285_000);
    expect(plan.quoteStarts.at(-1)!.getTime() - plan.quoteStarts[0]!.getTime()).toBe(282_000);
    expect(plan.quoteStarts.every((time, index, all) => (
      index === 0 || time.getTime() - all[index - 1]!.getTime() >= 3_000
    ))).toBe(true);
  });

  it("contains no duplicate, malformed, unsupported, or mutable catalog entries", () => {
    const approved = [...EXPECTED_STOCKS, ...EXPECTED_ETFS];
    expect(MARKET_UNIVERSE.map((item) => item.symbol)).toEqual(approved);
    expect(MARKET_UNIVERSE.every((item) => /^[A-Z][A-Z0-9.]*$/.test(item.symbol))).toBe(true);
    expect(MARKET_UNIVERSE.every((item) => item.symbol === item.symbol.trim())).toBe(true);
    expect(MARKET_UNIVERSE.every((item) => (
      Object.keys(item).sort().join(",") === "kind,symbol"
    ))).toBe(true);
    expect(Object.isFrozen(MARKET_UNIVERSE)).toBe(true);
    expect(MARKET_UNIVERSE.every(Object.isFrozen)).toBe(true);

    const first = MARKET_UNIVERSE[0]!;
    expect(Reflect.set(first, "symbol", "TSLA")).toBe(false);
    expect(Reflect.set(MARKET_UNIVERSE, MARKET_UNIVERSE.length, {
      symbol: "BTCUSD",
      kind: "STOCK",
    })).toBe(false);
    expect(MARKET_UNIVERSE[0]).toEqual({ symbol: "AAPL", kind: "STOCK" });
    expect(MARKET_UNIVERSE).toHaveLength(95);

    expectTypeOf(MARKET_UNIVERSE).toMatchTypeOf<
      readonly Readonly<{ readonly symbol: string; readonly kind: "STOCK" | "ETF" }>[]
    >();
    if (false) {
      // @ts-expect-error the exported catalog cannot be extended
      MARKET_UNIVERSE.push({ symbol: "BTCUSD", kind: "STOCK" });
      // @ts-expect-error catalog entries are read-only
      MARKET_UNIVERSE[0].symbol = "TSLA";
    }
  });

  it("returns an explicit no-quote plan outside the regular US session", () => {
    for (const instant of [
      "2026-08-13T13:29:59.999Z", // 09:29:59.999 EDT
      "2026-08-13T20:00:00.000Z", // 16:00 EDT
      "2026-08-15T14:00:00.000Z", // Saturday
    ]) {
      const plan = createMarketWindowPlan(new Date(instant));
      expect(plan.marketOpen).toBe(false);
      expect(plan.totalCalls).toBe(1);
      expect(plan.resultCount).toBe(95);
      expect(plan.quoteStarts).toEqual([]);
      expect(plan.marketStatusStart.toISOString()).toBe(instant);
    }
  });

  it("uses New York clock boundaries across daylight-saving changes", () => {
    const summerOpen = createMarketWindowPlan(new Date("2026-08-13T13:30:00.000Z"));
    const winterOpen = createMarketWindowPlan(new Date("2026-01-05T14:30:00.000Z"));
    const summerLastMoment = createMarketWindowPlan(new Date("2026-08-13T19:59:59.999Z"));
    const winterLastMoment = createMarketWindowPlan(new Date("2026-01-05T20:59:59.999Z"));

    expect([summerOpen, winterOpen, summerLastMoment, winterLastMoment]
      .every((plan) => plan.marketOpen)).toBe(true);
    expect(createMarketWindowPlan(new Date("2026-01-05T21:00:00.000Z")).marketOpen).toBe(false);
  });

  it("rejects invalid clocks and does not mutate its input or leak mutable schedule state", () => {
    expect(() => createMarketWindowPlan(new Date(Number.NaN))).toThrow("MARKET_WINDOW_START_INVALID");

    const input = new Date("2026-08-13T13:30:00.000Z");
    const plan = createMarketWindowPlan(input);
    input.setTime(0);
    const returnedStarts = plan.quoteStarts;
    returnedStarts[0]!.setTime(0);

    expect(plan.windowStartsAt.toISOString()).toBe("2026-08-13T13:30:00.000Z");
    expect(plan.quoteStarts[0]!.toISOString()).toBe("2026-08-13T13:30:03.000Z");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.quoteStarts)).toBe(true);
  });
});
