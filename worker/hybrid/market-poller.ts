import type { EventDatabase } from "../../lib/server/events/types";
import { storeLatestMarketWindow } from "../../lib/server/market-data/latest";
import {
  finalizeMarketPollWindow,
  MARKET_MAX_CALLS_PER_WINDOW,
  marketWindowStart,
  recoverMarketPollWindow,
  type MarketPollWindowInput,
  type PersistableMarketPollWindow,
} from "../../lib/server/market-data/session";

const FINNHUB_DAILY_CALL_LIMIT = 27_648 as const;

export type MarketPollReservation =
  | {
    readonly disposition: "POLL";
    readonly windowId: string;
  }
  | {
    readonly disposition: "RECOVER";
    readonly windowId: string;
    readonly callsUsed: number;
  }
  | {
    readonly disposition: "SKIP";
    readonly windowId: string;
  }
  | {
    readonly disposition: "REJECT";
    readonly windowId: string;
    readonly safeCode: "QUOTA_EXHAUSTED";
  };

export interface MarketHeartbeat {
  readonly status: "HEALTHY" | "DEGRADED";
  readonly safeCode?: "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "QUOTA_EXHAUSTED";
}

export interface RunMarketPollWindowOptions<Database> {
  readonly withDatabase: <Result>(
    work: (database: Database) => Promise<Result>,
  ) => Promise<Result>;
  readonly reserve: (database: Database) => Promise<MarketPollReservation>;
  readonly poll: (windowId: string) => Promise<MarketPollWindowInput>;
  readonly store: (
    database: Database,
    window: PersistableMarketPollWindow,
  ) => Promise<void | "STORED" | "SKIPPED">;
  readonly heartbeat: (
    database: Database,
    heartbeat: MarketHeartbeat,
  ) => Promise<void>;
}

export type MarketPollWindowOutcome = PersistableMarketPollWindow | {
  readonly disposition: "SKIPPED";
  readonly windowId: string;
} | {
  readonly disposition: "REJECTED";
  readonly windowId: string;
  readonly safeCode: "QUOTA_EXHAUSTED";
};

interface PollWindowRow extends Record<string, unknown> {
  readonly window_id: string;
  readonly status: "PENDING" | "COMPLETED" | "FAILED";
  readonly calls_used: number;
  readonly prune_after: Date;
}

interface ReservationClockRow extends Record<string, unknown> {
  readonly database_now: Date;
  readonly current_window_started_at: Date;
}

async function reservationClock(database: EventDatabase): Promise<{
  readonly databaseNow: Date;
  readonly currentWindowStartedAt: Date;
}> {
  const rows = await database.query<ReservationClockRow>(
    `with database_clock as (
       select market_poll_reservation_now() database_now
     )
     select database_now,
            date_bin(
              interval '5 minutes',database_now,
              timestamptz '1970-01-01 00:00:00+00'
            ) current_window_started_at
       from database_clock`,
  );
  if (rows.length !== 1) throw new Error("MARKET_POLL_RESERVATION_INVALID");
  const databaseNow = rows[0]!.database_now;
  const currentWindowStartedAt = rows[0]!.current_window_started_at;
  if (!(databaseNow instanceof Date) || !Number.isFinite(databaseNow.getTime())
    || !(currentWindowStartedAt instanceof Date)
    || !Number.isFinite(currentWindowStartedAt.getTime())) {
    throw new Error("MARKET_POLL_RESERVATION_INVALID");
  }
  return Object.freeze({ databaseNow, currentWindowStartedAt });
}

function exactReservation(value: MarketPollReservation): MarketPollReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MARKET_POLL_RESERVATION_INVALID");
  }
  const windowId = value.windowId;
  marketWindowStart(windowId);
  if (value.disposition === "POLL" || value.disposition === "SKIP") {
    if (Object.keys(value).sort().join(",") !== "disposition,windowId") {
      throw new Error("MARKET_POLL_RESERVATION_INVALID");
    }
    return Object.freeze({ disposition: value.disposition, windowId });
  }
  if (value.disposition === "RECOVER") {
    if (Object.keys(value).sort().join(",") !== "callsUsed,disposition,windowId"
      || !Number.isSafeInteger(value.callsUsed)
      || value.callsUsed < 0
      || value.callsUsed > 96) {
      throw new Error("MARKET_POLL_RESERVATION_INVALID");
    }
    return Object.freeze({
      disposition: "RECOVER",
      windowId,
      callsUsed: value.callsUsed,
    });
  }
  if (value.disposition === "REJECT"
    && Object.keys(value).sort().join(",") === "disposition,safeCode,windowId"
    && value.safeCode === "QUOTA_EXHAUSTED") {
    return Object.freeze({
      disposition: "REJECT",
      windowId,
      safeCode: "QUOTA_EXHAUSTED",
    });
  }
  throw new Error("MARKET_POLL_RESERVATION_INVALID");
}

function heartbeatFor(window: PersistableMarketPollWindow): MarketHeartbeat {
  if (window.status === "COMPLETED") return Object.freeze({ status: "HEALTHY" });
  return Object.freeze({
    status: "DEGRADED",
    safeCode: window.safeCode === "RATE_LIMITED"
      ? "RATE_LIMITED"
      : "PROVIDER_UNAVAILABLE",
  });
}

/**
 * Each database callback is a complete short-lived transaction lifecycle.
 * No database handle crosses the provider await, and the final store plus
 * heartbeat share one callback so their transaction can commit atomically.
 */
export async function runMarketPollWindow<Database>(
  options: RunMarketPollWindowOptions<Database>,
): Promise<MarketPollWindowOutcome> {
  if (!options || typeof options.withDatabase !== "function"
    || typeof options.reserve !== "function"
    || typeof options.poll !== "function"
    || typeof options.store !== "function"
    || typeof options.heartbeat !== "function") {
    throw new Error("MARKET_POLLER_CONFIG_INVALID");
  }

  const reservation = await options.withDatabase(async (database) => {
    const reserved = exactReservation(await options.reserve(database));
    if (reserved.disposition === "REJECT") {
      await options.heartbeat(database, Object.freeze({
        status: "DEGRADED",
        safeCode: "QUOTA_EXHAUSTED",
      }));
    }
    return reserved;
  });

  if (reservation.disposition === "SKIP") {
    return Object.freeze({
      disposition: "SKIPPED",
      windowId: reservation.windowId,
    });
  }
  if (reservation.disposition === "REJECT") {
    return Object.freeze({
      disposition: "REJECTED",
      windowId: reservation.windowId,
      safeCode: "QUOTA_EXHAUSTED",
    });
  }

  let persistable: PersistableMarketPollWindow;
  if (reservation.disposition === "RECOVER") {
    persistable = recoverMarketPollWindow(
      reservation.windowId,
      reservation.callsUsed,
    );
  } else {
    try {
      persistable = finalizeMarketPollWindow(
        reservation.windowId,
        await options.poll(reservation.windowId),
      );
    } catch {
      persistable = recoverMarketPollWindow(reservation.windowId, 0);
    }
  }

  const storeResult = await options.withDatabase(async (database) => {
    const result = await options.store(database, persistable);
    if (result === "SKIPPED") return result;
    if (result !== undefined && result !== "STORED") {
      throw new Error("MARKET_POLL_STORE_INVALID");
    }
    await options.heartbeat(database, heartbeatFor(persistable));
    return "STORED" as const;
  });
  if (storeResult === "SKIPPED") {
    return Object.freeze({
      disposition: "SKIPPED",
      windowId: persistable.windowId,
    });
  }
  return persistable;
}

export async function reserveMarketPollWindow(
  database: EventDatabase,
  windowId: string,
): Promise<MarketPollReservation> {
  const windowStartedAt = marketWindowStart(windowId);
  await database.query(
    "select pg_advisory_xact_lock(hashtextextended($1,0))",
    [`market-poll:${windowId}`],
  );
  const { databaseNow, currentWindowStartedAt } = await reservationClock(database);
  const existing = await database.query<PollWindowRow>(
    `select window_id,status,calls_used,prune_after
       from market_poll_windows where window_id=$1 for update`,
    [windowId],
  );
  if (existing.length > 0) {
    const row = existing[0]!;
    if (row.window_id !== windowId
      || !Number.isInteger(row.calls_used)
      || row.calls_used < 0
      || row.calls_used > MARKET_MAX_CALLS_PER_WINDOW
      || !(row.prune_after instanceof Date)
      || !Number.isFinite(row.prune_after.getTime())) {
      throw new Error("MARKET_POLL_RESERVATION_INVALID");
    }
    if (row.status === "PENDING") {
      if (databaseNow.getTime() >= row.prune_after.getTime()) {
        const removed = await database.query(
          `delete from market_poll_windows
            where window_id=$1 and status='PENDING'
              and prune_after<=clock_timestamp()
            returning window_id`,
          [windowId],
        );
        if (removed.length !== 1) throw new Error("MARKET_POLL_RESERVATION_INVALID");
        return Object.freeze({ disposition: "SKIP", windowId });
      }
      if (windowStartedAt.getTime() < currentWindowStartedAt.getTime()) {
        return Object.freeze({
          disposition: "RECOVER",
          windowId,
          callsUsed: row.calls_used,
        });
      }
      return Object.freeze({ disposition: "SKIP", windowId });
    }
    if (row.status === "COMPLETED" || row.status === "FAILED") {
      return Object.freeze({ disposition: "SKIP", windowId });
    }
    throw new Error("MARKET_POLL_RESERVATION_INVALID");
  }

  if (windowStartedAt.getTime() !== currentWindowStartedAt.getTime()) {
    return Object.freeze({ disposition: "SKIP", windowId });
  }
  const bucketDate = currentWindowStartedAt.toISOString().slice(0, 10);
  await database.query("savepoint market_poll_quota_reservation");
  const quota = await database.query<{ readonly used_count: number } & Record<string, unknown>>(
    `insert into deployment_quota_counters (
       quota_name,bucket_date,used_count,limit_count
     ) values ('FINNHUB_CALLS',$1,$2,$3)
     on conflict (quota_name,bucket_date) do update
       set used_count=deployment_quota_counters.used_count+excluded.used_count,
           updated_at=clock_timestamp()
     where deployment_quota_counters.used_count+excluded.used_count
           <=deployment_quota_counters.limit_count
     returning used_count`,
    [bucketDate, MARKET_MAX_CALLS_PER_WINDOW, FINNHUB_DAILY_CALL_LIMIT],
  );
  const afterQuota = await reservationClock(database);
  if (windowStartedAt.getTime() !== afterQuota.currentWindowStartedAt.getTime()) {
    await database.query("rollback to savepoint market_poll_quota_reservation");
    await database.query("release savepoint market_poll_quota_reservation");
    return Object.freeze({ disposition: "SKIP", windowId });
  }
  await database.query("release savepoint market_poll_quota_reservation");
  if (quota.length !== 1) {
    return Object.freeze({
      disposition: "REJECT",
      windowId,
      safeCode: "QUOTA_EXHAUSTED",
    });
  }
  await database.query(
    `insert into market_poll_windows (window_id,window_started_at)
     values ($1,$2)`,
    [windowId, windowStartedAt],
  );
  return Object.freeze({ disposition: "POLL", windowId });
}

export async function persistMarketPollWindow(
  database: EventDatabase,
  accountId: string,
  window: PersistableMarketPollWindow,
): Promise<"STORED" | "SKIPPED"> {
  const exact = window.status === "FAILED"
    ? validatedFailure(window)
    : finalizeMarketPollWindow(window.windowId, window);
  if (exact.mutateLatest) {
    await storeLatestMarketWindow(
      { db: database, accountId },
      { windowId: exact.windowId, items: exact.items },
    );
  }
  const updated = await database.query(
    `update market_poll_windows
        set status=$2,provider_status=$3,calls_used=$4,result_count=$5,
            safe_code=$6,completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where window_id=$1 and status='PENDING'
      returning window_id`,
    [exact.windowId, exact.status, exact.providerStatus, exact.callsUsed,
      exact.resultCount, exact.safeCode],
  );
  if (updated.length === 1) return "STORED";
  if (exact.status === "FAILED") {
    const removed = await database.query(
      `delete from market_poll_windows
        where window_id=$1 and status='PENDING'
          and prune_after<=clock_timestamp()
        returning window_id`,
      [exact.windowId],
    );
    if (removed.length === 1) return "SKIPPED";
  }
  throw new Error("MARKET_POLL_STORE_CONFLICT");
}

function validatedFailure(
  window: PersistableMarketPollWindow,
): PersistableMarketPollWindow {
  marketWindowStart(window.windowId);
  if (window.status !== "FAILED"
    || window.providerStatus !== "ERROR"
    || window.mutateLatest
    || !window.nextWindowPending
    || !Number.isInteger(window.callsUsed) || window.callsUsed < 0
    || window.callsUsed > MARKET_MAX_CALLS_PER_WINDOW
    || !Number.isInteger(window.resultCount) || window.resultCount < 0
    || window.resultCount > 95
    || !["PROVIDER_ERROR", "RATE_LIMITED", "RESULT_COUNT_INVALID",
      "CALL_LIMIT_EXCEEDED", "WINDOW_CONFLICT"].includes(window.safeCode ?? "")) {
    throw new Error("MARKET_POLL_STORE_INVALID");
  }
  return window;
}

export async function writeMarketHeartbeat(
  database: EventDatabase,
  heartbeat: MarketHeartbeat,
): Promise<void> {
  const safeCode = heartbeat.status === "HEALTHY" ? null : heartbeat.safeCode;
  if ((heartbeat.status === "HEALTHY" && heartbeat.safeCode !== undefined)
    || (heartbeat.status === "DEGRADED"
      && !["PROVIDER_UNAVAILABLE", "RATE_LIMITED", "QUOTA_EXHAUSTED"].includes(safeCode ?? ""))) {
    throw new Error("MARKET_HEARTBEAT_INVALID");
  }
  await database.query(
    `insert into hybrid_worker_heartbeats (component,status,safe_code)
     values ('MARKET',$1,$2)
     on conflict (component) do update
       set status=excluded.status,safe_code=excluded.safe_code,
           observed_at=clock_timestamp(),updated_at=clock_timestamp()`,
    [heartbeat.status, safeCode],
  );
}
