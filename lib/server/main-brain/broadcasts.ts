import { randomUUID } from "node:crypto";
import editorialPolicy from "../../../policy/editorial-policy.json";
import {
  canonicalContentDigest,
  digestsEqual,
} from "../events/integrity";
import { appendEvent, readEventBody } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { assertBroadcastEditorialPolicy } from "./editorial-validator";

const MAIN_BRAIN_ID = "gustavo-main";
export const BROADCAST_POLICY_VERSION = "main-broadcast-policy-v1";
const MAX_BROADCAST_BODY_LENGTH = 20_000;
const MAX_BROADCAST_SOURCES = 64;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:./_-]{0,199}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const LOCALE_CHARACTERS = /^[A-Za-z0-9-]+$/;
// Supported v1 BCP-47 subset: lowercase 2-3 letter language, optional
// Titlecase script, and optional uppercase alpha or three-digit region.
const CANONICAL_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BROADCAST_LOCALE_LENGTH = 35;

export interface BroadcastContext {
  readonly db: EventDatabase;
}

export interface CommitBroadcastInput {
  readonly mainStateVersion: number;
  readonly body: string;
  readonly sourceIds: readonly string[];
  readonly idempotencyKey?: string;
}

export interface CommittedBroadcast {
  readonly id: string;
  readonly mainStateVersion: number;
  readonly body: string;
  readonly bodyDigest: string;
  readonly sourceIds: readonly string[];
  readonly author: {
    readonly type: "MAIN_BRAIN";
    readonly stateVersion: number;
  };
  readonly commitEventId: string;
  readonly committedAt: string;
}

export interface DeliveryProjectionInput {
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly locale: string;
}

export interface BroadcastDelivery {
  readonly id: string;
  readonly broadcastId: string;
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly locale: string;
  readonly body: string;
  readonly bodyDigest: string;
  readonly author: {
    readonly type: "MAIN_BRAIN";
    readonly stateVersion: number;
  };
  readonly deliveryEventId: string;
  readonly createdAt: string;
}

interface BroadcastRow extends Record<string, unknown> {
  readonly id: string;
  readonly main_state_version: string | number;
  readonly author_type: string;
  readonly author_id: string;
  readonly body_digest: string;
  readonly source_ids: unknown;
  readonly policy_version: string;
  readonly commit_event_id: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly committed_at: Date;
}

interface DeliveryRow extends Record<string, unknown> {
  readonly id: string;
  readonly broadcast_id: string;
  readonly account_id: string;
  readonly node_brain_id: string;
  readonly body_digest: string;
  readonly author_type: string;
  readonly main_state_version: string | number;
  readonly locale: string;
  readonly request_digest: string;
  readonly delivery_event_id: string;
  readonly created_at: Date;
}

interface BroadcastEventBody {
  readonly author: { readonly type: "MAIN_BRAIN"; readonly stateVersion: number };
  readonly body: string;
  readonly bodyDigest: string;
  readonly contentClassification: string;
  readonly policyVersion: string;
  readonly sourceIds: readonly string[];
}

const BROADCAST_COLUMNS = `
  id::text, main_state_version, author_type, author_id, body_digest,
  source_ids, policy_version, commit_event_id::text, idempotency_key,
  request_digest, committed_at
`;

const DELIVERY_COLUMNS = `
  id::text, broadcast_id::text, account_id::text, node_brain_id::text,
  body_digest, author_type, main_state_version, locale,
  request_digest, delivery_event_id::text, created_at
`;

function requireContext(context: BroadcastContext): EventDatabase {
  if (!context || typeof context !== "object" || !context.db) {
    throw new Error("BROADCAST_CONTEXT_INVALID");
  }
  return context.db;
}

function assertPolicy(): void {
  if (
    editorialPolicy.productName !== "Gustavo"
    || editorialPolicy.realExecutionEnabled !== false
    || editorialPolicy.contentClassification !== "EDUCATIONAL_MARKET_COMMENTARY"
    || editorialPolicy.canonicalOrigin !== "https://gustavo.lol"
  ) {
    throw new Error("BROADCAST_POLICY_INVALID");
  }
}

function validateMainStateVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("BROADCAST_MAIN_STATE_VERSION_INVALID");
  }
  return value as number;
}

function validateBody(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_BROADCAST_BODY_LENGTH
    || value !== value.trim()
    || value.includes("\u0000")
  ) {
    throw new Error("BROADCAST_BODY_INVALID");
  }
  assertBroadcastEditorialPolicy(value);
  return value;
}

function canonicalizeSources(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BROADCAST_SOURCES) {
    throw new Error("BROADCAST_SOURCES_INVALID");
  }
  const sources = value.map((source) => {
    if (typeof source !== "string" || !SOURCE_ID_PATTERN.test(source)) {
      throw new Error("BROADCAST_SOURCE_ID_INVALID");
    }
    return source;
  });
  return Object.freeze([...new Set(sources)].sort());
}

function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("BROADCAST_IDEMPOTENCY_KEY_INVALID");
  }
  return value;
}

function validateIdentifier(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("BROADCAST_DELIVERY_INPUT_INVALID");
  }
  return value;
}

function validateDeliveryInput(value: DeliveryProjectionInput): DeliveryProjectionInput {
  if (!value || typeof value !== "object") {
    throw new Error("BROADCAST_DELIVERY_INPUT_INVALID");
  }
  const accountId = validateIdentifier(value.accountId);
  const nodeBrainId = validateIdentifier(value.nodeBrainId);
  const locale = canonicalBroadcastLocale(value.locale);
  return Object.freeze({ accountId, nodeBrainId, locale });
}

export function canonicalBroadcastLocale(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > MAX_BROADCAST_LOCALE_LENGTH
    || !LOCALE_CHARACTERS.test(value)
  ) {
    throw new Error("BROADCAST_DELIVERY_INPUT_INVALID");
  }
  try {
    const locales = Intl.getCanonicalLocales(value);
    const canonical = locales[0];
    if (
      locales.length !== 1
      || !canonical
      || canonical.length > MAX_BROADCAST_LOCALE_LENGTH
      || !CANONICAL_LOCALE_PATTERN.test(canonical)
    ) {
      throw new Error("BROADCAST_DELIVERY_INPUT_INVALID");
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message === "BROADCAST_DELIVERY_INPUT_INVALID") {
      throw error;
    }
    throw new Error("BROADCAST_DELIVERY_INPUT_INVALID");
  }
}

function parseVersion(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return validateMainStateVersion(parsed);
}

function parseBroadcastEventBody(value: JsonValue): BroadcastEventBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BROADCAST_INTEGRITY_FAILURE");
  }
  const record = value as Record<string, JsonValue>;
  const author = record.author;
  if (!author || typeof author !== "object" || Array.isArray(author)) {
    throw new Error("BROADCAST_INTEGRITY_FAILURE");
  }
  const authorRecord = author as Record<string, JsonValue>;
  if (
    authorRecord.type !== "MAIN_BRAIN"
    || typeof authorRecord.stateVersion !== "number"
    || typeof record.body !== "string"
    || typeof record.bodyDigest !== "string"
    || typeof record.contentClassification !== "string"
    || typeof record.policyVersion !== "string"
    || !Array.isArray(record.sourceIds)
    || record.sourceIds.some((source) => typeof source !== "string")
  ) {
    throw new Error("BROADCAST_INTEGRITY_FAILURE");
  }
  return {
    author: {
      type: "MAIN_BRAIN",
      stateVersion: authorRecord.stateVersion,
    },
    body: record.body,
    bodyDigest: record.bodyDigest,
    contentClassification: record.contentClassification,
    policyVersion: record.policyVersion,
    sourceIds: record.sourceIds as string[],
  };
}

function freezeAuthor(stateVersion: number): CommittedBroadcast["author"] {
  return Object.freeze({ type: "MAIN_BRAIN" as const, stateVersion });
}

async function hydrateBroadcast(
  database: EventDatabase,
  row: BroadcastRow,
): Promise<CommittedBroadcast> {
  const mainStateVersion = parseVersion(row.main_state_version);
  const sourceIds = canonicalizeSources(row.source_ids);
  const eventBody = parseBroadcastEventBody(
    await readEventBody(database, row.commit_event_id, { actor: { role: "SYSTEM" } }),
  );
  const calculatedDigest = canonicalContentDigest(eventBody.body);
  if (
    row.author_type !== "MAIN_BRAIN"
    || row.author_id !== MAIN_BRAIN_ID
    || row.policy_version !== BROADCAST_POLICY_VERSION
    || eventBody.author.type !== "MAIN_BRAIN"
    || eventBody.author.stateVersion !== mainStateVersion
    || eventBody.policyVersion !== BROADCAST_POLICY_VERSION
    || eventBody.contentClassification !== editorialPolicy.contentClassification
    || !digestsEqual(row.body_digest, eventBody.bodyDigest)
    || !digestsEqual(row.body_digest, calculatedDigest)
    || canonicalContentDigest(sourceIds) !== canonicalContentDigest(eventBody.sourceIds)
  ) {
    throw new Error("BROADCAST_INTEGRITY_FAILURE");
  }
  return Object.freeze({
    id: row.id,
    mainStateVersion,
    body: eventBody.body,
    bodyDigest: row.body_digest,
    sourceIds,
    author: freezeAuthor(mainStateVersion),
    commitEventId: row.commit_event_id,
    committedAt: new Date(row.committed_at).toISOString(),
  });
}

async function broadcastRowById(
  database: EventDatabase,
  broadcastId: string,
): Promise<BroadcastRow> {
  const rows = await database.query<BroadcastRow>(
    `select ${BROADCAST_COLUMNS} from broadcasts where id=$1`,
    [broadcastId],
  );
  if (!rows[0]) {
    throw new Error("BROADCAST_NOT_FOUND");
  }
  return rows[0];
}

export async function commitBroadcast(
  context: BroadcastContext,
  input: CommitBroadcastInput,
): Promise<CommittedBroadcast> {
  const database = requireContext(context);
  assertPolicy();
  if (!input || typeof input !== "object") {
    throw new Error("BROADCAST_INPUT_INVALID");
  }
  const mainStateVersion = validateMainStateVersion(input.mainStateVersion);
  const body = validateBody(input.body);
  const sourceIds = canonicalizeSources(input.sourceIds);
  const bodyDigest = canonicalContentDigest(body);
  const requestDigest = canonicalContentDigest({ bodyDigest, mainStateVersion, sourceIds });
  const idempotencyKey = input.idempotencyKey === undefined
    ? requestDigest
    : validateIdempotencyKey(input.idempotencyKey);

  return database.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `broadcast:${idempotencyKey}`,
    ]);
    const duplicates = await transaction.query<BroadcastRow>(
      `select ${BROADCAST_COLUMNS} from broadcasts where idempotency_key=$1`,
      [idempotencyKey],
    );
    if (duplicates[0]) {
      if (!digestsEqual(duplicates[0].request_digest, requestDigest)) {
        throw new Error("BROADCAST_IDEMPOTENCY_KEY_REUSED");
      }
      return hydrateBroadcast(transaction, duplicates[0]);
    }

    await transaction.query(
      `insert into main_state_versions(version, author_type, author_id, status)
       values ($1, 'MAIN_BRAIN', $2, 'COMMITTED')
       on conflict (version) do nothing`,
      [mainStateVersion, MAIN_BRAIN_ID],
    );
    const id = randomUUID();
    const event = await appendEvent(transaction, {
      aggregateId: id,
      actor: { type: "MAIN_BRAIN", id: MAIN_BRAIN_ID },
      type: "main.broadcast.committed",
      visibility: "SHARED",
      body: {
        author: { type: "MAIN_BRAIN", stateVersion: mainStateVersion },
        body,
        bodyDigest,
        contentClassification: editorialPolicy.contentClassification,
        policyVersion: BROADCAST_POLICY_VERSION,
        sourceIds: [...sourceIds],
      },
      idempotencyKey: `main-broadcast:${idempotencyKey}`,
      policyVersion: BROADCAST_POLICY_VERSION,
    });
    const rows = await transaction.query<BroadcastRow>(
      `insert into broadcasts (
         id, main_state_version, author_type, author_id, body_digest,
         source_ids, policy_version, commit_event_id, idempotency_key,
         request_digest, committed_at
       ) values ($1, $2, 'MAIN_BRAIN', $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
       returning ${BROADCAST_COLUMNS}`,
      [
        id,
        mainStateVersion,
        MAIN_BRAIN_ID,
        bodyDigest,
        JSON.stringify(sourceIds),
        BROADCAST_POLICY_VERSION,
        event.id,
        idempotencyKey,
        requestDigest,
        event.occurredAt,
      ],
    );
    return hydrateBroadcast(transaction, rows[0]);
  });
}

async function authorizeDelivery(
  database: EventDatabase,
  input: DeliveryProjectionInput,
): Promise<void> {
  const rows = await database.query<{ readonly authorized: boolean }>(
    `select true as authorized
     from accounts account
     join entitlements entitlement
       on entitlement.account_id=account.id
      and entitlement.revoked_at is null
      and entitlement.active_from <= clock_timestamp()
      and (entitlement.expires_at is null or entitlement.expires_at > clock_timestamp())
     join node_brains node
       on node.account_id=account.id
      and node.id=$2
      and node.status='ACTIVE'
     where account.id=$1 and account.status='ACTIVE'`,
    [input.accountId, input.nodeBrainId],
  );
  if (!rows[0]) {
    throw new Error("BROADCAST_DELIVERY_FORBIDDEN");
  }
}

function hydrateDelivery(
  row: DeliveryRow,
  broadcast: CommittedBroadcast,
): BroadcastDelivery {
  const stateVersion = parseVersion(row.main_state_version);
  const calculatedRequestDigest = canonicalContentDigest({
    accountId: row.account_id,
    broadcastId: row.broadcast_id,
    locale: row.locale,
    nodeBrainId: row.node_brain_id,
  });
  if (
    row.broadcast_id !== broadcast.id
    || row.body_digest !== broadcast.bodyDigest
    || row.author_type !== "MAIN_BRAIN"
    || stateVersion !== broadcast.mainStateVersion
    || !digestsEqual(row.request_digest, calculatedRequestDigest)
  ) {
    throw new Error("BROADCAST_DELIVERY_INTEGRITY_FAILURE");
  }
  return Object.freeze({
    id: row.id,
    broadcastId: row.broadcast_id,
    accountId: row.account_id,
    nodeBrainId: row.node_brain_id,
    locale: row.locale,
    body: broadcast.body,
    bodyDigest: broadcast.bodyDigest,
    author: freezeAuthor(broadcast.mainStateVersion),
    deliveryEventId: row.delivery_event_id,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export async function projectDelivery(
  context: BroadcastContext,
  broadcastId: string,
  input: DeliveryProjectionInput,
): Promise<BroadcastDelivery> {
  const database = requireContext(context);
  const normalizedBroadcastId = validateIdentifier(broadcastId);
  const normalizedInput = validateDeliveryInput(input);
  const requestDigest = canonicalContentDigest({
    accountId: normalizedInput.accountId,
    broadcastId: normalizedBroadcastId,
    locale: normalizedInput.locale,
    nodeBrainId: normalizedInput.nodeBrainId,
  });

  return database.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `broadcast-delivery:${normalizedBroadcastId}:${normalizedInput.accountId}`,
    ]);
    // Account/Node scope is established before any committed body is decrypted.
    await authorizeDelivery(transaction, normalizedInput);
    const broadcast = await hydrateBroadcast(
      transaction,
      await broadcastRowById(transaction, normalizedBroadcastId),
    );
    const existing = await transaction.query<DeliveryRow>(
      `select ${DELIVERY_COLUMNS}
       from deliveries where broadcast_id=$1 and account_id=$2`,
      [normalizedBroadcastId, normalizedInput.accountId],
    );
    if (existing[0]) {
      if (!digestsEqual(existing[0].request_digest, requestDigest)) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return hydrateDelivery(existing[0], broadcast);
    }

    const id = randomUUID();
    const event = await appendEvent(transaction, {
      aggregateId: broadcast.id,
      accountId: normalizedInput.accountId,
      actor: { type: "MAIN_BRAIN", id: MAIN_BRAIN_ID },
      type: "main.broadcast.delivered",
      visibility: "PRIVATE_ACCOUNT",
      body: {
        author: broadcast.author,
        bodyDigest: broadcast.bodyDigest,
        broadcastId: broadcast.id,
        transport: {
          locale: normalizedInput.locale,
          nodeBrainId: normalizedInput.nodeBrainId,
        },
      },
      idempotencyKey: `main-broadcast-delivery:${broadcast.id}:${normalizedInput.accountId}`,
      causationId: broadcast.commitEventId,
      policyVersion: BROADCAST_POLICY_VERSION,
    });
    const rows = await transaction.query<DeliveryRow>(
      `insert into deliveries (
         id, broadcast_id, account_id, node_brain_id, body_digest,
         author_type, main_state_version, locale, request_digest,
         delivery_event_id, created_at
       ) values ($1, $2, $3, $4, $5, 'MAIN_BRAIN', $6, $7, $8, $9, $10)
       returning ${DELIVERY_COLUMNS}`,
      [
        id,
        broadcast.id,
        normalizedInput.accountId,
        normalizedInput.nodeBrainId,
        broadcast.bodyDigest,
        broadcast.mainStateVersion,
        normalizedInput.locale,
        requestDigest,
        event.id,
        event.occurredAt,
      ],
    );
    return hydrateDelivery(rows[0], broadcast);
  });
}
