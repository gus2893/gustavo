import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { chmod, lstat, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, FullConfig } from "@playwright/test";
import { Pool } from "pg";
import { databaseFromPool } from "../../lib/server/db/postgres";
import {
  createProductionCacheRuntime,
  prewarmPostgresCache,
  rebuildPostgresCache,
} from "../../lib/server/cache/runtime";
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
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import { appendEvent } from "../../lib/server/events/store";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  loadLatestMarket,
  materializeMarketObservation,
  storeLatestMarketWindow,
} from "../../lib/server/market-data/latest";
import {
  commitMainBaseline,
  openDecisionWindow,
  recordEvaluation,
} from "../../lib/server/orchestration/decision-window";

const execFileAsync = promisify(execFile);
const E2E_DATABASE_PREFIX = "gustavo-e2e-postgres-";
const E2E_BACKUP_PREFIX = "gustavo-e2e-backup-";
const E2E_VALKEY_CONTAINER_PREFIX = "gustavo-e2e-valkey-";
const E2E_CODEX_CONTAINER_PREFIX = "gustavo-e2e-codex-";
const E2E_HYBRID_CHILD_PREFIX = "gustavo-e2e-hybrid-child-";
const E2E_OWNERSHIP_PREFIX = "gustavo-e2e-ownership-";
const E2E_OWNERSHIP_ENV = "GUSTAVO_E2E_OWNERSHIP_REGISTRY";
const E2E_VALKEY_IMAGE = "valkey/valkey:8.1.3-bookworm";
const E2E_VALKEY_OWNER_LABEL = "com.gustavo.e2e.registry";
const E2E_CODEX_OWNER_LABEL = "com.gustavo.e2e.registry";
const TEST_PROVIDER = "gustavo-e2e-licensed";
const TEST_LICENSE = "e2e-license-v1";

interface E2eRuntime {
  dataDirectory: string;
  ownershipDirectory: string;
  postgresBin: string;
  admin: Pool;
  qstash: HttpServer;
  web: ChildProcess;
}

interface HostedWakePublication {
  readonly accepted: true;
  readonly bodyKind: "JOB";
  readonly destinationVariable: "GUSTAVO_HYBRID_WAKE_URL";
  readonly jobId: string;
  readonly url: string;
}

interface QStashFixtureState {
  marketSchedulePaused: boolean;
  readonly publications: HostedWakePublication[];
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

export interface VerifiedBackupFixture {
  readonly verified: true;
  readonly eventHighWater: string;
  readonly schemaVersion: string;
  readonly manifestPath: string;
  readonly keyPath: string;
  readonly rootDirectory: string;
  readonly ownershipRecord: string;
}

export interface RestoredFixture {
  readonly eventHighWater: string;
  readonly schemaVersion: string;
}

export interface CacheRestartFixture {
  readonly rebuilt: true;
  readonly prewarmed: true;
  readonly source: "POSTGRES";
  readonly backend: "VALKEY";
  readonly keysBeforeLoss: number;
  readonly keysAfterLoss: 0;
  readonly keysAfterPrewarm: number;
}

export interface ScheduledBroadcastFixture {
  readonly authorType: "MAIN_BRAIN";
  readonly protectedText?: never;
}

export interface HybridE2eDatabaseURLs {
  readonly admin: string;
  readonly materializer: string;
  readonly ordinary: string;
}

export type FixtureOwnership = Readonly<{
  kind: "BACKUP" | "CHILD" | "CONTAINER" | "FILE" | "VALKEY";
  value: string;
}>;

export interface FixtureOwnershipOperations {
  readonly removeValkey?: (name: string) => Promise<void>;
  readonly removeBackup?: (directory: string) => Promise<void>;
  readonly removeChild?: (value: string) => Promise<void>;
  readonly removeContainer?: (name: string) => Promise<void>;
  readonly removeFile?: (path: string) => Promise<void>;
}

type FixturePathKind = "DIRECTORY" | "FILE";

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

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
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
    const probe = createNetServer();
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

export function hybridE2eDatabaseURLs(): HybridE2eDatabaseURLs {
  const admin = process.env.GUSTAVO_E2E_ADMIN_DATABASE_URL;
  const materializer = process.env.GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL;
  const ordinary = process.env.DATABASE_URL;
  if (!admin || !materializer || !ordinary) {
    throw new Error("E2E_HYBRID_DATABASE_URLS_REQUIRED");
  }
  return Object.freeze({ admin, materializer, ordinary });
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
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default clock_timestamp()
     )`,
  );
  const migrations = readdirSync(join(process.cwd(), "db", "migrations"))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const name of migrations) {
    const applied = await pool.query<{ readonly count: string }>(
      "select count(*)::text count from schema_migrations where name=$1",
      [name],
    );
    if (applied.rows[0]?.count === "1") continue;
    const sql = await readFile(join(process.cwd(), "db", "migrations", name), "utf8");
    await pool.query(sql);
    await pool.query("insert into schema_migrations(name) values ($1)", [name]);
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

export function assertFixtureRuntimeAllowed(environment: string | undefined): void {
  if (environment === "production") {
    throw new Error("E2E_FIXTURES_PRODUCTION_FORBIDDEN");
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

function qstashFixtureToken(): string {
  const token = process.env.QSTASH_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/u.test(token)) {
    throw new Error("E2E_QSTASH_TOKEN_REQUIRED");
  }
  return token;
}

function qstashFixtureURL(): string {
  const value = process.env.QSTASH_URL;
  if (!value) throw new Error("E2E_QSTASH_URL_REQUIRED");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("E2E_QSTASH_URL_INVALID");
  }
  return parsed.origin;
}

async function boundedRequestBody(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.byteLength;
    if (length > 4_096) throw new Error("E2E_QSTASH_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startQStashFixture(
  token: string,
  hostedWakeURL: string,
  currentSigningKey: string,
): Promise<{ readonly server: HttpServer; readonly url: string }> {
  const state: QStashFixtureState = {
    marketSchedulePaused: false,
    publications: [],
  };
  const server = createHttpServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (request.method === "POST" && url.pathname.startsWith("/v2/publish/")) {
        const destination = decodeURIComponent(url.pathname.slice("/v2/publish/".length));
        const rawBody = await boundedRequestBody(request);
        const body: unknown = JSON.parse(rawBody);
        if (destination !== hostedWakeURL || !body || typeof body !== "object"
            || Array.isArray(body) || Object.keys(body).join(",") !== "jobId"
            || typeof (body as { readonly jobId?: unknown }).jobId !== "string"
            || !/^[0-9a-f-]{36}$/iu.test((body as { readonly jobId: string }).jobId)) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid publication" }));
          return;
        }
        const publication = Object.freeze({
          accepted: true,
          bodyKind: "JOB",
          destinationVariable: "GUSTAVO_HYBRID_WAKE_URL",
          jobId: (body as { readonly jobId: string }).jobId,
          url: destination,
        } satisfies HostedWakePublication);
        state.publications.push(publication);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ messageId: `e2e-${state.publications.length}` }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/_e2e/publications/next") {
        const publication = state.publications.shift();
        response.writeHead(publication ? 200 : 404, { "content-type": "application/json" });
        response.end(JSON.stringify(publication ?? { error: "empty" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/_e2e/schedules") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          schedules: [
            {
              id: "gustavo-hosted-maintenance-v1",
              cron: "*/15 * * * *",
              method: "POST",
              destination: "https://gustavo.lol/api/internal/maintenance",
              body: { operation: "maintenance" },
            },
            {
              id: "gustavo-market-current-v1",
              cron: "*/5 * * * *",
              method: "POST",
              destination: hostedWakeURL,
              body: { kind: "MARKET_CURRENT" },
              paused: state.marketSchedulePaused,
            },
          ],
        }));
        return;
      }
      if (request.method === "POST"
          && url.pathname === "/_e2e/schedules/gustavo-market-current-v1/deliver") {
        if (state.marketSchedulePaused) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "schedule paused" }));
          return;
        }
        const rawControl = await boundedRequestBody(request);
        const control: unknown = JSON.parse(rawControl);
        const port = control && typeof control === "object" && !Array.isArray(control)
          ? (control as { readonly port?: unknown }).port
          : undefined;
        if (!Number.isInteger(port) || (port as number) < 1_024 || (port as number) > 65_535) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid delivery target" }));
          return;
        }
        const rawBody = JSON.stringify({ kind: "MARKET_CURRENT" });
        const now = Math.floor(Date.now() / 1_000);
        const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
          .toString("base64url");
        const claims = Buffer.from(JSON.stringify({
          iss: "Upstash",
          sub: hostedWakeURL,
          body: createHash("sha256").update(rawBody, "utf8").digest("base64url"),
          iat: now - 1,
          nbf: now - 2,
          exp: now + 3_600,
          jti: `e2e-market-${randomUUID()}`,
        })).toString("base64url");
        const unsigned = `${header}.${claims}`;
        const signature = `${unsigned}.${createHmac("sha256", currentSigningKey)
          .update(unsigned, "utf8").digest("base64url")}`;
        const wakeResponse = await fetch(`http://127.0.0.1:${port as number}/wake`, {
          method: "POST",
          headers: {
            "content-length": String(Buffer.byteLength(rawBody)),
            "content-type": "application/json",
            "upstash-message-id": `e2e-market-${randomUUID()}`,
            "upstash-signature": signature,
          },
          body: rawBody,
          signal: AbortSignal.timeout(2_000),
        });
        const wakeBody = await wakeResponse.text();
        if (wakeBody !== "WAKE_ACCEPTED") throw new Error("E2E_MARKET_DELIVERY_REJECTED");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          bodyKind: "MARKET_CURRENT",
          scheduleId: "gustavo-market-current-v1",
          status: wakeResponse.status,
        }));
        return;
      }
      if (request.method === "POST"
          && url.pathname === "/_e2e/schedules/gustavo-market-current-v1/pause") {
        state.marketSchedulePaused = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ schedulePaused: true }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture failure" }));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("E2E_QSTASH_BIND_INVALID");
  }
  return Object.freeze({ server, url: `http://127.0.0.1:${address.port}` });
}

async function stopQStashFixture(server: HttpServer): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function assertSafeOwnershipRegistry(directory: string): void {
  const expectedParent = resolve(tmpdir());
  const target = resolve(directory);
  const leaf = target.split(/[\\/]/u).at(-1) ?? "";
  if (resolve(target, "..") !== expectedParent
      || !new RegExp(`^${E2E_OWNERSHIP_PREFIX}[A-Za-z0-9]{6}$`, "u").test(leaf)) {
    throw new Error("UNSAFE_E2E_OWNERSHIP_REGISTRY");
  }
}

function currentOwnershipRegistry(): string {
  const directory = process.env[E2E_OWNERSHIP_ENV];
  if (!directory) throw new Error("E2E_OWNERSHIP_REGISTRY_REQUIRED");
  assertSafeOwnershipRegistry(directory);
  return directory;
}

export async function createFixtureOwnershipRegistry(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), E2E_OWNERSHIP_PREFIX));
  assertSafeOwnershipRegistry(directory);
  try {
    await protectOwnerOnlyPath(directory, "DIRECTORY");
    if (!await fixtureOwnershipRegistryProtected(directory)) {
      throw new Error("E2E_OWNERSHIP_REGISTRY_PERMISSIONS_INVALID");
    }
    return directory;
  } catch (error) {
    await rmdir(directory).catch(() => undefined);
    throw error;
  }
}

async function protectOwnerOnlyPath(path: string, kind: FixturePathKind): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, kind === "DIRECTORY" ? 0o700 : 0o600);
    return;
  }
  const aclScript = [
    "param([string]$Target,[string]$Kind)",
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent()",
    "$security=if($Kind -eq 'DIRECTORY'){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}",
    "$security.SetOwner($identity.User)",
    "$security.SetAccessRuleProtection($true,$false)",
    "$rule=if($Kind -eq 'DIRECTORY'){New-Object Security.AccessControl.FileSystemAccessRule($identity.User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{New-Object Security.AccessControl.FileSystemAccessRule($identity.User,'FullControl','Allow')}",
    "$security.AddAccessRule($rule)",
    "if($Kind -eq 'DIRECTORY'){[IO.Directory]::SetAccessControl($Target,$security)}else{[IO.File]::SetAccessControl($Target,$security)}",
  ].join(";");
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", `& { ${aclScript} }`, path, kind,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
}

export async function fixtureOwnerOnlyPath(
  path: string,
  kind: FixturePathKind,
): Promise<boolean> {
  const item = await lstat(path);
  if (item.isSymbolicLink()
      || (kind === "DIRECTORY" ? !item.isDirectory() : !item.isFile())) return false;
  if (process.platform !== "win32") return (item.mode & 0o077) === 0;
  const auditScript = [
    "param([string]$Target)",
    "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$acl=Get-Acl -LiteralPath $Target",
    "$owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value",
    "$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])",
    "$valid=$acl.AreAccessRulesProtected -and $owner -eq $current -and $rules.Count -gt 0",
    "foreach($rule in $rules){if($rule.IdentityReference.Value -ne $current -or $rule.AccessControlType -ne 'Allow'){$valid=$false}}",
    "$valid",
  ].join(";");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", `& { ${auditScript} }`, path,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return stdout.trim() === "True";
}

export async function fixtureOwnershipRegistryProtected(registry: string): Promise<boolean> {
  assertSafeOwnershipRegistry(registry);
  return fixtureOwnerOnlyPath(registry, "DIRECTORY");
}

function validateOwnership(ownership: FixtureOwnership): FixtureOwnership {
  if (!ownership || typeof ownership !== "object") {
    throw new Error("E2E_OWNERSHIP_INVALID");
  }
  if (ownership.kind === "VALKEY") assertValkeyContainerName(ownership.value);
  else if (ownership.kind === "BACKUP") assertSafeBackupDirectory(ownership.value);
  else if (ownership.kind === "CHILD") parseOwnedChild(ownership.value);
  else if (ownership.kind === "CONTAINER") assertCodexContainerName(ownership.value);
  else if (ownership.kind === "FILE") assertSafeMaintenanceLauncher(ownership.value);
  else throw new Error("E2E_OWNERSHIP_INVALID");
  return Object.freeze({ kind: ownership.kind, value: ownership.value });
}

function assertSafeMaintenanceLauncher(path: string): void {
  const target = resolve(path);
  const name = target.split(/[\\/]/u).at(-1) ?? "";
  if (resolve(target, "..") !== resolve(tmpdir())
      || !/^gustavo-e2e-(?:maintenance-[0-9a-f]{32}\.ps1|settlement-[0-9a-f]{32}\.state)$/u.test(name)) {
    throw new Error("UNSAFE_E2E_MAINTENANCE_LAUNCHER");
  }
}

async function removeOwnedMaintenanceLauncher(path: string): Promise<void> {
  assertSafeMaintenanceLauncher(path);
  try {
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error("E2E_MAINTENANCE_LAUNCHER_INVALID");
    }
    await rm(path, { force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function registerFixtureOwnership(
  registry: string,
  ownership: FixtureOwnership,
): Promise<string> {
  assertSafeOwnershipRegistry(registry);
  const registryItem = await lstat(registry);
  if (!registryItem.isDirectory() || registryItem.isSymbolicLink()) {
    throw new Error("E2E_OWNERSHIP_REGISTRY_INVALID");
  }
  if (!await fixtureOwnershipRegistryProtected(registry)) {
    throw new Error("E2E_OWNERSHIP_REGISTRY_PERMISSIONS_INVALID");
  }
  const validated = validateOwnership(ownership);
  if (validated.kind === "BACKUP") {
    const backupItem = await lstat(validated.value);
    if (!backupItem.isDirectory() || backupItem.isSymbolicLink()) {
      throw new Error("E2E_BACKUP_DIRECTORY_INVALID");
    }
  }
  const record = join(registry, `${randomUUID().replaceAll("-", "")}.json`);
  await writeFile(record, JSON.stringify(validated), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return record;
}

async function ownershipEntries(registry: string): Promise<readonly {
  readonly ownership: FixtureOwnership;
  readonly record: string;
}[]> {
  assertSafeOwnershipRegistry(registry);
  const registryItem = await lstat(registry);
  if (!registryItem.isDirectory() || registryItem.isSymbolicLink()) {
    throw new Error("E2E_OWNERSHIP_REGISTRY_INVALID");
  }
  if (!await fixtureOwnershipRegistryProtected(registry)) {
    throw new Error("E2E_OWNERSHIP_REGISTRY_PERMISSIONS_INVALID");
  }
  const names = (await readdir(registry)).sort();
  if (names.length > 128 || names.some((name) => !/^[0-9a-f]{32}\.json$/u.test(name))) {
    throw new Error("E2E_OWNERSHIP_REGISTRY_CONTENT_INVALID");
  }
  return Object.freeze(await Promise.all(names.map(async (name) => {
    const record = join(registry, name);
    const item = await lstat(record);
    if (!item.isFile() || item.isSymbolicLink() || item.size > 4_096) {
      throw new Error("E2E_OWNERSHIP_RECORD_INVALID");
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(record, "utf8"));
    } catch {
      throw new Error("E2E_OWNERSHIP_RECORD_INVALID");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("E2E_OWNERSHIP_RECORD_INVALID");
    }
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).sort().join(",") !== "kind,value"
        || typeof fields.kind !== "string" || typeof fields.value !== "string") {
      throw new Error("E2E_OWNERSHIP_RECORD_INVALID");
    }
    return Object.freeze({
      ownership: validateOwnership(fields as FixtureOwnership),
      record,
    });
  })));
}

export async function readFixtureOwnership(
  registry: string,
): Promise<readonly FixtureOwnership[]> {
  return Object.freeze((await ownershipEntries(registry)).map(({ ownership }) => ownership));
}

export async function assertNoOwnedFixtureResidue(): Promise<true> {
  const owned = await readFixtureOwnership(currentOwnershipRegistry());
  if (owned.length !== 0) throw new Error("E2E_OWNED_FIXTURE_RESIDUE");
  return true;
}

type DockerInvocation = (arguments_: readonly string[]) => Promise<string>;

function exactNoSuchContainer(error: unknown, name: string): boolean {
  if (!error || typeof error !== "object") return false;
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  if (typeof stderr !== "string") return false;
  const line = stderr.trim();
  return line === `Error: No such container: ${name}`
    || line === `Error response from daemon: No such container: ${name}`;
}

export async function removeOwnedValkeyForTest(
  name: string,
  registryId: string,
  invokeDocker: DockerInvocation = docker,
): Promise<"ABSENT" | "REMOVED"> {
  assertValkeyContainerName(name);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(registryId)) {
    throw new Error("E2E_VALKEY_REGISTRY_ID_INVALID");
  }
  let label: string;
  try {
    label = await invokeDocker([
      "container", "inspect", "--format",
      `{{ index .Config.Labels "${E2E_VALKEY_OWNER_LABEL}" }}`,
      name,
    ]);
  } catch (error) {
    if (exactNoSuchContainer(error, name)) return "ABSENT";
    throw error;
  }
  if (label.trim() !== registryId) throw new Error("E2E_VALKEY_OWNERSHIP_LABEL_INVALID");
  await invokeDocker(["rm", "--force", name]);
  return "REMOVED";
}

async function removeValkeyContainer(
  name: string,
  registry: string,
  invokeDocker: DockerInvocation = docker,
): Promise<void> {
  assertSafeOwnershipRegistry(registry);
  const registryId = resolve(registry).split(/[\\/]/u).at(-1)!;
  await removeOwnedValkeyForTest(name, registryId, invokeDocker);
}

async function removeOwnedBackup(directory: string): Promise<void> {
  assertSafeBackupDirectory(directory);
  let item;
  try {
    item = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new Error("E2E_BACKUP_DIRECTORY_INVALID");
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}

function parseOwnedChild(value: string): { readonly marker: string; readonly pid: number } {
  const match = new RegExp(
    `^([1-9][0-9]{0,9}):(${E2E_HYBRID_CHILD_PREFIX}[0-9a-f]{32})$`,
    "u",
  ).exec(value);
  const pid = Number(match?.[1]);
  if (!match?.[2] || !Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("UNSAFE_E2E_HYBRID_CHILD");
  }
  return Object.freeze({ pid, marker: match[2] });
}

async function ownedChildCommandLine(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") {
    const script = [
      "param([int]$TargetPid)",
      "$item=Get-CimInstance Win32_Process -Filter \"ProcessId=$TargetPid\"",
      "if($null -ne $item){$item.CommandLine}",
    ].join(";");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", `& { ${script} }`, String(pid),
    ], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
    const line = stdout.trim();
    return line === "" ? undefined : line;
  }
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\u0000", " ").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeOwnedHybridChild(value: string): Promise<void> {
  const { marker, pid } = parseOwnedChild(value);
  const commandLine = await ownedChildCommandLine(pid);
  if (commandLine === undefined) return;
  if (!commandLine.includes(marker)
      || !commandLine.includes("gustavo-hybrid-production.spec.ts")) {
    throw new Error("E2E_HYBRID_CHILD_OWNERSHIP_MISMATCH");
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await ownedChildCommandLine(pid);
    if (current === undefined || !current.includes(marker)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("E2E_HYBRID_CHILD_STOP_TIMEOUT");
}

export async function cleanupFixtureOwnershipRegistry(
  registry: string,
  operations: FixtureOwnershipOperations = {},
): Promise<void> {
  const failures: unknown[] = [];
  for (const { ownership, record } of await ownershipEntries(registry)) {
    try {
      if (ownership.kind === "VALKEY") {
        await (operations.removeValkey ?? ((name) => removeValkeyContainer(name, registry)))(
          ownership.value,
        );
      } else if (ownership.kind === "BACKUP") {
        await (operations.removeBackup ?? removeOwnedBackup)(ownership.value);
      } else if (ownership.kind === "CHILD") {
        await (operations.removeChild ?? removeOwnedHybridChild)(ownership.value);
      } else if (ownership.kind === "FILE") {
        await (operations.removeFile ?? removeOwnedMaintenanceLauncher)(ownership.value);
      } else {
        await (operations.removeContainer ?? ((name) => removeCodexContainer(name, registry)))(
          ownership.value,
        );
      }
      await rm(record, { force: false });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "E2E_OWNERSHIP_CLEANUP_FAILED");
  }
  if ((await readdir(registry)).length !== 0) throw new Error("E2E_OWNERSHIP_REGISTRY_NOT_EMPTY");
  await rmdir(registry);
}

async function unregisterFixtureOwnership(
  record: string,
  registry = currentOwnershipRegistry(),
): Promise<void> {
  const target = resolve(record);
  if (resolve(target, "..") !== resolve(registry)
      || !/^[0-9a-f]{32}\.json$/u.test(target.split(/[\\/]/u).at(-1) ?? "")) {
    throw new Error("UNSAFE_E2E_OWNERSHIP_RECORD");
  }
  const item = await lstat(target);
  if (!item.isFile() || item.isSymbolicLink() || item.size > 4_096) {
    throw new Error("E2E_OWNERSHIP_RECORD_INVALID");
  }
  await rm(target, { force: false });
}

export async function registerOwnedHybridChild(
  pid: number,
  marker: string,
): Promise<string> {
  return registerFixtureOwnership(currentOwnershipRegistry(), {
    kind: "CHILD",
    value: `${pid}:${marker}`,
  });
}

export async function unregisterOwnedHybridChild(record: string): Promise<void> {
  await unregisterFixtureOwnership(record);
}

export async function cleanupOwnedHybridChild(record: string): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(record, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || (raw as { readonly kind?: unknown }).kind !== "CHILD"
      || typeof (raw as { readonly value?: unknown }).value !== "string") {
    throw new Error("E2E_OWNERSHIP_RECORD_INVALID");
  }
  await removeOwnedHybridChild((raw as { readonly value: string }).value);
  await unregisterFixtureOwnership(record);
}

export async function createOwnedMaintenanceLauncher(
  content: string,
): Promise<{ readonly path: string; readonly ownershipRecord: string }> {
  if (typeof content !== "string" || content.length < 1 || content.length > 1_000_000) {
    throw new Error("E2E_MAINTENANCE_LAUNCHER_CONTENT_INVALID");
  }
  const path = join(tmpdir(), `gustavo-e2e-maintenance-${randomUUID().replaceAll("-", "")}.ps1`);
  assertSafeMaintenanceLauncher(path);
  const ownershipRecord = await registerFixtureOwnership(currentOwnershipRegistry(), {
    kind: "FILE",
    value: path,
  });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await protectOwnerOnlyPath(path, "FILE");
    if (!await fixtureOwnerOnlyPath(path, "FILE")) {
      throw new Error("E2E_MAINTENANCE_LAUNCHER_PERMISSIONS_INVALID");
    }
    return Object.freeze({ path, ownershipRecord });
  } catch (error) {
    await removeOwnedMaintenanceLauncher(path).catch(() => undefined);
    await unregisterFixtureOwnership(ownershipRecord).catch(() => undefined);
    throw error;
  }
}

export async function createOwnedChildSettlementAuthority(): Promise<{
  readonly path: string;
  readonly ownershipRecord: string;
}> {
  const path = join(tmpdir(), `gustavo-e2e-settlement-${randomUUID().replaceAll("-", "")}.state`);
  assertSafeMaintenanceLauncher(path);
  const ownershipRecord = await registerFixtureOwnership(currentOwnershipRegistry(), {
    kind: "FILE",
    value: path,
  });
  try {
    await writeFile(path, "PENDING", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await protectOwnerOnlyPath(path, "FILE");
    if (!await fixtureOwnerOnlyPath(path, "FILE")) {
      throw new Error("E2E_CHILD_SETTLEMENT_PERMISSIONS_INVALID");
    }
    return Object.freeze({ path, ownershipRecord });
  } catch (error) {
    await removeOwnedMaintenanceLauncher(path).catch(() => undefined);
    await unregisterFixtureOwnership(ownershipRecord).catch(() => undefined);
    throw error;
  }
}

export async function cleanupOwnedMaintenanceLauncher(
  path: string,
  ownershipRecord: string,
): Promise<true> {
  await removeOwnedMaintenanceLauncher(path);
  await unregisterFixtureOwnership(ownershipRecord);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  throw new Error("E2E_MAINTENANCE_LAUNCHER_RESIDUE");
}

async function cleanup(runtime: Partial<E2eRuntime>): Promise<void> {
  const failures: unknown[] = [];
  if (runtime.ownershipDirectory) {
    await cleanupFixtureOwnershipRegistry(runtime.ownershipDirectory)
      .catch((error: unknown) => failures.push(error));
  }
  if (runtime.web) {
    await stopWeb(runtime.web).catch((error: unknown) => failures.push(error));
  }
  if (runtime.qstash) {
    await stopQStashFixture(runtime.qstash).catch((error: unknown) => failures.push(error));
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
  delete process.env[E2E_OWNERSHIP_ENV];
}

function databaseURLForRole(databaseURL: string, role: string): string {
  const url = new URL(databaseURL);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function configureHybridE2eDatabaseRoles(
  admin: Pool,
  adminDatabaseURL: string,
): Promise<{ readonly ordinaryURL: string; readonly materializerURL: string }> {
  const ordinaryRole = "gustavo_e2e_ordinary";
  const materializerRole = "gustavo_e2e_materializer";
  await admin.query(`
    create role ${ordinaryRole}
      login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role ${materializerRole}
      login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    grant gustavo_market_materializer to ${materializerRole};
    grant usage on schema public to ${ordinaryRole};
    grant select,insert,update,delete on all tables in schema public to ${ordinaryRole};
    grant usage,select,update on all sequences in schema public to ${ordinaryRole};
    grant execute on all functions in schema public to ${ordinaryRole};
    revoke insert,update,delete,truncate on
      market_observation_consumptions,market_instrument_allowlist,
      market_data_sources,market_observations
    from ${ordinaryRole};
  `);
  return Object.freeze({
    ordinaryURL: databaseURLForRole(adminDatabaseURL, ordinaryRole),
    materializerURL: databaseURLForRole(adminDatabaseURL, materializerRole),
  });
}

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  assertFixtureRuntimeAllowed(process.env.NODE_ENV);
  if (config.metadata.reuseExistingServer !== false) {
    throw new Error("E2E_SERVER_REUSE_FORBIDDEN");
  }
  const runtime: Partial<E2eRuntime> = {};
  try {
    runtime.ownershipDirectory = await createFixtureOwnershipRegistry();
    process.env[E2E_OWNERSHIP_ENV] = runtime.ownershipDirectory;
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

    const adminDatabaseURL = `postgresql://postgres@127.0.0.1:${databasePort}/postgres`;
    runtime.admin = new Pool({ connectionString: adminDatabaseURL, max: 4 });
    process.stderr.write("[e2e setup] applying migrations\n");
    await applyMigrations(runtime.admin);
    process.stderr.write("[e2e setup] migrations applied\n");
    const databaseRoles = await configureHybridE2eDatabaseRoles(
      runtime.admin,
      adminDatabaseURL,
    );

    const webPort = await reserveLoopbackPort();
    const baseURL = `http://127.0.0.1:${webPort}`;
    const hostedWakeURL = "https://gustavo-fixture.private-fixture.ts.net/wake";
    const qstashToken = randomBytes(32).toString("base64url");
    const currentSigningKey = "e2e-current-signing-key-with-at-least-32-bytes";
    const nextSigningKey = "e2e-next-signing-key-with-at-least-32-bytes";
    const qstash = await startQStashFixture(qstashToken, hostedWakeURL, currentSigningKey);
    runtime.qstash = qstash.server;
    process.env.DATABASE_URL = databaseRoles.ordinaryURL;
    process.env.GUSTAVO_E2E_ADMIN_DATABASE_URL = adminDatabaseURL;
    process.env.GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL = databaseRoles.materializerURL;
    process.env.GUSTAVO_APP_ORIGIN = baseURL;
    process.env.GUSTAVO_E2E_BASE_URL = baseURL;
    process.env.GUSTAVO_TEST_FIXTURES_ENABLED = "true";
    process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION = "1";
    process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = randomBytes(32).toString("base64");
    process.env.GUSTAVO_CURSOR_SIGNING_KEY = randomBytes(32).toString("base64");
    process.env.GUSTAVO_OPERATOR_HEALTH_TOKEN = randomBytes(32).toString("base64url");
    process.env.GUSTAVO_HYBRID_BRIDGE_ENABLED = "true";
    process.env.GUSTAVO_HYBRID_WAKE_URL = hostedWakeURL;
    process.env.QSTASH_URL = qstash.url;
    process.env.QSTASH_TOKEN = qstashToken;
    process.env.QSTASH_CURRENT_SIGNING_KEY = currentSigningKey;
    process.env.QSTASH_NEXT_SIGNING_KEY = nextSigningKey;

    let serverOutput = "";
    const nextBin = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
    // This harness always owns a new server. It never reuses an existing process.
    await assertLoopbackPortAvailable(webPort);
    const webEnvironment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };
    delete webEnvironment.GUSTAVO_E2E_ADMIN_DATABASE_URL;
    delete webEnvironment.GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL;
    const web = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(webPort)], {
      cwd: process.cwd(),
      env: webEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    runtime.web = web;
    const capture = (chunk: Buffer): void => {
      serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-16_384);
    };
    web.stdout?.on("data", capture);
    web.stderr?.on("data", capture);
    process.stderr.write("[e2e setup] waiting for Next\n");
    await waitForWeb(baseURL, web, () => serverOutput);
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

async function qstashFixtureFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${qstashFixtureURL()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${qstashFixtureToken()}`,
      ...init.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });
}

export async function assertHostedWakePublished(): Promise<HostedWakePublication> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await qstashFixtureFetch("/_e2e/publications/next");
    if (response.status === 200) {
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("E2E_HOSTED_WAKE_PUBLICATION_INVALID");
      }
      const publication = value as Record<string, unknown>;
      if (publication.accepted !== true || publication.bodyKind !== "JOB"
          || publication.destinationVariable !== "GUSTAVO_HYBRID_WAKE_URL"
          || typeof publication.jobId !== "string"
          || typeof publication.url !== "string") {
        throw new Error("E2E_HOSTED_WAKE_PUBLICATION_INVALID");
      }
      return Object.freeze(publication as unknown as HostedWakePublication);
    }
    if (response.status !== 404) throw new Error("E2E_HOSTED_WAKE_PUBLICATION_FAILED");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("E2E_HOSTED_WAKE_PUBLICATION_TIMEOUT");
}

export async function assertMarketScheduleBody(): Promise<{
  readonly bodyKind: "MARKET_CURRENT";
  readonly scheduleCount: 2;
  readonly hasHostedRelay: boolean;
  readonly maintenanceScheduleExact: true;
  readonly marketScheduleExact: true;
  readonly relayCheckSource: "SCHEDULE_INVENTORY";
  readonly marketScheduleId: "gustavo-market-current-v1";
  readonly fixtureOwnsSignedDelivery: true;
}> {
  const response = await qstashFixtureFetch("/_e2e/schedules");
  if (!response.ok) throw new Error("E2E_QSTASH_SCHEDULES_UNAVAILABLE");
  const value = await response.json() as {
    readonly schedules?: readonly {
      readonly id?: unknown;
      readonly body?: unknown;
      readonly cron?: unknown;
      readonly destination?: unknown;
      readonly method?: unknown;
    }[];
  };
  const schedules = value.schedules;
  const maintenance = schedules?.find(({ id }) => id === "gustavo-hosted-maintenance-v1");
  const market = schedules?.find(({ id }) => id === "gustavo-market-current-v1");
  const maintenanceScheduleExact = maintenance !== undefined && schedules?.[0] === maintenance
    && maintenance.cron === "*/15 * * * *" && maintenance.method === "POST"
    && maintenance.destination === "https://gustavo.lol/api/internal/maintenance"
    && JSON.stringify(maintenance.body) === JSON.stringify({ operation: "maintenance" });
  const marketScheduleExact = market !== undefined && schedules?.[1] === market
    && market.cron === "*/5 * * * *" && market.method === "POST"
    && market.destination === process.env.GUSTAVO_HYBRID_WAKE_URL
    && JSON.stringify(market.body) === JSON.stringify({ kind: "MARKET_CURRENT" });
  const expectedDestinations = new Map<string, unknown>([
    ["gustavo-hosted-maintenance-v1", "https://gustavo.lol/api/internal/maintenance"],
    ["gustavo-market-current-v1", process.env.GUSTAVO_HYBRID_WAKE_URL],
  ]);
  const hasHostedRelay = schedules?.some(({ id, destination }) => (
    typeof id !== "string" || !expectedDestinations.has(id)
      || expectedDestinations.get(id) !== destination
  )) ?? true;
  if (schedules?.length !== 2 || !maintenanceScheduleExact || !marketScheduleExact
      || hasHostedRelay) {
    throw new Error("E2E_QSTASH_SCHEDULES_INVALID");
  }
  return Object.freeze({
    bodyKind: "MARKET_CURRENT",
    scheduleCount: 2,
    hasHostedRelay,
    maintenanceScheduleExact: true,
    marketScheduleExact: true,
    relayCheckSource: "SCHEDULE_INVENTORY",
    marketScheduleId: "gustavo-market-current-v1",
    fixtureOwnsSignedDelivery: true,
  });
}

export async function deliverMarketSchedule(port: number): Promise<number> {
  const response = await qstashFixtureFetch(
    "/_e2e/schedules/gustavo-market-current-v1/deliver",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    },
  );
  if (response.status === 409) throw new Error("E2E_MARKET_SCHEDULE_PAUSED");
  if (!response.ok) throw new Error("E2E_MARKET_SCHEDULE_DELIVERY_FAILED");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("E2E_MARKET_SCHEDULE_DELIVERY_INVALID");
  }
  const delivery = value as Record<string, unknown>;
  if (delivery.bodyKind !== "MARKET_CURRENT"
      || delivery.scheduleId !== "gustavo-market-current-v1"
      || delivery.status !== 202) {
    throw new Error("E2E_MARKET_SCHEDULE_DELIVERY_INVALID");
  }
  return 202;
}

export async function pauseMarketSchedule(): Promise<{ readonly schedulePaused: true }> {
  const response = await qstashFixtureFetch(
    "/_e2e/schedules/gustavo-market-current-v1/pause",
    { method: "POST" },
  );
  if (!response.ok) throw new Error("E2E_MARKET_SCHEDULE_PAUSE_FAILED");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)
      || (value as { readonly schedulePaused?: unknown }).schedulePaused !== true) {
    throw new Error("E2E_MARKET_SCHEDULE_PAUSE_INVALID");
  }
  return Object.freeze({ schedulePaused: true });
}

export async function assertFreshHybridInventory(): Promise<{
  readonly accounts: 0;
  readonly conversations: 0;
  readonly bridgeJobs: 0;
  readonly latestQuotes: 0;
}> {
  const pool = new Pool({ connectionString: databaseURL(), max: 1 });
  try {
    const rows = await pool.query<{
      readonly accounts: number;
      readonly conversations: number;
      readonly bridge_jobs: number;
      readonly latest_quotes: number;
    }>(`select
      (select count(*)::int from accounts) accounts,
      (select count(*)::int from conversations) conversations,
      (select count(*)::int from bridge_model_jobs) bridge_jobs,
      (select count(*)::int from market_latest_quotes) latest_quotes`);
    const row = rows.rows[0];
    if (!row || row.accounts !== 0 || row.conversations !== 0
        || row.bridge_jobs !== 0 || row.latest_quotes !== 0) {
      throw new Error("E2E_FRESH_HYBRID_INVENTORY_NOT_EMPTY");
    }
    return Object.freeze({
      accounts: 0,
      conversations: 0,
      bridgeJobs: 0,
      latestQuotes: 0,
    });
  } finally {
    await pool.end();
  }
}

interface MarketMaterializerIsolationOptions {
  readonly poolFactory?: (
    kind: "admin" | "materializer" | "ordinary",
    connectionString: string,
  ) => Pool;
}

export async function assertMarketMaterializerIsolation(
  options: MarketMaterializerIsolationOptions = {},
): Promise<{
  readonly materializerAccepted: true;
  readonly materializerProductionPathCleaned: true;
  readonly materializerProductionPathCommitted: true;
  readonly materializerProductionPathVerified: true;
  readonly ordinaryForgeryRejected: true;
  readonly ordinaryMatchingInsertAttempted: true;
  readonly ordinaryMatchingInsertRejected: true;
}> {
  const urls = hybridE2eDatabaseURLs();
  const poolFactory = options.poolFactory ?? ((_kind: "admin" | "materializer" | "ordinary",
    connectionString: string) => new Pool({ connectionString, max: 1 }));
  const ordinary = poolFactory("ordinary", urls.ordinary);
  const materializer = poolFactory("materializer", urls.materializer);
  const admin = poolFactory("admin", urls.admin);
  const probeAccountId = randomUUID();
  let probeWindowId: string | undefined;
  let probeMayOwnGlobalAuthorities = false;
  let materializerProductionPathCommitted = false;
  let materializerProductionPathVerified = false;
  let primaryFailure: unknown;
  try {
    const operationFailures: unknown[] = [];
    try {
    const ordinaryResult = await ordinary.query<{
      readonly member: boolean;
      readonly can_insert: boolean;
    }>(`select
      pg_has_role(current_user,'gustavo_market_materializer','MEMBER') member,
      has_table_privilege(current_user,'market_observation_consumptions','INSERT') can_insert`);
    let ordinaryMatchingInsertRejected = false;
    const ordinaryClient = await ordinary.connect();
    try {
      await ordinaryClient.query("begin");
      const digest = "a".repeat(64);
      await ordinaryClient.query(
        `insert into market_observation_consumptions(
           command_event_id,account_id,symbol,latest_context_digest,
           command_body_digest,observation_id,latest_window_id,latest_data_key_id,
           latest_source_observed_at,latest_received_at,request_digest
         ) values ($1,$2,'AAPL',$3,$3,$4,'2026-08-14T12:00Z',$5,
                   timestamptz '2026-08-14 12:00:00+00',
                   timestamptz '2026-08-14 12:00:01+00',$3)`,
        [randomUUID(), randomUUID(), digest, randomUUID(), randomUUID()],
      );
    } catch (error) {
      ordinaryMatchingInsertRejected = error instanceof Error
        && "code" in error && (error as Error & { readonly code?: unknown }).code === "42501";
    } finally {
      await ordinaryClient.query("rollback").catch(() => undefined);
      ordinaryClient.release();
    }
    const materializerResult = await materializer.query<{
      readonly current_user_name: string;
      readonly member: boolean;
      readonly login: boolean;
      readonly inherit: boolean;
      readonly superuser: boolean;
      readonly createdb: boolean;
      readonly createrole: boolean;
      readonly replication: boolean;
      readonly bypassrls: boolean;
      readonly permission_login: boolean;
      readonly permission_inherit: boolean;
      readonly permission_superuser: boolean;
      readonly permission_createdb: boolean;
      readonly permission_createrole: boolean;
      readonly permission_replication: boolean;
      readonly permission_bypassrls: boolean;
      readonly login_other_memberships: number;
      readonly permission_other_memberships: number;
      readonly permission_member_count: number;
    }>(`select current_user current_user_name,
      pg_has_role(current_user,'gustavo_market_materializer','MEMBER') member,
      login.rolcanlogin login,login.rolinherit inherit,login.rolsuper superuser,
      login.rolcreatedb createdb,login.rolcreaterole createrole,
      login.rolreplication replication,login.rolbypassrls bypassrls,
      permission.rolcanlogin permission_login,
      permission.rolinherit permission_inherit,
      permission.rolsuper permission_superuser,
      permission.rolcreatedb permission_createdb,
      permission.rolcreaterole permission_createrole,
      permission.rolreplication permission_replication,
      permission.rolbypassrls permission_bypassrls,
      (select count(*)::int from pg_auth_members membership
        join pg_roles granted on granted.oid=membership.roleid
       where membership.member=login.oid
         and granted.rolname<>'gustavo_market_materializer') login_other_memberships,
      (select count(*)::int from pg_auth_members membership
       where membership.member=permission.oid) permission_other_memberships,
      (select count(*)::int from pg_auth_members membership
       where membership.roleid=permission.oid) permission_member_count
      from pg_roles login cross join pg_roles permission
      where login.rolname=current_user
        and permission.rolname='gustavo_market_materializer'`);
    const ordinaryRow = ordinaryResult.rows[0];
    const row = materializerResult.rows[0];
    const materializerAccepted = row !== undefined
      && ordinaryRow?.member === false
      && row.current_user_name !== "gustavo_market_materializer"
      && row.member === true && row.login === true && row.inherit === true
      && row.superuser === false && row.createdb === false && row.createrole === false
      && row.replication === false && row.bypassrls === false
      && row.login_other_memberships === 0
      && row.permission_login === false && row.permission_inherit === false
      && row.permission_superuser === false && row.permission_createdb === false
      && row.permission_createrole === false && row.permission_replication === false
      && row.permission_bypassrls === false && row.permission_other_memberships === 0
      && row.permission_member_count === 1;

    const ordinaryDatabase = databaseFromPool(ordinary);
    const materializerDatabase = databaseFromPool(materializer);
    const roleBoundMaterializer: EventDatabase = Object.freeze({
      query: <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: readonly unknown[],
      ) => materializerDatabase.query<Row>(sql, parameters),
      one: <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: readonly unknown[],
      ) => materializerDatabase.one<Row>(sql, parameters),
      transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
        materializerDatabase.transaction(async (transaction) => {
          await transaction.query("set local role gustavo_market_materializer");
          return work(transaction);
        })
      ),
    });
    const globalAuthorityBefore = await admin.query<{
      readonly instrument_count: number;
      readonly source_count: number;
    }>(`select
      (select count(*)::int from market_instrument_allowlist
        where symbol='AAPL') instrument_count,
      (select count(*)::int from market_data_sources
        where provider='finnhub' and license_id='finnhub-free-personal') source_count`);
    if (globalAuthorityBefore.rows[0]?.instrument_count !== 0
        || globalAuthorityBefore.rows[0]?.source_count !== 0) {
      throw new Error("E2E_MARKET_MATERIALIZER_GLOBAL_AUTHORITY_PREEXISTED");
    }
    const window = await admin.query<{
      readonly window_id: string;
      readonly window_started_at: Date;
    }>(`select
      to_char(window_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI"Z"') window_id,
      window_started_at
      from (select date_bin(
        interval '5 minutes',clock_timestamp(),timestamptz '1970-01-01 00:00:00+00'
      ) window_started_at) current_window`);
    const exactWindow = window.rows[0];
    if (!exactWindow) throw new Error("E2E_MARKET_MATERIALIZER_WINDOW_MISSING");
    probeWindowId = exactWindow.window_id;
    const observedAt = new Date(exactWindow.window_started_at.getTime() + 1_000).toISOString();
    const setup = await admin.connect();
    try {
      await setup.query("begin");
      await setup.query(
        "insert into accounts(id,display_name,created_at) values ($1,'Materializer probe',clock_timestamp())",
        [probeAccountId],
      );
      await setup.query(
        `insert into entitlements(id,account_id,active_from,created_at)
         values ($1,$2,clock_timestamp()-interval '1 second',clock_timestamp())`,
        [randomUUID(), probeAccountId],
      );
      await setup.query("commit");
    } catch (error) {
      await setup.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      setup.release();
    }
    await storeLatestMarketWindow({ db: ordinaryDatabase, accountId: probeAccountId }, {
      windowId: probeWindowId,
      receivedAt: observedAt,
      items: [Object.freeze({
        symbol: "AAPL",
        kind: "STOCK" as const,
        status: "SUCCESS" as const,
        price: "813.42",
        sourceObservedAt: observedAt,
        safeCode: null,
      })],
    });
    const [latest] = await loadLatestMarket(
      { db: ordinaryDatabase, accountId: probeAccountId },
      ["AAPL"],
    );
    if (!latest) throw new Error("E2E_MARKET_MATERIALIZER_LATEST_MISSING");
    const commandBody = Object.freeze({
      symbol: "AAPL",
      latestContextDigest: latest.latestContextDigest,
    });
    const commandBodyDigest = canonicalContentDigest(commandBody);
    const command = await appendEvent(ordinaryDatabase, {
      aggregateId: `market-latest:${probeAccountId}`,
      accountId: probeAccountId,
      actor: { type: "SYSTEM", id: "gustavo-decision-orchestrator" },
      type: "market.observation.consumption.requested",
      visibility: "PRIVATE_ACCOUNT",
      body: commandBody,
      idempotencyKey: `market-consumption-command:e2e-positive:${commandBodyDigest}`,
      policyVersion: "decision-window-policy-v1",
    });
    probeMayOwnGlobalAuthorities = true;
    const materialized = await materializeMarketObservation({
      db: roleBoundMaterializer,
      accountId: probeAccountId,
    }, { commandEventId: command.id });
    materializerProductionPathCommitted = true;
    const committed = await ordinary.query<{
      readonly binding_count: number;
      readonly observation_count: number;
    }>(`select
      (select count(*)::int from market_observation_consumptions
        where command_event_id=$1 and account_id=$2 and observation_id=$3) binding_count,
      (select count(*)::int from market_observations
        where id=$3 and account_id=$2 and decision_command_event_id=$1) observation_count`,
    [command.id, probeAccountId, materialized.observationId]);
    materializerProductionPathVerified = committed.rows[0]?.binding_count === 1
      && committed.rows[0]?.observation_count === 1;
    if (!materializerAccepted || ordinaryRow?.can_insert !== false
        || !ordinaryMatchingInsertRejected || !materializerProductionPathCommitted
        || !materializerProductionPathVerified) {
      throw new Error("E2E_MARKET_MATERIALIZER_ISOLATION_INVALID");
    }
    } catch (error) {
      operationFailures.push(error);
    }
    try {
      const cleanup = await admin.connect();
    try {
      await cleanup.query("begin");
      await cleanup.query("set local session_replication_role=replica");
      await cleanup.query(
        "delete from market_observation_consumptions where account_id=$1",
        [probeAccountId],
      );
      await cleanup.query("delete from market_observations where account_id=$1", [probeAccountId]);
      if (probeMayOwnGlobalAuthorities) {
        await cleanup.query(
          `delete from market_data_sources
            where provider='finnhub' and license_id='finnhub-free-personal'
              and licensed=true and redistribution='ACCOUNT_ONLY'`,
        );
        await cleanup.query(
          `delete from market_instrument_allowlist
            where symbol='AAPL' and asset_class='US_STOCK' and enabled=true`,
        );
      }
      await cleanup.query(
        `delete from encrypted_event_bodies
          where event_id in (select id from events where account_id=$1::text)`,
        [probeAccountId],
      );
      await cleanup.query(
        `delete from transactional_outbox
          where event_id in (select id from events where account_id=$1::text)`,
        [probeAccountId],
      );
      await cleanup.query("delete from events where account_id=$1::text", [probeAccountId]);
      await cleanup.query("delete from market_latest_quotes where account_id=$1", [probeAccountId]);
      await cleanup.query("delete from aggregate_data_keys where aggregate_id=$1", [
        `market-latest:${probeAccountId}`,
      ]);
      await cleanup.query("delete from entitlements where account_id=$1", [probeAccountId]);
      await cleanup.query("delete from accounts where id=$1", [probeAccountId]);
      if (probeWindowId) {
        await cleanup.query(
          `delete from market_poll_windows where window_id=$1
            and not exists (select 1 from market_latest_quotes where window_id=$1)`,
          [probeWindowId],
        );
      }
      await cleanup.query("commit");
    } catch (error) {
      await cleanup.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      cleanup.release();
    }
    } catch (error) {
      operationFailures.push(error);
    }
    let materializerProductionPathCleaned = false;
    try {
      const residue = await admin.query<{ readonly count: number }>(
        `select (
          (select count(*) from accounts where id=$1)
          +(select count(*) from events where account_id=$1::text)
          +(select count(*) from market_latest_quotes where account_id=$1)
          +(select count(*) from market_observation_consumptions where account_id=$1)
          +(select count(*) from market_observations where account_id=$1)
          +(select count(*) from market_instrument_allowlist
            where symbol='AAPL' and asset_class='US_STOCK' and enabled=true)
          +(select count(*) from market_data_sources
            where provider='finnhub' and license_id='finnhub-free-personal'
              and licensed=true and redistribution='ACCOUNT_ONLY')
        )::int count`,
        [probeAccountId],
      );
      materializerProductionPathCleaned = residue.rows[0]?.count === 0;
      if (!materializerProductionPathCleaned) {
        throw new Error("E2E_MARKET_MATERIALIZER_CLEANUP_INVALID");
      }
    } catch (error) {
      operationFailures.push(error);
    }
    if (operationFailures.length === 1) throw operationFailures[0];
    if (operationFailures.length > 1) {
      throw new AggregateError(operationFailures, "E2E_MARKET_MATERIALIZER_OPERATION_FAILED");
    }
    return Object.freeze({
      materializerAccepted: true,
      materializerProductionPathCleaned: true,
      materializerProductionPathCommitted: true,
      materializerProductionPathVerified: true,
      ordinaryForgeryRejected: true,
      ordinaryMatchingInsertAttempted: true,
      ordinaryMatchingInsertRejected: true,
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const settlements = await Promise.allSettled([
      ordinary.end(),
      materializer.end(),
      admin.end(),
    ]);
    const settlementFailures = settlements.flatMap((settlement) => (
      settlement.status === "rejected" ? [settlement.reason] : []
    ));
    if (settlementFailures.length > 0) {
      const priorFailures = primaryFailure instanceof AggregateError
        ? primaryFailure.errors
        : primaryFailure === undefined ? [] : [primaryFailure];
      throw new AggregateError(
        [...priorFailures, ...settlementFailures],
        "E2E_MARKET_MATERIALIZER_SETTLEMENT_FAILED",
      );
    }
  }
}

function backupDatabaseURL(): string {
  const value = new URL(databaseURL());
  // The disposable cluster uses trust authentication, while the production
  // backup parser correctly requires a complete credential-shaped URL.
  value.password = "e2e-disposable-cluster";
  return value.toString();
}

function powershellExecutable(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

async function runPowerShellScript(
  script: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    powershellExecutable(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      ...arguments_],
    {
      cwd: process.cwd(),
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...environment },
    },
  );
  return stdout;
}

function assertSafeBackupDirectory(directory: string): void {
  const expectedParent = resolve(tmpdir());
  const target = resolve(directory);
  const leaf = target.split(/[\\/]/u).at(-1) ?? "";
  if (resolve(target, "..") !== expectedParent
      || !new RegExp(`^${E2E_BACKUP_PREFIX}[A-Za-z0-9]{6}$`, "u").test(leaf)) {
    throw new Error("UNSAFE_E2E_BACKUP_DIRECTORY");
  }
}

export function operatorHealthToken(): string {
  const token = process.env.GUSTAVO_OPERATOR_HEALTH_TOKEN;
  if (!token || token.length < 32) throw new Error("E2E_OPERATOR_HEALTH_TOKEN_REQUIRED");
  return token;
}

export async function readOperatorHybridHealth(): Promise<{
  readonly codex: {
    readonly status: "OFFLINE" | "DEGRADED";
    readonly safeCode: "WORKER_OFFLINE" | "QUOTA_EXHAUSTED";
    readonly leaseFresh: boolean;
  };
  readonly codexQuota: { readonly used: number; readonly limit: 100; readonly exhausted: boolean };
}> {
  const response = await fetch(`${e2eBaseURL()}/api/operator/health`, {
    headers: { authorization: `Bearer ${operatorHealthToken()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("E2E_OPERATOR_HEALTH_UNAVAILABLE");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("E2E_OPERATOR_HEALTH_INVALID");
  }
  const hybrid = (value as { readonly hybrid?: unknown }).hybrid;
  if (!hybrid || typeof hybrid !== "object" || Array.isArray(hybrid)) {
    throw new Error("E2E_OPERATOR_HEALTH_INVALID");
  }
  const components = (hybrid as { readonly components?: unknown }).components;
  const quotas = (hybrid as { readonly quotas?: unknown }).quotas;
  if (!Array.isArray(components) || !Array.isArray(quotas)) {
    throw new Error("E2E_OPERATOR_HEALTH_INVALID");
  }
  const rawCodex: unknown = components.find((item) => item && typeof item === "object"
    && !Array.isArray(item) && (item as { readonly component?: unknown }).component === "CODEX");
  const rawQuota: unknown = quotas.find((item) => item && typeof item === "object"
    && !Array.isArray(item) && (item as { readonly name?: unknown }).name === "CODEX_JOBS");
  const codex = rawCodex as Record<string, unknown> | undefined;
  const quota = rawQuota as Record<string, unknown> | undefined;
  const validStatus = codex?.status === "OFFLINE" || codex?.status === "DEGRADED";
  const validCode = codex?.safeCode === "WORKER_OFFLINE"
    || codex?.safeCode === "QUOTA_EXHAUSTED";
  if (!validStatus || !validCode || typeof codex.ageSeconds !== "number"
      || !Number.isInteger(quota?.used) || quota?.limit !== 100
      || typeof quota.exhausted !== "boolean") {
    throw new Error("E2E_OPERATOR_HEALTH_INVALID");
  }
  return Object.freeze({
    codex: Object.freeze({
      status: codex.status as "OFFLINE" | "DEGRADED",
      safeCode: codex.safeCode as "WORKER_OFFLINE" | "QUOTA_EXHAUSTED",
      leaseFresh: codex.ageSeconds < 12 * 60,
    }),
    codexQuota: Object.freeze({
      used: quota.used as number,
      limit: 100,
      exhausted: quota.exhausted as boolean,
    }),
  });
}

export function assertNoPublicLeakage(
  captured: string,
  forbidden: readonly { readonly label: string; readonly value: string }[],
): true {
  if (typeof captured !== "string" || captured.length === 0 || forbidden.length === 0) {
    throw new Error("E2E_PUBLIC_LEAKAGE_CAPTURE_INVALID");
  }
  for (const entry of forbidden) {
    if (!/^[a-z0-9-]+$/u.test(entry.label) || entry.value.length === 0) {
      throw new Error("E2E_PUBLIC_LEAKAGE_ENTRY_INVALID");
    }
    if (captured.includes(entry.value)) {
      throw new Error(`E2E_PUBLIC_LEAK:${entry.label}`);
    }
  }
  return true;
}

export async function createVerifiedBackup(): Promise<VerifiedBackupFixture> {
  const rootDirectory = mkdtempSync(join(tmpdir(), E2E_BACKUP_PREFIX));
  assertSafeBackupDirectory(rootDirectory);
  let ownershipRecord: string;
  try {
    await protectOwnerOnlyPath(rootDirectory, "DIRECTORY");
    if (!await fixtureOwnerOnlyPath(rootDirectory, "DIRECTORY")) {
      throw new Error("E2E_BACKUP_DIRECTORY_PERMISSIONS_INVALID");
    }
    ownershipRecord = await registerFixtureOwnership(currentOwnershipRegistry(), {
      kind: "BACKUP", value: rootDirectory,
    });
  } catch (error) {
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }
  const destination = join(rootDirectory, "generation");
  const keyPath = join(rootDirectory, "backup.key");
  const binaryDirectory = postgresBin();
  try {
    await writeFile(keyPath, new Uint8Array(), { mode: 0o600, flag: "wx" });
    await protectOwnerOnlyPath(keyPath, "FILE");
    if (!await fixtureOwnerOnlyPath(keyPath, "FILE")) {
      throw new Error("E2E_BACKUP_KEY_PERMISSIONS_INVALID");
    }
    await writeFile(keyPath, randomBytes(64), { flag: "r+" });
    await runPowerShellScript("infra/backup/create.ps1", [
      "-DestinationDirectory", destination,
      "-KeyFile", keyPath,
      "-KeyVersion", "e2e-key-v1",
      "-PsqlPath", executable(binaryDirectory, "psql"),
      "-PgDumpPath", executable(binaryDirectory, "pg_dump"),
    ], { GUSTAVO_BACKUP_DATABASE_URL: backupDatabaseURL() });
    const manifestPath = join(destination, "backup.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      readonly eventHighWater?: unknown;
      readonly schemaVersion?: unknown;
    };
    if (typeof manifest.eventHighWater !== "string"
        || typeof manifest.schemaVersion !== "string") {
      throw new Error("E2E_BACKUP_MANIFEST_INVALID");
    }
    const output = await runPowerShellScript("infra/backup/verify.ps1", [
      "-ManifestPath", manifestPath,
      "-KeyFile", keyPath,
    ]);
    if (!output.includes("BACKUP VERIFIED")) throw new Error("E2E_BACKUP_NOT_VERIFIED");
    return Object.freeze({
      verified: true,
      eventHighWater: manifest.eventHighWater,
      schemaVersion: manifest.schemaVersion,
      manifestPath,
      keyPath,
      rootDirectory,
      ownershipRecord,
    });
  } catch (error) {
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 5 });
    await unregisterFixtureOwnership(ownershipRecord);
    throw error;
  }
}

export async function restoreFixture(
  backup: VerifiedBackupFixture,
): Promise<RestoredFixture> {
  assertSafeBackupDirectory(backup.rootDirectory);
  const binaryDirectory = postgresBin();
  const activeDatabase = new URL(databaseURL()).pathname.slice(1);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/u.test(activeDatabase)) {
    throw new Error("E2E_ACTIVE_DATABASE_INVALID");
  }
  const restoreDatabase = `gustavo_e2e_restore_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const output = await runPowerShellScript("infra/backup/restore-drill.ps1", [
    "-ManifestPath", backup.manifestPath,
    "-KeyFile", backup.keyPath,
    "-RestoreDatabaseName", restoreDatabase,
    "-ActiveDatabaseName", activeDatabase,
    "-CreatedbPath", executable(binaryDirectory, "createdb"),
    "-PgRestorePath", executable(binaryDirectory, "pg_restore"),
    "-PsqlPath", executable(binaryDirectory, "psql"),
    "-DropdbPath", executable(binaryDirectory, "dropdb"),
  ], { GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL: backupDatabaseURL() });
  const match = /RESTORE DRILL PASSED[^\r\n]*; schema: ([^;\r\n]+); event high-water: ([^\r\n]+)/u.exec(output);
  if (!match?.[1] || !match[2]) throw new Error("E2E_RESTORE_RESULT_INVALID");
  return Object.freeze({ schemaVersion: match[1].trim(), eventHighWater: match[2].trim() });
}

export async function cleanupVerifiedBackup(backup: VerifiedBackupFixture): Promise<void> {
  assertSafeBackupDirectory(backup.rootDirectory);
  await rm(backup.rootDirectory, { recursive: true, force: true, maxRetries: 5 });
  await unregisterFixtureOwnership(backup.ownershipRecord);
}

function assertValkeyContainerName(name: string): void {
  if (!new RegExp(`^${E2E_VALKEY_CONTAINER_PREFIX}[0-9a-f]{32}$`, "u").test(name)) {
    throw new Error("UNSAFE_E2E_VALKEY_CONTAINER");
  }
}

function assertCodexContainerName(name: string): void {
  if (!new RegExp(`^${E2E_CODEX_CONTAINER_PREFIX}[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`, "u")
    .test(name)) {
    throw new Error("UNSAFE_E2E_CODEX_CONTAINER");
  }
}

async function docker(arguments_: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", [...arguments_], {
    cwd: process.cwd(),
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function removeCodexContainer(
  name: string,
  registry: string,
  invokeDocker: DockerInvocation = docker,
): Promise<void> {
  assertCodexContainerName(name);
  assertSafeOwnershipRegistry(registry);
  const registryId = resolve(registry).split(/[\\/]/u).at(-1)!;
  let labels: string;
  try {
    labels = await invokeDocker([
      "container", "inspect", "--format",
      `{{ index .Config.Labels "${E2E_CODEX_OWNER_LABEL}" }}|{{ index .Config.Labels "com.gustavo.codex-runner" }}`,
      name,
    ]);
  } catch (error) {
    if (exactNoSuchContainer(error, name)) return;
    throw error;
  }
  if (labels.trim() !== `${registryId}|v1`) {
    throw new Error("E2E_CODEX_CONTAINER_OWNERSHIP_LABEL_INVALID");
  }
  await invokeDocker(["rm", "--force", name]);
}

export async function registerOwnedCodexContainer(name: string): Promise<string> {
  assertCodexContainerName(name);
  return registerFixtureOwnership(currentOwnershipRegistry(), {
    kind: "CONTAINER",
    value: name,
  });
}

export async function cleanupOwnedCodexContainer(
  name: string,
  ownershipRecord: string,
): Promise<void> {
  const registry = resolve(ownershipRecord, "..");
  await removeCodexContainer(name, registry);
  await unregisterFixtureOwnership(ownershipRecord, registry);
}

export function currentFixtureOwnershipId(): string {
  return resolve(currentOwnershipRegistry()).split(/[\\/]/u).at(-1)!;
}

interface OwnedValkeyContainer {
  readonly name: string;
  readonly ownershipRecord: string;
}

export async function runOwnedValkeyContainerForTest(
  registry: string,
  port: number,
  invokeDocker: DockerInvocation = docker,
): Promise<OwnedValkeyContainer> {
  assertSafeOwnershipRegistry(registry);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_VALKEY_PORT_INVALID");
  }
  const name = `${E2E_VALKEY_CONTAINER_PREFIX}${randomUUID().replaceAll("-", "")}`;
  assertValkeyContainerName(name);
  const registryId = resolve(registry).split(/[\\/]/u).at(-1)!;
  const ownershipRecord = await registerFixtureOwnership(registry, {
    kind: "VALKEY", value: name,
  });
  try {
    await invokeDocker([
      "run", "--detach", "--rm", "--name", name,
      "--label", `${E2E_VALKEY_OWNER_LABEL}=${registryId}`,
      "--publish", `127.0.0.1:${port}:6379`,
      E2E_VALKEY_IMAGE,
      "valkey-server", "--appendonly", "yes", "--appendfsync", "everysec",
    ]);
  } catch (error) {
    try {
      await removeValkeyContainer(name, registry, invokeDocker);
      await unregisterFixtureOwnership(ownershipRecord, registry);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "E2E_VALKEY_RUN_AND_CLEANUP_FAILED",
      );
    }
    throw error;
  }
  return Object.freeze({ name, ownershipRecord });
}

async function startValkeyContainer(port: number): Promise<OwnedValkeyContainer> {
  const container = await runOwnedValkeyContainerForTest(
    currentOwnershipRegistry(),
    port,
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pong = await docker(["exec", container.name, "valkey-cli", "ping"])
      .catch(() => "");
    if (pong === "PONG") return container;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  await stopValkeyContainer(container).catch(() => undefined);
  throw new Error("E2E_VALKEY_START_TIMEOUT");
}

async function stopValkeyContainer(container: OwnedValkeyContainer): Promise<void> {
  assertValkeyContainerName(container.name);
  const registry = resolve(container.ownershipRecord, "..");
  await removeValkeyContainer(container.name, registry);
  await unregisterFixtureOwnership(container.ownershipRecord);
}

async function valkeyKeyCount(name: string): Promise<number> {
  assertValkeyContainerName(name);
  const value = await docker(["exec", name, "valkey-cli", "dbsize"]);
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("E2E_VALKEY_DBSIZE_INVALID");
  return count;
}

export async function restartCache(): Promise<CacheRestartFixture> {
  const port = await reserveLoopbackPort();
  const previousValkeyURL = process.env.VALKEY_URL;
  const previousEncryptionKey = process.env.GUSTAVO_CACHE_ENCRYPTION_KEY;
  const encryptionKey = randomBytes(32).toString("base64");
  process.env.VALKEY_URL = `redis://127.0.0.1:${port}`;
  process.env.GUSTAVO_CACHE_ENCRYPTION_KEY = encryptionKey;
  let firstContainer: OwnedValkeyContainer | undefined;
  let secondContainer: OwnedValkeyContainer | undefined;
  try {
    firstContainer = await startValkeyContainer(port);
    const firstRuntime = await createProductionCacheRuntime();
    const rebuilt = await rebuildPostgresCache({
      db: firstRuntime.db, cache: firstRuntime.publisher, checkpoint: "CURRENT",
    }).finally(() => firstRuntime.close());
    const keysBeforeLoss = await valkeyKeyCount(firstContainer.name);
    if (keysBeforeLoss < 1) throw new Error("E2E_VALKEY_REBUILD_EMPTY");
    await stopValkeyContainer(firstContainer);
    firstContainer = undefined;

    secondContainer = await startValkeyContainer(port);
    const keysAfterLoss = await valkeyKeyCount(secondContainer.name);
    if (keysAfterLoss !== 0) throw new Error("E2E_VALKEY_LOSS_NOT_CLEAN");
    const secondRuntime = await createProductionCacheRuntime();
    const prewarmed = await prewarmPostgresCache({
      db: secondRuntime.db, cache: secondRuntime.publisher, checkpoint: "CURRENT",
    }).finally(() => secondRuntime.close());
    const keysAfterPrewarm = await valkeyKeyCount(secondContainer.name);
    if (keysAfterPrewarm < 1) throw new Error("E2E_VALKEY_PREWARM_EMPTY");
    if (rebuilt.source !== "POSTGRES" || prewarmed.source !== "POSTGRES") {
      throw new Error("E2E_CACHE_SOURCE_INVALID");
    }
    return Object.freeze({
      rebuilt: true,
      prewarmed: true,
      source: "POSTGRES",
      backend: "VALKEY",
      keysBeforeLoss,
      keysAfterLoss: 0,
      keysAfterPrewarm,
    });
  } finally {
    if (firstContainer) await stopValkeyContainer(firstContainer).catch(() => undefined);
    if (secondContainer) await stopValkeyContainer(secondContainer).catch(() => undefined);
    if (previousValkeyURL === undefined) delete process.env.VALKEY_URL;
    else process.env.VALKEY_URL = previousValkeyURL;
    if (previousEncryptionKey === undefined) delete process.env.GUSTAVO_CACHE_ENCRYPTION_KEY;
    else process.env.GUSTAVO_CACHE_ENCRYPTION_KEY = previousEncryptionKey;
  }
}

export async function waitForScheduledBroadcast(): Promise<ScheduledBroadcastFixture> {
  const pool = new Pool({ connectionString: databaseURL(), max: 2 });
  try {
    const database = databaseFromPool(pool);
    const scheduleId = `e2e-${randomUUID()}`;
    const now = new Date();
    const slotAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    await database.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ($1,'* * * * *','UTC',true,$2)`,
      [scheduleId, new Date(slotAt.getTime() - 1_000)],
    );
    const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const schedulerProgram = [
      'import { Pool } from "pg";',
      'import { databaseFromPool } from "./lib/server/db/postgres.ts";',
      'import { runBroadcastSchedulerOnce } from "./worker/broadcasts/scheduler.ts";',
      '(async () => {',
      'const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });',
      'try { await runBroadcastSchedulerOnce({ db: databaseFromPool(pool),',
      'now: () => new Date(process.env.GUSTAVO_E2E_SCHEDULE_NOW) }); }',
      'finally { await pool.end(); }',
      '})().catch((error) => { console.error(error); process.exitCode = 1; });',
    ].join("\n");
    await execFileAsync(process.execPath, [tsxCli, "--eval", schedulerProgram], {
      cwd: process.cwd(),
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: databaseURL(), GUSTAVO_E2E_SCHEDULE_NOW: now.toISOString() },
    });
    const cycle = await database.query<{
      readonly author_type: string;
      readonly slot_at: Date;
    }>(
      "select author_type,slot_at from broadcast_cycles where schedule_id=$1",
      [scheduleId],
    );
    if (cycle.length !== 1 || cycle[0]?.author_type !== "MAIN_BRAIN"
        || cycle[0].slot_at.toISOString() !== slotAt.toISOString()) {
      throw new Error("E2E_SCHEDULED_BROADCAST_MISSING");
    }
    return Object.freeze({ authorType: "MAIN_BRAIN" });
  } finally {
    await pool.end();
  }
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
