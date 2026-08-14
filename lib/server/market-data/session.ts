import { MARKET_UNIVERSE } from "../../../config/market-universe";
import type { FinnhubPollItem } from "./finnhub";

export const MARKET_WINDOW_DURATION_MS = 300_000 as const;
export const MARKET_REQUEST_INTERVAL_MS = 3_000 as const;
export const MARKET_MAX_CALLS_PER_WINDOW = 96 as const;
export const MARKET_RESULTS_PER_WINDOW = 95 as const;

export type MarketPollWindowSafeCode =
  | "MARKET_CLOSED"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "RESULT_COUNT_INVALID"
  | "CALL_LIMIT_EXCEEDED"
  | "WINDOW_CONFLICT";

export interface MarketPollWindowInput {
  readonly windowId: string;
  readonly callsUsed: number;
  readonly items: readonly FinnhubPollItem[];
}

export interface PersistableMarketPollWindow {
  readonly windowId: string;
  readonly status: "COMPLETED" | "FAILED";
  readonly providerStatus: "OPEN" | "CLOSED" | "ERROR";
  readonly callsUsed: number;
  readonly resultCount: number;
  readonly safeCode: MarketPollWindowSafeCode | null;
  readonly items: readonly FinnhubPollItem[];
  readonly mutateLatest: boolean;
  readonly nextWindowPending: boolean;
}

export interface MarketWindowPlan {
  readonly marketOpen: boolean;
  readonly totalCalls: 1 | typeof MARKET_MAX_CALLS_PER_WINDOW;
  readonly resultCount: typeof MARKET_RESULTS_PER_WINDOW;
  readonly windowStartsAt: Date;
  readonly windowEndsAt: Date;
  readonly marketStatusStart: Date;
  readonly quoteStarts: readonly Date[];
}

const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const OPEN_WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

function regularSessionIsOpen(instant: Date): boolean {
  const parts = new Map(newYorkClock.formatToParts(instant).map((part) => [part.type, part.value]));
  const weekday = parts.get("weekday");
  const hour = Number(parts.get("hour"));
  const minute = Number(parts.get("minute"));
  if (!weekday || !OPEN_WEEKDAYS.has(weekday)
    || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    return false;
  }
  const minuteOfDay = hour * 60 + minute;
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
}

function dateSnapshot(milliseconds: number): Date {
  return Object.freeze(new Date(milliseconds));
}

function fixedWindowStart(windowId: string): Date | undefined {
  if (typeof windowId !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/u.test(windowId)) return undefined;
  const instant = new Date(`${windowId.slice(0, -1)}:00.000Z`);
  if (!Number.isFinite(instant.getTime())
    || instant.getUTCSeconds() !== 0
    || instant.getUTCMilliseconds() !== 0
    || instant.getUTCMinutes() % 5 !== 0
    || instant.toISOString().slice(0, 16) !== windowId.slice(0, 16)) return undefined;
  return instant;
}

export function marketWindowStart(windowId: string): Date {
  const start = fixedWindowStart(windowId);
  if (!start) throw new Error("MARKET_WINDOW_ID_INVALID");
  return dateSnapshot(start.getTime());
}

export function marketWindowId(instant: Date): string {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new Error("MARKET_WINDOW_START_INVALID");
  }
  const start = Math.floor(instant.getTime() / MARKET_WINDOW_DURATION_MS)
    * MARKET_WINDOW_DURATION_MS;
  return new Date(start).toISOString().slice(0, 16) + "Z";
}

function unavailableItem(
  catalog: (typeof MARKET_UNIVERSE)[number],
): FinnhubPollItem {
  return Object.freeze({
    symbol: catalog.symbol,
    kind: catalog.kind,
    status: "PROVIDER_ERROR",
    price: null,
    sourceObservedAt: null,
    safeCode: "PROVIDER_ERROR",
  });
}

function validPollItem(
  value: FinnhubPollItem | undefined,
  catalog: (typeof MARKET_UNIVERSE)[number],
  windowStartedAt: number,
): value is FinnhubPollItem {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",")
      !== "kind,price,safeCode,sourceObservedAt,status,symbol"
    || value.symbol !== catalog.symbol || value.kind !== catalog.kind) return false;
  if (value.status === "SUCCESS") {
    if (typeof value.price !== "string"
      || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/u.test(value.price)
      || !/[1-9]/u.test(value.price.replace(".", ""))
      || typeof value.sourceObservedAt !== "string"
      || value.safeCode !== null) return false;
    const observed = new Date(value.sourceObservedAt);
    return Number.isFinite(observed.getTime())
      && observed.toISOString() === value.sourceObservedAt
      && observed.getTime() >= windowStartedAt
      && observed.getTime() < windowStartedAt + MARKET_WINDOW_DURATION_MS;
  }
  if (value.price !== null || value.sourceObservedAt !== null) return false;
  if (value.status === "RATE_LIMITED") return value.safeCode === "RATE_LIMITED";
  if (value.status === "PROVIDER_ERROR") {
    return value.safeCode === "PROVIDER_ERROR" || value.safeCode === "MALFORMED_RESPONSE";
  }
  return value.status === "UNAVAILABLE"
    && (value.safeCode === "MARKET_CLOSED"
      || value.safeCode === "SYMBOL_UNAVAILABLE"
      || value.safeCode === "STALE_QUOTE");
}

function safeItems(input: readonly FinnhubPollItem[], windowStartedAt: number): {
  readonly items: readonly FinnhubPollItem[];
  readonly validCount: number;
  readonly exact: boolean;
} {
  try {
    if (!Array.isArray(input)) {
      return { items: Object.freeze(MARKET_UNIVERSE.map(unavailableItem)), validCount: 0, exact: false };
    }
    let validCount = 0;
    const items = MARKET_UNIVERSE.map((catalog, index) => {
      const item = input[index];
      if (!validPollItem(item, catalog, windowStartedAt)) return unavailableItem(catalog);
      validCount += 1;
      return Object.freeze({
        symbol: catalog.symbol,
        kind: catalog.kind,
        status: item.status,
        price: item.price,
        sourceObservedAt: item.sourceObservedAt,
        safeCode: item.safeCode,
      });
    });
    return Object.freeze({
      items: Object.freeze(items),
      validCount,
      exact: input.length === MARKET_RESULTS_PER_WINDOW
        && validCount === MARKET_RESULTS_PER_WINDOW,
    });
  } catch {
    return Object.freeze({
      items: Object.freeze(MARKET_UNIVERSE.map(unavailableItem)),
      validCount: 0,
      exact: false,
    });
  }
}

function failedWindow(
  windowId: string,
  callsUsed: number,
  resultCount: number,
  items: readonly FinnhubPollItem[],
  safeCode: Exclude<MarketPollWindowSafeCode, "MARKET_CLOSED">,
): PersistableMarketPollWindow {
  return Object.freeze({
    windowId,
    status: "FAILED",
    providerStatus: "ERROR",
    callsUsed,
    resultCount,
    safeCode,
    items,
    mutateLatest: false,
    nextWindowPending: true,
  });
}

export function finalizeMarketPollWindow(
  expectedWindowId: string,
  input: MarketPollWindowInput,
): PersistableMarketPollWindow {
  const windowStartedAt = marketWindowStart(expectedWindowId).getTime();
  let receivedWindowId: unknown;
  let callsUsed: unknown;
  let receivedItems: readonly FinnhubPollItem[] = [];
  try {
    receivedWindowId = input?.windowId;
    callsUsed = input?.callsUsed;
    receivedItems = input?.items;
  } catch {
    return failedWindow(
      expectedWindowId, 0, 0,
      Object.freeze(MARKET_UNIVERSE.map(unavailableItem)),
      "PROVIDER_ERROR",
    );
  }
  const normalized = safeItems(receivedItems, windowStartedAt);
  if (receivedWindowId !== expectedWindowId) {
    return failedWindow(expectedWindowId, 0, normalized.validCount, normalized.items, "WINDOW_CONFLICT");
  }
  if (!Number.isSafeInteger(callsUsed) || (callsUsed as number) < 0) {
    return failedWindow(expectedWindowId, 0, normalized.validCount, normalized.items, "PROVIDER_ERROR");
  }
  if ((callsUsed as number) > MARKET_MAX_CALLS_PER_WINDOW) {
    return failedWindow(
      expectedWindowId,
      MARKET_MAX_CALLS_PER_WINDOW,
      normalized.validCount,
      normalized.items,
      "CALL_LIMIT_EXCEEDED",
    );
  }
  if (!normalized.exact) {
    return failedWindow(
      expectedWindowId,
      callsUsed as number,
      normalized.validCount,
      normalized.items,
      "RESULT_COUNT_INVALID",
    );
  }

  const allClosed = normalized.items.every((item) => (
    item.status === "UNAVAILABLE" && item.safeCode === "MARKET_CLOSED"
  ));
  if (callsUsed === 1 && allClosed) {
    return Object.freeze({
      windowId: expectedWindowId,
      status: "COMPLETED",
      providerStatus: "CLOSED",
      callsUsed: 1,
      resultCount: MARKET_RESULTS_PER_WINDOW,
      safeCode: "MARKET_CLOSED",
      items: normalized.items,
      mutateLatest: true,
      nextWindowPending: false,
    });
  }
  if (callsUsed === MARKET_MAX_CALLS_PER_WINDOW) {
    return Object.freeze({
      windowId: expectedWindowId,
      status: "COMPLETED",
      providerStatus: "OPEN",
      callsUsed: MARKET_MAX_CALLS_PER_WINDOW,
      resultCount: MARKET_RESULTS_PER_WINDOW,
      safeCode: null,
      items: normalized.items,
      mutateLatest: true,
      nextWindowPending: false,
    });
  }
  const rateLimited = normalized.items.every((item) => item.status === "RATE_LIMITED");
  return failedWindow(
    expectedWindowId,
    callsUsed as number,
    MARKET_RESULTS_PER_WINDOW,
    normalized.items,
    rateLimited ? "RATE_LIMITED" : "PROVIDER_ERROR",
  );
}

export function recoverMarketPollWindow(
  windowId: string,
  callsUsed: number,
): PersistableMarketPollWindow {
  marketWindowStart(windowId);
  const boundedCalls = Number.isSafeInteger(callsUsed)
    ? Math.min(Math.max(callsUsed, 0), MARKET_MAX_CALLS_PER_WINDOW)
    : 0;
  return failedWindow(
    windowId,
    boundedCalls,
    0,
    Object.freeze(MARKET_UNIVERSE.map(unavailableItem)),
    "PROVIDER_ERROR",
  );
}

/**
 * Plans only request starts. Provider status remains authoritative for holidays,
 * halts, and other exceptional closures, so callers may explicitly close a plan.
 */
export function createMarketWindowPlan(
  windowStartsAt: Date,
  marketOpenOverride?: boolean,
): MarketWindowPlan {
  if (!(windowStartsAt instanceof Date) || !Number.isFinite(windowStartsAt.getTime())) {
    throw new Error("MARKET_WINDOW_START_INVALID");
  }
  if (marketOpenOverride !== undefined && typeof marketOpenOverride !== "boolean") {
    throw new Error("MARKET_SESSION_INVALID");
  }

  const startMilliseconds = windowStartsAt.getTime();
  const marketOpen = marketOpenOverride ?? regularSessionIsOpen(windowStartsAt);
  const quoteStartMilliseconds = marketOpen
    ? MARKET_UNIVERSE.map((_, index) => (
      startMilliseconds + MARKET_REQUEST_INTERVAL_MS * (index + 1)
    ))
    : [];
  if (quoteStartMilliseconds.length !== (marketOpen ? MARKET_RESULTS_PER_WINDOW : 0)
    || (quoteStartMilliseconds.at(-1) ?? startMilliseconds)
      >= startMilliseconds + MARKET_WINDOW_DURATION_MS) {
    throw new Error("MARKET_WINDOW_BUDGET_INVALID");
  }

  return Object.freeze({
    marketOpen,
    totalCalls: marketOpen ? MARKET_MAX_CALLS_PER_WINDOW : 1,
    resultCount: MARKET_RESULTS_PER_WINDOW,
    get windowStartsAt() {
      return dateSnapshot(startMilliseconds);
    },
    get windowEndsAt() {
      return dateSnapshot(startMilliseconds + MARKET_WINDOW_DURATION_MS);
    },
    get marketStatusStart() {
      return dateSnapshot(startMilliseconds);
    },
    get quoteStarts() {
      return Object.freeze(quoteStartMilliseconds.map(dateSnapshot));
    },
  });
}
