import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  cronMatchesInstant,
  nextCronSlotAfter,
  openDueBroadcastCycles,
} from "../../lib/server/main-brain/schedules";
import {
  runBroadcastSchedulerOnce,
  startBroadcastScheduler,
} from "../../worker/broadcasts/scheduler";
import { startProductionBroadcastScheduler } from "../../worker/runtime";
import { testContext } from "../helpers/postgres";

async function waitForCycleCount(
  db: Awaited<ReturnType<typeof testContext>>["db"],
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await db.one<{ readonly count: number }>(
      "select count(*)::int count from broadcast_cycles",
    );
    if (row.count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`CYCLE_COUNT_TIMEOUT:${expected}`);
}

describe("Main broadcast scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens one Main-authored durable cycle per due slot across retries", async () => {
    const ctx = await testContext();
    await ctx.db.query(
      "insert into broadcast_schedules(id, cron, timezone, enabled, created_at) values ($1,$2,$3,true,$4)",
      ["market-cycle", "*/15 * * * 1-5", "UTC", "2026-08-10T14:29:00.000Z"],
    );
    await ctx.db.query(
      "insert into broadcast_schedules(id, cron, timezone, enabled, created_at) values ($1,$2,$3,true,$4)",
      ["new-york-open", "30 10 * * 1-5", "America/New_York", "2026-08-10T14:29:00.000Z"],
    );
    await ctx.db.query(
      "insert into main_state_versions(version, author_type, author_id, status) values (7,'MAIN_BRAIN','gustavo-main','COMMITTED')",
    );
    await ctx.db.query(
      "insert into market_instrument_allowlist(symbol,asset_class,enabled) values ('AAPL','US_STOCK',true)",
    );
    await ctx.db.query(
      "insert into market_data_sources(provider,license_id,licensed,redistribution) values ('fixture','fixture-v1',true,'INTERNAL_ONLY')",
    );
    await ctx.db.query(
      `insert into market_observations(
         id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
         raw_source_ref,feed_status,delay_seconds,redistribution,session_state
       ) values (
         '00000000-0000-4000-8000-000000003501','AAPL','US_STOCK','100.00',
         '2026-08-10T14:29:00.000Z','2026-08-10T14:29:01.000Z','fixture','fixture-v1',
         'scheduler-fixture','REALTIME',0,'INTERNAL_ONLY','OPEN'
       )`,
    );

    const at = new Date("2026-08-10T14:30:42.000Z");
    expect(cronMatchesInstant("*/15 * * * 1-5", "UTC", at)).toBe(true);
    expect(cronMatchesInstant("30 10 * * 1-5", "America/New_York", at)).toBe(true);

    const [first, retry, concurrent] = await Promise.all([
      openDueBroadcastCycles(ctx, at),
      openDueBroadcastCycles(ctx, at),
      runBroadcastSchedulerOnce({ ...ctx, now: () => at }),
    ]);
    expect(first.length + retry.length + concurrent.length).toBeGreaterThanOrEqual(3);
    expect(await ctx.db.one(
      "select count(*)::int as count, min(author_type) as author_type from broadcast_cycles where schedule_id=$1 and slot_at=$2",
      ["market-cycle", "2026-08-10T14:30:00.000Z"],
    )).toEqual({ count: 1, author_type: "MAIN_BRAIN" });

    expect(await ctx.db.one(
      `select count(*)::int count,
              min(main_state_version)::int main_state_version,
              min(policy_version) policy_version,
              min(snapshot->'marketData'->>'highWaterId') market_data_high_water
         from broadcast_cycles where slot_at=$1`,
      ["2026-08-10T14:30:00.000Z"],
    )).toEqual({
      count: 2,
      main_state_version: 7,
      policy_version: "main-broadcast-policy-v1",
      market_data_high_water: "00000000-0000-4000-8000-000000003501",
    });
    expect(await ctx.db.one(
      `select count(*)::int count
         from transactional_outbox outbox
         join events event on event.id=outbox.event_id
         join broadcast_cycles cycle on cycle.open_event_id=event.id
        where outbox.topic='main.broadcast.generation.requested'
          and event.actor_type='MAIN_BRAIN'
          and event.actor_id='gustavo-main'`,
    )).toEqual({ count: 2 });
    const generationOutbox = await ctx.db.one<{ readonly id: string }>(
      `select outbox.id::text id
         from transactional_outbox outbox
         join events event on event.id=outbox.event_id
        where event.type='main.broadcast.generation.requested'
        order by outbox.id limit 1`,
    );
    await expect(ctx.db.query(
      "update transactional_outbox set payload=jsonb_build_object('eventId','00000000-0000-4000-8000-000000000000') where id=$1",
      [generationOutbox.id],
    )).rejects.toThrow(/IMMUTABLE_BROADCAST_GENERATION_OUTBOX/);
    await expect(ctx.db.query(
      "update transactional_outbox set topic='other.topic' where id=$1",
      [generationOutbox.id],
    )).rejects.toThrow(/IMMUTABLE_BROADCAST_GENERATION_OUTBOX/);
    await expect(ctx.db.query(
      "delete from transactional_outbox where id=$1",
      [generationOutbox.id],
    )).rejects.toThrow(/IMMUTABLE_BROADCAST_GENERATION_OUTBOX/);
    await ctx.db.query(
      `update transactional_outbox
          set status='LEASED',attempts=attempts+1,
              leased_until=clock_timestamp()+interval '30 seconds'
        where id=$1`,
      [generationOutbox.id],
    );
    expect(await ctx.db.one(
      "select next_run_at from broadcast_schedule_runtime where schedule_id=$1",
      ["market-cycle"],
    )).toEqual({ next_run_at: new Date("2026-08-10T14:45:00.000Z") });

    await expect(ctx.db.query(
      "update broadcast_schedules set cron='0 * * * *' where id='market-cycle'",
    )).rejects.toThrow(/IMMUTABLE_BROADCAST_SCHEDULE/);
    await ctx.db.query(
      "insert into broadcast_schedules(id,version,cron,timezone,enabled) values ($1,2,$2,$3,false)",
      ["market-cycle", "*/15 * * * 1-5", "UTC"],
    );
    await openDueBroadcastCycles(ctx, new Date("2026-08-10T14:45:00.000Z"));
    expect(await ctx.db.one(
      "select count(*)::int count from broadcast_cycles where schedule_id='market-cycle'",
    )).toEqual({ count: 1 });
  }, 30_000);

  it("catches up bounded due slots from durable schedule and runtime cursors", async () => {
    const ctx = await testContext();
    await ctx.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('restart-cycle','*/15 * * * *','UTC',true,$1)`,
      ["2026-08-10T14:00:30.000Z"],
    );
    await openDueBroadcastCycles(ctx, new Date("2026-08-10T14:46:00.000Z"));
    expect((await ctx.db.query<{ readonly slot_at: Date }>(
      "select slot_at from broadcast_cycles order by slot_at",
    )).map(({ slot_at }) => slot_at.toISOString())).toEqual([
      "2026-08-10T14:15:00.000Z",
      "2026-08-10T14:30:00.000Z",
      "2026-08-10T14:45:00.000Z",
    ]);

    await ctx.db.query("delete from broadcast_schedule_runtime");
    await openDueBroadcastCycles(ctx, new Date("2026-08-10T15:01:00.000Z"));
    expect(await ctx.db.one(
      "select count(*)::int count from broadcast_cycles",
    )).toEqual({ count: 4 });
    expect(await ctx.db.one(
      "select next_run_at from broadcast_schedule_runtime where schedule_id='restart-cycle'",
    )).toEqual({ next_run_at: new Date("2026-08-10T15:15:00.000Z") });
  }, 30_000);

  it("rotates bounded polling fairly beyond one page", async () => {
    const ctx = await testContext();
    const schedules = Array.from({ length: 101 }, (_, index) => `fair-${String(index).padStart(3, "0")}`);
    await ctx.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       select schedule_id,'0 * * * *','UTC',true,$2::timestamptz
         from unnest($1::text[]) schedule_id`,
      [schedules, "2026-08-10T13:59:00.000Z"],
    );
    const at = new Date("2026-08-10T14:00:00.000Z");
    await openDueBroadcastCycles(ctx, at);
    await openDueBroadcastCycles(ctx, at);
    expect(await ctx.db.one(
      "select count(*)::int count from broadcast_cycles",
    )).toEqual({ count: 101 });
  }, 60_000);

  it("treats stepped full-range days as cron wildcards", () => {
    expect(cronMatchesInstant(
      "0 0 */1 * 1", "UTC", new Date("2026-08-11T00:00:00.000Z"),
    )).toBe(false);
    expect(nextCronSlotAfter(
      "* * * * *", "UTC", new Date("2026-08-11T00:00:42.000Z"),
    )).toEqual(new Date("2026-08-11T00:01:00.000Z"));
  });

  it("finds leap-day and DST slots", () => {
    const startedAt = performance.now();
    for (let lookup = 0; lookup < 100; lookup += 1) {
      expect(nextCronSlotAfter(
        "0 0 29 2 *", "UTC", new Date("2025-03-01T00:00:00.000Z"),
      )).toEqual(new Date("2028-02-29T00:00:00.000Z"));
    }
    expect(performance.now() - startedAt).toBeLessThan(2_500);
    expect(nextCronSlotAfter(
      "30 1 * * *", "America/New_York", new Date("2026-11-01T05:30:00.000Z"),
    )).toEqual(new Date("2026-11-01T06:30:00.000Z"));
    expect(nextCronSlotAfter(
      "* * * * *", "America/New_York", new Date("2026-11-01T05:30:00.000Z"),
    )).toEqual(new Date("2026-11-01T05:31:00.000Z"));
    expect(nextCronSlotAfter(
      "30 1 * * *", "America/New_York", new Date("2026-11-01T05:29:00.000Z"),
    )).toEqual(new Date("2026-11-01T05:30:00.000Z"));
    expect(nextCronSlotAfter(
      "30 2 * * *", "America/New_York", new Date("2026-03-08T06:59:00.000Z"),
    )).toEqual(new Date("2026-03-09T06:30:00.000Z"));
  }, 60_000);

  it("calculates a dense full scheduler page and catch-up window within budget", () => {
    const startedAt = performance.now();
    const base = new Date("2026-08-10T14:00:00.000Z");
    let finalSlot = base;
    for (let schedule = 0; schedule < 100; schedule += 1) {
      let cursor = base;
      for (let slot = 0; slot < 64; slot += 1) {
        cursor = nextCronSlotAfter("* * * * *", "UTC", cursor);
        if (performance.now() - startedAt >= 2_500) {
          throw new Error("DENSE_CRON_PAGE_BUDGET_EXCEEDED");
        }
      }
      finalSlot = cursor;
    }
    expect(finalSlot).toEqual(new Date("2026-08-10T15:04:00.000Z"));
    expect(performance.now() - startedAt).toBeLessThan(2_500);
  }, 10_000);

  it("isolates an invalid schedule from later schedules", async () => {
    const ctx = await testContext();
    const invalidSchedules = Array.from(
      { length: 100 },
      (_, index) => `a-invalid-${String(index).padStart(3, "0")}`,
    );
    await ctx.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       select schedule_id,'not a cron','UTC',true,$2::timestamptz
         from unnest($1::text[]) schedule_id`,
      [invalidSchedules, "2026-08-10T13:59:00.000Z"],
    );
    await ctx.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('z-valid','0 14 * * *','UTC',true,$1)`,
      ["2026-08-10T13:59:00.000Z"],
    );
    await expect(openDueBroadcastCycles(
      ctx, new Date("2026-08-10T14:00:00.000Z"),
    )).resolves.toHaveLength(0);
    await expect(openDueBroadcastCycles(
      ctx, new Date("2026-08-10T14:00:00.000Z"),
    )).resolves.toHaveLength(1);
    expect(await ctx.db.one(
      "select count(*)::int count from broadcast_cycles where schedule_id='z-valid'",
    )).toEqual({ count: 1 });
  }, 30_000);

  it("stops and restarts its controller", async () => {
    const ctx = await testContext();
    await ctx.db.query(
      `insert into broadcast_schedules(id,cron,timezone,enabled,created_at)
       values ('worker-cycle','*/15 * * * *','UTC',true,$1)`,
      ["2026-08-10T14:00:30.000Z"],
    );
    let now = new Date("2026-08-10T14:16:00.000Z");
    const first = startBroadcastScheduler({ db: ctx.db, now: () => now, pollIntervalMs: 1_000 });
    await waitForCycleCount(ctx.db, 1);
    await first.stop();
    now = new Date("2026-08-10T14:31:00.000Z");
    const restarted = startBroadcastScheduler({ db: ctx.db, now: () => now, pollIntervalMs: 1_000 });
    await waitForCycleCount(ctx.db, 2);
    await restarted.stop();
  }, 30_000);

  it("coalesces timer ticks and stops without draining an unbounded backlog", async () => {
    vi.useFakeTimers();
    let queryCalls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstQuery = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const db: EventDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<Row[]> {
        queryCalls += 1;
        if (queryCalls === 1) await firstQuery;
        return [];
      },
      async one(): Promise<never> {
        throw new Error("UNEXPECTED_ONE");
      },
      async transaction<Result>(work: (transaction: EventDatabase) => Promise<Result>) {
        return work(db);
      },
    };
    const controller = startBroadcastScheduler({ db, pollIntervalMs: 1_000 });
    await Promise.resolve();
    expect(queryCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    const stopped = controller.stop();
    releaseFirst?.();
    await stopped;
    expect(queryCalls).toBe(1);
  });

  it("contains a throwing scheduler error callback", async () => {
    const db: EventDatabase = {
      async query(): Promise<never> {
        throw new Error("EXPECTED_POLL_FAILURE");
      },
      async one(): Promise<never> {
        throw new Error("UNEXPECTED_ONE");
      },
      async transaction<Result>(): Promise<Result> {
        throw new Error("UNEXPECTED_TRANSACTION");
      },
    };
    const controller = startBroadcastScheduler({
      db,
      pollIntervalMs: 1_000,
      onError: () => { throw new Error("EXPECTED_HANDLER_FAILURE"); },
    });
    await expect(controller.stop()).resolves.toBeUndefined();
  });

  it("starts and stops the scheduler through the production worker lifecycle", async () => {
    let queryCalls = 0;
    const db: EventDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<Row[]> {
        queryCalls += 1;
        return [];
      },
      async one(): Promise<never> {
        throw new Error("UNEXPECTED_ONE");
      },
      async transaction<Result>(work: (transaction: EventDatabase) => Promise<Result>) {
        return work(db);
      },
    };
    const scheduler = startProductionBroadcastScheduler(db);
    await scheduler.stop();
    expect(queryCalls).toBe(1);
  });
});
