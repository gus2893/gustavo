import type {
  ModelProviderAdapter,
  ModelProviderCall,
  ModelProviderEvent,
  ModelProviderRequest,
  ModelProviderSafeErrorCode,
} from "./types";
import { ModelProviderError } from "./types";

export interface FakeModelProviderOptions {
  readonly response?: string;
  readonly chunks?: readonly string[];
  readonly failWith?: ModelProviderSafeErrorCode;
  readonly delayMs?: number;
  readonly inputCostMicrousdPerToken?: bigint;
  readonly outputCostMicrousdPerToken?: bigint;
}

export interface FakeModelProvider extends ModelProviderAdapter {
  readonly calls: readonly ModelProviderCall[];
}

function tokenCount(value: string): number {
  const trimmed = value.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("MODEL_PROVIDER_ABORTED"));
      },
      { once: true },
    );
  });
}

export function fakeModelProvider(
  responseOrOptions: string | FakeModelProviderOptions,
): FakeModelProvider {
  const options =
    typeof responseOrOptions === "string"
      ? { response: responseOrOptions }
      : responseOrOptions;
  const chunks = options.chunks ?? [options.response ?? "fixed response"];
  const inputRate = options.inputCostMicrousdPerToken ?? 1n;
  const outputRate = options.outputCostMicrousdPerToken ?? 1n;
  const calls: ModelProviderCall[] = [];

  return {
    providerId: "fake",
    calls,
    countInputTokens: tokenCount,
    estimateMaximumCostMicrousd(inputTokens, maxOutputTokens) {
      return BigInt(inputTokens) * inputRate + BigInt(maxOutputTokens) * outputRate;
    },
    estimateUsage(input, output) {
      const inputTokens = tokenCount(input);
      const outputTokens = tokenCount(output);
      return {
        inputTokens,
        outputTokens,
        estimatedCostMicrousd:
          BigInt(inputTokens) * inputRate + BigInt(outputTokens) * outputRate,
      };
    },
    async *stream(request: ModelProviderRequest): AsyncIterable<ModelProviderEvent> {
      calls.push({
        role: request.role,
        modelId: request.modelId,
        maxOutputTokens: request.maxOutputTokens,
      });
      if (options.failWith) throw new ModelProviderError(options.failWith);
      const output = chunks.join("");
      for (const chunk of chunks) {
        if (request.signal?.aborted) throw new Error("MODEL_PROVIDER_ABORTED");
        await delay(options.delayMs ?? 0, request.signal);
        yield { type: "DELTA", text: chunk, outputTokens: tokenCount(chunk) };
      }
      yield {
        type: "COMPLETED",
        usage: this.estimateUsage(request.input, output, request.modelId),
      };
    },
  };
}
