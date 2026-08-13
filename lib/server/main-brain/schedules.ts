import { randomUUID } from "node:crypto";
import { appendEvent } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { BROADCAST_POLICY_VERSION } from "./broadcasts";

const MAIN_BRAIN_ID = "gustavo-main";
const GENERATION_EVENT_TYPE = "main.broadcast.generation.requested";
const MAX_SCHEDULES_PER_POLL = 100;
const MAX_DUE_SLOTS_PER_SCHEDULE = 64;
const MAX_CRON_SEARCH_DAYS = 8 * 366;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface ScheduleRow extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly created_at: Date;
}

interface RuntimeRow extends Record<string, unknown> {
  readonly schedule_version: number;
  readonly next_run_at: Date | null;
}

interface CycleRow extends Record<string, unknown> {
  readonly id: string;
  readonly schedule_id: string;
  readonly schedule_version: number;
  readonly slot_at: Date;
  readonly main_state_version: string | number | null;
  readonly policy_version: string;
  readonly snapshot: unknown;
  readonly open_event_id: string;
  readonly opened_at: Date;
}

interface SnapshotRow extends Record<string, unknown> {
  readonly main_state_version: string | number | null;
  readonly market_data_high_water_id: string | null;
  readonly market_data_observed_at: Date | null;
}

interface ParsedCronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

interface ParsedCron {
  readonly minute: ParsedCronField;
  readonly hour: ParsedCronField;
  readonly dayOfMonth: ParsedCronField;
  readonly month: ParsedCronField;
  readonly dayOfWeek: ParsedCronField;
}

interface ZonedMinute {
  readonly year: number;
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
}

export interface BroadcastScheduleContext {
  readonly db: EventDatabase;
}

export interface OpenedBroadcastCycle {
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduleVersion: number;
  readonly slotAt: string;
  readonly authorType: "MAIN_BRAIN";
  readonly mainStateVersion: number | null;
  readonly policyVersion: string;
  readonly snapshot: Readonly<{
    readonly mainStateVersion: number | null;
    readonly policyVersion: string;
    readonly marketData: Readonly<{
      readonly highWaterId: string | null;
      readonly observedAt: string | null;
    }>;
  }>;
  readonly openEventId: string;
  readonly openedAt: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const zonedMinuteCache = new Map<string, ZonedMinute>();
const timezoneOffsetCache = new Map<string, readonly number[]>();
const MAX_ZONED_MINUTE_CACHE_ENTRIES = 16_384;
const MAX_TIMEZONE_OFFSET_CACHE_ENTRIES = 4_096;

function requireDatabase(context: BroadcastScheduleContext): EventDatabase {
  if (!context || typeof context !== "object" || !context.db) {
    throw new Error("BROADCAST_SCHEDULE_CONTEXT_INVALID");
  }
  return context.db;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("BROADCAST_SCHEDULE_CLOCK_INVALID");
  }
  return new Date(value);
}

function positiveInteger(value: unknown, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(code);
  }
  return value as number;
}

function parseInteger(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
  }
  return parsed;
}

function parseCronField(
  source: string,
  minimum: number,
  maximum: number,
  normalize?: (value: number) => number,
): ParsedCronField {
  if (!source || source.length > 64) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
  const values = new Set<number>();
  for (const segment of source.split(",")) {
    if (!segment) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
    const slashParts = segment.split("/");
    if (slashParts.length > 2) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
    const base = slashParts[0]!;
    const step = slashParts[1] === undefined
      ? 1
      : parseInteger(slashParts[1], 1, maximum - minimum + 1);
    let start: number;
    let end: number;
    if (base === "*") {
      start = minimum;
      end = maximum;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
      start = parseInteger(range[0]!, minimum, maximum);
      end = parseInteger(range[1]!, minimum, maximum);
      if (start > end) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
    } else {
      start = parseInteger(base, minimum, maximum);
      end = start;
      if (slashParts[1] !== undefined) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalize ? normalize(value) : value);
    }
  }
  if (values.size === 0) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
  return Object.freeze({
    values,
    wildcard: /^\*(?:\/1)?$/.test(source),
  });
}

function parseCron(source: string): ParsedCron {
  if (typeof source !== "string" || source !== source.trim()) {
    throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
  }
  const fields = source.split(/\s+/);
  if (fields.length !== 5) throw new Error("BROADCAST_SCHEDULE_CRON_INVALID");
  return Object.freeze({
    minute: parseCronField(fields[0]!, 0, 59),
    hour: parseCronField(fields[1]!, 0, 23),
    dayOfMonth: parseCronField(fields[2]!, 1, 31),
    month: parseCronField(fields[3]!, 1, 12),
    dayOfWeek: parseCronField(fields[4]!, 0, 7, (value) => value === 7 ? 0 : value),
  });
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  if (typeof timezone !== "string" || timezone.length < 1 || timezone.length > 128
    || timezone !== timezone.trim()) {
    throw new Error("BROADCAST_SCHEDULE_TIMEZONE_INVALID");
  }
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatter.format(new Date(0));
    if (formatterCache.size >= 128) formatterCache.clear();
    formatterCache.set(timezone, formatter);
    return formatter;
  } catch {
    throw new Error("BROADCAST_SCHEDULE_TIMEZONE_INVALID");
  }
}

function zonedMinute(timezone: string, instant: Date): ZonedMinute {
  const formatter = formatterFor(timezone);
  const instantMilliseconds = instant.getTime();
  if (!Number.isFinite(instantMilliseconds)) {
    throw new Error("BROADCAST_SCHEDULE_TIMEZONE_INVALID");
  }
  const cacheKey = `${timezone}:${Math.floor(instantMilliseconds / MINUTE_MS)}`;
  const cached = zonedMinuteCache.get(cacheKey);
  if (cached) return cached;
  const parts = formatter.formatToParts(instant);
  const record = new Map(parts.map((part) => [part.type, part.value]));
  const weekdays: Readonly<Record<string, number>> = Object.freeze({
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  });
  const weekday = weekdays[record.get("weekday") ?? ""];
  const minute = Number(record.get("minute"));
  const hour = Number(record.get("hour"));
  const dayOfMonth = Number(record.get("day"));
  const month = Number(record.get("month"));
  const year = Number(record.get("year"));
  if (weekday === undefined || !Number.isInteger(minute) || !Number.isInteger(hour)
    || !Number.isInteger(dayOfMonth) || !Number.isInteger(month)
    || !Number.isInteger(year)) {
    throw new Error("BROADCAST_SCHEDULE_TIMEZONE_INVALID");
  }
  const result = Object.freeze({ year, minute, hour, dayOfMonth, month, dayOfWeek: weekday });
  if (zonedMinuteCache.size >= MAX_ZONED_MINUTE_CACHE_ENTRIES) zonedMinuteCache.clear();
  zonedMinuteCache.set(cacheKey, result);
  return result;
}

function cronDateMatches(
  parsed: ParsedCron,
  month: number,
  dayOfMonth: number,
  dayOfWeek: number,
): boolean {
  if (!parsed.month.values.has(month)) return false;
  const dayOfMonthMatches = parsed.dayOfMonth.values.has(dayOfMonth);
  const dayOfWeekMatches = parsed.dayOfWeek.values.has(dayOfWeek);
  if (parsed.dayOfMonth.wildcard) return dayOfWeekMatches;
  if (parsed.dayOfWeek.wildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function cronMatches(parsed: ParsedCron, zoned: ZonedMinute): boolean {
  return parsed.minute.values.has(zoned.minute)
    && parsed.hour.values.has(zoned.hour)
    && cronDateMatches(
      parsed, zoned.month, zoned.dayOfMonth, zoned.dayOfWeek,
    );
}

function floorMinute(value: Date): Date {
  return new Date(Math.floor(value.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function cronMatchesInstant(cron: string, timezone: string, instant: Date): boolean {
  const safeInstant = requireDate(instant);
  return cronMatches(parseCron(cron), zonedMinute(timezone, safeInstant));
}

function timezoneOffsetMilliseconds(timezone: string, instantMilliseconds: number): number {
  const instant = new Date(Math.floor(instantMilliseconds / MINUTE_MS) * MINUTE_MS);
  const zoned = zonedMinute(timezone, instant);
  return Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.dayOfMonth,
    zoned.hour,
    zoned.minute,
  ) - instant.getTime();
}

function timezoneOffsetsForLocalDate(
  timezone: string,
  year: number,
  month: number,
  dayOfMonth: number,
): readonly number[] {
  const cacheKey = `${timezone}:${year}-${month}-${dayOfMonth}`;
  const cached = timezoneOffsetCache.get(cacheKey);
  if (cached) return cached;
  const localNoonAsUtc = Date.UTC(year, month - 1, dayOfMonth, 12);
  const probeDays = [-2, 0, 2] as const;
  const result = Object.freeze([...new Set(probeDays.map((days) => (
    timezoneOffsetMilliseconds(timezone, localNoonAsUtc + days * DAY_MS)
  )))]);
  if (timezoneOffsetCache.size >= MAX_TIMEZONE_OFFSET_CACHE_ENTRIES) {
    timezoneOffsetCache.clear();
  }
  timezoneOffsetCache.set(cacheKey, result);
  return result;
}

function possibleWallClockInstants(
  timezone: string,
  year: number,
  month: number,
  dayOfMonth: number,
  hour: number,
  minute: number,
): readonly Date[] {
  const wallAsUtc = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  const matches = new Map<number, Date>();
  for (const offset of timezoneOffsetsForLocalDate(
    timezone, year, month, dayOfMonth,
  )) {
    const candidate = new Date(wallAsUtc - offset);
    const zoned = zonedMinute(timezone, candidate);
    if (zoned.year === year
      && zoned.month === month
      && zoned.dayOfMonth === dayOfMonth
      && zoned.hour === hour
      && zoned.minute === minute) {
      matches.set(candidate.getTime(), candidate);
    }
  }
  return Object.freeze([...matches.values()].sort(
    (left, right) => left.getTime() - right.getTime(),
  ));
}

export function nextCronSlotAfter(cron: string, timezone: string, after: Date): Date {
  const parsed = parseCron(cron);
  formatterFor(timezone);
  const safeAfter = requireDate(after);
  const localStart = zonedMinute(timezone, safeAfter);
  const startDate = Date.UTC(
    localStart.year, localStart.month - 1, localStart.dayOfMonth,
  );
  const hours = [...parsed.hour.values].sort((left, right) => left - right);
  const minutes = [...parsed.minute.values].sort((left, right) => left - right);

  for (let checkedDays = 0; checkedDays <= MAX_CRON_SEARCH_DAYS; checkedDays += 1) {
    const calendarDate = new Date(startDate + checkedDays * DAY_MS);
    const year = calendarDate.getUTCFullYear();
    const month = calendarDate.getUTCMonth() + 1;
    const dayOfMonth = calendarDate.getUTCDate();
    const dayOfWeek = calendarDate.getUTCDay();
    if (!cronDateMatches(parsed, month, dayOfMonth, dayOfWeek)) {
      continue;
    }

    const offsets = timezoneOffsetsForLocalDate(timezone, year, month, dayOfMonth);
    const offsetSpreadMinutes = offsets.length < 2
      ? 0
      : (Math.max(...offsets) - Math.min(...offsets)) / MINUTE_MS;
    const firstWallMinute = checkedDays === 0
      ? Math.max(0, localStart.hour * 60 + localStart.minute - offsetSpreadMinutes)
      : 0;
    let earliest: Date | undefined;
    for (const hour of hours) {
      for (const minute of minutes) {
        if (hour * 60 + minute < firstWallMinute) continue;
        if (earliest && checkedDays === 0) {
          const wallMinutesAhead = hour * 60 + minute
            - (localStart.hour * 60 + localStart.minute);
          if (wallMinutesAhead > offsetSpreadMinutes) return earliest;
        }
        for (const candidate of possibleWallClockInstants(
          timezone, year, month, dayOfMonth, hour, minute,
        )) {
          if (candidate.getTime() > safeAfter.getTime()
            && (!earliest || candidate.getTime() < earliest.getTime())) {
            earliest = candidate;
          }
        }
      }
    }
    if (earliest) return earliest;
  }
  throw new Error("BROADCAST_SCHEDULE_NEXT_RUN_OUT_OF_RANGE");
}

function parseMainStateVersion(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("BROADCAST_SCHEDULE_MAIN_STATE_INVALID");
  }
  return parsed;
}

function parseSnapshot(value: unknown): OpenedBroadcastCycle["snapshot"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BROADCAST_SCHEDULE_SNAPSHOT_INVALID");
  }
  const snapshot = value as Record<string, unknown>;
  const mainStateVersion = snapshot.mainStateVersion;
  const marketData = snapshot.marketData;
  if ((mainStateVersion !== null && !Number.isSafeInteger(mainStateVersion))
    || snapshot.policyVersion !== BROADCAST_POLICY_VERSION
    || !marketData || typeof marketData !== "object" || Array.isArray(marketData)) {
    throw new Error("BROADCAST_SCHEDULE_SNAPSHOT_INVALID");
  }
  const market = marketData as Record<string, unknown>;
  if ((market.highWaterId !== null && typeof market.highWaterId !== "string")
    || (market.observedAt !== null && typeof market.observedAt !== "string")) {
    throw new Error("BROADCAST_SCHEDULE_SNAPSHOT_INVALID");
  }
  return Object.freeze({
    mainStateVersion: mainStateVersion as number | null,
    policyVersion: BROADCAST_POLICY_VERSION,
    marketData: Object.freeze({
      highWaterId: market.highWaterId as string | null,
      observedAt: market.observedAt as string | null,
    }),
  });
}

function mapCycle(row: CycleRow): OpenedBroadcastCycle {
  return Object.freeze({
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleVersion: row.schedule_version,
    slotAt: row.slot_at.toISOString(),
    authorType: "MAIN_BRAIN",
    mainStateVersion: parseMainStateVersion(row.main_state_version),
    policyVersion: row.policy_version,
    snapshot: parseSnapshot(row.snapshot),
    openEventId: row.open_event_id,
    openedAt: row.opened_at.toISOString(),
  });
}

const CYCLE_COLUMNS = `
  id::text,schedule_id,schedule_version,slot_at,main_state_version,
  policy_version,snapshot,open_event_id::text,opened_at
`;

async function currentSnapshot(database: EventDatabase): Promise<OpenedBroadcastCycle["snapshot"]> {
  const row = await database.one<SnapshotRow>(
    `select
       (select max(version) from main_state_versions where status='COMMITTED') main_state_version,
       (select id::text from market_observations
         order by observed_at desc,id desc limit 1) market_data_high_water_id,
       (select observed_at from market_observations
         order by observed_at desc,id desc limit 1) market_data_observed_at`,
  );
  return Object.freeze({
    mainStateVersion: parseMainStateVersion(row.main_state_version),
    policyVersion: BROADCAST_POLICY_VERSION,
    marketData: Object.freeze({
      highWaterId: row.market_data_high_water_id,
      observedAt: row.market_data_observed_at?.toISOString() ?? null,
    }),
  });
}

async function openSlot(
  database: EventDatabase,
  schedule: ScheduleRow,
  slotAt: Date,
  openedAt: Date,
  snapshot: OpenedBroadcastCycle["snapshot"],
): Promise<OpenedBroadcastCycle> {
  const existing = await database.query<CycleRow>(
    `select ${CYCLE_COLUMNS} from broadcast_cycles
      where schedule_id=$1 and slot_at=$2`,
    [schedule.id, slotAt],
  );
  if (existing[0]) return mapCycle(existing[0]);

  const id = randomUUID();
  const body = {
    author: { type: "MAIN_BRAIN", id: MAIN_BRAIN_ID },
    scheduleId: schedule.id,
    scheduleVersion: schedule.version,
    slotAt: slotAt.toISOString(),
    snapshot,
  } satisfies JsonValue;
  const event = await appendEvent(database, {
    aggregateId: id,
    actor: { type: "MAIN_BRAIN", id: MAIN_BRAIN_ID },
    type: GENERATION_EVENT_TYPE,
    visibility: "SHARED",
    body,
    idempotencyKey: `broadcast-cycle:${schedule.id}:${slotAt.toISOString()}`,
    occurredAt: openedAt,
    policyVersion: BROADCAST_POLICY_VERSION,
  });
  const rows = await database.query<CycleRow>(
    `insert into broadcast_cycles (
       id,schedule_id,schedule_version,slot_at,author_type,author_id,
       main_state_version,policy_version,snapshot,open_event_id,opened_at
     ) values ($1,$2,$3,$4,'MAIN_BRAIN',$5,$6,$7,$8::jsonb,$9,$10)
     returning ${CYCLE_COLUMNS}`,
    [id, schedule.id, schedule.version, slotAt, MAIN_BRAIN_ID,
      snapshot.mainStateVersion, BROADCAST_POLICY_VERSION, JSON.stringify(snapshot),
      event.id, event.occurredAt],
  );
  return mapCycle(rows[0]!);
}

async function openSchedule(
  database: EventDatabase,
  candidate: ScheduleRow,
  now: Date,
): Promise<readonly OpenedBroadcastCycle[]> {
  return database.transaction(async (transaction) => {
    await transaction.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [`broadcast-schedule:${candidate.id}`],
    );
    const currentRows = await transaction.query<ScheduleRow>(
      `select id,version,cron,timezone,enabled,created_at from broadcast_schedules
        where id=$1 order by version desc limit 1`,
      [candidate.id],
    );
    const schedule = currentRows[0];
    if (!schedule || !schedule.enabled || schedule.version !== candidate.version) return [];

    const slotNow = floorMinute(now);
    const runtimeRows = await transaction.query<RuntimeRow>(
      `select schedule_version,next_run_at from broadcast_schedule_runtime
        where schedule_id=$1 for update`,
      [schedule.id],
    );
    const runtime = runtimeRows[0];
    let nextRun = runtime?.schedule_version === schedule.version && runtime.next_run_at
      ? new Date(runtime.next_run_at)
      : nextCronSlotAfter(
        schedule.cron,
        schedule.timezone,
        new Date(schedule.created_at.getTime() - 1),
      );
    const dueByTime = new Map<number, Date>();
    let opened = 0;
    while (nextRun.getTime() <= slotNow.getTime()
      && opened < MAX_DUE_SLOTS_PER_SCHEDULE) {
      dueByTime.set(nextRun.getTime(), nextRun);
      nextRun = nextCronSlotAfter(schedule.cron, schedule.timezone, nextRun);
      opened += 1;
    }

    const cycles: OpenedBroadcastCycle[] = [];
    const dueSlots = [...dueByTime.values()]
      .sort((left, right) => left.getTime() - right.getTime())
      .slice(0, MAX_DUE_SLOTS_PER_SCHEDULE);
    if (dueSlots.length > 0) {
      const snapshot = await currentSnapshot(transaction);
      for (const slotAt of dueSlots) {
        cycles.push(await openSlot(transaction, schedule, slotAt, now, snapshot));
      }
    } else if (schedule.created_at.getTime() <= slotNow.getTime()
      && cronMatchesInstant(schedule.cron, schedule.timezone, slotNow)) {
      const replay = await transaction.query<CycleRow>(
        `select ${CYCLE_COLUMNS} from broadcast_cycles
          where schedule_id=$1 and slot_at=$2`,
        [schedule.id, slotNow],
      );
      if (replay[0]) cycles.push(mapCycle(replay[0]));
    }

    await transaction.query(
      `insert into broadcast_schedule_runtime (
         schedule_id,schedule_version,next_run_at,last_error_code,last_checked_at,updated_at
       ) values ($1,$2,$3,null,$4,clock_timestamp())
       on conflict (schedule_id) do update set
         schedule_version=excluded.schedule_version,
         next_run_at=excluded.next_run_at,
         last_error_code=null,
         last_checked_at=excluded.last_checked_at,
         updated_at=clock_timestamp()`,
      [schedule.id, schedule.version, nextRun, now],
    );
    return Object.freeze(cycles);
  });
}

export async function openDueBroadcastCycles(
  context: BroadcastScheduleContext,
  at: Date,
  options: { readonly scheduleLimit?: number } = {},
): Promise<readonly OpenedBroadcastCycle[]> {
  const database = requireDatabase(context);
  const now = requireDate(at);
  const scheduleLimit = positiveInteger(
    options.scheduleLimit ?? MAX_SCHEDULES_PER_POLL,
    MAX_SCHEDULES_PER_POLL,
    "BROADCAST_SCHEDULE_LIMIT_INVALID",
  );
  const schedules = await database.query<ScheduleRow>(
    `select current.id,current.version,current.cron,current.timezone,
            current.enabled,current.created_at
       from (
       select distinct on (id) id,version,cron,timezone,enabled,created_at
         from broadcast_schedules order by id,version desc
     ) current
     left join broadcast_schedule_runtime runtime
       on runtime.schedule_id=current.id
     where enabled
     order by (runtime.schedule_id is not null),runtime.last_checked_at nulls first,current.id
     limit $1`,
    [scheduleLimit],
  );
  const opened: OpenedBroadcastCycle[] = [];
  for (const schedule of schedules) {
    try {
      opened.push(...await openSchedule(database, schedule, now));
    } catch (error) {
      if (!(error instanceof Error) || ![
        "BROADCAST_SCHEDULE_CRON_INVALID",
        "BROADCAST_SCHEDULE_TIMEZONE_INVALID",
        "BROADCAST_SCHEDULE_NEXT_RUN_OUT_OF_RANGE",
      ].includes(error.message)) throw error;
      await database.query(
        `insert into broadcast_schedule_runtime (
           schedule_id,schedule_version,next_run_at,last_error_code,last_checked_at,updated_at
         ) values ($1,$2,null,$3,$4,clock_timestamp())
         on conflict (schedule_id) do update set
           schedule_version=excluded.schedule_version,
           next_run_at=null,
           last_error_code=excluded.last_error_code,
           last_checked_at=excluded.last_checked_at,
           updated_at=clock_timestamp()`,
        [schedule.id, schedule.version, error.message, now],
      );
    }
  }
  return Object.freeze(opened);
}
