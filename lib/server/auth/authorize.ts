export type ActorContext =
  | { readonly role: "PUBLIC" }
  | { readonly role: "ACCOUNT"; readonly accountId: string }
  | {
      readonly role: "MODERATOR";
      readonly actorId: string;
      readonly purpose: string;
    }
  | {
      readonly role: "OPERATOR";
      readonly actorId: string;
      readonly purpose: string;
    };

export type ActorRole = ActorContext["role"];

export interface AuthorizationQueryFilter {
  readonly clause: string;
  readonly parameters: readonly unknown[];
}

function requireIdentifier(value: string, error: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(error);
  }
  return normalized;
}

function assertNever(value: never): never {
  throw new Error(`UNSUPPORTED_ACTOR:${JSON.stringify(value)}`);
}

/**
 * Converts an actor into the filter that must be applied by the database query.
 * Callers must not fetch a broader result set and filter it in application code.
 */
export function feedAuthorizationFilter(
  actor: ActorContext,
): AuthorizationQueryFilter {
  switch (actor.role) {
    case "PUBLIC":
      return { clause: "e.visibility = 'PUBLIC'", parameters: [] };
    case "ACCOUNT":
      return {
        clause:
          "(e.account_id = $1 and e.visibility in ('PRIVATE_ACCOUNT', 'SHARED'))",
        parameters: [requireIdentifier(actor.accountId, "ACCOUNT_ID_REQUIRED")],
      };
    case "MODERATOR":
      requireIdentifier(actor.actorId, "ACTOR_ID_REQUIRED");
      requireIdentifier(actor.purpose, "PURPOSE_REQUIRED");
      return {
        clause: "e.visibility in ('PUBLIC', 'PRIVATE_ACCOUNT', 'SHARED')",
        parameters: [],
      };
    case "OPERATOR":
      requireIdentifier(actor.actorId, "ACTOR_ID_REQUIRED");
      requireIdentifier(actor.purpose, "PURPOSE_REQUIRED");
      return {
        clause:
          "e.visibility in ('PUBLIC', 'PRIVATE_ACCOUNT', 'SHARED', 'OPERATOR')",
        parameters: [],
      };
    default:
      return assertNever(actor);
  }
}
