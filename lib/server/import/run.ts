import { createHash, randomUUID } from "node:crypto";
import {
  createAndWrapDataKey,
  encryptEventBody,
  unwrapDataKey,
  type WrappedDataKey,
} from "../crypto/envelope";
import {
  canonicalContentDigest,
  canonicalJson,
  sha256Digest,
} from "../events/integrity";
import { appendEvent, readEventBody } from "../events/store";
import type {
  EventDatabase,
  EventReadActor,
  JsonValue,
} from "../events/types";
import {
  CLASSIFICATION_RULESET_VERSION,
  IMPORTER_VERSION,
  IMPORT_LIMITS,
  classifyImportRecord,
  containsProhibitedImportedBehavior,
  matchingCanonicalCatalogEntry,
  validateCanonicalReview,
  type Classification,
  type ImportRecordKind,
  type LifecycleClass,
  type RetrievalMode,
} from "./classify";
import {
  createMemoryWorkerContext,
  processMemoryEvent,
} from "../../../worker/consolidation/process-event";
import {
  sealBootstrapArchiveTransportReceipt,
  type BootstrapArchiveReceipt,
} from "./verify";

export const GUSTAVO_POLICY_VERSION = "gustavo-policy-v1";
export const IMPORT_ITEM_SCHEMA_VERSION = "import-item-schema-v1";

export type ImportSourceType =
  | "CONVERSATION_EXPORT"
  | "PRESERVED_TRANSCRIPT"
  | "REPOSITORY_FILE"
  | "HISTORICAL_PAPER_EXPORT"
  | "OPERATOR_CORRECTION";

export type ImportVisibilityScope =
  | "PUBLIC"
  | "PRIVATE_ACCOUNT"
  | "MAIN_SHARED"
  | "CHALLENGE_SHARED"
  | "OPERATOR";

export interface HistoricalMetadata {
  readonly provider: string;
  readonly setupGeometry: {
    readonly symbol: string;
    readonly direction: "PAPER_LONG" | "PAPER_SHORT" | "NO_SIMULATED_POSITION" | "UNKNOWN";
    readonly entry: string;
    readonly stop: string;
    readonly target: string;
  };
  readonly result: {
    readonly status: "STOPPED" | "TARGET_HIT" | "CANCELLED" | "EXPIRED" | "NO_TRADE" | "UNKNOWN";
    readonly realizedPnl: string;
  };
  readonly lesson: string;
}

export interface BootstrapItem {
  readonly id: string;
  /** Optional assertion only. Imported text is always decoded from byteRange. */
  readonly text?: string;
  readonly byteRange: {
    readonly start: number;
    readonly end: number;
  };
  readonly kind: ImportRecordKind;
  readonly canonicalCatalogId?: string;
  readonly visibilityScope: ImportVisibilityScope;
  readonly observedAt?: string;
  readonly expiresAt?: string;
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string;
  readonly excerptRef: string;
  readonly reviewer?: string;
  readonly reviewReason?: string;
  readonly historicalMetadata?: HistoricalMetadata;
}

export interface BootstrapSource {
  readonly namespace: string;
  readonly sourceType: ImportSourceType;
  readonly locator: string;
  readonly sourceTimestamp?: string;
  readonly digest: string;
  readonly sourceBytes: Uint8Array;
  readonly parserVersion: string;
  readonly items: readonly BootstrapItem[];
}

export interface ImportContext {
  readonly db: EventDatabase;
}

export interface BootstrapResult {
  readonly manifestId: string;
  readonly priorManifestId: string | null;
  readonly inserted: number;
  readonly duplicates: number;
  readonly classifications: Readonly<Record<LifecycleClass, number>>;
  readonly manifestDigest: string;
  readonly eventHighWater: number;
}

export interface BootstrapVerification {
  readonly valid: boolean;
  readonly activeItems: number;
  readonly hashMismatches: number;
  readonly sourceHashMismatches: number;
  readonly manifestMismatches: number;
  readonly outboxMismatches: number;
  readonly provenanceMissing: number;
  readonly orphanAuthorityRows: number;
  readonly prohibitedInActiveRetrieval: number;
  readonly deprecatedInActiveRetrieval: number;
  readonly historicalInFreshDecisionGates: number;
  readonly candidateInAcceptedRules: number;
  readonly forbiddenBehaviorInActiveRetrieval: number;
  readonly deterministicReplay: boolean;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly archiveReceipt?: BootstrapArchiveReceipt;
}

export type ImportLifecycleActor =
  | { readonly role: "OPERATOR"; readonly id: string; readonly purpose: string }
  | { readonly role: "PUBLIC" }
  | { readonly role: "ACCOUNT"; readonly accountId: string };

export interface ImportLifecycleResult {
  readonly commandId: string;
  readonly lifecycleEventIds: readonly string[];
  readonly transitioned: number;
  readonly replayed: boolean;
}

export type ImportReviewDecision =
  | "RETAIN_AS_CLASSIFIED"
  | "REJECTED"
  | "ARCHIVE_AS_SUPERSEDED_RAW";

interface AggregateKeyRow extends Record<string, unknown> {
  readonly id: string;
  readonly aggregate_id: string;
  readonly root_key_version: number;
  readonly wrapped_key: Buffer;
  readonly wrap_iv: Buffer;
  readonly wrap_auth_tag: Buffer;
}

interface CommittedImportEvent {
  readonly id: string;
  readonly requestHash: string;
  readonly integrityHash: string;
  readonly bodyDigest: string;
  readonly sequence: number;
  readonly createdAt: Date;
}

interface PreparedItem {
  readonly id: string;
  readonly stableLocator: string;
  readonly text: string;
  readonly itemDigest: string;
  readonly sourceByteStart: number;
  readonly sourceByteEnd: number;
  readonly excerptDigest: string;
  readonly annotationDigest: string;
  readonly kind: ImportRecordKind;
  readonly visibilityScope: ImportVisibilityScope;
  readonly observedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
  readonly excerptRef: string;
  readonly reviewer: string;
  readonly reviewReason: string;
  readonly classification: Classification;
  readonly importKey: string;
  readonly priorItemId: string | null;
  readonly historicalMetadata: HistoricalMetadata | null;
  readonly historicalMetadataDigest: string | null;
  readonly canonicalCatalogAnnotationId: string | null;
  readonly canonicalCatalogId: string | null;
  readonly canonicalContentDigest: string | null;
  readonly currentReviewStatus: "REVIEWED" | "PENDING" | "CLASSIFIED";
  readonly currentReviewDecision: string;
}

interface ImportedMemoryProjection {
  readonly memoryId: string;
  readonly extractionRunId: string;
  readonly consolidationEventId: string;
  readonly sourceEventId: string;
  readonly retrievalProfile: "CURRENT_GENERAL" | "HISTORICAL_SIMILARITY";
}

interface ManifestRow extends Record<string, unknown> {
  readonly id: string;
  readonly prior_manifest_id: string | null;
  readonly classification_counts: Record<LifecycleClass, number>;
  readonly manifest_digest: string;
  readonly event_high_water: string | number;
}

interface ImportItemVerificationRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_id: string;
  readonly prior_item_id: string | null;
  readonly import_key: string;
  readonly stable_locator: string;
  readonly source_namespace: string;
  readonly source_locator: string;
  readonly source_digest: string;
  readonly item_digest: string;
  readonly importer_version: string;
  readonly parser_version: string;
  readonly record_type: string;
  readonly lifecycle_class: LifecycleClass;
  readonly retrieval_mode: RetrievalMode;
  readonly freshness: string;
  readonly visibility_scope: string;
  readonly source_type: ImportSourceType;
  readonly source_timestamp: Date | null;
  readonly observed_at: Date | null;
  readonly expires_at: Date | null;
  readonly effective_from: Date;
  readonly effective_until: Date | null;
  readonly classification_rule_id: string;
  readonly ruleset_version: string;
  readonly schema_version: string;
  readonly gustavo_policy_version: string;
  readonly canonical_catalog_id: string | null;
  readonly canonical_content_digest: string | null;
  readonly current_review_status: string;
  readonly current_review_decision: string;
  readonly authority_sequence: string | number;
  readonly created_at: Date;
  readonly historical_metadata_digest: string | null;
  readonly source_byte_start: string | number;
  readonly source_byte_end: string | number;
  readonly excerpt_digest: string;
  readonly annotation_digest: string;
  readonly accepted_decision_rule: boolean;
  readonly fresh_decision_eligible: boolean;
  readonly reviewer: string;
  readonly review_reason: string;
  readonly excerpt_ref: string;
  readonly result_ids: Readonly<Record<string, string>>;
  readonly body_digest: string;
  readonly encrypted_body_digest: string | null;
  readonly active: boolean;
  readonly memory_manifest_id: string | null;
  readonly memory_projection_class: string | null;
  readonly memory_retrieval_profile: string | null;
  readonly memory_id: string | null;
  readonly extraction_run_id: string | null;
  readonly consolidation_event_id: string | null;
  readonly memory_source_event_id: string | null;
  readonly memory_type: string | null;
  readonly memory_scope: string | null;
  readonly memory_valid_from: Date | null;
  readonly memory_valid_to: Date | null;
  readonly memory_conflict_state: string | null;
  readonly memory_source_count: number | null;
  readonly extraction_scope: string | null;
  readonly extraction_source_event_id: string | null;
  readonly extraction_consolidation_event_id: string | null;
  readonly extraction_prompt_version: string | null;
  readonly extraction_model_version: string | null;
  readonly extraction_extractor_version: string | null;
  readonly extraction_embedding_version: string | null;
  readonly extraction_memory_count: number | null;
  readonly extraction_status: string | null;
  readonly memory_source_event_type: string | null;
  readonly memory_source_event_visibility: string | null;
  readonly review_queue_id: string | null;
  readonly review_manifest_id: string | null;
  readonly review_status: string | null;
  readonly archive_decision_event_id: string | null;
  readonly archive_decision_sequence: string | number | null;
  readonly archive_decision_after_verification: boolean | null;
}

interface LifecycleCommandRow extends Record<string, unknown> {
  readonly id: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly result_event_ids: readonly string[];
}

interface LifecycleItemRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_id: string;
  readonly retrieval_mode: RetrievalMode;
  readonly lifecycle_class: LifecycleClass;
  readonly source_locator: string;
  readonly source_digest: string;
  readonly source_byte_start: string | number;
  readonly source_byte_end: string | number;
  readonly active: boolean;
}

const SOURCE_TYPES = new Set<ImportSourceType>([
  "CONVERSATION_EXPORT",
  "PRESERVED_TRANSCRIPT",
  "REPOSITORY_FILE",
  "HISTORICAL_PAPER_EXPORT",
  "OPERATOR_CORRECTION",
]);

const VISIBILITY_SCOPES = new Set<ImportVisibilityScope>([
  "PUBLIC",
  "PRIVATE_ACCOUNT",
  "MAIN_SHARED",
  "CHALLENGE_SHARED",
  "OPERATOR",
]);

const EMPTY_CLASSIFICATIONS: Readonly<Record<LifecycleClass, number>> = Object.freeze({
  CANONICAL: 0,
  CANDIDATE: 0,
  HISTORICAL: 0,
  DEPRECATED: 0,
  PROHIBITED: 0,
});

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function memoryKeywords(text: string): readonly string[] {
  return Object.freeze([...new Set(
    text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,39}/gu) ?? [],
  )].slice(0, 24));
}

async function projectImportedMemory(
  db: EventDatabase,
  manifestId: string,
  item: PreparedItem,
  createdAt: Date,
): Promise<ImportedMemoryProjection> {
  const lifecycleClass = item.classification.lifecycleClass;
  if (lifecycleClass !== "CANONICAL" && lifecycleClass !== "HISTORICAL") {
    throw new Error("IMPORT_MEMORY_CLASS_UNSUPPORTED");
  }
  if (item.visibilityScope !== "MAIN_SHARED") {
    throw new Error("IMPORT_PROJECTABLE_VISIBILITY_UNSUPPORTED");
  }
  const aggregateId = `import-memory:${manifestId}:${item.id}`;
  const sourceOccurredAt = lifecycleClass === "HISTORICAL"
    ? item.observedAt! : createdAt;
  const sourceEvent = await appendEvent(db, {
    aggregateId,
    actor: { type: "OPERATOR", id: "gustavo-importer" },
    type: "import.memory.source.captured",
    visibility: "SHARED",
    body: {
      itemDigest: item.itemDigest,
      manifestId,
      stableLocator: item.stableLocator,
      text: item.text,
    },
    occurredAt: sourceOccurredAt,
    promptVersion: IMPORTER_VERSION,
    policyVersion: GUSTAVO_POLICY_VERSION,
    idempotencyKey: `import:memory-source:${item.importKey}`,
  });
  const keywords = memoryKeywords(item.text);
  const validFrom = item.effectiveFrom.toISOString();
  const validTo = lifecycleClass === "HISTORICAL"
    ? (item.effectiveUntil?.toISOString() ?? createdAt.toISOString()) : undefined;
  const extracted = lifecycleClass === "CANONICAL"
    ? { facts: [{
      text: item.text,
      sourceIds: [sourceEvent.id],
      confidence: 1,
      importance: 1,
      keywords,
      validFrom,
    }] }
    : { episodes: [{
      text: item.text,
      sourceIds: [sourceEvent.id],
      confidence: 1,
      importance: 0.5,
      keywords,
      entities: item.historicalMetadata?.setupGeometry.symbol === "UNKNOWN"
        ? [] : [item.historicalMetadata!.setupGeometry.symbol],
      validFrom,
      validTo,
      conflictState: "SUPERSEDED" as const,
    }] };
  const projected = await processMemoryEvent(createMemoryWorkerContext(db), {
    scope: "MAIN_SHARED",
    sourceEventId: sourceEvent.id,
    events: [{
      id: sourceEvent.id,
      at: sourceEvent.occurredAt.toISOString(),
      text: item.text,
    }],
    extracted,
    versions: {
      promptVersion: "import-memory-prompt-v1",
      modelVersion: "deterministic-import-v1",
      extractorVersion: IMPORTER_VERSION,
      embeddingVersion: "import-no-embedding-v1",
    },
    observedAt: createdAt.toISOString(),
    idempotencyKey: `import:memory-projection:${item.importKey}`,
  });
  if (projected.memories.length !== 1) throw new Error("IMPORT_MEMORY_PROJECTION_INVALID");
  return Object.freeze({
    memoryId: projected.memories[0]!.id,
    extractionRunId: projected.extractionRunId,
    consolidationEventId: projected.consolidationEventId,
    sourceEventId: sourceEvent.id,
    retrievalProfile: lifecycleClass === "CANONICAL"
      ? "CURRENT_GENERAL" : "HISTORICAL_SIMILARITY",
  });
}

function requireBoundedText(value: string, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`IMPORT_${field}_REQUIRED`);
  }
  if (byteLength(value) > maximumBytes) throw new Error(`IMPORT_${field}_LIMIT`);
  return value;
}

function parseOptionalDate(value: string | undefined, field: string): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`IMPORT_${field}_INVALID`);
  }
  return parsed;
}

function historicalValue(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maximumBytes) {
    throw new Error(`HISTORICAL_${field}_INVALID`);
  }
  return value;
}

function historicalDecimal(value: unknown, field: string): string {
  const result = historicalValue(value, field, 64);
  if (result !== "UNKNOWN" && !/^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/.test(result)) {
    throw new Error(`HISTORICAL_${field}_INVALID`);
  }
  return result;
}

function validateHistoricalMetadata(
  value: HistoricalMetadata | undefined,
  lifecycleClass: LifecycleClass,
): HistoricalMetadata | null {
  if (lifecycleClass !== "HISTORICAL") {
    if (value !== undefined) throw new Error("HISTORICAL_METADATA_UNEXPECTED");
    return null;
  }
  if (!value || typeof value !== "object" || !value.setupGeometry || !value.result) {
    throw new Error("HISTORICAL_METADATA_REQUIRED");
  }
  const direction = value.setupGeometry.direction;
  if (!["PAPER_LONG", "PAPER_SHORT", "NO_SIMULATED_POSITION", "UNKNOWN"].includes(direction)) {
    throw new Error("HISTORICAL_DIRECTION_INVALID");
  }
  const status = value.result.status;
  if (!["STOPPED", "TARGET_HIT", "CANCELLED", "EXPIRED", "NO_TRADE", "UNKNOWN"]
    .includes(status)) {
    throw new Error("HISTORICAL_RESULT_STATUS_INVALID");
  }
  return Object.freeze({
    provider: historicalValue(value.provider, "PROVIDER", 128),
    setupGeometry: Object.freeze({
      symbol: historicalValue(value.setupGeometry.symbol, "SYMBOL", 32),
      direction,
      entry: historicalDecimal(value.setupGeometry.entry, "ENTRY"),
      stop: historicalDecimal(value.setupGeometry.stop, "STOP"),
      target: historicalDecimal(value.setupGeometry.target, "TARGET"),
    }),
    result: Object.freeze({
      status,
      realizedPnl: historicalDecimal(value.result.realizedPnl, "REALIZED_PNL"),
    }),
    lesson: historicalValue(value.lesson, "LESSON", 1_024),
  });
}

function historicalMetadataDocument(value: HistoricalMetadata | null): JsonValue {
  if (value === null) return null;
  return {
    lesson: value.lesson,
    provider: value.provider,
    result: {
      realizedPnl: value.result.realizedPnl,
      status: value.result.status,
    },
    setupGeometry: {
      direction: value.setupGeometry.direction,
      entry: value.setupGeometry.entry,
      stop: value.setupGeometry.stop,
      symbol: value.setupGeometry.symbol,
      target: value.setupGeometry.target,
    },
  };
}

function sourceDigest(value: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(value);
  if (!match) throw new Error("IMPORT_SOURCE_DIGEST_INVALID");
  return match[1];
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactExcerpt(
  sourceBytes: Buffer,
  range: BootstrapItem["byteRange"],
): { readonly text: string; readonly start: number; readonly end: number; readonly digest: string } {
  if (!range || typeof range !== "object"
    || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end <= range.start || range.end > sourceBytes.length) {
    throw new Error("IMPORT_ITEM_BYTE_RANGE_INVALID");
  }
  const bytes = sourceBytes.subarray(range.start, range.end);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("IMPORT_ITEM_BYTE_RANGE_UTF8_INVALID");
  }
  return Object.freeze({
    text,
    start: range.start,
    end: range.end,
    digest: digestBytes(bytes),
  });
}

function deterministicImportKey(input: {
  readonly namespace: string;
  readonly stableLocator: string;
  readonly digest: string;
  readonly importerVersion: string;
}): string {
  return canonicalContentDigest({
    contentDigest: input.digest,
    importerVersion: input.importerVersion,
    sourceNamespace: input.namespace,
    stableLocator: input.stableLocator,
  });
}

function normalizedClassifications(
  value: Partial<Record<LifecycleClass, number>>,
): Readonly<Record<LifecycleClass, number>> {
  return Object.freeze({
    CANONICAL: value.CANONICAL ?? 0,
    CANDIDATE: value.CANDIDATE ?? 0,
    HISTORICAL: value.HISTORICAL ?? 0,
    DEPRECATED: value.DEPRECATED ?? 0,
    PROHIBITED: value.PROHIBITED ?? 0,
  });
}

function wrappedFromRow(row: AggregateKeyRow): WrappedDataKey {
  return {
    rootKeyVersion: row.root_key_version,
    wrappedKey: row.wrapped_key,
    iv: row.wrap_iv,
    authTag: row.wrap_auth_tag,
  };
}

function eventRequestDocument(input: {
  readonly aggregateId: string;
  readonly type: string;
  readonly body: JsonValue;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly causationId: string | null;
  readonly createdAt: Date;
}): JsonValue {
  return {
    accountId: null,
    actor: { id: "gustavo-importer", type: "OPERATOR" },
    aggregateId: input.aggregateId,
    body: input.body,
    causationId: input.causationId,
    correlationId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    modelVersion: null,
    occurredAt: input.createdAt.toISOString(),
    policyVersion: GUSTAVO_POLICY_VERSION,
    promptVersion: IMPORTER_VERSION,
    type: input.type,
    visibility: "OPERATOR",
  };
}

function eventIntegrityDocument(input: {
  readonly aggregateId: string;
  readonly type: string;
  readonly body: JsonValue;
  readonly eventId: string;
  readonly causationId: string | null;
  readonly createdAt: Date;
}): JsonValue {
  return {
    accountId: null,
    actor: { id: "gustavo-importer", type: "OPERATOR" },
    aggregateId: input.aggregateId,
    body: input.body,
    causationId: input.causationId,
    correlationId: input.eventId,
    id: input.eventId,
    modelVersion: null,
    occurredAt: input.createdAt.toISOString(),
    policyVersion: GUSTAVO_POLICY_VERSION,
    promptVersion: IMPORTER_VERSION,
    type: input.type,
    visibility: "OPERATOR",
  };
}

async function loadAggregateKey(
  database: EventDatabase,
  aggregateId: string,
  missing: "CREATE" | "FAIL",
): Promise<{ readonly id: string; readonly plaintext: Buffer }> {
  await database.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `aggregate-key:${aggregateId}`,
  ]);
  const rows = await database.query<AggregateKeyRow>(
    `select id::text,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag
       from aggregate_data_keys where aggregate_id=$1`,
    [aggregateId],
  );
  const existing = rows[0];
  if (existing) {
    return { id: existing.id, plaintext: unwrapDataKey(aggregateId, wrappedFromRow(existing)) };
  }
  if (missing === "FAIL") throw new Error("EVENT_KEY_UNAVAILABLE");
  const created = createAndWrapDataKey(aggregateId);
  const id = randomUUID();
  await database.query(
    `insert into aggregate_data_keys
       (id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag)
     values ($1,$2,$3,$4,$5,$6)`,
    [id, aggregateId, created.wrapped.rootKeyVersion, created.wrapped.wrappedKey,
      created.wrapped.iv, created.wrapped.authTag],
  );
  return { id, plaintext: created.dataKey };
}

async function appendImportEvent(
  database: EventDatabase,
  key: { readonly id: string; readonly plaintext: Buffer },
  input: {
    readonly aggregateId: string;
    readonly eventId: string;
    readonly type: string;
    readonly body: JsonValue;
    readonly idempotencyPrefix: string;
    readonly causationId?: string;
    readonly createdAt: Date;
  },
): Promise<CommittedImportEvent> {
  const bodyDigest = canonicalContentDigest(input.body);
  const idempotencyKey = `${input.idempotencyPrefix}:${bodyDigest}`;
  const causationId = input.causationId ?? null;
  const requestHash = canonicalContentDigest(eventRequestDocument({
    ...input, idempotencyKey, causationId,
  }));
  const integrityHash = canonicalContentDigest(eventIntegrityDocument({
    ...input, causationId,
  }));
  const encrypted = encryptEventBody(
    input.eventId,
    integrityHash,
    Buffer.from(canonicalJson(input.body), "utf8"),
    key.plaintext,
  );
  const rows = await database.query<{ ingested_sequence: string | number }>(
    `insert into events (
       id,aggregate_id,account_id,actor_type,actor_id,type,visibility,occurred_at,
       causation_id,correlation_id,prompt_version,model_version,policy_version,
       idempotency_key,request_hash,integrity_hash
     ) values ($1,$2,null,'OPERATOR','gustavo-importer',$3,'OPERATOR',$4,
               $5,$1,$6,null,$7,$8,$9,$10)
     returning ingested_sequence`,
    [input.eventId, input.aggregateId, input.type, input.createdAt, causationId,
      IMPORTER_VERSION, GUSTAVO_POLICY_VERSION, idempotencyKey,
      requestHash, integrityHash],
  );
  const sequence = Number(rows[0]?.ingested_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("IMPORT_EVENT_SEQUENCE_INVALID");
  }
  await database.query(
    `insert into encrypted_event_bodies
       (event_id,aggregate_id,data_key_id,ciphertext,body_iv,body_auth_tag,body_digest)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [input.eventId, input.aggregateId, key.id, encrypted.ciphertext,
      encrypted.iv, encrypted.authTag, bodyDigest],
  );
  await database.query(
    `insert into transactional_outbox (id,event_id,topic,payload,created_at)
     values ($1,$2,$3,$4,$5)`,
    [randomUUID(), input.eventId, input.type,
      JSON.stringify({ eventId: input.eventId }), input.createdAt],
  );
  return Object.freeze({
    id: input.eventId,
    requestHash,
    integrityHash,
    bodyDigest,
    sequence,
    createdAt: input.createdAt,
  });
}

function prepareSource(source: BootstrapSource): {
  readonly sourceDigest: string;
  readonly sourceContent: Buffer;
  readonly sourceTimestamp: Date | null;
  readonly sourceByteCount: number;
  readonly sourceIdentityKey: string;
  readonly importKey: string;
  readonly items: readonly Omit<PreparedItem, "priorItemId">[];
  readonly classifications: Readonly<Record<LifecycleClass, number>>;
} {
  const namespace = requireBoundedText(
    source.namespace,
    "NAMESPACE",
    IMPORT_LIMITS.namespaceBytes,
  );
  const locator = requireBoundedText(source.locator, "LOCATOR", IMPORT_LIMITS.locatorBytes);
  requireBoundedText(source.parserVersion, "PARSER_VERSION", 128);
  if (!SOURCE_TYPES.has(source.sourceType)) throw new Error("IMPORT_SOURCE_TYPE_UNSUPPORTED");
  if (!Array.isArray(source.items) || source.items.length < 1
    || source.items.length > IMPORT_LIMITS.items) {
    throw new Error("IMPORT_ITEM_LIMIT");
  }
  if (!(source.sourceBytes instanceof Uint8Array)) throw new Error("IMPORT_SOURCE_BYTES_REQUIRED");
  if (source.sourceBytes.byteLength > IMPORT_LIMITS.sourceBytes) {
    throw new Error("IMPORT_SOURCE_BYTES_LIMIT");
  }
  const exactSourceBytes = Buffer.from(source.sourceBytes);
  const normalizedDigest = digestBytes(exactSourceBytes);
  if (sourceDigest(source.digest) !== normalizedDigest) {
    exactSourceBytes.fill(0);
    throw new Error("IMPORT_SOURCE_DIGEST_MISMATCH");
  }
  try {
    const sourceTimestamp = parseOptionalDate(source.sourceTimestamp, "SOURCE_TIMESTAMP");
    const seen = new Set<string>();
    const classifications: Record<LifecycleClass, number> = { ...EMPTY_CLASSIFICATIONS };
    const items = source.items.map((item) => {
    if (Object.prototype.hasOwnProperty.call(item, "supersededRawPaperLab")) {
      throw new Error("IMPORT_CALLER_ARCHIVE_ELIGIBILITY_FORBIDDEN");
    }
    const id = requireBoundedText(item.id, "ITEM_ID", 256);
    if (seen.has(id)) throw new Error("IMPORT_ITEM_LOCATOR_DUPLICATE");
    seen.add(id);
    const stableLocator = `${locator}#${id}`;
    requireBoundedText(stableLocator, "ITEM_LOCATOR", IMPORT_LIMITS.locatorBytes);
    const excerpt = exactExcerpt(exactSourceBytes, item.byteRange);
    const text = requireBoundedText(excerpt.text, "ITEM_TEXT", IMPORT_LIMITS.itemTextBytes);
    if (item.text !== undefined && item.text !== text) {
      throw new Error("IMPORT_ITEM_TEXT_SOURCE_MISMATCH");
    }
    const excerptRef = requireBoundedText(
      item.excerptRef,
      "EXCERPT_REF",
      IMPORT_LIMITS.locatorBytes,
    );
    if (!VISIBILITY_SCOPES.has(item.visibilityScope)) {
      throw new Error("IMPORT_VISIBILITY_SCOPE_UNSUPPORTED");
    }
    if (item.visibilityScope === "PRIVATE_ACCOUNT") {
      throw new Error("IMPORT_PRIVATE_TOPOLOGY_UNSUPPORTED");
    }
    if (item.canonicalCatalogId !== undefined) {
      requireBoundedText(item.canonicalCatalogId, "CANONICAL_CATALOG_ID", 128);
    }
    const classification = classifyImportRecord(item.kind, text, item.canonicalCatalogId);
    if ((classification.lifecycleClass === "CANONICAL"
      || classification.lifecycleClass === "HISTORICAL")
      && item.visibilityScope !== "MAIN_SHARED") {
      throw new Error("IMPORT_PROJECTABLE_VISIBILITY_UNSUPPORTED");
    }
    validateCanonicalReview({
      classification,
      reviewer: item.reviewer,
      reviewReason: item.reviewReason,
    });
    const observedAt = parseOptionalDate(item.observedAt, "OBSERVED_AT");
    const expiresAt = parseOptionalDate(item.expiresAt, "EXPIRES_AT");
    const effectiveFrom = parseOptionalDate(item.effectiveFrom, "EFFECTIVE_FROM")
      ?? observedAt ?? sourceTimestamp;
    const effectiveUntil = parseOptionalDate(item.effectiveUntil, "EFFECTIVE_UNTIL")
      ?? expiresAt;
    if (!effectiveFrom) throw new Error("IMPORT_EFFECTIVE_FROM_REQUIRED");
    if (effectiveUntil && effectiveUntil.getTime() <= effectiveFrom.getTime()) {
      throw new Error("IMPORT_EFFECTIVE_INTERVAL_INVALID");
    }
    if (classification.lifecycleClass === "HISTORICAL" && !observedAt) {
      throw new Error("HISTORICAL_OBSERVATION_TIME_REQUIRED");
    }
    const historicalMetadata = validateHistoricalMetadata(
      item.historicalMetadata,
      classification.lifecycleClass,
    );
    const historicalMetadataDigest = historicalMetadata === null
      ? null : canonicalContentDigest(historicalMetadata);
    if (expiresAt && (!observedAt || expiresAt.getTime() < observedAt.getTime())) {
      throw new Error("IMPORT_EXPIRY_INVALID");
    }
    const itemDigest = sha256Digest(text);
    const canonicalCatalog = classification.lifecycleClass === "CANONICAL"
      ? matchingCanonicalCatalogEntry(item.canonicalCatalogId, text) : null;
    if (classification.lifecycleClass === "CANONICAL" && canonicalCatalog === null) {
      throw new Error("CANONICAL_CATALOG_MISMATCH");
    }
    const currentReviewStatus = classification.lifecycleClass === "CANONICAL"
      ? "REVIEWED" as const
      : classification.lifecycleClass === "CANDIDATE" ? "PENDING" as const : "CLASSIFIED" as const;
    const currentReviewDecision = classification.lifecycleClass === "CANONICAL"
      ? "ACCEPTED_AS_CANONICAL"
      : classification.lifecycleClass === "CANDIDATE" ? "PENDING"
        : classification.lifecycleClass === "HISTORICAL" ? "RETAIN_AS_HISTORICAL"
          : classification.lifecycleClass === "DEPRECATED" ? "RETAIN_AS_AUDIT"
            : "EXCLUDED_PROHIBITED";
    const reviewer = item.reviewer?.trim() || "system:bootstrap-classifier";
    const reviewReason = item.reviewReason?.trim()
      || `Classified by fixed rule ${classification.ruleId}.`;
    const annotationDigest = canonicalContentDigest({
      canonicalCatalogId: item.canonicalCatalogId ?? null,
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveUntil: effectiveUntil?.toISOString() ?? null,
      excerptRef,
      expiresAt: expiresAt?.toISOString() ?? null,
      historicalMetadata: historicalMetadataDocument(historicalMetadata),
      kind: item.kind,
      observedAt: observedAt?.toISOString() ?? null,
      reviewReason,
      reviewer,
      visibilityScope: item.visibilityScope,
    });
    classifications[classification.lifecycleClass] += 1;
    return Object.freeze({
      id,
      stableLocator,
      text,
      itemDigest,
      sourceByteStart: excerpt.start,
      sourceByteEnd: excerpt.end,
      excerptDigest: excerpt.digest,
      annotationDigest,
      kind: item.kind,
      visibilityScope: item.visibilityScope,
      observedAt,
      expiresAt,
      effectiveFrom,
      effectiveUntil,
      excerptRef,
      reviewer,
      reviewReason,
      historicalMetadata,
      historicalMetadataDigest,
      canonicalCatalogAnnotationId: item.canonicalCatalogId ?? null,
      canonicalCatalogId: canonicalCatalog?.id ?? null,
      canonicalContentDigest: canonicalCatalog?.contentDigest ?? null,
      currentReviewStatus,
      currentReviewDecision,
      classification,
      importKey: deterministicImportKey({
        namespace,
        stableLocator,
        digest: normalizedDigest,
        importerVersion: IMPORTER_VERSION,
      }),
    });
    });
    const byRange = [...items].sort((left, right) => left.sourceByteStart - right.sourceByteStart
      || left.sourceByteEnd - right.sourceByteEnd
      || left.stableLocator.localeCompare(right.stableLocator));
    for (let index = 1; index < byRange.length; index += 1) {
      if (byRange[index]!.sourceByteStart < byRange[index - 1]!.sourceByteEnd) {
        throw new Error("IMPORT_ITEM_BYTE_RANGE_OVERLAP");
      }
    }
    items.sort((left, right) => left.stableLocator.localeCompare(right.stableLocator, "en"));
    return Object.freeze({
      sourceDigest: normalizedDigest,
      sourceContent: exactSourceBytes,
      sourceTimestamp,
      sourceByteCount: exactSourceBytes.length,
      sourceIdentityKey: canonicalContentDigest({
        sourceNamespace: namespace,
        stableLocator: locator,
      }),
      importKey: deterministicImportKey({
        namespace,
        stableLocator: locator,
        digest: normalizedDigest,
        importerVersion: IMPORTER_VERSION,
      }),
      items: Object.freeze(items),
      classifications: normalizedClassifications(classifications),
    });
  } catch (error) {
    exactSourceBytes.fill(0);
    throw error;
  }
}

function authorityManifest(
  source: BootstrapSource,
  prepared: ReturnType<typeof prepareSource>,
): JsonValue {
  return {
    classifications: prepared.classifications,
    counts: {
      bytes: prepared.sourceByteCount,
      duplicates: 0,
      parsed: prepared.items.length,
      rejected: 0,
      sources: 1,
    },
    importerVersion: IMPORTER_VERSION,
    gustavoPolicyVersion: GUSTAVO_POLICY_VERSION,
    items: prepared.items.map((item) => ({
      annotationDigest: item.annotationDigest,
      byteRange: { end: item.sourceByteEnd, start: item.sourceByteStart },
      digest: item.itemDigest,
      excerptDigest: item.excerptDigest,
      freshness: item.classification.freshness,
      historicalMetadataDigest: item.historicalMetadataDigest,
      lifecycleClass: item.classification.lifecycleClass,
      locator: item.stableLocator,
      recordType: item.kind,
      retrievalMode: item.classification.retrievalMode,
    })),
    parserVersion: source.parserVersion,
    projectionStatus: "VERIFIED",
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
    schemaVersion: IMPORT_ITEM_SCHEMA_VERSION,
    source: {
      digest: prepared.sourceDigest,
      locator: source.locator,
      namespace: source.namespace,
      sourceTimestamp: prepared.sourceTimestamp?.toISOString() ?? null,
      type: source.sourceType,
    },
  };
}

async function insertEventAuthority(
  database: EventDatabase,
  authorityKind: "MANIFEST" | "ITEM" | "LIFECYCLE" | "VERIFICATION",
  authorityId: string,
  event: CommittedImportEvent,
): Promise<void> {
  await database.query(
    `insert into import_event_authorities (
       event_id,authority_kind,authority_id,body_digest,event_request_hash,
       event_integrity_hash,outbox_payload_digest,authority_sequence,created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [event.id, authorityKind, authorityId, event.bodyDigest, event.requestHash,
      event.integrityHash, canonicalContentDigest({ eventId: event.id }),
      event.sequence, event.createdAt],
  );
}

async function persistVerificationReceipt(
  context: ImportContext,
  input: {
    readonly manifestId: string;
    readonly manifestEventId: string;
    readonly manifestDigest: string;
    readonly manifestEventHighWater: number;
    readonly sourceCount: number;
    readonly sourceBytes: number;
    readonly parsedCount: number;
    readonly rejectedCount: number;
    readonly duplicateCount: number;
    readonly classificationCounts: Readonly<Record<LifecycleClass, number>>;
    readonly projectionStatus: string;
    readonly provenanceCount: number;
    readonly bodyCount: number;
    readonly outboxCount: number;
    readonly safety: JsonValue;
    readonly deterministicReplay: boolean;
    readonly valid: boolean;
  },
): Promise<{ readonly receiptId: string; readonly receiptDigest: string }> {
  const authorityManifest: JsonValue = {
    classificationCounts: input.classificationCounts,
    counts: {
      body: input.bodyCount,
      bytes: input.sourceBytes,
      duplicates: input.duplicateCount,
      outbox: input.outboxCount,
      parsed: input.parsedCount,
      provenance: input.provenanceCount,
      rejected: input.rejectedCount,
      sources: input.sourceCount,
    },
    deterministicReplay: input.deterministicReplay,
    importerVersion: IMPORTER_VERSION,
    manifestDigest: input.manifestDigest,
    manifestEventHighWater: input.manifestEventHighWater,
    manifestId: input.manifestId,
    projectionStatus: input.projectionStatus,
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
    safety: input.safety,
    schemaVersion: IMPORT_ITEM_SCHEMA_VERSION,
    gustavoPolicyVersion: GUSTAVO_POLICY_VERSION,
    valid: input.valid,
  };
  const receiptDigest = canonicalContentDigest(authorityManifest);
  const eventBody: JsonValue = {
    authorityManifest,
    manifestId: input.manifestId,
    reconstructed: {
      sourceCount: input.sourceCount,
      sourceBytes: input.sourceBytes,
      parsedCount: input.parsedCount,
      rejectedCount: input.rejectedCount,
      duplicateCount: input.duplicateCount,
      classificationCounts: input.classificationCounts,
      projectionStatus: input.projectionStatus,
    },
    valid: input.valid,
    verificationDigest: receiptDigest,
  };
  return context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `bootstrap-verification:${input.manifestId}`,
    ]);
    const existing = await transaction.query<{
      id: string;
      event_id: string;
      authority_manifest: JsonValue;
      body_digest: string;
    }>(
      `select id::text,event_id::text,authority_manifest,body_digest
         from import_verification_receipts
        where manifest_id=$1 and verification_digest=$2`,
      [input.manifestId, receiptDigest],
    );
    if (existing[0]) {
      const persistedBody = await readEventBody(transaction, existing[0].event_id, {
        actor: { role: "OPERATOR", purpose: "verify replayed bootstrap receipt" },
      });
      if (canonicalJson(existing[0].authority_manifest) !== canonicalJson(authorityManifest)
        || canonicalJson(persistedBody) !== canonicalJson(eventBody)
        || canonicalContentDigest(persistedBody) !== existing[0].body_digest) {
        throw new Error("IMPORT_VERIFICATION_RECEIPT_INVALID");
      }
      return Object.freeze({ receiptId: existing[0].id, receiptDigest });
    }
    const aggregateId = `import:${input.manifestId}`;
    const key = await loadAggregateKey(transaction, aggregateId, "FAIL");
    try {
      const receiptId = randomUUID();
      const createdAt = new Date();
      const event = await appendImportEvent(transaction, key, {
        aggregateId,
        eventId: randomUUID(),
        type: "import.verification.completed",
        body: eventBody,
        idempotencyPrefix: `import:verification:${input.manifestId}:${receiptDigest}`,
        causationId: input.manifestEventId,
        createdAt,
      });
      await transaction.query(
        `insert into import_verification_receipts (
           id,event_id,manifest_id,verification_digest,authority_manifest,source_count,
           source_bytes,parsed_count,rejected_count,duplicate_count,classification_counts,
           projection_status,manifest_event_high_water,verified_event_high_water,
           provenance_count,body_count,outbox_count,valid,importer_version,ruleset_version,
           body_digest,created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                   $19,$20,$21,$22)`,
        [receiptId, event.id, input.manifestId, receiptDigest,
          JSON.stringify(authorityManifest), input.sourceCount, input.sourceBytes,
          input.parsedCount, input.rejectedCount, input.duplicateCount,
          JSON.stringify(input.classificationCounts), input.projectionStatus,
          input.manifestEventHighWater, event.sequence, input.provenanceCount,
          input.bodyCount, input.outboxCount, input.valid, IMPORTER_VERSION,
          CLASSIFICATION_RULESET_VERSION, event.bodyDigest, createdAt],
      );
      await insertEventAuthority(transaction, "VERIFICATION", receiptId, event);
      return Object.freeze({ receiptId, receiptDigest });
    } finally {
      key.plaintext.fill(0);
    }
  });
}

function resultFromManifest(row: ManifestRow, duplicateCount: number): BootstrapResult {
  return Object.freeze({
    manifestId: row.id,
    priorManifestId: row.prior_manifest_id,
    inserted: duplicateCount === 0 ? Object.values(row.classification_counts)
      .reduce((sum, count) => sum + Number(count), 0) : 0,
    duplicates: duplicateCount,
    classifications: normalizedClassifications(row.classification_counts),
    manifestDigest: row.manifest_digest,
    eventHighWater: Number(row.event_high_water),
  });
}

export async function runBootstrapImport(
  context: ImportContext,
  source: BootstrapSource,
): Promise<BootstrapResult> {
  const prepared = prepareSource(source);
  try {
    return await context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `bootstrap-source:${prepared.sourceIdentityKey}`,
    ]);
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `bootstrap-import:${prepared.importKey}`,
    ]);
    const existing = await transaction.query<ManifestRow>(
      `select id::text,prior_manifest_id::text,classification_counts,manifest_digest,
              event_high_water::text
         from import_manifests where import_key=$1`,
      [prepared.importKey],
    );
    if (existing[0]) return resultFromManifest(existing[0], prepared.items.length);

    const priorRows = await transaction.query<{ id: string }>(
      `select id::text from import_manifests
        where source_namespace=$1 and stable_locator=$2
        order by event_high_water desc,id desc limit 1`,
      [source.namespace, source.locator],
    );
    const priorManifestId = priorRows[0]?.id ?? null;
    const priorItems = priorManifestId ? await transaction.query<{
      id: string;
      stable_locator: string;
    }>(
      `select id::text,stable_locator from import_source_items where manifest_id=$1`,
      [priorManifestId],
    ) : [];
    const priorByLocator = new Map(priorItems.map((item) => [item.stable_locator, item.id]));
    const items: readonly PreparedItem[] = prepared.items.map((item) => Object.freeze({
      ...item,
      priorItemId: priorByLocator.get(item.stableLocator) ?? null,
    }));
    const manifestId = randomUUID();
    const aggregateId = `import:${manifestId}`;
    const createdAt = new Date();
    const key = await loadAggregateKey(transaction, aggregateId, "CREATE");
    try {
      const itemCommits: Array<{
        readonly item: PreparedItem;
        readonly itemId: string;
        readonly itemEvent: CommittedImportEvent;
        readonly lifecycleId: string;
        readonly lifecycleEvent: CommittedImportEvent;
        readonly memoryProjection: ImportedMemoryProjection | null;
        readonly reviewQueueId: string | null;
        readonly resultIds: JsonValue;
      }> = [];
      for (const item of items) {
        const itemId = randomUUID();
        const itemEventId = randomUUID();
        const memoryProjection = item.classification.lifecycleClass === "CANONICAL"
          || item.classification.lifecycleClass === "HISTORICAL"
          ? await projectImportedMemory(transaction, manifestId, item, createdAt)
          : null;
        const reviewQueueId = item.classification.lifecycleClass === "CANDIDATE"
          ? randomUUID() : null;
        const resultIds: JsonValue = memoryProjection === null
          ? reviewQueueId === null
            ? { eventId: itemEventId }
            : { eventId: itemEventId, reviewQueueId }
          : {
            eventId: itemEventId,
            sourceEventId: memoryProjection.sourceEventId,
            memoryId: memoryProjection.memoryId,
            extractionRunId: memoryProjection.extractionRunId,
            consolidationEventId: memoryProjection.consolidationEventId,
          };
        const itemBody: JsonValue = {
          acceptedDecisionRule: item.classification.acceptedDecisionRule,
          annotationDigest: item.annotationDigest,
          byteRange: { end: item.sourceByteEnd, start: item.sourceByteStart },
          canonicalCatalogAnnotationId: item.canonicalCatalogAnnotationId,
          canonicalCatalogId: item.canonicalCatalogId,
          canonicalContentDigest: item.canonicalContentDigest,
          classificationRuleId: item.classification.ruleId,
          currentReviewDecision: item.currentReviewDecision,
          currentReviewStatus: item.currentReviewStatus,
          effectiveFrom: item.effectiveFrom.toISOString(),
          effectiveUntil: item.effectiveUntil?.toISOString() ?? null,
          excerptDigest: item.excerptDigest,
          excerptRef: item.excerptRef,
          expiresAt: item.expiresAt?.toISOString() ?? null,
          freshness: item.classification.freshness,
          freshDecisionEligible: item.classification.freshDecisionEligible,
          gustavoPolicyVersion: GUSTAVO_POLICY_VERSION,
          historicalMetadata: historicalMetadataDocument(item.historicalMetadata),
          historicalMetadataDigest: item.historicalMetadataDigest,
          importerVersion: IMPORTER_VERSION,
          itemDigest: item.itemDigest,
          lifecycleClass: item.classification.lifecycleClass,
          manifestId,
          observedAt: item.observedAt?.toISOString() ?? null,
          parserVersion: source.parserVersion,
          priorItemId: item.priorItemId,
          rawContent: item.text,
          recordType: item.kind,
          resultIds,
          retrievalMode: item.classification.retrievalMode,
          reviewReason: item.reviewReason,
          reviewer: item.reviewer,
          rulesetVersion: CLASSIFICATION_RULESET_VERSION,
          schemaVersion: IMPORT_ITEM_SCHEMA_VERSION,
          sourceDigest: prepared.sourceDigest,
          sourceLocator: source.locator,
          sourceNamespace: source.namespace,
          sourceTimestamp: prepared.sourceTimestamp?.toISOString() ?? null,
          sourceType: source.sourceType,
          stableLocator: item.stableLocator,
          visibilityScope: item.visibilityScope,
        };
        const itemEvent = await appendImportEvent(transaction, key, {
          aggregateId,
          eventId: itemEventId,
          type: "import.item.classified",
          body: itemBody,
          idempotencyPrefix: `import:item:${item.importKey}`,
          createdAt,
        });
        const lifecycleId = randomUUID();
        const lifecycleEventId = randomUUID();
        const lifecycleEvent = await appendImportEvent(transaction, key, {
          aggregateId,
          eventId: lifecycleEventId,
          type: "import.item.lifecycle_recorded",
          body: {
            action: "ACTIVATED",
            active: true,
            commandId: null,
            importerVersion: IMPORTER_VERSION,
            itemId,
            manifestId,
            reason: item.reviewReason,
            retrievalMode: item.classification.retrievalMode,
            reviewDecision: null,
            reviewer: item.reviewer,
            rulesetVersion: CLASSIFICATION_RULESET_VERSION,
          },
          idempotencyPrefix: `import:lifecycle:activate:${item.importKey}`,
          causationId: itemEvent.id,
          createdAt,
        });
        itemCommits.push({ item, itemId, itemEvent, lifecycleId, lifecycleEvent,
          memoryProjection, reviewQueueId, resultIds });
      }

      const manifestAuthority = authorityManifest(source, prepared);
      const manifestDigest = canonicalContentDigest(manifestAuthority);
      const manifestEvent = await appendImportEvent(transaction, key, {
        aggregateId,
        eventId: randomUUID(),
        type: "import.manifest.committed",
        body: {
          authorityManifest: manifestAuthority,
          manifestDigest,
          manifestId,
          priorManifestId,
          projectionStatus: "VERIFIED",
          sourceBytesBase64: prepared.sourceContent.toString("base64"),
        },
        idempotencyPrefix: `import:manifest:${prepared.importKey}`,
        createdAt,
      });

      await transaction.query(
        `insert into import_manifests (
           id,event_id,import_key,source_namespace,stable_locator,source_type,
           source_timestamp,source_digest,parser_version,importer_version,ruleset_version,
           schema_version,gustavo_policy_version,prior_manifest_id,source_count,
           source_bytes,parsed_count,rejected_count,
           duplicate_count,classification_counts,event_high_water,projection_status,
           authority_manifest,manifest_digest,body_digest,created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,0,0,$17,
                   $18,'VERIFIED',$19,$20,$21,$22)`,
        [manifestId, manifestEvent.id, prepared.importKey, source.namespace, source.locator,
          source.sourceType, prepared.sourceTimestamp, prepared.sourceDigest,
          source.parserVersion, IMPORTER_VERSION, CLASSIFICATION_RULESET_VERSION,
          IMPORT_ITEM_SCHEMA_VERSION, GUSTAVO_POLICY_VERSION, priorManifestId,
          prepared.sourceByteCount, items.length,
          JSON.stringify(prepared.classifications), manifestEvent.sequence,
          JSON.stringify(manifestAuthority), manifestDigest, manifestEvent.bodyDigest, createdAt],
      );

      for (const commit of itemCommits) {
        const item = commit.item;
        await transaction.query(
          `insert into import_source_items (
             id,event_id,manifest_id,prior_item_id,import_key,source_type,source_namespace,
             source_locator,stable_locator,source_timestamp,source_digest,item_digest,
             source_byte_start,source_byte_end,excerpt_digest,annotation_digest,
             historical_metadata_digest,parser_version,importer_version,record_type,
             lifecycle_class,visibility_scope,
             observed_at,expires_at,effective_from,effective_until,freshness,excerpt_ref,
             reviewer,review_reason,classification_rule_id,ruleset_version,schema_version,
             gustavo_policy_version,canonical_catalog_id,canonical_content_digest,
             current_review_status,current_review_decision,retrieval_mode,
             accepted_decision_rule,fresh_decision_eligible,
             result_ids,body_digest,authority_sequence,created_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                     $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,
                     $34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45)`,
          [commit.itemId, commit.itemEvent.id, manifestId, item.priorItemId, item.importKey,
            source.sourceType, source.namespace, source.locator, item.stableLocator,
            prepared.sourceTimestamp, prepared.sourceDigest, item.itemDigest,
            item.sourceByteStart, item.sourceByteEnd, item.excerptDigest, item.annotationDigest,
            item.historicalMetadataDigest, source.parserVersion, IMPORTER_VERSION, item.kind,
            item.classification.lifecycleClass, item.visibilityScope, item.observedAt,
            item.expiresAt, item.effectiveFrom, item.effectiveUntil,
            item.classification.freshness, item.excerptRef, item.reviewer, item.reviewReason,
            item.classification.ruleId, CLASSIFICATION_RULESET_VERSION,
            IMPORT_ITEM_SCHEMA_VERSION, GUSTAVO_POLICY_VERSION,
            item.canonicalCatalogId, item.canonicalContentDigest,
            item.currentReviewStatus, item.currentReviewDecision,
            item.classification.retrievalMode, item.classification.acceptedDecisionRule,
            item.classification.freshDecisionEligible, JSON.stringify(commit.resultIds),
            commit.itemEvent.bodyDigest,
            commit.itemEvent.sequence, createdAt],
        );
        await transaction.query(
          `insert into import_item_lifecycle_events (
             id,event_id,manifest_id,item_id,action,active,retrieval_mode,reviewer,reason,
             importer_version,ruleset_version,body_digest,authority_sequence,created_at
           ) values ($1,$2,$3,$4,'ACTIVATED',true,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [commit.lifecycleId, commit.lifecycleEvent.id, manifestId, commit.itemId,
            item.classification.retrievalMode, item.reviewer, item.reviewReason,
            IMPORTER_VERSION, CLASSIFICATION_RULESET_VERSION,
            commit.lifecycleEvent.bodyDigest, commit.lifecycleEvent.sequence, createdAt],
        );
        if (commit.memoryProjection !== null) {
          await transaction.query(
            `insert into import_memory_projections (
               item_id,manifest_id,memory_id,extraction_run_id,consolidation_event_id,
               source_event_id,lifecycle_class,retrieval_profile,created_at
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [commit.itemId, manifestId, commit.memoryProjection.memoryId,
              commit.memoryProjection.extractionRunId,
              commit.memoryProjection.consolidationEventId,
              commit.memoryProjection.sourceEventId, item.classification.lifecycleClass,
              commit.memoryProjection.retrievalProfile, createdAt],
          );
        }
        if (commit.reviewQueueId !== null) {
          await transaction.query(
            `insert into import_review_queue_entries (id,item_id,manifest_id,status,created_at)
             values ($1,$2,$3,'PENDING',$4)`,
            [commit.reviewQueueId, commit.itemId, manifestId, createdAt],
          );
        }
      }

      await insertEventAuthority(transaction, "MANIFEST", manifestId, manifestEvent);
      for (const commit of itemCommits) {
        await insertEventAuthority(transaction, "ITEM", commit.itemId, commit.itemEvent);
        await insertEventAuthority(
          transaction,
          "LIFECYCLE",
          commit.lifecycleId,
          commit.lifecycleEvent,
        );
      }
      return Object.freeze({
        manifestId,
        priorManifestId,
        inserted: items.length,
        duplicates: 0,
        classifications: prepared.classifications,
        manifestDigest,
        eventHighWater: manifestEvent.sequence,
      });
    } finally {
      key.plaintext.fill(0);
    }
    });
  } finally {
    prepared.sourceContent.fill(0);
  }
}

export async function readImportedItemContent(
  context: ImportContext,
  itemId: string,
  actor: EventReadActor,
): Promise<string> {
  if (actor.role !== "SYSTEM"
    && (actor.role !== "OPERATOR" || actor.purpose.trim().length === 0)) {
    throw new Error("FORBIDDEN");
  }
  const item = await context.db.one<{ event_id: string }>(
    "select event_id::text from import_source_items where id=$1",
    [itemId],
  );
  const body = await readEventBody(context.db, item.event_id, { actor });
  if (body === null || Array.isArray(body) || typeof body !== "object"
    || typeof body.rawContent !== "string") {
    throw new Error("IMPORT_ITEM_BODY_INVALID");
  }
  return body.rawContent;
}

function authorizeLifecycleActor(actor: ImportLifecycleActor): {
  readonly id: string;
  readonly purpose: string;
} {
  if (actor.role !== "OPERATOR" || !actor.id.trim() || !actor.purpose.trim()) {
    throw new Error("FORBIDDEN");
  }
  return Object.freeze({
    id: requireBoundedText(actor.id, "LIFECYCLE_ACTOR", 256),
    purpose: requireBoundedText(actor.purpose, "LIFECYCLE_PURPOSE", 512),
  });
}

function exactItemIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > IMPORT_LIMITS.items) {
    throw new Error("IMPORT_ITEM_SET_LIMIT");
  }
  const ids = value.map((id) => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
      .test(id)) {
      throw new Error("IMPORT_ITEM_ID_INVALID");
    }
    return id.toLowerCase();
  }).sort();
  if (new Set(ids).size !== ids.length) throw new Error("IMPORT_ITEM_SET_DUPLICATE");
  return Object.freeze(ids);
}

async function applyImportLifecycleCommand(
  context: ImportContext,
  input: {
    readonly manifestId: string;
    readonly itemIds: readonly string[];
    readonly actor: ImportLifecycleActor;
    readonly action: "DEACTIVATED" | "REACTIVATED" | "REVIEW_DECIDED";
    readonly reviewDecision: ImportReviewDecision | null;
    readonly reason: string;
    readonly idempotencyKey: string;
  },
): Promise<ImportLifecycleResult> {
  const actor = authorizeLifecycleActor(input.actor);
  const itemIds = exactItemIds(input.itemIds);
  const reason = requireBoundedText(input.reason, "REVIEW_REASON", 1_024);
  const idempotencyKey = requireBoundedText(input.idempotencyKey, "IDEMPOTENCY_KEY", 256);
  const requestManifest: JsonValue = {
    action: input.action,
    actorId: actor.id,
    actorPurpose: actor.purpose,
    itemIds: [...itemIds],
    manifestId: input.manifestId,
    reason,
    reviewDecision: input.reviewDecision,
  };
  const requestDigest = canonicalContentDigest(requestManifest);
  return context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `bootstrap-lifecycle-idempotency:${idempotencyKey}`,
    ]);
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `bootstrap-lifecycle:${input.manifestId}`,
    ]);
    const byIdempotencyKey = await transaction.query<LifecycleCommandRow>(
      `select command.id::text,alias.idempotency_key,command.request_digest,
              command.result_event_ids::text[]
         from import_lifecycle_idempotency_aliases alias
         join import_lifecycle_commands command on command.id=alias.command_id
        where alias.idempotency_key=$1`,
      [idempotencyKey],
    );
    if (byIdempotencyKey[0]) {
      if (byIdempotencyKey[0].request_digest !== requestDigest) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return Object.freeze({
        commandId: byIdempotencyKey[0].id,
        lifecycleEventIds: Object.freeze([...byIdempotencyKey[0].result_event_ids]),
        transitioned: byIdempotencyKey[0].result_event_ids.length,
        replayed: true,
      });
    }
    const byRequest = await transaction.query<LifecycleCommandRow>(
      `select id::text,idempotency_key,request_digest,result_event_ids::text[]
         from import_lifecycle_commands where request_digest=$1`,
      [requestDigest],
    );
    if (byRequest[0]) {
      await transaction.query(
        `insert into import_lifecycle_idempotency_aliases (
           idempotency_key,command_id,request_digest,created_at
         ) values ($1,$2,$3,$4)`,
        [idempotencyKey, byRequest[0].id, requestDigest, new Date()],
      );
      return Object.freeze({
        commandId: byRequest[0].id,
        lifecycleEventIds: Object.freeze([...byRequest[0].result_event_ids]),
        transitioned: byRequest[0].result_event_ids.length,
        replayed: true,
      });
    }
    const manifest = await transaction.one<{
      importer_version: string;
      ruleset_version: string;
      stable_locator: string;
      source_digest: string;
      source_bytes: string | number;
    }>(
      `select importer_version,ruleset_version,stable_locator,source_digest,source_bytes::text
         from import_manifests where id=$1`,
      [input.manifestId],
    );
    if (manifest.importer_version !== IMPORTER_VERSION
      || manifest.ruleset_version !== CLASSIFICATION_RULESET_VERSION) {
      throw new Error("IMPORT_VERSION_UNSUPPORTED");
    }
    const items = await transaction.query<LifecycleItemRow>(
      `select item.id::text,item.event_id::text,item.retrieval_mode,item.lifecycle_class,
              item.source_locator,item.source_digest,item.source_byte_start::text,
              item.source_byte_end::text,
              latest.active
         from import_source_items item
         join lateral (
           select lifecycle.active from import_item_lifecycle_events lifecycle
            where lifecycle.item_id=item.id
            order by lifecycle.authority_sequence desc,lifecycle.id desc limit 1
         ) latest on true
        where item.manifest_id=$1 and item.id=any($2::uuid[])
        order by item.id for update of item`,
      [input.manifestId, itemIds],
    );
    if (items.length !== itemIds.length
      || items.some((item, index) => item.id !== itemIds[index])) {
      throw new Error("IMPORT_ITEM_SET_MISMATCH");
    }
    if (input.action === "DEACTIVATED" && items.some((item) => !item.active)
      || input.action === "REACTIVATED" && items.some((item) => item.active)) {
      throw new Error("IMPORT_LIFECYCLE_STATE_CONFLICT");
    }
    if (input.action === "REVIEW_DECIDED") {
      if (input.reviewDecision === "ARCHIVE_AS_SUPERSEDED_RAW") {
        const verification = await transaction.query<{ id: string }>(
          `select id::text from import_verification_receipts
            where manifest_id=$1 and valid order by verified_event_high_water desc limit 1`,
          [input.manifestId],
        );
        if (!verification[0]) throw new Error("IMPORT_ARCHIVE_VERIFICATION_REQUIRED");
        if (items.length !== 1 || items.some((item) => (
          !["DEPRECATED", "HISTORICAL"].includes(item.lifecycle_class)
          || item.source_locator !== manifest.stable_locator
          || item.source_digest !== manifest.source_digest
          || Number(item.source_byte_start) !== 0
          || Number(item.source_byte_end) !== Number(manifest.source_bytes)
        ))) {
          throw new Error("IMPORT_ARCHIVE_REVIEW_ITEM_INVALID");
        }
      } else if (items.some((item) => item.lifecycle_class !== "CANDIDATE")) {
        throw new Error("IMPORT_REVIEW_ITEM_CLASS_INVALID");
      }
    }
    const aggregateId = `import:${input.manifestId}`;
    const key = await loadAggregateKey(transaction, aggregateId, "FAIL");
    try {
      const commandId = randomUUID();
      const createdAt = new Date();
      const pending: Array<{
        readonly item: LifecycleItemRow;
        readonly lifecycleId: string;
        readonly event: CommittedImportEvent;
      }> = [];
      for (const item of items) {
        const lifecycleId = randomUUID();
        const active = input.action === "DEACTIVATED" ? false
          : input.action === "REACTIVATED" ? true : item.active;
        const event = await appendImportEvent(transaction, key, {
          aggregateId,
          eventId: randomUUID(),
          type: "import.item.lifecycle_recorded",
          body: {
            action: input.action,
            active,
            actorPurpose: actor.purpose,
            commandId,
            importerVersion: IMPORTER_VERSION,
            itemId: item.id,
            manifestId: input.manifestId,
            reason,
            requestDigest,
            retrievalMode: item.retrieval_mode,
            reviewDecision: input.reviewDecision,
            reviewer: actor.id,
            rulesetVersion: CLASSIFICATION_RULESET_VERSION,
          },
          idempotencyPrefix: `import:lifecycle:${requestDigest}:${item.id}`,
          causationId: item.event_id,
          createdAt,
        });
        pending.push({ item, lifecycleId, event });
      }
      await transaction.query(
        `insert into import_lifecycle_commands (
           id,manifest_id,action,item_ids,actor_id,actor_purpose,reason,review_decision,
           idempotency_key,request_manifest,request_digest,result_lifecycle_ids,
           result_event_ids,created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [commandId, input.manifestId, input.action, itemIds, actor.id, actor.purpose,
          reason, input.reviewDecision, idempotencyKey, JSON.stringify(requestManifest),
          requestDigest, pending.map(({ lifecycleId }) => lifecycleId),
          pending.map(({ event }) => event.id), createdAt],
      );
      await transaction.query(
        `insert into import_lifecycle_idempotency_aliases (
           idempotency_key,command_id,request_digest,created_at
         ) values ($1,$2,$3,$4)`,
        [idempotencyKey, commandId, requestDigest, createdAt],
      );
      for (const transition of pending) {
        const active = input.action === "DEACTIVATED" ? false
          : input.action === "REACTIVATED" ? true : transition.item.active;
        await transaction.query(
          `insert into import_item_lifecycle_events (
             id,event_id,manifest_id,item_id,command_id,action,active,retrieval_mode,
             reviewer,reason,review_decision,importer_version,ruleset_version,
             body_digest,authority_sequence,created_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [transition.lifecycleId, transition.event.id, input.manifestId,
            transition.item.id, commandId, input.action, active,
            transition.item.retrieval_mode, actor.id, reason, input.reviewDecision,
            IMPORTER_VERSION, CLASSIFICATION_RULESET_VERSION,
            transition.event.bodyDigest, transition.event.sequence, createdAt],
        );
        await insertEventAuthority(
          transaction,
          "LIFECYCLE",
          transition.lifecycleId,
          transition.event,
        );
      }
      return Object.freeze({
        commandId,
        lifecycleEventIds: Object.freeze(pending.map(({ event }) => event.id)),
        transitioned: pending.length,
        replayed: false,
      });
    } finally {
      key.plaintext.fill(0);
    }
  });
}

export function deactivateImportItems(
  context: ImportContext,
  input: {
    readonly manifestId: string;
    readonly itemIds: readonly string[];
    readonly actor: ImportLifecycleActor;
    readonly reason: string;
    readonly idempotencyKey: string;
  },
): Promise<ImportLifecycleResult> {
  return applyImportLifecycleCommand(context, {
    ...input,
    action: "DEACTIVATED",
    reviewDecision: null,
  });
}

export function reactivateImportItems(
  context: ImportContext,
  input: {
    readonly manifestId: string;
    readonly itemIds: readonly string[];
    readonly actor: ImportLifecycleActor;
    readonly reason: string;
    readonly idempotencyKey: string;
  },
): Promise<ImportLifecycleResult> {
  return applyImportLifecycleCommand(context, {
    ...input,
    action: "REACTIVATED",
    reviewDecision: null,
  });
}

export function reviewImportItems(
  context: ImportContext,
  input: {
    readonly manifestId: string;
    readonly itemIds: readonly string[];
    readonly actor: ImportLifecycleActor;
    readonly decision: ImportReviewDecision;
    readonly reason: string;
    readonly idempotencyKey: string;
  },
): Promise<ImportLifecycleResult> {
  if (!["RETAIN_AS_CLASSIFIED", "REJECTED", "ARCHIVE_AS_SUPERSEDED_RAW"]
    .includes(input.decision)) {
    return Promise.reject(new Error("IMPORT_REVIEW_DECISION_UNSUPPORTED"));
  }
  return applyImportLifecycleCommand(context, {
    ...input,
    action: "REVIEW_DECIDED",
    reviewDecision: input.decision,
  });
}

export async function deactivateBootstrapImport(
  context: ImportContext,
  input: {
    readonly manifestId: string;
    readonly actor: ImportLifecycleActor;
    readonly reason: string;
    readonly idempotencyKey: string;
  },
): Promise<{ readonly deactivated: number }> {
  authorizeLifecycleActor(input.actor);
  const activeItems = await context.db.query<{ id: string }>(
    `select item.id::text from import_source_items item
     join lateral (
       select active from import_item_lifecycle_events lifecycle where lifecycle.item_id=item.id
       order by authority_sequence desc,id desc limit 1
     ) latest on true where item.manifest_id=$1 and latest.active order by item.id`,
    [input.manifestId],
  );
  if (activeItems.length === 0) return Object.freeze({ deactivated: 0 });
  const result = await deactivateImportItems(context, {
    manifestId: input.manifestId,
    itemIds: activeItems.map(({ id }) => id),
    actor: input.actor,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  });
  return Object.freeze({ deactivated: result.transitioned });
}

interface ArchiveAuthorityEventRow extends Record<string, unknown> {
  readonly id: string;
  readonly aggregate_id: string;
  readonly account_id: string | null;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly type: string;
  readonly visibility: string;
  readonly occurred_at: Date;
  readonly causation_id: string | null;
  readonly correlation_id: string;
  readonly prompt_version: string | null;
  readonly model_version: string | null;
  readonly policy_version: string | null;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly integrity_hash: string;
  readonly ingested_sequence: string | number;
  readonly encrypted_body_digest: string;
  readonly authority_kind: string;
  readonly authority_id: string;
  readonly authority_body_digest: string;
  readonly authority_request_hash: string;
  readonly authority_integrity_hash: string;
  readonly authority_outbox_digest: string;
  readonly authority_sequence: string | number;
  readonly topic: string;
  readonly payload: JsonValue;
}

async function loadArchiveAuthorityEvent(
  database: EventDatabase,
  authorityKind: "MANIFEST" | "ITEM" | "LIFECYCLE" | "VERIFICATION",
  authorityId: string,
): Promise<{ readonly row: ArchiveAuthorityEventRow; readonly body: JsonValue }> {
  const rows = await database.query<ArchiveAuthorityEventRow>(
    `select event.id::text,event.aggregate_id,event.account_id::text,event.actor_type,
            event.actor_id,event.type,event.visibility,event.occurred_at,
            event.causation_id::text,event.correlation_id::text,event.prompt_version,
            event.model_version,event.policy_version,event.idempotency_key,
            event.request_hash,event.integrity_hash,event.ingested_sequence::text,
            body.body_digest encrypted_body_digest,authority.authority_kind,
            authority.authority_id::text,authority.body_digest authority_body_digest,
            authority.event_request_hash authority_request_hash,
            authority.event_integrity_hash authority_integrity_hash,
            authority.outbox_payload_digest authority_outbox_digest,
            authority.authority_sequence::text,outbox.topic,outbox.payload
       from import_event_authorities authority
       join events event on event.id=authority.event_id
       join encrypted_event_bodies body on body.event_id=event.id
       join transactional_outbox outbox on outbox.event_id=event.id
      where authority.authority_kind=$1 and authority.authority_id=$2
      for share of authority,event,body,outbox`,
    [authorityKind, authorityId],
  );
  if (rows.length !== 1) throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
  const row = rows[0]!;
  const body = await readEventBody(database, row.id, {
    actor: { role: "OPERATOR", purpose: "verify durable bootstrap archive authority" },
  });
  const sequence = Number(row.ingested_sequence);
  if (row.authority_kind !== authorityKind || row.authority_id !== authorityId
    || row.aggregate_id.length < 8 || row.account_id !== null
    || row.actor_type !== "OPERATOR" || row.actor_id !== "gustavo-importer"
    || row.visibility !== "OPERATOR" || row.correlation_id !== row.id
    || row.prompt_version !== IMPORTER_VERSION || row.policy_version !== GUSTAVO_POLICY_VERSION
    || row.model_version !== null || !Number.isSafeInteger(sequence) || sequence < 1
    || Number(row.authority_sequence) !== sequence
    || row.encrypted_body_digest !== row.authority_body_digest
    || canonicalContentDigest(body) !== row.encrypted_body_digest
    || row.authority_request_hash !== row.request_hash
    || row.authority_integrity_hash !== row.integrity_hash
    || row.topic !== row.type
    || canonicalJson(row.payload) !== canonicalJson({ eventId: row.id })
    || row.authority_outbox_digest !== canonicalContentDigest(row.payload)
    || !row.idempotency_key.endsWith(`:${row.encrypted_body_digest}`)
    || row.request_hash !== canonicalContentDigest(eventRequestDocument({
      aggregateId: row.aggregate_id,
      body,
      causationId: row.causation_id,
      createdAt: row.occurred_at,
      eventId: row.id,
      idempotencyKey: row.idempotency_key,
      type: row.type,
    }))
    || row.integrity_hash !== canonicalContentDigest(eventIntegrityDocument({
      aggregateId: row.aggregate_id,
      body,
      causationId: row.causation_id,
      createdAt: row.occurred_at,
      eventId: row.id,
      type: row.type,
    }))) {
    throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
  }
  return Object.freeze({ row, body });
}

function jsonRecord(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
  }
  return value;
}

function hasExactJsonKeys(
  value: { readonly [key: string]: JsonValue },
  expected: readonly string[],
): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

/**
 * Reconstructs removal authority from immutable database projections and their
 * encrypted canonical events. The HMAC receipt is intentionally not treated as
 * authority here; callers must verify its transport integrity separately.
 */
async function withBootstrapArchiveAuthority<Result>(
  context: ImportContext,
  receipt: BootstrapArchiveReceipt,
  action: () => Promise<Result>,
): Promise<Result> {
  let authorityValidated = false;
  try {
    return await context.db.transaction(async (transaction) => {
      if (receipt.format !== "gustavo-bootstrap-archive-receipt-v1"
        || Object.keys(receipt).sort().join(",")
          !== "authenticationDigest,format,manifestDigest,manifestId,sources,verificationDigest,verificationReceiptId"
        || receipt.sources.length !== 1 || receipt.sources[0]!.itemIds.length !== 1
        || Object.keys(receipt.sources[0]!).sort().join(",")
          !== "archiveDecision,archiveDecisionEventId,digest,itemIds,lifecycleClass,locator") {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }
      await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `bootstrap-lifecycle:${receipt.manifestId}`,
      ]);
      const manifestRows = await transaction.query<{
        id: string;
        event_id: string;
        stable_locator: string;
        source_digest: string;
        source_bytes: string | number;
        source_count: number;
        parsed_count: number;
        rejected_count: number;
        duplicate_count: number;
        classification_counts: JsonValue;
        projection_status: string;
        event_high_water: string | number;
        manifest_digest: string;
        authority_manifest: JsonValue;
        body_digest: string;
        prior_manifest_id: string | null;
      }>(
        `select id::text,event_id::text,stable_locator,source_digest,source_bytes::text,
                source_count,parsed_count,rejected_count,duplicate_count,
                classification_counts,projection_status,event_high_water::text,
                manifest_digest,authority_manifest,body_digest,prior_manifest_id::text
           from import_manifests where id=$1 for share`,
        [receipt.manifestId],
      );
      const manifest = manifestRows[0];
      if (manifestRows.length !== 1 || !manifest
        || manifest.id !== receipt.manifestId
        || manifest.manifest_digest !== receipt.manifestDigest
        || manifest.source_count !== 1 || manifest.parsed_count !== 1
        || manifest.rejected_count !== 0 || manifest.duplicate_count !== 0
        || manifest.projection_status !== "VERIFIED"
        || canonicalContentDigest(manifest.authority_manifest) !== manifest.manifest_digest) {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }
      const manifestAuthority = await loadArchiveAuthorityEvent(
        transaction,
        "MANIFEST",
        manifest.id,
      );
      const manifestBody = jsonRecord(manifestAuthority.body);
      const sourceBytesBase64 = manifestBody.sourceBytesBase64;
      if (manifestAuthority.row.id !== manifest.event_id
        || manifestAuthority.row.type !== "import.manifest.committed"
        || manifestAuthority.row.aggregate_id !== `import:${manifest.id}`
        || manifestAuthority.row.encrypted_body_digest !== manifest.body_digest
        || Number(manifestAuthority.row.ingested_sequence) !== Number(manifest.event_high_water)
        || Object.keys(manifestBody).length !== 6
        || manifestBody.manifestId !== manifest.id
        || manifestBody.manifestDigest !== manifest.manifest_digest
        || manifestBody.priorManifestId !== manifest.prior_manifest_id
        || manifestBody.projectionStatus !== manifest.projection_status
        || canonicalJson(manifestBody.authorityManifest ?? null)
          !== canonicalJson(manifest.authority_manifest)
        || typeof sourceBytesBase64 !== "string") {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }
      const sourceBytes = Buffer.from(sourceBytesBase64, "base64");
      try {
        if (sourceBytes.toString("base64") !== sourceBytesBase64
          || sourceBytes.length !== Number(manifest.source_bytes)
          || digestBytes(sourceBytes) !== manifest.source_digest) {
          throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
        }
      } finally {
        sourceBytes.fill(0);
      }

      const verificationRows = await transaction.query<{
        id: string;
        event_id: string;
        manifest_id: string;
        verification_digest: string;
        authority_manifest: JsonValue;
        source_count: number;
        source_bytes: string | number;
        parsed_count: number;
        rejected_count: number;
        duplicate_count: number;
        classification_counts: JsonValue;
        projection_status: string;
        manifest_event_high_water: string | number;
        verified_event_high_water: string | number;
        provenance_count: number;
        body_count: number;
        outbox_count: number;
        valid: boolean;
        body_digest: string;
      }>(
        `select id::text,event_id::text,manifest_id::text,verification_digest,
                authority_manifest,source_count,source_bytes::text,parsed_count,
                rejected_count,duplicate_count,classification_counts,projection_status,
                manifest_event_high_water::text,verified_event_high_water::text,
                provenance_count,body_count,outbox_count,valid,body_digest
           from import_verification_receipts where id=$1 for share`,
        [receipt.verificationReceiptId],
      );
      const verification = verificationRows[0];
      if (verificationRows.length !== 1 || !verification || !verification.valid
        || verification.manifest_id !== manifest.id
        || verification.verification_digest !== receipt.verificationDigest
        || canonicalContentDigest(verification.authority_manifest)
          !== verification.verification_digest
        || verification.source_count !== manifest.source_count
        || Number(verification.source_bytes) !== Number(manifest.source_bytes)
        || verification.parsed_count !== manifest.parsed_count
        || verification.rejected_count !== manifest.rejected_count
        || verification.duplicate_count !== manifest.duplicate_count
        || canonicalJson(verification.classification_counts)
          !== canonicalJson(manifest.classification_counts)
        || verification.projection_status !== manifest.projection_status
        || Number(verification.manifest_event_high_water) !== Number(manifest.event_high_water)) {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }
      const verificationAuthority = await loadArchiveAuthorityEvent(
        transaction,
        "VERIFICATION",
        verification.id,
      );
      const verificationBody = jsonRecord(verificationAuthority.body);
      const reconstructed = jsonRecord(verificationBody.reconstructed ?? null);
      const verificationAuthorityManifest = jsonRecord(
        verificationBody.authorityManifest ?? null,
      );
      const verificationCounts = jsonRecord(verificationAuthorityManifest.counts ?? null);
      const verificationSafety = jsonRecord(verificationAuthorityManifest.safety ?? null);
      if (!hasExactJsonKeys(verificationBody, [
        "authorityManifest", "manifestId", "reconstructed", "valid", "verificationDigest",
      ])
        || !hasExactJsonKeys(reconstructed, [
          "classificationCounts", "duplicateCount", "parsedCount", "projectionStatus",
          "rejectedCount", "sourceBytes", "sourceCount",
        ])
        || !hasExactJsonKeys(verificationAuthorityManifest, [
          "classificationCounts", "counts", "deterministicReplay", "gustavoPolicyVersion",
          "importerVersion", "manifestDigest", "manifestEventHighWater", "manifestId",
          "projectionStatus", "rulesetVersion", "safety", "schemaVersion", "valid",
        ])
        || !hasExactJsonKeys(verificationCounts, [
          "body", "bytes", "duplicates", "outbox", "parsed", "provenance", "rejected", "sources",
        ])
        || !hasExactJsonKeys(verificationSafety, [
          "candidateInAcceptedRules", "deprecatedInActiveRetrieval",
          "forbiddenBehaviorInActiveRetrieval", "historicalInFreshDecisionGates",
          "prohibitedInActiveRetrieval",
        ])
        || verificationAuthority.row.id !== verification.event_id
        || verificationAuthority.row.type !== "import.verification.completed"
        || verificationAuthority.row.aggregate_id !== `import:${manifest.id}`
        || verificationAuthority.row.causation_id !== manifest.event_id
        || verificationAuthority.row.encrypted_body_digest !== verification.body_digest
        || Number(verificationAuthority.row.ingested_sequence)
          !== Number(verification.verified_event_high_water)
        || verificationBody.manifestId !== manifest.id
        || verificationBody.verificationDigest !== verification.verification_digest
        || verificationBody.valid !== true
        || canonicalJson(verificationBody.authorityManifest ?? null)
          !== canonicalJson(verification.authority_manifest)
        || reconstructed.sourceCount !== verification.source_count
        || reconstructed.sourceBytes !== Number(verification.source_bytes)
        || reconstructed.parsedCount !== verification.parsed_count
        || reconstructed.rejectedCount !== verification.rejected_count
        || reconstructed.duplicateCount !== verification.duplicate_count
        || canonicalJson(reconstructed.classificationCounts ?? null)
          !== canonicalJson(verification.classification_counts)
        || reconstructed.projectionStatus !== verification.projection_status) {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }

      const source = receipt.sources[0]!;
      const itemId = source.itemIds[0]!;
      const itemRows = await transaction.query<{
        id: string;
        event_id: string;
        manifest_id: string;
        source_locator: string;
        source_digest: string;
        source_byte_start: string | number;
        source_byte_end: string | number;
        excerpt_digest: string;
        item_digest: string;
        lifecycle_class: string;
        retrieval_mode: string;
        body_digest: string;
        authority_sequence: string | number;
        active: boolean;
        current_review_status: string;
        current_review_decision: string;
        review_pending: boolean;
      }>(
        `select item.id::text,item.event_id::text,item.manifest_id::text,
                item.source_locator,item.source_digest,item.source_byte_start::text,
                item.source_byte_end::text,item.excerpt_digest,item.item_digest,
                item.lifecycle_class,item.retrieval_mode,item.body_digest,
                item.authority_sequence::text,state.active,state.current_review_status,
                state.current_review_decision,state.review_pending
           from import_source_items item
           join import_item_current_states state on state.item_id=item.id
          where item.id=$1 for share of item`,
        [itemId],
      );
      const item = itemRows[0];
      if (itemRows.length !== 1 || !item || item.manifest_id !== manifest.id
        || source.locator !== manifest.stable_locator
        || item.source_locator !== source.locator
        || source.digest !== `sha256:${manifest.source_digest}`
        || item.source_digest !== manifest.source_digest
        || Number(item.source_byte_start) !== 0
        || Number(item.source_byte_end) !== Number(manifest.source_bytes)
        || item.excerpt_digest !== manifest.source_digest
        || item.item_digest !== manifest.source_digest
        || item.lifecycle_class !== source.lifecycleClass
        || !["DEPRECATED", "HISTORICAL"].includes(item.lifecycle_class)
        || item.retrieval_mode !== (item.lifecycle_class === "HISTORICAL"
          ? "SIMILARITY_ONLY" : "AUDIT_ONLY")
        || !item.active || item.review_pending
        || item.current_review_status !== "CLASSIFIED"
        || item.current_review_decision !== "ARCHIVE_AS_SUPERSEDED_RAW") {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }
      const itemAuthority = await loadArchiveAuthorityEvent(transaction, "ITEM", item.id);
      const itemBody = jsonRecord(itemAuthority.body);
      const byteRange = jsonRecord(itemBody.byteRange ?? null);
      if (itemAuthority.row.id !== item.event_id
        || itemAuthority.row.type !== "import.item.classified"
        || itemAuthority.row.aggregate_id !== `import:${manifest.id}`
        || itemAuthority.row.encrypted_body_digest !== item.body_digest
        || Number(itemAuthority.row.ingested_sequence) !== Number(item.authority_sequence)
        || itemBody.manifestId !== manifest.id || itemBody.sourceLocator !== source.locator
        || itemBody.sourceDigest !== manifest.source_digest
        || itemBody.rawContent === undefined || typeof itemBody.rawContent !== "string"
        || digestBytes(Buffer.from(itemBody.rawContent, "utf8")) !== manifest.source_digest
        || byteRange.start !== 0 || byteRange.end !== Number(manifest.source_bytes)
        || itemBody.excerptDigest !== manifest.source_digest
        || itemBody.lifecycleClass !== item.lifecycle_class
        || itemBody.retrievalMode !== item.retrieval_mode) {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }

      const decisions = await transaction.query<{
        id: string;
        event_id: string;
        manifest_id: string;
        item_id: string;
        command_id: string;
        action: string;
        active: boolean;
        retrieval_mode: string;
        reviewer: string;
        reason: string;
        review_decision: string;
        importer_version: string;
        ruleset_version: string;
        body_digest: string;
        authority_sequence: string | number;
        item_ids: string[];
        actor_id: string;
        actor_purpose: string;
        command_reason: string;
        command_review_decision: string;
        request_manifest: JsonValue;
        request_digest: string;
        result_lifecycle_ids: string[];
        result_event_ids: string[];
      }>(
        `select lifecycle.id::text,lifecycle.event_id::text,lifecycle.manifest_id::text,
                lifecycle.item_id::text,lifecycle.command_id::text,lifecycle.action,
                lifecycle.active,lifecycle.retrieval_mode,lifecycle.reviewer,lifecycle.reason,
                lifecycle.review_decision,lifecycle.importer_version,lifecycle.ruleset_version,
                lifecycle.body_digest,lifecycle.authority_sequence::text,
                command.item_ids::text[],command.actor_id,command.actor_purpose,
                command.reason command_reason,command.review_decision command_review_decision,
                command.request_manifest,command.request_digest,
                command.result_lifecycle_ids::text[],command.result_event_ids::text[]
           from import_item_lifecycle_events lifecycle
           join import_lifecycle_commands command on command.id=lifecycle.command_id
          where lifecycle.item_id=$1 and lifecycle.action='REVIEW_DECIDED'
            and lifecycle.review_decision='ARCHIVE_AS_SUPERSEDED_RAW'
          order by lifecycle.authority_sequence desc,lifecycle.id desc
          for share of lifecycle,command`,
        [item.id],
      );
      const decision = decisions[0];
      if (!decision || decision.event_id !== source.archiveDecisionEventId
        || source.archiveDecision !== "ARCHIVE_AS_SUPERSEDED_RAW"
        || decision.manifest_id !== manifest.id || decision.item_id !== item.id
        || decision.action !== "REVIEW_DECIDED" || !decision.active
        || decision.retrieval_mode !== item.retrieval_mode
        || decision.review_decision !== "ARCHIVE_AS_SUPERSEDED_RAW"
        || decision.command_review_decision !== decision.review_decision
        || decision.actor_id !== decision.reviewer || decision.command_reason !== decision.reason
        || decision.item_ids.length !== 1 || decision.item_ids[0] !== item.id
        || decision.result_lifecycle_ids.length !== 1
        || decision.result_lifecycle_ids[0] !== decision.id
        || decision.result_event_ids.length !== 1
        || decision.result_event_ids[0] !== decision.event_id
        || Number(decision.authority_sequence)
          <= Number(verification.verified_event_high_water)
        || canonicalContentDigest(decision.request_manifest) !== decision.request_digest) {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }
      const expectedRequestManifest: JsonValue = {
        action: "REVIEW_DECIDED",
        actorId: decision.actor_id,
        actorPurpose: decision.actor_purpose,
        itemIds: [item.id],
        manifestId: manifest.id,
        reason: decision.reason,
        reviewDecision: "ARCHIVE_AS_SUPERSEDED_RAW",
      };
      if (canonicalJson(decision.request_manifest) !== canonicalJson(expectedRequestManifest)) {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }
      const decisionAuthority = await loadArchiveAuthorityEvent(
        transaction,
        "LIFECYCLE",
        decision.id,
      );
      const expectedDecisionBody: JsonValue = {
        action: "REVIEW_DECIDED",
        active: true,
        actorPurpose: decision.actor_purpose,
        commandId: decision.command_id,
        importerVersion: decision.importer_version,
        itemId: item.id,
        manifestId: manifest.id,
        reason: decision.reason,
        requestDigest: decision.request_digest,
        retrievalMode: decision.retrieval_mode,
        reviewDecision: "ARCHIVE_AS_SUPERSEDED_RAW",
        reviewer: decision.reviewer,
        rulesetVersion: decision.ruleset_version,
      };
      if (decisionAuthority.row.id !== decision.event_id
        || decisionAuthority.row.type !== "import.item.lifecycle_recorded"
        || decisionAuthority.row.aggregate_id !== `import:${manifest.id}`
        || decisionAuthority.row.encrypted_body_digest !== decision.body_digest
        || Number(decisionAuthority.row.ingested_sequence) !== Number(decision.authority_sequence)
        || canonicalJson(decisionAuthority.body) !== canonicalJson(expectedDecisionBody)) {
        throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      }
      authorityValidated = true;
      return action();
    });
  } catch (error) {
    if (authorityValidated) throw error;
    if (error instanceof Error && error.message === "ARCHIVE_DATABASE_AUTHORITY_INVALID") {
      throw error;
    }
    throw new Error("ARCHIVE_DATABASE_AUTHORITY_INVALID", { cause: error });
  }
}

export async function verifyBootstrapArchiveAuthority(
  context: ImportContext,
  receipt: BootstrapArchiveReceipt,
): Promise<void> {
  await withBootstrapArchiveAuthority(context, receipt, async () => undefined);
}

export function executeWithBootstrapArchiveAuthority<Result>(
  context: ImportContext,
  receipt: BootstrapArchiveReceipt,
  action: () => Promise<Result>,
): Promise<Result> {
  return withBootstrapArchiveAuthority(context, receipt, action);
}

export async function verifyBootstrap(
  context: ImportContext,
  manifestId: string,
  options: { readonly archiveReceiptKey?: Buffer } = {},
): Promise<BootstrapVerification> {
  const manifest = await context.db.one<{
    import_key: string;
    source_namespace: string;
    stable_locator: string;
    source_digest: string;
    source_type: ImportSourceType;
    source_timestamp: Date | null;
    source_count: number;
    source_bytes: string | number;
    parsed_count: number;
    rejected_count: number;
    duplicate_count: number;
    classification_counts: Record<LifecycleClass, number>;
    projection_status: string;
    event_high_water: string | number;
    importer_version: string;
    parser_version: string;
    ruleset_version: string;
    schema_version: string;
    gustavo_policy_version: string;
    prior_manifest_id: string | null;
    authority_manifest: JsonValue;
    manifest_digest: string;
    event_id: string;
    body_digest: string;
  }>(
    `select import_key,source_namespace,stable_locator,source_digest,source_type,
            source_timestamp,source_count,source_bytes::text,parsed_count,rejected_count,
            duplicate_count,classification_counts,projection_status,event_high_water::text,
            importer_version,parser_version,ruleset_version,schema_version,
            gustavo_policy_version,prior_manifest_id::text,authority_manifest,
            manifest_digest,event_id::text,body_digest
       from import_manifests where id=$1`,
    [manifestId],
  );
  const items = await context.db.query<ImportItemVerificationRow>(
    `select item.id::text,item.event_id::text,item.prior_item_id::text,item.import_key,
            item.stable_locator,item.source_namespace,
            item.source_locator,item.source_digest,item.item_digest,
            item.source_byte_start::text,item.source_byte_end::text,
            item.excerpt_digest,item.annotation_digest,
            item.historical_metadata_digest,item.source_type,
            item.source_timestamp,item.importer_version,item.parser_version,item.record_type,
            item.lifecycle_class,item.retrieval_mode,item.freshness,item.visibility_scope,
            item.observed_at,item.expires_at,item.effective_from,item.effective_until,
            item.classification_rule_id,item.ruleset_version,item.schema_version,
            item.gustavo_policy_version,item.canonical_catalog_id,item.canonical_content_digest,
            item.current_review_status,item.current_review_decision,
            item.authority_sequence::text,item.created_at,item.accepted_decision_rule,
            item.fresh_decision_eligible,item.reviewer,item.review_reason,item.excerpt_ref,
            item.result_ids,item.body_digest,body.body_digest encrypted_body_digest,
            memory.manifest_id::text memory_manifest_id,
            memory.lifecycle_class memory_projection_class,
            memory.retrieval_profile memory_retrieval_profile,
            memory.memory_id::text,memory.extraction_run_id::text,
            memory.consolidation_event_id::text,memory.source_event_id::text memory_source_event_id,
            memory_record.type memory_type,memory_record.scope memory_scope,
            memory_record.valid_from memory_valid_from,memory_record.valid_to memory_valid_to,
            memory_record.conflict_state memory_conflict_state,
            memory_record.source_count memory_source_count,
            extraction.scope extraction_scope,
            extraction.source_event_id::text extraction_source_event_id,
            extraction.consolidation_event_id::text extraction_consolidation_event_id,
            extraction.prompt_version extraction_prompt_version,
            extraction.model_version extraction_model_version,
            extraction.extractor_version extraction_extractor_version,
            extraction.embedding_version extraction_embedding_version,
            extraction.memory_count extraction_memory_count,
            extraction.status extraction_status,
            source_event.type memory_source_event_type,
            source_event.visibility memory_source_event_visibility,
            review.id::text review_queue_id,review.manifest_id::text review_manifest_id,
            review.status review_status,
            archive_decision.event_id::text archive_decision_event_id,
            archive_decision.authority_sequence::text archive_decision_sequence,
            archive_decision.after_verification archive_decision_after_verification,
            latest.active
       from import_source_items item
       left join encrypted_event_bodies body on body.event_id=item.event_id
        left join import_memory_projections memory on memory.item_id=item.id
        left join memory_records memory_record on memory_record.id=memory.memory_id
        left join memory_extraction_runs extraction on extraction.id=memory.extraction_run_id
        left join events source_event on source_event.id=memory.source_event_id
        left join import_review_queue_entries review on review.item_id=item.id
        left join lateral (
          select lifecycle.event_id,lifecycle.authority_sequence,exists (
            select 1 from import_verification_receipts receipt
             where receipt.manifest_id=lifecycle.manifest_id and receipt.valid
               and receipt.verified_event_high_water<lifecycle.authority_sequence
          ) after_verification
            from import_item_lifecycle_events lifecycle
           where lifecycle.item_id=item.id and lifecycle.action='REVIEW_DECIDED'
             and lifecycle.review_decision='ARCHIVE_AS_SUPERSEDED_RAW'
           order by lifecycle.authority_sequence desc,lifecycle.id desc limit 1
        ) archive_decision on true
       join lateral (
         select lifecycle.active from import_item_lifecycle_events lifecycle
          where lifecycle.item_id=item.id
          order by lifecycle.authority_sequence desc,lifecycle.id desc limit 1
       ) latest on true
      where item.manifest_id=$1 order by item.stable_locator`,
    [manifestId],
  );
  let hashMismatches = canonicalContentDigest(manifest.authority_manifest)
    === manifest.manifest_digest ? 0 : 1;
  const manifestBody = await readEventBody(context.db, manifest.event_id, {
    actor: { role: "OPERATOR", purpose: "verify bootstrap manifest" },
  });
  const manifestBodyRecord = manifestBody !== null && !Array.isArray(manifestBody)
    && typeof manifestBody === "object" ? manifestBody : undefined;
  if (canonicalContentDigest(manifestBody) !== manifest.body_digest
    || manifestBodyRecord === undefined
    || Object.keys(manifestBodyRecord).length !== 6
    || manifestBodyRecord?.manifestDigest !== manifest.manifest_digest
    || manifestBodyRecord?.manifestId !== manifestId
    || manifestBodyRecord?.priorManifestId !== manifest.prior_manifest_id
    || manifestBodyRecord?.projectionStatus !== manifest.projection_status
    || manifestBodyRecord?.authorityManifest === undefined
    || canonicalJson(manifestBodyRecord?.authorityManifest)
      !== canonicalJson(manifest.authority_manifest)) {
    hashMismatches += 1;
  }
  let sourceHashMismatches = 0;
  let exactSourceBytes: Buffer | undefined;
  const encodedSource = manifestBodyRecord?.sourceBytesBase64;
  if (typeof encodedSource !== "string") {
    sourceHashMismatches += 1;
  } else {
    const decoded = Buffer.from(encodedSource, "base64");
    if (decoded.toString("base64") !== encodedSource
      || digestBytes(decoded) !== manifest.source_digest
      || decoded.length !== Number(manifest.source_bytes)) {
      sourceHashMismatches += 1;
      decoded.fill(0);
    } else {
      exactSourceBytes = decoded;
    }
  }
  let provenanceMissing = 0;
  let forbiddenBehaviorInActiveRetrieval = 0;
  for (const item of items) {
    const body = await readEventBody(context.db, item.event_id, {
      actor: { role: "OPERATOR", purpose: "verify bootstrap provenance" },
    });
    const bodyRecord = body !== null && !Array.isArray(body) && typeof body === "object"
      ? body : undefined;
    const rawContent = bodyRecord?.rawContent;
    const historicalMetadata = bodyRecord?.historicalMetadata;
    const historicalDigestMatches = item.historical_metadata_digest === null
      ? historicalMetadata === null
      : historicalMetadata !== null && historicalMetadata !== undefined
        && canonicalContentDigest(historicalMetadata) === item.historical_metadata_digest;
    const expectedResultIds: JsonValue = item.memory_id !== null ? {
      eventId: item.event_id,
      sourceEventId: item.memory_source_event_id,
      memoryId: item.memory_id,
      extractionRunId: item.extraction_run_id,
      consolidationEventId: item.consolidation_event_id,
    } : item.review_queue_id !== null ? {
      eventId: item.event_id,
      reviewQueueId: item.review_queue_id,
    } : { eventId: item.event_id };
    const replayedClassification = typeof rawContent === "string"
      ? classifyImportRecord(item.record_type, rawContent, item.canonical_catalog_id ?? undefined)
      : null;
    const rangeStart = Number(item.source_byte_start);
    const rangeEnd = Number(item.source_byte_end);
    const exactExcerptBytes = exactSourceBytes?.subarray(rangeStart, rangeEnd);
    const bodyByteRange = bodyRecord?.byteRange;
    const bodyByteRangeRecord = bodyByteRange !== null && !Array.isArray(bodyByteRange)
      && typeof bodyByteRange === "object" ? bodyByteRange : undefined;
    const replayedAnnotationDigest = bodyRecord === undefined ? null : canonicalContentDigest({
      canonicalCatalogId: bodyRecord.canonicalCatalogAnnotationId ?? null,
      effectiveFrom: bodyRecord.effectiveFrom ?? null,
      effectiveUntil: bodyRecord.effectiveUntil ?? null,
      excerptRef: bodyRecord.excerptRef ?? null,
      expiresAt: bodyRecord.expiresAt ?? null,
      historicalMetadata: bodyRecord.historicalMetadata ?? null,
      kind: bodyRecord.recordType ?? null,
      observedAt: bodyRecord.observedAt ?? null,
      reviewReason: bodyRecord.reviewReason ?? null,
      reviewer: bodyRecord.reviewer ?? null,
      visibilityScope: bodyRecord.visibilityScope ?? null,
    });
    if (typeof rawContent !== "string" || sha256Digest(rawContent) !== item.item_digest
      || bodyRecord === undefined || Object.keys(bodyRecord).length !== 41
      || !Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd)
      || rangeStart < 0 || rangeEnd <= rangeStart
      || exactExcerptBytes === undefined || exactExcerptBytes.length !== rangeEnd - rangeStart
      || digestBytes(exactExcerptBytes) !== item.excerpt_digest
      || item.excerpt_digest !== item.item_digest
      || exactExcerptBytes.toString("utf8") !== rawContent
      || bodyByteRangeRecord?.start !== rangeStart || bodyByteRangeRecord?.end !== rangeEnd
      || bodyRecord?.excerptDigest !== item.excerpt_digest
      || bodyRecord?.annotationDigest !== item.annotation_digest
      || replayedAnnotationDigest !== item.annotation_digest
      || canonicalContentDigest(body) !== item.body_digest
      || item.body_digest !== item.encrypted_body_digest
      || bodyRecord?.sourceDigest !== item.source_digest
      || bodyRecord?.sourceLocator !== item.source_locator
      || bodyRecord?.sourceNamespace !== item.source_namespace
      || bodyRecord?.sourceType !== item.source_type
      || bodyRecord?.sourceTimestamp !== (item.source_timestamp?.toISOString() ?? null)
      || bodyRecord?.itemDigest !== item.item_digest
      || bodyRecord?.historicalMetadataDigest !== item.historical_metadata_digest
      || !historicalDigestMatches
      || bodyRecord?.importerVersion !== item.importer_version
      || bodyRecord?.parserVersion !== item.parser_version
      || bodyRecord?.recordType !== item.record_type
      || bodyRecord?.lifecycleClass !== item.lifecycle_class
      || bodyRecord?.retrievalMode !== item.retrieval_mode
      || bodyRecord?.freshness !== item.freshness
      || bodyRecord?.visibilityScope !== item.visibility_scope
      || bodyRecord?.observedAt !== (item.observed_at?.toISOString() ?? null)
      || bodyRecord?.expiresAt !== (item.expires_at?.toISOString() ?? null)
      || bodyRecord?.effectiveFrom !== item.effective_from.toISOString()
      || bodyRecord?.effectiveUntil !== (item.effective_until?.toISOString() ?? null)
      || bodyRecord?.classificationRuleId !== item.classification_rule_id
      || bodyRecord?.rulesetVersion !== item.ruleset_version
      || bodyRecord?.schemaVersion !== item.schema_version
      || bodyRecord?.gustavoPolicyVersion !== item.gustavo_policy_version
      || bodyRecord?.canonicalCatalogId !== item.canonical_catalog_id
      || bodyRecord?.canonicalContentDigest !== item.canonical_content_digest
      || bodyRecord?.currentReviewStatus !== item.current_review_status
      || bodyRecord?.currentReviewDecision !== item.current_review_decision
      || bodyRecord?.acceptedDecisionRule !== item.accepted_decision_rule
      || bodyRecord?.freshDecisionEligible !== item.fresh_decision_eligible
      || bodyRecord?.priorItemId !== item.prior_item_id
      || canonicalJson(bodyRecord?.resultIds ?? null) !== canonicalJson(expectedResultIds)
      || bodyRecord?.reviewer !== item.reviewer
      || bodyRecord?.reviewReason !== item.review_reason
      || bodyRecord?.excerptRef !== item.excerpt_ref
      || replayedClassification?.lifecycleClass !== item.lifecycle_class
      || replayedClassification?.retrievalMode !== item.retrieval_mode
      || replayedClassification?.freshness !== item.freshness
      || replayedClassification?.acceptedDecisionRule !== item.accepted_decision_rule
      || replayedClassification?.freshDecisionEligible !== item.fresh_decision_eligible
      || replayedClassification?.ruleId !== item.classification_rule_id) {
      hashMismatches += 1;
    }
    if (typeof rawContent === "string" && item.active
      && containsProhibitedImportedBehavior(rawContent)
      && (item.lifecycle_class !== "PROHIBITED" || item.retrieval_mode !== "AUDIT_ONLY")) {
      forbiddenBehaviorInActiveRetrieval += 1;
    }
    let memoryProjectionMismatch = false;
    if (item.memory_id !== null) {
      const sourceBody = await readEventBody(context.db, item.memory_source_event_id!, {
        actor: { role: "SYSTEM" },
      });
      const sourceRecord = sourceBody !== null && !Array.isArray(sourceBody)
        && typeof sourceBody === "object" ? sourceBody : undefined;
      const consolidationBody = await readEventBody(context.db, item.consolidation_event_id!, {
        actor: { role: "SYSTEM" },
      });
      const consolidationRecord = consolidationBody !== null && !Array.isArray(consolidationBody)
        && typeof consolidationBody === "object" ? consolidationBody : undefined;
      const projectedMemories = Array.isArray(consolidationRecord?.memories)
        ? consolidationRecord.memories : [];
      const projectedMemory = projectedMemories.find((value) => value !== null
        && !Array.isArray(value) && typeof value === "object" && value.id === item.memory_id);
      const projectedRecord = projectedMemory !== null && !Array.isArray(projectedMemory)
        && typeof projectedMemory === "object" ? projectedMemory : undefined;
      const expectedValidTo = item.lifecycle_class === "HISTORICAL"
        ? (item.effective_until ?? item.created_at).toISOString() : null;
      memoryProjectionMismatch = sourceRecord === undefined
        || Object.keys(sourceRecord).length !== 4
        || sourceRecord.itemDigest !== item.item_digest
        || sourceRecord.manifestId !== manifestId
        || sourceRecord.stableLocator !== item.stable_locator
        || sourceRecord.text !== rawContent
        || item.memory_manifest_id !== manifestId
        || item.memory_projection_class !== item.lifecycle_class
        || item.memory_retrieval_profile !== (item.lifecycle_class === "CANONICAL"
          ? "CURRENT_GENERAL" : "HISTORICAL_SIMILARITY")
        || item.extraction_run_id === null
        || item.extraction_scope !== "MAIN_SHARED"
        || item.extraction_source_event_id !== item.memory_source_event_id
        || item.extraction_consolidation_event_id !== item.consolidation_event_id
        || item.extraction_prompt_version !== "import-memory-prompt-v1"
        || item.extraction_model_version !== "deterministic-import-v1"
        || item.extraction_extractor_version !== IMPORTER_VERSION
        || item.extraction_embedding_version !== "import-no-embedding-v1"
        || item.extraction_memory_count !== 1
        || item.extraction_status !== "COMPLETED"
        || item.memory_source_event_type !== "import.memory.source.captured"
        || item.memory_source_event_visibility !== "SHARED"
        || item.memory_source_count !== 1
        || item.memory_valid_from?.toISOString() !== item.effective_from.toISOString()
        || (item.memory_valid_to?.toISOString() ?? null) !== expectedValidTo
        || item.memory_conflict_state !== (item.lifecycle_class === "CANONICAL"
          ? "CURRENT" : "SUPERSEDED")
        || projectedRecord === undefined
        || projectedRecord.text !== rawContent
        || projectedRecord.type !== item.memory_type
        || projectedRecord.scope !== item.memory_scope
        || canonicalJson(projectedRecord.sourceIds ?? null)
          !== canonicalJson([item.memory_source_event_id])
        || projectedRecord.validFrom !== item.effective_from.toISOString()
        || (projectedRecord.validTo ?? null) !== expectedValidTo
        || projectedRecord.conflictState !== item.memory_conflict_state;
    }
    if (!item.source_namespace || !item.source_locator || !item.source_digest
      || !item.importer_version || !item.reviewer || !item.review_reason
      || !item.excerpt_ref || canonicalJson(item.result_ids) !== canonicalJson(expectedResultIds)
      || (item.archive_decision_event_id !== null
        && item.archive_decision_after_verification !== true)
      || memoryProjectionMismatch
      || (item.lifecycle_class === "CANONICAL" && (
        item.memory_id === null || item.memory_type !== "SEMANTIC"
        || item.memory_scope !== "MAIN_SHARED" || item.memory_valid_to !== null
      ))
      || (item.lifecycle_class === "HISTORICAL" && (
        item.memory_id === null || item.memory_type !== "EPISODIC"
        || item.memory_scope !== "MAIN_SHARED" || item.memory_valid_to === null
      ))
      || (item.lifecycle_class === "CANDIDATE" && (
        item.review_queue_id === null || item.review_manifest_id !== manifestId
        || item.review_status !== "PENDING"
      ))
      || (["DEPRECATED", "PROHIBITED"].includes(item.lifecycle_class)
        && (item.memory_id !== null || item.review_queue_id !== null))) {
      provenanceMissing += 1;
    }
  }
  const graph = await context.db.query<{
    id: string;
    aggregate_id: string;
    account_id: string | null;
    type: string;
    actor_type: string;
    actor_id: string;
    visibility: string;
    prompt_version: string | null;
    policy_version: string | null;
    model_version: string | null;
    occurred_at: Date;
    correlation_id: string;
    causation_id: string | null;
    idempotency_key: string;
    request_hash: string;
    integrity_hash: string;
    ingested_sequence: string | number;
    authority_event_id: string | null;
    authority_sequence: string | number | null;
    authority_body_digest: string | null;
    authority_request_hash: string | null;
    authority_integrity_hash: string | null;
    authority_outbox_digest: string | null;
    encrypted_body_digest: string | null;
    topic: string | null;
    payload: { readonly eventId?: string } | null;
  }>(
    `select event.id::text,event.aggregate_id,event.account_id::text,event.type,
            event.actor_type,event.actor_id,event.visibility,
            event.prompt_version,event.policy_version,event.model_version,event.occurred_at,
            event.correlation_id::text,event.causation_id::text,event.idempotency_key,
            event.request_hash,event.integrity_hash,
            event.ingested_sequence::text,
            authority.event_id::text authority_event_id,
            authority.authority_sequence::text,authority.body_digest authority_body_digest,
            authority.event_request_hash authority_request_hash,
            authority.event_integrity_hash authority_integrity_hash,
            authority.outbox_payload_digest authority_outbox_digest,
            body.body_digest encrypted_body_digest,outbox.topic,outbox.payload
       from events event
       left join import_event_authorities authority on authority.event_id=event.id
       left join encrypted_event_bodies body on body.event_id=event.id
       left join transactional_outbox outbox on outbox.event_id=event.id
      where event.aggregate_id=$1 order by event.ingested_sequence,event.id`,
    [`import:${manifestId}`],
  );
  const orphanAuthorityRows = graph.filter((row) => row.authority_event_id === null
    || row.encrypted_body_digest === null || row.topic === null).length;
  let outboxMismatches = graph.filter((row) => row.topic !== row.type
    || row.actor_type !== "OPERATOR" || row.actor_id !== "gustavo-importer"
    || row.aggregate_id !== `import:${manifestId}` || row.account_id !== null
    || row.visibility !== "OPERATOR" || row.prompt_version !== IMPORTER_VERSION
    || row.policy_version !== GUSTAVO_POLICY_VERSION
    || row.model_version !== null || row.correlation_id !== row.id
    || !row.idempotency_key.endsWith(`:${row.encrypted_body_digest}`)
    || row.payload?.eventId !== row.id
    || row.authority_request_hash !== row.request_hash
    || row.authority_integrity_hash !== row.integrity_hash
    || row.authority_outbox_digest !== canonicalContentDigest(row.payload)
    || row.authority_body_digest !== row.encrypted_body_digest
    || Number(row.authority_sequence) !== Number(row.ingested_sequence)).length;
  for (const row of graph) {
    const body = await readEventBody(context.db, row.id, {
      actor: { role: "OPERATOR", purpose: "verify bootstrap event graph" },
    });
    const expectedRequestHash = canonicalContentDigest(eventRequestDocument({
      aggregateId: row.aggregate_id,
      body,
      causationId: row.causation_id,
      createdAt: row.occurred_at,
      eventId: row.id,
      idempotencyKey: row.idempotency_key,
      type: row.type,
    }));
    const expectedIntegrityHash = canonicalContentDigest(eventIntegrityDocument({
      aggregateId: row.aggregate_id,
      body,
      causationId: row.causation_id,
      createdAt: row.occurred_at,
      eventId: row.id,
      type: row.type,
    }));
    if (canonicalContentDigest(body) !== row.encrypted_body_digest
      || expectedRequestHash !== row.request_hash
      || expectedIntegrityHash !== row.integrity_hash) {
      outboxMismatches += 1;
    }
  }
  const lifecycle = await context.db.query<{
    action: string;
    item_id: string;
    event_id: string;
    command_id: string | null;
    actor_purpose: string | null;
    request_digest: string | null;
    active: boolean;
    retrieval_mode: RetrievalMode;
    reviewer: string;
    reason: string;
    review_decision: string | null;
    importer_version: string;
    ruleset_version: string;
    body_digest: string;
    authority_sequence: string | number;
  }>(
    `select lifecycle.action,lifecycle.item_id::text,lifecycle.event_id::text,
            lifecycle.command_id::text,lifecycle.active,lifecycle.retrieval_mode,
            lifecycle.reviewer,lifecycle.reason,lifecycle.review_decision,
            lifecycle.importer_version,lifecycle.ruleset_version,lifecycle.body_digest,
            command.actor_purpose,command.request_digest,
            authority_sequence::text
       from import_item_lifecycle_events lifecycle
       left join import_lifecycle_commands command on command.id=lifecycle.command_id
      where lifecycle.manifest_id=$1
      order by lifecycle.authority_sequence,lifecycle.id`,
    [manifestId],
  );
  for (const transition of lifecycle) {
    const body = await readEventBody(context.db, transition.event_id, {
      actor: { role: "OPERATOR", purpose: "verify bootstrap lifecycle" },
    });
    const record = body !== null && !Array.isArray(body) && typeof body === "object"
      ? body : undefined;
    if (canonicalContentDigest(body) !== transition.body_digest
      || record === undefined
      || Object.keys(record).length !== (transition.command_id === null ? 11 : 13)
      || record?.action !== transition.action
      || record?.active !== transition.active
      || record?.actorPurpose !== (transition.actor_purpose ?? undefined)
      || record?.commandId !== transition.command_id
      || record?.importerVersion !== transition.importer_version
      || record?.itemId !== transition.item_id
      || record?.manifestId !== manifestId
      || record?.reason !== transition.reason
      || record?.requestDigest !== (transition.request_digest ?? undefined)
      || record?.retrievalMode !== transition.retrieval_mode
      || record?.reviewDecision !== transition.review_decision
      || record?.reviewer !== transition.reviewer
      || record?.rulesetVersion !== transition.ruleset_version) {
      hashMismatches += 1;
    }
  }
  const actualClassifications = normalizedClassifications(items.reduce<
    Partial<Record<LifecycleClass, number>>
  >((counts, item) => {
    counts[item.lifecycle_class] = (counts[item.lifecycle_class] ?? 0) + 1;
    return counts;
  }, {}));
  const orderedRanges = [...items].sort((left, right) => Number(left.source_byte_start)
    - Number(right.source_byte_start) || Number(left.source_byte_end) - Number(right.source_byte_end));
  const excerptRangesInvalid = orderedRanges.some((item, index) => {
    const start = Number(item.source_byte_start);
    const end = Number(item.source_byte_end);
    return !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > (exactSourceBytes?.length ?? -1)
      || (index > 0 && start < Number(orderedRanges[index - 1]!.source_byte_end));
  });
  const expectedAuthorityManifest: JsonValue = {
    classifications: actualClassifications,
    counts: {
      bytes: exactSourceBytes?.length ?? -1,
      duplicates: 0,
      parsed: items.length,
      rejected: 0,
      sources: 1,
    },
    importerVersion: manifest.importer_version,
    gustavoPolicyVersion: manifest.gustavo_policy_version,
    items: items.map((item) => ({
      annotationDigest: item.annotation_digest,
      byteRange: { end: Number(item.source_byte_end), start: Number(item.source_byte_start) },
      digest: item.item_digest,
      excerptDigest: item.excerpt_digest,
      freshness: item.freshness,
      historicalMetadataDigest: item.historical_metadata_digest,
      lifecycleClass: item.lifecycle_class,
      locator: item.stable_locator,
      recordType: item.record_type,
      retrievalMode: item.retrieval_mode,
    })),
    parserVersion: manifest.parser_version,
    projectionStatus: "VERIFIED",
    rulesetVersion: manifest.ruleset_version,
    schemaVersion: manifest.schema_version,
    source: {
      digest: manifest.source_digest,
      locator: manifest.stable_locator,
      namespace: manifest.source_namespace,
      sourceTimestamp: manifest.source_timestamp?.toISOString() ?? null,
      type: manifest.source_type,
    },
  };
  const manifestEventSequence = Number(graph.find((row) => row.id === manifest.event_id)
    ?.ingested_sequence);
  const initialGraph = graph.filter((row) => Number(row.ingested_sequence)
    <= Number(manifest.event_high_water));
  const initialActivationCount = lifecycle.filter((row) => row.action === "ACTIVATED"
    && Number(row.authority_sequence) <= Number(manifest.event_high_water)).length;
  const manifestMismatches = [
    manifest.source_count !== 1,
    Number(manifest.source_bytes) !== (exactSourceBytes?.length ?? -1),
    manifest.parsed_count !== items.length,
    manifest.rejected_count !== 0,
    manifest.duplicate_count !== 0,
    canonicalJson(manifest.classification_counts) !== canonicalJson(actualClassifications),
    manifest.projection_status !== "VERIFIED",
    Number(manifest.event_high_water) !== manifestEventSequence,
    initialGraph.length !== 1 + (items.length * 2),
    initialActivationCount !== items.length,
    excerptRangesInvalid,
    canonicalJson(manifest.authority_manifest) !== canonicalJson(expectedAuthorityManifest),
  ].filter(Boolean).length;
  const prohibitedInActiveRetrieval = items.filter((item) => item.active
    && item.lifecycle_class === "PROHIBITED" && item.retrieval_mode !== "AUDIT_ONLY").length;
  const deprecatedInActiveRetrieval = items.filter((item) => item.active
    && item.lifecycle_class === "DEPRECATED" && item.retrieval_mode !== "AUDIT_ONLY").length;
  const historicalInFreshDecisionGates = items.filter((item) => item.active
    && item.lifecycle_class === "HISTORICAL" && item.fresh_decision_eligible).length;
  const candidateInAcceptedRules = items.filter((item) => item.active
    && item.lifecycle_class === "CANDIDATE" && item.accepted_decision_rule).length;
  const deterministicReplay = manifest.import_key === deterministicImportKey({
    namespace: manifest.source_namespace,
    stableLocator: manifest.stable_locator,
    digest: manifest.source_digest,
    importerVersion: manifest.importer_version,
  }) && items.every((item) => item.import_key === deterministicImportKey({
    namespace: item.source_namespace,
    stableLocator: item.stable_locator,
    digest: item.source_digest,
    importerVersion: item.importer_version,
  }));
  const activeItems = items.filter((item) => item.active).length;
  const valid = hashMismatches === 0 && sourceHashMismatches === 0
    && manifestMismatches === 0 && outboxMismatches === 0
    && provenanceMissing === 0 && orphanAuthorityRows === 0
    && prohibitedInActiveRetrieval === 0 && deprecatedInActiveRetrieval === 0
    && historicalInFreshDecisionGates === 0 && candidateInAcceptedRules === 0
    && forbiddenBehaviorInActiveRetrieval === 0 && deterministicReplay;
  const receipt = await persistVerificationReceipt(context, {
    manifestId,
    manifestEventId: manifest.event_id,
    manifestDigest: manifest.manifest_digest,
    manifestEventHighWater: Number(manifest.event_high_water),
    sourceCount: 1,
    sourceBytes: exactSourceBytes?.length ?? 0,
    parsedCount: items.length,
    rejectedCount: 0,
    duplicateCount: 0,
    classificationCounts: actualClassifications,
    projectionStatus: manifest.projection_status,
    provenanceCount: Math.max(0, items.length - provenanceMissing),
    bodyCount: initialGraph.filter((row) => row.encrypted_body_digest !== null).length,
    outboxCount: initialGraph.filter((row) => row.topic === row.type
      && row.payload?.eventId === row.id).length,
    safety: {
      candidateInAcceptedRules,
      deprecatedInActiveRetrieval,
      forbiddenBehaviorInActiveRetrieval,
      historicalInFreshDecisionGates,
      prohibitedInActiveRetrieval,
    },
    deterministicReplay,
    valid,
  });
  let archiveReceipt: BootstrapArchiveReceipt | undefined;
  if (options.archiveReceiptKey !== undefined) {
    if (!valid) throw new Error("IMPORT_VERIFICATION_FAILED");
    const eligibleItem = items.length === 1 ? items[0]! : null;
    const eligible = eligibleItem !== null
      && (eligibleItem.lifecycle_class === "DEPRECATED"
        || eligibleItem.lifecycle_class === "HISTORICAL")
      && Number(eligibleItem.source_byte_start) === 0
      && Number(eligibleItem.source_byte_end) === Number(manifest.source_bytes)
      && eligibleItem.source_locator === manifest.stable_locator
      && eligibleItem.source_digest === manifest.source_digest
      && eligibleItem.archive_decision_event_id !== null
      && eligibleItem.archive_decision_after_verification === true;
    const sources = eligible ? [{
      locator: manifest.stable_locator,
      digest: `sha256:${manifest.source_digest}`,
      lifecycleClass: eligibleItem.lifecycle_class as "DEPRECATED" | "HISTORICAL",
      archiveDecision: "ARCHIVE_AS_SUPERSEDED_RAW" as const,
      archiveDecisionEventId: eligibleItem.archive_decision_event_id!,
      itemIds: Object.freeze([eligibleItem.id]),
    }] : [];
    archiveReceipt = sealBootstrapArchiveTransportReceipt({
      format: "gustavo-bootstrap-archive-receipt-v1",
      manifestId,
      manifestDigest: manifest.manifest_digest,
      verificationReceiptId: receipt.receiptId,
      verificationDigest: receipt.receiptDigest,
      sources: Object.freeze(sources),
    }, options.archiveReceiptKey);
  }
  exactSourceBytes?.fill(0);
  return Object.freeze({
    valid,
    activeItems,
    hashMismatches,
    sourceHashMismatches,
    manifestMismatches,
    outboxMismatches,
    provenanceMissing,
    orphanAuthorityRows,
    prohibitedInActiveRetrieval,
    deprecatedInActiveRetrieval,
    historicalInFreshDecisionGates,
    candidateInAcceptedRules,
    forbiddenBehaviorInActiveRetrieval,
    deterministicReplay,
    ...receipt,
    ...(archiveReceipt === undefined ? {} : { archiveReceipt }),
  });
}
