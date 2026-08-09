import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll } from "vitest";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from "../../lib/server/auth/sessions";
import type { EventDatabase } from "../../lib/server/events/types";

const execFileAsync = promisify(execFile);
const TEST_CLUSTER_PREFIX = "gustavo-postgres-";
const originalRootKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
const originalRootKeyVersion = process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION;

export interface TestDatabase extends EventDatabase {
  readonly schema: string;
}

interface PartialTestPostgresServer {
  admin?: Pool;
  readonly binDirectory: string;
  readonly dataDirectory: string;
  port?: number;
  started: boolean;
}

interface TestPostgresServer extends PartialTestPostgresServer {
  admin: Pool;
  port: number;
  started: true;
}

export interface TestPostgresStartupOverrides {
  readonly createDataDirectory?: () => string;
  readonly reservePort?: () => Promise<number>;
}

interface SchemaResource {
  readonly name: string;
  readonly pool: Pool;
}

let serverPromise: Promise<TestPostgresServer> | undefined;
let partialServer: PartialTestPostgresServer | undefined;
const schemas: SchemaResource[] = [];

export interface CleanupStep {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export async function runCleanupSteps(steps: readonly CleanupStep[]): Promise<void> {
  const failures: { readonly name: string; readonly cause: unknown }[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      failures.push({ name: step.name, cause });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ cause }) => cause),
      `TEST_RESOURCE_CLEANUP_FAILED:${failures.map(({ name }) => name).join(",")}`,
    );
  }
}

function executable(directory: string, name: string): string {
  return join(directory, process.platform === "win32" ? `${name}.exe` : name);
}

function postgresBinCandidates(): string[] {
  const configured = process.env.GUSTAVO_TEST_POSTGRES_BIN;
  const candidates = configured ? [configured] : [];
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const root = join(programFiles, "PostgreSQL");
    if (existsSync(root)) {
      const versions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)*$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => Number(right.split(".")[0]) - Number(left.split(".")[0]));
      candidates.push(...versions.map((version) => join(root, version, "bin")));
    }
  } else {
    const root = "/usr/lib/postgresql";
    if (existsSync(root)) {
      candidates.push(
        ...readdirSync(root)
          .sort((left, right) => Number(right) - Number(left))
          .map((version) => join(root, version, "bin")),
      );
    }
    candidates.push("/usr/local/bin", "/usr/bin");
  }
  return candidates;
}

function resolvePostgresBin(): string {
  const directory = postgresBinCandidates().find(
    (candidate) =>
      existsSync(executable(candidate, "initdb")) &&
      existsSync(executable(candidate, "pg_ctl")),
  );
  if (!directory) {
    throw new Error(
      "TEST_POSTGRES_NOT_FOUND: set GUSTAVO_TEST_POSTGRES_BIN to a local PostgreSQL bin directory",
    );
  }
  return directory;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("TEST_POSTGRES_PORT_RESERVATION_FAILED"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function runWithoutInheritedPipes(command: string, arguments_: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`TEST_POSTGRES_COMMAND_FAILED:${code ?? "signal"}`));
      }
    });
  });
}

function assertSafeDataDirectory(dataDirectory: string): void {
  if (!dataDirectory.startsWith(join(tmpdir(), TEST_CLUSTER_PREFIX))) {
    throw new Error("UNSAFE_TEST_POSTGRES_DIRECTORY");
  }
}

function restoreRootKeyEnvironment(): void {
  if (originalRootKey === undefined) {
    delete process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
  } else {
    process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = originalRootKey;
  }
  if (originalRootKeyVersion === undefined) {
    delete process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION;
  } else {
    process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION = originalRootKeyVersion;
  }
}

function serverCleanupSteps(server: PartialTestPostgresServer): CleanupStep[] {
  const steps: CleanupStep[] = [];
  if (server.admin) {
    steps.push({ name: "close postgres admin pool", run: () => server.admin!.end() });
  }
  if (server.started) {
    steps.push({
      name: "stop postgres",
      run: async () => {
        await execFileAsync(
          executable(server.binDirectory, "pg_ctl"),
          ["-D", server.dataDirectory, "-m", "fast", "-t", "10", "-w", "stop"],
          { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        );
        server.started = false;
      },
    });
  }
  steps.push({
    name: "remove postgres temp directory",
    run: () => {
      assertSafeDataDirectory(server.dataDirectory);
      rmSync(server.dataDirectory, { recursive: true, force: true });
    },
  });
  return steps;
}

async function cleanupPartialServer(server: PartialTestPostgresServer): Promise<void> {
  await runCleanupSteps([
    ...serverCleanupSteps(server),
    { name: "restore root-key environment", run: restoreRootKeyEnvironment },
  ]);
  if (partialServer === server) {
    partialServer = undefined;
  }
}

async function startTestPostgres(
  overrides: TestPostgresStartupOverrides = {},
): Promise<TestPostgresServer> {
  const binDirectory = resolvePostgresBin();
  const dataDirectory =
    overrides.createDataDirectory?.() ?? mkdtempSync(join(tmpdir(), TEST_CLUSTER_PREFIX));
  const server: PartialTestPostgresServer = {
    binDirectory,
    dataDirectory,
    started: false,
  };
  // Register ownership immediately after creation. Every later boundary,
  // including validation and port reservation, is cleanup-protected.
  partialServer = server;
  try {
    assertSafeDataDirectory(dataDirectory);
    const port = await (overrides.reservePort?.() ?? reserveLoopbackPort());
    server.port = port;
    await execFileAsync(
      executable(binDirectory, "initdb"),
      ["-D", dataDirectory, "-A", "trust", "-U", "postgres", "--encoding=UTF8", "--no-locale", "--no-sync"],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    // Mark the server as requiring a stop attempt before launch so a failure
    // after postgres forks but before pg_ctl resolves cannot orphan the child.
    server.started = true;
    await runWithoutInheritedPipes(
      executable(binDirectory, "pg_ctl"),
      [
        "-D",
        dataDirectory,
        "-l",
        join(dataDirectory, "postgres.log"),
        "-o",
        `-h 127.0.0.1 -p ${port} -c fsync=off -c synchronous_commit=off`,
        "-w",
        "-t",
        "10",
        "start",
      ],
    );
    const admin = new Pool({
      host: "127.0.0.1",
      port,
      database: "postgres",
      user: "postgres",
      max: 2,
      connectionTimeoutMillis: 2_000,
    });
    server.admin = admin;
    await admin.query("select 1");
    return server as TestPostgresServer;
  } catch (error) {
    try {
      await cleanupPartialServer(server);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "TEST_POSTGRES_STARTUP_FAILED_WITH_CLEANUP_ERRORS",
      );
    }
    throw error;
  }
}

export async function startTestPostgresWithOverridesForTest(
  overrides: TestPostgresStartupOverrides,
): Promise<void> {
  await startTestPostgres(overrides);
}

function testServer(): Promise<TestPostgresServer> {
  serverPromise ??= startTestPostgres();
  return serverPromise;
}

interface PgQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

function databaseFor(
  queryable: PgQueryable,
  schema: string,
  transactionFactory: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => Promise<Result>,
): TestDatabase {
  const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Row[]> => {
    const result = await queryable.query<Row>(sql, [...parameters]);
    return result.rows;
  };
  return {
    schema,
    query,
    async one<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row> {
      const rows = await query<Row>(sql, parameters);
      if (rows.length !== 1) {
        throw new Error(`EXPECTED_ONE_ROW:${rows.length}`);
      }
      return rows[0];
    },
    transaction: transactionFactory,
  };
}

function poolDatabase(pool: Pool, schema: string): TestDatabase {
  const transaction = async <Result>(
    work: (transaction: EventDatabase) => Promise<Result>,
  ): Promise<Result> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const scoped = clientDatabase(client, schema);
      const result = await work(scoped);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  return databaseFor(pool, schema, transaction);
}

function clientDatabase(client: PoolClient, schema: string): TestDatabase {
  let database: TestDatabase;
  database = databaseFor(client, schema, async (work) => work(database));
  return database;
}

export async function openTestDb(): Promise<TestDatabase> {
  const server = await testServer();
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await server.admin.query(`create schema ${schema}`);
  const pool = new Pool({
    host: "127.0.0.1",
    port: server.port,
    database: "postgres",
    user: "postgres",
    max: 4,
    options: `-c search_path=${schema}`,
  });
  schemas.push({ name: schema, pool });
  const database = poolDatabase(pool, schema);
  const migrationDirectory = join("db", "migrations");
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const migrationName of migrations) {
    const migration = await readFile(join(migrationDirectory, migrationName), "utf8");
    await database.query(migration);
  }
  process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION = "1";
  process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = randomBytes(32).toString("base64");
  return database;
}

export async function testContext(): Promise<{ readonly db: TestDatabase }> {
  return { db: await openTestDb() };
}

export async function seedInvitation(
  database: TestDatabase,
  options: {
    readonly expiresAt: Date;
    readonly revokedAt?: Date;
  },
): Promise<string> {
  const token = generateOpaqueToken();
  const invitationId = randomUUID();
  const expiresAt = new Date(options.expiresAt);
  const issuedAt = new Date(
    Math.min(Date.now(), expiresAt.getTime() - 24 * 60 * 60 * 1_000),
  );
  await database.query(
    `insert into invitations
      (id, token_hash, issued_by_actor_id, issued_at, expires_at, revoked_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      invitationId,
      hashOpaqueToken(token),
      "test-operator",
      issuedAt,
      expiresAt,
      options.revokedAt ?? null,
    ],
  );
  return token;
}

afterAll(async () => {
  const resolvedServer = serverPromise
    ? await serverPromise.catch(() => undefined)
    : undefined;
  const server = resolvedServer ?? partialServer;
  const steps: CleanupStep[] = [];
  for (const resource of schemas) {
    steps.push({ name: `close schema pool:${resource.name}`, run: () => resource.pool.end() });
    if (server?.admin) {
      steps.push({
        name: `drop schema:${resource.name}`,
        run: async () => {
          if (!/^test_[a-f0-9]{32}$/.test(resource.name)) {
            throw new Error("UNSAFE_TEST_SCHEMA_NAME");
          }
          await server.admin!.query(`drop schema if exists ${resource.name} cascade`);
        },
      });
    }
  }
  if (server) {
    steps.push(...serverCleanupSteps(server));
  }
  steps.push({
    name: "restore root-key environment",
    run: restoreRootKeyEnvironment,
  });
  await runCleanupSteps(steps);
  partialServer = undefined;
}, 30_000);
