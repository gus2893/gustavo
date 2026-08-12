import {
  assertRequestOrigin,
  authenticateSession,
  sessionCookieName,
} from "../../../../lib/server/auth/sessions";
import editorialPolicy from "../../../../policy/editorial-policy.json";
import { getDatabase } from "../../../../lib/server/db/postgres";
import { exportAccountData } from "../../../../lib/server/memory/controls";

const MAX_EXPORT_CURSOR_LENGTH = 4_096;

function privateHeaders(filename?: string): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...(filename === undefined ? {} : {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
    }),
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

function parameter(search: URLSearchParams, name: string): string | undefined {
  const values = search.getAll(name);
  if (values.length > 1) throw new Error("INVALID_EXPORT_REQUEST");
  const value = values[0];
  if (value !== undefined && (value.length === 0 || value.length > MAX_EXPORT_CURSOR_LENGTH)) {
    throw new Error("INVALID_EXPORT_REQUEST");
  }
  return value;
}

function pageLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]?$/u.test(value) || Number(value) > 50) {
    throw new Error("INVALID_EXPORT_REQUEST");
  }
  return Number(value);
}

function assertSafeSameOriginGet(request: Request, environment: string): void {
  const configuredOrigin = environment === "production"
    ? editorialPolicy.canonicalOrigin
    : process.env.GUSTAVO_APP_ORIGIN ?? "http://localhost:3000";
  let allowed: URL;
  let requested: URL;
  try {
    allowed = new URL(configuredOrigin);
    requested = new URL(request.url);
  } catch {
    throw new Error("INVALID_ORIGIN");
  }
  if (requested.origin !== allowed.origin) throw new Error("INVALID_ORIGIN");
  const suppliedHost = request.headers.get("host");
  if (suppliedHost !== null && suppliedHost.toLowerCase() !== allowed.host.toLowerCase()) {
    throw new Error("INVALID_ORIGIN");
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    assertRequestOrigin(
      request,
      environment,
      environment === "production" ? undefined : process.env.GUSTAVO_APP_ORIGIN,
    );
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      throw new Error("INVALID_ORIGIN");
    }
    return;
  }
  if (suppliedHost === null
      || request.headers.get("sec-fetch-site") !== "same-origin"
      || !["cors", "same-origin"].includes(request.headers.get("sec-fetch-mode") ?? "")
      || request.headers.get("sec-fetch-dest") !== "empty") {
    throw new Error("INVALID_ORIGIN");
  }
}

function routeFailure(error: unknown): Response {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (["SESSION_REQUIRED", "SESSION_INVALID", "INVALID_OPAQUE_TOKEN"].includes(code)) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: privateHeaders() });
  }
  if (code === "INVALID_ORIGIN" || code === "FORBIDDEN") {
    return Response.json({ error: "FORBIDDEN" }, { status: 403, headers: privateHeaders() });
  }
  if (code === "EXPORT_SNAPSHOT_EXPIRED") {
    return Response.json({ error: "EXPORT_SNAPSHOT_EXPIRED" }, {
      status: 410, headers: privateHeaders(),
    });
  }
  if (code.startsWith("INVALID_") || code === "CONTENT_FORGOTTEN") {
    return Response.json({ error: "INVALID_EXPORT_REQUEST" }, {
      status: 400, headers: privateHeaders(),
    });
  }
  return Response.json({ error: "ACCOUNT_EXPORT_FAILED" }, {
    status: 500, headers: privateHeaders(),
  });
}

/** Streams one bounded, snapshot-stable data-portability page; it never exports trade data. */
export async function GET(request: Request): Promise<Response> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    assertSafeSameOriginGet(request, environment);
    const search = new URL(request.url).searchParams;
    for (const key of search.keys()) {
      if (key !== "cursor" && key !== "limit") throw new Error("INVALID_EXPORT_REQUEST");
    }
    const cursor = parameter(search, "cursor");
    const limit = pageLimit(parameter(search, "limit"));
    const database = getDatabase();
    const session = await authenticateSession(database, sessionToken(request, environment));
    const page = await exportAccountData({ db: database }, {
      actor: {
        kind: "ACCOUNT_OWNER",
        accountId: session.accountId,
        sessionId: session.sessionId,
        capability: "EXPORT_DATA",
      },
      cursor,
      limit,
    });
    return Response.json(page, {
      headers: privateHeaders(`gustavo-account-export-${page.manifest.snapshotId}.json`),
    });
  } catch (error) {
    return routeFailure(error);
  }
}
