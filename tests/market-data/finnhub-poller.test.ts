import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { MARKET_UNIVERSE } from "../../config/market-universe";
import {
  createFinnhubHttpClient,
  pollFinnhubWindow,
} from "../../lib/server/market-data/finnhub";
import { createMarketWindowPlan } from "../../lib/server/market-data/session";

const EXPECTED_STOCKS = "AAPL, MSFT, NVDA, AMZN, GOOGL, GOOG, META, TSLA, BRK.B, AVGO, JPM, LLY, V, XOM, MA, UNH, COST, WMT, NFLX, ORCL, HD, PG, JNJ, BAC, ABBV, KO, CRM, CVX, MRK, AMD, PLTR, CSCO, ACN, MCD, IBM, GE, CAT, GS, MS, AXP, BX, TMO, ISRG, LIN, ABT, DIS, NOW, QCOM, TXN, AMGN, DHR, PEP, PM, INTU, BKNG, RTX, AMAT, SPGI, NEE, LOW, UPS, HON, PFE, C, MU, SBUX, COP, SCHW, GILD, ADP, DE, BLK, PANW, LRCX, KLAC".split(", ");
const EXPECTED_ETFS = "SPY, QQQ, DIA, IWM, VTI, VO, VB, VOO, IVV, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, ARKK".split(", ");

function jsonHttpResponse(payload: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return new Response(bytes, {
    status,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

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

describe("Finnhub adapter", () => {
  it("returns exactly 95 bounded results and never starts call 97", async () => {
    const starts: number[] = [];
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string) => {
      starts.push(now);
      return symbol === "BRK.B"
        ? { status: 429 as const }
        : { status: 200 as const, json: { c: 100.25, t: 1_776_089_600 } };
    });
    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      timeoutMs: 2_500,
    });

    expect(result.items).toHaveLength(95);
    expect(fetchQuote).toHaveBeenCalledTimes(95);
    expect(starts.every((value, index) => index === 0 || value - starts[index - 1]! >= 3_000)).toBe(true);
    expect(result.items.find((item) => item.symbol === "BRK.B")?.status).toBe("RATE_LIMITED");
    expect(result.callsUsed).toBe(96);
  });

  it("returns the fixed ordered catalog and uses only the market-status call when closed", async () => {
    const fetchQuote = vi.fn();
    const sleep = vi.fn();

    const result = await pollFinnhubWindow({
      marketOpen: false,
      fetchQuote,
      sleep,
      now: () => 0,
      timeoutMs: 2_500,
    });

    expect(result.callsUsed).toBe(1);
    expect(result.items.map((item) => item.symbol)).toEqual(
      MARKET_UNIVERSE.map((item) => item.symbol),
    );
    expect(result.items).toHaveLength(95);
    expect(result.items.every((item) => (
      item.status === "UNAVAILABLE"
      && item.price === null
      && item.sourceObservedAt === null
      && item.safeCode === "MARKET_CLOSED"
    ))).toBe(true);
    expect(fetchQuote).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("paces all starts at least three seconds apart and aborts a quote below three seconds", async () => {
    let now = 0;
    const starts: number[] = [];
    const signals: AbortSignal[] = [];
    const fetchQuote = vi.fn((symbol: string, signal: AbortSignal) => {
      starts.push(now);
      signals.push(signal);
      if (symbol !== "AAPL") {
        return Promise.resolve({ status: 200, json: { c: 10, t: 1_776_089_600 } });
      }
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("private timeout detail")), {
          once: true,
        });
      });
    });

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 5,
    });

    expect(fetchQuote).toHaveBeenCalledTimes(95);
    expect(starts[0]).toBeGreaterThanOrEqual(3_000);
    expect(starts.every((value, index) => (
      index === 0 || value - starts[index - 1]! >= 3_000
    ))).toBe(true);
    expect(signals).toHaveLength(95);
    expect(signals[0]?.aborted).toBe(true);
    expect(result.items[0]).toMatchObject({
      symbol: "AAPL",
      status: "PROVIDER_ERROR",
      safeCode: "PROVIDER_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain("private timeout detail");
  });

  it("maps unavailable, stale, rate-limited, malformed, and network results without dropping symbols", async () => {
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string) => {
      switch (symbol) {
        case "AAPL": return { status: 200, json: { c: 225.1, t: 200 } };
        case "MSFT": return { status: 200, json: { c: 0, t: 200 } };
        case "NVDA": return { status: 200, json: { t: 200 } };
        case "AMZN": return { status: 200, json: { c: 10, t: 99 } };
        case "GOOGL": return { status: 404, json: { error: "unknown symbol" } };
        case "GOOG": return { status: 429, json: { error: "limit" } };
        case "META": return { status: 200, json: "not-json-object" };
        case "TSLA": return { status: 200, malformed: true };
        case "BRK.B": throw new Error("network url token=private-key");
        case "AVGO": return { status: 200, json: { c: 0.000_000_001, t: 200 } };
        default: return { status: 503, json: { error: "downstream detail" } };
      }
    });

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 2_500,
      minimumSourceTimestampSeconds: 100,
    });

    expect(result.items).toHaveLength(95);
    expect(result.items.map((item) => item.symbol)).toEqual(
      MARKET_UNIVERSE.map((item) => item.symbol),
    );
    expect(result.items[0]).toMatchObject({
      symbol: "AAPL",
      kind: "STOCK",
      status: "SUCCESS",
      price: "225.1",
      sourceObservedAt: "1970-01-01T00:03:20.000Z",
      safeCode: null,
    });
    for (const symbol of ["MSFT", "NVDA", "GOOGL"]) {
      expect(result.items.find((item) => item.symbol === symbol)).toMatchObject({
        status: "UNAVAILABLE",
        safeCode: "SYMBOL_UNAVAILABLE",
      });
    }
    expect(result.items.find((item) => item.symbol === "AMZN")).toMatchObject({
      status: "UNAVAILABLE",
      safeCode: "STALE_QUOTE",
    });
    expect(result.items.find((item) => item.symbol === "GOOG")).toMatchObject({
      status: "RATE_LIMITED",
      safeCode: "RATE_LIMITED",
    });
    for (const symbol of ["META", "TSLA", "AVGO"]) {
      expect(result.items.find((item) => item.symbol === symbol)).toMatchObject({
        status: "PROVIDER_ERROR",
        safeCode: "MALFORMED_RESPONSE",
      });
    }
    expect(result.items.find((item) => item.symbol === "BRK.B")).toMatchObject({
      status: "PROVIDER_ERROR",
      safeCode: "PROVIDER_ERROR",
    });
    expect(JSON.stringify(result)).not.toMatch(/private-key|downstream detail|unknown symbol/);
  });

  it("finalizes every missing symbol after a pacing failure without spending unmade calls", async () => {
    let now = 0;
    let sleepCount = 0;
    const fetchQuote = vi.fn(async () => ({
      status: 200,
      json: { c: 10, t: 1_776_089_600 },
    }));

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => {
        sleepCount += 1;
        if (sleepCount === 3) throw new Error("scheduler private detail");
        now += milliseconds;
      },
      now: () => now,
      wallNow: () => 1_776_089_600_000,
      timeoutMs: 2_500,
    });

    expect(result.items).toHaveLength(95);
    expect(result.items.map((item) => item.symbol)).toEqual(
      MARKET_UNIVERSE.map((item) => item.symbol),
    );
    expect(fetchQuote).toHaveBeenCalledTimes(2);
    expect(result.callsUsed).toBe(3);
    expect(result.items.slice(0, 2).every((item) => item.status === "SUCCESS")).toBe(true);
    expect(result.items.slice(2).every((item) => (
      item.status === "PROVIDER_ERROR" && item.safeCode === "PROVIDER_ERROR"
    ))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("scheduler private detail");
  });

  it("does not start a quote after the fixed five-minute window deadline", async () => {
    let now = 0;
    const fetchQuote = vi.fn(async () => ({
      status: 200,
      json: { c: 10, t: 1_776_089_600 },
    }));

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds + 300_000; },
      now: () => now,
      timeoutMs: 2_500,
    });

    expect(fetchQuote).not.toHaveBeenCalled();
    expect(result.callsUsed).toBe(1);
    expect(result.items).toHaveLength(95);
    expect(result.items.every((item) => (
      item.status === "PROVIDER_ERROR" && item.safeCode === "PROVIDER_ERROR"
    ))).toBe(true);
  });

  it("maps an injected provider status call before deciding whether quotes may start", async () => {
    let now = 0;
    const fetchMarketStatus = vi.fn(async () => ({
      status: 200,
      json: { isOpen: false },
    }));
    const fetchQuote = vi.fn();

    const result = await pollFinnhubWindow({
      fetchMarketStatus,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 2_500,
    });

    expect(fetchMarketStatus).toHaveBeenCalledOnce();
    expect(fetchQuote).not.toHaveBeenCalled();
    expect(result.callsUsed).toBe(1);
    expect(result.items.every((item) => item.safeCode === "MARKET_CLOSED")).toBe(true);
  });

  it("accepts only bounded future skew within the active window", async () => {
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string) => {
      if (symbol === "AAPL") return { status: 200, json: { c: 10, t: 8 } };
      if (symbol === "MSFT") return { status: 200, json: { c: 10, t: 12 } };
      return { status: 200, json: { c: 10, t: Math.floor(now / 1_000) } };
    });

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      wallNow: () => now,
      timeoutMs: 2_500,
    });

    expect(result.items.find((item) => item.symbol === "AAPL")).toMatchObject({
      status: "SUCCESS",
      sourceObservedAt: "1970-01-01T00:00:08.000Z",
      safeCode: null,
    });
    expect(result.items.find((item) => item.symbol === "MSFT")).toMatchObject({
      status: "PROVIDER_ERROR",
      sourceObservedAt: null,
      safeCode: "MALFORMED_RESPONSE",
    });
  });

  it("defaults the stale floor to the source window while preserving an explicit override", async () => {
    let pacingNow = 0;
    const sourceWindowStartedAt = 100_000;
    const fetchQuote = vi.fn(async (symbol: string) => ({
      status: 200,
      json: { c: 10, t: symbol === "AAPL" ? 99 : 100 },
    }));

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { pacingNow += milliseconds; },
      now: () => pacingNow,
      wallNow: () => sourceWindowStartedAt,
      timeoutMs: 2_500,
    });

    expect(result.items.find((item) => item.symbol === "AAPL")).toMatchObject({
      status: "UNAVAILABLE",
      sourceObservedAt: null,
      safeCode: "STALE_QUOTE",
    });
    expect(result.items.find((item) => item.symbol === "MSFT")).toMatchObject({
      status: "SUCCESS",
      sourceObservedAt: "1970-01-01T00:01:40.000Z",
      safeCode: null,
    });

    const overridden = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { pacingNow += milliseconds; },
      now: () => pacingNow,
      wallNow: () => sourceWindowStartedAt,
      timeoutMs: 2_500,
      minimumSourceTimestampSeconds: 99,
    });
    expect(overridden.items.find((item) => item.symbol === "AAPL")?.status).toBe("SUCCESS");
  });

  it("contains hostile fulfilled provider values as safe malformed results", async () => {
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string): Promise<unknown> => {
      if (symbol === "AAPL") return null;
      if (symbol === "MSFT") return 7;
      if (symbol === "NVDA") {
        return Object.defineProperty({}, "status", {
          get() { throw new Error("private status getter detail"); },
        });
      }
      if (symbol === "AMZN") {
        return Object.defineProperty({ status: 200 }, "json", {
          get() { throw new Error("private json getter detail"); },
        });
      }
      if (symbol === "GOOGL") {
        return new Proxy({}, {
          getPrototypeOf() { throw new Error("private proxy detail"); },
        });
      }
      if (symbol === "GOOG") {
        return {
          status: 200,
          json: new Proxy({}, {
            getOwnPropertyDescriptor() { throw new Error("private nested proxy detail"); },
          }),
        };
      }
      return { status: 200, json: { c: 10, t: Math.floor(now / 1_000) } };
    });

    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 2_500,
    });

    for (const symbol of ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG"]) {
      expect(result.items.find((item) => item.symbol === symbol)).toMatchObject({
        status: "PROVIDER_ERROR",
        price: null,
        sourceObservedAt: null,
        safeCode: "MALFORMED_RESPONSE",
      });
    }
    expect(JSON.stringify(result)).not.toMatch(/private status|private json|private (?:nested )?proxy/);

    const statusResult = await pollFinnhubWindow({
      fetchMarketStatus: async () => new Proxy({}, {
        getPrototypeOf() { throw new Error("private status proxy detail"); },
      }),
      fetchQuote: vi.fn(),
      sleep: async () => undefined,
      now: () => 0,
      timeoutMs: 2_500,
    });
    expect(statusResult.items.every((item) => (
      item.status === "PROVIDER_ERROR" && item.safeCode === "MALFORMED_RESPONSE"
    ))).toBe(true);
  });

  it("bounds streamed HTTP JSON and cancels every rejected body exactly once", async () => {
    const encoder = new TextEncoder();
    const makeStreamResponse = (
      chunks: readonly Uint8Array[],
      headers: HeadersInit,
      status = 200,
    ) => {
      let index = 0;
      const cancel = vi.fn(async () => undefined);
      const read = vi.fn(async () => (
        index < chunks.length
          ? { done: false as const, value: chunks[index++]! }
          : { done: true as const, value: undefined }
      ));
      const body = {
        cancel,
        getReader: () => ({ read, cancel, releaseLock: vi.fn() }),
      };
      return {
        cancel,
        response: {
          status,
          headers: new Headers(headers),
          body,
          get json(): never { throw new Error("response.json must not be called"); },
        } as unknown as Response,
      };
    };

    const successBytes = encoder.encode('{"c":12.5,"t":200}');
    const success = makeStreamResponse(
      [successBytes],
      { "content-length": String(successBytes.byteLength) },
    );
    const noLength = makeStreamResponse([encoder.encode("{}")], {});
    const chunked = makeStreamResponse(
      [encoder.encode("{}")],
      { "content-length": "2", "transfer-encoding": "chunked" },
    );
    const oversizedHeader = makeStreamResponse(
      [encoder.encode("{}")],
      { "content-length": "5000" },
    );
    const oversizedActual = makeStreamResponse(
      [new Uint8Array(5_000)],
      { "content-length": "2" },
    );
    const invalidUtf8 = makeStreamResponse(
      [Uint8Array.of(0xff)],
      { "content-length": "1" },
    );
    const invalidJson = makeStreamResponse(
      [encoder.encode("{")],
      { "content-length": "1" },
    );
    const nonSuccess = makeStreamResponse(
      [encoder.encode("provider private detail")],
      {},
      429,
    );
    const queued = [
      success,
      noLength,
      chunked,
      oversizedHeader,
      oversizedActual,
      invalidUtf8,
      invalidJson,
      nonSuccess,
    ];
    const client = createFinnhubHttpClient({
      fetch: vi.fn(async () => queued.shift()!.response),
      readApiKey: () => "bounded-private-key",
    });

    await expect(client.fetchQuote("AAPL")).resolves.toEqual({
      status: 200,
      json: { c: 12.5, t: 200 },
    });
    for (const symbol of ["MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META"]) {
      await expect(client.fetchQuote(symbol)).resolves.toEqual({
        status: 200,
        malformed: true,
      });
    }
    await expect(client.fetchQuote("TSLA")).resolves.toEqual({ status: 429 });

    expect(success.cancel).not.toHaveBeenCalled();
    for (const rejected of [
      noLength,
      chunked,
      oversizedHeader,
      oversizedActual,
      invalidUtf8,
      invalidJson,
      nonSuccess,
    ]) {
      expect(rejected.cancel).toHaveBeenCalledOnce();
    }
  });

  it("reads the API key at request time and keeps it out of URLs, results, and provider errors", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const keys = ["first-private-key", "second-private-key", "third-private-key"];
    let keyIndex = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (requests.length === 3) throw new Error(`provider leaked ${keys[2]}`);
      return jsonHttpResponse(requests.length === 1 ? { isOpen: true } : { c: 12.5, t: 200 });
    });
    const client = createFinnhubHttpClient({
      fetch: fetchImpl,
      readApiKey: () => keys[keyIndex++] ?? keys.at(-1),
    });

    const status = await client.fetchMarketStatus();
    const quote = await client.fetchQuote("AAPL");
    const failure = await client.fetchQuote("MSFT");

    expect(requests.map((request) => request.url)).toEqual([
      "https://finnhub.io/api/v1/stock/market-status?exchange=US",
      "https://finnhub.io/api/v1/quote?symbol=AAPL",
      "https://finnhub.io/api/v1/quote?symbol=MSFT",
    ]);
    expect(requests.map((request) => new Headers(request.init?.headers).get("X-Finnhub-Token")))
      .toEqual(keys);
    expect(JSON.stringify({ status, quote, failure, requests: requests.map(({ url }) => url) }))
      .not.toMatch(/first-private-key|second-private-key|third-private-key/);
    expect(failure).toEqual({ status: 0 });

    const callsBeforeInvalidSymbol = fetchImpl.mock.calls.length;
    await expect(client.fetchQuote("AAPL&token=exfiltrate")).resolves.toEqual({ status: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(callsBeforeInvalidSymbol);
    expect(Object.keys(client).sort()).toEqual(["fetchMarketStatus", "fetchQuote"]);
  });

  it("rejects unsafe bounds and returns immutable result snapshots without fallback configuration", async () => {
    const fetchQuote = vi.fn(async () => ({
      status: 200,
      json: { c: 10, t: 1_776_089_600 },
    }));
    const common = {
      marketOpen: true as const,
      fetchQuote,
      sleep: async () => undefined,
      now: () => 1_000_000,
    };

    for (const timeoutMs of [0, 3_000, Number.NaN, 2_500.5]) {
      await expect(pollFinnhubWindow({ ...common, timeoutMs })).rejects.toThrow(
        "FINNHUB_POLL_CONFIG_INVALID",
      );
    }
    await expect(pollFinnhubWindow({
      ...common,
      timeoutMs: 2_500,
      minimumSourceTimestampSeconds: -1,
    })).rejects.toThrow("FINNHUB_POLL_CONFIG_INVALID");

    let now = 0;
    const result = await pollFinnhubWindow({
      ...common,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      timeoutMs: 2_500,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(result.items.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(result, "callsUsed", 97)).toBe(false);
    expect(Reflect.set(result.items[0]!, "symbol", "BTCUSD")).toBe(false);
    expect(fetchQuote).toHaveBeenCalledTimes(95);
  });
});
