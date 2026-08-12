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
import { appendChallengeLedgerEvent } from "../../lib/server/challenge/ledger";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";
import {
  createMainPaperOrderContext,
  createPaperWorkerContext,
  type MainPaperOrderContext,
  type PaperWorkerContext,
} from "../../lib/server/challenge/orders";
import {
  commitMainBaseline,
  openDecisionWindow,
  recordEvaluation,
} from "../../lib/server/orchestration/decision-window";
import { appendMessage } from "../../lib/server/history/messages";
import {
  createMemoryWorkerContext,
  processMemoryEvent,
} from "../../worker/consolidation/process-event";
import {
  createMemoryGraphWriterContext,
  versionMemoryGraph,
} from "../../lib/server/consolidation/graph";

const execFileAsync = promisify(execFile);
const TEST_CLUSTER_PREFIX = "gustavo-postgres-";
const originalRootKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
const originalRootKeyVersion = process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION;
const originalCursorSigningKey = process.env.GUSTAVO_CURSOR_SIGNING_KEY;

export interface TestDatabase extends EventDatabase {
  readonly schema: string;
}

export interface ConversationFixture {
  readonly db: TestDatabase;
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly sessionToken: string;
}

export interface ProtectedConversationFixture extends ConversationFixture {
  readonly sourceEventId: string;
  readonly memoryIds: readonly string[];
  readonly dataKeyId: string;
  readonly keys: {
    exists(dataKeyId: string): Promise<boolean>;
  };
  readonly cache: {
    find(text: string): Promise<readonly string[]>;
    purgeConversation(input: {
      readonly accountId: string;
      readonly nodeBrainId: string;
      readonly conversationId: string;
    }): Promise<void>;
  };
}

export interface ChallengeFixture {
  readonly db: TestDatabase;
  readonly challengePortfolioId: string;
  readonly profileVersionId: string;
  readonly stageId: string;
  readonly stageStartedEventId: string;
  readonly observationId: string;
  readonly decisionWindowId: string;
  readonly selectionEventId: string;
  readonly mainOrderContext: MainPaperOrderContext;
  readonly paperWorkerContext: PaperWorkerContext;
}

export interface ChallengeFixtureOptions {
  readonly sessionState?: "OPEN" | "CLOSED" | "PRE_MARKET" | "AFTER_HOURS" | "HALTED";
  readonly evidenceFresh?: boolean;
  readonly completedEvidence?: boolean;
  readonly selectedThesis?: string;
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

interface SchemaCleanupAction {
  readonly type: "close" | "drop";
  readonly name: string;
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

function planSchemaCleanupActions(
  schemaNames: readonly string[],
  includeDrops: boolean,
): SchemaCleanupAction[] {
  return schemaNames.flatMap((name) => [
    { type: "close" as const, name },
    ...(includeDrops ? [{ type: "drop" as const, name }] : []),
  ]);
}

export function planSchemaCleanupActionsForTest(
  schemaNames: readonly string[],
  includeDrops: boolean,
): SchemaCleanupAction[] {
  return planSchemaCleanupActions(schemaNames, includeDrops);
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

function removePostgresTempDirectory(
  dataDirectory: string,
  removeDirectory: typeof rmSync = rmSync,
): void {
  assertSafeDataDirectory(dataDirectory);
  removeDirectory(dataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export function removePostgresTempDirectoryForTest(
  dataDirectory: string,
  removeDirectory: typeof rmSync,
): void {
  removePostgresTempDirectory(dataDirectory, removeDirectory);
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
  if (originalCursorSigningKey === undefined) {
    delete process.env.GUSTAVO_CURSOR_SIGNING_KEY;
  } else {
    process.env.GUSTAVO_CURSOR_SIGNING_KEY = originalCursorSigningKey;
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
    run: () => removePostgresTempDirectory(server.dataDirectory),
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
  process.env.GUSTAVO_CURSOR_SIGNING_KEY ??= randomBytes(32).toString("base64");
  return database;
}

export async function testContext(): Promise<{ readonly db: TestDatabase }> {
  return { db: await openTestDb() };
}

export async function createChallengeDecisionFixture(
  db: TestDatabase,
  stageId: string,
  highWaterEventId: string,
  label: string,
  desiredRisk: string,
) {
  const marketObservationId = randomUUID();
  const geometry = Object.freeze({
    symbol: "AAPL" as const, direction: "LONG" as const, entry: "100.00" as const,
    stop: "95.00" as const, target: "110.00" as const, desiredRisk,
    expiresAt: "2026-08-09T01:00:00.000Z" as const,
  });
  await db.query(`insert into market_instrument_allowlist(symbol,asset_class,enabled)
    values ('AAPL','US_STOCK',true) on conflict (symbol) do nothing`);
  await db.query(`insert into market_data_sources(provider,license_id,licensed,redistribution)
    values ('ledger-fixture','ledger-v1',true,'INTERNAL_ONLY')
    on conflict (provider,license_id) do nothing`);
  await db.query(
    `insert into market_observations (
       id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
       raw_source_ref,feed_status,delay_seconds,redistribution,session_state
     ) values ($1,'AAPL','US_STOCK','100.00',$2,$2,'ledger-fixture','ledger-v1',
               $3,'REALTIME',0,'INTERNAL_ONLY','OPEN')`,
    [marketObservationId, "2026-08-09T00:00:00.000Z", `ledger:${label}:${marketObservationId}`],
  );
  const evidence = [{ kind: "MARKET_EVENT" as const, referenceId: marketObservationId }];
  const window = await openDecisionWindow({ db }, {
    marketObservationIds: [marketObservationId], evidence,
    portfolioSnapshot: { equity: "2500.00", highWaterId: highWaterEventId },
    costModelSnapshot: { policyVersion: INITIAL_PROFILE.costPolicyVersion },
    stageProfileVersion: INITIAL_PROFILE.profileVersionId, eligibleInstruments: ["AAPL"],
    idempotencyKey: `ledger-window:${label}:${stageId}`,
  });
  const main = await commitMainBaseline({ db }, {
    windowId: window.id, disposition: "THESIS", thesis: JSON.stringify(geometry), evidence,
    counterevidence: [], uncertainty: "Fixture thesis can invalidate at its stop.",
    idempotencyKey: `ledger-main:${label}:${stageId}`,
  });
  const evaluatorRunId = randomUUID();
  await db.query(`insert into model_runs (
      id,role,provider,model,prompt_version,policy_version,correlation_id,causation_id,
      input_tokens,output_tokens,max_input_tokens,max_output_tokens,completion_status,completed_at
    ) values ($1,'EVALUATOR','fake','ledger-fixture','fixture-prompt','fixture-policy',
      $2,$3,1,1,128,128,'COMPLETED',clock_timestamp())`,
  [evaluatorRunId, randomUUID(), main.eventId]);
  const selection = await recordEvaluation({ db }, {
    windowId: window.id, evaluatorRunId,
    scores: [{ candidateId: "main", components: {
      evidenceFreshness: 25, structuralClarity: 20, costAdjustedGeometry: 20,
      falsifiability: 15, uncertainty: 10, independence: 10,
    }, hardGates: { evidenceFresh: true, sessionValid: true, geometryComplete: true,
      nonDuplicate: true, authorized: true } }],
    idempotencyKey: `ledger-evaluation:${label}:${stageId}`,
  });
  return Object.freeze({
    decisionWindowId: window.id, selectionEventId: selection.selectionEventId,
    selectedCandidateId: "main", selectedCandidateEventId: main.eventId,
    selectedCandidateCommitmentDigest: main.commitmentDigest, evaluatorRunId,
    marketObservationId, geometry,
  });
}

export async function testChallengeContext(
  options: ChallengeFixtureOptions = {},
): Promise<ChallengeFixture> {
  const db = await openTestDb();
  const stageId = randomUUID();
  const stageStartedEventId = randomUUID();
  const observationId = randomUUID();
  const stageStartedAt = "2026-08-09T14:00:00.000Z";
  const observedAt = "2026-08-09T15:00:00.000Z";

  await db.query(
    `insert into challenge_stages (
       id, challenge_portfolio_id, profile_version_id, stage_profile_id,
       ordinal, created_at
     ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
    [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
      stageStartedAt],
  );
  await appendChallengeLedgerEvent({ db }, {
    id: stageStartedEventId,
    challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
    stageId,
    profileVersionId: INITIAL_PROFILE.profileVersionId,
    type: "stage.started",
    payload: { amount: "2500.00" },
    occurredAt: stageStartedAt,
    actorType: "SYSTEM",
    actorId: "challenge-test-fixture",
    idempotencyKey: `challenge-test-stage:${stageId}`,
  });
  await db.query(
    `insert into market_instrument_allowlist (symbol, asset_class, enabled, updated_at)
     values ('AAPL','US_STOCK',true,$1)`,
    [stageStartedAt],
  );
  await db.query(
    `insert into market_data_sources (
       provider, license_id, licensed, redistribution, created_at
     ) values ('licensed-feed','license-v1',true,'INTERNAL_ONLY',$1)`,
    [stageStartedAt],
  );
  await db.query(
    `insert into market_observations (
       id, symbol, asset_class, price, observed_at, received_at,
       provider, license_id, raw_source_ref, feed_status, delay_seconds,
       redistribution, session_state, created_at
     ) values ($1,'AAPL','US_STOCK','100.00',$2,$2,'licensed-feed','license-v1',
               $3,'REALTIME',0,'INTERNAL_ONLY',$4,$2)`,
    [observationId, observedAt, `fixture:${observationId}`, options.sessionState ?? "OPEN"],
  );
  if (options.completedEvidence ?? true) {
    await db.query(
      `insert into market_bars (
         id, source_observation_id, symbol, asset_class, provider, timeframe,
         started_at, ended_at, open_price, high_price, low_price, close_price,
         completed, created_at
       ) values ($1,$2,'AAPL','US_STOCK','licensed-feed','15m',$3,$4,
                 '99.00','101.00','98.00','100.00',true,$4)`,
      [randomUUID(), observationId, "2026-08-09T14:45:00.000Z", observedAt],
    );
  }

  const evidence = [{ kind: "MARKET_EVENT" as const, referenceId: observationId }];
  const window = await openDecisionWindow({ db }, {
    marketObservationIds: [observationId],
    evidence,
    portfolioSnapshot: { equity: "2500.00", highWaterId: stageStartedEventId },
    costModelSnapshot: { policyVersion: INITIAL_PROFILE.costPolicyVersion },
    stageProfileVersion: INITIAL_PROFILE.profileVersionId,
    eligibleInstruments: ["AAPL"],
    idempotencyKey: `challenge-test-window:${stageId}`,
  });
  const main = await commitMainBaseline({ db }, {
    windowId: window.id,
    disposition: "THESIS",
    thesis: options.selectedThesis ?? JSON.stringify({
      direction: "LONG",
      entry: "100.00",
      expiresAt: "2026-08-09T20:00:00.000Z",
      desiredRisk: "25.00",
      stop: "97.50",
      symbol: "AAPL",
      target: "105.00",
    }),
    evidence,
    counterevidence: [],
    uncertainty: "The simulated entry can expire or invalidate at its structural stop.",
    idempotencyKey: `challenge-test-main:${stageId}`,
  });
  const evaluatorRunId = randomUUID();
  await db.query(
    `insert into model_runs (
       id, role, provider, model, prompt_version, policy_version,
       correlation_id, causation_id, input_tokens, output_tokens,
       max_input_tokens, max_output_tokens, completion_status, completed_at
     ) values ($1,'EVALUATOR','fake','fixture-evaluator','fixture-prompt','fixture-policy',
               $2,$3,1,1,128,128,'COMPLETED',clock_timestamp())`,
    [evaluatorRunId, randomUUID(), main.eventId],
  );
  const selection = await recordEvaluation({ db }, {
    windowId: window.id,
    evaluatorRunId,
    scores: [{
      candidateId: "main",
      components: {
        evidenceFreshness: 25,
        structuralClarity: 20,
        costAdjustedGeometry: 20,
        falsifiability: 15,
        uncertainty: 10,
        independence: 10,
      },
      hardGates: {
        evidenceFresh: options.evidenceFresh ?? true,
        sessionValid: true,
        geometryComplete: true,
        nonDuplicate: true,
        authorized: true,
      },
    }],
    idempotencyKey: `challenge-test-evaluation:${stageId}`,
  });

  return Object.freeze({
    db,
    challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
    profileVersionId: INITIAL_PROFILE.profileVersionId,
    stageId,
    stageStartedEventId,
    observationId,
    decisionWindowId: window.id,
    selectionEventId: selection.selectionEventId,
    mainOrderContext: createMainPaperOrderContext(db),
    paperWorkerContext: createPaperWorkerContext(db),
  });
}

export async function createConversationFixture(
  label: string,
  database?: TestDatabase,
): Promise<ConversationFixture> {
  const db = database ?? await openTestDb();
  const accountId = randomUUID();
  const nodeBrainId = randomUUID();
  const conversationId = randomUUID();
  const sessionId = randomUUID();
  const sessionToken = generateOpaqueToken();
  const now = new Date();
  const sessionExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

  await db.transaction(async (transaction) => {
    await transaction.query(
      "insert into accounts (id, display_name, created_at) values ($1, $2, $3)",
      [accountId, label, now],
    );
    await transaction.query(
      `insert into entitlements (id, account_id, active_from, created_at)
       values ($1, $2, $3, $3)`,
      [randomUUID(), accountId, now],
    );
    await transaction.query(
      `insert into node_brains (id, account_id, name, created_at)
       values ($1, $2, $3, $4)`,
      [nodeBrainId, accountId, `${label} Node`, now],
    );
    await transaction.query(
      `insert into conversations (id, account_id, node_brain_id, created_at)
       values ($1, $2, $3, $4)`,
      [conversationId, accountId, nodeBrainId, now],
    );
    await transaction.query(
      `insert into sessions
        (id, account_id, token_hash, created_at, expires_at, last_rotated_at)
       values ($1, $2, $3, $4, $5, $4)`,
      [
        sessionId,
        accountId,
        hashOpaqueToken(sessionToken),
        now,
        sessionExpiresAt,
      ],
    );
  });

  return {
    db,
    accountId,
    nodeBrainId,
    conversationId,
    sessionId,
    sessionToken,
  };
}

class ProtectedConversationCache {
  readonly #values = new Map<string, { readonly conversationId: string; readonly text: string }>();

  seed(conversationId: string, text: string): void {
    this.#values.set(`${conversationId}:${this.#values.size}`, { conversationId, text });
  }

  async find(text: string): Promise<readonly string[]> {
    return Object.freeze([...this.#values.values()]
      .filter((value) => value.text.includes(text)).map(({ text: value }) => value));
  }

  async purgeConversation(input: { readonly conversationId: string }): Promise<void> {
    for (const [key, value] of this.#values) {
      if (value.conversationId === input.conversationId) this.#values.delete(key);
    }
  }
}

export async function seedProtectedConversation(
  label: string,
  text: string,
  database?: TestDatabase,
): Promise<ProtectedConversationFixture> {
  const fixture = await createConversationFixture(label, database);
  const message = await appendMessage({
    db: fixture.db,
    accountId: fixture.accountId,
    conversationId: fixture.conversationId,
  }, {
    role: "USER",
    text,
    idempotencyKey: `privacy-source:${label}`,
  });
  const sourceAt = message.occurredAt;
  const observedAt = new Date(new Date(sourceAt).getTime() + 1).toISOString();
  const projected = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
    scope: "PRIVATE_ACCOUNT",
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventId: message.eventId,
    events: [{ id: message.eventId, at: sourceAt, text }],
    extracted: {
      facts: [{
        text,
        sourceIds: [message.eventId],
        keywords: ["secret", "preference"],
        entities: ["privacy-subject"],
        embedding: [0.25, -0.5, 0.75],
      }, {
        text: `Context for ${text}`,
        sourceIds: [message.eventId],
        keywords: ["context", "preference"],
        entities: ["privacy-context"],
      }],
    },
    versions: {
      promptVersion: "privacy-fixture-prompt-v1",
      modelVersion: "deterministic-privacy-fixture-v1",
      extractorVersion: "privacy-fixture-extractor-v1",
      embeddingVersion: "privacy-fixture-embedding-v1",
    },
    observedAt,
    idempotencyKey: `privacy-consolidation:${label}`,
  });
  const entityOne = randomUUID();
  const entityTwo = randomUUID();
  const firstMemory = projected.memories[0]!;
  const secondMemory = projected.memories[1]!;
  await versionMemoryGraph(createMemoryGraphWriterContext(fixture.db), {
    scope: "PRIVATE_ACCOUNT",
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    idempotencyKey: `privacy-graph:${label}`,
    reconcilerVersion: "temporal-memory-graph-v2",
    observedAt: new Date(new Date(sourceAt).getTime() + 2).toISOString(),
    entities: [{
      id: entityOne,
      type: "METHOD",
      canonicalName: firstMemory.entities[0]!,
      validFrom: sourceAt,
      aliases: [{ alias: firstMemory.entities[0]!, validFrom: sourceAt, sourceIds: [message.eventId] }],
    }, {
      id: entityTwo,
      type: "METHOD",
      canonicalName: secondMemory.entities[0]!,
      validFrom: sourceAt,
      aliases: [{ alias: secondMemory.entities[0]!, validFrom: sourceAt, sourceIds: [message.eventId] }],
    }],
    claims: [{
      memoryId: firstMemory.id,
      entityId: entityOne,
      nodeType: "FACT",
      predicate: firstMemory.keywords[0]!,
      value: firstMemory.keywords[1]!,
      approved: true,
      validFrom: sourceAt,
      sourceIds: [message.eventId],
    }, {
      memoryId: secondMemory.id,
      entityId: entityTwo,
      nodeType: "FACT",
      predicate: secondMemory.keywords[0]!,
      value: secondMemory.keywords[1]!,
      approved: true,
      validFrom: sourceAt,
      sourceIds: [message.eventId],
    }],
  });
  const key = await fixture.db.one<{ id: string }>(
    "select id::text from aggregate_data_keys where aggregate_id=$1",
    [fixture.conversationId],
  );
  const cache = new ProtectedConversationCache();
  cache.seed(fixture.conversationId, text);
  return Object.freeze({
    ...fixture,
    sourceEventId: message.eventId,
    memoryIds: Object.freeze(projected.memories.map(({ id }) => id)),
    dataKeyId: key.id,
    keys: Object.freeze({
      exists: async (dataKeyId: string) => (await fixture.db.query(
        "select 1 from aggregate_data_keys where id=$1",
        [dataKeyId],
      )).length === 1,
    }),
    cache,
  });
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
  const schemaAdmin = server?.admin;
  const resourcesByName = new Map(schemas.map((resource) => [resource.name, resource]));
  const schemaActions = planSchemaCleanupActions(
    schemas.map((resource) => resource.name),
    Boolean(schemaAdmin && server && !server.started),
  );
  for (const action of schemaActions) {
    const resource = resourcesByName.get(action.name)!;
    if (action.type === "close") {
      steps.push({ name: `close schema pool:${resource.name}`, run: () => resource.pool.end() });
    } else {
      steps.push({
        name: `drop schema:${resource.name}`,
        run: async () => {
          if (!/^test_[a-f0-9]{32}$/.test(resource.name)) {
            throw new Error("UNSAFE_TEST_SCHEMA_NAME");
          }
          await schemaAdmin!.query(`drop schema if exists ${resource.name} cascade`);
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
