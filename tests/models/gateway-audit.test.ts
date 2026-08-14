import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createModelGateway,
  loadProductionModelRoleConfigs,
} from "../../lib/server/models/gateway";
import { createCodexCliProvider } from "../../lib/server/models/codex-cli";
import { fakeModelProvider } from "../../lib/server/models/fake";
import type {
  ModelProviderEvent,
  ModelProviderAdapter,
  ModelRole,
  ModelRoleConfigs,
} from "../../lib/server/models/types";
import { ModelProviderError } from "../../lib/server/models/types";
import { testContext } from "../helpers/postgres";

const roles = ["MAIN", "NODE", "EVALUATOR"] as const;

function configs(
  overrides: Partial<ModelRoleConfigs[ModelRole]> = {},
): ModelRoleConfigs {
  return Object.fromEntries(
    roles.map((role) => [
      role,
      {
        providerId: "fake",
        modelId: `deterministic-${role.toLowerCase()}-v1`,
        monthlyBudgetUsd: "10.00",
        maxInputTokens: 4_096,
        maxOutputTokens: 1_024,
        ...overrides,
      },
    ]),
  ) as unknown as ModelRoleConfigs;
}

async function settleWithin<Result>(
  promise: Promise<Result>,
  milliseconds: number,
): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("TEST_ABORT_TIMEOUT")), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("model gateway audit", () => {
  it("uses the Codex adapter's conservative UTF-8 input count before invoking its runner", async () => {
    const ctx = await testContext();
    const run = vi.fn().mockResolvedValue({ response: "unused" });
    const provider = createCodexCliProvider({ model: "gpt-5.6-sol", run });
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({
        providerId: "codex-cli",
        modelId: "gpt-5.6-sol",
        maxInputTokens: 6,
      }),
    });

    await expect(gateway.generate({
      role: "NODE",
      promptVersion: "p-codex-conservative-input",
      policyVersion: "v1",
      input: "你好!",
    })).rejects.toThrow("MODEL_INPUT_TOKEN_LIMIT");
    expect(run).not.toHaveBeenCalled();
    expect(
      await ctx.db.one(
        `select input_tokens, completion_status, error_code from model_runs
         where prompt_version='p-codex-conservative-input'`,
      ),
    ).toEqual({
      input_tokens: 7,
      completion_status: "TOKEN_REJECTED",
      error_code: "MODEL_INPUT_TOKEN_LIMIT",
    });
  }, 30_000);

  it.each(roles)("records every %s generation using its role configuration", async (role) => {
    const ctx = await testContext();
    const provider = fakeModelProvider("fixed response");
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });
    const correlationId = randomUUID();

    const result = await gateway.generate({
      role,
      promptVersion: "p1",
      policyVersion: "v1",
      input: "test",
      correlationId,
    });
    const run = await ctx.db.one(
      `select role, provider, model, prompt_version, policy_version,
        input_tokens, output_tokens, completion_status, correlation_id::text,
        latency_ms, estimated_cost_microusd
       from model_runs where id=$1`,
      [result.runId],
    );

    expect(run).toMatchObject({
      role,
      provider: "fake",
      model: `deterministic-${role.toLowerCase()}-v1`,
      prompt_version: "p1",
      policy_version: "v1",
      input_tokens: 1,
      output_tokens: 2,
      completion_status: "COMPLETED",
      correlation_id: correlationId,
    });
    expect(Number(run.latency_ms)).toBeGreaterThanOrEqual(0);
    expect(Number(run.estimated_cost_microusd)).toBeGreaterThan(0);
    expect(result.output).toBe("fixed response");
    expect(provider.calls).toHaveLength(1);
  }, 30_000);

  it("records a budget rejection and never calls the provider", async () => {
    const ctx = await testContext();
    const provider = fakeModelProvider("unused");
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({ monthlyBudgetUsd: "0.00" }),
    });

    await expect(
      gateway.generate({
        role: "NODE",
        promptVersion: "p1",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_BUDGET_EXHAUSTED");

    expect(provider.calls).toHaveLength(0);
    const run = await ctx.db.one(
      "select completion_status, error_code from model_runs where role='NODE'",
    );
    expect(run).toEqual({
      completion_status: "BUDGET_REJECTED",
      error_code: "MODEL_BUDGET_EXHAUSTED",
    });
  }, 30_000);

  it("rejects oversized input before invocation and passes the output ceiling to adapters", async () => {
    const ctx = await testContext();
    const rejectedProvider = fakeModelProvider("unused");
    const rejectedGateway = createModelGateway(ctx.db, rejectedProvider, {
      roleConfigs: configs({ maxInputTokens: 1, maxOutputTokens: 3 }),
    });

    await expect(
      rejectedGateway.generate({
        role: "MAIN",
        promptVersion: "p1",
        policyVersion: "v1",
        input: "two tokens",
      }),
    ).rejects.toThrow("MODEL_INPUT_TOKEN_LIMIT");
    expect(rejectedProvider.calls).toHaveLength(0);

    const provider = fakeModelProvider("three token reply");
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({ maxOutputTokens: 3 }),
    });
    await gateway.generate({
      role: "MAIN",
      promptVersion: "p1",
      policyVersion: "v1",
      input: "test",
    });
    expect(provider.calls[0]?.maxOutputTokens).toBe(3);
  }, 30_000);

  it("audits streamed completion, provider failure, and caller abort", async () => {
    const ctx = await testContext();
    const streaming = fakeModelProvider({ chunks: ["fixed ", "response"] });
    const gateway = createModelGateway(ctx.db, streaming, {
      roleConfigs: configs(),
    });
    const events = [];
    for await (const event of gateway.stream({
      role: "NODE",
      promptVersion: "p-stream",
      policyVersion: "v1",
      input: "test",
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "STARTED",
      "DELTA",
      "DELTA",
      "COMPLETED",
    ]);

    const failing = fakeModelProvider({ failWith: "UPSTREAM_UNAVAILABLE" });
    const failingGateway = createModelGateway(ctx.db, failing, {
      roleConfigs: configs(),
    });
    await expect(
      failingGateway.generate({
        role: "EVALUATOR",
        promptVersion: "p-fail",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("UPSTREAM_UNAVAILABLE");

    const aborting = fakeModelProvider({ chunks: ["one", "two"] });
    const abortGateway = createModelGateway(ctx.db, aborting, {
      roleConfigs: configs(),
    });
    for await (const event of abortGateway.stream({
      role: "MAIN",
      promptVersion: "p-abort",
      policyVersion: "v1",
      input: "test",
    })) {
      if (event.type === "DELTA") break;
    }

    const rows = await ctx.db.query<{
      completion_status: string;
      error_code: string | null;
      output_tokens: number;
      estimated_cost_microusd: string;
    }>(
      `select completion_status, error_code, output_tokens,
        estimated_cost_microusd
       from model_runs
       where prompt_version in ('p-stream', 'p-fail', 'p-abort')
       order by prompt_version`,
    );
    expect(rows).toEqual([
      {
        completion_status: "ABORTED",
        error_code: "MODEL_STREAM_ABORTED",
        output_tokens: 1,
        estimated_cost_microusd: "2",
      },
      {
        completion_status: "FAILED",
        error_code: "UPSTREAM_UNAVAILABLE",
        output_tokens: 0,
        estimated_cost_microusd: "1",
      },
      {
        completion_status: "COMPLETED",
        error_code: null,
        output_tokens: 2,
        estimated_cost_microusd: "3",
      },
    ]);
  }, 30_000);

  it("finalizes an aborted run when a consumer closes immediately after STARTED", async () => {
    const ctx = await testContext();
    const provider = fakeModelProvider("unused");
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });
    const iterator = gateway.stream({
      role: "NODE",
      promptVersion: "p-started-only",
      policyVersion: "v1",
      input: "test",
    })[Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.value).toMatchObject({ type: "STARTED" });
    await iterator.return?.();

    expect(provider.calls).toHaveLength(0);
    const run = await ctx.db.one(
      `select completion_status, error_code, output_tokens,
        estimated_cost_microusd
       from model_runs where prompt_version='p-started-only'`,
    );
    expect(run).toEqual({
      completion_status: "ABORTED",
      error_code: "MODEL_STREAM_ABORTED",
      output_tokens: 0,
      estimated_cost_microusd: "1",
    });
    expect(
      await ctx.db.query(
        "select id from model_runs where completion_status='IN_PROGRESS'",
      ),
    ).toEqual([]);
    expect(
      await ctx.db.one(
        `select committed_cost_microusd from model_budget_usage
         where role='NODE'`,
      ),
    ).toEqual({ committed_cost_microusd: "1" });
  }, 30_000);

  it("requires correlation and version metadata while never persisting prompts or hidden reasoning", async () => {
    const ctx = await testContext();
    const gateway = createModelGateway(ctx.db, fakeModelProvider("safe answer"), {
      roleConfigs: configs(),
    });

    await expect(
      gateway.generate({
        role: "NODE",
        promptVersion: "",
        policyVersion: "v1",
        input: "secret prompt",
      }),
    ).rejects.toThrow("MODEL_PROMPT_VERSION_REQUIRED");
    await expect(
      gateway.generate({
        role: "NODE",
        promptVersion: "p1",
        policyVersion: "",
        input: "secret prompt",
      }),
    ).rejects.toThrow("MODEL_POLICY_VERSION_REQUIRED");

    const columns = await ctx.db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema=current_schema() and table_name='model_runs'`,
    );
    expect(columns.map(({ column_name }) => column_name)).not.toEqual(
      expect.arrayContaining(["input", "prompt", "output", "hidden_reasoning", "reasoning"]),
    );
  }, 30_000);

  it("finalizes the exact reservation month when a stream crosses UTC month end", async () => {
    const ctx = await testContext();
    let now = new Date("2026-01-31T23:59:59.900Z");
    const gateway = createModelGateway(ctx.db, fakeModelProvider("fixed response"), {
      roleConfigs: configs(),
      clock: () => new Date(now),
    });
    const iterator = gateway.stream({
      role: "MAIN",
      promptVersion: "p-month",
      policyVersion: "v1",
      input: "test",
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: "STARTED" });
    now = new Date("2026-02-01T00:00:00.100Z");
    let completed = false;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "COMPLETED") completed = true;
    }

    expect(completed).toBe(true);
    const run = await ctx.db.one(
      "select completion_status from model_runs where prompt_version='p-month'",
    );
    expect(run).toEqual({ completion_status: "COMPLETED" });
    const usage = await ctx.db.query(
      `select budget_month::text, committed_cost_microusd
       from model_budget_usage where role='MAIN' order by budget_month`,
    );
    expect(usage).toEqual([
      { budget_month: "2026-01-01", committed_cost_microusd: "3" },
    ]);
  }, 30_000);

  it("aborts after invocation even when the provider ignores the signal", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream(request) {
        yield { type: "DELTA", text: "one", outputTokens: 1 };
        yield { type: "DELTA", text: "two", outputTokens: 1 };
        yield {
          type: "COMPLETED",
          usage: base.estimateUsage(request.input, "one two", request.modelId),
        };
      },
    };
    const controller = new AbortController();
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });
    const iterator = gateway.stream({
      role: "NODE",
      promptVersion: "p-noncooperative-abort",
      policyVersion: "v1",
      input: "test",
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: "STARTED" });
    expect((await iterator.next()).value).toEqual({ type: "DELTA", text: "one" });
    controller.abort();
    try {
      await expect(iterator.next()).rejects.toThrow("MODEL_PROVIDER_ABORTED");
    } finally {
      await iterator.return?.();
    }

    const run = await ctx.db.one(
      `select completion_status, error_code, output_tokens,
        estimated_cost_microusd
       from model_runs where prompt_version='p-noncooperative-abort'`,
    );
    expect(run).toEqual({
      completion_status: "ABORTED",
      error_code: "MODEL_PROVIDER_ABORTED",
      output_tokens: 1,
      estimated_cost_microusd: "2",
    });
  }, 30_000);

  it("settles an abort when a non-cooperative provider next call never resolves", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield { type: "DELTA", text: "one", outputTokens: 1 };
        await new Promise<never>(() => undefined);
      },
    };
    const controller = new AbortController();
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });
    const iterator = gateway.stream({
      role: "NODE",
      promptVersion: "p-stalled-abort",
      policyVersion: "v1",
      input: "test",
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: "STARTED" });
    expect((await iterator.next()).value).toEqual({ type: "DELTA", text: "one" });
    const pendingNext = iterator.next();
    await Promise.resolve();
    controller.abort();
    await expect(settleWithin(pendingNext, 250)).rejects.toThrow(
      "MODEL_PROVIDER_ABORTED",
    );

    const run = await ctx.db.one(
      `select completion_status, error_code, output_tokens,
        estimated_cost_microusd
       from model_runs where prompt_version='p-stalled-abort'`,
    );
    expect(run).toEqual({
      completion_status: "ABORTED",
      error_code: "MODEL_PROVIDER_ABORTED",
      output_tokens: 1,
      estimated_cost_microusd: "2",
    });
    const usage = await ctx.db.one(
      `select committed_cost_microusd from model_budget_usage
       where role='NODE'`,
    );
    expect(usage).toEqual({ committed_cost_microusd: "2" });
    expect(
      await ctx.db.query(
        "select id from model_runs where completion_status='IN_PROGRESS'",
      ),
    ).toEqual([]);
  }, 30_000);

  it("bounds accounting and fails safely when actual cost exceeds its reservation", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("fixed response");
    let providerCalls = 0;
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream(request) {
        providerCalls += 1;
        yield { type: "DELTA", text: "fixed response", outputTokens: 2 };
        yield {
          type: "COMPLETED",
          usage: {
            ...base.estimateUsage(request.input, "fixed response", request.modelId),
            estimatedCostMicrousd: 100n,
          },
        };
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({
        monthlyBudgetUsd: "0.000003",
        maxOutputTokens: 2,
      }),
    });

    await expect(
      gateway.generate({
        role: "EVALUATOR",
        promptVersion: "p-cost-violation",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_PROVIDER_COST_EXCEEDS_RESERVATION");

    const run = await ctx.db.one(
      `select completion_status, error_code, estimated_cost_microusd,
        reserved_cost_microusd, provider_reported_input_tokens,
        provider_reported_output_tokens, provider_reported_cost_microusd,
        budget_accounted_cost_microusd
       from model_runs where prompt_version='p-cost-violation'`,
    );
    expect(run).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_PROVIDER_COST_EXCEEDS_RESERVATION",
      estimated_cost_microusd: "100",
      reserved_cost_microusd: "3",
      provider_reported_input_tokens: "1",
      provider_reported_output_tokens: "2",
      provider_reported_cost_microusd: "100",
      budget_accounted_cost_microusd: "100",
    });
    const usage = await ctx.db.one(
      `select committed_cost_microusd from model_budget_usage
       where role='EVALUATOR'`,
    );
    expect(usage).toEqual({ committed_cost_microusd: "100" });
    await expect(
      gateway.generate({
        role: "EVALUATOR",
        promptVersion: "p-after-cost-violation",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_BUDGET_EXHAUSTED");
    expect(providerCalls).toBe(1);
    expect(
      await ctx.db.one(
        `select completion_status from model_runs
         where prompt_version='p-after-cost-violation'`,
      ),
    ).toEqual({ completion_status: "BUDGET_REJECTED" });
  }, 30_000);

  it.each(["throws", "invalid"] as const)(
    "fails closed when post-invocation usage estimation %s",
    async (mode) => {
      const ctx = await testContext();
      const base = fakeModelProvider("unused");
      const provider: ModelProviderAdapter = {
        ...base,
        estimateUsage(input, output, modelId) {
          if (mode === "throws") throw new Error("PRIVATE_ESTIMATOR_FAILURE");
          return {
            ...base.estimateUsage(input, output, modelId),
            outputTokens: Number.NaN,
            estimatedCostMicrousd: -1n,
          };
        },
        async *stream() {
          yield { type: "DELTA", text: "partial", outputTokens: 1 };
          throw new Error("PRIVATE_PROVIDER_FAILURE");
        },
      };
      const gateway = createModelGateway(ctx.db, provider, {
        roleConfigs: configs({
          monthlyBudgetUsd: "0.000003",
          maxOutputTokens: 2,
        }),
      });

      await expect(
        gateway.generate({
          role: "MAIN",
          promptVersion: `p-estimate-${mode}`,
          policyVersion: "v1",
          input: "test",
        }),
      ).rejects.toThrow(
        mode === "throws"
          ? "MODEL_PROVIDER_USAGE_UNAVAILABLE"
          : "MODEL_PROVIDER_USAGE_INVALID",
      );

      const run = await ctx.db.one(
        `select completion_status, error_code, reserved_cost_microusd,
          budget_accounted_cost_microusd, provider_reported_input_tokens,
          provider_reported_output_tokens, provider_reported_cost_microusd
         from model_runs where prompt_version=$1`,
        [`p-estimate-${mode}`],
      );
      expect(run).toMatchObject({
        completion_status: "FAILED",
        error_code:
          mode === "throws"
            ? "MODEL_PROVIDER_USAGE_UNAVAILABLE"
            : "MODEL_PROVIDER_USAGE_INVALID",
        reserved_cost_microusd: "3",
        budget_accounted_cost_microusd: "3",
      });
      if (mode === "invalid") {
        expect(run).toMatchObject({
          provider_reported_input_tokens: "1",
          provider_reported_output_tokens: null,
          provider_reported_cost_microusd: null,
        });
      }
      expect(
        await ctx.db.one(
          `select committed_cost_microusd from model_budget_usage
           where role='MAIN'`,
        ),
      ).toEqual({ committed_cost_microusd: "3" });
    },
    30_000,
  );

  it("snapshots mutable partial usage once after provider failure", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const reads = { inputTokens: 0, outputTokens: 0, cost: 0 };
    const provider: ModelProviderAdapter = {
      ...base,
      estimateUsage() {
        return {
          get inputTokens() {
            reads.inputTokens += 1;
            return reads.inputTokens === 1 ? 1 : 999;
          },
          get outputTokens() {
            reads.outputTokens += 1;
            return reads.outputTokens === 1 ? 1 : 999;
          },
          get estimatedCostMicrousd() {
            reads.cost += 1;
            return reads.cost === 1 ? 2n : 999n;
          },
        };
      },
      async *stream() {
        yield { type: "DELTA", text: "one", outputTokens: 1 };
        throw new ModelProviderError("UPSTREAM_UNAVAILABLE");
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({ maxOutputTokens: 2 }),
    });

    await expect(
      gateway.generate({
        role: "MAIN",
        promptVersion: "p-partial-mutable",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("UPSTREAM_UNAVAILABLE");
    expect(reads).toEqual({ inputTokens: 1, outputTokens: 1, cost: 1 });
    expect(
      await ctx.db.one(
        `select completion_status, error_code, provider_reported_input_tokens,
          provider_reported_output_tokens, provider_reported_cost_microusd
         from model_runs where prompt_version='p-partial-mutable'`,
      ),
    ).toEqual({
      completion_status: "FAILED",
      error_code: "UPSTREAM_UNAVAILABLE",
      provider_reported_input_tokens: "1",
      provider_reported_output_tokens: "1",
      provider_reported_cost_microusd: "2",
    });
  }, 30_000);

  it("rejects partial usage that underreports gateway-observed output", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const provider: ModelProviderAdapter = {
      ...base,
      estimateUsage() {
        return {
          inputTokens: 1,
          outputTokens: 0,
          estimatedCostMicrousd: 1n,
        };
      },
      async *stream() {
        yield { type: "DELTA", text: "one", outputTokens: 1 };
        throw new ModelProviderError("UPSTREAM_UNAVAILABLE");
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({
        monthlyBudgetUsd: "0.000003",
        maxOutputTokens: 2,
      }),
    });

    await expect(
      gateway.generate({
        role: "NODE",
        promptVersion: "p-partial-underreported",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_PROVIDER_USAGE_INVALID");
    expect(
      await ctx.db.one(
        `select completion_status, error_code, reserved_cost_microusd,
          provider_reported_output_tokens, provider_reported_cost_microusd,
          budget_accounted_cost_microusd
         from model_runs where prompt_version='p-partial-underreported'`,
      ),
    ).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_PROVIDER_USAGE_INVALID",
      reserved_cost_microusd: "3",
      provider_reported_output_tokens: "0",
      provider_reported_cost_microusd: "1",
      budget_accounted_cost_microusd: "3",
    });
  }, 30_000);

  it("charges the full reservation when an otherwise-low usage tuple is invalid", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield { type: "DELTA", text: "one", outputTokens: 1 };
        yield {
          type: "COMPLETED",
          usage: {
            inputTokens: 999,
            outputTokens: 1,
            estimatedCostMicrousd: 1n,
          },
        };
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({
        monthlyBudgetUsd: "0.000003",
        maxOutputTokens: 2,
      }),
    });

    await expect(
      gateway.generate({
        role: "MAIN",
        promptVersion: "p-atomic-usage",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_PROVIDER_USAGE_INVALID");
    expect(
      await ctx.db.one(
        `select completion_status, error_code, reserved_cost_microusd,
          provider_reported_input_tokens, provider_reported_cost_microusd,
          budget_accounted_cost_microusd
         from model_runs where prompt_version='p-atomic-usage'`,
      ),
    ).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_PROVIDER_USAGE_INVALID",
      reserved_cost_microusd: "3",
      provider_reported_input_tokens: "999",
      provider_reported_cost_microusd: "1",
      budget_accounted_cost_microusd: "3",
    });
    expect(
      await ctx.db.one(
        `select committed_cost_microusd from model_budget_usage
         where role='MAIN'`,
      ),
    ).toEqual({ committed_cost_microusd: "3" });
  }, 30_000);

  it("snapshots the request and role configuration before STARTED", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("fixed response");
    const seen: { role: string; input: string; modelId: string }[] = [];
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream(request) {
        seen.push({
          role: request.role,
          input: request.input,
          modelId: request.modelId,
        });
        yield* base.stream(request);
      },
    };
    const roleConfigs = configs({ maxOutputTokens: 2 });
    const request: {
      role: ModelRole;
      promptVersion: string;
      policyVersion: string;
      input: string;
    } = {
      role: "NODE",
      promptVersion: "p-snapshot",
      policyVersion: "v1",
      input: "original input",
    };
    const gateway = createModelGateway(ctx.db, provider, { roleConfigs });
    const iterator = gateway.stream(request)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: "STARTED" });
    request.role = "EVALUATOR";
    request.input = "mutated input that must not escape";
    request.promptVersion = "mutated-prompt";
    (roleConfigs.NODE as { modelId: string }).modelId = "mutated-model";
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
    }

    expect(seen).toEqual([
      {
        role: "NODE",
        input: "original input",
        modelId: "deterministic-node-v1",
      },
    ]);
    expect(
      await ctx.db.one(
        `select role, model, prompt_version, input_tokens, completion_status
         from model_runs where prompt_version='p-snapshot'`,
      ),
    ).toEqual({
      role: "NODE",
      model: "deterministic-node-v1",
      prompt_version: "p-snapshot",
      input_tokens: 2,
      completion_status: "COMPLETED",
    });
  }, 30_000);

  it("retains a frozen production role-config snapshot after construction", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("fixed response");
    const provider: ModelProviderAdapter = {
      ...base,
      providerId: "trusted-provider",
    };
    const roleConfigs = configs({ providerId: "trusted-provider" });
    vi.stubEnv("NODE_ENV", "production");
    try {
      const gateway = createModelGateway(ctx.db, provider, { roleConfigs });
      Object.assign(roleConfigs.NODE as object, {
        providerId: "fake",
        modelId: "mutated-model",
        monthlyBudgetUsd: "0.00",
        maxInputTokens: 1,
        maxOutputTokens: 1,
      });

      const result = await gateway.generate({
        role: "NODE",
        promptVersion: "p-config-snapshot",
        policyVersion: "v1",
        input: "original input",
      });
      expect(result.output).toBe("fixed response");
      expect(base.calls).toEqual([
        {
          role: "NODE",
          modelId: "deterministic-node-v1",
          maxOutputTokens: 1_024,
        },
      ]);
      expect(
        await ctx.db.one(
          `select provider, model, max_input_tokens, max_output_tokens,
            completion_status
           from model_runs where prompt_version='p-config-snapshot'`,
        ),
      ).toEqual({
        provider: "trusted-provider",
        model: "deterministic-node-v1",
        max_input_tokens: 4096,
        max_output_tokens: 1024,
        completion_status: "COMPLETED",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it.each(["completed", "failed"] as const)(
    "reads and swallows a throwing iterator return getter once after %s",
    async (terminal) => {
      const ctx = await testContext();
      const base = fakeModelProvider("unused");
      let returnReads = 0;
      const provider: ModelProviderAdapter = {
        ...base,
        stream() {
          let nextCalls = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<ModelProviderEvent>> {
                  nextCalls += 1;
                  if (terminal === "failed") {
                    throw new ModelProviderError("UPSTREAM_UNAVAILABLE");
                  }
                  if (nextCalls === 1) {
                    return {
                      done: false,
                      value: {
                        type: "COMPLETED",
                        usage: {
                          inputTokens: 1,
                          outputTokens: 0,
                          estimatedCostMicrousd: 1n,
                        },
                      },
                    };
                  }
                  return { done: true, value: undefined };
                },
                get return(): AsyncIterator<ModelProviderEvent>["return"] {
                  returnReads += 1;
                  throw new Error("PRIVATE_CLEANUP_GETTER");
                },
              };
            },
          };
        },
      };
      const gateway = createModelGateway(ctx.db, provider, {
        roleConfigs: configs(),
      });
      const request = {
        role: "EVALUATOR" as const,
        promptVersion: `p-return-getter-${terminal}`,
        policyVersion: "v1",
        input: "test",
      };

      if (terminal === "completed") {
        await expect(gateway.generate(request)).resolves.toMatchObject({ output: "" });
      } else {
        await expect(gateway.generate(request)).rejects.toThrow(
          "UPSTREAM_UNAVAILABLE",
        );
      }
      expect(returnReads).toBe(1);
      expect(
        await ctx.db.one(
          `select completion_status, error_code from model_runs
           where prompt_version=$1`,
          [request.promptVersion],
        ),
      ).toEqual(
        terminal === "completed"
          ? { completion_status: "COMPLETED", error_code: null }
          : {
              completion_status: "FAILED",
              error_code: "UPSTREAM_UNAVAILABLE",
            },
      );
    },
    30_000,
  );

  it("normalizes arbitrary provider abort errors without exposing them", async () => {
    const ctx = await testContext();
    const controller = new AbortController();
    const base = fakeModelProvider("unused");
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield { type: "DELTA", text: "one", outputTokens: 1 };
        controller.abort();
        throw new DOMException("PRIVATE_PROVIDER_ABORT_DETAIL", "AbortError");
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });

    await expect(
      gateway.generate({
        role: "NODE",
        promptVersion: "p-abort-normalized",
        policyVersion: "v1",
        input: "test",
        signal: controller.signal,
      }),
    ).rejects.toThrow("MODEL_PROVIDER_ABORTED");
    const run = await ctx.db.one(
      `select completion_status, error_code from model_runs
       where prompt_version='p-abort-normalized'`,
    );
    expect(run).toEqual({
      completion_status: "ABORTED",
      error_code: "MODEL_PROVIDER_ABORTED",
    });
  }, 30_000);

  it("normalizes a provider-originated AbortError without a caller signal", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const providerAbort = new DOMException("PRIVATE_PROVIDER_ABORT_DETAIL", "AbortError");
    const wrappedAbort = new Error("PRIVATE_PROVIDER_WRAPPER", {
      cause: providerAbort,
    });
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield { type: "DELTA", text: "one", outputTokens: 1 };
        throw wrappedAbort;
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });

    let caught: unknown;
    try {
      await gateway.generate({
        role: "NODE",
        promptVersion: "p-provider-abort",
        policyVersion: "v1",
        input: "test",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("MODEL_PROVIDER_ABORTED");
    expect((caught as Error).message).not.toContain("PRIVATE_PROVIDER");
    expect((caught as Error).cause).toBeUndefined();
    expect(
      await ctx.db.one(
        `select completion_status, error_code from model_runs
         where prompt_version='p-provider-abort'`,
      ),
    ).toEqual({
      completion_status: "ABORTED",
      error_code: "MODEL_PROVIDER_ABORTED",
    });
  }, 30_000);

  it("never exposes or audits unknown provider error text or nested causes", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const secretCause = new Error("SECRET_NESTED_RESPONSE_BODY");
    const secretProviderError = new Error("SECRET_UPPERCASE_RESPONSE_BODY", {
      cause: secretCause,
    });
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        throw secretProviderError;
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });

    let caught: unknown;
    try {
      await gateway.generate({
        role: "EVALUATOR",
        promptVersion: "p-secret-provider-error",
        policyVersion: "v1",
        input: "test",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("MODEL_PROVIDER_FAILURE");
    expect((caught as Error).cause).toBeUndefined();
    expect(String(caught)).not.toContain("SECRET");
    expect(JSON.stringify(caught)).not.toContain("SECRET");
    expect(
      await ctx.db.one(
        `select completion_status, error_code from model_runs
         where prompt_version='p-secret-provider-error'`,
      ),
    ).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_PROVIDER_FAILURE",
    });
  }, 30_000);

  it.each(["count", "reserve"] as const)(
    "normalizes an adversarial %s callback exception before SQL or provider invocation",
    async (callback) => {
      const ctx = await testContext();
      const base = fakeModelProvider("unused");
      const adversarial = new Proxy(Object.create(null) as object, {
        get() {
          throw new Error("SECRET_THROWING_GETTER");
        },
        getPrototypeOf() {
          throw new Error("SECRET_THROWING_PROTOTYPE");
        },
        has() {
          throw new Error("SECRET_THROWING_HAS");
        },
      });
      const provider: ModelProviderAdapter = {
        ...base,
        countInputTokens(input) {
          if (callback === "count") throw adversarial;
          return base.countInputTokens(input);
        },
        estimateMaximumCostMicrousd(inputTokens, maxOutputTokens, modelId) {
          if (callback === "reserve") throw adversarial;
          return base.estimateMaximumCostMicrousd(
            inputTokens,
            maxOutputTokens,
            modelId,
          );
        },
      };
      const gateway = createModelGateway(ctx.db, provider, {
        roleConfigs: configs(),
      });

      let caught: unknown;
      try {
        await gateway.generate({
          role: "MAIN",
          promptVersion: `p-adversarial-${callback}`,
          policyVersion: "v1",
          input: "test",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("MODEL_PROVIDER_FAILURE");
      expect((caught as Error).cause).toBeUndefined();
      expect(String(caught)).not.toContain("SECRET");
      expect(await ctx.db.query("select id from model_runs")).toEqual([]);
      expect(base.calls).toHaveLength(0);
    },
    30_000,
  );

  it("rejects a forged adapter-safe error code as a generic provider failure", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const forged = new ModelProviderError("UPSTREAM_UNAVAILABLE");
    (forged as { code: string }).code = "SECRET_FORGED_RESPONSE_BODY";
    Object.defineProperty(forged, "message", {
      value: "SECRET_FORGED_RESPONSE_BODY",
    });
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        throw forged;
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });

    await expect(
      gateway.generate({
        role: "NODE",
        promptVersion: "p-forged-safe-code",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_PROVIDER_FAILURE");
    expect(
      await ctx.db.one(
        `select error_code from model_runs
         where prompt_version='p-forged-safe-code'`,
      ),
    ).toEqual({ error_code: "MODEL_PROVIDER_FAILURE" });
  }, 30_000);

  it("rejects a non-string delta before appending or yielding it", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield {
          type: "DELTA",
          text: 42 as unknown as string,
          outputTokens: 1,
        };
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });
    const events = gateway.stream({
      role: "MAIN",
      promptVersion: "p-non-string-delta",
      policyVersion: "v1",
      input: "test",
    })[Symbol.asyncIterator]();
    await events.next();
    await expect(events.next()).rejects.toThrow("MODEL_PROVIDER_EVENT_INVALID");
    expect(
      await ctx.db.one(
        `select completion_status, error_code from model_runs
         where prompt_version='p-non-string-delta'`,
      ),
    ).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_PROVIDER_EVENT_INVALID",
    });
  }, 30_000);

  it("reads a proxy delta once and yields only a fresh normalized copy", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const reads = { type: 0, text: 0, outputTokens: 0 };
    const proxyDelta = {
      get type() {
        reads.type += 1;
        return "DELTA" as const;
      },
      get text() {
        reads.text += 1;
        return "one";
      },
      get outputTokens() {
        reads.outputTokens += 1;
        return reads.outputTokens === 1 ? 1 : 999;
      },
    };
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield proxyDelta;
        yield {
          type: "COMPLETED",
          usage: { inputTokens: 1, outputTokens: 1, estimatedCostMicrousd: 2n },
        };
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({ maxOutputTokens: 2 }),
    });
    const streamed = [];
    for await (const event of gateway.stream({
      role: "NODE",
      promptVersion: "p-proxy-delta",
      policyVersion: "v1",
      input: "test",
    })) {
      streamed.push(event);
    }

    expect(reads).toEqual({ type: 1, text: 1, outputTokens: 1 });
    expect(streamed[1]).toEqual({ type: "DELTA", text: "one" });
    expect(streamed[1]).not.toBe(proxyDelta);
  }, 30_000);

  it("snapshots and freezes completion usage from mutable getters exactly once", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const reads = { inputTokens: 0, outputTokens: 0, cost: 0 };
    const mutableUsage = {
      get inputTokens() {
        reads.inputTokens += 1;
        return reads.inputTokens === 1 ? 1 : 999;
      },
      get outputTokens() {
        reads.outputTokens += 1;
        return reads.outputTokens === 1 ? 0 : 999;
      },
      get estimatedCostMicrousd() {
        reads.cost += 1;
        return reads.cost === 1 ? 1n : 999n;
      },
    };
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield { type: "COMPLETED", usage: mutableUsage };
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });

    const result = await gateway.generate({
      role: "EVALUATOR",
      promptVersion: "p-mutable-completion",
      policyVersion: "v1",
      input: "test",
    });
    expect(reads).toEqual({ inputTokens: 1, outputTokens: 1, cost: 1 });
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 0,
      estimatedCostMicrousd: 1n,
    });
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(
      await ctx.db.one(
        `select provider_reported_input_tokens, provider_reported_output_tokens,
          provider_reported_cost_microusd
         from model_runs where prompt_version='p-mutable-completion'`,
      ),
    ).toEqual({
      provider_reported_input_tokens: "1",
      provider_reported_output_tokens: "0",
      provider_reported_cost_microusd: "1",
    });
  }, 30_000);

  it("snapshots and freezes reported provider metering independently of observed usage", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const reads = {
      providerMetering: 0,
      status: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const mutableMetering = {
      get status() {
        reads.status += 1;
        return reads.status === 1 ? "REPORTED" as const : "UNKNOWN" as const;
      },
      get inputTokens() {
        reads.inputTokens += 1;
        return reads.inputTokens === 1 ? 77 : -1;
      },
      get outputTokens() {
        reads.outputTokens += 1;
        return reads.outputTokens === 1 ? 9 : -1;
      },
    };
    const mutableUsage = {
      inputTokens: 1,
      outputTokens: 0,
      estimatedCostMicrousd: 0n,
      get providerMetering() {
        reads.providerMetering += 1;
        return mutableMetering;
      },
    };
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield { type: "COMPLETED", usage: mutableUsage } as ModelProviderEvent;
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });

    const result = await gateway.generate({
      role: "NODE",
      promptVersion: "p-reported-metering",
      policyVersion: "v1",
      input: "test",
    });
    const usage = result.usage as typeof result.usage & {
      readonly providerMetering: {
        readonly status: "REPORTED";
        readonly inputTokens: number;
        readonly outputTokens: number;
      };
    };
    expect(reads).toEqual({
      providerMetering: 1,
      status: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(usage.providerMetering).toEqual({
      status: "REPORTED",
      inputTokens: 77,
      outputTokens: 9,
    });
    expect(Object.isFrozen(usage.providerMetering)).toBe(true);
    expect(Object.isFrozen(usage)).toBe(true);
  }, 30_000);

  it("snapshots and freezes explicit unknown metering while legacy providers stay unchanged", async () => {
    const unknownContext = await testContext();
    const base = fakeModelProvider("unused");
    const unknownProvider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield {
          type: "COMPLETED",
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            estimatedCostMicrousd: 0n,
            providerMetering: { status: "UNKNOWN" },
          },
        } as ModelProviderEvent;
      },
    };
    const unknownResult = await createModelGateway(unknownContext.db, unknownProvider, {
      roleConfigs: configs(),
    }).generate({
      role: "EVALUATOR",
      promptVersion: "p-unknown-metering",
      policyVersion: "v1",
      input: "test",
    });
    const unknownUsage = unknownResult.usage as typeof unknownResult.usage & {
      readonly providerMetering: { readonly status: "UNKNOWN" };
    };
    expect(unknownUsage.providerMetering).toEqual({ status: "UNKNOWN" });
    expect(Object.isFrozen(unknownUsage.providerMetering)).toBe(true);

    const legacyContext = await testContext();
    const legacyResult = await createModelGateway(
      legacyContext.db,
      fakeModelProvider("legacy response"),
      { roleConfigs: configs() },
    ).generate({
      role: "MAIN",
      promptVersion: "p-legacy-metering",
      policyVersion: "v1",
      input: "test",
    });
    expect(legacyResult.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      estimatedCostMicrousd: 3n,
    });
    expect(legacyResult.usage).not.toHaveProperty("providerMetering");
  }, 30_000);

  it.each([
    { status: "REPORTED", inputTokens: 1 },
    { status: "REPORTED", inputTokens: -1, outputTokens: 0 },
    { status: "UNKNOWN", outputTokens: 0 },
    { status: "INFERRED" },
  ])("rejects malformed provider metering without exposing it: $status", async (providerMetering) => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield {
          type: "COMPLETED",
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            estimatedCostMicrousd: 0n,
            providerMetering,
          },
        } as ModelProviderEvent;
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });

    await expect(gateway.generate({
      role: "NODE",
      promptVersion: `p-malformed-metering-${String(providerMetering.status)}`,
      policyVersion: "v1",
      input: "test",
    })).rejects.toThrow("MODEL_PROVIDER_EVENT_INVALID");
    expect(
      await ctx.db.one(
        `select completion_status, error_code from model_runs
         where prompt_version=$1`,
        [`p-malformed-metering-${String(providerMetering.status)}`],
      ),
    ).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_PROVIDER_EVENT_INVALID",
    });
  }, 30_000);

  it("saturates accounting when reported incurred cost exceeds BIGINT", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    let providerCalls = 0;
    const overBigint = 9_223_372_036_854_775_808n;
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        providerCalls += 1;
        yield {
          type: "COMPLETED",
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            estimatedCostMicrousd: overBigint,
          },
        };
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });
    await expect(
      gateway.generate({
        role: "MAIN",
        promptVersion: "p-over-bigint",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_PROVIDER_COST_RANGE_INVALID");
    expect(
      await ctx.db.one(
        `select completion_status, error_code, provider_reported_cost_microusd,
          budget_accounted_cost_microusd
         from model_runs where prompt_version='p-over-bigint'`,
      ),
    ).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_PROVIDER_COST_RANGE_INVALID",
      provider_reported_cost_microusd: overBigint.toString(),
      budget_accounted_cost_microusd: "9223372036854775807",
    });
    expect(
      await ctx.db.one(
        `select committed_cost_microusd from model_budget_usage
         where role='MAIN'`,
      ),
    ).toEqual({ committed_cost_microusd: "9223372036854775807" });
    await expect(
      gateway.generate({
        role: "MAIN",
        promptVersion: "p-after-over-bigint",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_BUDGET_EXHAUSTED");
    expect(providerCalls).toBe(1);
  }, 30_000);

  it("keeps a saturated role-month budget sticky across concurrent finalization", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const providerCalls: string[] = [];
    const provider: ModelProviderAdapter = {
      ...base,
      estimateMaximumCostMicrousd: () => 10n,
      async *stream(request) {
        providerCalls.push(request.input);
        yield {
          type: "COMPLETED",
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            estimatedCostMicrousd:
              request.input === "A" ? 9_223_372_036_854_775_808n : 1n,
          },
        };
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({ monthlyBudgetUsd: "10.00" }),
    });
    const runA = gateway.stream({
      role: "NODE",
      promptVersion: "p-sticky-a",
      policyVersion: "v1",
      input: "A",
    })[Symbol.asyncIterator]();
    const runB = gateway.stream({
      role: "NODE",
      promptVersion: "p-sticky-b",
      policyVersion: "v1",
      input: "B",
    })[Symbol.asyncIterator]();

    const [startedA, startedB] = await Promise.all([runA.next(), runB.next()]);
    expect(startedA.value).toMatchObject({ type: "STARTED" });
    expect(startedB.value).toMatchObject({ type: "STARTED" });
    await expect(runA.next()).rejects.toThrow("MODEL_PROVIDER_COST_RANGE_INVALID");
    expect((await runB.next()).value).toMatchObject({ type: "COMPLETED" });
    await runB.return?.();

    expect(
      await ctx.db.one(
        `select committed_cost_microusd from model_budget_usage
         where role='NODE'`,
      ),
    ).toEqual({ committed_cost_microusd: "9223372036854775807" });
    await expect(
      gateway.generate({
        role: "NODE",
        promptVersion: "p-sticky-after",
        policyVersion: "v1",
        input: "C",
      }),
    ).rejects.toThrow("MODEL_BUDGET_EXHAUSTED");
    expect(providerCalls).toEqual(["A", "B"]);
  }, 30_000);

  it("caps enormous provider cost evidence without leaving an in-progress run", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const enormousCost = 10n ** 150n;
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield {
          type: "COMPLETED",
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            estimatedCostMicrousd: enormousCost,
          },
        };
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs(),
    });

    await expect(
      gateway.generate({
        role: "MAIN",
        promptVersion: "p-enormous-evidence",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_PROVIDER_COST_RANGE_INVALID");
    expect(
      await ctx.db.one(
        `select completion_status, error_code, provider_reported_cost_microusd,
          budget_accounted_cost_microusd
         from model_runs where prompt_version='p-enormous-evidence'`,
      ),
    ).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_PROVIDER_COST_RANGE_INVALID",
      provider_reported_cost_microusd: "9".repeat(100),
      budget_accounted_cost_microusd: "9223372036854775807",
    });
    expect(
      await ctx.db.query(
        "select id from model_runs where completion_status='IN_PROGRESS'",
      ),
    ).toEqual([]);
  }, 30_000);

  it("stops before yielding a delta that exceeds the incremental output ceiling", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const provider: ModelProviderAdapter = {
      ...base,
      async *stream() {
        yield { type: "DELTA", text: "one", outputTokens: 1 };
        yield { type: "DELTA", text: "two three", outputTokens: 2 };
        await new Promise<never>(() => undefined);
      },
    };
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({
        monthlyBudgetUsd: "0.000003",
        maxOutputTokens: 2,
      }),
    });
    const iterator = gateway.stream({
      role: "MAIN",
      promptVersion: "p-incremental-limit",
      policyVersion: "v1",
      input: "test",
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: "STARTED" });
    expect((await iterator.next()).value).toMatchObject({
      type: "DELTA",
      text: "one",
    });
    await expect(settleWithin(iterator.next(), 250)).rejects.toThrow(
      "MODEL_OUTPUT_TOKEN_LIMIT_EXCEEDED",
    );
    const run = await ctx.db.one(
      `select completion_status, error_code, output_tokens,
        budget_accounted_cost_microusd
       from model_runs where prompt_version='p-incremental-limit'`,
    );
    expect(run).toEqual({
      completion_status: "FAILED",
      error_code: "MODEL_OUTPUT_TOKEN_LIMIT_EXCEEDED",
      output_tokens: 1,
      budget_accounted_cost_microusd: "3",
    });
    expect(
      await ctx.db.query(
        "select id from model_runs where completion_status='IN_PROGRESS'",
      ),
    ).toEqual([]);
    expect(
      await ctx.db.one(
        `select committed_cost_microusd from model_budget_usage
         where role='MAIN'`,
      ),
    ).toEqual({ committed_cost_microusd: "3" });
  }, 30_000);

  it("rejects token, budget, and reservation values outside PostgreSQL ranges", async () => {
    const ctx = await testContext();
    const base = fakeModelProvider("unused");
    const oversizedTokens: ModelProviderAdapter = {
      ...base,
      countInputTokens: () => 2_147_483_648,
    };
    const tokenGateway = createModelGateway(ctx.db, oversizedTokens, {
      roleConfigs: configs(),
    });
    await expect(
      tokenGateway.generate({
        role: "MAIN",
        promptVersion: "p-token-range",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_PROVIDER_TOKEN_COUNT_INVALID");

    const oversizedReservation: ModelProviderAdapter = {
      ...base,
      estimateMaximumCostMicrousd: () => 9_223_372_036_854_775_808n,
    };
    const reservationGateway = createModelGateway(ctx.db, oversizedReservation, {
      roleConfigs: configs(),
    });
    await expect(
      reservationGateway.generate({
        role: "MAIN",
        promptVersion: "p-cost-range",
        policyVersion: "v1",
        input: "test",
      }),
    ).rejects.toThrow("MODEL_COST_ESTIMATE_RANGE_INVALID");

    expect(() =>
      createModelGateway(ctx.db, base, {
        roleConfigs: configs({ monthlyBudgetUsd: "9223372036854.775808" }),
      }),
    ).toThrow("MODEL_BUDGET_RANGE_INVALID");
    expect(await ctx.db.query("select id from model_runs")).toEqual([]);
    expect(base.calls).toHaveLength(0);
  }, 30_000);

  it("rejects oversized production token limits before gateway construction", () => {
    const environment: Record<string, string> = {};
    for (const role of roles) {
      environment[`GUSTAVO_MODEL_${role}_PROVIDER`] = "provider";
      environment[`GUSTAVO_MODEL_${role}_MODEL`] = `model-${role.toLowerCase()}`;
      environment[`GUSTAVO_MODEL_${role}_MONTHLY_BUDGET_USD`] = "10.00";
    }
    environment.GUSTAVO_MODEL_MAIN_MAX_INPUT_TOKENS = "2147483648";
    expect(() => loadProductionModelRoleConfigs(environment)).toThrow(
      "PRODUCTION_MODEL_LIMIT_INVALID:MAIN",
    );
  });

  it("uses concurrency-safe monthly role reservations", async () => {
    const ctx = await testContext();
    const provider = fakeModelProvider({ response: "fixed response", delayMs: 50 });
    const gateway = createModelGateway(ctx.db, provider, {
      roleConfigs: configs({
        monthlyBudgetUsd: "0.001025",
        maxOutputTokens: 1_024,
      }),
    });
    const request = {
      role: "NODE" as const,
      promptVersion: "p-race",
      policyVersion: "v1",
      input: "test",
    };

    const settled = await Promise.allSettled([
      gateway.generate(request),
      gateway.generate(request),
    ]);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  }, 30_000);

  it("automatically rejects missing, default, or fake production role configuration", async () => {
    expect(() => loadProductionModelRoleConfigs({})).toThrow(
      "PRODUCTION_MODEL_CONFIG_REQUIRED:MAIN",
    );

    const ctx = await testContext();
    vi.stubEnv("NODE_ENV", "production");
    for (const role of roles) {
      vi.stubEnv(`GUSTAVO_MODEL_${role}_PROVIDER`, "");
      vi.stubEnv(`GUSTAVO_MODEL_${role}_MODEL`, "");
      vi.stubEnv(`GUSTAVO_MODEL_${role}_MONTHLY_BUDGET_USD`, "");
    }
    try {
      expect(() => createModelGateway(ctx.db, fakeModelProvider("unused"))).toThrow(
        "PRODUCTION_MODEL_CONFIG_REQUIRED:MAIN",
      );
      expect(() =>
        createModelGateway(ctx.db, fakeModelProvider("unused"), {
          roleConfigs: configs(),
        }),
      ).toThrow("PRODUCTION_MODEL_PROVIDER_INVALID:MAIN");
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
