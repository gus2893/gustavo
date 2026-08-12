import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import { canonicalJson } from "../../lib/server/events/integrity";
import type { EventDatabase } from "../../lib/server/events/types";
import { cacheKey, cachePointerKey } from "../../lib/server/cache/keys";
import {
  MemoryCacheBackend,
  ScopedCache,
  ValkeyCacheBackend,
  projectionValueHash,
  type ValkeyTransport,
} from "../../lib/server/cache/store";
import { createPostgresCacheAccess } from "../../lib/server/cache/runtime";
import {
  createPostgresCacheJobRepository,
  synchronizeCanonicalCacheJobs,
} from "../../lib/server/cache/postgres";
import {
  archiveConversation,
  correctMemory,
  exportAccountData,
  inspectMemorySource,
  listAccountMemories,
  type AccountExportRecord,
  type PrivacyCapability,
} from "../../lib/server/memory/controls";
import {
  FORGET_PROJECTION_REGISTRY,
  forgetConversation,
  getForgetStatus,
  processForgetPropagation,
} from "../../lib/server/memory/forget";
import {
  createConversationFixture,
  seedProtectedConversation,
  type ProtectedConversationFixture,
} from "../helpers/postgres";
import {
  createThoughtWriterContext,
  recordDecisionThought,
} from "../../lib/server/thoughts/store";
import { importChatManifest } from "../../lib/server/chat-sources/import";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import {
  addProposalTurn,
  createDisclosureAuthorization,
  createProposal,
  transitionProposal,
} from "../../lib/server/orchestration/proposals";
import { processNextCacheJob } from "../../worker/cache/invalidate";
import {
  createMemoryWorkerContext,
  processMemoryEvent,
} from "../../worker/consolidation/process-event";

const exportRouteState = vi.hoisted(() => ({
  db: undefined as EventDatabase | undefined,
}));

vi.mock("../../lib/server/db/postgres", () => ({
  getDatabase(): EventDatabase {
    if (!exportRouteState.db) throw new Error("TEST_DATABASE_NOT_READY");
    return exportRouteState.db;
  },
}));

import { GET as getAccountExport } from "../../app/api/account/export/route";
import { appendMessage } from "../../lib/server/history/messages";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

afterEach(() => {
  exportRouteState.db = undefined;
  vi.unstubAllEnvs();
});

const ESTABLISHED_PROJECTION_RELATIONS = Object.freeze([
  "thought_records", "thought_claims", "thought_references", "recall_actor_authorities",
  "memory_extraction_runs", "memory_records", "memory_sources", "memory_semantic_facts",
  "memory_episodes", "memory_procedures", "memory_goals", "memory_embeddings",
  "memory_index_terms", "memory_equivalence_sets", "memory_equivalence_links",
  "memory_supersession_authorizations", "memory_retrieval_stats",
  "memory_projection_checkpoints", "memory_dossier_refreshes", "memory_vector_buckets",
  "memory_vector_backfill_checkpoints", "memory_graph_edges", "recall_traces",
  "recall_trace_plan_steps", "recall_trace_candidates", "recall_trace_sources",
  "recall_trace_context_entries", "chat_source_authorizations", "chat_sources",
  "chat_source_imports", "imported_chat_conversations",
  "imported_chat_conversation_versions", "imported_chat_message_versions",
  "chat_import_quarantine", "chat_source_cursors", "chat_import_conversation_occurrences",
  "chat_import_item_occurrences", "chat_import_quarantine_occurrences",
  "chat_source_event_manifests", "memory_graph_reconciliation_runs",
  "memory_graph_idempotency_keys", "memory_graph_entities", "memory_graph_entity_versions",
  "memory_graph_run_entities", "memory_graph_entity_aliases", "memory_graph_run_aliases",
  "memory_graph_alias_sources", "memory_graph_nodes", "memory_graph_run_candidates",
  "memory_graph_node_sources", "memory_graph_current_claims",
  "memory_graph_legacy_edge_backfills", "memory_graph_run_edges",
  "memory_graph_edge_sources", "memory_conflicts", "memory_graph_run_conflicts",
  "memory_conflict_sources", "memory_graph_background_jobs",
  "memory_graph_reconciliation_jobs", "memory_graph_reconciliation_job_idempotency_keys",
  "memory_graph_reconciliation_job_entities", "memory_graph_reconciliation_job_aliases",
  "memory_graph_reconciliation_job_sources", "memory_graph_reconciliation_job_source_sets",
  "memory_graph_reconciliation_job_candidates", "memory_graph_reconciliation_job_manifests",
  "memory_graph_reconciliation_job_transitions",
  "memory_graph_reconciliation_job_transition_manifests", "memory_graph_event_manifests",
  "memory_graph_head_versions", "memory_graph_background_job_transitions",
  "memory_graph_job_transition_manifests", "memory_graph_worker_authorities",
  "handoff_packets", "handoff_packet_keys",
  "handoff_packet_ideas", "handoff_packet_manifests", "handoff_refresh_checkpoints",
  "handoff_refresh_checkpoint_keys", "handoff_refresh_checkpoint_manifests",
  "handoff_key_registry", "handoff_refresh_jobs", "handoff_refresh_job_keys",
  "handoff_refresh_job_transitions", "handoff_refresh_job_manifests",
  "handoff_refresh_job_transition_manifests", "cache_projection_jobs",
  "cache_outbox_staging", "cache_outbox_backfill_state", "cache_authority_changes",
  "cache_authority_staging", "cache_main_state_sources", "cache_projection_versions",
  "cache_rebuild_runs", "cache_rebuild_category_checks", "cache_metric_observations",
  "import_manifests", "import_source_items", "import_memory_projections",
  "import_review_queue_entries", "import_lifecycle_commands",
  "import_lifecycle_idempotency_aliases", "import_item_lifecycle_events",
  "import_verification_receipts", "import_event_authorities",
  "proposal_disclosure_authorizations", "proposal_disclosure_revocations",
  "proposal_operation_idempotency", "proposals", "proposal_evidence_links",
  "proposal_status_transitions", "proposal_turns", "proposal_turn_evidence_links",
] as const);

function owner(
  fixture: ProtectedConversationFixture,
  capability: PrivacyCapability,
) {
  return {
    kind: "ACCOUNT_OWNER" as const,
    accountId: fixture.accountId,
    sessionId: fixture.sessionId,
    capability,
  };
}

function instrumentDatabase(database: EventDatabase) {
  const observed: string[] = [];
  const wrap = (delegate: EventDatabase): EventDatabase => ({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ) => {
      observed.push(sql);
      return delegate.query<Row>(sql, parameters);
    },
    one: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ) => {
      observed.push(sql);
      return delegate.one<Row>(sql, parameters);
    },
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      delegate.transaction((transaction) => work(wrap(transaction)))
    ),
  });
  return { db: wrap(database), observed };
}

function gatedDatabase(
  database: EventDatabase,
  marker: string,
  reached: () => void,
  release: Promise<void>,
): EventDatabase {
  const wrap = (delegate: EventDatabase): EventDatabase => ({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> => {
      const rows = await delegate.query<Row>(sql, parameters);
      if (sql.includes(marker)) {
        reached();
        await release;
      }
      return rows;
    },
    one: (sql, parameters) => delegate.one(sql, parameters),
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      delegate.transaction((transaction) => work(wrap(transaction)))
    ),
  });
  return wrap(database);
}

function signalingDatabase(
  database: EventDatabase,
  marker: string,
  signal: () => void,
): EventDatabase {
  const wrap = (delegate: EventDatabase): EventDatabase => ({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> => {
      if (sql.includes(marker)) signal();
      return delegate.query<Row>(sql, parameters);
    },
    one: (sql, parameters) => delegate.one(sql, parameters),
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      delegate.transaction((transaction) => work(wrap(transaction)))
    ),
  });
  return wrap(database);
}

function failingProjectionDatabase(database: EventDatabase): EventDatabase {
  const wrap = (delegate: EventDatabase): EventDatabase => ({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> => {
      if (sql.includes("select candidate.record_id")) {
        return Promise.reject(new Error("DISPOSABLE_PROJECTION_FAILURE"));
      }
      return delegate.query<Row>(sql, parameters);
    },
    one: (sql, parameters) => delegate.one(sql, parameters),
    transaction: <Result>(work: (transaction: EventDatabase) => Promise<Result>) => (
      delegate.transaction((transaction) => work(wrap(transaction)))
    ),
  });
  return wrap(database);
}

class PrivacyValkeyTransport implements ValkeyTransport {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: { readonly NX: true; readonly PXAT: number },
  ): Promise<string | null> {
    void options.PXAT;
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(
    _script: string,
    options: { readonly keys: readonly string[]; readonly arguments: readonly string[] },
  ): Promise<number> {
    const key = options.keys[0]!;
    if (options.arguments.length === 3) {
      this.values.set(key, options.arguments[0]!);
      return 1;
    }
    if (options.arguments.length === 1 && this.values.get(key) === options.arguments[0]) {
      this.values.delete(key);
      return 1;
    }
    return 0;
  }

  async scan(
    cursor: string,
    options: { readonly MATCH: string; readonly COUNT: number },
  ): Promise<{ readonly cursor: string; readonly keys: readonly string[] }> {
    void cursor;
    void options.COUNT;
    const prefix = options.MATCH.endsWith("*") ? options.MATCH.slice(0, -1) : options.MATCH;
    return { cursor: "0", keys: [...this.values.keys()].filter((key) => key.startsWith(prefix)) };
  }

  async del(keys: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.values.delete(key)) deleted += 1;
    return deleted;
  }
}

class GatedPrivacyValkeyTransport extends PrivacyValkeyTransport {
  constructor(
    readonly entered: () => void,
    readonly released: Promise<void>,
  ) {
    super();
  }

  override async set(
    key: string,
    value: string,
    options: { readonly NX: true; readonly PXAT: number },
  ): Promise<string | null> {
    if (key.startsWith("gustavo-cache:v1:lease:")) return super.set(key, value, options);
    this.entered();
    await this.released;
    return super.set(key, value, options);
  }
}

class GatedReadMemoryBackend extends MemoryCacheBackend {
  #target: string | null = null;
  #entered: (() => void) | null = null;
  #released: Promise<void> | null = null;

  gate(target: string, entered: () => void, released: Promise<void>): void {
    this.#target = target;
    this.#entered = entered;
    this.#released = released;
  }

  override async read(key: string): Promise<string | null> {
    const captured = await super.read(key);
    if (key === this.#target && this.#entered && this.#released) {
      this.#entered();
      await this.#released;
    }
    return captured;
  }
}

async function protectedDossierMaterial(
  fixture: ProtectedConversationFixture,
  suffix: string,
) {
  const routed = await appendEvent(fixture.db, {
    aggregateId: fixture.conversationId, accountId: fixture.accountId,
    actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId }, type: "node.reply.routed",
    visibility: "PRIVATE_ACCOUNT", policyVersion: "node-routing-v1",
    body: { mode: "NODE", sourceEventIds: [fixture.sourceEventId] },
    idempotencyKey: `privacy-cache-read-route:${suffix}`,
  });
  const source = await fixture.db.one<{ sequence: string }>(
    "select ingested_sequence::text sequence from events where id=$1", [routed.id],
  );
  const descriptor = {
    namespace: "node-dossier" as const, scope: "PRIVATE_ACCOUNT" as const,
    entityId: fixture.conversationId, identityId: fixture.accountId,
    topologyVersion: "single-main-node-v1", sourceHighWater: `e${source.sequence}`,
    stateVersion: routed.id, policyVersion: "node-routing-v1", schemaVersion: 1,
  };
  const value = {
    kind: "NODE_DOSSIER" as const, accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
    sourceEventIds: [routed.id], sourceHighWater: descriptor.sourceHighWater,
    mainStateVersion: "1",
    route: { classificationConfidence: 1, mode: "NODE", policyVersion: "node-routing-v1",
      reason: "MATERIAL_EVIDENCE", response: { authority: "NODE_BRAIN",
        canonical: false, label: "Node" }, sourceIds: [fixture.sourceEventId] },
    occurredAt: routed.occurredAt.toISOString(),
  };
  return { descriptor, value };
}

async function waitForForget(
  fixture: ProtectedConversationFixture,
  requestId: string,
): Promise<Awaited<ReturnType<typeof getForgetStatus>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await getForgetStatus(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"), requestId,
    });
    if (status.status === "COMPLETED" || status.status === "FAILED") return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("PRIVACY_WORKER_TIMEOUT");
}

async function completeForget(fixture: ProtectedConversationFixture, requestId: string) {
  let status = await getForgetStatus(fixture, {
    actor: owner(fixture, "FORGET_CONVERSATION"),
    requestId,
  });
  for (let attempt = 0; attempt < 20 && status.status !== "COMPLETED"; attempt += 1) {
    await processForgetPropagation(fixture, {
      workerId: "privacy-worker-test",
      maximumSteps: 8,
      leaseMilliseconds: 5_000,
    });
    status = await getForgetStatus(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      requestId,
    });
  }
  return status;
}

describe("memory privacy controls", () => {
  it("inspects sources, appends a correction, and archives reversibly without erasing memory", async () => {
    const fixture = await seedProtectedConversation("privacy-controls", "secret preference");
    const page = await listAccountMemories(fixture, {
      actor: owner(fixture, "INSPECT_MEMORY"),
      conversationId: fixture.conversationId,
      limit: 10,
    });
    expect(page.items.map(({ text }) => text)).toContain("secret preference");
    expect(page.items[0]?.sourceEventIds).toContain(fixture.sourceEventId);

    const inspected = await inspectMemorySource(fixture, {
      actor: owner(fixture, "INSPECT_MEMORY"),
      conversationId: fixture.conversationId,
      memoryId: fixture.memoryIds[0]!,
      sourceEventId: fixture.sourceEventId,
    });
    expect(inspected).toMatchObject({
      contentKind: "ORIGINAL_EVENT",
      sourceEventId: fixture.sourceEventId,
      text: "secret preference",
    });

    const corrected = await correctMemory(fixture, {
      actor: owner(fixture, "CORRECT_MEMORY"),
      conversationId: fixture.conversationId,
      memoryId: fixture.memoryIds[0]!,
      correctedText: "corrected preference",
      reason: "The account owner corrected an outdated preference.",
      idempotencyKey: "privacy-controls-correction",
    });
    expect(corrected.supersedesMemoryId).toBe(fixture.memoryIds[0]);
    expect(await correctMemory(fixture, {
      actor: owner(fixture, "CORRECT_MEMORY"),
      conversationId: fixture.conversationId,
      memoryId: fixture.memoryIds[0]!,
      correctedText: "corrected preference",
      reason: "The account owner corrected an outdated preference.",
      idempotencyKey: "privacy-controls-correction",
    })).toEqual(corrected);
    expect(await fixture.db.one<{ count: number }>(
      "select count(*)::int count from memory_records where supersedes_memory_id=$1",
      [fixture.memoryIds[0]],
    )).toEqual({ count: 1 });

    await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"),
      conversationId: fixture.conversationId,
      archived: true,
      idempotencyKey: "privacy-controls-archive",
    });
    expect((await listAccountMemories(fixture, {
      actor: owner(fixture, "INSPECT_MEMORY"),
      conversationId: fixture.conversationId,
      limit: 10,
    })).items).not.toHaveLength(0);
    await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"),
      conversationId: fixture.conversationId,
      archived: false,
      idempotencyKey: "privacy-controls-restore",
    });
    expect(await fixture.db.one<{ status: string }>(
      "select status from conversations where id=$1",
      [fixture.conversationId],
    )).toEqual({ status: "OPEN" });
  }, 30_000);

  it("holds one inspection transaction through list decryption and response construction", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-list-transaction", "list transaction secret",
    );
    let ciphertextLoaded!: () => void;
    const loaded = new Promise<void>((resolve) => { ciphertextLoaded = resolve; });
    let releaseInspection!: () => void;
    const released = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const inspecting = listAccountMemories({
      ...fixture,
      db: gatedDatabase(
        fixture.db,
        "select event_id::text,aggregate_id,data_key_id,ciphertext",
        ciphertextLoaded,
        released,
      ),
    }, {
      actor: owner(fixture, "INSPECT_MEMORY"),
      conversationId: fixture.conversationId,
      limit: 10,
    });
    await loaded;
    const forgetting = forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-during-list-inspection",
    });
    const beforeRelease = await Promise.race([
      forgetting.then(() => "forget-finished" as const),
      new Promise<"inspection-holds-lock">((resolve) => setTimeout(
        () => resolve("inspection-holds-lock"), 250,
      )),
    ]);
    releaseInspection();
    expect((await inspecting).items.map(({ text }) => text))
      .toContain("list transaction secret");
    await forgetting;
    expect(beforeRelease).toBe("inspection-holds-lock");
    await expect(listAccountMemories(fixture, {
      actor: owner(fixture, "INSPECT_MEMORY"),
      conversationId: fixture.conversationId,
    })).rejects.toThrow("CONTENT_FORGOTTEN");
  }, 30_000);

  it("holds one inspection transaction through source decryption and projection", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-source-transaction", "source transaction secret",
    );
    let ciphertextLoaded!: () => void;
    const loaded = new Promise<void>((resolve) => { ciphertextLoaded = resolve; });
    let releaseInspection!: () => void;
    const released = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const inspecting = inspectMemorySource({
      ...fixture,
      db: gatedDatabase(
        fixture.db,
        "select event_id::text,aggregate_id,data_key_id,ciphertext",
        ciphertextLoaded,
        released,
      ),
    }, {
      actor: owner(fixture, "INSPECT_MEMORY"),
      conversationId: fixture.conversationId,
      memoryId: fixture.memoryIds[0]!,
      sourceEventId: fixture.sourceEventId,
    });
    await loaded;
    const forgetting = forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-during-source-inspection",
    });
    const beforeRelease = await Promise.race([
      forgetting.then(() => "forget-finished" as const),
      new Promise<"inspection-holds-lock">((resolve) => setTimeout(
        () => resolve("inspection-holds-lock"), 250,
      )),
    ]);
    releaseInspection();
    expect(await inspecting).toMatchObject({ text: "source transaction secret" });
    await forgetting;
    expect(beforeRelease).toBe("inspection-holds-lock");
    await expect(inspectMemorySource(fixture, {
      actor: owner(fixture, "INSPECT_MEMORY"),
      conversationId: fixture.conversationId,
      memoryId: fixture.memoryIds[0]!,
      sourceEventId: fixture.sourceEventId,
    })).rejects.toThrow("CONTENT_FORGOTTEN");
  }, 30_000);

  it("inspects structured thought and proposal sources through bounded sanitized projections", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-structured-source", "structured source seed",
    );
    const source = await fixture.db.one<{ occurred_at: Date }>(
      "select occurred_at from events where id=$1", [fixture.sourceEventId],
    );
    const thoughtAt = new Date(source.occurred_at.getTime() + 10).toISOString();
    const thought = await recordDecisionThought(
      createThoughtWriterContext(fixture.db, { type: "NODE_BRAIN", id: fixture.nodeBrainId }),
      {
        aggregateId: fixture.conversationId, accountId: fixture.accountId,
        type: "NODE_REPLY_SUMMARY", scope: "PRIVATE_ACCOUNT",
        rationale: "Private decision rationale for the structured record.",
        claims: [{ text: "The owner-facing claim is safe to inspect.", confidence: "0.9" }],
        evidence: [{ kind: "EVENT", id: fixture.sourceEventId }], counterevidence: [],
        sourceEventIds: [fixture.sourceEventId], uncertainty: "LOW",
        stateReference: { kind: "NODE_STATE", id: fixture.nodeBrainId,
          version: fixture.sourceEventId },
        promptVersion: "privacy-inspection-thought-p1", modelVersion: "none",
        policyVersion: "thought-policy-v1", validFrom: thoughtAt, occurredAt: thoughtAt,
        idempotencyKey: "privacy-inspection-thought",
      },
    );
    const thoughtMemory = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      sourceEventId: thought.eventId,
      events: [{ id: thought.eventId, at: thought.createdAt, text: canonicalJson(
        await readEventBody(fixture.db, thought.eventId, {
          actor: { role: "ACCOUNT", accountId: fixture.accountId },
        }),
      ) }],
      extracted: { facts: [{ text: "The owner-facing claim is safe to inspect.",
        sourceIds: [thought.eventId] }] },
      versions: { promptVersion: "privacy-inspection-p1", modelVersion: "none",
        extractorVersion: "privacy-inspection-v1", embeddingVersion: "memory-embedding-v1" },
      observedAt: thought.createdAt, idempotencyKey: "privacy-inspection-thought-memory",
    });
    const proposalEvent = await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId, accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId }, type: "proposal.recorded",
      visibility: "PRIVATE_ACCOUNT", idempotencyKey: "privacy-inspection-proposal",
      body: { proposalId: randomUUID(), title: "Bounded proposal",
        summary: "A safe structured proposal summary.", sourceEventIds: [fixture.sourceEventId],
        hiddenChainOfThought: "never expose this field" },
    });
    const proposalMemory = await processMemoryEvent(createMemoryWorkerContext(fixture.db), {
      scope: "PRIVATE_ACCOUNT", accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      sourceEventId: proposalEvent.id,
      events: [{ id: proposalEvent.id, at: proposalEvent.occurredAt.toISOString(),
        text: canonicalJson(await readEventBody(fixture.db, proposalEvent.id, {
          actor: { role: "ACCOUNT", accountId: fixture.accountId },
        })) }],
      extracted: { facts: [{ text: "A safe structured proposal summary.",
        sourceIds: [proposalEvent.id] }] },
      versions: { promptVersion: "privacy-inspection-p1", modelVersion: "none",
        extractorVersion: "privacy-inspection-v1", embeddingVersion: "memory-embedding-v1" },
      observedAt: proposalEvent.occurredAt.toISOString(),
      idempotencyKey: "privacy-inspection-proposal-memory",
    });
    const thoughtInspection = await inspectMemorySource(fixture, {
      actor: owner(fixture, "INSPECT_MEMORY"), conversationId: fixture.conversationId,
      memoryId: thoughtMemory.memories[0]!.id, sourceEventId: thought.eventId,
    }) as unknown as { readonly data: unknown; readonly provenance: unknown };
    const proposalInspection = await inspectMemorySource(fixture, {
      actor: owner(fixture, "INSPECT_MEMORY"), conversationId: fixture.conversationId,
      memoryId: proposalMemory.memories[0]!.id, sourceEventId: proposalEvent.id,
    }) as unknown as { readonly data: unknown; readonly provenance: unknown };
    expect(thoughtInspection.data).toMatchObject({
      thoughtId: thought.id,
      claims: [{ text: "The owner-facing claim is safe to inspect.", confidence: "0.9" }],
    });
    expect(proposalInspection.data).toMatchObject({
      title: "Bounded proposal", summary: "A safe structured proposal summary.",
    });
    expect(JSON.stringify([thoughtInspection, proposalInspection])).not.toMatch(
      /private decision rationale|hiddenChainOfThought|never expose|requestDigest|erasureNonce/iu,
    );
    expect(thoughtInspection.provenance).toMatchObject({ sourceEventIds: [fixture.sourceEventId] });
  }, 30_000);

  it("cryptographically erases proposal private artifacts derived from forgotten conversations", async () => {
    const secret = "proposal cryptographic erasure secret";
    const fixture = await seedProtectedConversation("privacy-proposal-erasure", secret);
    const mainState = await fixture.db.one<{ version: string }>(
      `insert into main_state_versions(version,author_type,author_id,status)
       values ((select coalesce(max(version),0)+1 from main_state_versions),
               'MAIN_BRAIN','gustavo-main','COMMITTED') returning version::text`,
    );
    const routed = await routeNodeReply({
      db: fixture.db, accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId, userMessageEventId: fixture.sourceEventId,
      coveredByMain: false, contradiction: true, materialEvidence: true, confidence: 0.99,
      mainStateVersion: mainState.version, sourceIds: [fixture.sourceEventId],
    }, async () => undefined);
    const previousPseudonymKey = process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY;
    process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY = randomBytes(32).toString("base64");
    try {
      const disclosure = await createDisclosureAuthorization({ db: fixture.db }, {
        accountId: fixture.accountId, conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId], disclosedText: secret,
        privacyScope: "PROPOSAL_RAW_TEXT", purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "privacy-proposal-erasure-disclosure",
      });
      const proposal = await createProposal({ db: fixture.db }, {
        accountId: fixture.accountId, nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId, sourceEventIds: [fixture.sourceEventId],
        routeEventId: routed.routingEventId, affectedMainStateIds: [mainState.version],
        privacyScope: "PROPOSAL_RAW_TEXT", proposedChange: secret,
        evidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
        counterevidence: [], uncertainty: "No additional uncertainty.", rawPrivateText: secret,
        disclosureAuthorizationId: disclosure.id,
        idempotencyKey: "privacy-proposal-erasure-proposal",
      });
      await transitionProposal({ db: fixture.db }, {
        proposalId: proposal.id, actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "CLARIFICATION_REQUESTED", reason: "Clarify the private evidence.",
        idempotencyKey: "privacy-proposal-erasure-transition",
      });
      const turn = await addProposalTurn({ db: fixture.db }, {
        proposalId: proposal.id, accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId }, kind: "CLARIFICATION",
        text: secret, sourceEventIds: [fixture.sourceEventId],
        evidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
        idempotencyKey: "privacy-proposal-erasure-turn",
      });
      const privateEvent = await fixture.db.one<{ id: string }>(
        "select raw_private_text_event_id::text id from proposals where id=$1", [proposal.id],
      );
      expect(await fixture.db.query(
        "select aggregate_id from aggregate_data_keys where aggregate_id=any($1::text[]) order by aggregate_id",
        [[proposal.id, disclosure.id]],
      )).toHaveLength(2);
      const request = await forgetConversation(fixture, {
        actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
        conversationId: fixture.conversationId, idempotencyKey: "forget-proposal-artifacts",
      });
      expect(await completeForget(fixture, request.requestId)).toMatchObject({ status: "COMPLETED" });
      expect(await fixture.db.query(
        "select aggregate_id from aggregate_data_keys where aggregate_id=any($1::text[])",
        [[proposal.id, disclosure.id]],
      )).toEqual([]);
      for (const eventId of [disclosure.createdEventId, proposal.createdEventId,
        privateEvent.id, turn.eventId]) {
        await expect(readEventBody(fixture.db, eventId, {
          actor: { role: "ACCOUNT", accountId: fixture.accountId },
        })).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
      }
      const exported = await exportAccountData(fixture, {
        actor: owner(fixture, "EXPORT_DATA"), limit: 50,
      });
      expect(JSON.stringify(exported.records)).not.toContain(secret);
      expect(exported.records.some(({ aggregateId }) => (
        aggregateId === proposal.id || aggregateId === disclosure.id
      ))).toBe(false);
      const proposalRegistry = await fixture.db.query<{ relation_name: string }>(
        `select relation_name from privacy_projection_registry
         where relation_name ~ '^(proposals$|proposal_)' order by relation_name`,
      );
      expect(proposalRegistry.map(({ relation_name }) => relation_name)).toEqual(expect.arrayContaining([
        "proposals", "proposal_disclosure_authorizations", "proposal_evidence_links",
        "proposal_status_transitions", "proposal_turns", "proposal_turn_evidence_links",
      ]));
      expect(await fixture.db.one<{ deactivated: number }>(
        `select count(*)::int deactivated from privacy_projection_deactivations deactivation
         join privacy_projection_registry registry using (projection_type)
         where deactivation.request_id=$1 and registry.relation_name ~ '^(proposals$|proposal_)'`,
        [request.requestId],
      )).toMatchObject({ deactivated: expect.any(Number) });
    } finally {
      if (previousPseudonymKey === undefined) delete process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY;
      else process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY = previousPseudonymKey;
    }
  }, 30_000);

  it("rejects cross-account inspection before protected memory, key, body, or index access", async () => {
    const target = await seedProtectedConversation("privacy-target", "target secret");
    const attacker = await seedProtectedConversation("privacy-attacker", "attacker content", target.db);
    const instrumented = instrumentDatabase(target.db);
    await expect(inspectMemorySource({ ...target, db: instrumented.db }, {
      actor: owner(attacker, "INSPECT_MEMORY"),
      conversationId: target.conversationId,
      memoryId: target.memoryIds[0]!,
      sourceEventId: target.sourceEventId,
    })).rejects.toThrow("FORBIDDEN");
    expect(instrumented.observed.some((sql) => /memory_records|memory_sources|encrypted_event_bodies|aggregate_data_keys|ciphertext/iu.test(sql)))
      .toBe(false);
    instrumented.observed.length = 0;
    await expect(forgetConversation({ ...target, db: instrumented.db }, {
      actor: owner(attacker, "FORGET_CONVERSATION"),
      accountId: attacker.accountId,
      conversationId: target.conversationId,
      idempotencyKey: "cross-account-forget",
    })).rejects.toThrow("FORBIDDEN");
    expect(instrumented.observed.some((sql) => /memory_records|memory_sources|encrypted_event_bodies|aggregate_data_keys|ciphertext/iu.test(sql)))
      .toBe(false);
  }, 30_000);

  it("exports only bounded authorized source and derived data, never trade payloads, keys, or ciphertext", async () => {
    const fixture = await seedProtectedConversation("privacy-export", "exported secret");
    await seedProtectedConversation("privacy-export-other", "other account secret", fixture.db);
    const page = await exportAccountData(fixture, {
      actor: owner(fixture, "EXPORT_DATA"),
      limit: 2,
    });
    expect(page.manifest).toMatchObject({
      format: "gustavo-account-data-export-v1",
      accountId: fixture.accountId,
      snapshotId: expect.stringMatching(UUID_PATTERN),
      accountRecordCount: expect.any(Number),
    });
    expect(page.records.length).toBeLessThanOrEqual(2);
    const remaining = page.nextCursor === null ? [] : (await exportAccountData(fixture, {
      actor: owner(fixture, "EXPORT_DATA"),
      limit: 50,
      cursor: page.nextCursor,
    })).records;
    const serialized = JSON.stringify([...page.records, ...remaining]);
    expect(serialized).toContain("exported secret");
    expect(serialized).not.toContain("other account secret");
    expect(serialized).not.toMatch(/ciphertext|wrappedKey|dataKey|authTag|chain.of.thought/iu);
    expect([...page.records, ...remaining].every((record) => (
      !/order|trade|fill|position|execution/iu.test(record.type)
    ))).toBe(true);
  }, 30_000);

  it("keeps the latest archive command authoritative when an older idempotent command is replayed", async () => {
    const fixture = await seedProtectedConversation("privacy-archive-replay", "archive replay");
    const archived = await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"),
      conversationId: fixture.conversationId,
      archived: true,
      idempotencyKey: "archive-command-a",
    });
    expect(archived).toMatchObject({
      commandStatus: "ARCHIVED", currentStatus: "ARCHIVED",
      eventId: expect.stringMatching(UUID_PATTERN),
    });
    await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"),
      conversationId: fixture.conversationId,
      archived: false,
      idempotencyKey: "archive-command-b",
    });
    expect(await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"),
      conversationId: fixture.conversationId,
      archived: true,
      idempotencyKey: "archive-command-a",
    })).toMatchObject({
      commandStatus: "ARCHIVED", currentStatus: "OPEN", eventId: archived.eventId,
    });
    expect(await fixture.db.one<{ status: string }>(
      "select status from conversations where id=$1", [fixture.conversationId],
    )).toEqual({ status: "OPEN" });
  }, 30_000);

  it("allows a new archive after restore while an old command replay remains mutation-free", async () => {
    const fixture = await seedProtectedConversation("privacy-archive-cycle", "archive cycle");
    await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"), conversationId: fixture.conversationId,
      archived: true, idempotencyKey: "archive-cycle-a",
    });
    await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"), conversationId: fixture.conversationId,
      archived: false, idempotencyKey: "archive-cycle-b",
    });
    await expect(archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"), conversationId: fixture.conversationId,
      archived: true, idempotencyKey: "archive-cycle-c",
    })).resolves.toMatchObject({ status: "ARCHIVED" });
    const beforeReplay = await fixture.db.one<{ commands: number; events: number }>(
      `select
         (select count(*)::int from conversation_archive_commands
           where conversation_id=$1) commands,
         (select count(*)::int from events where aggregate_id=$1::text
           and type in ('conversation.archived','conversation.restored')) events`,
      [fixture.conversationId],
    );
    expect(beforeReplay).toEqual({ commands: 3, events: 3 });
    expect(await fixture.db.one<{ repeated_digests: number }>(
      `select count(*)::int repeated_digests from (
         select request_digest from conversation_archive_commands
         where conversation_id=$1 group by request_digest having count(*)>1
       ) repeated`,
      [fixture.conversationId],
    )).toEqual({ repeated_digests: 1 });
    await expect(archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"), conversationId: fixture.conversationId,
      archived: true, idempotencyKey: "archive-cycle-a",
    })).resolves.toMatchObject({ status: "ARCHIVED" });
    expect(await fixture.db.one<{ commands: number; events: number }>(
      `select
         (select count(*)::int from conversation_archive_commands
           where conversation_id=$1) commands,
         (select count(*)::int from events where aggregate_id=$1::text
           and type in ('conversation.archived','conversation.restored')) events`,
      [fixture.conversationId],
    )).toEqual(beforeReplay);
  }, 30_000);

  it("scopes archive idempotency keys to the owning account, conversation, and action", async () => {
    const first = await seedProtectedConversation("privacy-archive-scope-a", "first archive");
    const second = await seedProtectedConversation("privacy-archive-scope-b", "second archive", first.db);
    await expect(archiveConversation(first, {
      actor: owner(first, "ARCHIVE_CONVERSATION"), conversationId: first.conversationId,
      archived: true, idempotencyKey: "shared-user-key",
    })).resolves.toMatchObject({ status: "ARCHIVED" });
    await expect(archiveConversation(second, {
      actor: owner(second, "ARCHIVE_CONVERSATION"), conversationId: second.conversationId,
      archived: true, idempotencyKey: "shared-user-key",
    })).resolves.toMatchObject({ status: "ARCHIVED" });
  }, 30_000);

  it("scopes correction and forget idempotency keys to their tenant conversations", async () => {
    const first = await seedProtectedConversation("privacy-command-scope-a", "first command");
    const second = await seedProtectedConversation("privacy-command-scope-b", "second command", first.db);
    await expect(correctMemory(first, {
      actor: owner(first, "CORRECT_MEMORY"), conversationId: first.conversationId,
      memoryId: first.memoryIds[0]!, correctedText: "first corrected", reason: "first owner",
      idempotencyKey: "shared-correction-key",
    })).resolves.toMatchObject({ supersedesMemoryId: first.memoryIds[0] });
    await expect(correctMemory(second, {
      actor: owner(second, "CORRECT_MEMORY"), conversationId: second.conversationId,
      memoryId: second.memoryIds[0]!, correctedText: "second corrected", reason: "second owner",
      idempotencyKey: "shared-correction-key",
    })).resolves.toMatchObject({ supersedesMemoryId: second.memoryIds[0] });
    await expect(forgetConversation(first, {
      actor: owner(first, "FORGET_CONVERSATION"), accountId: first.accountId,
      conversationId: first.conversationId, idempotencyKey: "shared-forget-key",
    })).resolves.toMatchObject({ status: "PENDING" });
    await expect(forgetConversation(second, {
      actor: owner(second, "FORGET_CONVERSATION"), accountId: second.accountId,
      conversationId: second.conversationId, idempotencyKey: "shared-forget-key",
    })).resolves.toMatchObject({ status: "PENDING" });
  }, 30_000);

  it("exports authorized private thoughts and uses an account-scoped snapshot boundary", async () => {
    const fixture = await seedProtectedConversation("privacy-export-thought", "thought source");
    const source = await fixture.db.one<{ occurred_at: Date }>(
      "select occurred_at from events where id=$1", [fixture.sourceEventId],
    );
    const occurredAt = new Date(source.occurred_at.getTime() + 10).toISOString();
    await recordDecisionThought(
      createThoughtWriterContext(fixture.db, { type: "NODE_BRAIN", id: fixture.nodeBrainId }),
      {
        aggregateId: fixture.conversationId,
        accountId: fixture.accountId,
        type: "NODE_REPLY_SUMMARY",
        scope: "PRIVATE_ACCOUNT",
        rationale: "Private thought included in data portability.",
        claims: [{ text: "The private source informed this summary.", confidence: "0.8" }],
        evidence: [{ kind: "EVENT", id: fixture.sourceEventId }],
        counterevidence: [{ kind: "EVENT", id: fixture.sourceEventId }],
        sourceEventIds: [fixture.sourceEventId],
        stateReference: { kind: "NODE_STATE", id: fixture.nodeBrainId,
          version: fixture.sourceEventId },
        uncertainty: "MEDIUM",
        promptVersion: "privacy-export-thought-p1",
        modelVersion: "none",
        policyVersion: "thought-policy-v1",
        validFrom: occurredAt,
        occurredAt,
        idempotencyKey: "privacy-export-thought",
      },
    );
    await seedProtectedConversation("privacy-export-later-account", "later other account", fixture.db);
    const first = await exportAccountData(fixture, {
      actor: owner(fixture, "EXPORT_DATA"), limit: 50,
    });
    const records = [...first.records];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await exportAccountData(fixture, {
        actor: owner(fixture, "EXPORT_DATA"), cursor, limit: 50,
      });
      records.push(...page.records);
      cursor = page.nextCursor;
    }
    expect(first.manifest).toMatchObject({
      snapshotId: expect.stringMatching(UUID_PATTERN), accountRecordCount: records.length,
    });
    expect(JSON.stringify(records)).toContain("Private thought included in data portability.");
    expect(records.some(({ type }) => type === "thought.recorded")).toBe(true);
  }, 30_000);

  it("materializes an opaque stable export membership across precommit sequence inversion", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-export-snapshot-inversion", "snapshot inversion seed",
    );
    let releaseLate!: () => void;
    const lateRelease = new Promise<void>((resolve) => { releaseLate = resolve; });
    let lateInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { lateInserted = resolve; });
    const lateCommit = fixture.db.transaction(async (db) => {
      const event = await appendEvent(db, {
        aggregateId: `privacy-export-late:${randomUUID()}`, accountId: fixture.accountId,
        actor: { type: "USER", id: fixture.accountId },
        type: "privacy.snapshot.late_commit", visibility: "PRIVATE_ACCOUNT",
        body: { text: "late commit must be outside the snapshot" },
        idempotencyKey: "privacy-export-late-commit",
      });
      lateInserted();
      await lateRelease;
      return event;
    });
    await inserted;
    await appendEvent(fixture.db, {
      aggregateId: `privacy-export-visible:${randomUUID()}`, accountId: fixture.accountId,
      actor: { type: "USER", id: fixture.accountId },
      type: "privacy.snapshot.visible", visibility: "PRIVATE_ACCOUNT",
      body: { text: "visible commit must be in the snapshot" },
      idempotencyKey: "privacy-export-visible-commit",
    });
    let first: Awaited<ReturnType<typeof exportAccountData>>;
    try {
      first = await exportAccountData(fixture, {
        actor: owner(fixture, "EXPORT_DATA"), limit: 1,
      });
    } finally {
      releaseLate();
    }
    const lateEvent = await lateCommit;
    const records = [...first.records];
    let cursor = first.nextCursor;
    let pages = 0;
    while (cursor !== null) {
      const page = await exportAccountData(fixture, {
        actor: owner(fixture, "EXPORT_DATA"), limit: 10, cursor,
      });
      records.push(...page.records);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 100) throw new Error("EXPORT_TEST_PAGE_BOUND_EXCEEDED");
    }
    expect(records.map(({ type }) => type)).toContain("privacy.snapshot.visible");
    expect(records.map(({ type }) => type)).not.toContain("privacy.snapshot.late_commit");
    const manifest = first.manifest as unknown as Record<string, unknown>;
    expect(manifest).toMatchObject({
      snapshotId: expect.stringMatching(UUID_PATTERN),
      accountRecordCount: expect.any(Number),
    });
    expect(manifest).not.toHaveProperty("highWaterSequence");
    const lateSequence = await fixture.db.one<{ sequence: string }>(
      "select ingested_sequence::text sequence from events where id=$1", [lateEvent.id],
    );
    await expect(fixture.db.query(
      `insert into account_export_snapshot_records
         (snapshot_id,ordinal,event_id,source_sequence,tombstone)
       values ($1,$2,$3,$4,false)`,
      [manifest.snapshotId, Number(manifest.accountRecordCount) + 1,
        lateEvent.id, lateSequence.sequence],
    )).rejects.toThrow("ACCOUNT_EXPORT_SNAPSHOT_MEMBERSHIP_INVALID");
    await expect(fixture.db.query(
      "delete from account_export_snapshot_records where snapshot_id=$1 and ordinal=1",
      [manifest.snapshotId],
    )).rejects.toThrow("IMMUTABLE_PRIVACY_CONTROL_RECORD");
  }, 30_000);

  it("reuses bounded export snapshots and expires disposable cursor membership", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-export-snapshot-reuse", "stable reusable export source",
    );
    const pages: Awaited<ReturnType<typeof exportAccountData>>[] = [];
    for (let index = 0; index < 100; index += 1) {
      pages.push(await exportAccountData(fixture, {
        actor: owner(fixture, "EXPORT_DATA"), limit: 1,
      }));
    }
    const stableSnapshotId = pages[0]!.manifest.snapshotId;
    expect(new Set(pages.map(({ manifest }) => manifest.snapshotId))).toEqual(
      new Set([stableSnapshotId]),
    );
    expect(await fixture.db.one<{ roots: number; memberships: number }>(
      `select
         (select count(*)::int from account_export_snapshots where account_id=$1) roots,
         (select count(*)::int from account_export_snapshot_records record
          join account_export_snapshots snapshot on snapshot.id=record.snapshot_id
          where snapshot.account_id=$1) memberships`,
      [fixture.accountId],
    )).toMatchObject({ roots: 1, memberships: pages[0]!.manifest.accountRecordCount });
    const priorCursor = pages[0]!.nextCursor;
    expect(priorCursor).not.toBeNull();
    await appendEvent(fixture.db, {
      aggregateId: `privacy-export-change:${randomUUID()}`, accountId: fixture.accountId,
      actor: { type: "USER", id: fixture.accountId }, type: "privacy.export.changed",
      visibility: "PRIVATE_ACCOUNT", body: { text: "new portable account data" },
      idempotencyKey: "privacy-export-snapshot-change",
    });
    const changed = await exportAccountData(fixture, {
      actor: owner(fixture, "EXPORT_DATA"), limit: 1,
    });
    expect(changed.manifest.snapshotId).not.toBe(stableSnapshotId);
    await expect(exportAccountData(fixture, {
      actor: owner(fixture, "EXPORT_DATA"), limit: 1, cursor: priorCursor!,
    })).rejects.toThrow("EXPORT_SNAPSHOT_EXPIRED");
    expect(await fixture.db.one<{ active: number; old_members: number }>(
      `select
         (select count(*)::int from account_export_snapshots snapshot
          where snapshot.account_id=$1 and snapshot.expires_at>clock_timestamp()
            and not exists (select 1 from account_export_snapshot_retirements retirement
              where retirement.snapshot_id=snapshot.id)) active,
         (select count(*)::int from account_export_snapshot_records
          where snapshot_id=$2) old_members`,
      [fixture.accountId, stableSnapshotId],
    )).toEqual({ active: 1, old_members: 0 });

    const expiring = await seedProtectedConversation(
      "privacy-export-snapshot-expiry", "short lived export source", fixture.db,
    );
    const expiringContext = ({
      ...expiring, exportSnapshotLifetimeSeconds: 1,
    } as unknown) as Parameters<typeof exportAccountData>[0];
    const short = await exportAccountData(expiringContext, {
      actor: owner(expiring, "EXPORT_DATA"), limit: 1,
    });
    expect(short.nextCursor).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(exportAccountData(expiringContext, {
      actor: owner(expiring, "EXPORT_DATA"), limit: 1, cursor: short.nextCursor!,
    })).rejects.toThrow("EXPORT_SNAPSHOT_EXPIRED");
    const renewed = await exportAccountData(expiringContext, {
      actor: owner(expiring, "EXPORT_DATA"), limit: 1,
    });
    expect(renewed.manifest.snapshotId).not.toBe(short.manifest.snapshotId);
    expect(await fixture.db.one<{ members: number }>(
      "select count(*)::int members from account_export_snapshot_records where snapshot_id=$1",
      [short.manifest.snapshotId],
    )).toEqual({ members: 0 });
  }, 60_000);

  it("maps an expired export cursor to a private bounded Gone response", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-export-route-expired", "expired route cursor source",
    );
    const shortContext = ({
      ...fixture, exportSnapshotLifetimeSeconds: 1,
    } as unknown) as Parameters<typeof exportAccountData>[0];
    const first = await exportAccountData(shortContext, {
      actor: owner(fixture, "EXPORT_DATA"), limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    exportRouteState.db = fixture.db;
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GUSTAVO_APP_ORIGIN", "https://gustavo.lol");
    const response = await getAccountExport(new Request(
      `https://gustavo.lol/api/account/export?limit=1&cursor=${
        encodeURIComponent(first.nextCursor!)}`,
      { headers: { cookie: `gustavo-session=${fixture.sessionToken}`,
        origin: "https://gustavo.lol" } },
    ));
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "EXPORT_SNAPSHOT_EXPIRED" });
  }, 30_000);

  it("expires a multipage export snapshot when one of its conversations is forgotten", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-export-forget-between-pages", "forget between export pages",
    );
    const first = await exportAccountData(fixture, {
      actor: owner(fixture, "EXPORT_DATA"), limit: 1,
    });
    expect(first.nextCursor).not.toBeNull();

    await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-between-export-pages",
    });

    await expect(exportAccountData(fixture, {
      actor: owner(fixture, "EXPORT_DATA"), limit: 1, cursor: first.nextCursor!,
    })).rejects.toThrow("EXPORT_SNAPSHOT_EXPIRED");

    exportRouteState.db = fixture.db;
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("GUSTAVO_APP_ORIGIN", "https://gustavo.lol");
    const response = await getAccountExport(new Request(
      `https://gustavo.lol/api/account/export?limit=1&cursor=${
        encodeURIComponent(first.nextCursor!)}`,
      { headers: { cookie: `gustavo-session=${fixture.sessionToken}`,
        origin: "https://gustavo.lol" } },
    ));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "EXPORT_SNAPSHOT_EXPIRED" });
    expect(await fixture.db.one<{ retirement: number; members: number }>(
      `select
         (select count(*)::int from account_export_snapshot_retirements
          where snapshot_id=$1) retirement,
         (select count(*)::int from account_export_snapshot_records
          where snapshot_id=$1) members`,
      [first.manifest.snapshotId],
    )).toEqual({ retirement: 1, members: 0 });
  }, 30_000);

  it("exports all authorized privacy lifecycle events with portable provenance headers", async () => {
    const fixture = await seedProtectedConversation("privacy-export-provenance", "portable source");
    await correctMemory(fixture, {
      actor: owner(fixture, "CORRECT_MEMORY"), conversationId: fixture.conversationId,
      memoryId: fixture.memoryIds[0]!, correctedText: "portable corrected source",
      reason: "owner correction", idempotencyKey: "privacy-export-provenance-correction",
    });
    await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"), conversationId: fixture.conversationId,
      archived: true, idempotencyKey: "privacy-export-provenance-archive",
    });
    await archiveConversation(fixture, {
      actor: owner(fixture, "ARCHIVE_CONVERSATION"), conversationId: fixture.conversationId,
      archived: false, idempotencyKey: "privacy-export-provenance-restore",
    });
    const records: AccountExportRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await exportAccountData(fixture, {
        actor: owner(fixture, "EXPORT_DATA"), limit: 10, ...(cursor ? { cursor } : {}),
      });
      records.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(records.map(({ type }) => type)).toEqual(expect.arrayContaining([
      "memory.correction.appended", "conversation.archived", "conversation.restored",
    ]));
    expect(records.every((record) => (
      typeof record.eventId === "string"
      && typeof record.aggregateId === "string"
      && record.accountId === fixture.accountId
      && typeof record.visibility === "string"
      && typeof record.actorType === "string"
      && typeof record.actorId === "string"
      && typeof record.correlationId === "string"
      && "causationId" in record
      && "promptVersion" in record
      && "modelVersion" in record
      && "policyVersion" in record
      && typeof record.occurredAt === "string"
      && typeof record.provenance === "object"
    ))).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(
      /ciphertext|wrappedKey|dataKey|authTag|chain.of.thought/iu,
    );
  }, 30_000);
});

describe("cryptographic forgetting", () => {
  it("forgets a newly created empty conversation and permanently fences later content", async () => {
    const fixture = await createConversationFixture("privacy-forget-empty");
    expect(await fixture.db.one<{ keys: number }>(
      "select count(*)::int keys from aggregate_data_keys where aggregate_id=$1",
      [fixture.conversationId],
    )).toEqual({ keys: 0 });
    const actor = {
      kind: "ACCOUNT_OWNER" as const,
      accountId: fixture.accountId,
      sessionId: fixture.sessionId,
      capability: "FORGET_CONVERSATION" as const,
    };
    const request = await forgetConversation({ db: fixture.db }, {
      actor, accountId: fixture.accountId, conversationId: fixture.conversationId,
      idempotencyKey: "forget-empty-conversation",
    });
    expect(await fixture.db.one<{ barrier: number; status: string }>(
      `select
         (select count(*)::int from privacy_forget_barriers where conversation_id=$1) barrier,
         (select status from conversations where id=$1) status`,
      [fixture.conversationId],
    )).toEqual({ barrier: 1, status: "ARCHIVED" });
    await expect(forgetConversation({ db: fixture.db }, {
      actor, accountId: fixture.accountId, conversationId: fixture.conversationId,
      idempotencyKey: "forget-empty-conversation-retry",
    })).resolves.toEqual(request);
    await expect(appendMessage({
      db: fixture.db, accountId: fixture.accountId, conversationId: fixture.conversationId,
    }, {
      role: "USER", text: "must remain unavailable", idempotencyKey: "after-empty-forget",
    })).rejects.toThrow("FORGOTTEN_AGGREGATE_KEY_CANNOT_BE_RECREATED");
    await expect(archiveConversation({ db: fixture.db }, {
      actor: { ...actor, capability: "ARCHIVE_CONVERSATION" as const },
      conversationId: fixture.conversationId, archived: false,
      idempotencyKey: "restore-empty-forgotten-conversation",
    })).rejects.toThrow("CONTENT_FORGOTTEN");
  }, 30_000);

  it("makes content unavailable in the barrier transaction and idempotently queues propagation", async () => {
    const fixture = await seedProtectedConversation("privacy-forget", "forgotten secret");
    expect(await fixture.cache.find("forgotten secret")).not.toEqual([]);
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-primary",
    });
    expect(request.status).toBe("PENDING");
    expect(await fixture.keys.exists(fixture.dataKeyId)).toBe(false);
    expect(await fixture.cache.find("forgotten secret")).toEqual([]);
    await expect(readEventBody(fixture.db, fixture.sourceEventId, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    })).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
    await expect(listAccountMemories(fixture, {
      actor: owner(fixture, "INSPECT_MEMORY"),
      conversationId: fixture.conversationId,
    })).rejects.toThrow("CONTENT_FORGOTTEN");
    expect(await fixture.db.one<{
      barrier: number; keyed_bodies: number; vector_buckets: number; status: string;
    }>(
      `select
         (select count(*)::int from privacy_forget_barriers where conversation_id=$1) barrier,
         (select count(*)::int from encrypted_event_bodies body
           join events event on event.id=body.event_id
          where event.aggregate_id=$1::text and body.data_key_id is not null) keyed_bodies,
         (select count(*)::int from memory_vector_buckets where conversation_id=$1) vector_buckets,
         (select status from conversations where id=$1) status`,
      [fixture.conversationId],
    )).toEqual({ barrier: 1, keyed_bodies: 0, vector_buckets: 0, status: "ARCHIVED" });
    expect(await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-retry-alias",
    })).toEqual(request);
  }, 30_000);

  it("resumes propagation to deactivate every source-derived projection and retains a non-sensitive tombstone", async () => {
    const fixture = await seedProtectedConversation("privacy-propagation", "propagation secret");
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-propagation",
    });
    const status = await completeForget(fixture, request.requestId);
    expect(status).toMatchObject({ status: "COMPLETED", completedSteps: status.totalSteps });
    const projections = await fixture.db.one<{
      indexes: number; active_embeddings: number; active_edges: number;
      memories: number; graph: number; dossiers: number; handoffs: number;
    }>(
      `select
         (select count(*)::int from memory_index_terms term join memory_records memory
           on memory.id=term.memory_id where memory.conversation_id=$1) indexes,
         (select count(*)::int from memory_embeddings where conversation_id=$1 and active) active_embeddings,
         (select count(*)::int from memory_graph_edges where conversation_id=$1 and valid_to is null) active_edges,
         (select count(*)::int from privacy_projection_deactivations
           where request_id=$2 and projection_type='MEMORY_RECORD') memories,
         (select count(*)::int from privacy_projection_deactivations
           where request_id=$2 and projection_type='GRAPH_EDGE') graph,
         (select count(*)::int from privacy_projection_deactivations
           where request_id=$2 and projection_type='DOSSIER_REFRESH') dossiers,
         (select count(*)::int from privacy_projection_deactivations
           where request_id=$2 and projection_type='HANDOFF_PACKET') handoffs`,
      [fixture.conversationId, request.requestId],
    );
    expect(projections).toMatchObject({ indexes: 0, active_embeddings: 0, active_edges: 0 });
    expect(projections.memories).toBeGreaterThan(0);
    expect(projections.graph).toBeGreaterThan(0);
    expect(projections.dossiers).toBeGreaterThan(0);
    expect(projections.handoffs).toBeGreaterThanOrEqual(0);
    const tombstone = await fixture.db.one<{ type: string; body: string }>(
      `select audit.type,audit.metadata::text body from audit_events audit
       where audit.aggregate_id=$1 order by audit.created_at desc limit 1`,
      [fixture.conversationId],
    );
    expect(tombstone.type).toBe("content.forgotten");
    expect(tombstone.body).not.toContain("propagation secret");
    expect(tombstone.body).not.toMatch(/[a-f0-9]{64}/u);
    const immutableSource = await fixture.db.one<{ source_events: number; ciphertexts: number }>(
      `select (select count(*)::int from events where aggregate_id=$1::text) source_events,
              (select count(*)::int from encrypted_event_bodies body join events event
                on event.id=body.event_id where event.aggregate_id=$1::text) ciphertexts`,
      [fixture.conversationId],
    );
    expect(immutableSource.source_events).toBeGreaterThan(0);
    expect(immutableSource.ciphertexts).toBe(immutableSource.source_events);
  }, 30_000);

  it("registers every T18-T25 projection with explicit forget and rebuild behavior", async () => {
    const fixture = await seedProtectedConversation("privacy-registry", "registry secret");
    const rows = await fixture.db.query<{
      projection_type: string; forget_behavior: string; rebuild_behavior: string;
    }>(
      `select projection_type,forget_behavior,rebuild_behavior
       from privacy_projection_registry order by ordinal`,
    );
    expect(rows).toEqual(FORGET_PROJECTION_REGISTRY);
    expect(rows.length).toBeGreaterThanOrEqual(25);
    expect(rows.every(({ forget_behavior, rebuild_behavior }) => (
      ["FORGET", "RETAIN", "RETAIN_TOMBSTONE"].includes(forget_behavior)
      && ["REBUILD", "RETAIN", "RETAIN_TOMBSTONE"].includes(rebuild_behavior)
    ))).toBe(true);
    expect(await fixture.db.one<{ missing: number; relations: number }>(
      `select count(*) filter (where to_regclass(relation_name) is null)::int missing,
              count(distinct relation_name)::int relations
       from privacy_projection_registry`,
    )).toEqual({ missing: 0, relations: rows.length });
  }, 30_000);

  it("covers the migration-discovered T18-T25 projection inventory with executable handlers", async () => {
    const fixture = await seedProtectedConversation("privacy-schema-contract", "schema contract");
    const rows = await fixture.db.query<{
      relation_name: string; forget_behavior: string; rebuild_behavior: string;
    }>(
      `select relation_name,forget_behavior,rebuild_behavior
       from privacy_projection_registry order by relation_name`,
    );
    const byRelation = new Map(rows.map((row) => [row.relation_name, row]));
    expect(ESTABLISHED_PROJECTION_RELATIONS.filter((relation) => !byRelation.has(relation)))
      .toEqual([]);
    expect([...byRelation.values()].every((row) => (
      ["FORGET", "REBUILD", "RETAIN", "RETAIN_TOMBSTONE"].includes(row.forget_behavior)
      && ["REBUILD", "RETAIN", "RETAIN_TOMBSTONE"].includes(row.rebuild_behavior)
    ))).toBe(true);
  }, 30_000);

  it("derives the complete projection inventory from the live T18-T25 schema", async () => {
    const fixture = await seedProtectedConversation("privacy-live-schema-contract", "live schema");
    const missing = await fixture.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables established
       where established.table_schema=current_schema()
         and established.table_type='BASE TABLE'
         and established.table_name ~ '^(thought_|memory_|recall_|chat_|handoff_|cache_|import_|proposal_|proposals$)'
         and established.table_name not like 'privacy_%'
         and not exists (
           select 1 from privacy_projection_registry registry
           where registry.relation_name=established.table_name
         )
       order by table_name`,
    );
    expect(missing).toEqual([]);
    const registry = await fixture.db.query<{
      relation_name: string; forget_behavior: string; rebuild_behavior: string;
      forget_executor: string; rebuild_executor: string;
    }>(
      `select relation_name,forget_behavior,rebuild_behavior,forget_executor,rebuild_executor
       from privacy_projection_registry order by ordinal`,
    );
    expect(registry.every((entry) => (
      entry.forget_executor.length > 0 && entry.rebuild_executor.length > 0
    ))).toBe(true);
    expect(registry).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation_name: "chat_source_authorizations",
        forget_behavior: "RETAIN_TOMBSTONE" }),
      expect.objectContaining({ relation_name: "chat_sources",
        forget_behavior: "RETAIN_TOMBSTONE" }),
      expect.objectContaining({ relation_name: "recall_actor_authorities",
        forget_behavior: "RETAIN_TOMBSTONE" }),
      expect.objectContaining({ relation_name: "memory_graph_worker_authorities",
        forget_behavior: "RETAIN_TOMBSTONE" }),
    ]));
  }, 30_000);

  it("rejects arbitrary deactivation IDs for every registered projection behavior", async () => {
    const fixture = await seedProtectedConversation("privacy-typed-authority", "typed authority");
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "privacy-typed-authority",
    });
    const registry = await fixture.db.query<{
      projection_type: string; forget_behavior: string; rebuild_behavior: string;
    }>(
      `select projection_type,forget_behavior,rebuild_behavior
       from privacy_projection_registry order by ordinal`,
    );
    const accepted: string[] = [];
    for (const projection of registry) {
      try {
        await fixture.db.transaction(async (db) => {
          await db.query(
            `insert into privacy_projection_deactivations
               (request_id,projection_type,record_id)
             values ($1,$2,$3)`,
            [request.requestId, projection.projection_type, randomUUID()],
          );
        });
        accepted.push(projection.projection_type);
      } catch {
        // Exact typed authority rejects arbitrary identifiers before durable mutation.
      }
    }
    expect(accepted).toEqual([]);
  }, 30_000);

  it("rejects unrecognized projection types instead of silently accepting an unhandled step", async () => {
    const fixture = await seedProtectedConversation("privacy-unknown-projection", "unknown projection");
    await expect(fixture.db.query(
      `insert into privacy_projection_registry
         (projection_type,ordinal,relation_name,forget_behavior,rebuild_behavior)
       values ('UNKNOWN_PROJECTION',99,'events','FORGET','REBUILD')`,
    )).rejects.toThrow("PRIVACY_PROJECTION_HANDLER_UNKNOWN");
  }, 30_000);

  it("maps chat imports through imported conversation identity, never aggregate-id coincidence", async () => {
    const fixture = await seedProtectedConversation("privacy-chat-import-db", "database anchor");
    const accountId = randomUUID();
    const nodeBrainId = randomUUID();
    const sessionId = randomUUID();
    await fixture.db.transaction(async (db) => {
      await db.query("insert into accounts (id,display_name) values ($1,'Chat privacy')", [accountId]);
      await db.query(
        `insert into entitlements (id,account_id,active_from)
         values ($1,$2,clock_timestamp()-interval '1 minute')`,
        [randomUUID(), accountId],
      );
      await db.query(
        "insert into node_brains (id,account_id,name) values ($1,$2,'Chat privacy node')",
        [nodeBrainId, accountId],
      );
      await db.query(
        `insert into sessions (id,account_id,token_hash,created_at,expires_at,last_rotated_at)
         values ($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp())`,
        [sessionId, accountId, "a".repeat(64)],
      );
    });
    await fixture.db.query(
      `insert into chat_source_authorizations (
         id,account_id,node_brain_id,source,external_source_id,granted_by_account_id,granted_at
       ) values ('privacy-chat-auth',$1,$2,'CHATGPT_EXPORT','privacy-chat-source',$1,
         clock_timestamp()-interval '1 minute')`,
      [accountId, nodeBrainId],
    );
    const imported = await importChatManifest({
      db: fixture.db, requesterAccountId: accountId,
    }, {
      source: "CHATGPT_EXPORT", formatVersion: "chatgpt-export-v1",
      exportedAt: new Date().toISOString(), cursor: "privacy-chat-cursor",
      ownerAuthorizationId: "privacy-chat-auth", sourceId: "privacy-chat-source",
      conversations: [{ id: "privacy-imported-conversation", participants: [
        { id: "owner", role: "USER" }, { id: "assistant", role: "ASSISTANT" },
      ], messages: [{ id: "privacy-imported-message", at: new Date().toISOString(),
        role: "USER", participantId: "owner", text: "independent imported evidence" }] }],
      conversationCount: 1, messageCount: 1,
    });
    // UUIDs from separate aggregate domains can coincide. The native conversation
    // must not inherit every import owned by a chat source with the same identifier.
    await fixture.db.query(
      `insert into conversations (id,account_id,node_brain_id,created_at)
       values ($1,$2,$3,clock_timestamp())`,
      [imported.chatSourceId, accountId, nodeBrainId],
    );
    const context = { db: fixture.db, cache: { purgeConversation: async () => undefined } };
    const request = await forgetConversation(context, {
      actor: { kind: "ACCOUNT_OWNER", accountId,
        sessionId, capability: "FORGET_CONVERSATION" },
      accountId, conversationId: imported.chatSourceId,
      idempotencyKey: "privacy-chat-topology-forget",
    });
    for (let pass = 0; pass < 4; pass += 1) {
      await processForgetPropagation(context, {
        workerId: "privacy-worker-test", maximumSteps: 50, leaseMilliseconds: 5_000,
      });
    }
    expect(await fixture.db.one<{ count: number }>(
      `select count(*)::int count from privacy_projection_deactivations
       where request_id=$1 and projection_type='CHAT_IMPORT'`,
      [request.requestId],
    )).toEqual({ count: 0 });
  }, 30_000);

  it("runs a provisioned production propagation loop through durable completion", async () => {
    const fixture = await seedProtectedConversation("privacy-production-worker", "worker secret");
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "production-worker-forget",
    });
    const module = await import("../../lib/server/memory/forget");
    const start = (module as unknown as {
      startForgetPropagationWorker?: (input: {
        readonly db: EventDatabase;
        readonly cache: ProtectedConversationFixture["cache"];
        readonly workerId: string;
        readonly pollIntervalMs: number;
        readonly leaseMilliseconds: number;
        readonly maximumSteps: number;
      }) => { readonly done: Promise<void>; stop(): Promise<void> };
    }).startForgetPropagationWorker;
    expect(typeof start).toBe("function");
    const worker = start!({
      db: fixture.db, cache: fixture.cache, workerId: "privacy-forget-production",
      pollIntervalMs: 10, leaseMilliseconds: 5_000, maximumSteps: 8,
    });
    try {
      expect(await waitForForget(fixture, request.requestId)).toMatchObject({ status: "COMPLETED" });
    } finally {
      await worker.stop();
      await worker.done;
    }
  }, 30_000);

  it("purges exact conversation Valkey pointer/version/negative/local entries and preserves peers", async () => {
    const accountId = randomUUID();
    const nodeBrainId = randomUUID();
    const forgottenConversationId = randomUUID();
    const retainedConversationId = randomUUID();
    const forgottenSourceId = randomUUID();
    const retainedSourceId = randomUUID();
    const transport = new PrivacyValkeyTransport();
    const backend = new ValkeyCacheBackend(transport);
    const cache = new ScopedCache({ backend, encryptionKey: randomBytes(32),
      authorize: () => true, processLruEntries: 8, random: () => 0.5 });
    const descriptor = (conversationId: string, sourceId: string) => ({
      namespace: "node-dossier" as const, scope: "PRIVATE_ACCOUNT" as const,
      entityId: conversationId, identityId: accountId, sourceHighWater: `e${Date.now()}`,
      stateVersion: sourceId, policyVersion: "node-routing-v1", schemaVersion: 1,
    });
    const forgotten = descriptor(forgottenConversationId, forgottenSourceId);
    const retained = descriptor(retainedConversationId, retainedSourceId);
    const value = (conversationId: string, sourceId: string, sourceHighWater: string) => ({
      kind: "NODE_DOSSIER" as const, accountId, nodeBrainId, conversationId,
      sourceEventIds: [sourceId], sourceHighWater,
      mainStateVersion: "1", route: { classificationConfidence: 1, mode: "NODE",
        policyVersion: "node-routing-v1", reason: "MATERIAL_EVIDENCE",
        response: { authority: "NODE_BRAIN", canonical: false, label: "Node" },
        sourceIds: [sourceId] }, occurredAt: new Date().toISOString(),
    });
    await cache.publish({ pointerKey: cachePointerKey(forgotten), versionKey: cacheKey(forgotten),
      versionOrdinal: "1", value: value(
        forgottenConversationId, forgottenSourceId, forgotten.sourceHighWater,
      ),
      options: { ttlSeconds: 60, encrypted: true } });
    await cache.publish({ pointerKey: cachePointerKey(retained), versionKey: cacheKey(retained),
      versionOrdinal: "1", value: value(
        retainedConversationId, retainedSourceId, retained.sourceHighWater,
      ),
      options: { ttlSeconds: 60, encrypted: true } });
    const localKey = (conversationId: string) => cacheKey({
      namespace: "context", scope: "PRIVATE_ACCOUNT", entityId: conversationId,
      identityId: accountId, sourceHighWater: "e1", stateVersion: "negative",
      policyVersion: "recall-v1", schemaVersion: 1,
    });
    await cache.set(localKey(forgottenConversationId), null, {
      ttlSeconds: 10, encrypted: true, negative: true, alreadyAuthorized: true,
    });
    await cache.set(localKey(retainedConversationId), null, {
      ttlSeconds: 10, encrypted: true, negative: true, alreadyAuthorized: true,
    });
    expect(cache.localSize()).toBe(2);
    const purge = (cache as unknown as { purgeConversation?: (input: {
      readonly accountId: string; readonly nodeBrainId: string; readonly conversationId: string;
    }) => Promise<{ readonly deleted: number }> }).purgeConversation;
    expect(typeof purge).toBe("function");
    await purge!.call(cache, { accountId, nodeBrainId, conversationId: forgottenConversationId });
    expect(await backend.read(cachePointerKey(forgotten))).toBeNull();
    expect(await backend.read(cacheKey(forgotten))).toBeNull();
    expect(await backend.read(localKey(forgottenConversationId))).toBeNull();
    expect(cache.localSize()).toBe(1);
    expect(await backend.read(cachePointerKey(retained))).not.toBeNull();
    expect(await backend.read(cacheKey(retained))).not.toBeNull();
    expect(await backend.read(localKey(retainedConversationId))).not.toBeNull();
  }, 30_000);

  it("purges decrypted values from every already-created runtime reader", async () => {
    const accountId = randomUUID();
    const nodeBrainId = randomUUID();
    const conversationId = randomUUID();
    const sourceId = randomUUID();
    const rows = [{ authorized: true }] as unknown as readonly Record<string, unknown>[];
    let database!: EventDatabase;
    database = {
      query: async <Row extends Record<string, unknown>>() => rows as readonly Row[] as Row[],
      one: async <Row extends Record<string, unknown>>() => rows[0] as Row,
      transaction: <Result>(work: (db: EventDatabase) => Promise<Result>) => work(database),
    };
    const backend = new MemoryCacheBackend();
    const access = createPostgresCacheAccess({
      db: database, backend, encryptionKey: randomBytes(32),
    });
    const descriptor = (ordinal: number) => ({
      namespace: "node-dossier" as const, scope: "PRIVATE_ACCOUNT" as const,
      entityId: conversationId, identityId: accountId, sourceHighWater: `e${ordinal}`,
      stateVersion: sourceId, policyVersion: "node-routing-v1", schemaVersion: 1,
    });
    const value = (sourceHighWater: string) => ({
      kind: "NODE_DOSSIER" as const, accountId, nodeBrainId, conversationId,
      sourceEventIds: [sourceId], sourceHighWater, mainStateVersion: "1",
      route: { classificationConfidence: 1, mode: "NODE", policyVersion: "node-routing-v1",
        reason: "MATERIAL_EVIDENCE", response: { authority: "NODE_BRAIN",
          canonical: false, label: "Node" }, sourceIds: [sourceId] },
      occurredAt: new Date().toISOString(),
    });
    const first = access.readerFor({ accountId, nodeBrainId, conversationId });
    const second = access.readerFor({ accountId, nodeBrainId, conversationId });
    const firstKey = cacheKey(descriptor(1));
    const secondKey = cacheKey(descriptor(2));
    expect(await first.readThrough(firstKey, { maxRows: 1, ttlSeconds: 60, encrypted: true,
      load: async () => ({ value: value("e1"), rowsRead: 1 }) }))
      .toMatchObject({ conversationId });
    expect(await second.readThrough(secondKey, { maxRows: 1, ttlSeconds: 60, encrypted: true,
      load: async () => ({ value: value("e2"), rowsRead: 1 }) }))
      .toMatchObject({ conversationId });
    expect(await first.get(firstKey)).toMatchObject({ conversationId });
    expect(await second.get(secondKey)).toMatchObject({ conversationId });
    await access.purgeConversation({ accountId, nodeBrainId, conversationId });
    expect(await first.get(firstKey)).toBeNull();
    expect(await second.get(secondKey)).toBeNull();
    access.destroy();
  }, 30_000);

  it("bounds the runtime reader registry through deterministic disposal and pruning", async () => {
    const accountId = randomUUID();
    const nodeBrainId = randomUUID();
    const conversationId = randomUUID();
    let database!: EventDatabase;
    database = {
      query: async <Row extends Record<string, unknown>>() => [] as Row[],
      one: async <Row extends Record<string, unknown>>() => ({}) as Row,
      transaction: <Result>(work: (db: EventDatabase) => Promise<Result>) => work(database),
    };
    const access = createPostgresCacheAccess({
      db: database, backend: new MemoryCacheBackend(), encryptionKey: randomBytes(32),
    });
    const registry = access as unknown as {
      pruneReaderRegistry?: () => number;
    };
    const readers = Array.from({ length: 500 }, () => access.readerFor({
      accountId, nodeBrainId, conversationId,
    }) as unknown as { dispose?: () => void });
    expect(registry.pruneReaderRegistry).toBeTypeOf("function");
    expect(readers.every(({ dispose }) => typeof dispose === "function")).toBe(true);
    for (const reader of readers) reader.dispose?.();
    expect(registry.pruneReaderRegistry?.()).toBe(0);
    const retained = access.readerFor({ accountId, nodeBrainId, conversationId }) as unknown as {
      dispose?: () => void;
    };
    expect(registry.pruneReaderRegistry?.()).toBe(1);
    retained.dispose?.();
    expect(registry.pruneReaderRegistry?.()).toBe(0);
    access.destroy();
  });

  it("bounds revoked runtime privacy scopes after completed purges", async () => {
    let database!: EventDatabase;
    database = {
      query: async <Row extends Record<string, unknown>>() => [] as Row[],
      one: async <Row extends Record<string, unknown>>() => ({}) as Row,
      transaction: <Result>(work: (db: EventDatabase) => Promise<Result>) => work(database),
    };
    const access = createPostgresCacheAccess({
      db: database, backend: new MemoryCacheBackend(), encryptionKey: randomBytes(32),
    });
    const accountId = randomUUID();
    const nodeBrainId = randomUUID();
    for (let index = 0; index < 500; index += 1) {
      await access.purgeConversation({ accountId, nodeBrainId, conversationId: randomUUID() });
    }
    const lifecycle = access as unknown as { revokedScopeCount?: () => number };
    expect(lifecycle.revokedScopeCount).toBeTypeOf("function");
    expect(lifecycle.revokedScopeCount?.()).toBe(0);
    access.destroy();
  }, 30_000);

  it("cancels pending and leased cache jobs at the barrier while unrelated jobs remain claimable", async () => {
    const target = await seedProtectedConversation("privacy-cache-job-target", "target cache job");
    const unrelated = await seedProtectedConversation(
      "privacy-cache-job-unrelated", "unrelated cache job", target.db,
    );
    await synchronizeCanonicalCacheJobs(target.db, { limit: 10_000 });
    await target.db.query(
      `update cache_projection_jobs set status='COMPLETED',completed_at=clock_timestamp(),
         worker_id=null,lease_token=null,lease_until=null
       where status in ('PENDING','RETRY_SCHEDULED','CLAIMED')`,
    );
    const route = (fixture: ProtectedConversationFixture, suffix: string) => appendEvent(
      fixture.db,
      {
        aggregateId: fixture.conversationId, accountId: fixture.accountId,
        actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId }, type: "node.reply.routed",
        visibility: "PRIVATE_ACCOUNT", body: { mode: "NODE", sourceEventIds: [] },
        policyVersion: "node-routing-v1", idempotencyKey: `privacy-cache-job:${suffix}`,
      },
    );
    const leasedEvent = await route(target, "leased");
    const pendingEvent = await route(target, "pending");
    const unrelatedEvent = await route(unrelated, "unrelated");
    await synchronizeCanonicalCacheJobs(target.db, { limit: 10_000 });
    await target.db.query(
      `update cache_projection_jobs set available_at=case event_id
         when $1 then clock_timestamp()-interval '3 minutes'
         when $2 then clock_timestamp()-interval '2 minutes'
         else clock_timestamp()-interval '1 minute' end
       where event_id=any($3::uuid[])`,
      [leasedEvent.id, pendingEvent.id, [leasedEvent.id, pendingEvent.id, unrelatedEvent.id]],
    );
    const repository = createPostgresCacheJobRepository(target.db, {
      categories: ["NODE_DOSSIERS"],
    });
    const leased = await repository.claim("cache-privacy-test", 5_000);
    expect(leased?.message.eventId).toBe(leasedEvent.id);
    await forgetConversation(target, {
      actor: owner(target, "FORGET_CONVERSATION"), accountId: target.accountId,
      conversationId: target.conversationId, idempotencyKey: "privacy-cache-job-forget",
    });
    expect(await target.db.query<{ event_id: string; status: string; error_code: string }>(
      `select event_id::text,status,error_code from cache_projection_jobs
       where event_id=any($1::uuid[]) order by event_id`,
      [[leasedEvent.id, pendingEvent.id]],
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: leasedEvent.id, status: "FAILED",
        error_code: "PRIVACY_FORGET_BARRIER" }),
      expect.objectContaining({ event_id: pendingEvent.id, status: "FAILED",
        error_code: "PRIVACY_FORGET_BARRIER" }),
    ]));
    await expect(repository.complete(leased!)).rejects.toThrow();
    expect((await repository.claim("cache-privacy-test", 5_000))?.message.eventId)
      .toBe(unrelatedEvent.id);
  }, 30_000);

  it("serializes cache publication with forgetting and preserves unrelated publication", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-cache-publication-fence", "publication fence secret",
    );
    const unrelatedFixture = await createConversationFixture(
      "privacy-cache-publication-unrelated", fixture.db,
    );
    await synchronizeCanonicalCacheJobs(fixture.db, { limit: 10_000 });
    await fixture.db.query(
      `update cache_projection_jobs set status='COMPLETED',completed_at=clock_timestamp(),
         worker_id=null,lease_token=null,lease_until=null
       where status in ('PENDING','RETRY_SCHEDULED','CLAIMED')`,
    );
    const trigger = await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId, accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId }, type: "node.reply.routed",
      visibility: "PRIVATE_ACCOUNT", policyVersion: "node-routing-v1",
      body: { mode: "NODE", sourceEventIds: [fixture.sourceEventId] },
      idempotencyKey: "privacy-cache-publication-fence",
    });
    await synchronizeCanonicalCacheJobs(fixture.db, { limit: 10_000 });
    await fixture.db.query(
      "update cache_projection_jobs set available_at=clock_timestamp()-interval '1 minute' where event_id=$1",
      [trigger.id],
    );
    const repository = createPostgresCacheJobRepository(fixture.db, {
      categories: ["NODE_DOSSIERS"],
    });
    const backend = new MemoryCacheBackend();
    const access = createPostgresCacheAccess({
      db: fixture.db, backend, encryptionKey: randomBytes(32),
    });
    const descriptor = {
      namespace: "node-dossier" as const, scope: "PRIVATE_ACCOUNT" as const,
      entityId: fixture.conversationId, identityId: fixture.accountId,
      topologyVersion: "single-main-node-v1", sourceHighWater: "1",
      stateVersion: trigger.id, policyVersion: "node-routing-v1", schemaVersion: 1,
    };
    const value = {
      kind: "NODE_DOSSIER" as const, accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
      sourceEventIds: [trigger.id], sourceHighWater: "1", mainStateVersion: "1",
      route: { classificationConfidence: 1, mode: "NODE", policyVersion: "node-routing-v1",
        reason: "MATERIAL_EVIDENCE", response: { authority: "NODE_BRAIN",
          canonical: false, label: "Node" }, sourceIds: [fixture.sourceEventId] },
      occurredAt: trigger.occurredAt.toISOString(),
    };
    let publishEntered!: () => void;
    const entered = new Promise<void>((resolve) => { publishEntered = resolve; });
    let releasePublish!: () => void;
    const released = new Promise<void>((resolve) => { releasePublish = resolve; });
    const gatedPublisher = {
      ...access.publisher,
      publish: async (input: Parameters<typeof access.publisher.publish>[0]) => {
        publishEntered();
        await released;
        return access.publisher.publish(input);
      },
    } as typeof access.publisher;
    const processing = processNextCacheJob({
      repository,
      source: { loadChange: async () => ({
        action: "PREWARM" as const, triggerEventId: trigger.id,
        recordSourceEventId: trigger.id, sourceTopic: "node.reply.routed",
        record: { id: randomUUID(), key: descriptor, versionOrdinal: "1", value,
          sourceRowCount: 1, contentHash: projectionValueHash(value) },
      }) },
      cache: gatedPublisher, workerId: "privacy-cache-publication", leaseMs: 20_000,
      maxAttempts: 1,
    });
    await entered;
    const forgetting = forgetConversation({ db: fixture.db, cache: access }, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "forget-cache-publication",
    });
    const fenceState = await Promise.race([
      forgetting.then(() => "forget-finished" as const),
      new Promise<"publisher-draining">((resolve) => setTimeout(
        () => resolve("publisher-draining"), 250,
      )),
    ]);
    releasePublish();
    const processingResult = await processing;
    await forgetting;
    expect(await backend.read(cachePointerKey(descriptor))).toBeNull();
    expect(await backend.read(cacheKey(descriptor))).toBeNull();
    expect(fenceState).toBe("publisher-draining");
    expect(processingResult).toBe("COMPLETED");
    const unrelated = { ...descriptor, entityId: unrelatedFixture.conversationId,
      identityId: unrelatedFixture.accountId, sourceHighWater: "2",
      stateVersion: randomUUID() };
    const unrelatedValue = { ...value, accountId: unrelatedFixture.accountId,
      nodeBrainId: unrelatedFixture.nodeBrainId, conversationId: unrelated.entityId,
      sourceHighWater: unrelated.sourceHighWater };
    await access.publisher.publish({
      pointerKey: cachePointerKey(unrelated), versionKey: cacheKey(unrelated),
      versionOrdinal: "2", value: unrelatedValue,
      options: { ttlSeconds: 60, encrypted: true },
    });
    expect(await backend.read(cachePointerKey(unrelated))).not.toBeNull();
    access.destroy();
  }, 30_000);

  it("recursively drains detached protected cache descendants before releasing the fence", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-cache-detached-descendant", "detached descendant secret",
    );
    let backendEntered!: () => void;
    const entered = new Promise<void>((resolve) => { backendEntered = resolve; });
    let releaseBackend!: () => void;
    const released = new Promise<void>((resolve) => { releaseBackend = resolve; });
    const transport = new GatedPrivacyValkeyTransport(backendEntered, released);
    const backend = new ValkeyCacheBackend(transport);
    const encryptionKey = randomBytes(32);
    const first = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const second = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const { descriptor, value } = await protectedDossierMaterial(fixture, "detached");
    let detached!: Promise<"STORED" | "STALE_IGNORED">;
    const outer = first.publisher.withPublicationGuard(
      cachePointerKey(descriptor),
      async () => {
        detached = first.publisher.publish({
          pointerKey: cachePointerKey(descriptor),
          versionKey: cacheKey(descriptor),
          versionOrdinal: "1",
          value,
          options: { ttlSeconds: 60, encrypted: true },
        });
        void detached.catch(() => undefined);
      },
    );
    await entered;
    const forgetting = forgetConversation({ db: fixture.db, cache: second }, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-detached-cache-descendant",
    });
    const beforeRelease = await Promise.race([
      forgetting.then(() => "forget-finished" as const),
      new Promise<"descendant-holds-fence">((resolve) => setTimeout(
        () => resolve("descendant-holds-fence"), 250,
      )),
    ]);
    releaseBackend();
    await outer;
    await detached;
    await forgetting;
    expect(beforeRelease).toBe("descendant-holds-fence");
    expect(await backend.read(cachePointerKey(descriptor))).toBeNull();
    expect(await backend.read(cacheKey(descriptor))).toBeNull();
    expect(transport.values.has(cachePointerKey(descriptor))).toBe(false);
    expect(transport.values.has(cacheKey(descriptor))).toBe(false);
    first.destroy();
    second.destroy();
  }, 30_000);

  it("drains an unawaited protected child read before its outer cache lease resolves", async () => {
    const backend = new GatedReadMemoryBackend();
    const accountId = randomUUID();
    const nodeBrainId = randomUUID();
    const conversationId = randomUUID();
    const sourceEventId = randomUUID();
    const descriptor = {
      namespace: "node-dossier" as const, scope: "PRIVATE_ACCOUNT" as const,
      entityId: conversationId, identityId: accountId,
      topologyVersion: "single-main-node-v1", sourceHighWater: "e1",
      stateVersion: randomUUID(), policyVersion: "node-routing-v1", schemaVersion: 1,
    };
    const key = cacheKey(descriptor);
    const value = {
      kind: "NODE_DOSSIER" as const, accountId, nodeBrainId, conversationId,
      sourceEventIds: [sourceEventId], sourceHighWater: "e1", mainStateVersion: "1",
      route: { classificationConfidence: 1, mode: "NODE", policyVersion: "node-routing-v1",
        reason: "MATERIAL_EVIDENCE", response: { authority: "NODE_BRAIN",
          canonical: false, label: "Node" }, sourceIds: [sourceEventId] },
      occurredAt: new Date().toISOString(),
    };
    const cache = new ScopedCache({
      backend,
      encryptionKey: randomBytes(32),
      authorize: () => true,
      protectedPublicationGuard: (_descriptor, work) => work(Object.freeze({})),
      requireProtectedPublicationGuard: true,
    });
    await cache.set(key, value, { ttlSeconds: 60, encrypted: true });
    let readEntered!: () => void;
    const entered = new Promise<void>((resolve) => { readEntered = resolve; });
    let releaseRead!: () => void;
    const released = new Promise<void>((resolve) => { releaseRead = resolve; });
    backend.gate(key, readEntered, released);
    let detached!: ReturnType<typeof cache.get<typeof value>>;
    const outer = cache.withPublicationGuard(key, async () => {
      detached = cache.get<typeof value>(key);
      void detached.catch(() => undefined);
    }, "READ");
    await entered;
    const beforeRelease = await Promise.race([
      outer.then(() => "outer-finished" as const),
      new Promise<"child-read-pending">((resolve) => setTimeout(
        () => resolve("child-read-pending"), 100,
      )),
    ]);
    releaseRead();
    await outer;
    expect(await detached).toMatchObject({ conversationId });
    expect(beforeRelease).toBe("child-read-pending");
    cache.destroy();
  });

  it("rejects an inherited protected operation that starts after its fence expires", async () => {
    const backend = new MemoryCacheBackend();
    const accountId = randomUUID();
    const conversationId = randomUUID();
    const descriptor = {
      namespace: "node-dossier" as const, scope: "PRIVATE_ACCOUNT" as const,
      entityId: conversationId, identityId: accountId,
      topologyVersion: "single-main-node-v1", sourceHighWater: "e1",
      stateVersion: randomUUID(), policyVersion: "node-routing-v1", schemaVersion: 1,
    };
    const key = cacheKey(descriptor);
    let guardEntries = 0;
    let releaseChild!: () => void;
    const childReleased = new Promise<void>((resolve) => { releaseChild = resolve; });
    const cache = new ScopedCache({
      backend,
      encryptionKey: randomBytes(32),
      authorize: () => true,
      protectedPublicationGuard: (_descriptor, work) => {
        guardEntries += 1;
        return work(Object.freeze({}));
      },
      requireProtectedPublicationGuard: true,
    });
    let child!: Promise<void>;
    await cache.withPublicationGuard(key, async () => {
      child = childReleased.then(() => cache.set(key, { conversationId }, {
        ttlSeconds: 60, encrypted: true,
      }));
      void child.catch(() => undefined);
    });
    releaseChild();
    await expect(child).rejects.toThrow("CACHE_PROTECTED_FENCE_EXPIRED");
    expect(guardEntries).toBe(1);
    expect(await backend.read(key)).toBeNull();
    cache.destroy();
  });

  it("reuses each protected cache transaction under pool-capacity concurrency", async () => {
    const firstFixture = await seedProtectedConversation(
      "privacy-cache-pool-first", "pool first secret",
    );
    const secondFixture = await seedProtectedConversation(
      "privacy-cache-pool-second", "pool second secret", firstFixture.db,
    );
    const capacity = 2;
    let activeTransactions = 0;
    let maximumTransactions = 0;
    let rootProtectedQueries = 0;
    let releaseCapacity!: () => void;
    const capacityReached = new Promise<void>((resolve) => { releaseCapacity = resolve; });
    const scoped = (database: EventDatabase): EventDatabase => ({
      query: (sql, parameters) => database.query(sql, parameters),
      one: (sql, parameters) => database.one(sql, parameters),
      transaction: (work) => work(scoped(database)),
    });
    let pressured!: EventDatabase;
    pressured = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: readonly unknown[],
      ): Promise<Row[]> => {
        if (activeTransactions >= capacity && sql.includes("from accounts account")) {
          rootProtectedQueries += 1;
          throw new Error("TEST_POOL_EXHAUSTED");
        }
        return firstFixture.db.query<Row>(sql, parameters);
      },
      one: (sql, parameters) => firstFixture.db.one(sql, parameters),
      transaction: <Result>(work: (database: EventDatabase) => Promise<Result>) => (
        firstFixture.db.transaction(async (transaction) => {
          activeTransactions += 1;
          maximumTransactions = Math.max(maximumTransactions, activeTransactions);
          if (activeTransactions === capacity) releaseCapacity();
          await capacityReached;
          try {
            return await work(scoped(transaction));
          } finally {
            activeTransactions -= 1;
          }
        })
      ),
    };
    const firstMaterial = await protectedDossierMaterial(firstFixture, "pool-first");
    const secondMaterial = await protectedDossierMaterial(secondFixture, "pool-second");
    const firstAccess = createPostgresCacheAccess({
      db: pressured, backend: new MemoryCacheBackend(), encryptionKey: randomBytes(32),
    });
    const secondAccess = createPostgresCacheAccess({
      db: pressured, backend: new MemoryCacheBackend(), encryptionKey: randomBytes(32),
    });
    const firstReader = firstAccess.readerFor(firstFixture);
    const secondReader = secondAccess.readerFor(secondFixture);
    try {
      const values = await Promise.race([
        Promise.all([
          firstReader.readThrough(cacheKey(firstMaterial.descriptor), {
            maxRows: 1, ttlSeconds: 60, encrypted: true,
            load: async () => ({ rowsRead: 1, value: firstMaterial.value }),
          }),
          secondReader.readThrough(cacheKey(secondMaterial.descriptor), {
            maxRows: 1, ttlSeconds: 60, encrypted: true,
            load: async () => ({ rowsRead: 1, value: secondMaterial.value }),
          }),
        ]),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("CACHE_POOL_DEADLOCK")), 5_000,
        )),
      ]);
      expect(values.map((value) => value?.conversationId)).toEqual([
        firstFixture.conversationId, secondFixture.conversationId,
      ]);
      expect(rootProtectedQueries).toBe(0);
      expect(maximumTransactions).toBe(capacity);
    } finally {
      firstReader.dispose();
      secondReader.dispose();
      firstAccess.destroy();
      secondAccess.destroy();
    }
  }, 30_000);

  it("loads and completes a protected cache job on the same fenced transaction", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-cache-worker-transaction", "worker transaction secret",
    );
    const { descriptor, value } = await protectedDossierMaterial(fixture, "worker-transaction");
    const access = createPostgresCacheAccess({
      db: fixture.db, backend: new MemoryCacheBackend(), encryptionKey: randomBytes(32),
    });
    const claim = {
      jobId: randomUUID(),
      message: {
        outboxId: randomUUID(), eventId: descriptor.stateVersion,
        topic: "node.reply.routed", payload: { eventId: descriptor.stateVersion },
        createdAt: new Date().toISOString(), category: "NODE_DOSSIERS" as const,
      },
      workerId: "privacy-worker-transaction", leaseToken: randomUUID(),
      leaseUntil: new Date(Date.now() + 30_000).toISOString(), attempt: 1,
    };
    let sourceDatabase: EventDatabase | undefined;
    let completeDatabase: EventDatabase | undefined;
    const result = await processNextCacheJob({
      repository: {
        claim: async () => claim,
        guardTarget: async () => ({ key: cachePointerKey(descriptor), operation: "WRITE" as const }),
        complete: async (_claim, _change, database?: EventDatabase) => {
          completeDatabase = database;
        },
        retry: async () => { throw new Error("UNEXPECTED_CACHE_RETRY"); },
        fail: async () => { throw new Error("UNEXPECTED_CACHE_FAILURE"); },
      },
      source: {
        loadChange: async (_eventId, _input, database?: EventDatabase) => {
          sourceDatabase = database;
          return {
            action: "PREWARM" as const,
            triggerEventId: descriptor.stateVersion,
            recordSourceEventId: descriptor.stateVersion,
            sourceTopic: "node.reply.routed",
            record: {
              id: randomUUID(), key: descriptor, versionOrdinal: "1", value,
              sourceRowCount: 1, contentHash: projectionValueHash(value),
            },
          };
        },
      },
      cache: access.publisher,
      workerId: claim.workerId,
      leaseMs: 20_000,
      maxAttempts: 1,
    });
    expect(result).toBe("COMPLETED");
    expect(sourceDatabase).toBeDefined();
    expect(completeDatabase).toBe(sourceDatabase);
    access.destroy();
  }, 30_000);

  it("fences cross-runtime fallback publication after forgetting", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-cache-cross-runtime", "cross runtime fallback secret",
    );
    const routed = await appendEvent(fixture.db, {
      aggregateId: fixture.conversationId, accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId }, type: "node.reply.routed",
      visibility: "PRIVATE_ACCOUNT", policyVersion: "node-routing-v1",
      body: { mode: "NODE", sourceEventIds: [fixture.sourceEventId] },
      idempotencyKey: "privacy-cache-cross-runtime-route",
    });
    const routedSequence = await fixture.db.one<{ sequence: string }>(
      "select ingested_sequence::text sequence from events where id=$1", [routed.id],
    );
    let backendEntered!: () => void;
    const entered = new Promise<void>((resolve) => { backendEntered = resolve; });
    let releaseBackend!: () => void;
    const released = new Promise<void>((resolve) => { releaseBackend = resolve; });
    const transport = new GatedPrivacyValkeyTransport(backendEntered, released);
    const backend = new ValkeyCacheBackend(transport);
    const encryptionKey = randomBytes(32);
    const first = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const second = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const descriptor = {
      namespace: "node-dossier" as const, scope: "PRIVATE_ACCOUNT" as const,
      entityId: fixture.conversationId, identityId: fixture.accountId,
      topologyVersion: "single-main-node-v1", sourceHighWater: `e${routedSequence.sequence}`,
      stateVersion: routed.id,
      policyVersion: "node-routing-v1", schemaVersion: 1,
    };
    const key = cacheKey(descriptor);
    const reader = first.readerFor({ accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId });
    const fallback = reader.readThrough(key, {
      maxRows: 1, ttlSeconds: 60, encrypted: true,
      load: async () => ({ rowsRead: 1, value: {
        kind: "NODE_DOSSIER" as const, accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId], sourceHighWater: `e${routedSequence.sequence}`,
        mainStateVersion: "1", route: { classificationConfidence: 1, mode: "NODE",
          policyVersion: "node-routing-v1", reason: "MATERIAL_EVIDENCE",
          response: { authority: "NODE_BRAIN", canonical: false, label: "Node" },
          sourceIds: [fixture.sourceEventId] }, occurredAt: new Date().toISOString(),
      } }),
    });
    await entered;
    let forgetFinished = false;
    const forgetting = forgetConversation({ db: fixture.db, cache: second }, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "forget-cross-runtime-cache",
    }).then((result) => { forgetFinished = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(forgetFinished).toBe(false);
    releaseBackend();
    await fallback;
    await forgetting;
    expect(await backend.read(key)).toBeNull();
    expect(transport.values.has(key)).toBe(false);
    expect(await reader.get(key)).toBeNull();
    reader.dispose();
    first.destroy();
    second.destroy();
  }, 30_000);

  it("holds the conversation fence through a protected getCurrent hit return", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-cache-read-hit-fence", "protected hit return secret",
    );
    const backend = new GatedReadMemoryBackend();
    const encryptionKey = randomBytes(32);
    const first = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const second = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const { descriptor, value } = await protectedDossierMaterial(fixture, "hit");
    await first.publisher.publish({
      pointerKey: cachePointerKey(descriptor), versionKey: cacheKey(descriptor),
      versionOrdinal: "1", value, options: { ttlSeconds: 60, encrypted: true },
    });
    let readEntered!: () => void;
    const entered = new Promise<void>((resolve) => { readEntered = resolve; });
    let releaseRead!: () => void;
    const released = new Promise<void>((resolve) => { releaseRead = resolve; });
    backend.gate(cacheKey(descriptor), readEntered, released);
    const reader = first.readerFor({ accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId });
    const reading = reader.getCurrent(cachePointerKey(descriptor));
    await entered;
    const forgetting = forgetConversation({ db: fixture.db, cache: second }, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "forget-protected-hit-return",
    });
    const beforeRelease = await Promise.race([
      forgetting.then(() => "forget-finished" as const),
      new Promise<"read-holds-fence">((resolve) => setTimeout(
        () => resolve("read-holds-fence"), 250,
      )),
    ]);
    releaseRead();
    expect(await reading).toMatchObject({ conversationId: fixture.conversationId });
    await forgetting;
    expect(beforeRelease).toBe("read-holds-fence");
    expect(await reader.getCurrent(cachePointerKey(descriptor))).toBeNull();
    reader.dispose();
    first.destroy();
    second.destroy();
  }, 30_000);

  it("fences normal fallback before single-flight and avoids forget deadlock", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-cache-read-fallback-fence", "protected fallback return secret",
    );
    const backend = new MemoryCacheBackend();
    const encryptionKey = randomBytes(32);
    const first = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const second = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const reader = first.readerFor({ accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId });
    const { descriptor, value } = await protectedDossierMaterial(fixture, "fallback");
    let loadEntered!: () => void;
    const entered = new Promise<void>((resolve) => { loadEntered = resolve; });
    let releaseLoad!: () => void;
    const released = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const firstRead = reader.readThrough(cacheKey(descriptor), {
      maxRows: 1, ttlSeconds: 60, encrypted: true,
      load: async () => {
        loadEntered();
        await released;
        return { rowsRead: 1, value };
      },
    });
    await entered;
    let forgetFenceAttempted!: () => void;
    const fenceAttempted = new Promise<void>((resolve) => { forgetFenceAttempted = resolve; });
    const forgetting = forgetConversation({
      db: signalingDatabase(
        fixture.db, "select pg_advisory_xact_lock(hashtextextended($1,0))", forgetFenceAttempted,
      ),
      cache: second,
    }, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "forget-normal-fallback-return",
    });
    await fenceAttempted;
    const secondRead = reader.readThrough(cacheKey(descriptor), {
      maxRows: 1, ttlSeconds: 60, encrypted: true,
      load: async () => ({ rowsRead: 1, value }),
    });
    const beforeRelease = await Promise.race([
      forgetting.then(() => "forget-finished" as const),
      new Promise<"read-holds-fence">((resolve) => setTimeout(
        () => resolve("read-holds-fence"), 250,
      )),
    ]);
    releaseLoad();
    expect(await firstRead).toMatchObject({ conversationId: fixture.conversationId });
    await expect(Promise.race([
      secondRead,
      new Promise((_, reject) => setTimeout(() => reject(new Error("CACHE_READ_DEADLOCK")), 5_000)),
    ])).rejects.toThrow(/CACHE_(?:PRIVACY_BARRIER|NOT_AUTHORIZED)/u);
    await expect(Promise.race([
      forgetting,
      new Promise((_, reject) => setTimeout(() => reject(new Error("CACHE_FORGET_DEADLOCK")), 5_000)),
    ])).resolves.toMatchObject({ status: "PENDING" });
    expect(beforeRelease).toBe("read-holds-fence");
    expect(await backend.read(cacheKey(descriptor))).toBeNull();
    reader.dispose();
    first.destroy();
    second.destroy();
  }, 30_000);

  it("holds the conversation fence through a decision-critical fallback return", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-cache-decision-fence", "decision critical return secret",
    );
    const backend = new MemoryCacheBackend();
    const encryptionKey = randomBytes(32);
    const first = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const second = createPostgresCacheAccess({ db: fixture.db, backend, encryptionKey });
    const reader = first.readerFor({ accountId: fixture.accountId,
      nodeBrainId: fixture.nodeBrainId, conversationId: fixture.conversationId });
    const { descriptor, value } = await protectedDossierMaterial(fixture, "decision");
    let loadEntered!: () => void;
    const entered = new Promise<void>((resolve) => { loadEntered = resolve; });
    let releaseLoad!: () => void;
    const released = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const reading = reader.readThrough(cacheKey(descriptor), {
      maxRows: 1, ttlSeconds: 60, encrypted: true, decisionCritical: true,
      load: async () => {
        loadEntered();
        await released;
        return { rowsRead: 1, value };
      },
    });
    await entered;
    const forgetting = forgetConversation({ db: fixture.db, cache: second }, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "forget-decision-critical-return",
    });
    const beforeRelease = await Promise.race([
      forgetting.then(() => "forget-finished" as const),
      new Promise<"read-holds-fence">((resolve) => setTimeout(
        () => resolve("read-holds-fence"), 250,
      )),
    ]);
    releaseLoad();
    expect(await reading).toMatchObject({ conversationId: fixture.conversationId });
    await forgetting;
    expect(beforeRelease).toBe("read-holds-fence");
    expect(await reader.get(cacheKey(descriptor))).toBeNull();
    reader.dispose();
    first.destroy();
    second.destroy();
  }, 30_000);

  it("durably retries projection failures and exposes terminal failure without error details", async () => {
    const fixture = await seedProtectedConversation("privacy-retry", "retry secret");
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-retry",
    });
    const failing = { ...fixture, db: failingProjectionDatabase(fixture.db) };
    await processForgetPropagation(failing, {
      workerId: "privacy-worker-test", maximumSteps: 1, leaseMilliseconds: 5_000,
    });
    expect(await fixture.db.one<{ to_status: string; error_code: string }>(
      `select to_status,error_code from privacy_forget_step_transitions
       where request_id=$1 and projection_type='CONSOLIDATION_RUN'
       order by transition_ordinal desc limit 1`,
      [request.requestId],
    )).toEqual({ to_status: "RETRY_SCHEDULED", error_code: "PROJECTION_PROCESSING_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await processForgetPropagation(failing, {
      workerId: "privacy-worker-test", maximumSteps: 1, leaseMilliseconds: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await processForgetPropagation(failing, {
      workerId: "privacy-worker-test", maximumSteps: 1, leaseMilliseconds: 5_000,
    });
    expect(await getForgetStatus(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"), requestId: request.requestId,
    })).toMatchObject({ status: "FAILED", failedSteps: 1 });
  }, 30_000);

  it("retries durable completion publication after a transient outbox failure", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-completion-retry", "completion retry secret",
    );
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "forget-completion-retry",
    });
    let completionFailures = 0;
    const flakyContext = ({ ...fixture,
      publishForgetCompletion: async (publish: () => Promise<void>) => {
        if (completionFailures === 0) {
          completionFailures += 1;
          throw new Error("TRANSIENT_COMPLETION_OUTBOX_FAILURE");
        }
        await publish();
      },
    } as unknown) as Parameters<typeof processForgetPropagation>[0];
    for (let attempt = 0; attempt < 10 && completionFailures === 0; attempt += 1) {
      await processForgetPropagation(flakyContext, {
        workerId: "privacy-worker-test", maximumSteps: 50, leaseMilliseconds: 5_000,
      }).catch(() => undefined);
    }
    expect(completionFailures).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await processForgetPropagation(fixture, {
        workerId: "privacy-worker-test", maximumSteps: 50, leaseMilliseconds: 5_000,
      });
      const completion = await fixture.db.one<{ events: number; outbox: number }>(
        `select
           (select count(*)::int from events where aggregate_id=$1
             and type='content.forget_propagated') events,
           (select count(*)::int from transactional_outbox outbox join events event
             on event.id=outbox.event_id where event.aggregate_id=$1
               and outbox.topic='content.forget_propagated') outbox`,
        [`privacy-forget:${request.requestId}`],
      );
      if (completion.events === 1 && completion.outbox === 1) break;
    }
    expect(await fixture.db.one<{ events: number; outbox: number }>(
      `select
         (select count(*)::int from events where aggregate_id=$1
           and type='content.forget_propagated') events,
         (select count(*)::int from transactional_outbox outbox join events event
           on event.id=outbox.event_id where event.aggregate_id=$1
             and outbox.topic='content.forget_propagated') outbox`,
      [`privacy-forget:${request.requestId}`],
    )).toEqual({ events: 1, outbox: 1 });
    expect(await getForgetStatus(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"), requestId: request.requestId,
    })).toMatchObject({ status: "COMPLETED" });
  }, 30_000);

  it("preserves remaining mixed-source evidence and queues a sanitized rebuild", async () => {
    const fixture = await seedProtectedConversation("privacy-mixed-source", "forgotten half");
    const remaining = await appendEvent(fixture.db, {
      aggregateId: `remaining-source:${randomUUID()}`,
      actor: { type: "SYSTEM", id: "privacy-public-source" },
      type: "participant.message.created",
      visibility: "PUBLIC",
      body: { role: "USER", text: "remaining authorized evidence" },
      idempotencyKey: "privacy-mixed-source-remaining",
    });
    const remainingRow = await fixture.db.one<{ ingested_sequence: string; occurred_at: Date }>(
      "select ingested_sequence::text,occurred_at from events where id=$1", [remaining.id],
    );
    await fixture.db.transaction(async (db) => {
      await db.query("alter table memory_records disable trigger memory_records_are_immutable");
      await db.query("alter table memory_sources disable trigger memory_source_authority_is_consistent");
      await db.query(
        "update memory_records set source_count=2,source_to=$2 where id=$1",
        [fixture.memoryIds[0], remainingRow.occurred_at],
      );
      await db.query(
        `insert into memory_sources
           (memory_id,ordinal,source_event_id,source_ingested_sequence,source_at)
         values ($1,1,$2,$3,$4)`,
        [fixture.memoryIds[0], remaining.id, remainingRow.ingested_sequence, remainingRow.occurred_at],
      );
      await db.query("alter table memory_sources enable trigger memory_source_authority_is_consistent");
      await db.query("alter table memory_records enable trigger memory_records_are_immutable");
    });
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "forget-mixed-source",
    });
    expect(await completeForget(fixture, request.requestId)).toMatchObject({ status: "COMPLETED" });
    expect(await fixture.db.one<{ forgotten_sources: number; retained_source_count: number }>(
      `select
         (select count(*)::int from privacy_projection_deactivations
          where request_id=$1 and projection_type='MEMORY_SOURCE'
            and record_id like $2||':%') forgotten_sources,
         (select retained_source_count from privacy_projection_deactivations
          where request_id=$1 and projection_type='MEMORY_RECORD' and record_id=$2)
            retained_source_count`,
      [request.requestId, fixture.memoryIds[0]],
    )).toEqual({ forgotten_sources: 1, retained_source_count: 1 });
    const rebuild = await fixture.db.one<{
      remaining_source_ids: string[]; status: string; replacement_record_id: string;
    }>(
      `select job.remaining_source_ids::text[],transition.to_status status,
              result.replacement_record_id
       from privacy_projection_rebuild_jobs job
       join lateral (
         select to_status from privacy_projection_rebuild_job_transitions item
         where item.rebuild_job_id=job.id order by item.transition_ordinal desc limit 1
       ) transition on true
       join privacy_projection_rebuild_results result on result.rebuild_job_id=job.id
       where job.request_id=$1 and job.projection_type='MEMORY_RECORD' and job.record_id=$2`,
      [request.requestId, fixture.memoryIds[0]],
    );
    expect(rebuild).toMatchObject({ remaining_source_ids: [remaining.id], status: "COMPLETED",
      replacement_record_id: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
    await expect(readEventBody(fixture.db, remaining.id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    })).resolves.toMatchObject({ text: "remaining authorized evidence" });
    const rebuilt = await fixture.db.one<{ body_event_id: string; source_ids: string[] }>(
      `select memory.body_event_id::text,
              array_agg(source.source_event_id::text order by source.ordinal) source_ids
       from memory_records memory join memory_sources source on source.memory_id=memory.id
       where memory.id=$1 group by memory.id`,
      [rebuild.replacement_record_id],
    );
    expect(rebuilt.source_ids).toEqual([remaining.id]);
    expect(await readEventBody(fixture.db, rebuilt.body_event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    })).toMatchObject({ memories: expect.any(Array) });
    expect(JSON.stringify(await readEventBody(fixture.db, rebuilt.body_event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    }))).toContain("remaining authorized evidence");
    expect(JSON.stringify(await readEventBody(fixture.db, rebuilt.body_event_id, {
      actor: { role: "ACCOUNT", accountId: fixture.accountId },
    }))).not.toContain("forgotten half");
  }, 30_000);

  it("rebuilds a mixed-source graph only from surviving replacement memories", async () => {
    const fixture = await seedProtectedConversation("privacy-mixed-graph", "forgotten graph source");
    const remaining = await Promise.all(["surviving graph source alpha", "surviving graph source beta"]
      .map((text, index) => appendEvent(fixture.db, {
        aggregateId: `remaining-graph:${randomUUID()}`,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        type: "participant.message.created", visibility: "PUBLIC", body: { role: "USER", text },
        idempotencyKey: `privacy-mixed-graph-remaining:${index}`,
      })));
    const sourceRows = await fixture.db.query<{ id: string; ingested_sequence: string;
      occurred_at: Date }>(
      `select id::text,ingested_sequence::text,occurred_at from events
       where id=any($1::uuid[]) order by ingested_sequence`,
      [remaining.map(({ id }) => id)],
    );
    await fixture.db.transaction(async (db) => {
      await db.query("alter table memory_records disable trigger memory_records_are_immutable");
      await db.query("alter table memory_sources disable trigger memory_source_authority_is_consistent");
      await db.query("alter table memory_graph_nodes disable trigger memory_graph_nodes_are_immutable");
      for (let index = 0; index < fixture.memoryIds.length; index += 1) {
        const memoryId = fixture.memoryIds[index]!;
        const source = sourceRows[index]!;
        await db.query("update memory_records set source_count=2,source_to=$2 where id=$1",
          [memoryId, source.occurred_at]);
        await db.query(
          `insert into memory_sources
             (memory_id,ordinal,source_event_id,source_ingested_sequence,source_at)
           values ($1,1,$2,$3,$4)`,
          [memoryId, source.id, source.ingested_sequence, source.occurred_at],
        );
        await db.query("update memory_graph_nodes set source_count=2 where memory_id=$1", [memoryId]);
        await db.query(
          `insert into memory_graph_node_sources (memory_id,ordinal,source_event_id)
           values ($1,1,$2)`,
          [memoryId, source.id],
        );
      }
      await db.query(
        `insert into memory_graph_edge_sources (edge_id,ordinal,source_event_id)
         select edge.id,source.ordinal,source.source_event_id
         from memory_graph_edges edge cross join (
           values (1,$2::uuid),(2,$3::uuid)
         ) source(ordinal,source_event_id)
         where edge.conversation_id=$1`,
        [fixture.conversationId, sourceRows[0]!.id, sourceRows[1]!.id],
      );
      await db.query("alter table memory_graph_nodes enable trigger memory_graph_nodes_are_immutable");
      await db.query("alter table memory_sources enable trigger memory_source_authority_is_consistent");
      await db.query("alter table memory_records enable trigger memory_records_are_immutable");
    });
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"), accountId: fixture.accountId,
      conversationId: fixture.conversationId, idempotencyKey: "forget-mixed-graph",
    });
    const status = await completeForget(fixture, request.requestId);
    const jobStates = await fixture.db.query<{
      projection_type: string; record_id: string; to_status: string | null; result: boolean;
    }>(
      `select job.projection_type,job.record_id,latest.to_status,
              (result.rebuild_job_id is not null) result
       from privacy_projection_rebuild_jobs job
       left join lateral (
         select to_status from privacy_projection_rebuild_job_transitions transition
         where transition.rebuild_job_id=job.id order by transition_ordinal desc limit 1
       ) latest on true
       left join privacy_projection_rebuild_results result on result.rebuild_job_id=job.id
       where job.request_id=$1 order by job.id`,
      [request.requestId],
    );
    expect({ status: status.status, jobStates }).toMatchObject({
      status: "COMPLETED",
      jobStates: expect.arrayContaining([
        expect.objectContaining({ projection_type: "GRAPH_EDGE", to_status: "COMPLETED",
          result: true }),
      ]),
    });
    const rebuilt = await fixture.db.query<{ replacement_record_id: string }>(
      `select result.replacement_record_id from privacy_projection_rebuild_jobs job
       join privacy_projection_rebuild_results result on result.rebuild_job_id=job.id
       where job.request_id=$1 and job.projection_type='GRAPH_EDGE'`,
      [request.requestId],
    );
    expect(rebuilt.length).toBeGreaterThan(0);
    const rebuiltSources = await fixture.db.one<{
      forgotten_sources: number; surviving_sources: number;
    }>(
      `select
         count(*) filter (where source.source_event_id=$2)::int forgotten_sources,
         count(*) filter (where source.source_event_id=any($3::uuid[]))::int surviving_sources
       from memory_graph_edge_sources source
       where source.edge_id=any($1::uuid[])`,
      [rebuilt.map(({ replacement_record_id }) => replacement_record_id), fixture.sourceEventId,
        remaining.map(({ id }) => id)],
    );
    expect(rebuiltSources.forgotten_sources).toBe(0);
    expect(rebuiltSources.surviving_sources).toBeGreaterThan(0);
  }, 30_000);

  it("rejects forged completion, barrier removal, conversation restoration, and key resurrection", async () => {
    const fixture = await seedProtectedConversation("privacy-forgery", "forgery secret");
    const request = await forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-forgery",
    });
    await expect(fixture.db.query(
      "update privacy_forget_requests set status='COMPLETED',completed_at=clock_timestamp() where id=$1",
      [request.requestId],
    )).rejects.toThrow("PRIVACY_FORGET_COMPLETION_INVALID");
    await expect(fixture.db.query(
      `insert into privacy_projection_deactivations
         (request_id,projection_type,record_id) values ($1,'GRAPH_EDGE',$2)`,
      [request.requestId, randomUUID()],
    )).rejects.toThrow("PRIVACY_PROJECTION_DEACTIVATION_INVALID");
    await expect(fixture.db.query(
      "delete from privacy_forget_barriers where conversation_id=$1",
      [fixture.conversationId],
    )).rejects.toThrow("IMMUTABLE_PRIVACY_FORGET_BARRIER");
    await expect(fixture.db.query(
      "update conversations set status='OPEN' where id=$1",
      [fixture.conversationId],
    )).rejects.toThrow("FORGOTTEN_CONVERSATION_CANNOT_BE_RESTORED");
    await expect(fixture.db.query(
      `insert into aggregate_data_keys
        (id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag)
       values ($1,$2,1,$3,$4,$5)`,
      [randomUUID(), fixture.conversationId, Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(16)],
    )).rejects.toThrow("FORGOTTEN_AGGREGATE_KEY_CANNOT_BE_RECREATED");
  }, 30_000);

  it("rolls back a legal forget when its append-only authority is concurrently revoked", async () => {
    const fixture = await seedProtectedConversation(
      "privacy-legal-revocation-race", "legal revocation secret",
    );
    const authorityId = `privacy-legal-forget-${randomUUID()}`;
    const actorId = `privacy-officer-${randomUUID()}`;
    const revokerAuthorityId = `privacy-legal-revoker-${randomUUID()}`;
    const revokerActorId = `privacy-revoker-${randomUUID()}`;
    await fixture.db.query(
      `insert into privacy_legal_authorities
         (id,account_id,actor_id,legal_role,capability)
       values ($1,$2,$3,'PRIVACY_OFFICER','FORGET_CONVERSATION'),
              ($4,$2,$5,'PRIVACY_OFFICER','FORGET_CONVERSATION')`,
      [authorityId, fixture.accountId, actorId, revokerAuthorityId, revokerActorId],
    );
    let forgetReached!: () => void;
    const reached = new Promise<void>((resolve) => { forgetReached = resolve; });
    let releaseForget!: () => void;
    const release = new Promise<void>((resolve) => { releaseForget = resolve; });
    const forgetting = forgetConversation({
      ...fixture,
      db: gatedDatabase(fixture.db, "delete from aggregate_data_keys", forgetReached, release),
    }, {
      actor: { kind: "LEGAL", actorId, accountId: fixture.accountId, authorityId,
        legalRole: "PRIVACY_OFFICER", capability: "FORGET_CONVERSATION" },
      accountId: fixture.accountId, conversationId: fixture.conversationId,
      idempotencyKey: "privacy-legal-revocation-race",
    });
    await reached;
    let revocationError: unknown;
    let revocationId = "";
    try {
      const revocationEvent = await appendEvent(fixture.db, {
        aggregateId: `privacy-legal-authority:${authorityId}`, accountId: fixture.accountId,
        actor: { type: "OPERATOR", id: revokerActorId },
        type: "privacy.legal_authority.revoked", visibility: "PRIVATE_ACCOUNT",
        body: { authorityId, revokerAuthorityId, reasonCode: "AUTHORITY_WITHDRAWN" },
        idempotencyKey: `privacy-legal-revocation:${authorityId}`,
      });
      revocationId = randomUUID();
      await fixture.db.query(
        `insert into privacy_legal_authority_revocations
           (id,event_id,authority_id,account_id,revoker_authority_id,
            revoked_by_actor_id,reason_code,revoked_at)
         values ($1,$2,$3,$4,$5,$6,'AUTHORITY_WITHDRAWN',$7)`,
        [revocationId, revocationEvent.id, authorityId, fixture.accountId,
          revokerAuthorityId, revokerActorId, revocationEvent.occurredAt],
      );
    } catch (error) {
      revocationError = error;
    } finally {
      releaseForget();
    }
    const outcome = await forgetting.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    if (revocationError) throw revocationError;
    expect(outcome.status).toBe("rejected");
    expect(outcome.status === "rejected" ? String(outcome.error) : "")
      .toContain("PRIVACY_FORGET_REQUEST_INVALID");
    expect(await fixture.db.one<{ barrier: number; key_count: number }>(
      `select
         (select count(*)::int from privacy_forget_barriers where conversation_id=$1) barrier,
         (select count(*)::int from aggregate_data_keys where aggregate_id=$1::text) key_count`,
      [fixture.conversationId],
    )).toEqual({ barrier: 0, key_count: 1 });
    await expect(fixture.db.query(
      "update privacy_legal_authority_revocations set reason_code='FORGED' where id=$1",
      [revocationId],
    )).rejects.toThrow("IMMUTABLE_PRIVACY_LEGAL_AUTHORITY_REVOCATION");
    const forgedAuthorityId = `privacy-legal-forged-${randomUUID()}`;
    await fixture.db.query(
      `insert into privacy_legal_authorities
         (id,account_id,actor_id,legal_role,capability)
       values ($1,$2,$3,'PRIVACY_OFFICER','FORGET_CONVERSATION')`,
      [forgedAuthorityId, fixture.accountId, `forged-target-${randomUUID()}`],
    );
    const forgedEvent = await appendEvent(fixture.db, {
      aggregateId: `wrong-privacy-legal-authority:${forgedAuthorityId}`,
      accountId: fixture.accountId, actor: { type: "OPERATOR", id: revokerActorId },
      type: "privacy.legal_authority.revoked", visibility: "PRIVATE_ACCOUNT",
      body: { authorityId: forgedAuthorityId, revokerAuthorityId,
        reasonCode: "AUTHORITY_WITHDRAWN" },
      idempotencyKey: `forged-privacy-legal-revocation:${forgedAuthorityId}`,
    });
    await expect(fixture.db.query(
      `insert into privacy_legal_authority_revocations
         (id,event_id,authority_id,account_id,revoker_authority_id,
          revoked_by_actor_id,reason_code,revoked_at)
       values ($1,$2,$3,$4,$5,$6,'AUTHORITY_WITHDRAWN',$7)`,
      [randomUUID(), forgedEvent.id, forgedAuthorityId, fixture.accountId,
        revokerAuthorityId, revokerActorId, forgedEvent.occurredAt],
    )).rejects.toThrow("PRIVACY_LEGAL_AUTHORITY_REVOCATION_INVALID");
    const ownerFixture = await seedProtectedConversation(
      "privacy-owner-after-legal-revocation", "owner remains authorized", fixture.db,
    );
    await expect(forgetConversation(ownerFixture, {
      actor: owner(ownerFixture, "FORGET_CONVERSATION"), accountId: ownerFixture.accountId,
      conversationId: ownerFixture.conversationId, idempotencyKey: "owner-fixed-capability",
    })).resolves.toMatchObject({ status: "PENDING" });
  }, 30_000);

  it("rejects direct SQL grants for unprovisioned forget workers", async () => {
    const fixture = await createConversationFixture("privacy-worker-grant");
    await expect(fixture.db.query(
      "insert into privacy_forget_worker_authorities (worker_id) values ('forged-privacy-worker')",
    )).rejects.toThrow("PRIVACY_FORGET_WORKER_GRANT_INVALID");
  });

  it("serializes export-first with forget and makes forget-first exports fail closed", async () => {
    const fixture = await seedProtectedConversation("privacy-concurrency", "concurrent secret");
    let releaseExport!: () => void;
    const release = new Promise<void>((resolve) => { releaseExport = resolve; });
    let reachedLock!: () => void;
    const lockReached = new Promise<void>((resolve) => { reachedLock = resolve; });
    const exporting = exportAccountData({
      ...fixture,
      db: gatedDatabase(fixture.db, "privacy-export-key-lock", reachedLock, release),
    }, {
      actor: owner(fixture, "EXPORT_DATA"),
      limit: 50,
    });
    await lockReached;
    let forgetFinished = false;
    const forgetting = forgetConversation(fixture, {
      actor: owner(fixture, "FORGET_CONVERSATION"),
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      idempotencyKey: "forget-concurrency",
    }).then((value) => {
      forgetFinished = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(forgetFinished).toBe(false);
    releaseExport();
    expect(JSON.stringify((await exporting).records)).toContain("concurrent secret");
    await forgetting;

    const after = await exportAccountData(fixture, {
      actor: owner(fixture, "EXPORT_DATA"),
      limit: 50,
    });
    expect(JSON.stringify(after.records)).not.toContain("concurrent secret");
    expect(after.records.some((record) => record.type === "content.forgotten")).toBe(true);
    expect(after.records.every((record) => (
      record.type === "content.forgotten" || record.type === "account.export.started"
    ))).toBe(true);
  }, 30_000);
});
