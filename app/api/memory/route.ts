import {
  assertRequestOrigin,
  authenticateSession,
  sessionCookieName,
} from "../../../lib/server/auth/sessions";
import { getDatabase } from "../../../lib/server/db/postgres";
import {
  archiveConversation,
  correctMemory,
  inspectMemorySource,
  listAccountMemories,
  type PrivacyActor,
  type PrivacyCapability,
} from "../../../lib/server/memory/controls";
import { forgetConversation, getForgetStatus } from "../../../lib/server/memory/forget";

const MAX_MEMORY_REQUEST_BYTES = 131_072;
const MAX_CURSOR_LENGTH = 4_096;

function privateHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
}

function sessionToken(request: Request, environment: string): string {
  const cookieName = sessionCookieName(environment);
  for (const segment of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = segment.indexOf("=");
    if (separator >= 0 && segment.slice(0, separator).trim() === cookieName) {
      const token = segment.slice(separator + 1).trim();
      if (token.length > 0) return token;
    }
  }
  throw new Error("SESSION_REQUIRED");
}

function owner(
  accountId: string,
  sessionId: string,
  capability: PrivacyCapability,
): PrivacyActor {
  return Object.freeze({ kind: "ACCOUNT_OWNER", accountId, sessionId, capability });
}

function assertSameOrigin(request: Request, environment: string): void {
  assertRequestOrigin(
    request,
    environment,
    environment === "production" ? undefined : process.env.GUSTAVO_APP_ORIGIN,
  );
}

function routeFailure(error: unknown): Response {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (["SESSION_REQUIRED", "SESSION_INVALID", "INVALID_OPAQUE_TOKEN"].includes(code)) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: privateHeaders() });
  }
  if (code === "INVALID_ORIGIN" || code === "FORBIDDEN") {
    return Response.json({ error: "FORBIDDEN" }, { status: 403, headers: privateHeaders() });
  }
  if (code === "CONTENT_FORGOTTEN" || code === "EVENT_KEY_UNAVAILABLE") {
    return Response.json({ error: "CONTENT_UNAVAILABLE" }, { status: 410, headers: privateHeaders() });
  }
  if (code === "REQUEST_BODY_TOO_LARGE") {
    return Response.json({ error: code }, { status: 413, headers: privateHeaders() });
  }
  if (code === "UNSUPPORTED_MEDIA_TYPE") {
    return Response.json({ error: code }, { status: 415, headers: privateHeaders() });
  }
  if (code === "IDEMPOTENCY_KEY_REUSED") {
    return Response.json({ error: "REQUEST_CONFLICT" }, { status: 409, headers: privateHeaders() });
  }
  if (code.startsWith("INVALID_") || code === "MEMORY_REQUEST_INVALID") {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400, headers: privateHeaders() });
  }
  return Response.json({ error: "MEMORY_REQUEST_FAILED" }, { status: 500, headers: privateHeaders() });
}

function one(search: URLSearchParams, name: string, required = false): string | undefined {
  const values = search.getAll(name);
  if (values.length > 1 || (required && values.length !== 1)) {
    throw new Error("INVALID_MEMORY_REQUEST");
  }
  const value = values[0];
  if (value !== undefined && (value.length === 0 || value.length > MAX_CURSOR_LENGTH)) {
    throw new Error("INVALID_MEMORY_REQUEST");
  }
  return value;
}

function limit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]?$/u.test(value)) throw new Error("INVALID_MEMORY_REQUEST");
  const parsed = Number(value);
  if (parsed > 50) throw new Error("INVALID_MEMORY_REQUEST");
  return parsed;
}

function assertOnly(search: URLSearchParams, names: readonly string[]): void {
  const allowed = new Set(names);
  for (const key of search.keys()) {
    if (!allowed.has(key)) throw new Error("INVALID_MEMORY_REQUEST");
  }
}

async function boundedJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      !== "application/json") throw new Error("UNSUPPORTED_MEDIA_TYPE");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,12}$/u.test(declared) || Number(declared) > MAX_MEMORY_REQUEST_BYTES) {
      throw new Error(Number(declared) > MAX_MEMORY_REQUEST_BYTES
        ? "REQUEST_BODY_TOO_LARGE" : "INVALID_MEMORY_REQUEST");
    }
  }
  if (!request.body) throw new Error("INVALID_MEMORY_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_MEMORY_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("REQUEST_BODY_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("INVALID_MEMORY_REQUEST");
  }
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_MEMORY_REQUEST");
  }
  return value as Record<string, unknown>;
}

function assertBodyShape(
  body: Record<string, unknown>,
  required: readonly string[],
): void {
  const allowed = new Set(["action", ...required]);
  if (Object.keys(body).some((key) => !allowed.has(key))
      || required.some((key) => !Object.hasOwn(body, key))) {
    throw new Error("INVALID_MEMORY_REQUEST");
  }
  for (const key of required) {
    if (typeof body[key] !== "string") throw new Error("INVALID_MEMORY_REQUEST");
  }
}

export async function GET(request: Request): Promise<Response> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    assertSameOrigin(request, environment);
    const database = getDatabase();
    const session = await authenticateSession(database, sessionToken(request, environment));
    const search = new URL(request.url).searchParams;
    const requestId = one(search, "requestId");
    if (requestId !== undefined) {
      assertOnly(search, ["requestId"]);
      const status = await getForgetStatus({ db: database }, {
        actor: owner(session.accountId, session.sessionId, "FORGET_CONVERSATION"), requestId,
      });
      return Response.json(status, { headers: privateHeaders() });
    }
    assertOnly(search, ["conversationId", "cursor", "limit", "memoryId", "sourceEventId"]);
    const conversationId = one(search, "conversationId", true)!;
    const memoryId = one(search, "memoryId");
    const sourceEventId = one(search, "sourceEventId");
    const actor = owner(session.accountId, session.sessionId, "INSPECT_MEMORY");
    if (memoryId !== undefined || sourceEventId !== undefined) {
      if (memoryId === undefined || sourceEventId === undefined
          || one(search, "cursor") !== undefined || one(search, "limit") !== undefined) {
        throw new Error("INVALID_MEMORY_REQUEST");
      }
      const result = await inspectMemorySource({ db: database }, {
        actor, conversationId, memoryId, sourceEventId,
      });
      return Response.json(result, { headers: privateHeaders() });
    }
    const result = await listAccountMemories({ db: database }, {
      actor, conversationId, cursor: one(search, "cursor"), limit: limit(one(search, "limit")),
    });
    return Response.json(result, { headers: privateHeaders() });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    assertSameOrigin(request, environment);
    const database = getDatabase();
    const session = await authenticateSession(database, sessionToken(request, environment));
    const body = bodyRecord(await boundedJson(request));
    if (body.action === "CORRECT") {
      assertBodyShape(body, ["conversationId", "memoryId", "correctedText", "reason", "idempotencyKey"]);
      const result = await correctMemory({ db: database }, {
        actor: owner(session.accountId, session.sessionId, "CORRECT_MEMORY"),
        conversationId: body.conversationId as string,
        memoryId: body.memoryId as string,
        correctedText: body.correctedText as string,
        reason: body.reason as string,
        idempotencyKey: body.idempotencyKey as string,
      });
      return Response.json(result, { status: 201, headers: privateHeaders() });
    }
    if (body.action === "ARCHIVE" || body.action === "RESTORE") {
      assertBodyShape(body, ["conversationId", "idempotencyKey"]);
      const result = await archiveConversation({ db: database }, {
        actor: owner(session.accountId, session.sessionId, "ARCHIVE_CONVERSATION"),
        conversationId: body.conversationId as string,
        archived: body.action === "ARCHIVE",
        idempotencyKey: body.idempotencyKey as string,
      });
      return Response.json(result, { headers: privateHeaders() });
    }
    if (body.action === "FORGET") {
      assertBodyShape(body, ["conversationId", "idempotencyKey"]);
      const result = await forgetConversation({ db: database }, {
        actor: owner(session.accountId, session.sessionId, "FORGET_CONVERSATION"),
        accountId: session.accountId,
        conversationId: body.conversationId as string,
        idempotencyKey: body.idempotencyKey as string,
      });
      return Response.json(result, { status: 202, headers: privateHeaders() });
    }
    throw new Error("INVALID_MEMORY_REQUEST");
  } catch (error) {
    return routeFailure(error);
  }
}
