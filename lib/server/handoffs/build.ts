import type { MemoryScope } from "../memory/types";
import { canonicalContentDigest } from "../events/integrity";
import { lockAvailableMemorySourceBodies, readEventBody } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { getProposal, type ProposalProjection } from "../orchestration/proposals";

export const HANDOFF_POLICY_VERSION = "node-main-handoff-v1";
export const MAX_HANDOFF_IDEAS = 24;
export const MAX_HANDOFF_ITEMS = MAX_HANDOFF_IDEAS * 5;
export const MAX_HANDOFF_SERIALIZED_BYTES = 96 * 1_024;

const HANDOFF_SCOPES = new Set<MemoryScope>([
  "NODE_BRANCH",
  "MAIN_SHARED",
  "CHALLENGE_SHARED",
  "PUBLIC",
]);

const HANDOFF_KINDS = new Set([
  "THESIS",
  "EVIDENCE",
  "COUNTEREVIDENCE",
  "OPEN_QUESTION",
  "RECENT_CHANGE",
]);

export type HandoffItemKind =
  | "THESIS"
  | "EVIDENCE"
  | "COUNTEREVIDENCE"
  | "OPEN_QUESTION"
  | "RECENT_CHANGE";

export interface HandoffMemoryInput {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly transmitted: boolean;
  readonly councilVisible?: boolean;
  readonly kind: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly version?: string;
}

export interface BuildHandoffInput {
  readonly nodeBrainId: string;
  readonly highWaterMark: string;
  readonly memories: readonly HandoffMemoryInput[];
}

export interface HandoffItem {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly kind: HandoffItemKind;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly memoryVersion: string;
}

export interface HandoffPacket {
  readonly nodeBrainId: string;
  readonly highWaterMark: string;
  readonly items: readonly HandoffItem[];
}

export interface HandoffContext {
  readonly db: EventDatabase;
}

export interface LoadHandoffInput {
  readonly packetId: string;
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly scope: "NODE_BRANCH";
  readonly policyVersion: string;
  readonly nodeStateVersion: string;
  readonly mainStateVersion: string;
}

export interface HandoffMemoryVersion {
  readonly memoryId: string;
  readonly version: string;
}

export interface DurableHandoffItem {
  readonly id: string;
  readonly proposalId: string;
  readonly kind: HandoffItemKind;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly memoryVersions: readonly HandoffMemoryVersion[];
}

export interface DurableHandoffPacket {
  readonly id: string;
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly scope: "NODE_BRANCH";
  readonly policyVersion: string;
  readonly nodeStateVersion: string;
  readonly mainStateVersion: string;
  readonly packetVersion: string;
  readonly highWaterSequence: string;
  readonly items: readonly DurableHandoffItem[];
}

interface PacketRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly node_brain_id: string;
  readonly conversation_id: string;
  readonly scope: "NODE_BRANCH";
  readonly policy_version: string;
  readonly node_state_version: string;
  readonly main_state_version: string;
  readonly packet_version: string;
  readonly source_high_water_sequence: string;
  readonly packet_event_id: string;
  readonly body_digest: string;
  readonly idea_count: number;
  readonly source_count: number;
  readonly normalized_idea_count: number;
  readonly normalized_source_count: number;
  readonly normalized_body_digest: string;
  readonly manifest_body_digest: string;
  readonly expected_body: JsonValue;
}

interface IdeaRow extends Record<string, unknown> {
  readonly ordinal: number;
  readonly proposal_id: string;
  readonly proposal_event_id: string;
  readonly proposal_status_event_id: string;
  readonly proposal_status_ordinal: number;
  readonly disclosure_authorization_id: string | null;
  readonly disclosure_revocation_event_id: string | null;
  readonly source_event_ids: string[];
  readonly memory_ids: string[];
  readonly memory_versions: string[];
  readonly content_digest: string;
}

function requiredString(value: unknown, code: string, maximum = 8_000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value !== value.trim() || value.includes("\u0000")) {
    throw new Error(code);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown, code: string): string {
  const result = requiredString(value, code, 36).toLowerCase();
  if (!UUID_PATTERN.test(result)) throw new Error(code);
  return result;
}

function version(value: unknown, code: string): string {
  return requiredString(value, code, 200);
}

function databaseFrom(context: HandoffContext): EventDatabase {
  if (!context || typeof context !== "object" || !context.db) {
    throw new Error("HANDOFF_CONTEXT_INVALID");
  }
  return context.db;
}

export function proposalHandoffContentDigest(proposal: ProposalProjection): string {
  return canonicalContentDigest({
    counterevidence: proposal.counterevidence,
    evidence: proposal.evidence,
    proposedChange: proposal.proposedChange,
    sourceEventIds: proposal.sourceEventIds,
    uncertainty: proposal.uncertainty,
  });
}

function canonicalBodyDigest(body: JsonValue): string {
  return canonicalContentDigest(body);
}

async function acquireHandoffAuthorityLocks(
  database: EventDatabase,
  ideas: readonly IdeaRow[],
): Promise<void> {
  const locks = ideas.flatMap((idea) => [
    `proposal-state:${idea.proposal_id}`,
    ...(idea.disclosure_authorization_id === null
      ? [] : [`proposal-disclosure:${idea.disclosure_authorization_id}`]),
  ]).sort();
  if (locks.length > 0) {
    await database.query(
      "select pg_advisory_xact_lock(hashtextextended(item,0)) from unnest($1::text[]) item order by item",
      [locks],
    );
  }
}

function proposalItems(
  proposal: ProposalProjection,
  idea: IdeaRow,
): readonly DurableHandoffItem[] {
  const memoryVersions = Object.freeze(idea.memory_ids.map((memoryId, index) => Object.freeze({
    memoryId,
    version: idea.memory_versions[index]!,
  })));
  const shared = {
    proposalId: proposal.id,
    sourceIds: Object.freeze([...proposal.sourceEventIds]),
    memoryVersions,
  };
  return Object.freeze([
    Object.freeze({ ...shared, id: `${proposal.id}:thesis`, kind: "THESIS" as const,
      text: proposal.proposedChange }),
    Object.freeze({ ...shared, id: `${proposal.id}:evidence`, kind: "EVIDENCE" as const,
      text: proposal.evidence.map(({ kind, referenceId }) => `${kind}:${referenceId}`).join("\n") }),
    Object.freeze({ ...shared, id: `${proposal.id}:counterevidence`, kind: "COUNTEREVIDENCE" as const,
      text: proposal.counterevidence.length === 0 ? "No counterevidence transmitted."
        : proposal.counterevidence.map(({ kind, referenceId }) => `${kind}:${referenceId}`).join("\n") }),
    Object.freeze({ ...shared, id: `${proposal.id}:open-question`, kind: "OPEN_QUESTION" as const,
      text: proposal.uncertainty }),
    Object.freeze({ ...shared, id: `${proposal.id}:recent-change`, kind: "RECENT_CHANGE" as const,
      text: proposal.proposedChange }),
  ]);
}

export function handoffProposalPayloadBytes(
  proposal: ProposalProjection,
  memoryVersions: readonly HandoffMemoryVersion[],
): number {
  const idea: IdeaRow = {
    ordinal: 0,
    proposal_id: proposal.id,
    proposal_event_id: proposal.createdEventId,
    proposal_status_event_id: proposal.createdEventId,
    proposal_status_ordinal: 0,
    disclosure_authorization_id: null,
    disclosure_revocation_event_id: null,
    source_event_ids: [...proposal.sourceEventIds],
    memory_ids: memoryVersions.map(({ memoryId }) => memoryId),
    memory_versions: memoryVersions.map(({ version: memoryVersion }) => memoryVersion),
    content_digest: proposalHandoffContentDigest(proposal),
  };
  return Buffer.byteLength(JSON.stringify(proposalItems(proposal, idea)), "utf8");
}

function canonicalSourceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("HANDOFF_SOURCES_INVALID");
  }
  const sources = value.map((sourceId) => requiredString(sourceId, "HANDOFF_SOURCE_INVALID", 240));
  return Object.freeze([...new Set(sources)].sort());
}

/**
 * Serializes an already-authorized set of handoff candidates. This boundary is
 * deliberately incapable of making a private record transmissible: a caller
 * must supply an explicit transmitted/council-visible marker, an allowed
 * scope, a supported structured kind, and source grounding.
 */
export function buildHandoff(input: BuildHandoffInput): HandoffPacket {
  if (!input || typeof input !== "object" || !Array.isArray(input.memories)) {
    throw new Error("HANDOFF_INPUT_INVALID");
  }
  const nodeBrainId = requiredString(input.nodeBrainId, "HANDOFF_NODE_INVALID", 240);
  const highWaterMark = requiredString(input.highWaterMark, "HANDOFF_HIGH_WATER_INVALID", 240);
  if (input.memories.length > 200) throw new Error("HANDOFF_CANDIDATE_LIMIT");

  const items = input.memories.flatMap((memory): HandoffItem[] => {
    if (!memory || typeof memory !== "object") throw new Error("HANDOFF_MEMORY_INVALID");
    if (!memory.transmitted && !memory.councilVisible) return [];
    if (!HANDOFF_SCOPES.has(memory.scope) || !HANDOFF_KINDS.has(memory.kind)) return [];
    const sourceIds = canonicalSourceIds(memory.sourceIds);
    const id = requiredString(memory.id, "HANDOFF_MEMORY_ID_INVALID", 240);
    return [{
      id,
      scope: memory.scope,
      kind: memory.kind as HandoffItemKind,
      text: requiredString(memory.text, "HANDOFF_TEXT_INVALID"),
      sourceIds,
      memoryVersion: requiredString(memory.version ?? id, "HANDOFF_VERSION_INVALID", 240),
    }];
  });
  if (Buffer.byteLength(JSON.stringify(items), "utf8") > MAX_HANDOFF_SERIALIZED_BYTES) {
    throw new Error("HANDOFF_PACKET_SIZE_LIMIT");
  }

  return Object.freeze({
    nodeBrainId,
    highWaterMark,
    items: Object.freeze(items.map((item) => Object.freeze(item))),
  });
}

/**
 * Loads a durable packet only after its complete account/Node/scope/policy/state
 * identity and every current proposal/disclosure authority have been locked and
 * revalidated. Protected packet/proposal ciphertext is not selected before
 * those checks complete.
 */
export async function loadHandoff(
  context: HandoffContext,
  input: LoadHandoffInput,
): Promise<DurableHandoffPacket> {
  const database = databaseFrom(context);
  if (!input || typeof input !== "object") throw new Error("HANDOFF_INPUT_INVALID");
  const packetId = uuid(input.packetId, "HANDOFF_INPUT_INVALID");
  const accountId = uuid(input.accountId, "HANDOFF_INPUT_INVALID");
  const nodeBrainId = uuid(input.nodeBrainId, "HANDOFF_INPUT_INVALID");
  const conversationId = uuid(input.conversationId, "HANDOFF_INPUT_INVALID");
  if (input.scope !== "NODE_BRANCH") throw new Error("HANDOFF_FORBIDDEN");
  const policyVersion = version(input.policyVersion, "HANDOFF_INPUT_INVALID");
  if (policyVersion !== HANDOFF_POLICY_VERSION) throw new Error("HANDOFF_FORBIDDEN");
  const nodeStateVersion = version(input.nodeStateVersion, "HANDOFF_INPUT_INVALID");
  const mainStateVersion = version(input.mainStateVersion, "HANDOFF_INPUT_INVALID");

  return database.transaction(async (transaction) => {
    const packets = await transaction.query<PacketRow>(
      `/* handoff-authority-metadata */
       select packet.id::text,packet.account_id::text,packet.node_brain_id::text,
              packet.conversation_id::text,packet.scope,packet.policy_version,
               packet.node_state_version,packet.main_state_version::text,
               packet.packet_version::text,
               packet.source_high_water_sequence::text,packet.packet_event_id::text,
               packet.body_digest,packet.idea_count,packet.source_count,
               (select count(*)::int from handoff_packet_ideas idea
                 where idea.packet_id=packet.id) normalized_idea_count,
               (select count(distinct source_id)::int from handoff_packet_ideas idea,
                 unnest(idea.source_event_ids) source_id
                 where idea.packet_id=packet.id) normalized_source_count,
               recall_manifest_digest(handoff_packet_event_body(packet.id)) normalized_body_digest,
               manifest.body_digest manifest_body_digest,
               handoff_packet_event_body(packet.id) expected_body
       from handoff_packets packet
       join handoff_packet_manifests manifest on manifest.packet_id=packet.id
       join accounts account on account.id=packet.account_id and account.status='ACTIVE'
       join entitlements entitlement on entitlement.account_id=account.id
         and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
         and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
       join node_brains node on node.id=packet.node_brain_id and node.account_id=account.id
         and node.status='ACTIVE'
       join conversations conversation on conversation.id=packet.conversation_id
         and conversation.account_id=account.id and conversation.node_brain_id=node.id
         and conversation.status='OPEN'
       where packet.id=$1 and packet.account_id=$2 and packet.node_brain_id=$3
         and packet.conversation_id=$4 and packet.scope=$5
          and packet.policy_version=$6 and packet.node_state_version=$7
          and packet.main_state_version=$8::bigint
        for share of packet,manifest,account,entitlement,node,conversation`,
      [packetId, accountId, nodeBrainId, conversationId, input.scope,
        policyVersion, nodeStateVersion, mainStateVersion],
    );
    if (packets.length !== 1) throw new Error("HANDOFF_FORBIDDEN");
    const packet = packets[0]!;
    if (packet.idea_count !== packet.normalized_idea_count
        || packet.source_count !== packet.normalized_source_count
        || packet.body_digest !== packet.normalized_body_digest
        || packet.body_digest !== packet.manifest_body_digest) {
      throw new Error("HANDOFF_INTEGRITY_FAILURE");
    }
    const ideas = await transaction.query<IdeaRow>(
      `select ordinal,proposal_id::text,proposal_event_id::text,
              proposal_status_event_id::text,proposal_status_ordinal,
              disclosure_authorization_id::text,disclosure_revocation_event_id::text,
              source_event_ids::text[],memory_ids::text[],memory_versions,content_digest
       from handoff_packet_ideas where packet_id=$1 order by ordinal`,
      [packetId],
    );
    if (ideas.length < 1 || ideas.length > MAX_HANDOFF_IDEAS) {
      throw new Error("HANDOFF_INTEGRITY_FAILURE");
    }
    await acquireHandoffAuthorityLocks(transaction, ideas);
    const current = await transaction.query<{ readonly proposal_id: string } & Record<string, unknown>>(
      `/* handoff-final-proposal-disclosure-revalidation */
       select idea.proposal_id::text
       from handoff_packet_ideas idea
       join handoff_packets packet on packet.id=idea.packet_id
       join proposals proposal on proposal.id=idea.proposal_id
         and proposal.account_id=$2 and proposal.node_brain_id=$3 and proposal.conversation_id=$4
         and proposal.created_event_id=idea.proposal_event_id
         and proposal.affected_main_state_ids ? packet.main_state_version::text
       join events proposal_boundary on proposal_boundary.id=idea.proposal_event_id
         and proposal_boundary.ingested_sequence<=packet.source_high_water_sequence
       left join events raw_private_boundary on raw_private_boundary.id=proposal.raw_private_text_event_id
         and raw_private_boundary.ingested_sequence<=packet.source_high_water_sequence
       join lateral (select transition.* from proposal_status_transitions transition
         where transition.proposal_id=proposal.id order by transition.ordinal desc limit 1) status on
         status.transition_event_id=idea.proposal_status_event_id
          and status.ordinal=idea.proposal_status_ordinal
          and status.to_status not in ('WITHDRAWN','REJECTED')
       join events status_boundary on status_boundary.id=idea.proposal_status_event_id
         and status_boundary.ingested_sequence<=packet.source_high_water_sequence
       left join proposal_disclosure_authorizations disclosure
         on disclosure.id=idea.disclosure_authorization_id
         and disclosure.id=proposal.disclosure_authorization_id
         and disclosure.account_id=proposal.account_id
         and disclosure.conversation_id=proposal.conversation_id
         and disclosure.expires_at>clock_timestamp()
       left join events disclosure_boundary on disclosure_boundary.id=disclosure.created_event_id
         and disclosure_boundary.ingested_sequence<=packet.source_high_water_sequence
       left join proposal_disclosure_revocations revoked
         on revoked.authorization_id=disclosure.id
       where idea.packet_id=$1
         and ((proposal.privacy_scope='PROPOSAL_SUMMARY'
             and idea.disclosure_authorization_id is null)
           or (proposal.privacy_scope='PROPOSAL_RAW_TEXT'
              and disclosure.id is not null and disclosure_boundary.id is not null
              and raw_private_boundary.id is not null
              and revoked.authorization_id is null))
         and not exists (select 1 from unnest(idea.source_event_ids) source_id
           join events source on source.id=source_id
           where source.ingested_sequence>packet.source_high_water_sequence)
       order by idea.ordinal`,
      [packetId, accountId, nodeBrainId, conversationId],
    );
    if (current.length !== ideas.length) throw new Error("HANDOFF_STALE");

    await lockAvailableMemorySourceBodies(transaction, [], [packet.packet_event_id]);
    for (const idea of ideas) {
      const bodyAuthority = await transaction.query<{
        readonly body_event_id: string;
        readonly raw_private_text_event_id: string | null;
      } & Record<string, unknown>>(
        `select memory.body_event_id::text,proposal.raw_private_text_event_id::text
         from unnest($1::uuid[]) memory_id
         join memory_records memory on memory.id=memory_id
         join proposals proposal on proposal.id=$2
         order by memory.body_event_id`,
        [idea.memory_ids, idea.proposal_id],
      );
      if (bodyAuthority.length !== idea.memory_ids.length) {
        throw new Error("HANDOFF_INTEGRITY_FAILURE");
      }
      const available = await lockAvailableMemorySourceBodies(
        transaction,
        bodyAuthority.map(({ body_event_id }) => body_event_id),
        [...idea.source_event_ids, idea.proposal_event_id,
          ...(bodyAuthority[0]?.raw_private_text_event_id
            ? [bodyAuthority[0].raw_private_text_event_id] : [])],
      );
      if (available.length !== bodyAuthority.length) {
        throw new Error("HANDOFF_SOURCE_UNAVAILABLE");
      }
    }

    const packetBody = await readEventBody(transaction, packet.packet_event_id, {
      actor: { role: "ACCOUNT", accountId },
    });
    if (canonicalBodyDigest(packetBody) !== packet.body_digest
        || canonicalBodyDigest(packet.expected_body) !== packet.body_digest
        || canonicalBodyDigest(packetBody) !== canonicalBodyDigest(packet.expected_body)) {
      throw new Error("HANDOFF_INTEGRITY_FAILURE");
    }
    const items: DurableHandoffItem[] = [];
    for (const idea of ideas) {
      const proposal = await getProposal({ db: transaction }, {
        accountId,
        proposalId: idea.proposal_id,
      });
      if (proposalHandoffContentDigest(proposal) !== idea.content_digest) {
        throw new Error("HANDOFF_STALE");
      }
      items.push(...proposalItems(proposal, idea));
    }
    if (items.length > MAX_HANDOFF_ITEMS) throw new Error("HANDOFF_ITEM_LIMIT");
    if (Buffer.byteLength(JSON.stringify(items), "utf8") > MAX_HANDOFF_SERIALIZED_BYTES) {
      throw new Error("HANDOFF_PACKET_SIZE_LIMIT");
    }
    return Object.freeze({
      id: packet.id,
      accountId: packet.account_id,
      nodeBrainId: packet.node_brain_id,
      conversationId: packet.conversation_id,
      scope: packet.scope,
      policyVersion: packet.policy_version,
      nodeStateVersion: packet.node_state_version,
      mainStateVersion: packet.main_state_version,
      packetVersion: packet.packet_version,
      highWaterSequence: packet.source_high_water_sequence,
      items: Object.freeze(items),
    });
  });
}
