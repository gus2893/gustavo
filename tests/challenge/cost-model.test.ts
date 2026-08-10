import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  COST_POLICY_VERSION,
  calculateCommission,
  calculatePriceFill,
  calculateShortBorrow,
  commission,
  priceFill,
  shortBorrow,
  type PriceFillInput,
} from "../../lib/server/challenge/costs";

function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction] = (negative ? value.slice(1) : value).split(".");
  const amount = (BigInt(whole) * 100n) + BigInt(fraction);
  return negative ? -amount : amount;
}

describe("stock simulation costs v1", () => {
  it("charges per-share commission with a one dollar minimum", () => {
    expect(commission("10")).toBe("1.00");
    expect(commission("1000")).toBe("5.00");
  });

  it("accepts positive bounded fractional-share quantities", () => {
    expect(commission("201.5")).toBe("1.01");
    expect(calculateCommission("0201.50000000").inputs).toEqual({ shares: "201.5" });
  });

  it("applies observed ask or fallback half-spread plus adverse slippage", () => {
    expect(priceFill({ side: "BUY", reference: "100.00", ask: "100.02" })).toBe("100.07");
    expect(priceFill({ side: "BUY", reference: "100.00" })).toBe("100.10");
    expect(priceFill({ side: "SELL", reference: "100.00" })).toBe("99.90");
  });

  it("uses the observed bid for sells and records spread and slippage separately", () => {
    const result = calculatePriceFill({ side: "SELL", reference: "100.00", bid: "99.98" });

    expect(result.result).toBe("99.93");
    expect(result.components).toEqual({
      commission: "0.00",
      spread: "0.02",
      slippage: "0.05",
      borrow: "0.00",
    });
  });

  it("records the synthetic half-spread independently from adverse slippage", () => {
    expect(calculatePriceFill({ side: "BUY", reference: "100.00" })).toMatchObject({
      quoteSource: "SYNTHETIC_HALF_SPREAD",
      result: "100.10",
      components: {
        commission: "0.00",
        spread: "0.05",
        slippage: "0.05",
        borrow: "0.00",
      },
    });
    expect(calculatePriceFill({ side: "SELL", reference: "100.00" })).toMatchObject({
      quoteSource: "SYNTHETIC_HALF_SPREAD",
      result: "99.90",
      components: {
        commission: "0.00",
        spread: "0.05",
        slippage: "0.05",
        borrow: "0.00",
      },
    });
  });

  it.each([
    {
      name: "buy rounding residual",
      input: { side: "BUY" as const, reference: "10", ask: "10.006" },
      roundedReference: "10.00",
      result: "10.01",
      spread: "0.01",
      slippage: "0.00",
    },
    {
      name: "buy favorable observed ask",
      input: { side: "BUY" as const, reference: "100", ask: "99.98" },
      roundedReference: "100.00",
      result: "100.03",
      spread: "-0.02",
      slippage: "0.05",
    },
    {
      name: "sell favorable observed bid",
      input: { side: "SELL" as const, reference: "100", bid: "100.02" },
      roundedReference: "100.00",
      result: "99.97",
      spread: "-0.02",
      slippage: "0.05",
    },
    {
      name: "sell adverse observed bid",
      input: { side: "SELL" as const, reference: "100", bid: "99.98" },
      roundedReference: "100.00",
      result: "99.93",
      spread: "0.02",
      slippage: "0.05",
    },
    {
      name: "buy synthetic spread",
      input: { side: "BUY" as const, reference: "100" },
      roundedReference: "100.00",
      result: "100.10",
      spread: "0.05",
      slippage: "0.05",
    },
    {
      name: "sell synthetic spread",
      input: { side: "SELL" as const, reference: "100" },
      roundedReference: "100.00",
      result: "99.90",
      spread: "0.05",
      slippage: "0.05",
    },
    {
      name: "buy half-cent spread boundary",
      input: { side: "BUY" as const, reference: "10.004", ask: "10.009" },
      roundedReference: "10.00",
      result: "10.01",
      spread: "0.01",
      slippage: "0.00",
    },
    {
      name: "sell half-cent spread boundary",
      input: { side: "SELL" as const, reference: "10.004", bid: "9.999" },
      roundedReference: "10.00",
      result: "9.99",
      spread: "0.01",
      slippage: "0.00",
    },
  ])("reconciles $name components exactly at cent precision", ({
    input,
    roundedReference,
    result: expectedResult,
    spread: expectedSpread,
    slippage: expectedSlippage,
  }) => {
    const result = calculatePriceFill(input);
    const direction = input.side === "BUY" ? 1n : -1n;

    expect(result).toMatchObject({
      result: expectedResult,
      components: { spread: expectedSpread, slippage: expectedSlippage },
    });
    expect(cents(result.components.slippage)).toBeGreaterThanOrEqual(0n);
    expect(cents(result.result)).toBe(
      cents(roundedReference)
      + (direction * cents(result.components.spread))
      + (direction * cents(result.components.slippage)),
    );
  });

  it("rounds final monetary values half up to exactly two decimals", () => {
    expect(commission("200")).toBe("1.00");
    expect(commission("201")).toBe("1.01");
    expect(shortBorrow({ shortNotional: "100.10", utcDays: 365 })).toBe("5.01");

    for (const value of [
      commission("201"),
      priceFill({ side: "BUY", reference: "0.01" }),
      shortBorrow({ shortNotional: "100.10", utcDays: 365 }),
    ]) {
      expect(value).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("accrues five percent annualized short borrow by UTC day", () => {
    expect(shortBorrow({ shortNotional: "10000.00", utcDays: 1 })).toBe("1.37");
    expect(shortBorrow({ shortNotional: "10000.00", utcDays: 0 })).toBe("0.00");
  });

  it("exposes the profile cost-policy version, normalized inputs, and frozen records", () => {
    const input = { side: "BUY" as const, reference: "00100.0000", ask: "00100.0200" };
    const result = calculatePriceFill(input);

    input.ask = "999.00";
    expect(COST_POLICY_VERSION).toBe("stock-etf-cost-v1");
    expect(result).toMatchObject({
      policyVersion: COST_POLICY_VERSION,
      calculation: "PRICE_FILL",
      quoteSource: "OBSERVED_ASK",
      inputs: { side: "BUY", reference: "100", ask: "100.02", bid: null },
      result: "100.07",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(Object.isFrozen(result.components)).toBe(true);

    const commissionResult = calculateCommission("0010");
    expect(commissionResult).toMatchObject({
      policyVersion: COST_POLICY_VERSION,
      calculation: "COMMISSION",
      inputs: { shares: "10" },
      result: "1.00",
      components: { commission: "1.00", spread: "0.00", slippage: "0.00", borrow: "0.00" },
    });

    const borrowResult = calculateShortBorrow({ shortNotional: "010000.00", utcDays: 1 });
    expect(borrowResult).toMatchObject({
      policyVersion: COST_POLICY_VERSION,
      calculation: "SHORT_BORROW",
      inputs: { shortNotional: "10000", utcDays: 1 },
      result: "1.37",
      components: { commission: "0.00", spread: "0.00", slippage: "0.00", borrow: "1.37" },
    });
  });

  it("snapshots each price input property exactly once before validation", () => {
    const reads = new Map<PropertyKey, number>();
    const input = new Proxy({} as PriceFillInput, {
      get(_target, property) {
        const count = (reads.get(property) ?? 0) + 1;
        reads.set(property, count);
        if (property === "side") {
          return count === 1 ? "BUY" : "SELL";
        }
        if (property === "reference") {
          return "100.00";
        }
        if (property === "ask") {
          return count === 1 ? "100.02" : "99.00";
        }
        if (property === "bid") {
          return undefined;
        }
        return undefined;
      },
    });

    expect(calculatePriceFill(input)).toMatchObject({
      quoteSource: "OBSERVED_ASK",
      inputs: { side: "BUY", reference: "100", ask: "100.02", bid: null },
      result: "100.07",
    });
    expect(reads).toEqual(new Map<PropertyKey, number>([
      ["side", 1],
      ["reference", 1],
      ["ask", 1],
      ["bid", 1],
    ]));
  });

  it("snapshots each borrow input property exactly once before validation", () => {
    let shortNotionalReads = 0;
    let utcDayReads = 0;
    const input = {
      get shortNotional() {
        shortNotionalReads += 1;
        return shortNotionalReads === 1 ? "100.00" : "999999.00";
      },
      get utcDays() {
        utcDayReads += 1;
        if (utcDayReads <= 3) {
          return 1;
        }
        return utcDayReads === 4 ? 365 : 0;
      },
    };

    expect(calculateShortBorrow(input)).toMatchObject({
      inputs: { shortNotional: "100", utcDays: 1 },
      result: "0.01",
    });
    expect(shortNotionalReads).toBe(1);
    expect(utcDayReads).toBe(1);
  });

  it.each(["0", "-1", "NaN", "Infinity", "1e3", "1.2.3", "", " "])(
    "rejects invalid share quantity %j",
    (shares) => {
      expect(() => commission(shares)).toThrow();
    },
  );

  it("rejects invalid prices, quotes, directions, and oversized decimal input", () => {
    for (const reference of ["0", "-1", "NaN", "Infinity", "1e2", "", " "]) {
      expect(() => priceFill({ side: "BUY", reference })).toThrow();
    }
    expect(() => priceFill({ side: "BUY", reference: "100", ask: "0" })).toThrow();
    expect(() => priceFill({ side: "SELL", reference: "100", bid: "malformed" })).toThrow();
    expect(() => priceFill({ side: "HOLD" as "BUY", reference: "100" })).toThrow();
    expect(() => priceFill({ side: "BUY", reference: "1".repeat(100) })).toThrow();
    expect(() => priceFill({ side: "BUY", reference: `${"0".repeat(100)}1` })).toThrow();
  });

  it("rejects positive prices and quotes that round to zero cents", () => {
    expect(() => priceFill({ side: "BUY", reference: "0.004" }))
      .toThrowError("COST_REFERENCE_PRICE_BELOW_CENT_PRECISION");
    expect(() => priceFill({ side: "BUY", reference: "100", ask: "0.004" }))
      .toThrowError("COST_ASK_PRICE_BELOW_CENT_PRECISION");
    expect(() => priceFill({ side: "SELL", reference: "100", bid: "0.004" }))
      .toThrowError("COST_BID_PRICE_BELOW_CENT_PRECISION");
    expect(() => priceFill({ side: "SELL", reference: "0.005" }))
      .toThrowError("COST_FILL_PRICE_BELOW_CENT_PRECISION");
    expect(() => priceFill({ side: "SELL", reference: "100", bid: "0.005" }))
      .toThrowError("COST_FILL_PRICE_BELOW_CENT_PRECISION");
  });

  it("rejects invalid borrow inputs and enforces whole UTC days", () => {
    for (const shortNotional of ["0", "-1", "NaN", "Infinity", "1e4", "", " "]) {
      expect(() => shortBorrow({ shortNotional, utcDays: 1 })).toThrow();
    }
    for (const utcDays of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => shortBorrow({ shortNotional: "100", utcDays })).toThrow();
    }
    expect(() => shortBorrow({ shortNotional: "1".repeat(100), utcDays: 1 })).toThrow();
  });

  it("uses deterministic decimal arithmetic without clocks, randomness, or external calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const first = calculatePriceFill({ side: "BUY", reference: "999999999999.99" });
    const second = calculatePriceFill({ side: "BUY", reference: "999999999999.99" });
    const source = await readFile("lib/server/challenge/costs.ts", "utf8");

    expect(second).toEqual(first);
    expect(first.result).toBe("1001000249999.99");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(source).not.toMatch(/\b(?:Date|Math\.random|parseFloat|parseInt)\b/);
    fetchSpy.mockRestore();
  });
});
