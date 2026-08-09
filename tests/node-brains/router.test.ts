import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import { appendMessage } from "../../lib/server/history/messages";
import {
  MAX_NODE_ROUTE_SOURCE_IDS,
  MIN_ROUTING_CONFIDENCE,
  NODE_REPLY_MODES,
  NODE_ROUTING_POLICY_VERSION,
  routeNodeReply,
  routeNodeTurn,
  type RouteNodeReplyInput,
} from "../../lib/server/node-brains/router";
import {
  createConversationFixture,
  type ConversationFixture,
} from "../helpers/postgres";

const MAIN_STATE_VERSION = "main-state-v17";

interface UserTurnFixture extends ConversationFixture {
  readonly userMessageEventId: string;
}

function classification(
  overrides: Partial<Parameters<typeof routeNodeTurn>[0]> = {},
): Parameters<typeof routeNodeTurn>[0] {
  return {
    coveredByMain: false,
    contradiction: false,
    materialEvidence: false,
    confidence: 0.9,
    mainStateVersion: MAIN_STATE_VERSION,
    sourceIds: ["019c42f4-e5fc-7c89-b42f-15a569c34b3b"],
    ...overrides,
  };
}

async function userTurn(
  label: string,
  database?: ConversationFixture["db"],
): Promise<UserTurnFixture> {
  const fixture = await createConversationFixture(label, database);
  const message = await appendMessage(fixture, {
    idempotencyKey: `${label}-user-turn`,
    role: "USER",
    text: `User turn for ${label}`,
  });
  return { ...fixture, userMessageEventId: message.eventId };
}

function replyInput(
  fixture: UserTurnFixture,
  overrides: Partial<RouteNodeReplyInput> = {},
): RouteNodeReplyInput {
  return {
    ...classification({ sourceIds: [fixture.userMessageEventId] }),
    db: fixture.db,
    accountId: fixture.accountId,
    conversationId: fixture.conversationId,
    nodeBrainId: fixture.nodeBrainId,
    userMessageEventId: fixture.userMessageEventId,
    ...overrides,
  };
}

async function routingEventCount(fixture: UserTurnFixture): Promise<number> {
  const row = await fixture.db.one<{ readonly count: number }>(
    "select count(*)::int as count from events where idempotency_key=$1",
    [`node-route:${fixture.userMessageEventId}`],
  );
  return row.count;
}

describe("routeNodeTurn", () => {
  it("uses Main by default, explores ambiguity, and proposes only material improvements", () => {
    expect(routeNodeTurn({ coveredByMain: true, contradiction: false, materialEvidence: false, confidence: 0.9 }).mode).toBe("MAIN_DEFAULT");
    expect(routeNodeTurn({ coveredByMain: false, contradiction: true, materialEvidence: false, confidence: 0.4 }).mode).toBe("NODE_EXPLORE");
    expect(routeNodeTurn({ coveredByMain: false, contradiction: true, materialEvidence: true, confidence: 0.9 }).mode).toBe("PROPOSAL_UPSTREAM");
  });

  it.each([
    ["agreement", { agreementCount: 50 }],
    ["popularity", { popularityCount: 50_000 }],
    ["repetition", { repetitionCount: 50 }],
    ["payment", { paid: true }],
  ] as const)("does not treat %s as material evidence", (_name, excludedSignal) => {
    expect(
      routeNodeTurn(classification({ confidence: 0.99, ...excludedSignal })).mode,
    ).not.toBe("PROPOSAL_UPSTREAM");
  });

  it("uses exactly the three approved modes", () => {
    expect(NODE_REPLY_MODES).toEqual([
      "MAIN_DEFAULT",
      "NODE_EXPLORE",
      "PROPOSAL_UPSTREAM",
    ]);
    expect(new Set(NODE_REPLY_MODES).size).toBe(3);
  });

  it("applies the confidence threshold inclusively and explores below it", () => {
    expect(
      routeNodeTurn(
        classification({ confidence: MIN_ROUTING_CONFIDENCE, materialEvidence: true }),
      ).mode,
    ).toBe("PROPOSAL_UPSTREAM");
    expect(
      routeNodeTurn(
        classification({
          confidence: MIN_ROUTING_CONFIDENCE - Number.EPSILON,
          materialEvidence: true,
        }),
      ),
    ).toMatchObject({ mode: "NODE_EXPLORE", reason: "LOW_CONFIDENCE" });
  });

  it("fails conflicting semantic classifications closed as non-canonical exploration", () => {
    expect(
      routeNodeTurn(
        classification({
          coveredByMain: true,
          contradiction: true,
          materialEvidence: true,
        }),
      ),
    ).toMatchObject({
      mode: "NODE_EXPLORE",
      reason: "CONFLICTING_CLASSIFICATION",
      response: {
        canonical: false,
        authority: "NODE",
        label: "NODE EXPLORATION — NOT AN ACCEPTED MAIN POSITION",
      },
    });
  });

  it("labels exploration non-canonical while Main-default remains version-bound", () => {
    expect(routeNodeTurn(classification({ confidence: 0.2 })).response).toEqual({
      canonical: false,
      authority: "NODE",
      label: "NODE EXPLORATION — NOT AN ACCEPTED MAIN POSITION",
    });
    expect(routeNodeTurn(classification({ coveredByMain: true })).response).toEqual({
      canonical: true,
      authority: "MAIN",
      label: "MAIN POSITION",
    });
  });

  it("canonicalizes and freezes bounded source provenance", () => {
    const result = routeNodeTurn(
      classification({
        confidence: 0.83,
        sourceIds: ["source-z", "source-a", "source-z"],
      }),
    );

    expect(result).toMatchObject({
      classificationConfidence: 0.83,
      mainStateVersion: MAIN_STATE_VERSION,
      policyVersion: NODE_ROUTING_POLICY_VERSION,
    });
    expect(result.sourceIds).toEqual(["source-a", "source-z"]);
    expect(Object.isFrozen(result.sourceIds)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() =>
      routeNodeTurn(
        classification({
          sourceIds: Array.from(
            { length: MAX_NODE_ROUTE_SOURCE_IDS + 1 },
            (_, index) => `source-${index}`,
          ),
        }),
      ),
    ).toThrow("NODE_ROUTE_SOURCE_LIMIT_EXCEEDED");
  });

  it.each([
    [{ coveredByMain: "yes" }, "NODE_ROUTE_INPUT_INVALID"],
    [{ contradiction: null }, "NODE_ROUTE_INPUT_INVALID"],
    [{ materialEvidence: 1 }, "NODE_ROUTE_INPUT_INVALID"],
    [{ confidence: Number.NaN }, "NODE_ROUTE_CONFIDENCE_INVALID"],
    [{ confidence: -0.001 }, "NODE_ROUTE_CONFIDENCE_INVALID"],
    [{ confidence: 1.001 }, "NODE_ROUTE_CONFIDENCE_INVALID"],
    [{ mainStateVersion: " " }, "NODE_ROUTE_MAIN_STATE_VERSION_INVALID"],
    [{ sourceIds: [""] }, "NODE_ROUTE_SOURCE_ID_INVALID"],
    [{ policyVersion: "different-policy" }, "NODE_ROUTE_POLICY_VERSION_CONFLICT"],
    [{ agreementCount: -1 }, "NODE_ROUTE_EXCLUDED_SIGNAL_INVALID"],
    [{ popularityCount: Number.POSITIVE_INFINITY }, "NODE_ROUTE_EXCLUDED_SIGNAL_INVALID"],
    [{ repetitionCount: 0.5 }, "NODE_ROUTE_EXCLUDED_SIGNAL_INVALID"],
    [{ paid: "true" }, "NODE_ROUTE_EXCLUDED_SIGNAL_INVALID"],
  ])("rejects invalid input %j before selecting a route", (override, code) => {
    expect(() =>
      routeNodeTurn({
        ...classification(),
        ...override,
      } as Parameters<typeof routeNodeTurn>[0]),
    ).toThrow(code);
  });

  it("is deterministic and performs no model or external call", () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error("ROUTER_MUST_NOT_FETCH");
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      expect(routeNodeTurn(classification({ materialEvidence: true }))).toEqual(
        routeNodeTurn(classification({ materialEvidence: true })),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a missing classification object without selecting a route", () => {
    expect(() =>
      routeNodeTurn(null as unknown as Parameters<typeof routeNodeTurn>[0]),
    ).toThrow("NODE_ROUTE_INPUT_INVALID");
  });
});

describe("routeNodeReply", () => {
  it("authorizes and commits node.reply.routed before generation continues", async () => {
    const fixture = await userTurn("route-order");
    const continueGeneration = vi.fn(async () => {
      expect(await routingEventCount(fixture)).toBe(1);
      return "generated response";
    });

    const routed = await routeNodeReply(replyInput(fixture), continueGeneration);

    expect(continueGeneration).toHaveBeenCalledWith(routed.route);
    expect(routed.output).toBe("generated response");
    expect(
      await fixture.db.one(
        `select account_id, actor_type, actor_id, type, visibility,
                idempotency_key, causation_id::text, policy_version
         from events where id=$1`,
        [routed.routingEventId],
      ),
    ).toEqual({
      account_id: fixture.accountId,
      actor_type: "NODE_BRAIN",
      actor_id: fixture.nodeBrainId,
      type: "node.reply.routed",
      visibility: "PRIVATE_ACCOUNT",
      idempotency_key: `node-route:${fixture.userMessageEventId}`,
      causation_id: fixture.userMessageEventId,
      policy_version: NODE_ROUTING_POLICY_VERSION,
    });
    expect(
      await readEventBody(fixture.db, routed.routingEventId, {
        actor: { role: "SYSTEM" },
      }),
    ).toEqual({
      classificationConfidence: 0.9,
      mainStateVersion: MAIN_STATE_VERSION,
      mode: "NODE_EXPLORE",
      policyVersion: NODE_ROUTING_POLICY_VERSION,
      reason: "CLARIFICATION_REQUIRED",
      response: {
        authority: "NODE",
        canonical: false,
        label: "NODE EXPLORATION — NOT AN ACCEPTED MAIN POSITION",
      },
      sourceIds: [fixture.userMessageEventId],
    });
  }, 30_000);

  it("rejects mixed-account, conversation, Node, and source-message graphs before append or generation", async () => {
    const owner = await userTurn("route-owner");
    const other = await userTurn("route-other", owner.db);
    const nodeMessage = await appendMessage(owner, {
      idempotencyKey: "node-event-is-not-user-input",
      role: "NODE",
      text: "Node response",
    });
    const generate = vi.fn(async () => "must not run");
    const mismatches: readonly Partial<RouteNodeReplyInput>[] = [
      { accountId: other.accountId },
      { conversationId: other.conversationId },
      { nodeBrainId: other.nodeBrainId },
      {
        userMessageEventId: other.userMessageEventId,
        sourceIds: [other.userMessageEventId],
      },
      {
        userMessageEventId: nodeMessage.eventId,
        sourceIds: [nodeMessage.eventId],
      },
    ];

    for (const mismatch of mismatches) {
      await expect(
        routeNodeReply(replyInput(owner, mismatch), generate),
      ).rejects.toThrow("NODE_ROUTE_SOURCE_FORBIDDEN");
    }
    expect(generate).not.toHaveBeenCalled();
    expect(
      await owner.db.one(
        "select count(*)::int as count from events where type='node.reply.routed'",
      ),
    ).toEqual({ count: 0 });
  }, 30_000);

  it("rejects non-native, wrong-actor, and non-private source events", async () => {
    const fixture = await userTurn("route-event-shape");
    const events = [
      await appendEvent(fixture.db, {
        aggregateId: fixture.conversationId,
        accountId: fixture.accountId,
        actor: { type: "USER", id: fixture.accountId },
        type: "not.a.native.message",
        visibility: "PRIVATE_ACCOUNT",
        body: { test: true },
        idempotencyKey: "wrong-type-user-event",
      }),
      await appendEvent(fixture.db, {
        aggregateId: fixture.conversationId,
        accountId: fixture.accountId,
        actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
        type: "participant.message.created",
        visibility: "PRIVATE_ACCOUNT",
        body: { test: true },
        idempotencyKey: "wrong-actor-user-event",
      }),
      await appendEvent(fixture.db, {
        aggregateId: fixture.conversationId,
        actor: { type: "USER", id: fixture.accountId },
        type: "participant.message.created",
        visibility: "SHARED",
        body: { test: true },
        idempotencyKey: "wrong-visibility-user-event",
      }),
    ];
    const generate = vi.fn(async () => "must not run");

    for (const event of events) {
      await expect(
        routeNodeReply(
          replyInput(fixture, {
            userMessageEventId: event.id,
            sourceIds: [event.id],
          }),
          generate,
        ),
      ).rejects.toThrow("NODE_ROUTE_SOURCE_FORBIDDEN");
    }
    expect(generate).not.toHaveBeenCalled();
    expect(
      await fixture.db.one(
        "select count(*)::int as count from events where type='node.reply.routed'",
      ),
    ).toEqual({ count: 0 });
  }, 30_000);

  it.each([
    ["account", "update accounts set status='SUSPENDED' where id=$1"],
    ["entitlement", "update entitlements set revoked_at=clock_timestamp() where account_id=$1"],
    ["Node", "update node_brains set status='PAUSED' where account_id=$1"],
    ["conversation", "update conversations set status='ARCHIVED' where account_id=$1"],
  ])("rejects an inactive %s identity edge", async (label, sql) => {
    const fixture = await userTurn(`route-inactive-${label}`);
    await fixture.db.query(sql, [fixture.accountId]);
    const generate = vi.fn(async () => "must not run");

    await expect(
      routeNodeReply(replyInput(fixture), generate),
    ).rejects.toThrow("NODE_ROUTE_SOURCE_FORBIDDEN");
    expect(generate).not.toHaveBeenCalled();
    expect(await routingEventCount(fixture)).toBe(0);
  }, 30_000);

  it("rolls back a failed durable append and never starts generation", async () => {
    const fixture = await userTurn("route-append-failure");
    await fixture.db.query(`
      create function reject_node_route_outbox() returns trigger language plpgsql as $$
      begin
        if new.topic = 'node.reply.routed' then
          raise exception 'TEST_NODE_ROUTE_OUTBOX_FAILURE';
        end if;
        return new;
      end;
      $$;
      create trigger reject_node_route_outbox before insert on transactional_outbox
      for each row execute function reject_node_route_outbox();
    `);
    const generate = vi.fn(async () => "must not run");

    await expect(routeNodeReply(replyInput(fixture), generate)).rejects.toThrow(
      "TEST_NODE_ROUTE_OUTBOX_FAILURE",
    );
    expect(generate).not.toHaveBeenCalled();
    expect(await routingEventCount(fixture)).toBe(0);
  }, 30_000);

  it("replays sequential retries from one immutable route event", async () => {
    const fixture = await userTurn("route-sequential");
    const first = await routeNodeReply(replyInput(fixture), async () => "first");
    const second = await routeNodeReply(replyInput(fixture), async () => "second");

    expect(second.routingEventId).toBe(first.routingEventId);
    expect(await routingEventCount(fixture)).toBe(1);
  }, 30_000);

  it("serializes concurrent retries to one immutable route event", async () => {
    const fixture = await userTurn("route-concurrent");
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        routeNodeReply(replyInput(fixture), async () => `response-${index}`),
      ),
    );

    expect(new Set(results.map((result) => result.routingEventId)).size).toBe(1);
    expect(await routingEventCount(fixture)).toBe(1);
  }, 30_000);

  it("rejects conflicting classification on the same source before second generation", async () => {
    const fixture = await userTurn("route-conflict");
    const generate = vi.fn(async () => "generated");
    await routeNodeReply(replyInput(fixture), generate);

    await expect(
      routeNodeReply(
        replyInput(fixture, { materialEvidence: true }),
        generate,
      ),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await routingEventCount(fixture)).toBe(1);
  }, 30_000);

  it("reuses the committed route after generation failure", async () => {
    const fixture = await userTurn("route-generation-retry");
    await expect(
      routeNodeReply(replyInput(fixture), async () => {
        throw new Error("GENERATION_FAILED");
      }),
    ).rejects.toThrow("GENERATION_FAILED");
    const stored = await fixture.db.one<{ readonly id: string }>(
      "select id::text from events where idempotency_key=$1",
      [`node-route:${fixture.userMessageEventId}`],
    );

    const retried = await routeNodeReply(
      replyInput(fixture),
      async () => "retry succeeded",
    );
    expect(retried.routingEventId).toBe(stored.id);
    expect(retried.output).toBe("retry succeeded");
    expect(await routingEventCount(fixture)).toBe(1);
  }, 30_000);

  it("fails closed on malformed routing context before database access", async () => {
    const generate = vi.fn(async () => "must not run");
    await expect(
      routeNodeReply(
        null as unknown as RouteNodeReplyInput,
        generate,
      ),
    ).rejects.toThrow("NODE_ROUTE_CONTEXT_INVALID");
    expect(generate).not.toHaveBeenCalled();
  });
});
