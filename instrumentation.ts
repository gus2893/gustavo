let startup: Promise<void> | undefined;

export type ProductionWorkerOwner = "web" | "worker";

export function resolveProductionWorkerOwner(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionWorkerOwner {
  const owner = environment.GUSTAVO_BACKGROUND_WORKER_OWNER;
  if (!owner) throw new Error("GUSTAVO_BACKGROUND_WORKER_OWNER_REQUIRED");
  if (owner !== "web" && owner !== "worker") {
    throw new Error("GUSTAVO_BACKGROUND_WORKER_OWNER_INVALID");
  }
  return owner;
}

export function assertProductionFixturesDisabled(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const enabled = environment.GUSTAVO_TEST_FIXTURES_ENABLED;
  if (enabled !== undefined && enabled !== "false") {
    throw new Error("PRODUCTION_TEST_FIXTURES_FORBIDDEN");
  }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  assertProductionFixturesDisabled(process.env);
  if (resolveProductionWorkerOwner(process.env) === "worker") return;
  startup ??= (async () => {
    const cacheRuntime = await import("./lib/server/cache/runtime");
    const runtime = await cacheRuntime.createProductionCacheRuntime();
    try {
      await cacheRuntime.prewarmPostgresCache({
        db: runtime.db,
        cache: runtime.publisher,
        checkpoint: "CURRENT",
      });
      const worker = cacheRuntime.startPostgresCacheWorker({
        db: runtime.db,
        cache: runtime.publisher,
        workerId: "cache-production",
        leaseMs: 30_000,
        maxAttempts: 8,
        pollIntervalMs: 250,
      });
      void worker.done;
      const privacyRuntime = await import("./lib/server/memory/forget");
      const privacyWorker = privacyRuntime.startForgetPropagationWorker({
        db: runtime.db,
        cache: runtime,
        workerId: "privacy-forget-production",
        leaseMilliseconds: 30_000,
        maximumSteps: 8,
        pollIntervalMs: 250,
      });
      void privacyWorker.done;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  })();
  await startup;
}
