import {
  assertRequestOrigin,
  authenticateSession,
  sessionCookieName,
} from "../../../lib/server/auth/sessions";
import { getDatabase } from "../../../lib/server/db/postgres";
import {
  createProposal,
  type CreateProposalInput,
} from "../../../lib/server/orchestration/proposals";

const MAX_PROPOSAL_REQUEST_BYTES = 16_384;
const REQUIRED_KEYS = [
  "affectedMainStateIds",
  "conversationId",
  "counterevidence",
  "evidence",
  "idempotencyKey",
  "nodeBrainId",
  "privacyScope",
  "proposedChange",
  "routeEventId",
  "sourceEventIds",
  "uncertainty",
] as const;
const OPTIONAL_KEYS = ["disclosureAuthorizationId", "rawPrivateText"] as const;
const ALLOWED_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

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
  const header = request.headers.get("content-length");
  if (header === null) return;
  if (!/^\d{1,12}$/.test(header)) throw new Error("INVALID_PROPOSAL_BODY");
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new Error("INVALID_PROPOSAL_BODY");
  if (length > MAX_PROPOSAL_REQUEST_BYTES) throw new Error("REQUEST_BODY_TOO_LARGE");
}

async function boundedBodyText(request: Request): Promise<string> {
  checkDeclaredLength(request);
  if (!request.body) throw new Error("INVALID_PROPOSAL_BODY");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_PROPOSAL_REQUEST_BYTES) {
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
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("INVALID_PROPOSAL_BODY");
  }
}

interface RouteProposalBody extends Omit<CreateProposalInput, "accountId"> {}

async function proposalBody(request: Request): Promise<RouteProposalBody> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new Error("UNSUPPORTED_MEDIA_TYPE");
  }
  let value: unknown;
  try {
    value = JSON.parse(await boundedBodyText(request)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "REQUEST_BODY_TOO_LARGE") throw error;
    throw new Error("INVALID_PROPOSAL_BODY");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_PROPOSAL_BODY");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key) => !ALLOWED_KEYS.has(key))
    || REQUIRED_KEYS.some((key) => !Object.hasOwn(record, key))
    || typeof record.nodeBrainId !== "string"
    || typeof record.conversationId !== "string"
    || typeof record.routeEventId !== "string"
    || !Array.isArray(record.affectedMainStateIds)
    || (record.privacyScope !== "PROPOSAL_SUMMARY" && record.privacyScope !== "PROPOSAL_RAW_TEXT")
    || !Array.isArray(record.sourceEventIds)
    || typeof record.proposedChange !== "string"
    || !Array.isArray(record.evidence)
    || !Array.isArray(record.counterevidence)
    || typeof record.uncertainty !== "string"
    || typeof record.idempotencyKey !== "string"
    || (record.rawPrivateText !== undefined && typeof record.rawPrivateText !== "string")
    || (record.disclosureAuthorizationId !== undefined && typeof record.disclosureAuthorizationId !== "string")
  ) {
    throw new Error("INVALID_PROPOSAL_BODY");
  }
  return {
    nodeBrainId: record.nodeBrainId,
    conversationId: record.conversationId,
    routeEventId: record.routeEventId,
    affectedMainStateIds: record.affectedMainStateIds as string[],
    privacyScope: record.privacyScope,
    sourceEventIds: record.sourceEventIds as string[],
    proposedChange: record.proposedChange,
    evidence: record.evidence as CreateProposalInput["evidence"],
    counterevidence: record.counterevidence as CreateProposalInput["counterevidence"],
    uncertainty: record.uncertainty,
    idempotencyKey: record.idempotencyKey,
    ...(record.rawPrivateText === undefined ? {} : { rawPrivateText: record.rawPrivateText }),
    ...(record.disclosureAuthorizationId === undefined
      ? {} : { disclosureAuthorizationId: record.disclosureAuthorizationId }),
  };
}

function routeFailure(error: unknown): Response {
  const code = error instanceof Error ? error.message : "UNKNOWN";
  if (["SESSION_REQUIRED", "SESSION_INVALID", "INVALID_OPAQUE_TOKEN"].includes(code)) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: privateHeaders() });
  }
  if (["INVALID_ORIGIN", "PROPOSAL_SOURCE_FORBIDDEN", "PROPOSAL_DISCLOSURE_FORBIDDEN"].includes(code)) {
    return Response.json({ error: code }, { status: 403, headers: privateHeaders() });
  }
  if (code === "REQUEST_BODY_TOO_LARGE") {
    return Response.json({ error: code }, { status: 413, headers: privateHeaders() });
  }
  if (code === "UNSUPPORTED_MEDIA_TYPE") {
    return Response.json({ error: code }, { status: 415, headers: privateHeaders() });
  }
  if (code === "PROPOSAL_IDEMPOTENCY_KEY_REUSED" || code === "IDEMPOTENCY_KEY_REUSED") {
    return Response.json({ error: "PROPOSAL_IDEMPOTENCY_KEY_REUSED" }, { status: 409, headers: privateHeaders() });
  }
  if (code === "PROPOSAL_NOT_FOUND") {
    return Response.json({ error: code }, { status: 404, headers: privateHeaders() });
  }
  if (
    code === "INVALID_PROPOSAL_BODY"
    || code.startsWith("PROPOSAL_")
    || code.startsWith("EVIDENCE_")
  ) {
    return Response.json({ error: code === "INVALID_PROPOSAL_BODY" ? code : "INVALID_PROPOSAL_BODY" }, {
      status: 400,
      headers: privateHeaders(),
    });
  }
  return Response.json({ error: "PROPOSAL_CREATE_FAILED" }, { status: 500, headers: privateHeaders() });
}

/** Creates a non-canonical Node proposal; this route has no Main/Challenge mutation capability. */
export async function POST(request: Request): Promise<Response> {
  const environment = process.env.NODE_ENV ?? "development";
  try {
    assertRequestOrigin(
      request,
      environment,
      environment === "production" ? undefined : process.env.GUSTAVO_APP_ORIGIN,
    );
    const body = await proposalBody(request);
    const database = getDatabase();
    const session = await authenticateSession(database, sessionToken(request, environment));
    const proposal = await createProposal(
      { db: database },
      { ...body, accountId: session.accountId },
    );
    return Response.json(proposal, { status: 201, headers: privateHeaders() });
  } catch (error) {
    return routeFailure(error);
  }
}
