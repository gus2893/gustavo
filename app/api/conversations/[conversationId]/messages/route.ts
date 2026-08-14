import { Client } from "@upstash/qstash";
import {
  assertRequestOrigin,
  authenticateSession,
  sessionCookieName,
} from "../../../../../lib/server/auth/sessions";
import { getDatabase } from "../../../../../lib/server/db/postgres";
import {
  appendMessageWithDisposition,
  listMessages,
} from "../../../../../lib/server/history/messages";
import { publishOpaqueWake } from "../../../../../lib/server/bridge/qstash";

interface RouteContext {
  readonly params: Promise<{ readonly conversationId: string }>;
}

interface ParticipantMessageBody {
  readonly idempotencyKey: string;
  readonly text: string;
}

const FUNNEL_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HYBRID_WAKE_TIMEOUT_MS = 2_000;

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

async function publishCommittedNodeWake(jobId: string): Promise<void> {
  const token = process.env.QSTASH_TOKEN;
  const destinationUrl = canonicalFunnelWakeUrl(process.env.GUSTAVO_HYBRID_WAKE_URL);
  if (!token) throw new Error("HYBRID_WAKE_UNAVAILABLE");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      publishOpaqueWake(new Client({ token }), destinationUrl, { jobId }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("HYBRID_WAKE_TIMEOUT")),
          HYBRID_WAKE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function canonicalFunnelWakeUrl(value: string | undefined): string {
  if (!value || value.includes("?") || value.includes("#")) {
    throw new Error("HYBRID_WAKE_UNAVAILABLE");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HYBRID_WAKE_UNAVAILABLE");
  }
  const labels = url.hostname.split(".");
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.pathname !== "/wake"
    || url.search !== ""
    || url.hash !== ""
    || url.href !== value
    || labels.length < 4
    || labels.at(-2) !== "ts"
    || labels.at(-1) !== "net"
    || labels.slice(0, -2).some((label) => !FUNNEL_HOST_LABEL.test(label))
  ) {
    throw new Error("HYBRID_WAKE_UNAVAILABLE");
  }
  return value;
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
    const appended = await appendMessageWithDisposition(
      { db: database, accountId: session.accountId, conversationId },
      {
        idempotencyKey: body.idempotencyKey,
        role: "USER",
        text: body.text,
      },
    );
    const message = appended.message;
    const acknowledgement = {
      eventId: message.eventId,
      role: message.role,
      status: message.status,
      occurredAt: message.occurredAt,
      completedAt: message.completedAt,
      abortedAt: message.abortedAt,
      abortReason: message.abortReason,
    } as const;
    if (process.env.GUSTAVO_HYBRID_BRIDGE_ENABLED === "true" && appended.inserted) {
      try {
        if (!appended.bridgeJobId) throw new Error("HYBRID_WAKE_JOB_INVALID");
        await publishCommittedNodeWake(appended.bridgeJobId);
      } catch {
        return Response.json(
          { ...acknowledgement, queued: true },
          { status: 202, headers: privateHeaders() },
        );
      }
    }
    return Response.json(acknowledgement, { status: 201, headers: privateHeaders() });
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
