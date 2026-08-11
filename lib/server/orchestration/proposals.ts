import { createHmac, randomUUID } from "node:crypto";
import { appendEvent, readEventBody } from "../events/store";
import { canonicalContentDigest, digestsEqual } from "../events/integrity";
import type { EventDatabase, JsonValue } from "../events/types";
import {
  canonicalEvidenceReferences,
  type EvidenceReference,
} from "./evidence";

export const PROPOSAL_POLICY_VERSION = "node-proposal-policy-v1";
export const MAX_CLARIFICATION_TURNS = 3;
export const MAX_REVIEW_TURNS = 6;
export const MAX_PROPOSAL_STATUS_TRANSITIONS = 5;
const MAX_SOURCE_EVENTS = 32;
const MAX_EVIDENCE_REFERENCES = 64;
const MAX_CHANGE_LENGTH = 8_000;
const MAX_UNCERTAINTY_LENGTH = 2_000;
const MAX_PRIVATE_TEXT_LENGTH = 12_000;
const MAX_TURN_TEXT_LENGTH = 8_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

export const PROPOSAL_STATUSES = [
  "PENDING_REVIEW",
  "CLARIFICATION_REQUESTED",
  "UNDER_REVIEW",
  "QUEUED_FOR_DECISION",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type ProposalTurnKind = "CLARIFICATION" | "REVIEW";
export type ProposalPrivacyScope = "PROPOSAL_SUMMARY" | "PROPOSAL_RAW_TEXT";
export type ProposalTurnActor =
  | { readonly type: "NODE_BRAIN"; readonly id: string }
  | { readonly type: "MAIN_BRAIN"; readonly id: "gustavo-main" }
  | { readonly type: "EVALUATOR"; readonly id: string };

export interface ProposalContext { readonly db: EventDatabase }

export interface CreateProposalInput {
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly sourceEventIds: readonly string[];
  readonly routeEventId: string;
  readonly affectedMainStateIds: readonly string[];
  readonly privacyScope: ProposalPrivacyScope;
  readonly proposedChange: string;
  readonly evidence: readonly EvidenceReference[];
  readonly counterevidence: readonly EvidenceReference[];
  readonly uncertainty: string;
  readonly rawPrivateText?: string;
  readonly disclosureAuthorizationId?: string;
  readonly idempotencyKey: string;
}

export interface ProposalProjection {
  readonly id: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly councilMemberId: string;
  readonly sourceEventIds: readonly string[];
  readonly routeEventId: string;
  readonly affectedMainStateIds: readonly string[];
  readonly privacyScope: ProposalPrivacyScope;
  readonly proposedChange: string;
  readonly evidence: readonly EvidenceReference[];
  readonly counterevidence: readonly EvidenceReference[];
  readonly uncertainty: string;
  readonly rawPrivateText?: string;
  readonly status: ProposalStatus;
  readonly createdEventId: string;
  readonly createdAt: string;
}

export interface CreateDisclosureAuthorizationInput {
  readonly accountId: string;
  readonly conversationId: string;
  readonly sourceEventIds: readonly string[];
  readonly disclosedText: string;
  readonly privacyScope: "PROPOSAL_RAW_TEXT";
  readonly purpose: "MAIN_PROPOSAL_REVIEW";
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
}

export interface DisclosureAuthorization {
  readonly id: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly sourceEventIds: readonly string[];
  readonly disclosedTextDigest: string;
  readonly privacyScope: "PROPOSAL_RAW_TEXT";
  readonly purpose: "MAIN_PROPOSAL_REVIEW";
  readonly expiresAt: string;
  readonly createdEventId: string;
}

export interface TransitionProposalInput {
  readonly proposalId: string;
  readonly actor: ProposalTurnActor;
  readonly toStatus: Exclude<ProposalStatus, "PENDING_REVIEW">;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface AddProposalTurnInput {
  readonly proposalId: string;
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly actor: ProposalTurnActor;
  readonly kind: ProposalTurnKind;
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
  readonly idempotencyKey: string;
}

export interface ProposalTurn {
  readonly id: string;
  readonly proposalId: string;
  readonly kind: ProposalTurnKind;
  readonly actor: ProposalTurnActor;
  readonly ordinal: number;
  readonly sourceEventIds: readonly string[];
  readonly text: string;
  readonly evidence: readonly EvidenceReference[];
  readonly eventId: string;
  readonly createdAt: string;
}

interface ProposalRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly node_brain_id: string;
  readonly conversation_id: string;
  readonly council_member_id: string;
  readonly source_event_ids: unknown;
  readonly route_event_id: string;
  readonly affected_main_state_ids: unknown;
  readonly privacy_scope: ProposalPrivacyScope;
  readonly raw_private_text_digest: string | null;
  readonly raw_private_text_event_id: string | null;
  readonly disclosure_authorization_id: string | null;
  readonly created_event_id: string;
  readonly policy_version: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly created_at: Date;
}

interface DisclosureRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly conversation_id: string;
  readonly source_event_ids: unknown;
  readonly disclosed_text_digest: string;
  readonly privacy_scope: "PROPOSAL_RAW_TEXT";
  readonly purpose: "MAIN_PROPOSAL_REVIEW";
  readonly expires_at: Date;
  readonly created_event_id: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly created_at: Date;
}

interface TransitionRow extends Record<string, unknown> {
  readonly to_status: ProposalStatus;
  readonly ordinal: number;
  readonly request_digest: string;
}

interface TurnRow extends Record<string, unknown> {
  readonly id: string;
  readonly proposal_id: string;
  readonly actor_type: ProposalTurnActor["type"];
  readonly actor_id: string;
  readonly kind: ProposalTurnKind;
  readonly ordinal: number;
  readonly source_event_ids: unknown;
  readonly turn_event_id: string;
  readonly request_digest: string;
  readonly created_at: Date;
}

const PROPOSAL_COLUMNS = `
  id::text, account_id::text, node_brain_id::text, conversation_id::text,
  council_member_id, source_event_ids, disclosure_authorization_id::text,
  route_event_id::text, affected_main_state_ids, privacy_scope,
  raw_private_text_digest, raw_private_text_event_id::text,
  created_event_id::text, policy_version,
  idempotency_key, request_digest, created_at
`;

const DISCLOSURE_COLUMNS = `
  id::text, account_id::text, conversation_id::text, source_event_ids,
  disclosed_text_digest, privacy_scope, purpose, expires_at,
  created_event_id::text, idempotency_key, request_digest, created_at
`;

function databaseFrom(context: ProposalContext): EventDatabase {
  if (!context || typeof context !== "object" || !context.db) {
    throw new Error("PROPOSAL_CONTEXT_INVALID");
  }
  return context.db;
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new Error("PROPOSAL_IDEMPOTENCY_KEY_INVALID");
  }
  return value;
}

function boundedText(value: unknown, maximum: number, code: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum
    || value !== value.trim() || value.includes("\u0000")
  ) throw new Error(code);
  return value;
}

function canonicalSourceEvents(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SOURCE_EVENTS) {
    throw new Error("PROPOSAL_SOURCE_EVENTS_INVALID");
  }
  const values = value.map((eventId) => identifier(eventId, "PROPOSAL_SOURCE_EVENT_INVALID"));
  return Object.freeze([...new Set(values)].sort());
}

function parsedSourceEvents(value: unknown): readonly string[] {
  return canonicalSourceEvents(value);
}

function canonicalMainStateIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error("PROPOSAL_MAIN_STATE_INVALID");
  }
  const values = value.map((stateId) => {
    if (typeof stateId !== "string" || !/^[1-9][0-9]{0,18}$/.test(stateId)) {
      throw new Error("PROPOSAL_MAIN_STATE_INVALID");
    }
    return stateId;
  });
  return Object.freeze([...new Set(values)].sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }));
}

type ProposalOperation =
  | "DISCLOSURE_AUTHORIZE"
  | "DISCLOSURE_REVOKE"
  | "PROPOSAL_CREATE"
  | "PROPOSAL_TRANSITION"
  | "PROPOSAL_TURN";

async function claimOperationIdempotency(
  database: EventDatabase,
  input: {
    readonly key: string;
    readonly operation: ProposalOperation;
    readonly aggregateScope: string;
    readonly requestDigest: string;
  },
): Promise<boolean> {
  await database.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `proposal-operation-idempotency:${input.key}`,
  ]);
  const existing = await database.query<{
    readonly operation: string;
    readonly aggregate_scope: string;
    readonly request_digest: string;
  }>(
    `select operation, aggregate_scope, request_digest
     from proposal_operation_idempotency where idempotency_key=$1`,
    [input.key],
  );
  if (existing[0]) {
    if (
      existing[0].operation !== input.operation
      || existing[0].aggregate_scope !== input.aggregateScope
      || !digestsEqual(existing[0].request_digest, input.requestDigest)
    ) {
      throw new Error("PROPOSAL_IDEMPOTENCY_KEY_REUSED");
    }
    return true;
  }
  await database.query(
    `insert into proposal_operation_idempotency
       (idempotency_key, operation, aggregate_scope, request_digest)
     values ($1,$2,$3,$4)`,
    [input.key, input.operation, input.aggregateScope, input.requestDigest],
  );
  return false;
}

function councilPseudonym(accountId: string): string {
  const encoded = process.env.GUSTAVO_COUNCIL_PSEUDONYM_KEY;
  if (!encoded) throw new Error("COUNCIL_PSEUDONYM_KEY_REQUIRED");
  const key = Buffer.from(encoded, "base64");
  if (key.length < 32) throw new Error("COUNCIL_PSEUDONYM_KEY_INVALID");
  return `member_${createHmac("sha256", key).update(accountId).digest("hex").slice(0, 20)}`;
}

function jsonReferences(references: readonly EvidenceReference[]): JsonValue[] {
  return references.map((reference) => ({
    kind: reference.kind,
    referenceId: reference.referenceId,
  }));
}

async function authorizeSourceGraph(
  database: EventDatabase,
  input: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly nodeBrainId?: string;
    readonly sourceEventIds: readonly string[];
  },
): Promise<void> {
  const identity = await database.query<{ readonly authorized: boolean }>(
    `select true as authorized
     from accounts account
     join entitlements entitlement on entitlement.account_id=account.id
       and entitlement.revoked_at is null
       and entitlement.active_from <= clock_timestamp()
       and (entitlement.expires_at is null or entitlement.expires_at > clock_timestamp())
     join conversations conversation on conversation.account_id=account.id
       and conversation.id=$2 and conversation.status='OPEN'
     join node_brains node on node.account_id=account.id
       and node.id=conversation.node_brain_id and node.status='ACTIVE'
     where account.id=$1 and account.status='ACTIVE'
       and ($3::uuid is null or node.id=$3::uuid)`,
    [input.accountId, input.conversationId, input.nodeBrainId ?? null],
  );
  if (!identity[0]) throw new Error("PROPOSAL_SOURCE_FORBIDDEN");
  const source = await database.one<{ readonly count: number }>(
    `select count(distinct event.id)::int as count
     from events event
     join messages message on message.event_id=event.id
     where event.id=any($1::uuid[])
       and event.aggregate_id=$2
       and event.account_id=$3
       and event.visibility='PRIVATE_ACCOUNT'
       and event.type='participant.message.created'
       and message.conversation_id=$2::uuid
       and message.account_id=$3::uuid`,
    [input.sourceEventIds, input.conversationId, input.accountId],
  );
  if (source.count !== input.sourceEventIds.length) {
    throw new Error("PROPOSAL_SOURCE_FORBIDDEN");
  }
}

function privateMessageText(body: JsonValue): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.text !== "string") {
    throw new Error("PROPOSAL_SOURCE_FORBIDDEN");
  }
  return body.text;
}

function normalizedDisclosureText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

const PRIVATE_VALUE_CUE_PATTERN = /(?:ssn|social security(?: number)?|private code|access code|user name|full name|name|email(?: address)?|phone(?: number)?|account(?: number)?|token|password|secret)\s*(?:(?:is|equals)\s*)?(?:[:=]\s*)?((?:[\p{L}\p{N}][\p{L}\p{N}@._+'-]*)(?:\s+[\p{L}\p{N}][\p{L}\p{N}@._+'-]*){0,3})/giu;
const PRIVATE_VALUE_TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}@._+'-]*/gu;
const PRIVATE_VALUE_CONNECTORS = new Set(["a", "an", "and", "equals", "is", "my", "our", "the", "your"]);

function privateValueTokens(value: string): readonly string[] {
  return (normalizedDisclosureText(value).match(PRIVATE_VALUE_TOKEN_PATTERN) ?? [])
    .map((token) => token.replace(/^[@._+'-]+|[@._+'-]+$/gu, ""))
    .filter((token) => token.length > 0);
}

function privateSourceFragments(source: string): ReadonlySet<string> {
  const fragments = new Set<string>();
  const normalizedSource = normalizedDisclosureText(source);
  for (const match of normalizedSource.matchAll(PRIVATE_VALUE_CUE_PATTERN)) {
    if (match[1]) {
      const cueFragments = privateValueTokens(match[1])
        .filter((fragment) => fragment.length >= 2 && !PRIVATE_VALUE_CONNECTORS.has(fragment));
      if (cueFragments.length > 1) fragments.add(cueFragments.join(" "));
      for (const fragment of cueFragments) {
        fragments.add(fragment);
      }
    }
  }
  for (const token of privateValueTokens(normalizedSource)) {
    if (token.length >= 3 && /[0-9]/u.test(token)) fragments.add(token);
  }
  return fragments;
}

function containsPrivateSourceFragment(candidate: string, source: string): boolean {
  const candidateTokens = new Set(privateValueTokens(candidate));
  for (const fragment of privateSourceFragments(source)) {
    if (candidateTokens.has(fragment)) return true;
  }
  return false;
}

async function sourceTexts(
  database: EventDatabase,
  accountId: string,
  sourceEventIds: readonly string[],
): Promise<readonly string[]> {
  return Promise.all(sourceEventIds.map(async (eventId) =>
    privateMessageText(await readEventBody(database, eventId, {
      actor: { role: "ACCOUNT", accountId },
    }))));
}

function copiesPrivateSource(candidate: string, sources: readonly string[]): boolean {
  const normalizedCandidate = normalizedDisclosureText(candidate);
  return sources.some((source) => {
    const normalizedSource = normalizedDisclosureText(source);
    if (normalizedCandidate === normalizedSource) return true;
    return containsPrivateSourceFragment(candidate, source)
      || normalizedCandidate.length >= 24 && normalizedSource.includes(normalizedCandidate)
      || normalizedSource.length >= 24 && normalizedCandidate.includes(normalizedSource);
  });
}

function isDisclosablePrivateSourceText(candidate: string, sources: readonly string[]): boolean {
  const normalizedCandidate = normalizedDisclosureText(candidate);
  return sources.some((source) => {
    const normalizedSource = normalizedDisclosureText(source);
    return normalizedCandidate === normalizedSource
      || privateSourceFragments(source).has(normalizedCandidate)
      || normalizedCandidate.length >= 24 && normalizedSource.includes(normalizedCandidate);
  });
}

async function authorizeMainStates(
  database: EventDatabase,
  affectedMainStateIds: readonly string[],
): Promise<void> {
  const row = await database.one<{ readonly count: number }>(
    "select count(*)::int as count from main_state_versions where version::text=any($1::text[])",
    [affectedMainStateIds],
  );
  if (row.count !== affectedMainStateIds.length) throw new Error("PROPOSAL_MAIN_STATE_FORBIDDEN");
}

async function authorizeEvidenceReferences(
  database: EventDatabase,
  input: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly sourceEventIds: readonly string[];
    readonly references: readonly EvidenceReference[];
  },
): Promise<void> {
  for (const reference of input.references) {
    if (reference.kind === "MARKET_EVENT") {
      throw new Error("PROPOSAL_EVIDENCE_KIND_UNAVAILABLE");
    }
    if (reference.kind === "SOURCE_EVENT") {
      if (!input.sourceEventIds.includes(reference.referenceId)) {
        throw new Error("PROPOSAL_EVIDENCE_FORBIDDEN");
      }
      continue;
    }
    if (!UUID_PATTERN.test(reference.referenceId)) throw new Error("PROPOSAL_EVIDENCE_FORBIDDEN");
    if (reference.kind === "COMMENTARY") {
      const row = await database.one<{ readonly count: number }>(
        "select count(*)::int as count from broadcasts where id=$1", [reference.referenceId],
      );
      if (row.count !== 1) throw new Error("PROPOSAL_EVIDENCE_FORBIDDEN");
      continue;
    }
    const row = await database.one<{ readonly count: number }>(
      "select count(*)::int as count from proposals where id=$1 and account_id=$2",
      [reference.referenceId, input.accountId],
    );
    if (row.count !== 1) throw new Error("PROPOSAL_EVIDENCE_FORBIDDEN");
  }
}

interface AuthorizedRoute {
  readonly correlationId: string;
  readonly mainStateVersion: string;
}

async function authorizeProposalRoute(
  database: EventDatabase,
  input: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly nodeBrainId: string;
    readonly routeEventId: string;
    readonly sourceEventIds: readonly string[];
    readonly affectedMainStateIds: readonly string[];
  },
): Promise<AuthorizedRoute> {
  const rows = await database.query<{
    readonly causation_id: string;
    readonly correlation_id: string;
  }>(
    `select causation_id::text, correlation_id::text from events
     where id=$1 and aggregate_id=$2 and account_id=$3
       and actor_type='NODE_BRAIN' and actor_id=$4
       and type='node.reply.routed' and visibility='PRIVATE_ACCOUNT'
       and policy_version='node-routing-v1'`,
    [input.routeEventId, input.conversationId, input.accountId, input.nodeBrainId],
  );
  if (!rows[0] || !input.sourceEventIds.includes(rows[0].causation_id)) {
    throw new Error("PROPOSAL_ROUTE_FORBIDDEN");
  }
  const body = await readEventBody(database, input.routeEventId, {
    actor: { role: "ACCOUNT", accountId: input.accountId },
  });
  if (!body || typeof body !== "object" || Array.isArray(body)
    || body.mode !== "PROPOSAL_UPSTREAM" || body.reason !== "MATERIAL_IMPROVEMENT"
    || typeof body.mainStateVersion !== "string" || !Array.isArray(body.sourceIds)
    || body.sourceIds.some((sourceId) => typeof sourceId !== "string")) {
    throw new Error("PROPOSAL_ROUTE_FORBIDDEN");
  }
  const routeSources = canonicalSourceEvents(body.sourceIds);
  if (canonicalContentDigest(routeSources) !== canonicalContentDigest(input.sourceEventIds)
    || !input.affectedMainStateIds.includes(body.mainStateVersion)) {
    throw new Error("PROPOSAL_ROUTE_FORBIDDEN");
  }
  return { correlationId: rows[0].correlation_id, mainStateVersion: body.mainStateVersion };
}

function parseProposalBody(body: JsonValue): {
  readonly affectedMainStateIds: readonly string[];
  readonly privacyScope: ProposalPrivacyScope;
  readonly proposedChange: string;
  readonly routeEventId: string;
  readonly sourceEventIds: readonly string[];
  readonly uncertainty: string;
  readonly privateTextUses: readonly ("PROPOSED_CHANGE" | "UNCERTAINTY")[];
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("PROPOSAL_INTEGRITY_FAILURE");
  }
  const record = body as Record<string, JsonValue>;
  if (typeof record.proposedChange !== "string" || typeof record.uncertainty !== "string"
    || typeof record.routeEventId !== "string" || !Array.isArray(record.sourceEventIds)
    || !Array.isArray(record.affectedMainStateIds)
    || !Array.isArray(record.privateTextUses)
    || record.privateTextUses.some((use) => use !== "PROPOSED_CHANGE" && use !== "UNCERTAINTY")
    || (record.privacyScope !== "PROPOSAL_SUMMARY" && record.privacyScope !== "PROPOSAL_RAW_TEXT")) {
    throw new Error("PROPOSAL_INTEGRITY_FAILURE");
  }
  return {
    affectedMainStateIds: canonicalMainStateIds(record.affectedMainStateIds),
    privacyScope: record.privacyScope,
    privateTextUses: Object.freeze([...new Set(record.privateTextUses as ("PROPOSED_CHANGE" | "UNCERTAINTY")[])].sort()),
    proposedChange: record.proposedChange,
    routeEventId: identifier(record.routeEventId, "PROPOSAL_INTEGRITY_FAILURE"),
    sourceEventIds: canonicalSourceEvents(record.sourceEventIds),
    uncertainty: record.uncertainty,
  };
}

function parseRawPrivateText(body: JsonValue): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.rawPrivateText !== "string") {
    throw new Error("PROPOSAL_PRIVATE_TEXT_INTEGRITY_FAILURE");
  }
  return body.rawPrivateText;
}

async function proposalReferences(
  database: EventDatabase,
  proposalId: string,
  polarity: "EVIDENCE" | "COUNTEREVIDENCE",
): Promise<readonly EvidenceReference[]> {
  const rows = await database.query<{ readonly reference_kind: EvidenceReference["kind"]; readonly reference_id: string }>(
    `select reference_kind, reference_id from proposal_evidence_links
     where proposal_id=$1 and polarity=$2 order by ordinal`,
    [proposalId, polarity],
  );
  return canonicalEvidenceReferences(
    rows.map((row) => ({ kind: row.reference_kind, referenceId: row.reference_id })),
    { max: MAX_EVIDENCE_REFERENCES, allowEmpty: true },
  );
}

async function currentStatus(database: EventDatabase, proposalId: string): Promise<ProposalStatus> {
  const row = await database.one<TransitionRow>(
    `select to_status, ordinal, request_digest from proposal_status_transitions
     where proposal_id=$1 order by ordinal desc limit 1`,
    [proposalId],
  );
  return row.to_status;
}

async function hydrateProposal(database: EventDatabase, row: ProposalRow): Promise<ProposalProjection> {
  if (row.policy_version !== PROPOSAL_POLICY_VERSION) throw new Error("PROPOSAL_INTEGRITY_FAILURE");
  const sourceEventIds = parsedSourceEvents(row.source_event_ids);
  await authorizeSourceGraph(database, {
    accountId: row.account_id,
    conversationId: row.conversation_id,
    nodeBrainId: row.node_brain_id,
    sourceEventIds,
  });
  const body = parseProposalBody(
    await readEventBody(database, row.created_event_id, {
      actor: { role: "ACCOUNT", accountId: row.account_id },
    }),
  );
  if (body.routeEventId !== row.route_event_id || body.privacyScope !== row.privacy_scope
    || canonicalContentDigest(body.sourceEventIds) !== canonicalContentDigest(sourceEventIds)
    || canonicalContentDigest(body.affectedMainStateIds) !== canonicalContentDigest(canonicalMainStateIds(row.affected_main_state_ids))) {
    throw new Error("PROPOSAL_INTEGRITY_FAILURE");
  }
  let activeRawText: string | undefined;
  let disclosureActive = false;
  if (row.disclosure_authorization_id && row.raw_private_text_digest && row.raw_private_text_event_id) {
    try {
      await disclosureFor(database, row.disclosure_authorization_id, {
        accountId: row.account_id,
        conversationId: row.conversation_id,
        sourceEventIds,
        disclosedTextDigest: row.raw_private_text_digest,
      });
      disclosureActive = true;
      activeRawText = parseRawPrivateText(
        await readEventBody(database, row.raw_private_text_event_id, {
          actor: { role: "ACCOUNT", accountId: row.account_id },
        }),
      );
      if (canonicalContentDigest(normalizedDisclosureText(activeRawText)) !== row.raw_private_text_digest) {
        throw new Error("PROPOSAL_PRIVATE_TEXT_INTEGRITY_FAILURE");
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PROPOSAL_DISCLOSURE_FORBIDDEN") throw error;
    }
  }
  const proposedChange = body.privateTextUses.includes("PROPOSED_CHANGE")
    ? disclosureActive ? activeRawText! : "[REDACTED PRIVATE TEXT]"
    : body.proposedChange;
  const uncertainty = body.privateTextUses.includes("UNCERTAINTY")
    ? disclosureActive ? activeRawText! : "[REDACTED PRIVATE TEXT]"
    : body.uncertainty;
  const projection: ProposalProjection = {
    id: row.id,
    nodeBrainId: row.node_brain_id,
    conversationId: row.conversation_id,
    councilMemberId: row.council_member_id,
    sourceEventIds,
    routeEventId: row.route_event_id,
    affectedMainStateIds: canonicalMainStateIds(row.affected_main_state_ids),
    privacyScope: row.privacy_scope,
    proposedChange,
    evidence: await proposalReferences(database, row.id, "EVIDENCE"),
    counterevidence: await proposalReferences(database, row.id, "COUNTEREVIDENCE"),
    uncertainty,
    ...(activeRawText === undefined ? {} : { rawPrivateText: activeRawText }),
    status: await currentStatus(database, row.id),
    createdEventId: row.created_event_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
  return Object.freeze(projection);
}

export async function getProposal(
  context: ProposalContext,
  input: { readonly accountId: string; readonly proposalId: string },
): Promise<ProposalProjection> {
  const database = databaseFrom(context);
  const accountId = identifier(input?.accountId, "PROPOSAL_READ_INPUT_INVALID");
  const proposalId = identifier(input?.proposalId, "PROPOSAL_READ_INPUT_INVALID");
  const rows = await database.query<ProposalRow>(
    `select ${PROPOSAL_COLUMNS} from proposals where id=$1 and account_id=$2`,
    [proposalId, accountId],
  );
  if (!rows[0]) throw new Error("PROPOSAL_NOT_FOUND");
  return hydrateProposal(database, rows[0]);
}

async function disclosureFor(
  database: EventDatabase,
  authorizationId: string,
  input: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly sourceEventIds: readonly string[];
    readonly disclosedTextDigest: string;
  },
): Promise<DisclosureRow> {
  const rows = await database.query<DisclosureRow>(
    `select disclosure.id::text, disclosure.account_id::text,
            disclosure.conversation_id::text, disclosure.source_event_ids,
            disclosure.disclosed_text_digest, disclosure.privacy_scope,
            disclosure.purpose, disclosure.expires_at, disclosure.created_event_id::text,
            disclosure.idempotency_key, disclosure.request_digest,
            disclosure.created_at
     from proposal_disclosure_authorizations disclosure
     left join proposal_disclosure_revocations revocation on revocation.authorization_id=disclosure.id
     where disclosure.id=$1 and disclosure.account_id=$2
       and disclosure.conversation_id=$3
       and disclosure.source_event_ids=$4::jsonb
       and disclosure.disclosed_text_digest=$5
       and disclosure.privacy_scope='PROPOSAL_RAW_TEXT'
       and disclosure.purpose='MAIN_PROPOSAL_REVIEW'
       and disclosure.expires_at > clock_timestamp()
       and revocation.authorization_id is null`,
    [authorizationId, input.accountId, input.conversationId,
      JSON.stringify(input.sourceEventIds), input.disclosedTextDigest],
  );
  if (!rows[0]) throw new Error("PROPOSAL_DISCLOSURE_FORBIDDEN");
  return rows[0];
}

export async function createDisclosureAuthorization(
  context: ProposalContext,
  input: CreateDisclosureAuthorizationInput,
): Promise<DisclosureAuthorization> {
  const database = databaseFrom(context);
  if (!input || typeof input !== "object") throw new Error("PROPOSAL_DISCLOSURE_INPUT_INVALID");
  const accountId = identifier(input.accountId, "PROPOSAL_DISCLOSURE_INPUT_INVALID");
  const conversationId = identifier(input.conversationId, "PROPOSAL_DISCLOSURE_INPUT_INVALID");
  const sourceEventIds = canonicalSourceEvents(input.sourceEventIds);
  const disclosedText = boundedText(input.disclosedText, MAX_PRIVATE_TEXT_LENGTH, "PROPOSAL_DISCLOSURE_TEXT_INVALID");
  if (input.privacyScope !== "PROPOSAL_RAW_TEXT" || input.purpose !== "MAIN_PROPOSAL_REVIEW") {
    throw new Error("PROPOSAL_DISCLOSURE_SCOPE_INVALID");
  }
  const disclosedTextDigest = canonicalContentDigest(normalizedDisclosureText(disclosedText));
  const expiresAt = new Date(input.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("PROPOSAL_DISCLOSURE_EXPIRY_INVALID");
  }
  const key = idempotencyKey(input.idempotencyKey);
  const requestDigest = canonicalContentDigest({ accountId, conversationId, disclosedTextDigest,
    expiresAt: expiresAt.toISOString(), privacyScope: input.privacyScope,
    purpose: input.purpose, sourceEventIds });
  await authorizeSourceGraph(database, { accountId, conversationId, sourceEventIds });
  const texts = await sourceTexts(database, accountId, sourceEventIds);
  if (!isDisclosablePrivateSourceText(disclosedText, texts)) {
    throw new Error("PROPOSAL_DISCLOSURE_TEXT_FORBIDDEN");
  }

  return database.transaction(async (transaction) => {
    await claimOperationIdempotency(transaction, {
      key, operation: "DISCLOSURE_AUTHORIZE", aggregateScope: `${accountId}:${conversationId}`, requestDigest,
    });
    const existing = await transaction.query<DisclosureRow>(
      `select ${DISCLOSURE_COLUMNS} from proposal_disclosure_authorizations where idempotency_key=$1`, [key],
    );
    if (existing[0]) {
      if (!digestsEqual(existing[0].request_digest, requestDigest)) throw new Error("PROPOSAL_IDEMPOTENCY_KEY_REUSED");
      return Object.freeze({
        id: existing[0].id,
        accountId: existing[0].account_id,
        conversationId: existing[0].conversation_id,
        sourceEventIds: parsedSourceEvents(existing[0].source_event_ids),
        disclosedTextDigest: existing[0].disclosed_text_digest,
        privacyScope: existing[0].privacy_scope,
        purpose: existing[0].purpose,
        expiresAt: new Date(existing[0].expires_at).toISOString(),
        createdEventId: existing[0].created_event_id,
      });
    }
    const id = randomUUID();
    const event = await appendEvent(transaction, {
      aggregateId: id,
      accountId,
      actor: { type: "USER", id: accountId },
      type: "proposal.disclosure.authorized",
      visibility: "PRIVATE_ACCOUNT",
      body: { conversationId, disclosedTextDigest, expiresAt: expiresAt.toISOString(),
        privacyScope: input.privacyScope, purpose: input.purpose, sourceEventIds: [...sourceEventIds] },
      idempotencyKey: `proposal-disclosure:${key}`,
      policyVersion: PROPOSAL_POLICY_VERSION,
    });
    const rows = await transaction.query<DisclosureRow>(
      `insert into proposal_disclosure_authorizations (
         id, account_id, conversation_id, source_event_ids, disclosed_text_digest,
         privacy_scope, purpose, expires_at,
         created_event_id, idempotency_key, request_digest, created_at
       ) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
       returning ${DISCLOSURE_COLUMNS}`,
      [id, accountId, conversationId, JSON.stringify(sourceEventIds), disclosedTextDigest,
        input.privacyScope, input.purpose, expiresAt, event.id, key, requestDigest, event.occurredAt],
    );
    return Object.freeze({
      id: rows[0].id,
      accountId: rows[0].account_id,
      conversationId: rows[0].conversation_id,
      sourceEventIds,
      disclosedTextDigest,
      privacyScope: input.privacyScope,
      purpose: input.purpose,
      expiresAt: expiresAt.toISOString(),
      createdEventId: event.id,
    });
  });
}

export async function revokeDisclosureAuthorization(
  context: ProposalContext,
  input: { readonly accountId: string; readonly authorizationId: string; readonly idempotencyKey: string },
): Promise<void> {
  const database = databaseFrom(context);
  const accountId = identifier(input?.accountId, "PROPOSAL_DISCLOSURE_INPUT_INVALID");
  const authorizationId = identifier(input?.authorizationId, "PROPOSAL_DISCLOSURE_INPUT_INVALID");
  const key = idempotencyKey(input?.idempotencyKey);
  const requestDigest = canonicalContentDigest({ accountId, authorizationId });
  await database.transaction(async (transaction) => {
    await claimOperationIdempotency(transaction, {
      key, operation: "DISCLOSURE_REVOKE", aggregateScope: authorizationId, requestDigest,
    });
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`proposal-disclosure:${authorizationId}`]);
    const authorization = await transaction.query<DisclosureRow>(
      `select ${DISCLOSURE_COLUMNS} from proposal_disclosure_authorizations where id=$1 and account_id=$2`,
      [authorizationId, accountId],
    );
    if (!authorization[0]) throw new Error("PROPOSAL_DISCLOSURE_FORBIDDEN");
    const duplicate = await transaction.query<{ readonly request_digest: string }>(
      "select request_digest from proposal_disclosure_revocations where authorization_id=$1", [authorizationId],
    );
    if (duplicate[0]) {
      if (!digestsEqual(duplicate[0].request_digest, requestDigest)) throw new Error("PROPOSAL_IDEMPOTENCY_KEY_REUSED");
      return;
    }
    const event = await appendEvent(transaction, {
      aggregateId: authorizationId,
      accountId,
      actor: { type: "USER", id: accountId },
      type: "proposal.disclosure.revoked",
      visibility: "PRIVATE_ACCOUNT",
      body: { authorizationId },
      idempotencyKey: `proposal-disclosure-revoke:${key}`,
      causationId: authorization[0].created_event_id,
      policyVersion: PROPOSAL_POLICY_VERSION,
    });
    await transaction.query(
      `insert into proposal_disclosure_revocations (
         authorization_id, account_id, revoked_event_id, idempotency_key, request_digest, revoked_at
       ) values ($1,$2,$3,$4,$5,$6)`,
      [authorizationId, accountId, event.id, key, requestDigest, event.occurredAt],
    );
  });
}

export async function createProposal(
  context: ProposalContext,
  input: CreateProposalInput,
): Promise<ProposalProjection> {
  const database = databaseFrom(context);
  if (!input || typeof input !== "object") throw new Error("PROPOSAL_INPUT_INVALID");
  const accountId = identifier(input.accountId, "PROPOSAL_INPUT_INVALID");
  const nodeBrainId = identifier(input.nodeBrainId, "PROPOSAL_INPUT_INVALID");
  const conversationId = identifier(input.conversationId, "PROPOSAL_INPUT_INVALID");
  const sourceEventIds = canonicalSourceEvents(input.sourceEventIds);
  const routeEventId = identifier(input.routeEventId, "PROPOSAL_ROUTE_FORBIDDEN");
  const affectedMainStateIds = canonicalMainStateIds(input.affectedMainStateIds);
  if (input.privacyScope !== "PROPOSAL_SUMMARY" && input.privacyScope !== "PROPOSAL_RAW_TEXT") {
    throw new Error("PROPOSAL_PRIVACY_SCOPE_INVALID");
  }
  const proposedChange = boundedText(input.proposedChange, MAX_CHANGE_LENGTH, "PROPOSAL_CHANGE_INVALID");
  const uncertainty = boundedText(input.uncertainty, MAX_UNCERTAINTY_LENGTH, "PROPOSAL_UNCERTAINTY_INVALID");
  const evidence = canonicalEvidenceReferences(input.evidence, { max: MAX_EVIDENCE_REFERENCES, allowEmpty: false });
  const counterevidence = canonicalEvidenceReferences(input.counterevidence, { max: MAX_EVIDENCE_REFERENCES, allowEmpty: true });
  const rawPrivateText = input.rawPrivateText === undefined ? undefined
    : boundedText(input.rawPrivateText, MAX_PRIVATE_TEXT_LENGTH, "PROPOSAL_PRIVATE_TEXT_INVALID");
  const disclosureAuthorizationId = input.disclosureAuthorizationId === undefined ? undefined
    : identifier(input.disclosureAuthorizationId, "PROPOSAL_DISCLOSURE_FORBIDDEN");
  const key = idempotencyKey(input.idempotencyKey);
  await authorizeSourceGraph(database, { accountId, conversationId, nodeBrainId, sourceEventIds });
  await authorizeMainStates(database, affectedMainStateIds);
  const route = await authorizeProposalRoute(database, {
    accountId, conversationId, nodeBrainId, routeEventId, sourceEventIds, affectedMainStateIds,
  });
  await authorizeEvidenceReferences(database, {
    accountId, conversationId, sourceEventIds, references: [...evidence, ...counterevidence],
  });
  const rawPrivateTextDigest = rawPrivateText === undefined ? undefined
    : canonicalContentDigest(normalizedDisclosureText(rawPrivateText));
  if (input.privacyScope === "PROPOSAL_RAW_TEXT") {
    if (!disclosureAuthorizationId || !rawPrivateText || !rawPrivateTextDigest) {
      throw new Error("PROPOSAL_DISCLOSURE_FORBIDDEN");
    }
    await disclosureFor(database, disclosureAuthorizationId, {
      accountId, conversationId, sourceEventIds, disclosedTextDigest: rawPrivateTextDigest,
    });
  } else if (disclosureAuthorizationId) {
    throw new Error("PROPOSAL_PRIVACY_SCOPE_INVALID");
  }
  const texts = await sourceTexts(database, accountId, sourceEventIds);
  const privateTextUses: ("PROPOSED_CHANGE" | "UNCERTAINTY")[] = [];
  for (const [use, candidate] of [
    ["PROPOSED_CHANGE", proposedChange],
    ["UNCERTAINTY", uncertainty],
  ] as const) {
    if (copiesPrivateSource(candidate, texts)) {
      if (input.privacyScope !== "PROPOSAL_RAW_TEXT" || !disclosureAuthorizationId
        || canonicalContentDigest(normalizedDisclosureText(candidate)) !== rawPrivateTextDigest) {
        throw new Error(disclosureAuthorizationId
          ? "PROPOSAL_DISCLOSURE_FORBIDDEN" : "PROPOSAL_PRIVATE_TEXT_DISCLOSURE_REQUIRED");
      }
      privateTextUses.push(use);
    }
  }
  const disclosedPrivateText = input.privacyScope === "PROPOSAL_RAW_TEXT" ? rawPrivateText : undefined;
  const requestDigest = canonicalContentDigest({
    accountId, affectedMainStateIds, conversationId, counterevidence,
    disclosureAuthorizationId: disclosureAuthorizationId ?? null, evidence, nodeBrainId,
    privacyScope: input.privacyScope, proposedChange,
    rawPrivateTextDigest: input.privacyScope === "PROPOSAL_RAW_TEXT" ? rawPrivateTextDigest : null,
    routeEventId, sourceEventIds, uncertainty,
  });

  return database.transaction(async (transaction) => {
    await claimOperationIdempotency(transaction, {
      key, operation: "PROPOSAL_CREATE", aggregateScope: `${accountId}:${conversationId}`, requestDigest,
    });
    const duplicates = await transaction.query<ProposalRow>(
      `select ${PROPOSAL_COLUMNS} from proposals where idempotency_key=$1`, [key],
    );
    if (duplicates[0]) {
      if (!digestsEqual(duplicates[0].request_digest, requestDigest)) throw new Error("PROPOSAL_IDEMPOTENCY_KEY_REUSED");
      return hydrateProposal(transaction, duplicates[0]);
    }
    const id = randomUUID();
    const pseudonym = councilPseudonym(accountId);
    const event = await appendEvent(transaction, {
      aggregateId: id,
      accountId,
      actor: { type: "NODE_BRAIN", id: nodeBrainId },
      type: "node.proposal.created",
      visibility: "PRIVATE_ACCOUNT",
      body: {
        councilMemberId: pseudonym,
        affectedMainStateIds: [...affectedMainStateIds],
        counterevidence: jsonReferences(counterevidence),
        ...(disclosureAuthorizationId ? { disclosureAuthorizationId } : {}),
        evidence: jsonReferences(evidence),
        privateTextUses,
        privacyScope: input.privacyScope,
        proposedChange: privateTextUses.includes("PROPOSED_CHANGE")
          ? "[AUTHORIZED PRIVATE TEXT]" : proposedChange,
        sourceEventIds: [...sourceEventIds],
        routeEventId,
        uncertainty: privateTextUses.includes("UNCERTAINTY")
          ? "[AUTHORIZED PRIVATE TEXT]" : uncertainty,
      },
      idempotencyKey: `node-proposal:${key}`,
      causationId: routeEventId,
      correlationId: route.correlationId,
      policyVersion: PROPOSAL_POLICY_VERSION,
    });
    const privateTextEvent = disclosedPrivateText === undefined ? undefined : await appendEvent(transaction, {
      aggregateId: id,
      accountId,
      actor: { type: "NODE_BRAIN", id: nodeBrainId },
      type: "feedback.proposal.private-text-attached",
      visibility: "PRIVATE_ACCOUNT",
      body: { rawPrivateText: disclosedPrivateText },
      idempotencyKey: `node-proposal-private:${key}`,
      causationId: event.id,
      correlationId: route.correlationId,
      policyVersion: PROPOSAL_POLICY_VERSION,
    });
    const rows = await transaction.query<ProposalRow>(
      `insert into proposals (
         id, account_id, node_brain_id, conversation_id, council_member_id,
         source_event_ids, route_event_id, affected_main_state_ids, privacy_scope,
         raw_private_text_digest, raw_private_text_event_id, evidence_count, counterevidence_count,
         disclosure_authorization_id, created_event_id,
         policy_version, idempotency_key, request_digest, created_at
       ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       returning ${PROPOSAL_COLUMNS}`,
      [id, accountId, nodeBrainId, conversationId, pseudonym, JSON.stringify(sourceEventIds),
        routeEventId, JSON.stringify(affectedMainStateIds), input.privacyScope,
        input.privacyScope === "PROPOSAL_RAW_TEXT" ? rawPrivateTextDigest : null,
        privateTextEvent?.id ?? null, evidence.length, counterevidence.length,
        disclosureAuthorizationId ?? null, event.id, PROPOSAL_POLICY_VERSION,
        key, requestDigest, event.occurredAt],
    );
    for (const [polarity, references] of [["EVIDENCE", evidence], ["COUNTEREVIDENCE", counterevidence]] as const) {
      for (const [ordinal, reference] of references.entries()) {
        await transaction.query(
          `insert into proposal_evidence_links
             (proposal_id, polarity, ordinal, reference_kind, reference_id)
           values ($1,$2,$3,$4,$5)`,
          [id, polarity, ordinal, reference.kind, reference.referenceId],
        );
      }
    }
    await transaction.query(
      `insert into proposal_status_transitions (
         id, proposal_id, ordinal, from_status, to_status, reason_digest,
         actor_type, actor_id, transition_event_id, idempotency_key,
         request_digest, created_at
       ) values ($1,$2,0,null,'PENDING_REVIEW',$3,'NODE_BRAIN',$4,$5,$6,$7,$8)`,
      [randomUUID(), id, canonicalContentDigest("proposal-created"), nodeBrainId, event.id,
        `proposal-initial:${key}`, canonicalContentDigest({ proposalId: id, toStatus: "PENDING_REVIEW" }), event.occurredAt],
    );
    return hydrateProposal(transaction, rows[0]);
  });
}

const LEGAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  PENDING_REVIEW: ["CLARIFICATION_REQUESTED", "UNDER_REVIEW", "WITHDRAWN"],
  CLARIFICATION_REQUESTED: ["UNDER_REVIEW", "WITHDRAWN"],
  UNDER_REVIEW: ["QUEUED_FOR_DECISION", "WITHDRAWN"],
  QUEUED_FOR_DECISION: ["ACCEPTED", "REJECTED", "WITHDRAWN"],
  ACCEPTED: [], REJECTED: [], WITHDRAWN: [],
};

function transitionAuthorityAllows(
  actor: ProposalTurnActor,
  nodeBrainId: string,
  fromStatus: ProposalStatus,
  toStatus: ProposalStatus,
): boolean {
  if (actor.type === "NODE_BRAIN") {
    return actor.id === nodeBrainId && toStatus === "WITHDRAWN";
  }
  if (actor.type === "EVALUATOR") {
    return fromStatus === "UNDER_REVIEW" && toStatus === "QUEUED_FOR_DECISION";
  }
  if (actor.id !== "gustavo-main") return false;
  return (
    fromStatus === "PENDING_REVIEW"
      && ["CLARIFICATION_REQUESTED", "UNDER_REVIEW"].includes(toStatus)
  ) || (
    fromStatus === "CLARIFICATION_REQUESTED"
      && toStatus === "UNDER_REVIEW"
  ) || (
    fromStatus === "QUEUED_FOR_DECISION"
      && ["ACCEPTED", "REJECTED"].includes(toStatus)
  );
}

async function authorizeEvaluatorActor(
  database: EventDatabase,
  actorId: string,
  proposalCreatedEventId: string,
  errorCode: "PROPOSAL_TRANSITION_ACTOR_FORBIDDEN" | "PROPOSAL_TURN_ACTOR_FORBIDDEN",
): Promise<void> {
  if (!UUID_PATTERN.test(actorId)) throw new Error(errorCode);
  const rows = await database.query<{ readonly authorized: boolean }>(
    `select true as authorized from model_runs
     where id=$1 and role='EVALUATOR' and completion_status='COMPLETED'
       and causation_id=$2`,
    [actorId, proposalCreatedEventId],
  );
  if (!rows[0]) throw new Error(errorCode);
}

export async function transitionProposal(
  context: ProposalContext,
  input: TransitionProposalInput,
): Promise<ProposalProjection> {
  const database = databaseFrom(context);
  const proposalId = identifier(input?.proposalId, "PROPOSAL_TRANSITION_INPUT_INVALID");
  const key = idempotencyKey(input?.idempotencyKey);
  const reason = boundedText(input?.reason, MAX_UNCERTAINTY_LENGTH, "PROPOSAL_TRANSITION_REASON_INVALID");
  if (!input.actor || !["NODE_BRAIN", "MAIN_BRAIN", "EVALUATOR"].includes(input.actor.type)
    || typeof input.actor.id !== "string" || input.actor.id.trim().length < 1 || input.actor.id.length > 200) {
    throw new Error("PROPOSAL_TRANSITION_ACTOR_INVALID");
  }
  if (!PROPOSAL_STATUSES.includes(input.toStatus)) {
    throw new Error("PROPOSAL_STATUS_INVALID");
  }
  const requestDigest = canonicalContentDigest({ actor: input.actor, proposalId, reason, toStatus: input.toStatus });
  return database.transaction(async (transaction) => {
    await claimOperationIdempotency(transaction, {
      key, operation: "PROPOSAL_TRANSITION", aggregateScope: proposalId, requestDigest,
    });
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`proposal-state:${proposalId}`]);
    const proposals = await transaction.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from proposals where id=$1`, [proposalId]);
    if (!proposals[0]) throw new Error("PROPOSAL_NOT_FOUND");
    const duplicate = await transaction.query<TransitionRow>(
      "select to_status, ordinal, request_digest from proposal_status_transitions where idempotency_key=$1", [key],
    );
    if (duplicate[0]) {
      if (!digestsEqual(duplicate[0].request_digest, requestDigest)) throw new Error("PROPOSAL_IDEMPOTENCY_KEY_REUSED");
      return hydrateProposal(transaction, proposals[0]);
    }
    const latest = await transaction.one<TransitionRow>(
      `select to_status, ordinal, request_digest from proposal_status_transitions
       where proposal_id=$1 order by ordinal desc limit 1`, [proposalId],
    );
    if (input.actor.type === "EVALUATOR") {
      await authorizeEvaluatorActor(
        transaction, input.actor.id, proposals[0].created_event_id,
        "PROPOSAL_TRANSITION_ACTOR_FORBIDDEN",
      );
    }
    if (!transitionAuthorityAllows(
      input.actor, proposals[0].node_brain_id, latest.to_status, input.toStatus,
    )) {
      throw new Error("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");
    }
    if (!LEGAL_TRANSITIONS[latest.to_status].includes(input.toStatus)) {
      throw new Error("PROPOSAL_STATUS_TRANSITION_INVALID");
    }
    if (latest.ordinal + 1 >= MAX_PROPOSAL_STATUS_TRANSITIONS) {
      throw new Error("PROPOSAL_TRANSITION_LIMIT");
    }
    const event = await appendEvent(transaction, {
      aggregateId: proposalId,
      accountId: proposals[0].account_id,
      actor: input.actor,
      type: "node.proposal.status-transitioned",
      visibility: "PRIVATE_ACCOUNT",
      body: { fromStatus: latest.to_status, reason, toStatus: input.toStatus },
      idempotencyKey: `proposal-transition:${key}`,
      causationId: proposals[0].created_event_id,
      policyVersion: PROPOSAL_POLICY_VERSION,
    });
    await transaction.query(
      `insert into proposal_status_transitions (
         id, proposal_id, ordinal, from_status, to_status, reason_digest,
         actor_type, actor_id, transition_event_id, idempotency_key,
         request_digest, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), proposalId, latest.ordinal + 1, latest.to_status, input.toStatus,
        canonicalContentDigest(reason), input.actor.type, input.actor.id, event.id, key, requestDigest, event.occurredAt],
    );
    return hydrateProposal(transaction, proposals[0]);
  });
}

function parseTurnBody(body: JsonValue): {
  readonly text: string;
  readonly evidence: readonly EvidenceReference[];
  readonly usesProposalPrivateText: boolean;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("PROPOSAL_TURN_INTEGRITY_FAILURE");
  const record = body as Record<string, JsonValue>;
  if (typeof record.text !== "string"
    || (record.usesProposalPrivateText !== undefined && typeof record.usesProposalPrivateText !== "boolean")) {
    throw new Error("PROPOSAL_TURN_INTEGRITY_FAILURE");
  }
  return {
    text: record.text,
    evidence: canonicalEvidenceReferences(record.evidence, { max: MAX_EVIDENCE_REFERENCES, allowEmpty: true }),
    usesProposalPrivateText: record.usesProposalPrivateText === true,
  };
}

async function hydrateTurn(database: EventDatabase, row: TurnRow): Promise<ProposalTurn> {
  const proposals = await database.query<ProposalRow>(
    `select ${PROPOSAL_COLUMNS} from proposals where id=$1`, [row.proposal_id],
  );
  const proposal = proposals[0];
  if (!proposal) throw new Error("PROPOSAL_TURN_INTEGRITY_FAILURE");
  await authorizeSourceGraph(database, {
    accountId: proposal.account_id,
    conversationId: proposal.conversation_id,
    nodeBrainId: proposal.node_brain_id,
    sourceEventIds: parsedSourceEvents(proposal.source_event_ids),
  });
  const body = parseTurnBody(await readEventBody(database, row.turn_event_id, {
    actor: { role: "ACCOUNT", accountId: proposal.account_id },
  }));
  let text = body.text;
  if (body.usesProposalPrivateText) {
    if (!proposal.disclosure_authorization_id || !proposal.raw_private_text_digest
      || !proposal.raw_private_text_event_id || body.text !== "[AUTHORIZED PRIVATE TEXT]") {
      throw new Error("PROPOSAL_TURN_INTEGRITY_FAILURE");
    }
    let active = false;
    try {
      await disclosureFor(database, proposal.disclosure_authorization_id, {
        accountId: proposal.account_id,
        conversationId: proposal.conversation_id,
        sourceEventIds: parsedSourceEvents(proposal.source_event_ids),
        disclosedTextDigest: proposal.raw_private_text_digest,
      });
      const privateText = parseRawPrivateText(
        await readEventBody(database, proposal.raw_private_text_event_id, {
          actor: { role: "ACCOUNT", accountId: proposal.account_id },
        }),
      );
      if (canonicalContentDigest(normalizedDisclosureText(privateText)) !== proposal.raw_private_text_digest) {
        throw new Error("PROPOSAL_TURN_INTEGRITY_FAILURE");
      }
      text = privateText;
      active = true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PROPOSAL_DISCLOSURE_FORBIDDEN") throw error;
    }
    if (!active) text = "[REDACTED PRIVATE TEXT]";
  }
  const actor = row.actor_type === "MAIN_BRAIN"
    ? { type: "MAIN_BRAIN" as const, id: "gustavo-main" as const }
    : row.actor_type === "EVALUATOR"
      ? { type: "EVALUATOR" as const, id: row.actor_id }
      : { type: "NODE_BRAIN" as const, id: row.actor_id };
  return Object.freeze({
    id: row.id, proposalId: row.proposal_id, kind: row.kind, actor,
    ordinal: row.ordinal, sourceEventIds: parsedSourceEvents(row.source_event_ids),
    text, evidence: body.evidence, eventId: row.turn_event_id,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export async function addProposalTurn(
  context: ProposalContext,
  input: AddProposalTurnInput,
): Promise<ProposalTurn> {
  const database = databaseFrom(context);
  const proposalId = identifier(input?.proposalId, "PROPOSAL_TURN_INPUT_INVALID");
  const accountId = identifier(input?.accountId, "PROPOSAL_TURN_INPUT_INVALID");
  const nodeBrainId = identifier(input?.nodeBrainId, "PROPOSAL_TURN_INPUT_INVALID");
  if (!input.actor || !["NODE_BRAIN", "MAIN_BRAIN", "EVALUATOR"].includes(input.actor.type)
    || typeof input.actor.id !== "string" || input.actor.id.trim().length < 1 || input.actor.id.length > 200) {
    throw new Error("PROPOSAL_TURN_ACTOR_INVALID");
  }
  if (input.actor.type === "MAIN_BRAIN" && input.actor.id !== "gustavo-main") {
    throw new Error("PROPOSAL_TURN_ACTOR_INVALID");
  }
  if (input.kind !== "CLARIFICATION" && input.kind !== "REVIEW") throw new Error("PROPOSAL_TURN_KIND_INVALID");
  const text = boundedText(input.text, MAX_TURN_TEXT_LENGTH, "PROPOSAL_TURN_TEXT_INVALID");
  const sourceEventIds = canonicalSourceEvents(input.sourceEventIds);
  const evidence = canonicalEvidenceReferences(input.evidence, { max: MAX_EVIDENCE_REFERENCES, allowEmpty: true });
  const key = idempotencyKey(input.idempotencyKey);
  const requestDigest = canonicalContentDigest({ accountId, actor: input.actor, evidence,
    kind: input.kind, nodeBrainId, proposalId, sourceEventIds, text });
  return database.transaction(async (transaction) => {
    await claimOperationIdempotency(transaction, {
      key, operation: "PROPOSAL_TURN", aggregateScope: proposalId, requestDigest,
    });
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`proposal-state:${proposalId}`]);
    const proposals = await transaction.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from proposals where id=$1`, [proposalId]);
    const proposal = proposals[0];
    if (!proposal || proposal.account_id !== accountId || proposal.node_brain_id !== nodeBrainId) {
      throw new Error("PROPOSAL_TURN_FORBIDDEN");
    }
    if (input.actor.type === "NODE_BRAIN" && input.actor.id !== nodeBrainId) {
      throw new Error("PROPOSAL_TURN_ACTOR_FORBIDDEN");
    }
    if (input.actor.type === "EVALUATOR") {
      await authorizeEvaluatorActor(
        transaction, input.actor.id, proposal.created_event_id,
        "PROPOSAL_TURN_ACTOR_FORBIDDEN",
      );
    }
    await authorizeSourceGraph(transaction, {
      accountId, conversationId: proposal.conversation_id, nodeBrainId,
      sourceEventIds,
    });
    await authorizeEvidenceReferences(transaction, {
      accountId, conversationId: proposal.conversation_id, sourceEventIds, references: evidence,
    });
    const texts = await sourceTexts(transaction, accountId, sourceEventIds);
    const usesProposalPrivateText = copiesPrivateSource(text, texts);
    if (usesProposalPrivateText) {
      const digest = canonicalContentDigest(normalizedDisclosureText(text));
      if (!proposal.disclosure_authorization_id || proposal.raw_private_text_digest !== digest
        || !proposal.raw_private_text_event_id) {
        throw new Error("PROPOSAL_PRIVATE_TEXT_DISCLOSURE_REQUIRED");
      }
      await disclosureFor(transaction, proposal.disclosure_authorization_id, {
        accountId, conversationId: proposal.conversation_id,
        sourceEventIds: parsedSourceEvents(proposal.source_event_ids),
        disclosedTextDigest: digest,
      });
    }
    const duplicate = await transaction.query<TurnRow>(
      `select id::text, proposal_id::text, actor_type, actor_id, kind, ordinal,
              source_event_ids, turn_event_id::text, request_digest, created_at
       from proposal_turns where idempotency_key=$1`, [key],
    );
    if (duplicate[0]) {
      if (!digestsEqual(duplicate[0].request_digest, requestDigest)) throw new Error("PROPOSAL_IDEMPOTENCY_KEY_REUSED");
      return hydrateTurn(transaction, duplicate[0]);
    }
    const status = await currentStatus(transaction, proposalId);
    const requiredStatus: ProposalStatus = input.kind === "CLARIFICATION" ? "CLARIFICATION_REQUESTED" : "UNDER_REVIEW";
    if (status !== requiredStatus) throw new Error("PROPOSAL_TURN_STATUS_INVALID");
    if (input.kind === "CLARIFICATION"
      && (input.actor.type !== "NODE_BRAIN" || input.actor.id !== nodeBrainId)) {
      throw new Error("PROPOSAL_TURN_ACTOR_FORBIDDEN");
    }
    if (input.kind === "REVIEW" && input.actor.type === "NODE_BRAIN") {
      throw new Error("PROPOSAL_TURN_ACTOR_FORBIDDEN");
    }
    const count = await transaction.one<{ readonly count: number }>(
      "select count(*)::int as count from proposal_turns where proposal_id=$1 and kind=$2",
      [proposalId, input.kind],
    );
    const limit = input.kind === "CLARIFICATION" ? MAX_CLARIFICATION_TURNS : MAX_REVIEW_TURNS;
    if (count.count >= limit) {
      throw new Error(input.kind === "CLARIFICATION"
        ? "PROPOSAL_CLARIFICATION_TURN_LIMIT" : "PROPOSAL_REVIEW_TURN_LIMIT");
    }
    if (input.kind === "REVIEW" && evidence.length === 0) {
      throw new Error("PROPOSAL_REVIEW_EVIDENCE_REQUIRED");
    }
    const id = randomUUID();
    const event = await appendEvent(transaction, {
      aggregateId: proposalId,
      accountId,
      actor: input.actor,
      type: "debate.turn.created",
      visibility: "PRIVATE_ACCOUNT",
      body: { actor: input.actor, evidence: jsonReferences(evidence), kind: input.kind,
        sourceEventIds: [...sourceEventIds],
        text: usesProposalPrivateText ? "[AUTHORIZED PRIVATE TEXT]" : text,
        usesProposalPrivateText },
      idempotencyKey: `proposal-turn:${key}`,
      causationId: proposal.created_event_id,
      policyVersion: PROPOSAL_POLICY_VERSION,
    });
    const rows = await transaction.query<TurnRow>(
      `insert into proposal_turns (
         id, proposal_id, account_id, node_brain_id, actor_type, actor_id,
         kind, ordinal, source_event_ids, text_digest, evidence_count,
         turn_event_id, idempotency_key, request_digest, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
       returning id::text, proposal_id::text, actor_type, actor_id, kind, ordinal,
                 source_event_ids, turn_event_id::text, request_digest, created_at`,
      [id, proposalId, accountId, nodeBrainId, input.actor.type, input.actor.id,
        input.kind, count.count, JSON.stringify(sourceEventIds), canonicalContentDigest(text),
        evidence.length, event.id, key, requestDigest, event.occurredAt],
    );
    for (const [ordinal, reference] of evidence.entries()) {
      await transaction.query(
        `insert into proposal_turn_evidence_links
           (turn_id, ordinal, reference_kind, reference_id) values ($1,$2,$3,$4)`,
        [id, ordinal, reference.kind, reference.referenceId],
      );
    }
    return hydrateTurn(transaction, rows[0]);
  });
}
