import { sha256Digest } from "../events/integrity";

export const IMPORTER_VERSION = "bootstrap-importer-v1";
export const CLASSIFICATION_RULESET_VERSION = "classification-rules-v1";
export const CANONICAL_CATALOG_VERSION = "gustavo-canonical-catalog-v1";

export const IMPORT_LIMITS = Object.freeze({
  items: 100,
  locatorBytes: 1_024,
  namespaceBytes: 128,
  itemTextBytes: 1_048_576,
  sourceBytes: 10_485_760,
});

export type LifecycleClass =
  | "CANONICAL"
  | "CANDIDATE"
  | "HISTORICAL"
  | "DEPRECATED"
  | "PROHIBITED";

export type RetrievalMode =
  | "GENERAL"
  | "OPERATOR_REVIEW"
  | "SIMILARITY_ONLY"
  | "AUDIT_ONLY";

export type ImportFreshness = "CURRENT" | "HISTORICAL" | "NOT_APPLICABLE";

export type ImportRecordKind =
  | "CURRENT_GUSTAVO_BOUNDARY"
  | "STRUCTURAL_METHOD"
  | "DATED_MARKET_EPISODE"
  | "SUPERSEDED_WORKFLOW"
  | "EXECUTION_WORKFLOW"
  | "CFT_MATERIAL"
  | "OPERATOR_CORRECTION";

export interface Classification {
  readonly lifecycleClass: LifecycleClass;
  readonly retrievalMode: RetrievalMode;
  readonly acceptedDecisionRule: boolean;
  readonly freshDecisionEligible: boolean;
  readonly freshness: ImportFreshness;
  readonly ruleId: string;
  readonly rulesetVersion: typeof CLASSIFICATION_RULESET_VERSION;
}

interface ClassificationRule extends Classification {
  readonly kinds: readonly ImportRecordKind[];
}

export interface CanonicalCatalogEntry {
  readonly id: string;
  readonly contentDigest: string;
  readonly schemaVersion: string;
  readonly gustavoPolicyVersion: string;
}

/** Immutable, reviewed canonical entries. The digest is over the exact UTF-8 item text. */
export const CANONICAL_CATALOG: readonly CanonicalCatalogEntry[] = Object.freeze([
  Object.freeze({
    id: "private-node-authorization-boundary-v1",
    contentDigest: "d9058b7bb63949ef3339b002c7067fdf1c1b7969df78e4d1726f0412f70d896f",
    schemaVersion: "import-item-schema-v1",
    gustavoPolicyVersion: "gustavo-policy-v1",
  }),
]);

const CANONICAL_CATALOG_BY_ID = new Map(CANONICAL_CATALOG.map((entry) => [entry.id, entry]));

export function matchingCanonicalCatalogEntry(
  id: string | undefined,
  text: string,
): CanonicalCatalogEntry | null {
  const entry = id === undefined ? undefined : CANONICAL_CATALOG_BY_ID.get(id);
  return entry && sha256Digest(text) === entry.contentDigest ? entry : null;
}

/**
 * Fixed, versioned data rules. Imported prose is deliberately never parsed as
 * code or used to select a lifecycle class.
 */
export const CLASSIFICATION_RULES: readonly ClassificationRule[] = Object.freeze([
  Object.freeze({
    kinds: Object.freeze(["CURRENT_GUSTAVO_BOUNDARY"] as const),
    lifecycleClass: "CANONICAL",
    retrievalMode: "GENERAL",
    acceptedDecisionRule: true,
    freshDecisionEligible: true,
    freshness: "CURRENT",
    ruleId: "approved-current-boundary",
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
  }),
  Object.freeze({
    kinds: Object.freeze(["STRUCTURAL_METHOD", "OPERATOR_CORRECTION"] as const),
    lifecycleClass: "CANDIDATE",
    retrievalMode: "OPERATOR_REVIEW",
    acceptedDecisionRule: false,
    freshDecisionEligible: false,
    freshness: "NOT_APPLICABLE",
    ruleId: "method-awaits-review",
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
  }),
  Object.freeze({
    kinds: Object.freeze(["DATED_MARKET_EPISODE"] as const),
    lifecycleClass: "HISTORICAL",
    retrievalMode: "SIMILARITY_ONLY",
    acceptedDecisionRule: false,
    freshDecisionEligible: false,
    freshness: "HISTORICAL",
    ruleId: "dated-market-evidence",
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
  }),
  Object.freeze({
    kinds: Object.freeze(["SUPERSEDED_WORKFLOW"] as const),
    lifecycleClass: "DEPRECATED",
    retrievalMode: "AUDIT_ONLY",
    acceptedDecisionRule: false,
    freshDecisionEligible: false,
    freshness: "NOT_APPLICABLE",
    ruleId: "superseded-audit-only",
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
  }),
  Object.freeze({
    kinds: Object.freeze(["EXECUTION_WORKFLOW", "CFT_MATERIAL"] as const),
    lifecycleClass: "PROHIBITED",
    retrievalMode: "AUDIT_ONLY",
    acceptedDecisionRule: false,
    freshDecisionEligible: false,
    freshness: "NOT_APPLICABLE",
    ruleId: "execution-material-prohibited",
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
  }),
]);

const CLASSIFICATION_BY_KIND = new Map(
  CLASSIFICATION_RULES.flatMap((rule) => rule.kinds.map((kind) => [kind, rule] as const)),
);

const PROHIBITED_CONTENT_RULES = Object.freeze([
  /\bexternal\s+execution\b/i,
  /\bexecution\s+inbox\b/i,
  /\breal[-\s]+order(?:\s+routing)?\b/i,
  /\blive[-\s]+(?:stock[-\s]+)?orders?\b/i,
  /\b(?:send|submit|place|route|execute|export)\s+(?:a\s+|the\s+)?(?:live\s+|real\s+)?(?:stock\s+|crypto\s+|market\s+|limit\s+|stop\s+)?orders?\b/i,
  /\b(?:connect|call|invoke|use)\s+(?:to\s+)?(?:the\s+)?(?:alpaca|broker(?:age)?)\s+api\b/i,
  /\b(?:broker(?:age)?|trading|execution)\s+api\b/i,
  /\bapi\s+(?:broker|execution|order|trading)\b/i,
  /\b(?:alpaca|interactive[-\s]+brokers?|ibkr)\s+(?:api|endpoint|credentials?)\b/i,
  /\b(?:api|broker(?:age)?)\s+(?:key|token|secret|credentials?|endpoint)s?\b/i,
  /\b(?:credentialed\s+)?(?:broker|execution|order|trading)\s+endpoints?\b/i,
  /\bcredentialed\s+(?:api\s+)?(?:broker|execution|trading\s+)?endpoints?\b/i,
  /\bexport\s+(?:broker[-\s]+style\s+|broker\s+)?(?:payloads?|files?)\b/i,
  /\bbroker[-\s]+style\s+export\s+files?\b/i,
  /\b(?:use\s+)?(?:the\s+)?broker(?:age)?\s+to\s+(?:execute|export|route|send)\s+trades?\b/i,
  /\b(?:send|route|export)\s+(?:(?:[a-z0-9'-]+)\s+){0,4}trades?\s+(?:to|through|via)\s+(?:an?\s+|the\s+)?(?:external\s+)?(?:alpaca|broker(?:age)?|endpoints?)\b/i,
  /\bconnect\s+(?:api\s+)?credentials?\s+(?:to|with)\s+(?:the\s+)?broker(?:age)?\b/i,
  /\b(?:broker|prop(?:-firm)?)\s+credentials?\b/i,
  /\bcopy[-\s]+trad(?:e|ing)\b/i,
  /(?:^|[^a-z0-9])cft(?:[^a-z0-9]|$)/i,
] as const);

export function classifyImportKind(kind: string): Classification {
  const rule = CLASSIFICATION_BY_KIND.get(kind as ImportRecordKind);
  if (!rule) throw new Error("IMPORT_RECORD_KIND_UNSUPPORTED");
  return Object.freeze({
    lifecycleClass: rule.lifecycleClass,
    retrievalMode: rule.retrievalMode,
    acceptedDecisionRule: rule.acceptedDecisionRule,
    freshDecisionEligible: rule.freshDecisionEligible,
    freshness: rule.freshness,
    ruleId: rule.ruleId,
    rulesetVersion: rule.rulesetVersion,
  });
}

/** Treats known execution behavior as prohibited regardless of a caller label. */
export function classifyImportRecord(
  kind: string,
  text: string,
  canonicalCatalogId?: string,
): Classification {
  if (PROHIBITED_CONTENT_RULES.some((pattern) => pattern.test(text))) {
    return Object.freeze({
      lifecycleClass: "PROHIBITED",
      retrievalMode: "AUDIT_ONLY",
      acceptedDecisionRule: false,
      freshDecisionEligible: false,
      freshness: "NOT_APPLICABLE",
      ruleId: "content-execution-behavior-prohibited",
      rulesetVersion: CLASSIFICATION_RULESET_VERSION,
    });
  }
  if (kind === "CURRENT_GUSTAVO_BOUNDARY") {
    if (!matchingCanonicalCatalogEntry(canonicalCatalogId, text)) {
      return Object.freeze({
        lifecycleClass: "CANDIDATE",
        retrievalMode: "OPERATOR_REVIEW",
        acceptedDecisionRule: false,
        freshDecisionEligible: false,
        freshness: "NOT_APPLICABLE",
        ruleId: "canonical-catalog-match-required",
        rulesetVersion: CLASSIFICATION_RULESET_VERSION,
      });
    }
  }
  return classifyImportKind(kind);
}

export function containsProhibitedImportedBehavior(text: string): boolean {
  return PROHIBITED_CONTENT_RULES.some((pattern) => pattern.test(text));
}

export function validateCanonicalReview(input: {
  readonly classification: Classification;
  readonly reviewer?: string;
  readonly reviewReason?: string;
}): void {
  if (input.classification.lifecycleClass !== "CANONICAL") return;
  if (!input.reviewer?.trim() || !input.reviewReason?.trim()) {
    throw new Error("CANONICAL_REVIEW_REQUIRED");
  }
}
