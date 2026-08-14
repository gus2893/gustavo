export const MODEL_ROLES = ["MAIN", "NODE", "EVALUATOR"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelRoleConfig {
  readonly providerId: string;
  readonly modelId: string;
  readonly monthlyBudgetUsd: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export type ModelRoleConfigs = Readonly<Record<ModelRole, ModelRoleConfig>>;

export interface ModelGenerationRequest {
  readonly role: ModelRole;
  readonly promptVersion: string;
  readonly policyVersion: string;
  readonly input: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly signal?: AbortSignal;
}

export interface ModelProviderRequest {
  readonly role: ModelRole;
  readonly modelId: string;
  readonly input: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export interface ModelProviderCall {
  readonly role: ModelRole;
  readonly modelId: string;
  readonly maxOutputTokens: number;
}

export interface ModelProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicrousd: bigint;
  readonly providerMetering?: ModelProviderMetering;
}

export type ModelProviderMetering =
  | {
      readonly status: "REPORTED";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly status: "UNKNOWN" };

export const MODEL_PROVIDER_SAFE_ERROR_CODES = [
  "UPSTREAM_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_AUTHENTICATION_FAILED",
  "PROVIDER_REQUEST_INVALID",
] as const;

export type ModelProviderSafeErrorCode =
  (typeof MODEL_PROVIDER_SAFE_ERROR_CODES)[number];

/** Adapter-owned error whose code is explicitly safe for gateway callers. */
export class ModelProviderError extends Error {
  readonly code: ModelProviderSafeErrorCode;

  constructor(code: ModelProviderSafeErrorCode) {
    super(code);
    this.name = "ModelProviderError";
    this.code = code;
  }
}

export type ModelProviderEvent =
  | {
      readonly type: "DELTA";
      readonly text: string;
      /** Deterministic token increment produced by the provider adapter. */
      readonly outputTokens: number;
    }
  | { readonly type: "COMPLETED"; readonly usage: ModelProviderUsage };

/**
 * Provider SDK values are converted to this contract inside adapters. Gateway
 * orchestration never imports a provider SDK or provider-specific response.
 */
export interface ModelProviderAdapter {
  readonly providerId: string;
  countInputTokens(input: string): number;
  estimateMaximumCostMicrousd(
    inputTokens: number,
    maxOutputTokens: number,
    modelId: string,
  ): bigint;
  estimateUsage(
    input: string,
    output: string,
    modelId: string,
  ): ModelProviderUsage;
  stream(request: ModelProviderRequest): AsyncIterable<ModelProviderEvent>;
}

export type ModelGatewayEvent =
  | { readonly type: "STARTED"; readonly runId: string; readonly correlationId: string }
  | { readonly type: "DELTA"; readonly text: string }
  | { readonly type: "COMPLETED"; readonly result: ModelGenerationResult };

export interface ModelGenerationResult {
  readonly runId: string;
  readonly correlationId: string;
  readonly output: string;
  readonly usage: ModelProviderUsage;
}

export interface ModelGateway {
  generate(request: ModelGenerationRequest): Promise<ModelGenerationResult>;
  stream(request: ModelGenerationRequest): AsyncIterable<ModelGatewayEvent>;
}

export interface ModelGatewayOptions {
  readonly roleConfigs?: ModelRoleConfigs;
  /** Test/runtime clock; production always uses the trusted system clock. */
  readonly clock?: () => Date;
  /** Backward-compatible all-role limits for the initial task contract. */
  readonly monthlyBudgetUsd?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}
