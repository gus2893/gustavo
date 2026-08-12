import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  formatStreamCursor,
  openFeedStream,
  parseStreamCursor,
  type EventIdSource,
} from "../../lib/server/stream/events";
import {
  createFeedStreamHandler,
  loadStreamEvent,
  resumeEventIds,
} from "../../app/api/feed/stream/route";
import { appendEvent } from "../../lib/server/events/store";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  publishNextCommittedEvent,
  startCommittedEventPublisher,
  STREAM_EVENT_CHANNEL,
} from "../../worker/stream/publish-events";
import { testContext } from "../helpers/postgres";

const fixtures: Record<string, { id: string; visibility: string; accountId?: string; text?: string }> = {
  "public-1": { id: "public-1", visibility: "PUBLIC" },
  "private-a": { id: "private-a", visibility: "PRIVATE_ACCOUNT", accountId: "acct-a", text: "private-a text" },
  "private-b": { id: "private-b", visibility: "PRIVATE_ACCOUNT", accountId: "acct-b", text: "private-b text" },
};

describe("authorized SSE feed", () => {
  it("reloads and projects event IDs instead of trusting fan-out payloads", async () => {
    const loaded: string[] = [];
    const stream = openFeedStream({
      actor: { role: "ACCOUNT", accountId: "acct-a" },
      eventIds: ["public-1", "private-a", "private-b"],
      load: async (id) => { loaded.push(id); return fixtures[id]; },
    });
    const items = await stream.collect();
    expect(loaded).toEqual(["public-1", "private-a", "private-b"]);
    expect(items.map((item) => item.id)).toEqual(["public-1", "private-a"]);
    expect(JSON.stringify(items)).not.toContain("private-b text");
    expect(stream.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("resumes after Last-Event-ID and emits independently framed minimum DTOs", async () => {
    const stream = openFeedStream({
      actor: { role: "ACCOUNT", accountId: "acct-a" },
      eventIds: ["public-1", "private-a"],
      lastEventId: "public-1",
      load: async (id) => ({
        ...fixtures[id],
        type: "brain.response.completed",
        createdAt: "2026-08-12T12:00:00.000Z",
        topic: "AAPL",
        internalDiagnostic: "do not emit",
      }),
    });

    const frames = await stream.collectFrames();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("id: private-a\n");
    expect(frames[0]).toContain("event: feed\n");
    expect(frames[0]).toContain('"text":"private-a text"');
    expect(frames[0]).not.toContain("internalDiagnostic");
    expect(frames[0]?.endsWith("\n\n")).toBe(true);
  });

  it("revalidates around every reload and closes before a revoked session can emit", async () => {
    const loaded: string[] = [];
    let checks = 0;
    const stream = openFeedStream({
      actor: { role: "ACCOUNT", accountId: "acct-a" },
      eventIds: ["private-a", "public-1"],
      load: async (id) => { loaded.push(id); return fixtures[id]; },
      revalidate: async () => {
        checks += 1;
        return checks <= 2;
      },
    });

    expect((await stream.collect()).map(({ id }) => id)).toEqual(["private-a"]);
    expect(loaded).toEqual(["private-a"]);
    expect(checks).toBe(3);
  });

  it("accepts event IDs only, rejecting payload-shaped fan-out messages before reload", async () => {
    const load = vi.fn(async () => fixtures["private-a"]);
    const stream = openFeedStream({
      actor: { role: "ACCOUNT", accountId: "acct-a" },
      eventIds: ['{"eventId":"private-a","text":"protected fan-out body"}'],
      load,
    });

    expect(await stream.collect()).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("bounds idle heartbeats and releases the subscription", async () => {
    let released = false;
    let closed = false;
    const idle: EventIdSource = {
      close() {
        closed = true;
      },
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => undefined),
          async return() {
            released = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const stream = openFeedStream({
      actor: { role: "ACCOUNT", accountId: "acct-a" },
      eventIds: idle,
      load: async () => undefined,
      heartbeatMs: 1,
      maxConsecutiveHeartbeats: 2,
    });

    expect(await stream.collectFrames()).toEqual([": heartbeat\n\n", ": heartbeat\n\n"]);
    expect(closed).toBe(true);
    expect(released).toBe(true);
  });

  it("cancels pending subscriptions without emitting or retaining resources", async () => {
    let released = false;
    const pending: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => undefined),
          async return() {
            released = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const controller = new AbortController();
    const stream = openFeedStream({
      actor: { role: "ACCOUNT", accountId: "acct-a" },
      eventIds: pending,
      load: async () => undefined,
      signal: controller.signal,
      heartbeatMs: 60_000,
    });
    const iterator = stream.frames()[Symbol.asyncIterator]();

    controller.abort();

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(released).toBe(true);
  });

  it("authenticates the route, forwards the resume cursor, and returns hardened SSE headers", async () => {
    const subscribe = vi.fn(() => ["private-a"] as const);
    const handler = createFeedStreamHandler({
      authenticate: async () => ({
        actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
        revalidate: async () => true,
      }),
      subscribe,
      load: async (_actor, id) => fixtures[id],
      heartbeatMs: 5,
    });
    const response = await handler(new Request("http://localhost:3000/api/feed/stream", {
      headers: {
        cookie: "gustavo-session=session-token",
        "Last-Event-ID": "public-1",
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({
      lastEventId: "public-1",
    }));
    expect(await response.text()).toContain("id: private-a");
  });

  it("rejects unauthenticated connections without subscribing", async () => {
    const subscribe = vi.fn(() => [] as const);
    const handler = createFeedStreamHandler({
      authenticate: async () => { throw new Error("SESSION_INVALID"); },
      subscribe,
      load: async () => undefined,
    });

    const response = await handler(new Request("http://localhost:3000/api/feed/stream"));

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("paginates resume replay beyond one bounded page without skipping IDs", async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: `00000000-0000-7000-8000-${String(index + 2).padStart(12, "0")}`,
      stream_position: String(index + 2),
    }));
    const cursors: string[] = [];
    let database!: EventDatabase;
    database = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters: readonly unknown[] = [],
      ): Promise<Row[]> {
        if (sql.includes("stream-resume-cursor-authority")) {
          return [{ authorized: 1 }] as unknown as Row[];
        }
        const cursor = String(parameters[0]);
        const limit = Number(parameters[2]);
        cursors.push(cursor);
        return rows.filter(({ stream_position }) => BigInt(stream_position) > BigInt(cursor))
          .slice(0, limit) as unknown as Row[];
      },
      async one(): Promise<never> {
        throw new Error("not used");
      },
      transaction: async (work) => work(database),
    };

    const replayed: string[] = [];
    for await (const id of resumeEventIds(
      database,
      { role: "ACCOUNT", accountId: "acct-a" },
      formatStreamCursor("1", "00000000-0000-7000-8000-000000000001"),
    )) replayed.push(id);

    expect(replayed).toEqual(rows.map(({ id, stream_position }) => (
      formatStreamCursor(stream_position, id)
    )));
    expect(cursors).toEqual(["1", "101", "201"]);
  });

  it("publishes committed IDs from the durable outbox into SSE without pubsub bodies", async () => {
    const { db } = await testContext();
    const protectedBody = "protected body must never enter pubsub";
    const event = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: protectedBody, topic: "AAPL" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    const messages: Array<{ readonly channel: string; readonly value: string }> = [];

    const result = await publishNextCommittedEvent({
      db,
      workerId: "stream-test-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
      publish: async (channel, value) => { messages.push({ channel, value }); },
    });

    expect(result).toBe("COMPLETED");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.channel).toBe(STREAM_EVENT_CHANNEL);
    const committedCursor = parseStreamCursor(messages[0]!.value);
    expect(committedCursor.eventId).toBe(event.id);
    expect(JSON.stringify(messages)).not.toContain(protectedBody);
    expect(await db.one<{ status: string }>(
      "select status from transactional_outbox where event_id=$1",
      [event.id],
    )).toEqual({ status: "PENDING" });
    expect(await db.one<{ status: string }>(
      "select status from stream_outbox_deliveries where event_id=$1",
      [event.id],
    )).toEqual({ status: "COMPLETED" });

    const accountActor = { role: "ACCOUNT" as const, accountId: randomUUID() };
    expect(await loadStreamEvent(
      db,
      accountActor,
      formatStreamCursor(committedCursor.position, randomUUID()),
    )).toBeUndefined();
    const handler = createFeedStreamHandler({
      authenticate: async () => ({
        actor: accountActor,
        revalidate: async () => true,
      }),
      subscribe: () => messages.map(({ value }) => value),
      load: (actor, eventId) => loadStreamEvent(db, actor, eventId),
    });
    const response = await handler(new Request("http://localhost:3000/api/feed/stream"));
    const responseText = await response.text();

    expect(responseText).toContain(`id: ${messages[0]!.value}`);
    expect(responseText).not.toContain(protectedBody);
    expect(responseText).toContain('"placeholder":true');
  }, 30_000);

  it("retries transient publish failures and rejects body-shaped outbox authority", async () => {
    const { db } = await testContext();
    const retryEvent = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "retry body" },
      idempotencyKey: `stream:${randomUUID()}`,
    });

    expect(await publishNextCommittedEvent({
      db,
      workerId: "stream-retry-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
      publish: async () => { throw new Error("VALKEY_UNAVAILABLE"); },
    })).toBe("RETRY_SCHEDULED");
    expect(await db.one<{ status: string; attempts: number }>(
      "select status,attempts from stream_outbox_deliveries where event_id=$1",
      [retryEvent.id],
    )).toEqual({ status: "RETRY_SCHEDULED", attempts: 1 });
    await db.query(
      "update stream_outbox_deliveries set available_at=clock_timestamp()-interval '1 second' where event_id=$1",
      [retryEvent.id],
    );
    const retried: string[] = [];
    expect(await publishNextCommittedEvent({
      db,
      workerId: "stream-retry-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
      publish: async (_channel, eventId) => { retried.push(eventId); },
    })).toBe("COMPLETED");
    expect(retried.map((cursor) => parseStreamCursor(cursor).eventId)).toEqual([retryEvent.id]);

    const forged = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "database protected body" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    await db.query(
      `update transactional_outbox
          set payload=jsonb_build_object('eventId',event_id::text,'text','forged pubsub body')
        where event_id=$1`,
      [forged.id],
    );
    const leaked: string[] = [];
    expect(await publishNextCommittedEvent({
      db,
      workerId: "stream-retry-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
      publish: async (_channel, value) => { leaked.push(value); },
    })).toBe("FAILED");
    expect(leaked).toEqual([]);
    expect(await db.one<{ status: string; error_code: string }>(
      "select status,error_code from stream_outbox_deliveries where event_id=$1",
      [forged.id],
    )).toEqual({ status: "FAILED", error_code: "STREAM_OUTBOX_AUTHORITY_INVALID" });
    expect(await db.one<{ status: string }>(
      "select status from transactional_outbox where event_id=$1",
      [forged.id],
    )).toEqual({ status: "PENDING" });
  }, 30_000);

  it("replays a lower event UUID that commits after a higher UUID was delivered", async () => {
    const { db } = await testContext();
    let staged!: () => void;
    let release!: () => void;
    const stagedPromise = new Promise<void>((resolve) => { staged = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let lowerEventId = "";
    const lowerCommit = db.transaction(async (transaction) => {
      const event = await appendEvent(transaction, {
        aggregateId: `stream:${randomUUID()}`,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        type: "commentary.published",
        visibility: "PUBLIC",
        body: { text: "lower UUID commits second" },
        idempotencyKey: `stream:${randomUUID()}`,
      });
      lowerEventId = event.id;
      staged();
      await releasePromise;
    });
    await stagedPromise;
    const higher = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "higher UUID commits first" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    expect(lowerEventId < higher.id).toBe(true);

    const published: string[] = [];
    expect(await publishNextCommittedEvent({
      db,
      workerId: "stream-order-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
      publish: async (_channel, cursor) => { published.push(cursor); },
    })).toBe("COMPLETED");
    release();
    await lowerCommit;
    expect(await publishNextCommittedEvent({
      db,
      workerId: "stream-order-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
      publish: async (_channel, cursor) => { published.push(cursor); },
    })).toBe("COMPLETED");

    expect(published[0]).not.toBe(higher.id);
    expect(published[1]).not.toBe(lowerEventId);
    const replayed: string[] = [];
    for await (const cursor of resumeEventIds(
      db,
      { role: "ACCOUNT", accountId: randomUUID() },
      published[0],
    )) replayed.push(cursor);
    expect(replayed).toEqual([published[1]]);
  }, 30_000);

  it("replays an allocated cursor while fanout completion is still in flight", async () => {
    const { db } = await testContext();
    const actor = { role: "ACCOUNT" as const, accountId: randomUUID() };
    const prior = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "prior event" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    let priorCursor = "";
    expect(await publishNextCommittedEvent({
      db, workerId: "stream-window-worker", leaseMs: 5_000, maxAttempts: 3,
      publish: async (_channel, cursor) => { priorCursor = cursor; },
    })).toBe("COMPLETED");
    expect(parseStreamCursor(priorCursor).eventId).toBe(prior.id);

    const current = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "published before completion" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    let observed!: () => void;
    let release!: () => void;
    const observedPromise = new Promise<void>((resolve) => { observed = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let currentCursor = "";
    const inFlight = publishNextCommittedEvent({
      db, workerId: "stream-window-worker", leaseMs: 5_000, maxAttempts: 3,
      publish: async (_channel, cursor) => {
        currentCursor = cursor;
        observed();
        await releasePromise;
      },
    });
    await observedPromise;
    expect(parseStreamCursor(currentCursor).eventId).toBe(current.id);
    const replayed: string[] = [];
    for await (const cursor of resumeEventIds(db, actor, priorCursor)) replayed.push(cursor);
    release();
    expect(await inFlight).toBe("COMPLETED");

    expect(replayed).toEqual([currentCursor]);
  }, 30_000);

  it("keeps terminal fanout failures available through durable reconnect replay", async () => {
    const { db } = await testContext();
    const actor = { role: "ACCOUNT" as const, accountId: randomUUID() };
    const prior = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "prior durable cursor" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    let priorCursor = "";
    expect(await publishNextCommittedEvent({
      db, workerId: "stream-terminal-worker", leaseMs: 5_000, maxAttempts: 3,
      publish: async (_channel, cursor) => { priorCursor = cursor; },
    })).toBe("COMPLETED");
    expect(parseStreamCursor(priorCursor).eventId).toBe(prior.id);

    const failed = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "recover through replay" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    await db.query(
      `update transactional_outbox
          set payload=jsonb_build_object('eventId',event_id::text,'text','never publish this body')
        where event_id=$1`,
      [failed.id],
    );
    expect(await publishNextCommittedEvent({
      db, workerId: "stream-terminal-worker", leaseMs: 5_000, maxAttempts: 3,
      publish: async () => { throw new Error("must not publish forged authority"); },
    })).toBe("FAILED");
    const failedPosition = await db.one<{ stream_position: string }>(
      "select stream_position::text from stream_outbox_deliveries where event_id=$1",
      [failed.id],
    );
    const failedCursor = formatStreamCursor(failedPosition.stream_position, failed.id);
    const replayed: string[] = [];
    for await (const cursor of resumeEventIds(db, actor, priorCursor)) replayed.push(cursor);

    expect(replayed).toEqual([failedCursor]);
  }, 30_000);

  it("keeps a delivered cursor valid after ambiguous completion failure", async () => {
    const { db } = await testContext();
    const actor = { role: "ACCOUNT" as const, accountId: randomUUID() };
    const ambiguous = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "delivered before completion ambiguity" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    let observedCursor = "";
    expect(await publishNextCommittedEvent({
      db, workerId: "stream-ambiguous-worker", leaseMs: 5_000, maxAttempts: 2,
      publish: async (_channel, cursor) => {
        observedCursor = cursor;
        await db.query(
          "update stream_outbox_deliveries set lease_until=clock_timestamp()-interval '1 second' where event_id=$1",
          [ambiguous.id],
        );
      },
    })).toBe("LEASE_LOST");
    expect(parseStreamCursor(observedCursor).eventId).toBe(ambiguous.id);
    expect(await publishNextCommittedEvent({
      db, workerId: "stream-ambiguous-worker", leaseMs: 5_000, maxAttempts: 2,
      publish: async () => { throw new Error("ambiguous redis outcome"); },
    })).toBe("FAILED");

    const later = await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "later event" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    let laterCursor = "";
    expect(await publishNextCommittedEvent({
      db, workerId: "stream-ambiguous-worker", leaseMs: 5_000, maxAttempts: 2,
      publish: async (_channel, cursor) => { laterCursor = cursor; },
    })).toBe("COMPLETED");
    expect(parseStreamCursor(laterCursor).eventId).toBe(later.id);
    const replayed: string[] = [];
    for await (const cursor of resumeEventIds(db, actor, observedCursor)) replayed.push(cursor);

    expect(replayed).toEqual([laterCursor]);
  }, 30_000);

  it("aborts an in-flight publish so worker shutdown cannot hang", async () => {
    const { db } = await testContext();
    await appendEvent(db, {
      aggregateId: `stream:${randomUUID()}`,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "commentary.published",
      visibility: "PUBLIC",
      body: { text: "shutdown must release this publish" },
      idempotencyKey: `stream:${randomUUID()}`,
    });
    let publishing!: () => void;
    const publishingPromise = new Promise<void>((resolve) => { publishing = resolve; });
    const controller = startCommittedEventPublisher({
      db,
      workerId: "stream-shutdown-worker",
      leaseMs: 5_000,
      maxAttempts: 3,
      pollIntervalMs: 1,
      publishTimeoutMs: 4_000,
      publish: async () => {
        publishing();
        await new Promise<void>(() => undefined);
      },
    });
    await publishingPromise;

    const stopped = await Promise.race([
      controller.stop().then(() => "STOPPED" as const),
      new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 1_000)),
    ]);

    expect(stopped).toBe("STOPPED");
    expect(await db.one<{ status: string }>(
      "select status from stream_outbox_deliveries where worker_id is null order by created_at desc limit 1",
    )).toEqual({ status: "RETRY_SCHEDULED" });
  }, 30_000);
});
