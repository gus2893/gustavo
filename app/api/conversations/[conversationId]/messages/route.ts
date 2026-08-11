import {
  assertRequestOrigin,
  authenticateSession,
  sessionCookieName,
} from "../../../../../lib/server/auth/sessions";
import { getDatabase } from "../../../../../lib/server/db/postgres";
import {
  appendMessage,
  listMessages,
} from "../../../../../lib/server/history/messages";

interface RouteContext {
  readonly params: Promise<{ readonly conversationId: string }>;
}

interface ParticipantMessageBody {
  readonly idempotencyKey: string;
  readonly text: string;
}

function privateHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
}

function sessionToken(request: Request, environment: string): string {
  const cookieName = sessionCookieName(environment);
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (segment.slice(0, separator).trim() === cookieName) {
      const token = segment.slice(separator + 1).trim();
      if (token.length > 0) {
        return token;
      }
    }
  }
  throw new Error("SESSION_REQUIRED");
}

async function participantMessageBody(
  request: Request,
): Promise<ParticipantMessageBody> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("INVALID_MESSAGE_BODY");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_MESSAGE_BODY");
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.idempotencyKey !== "string"
    || typeof body.text !== "string"
  ) {
    throw new Error("INVALID_MESSAGE_BODY");
  }
  return {
    idempotencyKey: body.idempotencyKey,
    text: body.text,
  };
}

function routeFailure(error: unknown, operation: "READ" | "WRITE"): Response {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (
    code === "SESSION_REQUIRED"
    || code === "SESSION_INVALID"
    || code === "INVALID_OPAQUE_TOKEN"
  ) {
    return Response.json(
      { error: "UNAUTHORIZED" },
      { status: 401, headers: privateHeaders() },
    );
  }
  if (code === "FORBIDDEN") {
    return Response.json(
      { error: "FORBIDDEN" },
      { status: 403, headers: privateHeaders() },
    );
  }
  if (code === "INVALID_ORIGIN") {
    return Response.json(
      { error: "INVALID_ORIGIN" },
      { status: 403, headers: privateHeaders() },
    );
  }
  if (code === "IDEMPOTENCY_KEY_REUSED") {
    return Response.json(
      { error: "IDEMPOTENCY_KEY_REUSED" },
      { status: 409, headers: privateHeaders() },
    );
  }
  if (
    code === "INVALID_MESSAGE_BODY"
    || code === "INVALID_MESSAGE_TEXT"
    || code === "INVALID_MESSAGE_IDEMPOTENCY_KEY"
    || code === "INVALID_MESSAGE_LIMIT"
    || code === "INVALID_CURSOR"
    || code === "INVALID_CURSOR_SIGNATURE"
    || code === "INVALID_CURSOR_SCOPE"
  ) {
    return Response.json(
      { error: code },
      { status: 400, headers: privateHeaders() },
    );
  }
  return Response.json(
    { error: operation === "WRITE" ? "MESSAGE_WRITE_FAILED" : "HISTORY_READ_FAILED" },
    { status: 500, headers: privateHeaders() },
  );
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    assertRequestOrigin(
      request,
      environment,
      environment === "production" ? undefined : process.env.GUSTAVO_APP_ORIGIN,
    );
    const database = getDatabase();
    const session = await authenticateSession(
      database,
      sessionToken(request, environment),
    );
    const { conversationId } = await context.params;
    const body = await participantMessageBody(request);
    // appendMessage resolves only after its event, ciphertext, message metadata,
    // and transactional-outbox row have committed as one database transaction.
    const message = await appendMessage(
      { db: database, accountId: session.accountId, conversationId },
      {
        idempotencyKey: body.idempotencyKey,
        role: "USER",
        text: body.text,
      },
    );
    return Response.json(
      {
        eventId: message.eventId,
        role: message.role,
        status: message.status,
        occurredAt: message.occurredAt,
        completedAt: message.completedAt,
        abortedAt: message.abortedAt,
        abortReason: message.abortReason,
      },
      { status: 201, headers: privateHeaders() },
    );
  } catch (error) {
    return routeFailure(error, "WRITE");
  }
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    const database = getDatabase();
    const session = await authenticateSession(
      database,
      sessionToken(request, environment),
    );
    const { conversationId } = await context.params;
    const url = new URL(request.url);
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? undefined : Number(limitValue);
    const after = url.searchParams.get("after");
    const page = await listMessages(
      { db: database, accountId: session.accountId, conversationId },
      {
        ...(limit === undefined ? {} : { limit }),
        ...(after === null ? {} : { after }),
      },
    );
    return Response.json(page, { headers: privateHeaders() });
  } catch (error) {
    return routeFailure(error, "READ");
  }
}
