import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, FullConfig } from "@playwright/test";
import { Pool } from "pg";
import { databaseFromPool } from "../../lib/server/db/postgres";
import {
  appendChallengeLedgerEvent,
  loadChallengeLedgerEvents,
  replaceProjectionCheckpoint,
} from "../../lib/server/challenge/ledger";
import {
  createMainPaperOrderContext,
  createPaperWorkerContext,
  processPaperOrder,
  submitPaperIntent,
} from "../../lib/server/challenge/orders";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";
import { replayStoredLedgerEvents } from "../../lib/server/challenge/projection";
import { appendEvent } from "../../lib/server/events/store";
import {
  commitMainBaseline,
  openDecisionWindow,
  recordEvaluation,
} from "../../lib/server/orchestration/decision-window";

const execFileAsync = promisify(execFile);
const E2E_DATABASE_PREFIX = "gustavo-e2e-postgres-";
const TEST_PROVIDER = "gustavo-e2e-licensed";
const TEST_LICENSE = "e2e-license-v1";

interface E2eRuntime {
  dataDirectory: string;
  postgresBin: string;
  admin: Pool;
  web: ChildProcess;
}

export interface OwnedChildStatus {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export interface LicensedObservationFixture {
  readonly symbol: string;
  readonly price: string;
  readonly feedStatus: "REALTIME" | "DELAYED";
  readonly delaySeconds: number;
}

function executable(directory: string, name: string): string {
  return join(directory, process.platform === "win32" ? `${name}.exe` : name);
}

function postgresBin(): string {
  const configured = process.env.GUSTAVO_TEST_POSTGRES_BIN;
  const candidates: string[] = configured ? [configured] : [];
  if (process.platform === "win32") {
    const root = join(process.env.ProgramFiles ?? "C:\\Program Files", "PostgreSQL");
    if (existsSync(root)) {
      candidates.push(...readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)*$/u.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => Number(right.split(".")[0]) - Number(left.split(".")[0]))
        .map((version) => join(root, version, "bin")));
    }
  } else {
    for (const root of ["/usr/lib/postgresql", "/usr/local/bin", "/usr/bin"]) {
      if (!existsSync(root)) continue;
      if (root.endsWith("postgresql")) {
        candidates.push(...readdirSync(root)
          .sort((left, right) => Number(right) - Number(left))
          .map((version) => join(root, version, "bin")));
      } else {
        candidates.push(root);
      }
    }
  }
  const found = candidates.find((candidate) => (
    existsSync(executable(candidate, "initdb"))
      && existsSync(executable(candidate, "pg_ctl"))
  ));
  if (!found) {
    throw new Error(
      "E2E_POSTGRES_NOT_FOUND: set GUSTAVO_TEST_POSTGRES_BIN to a local PostgreSQL bin directory",
    );
  }
  return found;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("E2E_POSTGRES_PORT_RESERVATION_FAILED"));
        return;
      }
      server.close((error) => (
        error ? reject(error) : resolvePort(address.port)
      ));
    });
  });
}

export async function assertLoopbackPortAvailable(port: number): Promise<void> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_WEB_PORT_INVALID");
  }
  await new Promise<void>((resolveAvailable, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error("E2E_WEB_PORT_PREOCCUPIED")));
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => error ? reject(error) : resolveAvailable());
    });
  });
}

export function e2eBaseURL(): string {
  const configured = process.env.GUSTAVO_E2E_BASE_URL;
  if (!configured) throw new Error("E2E_BASE_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("E2E_BASE_URL_INVALID");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
      || parsed.port === "" || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("E2E_BASE_URL_INVALID");
  }
  return parsed.origin;
}

async function runWithoutInheritedPipes(command: string, arguments_: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, arguments_, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`E2E_POSTGRES_COMMAND_FAILED:${code ?? "signal"}`));
    });
  });
}

function assertSafeDataDirectory(dataDirectory: string): void {
  const expectedParent = resolve(tmpdir());
  const target = resolve(dataDirectory);
  if (
    !target.startsWith(`${expectedParent}${process.platform === "win32" ? "\\" : "/"}`)
    || !target.split(/[\\/]/u).at(-1)?.startsWith(E2E_DATABASE_PREFIX)
  ) {
    throw new Error("UNSAFE_E2E_POSTGRES_DIRECTORY");
  }
}

async function applyMigrations(pool: Pool): Promise<void> {
  const migrations = readdirSync(join(process.cwd(), "db", "migrations"))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const name of migrations) {
    const sql = await readFile(join(process.cwd(), "db", "migrations", name), "utf8");
    await pool.query(sql);
  }
}

function ownedChildExitError(status: OwnedChildStatus, output: string): Error {
  return new Error(
    `E2E_WEB_EXITED:code=${status.exitCode ?? "null"}`
      + `:signal=${status.signalCode ?? "null"}\n${output}`,
  );
}

export function assertOwnedChildAlive(status: OwnedChildStatus, output: string): void {
  if (status.exitCode !== null || status.signalCode !== null) {
    throw ownedChildExitError(status, output);
  }
}

async function waitForWeb(baseURL: string, web: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  const ended = new Promise<{ readonly error: Error }>((resolveEnd) => {
    web.once("error", (error) => resolveEnd({
      error: new Error(`E2E_WEB_SPAWN_FAILED:${error.message}\n${output()}`),
    }));
    web.once("exit", (exitCode, signalCode) => resolveEnd({
      error: ownedChildExitError({ exitCode, signalCode }, output()),
    }));
  });
  while (Date.now() < deadline) {
    assertOwnedChildAlive(web, output());
    const attempt = (async (): Promise<"READY" | "RETRY"> => {
      try {
        const response = await fetch(baseURL, { signal: AbortSignal.timeout(1_000) });
        if (!response.ok) return "RETRY";
        const html = await response.text();
        if (!html.includes("<h1>Gustavo</h1>")
            || !html.includes('data-testid="public-feed"')) {
          throw new Error("E2E_WEB_READINESS_MARKER_MISSING");
        }
        assertOwnedChildAlive(web, output());
        return "READY";
      } catch (error) {
        assertOwnedChildAlive(web, output());
        if (error instanceof Error && error.message === "E2E_WEB_READINESS_MARKER_MISSING") {
          throw error;
        }
        return "RETRY";
      }
    })();
    const outcome = await Promise.race([attempt, ended]);
    if (typeof outcome === "object") throw outcome.error;
    if (outcome === "READY") return;
    const retry = await Promise.race([
      new Promise<"RETRY">((resolveRetry) => setTimeout(() => resolveRetry("RETRY"), 250)),
      ended,
    ]);
    if (typeof retry === "object") throw retry.error;
    // The owned Next server is still starting.
    if (Date.now() >= deadline) {
      break;
    }
  }
  throw new Error(`E2E_WEB_START_TIMEOUT\n${output()}`);
}

async function stopWeb(web: ChildProcess): Promise<void> {
  if (web.exitCode !== null) return;
  web.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => web.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (web.exitCode === null && web.pid !== undefined) {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/pid", String(web.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => undefined);
    } else {
      web.kill("SIGKILL");
    }
  }
}

async function cleanup(runtime: Partial<E2eRuntime>): Promise<void> {
  const failures: unknown[] = [];
  if (runtime.web) {
    await stopWeb(runtime.web).catch((error: unknown) => failures.push(error));
  }
  if (runtime.admin) {
    await runtime.admin.end().catch((error: unknown) => failures.push(error));
  }
  if (runtime.postgresBin && runtime.dataDirectory) {
    await execFileAsync(
      executable(runtime.postgresBin, "pg_ctl"),
      ["-D", runtime.dataDirectory, "-m", "fast", "-t", "10", "-w", "stop"],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    ).catch((error: unknown) => failures.push(error));
  }
  if (runtime.dataDirectory) {
    try {
      assertSafeDataDirectory(runtime.dataDirectory);
      rmSync(runtime.dataDirectory, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "E2E_CLEANUP_FAILED");
  }
}

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("E2E_FIXTURES_PRODUCTION_FORBIDDEN");
  }
  if (config.metadata.reuseExistingServer !== false) {
    throw new Error("E2E_SERVER_REUSE_FORBIDDEN");
  }
  const runtime: Partial<E2eRuntime> = {};
  try {
    process.stderr.write("[e2e setup] starting disposable PostgreSQL\n");
    runtime.postgresBin = postgresBin();
    runtime.dataDirectory = mkdtempSync(join(tmpdir(), E2E_DATABASE_PREFIX));
    assertSafeDataDirectory(runtime.dataDirectory);
    const databasePort = await reserveLoopbackPort();
    await execFileAsync(executable(runtime.postgresBin, "initdb"), [
      "-D", runtime.dataDirectory,
      "-A", "trust",
      "-U", "postgres",
      "--encoding=UTF8",
      "--no-locale",
      "--no-sync",
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    await runWithoutInheritedPipes(executable(runtime.postgresBin, "pg_ctl"), [
      "-D", runtime.dataDirectory,
      "-l", join(runtime.dataDirectory, "postgres.log"),
      "-o", `-h 127.0.0.1 -p ${databasePort} -c fsync=off -c synchronous_commit=off`,
      "-w", "-t", "10", "start",
    ]);

    const databaseURL = `postgresql://postgres@127.0.0.1:${databasePort}/postgres`;
    runtime.admin = new Pool({ connectionString: databaseURL, max: 4 });
    process.stderr.write("[e2e setup] applying migrations\n");
    await applyMigrations(runtime.admin);
    process.stderr.write("[e2e setup] migrations applied\n");

    const webPort = await reserveLoopbackPort();
    const baseURL = `http://127.0.0.1:${webPort}`;
    process.env.DATABASE_URL = databaseURL;
    process.env.GUSTAVO_APP_ORIGIN = baseURL;
    process.env.GUSTAVO_E2E_BASE_URL = baseURL;
    process.env.GUSTAVO_TEST_FIXTURES_ENABLED = "true";
    process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION = "1";
    process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = randomBytes(32).toString("base64");
    process.env.GUSTAVO_CURSOR_SIGNING_KEY = randomBytes(32).toString("base64");

    let serverOutput = "";
    const nextBin = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
    // This harness always owns a new server. It never reuses an existing process.
    await assertLoopbackPortAvailable(webPort);
    runtime.web = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(webPort)], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk: Buffer): void => {
      serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-16_384);
    };
    runtime.web.stdout?.on("data", capture);
    runtime.web.stderr?.on("data", capture);
    process.stderr.write("[e2e setup] waiting for Next\n");
    await waitForWeb(baseURL, runtime.web, () => serverOutput);
    process.stderr.write("[e2e setup] Next is ready\n");
    const owned = runtime as E2eRuntime;
    return async () => cleanup(owned);
  } catch (error) {
    await cleanup(runtime).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "E2E_SETUP_FAILED_WITH_CLEANUP_ERRORS");
    });
    throw error;
  }
}

function databaseURL(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("E2E_DATABASE_URL_REQUIRED");
  return value;
}

export async function issueInvitation(_request: APIRequestContext): Promise<string> {
  const pool = new Pool({ connectionString: databaseURL(), max: 1 });
  try {
    const database = databaseFromPool(pool);
    const invitationId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 15 * 60 * 1_000);
    await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into invitations
          (id,token_hash,issued_by_actor_id,issued_at,expires_at)
         values ($1,$2,$3,$4,$5)`,
        [invitationId, tokenHash, "operator:e2e", issuedAt, expiresAt],
      );
      const event = await appendEvent(transaction, {
        aggregateId: "operator:invitations",
        actor: { type: "OPERATOR", id: "operator:e2e" },
        type: "invitation.issued",
        visibility: "OPERATOR",
        body: { invitationId, expiresAt: expiresAt.toISOString() },
        idempotencyKey: `invitation-issued:${invitationId}`,
        occurredAt: issuedAt,
        policyVersion: "editorial-policy-v1",
      });
      await transaction.query(
        "update invitations set issue_event_id=$2 where id=$1",
        [invitationId, event.id],
      );
    });
    return token;
  } finally {
    await pool.end();
  }
}

export async function seedLicensedObservation(
  _request: APIRequestContext,
  input: LicensedObservationFixture,
): Promise<{ readonly observedAt: string }> {
  const pool = new Pool({ connectionString: databaseURL(), max: 1 });
  const receivedAt = new Date();
  const observedAt = new Date(receivedAt.getTime() - input.delaySeconds * 1_000);
  try {
    const database = databaseFromPool(pool);
    const stageId = randomUUID();
    const stageStartedEventId = randomUUID();
    const stageStartedAt = new Date(receivedAt.getTime() - 60_000).toISOString();
    await database.query(
      `insert into challenge_stages (
         id,challenge_portfolio_id,profile_version_id,stage_profile_id,ordinal,created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
      [stageId, INITIAL_PROFILE.challengePortfolioId,
        INITIAL_PROFILE.profileVersionId, stageStartedAt],
    );
    await appendChallengeLedgerEvent({ db: database }, {
      id: stageStartedEventId,
      challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      type: "stage.started",
      payload: { amount: "2500.00" },
      occurredAt: stageStartedAt,
      actorType: "SYSTEM",
      actorId: "e2e-challenge-fixture",
      idempotencyKey: `e2e-stage:${stageId}`,
    });
    await pool.query(
      `insert into market_instrument_allowlist (symbol,asset_class)
       values ($1,'US_STOCK') on conflict (symbol) do nothing`,
      [input.symbol],
    );
    const observationId = randomUUID();
    await pool.query(
      `insert into market_data_sources (provider,license_id,licensed,redistribution)
       values ($1,$2,true,'ACCOUNT_ONLY')
       on conflict (provider,license_id) do nothing`,
      [TEST_PROVIDER, TEST_LICENSE],
    );
    await pool.query(
      `insert into market_observations (
         id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
         raw_source_ref,feed_status,delay_seconds,redistribution,session_state
       ) values ($1,$2,'US_STOCK',$3,$4,$5,$6,$7,$8,$9,$10,'ACCOUNT_ONLY','OPEN')`,
      [
        observationId, input.symbol, input.price, observedAt, receivedAt,
        TEST_PROVIDER, TEST_LICENSE, `e2e:${randomUUID()}`,
        input.feedStatus, input.delaySeconds,
      ],
    );
    await pool.query(
      `insert into market_bars (
         id,source_observation_id,symbol,asset_class,provider,timeframe,
         started_at,ended_at,open_price,high_price,low_price,close_price,completed
       ) values ($1,$2,$3,'US_STOCK',$4,'15m',$5,$6,$7,$7,$7,$7,true)`,
      [randomUUID(), observationId, input.symbol, TEST_PROVIDER,
        new Date(observedAt.getTime() - 15 * 60 * 1_000), observedAt, input.price],
    );
    const evidence = [{ kind: "MARKET_EVENT" as const, referenceId: observationId }];
    const expiresAt = new Date(receivedAt.getTime() + 60 * 60 * 1_000).toISOString();
    const geometry = {
      direction: "LONG",
      entry: input.price,
      expiresAt,
      desiredRisk: "25.00",
      stop: "97.50",
      symbol: input.symbol,
      target: "105.00",
    } as const;
    const window = await openDecisionWindow({ db: database }, {
      marketObservationIds: [observationId],
      evidence,
      portfolioSnapshot: { equity: "2500.00", highWaterId: stageStartedEventId },
      costModelSnapshot: { policyVersion: INITIAL_PROFILE.costPolicyVersion },
      stageProfileVersion: INITIAL_PROFILE.profileVersionId,
      eligibleInstruments: [input.symbol],
      idempotencyKey: `e2e-window:${stageId}`,
    });
    const main = await commitMainBaseline({ db: database }, {
      windowId: window.id,
      disposition: "THESIS",
      thesis: JSON.stringify(geometry),
      evidence,
      counterevidence: [],
      uncertainty: "The simulated entry invalidates at its structural stop.",
      idempotencyKey: `e2e-main:${stageId}`,
    });
    const evaluatorRunId = randomUUID();
    await database.query(
      `insert into model_runs (
         id,role,provider,model,prompt_version,policy_version,correlation_id,causation_id,
         input_tokens,output_tokens,max_input_tokens,max_output_tokens,completion_status,completed_at
       ) values ($1,'EVALUATOR',$2,'e2e-evaluator','e2e-prompt','e2e-policy',
         $3,$4,1,1,128,128,'COMPLETED',$5)`,
      [evaluatorRunId, TEST_PROVIDER, randomUUID(), main.eventId, receivedAt],
    );
    await recordEvaluation({ db: database }, {
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
          evidenceFresh: true,
          sessionValid: true,
          geometryComplete: true,
          nonDuplicate: true,
          authorized: true,
        },
      }],
      idempotencyKey: `e2e-evaluation:${stageId}`,
    });
    const intent = await submitPaperIntent(createMainPaperOrderContext(database), {
      sourceDecisionId: window.id,
      symbol: input.symbol,
      direction: "LONG",
      entry: input.price,
      stop: "97.50",
      exitRule: { type: "TARGET", price: "105.00" },
      desiredRisk: "25.00",
      expiresAt,
      evaluatedAt: receivedAt.toISOString(),
      idempotencyKey: `e2e-intent:${stageId}`,
    });
    if (!intent.orderId) throw new Error(`E2E_PAPER_INTENT_REJECTED:${intent.reasons.join(",")}`);
    await processPaperOrder(createPaperWorkerContext(database, "e2e-paper-worker"), intent.orderId, {
      reference: input.price,
      observedAt: observedAt.toISOString(),
      evaluatedAt: receivedAt.toISOString(),
    });
    const ledger = await loadChallengeLedgerEvents({ db: database }, stageId);
    const highWater = ledger.at(-1);
    if (!highWater) throw new Error("E2E_CHALLENGE_LEDGER_EMPTY");
    await replaceProjectionCheckpoint({ db: database }, {
      stageId,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: highWater.id,
      highWaterSequence: highWater.sequence,
      projection: replayStoredLedgerEvents(ledger),
    });
    return Object.freeze({ observedAt: observedAt.toISOString() });
  } finally {
    await pool.end();
  }
}
