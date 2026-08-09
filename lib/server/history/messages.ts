import { appendEvent, readEventBody } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import { decodeOpaqueCursor, encodeOpaqueCursor } from "./cursor";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  return {
    eventId: row.event_id,
    role: row.role,
    text,
    status: row.status,
    occurredAt: iso(row.occurred_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    abortedAt: row.aborted_at === null ? null : iso(row.aborted_at),
    abortReason: row.abort_reason,
  };
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

export async function appendMessage(
  context: ConversationHistoryContext,
  input: AppendMessageInput,
): Promise<ConversationMessage> {
  const idempotencyKey = requireBoundedText(
    input.idempotencyKey,
    200,
    "INVALID_MESSAGE_IDEMPOTENCY_KEY",
  );
  requireBoundedText(input.text, 100_000, "INVALID_MESSAGE_TEXT");
  if (input.role !== "USER" && input.role !== "NODE") {
    throw new Error("INVALID_MESSAGE_ROLE");
  }

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

  return context.db.transaction(async (transaction) => {
    const conversation = await authorizeConversation(
      transaction,
      context.accountId,
      context.conversationId,
    );
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
      ...(explicitAt ? { occurredAt: explicitAt } : {}),
    });
    const completionAt = status === "COMPLETED"
      ? explicitAt ?? event.occurredAt
      : null;
    const abortedAt = status === "ABORTED"
      ? explicitAt ?? event.occurredAt
      : null;

    await transaction.query(
      `insert into messages (
        event_id, conversation_id, account_id, role, idempotency_key,
        status, occurred_at, completed_at, aborted_at, abort_reason
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict (conversation_id, idempotency_key) do nothing`,
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
    return mapMessageRow(persisted, input.text);
  });
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
