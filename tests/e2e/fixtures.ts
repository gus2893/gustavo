import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { chmod, lstat, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
import { appendEvent } from "../../lib/server/events/store";
import {
  commitMainBaseline,
  openDecisionWindow,
  recordEvaluation,
} from "../../lib/server/orchestration/decision-window";

const execFileAsync = promisify(execFile);
const E2E_DATABASE_PREFIX = "gustavo-e2e-postgres-";
const E2E_BACKUP_PREFIX = "gustavo-e2e-backup-";
const E2E_VALKEY_CONTAINER_PREFIX = "gustavo-e2e-valkey-";
const E2E_OWNERSHIP_PREFIX = "gustavo-e2e-ownership-";
const E2E_OWNERSHIP_ENV = "GUSTAVO_E2E_OWNERSHIP_REGISTRY";
const E2E_VALKEY_IMAGE = "valkey/valkey:8.1.3-bookworm";
const E2E_VALKEY_OWNER_LABEL = "com.gustavo.e2e.registry";
const TEST_PROVIDER = "gustavo-e2e-licensed";
const TEST_LICENSE = "e2e-license-v1";

interface E2eRuntime {
  dataDirectory: string;
  ownershipDirectory: string;
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

export type FixtureOwnership = Readonly<{
  kind: "BACKUP" | "VALKEY";
  value: string;
}>;

export interface FixtureOwnershipOperations {
  readonly removeValkey?: (name: string) => Promise<void>;
  readonly removeBackup?: (directory: string) => Promise<void>;
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
  else throw new Error("E2E_OWNERSHIP_INVALID");
  return Object.freeze({ kind: ownership.kind, value: ownership.value });
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
      } else {
        await (operations.removeBackup ?? removeOwnedBackup)(ownership.value);
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

async function cleanup(runtime: Partial<E2eRuntime>): Promise<void> {
  const failures: unknown[] = [];
  if (runtime.ownershipDirectory) {
    await cleanupFixtureOwnershipRegistry(runtime.ownershipDirectory)
      .catch((error: unknown) => failures.push(error));
  }
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
  delete process.env[E2E_OWNERSHIP_ENV];
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
    process.env.GUSTAVO_OPERATOR_HEALTH_TOKEN = randomBytes(32).toString("base64url");

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

async function docker(arguments_: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", [...arguments_], {
    cwd: process.cwd(),
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
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
