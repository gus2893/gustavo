import { createHash, timingSafeEqual } from "node:crypto";
import type { EventDatabase } from "../../../../lib/server/events/types";
import { getDatabase } from "../../../../lib/server/db/postgres";
import {
  collectOperatorHealth,
  type OperatorHealth,
} from "../../../../lib/server/observability/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const RESPONSE_HEADERS = Object.freeze({
  "cache-control": "private, no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

function json(body: unknown, status: number): Response {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES) {
    return json({ error: "OPERATOR_HEALTH_RESPONSE_TOO_LARGE" }, 503);
  }
  return new Response(serialized, {
    status,
    headers: { ...RESPONSE_HEADERS, "content-length": String(Buffer.byteLength(serialized, "utf8")) },
  });
}

function suppliedBearer(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 600 || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length >= 32 && token.length <= 512 ? token : null;
}

function authorized(request: Request, expectedToken: string): boolean {
  if (expectedToken.length < 32 || expectedToken.length > 512) return false;
  const supplied = suppliedBearer(request);
  if (!supplied) return false;
  const expectedDigest = createHash("sha256").update(expectedToken, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

export function createOperatorHealthHandler(dependencies: {
  readonly resolveDatabase: () => EventDatabase;
  readonly token: string;
  readonly collect?: (database: EventDatabase) => Promise<OperatorHealth>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    // Authentication is intentionally complete before the database factory is
    // called. An unauthenticated client cannot consume a pool connection or
    // infer database/cache/queue state through timing and error differences.
    if (!authorized(request, dependencies.token)) {
      return json({ error: "UNAUTHORIZED" }, 401);
    }
    try {
      const database = dependencies.resolveDatabase();
      const health = await (dependencies.collect ?? collectOperatorHealth)(database);
      return json(health, 200);
    } catch {
      return json({ error: "OPERATOR_HEALTH_UNAVAILABLE" }, 503);
    }
  };
}

export async function GET(request: Request): Promise<Response> {
  const token = process.env.GUSTAVO_OPERATOR_HEALTH_TOKEN ?? "";
  return createOperatorHealthHandler({ resolveDatabase: getDatabase, token })(request);
}
