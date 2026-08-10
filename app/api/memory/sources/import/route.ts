import {
  assertRequestOrigin,
  authenticateSession,
  sessionCookieName,
} from "../../../../../lib/server/auth/sessions";
import { importChatManifest } from "../../../../../lib/server/chat-sources/import";
import { CHAT_IMPORT_LIMITS } from "../../../../../lib/server/chat-sources/contracts";
import { getDatabase } from "../../../../../lib/server/db/postgres";

const MAX_IMPORT_REQUEST_BYTES = CHAT_IMPORT_LIMITS.maximumManifestBytes;

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

function checkDeclaredLength(request: Request): void {
  const value = request.headers.get("content-length");
  if (value === null) return;
  if (!/^\d{1,12}$/u.test(value)) throw new Error("INVALID_CHAT_IMPORT_BODY");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new Error("INVALID_CHAT_IMPORT_BODY");
  if (length > MAX_IMPORT_REQUEST_BYTES) throw new Error("REQUEST_BODY_TOO_LARGE");
}

function checkDeclaredRequest(request: Request): void {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      !== "application/json") {
    throw new Error("UNSUPPORTED_MEDIA_TYPE");
  }
  checkDeclaredLength(request);
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("INVALID_CHAT_IMPORT_BODY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_IMPORT_REQUEST_BYTES) {
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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("INVALID_CHAT_IMPORT_BODY");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("INVALID_CHAT_IMPORT_BODY");
  }
}

function routeFailure(error: unknown): Response {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (["SESSION_REQUIRED", "SESSION_INVALID", "INVALID_OPAQUE_TOKEN"].includes(code)) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: privateHeaders() });
  }
  if (code === "INVALID_ORIGIN" || code === "SOURCE_NOT_AUTHORIZED") {
    return Response.json({ error: code }, { status: 403, headers: privateHeaders() });
  }
  if (code === "REQUEST_BODY_TOO_LARGE" || code === "CHAT_MANIFEST_TOO_LARGE") {
    return Response.json({ error: "REQUEST_BODY_TOO_LARGE" }, { status: 413, headers: privateHeaders() });
  }
  if (code === "UNSUPPORTED_MEDIA_TYPE") {
    return Response.json({ error: code }, { status: 415, headers: privateHeaders() });
  }
  if (code === "CHAT_CURSOR_CONTENT_CONFLICT") {
    return Response.json({ error: code }, { status: 409, headers: privateHeaders() });
  }
  if (code === "INVALID_CHAT_IMPORT_BODY" || code.startsWith("INVALID_CHAT_")) {
    return Response.json({ error: "INVALID_CHAT_IMPORT_BODY" }, { status: 400, headers: privateHeaders() });
  }
  if (code === "UNSUPPORTED_CHAT_SOURCE_FORMAT" || code === "CHAT_MANIFEST_COUNT_MISMATCH") {
    return Response.json({ error: "INVALID_CHAT_IMPORT_BODY" }, { status: 400, headers: privateHeaders() });
  }
  return Response.json({ error: "CHAT_IMPORT_FAILED" }, { status: 500, headers: privateHeaders() });
}

/** Imports a supplied export manifest only; it has no connector, model, or Main-memory capability. */
export async function POST(request: Request): Promise<Response> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    assertRequestOrigin(
      request,
      environment,
      environment === "production" ? undefined : process.env.GUSTAVO_APP_ORIGIN,
    );
    checkDeclaredRequest(request);
    const database = getDatabase();
    const session = await authenticateSession(database, sessionToken(request, environment));
    const body = await boundedJson(request);
    const result = await importChatManifest(
      { db: database, requesterAccountId: session.accountId },
      body,
    );
    return Response.json(result, { status: 201, headers: privateHeaders() });
  } catch (error) {
    return routeFailure(error);
  }
}
