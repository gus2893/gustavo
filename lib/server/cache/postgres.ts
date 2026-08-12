import { createHash, randomUUID } from "node:crypto";
import type { EventDatabase } from "../events/types";
import { readEventBody } from "../events/store";
import { loadHandoff } from "../handoffs/build";
import {
  CACHE_REQUIRED_CATEGORIES,
  cachePointerKey,
  projectionCategory,
  projectionCategoryManifests,
  projectionManifestHash,
  projectionValueHash,
  type CacheJson,
  type CacheProjectionCategory,
  type CachePointerKeyInput,
  type CriticalProjectionManifest,
  type CriticalProjectionRecord,
  type CriticalProjectionSource,
} from "./store";
import type {
  CacheChangeSource,
  CacheJobClaim,
  CacheJobRepository,
  CacheOutboxMessage,
  CacheProjectionChange,
} from "../../../worker/cache/invalidate";

export { CACHE_REQUIRED_CATEGORIES } from "./store";

const TOPOLOGY_VERSION = "single-main-node-v1";
const CACHE_SCHEMA_VERSION = 1;
const MAX_SOURCE_RECORDS = 100;
const MAX_METRIC_BUCKETS_PER_SERIES = 1_000;
const CATEGORY_SET: ReadonlySet<string> = new Set(CACHE_REQUIRED_CATEGORIES);
const CACHE_OUTBOX_TOPICS = Object.freeze([
  "main.broadcast.committed",
  "node.reply.routed",
  "node.handoff.packet.refreshed",
  "node.handoff.checkpoint.advanced",
  "proposal.disclosure.revoked",
] as const);
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function deterministicUuid(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function valuePlaceholders(rowCount: number, width: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    `(${Array.from({ length: width }, (_unused, columnIndex) => (
      `$${rowIndex * width + columnIndex + 1}`
    )).join(",")})`
  )).join(",");
}

function frozen<Value extends CacheJson>(value: Value): Value {
  return Object.freeze(value);
}

function record(input: Omit<CriticalProjectionRecord, "contentHash">): CriticalProjectionRecord {
  return Object.freeze({ ...input, contentHash: projectionValueHash(input.value) });
}

function projectionRecordSourceEventId(record: CriticalProjectionRecord): string {
  const sourceEventIds = objectValue(record.value) ? record.value.sourceEventIds : undefined;
  const sourceEventId = Array.isArray(sourceEventIds) ? sourceEventIds[0] : undefined;
  if (typeof sourceEventId !== "string" || !EVENT_ID_PATTERN.test(sourceEventId)) {
    throw new Error("CACHE_RECORD_SOURCE_EVENT_INVALID");
  }
  return sourceEventId;
}

function maxHighWater(values: readonly string[]): string {
  if (values.length === 0) return "e0";
  return values.reduce((highest, value) => {
    const left = BigInt(highest.replace(/^e/u, ""));
    const right = BigInt(value.replace(/^e/u, ""));
    return right > left ? value : highest;
  });
}

function deniedProtectedProjection(error: unknown): boolean {
  return error instanceof Error
    && (error.message === "HANDOFF_FORBIDDEN" || error.message === "HANDOFF_STALE");
}

interface BroadcastRow extends Record<string, unknown> {
  readonly id: string;
  readonly main_state_version: string;
  readonly body_digest: string;
  readonly source_ids: readonly string[];
  readonly policy_version: string;
  readonly commit_event_id: string;
  readonly committed_at: Date;
  readonly ingested_sequence: string;
}

interface NodeRow extends Record<string, unknown> {
  readonly account_id: string;
  readonly node_brain_id: string;
  readonly conversation_id: string;
  readonly event_id: string;
  readonly occurred_at: Date;
  readonly ingested_sequence: string;
  readonly policy_version: string;
}

interface HandoffRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly node_brain_id: string;
  readonly conversation_id: string;
  readonly source_event_id: string;
  readonly through_event_id: string;
  readonly source_high_water_sequence: string;
  readonly main_state_version: string;
  readonly node_state_version: string;
  readonly version: string;
  readonly packet_kind: "PACKET" | "EMPTY_CHECKPOINT";
  readonly idea_count: number;
  readonly policy_version: string;
  readonly occurred_at: Date;
}

interface ChallengeRow extends Record<string, unknown> {
  readonly stage_id: string;
  readonly profile_version_id: string;
  readonly high_water_event_id: string;
  readonly high_water_sequence: string;
  readonly projection: CacheJson;
  readonly rebuilt_at: Date;
}

interface NodeRouteBody extends Record<string, CacheJson> {
  readonly classificationConfidence: number;
  readonly mainStateVersion: string;
  readonly mode: string;
  readonly policyVersion: string;
  readonly reason: string;
  readonly response: {
    readonly authority: string;
    readonly canonical: boolean;
    readonly label: string;
  };
  readonly sourceIds: readonly string[];
}

function objectValue(value: unknown): value is Record<string, CacheJson> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nodeRouteBody(value: CacheJson | null): NodeRouteBody {
  if (!objectValue(value)
      || typeof value.classificationConfidence !== "number"
      || !Number.isFinite(value.classificationConfidence)
      || typeof value.mainStateVersion !== "string"
      || typeof value.mode !== "string"
      || typeof value.policyVersion !== "string"
      || typeof value.reason !== "string"
      || !objectValue(value.response)
      || typeof value.response.authority !== "string"
      || typeof value.response.canonical !== "boolean"
      || typeof value.response.label !== "string"
      || !Array.isArray(value.sourceIds)
      || value.sourceIds.length === 0
      || value.sourceIds.some((sourceId) => typeof sourceId !== "string")) {
    throw new Error("CACHE_NODE_DOSSIER_SOURCE_INVALID");
  }
  return Object.freeze({
    classificationConfidence: value.classificationConfidence,
    mainStateVersion: value.mainStateVersion,
    mode: value.mode,
    policyVersion: value.policyVersion,
    reason: value.reason,
    response: Object.freeze({
      authority: value.response.authority,
      canonical: value.response.canonical,
      label: value.response.label,
    }),
    sourceIds: Object.freeze([...value.sourceIds] as string[]),
  });
}

async function nodeProjectionRecord(
  database: EventDatabase,
  row: NodeRow,
): Promise<CriticalProjectionRecord> {
  const body = nodeRouteBody(await readEventBody(database, row.event_id, {
    actor: { role: "ACCOUNT", accountId: row.account_id },
  }));
  const highWater = `e${row.ingested_sequence}`;
  return record({
    id: `03-node:${row.node_brain_id}`,
    key: {
      namespace: "node-dossier", scope: "PRIVATE_ACCOUNT", entityId: row.conversation_id,
      identityId: row.account_id, topologyVersion: TOPOLOGY_VERSION,
      sourceHighWater: highWater, stateVersion: row.ingested_sequence,
      policyVersion: row.policy_version, schemaVersion: CACHE_SCHEMA_VERSION,
    },
    versionOrdinal: row.ingested_sequence,
    value: frozen({
      kind: "NODE_DOSSIER", accountId: row.account_id, nodeBrainId: row.node_brain_id,
      conversationId: row.conversation_id,
      sourceEventIds: [...new Set([row.event_id, ...body.sourceIds])],
      sourceHighWater: highWater, mainStateVersion: body.mainStateVersion,
      route: {
        classificationConfidence: body.classificationConfidence,
        mode: body.mode, policyVersion: body.policyVersion, reason: body.reason,
        response: body.response, sourceIds: body.sourceIds,
      },
      occurredAt: row.occurred_at.toISOString(),
    }),
    sourceRowCount: 1,
  });
}

async function handoffProjectionRecord(
  database: EventDatabase,
  row: HandoffRow,
): Promise<CriticalProjectionRecord> {
  const items = row.packet_kind === "PACKET"
    ? (await loadHandoff({ db: database }, {
        packetId: row.id,
        accountId: row.account_id,
        nodeBrainId: row.node_brain_id,
        conversationId: row.conversation_id,
        scope: "NODE_BRANCH",
        policyVersion: row.policy_version,
        nodeStateVersion: row.node_state_version,
        mainStateVersion: row.main_state_version,
      })).items
    : [];
  const highWater = `e${row.source_high_water_sequence}`;
  const sourceEventIds = [...new Set([
    row.source_event_id,
    row.through_event_id,
    ...items.flatMap((item) => item.sourceIds),
  ])];
  return record({
    id: `04-handoff:${row.node_brain_id}`,
    key: {
      namespace: "handoff", scope: "PRIVATE_ACCOUNT", entityId: row.conversation_id,
      identityId: row.account_id, topologyVersion: TOPOLOGY_VERSION,
      sourceHighWater: highWater, stateVersion: row.version,
      policyVersion: row.policy_version, schemaVersion: CACHE_SCHEMA_VERSION,
    },
    versionOrdinal: row.source_high_water_sequence,
    value: frozen({
      kind: "NODE_HANDOFF", accountId: row.account_id, nodeBrainId: row.node_brain_id,
      conversationId: row.conversation_id, sourceEventIds,
      sourceHighWater: highWater, mainStateVersion: row.main_state_version,
      packetKind: row.packet_kind, packetVersion: row.version,
      throughEventId: row.through_event_id, ideaCount: row.idea_count,
      items: items.map((item) => ({
        id: item.id, proposalId: item.proposalId, kind: item.kind, text: item.text,
        sourceIds: item.sourceIds,
        memoryVersions: item.memoryVersions.map((memory) => ({
          memoryId: memory.memoryId, version: memory.version,
        })),
      })),
      occurredAt: row.occurred_at.toISOString(),
    }),
    sourceRowCount: 1,
  });
}

async function projectionRecords(database: EventDatabase): Promise<readonly CriticalProjectionRecord[]> {
  return database.transaction(async (transaction) => {
    await transaction.query("set transaction isolation level repeatable read");
    const broadcasts = await transaction.query<BroadcastRow>(
      `select broadcast.id::text,broadcast.main_state_version::text,broadcast.body_digest,
              broadcast.source_ids,broadcast.policy_version,broadcast.commit_event_id::text,
              broadcast.committed_at,event.ingested_sequence::text
       from broadcasts broadcast join events event on event.id=broadcast.commit_event_id
       order by event.ingested_sequence desc,broadcast.id limit ${MAX_SOURCE_RECORDS}`,
    );
    const currentMainState = await transaction.one<{ readonly version: string | null }>(
      "select max(version)::text version from main_state_versions where status='COMMITTED'",
    );
    const mainRows = await transaction.query<BroadcastRow>(
      `select broadcast.id::text,broadcast.main_state_version::text,broadcast.body_digest,
              broadcast.source_ids,broadcast.policy_version,broadcast.commit_event_id::text,
              broadcast.committed_at,source.source_ingestion_ordinal::text ingested_sequence
       from main_state_versions state
       join cache_main_state_sources source on source.main_state_version=state.version
       join broadcasts broadcast on broadcast.commit_event_id=source.source_event_id
       where state.status='COMMITTED'
       order by state.version desc limit 1`,
    );
    if (currentMainState.version !== null
        && mainRows[0]?.main_state_version !== currentMainState.version) {
      throw new Error("CACHE_MAIN_STATE_CANONICAL_SOURCE_MISSING");
    }
    const nodes = await transaction.query<NodeRow>(
      `select latest.* from (
         select distinct on (node.id) account.id::text account_id,node.id::text node_brain_id,
                conversation.id::text conversation_id,event.id::text event_id,event.occurred_at,
                event.ingested_sequence::text,
                coalesce(event.policy_version,'node-routing-v1') policy_version
         from accounts account
         join lateral (select entitlement.id from entitlements entitlement
           where entitlement.account_id=account.id and entitlement.revoked_at is null
             and entitlement.active_from<=clock_timestamp()
             and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
           order by entitlement.active_from desc,entitlement.id limit 1 for share) entitlement on true
         join node_brains node on node.account_id=account.id
         join conversations conversation on conversation.node_brain_id=node.id
           and conversation.account_id=account.id
         join events event on event.aggregate_id=conversation.id::text
           and event.account_id=account.id::text and event.actor_type='NODE_BRAIN'
           and event.actor_id=node.id::text and event.type='node.reply.routed'
           and event.visibility='PRIVATE_ACCOUNT'
         where account.status='ACTIVE' and node.status='ACTIVE' and conversation.status='OPEN'
         order by node.id,event.ingested_sequence desc,event.id desc
       ) latest order by latest.ingested_sequence::bigint desc,latest.event_id desc
       limit ${MAX_SOURCE_RECORDS}`,
    );
    const packetRows = await transaction.query<HandoffRow>(
      `select packet.id::text,packet.account_id::text,packet.node_brain_id::text,
              packet.conversation_id::text,packet.packet_event_id::text source_event_id,
              packet.through_event_id::text,packet.source_high_water_sequence::text,
              packet.main_state_version::text,packet.node_state_version,
              packet.packet_version::text version,'PACKET'::text packet_kind,
              packet.idea_count,packet.policy_version,packet.created_at occurred_at
       from handoff_packets packet
       join accounts account on account.id=packet.account_id and account.status='ACTIVE'
       join lateral (select entitlement.id from entitlements entitlement
         where entitlement.account_id=account.id and entitlement.revoked_at is null
           and entitlement.active_from<=clock_timestamp()
           and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
         order by entitlement.active_from desc,entitlement.id limit 1 for share) entitlement on true
       join node_brains node on node.id=packet.node_brain_id and node.account_id=account.id
         and node.status='ACTIVE'
       join conversations conversation on conversation.id=packet.conversation_id
         and conversation.account_id=account.id and conversation.node_brain_id=node.id
         and conversation.status='OPEN'
       order by packet.source_high_water_sequence desc,packet.packet_version desc,packet.id
       limit ${MAX_SOURCE_RECORDS}`,
    );
    const checkpointRows = await transaction.query<HandoffRow>(
      `select checkpoint.id::text,checkpoint.account_id::text,checkpoint.node_brain_id::text,
              checkpoint.conversation_id::text,
              checkpoint.checkpoint_event_id::text source_event_id,
              checkpoint.through_event_id::text,checkpoint.source_high_water_sequence::text,
              checkpoint.main_state_version::text,checkpoint.node_state_version,
              checkpoint.checkpoint_version::text version,
              'EMPTY_CHECKPOINT'::text packet_kind,0 idea_count,
              checkpoint.policy_version,checkpoint.created_at occurred_at
       from handoff_refresh_checkpoints checkpoint
       join accounts account on account.id=checkpoint.account_id and account.status='ACTIVE'
       join lateral (select entitlement.id from entitlements entitlement
         where entitlement.account_id=account.id and entitlement.revoked_at is null
           and entitlement.active_from<=clock_timestamp()
           and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
         order by entitlement.active_from desc,entitlement.id limit 1 for share) entitlement on true
       join node_brains node on node.id=checkpoint.node_brain_id and node.account_id=account.id
         and node.status='ACTIVE'
       join conversations conversation on conversation.id=checkpoint.conversation_id
         and conversation.account_id=account.id and conversation.node_brain_id=node.id
         and conversation.status='OPEN'
       order by checkpoint.source_high_water_sequence desc,
                checkpoint.checkpoint_version desc,checkpoint.id
       limit ${MAX_SOURCE_RECORDS}`,
    );
    const handoffs = [...packetRows, ...checkpointRows]
      .sort((left, right) => {
        const byHighWater = BigInt(right.source_high_water_sequence)
          - BigInt(left.source_high_water_sequence);
        if (byHighWater !== 0n) return byHighWater > 0n ? 1 : -1;
        return right.version.localeCompare(left.version);
      })
      .filter((row, index, rows) => (
        rows.findIndex((candidate) => candidate.node_brain_id === row.node_brain_id) === index
      ))
      .slice(0, MAX_SOURCE_RECORDS);
    const challenges = await transaction.query<ChallengeRow>(
      `select stage_id::text,profile_version_id::text,high_water_event_id::text,
              high_water_sequence::text,projection,rebuilt_at
       from challenge_projection_checkpoints
       order by high_water_sequence desc,stage_id limit ${MAX_SOURCE_RECORDS}`,
    );

    const records: CriticalProjectionRecord[] = [];
    const currentMain = mainRows[0];
    if (currentMain) {
      const mainHighWater = `e${currentMain.ingested_sequence}`;
      records.push(record({
        id: `01-main:${currentMain.main_state_version}`,
        key: {
          namespace: "main-state", scope: "SHARED", entityId: "gustavo-main",
          identityId: "gustavo-main", topologyVersion: TOPOLOGY_VERSION,
          sourceHighWater: mainHighWater, stateVersion: currentMain.main_state_version,
          policyVersion: currentMain.policy_version, schemaVersion: CACHE_SCHEMA_VERSION,
        },
        versionOrdinal: currentMain.main_state_version,
        value: frozen({
          kind: "MAIN_STATE", mainStateVersion: currentMain.main_state_version,
          sourceEventIds: [currentMain.commit_event_id], sourceHighWater: mainHighWater,
          committedAt: currentMain.committed_at.toISOString(),
        }),
        sourceRowCount: 1,
      }));
    }
    for (const row of [...broadcasts].reverse()) {
      const rowHighWater = `e${row.ingested_sequence}`;
      const body = await readEventBody(transaction, row.commit_event_id, { actor: { role: "SYSTEM" } });
      const broadcastBody = body && typeof body === "object" && !Array.isArray(body)
        && typeof body.body === "string" ? body.body : null;
      if (broadcastBody === null) throw new Error("CACHE_BROADCAST_SOURCE_INVALID");
      records.push(record({
        id: `02-broadcast:${row.id}`,
        key: {
          namespace: "broadcast", scope: "SHARED", entityId: row.id,
          identityId: "gustavo-main", topologyVersion: TOPOLOGY_VERSION,
          sourceHighWater: rowHighWater, stateVersion: row.main_state_version,
          policyVersion: row.policy_version, schemaVersion: CACHE_SCHEMA_VERSION,
        },
        versionOrdinal: row.ingested_sequence,
        value: frozen({
          kind: "SCHEDULED_BROADCAST", broadcastId: row.id,
          mainStateVersion: row.main_state_version, body: broadcastBody,
          bodyDigest: row.body_digest, sourceIds: row.source_ids,
          sourceEventIds: [row.commit_event_id], sourceHighWater: rowHighWater,
          committedAt: row.committed_at.toISOString(),
        }),
        sourceRowCount: 1,
      }));
    }
    for (const row of nodes) records.push(await nodeProjectionRecord(transaction, row));
    for (const row of handoffs) {
      try {
        records.push(await handoffProjectionRecord(transaction, row));
      } catch (error) {
        if (!deniedProtectedProjection(error)) throw error;
      }
    }
    for (const row of challenges) {
      const rowHighWater = `e${row.high_water_sequence}`;
      records.push(record({
        id: `05-challenge:${row.stage_id}`,
        key: {
          namespace: "challenge-snapshot", scope: "SHARED", entityId: row.stage_id,
          identityId: "gustavo-main", topologyVersion: TOPOLOGY_VERSION,
          sourceHighWater: rowHighWater, stateVersion: row.high_water_sequence,
          policyVersion: row.profile_version_id, schemaVersion: CACHE_SCHEMA_VERSION,
        },
        versionOrdinal: row.high_water_sequence,
        value: frozen({
          kind: "CHALLENGE_SNAPSHOT", stageId: row.stage_id,
          profileVersionId: row.profile_version_id,
          sourceEventIds: [row.high_water_event_id], sourceHighWater: rowHighWater,
          highWaterSequence: row.high_water_sequence, projection: row.projection,
          simulationLabel: "SIMULATION ONLY — NOT A REAL TRADE",
          rebuiltAt: row.rebuilt_at.toISOString(),
        }),
        sourceRowCount: 1,
      }));
    }
    return Object.freeze(records.sort((left, right) => left.id.localeCompare(right.id)));
  });
}

class PostgresProjectionSource implements CriticalProjectionSource, CacheChangeSource {
  readonly name = "POSTGRES" as const;
  readonly #database: EventDatabase;
  readonly #snapshots = new Map<string, readonly CriticalProjectionRecord[]>();

  constructor(database: EventDatabase) {
    this.#database = database;
  }

  async readManifest(checkpoint: string): Promise<CriticalProjectionManifest> {
    if (checkpoint !== "CURRENT" && !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/u.test(checkpoint)) {
      throw new Error("CACHE_REBUILD_CHECKPOINT_INVALID");
    }
    const records = await projectionRecords(this.#database);
    this.#snapshots.clear();
    this.#snapshots.set(checkpoint, records);
    return Object.freeze({
      checkpoint,
      sourceHighWater: maxHighWater(records.map((item) => item.key.sourceHighWater)),
      recordCount: records.length,
      manifestHash: projectionManifestHash(records),
      categories: projectionCategoryManifests(records),
    });
  }

  async readPage(input: { readonly checkpoint: string; readonly afterId: string | null; readonly limit: number }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("CACHE_REBUILD_PAGE_LIMIT_INVALID");
    }
    if (!this.#snapshots.has(input.checkpoint)) await this.readManifest(input.checkpoint);
    const records = this.#snapshots.get(input.checkpoint)!;
    const remaining = records.filter((item) => input.afterId === null || item.id > input.afterId);
    const page = remaining.slice(0, input.limit);
    return Object.freeze({
      records: page,
      nextCursor: remaining.length > input.limit ? page.at(-1)!.id : null,
    });
  }

  async #currentMain(): Promise<CriticalProjectionRecord | null> {
    return this.#database.transaction(async (transaction) => {
      await transaction.query("set transaction isolation level repeatable read");
      const current = await transaction.one<{ readonly version: string | null }>(
        "select max(version)::text version from main_state_versions where status='COMMITTED'",
      );
      const rows = await transaction.query<BroadcastRow>(
        `select broadcast.id::text,broadcast.main_state_version::text,broadcast.body_digest,
                broadcast.source_ids,broadcast.policy_version,broadcast.commit_event_id::text,
                broadcast.committed_at,source.source_ingestion_ordinal::text ingested_sequence
         from main_state_versions state
         join cache_main_state_sources source on source.main_state_version=state.version
         join broadcasts broadcast on broadcast.commit_event_id=source.source_event_id
         where state.status='COMMITTED'
         order by state.version desc limit 1`,
      );
      const row = rows[0];
      if (current.version !== null && row?.main_state_version !== current.version) {
        throw new Error("CACHE_MAIN_STATE_CANONICAL_SOURCE_MISSING");
      }
      if (!row) return null;
      const highWater = `e${row.ingested_sequence}`;
      return record({
        id: `01-main:${row.main_state_version}`,
        key: {
          namespace: "main-state", scope: "SHARED", entityId: "gustavo-main",
          identityId: "gustavo-main", topologyVersion: TOPOLOGY_VERSION,
          sourceHighWater: highWater, stateVersion: row.main_state_version,
          policyVersion: row.policy_version, schemaVersion: CACHE_SCHEMA_VERSION,
        },
        versionOrdinal: row.main_state_version,
        value: frozen({
          kind: "MAIN_STATE", mainStateVersion: row.main_state_version,
          sourceEventIds: [row.commit_event_id], sourceHighWater: highWater,
          committedAt: row.committed_at.toISOString(),
        }),
        sourceRowCount: 1,
      });
    });
  }

  async #exactBroadcast(
    eventId: string,
    category: "MAIN_STATE" | "BROADCASTS",
  ): Promise<CriticalProjectionRecord | null> {
    if (category === "MAIN_STATE") return this.#currentMain();
    const rows = await this.#database.query<BroadcastRow>(
      `select broadcast.id::text,broadcast.main_state_version::text,broadcast.body_digest,
              broadcast.source_ids,broadcast.policy_version,broadcast.commit_event_id::text,
              broadcast.committed_at,event.ingested_sequence::text
       from broadcasts broadcast join events event on event.id=broadcast.commit_event_id
       where broadcast.commit_event_id=$1 limit 1`,
      [eventId],
    );
    const row = rows[0];
    if (!row) return null;
    const highWater = `e${row.ingested_sequence}`;
    const body = await readEventBody(this.#database, row.commit_event_id, {
      actor: { role: "SYSTEM" },
    });
    const broadcastBody = objectValue(body) && typeof body.body === "string" ? body.body : null;
    if (broadcastBody === null) throw new Error("CACHE_BROADCAST_SOURCE_INVALID");
    return record({
      id: `02-broadcast:${row.id}`,
      key: {
        namespace: "broadcast", scope: "SHARED", entityId: row.id,
        identityId: "gustavo-main", topologyVersion: TOPOLOGY_VERSION,
        sourceHighWater: highWater, stateVersion: row.main_state_version,
        policyVersion: row.policy_version, schemaVersion: CACHE_SCHEMA_VERSION,
      },
      versionOrdinal: row.ingested_sequence,
      value: frozen({
        kind: "SCHEDULED_BROADCAST", broadcastId: row.id,
        mainStateVersion: row.main_state_version, body: broadcastBody,
        bodyDigest: row.body_digest, sourceIds: row.source_ids,
        sourceEventIds: [row.commit_event_id], sourceHighWater: highWater,
        committedAt: row.committed_at.toISOString(),
      }),
      sourceRowCount: 1,
    });
  }

  async #exactNode(eventId: string): Promise<CriticalProjectionRecord | null> {
    return this.#database.transaction(async (transaction) => {
      const rows = await transaction.query<NodeRow>(
        `select account.id::text account_id,node.id::text node_brain_id,
                conversation.id::text conversation_id,latest.id::text event_id,
                latest.occurred_at,latest.ingested_sequence::text,
                coalesce(latest.policy_version,'node-routing-v1') policy_version
         from events source
         join conversations conversation on conversation.id::text=source.aggregate_id
           and conversation.status='OPEN'
         join node_brains node on node.id=conversation.node_brain_id
           and node.id::text=source.actor_id and node.status='ACTIVE'
         join accounts account on account.id=node.account_id
           and account.id=conversation.account_id and account.id::text=source.account_id
           and account.status='ACTIVE'
         join lateral (select entitlement.id from entitlements entitlement
           where entitlement.account_id=account.id and entitlement.revoked_at is null
             and entitlement.active_from<=clock_timestamp()
             and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
           order by entitlement.active_from desc,entitlement.id limit 1 for share) entitlement on true
         join lateral (select event.* from events event
           where event.aggregate_id=conversation.id::text
             and event.account_id=account.id::text and event.actor_type='NODE_BRAIN'
             and event.actor_id=node.id::text and event.type='node.reply.routed'
             and event.visibility='PRIVATE_ACCOUNT'
           order by event.ingested_sequence desc,event.id desc limit 1) latest on true
         where source.id=$1 and source.type='node.reply.routed'
           and source.actor_type='NODE_BRAIN' and source.visibility='PRIVATE_ACCOUNT'
         for share of source,conversation,node,account`,
        [eventId],
      );
      return rows[0] ? nodeProjectionRecord(transaction, rows[0]) : null;
    });
  }

  async #exactHandoff(eventId: string): Promise<CriticalProjectionRecord | null> {
    const identities = await this.#database.query<{
      readonly account_id: string;
      readonly node_brain_id: string;
      readonly conversation_id: string;
    } & Record<string, unknown>>(
      `select packet.account_id::text,packet.node_brain_id::text,
              packet.conversation_id::text
       from handoff_packets packet where packet.packet_event_id=$1
       union all
       select checkpoint.account_id::text,checkpoint.node_brain_id::text,
              checkpoint.conversation_id::text
       from handoff_refresh_checkpoints checkpoint where checkpoint.checkpoint_event_id=$1
       limit 1`,
      [eventId],
    );
    const identity = identities[0];
    if (!identity) return null;
    const packets = await this.#database.query<HandoffRow>(
      `select packet.id::text,packet.account_id::text,packet.node_brain_id::text,
              packet.conversation_id::text,packet.packet_event_id::text source_event_id,
              packet.through_event_id::text,packet.source_high_water_sequence::text,
              packet.main_state_version::text,packet.node_state_version,
              packet.packet_version::text version,'PACKET'::text packet_kind,
              packet.idea_count,packet.policy_version,packet.created_at occurred_at
       from handoff_packets packet
       where packet.account_id=$1 and packet.node_brain_id=$2 and packet.conversation_id=$3
       order by packet.source_high_water_sequence desc,packet.packet_version desc,packet.id
       limit 1`,
      [identity.account_id, identity.node_brain_id, identity.conversation_id],
    );
    const checkpoints = await this.#database.query<HandoffRow>(
      `select checkpoint.id::text,checkpoint.account_id::text,
                checkpoint.node_brain_id::text,checkpoint.conversation_id::text,
                checkpoint.checkpoint_event_id::text source_event_id,
                checkpoint.through_event_id::text,
                checkpoint.source_high_water_sequence::text,
                checkpoint.main_state_version::text,checkpoint.node_state_version,
                checkpoint.checkpoint_version::text version,
                'EMPTY_CHECKPOINT'::text packet_kind,0 idea_count,
                checkpoint.policy_version,checkpoint.created_at occurred_at
         from handoff_refresh_checkpoints checkpoint
         join accounts account on account.id=checkpoint.account_id and account.status='ACTIVE'
         join lateral (select entitlement.id from entitlements entitlement
           where entitlement.account_id=account.id and entitlement.revoked_at is null
             and entitlement.active_from<=clock_timestamp()
             and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
           order by entitlement.active_from desc,entitlement.id limit 1 for share) entitlement on true
         join node_brains node on node.id=checkpoint.node_brain_id
           and node.account_id=account.id and node.status='ACTIVE'
         join conversations conversation on conversation.id=checkpoint.conversation_id
           and conversation.account_id=account.id and conversation.node_brain_id=node.id
           and conversation.status='OPEN'
         where checkpoint.account_id=$1 and checkpoint.node_brain_id=$2
           and checkpoint.conversation_id=$3
         order by checkpoint.source_high_water_sequence desc,
                  checkpoint.checkpoint_version desc,checkpoint.id
         limit 1`,
      [identity.account_id, identity.node_brain_id, identity.conversation_id],
    );
    const row = [...packets, ...checkpoints].sort((left, right) => {
      const highWater = BigInt(right.source_high_water_sequence)
        - BigInt(left.source_high_water_sequence);
      if (highWater !== 0n) return highWater > 0n ? 1 : -1;
      return right.version.localeCompare(left.version);
    })[0];
    if (!row) return null;
    try {
      return await handoffProjectionRecord(this.#database, row);
    } catch (error) {
      if (deniedProtectedProjection(error)) return null;
      throw error;
    }
  }

  async #exactChallenge(eventId: string): Promise<CriticalProjectionRecord | null> {
    const rows = await this.#database.query<ChallengeRow>(
      `select stage_id::text,profile_version_id::text,high_water_event_id::text,
              high_water_sequence::text,projection,rebuilt_at
       from challenge_projection_checkpoints where high_water_event_id=$1 limit 1`,
      [eventId],
    );
    const row = rows[0];
    if (!row) return null;
    const highWater = `e${row.high_water_sequence}`;
    return record({
      id: `05-challenge:${row.stage_id}`,
      key: {
        namespace: "challenge-snapshot", scope: "SHARED", entityId: row.stage_id,
        identityId: "gustavo-main", topologyVersion: TOPOLOGY_VERSION,
        sourceHighWater: highWater, stateVersion: row.high_water_sequence,
        policyVersion: row.profile_version_id, schemaVersion: CACHE_SCHEMA_VERSION,
      },
      versionOrdinal: row.high_water_sequence,
      value: frozen({
        kind: "CHALLENGE_SNAPSHOT", stageId: row.stage_id,
        profileVersionId: row.profile_version_id,
        sourceEventIds: [row.high_water_event_id], sourceHighWater: highWater,
        highWaterSequence: row.high_water_sequence, projection: row.projection,
        simulationLabel: "SIMULATION ONLY — NOT A REAL TRADE",
        rebuiltAt: row.rebuilt_at.toISOString(),
      }),
      sourceRowCount: 1,
    });
  }

  async #staleInvalidation(
    eventId: string,
    category: CacheProjectionCategory,
    topic: string,
  ): Promise<CacheProjectionChange> {
    interface InvalidationRow extends Record<string, unknown> {
      readonly namespace: CachePointerKeyInput["namespace"];
      readonly scope: CachePointerKeyInput["scope"];
      readonly entity_id: string;
      readonly identity_id: string;
      readonly policy_version: string;
      readonly through_ordinal: string;
    }
    let sql: string;
    if (category === "MAIN_STATE" || category === "BROADCASTS") {
      sql = category === "MAIN_STATE"
        ? `select 'main-state' namespace,'SHARED' scope,'gustavo-main' entity_id,
                  'gustavo-main' identity_id,broadcast.policy_version,
                  broadcast.main_state_version::text through_ordinal
           from broadcasts broadcast where broadcast.commit_event_id=$1 limit 1`
        : `select 'broadcast' namespace,'SHARED' scope,broadcast.id::text entity_id,
                  'gustavo-main' identity_id,broadcast.policy_version,
                  event.ingested_sequence::text through_ordinal
           from broadcasts broadcast join events event on event.id=broadcast.commit_event_id
           where broadcast.commit_event_id=$1 limit 1`;
    } else if (category === "NODE_DOSSIERS") {
      sql = `select 'node-dossier' namespace,'PRIVATE_ACCOUNT' scope,event.aggregate_id entity_id,
                    event.account_id::text identity_id,coalesce(event.policy_version,'node-routing-v1') policy_version,
                    event.ingested_sequence::text through_ordinal
             from events event where event.id=$1 and event.type='node.reply.routed' limit 1`;
    } else if (category === "NODE_HANDOFFS") {
      sql = `select 'handoff' namespace,'PRIVATE_ACCOUNT' scope,source.conversation_id::text entity_id,
                    source.account_id::text identity_id,source.policy_version,
                    source.source_high_water_sequence::text through_ordinal
             from (
               select account_id,conversation_id,policy_version,source_high_water_sequence,
                      packet_event_id source_event_id
               from handoff_packets where packet_event_id=$1
               union all
               select account_id,conversation_id,policy_version,source_high_water_sequence,
                      checkpoint_event_id
               from handoff_refresh_checkpoints where checkpoint_event_id=$1
             ) source limit 1`;
    } else {
      sql = `select 'challenge-snapshot' namespace,'SHARED' scope,ledger.stage_id::text entity_id,
                    'gustavo-main' identity_id,ledger.profile_version_id::text policy_version,
                    ledger.sequence::text through_ordinal
             from challenge_ledger_events ledger where ledger.id=$1 limit 1`;
    }
    const rows = await this.#database.query<InvalidationRow>(sql, [eventId]);
    const row = rows[0];
    if (!row) throw new Error("CACHE_CHANGE_SOURCE_NOT_FOUND");
    return Object.freeze({
      action: "INVALIDATE",
      triggerEventId: eventId,
      sourceTopic: topic,
      pointer: Object.freeze({
        namespace: row.namespace,
        scope: row.scope,
        entityId: row.entity_id,
        identityId: row.identity_id,
        topologyVersion: TOPOLOGY_VERSION,
        policyVersion: row.policy_version,
        schemaVersion: CACHE_SCHEMA_VERSION,
      }),
      throughOrdinal: row.through_ordinal,
    });
  }

  async #authorityInvalidation(
    eventId: string,
    category: "NODE_DOSSIERS" | "NODE_HANDOFFS",
    topic: string,
  ): Promise<CacheProjectionChange> {
    const rows = await this.#database.query<{
      readonly account_id: string;
      readonly conversation_id: string;
      readonly policy_version: string;
      readonly through_ordinal: string;
    } & Record<string, unknown>>(
      category === "NODE_DOSSIERS"
        ? `select account_id::text,conversation_id::text,
                  dossier_policy_version policy_version,
                  dossier_through_ordinal::text through_ordinal
           from cache_authority_changes
           where event_id=$1 and dossier_policy_version is not null limit 1`
        : `select account_id::text,conversation_id::text,
                  handoff_policy_version policy_version,
                  handoff_through_ordinal::text through_ordinal
           from cache_authority_changes
           where event_id=$1 and handoff_policy_version is not null limit 1`,
      [eventId],
    );
    const row = rows[0];
    if (!row) throw new Error("CACHE_AUTHORITY_CHANGE_NOT_FOUND");
    return Object.freeze({
      action: "INVALIDATE",
      triggerEventId: eventId,
      sourceTopic: topic,
      pointer: Object.freeze({
        namespace: category === "NODE_DOSSIERS" ? "node-dossier" : "handoff",
        scope: "PRIVATE_ACCOUNT",
        entityId: row.conversation_id,
        identityId: row.account_id,
        topologyVersion: TOPOLOGY_VERSION,
        policyVersion: row.policy_version,
        schemaVersion: CACHE_SCHEMA_VERSION,
      }),
      throughOrdinal: row.through_ordinal,
    });
  }

  async #proposalRevocationInvalidation(
    eventId: string,
    topic: string,
  ): Promise<CacheProjectionChange> {
    const rows = await this.#database.query<{
      readonly account_id: string;
      readonly conversation_id: string;
      readonly policy_version: string;
      readonly through_ordinal: string;
    } & Record<string, unknown>>(
      `select disclosure.account_id::text,disclosure.conversation_id::text,
              latest.policy_version,latest.source_high_water_sequence::text through_ordinal
       from events revoked
       join proposal_disclosure_authorizations disclosure
         on disclosure.id::text=revoked.aggregate_id
       join lateral (
         select source.policy_version,source.source_high_water_sequence
         from (
           select packet.policy_version,packet.source_high_water_sequence,packet.id
           from handoff_packets packet
           where packet.account_id=disclosure.account_id
             and packet.conversation_id=disclosure.conversation_id
           union all
           select checkpoint.policy_version,checkpoint.source_high_water_sequence,checkpoint.id
           from handoff_refresh_checkpoints checkpoint
           where checkpoint.account_id=disclosure.account_id
             and checkpoint.conversation_id=disclosure.conversation_id
         ) source
         order by source.source_high_water_sequence desc,source.id desc limit 1
       ) latest on true
       where revoked.id=$1 and revoked.type='proposal.disclosure.revoked' limit 1`,
      [eventId],
    );
    const row = rows[0];
    if (!row) throw new Error("CACHE_DISCLOSURE_REVOCATION_NOT_FOUND");
    return Object.freeze({
      action: "INVALIDATE",
      triggerEventId: eventId,
      sourceTopic: topic,
      pointer: Object.freeze({
        namespace: "handoff",
        scope: "PRIVATE_ACCOUNT",
        entityId: row.conversation_id,
        identityId: row.account_id,
        topologyVersion: TOPOLOGY_VERSION,
        policyVersion: row.policy_version,
        schemaVersion: CACHE_SCHEMA_VERSION,
      }),
      throughOrdinal: row.through_ordinal,
    });
  }

  async loadChange(eventId: string, input: {
    readonly topic: string;
    readonly maxRows: number;
    readonly category?: CacheProjectionCategory;
  }, database?: EventDatabase): Promise<CacheProjectionChange> {
    if (database !== undefined && database !== this.#database) {
      return new PostgresProjectionSource(database).loadChange(eventId, input);
    }
    if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > 1_000) {
      throw new Error("CACHE_CHANGE_SOURCE_BOUND_INVALID");
    }
    const barred = await this.#database.query(
      `select 1 from privacy_forget_barriers barrier where
         exists (select 1 from events event where event.id=$1
           and event.aggregate_id=barrier.conversation_id::text)
         or exists (select 1 from cache_authority_changes authority where authority.event_id=$1
           and authority.conversation_id=barrier.conversation_id)
       limit 1`,
      [eventId],
    );
    if (barred.length > 0) throw new Error("CACHE_PRIVACY_BARRIER");
    if (input.topic.startsWith("cache.authority.")) {
      if (input.category !== "NODE_DOSSIERS" && input.category !== "NODE_HANDOFFS") {
        throw new Error("CACHE_AUTHORITY_CHANGE_CATEGORY_INVALID");
      }
      return this.#authorityInvalidation(eventId, input.category, input.topic);
    }
    if (input.topic === "proposal.disclosure.revoked") {
      if (input.category !== undefined && input.category !== "NODE_HANDOFFS") {
        throw new Error("CACHE_DISCLOSURE_REVOCATION_CATEGORY_INVALID");
      }
      return this.#proposalRevocationInvalidation(eventId, input.topic);
    }
    const category = input.category ?? (
      input.topic === "main.broadcast.committed" ? "BROADCASTS"
        : input.topic === "node.reply.routed" ? "NODE_DOSSIERS"
          : input.topic.startsWith("node.handoff.") ? "NODE_HANDOFFS" : "CHALLENGE"
    );
    const recordForEvent = category === "MAIN_STATE" || category === "BROADCASTS"
      ? await this.#exactBroadcast(eventId, category)
      : category === "NODE_DOSSIERS" ? await this.#exactNode(eventId)
        : category === "NODE_HANDOFFS" ? await this.#exactHandoff(eventId)
          : await this.#exactChallenge(eventId);
    if (!recordForEvent) {
      return this.#staleInvalidation(eventId, category, input.topic);
    }
    return Object.freeze({
      action: "PREWARM",
      triggerEventId: eventId,
      recordSourceEventId: projectionRecordSourceEventId(recordForEvent),
      sourceTopic: input.topic,
      record: recordForEvent,
    });
  }
}

export function createPostgresProjectionSource(database: EventDatabase): CriticalProjectionSource & CacheChangeSource {
  return new PostgresProjectionSource(database);
}

function categories(value: readonly CacheProjectionCategory[] | undefined): readonly CacheProjectionCategory[] {
  const selected = value ?? CACHE_REQUIRED_CATEGORIES;
  if (selected.length === 0 || selected.some((item) => !CATEGORY_SET.has(item))) {
    throw new Error("CACHE_JOB_CATEGORY_INVALID");
  }
  return Object.freeze([...new Set(selected)]);
}

interface JobRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_id: string;
  readonly topic: string;
  readonly category: CacheProjectionCategory;
  readonly created_at: Date;
  readonly worker_id: string;
  readonly lease_token: string;
  readonly lease_until: Date;
  readonly attempts: number;
}

class PostgresCacheJobRepository implements CacheJobRepository {
  readonly #database: EventDatabase;
  readonly #categories: readonly CacheProjectionCategory[];

  constructor(database: EventDatabase, selected?: readonly CacheProjectionCategory[]) {
    this.#database = database;
    this.#categories = categories(selected);
  }

  async claim(workerId: string, leaseMs: number): Promise<CacheJobClaim | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(workerId)) throw new Error("CACHE_JOB_WORKER_ID_INVALID");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("CACHE_JOB_LEASE_INVALID");
    return this.#database.transaction(async (transaction) => {
      await transaction.query(
        `update cache_projection_jobs job
         set status='FAILED',worker_id=null,lease_token=null,lease_until=null,
             available_at=clock_timestamp(),completed_at=null,error_code='PRIVACY_FORGET_BARRIER'
         where job.status in ('PENDING','CLAIMED','RETRY_SCHEDULED') and exists (
           select 1 from privacy_forget_barriers barrier where
             exists (select 1 from events event where event.id=job.event_id
               and event.aggregate_id=barrier.conversation_id::text)
             or exists (select 1 from cache_authority_changes authority
               where authority.event_id=job.event_id
                 and authority.conversation_id=barrier.conversation_id)
         )`,
      );
      const rows = await transaction.query<JobRow>(
        `with candidate as (
           select id from cache_projection_jobs
           where category=any($1::text[]) and (
             status='PENDING'
             or (status='RETRY_SCHEDULED' and available_at<=clock_timestamp())
             or (status='CLAIMED' and lease_until<=clock_timestamp())
           )
           and not exists (
             select 1 from privacy_forget_barriers barrier where
               exists (select 1 from events event where event.id=cache_projection_jobs.event_id
                 and event.aggregate_id=barrier.conversation_id::text)
               or exists (select 1 from cache_authority_changes authority
                 where authority.event_id=cache_projection_jobs.event_id
                   and authority.conversation_id=barrier.conversation_id)
           )
           order by available_at,created_at,id for update skip locked limit 1
         )
         update cache_projection_jobs job set status='CLAIMED',attempts=attempts+1,
           worker_id=$2,lease_token=$3,lease_until=clock_timestamp()+($4::int*interval '1 millisecond'),
           available_at=clock_timestamp(),error_code=null,completed_at=null
         from candidate where job.id=candidate.id
         returning job.id::text,job.event_id::text,job.topic,job.category,job.created_at,
                   job.worker_id,job.lease_token::text,job.lease_until,job.attempts`,
        [this.#categories, workerId, randomUUID(), leaseMs],
      );
      const row = rows[0];
      if (!row) return null;
      const message: CacheOutboxMessage = Object.freeze({
        outboxId: row.id, eventId: row.event_id, topic: row.topic,
        payload: Object.freeze({ eventId: row.event_id }), createdAt: row.created_at.toISOString(),
        category: row.category,
      });
      return Object.freeze({
        jobId: row.id, message, workerId: row.worker_id, leaseToken: row.lease_token,
        leaseUntil: row.lease_until.toISOString(), attempt: row.attempts,
      });
    });
  }

  async guardTarget(claim: CacheJobClaim): Promise<{
    readonly key: ReturnType<typeof cachePointerKey>;
    readonly operation: "WRITE" | "INVALIDATE";
  } | null> {
    if (claim.message.category !== "NODE_DOSSIERS"
        && claim.message.category !== "NODE_HANDOFFS") return null;
    const rows = await this.#database.query<{
      readonly account_id: string;
      readonly conversation_id: string;
    } & Record<string, unknown>>(
      `with claimed as (
         select job.event_id,job.topic,job.category
         from cache_projection_jobs job
         where job.id=$1 and job.event_id=$2 and job.status='CLAIMED'
           and job.worker_id=$3 and job.lease_token=$4
           and job.lease_until>clock_timestamp()
       ), resolved as (
         select conversation.account_id,conversation.id conversation_id
         from claimed join events event on event.id=claimed.event_id
         join conversations conversation on conversation.id::text=event.aggregate_id
           and conversation.account_id::text=event.account_id
         union
         select packet.account_id,packet.conversation_id
         from claimed join handoff_packets packet on packet.packet_event_id=claimed.event_id
         union
         select checkpoint.account_id,checkpoint.conversation_id
         from claimed join handoff_refresh_checkpoints checkpoint
           on checkpoint.checkpoint_event_id=claimed.event_id
         union
         select authority.account_id,authority.conversation_id
         from claimed join cache_authority_changes authority
           on authority.event_id=claimed.event_id
         union
         select disclosure.account_id,disclosure.conversation_id
         from claimed join events event on event.id=claimed.event_id
           and event.type='proposal.disclosure.revoked'
         join proposal_disclosure_authorizations disclosure
           on disclosure.id::text=event.aggregate_id
       )
       select account_id::text,conversation_id::text from resolved limit 2`,
      [claim.jobId, claim.message.eventId, claim.workerId, claim.leaseToken],
    );
    if (rows.length !== 1) throw new Error("CACHE_JOB_PROTECTED_SCOPE_INVALID");
    const namespace = claim.message.category === "NODE_DOSSIERS"
      ? "node-dossier" as const : "handoff" as const;
    return Object.freeze({
      key: cachePointerKey({
        namespace,
        scope: "PRIVATE_ACCOUNT",
        entityId: rows[0]!.conversation_id,
        identityId: rows[0]!.account_id,
        topologyVersion: TOPOLOGY_VERSION,
        policyVersion: "privacy-cache-fence-v1",
        schemaVersion: CACHE_SCHEMA_VERSION,
      }),
      operation: claim.message.topic.startsWith("cache.authority.")
          || claim.message.topic === "proposal.disclosure.revoked"
        ? "INVALIDATE" : "WRITE",
    });
  }

  async #transition(claim: CacheJobClaim, status: "RETRY_SCHEDULED" | "FAILED", errorCode: string) {
    const delay = status === "RETRY_SCHEDULED" ? Math.min(60_000, 250 * (2 ** Math.max(0, claim.attempt - 1))) : 0;
    const rows = await this.#database.query<{ readonly id: string }>(
      `update cache_projection_jobs set status=$1,available_at=clock_timestamp()+($2::int*interval '1 millisecond'),
         worker_id=null,lease_token=null,lease_until=null,error_code=$3
       where id=$4 and status='CLAIMED' and worker_id=$5 and lease_token=$6
         and lease_until>clock_timestamp() and not exists (
           select 1 from privacy_forget_barriers barrier where
             exists (select 1 from events event where event.id=cache_projection_jobs.event_id
               and event.aggregate_id=barrier.conversation_id::text)
             or exists (select 1 from cache_authority_changes authority
               where authority.event_id=cache_projection_jobs.event_id
                 and authority.conversation_id=barrier.conversation_id)
         ) returning id::text`,
      [status, delay, errorCode.slice(0, 128), claim.jobId, claim.workerId, claim.leaseToken],
    );
    if (rows.length !== 1) throw new Error("CACHE_JOB_CLAIM_STALE");
  }

  async #complete(
    transaction: EventDatabase,
    claim: CacheJobClaim,
    change?: CacheProjectionChange,
  ): Promise<void> {
    if (change?.action === "PREWARM") {
      const category = projectionCategory(change.record);
      const inserted = await transaction.query<{ readonly id: string }>(
        `insert into cache_projection_versions (
           job_id,category,entity_id,source_event_id,source_high_water,version_ordinal,content_hash
         ) select $1,$2,$3,$4,$5,$6,$7
         where exists (
           select 1 from cache_projection_jobs where id=$1 and status='CLAIMED'
             and worker_id=$8 and lease_token=$9 and lease_until>clock_timestamp()
             and not exists (
               select 1 from privacy_forget_barriers barrier where
                 exists (select 1 from events event
                   where event.id=cache_projection_jobs.event_id
                     and event.aggregate_id=barrier.conversation_id::text)
                 or exists (select 1 from cache_authority_changes authority
                   where authority.event_id=cache_projection_jobs.event_id
                     and authority.conversation_id=barrier.conversation_id)
             )
         ) on conflict do nothing returning id::text`,
        [claim.jobId, category, change.record.key.entityId, change.recordSourceEventId,
          change.record.key.sourceHighWater, change.record.versionOrdinal, change.record.contentHash,
          claim.workerId, claim.leaseToken],
      );
      if (inserted.length === 0) {
        const existing = await transaction.query<{ readonly content_hash: string }>(
          `select content_hash from cache_projection_versions
           where category=$1 and entity_id=$2 and source_high_water=$3 and version_ordinal=$4`,
          [category, change.record.key.entityId, change.record.key.sourceHighWater,
            change.record.versionOrdinal],
        );
        if (existing[0] && existing[0].content_hash !== change.record.contentHash) {
          throw new Error("CACHE_PROJECTION_VERSION_CONFLICT");
        }
      }
    }
    const rows = await transaction.query<{ readonly id: string }>(
      `update cache_projection_jobs set status='COMPLETED',worker_id=null,lease_token=null,
         lease_until=null,completed_at=clock_timestamp(),error_code=null
       where id=$1 and status='CLAIMED' and worker_id=$2 and lease_token=$3
         and lease_until>clock_timestamp() and not exists (
           select 1 from privacy_forget_barriers barrier where
             exists (select 1 from events event where event.id=cache_projection_jobs.event_id
               and event.aggregate_id=barrier.conversation_id::text)
             or exists (select 1 from cache_authority_changes authority
               where authority.event_id=cache_projection_jobs.event_id
                 and authority.conversation_id=barrier.conversation_id)
         ) returning id::text`,
      [claim.jobId, claim.workerId, claim.leaseToken],
    );
    if (rows.length !== 1) throw new Error("CACHE_JOB_CLAIM_STALE");
  }

  async complete(
    claim: CacheJobClaim,
    change?: CacheProjectionChange,
    database?: EventDatabase,
  ): Promise<void> {
    if (database !== undefined) {
      await this.#complete(database, claim, change);
      return;
    }
    await this.#database.transaction((transaction) => this.#complete(transaction, claim, change));
  }

  async retry(claim: CacheJobClaim, errorCode: string): Promise<void> {
    await this.#transition(claim, "RETRY_SCHEDULED", errorCode);
  }

  async fail(claim: CacheJobClaim, errorCode: string): Promise<void> {
    await this.#transition(claim, "FAILED", errorCode);
  }
}

export function createPostgresCacheJobRepository(
  database: EventDatabase,
  options: { readonly categories?: readonly CacheProjectionCategory[] } = {},
): CacheJobRepository {
  return new PostgresCacheJobRepository(database, options.categories);
}

export async function synchronizeCanonicalCacheJobs(
  database: EventDatabase,
  input: { readonly limit: number },
): Promise<Readonly<{
  inserted: number;
  scanned: number;
  backfilled: number;
  backlog: boolean;
}>> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
    throw new Error("CACHE_JOB_SYNC_LIMIT_INVALID");
  }
  return database.transaction(async (transaction) => {
    const backfillState = await transaction.one<{
      readonly boundary_ingested_sequence: string;
      readonly last_ingested_sequence: string;
      readonly completed: boolean;
    }>(
      `select boundary_ingested_sequence::text,last_ingested_sequence::text,completed
       from cache_outbox_backfill_state where singleton=true for update`,
    );
    let backfilledOutbox = 0;
    let backfillCompleted = backfillState.completed;
    if (!backfillState.completed) {
      const legacy = await transaction.query<{
        readonly outbox_id: string;
        readonly event_id: string;
        readonly topic: string;
        readonly event_ingested_sequence: string;
        readonly source_created_at: Date;
      }>(
        `/* cache-canonical-outbox-backfill: fixed migration boundary, bounded keyset */
         select outbox.id::text outbox_id,outbox.event_id::text,outbox.topic,
                event.ingested_sequence::text event_ingested_sequence,
                outbox.created_at source_created_at
         from transactional_outbox outbox join events event on event.id=outbox.event_id
         where event.ingested_sequence > $1 and event.ingested_sequence <= $2
           and outbox.topic=any($3::text[])
           and not exists (select 1 from privacy_forget_barriers barrier
             where barrier.conversation_id::text=event.aggregate_id)
         order by event.ingested_sequence,outbox.id limit $4`,
        [backfillState.last_ingested_sequence, backfillState.boundary_ingested_sequence,
          CACHE_OUTBOX_TOPICS, input.limit],
      );
      if (legacy.length > 0) {
        const inserted = await transaction.query(
          `insert into cache_outbox_staging (
             outbox_id,event_id,topic,event_ingested_sequence,source_created_at
           ) values ${valuePlaceholders(legacy.length, 5)}
           on conflict (outbox_id) do nothing returning outbox_id`,
          legacy.flatMap((source) => [
            source.outbox_id, source.event_id, source.topic,
            source.event_ingested_sequence, source.source_created_at,
          ]),
        );
        backfilledOutbox = inserted.length;
      }
      const lastIngestedSequence = legacy.at(-1)?.event_ingested_sequence
        ?? backfillState.last_ingested_sequence;
      backfillCompleted = legacy.length < input.limit
        || BigInt(lastIngestedSequence) >= BigInt(backfillState.boundary_ingested_sequence);
      await transaction.query(
        `update cache_outbox_backfill_state
         set last_ingested_sequence=$1,completed=$2,updated_at=clock_timestamp()
         where singleton=true`,
        [lastIngestedSequence, backfillCompleted],
      );
    }
    const outbox = await transaction.query<{
      readonly id: string;
      readonly event_id: string;
      readonly topic: string;
      readonly created_at: Date;
      readonly ingested_sequence: string;
      readonly privacy_barred: boolean;
    }>(
      `/* cache-canonical-outbox-poll: bounded by caller limit */
       select staged.outbox_id::text id,staged.event_id::text,staged.topic,
              staged.source_created_at created_at,
              staged.event_ingested_sequence::text ingested_sequence,
              exists (select 1 from events event join privacy_forget_barriers barrier
                on barrier.conversation_id::text=event.aggregate_id
                where event.id=staged.event_id) privacy_barred
       from cache_outbox_staging staged where staged.processed_at is null
       order by staged.event_ingested_sequence,staged.outbox_id
       for update skip locked limit $1`,
      [input.limit + 1],
    );
    const outboxBacklog = outbox.length > input.limit;
    const consumedOutbox = outbox.slice(0, input.limit);

    const authority = await transaction.query<{
      readonly sequence: string;
      readonly event_id: string;
      readonly topic: string;
      readonly dossier_policy_version: string | null;
      readonly handoff_policy_version: string | null;
      readonly changed_at: Date;
      readonly privacy_barred: boolean;
    }>(
      `/* cache-authority-change-poll: bounded by caller limit */
       select authority.sequence::text,authority.event_id::text,authority.topic,
              authority.dossier_policy_version,authority.handoff_policy_version,
              authority.changed_at,
              exists (select 1 from privacy_forget_barriers barrier
                where barrier.conversation_id=authority.conversation_id) privacy_barred
       from cache_authority_staging staged
       join cache_authority_changes authority
         on authority.event_id=staged.authority_event_id
       where staged.processed_at is null
       order by staged.authority_sequence,staged.authority_event_id
       for update of staged skip locked limit $1`,
      [input.limit + 1],
    );
    const authorityBacklog = authority.length > input.limit;
    const consumedAuthority = authority.slice(0, input.limit);
    const checkpoints = await transaction.query<{
      readonly event_id: string; readonly created_at: Date;
    }>(
      `select high_water_event_id::text event_id,rebuilt_at created_at
       from challenge_projection_checkpoints checkpoint
       where not exists (select 1 from cache_projection_jobs job
         where job.source_kind='CHALLENGE_CHECKPOINT'
           and job.source_id=checkpoint.high_water_event_id and job.category='CHALLENGE')
       order by rebuilt_at,stage_id limit $1`,
      [input.limit],
    );
    const jobs: Array<readonly [
      string, "TRANSACTIONAL_OUTBOX" | "CHALLENGE_CHECKPOINT" | "AUTHORITY_CHANGE",
      string, string | null,
      string, string, CacheProjectionCategory, Date,
    ]> = [];
    for (const source of consumedOutbox) {
      if (source.privacy_barred) continue;
      const selected: readonly CacheProjectionCategory[] = source.topic === "main.broadcast.committed"
        ? ["MAIN_STATE", "BROADCASTS"]
        : source.topic === "node.reply.routed" ? ["NODE_DOSSIERS"]
          : source.topic === "node.handoff.packet.refreshed"
              || source.topic === "node.handoff.checkpoint.advanced"
              || source.topic === "proposal.disclosure.revoked"
            ? ["NODE_HANDOFFS"] : [];
      for (const category of selected) {
        jobs.push([
          deterministicUuid(`cache-job:${source.id}:${category}`), "TRANSACTIONAL_OUTBOX",
          source.id, source.id, source.event_id, source.topic, category, source.created_at,
        ]);
      }
    }
    for (const source of consumedAuthority) {
      if (source.privacy_barred) continue;
      const selected: readonly CacheProjectionCategory[] = [
        ...(source.dossier_policy_version === null ? [] : ["NODE_DOSSIERS"] as const),
        ...(source.handoff_policy_version === null ? [] : ["NODE_HANDOFFS"] as const),
      ];
      for (const category of selected) {
        jobs.push([
          deterministicUuid(`cache-job:authority:${source.event_id}:${category}`),
          "AUTHORITY_CHANGE", source.event_id, null, source.event_id,
          source.topic, category, source.changed_at,
        ]);
      }
    }
    for (const checkpoint of checkpoints) {
      jobs.push([
        deterministicUuid(`cache-job:challenge:${checkpoint.event_id}`), "CHALLENGE_CHECKPOINT",
        checkpoint.event_id, null, checkpoint.event_id, "challenge.projection.checkpointed",
        "CHALLENGE", checkpoint.created_at,
      ]);
    }
    let inserted = 0;
    for (let offset = 0; offset < jobs.length; offset += 500) {
      const batch = jobs.slice(offset, offset + 500);
      const rows = await transaction.query(
        `insert into cache_projection_jobs (
           id,source_kind,source_id,source_outbox_id,event_id,topic,category,created_at
         ) values ${valuePlaceholders(batch.length, 8)}
         on conflict (source_kind,source_id,category) do nothing returning id`,
        batch.flatMap((job) => [...job]),
      );
      inserted += rows.length;
    }
    if (consumedOutbox.length > 0) {
      await transaction.query(
        `update cache_outbox_staging set processed_at=clock_timestamp()
         where outbox_id=any($1::uuid[]) and processed_at is null`,
        [consumedOutbox.map(({ id }) => id)],
      );
    }
    if (consumedAuthority.length > 0) {
      await transaction.query(
        `update cache_authority_staging set processed_at=clock_timestamp()
         where authority_event_id=any($1::uuid[]) and processed_at is null`,
        [consumedAuthority.map(({ event_id }) => event_id)],
      );
    }
    return Object.freeze({
      inserted,
      scanned: consumedOutbox.length,
      backfilled: backfilledOutbox,
      backlog: outboxBacklog || authorityBacklog
        || !backfillCompleted,
    });
  });
}

export async function recordPostgresCacheMetric(
  database: EventDatabase,
  name: string,
  value: number,
  category?: CacheProjectionCategory,
): Promise<void> {
  if (!Number.isFinite(value) || value < 0) throw new Error("CACHE_METRIC_VALUE_INVALID");
  await database.transaction(async (transaction) => {
    await transaction.query(
      `insert into cache_metric_observations (
         name,value,category,topology_version,bucket_start,sample_count,
         value_sum,value_max,observed_at
       ) values (
         $1,$2,$3,$4,date_trunc('minute',clock_timestamp()),1,$2,$2,clock_timestamp()
       )
       on conflict (name,category,topology_version,bucket_start) do update
       set value=excluded.value,
           sample_count=cache_metric_observations.sample_count+1,
           value_sum=cache_metric_observations.value_sum+excluded.value,
           value_max=greatest(cache_metric_observations.value_max,excluded.value),
           observed_at=excluded.observed_at`,
      [name, value, category ?? null, TOPOLOGY_VERSION],
    );
    await transaction.query(
      `delete from cache_metric_observations where id in (
         select id from cache_metric_observations
         where name=$1 and category is not distinct from $2 and topology_version=$3
         order by bucket_start desc,id desc offset $4
       )`,
      [name, category ?? null, TOPOLOGY_VERSION, MAX_METRIC_BUCKETS_PER_SERIES],
    );
  });
}

export interface PostgresCacheMetric {
  readonly name: string;
  readonly value: number;
  readonly category: string | null;
  readonly topologyVersion: string;
  readonly bucketStart: string;
  readonly sampleCount: number;
  readonly averageValue: number;
  readonly maxValue: number;
  readonly observedAt: string;
}

export async function readPostgresCacheMetrics(database: EventDatabase): Promise<readonly PostgresCacheMetric[]> {
  const rows = await database.query<{
    readonly name: string; readonly value: number; readonly category: string | null;
    readonly topology_version: string; readonly bucket_start: Date;
    readonly sample_count: string; readonly value_sum: number; readonly value_max: number;
    readonly observed_at: Date;
  }>(
    `select name,value,category,topology_version,bucket_start,
            sample_count::text,value_sum,value_max,observed_at
     from cache_metric_observations order by observed_at desc,id desc limit 1000`,
  );
  return Object.freeze(rows.map((row) => Object.freeze({
    name: row.name,
    value: row.value,
    category: row.category,
    topologyVersion: row.topology_version,
    bucketStart: row.bucket_start.toISOString(),
    sampleCount: Number(row.sample_count),
    averageValue: row.value_sum / Number(row.sample_count),
    maxValue: row.value_max,
    observedAt: row.observed_at.toISOString(),
  })));
}

export async function persistRebuildVerification(
  database: EventDatabase,
  input: {
    readonly mode: "REBUILD" | "STARTUP_PREWARM";
    readonly checkpoint: string;
    readonly manifest: CriticalProjectionManifest;
    readonly durationMs: number;
  },
): Promise<void> {
  await database.transaction(async (transaction) => {
    const runId = randomUUID();
    await transaction.query(
      `insert into cache_rebuild_runs (
         id,mode,checkpoint,status,record_count,manifest_hash,completed_at
       ) values ($1,$2,$3,'VERIFIED',$4,$5,clock_timestamp())`,
      [runId, input.mode, input.checkpoint, input.manifest.recordCount, input.manifest.manifestHash],
    );
    for (const category of input.manifest.categories) {
      await transaction.query(
        `insert into cache_rebuild_category_checks (
           run_id,category,source_high_water,record_count,manifest_hash,
           high_water_count,high_water_hash,status
         ) values ($1,$2,$3,$4,$5,$6,$7,'VERIFIED')`,
        [runId, category.category, category.sourceHighWater, category.recordCount,
          category.manifestHash, category.highWaterCount, category.highWaterHash],
      );
    }
    await recordPostgresCacheMetric(
      transaction,
      input.mode === "REBUILD" ? "cache.rebuild_latency_ms" : "cache.startup_prewarm_latency_ms",
      input.durationMs,
    );
  });
}
