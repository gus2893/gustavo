import { unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "redis";
import {
  assertProductionFixturesDisabled,
  resolveProductionWorkerOwner,
} from "../instrumentation";
import {
  createProductionCacheRuntime,
  prewarmPostgresCache,
  startPostgresCacheWorker,
} from "../lib/server/cache/runtime";
import { startForgetPropagationWorker } from "../lib/server/memory/forget";
import {
  startCommittedEventPublisher,
  STREAM_EVENT_CHANNEL,
} from "./stream/publish-events";

const SHUTDOWN_TIMEOUT_MS = 25_000;
const WORKER_READINESS_FILE = "/tmp/gustavo-worker-ready";

export async function clearWorkerReadiness(markerFile: string): Promise<void> {
  try {
    await unlink(markerFile);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function markWorkerReady(markerFile: string): Promise<void> {
  await writeFile(markerFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
}

function requireWorkerOwnership(): void {
  if (process.env.NODE_ENV !== "production") {
    throw new Error("WORKER_RUNTIME_PRODUCTION_REQUIRED");
  }
  assertProductionFixturesDisabled(process.env);
  if (resolveProductionWorkerOwner(process.env) !== "worker") {
    throw new Error("BACKGROUND_WORKER_OWNERSHIP_CONFLICT");
  }
}

async function boundedShutdown(work: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("WORKER_SHUTDOWN_TIMEOUT")),
          SHUTDOWN_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runProductionWorker(): Promise<void> {
  await clearWorkerReadiness(WORKER_READINESS_FILE);
  requireWorkerOwnership();
  const runtime = await createProductionCacheRuntime();
  const streamClient = createClient({ url: process.env.VALKEY_URL });
  streamClient.on("error", () => undefined);
  let cacheWorker: ReturnType<typeof startPostgresCacheWorker> | undefined;
  let privacyWorker: ReturnType<typeof startForgetPropagationWorker> | undefined;
  let streamWorker: ReturnType<typeof startCommittedEventPublisher> | undefined;

  try {
    await streamClient.connect();
    await prewarmPostgresCache({
      db: runtime.db,
      cache: runtime.publisher,
      checkpoint: "CURRENT",
    });
    cacheWorker = startPostgresCacheWorker({
      db: runtime.db,
      cache: runtime.publisher,
      workerId: "cache-production",
      leaseMs: 30_000,
      maxAttempts: 8,
      pollIntervalMs: 250,
    });
    privacyWorker = startForgetPropagationWorker({
      db: runtime.db,
      cache: runtime,
      workerId: "privacy-forget-production",
      leaseMilliseconds: 30_000,
      maximumSteps: 8,
      pollIntervalMs: 250,
    });
    streamWorker = startCommittedEventPublisher({
      db: runtime.db,
      workerId: process.env.GUSTAVO_STREAM_WORKER_ID ?? `stream:${process.pid}`,
      leaseMs: 30_000,
      maxAttempts: 10,
      pollIntervalMs: 250,
      publishTimeoutMs: 5_000,
      publish: async (_channel, cursor) => {
        await streamClient.publish(STREAM_EVENT_CHANNEL, cursor);
      },
    });
    await markWorkerReady(WORKER_READINESS_FILE);

    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await boundedShutdown((async () => {
      try {
        await clearWorkerReadiness(WORKER_READINESS_FILE);
      } finally {
        try {
          await Promise.all([
            streamWorker?.stop(),
            privacyWorker?.stop(),
            cacheWorker?.stop(),
          ]);
        } finally {
          try {
            if (streamClient.isOpen) streamClient.destroy();
          } finally {
            await runtime.close();
          }
        }
      }
    })());
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void runProductionWorker().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "WORKER_RUNTIME_FAILED"}\n`);
    process.exitCode = 1;
  });
}
