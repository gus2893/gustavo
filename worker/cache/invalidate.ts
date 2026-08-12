import { randomUUID } from "node:crypto";
import {
  cacheKey,
  cachePointerKey,
  projectionValueHash,
  type CacheProtectedGuardContext,
  type CachePointerKeyInput,
  type CacheProjectionPublisher,
  type CriticalProjectionRecord,
  type CacheProjectionCategory,
} from "../../lib/server/cache/store";
import type { EventDatabase } from "../../lib/server/events/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const MAX_CHANGE_SOURCE_ROWS = 1_000;

export interface CacheOutboxMessage {
  readonly outboxId: string;
  readonly eventId: string;
  readonly topic: string;
  readonly payload: { readonly eventId: string };
  readonly createdAt: string;
  readonly category?: CacheProjectionCategory;
}

export type CacheProjectionChange =
  | {
      readonly action: "PREWARM";
      readonly triggerEventId: string;
      readonly recordSourceEventId: string;
      readonly sourceTopic: string;
      readonly record: CriticalProjectionRecord;
    }
  | {
      readonly action: "INVALIDATE";
      readonly triggerEventId: string;
      readonly sourceTopic: string;
      readonly pointer: CachePointerKeyInput;
      readonly throughOrdinal: string;
    };

export interface CacheChangeSource {
  loadChange(
    eventId: string,
    input: {
      readonly topic: string;
      readonly maxRows: number;
      readonly category?: CacheProjectionCategory;
    },
    database?: EventDatabase,
  ): Promise<CacheProjectionChange>;
}

export interface CacheJobClaim {
  readonly jobId: string;
  readonly message: CacheOutboxMessage;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseUntil: string;
  readonly attempt: number;
}

export interface CacheJobRepository {
  claim(workerId: string, leaseMs: number): Promise<CacheJobClaim | null>;
  guardTarget?(claim: CacheJobClaim): Promise<{
    readonly key: ReturnType<typeof cachePointerKey>;
    readonly operation: "WRITE" | "INVALIDATE";
  } | null>;
  complete(
    claim: CacheJobClaim,
    change?: CacheProjectionChange,
    database?: EventDatabase,
  ): Promise<void>;
  retry(claim: CacheJobClaim, errorCode: string): Promise<void>;
  fail(claim: CacheJobClaim, errorCode: string): Promise<void>;
}

type JobStatus = "PENDING" | "CLAIMED" | "RETRY_SCHEDULED" | "COMPLETED" | "FAILED";

interface MutableCacheJob {
  readonly id: string;
  readonly message: CacheOutboxMessage;
  readonly receipt: CacheJobReceipt;
  status: JobStatus;
  attempts: number;
  workerId: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  retryAt: number | null;
  errorCode: string | null;
}

interface InMemoryCacheJobRepositoryOptions {
  readonly now?: () => Date;
  readonly retryDelayMs?: number;
}

/**
 * Executable queue contract for deterministic tests. A PostgreSQL adapter uses
 * the same atomic claim/transition contract against the transactional outbox.
 */
export class InMemoryCacheJobRepository implements CacheJobRepository {
  readonly #jobs = new Map<string, MutableCacheJob>();
  readonly #eventIndex = new Map<string, string>();
  readonly #now: () => Date;
  readonly #retryDelayMs: number;

  constructor(options: InMemoryCacheJobRepositoryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 1) {
      throw new Error("CACHE_JOB_RETRY_DELAY_INVALID");
    }
  }

  enqueue(message: CacheOutboxMessage): CacheJobReceipt {
    const existing = this.#jobs.get(message.outboxId);
    if (existing) {
      if (existing.message.eventId !== message.eventId
          || existing.message.topic !== message.topic
          || existing.message.payload.eventId !== message.payload.eventId
          || existing.message.createdAt !== message.createdAt) {
        throw new Error("CACHE_JOB_IDEMPOTENCY_CONFLICT");
      }
      return existing.receipt;
    }
    const createdAt = Date.parse(message.createdAt);
    if (!UUID_PATTERN.test(message.outboxId)
        || !UUID_PATTERN.test(message.eventId)
        || !Number.isFinite(createdAt)) {
      throw new Error("CACHE_JOB_MESSAGE_INVALID");
    }
    const existingOutboxId = this.#eventIndex.get(message.eventId);
    if (existingOutboxId !== undefined && existingOutboxId !== message.outboxId) {
      throw new Error("CACHE_JOB_EVENT_REASSIGNED");
    }
    const receipt = Object.freeze({ jobId: message.outboxId });
    const job: MutableCacheJob = {
      id: message.outboxId,
      message: Object.freeze({
        ...message,
        payload: Object.freeze({ ...message.payload }),
      }),
      receipt,
      status: "PENDING",
      attempts: 0,
      workerId: null,
      leaseToken: null,
      leaseUntil: null,
      retryAt: null,
      errorCode: null,
    };
    this.#jobs.set(job.id, job);
    this.#eventIndex.set(message.eventId, message.outboxId);
    return receipt;
  }

  async claim(workerId: string, leaseMs: number): Promise<CacheJobClaim | null> {
    if (!WORKER_ID_PATTERN.test(workerId)) throw new Error("CACHE_JOB_WORKER_ID_INVALID");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
      throw new Error("CACHE_JOB_LEASE_INVALID");
    }
    const now = this.#now().getTime();
    if (!Number.isFinite(now)) throw new Error("CACHE_JOB_CLOCK_INVALID");
    const candidate = [...this.#jobs.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .find((job) => (
        job.status === "PENDING"
        || (job.status === "RETRY_SCHEDULED" && (job.retryAt ?? Number.POSITIVE_INFINITY) <= now)
        || (job.status === "CLAIMED" && (job.leaseUntil ?? Number.POSITIVE_INFINITY) <= now)
      ));
    if (!candidate) return null;
    candidate.status = "CLAIMED";
    candidate.attempts += 1;
    candidate.workerId = workerId;
    candidate.leaseToken = randomUUID();
    candidate.leaseUntil = now + leaseMs;
    candidate.retryAt = null;
    candidate.errorCode = null;
    return Object.freeze({
      jobId: candidate.id,
      message: candidate.message,
      workerId,
      leaseToken: candidate.leaseToken,
      leaseUntil: new Date(candidate.leaseUntil).toISOString(),
      attempt: candidate.attempts,
    });
  }

  #assertClaim(claim: CacheJobClaim): MutableCacheJob {
    const job = this.#jobs.get(claim.jobId);
    const now = this.#now().getTime();
    if (!job || job.status !== "CLAIMED"
        || job.workerId !== claim.workerId
        || job.leaseToken !== claim.leaseToken
        || job.leaseUntil === null
        || job.leaseUntil <= now) {
      throw new Error("CACHE_JOB_CLAIM_STALE");
    }
    return job;
  }

  async complete(claim: CacheJobClaim, _change?: CacheProjectionChange): Promise<void> {
    const job = this.#assertClaim(claim);
    job.status = "COMPLETED";
    job.leaseUntil = null;
    job.retryAt = null;
  }

  async retry(claim: CacheJobClaim, errorCode: string): Promise<void> {
    const job = this.#assertClaim(claim);
    job.status = "RETRY_SCHEDULED";
    job.retryAt = this.#now().getTime() + this.#retryDelayMs;
    job.leaseUntil = null;
    job.errorCode = normalizedError(errorCode);
  }

  async fail(claim: CacheJobClaim, errorCode: string): Promise<void> {
    const job = this.#assertClaim(claim);
    job.status = "FAILED";
    job.leaseUntil = null;
    job.retryAt = null;
    job.errorCode = normalizedError(errorCode);
  }

  snapshot(): Readonly<{
    pending: number;
    claimed: number;
    retryScheduled: number;
    completed: number;
    failed: number;
  }> {
    const counts = {
      pending: 0,
      claimed: 0,
      retryScheduled: 0,
      completed: 0,
      failed: 0,
    };
    for (const job of this.#jobs.values()) {
      if (job.status === "PENDING") counts.pending += 1;
      else if (job.status === "CLAIMED") counts.claimed += 1;
      else if (job.status === "RETRY_SCHEDULED") counts.retryScheduled += 1;
      else if (job.status === "COMPLETED") counts.completed += 1;
      else counts.failed += 1;
    }
    return Object.freeze(counts);
  }
}

function normalizedError(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  const normalized = source.toUpperCase().replace(/[^A-Z0-9_:-]/gu, "_").slice(0, 128);
  return normalized.startsWith("CACHE_") ? normalized : "CACHE_JOB_PROCESSING_FAILED";
}

function validateMessage(message: CacheOutboxMessage): void {
  if (
    !UUID_PATTERN.test(message.outboxId)
    || !UUID_PATTERN.test(message.eventId)
    || typeof message.topic !== "string"
    || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/u.test(message.topic)
    || message.topic.length > 160
    || message.payload === null
    || typeof message.payload !== "object"
    || Object.keys(message.payload).length !== 1
    || message.payload.eventId !== message.eventId
    || !Number.isFinite(Date.parse(message.createdAt))
  ) {
    throw new Error("CACHE_OUTBOX_MESSAGE_INVALID");
  }
}

function validatePrewarmRecord(
  record: CriticalProjectionRecord,
  recordSourceEventId: string,
): void {
  const sourceEventIds = record.value !== null
      && typeof record.value === "object" && !Array.isArray(record.value)
    ? record.value.sourceEventIds : undefined;
  if (
    !UUID_PATTERN.test(recordSourceEventId)
    || !Array.isArray(sourceEventIds)
    || sourceEventIds[0] !== recordSourceEventId
    || !Number.isSafeInteger(record.sourceRowCount)
    || record.sourceRowCount < 0
    || record.sourceRowCount > MAX_CHANGE_SOURCE_ROWS
    || projectionValueHash(record.value) !== record.contentHash
  ) {
    throw new Error("CACHE_PREWARM_SOURCE_INVALID");
  }
}

export type CacheJobProcessResult =
  | "IDLE"
  | "COMPLETED"
  | "RETRY_SCHEDULED"
  | "FAILED"
  | "LEASE_LOST";

function guardDatabase(context: CacheProtectedGuardContext): EventDatabase | undefined {
  const candidate = context.database;
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Partial<EventDatabase>;
  return typeof value.query === "function"
      && typeof value.one === "function"
      && typeof value.transaction === "function"
    ? value as EventDatabase : undefined;
}

export async function processNextCacheJob(input: {
  readonly repository: CacheJobRepository;
  readonly source: CacheChangeSource;
  readonly cache: CacheProjectionPublisher;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
}): Promise<CacheJobProcessResult> {
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20) {
    throw new Error("CACHE_JOB_MAX_ATTEMPTS_INVALID");
  }
  const claim = await input.repository.claim(input.workerId, input.leaseMs);
  if (!claim) return "IDLE";
  let attemptedAction: CacheProjectionChange["action"] | null = null;
  try {
    validateMessage(claim.message);
    const loadChange = async (database?: EventDatabase): Promise<CacheProjectionChange> => {
      const change = await input.source.loadChange(claim.message.eventId, {
        topic: claim.message.topic,
        maxRows: MAX_CHANGE_SOURCE_ROWS,
        ...(claim.message.category === undefined ? {} : { category: claim.message.category }),
      }, database);
      if (change.triggerEventId !== claim.message.eventId
          || change.sourceTopic !== claim.message.topic) {
        throw new Error("CACHE_CHANGE_SOURCE_AUTHORITY_INVALID");
      }
      attemptedAction = change.action;
      return change;
    };
    const applyChange = async (
      change: CacheProjectionChange,
      database?: EventDatabase,
    ): Promise<void> => {
      if (change.action === "PREWARM") {
        validatePrewarmRecord(change.record, change.recordSourceEventId);
        await input.cache.publish({
          pointerKey: cachePointerKey(change.record.key),
          versionKey: cacheKey(change.record.key),
          versionOrdinal: change.record.versionOrdinal,
          value: change.record.value,
          options: {
            ttlSeconds: change.record.key.namespace === "broadcast" ? 300 : 60,
            encrypted: change.record.key.scope === "PRIVATE_ACCOUNT"
              || change.record.key.scope === "OPERATOR",
          },
          sourceOccurredAt: claim.message.createdAt,
        });
      } else if (change.action === "INVALIDATE") {
        await input.cache.invalidate(cachePointerKey(change.pointer), {
          throughOrdinal: change.throughOrdinal,
        });
      } else {
        throw new Error("CACHE_CHANGE_ACTION_INVALID");
      }
      await input.repository.complete(claim, change, database);
    };
    const target = await input.repository.guardTarget?.(claim) ?? null;
    if (target) {
      await input.cache.withPublicationGuard(target.key, async (context) => {
        const database = guardDatabase(context);
        if (!database) throw new Error("CACHE_PROTECTED_TRANSACTION_REQUIRED");
        const change = await loadChange(database);
        const operation = change.action === "INVALIDATE" ? "INVALIDATE" : "WRITE";
        if (target.operation !== operation) throw new Error("CACHE_JOB_GUARD_ACTION_MISMATCH");
        await applyChange(change, database);
      }, target.operation);
    } else {
      const change = await loadChange();
      const publicationKey = change.action === "PREWARM"
        ? cacheKey(change.record.key) : cachePointerKey(change.pointer);
      const protectedChange = change.action === "PREWARM"
        ? change.record.key.scope === "PRIVATE_ACCOUNT"
        : change.pointer.scope === "PRIVATE_ACCOUNT";
      if (protectedChange) throw new Error("CACHE_JOB_PROTECTED_GUARD_TARGET_REQUIRED");
      await input.cache.withPublicationGuard(publicationKey, async (context) => {
        await applyChange(change, guardDatabase(context));
      }, change.action === "INVALIDATE" ? "INVALIDATE" : "WRITE");
    }
    return "COMPLETED";
  } catch (error) {
    // invalidate() records backend failures itself; source/authority failures
    // have not selected a safe target and are tracked as prewarm/job failures.
    if (attemptedAction !== "INVALIDATE") input.cache.recordPrewarmFailure();
    const code = normalizedError(error);
    try {
      if (claim.attempt < input.maxAttempts) {
        await input.repository.retry(claim, code);
        return "RETRY_SCHEDULED";
      }
      await input.repository.fail(claim, code);
      return "FAILED";
    } catch (transitionError) {
      if (transitionError instanceof Error && transitionError.message === "CACHE_JOB_CLAIM_STALE") {
        return "LEASE_LOST";
      }
      throw transitionError;
    }
  }
}

export interface CacheJobReceipt {
  readonly jobId: string;
}
