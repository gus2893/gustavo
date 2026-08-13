import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  cacheKey,
  cachePointerKey,
  inspectCacheKey,
  isCachePointerKey,
  isCacheVersionKey,
  type CacheKeyDescriptor,
  type CacheNamespace,
  type CachePointerKey,
  type CachePointerKeyInput,
  type CacheScope,
  type CacheVersionKey,
  type CacheVersionKeyInput,
  type TypedCacheKey,
} from "./keys";

export { cacheKey, cachePointerKey } from "./keys";
export type {
  CacheKeyDescriptor,
  CacheNamespace,
  CachePointerKey,
  CachePointerKeyInput,
  CacheScope,
  CacheVersionKey,
  CacheVersionKeyInput,
  TypedCacheKey,
} from "./keys";

export type CacheJson =
  | boolean
  | number
  | string
  | null
  | readonly CacheJson[]
  | { readonly [key: string]: CacheJson };

export type ProtectedProjectionDto =
  | {
      readonly kind: "AUTHORIZED_CONTEXT_PACK";
      readonly accountId: string;
      readonly sourceEventIds: readonly string[];
      readonly sourceHighWater: string;
      readonly generatedAt: string;
      readonly excerpts: readonly {
        readonly sourceEventId: string;
        readonly text: string;
      }[];
    }
  | {
      readonly kind: "NODE_DOSSIER";
      readonly accountId: string;
      readonly nodeBrainId: string;
      readonly conversationId: string;
      readonly sourceEventIds: readonly string[];
      readonly sourceHighWater: string;
      readonly mainStateVersion: string;
      readonly route: {
        readonly classificationConfidence: number;
        readonly mode: string;
        readonly policyVersion: string;
        readonly reason: string;
        readonly response: {
          readonly authority: string;
          readonly canonical: boolean;
          readonly label: string;
        };
        readonly sourceIds: readonly string[];
      };
      readonly occurredAt: string;
    }
  | {
      readonly kind: "NODE_HANDOFF";
      readonly accountId: string;
      readonly nodeBrainId: string;
      readonly conversationId: string;
      readonly sourceEventIds: readonly string[];
      readonly sourceHighWater: string;
      readonly mainStateVersion: string;
      readonly packetKind: "PACKET" | "EMPTY_CHECKPOINT";
      readonly packetVersion: string;
      readonly throughEventId: string;
      readonly ideaCount: number;
      readonly items: readonly {
        readonly id: string;
        readonly proposalId: string;
        readonly kind: string;
        readonly text: string;
        readonly sourceIds: readonly string[];
        readonly memoryVersions: readonly {
          readonly memoryId: string;
          readonly version: string;
        }[];
      }[];
      readonly occurredAt: string;
    };

const MAX_CACHE_BYTES = 256 * 1_024;
const MAX_PROTECTED_CACHE_BYTES = 96 * 1_024;
const MAX_PROTECTED_TTL_SECONDS = 300;
const MAX_NEGATIVE_TTL_SECONDS = 30;
const MAX_REBUILD_RECORDS = 10_000;
const REBUILD_PAGE_SIZE = 100;
const MAX_PROJECTION_SOURCE_ROWS = 1_000;
const MAX_PROTECTED_SOURCE_IDS = 64;
const MAX_PROTECTED_HANDOFF_SOURCE_IDS = 770;
const MAX_PROTECTED_EXCERPTS = 24;
const MAX_PROTECTED_HANDOFF_IDEAS = 24;
const MAX_PROTECTED_HANDOFF_ITEMS_PER_IDEA = 5;
const MAX_PROTECTED_MEMORY_VERSIONS = 64;
const MAX_PROTECTED_TEXT_LENGTH = 2_000;
const REBUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/u;
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RAW_PRIVATE_FIELDS = new Set([
  "rawchat",
  "rawmessages",
  "rawtext",
  "rawtranscript",
  "transcript",
  "transcripttext",
  "messagehistory",
  "privatemessages",
]);
const PROCESS_LRU_NAMESPACES: ReadonlySet<CacheNamespace> = new Set([
  "configuration",
  "policy",
  "public-metadata",
]);
const CRITICAL_NAMESPACES: ReadonlySet<CacheNamespace> = new Set([
  "main-state",
  "broadcast",
  "challenge-snapshot",
  "handoff",
  "node-dossier",
]);

interface PlainEnvelope {
  readonly format: "gustavo-cache-envelope-v1";
  readonly protected: false;
  readonly negative: boolean;
  readonly contentDigest: string;
  readonly value: CacheJson | null;
}

interface ProtectedEnvelope {
  readonly format: "gustavo-cache-envelope-v1";
  readonly protected: true;
  readonly negative: boolean;
  readonly contentDigest: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

type CacheEnvelope = PlainEnvelope | ProtectedEnvelope;

interface PointerEnvelope {
  readonly format: "gustavo-cache-pointer-v1";
  readonly target: CacheVersionKey;
  readonly ordinal: string;
  readonly signature: string;
}

interface BackendValue {
  readonly value: string;
  readonly expiresAt: number;
}

export interface CacheBackend {
  read(key: string): Promise<string | null>;
  putImmutable(key: string, value: string, expiresAt: number): Promise<"STORED" | "EXISTS">;
  extendExpiry(key: string, expiresAt: number): Promise<boolean>;
  putPointerIfNewer(
    key: string,
    value: string,
    ordinal: string,
    expiresAt: number,
  ): Promise<"STORED" | "STALE_IGNORED">;
  deletePointerThrough(key: string, throughOrdinal: string): Promise<"INVALIDATED" | "STALE_IGNORED" | "MISSING">;
  acquireLease(key: string, owner: string, expiresAt: number): Promise<boolean>;
  releaseLease(key: string, owner: string): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMatching(input: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly maximumKeys: number;
  }): Promise<number>;
  flushAll(): Promise<void>;
}

export interface ValkeyTransport {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { readonly NX: true; readonly PXAT: number },
  ): Promise<string | null>;
  eval(
    script: string,
    options: { readonly keys: readonly string[]; readonly arguments: readonly string[] },
  ): Promise<number | string | null>;
  scan(
    cursor: string,
    options: { readonly MATCH: string; readonly COUNT: number },
  ): Promise<{ readonly cursor: string; readonly keys: readonly string[] }>;
  del(keys: readonly string[]): Promise<number>;
}

const VALKEY_PREFIX = "gustavo-cache:v1:";
const VALKEY_MAX_FLUSH_KEYS = 100_000;
const VALKEY_MAX_SCAN_PAGES = 10_000;

const EXTEND_EXPIRY_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('PEXPIREAT', KEYS[1], ARGV[1])
return 1`;

const PUT_POINTER_SCRIPT = `
local function compare_decimal(left, right)
  if string.len(left) ~= string.len(right) then
    if string.len(left) > string.len(right) then return 1 else return -1 end
  end
  if left == right then return 0 end
  if left > right then return 1 else return -1 end
end
local existing = redis.call('GET', KEYS[1])
if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if not ok or type(decoded.ordinal) ~= 'string' then
    redis.call('DEL', KEYS[1])
  else
    local comparison = compare_decimal(decoded.ordinal, ARGV[2])
    if comparison > 0 then return 0 end
    if comparison == 0 then
      if existing ~= ARGV[1] then return 0 end
      redis.call('PEXPIREAT', KEYS[1], ARGV[3])
      return 1
    end
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[3])
return 1`;

const INVALIDATE_POINTER_SCRIPT = `
local function compare_decimal(left, right)
  if string.len(left) ~= string.len(right) then
    if string.len(left) > string.len(right) then return 1 else return -1 end
  end
  if left == right then return 0 end
  if left > right then return 1 else return -1 end
end
local existing = redis.call('GET', KEYS[1])
if not existing then return -1 end
local ok, decoded = pcall(cjson.decode, existing)
if not ok or type(decoded.ordinal) ~= 'string' then
  redis.call('DEL', KEYS[1])
  return 1
end
if compare_decimal(decoded.ordinal, ARGV[1]) > 0 then return 0 end
redis.call('DEL', KEYS[1])
return 1`;

const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;

function valkeyStorageKey(key: string): string {
  if (typeof key !== "string" || !key.startsWith(VALKEY_PREFIX) || key.length > 4_096) {
    throw new Error("CACHE_STORAGE_KEY_INVALID");
  }
  if (/^gustavo-cache:v1:lease:[a-f0-9]{64}$/u.test(key)) return key;
  try {
    inspectCacheKey(key as TypedCacheKey);
  } catch {
    throw new Error("CACHE_STORAGE_KEY_INVALID");
  }
  return key;
}

function valkeyExpiry(expiresAt: number): number {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("CACHE_STORAGE_EXPIRY_INVALID");
  }
  return expiresAt;
}

/** Atomic Valkey implementation; all raw commands remain inside this adapter. */
export class ValkeyCacheBackend implements CacheBackend {
  readonly #client: ValkeyTransport;

  constructor(client: ValkeyTransport) {
    if (!client || typeof client !== "object") throw new Error("CACHE_VALKEY_CLIENT_INVALID");
    this.#client = client;
  }

  async read(key: string): Promise<string | null> {
    return this.#client.get(valkeyStorageKey(key));
  }

  async putImmutable(key: string, value: string, expiresAt: number): Promise<"STORED" | "EXISTS"> {
    const result = await this.#client.set(valkeyStorageKey(key), value, {
      NX: true,
      PXAT: valkeyExpiry(expiresAt),
    });
    return result === "OK" ? "STORED" : "EXISTS";
  }

  async extendExpiry(key: string, expiresAt: number): Promise<boolean> {
    const result = await this.#client.eval(EXTEND_EXPIRY_SCRIPT, {
      keys: [valkeyStorageKey(key)],
      arguments: [String(valkeyExpiry(expiresAt))],
    });
    return Number(result) === 1;
  }

  async putPointerIfNewer(
    key: string,
    value: string,
    ordinal: string,
    expiresAt: number,
  ): Promise<"STORED" | "STALE_IGNORED"> {
    ordinalValue(ordinal);
    const result = await this.#client.eval(PUT_POINTER_SCRIPT, {
      keys: [valkeyStorageKey(key)],
      arguments: [value, ordinal, String(valkeyExpiry(expiresAt))],
    });
    return Number(result) === 1 ? "STORED" : "STALE_IGNORED";
  }

  async deletePointerThrough(
    key: string,
    throughOrdinal: string,
  ): Promise<"INVALIDATED" | "STALE_IGNORED" | "MISSING"> {
    ordinalValue(throughOrdinal);
    const result = Number(await this.#client.eval(INVALIDATE_POINTER_SCRIPT, {
      keys: [valkeyStorageKey(key)],
      arguments: [throughOrdinal],
    }));
    if (result === 1) return "INVALIDATED";
    if (result === 0) return "STALE_IGNORED";
    return "MISSING";
  }

  async acquireLease(key: string, owner: string, expiresAt: number): Promise<boolean> {
    if (typeof owner !== "string" || owner.length < 1 || owner.length > 128) {
      throw new Error("CACHE_LEASE_OWNER_INVALID");
    }
    const result = await this.#client.set(valkeyStorageKey(key), owner, {
      NX: true,
      PXAT: valkeyExpiry(expiresAt),
    });
    return result === "OK";
  }

  async releaseLease(key: string, owner: string): Promise<void> {
    await this.#client.eval(RELEASE_LEASE_SCRIPT, {
      keys: [valkeyStorageKey(key)],
      arguments: [owner],
    });
  }

  async delete(key: string): Promise<void> {
    await this.#client.del([valkeyStorageKey(key)]);
  }

  async deleteMatching(input: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly maximumKeys: number;
  }): Promise<number> {
    let cursor = "0";
    let pages = 0;
    const matched = new Set<string>();
    do {
      const page = await this.#client.scan(cursor, {
        MATCH: `${VALKEY_PREFIX}*`, COUNT: 250,
      });
      if (!page || typeof page.cursor !== "string" || !Array.isArray(page.keys)) {
        throw new Error("CACHE_VALKEY_SCAN_INVALID");
      }
      pages += 1;
      if (pages > VALKEY_MAX_SCAN_PAGES) throw new Error("CACHE_VALKEY_PURGE_BOUND_EXCEEDED");
      const matches = page.keys.filter((key) => {
        try {
          const descriptor = inspectCacheKey(key as TypedCacheKey);
          return descriptor.scope === "PRIVATE_ACCOUNT"
            && descriptor.identityId === input.accountId
            && descriptor.entityId === input.conversationId;
        } catch {
          return false;
        }
      });
      for (const key of matches) matched.add(key);
      if (matched.size > input.maximumKeys) {
        throw new Error("CACHE_VALKEY_PURGE_BOUND_EXCEEDED");
      }
      cursor = page.cursor;
    } while (cursor !== "0");
    let deleted = 0;
    const keys = [...matched];
    for (let offset = 0; offset < keys.length; offset += 250) {
      deleted += await this.#client.del(keys.slice(offset, offset + 250));
    }
    return deleted;
  }

  async flushAll(): Promise<void> {
    let cursor = "0";
    let pages = 0;
    let deleted = 0;
    do {
      const page = await this.#client.scan(cursor, {
        MATCH: `${VALKEY_PREFIX}*`,
        COUNT: 250,
      });
      if (!page || typeof page.cursor !== "string" || !Array.isArray(page.keys)) {
        throw new Error("CACHE_VALKEY_SCAN_INVALID");
      }
      if (page.keys.some((key) => !key.startsWith(VALKEY_PREFIX))) {
        throw new Error("CACHE_VALKEY_SCAN_SCOPE_INVALID");
      }
      deleted += page.keys.length;
      pages += 1;
      if (deleted > VALKEY_MAX_FLUSH_KEYS || pages > VALKEY_MAX_SCAN_PAGES) {
        throw new Error("CACHE_VALKEY_FLUSH_BOUND_EXCEEDED");
      }
      if (page.keys.length > 0) await this.#client.del(page.keys);
      cursor = page.cursor;
    } while (cursor !== "0");
  }
}

interface MemoryCacheBackendOptions {
  readonly now?: () => number;
}

/**
 * Deterministic backend used by tests and local composition. Production
 * Valkey adapters implement CacheBackend; no domain module sees raw commands.
 */
export class MemoryCacheBackend implements CacheBackend {
  readonly #values = new Map<string, BackendValue>();
  readonly #leases = new Map<string, { readonly owner: string; readonly expiresAt: number }>();
  readonly #now: () => number;
  #reads = 0;
  #writes = 0;

  constructor(options: MemoryCacheBackendOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  #live(key: string): BackendValue | null {
    const stored = this.#values.get(key);
    if (!stored) return null;
    if (stored.expiresAt <= this.#now()) {
      this.#values.delete(key);
      return null;
    }
    return stored;
  }

  async read(key: string): Promise<string | null> {
    this.#reads += 1;
    return this.#live(key)?.value ?? null;
  }

  async putImmutable(key: string, value: string, expiresAt: number): Promise<"STORED" | "EXISTS"> {
    if (this.#live(key)) return "EXISTS";
    this.#values.set(key, { value, expiresAt });
    this.#writes += 1;
    return "STORED";
  }

  async extendExpiry(key: string, expiresAt: number): Promise<boolean> {
    const existing = this.#live(key);
    if (!existing) return false;
    this.#values.set(key, { value: existing.value, expiresAt: Math.max(existing.expiresAt, expiresAt) });
    return true;
  }

  async putPointerIfNewer(
    key: string,
    value: string,
    ordinal: string,
    expiresAt: number,
  ): Promise<"STORED" | "STALE_IGNORED"> {
    const nextOrdinal = ordinalValue(ordinal);
    const existing = this.#live(key);
    if (existing) {
      const pointer = parsePointer(existing.value);
      const existingOrdinal = ordinalValue(pointer.ordinal);
      if (existingOrdinal > nextOrdinal) return "STALE_IGNORED";
      if (existingOrdinal === nextOrdinal) {
        if (existing.value !== value) return "STALE_IGNORED";
        this.#values.set(key, { value: existing.value, expiresAt: Math.max(existing.expiresAt, expiresAt) });
        return "STORED";
      }
    }
    this.#values.set(key, { value, expiresAt });
    this.#writes += 1;
    return "STORED";
  }

  async deletePointerThrough(
    key: string,
    throughOrdinal: string,
  ): Promise<"INVALIDATED" | "STALE_IGNORED" | "MISSING"> {
    const existing = this.#live(key);
    if (!existing) return "MISSING";
    const pointer = parsePointer(existing.value);
    if (ordinalValue(pointer.ordinal) > ordinalValue(throughOrdinal)) return "STALE_IGNORED";
    this.#values.delete(key);
    return "INVALIDATED";
  }

  async acquireLease(key: string, owner: string, expiresAt: number): Promise<boolean> {
    const existing = this.#leases.get(key);
    if (existing && existing.expiresAt > this.#now()) return false;
    if (expiresAt <= this.#now()) throw new Error("CACHE_LEASE_EXPIRY_INVALID");
    this.#leases.set(key, { owner, expiresAt });
    return true;
  }

  async releaseLease(key: string, owner: string): Promise<void> {
    const existing = this.#leases.get(key);
    if (existing?.owner === owner) this.#leases.delete(key);
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }

  async deleteMatching(input: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly maximumKeys: number;
  }): Promise<number> {
    const matches = [...this.#values.keys()].filter((key) => {
      try {
        const descriptor = inspectCacheKey(key as TypedCacheKey);
        return descriptor.scope === "PRIVATE_ACCOUNT"
          && descriptor.identityId === input.accountId
          && descriptor.entityId === input.conversationId;
      } catch {
        return false;
      }
    });
    if (matches.length > input.maximumKeys) throw new Error("CACHE_PURGE_BOUND_EXCEEDED");
    for (const key of matches) this.#values.delete(key);
    return matches.length;
  }

  async flushAll(): Promise<void> {
    this.#values.clear();
    this.#leases.clear();
  }

  peek(key: string): string | null {
    return this.#live(key)?.value ?? null;
  }

  stats(): { readonly reads: number; readonly writes: number; readonly entries: number } {
    return Object.freeze({ reads: this.#reads, writes: this.#writes, entries: this.#values.size });
  }
}

interface MetricAggregate {
  count: number;
  total: number;
  max: number;
}

export interface CacheMetricSnapshot {
  readonly hits: number;
  readonly misses: number;
  readonly authorizationFilteredMisses: number;
  readonly fallbacks: number;
  readonly invalidations: number;
  readonly invalidationFailures: number;
  readonly prewarms: number;
  readonly prewarmFailures: number;
  readonly rebuilds: number;
  readonly staleVersionRejections: number;
  readonly singleFlightContention: number;
  readonly evictions: number;
  readonly backendFailures: number;
  readonly fallbackLatencyMs: Readonly<MetricAggregate>;
  readonly fallbackLatencySequence: number;
  readonly fallbackLatencyWindow: readonly Readonly<{ readonly sequence: number; readonly value: number }>[];
  readonly cacheReadLatencyMs: Readonly<MetricAggregate>;
  readonly invalidationLatencyMs: Readonly<MetricAggregate>;
  readonly prewarmLatencyMs: Readonly<MetricAggregate>;
  readonly freshnessLagMs: Readonly<MetricAggregate>;
  readonly rebuildLatencyMs: Readonly<MetricAggregate>;
  readonly byNamespace: Readonly<Record<string, Readonly<{ hits: number; misses: number }>>>;
}

class CacheMetrics {
  hits = 0;
  misses = 0;
  authorizationFilteredMisses = 0;
  fallbacks = 0;
  invalidations = 0;
  invalidationFailures = 0;
  prewarms = 0;
  prewarmFailures = 0;
  rebuilds = 0;
  staleVersionRejections = 0;
  singleFlightContention = 0;
  evictions = 0;
  backendFailures = 0;
  readonly fallbackLatencyMs: MetricAggregate = { count: 0, total: 0, max: 0 };
  fallbackLatencySequence = 0;
  readonly fallbackLatencyWindow: { sequence: number; value: number }[] = [];
  readonly cacheReadLatencyMs: MetricAggregate = { count: 0, total: 0, max: 0 };
  readonly invalidationLatencyMs: MetricAggregate = { count: 0, total: 0, max: 0 };
  readonly prewarmLatencyMs: MetricAggregate = { count: 0, total: 0, max: 0 };
  readonly freshnessLagMs: MetricAggregate = { count: 0, total: 0, max: 0 };
  readonly rebuildLatencyMs: MetricAggregate = { count: 0, total: 0, max: 0 };
  readonly byNamespace = new Map<CacheNamespace, { hits: number; misses: number }>();

  namespace(namespace: CacheNamespace, result: "HIT" | "MISS") {
    const metric = this.byNamespace.get(namespace) ?? { hits: 0, misses: 0 };
    if (result === "HIT") metric.hits += 1;
    else metric.misses += 1;
    this.byNamespace.set(namespace, metric);
  }

  observe(metric: MetricAggregate, value: number) {
    const bounded = Number.isFinite(value) && value >= 0 ? value : 0;
    metric.count += 1;
    metric.total += bounded;
    metric.max = Math.max(metric.max, bounded);
  }

  observeFallback(value: number) {
    const bounded = Number.isFinite(value) && value >= 0 ? value : 0;
    this.observe(this.fallbackLatencyMs, bounded);
    this.fallbackLatencySequence += 1;
    this.fallbackLatencyWindow.push(Object.freeze({
      sequence: this.fallbackLatencySequence, value: bounded,
    }));
    if (this.fallbackLatencyWindow.length > 4_096) this.fallbackLatencyWindow.shift();
  }

  snapshot(): CacheMetricSnapshot {
    return Object.freeze({
      hits: this.hits,
      misses: this.misses,
      authorizationFilteredMisses: this.authorizationFilteredMisses,
      fallbacks: this.fallbacks,
      invalidations: this.invalidations,
      invalidationFailures: this.invalidationFailures,
      prewarms: this.prewarms,
      prewarmFailures: this.prewarmFailures,
      rebuilds: this.rebuilds,
      staleVersionRejections: this.staleVersionRejections,
      singleFlightContention: this.singleFlightContention,
      evictions: this.evictions,
      backendFailures: this.backendFailures,
      fallbackLatencyMs: Object.freeze({ ...this.fallbackLatencyMs }),
      fallbackLatencySequence: this.fallbackLatencySequence,
      fallbackLatencyWindow: Object.freeze(this.fallbackLatencyWindow.map((item) => (
        Object.freeze({ ...item })
      ))),
      cacheReadLatencyMs: Object.freeze({ ...this.cacheReadLatencyMs }),
      invalidationLatencyMs: Object.freeze({ ...this.invalidationLatencyMs }),
      prewarmLatencyMs: Object.freeze({ ...this.prewarmLatencyMs }),
      freshnessLagMs: Object.freeze({ ...this.freshnessLagMs }),
      rebuildLatencyMs: Object.freeze({ ...this.rebuildLatencyMs }),
      byNamespace: Object.freeze(Object.fromEntries(
        [...this.byNamespace.entries()].map(([namespace, metric]) => [
          namespace,
          Object.freeze({ ...metric }),
        ]),
      )),
    });
  }
}

interface LruEntry {
  readonly value: CacheJson | null;
  readonly negative: boolean;
  readonly expiresAt: number;
}

class BoundedLru {
  readonly #values = new Map<string, LruEntry>();
  readonly #limit: number;
  readonly #metrics: CacheMetrics;

  constructor(limit: number, metrics: CacheMetrics) {
    this.#limit = limit;
    this.#metrics = metrics;
  }

  get(key: string, now: number): LruEntry | null {
    const entry = this.#values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.#values.delete(key);
      return null;
    }
    this.#values.delete(key);
    this.#values.set(key, entry);
    return entry;
  }

  set(key: string, entry: LruEntry) {
    if (this.#limit === 0) return;
    this.#values.delete(key);
    this.#values.set(key, entry);
    while (this.#values.size > this.#limit) {
      const oldest = this.#values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#values.delete(oldest);
      this.#metrics.evictions += 1;
    }
  }

  delete(key: string) {
    this.#values.delete(key);
  }

  deleteMatching(predicate: (key: string) => boolean): number {
    let deleted = 0;
    for (const key of this.#values.keys()) {
      if (!predicate(key)) continue;
      this.#values.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  clear() {
    this.#values.clear();
  }

  get size() {
    return this.#values.size;
  }
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("CACHE_VALUE_DEPTH_INVALID");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CACHE_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 20_000) throw new Error("CACHE_VALUE_INVALID");
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("CACHE_VALUE_INVALID");
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((name) => {
    if (object[name] === undefined) throw new Error("CACHE_VALUE_INVALID");
    return `${JSON.stringify(name)}:${canonical(object[name], depth + 1)}`;
  }).join(",")}}`;
}

function freezeJson<Value extends CacheJson>(value: Value): Value {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value) as Value;
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    return Object.freeze(value) as Value;
  }
  return value;
}

function normalizedJson(value: CacheJson | null): CacheJson | null {
  if (value === null) return null;
  return freezeJson(JSON.parse(canonical(value)) as CacheJson);
}

function contentDigest(value: CacheJson | null): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Canonical projection digest shared by PostgreSQL adapters and workers. */
export function projectionValueHash(value: CacheJson): string {
  return contentDigest(value);
}

function protectedDescriptor(descriptor: CacheKeyDescriptor): boolean {
  return descriptor.scope === "PRIVATE_ACCOUNT"
    || descriptor.scope === "OPERATOR"
    || descriptor.namespace === "session"
    || descriptor.namespace === "rate-limit";
}

function containsRawTranscript(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsRawTranscript(item, depth + 1));
  return Object.entries(value).some(([name, child]) => (
    RAW_PRIVATE_FIELDS.has(name.toLowerCase().replace(/[_-]/gu, ""))
    || containsRawTranscript(child, depth + 1)
  ));
}

function exactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function boundedString(value: unknown, maximum = 240): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function sourceIds(value: unknown, maximum = MAX_PROTECTED_SOURCE_IDS): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= maximum
    && value.every((item) => typeof item === "string" && EVENT_ID_PATTERN.test(item));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validProtectedProjection(value: unknown): value is ProtectedProjectionDto {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "AUTHORIZED_CONTEXT_PACK") {
    if (!exactKeys(candidate, [
      "kind", "accountId", "sourceEventIds", "sourceHighWater", "generatedAt", "excerpts",
    ]) || !boundedString(candidate.accountId) || !sourceIds(candidate.sourceEventIds)
      || !boundedString(candidate.sourceHighWater) || !canonicalTimestamp(candidate.generatedAt)
      || !Array.isArray(candidate.excerpts) || candidate.excerpts.length > MAX_PROTECTED_EXCERPTS) {
      return false;
    }
    return candidate.excerpts.every((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const excerpt = entry as Record<string, unknown>;
      return exactKeys(excerpt, ["sourceEventId", "text"])
        && EVENT_ID_PATTERN.test(String(excerpt.sourceEventId))
        && boundedString(excerpt.text, MAX_PROTECTED_TEXT_LENGTH)
        && (candidate.sourceEventIds as readonly string[]).includes(String(excerpt.sourceEventId));
    });
  }
  if (candidate.kind === "NODE_DOSSIER") {
    if (!(exactKeys(candidate, [
      "kind", "accountId", "nodeBrainId", "conversationId", "sourceEventIds",
      "sourceHighWater", "mainStateVersion", "route", "occurredAt",
    ]) && boundedString(candidate.accountId) && boundedString(candidate.nodeBrainId)
      && boundedString(candidate.conversationId) && sourceIds(candidate.sourceEventIds)
      && boundedString(candidate.sourceHighWater) && boundedString(candidate.mainStateVersion)
      && canonicalTimestamp(candidate.occurredAt))) return false;
    if (candidate.route === null || typeof candidate.route !== "object"
        || Array.isArray(candidate.route)) return false;
    const route = candidate.route as Record<string, unknown>;
    if (!exactKeys(route, [
      "classificationConfidence", "mode", "policyVersion", "reason", "response", "sourceIds",
    ]) || typeof route.classificationConfidence !== "number"
      || !Number.isFinite(route.classificationConfidence)
      || route.classificationConfidence < 0 || route.classificationConfidence > 1
      || !boundedString(route.mode, 64) || !boundedString(route.policyVersion)
      || !boundedString(route.reason, 64) || !sourceIds(route.sourceIds)
      || route.response === null || typeof route.response !== "object"
      || Array.isArray(route.response)) return false;
    const response = route.response as Record<string, unknown>;
    return exactKeys(response, ["authority", "canonical", "label"])
      && boundedString(response.authority, 64) && typeof response.canonical === "boolean"
      && boundedString(response.label, 160);
  }
  if (candidate.kind === "NODE_HANDOFF") {
    if (!(exactKeys(candidate, [
      "kind", "accountId", "nodeBrainId", "conversationId", "sourceEventIds",
      "sourceHighWater", "mainStateVersion", "packetKind", "packetVersion",
      "throughEventId", "ideaCount", "items", "occurredAt",
    ]) && boundedString(candidate.accountId) && boundedString(candidate.nodeBrainId)
      && boundedString(candidate.conversationId)
      && sourceIds(candidate.sourceEventIds, MAX_PROTECTED_HANDOFF_SOURCE_IDS)
      && boundedString(candidate.sourceHighWater) && boundedString(candidate.mainStateVersion)
      && (candidate.packetKind === "PACKET" || candidate.packetKind === "EMPTY_CHECKPOINT")
      && boundedString(candidate.packetVersion)
      && EVENT_ID_PATTERN.test(String(candidate.throughEventId))
      && (candidate.sourceEventIds as readonly string[]).includes(candidate.throughEventId as string)
      && Number.isSafeInteger(candidate.ideaCount) && (candidate.ideaCount as number) >= 0
      && (candidate.ideaCount as number) <= MAX_PROTECTED_HANDOFF_IDEAS
      && canonicalTimestamp(candidate.occurredAt)
      && Array.isArray(candidate.items)
      && (candidate.packetKind === "EMPTY_CHECKPOINT"
        ? candidate.ideaCount === 0 && candidate.items.length === 0
        : (candidate.ideaCount as number) > 0
          && candidate.items.length >= (candidate.ideaCount as number)
          && candidate.items.length <= (candidate.ideaCount as number)
            * MAX_PROTECTED_HANDOFF_ITEMS_PER_IDEA))) return false;
    return candidate.items.every((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      const item = entry as Record<string, unknown>;
      if (!exactKeys(item, [
        "id", "proposalId", "kind", "text", "sourceIds", "memoryVersions",
      ]) || !boundedString(item.id, 320)
        || !EVENT_ID_PATTERN.test(String(item.proposalId))
        || !boundedString(item.kind, 64) || !boundedString(item.text, MAX_PROTECTED_TEXT_LENGTH)
        || !sourceIds(item.sourceIds) || !Array.isArray(item.memoryVersions)
        || item.memoryVersions.length > MAX_PROTECTED_MEMORY_VERSIONS) return false;
      return item.memoryVersions.every((entryVersion) => {
        if (entryVersion === null || typeof entryVersion !== "object"
            || Array.isArray(entryVersion)) return false;
        const memory = entryVersion as Record<string, unknown>;
        return exactKeys(memory, ["memoryId", "version"])
          && EVENT_ID_PATTERN.test(String(memory.memoryId)) && boundedString(memory.version);
      });
    });
  }
  return false;
}

function encryptionKey(value: Uint8Array | undefined): Buffer {
  if (value === undefined) return randomBytes(32);
  const key = Buffer.from(value);
  if (key.length !== 32) throw new Error("CACHE_ENCRYPTION_KEY_INVALID");
  return key;
}

function encryptEnvelope(
  key: CacheVersionKey,
  value: CacheJson | null,
  negative: boolean,
  secret: Buffer,
): ProtectedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(key, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(canonical(value), "utf8"), cipher.final()]);
  return Object.freeze({
    format: "gustavo-cache-envelope-v1",
    protected: true,
    negative,
    contentDigest: contentDigest(value),
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  });
}

function parseEnvelope(serialized: string): CacheEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("CACHE_ENVELOPE_INVALID");
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("CACHE_ENVELOPE_INVALID");
  const envelope = parsed as Partial<CacheEnvelope> & Record<string, unknown>;
  if (
    envelope.format !== "gustavo-cache-envelope-v1"
    || typeof envelope.protected !== "boolean"
    || typeof envelope.negative !== "boolean"
    || typeof envelope.contentDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test(envelope.contentDigest)
  ) {
    throw new Error("CACHE_ENVELOPE_INVALID");
  }
  if (envelope.protected) {
    if (typeof envelope.iv !== "string"
        || typeof envelope.ciphertext !== "string"
        || typeof envelope.authTag !== "string") {
      throw new Error("CACHE_ENVELOPE_INVALID");
    }
  } else if (!("value" in envelope)) {
    throw new Error("CACHE_ENVELOPE_INVALID");
  }
  return envelope as unknown as CacheEnvelope;
}

function decodeEnvelope(
  key: CacheVersionKey,
  envelope: CacheEnvelope,
  secret: Buffer,
): { readonly value: CacheJson | null; readonly negative: boolean } {
  let value: CacheJson | null;
  if (envelope.protected) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(envelope.iv, "base64url"));
      decipher.setAAD(Buffer.from(key, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      value = JSON.parse(plaintext) as CacheJson;
    } catch {
      throw new Error("CACHE_DECRYPTION_FAILED");
    }
  } else {
    value = envelope.value;
  }
  const actual = Buffer.from(contentDigest(value), "hex");
  const claimed = Buffer.from(envelope.contentDigest, "hex");
  if (actual.length !== claimed.length || !timingSafeEqual(actual, claimed)) {
    throw new Error("CACHE_CONTENT_DIGEST_INVALID");
  }
  if (envelope.negative && value !== null) throw new Error("CACHE_NEGATIVE_VALUE_INVALID");
  return Object.freeze({ value: normalizedJson(value), negative: envelope.negative });
}

function ordinalValue(value: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("CACHE_VERSION_ORDINAL_INVALID");
  }
  return BigInt(value);
}

function parsePointer(serialized: string): PointerEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("CACHE_POINTER_INVALID");
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("CACHE_POINTER_INVALID");
  const pointer = parsed as Partial<PointerEnvelope>;
  if (
    pointer.format !== "gustavo-cache-pointer-v1"
    || typeof pointer.target !== "string"
    || typeof pointer.ordinal !== "string"
    || typeof pointer.signature !== "string"
    || !/^[a-f0-9]{64}$/u.test(pointer.signature)
  ) {
    throw new Error("CACHE_POINTER_INVALID");
  }
  if (!isCacheVersionKey(pointer.target as CacheVersionKey)) throw new Error("CACHE_POINTER_INVALID");
  ordinalValue(pointer.ordinal);
  return Object.freeze(pointer as PointerEnvelope);
}

function pointerSignature(
  pointerKey: CachePointerKey,
  target: CacheVersionKey,
  ordinal: string,
  secret: Buffer,
): string {
  return createHmac("sha256", secret)
    .update(canonical([pointerKey, target, ordinal]))
    .digest("hex");
}

function verifyPointerSignature(
  pointerKey: CachePointerKey,
  pointer: PointerEnvelope,
  secret: Buffer,
): void {
  const actual = Buffer.from(pointerSignature(pointerKey, pointer.target, pointer.ordinal, secret), "hex");
  const claimed = Buffer.from(pointer.signature, "hex");
  if (actual.length !== claimed.length || !timingSafeEqual(actual, claimed)) {
    throw new Error("CACHE_POINTER_SIGNATURE_INVALID");
  }
}

function samePointerScope(pointer: CacheKeyDescriptor, target: CacheKeyDescriptor): boolean {
  return pointer.namespace === target.namespace
    && pointer.scope === target.scope
    && pointer.entityId === target.entityId
    && pointer.identityId === target.identityId
    && pointer.topologyVersion === target.topologyVersion
    && pointer.policyVersion === target.policyVersion
    && pointer.schemaVersion === target.schemaVersion;
}

export interface CacheSetOptions {
  readonly ttlSeconds: number;
  readonly encrypted?: boolean;
  readonly alreadyAuthorized?: boolean;
  readonly negative?: boolean;
}

export interface CacheFallbackResult<Value extends CacheJson> {
  readonly value: Value | null;
  readonly rowsRead: number;
}

export interface CacheReadThroughOptions<Value extends CacheJson> extends CacheSetOptions {
  readonly maxRows: number;
  readonly negativeTtlSeconds?: number;
  readonly decisionCritical?: boolean;
  readonly load: () => Promise<CacheFallbackResult<Value>>;
}

export interface CachePublishInput<Value extends CacheJson> {
  readonly pointerKey: CachePointerKey;
  readonly versionKey: CacheVersionKey;
  readonly versionOrdinal: string;
  readonly value: Value;
  readonly options: CacheSetOptions;
  readonly sourceOccurredAt?: string;
}

export interface CacheProtectedGuardContext {
  /**
   * A transaction-scoped database facade supplied by the production guard.
   * It is intentionally opaque here so cache-only callers cannot depend on a
   * database implementation. The facade expires when the fence is released.
   */
  readonly database?: unknown;
}

export type CacheProtectedPublicationGuard = <Result>(
  descriptor: CacheKeyDescriptor,
  publish: (context: CacheProtectedGuardContext) => Promise<Result>,
  operation: "READ" | "WRITE" | "INVALIDATE",
) => Promise<Result>;

export interface ScopedCacheOptions {
  readonly backend?: CacheBackend;
  readonly encryptionKey?: Uint8Array;
  readonly authorize?: (
    descriptor: CacheKeyDescriptor,
    context: CacheProtectedGuardContext | undefined,
  ) => boolean | Promise<boolean>;
  readonly protectedPublicationGuard?: CacheProtectedPublicationGuard;
  readonly requireProtectedPublicationGuard?: boolean;
  readonly processLruEntries?: number;
  readonly authoritativeSource?: CriticalProjectionSource;
  readonly now?: () => number;
  readonly random?: () => number;
}

interface ProtectedFenceLease {
  readonly nonce: symbol;
  readonly descriptor: CacheKeyDescriptor;
  readonly context: CacheProtectedGuardContext;
  readonly pending: Set<Promise<unknown>>;
  readonly failures: unknown[];
  active: boolean;
}

type CacheLookup<Value extends CacheJson> =
  | { readonly status: "HIT"; readonly value: Value }
  | { readonly status: "NEGATIVE"; readonly value: null }
  | { readonly status: "MISS"; readonly value: null };

export class ScopedCache {
  readonly #backend: CacheBackend;
  readonly #secret: Buffer;
  readonly #authorize: (
    descriptor: CacheKeyDescriptor,
    context: CacheProtectedGuardContext | undefined,
  ) => boolean | Promise<boolean>;
  readonly #protectedPublicationGuard: CacheProtectedPublicationGuard | undefined;
  readonly #requireProtectedPublicationGuard: boolean;
  readonly #fenceNonce = Symbol("cache-protected-fence");
  readonly #fenceContext = new AsyncLocalStorage<ProtectedFenceLease>();
  readonly #lru: BoundedLru;
  readonly #metrics = new CacheMetrics();
  readonly #singleFlights = new Map<string, Promise<CacheJson | null>>();
  readonly #now: () => number;
  readonly #random: () => number;
  #destroyed = false;
  readonly authoritativeSource: CriticalProjectionSource | undefined;

  constructor(options: ScopedCacheOptions = {}) {
    this.#backend = options.backend ?? new MemoryCacheBackend({ now: options.now });
    this.#secret = encryptionKey(options.encryptionKey);
    this.#authorize = options.authorize ?? ((descriptor) => (
      descriptor.scope === "PUBLIC" || descriptor.scope === "SHARED"
    ));
    this.#protectedPublicationGuard = options.protectedPublicationGuard;
    this.#requireProtectedPublicationGuard = options.requireProtectedPublicationGuard === true;
    if (this.#requireProtectedPublicationGuard && !this.#protectedPublicationGuard) {
      throw new Error("CACHE_PROTECTED_PUBLICATION_GUARD_REQUIRED");
    }
    const lruEntries = options.processLruEntries ?? 64;
    if (!Number.isSafeInteger(lruEntries) || lruEntries < 0 || lruEntries > 10_000) {
      throw new Error("CACHE_LRU_LIMIT_INVALID");
    }
    this.#lru = new BoundedLru(lruEntries, this.#metrics);
    this.authoritativeSource = options.authoritativeSource;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  #descriptor(key: TypedCacheKey): CacheKeyDescriptor {
    if (this.#destroyed) throw new Error("CACHE_DESTROYED");
    return inspectCacheKey(key);
  }

  #sameFenceScope(left: CacheKeyDescriptor, right: CacheKeyDescriptor): boolean {
    return left.scope === right.scope
      && left.identityId === right.identityId
      && left.entityId === right.entityId;
  }

  #trackFenceDescendant<Result>(
    lease: ProtectedFenceLease,
    publish: () => Promise<Result>,
  ): Promise<Result> {
    let operation: Promise<Result>;
    try {
      operation = Promise.resolve(publish());
    } catch (error) {
      operation = Promise.reject(error);
    }
    lease.pending.add(operation);
    void operation.then(
      () => { lease.pending.delete(operation); },
      (error: unknown) => {
        lease.failures.push(error);
        lease.pending.delete(operation);
      },
    );
    return operation;
  }

  async #drainFenceDescendants(lease: ProtectedFenceLease): Promise<void> {
    // Descendants can start additional cache operations while settling. Keep
    // taking bounded snapshots until no registered operation remains.
    while (lease.pending.size > 0) {
      await Promise.allSettled([...lease.pending]);
    }
    if (lease.failures.length > 0) throw lease.failures[0];
  }

  #guardContext(): CacheProtectedGuardContext | undefined {
    const lease = this.#fenceContext.getStore();
    return lease?.nonce === this.#fenceNonce && lease.active ? lease.context : undefined;
  }

  #authorized(descriptor: CacheKeyDescriptor): boolean | Promise<boolean> {
    return this.#authorize(descriptor, this.#guardContext());
  }

  async #guardPublication<Result>(
    descriptor: CacheKeyDescriptor,
    publish: () => Promise<Result>,
    operation: "READ" | "WRITE" | "INVALIDATE" = "WRITE",
  ): Promise<Result> {
    const inherited = this.#fenceContext.getStore();
    if (!protectedDescriptor(descriptor)) {
      return publish();
    }
    if (inherited?.nonce === this.#fenceNonce) {
      if (!inherited.active) {
        throw new Error("CACHE_PROTECTED_FENCE_EXPIRED");
      }
      return this.#trackFenceDescendant(inherited, async () => {
        if (!this.#sameFenceScope(inherited.descriptor, descriptor)) {
          throw new Error("CACHE_PROTECTED_FENCE_SCOPE_MISMATCH");
        }
        return publish();
      });
    }
    const guard = this.#protectedPublicationGuard;
    if (!guard) {
      if (this.#requireProtectedPublicationGuard) {
        throw new Error("CACHE_PROTECTED_PUBLICATION_GUARD_REQUIRED");
      }
      return publish();
    }
    return guard(descriptor, async (context) => {
      const lease: ProtectedFenceLease = {
        nonce: this.#fenceNonce,
        descriptor,
        context: Object.freeze({ ...context }),
        pending: new Set(),
        failures: [],
        active: true,
      };
      try {
        let result: Result | undefined;
        let callbackFailed = false;
        let callbackFailure: unknown;
        try {
          result = await this.#fenceContext.run(lease, publish);
        } catch (error) {
          callbackFailed = true;
          callbackFailure = error;
        }
        let descendantFailed = false;
        let descendantFailure: unknown;
        try {
          await this.#drainFenceDescendants(lease);
        } catch (error) {
          descendantFailed = true;
          descendantFailure = error;
        }
        if (callbackFailed) throw callbackFailure;
        if (descendantFailed) throw descendantFailure;
        return result as Result;
      } finally {
        lease.active = false;
      }
    }, operation);
  }

  async withPublicationGuard<Result>(
    key: TypedCacheKey,
    publish: (context: CacheProtectedGuardContext) => Promise<Result>,
    operation: "READ" | "WRITE" | "INVALIDATE" = "WRITE",
  ): Promise<Result> {
    const descriptor = this.#descriptor(key);
    return this.#guardPublication(descriptor, async () => {
      if (!await this.#authorized(descriptor)) throw new Error("CACHE_NOT_AUTHORIZED");
      return publish(this.#guardContext() ?? Object.freeze({}));
    }, operation);
  }

  #ttlMilliseconds(options: CacheSetOptions, descriptor: CacheKeyDescriptor): number {
    if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
      throw new Error("CACHE_TTL_INVALID");
    }
    const protectedValue = protectedDescriptor(descriptor);
    if (protectedValue && !options.encrypted) throw new Error("CACHE_PROTECTED_ENCRYPTION_REQUIRED");
    if (protectedValue && options.ttlSeconds > MAX_PROTECTED_TTL_SECONDS) {
      throw new Error("CACHE_PROTECTED_TTL_INVALID");
    }
    if (options.negative && options.ttlSeconds > MAX_NEGATIVE_TTL_SECONDS) {
      throw new Error("CACHE_NEGATIVE_TTL_INVALID");
    }
    const jitter = 0.9 + Math.min(1, Math.max(0, this.#random())) * 0.2;
    return Math.max(1, Math.floor(options.ttlSeconds * 1_000 * jitter));
  }

  #eligibleForLru(descriptor: CacheKeyDescriptor, options: CacheSetOptions): boolean {
    return PROCESS_LRU_NAMESPACES.has(descriptor.namespace)
      || (descriptor.namespace === "context" && options.alreadyAuthorized === true);
  }

  async #lookup<Value extends CacheJson>(
    key: CacheVersionKey,
    descriptor: CacheKeyDescriptor,
  ): Promise<CacheLookup<Value>> {
    const started = this.#now();
    const local = this.#lru.get(key, this.#now());
    if (local) {
      this.#metrics.hits += 1;
      this.#metrics.namespace(descriptor.namespace, "HIT");
      this.#metrics.observe(this.#metrics.cacheReadLatencyMs, this.#now() - started);
      return local.negative
        ? { status: "NEGATIVE", value: null }
        : { status: "HIT", value: local.value as Value };
    }
    const serialized = await this.#backend.read(key);
    if (serialized === null) {
      this.#metrics.misses += 1;
      this.#metrics.namespace(descriptor.namespace, "MISS");
      this.#metrics.observe(this.#metrics.cacheReadLatencyMs, this.#now() - started);
      return { status: "MISS", value: null };
    }
    let decoded: { readonly value: CacheJson | null; readonly negative: boolean };
    try {
      decoded = decodeEnvelope(key, parseEnvelope(serialized), this.#secret);
    } catch (error) {
      await this.#backend.delete(key);
      this.#metrics.staleVersionRejections += 1;
      throw error;
    }
    this.#metrics.hits += 1;
    this.#metrics.namespace(descriptor.namespace, "HIT");
    this.#metrics.observe(this.#metrics.cacheReadLatencyMs, this.#now() - started);
    return decoded.negative
      ? { status: "NEGATIVE", value: null }
      : { status: "HIT", value: decoded.value as Value };
  }

  async set<Value extends CacheJson>(
    key: CacheVersionKey,
    value: Value | null,
    options: CacheSetOptions,
  ): Promise<void> {
    if (!isCacheVersionKey(key)) throw new Error("CACHE_VERSION_KEY_REQUIRED");
    const descriptor = this.#descriptor(key);
    await this.#guardPublication(
      descriptor,
      async () => {
        if (!await this.#authorized(descriptor)) throw new Error("CACHE_NOT_AUTHORIZED");
        await this.#setAuthorized(key, value, options, descriptor);
      },
    );
  }

  async #setAuthorized<Value extends CacheJson>(
    key: CacheVersionKey,
    value: Value | null,
    options: CacheSetOptions,
    descriptor: CacheKeyDescriptor,
  ): Promise<void> {
    const protectedValue = protectedDescriptor(descriptor);
    if (containsRawTranscript(value)) {
      throw new Error("CACHE_RAW_PRIVATE_TRANSCRIPT_PROHIBITED");
    }
    if (protectedValue && value !== null && !validProtectedProjection(value)) {
      throw new Error("CACHE_PROTECTED_PROJECTION_INVALID");
    }
    if (protectedValue && value !== null) {
      const projection = value as ProtectedProjectionDto;
      if (projection.accountId !== descriptor.identityId
          || projection.sourceHighWater !== descriptor.sourceHighWater) {
        throw new Error("CACHE_PROTECTED_SCOPE_MISMATCH");
      }
    }
    const canonicalValue = canonical(value);
    const maxBytes = protectedValue ? MAX_PROTECTED_CACHE_BYTES : MAX_CACHE_BYTES;
    if (Buffer.byteLength(canonicalValue, "utf8") > maxBytes) {
      throw new Error("CACHE_VALUE_TOO_LARGE");
    }
    const storedValue = normalizedJson(value);
    const negative = options.negative === true;
    if (negative && value !== null) throw new Error("CACHE_NEGATIVE_VALUE_INVALID");
    const ttlMilliseconds = this.#ttlMilliseconds({ ...options, negative }, descriptor);
    const expiresAt = this.#now() + ttlMilliseconds;
    const envelope: CacheEnvelope = protectedValue
      ? encryptEnvelope(key, storedValue, negative, this.#secret)
      : Object.freeze({
          format: "gustavo-cache-envelope-v1",
          protected: false,
          negative,
          contentDigest: contentDigest(storedValue),
          value: storedValue,
        });
    const serialized = JSON.stringify(envelope);
    let status: "STORED" | "EXISTS";
    try {
      status = await this.#backend.putImmutable(key, serialized, expiresAt);
    } catch (error) {
      this.#metrics.backendFailures += 1;
      throw error;
    }
    if (status === "EXISTS") {
      const existingSerialized = await this.#backend.read(key);
      if (existingSerialized === null) {
        // The prior value expired between the atomic check and validation.
        return this.#setAuthorized(key, value, options, descriptor);
      }
      let existing: CacheEnvelope;
      let existingValue: CacheJson | null;
      try {
        existing = parseEnvelope(existingSerialized);
        existingValue = decodeEnvelope(key, existing, this.#secret).value;
      } catch (error) {
        await this.#backend.delete(key);
        throw error;
      }
      if (
        existing.contentDigest !== envelope.contentDigest
        || existing.negative !== negative
        || canonical(existingValue) !== canonical(storedValue)
      ) {
        throw new Error("CACHE_IMMUTABLE_VERSION_CONFLICT");
      }
      await this.#backend.extendExpiry(key, expiresAt);
    }
    if (this.#eligibleForLru(descriptor, options)) {
      this.#lru.set(key, Object.freeze({ value: storedValue, negative, expiresAt }));
    }
  }

  async get<Value extends CacheJson>(key: CacheVersionKey): Promise<Value | null> {
    if (!isCacheVersionKey(key)) throw new Error("CACHE_VERSION_KEY_REQUIRED");
    const descriptor = this.#descriptor(key);
    try {
      return await this.#guardPublication(descriptor, async () => {
        if (!await this.#authorized(descriptor)) return null;
        const lookup = await this.#lookup<Value>(key, descriptor);
        if (!await this.#authorized(descriptor)) return null;
        return normalizedJson(lookup.value) as Value | null;
      }, "READ");
    } catch (error) {
      this.#metrics.backendFailures += 1;
      if (error instanceof Error && error.message === "CACHE_DESTROYED") throw error;
      return null;
    }
  }

  async readThrough<Value extends CacheJson>(
    key: CacheVersionKey,
    options: CacheReadThroughOptions<Value>,
  ): Promise<Value | null> {
    if (!Number.isSafeInteger(options.maxRows) || options.maxRows < 1 || options.maxRows > 10_000) {
      throw new Error("CACHE_FALLBACK_BOUND_INVALID");
    }
    if (!isCacheVersionKey(key)) throw new Error("CACHE_VERSION_KEY_REQUIRED");
    const descriptor = this.#descriptor(key);
    return this.#guardPublication(descriptor, async () => {
      if (!await this.#authorized(descriptor)) throw new Error("CACHE_NOT_AUTHORIZED");
      let value = await this.#readThroughAuthorized(key, options, descriptor);
      if (!await this.#authorized(descriptor)) {
        value = null;
        throw new Error("CACHE_NOT_AUTHORIZED");
      }
      return normalizedJson(value) as Value | null;
    }, "READ");
  }

  async #readThroughAuthorized<Value extends CacheJson>(
    key: CacheVersionKey,
    options: CacheReadThroughOptions<Value>,
    descriptor: CacheKeyDescriptor,
  ): Promise<Value | null> {

    if (!options.decisionCritical) {
      try {
        const existing = await this.#lookup<Value>(key, descriptor);
        if (existing.status !== "MISS") return existing.value;
      } catch {
        this.#metrics.backendFailures += 1;
      }
    }

    const active = this.#singleFlights.get(key);
    if (active) {
      this.#metrics.singleFlightContention += 1;
      return await active as Value | null;
    }

    const operation = (async (): Promise<Value | null> => {
      const loadAuthority = async (): Promise<Value | null> => {
        const started = this.#now();
        const fallback = await options.load();
        this.#metrics.fallbacks += 1;
        this.#metrics.observeFallback(this.#now() - started);
        if (!Number.isSafeInteger(fallback.rowsRead) || fallback.rowsRead < 0) {
          throw new Error("CACHE_FALLBACK_ROWS_INVALID");
        }
        if (fallback.rowsRead > options.maxRows) throw new Error("CACHE_FALLBACK_BOUND_EXCEEDED");
        return fallback.value;
      };
      if (options.decisionCritical) return loadAuthority();
      const owner = randomUUID();
      const leaseKey = `${VALKEY_PREFIX}lease:${createHash("sha256").update(key).digest("hex")}`;
      let leaseAcquired = false;
      let backendAvailable = true;
      try {
        leaseAcquired = await this.#backend.acquireLease(leaseKey, owner, this.#now() + 5_000);
      } catch {
        backendAvailable = false;
        this.#metrics.backendFailures += 1;
      }
      try {
        if (!leaseAcquired && backendAvailable) {
          this.#metrics.singleFlightContention += 1;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            let winner: CacheLookup<Value> = { status: "MISS", value: null };
            try {
              winner = await this.#lookup<Value>(key, descriptor);
            } catch {
              backendAvailable = false;
              this.#metrics.backendFailures += 1;
              break;
            }
            if (winner.status !== "MISS") return winner.value;
            try {
              leaseAcquired = await this.#backend.acquireLease(
                leaseKey,
                owner,
                this.#now() + 5_000,
              );
            } catch {
              backendAvailable = false;
              this.#metrics.backendFailures += 1;
              break;
            }
            if (leaseAcquired) break;
          }
          if (!leaseAcquired && backendAvailable) throw new Error("CACHE_SINGLE_FLIGHT_TIMEOUT");
        }
        let fallbackValue = await loadAuthority();
        if (backendAvailable) {
          try {
            if (fallbackValue === null) {
            const negativeTtlSeconds = options.negativeTtlSeconds ?? 5;
            await this.set(key, null, {
              ...options,
              ttlSeconds: negativeTtlSeconds,
              negative: true,
            });
            } else {
              await this.set(key, fallbackValue, options);
            }
          } catch (error) {
            if (error instanceof Error && [
              "CACHE_NOT_AUTHORIZED", "CACHE_PRIVACY_BARRIER",
              "CACHE_PRIVACY_SCOPE_INVALID", "CACHE_DESTROYED",
            ].includes(error.message)) {
              fallbackValue = null;
              throw error;
            }
            this.#metrics.backendFailures += 1;
          }
        }
        return fallbackValue;
      } finally {
        if (leaseAcquired) {
          try {
            await this.#backend.releaseLease(leaseKey, owner);
          } catch {
            this.#metrics.backendFailures += 1;
          }
        }
      }
    })();
    this.#singleFlights.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#singleFlights.get(key) === operation) this.#singleFlights.delete(key);
    }
  }

  async publish<Value extends CacheJson>(input: CachePublishInput<Value>): Promise<"STORED" | "STALE_IGNORED"> {
    const started = this.#now();
    if (!isCachePointerKey(input.pointerKey) || !isCacheVersionKey(input.versionKey)) {
      throw new Error("CACHE_PUBLISH_KEY_INVALID");
    }
    const pointerDescriptor = this.#descriptor(input.pointerKey);
    const versionDescriptor = this.#descriptor(input.versionKey);
    if (!samePointerScope(pointerDescriptor, versionDescriptor)) {
      throw new Error("CACHE_POINTER_SCOPE_MISMATCH");
    }
    return this.#guardPublication(pointerDescriptor, async () => {
      if (!await this.#authorized(pointerDescriptor) || !await this.#authorized(versionDescriptor)) {
        this.#metrics.authorizationFilteredMisses += 1;
        throw new Error("CACHE_NOT_AUTHORIZED");
      }
      return this.#publishAuthorized(input, versionDescriptor, started);
    });
  }

  async #publishAuthorized<Value extends CacheJson>(
    input: CachePublishInput<Value>,
    versionDescriptor: CacheKeyDescriptor,
    started: number,
  ): Promise<"STORED" | "STALE_IGNORED"> {
    ordinalValue(input.versionOrdinal);
    await this.set(input.versionKey, input.value, input.options);
    const expiresAt = this.#now() + this.#ttlMilliseconds(input.options, versionDescriptor);
    const pointer: PointerEnvelope = Object.freeze({
      format: "gustavo-cache-pointer-v1",
      target: input.versionKey,
      ordinal: input.versionOrdinal,
      signature: pointerSignature(
        input.pointerKey,
        input.versionKey,
        input.versionOrdinal,
        this.#secret,
      ),
    });
    let status: "STORED" | "STALE_IGNORED";
    try {
      status = await this.#backend.putPointerIfNewer(
        input.pointerKey,
        JSON.stringify(pointer),
        input.versionOrdinal,
        expiresAt,
      );
    } catch (error) {
      this.#metrics.backendFailures += 1;
      throw error;
    }
    if (status === "STALE_IGNORED") this.#metrics.staleVersionRejections += 1;
    else {
      this.#metrics.prewarms += 1;
      if (input.sourceOccurredAt !== undefined) {
        const occurredAt = Date.parse(input.sourceOccurredAt);
        if (Number.isFinite(occurredAt)) {
          this.#metrics.observe(this.#metrics.freshnessLagMs, Math.max(0, this.#now() - occurredAt));
        }
      }
    }
    this.#metrics.observe(this.#metrics.prewarmLatencyMs, this.#now() - started);
    return status;
  }

  async getCurrent<Value extends CacheJson>(pointerKey: CachePointerKey): Promise<Value | null> {
    if (!isCachePointerKey(pointerKey)) throw new Error("CACHE_POINTER_KEY_REQUIRED");
    const pointerDescriptor = this.#descriptor(pointerKey);
    try {
      return await this.#guardPublication(pointerDescriptor, async () => {
        if (!await this.#authorized(pointerDescriptor)) return null;
        const value = await this.#getCurrentAuthorized<Value>(pointerKey, pointerDescriptor);
        if (!await this.#authorized(pointerDescriptor)) return null;
        return normalizedJson(value) as Value | null;
      }, "READ");
    } catch (error) {
      if (error instanceof Error && error.message === "CACHE_DESTROYED") throw error;
      if (error instanceof Error && [
        "CACHE_PRIVACY_BARRIER", "CACHE_PRIVACY_SCOPE_INVALID", "CACHE_NOT_AUTHORIZED",
      ].includes(error.message)) return null;
      throw error;
    }
  }

  async #getCurrentAuthorized<Value extends CacheJson>(
    pointerKey: CachePointerKey,
    pointerDescriptor: CacheKeyDescriptor,
  ): Promise<Value | null> {
    let serialized: string | null;
    try {
      serialized = await this.#backend.read(pointerKey);
    } catch {
      this.#metrics.backendFailures += 1;
      return null;
    }
    if (serialized === null) {
      this.#metrics.misses += 1;
      this.#metrics.namespace(pointerDescriptor.namespace, "MISS");
      return null;
    }
    let pointer: PointerEnvelope;
    try {
      pointer = parsePointer(serialized);
      verifyPointerSignature(pointerKey, pointer, this.#secret);
    } catch (error) {
      await this.#backend.delete(pointerKey);
      this.#metrics.staleVersionRejections += 1;
      throw error;
    }
    const targetDescriptor = inspectCacheKey(pointer.target);
    if (!samePointerScope(pointerDescriptor, targetDescriptor)) {
      await this.#backend.delete(pointerKey);
      this.#metrics.staleVersionRejections += 1;
      throw new Error("CACHE_POINTER_SCOPE_MISMATCH");
    }
    // The pointer contains no protected value. Re-authorize the immutable
    // target before its envelope is read or decrypted so live source-specific
    // policy changes can deny a stale pointer safely.
    if (!await this.#authorized(targetDescriptor)) return null;
    const lookup = await this.#lookup<Value>(pointer.target, targetDescriptor);
    if (lookup.status === "MISS") {
      await this.#backend.delete(pointerKey);
      this.#metrics.staleVersionRejections += 1;
    }
    if (!await this.#authorized(targetDescriptor)) return null;
    return lookup.value;
  }

  async invalidate(
    pointerKey: CachePointerKey,
    input: { readonly throughOrdinal: string },
  ): Promise<"INVALIDATED" | "STALE_IGNORED" | "MISSING"> {
    const started = this.#now();
    if (!isCachePointerKey(pointerKey)) throw new Error("CACHE_POINTER_KEY_REQUIRED");
    const descriptor = this.#descriptor(pointerKey);
    return this.#guardPublication(descriptor, async () => {
      if (!await this.#authorized(descriptor)) throw new Error("CACHE_NOT_AUTHORIZED");
      try {
        const result = await this.#backend.deletePointerThrough(pointerKey, input.throughOrdinal);
        if (result === "INVALIDATED") this.#metrics.invalidations += 1;
        if (result === "STALE_IGNORED") this.#metrics.staleVersionRejections += 1;
        this.#metrics.observe(this.#metrics.invalidationLatencyMs, this.#now() - started);
        return result;
      } catch (error) {
        this.#metrics.invalidationFailures += 1;
        this.#metrics.backendFailures += 1;
        throw error;
      }
    }, "INVALIDATE");
  }

  async flushAll(): Promise<void> {
    await this.#backend.flushAll();
    this.#lru.clear();
  }

  async purgeConversationLocal(input: {
    readonly accountId: string;
    readonly nodeBrainId: string;
    readonly conversationId: string;
  }): Promise<void> {
    if (!EVENT_ID_PATTERN.test(input.accountId)
        || !EVENT_ID_PATTERN.test(input.nodeBrainId)
        || !EVENT_ID_PATTERN.test(input.conversationId)) {
      throw new Error("CACHE_PURGE_SCOPE_INVALID");
    }
    const matches = (key: string): boolean => {
      try {
        const descriptor = inspectCacheKey(key as TypedCacheKey);
        return descriptor.scope === "PRIVATE_ACCOUNT"
          && descriptor.identityId === input.accountId
          && descriptor.entityId === input.conversationId;
      } catch {
        return false;
      }
    };
    // The DB conversation fence drains reads that began before forgetting and
    // prevents later reads from registering. Never await arbitrary application
    // loaders while forget holds that fence; only detach a matching stale slot.
    for (const [key] of this.#singleFlights.entries()) {
      if (matches(key)) this.#singleFlights.delete(key);
    }
    this.#lru.deleteMatching(matches);
  }

  async purgeConversation(input: {
    readonly accountId: string;
    readonly nodeBrainId: string;
    readonly conversationId: string;
  }): Promise<void> {
    await this.purgeConversationLocal(input);
    await this.#backend.deleteMatching({
      accountId: input.accountId,
      conversationId: input.conversationId,
      maximumKeys: 10_000,
    });
  }

  destroy(): void {
    this.#destroyed = true;
    this.#secret.fill(0);
    this.#lru.clear();
    this.#singleFlights.clear();
  }

  localSize(): number {
    return this.#lru.size;
  }

  metrics(): CacheMetricSnapshot {
    return this.#metrics.snapshot();
  }

  recordPrewarmFailure() {
    this.#metrics.prewarmFailures += 1;
  }

  recordInvalidationFailure() {
    this.#metrics.invalidationFailures += 1;
  }

  recordRebuild(durationMs: number) {
    this.#metrics.rebuilds += 1;
    this.#metrics.observe(this.#metrics.rebuildLatencyMs, durationMs);
  }
}

export function scopedCache(options: ScopedCacheOptions = {}): ScopedCache {
  return new ScopedCache(options);
}

export type CacheProjectionPublisher = Pick<
  ScopedCache,
  "publish" | "invalidate" | "withPublicationGuard" | "metrics"
    | "recordPrewarmFailure" | "recordRebuild"
> & { readonly authoritativeSource?: CriticalProjectionSource };

export function cacheProjectionPublisher(cache: ScopedCache): CacheProjectionPublisher {
  return Object.freeze({
    publish: cache.publish.bind(cache),
    invalidate: cache.invalidate.bind(cache),
    withPublicationGuard: cache.withPublicationGuard.bind(cache),
    metrics: cache.metrics.bind(cache),
    recordPrewarmFailure: cache.recordPrewarmFailure.bind(cache),
    recordRebuild: cache.recordRebuild.bind(cache),
    ...(cache.authoritativeSource === undefined
      ? {} : { authoritativeSource: cache.authoritativeSource }),
  });
}

export type CacheProjectionReader = Pick<
  ScopedCache,
  "get" | "getCurrent" | "readThrough" | "metrics"
> & { dispose(): void };

export function cacheProjectionReader(
  cache: ScopedCache,
  onDispose: () => void = () => undefined,
): CacheProjectionReader {
  let disposed = false;
  return Object.freeze({
    get: cache.get.bind(cache),
    getCurrent: cache.getCurrent.bind(cache),
    readThrough: cache.readThrough.bind(cache),
    metrics: cache.metrics.bind(cache),
    dispose() {
      if (disposed) return;
      disposed = true;
      cache.destroy();
      onDispose();
    },
  });
}

export interface CriticalProjectionRecord {
  readonly id: string;
  readonly key: CacheVersionKeyInput;
  readonly versionOrdinal: string;
  readonly value: {
    readonly kind: string;
    readonly sourceEventIds: readonly string[];
    readonly [key: string]: CacheJson;
  };
  readonly sourceRowCount: number;
  readonly contentHash: string;
}

export const CACHE_REQUIRED_CATEGORIES = Object.freeze([
  "MAIN_STATE",
  "BROADCASTS",
  "NODE_DOSSIERS",
  "NODE_HANDOFFS",
  "CHALLENGE",
] as const);

export type CacheProjectionCategory = typeof CACHE_REQUIRED_CATEGORIES[number];

export interface CriticalProjectionCategoryManifest {
  readonly category: CacheProjectionCategory;
  /** Canonical numeric cursor: the greatest declared record high-water. */
  readonly sourceHighWater: string;
  readonly recordCount: number;
  readonly manifestHash: string;
  /** Complete ordered per-record/entity high-water authority. */
  readonly highWaterCount: number;
  readonly highWaterHash: string;
}

export interface CriticalProjectionManifest {
  readonly checkpoint: string;
  readonly sourceHighWater: string;
  readonly recordCount: number;
  readonly manifestHash: string;
  readonly categories: readonly CriticalProjectionCategoryManifest[];
}

export interface CriticalProjectionPage {
  readonly records: readonly CriticalProjectionRecord[];
  readonly nextCursor: string | null;
}

export interface CriticalProjectionSource {
  readonly name: "POSTGRES";
  readManifest(checkpoint: string): Promise<CriticalProjectionManifest>;
  readPage(input: {
    readonly checkpoint: string;
    readonly afterId: string | null;
    readonly limit: number;
  }): Promise<CriticalProjectionPage>;
}

function projectionRecordManifest(record: CriticalProjectionRecord): readonly CacheJson[] {
  return Object.freeze([
    record.id,
    record.key.namespace,
    record.key.scope,
    record.key.entityId,
    record.key.identityId ?? record.key.entityId,
    record.key.topologyVersion ?? "single-main-node-v1",
    record.key.sourceHighWater,
    String(record.key.stateVersion),
    record.key.policyVersion,
    record.key.schemaVersion,
    record.versionOrdinal,
    record.sourceRowCount,
    record.contentHash,
  ]);
}

export function projectionManifestHash(records: readonly CriticalProjectionRecord[]): string {
  const sorted = [...records].sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(canonical(sorted.map(projectionRecordManifest))).digest("hex");
}

export function projectionCategory(record: CriticalProjectionRecord): CacheProjectionCategory {
  if (record.key.namespace === "main-state") return "MAIN_STATE";
  if (record.key.namespace === "broadcast") return "BROADCASTS";
  if (record.key.namespace === "node-dossier") return "NODE_DOSSIERS";
  if (record.key.namespace === "handoff") return "NODE_HANDOFFS";
  if (record.key.namespace === "challenge-snapshot") return "CHALLENGE";
  throw new Error("CACHE_PROJECTION_CATEGORY_INVALID");
}

const PROJECTION_HIGH_WATER_PATTERN = /^e(0|[1-9][0-9]*)$/u;

function projectionHighWaterOrdinal(value: string): bigint {
  if (!PROJECTION_HIGH_WATER_PATTERN.test(value)) {
    throw new Error("CACHE_PROJECTION_HIGH_WATER_INVALID");
  }
  return BigInt(value.slice(1));
}

function projectionHighWaterCursor(records: readonly CriticalProjectionRecord[]): string {
  let cursor = 0n;
  for (const item of records) {
    const ordinal = projectionHighWaterOrdinal(item.key.sourceHighWater);
    if (ordinal > cursor) cursor = ordinal;
  }
  return `e${cursor}`;
}

function projectionHighWaterHash(records: readonly CriticalProjectionRecord[]): string {
  const authority = records.map((item) => Object.freeze([
    item.key.identityId ?? item.key.entityId,
    item.key.entityId,
    item.id,
    item.key.sourceHighWater,
    String(item.key.stateVersion),
    item.versionOrdinal,
  ] as const)).sort((left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      const compared = left[index]!.localeCompare(right[index]!);
      if (compared !== 0) return compared;
    }
    return 0;
  });
  return createHash("sha256").update(canonical(authority)).digest("hex");
}

export function projectionCategoryManifests(
  records: readonly CriticalProjectionRecord[],
): readonly CriticalProjectionCategoryManifest[] {
  return CACHE_REQUIRED_CATEGORIES.map((category) => {
    const categoryRecords = records.filter((record) => projectionCategory(record) === category);
    return Object.freeze({
      category,
      sourceHighWater: projectionHighWaterCursor(categoryRecords),
      recordCount: categoryRecords.length,
      manifestHash: projectionManifestHash(categoryRecords),
      highWaterCount: categoryRecords.length,
      highWaterHash: projectionHighWaterHash(categoryRecords),
    });
  });
}

export interface RebuildCriticalProjectionsInput {
  readonly cache: CacheProjectionPublisher;
  readonly source: "POSTGRES" | CriticalProjectionSource;
  readonly checkpoint: string;
}

export interface RebuildCriticalProjectionsResult {
  readonly source: "POSTGRES";
  readonly checkpoint: string;
  readonly mainState: "rebuilt";
  readonly challenge: "rebuilt";
  readonly handoffs: "rebuilt";
}

function rebuildSource(input: RebuildCriticalProjectionsInput): CriticalProjectionSource {
  if (input.source !== "POSTGRES") {
    if (!input.source || input.source.name !== "POSTGRES") {
      throw new Error("CACHE_REBUILD_SOURCE_INVALID");
    }
    return input.source;
  }
  if (!input.cache.authoritativeSource) throw new Error("CACHE_AUTHORITATIVE_SOURCE_REQUIRED");
  return input.cache.authoritativeSource;
}

export async function rebuildCriticalProjections(
  input: RebuildCriticalProjectionsInput,
): Promise<RebuildCriticalProjectionsResult> {
  const started = Date.now();
  if (!REBUILD_ID_PATTERN.test(input.checkpoint)) {
    throw new Error("CACHE_REBUILD_CHECKPOINT_INVALID");
  }
  const source = rebuildSource(input);
  const manifest = await source.readManifest(input.checkpoint);
  if (
    manifest.checkpoint !== input.checkpoint
    || typeof manifest.sourceHighWater !== "string"
    || !PROJECTION_HIGH_WATER_PATTERN.test(manifest.sourceHighWater)
    || !Number.isSafeInteger(manifest.recordCount)
    || manifest.recordCount < 0
    || manifest.recordCount > MAX_REBUILD_RECORDS
    || !/^[a-f0-9]{64}$/u.test(manifest.manifestHash)
    || !Array.isArray(manifest.categories)
    || manifest.categories.length !== CACHE_REQUIRED_CATEGORIES.length
  ) {
    throw new Error("CACHE_REBUILD_MANIFEST_INVALID");
  }
  const categories = new Map<CacheProjectionCategory, CriticalProjectionCategoryManifest>();
  for (const category of manifest.categories) {
    if (!CACHE_REQUIRED_CATEGORIES.includes(category.category)
        || categories.has(category.category)
        || !PROJECTION_HIGH_WATER_PATTERN.test(category.sourceHighWater)
        || !Number.isSafeInteger(category.recordCount)
        || category.recordCount < 0
        || category.recordCount > MAX_REBUILD_RECORDS
        || !/^[a-f0-9]{64}$/u.test(category.manifestHash)
        || !Number.isSafeInteger(category.highWaterCount)
        || category.highWaterCount !== category.recordCount
        || !/^[a-f0-9]{64}$/u.test(category.highWaterHash)) {
      throw new Error("CACHE_REBUILD_CATEGORY_MANIFEST_INVALID");
    }
    categories.set(category.category, category);
  }
  if (CACHE_REQUIRED_CATEGORIES.some((category) => !categories.has(category))) {
    throw new Error("CACHE_REBUILD_CATEGORY_MISSING");
  }
  if ([...categories.values()].reduce((total, category) => total + category.recordCount, 0)
      !== manifest.recordCount) {
    throw new Error("CACHE_REBUILD_MANIFEST_INVALID");
  }

  const records: CriticalProjectionRecord[] = [];
  const seen = new Set<string>();
  let afterId: string | null = null;
  while (records.length < manifest.recordCount) {
    const page = await source.readPage({
      checkpoint: input.checkpoint,
      afterId,
      limit: REBUILD_PAGE_SIZE,
    });
    if (!Array.isArray(page.records) || page.records.length === 0
        || page.records.length > REBUILD_PAGE_SIZE) {
      throw new Error("CACHE_REBUILD_PAGE_INVALID");
    }
    for (const item of page.records) {
      if (
        typeof item.id !== "string"
        || !REBUILD_ID_PATTERN.test(item.id)
        || seen.has(item.id)
        || (afterId !== null && item.id <= afterId)
        || !CRITICAL_NAMESPACES.has(item.key.namespace)
        || !Number.isSafeInteger(item.sourceRowCount)
        || item.sourceRowCount < 0
        || item.sourceRowCount > MAX_PROJECTION_SOURCE_ROWS
        || !PROJECTION_HIGH_WATER_PATTERN.test(item.key.sourceHighWater)
        || item.value === null
        || typeof item.value !== "object"
        || Array.isArray(item.value)
        || item.value.sourceHighWater !== item.key.sourceHighWater
        || contentDigest(item.value) !== item.contentHash
      ) {
        throw new Error("CACHE_REBUILD_RECORD_INVALID");
      }
      ordinalValue(item.versionOrdinal);
      cacheKey(item.key);
      seen.add(item.id);
      records.push(item);
      afterId = item.id;
      if (records.length > manifest.recordCount) throw new Error("CACHE_REBUILD_COUNT_DIVERGED");
    }
    if (records.length < manifest.recordCount) {
      if (page.nextCursor !== afterId) throw new Error("CACHE_REBUILD_CURSOR_INVALID");
    } else if (page.nextCursor !== null) {
      throw new Error("CACHE_REBUILD_CURSOR_INVALID");
    }
  }
  if (records.length !== manifest.recordCount
      || projectionHighWaterCursor(records) !== manifest.sourceHighWater
      || projectionManifestHash(records) !== manifest.manifestHash) {
    throw new Error("CACHE_REBUILD_MANIFEST_DIVERGED");
  }
  for (const category of CACHE_REQUIRED_CATEGORIES) {
    const declared = categories.get(category)!;
    const actual = records.filter((record) => projectionCategory(record) === category);
    const actualManifest = projectionCategoryManifests(actual)
      .find((candidate) => candidate.category === category)!;
    if (actual.length !== declared.recordCount
        || actualManifest.sourceHighWater !== declared.sourceHighWater
        || actualManifest.manifestHash !== declared.manifestHash
        || actualManifest.highWaterCount !== declared.highWaterCount
        || actualManifest.highWaterHash !== declared.highWaterHash) {
      throw new Error("CACHE_REBUILD_CATEGORY_DIVERGED");
    }
  }

  // Publish pointers only after the entire manifest verifies, so a corrupt or
  // partial rebuild can never become the current view.
  for (const item of records) {
    const versionKey = cacheKey(item.key);
    await input.cache.publish({
      pointerKey: cachePointerKey(item.key),
      versionKey,
      versionOrdinal: item.versionOrdinal,
      value: item.value,
      options: {
        ttlSeconds: item.key.namespace === "broadcast" ? 300 : 60,
        encrypted: item.key.scope === "PRIVATE_ACCOUNT" || item.key.scope === "OPERATOR",
      },
    });
  }
  input.cache.recordRebuild(Date.now() - started);
  return Object.freeze({
    source: "POSTGRES",
    checkpoint: input.checkpoint,
    mainState: "rebuilt",
    challenge: "rebuilt",
    handoffs: "rebuilt",
  });
}

/** Startup path: verify and warm only the source's declared current checkpoint. */
export async function prewarmCriticalProjections(input: {
  readonly cache: CacheProjectionPublisher;
  readonly source: CriticalProjectionSource;
  readonly checkpoint: string;
}): Promise<RebuildCriticalProjectionsResult> {
  return rebuildCriticalProjections({ ...input, source: input.source });
}
