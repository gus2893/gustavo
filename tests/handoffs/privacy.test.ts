import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMessage } from "../../lib/server/history/messages";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import { canonicalContentDigest, canonicalJson } from "../../lib/server/events/integrity";
import type { EventDatabase, JsonValue } from "../../lib/server/events/types";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import {
  createDisclosureAuthorization,
  createProposal,
  getProposal,
  transitionProposal,
} from "../../lib/server/orchestration/proposals";
import {
  HANDOFF_POLICY_VERSION,
  buildHandoff,
  loadHandoff,
} from "../../lib/server/handoffs/build";
import {
  createMemoryWorkerContext,
  processMemoryEvent,
} from "../../worker/consolidation/process-event";
import {
  claimHandoffRefreshJob,
  enqueueHandoffRefresh,
  processHandoffRefreshJob,
  refreshHandoff,
  refreshHandoffIncrementally,
  retryHandoffRefreshJob,
} from "../../worker/handoffs/refresh";
import { createConversationFixture, type TestDatabase } from "../helpers/postgres";

const VERSIONS = Object.freeze({
  promptVersion: "handoff-memory-prompt-v1",
  modelVersion: "handoff-memory-model-v1",
  extractorVersion: "handoff-memory-extractor-v1",
  embeddingVersion: "handoff-memory-embedding-v1",
});

let nextMainStateVersion = 900_000;

beforeEach(() => {
  process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  delete process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY;
});

async function proposalFixture(
  label: string,
  options: { readonly raw?: boolean } = {},
  database?: TestDatabase,
) {
  const fixture = await createConversationFixture(`Handoff ${label}`, database);
  const sourceText = `Private ${label} source: completed close rejected resistance. Secret ${label} must stay private.`;
  const unrelatedText = `Unrelated private detail ${label} must never enter the packet.`;
  const source = await appendMessage(fixture, {
    role: "USER",
    text: sourceText,
    idempotencyKey: `handoff:${label}:source`,
  });
  const unrelated = await appendMessage(fixture, {
    role: "USER",
    text: unrelatedText,
    idempotencyKey: `handoff:${label}:unrelated`,
  });
  const memories = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
    scope: "NODE_BRANCH",
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventId: unrelated.eventId,
    events: [
      { id: source.eventId, at: source.occurredAt, text: sourceText },
      { id: unrelated.eventId, at: unrelated.occurredAt, text: unrelatedText },
    ],
    extracted: { facts: [
      {
        text: "Completed close rejected resistance",
        sourceIds: [source.eventId],
        keywords: ["rejection"],
        entities: ["AAPL"],
      },
      {
        text: `Unrelated private detail ${label}`,
        sourceIds: [unrelated.eventId],
        keywords: ["private"],
        entities: [],
      },
    ] },
    versions: VERSIONS,
    observedAt: new Date().toISOString(),
    idempotencyKey: `handoff:${label}:memory`,
  });
  const mainStateVersion = String(nextMainStateVersion++);
  await fixture.db.query(
    "insert into main_state_versions(version,author_type,author_id,status) values ($1,'MAIN_BRAIN','gustavo-main','COMMITTED')",
    [mainStateVersion],
  );
  const route = await routeNodeReply({
    db: fixture.db,
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    userMessageEventId: source.eventId,
    coveredByMain: false,
    contradiction: true,
    materialEvidence: true,
    confidence: 0.95,
    mainStateVersion,
    sourceIds: [source.eventId],
  }, async () => undefined);
  const disclosure = options.raw ? await createDisclosureAuthorization({ db: fixture.db }, {
    accountId: fixture.accountId,
    conversationId: fixture.conversationId,
    sourceEventIds: [source.eventId],
    disclosedText: sourceText,
    privacyScope: "PROPOSAL_RAW_TEXT",
    purpose: "MAIN_PROPOSAL_REVIEW",
    expiresAt: new Date(Date.now() + 300_000),
    idempotencyKey: `handoff:${label}:disclosure`,
  }) : null;
  const proposal = await createProposal({ db: fixture.db }, {
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventIds: [source.eventId],
    routeEventId: route.routingEventId,
    affectedMainStateIds: [mainStateVersion],
    privacyScope: options.raw ? "PROPOSAL_RAW_TEXT" : "PROPOSAL_SUMMARY",
    proposedChange: options.raw ? sourceText : "Treat the completed close as a resistance rejection.",
    evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
    counterevidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
    uncertainty: options.raw ? sourceText : "Ask whether the next completed bar confirms the rejection.",
    ...(options.raw ? {
      disclosureAuthorizationId: disclosure!.id,
      rawPrivateText: sourceText,
    } : {}),
    idempotencyKey: `handoff:${label}:proposal`,
  });
  const routed = await fixture.db.one<{ ingested_sequence: string }>(
    "select ingested_sequence::text from events where id=$1",
    [route.routingEventId],
  );
  const rawPrivateTextEvent = await fixture.db.query<{ raw_private_text_event_id: string }>(
    "select raw_private_text_event_id::text from proposals where id=$1",
    [proposal.id],
  );
  return Object.freeze({
    ...fixture,
    source,
    unrelated,
    transmittedMemory: memories.memories[0]!,
    unrelatedMemory: memories.memories[1]!,
    sourceText,
    mainStateVersion,
    nodeStateVersion: routed.ingested_sequence,
    routeEventId: route.routingEventId,
    disclosure,
    rawPrivateTextEventId: rawPrivateTextEvent[0]?.raw_private_text_event_id ?? null,
    proposal,
  });
}

async function createFollowupProposal(
  fixture: Awaited<ReturnType<typeof proposalFixture>>,
  label: string,
) {
  const sourceText = `Follow-up ${label}: completed close rejected resistance.`;
  const source = await appendMessage(fixture, {
    role: "USER",
    text: sourceText,
    idempotencyKey: `handoff:${label}:followup-source`,
  });
  const route = await routeNodeReply({
    db: fixture.db,
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    userMessageEventId: source.eventId,
    coveredByMain: false,
    contradiction: true,
    materialEvidence: true,
    confidence: 0.94,
    mainStateVersion: fixture.mainStateVersion,
    sourceIds: [fixture.source.eventId, source.eventId],
  }, async () => undefined);
  const proposal = await createProposal({ db: fixture.db }, {
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventIds: [fixture.source.eventId, source.eventId],
    routeEventId: route.routingEventId,
    affectedMainStateIds: [fixture.mainStateVersion],
    privacyScope: "PROPOSAL_SUMMARY",
    proposedChange: "Treat the completed close as a resistance rejection.",
    evidence: [
      { kind: "SOURCE_EVENT", referenceId: fixture.source.eventId },
      { kind: "SOURCE_EVENT", referenceId: source.eventId },
    ],
    counterevidence: [],
    uncertainty: "Ask whether the next completed bar confirms the rejection.",
    idempotencyKey: `handoff:${label}:followup`,
  });
  return Object.freeze({ proposal, source, memory: fixture.transmittedMemory });
}

function rejectProtectedReads(database: EventDatabase): EventDatabase {
  const protectedRead = (sql: string) => /\b(ciphertext|wrapped_key|body_iv|body_auth_tag)\b/i
    .test(sql.replace(/\/\*[\s\S]*?\*\//g, ""));
  const wrap = (db: EventDatabase): EventDatabase => ({
    query: async (sql, parameters) => {
      if (protectedRead(sql)) {
        throw new Error("HANDOFF_CIPHERTEXT_READ_BEFORE_AUTHORIZATION");
      }
      return db.query(sql, parameters);
    },
    one: async (sql, parameters) => {
      if (protectedRead(sql)) {
        throw new Error("HANDOFF_CIPHERTEXT_READ_BEFORE_AUTHORIZATION");
      }
      return db.one(sql, parameters);
    },
    transaction: (work) => db.transaction((transaction) => work(wrap(transaction))),
  });
  return wrap(database);
}

type DirectJobAction = "CLAIM" | "RETRY" | "COMPLETE" | "FAIL";

async function appendCanonicalDirectJobTransition(
  database: EventDatabase,
  input: {
    readonly jobId: string;
    readonly action: DirectJobAction;
    readonly workerId: string;
    readonly createdAt: Date;
    readonly leaseUntil?: Date;
    readonly retryAt?: Date;
    readonly packetId?: string;
    readonly errorCode?: string;
    readonly capture?: { eventId?: string };
  },
): Promise<void> {
  await database.transaction(async (transaction) => {
    const current = await transaction.one<{
      ordinal: number;
      status: "PENDING" | "CLAIMED" | "RETRY_SCHEDULED";
      transition_event_id: string;
      account_id: string;
      policy_version: string;
    }>(
      `select current.ordinal,current.status,transition.transition_event_id::text,
              current.account_id::text,current.policy_version
         from handoff_refresh_job_current current
         join handoff_refresh_job_transitions transition on transition.id=current.transition_id
        where current.id=$1`,
      [input.jobId],
    );
    const toStatus = input.action === "CLAIM" ? "CLAIMED"
      : input.action === "RETRY" ? "RETRY_SCHEDULED"
        : input.action === "COMPLETE" ? "COMPLETED" : "FAILED";
    const transitionId = randomUUID();
    const draft = {
      jobId: input.jobId,
      ordinal: current.ordinal + 1,
      action: input.action,
      fromStatus: current.status,
      toStatus,
      workerId: input.workerId,
      leaseUntil: input.leaseUntil?.toISOString() ?? null,
      retryAt: input.retryAt?.toISOString() ?? null,
      packetId: input.packetId ?? null,
      checkpointId: null,
      errorCode: input.errorCode ?? null,
    } as const;
    const operationDigest = canonicalContentDigest(draft);
    const body = {
      transitionId,
      ...draft,
      operationDigest,
      createdAt: input.createdAt.toISOString(),
    } as const;
    const event = await appendEvent(transaction, {
      aggregateId: `node-handoff-job:${input.jobId}`,
      accountId: current.account_id,
      actor: { type: "SYSTEM", id: "handoff-refresher" },
      type: input.action === "CLAIM" ? "node.handoff.refresh.claimed"
        : input.action === "RETRY" ? "node.handoff.refresh.retry_scheduled"
          : input.action === "COMPLETE" ? "node.handoff.refresh.completed"
            : "node.handoff.refresh.failed",
      visibility: "PRIVATE_ACCOUNT",
      body,
      idempotencyKey: `node-handoff-transition:${operationDigest}`,
      causationId: current.transition_event_id,
      correlationId: input.jobId,
      occurredAt: input.createdAt,
      policyVersion: current.policy_version,
    });
    if (input.capture) input.capture.eventId = event.id;
    const bodyDigest = canonicalContentDigest(body);
    await transaction.query(
      `insert into handoff_refresh_job_transitions (
         id,job_id,ordinal,action,from_status,to_status,worker_id,lease_until,retry_at,
         packet_id,error_code,transition_event_id,idempotency_key,operation_digest,
         body_digest,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [transitionId, input.jobId, draft.ordinal, input.action, current.status, toStatus,
        input.workerId, draft.leaseUntil, draft.retryAt, draft.packetId, draft.errorCode,
        event.id, `handoff-transition:${operationDigest}`, operationDigest, bodyDigest,
        event.occurredAt],
    );
    await transaction.query(
      `insert into handoff_refresh_job_transition_manifests (
         transition_id,job_id,transition_event_id,operation_digest,body_digest,
         event_request_hash,event_integrity_hash,created_at
       ) select $1,$2,event.id,$3,$4,event.request_hash,event.integrity_hash,$5
           from events event where event.id=$6`,
      [transitionId, input.jobId, operationDigest, bodyDigest, event.occurredAt, event.id],
    );
  });
}

describe("Node-to-Main handoff", { timeout: 20_000 }, () => {
  it("includes authorized proposal facts and excludes unrelated raw chat", () => {
    const packet = buildHandoff({
      nodeBrainId: "node-1",
      highWaterMark: "e9",
      memories: [
        {
          id: "m1",
          scope: "NODE_BRANCH",
          transmitted: true,
          kind: "EVIDENCE",
          text: "Completed close rejected resistance",
          sourceIds: ["e8"],
        },
        {
          id: "m2",
          scope: "PRIVATE_ACCOUNT",
          transmitted: false,
          kind: "MESSAGE",
          text: "unrelated private detail",
          sourceIds: ["e7"],
        },
      ],
    });

    expect(packet.items.map((item) => item.id)).toEqual(["m1"]);
    expect(JSON.stringify(packet)).not.toContain("unrelated private detail");
    expect(packet.highWaterMark).toBe("e9");
  });

  it("persists a source-grounded encrypted packet and revalidates its exact identity", async () => {
    const fixture = await proposalFixture("durable");
    const refreshed = await refreshHandoffIncrementally({ db: fixture.db }, {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:refresh:${fixture.accountId}`,
    });
    expect(refreshed.status).toBe("COMPLETED");
    if (refreshed.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");

    const packet = await loadHandoff({ db: fixture.db }, {
      packetId: refreshed.packet.id,
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
    });
    const serialized = JSON.stringify(packet);
    expect(packet.items.map(({ kind }) => kind)).toEqual([
      "THESIS", "EVIDENCE", "COUNTEREVIDENCE", "OPEN_QUESTION", "RECENT_CHANGE",
    ]);
    expect(packet.items.every(({ sourceIds }) => sourceIds.includes(fixture.source.eventId))).toBe(true);
    expect(packet.items.every(({ memoryVersions }) => (
      memoryVersions.some(({ memoryId }) => memoryId === fixture.transmittedMemory.id)
    ))).toBe(true);
    expect(serialized).not.toContain(`Unrelated private detail durable`);
    expect(serialized).not.toContain(fixture.unrelatedMemory.id);
    await expect(loadHandoff({ db: fixture.db }, {
      packetId: refreshed.packet.id,
      accountId: fixture.accountId,
      nodeBrainId: randomUUID(),
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
    })).rejects.toThrow("HANDOFF_FORBIDDEN");
  });

  it("replays concurrently by operation while rejecting changed identity and revoked authority before ciphertext", async () => {
    const fixture = await proposalFixture("replay");
    const base = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
    };
    const [first, second, third] = await Promise.all([
      refreshHandoff({ db: fixture.db }, { ...base, idempotencyKey: `handoff:replay:a:${fixture.accountId}` }),
      refreshHandoff({ db: fixture.db }, { ...base, idempotencyKey: `handoff:replay:a:${fixture.accountId}` }),
      refreshHandoff({ db: fixture.db }, { ...base, idempotencyKey: `handoff:replay:b:${fixture.accountId}` }),
    ]);
    expect([first, second, third].every(({ status }) => status === "COMPLETED")).toBe(true);
    if (first.status !== "COMPLETED" || second.status !== "COMPLETED" || third.status !== "COMPLETED") {
      throw new Error("HANDOFF_TEST_REPLAY_INCOMPLETE");
    }
    expect(new Set([first.packet.id, second.packet.id, third.packet.id]).size).toBe(1);
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int count from handoff_packets where operation_key=(select operation_key from handoff_packets where id=$1)",
      [first.packet.id],
    )).toEqual({ count: 1 });
    expect(await fixture.db.one<{ count: number; exact: boolean }>(
      `select count(*)::int count,
              bool_and(key.operation_key=packet.operation_key
                and key.request_digest=packet.request_digest
                and key.source_high_water_sequence=packet.source_high_water_sequence
                and key.created_at=packet.created_at
                and key.key_digest=handoff_packet_key_digest(key.idempotency_key,packet.id)) exact
         from handoff_packet_keys key join handoff_packets packet on packet.id=key.packet_id
        where packet.id=$1`,
      [first.packet.id],
    )).toEqual({ count: 2, exact: true });
    await expect(loadHandoff({ db: rejectProtectedReads(fixture.db) }, {
      packetId: first.packet.id,
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: `${fixture.nodeStateVersion}0`,
      mainStateVersion: fixture.mainStateVersion,
    })).rejects.toThrow("HANDOFF_FORBIDDEN");
    await fixture.db.query("update entitlements set revoked_at=clock_timestamp() where account_id=$1", [fixture.accountId]);
    await expect(loadHandoff({ db: rejectProtectedReads(fixture.db) }, {
      packetId: first.packet.id,
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
    })).rejects.toThrow("HANDOFF_FORBIDDEN");
  });

  it("seals the normalized idea graph at manifest and rejects forged packet keys", async () => {
    const fixture = await proposalFixture("sealed");
    const refreshed = await refreshHandoff({ db: fixture.db }, {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:sealed:${fixture.accountId}`,
    });
    if (refreshed.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");
    const followup = await createFollowupProposal(fixture, "sealed");
    const followupProjection = await getProposal({ db: fixture.db }, {
      accountId: fixture.accountId,
      proposalId: followup.proposal.id,
    });
    await expect(fixture.db.query(
      `insert into handoff_packet_ideas (
         packet_id,ordinal,proposal_id,proposal_event_id,proposal_status_event_id,
         proposal_status_ordinal,disclosure_authorization_id,disclosure_revocation_event_id,
         source_event_ids,memory_ids,memory_versions,content_digest
       ) select idea.packet_id,idea.ordinal+1,$2,$3,$3,0,null,null,
                idea.source_event_ids,idea.memory_ids,idea.memory_versions,$4
         from handoff_packet_ideas idea where idea.packet_id=$1 and idea.ordinal=0`,
      [refreshed.packet.id, followup.proposal.id, followup.proposal.createdEventId,
        canonicalContentDigest({
          counterevidence: followupProjection.counterevidence,
          evidence: followupProjection.evidence,
          proposedChange: followupProjection.proposedChange,
          sourceEventIds: followupProjection.sourceEventIds,
          uncertainty: followupProjection.uncertainty,
        })],
    )).rejects.toThrow("HANDOFF_PACKET_IDEAS_SEALED");

    await expect(fixture.db.query(
      `insert into handoff_packet_keys (
         idempotency_key,packet_id,operation_key,request_digest,source_high_water_sequence,
         key_digest,created_at
       ) select $2,id,$3,$4,source_high_water_sequence,
                handoff_packet_key_digest($2,id),created_at
           from handoff_packets where id=$1`,
      [refreshed.packet.id, `handoff:forged-key:${fixture.accountId}`,
        "a".repeat(64), "b".repeat(64)],
    )).rejects.toThrow("HANDOFF_PACKET_KEY_INVALID");
  });

  it("rejects proposal and status authority that occurs beyond the packet high-water", async () => {
    const fixture = await proposalFixture("high-water");
    const through = await fixture.db.one<{ ingested_sequence: string }>(
      "select ingested_sequence::text from events where id=$1",
      [fixture.proposal.createdEventId],
    );
    await transitionProposal({ db: fixture.db }, {
      proposalId: fixture.proposal.id,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      toStatus: "UNDER_REVIEW",
      reason: "This status deliberately occurs beyond the forged packet boundary.",
      idempotencyKey: `handoff:high-water:transition:${fixture.accountId}`,
    });
    const status = await fixture.db.one<{ transition_event_id: string; ordinal: number }>(
      `select transition_event_id::text,ordinal from proposal_status_transitions
        where proposal_id=$1 order by ordinal desc limit 1`,
      [fixture.proposal.id],
    );
    const proposal = await getProposal({ db: fixture.db }, {
      accountId: fixture.accountId,
      proposalId: fixture.proposal.id,
    });
    const operationKey = canonicalContentDigest({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      highWaterSequence: through.ingested_sequence,
      nodeBrainId: fixture.nodeBrainId,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      policyVersion: HANDOFF_POLICY_VERSION,
      scope: "NODE_BRANCH",
    });
    const requestDigest = canonicalContentDigest({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      policyVersion: HANDOFF_POLICY_VERSION,
      scope: "NODE_BRANCH",
      throughEventId: fixture.proposal.createdEventId,
      highWaterSequence: through.ingested_sequence,
    });
    await expect(fixture.db.transaction(async (transaction) => {
      const packetId = randomUUID();
      const createdAt = new Date();
      const forgedBody = { forged: true } as const;
      const event = await appendEvent(transaction, {
        aggregateId: `node-handoff:${fixture.nodeBrainId}`,
        accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "handoff-refresher" },
        type: "node.handoff.packet.refreshed",
        visibility: "PRIVATE_ACCOUNT",
        body: forgedBody,
        policyVersion: HANDOFF_POLICY_VERSION,
        idempotencyKey: `node-handoff-packet:${operationKey}`,
        causationId: fixture.proposal.createdEventId,
        correlationId: packetId,
        occurredAt: createdAt,
      });
      await transaction.query(
        `insert into handoff_packets (
           id,account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
           main_state_version,
           packet_version,previous_packet_id,source_high_water_sequence,through_event_id,
           operation_key,idempotency_key,request_digest,packet_event_id,idea_count,source_count,
           body_digest,created_at
         ) values ($1,$2,$3,$4,'NODE_BRANCH',$5,$6,$7,1,null,$8,$9,$10,$11,$12,$13,1,1,$14,$15)`,
        [packetId, fixture.accountId, fixture.nodeBrainId, fixture.conversationId,
          HANDOFF_POLICY_VERSION, fixture.nodeStateVersion, fixture.mainStateVersion,
          through.ingested_sequence,
          fixture.proposal.createdEventId, operationKey, `handoff:raw:${packetId}`,
          requestDigest, event.id, canonicalContentDigest(forgedBody), event.occurredAt],
      );
      await transaction.query(
        `insert into handoff_packet_ideas (
           packet_id,ordinal,proposal_id,proposal_event_id,proposal_status_event_id,
           proposal_status_ordinal,disclosure_authorization_id,disclosure_revocation_event_id,
           source_event_ids,memory_ids,memory_versions,content_digest
         ) select $1,0,$2,$3,$4,$5,null,null,array[$6]::uuid[],array[memory.id],
                  array[memory.body_event_id::text||':'||memory.conflict_state],$7
             from memory_records memory where memory.id=$8`,
        [packetId, fixture.proposal.id, fixture.proposal.createdEventId,
          status.transition_event_id, status.ordinal, fixture.source.eventId,
          canonicalContentDigest({
            counterevidence: proposal.counterevidence,
            evidence: proposal.evidence,
            proposedChange: proposal.proposedChange,
            sourceEventIds: proposal.sourceEventIds,
            uncertainty: proposal.uncertainty,
          }), fixture.transmittedMemory.id],
      );
    })).rejects.toThrow("HANDOFF_PACKET_IDEA_HIGH_WATER_INVALID");
  });

  it("excludes real raw-text proposals until the private attachment reaches high-water", async () => {
    const fixture = await proposalFixture("raw-selection", { raw: true });
    if (!fixture.rawPrivateTextEventId) throw new Error("HANDOFF_TEST_RAW_EVENT_MISSING");
    const boundaries = await fixture.db.one<{ created: string; attached: string }>(
      `select created.ingested_sequence::text created,attached.ingested_sequence::text attached
         from events created cross join events attached where created.id=$1 and attached.id=$2`,
      [fixture.proposal.createdEventId, fixture.rawPrivateTextEventId],
    );
    expect(BigInt(boundaries.attached)).toBeGreaterThan(BigInt(boundaries.created));
    const base = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
    };
    const premature = await refreshHandoff({ db: fixture.db }, {
      ...base,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:raw-premature:${fixture.accountId}`,
    });
    expect(premature).toMatchObject({ status: "EMPTY", highWaterSequence: boundaries.created });
    if (premature.status !== "EMPTY") throw new Error("HANDOFF_TEST_EMPTY_CHECKPOINT_MISSING");
    expect(premature.checkpointId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await fixture.db.one<{
      id: string; source_high_water_sequence: string; through_event_id: string;
    }>(
      `select id::text,source_high_water_sequence::text,through_event_id::text
         from handoff_refresh_checkpoints where id=$1`,
      [premature.checkpointId],
    )).toEqual({
      id: premature.checkpointId,
      source_high_water_sequence: boundaries.created,
      through_event_id: fixture.proposal.createdEventId,
    });

    const complete = await refreshHandoff({ db: fixture.db }, {
      ...base,
      throughEventId: fixture.rawPrivateTextEventId,
      idempotencyKey: `handoff:raw-complete:${fixture.accountId}`,
    });
    if (complete.status !== "COMPLETED") throw new Error("HANDOFF_TEST_RAW_REFRESH_INCOMPLETE");
    const loaded = await loadHandoff({ db: fixture.db }, {
      packetId: complete.packet.id,
      ...base,
    });
    expect(loaded.highWaterSequence).toBe(boundaries.attached);
    expect(loaded.items.some(({ text }) => text === fixture.sourceText)).toBe(true);
  });

  it("rejects direct-SQL raw private attachment authority beyond packet high-water", async () => {
    const fixture = await proposalFixture("raw-direct", { raw: true });
    if (!fixture.rawPrivateTextEventId || !fixture.disclosure) {
      throw new Error("HANDOFF_TEST_RAW_EVENT_MISSING");
    }
    const disclosure = fixture.disclosure;
    const highWater = await fixture.db.one<{ ingested_sequence: string }>(
      "select ingested_sequence::text from events where id=$1",
      [fixture.proposal.createdEventId],
    );
    const proposal = await getProposal({ db: fixture.db }, {
      accountId: fixture.accountId,
      proposalId: fixture.proposal.id,
    });
    const operationKey = canonicalContentDigest({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      highWaterSequence: highWater.ingested_sequence,
      nodeBrainId: fixture.nodeBrainId,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      policyVersion: HANDOFF_POLICY_VERSION,
      scope: "NODE_BRANCH",
    });
    const requestDigest = canonicalContentDigest({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      policyVersion: HANDOFF_POLICY_VERSION,
      scope: "NODE_BRANCH",
      throughEventId: fixture.proposal.createdEventId,
      highWaterSequence: highWater.ingested_sequence,
    });
    await expect(fixture.db.transaction(async (transaction) => {
      const packetId = randomUUID();
      const createdAt = new Date();
      const forgedBody = { forged: "raw-high-water" } as const;
      const event = await appendEvent(transaction, {
        aggregateId: `node-handoff:${fixture.nodeBrainId}`,
        accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "handoff-refresher" },
        type: "node.handoff.packet.refreshed",
        visibility: "PRIVATE_ACCOUNT",
        body: forgedBody,
        policyVersion: HANDOFF_POLICY_VERSION,
        idempotencyKey: `node-handoff-packet:${operationKey}`,
        causationId: fixture.proposal.createdEventId,
        correlationId: packetId,
        occurredAt: createdAt,
      });
      await transaction.query(
        `insert into handoff_packets (
           id,account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
           main_state_version,packet_version,previous_packet_id,source_high_water_sequence,
           through_event_id,operation_key,idempotency_key,request_digest,packet_event_id,
           idea_count,source_count,body_digest,created_at
         ) values ($1,$2,$3,$4,'NODE_BRANCH',$5,$6,$7,1,null,$8,$9,$10,$11,$12,$13,1,1,$14,$15)`,
        [packetId, fixture.accountId, fixture.nodeBrainId, fixture.conversationId,
          HANDOFF_POLICY_VERSION, fixture.nodeStateVersion, fixture.mainStateVersion,
          highWater.ingested_sequence, fixture.proposal.createdEventId, operationKey,
          `handoff:raw-direct:${packetId}`, requestDigest, event.id,
          canonicalContentDigest(forgedBody), event.occurredAt],
      );
      await transaction.query(
        `insert into handoff_packet_ideas (
           packet_id,ordinal,proposal_id,proposal_event_id,proposal_status_event_id,
           proposal_status_ordinal,disclosure_authorization_id,disclosure_revocation_event_id,
           source_event_ids,memory_ids,memory_versions,content_digest
         ) select $1,0,$2,$3,$3,0,$4,null,array[$5]::uuid[],array[memory.id],
                  array[memory.body_event_id::text||':'||memory.conflict_state],$6
             from memory_records memory where memory.id=$7`,
        [packetId, fixture.proposal.id, fixture.proposal.createdEventId, disclosure.id,
          fixture.source.eventId, canonicalContentDigest({
            counterevidence: proposal.counterevidence,
            evidence: proposal.evidence,
            proposedChange: proposal.proposedChange,
            sourceEventIds: proposal.sourceEventIds,
            uncertainty: proposal.uncertainty,
          }), fixture.transmittedMemory.id],
      );
    })).rejects.toThrow("HANDOFF_PACKET_IDEA_HIGH_WATER_INVALID");
  });

  it("replays sealed empty checkpoints concurrently and fails closed on revocation or erasure", async () => {
    const fixture = await proposalFixture("checkpoint-replay", { raw: true });
    const base = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
    };
    const [first, duplicate, alternate] = await Promise.all([
      refreshHandoff({ db: fixture.db }, {
        ...base, idempotencyKey: `handoff:checkpoint-replay:a:${fixture.accountId}`,
      }),
      refreshHandoff({ db: fixture.db }, {
        ...base, idempotencyKey: `handoff:checkpoint-replay:a:${fixture.accountId}`,
      }),
      refreshHandoff({ db: fixture.db }, {
        ...base, idempotencyKey: `handoff:checkpoint-replay:b:${fixture.accountId}`,
      }),
    ]);
    if (first.status !== "EMPTY" || duplicate.status !== "EMPTY" || alternate.status !== "EMPTY") {
      throw new Error("HANDOFF_TEST_EMPTY_REPLAY_INCOMPLETE");
    }
    expect(new Set([first.checkpointId, duplicate.checkpointId, alternate.checkpointId]).size)
      .toBe(1);
    const authority = await fixture.db.one<{
      checkpoint_event_id: string; body_digest: string; manifest_digest: string;
      topic: string; payload: { eventId: string }; keys: number; exact_keys: boolean;
    }>(
      `select checkpoint.checkpoint_event_id::text,checkpoint.body_digest,
              manifest.body_digest manifest_digest,outbox.topic,outbox.payload,
              (select count(*)::int from handoff_refresh_checkpoint_keys key
                where key.checkpoint_id=checkpoint.id) keys,
              (select bool_and(key.operation_key=checkpoint.operation_key
                  and key.request_digest=checkpoint.request_digest
                  and key.source_high_water_sequence=checkpoint.source_high_water_sequence
                  and key.created_at=checkpoint.created_at
                  and key.key_digest=handoff_refresh_checkpoint_key_digest(
                    key.idempotency_key,checkpoint.id))
                 from handoff_refresh_checkpoint_keys key
                where key.checkpoint_id=checkpoint.id) exact_keys
         from handoff_refresh_checkpoints checkpoint
         join handoff_refresh_checkpoint_manifests manifest
           on manifest.checkpoint_id=checkpoint.id
         join transactional_outbox outbox on outbox.event_id=checkpoint.checkpoint_event_id
        where checkpoint.id=$1`,
      [first.checkpointId],
    );
    expect(authority).toMatchObject({
      body_digest: authority.manifest_digest,
      topic: "node.handoff.checkpoint.advanced",
      payload: { eventId: authority.checkpoint_event_id },
      keys: 2,
      exact_keys: true,
    });
    expect(await readEventBody(fixture.db, authority.checkpoint_event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    })).toMatchObject({
      checkpointId: first.checkpointId,
      result: "EMPTY",
      highWaterSequence: first.highWaterSequence,
      throughEventId: fixture.proposal.createdEventId,
    });
    await fixture.db.query(
      "update entitlements set revoked_at=clock_timestamp() where account_id=$1",
      [fixture.accountId],
    );
    await expect(refreshHandoff({ db: rejectProtectedReads(fixture.db) }, {
      ...base,
      idempotencyKey: `handoff:checkpoint-replay:c:${fixture.accountId}`,
    })).rejects.toThrow("HANDOFF_FORBIDDEN");

    const erased = await proposalFixture("checkpoint-erasure", { raw: true });
    const erasedBase = {
      accountId: erased.accountId,
      nodeBrainId: erased.nodeBrainId,
      conversationId: erased.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: erased.nodeStateVersion,
      mainStateVersion: erased.mainStateVersion,
      throughEventId: erased.proposal.createdEventId,
    };
    const sealed = await refreshHandoff({ db: erased.db }, {
      ...erasedBase,
      idempotencyKey: `handoff:checkpoint-erasure:a:${erased.accountId}`,
    });
    if (sealed.status !== "EMPTY") throw new Error("HANDOFF_TEST_EMPTY_CHECKPOINT_MISSING");
    await erased.db.query(
      "delete from aggregate_data_keys where aggregate_id=$1",
      [`node-handoff-checkpoint:${erased.nodeBrainId}`],
    );
    await expect(refreshHandoff({ db: erased.db }, {
      ...erasedBase,
      idempotencyKey: `handoff:checkpoint-erasure:b:${erased.accountId}`,
    })).rejects.toThrow("HANDOFF_CHECKPOINT_UNAVAILABLE");
    expect(await erased.db.one<{ count: number }>(
      "select count(*)::int count from handoff_refresh_checkpoints where id=$1",
      [sealed.checkpointId],
    )).toEqual({ count: 1 });
  }, 30_000);

  it("rejects a direct-SQL empty checkpoint while an eligible proposal exists", async () => {
    const fixture = await proposalFixture("checkpoint-nonempty");
    const highWater = await fixture.db.one<{ ingested_sequence: string }>(
      "select ingested_sequence::text from events where id=$1",
      [fixture.proposal.createdEventId],
    );
    const operationKey = canonicalContentDigest({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      highWaterSequence: highWater.ingested_sequence,
      nodeBrainId: fixture.nodeBrainId,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      policyVersion: HANDOFF_POLICY_VERSION,
      scope: "NODE_BRANCH",
    });
    const requestDigest = canonicalContentDigest({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      policyVersion: HANDOFF_POLICY_VERSION,
      scope: "NODE_BRANCH",
      throughEventId: fixture.proposal.createdEventId,
      highWaterSequence: highWater.ingested_sequence,
    });
    await expect(fixture.db.transaction(async (transaction) => {
      const checkpointId = randomUUID();
      const createdAt = new Date();
      const body = {
        checkpointId,
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId,
        scope: "NODE_BRANCH",
        policyVersion: HANDOFF_POLICY_VERSION,
        nodeStateVersion: fixture.nodeStateVersion,
        mainStateVersion: fixture.mainStateVersion,
        checkpointVersion: "1",
        previousCheckpointId: null,
        highWaterSequence: highWater.ingested_sequence,
        throughEventId: fixture.proposal.createdEventId,
        operationKey,
        requestDigest,
        result: "EMPTY",
        createdAt: createdAt.toISOString(),
      } as const;
      const event = await appendEvent(transaction, {
        aggregateId: `node-handoff-checkpoint:${fixture.nodeBrainId}`,
        accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "handoff-refresher" },
        type: "node.handoff.checkpoint.advanced",
        visibility: "PRIVATE_ACCOUNT",
        body,
        idempotencyKey: `node-handoff-checkpoint:${operationKey}`,
        causationId: fixture.proposal.createdEventId,
        correlationId: checkpointId,
        occurredAt: createdAt,
        policyVersion: HANDOFF_POLICY_VERSION,
      });
      await transaction.query(
        `insert into handoff_refresh_checkpoints (
           id,account_id,node_brain_id,conversation_id,scope,policy_version,
           node_state_version,main_state_version,checkpoint_version,previous_checkpoint_id,
           source_high_water_sequence,through_event_id,operation_key,idempotency_key,
           request_digest,checkpoint_event_id,body_digest,created_at
         ) values ($1,$2,$3,$4,'NODE_BRANCH',$5,$6,$7,1,null,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [checkpointId, fixture.accountId, fixture.nodeBrainId, fixture.conversationId,
          HANDOFF_POLICY_VERSION, fixture.nodeStateVersion, fixture.mainStateVersion,
          highWater.ingested_sequence, fixture.proposal.createdEventId, operationKey,
          `handoff:checkpoint-nonempty:${fixture.accountId}`, requestDigest, event.id,
          canonicalContentDigest(body), event.occurredAt],
      );
      throw new Error("HANDOFF_NONEMPTY_CHECKPOINT_ACCEPTED");
    })).rejects.toThrow("HANDOFF_CHECKPOINT_NOT_EMPTY");
  });

  it("serializes one global alias across concurrently sealed packet and checkpoint targets", async () => {
    const packetFixture = await proposalFixture("alias-race-packet");
    const packetInput = {
      accountId: packetFixture.accountId,
      nodeBrainId: packetFixture.nodeBrainId,
      conversationId: packetFixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: packetFixture.nodeStateVersion,
      mainStateVersion: packetFixture.mainStateVersion,
      throughEventId: packetFixture.proposal.createdEventId,
      idempotencyKey: `handoff:alias-race:packet:${packetFixture.accountId}`,
    };
    const packet = await refreshHandoff({ db: packetFixture.db }, packetInput);
    if (packet.status !== "COMPLETED") throw new Error("HANDOFF_TEST_PACKET_MISSING");

    const checkpointFixture = await proposalFixture(
      "alias-race-checkpoint", { raw: true }, packetFixture.db,
    );
    const checkpointInput = {
      accountId: checkpointFixture.accountId,
      nodeBrainId: checkpointFixture.nodeBrainId,
      conversationId: checkpointFixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: checkpointFixture.nodeStateVersion,
      mainStateVersion: checkpointFixture.mainStateVersion,
      throughEventId: checkpointFixture.proposal.createdEventId,
      idempotencyKey: `handoff:alias-race:checkpoint:${checkpointFixture.accountId}`,
    };
    const checkpoint = await refreshHandoff({ db: packetFixture.db }, checkpointInput);
    if (checkpoint.status !== "EMPTY") throw new Error("HANDOFF_TEST_CHECKPOINT_MISSING");

    const alias = `handoff:alias-race:shared:${packetFixture.accountId}`;
    const outcomes = await Promise.allSettled([
      packetFixture.db.transaction(async (transaction) => {
        await transaction.query(
          `insert into handoff_packet_keys (
             idempotency_key,packet_id,operation_key,request_digest,
             source_high_water_sequence,key_digest,created_at
           ) select $1,id,operation_key,request_digest,source_high_water_sequence,
                    handoff_packet_key_digest($1,id),created_at
               from handoff_packets where id=$2`,
          [alias, packet.packet.id],
        );
        await transaction.query("select pg_sleep(0.5)");
      }),
      packetFixture.db.transaction(async (transaction) => {
        await transaction.query(
          `insert into handoff_refresh_checkpoint_keys (
             idempotency_key,checkpoint_id,operation_key,request_digest,
             source_high_water_sequence,key_digest,created_at
           ) select $1,id,operation_key,request_digest,source_high_water_sequence,
                    handoff_refresh_checkpoint_key_digest($1,id),created_at
               from handoff_refresh_checkpoints where id=$2`,
          [alias, checkpoint.checkpointId],
        );
        await transaction.query("select pg_sleep(0.5)");
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    if (!rejected || rejected.status !== "rejected") throw new Error("HANDOFF_ALIAS_RACE_NOT_REJECTED");
    expect(rejected.reason).toBeInstanceOf(Error);
    expect((rejected.reason as Error).message).toContain("HANDOFF_KEY_REGISTRY_CONFLICT");
    const registry = await packetFixture.db.one<{
      target_kind: "PACKET" | "CHECKPOINT"; target_id: string;
      operation_key: string; request_digest: string; source_high_water_sequence: string;
      key_digest: string; created_at: Date;
    }>(
      `select target_kind,target_id::text,operation_key,request_digest,
              source_high_water_sequence::text,key_digest,created_at
         from handoff_key_registry where idempotency_key=$1`,
      [alias],
    );
    expect(await packetFixture.db.one<{ aliases: number; exact: boolean }>(
      `select count(*)::int aliases,bool_and(
          registry.target_kind=alias.target_kind
          and registry.target_id=alias.target_id
          and registry.operation_key=alias.operation_key
          and registry.request_digest=alias.request_digest
          and registry.source_high_water_sequence=alias.source_high_water_sequence
          and registry.key_digest=alias.key_digest
          and registry.created_at=alias.created_at) exact
       from handoff_key_registry registry
       join (
         select 'PACKET'::text target_kind,key.packet_id target_id,key.operation_key,
                key.request_digest,key.source_high_water_sequence,key.key_digest,key.created_at
           from handoff_packet_keys key where key.idempotency_key=$1
         union all
         select 'CHECKPOINT'::text,key.checkpoint_id,key.operation_key,key.request_digest,
                key.source_high_water_sequence,key.key_digest,key.created_at
           from handoff_refresh_checkpoint_keys key where key.idempotency_key=$1
       ) alias on true where registry.idempotency_key=$1`,
      [alias],
    )).toEqual({ aliases: 1, exact: true });
    const replay = await Promise.all([
      packetFixture.db.one<typeof registry>(
        `select target_kind,target_id::text,operation_key,request_digest,
                source_high_water_sequence::text,key_digest,created_at
           from handoff_key_registry where idempotency_key=$1`, [alias],
      ),
      packetFixture.db.one<typeof registry>(
        `select target_kind,target_id::text,operation_key,request_digest,
                source_high_water_sequence::text,key_digest,created_at
           from handoff_key_registry where idempotency_key=$1`, [alias],
      ),
    ]);
    expect(replay).toEqual([registry, registry]);
  }, 30_000);

  it("rejects foreign-account packet and job high-water anchors before protected authority persists", async () => {
    const fixture = await proposalFixture("foreign-high-water");
    const packetInput = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:foreign-high-water:packet:${fixture.accountId}`,
    };
    const sealed = await refreshHandoff({ db: fixture.db }, packetInput);
    if (sealed.status !== "COMPLETED") throw new Error("HANDOFF_TEST_PACKET_MISSING");
    const foreign = await createConversationFixture("Foreign high-water", fixture.db);
    const foreignSource = await appendMessage(foreign, {
      role: "USER",
      text: "This other account event cannot anchor a handoff.",
      idempotencyKey: `handoff:foreign-high-water:source:${foreign.accountId}`,
    });
    const highWater = await fixture.db.one<{ ingested_sequence: string }>(
      "select ingested_sequence::text from events where id=$1", [foreignSource.eventId],
    );
    const operationKey = canonicalContentDigest({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      highWaterSequence: highWater.ingested_sequence,
      nodeBrainId: fixture.nodeBrainId,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      policyVersion: HANDOFF_POLICY_VERSION,
      scope: "NODE_BRANCH",
    });
    const requestDigest = canonicalContentDigest({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      policyVersion: HANDOFF_POLICY_VERSION,
      scope: "NODE_BRANCH",
      throughEventId: foreignSource.eventId,
      highWaterSequence: highWater.ingested_sequence,
    });
    const persisted = await fixture.db.one<{
      packet_version: string; idea_count: number; source_count: number;
      packet_event_id: string;
    }>(
      `select packet_version::text,idea_count,source_count,packet_event_id::text
         from handoff_packets where id=$1`, [sealed.packet.id],
    );
    const original = await fixture.db.one<{ body: JsonValue }>(
      "select handoff_packet_event_body($1) body", [sealed.packet.id],
    );
    let forgedPacketEventId: string = randomUUID();
    await expect(fixture.db.transaction(async (transaction) => {
      const packetId = randomUUID();
      const createdAt = new Date();
      const body = {
        ...(original.body as Record<string, JsonValue>),
        packetId,
        packetVersion: String(BigInt(persisted.packet_version) + 1n),
        previousPacketId: sealed.packet.id,
        highWaterSequence: highWater.ingested_sequence,
        throughEventId: foreignSource.eventId,
        operationKey,
        requestDigest,
        createdAt: createdAt.toISOString(),
      } as const;
      const event = await appendEvent(transaction, {
        aggregateId: `node-handoff:${fixture.nodeBrainId}`,
        accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "handoff-refresher" },
        type: "node.handoff.packet.refreshed",
        visibility: "PRIVATE_ACCOUNT",
        body,
        idempotencyKey: `node-handoff-packet:${operationKey}`,
        causationId: foreignSource.eventId,
        correlationId: packetId,
        occurredAt: createdAt,
        policyVersion: HANDOFF_POLICY_VERSION,
      });
      forgedPacketEventId = event.id;
      await transaction.query(
        `insert into handoff_packets (
           id,account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
           main_state_version,packet_version,previous_packet_id,source_high_water_sequence,
           through_event_id,operation_key,idempotency_key,request_digest,packet_event_id,
           idea_count,source_count,body_digest,created_at
         ) values ($1,$2,$3,$4,'NODE_BRANCH',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   $16,$17,$18,$19)`,
        [packetId, fixture.accountId, fixture.nodeBrainId, fixture.conversationId,
          HANDOFF_POLICY_VERSION, fixture.nodeStateVersion, fixture.mainStateVersion,
          String(BigInt(persisted.packet_version) + 1n), sealed.packet.id,
          highWater.ingested_sequence, foreignSource.eventId, operationKey,
          `handoff:foreign-high-water:forged-packet:${fixture.accountId}`, requestDigest,
          event.id, persisted.idea_count, persisted.source_count,
          canonicalContentDigest(body), event.occurredAt],
      );
      throw new Error("HANDOFF_FOREIGN_PACKET_HIGH_WATER_ACCEPTED");
    })).rejects.toThrow("HANDOFF_PACKET_HIGH_WATER_INVALID");
    expect(await fixture.db.one<{ events: number; bodies: number; outbox: number }>(
      `select (select count(*)::int from events where id=$1) events,
              (select count(*)::int from encrypted_event_bodies where event_id=$1) bodies,
              (select count(*)::int from transactional_outbox where event_id=$1) outbox`,
      [forgedPacketEventId],
    )).toEqual({ events: 0, bodies: 0, outbox: 0 });

    let forgedJobEventId: string = randomUUID();
    await expect(fixture.db.transaction(async (transaction) => {
      const jobId = randomUUID();
      const createdAt = new Date();
      const jobRequestDigest = canonicalContentDigest({
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        estimatedDeltaCount: 9,
        highWaterSequence: highWater.ingested_sequence,
        nodeBrainId: fixture.nodeBrainId,
        nodeStateVersion: fixture.nodeStateVersion,
        mainStateVersion: fixture.mainStateVersion,
        policyVersion: HANDOFF_POLICY_VERSION,
        scope: "NODE_BRANCH",
        throughEventId: foreignSource.eventId,
      });
      const body = {
        jobId,
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId,
        scope: "NODE_BRANCH",
        policyVersion: HANDOFF_POLICY_VERSION,
        nodeStateVersion: fixture.nodeStateVersion,
        mainStateVersion: fixture.mainStateVersion,
        requestedHighWaterSequence: highWater.ingested_sequence,
        throughEventId: foreignSource.eventId,
        operationKey,
        requestDigest: jobRequestDigest,
        estimatedDeltaCount: 9,
        createdAt: createdAt.toISOString(),
      } as const;
      const event = await appendEvent(transaction, {
        aggregateId: `node-handoff-job:${jobId}`,
        accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "handoff-refresher" },
        type: "node.handoff.refresh.queued",
        visibility: "PRIVATE_ACCOUNT",
        body,
        idempotencyKey: `node-handoff-job:${operationKey}`,
        causationId: foreignSource.eventId,
        correlationId: jobId,
        occurredAt: createdAt,
        policyVersion: HANDOFF_POLICY_VERSION,
      });
      forgedJobEventId = event.id;
      await transaction.query(
        `insert into handoff_refresh_jobs (
           id,account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
           main_state_version,requested_high_water_sequence,through_event_id,operation_key,
           request_digest,request_event_id,estimated_delta_count,body_digest,created_at
         ) values ($1,$2,$3,$4,'NODE_BRANCH',$5,$6,$7,$8,$9,$10,$11,$12,9,$13,$14)`,
        [jobId, fixture.accountId, fixture.nodeBrainId, fixture.conversationId,
          HANDOFF_POLICY_VERSION, fixture.nodeStateVersion, fixture.mainStateVersion,
          highWater.ingested_sequence, foreignSource.eventId, operationKey, jobRequestDigest,
          event.id, canonicalContentDigest(body), event.occurredAt],
      );
      throw new Error("HANDOFF_FOREIGN_JOB_HIGH_WATER_ACCEPTED");
    })).rejects.toThrow("HANDOFF_REFRESH_JOB_HIGH_WATER_INVALID");
    expect(await fixture.db.one<{ events: number; bodies: number; outbox: number }>(
      `select (select count(*)::int from events where id=$1) events,
              (select count(*)::int from encrypted_event_bodies where event_id=$1) bodies,
              (select count(*)::int from transactional_outbox where event_id=$1) outbox`,
      [forgedJobEventId],
    )).toEqual({ events: 0, bodies: 0, outbox: 0 });
  }, 30_000);

  it("rejects stale Node/Main state inputs and unsupported policy at the SQL boundary", async () => {
    const fixture = await proposalFixture("state");
    const valid = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
    };
    await expect(refreshHandoff({ db: fixture.db }, {
      ...valid,
      nodeStateVersion: String(BigInt(fixture.nodeStateVersion) + 1n),
      idempotencyKey: `handoff:stale-node:${fixture.accountId}`,
    })).rejects.toThrow("HANDOFF_STATE_STALE");
    await expect(refreshHandoff({ db: fixture.db }, {
      ...valid,
      mainStateVersion: String(BigInt(fixture.mainStateVersion) + 1n),
      idempotencyKey: `handoff:stale-main:${fixture.accountId}`,
    })).rejects.toThrow("HANDOFF_STATE_STALE");

    await expect(fixture.db.query(
      `insert into handoff_refresh_jobs (
         id,account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
         main_state_version,
         requested_high_water_sequence,through_event_id,operation_key,request_digest,
         request_event_id,estimated_delta_count,body_digest,created_at
       ) select $1,$2,$3,$4,'NODE_BRANCH','unsupported-handoff-policy',$5,$6,
                event.ingested_sequence,event.id,$7,$8,event.id,9,body.body_digest,clock_timestamp()
           from events event join encrypted_event_bodies body on body.event_id=event.id
          where event.id=$9`,
      [randomUUID(), fixture.accountId, fixture.nodeBrainId, fixture.conversationId,
        fixture.nodeStateVersion, fixture.mainStateVersion, "a".repeat(64), "b".repeat(64),
        fixture.proposal.createdEventId],
    )).rejects.toThrow("HANDOFF_POLICY_UNSUPPORTED");
  });

  it("invalidates a packet after proposal withdrawal without hydrating protected bodies", async () => {
    const fixture = await proposalFixture("withdrawn");
    const refreshed = await refreshHandoff({ db: fixture.db }, {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:withdrawn:${fixture.accountId}`,
    });
    if (refreshed.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");
    await transitionProposal({ db: fixture.db }, {
      proposalId: fixture.proposal.id,
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
      toStatus: "WITHDRAWN",
      reason: "The source thesis is no longer offered upstream.",
      idempotencyKey: `handoff:withdraw:${fixture.accountId}`,
    });
    await expect(loadHandoff({ db: rejectProtectedReads(fixture.db) }, {
      packetId: refreshed.packet.id,
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
    })).rejects.toThrow("HANDOFF_STALE");
  });

  it("advances append-only packet versions from the prior high-water mark", async () => {
    const fixture = await proposalFixture("incremental");
    const base = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
    };
    const first = await refreshHandoff({ db: fixture.db }, {
      ...base,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:incremental:first:${fixture.accountId}`,
    });
    if (first.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");
    await transitionProposal({ db: fixture.db }, {
      proposalId: fixture.proposal.id,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      toStatus: "UNDER_REVIEW",
      reason: "The transmitted proposal is ready for structured review.",
      idempotencyKey: `handoff:incremental:transition:${fixture.accountId}`,
    });
    const transition = await fixture.db.one<{ transition_event_id: string }>(
      `select transition_event_id::text from proposal_status_transitions
       where proposal_id=$1 order by ordinal desc limit 1`,
      [fixture.proposal.id],
    );
    const second = await refreshHandoff({ db: fixture.db }, {
      ...base,
      throughEventId: transition.transition_event_id,
      idempotencyKey: `handoff:incremental:second:${fixture.accountId}`,
    });
    if (second.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");
    expect(BigInt(second.packet.highWaterSequence)).toBeGreaterThan(BigInt(first.packet.highWaterSequence));
    expect(second.packet.packetVersion).toBe("2");
    expect(await fixture.db.one<{ previous_packet_id: string }>(
      "select previous_packet_id::text from handoff_packets where id=$1", [second.packet.id],
    )).toEqual({ previous_packet_id: first.packet.id });
  });

  it("fails closed after source-key erasure while retaining non-sensitive packet authority", async () => {
    const fixture = await proposalFixture("erasure");
    const refreshed = await refreshHandoff({ db: fixture.db }, {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:erasure:${fixture.accountId}`,
    });
    if (refreshed.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");
    await fixture.db.query("delete from aggregate_data_keys where aggregate_id=$1", [fixture.conversationId]);
    await expect(loadHandoff({ db: fixture.db }, {
      packetId: refreshed.packet.id,
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
    })).rejects.toThrow(/EVENT_KEY_UNAVAILABLE|HANDOFF_SOURCE_UNAVAILABLE/);
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int count from handoff_packets where id=$1", [refreshed.packet.id],
    )).toEqual({ count: 1 });
  });

  it("queues oversized refresh work durably and permits only one live claimant", async () => {
    const fixture = await proposalFixture("job");
    const input = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:job:${fixture.accountId}`,
    };
    const queued = await enqueueHandoffRefresh({ db: fixture.db }, input, {
      estimatedDeltaCount: 9,
    });
    expect(queued.status).toBe("PENDING");
    const queueBody = await readEventBody(fixture.db, queued.eventId, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    });
    expect(queueBody).toMatchObject({ jobId: queued.id, estimatedDeltaCount: 9 });
    expect(await fixture.db.one<{ topic: string; payload: { eventId: string } }>(
      "select topic,payload from transactional_outbox where event_id=$1", [queued.eventId],
    )).toEqual({ topic: "node.handoff.refresh.queued", payload: { eventId: queued.eventId } });
    await expect(fixture.db.query(
      `insert into handoff_refresh_job_transitions (
         id,job_id,ordinal,action,from_status,to_status,worker_id,lease_until,retry_at,
         packet_id,error_code,transition_event_id,idempotency_key,operation_digest,
         body_digest,created_at
       ) values ($1,$2,1,'CLAIM','PENDING','CLAIMED','expired-worker',
         clock_timestamp()-interval '1 second',null,null,null,$3,$4,$5,$6,clock_timestamp())`,
      [randomUUID(), queued.id, queued.eventId, `handoff:expired:${fixture.accountId}`,
        "1".repeat(64), "2".repeat(64)],
    )).rejects.toThrow("HANDOFF_REFRESH_TRANSITION_TIME_INVALID");
    await expect(fixture.db.query(
      "update transactional_outbox set topic='forged.handoff.topic' where event_id=$1",
      [queued.eventId],
    )).rejects.toThrow("IMMUTABLE_HANDOFF_OUTBOX");
    const claims = await Promise.allSettled([
      claimHandoffRefreshJob({ db: fixture.db }, { jobId: queued.id, workerId: "worker-a", leaseMilliseconds: 30_000 }),
      claimHandoffRefreshJob({ db: fixture.db }, { jobId: queued.id, workerId: "worker-b", leaseMilliseconds: 30_000 }),
    ]);
    expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(claims.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const claim = claims.find((result) => result.status === "fulfilled");
    if (!claim || claim.status !== "fulfilled") throw new Error("HANDOFF_TEST_CLAIM_MISSING");
    const completed = await processHandoffRefreshJob({ db: fixture.db }, claim.value);
    expect(completed.status).toBe("COMPLETED");
    expect(await fixture.db.one<{ status: string; packet_id: string | null }>(
      "select status,packet_id::text from handoff_refresh_job_current where id=$1", [queued.id],
    )).toMatchObject({ status: "COMPLETED", packet_id: expect.any(String) });
  });

  it("counts raw private attachment events at the eight-event incremental boundary", async () => {
    const runBoundary = async (label: string, memoryRunCount: number) => {
      const fixture = await proposalFixture(label, { raw: true });
      const base = {
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId,
        scope: "NODE_BRANCH" as const,
        policyVersion: HANDOFF_POLICY_VERSION,
        nodeStateVersion: fixture.nodeStateVersion,
        mainStateVersion: fixture.mainStateVersion,
      };
      const checkpoint = await refreshHandoff({ db: fixture.db }, {
        ...base,
        throughEventId: fixture.proposal.createdEventId,
        idempotencyKey: `handoff:attachment-boundary:checkpoint:${label}`,
      });
      if (checkpoint.status !== "EMPTY") throw new Error("HANDOFF_TEST_CHECKPOINT_MISSING");
      const route = await fixture.db.one<{ occurred_at: Date }>(
        "select occurred_at from events where id=$1", [fixture.routeEventId],
      );
      const routeText = canonicalJson(await readEventBody(fixture.db, fixture.routeEventId, {
        actor: { role: "ACCOUNT", accountId: fixture.accountId },
      }));
      let throughEventId = fixture.rawPrivateTextEventId!;
      for (let index = 0; index < memoryRunCount; index += 1) {
        const text = `Attachment boundary ${label} memory ${index}.`;
        const source = await appendMessage(fixture, {
          role: "USER",
          text,
          idempotencyKey: `handoff:attachment-boundary:source:${label}:${index}`,
        });
        const consolidated = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
          scope: "NODE_BRANCH",
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          conversationId: fixture.conversationId,
          sourceEventId: source.eventId,
          events: [
            ...(index === 0 ? [{
              id: fixture.routeEventId,
              at: route.occurred_at.toISOString(),
              text: routeText,
            }] : []),
            { id: source.eventId, at: source.occurredAt, text },
          ],
          extracted: { facts: [{
            text,
            sourceIds: [source.eventId],
            keywords: ["attachment-boundary"],
            entities: [],
          }] },
          versions: VERSIONS,
          observedAt: new Date().toISOString(),
          idempotencyKey: `handoff:attachment-boundary:memory:${label}:${index}`,
        });
        throughEventId = consolidated.consolidationEventId;
      }
      return refreshHandoffIncrementally({ db: fixture.db }, {
        ...base,
        throughEventId,
        idempotencyKey: `handoff:attachment-boundary:refresh:${label}`,
      });
    };
    const exactlyEight = await runBoundary("attachment-eight", 7);
    expect(exactlyEight.status).toBe("COMPLETED");
    const nine = await runBoundary("attachment-nine", 8);
    expect(nine.status).toBe("QUEUED");
    if (nine.status !== "QUEUED") throw new Error("HANDOFF_TEST_ATTACHMENT_JOB_MISSING");
    expect(nine.job.estimatedDeltaCount).toBe(9);
  }, 60_000);

  it("completes empty oversized work once and advances its durable incremental checkpoint", async () => {
    const fixture = await proposalFixture("job-empty");
    const proposals = [fixture.proposal];
    for (let index = 0; index < 4; index += 1) {
      proposals.push((await createFollowupProposal(fixture, `job-empty-${index}`)).proposal);
    }
    for (const [index, proposal] of proposals.entries()) {
      await transitionProposal({ db: fixture.db }, {
        proposalId: proposal.id,
        actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
        toStatus: "WITHDRAWN",
        reason: `No longer eligible for the empty handoff batch ${index}.`,
        idempotencyKey: `handoff:job-empty:withdraw:${index}:${fixture.accountId}`,
      });
    }
    const through = await fixture.db.one<{ transition_event_id: string }>(
      `select transition_event_id::text from proposal_status_transitions
        where proposal_id=$1 order by ordinal desc limit 1`,
      [proposals.at(-1)!.id],
    );
    const state = await fixture.db.one<{
      node_state_version: string; main_state_version: string;
    }>(
      `select routed.ingested_sequence::text node_state_version,
              main.version::text main_state_version
         from events source
         join lateral (select event.* from events event
           where event.aggregate_id=$1 and event.account_id=$2
             and event.actor_type='NODE_BRAIN' and event.actor_id=$3
             and event.type='node.reply.routed' and event.visibility='PRIVATE_ACCOUNT'
             and event.ingested_sequence<=source.ingested_sequence
           order by event.ingested_sequence desc,event.id desc limit 1) routed on true
         join lateral (select version from main_state_versions order by version desc limit 1) main on true
        where source.id=$4`,
      [fixture.conversationId, fixture.accountId, fixture.nodeBrainId,
        through.transition_event_id],
    );
    const input = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: state.node_state_version,
      mainStateVersion: state.main_state_version,
      throughEventId: through.transition_event_id,
      idempotencyKey: `handoff:job-empty:${fixture.accountId}`,
    };
    const queued = await refreshHandoffIncrementally({ db: fixture.db }, input);
    expect(queued.status).toBe("QUEUED");
    if (queued.status !== "QUEUED") throw new Error("HANDOFF_TEST_EMPTY_JOB_NOT_QUEUED");
    const claim = await claimHandoffRefreshJob({ db: fixture.db }, {
      jobId: queued.job.id,
      workerId: "empty-worker",
      leaseMilliseconds: 30_000,
    });
    const completed = await processHandoffRefreshJob({ db: fixture.db }, claim);
    expect(completed).toMatchObject({
      status: "COMPLETED",
      packet: null,
      checkpointId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(await fixture.db.one<{
      status: string; packet_id: string | null; checkpoint_id: string | null;
    }>(
      "select status,packet_id::text,checkpoint_id::text from handoff_refresh_job_current where id=$1",
      [queued.job.id],
    )).toEqual({
      status: "COMPLETED",
      packet_id: null,
      checkpoint_id: completed.checkpointId,
    });
    const completion = await fixture.db.one<{
      transition_event_id: string; topic: string; payload: { eventId: string };
    }>(
      `select transition.transition_event_id::text,outbox.topic,outbox.payload
         from handoff_refresh_job_current current
         join handoff_refresh_job_transitions transition on transition.id=current.transition_id
         join transactional_outbox outbox on outbox.event_id=transition.transition_event_id
        where current.id=$1`,
      [queued.job.id],
    );
    expect(completion).toMatchObject({
      topic: "node.handoff.refresh.completed",
      payload: { eventId: completion.transition_event_id },
    });
    expect(await readEventBody(fixture.db, completion.transition_event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    })).toMatchObject({
      jobId: queued.job.id,
      packetId: null,
      checkpointId: completed.checkpointId,
      toStatus: "COMPLETED",
    });
    const second = await refreshHandoffIncrementally({ db: fixture.db }, {
      ...input,
      idempotencyKey: `handoff:job-empty:second:${fixture.accountId}`,
    });
    expect(second).toMatchObject({
      status: "EMPTY",
      highWaterSequence: queued.job.highWaterSequence,
      checkpointId: completed.checkpointId,
    });
    expect(await fixture.db.one<{ jobs: number; checkpoints: number }>(
      `select (select count(*)::int from handoff_refresh_jobs) jobs,
              (select count(*)::int from handoff_refresh_checkpoints) checkpoints`,
    )).toEqual({ jobs: 1, checkpoints: 1 });
  }, 60_000);

  it("seals canonical handoff outbox association while permitting publisher lifecycle fields", async () => {
    const fixture = await proposalFixture("outbox-seal");
    const refreshed = await refreshHandoff({ db: fixture.db }, {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:outbox-seal:${fixture.accountId}`,
    });
    if (refreshed.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");
    const canonical = await fixture.db.one<{
      id: string; event_id: string; topic: string; payload: { eventId: string };
    }>(
      `select outbox.id::text,outbox.event_id::text,outbox.topic,outbox.payload
         from transactional_outbox outbox join handoff_packets packet
           on packet.packet_event_id=outbox.event_id where packet.id=$1`,
      [refreshed.packet.id],
    );
    expect(canonical.payload).toEqual({ eventId: canonical.event_id });
    await expect(fixture.db.query(
      `insert into transactional_outbox(id,event_id,topic,payload)
       values ($1,$2,$3,'{"eventId":"attacker","extra":true}'::jsonb)`,
      [randomUUID(), canonical.event_id, canonical.topic],
    )).rejects.toThrow("HANDOFF_OUTBOX_INVALID");
    await expect(fixture.db.query(
      "delete from transactional_outbox where id=$1", [canonical.id],
    )).rejects.toThrow("IMMUTABLE_HANDOFF_OUTBOX");

    const ordinary = await appendEvent(fixture.db, {
      aggregateId: "handoff-outbox-ordinary",
      actor: { type: "SYSTEM", id: "ordinary" },
      type: "ordinary.handoff.outbox",
      visibility: "PUBLIC",
      body: { ordinary: true },
      idempotencyKey: `handoff:outbox-ordinary:${fixture.accountId}`,
    });
    const replacement = await appendEvent(fixture.db, {
      aggregateId: "handoff-outbox-replacement",
      actor: { type: "SYSTEM", id: "ordinary" },
      type: "ordinary.handoff.replacement",
      visibility: "PUBLIC",
      body: { replacement: true },
      idempotencyKey: `handoff:outbox-replacement:${fixture.accountId}`,
    });
    await expect(fixture.db.transaction(async (transaction) => {
      await transaction.query("delete from transactional_outbox where event_id=$1", [replacement.id]);
      await transaction.query(
        `update transactional_outbox set event_id=$1::uuid,topic=$2,
           payload=jsonb_build_object('eventId',($1::uuid)::text) where id=$3`,
        [replacement.id, "ordinary.handoff.replacement", canonical.id],
      );
      throw new Error("CANONICAL_TO_ORDINARY_HANDOFF_OUTBOX_ACCEPTED");
    })).rejects.toThrow("IMMUTABLE_HANDOFF_OUTBOX");

    await expect(fixture.db.transaction(async (transaction) => {
      const forgedCanonicalEventId = randomUUID();
      await transaction.query(
        `insert into events (
           id,aggregate_id,account_id,actor_type,actor_id,type,visibility,occurred_at,
           causation_id,correlation_id,prompt_version,model_version,policy_version,
           idempotency_key,request_hash,integrity_hash
         ) select $1::uuid,event.aggregate_id,event.account_id,event.actor_type,event.actor_id,
                  event.type,event.visibility,event.occurred_at,null,$1::uuid,event.prompt_version,
                  event.model_version,event.policy_version,$2,event.request_hash,event.integrity_hash
             from events event where event.id=$3`,
        [forgedCanonicalEventId, `handoff:outbox-forged:${forgedCanonicalEventId}`,
          canonical.event_id],
      );
      await transaction.query(
        `update transactional_outbox set event_id=$1::uuid,topic=$2,
           payload=jsonb_build_object('eventId',($1::uuid)::text) where event_id=$3`,
        [forgedCanonicalEventId, canonical.topic, ordinary.id],
      );
      throw new Error("ORDINARY_TO_CANONICAL_HANDOFF_OUTBOX_ACCEPTED");
    })).rejects.toThrow("HANDOFF_OUTBOX_INVALID");

    await expect(fixture.db.transaction(async (transaction) => {
      await transaction.query(
        `update transactional_outbox set status='LEASED',attempts=attempts+1,
           available_at=clock_timestamp(),leased_until=clock_timestamp()+interval '1 minute'
         where id=$1`, [canonical.id],
      );
      await transaction.query(
        `update transactional_outbox set status='PUBLISHED',leased_until=null,
           published_at=clock_timestamp() where id=$1`, [canonical.id],
      );
      throw new Error("HANDOFF_OUTBOX_PUBLISHER_LIFECYCLE_ALLOWED");
    })).rejects.toThrow("HANDOFF_OUTBOX_PUBLISHER_LIFECYCLE_ALLOWED");
    await expect(fixture.db.transaction(async (transaction) => {
      await transaction.query(
        `update transactional_outbox set topic='ordinary.handoff.changed',payload='{}'::jsonb
           where event_id=$1`, [ordinary.id],
      );
      await transaction.query("delete from transactional_outbox where event_id=$1", [ordinary.id]);
      throw new Error("ORDINARY_HANDOFF_OUTBOX_MUTATION_ALLOWED");
    })).rejects.toThrow("ORDINARY_HANDOFF_OUTBOX_MUTATION_ALLOWED");
  });

  it("rolls back a canonical direct-SQL claim before its retry schedule is due", async () => {
    const fixture = await proposalFixture("retry-early");
    const input = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:retry-early:${fixture.accountId}`,
    };
    const queued = await enqueueHandoffRefresh({ db: fixture.db }, input, {
      estimatedDeltaCount: 9,
    });
    const claim = await claimHandoffRefreshJob({ db: fixture.db }, {
      jobId: queued.id,
      workerId: "retry-worker",
      leaseMilliseconds: 120_000,
    });
    await retryHandoffRefreshJob({ db: fixture.db }, claim, {
      retryDelayMilliseconds: 60_000,
      errorCode: "TRANSIENT_TEST_FAILURE",
    });
    const current = await fixture.db.one<{
      ordinal: number;
      transition_event_id: string;
    }>(
      `select current.ordinal,transition.transition_event_id::text
         from handoff_refresh_job_current current
         join handoff_refresh_job_transitions transition on transition.id=current.transition_id
        where current.id=$1`,
      [queued.id],
    );
    let forgedEventId: string = randomUUID();
    await expect(fixture.db.transaction(async (transaction) => {
      const transitionId = randomUUID();
      const createdAt = new Date();
      const leaseUntil = new Date(createdAt.getTime() + 30_000);
      const draft = {
        jobId: queued.id,
        ordinal: current.ordinal + 1,
        action: "CLAIM",
        fromStatus: "RETRY_SCHEDULED",
        toStatus: "CLAIMED",
        workerId: "early-worker",
        leaseUntil: leaseUntil.toISOString(),
        retryAt: null,
        packetId: null,
        checkpointId: null,
        errorCode: null,
      } as const;
      const operationDigest = canonicalContentDigest(draft);
      const body = {
        transitionId,
        ...draft,
        operationDigest,
        createdAt: createdAt.toISOString(),
      } as const;
      const event = await appendEvent(transaction, {
        aggregateId: `node-handoff-job:${queued.id}`,
        accountId: fixture.accountId,
        actor: { type: "SYSTEM", id: "handoff-refresher" },
        type: "node.handoff.refresh.claimed",
        visibility: "PRIVATE_ACCOUNT",
        body,
        idempotencyKey: `node-handoff-transition:${operationDigest}`,
        causationId: current.transition_event_id,
        correlationId: queued.id,
        occurredAt: createdAt,
        policyVersion: HANDOFF_POLICY_VERSION,
      });
      forgedEventId = event.id;
      const bodyDigest = canonicalContentDigest(body);
      await transaction.query(
        `insert into handoff_refresh_job_transitions (
           id,job_id,ordinal,action,from_status,to_status,worker_id,lease_until,retry_at,
           packet_id,error_code,transition_event_id,idempotency_key,operation_digest,
           body_digest,created_at
         ) values ($1,$2,$3,'CLAIM','RETRY_SCHEDULED','CLAIMED',$4,$5,null,null,null,
                   $6,$7,$8,$9,$10)`,
        [transitionId, queued.id, draft.ordinal, draft.workerId, draft.leaseUntil,
          event.id, `handoff-transition:${operationDigest}`, operationDigest, bodyDigest,
          event.occurredAt],
      );
      await transaction.query(
        `insert into handoff_refresh_job_transition_manifests (
           transition_id,job_id,transition_event_id,operation_digest,body_digest,
           event_request_hash,event_integrity_hash,created_at
         ) select $1,$2,event.id,$3,$4,event.request_hash,event.integrity_hash,$5
             from events event where event.id=$6`,
        [transitionId, queued.id, operationDigest, bodyDigest, event.occurredAt, event.id],
      );
    })).rejects.toThrow("HANDOFF_REFRESH_RETRY_NOT_DUE");
    expect(await fixture.db.one<{ events: number; outbox: number }>(
      `select (select count(*)::int from events where id=$1) events,
              (select count(*)::int from transactional_outbox where event_id=$1) outbox`,
      [forgedEventId],
    )).toEqual({ events: 0, outbox: 0 });
  });

  it("uses the DB clock to reject a future-dated steal of a still-live lease", async () => {
    const fixture = await proposalFixture("lease-steal");
    const input = {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH" as const,
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:lease-steal:${fixture.accountId}`,
    };
    const queued = await enqueueHandoffRefresh({ db: fixture.db }, input, {
      estimatedDeltaCount: 9,
    });
    await claimHandoffRefreshJob({ db: fixture.db }, {
      jobId: queued.id,
      workerId: "lease-owner",
      leaseMilliseconds: 1_000,
    });
    const prior = await fixture.db.one<{ lease_until: Date; claimed: number; outbox: number }>(
      `select current.lease_until,
              (select count(*)::int from events where correlation_id=$1
                and type='node.handoff.refresh.claimed') claimed,
              (select count(*)::int from transactional_outbox outbox join events event
                on event.id=outbox.event_id where event.correlation_id=$1
                and event.type='node.handoff.refresh.claimed') outbox
         from handoff_refresh_job_current current where current.id=$1`,
      [queued.id],
    );
    const stillLive = await fixture.db.one<{ live: boolean }>(
      "select clock_timestamp() < $1::timestamptz live",
      [prior.lease_until],
    );
    expect(stillLive.live).toBe(true);
    const capture: { eventId?: string } = {};
    await expect(appendCanonicalDirectJobTransition(fixture.db, {
      jobId: queued.id,
      action: "CLAIM",
      workerId: "lease-stealer",
      createdAt: prior.lease_until,
      leaseUntil: new Date(prior.lease_until.getTime() + 30_000),
      capture,
    })).rejects.toThrow("HANDOFF_REFRESH_LEASE_ACTIVE");
    expect(await fixture.db.one<{ claimed: number; outbox: number }>(
      `select (select count(*)::int from events where correlation_id=$1
                and type='node.handoff.refresh.claimed') claimed,
              (select count(*)::int from transactional_outbox outbox join events event
                on event.id=outbox.event_id where event.correlation_id=$1
                and event.type='node.handoff.refresh.claimed') outbox`,
      [queued.id],
    )).toEqual({ claimed: prior.claimed, outbox: prior.outbox });
    if (capture.eventId) {
      expect(await fixture.db.one<{ count: number }>(
        "select count(*)::int count from events where id=$1", [capture.eventId],
      )).toEqual({ count: 0 });
    }
  });

  it.each(["COMPLETE", "RETRY", "FAIL"] as const)(
    "rejects backdated canonical %s after the worker lease has expired",
    async (action) => {
      const fixture = await proposalFixture(`lease-expired-${action.toLowerCase()}`);
      const input = {
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId,
        scope: "NODE_BRANCH" as const,
        policyVersion: HANDOFF_POLICY_VERSION,
        nodeStateVersion: fixture.nodeStateVersion,
        mainStateVersion: fixture.mainStateVersion,
        throughEventId: fixture.proposal.createdEventId,
        idempotencyKey: `handoff:lease-expired:${action}:${fixture.accountId}`,
      };
      const packet = await refreshHandoff({ db: fixture.db }, {
        ...input,
        idempotencyKey: `handoff:lease-packet:${action}:${fixture.accountId}`,
      });
      if (packet.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");
      const queued = await enqueueHandoffRefresh({ db: fixture.db }, input, {
        estimatedDeltaCount: 9,
      });
      await claimHandoffRefreshJob({ db: fixture.db }, {
        jobId: queued.id,
        workerId: "expired-owner",
        leaseMilliseconds: 1_000,
      });
      const prior = await fixture.db.one<{ lease_until: Date }>(
        "select lease_until from handoff_refresh_job_current where id=$1",
        [queued.id],
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(await fixture.db.one<{ expired: boolean }>(
        "select clock_timestamp() >= $1::timestamptz expired", [prior.lease_until],
      )).toEqual({ expired: true });
      const before = await fixture.db.one<{ events: number; outbox: number }>(
        `select (select count(*)::int from events where correlation_id=$1) events,
                (select count(*)::int from transactional_outbox outbox join events event
                  on event.id=outbox.event_id where event.correlation_id=$1) outbox`,
        [queued.id],
      );
      const capture: { eventId?: string } = {};
      await expect(appendCanonicalDirectJobTransition(fixture.db, {
        jobId: queued.id,
        action,
        workerId: "expired-owner",
        createdAt: new Date(prior.lease_until.getTime() - 1),
        ...(action === "COMPLETE" ? { packetId: packet.packet.id } : {}),
        ...(action === "RETRY" ? {
          retryAt: new Date(Date.now() + 60_000),
          errorCode: "TRANSIENT_EXPIRED_LEASE",
        } : {}),
        ...(action === "FAIL" ? { errorCode: "EXPIRED_LEASE_FAILURE" } : {}),
        capture,
      })).rejects.toThrow("HANDOFF_REFRESH_LEASE_EXPIRED");
      expect(await fixture.db.one<{ events: number; outbox: number }>(
        `select (select count(*)::int from events where correlation_id=$1) events,
                (select count(*)::int from transactional_outbox outbox join events event
                  on event.id=outbox.event_id where event.correlation_id=$1) outbox`,
        [queued.id],
      )).toEqual(before);
      if (capture.eventId) {
        expect(await fixture.db.one<{ count: number }>(
          "select count(*)::int count from events where id=$1", [capture.eventId],
        )).toEqual({ count: 0 });
      }
    },
  );

  it("rejects orphan canonical handoff events and keeps protected text out of normalized rows", async () => {
    const fixture = await proposalFixture("authority");
    await expect(appendEvent(fixture.db, {
      aggregateId: `node-handoff:${fixture.nodeBrainId}`,
      accountId: fixture.accountId,
      actor: { type: "SYSTEM", id: "handoff-refresher" },
      type: "node.handoff.packet.refreshed",
      visibility: "PRIVATE_ACCOUNT",
      body: { forged: true },
      policyVersion: HANDOFF_POLICY_VERSION,
      idempotencyKey: `handoff:orphan:${fixture.accountId}`,
    })).rejects.toThrow("INCOMPLETE_HANDOFF_EVENT");
    const refreshed = await refreshHandoff({ db: fixture.db }, {
      accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      scope: "NODE_BRANCH",
      policyVersion: HANDOFF_POLICY_VERSION,
      nodeStateVersion: fixture.nodeStateVersion,
      mainStateVersion: fixture.mainStateVersion,
      throughEventId: fixture.proposal.createdEventId,
      idempotencyKey: `handoff:authority:${fixture.accountId}`,
    });
    if (refreshed.status !== "COMPLETED") throw new Error("HANDOFF_TEST_REFRESH_INCOMPLETE");
    const normalized = await fixture.db.one<{ document: string }>(
      `select concat_ws('|',packet::text,string_agg(idea::text,'|')) document
       from handoff_packets packet join handoff_packet_ideas idea on idea.packet_id=packet.id
       where packet.id=$1 group by packet.id`,
      [refreshed.packet.id],
    );
    expect(normalized.document).not.toContain("Secret authority");
    expect(normalized.document).not.toContain("Unrelated private detail authority");
    await expect(fixture.db.query("delete from handoff_packets where id=$1", [refreshed.packet.id]))
      .rejects.toThrow("IMMUTABLE_HANDOFF");
  });
});
