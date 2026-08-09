import type {
  EventDatabase,
} from "../events/types";

export const NODE_REPLY_MODES = [
  "MAIN_DEFAULT",
  "NODE_EXPLORE",
  "PROPOSAL_UPSTREAM",
] as const;

export type NodeReplyMode = (typeof NODE_REPLY_MODES)[number];

export const NODE_ROUTING_REASONS = [
  "MAIN_COVERED",
  "LOW_CONFIDENCE",
  "CONFLICTING_CLASSIFICATION",
  "UNRESOLVED_CONTRADICTION",
  "CLARIFICATION_REQUIRED",
  "MATERIAL_IMPROVEMENT",
] as const;

export type NodeRoutingReason = (typeof NODE_ROUTING_REASONS)[number];

export type NodeResponseContract =
  | {
      readonly canonical: true;
      readonly authority: "MAIN";
      readonly label: "MAIN POSITION";
    }
  | {
      readonly canonical: false;
      readonly authority: "NODE";
      readonly label:
        | "NODE EXPLORATION — NOT AN ACCEPTED MAIN POSITION"
        | "NODE PROPOSAL — PENDING MAIN REVIEW";
    };

/**
 * Semantic classification fields can be supplied by a model-backed caller,
 * but routing itself is deterministic and provider-independent.
 */
export interface NodeTurnClassification {
  readonly coveredByMain: boolean;
  readonly contradiction: boolean;
  readonly materialEvidence: boolean;
  readonly confidence: number;
  readonly mainStateVersion?: string;
  readonly sourceIds?: readonly string[];
  readonly policyVersion?: string;
  /** Excluded signal: recorded nowhere and never contributes to eligibility. */
  readonly agreementCount?: number;
  /** Excluded signal: recorded nowhere and never contributes to eligibility. */
  readonly popularityCount?: number;
  /** Excluded signal: recorded nowhere and never contributes to eligibility. */
  readonly repetitionCount?: number;
  /** Excluded signal: recorded nowhere and never contributes to eligibility. */
  readonly paid?: boolean;
}

export interface NodeRouteResult {
  readonly mode: NodeReplyMode;
  readonly reason: NodeRoutingReason;
  readonly classificationConfidence: number;
  readonly mainStateVersion: string;
  readonly sourceIds: readonly string[];
  readonly policyVersion: string;
  readonly response: NodeResponseContract;
}

export interface RouteNodeReplyInput extends NodeTurnClassification {
  readonly db: EventDatabase;
  readonly accountId: string;
  readonly conversationId: string;
  readonly nodeBrainId: string;
  readonly userMessageEventId: string;
}

export interface RoutedNodeReply<Output> {
  readonly route: NodeRouteResult;
  readonly routingEventId: string;
  readonly output: Output;
}
