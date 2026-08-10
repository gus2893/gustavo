import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import type { EventDatabase } from "../../lib/server/events/types";
import * as chatImportModule from "../../lib/server/chat-sources/import";
import {
  importChatManifest,
  type ChatImportContext,
} from "../../lib/server/chat-sources/import";
import type { ChatManifest } from "../../lib/server/chat-sources/contracts";
import {
  createConversationFixture,
  type ConversationFixture,
} from "../helpers/postgres";

const routeState = vi.hoisted(() => ({
  db: undefined as ChatImportContext["db"] | undefined,
}));

vi.mock("../../lib/server/db/postgres", () => ({
  getDatabase: () => {
    if (!routeState.db) throw new Error("TEST_DATABASE_NOT_READY");
    return routeState.db;
  },
}));

import { POST } from "../../app/api/memory/sources/import/route";

const AT_1 = "2026-08-01T00:00:00.000Z";
const AT_2 = "2026-08-02T00:00:00.000Z";

function manifest(overrides: Partial<ChatManifest> = {}): ChatManifest {
  const base: ChatManifest = {
    source: "CHATGPT_EXPORT",
    formatVersion: "chatgpt-export-v1",
    exportedAt: "2026-08-03T00:00:00.000Z",
    cursor: "opaque/cursor:1",
    ownerAuthorizationId: "auth-1",
    sourceId: "export-1",
    conversations: [{
      id: "conversation-1",
      participants: [
        { id: "owner-user", role: "USER" },
        { id: "source-assistant", role: "ASSISTANT" },
      ],
      messages: [{
        id: "message-1", at: AT_1, role: "USER", participantId: "owner-user",
        text: "Remember AAPL",
      }],
      }],
    conversationCount: 1,
    messageCount: 1,
  };
  const value: ChatManifest = { ...base, ...overrides };
  return {
    ...value,
    conversationCount: overrides.conversationCount ?? value.conversations.length,
    messageCount: overrides.messageCount
      ?? value.conversations.reduce((count, conversation) => count + conversation.messages.length, 0),
  };
}

async function authorize(
  fixture: ConversationFixture,
  options: {
    readonly id?: string;
    readonly source?: ChatManifest["source"];
    readonly sourceId?: string;
    readonly revoked?: boolean;
  } = {},
): Promise<string> {
  const id = options.id ?? "auth-1";
  await fixture.db.query(
    `insert into chat_source_authorizations (
       id,account_id,node_brain_id,source,external_source_id,granted_by_account_id,
       granted_at,revoked_at
     ) values ($1,$2,$3,$4,$5,$2,$6,$7)`,
    [
      id,
      fixture.accountId,
      fixture.nodeBrainId,
      options.source ?? "CHATGPT_EXPORT",
      options.sourceId ?? "export-1",
      new Date("2026-07-31T00:00:00.000Z"),
      options.revoked ? new Date("2026-07-31T12:00:00.000Z") : null,
    ],
  );
  return id;
}

function routeRequest(fixture: ConversationFixture, body: unknown): Request {
  return new Request("http://localhost:3000/api/memory/sources/import", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `gustavo-session=${fixture.sessionToken}`,
      origin: "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

function countedDatabase(database: EventDatabase): {
  readonly db: EventDatabase;
  readonly count: () => number;
} {
  let queries = 0;
  const wrap = (target: EventDatabase): EventDatabase => ({
    query: async (sql, parameters) => {
      queries += 1;
      return target.query(sql, parameters);
    },
    one: async (sql, parameters) => {
      queries += 1;
      return target.one(sql, parameters);
    },
    transaction: (work) => target.transaction((transaction) => work(wrap(transaction))),
  });
  return Object.freeze({ db: wrap(database), count: () => queries });
}

async function waitForDatabaseActivity(
  db: ChatImportContext["db"],
  queryFragment: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = await db.one<{ waiting: boolean }>(
      `select exists (
         select 1 from pg_stat_activity
         where pid<>pg_backend_pid() and query like $1 and wait_event_type='Lock'
       ) as waiting`,
      [`%${queryFragment}%`],
    );
    if (row.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`DATABASE_ACTIVITY_NOT_OBSERVED:${queryFragment}`);
}

afterEach(() => {
  routeState.db = undefined;
  vi.restoreAllMocks();
});

describe("external chat source cursors", () => {
  it("imports only authorized new content and makes exact and concurrent retries no-ops", async () => {
    const fixture = await createConversationFixture("chat-import-basic");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };

    const first = await importChatManifest(context, manifest());
    expect(first).toMatchObject({ insertedMessages: 1, correctedMessages: 0, quarantinedMessages: 0 });
    expect((await importChatManifest(context, manifest())).insertedMessages).toBe(0);

    const updated = manifest({
      cursor: "opaque/cursor:2",
      exportedAt: "2026-08-04T00:00:00.000Z",
      conversations: [{
        id: "conversation-1",
        participants: [
          { id: "owner-user", role: "USER" },
          { id: "source-assistant", role: "ASSISTANT" },
        ],
        messages: [
          { id: "message-1", at: AT_1, role: "USER", participantId: "owner-user", text: "Remember AAPL" },
          { id: "message-2", at: AT_2, role: "ASSISTANT", participantId: "source-assistant", text: "Stored" },
        ],
      }],
    });
    expect((await importChatManifest(context, updated)).insertedMessages).toBe(1);

    const concurrentSource = manifest({
      sourceId: "export-concurrent",
      ownerAuthorizationId: "auth-concurrent",
    });
    await authorize(fixture, { id: "auth-concurrent", sourceId: "export-concurrent" });
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => importChatManifest(context, concurrentSource)),
    );
    expect(concurrent.reduce((sum, result) => sum + result.insertedMessages, 0)).toBe(1);
    expect(await fixture.db.one<{ count: number }>(
      `select count(*)::int as count from imported_chat_message_versions v
       join imported_chat_conversations c on c.id=v.imported_conversation_id
       join chat_sources s on s.id=c.chat_source_id
       where s.external_source_id='export-concurrent'`,
    )).toEqual({ count: 1 });
  }, 20_000);

  it("appends corrected versions with deterministic identities while retaining source fidelity", async () => {
    const fixture = await createConversationFixture("chat-import-correction");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    const original = await importChatManifest(context, manifest());
    const correctionManifest = manifest({
      cursor: "opaque/cursor:2",
      exportedAt: "2026-08-04T00:00:00.000Z",
      conversations: [{
        id: "conversation-1",
        participants: [{ id: "owner-user", role: "USER" }],
        messages: [{
          id: "message-1", at: AT_2, role: "USER", participantId: "owner-user",
          text: "Remember MSFT instead",
        }],
      }],
    });
    const corrected = await importChatManifest(context, correctionManifest);
    expect(corrected).toMatchObject({ insertedMessages: 1, correctedMessages: 1 });
    expect((await importChatManifest(context, correctionManifest)).insertedMessages).toBe(0);

    const rows = await fixture.db.query<{
      id: string; event_id: string; version: number; content_digest: string;
      supersedes_message_version_id: string | null;
    }>(
      `select v.id::text,v.event_id::text,v.version,v.content_digest,
              v.supersedes_message_version_id::text
       from imported_chat_message_versions v order by v.version`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].supersedes_message_version_id).toBe(rows[0].id);
    expect(rows[1].version).toBe(2);
    expect(rows[1].content_digest).toBe(canonicalContentDigest({
      at: AT_2, participantId: "owner-user", role: "USER", text: "Remember MSFT instead",
    }));
    expect(corrected.messageVersionIds[0]).toBe(rows[1].id);
    expect(original.messageVersionIds[0]).toBe(rows[0].id);

    const body = await readEventBody(fixture.db, rows[1].event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    });
    expect(body).toMatchObject({
      externalConversationId: "conversation-1",
      externalMessageId: "message-1",
      text: "Remember MSFT instead",
      role: "USER",
      version: 2,
    });
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int as count from memory_records",
    )).toEqual({ count: 0 });
    expect(await fixture.db.one<{ count: number }>(
      `select count(*)::int as count from events
       where type like 'external.chat.%' and visibility<>'PRIVATE_ACCOUNT'`,
    )).toEqual({ count: 0 });
  });

  it("rejects missing, revoked, mismatched, and cross-account owner authorization before writes", async () => {
    const owner = await createConversationFixture("chat-import-owner");
    const intruder = await createConversationFixture("chat-import-intruder", owner.db);
    await expect(importChatManifest(
      { db: owner.db, requesterAccountId: owner.accountId }, manifest(),
    )).rejects.toThrow("SOURCE_NOT_AUTHORIZED");

    await authorize(owner, { id: "auth-wrong", source: "CLAUDE_EXPORT", sourceId: "export-wrong" });
    await expect(importChatManifest(
      { db: owner.db, requesterAccountId: owner.accountId },
      manifest({ ownerAuthorizationId: "auth-wrong", sourceId: "export-wrong" }),
    )).rejects.toThrow("SOURCE_NOT_AUTHORIZED");
    await authorize(owner, { id: "auth-revoked", sourceId: "export-revoked", revoked: true });
    await expect(importChatManifest(
      { db: owner.db, requesterAccountId: owner.accountId },
      manifest({ ownerAuthorizationId: "auth-revoked", sourceId: "export-revoked" }),
    )).rejects.toThrow("SOURCE_NOT_AUTHORIZED");
    await authorize(owner);
    await expect(importChatManifest(
      { db: owner.db, requesterAccountId: intruder.accountId }, manifest(),
    )).rejects.toThrow("SOURCE_NOT_AUTHORIZED");
    expect(await owner.db.one<{ count: number }>(
      "select count(*)::int as count from chat_sources",
    )).toEqual({ count: 0 });
  });

  it("quarantines invalid source items without inventing context and imports a later valid version", async () => {
    const fixture = await createConversationFixture("chat-import-quarantine");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    const mixed = manifest({
      conversations: [{
        id: "conversation-1",
        participants: [
          { id: "owner-user", role: "USER" },
          { id: "source-assistant", role: "ASSISTANT" },
        ],
        messages: [
          { id: "message-1", at: AT_1, role: "USER", participantId: "owner-user", text: "Valid" },
          { id: "message-2", at: "2026-08-02T00:00:00+00:00", role: "ASSISTANT", participantId: "source-assistant", text: "Not canonical" },
          {
            id: "message-3", at: AT_2, role: "ASSISTANT", participantId: "source-assistant", text: "Digest mismatch",
            contentDigest: "0".repeat(64),
          },
        ],
      }],
    });
    const first = await importChatManifest(context, mixed);
    expect(first).toMatchObject({ insertedMessages: 1, quarantinedMessages: 2 });
    expect((await importChatManifest(context, mixed))).toMatchObject({
      insertedMessages: 0, quarantinedMessages: 0,
    });
    const quarantine = await fixture.db.query<{
      reason: string; external_conversation_id: string | null; external_message_id: string | null;
    }>(
      `select reason,external_conversation_id,external_message_id
       from chat_import_quarantine order by external_message_id`,
    );
    expect(quarantine).toEqual([
      { reason: "INVALID_CHAT_MESSAGE_AT", external_conversation_id: "conversation-1", external_message_id: "message-2" },
      { reason: "CHAT_CONTENT_DIGEST_MISMATCH", external_conversation_id: "conversation-1", external_message_id: "message-3" },
    ]);

    const repaired = manifest({
      cursor: "opaque/cursor:2",
      exportedAt: "2026-08-04T00:00:00.000Z",
      conversations: [{
        id: "conversation-1",
        participants: [
          { id: "owner-user", role: "USER" },
          { id: "source-assistant", role: "ASSISTANT" },
        ],
        messages: [
          { id: "message-1", at: AT_1, role: "USER", participantId: "owner-user", text: "Valid" },
          { id: "message-2", at: AT_2, role: "ASSISTANT", participantId: "source-assistant", text: "Now canonical" },
        ],
      }],
    });
    expect(await importChatManifest(context, repaired)).toMatchObject({
      insertedMessages: 1, quarantinedMessages: 0,
    });
  });

  it("rolls back messages, encrypted source events, imports, and cursor together", async () => {
    const fixture = await createConversationFixture("chat-import-rollback");
    await authorize(fixture);
    await fixture.db.query(`
      create function reject_chat_cursor_for_test() returns trigger language plpgsql as $$
      begin raise exception 'CURSOR_REJECTED_FOR_TEST'; end; $$;
      create trigger reject_chat_cursor_for_test before insert or update on chat_source_cursors
      for each row execute function reject_chat_cursor_for_test();
    `);
    await expect(importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, manifest(),
    )).rejects.toThrow("CURSOR_REJECTED_FOR_TEST");
    for (const table of [
      "chat_sources", "chat_source_imports", "imported_chat_conversations",
      "imported_chat_message_versions", "chat_import_quarantine",
    ]) {
      expect(await fixture.db.one<{ count: number }>(`select count(*)::int as count from ${table}`))
        .toEqual({ count: 0 });
    }
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int as count from events where type like 'external.chat.%'",
    )).toEqual({ count: 0 });
    await fixture.db.query("drop trigger reject_chat_cursor_for_test on chat_source_cursors");
    expect((await importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, manifest(),
    )).insertedMessages).toBe(1);
  });

  it("enforces ownership, event scope, append-only versions, and cursor integrity in SQL", async () => {
    const fixture = await createConversationFixture("chat-import-sql");
    const other = await createConversationFixture("chat-import-sql-other", fixture.db);
    await authorize(fixture);
    await importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, manifest(),
    );
    const source = await fixture.db.one<{ id: string; authorization_id: string }>(
      "select id::text,authorization_id from chat_sources",
    );
    await expect(fixture.db.query(
      `insert into imported_chat_conversations
       (id,chat_source_id,account_id,node_brain_id,external_conversation_id,identity_digest,created_at)
       values ($1,$2,$3,$4,'orphan-conversation',$5,clock_timestamp())`,
      [randomUUID(), source.id, fixture.accountId, fixture.nodeBrainId, "4".repeat(64)],
    )).rejects.toThrow("ORPHAN_CHAT_IMPORT_CHILD");
    await expect(fixture.db.query(
      `insert into imported_chat_conversations
       (id,chat_source_id,account_id,node_brain_id,external_conversation_id,identity_digest,created_at)
       values ($1,$2,$3,$4,'forged',$5,clock_timestamp())`,
      [randomUUID(), source.id, other.accountId, other.nodeBrainId, "1".repeat(64)],
    )).rejects.toThrow("CHAT_CONVERSATION_SCOPE_MISMATCH");
    await expect(fixture.db.query(
      "update imported_chat_message_versions set version=99",
    )).rejects.toThrow("IMMUTABLE_CHAT_SOURCE_RECORD");
    await expect(fixture.db.query(
      "delete from imported_chat_message_versions",
    )).rejects.toThrow("IMMUTABLE_CHAT_SOURCE_RECORD");
    await expect(fixture.db.query(
      "update chat_source_imports set manifest_digest=$1",
      ["2".repeat(64)],
    )).rejects.toThrow("IMMUTABLE_CHAT_SOURCE_RECORD");
    await expect(fixture.db.query(
      `update chat_source_cursors set chat_source_id=$1`, [randomUUID()],
    )).rejects.toThrow();
  });

  it("prevents a direct SQL cursor from regressing to an older source import", async () => {
    const fixture = await createConversationFixture("chat-import-cursor-regression");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    const first = await importChatManifest(context, manifest());
    await importChatManifest(context, manifest({
      cursor: "opaque/cursor:2",
      exportedAt: "2026-08-04T00:00:00.000Z",
      conversations: [{
        id: "conversation-1",
        participants: [
          { id: "owner-user", role: "USER" },
          { id: "source-assistant", role: "ASSISTANT" },
        ],
        messages: [
          { id: "message-1", at: AT_1, role: "USER", participantId: "owner-user", text: "Remember AAPL" },
          { id: "message-2", at: AT_2, role: "ASSISTANT", participantId: "source-assistant", text: "Stored" },
        ],
      }],
    }));
    const oldImport = await fixture.db.one<{ manifest_digest: string }>(
      "select manifest_digest from chat_source_imports where id=$1",
      [first.importId],
    );
    await expect(fixture.db.query(
      `update chat_source_cursors set
         last_import_id=$2,manifest_digest=$3,revision=revision+1,advanced_at=clock_timestamp()
       where chat_source_id=$1`,
      [first.chatSourceId, first.importId, oldImport.manifest_digest],
    )).rejects.toThrow("CHAT_CURSOR_IMPORT_MISMATCH");
  }, 20_000);

  it("serves a strict session-bound, private no-store route without external or model calls", async () => {
    const fixture = await createConversationFixture("chat-import-route");
    await authorize(fixture);
    routeState.db = fixture.db;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
    const accepted = await POST(routeRequest(fixture, manifest()));
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    expect(await accepted.json()).toMatchObject({ insertedMessages: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    const unsupported = await POST(routeRequest(fixture, manifest({
      formatVersion: "unsupported-v99" as ChatManifest["formatVersion"],
    })));
    expect(unsupported.status).toBe(400);
    expect(unsupported.headers.get("cache-control")).toBe("private, no-store");
    const conflict = await POST(routeRequest(fixture, manifest({
      conversations: [{
        ...manifest().conversations[0],
        messages: [{ ...manifest().conversations[0].messages[0], text: "cursor conflict" }],
      }],
    })));
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("private, no-store");

    const badOrigin = routeRequest(fixture, manifest());
    badOrigin.headers.set("origin", "https://attacker.example");
    expect((await POST(badOrigin)).status).toBe(403);
    expect((await POST(new Request("http://localhost:3000/api/memory/sources/import", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
    }))).status).toBe(403);
    const unknownField = await POST(routeRequest(fixture, { ...manifest(), accountId: fixture.accountId }));
    expect(unknownField.status).toBe(400);
    expect(unknownField.headers.get("cache-control")).toBe("private, no-store");

    const source = await readFile(fileURLToPath(new URL(
      "../../app/api/memory/sources/import/route.ts", import.meta.url,
    )), "utf8");
    expect(source).not.toMatch(/models|gateway|fetch\s*\(/u);
  });

  it("checks origin and declared media bounds, then authenticates before pulling the body", async () => {
    const fixture = await createConversationFixture("chat-import-route-auth-before-body");
    routeState.db = fixture.db;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request("http://localhost:3000/api/memory/sources/import", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(pulls).toBe(0);

    const unsupported = await POST(new Request(
      "http://localhost:3000/api/memory/sources/import",
      { method: "POST", headers: { "content-type": "text/plain", origin: "http://localhost:3000" }, body: "{}" },
    ));
    expect(unsupported.status).toBe(415);
    const oversized = await POST(new Request(
      "http://localhost:3000/api/memory/sources/import",
      { method: "POST", headers: {
        "content-type": "application/json", origin: "http://localhost:3000",
        "content-length": String(8 * 1024 * 1024 + 1),
      }, body: "{}" },
    ));
    expect(oversized.status).toBe(413);
  });

  it("uses fixed code-unit participant ordering for durable digests", async () => {
    const fixture = await createConversationFixture("chat-import-code-unit-order");
    await authorize(fixture);
    const participants = [
      { id: "a.user", role: "USER" as const },
      { id: "Z-user", role: "ASSISTANT" as const },
      { id: "A_user", role: "TOOL" as const },
    ];
    const imported = await importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId },
      manifest({
        conversations: [{
          id: "conversation-1", participants,
          messages: [{ id: "message-1", at: AT_1, role: "USER", participantId: "a.user", text: "ordered" }],
        }],
      }),
    );
    const row = await fixture.db.one<{ participants_digest: string; imported_event_id: string }>(
      `select participants_digest,imported_event_id::text
         from imported_chat_conversation_versions where import_id=$1`,
      [imported.importId],
    );
    const codeUnitOrdered = [participants[2], participants[1], participants[0]];
    expect(row.participants_digest).toBe(canonicalContentDigest({ participants: codeUnitOrdered }));
    expect(await readEventBody(fixture.db, row.imported_event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    })).toMatchObject({ participants: codeUnitOrdered });
  });

  it("imports 100 message authorities with query cost bounded by chunks and aggregates", async () => {
    const fixture = await createConversationFixture("chat-import-batched-authority");
    await authorize(fixture);
    const counted = countedDatabase(fixture.db);
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `message-${index}`, at: AT_1, role: "USER" as const,
      participantId: "owner-user", text: `bounded-${index}`,
    }));
    const result = await importChatManifest(
      { db: counted.db, requesterAccountId: fixture.accountId },
      manifest({
        conversations: [{
          id: "conversation-1", participants: [{ id: "owner-user", role: "USER" }], messages,
        }],
      }),
    );
    expect(result.insertedMessages).toBe(100);
    expect(counted.count()).toBeLessThanOrEqual(100);
    expect(await fixture.db.one<{ events: number; manifests: number; versions: number; occurrences: number }>(
      `select
         (select count(*)::int from events where actor_id='external-chat-importer') as events,
         (select count(*)::int from chat_source_event_manifests) as manifests,
         (select count(*)::int from imported_chat_message_versions) as versions,
         (select count(*)::int from chat_import_item_occurrences) as occurrences`,
    )).toEqual({ events: 103, manifests: 103, versions: 100, occurrences: 100 });
  }, 30_000);

  it("records canonical source, conversation, and every cursor event and replays exact source state", async () => {
    const fixture = await createConversationFixture("chat-import-canonical-replay");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    const first = await importChatManifest(context, manifest());
    const secondManifest = manifest({
      cursor: "opaque/cursor:metadata-only-2",
      exportedAt: "2026-08-04T00:00:00.000Z",
    });
    const second = await importChatManifest(context, secondManifest);
    expect(second).toMatchObject({ insertedMessages: 0, cursorRevision: 2 });

    const canonicalEvents = await fixture.db.query<{ type: string; count: number }>(
      `select type,count(*)::int as count from events
       where account_id=$1 and type in (
         'chat.source.connected','conversation.imported','chat.source.cursor_advanced'
       ) group by type order by type`,
      [fixture.accountId],
    );
    expect(canonicalEvents).toEqual([
      { type: "chat.source.connected", count: 1 },
      { type: "chat.source.cursor_advanced", count: 2 },
      { type: "conversation.imported", count: 1 },
    ]);
    expect(await fixture.db.one<{ count: number }>(
      `select count(*)::int as count from transactional_outbox o
       join events e on e.id=o.event_id
       where e.account_id=$1 and e.type in (
         'chat.source.connected','conversation.imported','chat.source.cursor_advanced'
       )`,
      [fixture.accountId],
    )).toEqual({ count: 4 });
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int as count from events where type like 'external.chat.%'",
    )).toEqual({ count: 0 });

    const replay = (chatImportModule as unknown as {
      replayChatSourceState: (
        context: ChatImportContext, chatSourceId: string,
      ) => Promise<Record<string, unknown>>;
    }).replayChatSourceState;
    expect(typeof replay).toBe("function");
    const sourceProjection = await fixture.db.one<{
      identity_digest: string; connected_event_id: string; connected_at: Date;
    }>(
      `select identity_digest,connected_event_id::text,connected_at
         from chat_sources where id=$1`,
      [first.chatSourceId],
    );
    const importProjections = await fixture.db.query<{
      id: string; cursor_event_id: string; created_at: Date;
    }>(
      `select id::text,cursor_event_id::text,created_at from chat_source_imports
        where chat_source_id=$1 order by source_revision`,
      [first.chatSourceId],
    );
    const conversationProjection = await fixture.db.one<{
      id: string; identity_digest: string; version_id: string; version_identity_digest: string;
      participants_digest: string; imported_event_id: string; import_id: string;
      predecessor_version_id: string | null; created_at: Date;
    }>(
      `select c.id::text,c.identity_digest,v.id::text as version_id,
              v.version_identity_digest,v.participants_digest,v.imported_event_id::text,
              v.import_id::text,v.predecessor_version_id::text,v.created_at
         from imported_chat_conversations c
         join imported_chat_conversation_versions v on v.imported_conversation_id=c.id
        where c.chat_source_id=$1`,
      [first.chatSourceId],
    );
    const replayed = await replay(context, first.chatSourceId);
    expect(replayed).toMatchObject({
      source: {
        chatSourceId: first.chatSourceId,
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        source: "CHATGPT_EXPORT",
        externalSourceId: "export-1",
        authorizationId: "auth-1",
        identityDigest: sourceProjection.identity_digest,
        formatVersion: "chatgpt-export-v1",
        connectedEventId: sourceProjection.connected_event_id,
        connectedAt: sourceProjection.connected_at.toISOString(),
      },
      cursor: {
        importId: second.importId,
        revision: 2,
        externalCursor: "opaque/cursor:metadata-only-2",
        externalCursorDigest: canonicalContentDigest({ cursor: "opaque/cursor:metadata-only-2" }),
        manifestDigest: canonicalContentDigest(secondManifest),
        cursorEventId: importProjections[1].cursor_event_id,
        advancedAt: importProjections[1].created_at.toISOString(),
      },
      imports: [
        {
          importId: first.importId, revision: 1, externalCursor: "opaque/cursor:1",
          externalCursorDigest: canonicalContentDigest({ cursor: "opaque/cursor:1" }),
          manifestDigest: canonicalContentDigest(manifest()), formatVersion: "chatgpt-export-v1",
          exportedAt: "2026-08-03T00:00:00.000Z", conversationCount: 1,
          itemCount: 1, quarantinedCount: 0,
          cursorEventId: importProjections[0].cursor_event_id,
          createdAt: importProjections[0].created_at.toISOString(),
        },
        {
          importId: second.importId, revision: 2,
          externalCursor: "opaque/cursor:metadata-only-2",
          externalCursorDigest: canonicalContentDigest({ cursor: "opaque/cursor:metadata-only-2" }),
          manifestDigest: canonicalContentDigest(secondManifest), formatVersion: "chatgpt-export-v1",
          exportedAt: "2026-08-04T00:00:00.000Z", conversationCount: 1,
          itemCount: 1, quarantinedCount: 0,
          cursorEventId: importProjections[1].cursor_event_id,
          createdAt: importProjections[1].created_at.toISOString(),
        },
      ],
      conversations: [{
        importedConversationId: conversationProjection.id,
        externalConversationId: "conversation-1",
        identityDigest: conversationProjection.identity_digest,
        conversationVersionId: conversationProjection.version_id,
        version: 1,
        versionIdentityDigest: conversationProjection.version_identity_digest,
        participants: manifest().conversations[0].participants,
        participantCount: 2,
        participantsDigest: conversationProjection.participants_digest,
        importedEventId: conversationProjection.imported_event_id,
        importId: conversationProjection.import_id,
        predecessorVersionId: conversationProjection.predecessor_version_id,
        createdAt: conversationProjection.created_at.toISOString(),
      }],
    });
  });

  it("serializes revocation against import and enforces a complete same-commit graph", async () => {
    const fixture = await createConversationFixture("chat-import-revocation-race");
    await authorize(fixture);
    await fixture.db.query(`
      create function block_chat_source_insert_for_test() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(77337733); return new; end; $$;
      create trigger zz_block_chat_source_insert_for_test before insert on chat_sources
      for each row execute function block_chat_source_insert_for_test();
    `);
    let releaseBlocker!: () => void;
    let blockerReady!: () => void;
    const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const ready = new Promise<void>((resolve) => { blockerReady = resolve; });
    const blocker = fixture.db.transaction(async (transaction) => {
      await transaction.query("select pg_advisory_xact_lock(77337733)");
      blockerReady();
      await release;
    });
    await ready;
    const importing = importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, manifest(),
    );
    await waitForDatabaseActivity(fixture.db, "insert into chat_sources");
    const revoking = fixture.db.query(
      "update chat_source_authorizations set revoked_at=clock_timestamp() where id='auth-1'",
    );
    await waitForDatabaseActivity(fixture.db, "update chat_source_authorizations");
    releaseBlocker();
    const imported = await importing;
    await revoking;
    await blocker;
    expect(imported.insertedMessages).toBe(1);
    await expect(importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId },
      manifest({ cursor: "opaque/cursor:after-revoke" }),
    )).rejects.toThrow("SOURCE_NOT_AUTHORIZED");
    await expect(importChatManifest(
      { db: fixture.db } as unknown as ChatImportContext,
      manifest({ cursor: "opaque/cursor:unbranded" }),
    )).rejects.toThrow("CHAT_IMPORT_ACCOUNT_REQUIRED");
    await expect(fixture.db.query(
      `insert into chat_source_imports (
         id,chat_source_id,authorization_id,account_id,node_brain_id,source_revision,
         format_version,exported_at,external_cursor_digest,manifest_digest,
         conversation_count,item_count,quarantined_count,cursor_event_id,created_at
       ) select $2,i.chat_source_id,i.authorization_id,i.account_id,i.node_brain_id,2,
                i.format_version,clock_timestamp(),$3,$4,0,0,0,i.cursor_event_id,clock_timestamp()
         from chat_source_imports i where i.id=$1`,
      [imported.importId, randomUUID(), "5".repeat(64), "6".repeat(64)],
    )).rejects.toThrow("CHAT_IMPORT_SCOPE_MISMATCH");

    expect(await fixture.db.one<{
      conversations_complete: boolean; items_complete: boolean; cursor_complete: boolean;
    }>(
      `select
         i.conversation_count=(select count(*) from chat_import_conversation_occurrences c where c.import_id=i.id)
           as conversations_complete,
         i.item_count=(select count(*) from chat_import_item_occurrences x where x.import_id=i.id)
           as items_complete,
         exists(select 1 from chat_source_cursors c
                where c.last_import_id=i.id and c.revision=i.source_revision
                  and c.cursor_event_id=i.cursor_event_id) as cursor_complete
       from chat_source_imports i where i.id=$1`,
       [imported.importId],
     )).toEqual({ conversations_complete: true, items_complete: true, cursor_complete: true });
    await expect(fixture.db.query(
      `insert into chat_import_item_occurrences (
         import_id,chat_source_id,ordinal,kind,message_version_id,
         quarantine_payload_id,record_digest,created_at
       ) select import_id,chat_source_id,99,kind,message_version_id,
                quarantine_payload_id,record_digest,clock_timestamp()
           from chat_import_item_occurrences where import_id=$1 limit 1`,
      [imported.importId],
    )).rejects.toThrow("CHAT_IMPORT_BACKFILL_FORBIDDEN");
    expect(await fixture.db.one<{ count: number }>(
      `select count(*)::int as count from pg_trigger
       where tgname in ('chat_import_graph_is_complete','chat_import_children_are_not_orphans')
         and tgrelid in ('chat_source_imports'::regclass,'chat_source_cursors'::regclass)
         and tgdeferrable and tginitdeferred`,
    )).toEqual({ count: 2 });
  }, 20_000);

  it("binds complete typed message and quarantine rows to immutable encrypted event authority", async () => {
    const fixture = await createConversationFixture("chat-import-authority-binding");
    await authorize(fixture);
    const result = await importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, manifest(),
    );
    const row = await fixture.db.one<{
      id: string; event_id: string; imported_conversation_id: string; chat_source_id: string;
      account_id: string; node_brain_id: string; external_message_id: string;
      message_identity_digest: string; version_identity_digest: string; content_digest: string;
      role: string; source_at: Date; import_id: string; created_at: Date;
    }>(
      `select id::text,event_id::text,imported_conversation_id::text,chat_source_id::text,
              account_id::text,node_brain_id::text,external_message_id,message_identity_digest,
              version_identity_digest,content_digest,role,source_at,import_id::text,created_at
       from imported_chat_message_versions where id=$1`,
      [result.messageVersionIds[0]],
    );
    const body = await readEventBody(fixture.db, row.event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    });
    expect(body).toMatchObject({
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      chatSourceId: result.chatSourceId,
      importId: result.importId,
      messageIdentityDigest: row.message_identity_digest,
      versionIdentityDigest: row.version_identity_digest,
      predecessorMessageVersionId: null,
      participantId: "owner-user",
      externalMessageId: "message-1",
      text: "Remember AAPL",
    });
    await expect(fixture.db.query(
      `insert into imported_chat_message_versions (
         id,imported_conversation_id,chat_source_id,account_id,node_brain_id,
         external_message_id,message_identity_digest,version,version_identity_digest,
         content_digest,role,source_at,event_id,import_id,
         supersedes_message_version_id,created_at
       ) values ($1,$2,$3,$4,$5,'forged-message',$6,1,$7,$8,$9,$10,$11,$12,null,$13)`,
      [randomUUID(), row.imported_conversation_id, row.chat_source_id, row.account_id,
        row.node_brain_id, "1".repeat(64), "2".repeat(64), row.content_digest,
        row.role, row.source_at, row.event_id, row.import_id, row.created_at],
    )).rejects.toThrow("CHAT_MESSAGE_AUTHORITY_MISMATCH");

    const authority = await fixture.db.one<{ count: number }>(
      `select count(*)::int as count from chat_source_event_manifests m
       join events e on e.id=m.event_id
       where m.event_id=$1 and m.event_request_hash=e.request_hash
         and m.event_integrity_hash=e.integrity_hash`,
      [row.event_id],
    );
    expect(authority).toEqual({ count: 1 });
  });

  it("enforces source-format adapters, participant metadata, and opaque cursor identity", async () => {
    const fixture = await createConversationFixture("chat-import-format-contract");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    await expect(importChatManifest(context, manifest({
      formatVersion: "unsupported-v99",
    }))).rejects.toThrow("UNSUPPORTED_CHAT_SOURCE_FORMAT");
    const accepted = await importChatManifest(context, manifest());
    expect(await fixture.db.one<{
      format_version: string; exported_at: Date; participant_count: number;
    }>(
      `select i.format_version,i.exported_at,v.participant_count
       from chat_source_imports i
       join chat_import_conversation_occurrences o on o.import_id=i.id
       join imported_chat_conversation_versions v on v.id=o.conversation_version_id
       where i.id=$1`,
      [accepted.importId],
    )).toMatchObject({ format_version: "chatgpt-export-v1", participant_count: 2 });
    await expect(importChatManifest(context, manifest({
      conversations: [{
        id: "conversation-1",
        participants: [{ id: "owner-user", role: "USER" }],
        messages: [{
          id: "message-1", at: AT_1, role: "USER", participantId: "owner-user",
          text: "Different content under the same opaque cursor",
        }],
      }],
    }))).rejects.toThrow("CHAT_CURSOR_CONTENT_CONFLICT");
  });

  it("keeps one encrypted quarantine payload with reviewable occurrences for every import", async () => {
    const owner = await createConversationFixture("chat-import-quarantine-review");
    const intruder = await createConversationFixture("chat-import-quarantine-intruder", owner.db);
    await authorize(owner);
    const context = { db: owner.db, requesterAccountId: owner.accountId };
    const invalidItem = {
      id: "bad-message", at: "not-a-time", role: "USER", participantId: "owner-user",
      text: "private quarantine payload 7d3f",
    } as const;
    const first = await importChatManifest(context, manifest({
      conversations: [{
        id: "conversation-1", participants: [{ id: "owner-user", role: "USER" }],
        messages: [invalidItem],
      }],
    }));
    const second = await importChatManifest(context, manifest({
      cursor: "opaque/cursor:quarantine-2",
      exportedAt: "2026-08-04T00:00:00.000Z",
      conversations: [{
        id: "conversation-1", participants: [{ id: "owner-user", role: "USER" }],
        messages: [invalidItem],
      }],
    }));
    expect(first.quarantinedMessages).toBe(1);
    expect(second.quarantinedMessages).toBe(1);
    const payload = await owner.db.one<{
      id: string; event_id: string; chat_source_id: string; account_id: string;
      node_brain_id: string; first_import_id: string; external_conversation_id: string;
      external_message_id: string; first_item_ordinal: number; record_digest: string; created_at: Date;
    }>(
      `select id::text,event_id::text,chat_source_id::text,account_id::text,node_brain_id::text,
              first_import_id::text,external_conversation_id,external_message_id,
              first_item_ordinal,record_digest,created_at from chat_import_quarantine`,
    );
    expect(await readEventBody(owner.db, payload.event_id, {
      actor: { role: "ACCOUNT", accountId: owner.accountId },
    })).toMatchObject({ rawItem: invalidItem, reason: "INVALID_CHAT_MESSAGE_AT" });
    await expect(readEventBody(owner.db, payload.event_id, {
      actor: { role: "ACCOUNT", accountId: intruder.accountId },
    })).rejects.toThrow("FORBIDDEN");
    await expect(owner.db.query(
      `insert into chat_import_quarantine (
         id,chat_source_id,account_id,node_brain_id,first_import_id,
         external_conversation_id,external_message_id,first_item_ordinal,
         record_digest,reason,event_id,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'FORGED_REASON',$10,$11)`,
      [randomUUID(), payload.chat_source_id, payload.account_id, payload.node_brain_id,
        payload.first_import_id, payload.external_conversation_id,
        payload.external_message_id, payload.first_item_ordinal,
        payload.record_digest, payload.event_id, payload.created_at],
    )).rejects.toThrow("CHAT_QUARANTINE_AUTHORITY_MISMATCH");
    expect(await owner.db.one<{ payloads: number; occurrences: number }>(
      `select
         (select count(*)::int from chat_import_quarantine) as payloads,
         (select count(*)::int from chat_import_quarantine_occurrences) as occurrences`,
     )).toEqual({ payloads: 1, occurrences: 2 });
    await expect(owner.db.query(
      `insert into chat_import_quarantine_occurrences
         (import_id,chat_source_id,item_ordinal,quarantine_payload_id,created_at)
       values ($1,$2,1,$3,clock_timestamp())`,
      [first.importId, payload.chat_source_id, payload.id],
    )).rejects.toThrow("CHAT_QUARANTINE_OCCURRENCE_MISMATCH");
    expect(await owner.db.one<{ exposed: boolean }>(
      `select exists (
         select 1 from chat_import_quarantine q
         where row_to_json(q)::text like '%private quarantine payload 7d3f%'
       ) as exposed`,
    )).toEqual({ exposed: false });
    expect(await owner.db.one<{ supports_maximum: boolean }>(
      `select position('10099' in pg_get_constraintdef(oid))>0 as supports_maximum
       from pg_constraint
       where conrelid='chat_import_quarantine_occurrences'::regclass
         and conname='chat_quarantine_occurrence_ordinal_bound'`,
    )).toEqual({ supports_maximum: true });
  });

  it("treats a correct optional content digest as representation metadata, not a new version", async () => {
    const fixture = await createConversationFixture("chat-import-optional-content-digest");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    const first = await importChatManifest(context, manifest());
    const semanticDigest = canonicalContentDigest({
      at: AT_1, participantId: "owner-user", role: "USER", text: "Remember AAPL",
    });
    const second = await importChatManifest(context, manifest({
      cursor: "opaque/cursor:optional-digest-2",
      exportedAt: "2026-08-05T00:00:00.000Z",
      conversations: [{
        ...manifest().conversations[0],
        messages: [{ ...manifest().conversations[0].messages[0], contentDigest: semanticDigest }],
      }],
    }));
    const third = await importChatManifest(context, manifest({
      cursor: "opaque/cursor:optional-digest-3",
      exportedAt: "2026-08-06T00:00:00.000Z",
    }));
    expect(first.insertedMessages).toBe(1);
    expect(second).toMatchObject({ insertedMessages: 0, correctedMessages: 0, cursorRevision: 2 });
    expect(third).toMatchObject({ insertedMessages: 0, correctedMessages: 0, cursorRevision: 3 });
    expect(await fixture.db.one<{ versions: number; occurrences: number; imports: number }>(
      `select
         (select count(*)::int from imported_chat_message_versions) as versions,
         (select count(*)::int from chat_import_item_occurrences) as occurrences,
         (select count(*)::int from chat_source_imports) as imports`,
    )).toEqual({ versions: 1, occurrences: 3, imports: 3 });
  });

  it("replays the complete canonical graph after disposable projections are removed", async () => {
    const fixture = await createConversationFixture("chat-import-event-rebuild");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    const first = await importChatManifest(context, manifest());
    await importChatManifest(context, manifest({
      cursor: "opaque/cursor:replay-2", exportedAt: "2026-08-05T00:00:00.000Z",
      conversations: [{
        ...manifest().conversations[0],
        messages: [{ ...manifest().conversations[0].messages[0], text: "Remember corrected AAPL" }],
      }],
    }));
    await importChatManifest(context, manifest({
      cursor: "opaque/cursor:replay-3", exportedAt: "2026-08-06T00:00:00.000Z",
      conversations: [{
        ...manifest().conversations[0],
        messages: [
          { ...manifest().conversations[0].messages[0], text: "Remember corrected AAPL" },
          { id: "bad-replay", at: "not-a-time", role: "USER", participantId: "owner-user", text: "raw replay quarantine" },
        ],
      }],
    }));
    const before = await chatImportModule.replayChatSourceState(context, first.chatSourceId);
    await fixture.db.query(`truncate table
      chat_import_quarantine_occurrences,chat_import_item_occurrences,
      chat_import_conversation_occurrences,chat_source_cursors,
      imported_chat_message_versions,imported_chat_conversation_versions,
      chat_import_quarantine,imported_chat_conversations,chat_source_imports,chat_sources`);
    const replayQueries: string[] = [];
    const pagedDatabase = {
      ...fixture.db,
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters: readonly unknown[] = [],
      ): Promise<Row[]> => {
        replayQueries.push(sql);
        return fixture.db.query<Row>(sql, parameters);
      },
    };
    const after = await chatImportModule.replayChatSourceState(
      { db: pagedDatabase, requesterAccountId: fixture.accountId }, first.chatSourceId,
    );
    expect(after).toEqual(before);
    expect(after.imports.map((entry) => entry.itemOccurrences.length)).toEqual([1, 1, 2]);
    expect(after.messageVersions).toHaveLength(2);
    expect(after.messageVersions.map((entry) => entry.version)).toEqual([1, 2]);
    expect(after.quarantinePayloads).toHaveLength(1);
    expect(after.imports[2].itemOccurrences[0]).toMatchObject({ kind: "MESSAGE_VERSION" });
    const manifestPageQueries = replayQueries.filter(
      (sql) => sql.includes("from chat_source_event_manifests"),
    );
    expect(manifestPageQueries)
      .toSatisfy((queries: string[]) => queries.length >= 1 && queries.every((sql) => /limit/iu.test(sql)));
    expect(manifestPageQueries.join("\n")).toMatch(/join events/iu);
    expect(manifestPageQueries.join("\n")).toMatch(
      /max\(.*ingested_sequence.*ingested_sequence>\$3::bigint.*ingested_sequence<=\$4::bigint/su,
    );
    expect(manifestPageQueries.join("\n")).not.toMatch(/event_id>\$3::uuid|order by event_id/iu);
  });

  it("replays an immutable ingestion-sequence snapshot across pages during a concurrent import", async () => {
    const fixture = await createConversationFixture("chat-import-replay-ingestion-snapshot");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    const messages = Array.from({ length: 101 }, (_, index) => ({
      id: `snapshot-message-${index}`, at: AT_1, role: "USER" as const,
      participantId: "owner-user", text: `snapshot-${index}`,
    }));
    const first = await importChatManifest(context, manifest({
      conversations: [{
        id: "conversation-1", participants: [{ id: "owner-user", role: "USER" }], messages,
      }],
    }));
    let concurrentStarted = false;
    let concurrentImportId: string | undefined;
    const replayQueries: string[] = [];
    const pagedDatabase: EventDatabase = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters: readonly unknown[] = [],
      ): Promise<Row[]> => {
        const rows = await fixture.db.query<Row>(sql, parameters);
        if (sql.includes("from chat_source_event_manifests")) {
          replayQueries.push(sql);
          if (!concurrentStarted) {
            concurrentStarted = true;
            vi.resetModules();
            const lowClock = vi.spyOn(Date, "now").mockReturnValue(1);
            try {
              const freshImporter = await import("../../lib/server/chat-sources/import");
              concurrentImportId = (await freshImporter.importChatManifest(context, manifest({
                cursor: "opaque/cursor:concurrent-2", exportedAt: "2026-08-04T00:00:00.000Z",
                conversations: [{
                  id: "conversation-1", participants: [{ id: "owner-user", role: "USER" }],
                  messages: [...messages, {
                    id: "snapshot-message-new", at: AT_2, role: "USER",
                    participantId: "owner-user", text: "must stay beyond snapshot",
                  }],
                }],
              }))).importId;
            } finally {
              lowClock.mockRestore();
            }
          }
        }
        return rows;
      },
      one: (sql, parameters) => fixture.db.one(sql, parameters),
      transaction: (work) => fixture.db.transaction(work),
    };
    const replayed = await chatImportModule.replayChatSourceState(
      { db: pagedDatabase, requesterAccountId: fixture.accountId }, first.chatSourceId,
    );
    expect(concurrentStarted).toBe(true);
    expect(concurrentImportId).toBeDefined();
    const cursorIds = await fixture.db.one<{ first_id: string; concurrent_id: string }>(
      `select
         (select cursor_event_id::text from chat_source_imports where id=$1) as first_id,
         (select cursor_event_id::text from chat_source_imports where id=$2) as concurrent_id`,
      [first.importId, concurrentImportId],
    );
    expect(cursorIds.concurrent_id < cursorIds.first_id).toBe(true);
    expect(replayQueries.length).toBeGreaterThan(1);
    expect(replayed.cursor.revision).toBe(1);
    expect(replayed.messageVersions).toHaveLength(101);
    expect(replayed.messageVersions.some(({ externalMessageId }) => (
      externalMessageId === "snapshot-message-new"
    ))).toBe(false);
    expect(replayQueries.join("\n")).toMatch(/ingested_sequence>\$3::bigint/iu);
    expect(replayQueries.join("\n")).not.toMatch(/event_id>\$3::uuid|order by event_id/iu);
  }, 30_000);

  it("rejects an altered ordered occurrence graph and an orphan canonical T20 event", async () => {
    const fixture = await createConversationFixture("chat-import-bidirectional-completeness");
    await authorize(fixture);
    await fixture.db.query(`
      create function shift_chat_item_ordinal_for_test() returns trigger language plpgsql as $$
      begin new.ordinal := new.ordinal + 1; return new; end; $$;
      create trigger zz_shift_chat_item_ordinal_for_test
      before insert on chat_import_item_occurrences
      for each row execute function shift_chat_item_ordinal_for_test();
    `);
    const tampered = await importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, manifest(),
    ).then(() => null, (error: unknown) => error);
    const orphan = await appendEvent(fixture.db, {
      aggregateId: randomUUID(), accountId: fixture.accountId,
      actor: { type: "SYSTEM", id: "external-chat-importer" },
      type: "chat.source.cursor_advanced", visibility: "PRIVATE_ACCOUNT",
      idempotencyKey: `orphan-chat-cursor:${randomUUID()}`,
      policyVersion: "external-chat-import-v1", body: { orphan: true },
    }).then(() => null, (error: unknown) => error);
    expect(tampered).toBeInstanceOf(Error);
    expect((tampered as Error).message).toMatch(
      /(?:CHAT_IMPORT_OCCURRENCE_MANIFEST_MISMATCH|INCOMPLETE_CHAT_IMPORT_GRAPH)/u,
    );
    expect(orphan).toBeInstanceOf(Error);
    expect((orphan as Error).message).toContain("ORPHAN_T20_CANONICAL_EVENT");
  });

  it.each([
    ["missing-policy", "external-chat-importer", undefined],
    ["wrong-policy", "external-chat-importer", "external-chat-import-wrong-policy"],
    ["wrong-actor", "forged-chat-importer", "external-chat-import-v1"],
  ] as const)("reserves canonical T20 type against %s orphan events", async (
    caseName, actorId, policyVersion,
  ) => {
    const fixture = await createConversationFixture(`chat-import-reverse-authority-${caseName}`);
    const eventInput = {
      aggregateId: randomUUID(), accountId: fixture.accountId,
      actor: { type: "SYSTEM" as const, id: actorId },
      type: "chat.source.connected", visibility: "PRIVATE_ACCOUNT" as const,
      idempotencyKey: `orphan-chat-authority:${caseName}:${randomUUID()}`,
      body: { orphan: true },
      ...(policyVersion === undefined ? {} : { policyVersion }),
    };
    await expect(appendEvent(fixture.db, eventInput)).rejects.toThrow("ORPHAN_T20_CANONICAL_EVENT");
  });

  it.each([
    ["wrong-policy", "new.policy_version := 'external-chat-import-wrong-policy';"],
    ["wrong-actor", "new.actor_id := 'forged-chat-importer';"],
  ] as const)("rejects a %s canonical event even when a manifest/projection graph is attempted", async (
    caseName, mutation,
  ) => {
    const fixture = await createConversationFixture(`chat-import-forward-authority-${caseName}`);
    await authorize(fixture);
    await fixture.db.query(`
      create function replace_chat_event_authority_for_test() returns trigger language plpgsql as $$
      begin
        if new.actor_type='SYSTEM' and new.actor_id='external-chat-importer'
           and new.type='chat.source.connected' then
          ${mutation}
        end if;
        return new;
      end; $$;
      create trigger zz_replace_chat_event_authority_for_test before insert on events
      for each row execute function replace_chat_event_authority_for_test();
    `);
    await expect(importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, manifest(),
    )).rejects.toThrow("CHAT_EVENT_AUTHORITY_MISMATCH");
  });

  it.each([
    ["swapped", "new.ordinal := 201 - new.ordinal;"],
    ["wrong-digest", "new.record_digest := repeat('f',64);"],
  ] as const)("rejects a %s per-import occurrence set", async (caseName, mutation) => {
    const fixture = await createConversationFixture(`chat-import-occurrence-${caseName}`);
    await authorize(fixture);
    await fixture.db.query(`
      create function mutate_chat_item_occurrence_for_test() returns trigger language plpgsql as $$
      begin ${mutation} return new; end; $$;
      create trigger zz_mutate_chat_item_occurrence_for_test
      before insert on chat_import_item_occurrences
      for each row execute function mutate_chat_item_occurrence_for_test();
    `);
    const twoItems = manifest({
      messageCount: 2,
      conversations: [{
        ...manifest().conversations[0],
        messages: [
          manifest().conversations[0].messages[0],
          { id: "message-2", at: AT_2, role: "ASSISTANT", participantId: "source-assistant", text: "Second item" },
        ],
      }],
    });
    await expect(importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, twoItems,
    )).rejects.toThrow(/(?:CHAT_ITEM_OCCURRENCE_MISMATCH|INCOMPLETE_CHAT_IMPORT_GRAPH)/u);
  });

  it.each([
    ["SOURCE_CONNECTED", "source='CLAUDE_EXPORT'"],
    ["CURSOR_ADVANCED", "manifest_digest=repeat('f',64)"],
    ["CONVERSATION_VERSION", "participants_digest=repeat('f',64)"],
    ["MESSAGE_VERSION", "record_digest=repeat('f',64)"],
    ["QUARANTINE_PAYLOAD", "reason='REPLAY_BODY_MISMATCH'"],
  ] as const)("recomputes the complete %s authority header from its encrypted body", async (
    kind, mutation,
  ) => {
    const fixture = await createConversationFixture(`chat-import-replay-header-${kind.toLowerCase()}`);
    await authorize(fixture);
    const imported = await importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId },
      manifest({
        conversations: [{
          id: "conversation-1", participants: [{ id: "owner-user", role: "USER" }],
          messages: [
            { id: "message-1", at: AT_1, role: "USER", participantId: "owner-user", text: "valid" },
            { id: "bad-message", at: "not-a-time", role: "USER", participantId: "owner-user", text: "quarantine" },
          ],
        }],
      }),
    );
    await fixture.db.transaction(async (transaction) => {
      await transaction.query("set local session_replication_role='replica'");
      await transaction.query(
        `update chat_source_event_manifests set ${mutation} where kind=$1`, [kind],
      );
    });
    await expect(chatImportModule.replayChatSourceState(
      { db: fixture.db, requesterAccountId: fixture.accountId }, imported.chatSourceId,
    )).rejects.toThrow("CHAT_REPLAY_INTEGRITY_FAILURE");
  }, 30_000);

  it("binds quarantine occurrence scope and conversation ordinal exactly to its payload", async () => {
    const fixture = await createConversationFixture("chat-import-quarantine-occurrence-binding");
    await authorize(fixture);
    await fixture.db.query(`
      create function shift_chat_quarantine_conversation_for_test() returns trigger language plpgsql as $$
      begin new.conversation_ordinal := (new.conversation_ordinal + 1) % 100; return new; end; $$;
      create trigger aa_shift_chat_quarantine_conversation_for_test
      before insert on chat_import_quarantine_occurrences
      for each row execute function shift_chat_quarantine_conversation_for_test();
    `);
    await expect(importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId },
      manifest({ conversations: [{
        id: "conversation-1", participants: [{ id: "owner-user", role: "USER" }],
        messages: [{
          id: "bad-message", at: "not-a-time", role: "USER",
          participantId: "owner-user", text: "reviewable",
        }],
      }] }),
    )).rejects.toThrow("CHAT_QUARANTINE_OCCURRENCE_MISMATCH");
  });

  it("rejects cross-conversation conversation and message correction predecessors in SQL", async () => {
    const fixture = await createConversationFixture("chat-import-correction-predecessors");
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    const twoConversationManifest = manifest({
      conversationCount: 2, messageCount: 2,
      conversations: [
        manifest().conversations[0],
        {
          id: "conversation-2",
          participants: manifest().conversations[0].participants,
          messages: [{ id: "message-2", at: AT_1, role: "USER", participantId: "owner-user", text: "Second" }],
        },
      ],
    });
    await importChatManifest(context, twoConversationManifest);
    await fixture.db.query(`
      create function cross_chat_correction_predecessor_for_test() returns trigger language plpgsql as $$
      begin
        select v.id into new.predecessor_version_id
          from imported_chat_conversation_versions v
         where v.imported_conversation_id<>new.imported_conversation_id limit 1;
        return new;
      end; $$;
      create trigger zz_cross_chat_correction_predecessor_for_test
      before insert on imported_chat_conversation_versions
      for each row when (new.version>1)
      execute function cross_chat_correction_predecessor_for_test();
      create function cross_message_correction_predecessor_for_test() returns trigger language plpgsql as $$
      begin
        select v.id into new.supersedes_message_version_id
          from imported_chat_message_versions v
         where v.imported_conversation_id<>new.imported_conversation_id limit 1;
        return new;
      end; $$;
      create trigger zz_cross_message_correction_predecessor_for_test
      before insert on imported_chat_message_versions
      for each row when (new.version>1)
      execute function cross_message_correction_predecessor_for_test();
    `);
    const corrected = {
      ...twoConversationManifest,
      cursor: "opaque/cursor:cross-predecessor-2",
      exportedAt: "2026-08-05T00:00:00.000Z",
      conversations: twoConversationManifest.conversations.map((conversation, index) => ({
        ...conversation,
        participants: [...conversation.participants, { id: `tool-${index}`, role: "TOOL" as const }],
        messages: conversation.messages.map((message) => ({ ...message, text: `${message.text} corrected` })),
      })),
    };
    await expect(importChatManifest(context, corrected))
      .rejects.toThrow(/(?:CHAT_(?:CONVERSATION|MESSAGE)_VERSION_MISMATCH|ORPHAN_CHAT_EVENT_MANIFEST)/u);
  });

  it.each([
    ["skipped", "new.version := new.version + 1;"],
    ["unchanged", "select content_digest into new.content_digest from imported_chat_message_versions where id=new.supersedes_message_version_id;"],
    ["identity-change", "new.message_identity_digest := repeat('f',64);"],
  ] as const)("rejects a %s direct SQL message correction", async (_caseName, mutation) => {
    const fixture = await createConversationFixture(`chat-import-message-${_caseName}`);
    await authorize(fixture);
    const context = { db: fixture.db, requesterAccountId: fixture.accountId };
    await importChatManifest(context, manifest());
    await fixture.db.query(`
      create function mutate_chat_message_correction_for_test() returns trigger language plpgsql as $$
      begin ${mutation} return new; end; $$;
      create trigger zz_mutate_chat_message_correction_for_test
      before insert on imported_chat_message_versions
      for each row when (new.version>1)
      execute function mutate_chat_message_correction_for_test();
    `);
    await expect(importChatManifest(context, manifest({
      cursor: `opaque/cursor:${_caseName}-2`, exportedAt: "2026-08-05T00:00:00.000Z",
      conversations: [{
        ...manifest().conversations[0],
        messages: [{ ...manifest().conversations[0].messages[0], text: `${_caseName} correction` }],
      }],
    }))).rejects.toThrow(
      /(?:CHAT_MESSAGE_VERSION_MISMATCH|ORPHAN_CHAT_EVENT_MANIFEST|INCOMPLETE_CHAT_IMPORT_GRAPH)/u,
    );
  });

  it("rejects unchanged and cross-account direct SQL conversation predecessors", async () => {
    const owner = await createConversationFixture("chat-import-conversation-cross-account");
    const other = await createConversationFixture("chat-import-conversation-cross-account-other", owner.db);
    await authorize(owner);
    await authorize(other, { id: "auth-other", sourceId: "export-other" });
    const ownerContext = { db: owner.db, requesterAccountId: owner.accountId };
    await importChatManifest(ownerContext, manifest());
    await importChatManifest(
      { db: other.db, requesterAccountId: other.accountId },
      manifest({ ownerAuthorizationId: "auth-other", sourceId: "export-other" }),
    );
    await owner.db.query(`
      create function mutate_chat_conversation_correction_for_test() returns trigger language plpgsql as $$
      begin
        select v.id into new.predecessor_version_id
          from imported_chat_conversation_versions v where v.account_id<>new.account_id limit 1;
        select v.participants_digest into new.participants_digest
          from imported_chat_conversation_versions v where v.id=new.predecessor_version_id;
        return new;
      end; $$;
      create trigger zz_mutate_chat_conversation_correction_for_test
      before insert on imported_chat_conversation_versions
      for each row when (new.version>1)
      execute function mutate_chat_conversation_correction_for_test();
    `);
    await expect(importChatManifest(ownerContext, manifest({
      cursor: "opaque/cursor:cross-account-2", exportedAt: "2026-08-05T00:00:00.000Z",
      conversations: [{
        ...manifest().conversations[0],
        participants: [...manifest().conversations[0].participants, { id: "tool-cross", role: "TOOL" }],
      }],
    }))).rejects.toThrow(
      /(?:CHAT_CONVERSATION_VERSION_MISMATCH|ORPHAN_CHAT_EVENT_MANIFEST|INCOMPLETE_CHAT_IMPORT_GRAPH)/u,
    );
  });

  it("quarantines malformed conversations, continues valid siblings, and uses the item ordinal namespace", async () => {
    const fixture = await createConversationFixture("chat-import-conversation-quarantine");
    await authorize(fixture);
    const malformed = { id: "broken-conversation", participants: "not-an-array", messages: [] };
    const malformedShape = { id: "broken-shape", participants: [], unexpected: true };
    const mixed = {
      ...manifest(), conversationCount: 3, messageCount: 3,
      conversations: [malformed, malformedShape, manifest().conversations[0]],
    };
    const imported = await importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId }, mixed,
    );
    expect(imported).toMatchObject({ insertedMessages: 1, quarantinedMessages: 2 });
    expect(await fixture.db.one<{
      source_conversations: number; conversations: number; items: number;
      quarantines: number; minimum_item_ordinal: number; maximum_item_ordinal: number;
    }>(
      `select i.conversation_count as source_conversations,
              (select count(*)::int from chat_import_conversation_occurrences where import_id=i.id) as conversations,
              (select count(*)::int from chat_import_item_occurrences where import_id=i.id) as items,
              (select count(*)::int from chat_import_quarantine_occurrences where import_id=i.id) as quarantines,
              (select min(ordinal) from chat_import_item_occurrences where import_id=i.id) as minimum_item_ordinal,
              (select max(ordinal) from chat_import_item_occurrences where import_id=i.id) as maximum_item_ordinal
         from chat_source_imports i where i.id=$1`,
      [imported.importId],
    )).toEqual({
      source_conversations: 3, conversations: 1, items: 3, quarantines: 2,
      minimum_item_ordinal: 100, maximum_item_ordinal: 102,
    });
    const quarantines = await fixture.db.query<{
      event_id: string; item_scope: string; conversation_ordinal: number;
    }>(
      `select event_id::text,item_scope,conversation_ordinal
         from chat_import_quarantine order by conversation_ordinal`,
    );
    expect(quarantines).toMatchObject([
      { item_scope: "CONVERSATION", conversation_ordinal: 0 },
      { item_scope: "CONVERSATION", conversation_ordinal: 1 },
    ]);
    expect(await readEventBody(fixture.db, quarantines[0].event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    })).toMatchObject({ rawItem: malformed, itemScope: "CONVERSATION", conversationOrdinal: 0 });
    expect(await readEventBody(fixture.db, quarantines[1].event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    })).toMatchObject({ rawItem: malformedShape, itemScope: "CONVERSATION", conversationOrdinal: 1 });
    expect(await fixture.db.one<{ maximum_supported: boolean }>(
      `select position('10099' in pg_get_constraintdef(oid))>0 as maximum_supported
         from pg_constraint where conrelid='chat_import_item_occurrences'::regclass
          and conname='chat_import_item_occurrence_ordinal_bound'`,
    )).toEqual({ maximum_supported: true });
  });

  it("reaches ordinal 10099 for the bounded 100-conversation and 10000-item manifest", async () => {
    const fixture = await createConversationFixture("chat-import-maximum-ordinal");
    await authorize(fixture);
    const invalidMessage = {
      id: "invalid-at-maximum", at: "not-a-time", role: "USER",
      participantId: "owner-user", text: "bounded invalid item",
    } as const;
    const conversations = Array.from({ length: 100 }, (_, conversationIndex) => ({
      id: `conversation-${conversationIndex}`,
      participants: [{ id: "owner-user", role: "USER" as const }],
      messages: Array.from({ length: 100 }, () => invalidMessage),
    }));
    const imported = await importChatManifest(
      { db: fixture.db, requesterAccountId: fixture.accountId },
      manifest({ conversations, conversationCount: 100, messageCount: 10_000 }),
    );
    expect(imported).toMatchObject({ insertedMessages: 0, quarantinedMessages: 10_000 });
    expect(await fixture.db.one<{
      conversations: number; items: number; quarantines: number;
      minimum_ordinal: number; maximum_ordinal: number; payloads: number;
    }>(
      `select
         (select count(*)::int from chat_import_conversation_occurrences where import_id=$1) as conversations,
         (select count(*)::int from chat_import_item_occurrences where import_id=$1) as items,
         (select count(*)::int from chat_import_quarantine_occurrences where import_id=$1) as quarantines,
         (select min(ordinal) from chat_import_item_occurrences where import_id=$1) as minimum_ordinal,
         (select max(ordinal) from chat_import_item_occurrences where import_id=$1) as maximum_ordinal,
         (select count(*)::int from chat_import_quarantine where first_import_id=$1) as payloads`,
      [imported.importId],
    )).toEqual({
      conversations: 100, items: 10_000, quarantines: 10_000,
      minimum_ordinal: 100, maximum_ordinal: 10_099, payloads: 100,
    });
    const replayed = await chatImportModule.replayChatSourceState(
      { db: fixture.db, requesterAccountId: fixture.accountId }, imported.chatSourceId,
    );
    expect(replayed.imports[0].itemOccurrences).toHaveLength(10_000);
    expect(replayed.quarantinePayloads).toHaveLength(100);
  }, 120_000);
});
