import { createClient } from "redis";
import {
  authenticateSession,
  sessionCookieName,
} from "../../../../lib/server/auth/sessions";
import type { ActorContext } from "../../../../lib/server/auth/authorize";
import { getDatabase } from "../../../../lib/server/db/postgres";
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

type AccountActor = Extract<ActorContext, { readonly role: "ACCOUNT" }>;

export interface FeedStreamAuthentication {
  readonly actor: AccountActor;
  readonly revalidate: () => boolean | Promise<boolean>;
}

export interface FeedSubscriptionInput {
  readonly actor: AccountActor;
  readonly lastEventId?: string;
  readonly signal: AbortSignal;
}

export interface FeedStreamDependencies {
  readonly authenticate: (request: Request) => Promise<FeedStreamAuthentication>;
  readonly subscribe: (
    input: FeedSubscriptionInput,
  ) => EventIdSource | Promise<EventIdSource>;
  readonly load: (
    actor: AccountActor,
    eventId: string,
  ) => Promise<StreamSourceEvent | undefined>;
  readonly validateLastEventId?: (lastEventId: string) => void;
  readonly heartbeatMs?: number;
  readonly maxConsecutiveHeartbeats?: number;
  readonly maxEvents?: number;
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
  return {
    close() {
      closed.abort();
    },
    async *[Symbol.asyncIterator]() {
      const url = process.env.VALKEY_URL;
      if (!url) throw new Error("VALKEY_URL_REQUIRED");
      if (input.signal.aborted || closed.signal.aborted) return;

      const client = createClient({
        url,
        socket: { connectTimeout: 5_000, reconnectStrategy: false },
      });
      client.on("error", () => undefined);
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let overflowed = false;
      const wakeReader = () => {
        const current = wake;
        wake = undefined;
        current?.();
      };
      const abort = () => wakeReader();
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
          getDatabase(), input.actor, input.lastEventId,
        )) {
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
        try {
          if (client.isOpen) await client.unsubscribe(STREAM_EVENT_CHANNEL);
        } finally {
          if (client.isOpen) await client.quit();
        }
      }
    },
  };
}

async function productionAuthentication(request: Request): Promise<FeedStreamAuthentication> {
  const environment = process.env.NODE_ENV ?? "development";
  const database = getDatabase();
  const token = cookieToken(request, environment);
  const session = await authenticateSession(database, token);
  const actor: AccountActor = { role: "ACCOUNT", accountId: session.accountId };
  return Object.freeze({
    actor,
    async revalidate() {
      try {
        const current = await authenticateSession(database, token);
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
  load: (actor, eventId) => loadStreamEvent(getDatabase(), actor, eventId),
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
    try {
      const lastEventId = request.headers.get("Last-Event-ID") ?? undefined;
      if (lastEventId !== undefined && !isFeedEventId(lastEventId)) {
        throw new Error("INVALID_LAST_EVENT_ID");
      }
      if (lastEventId !== undefined) dependencies.validateLastEventId?.(lastEventId);
      const authentication = await dependencies.authenticate(request);
      const eventIds = await dependencies.subscribe({
        actor: authentication.actor,
        lastEventId,
        signal: request.signal,
      });
      const stream = openFeedStream({
        actor: authentication.actor,
        eventIds,
        load: (eventId) => dependencies.load(authentication.actor, eventId),
        revalidate: authentication.revalidate,
        lastEventId,
        signal: request.signal,
        heartbeatMs: dependencies.heartbeatMs,
        maxConsecutiveHeartbeats: dependencies.maxConsecutiveHeartbeats,
        maxEvents: dependencies.maxEvents,
      });
      return new Response(stream.readable(), { headers: stream.headers });
    } catch (error) {
      return routeFailure(error);
    }
  };
}

export const GET = createFeedStreamHandler();
