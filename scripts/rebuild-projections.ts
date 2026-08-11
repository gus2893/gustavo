import {
  rebuildCriticalProjections,
  type CacheProjectionPublisher,
  type CriticalProjectionSource,
  type RebuildCriticalProjectionsResult,
} from "../lib/server/cache/store";
import {
  createProductionCacheRuntime,
  prewarmPostgresCache,
  rebuildPostgresCache,
} from "../lib/server/cache/runtime";

export interface RunProjectionRebuildInput {
  readonly cache: CacheProjectionPublisher;
  readonly source: CriticalProjectionSource;
  readonly checkpoint: string;
  readonly writeLine?: (line: string) => void;
}

/**
 * Operator command core. Runtime composition supplies the PostgreSQL adapter;
 * this module never treats a cache or an environment payload as authority.
 */
export async function runProjectionRebuild(
  input: RunProjectionRebuildInput,
): Promise<RebuildCriticalProjectionsResult> {
  if (input.source.name !== "POSTGRES") throw new Error("CACHE_REBUILD_SOURCE_INVALID");
  const manifest = await input.source.readManifest(input.checkpoint);
  const result = await rebuildCriticalProjections({
    cache: input.cache,
    source: input.source,
    checkpoint: input.checkpoint,
  });
  (input.writeLine ?? console.log)(
    `cache rebuild verified source=${result.source} checkpoint=${result.checkpoint} `
      + `records=${manifest.recordCount} highWater=${manifest.sourceHighWater}`,
  );
  return result;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "rebuild" && mode !== "prewarm") {
    throw new Error("CACHE_COMMAND_MODE_REQUIRED");
  }
  const runtime = await createProductionCacheRuntime();
  try {
    const run = mode === "rebuild" ? rebuildPostgresCache : prewarmPostgresCache;
    const result = await run({ db: runtime.db, cache: runtime.publisher, checkpoint: "CURRENT" });
    console.log(`cache ${mode} verified source=${result.source} checkpoint=${result.checkpoint}`);
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "CACHE_COMMAND_FAILED");
    process.exitCode = 1;
  });
}
import { pathToFileURL } from "node:url";
