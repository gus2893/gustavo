import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("INVALID_JSON_NUMBER");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("INVALID_JSON_VALUE");
  }
  if (ancestors.has(value)) {
    throw new Error("CYCLIC_JSON_VALUE");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("INVALID_JSON_OBJECT");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

export async function appendEvent(
  database: EventDatabase,
  input: AppendEventInput,
): Promise<StoredEvent> {
  requireNonEmpty(input.aggregateId, "aggregate_id");
  requireNonEmpty(input.actor.id, "actor_id");
  requireNonEmpty(input.type, "type");
  requireNonEmpty(input.idempotencyKey, "idempotency_key");
  const accountId = eventOwner(input);
  const requestHash = sha256(canonicalJson(requestDocument(input, accountId)));

  return database.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `event-idempotency:${input.idempotencyKey}`,
    ]);
    const duplicateRows = await transaction.query<EventRow>(
      `select ${EVENT_COLUMNS} from events where idempotency_key=$1`,
      [input.idempotencyKey],
    );
    const duplicate = duplicateRows[0];
    if (duplicate) {
      if (duplicate.request_hash !== requestHash) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return mapEvent(duplicate);
    }

    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `aggregate-key:${input.aggregateId}`,
    ]);
    let keyRows = await transaction.query<AggregateKeyRow>(
      `select id, aggregate_id, root_key_version, wrapped_key, wrap_iv, wrap_auth_tag
       from aggregate_data_keys where aggregate_id=$1`,
      [input.aggregateId],
    );
    let dataKey: Buffer;
    if (keyRows.length === 0) {
      const created = createAndWrapDataKey(input.aggregateId);
      dataKey = created.dataKey;
      const dataKeyId = nextUuidV7();
      await transaction.query(
        `insert into aggregate_data_keys
          (id, aggregate_id, root_key_version, wrapped_key, wrap_iv, wrap_auth_tag)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          dataKeyId,
          input.aggregateId,
          created.wrapped.rootKeyVersion,
          created.wrapped.wrappedKey,
          created.wrapped.iv,
          created.wrapped.authTag,
        ],
      );
      keyRows = [
        {
          id: dataKeyId,
          aggregate_id: input.aggregateId,
          root_key_version: created.wrapped.rootKeyVersion,
          wrapped_key: created.wrapped.wrappedKey,
          wrap_iv: created.wrapped.iv,
          wrap_auth_tag: created.wrapped.authTag,
        },
      ];
    } else {
      dataKey = unwrapDataKey(input.aggregateId, wrappedFromAggregateRow(keyRows[0]));
    }
    const keyRow = keyRows[0];

    const id = nextUuidV7();
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (!Number.isFinite(occurredAt.getTime())) {
      throw new Error("INVALID_EVENT_OCCURRED_AT");
    }
    const correlationId = input.correlationId ?? id;
    const eventWithoutHash: Omit<StoredEvent, "integrityHash"> = {
      id,
      aggregateId: input.aggregateId,
      accountId,
      actor: input.actor,
      type: input.type,
      visibility: input.visibility,
      occurredAt,
      causationId: input.causationId ?? null,
      correlationId,
      promptVersion: input.promptVersion ?? null,
      modelVersion: input.modelVersion ?? null,
      policyVersion: input.policyVersion ?? null,
    };
    const canonicalBody = canonicalJson(input.body);
    const integrityHash = sha256(canonicalJson(integrityDocument(eventWithoutHash, input.body)));
    const encrypted = encryptEventBody(
      id,
      integrityHash,
      Buffer.from(canonicalBody, "utf8"),
      dataKey,
    );

    await transaction.query(
      `insert into events (
        id, aggregate_id, account_id, actor_type, actor_id, type, visibility,
        occurred_at, causation_id, correlation_id, prompt_version, model_version,
        policy_version, idempotency_key, request_hash, integrity_hash
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )`,
      [
        id,
        input.aggregateId,
        accountId,
        input.actor.type,
        input.actor.id,
        input.type,
        input.visibility,
        occurredAt,
        input.causationId ?? null,
        correlationId,
        input.promptVersion ?? null,
        input.modelVersion ?? null,
        input.policyVersion ?? null,
        input.idempotencyKey,
        requestHash,
        integrityHash,
      ],
    );
    await transaction.query(
      `insert into encrypted_event_bodies (
        event_id, aggregate_id, data_key_id, ciphertext, body_iv, body_auth_tag
      ) values ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.aggregateId,
        keyRow.id,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
      ],
    );
    await transaction.query(
      `insert into transactional_outbox (id, event_id, topic, payload)
       values ($1, $2, $3, $4::jsonb)`,
      [nextUuidV7(), id, input.type, JSON.stringify({ eventId: id })],
    );
    return { ...eventWithoutHash, integrityHash };
  });
}

export async function readEventBody(
  database: EventDatabase,
  eventId: string,
  context: EventReadContext,
): Promise<JsonValue> {
  const eventRow = await database.one<EventRow>(
    `select ${EVENT_COLUMNS} from events where id=$1`,
    [eventId],
  );
  const event = mapEvent(eventRow);

  // Authorization intentionally precedes every query for ciphertext or wrapped keys.
  authorizeRead(event, context);

  const protectedRow = await database.one<EncryptedBodyRow>(
    `select aggregate_id, data_key_id, ciphertext, body_iv, body_auth_tag
     from encrypted_event_bodies where event_id=$1`,
    [eventId],
  );
  if (!protectedRow.data_key_id) {
    throw new Error("EVENT_KEY_UNAVAILABLE");
  }
  const keyRows = await database.query<AggregateKeyRow>(
    `select id, aggregate_id, root_key_version, wrapped_key, wrap_iv, wrap_auth_tag
     from aggregate_data_keys where id=$1 and aggregate_id=$2`,
    [protectedRow.data_key_id, protectedRow.aggregate_id],
  );
  const keyRow = keyRows[0];
  if (!keyRow) {
    throw new Error("EVENT_KEY_UNAVAILABLE");
  }
  const dataKey = unwrapDataKey(protectedRow.aggregate_id, wrappedFromAggregateRow(keyRow));
  const plaintext = decryptEventBody(
    event.id,
    event.integrityHash,
    {
      ciphertext: protectedRow.ciphertext,
      iv: protectedRow.body_iv,
      authTag: protectedRow.body_auth_tag,
    },
    dataKey,
  );
  const body = JSON.parse(plaintext.toString("utf8")) as JsonValue;
  const calculatedHash = sha256(
    canonicalJson(
      integrityDocument(
        {
          id: event.id,
          aggregateId: event.aggregateId,
          accountId: event.accountId,
          actor: event.actor,
          type: event.type,
          visibility: event.visibility,
          occurredAt: event.occurredAt,
          causationId: event.causationId,
          correlationId: event.correlationId,
          promptVersion: event.promptVersion,
          modelVersion: event.modelVersion,
          policyVersion: event.policyVersion,
        },
        body,
      ),
    ),
  );
  const expected = Buffer.from(event.integrityHash, "hex");
  const actual = Buffer.from(calculatedHash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("EVENT_INTEGRITY_FAILURE");
  }
  return body;
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
