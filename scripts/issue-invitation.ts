import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { issueInvitation } from "../lib/server/auth/invitations";
import type {
  InvitationIssueOptions,
  InvitationServiceContext,
} from "../lib/server/auth/invitations";
import {
  hashOpaqueToken,
  resolveApplicationOrigin,
} from "../lib/server/auth/sessions";
import { closeDatabase, getDatabase } from "../lib/server/db/postgres";

const CANONICAL_PRODUCTION_ORIGIN = "https://gustavo.lol";

export interface IssuedRedemptionInvitation {
  readonly redemptionUrl: string;
  readonly expiresAt: string;
}

function assertInvitationCanonicalOrigin(canonicalOrigin: string): void {
  if (canonicalOrigin !== CANONICAL_PRODUCTION_ORIGIN
      || resolveApplicationOrigin("production", {
        GUSTAVO_DEPLOYMENT_PROFILE: "public-production-v1",
      }) !== canonicalOrigin) {
    throw new Error("INVITATION_CANONICAL_ORIGIN_INVALID");
  }
}

export function createInvitationRedemptionUrl(
  canonicalOrigin: string,
  token: string,
): string {
  assertInvitationCanonicalOrigin(canonicalOrigin);
  hashOpaqueToken(token);
  const url = new URL("/join", canonicalOrigin);
  url.searchParams.set("token", token);
  return url.toString();
}

export async function issueInvitationRedemptionUrl(
  context: InvitationServiceContext,
  options: InvitationIssueOptions,
  canonicalOrigin: string,
): Promise<IssuedRedemptionInvitation> {
  assertInvitationCanonicalOrigin(canonicalOrigin);
  const invitation = await issueInvitation(context, options);
  return {
    redemptionUrl: createInvitationRedemptionUrl(canonicalOrigin, invitation.token),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

function requireOperatorId(): string {
  const operatorId = process.env.GUSTAVO_OPERATOR_ID?.trim();
  if (!operatorId) {
    throw new Error("GUSTAVO_OPERATOR_ID_REQUIRED");
  }
  return operatorId;
}

function parseExpiry(argument: string | undefined): Date {
  if (!argument) {
    throw new Error("USAGE: pnpm invitation:issue <expiry-iso-8601>");
  }
  const expiresAt = new Date(argument);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("INVALID_INVITATION_EXPIRY");
  }
  return expiresAt;
}

async function main(): Promise<void> {
  const operatorId = requireOperatorId();
  const redemptionUrlMode = process.argv[2] === "--redemption-url";
  const expiresAt = parseExpiry(process.argv[redemptionUrlMode ? 3 : 2]);
  try {
    const context = {
      db: getDatabase(),
      operator: { id: operatorId, role: "OPERATOR" as const },
    };
    const invitation = redemptionUrlMode
      ? await issueInvitationRedemptionUrl(
        context,
        { expiresAt },
        resolveApplicationOrigin("production"),
      )
      : await issueInvitation(context, { expiresAt });
    // The selected bearer output is emitted exactly once and is never persisted.
    process.stdout.write(`${"redemptionUrl" in invitation
      ? invitation.redemptionUrl
      : invitation.token}\n`);
  } finally {
    await closeDatabase();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined
    && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch(() => {
    process.stderr.write("INVITATION_ISSUE_FAILED\n");
    process.exitCode = 1;
  });
}
