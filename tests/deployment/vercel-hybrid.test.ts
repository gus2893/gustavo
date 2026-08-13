import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { postgresPoolPolicy } from "../../lib/server/db/postgres";
import { runProductionMigrations } from "../../scripts/migrate-production";

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
