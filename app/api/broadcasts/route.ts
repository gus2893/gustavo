import {
  assertRequestOrigin,
  authenticateSession,
  sessionCookieName,
} from "../../../lib/server/auth/sessions";
import { getDatabase } from "../../../lib/server/db/postgres";
import {
  canonicalBroadcastLocale,
  projectDelivery,
} from "../../../lib/server/main-brain/broadcasts";

const MAX_DELIVERY_REQUEST_BYTES = 2_048;

interface DeliveryRequestBody {
  readonly broadcastId: string;
  readonly nodeBrainId: string;
  readonly locale: string;
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

function declaredBodyLength(request: Request): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) {
    return undefined;
  }
  if (!/^\d{1,12}$/.test(header)) {
    throw new Error("INVALID_BROADCAST_DELIVERY_BODY");
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new Error("INVALID_BROADCAST_DELIVERY_BODY");
  }
  if (length > MAX_DELIVERY_REQUEST_BYTES) {
    throw new Error("REQUEST_BODY_TOO_LARGE");
  }
  return length;
}

async function boundedBodyText(request: Request): Promise<string> {
  declaredBodyLength(request);
  if (!request.body) {
    throw new Error("INVALID_BROADCAST_DELIVERY_BODY");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > MAX_DELIVERY_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("REQUEST_BODY_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("INVALID_BROADCAST_DELIVERY_BODY");
  }
}

async function deliveryBody(request: Request): Promise<DeliveryRequestBody> {
  let value: unknown;
  try {
    value = JSON.parse(await boundedBodyText(request)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "REQUEST_BODY_TOO_LARGE") {
      throw error;
    }
    throw new Error("INVALID_BROADCAST_DELIVERY_BODY");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_BROADCAST_DELIVERY_BODY");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== "broadcastId"
    || keys[1] !== "locale"
    || keys[2] !== "nodeBrainId"
    || typeof record.broadcastId !== "string"
    || typeof record.nodeBrainId !== "string"
    || typeof record.locale !== "string"
  ) {
    throw new Error("INVALID_BROADCAST_DELIVERY_BODY");
  }
  return {
    broadcastId: record.broadcastId,
    nodeBrainId: record.nodeBrainId,
    locale: canonicalBroadcastLocale(record.locale),
  };
}

function routeFailure(error: unknown): Response {
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
  if (code === "INVALID_ORIGIN" || code === "BROADCAST_DELIVERY_FORBIDDEN") {
    return Response.json(
      { error: code },
      { status: 403, headers: privateHeaders() },
    );
  }
  if (code === "BROADCAST_NOT_FOUND") {
    return Response.json(
      { error: code },
      { status: 404, headers: privateHeaders() },
    );
  }
  if (code === "REQUEST_BODY_TOO_LARGE") {
    return Response.json(
      { error: code },
      { status: 413, headers: privateHeaders() },
    );
  }
  if (code === "IDEMPOTENCY_KEY_REUSED") {
    return Response.json(
      { error: code },
      { status: 409, headers: privateHeaders() },
    );
  }
  if (
    code === "INVALID_BROADCAST_DELIVERY_BODY"
    || code === "BROADCAST_DELIVERY_INPUT_INVALID"
  ) {
    return Response.json(
      { error: code === "BROADCAST_DELIVERY_INPUT_INVALID"
        ? "INVALID_BROADCAST_DELIVERY_BODY"
        : code },
      { status: 400, headers: privateHeaders() },
    );
  }
  return Response.json(
    { error: "BROADCAST_DELIVERY_FAILED" },
    { status: 500, headers: privateHeaders() },
  );
}

/**
 * Projects an already-committed Main broadcast into the authenticated account.
 * This route cannot accept, alter, or synthesize semantic broadcast content.
 */
export async function POST(request: Request): Promise<Response> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    assertRequestOrigin(
      request,
      environment,
      environment === "production" ? undefined : process.env.GUSTAVO_APP_ORIGIN,
    );
    // Size, shape, and bounded transport metadata are rejected before any
    // session/database work, preventing oversized requests from consuming it.
    const body = await deliveryBody(request);
    const database = getDatabase();
    const session = await authenticateSession(
      database,
      sessionToken(request, environment),
    );
    const delivery = await projectDelivery(
      { db: database },
      body.broadcastId,
      {
        accountId: session.accountId,
        nodeBrainId: body.nodeBrainId,
        locale: body.locale,
      },
    );
    return Response.json(delivery, { status: 201, headers: privateHeaders() });
  } catch (error) {
    return routeFailure(error);
  }
}
