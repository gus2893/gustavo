import { randomUUID } from "node:crypto";
import { MARKET_UNIVERSE } from "../../../config/market-universe";
import {
  createAndWrapDataKey,
  decryptEventBody,
  encryptEventBody,
  unwrapDataKey,
  type WrappedDataKey,
} from "../crypto/envelope";
import {
  canonicalContentDigest,
  canonicalJson,
  digestsEqual,
} from "../events/integrity";
import { readEventBody } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import type {
  FinnhubPollItem,
  FinnhubQuoteSafeCode,
  FinnhubQuoteStatus,
} from "./finnhub";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOW_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/u;
const PRICE_PATTERN = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/u;
const MARKET_PROVIDER = "FINNHUB" as const;
const MARKET_AGGREGATE_PREFIX = "market-latest:" as const;
const MARKET_CONSUMPTION_EVENT_TYPE = "market.observation.consumption.requested" as const;
const MARKET_CONSUMPTION_ACTOR_ID = "gustavo-decision-orchestrator" as const;
const MARKET_DECISION_POLICY_VERSION = "decision-window-policy-v1" as const;
const FINNHUB_LICENSE_ID = "finnhub-free-personal" as const;

const catalogBySymbol: ReadonlyMap<string, (typeof MARKET_UNIVERSE)[number]> = new Map(
  MARKET_UNIVERSE.map((item) => [item.symbol, item]),
);
const quoteStatuses = new Set<FinnhubQuoteStatus>([
  "SUCCESS",
  "UNAVAILABLE",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
]);
const safeCodes = new Set<FinnhubQuoteSafeCode>([
  "MARKET_CLOSED",
  "SYMBOL_UNAVAILABLE",
  "STALE_QUOTE",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "MALFORMED_RESPONSE",
]);

export interface LatestMarketContext {
  readonly db: EventDatabase;
  readonly accountId: string;
}

export interface MarketMaterializerContext {
  readonly db: EventDatabase;
  readonly accountId: string;
}

export interface StoreLatestMarketWindowInput {
  readonly windowId: string;
  readonly items: readonly FinnhubPollItem[];
  readonly receivedAt?: string;
}

export interface LatestMarketItem {
  readonly symbol: string;
  readonly kind: "STOCK" | "ETF";
  readonly status: FinnhubQuoteStatus;
  readonly price: string | null;
  readonly sourceObservedAt: string | null;
  readonly receivedAt: string;
  readonly windowId: string;
  readonly provider: typeof MARKET_PROVIDER;
  readonly safeCode: FinnhubQuoteSafeCode | null;
  readonly latestContextDigest: string;
}

export interface MaterializeMarketObservationInput {
  readonly commandEventId: string;
}

export interface MaterializedMarketObservation {
  readonly observationId: string;
  readonly commandEventId: string;
  readonly symbol: string;
  readonly latestContextDigest: string;
}

interface AggregateKeyRow extends Record<string, unknown> {
  readonly id: string;
  readonly aggregate_id: string;
  readonly root_key_version: number;
  readonly wrapped_key: Buffer;
  readonly wrap_iv: Buffer;
  readonly wrap_auth_tag: Buffer;
}

interface LatestMetadataRow extends Record<string, unknown> {
  readonly account_id: string;
  readonly symbol: string;
  readonly window_id: string;
  readonly provider: typeof MARKET_PROVIDER;
  readonly status: FinnhubQuoteStatus;
  readonly source_observed_at: Date | null;
  readonly received_at: Date;
  readonly data_key_id: string | null;
  readonly context_digest: string;
  readonly safe_code: FinnhubQuoteSafeCode | null;
}

interface LatestProtectedRow extends LatestMetadataRow {
  readonly ciphertext: Buffer | null;
  readonly envelope_iv: Buffer | null;
  readonly envelope_auth_tag: Buffer | null;
  readonly envelope_encoding: "canonical-json-v1" | null;
}

interface ConsumptionCommandRow extends Record<string, unknown> {
  readonly id: string;
  readonly aggregate_id: string;
  readonly account_id: string | null;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly type: string;
  readonly visibility: string;
  readonly causation_id: string | null;
  readonly correlation_id: string;
  readonly policy_version: string | null;
  readonly body_digest: string | null;
  readonly data_key_id: string | null;
  readonly topic: string | null;
  readonly payload_event_id: string | null;
}

interface ConsumptionBindingRow extends Record<string, unknown> {
  readonly command_event_id: string;
  readonly account_id: string;
  readonly symbol: string;
  readonly latest_context_digest: string;
  readonly command_body_digest: string;
  readonly observation_id: string;
  readonly latest_window_id: string;
  readonly latest_data_key_id: string | null;
  readonly latest_source_observed_at: Date;
  readonly latest_received_at: Date;
  readonly request_digest: string;
}

interface ObservationReplayRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string | null;
  readonly symbol: string;
  readonly asset_class: string;
  readonly price: string;
  readonly observed_at: Date;
  readonly received_at: Date;
  readonly provider: string;
  readonly license_id: string;
  readonly raw_source_ref: string;
  readonly feed_status: string;
  readonly delay_seconds: number;
  readonly redistribution: string;
  readonly session_state: string;
  readonly latest_context_digest: string | null;
  readonly decision_command_event_id: string | null;
}

function marketAggregateId(accountId: string): string {
  return `${MARKET_AGGREGATE_PREFIX}${accountId}`;
}

function requireAccountId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("MARKET_ACCOUNT_FORBIDDEN");
  }
  return value.toLowerCase();
}

function requireCommandEventId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("MARKET_CONSUMPTION_COMMAND_INVALID");
  }
  return value.toLowerCase();
}

function windowStart(windowId: unknown): Date {
  if (typeof windowId !== "string" || !WINDOW_PATTERN.test(windowId)) {
    throw new Error("MARKET_LATEST_INPUT_INVALID");
  }
  const start = new Date(`${windowId.slice(0, -1)}:00.000Z`);
  if (!Number.isFinite(start.getTime())
    || start.toISOString().slice(0, 16) !== windowId.slice(0, 16)) {
    throw new Error("MARKET_LATEST_INPUT_INVALID");
  }
  return start;
}

function exactIso(value: unknown): string {
  if (typeof value !== "string") throw new Error("MARKET_LATEST_INPUT_INVALID");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("MARKET_LATEST_INPUT_INVALID");
  }
  return value;
}

function validPositivePrice(value: unknown): value is string {
  return typeof value === "string" && PRICE_PATTERN.test(value)
    && /[1-9]/u.test(value.replace(".", ""));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatedItem(raw: unknown, start: Date): FinnhubPollItem {
  try {
    if (!plainRecord(raw)
      || Object.keys(raw).sort().join(",") !== "kind,price,safeCode,sourceObservedAt,status,symbol"
      || typeof raw.symbol !== "string" || typeof raw.kind !== "string"
      || !quoteStatuses.has(raw.status as FinnhubQuoteStatus)) {
      throw new Error("MARKET_LATEST_INPUT_INVALID");
    }
    const catalog = catalogBySymbol.get(raw.symbol);
    if (!catalog || catalog.kind !== raw.kind) throw new Error("MARKET_LATEST_INPUT_INVALID");
    const status = raw.status as FinnhubQuoteStatus;
    if (status === "SUCCESS") {
      if (!validPositivePrice(raw.price) || raw.safeCode !== null) {
        throw new Error("MARKET_LATEST_INPUT_INVALID");
      }
      const observedAt = exactIso(raw.sourceObservedAt);
      const observed = new Date(observedAt).getTime();
      if (observed < start.getTime() || observed >= start.getTime() + 300_000) {
        throw new Error("MARKET_LATEST_INPUT_INVALID");
      }
      return Object.freeze({
        symbol: catalog.symbol,
        kind: catalog.kind,
        status,
        price: raw.price,
        sourceObservedAt: observedAt,
        safeCode: null,
      });
    }
    if (raw.price !== null || raw.sourceObservedAt !== null
      || typeof raw.safeCode !== "string"
      || !safeCodes.has(raw.safeCode as FinnhubQuoteSafeCode)
      || (status === "RATE_LIMITED" && raw.safeCode !== "RATE_LIMITED")
      || (status === "PROVIDER_ERROR"
        && raw.safeCode !== "PROVIDER_ERROR" && raw.safeCode !== "MALFORMED_RESPONSE")
      || (status === "UNAVAILABLE"
        && !["MARKET_CLOSED", "SYMBOL_UNAVAILABLE", "STALE_QUOTE"].includes(raw.safeCode))) {
      throw new Error("MARKET_LATEST_INPUT_INVALID");
    }
    return Object.freeze({
      symbol: catalog.symbol,
      kind: catalog.kind,
      status,
      price: null,
      sourceObservedAt: null,
      safeCode: raw.safeCode as FinnhubQuoteSafeCode,
    });
  } catch {
    throw new Error("MARKET_LATEST_INPUT_INVALID");
  }
}

function validateWindowInput(input: StoreLatestMarketWindowInput): {
  readonly start: Date;
  readonly items: readonly FinnhubPollItem[];
  readonly receivedAt?: string;
} {
  if (!input || typeof input !== "object" || !Array.isArray(input.items)
    || input.items.length < 1 || input.items.length > MARKET_UNIVERSE.length) {
    throw new Error("MARKET_LATEST_INPUT_INVALID");
  }
  const start = windowStart(input.windowId);
  const items = input.items.map((item) => validatedItem(item, start));
  if (new Set(items.map(({ symbol }) => symbol)).size !== items.length) {
    throw new Error("MARKET_LATEST_INPUT_INVALID");
  }
  let receivedAt: string | undefined;
  if (input.receivedAt !== undefined) {
    receivedAt = exactIso(input.receivedAt);
    const received = new Date(receivedAt).getTime();
    if (received < start.getTime() || received >= start.getTime() + 300_000
      || items.some(({ sourceObservedAt }) => (
        sourceObservedAt !== null && new Date(sourceObservedAt).getTime() > received
      ))) throw new Error("MARKET_LATEST_INPUT_INVALID");
  }
  return Object.freeze({ start, items: Object.freeze(items), receivedAt });
}

function wrappedFromRow(row: AggregateKeyRow): WrappedDataKey {
  return {
    rootKeyVersion: row.root_key_version,
    wrappedKey: row.wrapped_key,
    iv: row.wrap_iv,
    authTag: row.wrap_auth_tag,
  };
}

async function authorizeAccount(database: EventDatabase, accountId: string): Promise<void> {
  const rows = await database.query(
    `/* market-account-authority */
     select account.id,entitlement.id entitlement_id
       from accounts account
       join entitlements entitlement on entitlement.account_id=account.id
        and entitlement.active_from<=clock_timestamp()
        and entitlement.revoked_at is null
        and (entitlement.expires_at is null
          or entitlement.expires_at>clock_timestamp())
      where account.id=$1 and account.status='ACTIVE'
      order by account.id,entitlement.id
      for share of account,entitlement`,
    [accountId],
  );
  if (rows.length !== 1) throw new Error("MARKET_ACCOUNT_FORBIDDEN");
}

async function authorizeMaterializerRole(database: EventDatabase): Promise<void> {
  try {
    const roles = await database.query<{ readonly role_name: string } & Record<string, unknown>>(
      `/* market-materializer-role-authority */
       select current_user::text role_name
        where current_user='gustavo_market_materializer'`,
    );
    if (roles.length !== 1 || roles[0].role_name !== "gustavo_market_materializer") {
      throw new Error("MARKET_MATERIALIZER_ROLE_REQUIRED");
    }
  } catch {
    throw new Error("MARKET_MATERIALIZER_ROLE_REQUIRED");
  }
}

async function advisoryAccountLock(database: EventDatabase, aggregateId: string): Promise<void> {
  await database.query(
    "select pg_advisory_xact_lock(hashtextextended($1,0))",
    [`market-latest-writer:${aggregateId}`],
  );
}

async function advisoryAggregateKeyLock(
  database: EventDatabase,
  aggregateId: string,
): Promise<void> {
  await database.query(
    "select pg_advisory_xact_lock(hashtextextended($1,0))",
    [`aggregate-key:${aggregateId}`],
  );
}

async function lockedMarketKey(
  database: EventDatabase,
  aggregateId: string,
): Promise<AggregateKeyRow | undefined> {
  const rows = await database.query<AggregateKeyRow>(
    `/* market-latest-key-lock */
     select id::text,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
       from aggregate_data_keys
      where aggregate_id=$1
      order by id
      for key share`,
    [aggregateId],
  );
  if (rows.length > 1) throw new Error("MARKET_LATEST_KEY_UNAVAILABLE");
  return rows[0];
}

async function createMarketKey(
  database: EventDatabase,
  aggregateId: string,
): Promise<{ readonly row: AggregateKeyRow; readonly plaintext: Buffer }> {
  const created = createAndWrapDataKey(aggregateId);
  try {
    const row: AggregateKeyRow = {
      id: randomUUID(),
      aggregate_id: aggregateId,
      root_key_version: created.wrapped.rootKeyVersion,
      wrapped_key: created.wrapped.wrappedKey,
      wrap_iv: created.wrapped.iv,
      wrap_auth_tag: created.wrapped.authTag,
    };
    await database.query(
      `insert into aggregate_data_keys (
         id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
       ) values ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.aggregate_id, row.root_key_version, row.wrapped_key,
        row.wrap_iv, row.wrap_auth_tag],
    );
    return Object.freeze({ row, plaintext: created.dataKey });
  } catch (error) {
    created.dataKey.fill(0);
    throw error;
  }
}

function latestContextDigest(accountId: string, symbol: string, windowId: string): string {
  return canonicalContentDigest({
    accountId,
    provider: MARKET_PROVIDER,
    symbol,
    windowId,
  });
}

function decryptedPrice(row: LatestProtectedRow, key: Buffer): string {
  if (row.status !== "SUCCESS" || row.data_key_id === null || row.ciphertext === null
    || row.envelope_iv === null || row.envelope_auth_tag === null
    || row.envelope_encoding !== "canonical-json-v1") {
    throw new Error("MARKET_LATEST_KEY_UNAVAILABLE");
  }
  try {
    const plaintext = decryptEventBody(
      row.context_digest,
      row.context_digest,
      { ciphertext: row.ciphertext, iv: row.envelope_iv, authTag: row.envelope_auth_tag },
      key,
    );
    const body = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (!plainRecord(body) || Object.keys(body).join(",") !== "price"
      || !validPositivePrice(body.price)) {
      throw new Error("MARKET_LATEST_BODY_INVALID");
    }
    return body.price;
  } catch (error) {
    if (error instanceof Error && error.message === "MARKET_LATEST_BODY_INVALID") throw error;
    throw new Error("MARKET_LATEST_BODY_INVALID");
  }
}

function exactReplay(
  existing: LatestProtectedRow,
  item: FinnhubPollItem,
  receivedAt: string,
  contextDigest: string,
  key: Buffer | undefined,
): boolean {
  if (existing.context_digest !== contextDigest || existing.provider !== MARKET_PROVIDER
    || existing.status !== item.status
    || existing.source_observed_at?.toISOString() !== item.sourceObservedAt
    || existing.received_at.toISOString() !== receivedAt
    || existing.safe_code !== item.safeCode) return false;
  if (item.status !== "SUCCESS") {
    return existing.data_key_id === null && existing.ciphertext === null
      && existing.envelope_iv === null && existing.envelope_auth_tag === null
      && existing.envelope_encoding === null;
  }
  return key !== undefined && existing.data_key_id !== null
    && digestsEqual(canonicalContentDigest(decryptedPrice(existing, key)), canonicalContentDigest(item.price));
}

function sameLatestVersion(
  metadata: LatestMetadataRow | undefined,
  protectedRow: LatestProtectedRow,
): boolean {
  return metadata !== undefined
    && metadata.account_id === protectedRow.account_id
    && metadata.symbol === protectedRow.symbol
    && metadata.window_id === protectedRow.window_id
    && metadata.provider === protectedRow.provider
    && metadata.status === protectedRow.status
    && metadata.source_observed_at?.getTime() === protectedRow.source_observed_at?.getTime()
    && metadata.received_at.getTime() === protectedRow.received_at.getTime()
    && metadata.data_key_id === protectedRow.data_key_id
    && metadata.context_digest === protectedRow.context_digest
    && metadata.safe_code === protectedRow.safe_code;
}

export async function storeLatestMarketWindow(
  context: LatestMarketContext,
  input: StoreLatestMarketWindowInput,
): Promise<void> {
  const accountId = requireAccountId(context?.accountId);
  const validated = validateWindowInput(input);
  const aggregateId = marketAggregateId(accountId);
  await context.db.transaction(async (transaction) => {
    await authorizeAccount(transaction, accountId);
    await advisoryAccountLock(transaction, aggregateId);
    await advisoryAggregateKeyLock(transaction, aggregateId);
    await transaction.query(
      `insert into market_poll_windows (window_id,window_started_at)
       values ($1,$2) on conflict (window_id) do nothing`,
      [input.windowId, validated.start],
    );
    const windows = await transaction.query<{
      readonly window_id: string;
      readonly window_started_at: Date;
      readonly provider: string;
    }>(
      `select window_id,window_started_at,provider from market_poll_windows
        where window_id=$1 for share`,
      [input.windowId],
    );
    if (windows.length !== 1 || windows[0].provider !== MARKET_PROVIDER
      || windows[0].window_started_at.getTime() !== validated.start.getTime()) {
      throw new Error("MARKET_LATEST_WINDOW_CONFLICT");
    }

    await authorizeAccount(transaction, accountId);
    let keyRow = await lockedMarketKey(transaction, aggregateId);
    let plaintextKey: Buffer | undefined;
    try {
      const symbols = [...validated.items.map(({ symbol }) => symbol)].sort();
      const existingRows = await transaction.query<LatestProtectedRow>(
        `/* market-latest-body-lock */
         select account_id::text,symbol,window_id,provider,status,source_observed_at,
                received_at,data_key_id::text,ciphertext,envelope_iv,envelope_auth_tag,
                envelope_encoding,context_digest,safe_code
           from market_latest_quotes
          where account_id=$1 and symbol=any($2::text[])
          order by symbol
          for update`,
        [accountId, symbols],
      );
      const existingBySymbol = new Map(existingRows.map((row) => [row.symbol, row]));
      await authorizeAccount(transaction, accountId);
      plaintextKey = keyRow ? unwrapDataKey(aggregateId, wrappedFromRow(keyRow)) : undefined;
      if (validated.items.some(({ status }) => status === "SUCCESS") && !keyRow) {
        const created = await createMarketKey(transaction, aggregateId);
        keyRow = created.row;
        plaintextKey = created.plaintext;
      }
      for (const item of validated.items) {
        const receivedAt = validated.receivedAt
          ?? item.sourceObservedAt
          ?? validated.start.toISOString();
        const contextDigest = latestContextDigest(accountId, item.symbol, input.windowId);
        const existing = existingBySymbol.get(item.symbol);
        if (existing?.window_id === input.windowId) {
          if (!exactReplay(existing, item, receivedAt, contextDigest, plaintextKey)) {
            throw new Error("MARKET_LATEST_WINDOW_CONFLICT");
          }
          continue;
        }
        if (existing) {
          const priorStart = windowStart(existing.window_id).getTime();
          if (validated.start.getTime() <= priorStart
            || (existing.status === "SUCCESS" && item.status === "SUCCESS"
              && new Date(item.sourceObservedAt!).getTime()
                <= existing.source_observed_at!.getTime())) {
            throw new Error("MARKET_LATEST_STALE");
          }
        }

        let encrypted: ReturnType<typeof encryptEventBody> | undefined;
        if (item.status === "SUCCESS") {
          if (!keyRow || !plaintextKey) throw new Error("MARKET_LATEST_KEY_UNAVAILABLE");
          encrypted = encryptEventBody(
            contextDigest,
            contextDigest,
            Buffer.from(canonicalJson({ price: item.price }), "utf8"),
            plaintextKey,
          );
        }
        if (existing) {
          await transaction.query(
            `update market_latest_quotes
                set window_id=$3,provider=$4,status=$5,source_observed_at=$6,
                    received_at=$7,data_key_id=$8,ciphertext=$9,envelope_iv=$10,
                    envelope_auth_tag=$11,envelope_encoding=$12,context_digest=$13,
                    safe_code=$14,updated_at=clock_timestamp()
              where account_id=$1 and symbol=$2`,
            [accountId, item.symbol, input.windowId, MARKET_PROVIDER, item.status,
              item.sourceObservedAt, receivedAt, item.status === "SUCCESS" ? keyRow?.id : null,
              encrypted?.ciphertext ?? null, encrypted?.iv ?? null,
              encrypted?.authTag ?? null,
              item.status === "SUCCESS" ? "canonical-json-v1" : null,
              contextDigest, item.safeCode],
          );
        } else {
          await transaction.query(
            `insert into market_latest_quotes (
               account_id,symbol,window_id,provider,status,source_observed_at,received_at,
               data_key_id,ciphertext,envelope_iv,envelope_auth_tag,envelope_encoding,
               context_digest,safe_code
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [accountId, item.symbol, input.windowId, MARKET_PROVIDER, item.status,
              item.sourceObservedAt, receivedAt, item.status === "SUCCESS" ? keyRow?.id : null,
              encrypted?.ciphertext ?? null, encrypted?.iv ?? null,
              encrypted?.authTag ?? null,
              item.status === "SUCCESS" ? "canonical-json-v1" : null,
              contextDigest, item.safeCode],
          );
        }
      }
      await transaction.query(
        `delete from market_poll_windows poll_window
          where poll_window.prune_after<=clock_timestamp()
            and not exists (
              select 1 from market_latest_quotes latest
               where latest.window_id=poll_window.window_id
            )`,
      );
    } finally {
      plaintextKey?.fill(0);
    }
  });
}

function validatedSymbols(symbols: readonly string[]): readonly string[] {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > MARKET_UNIVERSE.length
    || new Set(symbols).size !== symbols.length
    || symbols.some((symbol) => typeof symbol !== "string" || !catalogBySymbol.has(symbol))) {
    throw new Error("MARKET_LATEST_QUERY_INVALID");
  }
  return Object.freeze([...symbols]);
}

export async function loadLatestMarket(
  context: LatestMarketContext,
  symbols: readonly string[],
): Promise<readonly LatestMarketItem[]> {
  const accountId = requireAccountId(context?.accountId);
  const requested = validatedSymbols(symbols);
  return context.db.transaction(async (transaction) => {
    await authorizeAccount(transaction, accountId);
    const metadata = await transaction.query<LatestMetadataRow>(
      `/* market-latest-metadata */
       select account_id::text,symbol,window_id,provider,status,source_observed_at,
              received_at,data_key_id::text,context_digest,safe_code
         from market_latest_quotes
        where account_id=$1 and symbol=any($2::text[])
        order by symbol`,
      [accountId, requested],
    );
    if (metadata.length === 0) return Object.freeze([]);
    await authorizeAccount(transaction, accountId);
    const protectedSymbols = metadata
      .filter(({ status }) => status === "SUCCESS")
      .map(({ symbol }) => symbol);
    let keyRow: AggregateKeyRow | undefined;
    let plaintextKey: Buffer | undefined;
    const protectedBySymbol = new Map<string, LatestProtectedRow>();
    try {
      if (protectedSymbols.length > 0) {
        keyRow = await lockedMarketKey(transaction, marketAggregateId(accountId));
        if (!keyRow) throw new Error("MARKET_LATEST_KEY_UNAVAILABLE");
        const protectedRows = await transaction.query<LatestProtectedRow>(
          `/* market-latest-body-lock */
           select account_id::text,symbol,window_id,provider,status,source_observed_at,
                  received_at,data_key_id::text,ciphertext,envelope_iv,envelope_auth_tag,
                  envelope_encoding,context_digest,safe_code
             from market_latest_quotes
            where account_id=$1 and symbol=any($2::text[]) and status='SUCCESS'
            order by symbol
            for share`,
          [accountId, protectedSymbols],
        );
        for (const row of protectedRows) protectedBySymbol.set(row.symbol, row);
        const metadataBySymbol = new Map(metadata.map((row) => [row.symbol, row]));
        if (protectedRows.length !== protectedSymbols.length
          || protectedRows.some((row) => row.data_key_id !== keyRow!.id
            || !sameLatestVersion(metadataBySymbol.get(row.symbol), row))) {
          throw new Error("MARKET_LATEST_VERSION_CHANGED");
        }
        await authorizeAccount(transaction, accountId);
        plaintextKey = unwrapDataKey(keyRow.aggregate_id, wrappedFromRow(keyRow));
      }
      const bySymbol = new Map(metadata.map((row) => [row.symbol, row]));
      return Object.freeze(requested.flatMap((symbol): LatestMarketItem[] => {
        const row = bySymbol.get(symbol);
        if (!row) return [];
        const expectedContext = latestContextDigest(accountId, symbol, row.window_id);
        if (!digestsEqual(row.context_digest, expectedContext)
          || row.provider !== MARKET_PROVIDER) {
          throw new Error("MARKET_LATEST_CONTEXT_INVALID");
        }
        const catalog = catalogBySymbol.get(symbol)!;
        const price = row.status === "SUCCESS"
          ? decryptedPrice(protectedBySymbol.get(symbol)!, plaintextKey!)
          : null;
        return [Object.freeze({
          symbol,
          kind: catalog.kind,
          status: row.status,
          price,
          sourceObservedAt: row.source_observed_at?.toISOString() ?? null,
          receivedAt: row.received_at.toISOString(),
          windowId: row.window_id,
          provider: MARKET_PROVIDER,
          safeCode: row.safe_code,
          latestContextDigest: row.context_digest,
        })];
      }));
    } finally {
      plaintextKey?.fill(0);
    }
  });
}

function exactConsumptionBody(
  body: JsonValue,
): { readonly symbol: string; readonly latestContextDigest: string } {
  if (!plainRecord(body)
    || Object.keys(body).sort().join(",") !== "latestContextDigest,symbol"
    || typeof body.symbol !== "string" || !catalogBySymbol.has(body.symbol)
    || typeof body.latestContextDigest !== "string"
    || !DIGEST_PATTERN.test(body.latestContextDigest)) {
    throw new Error("MARKET_CONSUMPTION_COMMAND_INVALID");
  }
  return Object.freeze({
    symbol: body.symbol,
    latestContextDigest: body.latestContextDigest,
  });
}

function consumptionRequestDigest(
  accountId: string,
  commandEventId: string,
  symbol: string,
  contextDigest: string,
): string {
  return canonicalContentDigest({
    accountId,
    commandEventId,
    latestContextDigest: contextDigest,
    symbol,
  });
}

function assertCommandMetadata(
  command: ConsumptionCommandRow | undefined,
  accountId: string,
  commandEventId: string,
): asserts command is ConsumptionCommandRow {
  if (!command
    || command.id !== commandEventId
    || command.aggregate_id !== marketAggregateId(accountId)
    || command.account_id !== accountId
    || command.actor_type !== "SYSTEM"
    || command.actor_id !== MARKET_CONSUMPTION_ACTOR_ID
    || command.type !== MARKET_CONSUMPTION_EVENT_TYPE
    || command.visibility !== "PRIVATE_ACCOUNT"
    || command.causation_id !== null
    || command.correlation_id !== commandEventId
    || command.policy_version !== MARKET_DECISION_POLICY_VERSION
    || command.data_key_id === null
    || command.body_digest === null || !DIGEST_PATTERN.test(command.body_digest)
    || command.topic !== MARKET_CONSUMPTION_EVENT_TYPE
    || command.payload_event_id !== commandEventId) {
    throw new Error("MARKET_CONSUMPTION_COMMAND_INVALID");
  }
}

function replayProjection(
  binding: ConsumptionBindingRow,
  observation: ObservationReplayRow | undefined,
  latest: LatestProtectedRow,
  decryptedLatestPrice: string,
  accountId: string,
  commandEventId: string,
  commandBody: { readonly symbol: string; readonly latestContextDigest: string },
  commandBodyDigest: string,
): MaterializedMarketObservation {
  const expectedRequest = consumptionRequestDigest(
    accountId,
    commandEventId,
    commandBody.symbol,
    commandBody.latestContextDigest,
  );
  const catalog = catalogBySymbol.get(commandBody.symbol);
  if (!observation || binding.account_id !== accountId
    || binding.command_event_id !== commandEventId
    || binding.symbol !== commandBody.symbol
    || binding.latest_context_digest !== commandBody.latestContextDigest
    || binding.command_body_digest !== commandBodyDigest
    || binding.latest_window_id !== latest.window_id
    || binding.latest_data_key_id !== latest.data_key_id
    || binding.latest_source_observed_at.getTime() !== latest.source_observed_at?.getTime()
    || binding.latest_received_at.getTime() !== latest.received_at.getTime()
    || binding.request_digest !== expectedRequest
    || observation.id !== binding.observation_id
    || observation.account_id !== accountId
    || observation.symbol !== commandBody.symbol
    || observation.asset_class !== (catalog?.kind === "STOCK" ? "US_STOCK" : "US_ETF")
    || observation.price !== decryptedLatestPrice
    || observation.observed_at.getTime() !== latest.source_observed_at?.getTime()
    || observation.received_at.getTime() !== latest.received_at.getTime()
    || observation.provider !== "finnhub"
    || observation.license_id !== FINNHUB_LICENSE_ID
    || observation.raw_source_ref !== `latest:${commandBody.latestContextDigest}`
    || observation.feed_status !== "REALTIME" || observation.delay_seconds !== 0
    || observation.redistribution !== "ACCOUNT_ONLY"
    || observation.session_state !== "OPEN"
    || observation.latest_context_digest !== commandBody.latestContextDigest
    || observation.decision_command_event_id !== commandEventId) {
    throw new Error("MARKET_CONSUMPTION_REPLAY_INVALID");
  }
  return Object.freeze({
    observationId: binding.observation_id,
    commandEventId,
    symbol: commandBody.symbol,
    latestContextDigest: commandBody.latestContextDigest,
  });
}

export async function materializeMarketObservation(
  context: MarketMaterializerContext,
  input: MaterializeMarketObservationInput,
): Promise<MaterializedMarketObservation> {
  const accountId = requireAccountId(context?.accountId);
  const commandEventId = requireCommandEventId(input?.commandEventId);
  const database = context?.db;
  if (!database || typeof database.transaction !== "function") {
    throw new Error("MARKET_MATERIALIZER_ROLE_REQUIRED");
  }
  return database.transaction(async (transaction) => {
    await authorizeMaterializerRole(transaction);
    await authorizeAccount(transaction, accountId);
    const commands = await transaction.query<ConsumptionCommandRow>(
      `/* market-consumption-command-authority */
       select command.id::text,command.aggregate_id,command.account_id,
              command.actor_type,command.actor_id,command.type,command.visibility,
              command.causation_id::text,command.correlation_id::text,
              command.policy_version,body.body_digest,body.data_key_id::text,
              outbox.topic,outbox.payload->>'eventId' payload_event_id
         from events command
         left join encrypted_event_bodies body on body.event_id=command.id
         left join transactional_outbox outbox on outbox.event_id=command.id
        where command.id=$1`,
      [commandEventId],
    );
    const command = commands[0];
    assertCommandMetadata(command, accountId, commandEventId);

    await authorizeAccount(transaction, accountId);
    let body: JsonValue;
    try {
      body = await readEventBody(transaction, commandEventId, {
        actor: { role: "ACCOUNT", accountId },
      });
    } catch {
      throw new Error("MARKET_CONSUMPTION_COMMAND_INVALID");
    }
    const commandBody = exactConsumptionBody(body);
    const commandBodyDigest = canonicalContentDigest(commandBody);
    if (!digestsEqual(command.body_digest!, commandBodyDigest)) {
      throw new Error("MARKET_CONSUMPTION_COMMAND_INVALID");
    }

    const bindings = await transaction.query<ConsumptionBindingRow>(
      `select command_event_id::text,account_id::text,symbol,latest_context_digest,
              command_body_digest,observation_id::text,latest_window_id,
              latest_data_key_id::text,latest_source_observed_at,latest_received_at,
              request_digest
         from market_observation_consumptions
        where command_event_id=$1
        for share`,
      [commandEventId],
    );

    await authorizeAccount(transaction, accountId);
    const keyRow = await lockedMarketKey(transaction, marketAggregateId(accountId));
    if (!keyRow || keyRow.id !== command.data_key_id) {
      throw new Error("MARKET_LATEST_KEY_UNAVAILABLE");
    }
    const latestRows = await transaction.query<LatestProtectedRow>(
      `/* market-latest-body-lock */
       select account_id::text,symbol,window_id,provider,status,source_observed_at,
              received_at,data_key_id::text,ciphertext,envelope_iv,envelope_auth_tag,
              envelope_encoding,context_digest,safe_code
         from market_latest_quotes
        where account_id=$1 and symbol=$2
        for update`,
      [accountId, commandBody.symbol],
    );
    const racedBindings = await transaction.query<ConsumptionBindingRow>(
      `/* market-consumption-post-lock-replay */
       select command_event_id::text,account_id::text,symbol,latest_context_digest,
              command_body_digest,observation_id::text,latest_window_id,
              latest_data_key_id::text,latest_source_observed_at,latest_received_at,
              request_digest
         from market_observation_consumptions
        where command_event_id=$1
           or (account_id=$2 and symbol=$3 and latest_context_digest=$4)
        order by command_event_id
        for share`,
      [commandEventId, accountId, commandBody.symbol, commandBody.latestContextDigest],
    );
    if (racedBindings.some(({ command_event_id }) => command_event_id !== commandEventId)) {
      throw new Error("MARKET_LATEST_VERSION_ALREADY_CONSUMED");
    }
    const latest = latestRows[0];
    if (!latest || latest.status !== "SUCCESS"
      || latest.context_digest !== commandBody.latestContextDigest
      || latest.data_key_id !== keyRow.id) {
      throw new Error("MARKET_LATEST_VERSION_UNAVAILABLE");
    }
    await authorizeAccount(transaction, accountId);
    const plaintextKey = unwrapDataKey(keyRow.aggregate_id, wrappedFromRow(keyRow));
    try {
      const price = decryptedPrice(latest, plaintextKey);
      const binding = racedBindings[0] ?? bindings[0];
      if (binding) {
        const observations = await transaction.query<ObservationReplayRow>(
          `select id::text,account_id::text,symbol,asset_class,price,
                  observed_at,received_at,provider,license_id,raw_source_ref,
                  feed_status,delay_seconds,redistribution,session_state,
                  latest_context_digest,decision_command_event_id::text
             from market_observations where id=$1`,
          [binding.observation_id],
        );
        return replayProjection(
          binding, observations[0], latest, price, accountId, commandEventId,
          commandBody, commandBodyDigest,
        );
      }
      const observationId = randomUUID();
      const catalog = catalogBySymbol.get(commandBody.symbol)!;
      const assetClass = catalog.kind === "STOCK" ? "US_STOCK" : "US_ETF";
      const observedAt = latest.source_observed_at!.toISOString();
      const receivedAt = latest.received_at.toISOString();
      const rawSourceRef = `latest:${commandBody.latestContextDigest}`;
      await transaction.query(
        `insert into market_observation_consumptions (
           command_event_id,account_id,symbol,latest_context_digest,observation_id
         ) values ($1,$2,$3,$4,$5)`,
        [commandEventId, accountId, commandBody.symbol,
          commandBody.latestContextDigest, observationId],
      );
      await transaction.query(
        `insert into market_instrument_allowlist (symbol,asset_class,enabled)
         values ($1,$2,true) on conflict (symbol) do nothing`,
        [commandBody.symbol, assetClass],
      );
      await transaction.query(
        `insert into market_data_sources (
           provider,license_id,licensed,redistribution
         ) values ('finnhub',$1,true,'ACCOUNT_ONLY')
         on conflict (provider,license_id) do nothing`,
        [FINNHUB_LICENSE_ID],
      );
      await transaction.query(
        `insert into market_observations (
           id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
           raw_source_ref,feed_status,delay_seconds,redistribution,session_state,
           account_id,latest_context_digest,decision_command_event_id
         ) values ($1,$2,$3,$4,$5,$6,'finnhub',$7,$8,'REALTIME',0,
                   'ACCOUNT_ONLY','OPEN',$9,$10,$11)`,
        [observationId, commandBody.symbol, assetClass,
          price, observedAt, receivedAt, FINNHUB_LICENSE_ID,
          rawSourceRef, accountId,
          commandBody.latestContextDigest, commandEventId],
      );
      return Object.freeze({
        observationId,
        commandEventId,
        symbol: commandBody.symbol,
        latestContextDigest: commandBody.latestContextDigest,
      });
    } finally {
      plaintextKey.fill(0);
    }
  });
}
