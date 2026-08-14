import type { ComponentProps, FormEvent } from "react";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type { EventDatabase } from "../../lib/server/events/types";
import { generateOpaqueToken } from "../../lib/server/auth/sessions";
import { appendMessage } from "../../lib/server/history/messages";
import { storeLatestMarketWindow } from "../../lib/server/market-data/latest";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import {
  PROPOSAL_STATUSES,
  type ProposalStatus,
} from "../../lib/server/orchestration/proposals";
import {
  commitBroadcast,
  projectDelivery,
} from "../../lib/server/main-brain/broadcasts";
import {
  processPaperOrder,
  submitPaperIntent,
} from "../../lib/server/challenge/orders";
import {
  appendChallengeLedgerEvent,
  loadChallengeLedgerEvents,
  replaceProjectionCheckpoint,
} from "../../lib/server/challenge/ledger";
import { replayStoredLedgerEvents } from "../../lib/server/challenge/projection";
import {
  createConversationFixture,
  testChallengeContext,
  type ChallengeFixture,
  type ConversationFixture,
} from "../helpers/postgres";
import {
  Conversation,
  submitConversationMessage,
} from "../../components/chat/Conversation";
import { ChallengeSummary } from "../../components/challenge/ChallengeSummary";
import { MarketStatus } from "../../components/market/MarketStatus";
import { MARKET_UNIVERSE } from "../../config/market-universe";

const pageState = vi.hoisted(() => ({
  db: undefined as EventDatabase | undefined,
  token: undefined as string | undefined,
}));

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

vi.mock("../../lib/server/db/postgres", () => ({
  getDatabase(): EventDatabase {
    if (!pageState.db) throw new Error("TEST_DATABASE_NOT_READY");
    return pageState.db;
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => pageState.token === undefined ? undefined : { value: pageState.token },
  }),
}));

vi.mock("next/cache", () => ({ unstable_noStore: vi.fn() }));

import ChatPage from "../../app/(account)/chat/page";
import ChallengePage from "../../app/(challenge)/challenge/page";
import MarketPage, { loadMarketPageData } from "../../app/(account)/market/page";
import {
  GET as getMemory,
  POST as mutateMemory,
} from "../../app/api/memory/route";
import { GET as getAccountExport } from "../../app/api/account/export/route";
import {
  loadAccountChallenge,
  loadAccountConversation,
  loadAccountMarket,
} from "../../lib/server/dal/account-surfaces";

describe("authenticated account surfaces", () => {
  it("shows queued/offline chat state and all 95 private market statuses without public serialization", async () => {
    const chat = renderToStaticMarkup(<Conversation
      conversationId="018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f"
      messages={[]}
      broadcasts={[]}
      nextCursor={null}
      bridge={{ status: "OFFLINE", pendingJobs: 1, safeCode: "LOCAL_BRIDGE_UNAVAILABLE" }}
    />);
    const market = renderToStaticMarkup(<MarketStatus items={MARKET_UNIVERSE.map((item) => ({
      ...item,
      status: "UNAVAILABLE" as const,
      price: null,
      sourceObservedAt: null,
      receivedAt: "2026-08-13T13:35:00.000Z",
      ageSeconds: null,
      freshness: "Unavailable" as const,
      safeCode: "LOCAL_BRIDGE_UNAVAILABLE" as const,
    }))} />);

    expect(chat).toContain("Message saved — local processing unavailable");
    expect(chat).toContain("1 queued");
    expect(market.match(/data-market-symbol=/g)).toHaveLength(95);
    expect(market).toContain("AAPL");
    expect(market).toContain("ARKK");
    expect(market).toMatch(/Fresh|Stale|Unavailable/);
    expect(market).not.toMatch(/ciphertext|providerKey|tunnelSecret|private operator prompt/i);

    const loadMarket = vi.fn();
    await expect(loadMarketPageData({
      getSession: vi.fn().mockResolvedValue(null),
      loadMarket,
    })).rejects.toThrow("AUTHENTICATION_REQUIRED");
    expect(loadMarket).not.toHaveBeenCalled();
  });

  it("never renders a price for unavailable data or hidden fields supplied outside the DTO", () => {
    const unavailable = {
      symbol: "AAPL",
      kind: "STOCK" as const,
      status: "UNAVAILABLE" as const,
      price: "999999.99",
      sourceObservedAt: null,
      receivedAt: "2026-08-13T13:35:00.000Z",
      ageSeconds: null,
      freshness: "Unavailable" as const,
      safeCode: "LOCAL_BRIDGE_UNAVAILABLE" as const,
      ciphertext: "protected-ciphertext",
      providerKey: "private-provider-key",
      tunnelSecret: "private-tunnel-secret",
      rawProviderResponse: "private-raw-response",
      hostname: "private-hostname",
      prompt: "private operator prompt",
    };
    const quotaChat = renderToStaticMarkup(<Conversation
      conversationId="018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f"
      messages={[{ id: "saved", author: "USER", text: "Committed message" }]}
      bridge={{ status: "QUOTA_LIMITED", pendingJobs: 2, safeCode: "LOCAL_BRIDGE_QUOTA_EXHAUSTED" }}
    />);
    const markup = renderToStaticMarkup(<MarketStatus items={[unavailable]} />);

    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("999999.99");
    expect(markup).not.toMatch(
      /protected-ciphertext|private-provider-key|private-tunnel-secret|private-raw-response|private-hostname|private operator prompt/i,
    );
    expect(quotaChat).toContain("Committed message");
    expect(quotaChat).toContain("Message saved — local processing quota limited");
    expect(quotaChat).toContain("2 queued");
    expect(quotaChat).toContain('href="/market"');
  });

  it("labels Node routing, Main authorship, memory controls, and simulation", () => {
    const markup = renderToStaticMarkup(
      <>
        <Conversation
          conversationId="10000000-0000-4000-8000-000000000001"
          messages={[{
            id: "m1",
            author: "NODE_BRAIN",
            routingMode: "MAIN_DEFAULT",
            text: "Completed support remains intact.",
            occurredAt: "2026-08-12T14:30:00.000Z",
          }]}
          broadcasts={[{
            id: "b1",
            author: "MAIN_BRAIN",
            text: "Main Brain scheduled market context.",
            occurredAt: "2026-08-12T14:31:00.000Z",
          }]}
          proposalDisclosure
        />
        <ChallengeSummary
          stage={{
            startingBalance: "2500.00",
            targetEquity: "2750.00",
            equity: "2500.00",
            status: "ACTIVE",
          }}
        />
      </>,
    );

    expect(markup).toContain("Main Brain");
    expect(markup).toContain("MAIN_DEFAULT");
    expect(markup).toMatch(/qualifying feedback may be summarized/i);
    expect(markup).toContain("Inspect memories");
    expect(markup).toContain("Export my data");
    expect(markup).toContain("SIMULATION ONLY — NOT A REAL TRADE");
    expect(markup).toContain("$2,500.00 → $2,750.00");
  });

  it("renders only account-safe DTO fields with paper terminology, costs, and times", () => {
    const protectedText = "cross-account protected thesis";
    const foreignAccount = "account-b";
    const stage = {
      startingBalance: "2500.00",
      targetEquity: "2750.00",
      equity: "2512.30",
      status: "ACTIVE" as const,
      updatedAt: "2026-08-12T15:00:00.000Z",
      accountId: foreignAccount,
      protectedText,
    };
    const markup = renderToStaticMarkup(
      <ChallengeSummary
        stage={stage}
        positions={[{
          id: "position-1",
          symbol: "AAPL",
          direction: "PAPER_LONG",
          quantity: "2",
          averagePrice: "100.00",
          markPrice: "101.25",
          unrealizedPnl: "2.50",
          simulatedCosts: "1.00",
          observedAt: "2026-08-12T14:59:00.000Z",
          freshness: "DELAYED — 900 seconds",
        }]}
        ledger={[{
          id: "ledger-1",
          type: "fee.recorded",
          occurredAt: "2026-08-12T14:59:01.000Z",
          amount: "1.00",
          simulatedCosts: "1.00",
        }]}
      />,
    );

    expectTypeOf<ComponentProps<typeof ChallengeSummary>["stage"]>()
      .toEqualTypeOf<import("../../components/challenge/ChallengeSummary").ChallengeStageDto | undefined>();
    expect(markup).toContain("paper long");
    expect(markup).toContain("Simulated costs");
    expect(markup).toContain("DELAYED — 900 seconds");
    expect(markup).toContain('dateTime="2026-08-12T14:59:00.000Z"');
    expect(markup).toContain("$2,512.30");
    expect(markup).not.toContain(protectedText);
    expect(markup).not.toContain(foreignAccount);
  });

  it("keeps mutation forms explicit, accessible, and server-authorized", () => {
    const markup = renderToStaticMarkup(
      <Conversation
        conversationId="10000000-0000-4000-8000-000000000001"
        messages={[]}
      />,
    );

    expect(markup).toContain('<form aria-label="Send a message" method="post">');
    expect(markup).toMatch(/<form aria-label="Send a message" method="post"><fieldset disabled=""/u);
    expect(markup).not.toContain("?text=");
    expect(markup).toContain('aria-label="Correct a memory"');
    expect(markup).toContain('for="corrected-memory"');
    expect(markup).toContain('<button type="button">Export my data</button>');
    expect(markup).toContain('aria-label="Forget this conversation"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("required");
    expect(markup).toContain("I understand this action is permanent");
    expect(markup).toContain("This permanently makes the conversation content unavailable.");
  });

  it("resets the captured form after a deferred successful message response", async () => {
    let resolveResponse!: (response: Response) => void;
    let targetAvailable = true;
    const form = { reset: vi.fn() } as unknown as HTMLFormElement;
    const event = {
      preventDefault: vi.fn(),
      get currentTarget() {
        return targetAvailable ? form : null as unknown as HTMLFormElement;
      },
    } as unknown as FormEvent<HTMLFormElement>;
    const status = vi.fn();
    const reload = vi.fn();
    const submitted = submitConversationMessage(
      event,
      "10000000-0000-4000-8000-000000000001",
      status,
      {
        fetch: vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })),
        formData: () => ({ get: () => "hello" } as unknown as FormData),
        randomUUID: () => "20000000-0000-4000-8000-000000000002",
        reload,
      },
    );
    targetAvailable = false;
    resolveResponse(new Response(null, { status: 201 }));
    await submitted;

    expect(form.reset).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith("Message accepted by the server.");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("has honest loading, error, and empty states without invented live data", () => {
    const chatLoading = renderToStaticMarkup(
      <Conversation messages={[]} status="loading" />,
    );
    const chatError = renderToStaticMarkup(
      <Conversation messages={[]} status="error" />,
    );
    const challengeLoading = renderToStaticMarkup(
      <ChallengeSummary status="loading" />,
    );
    const challengeEmpty = renderToStaticMarkup(<ChallengeSummary />);

    expect(chatLoading).toContain('aria-busy="true"');
    expect(chatLoading).toContain("Loading conversation history");
    expect(chatError).toContain('role="alert"');
    expect(challengeLoading).toContain("Loading Challenge");
    expect(challengeEmpty).toContain("No active Challenge stage");
    expect(challengeEmpty).toContain("No simulated position");
    expect(`${chatLoading}${chatError}${challengeLoading}${challengeEmpty}`)
      .not.toMatch(/private thesis|ciphertext|account-b/iu);
  });
});

describe("production account surface integration", () => {
  let challenge: ChallengeFixture;
  let conversation: ConversationFixture;
  let foreignConversation: ConversationFixture;
  let exactRoutingEventId: string;
  let foreignRoutingEventId: string;
  let suiteRootKey: string;
  let suiteRootKeyVersion: string;
  const firstText = "First private account message.";
  const nodeText = "Completed support remains intact.";
  const abandonedText = "Interleaved message with an abandoned route.";
  const secondText = "A newer private account message.";
  const mainText = "Main Brain scheduled market context.";
  const foreignText = "Foreign account protected message.";

  beforeAll(async () => {
    challenge = await testChallengeContext();
    conversation = await createConversationFixture("account-surface", challenge.db);
    const foreign = await createConversationFixture("account-surface-foreign", challenge.db);
    foreignConversation = foreign;
    pageState.db = challenge.db;
    pageState.token = conversation.sessionToken;
    vi.stubEnv("NODE_ENV", "production");
    await storeLatestMarketWindow({
      db: challenge.db,
      accountId: conversation.accountId,
    }, {
      windowId: "2026-08-13T13:30Z",
      receivedAt: "2026-08-13T13:34:59.000Z",
      items: [{
        symbol: "AAPL",
        kind: "STOCK",
        status: "SUCCESS",
        price: "225.10",
        sourceObservedAt: "2026-08-13T13:34:59.000Z",
        safeCode: null,
      }],
    });
    await challenge.db.query(
      `insert into market_poll_windows (window_id,window_started_at)
       values ('2026-08-13T13:35Z','2026-08-13T13:35:00Z')`,
    );
    await challenge.db.query(
      `update market_poll_windows
          set status='FAILED',provider_status='ERROR',safe_code='PROVIDER_ERROR'
        where window_id='2026-08-13T13:35Z'`,
    );
    const foreignUser = await appendMessage({
      db: challenge.db,
      accountId: foreign.accountId,
      conversationId: foreign.conversationId,
    }, {
      role: "USER",
      text: foreignText,
      idempotencyKey: "account-surface-foreign-message",
    });
    foreignRoutingEventId = (await routeNodeReply({
      db: challenge.db,
      accountId: foreign.accountId,
      conversationId: foreign.conversationId,
      nodeBrainId: foreign.nodeBrainId,
      userMessageEventId: foreignUser.eventId,
      coveredByMain: true,
      contradiction: false,
      materialEvidence: false,
      confidence: 0.9,
      mainStateVersion: "main-state-account-surface",
      sourceIds: [foreignUser.eventId],
    }, async () => foreignText)).routingEventId;

    const user = await appendMessage({
      db: challenge.db,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
    }, {
      role: "USER",
      text: firstText,
      idempotencyKey: "account-surface-user",
    });
    const routed = await routeNodeReply({
      db: challenge.db,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      nodeBrainId: conversation.nodeBrainId,
      userMessageEventId: user.eventId,
      coveredByMain: true,
      contradiction: false,
      materialEvidence: false,
      confidence: 0.9,
      mainStateVersion: "main-state-account-surface",
      sourceIds: [user.eventId],
    }, async () => nodeText);
    exactRoutingEventId = routed.routingEventId;
    const abandonedUser = await appendMessage({
      db: challenge.db,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
    }, {
      role: "USER",
      text: abandonedText,
      idempotencyKey: "account-surface-abandoned-user",
    });
    await routeNodeReply({
      db: challenge.db,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      nodeBrainId: conversation.nodeBrainId,
      userMessageEventId: abandonedUser.eventId,
      coveredByMain: false,
      contradiction: true,
      materialEvidence: false,
      confidence: 0.9,
      mainStateVersion: "main-state-account-surface",
      sourceIds: [abandonedUser.eventId],
    }, async () => "This abandoned route must not be attributed.");
    await appendMessage({
      db: challenge.db,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
    }, {
      role: "NODE",
      text: nodeText,
      idempotencyKey: "account-surface-node",
      routingEventId: routed.routingEventId,
    });
    await appendMessage({
      db: challenge.db,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
    }, {
      role: "USER",
      text: secondText,
      idempotencyKey: "account-surface-second-user",
    });

    const broadcast = await commitBroadcast({ db: challenge.db }, {
      mainStateVersion: 8_120_029,
      body: mainText,
      sourceIds: ["market:AAPL:account-surface"],
      idempotencyKey: "account-surface-broadcast",
    });
    const source = await challenge.db.one<{ ingested_sequence: string }>(
      "select ingested_sequence::text from events where id=$1",
      [broadcast.commitEventId],
    );
    await challenge.db.query(
      `insert into cache_projection_versions (
         category,entity_id,source_event_id,source_high_water,version_ordinal,content_hash
       ) values ('BROADCASTS',$1,$2,$3,$4,$5)`,
      [broadcast.id, broadcast.commitEventId, `e${source.ingested_sequence}`,
        source.ingested_sequence, "0".repeat(64)],
    );
    await projectDelivery({ db: challenge.db }, broadcast.id, {
      accountId: conversation.accountId,
      nodeBrainId: conversation.nodeBrainId,
      locale: "en-US",
    });

    const intent = await submitPaperIntent(challenge.mainOrderContext, {
      sourceDecisionId: challenge.decisionWindowId,
      symbol: "AAPL",
      direction: "LONG",
      entry: "100.00",
      stop: "97.50",
      exitRule: { type: "TARGET", price: "105.00" },
      desiredRisk: "25.00",
      expiresAt: "2026-08-09T20:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:00.000Z",
      idempotencyKey: "account-surface-paper-intent",
    });
    await processPaperOrder(challenge.paperWorkerContext, intent.orderId!, {
      reference: "100.00",
      observedAt: "2026-08-09T15:00:00.000Z",
      evaluatedAt: "2026-08-09T15:01:30.000Z",
    });
    const appendFee = async (amount: string, index: number, label: string): Promise<void> => {
      const feeId = randomUUID();
      const eventId = randomUUID();
      const recordedAt = new Date(Date.UTC(2026, 7, 9, 16, 0, index)).toISOString();
      await challenge.db.transaction(async (transaction) => {
        await appendChallengeLedgerEvent({ db: transaction }, {
          id: eventId,
          challengePortfolioId: challenge.challengePortfolioId,
          stageId: challenge.stageId,
          profileVersionId: challenge.profileVersionId,
          type: "fee.recorded",
          payload: {
            feeId, positionId: null, orderId: null, amount,
            category: "OTHER_SIMULATED_FEE", recordedAt,
          },
          occurredAt: recordedAt,
          actorType: "SYSTEM",
          actorId: "account-surface-bounded-ledger",
          idempotencyKey: `account-surface-${label}-${index}`,
        });
        await transaction.query(
          `insert into challenge_fees (
             id,stage_id,profile_version_id,ledger_event_id,position_id,
             order_id,amount,category,recorded_at
           ) values ($1,$2,$3,$4,null,null,$5,'OTHER_SIMULATED_FEE',$6)`,
          [feeId, challenge.stageId, challenge.profileVersionId, eventId, amount, recordedAt],
        );
      });
    };
    for (let index = 0; index < 27; index += 1) {
      await appendFee("0.01", index, "ledger");
    }
    for (const [index, amount] of ["1", "0.1", "1.005"].entries()) {
      await appendFee(amount, index + 30, "money");
    }
    const allLedger = await loadChallengeLedgerEvents({ db: challenge.db }, challenge.stageId);
    const projection = replayStoredLedgerEvents(allLedger);
    const highWater = allLedger.at(-1)!;
    await replaceProjectionCheckpoint({ db: challenge.db }, {
      stageId: challenge.stageId,
      profileVersionId: challenge.profileVersionId,
      highWaterEventId: highWater.id,
      highWaterSequence: highWater.sequence,
      projection,
    });
    suiteRootKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1!;
    suiteRootKeyVersion = process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION!;
  }, 60_000);

  afterEach(() => {
    process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = suiteRootKey;
    process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION = suiteRootKeyVersion;
  });

  afterAll(() => {
    pageState.db = undefined;
    pageState.token = undefined;
    vi.unstubAllEnvs();
  });

  it("keeps Main broadcasts separate from oldest-first history and follows its actual after cursor", async () => {
    const first = await loadAccountConversation(
      challenge.db,
      conversation.sessionToken,
    );
    expect(first.conversationId).toBe(conversation.conversationId);
    expect(first.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: "USER", text: firstText }),
      expect.objectContaining({ author: "USER", text: abandonedText }),
      expect.objectContaining({
        author: "NODE_BRAIN",
        text: nodeText,
        routingMode: "MAIN_DEFAULT",
      }),
    ]));
    expect(first.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ author: "MAIN_BRAIN" }),
    ]));
    expect(first.broadcasts).toEqual([
      expect.objectContaining({ author: "MAIN_BRAIN", text: mainText }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain("account-surface-broadcast");
    expect(JSON.stringify(first)).not.toContain(foreignText);
    expect(await challenge.db.one<{ causation_id: string | null }>(
      `select causation_id::text from events
        where aggregate_id=$1 and type='brain.response.completed'`,
      [conversation.conversationId],
    )).toEqual({ causation_id: exactRoutingEventId });

    const firstMarkup = renderToStaticMarkup(await ChatPage({
      searchParams: Promise.resolve({}),
    }));
    expect(firstMarkup).toContain(firstText);
    expect(firstMarkup).toContain(nodeText);
    expect(firstMarkup).toContain(abandonedText);
    expect(firstMarkup).not.toContain(secondText);
    expect(firstMarkup).toContain(mainText);
    expect(firstMarkup).toContain("Main Brain broadcasts");
    expect(firstMarkup).toContain("Load newer messages");
    expect(firstMarkup).toContain('href="/market"');
    expect(firstMarkup).toContain("Message saved — local processing unavailable");

    const newerMarkup = renderToStaticMarkup(await ChatPage({
      searchParams: Promise.resolve({ after: first.nextCursor! }),
    }));
    expect(newerMarkup).toContain(secondText);
    expect(newerMarkup).not.toContain(firstText);
    expect(newerMarkup).not.toContain(mainText);
    expect(newerMarkup).toMatch(
      /<form aria-label="Send a message" method="post"><fieldset disabled=""/u,
    );
  }, 30_000);

  it("loads the account-scoped bridge summary through the event account authority", async () => {
    const projection = await loadAccountConversation(
      challenge.db,
      conversation.sessionToken,
    );
    expect(projection.bridge).toMatchObject({
      status: "OFFLINE",
      safeCode: "LOCAL_BRIDGE_UNAVAILABLE",
    });
    expect(projection.bridge.pendingJobs).toBeGreaterThan(0);
  }, 30_000);

  it("ages the database-clock CODEX lease and gives today's durable quota precedence", async () => {
    const fixture = await createConversationFixture("account-bridge-lease");
    await fixture.db.query(
      `insert into hybrid_worker_heartbeats (component,status,safe_code)
       values ('CODEX','HEALTHY',null)`,
    );
    await fixture.db.query(
      "alter table hybrid_worker_heartbeats disable trigger hybrid_worker_heartbeats_are_bounded",
    );
    try {
      await fixture.db.query(
        `update hybrid_worker_heartbeats
            set observed_at=clock_timestamp()-interval '12 minutes 1 millisecond',
                updated_at=clock_timestamp()-interval '12 minutes 1 millisecond'
          where component='CODEX'`,
      );
    } finally {
      await fixture.db.query(
        "alter table hybrid_worker_heartbeats enable trigger hybrid_worker_heartbeats_are_bounded",
      );
    }

    const stale = await loadAccountConversation(fixture.db, fixture.sessionToken);
    expect(stale.bridge).toEqual({
      status: "OFFLINE", pendingJobs: 0, safeCode: "LOCAL_BRIDGE_UNAVAILABLE",
    });

    await fixture.db.query(
      `update hybrid_worker_heartbeats
          set status='HEALTHY',safe_code=null
        where component='CODEX'`,
    );
    await fixture.db.query(
      `insert into deployment_quota_counters (
         quota_name,bucket_date,used_count,limit_count
       ) values (
         'CODEX_JOBS',(clock_timestamp() at time zone 'UTC')::date,100,100
       )`,
    );
    const exhausted = await loadAccountConversation(fixture.db, fixture.sessionToken);
    expect(exhausted.bridge).toEqual({
      status: "QUOTA_LIMITED",
      pendingJobs: 0,
      safeCode: "LOCAL_BRIDGE_QUOTA_EXHAUSTED",
    });
  }, 30_000);

  it("authorizes and decrypts only the tenant's latest rows and keeps recovered failures stale", async () => {
    const dto = await loadAccountMarket(
      challenge.db,
      conversation.sessionToken,
      new Date("2026-08-13T13:35:10.000Z"),
    );
    expect(dto.items).toHaveLength(95);
    expect(dto.items.map(({ symbol }) => symbol)).toEqual(
      MARKET_UNIVERSE.map(({ symbol }) => symbol),
    );
    expect(dto.items[0]).toMatchObject({
      symbol: "AAPL",
      status: "SUCCESS",
      price: "225.10",
      sourceObservedAt: "2026-08-13T13:34:59.000Z",
      receivedAt: "2026-08-13T13:34:59.000Z",
      ageSeconds: 11,
      freshness: "Stale",
      safeCode: "PROVIDER_ERROR",
    });
    expect(dto.items.slice(1).every((item) => (
      item.status === "UNAVAILABLE" && item.price === null
        && item.freshness === "Unavailable"
    ))).toBe(true);
    expect(JSON.stringify(dto)).not.toMatch(
      /ciphertext|dataKey|providerKey|rawProvider|hostname|tunnel|prompt/i,
    );

    const marketMarkup = renderToStaticMarkup(await MarketPage());
    expect(marketMarkup.match(/data-market-symbol=/g)).toHaveLength(95);
    expect(marketMarkup).toContain("$225.10");
    expect(marketMarkup).toContain("Stale");
    expect(marketMarkup).not.toMatch(
      /ciphertext|dataKey|providerKey|rawProvider|hostname|tunnel|prompt/i,
    );

    const foreign = await loadAccountMarket(
      challenge.db,
      foreignConversation.sessionToken,
      new Date("2026-08-13T13:35:10.000Z"),
    );
    expect(foreign.items).toHaveLength(95);
    expect(foreign.items.find(({ symbol }) => symbol === "AAPL")).toMatchObject({
      status: "UNAVAILABLE",
      price: null,
    });
  }, 30_000);

  it("keeps the previous completed quote fresh while a newer market window is pending", async () => {
    const fixture = await createConversationFixture("account-market-pending-window");
    const completedWindow = "2026-08-14T11:00Z";
    await storeLatestMarketWindow({ db: fixture.db, accountId: fixture.accountId }, {
      windowId: completedWindow,
      receivedAt: "2026-08-14T11:04:59.000Z",
      items: [{
        symbol: "AAPL",
        kind: "STOCK",
        status: "SUCCESS",
        price: "227.00",
        sourceObservedAt: "2026-08-14T11:04:59.000Z",
        safeCode: null,
      }],
    });
    await fixture.db.query(
      "alter table market_poll_windows disable trigger market_poll_windows_are_semantically_immutable",
    );
    try {
      await fixture.db.query(
        `update market_poll_windows
            set status='COMPLETED',provider_status='OPEN',calls_used=96,result_count=95,
                completed_at='2026-08-14T11:04:59.500Z',updated_at=clock_timestamp()
          where window_id=$1`,
        [completedWindow],
      );
    } finally {
      await fixture.db.query(
        "alter table market_poll_windows enable trigger market_poll_windows_are_semantically_immutable",
      );
    }
    await fixture.db.query(
      `insert into market_poll_windows (window_id,window_started_at)
       values ('2026-08-14T11:05Z','2026-08-14T11:05:00.000Z')`,
    );
    await fixture.db.query(
      `insert into hybrid_worker_heartbeats (component,status,safe_code)
       values ('MARKET','HEALTHY',null)`,
    );

    const dto = await loadAccountMarket(
      fixture.db,
      fixture.sessionToken,
      new Date("2026-08-14T11:05:01.000Z"),
    );
    expect(dto.items.find(({ symbol }) => symbol === "AAPL")).toMatchObject({
      status: "SUCCESS",
      price: "227.00",
      ageSeconds: 2,
      freshness: "Fresh",
      safeCode: null,
    });
  }, 30_000);

  it("keeps market latest, poll, and heartbeat on one coherent transaction snapshot", async () => {
    const fixture = await createConversationFixture("account-market-snapshot");
    const oldWindow = "2026-08-14T10:00Z";
    const newWindow = "2026-08-14T10:05Z";
    await storeLatestMarketWindow({ db: fixture.db, accountId: fixture.accountId }, {
      windowId: oldWindow,
      receivedAt: "2026-08-14T10:04:59.000Z",
      items: [{
        symbol: "AAPL",
        kind: "STOCK",
        status: "SUCCESS",
        price: "226.00",
        sourceObservedAt: "2026-08-14T10:04:59.000Z",
        safeCode: null,
      }],
    });
    await fixture.db.query(
      "alter table market_poll_windows disable trigger market_poll_windows_are_semantically_immutable",
    );
    try {
      await fixture.db.query(
        `update market_poll_windows
            set status='COMPLETED',provider_status='OPEN',calls_used=96,result_count=95,
                completed_at='2026-08-14T10:04:59.500Z',
                updated_at=clock_timestamp()
          where window_id=$1`,
        [oldWindow],
      );
    } finally {
      await fixture.db.query(
        "alter table market_poll_windows enable trigger market_poll_windows_are_semantically_immutable",
      );
    }
    await fixture.db.query(
      `insert into hybrid_worker_heartbeats (component,status,safe_code)
       values ('MARKET','HEALTHY',null)`,
    );

    const latestReady = deferred();
    const releaseLatest = deferred();
    let newPollCommitted = false;
    let observedLatestWindow: string | undefined;
    let observedPollWindow: string | undefined;
    const commitNewPoll = async () => {
      if (newPollCommitted) return;
      newPollCommitted = true;
      await fixture.db.query(
        `insert into market_poll_windows (
           window_id,window_started_at,status,provider_status,calls_used,result_count,
           completed_at,created_at,updated_at,prune_after
         ) values (
           $1,'2026-08-14T10:05:00.000Z','COMPLETED','OPEN',96,95,
           '2026-08-14T10:09:59.000Z','2026-08-14T10:05:00.000Z',
           '2026-08-14T10:09:59.000Z','2026-08-21T10:04:59.999Z'
         )`,
        [newWindow],
      );
    };

    const database: EventDatabase = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters: readonly unknown[] = [],
      ): Promise<Row[]> {
        if (sql.includes("/* account-market-poll-summary */")) {
          await latestReady.promise;
          await commitNewPoll();
          releaseLatest.resolve();
        }
        const rows = await fixture.db.query<Row>(sql, parameters);
        if (sql.includes("/* account-market-poll-summary */")) {
          observedPollWindow = (rows[0] as { readonly window_id?: string } | undefined)?.window_id;
        }
        return rows;
      },
      one: (sql, parameters = []) => fixture.db.one(sql, parameters),
      transaction: (work) => fixture.db.transaction(async (transaction) => {
        let coherent = false;
        let readLatest = false;
        const observed: EventDatabase = {
          async query<Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            parameters: readonly unknown[] = [],
          ): Promise<Row[]> {
            if (/set transaction isolation level repeatable read/u.test(sql)) coherent = true;
            const rows = await transaction.query<Row>(sql, parameters);
            if (sql.includes("/* account-market-poll-summary */")) {
              observedPollWindow = (rows[0] as {
                readonly window_id?: string;
              } | undefined)?.window_id;
              if (coherent) await commitNewPoll();
            }
            if (sql.includes("/* market-latest-metadata */")) {
              readLatest = true;
              observedLatestWindow = (rows[0] as {
                readonly window_id?: string;
              } | undefined)?.window_id;
            }
            return rows;
          },
          one: (sql, parameters = []) => transaction.one(sql, parameters),
          transaction: (nested) => nested(observed),
        };
        const result = await work(observed);
        if (readLatest && !coherent) {
          latestReady.resolve();
          await releaseLatest.promise;
        }
        return result;
      }),
    };

    const dto = await loadAccountMarket(
      database,
      fixture.sessionToken,
      new Date("2026-08-14T10:04:59.500Z"),
    );
    const aapl = dto.items.find(({ symbol }) => symbol === "AAPL");
    expect(aapl).toMatchObject({ status: "SUCCESS", price: "226.00" });
    if (aapl?.freshness === "Fresh") {
      expect(observedLatestWindow).toBe(observedPollWindow);
    }
    expect(newPollCommitted).toBe(true);
  }, 30_000);

  it("allows only a canonical same-conversation Node route to cause a Node response", async () => {
    await expect(appendMessage({
      db: challenge.db,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
    }, {
      role: "USER",
      text: "A participant cannot select routing authority.",
      idempotencyKey: "account-surface-user-forged-route",
      routingEventId: exactRoutingEventId,
    })).rejects.toThrow("INVALID_MESSAGE_ROUTING_EVENT");

    await expect(appendMessage({
      db: challenge.db,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
    }, {
      role: "NODE",
      text: "A foreign route cannot be attached.",
      idempotencyKey: "account-surface-foreign-route",
      routingEventId: foreignRoutingEventId,
    })).rejects.toThrow("INVALID_MESSAGE_ROUTING_EVENT");
    expect(foreignConversation.accountId).not.toBe(conversation.accountId);
  });

  it("uses the complete canonical proposal lifecycle in its safe DTO", () => {
    expectTypeOf<NonNullable<ComponentProps<typeof Conversation>["messages"]>[number]["proposalStatus"]>()
      .toEqualTypeOf<ProposalStatus | undefined>();
    for (const status of PROPOSAL_STATUSES) {
      const markup = renderToStaticMarkup(<Conversation messages={[{
        id: status,
        author: "NODE_BRAIN",
        text: "Safe projection",
        proposalStatus: status,
      }]} />);
      expect(markup).toContain(status);
    }
  });

  it("loads Challenge stage, equity, account-safe positions, ledger, and costs", async () => {
    const sql: string[] = [];
    const auditedDatabase: EventDatabase = {
      query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        sql.push(text);
        return challenge.db.query<Row>(text, values);
      },
      one: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => (
        challenge.db.one<Row>(text, values)
      ),
      transaction: async <Result,>(work: (transaction: EventDatabase) => Promise<Result>) => (
        challenge.db.transaction(work)
      ),
    };
    const dto = await loadAccountChallenge(auditedDatabase, conversation.sessionToken);
    expect(dto.stage).toMatchObject({
      startingBalance: "2500.00",
      targetEquity: "2750.00",
      status: "ACTIVE",
    });
    expect(dto.positions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: "AAPL",
        direction: "PAPER_LONG",
        simulatedCosts: "1.00",
      }),
    ]));
    expect(dto.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "fee.recorded", amount: "1.00", simulatedCosts: "1.00" }),
      expect.objectContaining({ type: "fee.recorded", amount: "0.10", simulatedCosts: "0.10" }),
      expect.objectContaining({ type: "fee.recorded", amount: "1.01", simulatedCosts: "1.01" }),
    ]));
    expect(dto.ledger).toHaveLength(25);
    expect(dto.ledgerTruncated).toBe(true);
    expect(dto.positions[0]).toMatchObject({
      averagePrice: "100.10",
      markPrice: "100.00",
      unrealizedPnl: "-0.85",
      simulatedCosts: "1.00",
    });
    expect(sql.some((statement) => (
      /from challenge_ledger_events[\s\S]*order by challenge_ledger_events\.sequence desc,[\s\S]*limit \$2/iu
        .test(statement)
    ))).toBe(true);
    expect(sql.some((statement) => (
      /from challenge_ledger_events[\s\S]*order by challenge_ledger_events\.sequence,/iu
        .test(statement)
    ))).toBe(false);

    const markup = renderToStaticMarkup(await ChallengePage());
    expect(markup).toContain("$2,500.00 \u2192 $2,750.00");
    expect(markup).toContain("AAPL: paper long");
    expect(markup).toContain("Simulated costs");
    expect(markup).toContain("fee.recorded");
    expect(markup).toContain("Showing the 25 most recent ledger events");
  }, 30_000);

  it("denies an invalid session before conversation or Challenge reads", async () => {
    const sql: string[] = [];
    const audit = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        sql.push(text);
        return database.query<Row>(text, values);
      },
      one: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        sql.push(text);
        return database.one<Row>(text, values);
      },
      transaction: async <Result,>(work: (transaction: EventDatabase) => Promise<Result>) => (
        database.transaction((transaction) => work(audit(transaction)))
      ),
    });
    const invalidToken = generateOpaqueToken();
    await expect(loadAccountConversation(audit(challenge.db), invalidToken))
      .rejects.toThrow("SESSION_INVALID");
    await expect(loadAccountChallenge(audit(challenge.db), invalidToken))
      .rejects.toThrow("SESSION_INVALID");
    await expect(loadAccountMarket(audit(challenge.db), invalidToken))
      .rejects.toThrow("SESSION_INVALID");
    expect(sql.some((statement) => /from sessions/u.test(statement))).toBe(true);
    expect(sql.some((statement) => (
      /from conversations|challenge_stages|deliveries|market_latest_quotes|market_poll_windows|hybrid_worker_heartbeats/u
        .test(statement)
    )))
      .toBe(false);
  });

  it("accepts authenticated same-origin browser GETs and rejects unsafe request contexts", async () => {
    const browserHeaders = (token = conversation.sessionToken): Headers => new Headers({
      cookie: `__Host-gustavo-session=${token}`,
      host: "gustavo.lol",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    });

    const memory = await getMemory(new Request(
      `https://gustavo.lol/api/memory?conversationId=${conversation.conversationId}&limit=25`,
      { headers: browserHeaders() },
    ));
    expect(memory.status).toBe(200);
    expect(memory.headers.get("cache-control")).toContain("no-store");

    const accountExport = await getAccountExport(new Request(
      "https://gustavo.lol/api/account/export?limit=1",
      { headers: browserHeaders() },
    ));
    expect(accountExport.status).toBe(200);
    expect(accountExport.headers.get("content-disposition")).toContain("attachment");

    const routeSql: string[] = [];
    const database = pageState.db!;
    pageState.db = {
      query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        routeSql.push(text);
        return database.query<Row>(text, values);
      },
      one: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        routeSql.push(text);
        return database.one<Row>(text, values);
      },
      transaction: async <Result,>(work: (transaction: EventDatabase) => Promise<Result>) => (
        database.transaction(work)
      ),
    };
    try {
      const invalidSession = await getMemory(new Request(
        `https://gustavo.lol/api/memory?conversationId=${conversation.conversationId}`,
        { headers: browserHeaders(generateOpaqueToken()) },
      ));
      expect(invalidSession.status).toBe(401);
    } finally {
      pageState.db = database;
    }
    expect(routeSql.some((statement) => /from sessions/u.test(statement))).toBe(true);
    expect(routeSql.some((statement) => /from memory_items|from conversations/u.test(statement)))
      .toBe(false);

    const crossSiteHeaders = browserHeaders();
    crossSiteHeaders.set("sec-fetch-site", "cross-site");
    expect((await getMemory(new Request(
      `https://gustavo.lol/api/memory?conversationId=${conversation.conversationId}`,
      { headers: crossSiteHeaders },
    ))).status).toBe(403);

    const wrongHostHeaders = browserHeaders();
    wrongHostHeaders.set("host", "attacker.example");
    expect((await getAccountExport(new Request(
      "https://gustavo.lol/api/account/export?limit=1",
      { headers: wrongHostHeaders },
    ))).status).toBe(403);

    expect((await mutateMemory(new Request("https://gustavo.lol/api/memory", {
      method: "POST",
      headers: new Headers({
        ...Object.fromEntries(browserHeaders()),
        "content-type": "application/json",
      }),
      body: JSON.stringify({}),
    }))).status).toBe(403);
  }, 30_000);
});
