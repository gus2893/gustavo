import { MARKET_UNIVERSE } from "../../../config/market-universe";

export const MARKET_WINDOW_DURATION_MS = 300_000 as const;
export const MARKET_REQUEST_INTERVAL_MS = 3_000 as const;
export const MARKET_MAX_CALLS_PER_WINDOW = 96 as const;
export const MARKET_RESULTS_PER_WINDOW = 95 as const;

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
