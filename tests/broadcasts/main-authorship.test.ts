import { randomUUID } from "node:crypto";
import type { EventDatabase } from "../../lib/server/events/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitBroadcast,
  projectDelivery,
} from "../../lib/server/main-brain/broadcasts";
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import {
  createConversationFixture,
  testContext,
  type ConversationFixture,
} from "../helpers/postgres";

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

import { POST } from "../../app/api/broadcasts/route";

function deliveryRequest(
  fixture: ConversationFixture,
  body: unknown,
  origin = "https://gustavo.lol",
): Request {
  return new Request("https://gustavo.lol/api/broadcasts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `__Host-gustavo-session=${fixture.sessionToken}`,
      origin,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  routeState.db = undefined;
  vi.unstubAllEnvs();
});

describe("Main broadcasts", () => {
  it("fans out one committed immutable semantic body without Node authorship", async () => {
    const aFixture = await createConversationFixture("broadcast-a");
    const bFixture = await createConversationFixture("broadcast-b", aFixture.db);
    const broadcast = await commitBroadcast(
      { db: aFixture.db },
      {
        mainStateVersion: 7,
        body: "AAPL is testing completed support.",
        sourceIds: ["price-z", "price-a", "price-z"],
      },
    );
    const a = await projectDelivery({ db: aFixture.db }, broadcast.id, {
      accountId: aFixture.accountId,
      nodeBrainId: aFixture.nodeBrainId,
      locale: "en-US",
    });
    const b = await projectDelivery({ db: aFixture.db }, broadcast.id, {
      accountId: bFixture.accountId,
      nodeBrainId: bFixture.nodeBrainId,
      locale: "en-US",
    });

    expect(broadcast.sourceIds).toEqual(["price-a", "price-z"]);
    expect(broadcast.bodyDigest).toBe(
      canonicalContentDigest("AAPL is testing completed support."),
    );
    expect(a.body).toBe(b.body);
    expect(a.bodyDigest).toBe(b.bodyDigest);
    expect(a.author).toEqual({ type: "MAIN_BRAIN", stateVersion: 7 });
    expect(b.author).toEqual(a.author);
    expect(a).not.toHaveProperty("nodeAuthoredBody");
    expect(Object.isFrozen(a)).toBe(true);

    expect(
      await readEventBody(aFixture.db, broadcast.commitEventId, {
        actor: { role: "SYSTEM" },
      }),
    ).toMatchObject({
      author: { type: "MAIN_BRAIN", stateVersion: 7 },
      body: "AAPL is testing completed support.",
      bodyDigest: broadcast.bodyDigest,
      sourceIds: ["price-a", "price-z"],
    });
    expect(
      await aFixture.db.one(
        `select
           count(distinct b.id)::int as broadcast_count,
           count(distinct d.id)::int as delivery_count,
           count(distinct e.id)::int as event_count,
           count(distinct o.id)::int as outbox_count,
           bool_and(d.created_at >= b.committed_at) as committed_before_delivery
         from broadcasts b
         join deliveries d on d.broadcast_id=b.id
         join events e on e.id in (b.commit_event_id, d.delivery_event_id)
         join transactional_outbox o on o.event_id=e.id
         where b.id=$1`,
        [broadcast.id],
      ),
    ).toEqual({
      broadcast_count: 1,
      delivery_count: 2,
      event_count: 3,
      outbox_count: 3,
      committed_before_delivery: true,
    });
  }, 30_000);

  it("rejects invalid Main state, body, sources, and conflicting broadcast retries", async () => {
    const ctx = await testContext();
    const valid = {
      mainStateVersion: 1,
      body: "Completed structure remains range-bound.",
      sourceIds: ["source-1"],
      idempotencyKey: "cycle-1",
    } as const;

    await expect(
      commitBroadcast(ctx, { ...valid, mainStateVersion: 0 }),
    ).rejects.toThrow("BROADCAST_MAIN_STATE_VERSION_INVALID");
    await expect(
      commitBroadcast(ctx, { ...valid, body: " " }),
    ).rejects.toThrow("BROADCAST_BODY_INVALID");
    await expect(
      commitBroadcast(ctx, { ...valid, body: "Buy now before the move." }),
    ).rejects.toThrow("BROADCAST_POLICY_REJECTED");
    await expect(
      commitBroadcast(ctx, { ...valid, sourceIds: [] }),
    ).rejects.toThrow("BROADCAST_SOURCES_INVALID");
    await expect(
      commitBroadcast(ctx, { ...valid, sourceIds: [" "] }),
    ).rejects.toThrow("BROADCAST_SOURCE_ID_INVALID");

    const committed = await commitBroadcast(ctx, valid);
    const replay = await commitBroadcast(ctx, valid);
    expect(replay).toEqual(committed);
    await expect(
      commitBroadcast(ctx, { ...valid, body: "Different semantics." }),
    ).rejects.toThrow("BROADCAST_IDEMPOTENCY_KEY_REUSED");
  }, 30_000);

  it.each([
    "You should buy AAPL in your real account; profit is guaranteed",
    "Y.o.u should h-o-l-d AAPL for your portfolio.",
    "You should bυy AAPL now.",
    "You should b.υ.y AAPL now.",
    "Please ѕеӏӏ AAPL now.",
    "Please ѕ.е.ӏ.ӏ AAPL now.",
    "ＳＥＬＬ　ＮＯＷ before price falls.",
    "Based on your finances, you need to short this stock.",
    "This trade cannot lose and has zero risk.",
    "Place a limit order through your broker.",
    "Send your brokerage credentials and account number.",
    "This is not a simulation; copy this trade with real money.",
    "Execute this live trade immediately.",
    "Our instruction: b.u.y AAPL today.",
    "This cannot fail and has no downside.",
    "Broker access is available for limit-order entry.",
    "Purchase AAPL now.",
    "I advise buying AAPL now.",
    "You should acquire AAPL.",
    "Consider disposing of AAPL.",
    "Our recommendation is holding AAPL.",
    "You should be purchasing AAPL.",
    "AAPL should be sold now.",
    "Acquiring AAPL is recommended.",
    "Close the AAPL position.",
    "Trade AAPL now.",
    "Short AAPL.",
    "Open a position.",
  ])("rejects adversarial instruction language: %s", async (body) => {
    const ctx = await testContext();
    await expect(
      commitBroadcast(ctx, {
        mainStateVersion: 2,
        body,
        sourceIds: ["policy-source"],
      }),
    ).rejects.toThrow("BROADCAST_POLICY_REJECTED");
    expect(await ctx.db.one("select count(*)::int as count from broadcasts")).toEqual({ count: 0 });
    expect(await ctx.db.one("select count(*)::int as count from events")).toEqual({ count: 0 });
  }, 30_000);

  it.each([
    "AAPL is testing completed support.",
    "Buying pressure rose, but no profit is guaranteed.",
    "Investors who hold AAPL remain exposed to price risk.",
    "Completed-candle slippage can widen around the open.",
    "Price can rise or fall; no outcome is certain.",
    "A breakout cannot be guaranteed.",
    "Certain stocks remained range-bound.",
    "Certain stocks rise while others fall.",
    "The symbols AΔ and ΩMEGA remained near completed support.",
    "Цена осталась около поддержки.",
    "Investors bought AAPL during the prior quarter.",
    "The fund acquired AAPL last quarter; price later fell.",
    "Opening volume increased while closing prices remained range-bound.",
    "Historical purchasing activity rose after earnings.",
    "Trade volume increased after the open.",
    "Short interest increased after earnings.",
    "Open interest rose while price remained range-bound.",
  ])("accepts educational price commentary: %s", async (body) => {
    const ctx = await testContext();
    await expect(
      commitBroadcast(ctx, {
        mainStateVersion: 2,
        body,
        sourceIds: ["educational-source"],
      }),
    ).resolves.toMatchObject({ body });
  }, 30_000);

  it("does not let negation in one clause whitelist a later guarantee", async () => {
    const ctx = await testContext();
    for (const body of [
      "No outcome is certain. Profit is guaranteed.",
      "Profit is not guaranteed and the outcome is guaranteed.",
      "No outcome is certain while the upside is guaranteed.",
      "Returns are not guaranteed though profit is guaranteed.",
      "Profit is not guaranteed because the outcome is guaranteed.",
      "Profit is guaranteed because no outcome is certain.",
      "Profit is g.u.a.r.a.n.t.e.e.d.",
    ]) {
      await expect(
        commitBroadcast(ctx, {
          mainStateVersion: 2,
          body,
          sourceIds: ["clause-policy-source"],
        }),
      ).rejects.toThrow("BROADCAST_POLICY_REJECTED");
    }
    expect(await ctx.db.one("select count(*)::int as count from broadcasts")).toEqual({ count: 0 });
  }, 30_000);

  it("serializes concurrent broadcast and delivery retries", async () => {
    const fixture = await createConversationFixture("broadcast-concurrency");
    const input = {
      mainStateVersion: 9,
      body: "MSFT has not confirmed a breakout.",
      sourceIds: ["bar-2", "bar-1"],
      idempotencyKey: "market-cycle-9",
    } as const;
    const broadcasts = await Promise.all(
      Array.from({ length: 6 }, () => commitBroadcast({ db: fixture.db }, input)),
    );
    expect(new Set(broadcasts.map(({ id }) => id)).size).toBe(1);

    const deliveries = await Promise.all(
      Array.from({ length: 6 }, () =>
        projectDelivery({ db: fixture.db }, broadcasts[0].id, {
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          locale: "en-US",
        }),
      ),
    );
    expect(new Set(deliveries.map(({ id }) => id)).size).toBe(1);
    expect(
      await fixture.db.one(
        "select count(*)::int as count from deliveries where broadcast_id=$1",
        [broadcasts[0].id],
      ),
    ).toEqual({ count: 1 });
  }, 30_000);

  it("binds a delivery retry to the canonical full transport request", async () => {
    const fixture = await createConversationFixture("broadcast-transport-retry");
    const broadcast = await commitBroadcast(
      { db: fixture.db },
      {
        mainStateVersion: 10,
        body: "AAPL remains within its completed range.",
        sourceIds: ["bar-10"],
      },
    );
    const input = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      locale: "en-us",
    } as const;
    const first = await projectDelivery({ db: fixture.db }, broadcast.id, input);
    const replay = await projectDelivery(
      { db: fixture.db },
      broadcast.id,
      { ...input, locale: "en-US" },
    );
    expect(replay).toEqual(first);
    expect(first.locale).toBe("en-US");
    expect(
      await fixture.db.one("select request_digest from deliveries where id=$1", [first.id]),
    ).toEqual({
      request_digest: canonicalContentDigest({
        accountId: fixture.accountId,
        broadcastId: broadcast.id,
        locale: "en-US",
        nodeBrainId: fixture.nodeBrainId,
      }),
    });

    await expect(
      projectDelivery(
        { db: fixture.db },
        broadcast.id,
        { ...input, locale: "fr-FR" },
      ),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(await fixture.db.one("select count(*)::int as count from deliveries")).toEqual({ count: 1 });
    expect(
      await fixture.db.one(
        "select count(*)::int as count from events where type='main.broadcast.delivered'",
      ),
    ).toEqual({ count: 1 });
  }, 30_000);

  it("makes PostgreSQL authoritative for the supported canonical locale subset", async () => {
    const fixture = await createConversationFixture("broadcast-locale-sql");
    const broadcast = await commitBroadcast(
      { db: fixture.db },
      {
        mainStateVersion: 12,
        body: "AAPL remains near completed support.",
        sourceIds: ["bar-12"],
      },
    );
    const event = await appendEvent(fixture.db, {
      aggregateId: broadcast.id,
      accountId: fixture.accountId,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.broadcast.delivered",
      visibility: "PRIVATE_ACCOUNT",
      body: { test: "direct-sql-locale-boundary" },
      idempotencyKey: "direct-sql-locale-boundary",
      causationId: broadcast.commitEventId,
      policyVersion: "main-broadcast-policy-v1",
    });

    for (const locale of ["EN-us", "en--US", "123"]) {
      await expect(
        fixture.db.query(
          `insert into deliveries (
             id, broadcast_id, account_id, node_brain_id, body_digest,
             author_type, main_state_version, locale, request_digest,
             delivery_event_id
           ) values ($1,$2,$3,$4,$5,'MAIN_BRAIN',$6,$7,$8,$9)`,
          [
            randomUUID(),
            broadcast.id,
            fixture.accountId,
            fixture.nodeBrainId,
            broadcast.bodyDigest,
            broadcast.mainStateVersion,
            locale,
            canonicalContentDigest({ locale }),
            event.id,
          ],
        ),
      ).rejects.toThrow();
    }
    expect(
      await fixture.db.query<{ readonly locale: string; readonly canonical: boolean }>(
        `select locale, is_canonical_broadcast_locale(locale) as canonical
         from unnest($1::text[]) as locale`,
        [["en", "en-US", "zh-Hant", "zh-Hant-TW", "es-419"]],
      ),
    ).toEqual([
      { locale: "en", canonical: true },
      { locale: "en-US", canonical: true },
      { locale: "zh-Hant", canonical: true },
      { locale: "zh-Hant-TW", canonical: true },
      { locale: "es-419", canonical: true },
    ]);
    await fixture.db.query(
      `insert into deliveries (
         id, broadcast_id, account_id, node_brain_id, body_digest,
         author_type, main_state_version, locale, request_digest,
         delivery_event_id
       ) values ($1,$2,$3,$4,$5,'MAIN_BRAIN',$6,$7,$8,$9)`,
      [
        randomUUID(),
        broadcast.id,
        fixture.accountId,
        fixture.nodeBrainId,
        broadcast.bodyDigest,
        broadcast.mainStateVersion,
        "en-US",
        canonicalContentDigest({ locale: "en-US" }),
        event.id,
      ],
    );
    expect(await fixture.db.one("select locale from deliveries")).toEqual({ locale: "en-US" });
  }, 30_000);

  it("makes PostgreSQL authoritative for delivery causation and policy provenance", async () => {
    const base = await createConversationFixture("broadcast-audit-base");
    const falseCauseRecipient = await createConversationFixture("broadcast-audit-cause", base.db);
    const wrongPolicyRecipient = await createConversationFixture("broadcast-audit-policy", base.db);
    const broadcast = await commitBroadcast(
      { db: base.db },
      {
        mainStateVersion: 13,
        body: "AAPL remains below completed resistance.",
        sourceIds: ["bar-13"],
      },
    );
    const unrelatedCause = await appendEvent(base.db, {
      aggregateId: randomUUID(),
      actor: { type: "SYSTEM", id: "audit-test" },
      type: "audit.test.cause",
      visibility: "SHARED",
      body: { test: true },
      idempotencyKey: "broadcast-audit-unrelated-cause",
    });
    const falseCauseEvent = await appendEvent(base.db, {
      aggregateId: broadcast.id,
      accountId: falseCauseRecipient.accountId,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.broadcast.delivered",
      visibility: "PRIVATE_ACCOUNT",
      body: { test: "false-cause" },
      idempotencyKey: "broadcast-audit-false-cause",
      causationId: unrelatedCause.id,
      policyVersion: "main-broadcast-policy-v1",
    });
    const wrongPolicyEvent = await appendEvent(base.db, {
      aggregateId: broadcast.id,
      accountId: wrongPolicyRecipient.accountId,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.broadcast.delivered",
      visibility: "PRIVATE_ACCOUNT",
      body: { test: "wrong-policy" },
      idempotencyKey: "broadcast-audit-wrong-policy",
      causationId: broadcast.commitEventId,
      policyVersion: "wrong-policy",
    });

    async function directDelivery(
      fixture: ConversationFixture,
      deliveryEventId: string,
    ): Promise<void> {
      await base.db.query(
        `insert into deliveries (
           id, broadcast_id, account_id, node_brain_id, body_digest,
           author_type, main_state_version, locale, request_digest,
           delivery_event_id
         ) values ($1,$2,$3,$4,$5,'MAIN_BRAIN',$6,'en-US',$7,$8)`,
        [
          randomUUID(),
          broadcast.id,
          fixture.accountId,
          fixture.nodeBrainId,
          broadcast.bodyDigest,
          broadcast.mainStateVersion,
          canonicalContentDigest({
            accountId: fixture.accountId,
            broadcastId: broadcast.id,
            locale: "en-US",
            nodeBrainId: fixture.nodeBrainId,
          }),
          deliveryEventId,
        ],
      );
    }

    await expect(
      directDelivery(falseCauseRecipient, falseCauseEvent.id),
    ).rejects.toThrow("BROADCAST_DELIVERY_EVENT_INVALID");
    await expect(
      directDelivery(wrongPolicyRecipient, wrongPolicyEvent.id),
    ).rejects.toThrow("BROADCAST_DELIVERY_EVENT_INVALID");

    await expect(
      projectDelivery(
        { db: base.db },
        broadcast.id,
        {
          accountId: falseCauseRecipient.accountId,
          nodeBrainId: falseCauseRecipient.nodeBrainId,
          locale: "en-US",
        },
      ),
    ).resolves.toMatchObject({
      accountId: falseCauseRecipient.accountId,
      deliveryEventId: expect.any(String),
    });
  }, 30_000);

  it("allows only one canonical transport request across concurrent conflicts", async () => {
    const fixture = await createConversationFixture("broadcast-transport-race");
    const broadcast = await commitBroadcast(
      { db: fixture.db },
      {
        mainStateVersion: 11,
        body: "SPY is retesting a completed level.",
        sourceIds: ["bar-11"],
      },
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        projectDelivery(
          { db: fixture.db },
          broadcast.id,
          {
            accountId: fixture.accountId,
            nodeBrainId: fixture.nodeBrainId,
            locale: index % 2 === 0 ? "en-US" : "fr-FR",
          },
        ),
      ),
    );
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(4);
    expect(
      rejected.every(
        (attempt) => attempt.reason instanceof Error
          && attempt.reason.message === "IDEMPOTENCY_KEY_REUSED",
      ),
    ).toBe(true);
    expect(await fixture.db.one("select count(*)::int as count from deliveries")).toEqual({ count: 1 });
    expect(
      await fixture.db.one(
        "select count(*)::int as count from events where type='main.broadcast.delivered'",
      ),
    ).toEqual({ count: 1 });
  }, 30_000);

  it("authorizes the active account and its stable Node before delivery creation", async () => {
    const owner = await createConversationFixture("broadcast-owner");
    const other = await createConversationFixture("broadcast-other", owner.db);
    const broadcast = await commitBroadcast(
      { db: owner.db },
      { mainStateVersion: 3, body: "SPY remains below resistance.", sourceIds: ["bar-1"] },
    );

    await expect(
      projectDelivery({ db: owner.db }, broadcast.id, {
        accountId: owner.accountId,
        nodeBrainId: other.nodeBrainId,
        locale: "en-US",
      }),
    ).rejects.toThrow("BROADCAST_DELIVERY_FORBIDDEN");
    await owner.db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [owner.accountId]);
    await expect(
      projectDelivery({ db: owner.db }, broadcast.id, {
        accountId: owner.accountId,
        nodeBrainId: owner.nodeBrainId,
        locale: "en-US",
      }),
    ).rejects.toThrow("BROADCAST_DELIVERY_FORBIDDEN");
    expect(
      await owner.db.one("select count(*)::int as count from deliveries"),
    ).toEqual({ count: 0 });
    expect(
      await owner.db.one(
        "select count(*)::int as count from events where type='main.broadcast.delivered'",
      ),
    ).toEqual({ count: 0 });
  }, 30_000);

  it("blocks SQL mutation of committed semantics and stores no plaintext body projection", async () => {
    const fixture = await createConversationFixture("broadcast-immutable");
    const broadcast = await commitBroadcast(
      { db: fixture.db },
      { mainStateVersion: 4, body: "QQQ has a provisional active bar.", sourceIds: ["bar-4"] },
    );
    const delivery = await projectDelivery({ db: fixture.db }, broadcast.id, {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      locale: "en-US",
    });

    await expect(
      fixture.db.query("update broadcasts set body_digest=$2 where id=$1", [broadcast.id, "0".repeat(64)]),
    ).rejects.toThrow("IMMUTABLE_BROADCAST");
    await expect(
      fixture.db.query("update broadcasts set author_type='NODE_BRAIN' where id=$1", [broadcast.id]),
    ).rejects.toThrow("IMMUTABLE_BROADCAST");
    await expect(
      fixture.db.query("update deliveries set body_digest=$2 where id=$1", [delivery.id, "0".repeat(64)]),
    ).rejects.toThrow("IMMUTABLE_DELIVERY_SEMANTICS");
    await expect(
      fixture.db.query("update deliveries set author_type='NODE_BRAIN' where id=$1", [delivery.id]),
    ).rejects.toThrow("IMMUTABLE_DELIVERY_SEMANTICS");
    await expect(
      fixture.db.query("update deliveries set request_digest=$2 where id=$1", [delivery.id, "0".repeat(64)]),
    ).rejects.toThrow("IMMUTABLE_DELIVERY_SEMANTICS");
    await expect(
      fixture.db.query("update deliveries set locale='fr-FR' where id=$1", [delivery.id]),
    ).rejects.toThrow("IMMUTABLE_DELIVERY_SEMANTICS");
    expect(
      await fixture.db.one(
        `select count(*)::int as count
         from information_schema.columns
         where table_schema=current_schema()
           and table_name in ('broadcasts', 'deliveries')
           and column_name in ('body', 'node_authored_body')`,
      ),
    ).toEqual({ count: 0 });
  }, 30_000);

  it("rolls back delivery and its audit event when outbox persistence fails", async () => {
    const fixture = await createConversationFixture("broadcast-rollback");
    const broadcast = await commitBroadcast(
      { db: fixture.db },
      { mainStateVersion: 5, body: "IWM is testing a confirmed level.", sourceIds: ["level-5"] },
    );
    await fixture.db.query(`
      create function reject_broadcast_delivery_outbox() returns trigger language plpgsql as $$
      begin
        if new.topic = 'main.broadcast.delivered' then
          raise exception 'TEST_BROADCAST_DELIVERY_OUTBOX_FAILURE';
        end if;
        return new;
      end;
      $$;
      create trigger reject_broadcast_delivery_outbox before insert on transactional_outbox
      for each row execute function reject_broadcast_delivery_outbox();
    `);

    await expect(
      projectDelivery({ db: fixture.db }, broadcast.id, {
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        locale: "en-US",
      }),
    ).rejects.toThrow("TEST_BROADCAST_DELIVERY_OUTBOX_FAILURE");
    expect(await fixture.db.one("select count(*)::int as count from deliveries")).toEqual({ count: 0 });
    expect(
      await fixture.db.one(
        "select count(*)::int as count from events where type='main.broadcast.delivered'",
      ),
    ).toEqual({ count: 0 });
  }, 30_000);

  it("enforces origin, session, strict input, generic failures, and private no-store route output", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fixture = await createConversationFixture("broadcast-route");
    routeState.db = fixture.db;
    const broadcast = await commitBroadcast(
      { db: fixture.db },
      { mainStateVersion: 6, body: "DIA is near completed support.", sourceIds: ["dia-6"] },
    );
    const payload = {
      broadcastId: broadcast.id,
      nodeBrainId: fixture.nodeBrainId,
      locale: "en-US",
    };

    const foreign = await POST(deliveryRequest(fixture, payload, "https://evil.example"));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "INVALID_ORIGIN" });
    expect(await fixture.db.one("select count(*)::int as count from deliveries")).toEqual({ count: 0 });

    const semanticMutation = await POST(
      deliveryRequest(fixture, { ...payload, body: "changed" }),
    );
    expect(semanticMutation.status).toBe(400);
    expect(await semanticMutation.json()).toEqual({ error: "INVALID_BROADCAST_DELIVERY_BODY" });

    const accepted = await POST(deliveryRequest(fixture, payload));
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    expect(await accepted.json()).toMatchObject({
      broadcastId: broadcast.id,
      body: "DIA is near completed support.",
      author: { type: "MAIN_BRAIN", stateVersion: 6 },
    });

    const transportConflict = await POST(
      deliveryRequest(fixture, { ...payload, locale: "fr-FR" }),
    );
    expect(transportConflict.status).toBe(409);
    expect(await transportConflict.json()).toEqual({ error: "IDEMPOTENCY_KEY_REUSED" });

    const missingSession = new Request("https://gustavo.lol/api/broadcasts", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://gustavo.lol" },
      body: JSON.stringify(payload),
    });
    expect((await POST(missingSession)).status).toBe(401);

    routeState.db = {
      async query() { throw new Error("SECRET_DATABASE_FAILURE"); },
      async one() { throw new Error("SECRET_DATABASE_FAILURE"); },
      async transaction() { throw new Error("SECRET_DATABASE_FAILURE"); },
    };
    const failed = await POST(deliveryRequest(fixture, payload));
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('{"error":"BROADCAST_DELIVERY_FAILED"}');
  }, 30_000);

  it("bounds declared bytes, streamed bytes, and locale before database access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const identifiers = {
      broadcastId: randomUUID(),
      nodeBrainId: randomUUID(),
    };
    const declaredOversize = new Request("https://gustavo.lol/api/broadcasts", {
      method: "POST",
      headers: {
        "content-length": "100000",
        "content-type": "application/json",
        origin: "https://gustavo.lol",
      },
      body: JSON.stringify({ ...identifiers, locale: "en-US" }),
    });
    const declared = await POST(declaredOversize);
    expect(declared.status).toBe(413);
    expect(declared.headers.get("cache-control")).toBe("private, no-store");
    expect(await declared.json()).toEqual({ error: "REQUEST_BODY_TOO_LARGE" });

    const actualOversize = new Request("https://gustavo.lol/api/broadcasts", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://gustavo.lol" },
      body: JSON.stringify({ ...identifiers, locale: "en-US", padding: "x".repeat(5_000) }),
    });
    const actual = await POST(actualOversize);
    expect(actual.status).toBe(413);
    expect(await actual.json()).toEqual({ error: "REQUEST_BODY_TOO_LARGE" });

    const longLocale = new Request("https://gustavo.lol/api/broadcasts", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://gustavo.lol" },
      body: JSON.stringify({ ...identifiers, locale: `en-${"a".repeat(80)}` }),
    });
    const locale = await POST(longLocale);
    expect(locale.status).toBe(400);
    expect(await locale.json()).toEqual({ error: "INVALID_BROADCAST_DELIVERY_BODY" });
    // routeState.db remains unset: any database/session access would have produced a generic 500.
    expect(routeState.db).toBeUndefined();
  });

  it("does not make external calls while validating and committing a broadcast", async () => {
    const ctx = await testContext();
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => { throw new Error("BROADCAST_MUST_NOT_FETCH"); });
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      await commitBroadcast(ctx, {
        mainStateVersion: 8,
        body: "A completed candle is required before confirmation.",
        sourceIds: [randomUUID()],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);
});
