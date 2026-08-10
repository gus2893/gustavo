import type { EventActor, EventDatabase } from "../events/types";

export const THOUGHT_TYPES = Object.freeze([
  "MAIN_POSITION", "MAIN_BROADCAST", "NODE_REPLY_SUMMARY", "NODE_PROPOSAL",
  "HYPOTHESIS", "EVIDENCE", "COUNTEREVIDENCE", "UNCERTAINTY", "OPEN_QUESTION",
  "EVALUATION", "DECISION", "REJECTION_REASON", "CORRECTION", "LESSON",
  "PAPER_INTENT_RATIONALE", "RISK_GATE_RESULT", "STAGE_REVIEW", "OUTCOME_REVIEW",
] as const);

export const THOUGHT_SCOPES = Object.freeze([
  "PUBLIC", "PRIVATE_ACCOUNT", "MAIN_SHARED", "CHALLENGE_SHARED", "OPERATOR",
] as const);

export const THOUGHT_UNCERTAINTIES = Object.freeze([
  "LOW", "MEDIUM", "HIGH", "UNKNOWN",
] as const);

export const THOUGHT_STATE_KINDS = Object.freeze([
  "MAIN_STATE", "NODE_STATE", "CHALLENGE_STATE", "CONVERSATION_STATE", "IMPORT_STATE",
] as const);

export type ThoughtType = typeof THOUGHT_TYPES[number];
export type ThoughtScope = typeof THOUGHT_SCOPES[number];
export type ThoughtUncertainty = typeof THOUGHT_UNCERTAINTIES[number];
export type ThoughtStateKind = typeof THOUGHT_STATE_KINDS[number];
export type ThoughtReferenceKind = "EVENT" | "MARKET_OBSERVATION" | "THOUGHT";

export interface ThoughtWriterContext {
  readonly db: EventDatabase;
  readonly actor: EventActor;
}

export interface ThoughtClaimInput {
  readonly text: string;
  readonly confidence?: string;
}

export interface ThoughtReferenceInput {
  readonly kind: ThoughtReferenceKind;
  readonly id: string;
}

export interface ThoughtStateReference {
  readonly kind: ThoughtStateKind;
  readonly id: string;
  readonly version: string;
}

export interface RecordDecisionThoughtInput {
  readonly aggregateId: string;
  readonly accountId?: string;
  readonly type: ThoughtType;
  readonly scope: ThoughtScope;
  readonly rationale: string;
  readonly claims?: readonly ThoughtClaimInput[];
  readonly evidence?: readonly ThoughtReferenceInput[];
  readonly counterevidence?: readonly ThoughtReferenceInput[];
  readonly sourceEventIds: readonly string[];
  readonly stateReference: ThoughtStateReference;
  readonly uncertainty: ThoughtUncertainty;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly supersedesThoughtId?: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

export interface StoredThoughtRecord {
  readonly id: string;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly accountId: string | null;
  readonly type: ThoughtType;
  readonly actor: EventActor;
  readonly scope: ThoughtScope;
  readonly uncertainty: ThoughtUncertainty;
  readonly stateReference: ThoughtStateReference;
  readonly createdAt: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly supersedesThoughtId: string | null;
}
