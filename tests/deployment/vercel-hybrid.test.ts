import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createOperatorHealthHandler } from "../../app/api/operator/health/route";
import {
  collectHybridHealth,
  HYBRID_HEALTH_POLICY,
  projectHybridHealth,
} from "../../lib/server/bridge/health";
import { postgresPoolPolicy } from "../../lib/server/db/postgres";
import type { EventDatabase } from "../../lib/server/events/types";
import { runProductionMigrations } from "../../scripts/migrate-production";
import { testContext } from "../helpers/postgres";

describe("hybrid operator health", () => {
  it("separates hosted and local components with durable bounded quota state", async () => {
    const dto = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "DEGRADED", stream: "HEALTHY" },
      heartbeats: [
        { component: "CODEX", observedAt: "2026-08-13T12:00:00.000Z", safeCode: null },
        { component: "MARKET", observedAt: "2026-08-13T11:55:00.000Z", safeCode: "RATE_LIMITED" },
        { component: "TUNNEL", observedAt: "2026-08-13T12:00:00.000Z", safeCode: null },
      ],
      quotas: [
        { name: "CODEX_JOBS", used: 4, limit: 100 },
        { name: "QSTASH_MESSAGES", used: 20, limit: 900 },
        { name: "FINNHUB_CALLS", used: 96, limit: 96 },
      ],
      pendingJobs: 2,
      now: new Date("2026-08-13T12:01:00.000Z"),
    });

    expect(dto).toMatchObject({
      hosted: { database: "HEALTHY", cache: "DEGRADED", stream: "HEALTHY" },
      local: { codex: "AVAILABLE", market: "DEGRADED", tunnel: "AVAILABLE" },
      bridge: { pendingJobs: 2 },
    });
    expect(JSON.stringify(dto)).not.toMatch(/hostname|url|prompt|price|token|ciphertext|providerKey/i);
  });

  it("uses the database-clock 12-minute CODEX lease and rejects future heartbeats", async () => {
    const atBoundary = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{
        component: "CODEX",
        status: "HEALTHY",
        observedAt: "2026-08-13T11:48:00.000Z",
        safeCode: null,
      }],
      quotas: [{ name: "CODEX_JOBS", used: 99, limit: 100 }],
      pendingJobs: 0,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    const stale = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{
        component: "CODEX",
        status: "HEALTHY",
        observedAt: "2026-08-13T11:47:59.999Z",
        safeCode: null,
      }],
      quotas: [{ name: "CODEX_JOBS", used: 99, limit: 100 }],
      pendingJobs: 0,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    const future = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{
        component: "CODEX",
        status: "HEALTHY",
        observedAt: "2026-08-13T12:00:00.001Z",
        safeCode: null,
      }],
      quotas: [{ name: "CODEX_JOBS", used: 99, limit: 100 }],
      pendingJobs: 0,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });

    expect(HYBRID_HEALTH_POLICY.codexLeaseSeconds).toBe(12 * 60);
    expect(atBoundary.local.codex).toBe("AVAILABLE");
    expect(atBoundary.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ ageSeconds: 720, safeCode: null });
    expect(stale.local.codex).toBe("OFFLINE");
    expect(future.local.codex).toBe("OFFLINE");
    expect(future.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ ageSeconds: 0, safeCode: "WORKER_OFFLINE" });
  });

  it("lets the fixed current-UTC CODEX quota override a fresh heartbeat", async () => {
    const dto = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{
        component: "CODEX",
        status: "HEALTHY",
        observedAt: "2026-08-13T12:00:00.000Z",
        safeCode: null,
      }],
      quotas: [{ name: "CODEX_JOBS", used: 100, limit: 100 }],
      pendingJobs: 1,
      now: new Date("2026-08-13T12:01:00.000Z"),
    });

    expect(dto.local.codex).toBe("DEGRADED");
    expect(dto.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ safeCode: "QUOTA_EXHAUSTED" });
    expect(dto.quotas).toContainEqual({
      name: "CODEX_JOBS",
      used: 100,
      limit: 100,
      exhausted: true,
    });
  });

  it("reads only fixed durable rows with database time and current UTC quotas", async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [
          { component: "CODEX", heartbeat_status: "HEALTHY", safe_code: null,
            age_seconds: 60, codex_lease_healthy: true,
            quota_name: "CODEX_JOBS", used: 100, quota_limit: 100, pending_jobs: 2 },
          { component: "MARKET", heartbeat_status: "DEGRADED", safe_code: "RATE_LIMITED",
            age_seconds: 360, codex_lease_healthy: null,
            quota_name: "QSTASH_MESSAGES", used: 20, quota_limit: 900, pending_jobs: 2 },
          { component: "TUNNEL", heartbeat_status: "HEALTHY", safe_code: null,
            age_seconds: 60, codex_lease_healthy: null,
            quota_name: "FINNHUB_CALLS", used: 96, quota_limit: 27_648, pending_jobs: 2 },
        ];
      }),
      one: vi.fn(async () => { throw new Error("HYBRID_HEALTH_SPLIT_READ"); }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "DEGRADED", stream: "HEALTHY",
    });

    expect(dto).toMatchObject({
      local: { codex: "DEGRADED" },
      bridge: { pendingJobs: 2 },
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/hybrid_worker_heartbeats[\s\S]*deployment_quota_counters/iu);
    expect(queries[0]).toMatch(/status='PENDING'[\s\S]*status='CLAIMED'/iu);
    expect(db.one).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("uses one materialized database clock across a UTC quota rollover", async () => {
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes("database_clock as materialized")) {
        throw new Error("HYBRID_HEALTH_DATABASE_CLOCK_NOT_COHERENT");
      }
      return [
        { component: "CODEX", heartbeat_status: "HEALTHY", safe_code: null,
          age_seconds: 1, codex_lease_healthy: true,
          quota_name: "CODEX_JOBS", used: 100, quota_limit: 100, pending_jobs: 0 },
        { component: "MARKET", heartbeat_status: "HEALTHY", safe_code: null,
          age_seconds: 1, codex_lease_healthy: null,
          quota_name: "QSTASH_MESSAGES", used: 0, quota_limit: 900, pending_jobs: 0 },
        { component: "TUNNEL", heartbeat_status: "HEALTHY", safe_code: null,
          age_seconds: 1, codex_lease_healthy: null,
          quota_name: "FINNHUB_CALLS", used: 0, quota_limit: 27_648, pending_jobs: 0 },
      ];
    });
    const db = {
      query,
      one: vi.fn(async () => { throw new Error("HYBRID_HEALTH_SPLIT_CLOCK_READ"); }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY",
    });
    const sql = query.mock.calls[0]?.[0] ?? "";

    expect(query).toHaveBeenCalledOnce();
    expect(dto.local.codex).toBe("DEGRADED");
    expect(dto.quotas.find(({ name }) => name === "CODEX_JOBS"))
      .toMatchObject({ used: 100, limit: 100, exhausted: true });
    expect(sql).toMatch(/with database_clock as materialized\s*\(\s*select clock_timestamp\(\) observed_now/iu);
    expect(sql).toMatch(/bucket_date\s*=\s*\(database_clock\.observed_now at time zone 'UTC'\)::date/iu);
    expect(db.one).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("keeps the PostgreSQL microsecond CODEX lease decision authoritative", async () => {
    const roundedByJavaScript = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{ component: "CODEX", status: "HEALTHY",
        observedAt: "2026-08-13T11:48:00.000Z", safeCode: null }],
      quotas: [{ name: "CODEX_JOBS", used: 99, limit: 100 }],
      pendingJobs: 0,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    expect(roundedByJavaScript.local.codex).toBe("AVAILABLE");

    const query = vi.fn(async (_sql: string, _parameters?: readonly unknown[]) => [
      { component: "CODEX", heartbeat_status: "HEALTHY", safe_code: null,
        age_seconds: 720, codex_lease_healthy: false,
        quota_name: "CODEX_JOBS", used: 99, quota_limit: 100, pending_jobs: 0 },
      { component: "MARKET", heartbeat_status: null, safe_code: null,
        age_seconds: null, codex_lease_healthy: null,
        quota_name: "QSTASH_MESSAGES", used: 0, quota_limit: 900, pending_jobs: 0 },
      { component: "TUNNEL", heartbeat_status: null, safe_code: null,
        age_seconds: null, codex_lease_healthy: null,
        quota_name: "FINNHUB_CALLS", used: 0, quota_limit: 27_648, pending_jobs: 0 },
    ]);
    const db = {
      query,
      one: vi.fn(async () => { throw new Error("HYBRID_HEALTH_JAVASCRIPT_CLOCK_USED"); }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY",
    });
    const sql = query.mock.calls[0]?.[0] ?? "";
    const parameters = query.mock.calls[0]?.[1] ?? [];

    expect(dto.local.codex).toBe("OFFLINE");
    expect(dto.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ ageSeconds: 720, safeCode: "WORKER_OFFLINE" });
    expect(parameters.slice(0, 2)).toEqual([
      HYBRID_HEALTH_POLICY.codexLeaseSeconds,
      HYBRID_HEALTH_POLICY.maximumHeartbeatAgeSeconds,
    ]);
    expect(sql).toMatch(/observed_at between\s+database_clock\.observed_now\s*-\s*make_interval\(secs => \$1::double precision\)\s+and database_clock\.observed_now/isu);
    expect(sql).toMatch(/extract\(epoch from\s+\(database_clock\.observed_now-heartbeat\.observed_at\)\)/iu);
    expect(db.one).not.toHaveBeenCalled();
  });

  it("bounds the pending scan at maximumPendingJobs plus one before counting", async () => {
    const query = vi.fn(async (_sql: string, _parameters?: readonly unknown[]) => [
      { component: "CODEX", heartbeat_status: "OFFLINE", safe_code: "WORKER_OFFLINE",
        age_seconds: 1, codex_lease_healthy: false,
        quota_name: "CODEX_JOBS", used: 0, quota_limit: 100, pending_jobs: 10_001 },
      { component: "MARKET", heartbeat_status: null, safe_code: null,
        age_seconds: null, codex_lease_healthy: null,
        quota_name: "QSTASH_MESSAGES", used: 0, quota_limit: 900, pending_jobs: 10_001 },
      { component: "TUNNEL", heartbeat_status: null, safe_code: null,
        age_seconds: null, codex_lease_healthy: null,
        quota_name: "FINNHUB_CALLS", used: 0, quota_limit: 27_648, pending_jobs: 10_001 },
    ]);
    const db = {
      query,
      one: vi.fn(async () => { throw new Error("HYBRID_HEALTH_UNBOUNDED_PENDING_READ"); }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY",
    });
    const sql = query.mock.calls[0]?.[0] ?? "";
    const parameters = query.mock.calls[0]?.[1] ?? [];
    const scanLimit = HYBRID_HEALTH_POLICY.maximumPendingJobs + 1;

    expect(dto.bridge.pendingJobs).toBe(HYBRID_HEALTH_POLICY.maximumPendingJobs);
    expect(parameters[2]).toBe(scanLimit);
    expect(sql).toMatch(/bounded_pending as materialized[\s\S]*limit \$3[\s\S]*count\(\*\)/iu);
    expect(sql).not.toMatch(/select count\(\*\)::text pending_jobs\s+from bridge_model_jobs/iu);
    expect(query).toHaveBeenCalledOnce();
    expect(db.one).not.toHaveBeenCalled();
  });

  it("executes the coherent health authority against PostgreSQL microsecond timestamps", async () => {
    const { db } = await testContext();
    await db.query(
      `insert into hybrid_worker_heartbeats (component,status,safe_code)
       values ('CODEX','HEALTHY',null)`,
    );
    await db.query(
      "alter table hybrid_worker_heartbeats disable trigger hybrid_worker_heartbeats_are_bounded",
    );
    try {
      await db.query(
        `update hybrid_worker_heartbeats
            set observed_at=clock_timestamp()-interval '12 minutes 0.0001 seconds',
                updated_at=clock_timestamp()
          where component='CODEX'`,
      );
    } finally {
      await db.query(
        "alter table hybrid_worker_heartbeats enable trigger hybrid_worker_heartbeats_are_bounded",
      );
    }
    await db.query(
      `insert into deployment_quota_counters
         (quota_name,bucket_date,used_count,limit_count)
       values ('CODEX_JOBS',(clock_timestamp() at time zone 'UTC')::date,99,100)`,
    );

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY",
    });

    expect(dto.local.codex).toBe("OFFLINE");
    expect(dto.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ ageSeconds: 720, safeCode: "WORKER_OFFLINE" });
    expect(dto.quotas.find(({ name }) => name === "CODEX_JOBS"))
      .toMatchObject({ used: 99, limit: 100, exhausted: false });
    expect(dto.bridge.pendingJobs).toBe(0);
  }, 20_000);

  it("returns a fixed bounded DTO and drops every sensitive or identifying input field", async () => {
    const dto = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "DEGRADED" },
      heartbeats: [{
        component: "CODEX",
        status: "DEGRADED",
        observedAt: "2026-08-13T11:59:59.999Z",
        safeCode: "PROVIDER_UNAVAILABLE",
        hostname: "private-host-canary",
        url: "https://private-funnel.invalid",
        prompt: "private-prompt-canary",
        price: "123.45",
        token: "private-token-canary",
        ciphertext: "private-ciphertext-canary",
        providerKey: "private-provider-key-canary",
        containerId: "private-container-canary",
        imageDigest: "private-image-canary",
        volumeName: "private-volume-canary",
        accountId: "private-account-canary",
        jobId: "private-job-canary",
      } as never],
      quotas: [{
        name: "CODEX_JOBS", used: 4, limit: 100, providerAccountId: "private-provider-account",
      } as never],
      pendingJobs: Number.MAX_SAFE_INTEGER,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    const serialized = JSON.stringify(dto);

    expect(dto.bridge.pendingJobs).toBe(HYBRID_HEALTH_POLICY.maximumPendingJobs);
    expect(dto.components).toHaveLength(3);
    expect(dto.quotas).toHaveLength(3);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(4 * 1024);
    expect(serialized).not.toMatch(
      /private-|hostname|https?:|prompt|price|token|ciphertext|providerKey|containerId|imageDigest|volumeName|accountId|jobId/iu,
    );
  });

  it("authenticates before protected reads and keeps private generic bounded failures", async () => {
    const resolveDatabase = vi.fn(() => ({ marker: "private-db" }) as never);
    const collect = vi.fn(async () => ({ privateState: "never-returned" }) as never);
    const handler = createOperatorHealthHandler({
      resolveDatabase,
      token: "operator-health-token-that-is-at-least-32-bytes",
      collect,
    });

    const denied = await handler(new Request("http://localhost/api/operator/health"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await denied.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(resolveDatabase).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();

    const failing = createOperatorHealthHandler({
      resolveDatabase: vi.fn(() => { throw new Error("private-host-canary"); }),
      token: "operator-health-token-that-is-at-least-32-bytes",
    });
    const unavailable = await failing(new Request("http://localhost/api/operator/health", {
      headers: { authorization: "Bearer operator-health-token-that-is-at-least-32-bytes" },
    }));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await unavailable.json()).toEqual({ error: "OPERATOR_HEALTH_UNAVAILABLE" });

    const oversized = createOperatorHealthHandler({
      resolveDatabase,
      token: "operator-health-token-that-is-at-least-32-bytes",
      collect: vi.fn(async () => ({ payload: "x".repeat(70 * 1024) }) as never),
    });
    const bounded = await oversized(new Request("http://localhost/api/operator/health", {
      headers: { authorization: "Bearer operator-health-token-that-is-at-least-32-bytes" },
    }));
    expect(bounded.status).toBe(503);
    expect(Number(bounded.headers.get("content-length"))).toBeLessThan(1024);
    expect(await bounded.json()).toEqual({ error: "OPERATOR_HEALTH_RESPONSE_TOO_LARGE" });
  });
});

describe("production migrations", () => {
  it("takes one advisory lock and applies each ordered migration once", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("select name, checksum_sha256")
        ? [{
          name: "0001_events.sql",
          checksum_sha256: createHash("sha256")
            .update("-- 0001_events.sql", "utf8")
            .digest("hex"),
        }]
        : [],
    }));

    const result = await runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql", "0002_event_metadata.sql"],
      readMigration: (name) => `-- ${name}`,
      withClient: async (work) => work({ query } as never),
    });

    expect(query.mock.calls[0]?.[0]).toBe("begin");
    expect(query.mock.calls[1]?.[0]).toContain("pg_advisory_xact_lock");
    expect(result).toEqual({ applied: ["0002_event_metadata.sql"], skipped: ["0001_events.sql"] });
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("replays recorded checksums and rejects changed migration contents", async () => {
    const ledger = new Map<string, string>();
    const appliedSql: string[] = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("select name, checksum_sha256")) {
        return {
          rows: [...ledger].map(([name, checksum_sha256]) => ({
            name,
            checksum_sha256,
          })),
        };
      }
      if (sql.includes("insert into") && values.length === 2) {
        ledger.set(String(values[0]), String(values[1]));
      }
      if (sql.startsWith("-- migration ")) appliedSql.push(sql);
      return { rows: [] };
    });
    let changed = false;
    const run = () => runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0002_event_metadata.sql", "0001_events.sql"],
      readMigration: (name: string) => [
        `-- migration ${name}`,
        changed && name === "0002_event_metadata.sql" ? "-- changed" : "",
      ].filter(Boolean).join("\n"),
      withClient: async (work) => work({ query } as never),
    });

    await expect(run()).resolves.toEqual({
      applied: ["0001_events.sql", "0002_event_metadata.sql"],
      skipped: [],
    });
    await expect(run()).resolves.toEqual({
      applied: [],
      skipped: ["0001_events.sql", "0002_event_metadata.sql"],
    });
    expect(appliedSql).toEqual([
      "-- migration 0001_events.sql",
      "-- migration 0002_event_metadata.sql",
    ]);
    const transactionCalls = query.mock.calls.map(([sql]) => sql);
    expect(transactionCalls.filter((sql) => sql === "begin")).toHaveLength(2);
    expect(transactionCalls.filter((sql) => sql === "commit")).toHaveLength(2);

    changed = true;
    await expect(run())
      .rejects.toThrow("MIGRATION_CHECKSUM_CHANGED:0002_event_metadata.sql");
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(query.mock.calls[1]?.[0]).toContain("gustavo:production-migrations:v1");
  });

  it("rejects a ledger row without its durable checksum", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("select name, checksum_sha256")
        ? [{ name: "0001_events.sql" }]
        : [],
    }));

    await expect(runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql"],
      readMigration: (name) => `-- ${name}`,
      withClient: async (work) => work({ query } as never),
    })).rejects.toThrow("MIGRATION_LEDGER_INVALID:0001_events.sql");
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("holds one transaction-scoped advisory lock across the complete batch", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql", "0002_identity.sql"],
      readMigration: (name) => `-- migration ${name}`,
      withClient: async (work) => work({ query } as never),
    });

    const sql = query.mock.calls.map(([statement]) => statement);
    const beginIndex = sql.indexOf("begin");
    const lockIndex = sql.findIndex((statement) => statement.includes(
      "pg_advisory_xact_lock(hashtextextended('gustavo:production-migrations:v1', 0))",
    ));
    const commitIndex = sql.indexOf("commit");
    expect(sql.filter((statement) => statement === "begin")).toHaveLength(1);
    expect(lockIndex).toBe(beginIndex + 1);
    expect(sql.filter((statement) => statement === "commit")).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("-- migration ")))
      .toHaveLength(2);
    expect(sql.slice(lockIndex + 1, commitIndex).filter((statement) => statement
      .includes("insert into schema_migrations"))).toHaveLength(2);
    expect(sql.join("\n")).not.toMatch(/pg_advisory_lock\(|pg_advisory_unlock\(/u);
  });

  it("shares the checksum-aware schema ledger used by backup and restore", async () => {
    const backup = readFileSync("infra/backup/create.ps1", "utf8");
    const restore = readFileSync("infra/backup/restore-drill.ps1", "utf8");
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql"],
      readMigration: (name) => `-- migration ${name}`,
      withClient: async (work) => work({ query } as never),
    });

    expect(backup).toContain("from schema_migrations");
    expect(restore).toContain("from schema_migrations");
    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("create table if not exists schema_migrations");
    expect(sql).toContain("alter table schema_migrations add column if not exists checksum_sha256 char(64)");
    expect(sql).toContain("select name, checksum_sha256");
    expect(sql).toContain("insert into schema_migrations");
    expect(sql).not.toContain("production_migration_ledger");
  });

  it("hashes and executes one canonical LF form across checkout line endings", async () => {
    const inspect = async (migrationSql: string) => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      await runProductionMigrations({
        databaseUrl: "postgresql://example.invalid/db",
        migrationFiles: ["0001_events.sql"],
        readMigration: () => migrationSql,
        withClient: async (work) => work({ query } as never),
      });
      const insert = query.mock.calls.find(([statement]) => statement
        .includes("insert into"));
      const executed = query.mock.calls.find(([statement]) => statement.startsWith("select 1;"));
      return {
        checksum: insert?.[1]?.[1],
        sql: executed?.[0],
      };
    };

    const forms = await Promise.all([
      inspect("select 1;\nselect 2;\n"),
      inspect("select 1;\r\nselect 2;\r\n"),
      inspect("select 1;\rselect 2;\r"),
    ]);
    expect(new Set(forms.map(({ checksum }) => checksum)).size).toBe(1);
    expect(forms[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(forms.map(({ sql }) => sql)).toEqual([
      "select 1;\nselect 2;\n",
      "select 1;\nselect 2;\n",
      "select 1;\nselect 2;\n",
    ]);
  });

  it("rolls back the whole batch when a later migration fails", async () => {
    let transaction: string[] | null = null;
    const durableLedger: string[] = [];
    let commits = 0;
    let rollbacks = 0;
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === "begin") {
        transaction = [];
      } else if (sql === "commit") {
        commits += 1;
        durableLedger.push(...(transaction ?? []));
        transaction = null;
      } else if (sql === "rollback") {
        rollbacks += 1;
        transaction = null;
      } else if (sql.includes("select filename, checksum_sha256")
          || sql.includes("select name, checksum_sha256")) {
        return { rows: [] };
      } else if (sql.includes("insert into") && values.length === 2) {
        transaction?.push(String(values[0]));
      } else if (sql === "-- migration two") {
        throw new Error("MIGRATION_TWO_FAILED");
      }
      return { rows: [] };
    });

    await expect(runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql", "0002_identity.sql"],
      readMigration: (name) => name.startsWith("0001")
        ? "-- migration one"
        : "-- migration two",
      withClient: async (work) => work({ query } as never),
    })).rejects.toThrow("MIGRATION_TWO_FAILED");
    expect(commits).toBe(0);
    expect(rollbacks).toBe(1);
    expect(durableLedger).toEqual([]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("does not let concurrent migration runs enter the protected body together", async () => {
    let locked = false;
    const waiters: Array<() => void> = [];
    const blockedBodies: Array<() => void> = [];
    let activeBodies = 0;
    let bodyEntries = 0;
    let maximumActiveBodies = 0;
    const acquire = async () => {
      if (!locked) {
        locked = true;
        return;
      }
      const available = new Promise<void>((resolve) => waiters.push(resolve));
      blockedBodies.shift()?.();
      await available;
      locked = true;
    };
    const release = () => {
      locked = false;
      waiters.shift()?.();
    };
    const withClient = async <T,>(work: (client: never) => Promise<T>): Promise<T> => {
      let ownsLock = false;
      const query = async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock")) {
          await acquire();
          ownsLock = true;
        } else if (sql === "commit" || sql === "rollback") {
          if (ownsLock) release();
          ownsLock = false;
        } else if (sql.startsWith("-- protected migration")) {
          activeBodies += 1;
          bodyEntries += 1;
          maximumActiveBodies = Math.max(maximumActiveBodies, activeBodies);
          if (bodyEntries === 1 && waiters.length === 0) {
            await new Promise<void>((resolve) => blockedBodies.push(resolve));
          } else if (activeBodies === 2) {
            blockedBodies.shift()?.();
          }
          activeBodies -= 1;
        }
        return { rows: [] };
      };
      return work({ query } as never);
    };
    const run = () => runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql"],
      readMigration: () => "-- protected migration",
      withClient,
    });

    await Promise.all([run(), run()]);
    expect(maximumActiveBodies).toBe(1);
  });
});

const EXPECTED_ACTIVE_ENV_KEYS = [
  "CODEX_HOME",
  "DATABASE_URL",
  "ENABLE_EXPERIMENTAL_COREPACK",
  "FINNHUB_API_KEY",
  "GUSTAVO_APP_ORIGIN",
  "GUSTAVO_BACKGROUND_WORKER_OWNER",
  "GUSTAVO_CACHE_ENCRYPTION_KEY",
  "GUSTAVO_COUNCIL_PSEUDONYM_KEY",
  "GUSTAVO_CURSOR_SIGNING_KEY",
  "GUSTAVO_DATABASE_SSL",
  "GUSTAVO_DEPLOYMENT_PROFILE",
  "GUSTAVO_EVALUATOR_PSEUDONYM_KEY",
  "GUSTAVO_EVENT_ROOT_KEY_V1",
  "GUSTAVO_EVENT_ROOT_KEY_VERSION",
  "GUSTAVO_HYBRID_BRIDGE_ENABLED",
  "GUSTAVO_HYBRID_WAKE_URL",
  "GUSTAVO_MARKET_POLLER_ENABLED",
  "GUSTAVO_OPERATOR_HEALTH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "QSTASH_TOKEN",
  "VALKEY_URL",
] as const;

function activeAssignments(env: string): ReadonlyArray<readonly [string, string]> {
  return env.split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 0) throw new Error(`ENV_ASSIGNMENT_INVALID:${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
}

function assertExactActiveKeyMultiset(
  assignments: ReadonlyArray<readonly [string, string]>,
): void {
  const actual = assignments.map(([key]) => key).sort();
  const expected = [...EXPECTED_ACTIVE_ENV_KEYS].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw new Error("ENV_KEY_SET_INVALID");
  }
}

function activeValues(env: string, name: string): string[] {
  const active = activeAssignments(env);
  assertExactActiveKeyMultiset(active);
  return active
    .filter(([key]) => key === name)
    .map(([, value]) => value);
}

describe("Vercel hybrid deployment contract", () => {
  it("pins Node 24, pnpm 11, bounded functions, and explicit free-tier flags", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    const env = readFileSync("infra/vercel.env.example", "utf8");

    expect(pkg.packageManager).toBe("pnpm@11.16.0");
    expect(pkg.engines.node).toBe(">=24.7.0 <25");
    expect(pkg.dependencies).toMatchObject({
      "@upstash/qstash": expect.any(String),
      "@vercel/functions": expect.any(String),
    });
    expect(vercel.functions).toEqual({
      "app/api/feed/stream/route.ts": { maxDuration: 60 },
      "app/api/internal/maintenance/route.ts": { maxDuration: 60 },
    });
    const bridgeFlag = "GUSTAVO_HYBRID_BRIDGE_ENABLED";
    const corepackFlag = "ENABLE_EXPERIMENTAL_COREPACK";
    expect(activeValues(env, corepackFlag)).toEqual(["1"]);
    expect(activeValues(env, "GUSTAVO_BACKGROUND_WORKER_OWNER")).toEqual(["worker"]);
    expect(activeValues(env, "GUSTAVO_DEPLOYMENT_PROFILE")).toEqual(["public-production-v1"]);
    expect(activeValues(env, "GUSTAVO_APP_ORIGIN")).toEqual(["https://gustavo.lol"]);
    expect(activeValues(env, "GUSTAVO_DATABASE_SSL")).toEqual(["require"]);
    expect(activeValues(env, "GUSTAVO_EVENT_ROOT_KEY_VERSION")).toEqual(["1"]);
    expect(activeValues(env, bridgeFlag)).toEqual(["false"]);
    expect(activeValues(env, "GUSTAVO_MARKET_POLLER_ENABLED")).toEqual(["false"]);
    expect(() => activeValues(
      env.replace("DATABASE_URL=", "DATABASE_URL"),
      "DATABASE_URL",
    )).toThrow("ENV_ASSIGNMENT_INVALID:DATABASE_URL");
    expect(() => activeValues(
      `${env}\nANTHROPIC_API_KEY=paid-secret`,
      "DATABASE_URL",
    )).toThrow("ENV_KEY_SET_INVALID");
    for (const secret of [
      "DATABASE_URL",
      "VALKEY_URL",
      "GUSTAVO_EVENT_ROOT_KEY_V1",
      "GUSTAVO_CURSOR_SIGNING_KEY",
      "GUSTAVO_CACHE_ENCRYPTION_KEY",
      "GUSTAVO_COUNCIL_PSEUDONYM_KEY",
      "GUSTAVO_EVALUATOR_PSEUDONYM_KEY",
      "GUSTAVO_OPERATOR_HEALTH_TOKEN",
      "GUSTAVO_HYBRID_WAKE_URL",
      "QSTASH_TOKEN",
      "QSTASH_CURRENT_SIGNING_KEY",
      "QSTASH_NEXT_SIGNING_KEY",
      "FINNHUB_API_KEY",
      "CODEX_HOME",
    ]) {
      expect(activeValues(env, secret), secret).toEqual([""]);
    }
    expect(activeValues(`# ${bridgeFlag}=true\n${env}`, bridgeFlag)).toEqual(["false"]);
    expect(() => activeValues(`${env}\n${bridgeFlag}=false`, bridgeFlag))
      .toThrow("ENV_KEY_SET_INVALID");
    expect(() => activeValues(`${env}\n${bridgeFlag}=true`, bridgeFlag))
      .toThrow("ENV_KEY_SET_INVALID");
    const suffixed = env.replace(
      `${bridgeFlag}=false`,
      `${bridgeFlag}=false=true`,
    );
    expect(activeValues(suffixed, bridgeFlag)).toEqual(["false=true"]);
    expect(activeValues(
      env.replace(`${corepackFlag}=1`, `${corepackFlag}=1=0`),
      corepackFlag,
    )).toEqual(["1=0"]);
    expect(env).not.toMatch(
      /OPENAI_API_KEY|PAID_FALLBACK|OVERAGE_ENABLED|GUSTAVO_EVENT_ENCRYPTION_KEY|GUSTAVO_INVITATION_HMAC_KEY|GUSTAVO_MEMORY_ENCRYPTION_KEY|GUSTAVO_NODE_SEED_ENCRYPTION_KEY|GUSTAVO_PASSWORD_PEPPER|GUSTAVO_SESSION_HMAC_KEY|GUSTAVO_THOUGHT_ENCRYPTION_KEY/,
    );
  });
});

describe("Vercel PostgreSQL policy", () => {
  it("uses a bounded Vercel pool and attaches exactly that pool", () => {
    const attach = vi.fn();
    const policy = postgresPoolPolicy(
      { VERCEL: "1", DATABASE_URL: "postgresql://example.invalid/db" },
      attach,
    );

    expect(policy.options).toMatchObject({
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
    });
    policy.attach({ marker: "pool" } as never);
    expect(attach).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledWith({ marker: "pool" });
  });
});
