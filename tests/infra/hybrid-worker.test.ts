import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  createHybridRuntimeController,
  type HybridContainerController,
} from "../../worker/hybrid/runtime";
import {
  reconcileCodexContainers,
  type CodexDockerController,
} from "../../worker/hybrid/codex-runner";
import {
  startHybridWakeServer,
  startHybridWorkerHost,
} from "../../worker/hybrid/wake-server";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const CONTROL_NONCE = "0123456789abcdef0123456789abcdef0123456789a";
const CONTROL_CHALLENGE = "abcdef0123456789abcdef0123456789abcdef01234";
const CONTROL_CHALLENGE_TWO = "bbcdef0123456789abcdef0123456789abcdef01234";
const CONTROL_CHALLENGE_THREE = "cbcdef0123456789abcdef0123456789abcdef01234";

function controlTag(
  domain: "request" | "response",
  method: string,
  path: string,
  challenge: string,
): string {
  return createHmac("sha256", CONTROL_NONCE)
    .update(`${domain}\n${method}\n${path}\n${challenge}`, "utf8")
    .digest("base64url");
}

function controlHeaders(
  method: string,
  path: string,
  challenge = CONTROL_CHALLENGE,
): Readonly<Record<string, string>> {
  return {
    "x-gustavo-worker-challenge": challenge,
    "x-gustavo-worker-control": controlTag("request", method, path, challenge),
  };
}

function readyContainer(
  overrides: Partial<HybridContainerController> = {},
): HybridContainerController {
  return {
    verifyReady: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    proveAbsent: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("hybrid worker host boundary", () => {
  it("binds loopback and verifies a bounded POST before wake", async () => {
    const order: string[] = [];
    const verify = vi.fn(async (_request: Request) => {
      order.push("verify");
      return { jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f" } as const;
    });
    const wake = vi.fn(async () => { order.push("wake"); });
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify,
      wake,
    });

    expect(server.address.host).toBe("127.0.0.1");
    await expect(server.inject({
      method: "POST",
      path: "/wake",
      body: "{}",
      headers: { "content-type": "application/json" },
    })).resolves.toMatchObject({ statusCode: 202 });
    expect(order).toEqual(["verify", "wake"]);
    const verifiedRequest = verify.mock.calls[0]?.[0];
    expect(verifiedRequest).toBeInstanceOf(Request);
    expect(verifiedRequest?.url).toBe("https://bridge.example.test/wake");
    await server.stop();
  });

  it("rejects non-loopback, wrong routes, oversized bodies, and failed verification", async () => {
    await expect(startHybridWakeServer({
      host: "0.0.0.0" as "127.0.0.1",
      port: 0,
      verify: vi.fn(),
      wake: vi.fn(),
    })).rejects.toThrow("HYBRID_WAKE_HOST_INVALID");

    const wake = vi.fn();
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify: vi.fn().mockRejectedValue(new Error("private verifier detail")),
      wake,
    });
    await expect(server.inject({ method: "GET", path: "/wake", body: "", headers: {} }))
      .resolves.toMatchObject({ statusCode: 405 });
    await expect(server.inject({ method: "POST", path: "/other", body: "{}", headers: {} }))
      .resolves.toMatchObject({ statusCode: 404 });
    await expect(server.inject({
      method: "POST",
      path: "/wake",
      body: "x".repeat(257),
      headers: {},
    })).resolves.toMatchObject({ statusCode: 413 });
    await expect(server.inject({ method: "POST", path: "/wake", body: "{}", headers: {} }))
      .resolves.toMatchObject({ statusCode: 401, body: "WAKE_REJECTED" });
    expect(wake).not.toHaveBeenCalled();
    await server.stop();
  });

  it("starts recovery before host acceptance and closes acceptance before runtime teardown", async () => {
    const order: string[] = [];
    const runtime = {
      start: vi.fn(async () => { order.push("runtime:start"); }),
      enqueue: vi.fn(async () => { order.push("runtime:wake"); }),
      wake: vi.fn(async () => { order.push("runtime:wake"); }),
      wakeModelDrain: vi.fn(),
      wakeMarketWindow: vi.fn(),
      stop: vi.fn(async () => { order.push("runtime:stop"); }),
      status: vi.fn(() => ({
        accepting: true,
        codexAvailable: true,
        marketMaterializationAvailable: true,
        modelActive: false,
        marketActive: false,
      })),
    };
    const host = await startHybridWorkerHost({
      runtime,
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify: vi.fn(async () => ({ jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f" } as const)),
    });
    expect(order).toEqual(["runtime:start"]);
    await host.server.inject({ method: "POST", path: "/wake", body: "{}", headers: {} });
    expect(order).toEqual(["runtime:start", "runtime:wake"]);
    await host.stop();
    expect(order.at(-1)).toBe("runtime:stop");
    await expect(host.server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    })).resolves.toMatchObject({ statusCode: 503 });
  });

  it("host stop settles an admitted valid wake before runtime teardown", async () => {
    const verifyGate = deferred();
    const order: string[] = [];
    const verify = vi.fn(async () => {
      order.push("verify:start");
      await verifyGate.promise;
      order.push("verify:end");
      return { jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f" } as const;
    });
    const runtime = {
      start: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(() => { order.push("wake:enqueue"); }),
      wake: vi.fn(),
      wakeModelDrain: vi.fn(),
      wakeMarketWindow: vi.fn(),
      stop: vi.fn(async (_remainingMs?: number) => { order.push("runtime:stop"); }),
      status: vi.fn(() => ({
        accepting: true, codexAvailable: true, marketMaterializationAvailable: true,
        modelActive: false, marketActive: false,
      })),
    };
    const host = await startHybridWorkerHost({
      runtime,
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify,
      stopTimeoutMs: 1_000,
    } as never);
    const admittedWake = host.server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    const stopping = host.stop();
    await expect(host.server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    })).resolves.toMatchObject({ statusCode: 503 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(verify).toHaveBeenCalledOnce();
    expect(runtime.stop).not.toHaveBeenCalled();

    verifyGate.resolve();
    await expect(admittedWake).resolves.toMatchObject({ statusCode: 202 });
    await stopping;
    expect(runtime.enqueue).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
    const remainingMs = runtime.stop.mock.calls[0]?.[0];
    expect(remainingMs).toEqual(expect.any(Number));
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(1_000);
    expect(order).toEqual([
      "verify:start", "verify:end", "wake:enqueue", "runtime:stop",
    ]);
  });

  it("host stop settles an admitted invalid wake without enqueue", async () => {
    const verifyGate = deferred();
    const runtime = {
      start: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
      wake: vi.fn(),
      wakeModelDrain: vi.fn(),
      wakeMarketWindow: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      status: vi.fn(() => ({
        accepting: true, codexAvailable: true, marketMaterializationAvailable: true,
        modelActive: false, marketActive: false,
      })),
    };
    const verify = vi.fn(async () => {
      await verifyGate.promise;
      throw new Error("invalid signature");
    });
    const host = await startHybridWorkerHost({
      runtime,
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify,
      stopTimeoutMs: 1_000,
    } as never);
    const admittedWake = host.server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    const stopping = host.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.stop).not.toHaveBeenCalled();
    verifyGate.resolve();

    await expect(admittedWake).resolves.toMatchObject({ statusCode: 401 });
    await stopping;
    expect(runtime.enqueue).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("host stop times out admission without runtime teardown and can retry safely", async () => {
    const verifyGate = deferred();
    const verify = vi.fn(async () => {
      await verifyGate.promise;
      return { jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f" } as const;
    });
    const runtime = {
      start: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
      wake: vi.fn(),
      wakeModelDrain: vi.fn(),
      wakeMarketWindow: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      status: vi.fn(() => ({
        accepting: true, codexAvailable: true, marketMaterializationAvailable: true,
        modelActive: false, marketActive: false,
      })),
    };
    const host = await startHybridWorkerHost({
      runtime,
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify,
      stopTimeoutMs: 20,
    } as never);
    const admittedWake = host.server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());

    await expect(host.stop()).rejects.toThrow("HYBRID_HOST_STOP_UNPROVEN");
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.enqueue).not.toHaveBeenCalled();
    await expect(host.server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    })).resolves.toMatchObject({ statusCode: 503 });
    expect(verify).toHaveBeenCalledOnce();

    verifyGate.resolve();
    await expect(admittedWake).resolves.toMatchObject({ statusCode: 202 });
    expect(runtime.enqueue).toHaveBeenCalledOnce();
    expect(runtime.stop).not.toHaveBeenCalled();
    await expect(host.stop()).resolves.toBeUndefined();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("binds authenticated STARTING control before deferred startup and opens wakes only at READY", async () => {
    const startGate = deferred();
    const verify = vi.fn(async () => ({
      jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f",
    } as const));
    const runtime = {
      start: vi.fn(async () => { await startGate.promise; }),
      enqueue: vi.fn(),
      wake: vi.fn(),
      wakeModelDrain: vi.fn(),
      wakeMarketWindow: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      status: vi.fn(() => ({
        accepting: true, codexAvailable: true, marketMaterializationAvailable: true,
        modelActive: false, marketActive: false,
      })),
    };
    const hostPromise = startHybridWorkerHost({
      runtime,
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify,
      controlNonce: CONTROL_NONCE,
    } as never);
    const hostOrBlocked = await Promise.race([
      hostPromise,
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 25)),
    ]);
    if (hostOrBlocked === "blocked") {
      startGate.resolve();
      const blockedHost = await hostPromise;
      await blockedHost.stop();
      expect(hostOrBlocked).not.toBe("blocked");
      return;
    }
    const host = hostOrBlocked;
    const starting = await host.server.inject({
      method: "GET",
      path: "/_gustavo/ready",
      body: "",
      headers: controlHeaders("GET", "/_gustavo/ready", CONTROL_CHALLENGE_TWO),
    });
    expect(JSON.parse(starting.body)).toMatchObject({
      service: "gustavo-hybrid-worker-v1", state: "STARTING",
    });
    await expect(host.server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    })).resolves.toMatchObject({ statusCode: 503 });
    expect(verify).not.toHaveBeenCalled();

    startGate.resolve();
    await host.ready;
    const ready = await host.server.inject({
      method: "GET",
      path: "/_gustavo/ready",
      body: "",
      headers: controlHeaders("GET", "/_gustavo/ready", CONTROL_CHALLENGE_THREE),
    });
    expect(JSON.parse(ready.body)).toMatchObject({
      service: "gustavo-hybrid-worker-v1", state: "READY",
    });
    await expect(host.server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    })).resolves.toMatchObject({ statusCode: 202 });
    expect(verify).toHaveBeenCalledOnce();
    await host.stop();

    const source = readFileSync("worker/hybrid/wake-server.ts", "utf8");
    expect(source.indexOf('process.once("SIGINT"')).toBeLessThan(
      source.indexOf("startHybridWorkerHost({"),
    );
  });

  for (const startupStage of ["market recovery", "model drain"] as const) {
    it(`authenticated stop aborts ${startupStage} and proves leased cleanup`, async () => {
      const stageEntered = deferred();
      const manualRelease = deferred();
      const order: string[] = [];
      const gatedStage = async (signal: AbortSignal) => {
        order.push(`${startupStage}:start`);
        stageEntered.resolve();
        await Promise.race([
          manualRelease.promise,
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {
            once: true,
          })),
        ]);
        if (signal.aborted) {
          order.push(`${startupStage}:aborted`);
          throw new Error("startup aborted");
        }
      };
      const runtime = createHybridRuntimeController({
        container: readyContainer({
          stop: vi.fn(async () => { order.push("container:stop"); }),
          proveAbsent: vi.fn(async () => {
            order.push("container:absent");
            return true;
          }),
        }),
        verifyMarketMaterializer: vi.fn().mockResolvedValue(true),
        recoverMarket: startupStage === "market recovery"
          ? gatedStage
          : vi.fn().mockResolvedValue(undefined),
        drainModel: startupStage === "model drain"
          ? gatedStage
          : vi.fn().mockResolvedValue(undefined),
        pollMarket: vi.fn(),
        closeResources: vi.fn(async () => { order.push("resources:closed"); }),
        stopTimeoutMs: 1_000,
      });
      const hostPromise = startHybridWorkerHost({
        runtime,
        port: 0,
        publicWakeUrl: "https://bridge.example.test/wake",
        verify: vi.fn(),
        controlNonce: CONTROL_NONCE,
        stopTimeoutMs: 1_000,
      });
      const hostOrBlocked = await Promise.race([
        hostPromise,
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 25)),
      ]);
      if (hostOrBlocked === "blocked") {
        manualRelease.resolve();
        const blockedHost = await hostPromise;
        await blockedHost.stop();
        expect(hostOrBlocked).not.toBe("blocked");
        return;
      }
      const host = hostOrBlocked;
      const readiness = host.ready;
      void readiness.catch(() => undefined);
      await stageEntered.promise;
      const stopped = await host.server.inject({
        method: "POST",
        path: "/_gustavo/stop",
        body: "",
        headers: controlHeaders("POST", "/_gustavo/stop", CONTROL_CHALLENGE_TWO),
      });
      expect(stopped.statusCode).toBe(200);
      await expect(readiness).rejects.toThrow("HYBRID_RUNTIME_START_FAILED");
      expect(order).toContain(`${startupStage}:aborted`);
      expect(order.indexOf(`${startupStage}:aborted`)).toBeLessThan(order.indexOf("container:stop"));
      expect(order.indexOf("container:stop")).toBeLessThan(order.lastIndexOf("container:absent"));
      expect(runtime.status()).toMatchObject({ accepting: false, codexAvailable: false });
      await host.stop();
    });
  }

  it("keeps one bounded stop authority while an aborted T7 reconcile helper settles", async () => {
    const image = `gustavo-codex@sha256:${"a".repeat(64)}`;
    const inspectEntered = deferred();
    const inspectLifecycle = deferred();
    const releaseLease = vi.fn(async () => undefined);
    const order: string[] = [];
    let inspections = 0;
    let initialHelperSignal: AbortSignal | undefined;
    const controller: CodexDockerController = {
      acquireHostLease: vi.fn(async () => ({ release: releaseLease })),
      inspect: vi.fn(async ({ signal }) => {
        inspections += 1;
        if (inspections === 1) {
          initialHelperSignal = signal;
          inspectEntered.resolve();
          await inspectLifecycle.promise;
          order.push("initial-helper-settled");
        } else {
          order.push("cleanup-inspect");
        }
        return { daemonAvailable: true, exists: false };
      }),
      create: vi.fn(),
      start: vi.fn(),
      wait: vi.fn(),
      kill: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(),
    };
    let cleanupProven = false;
    const runtime = createHybridRuntimeController({
      container: {
        reconcile: async (signal) => {
          await reconcileCodexContainers({
            image,
            dockerExecutable: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
            resolveDockerExecutable: async (path) => path,
            controller,
            signal,
          });
        },
        verifyReady: vi.fn(),
        stop: async (signal) => {
          order.push("cleanup-start");
          await reconcileCodexContainers({
            image,
            dockerExecutable: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
            resolveDockerExecutable: async (path) => path,
            controller,
            signal,
          });
          cleanupProven = true;
        },
        proveAbsent: async () => {
          order.push("cleanup-proven");
          return cleanupProven;
        },
      },
      recoverMarket: vi.fn(),
      drainModel: vi.fn(),
      pollMarket: vi.fn(),
      closeResources: vi.fn(),
      stopTimeoutMs: 1_000,
    });
    const host = await startHybridWorkerHost({
      runtime,
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify: vi.fn(),
      controlNonce: CONTROL_NONCE,
      stopTimeoutMs: 1_000,
    });
    void host.ready.catch(() => undefined);
    await inspectEntered.promise;
    const stopping = host.server.inject({
      method: "POST",
      path: "/_gustavo/stop",
      body: "",
      headers: controlHeaders("POST", "/_gustavo/stop", CONTROL_CHALLENGE_TWO),
    });
    try {
      await vi.waitFor(() => expect(initialHelperSignal?.aborted).toBe(true));
      expect(releaseLease).not.toHaveBeenCalled();
    } finally {
      inspectLifecycle.resolve();
    }
    await expect(stopping).resolves.toMatchObject({ statusCode: 200 });
    await expect(host.ready).rejects.toThrow("HYBRID_RUNTIME_START_FAILED");
    expect(order).toEqual([
      "initial-helper-settled",
      "cleanup-start",
      "cleanup-inspect",
      "cleanup-proven",
    ]);
    expect(releaseLease).toHaveBeenCalledTimes(2);
    await host.stop();
  });

  it("performs zero Docker work when the T7 host lease is contended", async () => {
    const verifyReady = vi.fn();
    const reconcile = vi.fn().mockRejectedValue(new Error("CODEX_CONTAINER_RECONCILIATION_FAILED"));
    const runtime = createHybridRuntimeController({
      container: readyContainer({ verifyReady, reconcile }),
      recoverMarket: vi.fn(),
      drainModel: vi.fn(),
      pollMarket: vi.fn(),
      closeResources: vi.fn(),
    });

    await expect(runtime.start()).rejects.toThrow("HYBRID_RUNTIME_START_FAILED");
    expect(reconcile).toHaveBeenCalledOnce();
    expect(verifyReady).not.toHaveBeenCalled();

    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    const wakeServer = readFileSync("worker/hybrid/wake-server.ts", "utf8");
    expect(start).not.toMatch(/dockerExecutable\s+container\s+(?:inspect|ls)/iu);
    expect(wakeServer).not.toMatch(/\[\s*"container",\s*"ls"/u);
  });

  it("acknowledges after durable verification and synchronous enqueue without awaiting work", async () => {
    const work = deferred();
    const verify = vi.fn(async () => ({ jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f" } as const));
    const wake = vi.fn(() => work.promise);
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify,
      wake,
    });
    const pending = server.inject({ method: "POST", path: "/wake", body: "{}", headers: {} });
    const first = await Promise.race([
      pending.then(() => "acknowledged" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 25)),
    ]);
    work.resolve();
    const response = await pending;
    await server.stop();

    expect(first).toBe("acknowledged");
    expect(response.statusCode).toBe(202);
    expect(verify).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("requires safe attributes and no outgoing membership on both materializer roles", async () => {
    const module = await import("../../worker/hybrid/wake-server") as unknown as {
      readonly validateMaterializerRoleAuthority?: (input: unknown) => boolean;
    };
    expect(module.validateMaterializerRoleAuthority).toBeTypeOf("function");
    const safe = {
      ordinary: { member: false },
      login: {
        currentUser: "gustavo_market_login", member: true, login: true, inherit: true,
        superuser: false, createdb: false, createrole: false, replication: false,
        bypassrls: false, otherMemberships: 0,
      },
      permission: {
        login: false, inherit: false, superuser: false, createdb: false,
        createrole: false, replication: false, bypassrls: false, otherMemberships: 0,
        memberCount: 1,
      },
    };
    expect(module.validateMaterializerRoleAuthority?.(safe)).toBe(true);
    for (const key of [
      "login", "inherit", "superuser", "createdb", "createrole", "replication", "bypassrls",
    ] as const) {
      expect(module.validateMaterializerRoleAuthority?.({
        ...safe,
        permission: { ...safe.permission, [key]: !safe.permission[key] },
      }), key).toBe(false);
    }
    expect(module.validateMaterializerRoleAuthority?.({
      ...safe, permission: { ...safe.permission, otherMemberships: 1 },
    })).toBe(false);
    expect(module.validateMaterializerRoleAuthority?.({
      ...safe, permission: { ...safe.permission, memberCount: 2 },
    })).toBe(false);

    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    expect(start).toMatch(/permission\.rolsuper/u);
    expect(start).toMatch(/permission\.rolcreatedb/u);
    expect(start).toMatch(/permission\.rolcreaterole/u);
    expect(start).toMatch(/permission\.rolreplication/u);
    expect(start).toMatch(/permission\.rolbypassrls/u);
    expect(start).toMatch(/permission_other_memberships/u);
    expect(start).toMatch(/permission_member_count/u);
  });

  it("requires an authenticated exact-worker readiness proof", async () => {
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify: vi.fn(),
      wake: vi.fn(),
      control: {
        nonce: CONTROL_NONCE,
        requestStop: vi.fn().mockResolvedValue(undefined),
      },
    } as never);
    const wrong = await server.inject({
      method: "GET", path: "/_gustavo/ready", body: "", headers: {},
    });
    const ready = await server.inject({
      method: "GET",
      path: "/_gustavo/ready",
      body: "",
      headers: controlHeaders("GET", "/_gustavo/ready"),
    });
    await server.stop();

    expect(wrong.statusCode).toBe(401);
    expect(ready.statusCode).toBe(200);
    expect(ready.body).toContain("gustavo-hybrid-worker-v1");
    expect(ready.body).not.toContain(CONTROL_NONCE);
    expect(JSON.parse(ready.body)).toEqual({
      service: "gustavo-hybrid-worker-v1",
      state: "READY",
      proof: controlTag("response", "GET", "/_gustavo/ready", CONTROL_CHALLENGE),
    });
    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    expect(start).not.toContain("TcpClient");
    expect(start).toContain("x-gustavo-worker-control");
    expect(start).toContain("x-gustavo-worker-challenge");
    expect(start).toContain("HMACSHA256");
    expect(start).not.toContain("RandomNumberGenerator]::Fill");
    expect(start).not.toContain("CryptographicOperations");
  });

  it("does not disclose the control secret and rejects reflection, replay, and wrong bindings", async () => {
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify: vi.fn(),
      wake: vi.fn(),
      control: {
        nonce: CONTROL_NONCE,
        requestStop: vi.fn().mockResolvedValue(undefined),
      },
    } as never);
    const headers = controlHeaders("GET", "/_gustavo/ready");
    expect(Object.values(headers)).not.toContain(CONTROL_NONCE);
    const requestTag = headers["x-gustavo-worker-control"]!;
    const first = await server.inject({
      method: "GET", path: "/_gustavo/ready", body: "", headers,
    });
    const replay = await server.inject({
      method: "GET", path: "/_gustavo/ready", body: "", headers,
    });
    const wrongPath = await server.inject({
      method: "POST", path: "/_gustavo/stop", body: "", headers,
    });
    const wrongMethod = await server.inject({
      method: "GET",
      path: "/_gustavo/stop",
      body: "",
      headers: controlHeaders("POST", "/_gustavo/stop", "123456789abcdef0123456789abcdef0123456789ab"),
    });
    await server.stop();

    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).proof).not.toBe(requestTag);
    expect(replay.statusCode).toBe(401);
    expect(wrongPath.statusCode).toBe(401);
    expect(wrongMethod.statusCode).toBe(405);
  });

  it("never reauthorizes an authenticated stop challenge after readiness retention", async () => {
    const requestStop = vi.fn().mockResolvedValue(undefined);
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify: vi.fn(),
      wake: vi.fn(),
      control: { nonce: CONTROL_NONCE, requestStop },
    } as never);
    let monotonicNow = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const headers = controlHeaders("POST", "/_gustavo/stop");
    try {
      const first = await server.inject({
        method: "POST", path: "/_gustavo/stop", body: "", headers,
      });
      monotonicNow = 600_001;
      const retainedReplay = await server.inject({
        method: "POST", path: "/_gustavo/stop", body: "", headers,
      });
      expect(first.statusCode).toBe(200);
      expect(retainedReplay.statusCode).toBe(401);
      expect(requestStop).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
      await server.stop();
    }
  });

  it("uses authenticated graceful stop and returns container-absence proof before exit", async () => {
    const order: string[] = [];
    const runtime = {
      start: vi.fn(async () => { order.push("start"); }),
      enqueue: vi.fn(),
      wake: vi.fn(),
      wakeModelDrain: vi.fn(),
      wakeMarketWindow: vi.fn(),
      stop: vi.fn(async () => { order.push("stop:proven"); }),
      status: vi.fn(() => ({
        accepting: true, codexAvailable: true, marketMaterializationAvailable: true,
        modelActive: false, marketActive: false,
      })),
    };
    const host = await startHybridWorkerHost({
      runtime,
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify: vi.fn(),
      controlNonce: CONTROL_NONCE,
    } as never);
    const stopped = await host.server.inject({
      method: "POST",
      path: "/_gustavo/stop",
      body: "",
      headers: controlHeaders("POST", "/_gustavo/stop"),
    });
    expect(stopped).toEqual({
      statusCode: 200,
      body: JSON.stringify({
        service: "gustavo-hybrid-worker-v1", stopped: true, containerAbsent: true,
        proof: controlTag("response", "POST", "/_gustavo/stop", CONTROL_CHALLENGE),
      }),
    });
    expect(order).toEqual(["start", "stop:proven"]);
    await host.stop();

    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    expect(start).not.toMatch(/CloseMainWindow|\$Worker\.Kill\(/u);
    expect(start).toContain("/_gustavo/stop");
    expect(start).toContain("25000");
  });

  it("closes acceptance before deferred stop work and does not consume a wake replay", async () => {
    const stopGate = deferred();
    const verify = vi.fn(async () => ({
      jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f",
    } as const));
    const wake = vi.fn();
    const requestStop = vi.fn(async () => {
      await stopGate.promise;
      throw new Error("container absence unproven");
    });
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify,
      wake,
      control: { nonce: CONTROL_NONCE, requestStop, stopTimeoutMs: 1_000 },
    } as never);

    const stopping = server.inject({
      method: "POST",
      path: "/_gustavo/stop",
      body: "",
      headers: controlHeaders("POST", "/_gustavo/stop"),
    });
    await vi.waitFor(() => expect(requestStop).toHaveBeenCalledOnce());
    const duringStop = await server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    });
    expect(duringStop.statusCode).toBe(503);
    expect(verify).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();

    stopGate.resolve();
    await expect(stopping).resolves.toMatchObject({ statusCode: 503 });
    const afterFailedStop = await server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    });
    expect(afterFailedStop.statusCode).toBe(503);
    expect(verify).not.toHaveBeenCalled();
    await server.stop();
  });

  it("settles already-admitted verification and enqueue before runtime stop", async () => {
    const verifyGate = deferred();
    const order: string[] = [];
    const verify = vi.fn(async () => {
      order.push("verify:start");
      await verifyGate.promise;
      order.push("verify:end");
      return { jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f" } as const;
    });
    const wake = vi.fn(() => { order.push("wake:enqueue"); });
    const requestStop = vi.fn(async (_remainingMs: number) => { order.push("runtime:stop"); });
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify,
      wake,
      control: { nonce: CONTROL_NONCE, requestStop, stopTimeoutMs: 1_000 },
    } as never);

    const admittedWake = server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    const stopping = server.inject({
      method: "POST",
      path: "/_gustavo/stop",
      body: "",
      headers: controlHeaders("POST", "/_gustavo/stop"),
    });
    await Promise.resolve();
    expect(requestStop).not.toHaveBeenCalled();
    await expect(server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    })).resolves.toMatchObject({ statusCode: 503 });
    expect(verify).toHaveBeenCalledOnce();

    verifyGate.resolve();
    await expect(admittedWake).resolves.toMatchObject({ statusCode: 202 });
    await expect(stopping).resolves.toMatchObject({ statusCode: 200 });
    expect(wake).toHaveBeenCalledOnce();
    expect(requestStop).toHaveBeenCalledOnce();
    const remainingMs = requestStop.mock.calls[0]?.[0];
    expect(remainingMs).toEqual(expect.any(Number));
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(1_000);
    expect(order).toEqual([
      "verify:start", "verify:end", "wake:enqueue", "runtime:stop",
    ]);
    await server.stop();
  });

  it("settles an admitted invalid verifier without enqueue before runtime stop", async () => {
    const verifyGate = deferred();
    const wake = vi.fn();
    const requestStop = vi.fn().mockResolvedValue(undefined);
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify: vi.fn(async () => {
        await verifyGate.promise;
        throw new Error("invalid signature");
      }),
      wake,
      control: { nonce: CONTROL_NONCE, requestStop },
    } as never);

    const admittedWake = server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    });
    const stopping = server.inject({
      method: "POST",
      path: "/_gustavo/stop",
      body: "",
      headers: controlHeaders("POST", "/_gustavo/stop"),
    });
    await Promise.resolve();
    expect(requestStop).not.toHaveBeenCalled();
    verifyGate.resolve();

    await expect(admittedWake).resolves.toMatchObject({ statusCode: 401 });
    await expect(stopping).resolves.toMatchObject({ statusCode: 200 });
    expect(wake).not.toHaveBeenCalled();
    expect(requestStop).toHaveBeenCalledOnce();
    await server.stop();
  });

  it("fails stop without runtime teardown when admitted verification exceeds its deadline", async () => {
    const verifyGate = deferred();
    const verify = vi.fn(async () => {
      await verifyGate.promise;
      return { jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f" } as const;
    });
    const wake = vi.fn();
    const requestStop = vi.fn();
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      verify,
      wake,
      control: { nonce: CONTROL_NONCE, requestStop, stopTimeoutMs: 20 },
    } as never);

    const admittedWake = server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    const stopped = await server.inject({
      method: "POST",
      path: "/_gustavo/stop",
      body: "",
      headers: controlHeaders("POST", "/_gustavo/stop"),
    });
    expect(stopped).toEqual({ statusCode: 503, body: "CONTROL_STOP_UNPROVEN" });
    expect(requestStop).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    await expect(server.inject({
      method: "POST", path: "/wake", body: "{}", headers: {},
    })).resolves.toMatchObject({ statusCode: 503 });

    verifyGate.resolve();
    await expect(admittedWake).resolves.toMatchObject({ statusCode: 202 });
    expect(wake).toHaveBeenCalledOnce();
    expect(requestStop).not.toHaveBeenCalled();
    await server.stop();
  });

  it("binds setup identity and ACLs to the exact local-user SID", () => {
    const setup = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
    expect(setup).not.toContain('.Name.Split("\\")[-1]');
    expect(setup).toMatch(/LocalUser\.SID\.Value/u);
    expect(setup).toMatch(/CurrentIdentity\.User\.Value/u);
    expect(setup).toContain("$env:COMPUTERNAME");
    expect(setup).toMatch(/Set-OwnerOnlyAcl[^\r\n]*LocalUser\.SID/u);
  });

  it("seals one canonical non-reparse config file before writing secret bytes", () => {
    const setup = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    for (const script of [setup, start]) {
      expect(script).toContain("GetFullPath");
      expect(script).toContain("ReparsePoint");
      expect(script).toContain("Assert-NoReparsePath");
      expect(script).toContain("ExpectedConfigPath");
    }
    expect(setup).toContain("[IO.FileMode]::CreateNew");
    expect(setup).toContain("[IO.FileShare]::None");
    expect(setup).toContain("[IO.FileOptions]::WriteThrough");
    expect(setup).not.toContain("[IO.File]::WriteAllLines");
    const sealDirectory = setup.indexOf("Set-OwnerOnlyAcl $ConfigDirectory");
    const openConfig = setup.indexOf("[IO.FileMode]::CreateNew");
    const secretWrite = setup.indexOf("$ConfigStream.Write(");
    expect(sealDirectory).toBeGreaterThan(-1);
    expect(sealDirectory).toBeLessThan(openConfig);
    expect(openConfig).toBeLessThan(secretWrite);
    expect(setup.slice(openConfig, secretWrite)).toContain("Set-OwnerOnlyAcl $ConfigWritePath");
    expect(setup.slice(secretWrite)).toContain("Assert-OwnerOnlyAcl $ConfigWritePath");
  });

  it("pins executable provenance and launches the worker with a minimal child environment", () => {
    const setup = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    const env = readFileSync("infra/env.example", "utf8");
    for (const name of [
      "GUSTAVO_DOCKER_EXECUTABLE",
      "GUSTAVO_NODE_EXECUTABLE",
      "GUSTAVO_COREPACK_EXECUTABLE",
      "GUSTAVO_TAILSCALE_EXECUTABLE",
    ]) {
      expect(setup).toContain(name);
      expect(start).toContain(name);
      expect(env).toMatch(new RegExp(`^${name}=$`, "mu"));
    }
    expect(setup).toContain("ProgramFiles");
    expect(setup).toContain("Docker\\Docker\\resources\\bin\\docker.exe");
    expect(setup).toContain("nodejs\\node.exe");
    expect(setup).toContain("nodejs\\corepack.cmd");
    expect(setup).toContain("Tailscale\\tailscale.exe");
    for (const script of [setup, start]) {
      expect(script).toContain("[Environment]::GetFolderPath");
      expect(script).toContain("[Environment+SpecialFolder]::ProgramFiles");
      expect(script).toContain("[Environment+SpecialFolder]::LocalApplicationData");
      expect(script).not.toMatch(/Join-Path\s+\$env:(?:ProgramFiles|LOCALAPPDATA)/iu);
    }
    expect(start).toContain("[Environment+SpecialFolder]::Windows");
    expect(start).not.toMatch(/Join-Path\s+\$env:SystemRoot/iu);
    expect(`${setup}\n${start}`).not.toMatch(/Get-Command\s+(?:docker|node|corepack|tailscale)/iu);
    expect(start).not.toMatch(/&\s+(?:node|corepack|tailscale)(?:\.exe|\.cmd)?\b/iu);
    expect(start).toContain("[Diagnostics.ProcessStartInfo]::new()");
    expect(start).toContain("EnvironmentVariables.Clear()");
    expect(start).toContain("$WorkerEnvironmentNames");
    expect(start).not.toContain("foreach ($Name in $AllowedNames) {\n  $StartInfo.EnvironmentVariables");
    expect(start).toContain("node_modules\\tsx\\dist\\cli.mjs");
    expect(start).toContain("$NodeExecutable");
    expect(start).toContain("$RoleStartInfo.FileName = $NodeExecutable");
    expect(start).toContain('$RoleStartInfo.Arguments = ConvertTo-TrustedArguments @($TsxCli, "--eval", $RoleCheck)');
    expect(start).not.toContain("$CorepackExecutable pnpm exec tsx --eval $RoleCheck");
    expect(start).toMatch(
      /\$ReadyProof\.state -eq "STARTING"[\s\S]{0,300}Start-Sleep -Milliseconds \(\[Math\]::Min\(/u,
    );
    const readinessLoop = start.slice(start.indexOf("$Ready = $false"), start.indexOf("if (-not $Ready)"));
    expect(readinessLoop).toContain("[Diagnostics.Stopwatch]::StartNew()");
    expect(readinessLoop).toContain("ElapsedMilliseconds -lt $ReadinessTimeoutMilliseconds");

    for (const script of [setup, start]) {
      expect(script).toContain("Invoke-TrustedProcess");
      expect(script).not.toMatch(/&\s+\$(?:Node|Corepack|Docker|Tailscale|PowerShell)Executable\b/u);
    }
    expect(start).toContain("$RoleStartInfo.EnvironmentVariables.Clear()");
    expect(start).toContain('$RoleStartInfo.EnvironmentVariables["DATABASE_URL"]');
    expect(start).toContain('$RoleStartInfo.EnvironmentVariables["GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL"]');
    expect(start).toContain("$RoleStartInfo.WorkingDirectory = $RepositoryRoot");
    expect(start).not.toContain('$RoleStartInfo.EnvironmentVariables["NODE_OPTIONS"]');
  });

  it.runIf(process.platform === "win32")(
    "clears hostile parent options and working directory in the trusted process helper",
    () => {
      const source = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
      const helper = source.slice(
        source.indexOf("function ConvertTo-TrustedArguments"),
        source.indexOf("$CurrentSid ="),
      );
      expect(helper).toContain("function Invoke-TrustedProcess");
      const hostileCwd = mkdtempSync(join(tmpdir(), "gustavo-hostile-cwd-"));
      const exactCwd = resolve(".");
      const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const probe = [
        "process.stdout.write(JSON.stringify({",
        "nodeOptions:process.env.NODE_OPTIONS??null,",
        "secret:process.env.SECRET_SHOULD_NOT_INHERIT??null,",
        "allowed:process.env.EXACT_ALLOWED??null,cwd:process.cwd()}))",
      ].join("");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "function Stop-Safely([string]$Code) { throw $Code }",
        helper,
        "$ExactEnvironment = [ordered]@{",
        `  SystemRoot = ${psLiteral(process.env.SystemRoot ?? "C:\\Windows")}`,
        `  PATH = ${psLiteral(dirname(process.execPath))}`,
        "  EXACT_ALLOWED = 'yes'",
        "}",
        `$Result = Invoke-TrustedProcess ${psLiteral(process.execPath)} @('-e', ${psLiteral(probe)}) $ExactEnvironment ${psLiteral(exactCwd)} -CaptureOutput`,
        "if ($Result.ExitCode -ne 0) { throw 'PROBE_FAILED' }",
        "[Console]::Out.Write($Result.Stdout)",
      ].join("\r\n");
      try {
        const powerShell = join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
        );
        const encodedScript = Buffer.from(script, "utf16le").toString("base64");
        const result = spawnSync(powerShell, [
          "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript,
        ], {
          cwd: hostileCwd,
          env: {
            ...process.env,
            NODE_OPTIONS: "--require=C:\\definitely-missing\\hostile.cjs",
            SECRET_SHOULD_NOT_INHERIT: "forbidden",
          },
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          nodeOptions: null,
          secret: null,
          allowed: "yes",
          cwd: exactCwd,
        });
      } finally {
        rmSync(hostileCwd, { recursive: true, force: true });
      }
    },
  );

  it("bounds Funnel helpers and cleans the worker before retrying a failed Funnel stop", () => {
    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    expect(start).toContain("[int]$TimeoutMilliseconds = 0");
    expect(start).toContain("$Process.WaitForExit($TimeoutMilliseconds)");
    expect(start).toContain("$Process.Kill()");
    expect(start).toContain("TimedOut = $true");
    expect(start).toContain("TimedOut = $false");
    const timeoutBranch = start.slice(
      start.indexOf("if ($TimedOut)"),
      start.indexOf("return [PSCustomObject]", start.indexOf("if ($TimedOut)")),
    );
    expect(timeoutBranch).not.toContain("GetAwaiter().GetResult()");
    expect(start).not.toMatch(/(?:Stop-Process|taskkill|Get-Process)[\s\S]{0,80}(?:Kill|Stop)/iu);
    expect(start).toContain("$FunnelCommandTimeoutMilliseconds = 5000");
    expect(start).toMatch(
      /"funnel", "--bg", "http:\/\/127\.0\.0\.1:\$Port"[\s\S]{0,180}-TimeoutMilliseconds \$FunnelCommandTimeoutMilliseconds/u,
    );
    expect(start).toMatch(
      /function Invoke-FunnelOff[\s\S]{0,300}"funnel", "off"[\s\S]{0,180}-TimeoutMilliseconds \$FunnelCommandTimeoutMilliseconds/u,
    );
    expect(start).toContain("$FunnelStopNeedsRetry = $FunnelStop.TimedOut -or $FunnelStop.ExitCode -ne 0");
    expect(start).toContain('Stop-Safely "TAILSCALE_FUNNEL_STOP_FAILED"');

    const firstOff = start.indexOf("$FunnelStop = Invoke-FunnelOff");
    const workerDispose = start.indexOf("$Worker.Dispose()", firstOff);
    const retryOff = start.indexOf("$FunnelStopRetry = Invoke-FunnelOff", workerDispose);
    expect(firstOff).toBeGreaterThan(-1);
    expect(workerDispose).toBeGreaterThan(firstOff);
    expect(retryOff).toBeGreaterThan(workerDispose);
    const workerCleanup = start.slice(firstOff, retryOff);
    expect(workerCleanup).toContain("try {");
    expect(workerCleanup).toContain("} finally {");
    expect(workerCleanup).toContain("$Worker.Dispose()");
  });

  it("derives a finite startup readiness window without weakening the stop deadline", () => {
    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    const wakeServer = readFileSync("worker/hybrid/wake-server.ts", "utf8");
    expect(start).toContain("$MaximumStartupModelJobs = 100");
    expect(start).toContain("$MaximumModelRoleMilliseconds = 300000");
    expect(start).toContain("$MaximumRecoveryWindows = 2016");
    expect(start).toContain("$MaximumDatabaseStatementMilliseconds = 5000");
    expect(start).toContain("$MaximumDatabaseStatementsPerModelJob = 100");
    expect(start).toContain("$ReadinessTimeoutMilliseconds =");
    expect(start).toContain("100 * 300s");
    expect(start).toContain("2016 * 12 * 5s");
    expect(start).toContain("100 * 100 * 5s");
    expect(start).toContain("$ReadinessPollMilliseconds = 5000");
    expect(start).toMatch(
      /while \(\$ReadyStopwatch\.ElapsedMilliseconds -lt \$ReadinessTimeoutMilliseconds\)/u,
    );
    expect(start).toContain("$RemainingReadinessMilliseconds");
    expect(start).toContain("-TimeoutSec $ReadyRequestTimeoutSeconds");
    expect(start).toContain("[Diagnostics.Stopwatch]::StartNew()");
    expect(start).toContain("25000 - [int]$Stopwatch.ElapsedMilliseconds");

    const pollMilliseconds = Number(
      /\$ReadinessPollMilliseconds = ([0-9]+)/u.exec(start)?.[1],
    );
    const retentionMilliseconds = Number(
      /const CONTROL_CHALLENGE_RETENTION_MS = ([0-9_]+)/u.exec(wakeServer)?.[1]
        ?.replaceAll("_", ""),
    );
    const challengeCapacity = Number(
      /const MAX_CONTROL_CHALLENGES = ([0-9_]+)/u.exec(wakeServer)?.[1]
        ?.replaceAll("_", ""),
    );
    expect(pollMilliseconds).toBe(5_000);
    expect(retentionMilliseconds).toBeGreaterThanOrEqual(10 * 60_000);
    expect(challengeCapacity).toBeLessThanOrEqual(512);
    expect(Math.ceil(retentionMilliseconds / pollMilliseconds) + 4)
      .toBeLessThanOrEqual(challengeCapacity);
    expect(wakeServer).toContain("new Map<string, number>()");
    expect(wakeServer).toContain("pruneControlChallenges");
    expect(wakeServer).toContain("usedControlChallenges.delete");
    expect(wakeServer).toContain("? Number.POSITIVE_INFINITY");
  });

  it.runIf(process.platform === "win32")(
    "keeps signed STARTING alive beyond 25 seconds and starts Funnel only after READY",
    () => {
      const source = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
      let readiness = source.slice(
        source.indexOf("$Ready = $false"),
        source.indexOf('Write-Output "HYBRID_WORKER_READY"'),
      );
      readiness = readiness
        .replace(
          "$ReadyStopwatch = [Diagnostics.Stopwatch]::StartNew()",
          "$ReadyStopwatch = $null",
        )
        .replaceAll("$ReadyStopwatch.ElapsedMilliseconds", "$script:ElapsedMilliseconds");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$script:ElapsedMilliseconds = 0",
        "$script:ReadyRequests = 0",
        "$script:FunnelStarts = 0",
        "function Stop-Safely([string]$Code) { throw $Code }",
        "function Start-Sleep { param([int]$Milliseconds) $script:ElapsedMilliseconds += 6000 }",
        "function New-ControlRequest { param([string]$Method, [string]$Path) return [PSCustomObject]@{ Headers = @{}; ExpectedProof = 'signed-proof' } }",
        "function Test-ControlProof { param([object]$Actual, [string]$Expected) return $Actual -eq $Expected }",
        "function Invoke-RestMethod {",
        "  param($Method, $Uri, $Headers, $TimeoutSec)",
        "  $script:ReadyRequests += 1",
        "  $State = if ($script:ReadyRequests -le 5) { 'STARTING' } else { 'READY' }",
        "  return [PSCustomObject]@{ service = 'gustavo-hybrid-worker-v1'; state = $State; proof = 'signed-proof' }",
        "}",
        "function Invoke-TrustedProcess {",
        "  param($FilePath, $Arguments, $Environment, [switch]$CaptureOutput, [int]$TimeoutMilliseconds)",
        "  if ($Arguments -contains '--bg') { $script:FunnelStarts += 1 }",
        "  return [PSCustomObject]@{ ExitCode = 0; TimedOut = $false }",
        "}",
        "$Worker = [PSCustomObject]@{ HasExited = $false }",
        "$ReadyPath = '/_gustavo/ready'",
        "$ReadyUri = 'http://127.0.0.1:4318/_gustavo/ready'",
        "$Port = 4318",
        "$TailscaleExecutable = 'C:\\trusted\\tailscale.exe'",
        "$TailscaleChildEnvironment = [ordered]@{}",
        "$FunnelCommandTimeoutMilliseconds = 5000",
        readiness,
        '[Console]::Out.Write("$Ready|$script:ReadyRequests|$script:FunnelStarts|$script:ElapsedMilliseconds")',
      ].join("\r\n");
      const powerShell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
      );
      const encodedScript = Buffer.from(script, "utf16le").toString("base64");
      const result = spawnSync(powerShell, [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript,
      ], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("True|6|1|30000");
    },
  );

  it.runIf(process.platform === "win32")(
    "times out and terminates only the exact trusted helper without exposing output",
    () => {
      const source = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
      const helper = source.slice(
        source.indexOf("function ConvertTo-TrustedArguments"),
        source.indexOf("$CurrentSid ="),
      );
      const temporaryDirectory = mkdtempSync(join(tmpdir(), "gustavo-helper-timeout-"));
      const pidFile = join(temporaryDirectory, "child.json");
      const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const probe = [
        "const fs=require('node:fs');",
        "fs.writeFileSync(process.env.PROBE_PID_FILE,String(process.pid)+'|'",
        "+(process.env.SECRET_SHOULD_NOT_INHERIT??''));",
        "setInterval(()=>{},1000);",
      ].join("");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "function Stop-Safely([string]$Code) { throw $Code }",
        helper,
        "$ExactEnvironment = [ordered]@{",
        `  SystemRoot = ${psLiteral(process.env.SystemRoot ?? "C:\\Windows")}`,
        `  PATH = ${psLiteral(dirname(process.execPath))}`,
        `  PROBE_PID_FILE = ${psLiteral(pidFile)}`,
        "}",
        `$Result = Invoke-TrustedProcess ${psLiteral(process.execPath)} @('-e', ${psLiteral(probe)}) $ExactEnvironment '' -CaptureOutput -TimeoutMilliseconds 200`,
        `$Child = [IO.File]::ReadAllText(${psLiteral(pidFile)}).Split('|')`,
        "$Alive = $false",
        "try {",
        "  $OwnedProcess = [Diagnostics.Process]::GetProcessById([int]$Child[0])",
        "  try { $Alive = -not $OwnedProcess.HasExited } finally { $OwnedProcess.Dispose() }",
        "} catch [ArgumentException] { $Alive = $false }",
        "$TimedOutText = $Result.TimedOut.ToString().ToLowerInvariant()",
        "$AliveText = $Alive.ToString().ToLowerInvariant()",
        '$SecretText = if ($Child[1].Length -eq 0) { "null" } else { "`"leaked`"" }',
        '$OutputText = if ($Result.Stdout.Length -eq 0 -and $Result.Stderr.Length -eq 0) { "true" } else { "false" }',
        '[Console]::Out.Write("{`"timedOut`":$TimedOutText,`"alive`":$AliveText,`"secret`":$SecretText,`"outputSuppressed`":$OutputText}")',
      ].join("\r\n");
      try {
        const powerShell = join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
        );
        const encodedScript = Buffer.from(script, "utf16le").toString("base64");
        const result = spawnSync(powerShell, [
          "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript,
        ], {
          env: {
            ...process.env,
            SECRET_SHOULD_NOT_INHERIT: "forbidden",
          },
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          timedOut: true,
          alive: false,
          secret: null,
          outputSuppressed: true,
        });
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );

  it("recovers before accepting wakes, coalesces model work, and runs market independently", async () => {
    const modelGate = deferred();
    const marketGate = deferred();
    const order: string[] = [];
    let modelDrainCount = 0;
    const drainModel = vi.fn(async () => {
      modelDrainCount += 1;
      if (modelDrainCount === 1) {
        order.push("model:recover");
        return;
      }
      order.push("model:start");
      await modelGate.promise;
      order.push("model:end");
    });
    const pollMarket = vi.fn(async (windowId: string) => {
      order.push(`market:${windowId}:start`);
      await marketGate.promise;
      order.push(`market:${windowId}:end`);
    });
    const recoverMarket = vi.fn(async () => { order.push("market:recover"); });
    const runtime = createHybridRuntimeController({
      container: readyContainer(),
      recoverMarket,
      drainModel,
      pollMarket,
      closeResources: vi.fn().mockResolvedValue(undefined),
    });

    await expect(runtime.wakeMarketWindow("2026-08-13T13:30Z"))
      .rejects.toThrow("HYBRID_RUNTIME_NOT_READY");
    await runtime.start();
    expect(order).toEqual(["market:recover", "model:recover"]);

    const modelOne = runtime.wakeModelDrain();
    const modelTwo = runtime.wakeModelDrain();
    const market = runtime.wakeMarketWindow("2026-08-13T13:30Z");
    await vi.waitFor(() => {
      expect(drainModel).toHaveBeenCalledTimes(2);
      expect(pollMarket).toHaveBeenCalledTimes(1);
    });
    expect(order).toContain("model:start");
    expect(order).toContain("market:2026-08-13T13:30Z:start");

    modelGate.resolve();
    marketGate.resolve();
    await Promise.all([modelOne, modelTwo, market]);
    expect(drainModel).toHaveBeenCalledTimes(3);
    expect(pollMarket).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("database-current market trigger returns synchronously and coalesces one market lane", async () => {
    const deriveGate = deferred();
    const pollGate = deferred();
    const deriveCurrentMarketWindow = vi.fn(async () => {
      await deriveGate.promise;
      return "2026-08-13T13:30Z";
    });
    const pollMarket = vi.fn(async () => { await pollGate.promise; });
    const runtime = createHybridRuntimeController({
      container: readyContainer(),
      recoverMarket: vi.fn().mockResolvedValue(undefined),
      drainModel: vi.fn().mockResolvedValue(undefined),
      pollMarket,
      deriveCurrentMarketWindow,
      closeResources: vi.fn().mockResolvedValue(undefined),
    });
    await runtime.start();
    const server = await startHybridWakeServer({
      host: "127.0.0.1",
      port: 0,
      publicWakeUrl: "https://bridge.example.test/wake",
      verify: vi.fn(async () => ({ kind: "MARKET_CURRENT" } as const)),
      wake: (verified) => runtime.enqueue(verified),
    });

    const inject = () => server.inject({
      method: "POST",
      path: "/wake",
      body: '{"kind":"MARKET_CURRENT"}',
      headers: { "content-type": "application/json" },
    });
    await expect(inject()).resolves.toMatchObject({ statusCode: 202 });
    await expect(inject()).resolves.toMatchObject({ statusCode: 202 });
    expect(deriveCurrentMarketWindow).toHaveBeenCalledOnce();
    expect(pollMarket).not.toHaveBeenCalled();

    deriveGate.resolve();
    await vi.waitFor(() => expect(pollMarket).toHaveBeenCalledOnce());
    expect(deriveCurrentMarketWindow).toHaveBeenCalledOnce();
    expect(pollMarket).toHaveBeenCalledWith(
      "2026-08-13T13:30Z",
      expect.any(AbortSignal),
    );
    pollGate.resolve();
    await vi.waitFor(() => expect(runtime.status().marketActive).toBe(false));
    await server.stop();
    await runtime.stop();
  });

  it("database-current market trigger retains one pending serial follow-up while active", async () => {
    const firstPollGate = deferred();
    const secondPollGate = deferred();
    const windows: string[] = [];
    let activePolls = 0;
    let maximumActivePolls = 0;
    const deriveCurrentMarketWindow = vi.fn()
      .mockResolvedValueOnce("2026-08-13T13:30Z")
      .mockResolvedValueOnce("2026-08-13T13:35Z");
    const pollMarket = vi.fn(async (windowId: string) => {
      windows.push(windowId);
      activePolls += 1;
      maximumActivePolls = Math.max(maximumActivePolls, activePolls);
      try {
        if (windowId === "2026-08-13T13:30Z") await firstPollGate.promise;
        else await secondPollGate.promise;
      } finally {
        activePolls -= 1;
      }
    });
    const runtime = createHybridRuntimeController({
      container: readyContainer(),
      recoverMarket: vi.fn().mockResolvedValue(undefined),
      drainModel: vi.fn().mockResolvedValue(undefined),
      pollMarket,
      deriveCurrentMarketWindow,
      closeResources: vi.fn().mockResolvedValue(undefined),
    });
    await runtime.start();

    runtime.enqueue({ kind: "MARKET_CURRENT" });
    await vi.waitFor(() => expect(pollMarket).toHaveBeenCalledOnce());
    runtime.enqueue({ kind: "MARKET_CURRENT" });
    runtime.enqueue({ kind: "MARKET_CURRENT" });
    runtime.enqueue({ kind: "MARKET_CURRENT" });
    expect(deriveCurrentMarketWindow).toHaveBeenCalledOnce();
    expect(windows).toEqual(["2026-08-13T13:30Z"]);

    firstPollGate.resolve();
    await vi.waitFor(() => expect(pollMarket).toHaveBeenCalledTimes(2));
    expect(deriveCurrentMarketWindow).toHaveBeenCalledTimes(2);
    expect(windows).toEqual(["2026-08-13T13:30Z", "2026-08-13T13:35Z"]);
    expect(maximumActivePolls).toBe(1);

    secondPollGate.resolve();
    await vi.waitFor(() => expect(runtime.status().marketActive).toBe(false));
    expect(pollMarket).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("drains durable model work once during startup before accepting current wakes", async () => {
    const startupDrainGate = deferred();
    const order: string[] = [];
    const drainModel = vi.fn(async () => {
      order.push("model:recover");
      await startupDrainGate.promise;
    });
    const runtime = createHybridRuntimeController({
      container: readyContainer({
        reconcile: vi.fn(async () => { order.push("container:reconcile"); }),
        verifyReady: vi.fn(async () => { order.push("container:ready"); }),
        proveAbsent: vi.fn(async () => {
          order.push("container:absent");
          return true;
        }),
      }),
      verifyMarketMaterializer: vi.fn(async () => {
        order.push("materializer:ready");
        return true;
      }),
      recoverMarket: vi.fn(async () => { order.push("market:recover"); }),
      drainModel,
      pollMarket: vi.fn(),
      closeResources: vi.fn(),
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(drainModel).toHaveBeenCalledOnce());
    expect(order).toEqual([
      "container:reconcile",
      "container:ready",
      "container:absent",
      "materializer:ready",
      "market:recover",
      "model:recover",
    ]);
    expect(runtime.status().accepting).toBe(false);
    expect(() => runtime.enqueue({
      jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f",
    })).toThrow("HYBRID_RUNTIME_NOT_READY");
    await expect(runtime.wakeMarketWindow("2026-08-13T13:30Z"))
      .rejects.toThrow("HYBRID_RUNTIME_NOT_READY");
    startupDrainGate.resolve();
    await starting;
    expect(runtime.status().accepting).toBe(true);
    expect(drainModel).toHaveBeenCalledOnce();
    await runtime.stop();

    const failedRuntime = createHybridRuntimeController({
      container: readyContainer(),
      verifyMarketMaterializer: vi.fn().mockResolvedValue(true),
      recoverMarket: vi.fn().mockResolvedValue(undefined),
      drainModel: vi.fn().mockRejectedValue(new Error("durable model recovery failed")),
      pollMarket: vi.fn(),
      closeResources: vi.fn(),
    });
    await expect(failedRuntime.start()).rejects.toThrow("HYBRID_RUNTIME_START_FAILED");
    expect(failedRuntime.status()).toMatchObject({ accepting: false, codexAvailable: false });
    expect(() => failedRuntime.enqueue({
      jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f",
    })).toThrow("HYBRID_RUNTIME_STOPPED");
  });

  it("stops acceptance, aborts active work, proves absence, and fails closed", async () => {
    const signals: AbortSignal[] = [];
    let modelDrainCount = 0;
    const container = readyContainer({
      proveAbsent: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    });
    const runtime = createHybridRuntimeController({
      container,
      recoverMarket: vi.fn().mockResolvedValue(undefined),
      drainModel: vi.fn(async (signal) => {
        modelDrainCount += 1;
        if (modelDrainCount === 1) return;
        signals.push(signal);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {
          once: true,
        }));
      }),
      pollMarket: vi.fn().mockResolvedValue(undefined),
      closeResources: vi.fn().mockResolvedValue(undefined),
      stopTimeoutMs: 100,
    });
    await runtime.start();
    const running = runtime.wakeModelDrain();
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await expect(runtime.stop()).rejects.toThrow("CODEX_CONTAINER_TERMINATION_UNPROVEN");
    await running;
    expect(signals[0]?.aborted).toBe(true);
    await expect(runtime.wakeModelDrain()).rejects.toThrow("HYBRID_RUNTIME_STOPPED");
    expect(runtime.status()).toMatchObject({ accepting: false, codexAvailable: false });
  });

  it("publishes only bounded component heartbeat states across startup and stop", async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const runtime = createHybridRuntimeController({
      container: readyContainer(),
      recoverMarket: vi.fn().mockResolvedValue(undefined),
      drainModel: vi.fn().mockResolvedValue(undefined),
      pollMarket: vi.fn().mockResolvedValue(undefined),
      closeResources: vi.fn().mockResolvedValue(undefined),
      verifyMarketMaterializer: vi.fn().mockResolvedValue(false),
      heartbeat,
    });
    await runtime.start();
    expect(heartbeat).toHaveBeenNthCalledWith(1, {
      component: "CODEX", status: "HEALTHY", safeCode: null,
    }, expect.any(AbortSignal));
    expect(heartbeat).toHaveBeenNthCalledWith(2, {
      component: "MARKET", status: "DEGRADED", safeCode: "DATABASE_UNAVAILABLE",
    }, expect.any(AbortSignal));
    await runtime.stop();
    expect(heartbeat).toHaveBeenCalledWith({
      component: "CODEX", status: "OFFLINE", safeCode: "WORKER_OFFLINE",
    }, expect.any(AbortSignal));
  });

  it("refreshes the CODEX heartbeat lease on accepted wakes without delaying or adding a timer", async () => {
    const refreshOne = deferred();
    const refreshTwo = deferred();
    const interval = vi.spyOn(globalThis, "setInterval");
    let codexHeartbeats = 0;
    const heartbeat = vi.fn(async (value: { readonly component: string }) => {
      if (value.component !== "CODEX") return;
      codexHeartbeats += 1;
      if (codexHeartbeats === 2) await refreshOne.promise;
      if (codexHeartbeats === 3) await refreshTwo.promise;
    });
    const runtime = createHybridRuntimeController({
      container: readyContainer(),
      recoverMarket: vi.fn().mockResolvedValue(undefined),
      drainModel: vi.fn().mockResolvedValue(undefined),
      pollMarket: vi.fn().mockResolvedValue(undefined),
      closeResources: vi.fn().mockResolvedValue(undefined),
      heartbeat,
    });

    try {
      await runtime.start();
      expect(runtime.enqueue({
        jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f",
      })).toBeUndefined();
      expect(runtime.enqueue({ windowId: "2026-08-13T13:30Z" })).toBeUndefined();
      await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(3));
      expect(heartbeat).toHaveBeenLastCalledWith({
        component: "CODEX", status: "HEALTHY", safeCode: null,
      }, expect.any(AbortSignal));

      refreshOne.resolve();
      await refreshOne.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(runtime.enqueue({
        jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e70",
      })).toBeUndefined();
      await vi.waitFor(() => expect(codexHeartbeats).toBe(3));
      expect(interval).not.toHaveBeenCalled();
      refreshTwo.resolve();
      await runtime.stop();
    } finally {
      refreshOne.resolve();
      refreshTwo.resolve();
      interval.mockRestore();
    }
  });

  it("installs an owner-only, digest-pinned, materializer-separated Windows worker", () => {
    const setup = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    const env = readFileSync("infra/env.example", "utf8");

    expect(setup).toContain("Gustavo Hybrid Worker");
    expect(setup).toContain("gustavo-codex-auth-v1");
    expect(setup).toContain("docker image inspect");
    expect(setup).toContain("@openai/codex@0.146.0");
    expect(setup).toContain("--pull --no-cache");
    expect(setup).toContain("/inheritance:r");
    expect(setup).toContain("GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL");
    expect(start).toContain("tailscale funnel --bg");
    expect(start).toContain("http://127.0.0.1:");
    expect(start).toContain("gustavo_market_materializer");
    expect(start).toContain("current_user");
    expect(start).toContain("pg_has_role");
    expect(env).toMatch(/^GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL=$/mu);
    expect(start).not.toMatch(/0\.0\.0\.0|OPENAI_API_KEY|--dangerously-bypass-approvals-and-sandbox/u);
    expect(start).not.toMatch(/GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL=.*\S/u);
    expect(`${setup}\n${start}`).not.toMatch(/-v\s+[^\r\n]*(?:docker\.sock|\.git|infra\\\.env)/iu);
    expect(start).not.toMatch(/DATABASE_URL[^\r\n]*(?:fallback|GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL)/iu);
  });

  it("rebuilds and optionally rotates worker authority without ambient paths or a plaintext backup", () => {
    const setup = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");

    for (const marker of [
      "[switch]$MaintenanceRebuild",
      "[switch]$RotateCodexAuthVolume",
      "HYBRID_MAINTENANCE_TASK_RUNNING",
      "HYBRID_MAINTENANCE_CONTAINER_PRESENT",
      "HYBRID_MAINTENANCE_LEASE_UNAVAILABLE",
      "[IO.File]::Replace",
    ]) expect(setup).toContain(marker);
    expect(setup).toMatch(/NamedPipeServerStream[\s\S]+gustavo-codex-runner-v1/);
    expect(setup).toMatch(/volume["'],\s*["']rm["'][\s\S]+\$AuthVolume/);
    expect(setup).not.toMatch(/\.previous|\$env:ProgramFiles[\s\S]+volume rm|Move-Item[\s\S]+hybrid-worker\.env/);
  });

  it("keeps maintenance fail-closed and orders replacement before task registration", () => {
    const setup = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
    expect(setup).toContain('Stop-Safely "HYBRID_MAINTENANCE_MODE_REQUIRED"');
    expect(setup).toContain('Stop-Safely "HYBRID_MAINTENANCE_CONFIG_REQUIRED"');
    expect(setup).toMatch(
      /if \(\$MaintenanceRebuild\)[\s\S]+Assert-OwnerOnlyAcl \$ConfigDirectory \$LocalUser\.SID[\s\S]+Assert-OwnerOnlyAcl \$ConfigFullPath \$LocalUser\.SID/u,
    );
    expect(setup).toMatch(
      /if \(-not \$MaintenanceRebuild\)[\s\S]+HYBRID_CONFIG_ALREADY_EXISTS/u,
    );

    const lease = setup.indexOf("$MaintenanceLease = New-MaintenanceLease");
    const unregister = setup.indexOf("Unregister-ScheduledTask", lease);
    const absence = setup.indexOf('Stop-Safely "HYBRID_MAINTENANCE_CONTAINER_PRESENT"');
    const build = setup.indexOf('"build", "--pull", "--no-cache"');
    const rotate = setup.indexOf('"volume", "rm", $AuthVolume');
    const temporaryValidation = setup.indexOf("Invoke-MaintenanceRoleValidation $TemporaryConfigPath");
    const replace = setup.indexOf("[IO.File]::Replace($TemporaryConfigPath, $ConfigFullPath, $null)");
    const finalValidation = setup.indexOf("Invoke-WorkerConfigValidation $ConfigFullPath", replace);
    const registration = setup.indexOf("Register-ExactWorkerTask", finalValidation);
    const cleanup = setup.indexOf("Remove-Item -Force -LiteralPath $TemporaryConfigPath", registration);
    const release = setup.indexOf("$MaintenanceLease.Dispose()", cleanup);
    for (const position of [lease, unregister, absence, build, rotate, temporaryValidation, replace,
      finalValidation, registration, cleanup, release]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(lease).toBeLessThan(unregister);
    expect(unregister).toBeLessThan(absence);
    expect(lease).toBeLessThan(absence);
    expect(absence).toBeLessThan(build);
    expect(absence).toBeLessThan(rotate);
    expect(temporaryValidation).toBeLessThan(replace);
    expect(replace).toBeLessThan(finalValidation);
    expect(finalValidation).toBeLessThan(registration);
    expect(registration).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(release);
  });

  it.runIf(process.platform === "win32")(
    "holds an exclusive crash-releasing maintenance pipe lease",
    () => {
      const source = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
      const start = source.indexOf("function New-MaintenanceLease");
      const end = source.indexOf("function ", start + "function ".length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const helper = source.slice(start, end);
      const pipeName = `gustavo-maintenance-test-${process.pid}-${Date.now()}`;
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "function Stop-Safely([string]$Code) { throw $Code }",
        helper,
        `$First = New-MaintenanceLease '${pipeName}'`,
        "$Failure = ''",
        "try {",
        `  try { $Second = New-MaintenanceLease '${pipeName}'; $Second.Dispose() } catch { $Failure = $_.Exception.Message }`,
        "} finally { $First.Dispose() }",
        `$Third = New-MaintenanceLease '${pipeName}'`,
        "$Third.Dispose()",
        "[Console]::Out.Write($Failure)",
      ].join("\r\n");
      const powerShell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
      );
      const result = spawnSync(powerShell, [
        "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("HYBRID_MAINTENANCE_LEASE_UNAVAILABLE");
    },
  );

  it("scopes every maintenance task operation to the exact root task identity", () => {
    const setup = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
    expect(setup).toContain('$ExactTaskPath = "\\"');
    expect(setup).toMatch(
      /Get-ScheduledTask -TaskName \$TaskName -TaskPath \$ExactTaskPath -ErrorAction Stop/u,
    );
    expect(setup).toMatch(
      /Disable-ScheduledTask -TaskName \$TaskName -TaskPath \$ExactTaskPath -ErrorAction Stop/u,
    );
    expect(setup).toMatch(
      /Unregister-ScheduledTask -TaskName \$TaskName -TaskPath \$ExactTaskPath -Confirm:\$false -ErrorAction Stop/u,
    );
    expect(setup).toMatch(
      /Register-ScheduledTask -TaskName \$TaskName -TaskPath \$ExactTaskPath /u,
    );
    expect(setup).toMatch(
      /\$ExistingTask\.TaskName\.Equals\([\s\S]+\$ExistingTask\.TaskPath\.Equals\(\$ExactTaskPath,[\s\S]+\$QuiescedTask\.TaskName\.Equals\([\s\S]+\$QuiescedTask\.TaskPath\.Equals\(\$ExactTaskPath,/u,
    );
  });

  it.runIf(process.platform === "win32")(
    "rejects duplicate ACL identities when owner or SYSTEM is omitted",
    () => {
      const source = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
      const start = source.indexOf("function Assert-OwnerOnlyAcl");
      const end = source.indexOf("function ", start + "function ".length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const helper = source.slice(start, end);
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "function Stop-Safely([string]$Code) { throw $Code }",
        helper,
        "$Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User",
        "$System = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)",
        "$OwnerName = $Owner.Translate([Security.Principal.NTAccount]).Value",
        "$OwnerRule = [Security.AccessControl.FileSystemAccessRule]::new($Owner, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)",
        "$SystemRule = [Security.AccessControl.FileSystemAccessRule]::new($System, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)",
        "function New-FakeAcl([object[]]$Rules) {",
        "  $Acl = [PSCustomObject]@{ Owner = $OwnerName; AreAccessRulesProtected = $true; RuleSet = $Rules }",
        "  $Acl | Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value { param($Explicit, $Inherited, $TargetType) return $this.RuleSet }",
        "  return $Acl",
        "}",
        "function Get-Acl { param([string]$LiteralPath) return $script:CurrentAcl }",
        "$script:CurrentAcl = New-FakeAcl @($OwnerRule, $SystemRule)",
        "Assert-OwnerOnlyAcl 'ignored' $Owner",
        "$OwnerDuplicateRejected = $false",
        "$script:CurrentAcl = New-FakeAcl @($OwnerRule, $OwnerRule)",
        "try { Assert-OwnerOnlyAcl 'ignored' $Owner } catch { $OwnerDuplicateRejected = $_.Exception.Message -eq 'HYBRID_CONFIG_ACL_INVALID' }",
        "$SystemDuplicateRejected = $false",
        "$script:CurrentAcl = New-FakeAcl @($SystemRule, $SystemRule)",
        "try { Assert-OwnerOnlyAcl 'ignored' $Owner } catch { $SystemDuplicateRejected = $_.Exception.Message -eq 'HYBRID_CONFIG_ACL_INVALID' }",
        '[Console]::Out.Write("$OwnerDuplicateRejected|$SystemDuplicateRejected")',
      ].join("\r\n");
      const powerShell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
      );
      const result = spawnSync(powerShell, [
        "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("True|True");
    },
  );
});
