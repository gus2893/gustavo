import Decimal from "decimal.js";
import { authenticateSession } from "../auth/sessions";
import {
  loadProjectionCheckpoint,
  type StoredChallengeLedgerEvent,
} from "../challenge/ledger";
import { replayStoredLedgerEvents } from "../challenge/projection";
import { readEventBodies } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { listMessages } from "../history/messages";
import {
  NODE_REPLY_MODES,
  type NodeReplyMode,
} from "../node-brains/contracts";
import {
  PROPOSAL_STATUSES,
  type ProposalStatus,
} from "../orchestration/proposals";

const CHAT_PAGE_SIZE = 3;
const BROADCAST_PAGE_SIZE = 25;
const CHALLENGE_LEDGER_PAGE_SIZE = 25;

export type AccountConversationAuthor = "USER" | "NODE_BRAIN" | "MAIN_BRAIN";

export interface AccountConversationMessageDto {
  readonly id: string;
  readonly author: AccountConversationAuthor;
  readonly routingMode?: NodeReplyMode;
  readonly proposalStatus?: ProposalStatus;
  readonly text: string;
  readonly occurredAt: string;
}

export interface AccountConversationBroadcastDto {
  readonly id: string;
  readonly author: "MAIN_BRAIN";
  readonly text: string;
  readonly occurredAt: string;
}

export interface AccountConversationDto {
  readonly conversationId: string;
  readonly messages: readonly AccountConversationMessageDto[];
  readonly broadcasts: readonly AccountConversationBroadcastDto[];
  readonly nextCursor: string | null;
}

export type AccountChallengeStageStatus =
  | "ACTIVE"
  | "PAUSED"
  | "PASSED"
  | "FAILED"
  | "COMPLETED"
  | "ARCHIVED";

export interface AccountChallengeStageDto {
  readonly startingBalance: string;
  readonly targetEquity: string;
  readonly equity: string;
  readonly status: AccountChallengeStageStatus;
  readonly updatedAt: string;
}

export interface AccountChallengePositionDto {
  readonly id: string;
  readonly symbol: string;
  readonly direction: "PAPER_LONG" | "PAPER_SHORT";
  readonly quantity: string;
  readonly averagePrice: string;
  readonly markPrice: string;
  readonly unrealizedPnl: string;
  readonly simulatedCosts: string;
  readonly observedAt: string;
  readonly freshness: string;
}

export interface AccountChallengeLedgerItemDto {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly amount?: string;
  readonly simulatedCosts?: string;
}

export interface AccountChallengeDto {
  readonly stage?: AccountChallengeStageDto;
  readonly positions: readonly AccountChallengePositionDto[];
  readonly ledger: readonly AccountChallengeLedgerItemDto[];
  readonly ledgerTruncated: boolean;
}

interface AssignedConversationRow extends Record<string, unknown> {
  readonly id: string;
  readonly node_brain_id: string;
  readonly status: "OPEN" | "ARCHIVED";
}

interface RouteProjectionRow extends Record<string, unknown> {
  readonly message_event_id: string;
  readonly route_event_id: string | null;
  readonly proposal_status: string | null;
}

interface DeliveryRow extends Record<string, unknown> {
  readonly delivery_event_id: string;
  readonly commit_event_id: string;
  readonly created_at: Date | string;
}

interface StageRow extends Record<string, unknown> {
  readonly id: string;
  readonly ordinal: number;
  readonly starting_balance_cents: string;
  readonly target_equity_cents: string;
  readonly portfolio_state: "ACTIVE" | "PAUSED" | "PASSED" | "FAILED" | "ARCHIVED";
}

interface PositionRow extends Record<string, unknown> {
  readonly id: string;
  readonly symbol: string;
  readonly observed_at: Date | string | null;
  readonly feed_status: "REALTIME" | "DELAYED" | null;
  readonly delay_seconds: number | null;
  readonly simulated_costs: string;
}

interface LedgerRow extends Record<string, unknown> {
  readonly id: string;
  readonly stage_id: string;
  readonly profile_version_id: string;
  readonly sequence: string;
  readonly type: string;
  readonly payload: Record<string, JsonValue>;
  readonly occurred_at: Date | string;
  readonly actor_type: "MAIN_BRAIN" | "SYSTEM";
  readonly actor_id: string;
  readonly idempotency_key: string;
  readonly causation_id: string | null;
  readonly correlation_id: string | null;
}

interface TerminalRow extends Record<string, unknown> {
  readonly type: string;
}

function requiredToken(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("SESSION_REQUIRED");
  return token;
}

function objectBody(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ACCOUNT_SURFACE_EVENT_INTEGRITY_FAILURE");
  }
  return value;
}

function routeMode(value: JsonValue | undefined): NodeReplyMode {
  if (typeof value !== "string" || !NODE_REPLY_MODES.includes(value as NodeReplyMode)) {
    throw new Error("ACCOUNT_SURFACE_ROUTE_INTEGRITY_FAILURE");
  }
  return value as NodeReplyMode;
}

function proposalStatus(value: string | null): ProposalStatus | undefined {
  if (value === null) return undefined;
  if (!PROPOSAL_STATUSES.includes(value as ProposalStatus)) {
    throw new Error("ACCOUNT_SURFACE_PROPOSAL_INTEGRITY_FAILURE");
  }
  return value as ProposalStatus;
}

function broadcastText(value: JsonValue): string {
  const body = objectBody(value);
  const author = body.author;
  if (typeof body.body !== "string" || !author || typeof author !== "object"
      || Array.isArray(author) || author.type !== "MAIN_BRAIN") {
    throw new Error("ACCOUNT_SURFACE_BROADCAST_INTEGRITY_FAILURE");
  }
  return body.body;
}

function moneyFromCents(cents: string): string {
  if (!/^[0-9]+$/u.test(cents)) throw new Error("ACCOUNT_SURFACE_MONEY_INTEGRITY_FAILURE");
  const value = BigInt(cents);
  const whole = value / 100n;
  return `${whole}.${(value % 100n).toString().padStart(2, "0")}`;
}

function money(value: string): string {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    throw new Error("ACCOUNT_SURFACE_MONEY_INTEGRITY_FAILURE");
  }
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function amount(event: StoredChallengeLedgerEvent): string | undefined {
  const value = event.payload.amount;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("ACCOUNT_SURFACE_MONEY_INTEGRITY_FAILURE");
  }
  return money(value);
}

function stageStatus(row: StageRow, terminal?: TerminalRow): AccountChallengeStageStatus {
  if (terminal?.type === "challenge.archived") return "ARCHIVED";
  if (terminal?.type === "challenge.failed" || terminal?.type === "stage.failed") return "FAILED";
  if (terminal?.type === "challenge.passed") return "COMPLETED";
  if (terminal?.type === "stage.passed") return row.ordinal === 10 ? "COMPLETED" : "PASSED";
  if (terminal?.type === "challenge.paused") return "PAUSED";
  return row.portfolio_state;
}

function storedLedgerEvent(row: LedgerRow): StoredChallengeLedgerEvent {
  return Object.freeze({
    id: row.id,
    stageId: row.stage_id,
    profileVersionId: row.profile_version_id,
    sequence: row.sequence,
    type: row.type,
    payload: Object.freeze(row.payload),
    occurredAt: new Date(row.occurred_at).toISOString(),
    actorType: row.actor_type,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
  });
}

/** Authenticates before resolving the account's one assigned conversation or any protected body. */
export async function loadAccountConversation(
  database: EventDatabase,
  token: string,
  after?: string,
): Promise<AccountConversationDto> {
  const session = await authenticateSession(database, requiredToken(token));
  const conversations = await database.query<AssignedConversationRow>(
    `select conversation.id::text,node.id::text node_brain_id,conversation.status
       from conversations conversation
       join node_brains node on node.id=conversation.node_brain_id
        and node.account_id=conversation.account_id and node.status='ACTIVE'
      where conversation.account_id=$1`,
    [session.accountId],
  );
  if (conversations.length !== 1) throw new Error("ACCOUNT_CONVERSATION_NOT_FOUND");
  const conversation = conversations[0]!;
  const page = await listMessages({
    db: database,
    accountId: session.accountId,
    conversationId: conversation.id,
  }, { limit: CHAT_PAGE_SIZE, ...(after === undefined ? {} : { after }) });
  const messageIds = page.items.map(({ eventId }) => eventId);
  const routeRows = messageIds.length === 0 ? [] : await database.query<RouteProjectionRow>(
    `select response.event_id::text message_event_id,route.id::text route_event_id,
            latest_status.to_status proposal_status
       from messages response
       join events response_event on response_event.id=response.event_id
       left join events route on response.role='NODE'
        and route.id=response_event.causation_id
        and route.aggregate_id=$2::text and route.account_id=$1::text
        and route.actor_type='NODE_BRAIN' and route.type='node.reply.routed'
        and route.visibility='PRIVATE_ACCOUNT'
       left join proposals proposal on proposal.route_event_id=route.id
        and proposal.account_id=$1::uuid and proposal.conversation_id=$2::uuid
       left join lateral (
         select transition.to_status
           from proposal_status_transitions transition
          where transition.proposal_id=proposal.id
          order by transition.ordinal desc limit 1
       ) latest_status on true
      where response.account_id=$1::uuid and response.conversation_id=$2::uuid
        and response.event_id=any($3::uuid[])`,
    [session.accountId, conversation.id, messageIds],
  );
  const routeEventIds = routeRows.flatMap(({ route_event_id }) => (
    route_event_id === null ? [] : [route_event_id]
  ));
  const routeBodies = routeEventIds.length === 0 ? [] : await readEventBodies(
    database,
    routeEventIds,
    { actor: { role: "ACCOUNT", accountId: session.accountId } },
  );
  const routeById = new Map(routeBodies.map(({ eventId, body }) => [eventId, body]));
  const metadataByMessage = new Map(routeRows.map((row) => {
    const body = row.route_event_id === null ? undefined : routeById.get(row.route_event_id);
    const status = proposalStatus(row.proposal_status);
    return [row.message_event_id, Object.freeze({
      ...(body === undefined ? {} : { routingMode: routeMode(objectBody(body).mode) }),
      ...(status === undefined ? {} : { proposalStatus: status }),
    })] as const;
  }));
  const messages: AccountConversationMessageDto[] = page.items.map((message) => Object.freeze({
    id: message.eventId,
    author: message.role === "USER" ? "USER" as const : "NODE_BRAIN" as const,
    text: message.text,
    occurredAt: message.occurredAt,
    ...metadataByMessage.get(message.eventId),
  }));

  const deliveryRows = after !== undefined ? [] : await database.query<DeliveryRow>(
    `select delivery.delivery_event_id::text,broadcast.commit_event_id::text,
            delivery.created_at
       from deliveries delivery
       join broadcasts broadcast on broadcast.id=delivery.broadcast_id
        and broadcast.author_type='MAIN_BRAIN'
      where delivery.account_id=$1 and delivery.node_brain_id=$2
        and delivery.author_type='MAIN_BRAIN'
      order by delivery.created_at desc,delivery.id desc limit $3`,
    [session.accountId, conversation.node_brain_id, BROADCAST_PAGE_SIZE],
  );
  const broadcastBodies = deliveryRows.length === 0 ? [] : await readEventBodies(
    database,
    deliveryRows.map(({ commit_event_id }) => commit_event_id),
    { actor: { role: "ACCOUNT", accountId: session.accountId } },
  );
  const broadcastById = new Map(broadcastBodies.map(({ eventId, body }) => [eventId, body]));
  const broadcasts: AccountConversationBroadcastDto[] = [];
  for (const delivery of deliveryRows) {
    const body = broadcastById.get(delivery.commit_event_id);
    if (body === undefined) throw new Error("ACCOUNT_SURFACE_BROADCAST_INTEGRITY_FAILURE");
    broadcasts.push(Object.freeze({
      id: delivery.delivery_event_id,
      author: "MAIN_BRAIN",
      text: broadcastText(body),
      occurredAt: new Date(delivery.created_at).toISOString(),
    }));
  }
  broadcasts.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
    || left.id.localeCompare(right.id));
  return Object.freeze({
    conversationId: conversation.id,
    messages: Object.freeze(messages),
    broadcasts: Object.freeze(broadcasts),
    nextCursor: page.nextCursor,
  });
}

/** Authenticates before resolving the shared read-only Challenge projection. */
export async function loadAccountChallenge(
  database: EventDatabase,
  token: string,
): Promise<AccountChallengeDto> {
  await authenticateSession(database, requiredToken(token));
  const stages = await database.query<StageRow>(
    `select stage.id::text,stage.ordinal,stage_profile.starting_balance_cents::text,
            stage_profile.target_equity_cents::text,
            portfolio.initial_lifecycle_state portfolio_state
       from challenge_stages stage
       join challenge_portfolios portfolio on portfolio.id=stage.challenge_portfolio_id
        and portfolio.owner_type='MAIN_BRAIN'
       join challenge_stage_profiles stage_profile on stage_profile.id=stage.stage_profile_id
      order by stage.ordinal desc limit 1`,
  );
  const stage = stages[0];
  if (!stage) return Object.freeze({
    positions: Object.freeze([]),
    ledger: Object.freeze([]),
    ledgerTruncated: false,
  });
  const checkpoint = await loadProjectionCheckpoint({ db: database }, stage.id);
  const recentRows = await database.query<LedgerRow>(
    `select id::text,stage_id::text,profile_version_id::text,sequence::text,
            type,payload,occurred_at,actor_type,actor_id,idempotency_key,
            causation_id::text,correlation_id::text
       from challenge_ledger_events
      where stage_id=$1
      order by challenge_ledger_events.sequence desc,
               challenge_ledger_events.id desc limit $2`,
    [stage.id, CHALLENGE_LEDGER_PAGE_SIZE + 1],
  );
  const ledgerTruncated = recentRows.length > CHALLENGE_LEDGER_PAGE_SIZE;
  const recentEvents = recentRows
    .slice(0, CHALLENGE_LEDGER_PAGE_SIZE)
    .map(storedLedgerEvent);
  let projection = checkpoint?.projection;
  if (checkpoint !== null && recentEvents[0]?.id !== checkpoint.highWaterEventId) {
    throw new Error("ACCOUNT_SURFACE_CHALLENGE_CHECKPOINT_STALE");
  }
  if (projection === undefined) {
    if (ledgerTruncated) throw new Error("ACCOUNT_SURFACE_CHALLENGE_CHECKPOINT_REQUIRED");
    projection = replayStoredLedgerEvents([...recentEvents].reverse());
  }
  const positionIds = projection.positions.map(({ positionId }) => positionId);
  const positionRows = positionIds.length === 0 ? [] : await database.query<PositionRow>(
    `select position.id::text,position.symbol,mark.observed_at,
            observation.feed_status,observation.delay_seconds,
            coalesce(cost.amount,'0.00') simulated_costs
       from challenge_positions position
       left join lateral (
         select price_mark.market_observation_id,price_mark.observed_at
           from challenge_price_marks price_mark
          where price_mark.position_id=position.id
          order by price_mark.observed_at desc,price_mark.id desc limit 1
       ) mark on true
       left join market_observations observation on observation.id=mark.market_observation_id
       left join lateral (
         select coalesce(sum(item.amount),0)::text amount from (
           select fee.amount::numeric amount from challenge_fees fee
            where fee.position_id=position.id
           union all
           select financing.amount::numeric amount from challenge_financing financing
            where financing.position_id=position.id
         ) item
       ) cost on true
      where position.stage_id=$1 and position.id=any($2::uuid[])`,
    [stage.id, positionIds],
  );
  const rowByPosition = new Map(positionRows.map((row) => [row.id, row]));
  const positions = projection.positions.map((position): AccountChallengePositionDto => {
    const row = rowByPosition.get(position.positionId);
    if (!row || row.observed_at === null || row.feed_status === null
        || row.delay_seconds === null) {
      throw new Error("ACCOUNT_SURFACE_POSITION_INTEGRITY_FAILURE");
    }
    return Object.freeze({
      id: position.positionId,
      symbol: row.symbol,
      direction: position.side === "BUY" ? "PAPER_LONG" : "PAPER_SHORT",
      quantity: position.quantity,
      averagePrice: money(position.averagePrice),
      markPrice: money(position.markPrice),
      unrealizedPnl: money(position.unrealizedPnl),
      simulatedCosts: money(row.simulated_costs),
      observedAt: new Date(row.observed_at).toISOString(),
      freshness: row.feed_status === "REALTIME"
        ? "REALTIME"
        : `DELAYED \u2014 ${row.delay_seconds} seconds`,
    });
  });
  const ledger = recentEvents.map((event): AccountChallengeLedgerItemDto => {
    const eventAmount = amount(event);
    return Object.freeze({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(eventAmount === undefined ? {} : { amount: eventAmount }),
      ...((event.type === "fee.recorded" || event.type === "financing.recorded")
        && eventAmount !== undefined ? { simulatedCosts: eventAmount } : {}),
    });
  });
  const latest = recentEvents[0];
  if (!latest) throw new Error("ACCOUNT_SURFACE_CHALLENGE_INTEGRITY_FAILURE");
  const terminal = (await database.query<TerminalRow>(
    `select type from challenge_ledger_events
      where stage_id=$1 and type=any($2::text[])
      order by sequence desc,id desc limit 1`,
    [stage.id, ["challenge.archived", "challenge.failed", "challenge.passed",
      "challenge.paused", "stage.failed", "stage.passed"]],
  ))[0];
  return Object.freeze({
    stage: Object.freeze({
      startingBalance: moneyFromCents(stage.starting_balance_cents),
      targetEquity: moneyFromCents(stage.target_equity_cents),
      equity: money(projection.equity),
      status: stageStatus(stage, terminal),
      updatedAt: latest.occurredAt,
    }),
    positions: Object.freeze(positions),
    ledger: Object.freeze(ledger),
    ledgerTruncated,
  });
}
