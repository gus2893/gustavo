import { createHash, randomBytes, randomUUID } from "node:crypto";
import editorialPolicy from "../../../policy/editorial-policy.json";
import type { EventDatabase } from "../events/types";

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

interface SessionRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly expiresAt: Date;
}

export interface RotatedSession {
  readonly id: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "strict";
  readonly path: "/";
  readonly expires?: Date;
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("INVALID_OPAQUE_TOKEN");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createSessionToken(now = new Date()): RotatedSession {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("INVALID_SESSION_TIME");
  }
  const token = generateOpaqueToken();
  return {
    id: randomUUID(),
    token,
    tokenHash: hashOpaqueToken(token),
    expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
  };
}

export function sessionCookieName(environment: string): string {
  return environment === "production" ? "__Host-gustavo-session" : "gustavo-session";
}

export function sessionCookieOptions(
  environment: string,
  expires?: Date,
): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: environment === "production",
    sameSite: "strict",
    path: "/",
    ...(expires ? { expires } : {}),
  };
}

export function assertRequestOrigin(
  request: Request,
  environment: string,
  configuredOrigin?: string,
): void {
  const allowedOrigin = configuredOrigin
    ?? (environment === "production" ? editorialPolicy.canonicalOrigin : "http://localhost:3000");
  let normalizedAllowedOrigin: string;
  try {
    normalizedAllowedOrigin = new URL(allowedOrigin).origin;
  } catch {
    throw new Error("INVALID_CONFIGURED_ORIGIN");
  }
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) {
    throw new Error("INVALID_ORIGIN");
  }
  try {
    if (new URL(suppliedOrigin).origin !== normalizedAllowedOrigin) {
      throw new Error("INVALID_ORIGIN");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_ORIGIN") {
      throw error;
    }
    throw new Error("INVALID_ORIGIN");
  }
}

export async function authenticateSession(
  database: EventDatabase,
  token: string,
  now = new Date(),
): Promise<AuthenticatedSession> {
  const rows = await database.query<SessionRow>(
    `select s.id, s.account_id, s.expires_at, s.revoked_at
     from sessions s
     join accounts a on a.id=s.account_id and a.status='ACTIVE'
     join entitlements e on e.account_id=s.account_id
     where s.token_hash=$1
       and s.revoked_at is null
       and s.expires_at > $2
       and e.revoked_at is null
       and e.active_from <= $2
       and (e.expires_at is null or e.expires_at > $2)`,
    [hashOpaqueToken(token), now],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("SESSION_INVALID");
  }
  return {
    sessionId: row.id,
    accountId: row.account_id,
    expiresAt: new Date(row.expires_at),
  };
}

export async function revokeSession(
  database: EventDatabase,
  token: string,
  now = new Date(),
): Promise<void> {
  const rows = await database.query<{ id: string }>(
    `update sessions set revoked_at=coalesce(revoked_at, $2)
     where token_hash=$1 returning id`,
    [hashOpaqueToken(token), now],
  );
  if (rows.length === 0) {
    throw new Error("SESSION_INVALID");
  }
}

export async function rotateSession(
  database: EventDatabase,
  token: string,
  now = new Date(),
): Promise<RotatedSession> {
  return database.transaction(async (transaction) => {
    const rows = await transaction.query<SessionRow>(
      `select s.id, s.account_id, s.expires_at, s.revoked_at
       from sessions s
       join accounts a on a.id=s.account_id and a.status='ACTIVE'
       join entitlements e on e.account_id=s.account_id
       where s.token_hash=$1
         and s.revoked_at is null
         and s.expires_at > $2
         and e.revoked_at is null
         and e.active_from <= $2
         and (e.expires_at is null or e.expires_at > $2)
       for update of s`,
      [hashOpaqueToken(token), now],
    );
    const current = rows[0];
    if (!current) {
      throw new Error("SESSION_INVALID");
    }
    const next = createSessionToken(now);
    await transaction.query(
      `insert into sessions
        (id, account_id, token_hash, created_at, expires_at, last_rotated_at)
       values ($1, $2, $3, $4, $5, $4)`,
      [next.id, current.account_id, next.tokenHash, now, next.expiresAt],
    );
    await transaction.query(
      `update sessions
       set revoked_at=$2, last_rotated_at=$2, replaced_by_session_id=$3
       where id=$1`,
      [current.id, now, next.id],
    );
    return next;
  });
}
