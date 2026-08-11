import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  feedHeaders,
  projectFeedEvent,
  queryFeedEvents,
  type FeedEvent,
  type FeedQueryDatabase,
  type PublicFeedDto,
} from "../../lib/server/dal/feed";
import {
  feedAuthorizationFilter,
  type ActorContext,
} from "../../lib/server/auth/authorize";
import { createPublicFeedHandler } from "../../app/api/public/feed/route";

const event: FeedEvent = {
  id: "evt-1",
  accountId: "acct-a",
  type: "brain.response.completed",
  createdAt: "2026-08-09T12:00:00.000Z",
  protectedText: "private thesis text",
  topic: "AAPL",
};

describe("feed DTO projection", () => {
  it("never returns protected text to a public visitor", () => {
    const dto = projectFeedEvent({ role: "PUBLIC" }, event);

    expect(JSON.stringify(dto)).not.toContain("private thesis text");
    expect(dto).toEqual({
      id: "evt-1",
      type: "brain.response.completed",
      createdAt: event.createdAt,
      topic: "AAPL",
      placeholder: true,
    });
    expect(feedHeaders("PUBLIC").get("Cache-Control")).toBe("public, max-age=30");
  });

  it("rejects an account requesting another account's event", () => {
    expect(() =>
      projectFeedEvent({ role: "ACCOUNT", accountId: "acct-b" }, event),
    ).toThrow("FORBIDDEN");
    expect(feedHeaders("ACCOUNT").get("Cache-Control")).toBe("private, no-store");
  });

  it("returns least-data role DTOs and requires audited purposes", () => {
    expect(projectFeedEvent({ role: "ACCOUNT", accountId: "acct-a" }, event)).toEqual({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      topic: event.topic,
      text: event.protectedText,
    });
    expect(
      projectFeedEvent(
        { role: "MODERATOR", actorId: "mod-1", purpose: "Safety review" },
        event,
      ),
    ).toEqual({
      id: event.id,
      accountId: event.accountId,
      type: event.type,
      createdAt: event.createdAt,
      topic: event.topic,
      text: event.protectedText,
    });
    expect(
      projectFeedEvent(
        { role: "OPERATOR", actorId: "op-1", purpose: "Incident review" },
        event,
      ),
    ).toEqual({
      id: event.id,
      accountId: event.accountId,
      type: event.type,
      createdAt: event.createdAt,
      topic: event.topic,
      text: event.protectedText,
    });
    expect(() =>
      feedAuthorizationFilter({
        role: "MODERATOR",
        actorId: "mod-1",
        purpose: "   ",
      }),
    ).toThrow("PURPOSE_REQUIRED");
    expect(() =>
      feedAuthorizationFilter({ role: "OPERATOR", actorId: "", purpose: "Review" }),
    ).toThrow("ACTOR_ID_REQUIRED");
  });
});

describe("authorization-first feed retrieval", () => {
  it("translates every actor role into a database query filter", () => {
    const actors: readonly ActorContext[] = [
      { role: "PUBLIC" },
      { role: "ACCOUNT", accountId: "acct-a" },
      { role: "MODERATOR", actorId: "mod-1", purpose: "Safety review" },
      { role: "OPERATOR", actorId: "op-1", purpose: "Incident review" },
    ];

    expect(actors.map((actor) => feedAuthorizationFilter(actor))).toEqual([
      { clause: "e.visibility = 'PUBLIC'", parameters: [] },
      {
        clause:
          "(e.account_id = $1 and e.visibility in ('PRIVATE_ACCOUNT', 'SHARED'))",
        parameters: ["acct-a"],
      },
      {
        clause: "e.visibility in ('PUBLIC', 'PRIVATE_ACCOUNT', 'SHARED')",
        parameters: [],
      },
      { clause: "e.visibility in ('PUBLIC', 'PRIVATE_ACCOUNT', 'SHARED', 'OPERATOR')", parameters: [] },
    ]);
    expect(feedHeaders("MODERATOR").get("Cache-Control")).toBe("private, no-store");
    expect(feedHeaders("OPERATOR").get("Cache-Control")).toBe("private, no-store");
  });

  it("applies the account scope in SQL instead of fetching and filtering", async () => {
    const rows = [
      {
        id: "evt-1",
        account_id: "acct-a",
        type: "brain.response.completed",
        created_at: new Date(event.createdAt),
        topic: "AAPL",
      },
    ];
    const calls: Array<{
      readonly sql: string;
      readonly parameters: readonly unknown[] | undefined;
    }> = [];
    const database: FeedQueryDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: readonly unknown[],
      ): Promise<Row[]> {
        calls.push({ sql, parameters });
        return rows as unknown as Row[];
      },
    };

    const result = await queryFeedEvents(
      database,
      { role: "ACCOUNT", accountId: "acct-a" },
      20,
    );

    expect(calls).toHaveLength(1);
    const [{ sql, parameters }] = calls;
    expect(sql).toContain("e.account_id = $1");
    expect(sql).not.toContain("encrypted_event_bodies");
    expect(parameters).toEqual(["acct-a", 20]);
    expect(result).toEqual([{ ...event, protectedText: undefined }]);
  });
});

describe("public feed route", () => {
  it("returns only placeholder DTOs with public metadata caching", async () => {
    const publicDto: PublicFeedDto = {
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      topic: event.topic,
      placeholder: true,
    };
    const load = vi.fn(async () => [
      { ...publicDto, internalDiagnostic: "must not cross the route boundary" },
    ]);
    const response = await createPublicFeedHandler(load)();
    const responseText = response.clone().text();

    expect(load).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ events: [publicDto] });
    expect(await responseText).not.toContain("internalDiagnostic");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=30");
  });

  it("contains no protected-data read or decryption path", async () => {
    const source = await readFile(
      new URL("../../app/api/public/feed/route.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/readEventBody|decrypt|encrypted_event_bodies|protectedText/);
  });
});
