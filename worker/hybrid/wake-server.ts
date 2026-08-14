import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { acceptQStashWake } from "../../lib/server/bridge/qstash";
import { databaseFromPool } from "../../lib/server/db/postgres";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  createFinnhubHttpClient,
  pollFinnhubWindow,
} from "../../lib/server/market-data/finnhub";
import type { FinnhubHttpClient } from "../../lib/server/market-data/finnhub";
import { marketWindowStart } from "../../lib/server/market-data/session";
import { createCodexCliProvider } from "../../lib/server/models/codex-cli";
import { createModelGateway } from "../../lib/server/models/gateway";
import {
  reconcileCodexContainers,
  runIsolatedCodex,
} from "./codex-runner";
import {
  persistMarketPollWindow,
  reserveMarketPollWindow,
  runMarketPollWindow,
  writeMarketHeartbeat,
} from "./market-poller";
import {
  createHybridRuntimeController,
  runOneHybridJob,
} from "./runtime";
import type {
  HybridContainerController,
  HybridRuntimeController,
  HybridRuntimeHeartbeat,
  HybridRuntimeWake,
} from "./runtime";

const LOOPBACK_HOST = "127.0.0.1" as const;
const WAKE_PATH = "/wake" as const;
const READY_PATH = "/_gustavo/ready" as const;
const STOP_PATH = "/_gustavo/stop" as const;
const CONTROL_HEADER = "x-gustavo-worker-control" as const;
const CONTROL_CHALLENGE_HEADER = "x-gustavo-worker-challenge" as const;
const WORKER_SERVICE = "gustavo-hybrid-worker-v1" as const;
const MAX_WAKE_BODY_BYTES = 256;
const CONTROL_CHALLENGE_RETENTION_MS = 600_000;
const MAX_CONTROL_CHALLENGES = 256;
const MAX_CONTROL_STOP_TIMEOUT_MS = 25_000;
const MAX_PORT = 65_535;
const SAFE_ID = /^[A-Za-z0-9:._-]{1,200}$/u;

export interface HybridWakeLogEntry {
  readonly code:
    | "WAKE_ACCEPTED"
    | "WAKE_BODY_TOO_LARGE"
    | "WAKE_METHOD_REJECTED"
    | "WAKE_PATH_REJECTED"
    | "WAKE_REJECTED"
    | "WAKE_RUNTIME_UNAVAILABLE";
  readonly jobId?: string;
  readonly windowId?: string;
}

export interface HybridWakeServerOptions<VerifiedWake> {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly publicWakeUrl?: string;
  readonly verify: (request: Request) => Promise<VerifiedWake>;
  readonly wake: (verified: VerifiedWake) => void | Promise<void>;
  /** Keeps public wake admission closed until the host finishes recovery. */
  readonly startInStartingState?: boolean;
  readonly control?: {
    readonly nonce: string;
    readonly requestStop: (remainingMs: number) => Promise<void>;
    readonly stopTimeoutMs?: number;
  };
  readonly log?: (entry: HybridWakeLogEntry) => void;
}

export interface HybridWakeInjection {
  readonly method: string;
  readonly path: string;
  readonly body: string | Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HybridWakeResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface HybridWakeServer {
  readonly address: {
    readonly host: typeof LOOPBACK_HOST;
    readonly port: number;
  };
  inject(input: HybridWakeInjection): Promise<HybridWakeResponse>;
  markReady(): void;
  stopAdmissionAndRuntime(
    requestStop: (remainingMs: number) => Promise<void>,
    timeoutMs?: number,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface HybridWorkerHostOptions {
  readonly runtime: HybridRuntimeController;
  readonly port: number;
  readonly publicWakeUrl: string;
  readonly verify: (request: Request) => Promise<HybridRuntimeWake>;
  readonly controlNonce?: string;
  readonly onControlStop?: () => void;
  readonly stopTimeoutMs?: number;
  readonly log?: (entry: HybridWakeLogEntry) => void;
}

export interface HybridWorkerHost {
  readonly server: HybridWakeServer;
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

function validPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT) {
    throw new Error("HYBRID_WAKE_PORT_INVALID");
  }
  return port;
}

function canonicalPublicWakeUrl(value: string | undefined): string {
  const candidate = value ?? "https://127.0.0.1/wake";
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("HYBRID_WAKE_PUBLIC_URL_INVALID");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== WAKE_PATH
    || url.search !== ""
    || url.hash !== ""
    || url.href !== candidate
  ) {
    throw new Error("HYBRID_WAKE_PUBLIC_URL_INVALID");
  }
  return candidate;
}

function headerRecord(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, raw] of Object.entries(headers)) {
    if (typeof raw === "string") result[name] = raw;
    else if (Array.isArray(raw)) result[name] = raw.join(", ");
  }
  return result;
}

function requestHeaders(headers: Readonly<Record<string, string>>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) result.append(name, value);
  return result;
}

function safeLogIdentity(value: unknown): Pick<HybridWakeLogEntry, "jobId" | "windowId"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as Readonly<Record<string, unknown>>;
  if (typeof candidate.jobId === "string" && SAFE_ID.test(candidate.jobId)) {
    return { jobId: candidate.jobId };
  }
  if (typeof candidate.windowId === "string" && SAFE_ID.test(candidate.windowId)) {
    return { windowId: candidate.windowId };
  }
  return {};
}

function byteBody(value: string | Uint8Array): Uint8Array {
  return typeof value === "string"
    ? new TextEncoder().encode(value)
    : value.slice();
}

function declaredLength(headers: Readonly<Record<string, string>>): number | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-length");
  if (!entry) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(entry[1])) return Number.NaN;
  return Number(entry[1]);
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function validControlNonce(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("HYBRID_CONTROL_NONCE_INVALID");
  }
  return value;
}

function validControlStopTimeout(value: number | undefined): number {
  const timeout = value ?? MAX_CONTROL_STOP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CONTROL_STOP_TIMEOUT_MS) {
    throw new Error("HYBRID_CONTROL_STOP_TIMEOUT_INVALID");
  }
  return timeout;
}

type DeadlineOutcome = "RESOLVED" | "REJECTED" | "TIMEOUT";

function settleBeforeDeadline(work: Promise<unknown>, deadline: number): Promise<DeadlineOutcome> {
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs < 1) return Promise.resolve("TIMEOUT");
  return new Promise<DeadlineOutcome>((resolveOutcome) => {
    let settled = false;
    const finish = (outcome: DeadlineOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };
    const timer = setTimeout(() => finish("TIMEOUT"), remainingMs);
    timer.unref?.();
    void work.then(
      () => finish("RESOLVED"),
      () => finish("REJECTED"),
    );
  });
}

function controlTag(
  nonce: string,
  domain: "request" | "response",
  method: string,
  path: string,
  challenge: string,
): string {
  return createHmac("sha256", nonce)
    .update(`${domain}\n${method}\n${path}\n${challenge}`, "utf8")
    .digest("base64url");
}

function controlAuthorized(
  headers: Readonly<Record<string, string>>,
  expected: string,
  method: string,
  path: string,
): string | undefined {
  const challenge = headerValue(headers, CONTROL_CHALLENGE_HEADER);
  const supplied = headerValue(headers, CONTROL_HEADER);
  if (!challenge || !supplied
    || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
    || !/^[A-Za-z0-9_-]{43}$/u.test(supplied)) return undefined;
  const expectedTag = controlTag(expected, "request", method, path, challenge);
  return timingSafeEqual(Buffer.from(supplied, "utf8"), Buffer.from(expectedTag, "utf8"))
    ? challenge
    : undefined;
}

async function readBoundedBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const length = declaredLength(headerRecord(request.headers));
  if (length !== undefined && (!Number.isSafeInteger(length) || length > MAX_WAKE_BODY_BYTES)) {
    request.resume();
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw);
    if (chunk.byteLength > MAX_WAKE_BODY_BYTES - size) {
      request.destroy();
      return undefined;
    }
    chunks.push(chunk.slice());
    size += chunk.byteLength;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function send(response: ServerResponse, result: HybridWakeResponse): void {
  response.statusCode = result.statusCode;
  response.setHeader(
    "content-type",
    result.body.startsWith("{") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
  );
  response.setHeader("cache-control", "no-store");
  response.end(result.body);
}

export async function startHybridWakeServer<VerifiedWake>(
  options: HybridWakeServerOptions<VerifiedWake>,
): Promise<HybridWakeServer> {
  if (!options || options.host !== LOOPBACK_HOST) {
    throw new Error("HYBRID_WAKE_HOST_INVALID");
  }
  const port = validPort(options.port);
  if (typeof options.verify !== "function" || typeof options.wake !== "function") {
    throw new Error("HYBRID_WAKE_CONFIG_INVALID");
  }
  const publicWakeUrl = canonicalPublicWakeUrl(options.publicWakeUrl);
  const control = options.control === undefined ? undefined : Object.freeze({
    nonce: validControlNonce(options.control.nonce),
    requestStop: options.control.requestStop,
    stopTimeoutMs: validControlStopTimeout(options.control.stopTimeoutMs),
  });
  if (control && typeof control.requestStop !== "function") {
    throw new Error("HYBRID_WAKE_CONFIG_INVALID");
  }
  let wakeAccepting = options.startInStartingState !== true;
  let readinessState: "STARTING" | "READY" = wakeAccepting ? "READY" : "STARTING";
  let shutdownStarted = false;
  const usedControlChallenges = new Map<string, number>();
  const admittedWakes = new Set<Promise<void>>();

  const pruneControlChallenges = (now: number): void => {
    for (const [challenge, expiresAt] of usedControlChallenges) {
      if (expiresAt <= now) usedControlChallenges.delete(challenge);
    }
  };

  const registerWakeAdmission = (): (() => void) => {
    let settle!: () => void;
    const admission = new Promise<void>((resolveAdmission) => {
      settle = resolveAdmission;
    });
    admittedWakes.add(admission);
    return () => {
      admittedWakes.delete(admission);
      settle();
    };
  };

  let stopAuthorityPromise: Promise<void> | undefined;
  const stopAdmissionAndRuntime = (
    requestStop: (remainingMs: number) => Promise<void>,
    timeoutMs = MAX_CONTROL_STOP_TIMEOUT_MS,
  ): Promise<void> => {
    if (typeof requestStop !== "function") {
      return Promise.reject(new Error("HYBRID_STOP_AUTHORITY_INVALID"));
    }
    let exactTimeout: number;
    try {
      exactTimeout = validControlStopTimeout(timeoutMs);
    } catch {
      return Promise.reject(new Error("HYBRID_STOP_AUTHORITY_INVALID"));
    }
    wakeAccepting = false;
    shutdownStarted = true;
    if (stopAuthorityPromise) return stopAuthorityPromise;
    const deadline = performance.now() + exactTimeout;
    const attempt = (async () => {
      try {
        const admissions = Promise.all([...admittedWakes]);
        if (await settleBeforeDeadline(admissions, deadline) !== "RESOLVED") {
          throw new Error("HYBRID_STOP_UNPROVEN");
        }
        const remainingMs = Math.floor(deadline - performance.now());
        if (remainingMs < 1) throw new Error("HYBRID_STOP_UNPROVEN");
        const stopWork = requestStop(remainingMs);
        if (await settleBeforeDeadline(stopWork, deadline) !== "RESOLVED") {
          throw new Error("HYBRID_STOP_UNPROVEN");
        }
      } catch {
        throw new Error("HYBRID_STOP_UNPROVEN");
      }
    })();
    stopAuthorityPromise = attempt;
    void attempt.catch(() => {
      if (stopAuthorityPromise === attempt) stopAuthorityPromise = undefined;
    });
    return attempt;
  };

  const handle = async (input: HybridWakeInjection): Promise<HybridWakeResponse> => {
    if (input.path === READY_PATH || input.path === STOP_PATH) {
      const expectedMethod = input.path === READY_PATH ? "GET" : "POST";
      const body = byteBody(input.body);
      if (input.method !== expectedMethod || body.byteLength !== 0) {
        return Object.freeze({ statusCode: 405, body: "CONTROL_REJECTED" });
      }
      const challenge = control
        ? controlAuthorized(input.headers, control.nonce, input.method, input.path)
        : undefined;
      const challengeNow = performance.now();
      pruneControlChallenges(challengeNow);
      if (!control || !challenge || usedControlChallenges.has(challenge)
        || usedControlChallenges.size >= MAX_CONTROL_CHALLENGES) {
        return Object.freeze({ statusCode: 401, body: "CONTROL_REJECTED" });
      }
      usedControlChallenges.set(
        challenge,
        input.path === STOP_PATH
          ? Number.POSITIVE_INFINITY
          : challengeNow + CONTROL_CHALLENGE_RETENTION_MS,
      );
      if (input.path === READY_PATH) {
        return Object.freeze({
          statusCode: 200,
          body: JSON.stringify({
            service: WORKER_SERVICE,
            state: readinessState,
            proof: controlTag(control.nonce, "response", input.method, input.path, challenge),
          }),
        });
      }
      try {
        await stopAdmissionAndRuntime(control.requestStop, control.stopTimeoutMs);
        return Object.freeze({
          statusCode: 200,
          body: JSON.stringify({
            service: WORKER_SERVICE,
            stopped: true,
            containerAbsent: true,
            proof: controlTag(control.nonce, "response", input.method, input.path, challenge),
          }),
        });
      } catch {
        return Object.freeze({ statusCode: 503, body: "CONTROL_STOP_UNPROVEN" });
      }
    }
    if (input.path !== WAKE_PATH) {
      options.log?.(Object.freeze({ code: "WAKE_PATH_REJECTED" }));
      return Object.freeze({ statusCode: 404, body: "NOT_FOUND" });
    }
    if (input.method !== "POST") {
      options.log?.(Object.freeze({ code: "WAKE_METHOD_REJECTED" }));
      return Object.freeze({ statusCode: 405, body: "METHOD_NOT_ALLOWED" });
    }
    if (!wakeAccepting) {
      return Object.freeze({ statusCode: 503, body: "WAKE_UNAVAILABLE" });
    }
    const body = byteBody(input.body);
    const length = declaredLength(input.headers);
    if (
      body.byteLength > MAX_WAKE_BODY_BYTES
      || length !== undefined
        && (!Number.isSafeInteger(length) || length !== body.byteLength)
    ) {
      options.log?.(Object.freeze({ code: "WAKE_BODY_TOO_LARGE" }));
      return Object.freeze({ statusCode: 413, body: "WAKE_BODY_TOO_LARGE" });
    }
    const settleAdmission = registerWakeAdmission();
    try {
      let verified: VerifiedWake;
      try {
        const requestBody = new ArrayBuffer(body.byteLength);
        new Uint8Array(requestBody).set(body);
        verified = await options.verify(new Request(publicWakeUrl, {
          method: "POST",
          headers: requestHeaders(input.headers),
          body: requestBody,
        }));
      } catch {
        options.log?.(Object.freeze({ code: "WAKE_REJECTED" }));
        return Object.freeze({ statusCode: 401, body: "WAKE_REJECTED" });
      }
      let work: void | Promise<void>;
      try {
        work = options.wake(verified);
      } catch {
        options.log?.(Object.freeze({
          code: "WAKE_RUNTIME_UNAVAILABLE",
          ...safeLogIdentity(verified),
        }));
        return Object.freeze({ statusCode: 503, body: "WAKE_UNAVAILABLE" });
      }
      void Promise.resolve(work).catch(() => {
        options.log?.(Object.freeze({
          code: "WAKE_RUNTIME_UNAVAILABLE",
          ...safeLogIdentity(verified),
        }));
      });
      options.log?.(Object.freeze({
        code: "WAKE_ACCEPTED",
        ...safeLogIdentity(verified),
      }));
      return Object.freeze({ statusCode: 202, body: "WAKE_ACCEPTED" });
    } finally {
      settleAdmission();
    }
  };

  let httpServer!: Server;
  httpServer = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "";
      const method = request.method ?? "";
      if (!([WAKE_PATH, READY_PATH, STOP_PATH] as readonly string[]).includes(path)
        || path === WAKE_PATH && method !== "POST"
        || path === READY_PATH && method !== "GET"
        || path === STOP_PATH && method !== "POST") {
        send(response, await handle({
          method,
          path,
          body: new Uint8Array(0),
          headers: headerRecord(request.headers),
        }));
        request.resume();
        return;
      }
      const body = await readBoundedBody(request);
      if (!body) {
        options.log?.(Object.freeze({ code: "WAKE_BODY_TOO_LARGE" }));
        if (!response.destroyed) send(response, { statusCode: 413, body: "WAKE_BODY_TOO_LARGE" });
        return;
      }
      send(response, await handle({
        method,
        path,
        body,
        headers: headerRecord(request.headers),
      }));
    })().catch(() => {
      if (!response.destroyed) send(response, { statusCode: 503, body: "WAKE_UNAVAILABLE" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, LOOPBACK_HOST);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    throw new Error("HYBRID_WAKE_BIND_INVALID");
  }

  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    address: Object.freeze({ host: LOOPBACK_HOST, port: address.port }),
    inject: handle,
    markReady(): void {
      if (shutdownStarted) throw new Error("HYBRID_WAKE_STOPPED");
      readinessState = "READY";
      wakeAccepting = true;
    },
    stopAdmissionAndRuntime,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      wakeAccepting = false;
      shutdownStarted = true;
      httpServer.closeIdleConnections();
      httpServer.closeAllConnections();
      stopPromise = new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
      return stopPromise;
    },
  });
}

/** Binds authenticated control first; public wake admission opens after recovery. */
export async function startHybridWorkerHost(
  options: HybridWorkerHostOptions,
): Promise<HybridWorkerHost> {
  if (!options || !options.runtime || typeof options.runtime.start !== "function"
    || typeof options.runtime.enqueue !== "function" || typeof options.runtime.stop !== "function") {
    throw new Error("HYBRID_HOST_CONFIG_INVALID");
  }
  let stopTimeoutMs: number;
  try {
    stopTimeoutMs = validControlStopTimeout(options.stopTimeoutMs);
  } catch {
    throw new Error("HYBRID_HOST_CONFIG_INVALID");
  }
  const stopRuntime = (remainingMs: number) => options.runtime.stop(remainingMs);
  let server: HybridWakeServer;
  try {
    server = await startHybridWakeServer({
      host: LOOPBACK_HOST,
      port: options.port,
      publicWakeUrl: options.publicWakeUrl,
      verify: options.verify,
      wake: (verified) => options.runtime.enqueue(verified),
      startInStartingState: true,
      ...(options.controlNonce ? {
        control: {
          nonce: options.controlNonce,
          requestStop: async (remainingMs) => {
            await stopRuntime(remainingMs);
            if (options.onControlStop) setImmediate(options.onControlStop);
          },
          stopTimeoutMs,
        },
      } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  } catch (error) {
    throw error;
  }
  const ready = options.runtime.start().then(() => {
    server.markReady();
  }, () => {
    throw new Error("HYBRID_RUNTIME_START_FAILED");
  });
  // The host owns this rejection through `ready`; suppress process-level
  // unhandled-rejection handling while authenticated control remains usable.
  void ready.catch(() => undefined);
  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    server,
    ready,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      const attempt = (async () => {
        try {
          await server.stopAdmissionAndRuntime(stopRuntime, stopTimeoutMs);
        } catch {
          throw new Error("HYBRID_HOST_STOP_UNPROVEN");
        }
        try {
          await server.stop();
        } catch {
          throw new Error("HYBRID_WAKE_STOP_FAILED");
        }
      })();
      stopPromise = attempt;
      void attempt.catch(() => {
        if (stopPromise === attempt) stopPromise = undefined;
      });
      return attempt;
    },
  });
}

const AUTH_VOLUME = "gustavo-codex-auth-v1" as const;
const CODEX_IMAGE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_RECOVERY_WINDOWS = 2_016;
const SAFE_WORKER_ID = "gustavo-hybrid-worker-v1" as const;

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export interface ConfiguredHybridDatabaseLifecycleInput {
  readonly applicationName: string;
  readonly connectionString: string;
  readonly transaction: boolean;
}

export type ConfiguredHybridDatabaseLifecycle = <Result>(
  input: ConfiguredHybridDatabaseLifecycleInput,
  work: (database: EventDatabase) => Promise<Result>,
) => Promise<Result>;

export interface ConfiguredHybridMarketClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly wallNow: () => number;
}

export interface ConfiguredHybridWorkerDependencies {
  readonly createFinnhubClient?: () => FinnhubHttpClient;
  readonly createMarketClock?: (signal: AbortSignal) => ConfiguredHybridMarketClock;
  readonly databaseLifecycle?: ConfiguredHybridDatabaseLifecycle;
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (entry: HybridWakeLogEntry) => void;
  readonly onControlStop?: () => void;
  readonly reconcileCodex?: typeof reconcileCodexContainers;
  readonly runCodex?: typeof runIsolatedCodex;
  readonly runDockerCommand?: (
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
  ) => Promise<CommandResult>;
  readonly startHost?: (
    options: HybridWorkerHostOptions,
  ) => Promise<HybridWorkerHost>;
}

export interface ConfiguredHybridWorkerAssembly {
  readonly controlStopped: Promise<void>;
  readonly runtime: HybridRuntimeController;
  readonly verify: (request: Request) => Promise<HybridRuntimeWake>;
  start(): Promise<HybridWorkerHost>;
}

function requiredEnvironment(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment[name];
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new Error("HYBRID_ENVIRONMENT_INVALID");
  }
  return value;
}

function configuredPort(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = requiredEnvironment("GUSTAVO_HYBRID_PORT", environment);
  if (!/^[0-9]{4,5}$/u.test(raw)) throw new Error("HYBRID_ENVIRONMENT_INVALID");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > MAX_PORT) {
    throw new Error("HYBRID_ENVIRONMENT_INVALID");
  }
  return port;
}

function pooledDatabase(connectionString: string, applicationName: string): Pool {
  if (!/^postgres(?:ql)?:\/\//u.test(connectionString)) {
    throw new Error("HYBRID_DATABASE_URL_INVALID");
  }
  return new Pool({
    connectionString,
    application_name: applicationName,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
  });
}

async function withFreshDatabase<Result>(
  connectionString: string,
  applicationName: string,
  work: (database: EventDatabase) => Promise<Result>,
): Promise<Result> {
  const pool = pooledDatabase(connectionString, applicationName);
  try {
    return await work(databaseFromPool(pool));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const configuredDatabaseLifecycle: ConfiguredHybridDatabaseLifecycle = async (
  input,
  work,
) => withFreshDatabase(input.connectionString, input.applicationName, (database) => (
  input.transaction ? database.transaction(work) : work(database)
));

function runCommand(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    if (signal.aborted) {
      resolveCommand({ exitCode: null, stdout: "" });
      return;
    }
    const child = spawn(executable, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      signal,
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 4_096) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => resolveCommand({ exitCode: null, stdout: "" }));
    child.once("close", (exitCode) => resolveCommand({
      exitCode: overflow ? null : exitCode,
      stdout: overflow ? "" : Buffer.concat(chunks).toString("utf8").trim(),
    }));
  });
}

interface MaterializerRoleAuthority {
  readonly ordinary: { readonly member: boolean };
  readonly login: {
    readonly currentUser: string;
    readonly member: boolean;
    readonly login: boolean;
    readonly inherit: boolean;
    readonly superuser: boolean;
    readonly createdb: boolean;
    readonly createrole: boolean;
    readonly replication: boolean;
    readonly bypassrls: boolean;
    readonly otherMemberships: number;
  };
  readonly permission: {
    readonly login: boolean;
    readonly inherit: boolean;
    readonly superuser: boolean;
    readonly createdb: boolean;
    readonly createrole: boolean;
    readonly replication: boolean;
    readonly bypassrls: boolean;
    readonly otherMemberships: number;
    readonly memberCount: number;
  };
}

export function validateMaterializerRoleAuthority(input: unknown): boolean {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const authority = input as MaterializerRoleAuthority;
    const { ordinary, login, permission } = authority;
    return ordinary?.member === false
      && typeof login?.currentUser === "string"
      && login.currentUser !== "gustavo_market_materializer"
      && login.member === true && login.login === true && login.inherit === true
      && login.superuser === false && login.createdb === false
      && login.createrole === false && login.replication === false
      && login.bypassrls === false && login.otherMemberships === 0
      && permission?.login === false && permission.inherit === false
      && permission.superuser === false && permission.createdb === false
      && permission.createrole === false && permission.replication === false
      && permission.bypassrls === false && permission.otherMemberships === 0
      && permission.memberCount === 1;
  } catch {
    return false;
  }
}

async function verifyMaterializerDatabase(
  ordinaryUrl: string,
  materializerUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || ordinaryUrl === materializerUrl) return false;
  const ordinary = pooledDatabase(ordinaryUrl, "gustavo-hybrid-role-check-ordinary");
  const materializer = pooledDatabase(materializerUrl, "gustavo-hybrid-role-check-materializer");
  try {
    const ordinaryRows = await databaseFromPool(ordinary).transaction((database) => (
      database.query<{
        readonly member: boolean;
      } & Record<string, unknown>>(
        "select pg_has_role(current_user,'gustavo_market_materializer','MEMBER') member",
      )
    ));
    const scopedRows = await databaseFromPool(materializer).transaction((database) => (
      database.query<{
      readonly currentUser: string;
      readonly member: boolean;
      readonly login: boolean;
      readonly inherit: boolean;
      readonly superuser: boolean;
      readonly createdb: boolean;
      readonly createrole: boolean;
      readonly replication: boolean;
      readonly bypassrls: boolean;
      readonly permissionLogin: boolean;
      readonly permissionInherit: boolean;
      readonly permissionSuperuser: boolean;
      readonly permissionCreatedb: boolean;
      readonly permissionCreaterole: boolean;
      readonly permissionReplication: boolean;
      readonly permissionBypassrls: boolean;
      readonly loginOtherMemberships: number;
      readonly permissionOtherMemberships: number;
      readonly permissionMemberCount: number;
      } & Record<string, unknown>>(
        `select current_user "currentUser",
              pg_has_role(current_user,'gustavo_market_materializer','MEMBER') member,
              login.rolcanlogin login,login.rolinherit inherit,
              login.rolsuper superuser,login.rolcreatedb createdb,
              login.rolcreaterole createrole,login.rolreplication replication,
              login.rolbypassrls bypassrls,
              permission.rolcanlogin "permissionLogin",
              permission.rolinherit "permissionInherit",
              permission.rolsuper "permissionSuperuser",
              permission.rolcreatedb "permissionCreatedb",
              permission.rolcreaterole "permissionCreaterole",
              permission.rolreplication "permissionReplication",
              permission.rolbypassrls "permissionBypassrls",
              (select count(*)::int from pg_auth_members membership
                join pg_roles granted on granted.oid=membership.roleid
               where membership.member=login.oid
                 and granted.rolname<>'gustavo_market_materializer') "loginOtherMemberships",
               (select count(*)::int from pg_auth_members membership
                where membership.member=permission.oid) "permissionOtherMemberships",
              (select count(*)::int from pg_auth_members membership
                where membership.roleid=permission.oid) "permissionMemberCount"
         from pg_roles login cross join pg_roles permission
        where login.rolname=current_user
          and permission.rolname='gustavo_market_materializer'`,
      )
    ));
    const row = scopedRows[0];
    return !signal.aborted && ordinaryRows.length === 1
      && scopedRows.length === 1
      && row !== undefined
      && validateMaterializerRoleAuthority({
        ordinary: ordinaryRows[0],
        login: {
          currentUser: row.currentUser,
          member: row.member,
          login: row.login,
          inherit: row.inherit,
          superuser: row.superuser,
          createdb: row.createdb,
          createrole: row.createrole,
          replication: row.replication,
          bypassrls: row.bypassrls,
          otherMemberships: row.loginOtherMemberships,
        },
        permission: {
          login: row.permissionLogin,
          inherit: row.permissionInherit,
          superuser: row.permissionSuperuser,
          createdb: row.permissionCreatedb,
          createrole: row.permissionCreaterole,
          replication: row.permissionReplication,
          bypassrls: row.permissionBypassrls,
          otherMemberships: row.permissionOtherMemberships,
          memberCount: row.permissionMemberCount,
        },
      });
  } catch {
    return false;
  } finally {
    await Promise.allSettled([ordinary.end(), materializer.end()]);
  }
}

async function writeRuntimeHeartbeat(
  databaseUrl: string,
  heartbeat: HybridRuntimeHeartbeat,
  signal: AbortSignal,
  databaseLifecycle: ConfiguredHybridDatabaseLifecycle = configuredDatabaseLifecycle,
): Promise<void> {
  if (signal.aborted) throw new Error("HYBRID_HEARTBEAT_ABORTED");
  await databaseLifecycle({
    connectionString: databaseUrl,
    applicationName: "gustavo-hybrid-heartbeat",
    transaction: true,
  }, async (transaction) => {
      if (signal.aborted) throw new Error("HYBRID_HEARTBEAT_ABORTED");
      await transaction.query(
        `insert into hybrid_worker_heartbeats (component,status,safe_code)
         values ($1,$2,$3)
         on conflict (component) do update
           set status=excluded.status,safe_code=excluded.safe_code,
               observed_at=clock_timestamp(),updated_at=clock_timestamp()`,
        [heartbeat.component, heartbeat.status, heartbeat.safeCode],
      );
  });
}

export async function deriveDatabaseCurrentMarketWindow(
  database: EventDatabase,
): Promise<string> {
  const row = await database.one<{ readonly windowId: string } & Record<string, unknown>>(
    `select to_char(
       date_bin(
         interval '5 minutes',market_poll_reservation_now(),
         timestamptz '1970-01-01 00:00:00+00'
       ) at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI"Z"'
     ) "windowId"`,
  );
  marketWindowStart(row.windowId);
  return row.windowId;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("MARKET_POLL_ABORTED"));
  return new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("MARKET_POLL_ABORTED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function safeWorkerLog(entry: HybridWakeLogEntry): void {
  const identity = entry.jobId
    ? { jobId: entry.jobId }
    : entry.windowId ? { windowId: entry.windowId } : {};
  process.stdout.write(`${JSON.stringify({ code: entry.code, ...identity })}\n`);
}

/** Shared production composition; tests may replace only transport and lifecycle boundaries. */
export function createConfiguredHybridWorkerAssembly(
  dependencies: ConfiguredHybridWorkerDependencies = {},
): ConfiguredHybridWorkerAssembly {
  const environment = dependencies.environment ?? process.env;
  const databaseUrl = requiredEnvironment("DATABASE_URL", environment);
  const materializerUrl = requiredEnvironment(
    "GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL",
    environment,
  );
  const image = requiredEnvironment("GUSTAVO_HYBRID_IMAGE_DIGEST", environment);
  const dockerExecutable = requiredEnvironment("GUSTAVO_DOCKER_EXECUTABLE", environment);
  const publicWakeUrl = canonicalPublicWakeUrl(
    requiredEnvironment("GUSTAVO_HYBRID_PUBLIC_WAKE_URL", environment),
  );
  const currentSigningKey = requiredEnvironment("QSTASH_CURRENT_SIGNING_KEY", environment);
  const nextSigningKey = requiredEnvironment("QSTASH_NEXT_SIGNING_KEY", environment);
  const controlNonce = validControlNonce(requiredEnvironment(
    "GUSTAVO_HYBRID_CONTROL_NONCE",
    environment,
  ));
  if (!CODEX_IMAGE_PATTERN.test(image) || !isAbsolute(dockerExecutable)) {
    throw new Error("HYBRID_ENVIRONMENT_INVALID");
  }
  const databaseLifecycle = dependencies.databaseLifecycle ?? configuredDatabaseLifecycle;
  const dockerCommand = dependencies.runDockerCommand ?? runCommand;
  const reconcileCodex = dependencies.reconcileCodex ?? reconcileCodexContainers;
  const runCodex = dependencies.runCodex ?? runIsolatedCodex;
  const createFinnhubClient = dependencies.createFinnhubClient ?? createFinnhubHttpClient;
  const createMarketClock = dependencies.createMarketClock ?? ((signal: AbortSignal) => ({
    sleep: (milliseconds: number) => abortableSleep(milliseconds, signal),
    now: Date.now,
    wallNow: Date.now,
  }));
  const startHost = dependencies.startHost ?? startHybridWorkerHost;
  const log = dependencies.log ?? safeWorkerLog;

  let absenceProvenByLeasedReconcile = false;
  const container: HybridContainerController = Object.freeze({
    async verifyReady(signal: AbortSignal): Promise<void> {
      const daemon = await dockerCommand(dockerExecutable, ["version", "--format", "{{.Server.Version}}"], signal);
      const inspected = await dockerCommand(
        dockerExecutable, ["image", "inspect", "--format", "{{.Id}}", image], signal,
      );
      const volume = await dockerCommand(
        dockerExecutable, ["volume", "inspect", "--format", "{{.Name}}", AUTH_VOLUME], signal,
      );
      if (daemon.exitCode !== 0 || daemon.stdout.length === 0
        || inspected.exitCode !== 0 || inspected.stdout !== image
        || volume.exitCode !== 0 || volume.stdout !== AUTH_VOLUME) {
        throw new Error("CODEX_CONTAINER_UNAVAILABLE");
      }
    },
    async reconcile(signal: AbortSignal): Promise<void> {
      absenceProvenByLeasedReconcile = false;
      await reconcileCodex({ image, dockerExecutable, signal });
      absenceProvenByLeasedReconcile = true;
    },
    async stop(signal: AbortSignal): Promise<void> {
      absenceProvenByLeasedReconcile = false;
      await reconcileCodex({ image, dockerExecutable, signal });
      absenceProvenByLeasedReconcile = true;
    },
    async proveAbsent(signal: AbortSignal): Promise<boolean> {
      return !signal.aborted && absenceProvenByLeasedReconcile;
    },
  });

  const withOrdinaryDatabase = <Result>(
    work: (database: EventDatabase) => Promise<Result>,
  ) => databaseLifecycle({
    connectionString: databaseUrl,
    applicationName: "gustavo-hybrid-market",
    transaction: true,
  }, work);

  const pollWindow = async (windowId: string, signal: AbortSignal): Promise<void> => {
    const client = createFinnhubClient();
    const clock = createMarketClock(signal);
    await runMarketPollWindow({
      withDatabase: withOrdinaryDatabase,
      reserve: (database) => reserveMarketPollWindow(database, windowId),
      poll: async (reservedWindowId) => {
        const result = await pollFinnhubWindow({
          fetchMarketStatus: (requestSignal) => client.fetchMarketStatus(
            AbortSignal.any([signal, requestSignal]),
          ),
          fetchQuote: (symbol, requestSignal) => client.fetchQuote(
            symbol, AbortSignal.any([signal, requestSignal]),
          ),
          sleep: clock.sleep,
          now: clock.now,
          wallNow: clock.wallNow,
          timeoutMs: 2_500,
        });
        if (signal.aborted) throw new Error("MARKET_POLL_ABORTED");
        return Object.freeze({ windowId: reservedWindowId, ...result });
      },
      store: async (database, window) => {
        if (signal.aborted) throw new Error("MARKET_POLL_ABORTED");
        const accounts = await database.query<{ readonly accountId: string } & Record<string, unknown>>(
          `select id::text "accountId" from accounts
            where status='ACTIVE' order by created_at,id limit 2 for share`,
        );
        if (accounts.length !== 1) throw new Error("HYBRID_OPERATOR_ACCOUNT_INVALID");
        return persistMarketPollWindow(database, accounts[0]!.accountId, window);
      },
      heartbeat: writeMarketHeartbeat,
    });
  };

  const recoverMarket = async (signal: AbortSignal): Promise<void> => {
    const priorWindows = await withOrdinaryDatabase((database) => database.query<{
      readonly windowId: string;
    } & Record<string, unknown>>(
      `select window_id "windowId" from market_poll_windows
        where status='PENDING'
          and window_started_at<date_bin(
            interval '5 minutes',clock_timestamp(),
            timestamptz '1970-01-01 00:00:00+00'
          )
        order by window_started_at,window_id limit $1`,
      [MAX_RECOVERY_WINDOWS + 1],
    ));
    if (priorWindows.length > MAX_RECOVERY_WINDOWS) {
      throw new Error("MARKET_RECOVERY_BOUND_EXCEEDED");
    }
    for (const row of priorWindows) {
      if (signal.aborted) throw new Error("MARKET_RECOVERY_ABORTED");
      await pollWindow(row.windowId, signal);
    }
  };

  const drainModel = async (signal: AbortSignal): Promise<void> => {
    await databaseLifecycle({
      connectionString: databaseUrl,
      applicationName: "gustavo-hybrid-model",
      transaction: false,
    }, async (database) => {
      const provider = createCodexCliProvider({
        model: "gpt-5.6-sol",
        run: (request) => runCodex({
          role: request.role,
          prompt: request.prompt,
          image,
          authVolume: AUTH_VOLUME,
          timeoutMs: request.timeoutMs,
          dockerExecutable,
          model: request.model,
          signal: request.signal,
        }),
      });
      const roleConfig = Object.freeze({
        providerId: "codex-cli",
        modelId: "gpt-5.6-sol",
        monthlyBudgetUsd: "0.00",
        maxInputTokens: 65_536,
        maxOutputTokens: 32_768,
      });
      const gateway = createModelGateway(database, provider, {
        roleConfigs: Object.freeze({
          NODE: roleConfig,
          EVALUATOR: roleConfig,
          MAIN: roleConfig,
        }),
      });
      for (let count = 0; count < 100 && !signal.aborted; count += 1) {
        const result = await runOneHybridJob({
          db: database,
          workerId: SAFE_WORKER_ID,
          generate: (request) => gateway.generate({ ...request, signal }),
        });
        if (result.status === "IDLE") return;
      }
    });
  };

  const runtime = createHybridRuntimeController({
    container,
    recoverMarket,
    drainModel,
    pollMarket: pollWindow,
    deriveCurrentMarketWindow: async (signal) => {
      if (signal.aborted) throw new Error("MARKET_POLL_ABORTED");
      const windowId = await databaseLifecycle({
        connectionString: databaseUrl,
        applicationName: "gustavo-hybrid-market-window",
        transaction: true,
      }, deriveDatabaseCurrentMarketWindow);
      if (signal.aborted) throw new Error("MARKET_POLL_ABORTED");
      return windowId;
    },
    closeResources: async () => undefined,
    verifyMarketMaterializer: (signal) => verifyMaterializerDatabase(
      databaseUrl, materializerUrl, signal,
    ),
    heartbeat: (heartbeat, signal) => writeRuntimeHeartbeat(
      databaseUrl, heartbeat, signal, databaseLifecycle,
    ),
  });
  const verify = async (request: Request): Promise<HybridRuntimeWake> => {
    let verifiedWake: HybridRuntimeWake | undefined;
    await databaseLifecycle({
      connectionString: databaseUrl,
      applicationName: "gustavo-hybrid-wake",
      transaction: false,
    }, (database) => (
      acceptQStashWake(request, {
        database,
        expectedUrl: publicWakeUrl,
        now: new Date(),
        currentSigningKey,
        nextSigningKey,
        wake(message) {
          verifiedWake = message;
        },
      })
    ));
    if (!verifiedWake) throw new Error("HYBRID_WAKE_VERIFICATION_INVALID");
    return verifiedWake;
  };
  let controlStopResolve!: () => void;
  const controlStop = new Promise<void>((resolveStop) => {
    controlStopResolve = resolveStop;
  });
  let hostPromise: Promise<HybridWorkerHost> | undefined;
  return Object.freeze({
    runtime,
    verify,
    controlStopped: controlStop,
    start(): Promise<HybridWorkerHost> {
      hostPromise ??= startHost({
        runtime,
        port: configuredPort(environment),
        publicWakeUrl,
        verify,
        controlNonce,
        onControlStop: () => {
          controlStopResolve();
          dependencies.onControlStop?.();
        },
        log,
      });
      return hostPromise;
    },
  });
}

/** Production entrypoint used only by the dedicated local Windows account. */
export async function runConfiguredHybridWorker(
  dependencies: ConfiguredHybridWorkerDependencies = {},
): Promise<void> {
  const assembly = createConfiguredHybridWorkerAssembly(dependencies);
  // Install process shutdown authority before recovery can block. The host's
  // authenticated control socket is then bound in STARTING state.
  const signalStop = new Promise<void>((resolveSignal) => {
    process.once("SIGINT", resolveSignal);
    process.once("SIGTERM", resolveSignal);
  });
  const host = await assembly.start();
  const startup = host.ready.then(
    () => "READY" as const,
    () => "FAILED" as const,
  );
  const requested = Promise.race([assembly.controlStopped, signalStop]).then(() => "STOP" as const);
  const first = await Promise.race([startup, requested]);
  if (first === "READY") await requested;
  await host.stop();
  if (first === "FAILED") await host.ready;
}

function isExecutedModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isExecutedModule()) {
  void runConfiguredHybridWorker().catch(() => {
    process.stderr.write("HYBRID_WORKER_START_FAILED\n");
    process.exitCode = 1;
  });
}
