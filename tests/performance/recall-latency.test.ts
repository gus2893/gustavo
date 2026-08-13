import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { EventDatabase } from "../../lib/server/events/types";
import { databaseFromPool } from "../../lib/server/db/postgres";
import { scopedCache, type CacheMetricSnapshot } from "../../lib/server/cache/store";
import { createModelGateway } from "../../lib/server/models/gateway";
import { fakeModelProvider } from "../../lib/server/models/fake";
import {
  benchmarkRecall,
  collectOperatorHealth,
  createMetricRegistry,
  operationalMetrics,
  percentile,
} from "../../lib/server/observability/metrics";
import { createOperatorHealthHandler } from "../../app/api/operator/health/route";
import { seedMillionMemoryFixture } from "./seed-million";
import { testContext } from "../helpers/postgres";

const RUN_MILLION = process.env.GUSTAVO_RUN_MILLION_BENCHMARK === "1";

describe("performance measurement primitives", () => {
  it("uses nearest-rank percentiles and a monotonic timer", () => {
    expect(percentile([100, 1, 20, 5], 0.5)).toBe(5);
    expect(percentile([100, 1, 20, 5], 0.95)).toBe(100);
    expect(percentile([], 0.95)).toBeNull();

    const ticks = [10, 14.25];
    const registry = createMetricRegistry({ now: () => ticks.shift()! });
    const finish = registry.start("database.commit.latency_ms", { outcome: "success" });
    finish();
    expect(registry.snapshot()).toContainEqual(expect.objectContaining({
      name: "database.commit.latency_ms",
      labels: { outcome: "success" },
      count: 1,
      p95: 4.25,
    }));
  });

  it("keeps registry count, sum, and max consistent with its bounded sample window", () => {
    const registry = createMetricRegistry();
    registry.observe("queue.age_ms", 10_000, { queue: "transactional_outbox" });
    for (let index = 0; index < 4_096; index += 1) {
      registry.observe("queue.age_ms", 1, { queue: "transactional_outbox" });
    }
    expect(registry.snapshot()[0]).toMatchObject({ count: 4_096, sum: 4_096, max: 1 });
  });

  it("bounds metric names and labels without accepting identifiers or protected values", () => {
    const registry = createMetricRegistry();
    registry.observe("queue.age_ms", 12, { queue: "transactional_outbox" });
    registry.observe("cache.fallback.latency_ms", 7, { namespace: "handoff" });
    registry.observe("model.cost_microusd", 42, { role: "NODE", status: "COMPLETED" });
    expect(() => registry.observe("queue.age_ms", 1, { accountId: crypto.randomUUID() } as never))
      .toThrow("METRIC_LABEL_INVALID");
    expect(() => registry.observe("cache.fallback.latency_ms", 1, {
      namespace: "private text: the user prefers AAPL",
    })).toThrow("METRIC_LABEL_VALUE_INVALID");
    expect(JSON.stringify(registry.snapshot())).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/iu);
  });

  it("instruments the actual PostgreSQL transaction commit boundary", async () => {
    const commands: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        commands.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const durableWrites: readonly unknown[][] = [];
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (_sql: string, parameters: readonly unknown[]) => {
        (durableWrites as unknown[][]).push([...parameters]);
        return { rows: [] };
      }),
    } as unknown as Pool;
    const before = createMetricCount("database.commit.latency_ms");
    await databaseFromPool(pool).transaction(async (transaction) => {
      await transaction.query("select 1");
    });
    expect(commands).toEqual(["begin", "select 1", "commit"]);
    expect(createMetricCount("database.commit.latency_ms")).toBe(before + 1);
    expect(durableWrites).toContainEqual(expect.arrayContaining(["success"]));
  });

  it("persists production cache hit, miss, fallback, and failure deltas", async () => {
    const runtime = await import("../../lib/server/cache/runtime") as unknown as {
      recordPostgresCacheRuntimeDeltas?: (
        db: EventDatabase, before: CacheMetricSnapshot, after: CacheMetricSnapshot,
      ) => Promise<void>;
      recordPostgresCacheQueueAge?: (db: EventDatabase, milliseconds: number) => Promise<void>;
    };
    expect(typeof runtime.recordPostgresCacheRuntimeDeltas).toBe("function");
    if (!runtime.recordPostgresCacheRuntimeDeltas) return;
    const calls: MetricWrite[] = [];
    const db = metricCaptureDatabase(calls);
    const cache = scopedCache();
    const before = cache.metrics();
    const fallbackBefore = createMetricCount("cache.fallback.latency_ms");
    const invalidationBefore = createMetricCount("cache.invalidation.failure");
    const queueBefore = createMetricCount("queue.age_ms");
    const after: CacheMetricSnapshot = Object.freeze({
      ...before,
      hits: before.hits + 3,
      misses: before.misses + 2,
      fallbacks: before.fallbacks + 1,
      invalidationFailures: before.invalidationFailures + 1,
      backendFailures: before.backendFailures + 1,
      fallbackLatencyMs: Object.freeze({ count: 1, total: 12, max: 12 }),
      fallbackLatencySequence: 1,
      fallbackLatencyWindow: Object.freeze([{ sequence: 1, value: 12 }]),
      byNamespace: Object.freeze({ handoff: Object.freeze({ hits: 3, misses: 2 }) }),
    });
    await runtime.recordPostgresCacheRuntimeDeltas(db, before, after);
    expect(calls.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "cache.hit", "cache.miss", "cache.fallback", "cache.backend_failure",
    ]));
    expect(createMetricCount("cache.fallback.latency_ms")).toBe(fallbackBefore + 1);
    expect(createMetricCount("cache.invalidation.failure")).toBe(invalidationBefore + 1);
    expect(operationalMetrics.snapshot()).toContainEqual(expect.objectContaining({
      name: "cache.access", labels: { namespace: "handoff", result: "hit" },
    }));
    expect(typeof runtime.recordPostgresCacheQueueAge).toBe("function");
    await runtime.recordPostgresCacheQueueAge?.(db, 9);
    expect(createMetricCount("queue.age_ms")).toBe(queueBefore + 1);
    cache.destroy();
  });

  it("persists fallback latency as a durable bounded aggregate", async () => {
    const { recordPostgresCacheRuntimeDeltas } = await import("../../lib/server/cache/runtime");
    const calls: MetricWrite[] = [];
    const before = emptyCacheSnapshot();
    await recordPostgresCacheRuntimeDeltas(metricCaptureDatabase(calls), before, Object.freeze({
      ...before,
      fallbacks: 2,
      fallbackLatencyMs: Object.freeze({ count: 2, total: 18, max: 11 }),
      fallbackLatencySequence: 2,
      fallbackLatencyWindow: Object.freeze([
        { sequence: 1, value: 7 }, { sequence: 2, value: 11 },
      ]),
    }));
    expect(calls).toContainEqual(expect.objectContaining({
      name: "cache.fallback", sampleCount: 2, valueSum: 18, valueMax: 11,
    }));
    const { db } = await testContext();
    await recordPostgresCacheRuntimeDeltas(db, before, Object.freeze({
      ...before,
      fallbacks: 2,
      fallbackLatencyMs: Object.freeze({ count: 2, total: 18, max: 11 }),
      fallbackLatencySequence: 2,
      fallbackLatencyWindow: Object.freeze([
        { sequence: 1, value: 7 }, { sequence: 2, value: 11 },
      ]),
    }));
    expect(await db.one(
      `select sample_count::int sample_count,value_sum,value_max
       from cache_metric_observations where name='cache.fallback'
         and topology_version='single-main-node-v1'`,
    )).toMatchObject({ sample_count: 2, value_sum: 18, value_max: 11 });
  });

  it("persists the exact fallback batch maximum after a larger historical sample", async () => {
    const { recordPostgresCacheRuntimeDeltas } = await import("../../lib/server/cache/runtime");
    const calls: MetricWrite[] = [];
    const before = Object.freeze({
      ...emptyCacheSnapshot(),
      fallbacks: 1,
      fallbackLatencyMs: Object.freeze({ count: 1, total: 100, max: 100 }),
      fallbackLatencySequence: 1,
      fallbackLatencyWindow: Object.freeze([{ sequence: 1, value: 100 }]),
    }) as CacheMetricSnapshot;
    const after = Object.freeze({
      ...before,
      fallbacks: 3,
      fallbackLatencyMs: Object.freeze({ count: 3, total: 118, max: 100 }),
      fallbackLatencySequence: 3,
      fallbackLatencyWindow: Object.freeze([
        { sequence: 1, value: 100 }, { sequence: 2, value: 7 }, { sequence: 3, value: 11 },
      ]),
    }) as CacheMetricSnapshot;
    await recordPostgresCacheRuntimeDeltas(metricCaptureDatabase(calls), before, after);
    expect(calls).toContainEqual(expect.objectContaining({
      name: "cache.fallback", sampleCount: 2, valueSum: 18, valueMax: 11,
    }));
  });

  it("persists invalidation failures as a distinguishable durable count", async () => {
    const { recordPostgresCacheRuntimeDeltas } = await import("../../lib/server/cache/runtime");
    const calls: MetricWrite[] = [];
    const before = emptyCacheSnapshot();
    await recordPostgresCacheRuntimeDeltas(metricCaptureDatabase(calls), before, Object.freeze({
      ...before,
      invalidationFailures: 3,
    }));
    expect(calls).toContainEqual(expect.objectContaining({
      name: "cache.backend_failure", sampleCount: 3,
      topologyVersion: "single-main-node-v1:invalidation-failure",
    }));
    const { db } = await testContext();
    await recordPostgresCacheRuntimeDeltas(db, before, Object.freeze({
      ...before,
      invalidationFailures: 3,
    }));
    expect(await db.one(
      `select sample_count::int sample_count from cache_metric_observations
       where name='cache.backend_failure'
         and topology_version='single-main-node-v1:invalidation-failure'`,
    )).toMatchObject({ sample_count: 3 });
  });

  it("observes model latency, cost, and provider divergence after durable finalization", async () => {
    const { db } = await testContext();
    const provider = fakeModelProvider({ response: "measured response", delayMs: 2 });
    const gateway = createModelGateway(db, provider, {
      monthlyBudgetUsd: "10.00", maxInputTokens: 100, maxOutputTokens: 10,
      clock: (() => {
        let time = Date.parse("2026-08-12T12:00:00.000Z");
        return () => new Date(time += 5);
      })(),
    });
    const beforeLatency = createMetricCount("model.latency_ms");
    const beforeCost = createMetricCount("model.cost_microusd");
    const beforeDivergence = createMetricCount("model.divergence_microusd");
    await gateway.generate({
      role: "NODE", promptVersion: "performance-prompt-v1",
      policyVersion: "performance-policy-v1", input: "measure this",
    });
    expect(createMetricCount("model.latency_ms")).toBe(beforeLatency + 1);
    expect(createMetricCount("model.cost_microusd")).toBe(beforeCost + 1);
    expect(createMetricCount("model.divergence_microusd")).toBe(beforeDivergence + 1);
  });
});

function createMetricCount(name: string): number {
  return operationalMetrics.snapshot().filter((metric) => metric.name === name)
    .reduce((sum, metric) => sum + metric.count, 0);
}

interface MetricWrite {
  readonly name: string;
  readonly value: number;
  readonly topologyVersion: string;
  readonly sampleCount?: number;
  readonly valueSum?: number;
  readonly valueMax?: number;
}

function emptyCacheSnapshot(): CacheMetricSnapshot {
  return Object.freeze({
    hits: 0, misses: 0, authorizationFilteredMisses: 0, fallbacks: 0,
    invalidations: 0, invalidationFailures: 0, prewarms: 0, prewarmFailures: 0,
    rebuilds: 0, staleVersionRejections: 0, singleFlightContention: 0,
    evictions: 0, backendFailures: 0,
    fallbackLatencyMs: Object.freeze({ count: 0, total: 0, max: 0 }),
    fallbackLatencySequence: 0,
    fallbackLatencyWindow: Object.freeze([]),
    cacheReadLatencyMs: Object.freeze({ count: 0, total: 0, max: 0 }),
    invalidationLatencyMs: Object.freeze({ count: 0, total: 0, max: 0 }),
    prewarmLatencyMs: Object.freeze({ count: 0, total: 0, max: 0 }),
    freshnessLagMs: Object.freeze({ count: 0, total: 0, max: 0 }),
    rebuildLatencyMs: Object.freeze({ count: 0, total: 0, max: 0 }),
    byNamespace: Object.freeze({}),
  });
}

function metricCaptureDatabase(calls: MetricWrite[]): EventDatabase {
  let database: EventDatabase;
  database = {
    query: async (sql, parameters = []) => {
      if (sql.includes("insert into cache_metric_observations")) calls.push(Object.freeze({
        name: String(parameters[0]), value: Number(parameters[1]),
        topologyVersion: String(parameters[3]),
        ...(parameters[4] === undefined ? {} : { sampleCount: Number(parameters[4]) }),
        ...(parameters[5] === undefined ? {} : { valueSum: Number(parameters[5]) }),
        ...(parameters[6] === undefined ? {} : { valueMax: Number(parameters[6]) }),
      }));
      return [];
    },
    one: async () => { throw new Error("UNEXPECTED_ONE"); },
    transaction: async (work) => work(database),
  };
  return database;
}

describe("operator health boundary", () => {
  it("authenticates before resolving/reading the database and returns a bounded no-store DTO", async () => {
    const queries: string[] = [];
    const runQuery = vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("operator-database-commit-probe")) return [{ probe: 1 }];
        if (sql.includes("server_version")) return [{ server_version: "17.1" }];
        if (sql.includes("transactional_outbox")) return [{ age_ms: 8 }];
        if (sql.includes("memory_projection_checkpoints")) return [{ freshness_ms: 12 }];
        if (sql.includes("database_commit_metric_buckets")) return [
          { outcome: "success", latency_bucket_ms: 5, sample_count: "4",
            value_sum: 12, value_max: 4 },
        ];
        if (sql.includes("cache_metric_observations")) return [
          { name: "cache.fallback", category: null,
            topology_version: "single-main-node-v1", sample_count: "2",
            average_value: 9, value_max: 11, p95_value: 11 },
          { name: "cache.backend_failure", category: null,
            topology_version: "single-main-node-v1:invalidation-failure", sample_count: "3",
            average_value: 1, value_max: 1, p95_value: 1 },
        ];
        if (sql.includes("cache_rebuild_category_checks")) return [{ mismatches: "0" }];
        if (sql.includes("cache_rebuild_runs")) return [{ rows_per_second: 20 }];
        if (sql.includes("recall_traces")) return [{ sample_count: "3", p50_ms: 1,
          p95_ms: 2, p99_ms: 3 }];
        if (sql.includes("model_runs")) return [{ role: "NODE", completion_status: "COMPLETED",
          sample_count: "1", estimated_cost_microusd: "5", divergence_microusd: "0",
          p50_ms: 10, p95_ms: 10, p99_ms: 10 }];
        throw new Error(`unexpected health SQL: ${sql}`);
      });
    const db = {
      query: runQuery,
      one: vi.fn(async (sql: string) => (await runQuery(sql))[0]),
      transaction: vi.fn(async (work: (transaction: EventDatabase) => Promise<unknown>) => work(db)),
    } as unknown as EventDatabase;
    const resolveDatabase = vi.fn(() => db);
    const handler = createOperatorHealthHandler({
      resolveDatabase,
      token: "operator-health-token-that-is-at-least-32-bytes",
      collect: collectOperatorHealth,
    });

    const denied = await handler(new Request("http://localhost/api/operator/health"));
    expect(denied.status).toBe(401);
    expect(resolveDatabase).not.toHaveBeenCalled();
    expect(queries).toEqual([]);

    const allowed = await handler(new Request("http://localhost/api/operator/health", {
      headers: { authorization: "Bearer operator-health-token-that-is-at-least-32-bytes" },
    }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(Number(allowed.headers.get("content-length"))).toBeLessThanOrEqual(64 * 1024);
    const body = await allowed.json() as Record<string, unknown>;
    expect(body).toMatchObject({ schemaVersion: 1, recall: { sampleCount: 3, p50Ms: 1,
      p95Ms: 2, p99Ms: 3 }, queue: { ageMs: 8 },
      projections: { freshnessMs: 12 }, cacheDivergence: { mismatches: 0 },
      cacheFallback: { sampleCount: 2, averageLatencyMs: 9, maxLatencyMs: 11 },
      cacheInvalidation: { failureCount: 3 },
      databaseCommit: [expect.objectContaining({ count: 4, p95: 5 })] });
    expect(JSON.stringify(body)).not.toContain("operator-health-token");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(queries.find((sql) => sql.includes("cache_metric_observations")))
      .not.toMatch(/percentile_cont/iu);
    expect(queries.find((sql) => sql.includes("recall_traces"))).toMatch(/limit 10000/iu);
    expect(queries.find((sql) => sql.includes("model_runs"))).toMatch(/limit 10000/iu);
    expect(body).not.toHaveProperty("runtimeMetrics");
  });

  it("reports absent projection and verified rebuild evidence as unknown", async () => {
    const queries: string[] = [];
    const runQuery = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("server_version")) return [{ server_version: "17.2" }];
      if (sql.includes("transactional_outbox")) return [{ age_ms: 0 }];
      if (sql.includes("memory_projection_checkpoints")) return [{ freshness_ms: null }];
      if (sql.includes("cache_metric_observations")) return [];
      if (sql.includes("cache_rebuild_category_checks")) return [{ mismatches: null }];
      if (sql.includes("cache_rebuild_runs")) return [{ rows_per_second: null }];
      if (sql.includes("recall_traces")) return [{ sample_count: "0", p50_ms: null,
        p95_ms: null, p99_ms: null }];
      if (sql.includes("model_runs")) return [];
      if (sql.includes("database_commit_metric_buckets")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const db = {
      query: runQuery,
      one: vi.fn(async (sql: string) => (await runQuery(sql))[0]),
      transaction: vi.fn(),
    } as unknown as EventDatabase;
    const health = await collectOperatorHealth(db);
    expect(health).toMatchObject({
      projections: { freshnessMs: null },
      cacheDivergence: { mismatches: null },
      rebuild: { rowsPerSecond: null },
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("returns unknown rebuild throughput when no verified rebuild row exists", async () => {
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.includes("server_version")) return [{ server_version: "17.2" }];
      if (sql.includes("transactional_outbox")) return [];
      if (sql.includes("memory_projection_checkpoints")) return [];
      if (sql.includes("cache_metric_observations")) return [];
      if (sql.includes("cache_rebuild_category_checks")) return [{ mismatches: null }];
      if (sql.includes("cache_rebuild_runs")) return [];
      if (sql.includes("recall_traces")) return [{ sample_count: "0", p50_ms: null,
        p95_ms: null, p99_ms: null }];
      if (sql.includes("model_runs") || sql.includes("database_commit_metric_buckets")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const db = {
      query: runQuery,
      one: vi.fn(async (sql: string) => {
        const row = (await runQuery(sql))[0];
        if (!row) throw new Error("EXPECTED_ONE_ROW");
        return row;
      }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;
    await expect(collectOperatorHealth(db)).resolves.toMatchObject({
      queue: { ageMs: 0 },
      projections: { freshnessMs: null },
      rebuild: { rowsPerSecond: null },
    });
  });

  it("has time-leading indexes for every bounded operator-health sample", async () => {
    const { db } = await testContext();
    const indexes = await db.query<{ indexname: string } & Record<string, unknown>>(
      `select indexname from pg_indexes where schemaname=current_schema()
         and indexname in (
           'recall_traces_health_window_idx','model_runs_health_window_idx',
           'transactional_outbox_active_age_idx','memory_projection_checkpoints_freshness_idx',
           'cache_rebuild_runs_verified_completed_idx'
         )
       order by indexname`,
    );
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      "cache_rebuild_runs_verified_completed_idx",
      "memory_projection_checkpoints_freshness_idx",
      "model_runs_health_window_idx",
      "recall_traces_health_window_idx",
      "transactional_outbox_active_age_idx",
    ]);
  });

  it("uses direct indexed oldest/latest reads for queue, projection, and rebuild health", async () => {
    const queries: string[] = [];
    const runQuery = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("server_version")) return [{ server_version: "17.2" }];
      if (sql.includes("transactional_outbox")) return [];
      if (sql.includes("memory_projection_checkpoints")) return [];
      if (sql.includes("cache_metric_observations")) return [];
      if (sql.includes("cache_rebuild_category_checks")) return [{ mismatches: null }];
      if (sql.includes("cache_rebuild_runs")) return [];
      if (sql.includes("recall_traces")) return [{ sample_count: "0", p50_ms: null,
        p95_ms: null, p99_ms: null }];
      if (sql.includes("model_runs") || sql.includes("database_commit_metric_buckets")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    };
    const db = {
      query: runQuery,
      one: async (sql: string) => (await runQuery(sql))[0]!,
      transaction: vi.fn(),
    } as unknown as EventDatabase;
    await collectOperatorHealth(db);
    expect(queries.find((sql) => sql.includes("transactional_outbox")))
      .toMatch(/status in \('PENDING','FAILED'\).*order by created_at,id limit 1/isu);
    expect(queries.find((sql) => sql.includes("transactional_outbox"))).not.toContain("LEASED");
    expect(queries.find((sql) => sql.includes("memory_projection_checkpoints")))
      .toMatch(/order by updated_at desc,projection_key desc limit 1/isu);
    expect(queries.find((sql) => sql.includes("cache_rebuild_runs")))
      .toMatch(/order by completed_at desc,id desc limit 1/isu);
  });

  it("bounds 24-hour recall and model percentile source rows", async () => {
    const queries: string[] = [];
    const runQuery = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("operator-database-commit-probe")) return [];
      if (sql.includes("server_version")) return [{ server_version: "17.2" }];
      if (sql.includes("transactional_outbox")) return [{ age_ms: 0 }];
      if (sql.includes("memory_projection_checkpoints")) return [{ freshness_ms: null }];
      if (sql.includes("cache_metric_observations")) return [];
      if (sql.includes("cache_rebuild_category_checks")) return [{ mismatches: null }];
      if (sql.includes("cache_rebuild_runs")) return [{ rows_per_second: null }];
      if (sql.includes("recall_traces")) return [{ sample_count: "0", p50_ms: null,
        p95_ms: null, p99_ms: null }];
      if (sql.includes("model_runs")) return [];
      if (sql.includes("database_commit_metric_buckets")) return [];
      throw new Error(`unexpected SQL: ${sql}`);
    };
    let db: EventDatabase;
    db = {
      query: runQuery,
      one: async (sql: string) => (await runQuery(sql))[0]!,
      transaction: async (work: (transaction: EventDatabase) => Promise<unknown>) => work(db),
    } as unknown as EventDatabase;
    await collectOperatorHealth(db);
    expect(queries.find((sql) => sql.includes("recall_traces"))).toMatch(/limit 10000/iu);
    expect(queries.find((sql) => sql.includes("model_runs"))).toMatch(/limit 10000/iu);
  });
});

describe("reference recall budgets", () => {
  it("proves real source counts, known answers, permission boundaries, indexed plans, and cold/warm separation", async () => {
    const fixture = await seedMillionMemoryFixture({
      sourceEventCount: RUN_MILLION ? 1_000_000 : 10_000,
    });
    const result = await benchmarkRecall({
      fixture,
      iterations: RUN_MILLION ? 200 : 8,
      warmup: RUN_MILLION ? 20 : 2,
      excludeModelGeneration: true,
    });
    console.info("T34_RECALL_BENCHMARK", JSON.stringify(result));

    expect(result.sourceEventCount).toBeGreaterThanOrEqual(RUN_MILLION ? 1_000_000 : 10_000);
    expect(result.measuredIterations).toBe(RUN_MILLION ? 200 : 8);
    expect(result.coldRecallMs).toBeGreaterThanOrEqual(0);
    expect(result.warmRecallP95Ms).toBeGreaterThanOrEqual(0);
    expect(result.cachedHandoffP95Ms).toBeGreaterThanOrEqual(0);
    expect(result.unboundedQueries).toBe(0);
    expect(result.queryPlans.length).toBeGreaterThan(0);
    expect(result.queryPlans.every((plan) => plan.bounded && plan.usesIndex)).toBe(true);
    expect(result.queryPlans.every((plan) => (
      (plan as unknown as { rootLimited?: boolean }).rootLimited === true
        && (plan as unknown as { unboundedCandidateScans?: readonly unknown[] })
          .unboundedCandidateScans?.length === 0
        && plan.planRows <= 20
    ))).toBe(true);
    expect((result as unknown as { projectedMemoryCount?: number }).projectedMemoryCount)
      .toBeGreaterThanOrEqual(RUN_MILLION ? 1_000_000 : 10_000);
    expect(result.queryPlans.every((plan) => (
      (plan as unknown as { evidenceSource?: string }).evidenceSource === "CAPTURED_RECALL_SQL"
    ))).toBe(true);
    expect(result.correctness).toEqual({
      knownAnswerFound: true,
      conflictResolvedToCurrent: true,
      temporalWindowRespected: true,
      permissionLeakCount: 0,
    });
    expect(result.machine.node).toMatch(/^v24\./u);
    expect(result.machine.postgres.length).toBeGreaterThan(0);

    if (RUN_MILLION) {
      expect(result.warmRecallP95Ms).toBeLessThanOrEqual(250);
      expect(result.cachedHandoffP95Ms).toBeLessThanOrEqual(100);
    }
    await fixture.cleanup();
  }, 600_000);
});
