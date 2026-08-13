import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const MIGRATION_FILENAME = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
const CHECKSUM = /^[a-f0-9]{64}$/u;
const ADVISORY_LOCK_NAME = "gustavo:production-migrations:v1";

const ACQUIRE_LOCK_SQL = `select pg_advisory_xact_lock(hashtextextended('${ADVISORY_LOCK_NAME}', 0))
as locked`;

const CREATE_LEDGER_SQL = `create table if not exists schema_migrations (
  name text primary key,
  checksum_sha256 char(64) not null
    check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default clock_timestamp()
);`;

const UPGRADE_LEDGER_SQL = `alter table schema_migrations add column if not exists checksum_sha256 char(64);`;

const READ_LEDGER_SQL = `select name, checksum_sha256
from schema_migrations
order by name`;

const RECORD_MIGRATION_SQL = `insert into schema_migrations (
  name,
  checksum_sha256
) values ($1, $2)`;

interface MigrationClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface ProductionMigrationOptions {
  databaseUrl: string;
  migrationFiles: readonly string[];
  readMigration(filename: string): string | Promise<string>;
  withClient<T>(work: (client: MigrationClient) => Promise<T>): Promise<T>;
}

export interface ProductionMigrationResult {
  applied: string[];
  skipped: string[];
}

interface PreparedMigration {
  filename: string;
  sql: string;
  checksum: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAndOrderFilenames(filenames: readonly string[]): string[] {
  const ordered = [...filenames].sort();
  const seen = new Set<string>();
  for (const filename of ordered) {
    if (!MIGRATION_FILENAME.test(filename)) {
      throw new Error("MIGRATION_FILENAME_INVALID");
    }
    if (seen.has(filename)) {
      throw new Error(`MIGRATION_FILENAME_DUPLICATE:${filename}`);
    }
    seen.add(filename);
  }
  return ordered;
}

async function prepareMigrations(
  filenames: readonly string[],
  readMigration: ProductionMigrationOptions["readMigration"],
): Promise<PreparedMigration[]> {
  const ordered = validateAndOrderFilenames(filenames);
  return Promise.all(ordered.map(async (filename) => {
    const rawSql = await readMigration(filename);
    if (typeof rawSql !== "string") throw new Error(`MIGRATION_READ_INVALID:${filename}`);
    const sql = rawSql.replace(/\r\n?/gu, "\n");
    return {
      filename,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    };
  }));
}

function readRecordedChecksums(rows: readonly unknown[]): Map<string, string> {
  const recorded = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.name !== "string"
        || !MIGRATION_FILENAME.test(row.name)) {
      throw new Error("MIGRATION_LEDGER_INVALID");
    }
    const checksum = row.checksum_sha256;
    if (typeof checksum !== "string" || !CHECKSUM.test(checksum)) {
      throw new Error(`MIGRATION_LEDGER_INVALID:${row.name}`);
    }
    if (recorded.has(row.name)) {
      throw new Error(`MIGRATION_LEDGER_DUPLICATE:${row.name}`);
    }
    recorded.set(row.name, checksum);
  }
  return recorded;
}

export async function runProductionMigrations(
  options: ProductionMigrationOptions,
): Promise<ProductionMigrationResult> {
  if (options.databaseUrl.trim() === "") throw new Error("DATABASE_URL_REQUIRED");
  const migrations = await prepareMigrations(options.migrationFiles, options.readMigration);

  return options.withClient(async (client) => {
    let transactionStarted = false;
    try {
      await client.query("begin");
      transactionStarted = true;
      await client.query(ACQUIRE_LOCK_SQL);
      await client.query(CREATE_LEDGER_SQL);
      await client.query(UPGRADE_LEDGER_SQL);
      const ledger = readRecordedChecksums((await client.query(READ_LEDGER_SQL)).rows);
      const result: ProductionMigrationResult = { applied: [], skipped: [] };

      for (const migration of migrations) {
        if (ledger.has(migration.filename)) {
          const recordedChecksum = ledger.get(migration.filename)!;
          if (recordedChecksum !== migration.checksum) {
            throw new Error(`MIGRATION_CHECKSUM_CHANGED:${migration.filename}`);
          }
          result.skipped.push(migration.filename);
          continue;
        }

        await client.query(migration.sql);
        await client.query(RECORD_MIGRATION_SQL, [migration.filename, migration.checksum]);
        result.applied.push(migration.filename);
      }

      await client.query("commit");
      transactionStarted = false;
      return result;
    } catch (error: unknown) {
      if (transactionStarted) {
        try {
          await client.query("rollback");
        } catch {
          // Preserve the failure that caused the transaction to be rolled back.
        }
      }
      throw error;
    }
  });
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  const migrationDirectory = fileURLToPath(new URL("../db/migrations/", import.meta.url));
  const migrationFiles = (await readdir(migrationDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name);

  const result = await runProductionMigrations({
    databaseUrl,
    migrationFiles,
    readMigration: (filename) => readFile(resolve(migrationDirectory, filename), "utf8"),
    withClient: async (work) => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        return await work({
          query: async (sql, values) => {
            const queryResult = await client.query<Record<string, unknown>>(sql, values);
            if (Array.isArray(queryResult)) {
              return { rows: queryResult.at(-1)?.rows ?? [] };
            }
            return { rows: queryResult.rows };
          },
        });
      } finally {
        await client.end();
      }
    },
  });

  process.stdout.write(
    `PRODUCTION_MIGRATIONS_OK applied=${result.applied.length} skipped=${result.skipped.length}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined
    && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  runCli().catch(() => {
    process.stderr.write("PRODUCTION_MIGRATIONS_FAILED\n");
    process.exitCode = 1;
  });
}
