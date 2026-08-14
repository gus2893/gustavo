import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { isAbsolute, normalize, resolve } from "node:path";

const CONFIGURED_MODEL = "gpt-5.6-sol" as const;
const AUTH_VOLUME = "gustavo-codex-auth-v1" as const;
const CONTAINER_NAME = "gustavo-codex-singleton-v1" as const;
const HOST_LEASE_PIPE = "\\\\.\\pipe\\gustavo-codex-runner-v1" as const;
const RUNNER_LABEL_NAME = "com.gustavo.codex-runner" as const;
const RUNNER_LABEL_VALUE = "v1" as const;
const RUN_ID_LABEL_NAME = "com.gustavo.codex-run-id" as const;
const ROLES = Object.freeze(["NODE", "MAIN", "EVALUATOR"] as const);
const SCHEMA_PATHS = Object.freeze({
  NODE: "/schemas/node.schema.json",
  MAIN: "/schemas/main.schema.json",
  EVALUATOR: "/schemas/evaluator.schema.json",
} as const);
const IMAGE_PATTERN = /^(?:[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-z0-9._-]+)?@sha256:|sha256:)[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const CONTAINER_NAME_PATTERN = /^gustavo-codex-singleton-v1$/u;
const MAX_STDIN_BYTES = 65_536;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;
const MAX_JSON_EVENTS = 256;
const MAX_JSON_LINE_BYTES = 65_536;
const MAX_JSON_DEPTH = 64;
const MAX_RESPONSE_BYTES = 32_768;
const MAX_USAGE_COUNT = 1_000_000_000;
const MAX_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const CONTROL_TIMEOUT_MS = 5_000;
const INSPECT_RETRIES = 100;
const INSPECT_RETRY_MS = 25;
const EMPTY_BYTES = new Uint8Array(0);

export type CodexRole = typeof ROLES[number];
export type CodexOutputOverflow = "STDOUT" | "STDERR";

export interface CodexReportedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface IsolatedCodexResult {
  readonly response: string;
  readonly usage?: CodexReportedUsage;
}

export interface CodexContainerIdentity {
  readonly name: string;
  readonly runId: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly containerId?: string;
}

interface CodexContainerExecutionRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: Uint8Array;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly identity: CodexContainerIdentity;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

interface CodexContainerExecutionResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly overflow?: CodexOutputOverflow;
  readonly outputAfterBound?: boolean;
  readonly containerExitProven: boolean;
  readonly containerAbsentProven: boolean;
  readonly containerNeverCreatedProven?: boolean;
  readonly containerBusyProven?: boolean;
}

export type DockerExecutableResolver = (recordedPath: string) => Promise<string>;

export interface DockerCreateRequest {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface DockerStartRequest extends DockerIdentityRequest {
  readonly stdin: Uint8Array;
  readonly env: Readonly<Record<string, string>>;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface DockerIdentityRequest {
  readonly identity: CodexContainerIdentity;
  readonly signal: AbortSignal;
}

export interface DockerListRequest {
  readonly runnerLabel: string;
  readonly signal: AbortSignal;
}

export interface DockerCommandResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly overflow?: CodexOutputOverflow;
}

export interface DockerCreateResult extends DockerCommandResult {
  readonly helperExitProven: boolean;
  readonly completion: "NATURAL" | "TERMINATED";
}

export interface DockerWaitResult {
  readonly helperExitCode: number | null;
  readonly containerExitCode: number | null;
}

export interface DockerKillResult {
  readonly helperExitCode: number | null;
}

export interface DockerInspection {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: "created" | "running" | "exited" | "dead" | "paused" | "restarting" | "removing";
  readonly exitCode: number | null;
}

export interface DockerInspectResult {
  readonly daemonAvailable: boolean;
  readonly exists: boolean;
  readonly inspection?: DockerInspection;
}

export interface DockerListResult {
  readonly daemonAvailable: boolean;
  readonly names: readonly string[];
}

export interface CodexDockerController {
  acquireHostLease(signal: AbortSignal): Promise<{
    release(): Promise<void>;
  } | undefined>;
  create(request: DockerCreateRequest): Promise<DockerCreateResult>;
  start(request: DockerStartRequest): Promise<DockerCommandResult>;
  wait(request: DockerIdentityRequest): Promise<DockerWaitResult>;
  kill(request: DockerIdentityRequest): Promise<DockerKillResult>;
  remove(request: DockerIdentityRequest): Promise<{ readonly helperExitCode: number | null }>;
  inspect(request: DockerIdentityRequest): Promise<DockerInspectResult>;
  list(request: DockerListRequest): Promise<DockerListResult>;
}

export interface RunIsolatedCodexOptions {
  readonly role: CodexRole;
  readonly prompt: string;
  readonly image: string;
  readonly authVolume: typeof AUTH_VOLUME;
  readonly timeoutMs: number;
  readonly dockerExecutable: string;
  readonly resolveDockerExecutable?: DockerExecutableResolver;
  readonly model?: typeof CONFIGURED_MODEL;
  readonly signal?: AbortSignal;
  readonly controller?: CodexDockerController;
}

export interface ReconcileCodexContainersOptions {
  readonly image: string;
  readonly dockerExecutable: string;
  readonly resolveDockerExecutable?: DockerExecutableResolver;
  readonly controller?: CodexDockerController;
  readonly signal?: AbortSignal;
}

interface RawDockerResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly overflow?: CodexOutputOverflow;
  readonly terminationInitiated: boolean;
}

let launchLocked = false;
let interruptedCreate: CodexContainerIdentity | undefined;
let authorityOwner: {
  readonly token: symbol;
  readonly kind: "RUN" | "RECONCILE";
  readonly pending: Set<Promise<void>>;
  releaseRequested: boolean;
  hostLease?: { release(): Promise<void> };
  releasing?: Promise<void>;
} | undefined;

function safeError(code: string): Error {
  return new Error(code);
}

function sameIdentity(left: CodexContainerIdentity, right: CodexContainerIdentity): boolean {
  return left.name === right.name
    && left.runId === right.runId
    && left.image === right.image
    && labelsAreExact(left.labels, right)
    && labelsAreExact(right.labels, left);
}

function rememberInterruptedCreate(identity: CodexContainerIdentity): void {
  if (interruptedCreate !== undefined && !sameIdentity(interruptedCreate, identity)) {
    launchLocked = true;
    throw safeError("CODEX_CONTAINER_TERMINATION_UNPROVEN");
  }
  interruptedCreate ??= identity;
  launchLocked = true;
}

function clearInterruptedCreate(identity: CodexContainerIdentity): void {
  if (interruptedCreate !== undefined && sameIdentity(interruptedCreate, identity)) {
    interruptedCreate = undefined;
  }
}

function claimAuthority(kind: "RUN" | "RECONCILE"): symbol {
  if (authorityOwner !== undefined) {
    throw safeError(kind === "RUN" ? "CODEX_CONTAINER_BUSY" : "CODEX_CONTAINER_RECONCILIATION_FAILED");
  }
  const token = Symbol(kind);
  authorityOwner = { token, kind, pending: new Set(), releaseRequested: false };
  return token;
}

async function finalizeAuthorityRelease(
  owner: NonNullable<typeof authorityOwner>,
): Promise<void> {
  if (owner.releasing !== undefined) return owner.releasing;
  const release = owner.hostLease?.release() ?? Promise.resolve();
  owner.releasing = release.then(() => {
    if (authorityOwner?.token === owner.token) authorityOwner = undefined;
  }, () => {
    launchLocked = true;
    throw safeError("CODEX_CONTAINER_UNAVAILABLE");
  });
  return owner.releasing;
}

async function requestAuthorityRelease(token: symbol): Promise<void> {
  const owner = authorityOwner;
  if (owner?.token !== token) throw safeError("CODEX_CONTAINER_UNAVAILABLE");
  owner.releaseRequested = true;
  if (owner.pending.size === 0) await finalizeAuthorityRelease(owner);
}

function retainAuthorityUntilSettlement(operation: Promise<unknown>): void {
  const owner = authorityOwner;
  if (owner === undefined) return;
  const settlement = operation.then(() => undefined, () => undefined);
  owner.pending.add(settlement);
  void settlement.then(() => {
    const current = authorityOwner;
    if (current?.token !== owner.token) return;
    current.pending.delete(settlement);
    if (current.releaseRequested && current.pending.size === 0) {
      void finalizeAuthorityRelease(current).catch(() => undefined);
    }
  });
}

async function acquireOwnerHostLease(
  token: symbol,
  controller: CodexDockerController,
  signal: AbortSignal,
): Promise<boolean> {
  const lease = await controller.acquireHostLease(signal);
  const owner = authorityOwner;
  if (owner?.token !== token) {
    if (lease !== undefined) await lease.release();
    return false;
  }
  if (lease === undefined) return false;
  owner.hostLease = lease;
  return true;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function immutableImage(value: string): string {
  if (typeof value !== "string" || !IMAGE_PATTERN.test(value)) {
    throw safeError("CODEX_IMAGE_INVALID");
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw safeError("CODEX_TIMEOUT_INVALID");
  }
  return value;
}

function createIdentity(image: string): CodexContainerIdentity {
  const runId = randomBytes(16).toString("hex");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw safeError("CODEX_CONTAINER_UNAVAILABLE");
  }
  return Object.freeze({
    name: CONTAINER_NAME,
    runId,
    image,
    labels: Object.freeze({
      [RUNNER_LABEL_NAME]: RUNNER_LABEL_VALUE,
      [RUN_ID_LABEL_NAME]: runId,
    }),
  });
}

function helperEnvironment(): Readonly<Record<string, string>> {
  const allowed = process.platform === "win32"
    ? ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]
    : ["TMPDIR"];
  const environment: Record<string, string> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value === undefined || value.length === 0) continue;
    const canonical = name === "SYSTEMROOT" ? "SystemRoot" : name;
    if (environment[canonical] === undefined) environment[canonical] = value;
  }
  return Object.freeze(environment);
}

function pathsAreExact(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

async function resolveTrustedDockerExecutable(
  recordedPath: string,
  injectedResolver?: DockerExecutableResolver,
): Promise<string> {
  if (
    typeof recordedPath !== "string"
    || !isAbsolute(recordedPath)
    || recordedPath.includes("\0")
  ) throw safeError("CODEX_DOCKER_EXECUTABLE_INVALID");
  if (injectedResolver) {
    try {
      const resolvedPath = await injectedResolver(recordedPath);
      if (!isAbsolute(resolvedPath) || !pathsAreExact(recordedPath, resolvedPath)) {
        throw safeError("CODEX_DOCKER_EXECUTABLE_INVALID");
      }
      return resolvedPath;
    } catch {
      throw safeError("CODEX_DOCKER_EXECUTABLE_INVALID");
    }
  }
  const candidate = recordedPath;
  try {
    const before = await lstat(candidate);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw safeError("CODEX_CONTAINER_UNAVAILABLE");
    }
    const canonical = await realpath(candidate);
    if (!isAbsolute(canonical) || !pathsAreExact(candidate, canonical)) {
      throw safeError("CODEX_CONTAINER_UNAVAILABLE");
    }
    const after = await lstat(canonical);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) throw safeError("CODEX_CONTAINER_UNAVAILABLE");
    return canonical;
  } catch {
    throw safeError("CODEX_DOCKER_EXECUTABLE_INVALID");
  }
}

function dockerArguments(
  role: CodexRole,
  timeoutMs: number,
  identity: CodexContainerIdentity,
): readonly string[] {
  const internalSeconds = `${Math.ceil(timeoutMs / 1_000)}s`;
  return Object.freeze([
    "create",
    "-i",
    "--read-only",
    "--init",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64",
    "--memory", "512m",
    "--cpus", "1.0",
    "--network", "bridge",
    "--pull=never",
    "--tmpfs", "/workspace:rw,noexec,nosuid,nodev,size=16777216",
    "--mount", `type=volume,src=${AUTH_VOLUME},dst=/codex-home`,
    "--env", "CODEX_HOME=/codex-home",
    "--name", identity.name,
    "--label", `${RUNNER_LABEL_NAME}=${RUNNER_LABEL_VALUE}`,
    "--label", `${RUN_ID_LABEL_NAME}=${identity.runId}`,
    identity.image,
    "/usr/bin/timeout", "--signal=KILL", "--kill-after=5s", internalSeconds,
    "codex", "exec", "--ephemeral", "--ignore-user-config",
    // Security boundary: auth persists, but every model-controlled tool and retained history is off.
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
    "--ask-for-approval", "never", "--model", CONFIGURED_MODEL, "--json",
    "--output-schema", SCHEMA_PATHS[role], "-C", "/workspace", "-",
  ]);
}

function labelsAreExact(
  labels: Readonly<Record<string, string>>,
  identity: CodexContainerIdentity,
): boolean {
  const entries = Object.entries(labels);
  return entries.length === 2
    && labels[RUNNER_LABEL_NAME] === RUNNER_LABEL_VALUE
    && labels[RUN_ID_LABEL_NAME] === identity.runId;
}

function inspectionMatches(
  inspection: DockerInspection,
  identity: CodexContainerIdentity,
): boolean {
  return CONTAINER_ID_PATTERN.test(inspection.id)
    && (identity.containerId === undefined || inspection.id === identity.containerId)
    && inspection.name === identity.name
    && inspection.image === identity.image
    && labelsAreExact(inspection.labels, identity);
}

function fatalDecode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
}

function exactResponse(value: unknown): { readonly response: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1
    || !Object.prototype.hasOwnProperty.call(record, "response")
    || typeof record.response !== "string"
    || record.response.length === 0
    || byteLength(record.response) > MAX_RESPONSE_BYTES
  ) {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
  return Object.freeze({ response: record.response });
}

function assertStrictJson(value: string): void {
  const whitespace = (character: string | undefined): boolean =>
    character === " " || character === "\t" || character === "\n" || character === "\r";
  const skipWhitespace = (start: number): number => {
    let index = start;
    while (whitespace(value[index])) index += 1;
    return index;
  };
  const stringEnd = (start: number): number => {
    if (value[start] !== '"') throw safeError("CODEX_OUTPUT_INVALID");
    let index = start + 1;
    while (index < value.length) {
      const character = value[index];
      if (character === '"') return index + 1;
      if (character === "\\") {
        const escaped = value[index + 1];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(value.slice(index + 2, index + 6))) {
            throw safeError("CODEX_OUTPUT_INVALID");
          }
          index += 6;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
          throw safeError("CODEX_OUTPUT_INVALID");
        }
        index += 2;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) {
        throw safeError("CODEX_OUTPUT_INVALID");
      }
      index += 1;
    }
    throw safeError("CODEX_OUTPUT_INVALID");
  };
  const decodedKey = (start: number, end: number): string => {
    try {
      const key = JSON.parse(value.slice(start, end)) as unknown;
      if (typeof key !== "string") throw safeError("CODEX_OUTPUT_INVALID");
      return key;
    } catch {
      throw safeError("CODEX_OUTPUT_INVALID");
    }
  };
  const primitiveEnd = (start: number): number => {
    let index = start;
    while (
      index < value.length
      && !whitespace(value[index])
      && value[index] !== ","
      && value[index] !== "]"
      && value[index] !== "}"
    ) index += 1;
    if (index === start) throw safeError("CODEX_OUTPUT_INVALID");
    try {
      const primitive = JSON.parse(value.slice(start, index)) as unknown;
      if (
        primitive !== null
        && typeof primitive !== "boolean"
        && (typeof primitive !== "number" || !Number.isFinite(primitive))
      ) throw safeError("CODEX_OUTPUT_INVALID");
    } catch {
      throw safeError("CODEX_OUTPUT_INVALID");
    }
    return index;
  };
  const parseValue = (start: number, depth: number): number => {
    if (depth > MAX_JSON_DEPTH) throw safeError("CODEX_OUTPUT_INVALID");
    let index = skipWhitespace(start);
    if (value[index] === '"') return stringEnd(index);
    if (value[index] === "{") {
      index = skipWhitespace(index + 1);
      const keys = new Set<string>();
      if (value[index] === "}") return index + 1;
      for (;;) {
        const keyStart = index;
        const keyEnd = stringEnd(keyStart);
        const key = decodedKey(keyStart, keyEnd);
        if (keys.has(key)) throw safeError("CODEX_OUTPUT_INVALID");
        keys.add(key);
        index = skipWhitespace(keyEnd);
        if (value[index] !== ":") throw safeError("CODEX_OUTPUT_INVALID");
        index = skipWhitespace(parseValue(index + 1, depth + 1));
        if (value[index] === "}") return index + 1;
        if (value[index] !== ",") throw safeError("CODEX_OUTPUT_INVALID");
        index = skipWhitespace(index + 1);
      }
    }
    if (value[index] === "[") {
      index = skipWhitespace(index + 1);
      if (value[index] === "]") return index + 1;
      for (;;) {
        index = skipWhitespace(parseValue(index, depth + 1));
        if (value[index] === "]") return index + 1;
        if (value[index] !== ",") throw safeError("CODEX_OUTPUT_INVALID");
        index = skipWhitespace(index + 1);
      }
    }
    return primitiveEnd(index);
  };

  const end = skipWhitespace(parseValue(0, 0));
  if (end !== value.length) throw safeError("CODEX_OUTPUT_INVALID");
}

function parseJson(value: string): unknown {
  try {
    assertStrictJson(value);
    return JSON.parse(value) as unknown;
  } catch {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
}

function exactUsage(value: unknown): CodexReportedUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
  let keys: string[];
  let inputTokens: unknown;
  let outputTokens: unknown;
  let cachedInputTokens: unknown;
  let cacheWriteInputTokens: unknown;
  let reasoningOutputTokens: unknown;
  try {
    const usage = value as Record<string, unknown>;
    keys = Object.keys(usage).sort();
    inputTokens = Reflect.get(usage, "input_tokens");
    outputTokens = Reflect.get(usage, "output_tokens");
    cachedInputTokens = Reflect.get(usage, "cached_input_tokens");
    cacheWriteInputTokens = Reflect.get(usage, "cache_write_input_tokens");
    reasoningOutputTokens = Reflect.get(usage, "reasoning_output_tokens");
  } catch {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
  // @openai/codex@0.146.0 serializes this exact five-field Usage shape.
  const counts = [
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  ];
  if (
    keys.length !== 5
    || keys[0] !== "cache_write_input_tokens"
    || keys[1] !== "cached_input_tokens"
    || keys[2] !== "input_tokens"
    || keys[3] !== "output_tokens"
    || keys[4] !== "reasoning_output_tokens"
    || counts.some((count) =>
      !Number.isSafeInteger(count)
      || (count as number) < 0
      || (count as number) > MAX_USAGE_COUNT)
  ) {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
  return Object.freeze({
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
  });
}

function responseFromEvent(value: unknown): { readonly response: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type !== "item.completed") return undefined;
  if (!event.item || typeof event.item !== "object" || Array.isArray(event.item)) {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
  const item = event.item as Record<string, unknown>;
  if (item.type !== "agent_message" || typeof item.text !== "string") return undefined;
  return exactResponse(parseJson(item.text));
}

function parseOutput(stdoutBytes: Uint8Array): IsolatedCodexResult {
  if (stdoutBytes.byteLength === 0 || stdoutBytes.byteLength > MAX_STDOUT_BYTES) {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
  const stdout = fatalDecode(stdoutBytes);
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_JSON_EVENTS) {
    throw safeError("CODEX_OUTPUT_INVALID");
  }
  const responses: { readonly response: string }[] = [];
  let usage: CodexReportedUsage | undefined;
  for (const line of lines) {
    if (byteLength(line) > MAX_JSON_LINE_BYTES) throw safeError("CODEX_OUTPUT_INVALID");
    const value = parseJson(line);
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as Record<string, unknown>).type === "turn.completed"
      && Object.prototype.hasOwnProperty.call(value, "usage")
    ) {
      if (usage !== undefined) throw safeError("CODEX_OUTPUT_INVALID");
      usage = exactUsage((value as Record<string, unknown>).usage);
    }
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, "response")
    ) {
      responses.push(exactResponse(value));
      continue;
    }
    const response = responseFromEvent(value);
    if (response) responses.push(response);
  }
  if (responses.length !== 1) throw safeError("CODEX_OUTPUT_INVALID");
  return Object.freeze({
    response: responses[0].response,
    ...(usage === undefined ? {} : { usage }),
  });
}

function processFailure(stderrBytes: Uint8Array): Error {
  const stderr = fatalDecode(stderrBytes);
  if (/model[\s\S]{0,120}(?:unavailable|not found|unsupported|does not exist)/iu.test(stderr)) {
    return safeError("CODEX_MODEL_UNAVAILABLE");
  }
  if (/(?:usage limit|quota|rate limit)/iu.test(stderr)) {
    return safeError("CODEX_QUOTA_EXHAUSTED");
  }
  if (/(?:not signed in|authentication|unauthorized|login required)/iu.test(stderr)) {
    return safeError("CODEX_AUTH_UNAVAILABLE");
  }
  return safeError("CODEX_PROCESS_FAILED");
}

function delayUntilAbort(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolveDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay(true);
    }, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolveDelay(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function bounded<T>(
  operation: Promise<T>,
  controller: AbortController,
  milliseconds = CONTROL_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const externalAbort = Symbol("EXTERNAL_ABORT");
  let onExternalAbort: (() => void) | undefined;
  const interrupted = externalSignal === undefined
    ? new Promise<never>(() => undefined)
    : new Promise<typeof externalAbort>((resolveAbort) => {
      onExternalAbort = () => {
        controller.abort();
        resolveAbort(externalAbort);
      };
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    });
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      retainAuthorityUntilSettlement(operation);
      reject(safeError("CODEX_CONTAINER_TERMINATION_UNPROVEN"));
    }, milliseconds);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([operation, expired, interrupted]);
    // Cancellation terminates the helper but never abandons it. The caller,
    // process owner, and named-pipe lease remain held until actual settlement.
    if (outcome === externalAbort) return await operation;
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal !== undefined && onExternalAbort !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function throwIfReconcileAborted(signal: AbortSignal): void {
  if (signal.aborted) throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
}

async function proveAbsent(
  controller: CodexDockerController,
  identity: CodexContainerIdentity,
  externalSignal?: AbortSignal,
): Promise<boolean> {
  const operationController = new AbortController();
  const result = await bounded(controller.inspect({
    identity,
    signal: operationController.signal,
  }), operationController, CONTROL_TIMEOUT_MS, externalSignal);
  return result.daemonAvailable && !result.exists;
}

function ownedIdentity(
  identity: CodexContainerIdentity,
  containerId: string,
): CodexContainerIdentity {
  return Object.freeze({ ...identity, containerId });
}

function parseContainerId(result: DockerCommandResult): string | undefined {
  if (result.exitCode !== 0 || result.overflow !== undefined) return undefined;
  const containerId = fatalDecode(result.stdout).trim();
  return CONTAINER_ID_PATTERN.test(containerId) ? containerId : undefined;
}

async function inspectOwned(
  controller: CodexDockerController,
  identity: CodexContainerIdentity,
  externalSignal?: AbortSignal,
): Promise<DockerInspectResult | undefined> {
  const inspectController = new AbortController();
  try {
    return await bounded(controller.inspect({
      identity,
      signal: inspectController.signal,
    }), inspectController, CONTROL_TIMEOUT_MS, externalSignal);
  } catch {
    return undefined;
  }
}

function guardedWait(
  controller: CodexDockerController,
  identity: CodexContainerIdentity,
  waitController: AbortController,
): Promise<{ readonly ok: true; readonly value: DockerWaitResult } | { readonly ok: false }> {
  return controller.wait({ identity, signal: waitController.signal }).then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
}

async function removeOwnedAndProveAbsent(
  controller: CodexDockerController,
  identity: CodexContainerIdentity,
  externalSignal?: AbortSignal,
): Promise<boolean> {
  const removeController = new AbortController();
  try {
    const removed = await bounded(controller.remove({
      identity,
      signal: removeController.signal,
    }), removeController, CONTROL_TIMEOUT_MS, externalSignal);
    return removed.helperExitCode === 0
      && await proveAbsent(controller, identity, externalSignal);
  } catch {
    return false;
  }
}

async function terminateOwned(
  controller: CodexDockerController,
  identity: CodexContainerIdentity,
  existingWait?: {
    readonly controller: AbortController;
    readonly promise: ReturnType<typeof guardedWait>;
  },
  externalSignal?: AbortSignal,
): Promise<{ readonly exitCode: number | null; readonly proven: boolean; readonly absent: boolean }> {
  // `docker wait` is registered before the exact-name kill in every termination path.
  const waitController = existingWait?.controller ?? new AbortController();
  const waitPromise = existingWait?.promise ?? guardedWait(controller, identity, waitController);
  const killController = new AbortController();
  let killProven = false;
  try {
    const killed = await bounded(controller.kill({
      identity,
      signal: killController.signal,
    }), killController, CONTROL_TIMEOUT_MS, externalSignal);
    killProven = killed.helperExitCode === 0;
  } catch {
    killProven = false;
  }
  const waitBoundController = new AbortController();
  let waited: DockerWaitResult | undefined;
  try {
    const outcome = await bounded(
      waitPromise,
      waitBoundController,
      CONTROL_TIMEOUT_MS,
      externalSignal,
    );
    if (outcome.ok) waited = outcome.value;
  } catch {
    waitController.abort();
  }
  const stopped = await inspectOwned(controller, identity, externalSignal);
  const stoppedProven = stopped?.daemonAvailable === true
    && stopped.exists
    && stopped.inspection !== undefined
    && inspectionMatches(stopped.inspection, identity)
    && stopped.inspection.state === "exited"
    && waited?.containerExitCode === stopped.inspection.exitCode;
  const absent = stoppedProven
    ? await removeOwnedAndProveAbsent(controller, identity, externalSignal)
    : false;
  return {
    exitCode: waited?.containerExitCode ?? null,
    proven: killProven
      && waited?.helperExitCode === 0
      && waited.containerExitCode !== null
      && stoppedProven,
    absent,
  };
}

async function reconcileOwnedInspection(
  controller: CodexDockerController,
  identity: CodexContainerIdentity,
  inspection: DockerInspection,
  externalSignal?: AbortSignal,
): Promise<boolean> {
  if (!inspectionMatches(inspection, identity)) return false;
  const owned = ownedIdentity(identity, inspection.id);
  if (inspection.state === "created") {
    return removeOwnedAndProveAbsent(controller, owned, externalSignal);
  }
  if (inspection.state === "exited") {
    const waitController = new AbortController();
    try {
      const waitOutcome = await bounded(
        guardedWait(controller, owned, waitController),
        waitController,
        CONTROL_TIMEOUT_MS,
        externalSignal,
      );
      return waitOutcome.ok
        && waitOutcome.value.helperExitCode === 0
        && waitOutcome.value.containerExitCode !== null
        && waitOutcome.value.containerExitCode === inspection.exitCode
        && await removeOwnedAndProveAbsent(controller, owned, externalSignal);
    } catch {
      return false;
    }
  }
  if (
    inspection.state === "running"
    || inspection.state === "paused"
    || inspection.state === "restarting"
  ) {
    const terminated = await terminateOwned(controller, owned, undefined, externalSignal);
    return terminated.proven && terminated.absent;
  }
  return false;
}

function runnerInspectionMatches(inspection: DockerInspection, image: string): boolean {
  const labels = inspection.labels;
  return CONTAINER_ID_PATTERN.test(inspection.id)
    && inspection.name === CONTAINER_NAME
    && inspection.image === image
    && Object.keys(labels).length === 2
    && labels[RUNNER_LABEL_NAME] === RUNNER_LABEL_VALUE
    && RUN_ID_PATTERN.test(labels[RUN_ID_LABEL_NAME] ?? "");
}

function identityFromInspection(inspection: DockerInspection): CodexContainerIdentity {
  return Object.freeze({
    name: CONTAINER_NAME,
    runId: inspection.labels[RUN_ID_LABEL_NAME],
    image: inspection.image,
    labels: Object.freeze({ ...inspection.labels }),
    containerId: inspection.id,
  });
}

function abortOutcome(signal: AbortSignal): Promise<"ABORTED"> {
  return new Promise((resolveAbort) => {
    if (signal.aborted) resolveAbort("ABORTED");
    else signal.addEventListener("abort", () => resolveAbort("ABORTED"), { once: true });
  });
}

async function executeWithController(
  request: CodexContainerExecutionRequest,
  controller: CodexDockerController,
): Promise<CodexContainerExecutionResult> {
  const createController = new AbortController();
  let createSettled = false;
  const createPromise = controller.create({
    args: request.args,
    env: request.env,
    signal: createController.signal,
    maxStdoutBytes: 128,
    maxStderrBytes: request.maxStderrBytes,
  }).then((result) => {
    createSettled = true;
    return result;
  }, (error: unknown) => {
    createSettled = true;
    throw error;
  });
  let createOutcome: DockerCreateResult | "ABORTED";
  try {
    createOutcome = await Promise.race([createPromise, abortOutcome(request.signal)]);
  } catch {
    createOutcome = "ABORTED";
  }
  let createResult: DockerCreateResult | undefined;
  if (createOutcome === "ABORTED") {
    rememberInterruptedCreate(request.identity);
    createController.abort();
    try {
      // Do not abandon this promise. The process owner remains claimed until the
      // helper actually settles, even after the caller's bounded wait returns.
      createResult = await createPromise;
    } catch {
      createResult = undefined;
    }
  } else {
    createResult = createOutcome;
  }

  if (request.signal.aborted || createResult?.completion === "TERMINATED") {
    rememberInterruptedCreate(request.identity);
  }

  const createdId = createResult === undefined ? undefined : parseContainerId(createResult);
  const inspectionIdentity = createdId === undefined
    ? request.identity
    : ownedIdentity(request.identity, createdId);
  const afterCreate = await inspectOwned(controller, inspectionIdentity);
  if (
    createSettled
    && createResult !== undefined
    && createResult.helperExitProven
    && createResult.completion === "NATURAL"
    && !request.signal.aborted
    && createResult.exitCode !== null
    && createResult.exitCode !== 0
    && createResult.overflow === undefined
    && afterCreate?.daemonAvailable === true
    && !afterCreate.exists
  ) {
    return {
      exitCode: createResult?.exitCode ?? 0,
      stdout: EMPTY_BYTES,
      stderr: createResult?.stderr ?? EMPTY_BYTES,
      ...(createResult?.overflow === undefined ? {} : { overflow: createResult.overflow }),
      containerExitProven: false,
      containerAbsentProven: true,
      containerNeverCreatedProven: true,
    };
  }
  if (
    createSettled
    && createResult?.helperExitProven
    && createResult.completion === "NATURAL"
    && createResult.exitCode !== null
    && createResult.exitCode !== 0
    && afterCreate?.daemonAvailable === true
    && afterCreate.exists
    && afterCreate.inspection !== undefined
    && runnerInspectionMatches(afterCreate.inspection, request.identity.image)
    && !inspectionMatches(afterCreate.inspection, request.identity)
  ) {
    return {
      exitCode: createResult.exitCode,
      stdout: EMPTY_BYTES,
      stderr: EMPTY_BYTES,
      containerExitProven: false,
      containerAbsentProven: false,
      containerBusyProven: true,
    };
  }
  if (
    afterCreate?.daemonAvailable !== true
    || !afterCreate.exists
    || afterCreate.inspection === undefined
    || !inspectionMatches(afterCreate.inspection, request.identity)
  ) {
    return {
      exitCode: createResult?.exitCode ?? null,
      stdout: EMPTY_BYTES,
      stderr: EMPTY_BYTES,
      containerExitProven: false,
      containerAbsentProven: false,
    };
  }
  if (
    interruptedCreate !== undefined
    && sameIdentity(interruptedCreate, request.identity)
  ) {
    // Once create was interrupted, this run cannot upgrade later helper output
    // into lifecycle authority. Release only through a distinct reconciliation.
    return {
      exitCode: createResult?.exitCode ?? null,
      stdout: EMPTY_BYTES,
      stderr: EMPTY_BYTES,
      containerExitProven: false,
      containerAbsentProven: false,
    };
  }
  const identity = ownedIdentity(request.identity, afterCreate.inspection.id);
  if (
    request.signal.aborted
    ||
    !createResult?.helperExitProven
    ||
    createResult.completion !== "NATURAL"
    ||
    createdId === undefined
    || createdId !== identity.containerId
    || afterCreate.inspection.state !== "created"
  ) {
    const terminated = await terminateOwned(controller, identity);
    if (terminated.absent && terminated.proven) clearInterruptedCreate(identity);
    return {
      exitCode: createResult?.exitCode ?? terminated.exitCode,
      stdout: EMPTY_BYTES,
      stderr: EMPTY_BYTES,
      containerExitProven: terminated.proven,
      containerAbsentProven: terminated.absent,
    };
  }

  const waitController = new AbortController();
  const waitPromise = guardedWait(controller, identity, waitController);
  const startController = new AbortController();
  const startPromise = controller.start({
    identity,
    stdin: request.stdin,
    env: request.env,
    signal: startController.signal,
    maxStdoutBytes: request.maxStdoutBytes,
    maxStderrBytes: request.maxStderrBytes,
  });
  let startOutcome: DockerCommandResult | "ABORTED";
  try {
    startOutcome = await Promise.race([startPromise, abortOutcome(request.signal)]);
  } catch {
    startOutcome = "ABORTED";
  }
  const requiresKill = startOutcome === "ABORTED" || startOutcome.overflow !== undefined;
  let killed: Awaited<ReturnType<typeof terminateOwned>> | undefined;
  if (requiresKill) {
    killed = await terminateOwned(controller, identity, {
      controller: waitController,
      promise: waitPromise,
    });
  }
  let startResult: DockerCommandResult | undefined;
  if (startOutcome !== "ABORTED") startResult = startOutcome;
  else {
    const settleController = new AbortController();
    try {
      startResult = await bounded(startPromise, settleController);
    } catch {
      startController.abort();
    }
  }
  if (requiresKill) {
    return {
      exitCode: startResult?.exitCode ?? killed?.exitCode ?? null,
      stdout: EMPTY_BYTES,
      stderr: EMPTY_BYTES,
      ...(startResult?.overflow === undefined ? {} : { overflow: startResult.overflow }),
      ...(startOutcome === "ABORTED" ? { outputAfterBound: true } : {}),
      containerExitProven: killed?.proven === true
        && startResult?.exitCode !== null
        && startResult?.exitCode === killed.exitCode,
      containerAbsentProven: killed?.absent === true,
    };
  }

  const waitBoundController = new AbortController();
  let waited: DockerWaitResult | undefined;
  try {
    const outcome = await bounded(waitPromise, waitBoundController);
    if (outcome.ok) waited = outcome.value;
  } catch {
    waitController.abort();
  }
  const stopped = await inspectOwned(controller, identity);
  const stoppedProven = stopped?.daemonAvailable === true
    && stopped.exists
    && stopped.inspection !== undefined
    && inspectionMatches(stopped.inspection, identity)
    && stopped.inspection.state === "exited"
    && waited?.containerExitCode === stopped.inspection.exitCode;
  const absent = stoppedProven
    ? await removeOwnedAndProveAbsent(controller, identity)
    : false;
  const exitProven = startResult !== undefined
    && startResult.exitCode !== null
    && waited?.helperExitCode === 0
    && startResult.exitCode === waited.containerExitCode
    && stoppedProven;
  return {
    exitCode: startResult?.exitCode ?? null,
    stdout: startResult?.stdout ?? EMPTY_BYTES,
    stderr: startResult?.stderr ?? EMPTY_BYTES,
    ...(startResult?.overflow === undefined ? {} : { overflow: startResult.overflow }),
    containerExitProven: exitProven,
    containerAbsentProven: absent,
  };
}

function rawDockerCommand(input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin?: Uint8Array;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}): Promise<RawDockerResult> {
  if (input.signal.aborted) return Promise.reject(safeError("CODEX_CONTAINER_UNAVAILABLE"));
  return new Promise<RawDockerResult>((resolveCommand, rejectCommand) => {
    const child = spawn(input.executable, [...input.args], {
      env: { ...input.env } as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: CodexOutputOverflow | undefined;
    let terminationInitiated = false;
    let settled = false;
    const capture = (chunks: Buffer[], chunk: Buffer, stream: CodexOutputOverflow) => {
      const current = stream === "STDOUT" ? stdoutBytes : stderrBytes;
      const maximum = stream === "STDOUT" ? input.maxStdoutBytes : input.maxStderrBytes;
      const remaining = Math.max(0, maximum - current);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (stream === "STDOUT") stdoutBytes += Math.min(chunk.byteLength, remaining);
      else stderrBytes += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining && overflow === undefined) {
        overflow = stream;
        terminationInitiated = true;
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => {
      terminationInitiated = true;
      child.kill("SIGKILL");
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, "STDOUT"));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, "STDERR"));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      rejectCommand(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      resolveCommand({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        terminationInitiated,
        ...(overflow === undefined ? {} : { overflow }),
      });
    });
    child.stdin.end(input.stdin ?? EMPTY_BYTES);
  });
}

function parseWait(result: RawDockerResult): DockerWaitResult {
  if (result.overflow !== undefined) return { helperExitCode: result.exitCode, containerExitCode: null };
  const text = fatalDecode(result.stdout).trim();
  const containerExitCode = /^(?:0|[1-9][0-9]{0,2})$/u.test(text) ? Number(text) : null;
  return { helperExitCode: result.exitCode, containerExitCode };
}

function parseInspection(result: RawDockerResult): DockerInspection | undefined {
  if (result.exitCode !== 0 || result.overflow !== undefined) return undefined;
  const line = fatalDecode(result.stdout).trim();
  const fields = line.split(";");
  if (fields.length !== 6) return undefined;
  try {
    const id = JSON.parse(fields[0]) as unknown;
    const name = JSON.parse(fields[1]) as unknown;
    const image = JSON.parse(fields[2]) as unknown;
    const labels = JSON.parse(fields[3]) as unknown;
    const state = JSON.parse(fields[4]) as unknown;
    const exitCode = JSON.parse(fields[5]) as unknown;
    if (
      typeof id !== "string"
      || !CONTAINER_ID_PATTERN.test(id)
      || typeof name !== "string"
      || typeof image !== "string"
      || !labels
      || typeof labels !== "object"
      || Array.isArray(labels)
      || !["created", "running", "exited", "dead", "paused", "restarting", "removing"].includes(
        state as string,
      )
      || !Number.isSafeInteger(exitCode)
      || (exitCode as number) < 0
      || (exitCode as number) > 255
    ) return undefined;
    const cleanName = name.startsWith("/") ? name.slice(1) : name;
    if (!CONTAINER_NAME_PATTERN.test(cleanName)) return undefined;
    const entries = Object.entries(labels as Record<string, unknown>);
    if (entries.some((entry) => typeof entry[1] !== "string")) return undefined;
    return {
      id,
      name: cleanName,
      image,
      labels: Object.freeze(Object.fromEntries(entries) as Record<string, string>),
      state: state as DockerInspection["state"],
      exitCode: state === "exited" ? exitCode as number : null,
    };
  } catch {
    return undefined;
  }
}

function immutableContainerId(identity: CodexContainerIdentity): string {
  if (identity.containerId === undefined || !CONTAINER_ID_PATTERN.test(identity.containerId)) {
    throw safeError("CODEX_CONTAINER_UNAVAILABLE");
  }
  return identity.containerId;
}

function inspectionReference(identity: CodexContainerIdentity): string {
  return identity.containerId === undefined ? identity.name : immutableContainerId(identity);
}

function closeLeaseServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function acquireNamedPipeLease(signal: AbortSignal): Promise<{
  release(): Promise<void>;
} | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolveLease) => {
    const server = createServer((socket) => socket.destroy());
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      server.close(() => resolveLease(undefined));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    server.once("error", () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveLease(undefined);
    });
    server.listen({ path: HOST_LEASE_PIPE, exclusive: true }, () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      let released = false;
      resolveLease(Object.freeze({
        async release(): Promise<void> {
          if (released) return;
          released = true;
          await closeLeaseServer(server);
        },
      }));
    });
  });
}

function createDockerController(dockerExecutable: string): CodexDockerController {
  const env = helperEnvironment();
  const control = (
    args: readonly string[],
    signal: AbortSignal,
    maxStdoutBytes = 16_384,
    maxStderrBytes = 16_384,
  ) => rawDockerCommand({
    executable: dockerExecutable,
    args,
    env,
    signal,
    maxStdoutBytes,
    maxStderrBytes,
  });
  const daemonAvailable = async (): Promise<boolean> => {
    const signal = new AbortController();
    try {
      const result = await bounded(control([
        "version", "--format", "{{.Server.Version}}",
      ], signal.signal, 256, 1_024), signal);
      return result.exitCode === 0 && result.overflow === undefined;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    acquireHostLease: acquireNamedPipeLease,
    async create(request: DockerCreateRequest): Promise<DockerCreateResult> {
      const result = await rawDockerCommand({
        executable: dockerExecutable,
        args: request.args,
        env: request.env,
        signal: request.signal,
        maxStdoutBytes: request.maxStdoutBytes,
        maxStderrBytes: request.maxStderrBytes,
      });
      return {
        ...result,
        helperExitProven: result.exitCode !== null,
        completion: result.terminationInitiated ? "TERMINATED" : "NATURAL",
      };
    },
    async start(request: DockerStartRequest): Promise<DockerCommandResult> {
      const containerId = immutableContainerId(request.identity);
      return rawDockerCommand({
        executable: dockerExecutable,
        args: ["start", "--attach", "--interactive", containerId],
        stdin: request.stdin,
        env: request.env,
        signal: request.signal,
        maxStdoutBytes: request.maxStdoutBytes,
        maxStderrBytes: request.maxStderrBytes,
      });
    },
    async wait(request: DockerIdentityRequest): Promise<DockerWaitResult> {
      const containerId = immutableContainerId(request.identity);
      let leftCreatedState = false;
      for (let attempt = 0; attempt < INSPECT_RETRIES; attempt += 1) {
        if (request.signal.aborted) return { helperExitCode: null, containerExitCode: null };
        const state = await control([
          "container", "inspect", "--format", "{{.State.Status}}", containerId,
        ], request.signal, 64, 1_024);
        if (state.exitCode !== 0 || state.overflow !== undefined) {
          return { helperExitCode: state.exitCode, containerExitCode: null };
        }
        if (fatalDecode(state.stdout).trim() !== "created") {
          leftCreatedState = true;
          break;
        }
        if (!await delayUntilAbort(INSPECT_RETRY_MS, request.signal)) {
          return { helperExitCode: null, containerExitCode: null };
        }
      }
      if (!leftCreatedState) return { helperExitCode: null, containerExitCode: null };
      return parseWait(await control(["wait", containerId], request.signal, 64, 1_024));
    },
    async kill(request: DockerIdentityRequest): Promise<DockerKillResult> {
      const containerId = immutableContainerId(request.identity);
      let result = await control([
        "kill", "--signal", "KILL", containerId,
      ], request.signal, 256, 1_024);
      if (result.exitCode !== 0 && !request.signal.aborted) {
        const state = await control([
          "container", "inspect", "--format", "{{.State.Status}}", containerId,
        ], request.signal, 64, 1_024);
        if (
          state.exitCode === 0
          && state.overflow === undefined
          && fatalDecode(state.stdout).trim() === "created"
        ) {
          const started = await control([
            "start", containerId,
          ], request.signal, 256, 1_024);
          if (started.exitCode === 0 && started.overflow === undefined) {
            result = await control([
              "kill", "--signal", "KILL", containerId,
            ], request.signal, 256, 1_024);
          }
        }
      }
      return { helperExitCode: result.exitCode };
    },
    async remove(request: DockerIdentityRequest): Promise<{ readonly helperExitCode: number | null }> {
      const containerId = immutableContainerId(request.identity);
      const result = await control([
        "container", "rm", containerId,
      ], request.signal, 256, 1_024);
      return { helperExitCode: result.exitCode };
    },
    async inspect(request: DockerIdentityRequest): Promise<DockerInspectResult> {
      const reference = inspectionReference(request.identity);
      const result = await control([
        "container", "inspect", "--format",
        "{{json .Id}};{{json .Name}};{{json .Config.Image}};{{json .Config.Labels}};{{json .State.Status}};{{json .State.ExitCode}}",
        reference,
      ], request.signal, 16_384, 1_024);
      const inspection = parseInspection(result);
      if (inspection) return { daemonAvailable: true, exists: true, inspection };
      if (result.exitCode === 0) return { daemonAvailable: true, exists: true };
      if (result.overflow === undefined) {
        const stderr = fatalDecode(result.stderr).trim();
        if (
          stderr === `Error: No such container: ${reference}`
          || stderr === `Error: No such object: ${reference}`
          || stderr === `Error response from daemon: No such container: ${reference}`
        ) return { daemonAvailable: true, exists: false };
      }
      const available = await daemonAvailable();
      return { daemonAvailable: available, exists: available };
    },
    async list(request: DockerListRequest): Promise<DockerListResult> {
      const result = await control([
        "container", "ls", "--all", "--filter", `label=${request.runnerLabel}`,
        "--format", "{{.Names}}",
      ], request.signal, 16_384, 1_024);
      if (result.exitCode !== 0 || result.overflow !== undefined) {
        return { daemonAvailable: false, names: [] };
      }
      const names = fatalDecode(result.stdout).split(/\r?\n/u).filter((name) => name.length > 0);
      return { daemonAvailable: true, names: Object.freeze(names) };
    },
  });
}

function validateExecutionResult(result: CodexContainerExecutionResult): void {
  if (
    (!result.containerExitProven && !result.containerNeverCreatedProven)
    || !result.containerAbsentProven
    || result.exitCode === null
    || (result.exitCode === 125 && !result.containerNeverCreatedProven)
  ) {
    launchLocked = true;
    throw safeError("CODEX_CONTAINER_TERMINATION_UNPROVEN");
  }
}

export function isCodexContainerLaunchLocked(): boolean {
  return launchLocked;
}

export async function reconcileCodexContainers(
  options: ReconcileCodexContainersOptions,
): Promise<{ readonly reconciled: true }> {
  const image = immutableImage(options.image);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
  }
  const reconcileSignal = options.signal ?? new AbortController().signal;
  throwIfReconcileAborted(reconcileSignal);
  const ownerToken = claimAuthority("RECONCILE");
  launchLocked = true;
  try {
    if (options.resolveDockerExecutable !== undefined && options.controller === undefined) {
      throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
    }
    const controller = options.controller
      ?? createDockerController(await resolveTrustedDockerExecutable(options.dockerExecutable));
    if (options.controller !== undefined) {
      await resolveTrustedDockerExecutable(
        options.dockerExecutable,
        options.resolveDockerExecutable,
      );
    }
    throwIfReconcileAborted(reconcileSignal);
    if (!await acquireOwnerHostLease(ownerToken, controller, reconcileSignal)) {
      throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
    }
    throwIfReconcileAborted(reconcileSignal);
    if (interruptedCreate !== undefined && interruptedCreate.image !== image) {
      throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
    }
    const lookupIdentity = interruptedCreate ?? Object.freeze({
      name: CONTAINER_NAME,
      runId: "0".repeat(32),
      image,
      labels: Object.freeze({
        [RUNNER_LABEL_NAME]: RUNNER_LABEL_VALUE,
        [RUN_ID_LABEL_NAME]: "0".repeat(32),
      }),
    });
    const before = await inspectOwned(controller, lookupIdentity, reconcileSignal);
    throwIfReconcileAborted(reconcileSignal);
    if (before?.daemonAvailable !== true) {
      throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
    }
    if (!before.exists) {
      // An interrupted create can materialize after any finite absence sample.
      if (interruptedCreate !== undefined) {
        throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
      }
      launchLocked = false;
      return Object.freeze({ reconciled: true });
    }
    if (
      before.inspection === undefined
      || !runnerInspectionMatches(before.inspection, image)
    ) throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
    const identity = identityFromInspection(before.inspection);
    if (
      interruptedCreate !== undefined
      && !sameIdentity(interruptedCreate, identity)
    ) throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
    if (!await reconcileOwnedInspection(
      controller,
      identity,
      before.inspection,
      reconcileSignal,
    )) {
      throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
    }
    throwIfReconcileAborted(reconcileSignal);
    clearInterruptedCreate(identity);
    const finalLookup = await inspectOwned(controller, lookupIdentity, reconcileSignal);
    throwIfReconcileAborted(reconcileSignal);
    if (finalLookup?.daemonAvailable !== true || finalLookup.exists) {
      throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
    }
    launchLocked = false;
    return Object.freeze({ reconciled: true });
  } catch {
    throw safeError("CODEX_CONTAINER_RECONCILIATION_FAILED");
  } finally {
    await requestAuthorityRelease(ownerToken);
  }
}

export async function runIsolatedCodex(
  input: RunIsolatedCodexOptions,
): Promise<IsolatedCodexResult> {
  if (!ROLES.includes(input.role)) throw safeError("CODEX_ROLE_UNSUPPORTED");
  if (input.model !== undefined && input.model !== CONFIGURED_MODEL) {
    throw safeError("CODEX_MODEL_UNAVAILABLE");
  }
  if (input.authVolume !== AUTH_VOLUME) throw safeError("CODEX_AUTH_VOLUME_INVALID");
  const image = immutableImage(input.image);
  const timeoutMs = validateTimeout(input.timeoutMs);
  if (
    typeof input.prompt !== "string"
    || input.prompt.length === 0
    || byteLength(input.prompt) > MAX_STDIN_BYTES
  ) throw safeError("CODEX_INPUT_INVALID");
  if (Object.prototype.hasOwnProperty.call(input, "execute")) {
    throw safeError("CODEX_CONTAINER_CONFIGURATION_INVALID");
  }
  if (launchLocked) throw safeError("CODEX_CONTAINER_LOCKED");
  if (input.signal?.aborted) throw safeError("CODEX_ABORTED");
  if (
    input.resolveDockerExecutable !== undefined
    && input.controller === undefined
  ) throw safeError("CODEX_CONTAINER_CONFIGURATION_INVALID");

  // Run and reconciliation share this synchronous claim before their first await.
  const ownerToken = claimAuthority("RUN");
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (input.signal?.aborted) onExternalAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  try {
    const dockerExecutable = await resolveTrustedDockerExecutable(
      input.dockerExecutable,
      input.resolveDockerExecutable,
    );
    if (externallyAborted) throw safeError("CODEX_ABORTED");
    if (timedOut) throw safeError("CODEX_TIMEOUT");
    const dockerController = input.controller ?? createDockerController(dockerExecutable);
    if (!await acquireOwnerHostLease(ownerToken, dockerController, controller.signal)) {
      throw safeError("CODEX_CONTAINER_BUSY");
    }
    const identity = createIdentity(image);
    const request: CodexContainerExecutionRequest = Object.freeze({
      command: dockerExecutable,
      args: dockerArguments(input.role, timeoutMs, identity),
      stdin: Buffer.from(input.prompt, "utf8"),
      env: helperEnvironment(),
      signal: controller.signal,
      identity,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
    let result: CodexContainerExecutionResult;
    let terminationUnproven = false;
    try {
      const execution = executeWithController(
        request,
        dockerController,
      );
      const aborted = new Promise<{ readonly kind: "ABORTED" }>((resolveAbort) => {
        if (request.signal.aborted) resolveAbort({ kind: "ABORTED" });
        else request.signal.addEventListener(
          "abort",
          () => resolveAbort({ kind: "ABORTED" }),
          { once: true },
        );
      });
      const first = await Promise.race([
        execution.then(
          (value) => ({ kind: "RESULT" as const, value }),
          () => ({ kind: "FAILED" as const }),
        ),
        aborted,
      ]);
      if (first.kind === "FAILED") {
        launchLocked = true;
        throw safeError("CODEX_CONTAINER_UNAVAILABLE");
      }
      if (first.kind === "ABORTED") {
        const settlementController = new AbortController();
        try {
          result = await bounded(execution, settlementController);
        } catch {
          terminationUnproven = true;
          launchLocked = true;
          throw safeError("CODEX_CONTAINER_TERMINATION_UNPROVEN");
        }
      } else {
        result = first.value;
      }
    } catch {
      if (!launchLocked) launchLocked = true;
      throw safeError(terminationUnproven
        ? "CODEX_CONTAINER_TERMINATION_UNPROVEN"
        : "CODEX_CONTAINER_UNAVAILABLE");
    }

    // A natural nonzero create with an existing exact runner container is the
    // daemon-owned singleton serializer (Docker versions vary in collision code).
    if (result.containerBusyProven) throw safeError("CODEX_CONTAINER_BUSY");
    validateExecutionResult(result);
    if (timedOut) throw safeError("CODEX_TIMEOUT");
    if (externallyAborted) throw safeError("CODEX_ABORTED");
    if (
      result.outputAfterBound
      || result.overflow !== undefined
      || result.stdout.byteLength > MAX_STDOUT_BYTES
      || result.stderr.byteLength > MAX_STDERR_BYTES
    ) throw safeError("CODEX_OUTPUT_INVALID");
    fatalDecode(result.stderr);
    if (result.exitCode !== 0) throw processFailure(result.stderr);
    return parseOutput(result.stdout);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onExternalAbort);
    await requestAuthorityRelease(ownerToken);
  }
}
