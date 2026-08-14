import type { EventDatabase } from "../events/types";

const HYBRID_COMPONENTS = Object.freeze(["CODEX", "MARKET", "TUNNEL"] as const);
const HYBRID_QUOTAS = Object.freeze(["CODEX_JOBS", "QSTASH_MESSAGES", "FINNHUB_CALLS"] as const);
const HEARTBEAT_SAFE_CODES = new Set([
  "AUTH_REQUIRED",
  "QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "DATABASE_UNAVAILABLE",
  "TUNNEL_UNAVAILABLE",
  "WORKER_OFFLINE",
] as const);
const HEARTBEAT_STATUSES = new Set(["HEALTHY", "DEGRADED", "OFFLINE"] as const);
const HOSTED_STATUSES = new Set(["HEALTHY", "DEGRADED"] as const);

export const HYBRID_HEALTH_POLICY = Object.freeze({
  codexLeaseSeconds: 12 * 60,
  maximumHeartbeatAgeSeconds: 24 * 60 * 60,
  maximumPendingJobs: 10_000,
  maximumQuotaValue: 1_000_000,
  quotaLimits: Object.freeze({
    CODEX_JOBS: 100,
    QSTASH_MESSAGES: 900,
    FINNHUB_CALLS: 27_648,
  }),
});

export type HybridComponent = typeof HYBRID_COMPONENTS[number];
export type HybridQuotaName = typeof HYBRID_QUOTAS[number];
export type HostedHealthStatus = "HEALTHY" | "DEGRADED";
export type LocalHealthStatus = "AVAILABLE" | "DEGRADED" | "OFFLINE" | "UNKNOWN";
export type HeartbeatSafeCode =
  | "AUTH_REQUIRED"
  | "QUOTA_EXHAUSTED"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "DATABASE_UNAVAILABLE"
  | "TUNNEL_UNAVAILABLE"
  | "WORKER_OFFLINE";

export interface HostedHybridHealth {
  readonly database: HostedHealthStatus;
  readonly cache: HostedHealthStatus;
  readonly stream: HostedHealthStatus;
}

export interface HybridHeartbeatInput {
  readonly component: HybridComponent;
  readonly status?: "HEALTHY" | "DEGRADED" | "OFFLINE";
  readonly observedAt?: string | Date;
  readonly safeCode: HeartbeatSafeCode | null;
  readonly ageSeconds?: number | null;
  readonly codexLeaseHealthy?: boolean;
}

export interface HybridQuotaInput {
  readonly name: HybridQuotaName;
  readonly used: number;
  readonly limit: number;
}

export interface HybridHealthInput {
  readonly hosted: HostedHybridHealth;
  readonly heartbeats: readonly HybridHeartbeatInput[];
  readonly quotas: readonly HybridQuotaInput[];
  readonly pendingJobs: number;
  readonly now?: Date;
}

export interface HybridComponentHealth {
  readonly component: HybridComponent;
  readonly status: LocalHealthStatus;
  readonly safeCode: HeartbeatSafeCode | null;
  readonly ageSeconds: number | null;
}

export interface HybridQuotaHealth {
  readonly name: HybridQuotaName;
  readonly used: number;
  readonly limit: number;
  readonly exhausted: boolean;
}

export interface HybridHealthDto {
  readonly schemaVersion: 1;
  readonly hosted: HostedHybridHealth;
  readonly local: {
    readonly codex: LocalHealthStatus;
    readonly market: LocalHealthStatus;
    readonly tunnel: LocalHealthStatus;
  };
  readonly components: readonly HybridComponentHealth[];
  readonly bridge: { readonly pendingJobs: number };
  readonly quotas: readonly HybridQuotaHealth[];
}

function boundedInteger(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function validHosted(input: HostedHybridHealth): HostedHybridHealth {
  if (!HOSTED_STATUSES.has(input.database)
      || !HOSTED_STATUSES.has(input.cache)
      || !HOSTED_STATUSES.has(input.stream)) {
    throw new Error("HYBRID_HEALTH_HOSTED_STATUS_INVALID");
  }
  return Object.freeze({
    database: input.database,
    cache: input.cache,
    stream: input.stream,
  });
}

function validSafeCode(value: HeartbeatSafeCode | null): HeartbeatSafeCode | null {
  return value !== null && !HEARTBEAT_SAFE_CODES.has(value)
    ? null
    : value;
}

function quotaProjection(input: readonly HybridQuotaInput[]): readonly HybridQuotaHealth[] {
  const byName = new Map<HybridQuotaName, HybridQuotaInput>();
  for (const quota of input) {
    if (HYBRID_QUOTAS.includes(quota.name) && !byName.has(quota.name)) byName.set(quota.name, quota);
  }
  return Object.freeze(HYBRID_QUOTAS.map((name) => {
    const source = byName.get(name);
    const policyLimit = HYBRID_HEALTH_POLICY.quotaLimits[name];
    const limit = source === undefined
      ? policyLimit
      : Math.max(1, boundedInteger(source.limit, HYBRID_HEALTH_POLICY.maximumQuotaValue));
    const used = source === undefined
      ? 0
      : Math.min(limit, boundedInteger(source.used, HYBRID_HEALTH_POLICY.maximumQuotaValue));
    return Object.freeze({ name, used, limit, exhausted: used >= limit });
  }));
}

function rawComponentProjection(
  component: HybridComponent,
  heartbeat: HybridHeartbeatInput | undefined,
  nowMilliseconds: number,
): HybridComponentHealth {
  if (heartbeat === undefined) {
    return Object.freeze({
      component,
      status: component === "CODEX" ? "OFFLINE" : "UNKNOWN",
      safeCode: component === "CODEX" ? "WORKER_OFFLINE" : null,
      ageSeconds: null,
    });
  }
  const hasDatabaseAge = heartbeat.ageSeconds !== undefined;
  let future = false;
  let ageSeconds: number | null;
  let codexLeaseExpired = false;
  if (hasDatabaseAge) {
    ageSeconds = heartbeat.ageSeconds === null
      ? null
      : boundedInteger(heartbeat.ageSeconds, HYBRID_HEALTH_POLICY.maximumHeartbeatAgeSeconds);
    codexLeaseExpired = component === "CODEX" && heartbeat.codexLeaseHealthy !== true;
  } else {
    const observedMilliseconds = new Date(heartbeat.observedAt ?? Number.NaN).getTime();
    future = !Number.isFinite(observedMilliseconds) || observedMilliseconds > nowMilliseconds;
    const ageMilliseconds = nowMilliseconds - observedMilliseconds;
    ageSeconds = future
      ? 0
      : boundedInteger(
        ageMilliseconds / 1_000,
        HYBRID_HEALTH_POLICY.maximumHeartbeatAgeSeconds,
      );
    codexLeaseExpired = component === "CODEX" && (heartbeat.codexLeaseHealthy === false
      || (heartbeat.codexLeaseHealthy === undefined
        && ageMilliseconds > HYBRID_HEALTH_POLICY.codexLeaseSeconds * 1_000));
  }
  if (future || codexLeaseExpired) {
    return Object.freeze({ component, status: "OFFLINE", safeCode: "WORKER_OFFLINE", ageSeconds });
  }
  const heartbeatStatus = heartbeat.status ?? (heartbeat.safeCode === null ? "HEALTHY" : "DEGRADED");
  if (!HEARTBEAT_STATUSES.has(heartbeatStatus)) {
    return Object.freeze({ component, status: "UNKNOWN", safeCode: null, ageSeconds });
  }
  const safeCode = validSafeCode(heartbeat.safeCode);
  const status: LocalHealthStatus = heartbeatStatus === "HEALTHY"
    ? "AVAILABLE"
    : heartbeatStatus === "DEGRADED" ? "DEGRADED" : "OFFLINE";
  return Object.freeze({
    component,
    status,
    safeCode: status === "OFFLINE" && safeCode === null ? "WORKER_OFFLINE" : safeCode,
    ageSeconds,
  });
}

export function projectHybridHealth(input: HybridHealthInput): HybridHealthDto {
  const nowMilliseconds = input.now?.getTime() ?? Number.NaN;
  if (input.heartbeats.some(({ ageSeconds }) => ageSeconds === undefined)
      && !Number.isFinite(nowMilliseconds)) {
    throw new Error("HYBRID_HEALTH_CLOCK_INVALID");
  }
  const heartbeatByComponent = new Map<HybridComponent, HybridHeartbeatInput>();
  for (const heartbeat of input.heartbeats) {
    if (HYBRID_COMPONENTS.includes(heartbeat.component)
        && !heartbeatByComponent.has(heartbeat.component)) {
      heartbeatByComponent.set(heartbeat.component, heartbeat);
    }
  }
  const quotas = quotaProjection(input.quotas);
  const codexQuota = quotas.find(({ name }) => name === "CODEX_JOBS")!;
  const components = HYBRID_COMPONENTS.map((component) => rawComponentProjection(
    component,
    heartbeatByComponent.get(component),
    nowMilliseconds,
  ));
  if (codexQuota.limit === HYBRID_HEALTH_POLICY.quotaLimits.CODEX_JOBS
      && codexQuota.exhausted) {
    const codexIndex = components.findIndex(({ component }) => component === "CODEX");
    components[codexIndex] = Object.freeze({
      ...components[codexIndex]!,
      status: "DEGRADED",
      safeCode: "QUOTA_EXHAUSTED",
    });
  }
  const component = (name: HybridComponent) => components.find((item) => item.component === name)!;
  return Object.freeze({
    schemaVersion: 1,
    hosted: validHosted(input.hosted),
    local: Object.freeze({
      codex: component("CODEX").status,
      market: component("MARKET").status,
      tunnel: component("TUNNEL").status,
    }),
    components: Object.freeze(components),
    bridge: Object.freeze({
      pendingJobs: boundedInteger(input.pendingJobs, HYBRID_HEALTH_POLICY.maximumPendingJobs),
    }),
    quotas,
  });
}

interface HybridAuthorityRow extends Record<string, unknown> {
  readonly component: HybridComponent;
  readonly heartbeat_status: "HEALTHY" | "DEGRADED" | "OFFLINE" | null;
  readonly safe_code: HeartbeatSafeCode | null;
  readonly age_seconds: number | null;
  readonly codex_lease_healthy: boolean | null;
  readonly quota_name: HybridQuotaName;
  readonly used: number;
  readonly quota_limit: number;
  readonly pending_jobs: number;
}

export async function collectHybridHealth(
  database: EventDatabase,
  hosted: HostedHybridHealth,
): Promise<HybridHealthDto> {
  const pendingScanLimit = HYBRID_HEALTH_POLICY.maximumPendingJobs + 1;
  const rows = await database.query<HybridAuthorityRow>(
    `with database_clock as materialized (
       select clock_timestamp() observed_now
     ), component_policy(component,ordinal) as (
       values ('CODEX',0),('MARKET',1),('TUNNEL',2)
     ), quota_policy(quota_name,limit_count,ordinal) as (
       values ('CODEX_JOBS',100,0),('QSTASH_MESSAGES',900,1),
              ('FINNHUB_CALLS',27648,2)
     ), bounded_pending as materialized (
       select job_id from (
         (select job_id from bridge_model_jobs
           where status='PENDING'
           order by priority,created_at,job_id
           limit $3)
         union all
         (select job_id from bridge_model_jobs
           where status='CLAIMED'
           order by lease_expires_at,priority,created_at,job_id
           limit $3)
       ) active_jobs
       limit $3
     ), pending_summary as (
       select count(*)::integer pending_jobs from bounded_pending
     ), heartbeat_projection as (
       select component_policy.ordinal,component_policy.component,
              heartbeat.status heartbeat_status,heartbeat.safe_code,
              case when heartbeat.observed_at is null then null else
                least($2::integer,greatest(0,floor(extract(epoch from
                  (database_clock.observed_now-heartbeat.observed_at)))))::integer
              end age_seconds,
              case when component_policy.component='CODEX' then coalesce(
                heartbeat.status='HEALTHY'
                and heartbeat.observed_at between
                  database_clock.observed_now-
                    make_interval(secs => $1::double precision)
                  and database_clock.observed_now,
                false
              ) else null end codex_lease_healthy
         from component_policy
         cross join database_clock
         left join hybrid_worker_heartbeats heartbeat
           on heartbeat.component=component_policy.component
     ), quota_projection as (
       select quota_policy.ordinal,quota_policy.quota_name,
              coalesce(counter.used_count,0)::integer used,
              quota_policy.limit_count::integer quota_limit
         from quota_policy
         cross join database_clock
         left join deployment_quota_counters counter
           on counter.quota_name=quota_policy.quota_name
          and counter.bucket_date=
            (database_clock.observed_now at time zone 'UTC')::date
     )
     select heartbeat_projection.component,
            heartbeat_projection.heartbeat_status,
            heartbeat_projection.safe_code,
            heartbeat_projection.age_seconds,
            heartbeat_projection.codex_lease_healthy,
            quota_projection.quota_name,quota_projection.used,
            quota_projection.quota_limit,pending_summary.pending_jobs
       from heartbeat_projection
       join quota_projection using (ordinal)
       cross join pending_summary
      order by heartbeat_projection.ordinal
      limit 3`,
    [
      HYBRID_HEALTH_POLICY.codexLeaseSeconds,
      HYBRID_HEALTH_POLICY.maximumHeartbeatAgeSeconds,
      pendingScanLimit,
    ],
  );
  if (rows.length !== HYBRID_COMPONENTS.length
      || rows.some((row, index) => row.component !== HYBRID_COMPONENTS[index]
        || row.quota_name !== HYBRID_QUOTAS[index]
        || row.pending_jobs !== rows[0]?.pending_jobs)) {
    throw new Error("HYBRID_HEALTH_DURABLE_STATE_INVALID");
  }
  return projectHybridHealth({
    hosted,
    heartbeats: rows.flatMap((row) => row.heartbeat_status === null ? [] : [{
      component: row.component,
      status: row.heartbeat_status,
      safeCode: row.safe_code,
      ageSeconds: row.age_seconds,
      ...(row.component === "CODEX" && row.codex_lease_healthy !== null
        ? { codexLeaseHealthy: row.codex_lease_healthy }
        : {}),
    }]),
    quotas: rows.map((row) => ({
      name: row.quota_name,
      used: row.used,
      limit: row.quota_limit,
    })),
    pendingJobs: rows[0]!.pending_jobs,
  });
}
