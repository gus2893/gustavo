let startup: Promise<void> | undefined;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
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
    } catch (error) {
      await runtime.close();
      throw error;
    }
  })();
  await startup;
}
