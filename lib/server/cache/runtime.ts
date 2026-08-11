import { createClient, type RedisClientType } from "redis";
import type { EventDatabase } from "../events/types";
import { closeDatabase, getDatabase } from "../db/postgres";
import {
  ValkeyCacheBackend,
  cacheProjectionPublisher,
  cacheProjectionReader,
  rebuildCriticalProjections,
  type CacheBackend,
  type CacheKeyDescriptor,
  type CacheProjectionPublisher,
  type CacheProjectionReader,
  scopedCache,
  type CriticalProjectionManifest,
  type CriticalProjectionSource,
  type ValkeyTransport,
} from "./store";
import {
  createPostgresCacheJobRepository,
  createPostgresProjectionSource,
  persistRebuildVerification,
  recordPostgresCacheMetric,
  synchronizeCanonicalCacheJobs,
} from "./postgres";
import { processNextCacheJob, type CacheJobProcessResult } from "../../../worker/cache/invalidate";

function cacheEncryptionKey(): Buffer {
  const encoded = process.env.GUSTAVO_CACHE_ENCRYPTION_KEY;
  if (!encoded) throw new Error("GUSTAVO_CACHE_ENCRYPTION_KEY_REQUIRED");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    key.fill(0);
    throw new Error("GUSTAVO_CACHE_ENCRYPTION_KEY_INVALID");
  }
  return key;
}

function valkeyTransport(client: RedisClientType): ValkeyTransport {
  return {
    get: (key) => client.get(key),
    set: async (key, value, options) => client.set(key, value, options),
    eval: async (script, options) => client.eval(script, {
      keys: [...options.keys], arguments: [...options.arguments],
    }) as Promise<number | string | null>,
    scan: async (cursor, options) => {
      const result = await client.scan(cursor, options);
      return { cursor: result.cursor, keys: result.keys };
    },
    del: (keys) => client.del([...keys]),
  };
}

const CACHE_ACTOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PostgresCacheActor {
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
}

function actor(input: PostgresCacheActor): PostgresCacheActor {
  if (!input || !CACHE_ACTOR_ID.test(input.accountId)
      || !CACHE_ACTOR_ID.test(input.nodeBrainId)
      || !CACHE_ACTOR_ID.test(input.conversationId)) {
    throw new Error("CACHE_READER_ACTOR_INVALID");
  }
  return Object.freeze({ ...input });
}

async function authorizePostgresCacheRead(
  database: EventDatabase,
  boundActor: PostgresCacheActor,
  descriptor: CacheKeyDescriptor,
): Promise<boolean> {
  if (descriptor.scope === "PUBLIC" || descriptor.scope === "SHARED") return true;
  if (descriptor.scope !== "PRIVATE_ACCOUNT"
      || descriptor.identityId !== boundActor.accountId
      || descriptor.entityId !== boundActor.conversationId
      || descriptor.topologyVersion !== "single-main-node-v1"
      || descriptor.schemaVersion !== 1
      || (descriptor.namespace !== "node-dossier" && descriptor.namespace !== "handoff")) {
    return false;
  }
  const sourceSequence = descriptor.kind === "POINTER"
    ? null : /^e([0-9]+)$/u.exec(descriptor.sourceHighWater)?.[1] ?? null;
  if (descriptor.kind === "VERSION" && sourceSequence === null) return false;
  const common = [
    boundActor.accountId,
    boundActor.nodeBrainId,
    boundActor.conversationId,
    descriptor.policyVersion,
    descriptor.kind,
    sourceSequence,
  ];
  const rows = descriptor.namespace === "node-dossier"
    ? await database.query<{ readonly authorized: boolean }>(
        `select true authorized
         from accounts account
         join entitlements entitlement on entitlement.account_id=account.id
           and entitlement.revoked_at is null
           and entitlement.active_from<=clock_timestamp()
           and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
         join node_brains node on node.account_id=account.id and node.id=$2
           and node.status='ACTIVE'
         join conversations conversation on conversation.account_id=account.id
           and conversation.node_brain_id=node.id and conversation.id=$3
           and conversation.status='OPEN'
         join lateral (
           select coalesce(event.policy_version,'node-routing-v1') policy_version
           from events event where event.aggregate_id=conversation.id::text
             and event.account_id=account.id::text and event.actor_type='NODE_BRAIN'
             and event.actor_id=node.id::text and event.type='node.reply.routed'
             and event.visibility='PRIVATE_ACCOUNT'
             and ($5::text='POINTER' or event.ingested_sequence=$6::bigint)
           order by event.ingested_sequence desc,event.id desc limit 1
         ) latest on latest.policy_version=$4
         where account.id=$1 and account.status='ACTIVE' limit 1`,
        common,
      )
    : await database.query<{ readonly authorized: boolean }>(
        `with latest as (
           select source.kind,source.id,source.policy_version
           from (
             select 'PACKET'::text kind,packet.id,packet.policy_version,
                    packet.source_high_water_sequence
             from handoff_packets packet
             where packet.account_id=$1 and packet.node_brain_id=$2
               and packet.conversation_id=$3
               and ($5::text='POINTER' or packet.source_high_water_sequence=$6::bigint)
             union all
             select 'CHECKPOINT'::text kind,checkpoint.id,checkpoint.policy_version,
                    checkpoint.source_high_water_sequence
             from handoff_refresh_checkpoints checkpoint
             where checkpoint.account_id=$1 and checkpoint.node_brain_id=$2
               and checkpoint.conversation_id=$3
               and ($5::text='POINTER' or checkpoint.source_high_water_sequence=$6::bigint)
           ) source
           order by source.source_high_water_sequence desc,source.id desc limit 1
         )
         select true authorized
         from accounts account
         join entitlements entitlement on entitlement.account_id=account.id
           and entitlement.revoked_at is null
           and entitlement.active_from<=clock_timestamp()
           and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
         join node_brains node on node.account_id=account.id and node.id=$2
           and node.status='ACTIVE'
         join conversations conversation on conversation.account_id=account.id
           and conversation.node_brain_id=node.id and conversation.id=$3
           and conversation.status='OPEN'
         join latest on latest.policy_version=$4
         where account.id=$1 and account.status='ACTIVE'
           and (latest.kind='CHECKPOINT' or not exists (
             select 1 from handoff_packet_ideas idea
             join proposal_disclosure_authorizations disclosure
               on disclosure.id=idea.disclosure_authorization_id
             left join proposal_disclosure_revocations revocation
               on revocation.authorization_id=disclosure.id
             where idea.packet_id=latest.id and idea.disclosure_authorization_id is not null
               and (disclosure.expires_at<=clock_timestamp() or revocation.authorization_id is not null)
           )) limit 1`,
        common,
      );
  return rows.length === 1;
}

function authorizeTrustedProjectionPublication(descriptor: CacheKeyDescriptor): boolean {
  return descriptor.namespace === "main-state"
    || descriptor.namespace === "broadcast"
    || descriptor.namespace === "challenge-snapshot"
    || descriptor.namespace === "node-dossier"
    || descriptor.namespace === "handoff";
}

export interface PostgresCacheAccess {
  readonly publisher: CacheProjectionPublisher;
  readerFor(actor: PostgresCacheActor): CacheProjectionReader;
  destroy(): void;
}

export function createPostgresCacheAccess(input: {
  readonly db: EventDatabase;
  readonly backend: CacheBackend;
  readonly encryptionKey: Uint8Array;
}): PostgresCacheAccess {
  const retainedKey = Buffer.from(input.encryptionKey);
  let destroyed = false;
  const cache = scopedCache({
    backend: input.backend,
    encryptionKey: retainedKey,
    authorize: authorizeTrustedProjectionPublication,
  });
  const publisher = cacheProjectionPublisher(cache);
  return Object.freeze({
    publisher,
    readerFor(inputActor: PostgresCacheActor) {
      if (destroyed) throw new Error("CACHE_ACCESS_DESTROYED");
      const boundActor = actor(inputActor);
      return cacheProjectionReader(scopedCache({
        backend: input.backend,
        encryptionKey: retainedKey,
        authorize: (descriptor) => authorizePostgresCacheRead(input.db, boundActor, descriptor),
      }));
    },
    destroy() {
      destroyed = true;
      retainedKey.fill(0);
    },
  });
}

export interface ProductionCacheRuntime {
  readonly db: EventDatabase;
  readonly publisher: CacheProjectionPublisher;
  readerFor(actor: PostgresCacheActor): CacheProjectionReader;
  close(): Promise<void>;
}

export async function createProductionCacheRuntime(): Promise<ProductionCacheRuntime> {
  const url = process.env.VALKEY_URL;
  if (!url) throw new Error("VALKEY_URL_REQUIRED");
  const client = createClient({ url });
  client.on("error", () => undefined);
  await client.connect();
  const secret = cacheEncryptionKey();
  const db = getDatabase();
  const access = createPostgresCacheAccess({
    db,
    backend: new ValkeyCacheBackend(valkeyTransport(client)),
    encryptionKey: secret,
  });
  secret.fill(0);
  return Object.freeze({
    db,
    publisher: access.publisher,
    readerFor: access.readerFor,
    async close() {
      try {
        await client.quit();
        await closeDatabase();
      } finally {
        access.destroy();
      }
    },
  });
}

function capturedSource(source: CriticalProjectionSource): {
  readonly source: CriticalProjectionSource;
  manifest(): CriticalProjectionManifest;
} {
  let captured: CriticalProjectionManifest | undefined;
  return {
    source: {
      name: "POSTGRES",
      async readManifest(checkpoint) {
        captured = await source.readManifest(checkpoint);
        return captured;
      },
      readPage: (input) => source.readPage(input),
    },
    manifest() {
      if (!captured) throw new Error("CACHE_REBUILD_MANIFEST_MISSING");
      return captured;
    },
  };
}

async function rebuild(input: {
  readonly db: EventDatabase;
  readonly cache: CacheProjectionPublisher;
  readonly checkpoint: string;
  readonly mode: "REBUILD" | "STARTUP_PREWARM";
}) {
  const started = Date.now();
  const capture = capturedSource(createPostgresProjectionSource(input.db));
  const result = await rebuildCriticalProjections({
    cache: input.cache, source: capture.source, checkpoint: input.checkpoint,
  });
  await persistRebuildVerification(input.db, {
    mode: input.mode,
    checkpoint: input.checkpoint,
    manifest: capture.manifest(),
    durationMs: Date.now() - started,
  });
  return result;
}

export function rebuildPostgresCache(input: {
  readonly db: EventDatabase;
  readonly cache: CacheProjectionPublisher;
  readonly checkpoint: string;
}) {
  return rebuild({ ...input, mode: "REBUILD" });
}

export function prewarmPostgresCache(input: {
  readonly db: EventDatabase;
  readonly cache: CacheProjectionPublisher;
  readonly checkpoint: string;
}) {
  return rebuild({ ...input, mode: "STARTUP_PREWARM" });
}

export async function runPostgresCacheWorkerOnce(input: {
  readonly db: EventDatabase;
  readonly cache: CacheProjectionPublisher;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
}): Promise<CacheJobProcessResult> {
  await synchronizeCanonicalCacheJobs(input.db, { limit: 1_000 });
  const lag = await input.db.one<{ readonly milliseconds: number }>(
    `select coalesce(max(extract(epoch from (clock_timestamp()-created_at))*1000),0)::float8 milliseconds
     from cache_projection_jobs where status in ('PENDING','RETRY_SCHEDULED','CLAIMED')`,
  );
  await recordPostgresCacheMetric(input.db, "cache.queue_lag_ms", Math.max(0, lag.milliseconds));
  const before = input.cache.metrics();
  const result = await processNextCacheJob({
    repository: createPostgresCacheJobRepository(input.db),
    source: createPostgresProjectionSource(input.db),
    cache: input.cache,
    workerId: input.workerId,
    leaseMs: input.leaseMs,
    maxAttempts: input.maxAttempts,
  });
  const after = input.cache.metrics();
  if (after.prewarmLatencyMs.count > before.prewarmLatencyMs.count) {
    await recordPostgresCacheMetric(
      input.db, "cache.prewarm_latency_ms",
      after.prewarmLatencyMs.total - before.prewarmLatencyMs.total,
    );
  }
  if (after.invalidationLatencyMs.count > before.invalidationLatencyMs.count) {
    await recordPostgresCacheMetric(
      input.db, "cache.invalidation_latency_ms",
      after.invalidationLatencyMs.total - before.invalidationLatencyMs.total,
    );
  }
  if (after.backendFailures > before.backendFailures) {
    await recordPostgresCacheMetric(
      input.db, "cache.backend_failure", after.backendFailures - before.backendFailures,
    );
  }
  if (after.freshnessLagMs.count > before.freshnessLagMs.count) {
    await recordPostgresCacheMetric(
      input.db, "cache.freshness_lag_ms",
      after.freshnessLagMs.total - before.freshnessLagMs.total,
    );
  }
  return result;
}

export interface PostgresCacheWorkerController {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export function startPostgresCacheWorker(input: {
  readonly db: EventDatabase;
  readonly cache: CacheProjectionPublisher;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly pollIntervalMs: number;
}): PostgresCacheWorkerController {
  if (!Number.isSafeInteger(input.pollIntervalMs)
      || input.pollIntervalMs < 1 || input.pollIntervalMs > 60_000) {
    throw new Error("CACHE_WORKER_POLL_INTERVAL_INVALID");
  }
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const wait = (milliseconds: number) => new Promise<void>((resolve) => {
    wake = resolve;
    timer = setTimeout(() => {
      timer = null;
      wake = null;
      resolve();
    }, milliseconds);
    timer.unref?.();
  });
  const done = (async () => {
    while (!stopping) {
      try {
        const result = await runPostgresCacheWorkerOnce(input);
        if (stopping) break;
        await wait(result === "IDLE" ? input.pollIntervalMs : 1);
      } catch {
        try {
          await recordPostgresCacheMetric(input.db, "cache.backend_failure", 1);
        } catch {
          // PostgreSQL may be the failed dependency; the bounded loop retries.
        }
        if (!stopping) await wait(Math.min(1_000, input.pollIntervalMs * 2));
      }
    }
  })();
  return Object.freeze({
    done,
    async stop() {
      stopping = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      wake?.();
      wake = null;
      await done;
    },
  });
}
