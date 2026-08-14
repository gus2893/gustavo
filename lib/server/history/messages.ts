import { appendEvent, readEventBody } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "./cursor";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const BRIDGE_CLAIM_LOCK = "gustavo:bridge-model-job-claim:v1";

export type MessageRole = "USER" | "NODE";
export type MessageStatus = "COMPLETED" | "ABORTED";

export type MessageCompletion =
  | {
      readonly status: "COMPLETED";
      readonly at?: Date;
    }
  | {
      readonly status: "ABORTED";
      readonly at: Date;
      readonly reason: string;
    };

export interface ConversationHistoryContext {
  readonly db: EventDatabase;
  readonly accountId: string;
  readonly conversationId: string;
}

export interface AppendMessageInput {
  readonly idempotencyKey: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly completion?: MessageCompletion;
  readonly routingEventId?: string;
  readonly bridgeAuthority?: {
    readonly jobId: string;
    readonly sourceEventId: string;
    readonly workerId: string;
    readonly attemptCount: number;
  };
}

export interface ConversationMessage {
  readonly eventId: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly status: MessageStatus;
  readonly occurredAt: string;
  readonly completedAt: string | null;
  readonly abortedAt: string | null;
  readonly abortReason: string | null;
}

export interface AppendedMessage extends ConversationMessage {
  readonly accountId: string;
  readonly conversationId: string;
  readonly nodeBrainId: string;
  readonly sourceEventId: string;
}

export interface AppendMessageDisposition {
  readonly message: AppendedMessage;
  readonly inserted: boolean;
  readonly bridgeJobId: string | null;
}

export interface MessagePage {
  readonly items: readonly ConversationMessage[];
  readonly nextCursor: string | null;
}

interface ConversationRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string;
  readonly node_brain_id: string;
}

interface MessageRow extends Record<string, unknown> {
  readonly event_id: string;
  readonly role: MessageRole;
  readonly status: MessageStatus;
  readonly occurred_at: Date | string;
  readonly completed_at: Date | string | null;
  readonly aborted_at: Date | string | null;
  readonly abort_reason: string | null;
}

interface RoutingEventRow extends Record<string, unknown> {
  readonly id: string;
  readonly correlation_id: string;
}

interface BridgeNodeOutputAuthorityRow extends Record<string, unknown> {
  readonly conversation_id: string;
  readonly account_id: string;
  readonly node_brain_id: string;
  readonly correlation_id: string;
}

interface BridgeSourceKeyRow extends Record<string, unknown> {
  readonly data_key_id: string;
}

interface HistoryCursor {
  readonly kind: "conversation-history";
  readonly version: 1;
  readonly accountId: string;
  readonly conversationId: string;
  readonly afterEventId: string;
}

function requireUuid(value: string, error: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(error);
  }
  return value;
}

function requireBoundedText(
  value: string,
  maximumLength: number,
  error: string,
): string {
  if (value.trim().length === 0 || value.length > maximumLength) {
    throw new Error(error);
  }
  return value;
}

function requireDate(value: Date, error: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(error);
  }
  return date;
}

function requireBridgeNodeOutputAuthority(
  input: AppendMessageInput,
  status: MessageStatus,
): AppendMessageInput["bridgeAuthority"] {
  const authority = input.bridgeAuthority;
  if (authority === undefined) return undefined;
  if (
    input.role !== "NODE"
    || status !== "COMPLETED"
    || input.routingEventId === undefined
    || !UUID_PATTERN.test(authority.jobId)
    || !UUID_PATTERN.test(authority.sourceEventId)
    || !WORKER_ID_PATTERN.test(authority.workerId)
    || !Number.isSafeInteger(authority.attemptCount)
    || authority.attemptCount < 1
    || authority.attemptCount > 3
  ) {
    throw new Error("BRIDGE_OUTPUT_AUTHORITY_INVALID");
  }
  return authority;
}

async function authorizeBridgeNodeOutput(
  database: EventDatabase,
  context: ConversationHistoryContext,
  routingEventId: string,
  authority: NonNullable<AppendMessageInput["bridgeAuthority"]>,
): Promise<BridgeNodeOutputAuthorityRow> {
  const rows = await database.query<BridgeNodeOutputAuthorityRow>(
    `/* hybrid-node-output-authority */
     select conversation.id::text as conversation_id,
            account.id::text as account_id,
            node.id::text as node_brain_id,
            route.correlation_id::text as correlation_id
       from bridge_model_jobs job
       join messages message
         on message.event_id=job.source_event_id
        and message.role='USER' and message.status='COMPLETED'
        and message.completed_at is not null
       join conversations conversation
         on conversation.id=message.conversation_id
        and conversation.account_id=message.account_id
        and conversation.status='OPEN'
       join accounts account
         on account.id=conversation.account_id and account.status='ACTIVE'
       join entitlements entitlement
         on entitlement.account_id=account.id
        and entitlement.revoked_at is null
        and entitlement.active_from<=clock_timestamp()
        and (entitlement.expires_at is null
             or entitlement.expires_at>clock_timestamp())
       join node_brains node
         on node.id=conversation.node_brain_id
        and node.account_id=account.id and node.status='ACTIVE'
       join events source
         on source.id=message.event_id
        and source.aggregate_id=conversation.id::text
        and source.account_id=account.id::text
        and source.actor_type='USER' and source.actor_id=account.id::text
        and source.type='participant.message.created'
        and source.visibility='PRIVATE_ACCOUNT'
       join transactional_outbox outbox
         on outbox.event_id=source.id
        and outbox.topic='participant.message.created'
        and outbox.payload=jsonb_build_object('eventId',source.id::text)
       join events route
         on route.id=$5
        and route.aggregate_id=conversation.id::text
        and route.account_id=account.id::text
        and route.actor_type='NODE_BRAIN' and route.actor_id=node.id::text
        and route.type='node.reply.routed'
        and route.visibility='PRIVATE_ACCOUNT'
        and route.causation_id=source.id
        and route.correlation_id=source.correlation_id
      where job.job_id=$1 and job.source_event_id=$2
        and job.role='NODE' and job.kind='NODE_REPLY' and job.priority=0
        and job.request_digest=bridge_model_job_request_digest(
          job.source_event_id,job.role,job.kind
        )
        and job.status='CLAIMED' and job.lease_owner=$3
        and job.attempt_count=$4 and job.lease_expires_at>clock_timestamp()
        and account.id=$6 and conversation.id=$7
      for update of job
      for share of account,entitlement,node,conversation,message,source,outbox,route`,
    [
      authority.jobId,
      authority.sourceEventId,
      authority.workerId,
      authority.attemptCount,
      routingEventId,
      context.accountId,
      context.conversationId,
    ],
  );
  if (rows.length !== 1) throw new Error("BRIDGE_OUTPUT_AUTHORITY_REVOKED");
  return rows[0];
}

async function revalidateBridgeNodeOutput(
  database: EventDatabase,
  context: ConversationHistoryContext,
  routingEventId: string,
  authority: NonNullable<AppendMessageInput["bridgeAuthority"]>,
  authorized: BridgeNodeOutputAuthorityRow,
  dataKeyId: string,
): Promise<void> {
  const rows = await database.query(
    `/* hybrid-node-output-revalidate */
     select 1
       from bridge_model_jobs job
       join messages message
         on message.event_id=job.source_event_id
        and message.role='USER' and message.status='COMPLETED'
        and message.completed_at is not null
       join conversations conversation
         on conversation.id=message.conversation_id
        and conversation.account_id=message.account_id
        and conversation.status='OPEN'
       join accounts account
         on account.id=conversation.account_id and account.status='ACTIVE'
       join entitlements entitlement
         on entitlement.account_id=account.id
        and entitlement.revoked_at is null
        and entitlement.active_from<=clock_timestamp()
        and (entitlement.expires_at is null
             or entitlement.expires_at>clock_timestamp())
       join node_brains node
         on node.id=conversation.node_brain_id
        and node.account_id=account.id and node.status='ACTIVE'
       join events source
         on source.id=message.event_id
        and source.aggregate_id=conversation.id::text
        and source.account_id=account.id::text
        and source.actor_type='USER' and source.actor_id=account.id::text
        and source.type='participant.message.created'
        and source.visibility='PRIVATE_ACCOUNT'
       join encrypted_event_bodies body
         on body.event_id=source.id
        and body.aggregate_id=source.aggregate_id
        and body.data_key_id=$8
       join aggregate_data_keys data_key
         on data_key.id=$8 and data_key.id=body.data_key_id
        and data_key.aggregate_id=conversation.id::text
       join transactional_outbox outbox
         on outbox.event_id=source.id
        and outbox.topic='participant.message.created'
        and outbox.payload=jsonb_build_object('eventId',source.id::text)
       join events route
         on route.id=$5
        and route.aggregate_id=conversation.id::text
        and route.account_id=account.id::text
        and route.actor_type='NODE_BRAIN' and route.actor_id=node.id::text
        and route.type='node.reply.routed'
        and route.visibility='PRIVATE_ACCOUNT'
        and route.causation_id=source.id
        and route.correlation_id=source.correlation_id
      where job.job_id=$1 and job.source_event_id=$2
        and job.role='NODE' and job.kind='NODE_REPLY' and job.priority=0
        and job.request_digest=bridge_model_job_request_digest(
          job.source_event_id,job.role,job.kind
        )
        and job.status='CLAIMED' and job.lease_owner=$3
        and job.attempt_count=$4 and job.lease_expires_at>clock_timestamp()
        and account.id=$6 and conversation.id=$7
        and account.id=$9 and conversation.id=$10 and node.id=$11
        and source.id=$2 and route.correlation_id=$12`,
    [
      authority.jobId,
      authority.sourceEventId,
      authority.workerId,
      authority.attemptCount,
      routingEventId,
      context.accountId,
      context.conversationId,
      dataKeyId,
      authorized.account_id,
      authorized.conversation_id,
      authorized.node_brain_id,
      authorized.correlation_id,
    ],
  );
  if (rows.length !== 1) throw new Error("BRIDGE_OUTPUT_AUTHORITY_REVOKED");
}

async function lockBridgeSourceBody(
  database: EventDatabase,
  context: ConversationHistoryContext,
  sourceEventId: string,
): Promise<string> {
  const keys = await database.query<BridgeSourceKeyRow>(
    `/* hybrid-output-key-lock */
     select data_key.id::text as data_key_id
       from events source
       join encrypted_event_bodies body
         on body.event_id=source.id
        and body.aggregate_id=source.aggregate_id
        and body.data_key_id is not null
       join aggregate_data_keys data_key
         on data_key.id=body.data_key_id
        and data_key.aggregate_id=source.aggregate_id
      where source.id=$1 and source.aggregate_id=$2::text
        and source.account_id=$3::text
      order by data_key.id
      for share of data_key`,
    [sourceEventId, context.conversationId, context.accountId],
  );
  if (keys.length !== 1) throw new Error("BRIDGE_OUTPUT_AUTHORITY_REVOKED");
  const bodies = await database.query(
    `/* hybrid-output-body-lock */
     select body.event_id
       from encrypted_event_bodies body
      where body.event_id=$1 and body.aggregate_id=$2::text
        and body.data_key_id=$3
      for share of body`,
    [sourceEventId, context.conversationId, keys[0].data_key_id],
  );
  if (bodies.length !== 1) throw new Error("BRIDGE_OUTPUT_AUTHORITY_REVOKED");
  return keys[0].data_key_id;
}

async function authorizeConversation(
  database: EventDatabase,
  accountId: string,
  conversationId: string,
): Promise<ConversationRow> {
  requireUuid(accountId, "FORBIDDEN");
  requireUuid(conversationId, "FORBIDDEN");
  const rows = await database.query<ConversationRow>(
    `select c.id, c.account_id, c.node_brain_id
     from conversations c
     where c.id=$1 and c.account_id=$2`,
    [conversationId, accountId],
  );
  const conversation = rows[0];
  if (!conversation) {
    throw new Error("FORBIDDEN");
  }
  return conversation;
}

function eventIdempotencyKey(
  conversationId: string,
  idempotencyKey: string,
): string {
  return `message:${conversationId}:${idempotencyKey}`;
}

function messageBody(
  input: AppendMessageInput,
  status: MessageStatus,
  abortReason: string | null,
): JsonValue {
  return {
    text: input.text,
    role: input.role,
    completion: {
      status,
      reason: abortReason,
    },
  };
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function mapMessageRow(row: MessageRow, text: string): ConversationMessage {
  return Object.freeze({
    eventId: row.event_id,
    role: row.role,
    text,
    status: row.status,
    occurredAt: iso(row.occurred_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    abortedAt: row.aborted_at === null ? null : iso(row.aborted_at),
    abortReason: row.abort_reason,
  });
}

function mapAppendedMessage(
  row: MessageRow,
  text: string,
  authority: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly nodeBrainId: string;
  },
): AppendedMessage {
  return Object.freeze({
    ...mapMessageRow(row, text),
    accountId: authority.accountId,
    conversationId: authority.conversationId,
    nodeBrainId: authority.nodeBrainId,
    sourceEventId: row.event_id,
  });
}

function cursorFor(
  context: ConversationHistoryContext,
  afterEventId: string,
): string {
  return encodeOpaqueCursor({
    kind: "conversation-history",
    version: 1,
    accountId: context.accountId,
    conversationId: context.conversationId,
    afterEventId,
  });
}

function parseCursor(
  cursor: string,
  context: ConversationHistoryContext,
): string {
  const decoded = decodeOpaqueCursor(cursor);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("INVALID_CURSOR");
  }
  const value = decoded as Partial<HistoryCursor>;
  if (
    value.kind !== "conversation-history"
    || value.version !== 1
    || typeof value.accountId !== "string"
    || typeof value.conversationId !== "string"
    || typeof value.afterEventId !== "string"
    || !UUID_PATTERN.test(value.afterEventId)
  ) {
    throw new Error("INVALID_CURSOR");
  }
  if (
    value.accountId !== context.accountId
    || value.conversationId !== context.conversationId
  ) {
    throw new Error("INVALID_CURSOR_SCOPE");
  }
  return value.afterEventId;
}

function textFromBody(body: JsonValue, row: MessageRow): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("INVALID_MESSAGE_BODY");
  }
  const text = body.text;
  const role = body.role;
  const completion = body.completion;
  if (
    typeof text !== "string"
    || role !== row.role
    || !completion
    || typeof completion !== "object"
    || Array.isArray(completion)
    || completion.status !== row.status
  ) {
    throw new Error("INVALID_MESSAGE_BODY");
  }
  return text;
}

export async function appendMessageWithDisposition(
  context: ConversationHistoryContext,
  input: AppendMessageInput,
): Promise<AppendMessageDisposition> {
  const idempotencyKey = requireBoundedText(
    input.idempotencyKey,
    200,
    "INVALID_MESSAGE_IDEMPOTENCY_KEY",
  );
  requireBoundedText(input.text, 100_000, "INVALID_MESSAGE_TEXT");
  if (input.role !== "USER" && input.role !== "NODE") {
    throw new Error("INVALID_MESSAGE_ROLE");
  }
  if (input.role === "USER" && input.routingEventId !== undefined) {
    throw new Error("INVALID_MESSAGE_ROUTING_EVENT");
  }
  const routingEventId = input.routingEventId === undefined
    ? undefined
    : requireUuid(input.routingEventId, "INVALID_MESSAGE_ROUTING_EVENT");

  const status = input.completion?.status ?? "COMPLETED";
  const explicitAt = input.completion?.at
    ? requireDate(input.completion.at, "INVALID_MESSAGE_COMPLETION_TIME")
    : undefined;
  const abortReason = input.completion?.status === "ABORTED"
    ? requireBoundedText(
        input.completion.reason,
        200,
        "INVALID_MESSAGE_ABORT_REASON",
      )
    : null;
  const bridgeAuthority = requireBridgeNodeOutputAuthority(input, status);

  return context.db.transaction(async (transaction) => {
    let conversation: ConversationRow;
    let routingCorrelationId: string | undefined;
    if (bridgeAuthority !== undefined && routingEventId !== undefined) {
      await transaction.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [BRIDGE_CLAIM_LOCK],
      );
      const authority = await authorizeBridgeNodeOutput(
        transaction,
        context,
        routingEventId,
        bridgeAuthority,
      );
      const dataKeyId = await lockBridgeSourceBody(
        transaction,
        context,
        bridgeAuthority.sourceEventId,
      );
      await revalidateBridgeNodeOutput(
        transaction,
        context,
        routingEventId,
        bridgeAuthority,
        authority,
        dataKeyId,
      );
      conversation = {
        id: authority.conversation_id,
        account_id: authority.account_id,
        node_brain_id: authority.node_brain_id,
      };
      routingCorrelationId = authority.correlation_id;
    } else {
      conversation = await authorizeConversation(
        transaction,
        context.accountId,
        context.conversationId,
      );
    }
    if (bridgeAuthority === undefined && routingEventId !== undefined) {
      const routes = await transaction.query<RoutingEventRow>(
        `select route.id::text,route.correlation_id::text
           from events route
          where route.id=$1 and route.aggregate_id=$2::text
            and route.account_id=$3::text
            and route.actor_type='NODE_BRAIN' and route.actor_id=$4::text
            and route.type='node.reply.routed' and route.visibility='PRIVATE_ACCOUNT'`,
        [routingEventId, conversation.id, context.accountId, conversation.node_brain_id],
      );
      if (routes.length !== 1) throw new Error("INVALID_MESSAGE_ROUTING_EVENT");
      routingCorrelationId = routes[0].correlation_id;
    }
    const event = await appendEvent(transaction, {
      aggregateId: conversation.id,
      accountId: context.accountId,
      actor: input.role === "USER"
        ? { type: "USER", id: context.accountId }
        : { type: "NODE_BRAIN", id: conversation.node_brain_id },
      type: input.role === "USER"
        ? "participant.message.created"
        : status === "COMPLETED"
          ? "brain.response.completed"
          : "brain.response.aborted",
      visibility: "PRIVATE_ACCOUNT",
      body: messageBody(input, status, abortReason),
      idempotencyKey: eventIdempotencyKey(conversation.id, idempotencyKey),
      ...(routingEventId === undefined ? {} : { causationId: routingEventId }),
      ...(routingCorrelationId === undefined ? {} : { correlationId: routingCorrelationId }),
      ...(explicitAt ? { occurredAt: explicitAt } : {}),
    });
    const completionAt = status === "COMPLETED"
      ? explicitAt ?? event.occurredAt
      : null;
    const abortedAt = status === "ABORTED"
      ? explicitAt ?? event.occurredAt
      : null;

    const insertedRows = await transaction.query<{ readonly event_id: string }>(
      `insert into messages (
        event_id, conversation_id, account_id, role, idempotency_key,
        status, occurred_at, completed_at, aborted_at, abort_reason
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict (conversation_id, idempotency_key) do nothing
      returning event_id::text`,
      [
        event.id,
        conversation.id,
        context.accountId,
        input.role,
        idempotencyKey,
        status,
        event.occurredAt,
        completionAt,
        abortedAt,
        abortReason,
      ],
    );
    const persisted = await transaction.one<MessageRow>(
      `select event_id, role, status, occurred_at, completed_at,
              aborted_at, abort_reason
       from messages
       where conversation_id=$1 and idempotency_key=$2`,
      [conversation.id, idempotencyKey],
    );
    if (persisted.event_id !== event.id) {
      throw new Error("IDEMPOTENCY_KEY_REUSED");
    }
    const inserted = insertedRows.length === 1;
    if (insertedRows.length > 1) throw new Error("MESSAGE_INSERT_INVALID");
    const completedJobs = bridgeAuthority === undefined
      ? []
      : inserted
        ? await transaction.query<{ readonly job_id: string }>(
            `update bridge_model_jobs
                set status='COMPLETED',lease_owner=null,lease_expires_at=null,
                    output_event_id=$2,safe_code=null
              where job_id=$1 and source_event_id=$3
                and role='NODE' and kind='NODE_REPLY' and priority=0
                and request_digest=bridge_model_job_request_digest(
                  source_event_id,role,kind
                )
                and status='CLAIMED' and lease_owner=$4
                and attempt_count=$5 and lease_expires_at>clock_timestamp()
              returning job_id::text`,
            [
              bridgeAuthority.jobId,
              event.id,
              bridgeAuthority.sourceEventId,
              bridgeAuthority.workerId,
              bridgeAuthority.attemptCount,
            ],
          )
        : [];
    if (bridgeAuthority !== undefined && completedJobs.length !== 1) {
      throw new Error("BRIDGE_OUTPUT_AUTHORITY_REVOKED");
    }
    const jobRows = inserted && input.role === "USER" && status === "COMPLETED"
      ? await transaction.query<{ readonly job_id: string }>(
          `select job_id::text
             from bridge_model_jobs
            where source_event_id=$1 and role='NODE' and kind='NODE_REPLY'`,
          [persisted.event_id],
        )
      : [];
    if (inserted && input.role === "USER" && status === "COMPLETED" && jobRows.length !== 1) {
      throw new Error("BRIDGE_JOB_BINDING_INVALID");
    }
    const bridgeJobId = completedJobs[0]?.job_id ?? jobRows[0]?.job_id ?? null;
    const message = mapAppendedMessage(persisted, input.text, {
      accountId: context.accountId,
      conversationId: conversation.id,
      nodeBrainId: conversation.node_brain_id,
    });
    return Object.freeze({ message, inserted, bridgeJobId });
  });
}

export async function appendMessage(
  context: ConversationHistoryContext,
  input: AppendMessageInput,
): Promise<AppendedMessage> {
  return (await appendMessageWithDisposition(context, input)).message;
}

export async function listMessages(
  context: ConversationHistoryContext,
  options: {
    readonly limit?: number;
    readonly after?: string | null;
  } = {},
): Promise<MessagePage> {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error("INVALID_MESSAGE_LIMIT");
  }

  // This scope check must run before any message metadata, ciphertext, or key query.
  await authorizeConversation(
    context.db,
    context.accountId,
    context.conversationId,
  );
  const afterEventId = options.after
    ? parseCursor(options.after, context)
    : null;
  const rows = await context.db.query<MessageRow>(
    `select m.event_id, m.role, m.status, m.occurred_at,
            m.completed_at, m.aborted_at, m.abort_reason
     from messages m
     where m.conversation_id=$1
       and m.account_id=$2
       and ($3::uuid is null or m.event_id > $3::uuid)
     order by m.event_id asc
     limit $4`,
    [context.conversationId, context.accountId, afterEventId, limit + 1],
  );
  const pageRows = rows.slice(0, limit);
  const items = await Promise.all(
    pageRows.map(async (row) => {
      const body = await readEventBody(context.db, row.event_id, {
        actor: { role: "ACCOUNT", accountId: context.accountId },
      });
      return mapMessageRow(row, textFromBody(body, row));
    }),
  );
  const nextCursor = rows.length > limit
    ? cursorFor(context, pageRows[pageRows.length - 1].event_id)
    : null;
  return { items, nextCursor };
}
