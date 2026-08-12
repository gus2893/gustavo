import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "redis";
import { closeDatabase, getDatabase } from "../../lib/server/db/postgres";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  formatStreamCursor,
  STREAM_EVENT_CHANNEL,
} from "../../lib/server/stream/events";

export { STREAM_EVENT_CHANNEL } from "../../lib/server/stream/events";

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type StreamPublishResult =
  | "IDLE"
  | "COMPLETED"
  | "RETRY_SCHEDULED"
  | "FAILED"
  | "LEASE_LOST";

interface StreamDeliveryClaim extends Record<string, unknown> {
  readonly outbox_id: string;
  readonly event_id: string;
  readonly payload: unknown;
  readonly worker_id: string;
  readonly lease_token: string;
  readonly attempts: number;
  readonly stream_position: string;
}

function positiveInteger(value: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(code);
  }
  return value;
}

function exactEventPayload(payload: unknown, eventId: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.eventId === eventId;
}

async function claimDelivery(
  database: EventDatabase,
  workerId: string,
  leaseMs: number,
): Promise<StreamDeliveryClaim | undefined> {
  const leaseToken = randomUUID();
  return database.transaction(async (transaction) => {
    const state = await transaction.one<{
      readonly next_position: string;
      readonly active_outbox_id: string | null;
    }>(
      `select next_position::text,active_outbox_id::text
         from stream_publish_state where singleton=true for update`,
    );
    const candidates = state.active_outbox_id
      ? await transaction.query<{ readonly outbox_id: string; readonly stream_position: string }>(
        `select outbox_id::text,stream_position::text
           from stream_outbox_deliveries
          where outbox_id=$1
            and ((status='RETRY_SCHEDULED' and available_at<=clock_timestamp())
              or (status='CLAIMED' and lease_until<=clock_timestamp()))
          for update`,
        [state.active_outbox_id],
      )
      : await transaction.query<{ readonly outbox_id: string; readonly stream_position: null }>(
        `select delivery.outbox_id::text,delivery.stream_position::text
           from stream_outbox_deliveries delivery
           join transactional_outbox outbox on outbox.id=delivery.outbox_id
          where delivery.status='PENDING' and delivery.event_id=outbox.event_id
          order by delivery.created_at,delivery.outbox_id
          for update of delivery skip locked limit 1`,
      );
    const candidate = candidates[0];
    if (!candidate) return undefined;
    const position = candidate.stream_position ?? state.next_position;
    const stateRows = await transaction.query(
      `update stream_publish_state
          set active_outbox_id=$1,
              next_position=case when $2::boolean then next_position+1 else next_position end,
              updated_at=clock_timestamp()
        where singleton=true and (active_outbox_id is null or active_outbox_id=$1)
        returning singleton`,
      [candidate.outbox_id, candidate.stream_position === null],
    );
    if (stateRows.length !== 1) throw new Error("STREAM_PUBLISH_STATE_CONFLICT");
    const rows = await transaction.query<StreamDeliveryClaim>(
      `update stream_outbox_deliveries delivery
          set status='CLAIMED',attempts=delivery.attempts+1,
              stream_position=coalesce(delivery.stream_position,$4::bigint),
              worker_id=$1,lease_token=$2,
              lease_until=clock_timestamp()+($3::int*interval '1 millisecond'),
              error_code=null
         from transactional_outbox outbox
        where delivery.outbox_id=$5 and outbox.id=delivery.outbox_id
          and delivery.event_id=outbox.event_id
       returning delivery.outbox_id::text,delivery.event_id::text,outbox.payload,
                 delivery.worker_id,delivery.lease_token::text,delivery.attempts,
                 delivery.stream_position::text`,
      [workerId, leaseToken, leaseMs, position, candidate.outbox_id],
    );
    if (rows.length !== 1) throw new Error("STREAM_DELIVERY_CLAIM_CONFLICT");
    return rows[0];
  });
}

async function completeDelivery(
  database: EventDatabase,
  claim: StreamDeliveryClaim,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const rows = await transaction.query(
      `update stream_outbox_deliveries
          set status='COMPLETED',worker_id=null,lease_token=null,lease_until=null,
              error_code=null,completed_at=clock_timestamp()
        where outbox_id=$1 and event_id=$2 and stream_position=$3::bigint
          and status='CLAIMED' and worker_id=$4 and lease_token=$5
          and lease_until>clock_timestamp()
        returning outbox_id`,
      [claim.outbox_id, claim.event_id, claim.stream_position,
        claim.worker_id, claim.lease_token],
    );
    if (rows.length !== 1) return false;
    const state = await transaction.query(
      `update stream_publish_state set active_outbox_id=null,updated_at=clock_timestamp()
        where singleton=true and active_outbox_id=$1 returning singleton`,
      [claim.outbox_id],
    );
    if (state.length !== 1) throw new Error("STREAM_PUBLISH_STATE_CONFLICT");
    return true;
  });
}

function errorCode(error: unknown): string {
  const source = error instanceof Error ? error.message : "STREAM_PUBLISH_FAILED";
  const normalized = source.toUpperCase().replace(/[^A-Z0-9_:-]/gu, "_").slice(0, 128);
  return normalized.startsWith("STREAM_") ? normalized : "STREAM_PUBLISH_FAILED";
}

async function transitionFailure(
  database: EventDatabase,
  claim: StreamDeliveryClaim,
  maximumAttempts: number,
  error: unknown,
): Promise<Exclude<StreamPublishResult, "IDLE" | "COMPLETED">> {
  const terminalAuthorityFailure = error instanceof Error
    && error.message === "STREAM_OUTBOX_AUTHORITY_INVALID";
  const terminal = terminalAuthorityFailure || claim.attempts >= maximumAttempts;
  return database.transaction(async (transaction) => {
    const rows = await transaction.query(
      `update stream_outbox_deliveries
          set status=$1,worker_id=null,lease_token=null,lease_until=null,
              available_at=case when $1='RETRY_SCHEDULED'
                then clock_timestamp()+($2::int*interval '1 millisecond')
                else available_at end,
              error_code=$3
        where outbox_id=$4 and event_id=$5 and stream_position=$6::bigint
          and status='CLAIMED' and worker_id=$7 and lease_token=$8
          and lease_until>clock_timestamp()
        returning outbox_id`,
      [terminal ? "FAILED" : "RETRY_SCHEDULED",
        Math.min(60_000, 1_000 * (2 ** Math.min(claim.attempts - 1, 6))),
        errorCode(error), claim.outbox_id, claim.event_id, claim.stream_position,
        claim.worker_id, claim.lease_token],
    );
    if (rows.length !== 1) return "LEASE_LOST";
    if (terminal) {
      const state = await transaction.query(
        `update stream_publish_state set active_outbox_id=null,updated_at=clock_timestamp()
          where singleton=true and active_outbox_id=$1 returning singleton`,
        [claim.outbox_id],
      );
      if (state.length !== 1) throw new Error("STREAM_PUBLISH_STATE_CONFLICT");
    }
    return terminal ? "FAILED" : "RETRY_SCHEDULED";
  });
}

export async function publishNextCommittedEvent(input: {
  readonly db: EventDatabase;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly publishTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly publish: (
    channel: string,
    cursor: string,
    signal: AbortSignal,
  ) => Promise<void>;
}): Promise<StreamPublishResult> {
  if (!WORKER_ID.test(input.workerId)) throw new Error("STREAM_WORKER_ID_INVALID");
  const leaseMs = positiveInteger(input.leaseMs, 300_000, "STREAM_LEASE_INVALID");
  if (leaseMs < 2) throw new Error("STREAM_LEASE_INVALID");
  const maxAttempts = positiveInteger(input.maxAttempts, 20, "STREAM_MAX_ATTEMPTS_INVALID");
  const publishTimeoutMs = positiveInteger(
    input.publishTimeoutMs ?? Math.max(1, Math.floor(leaseMs / 2)),
    60_000,
    "STREAM_PUBLISH_TIMEOUT_INVALID",
  );
  if (publishTimeoutMs >= leaseMs) throw new Error("STREAM_PUBLISH_TIMEOUT_INVALID");
  if (input.signal?.aborted) return "IDLE";
  const claim = await claimDelivery(input.db, input.workerId, leaseMs);
  if (!claim) return "IDLE";
  try {
    if (!UUID.test(claim.event_id)
        || !UUID.test(claim.outbox_id)
        || !exactEventPayload(claim.payload, claim.event_id)) {
      throw new Error("STREAM_OUTBOX_AUTHORITY_INVALID");
    }
    const cursor = formatStreamCursor(claim.stream_position, claim.event_id);
    if (input.signal?.aborted) throw new Error("STREAM_PUBLISH_ABORTED");
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("STREAM_PUBLISH_ABORTED"));
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new Error("STREAM_PUBLISH_TIMEOUT"));
    }, publishTimeoutMs);
    timer.unref?.();
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("STREAM_PUBLISH_ABORTED"),
        );
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      await Promise.race([
        input.publish(STREAM_EVENT_CHANNEL, cursor, controller.signal),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
    return await completeDelivery(input.db, claim) ? "COMPLETED" : "LEASE_LOST";
  } catch (error) {
    return transitionFailure(input.db, claim, maxAttempts, error);
  }
}

export interface StreamPublisherController {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export function startCommittedEventPublisher(input: {
  readonly db: EventDatabase;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly pollIntervalMs: number;
  readonly publishTimeoutMs?: number;
  readonly publish: (
    channel: string,
    cursor: string,
    signal: AbortSignal,
  ) => Promise<void>;
}): StreamPublisherController {
  const pollIntervalMs = positiveInteger(
    input.pollIntervalMs, 60_000, "STREAM_POLL_INTERVAL_INVALID",
  );
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const shutdown = new AbortController();
  const wait = () => new Promise<void>((resolve) => {
    wake = resolve;
    timer = setTimeout(() => {
      timer = undefined;
      wake = undefined;
      resolve();
    }, pollIntervalMs);
    timer.unref?.();
  });
  const done = (async () => {
    while (!stopping) {
      const result = await publishNextCommittedEvent({
        ...input,
        signal: shutdown.signal,
      }).catch(() => "RETRY_SCHEDULED" as const);
      if (stopping) break;
      if (result === "IDLE" || result === "RETRY_SCHEDULED" || result === "FAILED") {
        await wait();
      }
    }
  })();
  return Object.freeze({
    done,
    async stop() {
      stopping = true;
      shutdown.abort(new Error("STREAM_PUBLISH_ABORTED"));
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      wake?.();
      wake = undefined;
      await done;
    },
  });
}

async function main(): Promise<void> {
  const url = process.env.VALKEY_URL;
  if (!url) throw new Error("VALKEY_URL_REQUIRED");
  const client = createClient({
    url,
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  });
  client.on("error", () => undefined);
  let controller: StreamPublisherController | undefined;
  try {
    await client.connect();
    controller = startCommittedEventPublisher({
      db: getDatabase(),
      workerId: process.env.GUSTAVO_STREAM_WORKER_ID ?? `stream:${process.pid}`,
      leaseMs: 30_000,
      maxAttempts: 10,
      pollIntervalMs: 250,
      publishTimeoutMs: 5_000,
      publish: async (channel, cursor) => { await client.publish(channel, cursor); },
    });
    let finish!: () => void;
    const interrupt = new Promise<void>((resolve) => { finish = resolve; });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    await interrupt.finally(() => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
    });
  } finally {
    try {
      await controller?.stop();
    } finally {
      try {
        if (client.isOpen) client.destroy();
      } finally {
        await closeDatabase();
      }
    }
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "STREAM_WORKER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
