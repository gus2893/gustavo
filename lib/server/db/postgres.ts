import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { EventDatabase } from "../events/types";

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

let sharedPool: Pool | undefined;
let sharedDatabase: EventDatabase | undefined;

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
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(clientDatabase(client));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
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
