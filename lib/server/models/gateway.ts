import { randomUUID } from "node:crypto";
import type { EventDatabase } from "../events/types";
import { operationalMetrics } from "../observability/metrics";
import {
  MODEL_ROLES,
  MODEL_PROVIDER_SAFE_ERROR_CODES,
  ModelProviderError,
  type ModelGateway,
  type ModelGatewayEvent,
  type ModelGatewayOptions,
  type ModelGenerationRequest,
  type ModelGenerationResult,
  type ModelProviderAdapter,
  type ModelProviderEvent,
  type ModelProviderUsage,
  type ModelRole,
  type ModelRoleConfig,
  type ModelRoleConfigs,
} from "./types";

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSTGRES_INT_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const POSTGRES_NUMERIC_EVIDENCE_MAX = 10n ** 100n - 1n;
const MAX_OUTPUT_CHARACTERS = 16 * 1024 * 1024;
const MAX_CHARACTERS_PER_OUTPUT_TOKEN = 32;
const UNREADABLE_PROVIDER_VALUE = Symbol("UNREADABLE_PROVIDER_VALUE");
const SAFE_PROVIDER_ERROR_CODES = new Set<string>(MODEL_PROVIDER_SAFE_ERROR_CODES);

class ModelGatewayExecutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ModelGatewayExecutionError";
    this.code = code;
  }
}

interface PreparedRun {
  readonly runId: string;
  readonly role: ModelRole;
  readonly input: string;
  readonly signal?: AbortSignal;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly promptVersion: string;
  readonly policyVersion: string;
  readonly startedAtMs: number;
  readonly inputTokens: number;
  readonly reservedCostMicrousd: bigint;
  readonly budgetMonth: string;
  readonly config: ModelRoleConfig;
  readonly provider: ModelProviderAdapter;
}

interface FinalizeRunInput {
  readonly status: "COMPLETED" | "FAILED" | "ABORTED";
  readonly errorCode: string | null;
  readonly usage?: ModelProviderUsage;
  readonly accountedCostMicrousd: bigint;
}

interface UsageAssessment {
  readonly usage?: ModelProviderUsage;
  readonly accountedCostMicrousd: bigint;
  readonly violationCode?: string;
}

function dollarsToMicrousd(value: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/u.test(value)) {
    throw new Error("MODEL_BUDGET_INVALID");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const microusd = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (microusd > POSTGRES_BIGINT_MAX) {
    throw new Error("MODEL_BUDGET_RANGE_INVALID");
  }
  return microusd;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > POSTGRES_INT_MAX) {
    throw new Error(code);
  }
  return value;
}

function requiredVersion(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) throw new Error(code);
  return normalized;
}

function assertUuid(value: string, code: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(code);
  return value;
}

function budgetMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function clockMilliseconds(clock: () => Date): number {
  const milliseconds = clock().getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("MODEL_CLOCK_INVALID");
  return milliseconds;
}

function postgresLatency(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
  return Math.min(Math.floor(milliseconds), POSTGRES_INT_MAX);
}

function readProviderProperty(
  value: unknown,
  property: PropertyKey,
): unknown | typeof UNREADABLE_PROVIDER_VALUE {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return UNREADABLE_PROVIDER_VALUE;
  }
  try {
    return Reflect.get(value, property);
  } catch {
    return UNREADABLE_PROVIDER_VALUE;
  }
}

function safeErrorCode(error: unknown): string {
  try {
    if (error instanceof ModelGatewayExecutionError) return error.code;
    if (error instanceof ModelProviderError) {
      const code = readProviderProperty(error, "code");
      if (typeof code === "string" && SAFE_PROVIDER_ERROR_CODES.has(code)) {
        return code;
      }
    }
  } catch {
    return "MODEL_PROVIDER_FAILURE";
  }
  return "MODEL_PROVIDER_FAILURE";
}

function modelAbortError(): Error {
  return new ModelGatewayExecutionError("MODEL_PROVIDER_ABORTED");
}

function modelExecutionError(code: string): Error {
  return new ModelGatewayExecutionError(code);
}

function isProviderAbortError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (visited.has(current)) return false;
    visited.add(current);
    const name = readProviderProperty(current, "name");
    if (name === "AbortError") return true;
    const message = readProviderProperty(current, "message");
    if (message === "MODEL_PROVIDER_ABORTED") return true;
    const cause = readProviderProperty(current, "cause");
    current = cause === UNREADABLE_PROVIDER_VALUE ? undefined : cause;
  }
  return false;
}

function callProviderCallback<Result>(callback: () => Result): Result {
  try {
    return callback();
  } catch (error) {
    if (isProviderAbortError(error)) throw modelAbortError();
    throw modelExecutionError(safeErrorCode(error));
  }
}

function nextProviderEvent<Event>(
  iterator: AsyncIterator<Event>,
  signal?: AbortSignal,
): Promise<IteratorResult<Event>> {
  if (!signal) return Promise.resolve(iterator.next());
  if (signal.aborted) return Promise.reject(modelAbortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      outcome: { readonly value: IteratorResult<Event> } | { readonly error: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const onAbort = (): void => finish({ error: modelAbortError() });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      Promise.resolve(iterator.next()).then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    } catch (error) {
      finish({ error });
    }
  });
}

function closeProviderIteratorBestEffort<Event>(
  iterator: AsyncIterator<Event>,
): void {
  try {
    const returnIterator = iterator.return;
    if (typeof returnIterator !== "function") return;
    void Promise.resolve(Reflect.apply(returnIterator, iterator, [])).catch(
      () => undefined,
    );
  } catch {
    // The run audit is authoritative; adapter cleanup cannot block it.
  }
}

function snapshotProviderUsage(
  rawUsage: unknown,
  invalidCode: string,
): ModelProviderUsage {
  const inputTokens = readProviderProperty(rawUsage, "inputTokens");
  const outputTokens = readProviderProperty(rawUsage, "outputTokens");
  const estimatedCostMicrousd = readProviderProperty(
    rawUsage,
    "estimatedCostMicrousd",
  );
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof estimatedCostMicrousd !== "bigint"
  ) {
    throw modelExecutionError(invalidCode);
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    estimatedCostMicrousd,
  });
}

function normalizeProviderEvent(event: unknown): ModelProviderEvent {
  const type = readProviderProperty(event, "type");
  if (type === "DELTA") {
    const text = readProviderProperty(event, "text");
    const outputTokens = readProviderProperty(event, "outputTokens");
    if (
      typeof text !== "string" ||
      typeof outputTokens !== "number" ||
      !Number.isSafeInteger(outputTokens)
    ) {
      throw modelExecutionError("MODEL_PROVIDER_EVENT_INVALID");
    }
    return Object.freeze({ type, text, outputTokens });
  }
  if (type === "COMPLETED") {
    const rawUsage = readProviderProperty(event, "usage");
    const usage = snapshotProviderUsage(rawUsage, "MODEL_PROVIDER_EVENT_INVALID");
    return Object.freeze({ type, usage });
  }
  throw modelExecutionError("MODEL_PROVIDER_EVENT_INVALID");
}

function defaultRoleConfigs(
  provider: ModelProviderAdapter,
  options: ModelGatewayOptions,
): ModelRoleConfigs {
  const config = {
    providerId: provider.providerId,
    modelId: "deterministic-v1",
    monthlyBudgetUsd: options.monthlyBudgetUsd ?? "10.00",
    maxInputTokens: options.maxInputTokens ?? 4_096,
    maxOutputTokens: options.maxOutputTokens ?? 1_024,
  };
  return {
    MAIN: { ...config },
    NODE: { ...config },
    EVALUATOR: { ...config },
  };
}

function validateRoleConfigs(
  configs: ModelRoleConfigs,
  production: boolean,
): void {
  for (const role of MODEL_ROLES) {
    const config = configs[role];
    if (!config || !IDENTIFIER_PATTERN.test(config.providerId)) {
      throw new Error(`MODEL_PROVIDER_INVALID:${role}`);
    }
    if (!IDENTIFIER_PATTERN.test(config.modelId)) {
      throw new Error(`MODEL_ID_INVALID:${role}`);
    }
    dollarsToMicrousd(config.monthlyBudgetUsd);
    positiveInteger(config.maxInputTokens, `MODEL_INPUT_LIMIT_INVALID:${role}`);
    positiveInteger(config.maxOutputTokens, `MODEL_OUTPUT_LIMIT_INVALID:${role}`);
    if (production && config.providerId === "fake") {
      throw new Error(`PRODUCTION_MODEL_PROVIDER_INVALID:${role}`);
    }
  }
}

function snapshotRoleConfigs(configs: ModelRoleConfigs): ModelRoleConfigs {
  const entries = MODEL_ROLES.map((role) => {
    const config = configs[role];
    if (!config) return [role, config] as const;
    return [
      role,
      Object.freeze({
        providerId: config.providerId,
        modelId: config.modelId,
        monthlyBudgetUsd: config.monthlyBudgetUsd,
        maxInputTokens: config.maxInputTokens,
        maxOutputTokens: config.maxOutputTokens,
      }),
    ] as const;
  });
  return Object.freeze(
    Object.fromEntries(entries),
  ) as unknown as ModelRoleConfigs;
}

function envRequired(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  role: ModelRole,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`PRODUCTION_MODEL_CONFIG_REQUIRED:${role}`);
  return value;
}

function envLimit(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  role: ModelRole,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  return positiveInteger(Number(raw), `PRODUCTION_MODEL_LIMIT_INVALID:${role}`);
}

export function loadProductionModelRoleConfigs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ModelRoleConfigs {
  const entries = MODEL_ROLES.map((role) => {
    const prefix = `GUSTAVO_MODEL_${role}`;
    const config: ModelRoleConfig = {
      providerId: envRequired(environment, `${prefix}_PROVIDER`, role),
      modelId: envRequired(environment, `${prefix}_MODEL`, role),
      monthlyBudgetUsd: envRequired(environment, `${prefix}_MONTHLY_BUDGET_USD`, role),
      maxInputTokens: envLimit(environment, `${prefix}_MAX_INPUT_TOKENS`, 4_096, role),
      maxOutputTokens: envLimit(environment, `${prefix}_MAX_OUTPUT_TOKENS`, 1_024, role),
    };
    return [role, config] as const;
  });
  const configs = Object.fromEntries(entries) as unknown as ModelRoleConfigs;
  validateRoleConfigs(configs, true);
  return configs;
}

async function recordRejectedRun(
  database: EventDatabase,
  input: {
    readonly runId: string;
    readonly role: ModelRole;
    readonly config: ModelRoleConfig;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly promptVersion: string;
    readonly policyVersion: string;
    readonly inputTokens: number;
    readonly reservedCostMicrousd: bigint;
    readonly status: "BUDGET_REJECTED" | "TOKEN_REJECTED";
    readonly errorCode: string;
  },
): Promise<void> {
  await database.query(
    `insert into model_runs
      (id, role, provider, model, prompt_version, policy_version,
       correlation_id, causation_id, input_tokens, max_input_tokens,
       max_output_tokens, estimated_cost_microusd, reserved_cost_microusd,
       completion_status, error_code, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,clock_timestamp())`,
    [
      input.runId,
      input.role,
      input.config.providerId,
      input.config.modelId,
      input.promptVersion,
      input.policyVersion,
      input.correlationId,
      input.causationId ?? null,
      input.inputTokens,
      input.config.maxInputTokens,
      input.config.maxOutputTokens,
      input.reservedCostMicrousd.toString(),
      input.status,
      input.errorCode,
    ],
  );
}

export function createModelGateway(
  database: EventDatabase,
  providerOrProviders: ModelProviderAdapter | readonly ModelProviderAdapter[],
  options: ModelGatewayOptions = {},
): ModelGateway {
  const providerList = Array.isArray(providerOrProviders)
    ? providerOrProviders
    : [providerOrProviders];
  const providers = new Map(
    providerList.map((provider) => [provider.providerId, provider] as const),
  );
  const firstProvider = providerList[0];
  if (!firstProvider) throw new Error("MODEL_PROVIDER_REQUIRED");
  const production = process.env.NODE_ENV === "production";
  const clock = production ? () => new Date() : (options.clock ?? (() => new Date()));
  const selectedRoleConfigs =
    options.roleConfigs ??
    (production
      ? loadProductionModelRoleConfigs(process.env)
      : defaultRoleConfigs(firstProvider, options));
  const roleConfigs = snapshotRoleConfigs(selectedRoleConfigs);
  validateRoleConfigs(roleConfigs, production);

  async function prepare(request: ModelGenerationRequest): Promise<PreparedRun> {
    const role = request.role;
    const input = request.input;
    const signal = request.signal;
    const configuredRole = roleConfigs[role];
    if (!configuredRole) throw new Error("MODEL_ROLE_INVALID");
    const config = Object.freeze({ ...configuredRole });
    const provider = providers.get(config.providerId);
    if (!provider) throw new Error(`MODEL_PROVIDER_NOT_REGISTERED:${config.providerId}`);
    const promptVersion = requiredVersion(
      request.promptVersion,
      "MODEL_PROMPT_VERSION_REQUIRED",
    );
    const policyVersion = requiredVersion(
      request.policyVersion,
      "MODEL_POLICY_VERSION_REQUIRED",
    );
    const correlationId = request.correlationId
      ? assertUuid(request.correlationId, "MODEL_CORRELATION_ID_INVALID")
      : randomUUID();
    const causationId = request.causationId
      ? assertUuid(request.causationId, "MODEL_CAUSATION_ID_INVALID")
      : undefined;
    const runId = randomUUID();
    const inputTokens = callProviderCallback(() =>
      provider.countInputTokens(input),
    );
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      inputTokens > POSTGRES_INT_MAX
    ) {
      throw new Error("MODEL_PROVIDER_TOKEN_COUNT_INVALID");
    }
    if (inputTokens > config.maxInputTokens) {
      await recordRejectedRun(database, {
        runId,
        role,
        config,
        correlationId,
        causationId,
        promptVersion,
        policyVersion,
        inputTokens,
        reservedCostMicrousd: 0n,
        status: "TOKEN_REJECTED",
        errorCode: "MODEL_INPUT_TOKEN_LIMIT",
      });
      throw new Error("MODEL_INPUT_TOKEN_LIMIT");
    }
    const reservedCostMicrousd = callProviderCallback(() =>
      provider.estimateMaximumCostMicrousd(
        inputTokens,
        config.maxOutputTokens,
        config.modelId,
      ),
    );
    if (
      typeof reservedCostMicrousd !== "bigint" ||
      reservedCostMicrousd < 0n ||
      reservedCostMicrousd > POSTGRES_BIGINT_MAX
    ) {
      throw new Error("MODEL_COST_ESTIMATE_RANGE_INVALID");
    }
    const monthlyBudgetMicrousd = dollarsToMicrousd(config.monthlyBudgetUsd);
    const month = budgetMonth(clock());

    const reserved = await database.transaction(async (transaction) => {
      await transaction.query(
        `insert into model_budget_usage (role, budget_month)
         values ($1,$2) on conflict do nothing`,
        [role, month],
      );
      const usage = await transaction.one<{ committed_cost_microusd: string }>(
        `select committed_cost_microusd from model_budget_usage
         where role=$1 and budget_month=$2 for update`,
        [role, month],
      );
      const next = BigInt(usage.committed_cost_microusd) + reservedCostMicrousd;
      if (next > monthlyBudgetMicrousd) {
        await recordRejectedRun(transaction, {
          runId,
          role,
          config,
          correlationId,
          causationId,
          promptVersion,
          policyVersion,
          inputTokens,
          reservedCostMicrousd,
          status: "BUDGET_REJECTED",
          errorCode: "MODEL_BUDGET_EXHAUSTED",
        });
        return false;
      }
      await transaction.query(
        `update model_budget_usage
         set committed_cost_microusd=$3, updated_at=clock_timestamp()
         where role=$1 and budget_month=$2`,
        [role, month, next.toString()],
      );
      await transaction.query(
        `insert into model_runs
          (id, role, provider, model, prompt_version, policy_version,
           correlation_id, causation_id, input_tokens, max_input_tokens,
           max_output_tokens, reserved_cost_microusd, completion_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'IN_PROGRESS')`,
        [
          runId,
          role,
          config.providerId,
          config.modelId,
          promptVersion,
          policyVersion,
          correlationId,
          causationId ?? null,
          inputTokens,
          config.maxInputTokens,
          config.maxOutputTokens,
          reservedCostMicrousd.toString(),
        ],
      );
      return true;
    });
    if (!reserved) throw new Error("MODEL_BUDGET_EXHAUSTED");

    return {
      runId,
      role,
      input,
      signal,
      correlationId,
      causationId,
      promptVersion,
      policyVersion,
      startedAtMs: clockMilliseconds(clock),
      inputTokens,
      reservedCostMicrousd,
      budgetMonth: month,
      config,
      provider,
    };
  }

  /**
   * Fail-closed accounting policy: a valid provider-reported cost is treated
   * as already incurred, including overruns. If cost cannot be trusted or
   * represented in PostgreSQL, the full reservation remains charged. The
   * role-month counter saturates at BIGINT_MAX so every later call still
   * rejects without losing the provider's raw numeric evidence on the run.
   */
  function assessUsage(
    prepared: PreparedRun,
    usage: ModelProviderUsage | undefined,
    unavailable = false,
    expectedOutputTokens?: number,
  ): UsageAssessment {
    if (!usage) {
      return {
        accountedCostMicrousd: prepared.reservedCostMicrousd,
        violationCode: unavailable ? "MODEL_PROVIDER_USAGE_UNAVAILABLE" : undefined,
      };
    }
    const inputValid =
      Number.isSafeInteger(usage.inputTokens) &&
      usage.inputTokens >= 0 &&
      usage.inputTokens <= POSTGRES_INT_MAX &&
      usage.inputTokens === prepared.inputTokens;
    const outputValid =
      Number.isSafeInteger(usage.outputTokens) &&
      usage.outputTokens >= 0 &&
      usage.outputTokens <= POSTGRES_INT_MAX &&
      (expectedOutputTokens === undefined || usage.outputTokens === expectedOutputTokens);
    const costTypeValid =
      typeof usage.estimatedCostMicrousd === "bigint" &&
      usage.estimatedCostMicrousd >= 0n;
    const costRangeValid =
      costTypeValid && usage.estimatedCostMicrousd <= POSTGRES_BIGINT_MAX;

    let violationCode: string | undefined;
    if (!inputValid || !outputValid || !costTypeValid) {
      violationCode = "MODEL_PROVIDER_USAGE_INVALID";
    } else if (!costRangeValid) {
      violationCode = "MODEL_PROVIDER_COST_RANGE_INVALID";
    } else if (usage.outputTokens > prepared.config.maxOutputTokens) {
      violationCode = "MODEL_OUTPUT_TOKEN_LIMIT";
    } else if (usage.estimatedCostMicrousd > prepared.reservedCostMicrousd) {
      violationCode = "MODEL_PROVIDER_COST_EXCEEDS_RESERVATION";
    }

    const representableCostMicrousd = costTypeValid
      ? usage.estimatedCostMicrousd > POSTGRES_BIGINT_MAX
        ? POSTGRES_BIGINT_MAX
        : usage.estimatedCostMicrousd
      : undefined;
    const accountedCostMicrousd = violationCode
      ? representableCostMicrousd !== undefined &&
        representableCostMicrousd > prepared.reservedCostMicrousd
        ? representableCostMicrousd
        : prepared.reservedCostMicrousd
      : representableCostMicrousd!;

    return {
      usage,
      accountedCostMicrousd,
      violationCode,
    };
  }

  function assessPartialUsage(
    prepared: PreparedRun,
    output: string,
    expectedOutputTokens: number,
  ): UsageAssessment {
    let rawUsage: unknown;
    try {
      rawUsage = prepared.provider.estimateUsage(
        prepared.input,
        output,
        prepared.config.modelId,
      );
    } catch {
      return assessUsage(prepared, undefined, true);
    }
    let usage: ModelProviderUsage;
    try {
      usage = snapshotProviderUsage(rawUsage, "MODEL_PROVIDER_USAGE_INVALID");
    } catch {
      return {
        accountedCostMicrousd: prepared.reservedCostMicrousd,
        violationCode: "MODEL_PROVIDER_USAGE_INVALID",
      };
    }
    return assessUsage(
      prepared,
      usage,
      false,
      expectedOutputTokens,
    );
  }

  async function finalize(
    prepared: PreparedRun,
    input: FinalizeRunInput,
  ): Promise<void> {
    const reportedUsage = input.usage;
    const outputTokens =
      reportedUsage &&
      Number.isSafeInteger(reportedUsage.outputTokens) &&
      reportedUsage.outputTokens >= 0
        ? Math.min(
            reportedUsage.outputTokens,
            prepared.config.maxOutputTokens,
            POSTGRES_INT_MAX,
          )
        : 0;
    const actualCost = input.accountedCostMicrousd;
    if (actualCost < 0n || actualCost > POSTGRES_BIGINT_MAX) {
      throw new Error("MODEL_BUDGET_ACCOUNTING_RANGE_INVALID");
    }
    const providerReportedInputTokens =
      reportedUsage &&
      Number.isSafeInteger(reportedUsage.inputTokens) &&
      reportedUsage.inputTokens >= 0
        ? reportedUsage.inputTokens.toString()
        : null;
    const providerReportedOutputTokens =
      reportedUsage &&
      Number.isSafeInteger(reportedUsage.outputTokens) &&
      reportedUsage.outputTokens >= 0
        ? reportedUsage.outputTokens.toString()
        : null;
    const providerReportedCostMicrousd =
      reportedUsage &&
      typeof reportedUsage.estimatedCostMicrousd === "bigint" &&
      reportedUsage.estimatedCostMicrousd >= 0n
        ? (reportedUsage.estimatedCostMicrousd > POSTGRES_NUMERIC_EVIDENCE_MAX
            ? POSTGRES_NUMERIC_EVIDENCE_MAX
            : reportedUsage.estimatedCostMicrousd
          ).toString()
        : null;
    const latencyMs = postgresLatency(clockMilliseconds(clock) - prepared.startedAtMs);
    const didFinalize = await database.transaction(async (transaction) => {
      const run = await transaction.one<{ completion_status: string }>(
        `select completion_status from model_runs where id=$1 for update`,
        [prepared.runId],
      );
      if (run.completion_status !== "IN_PROGRESS") return false;
      const row = await transaction.one<{ committed_cost_microusd: string }>(
        `select committed_cost_microusd from model_budget_usage
         where role=$1 and budget_month=$2 for update`,
        [prepared.role, prepared.budgetMonth],
      );
      const currentCommitted = BigInt(row.committed_cost_microusd);
      const committedBeforeRangeBound =
        currentCommitted === POSTGRES_BIGINT_MAX
          ? POSTGRES_BIGINT_MAX
          : currentCommitted - prepared.reservedCostMicrousd + actualCost;
      if (committedBeforeRangeBound < 0n) {
        throw new Error("MODEL_BUDGET_ACCOUNTING_INVALID");
      }
      const committed =
        committedBeforeRangeBound > POSTGRES_BIGINT_MAX
          ? POSTGRES_BIGINT_MAX
          : committedBeforeRangeBound;
      await transaction.query(
        `update model_budget_usage
         set committed_cost_microusd=$3, updated_at=clock_timestamp()
         where role=$1 and budget_month=$2`,
        [prepared.role, prepared.budgetMonth, committed.toString()],
      );
      await transaction.query(
        `update model_runs
         set output_tokens=$2, latency_ms=$3, estimated_cost_microusd=$4,
             completion_status=$5, error_code=$6, streamed=true,
             completed_at=clock_timestamp(),
             provider_reported_input_tokens=$7,
             provider_reported_output_tokens=$8,
             provider_reported_cost_microusd=$9,
             budget_accounted_cost_microusd=$4
         where id=$1 and completion_status='IN_PROGRESS'`,
        [
          prepared.runId,
          outputTokens,
          latencyMs,
          actualCost.toString(),
          input.status,
          input.errorCode,
          providerReportedInputTokens,
          providerReportedOutputTokens,
          providerReportedCostMicrousd,
        ],
      );
      return true;
    });
    if (!didFinalize) return;
    const labels = { role: prepared.role, status: input.status } as const;
    const reportedCost = providerReportedCostMicrousd === null
      ? actualCost : BigInt(providerReportedCostMicrousd);
    const divergence = reportedCost >= actualCost
      ? reportedCost - actualCost : actualCost - reportedCost;
    operationalMetrics.observe("model.latency_ms", latencyMs, labels);
    operationalMetrics.observe("model.cost_microusd", Number(actualCost), labels);
    operationalMetrics.observe("model.divergence_microusd", Number(divergence), labels);
  }

  async function* stream(
    request: ModelGenerationRequest,
  ): AsyncIterable<ModelGatewayEvent> {
    const prepared = await prepare(request);
    let finalized = false;
    let output = "";
    let streamedOutputTokens = 0;
    let lastReportedUsage: ModelProviderUsage | undefined;
    const maximumOutputCharacters = Math.min(
      prepared.config.maxOutputTokens * MAX_CHARACTERS_PER_OUTPUT_TOKEN,
      MAX_OUTPUT_CHARACTERS,
    );
    try {
      yield {
        type: "STARTED",
        runId: prepared.runId,
        correlationId: prepared.correlationId,
      };
      if (prepared.signal?.aborted) throw modelAbortError();
      const providerIterator = prepared.provider.stream({
        role: prepared.role,
        modelId: prepared.config.modelId,
        input: prepared.input,
        maxOutputTokens: prepared.config.maxOutputTokens,
        signal: prepared.signal,
      })[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await nextProviderEvent(providerIterator, prepared.signal);
          if (next.done) throw modelExecutionError("MODEL_PROVIDER_INCOMPLETE");
          const event = normalizeProviderEvent(next.value);
          if (prepared.signal?.aborted) throw modelAbortError();
          if (event.type === "DELTA") {
            if (
              !Number.isSafeInteger(event.outputTokens) ||
              event.outputTokens < 0 ||
              event.outputTokens > POSTGRES_INT_MAX ||
              (event.text.length > 0 && event.outputTokens === 0)
            ) {
              throw modelExecutionError("MODEL_PROVIDER_USAGE_INVALID");
            }
            const nextOutputTokens = streamedOutputTokens + event.outputTokens;
            const nextOutputCharacters = output.length + event.text.length;
            if (
              nextOutputTokens > prepared.config.maxOutputTokens ||
              nextOutputCharacters > maximumOutputCharacters
            ) {
              throw modelExecutionError("MODEL_OUTPUT_TOKEN_LIMIT_EXCEEDED");
            }
            streamedOutputTokens = nextOutputTokens;
            output += event.text;
            yield { type: "DELTA", text: event.text };
            continue;
          }
          lastReportedUsage = event.usage;
          const assessment = assessUsage(
            prepared,
            event.usage,
            false,
            streamedOutputTokens,
          );
          if (assessment.violationCode) {
            throw modelExecutionError(assessment.violationCode);
          }
          if (prepared.signal?.aborted) throw modelAbortError();
          await finalize(prepared, {
            status: "COMPLETED",
            errorCode: null,
            usage: event.usage,
            accountedCostMicrousd: assessment.accountedCostMicrousd,
          });
          finalized = true;
          const result: ModelGenerationResult = {
            runId: prepared.runId,
            correlationId: prepared.correlationId,
            output,
            usage: event.usage,
          };
          yield { type: "COMPLETED", result };
          return;
        }
      } finally {
        closeProviderIteratorBestEffort(providerIterator);
      }
    } catch (error) {
      const assessment = lastReportedUsage
        ? assessUsage(prepared, lastReportedUsage, false, streamedOutputTokens)
        : assessPartialUsage(prepared, output, streamedOutputTokens);
      const aborted =
        prepared.signal?.aborted === true || isProviderAbortError(error);
      const errorCode = aborted
        ? "MODEL_PROVIDER_ABORTED"
        : (assessment.violationCode ?? safeErrorCode(error));
      const failClosedAccounting =
        errorCode === "MODEL_OUTPUT_TOKEN_LIMIT_EXCEEDED" ||
        errorCode === "MODEL_PROVIDER_USAGE_INVALID" ||
        errorCode === "MODEL_PROVIDER_EVENT_INVALID";
      const accountedCostMicrousd = failClosedAccounting
        ? assessment.accountedCostMicrousd > prepared.reservedCostMicrousd
          ? assessment.accountedCostMicrousd
          : prepared.reservedCostMicrousd
        : assessment.accountedCostMicrousd;
      await finalize(prepared, {
        status: aborted ? "ABORTED" : "FAILED",
        errorCode,
        usage: assessment.usage,
        accountedCostMicrousd,
      });
      finalized = true;
      if (aborted) {
        throw modelAbortError();
      }
      throw modelExecutionError(errorCode);
    } finally {
      if (!finalized) {
        const assessment = assessPartialUsage(
          prepared,
          output,
          streamedOutputTokens,
        );
        const violation = assessment.violationCode;
        await finalize(prepared, {
          status: violation ? "FAILED" : "ABORTED",
          errorCode: violation ?? "MODEL_STREAM_ABORTED",
          usage: assessment.usage,
          accountedCostMicrousd: assessment.accountedCostMicrousd,
        });
      }
    }
  }

  async function generate(
    request: ModelGenerationRequest,
  ): Promise<ModelGenerationResult> {
    for await (const event of stream(request)) {
      if (event.type === "COMPLETED") return event.result;
    }
    throw new Error("MODEL_GENERATION_INCOMPLETE");
  }

  return { generate, stream };
}
