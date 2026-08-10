import { randomBytes, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { appendEvent, readEventBody } from "../events/store";
import { canonicalContentDigest } from "../events/integrity";
import type { EventActor, EventVisibility, JsonValue } from "../events/types";
import {
  THOUGHT_SCOPES,
  THOUGHT_STATE_KINDS,
  THOUGHT_TYPES,
  THOUGHT_UNCERTAINTIES,
  type RecordDecisionThoughtInput,
  type StoredThoughtRecord,
  type ThoughtClaimInput,
  type ThoughtReferenceInput,
  type ThoughtReferenceKind,
  type ThoughtScope,
  type ThoughtStateReference,
  type ThoughtType,
  type ThoughtUncertainty,
  type ThoughtWriterContext,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CONFIDENCE_PATTERN = /^(?:0(?:\.[0-9]{1,8})?|1(?:\.0{1,8})?)$/u;
const writerContexts = new WeakSet<object>();
const actorTypes = new Set(["USER", "NODE_BRAIN", "MAIN_BRAIN", "EVALUATOR", "SYSTEM", "OPERATOR"]);

interface ThoughtRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_id: string;
  readonly aggregate_id: string;
  readonly account_id: string | null;
  readonly type: ThoughtType;
  readonly actor_type: EventActor["type"];
  readonly actor_id: string;
  readonly scope: ThoughtScope;
  readonly uncertainty: ThoughtUncertainty;
  readonly state_kind: ThoughtStateReference["kind"];
  readonly state_id: string;
  readonly state_version: string;
  readonly valid_from: Date;
  readonly valid_until: Date | null;
  readonly supersedes_thought_id: string | null;
  readonly created_at: Date;
  readonly request_digest: string | null;
}

type CapturedInput = Readonly<{
  aggregateId: string;
  accountId: string | null;
  type: ThoughtType;
  scope: ThoughtScope;
  rationale: string;
  claims: readonly Readonly<{ text: string; confidence: string | null }>[];
  evidence: readonly Readonly<ThoughtReferenceInput>[];
  counterevidence: readonly Readonly<ThoughtReferenceInput>[];
  sourceEventIds: readonly string[];
  stateReference: Readonly<ThoughtStateReference>;
  uncertainty: ThoughtUncertainty;
  promptVersion: string;
  modelVersion: string;
  policyVersion: string;
  validFrom: string;
  validUntil: string | null;
  supersedesThoughtId: string | null;
  occurredAt: string;
  idempotencyKey: string;
}>;

function invalid(code: string): never {
  throw new Error(`THOUGHT_${code}`);
}

function plainRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return invalid("INPUT_INVALID");
    }
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (keys.length < required.length || keys.length > allowed.size
      || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
      return invalid("INPUT_INVALID");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of required) if (!keys.includes(key)) return invalid("INPUT_INVALID");
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalid("INPUT_INVALID");
      }
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch (error) {
    if (error instanceof Error && error.message === "THOUGHT_INPUT_INVALID") throw error;
    return invalid("INPUT_INVALID");
  }
}

function denseArray(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) return invalid("INPUT_INVALID");
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, "value")
      ? lengthDescriptor.value
      : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length)
      || length < 0 || length > maximum) return invalid("INPUT_INVALID");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return invalid("INPUT_INVALID");
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalid("INPUT_INVALID");
      }
      captured.push(descriptor.value);
    }
    if (keys.some((key) => typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)))) {
      return invalid("INPUT_INVALID");
    }
    return Object.freeze(captured);
  } catch (error) {
    if (error instanceof Error && error.message === "THOUGHT_INPUT_INVALID") throw error;
    return invalid("INPUT_INVALID");
  }
}

function boundedText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1
    || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    return invalid(`${code}_INVALID`);
  }
  return value;
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalid(`${code}_INVALID`);
  return value.toLowerCase();
}

function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    return invalid(`${code}_INVALID`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid(`${code}_INVALID`);
  }
  return value;
}

function version(value: unknown, code: string): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    return invalid(`${code}_INVALID`);
  }
  return value;
}

function actor(value: unknown): Readonly<EventActor> {
  const captured = plainRecord(value, ["id", "type"]);
  if (typeof captured.type !== "string" || !actorTypes.has(captured.type)) {
    return invalid("ACTOR_INVALID");
  }
  return Object.freeze({
    type: captured.type as EventActor["type"],
    id: boundedText(captured.id, 128, "ACTOR_ID"),
  });
}

function claim(value: unknown): Readonly<{ text: string; confidence: string | null }> {
  const captured = plainRecord(value, ["text"], ["confidence"]);
  const confidence = captured.confidence === undefined
    ? null
    : typeof captured.confidence === "string" && CONFIDENCE_PATTERN.test(captured.confidence)
      ? captured.confidence
      : invalid("CLAIM_CONFIDENCE_INVALID");
  return Object.freeze({ text: boundedText(captured.text, 1_000, "CLAIM"), confidence });
}

function reference(value: unknown): Readonly<ThoughtReferenceInput> {
  const captured = plainRecord(value, ["id", "kind"]);
  if (captured.kind !== "EVENT" && captured.kind !== "MARKET_OBSERVATION"
    && captured.kind !== "THOUGHT") return invalid("REFERENCE_KIND_INVALID");
  return Object.freeze({
    kind: captured.kind as ThoughtReferenceKind,
    id: uuid(captured.id, "REFERENCE_ID"),
  });
}

function stateReference(value: unknown): Readonly<ThoughtStateReference> {
  const captured = plainRecord(value, ["id", "kind", "version"]);
  if (typeof captured.kind !== "string"
    || !THOUGHT_STATE_KINDS.includes(captured.kind as ThoughtStateReference["kind"])) {
    return invalid("STATE_KIND_INVALID");
  }
  return Object.freeze({
    kind: captured.kind as ThoughtStateReference["kind"],
    id: boundedText(captured.id, 256, "STATE_ID"),
    version: version(captured.version, "STATE_VERSION"),
  });
}

function uniqueValues<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) return invalid("REFERENCE_DUPLICATE");
    seen.add(identity);
  }
  return Object.freeze([...values]);
}

function captureInput(rawInput: RecordDecisionThoughtInput): CapturedInput {
  const input = plainRecord(
    rawInput,
    [
      "aggregateId", "idempotencyKey", "modelVersion", "occurredAt", "policyVersion",
      "promptVersion", "rationale", "scope", "sourceEventIds", "stateReference",
      "type", "uncertainty",
    ],
    [
      "accountId", "claims", "counterevidence", "evidence", "supersedesThoughtId",
      "validFrom", "validUntil",
    ],
  );
  if (typeof input.type !== "string" || !THOUGHT_TYPES.includes(input.type as ThoughtType)) {
    return invalid("TYPE_INVALID");
  }
  if (typeof input.scope !== "string" || !THOUGHT_SCOPES.includes(input.scope as ThoughtScope)) {
    return invalid("SCOPE_INVALID");
  }
  if (typeof input.uncertainty !== "string"
    || !THOUGHT_UNCERTAINTIES.includes(input.uncertainty as ThoughtUncertainty)) {
    return invalid("UNCERTAINTY_INVALID");
  }
  const rationale = boundedText(input.rationale, 4_000, "RATIONALE");
  if (/(?:reveal|show|provide|print|expose).{0,32}(?:chain[ -]of[ -]thought|hidden reasoning|private reasoning|internal reasoning)|(?:chain[ -]of[ -]thought).{0,32}(?:step[ -]by[ -]step|verbatim)/iu.test(rationale)) {
    return invalid("REASONING_DISCLOSURE_FORBIDDEN");
  }
  const occurredAt = timestamp(input.occurredAt, "OCCURRED_AT");
  const validFrom = input.validFrom === undefined
    ? occurredAt
    : timestamp(input.validFrom, "VALID_FROM");
  const validUntil = input.validUntil === undefined
    ? null
    : timestamp(input.validUntil, "VALID_UNTIL");
  if (validUntil !== null && Date.parse(validUntil) <= Date.parse(validFrom)) {
    return invalid("VALIDITY_INVALID");
  }
  const claims = denseArray(input.claims ?? [], 32).map(claim);
  const evidence = uniqueValues(
    denseArray(input.evidence ?? [], 64).map(reference),
    (item) => `${item.kind}:${item.id}`,
  );
  const counterevidence = uniqueValues(
    denseArray(input.counterevidence ?? [], 64).map(reference),
    (item) => `${item.kind}:${item.id}`,
  );
  const sourceEventIds = uniqueValues(
    denseArray(input.sourceEventIds, 64).map((item) => uuid(item, "SOURCE_EVENT_ID")),
    (item) => item,
  );
  if (sourceEventIds.length === 0) return invalid("SOURCE_REQUIRED");
  const scope = input.scope as ThoughtScope;
  const accountId = input.accountId === undefined
    ? null
    : uuid(input.accountId, "ACCOUNT_ID");
  if ((scope === "PRIVATE_ACCOUNT") !== (accountId !== null)) {
    return invalid("SCOPE_ACCOUNT_INVALID");
  }
  const idempotencyKey = typeof input.idempotencyKey === "string"
    && KEY_PATTERN.test(input.idempotencyKey)
    ? input.idempotencyKey
    : invalid("IDEMPOTENCY_KEY_INVALID");
  return Object.freeze({
    aggregateId: boundedText(input.aggregateId, 256, "AGGREGATE_ID"),
    accountId,
    type: input.type as ThoughtType,
    scope,
    rationale,
    claims: Object.freeze(claims),
    evidence,
    counterevidence,
    sourceEventIds,
    stateReference: stateReference(input.stateReference),
    uncertainty: input.uncertainty as ThoughtUncertainty,
    promptVersion: version(input.promptVersion, "PROMPT_VERSION"),
    modelVersion: version(input.modelVersion, "MODEL_VERSION"),
    policyVersion: version(input.policyVersion, "POLICY_VERSION"),
    validFrom,
    validUntil,
    supersedesThoughtId: input.supersedesThoughtId === undefined
      ? null
      : uuid(input.supersedesThoughtId, "SUPERSEDES_ID"),
    occurredAt,
    idempotencyKey,
  });
}

function validateActorAuthority(actorValue: EventActor, input: CapturedInput): void {
  if (actorValue.type === "MAIN_BRAIN" && actorValue.id !== "gustavo-main") {
    invalid("ACTOR_ID_INVALID");
  }
  const allowed = actorValue.type === "SYSTEM"
    || (actorValue.type === "USER" && input.scope === "PRIVATE_ACCOUNT")
    || (actorValue.type === "NODE_BRAIN" && input.scope === "PRIVATE_ACCOUNT")
    || (actorValue.type === "MAIN_BRAIN"
      && ["PUBLIC", "MAIN_SHARED", "CHALLENGE_SHARED"].includes(input.scope))
    || (actorValue.type === "EVALUATOR"
      && ["MAIN_SHARED", "CHALLENGE_SHARED"].includes(input.scope))
    || (actorValue.type === "OPERATOR" && input.scope === "OPERATOR");
  if (!allowed) invalid("ACTOR_SCOPE_INVALID");
  if (["MAIN_POSITION", "MAIN_BROADCAST", "DECISION", "PAPER_INTENT_RATIONALE"].includes(input.type)
    && actorValue.type !== "MAIN_BRAIN") {
    invalid("ACTOR_TYPE_INVALID");
  }
  if (["NODE_REPLY_SUMMARY", "NODE_PROPOSAL"].includes(input.type)
    && actorValue.type !== "NODE_BRAIN") invalid("ACTOR_TYPE_INVALID");
  if (input.type === "EVALUATION"
    && actorValue.type !== "EVALUATOR" && actorValue.type !== "SYSTEM") {
    invalid("ACTOR_TYPE_INVALID");
  }
  if (["RISK_GATE_RESULT", "STAGE_REVIEW", "OUTCOME_REVIEW"].includes(input.type)
    && actorValue.type !== "MAIN_BRAIN" && actorValue.type !== "SYSTEM") {
    invalid("ACTOR_TYPE_INVALID");
  }
}

function visibility(scope: ThoughtScope): EventVisibility {
  if (scope === "PUBLIC") return "PUBLIC";
  if (scope === "PRIVATE_ACCOUNT") return "PRIVATE_ACCOUNT";
  if (scope === "OPERATOR") return "OPERATOR";
  return "SHARED";
}

async function validateDurableAuthority(
  database: ThoughtWriterContext["db"],
  actorValue: EventActor,
  input: CapturedInput,
): Promise<void> {
  if (input.scope === "PRIVATE_ACCOUNT") {
    await database.query(
      "select validate_private_thought_owner_values($1,$2,$3,$4)",
      [input.accountId, input.aggregateId, actorValue.type, actorValue.id],
    );
  }
  await database.query(
    "select validate_thought_state_reference_values($1,$2,$3,$4,$5,$6)",
    [
      input.stateReference.kind, input.stateReference.id, input.stateReference.version,
      input.scope, input.accountId, input.aggregateId,
    ],
  );
}

async function encryptedRequestDigest(
  database: ThoughtWriterContext["db"],
  eventId: string,
): Promise<string> {
  const body = await readEventBody(database, eventId, { actor: { role: "SYSTEM" } });
  if (body === null || Array.isArray(body) || typeof body !== "object"
    || typeof body.requestDigest !== "string") {
    throw new Error("THOUGHT_EVENT_BODY_INVALID");
  }
  return body.requestDigest;
}

function storedThought(row: ThoughtRow): Readonly<StoredThoughtRecord> {
  return Object.freeze({
    id: row.id,
    eventId: row.event_id,
    aggregateId: row.aggregate_id,
    accountId: row.account_id,
    type: row.type,
    actor: Object.freeze({ type: row.actor_type, id: row.actor_id }),
    scope: row.scope,
    uncertainty: row.uncertainty,
    stateReference: Object.freeze({
      kind: row.state_kind,
      id: row.state_id,
      version: row.state_version,
    }),
    createdAt: row.created_at.toISOString(),
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
    supersedesThoughtId: row.supersedes_thought_id,
  });
}

const THOUGHT_COLUMNS = `
  id::text,event_id::text,aggregate_id,account_id,type,actor_type,actor_id,scope,
  uncertainty,state_kind,state_id,state_version,valid_from,valid_until,
  supersedes_thought_id::text,created_at,request_digest
`;

export function createThoughtWriterContext(
  db: ThoughtWriterContext["db"],
  rawActor: EventActor,
): ThoughtWriterContext {
  if (!db || typeof db !== "object" || typeof db.transaction !== "function") {
    throw new Error("THOUGHT_CONTEXT_INVALID");
  }
  const context = Object.freeze({ db, actor: actor(rawActor) });
  writerContexts.add(context);
  return context;
}

export async function recordDecisionThought(
  context: ThoughtWriterContext,
  rawInput: RecordDecisionThoughtInput,
): Promise<Readonly<StoredThoughtRecord>> {
  if (!context || typeof context !== "object" || !writerContexts.has(context)) {
    throw new Error("THOUGHT_CONTEXT_INVALID");
  }
  const input = captureInput(rawInput);
  validateActorAuthority(context.actor, input);
  const requestDigest = canonicalContentDigest({ actor: context.actor, ...input });
  const idempotencyScope = canonicalContentDigest({
    accountId: input.accountId,
    actor: context.actor,
    aggregateId: input.aggregateId,
    idempotencyKey: input.idempotencyKey,
  });
  return context.db.transaction(async (transaction) => {
    await transaction.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [`thought-idempotency:${idempotencyScope}`],
    );
    await validateDurableAuthority(transaction, context.actor, input);
    const duplicates = await transaction.query<ThoughtRow>(
      `select ${THOUGHT_COLUMNS} from thought_records
        where aggregate_id=$1 and account_id is not distinct from $2
          and actor_type=$3 and actor_id=$4 and idempotency_key=$5`,
      [
        input.aggregateId, input.accountId, context.actor.type, context.actor.id,
        input.idempotencyKey,
      ],
    );
    if (duplicates[0]) {
      const storedRequestDigest = duplicates[0].request_digest
        ?? await encryptedRequestDigest(transaction, duplicates[0].event_id);
      if (storedRequestDigest !== requestDigest) {
        throw new Error("THOUGHT_IDEMPOTENCY_CONFLICT");
      }
      return storedThought(duplicates[0]);
    }
    if (input.supersedesThoughtId !== null) {
      await transaction.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`thought-supersession:${input.supersedesThoughtId}`],
      );
      const prior = await transaction.query<{ id: string } & Record<string, unknown>>(
        `select id::text from thought_records
          where id=$1 and aggregate_id=$2 and account_id is not distinct from $3 and scope=$4`,
        [input.supersedesThoughtId, input.aggregateId, input.accountId, input.scope],
      );
      if (!prior[0]) throw new Error("THOUGHT_SUPERSESSION_INVALID");
      const existing = await transaction.query<{ id: string } & Record<string, unknown>>(
        "select id::text from thought_records where supersedes_thought_id=$1",
        [input.supersedesThoughtId],
      );
      if (existing[0]) throw new Error("THOUGHT_ALREADY_SUPERSEDED");
    }
    const thoughtId = randomUUID();
    const protectedScope = input.scope === "PRIVATE_ACCOUNT";
    const rationaleDigest = protectedScope ? null : canonicalContentDigest(input.rationale);
    const body: JsonValue = {
      thoughtId,
      type: input.type,
      scope: input.scope,
      rationale: input.rationale,
      claims: input.claims.map((item) => ({ ...item })),
      evidence: input.evidence.map((item) => ({ ...item })),
      counterevidence: input.counterevidence.map((item) => ({ ...item })),
      sourceEventIds: [...input.sourceEventIds],
      stateReference: { ...input.stateReference },
      uncertainty: input.uncertainty,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      supersedesThoughtId: input.supersedesThoughtId,
      requestDigest,
      erasureNonce: protectedScope ? randomBytes(32).toString("hex") : null,
    };
    const event = await appendEvent(transaction, {
      aggregateId: input.aggregateId,
      ...(input.accountId === null ? {} : { accountId: input.accountId }),
      actor: context.actor,
      type: "thought.recorded",
      visibility: visibility(input.scope),
      body,
      occurredAt: new Date(input.occurredAt),
      promptVersion: input.promptVersion,
      modelVersion: input.modelVersion,
      policyVersion: input.policyVersion,
      idempotencyKey: `thought:${idempotencyScope}`,
    });
    await transaction.query(
      `insert into thought_records (
         id,event_id,aggregate_id,account_id,type,actor_type,actor_id,scope,
         rationale_digest,claim_count,source_count,evidence_count,counterevidence_count,
         uncertainty,state_kind,state_id,state_version,
         prompt_version,model_version,policy_version,valid_from,valid_until,
         supersedes_thought_id,idempotency_key,request_digest,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [
        thoughtId, event.id, input.aggregateId, input.accountId, input.type,
        context.actor.type, context.actor.id, input.scope, rationaleDigest,
        input.claims.length, input.sourceEventIds.length, input.evidence.length,
        input.counterevidence.length, input.uncertainty, input.stateReference.kind,
        input.stateReference.id, input.stateReference.version, input.promptVersion,
        input.modelVersion, input.policyVersion, input.validFrom, input.validUntil,
        input.supersedesThoughtId, input.idempotencyKey,
        protectedScope ? null : requestDigest, input.occurredAt,
      ],
    );
    for (const [ordinal, item] of input.claims.entries()) {
      await transaction.query(
        `insert into thought_claims (id,thought_id,ordinal,claim_digest,confidence)
         values ($1,$2,$3,$4,$5)`,
        [
          randomUUID(), thoughtId, ordinal,
          protectedScope ? null : canonicalContentDigest(item.text), item.confidence,
        ],
      );
    }
    const references = [
      ...input.sourceEventIds.map((id) => ({ role: "SOURCE", kind: "EVENT", id } as const)),
      ...input.evidence.map((item) => ({ role: "EVIDENCE", ...item } as const)),
      ...input.counterevidence.map((item) => ({ role: "COUNTEREVIDENCE", ...item } as const)),
    ];
    const roleOrdinals = new Map<string, number>();
    for (const item of references) {
      const ordinal = roleOrdinals.get(item.role) ?? 0;
      roleOrdinals.set(item.role, ordinal + 1);
      await transaction.query(
        `insert into thought_references (thought_id,role,kind,reference_id,ordinal)
         values ($1,$2,$3,$4,$5)`,
        [thoughtId, item.role, item.kind, item.id, ordinal],
      );
    }
    const stored = await transaction.one<ThoughtRow>(
      `select ${THOUGHT_COLUMNS} from thought_records where id=$1`,
      [thoughtId],
    );
    return storedThought(stored);
  });
}
