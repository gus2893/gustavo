import { issueInvitation } from "../lib/server/auth/invitations";
import { closeDatabase, getDatabase } from "../lib/server/db/postgres";

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
  const expiresAt = parseExpiry(process.argv[2]);
  try {
    const invitation = await issueInvitation(
      {
        db: getDatabase(),
        operator: { id: operatorId, role: "OPERATOR" },
      },
      { expiresAt },
    );
    // The raw bearer token is intentionally emitted exactly once and is never persisted.
    process.stdout.write(`${invitation.token}\n`);
  } finally {
    await closeDatabase();
  }
}

await main();
