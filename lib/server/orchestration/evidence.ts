export const EVIDENCE_REFERENCE_KINDS = [
  "SOURCE_EVENT",
  "MARKET_EVENT",
  "COMMENTARY",
  "PROPOSAL",
] as const;

export type EvidenceReferenceKind = (typeof EVIDENCE_REFERENCE_KINDS)[number];

/** Provider-neutral reference shared by commentary, proposals, and evaluation. */
export interface EvidenceReference {
  readonly kind: EvidenceReferenceKind;
  readonly referenceId: string;
}

// MARKET_EVENT is reserved for T11's durable market-record resolver and fails
// closed in T9. SOURCE_EVENT, COMMENTARY, and PROPOSAL must resolve against
// authorized PostgreSQL records before they may be persisted as evidence.

export type EvidenceReferenceId = EvidenceReference["referenceId"];

const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:./_-]{0,199}$/;
const kindSet = new Set<string>(EVIDENCE_REFERENCE_KINDS);

function validateReference(value: unknown): EvidenceReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EVIDENCE_REFERENCE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "kind,referenceId"
    || typeof record.kind !== "string"
    || !kindSet.has(record.kind)
    || typeof record.referenceId !== "string"
    || !REFERENCE_ID_PATTERN.test(record.referenceId)
  ) {
    throw new Error("EVIDENCE_REFERENCE_INVALID");
  }
  return Object.freeze({
    kind: record.kind as EvidenceReferenceKind,
    referenceId: record.referenceId,
  });
}

export function canonicalEvidenceReferences(
  value: unknown,
  options: { readonly max: number; readonly allowEmpty: boolean },
): readonly EvidenceReference[] {
  if (!Array.isArray(value) || value.length > options.max || (!options.allowEmpty && value.length === 0)) {
    throw new Error("EVIDENCE_REFERENCES_INVALID");
  }
  const canonical = new Map<string, EvidenceReference>();
  for (const item of value) {
    const reference = validateReference(item);
    canonical.set(`${reference.kind}:${reference.referenceId}`, reference);
  }
  return Object.freeze(
    [...canonical.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.referenceId.localeCompare(right.referenceId)),
  );
}
