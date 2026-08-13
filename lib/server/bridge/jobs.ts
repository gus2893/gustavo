import type { EventDatabase } from "../events/types";

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

const BRIDGE_CLAIM_LOCK = "gustavo:bridge-model-job-claim:v1";
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Deliberately excludes event bodies, prompts, output text, and ciphertext.
const BRIDGE_JOB_SAFE_COLUMNS = `
  job_id::text as "jobId",
  source_event_id::text as "sourceEventId",
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
