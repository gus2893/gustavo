import { createClient } from "redis";
import {
  authenticateSession,
  sessionCookieName,
} from "../../../../lib/server/auth/sessions";
import type { ActorContext } from "../../../../lib/server/auth/authorize";
import {
  getDatabase,
  type DatabaseTransactionBudget,
} from "../../../../lib/server/db/postgres";
import { readEventBody } from "../../../../lib/server/events/store";
import type { EventDatabase, JsonValue } from "../../../../lib/server/events/types";
import {
  formatStreamCursor,
  isFeedEventId,
  openFeedStream,
  parseStreamCursor,
  STREAM_EVENT_CHANNEL,
  type EventIdSource,
  type StreamSourceEvent,
} from "../../../../lib/server/stream/events";

const MAX_PENDING_EVENT_IDS = 100;
const MAX_RESUME_EVENTS = 100;
const VERCEL_STREAM_LIFETIME_MS = 55_000;
const STREAM_ADMISSION_CEILING_MS = 54_000;
const STREAM_SHUTDOWN_MARGIN_MS = 1_000;
const STREAM_PAGE_SIZE = 100;
const STREAM_IDLE_POLL_MS = 1_000;
const STREAM_DATABASE_CEILING_MS = 53_000;
const STREAM_DATABASE_CONNECTION_MS = 5_000;
const STREAM_DATABASE_QUERY_MS = 5_000;
const STREAM_DATABASE_HEADROOM_MS = 250;

export const maxDuration = 60;

type AccountActor = Extract<ActorContext, { readonly role: "ACCOUNT" }>;

export interface FeedStreamAuthentication {
  readonly actor: AccountActor;
  readonly revalidate: (
    operation?: FeedStreamOperation,
  ) => boolean | Promise<boolean>;
}

export interface FeedStreamOperation {
  readonly signal: AbortSignal;
  readonly deadlineMonotonicMs: number;
  readonly remainingMilliseconds: () => number;
}

export interface FeedSubscriptionInput {
  readonly actor: AccountActor;
  readonly lastEventId?: string;
  readonly signal: AbortSignal;
  readonly operation?: FeedStreamOperation;
}

export interface FeedStreamDependencies {
  readonly authenticate: (
    request: Request,
    operation?: FeedStreamOperation,
  ) => Promise<FeedStreamAuthentication>;
  readonly subscribe: (
    input: FeedSubscriptionInput,
  ) => EventIdSource | Promise<EventIdSource>;
  readonly load: (
    actor: AccountActor,
    eventId: string,
    operation?: FeedStreamOperation,
  ) => Promise<StreamSourceEvent | undefined>;
  readonly validateLastEventId?: (lastEventId: string) => void;
  readonly heartbeatMs?: number;
  readonly maxConsecutiveHeartbeats?: number;
  readonly maxEvents?: number;
  readonly monotonicNow?: () => number;
  readonly scheduleLifecycleAlarm?: (
    milliseconds: number,
    fire: () => void,
  ) => () => void;
}

export interface AuthorizedStreamEventReference {
  readonly cursor: string;
  readonly eventId: string;
  readonly [key: string]: unknown;
}

export interface StreamAuthorizedEventsInput {
  readonly lastEventId?: string;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly subscribe?: () => Promise<{ readonly close?: () => void | Promise<void> }>;
  readonly load: (input: {
    readonly after?: string;
    readonly limit: number;
  }) => Promise<readonly AuthorizedStreamEventReference[]>;
  readonly authorize: () => boolean | Promise<boolean>;
  readonly loadProtected?: (
    event: AuthorizedStreamEventReference,
  ) => Promise<AuthorizedStreamEventReference | undefined>;
  readonly emit: (event: AuthorizedStreamEventReference) => Promise<void>;
  readonly maxDurationMs: number;
  readonly signal?: AbortSignal;
  readonly stopWhenEmpty?: () => boolean;
  readonly pageSize?: number;
  readonly pollIntervalMs?: number;
}

export interface StreamAuthorizedEventsResult {
  readonly reason: "DURATION_BOUND" | "ABORTED" | "AUTHORIZATION_LOST" | "SOURCE_CLOSED";
  readonly lastEmittedCursor?: string;
}

function admissionLifetime(maxDurationMs: number): number {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= STREAM_SHUTDOWN_MARGIN_MS) {
    throw new Error("INVALID_SSE_DURATION");
  }
  return Math.min(
    STREAM_ADMISSION_CEILING_MS,
    maxDurationMs - STREAM_SHUTDOWN_MARGIN_MS,
  );
}

function boundedPositiveInteger(value: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(code);
  }
  return value;
}

function cursorPosition(cursor: string | undefined): bigint | undefined {
  if (cursor === undefined) return undefined;
  const match = /^sse\.v1:([1-9][0-9]*):[A-Za-z0-9][A-Za-z0-9._:-]*$/u.exec(cursor);
  return match ? BigInt(match[1]!) : undefined;
}

async function remainsAuthorized(
  authorize: StreamAuthorizedEventsInput["authorize"],
): Promise<boolean> {
  try {
    return await authorize();
  } catch {
    return false;
  }
}

/**
 * Runs the body-free replay/live admission loop. Callers may provide a
 * protected loader, but authorization is always checked immediately before
 * that load and again before emission.
 */
export async function streamAuthorizedEvents(
  input: StreamAuthorizedEventsInput,
): Promise<StreamAuthorizedEventsResult> {
  const startedAt = input.now();
  if (!Number.isFinite(startedAt)) throw new Error("INVALID_SSE_CLOCK");
  const admissionMs = admissionLifetime(input.maxDurationMs);
  const pageSize = boundedPositiveInteger(
    input.pageSize ?? STREAM_PAGE_SIZE,
    MAX_RESUME_EVENTS,
    "INVALID_SSE_PAGE_SIZE",
  );
  const pollIntervalMs = boundedPositiveInteger(
    input.pollIntervalMs ?? STREAM_IDLE_POLL_MS,
    STREAM_ADMISSION_CEILING_MS,
    "INVALID_SSE_POLL_INTERVAL",
  );
  const seen = new Set<string>(input.lastEventId ? [input.lastEventId] : []);
  let after = input.lastEventId;
  let afterPosition = cursorPosition(after);
  let lastEmittedCursor: string | undefined;
  let subscription: Awaited<ReturnType<NonNullable<typeof input.subscribe>>> | undefined;

  const result = (
    reason: StreamAuthorizedEventsResult["reason"],
  ): StreamAuthorizedEventsResult => Object.freeze({
    reason,
    ...(lastEmittedCursor === undefined ? {} : { lastEmittedCursor }),
  });
  const elapsed = () => input.now() - startedAt;

  try {
    if (elapsed() >= admissionMs) return result("DURATION_BOUND");
    if (input.signal?.aborted) return result("ABORTED");
    subscription = await input.subscribe?.();
    while (true) {
      if (elapsed() >= admissionMs) return result("DURATION_BOUND");
      if (input.signal?.aborted) return result("ABORTED");
      if (!await remainsAuthorized(input.authorize)) {
        return result("AUTHORIZATION_LOST");
      }

      const page = await input.load({ after, limit: pageSize });
      if (elapsed() >= admissionMs) return result("DURATION_BOUND");
      if (input.signal?.aborted) return result("ABORTED");
      if (page.length === 0) {
        if (input.stopWhenEmpty?.()) return result("SOURCE_CLOSED");
        const remaining = admissionMs - elapsed();
        if (remaining <= 0) return result("DURATION_BOUND");
        await input.sleep(Math.min(pollIntervalMs, remaining));
        continue;
      }

      for (const event of page) {
        if (elapsed() >= admissionMs) return result("DURATION_BOUND");
        if (input.signal?.aborted) return result("ABORTED");
        if (!isFeedEventId(event.cursor) || !isFeedEventId(event.eventId)) continue;

        const position = cursorPosition(event.cursor);
        if (position !== undefined && afterPosition !== undefined
            && position <= afterPosition) {
          continue;
        }
        after = event.cursor;
        afterPosition = position;
        if (seen.has(event.cursor)) continue;
        seen.add(event.cursor);

        if (!await remainsAuthorized(input.authorize)) {
          return result("AUTHORIZATION_LOST");
        }
        const protectedEvent = input.loadProtected
          ? await input.loadProtected(event)
          : event;
        if (!protectedEvent) continue;
        if (elapsed() >= admissionMs) return result("DURATION_BOUND");
        if (input.signal?.aborted) return result("ABORTED");
        if (!await remainsAuthorized(input.authorize)) {
          return result("AUTHORIZATION_LOST");
        }
        await input.emit(protectedEvent);
        lastEmittedCursor = event.cursor;
      }
    }
  } finally {
    await subscription?.close?.();
  }
}

interface FeedRequestLifecycle {
  readonly signal: AbortSignal;
  readonly operation: () => FeedStreamOperation;
  readonly remainingAdmissionMilliseconds: () => number;
  abort(): void;
  dispose(): void;
}

function nativeLifecycleAlarm(milliseconds: number, fire: () => void): () => void {
  const timer = setTimeout(fire, milliseconds);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function createFeedRequestLifecycle(input: {
  readonly dependencies: FeedStreamDependencies;
  readonly requestSignal: AbortSignal;
  readonly startedAt: number;
}): FeedRequestLifecycle {
  if (!Number.isFinite(input.startedAt)) throw new Error("INVALID_SSE_CLOCK");
  const monotonicNow = input.dependencies.monotonicNow ?? (() => performance.now());
  const admissionDeadline = input.startedAt + STREAM_ADMISSION_CEILING_MS;
  const databaseDeadline = input.startedAt + STREAM_DATABASE_CEILING_MS;
  const controller = new AbortController();
  let lastObserved = input.startedAt;
  let disposed = false;
  const observedNow = () => {
    const observed = monotonicNow();
    if (!Number.isFinite(observed) || observed < lastObserved) {
      throw new Error("INVALID_SSE_CLOCK");
    }
    lastObserved = observed;
    return observed;
  };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("SSE_DURATION_BOUND"));
    }
  };
  const abortFromRequest = () => abort();
  if (input.requestSignal.aborted) abort();
  else input.requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  const schedule = input.dependencies.scheduleLifecycleAlarm ?? nativeLifecycleAlarm;
  const cancelAlarm = controller.signal.aborted
    ? () => undefined
    : schedule(STREAM_ADMISSION_CEILING_MS, abort);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAlarm();
    input.requestSignal.removeEventListener("abort", abortFromRequest);
  };
  const remainingDatabaseMilliseconds = () => (
    controller.signal.aborted ? 0 : databaseDeadline - observedNow()
  );
  return Object.freeze({
    signal: controller.signal,
    abort,
    dispose,
    remainingAdmissionMilliseconds: () => (
      controller.signal.aborted ? 0 : admissionDeadline - observedNow()
    ),
    operation: () => Object.freeze({
      signal: controller.signal,
      deadlineMonotonicMs: databaseDeadline,
      remainingMilliseconds: remainingDatabaseMilliseconds,
    }),
  });
}

function streamDeadlineError(): Error {
  return new Error("SSE_DURATION_BOUND");
}

function streamTransactionBudget(operation: FeedStreamOperation): DatabaseTransactionBudget {
  return Object.freeze({
    remainingMilliseconds: operation.remainingMilliseconds,
    expirationError: streamDeadlineError,
    maximumConnectionMilliseconds: STREAM_DATABASE_CONNECTION_MS,
    maximumQueryMilliseconds: STREAM_DATABASE_QUERY_MS,
    minimumOperationHeadroomMilliseconds: STREAM_DATABASE_HEADROOM_MS,
  });
}

async function streamDatabaseTransaction<Result>(
  operation: FeedStreamOperation,
  work: (database: EventDatabase) => Promise<Result>,
): Promise<Result> {
  if (operation.signal.aborted || operation.remainingMilliseconds() <= 0) {
    throw streamDeadlineError();
  }
  const result = await getDatabase({
    transactionBudget: streamTransactionBudget(operation),
  }).transaction(work);
  if (operation.signal.aborted || operation.remainingMilliseconds() <= 0) {
    throw streamDeadlineError();
  }
  return result;
}

function streamDatabase(operation: FeedStreamOperation): EventDatabase {
  return {
    query: (sql, parameters = []) => streamDatabaseTransaction(
      operation,
      (database) => database.query(sql, parameters),
    ),
    one: (sql, parameters = []) => streamDatabaseTransaction(
      operation,
      (database) => database.one(sql, parameters),
    ),
    transaction: (work) => streamDatabaseTransaction(operation, work),
  };
}

interface EventRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string | null;
  readonly type: string;
  readonly visibility: string;
  readonly occurred_at: Date | string;
}

function privateHeaders(contentType = "application/json; charset=utf-8"): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
}

function cookieToken(request: Request, environment: string): string {
  const name = sessionCookieName(environment);
  for (const segment of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    const token = segment.slice(separator + 1).trim();
    if (token.length > 0) return token;
  }
  throw new Error("SESSION_REQUIRED");
}

function protectedText(body: JsonValue): string | undefined {
  if (typeof body === "string") return body;
  if (!body || Array.isArray(body) || typeof body !== "object") return undefined;
  if (typeof body.text === "string") return body.text;
  return typeof body.body === "string" ? body.body : undefined;
}

export async function loadStreamEvent(
  database: EventDatabase,
  actor: AccountActor,
  cursorOrEventId: string,
): Promise<StreamSourceEvent | undefined> {
  let cursor: ReturnType<typeof parseStreamCursor> | undefined;
  try {
    cursor = parseStreamCursor(cursorOrEventId);
  } catch {
    // Direct event-ID loading remains available to injected/internal callers;
    // production Last-Event-ID and pub/sub inputs are cursor-validated.
  }
  const rows = cursor
    ? await database.query<EventRow>(
      `select e.id::text,e.account_id::text,e.type,e.visibility,e.occurred_at
        from stream_outbox_deliveries delivery
         join events e on e.id=delivery.event_id
        where delivery.stream_position=$1::bigint and delivery.event_id=$2::uuid
          and (e.visibility='PUBLIC'
            or (e.account_id=$3 and e.visibility in ('PRIVATE_ACCOUNT','SHARED')))
        limit 1`,
      [cursor.position, cursor.eventId, actor.accountId],
    )
    : await database.query<EventRow>(
      `select e.id::text,e.account_id::text,e.type,e.visibility,e.occurred_at
         from events e
        where e.id::text=$1
          and (e.visibility='PUBLIC'
            or (e.account_id=$2 and e.visibility in ('PRIVATE_ACCOUNT','SHARED')))
        limit 1`,
      [cursorOrEventId, actor.accountId],
    );
  const row = rows[0];
  if (!row) return undefined;
  const text = row.visibility === "PUBLIC"
    ? undefined
    : protectedText(await readEventBody(database, row.id, { actor }));
  return Object.freeze({
    id: row.id,
    ...(cursor ? { cursorId: cursorOrEventId } : {}),
    accountId: row.account_id,
    type: row.type,
    visibility: row.visibility,
    createdAt: new Date(row.occurred_at).toISOString(),
    topic: row.type,
    protectedText: text,
  });
}

export async function* resumeEventIds(
  database: EventDatabase,
  actor: AccountActor,
  lastEventId: string | undefined,
): AsyncGenerator<string> {
  if (!lastEventId) return;
  let cursor = parseStreamCursor(lastEventId);
  const authority = await database.query(
    `/* stream-resume-cursor-authority */
     select 1 authorized
       from stream_outbox_deliveries
      where stream_position=$1::bigint and event_id=$2::uuid
      limit 1`,
    [cursor.position, cursor.eventId],
  );
  if (authority.length !== 1) throw new Error("INVALID_LAST_EVENT_ID");
  while (true) {
    const rows = await database.query<{
      readonly id: string;
      readonly stream_position: string;
    }>(
      `select e.id::text id,delivery.stream_position::text
         from stream_outbox_deliveries delivery
         join events e on e.id=delivery.event_id
        where delivery.stream_position>$1::bigint
          and (e.visibility='PUBLIC'
            or (e.account_id=$2 and e.visibility in ('PRIVATE_ACCOUNT','SHARED')))
        order by delivery.stream_position
        limit $3`,
      [cursor.position, actor.accountId, MAX_RESUME_EVENTS],
    );
    for (const { id, stream_position: position } of rows) {
      const next = formatStreamCursor(position, id);
      if (BigInt(position) <= BigInt(cursor.position)) {
        throw new Error("INVALID_COMMITTED_EVENT_ID");
      }
      yield next;
    }
    if (rows.length < MAX_RESUME_EVENTS) return;
    cursor = parseStreamCursor(formatStreamCursor(
      rows.at(-1)!.stream_position, rows.at(-1)!.id,
    ));
  }
}

function productionSubscription(input: FeedSubscriptionInput): EventIdSource {
  const closed = new AbortController();
  let activeClient: { readonly isOpen: boolean; destroy(): void } | undefined;
  const destroyActiveClient = () => {
    if (activeClient?.isOpen) activeClient.destroy();
  };
  return {
    close() {
      closed.abort();
      destroyActiveClient();
    },
    async *[Symbol.asyncIterator]() {
      const url = process.env.VALKEY_URL;
      if (!url) throw new Error("VALKEY_URL_REQUIRED");
      const operation = input.operation;
      if (!operation) throw new Error("SSE_OPERATION_REQUIRED");
      if (input.signal.aborted || closed.signal.aborted) return;
      const connectTimeout = Math.min(
        STREAM_DATABASE_CONNECTION_MS,
        Math.floor(operation.remainingMilliseconds() - STREAM_DATABASE_HEADROOM_MS),
      );
      if (connectTimeout <= 0) throw streamDeadlineError();

      const client = createClient({
        url,
        socket: { connectTimeout, reconnectStrategy: false },
      });
      activeClient = client;
      client.on("error", () => undefined);
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let overflowed = false;
      const wakeReader = () => {
        const current = wake;
        wake = undefined;
        current?.();
      };
      const abort = () => {
        destroyActiveClient();
        wakeReader();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      closed.signal.addEventListener("abort", abort, { once: true });
      try {
        await client.connect();
        if (input.signal.aborted || closed.signal.aborted) return;
        await client.subscribe(STREAM_EVENT_CHANNEL, (message) => {
          // The channel contract is an opaque committed stream cursor. JSON
          // payloads, whitespace, and all body-shaped messages are discarded.
          if (!isFeedEventId(message)) return;
          try {
            parseStreamCursor(message);
          } catch {
            return;
          }
          if (queue.length >= MAX_PENDING_EVENT_IDS) {
            overflowed = true;
            wakeReader();
            return;
          }
          queue.push(message);
          wakeReader();
        });
        if (input.signal.aborted || closed.signal.aborted) return;
        for await (const id of resumeEventIds(
          streamDatabase(operation), input.actor, input.lastEventId,
        )) {
          if (input.signal.aborted || closed.signal.aborted) return;
          yield id;
        }
        while (!input.signal.aborted && !closed.signal.aborted && !overflowed) {
          const id = queue.shift();
          if (id !== undefined) {
            yield id;
            continue;
          }
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally {
        input.signal.removeEventListener("abort", abort);
        closed.signal.removeEventListener("abort", abort);
        if (client.isOpen) client.destroy();
        if (activeClient === client) activeClient = undefined;
      }
    },
  };
}

function eventIdIterator(source: EventIdSource): AsyncIterator<string> {
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]();
  const iterator = source[Symbol.iterator]();
  return {
    async next() {
      return iterator.next();
    },
    async return() {
      return iterator.return?.() ?? { done: true, value: undefined };
    },
  };
}

async function sleepUntilOrAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function durationBoundedEventIds(input: {
  readonly dependencies: FeedStreamDependencies;
  readonly authentication: FeedStreamAuthentication;
  readonly lastEventId?: string;
  readonly lifecycle: FeedRequestLifecycle;
}): EventIdSource {
  const queue: string[] = [];
  const readers: Array<(result: IteratorResult<string>) => void> = [];
  const writers: Array<() => void> = [];
  let source: EventIdSource | undefined;
  let iterator: AsyncIterator<string> | undefined;
  let sourceReady: Promise<void> | undefined;
  let sourceExhausted = false;
  let started = false;
  let finished = false;
  let finalization: Promise<void> | undefined;
  let producer: Promise<void> | undefined;

  const wakeWriter = () => writers.shift()?.();
  const wakeWriters = () => {
    while (writers.length > 0) writers.shift()!();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    input.lifecycle.signal.removeEventListener("abort", abortProducer);
    while (readers.length > 0) readers.shift()!({ done: true, value: undefined });
    wakeWriters();
  };

  const finalizeSource = (): Promise<void> => {
    finalization ??= (async () => {
      try {
        await sourceReady;
        await source?.close?.();
      } finally {
        await iterator?.return?.();
      }
    })();
    return finalization;
  };
  const abortProducer = () => {
    wakeWriters();
    void finalizeSource().catch(() => undefined);
  };
  input.lifecycle.signal.addEventListener("abort", abortProducer, { once: true });

  const enqueue = async (eventId: string): Promise<void> => {
    while (!finished
        && !input.lifecycle.signal.aborted
        && queue.length >= MAX_PENDING_EVENT_IDS) {
      await new Promise<void>((resolve) => writers.push(resolve));
    }
    if (finished || input.lifecycle.signal.aborted) return;
    const reader = readers.shift();
    if (reader) reader({ done: false, value: eventId });
    else queue.push(eventId);
  };

  const start = () => {
    if (started) return;
    started = true;
    if (input.lifecycle.signal.aborted) {
      finish();
      return;
    }
    const monotonicNow = input.dependencies.monotonicNow ?? (() => performance.now());
    const remainingAdmissionMs = Math.floor(input.lifecycle.remainingAdmissionMilliseconds());
    if (remainingAdmissionMs < 1) {
      input.lifecycle.abort();
      finish();
      return;
    }
    const authorize = () => input.authentication.revalidate(input.lifecycle.operation());
    producer = streamAuthorizedEvents({
      lastEventId: input.lastEventId,
      now: monotonicNow,
      sleep: (milliseconds) => sleepUntilOrAbort(milliseconds, input.lifecycle.signal),
      subscribe: async () => {
        const admittedSubscription = input.dependencies.subscribe({
          actor: input.authentication.actor,
          ...(input.lastEventId === undefined ? {} : { lastEventId: input.lastEventId }),
          signal: input.lifecycle.signal,
          operation: input.lifecycle.operation(),
        });
        sourceReady = Promise.resolve(admittedSubscription).then((nextSource) => {
          source = nextSource;
          iterator = eventIdIterator(nextSource);
        });
        await sourceReady;
        return { close: finalizeSource };
      },
      load: async () => {
        if (!iterator) throw new Error("SSE_SUBSCRIPTION_REQUIRED");
        const next = await iterator.next();
        if (next.done) {
          sourceExhausted = true;
          return [];
        }
        return [{ cursor: next.value, eventId: next.value }];
      },
      authorize,
      emit: async (event) => enqueue(event.cursor),
      maxDurationMs: remainingAdmissionMs + STREAM_SHUTDOWN_MARGIN_MS,
      signal: input.lifecycle.signal,
      stopWhenEmpty: () => sourceExhausted,
    }).then(() => undefined, () => undefined).finally(() => {
      finish();
    });
  };

  const close = async () => {
    input.lifecycle.abort();
    wakeWriters();
    if (producer) await producer;
    else await finalizeSource();
    finish();
  };

  return Object.freeze({
    close,
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          start();
          const value = queue.shift();
          if (value !== undefined) {
            wakeWriter();
            return { done: false, value };
          }
          if (finished) return { done: true, value: undefined };
          return new Promise<IteratorResult<string>>((resolve) => readers.push(resolve));
        },
        async return(): Promise<IteratorResult<string>> {
          await close();
          return { done: true, value: undefined };
        },
      };
    },
  });
}

async function productionAuthentication(
  request: Request,
  operation?: FeedStreamOperation,
): Promise<FeedStreamAuthentication> {
  if (!operation) throw new Error("SSE_OPERATION_REQUIRED");
  const environment = process.env.NODE_ENV ?? "development";
  const token = cookieToken(request, environment);
  const session = await authenticateSession(streamDatabase(operation), token);
  const actor: AccountActor = { role: "ACCOUNT", accountId: session.accountId };
  return Object.freeze({
    actor,
    async revalidate(nextOperation?: FeedStreamOperation) {
      if (!nextOperation) return false;
      try {
        const current = await authenticateSession(streamDatabase(nextOperation), token);
        return current.sessionId === session.sessionId
          && current.accountId === session.accountId;
      } catch {
        return false;
      }
    },
  });
}

const productionDependencies: FeedStreamDependencies = {
  authenticate: productionAuthentication,
  subscribe: productionSubscription,
  load: (actor, eventId, operation) => {
    if (!operation) throw new Error("SSE_OPERATION_REQUIRED");
    return streamDatabaseTransaction(
      operation,
      (database) => loadStreamEvent(database, actor, eventId),
    );
  },
  validateLastEventId: (lastEventId) => { parseStreamCursor(lastEventId); },
};

function routeFailure(error: unknown): Response {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (code === "SESSION_REQUIRED" || code === "SESSION_INVALID"
      || code === "INVALID_OPAQUE_TOKEN") {
    return Response.json({ error: "UNAUTHORIZED" }, {
      status: 401,
      headers: privateHeaders(),
    });
  }
  if (code === "INVALID_LAST_EVENT_ID") {
    return Response.json({ error: code }, { status: 400, headers: privateHeaders() });
  }
  return Response.json({ error: "FEED_STREAM_FAILED" }, {
    status: 500,
    headers: privateHeaders(),
  });
}

export function createFeedStreamHandler(
  dependencies: FeedStreamDependencies = productionDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const requestStartedAt = (dependencies.monotonicNow ?? (() => performance.now()))();
    let lifecycle: FeedRequestLifecycle;
    try {
      lifecycle = createFeedRequestLifecycle({
        dependencies,
        requestSignal: request.signal,
        startedAt: requestStartedAt,
      });
    } catch (error) {
      return routeFailure(error);
    }
    try {
      const lastEventId = request.headers.get("Last-Event-ID") ?? undefined;
      if (lastEventId !== undefined && !isFeedEventId(lastEventId)) {
        throw new Error("INVALID_LAST_EVENT_ID");
      }
      if (lastEventId !== undefined) dependencies.validateLastEventId?.(lastEventId);
      const authentication = await dependencies.authenticate(request, lifecycle.operation());
      const eventIds = durationBoundedEventIds({
        dependencies,
        authentication,
        ...(lastEventId === undefined ? {} : { lastEventId }),
        lifecycle,
      });
      const authorize = () => authentication.revalidate(lifecycle.operation());
      const stream = openFeedStream({
        actor: authentication.actor,
        eventIds,
        load: (eventId) => dependencies.load(
          authentication.actor,
          eventId,
          lifecycle.operation(),
        ),
        revalidate: authorize,
        abort: lifecycle.abort,
        onResponseSettled: lifecycle.dispose,
        lastEventId,
        signal: lifecycle.signal,
        heartbeatMs: dependencies.heartbeatMs,
        maxConsecutiveHeartbeats: dependencies.maxConsecutiveHeartbeats,
        maxEvents: dependencies.maxEvents,
      });
      return new Response(stream.readable(), {
        headers: stream.headers,
      });
    } catch (error) {
      lifecycle.abort();
      lifecycle.dispose();
      return routeFailure(error);
    }
  };
}

export const GET = createFeedStreamHandler();
