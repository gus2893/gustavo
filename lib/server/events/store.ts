import { randomBytes } from "node:crypto";
import {
  createAndWrapDataKey,
  decryptEventBody,
  encryptEventBody,
  unwrapDataKey,
  wrapDataKey,
  type WrappedDataKey,
} from "../crypto/envelope";
import type {
  AppendEventInput,
  EventDatabase,
  EventReadContext,
  EventVisibility,
  JsonValue,
  StoredEvent,
} from "./types";
import {
  canonicalContentDigest,
  canonicalJson,
  digestsEqual,
} from "./integrity";

export interface EventBodyResult {
  readonly eventId: string;
  readonly body: JsonValue;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  aggregate_id: string;
  account_id: string | null;
  actor_type: StoredEvent["actor"]["type"];
  actor_id: string;
  type: string;
  visibility: EventVisibility;
  occurred_at: Date;
  causation_id: string | null;
  correlation_id: string;
  prompt_version: string | null;
  model_version: string | null;
  policy_version: string | null;
  request_hash: string;
  integrity_hash: string;
}

interface IdempotentEventRow extends EventRow {
  idempotency_key: string;
}

interface AggregateKeyRow extends Record<string, unknown> {
  id: string;
  aggregate_id: string;
  root_key_version: number;
  wrapped_key: Buffer;
  wrap_iv: Buffer;
  wrap_auth_tag: Buffer;
}

interface EncryptedBodyRow extends Record<string, unknown> {
  aggregate_id: string;
  data_key_id: string | null;
  ciphertext: Buffer;
  body_iv: Buffer;
  body_auth_tag: Buffer;
}

const UUID_V7_RANDOM_MASK = (1n << 74n) - 1n;
let lastUuidTimestamp = 0;
let lastUuidRandom = 0n;

function random74Bits(): bigint {
  return BigInt(`0x${randomBytes(10).toString("hex")}`) & UUID_V7_RANDOM_MASK;
}

function nextUuidV7(): string {
  let timestamp = Date.now();
  let randomness = random74Bits();
  if (timestamp < lastUuidTimestamp) {
    timestamp = lastUuidTimestamp;
  }
  if (timestamp === lastUuidTimestamp) {
    randomness = (lastUuidRandom + 1n) & UUID_V7_RANDOM_MASK;
    if (randomness === 0n) {
      timestamp += 1;
      randomness = random74Bits();
    }
  }
  lastUuidTimestamp = timestamp;
  lastUuidRandom = randomness;

  const bytes = Buffer.alloc(16);
  let remainingTimestamp = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remainingTimestamp & 0xffn);
    remainingTimestamp >>= 8n;
  }
  const randomA = Number(randomness >> 62n);
  const randomB = randomness & ((1n << 62n) - 1n);
  bytes[6] = 0x70 | ((randomA >> 8) & 0x0f);
  bytes[7] = randomA & 0xff;
  bytes[8] = 0x80 | Number((randomB >> 56n) & 0x3fn);
  for (let index = 9; index < 16; index += 1) {
    const shift = BigInt((15 - index) * 8);
    bytes[index] = Number((randomB >> shift) & 0xffn);
  }
  const hexadecimal = bytes.toString("hex");
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`INVALID_EVENT_${field.toUpperCase()}`);
  }
  return value;
}

function requestDocument(input: AppendEventInput, accountId: string | null): unknown {
  return {
    accountId,
    actor: input.actor,
    aggregateId: input.aggregateId,
    body: input.body,
    causationId: input.causationId ?? null,
    correlationId: input.correlationId ?? null,
    idempotencyKey: input.idempotencyKey,
    modelVersion: input.modelVersion ?? null,
    occurredAt: input.occurredAt?.toISOString() ?? null,
    policyVersion: input.policyVersion ?? null,
    promptVersion: input.promptVersion ?? null,
    type: input.type,
    visibility: input.visibility,
  };
}

function integrityDocument(event: Omit<StoredEvent, "integrityHash">, body: JsonValue): unknown {
  return {
    accountId: event.accountId,
    actor: event.actor,
    aggregateId: event.aggregateId,
    body,
    causationId: event.causationId,
    correlationId: event.correlationId,
    id: event.id,
    modelVersion: event.modelVersion,
    occurredAt: event.occurredAt.toISOString(),
    policyVersion: event.policyVersion,
    promptVersion: event.promptVersion,
    type: event.type,
    visibility: event.visibility,
  };
}

function mapEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    accountId: row.account_id,
    actor: { type: row.actor_type, id: row.actor_id },
    type: row.type,
    visibility: row.visibility,
    occurredAt: new Date(row.occurred_at),
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    promptVersion: row.prompt_version,
    modelVersion: row.model_version,
    policyVersion: row.policy_version,
    integrityHash: row.integrity_hash,
  };
}

function wrappedFromAggregateRow(row: AggregateKeyRow): WrappedDataKey {
  return {
    rootKeyVersion: row.root_key_version,
    wrappedKey: row.wrapped_key,
    iv: row.wrap_iv,
    authTag: row.wrap_auth_tag,
  };
}

function eventOwner(input: AppendEventInput): string | null {
  if (input.accountId) {
    return requireNonEmpty(input.accountId, "account_id");
  }
  if (input.actor.type === "USER") {
    return requireNonEmpty(input.actor.id, "actor_id");
  }
  if (input.visibility === "PRIVATE_ACCOUNT") {
    throw new Error("PRIVATE_EVENT_REQUIRES_ACCOUNT");
  }
  return null;
}

function authorizeRead(event: StoredEvent, context: EventReadContext): void {
  const actor = context.actor;
  if (actor.role === "SYSTEM") {
    return;
  }
  if (event.visibility === "PUBLIC") {
    return;
  }
  if (event.visibility === "PRIVATE_ACCOUNT") {
    if (actor.role === "ACCOUNT" && actor.accountId === event.accountId) {
      return;
    }
    if (
      (actor.role === "MODERATOR" || actor.role === "OPERATOR") &&
      actor.purpose.trim().length > 0
    ) {
      return;
    }
    throw new Error("FORBIDDEN");
  }
  if (event.visibility === "SHARED") {
    if (actor.role !== "PUBLIC") {
      return;
    }
    throw new Error("FORBIDDEN");
  }
  if (event.visibility === "OPERATOR" && actor.role === "OPERATOR" && actor.purpose.trim()) {
    return;
  }
  throw new Error("FORBIDDEN");
}

const EVENT_COLUMNS = `
  id, aggregate_id, account_id, actor_type, actor_id, type, visibility,
  occurred_at, causation_id, correlation_id, prompt_version, model_version,
  policy_version, request_hash, integrity_hash
`;

const EVENT_APPEND_BATCH_LIMIT = 100;

function batchValues(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, row) => (
    `(${Array.from({ length: columnCount }, (__, column) => (
      `$${row * columnCount + column + 1}`
    )).join(",")})`
  )).join(",");
}

interface PreparedAppend {
  readonly input: AppendEventInput;
  readonly accountId: string | null;
  readonly requestHash: string;
}

function prepareAppend(input: AppendEventInput): PreparedAppend {
  requireNonEmpty(input.aggregateId, "aggregate_id");
  requireNonEmpty(input.actor.id, "actor_id");
  requireNonEmpty(input.type, "type");
  requireNonEmpty(input.idempotencyKey, "idempotency_key");
  const accountId = eventOwner(input);
  return Object.freeze({
    input,
    accountId,
    requestHash: canonicalContentDigest(requestDocument(input, accountId)),
  });
}

export async function appendEvents(
  database: EventDatabase,
  inputs: readonly AppendEventInput[],
): Promise<readonly StoredEvent[]> {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > EVENT_APPEND_BATCH_LIMIT) {
    throw new Error("EVENT_APPEND_BATCH_LIMIT");
  }
  const prepared = inputs.map(prepareAppend);
  const uniqueByIdempotency = new Map<string, PreparedAppend>();
  for (const item of prepared) {
    const prior = uniqueByIdempotency.get(item.input.idempotencyKey);
    if (prior && prior.requestHash !== item.requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED");
    uniqueByIdempotency.set(item.input.idempotencyKey, prior ?? item);
  }
  const unique = [...uniqueByIdempotency.values()];

  return database.transaction(async (transaction) => {
    const idempotencyKeys = [...uniqueByIdempotency.keys()].sort();
    await transaction.query(
      `select pg_advisory_xact_lock(hashtextextended(item,0))
         from unnest($1::text[]) item order by item`,
      [idempotencyKeys.map((key) => `event-idempotency:${key}`)],
    );
    const duplicates = await transaction.query<IdempotentEventRow>(
      `select ${EVENT_COLUMNS},idempotency_key from events
        where idempotency_key=any($1::text[])`,
      [idempotencyKeys],
    );
    const eventsByKey = new Map<string, StoredEvent>();
    const requestByKey = new Map(unique.map((item) => [item.input.idempotencyKey, item]));
    for (const duplicate of duplicates) {
      const requested = requestByKey.get(duplicate.idempotency_key);
      if (!requested || duplicate.request_hash !== requested.requestHash) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      eventsByKey.set(duplicate.idempotency_key, mapEvent(duplicate));
    }
    const pending = unique.filter(({ input }) => !eventsByKey.has(input.idempotencyKey));
    if (pending.length === 0) {
      return Object.freeze(prepared.map(({ input }) => eventsByKey.get(input.idempotencyKey)!));
    }

    const aggregateIds = [...new Set(pending.map(({ input }) => input.aggregateId))].sort();
    await transaction.query(
      `select pg_advisory_xact_lock(hashtextextended(item,0))
         from unnest($1::text[]) item order by item`,
      [aggregateIds.map((aggregateId) => `aggregate-key:${aggregateId}`)],
    );
    const keyRows = await transaction.query<AggregateKeyRow>(
      `select id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
         from aggregate_data_keys where aggregate_id=any($1::text[])`,
      [aggregateIds],
    );
    const keysByAggregate = new Map(keyRows.map((row) => [row.aggregate_id, row]));
    const plaintextKeys = new Map<string, Buffer>();
    try {
      const newKeyRows: AggregateKeyRow[] = [];
      for (const aggregateId of aggregateIds) {
        const existing = keysByAggregate.get(aggregateId);
        if (existing) {
          plaintextKeys.set(aggregateId, unwrapDataKey(
            aggregateId, wrappedFromAggregateRow(existing),
          ));
          continue;
        }
        const created = createAndWrapDataKey(aggregateId);
        const row: AggregateKeyRow = {
          id: nextUuidV7(), aggregate_id: aggregateId,
          root_key_version: created.wrapped.rootKeyVersion,
          wrapped_key: created.wrapped.wrappedKey, wrap_iv: created.wrapped.iv,
          wrap_auth_tag: created.wrapped.authTag,
        };
        keysByAggregate.set(aggregateId, row);
        plaintextKeys.set(aggregateId, created.dataKey);
        newKeyRows.push(row);
      }
      if (newKeyRows.length > 0) {
        await transaction.query(
          `insert into aggregate_data_keys
             (id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag)
           values ${batchValues(newKeyRows.length, 6)}`,
          newKeyRows.flatMap((row) => [row.id, row.aggregate_id, row.root_key_version,
            row.wrapped_key, row.wrap_iv, row.wrap_auth_tag]),
        );
      }

      const pendingRows = pending.map(({ input, accountId, requestHash }) => {
        const id = nextUuidV7();
        const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
        if (!Number.isFinite(occurredAt.getTime())) throw new Error("INVALID_EVENT_OCCURRED_AT");
        const correlationId = input.correlationId ?? id;
        const eventWithoutHash: Omit<StoredEvent, "integrityHash"> = {
          id, aggregateId: input.aggregateId, accountId, actor: input.actor,
          type: input.type, visibility: input.visibility, occurredAt,
          causationId: input.causationId ?? null, correlationId,
          promptVersion: input.promptVersion ?? null, modelVersion: input.modelVersion ?? null,
          policyVersion: input.policyVersion ?? null,
        };
        const integrityHash = canonicalContentDigest(integrityDocument(eventWithoutHash, input.body));
        const encrypted = encryptEventBody(
          id, integrityHash, Buffer.from(canonicalJson(input.body), "utf8"),
          plaintextKeys.get(input.aggregateId)!,
        );
        return { input, accountId, requestHash, eventWithoutHash, integrityHash, encrypted,
          keyRow: keysByAggregate.get(input.aggregateId)! };
      });
      await transaction.query(
        `insert into events (
           id,aggregate_id,account_id,actor_type,actor_id,type,visibility,occurred_at,
           causation_id,correlation_id,prompt_version,model_version,policy_version,
           idempotency_key,request_hash,integrity_hash
         ) values ${batchValues(pendingRows.length, 16)}`,
        pendingRows.flatMap((row) => [
          row.eventWithoutHash.id, row.input.aggregateId, row.accountId,
          row.input.actor.type, row.input.actor.id, row.input.type, row.input.visibility,
          row.eventWithoutHash.occurredAt, row.input.causationId ?? null,
          row.eventWithoutHash.correlationId, row.input.promptVersion ?? null,
          row.input.modelVersion ?? null, row.input.policyVersion ?? null,
          row.input.idempotencyKey, row.requestHash, row.integrityHash,
        ]),
      );
      await transaction.query(
        `insert into encrypted_event_bodies
           (event_id,aggregate_id,data_key_id,ciphertext,body_iv,body_auth_tag)
         values ${batchValues(pendingRows.length, 6)}`,
        pendingRows.flatMap((row) => [row.eventWithoutHash.id, row.input.aggregateId,
          row.keyRow.id, row.encrypted.ciphertext, row.encrypted.iv, row.encrypted.authTag]),
      );
      await transaction.query(
        `insert into transactional_outbox (id,event_id,topic,payload)
         values ${batchValues(pendingRows.length, 4)}`,
        pendingRows.flatMap((row) => [nextUuidV7(), row.eventWithoutHash.id,
          row.input.type, JSON.stringify({ eventId: row.eventWithoutHash.id })]),
      );
      for (const row of pendingRows) eventsByKey.set(row.input.idempotencyKey, {
        ...row.eventWithoutHash, integrityHash: row.integrityHash,
      });
      return Object.freeze(prepared.map(({ input }) => eventsByKey.get(input.idempotencyKey)!));
    } finally {
      for (const key of plaintextKeys.values()) key.fill(0);
    }
  });
}

export async function appendEvent(
  database: EventDatabase,
  input: AppendEventInput,
): Promise<StoredEvent> {
  return (await appendEvents(database, [input]))[0];
}

export async function readEventBody(
  database: EventDatabase,
  eventId: string,
  context: EventReadContext,
): Promise<JsonValue> {
  return (await readEventBodies(database, [eventId], context))[0].body;
}

function immutableJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableJson(item))) as JsonValue;
  }
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(value)) result[key] = immutableJson(item);
  return Object.freeze(result);
}

export async function readEventBodies(
  database: EventDatabase,
  eventIds: readonly string[],
  context: EventReadContext,
): Promise<readonly EventBodyResult[]> {
  if (!Array.isArray(eventIds) || eventIds.length === 0 || eventIds.length > 100) {
    throw new Error("EVENT_BODY_BATCH_LIMIT");
  }
  const uniqueIds = [...new Set(eventIds)];
  const eventRows = await database.query<EventRow>(
    `select ${EVENT_COLUMNS} from events where id=any($1::uuid[])`, [uniqueIds],
  );
  const events = new Map(eventRows.map((row) => [row.id, mapEvent(row)]));
  if (events.size !== uniqueIds.length) throw new Error("EVENT_NOT_FOUND");
  // Authorize the complete metadata set before reading any ciphertext or wrapped key.
  for (const id of uniqueIds) authorizeRead(events.get(id)!, context);

  const protectedRows = await database.query<EncryptedBodyRow & { event_id: string }>(
    `select event_id::text,aggregate_id,data_key_id,ciphertext,body_iv,body_auth_tag
     from encrypted_event_bodies where event_id=any($1::uuid[])`,
    [uniqueIds],
  );
  const protectedByEvent = new Map(protectedRows.map((row) => [row.event_id, row]));
  if (protectedByEvent.size !== uniqueIds.length) throw new Error("EVENT_BODY_NOT_FOUND");
  const keyIds = new Set<string>();
  for (const id of uniqueIds) {
    const keyId = protectedByEvent.get(id)!.data_key_id;
    if (!keyId) throw new Error("EVENT_KEY_UNAVAILABLE");
    keyIds.add(keyId);
  }
  const keyRows = await database.query<AggregateKeyRow>(
    `select id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
     from aggregate_data_keys where id=any($1::uuid[])`,
    [[...keyIds]],
  );
  const keysById = new Map(keyRows.map((row) => [row.id, row]));
  if (keysById.size !== keyIds.size) throw new Error("EVENT_KEY_UNAVAILABLE");
  const unwrapped = new Map<string, Buffer>();
  const bodies = new Map<string, JsonValue>();
  try {
    for (const keyRow of keyRows) {
      unwrapped.set(keyRow.id, unwrapDataKey(
        keyRow.aggregate_id, wrappedFromAggregateRow(keyRow),
      ));
    }
    for (const id of uniqueIds) {
      const event = events.get(id)!;
      const protectedRow = protectedByEvent.get(id)!;
      const keyRow = keysById.get(protectedRow.data_key_id!)!;
      if (keyRow.aggregate_id !== protectedRow.aggregate_id
          || keyRow.aggregate_id !== event.aggregateId) {
        throw new Error("EVENT_KEY_UNAVAILABLE");
      }
      const plaintext = decryptEventBody(
        event.id, event.integrityHash,
        { ciphertext: protectedRow.ciphertext, iv: protectedRow.body_iv,
          authTag: protectedRow.body_auth_tag },
        unwrapped.get(keyRow.id)!,
      );
      const body = immutableJson(JSON.parse(plaintext.toString("utf8")) as JsonValue);
      const calculatedHash = canonicalContentDigest(integrityDocument({
        id: event.id, aggregateId: event.aggregateId, accountId: event.accountId,
        actor: event.actor, type: event.type, visibility: event.visibility,
        occurredAt: event.occurredAt, causationId: event.causationId,
        correlationId: event.correlationId, promptVersion: event.promptVersion,
        modelVersion: event.modelVersion, policyVersion: event.policyVersion,
      }, body));
      if (!digestsEqual(event.integrityHash, calculatedHash)) {
        throw new Error("EVENT_INTEGRITY_FAILURE");
      }
      bodies.set(id, body);
    }
    return Object.freeze(eventIds.map((eventId) => Object.freeze({
      eventId, body: bodies.get(eventId)!,
    })));
  } finally {
    for (const key of unwrapped.values()) key.fill(0);
  }
}

export async function rewrapAggregateDataKey(
  database: EventDatabase,
  aggregateId: string,
  targetRootKeyVersion: number,
): Promise<void> {
  requireNonEmpty(aggregateId, "aggregate_id");
  if (!Number.isSafeInteger(targetRootKeyVersion) || targetRootKeyVersion < 1) {
    throw new Error("INVALID_EVENT_ROOT_KEY_VERSION");
  }
  await database.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `aggregate-key:${aggregateId}`,
    ]);
    const keyRows = await transaction.query<AggregateKeyRow>(
      `select id, aggregate_id, root_key_version, wrapped_key, wrap_iv, wrap_auth_tag
       from aggregate_data_keys where aggregate_id=$1 for update`,
      [aggregateId],
    );
    const keyRow = keyRows[0];
    if (!keyRow) {
      throw new Error("EVENT_KEY_UNAVAILABLE");
    }
    const dataKey = unwrapDataKey(aggregateId, wrappedFromAggregateRow(keyRow));
    try {
      const rewrapped = wrapDataKey(aggregateId, dataKey, targetRootKeyVersion);
      await transaction.query(
        `update aggregate_data_keys
         set root_key_version=$2, wrapped_key=$3, wrap_iv=$4, wrap_auth_tag=$5
         where id=$1`,
        [
          keyRow.id,
          rewrapped.rootKeyVersion,
          rewrapped.wrappedKey,
          rewrapped.iv,
          rewrapped.authTag,
        ],
      );
    } finally {
      dataKey.fill(0);
    }
  });
}
