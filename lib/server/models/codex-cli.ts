import type {
  ModelProviderAdapter,
  ModelProviderEvent,
  ModelProviderRequest,
  ModelProviderUsage,
  ModelRole,
} from "./types";
import { MODEL_ROLES, ModelProviderError } from "./types";

const CONFIGURED_MODEL = "gpt-5.6-sol" as const;
const MAX_REPORTED_TOKENS = 1_000_000_000;
const ROLE_TIMEOUTS = Object.freeze({
  NODE: 90_000,
  EVALUATOR: 180_000,
  MAIN: 300_000,
} satisfies Readonly<Record<ModelRole, number>>);

interface CodexCliRunRequest {
  readonly role: ModelRole;
  readonly prompt: string;
  readonly model: typeof CONFIGURED_MODEL;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface CodexCliRunResult {
  readonly response: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface CodexCliProviderOptions {
  readonly model: typeof CONFIGURED_MODEL;
  readonly run: (request: CodexCliRunRequest) => Promise<CodexCliRunResult>;
}

function tokenCount(value: string): number {
  if (value.length === 0) return 0;
  const bytes = Buffer.byteLength(value, "utf8");
  return Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER;
}

function safeRunnerCode(error: unknown): string | undefined {
  try {
    if (
      (typeof error !== "object" && typeof error !== "function")
      || error === null
    ) return undefined;
    const message = Reflect.get(error, "message");
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

function mapRunnerError(error: unknown): Error {
  const code = safeRunnerCode(error);
  if (code === "CODEX_ABORTED") {
    const aborted = new Error("MODEL_PROVIDER_ABORTED");
    aborted.name = "AbortError";
    return aborted;
  }
  if (code === "CODEX_QUOTA_EXHAUSTED") {
    return new ModelProviderError("PROVIDER_RATE_LIMITED");
  }
  if (code === "CODEX_AUTH_UNAVAILABLE") {
    return new ModelProviderError("PROVIDER_AUTHENTICATION_FAILED");
  }
  return new ModelProviderError("UPSTREAM_UNAVAILABLE");
}

function snapshotReportedUsage(
  value: CodexCliRunResult["usage"],
): ModelProviderUsage["providerMetering"] {
  if (value === undefined) return Object.freeze({ status: "UNKNOWN" });
  let inputTokens: unknown;
  let outputTokens: unknown;
  let keys: string[];
  try {
    keys = Object.keys(value).sort();
    inputTokens = Reflect.get(value, "inputTokens");
    outputTokens = Reflect.get(value, "outputTokens");
  } catch {
    throw new ModelProviderError("UPSTREAM_UNAVAILABLE");
  }
  if (
    keys.length !== 2
    || keys[0] !== "inputTokens"
    || keys[1] !== "outputTokens"
    || typeof inputTokens !== "number"
    || !Number.isSafeInteger(inputTokens)
    || inputTokens < 0
    || inputTokens > MAX_REPORTED_TOKENS
    || typeof outputTokens !== "number"
    || !Number.isSafeInteger(outputTokens)
    || outputTokens < 0
    || outputTokens > MAX_REPORTED_TOKENS
  ) {
    throw new ModelProviderError("UPSTREAM_UNAVAILABLE");
  }
  return Object.freeze({ status: "REPORTED", inputTokens, outputTokens });
}

function usage(
  input: string,
  output: string,
  providerMetering: ModelProviderUsage["providerMetering"],
): ModelProviderUsage {
  return Object.freeze({
    inputTokens: tokenCount(input),
    outputTokens: tokenCount(output),
    estimatedCostMicrousd: 0n,
    providerMetering,
  });
}

export function createCodexCliProvider(
  options: CodexCliProviderOptions,
): ModelProviderAdapter {
  let run: CodexCliProviderOptions["run"];
  try {
    run = Reflect.get(options, "run") as CodexCliProviderOptions["run"];
  } catch {
    throw new ModelProviderError("PROVIDER_REQUEST_INVALID");
  }
  if (options.model !== CONFIGURED_MODEL || typeof run !== "function") {
    throw new ModelProviderError("PROVIDER_REQUEST_INVALID");
  }

  return Object.freeze({
    providerId: "codex-cli",
    countInputTokens: tokenCount,
    estimateMaximumCostMicrousd() {
      return 0n;
    },
    estimateUsage(input: string, output: string) {
      return usage(input, output, Object.freeze({ status: "UNKNOWN" }));
    },
    async *stream(request: ModelProviderRequest): AsyncIterable<ModelProviderEvent> {
      if (
        !MODEL_ROLES.includes(request.role)
        || request.modelId !== CONFIGURED_MODEL
        || !Number.isSafeInteger(request.maxOutputTokens)
        || request.maxOutputTokens <= 0
      ) {
        throw new ModelProviderError("PROVIDER_REQUEST_INVALID");
      }
      let result: CodexCliRunResult;
      try {
        result = await run({
          role: request.role,
          prompt: request.input,
          model: CONFIGURED_MODEL,
          timeoutMs: ROLE_TIMEOUTS[request.role],
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error) {
        throw mapRunnerError(error);
      }
      let response: unknown;
      let rawUsage: CodexCliRunResult["usage"];
      try {
        response = Reflect.get(result, "response");
        rawUsage = Reflect.get(result, "usage") as CodexCliRunResult["usage"];
      } catch {
        throw new ModelProviderError("UPSTREAM_UNAVAILABLE");
      }
      if (typeof response !== "string" || response.length === 0) {
        throw new ModelProviderError("UPSTREAM_UNAVAILABLE");
      }
      const outputTokens = tokenCount(response);
      if (outputTokens > request.maxOutputTokens) {
        throw new ModelProviderError("PROVIDER_REQUEST_INVALID");
      }
      const providerMetering = snapshotReportedUsage(rawUsage);
      yield Object.freeze({ type: "DELTA", text: response, outputTokens });
      yield Object.freeze({
        type: "COMPLETED",
        usage: usage(request.input, response, providerMetering),
      });
    },
  });
}
