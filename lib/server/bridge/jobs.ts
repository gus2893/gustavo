import { appendEvent, readEventBody } from "../events/store";
import { canonicalContentDigest, digestsEqual } from "../events/integrity";
import type { EventDatabase, JsonValue } from "../events/types";
import {
  BROADCAST_POLICY_VERSION,
  commitBroadcast,
} from "../main-brain/broadcasts";

export const BRIDGE_JOB_ROLES = Object.freeze([
  "NODE",
  "EVALUATOR",
  "MAIN",
] as const);

export const BRIDGE_JOB_RETENTION_DAYS = 7 as const;

export const BRIDGE_JOB_KINDS = Object.freeze([
  "NODE_REPLY",
  "EVALUATOR_REVIEW",
  "MAIN_GENERATION",
] as const);

export const BRIDGE_JOB_STATUSES = Object.freeze([
  "PENDING",
  "CLAIMED",
  "COMPLETED",
  "FAILED",
] as const);

export const BRIDGE_SAFE_TERMINAL_CODES = Object.freeze([
  "SOURCE_AUTHORITY_REVOKED",
  "ROUTING_AUTHORITY_REVOKED",
  "CODEX_AUTH_UNAVAILABLE",
  "CODEX_DAILY_QUOTA_EXHAUSTED",
  "CODEX_MODEL_UNAVAILABLE",
  "CODEX_TIMEOUT",
  "CODEX_OUTPUT_INVALID",
  "CODEX_PROCESS_FAILED",
  "OUTPUT_AUTHORITY_INVALID",
  "ATTEMPT_LIMIT_EXHAUSTED",
  "MAIN_CANDIDATE_REJECTED",
  "EVALUATOR_REJECTED",
] as const);

export const BRIDGE_ROLE_PRIORITIES = Object.freeze({
  NODE: 0,
  EVALUATOR: 10,
  MAIN: 20,
} as const);

export const HYBRID_WORKER_COMPONENTS = Object.freeze([
  "CODEX",
  "MARKET",
  "TUNNEL",
] as const);

export const HYBRID_WORKER_STATUSES = Object.freeze([
  "HEALTHY",
  "DEGRADED",
  "OFFLINE",
] as const);

export const HYBRID_WORKER_SAFE_CODES = Object.freeze([
  "AUTH_REQUIRED",
  "QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "DATABASE_UNAVAILABLE",
  "TUNNEL_UNAVAILABLE",
  "WORKER_OFFLINE",
] as const);

export const MARKET_WINDOW_STATUSES = Object.freeze([
  "PENDING",
  "COMPLETED",
  "FAILED",
] as const);

export const MARKET_PROVIDER_STATUSES = Object.freeze([
  "UNKNOWN",
  "OPEN",
  "CLOSED",
  "ERROR",
] as const);

export const MARKET_WINDOW_SAFE_CODES = Object.freeze([
  "MARKET_CLOSED",
  "PROVIDER_ERROR",
  "RATE_LIMITED",
  "RESULT_COUNT_INVALID",
  "CALL_LIMIT_EXCEEDED",
  "WINDOW_CONFLICT",
] as const);

export const MARKET_QUOTE_STATUSES = Object.freeze([
  "SUCCESS",
  "UNAVAILABLE",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
] as const);

export const MARKET_QUOTE_SAFE_CODES = Object.freeze([
  "MARKET_CLOSED",
  "SYMBOL_UNAVAILABLE",
  "STALE_QUOTE",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "MALFORMED_RESPONSE",
] as const);

export const MARKET_SYMBOL_KINDS = Object.freeze([
  "STOCK",
  "ETF",
] as const);

export const DEPLOYMENT_QUOTA_NAMES = Object.freeze([
  "QSTASH_MESSAGES",
  "CODEX_JOBS",
  "FINNHUB_CALLS",
] as const);

export type BridgeJobRole = typeof BRIDGE_JOB_ROLES[number];
export type BridgeJobKind = typeof BRIDGE_JOB_KINDS[number];
export type BridgeJobStatus = typeof BRIDGE_JOB_STATUSES[number];
export type BridgeSafeTerminalCode = typeof BRIDGE_SAFE_TERMINAL_CODES[number];
export type BridgeCallerFailureCode = Exclude<
  BridgeSafeTerminalCode,
  "ATTEMPT_LIMIT_EXHAUSTED"
>;
export type HybridWorkerComponent = typeof HYBRID_WORKER_COMPONENTS[number];
export type HybridWorkerStatus = typeof HYBRID_WORKER_STATUSES[number];
export type HybridWorkerSafeCode = typeof HYBRID_WORKER_SAFE_CODES[number];
export type MarketWindowStatus = typeof MARKET_WINDOW_STATUSES[number];
export type MarketProviderStatus = typeof MARKET_PROVIDER_STATUSES[number];
export type MarketWindowSafeCode = typeof MARKET_WINDOW_SAFE_CODES[number];
export type MarketQuoteStatus = typeof MARKET_QUOTE_STATUSES[number];
export type MarketQuoteSafeCode = typeof MARKET_QUOTE_SAFE_CODES[number];
export type MarketSymbolKind = typeof MARKET_SYMBOL_KINDS[number];
export type DeploymentQuotaName = typeof DEPLOYMENT_QUOTA_NAMES[number];

export interface BridgeModelJobRow {
  readonly jobId: string;
  readonly sourceEventId: string;
  readonly cycleId: string | null;
  readonly candidateEventId: string | null;
  readonly parentMainJobId: string | null;
  readonly role: BridgeJobRole;
  readonly kind: BridgeJobKind;
  readonly priority: 0 | 10 | 20;
  readonly requestDigest: string;
  readonly status: BridgeJobStatus;
  readonly attemptCount: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly outputEventId: string | null;
  readonly safeCode: BridgeSafeTerminalCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BridgeWakeReceiptRow {
  readonly messageId: string;
  readonly bodyDigest: string;
  readonly publishedAt: string;
  readonly receivedAt: string;
  readonly pruneAfter: string;
}

export interface HybridWorkerHeartbeatRow {
  readonly component: HybridWorkerComponent;
  readonly status: HybridWorkerStatus;
  readonly safeCode: HybridWorkerSafeCode | null;
  readonly observedAt: string;
  readonly updatedAt: string;
}

export interface MarketPollWindowRow {
  readonly windowId: string;
  readonly windowStartedAt: string;
  readonly provider: "FINNHUB";
  readonly status: MarketWindowStatus;
  readonly providerStatus: MarketProviderStatus;
  readonly callsUsed: number;
  readonly resultCount: number;
  readonly safeCode: MarketWindowSafeCode | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pruneAfter: string;
}

export interface MarketLatestQuoteRow {
  readonly accountId: string;
  readonly symbol: string;
  readonly windowId: string;
  readonly provider: "FINNHUB";
  readonly status: MarketQuoteStatus;
  readonly sourceObservedAt: string | null;
  readonly receivedAt: string;
  readonly dataKeyId: string | null;
  readonly ciphertext: Uint8Array | null;
  readonly envelopeIv: Uint8Array | null;
  readonly envelopeAuthTag: Uint8Array | null;
  readonly envelopeEncoding: "canonical-json-v1" | null;
  readonly contextDigest: string;
  readonly safeCode: MarketQuoteSafeCode | null;
  readonly updatedAt: string;
}

export interface MarketSymbolCatalogRow {
  readonly ordinal: number;
  readonly symbol: string;
  readonly kind: MarketSymbolKind;
}

export interface DeploymentQuotaCounterRow {
  readonly quotaName: DeploymentQuotaName;
  readonly bucketDate: string;
  readonly usedCount: number;
  readonly limitCount: number;
  readonly updatedAt: string;
}

export const BRIDGE_JOB_MAX_ATTEMPTS = 3 as const;
export const BRIDGE_JOB_LEASE_MINUTES = 15 as const;

const BROADCAST_EVALUATOR_CRITERIA = Object.freeze([
  "Support every material claim with the exact authorized cycle snapshot and source provenance.",
  "Enforce educational market commentary policy without directives, execution claims, or paid-provider fallback.",
  "Preserve exact cycle, candidate, source-ID, source-digest, and review provenance.",
  "Preserve source time, freshness, and provisional-market-observation caveats.",
  "Use approved simulation and paper-position language whenever simulated actions appear.",
] as const);

const BROADCAST_EVALUATOR_RUBRIC_DOCUMENT = Object.freeze({
  version: "broadcast-evaluator-v1" as const,
  criteria: BROADCAST_EVALUATOR_CRITERIA,
});

export const BROADCAST_EVALUATOR_RUBRIC = Object.freeze({
  ...BROADCAST_EVALUATOR_RUBRIC_DOCUMENT,
  digest: canonicalContentDigest(BROADCAST_EVALUATOR_RUBRIC_DOCUMENT),
});

const BRIDGE_CLAIM_LOCK = "gustavo:bridge-model-job-claim:v1";
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Deliberately excludes event bodies, prompts, output text, and ciphertext.
const BRIDGE_JOB_SAFE_COLUMNS = `
  job_id::text as "jobId",
  source_event_id::text as "sourceEventId",
  cycle_id::text as "cycleId",
  candidate_event_id::text as "candidateEventId",
  parent_main_job_id::text as "parentMainJobId",
  role as "role",
  kind as "kind",
  priority as "priority",
  request_digest::text as "requestDigest",
  status as "status",
  attempt_count as "attemptCount",
  lease_owner as "leaseOwner",
  lease_expires_at as "leaseExpiresAt",
  output_event_id::text as "outputEventId",
  safe_code as "safeCode",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

interface BridgeJobSqlRow extends Record<string, unknown> {
  readonly jobId: string;
  readonly sourceEventId: string;
  readonly cycleId: string | null;
  readonly candidateEventId: string | null;
  readonly parentMainJobId: string | null;
  readonly role: BridgeJobRole;
  readonly kind: BridgeJobKind;
  readonly priority: 0 | 10 | 20;
  readonly requestDigest: string;
  readonly status: BridgeJobStatus;
  readonly attemptCount: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | string | null;
  readonly outputEventId: string | null;
  readonly safeCode: BridgeSafeTerminalCode | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

export interface ClaimNextBridgeJobInput {
  readonly workerId: string;
  /** Validated for caller contract compatibility; database time owns leases and UTC quotas. */
  readonly now: Date;
}

export interface CompleteBridgeJobInput {
  readonly jobId: string;
  readonly workerId: string;
  readonly attemptCount: number;
  readonly outputEventId: string;
}

export interface FailBridgeJobInput {
  readonly jobId: string;
  readonly workerId: string;
  readonly attemptCount: number;
  readonly safeCode: BridgeCallerFailureCode;
}

export interface StageMainCandidateInput {
  readonly jobId: string;
  readonly workerId: string;
  readonly attemptCount: number;
  readonly cycleId: string;
  readonly candidate: string;
}

export interface CommitAcceptedEvaluatorInput {
  readonly jobId: string;
  readonly workerId: string;
  readonly attemptCount: number;
  readonly cycleId: string;
  readonly candidateEventId: string;
  readonly decision: "ACCEPT";
  readonly rubricVersion: "broadcast-evaluator-v1";
  readonly rubricDigest: string;
  readonly rubricCriteria: readonly string[];
  readonly rationaleCode: string;
}

function requireUuid(value: string, code: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(code);
  return value;
}

function requireWorkerId(value: string): string {
  if (!WORKER_ID_PATTERN.test(value)) throw new Error("BRIDGE_WORKER_ID_INVALID");
  return value;
}

function requireAttemptCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > BRIDGE_JOB_MAX_ATTEMPTS) {
    throw new Error("BRIDGE_JOB_ATTEMPT_INVALID");
  }
  return value;
}

function requireUtcInstant(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time)) throw new Error("BRIDGE_CLAIM_TIME_INVALID");
  return new Date(time).toISOString();
}

function requireSafeTerminalCode(value: BridgeSafeTerminalCode): BridgeCallerFailureCode {
  if (
    value === "ATTEMPT_LIMIT_EXHAUSTED"
    || !(BRIDGE_SAFE_TERMINAL_CODES as readonly string[]).includes(value)
  ) {
    throw new Error("BRIDGE_SAFE_CODE_INVALID");
  }
  return value as BridgeCallerFailureCode;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function mapBridgeJob(row: BridgeJobSqlRow): BridgeModelJobRow {
  return Object.freeze({
    jobId: row.jobId,
    sourceEventId: row.sourceEventId,
    cycleId: row.cycleId,
    candidateEventId: row.candidateEventId,
    parentMainJobId: row.parentMainJobId,
    role: row.role,
    kind: row.kind,
    priority: row.priority,
    requestDigest: row.requestDigest,
    status: row.status,
    attemptCount: row.attemptCount,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt === null ? null : iso(row.leaseExpiresAt),
    outputEventId: row.outputEventId,
    safeCode: row.safeCode,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

async function takeClaimLock(database: EventDatabase): Promise<void> {
  await database.query(
    "select pg_advisory_xact_lock(hashtextextended($1,0))",
    [BRIDGE_CLAIM_LOCK],
  );
}

interface LockedCycleDataKeyRow extends Record<string, unknown> {
  readonly id: string;
}

interface LockedCycleBodyRow extends Record<string, unknown> {
  readonly eventId: string;
  readonly dataKeyId: string | null;
}

async function lockCycleEventBodies(
  database: EventDatabase,
  cycleId: string,
  eventIds: readonly string[],
  errorCode: string,
  appendIdempotencyKeys: readonly string[] = [],
): Promise<void> {
  if (appendIdempotencyKeys.length > 0) {
    const lockKeys = [...new Set(appendIdempotencyKeys)].sort()
      .map((key) => `event-idempotency:${key}`);
    await database.query(
      `/* bridge-event-idempotency-lock */
       select pg_advisory_xact_lock(hashtextextended(item,0))
         from unnest($1::text[]) item order by item`,
      [lockKeys],
    );
  }
  await database.query(
    `/* bridge-cycle-aggregate-lock */
     select pg_advisory_xact_lock(hashtextextended($1,0))`,
    [`aggregate-key:${cycleId}`],
  );
  const keys = await database.query<LockedCycleDataKeyRow>(
    `/* bridge-cycle-key-lock */
     select id::text as id
       from aggregate_data_keys
      where aggregate_id=$1
      order by id
      for key share`,
    [cycleId],
  );
  if (keys.length !== 1) throw new Error(errorCode);
  const uniqueEventIds = [...new Set(eventIds)].sort();
  const bodies = await database.query<LockedCycleBodyRow>(
    `/* bridge-cycle-body-lock */
     select event_id::text as "eventId",data_key_id::text as "dataKeyId"
       from encrypted_event_bodies
      where aggregate_id=$1 and event_id=any($2::uuid[])
      order by event_id
      for share`,
    [cycleId, uniqueEventIds],
  );
  const lockedByEvent = new Map(bodies.map((body) => [body.eventId, body.dataKeyId]));
  if (
    bodies.length !== uniqueEventIds.length
    || uniqueEventIds.some((eventId) => lockedByEvent.get(eventId) !== keys[0].id)
  ) throw new Error(errorCode);
}

async function readLockedJob(
  database: EventDatabase,
  jobId: string,
): Promise<BridgeJobSqlRow | null> {
  const rows = await database.query<BridgeJobSqlRow>(
    `select ${BRIDGE_JOB_SAFE_COLUMNS}
       from bridge_model_jobs
      where job_id=$1
      for update`,
    [jobId],
  );
  return rows[0] ?? null;
}

async function readJobSnapshot(
  database: EventDatabase,
  jobId: string,
): Promise<BridgeJobSqlRow | null> {
  const rows = await database.query<BridgeJobSqlRow>(
    `select ${BRIDGE_JOB_SAFE_COLUMNS}
       from bridge_model_jobs
      where job_id=$1`,
    [jobId],
  );
  return rows[0] ?? null;
}

export async function claimNextBridgeJob(
  database: EventDatabase,
  input: ClaimNextBridgeJobInput,
): Promise<BridgeModelJobRow | null> {
  const workerId = requireWorkerId(input.workerId);
  requireUtcInstant(input.now);

  const first = await claimBridgeJobPhase(database, workerId);
  if (first !== BRIDGE_EXHAUSTION_CLEANED) return first;
  const second = await claimBridgeJobPhase(database, workerId);
  return second === BRIDGE_EXHAUSTION_CLEANED ? null : second;
}

const BRIDGE_EXHAUSTION_CLEANED = Symbol("BRIDGE_EXHAUSTION_CLEANED");

async function claimBridgeJobPhase(
  database: EventDatabase,
  workerId: string,
): Promise<BridgeModelJobRow | null | typeof BRIDGE_EXHAUSTION_CLEANED> {

  return database.transaction(async (transaction) => {
    await takeClaimLock(transaction);
    const exhausted = await transaction.query<{ readonly jobId: string }>(
      `update bridge_model_jobs
          set status='FAILED',lease_owner=null,lease_expires_at=null,
              output_event_id=null,safe_code='ATTEMPT_LIMIT_EXHAUSTED'
        where status='CLAIMED'
          and lease_expires_at<=clock_timestamp()
          and attempt_count=$1
        returning job_id::text as "jobId"`,
      [BRIDGE_JOB_MAX_ATTEMPTS],
    );
    if (exhausted.length > 0) return BRIDGE_EXHAUSTION_CLEANED;

    const active = await transaction.query(
      `select job_id
         from bridge_model_jobs
        where status='CLAIMED' and lease_expires_at>clock_timestamp()
        limit 1`,
    );
    if (active.length > 0) return null;

    const candidates = await transaction.query<{ readonly jobId: string }>(
      `select job_id::text as "jobId"
         from bridge_model_jobs
        where status='PENDING'
           or (status='CLAIMED' and lease_expires_at<=clock_timestamp()
               and attempt_count<$1)
        order by priority,created_at,job_id
        for update skip locked
        limit 1`,
      [BRIDGE_JOB_MAX_ATTEMPTS],
    );
    const candidate = candidates[0];
    if (!candidate) return null;

    const quota = await transaction.query<{ readonly usedCount: number }>(
      `insert into deployment_quota_counters (
         quota_name,bucket_date,used_count,limit_count,updated_at
       ) values (
         'CODEX_JOBS',(clock_timestamp() at time zone 'UTC')::date,1,100,clock_timestamp()
       )
       on conflict (quota_name,bucket_date) do update
         set used_count=deployment_quota_counters.used_count+1,
             updated_at=clock_timestamp()
       where deployment_quota_counters.used_count<deployment_quota_counters.limit_count
       returning used_count as "usedCount"`,
    );
    if (quota.length !== 1) throw new Error("CODEX_DAILY_QUOTA_EXHAUSTED");

    const claimed = await transaction.query<BridgeJobSqlRow>(
      `update bridge_model_jobs
          set status='CLAIMED',attempt_count=attempt_count+1,
              lease_owner=$2,
              lease_expires_at=clock_timestamp()+interval '${BRIDGE_JOB_LEASE_MINUTES} minutes',
              output_event_id=null,safe_code=null
        where job_id=$1
        returning ${BRIDGE_JOB_SAFE_COLUMNS}`,
      [candidate.jobId, workerId],
    );
    if (claimed.length !== 1) throw new Error("BRIDGE_JOB_CLAIM_CONFLICT");
    return mapBridgeJob(claimed[0]);
  });
}

async function outputIsBoundToJob(
  database: EventDatabase,
  job: BridgeJobSqlRow,
  outputEventId: string,
): Promise<boolean> {
  const result = await database.one<{ readonly authorized: boolean }>(
    `select exists (
       select 1
         from events source
         join conversations conversation
           on conversation.id::text=source.aggregate_id
          and conversation.account_id::text=source.account_id
         join events output on output.id=$2
         join encrypted_event_bodies output_body on output_body.event_id=output.id
        where source.id=$1
          and output.aggregate_id=source.aggregate_id
          and output.account_id is not distinct from source.account_id
          and $3='NODE'
          and output.actor_type='NODE_BRAIN'
          and output.type='brain.response.completed'
          and output.visibility='PRIVATE_ACCOUNT'
          and output.actor_id=conversation.node_brain_id::text
          and output.correlation_id=source.correlation_id
          and output_body.data_key_id is not null
          and exists (
            select 1
              from events route
              join messages message on message.event_id=output.id
             where route.id=output.causation_id
               and route.causation_id=source.id
               and route.correlation_id=source.correlation_id
               and route.correlation_id=output.correlation_id
               and route.aggregate_id=source.aggregate_id
               and route.account_id is not distinct from source.account_id
               and route.actor_type='NODE_BRAIN'
               and route.actor_id=output.actor_id
               and route.type='node.reply.routed'
               and route.visibility='PRIVATE_ACCOUNT'
               and message.conversation_id=conversation.id
               and message.account_id=conversation.account_id
               and message.role='NODE'
               and message.status='COMPLETED'
          )
     ) as authorized`,
    [job.sourceEventId, outputEventId, job.role],
  );
  return result.authorized;
}

function assertClaimIdentity(
  job: BridgeJobSqlRow,
  workerId: string,
  attemptCount: number,
): void {
  if (
    job.status !== "CLAIMED"
    || job.leaseOwner !== workerId
    || job.attemptCount !== attemptCount
  ) {
    throw new Error("BRIDGE_JOB_CLAIM_INVALID");
  }
}

export async function completeBridgeJob(
  database: EventDatabase,
  input: CompleteBridgeJobInput,
): Promise<BridgeModelJobRow> {
  const jobId = requireUuid(input.jobId, "BRIDGE_JOB_ID_INVALID");
  const outputEventId = requireUuid(input.outputEventId, "BRIDGE_OUTPUT_EVENT_ID_INVALID");
  const workerId = requireWorkerId(input.workerId);
  const attemptCount = requireAttemptCount(input.attemptCount);

  return database.transaction(async (transaction) => {
    await takeClaimLock(transaction);
    const job = await readLockedJob(transaction, jobId);
    if (!job) throw new Error("BRIDGE_JOB_NOT_FOUND");
    if (job.status === "COMPLETED") {
      if (job.outputEventId !== outputEventId || job.attemptCount !== attemptCount) {
        throw new Error("OUTPUT_AUTHORITY_INVALID");
      }
      if (!(await outputIsBoundToJob(transaction, job, outputEventId))) {
        throw new Error("OUTPUT_AUTHORITY_INVALID");
      }
      return mapBridgeJob(job);
    }
    assertClaimIdentity(job, workerId, attemptCount);
    if (!(await outputIsBoundToJob(transaction, job, outputEventId))) {
      throw new Error("OUTPUT_AUTHORITY_INVALID");
    }
    const completed = await transaction.query<BridgeJobSqlRow>(
      `update bridge_model_jobs
          set status='COMPLETED',lease_owner=null,lease_expires_at=null,
              output_event_id=$2,safe_code=null
        where job_id=$1 and status='CLAIMED'
          and lease_owner=$3 and attempt_count=$4
          and lease_expires_at>clock_timestamp()
        returning ${BRIDGE_JOB_SAFE_COLUMNS}`,
      [jobId, outputEventId, workerId, attemptCount],
    );
    if (completed.length !== 1) throw new Error("BRIDGE_JOB_CLAIM_INVALID");
    return mapBridgeJob(completed[0]);
  });
}

export async function failBridgeJob(
  database: EventDatabase,
  input: FailBridgeJobInput,
): Promise<BridgeModelJobRow> {
  const jobId = requireUuid(input.jobId, "BRIDGE_JOB_ID_INVALID");
  const workerId = requireWorkerId(input.workerId);
  const attemptCount = requireAttemptCount(input.attemptCount);
  const safeCode = requireSafeTerminalCode(input.safeCode);

  return database.transaction(async (transaction) => {
    await takeClaimLock(transaction);
    const job = await readLockedJob(transaction, jobId);
    if (!job) throw new Error("BRIDGE_JOB_NOT_FOUND");
    if (job.status === "FAILED") {
      if (job.safeCode !== safeCode || job.attemptCount !== attemptCount) {
        throw new Error("BRIDGE_JOB_TERMINAL_CONFLICT");
      }
      return mapBridgeJob(job);
    }
    assertClaimIdentity(job, workerId, attemptCount);
    const failed = await transaction.query<BridgeJobSqlRow>(
      `update bridge_model_jobs
          set status='FAILED',lease_owner=null,lease_expires_at=null,
              output_event_id=null,safe_code=$2
        where job_id=$1 and status='CLAIMED'
          and lease_owner=$3 and attempt_count=$4
          and lease_expires_at>clock_timestamp()
        returning ${BRIDGE_JOB_SAFE_COLUMNS}`,
      [jobId, safeCode, workerId, attemptCount],
    );
    if (failed.length !== 1) throw new Error("BRIDGE_JOB_CLAIM_INVALID");
    return mapBridgeJob(failed[0]);
  });
}

export interface MainGenerationCycleAuthority {
  readonly cycleId: string;
  readonly scheduleId: string;
  readonly scheduleVersion: number;
  readonly slotAt: Date | string;
  readonly snapshot: unknown;
  readonly currentMainStateVersion: number | string | null;
  readonly policyVersion: string;
  readonly sourceEventId: string;
  readonly sourceRequestHash: string;
  readonly sourceIntegrityHash: string;
}

export interface ValidatedMainGenerationAuthority {
  readonly cycleId: string;
  readonly scheduleId: string;
  readonly scheduleVersion: number;
  readonly slotAt: string;
  readonly snapshot: Readonly<{
    readonly mainStateVersion: number | null;
    readonly policyVersion: typeof BROADCAST_POLICY_VERSION;
    readonly marketData: Readonly<{
      readonly highWaterId: string | null;
      readonly observedAt: string | null;
    }>;
  }>;
  readonly snapshotDigest: string;
  readonly currentMainStateVersion: number | null;
  readonly nextMainStateVersion: number;
  readonly policyVersion: typeof BROADCAST_POLICY_VERSION;
  readonly editorialPolicyVersion: typeof BROADCAST_POLICY_VERSION;
  readonly sourceEventId: string;
  readonly sourceIds: readonly string[];
  readonly sourceRequestHash: string;
  readonly sourceIntegrityHash: string;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function safeMainStateVersion(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === "string" && !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("MAIN_STATE_AUTHORITY_INVALID");
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("MAIN_STATE_AUTHORITY_INVALID");
  }
  return parsed;
}

function nextMainStateVersion(value: number | null): number {
  if (value === null) return 1;
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("MAIN_STATE_AUTHORITY_INVALID");
  }
  return value + 1;
}

function canonicalInstant(value: Date | string, code: string): string {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(code);
  return parsed.toISOString();
}

function exactSnapshot(value: unknown): ValidatedMainGenerationAuthority["snapshot"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MAIN_GENERATION_BODY_INVALID");
  }
  const snapshot = value as Record<string, unknown>;
  if (!exactKeys(snapshot, ["mainStateVersion", "marketData", "policyVersion"])) {
    throw new Error("MAIN_GENERATION_BODY_INVALID");
  }
  if (
    snapshot.mainStateVersion !== null
    && typeof snapshot.mainStateVersion !== "number"
  ) throw new Error("MAIN_GENERATION_BODY_INVALID");
  const current = safeMainStateVersion(
    snapshot.mainStateVersion as number | null,
  );
  const marketData = snapshot.marketData;
  if (!marketData || typeof marketData !== "object" || Array.isArray(marketData)) {
    throw new Error("MAIN_GENERATION_BODY_INVALID");
  }
  const market = marketData as Record<string, unknown>;
  if (
    !exactKeys(market, ["highWaterId", "observedAt"])
    || (market.highWaterId !== null && typeof market.highWaterId !== "string")
    || (market.observedAt !== null && typeof market.observedAt !== "string")
    || (market.highWaterId === null) !== (market.observedAt === null)
    || (typeof market.observedAt === "string"
      && canonicalInstant(market.observedAt, "MAIN_GENERATION_BODY_INVALID") !== market.observedAt)
    || snapshot.policyVersion !== BROADCAST_POLICY_VERSION
  ) throw new Error("MAIN_GENERATION_BODY_INVALID");
  return Object.freeze({
    mainStateVersion: current,
    policyVersion: BROADCAST_POLICY_VERSION,
    marketData: Object.freeze({
      highWaterId: market.highWaterId as string | null,
      observedAt: market.observedAt as string | null,
    }),
  });
}

export function validateMainGenerationAuthority(
  body: JsonValue,
  input: MainGenerationCycleAuthority,
): ValidatedMainGenerationAuthority {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("MAIN_GENERATION_BODY_INVALID");
  }
  const record = body as Record<string, JsonValue>;
  if (!exactKeys(record, ["author", "scheduleId", "scheduleVersion", "slotAt", "snapshot"])) {
    throw new Error("MAIN_GENERATION_BODY_INVALID");
  }
  const author = record.author;
  if (
    !author
    || typeof author !== "object"
    || Array.isArray(author)
    || !exactKeys(author, ["id", "type"])
    || author.type !== "MAIN_BRAIN"
    || author.id !== "gustavo-main"
  ) throw new Error("MAIN_GENERATION_BODY_INVALID");
  const current = safeMainStateVersion(input.currentMainStateVersion);
  const slotAt = canonicalInstant(input.slotAt, "MAIN_GENERATION_BODY_INVALID");
  const snapshot = exactSnapshot(record.snapshot);
  const storedSnapshot = exactSnapshot(input.snapshot);
  if (
    input.policyVersion !== BROADCAST_POLICY_VERSION
    || input.scheduleId !== record.scheduleId
    || input.scheduleVersion !== record.scheduleVersion
    || !Number.isSafeInteger(input.scheduleVersion)
    || input.scheduleVersion < 1
    || record.slotAt !== slotAt
    || snapshot.mainStateVersion !== current
    || !digestsEqual(
      canonicalContentDigest(snapshot),
      canonicalContentDigest(storedSnapshot),
    )
    || !/^[a-f0-9]{64}$/u.test(input.sourceRequestHash)
    || !/^[a-f0-9]{64}$/u.test(input.sourceIntegrityHash)
  ) throw new Error("MAIN_GENERATION_BODY_INVALID");
  const sourceIds = Object.freeze(
    snapshot.marketData.highWaterId === null ? [] : [snapshot.marketData.highWaterId],
  );
  return Object.freeze({
    cycleId: input.cycleId,
    scheduleId: input.scheduleId,
    scheduleVersion: input.scheduleVersion,
    slotAt,
    snapshot,
    snapshotDigest: canonicalContentDigest(snapshot),
    currentMainStateVersion: current,
    nextMainStateVersion: nextMainStateVersion(current),
    policyVersion: BROADCAST_POLICY_VERSION,
    editorialPolicyVersion: BROADCAST_POLICY_VERSION,
    sourceEventId: input.sourceEventId,
    sourceIds,
    sourceRequestHash: input.sourceRequestHash,
    sourceIntegrityHash: input.sourceIntegrityHash,
  });
}

interface MainCycleAuthorityRow extends Record<string, unknown> {
  readonly cycleId: string;
  readonly openEventId: string;
  readonly sourceEventId: string;
  readonly correlationId: string;
  readonly policyVersion: string;
  readonly currentMainStateVersion: number | string | null;
  readonly scheduleId: string;
  readonly scheduleVersion: number;
  readonly slotAt: Date | string;
  readonly snapshot: unknown;
  readonly sourceRequestHash: string;
  readonly sourceIntegrityHash: string;
}

interface EvaluatorAuthorityRow extends MainCycleAuthorityRow {
  readonly candidateEventId: string;
  readonly parentMainJobId: string;
}

interface EvaluatorReplayAuthorityRow extends EvaluatorAuthorityRow {
  readonly broadcastId: string;
  readonly broadcastMainStateVersion: number | string;
  readonly broadcastSourceIds: unknown;
  readonly reviewEventId: string;
}

interface MainReplayAuthorityRow extends MainCycleAuthorityRow {
  readonly candidateEventId: string;
  readonly evaluatorJobId: string;
}

export interface MainCandidateCycleAuthority extends MainGenerationCycleAuthority {
  readonly candidateEventId: string;
}

export interface ValidatedMainCandidateAuthority {
  readonly candidate: string;
  readonly cycleId: string;
  readonly editorialPolicyVersion: typeof BROADCAST_POLICY_VERSION;
  readonly generationEventId: string;
  readonly generationIntegrityHash: string;
  readonly generationRequestHash: string;
  readonly mainStateVersion: number;
  readonly policyVersion: typeof BROADCAST_POLICY_VERSION;
  readonly snapshotDigest: string;
  readonly sourceIds: readonly string[];
}

function generationAuthorityInput(
  authority: MainCycleAuthorityRow,
): MainGenerationCycleAuthority {
  return {
    cycleId: authority.cycleId,
    scheduleId: authority.scheduleId,
    scheduleVersion: authority.scheduleVersion,
    slotAt: authority.slotAt,
    snapshot: authority.snapshot,
    currentMainStateVersion: authority.currentMainStateVersion,
    policyVersion: authority.policyVersion,
    sourceEventId: authority.sourceEventId,
    sourceRequestHash: authority.sourceRequestHash,
    sourceIntegrityHash: authority.sourceIntegrityHash,
  };
}

export function validateMainCandidateAuthority(
  value: JsonValue,
  authority: MainCandidateCycleAuthority,
): ValidatedMainCandidateAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EVALUATOR_CANDIDATE_INVALID");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.join("\u0000") !== [
      "candidate",
      "cycleId",
      "editorialPolicyVersion",
      "generationEventId",
      "generationIntegrityHash",
      "generationRequestHash",
      "mainStateVersion",
      "policyVersion",
      "snapshotDigest",
      "sourceIds",
    ].sort().join("\u0000")
    || value.cycleId !== authority.cycleId
    || authority.policyVersion !== BROADCAST_POLICY_VERSION
    || value.policyVersion !== BROADCAST_POLICY_VERSION
    || value.editorialPolicyVersion !== BROADCAST_POLICY_VERSION
    || value.generationEventId !== authority.sourceEventId
    || value.generationRequestHash !== authority.sourceRequestHash
    || value.generationIntegrityHash !== authority.sourceIntegrityHash
    || typeof value.candidate !== "string"
    || value.candidate.length < 1
    || value.candidate.length > 20_000
    || value.candidate !== value.candidate.trim()
    || !Array.isArray(value.sourceIds)
    || value.sourceIds.some((sourceId) => typeof sourceId !== "string")
  ) throw new Error("EVALUATOR_CANDIDATE_INVALID");
  const expectedCurrent = safeMainStateVersion(authority.currentMainStateVersion);
  const expectedNext = nextMainStateVersion(expectedCurrent);
  const storedSnapshot = exactSnapshot(authority.snapshot);
  const expectedSnapshotDigest = canonicalContentDigest(storedSnapshot);
  const expectedSourceIds = storedSnapshot.marketData.highWaterId === null
    ? [] : [storedSnapshot.marketData.highWaterId];
  if (
    value.mainStateVersion !== expectedNext
    || value.snapshotDigest !== expectedSnapshotDigest
    || canonicalContentDigest(value.sourceIds) !== canonicalContentDigest(expectedSourceIds)
  ) throw new Error("EVALUATOR_CANDIDATE_INVALID");
  return Object.freeze({
    candidate: value.candidate,
    cycleId: authority.cycleId,
    editorialPolicyVersion: BROADCAST_POLICY_VERSION,
    generationEventId: authority.sourceEventId,
    generationIntegrityHash: authority.sourceIntegrityHash,
    generationRequestHash: authority.sourceRequestHash,
    mainStateVersion: value.mainStateVersion,
    policyVersion: BROADCAST_POLICY_VERSION,
    snapshotDigest: expectedSnapshotDigest,
    sourceIds: Object.freeze([...expectedSourceIds]),
  });
}

async function replayCompletedMainCandidate(
  transaction: EventDatabase,
  job: BridgeJobSqlRow,
  input: StageMainCandidateInput,
): Promise<{ readonly candidateEventId: string; readonly evaluatorJobId: string }> {
  if (
    job.role !== "MAIN"
    || job.kind !== "MAIN_GENERATION"
    || job.priority !== 20
    || job.cycleId !== input.cycleId
    || job.candidateEventId !== null
    || job.parentMainJobId !== null
    || job.outputEventId === null
    || job.attemptCount !== input.attemptCount
  ) throw new Error("MAIN_REPLAY_CONFLICT");
  const rows = await transaction.query<MainReplayAuthorityRow>(
    `select cycle.id::text as "cycleId",cycle.open_event_id::text as "openEventId",
            generation.id::text as "sourceEventId",
            generation.correlation_id::text as "correlationId",
            cycle.policy_version as "policyVersion",
            cycle.main_state_version as "currentMainStateVersion",
            cycle.schedule_id as "scheduleId",cycle.schedule_version as "scheduleVersion",
            cycle.slot_at as "slotAt",cycle.snapshot,
            generation.request_hash::text as "sourceRequestHash",
            generation.integrity_hash::text as "sourceIntegrityHash",
            candidate.id::text as "candidateEventId",
            evaluator.job_id::text as "evaluatorJobId"
       from bridge_model_jobs main
       join broadcast_cycles cycle on cycle.id=main.cycle_id
       join events generation on generation.id=cycle.open_event_id
       join encrypted_event_bodies generation_body
         on generation_body.event_id=generation.id
        and generation_body.aggregate_id=generation.aggregate_id
        and generation_body.data_key_id is not null
       join aggregate_data_keys generation_key
         on generation_key.id=generation_body.data_key_id
        and generation_key.aggregate_id=generation.aggregate_id
       join transactional_outbox generation_outbox
         on generation_outbox.event_id=generation.id
        and generation_outbox.topic='main.broadcast.generation.requested'
        and generation_outbox.payload=jsonb_build_object('eventId',generation.id::text)
       join events candidate on candidate.id=main.output_event_id
       join encrypted_event_bodies candidate_body
         on candidate_body.event_id=candidate.id
        and candidate_body.aggregate_id=candidate.aggregate_id
        and candidate_body.data_key_id is not null
       join aggregate_data_keys candidate_key
         on candidate_key.id=candidate_body.data_key_id
        and candidate_key.aggregate_id=candidate.aggregate_id
       join transactional_outbox candidate_outbox
         on candidate_outbox.event_id=candidate.id
        and candidate_outbox.topic='main.broadcast.candidate.generated'
        and candidate_outbox.payload=jsonb_build_object('eventId',candidate.id::text)
       join bridge_model_jobs evaluator
         on evaluator.parent_main_job_id=main.job_id
        and evaluator.cycle_id=cycle.id
        and evaluator.source_event_id=candidate.id
        and evaluator.candidate_event_id=candidate.id
        and evaluator.role='EVALUATOR' and evaluator.kind='EVALUATOR_REVIEW'
        and evaluator.priority=10
      where main.job_id=$1 and main.status='COMPLETED'
        and main.role='MAIN' and main.kind='MAIN_GENERATION' and main.priority=20
        and main.cycle_id=$2 and main.candidate_event_id is null
        and main.parent_main_job_id is null and main.output_event_id=$3
        and main.request_digest=bridge_model_job_request_digest(
          main.source_event_id,main.role,main.kind
        )
        and generation.id=main.source_event_id
        and generation.aggregate_id=cycle.id::text
        and generation.actor_type='MAIN_BRAIN' and generation.actor_id='gustavo-main'
        and generation.type='main.broadcast.generation.requested'
        and generation.visibility='SHARED' and generation.account_id is null
        and generation.policy_version=cycle.policy_version
        and candidate.aggregate_id=cycle.id::text
        and candidate.actor_type='MAIN_BRAIN' and candidate.actor_id='gustavo-main'
        and candidate.type='main.broadcast.candidate.generated'
        and candidate.visibility='SHARED' and candidate.account_id is null
        and candidate.causation_id=generation.id
        and candidate.correlation_id=generation.correlation_id
        and candidate.policy_version=cycle.policy_version
      for share of cycle,generation,generation_outbox,candidate,candidate_outbox,evaluator`,
    [job.jobId, input.cycleId, job.outputEventId],
  );
  if (rows.length !== 1) throw new Error("MAIN_REPLAY_CONFLICT");
  const authority = rows[0];
  validateMainGenerationAuthority(
    await readEventBody(transaction, authority.sourceEventId, { actor: { role: "SYSTEM" } }),
    generationAuthorityInput(authority),
  );
  const candidate = validateMainCandidateAuthority(
    await readEventBody(transaction, authority.candidateEventId, {
      actor: { role: "SYSTEM" },
    }),
    { ...generationAuthorityInput(authority), candidateEventId: authority.candidateEventId },
  );
  if (candidate.candidate !== input.candidate) throw new Error("MAIN_REPLAY_CONFLICT");
  return Object.freeze({
    candidateEventId: authority.candidateEventId,
    evaluatorJobId: authority.evaluatorJobId,
  });
}

export async function stageMainCandidateAndEvaluator(
  database: EventDatabase,
  input: StageMainCandidateInput,
): Promise<{ readonly candidateEventId: string; readonly evaluatorJobId: string }> {
  const jobId = requireUuid(input.jobId, "BRIDGE_JOB_ID_INVALID");
  const cycleId = requireUuid(input.cycleId, "BRIDGE_CYCLE_ID_INVALID");
  const workerId = requireWorkerId(input.workerId);
  const attemptCount = requireAttemptCount(input.attemptCount);
  if (
    typeof input.candidate !== "string"
    || input.candidate.length < 1
    || input.candidate.length > 20_000
    || input.candidate !== input.candidate.trim()
    || input.candidate.includes("\u0000")
  ) throw new Error("MAIN_OUTPUT_INVALID");

  return database.transaction(async (transaction) => {
    await takeClaimLock(transaction);
    const snapshot = await readJobSnapshot(transaction, jobId);
    if (!snapshot) throw new Error("BRIDGE_JOB_NOT_FOUND");
    if (snapshot.status === "COMPLETED") {
      try {
        if (snapshot.outputEventId === null) throw new Error("MAIN_REPLAY_CONFLICT");
        await lockCycleEventBodies(
          transaction,
          cycleId,
          [snapshot.sourceEventId, snapshot.outputEventId],
          "MAIN_REPLAY_CONFLICT",
        );
        const job = await readLockedJob(transaction, jobId);
        if (!job) throw new Error("MAIN_REPLAY_CONFLICT");
        return await replayCompletedMainCandidate(transaction, job, input);
      } catch {
        throw new Error("MAIN_REPLAY_CONFLICT");
      }
    }
    await lockCycleEventBodies(
      transaction,
      cycleId,
      [snapshot.sourceEventId],
      "MAIN_AUTHORITY_REVOKED",
      [`bridge-main-candidate:${jobId}`],
    );
    const job = await readLockedJob(transaction, jobId);
    if (!job) throw new Error("BRIDGE_JOB_NOT_FOUND");
    assertClaimIdentity(job, workerId, attemptCount);
    if (
      job.role !== "MAIN"
      || job.kind !== "MAIN_GENERATION"
      || job.priority !== 20
      || job.cycleId !== cycleId
      || job.candidateEventId !== null
      || job.sourceEventId !== snapshot.sourceEventId
    ) throw new Error("MAIN_AUTHORITY_REVOKED");
    const rows = await transaction.query<MainCycleAuthorityRow>(
      `select cycle.id::text as "cycleId",cycle.open_event_id::text as "openEventId",
              source.id::text as "sourceEventId",
              source.correlation_id::text as "correlationId",
              cycle.policy_version as "policyVersion",
              cycle.main_state_version as "currentMainStateVersion",
              cycle.schedule_id as "scheduleId",
              cycle.schedule_version as "scheduleVersion",
              cycle.slot_at as "slotAt",cycle.snapshot,
              source.request_hash::text as "sourceRequestHash",
              source.integrity_hash::text as "sourceIntegrityHash"
       from bridge_model_jobs job
       join broadcast_cycles cycle on cycle.id=job.cycle_id
       join events source on source.id=cycle.open_event_id
       join encrypted_event_bodies body
         on body.event_id=source.id and body.aggregate_id=source.aggregate_id
        and body.data_key_id is not null
       join aggregate_data_keys data_key
         on data_key.id=body.data_key_id and data_key.aggregate_id=source.aggregate_id
       join transactional_outbox outbox
         on outbox.event_id=source.id
        and outbox.topic='main.broadcast.generation.requested'
        and outbox.payload=jsonb_build_object('eventId',source.id::text)
       where job.job_id=$1 and job.source_event_id=source.id and cycle.id=$2
         and job.status='CLAIMED' and job.lease_owner=$3
         and job.attempt_count=$4 and job.lease_expires_at>clock_timestamp()
         and job.request_digest=bridge_model_job_request_digest(
           job.source_event_id,job.role,job.kind
         )
         and source.aggregate_id=cycle.id::text
         and source.actor_type='MAIN_BRAIN' and source.actor_id='gustavo-main'
         and source.type='main.broadcast.generation.requested'
         and source.visibility='SHARED' and source.account_id is null
         and source.policy_version=cycle.policy_version
       for share of cycle,source,outbox`,
      [jobId, cycleId, workerId, attemptCount],
    );
    if (rows.length !== 1) throw new Error("MAIN_AUTHORITY_REVOKED");
    const authority = rows[0];
    const generation = validateMainGenerationAuthority(
      await readEventBody(transaction, authority.sourceEventId, {
        actor: { role: "SYSTEM" },
      }),
      generationAuthorityInput(authority),
    );
    const candidate = await appendEvent(transaction, {
      aggregateId: cycleId,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.broadcast.candidate.generated",
      visibility: "SHARED",
      body: {
        candidate: input.candidate,
        cycleId,
        editorialPolicyVersion: generation.editorialPolicyVersion,
        generationEventId: generation.sourceEventId,
        generationIntegrityHash: generation.sourceIntegrityHash,
        generationRequestHash: generation.sourceRequestHash,
        mainStateVersion: generation.nextMainStateVersion,
        policyVersion: generation.policyVersion,
        snapshotDigest: generation.snapshotDigest,
        sourceIds: [...generation.sourceIds],
      },
      idempotencyKey: `bridge-main-candidate:${jobId}`,
      causationId: authority.openEventId,
      correlationId: authority.correlationId,
      policyVersion: authority.policyVersion,
    });
    const completed = await transaction.query(
      `update bridge_model_jobs
       set status='COMPLETED',lease_owner=null,lease_expires_at=null,
           output_event_id=$2,safe_code=null
       where job_id=$1 and status='CLAIMED' and lease_owner=$3
         and attempt_count=$4 and lease_expires_at>clock_timestamp()
       returning job_id`,
      [jobId, candidate.id, workerId, attemptCount],
    );
    if (completed.length !== 1) throw new Error("BRIDGE_JOB_CLAIM_INVALID");
    const evaluator = await transaction.one<{ readonly jobId: string }>(
      `insert into bridge_model_jobs (
         source_event_id,cycle_id,candidate_event_id,parent_main_job_id,
         role,kind,priority,request_digest,created_at,updated_at
       ) values (
         $1,$2,$1,$3,'EVALUATOR','EVALUATOR_REVIEW',10,
         bridge_model_job_request_digest($1,'EVALUATOR','EVALUATOR_REVIEW'),
         clock_timestamp(),clock_timestamp()
       ) on conflict (candidate_event_id) where role='EVALUATOR' do update
         set candidate_event_id=excluded.candidate_event_id
       returning job_id::text as "jobId"`,
      [candidate.id, cycleId, jobId],
    );
    return Object.freeze({ candidateEventId: candidate.id, evaluatorJobId: evaluator.jobId });
  });
}

function validateAcceptedReviewBody(
  value: JsonValue,
  input: CommitAcceptedEvaluatorInput,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EVALUATOR_REPLAY_CONFLICT");
  }
  if (
    !exactKeys(value, [
      "candidateEventId",
      "cycleId",
      "decision",
      "rationaleCode",
      "rubricDigest",
      "rubricVersion",
    ])
    || value.candidateEventId !== input.candidateEventId
    || value.cycleId !== input.cycleId
    || value.decision !== input.decision
    || value.rationaleCode !== input.rationaleCode
    || value.rubricVersion !== input.rubricVersion
    || value.rubricDigest !== input.rubricDigest
  ) throw new Error("EVALUATOR_REPLAY_CONFLICT");
}

async function replayCompletedEvaluatorReview(
  transaction: EventDatabase,
  job: BridgeJobSqlRow,
  input: CommitAcceptedEvaluatorInput,
): Promise<{ readonly broadcastId: string; readonly reviewEventId: string }> {
  if (
    job.role !== "EVALUATOR"
    || job.kind !== "EVALUATOR_REVIEW"
    || job.priority !== 10
    || job.cycleId !== input.cycleId
    || job.candidateEventId !== input.candidateEventId
    || job.sourceEventId !== input.candidateEventId
    || job.parentMainJobId === null
    || job.outputEventId === null
    || job.attemptCount !== input.attemptCount
  ) throw new Error("EVALUATOR_REPLAY_CONFLICT");
  const rows = await transaction.query<EvaluatorReplayAuthorityRow>(
    `select cycle.id::text as "cycleId",cycle.open_event_id::text as "openEventId",
            candidate.id::text as "candidateEventId",
            generation.id::text as "sourceEventId",
            candidate.correlation_id::text as "correlationId",
            cycle.policy_version as "policyVersion",
            cycle.main_state_version as "currentMainStateVersion",
            cycle.schedule_id as "scheduleId",cycle.schedule_version as "scheduleVersion",
            cycle.slot_at as "slotAt",cycle.snapshot,
            generation.request_hash::text as "sourceRequestHash",
            generation.integrity_hash::text as "sourceIntegrityHash",
            parent.job_id::text as "parentMainJobId",
            review.id::text as "reviewEventId",broadcast.id::text as "broadcastId",
            broadcast.main_state_version as "broadcastMainStateVersion",
            broadcast.source_ids as "broadcastSourceIds"
       from bridge_model_jobs evaluator
       join bridge_model_jobs parent on parent.job_id=evaluator.parent_main_job_id
       join broadcast_cycles cycle on cycle.id=evaluator.cycle_id
       join events generation on generation.id=cycle.open_event_id
       join events candidate on candidate.id=evaluator.candidate_event_id
       join encrypted_event_bodies candidate_body
         on candidate_body.event_id=candidate.id
        and candidate_body.aggregate_id=candidate.aggregate_id
        and candidate_body.data_key_id is not null
       join aggregate_data_keys candidate_key
         on candidate_key.id=candidate_body.data_key_id
        and candidate_key.aggregate_id=candidate.aggregate_id
       join transactional_outbox candidate_outbox
         on candidate_outbox.event_id=candidate.id
        and candidate_outbox.topic='main.broadcast.candidate.generated'
        and candidate_outbox.payload=jsonb_build_object('eventId',candidate.id::text)
       join events review on review.id=evaluator.output_event_id
       join encrypted_event_bodies review_body
         on review_body.event_id=review.id and review_body.aggregate_id=review.aggregate_id
        and review_body.data_key_id is not null
       join aggregate_data_keys review_key
         on review_key.id=review_body.data_key_id
        and review_key.aggregate_id=review.aggregate_id
       join transactional_outbox review_outbox
         on review_outbox.event_id=review.id
        and review_outbox.topic='main.broadcast.evaluation.completed'
        and review_outbox.payload=jsonb_build_object('eventId',review.id::text)
       join broadcasts broadcast on broadcast.idempotency_key=$4
      where evaluator.job_id=$1 and evaluator.status='COMPLETED'
        and evaluator.cycle_id=$2 and evaluator.candidate_event_id=$3
        and evaluator.source_event_id=candidate.id
        and evaluator.role='EVALUATOR' and evaluator.kind='EVALUATOR_REVIEW'
        and evaluator.priority=10 and evaluator.output_event_id=review.id
        and evaluator.request_digest=bridge_model_job_request_digest(
          evaluator.source_event_id,evaluator.role,evaluator.kind
        )
        and parent.job_id=$5 and parent.role='MAIN' and parent.kind='MAIN_GENERATION'
        and parent.priority=20 and parent.status='COMPLETED'
        and parent.cycle_id=cycle.id and parent.candidate_event_id is null
        and parent.parent_main_job_id is null and parent.output_event_id=candidate.id
        and parent.source_event_id=generation.id
        and parent.request_digest=bridge_model_job_request_digest(
          parent.source_event_id,parent.role,parent.kind
        )
        and candidate.aggregate_id=cycle.id::text
        and candidate.actor_type='MAIN_BRAIN' and candidate.actor_id='gustavo-main'
        and candidate.type='main.broadcast.candidate.generated'
        and candidate.visibility='SHARED' and candidate.account_id is null
        and candidate.causation_id=generation.id
        and candidate.correlation_id=generation.correlation_id
        and candidate.policy_version=cycle.policy_version
        and generation.id=parent.source_event_id
        and generation.aggregate_id=cycle.id::text
        and generation.actor_type='MAIN_BRAIN' and generation.actor_id='gustavo-main'
        and generation.type='main.broadcast.generation.requested'
        and generation.visibility='SHARED' and generation.account_id is null
        and generation.policy_version=cycle.policy_version
        and review.aggregate_id=cycle.id::text
        and review.actor_type='EVALUATOR' and review.actor_id=evaluator.job_id::text
        and review.type='main.broadcast.evaluation.completed'
        and review.visibility='SHARED' and review.account_id is null
        and review.causation_id=candidate.id
        and review.correlation_id=candidate.correlation_id
        and review.policy_version=cycle.policy_version
      for share of parent,cycle,generation,candidate,candidate_outbox,
                   review,review_outbox,broadcast`,
    [
      job.jobId,
      input.cycleId,
      input.candidateEventId,
      `bridge-broadcast:${input.cycleId}`,
      job.parentMainJobId,
    ],
  );
  if (rows.length !== 1) throw new Error("EVALUATOR_REPLAY_CONFLICT");
  const authority = rows[0];
  const candidate = validateMainCandidateAuthority(
    await readEventBody(transaction, input.candidateEventId, { actor: { role: "SYSTEM" } }),
    authority,
  );
  validateAcceptedReviewBody(
    await readEventBody(transaction, authority.reviewEventId, { actor: { role: "SYSTEM" } }),
    input,
  );
  const sourceIds = authority.broadcastSourceIds;
  const expectedSources = [input.cycleId, input.candidateEventId, authority.reviewEventId].sort();
  if (
    safeMainStateVersion(authority.broadcastMainStateVersion) !== candidate.mainStateVersion
    || !Array.isArray(sourceIds)
    || sourceIds.some((sourceId) => typeof sourceId !== "string")
    || canonicalContentDigest(sourceIds) !== canonicalContentDigest(expectedSources)
  ) throw new Error("EVALUATOR_REPLAY_CONFLICT");
  const broadcast = await commitBroadcast({ db: transaction }, {
    mainStateVersion: candidate.mainStateVersion,
    body: candidate.candidate,
    sourceIds: expectedSources,
    idempotencyKey: `bridge-broadcast:${input.cycleId}`,
  });
  if (broadcast.id !== authority.broadcastId) throw new Error("EVALUATOR_REPLAY_CONFLICT");
  return Object.freeze({
    broadcastId: broadcast.id,
    reviewEventId: authority.reviewEventId,
  });
}

export async function commitAcceptedEvaluatorBridgeJob(
  database: EventDatabase,
  input: CommitAcceptedEvaluatorInput,
): Promise<{ readonly broadcastId: string; readonly reviewEventId: string }> {
  const jobId = requireUuid(input.jobId, "BRIDGE_JOB_ID_INVALID");
  const cycleId = requireUuid(input.cycleId, "BRIDGE_CYCLE_ID_INVALID");
  const candidateEventId = requireUuid(
    input.candidateEventId,
    "BRIDGE_CANDIDATE_EVENT_ID_INVALID",
  );
  const workerId = requireWorkerId(input.workerId);
  const attemptCount = requireAttemptCount(input.attemptCount);
  if (
    input.decision !== "ACCEPT"
    || input.rubricVersion !== BROADCAST_EVALUATOR_RUBRIC.version
    || typeof input.rubricDigest !== "string"
    || !digestsEqual(input.rubricDigest, BROADCAST_EVALUATOR_RUBRIC.digest)
    || !Array.isArray(input.rubricCriteria)
    || input.rubricCriteria.some((criterion) => typeof criterion !== "string")
    || canonicalContentDigest(input.rubricCriteria)
      !== canonicalContentDigest(BROADCAST_EVALUATOR_RUBRIC.criteria)
  ) {
    throw new Error("EVALUATOR_RUBRIC_INVALID");
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(input.rationaleCode)) {
    throw new Error("EVALUATOR_OUTPUT_INVALID");
  }

  return database.transaction(async (transaction) => {
    await takeClaimLock(transaction);
    const snapshot = await readJobSnapshot(transaction, jobId);
    if (!snapshot) throw new Error("BRIDGE_JOB_NOT_FOUND");
    if (snapshot.status === "COMPLETED") {
      try {
        if (snapshot.outputEventId === null) throw new Error("EVALUATOR_REPLAY_CONFLICT");
        await lockCycleEventBodies(
          transaction,
          cycleId,
          [candidateEventId, snapshot.outputEventId],
          "EVALUATOR_REPLAY_CONFLICT",
        );
        const job = await readLockedJob(transaction, jobId);
        if (!job) throw new Error("EVALUATOR_REPLAY_CONFLICT");
        return await replayCompletedEvaluatorReview(transaction, job, input);
      } catch {
        throw new Error("EVALUATOR_REPLAY_CONFLICT");
      }
    }
    await lockCycleEventBodies(
      transaction,
      cycleId,
      [candidateEventId],
      "EVALUATOR_AUTHORITY_REVOKED",
      [`bridge-evaluator-review:${jobId}`],
    );
    const job = await readLockedJob(transaction, jobId);
    if (!job) throw new Error("BRIDGE_JOB_NOT_FOUND");
    assertClaimIdentity(job, workerId, attemptCount);
    if (
      job.role !== "EVALUATOR"
      || job.kind !== "EVALUATOR_REVIEW"
      || job.priority !== 10
      || job.cycleId !== cycleId
      || job.candidateEventId !== candidateEventId
      || job.sourceEventId !== candidateEventId
      || job.parentMainJobId === null
      || snapshot.sourceEventId !== candidateEventId
    ) throw new Error("EVALUATOR_AUTHORITY_REVOKED");
    const rows = await transaction.query<EvaluatorAuthorityRow>(
      `select cycle.id::text as "cycleId",cycle.open_event_id::text as "openEventId",
              candidate.id::text as "candidateEventId",
              generation.id::text as "sourceEventId",
              candidate.correlation_id::text as "correlationId",
              cycle.policy_version as "policyVersion",
              cycle.main_state_version as "currentMainStateVersion",
              cycle.schedule_id as "scheduleId",
              cycle.schedule_version as "scheduleVersion",
              cycle.slot_at as "slotAt",cycle.snapshot,
              generation.request_hash::text as "sourceRequestHash",
              generation.integrity_hash::text as "sourceIntegrityHash",
              parent.job_id::text as "parentMainJobId"
       from bridge_model_jobs job
       join bridge_model_jobs parent on parent.job_id=job.parent_main_job_id
       join broadcast_cycles cycle on cycle.id=job.cycle_id
       join events generation on generation.id=cycle.open_event_id
       join events candidate on candidate.id=job.candidate_event_id
       join encrypted_event_bodies body
         on body.event_id=candidate.id and body.aggregate_id=candidate.aggregate_id
        and body.data_key_id is not null
       join aggregate_data_keys data_key
         on data_key.id=body.data_key_id and data_key.aggregate_id=candidate.aggregate_id
       join transactional_outbox outbox
         on outbox.event_id=candidate.id
        and outbox.topic='main.broadcast.candidate.generated'
        and outbox.payload=jsonb_build_object('eventId',candidate.id::text)
       where job.job_id=$1 and cycle.id=$2 and candidate.id=$3
         and job.status='CLAIMED' and job.lease_owner=$4
         and job.attempt_count=$5 and job.lease_expires_at>clock_timestamp()
         and job.request_digest=bridge_model_job_request_digest(
           job.source_event_id,job.role,job.kind
         )
         and parent.role='MAIN' and parent.kind='MAIN_GENERATION' and parent.priority=20
         and parent.status='COMPLETED' and parent.cycle_id=cycle.id
         and parent.candidate_event_id is null and parent.parent_main_job_id is null
         and parent.output_event_id=candidate.id
         and parent.source_event_id=generation.id
         and parent.request_digest=bridge_model_job_request_digest(
           parent.source_event_id,parent.role,parent.kind
         )
         and candidate.aggregate_id=cycle.id::text
         and candidate.actor_type='MAIN_BRAIN' and candidate.actor_id='gustavo-main'
         and candidate.type='main.broadcast.candidate.generated'
         and candidate.visibility='SHARED' and candidate.account_id is null
         and candidate.causation_id=generation.id
         and candidate.correlation_id=generation.correlation_id
         and candidate.policy_version=cycle.policy_version
         and generation.aggregate_id=cycle.id::text
         and generation.actor_type='MAIN_BRAIN' and generation.actor_id='gustavo-main'
         and generation.type='main.broadcast.generation.requested'
         and generation.visibility='SHARED' and generation.account_id is null
         and generation.policy_version=cycle.policy_version
       for share of parent,cycle,generation,candidate,outbox`,
      [jobId, cycleId, candidateEventId, workerId, attemptCount],
    );
    if (rows.length !== 1) throw new Error("EVALUATOR_AUTHORITY_REVOKED");
    const authority = rows[0];
    const body = validateMainCandidateAuthority(
      await readEventBody(transaction, candidateEventId, { actor: { role: "SYSTEM" } }),
      authority,
    );
    const review = await appendEvent(transaction, {
      aggregateId: cycleId,
      actor: { type: "EVALUATOR", id: jobId },
      type: "main.broadcast.evaluation.completed",
      visibility: "SHARED",
      body: {
        candidateEventId,
        cycleId,
        decision: input.decision,
        rationaleCode: input.rationaleCode,
        rubricVersion: input.rubricVersion,
        rubricDigest: input.rubricDigest,
      },
      idempotencyKey: `bridge-evaluator-review:${jobId}`,
      causationId: candidateEventId,
      correlationId: authority.correlationId,
      policyVersion: authority.policyVersion,
    });
    const broadcast = await commitBroadcast({ db: transaction }, {
      mainStateVersion: body.mainStateVersion,
      body: body.candidate,
      sourceIds: [cycleId, candidateEventId, review.id],
      idempotencyKey: `bridge-broadcast:${cycleId}`,
    });
    const completed = await transaction.query(
      `update bridge_model_jobs
       set status='COMPLETED',lease_owner=null,lease_expires_at=null,
           output_event_id=$2,safe_code=null
       where job_id=$1 and status='CLAIMED' and lease_owner=$3
         and attempt_count=$4 and lease_expires_at>clock_timestamp()
       returning job_id`,
      [jobId, review.id, workerId, attemptCount],
    );
    if (completed.length !== 1) throw new Error("BRIDGE_JOB_CLAIM_INVALID");
    return Object.freeze({ broadcastId: broadcast.id, reviewEventId: review.id });
  });
}
