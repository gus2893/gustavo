import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { MARKET_UNIVERSE } from "../../config/market-universe";
import type { OpaqueQStashWake } from "../../lib/server/bridge/qstash";
import { databaseFromPool } from "../../lib/server/db/postgres";
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import { appendEvent } from "../../lib/server/events/store";
import type { EventDatabase } from "../../lib/server/events/types";
import { loadLatestMarket } from "../../lib/server/market-data/latest";
import type {
  CodexContainerIdentity,
  CodexDockerController,
  CodexRole,
  DockerInspection,
} from "../../worker/hybrid/codex-runner";
import type {
  HybridContainerController,
  HybridRuntimeController,
  HybridRuntimeHeartbeat,
} from "../../worker/hybrid/runtime";
import type {
  HybridWorkerHost,
} from "../../worker/hybrid/wake-server";
import {
  assertFreshHybridInventory,
  assertHostedWakePublished,
  assertLoopbackPortAvailable,
  assertMarketMaterializerIsolation,
  assertMarketScheduleBody,
  assertNoPublicLeakage,
  assertNoOwnedFixtureResidue,
  cleanupOwnedMaintenanceLauncher,
  cleanupOwnedHybridChild,
  cleanupOwnedCodexContainer,
  createOwnedMaintenanceLauncher,
  createOwnedChildSettlementAuthority,
  currentFixtureOwnershipId,
  deliverMarketSchedule,
  e2eBaseURL,
  hybridE2eDatabaseURLs,
  issueInvitation,
  pauseMarketSchedule,
  readOperatorHybridHealth,
  registerOwnedCodexContainer,
  registerOwnedHybridChild,
  reserveLoopbackPort,
} from "./fixtures";

const PRIVATE_CANARY = "private-hybrid-canary-813";
const OFFLINE_CANARY = "private-offline-recovery-canary-813";
const PENDING_CANARY = "private-maintenance-pending-canary-813";
const PRESERVED_CANARY = "private-maintenance-preserved-canary-813";
const NODE_REPLY = "Node private fixture reply";
const LIVE_QUOTE = "813.42";
const PUBLIC_WAKE_URL = "https://gustavo-fixture.private-fixture.ts.net/wake";
const CURRENT_SIGNING_KEY = "e2e-current-signing-key-with-at-least-32-bytes";
const NEXT_SIGNING_KEY = "e2e-next-signing-key-with-at-least-32-bytes";
const CODEX_IMAGE = `sha256:${"a".repeat(64)}`;
const CODEX_AUTH_VOLUME = "gustavo-codex-auth-v1" as const;
const CONTAINER_ID = "c".repeat(64);
const execFileAsync = promisify(execFile);

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signedWake(input: {
  readonly body: OpaqueQStashWake;
  readonly messageId: string;
  readonly now?: Date;
}): { readonly body: string; readonly headers: Readonly<Record<string, string>> } {
  const now = input.now ?? new Date();
  const rawBody = JSON.stringify(input.body);
  const issuedAt = Math.floor(now.getTime() / 1_000) - 1;
  const unsigned = `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({
    iss: "Upstash",
    sub: PUBLIC_WAKE_URL,
    body: createHash("sha256").update(rawBody, "utf8").digest("base64url"),
    iat: issuedAt,
    nbf: issuedAt - 1,
    exp: issuedAt + 3_600,
    jti: input.messageId,
  })}`;
  const signature = `${unsigned}.${createHmac("sha256", CURRENT_SIGNING_KEY)
    .update(unsigned).digest("base64url")}`;
  return Object.freeze({
    body: rawBody,
    headers: Object.freeze({
      "content-length": String(Buffer.byteLength(rawBody, "utf8")),
      "content-type": "application/json",
      "upstash-message-id": input.messageId,
      "upstash-signature": signature,
    }),
  });
}

function exactInspection(
  identity: CodexContainerIdentity,
  state: DockerInspection["state"],
  exitCode: number | null,
): DockerInspection {
  return Object.freeze({
    id: identity.containerId ?? CONTAINER_ID,
    name: identity.name,
    image: identity.image,
    labels: identity.labels,
    state,
    exitCode: state === "exited" ? exitCode : null,
  });
}

function responseForRole(role: CodexRole): string {
  if (role === "NODE") return NODE_REPLY;
  if (role === "MAIN") return JSON.stringify({
    candidate: "Main fixture candidate with source-bounded educational context.",
  });
  return JSON.stringify({
    decision: "ACCEPT",
    rationaleCode: "SUPPORTED",
    rubricVersion: "broadcast-evaluator-v1",
  });
}

function exactDockerHelperEnvironment(
  environment: Readonly<Record<string, string>>,
): boolean {
  const allowed = process.platform === "win32"
    ? ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]
    : ["TMPDIR"];
  const expected: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (!value) continue;
    const canonical = name === "SYSTEMROOT" ? "SystemRoot" : name;
    expected[canonical] ??= value;
  }
  const entries = (value: Readonly<Record<string, string>>) => (
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  );
  return JSON.stringify(entries(environment)) === JSON.stringify(entries(expected));
}

function expectedCodexCreateArguments(role: CodexRole, runId: string): readonly string[] {
  const timeout = role === "NODE" ? "90s" : role === "EVALUATOR" ? "180s" : "300s";
  const schema = role === "NODE" ? "/schemas/node.schema.json"
    : role === "MAIN" ? "/schemas/main.schema.json"
      : "/schemas/evaluator.schema.json";
  return Object.freeze([
    "create", "-i", "--read-only", "--init", "--cap-drop=ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64", "--memory", "512m", "--cpus", "1.0",
    "--network", "bridge", "--pull=never",
    "--tmpfs", "/workspace:rw,noexec,nosuid,nodev,size=16777216",
    "--mount", "type=volume,src=gustavo-codex-auth-v1,dst=/codex-home",
    "--env", "CODEX_HOME=/codex-home",
    "--name", "gustavo-codex-singleton-v1",
    "--label", "com.gustavo.codex-runner=v1",
    "--label", `com.gustavo.codex-run-id=${runId}`,
    CODEX_IMAGE,
    "/usr/bin/timeout", "--signal=KILL", "--kill-after=5s", timeout,
    "codex", "exec", "--ephemeral", "--ignore-user-config",
    "--config", "features.shell_tool=false",
    "--config", "features.unified_exec=false",
    "--config", "features.apps=false",
    "--config", "features.multi_agent=false",
    "--config", "features.hooks=false",
    "--config", "features.skill_mcp_dependency_install=false",
    "--config", "features.browser_use=false",
    "--config", "features.browser_use_external=false",
    "--config", "features.browser_use_full_cdp_access=false",
    "--config", "features.computer_use=false",
    "--config", "features.in_app_browser=false",
    "--config", "features.enable_mcp_apps=false",
    "--config", "features.plugins=false",
    "--config", "features.remote_plugin=false",
    "--config", "features.tool_call_mcp_elicitation=false",
    "--config", "features.tool_suggest=false",
    "--config", "features.code_mode_host=false",
    "--config", "features.image_generation=false",
    "--config", "features.skill_search=false",
    "--config", "features.workspace_dependencies=false",
    "--config", "features.js_repl=false",
    "--config", "features.auth_elicitation=false",
    "--config", "features.goals=false",
    "--config", "features.plugin_sharing=false",
    "--config", "features.shell_snapshot=false",
    "--config", "tools.view_image=false",
    "--config", 'web_search="disabled"',
    "--config", 'history.persistence="none"',
    "--config", "feedback.enabled=false",
    "--skip-git-repo-check", "--sandbox", "read-only",
    "--ask-for-approval", "never", "--model", "gpt-5.6-sol", "--json",
    "--output-schema", schema, "-C", "/workspace", "-",
  ]);
}

function sameCodexIdentity(
  left: CodexContainerIdentity,
  right: CodexContainerIdentity,
): boolean {
  return left.name === right.name && left.runId === right.runId
    && left.image === right.image && left.containerId === right.containerId
    && JSON.stringify(left.labels) === JSON.stringify(right.labels);
}

class FakeCodexContainerTransport implements CodexDockerController {
  readonly roleInvocations: CodexRole[] = [];
  modelGateReached = false;
  maxActiveContainers = 0;
  private activeContainers = 0;
  private exitPromise: Promise<number> | undefined;
  private exitCode: number | null = null;
  private resolveExit: ((exitCode: number) => void) | undefined;
  private hostLease = false;
  private authority: CodexContainerIdentity | undefined;
  private role: CodexRole | undefined;
  private state: "ABSENT" | "CREATED" | "EXITED" = "ABSENT";
  private startGate: { readonly promise: Promise<void>; release(): void } | undefined;
  private completedContracts = 0;
  private createContracts = 0;
  private environmentContracts = 0;
  private inspectContracts = 0;
  private removeContracts = 0;
  private startContracts = 0;
  private lifecycle: string[] = [];
  private lifecycleExact = true;

  get containerAbsent(): boolean {
    return this.state === "ABSENT" && this.activeContainers === 0;
  }

  get codexCreateContractExact(): boolean {
    return this.createContracts > 0 && this.createContracts === this.completedContracts;
  }

  get codexEnvironmentExact(): boolean {
    return this.environmentContracts > 0
      && this.environmentContracts === this.completedContracts * 2;
  }

  get codexInspectDerivedFromCreate(): boolean {
    return this.inspectContracts > 0 && this.inspectContracts === this.completedContracts * 3;
  }

  get codexLifecycleOrderExact(): boolean {
    return this.lifecycleExact && this.completedContracts > 0;
  }

  get codexRemoveContractExact(): boolean {
    return this.removeContracts > 0 && this.removeContracts === this.completedContracts;
  }

  get codexStartContractExact(): boolean {
    return this.startContracts > 0 && this.startContracts === this.completedContracts;
  }

  private requireLifecycle(expected: readonly string[], next: string): void {
    if (JSON.stringify(this.lifecycle) !== JSON.stringify(expected)) {
      this.lifecycleExact = false;
      throw new Error("E2E_CODEX_LIFECYCLE_ORDER_INVALID");
    }
    this.lifecycle.push(next);
  }

  gateNextStart(): void {
    if (this.startGate) throw new Error("E2E_CODEX_START_GATE_ALREADY_SET");
    let release!: () => void;
    const promise = new Promise<void>((resolveGate) => { release = resolveGate; });
    this.startGate = Object.freeze({ promise, release });
    this.modelGateReached = false;
  }

  releaseStartGate(): void {
    const gate = this.startGate;
    if (!gate) throw new Error("E2E_CODEX_START_GATE_NOT_SET");
    this.startGate = undefined;
    gate.release();
  }

  async acquireHostLease(): Promise<{ release(): Promise<void> } | undefined> {
    if (this.hostLease) return undefined;
    this.hostLease = true;
    return Object.freeze({
      release: async () => {
        if (!this.hostLease) throw new Error("E2E_CODEX_LEASE_DOUBLE_RELEASE");
        this.hostLease = false;
      },
    });
  }

  async create(request: Parameters<CodexDockerController["create"]>[0]) {
    if (this.state !== "ABSENT" || !this.hostLease || request.signal.aborted) {
      throw new Error("E2E_CODEX_CREATE_STATE_INVALID");
    }
    const args = [...request.args];
    const schemaIndex = args.indexOf("--output-schema");
    const schema = args[schemaIndex + 1];
    const role = schema === "/schemas/node.schema.json" ? "NODE"
      : schema === "/schemas/main.schema.json" ? "MAIN"
        : schema === "/schemas/evaluator.schema.json" ? "EVALUATOR" : undefined;
    const runLabel = args.find((value) => value.startsWith("com.gustavo.codex-run-id="));
    const runId = runLabel?.slice("com.gustavo.codex-run-id=".length);
    if (!role || !runId || !/^[a-f0-9]{32}$/u.test(runId)
        || JSON.stringify(args) !== JSON.stringify(expectedCodexCreateArguments(role, runId))
        || request.maxStdoutBytes !== 128 || request.maxStderrBytes !== 65_536
        || !exactDockerHelperEnvironment(request.env)) {
      throw new Error("E2E_CODEX_ARGUMENT_VALIDATION_FAILED");
    }
    this.requireLifecycle([], "create");
    const nameIndex = args.indexOf("--name");
    const imageIndex = args.indexOf(CODEX_IMAGE);
    const labelIndexes = args.flatMap((value, index) => value === "--label" ? [index] : []);
    const parsedLabels = Object.fromEntries(labelIndexes.map((index) => {
      const [name, value] = (args[index + 1] ?? "").split("=", 2);
      return [name, value];
    }));
    this.authority = Object.freeze({
      name: args[nameIndex + 1]!,
      runId,
      image: args[imageIndex]!,
      labels: Object.freeze(parsedLabels),
      containerId: CONTAINER_ID,
    });
    this.createContracts += 1;
    this.environmentContracts += 1;
    this.role = role;
    this.state = "CREATED";
    this.exitCode = null;
    this.activeContainers += 1;
    this.maxActiveContainers = Math.max(this.maxActiveContainers, this.activeContainers);
    this.exitPromise = new Promise<number>((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    return Object.freeze({
      exitCode: 0,
      stdout: Buffer.from(`${CONTAINER_ID}\n`, "utf8"),
      stderr: Buffer.alloc(0),
      helperExitProven: true,
      completion: "NATURAL" as const,
    });
  }

  async start(request: Parameters<CodexDockerController["start"]>[0]) {
    if (this.state !== "CREATED" || !this.role || !this.authority || request.signal.aborted
        || !sameCodexIdentity(request.identity, this.authority)
        || request.stdin.byteLength === 0 || request.stdin.byteLength > 65_536
        || request.maxStdoutBytes !== 1_048_576 || request.maxStderrBytes !== 65_536
        || !exactDockerHelperEnvironment(request.env)) {
      throw new Error("E2E_CODEX_START_STATE_INVALID");
    }
    this.requireLifecycle(["create", "inspect-created", "wait"], "start");
    this.environmentContracts += 1;
    this.startContracts += 1;
    this.roleInvocations.push(this.role);
    if (this.startGate) {
      this.modelGateReached = true;
      await this.startGate.promise;
    }
    this.state = "EXITED";
    this.exitCode = 0;
    this.resolveExit?.(0);
    return Object.freeze({
      exitCode: 0,
      stdout: Buffer.from(`${JSON.stringify({ response: responseForRole(this.role) })}\n`, "utf8"),
      stderr: Buffer.alloc(0),
    });
  }

  async wait(request: Parameters<CodexDockerController["wait"]>[0]) {
    const exitPromise = this.exitPromise;
    if (!this.authority || !sameCodexIdentity(request.identity, this.authority)
        || this.state === "ABSENT" || !exitPromise) {
      throw new Error("E2E_CODEX_WAIT_STATE_INVALID");
    }
    this.requireLifecycle(["create", "inspect-created"], "wait");
    const containerExitCode = await exitPromise;
    if (request.signal.aborted) throw new Error("E2E_CODEX_WAIT_ABORTED");
    return Object.freeze({ helperExitCode: 0, containerExitCode });
  }

  async kill(request: Parameters<CodexDockerController["kill"]>[0]) {
    if (request.identity.containerId !== CONTAINER_ID || this.state === "ABSENT") {
      throw new Error("E2E_CODEX_KILL_STATE_INVALID");
    }
    this.state = "EXITED";
    this.exitCode = 137;
    this.resolveExit?.(137);
    return Object.freeze({ helperExitCode: 0 });
  }

  async remove(request: Parameters<CodexDockerController["remove"]>[0]) {
    if (!this.authority || !sameCodexIdentity(request.identity, this.authority)
        || this.state !== "EXITED") {
      throw new Error("E2E_CODEX_REMOVE_STATE_INVALID");
    }
    this.requireLifecycle(
      ["create", "inspect-created", "wait", "start", "inspect-exited"],
      "remove",
    );
    this.state = "ABSENT";
    this.role = undefined;
    this.exitPromise = undefined;
    this.resolveExit = undefined;
    this.exitCode = null;
    this.activeContainers -= 1;
    this.removeContracts += 1;
    return Object.freeze({ helperExitCode: 0 });
  }

  async inspect(request: Parameters<CodexDockerController["inspect"]>[0]) {
    if (!this.authority || !sameCodexIdentity(request.identity, this.authority)) {
      throw new Error("E2E_CODEX_INSPECT_ID_INVALID");
    }
    if (this.state === "ABSENT") {
      this.requireLifecycle(
        ["create", "inspect-created", "wait", "start", "inspect-exited", "remove"],
        "inspect-absent",
      );
      this.inspectContracts += 1;
      this.completedContracts += 1;
      this.authority = undefined;
      this.lifecycle = [];
      return Object.freeze({ daemonAvailable: true, exists: false });
    }
    this.requireLifecycle(
      this.state === "CREATED"
        ? ["create"]
        : ["create", "inspect-created", "wait", "start"],
      this.state === "CREATED" ? "inspect-created" : "inspect-exited",
    );
    this.inspectContracts += 1;
    return Object.freeze({
      daemonAvailable: true,
      exists: true,
      inspection: exactInspection(
        this.authority,
        this.state === "CREATED" ? "created" : "exited",
        this.exitCode,
      ),
    });
  }

  async list() {
    return Object.freeze({
      daemonAvailable: true,
      names: this.state === "ABSENT" || !this.authority
        ? Object.freeze([])
        : Object.freeze([this.authority.name]),
    });
  }
}

interface HybridHarness {
  readonly controlStopped: Promise<void>;
  readonly host: HybridWorkerHost;
  readonly pool: Pool;
  readonly providerCalls: { count: number; symbols: string[] };
  readonly runtime: HybridRuntimeController;
  readonly transport: FakeCodexContainerTransport;
  releaseHeartbeatGate(): void;
  gateNextHeartbeatRefresh(): void;
  gateNextMarketDerivation(): void;
  releaseMarketDerivationGate(): void;
  gateNextWakeAdmission(): void;
  releaseWakeAdmissionGate(): void;
}

async function startHybridHarness(
  transport: FakeCodexContainerTransport,
  controlNonce = randomBytes(32).toString("base64url"),
  port = 0,
): Promise<HybridHarness> {
  const [{ runIsolatedCodex }, { createConfiguredHybridWorkerAssembly }] = await Promise.all([
    import("../../worker/hybrid/codex-runner"),
    import("../../worker/hybrid/wake-server"),
  ]);
  const urls = hybridE2eDatabaseURLs();
  const pool = new Pool({ connectionString: urls.ordinary, max: 4 });
  const database = databaseFromPool(pool);
  const providerCalls = { count: 0, symbols: [] as string[] };
  let heartbeatGate: { readonly promise: Promise<void>; release(): void } | undefined;
  let marketDerivationGate: { readonly promise: Promise<void>; release(): void } | undefined;
  let wakeAdmissionGate: { readonly promise: Promise<void>; release(): void } | undefined;
  const wrapDatabase = (inner: EventDatabase, applicationName: string): EventDatabase => ({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> => {
      if (applicationName === "gustavo-hybrid-heartbeat"
          && sql.includes("insert into hybrid_worker_heartbeats")
          && parameters?.[0] === "CODEX" && parameters[1] === "HEALTHY"
          && heartbeatGate) {
        const gate = heartbeatGate;
        await gate.promise;
        if (heartbeatGate === gate) heartbeatGate = undefined;
      }
      return inner.query<Row>(sql, parameters);
    },
    one: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ) => inner.one<Row>(sql, parameters),
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      inner.transaction((transaction) => work(wrapDatabase(transaction, applicationName)))
    ),
  });
  const dockerExecutable = process.platform === "win32"
    ? resolve(process.env.ProgramFiles ?? "C:\\Program Files", "Docker/Docker/resources/bin/docker.exe")
    : "/usr/bin/docker";
  const configuredPort = port === 0 ? await reserveLoopbackPort() : port;
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL: urls.ordinary,
    GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL: urls.materializer,
    GUSTAVO_HYBRID_IMAGE_DIGEST: CODEX_IMAGE,
    GUSTAVO_DOCKER_EXECUTABLE: dockerExecutable,
    GUSTAVO_HYBRID_PUBLIC_WAKE_URL: PUBLIC_WAKE_URL,
    QSTASH_CURRENT_SIGNING_KEY: CURRENT_SIGNING_KEY,
    QSTASH_NEXT_SIGNING_KEY: NEXT_SIGNING_KEY,
    GUSTAVO_HYBRID_CONTROL_NONCE: controlNonce,
    GUSTAVO_HYBRID_PORT: String(configuredPort),
  };
  const assembly = createConfiguredHybridWorkerAssembly({
    environment,
    databaseLifecycle: async (input, work) => {
      if (input.connectionString !== urls.ordinary) {
        throw new Error("E2E_CONFIGURED_DATABASE_INVALID");
      }
      if (input.applicationName === "gustavo-hybrid-market-window" && marketDerivationGate) {
        await marketDerivationGate.promise;
      }
      if (input.applicationName === "gustavo-hybrid-wake" && wakeAdmissionGate) {
        await wakeAdmissionGate.promise;
      }
      return input.transaction
        ? database.transaction((transaction) => work(wrapDatabase(
          transaction,
          input.applicationName,
        )))
        : work(wrapDatabase(database, input.applicationName));
    },
    runDockerCommand: async (_executable, args, signal) => {
      if (signal.aborted) return Object.freeze({ exitCode: null, stdout: "" });
      if (JSON.stringify(args) === JSON.stringify(["version", "--format", "{{.Server.Version}}"])) {
        return Object.freeze({ exitCode: 0, stdout: "24.0.0" });
      }
      if (JSON.stringify(args) === JSON.stringify([
        "image", "inspect", "--format", "{{.Id}}", CODEX_IMAGE,
      ])) return Object.freeze({ exitCode: 0, stdout: CODEX_IMAGE });
      if (JSON.stringify(args) === JSON.stringify([
        "volume", "inspect", "--format", "{{.Name}}", CODEX_AUTH_VOLUME,
      ])) return Object.freeze({ exitCode: 0, stdout: CODEX_AUTH_VOLUME });
      throw new Error("E2E_DOCKER_PREFLIGHT_COMMAND_INVALID");
    },
    reconcileCodex: async ({ signal }) => {
      if (signal?.aborted || !transport.containerAbsent) {
        throw new Error("E2E_CONTAINER_RECONCILE_FAILED");
      }
      return Object.freeze({ reconciled: true as const });
    },
    runCodex: (input) => runIsolatedCodex({
      ...input,
      resolveDockerExecutable: async (recordedPath) => recordedPath,
      controller: transport,
    }),
    createFinnhubClient: () => {
      const sourceNow = Math.floor(Date.now() / 1_000);
      return Object.freeze({
        async fetchMarketStatus() {
          providerCalls.count += 1;
          return Object.freeze({ status: 200, json: { isOpen: true } });
        },
        async fetchQuote(symbol: string) {
          providerCalls.count += 1;
          providerCalls.symbols.push(symbol);
          return Object.freeze({ status: 200, json: { c: Number(LIVE_QUOTE), t: sourceNow } });
        },
      });
    },
    createMarketClock: () => {
      let pacingClock = 0;
      const sourceNow = Math.floor(Date.now() / 1_000) * 1_000;
      return Object.freeze({
        sleep: async (milliseconds: number) => { pacingClock += milliseconds; },
        now: () => pacingClock,
        wallNow: () => sourceNow,
      });
    },
    log: () => undefined,
  });
  const host = await assembly.start();
  await host.ready;
  return Object.freeze({
    host,
    controlStopped: assembly.controlStopped,
    pool,
    providerCalls,
    runtime: assembly.runtime,
    transport,
    gateNextHeartbeatRefresh() {
      if (heartbeatGate) throw new Error("E2E_HEARTBEAT_GATE_ALREADY_SET");
      let release!: () => void;
      const promise = new Promise<void>((resolveGate) => { release = resolveGate; });
      heartbeatGate = Object.freeze({ promise, release });
    },
    releaseHeartbeatGate() {
      if (!heartbeatGate) throw new Error("E2E_HEARTBEAT_GATE_NOT_SET");
      heartbeatGate.release();
    },
    gateNextMarketDerivation() {
      if (marketDerivationGate) throw new Error("E2E_MARKET_GATE_ALREADY_SET");
      let release!: () => void;
      const promise = new Promise<void>((resolveGate) => { release = resolveGate; });
      marketDerivationGate = Object.freeze({ promise, release });
    },
    releaseMarketDerivationGate() {
      const gate = marketDerivationGate;
      if (!gate) throw new Error("E2E_MARKET_GATE_NOT_SET");
      marketDerivationGate = undefined;
      gate.release();
    },
    gateNextWakeAdmission() {
      if (wakeAdmissionGate) throw new Error("E2E_WAKE_GATE_ALREADY_SET");
      let release!: () => void;
      const promise = new Promise<void>((resolveGate) => { release = resolveGate; });
      wakeAdmissionGate = Object.freeze({ promise, release });
    },
    releaseWakeAdmissionGate() {
      const gate = wakeAdmissionGate;
      if (!gate) throw new Error("E2E_WAKE_GATE_NOT_SET");
      wakeAdmissionGate = undefined;
      gate.release();
    },
  });
}

async function deliverSignedWake(
  host: HybridWorkerHost,
  body: OpaqueQStashWake,
  messageId: string,
): Promise<number> {
  const signed = signedWake({ body, messageId });
  const response = await host.server.inject({
    method: "POST",
    path: "/wake",
    body: signed.body,
    headers: signed.headers,
  });
  expect(response.body).toBe("WAKE_ACCEPTED");
  return response.statusCode;
}

async function deliverSignedWakeOverHttp(
  port: number,
  body: OpaqueQStashWake,
  messageId: string,
): Promise<number> {
  const signed = signedWake({ body, messageId });
  const response = await fetch(`http://127.0.0.1:${port}/wake`, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
    signal: AbortSignal.timeout(20_000),
  });
  const responseBody = await response.text();
  if (responseBody !== "WAKE_ACCEPTED") throw new Error("E2E_WAKE_DELIVERY_REJECTED");
  return response.status;
}

async function waitForDatabase(
  pool: Pool,
  query: string,
  parameters: readonly unknown[],
  predicate: (rows: readonly Record<string, unknown>[]) => boolean,
): Promise<readonly Record<string, unknown>[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = (await pool.query(query, [...parameters])).rows as Record<string, unknown>[];
    if (predicate(rows)) return rows;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("E2E_DATABASE_WAIT_TIMEOUT");
}

async function seedMainPriorityJob(database: EventDatabase): Promise<void> {
  const { openDueBroadcastCycles } = await import("../../lib/server/main-brain/schedules");
  const now = new Date();
  const scheduleId = `e2e-main-${randomUUID()}`;
  await database.query(
    `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
     values ($1,'* * * * *','UTC',true,$2)`,
    [scheduleId, new Date(now.getTime() - 60_000)],
  );
  const opened = await openDueBroadcastCycles({ db: database }, now);
  if (!opened.some(({ scheduleId: id }) => id === scheduleId)) {
    throw new Error("E2E_MAIN_PRIORITY_JOB_NOT_OPENED");
  }
}

function windowId(instant: Date): string {
  return `${instant.toISOString().slice(0, 16)}Z`;
}

async function seedRecoveryWindows(pool: Pool): Promise<{
  readonly expiredWindowId: string;
  readonly retainedWindowId: string;
}> {
  const current = new Date(Math.floor(Date.now() / 300_000) * 300_000);
  const retained = new Date(current.getTime() - 300_000);
  const expired = new Date(current.getTime() - 8 * 24 * 60 * 60 * 1_000);
  const retainedWindowId = windowId(retained);
  const expiredWindowId = windowId(expired);
  await pool.query(
    `insert into market_poll_windows(
       window_id,window_started_at,created_at,updated_at,prune_after
     ) values ($1,$2::timestamptz,$2,$2,$2+interval '7 days'),
              ($3,$4::timestamptz,$4,$4,$4+interval '7 days')`,
    [retainedWindowId, retained, expiredWindowId, expired],
  );
  return Object.freeze({ retainedWindowId, expiredWindowId });
}

async function recoveryMarketAuthoritySnapshot(pool: Pool): Promise<{
  readonly latest: readonly Record<string, unknown>[];
  readonly finnhubQuota: readonly Record<string, unknown>[];
}> {
  const [latest, finnhubQuota] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `select account_id::text,symbol,window_id,provider,status,
              source_observed_at::text,received_at::text,
              coalesce(encode(ciphertext,'base64'),'') ciphertext,
              context_digest,safe_code,updated_at::text
       from market_latest_quotes order by account_id,symbol`,
    ),
    pool.query<Record<string, unknown>>(
      `select quota_name,bucket_date::text,used_count,limit_count,updated_at::text
       from deployment_quota_counters
       where quota_name='FINNHUB_CALLS' order by bucket_date`,
    ),
  ]);
  return Object.freeze({
    latest: Object.freeze(latest.rows.map((row) => Object.freeze({ ...row }))),
    finnhubQuota: Object.freeze(finnhubQuota.rows.map((row) => Object.freeze({ ...row }))),
  });
}

async function assertMatchingForgeryRejected(
  database: EventDatabase,
  pool: Pool,
  accountId: string,
): Promise<void> {
  const [latest] = await loadLatestMarket({ db: database, accountId }, ["AAPL"]);
  if (!latest) throw new Error("E2E_AAPL_LATEST_REQUIRED");
  const body = { symbol: "AAPL", latestContextDigest: latest.latestContextDigest };
  const bodyDigest = canonicalContentDigest(body);
  const command = await appendEvent(database, {
    aggregateId: `market-latest:${accountId}`,
    accountId,
    actor: { type: "SYSTEM", id: "gustavo-decision-orchestrator" },
    type: "market.observation.consumption.requested",
    visibility: "PRIVATE_ACCOUNT",
    body,
    idempotencyKey: `market-consumption-command:e2e:${bodyDigest}`,
    policyVersion: "decision-window-policy-v1",
  });
  await expect(pool.query(
    `insert into market_observation_consumptions(
       command_event_id,account_id,symbol,latest_context_digest,observation_id
     ) values ($1,$2,'AAPL',$3,$4)`,
    [command.id, accountId, latest.latestContextDigest, randomUUID()],
  )).rejects.toThrow(/permission denied|MARKET_MATERIALIZER_ROLE_REQUIRED/u);
}

async function backdateHealthyCodexHeartbeat(adminURL: string): Promise<void> {
  const admin = new Pool({ connectionString: adminURL, max: 1 });
  try {
    await admin.query("alter table hybrid_worker_heartbeats disable trigger hybrid_worker_heartbeats_are_bounded");
    try {
      await admin.query(
        `update hybrid_worker_heartbeats
         set status='HEALTHY',safe_code=null,
             observed_at=clock_timestamp()-interval '13 minutes',
             updated_at=clock_timestamp()-interval '13 minutes'
         where component='CODEX'`,
      );
    } finally {
      await admin.query("alter table hybrid_worker_heartbeats enable trigger hybrid_worker_heartbeats_are_bounded");
    }
  } finally {
    await admin.end();
  }
}

function powerShellFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error("E2E_PRODUCTION_POWERSHELL_FUNCTION_MISSING");
  const end = source.indexOf("\nfunction ", start + "function ".length);
  return source.slice(start, end < 0 ? source.length : end);
}

interface MaintenanceOwnerEvidence {
  readonly childExitZero: boolean;
  readonly containerAbsent: boolean;
  readonly directWorkerOwned: boolean;
  readonly funnelSettled: boolean;
  readonly ownerSystemPipeProven: boolean;
  readonly pipeConnected: boolean;
  readonly proofAcknowledged: boolean;
  readonly proofAfterChildSettlement: boolean;
  readonly runtimeSettled: boolean;
  readonly workerReleased: boolean;
}

function maintenanceOwnerScript(): string {
  const source = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
  const functions = [
    "New-MaintenancePipeSecurity", "New-MaintenancePipeServer",
    "Receive-MaintenancePipeRequest", "Write-MaintenancePipeProof",
    "Wait-MaintenancePipeProofAcknowledgement", "Reset-MaintenancePipeConnection",
    "Receive-PendingMaintenanceRequest", "New-LauncherCleanupState",
    "Assert-MaintenanceRuntimeProof", "Invoke-MaintenanceStopTransaction",
    "Invoke-MaintenanceConnection", "Close-MaintenanceAuthority",
    "ConvertTo-Base64Url", "Get-ControlTag", "New-ControlRequest",
    "Test-ControlProof", "Invoke-WorkerStopProof",
  ].map((name) => powerShellFunction(source, name)).join("\r\n");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "function Stop-Safely([string]$Code) { throw $Code }",
    "$ControlNonce = [Environment]::GetEnvironmentVariable('GUSTAVO_HYBRID_CONTROL_NONCE','Process')",
    "if ($ControlNonce -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'E2E_MAINTENANCE_NONCE_INVALID' }",
    functions,
    "$NodePath = [Environment]::GetEnvironmentVariable('GUSTAVO_E2E_NODE_PATH','Process')",
    "$NodeEvaluation = [Environment]::GetEnvironmentVariable('GUSTAVO_E2E_NODE_EVALUATION','Process')",
    "$WorkingDirectory = [Environment]::GetEnvironmentVariable('GUSTAVO_E2E_WORKING_DIRECTORY','Process')",
    "$SettlementPath = [Environment]::GetEnvironmentVariable('GUSTAVO_E2E_CHILD_SETTLEMENT_PATH','Process')",
    "$StopUri = [Environment]::GetEnvironmentVariable('GUSTAVO_E2E_STOP_URI','Process')",
    "$StartInfo = [Diagnostics.ProcessStartInfo]::new()",
    "$StartInfo.FileName = $NodePath",
    "$StartInfo.Arguments = '--import tsx --eval \"' + $NodeEvaluation + '\"'",
    "$StartInfo.WorkingDirectory = $WorkingDirectory",
    "$StartInfo.UseShellExecute = $false",
    "$StartInfo.CreateNoWindow = $true",
    "$StartInfo.RedirectStandardInput = $true",
    "$StartInfo.RedirectStandardOutput = $true",
    "$StartInfo.RedirectStandardError = $true",
    "$Worker = [Diagnostics.Process]::new()",
    "$Worker.StartInfo = $StartInfo",
    "if (-not $Worker.Start()) { throw 'E2E_HYBRID_CHILD_START_FAILED' }",
    "$WorkerPid = $Worker.Id",
    "$DirectWorkerOwned = $Worker.Id -eq $WorkerPid",
    "[Console]::Out.WriteLine(('{\"ownerWorkerPid\":' + $WorkerPid + '}'))",
    "$OutputRead = $Worker.StandardOutput.ReadLineAsync()",
    "$ErrorRead = $Worker.StandardError.ReadLineAsync()",
    "$ErrorLineCount = 0",
    "$Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$Pipe = New-MaintenancePipeServer 'gustavo-hybrid-maintenance-v1' $Owner",
    "$Connection = $Pipe.WaitForConnectionAsync()",
    "$Acl = $Pipe.GetAccessControl()",
    "$Rules = @($Acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))",
    "$System = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)",
    "$OwnerSystemPipeProven = $Acl.AreAccessRulesProtected -and $Rules.Count -eq 2 -and @($Rules | Where-Object { $_.IdentityReference.Value -eq $Owner.Value }).Count -eq 1 -and @($Rules | Where-Object { $_.IdentityReference.Value -eq $System.Value }).Count -eq 1",
    "$State = New-LauncherCleanupState",
    "$Counts = [PSCustomObject]@{ Funnel = 0 }",
    "$RequestStop = { return Invoke-WorkerStopProof $Worker $StopUri '/_gustavo/stop' }.GetNewClosure()",
    "$FunnelStop = { $Counts.Funnel += 1; return $true }.GetNewClosure()",
    "try {",
    "  while (-not $Worker.HasExited -and -not $Connection.IsCompleted) {",
    "    if ($OutputRead.IsCompleted) {",
    "      $OutputLine = $OutputRead.Result",
    "      if ($null -ne $OutputLine) { [Console]::Out.WriteLine($OutputLine); $OutputRead = $Worker.StandardOutput.ReadLineAsync() }",
    "    }",
    "    if ($ErrorRead.IsCompleted) {",
    "      $ErrorLine = $ErrorRead.Result",
    "      if ($null -ne $ErrorLine) { $ErrorLineCount += 1; $ErrorRead = $Worker.StandardError.ReadLineAsync() }",
    "    }",
    "    Start-Sleep -Milliseconds 10",
    "  }",
    "  if (-not $Connection.IsCompleted) {",
    "    [void]$Worker.WaitForExit()",
    "    while ($true) { $OutputLine = $OutputRead.Result; if ($null -eq $OutputLine) { break }; [Console]::Out.WriteLine($OutputLine); $OutputRead = $Worker.StandardOutput.ReadLineAsync() }",
    "    while ($true) { $ErrorLine = $ErrorRead.Result; if ($null -eq $ErrorLine) { break }; $ErrorLineCount += 1; $ErrorRead = $Worker.StandardError.ReadLineAsync() }",
    "    [Console]::Error.WriteLine(('E2E_OWNER_WORKER_EXIT_CLASS:' + $(if ($Worker.ExitCode -eq 0) { 'ZERO' } elseif ($Worker.ExitCode -ge 1 -and $Worker.ExitCode -le 20) { 'BOUNDED' } else { 'OTHER' })) + ':ERROR_LINES=' + $ErrorLineCount)",
    "    exit $Worker.ExitCode",
    "  }",
    "  $Connected = Invoke-MaintenanceConnection $Pipe ([ref]$Connection) $State $Worker $RequestStop $FunnelStop",
    "  $ChildSettled = $null -eq (Get-Process -Id $WorkerPid -ErrorAction SilentlyContinue)",
    "  $SettlementProven = $ChildSettled -and (Get-Content -Raw -LiteralPath $SettlementPath) -ceq 'SETTLED'",
    "  $Evidence = [PSCustomObject]@{ maintenanceOwnerEvidence=$true; ownerSystemPipeProven=$OwnerSystemPipeProven; directWorkerOwned=$DirectWorkerOwned; pipeConnected=$Connected; runtimeSettled=$State.RuntimeSettled; containerAbsent=($State.RuntimeSettled -and $ChildSettled); childExitZero=$State.RuntimeSettled; funnelSettled=($State.FunnelSettled -and $Counts.Funnel -eq 1); workerReleased=$State.WorkerReleased; proofAcknowledged=$State.ProofAcknowledged; proofAfterChildSettlement=($Connected -and $SettlementProven -and $State.WorkerReleased -and $State.ProofAcknowledged) }",
    "  if ($State.RuntimeSettled -and $State.FunnelSettled -and $State.WorkerReleased -and $State.ProofAcknowledged) { Close-MaintenanceAuthority $Pipe $State } else { $Pipe.Dispose() }",
    "  [Console]::Out.WriteLine(($Evidence | ConvertTo-Json -Compress))",
    "  if (-not $Connected) { exit 25 }",
    "} finally {",
    "  if ($null -ne $Pipe -and -not $Pipe.SafePipeHandle.IsClosed) { $Pipe.Dispose() }",
    "  if (-not $State.WorkerReleased) { try { if (-not $Worker.HasExited) { $Worker.Kill(); [void]$Worker.WaitForExit(2000) } } catch {}; $Worker.Dispose() }",
    "}",
  ].join("\r\n");
}

async function runProductionStopForMaintenance(input: {
  readonly childPid: number;
  readonly launcherPid: number;
  readonly controlNonce: string;
  readonly port: number;
  readonly settlementPath: string;
  readonly waitForOwnerEvidence: () => Promise<MaintenanceOwnerEvidence>;
}): Promise<{
  readonly authority: "PRODUCTION_STOP_FOR_MAINTENANCE";
  readonly containerAbsent: true;
  readonly funnelSettled: true;
  readonly ownerSystemPipeProven: true;
  readonly proofAfterChildSettlement: true;
  readonly taskNonRunning: true;
}> {
  const source = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
  const clientFunctions = [
    "Write-MaintenancePipeProofAcknowledgement", "Read-MaintenancePipeProof",
    "Assert-MaintenancePipeSecurity", "Wait-ExactWorkerTaskNonRunning",
    "Invoke-MaintenanceStopClient",
  ].map((name) => powerShellFunction(source, name)).join("\r\n");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "function Stop-Safely([string]$Code) { throw $Code }",
    "$ControlNonce = [Environment]::GetEnvironmentVariable('GUSTAVO_E2E_MAINTENANCE_NONCE','Process')",
    "if ($ControlNonce -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'E2E_MAINTENANCE_NONCE_INVALID' }",
    clientFunctions,
    "$Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    `$NodePid = ${input.childPid}`,
    `$LauncherPid = ${input.launcherPid}`,
    "$TaskPid = $LauncherPid",
    "$ExpectedPowerShell = 'C:\\trusted\\powershell.exe'",
    "$ExpectedStartScript = 'C:\\trusted\\start-hybrid-worker.ps1'",
    "$ExpectedConfigPath = 'C:\\trusted\\hybrid-worker.env'",
    "$script:TaskStates = [Collections.Generic.List[string]]::new()",
    "$script:PrematureReady = $false",
    "function Get-ExactWorkerTask {",
    "  param([Security.Principal.SecurityIdentifier]$DedicatedSid,[string]$ExpectedPowerShell,[string]$ExpectedStartScript,[string]$ExpectedConfigPath)",
    "  if ($DedicatedSid.Value -ne $Owner.Value -or $ExpectedPowerShell -ne 'C:\\trusted\\powershell.exe' -or $ExpectedStartScript -ne 'C:\\trusted\\start-hybrid-worker.ps1' -or $ExpectedConfigPath -ne 'C:\\trusted\\hybrid-worker.env') { Stop-Safely 'HYBRID_MAINTENANCE_STOP_UNPROVEN' }",
    "  $NodeRunning = $null -ne (Get-Process -Id $NodePid -ErrorAction SilentlyContinue)",
    "  $LauncherRunning = $null -ne (Get-Process -Id $LauncherPid -ErrorAction SilentlyContinue)",
    "  $Running = $null -ne (Get-Process -Id $TaskPid -ErrorAction SilentlyContinue)",
    "  $TaskState = if ($Running) { 'Running' } else { 'Ready' }",
    "  if ($TaskState -eq 'Ready' -and -not $NodeRunning -and $LauncherRunning) { $script:PrematureReady = $true }",
    "  [void]$script:TaskStates.Add($TaskState)",
    "  return [PSCustomObject]@{ State = $TaskState }",
    "}",
    "$Proof = @(Invoke-MaintenanceStopClient $Owner $ExpectedPowerShell $ExpectedStartScript $ExpectedConfigPath)[-1]",
    "$Evidence = [PSCustomObject]@{ exactProof=($Proof -eq 'HYBRID_WORKER_MAINTENANCE_STOPPED'); taskAuthorityIsLauncher=($TaskPid -eq $LauncherPid); noPrematureReady=(-not $script:PrematureReady); taskInitialRunning=($script:TaskStates.Count -ge 1 -and $script:TaskStates[0] -eq 'Running'); taskNonRunning=($script:TaskStates.Count -ge 2 -and $script:TaskStates[-1] -eq 'Ready') }",
    "[Console]::Out.Write(($Evidence | ConvertTo-Json -Compress))",
  ].join("\r\n");
  const powerShell = resolve(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const launcher = await createOwnedMaintenanceLauncher(script);
  try {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const temporaryRoot = process.env.TEMP ?? process.env.TMP;
    const result = await execFileAsync(powerShell, [
      "-NoProfile", "-NonInteractive", "-File", launcher.path,
    ], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        NODE_ENV: "test",
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        ...(temporaryRoot ? { TEMP: temporaryRoot, TMP: temporaryRoot } : {}),
        GUSTAVO_E2E_MAINTENANCE_NONCE: input.controlNonce,
        GUSTAVO_E2E_CHILD_SETTLEMENT_PATH: input.settlementPath,
      },
    });
    if (result.stderr !== "") throw new Error("E2E_MAINTENANCE_LAUNCHER_STDERR");
    const [client, owner] = await Promise.all([
      Promise.resolve(JSON.parse(result.stdout) as Record<string, unknown>),
      input.waitForOwnerEvidence(),
    ]);
    const phases = {
      ownerSystemPipeProven: owner.ownerSystemPipeProven,
      directWorkerOwned: owner.directWorkerOwned,
      pipeConnected: owner.pipeConnected,
      runtimeSettled: owner.runtimeSettled,
      containerAbsent: owner.containerAbsent,
      childExitZero: owner.childExitZero,
      funnelSettled: owner.funnelSettled,
      workerReleased: owner.workerReleased,
      proofAcknowledged: owner.proofAcknowledged,
      exactProof: client.exactProof === true,
      taskAuthorityIsLauncher: client.taskAuthorityIsLauncher === true,
      noPrematureReady: client.noPrematureReady === true,
      proofAfterChildSettlement: owner.proofAfterChildSettlement,
      taskInitialRunning: client.taskInitialRunning === true,
      taskNonRunning: client.taskNonRunning === true,
    };
    if (Object.values(phases).some((value) => !value)) {
      throw new Error(`E2E_MAINTENANCE_PHASES:${JSON.stringify(phases)}`);
    }
    return Object.freeze({
      authority: "PRODUCTION_STOP_FOR_MAINTENANCE",
      containerAbsent: true,
      funnelSettled: true,
      ownerSystemPipeProven: true,
      proofAfterChildSettlement: true,
      taskNonRunning: true,
    });
  } finally {
    await cleanupOwnedMaintenanceLauncher(launcher.path, launcher.ownershipRecord);
  }
}

interface HybridChildStatus {
  readonly codexCreateContractExact?: boolean;
  readonly codexEnvironmentExact?: boolean;
  readonly codexInspectDerivedFromCreate?: boolean;
  readonly codexLifecycleOrderExact?: boolean;
  readonly codexRemoveContractExact?: boolean;
  readonly codexStartContractExact?: boolean;
  readonly containerAbsent: boolean;
  readonly maxActiveContainers: number;
  readonly modelGateReached: boolean;
  readonly providerCallCount: number;
  readonly providerSymbols: readonly string[];
  readonly roleInvocations: readonly CodexRole[];
  readonly runtime: ReturnType<HybridRuntimeController["status"]>;
  readonly port: number;
}

interface ChildResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

async function readOwnerWorkerPid(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise<number>((resolvePid, rejectPid) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      lines.close();
      rejectPid(new Error("E2E_OWNER_WORKER_PID_TIMEOUT"));
    }, 10_000);
    timer.unref?.();
    lines.once("line", (line) => {
      clearTimeout(timer);
      lines.close();
      try {
        const value = JSON.parse(line) as { readonly ownerWorkerPid?: unknown };
        if (!Number.isSafeInteger(value.ownerWorkerPid) || (value.ownerWorkerPid as number) < 1) {
          throw new Error("E2E_OWNER_WORKER_PID_INVALID");
        }
        resolvePid(value.ownerWorkerPid as number);
      } catch {
        rejectPid(new Error("E2E_OWNER_WORKER_PID_INVALID"));
      }
    });
  });
}

async function connectChildControl(port: number): Promise<Socket> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const socket = createConnection({ host: "127.0.0.1", port });
    const connected = await new Promise<boolean>((resolveConnected) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        socket.removeAllListeners("connect");
        socket.removeAllListeners("error");
        resolveConnected(value);
      };
      const timer = setTimeout(() => finish(false), 500);
      timer.unref?.();
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (connected) return socket;
    socket.destroy();
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("E2E_CHILD_CONTROL_CONNECT_TIMEOUT");
}

class HybridChildProcess {
  private nextId = 1;
  private readonly pending = new Map<number, {
    readonly reject: (error: Error) => void;
    readonly resolve: (value: unknown) => void;
  }>();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly control: Socket;
  private readonly workerPid: number;
  private readonly settlementPath: string;
  private readonly launcherPath: string | undefined;
  private readonly maintenanceEvidence: Promise<MaintenanceOwnerEvidence>;
  private resolveMaintenanceEvidence!: (value: MaintenanceOwnerEvidence) => void;
  private settlementOwnershipRecord: string | undefined;
  private launcherOwnershipRecord: string | undefined;
  private ownershipRecord: string | undefined;
  private stderr = "";

  get pid(): number {
    return this.workerPid;
  }

  get settlementAuthorityPath(): string {
    return this.settlementPath;
  }

  get launcherPid(): number {
    if (!this.child.pid) throw new Error("E2E_HYBRID_LAUNCHER_PID_MISSING");
    return this.child.pid;
  }

  private constructor(
    child: ChildProcessWithoutNullStreams,
    control: Socket,
    workerPid: number,
    ownershipRecord: string,
    settlementPath: string,
    settlementOwnershipRecord: string,
    launcherPath?: string,
    launcherOwnershipRecord?: string,
  ) {
    this.child = child;
    this.control = control;
    this.workerPid = workerPid;
    this.ownershipRecord = ownershipRecord;
    this.settlementPath = settlementPath;
    this.settlementOwnershipRecord = settlementOwnershipRecord;
    this.launcherPath = launcherPath;
    this.launcherOwnershipRecord = launcherOwnershipRecord;
    this.maintenanceEvidence = new Promise((resolveEvidence) => {
      this.resolveMaintenanceEvidence = resolveEvidence;
    });
    const handleLine = (line: string): void => {
      let response: ChildResponse & { readonly maintenanceOwnerEvidence?: unknown };
      try {
        response = JSON.parse(line) as ChildResponse & { readonly maintenanceOwnerEvidence?: unknown };
      } catch {
        return;
      }
      if (response.maintenanceOwnerEvidence === true) {
        this.resolveMaintenanceEvidence(response as unknown as MaintenanceOwnerEvidence);
        return;
      }
      if (!Number.isSafeInteger(response.id)) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error ?? "E2E_HYBRID_CHILD_FAILED"));
    };
    createInterface({ input: child.stdout }).on("line", handleLine);
    const handleControlError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "ECONNRESET") return;
      const failure = new Error("E2E_CHILD_CONTROL_FAILED");
      for (const pending of this.pending.values()) pending.reject(failure);
      this.pending.clear();
    };
    const controlLines = createInterface({ input: control });
    controlLines.on("line", handleLine);
    controlLines.on("error", handleControlError);
    control.on("error", handleControlError);
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    child.once("exit", (code, signal) => {
      if (this.pending.size === 0) return;
      const error = new Error(
        `E2E_HYBRID_CHILD_EXITED:${code ?? "null"}:${signal ?? "null"}\n${this.stderr}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async start(controlNonce: string): Promise<HybridChildProcess> {
    const marker = `gustavo-e2e-hybrid-child-${randomUUID().replaceAll("-", "")}`;
    const settlement = await createOwnedChildSettlementAuthority();
    const port = await reserveLoopbackPort();
    const controlPort = await reserveLoopbackPort();
    const evaluation = `globalThis['${marker}']=true;import('./tests/e2e/gustavo-hybrid-production.spec.ts')`;
    const launcher = process.platform === "win32"
      ? await createOwnedMaintenanceLauncher(maintenanceOwnerScript())
      : undefined;
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      GUSTAVO_E2E_HYBRID_CHILD: "1",
      GUSTAVO_E2E_CHILD_SETTLEMENT_PATH: settlement.path,
      GUSTAVO_E2E_CHILD_CONTROL_PORT: String(controlPort),
      GUSTAVO_HYBRID_CONTROL_NONCE: controlNonce,
    };
    if (launcher) {
      childEnvironment.GUSTAVO_E2E_NODE_PATH = process.execPath;
      childEnvironment.GUSTAVO_E2E_NODE_EVALUATION = evaluation;
      childEnvironment.GUSTAVO_E2E_WORKING_DIRECTORY = process.cwd();
      childEnvironment.GUSTAVO_E2E_STOP_URI = `http://127.0.0.1:${port}/_gustavo/stop`;
    }
    const child = launcher ? spawn(resolve(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ), ["-NoProfile", "-NonInteractive", "-File", launcher.path], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) : spawn(process.execPath, ["--import", "tsx", "--eval", evaluation], {
      cwd: process.cwd(), env: childEnvironment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    if (!child.pid) {
      child.kill();
      await cleanupOwnedMaintenanceLauncher(settlement.path, settlement.ownershipRecord);
      if (launcher) await cleanupOwnedMaintenanceLauncher(launcher.path, launcher.ownershipRecord);
      throw new Error("E2E_HYBRID_CHILD_PID_MISSING");
    }
    let workerPid: number;
    try {
      workerPid = launcher ? await readOwnerWorkerPid(child) : child.pid;
    } catch (error) {
      child.kill();
      await cleanupOwnedMaintenanceLauncher(settlement.path, settlement.ownershipRecord);
      if (launcher) await cleanupOwnedMaintenanceLauncher(launcher.path, launcher.ownershipRecord);
      throw error;
    }
    let ownershipRecord: string;
    try {
      ownershipRecord = await registerOwnedHybridChild(workerPid, marker);
    } catch (error) {
      child.kill();
      await cleanupOwnedMaintenanceLauncher(settlement.path, settlement.ownershipRecord);
      if (launcher) await cleanupOwnedMaintenanceLauncher(launcher.path, launcher.ownershipRecord);
      throw error;
    }
    let control: Socket;
    try {
      control = await connectChildControl(controlPort);
    } catch (error) {
      child.kill();
      await cleanupOwnedHybridChild(ownershipRecord);
      await cleanupOwnedMaintenanceLauncher(settlement.path, settlement.ownershipRecord);
      if (launcher) await cleanupOwnedMaintenanceLauncher(launcher.path, launcher.ownershipRecord);
      throw error;
    }
    const controller = new HybridChildProcess(
      child,
      control,
      workerPid,
      ownershipRecord,
      settlement.path,
      settlement.ownershipRecord,
      launcher?.path,
      launcher?.ownershipRecord,
    );
    try {
      await controller.command("START", { controlNonce, port });
      return controller;
    } catch (error) {
      await controller.close().catch(() => undefined);
      throw error;
    }
  }

  command<Result>(action: string, input: Record<string, unknown> = {}): Promise<Result> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.reject(new Error(`E2E_HYBRID_CHILD_NOT_RUNNING\n${this.stderr}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise<Result>((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill();
        rejectCommand(new Error(`E2E_HYBRID_CHILD_COMMAND_TIMEOUT:${action}\n${this.stderr}`));
      }, 30_000);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCommand(value as Result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectCommand(error);
        },
      });
    });
    this.control.write(`${JSON.stringify({ id, action, input })}\n`);
    return result;
  }

  waitForMaintenanceEvidence(): Promise<MaintenanceOwnerEvidence> {
    return new Promise<MaintenanceOwnerEvidence>((resolveEvidence, rejectEvidence) => {
      const timer = setTimeout(() => rejectEvidence(
        new Error("E2E_MAINTENANCE_OWNER_EVIDENCE_TIMEOUT"),
      ), 60_000);
      timer.unref?.();
      void this.maintenanceEvidence.then((evidence) => {
        clearTimeout(timer);
        resolveEvidence(evidence);
      });
    });
  }

  async close(): Promise<void> {
    try {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await this.command("CLOSE").catch(() => undefined);
      }
      if (this.child.exitCode === null && !await this.waitForExit(5_000)) {
        this.child.kill();
        if (!await this.waitForExit(5_000)) throw new Error("E2E_HYBRID_CHILD_EXIT_TIMEOUT");
      }
    } finally {
      this.control.destroy();
      const ownershipRecord = this.ownershipRecord;
      this.ownershipRecord = undefined;
      if (ownershipRecord) await cleanupOwnedHybridChild(ownershipRecord);
      const settlementRecord = this.settlementOwnershipRecord;
      this.settlementOwnershipRecord = undefined;
      if (settlementRecord) {
        await cleanupOwnedMaintenanceLauncher(this.settlementPath, settlementRecord);
      }
      const launcherRecord = this.launcherOwnershipRecord;
      this.launcherOwnershipRecord = undefined;
      if (launcherRecord && this.launcherPath) {
        await cleanupOwnedMaintenanceLauncher(this.launcherPath, launcherRecord);
      }
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolveExit) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child.off("exit", onExit);
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.child.once("exit", onExit);
    });
  }
}

async function waitForHybridStatus(
  child: HybridChildProcess,
  predicate: (status: HybridChildStatus) => boolean,
): Promise<HybridChildStatus> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = await child.command<HybridChildStatus>("STATUS");
    if (predicate(status)) return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("E2E_HYBRID_STATUS_WAIT_TIMEOUT");
}

async function childProtocolChannel(): Promise<{
  readonly input: NodeJS.ReadableStream;
  readonly write: (value: string) => void;
  readonly close: () => void;
}> {
  const configured = process.env.GUSTAVO_E2E_CHILD_CONTROL_PORT;
  if (!configured) {
    return Object.freeze({
      input: process.stdin,
      write: (value: string) => { process.stdout.write(value); },
      close: () => { process.stdin.unref(); },
    });
  }
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("E2E_CHILD_CONTROL_PORT_INVALID");
  }
  const server = createNetServer();
  const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
    const timer = setTimeout(() => rejectSocket(new Error("E2E_CHILD_CONTROL_CONNECT_TIMEOUT")),
      10_000);
    timer.unref?.();
    server.once("error", (error) => {
      clearTimeout(timer);
      rejectSocket(error);
    });
    server.once("connection", (connection) => {
      clearTimeout(timer);
      resolveSocket(connection);
    });
    server.listen(port, "127.0.0.1");
  });
  server.close();
  return Object.freeze({
    input: socket,
    write: (value: string) => { socket.write(value); },
    close: () => { socket.destroy(); },
  });
}

async function runHybridChildProtocol(): Promise<void> {
  const transport = new FakeCodexContainerTransport();
  let harness: HybridHarness | undefined;
  const channel = await childProtocolChannel();
  const lines = createInterface({ input: channel.input });
  let chain = Promise.resolve();
  lines.on("line", (line) => {
    chain = chain.then(async () => {
      let request: {
        readonly id: number;
        readonly action: string;
        readonly input?: Readonly<Record<string, unknown>>;
      };
      try {
        request = JSON.parse(line) as typeof request;
      } catch {
        return;
      }
      try {
        let value: unknown;
        const input = request.input ?? {};
        if (request.action === "START") {
          if (harness || typeof input.controlNonce !== "string"
              || !Number.isInteger(input.port) || (input.port as number) < 1_024
              || (input.port as number) > 65_535) {
            throw new Error("E2E_HYBRID_CHILD_START_INVALID");
          }
          harness = await startHybridHarness(transport, input.controlNonce, input.port as number);
          value = true;
        } else if (request.action === "SEED_MAIN") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          await seedMainPriorityJob(databaseFromPool(harness.pool));
          value = true;
        } else if (request.action === "DELIVER") {
          if (!harness || typeof input.messageId !== "string"
              || !input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
            throw new Error("E2E_HYBRID_CHILD_DELIVERY_INVALID");
          }
          value = await deliverSignedWake(
            harness.host,
            input.body as OpaqueQStashWake,
            input.messageId,
          );
        } else if (request.action === "STATUS") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          value = Object.freeze({
            codexCreateContractExact: transport.codexCreateContractExact,
            codexEnvironmentExact: transport.codexEnvironmentExact,
            codexInspectDerivedFromCreate: transport.codexInspectDerivedFromCreate,
            codexLifecycleOrderExact: transport.codexLifecycleOrderExact,
            codexRemoveContractExact: transport.codexRemoveContractExact,
            codexStartContractExact: transport.codexStartContractExact,
            containerAbsent: transport.containerAbsent,
            maxActiveContainers: transport.maxActiveContainers,
            modelGateReached: transport.modelGateReached,
            providerCallCount: harness.providerCalls.count,
            providerSymbols: Object.freeze([...harness.providerCalls.symbols]),
            roleInvocations: Object.freeze([...transport.roleInvocations]),
            runtime: harness.runtime.status(),
            port: harness.host.server.address.port,
          } satisfies HybridChildStatus);
        } else if (request.action === "GATE_MODEL") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          transport.gateNextStart();
          value = true;
        } else if (request.action === "RELEASE_MODEL") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          transport.releaseStartGate();
          value = true;
        } else if (request.action === "GATE_MARKET") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          harness.gateNextMarketDerivation();
          value = true;
        } else if (request.action === "RELEASE_MARKET") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          harness.releaseMarketDerivationGate();
          value = true;
        } else if (request.action === "GATE_ADMISSION") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          harness.gateNextWakeAdmission();
          value = true;
        } else if (request.action === "RELEASE_ADMISSION") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          harness.releaseWakeAdmissionGate();
          value = true;
        } else if (request.action === "GATE_HEARTBEAT") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          harness.gateNextHeartbeatRefresh();
          value = true;
        } else if (request.action === "RELEASE_HEARTBEAT") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          harness.releaseHeartbeatGate();
          value = true;
        } else if (request.action === "STOP") {
          if (!harness) throw new Error("E2E_HYBRID_CHILD_NOT_STARTED");
          await harness.host.stop();
          await harness.pool.end();
          harness = undefined;
          value = true;
        } else if (request.action === "CLOSE") {
          if (harness) {
            await harness.host.stop().catch(() => undefined);
            await harness.pool.end().catch(() => undefined);
            harness = undefined;
          }
          value = true;
        } else {
          throw new Error("E2E_HYBRID_CHILD_ACTION_INVALID");
        }
        channel.write(`${JSON.stringify({ id: request.id, ok: true, value })}\n`);
        if (request.action === "START" && harness) {
          const started = harness;
          void started.controlStopped.then(async () => {
            let hostCleanupSettled = true;
            let poolCleanupSettled = true;
            try { await started.host.stop(); } catch { hostCleanupSettled = false; }
            try { await started.pool.end(); } catch { poolCleanupSettled = false; }
            if (harness === started) harness = undefined;
            if (hostCleanupSettled && poolCleanupSettled) {
              markChildSettlement();
              process.exit(0);
            }
            lines.close();
            channel.close();
            if (!hostCleanupSettled) process.exitCode = 21;
            else if (!poolCleanupSettled) process.exitCode = 22;
          }).catch(() => { process.exitCode = 23; });
        }
        if (request.action === "CLOSE") {
          lines.close();
          channel.close();
        }
      } catch (error) {
        channel.write(`${JSON.stringify({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : "E2E_HYBRID_CHILD_FAILED",
        })}\n`);
      }
    }).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "E2E_HYBRID_CHILD_FAILED"}\n`);
      process.exitCode = 31;
    });
  });
}

function markChildSettlement(): void {
  const configured = process.env.GUSTAVO_E2E_CHILD_SETTLEMENT_PATH;
  if (!configured) throw new Error("E2E_CHILD_SETTLEMENT_PATH_REQUIRED");
  const target = resolve(configured);
  const name = target.split(/[\\/]/u).at(-1) ?? "";
  if (resolve(target, "..") !== resolve(tmpdir())
      || !/^gustavo-e2e-settlement-[0-9a-f]{32}\.state$/u.test(name)) {
    throw new Error("E2E_CHILD_SETTLEMENT_PATH_INVALID");
  }
  writeFileSync(target, "SETTLED", { encoding: "utf8", flag: "w" });
}

if (process.env.GUSTAVO_E2E_HYBRID_CHILD === "1") {
  void runHybridChildProtocol().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "E2E_HYBRID_CHILD_FAILED"}\n`);
    process.exitCode = 32;
  });
} else {
  test.setTimeout(180_000);

test("materializer isolation settles every pool and retains primary plus settlement failures", async () => {
  const endCalls: string[] = [];
  const invoke = assertMarketMaterializerIsolation as unknown as (options: {
    readonly poolFactory: (kind: "admin" | "materializer" | "ordinary") => unknown;
  }) => Promise<unknown>;
  const poolFactory = (kind: "admin" | "materializer" | "ordinary") => Object.freeze({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
      if (kind === "ordinary") throw new Error("E2E_POOL_PRIMARY_PROBE");
      if (kind === "admin" && sql.includes("select (")) {
        return Object.freeze({
          rows: Object.freeze([{ count: 0 }]) as unknown as readonly Row[],
        });
      }
      return Object.freeze({ rows: Object.freeze([]) as readonly Row[] });
    },
    async connect() {
      return Object.freeze({
        async query<Row extends Record<string, unknown> = Record<string, unknown>>() {
          return Object.freeze({ rows: Object.freeze([]) as readonly Row[] });
        },
        release() { return undefined; },
      });
    },
    async end() {
      endCalls.push(kind);
      if (kind === "materializer") throw new Error("E2E_POOL_SETTLEMENT_PROBE");
    },
  });
  let failure: unknown;
  try {
    await invoke({ poolFactory });
  } catch (error) {
    failure = error;
  }

  expect.soft(endCalls.sort()).toEqual(["admin", "materializer", "ordinary"]);
  expect.soft(failure).toBeInstanceOf(AggregateError);
  if (failure instanceof AggregateError) {
    expect.soft(failure.errors.map((error: unknown) => (
      error instanceof Error ? error.message : "NON_ERROR"
    ))).toEqual(["E2E_POOL_PRIMARY_PROBE", "E2E_POOL_SETTLEMENT_PROBE"]);
  }
});

test("fresh operator chat, 95-symbol market, offline recovery, and public redaction", async ({
  page,
  request,
}) => {
  expect(await assertFreshHybridInventory()).toEqual({
    accounts: 0,
    conversations: 0,
    bridgeJobs: 0,
    latestQuotes: 0,
  });
  const materializerIsolation = await assertMarketMaterializerIsolation();
  expect.soft(materializerIsolation).toEqual({
    materializerAccepted: true,
    materializerProductionPathCleaned: true,
    materializerProductionPathCommitted: true,
    materializerProductionPathVerified: true,
    ordinaryForgeryRejected: true,
    ordinaryMatchingInsertAttempted: true,
    ordinaryMatchingInsertRejected: true,
  });
  const globalProbePool = new Pool({
    connectionString: hybridE2eDatabaseURLs().admin,
    max: 1,
  });
  const globalProbeResidue = await globalProbePool.query<{
    readonly instrument_count: number;
    readonly source_count: number;
  }>(`select
    (select count(*)::int from market_instrument_allowlist
      where symbol='AAPL' and asset_class='US_STOCK' and enabled=true) instrument_count,
    (select count(*)::int from market_data_sources
      where provider='finnhub' and license_id='finnhub-free-personal'
        and licensed=true and redistribution='ACCOUNT_ONLY') source_count`);
  await globalProbePool.end();
  expect(globalProbeResidue.rows[0]).toEqual({ instrument_count: 0, source_count: 0 });
  await expect(assertMarketScheduleBody()).resolves.toEqual({
    bodyKind: "MARKET_CURRENT",
    scheduleCount: 2,
    hasHostedRelay: false,
    maintenanceScheduleExact: true,
    marketScheduleExact: true,
    relayCheckSource: "SCHEDULE_INVENTORY",
    marketScheduleId: "gustavo-market-current-v1",
    fixtureOwnsSignedDelivery: true,
  });

  const urls = hybridE2eDatabaseURLs();
  const pool = new Pool({
    connectionString: urls.ordinary,
    max: 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 7_000,
    statement_timeout: 5_000,
  });
  const database = databaseFromPool(pool);
  let firstChild: HybridChildProcess | undefined;
  let secondChild: HybridChildProcess | undefined;
  try {
    firstChild = await test.step("start first hybrid child", () => (
      HybridChildProcess.start(randomBytes(32).toString("base64url"))
    ));
    const invitation = await issueInvitation(request);
    await page.goto(`${e2eBaseURL()}/join?token=${encodeURIComponent(invitation)}`);
    await page.getByLabel("Display name").fill("Gustavo Operator");
    await page.getByLabel("Passphrase").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/chat$/u);
    const account = await pool.query<{ readonly id: string }>(
      "select id::text from accounts order by created_at,id",
    );
    expect(account.rows).toHaveLength(1);
    const accountId = account.rows[0]!.id;

    await firstChild.command("SEED_MAIN");
    await page.getByLabel("Message", { exact: true }).fill(PRIVATE_CANARY);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(PRIVATE_CANARY)).toBeVisible();
    const publication = await assertHostedWakePublished();
    expect(publication).toMatchObject({
      destinationVariable: "GUSTAVO_HYBRID_WAKE_URL",
      bodyKind: "JOB",
      accepted: true,
      url: PUBLIC_WAKE_URL,
    });
    await test.step("accept first signed wake", async () => {
      expect(await firstChild!.command<number>("DELIVER", {
        body: { jobId: publication.jobId },
        messageId: `e2e-chat-${randomUUID()}`,
      })).toBe(202);
    });
    await test.step("observe first Node Main Evaluator drain", async () => {
      try {
        await waitForDatabase(
          pool,
          "select role,status from bridge_model_jobs order by updated_at,priority,job_id",
          [],
          (rows) => rows.filter(({ status }) => status === "COMPLETED").length >= 3,
        );
      } catch (error) {
        const [status, jobs] = await Promise.all([
          firstChild!.command<HybridChildStatus>("STATUS"),
          pool.query(
            `select job_id::text,role,status,safe_code,attempt_count,
                    lease_owner,output_event_id::text
             from bridge_model_jobs order by updated_at,priority,job_id`,
          ).then(({ rows }) => rows),
        ]);
        throw new Error(`E2E_FIRST_DRAIN_DIAGNOSTIC:${JSON.stringify({
          original: error instanceof Error ? error.message : "UNKNOWN",
          status,
          jobs,
        })}`);
      }
    });
    await page.reload();
    await expect(page.getByText(NODE_REPLY)).toBeVisible();
    await expect(page.getByText(NODE_REPLY).locator("xpath=ancestor::article").getByText("Node Brain"))
      .toBeVisible();
    const firstStatus = await firstChild.command<HybridChildStatus>("STATUS");
    expect(firstStatus.roleInvocations.slice(0, 3)).toEqual(["NODE", "MAIN", "EVALUATOR"]);
    expect(firstStatus.maxActiveContainers).toBe(1);
    expect.soft(firstStatus.codexCreateContractExact).toBe(true);
    expect.soft(firstStatus.codexEnvironmentExact).toBe(true);
    expect.soft(firstStatus.codexInspectDerivedFromCreate).toBe(true);
    expect.soft(firstStatus.codexLifecycleOrderExact).toBe(true);
    expect.soft(firstStatus.codexRemoveContractExact).toBe(true);
    expect.soft(firstStatus.codexStartContractExact).toBe(true);

    await test.step("stop first hybrid child", async () => {
      await firstChild!.command("STOP");
      await firstChild!.close();
    });
    firstChild = undefined;
    await page.reload();
    await expect(page.getByText("Message saved \u2014 local processing unavailable")).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill(OFFLINE_CANARY);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(OFFLINE_CANARY)).toBeVisible();
    const offlinePublication = await assertHostedWakePublished();
    expect(offlinePublication.bodyKind).toBe("JOB");
    const pendingBeforeRestart = await pool.query<{ readonly count: number }>(
      "select count(*)::int count from bridge_model_jobs where status='PENDING' and role='NODE'",
    );
    expect(pendingBeforeRestart.rows[0]?.count).toBe(1);

    const beforeRecoveryAuthority = await recoveryMarketAuthoritySnapshot(pool);
    const recoveryWindows = await seedRecoveryWindows(pool);
    const controlNonce = randomBytes(32).toString("base64url");
    secondChild = await HybridChildProcess.start(controlNonce);
    expect((await secondChild.command<HybridChildStatus>("STATUS")).providerCallCount).toBe(0);
    const recoveryRows = await pool.query<{
      readonly status: string;
      readonly window_id: string;
    }>(
      "select window_id,status from market_poll_windows where window_id=any($1::text[]) order by window_id",
      [[recoveryWindows.retainedWindowId, recoveryWindows.expiredWindowId]],
    );
    expect(recoveryRows.rows).toEqual([
      { window_id: recoveryWindows.retainedWindowId, status: "FAILED" },
    ]);
    const afterRecoveryAuthority = await recoveryMarketAuthoritySnapshot(pool);
    expect(afterRecoveryAuthority).toEqual(beforeRecoveryAuthority);
    await waitForDatabase(
      pool,
      "select role,status,source_event_id::text from bridge_model_jobs where role='NODE' order by created_at",
      [],
      (rows) => rows.length === 2 && rows.every(({ status }) => status === "COMPLETED"),
    );
    await page.reload();
    const loadNewerMessages = page.getByRole("link", { name: "Load newer messages" });
    await expect(loadNewerMessages).toBeVisible();
    await loadNewerMessages.click();
    const recoveredReply = page.getByText(NODE_REPLY);
    await expect(recoveredReply).toBeVisible();
    await expect(recoveredReply.locator("xpath=ancestor::article").getByText("Node Brain"))
      .toBeVisible();
    const recoveredStatus = await secondChild.command<HybridChildStatus>("STATUS");
    expect(recoveredStatus.roleInvocations.filter((role) => role === "NODE")).toHaveLength(1);

    const currentWindow = await pool.query<{ readonly window_id: string }>(
      `select to_char(
         date_bin(interval '5 minutes',clock_timestamp(),
           timestamptz '1970-01-01 00:00:00+00') at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI"Z"'
       ) window_id`,
    );
    const currentWindowId = currentWindow.rows[0]?.window_id;
    expect(currentWindowId).toMatch(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$/u);
    expect(await deliverMarketSchedule(recoveredStatus.port)).toBe(202);
    const completedCurrentWindow = await waitForDatabase(
      pool,
      `select window_id,status,calls_used,result_count
       from market_poll_windows where window_id=$1`,
      [currentWindowId],
      (rows) => rows.length === 1 && rows[0]?.status === "COMPLETED"
        && rows[0]?.calls_used === 96 && rows[0]?.result_count === 95,
    );
    expect(completedCurrentWindow).toEqual([{
      window_id: currentWindowId,
      status: "COMPLETED",
      calls_used: 96,
      result_count: 95,
    }]);
    const marketStatus = await secondChild.command<HybridChildStatus>("STATUS");
    expect(marketStatus.providerCallCount).toBe(96);
    expect(marketStatus.providerSymbols).toEqual(MARKET_UNIVERSE.map(({ symbol }) => symbol));
    const latestCount = await pool.query<{ readonly count: number }>(
      "select count(*)::int count from market_latest_quotes",
    );
    expect(latestCount.rows[0]?.count).toBe(95);
    const finnhubQuota = await pool.query<{
      readonly used_count: number;
      readonly limit_count: number;
    }>(
      `select used_count,limit_count from deployment_quota_counters
       where quota_name='FINNHUB_CALLS'
         and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    );
    expect(finnhubQuota.rows).toEqual([{ used_count: 96, limit_count: 27_648 }]);
    await assertMatchingForgeryRejected(database, pool, accountId);

    await page.goto(`${e2eBaseURL()}/market`);
    const marketCards = page.locator("[data-market-symbol]");
    await expect(marketCards).toHaveCount(95);
    await expect(page.getByText("Fresh", { exact: true })).toHaveCount(95);
    const providerTimes = marketCards.locator('dt:has-text("Provider observation") + dd time');
    const receivedTimes = marketCards.locator('dt:has-text("Received") + dd time');
    const ages = marketCards.locator('dt:has-text("Age") + dd');
    await expect(providerTimes).toHaveCount(95);
    await expect(receivedTimes).toHaveCount(95);
    await expect(ages).toHaveCount(95);
    for (const symbol of ["AAPL", "ARKK"] as const) {
      const card = page.locator(`[data-market-symbol="${symbol}"]`);
      await expect(card).toContainText("Fresh");
      const providerAt = Date.parse(await card.locator(
        'dt:has-text("Provider observation") + dd time',
      ).getAttribute("datetime") ?? "");
      const receivedAt = Date.parse(await card.locator(
        'dt:has-text("Received") + dd time',
      ).getAttribute("datetime") ?? "");
      const ageText = await card.locator('dt:has-text("Age") + dd').innerText();
      const ageSeconds = Number.parseInt(ageText, 10);
      expect(Number.isFinite(providerAt) && providerAt <= receivedAt).toBe(true);
      expect(Number.isInteger(ageSeconds) && ageSeconds >= 0).toBe(true);
      expect(Math.abs(Date.now() - receivedAt - ageSeconds * 1_000)).toBeLessThan(15_000);
    }
    for (const age of await ages.allTextContents()) expect(age).toMatch(/^[0-9]+ seconds$/u);
    await expect(page.locator('[data-market-symbol="AAPL"]')).toContainText(LIVE_QUOTE);

    await backdateHealthyCodexHeartbeat(urls.admin);
    const staleOperatorHealth = await readOperatorHybridHealth();
    expect(staleOperatorHealth.codex).toEqual({
      status: "OFFLINE", safeCode: "WORKER_OFFLINE", leaseFresh: false,
    });
    expect(staleOperatorHealth.codexQuota).toMatchObject({ limit: 100, exhausted: false });
    expect(staleOperatorHealth.codexQuota.used).toBeLessThan(100);
    await page.goto(`${e2eBaseURL()}/chat`);
    await expect(page.getByText("Message saved \u2014 local processing unavailable")).toBeVisible();
    await secondChild.command("GATE_HEARTBEAT");
    const refreshStarted = performance.now();
    expect(await secondChild.command<number>("DELIVER", {
      body: { jobId: randomUUID() },
      messageId: `e2e-heartbeat-${randomUUID()}`,
    })).toBe(202);
    expect(performance.now() - refreshStarted).toBeLessThan(2_000);
    await secondChild.command("RELEASE_HEARTBEAT");
    await waitForDatabase(
      pool,
      `select status,extract(epoch from (clock_timestamp()-observed_at))::int age
       from hybrid_worker_heartbeats where component='CODEX'`,
      [],
      (rows) => rows[0]?.status === "HEALTHY"
        && typeof rows[0]?.age === "number" && rows[0].age < 12 * 60,
    );
    await page.reload();
    await page.getByLabel("Message", { exact: true }).fill(PENDING_CANARY);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
    const loadPendingMessage = page.getByRole("link", { name: "Load newer messages" });
    await expect(loadPendingMessage).toBeVisible();
    await loadPendingMessage.click();
    await expect(page.getByText(PENDING_CANARY)).toBeVisible();
    const maintenancePublication = await assertHostedWakePublished();
    const beforeMaintenance = await secondChild.command<HybridChildStatus>("STATUS");
    await secondChild.command("GATE_MODEL");
    expect(await deliverSignedWakeOverHttp(
      beforeMaintenance.port,
      { jobId: maintenancePublication.jobId },
      `e2e-maintenance-job-${randomUUID()}`,
    )).toBe(202);
    await waitForHybridStatus(
      secondChild,
      ({ modelGateReached, runtime }) => modelGateReached && runtime.modelActive,
    );
    await pool.query(
      `insert into deployment_quota_counters(quota_name,bucket_date,used_count,limit_count)
       values ('CODEX_JOBS',(clock_timestamp() at time zone 'UTC')::date,100,100)
       on conflict(quota_name,bucket_date) do update set
         used_count=100,updated_at=clock_timestamp()`,
    );
    await expect(readOperatorHybridHealth()).resolves.toEqual({
      codex: { status: "DEGRADED", safeCode: "QUOTA_EXHAUSTED", leaseFresh: true },
      codexQuota: { used: 100, limit: 100, exhausted: true },
    });
    await page.reload();
    await expect(page.getByText("Message saved \u2014 local processing quota limited")).toBeVisible();

    await secondChild.command("GATE_MARKET");
    expect(await deliverMarketSchedule(beforeMaintenance.port)).toBe(202);
    await waitForHybridStatus(
      secondChild,
      ({ runtime }) => runtime.modelActive && runtime.marketActive,
    );
    await secondChild.command("GATE_ADMISSION");
    const admittedWake = deliverMarketSchedule(beforeMaintenance.port);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await pauseMarketSchedule();
    const pausedProbePort = await reserveLoopbackPort();
    await expect(deliverMarketSchedule(pausedProbePort)).rejects.toThrow(
      "E2E_MARKET_SCHEDULE_PAUSED",
    );
    let maintenanceSettled = false;
    const maintenance = runProductionStopForMaintenance({
      childPid: secondChild.pid,
      launcherPid: secondChild.launcherPid,
      controlNonce,
      port: beforeMaintenance.port,
      settlementPath: secondChild.settlementAuthorityPath,
      waitForOwnerEvidence: () => secondChild!.waitForMaintenanceEvidence(),
    }).finally(() => { maintenanceSettled = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    expect(maintenanceSettled).toBe(false);
    await page.getByLabel("Message", { exact: true }).fill(PRESERVED_CANARY);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(PRESERVED_CANARY)).toBeVisible();
    await assertHostedWakePublished();
    await secondChild.command("RELEASE_ADMISSION");
    await admittedWake;
    await secondChild.command("RELEASE_MARKET");
    await secondChild.command("RELEASE_MODEL");
    const productionProof = await maintenance;
    await assertLoopbackPortAvailable(beforeMaintenance.port);
    const claimedAfterMaintenance = await pool.query<{ readonly count: number }>(
      "select count(*)::int count from bridge_model_jobs where status='CLAIMED'",
    );
    const pendingAfterMaintenance = await pool.query<{ readonly count: number }>(
      "select count(*)::int count from bridge_model_jobs where status='PENDING'",
    );
    expect(claimedAfterMaintenance.rows[0]?.count).toBe(0);
    expect(pendingAfterMaintenance.rows[0]?.count).toBeGreaterThan(0);
    expect({
      ...productionProof,
      schedulePaused: true,
      activePollSettled: true,
      claimedJobsSettled: true,
      pendingJobsPreserved: true,
    }).toEqual({
      authority: "PRODUCTION_STOP_FOR_MAINTENANCE",
      ownerSystemPipeProven: true,
      schedulePaused: true,
      activePollSettled: true,
      claimedJobsSettled: true,
      pendingJobsPreserved: true,
      containerAbsent: true,
      funnelSettled: true,
      taskNonRunning: true,
      proofAfterChildSettlement: true,
    });
    const storedPrivateValues = await pool.query<{
      readonly kind: "event-ciphertext" | "latest-ciphertext" | "wrapped-key";
      readonly value: string;
    }>(
      `select kind,value from (
         select 'event-ciphertext'::text kind,encode(ciphertext,'base64') value
           from encrypted_event_bodies
         union all
         select 'latest-ciphertext',encode(ciphertext,'base64')
           from market_latest_quotes where ciphertext is not null
         union all
         select 'wrapped-key',encode(wrapped_key,'base64') from aggregate_data_keys
       ) private_values order by kind,value`,
    );
    if (storedPrivateValues.rows.length === 0
        || !storedPrivateValues.rows.some(({ kind }) => kind === "event-ciphertext")
        || !storedPrivateValues.rows.some(({ kind }) => kind === "latest-ciphertext")
        || !storedPrivateValues.rows.some(({ kind }) => kind === "wrapped-key")) {
      throw new Error("E2E_STORED_PRIVATE_VALUES_REQUIRED");
    }
    await secondChild.close();
    secondChild = undefined;

    const publicPayloads: Promise<string>[] = [];
    const publicRequests: { readonly postData: string | null; readonly url: string }[] = [];
    page.on("request", (browserRequest) => {
      publicRequests.push({ url: browserRequest.url(), postData: browserRequest.postData() });
    });
    page.on("response", (response) => {
      const contentType = response.headers()["content-type"] ?? "";
      if (/(?:text|json|javascript)/iu.test(contentType)) {
        publicPayloads.push(response.text().catch(() => ""));
      }
    });
    await page.context().clearCookies();
    await page.goto(e2eBaseURL());
    await expect(page.getByText("SIMULATION ONLY \u2014 NOT A REAL TRADE")).toBeVisible();
    const publicApi = await request.get(`${e2eBaseURL()}/api/public/feed`);
    expect(publicApi.status()).toBe(200);
    const captured = [
      await page.content(),
      await publicApi.text(),
      ...(await Promise.all(publicPayloads)),
      JSON.stringify(publicRequests),
    ].join("\n");
    const requiredSecret = (name: string): string => {
      const value = process.env[name];
      if (!value) throw new Error(`E2E_LEAKAGE_SECRET_REQUIRED:${name}`);
      return value;
    };
    const forbiddenPublicValues = [
      { label: "private-canary", value: PRIVATE_CANARY },
      { label: "offline-canary", value: OFFLINE_CANARY },
      { label: "pending-canary", value: PENDING_CANARY },
      { label: "preserved-canary", value: PRESERVED_CANARY },
      { label: "node-reply", value: NODE_REPLY },
      { label: "live-quote", value: LIVE_QUOTE },
      { label: "qstash-token", value: requiredSecret("QSTASH_TOKEN") },
      { label: "qstash-current-key", value: requiredSecret("QSTASH_CURRENT_SIGNING_KEY") },
      { label: "qstash-next-key", value: requiredSecret("QSTASH_NEXT_SIGNING_KEY") },
      { label: "event-root-key", value: requiredSecret("GUSTAVO_EVENT_ROOT_KEY_V1") },
      { label: "cursor-key", value: requiredSecret("GUSTAVO_CURSOR_SIGNING_KEY") },
      { label: "operator-health-token", value: requiredSecret("GUSTAVO_OPERATOR_HEALTH_TOKEN") },
      { label: "control-nonce", value: controlNonce },
      { label: "tunnel-url", value: PUBLIC_WAKE_URL },
      ...storedPrivateValues.rows.map(({ kind, value }, index) => ({
        label: `${kind}-${index}`,
        value,
      })),
    ];
    expect(assertNoPublicLeakage(captured, forbiddenPublicValues)).toBe(true);
    await expect(assertNoOwnedFixtureResidue()).resolves.toBe(true);
  } finally {
    if (firstChild) await firstChild.close().catch(() => undefined);
    if (secondChild) await secondChild.close().catch(() => undefined);
    await pool.end();
  }
});

test("opt-in real Docker cleanup keeps repository and application secrets unmounted", async () => {
  test.skip(process.env.GUSTAVO_E2E_REAL_DOCKER !== "1", "real Docker fixture is opt-in");
  const image = process.env.GUSTAVO_E2E_REAL_DOCKER_IMAGE;
  if (!image || !/^sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error("E2E_REAL_DOCKER_IMAGE_REQUIRED");
  }
  const name = `gustavo-e2e-codex-${randomUUID()}`;
  const ownershipRecord = await registerOwnedCodexContainer(name);
  try {
    const createdResult = await execFileAsync("docker", [
      "create", "--name", name,
      "--label", "com.gustavo.codex-runner=v1",
      "--label", `com.gustavo.e2e.registry=${currentFixtureOwnershipId()}`,
      "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/workspace:rw,noexec,nosuid,nodev,size=16777216",
      image,
    ], { windowsHide: true, timeout: 30_000 });
    expect(createdResult.stdout.trim()).toMatch(/^[a-f0-9]{64}$/u);
    const inspect = await execFileAsync("docker", ["inspect", name, "--format", "{{json .Mounts}}"], {
      windowsHide: true,
      timeout: 30_000,
    });
    const mounts = inspect.stdout;
    expect(mounts).not.toContain(process.cwd());
    expect(mounts).not.toMatch(/DATABASE_URL|QSTASH|FINNHUB|TAILSCALE/u);
  } finally {
    await cleanupOwnedCodexContainer(name, ownershipRecord);
  }
  const residue = await execFileAsync("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"], {
    windowsHide: true,
    timeout: 30_000,
  });
  expect(residue.stdout.trim()).toBe("");
});
}
