import { types as utilTypes } from "node:util";

const MAX_CLAIMS = 101;
const MAX_ALIASES = 500;
const MAX_SOURCES = 500;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export interface TemporalMemoryClaim {
  readonly id: string;
  readonly entityId: string;
  readonly predicate: string;
  readonly value: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly approved: boolean;
  readonly sourceIds: readonly string[];
}

export interface MemoryEntityAlias {
  readonly alias: string;
  readonly entityId: string;
  readonly validFrom: string;
  readonly validTo?: string;
}

export interface ReconciledMemoryClaim extends Omit<TemporalMemoryClaim, "validTo"> {
  readonly validTo: string | null;
}

export interface MemoryConflictEdge {
  readonly from: string;
  readonly type: "CONTRADICTS" | "SUPERSEDES";
  readonly to: string;
}

export interface ExplicitMemoryConflict {
  readonly newer: string;
  readonly older: string;
  readonly preferred: string;
  readonly sourceIds: readonly string[];
}

export interface MemoryReconciliationResult {
  readonly current: ReconciledMemoryClaim;
  readonly preserved: readonly ReconciledMemoryClaim[];
  readonly edges: readonly MemoryConflictEdge[];
  readonly conflicts: readonly ExplicitMemoryConflict[];
}

interface ReconcileOptions {
  readonly aliases?: readonly MemoryEntityAlias[];
}

function invalid(code = "MEMORY_CONFLICT_INPUT_INVALID"): never {
  throw new Error(code);
}

function plainRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (keys.length < required.length || keys.length > allowed.size
      || keys.some((key) => typeof key !== "string" || !allowed.has(key))) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of required) if (!keys.includes(key)) return invalid();
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined || descriptor.set !== undefined) return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MEMORY_")) throw error;
    return invalid();
  }
}

function denseArray(value: unknown, maximum: number, limitCode: string): readonly unknown[] {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0) return invalid();
    if (length > maximum) return invalid(limitCode);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined || descriptor.set !== undefined) return invalid();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MEMORY_")) throw error;
    return invalid();
  }
}

function boundedText(value: unknown, maximum = 240): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}

function timestamp(value: unknown): string {
  const captured = boundedText(value, 24);
  if (!TIMESTAMP_PATTERN.test(captured)) return invalid();
  const parsed = new Date(captured);
  if (!Number.isFinite(parsed.getTime())) return invalid();
  const canonical = parsed.toISOString();
  const expected = captured.includes(".") ? captured : `${captured.slice(0, -1)}.000Z`;
  if (canonical !== expected) return invalid();
  return canonical;
}

function normalizedAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function captureAlias(value: unknown): MemoryEntityAlias {
  const record = plainRecord(value, ["alias", "entityId", "validFrom"], ["validTo"]);
  const validFrom = timestamp(record.validFrom);
  const validTo = record.validTo === undefined ? undefined : timestamp(record.validTo);
  if (validTo !== undefined && validTo <= validFrom) {
    invalid("MEMORY_ALIAS_VALIDITY_INVALID");
  }
  return Object.freeze({
    alias: boundedText(record.alias, 240),
    entityId: boundedText(record.entityId, 240),
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
  });
}

function captureAliases(value: unknown): readonly MemoryEntityAlias[] {
  const aliases = denseArray(value, MAX_ALIASES, "MEMORY_ALIAS_LIMIT_EXCEEDED")
    .map(captureAlias);
  return Object.freeze(aliases);
}

export function resolveMemoryEntityAlias(
  rawReference: unknown,
  rawAliases: unknown,
  rawAt: unknown,
): string {
  if (typeof rawReference !== "string" || rawReference.length > 240
    || /[\u0000-\u001f\u007f]/u.test(rawReference)) return invalid();
  const reference = rawReference.trim();
  if (reference.length === 0) return invalid();
  const aliases = captureAliases(rawAliases);
  const at = timestamp(rawAt);
  const normalized = normalizedAlias(reference);
  const matches = aliases.filter((alias) => normalizedAlias(alias.alias) === normalized
    && alias.validFrom <= at && (alias.validTo === undefined || at < alias.validTo));
  const entities = [...new Set(matches.map(({ entityId }) => entityId))].sort();
  if (entities.length > 1) invalid("MEMORY_ALIAS_AMBIGUOUS");
  return entities[0] ?? reference;
}

function captureClaim(value: unknown, aliases: readonly MemoryEntityAlias[]): ReconciledMemoryClaim {
  const record = plainRecord(
    value,
    ["id", "entityId", "predicate", "value", "validFrom", "approved", "sourceIds"],
    ["validTo"],
  );
  const validFrom = timestamp(record.validFrom);
  const validTo = record.validTo === undefined ? null : timestamp(record.validTo);
  if (validTo !== null && validTo <= validFrom) {
    invalid("MEMORY_CONFLICT_VALIDITY_INVALID");
  }
  if (typeof record.approved !== "boolean") return invalid();
  const sources = denseArray(record.sourceIds, MAX_SOURCES, "MEMORY_CONFLICT_SOURCE_LIMIT_EXCEEDED")
    .map((sourceId) => boundedText(sourceId, 240));
  if (sources.length === 0) invalid("MEMORY_CONFLICT_SOURCE_REQUIRED");
  if (new Set(sources).size !== sources.length) invalid("MEMORY_CONFLICT_SOURCE_DUPLICATE");
  const originalEntity = boundedText(record.entityId, 240);
  const entityId = aliases.length === 0
    ? originalEntity
    : resolveMemoryEntityAlias(originalEntity, aliases, validFrom);
  return Object.freeze({
    id: boundedText(record.id, 240),
    entityId,
    predicate: boundedText(record.predicate, 240),
    value: boundedText(record.value, 2_000),
    validFrom,
    validTo,
    approved: record.approved,
    sourceIds: Object.freeze([...sources]),
  });
}

function intervalsOverlap(left: ReconciledMemoryClaim, right: ReconciledMemoryClaim): boolean {
  const end = (value: string | null) => value ?? "9999-12-31T23:59:59.999Z";
  return left.validFrom < end(right.validTo) && right.validFrom < end(left.validTo);
}

function newerFirst(left: ReconciledMemoryClaim, right: ReconciledMemoryClaim): number {
  return right.validFrom.localeCompare(left.validFrom) || right.id.localeCompare(left.id);
}

function selectCurrent(claims: readonly ReconciledMemoryClaim[]): ReconciledMemoryClaim {
  const open = claims.filter(({ validTo }) => validTo === null);
  const approvedOpen = open.filter(({ approved }) => approved);
  const approved = claims.filter(({ approved: isApproved }) => isApproved);
  return [...(approvedOpen.length > 0 ? approvedOpen
    : open.length > 0 ? open
      : approved.length > 0 ? approved : claims)].sort(newerFirst)[0]!;
}

export function reconcileMemories(
  rawClaims: unknown,
  rawOptions: unknown = {},
): MemoryReconciliationResult {
  const options = plainRecord(rawOptions, [], ["aliases"]);
  const aliases = options.aliases === undefined ? Object.freeze([]) : captureAliases(options.aliases);
  const claims = denseArray(rawClaims, MAX_CLAIMS, "MEMORY_CONFLICT_LIMIT_EXCEEDED")
    .map((claim) => captureClaim(claim, aliases));
  if (claims.length === 0) invalid("MEMORY_CONFLICT_CLAIM_REQUIRED");
  if (new Set(claims.map(({ id }) => id)).size !== claims.length) {
    invalid("MEMORY_CONFLICT_ID_DUPLICATE");
  }
  const group = `${claims[0]!.entityId}\u0000${claims[0]!.predicate}`;
  if (claims.some((claim) => `${claim.entityId}\u0000${claim.predicate}` !== group)) {
    invalid("MEMORY_CONFLICT_GROUP_MISMATCH");
  }
  const preserved = Object.freeze([...claims].sort((left, right) => (
    left.validFrom.localeCompare(right.validFrom) || left.id.localeCompare(right.id)
  )));
  const current = selectCurrent(preserved);
  const edges: MemoryConflictEdge[] = [];
  const conflicts: ExplicitMemoryConflict[] = [];
  for (let olderIndex = 0; olderIndex < preserved.length; olderIndex += 1) {
    for (let newerIndex = olderIndex + 1; newerIndex < preserved.length; newerIndex += 1) {
      const older = preserved[olderIndex]!;
      const newer = preserved[newerIndex]!;
      if (older.value === newer.value) continue;
      if (intervalsOverlap(older, newer)) {
        edges.push(Object.freeze({ from: newer.id, type: "CONTRADICTS", to: older.id }));
        const preferred = current.id === older.id || current.id === newer.id
          ? current : selectCurrent([older, newer]);
        conflicts.push(Object.freeze({
          newer: newer.id,
          older: older.id,
          preferred: preferred.id,
          sourceIds: Object.freeze([...new Set([...older.sourceIds, ...newer.sourceIds])].sort()),
        }));
      }
      if (current.id === newer.id && newer.approved) {
        edges.push(Object.freeze({ from: newer.id, type: "SUPERSEDES", to: older.id }));
      }
    }
  }
  return Object.freeze({
    current,
    preserved,
    edges: Object.freeze(edges),
    conflicts: Object.freeze(conflicts),
  });
}
