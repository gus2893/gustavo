import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexCliProvider } from "../../lib/server/models/codex-cli";
import {
  isCodexContainerLaunchLocked,
  reconcileCodexContainers as reconcileProduction,
  runIsolatedCodex as runProduction,
  type CodexContainerIdentity,
  type CodexDockerController,
  type DockerCommandResult,
  type DockerCreateResult,
  type DockerInspection,
} from "../../worker/hybrid/codex-runner";

const IMAGE = `gustavo-codex@sha256:${"a".repeat(64)}`;
const OTHER_IMAGE = `gustavo-codex@sha256:${"b".repeat(64)}`;
const CONTAINER_ID = "c".repeat(64);
const AUTH_VOLUME = "gustavo-codex-auth-v1" as const;
const VALID_STDOUT = Buffer.from('{"response":"bounded response"}\n', "utf8");
const RECORDED_DOCKER_EXECUTABLE = process.platform === "win32"
  ? resolve(process.env.ProgramFiles ?? "C:\\Program Files", "Docker/Docker/resources/bin/docker.exe")
  : "/usr/bin/docker";
const UNIT_DOCKER_AUTHORITY = Object.freeze({
  dockerExecutable: RECORDED_DOCKER_EXECUTABLE,
  resolveDockerExecutable: async (recordedPath: string) => recordedPath,
});
const TOOL_OFF_CONFIG = Object.freeze([
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.apps=false",
  "features.multi_agent=false",
  "features.hooks=false",
  "features.skill_mcp_dependency_install=false",
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.browser_use_full_cdp_access=false",
  "features.computer_use=false",
  "features.in_app_browser=false",
  "features.enable_mcp_apps=false",
  "features.plugins=false",
  "features.remote_plugin=false",
  "features.tool_call_mcp_elicitation=false",
  "features.tool_suggest=false",
  "features.code_mode_host=false",
  "features.image_generation=false",
  "features.skill_search=false",
  "features.workspace_dependencies=false",
  "features.js_repl=false",
  "features.auth_elicitation=false",
  "features.goals=false",
  "features.plugin_sharing=false",
  "features.shell_snapshot=false",
  "tools.view_image=false",
  'web_search="disabled"',
  'history.persistence="none"',
  "feedback.enabled=false",
] as const);

type RunInput = Parameters<typeof runProduction>[0];
type ReconcileInput = Parameters<typeof reconcileProduction>[0];
type RunInputHasExecute = "execute" extends keyof RunInput ? true : false;
const RUN_INPUT_HAS_NO_EXECUTE: RunInputHasExecute = false;

function runIsolatedCodex(
  input: Omit<RunInput, "dockerExecutable" | "resolveDockerExecutable">
    & Partial<Pick<RunInput, "dockerExecutable" | "resolveDockerExecutable">>,
): ReturnType<typeof runProduction> {
  return runProduction({ ...UNIT_DOCKER_AUTHORITY, ...input } as RunInput);
}

function reconcileCodexContainers(
  input: Omit<ReconcileInput, "dockerExecutable" | "resolveDockerExecutable">
    & Partial<Pick<ReconcileInput, "dockerExecutable" | "resolveDockerExecutable">>,
): ReturnType<typeof reconcileProduction> {
  return reconcileProduction({ ...UNIT_DOCKER_AUTHORITY, ...input } as ReconcileInput);
}

function exactInspection(
  identity: CodexContainerIdentity,
  state: DockerInspection["state"],
  overrides: Partial<DockerInspection> = {},
): DockerInspection {
  return {
    id: identity.containerId ?? CONTAINER_ID,
    name: identity.name,
    image: identity.image,
    labels: identity.labels,
    state,
    exitCode: state === "exited" ? 0 : null,
    ...overrides,
  };
}

function commandResult(overrides: Partial<DockerCommandResult> = {}): DockerCommandResult {
  return {
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}

function createResult(overrides: Partial<DockerCreateResult> = {}): DockerCreateResult {
  return {
    ...commandResult(),
    helperExitProven: true,
    completion: "NATURAL",
    ...overrides,
  };
}

function emptyController(): CodexDockerController {
  return {
    acquireHostLease: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
    create: vi.fn(async () => createResult({ stdout: Buffer.from(`${CONTAINER_ID}\n`) })),
    start: vi.fn(async () => commandResult({ stdout: VALID_STDOUT })),
    wait: vi.fn(async () => ({ helperExitCode: 0, containerExitCode: 0 })),
    kill: vi.fn(async () => ({ helperExitCode: 0 })),
    remove: vi.fn(async () => ({ helperExitCode: 0 })),
    inspect: vi.fn(async () => ({ daemonAvailable: true, exists: false })),
    list: vi.fn(async () => ({ daemonAvailable: true, names: [] })),
  };
}

function completedLifecycleController(input: {
  readonly exitCode?: number;
  readonly stdout?: Uint8Array;
  readonly stderr?: Uint8Array;
  readonly events?: string[];
  readonly removeExitCode?: number;
  readonly waitHelperExitCode?: number;
  readonly overflow?: "STDOUT" | "STDERR";
} = {}): CodexDockerController {
  const events = input.events ?? [];
  let inspections = 0;
  return {
    ...emptyController(),
    create: vi.fn(async ({ args }) => {
      events.push("create");
      expect(args[0]).toBe("create");
      return createResult({ stdout: Buffer.from(`${CONTAINER_ID}\n`) });
    }),
    wait: vi.fn(async () => {
      events.push("wait");
      return {
        helperExitCode: input.waitHelperExitCode ?? 0,
        containerExitCode: input.exitCode ?? 0,
      };
    }),
    start: vi.fn(async ({ stdin }) => {
      events.push("start");
      expect(stdin).toEqual(Buffer.from("private prompt"));
      return commandResult({
        exitCode: input.exitCode ?? 0,
        stdout: input.stdout ?? VALID_STDOUT,
        stderr: input.stderr ?? Buffer.alloc(0),
        ...(input.overflow === undefined ? {} : { overflow: input.overflow }),
      });
    }),
    inspect: vi.fn(async ({ identity }) => {
      inspections += 1;
      events.push(`inspect-${inspections}`);
      if (inspections === 1) {
        return {
          daemonAvailable: true,
          exists: true,
          inspection: exactInspection(identity, "created"),
        };
      }
      if (inspections === 2) {
        return {
          daemonAvailable: true,
          exists: true,
          inspection: exactInspection(identity, "exited", { exitCode: input.exitCode ?? 0 }),
        };
      }
      return { daemonAvailable: true, exists: false };
    }),
    remove: vi.fn(async () => {
      events.push("remove");
      return { helperExitCode: input.removeExitCode ?? 0 };
    }),
  };
}

async function clearLaunchLock(): Promise<void> {
  let present = true;
  const controller = emptyController();
  controller.inspect = vi.fn(async ({ identity }) => present
    ? {
      daemonAvailable: true,
      exists: true,
      inspection: exactInspection(identity, "created"),
    }
    : { daemonAvailable: true, exists: false });
  controller.remove = vi.fn(async () => {
    present = false;
    return { helperExitCode: 0 };
  });
  await reconcileCodexContainers({
    image: IMAGE,
    controller,
  });
}

afterEach(async () => {
  await clearLaunchLock();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Codex model provider", () => {
  it("maps one bounded role request and never exposes a paid fallback", async () => {
    const run = vi.fn().mockResolvedValue({ response: "Node answer" });
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run,
    });

    const events = [];
    for await (const event of provider.stream({
      role: "NODE",
      modelId: "gpt-5.6-sol",
      input: "encrypted-source prompt after authorized load",
      maxOutputTokens: 800,
    })) events.push(event);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      role: "NODE",
      prompt: "encrypted-source prompt after authorized load",
      model: "gpt-5.6-sol",
      timeoutMs: 90_000,
    }));
    expect(events).toEqual([
      { type: "DELTA", text: "Node answer", outputTokens: 11 },
      {
        type: "COMPLETED",
        usage: {
          inputTokens: 45,
          outputTokens: 11,
          estimatedCostMicrousd: 0n,
          providerMetering: { status: "UNKNOWN" },
        },
      },
    ]);
    expect(provider.providerId).toBe("codex-cli");
    expect(provider).not.toHaveProperty("fallback");
  });

  it("preserves bounded runner-reported usage separately from zero-cost observed counts", async () => {
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run: vi.fn().mockResolvedValue({
        response: "reported answer",
        usage: { inputTokens: 77, outputTokens: 9 },
      }),
    });

    const events = [];
    for await (const event of provider.stream({
      role: "EVALUATOR",
      modelId: "gpt-5.6-sol",
      input: "observed input",
      maxOutputTokens: 20,
    })) events.push(event);

    expect(events.at(-1)).toEqual({
      type: "COMPLETED",
      usage: {
        inputTokens: 14,
        outputTokens: 15,
        estimatedCostMicrousd: 0n,
        providerMetering: {
          status: "REPORTED",
          inputTokens: 77,
          outputTokens: 9,
        },
      },
    });
  });

  it.each([
    ["NODE", 90_000],
    ["EVALUATOR", 180_000],
    ["MAIN", 300_000],
  ] as const)("uses the fixed %s deadline", async (role, timeoutMs) => {
    const run = vi.fn().mockResolvedValue({ response: "ok" });
    const provider = createCodexCliProvider({ model: "gpt-5.6-sol", run });

    for await (const _event of provider.stream({
      role,
      modelId: "gpt-5.6-sol",
      input: "prompt",
      maxOutputTokens: 2,
    })) {
      // Drain the adapter so the runner call and completion are observed.
    }

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ role, timeoutMs }));
  });

  it("rejects the wrong model and an over-limit response before yielding output", async () => {
    const wrongModelRun = vi.fn().mockResolvedValue({ response: "unused" });
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run: wrongModelRun,
    });
    const wrongModel = provider.stream({
      role: "NODE",
      modelId: "another-model",
      input: "prompt",
      maxOutputTokens: 10,
    })[Symbol.asyncIterator]();
    await expect(wrongModel.next()).rejects.toThrow("PROVIDER_REQUEST_INVALID");
    expect(wrongModelRun).not.toHaveBeenCalled();

    const overLimitRun = vi.fn().mockResolvedValue({ response: "two tokens" });
    const bounded = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run: overLimitRun,
    }).stream({
      role: "MAIN",
      modelId: "gpt-5.6-sol",
      input: "prompt",
      maxOutputTokens: 1,
    })[Symbol.asyncIterator]();
    await expect(bounded.next()).rejects.toThrow("PROVIDER_REQUEST_INVALID");
  });

  it("rejects an unsupported runtime role before invoking the local runner", async () => {
    const run = vi.fn().mockResolvedValue({ response: "unused" });
    const provider = createCodexCliProvider({ model: "gpt-5.6-sol", run });
    const iterator = provider.stream({
      role: "ADMIN" as "NODE",
      modelId: "gpt-5.6-sol",
      input: "prompt",
      maxOutputTokens: 10,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow("PROVIDER_REQUEST_INVALID");
    expect(run).not.toHaveBeenCalled();
  });

  it("uses conservative allocation-bounded UTF-8 counts for every model bound", () => {
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run: vi.fn().mockResolvedValue({ response: "unused" }),
    });

    expect(provider.countInputTokens("")).toBe(0);
    expect(provider.countInputTokens(" \t\n")).toBe(3);
    expect(provider.countInputTokens("你好")).toBe(6);
    expect(provider.countInputTokens("a,b!")).toBe(4);
    expect(provider.countInputTokens("x".repeat(65_536))).toBe(65_536);
    expect(provider.estimateUsage("你好", "a,b!", "gpt-5.6-sol")).toEqual({
      inputTokens: 6,
      outputTokens: 4,
      estimatedCostMicrousd: 0n,
      providerMetering: { status: "UNKNOWN" },
    });
  });

  it("rejects conservative CJK output overflow before yielding a delta", async () => {
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run: vi.fn().mockResolvedValue({ response: "你好" }),
    });
    const iterator = provider.stream({
      role: "NODE",
      modelId: "gpt-5.6-sol",
      input: "prompt",
      maxOutputTokens: 5,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow("PROVIDER_REQUEST_INVALID");
  });

  it.each([
    ["CODEX_QUOTA_EXHAUSTED", "PROVIDER_RATE_LIMITED"],
    ["CODEX_AUTH_UNAVAILABLE", "PROVIDER_AUTHENTICATION_FAILED"],
    ["CODEX_MODEL_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"],
    ["CODEX_TIMEOUT", "UPSTREAM_UNAVAILABLE"],
    ["CODEX_OUTPUT_INVALID", "UPSTREAM_UNAVAILABLE"],
    ["CODEX_CONTAINER_TERMINATION_UNPROVEN", "UPSTREAM_UNAVAILABLE"],
    ["CODEX_CONTAINER_LOCKED", "UPSTREAM_UNAVAILABLE"],
    ["SECRET_DOCKER_FAILURE", "UPSTREAM_UNAVAILABLE"],
  ] as const)("maps %s to only the safe provider error %s", async (runnerCode, safeCode) => {
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run: vi.fn().mockRejectedValue(new Error(runnerCode)),
    });
    const iterator = provider.stream({
      role: "NODE",
      modelId: "gpt-5.6-sol",
      input: "prompt",
      maxOutputTokens: 10,
    })[Symbol.asyncIterator]();

    let caught: unknown;
    try {
      await iterator.next();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ message: safeCode, code: safeCode });
    expect(String(caught)).not.toContain("SECRET");
    expect(provider).not.toHaveProperty("fallback");
  });

  it("normalizes an unreadable runner result without exposing its error", async () => {
    const secretResult = Object.defineProperty({}, "usage", {
      get() {
        throw new Error("SECRET_RUNNER_USAGE");
      },
    });
    let responseReads = 0;
    Object.defineProperty(secretResult, "response", {
      get() {
        responseReads += 1;
        return "answer";
      },
    });
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run: vi.fn().mockResolvedValue(secretResult),
    });
    const iterator = provider.stream({
      role: "NODE",
      modelId: "gpt-5.6-sol",
      input: "prompt",
      maxOutputTokens: 10,
    })[Symbol.asyncIterator]();

    let caught: unknown;
    try {
      await iterator.next();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "UPSTREAM_UNAVAILABLE",
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(String(caught)).not.toContain("SECRET");
    expect(responseReads).toBe(1);
  });

  it("snapshots and validates the local runner exactly once at construction", async () => {
    const pinnedRun = vi.fn().mockResolvedValue({ response: "pinned" });
    const swappedRun = vi.fn().mockResolvedValue({ response: "fallback" });
    let runReads = 0;
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      get run() {
        runReads += 1;
        return runReads === 1 ? pinnedRun : swappedRun;
      },
    });
    expect(runReads).toBe(1);

    const events = [];
    for await (const event of provider.stream({
      role: "NODE",
      modelId: "gpt-5.6-sol",
      input: "prompt",
      maxOutputTokens: 20,
    })) events.push(event);

    expect(runReads).toBe(1);
    expect(pinnedRun).toHaveBeenCalledOnce();
    expect(swappedRun).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: "DELTA", text: "pinned" });
  });
});

describe("container-isolated Codex runner", () => {
  it("performs zero Docker actions when another process owns the run lease", async () => {
    const controller = emptyController() as CodexDockerController & {
      acquireHostLease: ReturnType<typeof vi.fn>;
    };
    controller.acquireHostLease = vi.fn(async () => undefined);
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller,
    })).rejects.toThrow(/^CODEX_CONTAINER_BUSY$/u);
    expect(controller.create).not.toHaveBeenCalled();
    expect(controller.inspect).not.toHaveBeenCalled();
    expect(controller.kill).not.toHaveBeenCalled();
    expect(controller.remove).not.toHaveBeenCalled();
  });

  it("performs zero Docker actions when another process owns the reconcile lease", async () => {
    const controller = emptyController() as CodexDockerController & {
      acquireHostLease: ReturnType<typeof vi.fn>;
    };
    controller.acquireHostLease = vi.fn(async () => undefined);
    await expect(reconcileCodexContainers({ image: IMAGE, controller }))
      .rejects.toThrow(/^CODEX_CONTAINER_RECONCILIATION_FAILED$/u);
    expect(controller.create).not.toHaveBeenCalled();
    expect(controller.inspect).not.toHaveBeenCalled();
    expect(controller.kill).not.toHaveBeenCalled();
    expect(controller.remove).not.toHaveBeenCalled();
  });

  it("allows a new process to lease and reconcile a stale exact singleton after crash release", async () => {
    let externallyHeld = true;
    let present = true;
    const controller = emptyController() as CodexDockerController & {
      acquireHostLease: ReturnType<typeof vi.fn>;
    };
    controller.acquireHostLease = vi.fn(async () => externallyHeld
      ? undefined
      : { release: vi.fn(async () => undefined) });
    controller.inspect = vi.fn(async ({ identity }) => present
      ? {
        daemonAvailable: true,
        exists: true,
        inspection: exactInspection(identity, "created"),
      }
      : { daemonAvailable: true, exists: false });
    controller.remove = vi.fn(async ({ identity }) => {
      expect(identity.containerId).toBe(CONTAINER_ID);
      present = false;
      return { helperExitCode: 0 };
    });

    await expect(reconcileCodexContainers({ image: IMAGE, controller }))
      .rejects.toThrow(/^CODEX_CONTAINER_RECONCILIATION_FAILED$/u);
    expect(controller.inspect).not.toHaveBeenCalled();
    externallyHeld = false;
    await expect(reconcileCodexContainers({ image: IMAGE, controller }))
      .resolves.toEqual({ reconciled: true });
    expect(controller.remove).toHaveBeenCalledTimes(1);
  });

  it("exposes no generic execute escape hatch around Docker authority", async () => {
    expect(RUN_INPUT_HAS_NO_EXECUTE).toBe(false);
    const source = await readFile(resolve("worker/hybrid/codex-runner.ts"), "utf8");
    expect(source).not.toMatch(/export\s+type\s+CodexContainerExecute|readonly\s+execute\?/u);
    expect(source).not.toMatch(
      /export\s+(?:async\s+)?function\s+(?:rawDockerCommand|executeWithController)/u,
    );
    const escapedExecute = vi.fn(async () => ({ bypassed: true }));
    await expect(runProduction({
      ...UNIT_DOCKER_AUTHORITY,
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      execute: escapedExecute,
    } as unknown as RunInput)).rejects.toThrow(/^CODEX_CONTAINER_CONFIGURATION_INVALID$/u);
    expect(escapedExecute).not.toHaveBeenCalled();
  });

  it("uses Docker-owned singleton authority across runs and reconciliation", async () => {
    const events: string[] = [];
    let inspections = 0;
    const controller = emptyController();
    controller.create = vi.fn(async ({ args }) => {
      expect(args[args.indexOf("--name") + 1]).toBe("gustavo-codex-singleton-v1");
      return createResult({ stdout: Buffer.from(`${CONTAINER_ID}\n`) });
    });
    controller.inspect = vi.fn(async ({ identity }) => {
      events.push(`inspect:${identity.containerId ?? identity.name}`);
      expect(identity.name).toBe("gustavo-codex-singleton-v1");
      expect(identity.containerId).toBe(CONTAINER_ID);
      inspections += 1;
      if (inspections === 1) {
        return { daemonAvailable: true, exists: true, inspection: exactInspection(identity, "created") };
      }
      if (inspections === 2) {
        return {
          daemonAvailable: true,
          exists: true,
          inspection: exactInspection(identity, "exited", { exitCode: 0 }),
        };
      }
      return { daemonAvailable: true, exists: false };
    });
    controller.wait = vi.fn(async ({ identity }) => {
      events.push(`wait:${identity.containerId ?? identity.name}`);
      return { helperExitCode: 0, containerExitCode: 0 };
    });
    controller.start = vi.fn(async ({ identity }) => {
      events.push(`start:${identity.containerId ?? identity.name}`);
      return commandResult({ stdout: VALID_STDOUT });
    });
    controller.remove = vi.fn(async ({ identity }) => {
      events.push(`remove:${identity.containerId ?? identity.name}`);
      return { helperExitCode: 0 };
    });

    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller,
    })).resolves.toEqual({ response: "bounded response" });
    expect(events).toEqual([
      `inspect:${CONTAINER_ID}`,
      `wait:${CONTAINER_ID}`,
      `start:${CONTAINER_ID}`,
      `inspect:${CONTAINER_ID}`,
      `remove:${CONTAINER_ID}`,
      `inspect:${CONTAINER_ID}`,
    ]);
  });

  it("uses the Docker name collision as the serializer across independent runner instances", async () => {
    const firstRun = runProduction;
    vi.resetModules();
    const secondModule = await import("../../worker/hybrid/codex-runner");
    const names: string[] = [];
    let ownerIdentity: CodexContainerIdentity | undefined;
    let present = true;
    let ownerInspections = 0;
    let started!: () => void;
    const startBegan = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    let releaseStart!: () => void;
    const firstController = emptyController();
    firstController.create = vi.fn(async ({ args }) => {
      names.push(args[args.indexOf("--name") + 1]);
      return createResult({ stdout: Buffer.from(`${CONTAINER_ID}\n`) });
    });
    firstController.inspect = vi.fn(async ({ identity }) => {
      ownerIdentity ??= identity;
      if (!present) return { daemonAvailable: true, exists: false };
      ownerInspections += 1;
      const state = ownerInspections === 1 ? "created" : "exited";
      return {
        daemonAvailable: true,
        exists: true,
        inspection: exactInspection(identity, state, {
          exitCode: state === "created" ? null : 137,
        }),
      };
    });
    firstController.start = vi.fn(async () => {
      started();
      return new Promise<DockerCommandResult>((resolveStart) => {
        releaseStart = () => resolveStart(commandResult({ exitCode: 137 }));
      });
    });
    firstController.wait = vi.fn(async () => ({ helperExitCode: 0, containerExitCode: 137 }));
    firstController.kill = vi.fn(async () => {
      releaseStart();
      return { helperExitCode: 0 };
    });
    firstController.remove = vi.fn(async () => {
      present = false;
      return { helperExitCode: 0 };
    });

    const firstAbort = new AbortController();
    const first = firstRun({
      ...UNIT_DOCKER_AUTHORITY,
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: firstAbort.signal,
      controller: firstController,
    });
    await startBegan;

    const secondController = emptyController();
    secondController.create = vi.fn(async ({ args }) => {
      names.push(args[args.indexOf("--name") + 1]);
      return createResult({ exitCode: 125, stderr: Buffer.from("name already in use") });
    });
    secondController.inspect = vi.fn(async () => ({
      daemonAvailable: true,
      exists: true,
      inspection: exactInspection(ownerIdentity as CodexContainerIdentity, "running"),
    }));
    let secondFailure: unknown;
    try {
      await secondModule.runIsolatedCodex({
        ...UNIT_DOCKER_AUTHORITY,
        role: "NODE",
        prompt: "second private prompt",
        image: IMAGE,
        authVolume: AUTH_VOLUME,
        timeoutMs: 30_000,
        controller: secondController,
      });
    } catch (error) {
      secondFailure = error;
    }
    firstAbort.abort();
    await expect(first).rejects.toThrow(/^CODEX_ABORTED$/u);
    await secondModule.reconcileCodexContainers({
      ...UNIT_DOCKER_AUTHORITY,
      image: IMAGE,
      controller: emptyController(),
    });
    expect(secondFailure).toEqual(expect.objectContaining({ message: "CODEX_CONTAINER_BUSY" }));
    expect(names).toEqual(["gustavo-codex-singleton-v1", "gustavo-codex-singleton-v1"]);
    expect(secondController.start).not.toHaveBeenCalled();
    expect(secondController.kill).not.toHaveBeenCalled();
    expect(secondController.remove).not.toHaveBeenCalled();
  });

  it("never removes an incumbent singleton when its own create loses the name collision", async () => {
    const incumbentIdentity: CodexContainerIdentity = Object.freeze({
      name: "gustavo-codex-singleton-v1",
      runId: "f".repeat(32),
      image: IMAGE,
      labels: Object.freeze({
        "com.gustavo.codex-runner": "v1",
        "com.gustavo.codex-run-id": "f".repeat(32),
      }),
    });
    const controller = emptyController();
    controller.create = vi.fn(async () => createResult({
      exitCode: 125,
      stderr: Buffer.from("name already in use"),
    }));
    controller.inspect = vi.fn(async () => ({
      daemonAvailable: true,
      exists: true,
      inspection: exactInspection(incumbentIdentity, "running"),
    }));

    await expect(runIsolatedCodex({
      ...UNIT_DOCKER_AUTHORITY,
      role: "NODE",
      prompt: "must not reach the incumbent",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller,
    })).rejects.toThrow(/^CODEX_CONTAINER_BUSY$/u);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.wait).not.toHaveBeenCalled();
    expect(controller.kill).not.toHaveBeenCalled();
    expect(controller.remove).not.toHaveBeenCalled();
  });

  it("reconciles the fixed singleton by exact name after process restart and binds its ID", async () => {
    const staleIdentity: CodexContainerIdentity = Object.freeze({
      name: "gustavo-codex-singleton-v1",
      runId: "d".repeat(32),
      image: IMAGE,
      labels: Object.freeze({
        "com.gustavo.codex-runner": "v1",
        "com.gustavo.codex-run-id": "d".repeat(32),
      }),
    });
    let present = true;
    const controller = emptyController();
    controller.list = vi.fn(async () => {
      throw new Error("fixed-name reconciliation must not scan labels");
    });
    controller.inspect = vi.fn(async ({ identity }) => {
      expect(identity.name).toBe("gustavo-codex-singleton-v1");
      if (!present) return { daemonAvailable: true, exists: false };
      return {
        daemonAvailable: true,
        exists: true,
        inspection: exactInspection(staleIdentity, "created"),
      };
    });
    controller.remove = vi.fn(async ({ identity }) => {
      expect(identity.containerId).toBe(CONTAINER_ID);
      expect(identity.name).toBe("gustavo-codex-singleton-v1");
      present = false;
      return { helperExitCode: 0 };
    });

    await expect(reconcileCodexContainers({ image: IMAGE, controller }))
      .resolves.toEqual({ reconciled: true });
    expect(controller.list).not.toHaveBeenCalled();
    expect(controller.remove).toHaveBeenCalledTimes(1);
  });

  it("claims one synchronous owner token across concurrent reconciliation attempts", async () => {
    let releaseFirst!: () => void;
    let announceFirst!: () => void;
    const firstResolverBegan = new Promise<void>((resolveBegan) => {
      announceFirst = resolveBegan;
    });
    const firstResolver = vi.fn(async (recordedPath: string) => {
      announceFirst();
      await new Promise<void>((resolveRelease) => {
        releaseFirst = resolveRelease;
      });
      return recordedPath;
    });
    const first = reconcileCodexContainers({
      image: IMAGE,
      controller: emptyController(),
      resolveDockerExecutable: firstResolver,
    });
    await firstResolverBegan;

    const secondResolver = vi.fn(async (recordedPath: string) => recordedPath);
    await expect(reconcileCodexContainers({
      image: IMAGE,
      controller: emptyController(),
      resolveDockerExecutable: secondResolver,
    })).rejects.toThrow(/^CODEX_CONTAINER_RECONCILIATION_FAILED$/u);
    expect(secondResolver).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toEqual({ reconciled: true });
  });

  it("propagates reconcile cancellation without releasing its lease before helper settlement", async () => {
    const external = new AbortController();
    const releaseLease = vi.fn(async () => undefined);
    let announceInspect!: () => void;
    let settleInspect!: () => void;
    let helperSignal: AbortSignal | undefined;
    const inspectBegan = new Promise<void>((resolveBegan) => { announceInspect = resolveBegan; });
    const inspectGate = new Promise<{
      readonly daemonAvailable: true;
      readonly exists: false;
    }>((resolveInspect) => {
      settleInspect = () => resolveInspect({ daemonAvailable: true, exists: false });
    });
    const controller = emptyController();
    controller.acquireHostLease = vi.fn(async () => ({ release: releaseLease }));
    controller.inspect = vi.fn(async ({ signal }) => {
      helperSignal = signal;
      announceInspect();
      return inspectGate;
    });
    const reconciliation = reconcileCodexContainers({
      image: IMAGE,
      controller,
      signal: external.signal,
    });
    void reconciliation.catch(() => undefined);
    await inspectBegan;

    try {
      external.abort();
      await Promise.resolve();
      expect(helperSignal?.aborted).toBe(true);
      expect(releaseLease).not.toHaveBeenCalled();

      const overlap = emptyController();
      await expect(reconcileCodexContainers({ image: IMAGE, controller: overlap }))
        .rejects.toThrow(/^CODEX_CONTAINER_RECONCILIATION_FAILED$/u);
      expect(overlap.acquireHostLease).not.toHaveBeenCalled();
    } finally {
      settleInspect();
      await reconciliation.catch(() => undefined);
    }

    await expect(reconciliation).rejects.toThrow(/^CODEX_CONTAINER_RECONCILIATION_FAILED$/u);
    expect(releaseLease).toHaveBeenCalledOnce();
    await expect(reconcileCodexContainers({ image: IMAGE, controller: emptyController() }))
      .resolves.toEqual({ reconciled: true });
  });

  it("retains execution ownership after a bounded timeout until the underlying promise settles", async () => {
    vi.useFakeTimers();
    try {
      let settleStart!: (result: DockerCommandResult) => void;
      let announceExecution!: () => void;
      const executionBegan = new Promise<void>((resolveBegan) => {
        announceExecution = resolveBegan;
      });
      let inspections = 0;
      const releaseLease = vi.fn(async () => undefined);
      const controller = emptyController() as CodexDockerController & {
        acquireHostLease: ReturnType<typeof vi.fn>;
      };
      controller.acquireHostLease = vi.fn(async () => ({ release: releaseLease }));
      controller.inspect = vi.fn(async ({ identity }) => {
        inspections += 1;
        if (inspections === 1) {
          return { daemonAvailable: true, exists: true, inspection: exactInspection(identity, "created") };
        }
        if (inspections === 2) {
          return {
            daemonAvailable: true,
            exists: true,
            inspection: exactInspection(identity, "exited", { exitCode: 137 }),
          };
        }
        return { daemonAvailable: true, exists: false };
      });
      controller.start = vi.fn(async () => {
        announceExecution();
        return new Promise<DockerCommandResult>((resolveStart) => {
          settleStart = resolveStart;
        });
      });
      controller.wait = vi.fn(async () => ({ helperExitCode: 0, containerExitCode: 137 }));
      const running = runIsolatedCodex({
        role: "NODE",
        prompt: "private prompt",
        image: IMAGE,
        authVolume: AUTH_VOLUME,
        timeoutMs: 1_000,
        controller,
      });
      const observed = running.then(
        () => "resolved",
        (error: unknown) => error,
      );
      await executionBegan;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await observed).toEqual(expect.objectContaining({
        message: "CODEX_CONTAINER_TERMINATION_UNPROVEN",
      }));
      expect(releaseLease).not.toHaveBeenCalled();

      const overlappingController = emptyController();
      await expect(reconcileCodexContainers({
        image: IMAGE,
        controller: overlappingController,
      })).rejects.toThrow(/^CODEX_CONTAINER_RECONCILIATION_FAILED$/u);
      expect(overlappingController.inspect).not.toHaveBeenCalled();
      expect(overlappingController.list).not.toHaveBeenCalled();

      settleStart(commandResult({ exitCode: 137 }));
      await Promise.resolve();
      await vi.waitFor(() => expect(releaseLease).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      await Promise.resolve();
      await expect(reconcileCodexContainers({ image: IMAGE, controller: emptyController() }))
        .resolves.toEqual({ reconciled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one fixed tool-free create command and keeps prompt bytes out of create", async () => {
    const events: string[] = [];
    const controller = completedLifecycleController({ events });
    const result = await runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller,
    });

    const invocation = (controller.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(invocation.args.slice(0, 2)).toEqual(["create", "-i"]);
    expect(invocation.args).not.toContain("--rm");
    expect(invocation.args).toEqual(expect.arrayContaining([
      "--read-only", "--init", "--cap-drop=ALL",
      "--security-opt", "no-new-privileges:true", "--pids-limit", "64",
      "--memory", "512m", "--cpus", "1.0", "--network", "bridge",
      "--pull=never", "--tmpfs", "/workspace:rw,noexec,nosuid,nodev,size=16777216",
      "--mount", "type=volume,src=gustavo-codex-auth-v1,dst=/codex-home",
      "--env", "CODEX_HOME=/codex-home",
      "/usr/bin/timeout", "--signal=KILL", "--kill-after=5s", "30s",
      "codex", "exec", "--ephemeral", "--ignore-user-config",
      "--skip-git-repo-check", "--sandbox", "read-only",
      "--ask-for-approval", "never", "--model", "gpt-5.6-sol", "--json",
      "--output-schema", "/schemas/node.schema.json", "-C", "/workspace", "-",
    ]));
    for (const config of TOOL_OFF_CONFIG) {
      const index = invocation.args.indexOf(config);
      expect(index).toBeGreaterThan(0);
      expect(invocation.args[index - 1]).toBe("--config");
    }
    expect(invocation.args.filter((argument: string) => argument === "--mount")).toHaveLength(1);
    expect(invocation.args.join(" ")).not.toMatch(/mcp_servers|connector|docker\.sock|DATABASE_URL|VALKEY_URL|FINNHUB|QSTASH|TAILSCALE/iu);
    expect(invocation.args).not.toContain("private prompt");
    expect(invocation.env).not.toHaveProperty("PATH");
    expect(controller.start).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({
        name: "gustavo-codex-singleton-v1",
        containerId: CONTAINER_ID,
      }),
      stdin: Buffer.from("private prompt"),
    }));
    expect(result).toEqual({ response: "bounded response" });
  });

  it("requires the recorded absolute Docker path and ignores hostile PATH and ProgramFiles", async () => {
    const hostileDirectory = await mkdtemp(join(tmpdir(), "gustavo-hostile-docker-"));
    const marker = join(hostileDirectory, "prompt-leaked");
    await writeFile(join(hostileDirectory, process.platform === "win32" ? "docker.cmd" : "docker"),
      process.platform === "win32" ? `@echo leaked>${marker}\r\n` : `#!/bin/sh\nprintf leaked > '${marker}'\n`,
      { mode: 0o755 });
    vi.stubEnv("PATH", hostileDirectory);
    vi.stubEnv("ProgramFiles", hostileDirectory);
    try {
      const controller = completedLifecycleController();
      await expect(runIsolatedCodex({
        role: "NODE",
        prompt: "private prompt",
        image: IMAGE,
        authVolume: AUTH_VOLUME,
        timeoutMs: 30_000,
        controller,
      })).resolves.toEqual({ response: "bounded response" });
      await expect(access(marker)).rejects.toThrow();
      await expect(runProduction({
        role: "NODE",
        prompt: "private prompt",
        image: IMAGE,
        authVolume: AUTH_VOLUME,
        timeoutMs: 30_000,
        dockerExecutable: "docker",
        controller,
      })).rejects.toThrow("CODEX_DOCKER_EXECUTABLE_INVALID");
    } finally {
      await rm(hostileDirectory, { recursive: true, force: true });
    }
  });

  it("owns the single launch synchronously while Docker executable authority resolves", async () => {
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolveGate) => {
      releaseResolver = resolveGate;
    });
    const resolver = vi.fn(async (recordedPath: string) => {
      await resolverGate;
      return recordedPath;
    });
    const events: string[] = [];
    const controller = completedLifecycleController({ events });
    const secondController = completedLifecycleController();
    const first = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      resolveDockerExecutable: resolver,
      controller,
    });
    const second = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      resolveDockerExecutable: resolver,
      controller: secondController,
    });
    await Promise.resolve();
    const resolverCallsBeforeRelease = resolver.mock.calls.length;
    releaseResolver();
    const secondOutcome = second.then(
      () => "RESOLVED",
      (error: unknown) => error instanceof Error ? error.message : "UNKNOWN",
    );
    const firstOutcome = await first.then(
      (value) => value,
      (error: unknown) => error,
    );
    expect(firstOutcome, events.join(",")).toEqual({ response: "bounded response" });
    await expect(secondOutcome).resolves.toBe("CODEX_CONTAINER_BUSY");
    expect(resolverCallsBeforeRelease).toBe(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(controller.create).toHaveBeenCalledTimes(1);
  });

  it("observes abort during delayed executable resolution before any Docker controller call", async () => {
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolveGate) => {
      releaseResolver = resolveGate;
    });
    const controller = emptyController();
    const abort = new AbortController();
    const running = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: abort.signal,
      resolveDockerExecutable: async (recordedPath) => {
        await resolverGate;
        return recordedPath;
      },
      controller,
    });
    abort.abort();
    releaseResolver();
    await expect(running).rejects.toThrow(/^CODEX_ABORTED$/u);
    expect(controller.create).not.toHaveBeenCalled();
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it("rejects caller-controlled role, model, image, volume, input, timeout, or dependencies", async () => {
    const base = {
      role: "NODE" as const,
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController(),
    };
    await expect(runIsolatedCodex({ ...base, role: "ADMIN" as "NODE" }))
      .rejects.toThrow("CODEX_ROLE_UNSUPPORTED");
    await expect(runIsolatedCodex({ ...base, model: "fallback" as never }))
      .rejects.toThrow("CODEX_MODEL_UNAVAILABLE");
    await expect(runIsolatedCodex({ ...base, image: "gustavo-codex:latest" }))
      .rejects.toThrow("CODEX_IMAGE_INVALID");
    await expect(runIsolatedCodex({ ...base, authVolume: "host" as typeof AUTH_VOLUME }))
      .rejects.toThrow("CODEX_AUTH_VOLUME_INVALID");
    await expect(runIsolatedCodex({ ...base, prompt: "" }))
      .rejects.toThrow("CODEX_INPUT_INVALID");
    await expect(runIsolatedCodex({ ...base, timeoutMs: 999 }))
      .rejects.toThrow("CODEX_TIMEOUT_INVALID");
    await expect(runIsolatedCodex({ ...base, dockerExecutable: undefined as never }))
      .rejects.toThrow("CODEX_DOCKER_EXECUTABLE_INVALID");
    await expect(runProduction({
      ...UNIT_DOCKER_AUTHORITY,
      ...base,
      execute: vi.fn(),
    } as unknown as RunInput)).rejects.toThrow("CODEX_CONTAINER_CONFIGURATION_INVALID");
  });

  it("accepts one strict bounded response and rejects malformed, extra, fatal UTF-8, and overflow", async () => {
    const invoke = (result: DockerCommandResult) => runIsolatedCodex({
      role: "EVALUATOR",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        overflow: result.overflow,
      }),
    });
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify({ response: "event response" }) },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 12,
          cached_input_tokens: 4,
          cache_write_input_tokens: 1,
          output_tokens: 3,
          reasoning_output_tokens: 2,
        },
      }),
      "",
    ].join("\n");
    await expect(invoke(commandResult({ stdout: Buffer.from(events) })))
      .resolves.toEqual({
        response: "event response",
        usage: { inputTokens: 12, outputTokens: 3 },
      });
    for (const invalid of [
      commandResult({ stdout: Buffer.from("not-json\n") }),
      commandResult({ stdout: Buffer.from('{"response":"answer","extra":true}\n') }),
      commandResult({ stdout: Buffer.from([0xff]) }),
      commandResult({ stderr: Buffer.from([0xff]) }),
      commandResult({ stdout: Buffer.alloc(0), overflow: "STDOUT" }),
      commandResult({ stdout: Buffer.alloc(1_048_577) }),
    ]) await expect(invoke(invalid)).rejects.toThrow("CODEX_OUTPUT_INVALID");
  });

  it("returns an explicit absence of provider usage when turn completion omits it", async () => {
    const events = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify({ response: "no usage" }) },
      }),
      JSON.stringify({ type: "turn.completed" }),
      "",
    ].join("\n");

    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({ stdout: Buffer.from(events) }),
    })).resolves.toEqual({ response: "no usage" });
  });

  it.each([
    {
      input_tokens: -1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
    {
      input_tokens: 1,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
    {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1.5,
      reasoning_output_tokens: 0,
    },
    {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 1_000_000_001,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
    {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: -1,
    },
    {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      extra: 1,
    },
  ])("rejects malformed reported usage before returning output: $usage", async (usage) => {
    const events = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify({ response: "discard me" }) },
      }),
      JSON.stringify({ type: "turn.completed", usage }),
      "",
    ].join("\n");

    await expect(runIsolatedCodex({
      role: "MAIN",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({ stdout: Buffer.from(events) }),
    })).rejects.toThrow("CODEX_OUTPUT_INVALID");
  });

  it("rejects duplicate reported usage before returning output", async () => {
    const events = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify({ response: "discard me" }) },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      }),
      "",
    ].join("\n");

    await expect(runIsolatedCodex({
      role: "EVALUATOR",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({ stdout: Buffer.from(events) }),
    })).rejects.toThrow("CODEX_OUTPUT_INVALID");
  });

  it.each([
    ["response", [
      '{"response":"safe","response":"evil"}',
    ]],
    ["escaped response", [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: '{"response":"safe","\\u0072esponse":"evil"}',
        },
      }),
    ]],
    ["event type", [
      '{"type":"turn.started","type":"item.completed","item":{"type":"agent_message","text":"{\\"response\\":\\"evil\\"}"}}',
    ]],
    ["escaped event type", [
      '{"type":"turn.started","ty\\u0070e":"item.completed","item":{"type":"agent_message","text":"{\\"response\\":\\"evil\\"}"}}',
    ]],
    ["event item", [
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"response\\":\\"safe\\"}"},"item":{"type":"agent_message","text":"{\\"response\\":\\"evil\\"}"}}',
    ]],
    ...[
      "input_tokens",
      "cached_input_tokens",
      "cache_write_input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
    ].map((key) => [key, [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify({ response: "discard me" }) },
      }),
      `{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0,"${key}":2}}`,
    ]] as const),
  ] as const)("rejects a duplicate JSON %s key before normalization", async (_key, lines) => {
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({
        stdout: Buffer.from(`${lines.join("\n")}\n`),
      }),
    })).rejects.toThrow("CODEX_OUTPUT_INVALID");
  });

  it("accepts escaped string content and repeated names only across distinct JSON objects", async () => {
    const events = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread-1",
        metadata: [{ type: "one" }, { type: "two", text: "{ \\\"type\\\": 1 }" }],
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({ response: 'escaped "quote" and { brace }' }),
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 2,
          cached_input_tokens: 1,
          cache_write_input_tokens: 0,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      }),
      "",
    ].join("\n");

    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({ stdout: Buffer.from(events) }),
    })).resolves.toEqual({
      response: 'escaped "quote" and { brace }',
      usage: { inputTokens: 2, outputTokens: 3 },
    });
  });

  it("starts wait before start, handles fast exit, inspects exited, removes, and proves absence", async () => {
    const events: string[] = [];
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({ events }),
    })).resolves.toEqual({ response: "bounded response" });
    expect(events).toEqual([
      "create", "inspect-1", "wait", "start", "inspect-2", "remove", "inspect-3",
    ]);
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it("on abort waits before kill, discards partial output, removes explicitly, and proves absence", async () => {
    const events: string[] = [];
    let resolveStart!: (result: DockerCommandResult) => void;
    let resolveWait!: (result: { helperExitCode: number; containerExitCode: number }) => void;
    let announceStart!: () => void;
    const startBegan = new Promise<void>((resolveStartBegan) => {
      announceStart = resolveStartBegan;
    });
    let inspections = 0;
    const controller: CodexDockerController = {
      ...emptyController(),
      create: vi.fn(async () => createResult({ stdout: Buffer.from(`${CONTAINER_ID}\n`) })),
      inspect: vi.fn(async ({ identity }) => {
        inspections += 1;
        if (inspections === 1) {
          return { daemonAvailable: true, exists: true, inspection: exactInspection(identity, "created") };
        }
        if (inspections === 2) {
          return {
            daemonAvailable: true,
            exists: true,
            inspection: exactInspection(identity, "exited", { exitCode: 137 }),
          };
        }
        return { daemonAvailable: true, exists: false };
      }),
      wait: vi.fn(async () => {
        events.push("wait");
        return new Promise<{ helperExitCode: number; containerExitCode: number }>((resolveWaitResult) => {
          resolveWait = resolveWaitResult;
        });
      }),
      start: vi.fn(async () => {
        events.push("start");
        announceStart();
        return new Promise<DockerCommandResult>((resolveStartResult) => {
          resolveStart = resolveStartResult;
        });
      }),
      kill: vi.fn(async () => {
        events.push("kill");
        resolveStart(commandResult({
          exitCode: 137,
          stdout: Buffer.from('{"response":"partial"}\n'),
          stderr: Buffer.from("private partial"),
        }));
        resolveWait({ helperExitCode: 0, containerExitCode: 137 });
        return { helperExitCode: 0 };
      }),
      remove: vi.fn(async () => {
        events.push("remove");
        return { helperExitCode: 0 };
      }),
    };
    const abort = new AbortController();
    const running = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: abort.signal,
      controller,
    });
    await startBegan;
    abort.abort();
    await expect(running).rejects.toThrow(/^CODEX_ABORTED$/u);
    expect(events).toEqual(["wait", "start", "kill", "remove"]);
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it("locks when create rejects without an authoritative helper exit even if inspect is absent", async () => {
    let announceCreate!: () => void;
    const createBegan = new Promise<void>((resolveCreateBegan) => {
      announceCreate = resolveCreateBegan;
    });
    const controller = emptyController();
    controller.create = vi.fn(async ({ signal }) => {
      announceCreate();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("create aborted")), { once: true });
      });
    });
    controller.inspect = vi.fn(async () => ({ daemonAvailable: true, exists: false }));
    const abort = new AbortController();
    const running = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: abort.signal,
      controller,
    });
    await createBegan;
    abort.abort();
    await expect(running).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(controller.start).not.toHaveBeenCalled();
    expect(isCodexContainerLaunchLocked()).toBe(true);
  });

  it("reconciles an exact container created concurrently with abort before any prompt is sent", async () => {
    let resolveCreate!: (result: DockerCreateResult) => void;
    let announceCreate!: () => void;
    const createBegan = new Promise<void>((resolveCreateBegan) => {
      announceCreate = resolveCreateBegan;
    });
    const events: string[] = [];
    let present = true;
    const controller = emptyController();
    controller.create = vi.fn(async () => {
      announceCreate();
      return new Promise<DockerCreateResult>((resolveCreateResult) => {
        resolveCreate = resolveCreateResult;
      });
    });
    controller.inspect = vi.fn(async ({ identity }) => {
      return present
        ? { daemonAvailable: true, exists: true, inspection: exactInspection(identity, "created") }
        : { daemonAvailable: true, exists: false };
    });
    controller.wait = vi.fn(async () => {
      events.push("wait");
      return { helperExitCode: 0, containerExitCode: 137 };
    });
    controller.kill = vi.fn(async () => {
      events.push("kill");
      return { helperExitCode: 0 };
    });
    controller.remove = vi.fn(async () => {
      events.push("remove");
      present = false;
      return { helperExitCode: 0 };
    });
    const abort = new AbortController();
    const running = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: abort.signal,
      controller,
    });
    await createBegan;
    abort.abort();
    resolveCreate(createResult({ stdout: Buffer.from(`${CONTAINER_ID}\n`) }));
    await expect(running).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(events).toEqual([]);
    expect(controller.start).not.toHaveBeenCalled();
    expect(isCodexContainerLaunchLocked()).toBe(true);
    await expect(reconcileCodexContainers({ image: IMAGE, controller }))
      .resolves.toEqual({ reconciled: true });
    expect(events).toEqual(["remove"]);
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it("locks when an aborted create helper is unsettled even if one immediate inspect is absent", async () => {
    let announceCreate!: () => void;
    const createBegan = new Promise<void>((resolveCreateBegan) => {
      announceCreate = resolveCreateBegan;
    });
    let resolveCreate!: (result: DockerCreateResult) => void;
    const controller = emptyController();
    controller.create = vi.fn(async () => {
      announceCreate();
      return new Promise<DockerCreateResult>((resolveCreateResult) => {
        resolveCreate = resolveCreateResult;
      });
    });
    controller.inspect = vi.fn(async () => ({ daemonAvailable: true, exists: false }));
    const abort = new AbortController();
    const running = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: abort.signal,
      controller,
    });
    await createBegan;
    abort.abort();
    await expect(running).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(isCodexContainerLaunchLocked()).toBe(true);
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "second prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: emptyController(),
    })).rejects.toThrow(/^CODEX_CONTAINER_LOCKED$/u);

    resolveCreate(createResult({ stdout: Buffer.from(`${CONTAINER_ID}\n`) }));
    await vi.waitFor(() => expect(controller.inspect).toHaveBeenCalled());
    await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 0));
    const name = (controller.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .args[(controller.create as ReturnType<typeof vi.fn>).mock.calls[0][0].args.indexOf("--name") + 1] as string;
    let listCalls = 0;
    let inspections = 0;
    const reconciliation = emptyController();
    reconciliation.list = vi.fn(async () => ({
      daemonAvailable: true,
      names: listCalls++ === 0 ? [name] : [],
    }));
    reconciliation.inspect = vi.fn(async ({ identity }) => {
      inspections += 1;
      return inspections === 1
        ? { daemonAvailable: true, exists: true, inspection: exactInspection(identity, "created") }
        : { daemonAvailable: true, exists: false };
    });
    await expect(reconcileCodexContainers({ image: IMAGE, controller: reconciliation }))
      .resolves.toEqual({ reconciled: true });
    expect(reconciliation.remove).toHaveBeenCalledTimes(1);
    expect(isCodexContainerLaunchLocked()).toBe(false);
  }, 15_000);

  it("requires explicit create-helper settlement before absence can prove never created", async () => {
    const controller = emptyController();
    controller.create = vi.fn(async () => createResult({
      exitCode: 1,
      stderr: Buffer.from("private create failure"),
      helperExitProven: false,
    }));
    controller.inspect = vi.fn(async () => ({ daemonAvailable: true, exists: false }));
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller,
    })).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(isCodexContainerLaunchLocked()).toBe(true);
  });

  it("locks when an aborted create helper exits nonzero before its container appears", async () => {
    let announceCreate!: () => void;
    const createBegan = new Promise<void>((resolveCreateBegan) => {
      announceCreate = resolveCreateBegan;
    });
    const controller = emptyController();
    controller.create = vi.fn(async ({ signal }) => {
      announceCreate();
      await new Promise<void>((resolveAbort) => {
        if (signal.aborted) resolveAbort();
        else signal.addEventListener("abort", () => resolveAbort(), { once: true });
      });
      return {
        ...createResult({
          exitCode: 1,
          stderr: Buffer.from("helper killed while daemon request remained in flight"),
        }),
        completion: "TERMINATED" as const,
      };
    });
    controller.inspect = vi.fn(async () => ({ daemonAvailable: true, exists: false }));
    const abort = new AbortController();
    const running = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: abort.signal,
      controller,
    });
    await createBegan;
    abort.abort();
    await expect(running).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(isCodexContainerLaunchLocked()).toBe(true);
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "second prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: emptyController(),
    })).rejects.toThrow(/^CODEX_CONTAINER_LOCKED$/u);

    const createRequest = (controller.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const name = createRequest.args[createRequest.args.indexOf("--name") + 1] as string;
    let listCalls = 0;
    let inspections = 0;
    const reconciliation = emptyController();
    reconciliation.list = vi.fn(async () => ({
      daemonAvailable: true,
      names: listCalls++ === 0 ? [name] : [],
    }));
    reconciliation.inspect = vi.fn(async ({ identity }) => {
      inspections += 1;
      return inspections === 1
        ? { daemonAvailable: true, exists: true, inspection: exactInspection(identity, "created") }
        : { daemonAvailable: true, exists: false };
    });
    await expect(reconcileCodexContainers({ image: IMAGE, controller: reconciliation }))
      .resolves.toEqual({ reconciled: true });
    expect(reconciliation.remove).toHaveBeenCalledTimes(1);
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it("does not lock after a naturally completed nonzero create and post-settlement absence", async () => {
    const controller = emptyController();
    controller.create = vi.fn(async () => ({
      ...createResult({
        exitCode: 1,
        stderr: Buffer.from("private natural daemon rejection"),
      }),
      completion: "NATURAL" as const,
    }));
    controller.inspect = vi.fn(async () => ({ daemonAvailable: true, exists: false }));
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller,
    })).rejects.toThrow(/^CODEX_PROCESS_FAILED$/u);
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it("keeps an interrupted create locked until its late exact singleton is removed", async () => {
    let announceCreate!: () => void;
    const createBegan = new Promise<void>((resolveCreateBegan) => {
      announceCreate = resolveCreateBegan;
    });
    let capturedIdentity: CodexContainerIdentity | undefined;
    const controller = emptyController();
    controller.create = vi.fn(async ({ args, signal }) => {
      const name = args[args.indexOf("--name") + 1];
      const runIdLabel = args.find((value: string) => value.startsWith("com.gustavo.codex-run-id="));
      const runId = runIdLabel?.slice("com.gustavo.codex-run-id=".length) ?? "";
      capturedIdentity = {
        name,
        runId,
        image: IMAGE,
        labels: {
          "com.gustavo.codex-runner": "v1",
          "com.gustavo.codex-run-id": runId,
        },
      };
      announceCreate();
      await new Promise<void>((resolveAbort) => {
        if (signal.aborted) resolveAbort();
        else signal.addEventListener("abort", () => resolveAbort(), { once: true });
      });
      return createResult({ exitCode: 1, completion: "TERMINATED" });
    });
    controller.inspect = vi.fn(async () => ({ daemonAvailable: true, exists: false }));
    const abort = new AbortController();
    const running = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: abort.signal,
      controller,
    });
    await createBegan;
    abort.abort();
    await expect(running).rejects.toThrow("CODEX_CONTAINER_TERMINATION_UNPROVEN");
    expect(capturedIdentity).toBeDefined();

    let lateExists = false;
    const reconciliation = emptyController();
    reconciliation.list = vi.fn(async () => ({ daemonAvailable: true, names: [] }));
    reconciliation.inspect = vi.fn(async () => lateExists
      ? {
        daemonAvailable: true,
        exists: true,
        inspection: exactInspection(capturedIdentity as CodexContainerIdentity, "created"),
      }
      : { daemonAvailable: true, exists: false });
    reconciliation.remove = vi.fn(async () => {
      lateExists = false;
      return { helperExitCode: 0 };
    });

    await expect(reconcileCodexContainers({
      image: IMAGE,
      controller: reconciliation,
    })).rejects.toThrow("CODEX_CONTAINER_RECONCILIATION_FAILED");
    expect(isCodexContainerLaunchLocked()).toBe(true);
    await expect(reconcileCodexContainers({
      image: IMAGE,
      controller: reconciliation,
    })).rejects.toThrow("CODEX_CONTAINER_RECONCILIATION_FAILED");
    expect(reconciliation.remove).not.toHaveBeenCalled();
    expect(isCodexContainerLaunchLocked()).toBe(true);

    lateExists = true;
    await expect(reconcileCodexContainers({
      image: IMAGE,
      controller: reconciliation,
    })).resolves.toEqual({ reconciled: true });
    expect(reconciliation.remove).toHaveBeenCalledTimes(1);
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it.each([
    { helper: "kill", killExitCode: 1, waitExitCode: 0, removeExitCode: 0 },
    { helper: "wait", killExitCode: 0, waitExitCode: 1, removeExitCode: 0 },
  ])("locks when abort cleanup cannot prove $helper authority", async ({
    killExitCode,
    waitExitCode,
    removeExitCode,
  }) => {
    let resolveStart!: (result: DockerCommandResult) => void;
    let resolveWait!: (result: { helperExitCode: number; containerExitCode: number }) => void;
    let announceStart!: () => void;
    const startBegan = new Promise<void>((resolveStartBegan) => {
      announceStart = resolveStartBegan;
    });
    let inspections = 0;
    const controller = emptyController();
    controller.create = vi.fn(async () => createResult({ stdout: Buffer.from(`${CONTAINER_ID}\n`) }));
    controller.inspect = vi.fn(async ({ identity }) => {
      inspections += 1;
      if (inspections === 1) {
        return { daemonAvailable: true, exists: true, inspection: exactInspection(identity, "created") };
      }
      if (inspections === 2) {
        return {
          daemonAvailable: true,
          exists: true,
          inspection: exactInspection(identity, "exited", { exitCode: 137 }),
        };
      }
      return { daemonAvailable: true, exists: false };
    });
    controller.wait = vi.fn(async () => new Promise<{
      helperExitCode: number;
      containerExitCode: number;
    }>((resolveWaitResult) => {
      resolveWait = resolveWaitResult;
    }));
    controller.start = vi.fn(async () => {
      announceStart();
      return new Promise<DockerCommandResult>((resolveStartResult) => {
        resolveStart = resolveStartResult;
      });
    });
    controller.kill = vi.fn(async () => {
      resolveStart(commandResult({ exitCode: 137 }));
      resolveWait({ helperExitCode: waitExitCode, containerExitCode: 137 });
      return { helperExitCode: killExitCode };
    });
    controller.remove = vi.fn(async () => ({ helperExitCode: removeExitCode }));
    const abort = new AbortController();
    const running = runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      signal: abort.signal,
      controller,
    });
    await startBegan;
    abort.abort();
    await expect(running).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(isCodexContainerLaunchLocked()).toBe(true);
  });

  it("locks when explicit remove returns nonzero after an otherwise proven fast exit", async () => {
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({ removeExitCode: 1 }),
    })).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(isCodexContainerLaunchLocked()).toBe(true);
  });

  it("locks on duplicate-name identity mismatch without starting or deleting the raced container", async () => {
    const controller = emptyController();
    controller.inspect = vi.fn(async ({ identity }) => ({
      daemonAvailable: true,
      exists: true,
      inspection: exactInspection(identity, "created", {
        id: "d".repeat(64),
        image: OTHER_IMAGE,
      }),
    }));
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller,
    })).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.remove).not.toHaveBeenCalled();
    expect(isCodexContainerLaunchLocked()).toBe(true);
  });

  it("locks Docker exit 125 but treats proven 126/127 Codex invocation failures as ordinary", async () => {
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({
        exitCode: 125,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("private daemon failure"),
      }),
    })).rejects.toThrow(/^CODEX_CONTAINER_TERMINATION_UNPROVEN$/u);
    expect(isCodexContainerLaunchLocked()).toBe(true);
    await clearLaunchLock();
    for (const exitCode of [126, 127]) {
      await expect(runIsolatedCodex({
        role: "NODE",
        prompt: "private prompt",
        image: IMAGE,
        authVolume: AUTH_VOLUME,
        timeoutMs: 30_000,
        controller: completedLifecycleController({
          exitCode,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("private invocation failure"),
        }),
      })).rejects.toThrow(/^CODEX_PROCESS_FAILED$/u);
      expect(isCodexContainerLaunchLocked()).toBe(false);
    }
  });

  it.each([
    { stderr: "authentication required: private detail", error: "CODEX_AUTH_UNAVAILABLE" },
    { stderr: "usage limit reached: private detail", error: "CODEX_QUOTA_EXHAUSTED" },
    { stderr: "model gpt-5.6-sol is unavailable: private detail", error: "CODEX_MODEL_UNAVAILABLE" },
  ])("does not permanently lock after a proven $error Codex failure", async ({ stderr, error }) => {
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(stderr),
      }),
    })).rejects.toThrow(new RegExp(`^${error}$`, "u"));
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it("reconciles only exact running containers with wait-before-kill, remove, and absence proof", async () => {
    await expect(runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      image: IMAGE,
      authVolume: AUTH_VOLUME,
      timeoutMs: 30_000,
      controller: completedLifecycleController({ removeExitCode: 1 }),
    })).rejects.toThrow("CODEX_CONTAINER_TERMINATION_UNPROVEN");
    const name = `gustavo-codex-${"e".repeat(32)}`;
    const events: string[] = [];
    let listCalls = 0;
    let inspections = 0;
    const controller = emptyController();
    controller.list = vi.fn(async () => ({
      daemonAvailable: true,
      names: listCalls++ === 0 ? [name] : [],
    }));
    controller.inspect = vi.fn(async ({ identity }) => {
      inspections += 1;
      if (inspections === 1) {
        return { daemonAvailable: true, exists: true, inspection: exactInspection(identity, "running") };
      }
      if (inspections === 2) {
        return {
          daemonAvailable: true,
          exists: true,
          inspection: exactInspection(identity, "exited", { exitCode: 137 }),
        };
      }
      return { daemonAvailable: true, exists: false };
    });
    controller.wait = vi.fn(async () => {
      events.push("wait");
      return { helperExitCode: 0, containerExitCode: 137 };
    });
    controller.kill = vi.fn(async () => {
      events.push("kill");
      return { helperExitCode: 0 };
    });
    controller.remove = vi.fn(async () => {
      events.push("remove");
      return { helperExitCode: 0 };
    });
    await expect(reconcileCodexContainers({ image: IMAGE, controller }))
      .resolves.toEqual({ reconciled: true });
    expect(events).toEqual(["wait", "kill", "remove"]);
    expect(isCodexContainerLaunchLocked()).toBe(false);
  });

  it.each(["created", "exited"] as const)(
    "reconciles an exact stale %s container without an invalid kill",
    async (state) => {
      await expect(runIsolatedCodex({
        role: "NODE",
        prompt: "private prompt",
        image: IMAGE,
        authVolume: AUTH_VOLUME,
        timeoutMs: 30_000,
        controller: completedLifecycleController({ removeExitCode: 1 }),
      })).rejects.toThrow("CODEX_CONTAINER_TERMINATION_UNPROVEN");
      const name = `gustavo-codex-${state === "created" ? "a".repeat(32) : "b".repeat(32)}`;
      let listCalls = 0;
      let inspections = 0;
      const events: string[] = [];
      const controller = emptyController();
      controller.list = vi.fn(async () => ({
        daemonAvailable: true,
        names: listCalls++ === 0 ? [name] : [],
      }));
      controller.inspect = vi.fn(async ({ identity }) => {
        inspections += 1;
        return inspections === 1
          ? { daemonAvailable: true, exists: true, inspection: exactInspection(identity, state) }
          : { daemonAvailable: true, exists: false };
      });
      controller.wait = vi.fn(async () => {
        events.push("wait");
        return { helperExitCode: 0, containerExitCode: 0 };
      });
      controller.kill = vi.fn(async () => {
        events.push("kill");
        return { helperExitCode: 1 };
      });
      controller.remove = vi.fn(async () => {
        events.push("remove");
        return { helperExitCode: 0 };
      });

      await expect(reconcileCodexContainers({ image: IMAGE, controller }))
        .resolves.toEqual({ reconciled: true });
      expect(events).toEqual(state === "created" ? ["remove"] : ["wait", "remove"]);
      expect(isCodexContainerLaunchLocked()).toBe(false);
    },
  );

  it.each(["dead", "removing"] as const)(
    "keeps reconciliation locked for an exact %s container",
    async (state) => {
      await expect(runIsolatedCodex({
        role: "NODE",
        prompt: "private prompt",
        image: IMAGE,
        authVolume: AUTH_VOLUME,
        timeoutMs: 30_000,
        controller: completedLifecycleController({ removeExitCode: 1 }),
      })).rejects.toThrow("CODEX_CONTAINER_TERMINATION_UNPROVEN");
      const name = `gustavo-codex-${state === "dead" ? "1".repeat(32) : "2".repeat(32)}`;
      const controller = emptyController();
      controller.list = vi.fn(async () => ({ daemonAvailable: true, names: [name] }));
      controller.inspect = vi.fn(async ({ identity }) => ({
        daemonAvailable: true,
        exists: true,
        inspection: exactInspection(identity, state),
      }));
      await expect(reconcileCodexContainers({ image: IMAGE, controller }))
        .rejects.toThrow("CODEX_CONTAINER_RECONCILIATION_FAILED");
      expect(controller.kill).not.toHaveBeenCalled();
      expect(controller.remove).not.toHaveBeenCalled();
      expect(isCodexContainerLaunchLocked()).toBe(true);
    },
  );

  it.each(["kill", "remove"] as const)(
    "keeps reconciliation locked when %s exits nonzero",
    async (failedHelper) => {
      await expect(runIsolatedCodex({
        role: "NODE",
        prompt: "private prompt",
        image: IMAGE,
        authVolume: AUTH_VOLUME,
        timeoutMs: 30_000,
        controller: completedLifecycleController({ removeExitCode: 1 }),
      })).rejects.toThrow("CODEX_CONTAINER_TERMINATION_UNPROVEN");
      const name = `gustavo-codex-${"f".repeat(32)}`;
      let inspections = 0;
      const controller = emptyController();
      controller.list = vi.fn(async () => ({ daemonAvailable: true, names: [name] }));
      controller.inspect = vi.fn(async ({ identity }) => {
        inspections += 1;
        return {
          daemonAvailable: true,
          exists: true,
          inspection: exactInspection(
            identity,
            inspections === 1 ? "running" : "exited",
            inspections === 1 ? {} : { exitCode: 137 },
          ),
        };
      });
      controller.wait = vi.fn(async () => ({ helperExitCode: 0, containerExitCode: 137 }));
      controller.kill = vi.fn(async () => ({ helperExitCode: failedHelper === "kill" ? 1 : 0 }));
      controller.remove = vi.fn(async () => ({ helperExitCode: failedHelper === "remove" ? 1 : 0 }));
      await expect(reconcileCodexContainers({ image: IMAGE, controller }))
        .rejects.toThrow("CODEX_CONTAINER_RECONCILIATION_FAILED");
      expect(isCodexContainerLaunchLocked()).toBe(true);
    },
  );

  it("pins a nonroot image and bakes only three exact response schemas", async () => {
    const root = resolve("worker/hybrid/codex-container");
    const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03",
    );
    expect(dockerfile).toContain("@openai/codex@0.146.0");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).not.toMatch(/mcp|plugin|connector|OPENAI_API_KEY|DATABASE_URL|VALKEY_URL|QSTASH|FINNHUB|TAILSCALE/iu);
    const expectedSchema = {
      type: "object",
      additionalProperties: false,
      required: ["response"],
      properties: { response: { type: "string", minLength: 1, maxLength: 32_768 } },
    };
    for (const role of ["node", "main", "evaluator"]) {
      expect(JSON.parse(await readFile(resolve(root, `${role}.schema.json`), "utf8")))
        .toEqual(expectedSchema);
    }
  });

  const dockerIt = process.env.GUSTAVO_RUN_DOCKER_CODEX_TEST === "1" ? it : it.skip;
  dockerIt("the actual pinned CLI accepts every fixed tool-off setting", async () => {
    const tag = `gustavo-codex-tool-proof:${randomBytes(8).toString("hex")}`;
    try {
      const built = await fixtureDocker({
        args: ["build", "--tag", tag, resolve("worker/hybrid/codex-container")],
        maxStdoutBytes: 4_194_304,
        maxStderrBytes: 4_194_304,
      });
      expect(built.exitCode).toBe(0);
      const args = ["run", "--rm", "--entrypoint", "codex", tag];
      for (const config of TOOL_OFF_CONFIG) args.push("--config", config);
      args.push("features", "list");
      const features = await fixtureDocker({ args });
      expect(features.exitCode).toBe(0);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(features.stderr))
        .not.toMatch(/unknown|invalid|unrecognized|configuration error/iu);
      const output = new TextDecoder("utf-8", { fatal: true }).decode(features.stdout);
      for (const feature of [
        "shell_tool", "unified_exec", "apps", "multi_agent", "hooks",
        "skill_mcp_dependency_install", "browser_use", "browser_use_external",
        "browser_use_full_cdp_access", "computer_use", "in_app_browser",
        "enable_mcp_apps", "plugins", "remote_plugin", "tool_call_mcp_elicitation",
        "tool_suggest", "code_mode_host", "image_generation", "skill_search",
        "workspace_dependencies", "js_repl",
        "auth_elicitation", "goals", "plugin_sharing", "shell_snapshot",
      ]) expect(output).toMatch(new RegExp(`^${feature}\\s+.*false$`, "mu"));
    } finally {
      await fixtureDocker({ args: ["image", "rm", "--force", tag] }).catch(() => undefined);
    }
  }, 120_000);

  dockerIt("kills a real container descendant, removes the container, and prevents a delayed marker", async () => {
    const suffix = randomBytes(8).toString("hex");
    const imageTag = `gustavo-t7-fixture:${suffix}`;
    const markerVolume = `gustavo-t7-marker-${suffix}`;
    const context = await mkdtemp(join(tmpdir(), `gustavo-t7-fixture-${suffix}-`));
    let validatedContainerId: string | undefined;
    let imageId: string | undefined;
    try {
      expect((await fixtureDocker({
        args: ["container", "inspect", "gustavo-codex-singleton-v1"],
      })).exitCode).not.toBe(0);
      const descendant = [
        "const fs=require('node:fs');",
        "setTimeout(()=>fs.writeFileSync('/codex-home/orphan-marker','survived'),2000);",
        "setInterval(()=>{},1000);",
      ].join("");
      const parent = [
        "const {spawn}=require('node:child_process');",
        `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
        "setInterval(()=>{},1000);",
      ].join("");
      await writeFile(join(context, "Dockerfile"), [
        "FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03",
        `ENTRYPOINT ["node","-e",${JSON.stringify(parent)}]`,
        "",
      ].join("\n"));
      expect((await fixtureDocker({ args: ["volume", "create", markerVolume] })).exitCode).toBe(0);
      expect((await fixtureDocker({
        args: ["build", "--tag", imageTag, context],
        maxStdoutBytes: 4_194_304,
        maxStderrBytes: 4_194_304,
      })).exitCode).toBe(0);
      const inspectedImage = await fixtureDocker({
        args: ["image", "inspect", "--format", "{{.Id}}", imageTag],
      });
      imageId = new TextDecoder("utf-8", { fatal: true }).decode(inspectedImage.stdout).trim();
      const events: string[] = [];
      const evidence: string[] = [];
      let announceStart!: () => void;
      const startBegan = new Promise<void>((resolveStartBegan) => {
        announceStart = resolveStartBegan;
      });
      const controller = liveFixtureController({
        markerVolume,
        onCreate(args) {
          expect(args[args.indexOf("--name") + 1]).toBe("gustavo-codex-singleton-v1");
          expect(args).not.toContain("--rm");
          expect(args).not.toContain("fixture prompt never enters create");
          events.push("create");
        },
        onValidatedContainer(containerId) {
          validatedContainerId = containerId;
        },
        onWait() {
          events.push("wait");
        },
        onStart() {
          events.push("start");
          announceStart();
        },
        onKill() {
          events.push("kill");
        },
        onRemove() {
          events.push("remove");
        },
        onEvidence(value) {
          evidence.push(value);
        },
      });
      const abort = new AbortController();
      const running = runIsolatedCodex({
        role: "NODE",
        prompt: "fixture prompt never enters create",
        image: imageId,
        authVolume: AUTH_VOLUME,
        timeoutMs: 30_000,
        dockerExecutable: RECORDED_DOCKER_EXECUTABLE,
        resolveDockerExecutable: undefined,
        signal: abort.signal,
        controller,
      });
      await startBegan;
      abort.abort();
      let failure: unknown;
      try {
        await running;
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(expect.objectContaining({ message: "CODEX_ABORTED" }));
      expect(events).toEqual(["create", "wait", "start", "kill", "remove"]);
      expect(evidence).toEqual(expect.arrayContaining([
        "inspect=created", "kill=0", "wait=0:137", "start=137", "inspect=exited", "remove=0",
      ]));
      expect((await fixtureDocker({
        args: ["container", "inspect", validatedContainerId as string],
      })).exitCode).not.toBe(0);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
      expect((await fixtureDocker({
        args: [
          "run", "--rm", "--pull=never", "--entrypoint", "/bin/sh",
          "--mount", `type=volume,src=${markerVolume},dst=/marker`, imageId,
          "-c", "test ! -e /marker/orphan-marker",
        ],
      })).exitCode).toBe(0);
    } finally {
      if (validatedContainerId !== undefined && imageId !== undefined) {
        await removeExactFixtureContainer({
          containerId: validatedContainerId,
          image: imageId,
        }).catch(() => undefined);
      }
      await fixtureDocker({ args: ["image", "rm", "--force", imageTag] }).catch(() => undefined);
      await fixtureDocker({ args: ["volume", "rm", "--force", markerVolume] }).catch(() => undefined);
      await rm(context, { recursive: true, force: true });
    }
  }, 120_000);

  dockerIt("uses Docker's fixed singleton name as a real cross-controller serializer", async () => {
    const suffix = randomBytes(8).toString("hex");
    const imageTag = `gustavo-t7-singleton:${suffix}`;
    const context = await mkdtemp(join(tmpdir(), `gustavo-t7-singleton-${suffix}-`));
    const runId = "e".repeat(32);
    let validatedContainerId: string | undefined;
    let imageId: string | undefined;
    try {
      expect((await fixtureDocker({
        args: ["container", "inspect", "gustavo-codex-singleton-v1"],
      })).exitCode).not.toBe(0);
      await writeFile(join(context, "Dockerfile"), [
        "FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03",
        'ENTRYPOINT ["node","-e","setInterval(()=>{},1000)"]',
        "",
      ].join("\n"));
      expect((await fixtureDocker({
        args: ["build", "--tag", imageTag, context],
        maxStdoutBytes: 4_194_304,
        maxStderrBytes: 4_194_304,
      })).exitCode).toBe(0);
      const imageResult = await fixtureDocker({
        args: ["image", "inspect", "--format", "{{.Id}}", imageTag],
      });
      imageId = new TextDecoder("utf-8", { fatal: true }).decode(imageResult.stdout).trim();
      const fixedArgs = [
        "create", "--name", "gustavo-codex-singleton-v1",
        "--label", "com.gustavo.codex-runner=v1",
        "--label", `com.gustavo.codex-run-id=${runId}`,
        imageId,
      ];
      const first = await fixtureDocker({ args: fixedArgs });
      expect(first.exitCode).toBe(0);
      const createdId = new TextDecoder("utf-8", { fatal: true }).decode(first.stdout).trim();
      expect(createdId).toMatch(/^[a-f0-9]{64}$/u);
      expect(await inspectExactFixtureContainer({
        containerId: createdId,
        image: imageId,
        runId,
      })).toBe(true);
      validatedContainerId = createdId;
      const second = await fixtureDocker({ args: fixedArgs });
      expect(second.exitCode).not.toBe(0);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(second.stdout)).not.toContain(imageId);
    } finally {
      if (validatedContainerId !== undefined && imageId !== undefined) {
        await removeExactFixtureContainer({
          containerId: validatedContainerId,
          image: imageId,
          runId,
        }).catch(() => undefined);
      }
      await fixtureDocker({ args: ["image", "rm", "--force", imageTag] }).catch(() => undefined);
      await rm(context, { recursive: true, force: true });
    }
  }, 120_000);
});

interface FixtureResult extends DockerCommandResult {}

function fixtureDocker(input: {
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}): Promise<FixtureResult> {
  const maximumStdout = input.maxStdoutBytes ?? 1_048_576;
  const maximumStderr = input.maxStderrBytes ?? 65_536;
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(RECORDED_DOCKER_EXECUTABLE, [...input.args], {
      env: { ...process.env } as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: "STDOUT" | "STDERR" | undefined;
    let settled = false;
    const capture = (chunks: Buffer[], chunk: Buffer, stream: "STDOUT" | "STDERR") => {
      const current = stream === "STDOUT" ? stdoutBytes : stderrBytes;
      const maximum = stream === "STDOUT" ? maximumStdout : maximumStderr;
      const remaining = Math.max(0, maximum - current);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (stream === "STDOUT") stdoutBytes += Math.min(chunk.byteLength, remaining);
      else stderrBytes += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining && overflow === undefined) {
        overflow = stream;
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => child.kill("SIGKILL");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, "STDOUT"));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, "STDERR"));
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectCommand(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolveCommand({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(overflow === undefined ? {} : { overflow }),
      });
    });
    child.stdin.end(input.stdin ?? Buffer.alloc(0));
  });
}

async function inspectExactFixtureContainer(input: {
  readonly containerId: string;
  readonly image: string;
  readonly runId?: string;
}): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/u.test(input.containerId)) return false;
  const result = await fixtureDocker({
    args: ["container", "inspect", input.containerId],
  });
  if (result.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)) as Array<{
      readonly Id: string;
      readonly Name: string;
      readonly Config: { readonly Image: string; readonly Labels: Record<string, string> | null };
    }>;
    const inspected = parsed.length === 1 ? parsed[0] : undefined;
    const labels = inspected?.Config.Labels ?? {};
    const labelKeys = Object.keys(labels).sort();
    const actualRunId = labels["com.gustavo.codex-run-id"];
    return inspected?.Id === input.containerId
      && inspected.Name === "/gustavo-codex-singleton-v1"
      && inspected.Config.Image === input.image
      && labelKeys.length === 2
      && labelKeys[0] === "com.gustavo.codex-run-id"
      && labelKeys[1] === "com.gustavo.codex-runner"
      && labels["com.gustavo.codex-runner"] === "v1"
      && /^[a-f0-9]{32}$/u.test(actualRunId ?? "")
      && (input.runId === undefined || actualRunId === input.runId);
  } catch {
    return false;
  }
}

async function removeExactFixtureContainer(input: {
  readonly containerId: string;
  readonly image: string;
  readonly runId?: string;
}): Promise<void> {
  if (!await inspectExactFixtureContainer(input)) return;
  await fixtureDocker({
    args: ["container", "rm", "--force", input.containerId],
  });
}

function liveFixtureController(input: {
  readonly markerVolume: string;
  readonly onCreate: (args: readonly string[]) => void;
  readonly onValidatedContainer?: (containerId: string) => void;
  readonly onWait: () => void;
  readonly onStart: () => void;
  readonly onKill: () => void;
  readonly onRemove: () => void;
  readonly onEvidence?: (value: string) => void;
}): CodexDockerController {
  const exactId = (identity: CodexContainerIdentity) => {
    if (!identity.containerId?.match(/^[a-f0-9]{64}$/u)) {
      throw new Error("fixture requires immutable container ID");
    }
    return identity.containerId;
  };
  const reference = (identity: CodexContainerIdentity) => identity.containerId ?? identity.name;
  return {
    async acquireHostLease() {
      return { release: async () => undefined };
    },
    async create(request) {
      input.onCreate(request.args);
      const args = request.args.map((argument) => argument ===
        "type=volume,src=gustavo-codex-auth-v1,dst=/codex-home"
        ? `type=volume,src=${input.markerVolume},dst=/codex-home`
        : argument);
      const result = await fixtureDocker({
        args,
        signal: request.signal,
        maxStdoutBytes: request.maxStdoutBytes,
        maxStderrBytes: request.maxStderrBytes,
      });
      return {
        ...result,
        helperExitProven: result.exitCode !== null,
        completion: request.signal.aborted ? "TERMINATED" : "NATURAL",
      };
    },
    async start(request) {
      const containerId = exactId(request.identity);
      const execution = fixtureDocker({
        args: ["start", "--attach", "--interactive", containerId],
        stdin: request.stdin,
        signal: request.signal,
        maxStdoutBytes: request.maxStdoutBytes,
        maxStderrBytes: request.maxStderrBytes,
      });
      let running = false;
      for (let attempt = 0; attempt < 100 && !running; attempt += 1) {
        const inspected = await fixtureDocker({
          args: ["container", "inspect", "--format", "{{.State.Running}}", containerId],
        });
        running = inspected.exitCode === 0
          && new TextDecoder().decode(inspected.stdout).trim() === "true";
        if (!running) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      if (!running) throw new Error("fixture container did not enter running state");
      input.onStart();
      const result = await execution;
      input.onEvidence?.(`start=${result.exitCode}`);
      return result;
    },
    async wait(request) {
      input.onWait();
      const containerId = exactId(request.identity);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await fixtureDocker({
          args: ["container", "inspect", "--format", "{{.State.Status}}", containerId],
          signal: request.signal,
        });
        const text = new TextDecoder("utf-8", { fatal: true }).decode(state.stdout).trim();
        if (state.exitCode !== 0) return { helperExitCode: state.exitCode, containerExitCode: null };
        if (text !== "created") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      const result = await fixtureDocker({
        args: ["wait", containerId],
        signal: request.signal,
        maxStdoutBytes: 64,
        maxStderrBytes: 1_024,
      });
      const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
      input.onEvidence?.(`wait=${result.exitCode}:${text}`);
      return {
        helperExitCode: result.exitCode,
        containerExitCode: /^(?:0|[1-9][0-9]{0,2})$/u.test(text) ? Number(text) : null,
      };
    },
    async kill(request) {
      input.onKill();
      const result = await fixtureDocker({
        args: ["kill", "--signal", "KILL", exactId(request.identity)],
        signal: request.signal,
      });
      input.onEvidence?.(`kill=${result.exitCode}`);
      return { helperExitCode: result.exitCode };
    },
    async remove(request) {
      input.onRemove();
      const result = await fixtureDocker({
        args: ["container", "rm", exactId(request.identity)],
        signal: request.signal,
      });
      input.onEvidence?.(`remove=${result.exitCode}`);
      return { helperExitCode: result.exitCode };
    },
    async inspect(request) {
      const result = await fixtureDocker({
        args: ["container", "inspect", reference(request.identity)],
        signal: request.signal,
      });
      if (result.exitCode !== 0) {
        const daemon = await fixtureDocker({ args: ["version", "--format", "{{.Server.Version}}"] });
        return { daemonAvailable: daemon.exitCode === 0, exists: false };
      }
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)) as Array<{
        readonly Id: string;
        readonly Name: string;
        readonly Config: { readonly Image: string; readonly Labels: Record<string, string> | null };
        readonly State: {
          readonly Status: DockerInspection["state"];
          readonly ExitCode: number;
        };
      }>;
      const inspected = parsed[0];
      const labels = inspected.Config.Labels ?? {};
      const labelKeys = Object.keys(labels).sort();
      if (
        request.identity.containerId !== undefined
        && inspected.Id === request.identity.containerId
        && inspected.Name === "/gustavo-codex-singleton-v1"
        && inspected.Config.Image === request.identity.image
        && labelKeys.length === 2
        && labelKeys[0] === "com.gustavo.codex-run-id"
        && labelKeys[1] === "com.gustavo.codex-runner"
        && labels["com.gustavo.codex-runner"] === "v1"
        && labels["com.gustavo.codex-run-id"] === request.identity.runId
      ) input.onValidatedContainer?.(inspected.Id);
      input.onEvidence?.(`inspect=${inspected.State.Status}`);
      return {
        daemonAvailable: true,
        exists: true,
        inspection: {
          id: inspected.Id,
          name: inspected.Name.startsWith("/") ? inspected.Name.slice(1) : inspected.Name,
          image: inspected.Config.Image,
          labels: inspected.Config.Labels ?? {},
          state: inspected.State.Status,
          exitCode: inspected.State.Status === "exited" ? inspected.State.ExitCode : null,
        },
      };
    },
    async list(request) {
      const result = await fixtureDocker({
        args: [
          "container", "ls", "--all", "--filter", `label=${request.runnerLabel}`,
          "--format", "{{.Names}}",
        ],
        signal: request.signal,
      });
      return {
        daemonAvailable: result.exitCode === 0,
        names: new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
          .split(/\r?\n/u).filter(Boolean),
      };
    },
  };
}
