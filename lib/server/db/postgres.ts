import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { EventDatabase } from "../events/types";
import type { CommitMeasurement } from "../observability/metrics";

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

let sharedPool: Pool | undefined;
let sharedDatabase: EventDatabase | undefined;

const COMMIT_LATENCY_BUCKETS_MS = Object.freeze([
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
]);

async function persistCommitMeasurement(pool: Pool, measurement: CommitMeasurement): Promise<void> {
  const durationMs = Math.max(0, measurement.durationMs);
  const latencyBucketMs = COMMIT_LATENCY_BUCKETS_MS.find((upper) => durationMs <= upper) ?? 60_000;
  await pool.query(
    `with pruned as (
       delete from database_commit_metric_buckets
       where bucket_start<date_trunc('minute',clock_timestamp()-interval '48 hours')
     )
     insert into database_commit_metric_buckets (
       outcome,latency_bucket_ms,bucket_start,sample_count,value_sum,value_max,observed_at
     ) values ($1,$2,date_trunc('minute',clock_timestamp()),1,$3,$3,clock_timestamp())
     on conflict (outcome,latency_bucket_ms,bucket_start) do update
     set sample_count=database_commit_metric_buckets.sample_count+1,
         value_sum=database_commit_metric_buckets.value_sum+excluded.value_sum,
         value_max=greatest(database_commit_metric_buckets.value_max,excluded.value_max),
         observed_at=excluded.observed_at`,
    [measurement.outcome, latencyBucketMs, durationMs],
  );
}

function databaseFor(
  queryable: Queryable,
  transactionFactory: <Result>(
    work: (transaction: EventDatabase) => Promise<Result>,
  ) => Promise<Result>,
): EventDatabase {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row[]> {
      const result = await queryable.query<Row & QueryResultRow>(sql, [...parameters]);
      return result.rows;
    },
    async one<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row> {
      const result = await queryable.query<Row & QueryResultRow>(sql, [...parameters]);
      if (result.rows.length !== 1) {
        throw new Error(`EXPECTED_ONE_ROW:${result.rows.length}`);
      }
      return result.rows[0];
    },
    transaction: transactionFactory,
  };
}

function clientDatabase(client: PoolClient): EventDatabase {
  let database: EventDatabase;
  database = databaseFor(client, async (work) => work(database));
  return database;
}

export function databaseFromPool(pool: Pool): EventDatabase {
  return databaseFor(pool, async (work) => {
    // Resolve the observer before opening a transaction so first-load module work
    // can never extend the database transaction lifetime.
    const { measureCommit } = await import("../observability/metrics");
    const client = await pool.connect();
    let commitMeasurement: CommitMeasurement | undefined;
    try {
      await client.query("begin");
      const result = await work(clientDatabase(client));
      await measureCommit(
        () => client.query("commit"),
        (measurement) => { commitMeasurement = measurement; },
      );
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
      if (commitMeasurement) {
        // The source transaction has already committed or failed. Metrics are
        // deliberately best-effort and cannot change that durable outcome.
        await persistCommitMeasurement(pool, commitMeasurement).catch(() => undefined);
      }
    }
  });
}

function configuredPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  return new Pool({
    connectionString,
    application_name: "gustavo",
    max: 10,
    connectionTimeoutMillis: 5_000,
    ...(process.env.GUSTAVO_DATABASE_SSL === "require"
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  });
}

export function getDatabase(): EventDatabase {
  if (!sharedDatabase) {
    sharedPool = configuredPool();
    sharedDatabase = databaseFromPool(sharedPool);
  }
  return sharedDatabase;
}

export async function closeDatabase(): Promise<void> {
  const pool = sharedPool;
  sharedDatabase = undefined;
  sharedPool = undefined;
  if (pool) {
    await pool.end();
  }
}
