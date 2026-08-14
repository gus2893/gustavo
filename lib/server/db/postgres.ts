import { attachDatabasePool as attachVercelDatabasePool } from "@vercel/functions";
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryConfig,
  type QueryResultRow,
} from "pg";
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

export interface DatabaseTransactionBudget {
  readonly remainingMilliseconds: () => number;
  readonly expirationError: () => Error;
  readonly maximumConnectionMilliseconds: number;
  readonly maximumQueryMilliseconds: number;
  readonly minimumOperationHeadroomMilliseconds: number;
}

export interface DatabaseAccessOptions {
  readonly transactionBudget?: DatabaseTransactionBudget;
}

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

type TimeoutQueryConfig = QueryConfig<unknown[]> & { readonly query_timeout: number };

function remainingQueryTimeout(budget: DatabaseTransactionBudget): number {
  const remainingMilliseconds = budget.remainingMilliseconds();
  if (!Number.isFinite(remainingMilliseconds)) throw budget.expirationError();
  const timeout = Math.min(
    budget.maximumQueryMilliseconds,
    Math.floor(remainingMilliseconds - budget.minimumOperationHeadroomMilliseconds),
  );
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw budget.expirationError();
  return timeout;
}

function assertRemainingBudget(budget: DatabaseTransactionBudget): void {
  const remainingMilliseconds = budget.remainingMilliseconds();
  if (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0) {
    throw budget.expirationError();
  }
}

function assertConnectionHeadroom(budget: DatabaseTransactionBudget): void {
  const remainingMilliseconds = budget.remainingMilliseconds();
  if (!Number.isFinite(remainingMilliseconds)
      || remainingMilliseconds - budget.minimumOperationHeadroomMilliseconds
        <= budget.maximumConnectionMilliseconds) {
    throw budget.expirationError();
  }
}

async function boundedQuery(
  queryable: Pool | PoolClient,
  text: string,
  budget: DatabaseTransactionBudget,
  values?: unknown[],
  onResolved?: () => void,
): Promise<void> {
  const query: TimeoutQueryConfig = {
    text,
    ...(values ? { values } : {}),
    query_timeout: remainingQueryTimeout(budget),
  };
  await queryable.query(query);
  onResolved?.();
  assertRemainingBudget(budget);
}

async function persistBoundedCommitMeasurement(
  queryable: Pool | PoolClient,
  measurement: CommitMeasurement,
  budget: DatabaseTransactionBudget,
  onResolved?: () => void,
): Promise<void> {
  const durationMs = Math.max(0, measurement.durationMs);
  const latencyBucketMs = COMMIT_LATENCY_BUCKETS_MS.find((upper) => durationMs <= upper) ?? 60_000;
  await boundedQuery(
    queryable,
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
    budget,
    [measurement.outcome, latencyBucketMs, durationMs],
    onResolved,
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

export function databaseFromPool(pool: Pool, options: DatabaseAccessOptions = {}): EventDatabase {
  const transactionBudget = options.transactionBudget;
  if (transactionBudget) {
    if (!Number.isSafeInteger(transactionBudget.maximumConnectionMilliseconds)
        || transactionBudget.maximumConnectionMilliseconds <= 0
        || !Number.isSafeInteger(transactionBudget.maximumQueryMilliseconds)
        || transactionBudget.maximumQueryMilliseconds <= 0
        || !Number.isSafeInteger(transactionBudget.minimumOperationHeadroomMilliseconds)
        || transactionBudget.minimumOperationHeadroomMilliseconds < 0) {
      throw new Error("DATABASE_TRANSACTION_BUDGET_INVALID");
    }
    return databaseFor(pool, async (work) => {
      assertRemainingBudget(transactionBudget);
      const { measureCommit } = await import("../observability/metrics");
      assertConnectionHeadroom(transactionBudget);
      const client = await pool.connect();
      let commitAttempted = false;
      let committed = false;
      let commitMeasurement: CommitMeasurement | undefined;
      let releaseError: Error | undefined;
      let transactionError: unknown;
      let result: Awaited<ReturnType<typeof work>> | undefined;
      try {
        try {
          await boundedQuery(client, "begin", transactionBudget);
          result = await work(clientDatabase(client));
          assertRemainingBudget(transactionBudget);
          commitAttempted = true;
          await measureCommit(
            () => boundedQuery(
              client, "commit", transactionBudget, undefined, () => { committed = true; },
            ),
            (measurement) => { commitMeasurement = measurement; },
          );
          assertRemainingBudget(transactionBudget);
        } catch (error) {
          transactionError = error;
          if (!commitAttempted) {
            try {
              await boundedQuery(client, "rollback", transactionBudget);
            } catch (rollbackError) {
              releaseError = rollbackError instanceof Error
                ? rollbackError
                : new Error("DATABASE_ROLLBACK_FAILED");
            }
          } else if (!committed) {
            releaseError = error instanceof Error ? error : new Error("DATABASE_COMMIT_FAILED");
          }
        }

        if (transactionError === undefined && committed && commitMeasurement) {
          let metricResolved = false;
          try {
            await persistBoundedCommitMeasurement(
              client, commitMeasurement, transactionBudget, () => { metricResolved = true; },
            );
          } catch (error) {
            if (!metricResolved) {
              releaseError = error instanceof Error
                ? error
                : new Error("DATABASE_COMMIT_METRIC_FAILED");
            }
            try {
              assertRemainingBudget(transactionBudget);
            } catch (deadlineError) {
              transactionError = deadlineError;
            }
          }
        }

        try {
          assertRemainingBudget(transactionBudget);
        } catch (error) {
          transactionError = error;
        }
        if (transactionError !== undefined) throw transactionError;
        return result as Awaited<ReturnType<typeof work>>;
      } finally {
        client.release(releaseError);
      }
    });
  }
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

export function postgresPoolPolicy(
  env: Readonly<Record<string, string | undefined>>,
  attachDatabasePool: (pool: Pool) => void,
): { options: PoolConfig; attach: (pool: Pool) => void } {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  const isVercel = env.VERCEL === "1";
  return {
    options: {
      connectionString,
      application_name: "gustavo",
      max: isVercel ? 5 : 10,
      connectionTimeoutMillis: 5_000,
      ...(isVercel ? { idleTimeoutMillis: 5_000 } : {}),
      ...(env.GUSTAVO_DATABASE_SSL === "require"
        ? { ssl: { rejectUnauthorized: true } }
        : {}),
    },
    attach(pool): void {
      if (isVercel) {
        attachDatabasePool(pool);
      }
    },
  };
}

function configuredPool(): Pool {
  const policy = postgresPoolPolicy(process.env, attachVercelDatabasePool);
  const pool = new Pool(policy.options);
  policy.attach(pool);
  return pool;
}

export function getDatabase(options: DatabaseAccessOptions = {}): EventDatabase {
  if (!sharedDatabase) {
    sharedPool = configuredPool();
    sharedDatabase = databaseFromPool(sharedPool);
  }
  return options.transactionBudget
    ? databaseFromPool(sharedPool!, options)
    : sharedDatabase;
}

export async function closeDatabase(): Promise<void> {
  const pool = sharedPool;
  sharedDatabase = undefined;
  sharedPool = undefined;
  if (pool) {
    await pool.end();
  }
}
