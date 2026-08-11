import { appendEvent } from "../events/store";
import type { JsonValue } from "../events/types";
import {
  NODE_REPLY_MODES,
  type NodeResponseContract,
  type NodeRouteResult,
  type NodeRoutingReason,
  type NodeTurnClassification,
  type RouteNodeReplyInput,
  type RoutedNodeReply,
} from "./contracts";

export { NODE_REPLY_MODES } from "./contracts";
export type {
  NodeReplyMode,
  NodeResponseContract,
  NodeRouteResult,
  NodeRoutingReason,
  NodeTurnClassification,
  RouteNodeReplyInput,
  RoutedNodeReply,
} from "./contracts";

export const NODE_ROUTING_POLICY_VERSION = "node-routing-v1";
export const MIN_ROUTING_CONFIDENCE = 0.8;
export const MAX_NODE_ROUTE_SOURCE_IDS = 64;

const DEFAULT_MAIN_STATE_VERSION = "main-state-v0";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAIN_RESPONSE = Object.freeze({
  canonical: true,
  authority: "MAIN",
  label: "MAIN POSITION",
} satisfies NodeResponseContract);
const EXPLORATION_RESPONSE = Object.freeze({
  canonical: false,
  authority: "NODE",
  label: "NODE EXPLORATION — NOT AN ACCEPTED MAIN POSITION",
} satisfies NodeResponseContract);
const PROPOSAL_RESPONSE = Object.freeze({
  canonical: false,
  authority: "NODE",
  label: "NODE PROPOSAL — PENDING MAIN REVIEW",
} satisfies NodeResponseContract);

interface SemanticRoute {
  readonly mode: (typeof NODE_REPLY_MODES)[number];
  readonly reason: NodeRoutingReason;
  readonly response: NodeResponseContract;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function requiredIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) throw new Error(code);
  return normalized;
}

function requiredUuid(value: unknown, code: string): string {
  const identifier = requiredIdentifier(value, code);
  if (!UUID_PATTERN.test(identifier)) throw new Error(code);
  return identifier;
}

function validateSemanticClassification(
  value: NodeTurnClassification,
): asserts value is NodeTurnClassification {
  if (!isRecord(value)) throw new Error("NODE_ROUTE_INPUT_INVALID");
  if (
    typeof value.coveredByMain !== "boolean" ||
    typeof value.contradiction !== "boolean" ||
    typeof value.materialEvidence !== "boolean"
  ) {
    throw new Error("NODE_ROUTE_INPUT_INVALID");
  }
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error("NODE_ROUTE_CONFIDENCE_INVALID");
  }
}

/**
 * Deterministic hard exclusion boundary. These fields are validated only so
 * malformed caller data fails closed; they are deliberately not returned to
 * semantic classification and cannot improve proposal eligibility.
 */
function validateExcludedSignals(value: NodeTurnClassification): void {
  for (const count of [
    value.agreementCount,
    value.popularityCount,
    value.repetitionCount,
  ]) {
    if (
      count !== undefined &&
      (!Number.isSafeInteger(count) || count < 0)
    ) {
      throw new Error("NODE_ROUTE_EXCLUDED_SIGNAL_INVALID");
    }
  }
  if (value.paid !== undefined && typeof value.paid !== "boolean") {
    throw new Error("NODE_ROUTE_EXCLUDED_SIGNAL_INVALID");
  }
}

function routingProvenance(input: NodeTurnClassification): {
  readonly mainStateVersion: string;
  readonly sourceIds: readonly string[];
  readonly policyVersion: string;
} {
  const mainStateVersion =
    input.mainStateVersion === undefined
      ? DEFAULT_MAIN_STATE_VERSION
      : requiredIdentifier(
          input.mainStateVersion,
          "NODE_ROUTE_MAIN_STATE_VERSION_INVALID",
        );
  const policyVersion =
    input.policyVersion === undefined
      ? NODE_ROUTING_POLICY_VERSION
      : requiredIdentifier(input.policyVersion, "NODE_ROUTE_POLICY_VERSION_INVALID");
  if (policyVersion !== NODE_ROUTING_POLICY_VERSION) {
    throw new Error("NODE_ROUTE_POLICY_VERSION_CONFLICT");
  }
  if (input.sourceIds !== undefined && !Array.isArray(input.sourceIds)) {
    throw new Error("NODE_ROUTE_SOURCE_ID_INVALID");
  }
  if ((input.sourceIds?.length ?? 0) > MAX_NODE_ROUTE_SOURCE_IDS) {
    throw new Error("NODE_ROUTE_SOURCE_LIMIT_EXCEEDED");
  }
  const sourceIds = Object.freeze(
    [...new Set(
      (input.sourceIds ?? []).map((sourceId) =>
        requiredIdentifier(sourceId, "NODE_ROUTE_SOURCE_ID_INVALID"),
      ),
    )].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return { mainStateVersion, sourceIds, policyVersion };
}

/** Classifies only approved semantic inputs after exclusions are removed. */
function classifySemanticRoute(input: {
  readonly coveredByMain: boolean;
  readonly contradiction: boolean;
  readonly materialEvidence: boolean;
  readonly confidence: number;
}): SemanticRoute {
  if (input.coveredByMain && input.contradiction) {
    return {
      mode: "NODE_EXPLORE",
      reason: "CONFLICTING_CLASSIFICATION",
      response: EXPLORATION_RESPONSE,
    };
  }
  if (input.confidence < MIN_ROUTING_CONFIDENCE) {
    return {
      mode: "NODE_EXPLORE",
      reason: "LOW_CONFIDENCE",
      response: EXPLORATION_RESPONSE,
    };
  }
  if (input.materialEvidence) {
    return {
      mode: "PROPOSAL_UPSTREAM",
      reason: "MATERIAL_IMPROVEMENT",
      response: PROPOSAL_RESPONSE,
    };
  }
  if (input.coveredByMain) {
    return {
      mode: "MAIN_DEFAULT",
      reason: "MAIN_COVERED",
      response: MAIN_RESPONSE,
    };
  }
  if (input.contradiction) {
    return {
      mode: "NODE_EXPLORE",
      reason: "UNRESOLVED_CONTRADICTION",
      response: EXPLORATION_RESPONSE,
    };
  }
  return {
    mode: "NODE_EXPLORE",
    reason: "CLARIFICATION_REQUIRED",
    response: EXPLORATION_RESPONSE,
  };
}

export function routeNodeTurn(input: NodeTurnClassification): NodeRouteResult {
  validateSemanticClassification(input);
  validateExcludedSignals(input);
  const provenance = routingProvenance(input);
  const semantic = classifySemanticRoute({
    coveredByMain: input.coveredByMain,
    contradiction: input.contradiction,
    materialEvidence: input.materialEvidence,
    confidence: input.confidence,
  });

  return Object.freeze({
    mode: semantic.mode,
    reason: semantic.reason,
    classificationConfidence: input.confidence,
    mainStateVersion: provenance.mainStateVersion,
    sourceIds: provenance.sourceIds,
    policyVersion: provenance.policyVersion,
    response: semantic.response,
  });
}

function routingEventBody(route: NodeRouteResult): JsonValue {
  return {
    classificationConfidence: route.classificationConfidence,
    mainStateVersion: route.mainStateVersion,
    mode: route.mode,
    policyVersion: route.policyVersion,
    reason: route.reason,
    response: {
      authority: route.response.authority,
      canonical: route.response.canonical,
      label: route.response.label,
    },
    sourceIds: [...route.sourceIds],
  };
}

function validateRoutingContext(input: RouteNodeReplyInput): void {
  if (
    !isRecord(input) ||
    !isRecord(input.db) ||
    typeof input.db.query !== "function" ||
    typeof input.db.one !== "function" ||
    typeof input.db.transaction !== "function"
  ) {
    throw new Error("NODE_ROUTE_CONTEXT_INVALID");
  }
  requiredUuid(input.accountId, "NODE_ROUTE_CONTEXT_INVALID");
  requiredUuid(input.conversationId, "NODE_ROUTE_CONTEXT_INVALID");
  requiredUuid(input.nodeBrainId, "NODE_ROUTE_CONTEXT_INVALID");
  const userMessageEventId = requiredUuid(
    input.userMessageEventId,
    "NODE_ROUTE_CONTEXT_INVALID",
  );
  if (
    typeof input.mainStateVersion !== "string" ||
    input.mainStateVersion.trim().length === 0 ||
    !Array.isArray(input.sourceIds) ||
    input.sourceIds.length === 0 ||
    !input.sourceIds.includes(userMessageEventId)
  ) {
    throw new Error("NODE_ROUTE_PROVENANCE_REQUIRED");
  }
}

interface AuthorizedRouteSource extends Record<string, unknown> {
  readonly correlation_id: string;
}

async function authorizeRouteSource(
  input: RouteNodeReplyInput,
  database: RouteNodeReplyInput["db"],
): Promise<AuthorizedRouteSource> {
  const rows = await database.query<AuthorizedRouteSource>(
    `select source_event.correlation_id::text as correlation_id
     from accounts account
     join entitlements entitlement on entitlement.account_id=account.id
     join node_brains node
       on node.account_id=account.id and node.id=$3 and node.status='ACTIVE'
     join conversations conversation
       on conversation.account_id=account.id
      and conversation.node_brain_id=node.id
      and conversation.id=$2
      and conversation.status='OPEN'
     join messages message
       on message.account_id=account.id
      and message.conversation_id=conversation.id
      and message.event_id=$4
      and message.role='USER'
      and message.status='COMPLETED'
     join events source_event
       on source_event.id=message.event_id
      and source_event.aggregate_id=conversation.id::text
      and source_event.account_id=account.id::text
      and source_event.actor_type='USER'
      and source_event.actor_id=account.id::text
      and source_event.type='participant.message.created'
      and source_event.visibility='PRIVATE_ACCOUNT'
     where account.id=$1
       and account.status='ACTIVE'
       and entitlement.revoked_at is null
       and entitlement.active_from <= clock_timestamp()
       and (
         entitlement.expires_at is null
         or entitlement.expires_at > clock_timestamp()
       )
     for key share of account, entitlement, node, conversation, message, source_event`,
    [input.accountId, input.conversationId, input.nodeBrainId, input.userMessageEventId],
  );
  if (rows.length !== 1) throw new Error("NODE_ROUTE_SOURCE_FORBIDDEN");
  return rows[0];
}

export async function routeNodeReply<Output>(
  input: RouteNodeReplyInput,
  continueGeneration: (route: NodeRouteResult) => Promise<Output>,
): Promise<RoutedNodeReply<Output>> {
  validateRoutingContext(input);
  if (typeof continueGeneration !== "function") {
    throw new Error("NODE_ROUTE_GENERATOR_INVALID");
  }
  const route = routeNodeTurn(input);
  const routingEvent = await input.db.transaction(async (transaction) => {
    const source = await authorizeRouteSource(input, transaction);
    return appendEvent(transaction, {
      aggregateId: input.conversationId,
      accountId: input.accountId,
      actor: {
        type: "NODE_BRAIN",
        id: input.nodeBrainId,
      },
      type: "node.reply.routed",
      visibility: "PRIVATE_ACCOUNT",
      body: routingEventBody(route),
      idempotencyKey: `node-route:${input.userMessageEventId}`,
      causationId: input.userMessageEventId,
      correlationId: source.correlation_id,
      policyVersion: route.policyVersion,
    });
  });
  const routingEventId = requiredIdentifier(
    routingEvent.id,
    "NODE_ROUTE_EVENT_APPEND_INVALID",
  );

  const output = await continueGeneration(route);
  return Object.freeze({ route, routingEventId, output });
}
