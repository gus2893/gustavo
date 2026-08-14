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
  maxDuration,
  resumeEventIds,
  streamAuthorizedEvents,
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

describe("Vercel SSE lifecycle", () => {
  it("closes by 55 seconds and resumes after the last emitted durable cursor", async () => {
    let now = 0;
    const load = vi.fn().mockResolvedValue([])
      .mockResolvedValueOnce([{ cursor: "sse.v1:41:event-a", eventId: "event-a" }])
      .mockResolvedValueOnce([{ cursor: "sse.v1:42:event-b", eventId: "event-b" }]);
    const emitted: string[] = [];

    const result = await streamAuthorizedEvents({
      lastEventId: "sse.v1:40:event-z",
      now: () => now,
      sleep: async (ms) => { now += ms; },
      load,
      authorize: vi.fn().mockResolvedValue(true),
      emit: async (event) => { emitted.push(event.cursor); },
      maxDurationMs: 55_000,
    });

    expect(result.reason).toBe("DURATION_BOUND");
    expect(emitted).toEqual(["sse.v1:41:event-a", "sse.v1:42:event-b"]);
    expect(load.mock.calls[1][0]).toMatchObject({ after: "sse.v1:41:event-a" });
  });

  it("subscribes before replay, pages allocated positions, deduplicates overlap, and finalizes once", async () => {
    let now = 0;
    const order: string[] = [];
    const close = vi.fn(async () => { order.push("close"); });
    const pages = [
      [
        { cursor: "sse.v1:41:event-a", eventId: "event-a" },
        { cursor: "sse.v1:42:event-b", eventId: "event-b" },
      ],
      [
        { cursor: "sse.v1:42:event-b", eventId: "event-b" },
        { cursor: "sse.v1:43:event-c", eventId: "event-c" },
      ],
      [],
    ];

    const result = await streamAuthorizedEvents({
      lastEventId: "sse.v1:40:event-z",
      now: () => now,
      sleep: async (ms) => { now += ms; },
      subscribe: async () => {
        order.push("subscribe");
        return { close };
      },
      load: async ({ after }) => {
        order.push(`load:${after}`);
        return pages.shift() ?? [];
      },
      authorize: async () => {
        order.push("authorize");
        return true;
      },
      loadProtected: async (event) => {
        order.push(`body:${event.eventId}`);
        return event;
      },
      emit: async (event) => { order.push(`emit:${event.eventId}`); },
      maxDurationMs: 55_000,
    });

    expect(order[0]).toBe("subscribe");
    expect(order).toContain("load:sse.v1:42:event-b");
    expect(order.filter((item) => item.startsWith("body:"))).toEqual([
      "body:event-a", "body:event-b", "body:event-c",
    ]);
    expect(order.filter((item) => item.startsWith("emit:"))).toEqual([
      "emit:event-a", "emit:event-b", "emit:event-c",
    ]);
    for (const prefix of ["body:", "emit:"]) {
      for (const index of order.keys()) {
        if (order[index]?.startsWith(prefix)) expect(order[index - 1]).toBe("authorize");
      }
    }
    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      reason: "DURATION_BOUND",
      lastEmittedCursor: "sse.v1:43:event-c",
    });
  });

  it("fails closed before protected loading when authorization is lost", async () => {
    const loadProtected = vi.fn();
    const emit = vi.fn();
    const result = await streamAuthorizedEvents({
      lastEventId: "sse.v1:40:event-z",
      now: () => 0,
      sleep: async () => undefined,
      load: vi.fn().mockResolvedValue([
        { cursor: "sse.v1:41:event-a", eventId: "event-a" },
      ]),
      authorize: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      loadProtected,
      emit,
      maxDurationMs: 55_000,
    });

    expect(result.reason).toBe("AUTHORIZATION_LOST");
    expect(loadProtected).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("exports the Vercel route duration and rejects malformed cursors before auth", async () => {
    expect(maxDuration).toBe(60);
    const authenticate = vi.fn();
    const subscribe = vi.fn();
    const handler = createFeedStreamHandler({
      authenticate,
      subscribe,
      load: vi.fn(),
      validateLastEventId: (value) => { parseStreamCursor(value); },
    });

    const response = await handler(new Request("http://localhost:3000/api/feed/stream", {
      headers: { "Last-Event-ID": "sse.v1:0:not-authority" },
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(authenticate).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("counts authentication time against the 54-second admission boundary", async () => {
    let now = 0;
    const subscribe = vi.fn(() => [] as const);
    const handler = createFeedStreamHandler({
      authenticate: async () => {
        now = 54_000;
        return {
          actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
          revalidate: async () => true,
        };
      },
      subscribe,
      load: async () => undefined,
      monotonicNow: () => now,
    });

    const response = await handler(new Request("http://localhost:3000/api/feed/stream"));

    expect(await response.text()).toBe("");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not emit a protected event when cancellation wins its body load", async () => {
    const controller = new AbortController();
    let loading!: () => void;
    let release!: (event: typeof fixtures["private-a"]) => void;
    const loadingPromise = new Promise<void>((resolve) => { loading = resolve; });
    const loaded = new Promise<typeof fixtures["private-a"]>((resolve) => { release = resolve; });
    const handler = createFeedStreamHandler({
      authenticate: async () => ({
        actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
        revalidate: async () => true,
      }),
      subscribe: () => ["private-a"],
      load: async () => {
        loading();
        return loaded;
      },
      heartbeatMs: 60_000,
    });
    const response = await handler(new Request("http://localhost:3000/api/feed/stream", {
      signal: controller.signal,
    }));
    const reading = response.body!.getReader().read();
    await loadingPromise;

    controller.abort();
    release(fixtures["private-a"]);

    expect(await reading).toEqual({ done: true, value: undefined });
  });

  it("does not subscribe when the request is cancelled before the first pull", async () => {
    const controller = new AbortController();
    const subscribe = vi.fn(() => [] as const);
    const handler = createFeedStreamHandler({
      authenticate: async () => ({
        actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
        revalidate: async () => true,
      }),
      subscribe,
      load: async () => undefined,
    });
    controller.abort();
    const response = await handler(new Request("http://localhost:3000/api/feed/stream", {
      signal: controller.signal,
    }));

    expect(await response.text()).toBe("");
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("settles a queue-full producer and finalizes its source when a non-reader aborts", async () => {
    const controller = new AbortController();
    let nextCount = 0;
    let queueFull!: () => void;
    let finalized!: () => void;
    const queueFullPromise = new Promise<void>((resolve) => { queueFull = resolve; });
    const finalizedPromise = new Promise<void>((resolve) => { finalized = resolve; });
    const source: EventIdSource = {
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            nextCount += 1;
            if (nextCount >= 102) queueFull();
            return { done: false, value: `private-${nextCount}` };
          },
          async return(): Promise<IteratorResult<string>> {
            finalized();
            return { done: true, value: undefined };
          },
        };
      },
    };
    const handler = createFeedStreamHandler({
      authenticate: async () => ({
        actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
        revalidate: async () => true,
      }),
      subscribe: () => source,
      load: async (_actor, eventId) => ({
        id: eventId,
        visibility: "PRIVATE_ACCOUNT",
        accountId: "acct-a",
      }),
    });
    const response = await handler(new Request("http://localhost:3000/api/feed/stream", {
      signal: controller.signal,
    }));
    await expect(Promise.race([
      queueFullPromise.then(() => "QUEUE_FULL" as const),
      new Promise<"QUEUE_NOT_REACHED">((resolve) => (
        setTimeout(() => resolve("QUEUE_NOT_REACHED"), 100)
      )),
    ])).resolves.toBe("QUEUE_FULL");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    controller.abort();

    await expect(Promise.race([
      finalizedPromise.then(() => "FINALIZED" as const),
      new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 100)),
    ])).resolves.toBe("FINALIZED");
    expect(source.close).toHaveBeenCalledOnce();
    await expect(Promise.race([
      response.body!.cancel().then(() => "CANCELLED" as const),
      new Promise<"CANCEL_HUNG">((resolve) => setTimeout(() => resolve("CANCEL_HUNG"), 100)),
    ])).resolves.toBe("CANCELLED");
  });

  it("keeps the lifecycle alarm armed until a finite producer response settles", async () => {
    let fireDeadline: (() => void) | undefined;
    let alarmDisposals = 0;
    let nextCount = 0;
    let finalized!: () => void;
    const finalizedPromise = new Promise<void>((resolve) => { finalized = resolve; });
    const iteratorReturn = vi.fn(async (): Promise<IteratorResult<string>> => {
      finalized();
      return { done: true, value: undefined };
    });
    const source: EventIdSource = {
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            nextCount += 1;
            return nextCount <= 20
              ? { done: false, value: `private-finite-${nextCount}` }
              : { done: true, value: undefined };
          },
          return: iteratorReturn,
        };
      },
    };
    const handler = createFeedStreamHandler({
      scheduleLifecycleAlarm: (_milliseconds, fire) => {
        let active = true;
        fireDeadline = () => { if (active) fire(); };
        return () => {
          if (!active) return;
          active = false;
          alarmDisposals += 1;
        };
      },
      authenticate: async () => ({
        actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
        revalidate: async () => true,
      }),
      subscribe: () => source,
      load: async (_actor, eventId) => ({
        id: eventId,
        visibility: "PRIVATE_ACCOUNT",
        accountId: "acct-a",
      }),
    });
    const response = await handler(new Request("http://localhost:3000/api/feed/stream"));

    await expect(Promise.race([
      finalizedPromise.then(() => "FINALIZED" as const),
      new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 100)),
    ])).resolves.toBe("FINALIZED");
    expect(alarmDisposals).toBe(0);
    expect(fireDeadline).toBeTypeOf("function");

    fireDeadline!();

    await expect(Promise.race([
      response.body!.cancel().then(() => "CANCELLED" as const),
      new Promise<"CANCEL_HUNG">((resolve) => setTimeout(() => resolve("CANCEL_HUNG"), 100)),
    ])).resolves.toBe("CANCELLED");
    expect(alarmDisposals).toBe(1);
    expect(source.close).toHaveBeenCalledOnce();
    expect(iteratorReturn).toHaveBeenCalledOnce();
  });

  it("finalizes a subscription that resolves after cancellation", async () => {
    const controller = new AbortController();
    let subscribing!: () => void;
    let resolveSubscription!: (source: EventIdSource) => void;
    const subscribingPromise = new Promise<void>((resolve) => { subscribing = resolve; });
    const subscriptionPromise = new Promise<EventIdSource>((resolve) => {
      resolveSubscription = resolve;
    });
    const iteratorReturn = vi.fn(async (): Promise<IteratorResult<string>> => ({
      done: true,
      value: undefined,
    }));
    const source: EventIdSource = {
      close: vi.fn(),
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            return { done: true, value: undefined };
          },
          return: iteratorReturn,
        };
      },
    };
    const handler = createFeedStreamHandler({
      authenticate: async () => ({
        actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
        revalidate: async () => true,
      }),
      subscribe: async () => {
        subscribing();
        return subscriptionPromise;
      },
      load: async () => undefined,
    });
    const response = await handler(new Request("http://localhost:3000/api/feed/stream", {
      signal: controller.signal,
    }));
    await subscribingPromise;

    controller.abort();
    resolveSubscription(source);

    await expect(Promise.race([
      response.body!.cancel().then(() => "CANCELLED" as const),
      new Promise<"CANCEL_HUNG">((resolve) => setTimeout(() => resolve("CANCEL_HUNG"), 100)),
    ])).resolves.toBe("CANCELLED");
    expect(source.close).toHaveBeenCalledOnce();
    expect(iteratorReturn).toHaveBeenCalledOnce();
  });

  it("aborts and awaits a non-resolving revalidator before source cleanup", async () => {
    const controller = new AbortController();
    let authorizing!: () => void;
    let finalized!: () => void;
    let authorizationSettled = false;
    const authorizingPromise = new Promise<void>((resolve) => { authorizing = resolve; });
    const finalizedPromise = new Promise<void>((resolve) => { finalized = resolve; });
    const source: EventIdSource = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            return { done: false, value: "private-a" };
          },
          async return(): Promise<IteratorResult<string>> {
            finalized();
            return { done: true, value: undefined };
          },
        };
      },
    };
    const handler = createFeedStreamHandler({
      authenticate: async () => ({
        actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
        revalidate: async (operation?: { readonly signal: AbortSignal }) => {
          authorizing();
          return new Promise<boolean>((resolve) => {
            operation?.signal.addEventListener("abort", () => {
              authorizationSettled = true;
              resolve(false);
            }, { once: true });
          });
        },
      }),
      subscribe: () => source,
      load: async () => undefined,
    });
    const response = await handler(new Request("http://localhost:3000/api/feed/stream", {
      signal: controller.signal,
    }));
    await authorizingPromise;

    controller.abort();

    await expect(Promise.race([
      finalizedPromise.then(() => "FINALIZED" as const),
      new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 100)),
    ])).resolves.toBe("FINALIZED");
    expect(authorizationSettled).toBe(true);
    await response.body?.cancel();
  });

  it("awaits protected-load cancellation settlement before closing the response", async () => {
    const controller = new AbortController();
    let loading!: () => void;
    let settled = false;
    const loadingPromise = new Promise<void>((resolve) => { loading = resolve; });
    const handler = createFeedStreamHandler({
      authenticate: async () => ({
        actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
        revalidate: async () => true,
      }),
      subscribe: () => ["private-a"],
      load: async (
        _actor,
        _eventId,
        operation?: { readonly signal: AbortSignal },
      ) => {
        loading();
        return new Promise<undefined>((resolve) => {
          operation?.signal.addEventListener("abort", () => {
            settled = true;
            resolve(undefined);
          }, { once: true });
        });
      },
    });
    const response = await handler(new Request("http://localhost:3000/api/feed/stream", {
      signal: controller.signal,
    }));
    const reading = response.body!.getReader().read();
    await loadingPromise;

    controller.abort();

    expect(await reading).toEqual({ done: true, value: undefined });
    expect(settled).toBe(true);
  });

  it("installs the 54-second lifecycle before authentication and awaits its abort", async () => {
    let now = 0;
    let fireDeadline: (() => void) | undefined;
    let releaseFallback!: () => void;
    let authenticating!: () => void;
    let authenticationSettled = false;
    const fallback = new Promise<void>((resolve) => { releaseFallback = resolve; });
    const authenticatingPromise = new Promise<void>((resolve) => { authenticating = resolve; });
    const subscribe = vi.fn(() => [] as const);
    const handler = createFeedStreamHandler({
      monotonicNow: () => now,
      scheduleLifecycleAlarm: (_milliseconds: number, fire: () => void) => {
        fireDeadline = fire;
        return () => undefined;
      },
      authenticate: async (
        _request,
        operation?: { readonly signal: AbortSignal },
      ) => {
        authenticating();
        if (!operation) {
          await fallback;
          return {
            actor: { role: "ACCOUNT" as const, accountId: "acct-a" },
            revalidate: async () => true,
          };
        }
        await new Promise<void>((_resolve, reject) => {
          operation.signal.addEventListener("abort", () => {
            authenticationSettled = true;
            reject(new Error("SSE_DURATION_BOUND"));
          }, { once: true });
        });
        throw new Error("unreachable");
      },
      subscribe,
      load: async () => undefined,
    });
    const pendingResponse = handler(new Request("http://localhost:3000/api/feed/stream"));
    await authenticatingPromise;

    if (fireDeadline) {
      now = 54_000;
      fireDeadline();
    } else {
      releaseFallback();
    }
    const response = await pendingResponse;

    expect(fireDeadline).toBeTypeOf("function");
    expect(response.status).toBe(500);
    expect(authenticationSettled).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

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
