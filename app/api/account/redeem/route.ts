import { NextResponse } from "next/server";
import { redeemInvitation } from "../../../../lib/server/auth/invitations";
import {
  assertRequestOrigin,
  sessionCookieName,
  sessionCookieOptions,
} from "../../../../lib/server/auth/sessions";
import { getDatabase } from "../../../../lib/server/db/postgres";

interface RedeemBody {
  readonly token: string;
  readonly displayName: string;
  readonly password: string;
}

function parseRedeemBody(value: unknown): RedeemBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_REDEMPTION_BODY");
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.token !== "string"
    || typeof body.displayName !== "string"
    || typeof body.password !== "string"
  ) {
    throw new Error("INVALID_REDEMPTION_BODY");
  }
  return {
    token: body.token,
    displayName: body.displayName,
    password: body.password,
  };
}

async function readRedeemBody(request: Request): Promise<RedeemBody> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Error("INVALID_REDEMPTION_BODY");
  }
  return parseRedeemBody(value);
}

function redemptionFailure(error: unknown): NextResponse {
  const code = error instanceof Error ? error.message : "REDEMPTION_FAILED";
  const clientFailures: Readonly<Record<string, {
    readonly status: number;
    readonly publicCode: string;
  }>> = {
    INVALID_ORIGIN: { status: 403, publicCode: "INVALID_ORIGIN" },
    INVALID_REDEMPTION_BODY: { status: 400, publicCode: "INVALID_REDEMPTION_BODY" },
    INVALID_DISPLAY_NAME: { status: 400, publicCode: "INVALID_DISPLAY_NAME" },
    INVALID_PASSWORD: { status: 400, publicCode: "INVALID_PASSWORD" },
    INVALID_OPAQUE_TOKEN: { status: 400, publicCode: "INVITATION_INVALID" },
    INVITATION_INVALID: { status: 400, publicCode: "INVITATION_INVALID" },
    INVITATION_ALREADY_REDEEMED: { status: 409, publicCode: "INVITATION_ALREADY_REDEEMED" },
    INVITATION_EXPIRED: { status: 410, publicCode: "INVITATION_EXPIRED" },
    INVITATION_REVOKED: { status: 410, publicCode: "INVITATION_REVOKED" },
  };
  const clientFailure = clientFailures[code];
  if (clientFailure) {
    return NextResponse.json(
      { error: clientFailure.publicCode },
      { status: clientFailure.status },
    );
  }
  return NextResponse.json(
    { error: "REDEMPTION_FAILED" },
    { status: 500 },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    assertRequestOrigin(
      request,
      environment,
      environment === "production" ? undefined : process.env.GUSTAVO_APP_ORIGIN,
    );
    const body = await readRedeemBody(request);
    const result = await redeemInvitation(
      { db: getDatabase() },
      body.token,
      { displayName: body.displayName, password: body.password },
    );
    const response = NextResponse.json(
      {
        accountId: result.accountId,
        nodeBrainId: result.nodeBrainId,
        conversationId: result.conversationId,
      },
      { status: 201 },
    );
    response.cookies.set(
      sessionCookieName(environment),
      result.sessionToken,
      sessionCookieOptions(environment, result.sessionExpiresAt),
    );
    return response;
  } catch (error) {
    return redemptionFailure(error);
  }
}
