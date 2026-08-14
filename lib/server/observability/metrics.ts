import { cpus, freemem, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  collectHybridHealth,
  type HybridHealthDto,
  type HostedHybridHealth,
} from "../bridge/health";
import type { EventDatabase } from "../events/types";
import {
  authorizeRecall,
  recallAuthorized,
  recallBenchmarkContract,
  type RecallAuthorizationContext,
} from "../recall/planner";

const METRIC_NAMES = Object.freeze([
  "database.commit.latency_ms",
  "queue.age_ms",
  "projection.freshness_ms",
  "cache.access",
  "cache.fallback.latency_ms",
  "cache.invalidation.failure",
  "cache.rebuild.rows_per_second",
  "cache.divergence",
  "model.latency_ms",
  "model.cost_microusd",
  "model.divergence_microusd",
] as const);

export type MetricName = typeof METRIC_NAMES[number];
type Labels = Readonly<Record<string, string>>;

const LABEL_VALUES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  outcome: new Set(["success", "failure"]),
  queue: new Set(["transactional_outbox", "cache_projection", "handoff_refresh", "privacy_rebuild"]),
  projection: new Set(["memory", "cache", "challenge", "handoff"]),
  namespace: new Set(["configuration", "policy", "public-metadata", "main-state", "broadcast",
    "node-dossier", "handoff", "context", "retrieval", "challenge-snapshot", "session", "rate-limit"]),
  result: new Set(["hit", "miss", "filtered", "stale", "evicted", "contended", "diverged", "matched"]),
  mode: new Set(["rebuild", "startup-prewarm"]),
  role: new Set(["MAIN", "NODE", "EVALUATOR"]),
  status: new Set(["IN_PROGRESS", "COMPLETED", "FAILED", "ABORTED", "BUDGET_REJECTED", "TOKEN_REJECTED"]),
});

const METRIC_LABELS: Readonly<Record<MetricName, ReadonlySet<string>>> = Object.freeze({
  "database.commit.latency_ms": new Set(["outcome"]),
  "queue.age_ms": new Set(["queue"]),
  "projection.freshness_ms": new Set(["projection"]),
  "cache.access": new Set(["namespace", "result"]),
  "cache.fallback.latency_ms": new Set(["namespace"]),
  "cache.invalidation.failure": new Set([]),
  "cache.rebuild.rows_per_second": new Set(["mode"]),
  "cache.divergence": new Set(["namespace", "result"]),
  "model.latency_ms": new Set(["role", "status"]),
  "model.cost_microusd": new Set(["role", "status"]),
  "model.divergence_microusd": new Set(["role", "status"]),
});

const MAX_SAMPLES_PER_SERIES = 4_096;
const CACHE_TOPOLOGY_VERSION = "single-main-node-v1";
const INVALIDATION_FAILURE_TOPOLOGY = `${CACHE_TOPOLOGY_VERSION}:invalidation-failure`;

interface Series {
  readonly name: MetricName;
  readonly labels: Labels;
  readonly samples: number[];
  sum: number;
  max: number;
}

export interface MetricSnapshot {
  readonly name: MetricName;
  readonly labels: Labels;
  readonly count: number;
  readonly sum: number;
  readonly max: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface MetricRegistry {
  readonly observe: (name: MetricName, value: number, labels: Labels) => void;
  readonly start: (name: MetricName, labels: Labels) => () => number;
  readonly snapshot: () => readonly MetricSnapshot[];
}

function validateLabels(name: MetricName, labels: Labels): Labels {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error("METRIC_LABEL_INVALID");
  }
  const allowed = METRIC_LABELS[name];
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > allowed.size || entries.some(([key]) => !allowed.has(key))) {
    throw new Error("METRIC_LABEL_INVALID");
  }
  for (const [key, value] of entries) {
    if (typeof value !== "string" || !LABEL_VALUES[key]?.has(value)) {
      throw new Error("METRIC_LABEL_VALUE_INVALID");
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function percentile(samples: readonly number[], quantile: number): number | null {
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) {
    throw new Error("PERCENTILE_QUANTILE_INVALID");
  }
  if (samples.length === 0) return null;
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("PERCENTILE_SAMPLE_INVALID");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]!;
}

export function createMetricRegistry(options: { readonly now?: () => number } = {}): MetricRegistry {
  const now = options.now ?? (() => performance.now());
  const series = new Map<string, Series>();
  const observe = (name: MetricName, value: number, rawLabels: Labels): void => {
    if (!METRIC_NAMES.includes(name) || !Number.isFinite(value) || value < 0) {
      throw new Error("METRIC_OBSERVATION_INVALID");
    }
    const labels = validateLabels(name, rawLabels);
    const key = JSON.stringify([name, labels]);
    let item = series.get(key);
    if (!item) {
      item = { name, labels, samples: [], sum: 0, max: 0 };
      series.set(key, item);
    }
    item.sum += value;
    item.max = Math.max(item.max, value);
    item.samples.push(value);
    if (item.samples.length > MAX_SAMPLES_PER_SERIES) {
      const removed = item.samples.shift()!;
      item.sum -= removed;
      if (removed === item.max) item.max = Math.max(0, ...item.samples);
    }
  };
  return Object.freeze({
    observe,
    start(name: MetricName, labels: Labels) {
      const startedAt = now();
      if (!Number.isFinite(startedAt)) throw new Error("METRIC_CLOCK_INVALID");
      return () => {
        const endedAt = now();
        if (!Number.isFinite(endedAt) || endedAt < startedAt) throw new Error("METRIC_CLOCK_INVALID");
        const duration = endedAt - startedAt;
        observe(name, duration, labels);
        return duration;
      };
    },
    snapshot() {
      return Object.freeze([...series.values()].map((item) => Object.freeze({
        name: item.name,
        labels: item.labels,
        count: item.samples.length,
        sum: item.sum,
        max: item.max,
        p50: percentile(item.samples, 0.5),
        p95: percentile(item.samples, 0.95),
        p99: percentile(item.samples, 0.99),
      })));
    },
  });
}

export const operationalMetrics = createMetricRegistry();

export interface CommitMeasurement {
  readonly outcome: "success" | "failure";
  readonly durationMs: number;
}

export async function measureCommit<Result>(
  work: () => Promise<Result>,
  observed?: (measurement: CommitMeasurement) => void,
): Promise<Result> {
  const startedAt = performance.now();
  try {
    const result = await work();
    const measurement = Object.freeze({
      outcome: "success" as const, durationMs: performance.now() - startedAt,
    });
    operationalMetrics.observe("database.commit.latency_ms", measurement.durationMs,
      { outcome: measurement.outcome });
    observed?.(measurement);
    return result;
  } catch (error) {
    const measurement = Object.freeze({
      outcome: "failure" as const, durationMs: performance.now() - startedAt,
    });
    operationalMetrics.observe("database.commit.latency_ms", measurement.durationMs,
      { outcome: measurement.outcome });
    observed?.(measurement);
    throw error;
  }
}

export interface PerformanceRecallFixture {
  readonly db: EventDatabase;
  readonly accountId: string;
  readonly sourceEventCountFloor: number;
  readonly projectedMemoryCountFloor: number;
  readonly knownAnswerMemoryId: string;
  readonly supersededMemoryId: string;
  readonly foreignMemoryId: string;
  readonly temporalFrom: string;
  readonly temporalTo: string;
  readonly readCachedHandoff: () => Promise<unknown>;
  readonly cleanup: () => Promise<void>;
}

export interface QueryPlanEvidence {
  readonly name: string;
  readonly evidenceSource: "CAPTURED_RECALL_SQL";
  readonly bounded: boolean;
  readonly rootLimited: boolean;
  readonly usesIndex: boolean;
  readonly indexNames: readonly string[];
  readonly unboundedCandidateScans: readonly string[];
  readonly planRows: number;
}

export interface RecallBenchmarkResult {
  readonly sourceEventCount: number;
  readonly projectedMemoryCount: number;
  readonly measuredIterations: number;
  readonly coldRecallMs: number;
  readonly warmRecallP50Ms: number;
  readonly warmRecallP95Ms: number;
  readonly warmRecallP99Ms: number;
  readonly cachedHandoffP50Ms: number;
  readonly cachedHandoffP95Ms: number;
  readonly cachedHandoffP99Ms: number;
  readonly unboundedQueries: number;
  readonly queryPlans: readonly QueryPlanEvidence[];
  readonly correctness: {
    readonly knownAnswerFound: boolean;
    readonly conflictResolvedToCurrent: boolean;
    readonly temporalWindowRespected: boolean;
    readonly permissionLeakCount: number;
  };
  readonly machine: MachineProfile;
}

interface ExplainNode {
  readonly [key: string]: unknown;
}

function explainRoot(value: unknown): ExplainNode {
  const entry = Array.isArray(value) ? value[0] : null;
  const root = entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>).Plan : null;
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("QUERY_PLAN_INVALID");
  return root as ExplainNode;
}

function inspectPlan(name: string, root: ExplainNode): QueryPlanEvidence {
  const indexNames: string[] = [];
  const candidateIndexNames: string[] = [];
  const unboundedCandidateScans: string[] = [];
  const candidateRelations = new Set([
    "memory_records", "memory_index_terms", "memory_embeddings", "memory_vector_buckets",
    "memory_sources", "memory_graph_edges", "memory_equivalence_links",
  ]);
  const rootLimited = root["Node Type"] === "Limit";
  const planRows = typeof root["Plan Rows"] === "number" ? root["Plan Rows"] : Number.POSITIVE_INFINITY;
  const visit = (node: ExplainNode): void => {
    if (typeof node["Index Name"] === "string") indexNames.push(node["Index Name"]);
    const relation = typeof node["Relation Name"] === "string" ? node["Relation Name"] : null;
    const nodeType = typeof node["Node Type"] === "string" ? node["Node Type"] : "unknown";
    const nodeRows = typeof node["Plan Rows"] === "number"
      ? node["Plan Rows"] : Number.POSITIVE_INFINITY;
    if (relation && candidateRelations.has(relation)) {
      if (typeof node["Index Name"] === "string") candidateIndexNames.push(node["Index Name"]);
      if (nodeType.includes("Seq Scan") && nodeRows > 200) {
        unboundedCandidateScans.push(`${relation}:${nodeType}:${nodeRows}`);
      }
    }
    if (Array.isArray(node.Plans)) {
      for (const child of node.Plans) if (child && typeof child === "object" && !Array.isArray(child)) {
        visit(child as ExplainNode);
      }
    }
  };
  visit(root);
  const bounded = rootLimited && planRows <= 20 && unboundedCandidateScans.length === 0;
  return Object.freeze({ name, evidenceSource: "CAPTURED_RECALL_SQL" as const,
    bounded, rootLimited, usesIndex: candidateIndexNames.length > 0,
    indexNames: Object.freeze([...new Set(indexNames)].sort()),
    unboundedCandidateScans: Object.freeze([...unboundedCandidateScans].sort()), planRows });
}

interface CapturedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

async function queryPlanEvidence(
  db: EventDatabase,
  statements: readonly CapturedQuery[],
): Promise<readonly QueryPlanEvidence[]> {
  const representative = new Map<string, CapturedQuery>();
  for (const statement of statements) {
    const match = /\/\* recall-channel:([A-Z_]+) \*\//u.exec(statement.sql);
    if (match?.[1] && !representative.has(match[1])) representative.set(match[1], statement);
  }
  if (representative.size === 0) throw new Error("RECALL_QUERY_PLAN_EVIDENCE_MISSING");
  return db.transaction(async (transaction) => Object.freeze(await Promise.all(
    [...representative.entries()].map(async ([name, statement]) => {
      const explained = await transaction.one<Record<string, unknown>>(
        `explain (format json) ${statement.sql}`,
        statement.parameters,
      );
      return inspectPlan(name, explainRoot(explained["QUERY PLAN"]));
    }),
  )));
}

function observingDatabase(db: EventDatabase, statements: CapturedQuery[]): EventDatabase {
  const remember = (sql: string, parameters: readonly unknown[] = []): void => {
    statements.push(Object.freeze({ sql, parameters: Object.freeze([...parameters]) }));
  };
  return Object.freeze({
    query: async <Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) => {
      remember(sql, parameters);
      return db.query<Row>(sql, parameters);
    },
    one: async <Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) => {
      remember(sql, parameters);
      return db.one<Row>(sql, parameters);
    },
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      db.transaction((transaction) => work(observingDatabase(transaction, statements)))
    ),
  });
}

function recallInput(fixture: PerformanceRecallFixture, sequence: number) {
  return Object.freeze({
    query: "benchmark known-answer current policy",
    entities: ["PERF_ENTITY"],
    from: fixture.temporalFrom,
    to: fixture.temporalTo,
    maxMemories: 8,
    tokenBudget: 1_500,
    graphDepth: 2,
    responseId: randomUUID(),
    idempotencyKey: `performance-recall:${sequence}:${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    policyVersion: "performance-policy-v1",
    modelVersion: "excluded-from-benchmark",
    plannerVersion: "performance-planner-v1",
  });
}

export async function benchmarkRecall(input: {
  readonly fixture: PerformanceRecallFixture;
  readonly iterations?: number;
  readonly warmup?: number;
  readonly excludeModelGeneration: true;
}): Promise<RecallBenchmarkResult> {
  const iterations = input.iterations ?? 200;
  const warmup = input.warmup ?? 20;
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000
      || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 200
      || input.excludeModelGeneration !== true) {
    throw new Error("RECALL_BENCHMARK_INPUT_INVALID");
  }
  const contract = recallBenchmarkContract();
  if (contract.maximumCandidateQueries !== 9 || contract.maximumCandidatesPerQuery !== 20) {
    throw new Error("RECALL_BENCHMARK_CONTRACT_CHANGED");
  }
  const statements: CapturedQuery[] = [];
  const observedDb = observingDatabase(input.fixture.db, statements);
  const observedContext = await authorizeRecall(
    observedDb, { role: "ACCOUNT", accountId: input.fixture.accountId },
  );
  const context = await authorizeRecall(
    input.fixture.db, { role: "ACCOUNT", accountId: input.fixture.accountId },
  );
  let sequence = 0;
  const runRecall = async (authorized: RecallAuthorizationContext = context) => {
    const startedAt = performance.now();
    const result = await recallAuthorized(authorized, recallInput(input.fixture, sequence++));
    return Object.freeze({ result, duration: performance.now() - startedAt });
  };
  // Capture one exact cold execution for plan evidence. Keep the warm timing path
  // identical to production instead of charging benchmark-only SQL recording to it.
  const cold = await runRecall(observedContext);
  for (let index = 0; index < warmup; index += 1) await runRecall();
  const warmDurations: number[] = [];
  let finalResult = cold.result;
  for (let index = 0; index < iterations; index += 1) {
    const measured = await runRecall();
    warmDurations.push(measured.duration);
    finalResult = measured.result;
  }
  const handoffDurations: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const handoff = await input.fixture.readCachedHandoff();
    const duration = performance.now() - startedAt;
    if (handoff === null || handoff === undefined) throw new Error("CACHED_HANDOFF_MISSING");
    handoffDurations.push(duration);
  }
  const count = await input.fixture.db.one<{ count: string } & Record<string, unknown>>(
    "select count(*)::text count from events",
  );
  const sourceEventCount = Number(count.count);
  if (!Number.isSafeInteger(sourceEventCount)
      || sourceEventCount < input.fixture.sourceEventCountFloor) {
    throw new Error("RECALL_FIXTURE_SOURCE_COUNT_INVALID");
  }
  const projected = await input.fixture.db.one<{ count: string } & Record<string, unknown>>(
    "select count(*)::text count from memory_records",
  );
  const projectedMemoryCount = Number(projected.count);
  if (!Number.isSafeInteger(projectedMemoryCount)
      || projectedMemoryCount < input.fixture.projectedMemoryCountFloor) {
    throw new Error("RECALL_FIXTURE_PROJECTED_COUNT_INVALID");
  }
  const selected = new Set(finalResult.memories.map(({ id }) => id));
  const knownAnswer = finalResult.memories.find(({ id }) => id === input.fixture.knownAnswerMemoryId);
  const superseded = finalResult.memories.find(({ id }) => id === input.fixture.supersededMemoryId);
  const knownAnswerIndex = finalResult.memories.findIndex(({ id }) => (
    id === input.fixture.knownAnswerMemoryId
  ));
  const supersededIndex = finalResult.memories.findIndex(({ id }) => (
    id === input.fixture.supersededMemoryId
  ));
  const permissionLeakCount = finalResult.memories.filter(({ id }) => (
    id === input.fixture.foreignMemoryId
  )).length;
  const unboundedQueries = statements.filter(({ sql }) => (
    sql.includes("/* recall-channel:") && !/\blimit\b/iu.test(sql)
  )).length;
  return Object.freeze({
    sourceEventCount,
    projectedMemoryCount,
    measuredIterations: iterations,
    coldRecallMs: cold.duration,
    warmRecallP50Ms: percentile(warmDurations, 0.5)!,
    warmRecallP95Ms: percentile(warmDurations, 0.95)!,
    warmRecallP99Ms: percentile(warmDurations, 0.99)!,
    cachedHandoffP50Ms: percentile(handoffDurations, 0.5)!,
    cachedHandoffP95Ms: percentile(handoffDurations, 0.95)!,
    cachedHandoffP99Ms: percentile(handoffDurations, 0.99)!,
    unboundedQueries,
    queryPlans: await queryPlanEvidence(input.fixture.db, statements),
    correctness: Object.freeze({
      knownAnswerFound: selected.has(input.fixture.knownAnswerMemoryId),
      conflictResolvedToCurrent: knownAnswer?.current === true
        && (superseded === undefined || (superseded.current === false
          && superseded.conflictState === "SUPERSEDED" && knownAnswerIndex < supersededIndex)),
      temporalWindowRespected: knownAnswer?.channels.includes("TIME") === true
        && superseded?.channels.includes("TIME") !== true,
      permissionLeakCount,
    }),
    machine: await machineProfile(input.fixture.db),
  });
}

export interface MachineProfile {
  readonly node: string;
  readonly postgres: string;
  readonly platform: string;
  readonly release: string;
  readonly cpuModel: string;
  readonly logicalCpuCount: number;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
}

async function machineProfile(db: EventDatabase): Promise<MachineProfile> {
  const version = await db.one<{ server_version: string } & Record<string, unknown>>(
    "select current_setting('server_version') server_version",
  );
  const processors = cpus();
  return Object.freeze({
    node: process.version,
    postgres: version.server_version,
    platform: platform(),
    release: release(),
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  });
}

export interface OperatorHealth {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly machine: MachineProfile;
  readonly databaseCommit: readonly MetricSnapshot[];
  readonly recall: {
    readonly sampleCount: number;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly p99Ms: number | null;
  };
  readonly queue: { readonly ageMs: number };
  readonly projections: { readonly freshnessMs: number | null };
  readonly cache: readonly Record<string, unknown>[];
  readonly cacheFallback: {
    readonly sampleCount: number;
    readonly averageLatencyMs: number | null;
    readonly maxLatencyMs: number | null;
  };
  readonly cacheInvalidation: { readonly failureCount: number };
  readonly cacheDivergence: { readonly mismatches: number | null };
  readonly rebuild: { readonly rowsPerSecond: number | null };
  readonly models: readonly Record<string, unknown>[];
}

export interface OperatorHealthResponse extends OperatorHealth {
  readonly hybrid: HybridHealthDto;
}

interface CommitBucketRow extends Record<string, unknown> {
  readonly outcome: "success" | "failure";
  readonly latency_bucket_ms: number;
  readonly sample_count: string;
  readonly value_sum: number;
  readonly value_max: number;
}

function commitMetricSnapshots(rows: readonly CommitBucketRow[]): readonly MetricSnapshot[] {
  return Object.freeze(["success", "failure"].flatMap((outcome) => {
    const buckets = rows.filter((row) => row.outcome === outcome)
      .sort((left, right) => left.latency_bucket_ms - right.latency_bucket_ms);
    if (buckets.length === 0) return [];
    const count = buckets.reduce((sum, row) => sum + Math.max(0, Number(row.sample_count) || 0), 0);
    if (count === 0) return [];
    const quantile = (value: number): number => {
      const threshold = Math.ceil(count * value);
      let cumulative = 0;
      for (const row of buckets) {
        cumulative += Math.max(0, Number(row.sample_count) || 0);
        if (cumulative >= threshold) return Math.max(0, Number(row.latency_bucket_ms));
      }
      return Math.max(0, Number(buckets.at(-1)!.latency_bucket_ms));
    };
    return [Object.freeze({
      name: "database.commit.latency_ms" as const,
      labels: Object.freeze({ outcome }),
      count,
      sum: buckets.reduce((sum, row) => sum + Math.max(0, Number(row.value_sum) || 0), 0),
      max: buckets.reduce((maximum, row) => Math.max(maximum, Number(row.value_max) || 0), 0),
      p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99),
    })];
  }));
}

export async function collectOperatorHealth(db: EventDatabase): Promise<OperatorHealth> {
  const [queueRows, projectionRows, cache, cacheDivergence, rebuildRows,
    recall, models, commits, machine] = await Promise.all([
    db.query<{ age_ms: number } & Record<string, unknown>>(
      `select greatest(extract(epoch from (clock_timestamp()-created_at))*1000,0)::float8 age_ms
       from transactional_outbox where status in ('PENDING','FAILED')
       order by created_at,id limit 1`,
    ),
    db.query<{ freshness_ms: number } & Record<string, unknown>>(
      `select greatest(extract(epoch from (clock_timestamp()-updated_at))*1000,0)::float8 freshness_ms
       from memory_projection_checkpoints
       order by updated_at desc,projection_key desc limit 1`,
    ),
    db.query<Record<string, unknown>>(
      `select name,category,topology_version,sum(sample_count)::text sample_count,
              (sum(value_sum)/sum(sample_count))::float8 average_value,max(value_max) value_max
       from cache_metric_observations
       where observed_at>=clock_timestamp()-interval '24 hours'
       group by name,category,topology_version order by name,category nulls first limit 100`,
    ),
    db.one<{ mismatches: string | null } & Record<string, unknown>>(
      `with latest as (
         select id from cache_rebuild_runs where status='VERIFIED' and completed_at is not null
         order by completed_at desc,id desc limit 1
       ) select case when count(*)=0 then null else count(*) filter (
              where category.record_count<>category.high_water_count
                 or category.manifest_hash<>category.high_water_hash
            )::text end mismatches
         from latest join cache_rebuild_category_checks category on category.run_id=latest.id`,
    ),
    db.query<{ rows_per_second: number | null } & Record<string, unknown>>(
      `select (record_count/nullif(extract(epoch from (completed_at-started_at)),0))::float8 rows_per_second
       from cache_rebuild_runs where status='VERIFIED' and completed_at is not null
       order by completed_at desc,id desc limit 1`,
    ),
    db.one<{
      sample_count: string; p50_ms: number | null; p95_ms: number | null; p99_ms: number | null;
    } & Record<string, unknown>>(
      `with samples as (
         select latency_ms from recall_traces
         where created_at>=clock_timestamp()-interval '24 hours'
         order by created_at desc,id desc limit 10000
       ) select count(*)::text sample_count,
              percentile_cont(0.5) within group (order by latency_ms)::float8 p50_ms,
              percentile_cont(0.95) within group (order by latency_ms)::float8 p95_ms,
              percentile_cont(0.99) within group (order by latency_ms)::float8 p99_ms
       from samples`,
    ),
    db.query<Record<string, unknown>>(
      `with samples as (
         select role,completion_status,latency_ms,estimated_cost_microusd,
                provider_reported_cost_microusd
         from model_runs where started_at>=clock_timestamp()-interval '24 hours'
         order by started_at desc,id desc limit 10000
       ) select role,completion_status,count(*)::text sample_count,
              sum(estimated_cost_microusd)::text estimated_cost_microusd,
              sum(abs(coalesce(provider_reported_cost_microusd,estimated_cost_microusd)
                -estimated_cost_microusd))::text divergence_microusd,
              percentile_cont(0.5) within group (order by latency_ms)::float8 p50_ms,
              percentile_cont(0.95) within group (order by latency_ms)::float8 p95_ms,
              percentile_cont(0.99) within group (order by latency_ms)::float8 p99_ms
       from samples
       group by role,completion_status order by role,completion_status limit 36`,
    ),
    db.query<CommitBucketRow>(
      `select outcome,latency_bucket_ms,sum(sample_count)::text sample_count,
              sum(value_sum)::float8 value_sum,max(value_max)::float8 value_max
       from database_commit_metric_buckets
       where bucket_start>=date_trunc('minute',clock_timestamp()-interval '24 hours')
       group by outcome,latency_bucket_ms order by outcome,latency_bucket_ms limit 30`,
    ),
    machineProfile(db),
  ]);
  const queue = queueRows[0];
  const projection = projectionRows[0];
  const rebuild = rebuildRows[0];
  const durableCacheRow = (name: string, topologyVersion: string) => cache.find((row) => (
    row.name === name && row.topology_version === topologyVersion && row.category === null
  ));
  const fallback = durableCacheRow("cache.fallback", CACHE_TOPOLOGY_VERSION);
  const invalidation = durableCacheRow("cache.backend_failure", INVALIDATION_FAILURE_TOPOLOGY);
  const fallbackSampleCount = Math.max(0, Number(fallback?.sample_count) || 0);
  return Object.freeze({
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    machine,
    databaseCommit: commitMetricSnapshots(commits),
    recall: Object.freeze({
      sampleCount: Math.max(0, Number(recall.sample_count) || 0),
      p50Ms: recall.p50_ms === null ? null : Math.max(0, Number(recall.p50_ms)),
      p95Ms: recall.p95_ms === null ? null : Math.max(0, Number(recall.p95_ms)),
      p99Ms: recall.p99_ms === null ? null : Math.max(0, Number(recall.p99_ms)),
    }),
    queue: Object.freeze({ ageMs: Math.max(0, Number(queue?.age_ms) || 0) }),
    projections: Object.freeze({
      freshnessMs: projection === undefined || projection.freshness_ms === null
        ? null : Math.max(0, Number(projection.freshness_ms)),
    }),
    cache: Object.freeze(cache.map((row) => Object.freeze({ ...row }))),
    cacheFallback: Object.freeze({
      sampleCount: fallbackSampleCount,
      averageLatencyMs: fallbackSampleCount === 0
        ? null : Math.max(0, Number(fallback?.average_value) || 0),
      maxLatencyMs: fallbackSampleCount === 0
        ? null : Math.max(0, Number(fallback?.value_max) || 0),
    }),
    cacheInvalidation: Object.freeze({
      failureCount: Math.max(0, Number(invalidation?.sample_count) || 0),
    }),
    cacheDivergence: Object.freeze({
      mismatches: cacheDivergence.mismatches === null
        ? null : Math.max(0, Number(cacheDivergence.mismatches) || 0),
    }),
    rebuild: Object.freeze({
      rowsPerSecond: rebuild === undefined || rebuild.rows_per_second === null
        ? null : Math.max(0, Number(rebuild.rows_per_second)),
    }),
    models: Object.freeze(models.map((row) => Object.freeze({ ...row }))),
  });
}

function hostedHybridHealth(health: OperatorHealth): HostedHybridHealth {
  const cacheDegraded = health.cacheInvalidation.failureCount > 0
    || (health.cacheDivergence.mismatches !== null && health.cacheDivergence.mismatches > 0);
  return Object.freeze({
    database: "HEALTHY",
    cache: cacheDegraded ? "DEGRADED" : "HEALTHY",
    stream: "HEALTHY",
  });
}

export async function collectOperatorHealthResponse(
  database: EventDatabase,
): Promise<OperatorHealthResponse> {
  const performanceHealth = await collectOperatorHealth(database);
  const hybrid = await collectHybridHealth(database, hostedHybridHealth(performanceHealth));
  return Object.freeze({ ...performanceHealth, hybrid });
}
