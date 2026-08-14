import {
  MARKET_REQUEST_INTERVAL_MS,
  MARKET_RESULTS_PER_WINDOW,
  MARKET_WINDOW_DURATION_MS,
} from "./session";
import {
  MARKET_UNIVERSE,
  type MarketUniverseItem,
} from "../../../config/market-universe";

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1" as const;
const FINNHUB_TIMEOUT_LIMIT_MS = MARKET_REQUEST_INTERVAL_MS;
const FINNHUB_MAX_FUTURE_SKEW_MS = 5_000 as const;
const FINNHUB_MAX_RESPONSE_BYTES = 4_096 as const;
const FINNHUB_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CONTENT_LENGTH_PATTERN = /^[1-9][0-9]{0,4}$/;
const PRICE_PATTERN = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/;
const approvedSymbols: ReadonlySet<string> = new Set<string>(
  MARKET_UNIVERSE.map(({ symbol }) => symbol),
);

export type FinnhubQuoteStatus =
  | "SUCCESS"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR";

export type FinnhubQuoteSafeCode =
  | "MARKET_CLOSED"
  | "SYMBOL_UNAVAILABLE"
  | "STALE_QUOTE"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "MALFORMED_RESPONSE";

export interface FinnhubPollItem {
  readonly symbol: MarketUniverseItem["symbol"];
  readonly kind: MarketUniverseItem["kind"];
  readonly status: FinnhubQuoteStatus;
  readonly price: string | null;
  readonly sourceObservedAt: string | null;
  readonly safeCode: FinnhubQuoteSafeCode | null;
}

export interface FinnhubPollResult {
  readonly callsUsed: number;
  readonly items: readonly FinnhubPollItem[];
}

export interface FinnhubRawResponse {
  readonly status: number;
  readonly json?: unknown;
  readonly malformed?: boolean;
}

type FinnhubRequest = (
  signal: AbortSignal,
) => Promise<unknown>;

export type FinnhubQuoteRequest = (
  symbol: MarketUniverseItem["symbol"],
  signal: AbortSignal,
) => Promise<unknown>;

interface FinnhubPollBaseOptions {
  readonly fetchQuote: FinnhubQuoteRequest;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
  readonly wallNow?: () => number;
  readonly timeoutMs: number;
  readonly minimumSourceTimestampSeconds?: number;
}

export type FinnhubPollOptions = FinnhubPollBaseOptions & (
  | {
    readonly marketOpen: boolean;
    readonly fetchMarketStatus?: never;
  }
  | {
    readonly marketOpen?: never;
    readonly fetchMarketStatus: FinnhubRequest;
  }
);

export interface FinnhubHttpClient {
  fetchMarketStatus(signal?: AbortSignal): Promise<FinnhubRawResponse>;
  fetchQuote(
    symbol: MarketUniverseItem["symbol"] | string,
    signal?: AbortSignal,
  ): Promise<FinnhubRawResponse>;
}

export interface FinnhubHttpClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly readApiKey?: () => string | undefined;
}

interface DeadlineSuccess {
  readonly ok: true;
  readonly value: unknown;
}

interface DeadlineFailure {
  readonly ok: false;
}

type DeadlineResult = DeadlineSuccess | DeadlineFailure;

interface MarketStatusOpen {
  readonly state: "OPEN";
}

interface MarketStatusClosed {
  readonly state: "CLOSED";
}

interface MarketStatusFailure {
  readonly state: "RATE_LIMITED" | "PROVIDER_ERROR";
  readonly safeCode: "RATE_LIMITED" | "PROVIDER_ERROR" | "MALFORMED_RESPONSE";
}

type MarketStatusResult = MarketStatusOpen | MarketStatusClosed | MarketStatusFailure;

function frozenResponse(response: FinnhubRawResponse): FinnhubRawResponse {
  return Object.freeze(response);
}

function safeCodeItem(
  item: MarketUniverseItem,
  status: Exclude<FinnhubQuoteStatus, "SUCCESS">,
  safeCode: FinnhubQuoteSafeCode,
): FinnhubPollItem {
  return Object.freeze({
    symbol: item.symbol,
    kind: item.kind,
    status,
    price: null,
    sourceObservedAt: null,
    safeCode,
  });
}

function successItem(
  item: MarketUniverseItem,
  price: string,
  sourceObservedAt: string,
): FinnhubPollItem {
  return Object.freeze({
    symbol: item.symbol,
    kind: item.kind,
    status: "SUCCESS",
    price,
    sourceObservedAt,
    safeCode: null,
  });
}

interface OwnDataResult {
  readonly ok: boolean;
  readonly present: boolean;
  readonly value?: unknown;
}

function ownData(record: object, key: string): OwnDataResult {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) return { ok: true, present: false };
    if (!("value" in descriptor)) return { ok: false, present: true };
    return { ok: true, present: true, value: descriptor.value };
  } catch {
    return { ok: false, present: false };
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function normalizedRawResponse(value: unknown): FinnhubRawResponse | undefined {
  try {
    if (!plainRecord(value)) return undefined;
    const status = ownData(value, "status");
    const malformed = ownData(value, "malformed");
    const json = ownData(value, "json");
    if (!status.ok || !status.present || !Number.isInteger(status.value)
      || !malformed.ok || !json.ok
      || (malformed.present && typeof malformed.value !== "boolean")) {
      return undefined;
    }
    return Object.freeze({
      status: status.value as number,
      ...(json.present ? { json: json.value } : {}),
      ...(malformed.present ? { malformed: malformed.value as boolean } : {}),
    });
  } catch {
    return undefined;
  }
}

function canonicalPrice(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0 || value >= 1_000_000_000_000) {
    return undefined;
  }
  const fixed = value.toFixed(8).replace(/(?:\.0+|(?<=[0-9])0+)$/, "").replace(/\.$/, "");
  return fixed !== "0" && PRICE_PATTERN.test(fixed) ? fixed : undefined;
}

function canonicalTimestamp(epochSeconds: number): string | undefined {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) return undefined;
  const date = new Date(epochSeconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function mapQuote(
  item: MarketUniverseItem,
  rawResponse: unknown,
  minimumSourceTimestampSeconds: number,
  maximumSourceTimestampSeconds: number,
): FinnhubPollItem {
  const response = normalizedRawResponse(rawResponse);
  if (!response) {
    return safeCodeItem(item, "PROVIDER_ERROR", "MALFORMED_RESPONSE");
  }
  if (!Number.isInteger(response.status) || response.status < 0 || response.status > 599) {
    return safeCodeItem(item, "PROVIDER_ERROR", "MALFORMED_RESPONSE");
  }
  if (response.status === 429) {
    return safeCodeItem(item, "RATE_LIMITED", "RATE_LIMITED");
  }
  if (response.malformed === true) {
    return safeCodeItem(item, "PROVIDER_ERROR", "MALFORMED_RESPONSE");
  }
  if (response.status === 404) {
    return safeCodeItem(item, "UNAVAILABLE", "SYMBOL_UNAVAILABLE");
  }
  if (response.status !== 200) {
    return safeCodeItem(item, "PROVIDER_ERROR", "PROVIDER_ERROR");
  }
  if (!plainRecord(response.json)) {
    return safeCodeItem(item, "PROVIDER_ERROR", "MALFORMED_RESPONSE");
  }

  const current = ownData(response.json, "c");
  const sourceTimestamp = ownData(response.json, "t");
  if (!current.ok || !sourceTimestamp.ok) {
    return safeCodeItem(item, "PROVIDER_ERROR", "MALFORMED_RESPONSE");
  }
  if (!current.present || !sourceTimestamp.present
    || current.value === undefined || sourceTimestamp.value === undefined
    || current.value === 0 || sourceTimestamp.value === 0) {
    return safeCodeItem(item, "UNAVAILABLE", "SYMBOL_UNAVAILABLE");
  }
  if (typeof current.value !== "number" || typeof sourceTimestamp.value !== "number") {
    return safeCodeItem(item, "PROVIDER_ERROR", "MALFORMED_RESPONSE");
  }
  if (sourceTimestamp.value < minimumSourceTimestampSeconds) {
    return safeCodeItem(item, "UNAVAILABLE", "STALE_QUOTE");
  }
  if (sourceTimestamp.value > maximumSourceTimestampSeconds) {
    return safeCodeItem(item, "PROVIDER_ERROR", "MALFORMED_RESPONSE");
  }

  const price = canonicalPrice(current.value);
  const sourceObservedAt = canonicalTimestamp(sourceTimestamp.value);
  if (!price || !sourceObservedAt) {
    return safeCodeItem(item, "PROVIDER_ERROR", "MALFORMED_RESPONSE");
  }
  return successItem(item, price, sourceObservedAt);
}

function mapMarketStatus(rawResponse: unknown): MarketStatusResult {
  const response = normalizedRawResponse(rawResponse);
  if (!response) {
    return { state: "PROVIDER_ERROR", safeCode: "MALFORMED_RESPONSE" };
  }
  if (response.status === 429) {
    return { state: "RATE_LIMITED", safeCode: "RATE_LIMITED" };
  }
  if (response.malformed === true) {
    return { state: "PROVIDER_ERROR", safeCode: "MALFORMED_RESPONSE" };
  }
  if (response.status !== 200) {
    return { state: "PROVIDER_ERROR", safeCode: "PROVIDER_ERROR" };
  }
  if (!plainRecord(response.json)) {
    return { state: "PROVIDER_ERROR", safeCode: "MALFORMED_RESPONSE" };
  }
  const isOpen = ownData(response.json, "isOpen");
  if (!isOpen.ok || !isOpen.present || typeof isOpen.value !== "boolean") {
    return { state: "PROVIDER_ERROR", safeCode: "MALFORMED_RESPONSE" };
  }
  return isOpen.value ? { state: "OPEN" } : { state: "CLOSED" };
}

async function withDeadline(
  timeoutMs: number,
  request: FinnhubRequest,
): Promise<DeadlineResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requestResult = Promise.resolve()
    .then(() => request(controller.signal))
    .then<DeadlineResult, DeadlineResult>(
      (value) => ({ ok: true, value }),
      () => ({ ok: false }),
    );
  const timeoutResult = new Promise<DeadlineFailure>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false });
    }, timeoutMs);
  });

  try {
    return await Promise.race([requestResult, timeoutResult]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validatedNow(now: () => number): number {
  const instant = now();
  if (!Number.isSafeInteger(instant) || instant < 0) {
    throw new Error("FINNHUB_POLL_CONFIG_INVALID");
  }
  return instant;
}

function validatePollOptions(options: FinnhubPollOptions): void {
  const hasMarketOpen = typeof options?.marketOpen === "boolean";
  const hasMarketStatus = typeof options?.fetchMarketStatus === "function";
  if (!options || typeof options !== "object"
    || hasMarketOpen === hasMarketStatus
    || typeof options.fetchQuote !== "function"
    || typeof options.sleep !== "function"
    || typeof options.now !== "function"
    || (options.wallNow !== undefined && typeof options.wallNow !== "function")
    || !Number.isInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs >= FINNHUB_TIMEOUT_LIMIT_MS
    || (options.minimumSourceTimestampSeconds !== undefined
      && (!Number.isSafeInteger(options.minimumSourceTimestampSeconds)
        || options.minimumSourceTimestampSeconds < 0))) {
    throw new Error("FINNHUB_POLL_CONFIG_INVALID");
  }
  validatedNow(options.now);
}

function finalizedResult(callsUsed: number, items: FinnhubPollItem[]): FinnhubPollResult {
  if (!Number.isSafeInteger(callsUsed) || callsUsed < 1 || callsUsed > 96
    || items.length !== MARKET_RESULTS_PER_WINDOW) {
    throw new Error("FINNHUB_WINDOW_BOUNDS_INVALID");
  }
  return Object.freeze({
    callsUsed,
    items: Object.freeze([...items]),
  });
}

function fillAll(
  status: Exclude<FinnhubQuoteStatus, "SUCCESS">,
  safeCode: FinnhubQuoteSafeCode,
): readonly FinnhubPollItem[] {
  return MARKET_UNIVERSE.map((item) => safeCodeItem(item, status, safeCode));
}

export async function pollFinnhubWindow(
  options: FinnhubPollOptions,
): Promise<FinnhubPollResult> {
  validatePollOptions(options);
  const windowStartedAt = validatedNow(options.now);
  const wallNow = options.wallNow ?? Date.now;
  const sourceWindowStartedAt = validatedNow(wallNow);
  const minimumSourceTimestampSeconds = options.minimumSourceTimestampSeconds
    ?? Math.floor(sourceWindowStartedAt / 1_000);
  let marketStatus: MarketStatusResult;

  if (typeof options.marketOpen === "boolean") {
    marketStatus = options.marketOpen ? { state: "OPEN" } : { state: "CLOSED" };
  } else {
    const statusResponse = await withDeadline(options.timeoutMs, options.fetchMarketStatus);
    marketStatus = statusResponse.ok
      ? mapMarketStatus(statusResponse.value)
      : { state: "PROVIDER_ERROR", safeCode: "PROVIDER_ERROR" };
  }

  if (marketStatus.state === "CLOSED") {
    return finalizedResult(1, [...fillAll("UNAVAILABLE", "MARKET_CLOSED")]);
  }
  if (marketStatus.state === "RATE_LIMITED") {
    return finalizedResult(1, [...fillAll("RATE_LIMITED", marketStatus.safeCode)]);
  }
  if (marketStatus.state === "PROVIDER_ERROR") {
    return finalizedResult(1, [...fillAll("PROVIDER_ERROR", marketStatus.safeCode)]);
  }

  const items: FinnhubPollItem[] = [];
  let callsUsed = 1;
  let previousStart = windowStartedAt;
  for (let index = 0; index < MARKET_UNIVERSE.length; index += 1) {
    const item = MARKET_UNIVERSE[index]!;
    const plannedStart = Math.max(
      windowStartedAt + (index + 1) * MARKET_REQUEST_INTERVAL_MS,
      previousStart + MARKET_REQUEST_INTERVAL_MS,
    );
    try {
      const remaining = plannedStart - validatedNow(options.now);
      if (remaining > 0) await options.sleep(remaining);
      const actualStart = validatedNow(options.now);
      if (actualStart < plannedStart
        || actualStart >= windowStartedAt + MARKET_WINDOW_DURATION_MS) {
        throw new Error("PACE_NOT_REACHED");
      }
      previousStart = actualStart;
    } catch {
      for (let missing = index; missing < MARKET_UNIVERSE.length; missing += 1) {
        items.push(safeCodeItem(
          MARKET_UNIVERSE[missing]!,
          "PROVIDER_ERROR",
          "PROVIDER_ERROR",
        ));
      }
      break;
    }

    if (callsUsed >= 96) {
      items.push(safeCodeItem(item, "PROVIDER_ERROR", "PROVIDER_ERROR"));
      continue;
    }
    callsUsed += 1;
    const quoteResponse = await withDeadline(
      options.timeoutMs,
      (signal) => options.fetchQuote(item.symbol, signal),
    );
    if (!quoteResponse.ok) {
      items.push(safeCodeItem(item, "PROVIDER_ERROR", "PROVIDER_ERROR"));
      continue;
    }
    let receivedAt: number;
    try {
      receivedAt = validatedNow(wallNow);
    } catch {
      items.push(safeCodeItem(item, "PROVIDER_ERROR", "PROVIDER_ERROR"));
      continue;
    }
    const maximumSourceTimestampSeconds = Math.floor(Math.min(
      receivedAt + FINNHUB_MAX_FUTURE_SKEW_MS,
      sourceWindowStartedAt + MARKET_WINDOW_DURATION_MS - 1,
    ) / 1_000);
    items.push(mapQuote(
      item,
      quoteResponse.value,
      minimumSourceTimestampSeconds,
      maximumSourceTimestampSeconds,
    ));
  }

  while (items.length < MARKET_RESULTS_PER_WINDOW) {
    items.push(safeCodeItem(
      MARKET_UNIVERSE[items.length]!,
      "PROVIDER_ERROR",
      "PROVIDER_ERROR",
    ));
  }
  return finalizedResult(callsUsed, items);
}

function defaultApiKey(): string | undefined {
  return process.env.FINNHUB_API_KEY;
}

function cancelWithoutWaiting(target: { cancel?: () => unknown } | null | undefined): void {
  try {
    if (!target || typeof target.cancel !== "function") return;
    const cancellation = target.cancel();
    Promise.resolve(cancellation).catch(() => undefined);
  } catch {
    // Cancellation is best effort; provider details never cross this boundary.
  }
}

async function readBoundedJsonResponse(
  response: Response,
  status: number,
): Promise<FinnhubRawResponse> {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    return frozenResponse({ status: 0, malformed: true });
  }

  if (status !== 200) {
    cancelWithoutWaiting(body);
    return frozenResponse({ status });
  }

  let contentLength: number;
  try {
    const contentLengthHeader = response.headers.get("content-length");
    const transferEncoding = response.headers.get("transfer-encoding");
    if (!body || transferEncoding !== null
      || contentLengthHeader === null
      || !CONTENT_LENGTH_PATTERN.test(contentLengthHeader)) {
      cancelWithoutWaiting(body);
      return frozenResponse({ status, malformed: true });
    }
    contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)
      || contentLength < 1
      || contentLength > FINNHUB_MAX_RESPONSE_BYTES) {
      cancelWithoutWaiting(body);
      return frozenResponse({ status, malformed: true });
    }
  } catch {
    cancelWithoutWaiting(body);
    return frozenResponse({ status, malformed: true });
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    cancelWithoutWaiting(body);
    return frozenResponse({ status, malformed: true });
  }

  let cancelled = false;
  const cancelReaderOnce = (): void => {
    if (cancelled) return;
    cancelled = true;
    cancelWithoutWaiting(reader);
  };
  try {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new Error("FINNHUB_RESPONSE_INVALID");
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > FINNHUB_MAX_RESPONSE_BYTES || byteLength > contentLength) {
        throw new Error("FINNHUB_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
    if (byteLength !== contentLength) throw new Error("FINNHUB_RESPONSE_LENGTH_INVALID");

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const json: unknown = JSON.parse(text);
    return frozenResponse({ status, json });
  } catch {
    cancelReaderOnce();
    return frozenResponse({ status, malformed: true });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader release is best effort and never changes the bounded result.
    }
  }
}

export function createFinnhubHttpClient(
  options: FinnhubHttpClientOptions = {},
): FinnhubHttpClient {
  if (!options || typeof options !== "object"
    || (options.fetch !== undefined && typeof options.fetch !== "function")
    || (options.readApiKey !== undefined && typeof options.readApiKey !== "function")) {
    throw new Error("FINNHUB_CLIENT_CONFIG_INVALID");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const readApiKey = options.readApiKey ?? defaultApiKey;

  const request = async (
    path: string,
    signal?: AbortSignal,
  ): Promise<FinnhubRawResponse> => {
    let response: Response;
    try {
      const apiKey = readApiKey();
      if (typeof apiKey !== "string" || !FINNHUB_KEY_PATTERN.test(apiKey)) {
        return frozenResponse({ status: 0 });
      }
      response = await fetchImpl(`${FINNHUB_BASE_URL}${path}`, {
        method: "GET",
        headers: {
          "Accept-Encoding": "identity",
          "X-Finnhub-Token": apiKey,
        },
        cache: "no-store",
        redirect: "error",
        signal,
      });
    } catch {
      return frozenResponse({ status: 0 });
    }
    try {
      if (!response || (typeof response !== "object" && typeof response !== "function")) {
        return frozenResponse({ status: 0, malformed: true });
      }
      const status: unknown = response.status;
      if (!Number.isInteger(status) || (status as number) < 0 || (status as number) > 599) {
        return frozenResponse({ status: 0, malformed: true });
      }
      return await readBoundedJsonResponse(response, status as number);
    } catch {
      return frozenResponse({ status: 0, malformed: true });
    }
  };

  return Object.freeze({
    fetchMarketStatus(signal?: AbortSignal) {
      return request("/stock/market-status?exchange=US", signal);
    },
    fetchQuote(symbol: string, signal?: AbortSignal) {
      if (!approvedSymbols.has(symbol)) return Promise.resolve(frozenResponse({ status: 0 }));
      return request(`/quote?symbol=${encodeURIComponent(symbol)}`, signal);
    },
  });
}
