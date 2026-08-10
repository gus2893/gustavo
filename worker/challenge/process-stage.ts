import { types as utilTypes } from "node:util";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  createStageLifecycleContext,
  evaluateStoredStage,
  type StoredStageEvaluation,
} from "../../lib/server/challenge/stages";

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const boundaryWorkerContexts = new WeakSet<object>();

export interface StageBoundaryWorkerContext {
  readonly db: EventDatabase;
  readonly workerId: string;
}

export interface ProcessUtcStageBoundaryInput {
  readonly evaluatedAt: string;
}

export function createStageBoundaryWorkerContext(
  db: EventDatabase,
  workerId: string,
): StageBoundaryWorkerContext {
  if (!db || typeof db !== "object" || typeof db.transaction !== "function"
    || typeof workerId !== "string" || !WORKER_ID_PATTERN.test(workerId)) {
    throw new Error("CHALLENGE_STAGE_BOUNDARY_CONTEXT_INVALID");
  }
  const context = Object.freeze({ db, workerId });
  boundaryWorkerContexts.add(context);
  return context;
}

function captureEvaluatedAt(input: ProcessUtcStageBoundaryInput): string {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || utilTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) {
      throw new Error("CHALLENGE_STAGE_BOUNDARY_INPUT_INVALID");
    }
    const keys = Reflect.ownKeys(input);
    const descriptor = Object.getOwnPropertyDescriptor(input, "evaluatedAt");
    if (keys.length !== 1 || keys[0] !== "evaluatedAt" || !descriptor
      || !descriptor.enumerable || !("value" in descriptor)
      || typeof descriptor.value !== "string"
      || !TIMESTAMP_PATTERN.test(descriptor.value)) {
      throw new Error("CHALLENGE_STAGE_BOUNDARY_INPUT_INVALID");
    }
    const parsed = new Date(descriptor.value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== descriptor.value) {
      throw new Error("CHALLENGE_STAGE_BOUNDARY_INPUT_INVALID");
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof Error
      && error.message === "CHALLENGE_STAGE_BOUNDARY_INPUT_INVALID") throw error;
    throw new Error("CHALLENGE_STAGE_BOUNDARY_INPUT_INVALID");
  }
}

/**
 * Production worker entry for the injected UTC reset boundary. The scheduler
 * owns when to invoke it; PostgreSQL and the stage evaluator own idempotency.
 */
export async function processUtcStageBoundary(
  context: StageBoundaryWorkerContext,
  input: ProcessUtcStageBoundaryInput,
): Promise<readonly Readonly<StoredStageEvaluation>[]> {
  if (!context || typeof context !== "object" || !boundaryWorkerContexts.has(context)) {
    throw new Error("CHALLENGE_STAGE_BOUNDARY_CONTEXT_INVALID");
  }
  const evaluatedAt = captureEvaluatedAt(input);
  const stages = await context.db.query<{ readonly stage_id: string } & Record<string, unknown>>(
    `select stage.id::text as stage_id
       from challenge_stages stage
      where not exists (
        select 1 from challenge_ledger_events terminal
         where terminal.stage_id=stage.id
           and terminal.type in ('stage.passed','stage.failed')
      )
        and exists (
          select 1 from challenge_ledger_events started
           where started.stage_id=stage.id and started.type='stage.started'
        )
      order by stage.challenge_portfolio_id,stage.ordinal`,
  );
  const results: Readonly<StoredStageEvaluation>[] = [];
  for (const stage of stages) {
    results.push(await context.db.transaction(async (transaction) => {
      await transaction.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`challenge-stage:${stage.stage_id}`],
      );
      await transaction.one(
        "select id from challenge_stages where id=$1 for update",
        [stage.stage_id],
      );
      const latest = await transaction.one<{ occurred_at: Date | null }>(
        "select max(occurred_at) as occurred_at from challenge_ledger_events where stage_id=$1",
        [stage.stage_id],
      );
      const effectiveEvaluationAt = latest.occurred_at
        && latest.occurred_at.getTime() > Date.parse(evaluatedAt)
        ? latest.occurred_at.toISOString()
        : evaluatedAt;
      return evaluateStoredStage(createStageLifecycleContext(transaction), {
        stageId: stage.stage_id,
        evaluatedAt: effectiveEvaluationAt,
      });
    }));
  }
  return Object.freeze(results);
}
