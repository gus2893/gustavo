import type { EventDatabase, JsonValue } from "../events/types";
import { replayStoredLedgerEvents, type ChallengeProjection } from "./projection";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface ChallengeLedgerContext {
  readonly db: EventDatabase;
}

export type ChallengeLedgerActorType = "MAIN_BRAIN" | "SYSTEM";
export type ChallengeJsonInput =
  | boolean
  | number
  | string
  | null
  | readonly ChallengeJsonInput[]
  | { readonly [key: string]: ChallengeJsonInput };

export interface AppendChallengeLedgerEventInput {
  readonly id: string;
  readonly challengePortfolioId: string;
  readonly stageId: string;
  readonly profileVersionId: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, ChallengeJsonInput>>;
  readonly occurredAt: string;
  readonly actorType: ChallengeLedgerActorType;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly causationId?: string;
  readonly correlationId?: string;
}

export interface StoredChallengeLedgerEvent {
  readonly id: string;
  readonly stageId: string;
  readonly profileVersionId: string;
  readonly sequence: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly occurredAt: string;
  readonly actorType: ChallengeLedgerActorType;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly causationId: string | null;
  readonly correlationId: string | null;
}

export interface ReplaceProjectionCheckpointInput {
  readonly stageId: string;
  readonly profileVersionId: string;
  readonly highWaterEventId: string;
  readonly highWaterSequence: string;
  readonly projection: ChallengeProjection;
}

export interface StoredProjectionCheckpoint extends ReplaceProjectionCheckpointInput {}

interface StoredLedgerRow extends Record<string, unknown> {
  readonly id: string;
  readonly stage_id: string;
  readonly profile_version_id: string;
  readonly sequence: string;
  readonly type: string;
  readonly payload: Record<string, JsonValue>;
  readonly occurred_at: Date;
  readonly actor_type: ChallengeLedgerActorType;
  readonly actor_id: string;
  readonly idempotency_key: string;
  readonly challenge_portfolio_id?: string;
  readonly causation_id?: string | null;
  readonly correlation_id?: string | null;
}

interface StoredCheckpointRow extends Record<string, unknown> {
  readonly stage_id: string;
  readonly profile_version_id: string;
  readonly high_water_event_id: string;
  readonly high_water_sequence: string;
  readonly projection: ChallengeProjection;
}

function invalid(field: string): never {
  throw new Error(`CHALLENGE_LEDGER_${field}_INVALID`);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string") return invalid(field);
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) return invalid(field);
  return normalized;
}

function bounded(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim()) {
    return invalid(field);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return invalid("OCCURRED_AT");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return invalid("OCCURRED_AT");
  const canonical = parsed.toISOString();
  const canonicalWithoutMilliseconds = canonical.endsWith(".000Z")
    ? canonical.replace(/\.000Z$/u, "Z")
    : undefined;
  if (value !== canonical && value !== canonicalWithoutMilliseconds) {
    return invalid("OCCURRED_AT");
  }
  return canonical;
}

function actor(value: unknown): ChallengeLedgerActorType {
  if (value !== "MAIN_BRAIN" && value !== "SYSTEM") return invalid("ACTOR_TYPE");
  return value;
}

function actorIdentity(type: ChallengeLedgerActorType, value: unknown): string {
  const identity = bounded(value, "ACTOR_ID", 200);
  if (
    (type === "MAIN_BRAIN" && identity !== "gustavo-main")
    || (type === "SYSTEM" && !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(identity))
  ) {
    throw new Error("CHALLENGE_LEDGER_ACTOR_ID_INVALID");
  }
  return identity;
}

interface JsonSnapshotState {
  readonly seen: WeakSet<object>;
  nodes: number;
  keys: number;
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 8_192;
const MAX_JSON_KEYS = 4_096;
const MAX_JSON_BYTES = 262_144;

function snapshotJson(
  value: unknown,
  state: JsonSnapshotState,
  errorField: "PAYLOAD" | "CHECKPOINT",
  depth = 0,
): JsonValue {
  if (depth > MAX_JSON_DEPTH) return invalid(errorField);
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) return invalid(errorField);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid(errorField);
    return value;
  }
  if (typeof value !== "object") return invalid(errorField);
  if (state.seen.has(value)) return invalid(errorField);
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return invalid(errorField);
    const length = Reflect.get(value, "length");
    if (
      typeof length !== "number"
      || !Number.isSafeInteger(length)
      || length < 0
      || length > MAX_JSON_NODES - state.nodes
    ) {
      return invalid(errorField);
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1
      || keys.at(-1) !== "length"
      || keys.some((key, index) => index < length && key !== String(index))
    ) {
      return invalid(errorField);
    }
    state.keys += length;
    if (state.keys > MAX_JSON_KEYS) return invalid(errorField);
    const snapshot: JsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) return invalid(errorField);
      snapshot.push(snapshotJson(Reflect.get(value, key), state, errorField, depth + 1));
    }
    return snapshot;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid(errorField);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    return invalid(errorField);
  }
  state.keys += keys.length;
  if (state.keys > MAX_JSON_KEYS) return invalid(errorField);
  const snapshot: Record<string, JsonValue> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) return invalid(errorField);
    const child = Reflect.get(value, key);
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: snapshotJson(child, state, errorField, depth + 1),
      writable: true,
    });
  }
  return snapshot;
}

function snapshotObject(
  value: unknown,
  errorField: "PAYLOAD" | "CHECKPOINT",
): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(errorField);
  }
  let snapshot: Record<string, JsonValue>;
  try {
    snapshot = snapshotJson(value, {
      seen: new WeakSet<object>(),
      nodes: 0,
      keys: 0,
    }, errorField) as Record<string, JsonValue>;
  } catch (error) {
    if (
      error instanceof Error
      && error.message === `CHALLENGE_LEDGER_${errorField}_INVALID`
    ) {
      throw error;
    }
    return invalid(errorField);
  }
  if (new TextEncoder().encode(stableJson(snapshot)).byteLength > MAX_JSON_BYTES) {
    return invalid(errorField);
  }
  return deepFreeze(snapshot);
}

function payload(value: unknown): Readonly<Record<string, JsonValue>> {
  return snapshotObject(value, "PAYLOAD");
}

function sequence(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return invalid("HIGH_WATER_SEQUENCE");
  }
  return value;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stableJson(value: JsonValue | Readonly<Record<string, JsonValue>>): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function storedEvent(row: StoredLedgerRow): Readonly<StoredChallengeLedgerEvent> {
  return Object.freeze({
    id: row.id,
    stageId: row.stage_id,
    profileVersionId: row.profile_version_id,
    sequence: row.sequence,
    type: row.type,
    payload: payload(row.payload),
    occurredAt: row.occurred_at.toISOString(),
    actorType: row.actor_type,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    causationId: row.causation_id ?? null,
    correlationId: row.correlation_id ?? null,
  });
}

function captureAppendInput(input: AppendChallengeLedgerEventInput) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalid("INPUT");
  }
  const captured = {
    id: input.id,
    challengePortfolioId: input.challengePortfolioId,
    stageId: input.stageId,
    profileVersionId: input.profileVersionId,
    type: input.type,
    payload: input.payload,
    occurredAt: input.occurredAt,
    actorType: input.actorType,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    causationId: input.causationId,
    correlationId: input.correlationId,
  };
  const profileVersionId = uuid(captured.profileVersionId, "PROFILE_VERSION_ID");
  const actorType = actor(captured.actorType);
  return Object.freeze({
    id: uuid(captured.id, "EVENT_ID"),
    challengePortfolioId: uuid(captured.challengePortfolioId, "PORTFOLIO_ID"),
    stageId: uuid(captured.stageId, "STAGE_ID"),
    profileVersionId,
    type: bounded(captured.type, "TYPE", 128),
    payload: payload(captured.payload),
    occurredAt: timestamp(captured.occurredAt),
    actorType,
    actorId: actorIdentity(actorType, captured.actorId),
    idempotencyKey: bounded(captured.idempotencyKey, "IDEMPOTENCY_KEY", 200),
    causationId: captured.causationId === undefined
      ? null : uuid(captured.causationId, "CAUSATION_ID"),
    correlationId: captured.correlationId === undefined
      ? null : uuid(captured.correlationId, "CORRELATION_ID"),
  });
}

function assertIdempotentMatch(
  existing: StoredLedgerRow,
  input: ReturnType<typeof captureAppendInput>,
): void {
  if (
    existing.id !== input.id
    || existing.challenge_portfolio_id !== input.challengePortfolioId
    || existing.stage_id !== input.stageId
    || existing.profile_version_id !== input.profileVersionId
    || existing.type !== input.type
    || stableJson(existing.payload) !== stableJson(input.payload)
    || existing.occurred_at.toISOString() !== input.occurredAt
    || existing.actor_type !== input.actorType
    || existing.actor_id !== input.actorId
    || existing.causation_id !== input.causationId
    || existing.correlation_id !== input.correlationId
  ) {
    throw new Error("CHALLENGE_LEDGER_IDEMPOTENCY_CONFLICT");
  }
}

/**
 * Serializes appends by locking the immutable stage row. Sequence allocation,
 * idempotency resolution, and source-event insertion therefore share one
 * database transaction and one profile-bound stage snapshot.
 */
export async function appendChallengeLedgerEvent(
  context: ChallengeLedgerContext,
  rawInput: AppendChallengeLedgerEventInput,
): Promise<Readonly<StoredChallengeLedgerEvent>> {
  const input = captureAppendInput(rawInput);
  return context.db.transaction(async (transaction) => {
    await transaction.one(
      `select id from challenge_stages
        where id=$1 and challenge_portfolio_id=$2 and profile_version_id=$3
        for update`,
      [input.stageId, input.challengePortfolioId, input.profileVersionId],
    );
    const existing = await transaction.query<StoredLedgerRow>(
      `select id::text, challenge_portfolio_id::text, stage_id::text,
              profile_version_id::text, sequence::text, type, payload,
              occurred_at, actor_type, actor_id, idempotency_key,
              causation_id::text, correlation_id::text
         from challenge_ledger_events
        where challenge_portfolio_id=$1 and idempotency_key=$2`,
      [input.challengePortfolioId, input.idempotencyKey],
    );
    if (existing[0]) {
      assertIdempotentMatch(existing[0], input);
      return storedEvent(existing[0]);
    }
    const next = await transaction.one<{ sequence: string }>(
      `select (coalesce(max(sequence),0)+1)::text as sequence
         from challenge_ledger_events where stage_id=$1`,
      [input.stageId],
    );
    const inserted = await transaction.one<StoredLedgerRow>(
      `insert into challenge_ledger_events (
         id, challenge_portfolio_id, stage_id, profile_version_id, sequence,
         type, payload, occurred_at, actor_type, actor_id, causation_id,
         correlation_id, idempotency_key
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning id::text, stage_id::text, profile_version_id::text,
                 sequence::text, type, payload, occurred_at, actor_type,
                 actor_id, idempotency_key, causation_id::text,
                 correlation_id::text`,
      [input.id, input.challengePortfolioId, input.stageId, input.profileVersionId,
        next.sequence, input.type, input.payload, input.occurredAt, input.actorType,
        input.actorId, input.causationId, input.correlationId, input.idempotencyKey],
    );
    return storedEvent(inserted);
  });
}

/** Loads immutable source events in their authoritative per-stage sequence. */
export async function loadChallengeLedgerEvents(
  context: ChallengeLedgerContext,
  rawStageId: string,
): Promise<readonly Readonly<StoredChallengeLedgerEvent>[]> {
  const stageId = uuid(rawStageId, "STAGE_ID");
  const rows = await context.db.query<StoredLedgerRow>(
      `select id::text, stage_id::text, profile_version_id::text,
            sequence::text, type, payload, occurred_at, actor_type,
            actor_id, idempotency_key, causation_id::text, correlation_id::text
       from challenge_ledger_events
      where stage_id=$1
      order by challenge_ledger_events.sequence, challenge_ledger_events.id`,
    [stageId],
  );
  return Object.freeze(rows.map(storedEvent));
}

function captureCheckpoint(input: ReplaceProjectionCheckpointInput) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalid("CHECKPOINT");
  }
  const captured = {
    stageId: input.stageId,
    profileVersionId: input.profileVersionId,
    highWaterEventId: input.highWaterEventId,
    highWaterSequence: input.highWaterSequence,
    projection: input.projection,
  };
  const stageId = uuid(captured.stageId, "STAGE_ID");
  const profileVersionId = uuid(captured.profileVersionId, "PROFILE_VERSION_ID");
  const highWaterEventId = uuid(captured.highWaterEventId, "HIGH_WATER_EVENT_ID");
  const highWaterSequence = sequence(captured.highWaterSequence);
  const projection = snapshotObject(captured.projection, "CHECKPOINT") as unknown as ChallengeProjection;
  if (projection.profileVersionId !== profileVersionId) {
    throw new Error("CHALLENGE_LEDGER_PROFILE_VERSION_MISMATCH");
  }
  if (projection.highWaterId !== highWaterEventId) {
    throw new Error("CHALLENGE_LEDGER_CHECKPOINT_HIGH_WATER_MISMATCH");
  }
  return Object.freeze({
    stageId,
    profileVersionId,
    highWaterEventId,
    highWaterSequence,
    projection,
  });
}

export async function replaceProjectionCheckpoint(
  context: ChallengeLedgerContext,
  rawInput: ReplaceProjectionCheckpointInput,
): Promise<void> {
  const input = captureCheckpoint(rawInput);
  await context.db.transaction(async (transaction) => {
    await transaction.one(
      `select id from challenge_stages
        where id=$1 and profile_version_id=$2
        for update`,
      [input.stageId, input.profileVersionId],
    );
    const rows = await transaction.query<StoredLedgerRow>(
      `select id::text, stage_id::text, profile_version_id::text,
              sequence::text, type, payload, occurred_at, actor_type,
              actor_id, idempotency_key, causation_id::text, correlation_id::text
         from challenge_ledger_events
        where stage_id=$1 and sequence<=$2
        order by challenge_ledger_events.sequence, challenge_ledger_events.id`,
      [input.stageId, input.highWaterSequence],
    );
    const events = rows.map(storedEvent);
    const highWater = events.at(-1);
    if (
      !highWater
      || highWater.id !== input.highWaterEventId
      || highWater.sequence !== input.highWaterSequence
    ) {
      throw new Error("CHALLENGE_LEDGER_CHECKPOINT_HIGH_WATER_MISMATCH");
    }
    const rebuilt = replayStoredLedgerEvents(events);
    if (
      stableJson(rebuilt as unknown as Readonly<Record<string, JsonValue>>)
      !== stableJson(input.projection as unknown as Readonly<Record<string, JsonValue>>)
    ) {
      throw new Error("CHALLENGE_LEDGER_CHECKPOINT_PROJECTION_MISMATCH");
    }
    await transaction.query(
      `insert into challenge_projection_checkpoints (
         stage_id, profile_version_id, high_water_event_id,
         high_water_sequence, projection, rebuilt_at
       ) values ($1,$2,$3,$4,$5,clock_timestamp())
       on conflict (stage_id) do update set
         profile_version_id=excluded.profile_version_id,
         high_water_event_id=excluded.high_water_event_id,
         high_water_sequence=excluded.high_water_sequence,
         projection=excluded.projection,
         rebuilt_at=excluded.rebuilt_at
       where challenge_projection_checkpoints.high_water_sequence
             < excluded.high_water_sequence`,
      [input.stageId, input.profileVersionId, input.highWaterEventId,
        input.highWaterSequence, input.projection],
    );
  });
}

export async function loadProjectionCheckpoint(
  context: ChallengeLedgerContext,
  rawStageId: string,
): Promise<Readonly<StoredProjectionCheckpoint> | null> {
  const stageId = uuid(rawStageId, "STAGE_ID");
  const rows = await context.db.query<StoredCheckpointRow>(
    `select stage_id::text, profile_version_id::text,
            high_water_event_id::text, high_water_sequence::text, projection
       from challenge_projection_checkpoints where stage_id=$1`,
    [stageId],
  );
  const row = rows[0];
  if (!row) return null;
  return deepFreeze({
    stageId: row.stage_id,
    profileVersionId: row.profile_version_id,
    highWaterEventId: row.high_water_event_id,
    highWaterSequence: row.high_water_sequence,
    projection: snapshotObject(row.projection, "CHECKPOINT") as unknown as ChallengeProjection,
  });
}
