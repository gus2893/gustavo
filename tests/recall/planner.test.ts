import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { appendEvent, appendEvents, readEventBody } from "../../lib/server/events/store";
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import type { EventDatabase } from "../../lib/server/events/types";
import { appendMessage } from "../../lib/server/history/messages";
import { commitBroadcast } from "../../lib/server/main-brain/broadcasts";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import {
  createDisclosureAuthorization,
  createProposal,
  revokeDisclosureAuthorization,
  transitionProposal,
} from "../../lib/server/orchestration/proposals";
import {
  appendChallengeLedgerEvent,
  loadChallengeLedgerEvents,
  replaceProjectionCheckpoint,
} from "../../lib/server/challenge/ledger";
import { replayStoredLedgerEvents } from "../../lib/server/challenge/projection";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";
import {
  authorizeRecall,
  recallAuthorized,
  recallBenchmarkContract,
  planRecall,
} from "../../lib/server/recall/planner";
import { createMemoryWorkerContext, processMemoryEvent } from "../../worker/consolidation/process-event";
import { createConversationFixture, openTestDb, type TestDatabase } from "../helpers/postgres";

// Durable authorization is evaluated at the trace's domain time, so keep the
// fixture just after the account/entitlement rows created during this run.
const NOW = new Date(Date.now() + 60_000).toISOString();
const VERSIONS = Object.freeze({
  embeddingVersion: "embedding-v1",
  extractorVersion: "extractor-v1",
  modelVersion: "memory-model-v1",
  promptVersion: "memory-prompt-v1",
});

function candidate(overrides: Record<string, unknown>) {
  const fixtureIdentity = randomUUID().replaceAll("-", "");
  return {
    id: randomUUID(),
    scope: "MAIN_SHARED",
    type: "SEMANTIC",
    current: true,
    score: 0.5,
    sourceIds: [randomUUID()],
    confidence: 0.8,
    importance: 0.5,
    freshness: 0.7,
    createdAt: NOW,
    conflictState: "CURRENT",
    equivalenceDigest: fixtureIdentity + fixtureIdentity,
    text: "A source-linked derived memory.",
    channels: [] as string[],
    ...overrides,
  };
}

function observeDatabase(db: EventDatabase, statements: string[]): EventDatabase {
  const record = (sql: string, parameters?: readonly unknown[]) => {
    if (sql.includes("select aggregate_id,root_key_version")) {
      statements.push(`${sql}\n/* aggregate-ids:${JSON.stringify(parameters?.[0] ?? [])} */`);
    } else {
      statements.push(sql);
    }
  };
  return {
    query: async (sql, parameters) => {
      record(sql, parameters);
      return db.query(sql, parameters);
    },
    one: async (sql, parameters) => {
      record(sql, parameters);
      return db.one(sql, parameters);
    },
    transaction: (work) => db.transaction((transaction) => (
      work(observeDatabase(transaction, statements))
    )),
  };
}

async function seedMemory(
  db: TestDatabase,
  options: {
    readonly scope: "PRIVATE_ACCOUNT" | "MAIN_SHARED" | "CHALLENGE_SHARED" | "PUBLIC";
    readonly text: string;
    readonly keyword: string;
    readonly accountId?: string;
    readonly nodeBrainId?: string;
    readonly conversationId?: string;
  },
) {
  const aggregateId = options.conversationId ?? `${options.scope.toLowerCase()}:fixture`;
  const source = await appendEvent(db, {
    aggregateId,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    actor: options.accountId
      ? { type: "USER", id: options.accountId }
      : { type: "MAIN_BRAIN", id: "gustavo-main" },
    type: options.accountId ? "participant.message.created" : "main.state.fixture-recorded",
    visibility: options.scope === "PUBLIC"
      ? "PUBLIC"
      : options.accountId
        ? "PRIVATE_ACCOUNT"
        : "SHARED",
    body: { text: options.text },
    idempotencyKey: `recall-source:${randomUUID()}`,
    occurredAt: new Date(NOW),
    policyVersion: "recall-fixture-v1",
  });
  const result = await processMemoryEvent(createMemoryWorkerContext(db), {
    scope: options.scope,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    ...(options.nodeBrainId ? { nodeBrainId: options.nodeBrainId } : {}),
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    events: [{ id: source.id, at: NOW, text: options.text }],
    extracted: {
      facts: [{
        text: options.text,
        sourceIds: [source.id],
        keywords: [options.keyword],
        entities: ["AAPL"],
        embedding: [1, 0],
        confidence: 0.9,
        importance: 0.8,
      }],
    },
    versions: VERSIONS,
    observedAt: NOW,
    sourceEventId: source.id,
    idempotencyKey: `recall-memory:${randomUUID()}`,
  });
  return { memoryId: result.memories[0].id, sourceEventId: source.id };
}

function authorizedRequest(overrides: Record<string, unknown> = {}) {
  return {
    query: "AAPL completed",
    entities: ["AAPL"],
    maxMemories: 4,
    tokenBudget: 500,
    graphDepth: 2,
    responseId: randomUUID(),
    idempotencyKey: `recall:${randomUUID()}`,
    occurredAt: NOW,
    policyVersion: "recall-policy-v1",
    modelVersion: "response-model-v1",
    plannerVersion: "recall-planner-v1",
    embeddingVersion: "embedding-v1",
    queryVector: [1, 0],
    ...overrides,
  };
}

async function rawProposalForSources(
  fixture: Awaited<ReturnType<typeof createConversationFixture>>,
  sources: readonly { readonly eventId: string; readonly text: string }[],
  label: string,
  expiresInMilliseconds = 10 * 60_000,
) {
  const sourceEventIds = sources.map(({ eventId }) => eventId);
  const route = await routeNodeReply({
    db: fixture.db,
    accountId: fixture.accountId,
    conversationId: fixture.conversationId,
    nodeBrainId: fixture.nodeBrainId,
    userMessageEventId: sourceEventIds.at(-1)!,
    coveredByMain: false,
    contradiction: true,
    materialEvidence: true,
    confidence: 0.95,
    mainStateVersion: "1",
    sourceIds: sourceEventIds,
  }, async () => undefined);
  const authorization = await createDisclosureAuthorization({ db: fixture.db }, {
    accountId: fixture.accountId,
    conversationId: fixture.conversationId,
    sourceEventIds,
    disclosedText: sources[0].text,
    privacyScope: "PROPOSAL_RAW_TEXT",
    purpose: "MAIN_PROPOSAL_REVIEW",
    expiresAt: new Date(Date.now() + expiresInMilliseconds),
    idempotencyKey: `proposal-disclosure:${label}:${randomUUID()}`,
  });
  const originalPseudonymKey = process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY;
  process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY = randomBytes(32).toString("base64");
  let proposal!: Awaited<ReturnType<typeof createProposal>>;
  try {
    proposal = await createProposal({ db: fixture.db }, {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      sourceEventIds,
      routeEventId: route.routingEventId,
      affectedMainStateIds: ["1"],
      privacyScope: "PROPOSAL_RAW_TEXT",
      proposedChange: `Apply proposal delta ${label}.`,
      evidence: sourceEventIds.map((referenceId) => ({ kind: "SOURCE_EVENT" as const, referenceId })),
      counterevidence: [],
      uncertainty: "Uncertainty remains material.",
      rawPrivateText: sources[0].text,
      disclosureAuthorizationId: authorization.id,
      idempotencyKey: `proposal:${label}:${randomUUID()}`,
    });
  } finally {
    if (originalPseudonymKey === undefined) delete process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY;
    else process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY = originalPseudonymKey;
  }
  return Object.freeze({ ...authorization, proposalId: proposal.id,
    proposalCreatedEventId: proposal.createdEventId });
}

async function seedRecallBatch(
  fixture: Awaited<ReturnType<typeof createConversationFixture>>,
  scope: "PRIVATE_ACCOUNT" | "MAIN_SHARED" | "PUBLIC",
  label: string,
  facts: readonly {
    readonly text: string; readonly keyword: string; readonly importance: number;
    readonly embedding: readonly number[];
  }[],
  observedAt = NOW,
) {
  const account = scope === "PRIVATE_ACCOUNT";
  const combinedText = facts.map(({ text }) => text).join(" ");
  let sourceEventId: string;
  let sourceOccurredAt: string;
  if (account) {
    const source = await appendMessage(fixture, {
      role: "USER", text: combinedText,
      idempotencyKey: `hybrid-source:${label}:${randomUUID()}`,
    });
    sourceEventId = source.eventId;
    sourceOccurredAt = source.occurredAt;
  } else {
    const source = await appendEvent(fixture.db, {
        aggregateId: `${scope.toLowerCase()}:${label}:${randomUUID()}`,
        actor: { type: "MAIN_BRAIN" as const, id: "gustavo-main" },
        type: "main.state.fixture-recorded",
        visibility: scope === "PUBLIC" ? "PUBLIC" : "SHARED",
        body: { text: combinedText },
        idempotencyKey: `hybrid-source:${label}:${randomUUID()}`,
        occurredAt: new Date(NOW), policyVersion: "recall-fixture-v1",
    });
    sourceEventId = source.id;
    sourceOccurredAt = new Date(source.occurredAt).toISOString();
  }
  return processMemoryEvent(createMemoryWorkerContext(fixture.db), {
    scope,
    ...(account ? {
      accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
    } : {}),
    events: [{ id: sourceEventId, at: sourceOccurredAt, text: combinedText }],
    extracted: { facts: facts.map((fact) => ({
      text: fact.text, sourceIds: [sourceEventId], keywords: [fact.keyword], entities: [],
      embedding: [...fact.embedding], confidence: 0.9, importance: fact.importance,
    })) },
    versions: VERSIONS, observedAt, sourceEventId,
    idempotencyKey: `hybrid-memory:${label}:${randomUUID()}`,
  });
}

async function queueProposalForMainDecision(
  fixture: Awaited<ReturnType<typeof createConversationFixture>>,
  authority: { readonly proposalId: string; readonly proposalCreatedEventId: string },
  label: string,
) {
  await transitionProposal({ db: fixture.db }, {
    proposalId: authority.proposalId,
    actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
    toStatus: "UNDER_REVIEW", reason: "Begin deterministic recall race review.",
    idempotencyKey: `proposal-under-review:${label}:${randomUUID()}`,
  });
  const evaluatorRunId = randomUUID();
  await fixture.db.query(
    `insert into model_runs (
       id,role,provider,model,prompt_version,policy_version,correlation_id,causation_id,
       input_tokens,output_tokens,max_input_tokens,max_output_tokens,completion_status,completed_at
     ) values ($1,'EVALUATOR','test-provider','test-evaluator','recall-race-v1',
       'recall-policy-v1',$2,$3,1,1,128,128,'COMPLETED',clock_timestamp())`,
    [evaluatorRunId, randomUUID(), authority.proposalCreatedEventId],
  );
  await transitionProposal({ db: fixture.db }, {
    proposalId: authority.proposalId,
    actor: { type: "EVALUATOR", id: evaluatorRunId },
    toStatus: "QUEUED_FOR_DECISION", reason: "Queue deterministic recall race decision.",
    idempotencyKey: `proposal-queued:${label}:${randomUUID()}`,
  });
}

async function seedSourceRichPublicMemory(db: TestDatabase, sourceCount: number) {
  const aggregateId = `public:source-rich:${sourceCount}:${randomUUID()}`;
  const sources: { id: string; occurredAt: string; text: string }[] = [];
  for (let offset = 0; offset < sourceCount; offset += 100) {
    const size = Math.min(100, sourceCount - offset);
    const events = await appendEvents(db, Array.from({ length: size }, (_, index) => {
      const ordinal = offset + index;
      return {
        aggregateId,
        actor: { type: "MAIN_BRAIN" as const, id: "gustavo-main" },
        type: "main.state.fixture-recorded",
        visibility: "PUBLIC" as const,
        body: { text: `Public source ${ordinal} for the 500-source recall contract.` },
        idempotencyKey: `source-rich:${sourceCount}:${ordinal}:${randomUUID()}`,
        occurredAt: new Date(NOW),
        policyVersion: "recall-fixture-v1",
      };
    }));
    sources.push(...events.map((event, index) => ({
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      text: `Public source ${offset + index} for the 500-source recall contract.`,
    })));
  }
  const result = await processMemoryEvent(createMemoryWorkerContext(db), {
    scope: "PUBLIC",
    events: sources.map(({ id, occurredAt, text }) => ({ id, at: occurredAt, text })),
    extracted: { facts: [{
      text: `AAPL public evidence retains exactly ${sourceCount} source references.`,
      sourceIds: sources.map(({ id }) => id),
      keywords: [`sources-${sourceCount}`],
      entities: ["AAPL"],
      embedding: [1, 0],
      confidence: 0.9,
      importance: 0.9,
    }] },
    versions: VERSIONS,
    observedAt: NOW,
    sourceEventId: sources.at(-1)!.id,
    idempotencyKey: `source-rich-memory:${sourceCount}:${randomUUID()}`,
  });
  return result.memories[0].id;
}

async function seedCurrentChallenge(db: TestDatabase) {
  const stageId = randomUUID();
  await db.query(
    `insert into challenge_stages (
       id,challenge_portfolio_id,profile_version_id,stage_profile_id,ordinal,created_at
     ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001211',1,$4)`,
    [stageId, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId, NOW],
  );
  const started = await appendChallengeLedgerEvent({ db }, {
    id: randomUUID(),
    challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
    stageId,
    profileVersionId: INITIAL_PROFILE.profileVersionId,
    type: "stage.started",
    payload: { amount: "2500.00" },
    occurredAt: NOW,
    actorType: "SYSTEM",
    actorId: "challenge-stage-lifecycle",
    idempotencyKey: `recall-challenge:${randomUUID()}`,
  });
  const projection = replayStoredLedgerEvents(await loadChallengeLedgerEvents({ db }, stageId));
  await replaceProjectionCheckpoint({ db }, {
    stageId, profileVersionId: INITIAL_PROFILE.profileVersionId,
    highWaterEventId: started.id, highWaterSequence: "1", projection,
  });
  return stageId;
}

describe("authorization-first recall planning", () => {
  it("pins current shared state, excludes foreign private memory, and bounds output", async () => {
    const result = await planRecall({
      actor: { role: "MAIN_BRAIN", actorId: "gustavo-main" },
      query: "What did we decide about AAPL?",
      maxMemories: 3,
      candidates: [
        candidate({ id: "00000000-0000-4000-8000-000000000001", type: "SEMANTIC", current: true, score: 0.4, sourceIds: ["00000000-0000-4000-8000-000000000101"] }),
        candidate({ id: "00000000-0000-4000-8000-000000000002", scope: "PRIVATE_ACCOUNT", accountId: "00000000-0000-4000-8000-0000000000aa", current: true, score: 0.99, sourceIds: ["00000000-0000-4000-8000-000000000102"] }),
        candidate({ id: "00000000-0000-4000-8000-000000000003", type: "SEMANTIC", current: false, score: 0.95, conflictState: "SUPERSEDED", sourceIds: ["00000000-0000-4000-8000-000000000103"] }),
        candidate({ id: "00000000-0000-4000-8000-000000000004", scope: "CHALLENGE_SHARED", type: "GOAL", current: true, score: 0.8, sourceIds: ["00000000-0000-4000-8000-000000000104"] }),
      ],
    });
    expect(result.memories.map((memory) => memory.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000003",
    ]);
    expect(result.excluded).toContainEqual({
      id: "00000000-0000-4000-8000-000000000002",
      reason: "SCOPE_FORBIDDEN",
    });
    expect(result.trace.selectedMemoryIds).toEqual(result.memories.map(({ id }) => id));
  });

  it("lets an account recall its own private and Node memory but never another account's", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000aa";
    const conversationId = "00000000-0000-4000-8000-0000000000ac";
    const nodeBrainId = "00000000-0000-4000-8000-0000000000ab";
    const result = await planRecall({
      actor: { role: "ACCOUNT", accountId, conversationId, nodeBrainId },
      query: "my preference",
      maxMemories: 3,
      candidates: [
        candidate({ id: "00000000-0000-4000-8000-000000000011", scope: "PRIVATE_ACCOUNT", accountId, conversationId, nodeBrainId, equivalenceDigest: "d".repeat(64), sourceIds: ["00000000-0000-4000-8000-000000000111"] }),
        candidate({ id: "00000000-0000-4000-8000-000000000012", scope: "NODE_BRANCH", accountId, conversationId, nodeBrainId, equivalenceDigest: "d".repeat(64), sourceIds: ["00000000-0000-4000-8000-000000000112"] }),
        candidate({ id: "00000000-0000-4000-8000-000000000013", scope: "PRIVATE_ACCOUNT", accountId: "00000000-0000-4000-8000-0000000000bb", conversationId, nodeBrainId, score: 0.99, sourceIds: ["00000000-0000-4000-8000-000000000113"] }),
      ],
    });
    expect(result.memories.map((memory) => memory.id)).toEqual([
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ]);
    expect(result.excluded).toContainEqual({
      id: "00000000-0000-4000-8000-000000000013",
      reason: "SCOPE_FORBIDDEN",
    });
  });

  it("does not let an unbranded caller assert proposal authorization", async () => {
    const privateMemory = candidate({
      id: "00000000-0000-4000-8000-000000000021",
      scope: "PRIVATE_ACCOUNT",
      accountId: "00000000-0000-4000-8000-0000000000aa",
      proposalAuthorized: true,
      sourceIds: ["00000000-0000-4000-8000-000000000121"],
    });
    const unauthorized = await planRecall({
      actor: { role: "MAIN_BRAIN", actorId: "gustavo-main" },
      query: "proposal",
      maxMemories: 2,
      candidates: [{ ...privateMemory, proposalAuthorized: false }],
    });
    const spoofed = await planRecall({
      actor: { role: "MAIN_BRAIN", actorId: "gustavo-main" },
      query: "proposal",
      maxMemories: 2,
      candidates: [privateMemory],
    });
    expect(unauthorized.memories).toHaveLength(0);
    expect(spoofed.memories).toHaveLength(0);
  });

  it("deduplicates exact source-equivalent memories while preserving distinct conflicts", async () => {
    const first = candidate({
      id: "00000000-0000-4000-8000-000000000031",
      score: 0.9,
      equivalenceDigest: "b".repeat(64),
      sourceIds: ["00000000-0000-4000-8000-000000000131"],
    });
    const equivalent = candidate({
      id: "00000000-0000-4000-8000-000000000032",
      score: 0.8,
      equivalenceDigest: "b".repeat(64),
      sourceIds: ["00000000-0000-4000-8000-000000000132"],
    });
    const conflict = candidate({
      id: "00000000-0000-4000-8000-000000000033",
      score: 0.7,
      equivalenceDigest: "c".repeat(64),
      conflictState: "CONFLICTED",
      sourceIds: ["00000000-0000-4000-8000-000000000133"],
    });
    const result = await planRecall({
      actor: { role: "MAIN_BRAIN", actorId: "gustavo-main" },
      query: "conflicts",
      maxMemories: 4,
      candidates: [equivalent, conflict, first],
    });
    expect(result.memories.map(({ id }) => id)).toEqual([first.id, conflict.id]);
    expect(result.excluded).toContainEqual({ id: equivalent.id, reason: "SOURCE_EQUIVALENT" });
  });

  it("uses stable tie-breaking and applies result and token caps", async () => {
    const candidates = [3, 1, 2].map((ordinal) => candidate({
      id: `00000000-0000-4000-8000-00000000004${ordinal}`,
      score: 0.5,
      equivalenceDigest: String(ordinal).repeat(64),
      text: "x".repeat(20),
      sourceIds: [`00000000-0000-4000-8000-00000000014${ordinal}`],
    }));
    const result = await planRecall({
      actor: { role: "MAIN_BRAIN", actorId: "gustavo-main" },
      query: "ties",
      maxMemories: 2,
      tokenBudget: 8_000,
      candidates,
    });
    expect(result.memories.map(({ id }) => id)).toEqual([
      "00000000-0000-4000-8000-000000000041",
      "00000000-0000-4000-8000-000000000042",
    ]);
    expect(result.contextPack.estimatedTokens).toBeLessThanOrEqual(8_000);
  });

  it("marks every excerpt as derived and includes provenance metadata", async () => {
    const sourceId = "00000000-0000-4000-8000-000000000151";
    const result = await planRecall({
      actor: { role: "MAIN_BRAIN", actorId: "gustavo-main" },
      query: "provenance",
      maxMemories: 1,
      candidates: [candidate({
        id: "00000000-0000-4000-8000-000000000051",
        sourceIds: [sourceId],
        supersedesMemoryId: "00000000-0000-4000-8000-000000000050",
      })],
    });
    expect(result.contextPack.memories[0]).toMatchObject({
      contentKind: "DERIVED_MEMORY",
      sourceEventIds: [sourceId],
      scope: "MAIN_SHARED",
      confidence: 0.8,
      createdAt: NOW,
      supersedesMemoryId: "00000000-0000-4000-8000-000000000050",
    });
  });

  it("rejects proxies, accessors, cycles, sparse arrays, and oversized candidate sets", async () => {
    const valid = {
      actor: { role: "MAIN_BRAIN", actorId: "gustavo-main" },
      query: "hostile",
      maxMemories: 1,
      candidates: [],
    };
    await expect(planRecall(new Proxy(valid, {}) as never)).rejects.toThrow("RECALL_INPUT_INVALID");
    const withGetter = { ...valid, candidates: [candidate({})] };
    Object.defineProperty(withGetter.candidates[0], "score", { enumerable: true, get: () => 1 });
    await expect(planRecall(withGetter)).rejects.toThrow("RECALL_INPUT_INVALID");
    const cyclic = candidate({});
    (cyclic as Record<string, unknown>).self = cyclic;
    await expect(planRecall({ ...valid, candidates: [cyclic] })).rejects.toThrow("RECALL_INPUT_INVALID");
    const sparse = new Array(2);
    sparse[0] = candidate({});
    await expect(planRecall({ ...valid, candidates: sparse })).rejects.toThrow("RECALL_INPUT_INVALID");
    await expect(planRecall({
      ...valid,
      candidates: Array.from({ length: 201 }, (_, index) => candidate({
        equivalenceDigest: index.toString(16).padStart(64, "0"),
      })),
    })).rejects.toThrow("RECALL_CANDIDATE_LIMIT");
  });

  it("publishes the bounded million-event benchmark/query-count contract without wall-clock claims", () => {
    expect(recallBenchmarkContract()).toEqual({
      fixtureSourceEvents: 1_000_000,
      warmP95Milliseconds: 250,
      cachedHandoffP95Milliseconds: 100,
      maximumCandidateQueries: 9,
      maximumCandidatesPerQuery: 20,
      maximumCandidatesBeforeRanking: 100,
      maximumGraphDepth: 2,
      maximumContextMemories: 24,
    });
  });

  it("fairly fuses bounded channels before the 100-candidate total cap", async () => {
    const rankModule = await import("../../lib/server/recall/rank");
    const fuseChannels = (rankModule as unknown as Record<string, unknown>)
      .fuseBoundedRecallChannels;
    expect(typeof fuseChannels).toBe("function");
    if (typeof fuseChannels !== "function") return;
    const kinds = [
      "CURRENT_STATE", "RECENT", "ENTITY", "TIME", "FULL_TEXT",
      "VECTOR", "GRAPH", "PROCEDURE", "GOAL",
    ];
    const channels = kinds.map((kind, channelIndex) => Array.from({ length: 20 }, (_, index) => (
      candidate({
        channels: [kind],
        score: kind === "VECTOR" && index === 0 ? 1 : 0.2,
        equivalenceDigest: (channelIndex * 20 + index + 1).toString(16).padStart(64, "0"),
      })
    )));
    const fused = (fuseChannels as (value: readonly (readonly ReturnType<typeof candidate>[])[]) => (
      readonly ReturnType<typeof candidate>[]
    ))(channels);
    expect(fused).toHaveLength(100);
    expect(fused.some(({ channels: candidateChannels }) => candidateChannels.includes("VECTOR")))
      .toBe(true);
    expect(new Set(fused.map(({ id }) => id)).size).toBe(100);
  });
});

describe("durable recall and RecallTrace provenance", () => {
  it("resolves durable account identity before candidate queries and recalls only owned protected memory", async () => {
    const owner = await createConversationFixture("Recall owner");
    const foreign = await createConversationFixture("Recall foreign", owner.db);
    const mine = await seedMemory(owner.db, {
      scope: "PRIVATE_ACCOUNT",
      accountId: owner.accountId,
      nodeBrainId: owner.nodeBrainId,
      conversationId: owner.conversationId,
      text: "The owner prefers an AAPL completed-bar checklist.",
      keyword: "checklist",
    });
    await seedMemory(owner.db, {
      scope: "PRIVATE_ACCOUNT",
      accountId: foreign.accountId,
      nodeBrainId: foreign.nodeBrainId,
      conversationId: foreign.conversationId,
      text: "Foreign private AAPL preference.",
      keyword: "checklist",
    });
    const queries: string[] = [];
    const observedDb = observeDatabase(owner.db, queries);
    const context = await authorizeRecall(observedDb, { role: "ACCOUNT", accountId: owner.accountId });
    const firstCandidateQuery = queries.findIndex((sql) => sql.includes("memory_records"));
    expect(firstCandidateQuery).toBe(-1);
    const result = await recallAuthorized(context, {
      query: "checklist AAPL",
      entities: ["AAPL"],
      maxMemories: 4,
      tokenBudget: 500,
      responseId: randomUUID(),
      idempotencyKey: `recall:${randomUUID()}`,
      occurredAt: NOW,
      policyVersion: "recall-policy-v1",
      modelVersion: "response-model-v1",
      plannerVersion: "recall-planner-v1",
      embeddingVersion: "embedding-v1",
      queryVector: [1, 0],
    });
    expect(result.memories.map(({ id }) => id)).toContain(mine.memoryId);
    expect(result.memories.every((memory) => memory.accountId === owner.accountId
      || !["PRIVATE_ACCOUNT", "NODE_BRANCH"].includes(memory.scope))).toBe(true);
    const channels = await owner.db.one<{ channels: string[] } & Record<string, unknown>>(
      "select channels from recall_trace_candidates where trace_id=$1 and memory_id=$2",
      [result.trace.id, mine.memoryId],
    );
    expect(channels.channels).toEqual(expect.arrayContaining(["ENTITY", "FULL_TEXT", "VECTOR"]));
    expect(queries.findIndex((sql) => sql.includes("memory_records"))).toBeGreaterThan(-1);
  }, 15_000);

  it("rejects invalid durable Main and account actors before cache or memory access", async () => {
    const db = await openTestDb();
    const cacheGet = vi.fn();
    await expect(authorizeRecall(db, {
      role: "MAIN_BRAIN", actorId: "impostor-main",
    }, { cache: { get: cacheGet } })).rejects.toThrow("RECALL_MAIN_ACTOR_INVALID");
    await expect(authorizeRecall(db, {
      role: "ACCOUNT", accountId: randomUUID(),
    }, { cache: { get: cacheGet } })).rejects.toThrow("RECALL_ACCOUNT_FORBIDDEN");
    expect(cacheGet).not.toHaveBeenCalled();
  });

  it("persists an immutable event-linked trace graph atomically and replays idempotently", async () => {
    const fixture = await createConversationFixture("Trace owner");
    const seeded = await seedMemory(fixture.db, {
      scope: "PRIVATE_ACCOUNT",
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      text: "AAPL decisions require completed candles.",
      keyword: "completed",
    });
    const context = await authorizeRecall(fixture.db, { role: "ACCOUNT", accountId: fixture.accountId });
    const request = {
      query: "completed AAPL",
      entities: ["AAPL"],
      maxMemories: 3,
      tokenBudget: 500,
      responseId: randomUUID(),
      idempotencyKey: `trace:${randomUUID()}`,
      occurredAt: NOW,
      policyVersion: "recall-policy-v1",
      modelVersion: "response-model-v1",
      plannerVersion: "recall-planner-v1",
      embeddingVersion: "embedding-v1",
      queryVector: [1, 0],
    } as const;
    const [first, replay] = await Promise.all([
      recallAuthorized(context, request),
      recallAuthorized(context, request),
    ]);
    expect(first.trace.id).toBe(replay.trace.id);
    expect(first.trace.stateVersions.node).toBeNull();
    expect(BigInt(first.trace.highWaterSequence)).toBeGreaterThan(0n);
    const traceBody = await readEventBody(fixture.db, first.trace.eventId, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    });
    expect(traceBody).toMatchObject({
      traceId: first.trace.id,
      responseId: request.responseId,
      selectedMemoryIds: first.trace.selectedMemoryIds,
      stateVersions: first.trace.stateVersions,
    });
    const sequentialReplay = await recallAuthorized(context, request);
    expect(sequentialReplay.trace.id).toBe(first.trace.id);
    await seedMemory(fixture.db, {
      scope: "PUBLIC",
      text: "A second completed-candle memory arrived after the first response.",
      keyword: "completed",
    });
    const replayAfterMemoryChange = await recallAuthorized(context, request);
    expect(replayAfterMemoryChange.trace.id).toBe(first.trace.id);
    expect(replayAfterMemoryChange.memories.map(({ id }) => id))
      .toEqual(first.trace.selectedMemoryIds);
    expect(first.trace.selectedMemoryIds).toContain(seeded.memoryId);
    const rows = await fixture.db.query<{
      event_count: number; trace_count: number; candidate_count: number; source_count: number;
    }>(
      `select
         (select count(*)::int from events where type='memory.recall.traced') event_count,
         (select count(*)::int from recall_traces) trace_count,
         (select count(*)::int from recall_trace_candidates) candidate_count,
         (select count(*)::int from recall_trace_sources) source_count`,
    );
    expect(rows[0]).toMatchObject({ event_count: 1, trace_count: 1 });
    expect(rows[0].candidate_count).toBeGreaterThanOrEqual(1);
    expect(rows[0].source_count).toBeGreaterThanOrEqual(1);
    expect(await fixture.db.one<{
      manifest_valid: boolean; digest_valid: boolean; body_valid: boolean; outbox_valid: boolean;
    }>(
      `select recall_trace_manifest_is_valid(trace) manifest_valid,
              recall_manifest_digest(trace.body_authority_manifest)=trace.body_authority_digest digest_valid,
              body.body_digest=trace.body_digest body_valid,
              outbox.topic='memory.recall.traced'
                and outbox.payload=jsonb_build_object('eventId',trace.event_id) outbox_valid
       from recall_traces trace
       join encrypted_event_bodies body on body.event_id=trace.event_id
       join transactional_outbox outbox on outbox.event_id=trace.event_id
       where trace.id=$1`, [first.trace.id],
    )).toEqual({ manifest_valid: true, digest_valid: true, body_valid: true, outbox_valid: true });
    const selectedAuthority = await fixture.db.one<{ memory_id: string; channels: string[]; score: string }>(
      `select memory_id::text,channels,score::text from recall_trace_candidates
       where trace_id=$1 and decision='SELECTED' order by selected_ordinal limit 1`,
      [first.trace.id],
    );
    expect(await fixture.db.one<{ exact: boolean; score_mismatch: boolean; channel_mismatch: boolean }>(
      `select
         recall_trace_candidate_matches_authority($1,$2,$3::text[],$4::numeric) exact,
         recall_trace_candidate_matches_authority($1,$2,$3::text[],0::numeric) score_mismatch,
         recall_trace_candidate_matches_authority($1,$2,array['GOAL']::text[],$4::numeric) channel_mismatch`,
      [first.trace.id, selectedAuthority.memory_id, selectedAuthority.channels, selectedAuthority.score],
    )).toEqual({ exact: true, score_mismatch: false, channel_mismatch: false });
    await expect(fixture.db.query(
      `insert into recall_trace_candidates (
         trace_id,memory_id,ordinal,decision,selected_ordinal,channels,score,exclusion_reason
       ) select trace_id,memory_id,ordinal,decision,selected_ordinal,channels,
                case when score=0 then 1 else 0 end,exclusion_reason
           from recall_trace_candidates where trace_id=$1 and memory_id=$2`,
      [first.trace.id, selectedAuthority.memory_id],
    )).rejects.toThrow("RECALL_TRACE_CANDIDATE_INVALID");
    await expect(fixture.db.query(
      `insert into recall_trace_candidates (
         trace_id,memory_id,ordinal,decision,selected_ordinal,channels,score,exclusion_reason
       ) select trace_id,memory_id,ordinal,decision,selected_ordinal,
                case when channels=array['GOAL']::text[] then array['VECTOR']::text[]
                  else array['GOAL']::text[] end,
                score,exclusion_reason
           from recall_trace_candidates where trace_id=$1 and memory_id=$2`,
      [first.trace.id, selectedAuthority.memory_id],
    )).rejects.toThrow("RECALL_TRACE_CANDIDATE_INVALID");
    await expect(fixture.db.transaction(async (transaction) => {
      const arbitraryBody = { arbitrary: "not the authoritative trace body" };
      const arbitraryEvent = await appendEvent(transaction, {
        aggregateId: fixture.conversationId, accountId: fixture.accountId,
        actor: { type: "USER", id: fixture.accountId }, type: "memory.recall.traced",
        visibility: "PRIVATE_ACCOUNT", body: arbitraryBody,
        idempotencyKey: `arbitrary-trace-body:${canonicalContentDigest(arbitraryBody)}`,
        occurredAt: new Date(first.trace.createdAt), promptVersion: request.plannerVersion,
        modelVersion: request.modelVersion, policyVersion: request.policyVersion,
      });
      const arbitraryTraceId = randomUUID();
      await transaction.query(
        `insert into recall_traces (
           id,event_id,response_id,actor_role,actor_id,account_id,node_brain_id,conversation_id,
           purpose,authorized_scopes,query_digest,query_plan,authorized_candidate_ids,exclusions,
           selected_memory_ids,selected_source_ids,cache_use,latency_ms,policy_version,
           model_version,planner_version,state_versions,high_water_sequence,idempotency_key,
           request_digest,body_authority_manifest,body_authority_digest,event_request_hash,
           body_digest,candidate_authority,context_entries,event_integrity_hash,
           outbox_payload_digest,source_high_water_sequence,created_at
         ) select $2::uuid,$3::uuid,source.response_id,source.actor_role,source.actor_id,source.account_id,
                  source.node_brain_id,source.conversation_id,source.purpose,source.authorized_scopes,
                  source.query_digest,source.query_plan,source.authorized_candidate_ids,source.exclusions,
                  source.selected_memory_ids,source.selected_source_ids,source.cache_use,source.latency_ms,
                  source.policy_version,source.model_version,source.planner_version,source.state_versions,
                  source.high_water_sequence,$4,source.request_digest,manifest.value,
                  recall_manifest_digest(manifest.value),event.request_hash,source.body_digest,
                  source.candidate_authority,source.context_entries,event.integrity_hash,
                  recall_manifest_digest(outbox.payload),source.source_high_water_sequence,source.created_at
           from recall_traces source
           join events event on event.id=$3
           join transactional_outbox outbox on outbox.event_id=event.id
           cross join lateral (select jsonb_set(source.body_authority_manifest,'{traceId}',
             to_jsonb($2::text)) value) manifest
           where source.id=$1`,
        [first.trace.id, arbitraryTraceId, arbitraryEvent.id,
          `arbitrary-body-clone:${randomUUID()}`],
      );
    })).rejects.toThrow("RECALL_TRACE_BODY_BINDING_INVALID");
    await expect(fixture.db.transaction(async (transaction) => {
      const forgedBody = { arbitrary: "self-consistent but forged recall plaintext" };
      const forgedDigest = canonicalContentDigest(forgedBody);
      const forgedEvent = await appendEvent(transaction, {
        aggregateId: fixture.conversationId, accountId: fixture.accountId,
        actor: { type: "USER", id: fixture.accountId }, type: "memory.recall.traced",
        visibility: "PRIVATE_ACCOUNT", body: forgedBody,
        idempotencyKey: `forged-recall-body:${forgedDigest}`,
        occurredAt: new Date(first.trace.createdAt), promptVersion: request.plannerVersion,
        modelVersion: request.modelVersion, policyVersion: request.policyVersion,
      });
      const forgedTraceId = randomUUID();
      await transaction.query(
        `insert into recall_traces (
           id,event_id,response_id,actor_role,actor_id,account_id,node_brain_id,conversation_id,
           purpose,authorized_scopes,query_digest,query_plan,authorized_candidate_ids,exclusions,
           selected_memory_ids,selected_source_ids,cache_use,latency_ms,policy_version,
           model_version,planner_version,state_versions,high_water_sequence,idempotency_key,
           request_digest,body_authority_manifest,body_authority_digest,event_request_hash,
           body_digest,candidate_authority,context_entries,event_integrity_hash,
           outbox_payload_digest,source_high_water_sequence,created_at
         ) select $2::uuid,$3::uuid,source.response_id,source.actor_role,source.actor_id,
                  source.account_id,source.node_brain_id,source.conversation_id,source.purpose,
                  source.authorized_scopes,source.query_digest,source.query_plan,
                  source.authorized_candidate_ids,source.exclusions,source.selected_memory_ids,
                  source.selected_source_ids,source.cache_use,source.latency_ms,source.policy_version,
                  source.model_version,source.planner_version,source.state_versions,
                  source.high_water_sequence,$4,source.request_digest,manifest.value,
                  recall_manifest_digest(manifest.value),event.request_hash,$5,
                  source.candidate_authority,source.context_entries,event.integrity_hash,
                  recall_manifest_digest(outbox.payload),source.source_high_water_sequence,
                  source.created_at
           from recall_traces source
           join events event on event.id=$3
           join transactional_outbox outbox on outbox.event_id=event.id
           cross join lateral (select jsonb_set(source.body_authority_manifest,'{traceId}',
             to_jsonb($2::text)) value) manifest
           where source.id=$1`,
        [first.trace.id, forgedTraceId, forgedEvent.id,
          `forged-body-clone:${randomUUID()}`, forgedDigest],
      );
      await transaction.query(
        `insert into recall_trace_plan_steps
         select $2,ordinal,kind,result_limit,graph_depth
         from recall_trace_plan_steps where trace_id=$1 order by ordinal`,
        [first.trace.id, forgedTraceId],
      );
      await transaction.query(
        `insert into recall_trace_candidates
         select $2,memory_id,ordinal,decision,selected_ordinal,channels,score,exclusion_reason
         from recall_trace_candidates where trace_id=$1 order by ordinal`,
        [first.trace.id, forgedTraceId],
      );
      await transaction.query(
        `insert into recall_trace_sources
         select $2,memory_id,source_event_id,ordinal
         from recall_trace_sources where trace_id=$1 order by memory_id,ordinal`,
        [first.trace.id, forgedTraceId],
      );
      await transaction.query(
        `insert into recall_trace_context_entries
         select $2,ordinal,kind,source_id,scope,version,content_kind,excerpt_digest,created_at
         from recall_trace_context_entries where trace_id=$1 order by ordinal`,
        [first.trace.id, forgedTraceId],
      );
    })).rejects.toThrow("RECALL_TRACE_BODY_BINDING_INVALID");
    await expect(fixture.db.query(
      "update recall_traces set latency_ms=latency_ms+1 where id=$1",
      [first.trace.id],
    )).rejects.toThrow(/IMMUTABLE_RECALL_TRACE/u);
    await expect(fixture.db.query(
      "update transactional_outbox set payload='{}'::jsonb where event_id=$1",
      [first.trace.eventId],
    )).rejects.toThrow(/IMMUTABLE_RECALL_OUTBOX_AUTHORITY/u);
    await expect(recallAuthorized(context, { ...request, query: "different" }))
      .rejects.toThrow("RECALL_IDEMPOTENCY_CONFLICT");
  }, 15_000);

  it("fails closed when a selected memory source or body key has been erased", async () => {
    const fixture = await createConversationFixture("Erased recall");
    await seedMemory(fixture.db, {
      scope: "PRIVATE_ACCOUNT",
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      text: "This source will be forgotten.",
      keyword: "forgotten",
    });
    await fixture.db.query("delete from aggregate_data_keys where aggregate_id=$1", [fixture.conversationId]);
    const context = await authorizeRecall(fixture.db, { role: "ACCOUNT", accountId: fixture.accountId });
    const result = await recallAuthorized(context, {
      query: "forgotten",
      maxMemories: 3,
      tokenBudget: 500,
      responseId: randomUUID(),
      idempotencyKey: `erased:${randomUUID()}`,
      occurredAt: NOW,
      policyVersion: "recall-policy-v1",
      modelVersion: "response-model-v1",
      plannerVersion: "recall-planner-v1",
    });
    expect(result.memories).toHaveLength(0);
  });

  it("bounds query groups, graph depth, candidates, and output independently of table size", async () => {
    const fixture = await createConversationFixture("Bounded recall");
    await seedMemory(fixture.db, {
      scope: "PRIVATE_ACCOUNT",
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      text: "Bounded indexed retrieval fixture.",
      keyword: "bounded",
    });
    const statements: string[] = [];
    const observedDb = observeDatabase(fixture.db, statements);
    const context = await authorizeRecall(observedDb, { role: "ACCOUNT", accountId: fixture.accountId });
    const result = await recallAuthorized(context, {
      query: "bounded",
      maxMemories: 24,
      tokenBudget: 8_000,
      graphDepth: 2,
      responseId: randomUUID(),
      idempotencyKey: `bounded:${randomUUID()}`,
      occurredAt: NOW,
      policyVersion: "recall-policy-v1",
      modelVersion: "response-model-v1",
      plannerVersion: "recall-planner-v1",
    });
    expect(result.trace.queryPlan.map(({ kind }) => kind)).toEqual([
      "CURRENT_STATE", "RECENT", "ENTITY", "TIME", "FULL_TEXT",
      "VECTOR", "GRAPH", "PROCEDURE", "GOAL",
    ]);
    expect(result.trace.queryPlan.every((step) => step.limit <= 20)).toBe(true);
    expect(result.trace.queryPlan.find((step) => step.kind === "GRAPH")?.depth).toBe(2);
    expect(result.trace.authorizedCandidateIds.length).toBeLessThanOrEqual(100);
    expect(result.memories.length).toBeLessThanOrEqual(24);
    expect(statements.filter((sql) => sql.includes("recall-channel:")).length).toBeLessThanOrEqual(9);
    expect(statements.filter((sql) => sql.includes("from aggregate_data_keys")
      && sql.includes("for key share")).length, statements.join("\n---\n")).toBeLessThanOrEqual(3);
  });

  it("rejects orphan trace events and operational grants for raw private memory", async () => {
    const fixture = await createConversationFixture("Trace authority");
    await expect(fixture.db.transaction(async (transaction) => {
      const body = { requestDigest: "a".repeat(64) };
      await appendEvent(transaction, {
        aggregateId: fixture.conversationId,
        accountId: fixture.accountId,
        actor: { type: "USER", id: fixture.accountId },
        type: "memory.recall.traced",
        visibility: "PRIVATE_ACCOUNT",
        body,
        occurredAt: new Date(NOW),
        promptVersion: "recall-planner-v1",
        modelVersion: "response-model-v1",
        policyVersion: "recall-policy-v1",
        idempotencyKey: `orphan-recall:${canonicalContentDigest(body)}`,
      });
    })).rejects.toThrow(/RECALL_EVENT_TRACE_REQUIRED/u);
    await expect(fixture.db.query(
      `insert into recall_actor_authorities (role,actor_id,scopes)
       values ('OPERATOR','private-reader',array['PRIVATE_ACCOUNT']::text[])`,
    )).rejects.toThrow(/recall_actor_authorities_check/u);
  });

  it("requires one active raw proposal to cover every source before Main graph, key, or body access", async () => {
    const fixture = await createConversationFixture("Main mixed proposal recall");
    const texts = [
      "Private proposal evidence LYNX7 says AAPL needs a completed close.",
      "Undisclosed private evidence ORCA9 says the setup is invalid.",
    ];
    const messages = [];
    for (const [index, text] of texts.entries()) {
      messages.push(await appendMessage(fixture, {
        role: "USER", text, idempotencyKey: `mixed-source:${index}:${randomUUID()}`,
      }));
    }
    await fixture.db.query(
      `insert into main_state_versions(version,author_type,author_id,status)
       values (1,'MAIN_BRAIN','gustavo-main','COMMITTED')`,
    );
    const sources = messages.map((message, index) => ({ eventId: message.eventId, text: texts[index] }));
    const firstAuthorization = await rawProposalForSources(fixture, [sources[0]], "mixed-one");
    const consolidated = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
      scope: "PRIVATE_ACCOUNT",
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      events: messages.map((message, index) => ({
        id: message.eventId, at: message.occurredAt, text: texts[index],
      })),
      extracted: { facts: [{
        text: `${texts[0]} ${texts[1]}`,
        sourceIds: messages.map(({ eventId }) => eventId),
        keywords: ["lynx7", "orca9"], entities: ["AAPL"], embedding: [1, 0],
      }] },
      versions: VERSIONS,
      observedAt: NOW,
      sourceEventId: messages.at(-1)!.eventId,
      idempotencyKey: `mixed-memory:${randomUUID()}`,
    });
    const statements: string[] = [];
    const main = await authorizeRecall(observeDatabase(fixture.db, statements), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    statements.length = 0;
    const denied = await recallAuthorized(main, authorizedRequest({
      query: "LYNX7 ORCA9 AAPL", occurredAt: NOW,
    }));
    expect(denied.memories).toHaveLength(0);
    expect(statements.some((sql) => sql.includes("recall-channel:GRAPH"))).toBe(false);
    expect(statements.some((sql) => sql.includes("select aggregate_id,root_key_version")
      && sql.includes(fixture.conversationId))).toBe(false);
    expect(statements.some((sql) => sql.includes(
      "select event_id::text,aggregate_id,data_key_id,ciphertext",
    )), statements.join("\n---\n"))
      .toBe(false);

    const allAuthorization = await rawProposalForSources(fixture, sources, "mixed-all");
    const permitted = await recallAuthorized(main, authorizedRequest({
      query: "LYNX7 ORCA9 AAPL", occurredAt: NOW,
    }));
    expect(permitted.memories.map(({ id }) => id)).toContain(consolidated.memories[0].id);
    await revokeDisclosureAuthorization({ db: fixture.db }, {
      accountId: fixture.accountId,
      authorizationId: allAuthorization.id,
      idempotencyKey: `proposal-revoke:${randomUUID()}`,
    });
    await revokeDisclosureAuthorization({ db: fixture.db }, {
      accountId: fixture.accountId,
      authorizationId: firstAuthorization.id,
      idempotencyKey: `proposal-revoke:${randomUUID()}`,
    });
    const afterRevocation = await recallAuthorized(main, authorizedRequest({
      query: "LYNX7 ORCA9 AAPL", occurredAt: NOW,
    }));
    expect(afterRevocation.memories).toHaveLength(0);
  }, 30_000);

  it("serializes account deactivation and proposal revocation against protected recall", async () => {
    const fixture = await createConversationFixture("Recall lock ordering");
    await seedMemory(fixture.db, {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      text: "AAPL protected lock evidence.", keyword: "protected",
    });
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const queryReached = new Promise<void>((resolve) => { reached = resolve; });
    let gateUsed = false;
    const gated = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        const rows = await database.query<Row>(sql, parameters);
        if (!gateUsed && sql.includes("recall-channel:GOAL")) {
          gateUsed = true;
          reached();
          await held;
        }
        return rows;
      },
      one: (sql, parameters) => database.one(sql, parameters),
      transaction: (work) => database.transaction((transaction) => work(gated(transaction))),
    });
    const context = await authorizeRecall(gated(fixture.db), {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const recall = recallAuthorized(context, authorizedRequest({ query: "protected AAPL" }));
    await queryReached;
    let deactivated = false;
    const deactivation = fixture.db.query(
      "update entitlements set revoked_at=clock_timestamp() where account_id=$1",
      [fixture.accountId],
    ).then(() => { deactivated = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deactivationWaitedForCommit = !deactivated;
    release();
    await recall.catch(() => undefined);
    await deactivation;
    expect(deactivationWaitedForCommit).toBe(true);
  }, 15_000);

  it("makes proposal revocation wait for an authorized recall or win before protected access", async () => {
    const fixture = await createConversationFixture("Recall proposal lock");
    const text = "Private proposal lock TIGER8 covers AAPL evidence.";
    const message = await appendMessage(fixture, {
      role: "USER", text, idempotencyKey: `proposal-lock-source:${randomUUID()}`,
    });
    await fixture.db.query(
      `insert into main_state_versions(version,author_type,author_id,status)
       values (1,'MAIN_BRAIN','gustavo-main','COMMITTED')`,
    );
    const authorization = await rawProposalForSources(fixture, [{ eventId: message.eventId, text }], "lock");
    await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      events: [{ id: message.eventId, at: message.occurredAt, text }],
      extracted: { facts: [{
        text, sourceIds: [message.eventId], keywords: ["tiger8"],
        entities: ["AAPL"], embedding: [1, 0],
      }] },
      versions: VERSIONS, observedAt: NOW, sourceEventId: message.eventId,
      idempotencyKey: `proposal-lock-memory:${randomUUID()}`,
    });
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const queryReached = new Promise<void>((resolve) => { reached = resolve; });
    let gateUsed = false;
    const gated = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        const rows = await database.query<Row>(sql, parameters);
        if (!gateUsed && sql.includes("recall-channel:GOAL")) {
          gateUsed = true;
          reached();
          await held;
        }
        return rows;
      },
      one: (sql, parameters) => database.one(sql, parameters),
      transaction: (work) => database.transaction((transaction) => work(gated(transaction))),
    });
    const main = await authorizeRecall(gated(fixture.db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    const recall = recallAuthorized(main, authorizedRequest({ query: "TIGER8 AAPL" }));
    await queryReached;
    let revocationLockReturned = false;
    const observedRevocation = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        const rows = await database.query<Row>(sql, parameters);
        if (sql.includes("pg_advisory_xact_lock")
          && String(parameters?.[0]).startsWith("proposal-disclosure:")) {
          revocationLockReturned = true;
        }
        return rows;
      },
      one: (sql, parameters) => database.one(sql, parameters),
      transaction: (work) => database.transaction((transaction) => work(observedRevocation(transaction))),
    });
    const revocation = revokeDisclosureAuthorization({ db: observedRevocation(fixture.db) }, {
      accountId: fixture.accountId,
      authorizationId: authorization.id,
      idempotencyKey: `proposal-lock-revoke:${randomUUID()}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const revocationWaitedForCommit = !revocationLockReturned;
    release();
    await recall.catch(() => undefined);
    await revocation;
    expect(revocationWaitedForCommit).toBe(true);
  }, 20_000);

  it("rechecks proposal expiry before graph, key, or ciphertext access", async () => {
    const fixture = await createConversationFixture("Recall proposal expiry");
    const text = "Private proposal expiry EAGLE6 covers AAPL evidence.";
    const message = await appendMessage(fixture, {
      role: "USER", text, idempotencyKey: `proposal-expiry-source:${randomUUID()}`,
    });
    await fixture.db.query(
      `insert into main_state_versions(version,author_type,author_id,status)
       values (1,'MAIN_BRAIN','gustavo-main','COMMITTED')`,
    );
    await rawProposalForSources(fixture, [{ eventId: message.eventId, text }], "expiry", 3_000);
    await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      events: [{ id: message.eventId, at: message.occurredAt, text }],
      extracted: { facts: [{
        text, sourceIds: [message.eventId], keywords: ["eagle6"],
        entities: ["AAPL"], embedding: [1, 0],
      }] },
      versions: VERSIONS, observedAt: NOW, sourceEventId: message.eventId,
      idempotencyKey: `proposal-expiry-memory:${randomUUID()}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 3_050));
    const statements: string[] = [];
    const main = await authorizeRecall(observeDatabase(fixture.db, statements), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    statements.length = 0;
    const result = await recallAuthorized(main, authorizedRequest({ query: "EAGLE6 AAPL" }));
    expect(result.memories).toHaveLength(0);
    expect(statements.some((sql) => sql.includes("recall-channel:GRAPH"))).toBe(false);
    expect(statements.some((sql) => sql.includes("select aggregate_id,root_key_version")
      && sql.includes(fixture.conversationId))).toBe(false);
    expect(statements.some((sql) => sql.includes(
      "select event_id::text,aggregate_id,data_key_id,ciphertext",
    )), statements.join("\n---\n"))
      .toBe(false);
  }, 20_000);

  it("assembles bounded canonical Main, Node, Challenge, and native-turn context before memories", async () => {
    const fixture = await createConversationFixture("Recall working context");
    const foreign = await createConversationFixture("Recall foreign context", fixture.db);
    await commitBroadcast({ db: fixture.db }, {
      mainStateVersion: 41,
      body: "AAPL current Main state uses completed bars.",
      sourceIds: ["recall-main-state"],
      idempotencyKey: `recall-main:${randomUUID()}`,
    });
    const user = await appendMessage(fixture, {
      role: "USER", text: "My newest native turn is AAPL only.",
      idempotencyKey: `working-user:${randomUUID()}`,
    });
    await appendMessage(fixture, {
      role: "NODE", text: "The Node is still evaluating that AAPL turn.",
      idempotencyKey: `working-node:${randomUUID()}`,
    });
    await appendMessage(foreign, {
      role: "USER", text: "FOREIGN_CONTEXT_MUST_NOT_APPEAR",
      idempotencyKey: `working-foreign:${randomUUID()}`,
    });
    await routeNodeReply({
      db: fixture.db, accountId: fixture.accountId, conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId, userMessageEventId: user.eventId,
      coveredByMain: false, contradiction: false, materialEvidence: false,
      confidence: 0.7, mainStateVersion: "41", sourceIds: [user.eventId],
    }, async () => undefined);
    await seedCurrentChallenge(fixture.db);
    const context = await authorizeRecall(fixture.db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const result = await recallAuthorized(context, authorizedRequest({
      query: "unconsolidated AAPL", tokenBudget: 2_000,
    }));
    const pack = result.contextPack as unknown as {
      entries: readonly { kind: string; excerpt: string; version: string | null }[];
      estimatedTokens: number;
    };
    expect(pack.entries.map(({ kind }) => kind).slice(0, 3)).toEqual([
      "MAIN_STATE", "NODE_STATE", "CHALLENGE_STATE",
    ]);
    expect(pack.entries.filter(({ kind }) => kind === "RECENT_TURN").length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(pack.entries)).toContain("current Main state");
    expect(JSON.stringify(pack.entries)).toContain("My newest native turn");
    expect(JSON.stringify(pack.entries)).toContain("2500.00");
    expect(JSON.stringify(pack.entries)).not.toContain("FOREIGN_CONTEXT_MUST_NOT_APPEAR");
  }, 20_000);

  it("publishes indexed bounded-preselection contracts for every recall source", async () => {
    const db = await openTestDb();
    const indexes = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname,indexdef from pg_indexes where schemaname=current_schema()
       and tablename in ('memory_records','memory_graph_edges','memory_vector_buckets','proposals')
       order by indexname`,
    );
    const definitions = indexes.map(({ indexdef }) => indexdef).join("\n");
    expect(definitions).toMatch(/memory_records.*created_at.*id/iu);
    expect(definitions).toMatch(/memory_graph_edges.*source_memory_id/iu);
    expect(definitions).toMatch(/memory_graph_edges.*target_memory_id/iu);
    expect(definitions).toMatch(/memory_vector_buckets.*embedding_version.*bucket_digest.*scope.*memory_id/iu);
    expect(definitions).toMatch(/using gin \(source_event_ids\)/iu);
  });

  it("publishes an exact SQL-authoritative trace body manifest and channel allowlist", async () => {
    const db = await openTestDb();
    const traceColumns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema=current_schema() and table_name='recall_traces'`,
    );
    expect(traceColumns.map(({ column_name }) => column_name)).toEqual(expect.arrayContaining([
      "body_authority_digest", "event_request_hash", "event_integrity_hash",
      "outbox_payload_digest", "source_high_water_sequence",
    ]));
    const channelConstraint = await db.query<{ definition: string }>(
      `select pg_get_constraintdef(constraint_row.oid) definition
       from pg_constraint constraint_row join pg_class relation on relation.oid=constraint_row.conrelid
       where relation.relname='recall_trace_candidates'`,
    );
    expect(channelConstraint.map(({ definition }) => definition).join("\n"))
      .toContain("CURRENT_STATE");
  });

  it("conflicts on every behavior-changing request input", async () => {
    const fixture = await createConversationFixture("Recall exact identity");
    await seedMemory(fixture.db, {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      text: "Original AAPL exact replay memory.", keyword: "original",
    });
    const context = await authorizeRecall(fixture.db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const request = authorizedRequest({
      query: "original AAPL", idempotencyKey: `exact-input:${randomUUID()}`,
    });
    await recallAuthorized(context, request);
    const variants: readonly Record<string, unknown>[] = [
      { entities: ["MSFT"] },
      { from: "2026-01-01T00:00:00.000Z" },
      { to: "2026-12-31T00:00:00.000Z" },
      { maxMemories: 3 },
      { tokenBudget: 499 },
      { graphDepth: 1 },
      { embeddingVersion: "embedding-v2" },
      { queryVector: [0, 1] },
    ];
    for (const variant of variants) {
      await expect(recallAuthorized(context, { ...request, ...variant }))
        .rejects.toThrow("RECALL_IDEMPOTENCY_CONFLICT");
    }
  }, 30_000);

  it("hydrates an exact stored selection even after more than 100 newer memories arrive", async () => {
    const fixture = await createConversationFixture("Recall replay pressure");
    const original = await seedMemory(fixture.db, {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      text: "Original AAPL exact replay memory.", keyword: "original",
    });
    const context = await authorizeRecall(fixture.db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const request = authorizedRequest({
      query: "original AAPL", idempotencyKey: `exact-replay:${randomUUID()}`,
    });
    const first = await recallAuthorized(context, request);
    const aggregateId = `public:replay-pressure:${randomUUID()}`;
    const source = await appendEvent(fixture.db, {
      aggregateId, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "PUBLIC",
      body: { text: "AAPL higher-ranked replay pressure." },
      idempotencyKey: `replay-pressure:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
      scope: "PUBLIC",
      events: [{ id: source.id, at: source.occurredAt.toISOString(), text: "AAPL higher-ranked replay pressure." }],
      extracted: { facts: Array.from({ length: 100 }, (_, index) => ({
        text: `AAPL higher-ranked replay pressure ${index}.`,
        sourceIds: [source.id], keywords: ["original"], entities: ["AAPL"],
        embedding: [1, 0], confidence: 1, importance: 1,
      })) },
      versions: VERSIONS, observedAt: NOW, sourceEventId: source.id,
      idempotencyKey: `replay-pressure-memory:${randomUUID()}`,
    });
    await seedMemory(fixture.db, {
      scope: "PUBLIC",
      text: "AAPL higher-ranked replay pressure 101.",
      keyword: "original",
    });
    const replay = await recallAuthorized(context, request);
    expect(replay.trace.id).toBe(first.trace.id);
    expect(replay.memories.map(({ id }) => id)).toEqual(first.trace.selectedMemoryIds);
    expect(replay.memories.map(({ id }) => id)).toContain(original.memoryId);
  }, 60_000);

  it.each([101, 500])("recalls and traces a valid %i-source T19 memory", async (sourceCount) => {
    const db = await openTestDb();
    const memoryId = await seedSourceRichPublicMemory(db, sourceCount);
    const main = await authorizeRecall(db, { role: "MAIN_BRAIN", actorId: "gustavo-main" });
    const result = await recallAuthorized(main, authorizedRequest({
      query: `sources-${sourceCount} AAPL`, tokenBudget: 8_000,
    }));
    expect(result.memories.map(({ id }) => id)).toContain(memoryId);
    expect(result.trace.selectedSourceIds).toHaveLength(sourceCount);
    expect(await db.one<{ count: number }>(
      "select count(*)::int count from recall_trace_sources where trace_id=$1 and memory_id=$2",
      [result.trace.id, memoryId],
    )).toEqual({ count: sourceCount });
  }, 120_000);

  it("budgets the complete serialized context pack", async () => {
    const planned = await planRecall({
      actor: { role: "MAIN_BRAIN", actorId: "gustavo-main" },
      query: "metadata-heavy",
      maxMemories: 1,
      tokenBudget: 100,
      candidates: [candidate({
        text: "short",
        sourceIds: Array.from({ length: 100 }, () => randomUUID()),
      })],
    });
    expect(Math.ceil(JSON.stringify(planned.contextPack).length / 4)).toBeLessThanOrEqual(100);

  });

  it.each(["MAIN_SHARED", "PRIVATE_ACCOUNT"] as const)(
    "retrieves an older exact protected %s term behind more than twenty distractors",
    async (scope) => {
      const fixture = await createConversationFixture(`Hybrid exact ${scope}`);
      await fixture.db.query(
        `insert into main_state_versions(version,author_type,author_id,status)
         values (1,'MAIN_BRAIN','gustavo-main','COMMITTED')`,
      );
      const exactText = `Protected exact ORCHID77 ${scope} evidence.`;
      const target = await seedRecallBatch(fixture, scope, `exact-${scope}`, [
        { text: exactText, keyword: "orchid77", importance: 0.01, embedding: [0, 1] },
      ]);
      await seedRecallBatch(fixture, scope, `exact-distractors-${scope}`, [
        ...Array.from({ length: 25 }, (_, index) => ({
          text: `High importance distractor ${index}.`, keyword: `distractor-${index}`,
          importance: 1, embedding: [0, 1] as readonly number[],
        })),
      ], new Date(Date.parse(NOW) + 1_000).toISOString());
      if (scope === "PRIVATE_ACCOUNT") {
        await rawProposalForSources(fixture, [{
          eventId: target.memories[0].sourceIds[0], text: exactText,
        }], `hybrid-${scope}`);
      } else {
        const unrelatedText = "Unrelated private proposal mentions no orchid token.";
        const unrelated = await appendMessage(fixture, {
          role: "USER", text: unrelatedText,
          idempotencyKey: `hybrid-unrelated-proposal:${randomUUID()}`,
        });
        await rawProposalForSources(fixture, [{
          eventId: unrelated.eventId, text: unrelatedText,
        }], `hybrid-unrelated-${scope}`);
      }
      const main = await authorizeRecall(fixture.db, {
        role: "MAIN_BRAIN", actorId: "gustavo-main",
      });
      const result = await recallAuthorized(main, authorizedRequest({
        query: "ORCHID77", entities: [], queryVector: [1, 0], tokenBudget: 2_000,
      }));
      const traced = await fixture.db.query<{
        decision: string; channels: string[]; score: string; exclusion_reason: string | null;
      }>(
        `select decision,channels,score::text,exclusion_reason
         from recall_trace_candidates where trace_id=$1 and memory_id=$2`,
        [result.trace.id, target.memories[0].id],
      );
      expect(traced[0]?.decision, JSON.stringify(traced[0])).toBe("SELECTED");
      expect(traced[0]?.channels).toContain("FULL_TEXT");
      expect(Number(traced[0]?.score)).toBeCloseTo(1, 9);
      expect(result.memories.map(({ id }) => id)).toContain(target.memories[0].id);
    },
    30_000,
  );

  it.each(["PUBLIC", "MAIN_SHARED"] as const)(
    "retrieves the nearest low-importance %s vector behind more than one hundred distractors",
    async (scope) => {
    const fixture = await createConversationFixture(`Hybrid vector preselection ${scope}`);
    const target = await seedRecallBatch(fixture, scope, `nearest-vector-${scope}`, [
      { text: "The exact nearest vector target.", keyword: "target-only", importance: 0.01,
        embedding: [1, 0] },
    ]);
    const distractors = Array.from({ length: 125 }, (_, index) => ({
      text: `Vector distractor ${index}.`, keyword: `vector-distractor-${index}`,
      importance: 1, embedding: [0, 1] as readonly number[],
    }));
    for (const [batch, offset] of [0, 75].entries()) {
      await seedRecallBatch(
        fixture, scope, `nearest-vector-distractors-${scope}-${batch}`,
        distractors.slice(offset, offset + 75),
        new Date(Date.parse(NOW) + 1_000 + batch).toISOString(),
      );
    }
    const main = await authorizeRecall(fixture.db, {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    const result = await recallAuthorized(main, authorizedRequest({
      query: "no lexical match", entities: [], queryVector: [1, 0], tokenBudget: 2_000,
    }));
    const traced = await fixture.db.query<{
      decision: string; channels: string[]; score: string; exclusion_reason: string | null;
      valid_to: string | null; conflict_state: string; importance: string;
    }>(
      `select candidate.decision,candidate.channels,candidate.score::text,
              candidate.exclusion_reason,memory.valid_to::text,memory.conflict_state,
              memory.importance::text
       from recall_trace_candidates candidate
       join memory_records memory on memory.id=candidate.memory_id
       where candidate.trace_id=$1 and candidate.memory_id=$2`,
      [result.trace.id, target.memories[0].id],
    );
    expect(traced[0]?.decision, JSON.stringify(traced[0])).toBe("SELECTED");
    expect(traced[0]?.channels).toEqual(expect.arrayContaining(["VECTOR"]));
    expect(Number(traced[0]?.score)).toBeCloseTo(1, 9);
    expect(result.memories.map(({ id }) => id)).toContain(target.memories[0].id);
  }, 30_000);

  it("keeps recall indexes eligible for historical rows and proposal locking query-count constant", async () => {
    const fixture = await createConversationFixture("Proposal lock scale");
    await fixture.db.query(
      `insert into main_state_versions(version,author_type,author_id,status)
       values (1,'MAIN_BRAIN','gustavo-main','COMMITTED')`,
    );
    for (let index = 0; index < 4; index += 1) {
      const text = `Unrelated proposal ${index} exact evidence.`;
      const message = await appendMessage(fixture, {
        role: "USER", text, idempotencyKey: `lock-scale-source:${index}:${randomUUID()}`,
      });
      await rawProposalForSources(fixture, [{ eventId: message.eventId, text }], `lock-scale-${index}`);
    }
    const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
    const observed: EventDatabase = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => { calls.push({ sql, parameters }); return fixture.db.query<Row>(sql, parameters); },
      one: (sql, parameters) => fixture.db.one(sql, parameters),
      transaction: (work) => fixture.db.transaction((transaction) => work({
        ...transaction,
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string, parameters?: readonly unknown[],
        ): Promise<Row[]> => { calls.push({ sql, parameters }); return transaction.query<Row>(sql, parameters); },
      })),
    };
    const main = await authorizeRecall(observed, { role: "MAIN_BRAIN", actorId: "gustavo-main" });
    calls.length = 0;
    await recallAuthorized(main, authorizedRequest({ query: "not-present", entities: [] }));
    expect(calls.filter(({ sql, parameters }) => sql.includes("pg_advisory_xact_lock")
      && String(parameters?.[0]).startsWith("proposal-disclosure:")).length).toBeLessThanOrEqual(1);
    const recent = await fixture.db.one<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname=current_schema() and indexname='recall_memory_recent_idx'`,
    );
    expect(recent.indexdef).not.toMatch(/\bwhere\b/iu);
    for (const channel of ["RECENT", "FULL_TEXT", "VECTOR"] as const) {
      const captured = calls.find(({ sql }) => sql.includes(`/* recall-channel:${channel} */`));
      if (!captured) throw new Error(`MISSING_CAPTURED_${channel}_QUERY`);
      const explained = await fixture.db.transaction(async (transaction) => {
        await transaction.query("set local enable_seqscan=off");
        return transaction.one<Record<string, unknown>>(
          `explain (format json) ${captured.sql}`, captured.parameters,
        );
      });
      const plan = JSON.stringify(explained);
      expect(plan).not.toMatch(/Seq Scan[^}]*memory_records/iu);
      if (channel === "RECENT") expect(plan).toContain("recall_memory_recent_idx");
      else if (channel === "VECTOR") expect(plan).toContain("memory_vector_buckets_lookup_idx");
      else expect(plan).toMatch(/(memory_index_terms_public_text|recall_(public_term_fts|protected_term_digest))_idx/u);
    }
  }, 45_000);

  it("pins the highest-ordinal Challenge stage and its complete checkpoint projection", async () => {
    const fixture = await createConversationFixture("Current Challenge stage");
    const firstStage = await seedCurrentChallenge(fixture.db);
    await appendChallengeLedgerEvent({ db: fixture.db }, {
      id: randomUUID(), challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      stageId: firstStage, profileVersionId: INITIAL_PROFILE.profileVersionId,
      type: "challenge.paused", payload: {}, occurredAt: NOW, actorType: "SYSTEM",
      actorId: "challenge-stage-lifecycle", idempotencyKey: `old-stage-delta:${randomUUID()}`,
    });
    const currentStage = randomUUID();
    await fixture.db.query(
      `insert into challenge_stages (
         id,challenge_portfolio_id,profile_version_id,stage_profile_id,ordinal,created_at
       ) values ($1,$2,$3,'00000000-0000-4000-8000-000000001212',2,$4)`,
      [currentStage, INITIAL_PROFILE.challengePortfolioId, INITIAL_PROFILE.profileVersionId,
        new Date(Date.parse(NOW) + 1_000).toISOString()],
    );
    const started = await appendChallengeLedgerEvent({ db: fixture.db }, {
      id: randomUUID(), challengePortfolioId: INITIAL_PROFILE.challengePortfolioId,
      stageId: currentStage, profileVersionId: INITIAL_PROFILE.profileVersionId,
      type: "stage.started", payload: { amount: "5000.00" },
      occurredAt: new Date(Date.parse(NOW) + 1_000).toISOString(), actorType: "SYSTEM",
      actorId: "challenge-stage-lifecycle", idempotencyKey: `current-stage:${randomUUID()}`,
    });
    const projection = replayStoredLedgerEvents(await loadChallengeLedgerEvents(
      { db: fixture.db }, currentStage,
    ));
    await replaceProjectionCheckpoint({ db: fixture.db }, {
      stageId: currentStage, profileVersionId: INITIAL_PROFILE.profileVersionId,
      highWaterEventId: started.id, highWaterSequence: "1", projection,
    });
    const account = await authorizeRecall(fixture.db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const result = await recallAuthorized(account, authorizedRequest({
      query: "challenge snapshot", tokenBudget: 2_000,
    }));
    const entry = result.contextPack.entries.find(({ kind }) => kind === "CHALLENGE_STATE");
    expect(entry?.id).toBe(started.id);
    expect(entry?.version).toBe(`${currentStage}:1`);
    expect(entry?.excerpt).toContain('"balance":"5000.00"');
    expect(entry?.excerpt).toContain(`"stageId":"${currentStage}"`);
  }, 30_000);

  it.each(["WITHDRAWN", "REJECTED", "EXPIRED"] as const)(
    "revalidates proposal authority immediately before ciphertext when it becomes %s",
    async (outcome) => {
      const fixture = await createConversationFixture(`Proposal post-scan ${outcome}`);
      const text = `Post-scan ${outcome} private LOTUS88 evidence.`;
      const message = await appendMessage(fixture, {
        role: "USER", text, idempotencyKey: `post-scan-source:${outcome}:${randomUUID()}`,
      });
      await fixture.db.query(
        `insert into main_state_versions(version,author_type,author_id,status)
         values (1,'MAIN_BRAIN','gustavo-main','COMMITTED')`,
      );
      const authority = await rawProposalForSources(
        fixture, [{ eventId: message.eventId, text }], `post-scan-${outcome}`,
        outcome === "EXPIRED" ? 1_500 : 10 * 60_000,
      );
      if (outcome === "REJECTED") {
        await queueProposalForMainDecision(fixture, authority, `post-scan-${outcome}`);
      }
      const projected = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
        scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
        events: [{ id: message.eventId, at: message.occurredAt, text }],
        extracted: { facts: [{ text, sourceIds: [message.eventId], keywords: ["lotus88"],
          entities: [], embedding: [1, 0] }] }, versions: VERSIONS, observedAt: NOW,
        sourceEventId: message.eventId, idempotencyKey: `post-scan-memory:${outcome}:${randomUUID()}`,
      });
      let release!: () => void;
      let reached!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const atHydration = new Promise<void>((resolve) => { reached = resolve; });
      const protectedBody = await fixture.db.one<{ body_event_id: string }>(
        "select body_event_id::text from memory_records where id=$1", [projected.memories[0].id],
      );
      const statements: { sql: string; parameters?: readonly unknown[] }[] = [];
      let gated = false;
      const wrap = (database: EventDatabase): EventDatabase => ({
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string, parameters?: readonly unknown[],
        ): Promise<Row[]> => {
          if (!gated && sql.includes("select broadcast.commit_event_id")) {
            gated = true; reached(); await held;
          }
          statements.push({ sql, parameters });
          return database.query<Row>(sql, parameters);
        },
        one: (sql, parameters) => database.one(sql, parameters),
        transaction: (work) => database.transaction((transaction) => work(wrap(transaction))),
      });
      const main = await authorizeRecall(wrap(fixture.db), {
        role: "MAIN_BRAIN", actorId: "gustavo-main",
      });
      statements.length = 0;
      const recall = recallAuthorized(main, authorizedRequest({
        query: "LOTUS88", entities: [], tokenBudget: 2_000,
      }));
      await atHydration;
      let authorityCompleted = false;
      let authorityChange: Promise<unknown> | null = null;
      if (outcome === "WITHDRAWN" || outcome === "REJECTED") {
        authorityChange = transitionProposal({ db: fixture.db }, {
          proposalId: authority.proposalId,
          actor: outcome === "WITHDRAWN"
            ? { type: "NODE_BRAIN", id: fixture.nodeBrainId }
            : { type: "MAIN_BRAIN", id: "gustavo-main" },
          toStatus: outcome, reason: `${outcome} before recall hydration.`,
          idempotencyKey: `post-scan-${outcome.toLowerCase()}:${randomUUID()}`,
        }).then((value) => { authorityCompleted = true; return value; });
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1_600));
        authorityCompleted = true;
      }
      const authorityWonBeforeHydration = authorityCompleted;
      release();
      const result = await recall;
      if (authorityChange) await authorityChange;
      if (authorityWonBeforeHydration) {
        expect(result.memories).toHaveLength(0);
        expect(statements.some(({ sql, parameters }) => sql.includes(
          "select event_id::text,aggregate_id,data_key_id,ciphertext",
        ) && (parameters?.[0] as readonly unknown[] | undefined)?.includes(
          protectedBody.body_event_id,
        ))).toBe(false);
      }
    },
    30_000,
  );

  it("rechecks a proposal created and revoked after the initial authority scan", async () => {
    const fixture = await createConversationFixture("Late proposal revocation");
    const text = "Late proposal private IRIS66 evidence.";
    const message = await appendMessage(fixture, {
      role: "USER", text, idempotencyKey: `late-proposal-source:${randomUUID()}`,
    });
    await fixture.db.query(
      `insert into main_state_versions(version,author_type,author_id,status)
       values (1,'MAIN_BRAIN','gustavo-main','COMMITTED')`,
    );
    const route = await routeNodeReply({
      db: fixture.db, accountId: fixture.accountId, conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId, userMessageEventId: message.eventId,
      coveredByMain: false, contradiction: true, materialEvidence: true,
      confidence: 0.95, mainStateVersion: "1", sourceIds: [message.eventId],
    }, async () => undefined);
    const disclosure = await createDisclosureAuthorization({ db: fixture.db }, {
      accountId: fixture.accountId, conversationId: fixture.conversationId,
      sourceEventIds: [message.eventId], disclosedText: text,
      privacyScope: "PROPOSAL_RAW_TEXT", purpose: "MAIN_PROPOSAL_REVIEW",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      idempotencyKey: `late-created-disclosure:${randomUUID()}`,
    });
    const projected = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      events: [{ id: message.eventId, at: message.occurredAt, text }],
      extracted: { facts: [{ text, sourceIds: [message.eventId], keywords: ["iris66"],
        entities: [], embedding: [1, 0] }] }, versions: VERSIONS, observedAt: NOW,
      sourceEventId: message.eventId, idempotencyKey: `late-proposal-memory:${randomUUID()}`,
    });
    const protectedBody = await fixture.db.one<{ body_event_id: string }>(
      "select body_event_id::text from memory_records where id=$1", [projected.memories[0].id],
    );
    let releaseScan!: () => void;
    let releaseHydration!: () => void;
    let scanReached!: () => void;
    let hydrationReached!: () => void;
    const scanHeld = new Promise<void>((resolve) => { releaseScan = resolve; });
    const hydrationHeld = new Promise<void>((resolve) => { releaseHydration = resolve; });
    const atScan = new Promise<void>((resolve) => { scanReached = resolve; });
    const atHydration = new Promise<void>((resolve) => { hydrationReached = resolve; });
    const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
    let scanGated = false;
    let hydrationGated = false;
    const wrap = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        if (!hydrationGated && sql.includes("select broadcast.commit_event_id")) {
          hydrationGated = true; hydrationReached(); await hydrationHeld;
        }
        calls.push({ sql, parameters });
        const rows = await database.query<Row>(sql, parameters);
        if (!scanGated && sql.includes("recall-proposal-authority-scan")) {
          scanGated = true; scanReached(); await scanHeld;
        }
        return rows;
      },
      one: (sql, parameters) => database.one(sql, parameters),
      transaction: (work) => database.transaction((transaction) => work(wrap(transaction))),
    });
    const main = await authorizeRecall(wrap(fixture.db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    const recall = recallAuthorized(main, authorizedRequest({
      query: "IRIS66", entities: [], tokenBudget: 2_000,
    }));
    await atScan;
    const originalPseudonymKey = process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY;
    process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY = randomBytes(32).toString("base64");
    try {
      await createProposal({ db: fixture.db }, {
        accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId, sourceEventIds: [message.eventId],
        routeEventId: route.routingEventId, affectedMainStateIds: ["1"],
        privacyScope: "PROPOSAL_RAW_TEXT", proposedChange: text,
        evidence: [{ kind: "SOURCE_EVENT", referenceId: message.eventId }],
        counterevidence: [], uncertainty: "Late proposal can still be wrong.",
        rawPrivateText: text, disclosureAuthorizationId: disclosure.id,
        idempotencyKey: `late-created-proposal:${randomUUID()}`,
      });
    } finally {
      if (originalPseudonymKey === undefined) delete process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY;
      else process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY = originalPseudonymKey;
    }
    releaseScan();
    await atHydration;
    await revokeDisclosureAuthorization({ db: fixture.db }, {
      accountId: fixture.accountId, authorizationId: disclosure.id,
      idempotencyKey: `late-created-revoke:${randomUUID()}`,
    });
    releaseHydration();
    const result = await recall;
    expect(result.memories).toHaveLength(0);
    expect(calls.some(({ sql, parameters }) => sql.includes(
      "select event_id::text,aggregate_id,data_key_id,ciphertext",
    ) && (parameters?.[0] as readonly unknown[] | undefined)?.includes(
      protectedBody.body_event_id,
    ))).toBe(false);
  }, 45_000);

  it("persists typed zero-memory context influences and exact body/candidate authority", async () => {
    const fixture = await createConversationFixture("Trace context influences");
    await commitBroadcast({ db: fixture.db }, {
      mainStateVersion: 51, body: "Context-only Main state.", sourceIds: ["context-only"],
      idempotencyKey: `context-only-main:${randomUUID()}`,
    });
    const user = await appendMessage(fixture, {
      role: "USER", text: "Context-only recent native turn.",
      idempotencyKey: `context-only-user:${randomUUID()}`,
    });
    await routeNodeReply({
      db: fixture.db, accountId: fixture.accountId, conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId, userMessageEventId: user.eventId,
      coveredByMain: false, contradiction: false, materialEvidence: false,
      confidence: 0.7, mainStateVersion: "51", sourceIds: [user.eventId],
    }, async () => undefined);
    await seedCurrentChallenge(fixture.db);
    const account = await authorizeRecall(fixture.db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const result = await recallAuthorized(account, authorizedRequest({
      query: "no matching derived memory", entities: [], queryVector: [0, 1], tokenBudget: 2_000,
    }));
    expect(result.memories).toHaveLength(0);
    const influences = await fixture.db.query<{
      kind: string; source_id: string; version: string | null; ordinal: number;
    }>(
      `select kind,source_id::text,version,ordinal from recall_trace_context_entries
       where trace_id=$1 order by ordinal`, [result.trace.id],
    );
    expect(influences.map(({ kind }) => kind)).toEqual([
      "MAIN_STATE", "NODE_STATE", "CHALLENGE_STATE", "RECENT_TURN",
    ]);
    const authority = await fixture.db.one<{
      body_valid: boolean; candidates_valid: boolean;
    }>(
      `select recall_trace_body_binding_is_valid(trace) body_valid,
              recall_trace_candidates_match_authority(trace.id) candidates_valid
       from recall_traces trace where trace.id=$1`, [result.trace.id],
    );
    expect(authority).toEqual({ body_valid: true, candidates_valid: true });
    const body = await readEventBody(fixture.db, result.trace.eventId, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    });
    expect(body).toMatchObject({ contextEntries: influences.map(({ kind, source_id, version }) => ({
      kind, sourceId: source_id, version,
    })) });
  }, 30_000);

  it("separates every behavior-changing cache key and never reports an unused hit", async () => {
    const fixture = await createConversationFixture("Recall cache identity");
    const keys: string[] = [];
    const context = await authorizeRecall(fixture.db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    }, { cache: { get: (key) => { keys.push(key); return { untrusted: "value" }; } } });
    const variants = [
      {}, { entities: ["MSFT"] }, { maxMemories: 3 }, { tokenBudget: 499 },
      { graphDepth: 1 }, { embeddingVersion: "embedding-v2" }, { queryVector: [0, 1] },
      { modelVersion: "response-model-v2" },
    ];
    const results = [];
    for (const variant of variants) {
      results.push(await recallAuthorized(context, authorizedRequest({
        ...variant, idempotencyKey: `cache-key:${randomUUID()}`,
      })));
    }
    expect(new Set(keys).size).toBe(variants.length);
    expect(results.every(({ trace }) => trace.cacheUse !== "HIT")).toBe(true);
  }, 30_000);

  it("refuses a protected consolidation body unless one current proposal covers every sibling memory", async () => {
    const fixture = await createConversationFixture("Recall whole-body proposal authority");
    const firstText = "Disclosed sibling FALCON71 supports the completed AAPL close.";
    const secondText = "Undisclosed sibling BADGER42 contradicts the same AAPL setup.";
    const first = await appendMessage(fixture, {
      role: "USER", text: firstText, idempotencyKey: `body-sibling-a:${randomUUID()}`,
    });
    const second = await appendMessage(fixture, {
      role: "USER", text: secondText, idempotencyKey: `body-sibling-b:${randomUUID()}`,
    });
    await fixture.db.query(
      `insert into main_state_versions(version,author_type,author_id,status)
       values (1,'MAIN_BRAIN','gustavo-main','COMMITTED')`,
    );
    await rawProposalForSources(fixture, [{ eventId: first.eventId, text: firstText }], "body-one");
    const run = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      events: [
        { id: first.eventId, at: first.occurredAt, text: firstText },
        { id: second.eventId, at: second.occurredAt, text: secondText },
      ],
      extracted: { facts: [
        { text: firstText, sourceIds: [first.eventId], keywords: ["falcon71"],
          entities: [], embedding: [1, 0] },
        { text: secondText, sourceIds: [second.eventId], keywords: ["badger42"],
          entities: [], embedding: [0, 1] },
      ] },
      versions: VERSIONS, observedAt: NOW, sourceEventId: second.eventId,
      idempotencyKey: `body-siblings:${randomUUID()}`,
    });
    const body = await fixture.db.one<{ body_event_id: string; aggregate_id: string }>(
      `select memory.body_event_id::text,event.aggregate_id
       from memory_records memory join events event on event.id=memory.body_event_id
       where memory.id=$1`, [run.memories[0].id],
    );
    const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
    const observed = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        calls.push({ sql, parameters });
        return database.query<Row>(sql, parameters);
      },
      one: (sql, parameters) => database.one(sql, parameters),
      transaction: (work) => database.transaction((transaction) => work(observed(transaction))),
    });
    const main = await authorizeRecall(observed(fixture.db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    const denied = await recallAuthorized(main, authorizedRequest({
      query: "FALCON71", entities: [], tokenBudget: 2_000,
    }));
    expect(denied.memories).toHaveLength(0);
    expect(calls.some(({ sql, parameters }) => sql.includes("from aggregate_data_keys")
      && (parameters?.[0] as readonly unknown[] | undefined)?.includes(body.aggregate_id))).toBe(false);
    expect(calls.some(({ sql, parameters }) => sql.includes(
      "select event_id::text,aggregate_id,data_key_id,ciphertext",
    ) && (parameters?.[0] as readonly unknown[] | undefined)?.includes(body.body_event_id))).toBe(false);

    await rawProposalForSources(fixture, [
      { eventId: first.eventId, text: firstText },
      { eventId: second.eventId, text: secondText },
    ], "body-all");
    const permitted = await recallAuthorized(main, authorizedRequest({
      query: "FALCON71", entities: [], tokenBudget: 2_000,
    }));
    expect(permitted.memories.map(({ id }) => id)).toContain(run.memories[0].id);
  }, 30_000);

  it("does not decrypt a protected body when any sibling source has been erased", async () => {
    const db = await openTestDb();
    const firstText = "Live shared sibling HAWK31 supports the AAPL close.";
    const secondText = "Erased shared sibling MOOSE24 contradicts that close.";
    const sharedAggregate = `shared-sibling-erasure:${randomUUID()}`;
    const first = await appendEvent(db, {
      aggregateId: sharedAggregate, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "SHARED", body: { text: firstText },
      idempotencyKey: `shared-live:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    const second = await appendEvent(db, {
      aggregateId: sharedAggregate, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "SHARED", body: { text: secondText },
      idempotencyKey: `shared-erased:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    const run = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", events: [
        { id: first.id, at: first.occurredAt.toISOString(), text: firstText },
        { id: second.id, at: second.occurredAt.toISOString(), text: secondText },
      ],
      extracted: { facts: [
        { text: firstText, sourceIds: [first.id], keywords: ["hawk31"],
          entities: [], embedding: [1, 0] },
        { text: secondText, sourceIds: [second.id], keywords: ["moose24"],
          entities: [], embedding: [0, 1] },
      ] }, versions: VERSIONS, observedAt: NOW, sourceEventId: second.id,
      idempotencyKey: `shared-erased-body:${randomUUID()}`,
    });
    const bodyEventId = await db.one<{ body_event_id: string }>(
      "select body_event_id::text from memory_records where id=$1", [run.memories[0].id],
    );
    await db.query("update encrypted_event_bodies set data_key_id=null where event_id=$1", [second.id]);
    const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
    const observed = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => { calls.push({ sql, parameters }); return database.query<Row>(sql, parameters); },
      one: (sql, parameters) => database.one(sql, parameters),
      transaction: (work) => database.transaction((transaction) => work(observed(transaction))),
    });
    const main = await authorizeRecall(observed(db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    const result = await recallAuthorized(main, authorizedRequest({
      query: "HAWK31", entities: [], tokenBudget: 2_000,
    }));
    expect(result.memories).toHaveLength(0);
    expect(calls.some(({ sql, parameters }) => sql.includes(
      "select event_id::text,aggregate_id,data_key_id,ciphertext",
    ) && (parameters?.[0] as readonly unknown[] | undefined)?.includes(
      bodyEventId.body_event_id,
    ))).toBe(false);
  }, 20_000);

  it("binds the Node state version to the routed reply despite newer conversation events", async () => {
    const fixture = await createConversationFixture("Recall Node route version");
    const routedUser = await appendMessage(fixture, {
      role: "USER", text: "Route this first private turn.",
      idempotencyKey: `node-version-routed-user:${randomUUID()}`,
    });
    const routed = await routeNodeReply({
      db: fixture.db, accountId: fixture.accountId, conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId, userMessageEventId: routedUser.eventId,
      coveredByMain: false, contradiction: false, materialEvidence: false,
      confidence: 0.7, mainStateVersion: "1", sourceIds: [routedUser.eventId],
    }, async () => undefined);
    await appendMessage(fixture, {
      role: "USER", text: "A newer user turn must not become the Node route version.",
      idempotencyKey: `node-version-new-user:${randomUUID()}`,
    });
    await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId, accountId: fixture.accountId,
      actor: { type: "USER", id: fixture.accountId }, type: "memory.source.imported",
      visibility: "PRIVATE_ACCOUNT", body: { text: "A newer imported source event." },
      idempotencyKey: `node-version-import:${randomUUID()}`,
      occurredAt: new Date(Date.parse(NOW) + 1_000), policyVersion: "recall-fixture-v1",
    });
    const routeSequence = await fixture.db.one<{ ingested_sequence: string }>(
      "select ingested_sequence::text from events where id=$1", [routed.routingEventId],
    );
    const account = await authorizeRecall(fixture.db, {
      role: "ACCOUNT", accountId: fixture.accountId,
    });
    const result = await recallAuthorized(account, authorizedRequest({
      query: "node route state", entities: [], tokenBudget: 2_000,
    }));
    const node = result.contextPack.entries.find(({ kind }) => kind === "NODE_STATE");
    expect(result.trace.stateVersions.node).toBe(routeSequence.ingested_sequence);
    expect(node).toMatchObject({ id: routed.routingEventId, version: routeSequence.ingested_sequence });
    expect(BigInt(result.trace.highWaterSequence)).toBeGreaterThan(BigInt(routeSequence.ingested_sequence));
  }, 20_000);

  it("persists a 500-source RecallTrace with constant set-wise writes and a commit-bound deadline", async () => {
    const db = await openTestDb();
    const memoryId = await seedSourceRichPublicMemory(db, 500);
    const calls: string[] = [];
    let clock = 0;
    let advanceAtFinalTraceRead = false;
    const observed = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        calls.push(sql);
        return database.query<Row>(sql, parameters);
      },
      one: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row> => {
        calls.push(sql);
        const row = await database.one<Row>(sql, parameters);
        if (advanceAtFinalTraceRead && sql.includes("from recall_traces trace")
            && sql.includes("where trace.id=$1")) clock = 5_001;
        return row;
      },
      transaction: (work) => database.transaction((transaction) => work(observed(transaction))),
    });
    const main = await authorizeRecall(observed(db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    const first = await recallAuthorized(main, authorizedRequest({
      query: "sources-500 AAPL", maxMemories: 1, tokenBudget: 8_000,
    }));
    expect(first.memories.map(({ id }) => id)).toContain(memoryId);
    expect.soft(calls.filter((sql) => sql.includes("insert into recall_trace_candidates")).length)
      .toBe(1);
    expect.soft(calls.filter((sql) => sql.includes("insert into recall_trace_sources")).length)
      .toBe(1);
    expect.soft(calls.filter((sql) => sql.includes("insert into recall_trace_plan_steps")).length)
      .toBe(1);
    expect.soft(calls.filter((sql) => sql.includes("insert into recall_trace_context_entries")).length)
      .toBeLessThanOrEqual(1);
    expect.soft(calls.length).toBeLessThanOrEqual(80);

    const tracesBefore = await db.one<{ count: number }>(
      "select count(*)::int count from recall_traces",
    );
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    advanceAtFinalTraceRead = true;
    try {
      await expect(recallAuthorized(main, authorizedRequest({
        query: "sources-500 AAPL", maxMemories: 1, tokenBudget: 8_000,
      }))).rejects.toThrow("RECALL_TIME_LIMIT");
    } finally {
      now.mockRestore();
    }
    expect(await db.one<{ count: number }>(
      "select count(*)::int count from recall_traces",
    )).toEqual(tracesBefore);
  }, 60_000);

  it("lazily and resumably indexes historical PUBLIC and protected embeddings", async () => {
    const fixture = await createConversationFixture("Historical vector upgrade");
    const publicTarget = await seedRecallBatch(fixture, "PUBLIC", "historical-public", [{
      text: "Historical public nearest vector target.", keyword: "historical-public",
      importance: 0.01, embedding: [1, 0],
    }]);
    const sharedTarget = await seedRecallBatch(fixture, "MAIN_SHARED", "historical-shared", [{
      text: "Historical protected shared nearest vector target.", keyword: "historical-shared",
      importance: 0.01, embedding: [1, 0],
    }]);
    const distractors = Array.from({ length: 25 }, (_, index) => ({
      text: `Historical vector distractor ${index}.`, keyword: `upgrade-distractor-${index}`,
      importance: 0.99, embedding: [0, 1] as readonly number[],
    }));
    await seedRecallBatch(fixture, "PUBLIC", "historical-public-distractors", distractors);
    await seedRecallBatch(fixture, "MAIN_SHARED", "historical-shared-distractors", distractors);
    const targetIds = [publicTarget.memories[0].id, sharedTarget.memories[0].id];
    await fixture.db.query(
      "delete from memory_vector_buckets where memory_id=any($1::uuid[])", [targetIds],
    );
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int count from memory_vector_buckets where memory_id=any($1::uuid[])",
      [targetIds],
    )).toEqual({ count: 0 });
    await fixture.db.query(
      `insert into recall_actor_authorities (role,actor_id,scopes)
       values ('SYSTEM','historical-vector-upgrade',array['PUBLIC']::text[])`,
    );
    const publicMaintenance = await authorizeRecall(fixture.db, {
      role: "SYSTEM", actorId: "historical-vector-upgrade",
      purpose: "HISTORICAL_VECTOR_UPGRADE", scopes: ["PUBLIC"],
    });
    const publicResult = await recallAuthorized(publicMaintenance, authorizedRequest({
      query: "term-that-does-not-exist", entities: [], queryVector: [1, 0],
      maxMemories: 4, tokenBudget: 4_000,
    }));
    expect(publicResult.memories.map(({ id }) => id)).toContain(publicTarget.memories[0].id);
    const main = await authorizeRecall(fixture.db, {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    const protectedResult = await recallAuthorized(main, authorizedRequest({
      query: "term-that-does-not-exist", entities: [], queryVector: [1, 0],
      maxMemories: 4, tokenBudget: 4_000,
    }));
    expect(protectedResult.memories.map(({ id }) => id)).toContain(sharedTarget.memories[0].id);
    const buckets = await fixture.db.query<{
      memory_id: string; scope: string; search_key_id: string | null; bucket_digest: string;
    }>(
      `select memory_id::text,scope,search_key_id::text,bucket_digest
       from memory_vector_buckets where memory_id=any($1::uuid[]) order by memory_id,ordinal`,
      [targetIds],
    );
    expect(buckets).toHaveLength(12);
    expect(buckets.filter(({ memory_id }) => memory_id === sharedTarget.memories[0].id)
      .every(({ search_key_id }) => search_key_id !== null)).toBe(true);
    expect(buckets.every(({ bucket_digest }) => /^[a-f0-9]{64}$/u.test(bucket_digest))).toBe(true);
  }, 45_000);

  it("does not backfill or decrypt a protected body whose sibling source key is erased", async () => {
    const db = await openTestDb();
    const aggregateId = `historical-erased-sibling:${randomUUID()}`;
    const firstText = "Historical live sibling KITE73 carries AAPL vector evidence.";
    const secondText = "Historical erased sibling OTTER19 contradicts that evidence.";
    const first = await appendEvent(db, {
      aggregateId, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "SHARED", body: { text: firstText },
      idempotencyKey: `historical-live-source:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    const second = await appendEvent(db, {
      aggregateId, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "SHARED", body: { text: secondText },
      idempotencyKey: `historical-erased-source:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    const run = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", events: [
        { id: first.id, at: first.occurredAt.toISOString(), text: firstText },
        { id: second.id, at: second.occurredAt.toISOString(), text: secondText },
      ], extracted: { facts: [
        { text: firstText, sourceIds: [first.id], keywords: ["kite73"],
          entities: [], embedding: [1, 0] },
        { text: secondText, sourceIds: [second.id], keywords: ["otter19"],
          entities: [], embedding: [0, 1] },
      ] }, versions: VERSIONS, observedAt: NOW, sourceEventId: second.id,
      idempotencyKey: `historical-erased-body:${randomUUID()}`,
    });
    const memoryIds = run.memories.map(({ id }) => id);
    const bodyEventId = await db.one<{ body_event_id: string }>(
      "select body_event_id::text from memory_records where id=$1", [memoryIds[0]],
    );
    await db.query("delete from memory_vector_buckets where memory_id=any($1::uuid[])", [memoryIds]);
    await db.query("update encrypted_event_bodies set data_key_id=null where event_id=$1", [second.id]);
    const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
    const observed = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => { calls.push({ sql, parameters }); return database.query<Row>(sql, parameters); },
      one: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row> => { calls.push({ sql, parameters }); return database.one<Row>(sql, parameters); },
      transaction: (work) => database.transaction((transaction) => work(observed(transaction))),
    });
    const main = await authorizeRecall(observed(db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    await recallAuthorized(main, authorizedRequest({
      query: "KITE73", entities: [], queryVector: [1, 0], tokenBudget: 2_000,
    }));
    expect(calls.some(({ sql, parameters }) => sql.includes(
      "select event_id::text,aggregate_id,data_key_id,ciphertext",
    ) && (parameters?.[0] as readonly unknown[] | undefined)?.includes(
      bodyEventId.body_event_id,
    ))).toBe(false);
    expect(await db.one<{ count: number }>(
      "select count(*)::int count from memory_vector_buckets where memory_id=any($1::uuid[])",
      [memoryIds],
    )).toEqual({ count: 0 });
  }, 20_000);

  it("serializes sibling source erasure immediately after historical availability", async () => {
    const db = await openTestDb();
    const aggregateId = `historical-source-race:${randomUUID()}`;
    const firstText = "Historical source race live sibling SWIFT82 carries AAPL evidence.";
    const secondText = "Historical source race erased sibling BADGER46 challenges it.";
    const first = await appendEvent(db, {
      aggregateId, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "SHARED", body: { text: firstText },
      idempotencyKey: `historical-race-live:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    const second = await appendEvent(db, {
      aggregateId, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "SHARED", body: { text: secondText },
      idempotencyKey: `historical-race-erased:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    const run = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", events: [
        { id: first.id, at: first.occurredAt.toISOString(), text: firstText },
        { id: second.id, at: second.occurredAt.toISOString(), text: secondText },
      ], extracted: { facts: [
        { text: firstText, sourceIds: [first.id], keywords: ["swift82"],
          entities: [], embedding: [1, 0] },
        { text: secondText, sourceIds: [second.id], keywords: ["badger46"],
          entities: [], embedding: [0, 1] },
      ] }, versions: VERSIONS, observedAt: NOW, sourceEventId: second.id,
      idempotencyKey: `historical-source-race:${randomUUID()}`,
    });
    const memoryIds = run.memories.map(({ id }) => id);
    const consolidation = await db.one<{ body_event_id: string }>(
      "select body_event_id::text from memory_records where id=$1", [memoryIds[0]],
    );
    await db.query("delete from memory_vector_buckets where memory_id=any($1::uuid[])", [memoryIds]);
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const availabilityReached = new Promise<void>((resolve) => { reached = resolve; });
    let gateUsed = false;
    const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
    const gated = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        calls.push({ sql, parameters });
        const rows = await database.query<Row>(sql, parameters);
        if (!gateUsed && sql.includes("recall-source-body-requirements")) {
          gateUsed = true;
          reached();
          await held;
        }
        return rows;
      },
      one: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row> => { calls.push({ sql, parameters }); return database.one<Row>(sql, parameters); },
      transaction: (work) => database.transaction((transaction) => work(gated(transaction))),
    });
    const main = await authorizeRecall(gated(db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    let recallCommitted = false;
    const recall = recallAuthorized(main, authorizedRequest({
      query: "SWIFT82", entities: [], queryVector: [1, 0], tokenBudget: 2_000,
    })).then((result) => { recallCommitted = true; return result; });
    await availabilityReached;
    let erasureCommitted = false;
    let erasureObservedRecallCommit = false;
    const erasure = db.query(
      "update encrypted_event_bodies set data_key_id=null where event_id=$1", [second.id],
    ).then(() => {
      erasureObservedRecallCommit = recallCommitted;
      erasureCommitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const erasureWon = erasureCommitted;
    release();
    const result = await recall;
    await erasure;
    if (erasureWon) {
      expect(result.memories).toHaveLength(0);
      expect(calls.some(({ sql, parameters }) => sql.includes(
        "select event_id::text,aggregate_id,data_key_id,ciphertext",
      ) && (parameters?.[0] as readonly unknown[] | undefined)?.includes(
        consolidation.body_event_id,
      ))).toBe(false);
      expect(calls.some(({ sql }) => sql.includes("insert into memory_vector_buckets"))).toBe(false);
      expect(await db.one<{ count: number }>(
        "select count(*)::int count from memory_vector_buckets where memory_id=any($1::uuid[])",
        [memoryIds],
      )).toEqual({ count: 0 });
    } else {
      expect(erasureObservedRecallCommit).toBe(true);
      expect(result.memories.map(({ id }) => id)).toContain(memoryIds[0]);
      expect(calls.some(({ sql }) => sql.includes("insert into memory_vector_buckets"))).toBe(true);
    }
    const keyLock = calls.find(({ sql }) => sql.includes("recall-source-key-lock"));
    const keyIds = keyLock?.parameters?.[0] as readonly string[] | undefined;
    expect(keyIds).toEqual([...(keyIds ?? [])].sort());
    const bodyLock = calls.find(({ sql }) => sql.includes("recall-source-body-lock"));
    const bodyIds = bodyLock?.parameters?.[0] as readonly string[] | undefined;
    expect(bodyIds).toEqual([...(bodyIds ?? [])].sort());
  }, 30_000);

  it("makes sibling source erasure wait behind the stable normal-recall body lock", async () => {
    const db = await openTestDb();
    const aggregateId = `normal-source-race:${randomUUID()}`;
    const firstText = "Normal source race live sibling IBIS17 carries AAPL evidence.";
    const secondText = "Normal source race protected sibling WOMBAT63 challenges it.";
    const first = await appendEvent(db, {
      aggregateId, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "SHARED", body: { text: firstText },
      idempotencyKey: `normal-race-live:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    const second = await appendEvent(db, {
      aggregateId, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.state.fixture-recorded", visibility: "SHARED", body: { text: secondText },
      idempotencyKey: `normal-race-protected:${randomUUID()}`, occurredAt: new Date(NOW),
      policyVersion: "recall-fixture-v1",
    });
    const run = await processMemoryEvent(createMemoryWorkerContext(db), {
      scope: "MAIN_SHARED", events: [
        { id: first.id, at: first.occurredAt.toISOString(), text: firstText },
        { id: second.id, at: second.occurredAt.toISOString(), text: secondText },
      ], extracted: { facts: [
        { text: firstText, sourceIds: [first.id], keywords: ["ibis17"],
          entities: [], embedding: [1, 0] },
        { text: secondText, sourceIds: [second.id], keywords: ["wombat63"],
          entities: [], embedding: [0, 1] },
      ] }, versions: VERSIONS, observedAt: NOW, sourceEventId: second.id,
      idempotencyKey: `normal-source-race:${randomUUID()}`,
    });
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockReached = new Promise<void>((resolve) => { reached = resolve; });
    let gateUsed = false;
    const calls: string[] = [];
    const gated = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        calls.push(sql);
        const rows = await database.query<Row>(sql, parameters);
        if (!gateUsed && sql.includes("recall-source-body-lock")) {
          gateUsed = true;
          reached();
          await held;
        }
        return rows;
      },
      one: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row> => { calls.push(sql); return database.one<Row>(sql, parameters); },
      transaction: (work) => database.transaction((transaction) => work(gated(transaction))),
    });
    const main = await authorizeRecall(gated(db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    let recallCommitted = false;
    const recall = recallAuthorized(main, authorizedRequest({
      query: "IBIS17", entities: [], tokenBudget: 2_000,
      embeddingVersion: undefined, queryVector: undefined,
    })).then((result) => { recallCommitted = true; return result; });
    await lockReached;
    let erasureCommitted = false;
    let erasureObservedRecallCommit = false;
    const erasure = db.query(
      "update encrypted_event_bodies set data_key_id=null where event_id=$1", [second.id],
    ).then(() => {
      erasureObservedRecallCommit = recallCommitted;
      erasureCommitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(erasureCommitted).toBe(false);
    release();
    const result = await recall;
    await erasure;
    expect(erasureObservedRecallCommit).toBe(true);
    expect(result.memories.map(({ id }) => id)).toContain(run.memories[0].id);
    const requirementsIndex = calls.findIndex((sql) => sql.includes("recall-source-body-requirements"));
    const keyLockIndex = calls.findIndex((sql) => sql.includes("recall-source-key-lock"));
    const bodyLockIndex = calls.findIndex((sql) => sql.includes("recall-source-body-lock"));
    const ciphertextIndex = calls.findIndex((sql) => sql.includes(
      "select event_id::text,aggregate_id,data_key_id,ciphertext",
    ));
    expect(requirementsIndex).toBeGreaterThan(-1);
    expect(keyLockIndex).toBeGreaterThan(requirementsIndex);
    expect(bodyLockIndex).toBeGreaterThan(keyLockIndex);
    expect(ciphertextIndex).toBeGreaterThan(bodyLockIndex);
    expect(calls.filter((sql) => sql.includes("recall-source-body-requirements"))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes("recall-source-key-lock"))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes("recall-source-body-lock"))).toHaveLength(1);
  }, 30_000);

  it("fails context-only recall before ciphertext when Main-state erasure wins", async () => {
    const db = await openTestDb();
    const broadcast = await commitBroadcast({ db }, {
      mainStateVersion: 71,
      body: "Context-only race Main state must remain locked through recall.",
      sourceIds: ["context-only-race-source"],
      idempotencyKey: `context-only-race:${randomUUID()}`,
    });
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const availabilityReached = new Promise<void>((resolve) => { reached = resolve; });
    let gateUsed = false;
    const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
    const gated = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        calls.push({ sql, parameters });
        const rows = await database.query<Row>(sql, parameters);
        if (!gateUsed && (sql.includes("recall-source-body-requirements")
          || (sql.includes("select id,aggregate_id,root_key_version")
            && sql.includes("order by id for key share")))) {
          gateUsed = true;
          reached();
          await held;
        }
        return rows;
      },
      one: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row> => { calls.push({ sql, parameters }); return database.one<Row>(sql, parameters); },
      transaction: (work) => database.transaction((transaction) => work(gated(transaction))),
    });
    const main = await authorizeRecall(gated(db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    const recall = recallAuthorized(main, authorizedRequest({
      query: "no matching memory", entities: [], tokenBudget: 2_000,
      embeddingVersion: undefined, queryVector: undefined,
    }));
    await availabilityReached;
    let erasureCommitted = false;
    const erasure = db.query(
      "update encrypted_event_bodies set data_key_id=null where event_id=$1",
      [broadcast.commitEventId],
    ).then(() => { erasureCommitted = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(erasureCommitted).toBe(true);
    release();
    await expect(recall).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
    await erasure;
    expect(calls.some(({ sql, parameters }) => sql.includes(
      "select event_id::text,aggregate_id,data_key_id,ciphertext",
    ) && (parameters?.[0] as readonly unknown[] | undefined)?.includes(
      broadcast.commitEventId,
    ))).toBe(false);
    expect(await db.one<{ count: number }>(
      "select count(*)::int count from recall_trace_context_entries",
    )).toEqual({ count: 0 });
  }, 30_000);

  it("makes Main-state erasure wait behind a context-only recall body lock", async () => {
    const db = await openTestDb();
    const broadcast = await commitBroadcast({ db }, {
      mainStateVersion: 72,
      body: "Context-only locked Main state remains available until recall commits.",
      sourceIds: ["context-only-lock-source"],
      idempotencyKey: `context-only-lock:${randomUUID()}`,
    });
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockReached = new Promise<void>((resolve) => { reached = resolve; });
    let gateUsed = false;
    const calls: string[] = [];
    const gated = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        calls.push(sql);
        const rows = await database.query<Row>(sql, parameters);
        if (!gateUsed && (sql.includes("recall-source-body-lock")
          || (sql.includes("select id,aggregate_id,root_key_version")
            && sql.includes("order by id for key share")))) {
          gateUsed = true;
          reached();
          await held;
        }
        return rows;
      },
      one: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row> => { calls.push(sql); return database.one<Row>(sql, parameters); },
      transaction: (work) => database.transaction((transaction) => work(gated(transaction))),
    });
    const main = await authorizeRecall(gated(db), {
      role: "MAIN_BRAIN", actorId: "gustavo-main",
    });
    calls.length = 0;
    let recallCommitted = false;
    const recall = recallAuthorized(main, authorizedRequest({
      query: "no matching memory", entities: [], tokenBudget: 2_000,
      embeddingVersion: undefined, queryVector: undefined,
    })).then((result) => { recallCommitted = true; return result; });
    await lockReached;
    let erasureCommitted = false;
    let erasureObservedRecallCommit = false;
    const erasure = db.query(
      "update encrypted_event_bodies set data_key_id=null where event_id=$1",
      [broadcast.commitEventId],
    ).then(() => {
      erasureObservedRecallCommit = recallCommitted;
      erasureCommitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const erasureWaited = !erasureCommitted;
    release();
    const result = await recall.catch(() => null);
    await erasure;
    expect(erasureWaited).toBe(true);
    expect(erasureObservedRecallCommit).toBe(true);
    expect(result?.memories).toHaveLength(0);
    expect(result?.contextPack.entries.some(({ kind, sourceEventIds }) => (
      kind === "MAIN_STATE" && sourceEventIds.includes(broadcast.commitEventId)
    ))).toBe(true);
    expect(calls.filter((sql) => sql.includes("recall-source-body-lock"))).toHaveLength(1);
  }, 30_000);

  it("uses indexed checkpointed 100-row traversal for historical vector maintenance", async () => {
    const fixture = await createConversationFixture("Historical vector cursor scale");
    const memories: string[] = [];
    for (const batch of [0, 1]) {
      const result = await seedRecallBatch(fixture, "PUBLIC", `cursor-scale-${batch}`,
        Array.from({ length: 75 }, (_, index) => ({
          text: `Historical cursor row ${batch * 75 + index}.`,
          keyword: `cursor-${batch * 75 + index}`, importance: 0.5,
          embedding: [1, 0] as readonly number[],
        })));
      memories.push(...result.memories.map(({ id }) => id));
    }
    const ordered = (await fixture.db.query<{ id: string }>(
      "select id::text from memory_records where id=any($1::uuid[]) order by id", [memories],
    )).map(({ id }) => id);
    const early = ordered[20];
    const late = ordered[120];
    await fixture.db.query(
      "delete from memory_vector_buckets where memory_id=any($1::uuid[])", [[early, late]],
    );
    await fixture.db.query(
      `insert into recall_actor_authorities (role,actor_id,scopes)
       values ('SYSTEM','historical-vector-cursor',array['PUBLIC']::text[])`,
    );
    const calls: string[] = [];
    const observed = (database: EventDatabase): EventDatabase => ({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row[]> => { calls.push(sql); return database.query<Row>(sql, parameters); },
      one: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, parameters?: readonly unknown[],
      ): Promise<Row> => { calls.push(sql); return database.one<Row>(sql, parameters); },
      transaction: (work) => database.transaction((transaction) => work(observed(transaction))),
    });
    const system = await authorizeRecall(observed(fixture.db), {
      role: "SYSTEM", actorId: "historical-vector-cursor",
      purpose: "HISTORICAL_VECTOR_UPGRADE", scopes: ["PUBLIC"],
    });
    calls.length = 0;
    await recallAuthorized(system, authorizedRequest({
      query: "cursor pass one", entities: [], queryVector: [1, 0], maxMemories: 1,
      graphDepth: 1,
    }));
    const firstMaintenanceCount = calls.filter((sql) => sql.includes("memory-vector-backfill")).length;
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int count from memory_vector_buckets where memory_id=$1", [early],
    )).toEqual({ count: 6 });
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int count from memory_vector_buckets where memory_id=$1", [late],
    )).toEqual({ count: 0 });
    const firstCheckpoint = await fixture.db.one<{ last_memory_id: string; completed: boolean }>(
      `select last_memory_id::text,completed from memory_vector_backfill_checkpoints
       where scope='PUBLIC' and embedding_version=$1`, [VERSIONS.embeddingVersion],
    );
    calls.length = 0;
    await recallAuthorized(system, authorizedRequest({
      query: "cursor pass two", entities: [], queryVector: [1, 0], maxMemories: 1,
      graphDepth: 1,
    }));
    const secondMaintenanceCount = calls.filter((sql) => sql.includes("memory-vector-backfill")).length;
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int count from memory_vector_buckets where memory_id=$1", [late],
    )).toEqual({ count: 6 });
    const secondCheckpoint = await fixture.db.one<{ last_memory_id: string; completed: boolean }>(
      `select last_memory_id::text,completed from memory_vector_backfill_checkpoints
       where scope='PUBLIC' and embedding_version=$1`, [VERSIONS.embeddingVersion],
    );
    expect(secondCheckpoint.completed).toBe(true);
    expect(secondCheckpoint.last_memory_id.localeCompare(firstCheckpoint.last_memory_id)).toBeGreaterThan(0);
    expect(firstMaintenanceCount).toBeLessThanOrEqual(8);
    expect(secondMaintenanceCount).toBeLessThanOrEqual(8);
    expect(Math.abs(firstMaintenanceCount - secondMaintenanceCount)).toBeLessThanOrEqual(1);
    expect(calls.some((sql) => sql.includes("memory-vector-backfill-scan")
      && sql.includes("memory.id>") && sql.includes("limit 100"))).toBe(true);
    const indexes = await fixture.db.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname=current_schema()
       and indexname in ('recall_memory_body_siblings_idx','memory_vector_backfill_scan_idx')
       order by indexname`,
    );
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      "memory_vector_backfill_scan_idx", "recall_memory_body_siblings_idx",
    ]);
    const explained = await fixture.db.transaction(async (transaction) => {
      await transaction.query("set local enable_seqscan=off");
      return transaction.one<Record<string, unknown>>(
        `explain (format json) select memory.id from memory_records memory
         where memory.scope='PUBLIC' and memory.account_id is null
           and memory.node_brain_id is null and memory.conversation_id is null
           and memory.embedding_version=$1 and memory.has_embedding and memory.id>$2
         order by memory.id limit 100`,
        [VERSIONS.embeddingVersion, firstCheckpoint.last_memory_id],
      );
    });
    expect(JSON.stringify(explained)).toContain("memory_vector_backfill_scan_idx");
  }, 45_000);
});
