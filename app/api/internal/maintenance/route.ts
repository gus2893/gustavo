import { createHash } from "node:crypto";
import { Receiver } from "@upstash/qstash";
import { createClient, type RedisClientType } from "redis";
import {
  createPostgresCacheJobRepository,
  createPostgresProjectionSource,
  synchronizeCanonicalCacheJobs,
} from "../../../../lib/server/cache/postgres";
import { createPostgresCacheAccess } from "../../../../lib/server/cache/runtime";
import {
  ValkeyCacheBackend,
  type ValkeyTransport,
} from "../../../../lib/server/cache/store";
import { getDatabase } from "../../../../lib/server/db/postgres";
import type { EventDatabase } from "../../../../lib/server/events/types";
import { openDueBroadcastCycles } from "../../../../lib/server/main-brain/schedules";
import { processForgetPropagation } from "../../../../lib/server/memory/forget";
import { processNextCacheJob } from "../../../../worker/cache/invalidate";
import { publishNextCommittedEvent } from "../../../../worker/stream/publish-events";

export const MAINTENANCE_PRODUCTION_URL = "https://gustavo.lol/api/internal/maintenance";
export const MAINTENANCE_BODY = '{"operation":"maintenance"}';

const MAINTENANCE_MAX_AGE_SECONDS = 300;
const MAINTENANCE_CLOCK_TOLERANCE_SECONDS = 5;
const MAINTENANCE_SIGNATURE_MAX_LENGTH = 8_192;
const MAINTENANCE_EXECUTION_BUDGET_MS = 50_000;
const MAINTENANCE_STATEMENT_MAX_MS = 5_000;
const MESSAGE_ID_PATTERN = /^[\x21-\x7e]{1,200}$/u;

interface MaintenanceStepResult {
  readonly processed: number;
}

export interface MaintenanceRunResult {
  readonly processed: number;
  readonly deadlineReached: boolean;
  readonly overlap?: true;
}

export interface BoundedMaintenanceOptions {
  readonly deadline: Date;
  readonly now: () => Date;
  readonly verify: () => Promise<void>;
  readonly withLock: (
    work: () => Promise<MaintenanceRunResult>,
  ) => Promise<MaintenanceRunResult | null>;
  readonly cache: () => Promise<MaintenanceStepResult>;
  readonly privacy: () => Promise<MaintenanceStepResult>;
  readonly stream: () => Promise<MaintenanceStepResult>;
  readonly schedules: () => Promise<MaintenanceStepResult>;
  readonly bridgeLeases: () => Promise<MaintenanceStepResult>;
}

function validInstant(value: Date, code: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(code);
  }
  return value;
}

function unauthorized(): Error {
  return new Error("MAINTENANCE_REQUEST_UNAUTHORIZED");
}

function deadlineReachedError(): Error {
  return new Error("MAINTENANCE_DEADLINE_REACHED");
}

function maintenanceSigningKey(value: string): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096) {
    throw unauthorized();
  }
  return value;
}

async function exactMaintenanceBody(
  request: Request,
  signal?: AbortSignal,
): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && declaredLength !== String(Buffer.byteLength(MAINTENANCE_BODY))) {
    await request.body?.cancel().catch(() => undefined);
    throw unauthorized();
  }
  if (!request.body || request.bodyUsed || request.body.locked) throw unauthorized();
  const reader = request.body.getReader();
  const expected = Buffer.from(MAINTENANCE_BODY, "utf8");
  const bytes = new Uint8Array(expected.length);
  let offset = 0;
  let chunkCount = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel().then(() => undefined, () => undefined);
    return cancellation;
  };
  const abort = () => { void cancel(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw deadlineReachedError();
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw deadlineReachedError();
      if (done) break;
      chunkCount += 1;
      if (chunkCount > expected.length || value.byteLength > bytes.length - offset) {
        await cancel();
        throw unauthorized();
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } catch (error) {
    await cancel();
    if (signal?.aborted
        || (error instanceof Error && error.message === "MAINTENANCE_DEADLINE_REACHED")) {
      throw deadlineReachedError();
    }
    throw unauthorized();
  } finally {
    signal?.removeEventListener("abort", abort);
    await cancellation;
    reader.releaseLock();
  }
  if (offset !== expected.length || !bytes.every((byte, index) => byte === expected[index])) {
    throw unauthorized();
  }
  return MAINTENANCE_BODY;
}

function verifiedTokenClaims(signature: string, now: Date): {
  readonly messageId: string;
  readonly publishedAt: Date;
} {
  const segments = signature.split(".");
  if (segments.length !== 3) throw unauthorized();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as unknown;
  } catch {
    throw unauthorized();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw unauthorized();
  const claims = payload as Record<string, unknown>;
  if (!Number.isSafeInteger(claims.iat)
      || (claims.iat as number) <= 0
      || typeof claims.jti !== "string"
      || !MESSAGE_ID_PATTERN.test(claims.jti)) {
    throw unauthorized();
  }
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const issuedAt = claims.iat as number;
  if (issuedAt > nowSeconds + MAINTENANCE_CLOCK_TOLERANCE_SECONDS
      || nowSeconds - issuedAt > MAINTENANCE_MAX_AGE_SECONDS) {
    throw unauthorized();
  }
  return Object.freeze({ messageId: claims.jti, publishedAt: new Date(issuedAt * 1_000) });
}

export async function verifyMaintenanceRequest(
  request: Request,
  options: {
    readonly now: Date;
    readonly currentSigningKey: string;
    readonly nextSigningKey: string;
    readonly signal?: AbortSignal;
  },
): Promise<{
  readonly messageId: string;
  readonly publishedAt: Date;
  readonly bodyDigest: string;
}> {
  const now = validInstant(options.now, "MAINTENANCE_REQUEST_UNAUTHORIZED");
  if (options.signal?.aborted) {
    await request.body?.cancel().catch(() => undefined);
    throw deadlineReachedError();
  }
  if (request.method !== "POST"
      || request.url !== MAINTENANCE_PRODUCTION_URL
      || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
        !== "application/json") {
    await request.body?.cancel().catch(() => undefined);
    throw unauthorized();
  }
  const deliveryId = request.headers.get("upstash-message-id");
  const signature = request.headers.get("upstash-signature");
  if (!deliveryId || !MESSAGE_ID_PATTERN.test(deliveryId)
      || !signature || signature !== signature.trim()
      || signature.length > MAINTENANCE_SIGNATURE_MAX_LENGTH) {
    await request.body?.cancel().catch(() => undefined);
    throw unauthorized();
  }
  const body = await exactMaintenanceBody(request, options.signal);
  if (options.signal?.aborted) throw deadlineReachedError();
  const receiver = new Receiver({
    currentSigningKey: maintenanceSigningKey(options.currentSigningKey),
    nextSigningKey: maintenanceSigningKey(options.nextSigningKey),
    devMode: false,
  });
  try {
    if (!await receiver.verify({
      signature,
      body,
      url: MAINTENANCE_PRODUCTION_URL,
      clockTolerance: MAINTENANCE_CLOCK_TOLERANCE_SECONDS,
      upstashRegion: request.headers.get("upstash-region") ?? undefined,
    })) throw unauthorized();
  } catch {
    if (options.signal?.aborted) throw deadlineReachedError();
    throw unauthorized();
  }
  const claims = verifiedTokenClaims(signature, now);
  return Object.freeze({
    ...claims,
    bodyDigest: createHash("sha256").update(body, "utf8").digest("hex"),
  });
}

export async function withMaintenanceLock<Result>(
  database: EventDatabase,
  work: (transaction: EventDatabase) => Promise<Result>,
): Promise<Result | null> {
  return database.transaction(async (transaction) => {
    const lock = await transaction.one<{ readonly acquired: boolean }>(
      `select pg_try_advisory_xact_lock(
         hashtextextended('gustavo-vercel-maintenance-v1',0)
       ) acquired`,
    );
    if (lock.acquired !== true) return null;
    await transaction.query("set local statement_timeout='8000ms'");
    await transaction.query("set local lock_timeout='2000ms'");
    return work(transaction);
  });
}

interface MonotonicDeadlineState {
  readonly deadlineMonotonicMs: number;
  readonly monotonicNow: () => number;
  lastObservedMs: number;
}

function remainingDatabaseBudget(state: MonotonicDeadlineState): number {
  const observed = state.monotonicNow();
  if (!Number.isFinite(observed) || observed < state.lastObservedMs) {
    throw new Error("MAINTENANCE_TIME_INVALID");
  }
  state.lastObservedMs = observed;
  const remaining = state.deadlineMonotonicMs - observed;
  if (remaining <= 0) throw new Error("MAINTENANCE_DEADLINE_REACHED");
  return remaining;
}

function boundedDatabase(
  database: EventDatabase,
  state: MonotonicDeadlineState,
): EventDatabase {
  const prepareStatement = async () => {
    const remaining = remainingDatabaseBudget(state);
    const timeoutMs = Math.max(
      1, Math.min(MAINTENANCE_STATEMENT_MAX_MS, Math.floor(remaining)),
    );
    await database.query(
      "select set_config('statement_timeout',$1,true)",
      [`${timeoutMs}ms`],
    );
    remainingDatabaseBudget(state);
  };
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row[]> {
      await prepareStatement();
      return database.query<Row>(sql, parameters);
    },
    async one<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row> {
      await prepareStatement();
      return database.one<Row>(sql, parameters);
    },
    transaction<Result>(
      work: (transaction: EventDatabase) => Promise<Result>,
    ): Promise<Result> {
      remainingDatabaseBudget(state);
      return database.transaction(async (transaction) => {
        const result = await work(boundedDatabase(transaction, state));
        remainingDatabaseBudget(state);
        return result;
      });
    },
  };
}

export function deadlineBoundDatabase(
  database: EventDatabase,
  options: {
    readonly deadlineMonotonicMs: number;
    readonly monotonicNow: () => number;
  },
): EventDatabase {
  if (!Number.isFinite(options.deadlineMonotonicMs)
      || typeof options.monotonicNow !== "function") {
    throw new Error("MAINTENANCE_DEADLINE_INVALID");
  }
  return boundedDatabase(database, {
    deadlineMonotonicMs: options.deadlineMonotonicMs,
    monotonicNow: options.monotonicNow,
    lastObservedMs: Number.NEGATIVE_INFINITY,
  });
}

export async function recordMaintenanceDelivery(
  database: EventDatabase,
  delivery: {
    readonly messageId: string;
    readonly bodyDigest: string;
    readonly publishedAt: Date;
  },
): Promise<void> {
  if (!MESSAGE_ID_PATTERN.test(delivery.messageId)
      || !/^[a-f0-9]{64}$/u.test(delivery.bodyDigest)) {
    throw new Error("MAINTENANCE_REQUEST_UNAUTHORIZED");
  }
  const publishedAt = validInstant(delivery.publishedAt, "MAINTENANCE_REQUEST_UNAUTHORIZED");
  const receipt = await database.query(
    `insert into bridge_wake_receipts (message_id,body_digest,published_at)
     values ($1,$2,least($3::timestamptz,statement_timestamp()))
     on conflict (message_id) do nothing returning message_id`,
    [delivery.messageId, delivery.bodyDigest, publishedAt],
  );
  if (receipt.length !== 1) throw new Error("MAINTENANCE_REQUEST_REPLAYED");
  const quota = await database.query(
    `insert into deployment_quota_counters (
       quota_name,bucket_date,used_count,limit_count,updated_at
     ) values (
       'QSTASH_MESSAGES',(clock_timestamp() at time zone 'UTC')::date,
       1,900,clock_timestamp()
     )
     on conflict (quota_name,bucket_date) do update
       set used_count=deployment_quota_counters.used_count+1,
           updated_at=clock_timestamp()
     where deployment_quota_counters.limit_count=900
       and deployment_quota_counters.used_count<900
     returning used_count`,
  );
  if (quota.length !== 1) throw new Error("MAINTENANCE_QSTASH_QUOTA_EXHAUSTED");
}

export async function settleStaleBridgeLeases(
  database: EventDatabase,
  limit: number,
): Promise<MaintenanceStepResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("MAINTENANCE_BATCH_LIMIT_INVALID");
  }
  const settled = await database.query(
    `with stale as (
       select job_id from bridge_model_jobs
        where status='CLAIMED' and attempt_count=3
          and lease_expires_at<=clock_timestamp()
        order by lease_expires_at,created_at,job_id
        for update skip locked limit $1
     )
     update bridge_model_jobs job
        set status='FAILED',lease_owner=null,lease_expires_at=null,
            output_event_id=null,safe_code='ATTEMPT_LIMIT_EXHAUSTED'
       from stale where job.job_id=stale.job_id
     returning job.job_id`,
    [limit],
  );
  return Object.freeze({ processed: settled.length });
}

function processedCount(value: MaintenanceStepResult): number {
  if (!value || !Number.isSafeInteger(value.processed)
      || value.processed < 0 || value.processed > 10_000) {
    throw new Error("MAINTENANCE_STEP_RESULT_INVALID");
  }
  return value.processed;
}

export async function runBoundedMaintenance(
  options: BoundedMaintenanceOptions,
): Promise<MaintenanceRunResult> {
  const startedAt = validInstant(options.now(), "MAINTENANCE_TIME_INVALID");
  const deadline = validInstant(options.deadline, "MAINTENANCE_DEADLINE_INVALID");
  const durationMs = deadline.getTime() - startedAt.getTime();
  if (durationMs <= 0 || durationMs >= 55_000) {
    throw new Error("MAINTENANCE_DEADLINE_INVALID");
  }

  await options.verify();
  const result = await options.withLock(async () => {
    let processed = 0;
    const reachedDeadline = () => validInstant(
      options.now(), "MAINTENANCE_TIME_INVALID",
    ).getTime() >= deadline.getTime();
    if (reachedDeadline()) throw deadlineReachedError();
    const steps = Object.freeze([
      ["cache", options.cache],
      ["privacy", options.privacy],
      ["stream", options.stream],
      ["schedules", options.schedules],
      ["bridgeLeases", options.bridgeLeases],
    ] as const);

    for (const [, step] of steps) {
      processed += processedCount(await step());
      if (reachedDeadline()) throw deadlineReachedError();
    }

    return Object.freeze({ processed, deadlineReached: false });
  });

  if (validInstant(options.now(), "MAINTENANCE_TIME_INVALID").getTime() >= deadline.getTime()) {
    throw deadlineReachedError();
  }

  return result ?? Object.freeze({ processed: 0, deadlineReached: false, overlap: true });
}

export function createMaintenanceHandler(options: {
  readonly now: () => Date;
  readonly run: (request: Request, deadline: Date) => Promise<MaintenanceRunResult>;
  readonly log: (safeCode: "MAINTENANCE_FAILED") => void;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    try {
      const startedAt = validInstant(options.now(), "MAINTENANCE_TIME_INVALID");
      const result = await options.run(
        request, new Date(startedAt.getTime() + MAINTENANCE_EXECUTION_BUDGET_MS),
      );
      if (result.overlap) {
        return Response.json({ code: "MAINTENANCE_OVERLAP" }, { status: 409, headers });
      }
      if (result.processed === 0 && !result.deadlineReached) {
        return new Response(null, { status: 204, headers });
      }
      return Response.json({
        processed: result.processed,
        deadlineReached: result.deadlineReached,
      }, { status: 200, headers });
    } catch (error) {
      if (error instanceof Error && error.message === "MAINTENANCE_REQUEST_UNAUTHORIZED") {
        return Response.json({ code: "MAINTENANCE_UNAUTHORIZED" }, { status: 401, headers });
      }
      if (error instanceof Error && error.message === "MAINTENANCE_REQUEST_REPLAYED") {
        return new Response(null, { status: 204, headers });
      }
      options.log("MAINTENANCE_FAILED");
      return Response.json({ code: "MAINTENANCE_UNAVAILABLE" }, { status: 503, headers });
    }
  };
}

function maintenanceCacheKey(): Buffer {
  const encoded = process.env.GUSTAVO_CACHE_ENCRYPTION_KEY;
  if (!encoded) throw new Error("MAINTENANCE_CACHE_UNAVAILABLE");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    key.fill(0);
    throw new Error("MAINTENANCE_CACHE_UNAVAILABLE");
  }
  return key;
}

function redisTransport(client: RedisClientType): ValkeyTransport {
  return {
    get: (key) => client.get(key),
    set: async (key, value, options) => client.set(key, value, options),
    eval: async (script, options) => client.eval(script, {
      keys: [...options.keys], arguments: [...options.arguments],
    }) as Promise<number | string | null>,
    scan: async (cursor, options) => {
      const result = await client.scan(cursor, options);
      return Object.freeze({ cursor: result.cursor, keys: result.keys });
    },
    del: (keys) => client.del([...keys]),
  };
}

async function runProductionMaintenance(
  request: Request,
  deadline: Date,
): Promise<MaintenanceRunResult> {
  const wallStartedAtMs = Date.now();
  const monotonicStartedAtMs = performance.now();
  const durationMs = deadline.getTime() - wallStartedAtMs;
  if (durationMs <= 0 || durationMs >= 55_000) {
    throw new Error("MAINTENANCE_DEADLINE_REACHED");
  }
  const deadlineMonotonicMs = monotonicStartedAtMs + durationMs;
  const monotonicNow = () => performance.now();
  const maintenanceNow = () => new Date(
    wallStartedAtMs + Math.max(0, monotonicNow() - monotonicStartedAtMs),
  );
  const overallAbort = new AbortController();
  const overallTimer = setTimeout(
    () => overallAbort.abort(new Error("MAINTENANCE_DEADLINE_REACHED")),
    durationMs,
  );
  overallTimer.unref?.();
  let delivery: Awaited<ReturnType<typeof verifyMaintenanceRequest>> | undefined;
  let transaction: EventDatabase | undefined;
  let cacheAccess: ReturnType<typeof createPostgresCacheAccess> | undefined;
  let redis: RedisClientType | undefined;

  const maintenance: BoundedMaintenanceOptions = {
    deadline,
    now: maintenanceNow,
    verify: async () => {
      const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
      const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
      if (!currentSigningKey || !nextSigningKey
          || currentSigningKey.length < 16 || currentSigningKey.length > 4_096
          || nextSigningKey.length < 16 || nextSigningKey.length > 4_096) {
        throw new Error("MAINTENANCE_SIGNING_KEYS_UNAVAILABLE");
      }
      delivery = await verifyMaintenanceRequest(request, {
        now: new Date(), currentSigningKey, nextSigningKey,
        signal: overallAbort.signal,
      });
    },
    withLock: async (work) => {
      const verifiedDelivery = delivery;
      if (!verifiedDelivery) throw unauthorized();
      const bounded = deadlineBoundDatabase(getDatabase({
        transactionBudget: {
          remainingMilliseconds: () => deadlineMonotonicMs - monotonicNow(),
          expirationError: deadlineReachedError,
          maximumConnectionMilliseconds: MAINTENANCE_STATEMENT_MAX_MS,
          maximumQueryMilliseconds: MAINTENANCE_STATEMENT_MAX_MS,
          minimumOperationHeadroomMilliseconds: 1,
        },
      }), {
        deadlineMonotonicMs, monotonicNow,
      });
      return withMaintenanceLock(bounded, async (database) => {
        transaction = database;
        await recordMaintenanceDelivery(database, verifiedDelivery);
        const valkeyUrl = process.env.VALKEY_URL;
        if (!valkeyUrl) throw new Error("MAINTENANCE_CACHE_UNAVAILABLE");
        const client = createClient({
          url: valkeyUrl,
          socket: { connectTimeout: 5_000, reconnectStrategy: false },
          commandOptions: { abortSignal: overallAbort.signal },
        });
        redis = client;
        client.on("error", () => undefined);
        const key = maintenanceCacheKey();
        try {
          await client.connect();
          cacheAccess = createPostgresCacheAccess({
            db: database,
            backend: new ValkeyCacheBackend(redisTransport(client)),
            encryptionKey: key,
          });
          return await work();
        } finally {
          key.fill(0);
          cacheAccess?.destroy();
          cacheAccess = undefined;
          if (client.isOpen) client.destroy();
          redis = undefined;
          transaction = undefined;
        }
      });
    },
    cache: async () => {
      if (!transaction || !cacheAccess) throw new Error("MAINTENANCE_CONTEXT_MISSING");
      await synchronizeCanonicalCacheJobs(transaction, { limit: 25 });
      const result = await processNextCacheJob({
        repository: createPostgresCacheJobRepository(transaction),
        source: createPostgresProjectionSource(transaction),
        cache: cacheAccess.publisher,
        workerId: "cache-vercel-maintenance",
        leaseMs: 5_000,
        maxAttempts: 8,
      });
      return Object.freeze({ processed: result === "IDLE" ? 0 : 1 });
    },
    privacy: async () => {
      if (!transaction || !cacheAccess) throw new Error("MAINTENANCE_CONTEXT_MISSING");
      const result = await processForgetPropagation({
        db: transaction, cache: cacheAccess,
      }, {
        workerId: "privacy-forget-production",
        maximumSteps: 2,
        leaseMilliseconds: 5_000,
      });
      return Object.freeze({ processed: result.processedSteps });
    },
    stream: async () => {
      const streamClient = redis;
      if (!transaction || !streamClient) throw new Error("MAINTENANCE_CONTEXT_MISSING");
      const result = await publishNextCommittedEvent({
        db: transaction,
        workerId: "stream-vercel-maintenance",
        leaseMs: 5_000,
        maxAttempts: 10,
        publishTimeoutMs: 2_000,
        publish: async (channel, cursor, signal) => {
          await streamClient.sendCommand(["PUBLISH", channel, cursor], { abortSignal: signal });
        },
      });
      return Object.freeze({ processed: result === "IDLE" ? 0 : 1 });
    },
    schedules: async () => {
      if (!transaction) throw new Error("MAINTENANCE_CONTEXT_MISSING");
      const cycles = await openDueBroadcastCycles(
        { db: transaction }, new Date(), { scheduleLimit: 4 },
      );
      return Object.freeze({ processed: cycles.length });
    },
    bridgeLeases: async () => {
      if (!transaction) throw new Error("MAINTENANCE_CONTEXT_MISSING");
      return settleStaleBridgeLeases(transaction, 8);
    },
  };
  try {
    return await runBoundedMaintenance(maintenance);
  } finally {
    clearTimeout(overallTimer);
  }
}

export const POST = createMaintenanceHandler({
  now: () => new Date(),
  run: runProductionMaintenance,
  log: (safeCode) => { console.error(safeCode); },
});
