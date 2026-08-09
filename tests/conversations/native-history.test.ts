import type { EventDatabase } from "../../lib/server/events/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConversationFixture,
  type ConversationFixture,
} from "../helpers/postgres";
import {
  appendMessage,
  listMessages,
} from "../../lib/server/history/messages";

const routeState = vi.hoisted(() => ({
  db: undefined as EventDatabase | undefined,
}));

vi.mock("../../lib/server/db/postgres", () => ({
  getDatabase(): EventDatabase {
    if (!routeState.db) {
      throw new Error("TEST_DATABASE_NOT_READY");
    }
    return routeState.db;
  },
}));

import {
  GET,
  POST,
} from "../../app/api/conversations/[conversationId]/messages/route";

function authenticatedRequest(
  fixture: ConversationFixture,
  method: "GET" | "POST",
  options: {
    readonly body?: unknown;
    readonly query?: string;
    readonly origin?: string;
  } = {},
): Request {
  return new Request(
    `https://gustavo.lol/api/conversations/${fixture.conversationId}/messages${options.query ?? ""}`,
    {
      method,
      headers: {
        cookie: `__Host-gustavo-session=${fixture.sessionToken}`,
        ...(method === "POST"
          ? {
              "content-type": "application/json",
              origin: options.origin ?? "https://gustavo.lol",
            }
          : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
  );
}

function routeContext(conversationId: string): {
  readonly params: Promise<{ readonly conversationId: string }>;
} {
  return { params: Promise.resolve({ conversationId }) };
}

afterEach(() => {
  routeState.db = undefined;
  vi.unstubAllEnvs();
});

describe("native conversation history", () => {
  it("commits encrypted messages before acknowledgement and paginates by stable cursor", async () => {
    const ctx = await createConversationFixture("acct-a");
    const first = await appendMessage(ctx, {
      idempotencyKey: "m1",
      role: "USER",
      text: "first",
    });
    await appendMessage(ctx, {
      idempotencyKey: "m2",
      role: "NODE",
      text: "second",
    });

    const page1 = await listMessages(ctx, { limit: 1 });
    const page2 = await listMessages(ctx, {
      limit: 1,
      after: page1.nextCursor,
    });

    expect(page1.items.map((item) => item.text)).toEqual(["first"]);
    expect(page2.items.map((item) => item.text)).toEqual(["second"]);
    expect(page2.nextCursor).toBeNull();
    expect(page1.items[0]).toMatchObject({
      eventId: first.eventId,
      role: "USER",
      status: "COMPLETED",
      completedAt: expect.any(String),
      abortedAt: null,
      abortReason: null,
    });

    const stored = await ctx.db.one<{
      event_count: number;
      outbox_count: number;
      protected_count: number;
      plaintext_count: number;
    }>(
      `select
         count(distinct e.id)::int as event_count,
         count(distinct o.id)::int as outbox_count,
         count(distinct b.event_id)::int as protected_count,
         count(*) filter (
           where position(convert_to('first', 'UTF8') in b.ciphertext) > 0
         )::int as plaintext_count
       from messages m
       join events e on e.id=m.event_id
       join transactional_outbox o on o.event_id=e.id
       join encrypted_event_bodies b on b.event_id=m.event_id
       where m.conversation_id=$1`,
      [ctx.conversationId],
    );
    expect(stored).toEqual({
      event_count: 2,
      outbox_count: 2,
      protected_count: 2,
      plaintext_count: 0,
    });
  }, 30_000);

  it("makes append idempotent per conversation and retains explicit abort metadata", async () => {
    const ctx = await createConversationFixture("acct-idempotent");
    const first = await appendMessage(ctx, {
      idempotencyKey: "same-key",
      role: "NODE",
      text: "partial response",
      completion: {
        status: "ABORTED",
        at: new Date("2026-08-09T12:00:00.000Z"),
        reason: "MODEL_TIMEOUT",
      },
    });
    const replay = await appendMessage(ctx, {
      idempotencyKey: "same-key",
      role: "NODE",
      text: "partial response",
      completion: {
        status: "ABORTED",
        at: new Date("2026-08-09T12:00:00.000Z"),
        reason: "MODEL_TIMEOUT",
      },
    });

    expect(replay).toEqual(first);
    expect((await listMessages(ctx)).items).toEqual([
      expect.objectContaining({
        eventId: first.eventId,
        status: "ABORTED",
        completedAt: null,
        abortedAt: "2026-08-09T12:00:00.000Z",
        abortReason: "MODEL_TIMEOUT",
      }),
    ]);
    expect(
      await ctx.db.one(
        "select count(*)::int as count from messages where conversation_id=$1",
        [ctx.conversationId],
      ),
    ).toEqual({ count: 1 });

    await expect(
      appendMessage(ctx, {
        idempotencyKey: "same-key",
        role: "NODE",
        text: "different response",
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  }, 30_000);

  it("authorizes the account and conversation before history access and binds signed cursors to scope", async () => {
    const firstAccount = await createConversationFixture("acct-scope-a");
    const secondAccount = await createConversationFixture("acct-scope-b");
    await appendMessage(firstAccount, {
      idempotencyKey: "scope-1",
      role: "USER",
      text: "one",
    });
    await appendMessage(firstAccount, {
      idempotencyKey: "scope-2",
      role: "NODE",
      text: "two",
    });
    await appendMessage(secondAccount, {
      idempotencyKey: "scope-1",
      role: "USER",
      text: "other account",
    });

    const firstPage = await listMessages(firstAccount, { limit: 1 });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const unauthorized = {
      ...firstAccount,
      accountId: secondAccount.accountId,
    };
    await expect(listMessages(unauthorized)).rejects.toThrow("FORBIDDEN");
    await expect(
      listMessages(secondAccount, {
        after: firstPage.nextCursor,
      }),
    ).rejects.toThrow("INVALID_CURSOR_SCOPE");

    const cursor = firstPage.nextCursor as string;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    await expect(
      listMessages(firstAccount, { after: tampered }),
    ).rejects.toThrow("INVALID_CURSOR_SIGNATURE");

    const replayOne = await listMessages(firstAccount, { after: cursor });
    const replayTwo = await listMessages(firstAccount, { after: cursor });
    expect(replayTwo).toEqual(replayOne);
    await expect(listMessages(firstAccount, { limit: 101 })).rejects.toThrow(
      "INVALID_MESSAGE_LIMIT",
    );
  }, 30_000);

  it("acknowledges the mutation route only after event, encrypted body, message, and outbox commit", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const ctx = await createConversationFixture("acct-route");
    routeState.db = ctx.db;

    const response = await POST(
      authenticatedRequest(ctx, "POST", {
        body: { idempotencyKey: "route-message", text: "route text" },
      }),
      routeContext(ctx.conversationId),
    );
    expect(response.status).toBe(201);
    const acknowledgement = await response.json() as {
      readonly eventId: string;
      readonly status: string;
    };
    expect(acknowledgement).toMatchObject({
      eventId: expect.any(String),
      status: "COMPLETED",
    });
    expect(
      await ctx.db.one(
        `select count(*)::int as count
         from messages m
         join encrypted_event_bodies b on b.event_id=m.event_id
         join transactional_outbox o on o.event_id=m.event_id
         where m.event_id=$1`,
        [acknowledgement.eventId],
      ),
    ).toEqual({ count: 1 });

    const history = await GET(
      authenticatedRequest(ctx, "GET", { query: "?limit=1" }),
      routeContext(ctx.conversationId),
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      items: [expect.objectContaining({ text: "route text" })],
      nextCursor: null,
    });
    expect(history.headers.get("cache-control")).toBe("private, no-store");
  }, 30_000);

  it("rejects a cross-origin mutation before any conversation write", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const ctx = await createConversationFixture("acct-route-origin");
    routeState.db = ctx.db;

    const response = await POST(
      authenticatedRequest(ctx, "POST", {
        body: { idempotencyKey: "foreign-origin", text: "do not write" },
        origin: "https://evil.example",
      }),
      routeContext(ctx.conversationId),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "INVALID_ORIGIN" });
    expect(
      await ctx.db.one(
        "select count(*)::int as count from messages where conversation_id=$1",
        [ctx.conversationId],
      ),
    ).toEqual({ count: 0 });
  }, 30_000);

  it("reports a reused idempotency key with different content as a stable conflict", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const ctx = await createConversationFixture("acct-route-conflict");
    routeState.db = ctx.db;

    const accepted = await POST(
      authenticatedRequest(ctx, "POST", {
        body: { idempotencyKey: "route-conflict", text: "original" },
      }),
      routeContext(ctx.conversationId),
    );
    expect(accepted.status).toBe(201);

    const conflict = await POST(
      authenticatedRequest(ctx, "POST", {
        body: { idempotencyKey: "route-conflict", text: "changed" },
      }),
      routeContext(ctx.conversationId),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(
      await ctx.db.one(
        "select count(*)::int as count from messages where conversation_id=$1",
        [ctx.conversationId],
      ),
    ).toEqual({ count: 1 });
  }, 30_000);

  it("denies cross-account routes and never acknowledges a rolled-back outbox write", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const owner = await createConversationFixture("acct-route-owner");
    const intruder = await createConversationFixture("acct-route-intruder", owner.db);
    routeState.db = owner.db;

    const denied = await GET(
      authenticatedRequest(intruder, "GET"),
      routeContext(owner.conversationId),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "FORBIDDEN" });

    await owner.db.query(`
      create function reject_message_outbox() returns trigger language plpgsql as $$
      begin
        if new.topic = 'participant.message.created' then
          raise exception 'TEST_MESSAGE_OUTBOX_FAILURE';
        end if;
        return new;
      end;
      $$;
      create trigger reject_message_outbox before insert on transactional_outbox
      for each row execute function reject_message_outbox();
    `);
    const failed = await POST(
      authenticatedRequest(owner, "POST", {
        body: { idempotencyKey: "route-rollback", text: "must not survive" },
      }),
      routeContext(owner.conversationId),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "MESSAGE_WRITE_FAILED" });
    expect(
      await owner.db.one(
        "select count(*)::int as count from events where idempotency_key=$1",
        [`message:${owner.conversationId}:route-rollback`],
      ),
    ).toEqual({ count: 0 });
    expect(
      await owner.db.one(
        "select count(*)::int as count from messages where conversation_id=$1",
        [owner.conversationId],
      ),
    ).toEqual({ count: 0 });
  }, 30_000);
});
