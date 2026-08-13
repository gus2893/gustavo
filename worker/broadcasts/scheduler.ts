import { pathToFileURL } from "node:url";
import { closeDatabase, getDatabase } from "../../lib/server/db/postgres";
import {
  openDueBroadcastCycles,
  type BroadcastScheduleContext,
  type OpenedBroadcastCycle,
} from "../../lib/server/main-brain/schedules";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 60_000;

export interface BroadcastSchedulerRunContext extends BroadcastScheduleContext {
  readonly now?: () => Date;
  readonly scheduleLimit?: number;
}

export interface BroadcastSchedulerController {
  stop(): Promise<void>;
}

function pollInterval(value: number): number {
  if (!Number.isSafeInteger(value)
    || value < MIN_POLL_INTERVAL_MS
    || value > MAX_POLL_INTERVAL_MS) {
    throw new Error("BROADCAST_SCHEDULER_POLL_INTERVAL_INVALID");
  }
  return value;
}

export async function runBroadcastSchedulerOnce(
  context: BroadcastSchedulerRunContext,
): Promise<readonly OpenedBroadcastCycle[]> {
  if (!context || typeof context !== "object" || !context.db) {
    throw new Error("BROADCAST_SCHEDULER_CONTEXT_INVALID");
  }
  const now = context.now?.() ?? new Date();
  return openDueBroadcastCycles(context, now, {
    scheduleLimit: context.scheduleLimit,
  });
}

export function startBroadcastScheduler(input: {
  readonly db: BroadcastScheduleContext["db"];
  readonly now?: () => Date;
  readonly scheduleLimit?: number;
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}): BroadcastSchedulerController {
  const intervalMs = pollInterval(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  let stopping = false;
  let running = true;
  let followUpRequested = false;
  const runOnce = async (): Promise<void> => {
    try {
      await runBroadcastSchedulerOnce(input);
    } catch (error) {
      try {
        input.onError?.(error);
      } catch {
        // Error reporting cannot poison scheduling or shutdown.
      }
    }
  };
  const drain = async (): Promise<void> => {
    do {
      followUpRequested = false;
      await runOnce();
    } while (followUpRequested && !stopping);
    running = false;
  };
  let active = drain();
  const tick = (): void => {
    if (stopping) return;
    if (running) {
      followUpRequested = true;
      return;
    }
    running = true;
    active = drain();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return Object.freeze({
    async stop(): Promise<void> {
      if (stopping) return active;
      stopping = true;
      followUpRequested = false;
      clearInterval(timer);
      await active;
    },
  });
}

async function runStandaloneScheduler(): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    throw new Error("BROADCAST_SCHEDULER_PRODUCTION_REQUIRED");
  }
  const controller = startBroadcastScheduler({
    db: getDatabase(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    onError: (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "BROADCAST_SCHEDULER_FAILED"}\n`,
      );
    },
  });
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await controller.stop();
  await closeDatabase();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void runStandaloneScheduler().catch(async (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "BROADCAST_SCHEDULER_FAILED"}\n`,
    );
    await closeDatabase().catch(() => undefined);
    process.exitCode = 1;
  });
}
