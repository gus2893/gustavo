import {
  argon2,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { appendEvent } from "../events/store";
import type { EventDatabase } from "../events/types";
import {
  createSessionToken,
  generateOpaqueToken,
  hashOpaqueToken,
} from "./sessions";

const ARGON2_MEMORY_KIB = 65_536;
const ARGON2_PASSES = 3;
const ARGON2_PARALLELISM = 4;
const ARGON2_TAG_BYTES = 32;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 1_024;

interface InvitationRow extends Record<string, unknown> {
  id: string;
  expires_at: Date;
  revoked_at: Date | null;
  redeemed_at: Date | null;
}

export interface InvitationServiceContext {
  readonly db: EventDatabase;
  readonly now?: Date;
  readonly passwordHasher?: (password: string) => Promise<string>;
  readonly operator?: {
    readonly id: string;
    readonly role: "OPERATOR";
  };
}

export interface InvitationIssueOptions {
  readonly expiresAt: Date;
}

export interface IssuedInvitation {
  readonly invitationId: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface RedemptionProfile {
  readonly displayName: string;
  readonly password: string;
}

export interface RedemptionResult {
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly conversationId: string;
  readonly sessionToken: string;
  readonly sessionExpiresAt: Date;
}

function currentTime(context: InvitationServiceContext): Date {
  const now = context.now ? new Date(context.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("INVALID_TIME");
  }
  return now;
}

function requireOperator(context: InvitationServiceContext): {
  readonly id: string;
  readonly role: "OPERATOR";
} {
  if (context.operator?.role !== "OPERATOR" || context.operator.id.trim().length === 0) {
    throw new Error("OPERATOR_REQUIRED");
  }
  return context.operator;
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim().replaceAll(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 80) {
    throw new Error("INVALID_DISPLAY_NAME");
  }
  return normalized;
}

function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error("INVALID_PASSWORD");
  }
}

function deriveArgon2id(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        parallelism: ARGON2_PARALLELISM,
        tagLength: ARGON2_TAG_BYTES,
        memory: ARGON2_MEMORY_KIB,
        passes: ARGON2_PASSES,
      },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await deriveArgon2id(password, salt);
  return [
    "",
    "argon2id",
    "v=19",
    `m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}`,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return false;
  }
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
    encodedHash,
  );
  if (!match) {
    return false;
  }
  const [memory, passes, parallelism] = match.slice(1, 4).map(Number);
  if (
    memory !== ARGON2_MEMORY_KIB
    || passes !== ARGON2_PASSES
    || parallelism !== ARGON2_PARALLELISM
  ) {
    return false;
  }
  const salt = Buffer.from(match[4], "base64url");
  const expected = Buffer.from(match[5], "base64url");
  if (salt.length !== 16 || expected.length !== ARGON2_TAG_BYTES) {
    return false;
  }
  const actual = await deriveArgon2id(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createInvitationToken(): { readonly token: string; readonly tokenHash: string } {
  const token = generateOpaqueToken();
  return { token, tokenHash: hashOpaqueToken(token) };
}

function assertInvitationEligible(invitation: InvitationRow, now: Date): void {
  if (invitation.redeemed_at) {
    throw new Error("INVITATION_ALREADY_REDEEMED");
  }
  if (invitation.revoked_at) {
    throw new Error("INVITATION_REVOKED");
  }
  if (new Date(invitation.expires_at) <= now) {
    throw new Error("INVITATION_EXPIRED");
  }
}

async function preflightInvitation(
  database: EventDatabase,
  tokenHash: string,
  now: Date,
): Promise<void> {
  const rows = await database.query<InvitationRow>(
    `select id, expires_at, revoked_at, redeemed_at
     from invitations where token_hash=$1`,
    [tokenHash],
  );
  const invitation = rows[0];
  if (!invitation) {
    throw new Error("INVITATION_INVALID");
  }
  assertInvitationEligible(invitation, now);
}

export async function issueInvitation(
  context: InvitationServiceContext,
  options: InvitationIssueOptions,
): Promise<IssuedInvitation> {
  const operator = requireOperator(context);
  const now = currentTime(context);
  const expiresAt = new Date(options.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new Error("INVALID_INVITATION_EXPIRY");
  }
  const invitationId = randomUUID();
  const generated = createInvitationToken();

  await context.db.transaction(async (transaction) => {
    await transaction.query(
      `insert into invitations
        (id, token_hash, issued_by_actor_id, issued_at, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [invitationId, generated.tokenHash, operator.id, now, expiresAt],
    );
    const event = await appendEvent(transaction, {
      aggregateId: "operator:invitations",
      actor: { type: "OPERATOR", id: operator.id },
      type: "invitation.issued",
      visibility: "OPERATOR",
      body: { invitationId, expiresAt: expiresAt.toISOString() },
      idempotencyKey: `invitation-issued:${invitationId}`,
      occurredAt: now,
      policyVersion: "editorial-policy-v1",
    });
    await transaction.query(
      "update invitations set issue_event_id=$2 where id=$1",
      [invitationId, event.id],
    );
  });

  return { invitationId, token: generated.token, expiresAt };
}

export async function revokeInvitation(
  context: InvitationServiceContext,
  invitationId: string,
): Promise<void> {
  const operator = requireOperator(context);
  const now = currentTime(context);
  await context.db.transaction(async (transaction) => {
    const updated = await transaction.query<{ id: string }>(
      `update invitations set revoked_at=coalesce(revoked_at, $2)
       where id=$1 and redeemed_at is null returning id`,
      [invitationId, now],
    );
    if (updated.length === 0) {
      throw new Error("INVITATION_NOT_REVOCABLE");
    }
    await appendEvent(transaction, {
      aggregateId: "operator:invitations",
      actor: { type: "OPERATOR", id: operator.id },
      type: "invitation.revoked",
      visibility: "OPERATOR",
      body: { invitationId },
      idempotencyKey: `invitation-revoked:${invitationId}`,
      occurredAt: now,
      policyVersion: "editorial-policy-v1",
    });
  });
}

export async function redeemInvitation(
  context: InvitationServiceContext,
  token: string,
  profile: RedemptionProfile,
): Promise<RedemptionResult> {
  const displayName = normalizeDisplayName(profile.displayName);
  validatePassword(profile.password);
  const tokenHash = hashOpaqueToken(token);
  const now = currentTime(context);
  await preflightInvitation(context.db, tokenHash, now);
  const passwordHash = await (context.passwordHasher ?? hashPassword)(profile.password);
  const accountId = randomUUID();
  const entitlementId = randomUUID();
  const nodeBrainId = randomUUID();
  const conversationId = randomUUID();

  const session = await context.db.transaction(async (transaction) => {
    const rows = await transaction.query<InvitationRow>(
      `select id, expires_at, revoked_at, redeemed_at
       from invitations where token_hash=$1 for update`,
      [tokenHash],
    );
    const invitation = rows[0];
    if (!invitation) {
      throw new Error("INVITATION_INVALID");
    }
    const clock = await transaction.one<{ now: Date }>(
      "select clock_timestamp() as now",
    );
    const transactionTime = new Date(clock.now);
    if (!Number.isFinite(transactionTime.getTime())) {
      throw new Error("INVALID_DATABASE_TIME");
    }
    assertInvitationEligible(invitation, transactionTime);
    const createdSession = createSessionToken(transactionTime);

    await transaction.query(
      "insert into accounts (id, display_name, created_at) values ($1, $2, $3)",
      [accountId, displayName, transactionTime],
    );
    await transaction.query(
      `insert into password_credentials (account_id, password_hash, created_at, updated_at)
       values ($1, $2, $3, $3)`,
      [accountId, passwordHash, transactionTime],
    );
    await transaction.query(
      `insert into entitlements (id, account_id, active_from, created_at)
       values ($1, $2, $3, $3)`,
      [entitlementId, accountId, transactionTime],
    );
    await transaction.query(
      `insert into node_brains (id, account_id, name, created_at)
       values ($1, $2, $3, $4)`,
      [nodeBrainId, accountId, `${displayName}'s Node Brain`, transactionTime],
    );
    await transaction.query(
      `insert into conversations (id, account_id, node_brain_id, created_at)
       values ($1, $2, $3, $4)`,
      [conversationId, accountId, nodeBrainId, transactionTime],
    );
    await transaction.query(
      `insert into sessions
        (id, account_id, token_hash, created_at, expires_at, last_rotated_at)
       values ($1, $2, $3, $4, $5, $4)`,
      [
        createdSession.id,
        accountId,
        createdSession.tokenHash,
        transactionTime,
        createdSession.expiresAt,
      ],
    );
    const redeemed = await transaction.query<{ id: string }>(
      `update invitations
       set redeemed_at=$2, redeemed_by_account_id=$3
       where id=$1 and redeemed_at is null and revoked_at is null and expires_at > $2
       returning id`,
      [invitation.id, transactionTime, accountId],
    );
    if (redeemed.length !== 1) {
      throw new Error("INVITATION_REDEMPTION_CONFLICT");
    }
    await appendEvent(transaction, {
      aggregateId: `account:${accountId}`,
      accountId,
      actor: { type: "SYSTEM", id: "identity-service" },
      type: "account.entitlement.activated",
      visibility: "PRIVATE_ACCOUNT",
      body: {
        accountId,
        conversationId,
        entitlementId,
        invitationId: invitation.id,
        nodeBrainId,
      },
      idempotencyKey: `invitation-redeemed:${invitation.id}`,
      occurredAt: transactionTime,
      policyVersion: "editorial-policy-v1",
    });
    return createdSession;
  });

  return {
    accountId,
    nodeBrainId,
    conversationId,
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt,
  };
}
