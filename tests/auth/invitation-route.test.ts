import type { EventDatabase } from "../../lib/server/events/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateOpaqueToken } from "../../lib/server/auth/sessions";
import { seedInvitation, testContext } from "../helpers/postgres";

const routeState = vi.hoisted(() => ({
  db: undefined as EventDatabase | undefined,
}));

vi.mock("../../lib/server/db/postgres", () => ({
  getDatabase(): EventDatabase {
    if (!routeState.db) {
      throw new Error("TEST_DATABASE_NOT_READY");
    }
    return routeState.db;
  },
}));

import { POST } from "../../app/api/account/redeem/route";

function redemptionRequest(token: string, origin: string): Request {
  return new Request("https://gustavo.lol/api/account/redeem", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({
      token,
      displayName: "Ada",
      password: "correct horse battery staple",
    }),
  });
}

function failingDatabase(error: Error): EventDatabase {
  const fail = (): never => {
    throw error;
  };
  return {
    async query() {
      return fail();
    },
    async one() {
      return fail();
    },
    async transaction() {
      return fail();
    },
  };
}

afterEach(() => {
  routeState.db = undefined;
  vi.unstubAllEnvs();
});

describe("POST /api/account/redeem", () => {
  it("rejects foreign origins and returns the raw session only in its hardened cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const ctx = await testContext();
    routeState.db = ctx.db;
    const token = await seedInvitation(ctx.db, { expiresAt: new Date("2030-01-01T00:00:00Z") });

    const rejected = await POST(redemptionRequest(token, "https://evil.example"));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("set-cookie")).toBeNull();

    const accepted = await POST(redemptionRequest(token, "https://gustavo.lol"));
    expect(accepted.status).toBe(201);
    const cookie = accepted.headers.get("set-cookie");
    expect(cookie).toMatch(/^__Host-gustavo-session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//i);
    const rawSessionToken = cookie?.match(/^__Host-gustavo-session=([^;]+)/)?.[1];
    expect(rawSessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const body = await accepted.text();
    expect(body).not.toContain(rawSessionToken as string);
    expect(body).not.toContain("sessionToken");
    expect(JSON.parse(body)).toEqual({
      accountId: expect.any(String),
      nodeBrainId: expect.any(String),
      conversationId: expect.any(String),
    });
  }, 30_000);

  it("keeps malformed JSON as an explicit client error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const request = new Request("https://gustavo.lol/api/account/redeem", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://gustavo.lol",
      },
      body: "{",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_REDEMPTION_BODY" });
  });

  it("returns a generic 500 for unexpected database failures", async () => {
    vi.stubEnv("NODE_ENV", "production");
    routeState.db = failingDatabase(new Error("SECRET_DATABASE_FAILURE"));

    const response = await POST(redemptionRequest(generateOpaqueToken(), "https://gustavo.lol"));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe('{"error":"REDEMPTION_FAILED"}');
    expect(body).not.toContain("SECRET_DATABASE_FAILURE");
  });

  it("does not misclassify an internal SyntaxError as malformed request JSON", async () => {
    vi.stubEnv("NODE_ENV", "production");
    routeState.db = failingDatabase(new SyntaxError("SECRET_PROGRAMMING_FAILURE"));

    const response = await POST(redemptionRequest(generateOpaqueToken(), "https://gustavo.lol"));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe('{"error":"REDEMPTION_FAILED"}');
    expect(body).not.toContain("SECRET_PROGRAMMING_FAILURE");
  });

  it("returns a generic 500 for invalid server origin configuration", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GUSTAVO_APP_ORIGIN", "not a valid URL");

    const response = await POST(redemptionRequest(generateOpaqueToken(), "http://localhost:3000"));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe('{"error":"REDEMPTION_FAILED"}');
    expect(body).not.toContain("INVALID_CONFIGURED_ORIGIN");
  });
});
