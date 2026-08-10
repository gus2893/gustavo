import {
  feedAuthorizationFilter,
  type ActorContext,
  type ActorRole,
} from "../auth/authorize";

export interface FeedEvent {
  readonly id: string;
  readonly accountId: string | null;
  readonly type: string;
  readonly createdAt: string;
  readonly topic: string;
  readonly protectedText?: string;
}

export interface PublicFeedDto {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly topic: string;
  readonly placeholder: true;
}

export interface AccountFeedDto {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly topic: string;
  readonly text: string | null;
}

export interface StaffFeedDto {
  readonly id: string;
  readonly accountId: string | null;
  readonly type: string;
  readonly createdAt: string;
  readonly topic: string;
  readonly text: string | null;
}

export type FeedDto = PublicFeedDto | AccountFeedDto | StaffFeedDto;

type PublicActorContext = Extract<ActorContext, { readonly role: "PUBLIC" }>;
type AccountActorContext = Extract<ActorContext, { readonly role: "ACCOUNT" }>;
type StaffActorContext = Extract<
  ActorContext,
  { readonly role: "MODERATOR" | "OPERATOR" }
>;

interface FeedRow extends Record<string, unknown> {
  readonly id: string;
  readonly account_id: string | null;
  readonly type: string;
  readonly created_at: Date | string;
  readonly topic: string;
}

export interface FeedQueryDatabase {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<Row[]>;
}

function assertNever(value: never): never {
  throw new Error(`UNSUPPORTED_ACTOR:${JSON.stringify(value)}`);
}

function staffDto(event: FeedEvent): StaffFeedDto {
  return {
    id: event.id,
    accountId: event.accountId,
    type: event.type,
    createdAt: event.createdAt,
    topic: event.topic,
    text: event.protectedText ?? null,
  };
}

export function projectFeedEvent(
  actor: PublicActorContext,
  event: FeedEvent,
): PublicFeedDto;
export function projectFeedEvent(
  actor: AccountActorContext,
  event: FeedEvent,
): AccountFeedDto;
export function projectFeedEvent(
  actor: StaffActorContext,
  event: FeedEvent,
): StaffFeedDto;
export function projectFeedEvent(
  actor: ActorContext,
  event: FeedEvent,
): FeedDto {
  // Validate scoped identifiers and staff purpose before projecting any body.
  feedAuthorizationFilter(actor);

  switch (actor.role) {
    case "PUBLIC":
      return {
        id: event.id,
        type: event.type,
        createdAt: event.createdAt,
        topic: event.topic,
        placeholder: true,
      };
    case "ACCOUNT":
      if (event.accountId !== actor.accountId) {
        throw new Error("FORBIDDEN");
      }
      return {
        id: event.id,
        type: event.type,
        createdAt: event.createdAt,
        topic: event.topic,
        text: event.protectedText ?? null,
      };
    case "MODERATOR":
    case "OPERATOR":
      return staffDto(event);
    default:
      return assertNever(actor);
  }
}

export function feedHeaders(role: ActorRole): Headers {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.set(
    "Cache-Control",
    role === "PUBLIC" ? "public, max-age=30" : "private, no-store",
  );
  return headers;
}

export async function queryFeedEvents(
  database: FeedQueryDatabase,
  actor: ActorContext,
  limit = 50,
): Promise<FeedEvent[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("INVALID_FEED_LIMIT");
  }
  const authorization = feedAuthorizationFilter(actor);
  const limitParameter = authorization.parameters.length + 1;
  const rows = await database.query<FeedRow>(
    `select e.id, e.account_id, e.type, e.occurred_at as created_at,
            e.type as topic
     from events e
     where ${authorization.clause}
     order by e.id desc
     limit $${limitParameter}`,
    [...authorization.parameters, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    createdAt: new Date(row.created_at).toISOString(),
    topic: row.topic,
    protectedText: undefined,
  }));
}
