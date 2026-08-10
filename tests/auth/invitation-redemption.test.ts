import { describe, expect, it } from "vitest";
import { seedInvitation, testContext } from "../helpers/postgres";
import {
  issueInvitation,
  redeemInvitation,
  verifyPassword,
} from "../../lib/server/auth/invitations";
import {
  assertRequestOrigin,
  authenticateSession,
  revokeSession,
  rotateSession,
  sessionCookieOptions,
} from "../../lib/server/auth/sessions";

describe("redeemInvitation", () => {
  it("creates exactly one identity graph and rejects reuse", async () => {
    const ctx = await testContext();
    const token = await seedInvitation(ctx.db, { expiresAt: new Date("2030-01-01T00:00:00Z") });
    const first = await redeemInvitation(ctx, token, { displayName: "Ada", password: "correct horse battery staple" });
    expect(first).toMatchObject({ accountId: expect.any(String), nodeBrainId: expect.any(String), conversationId: expect.any(String) });
    await expect(redeemInvitation(ctx, token, { displayName: "Other", password: "correct horse battery staple" }))
      .rejects.toThrow("INVITATION_ALREADY_REDEEMED");
    expect(await ctx.db.one("select count(*)::int as count from node_brains where account_id=$1", [first.accountId]))
      .toEqual({ count: 1 });
    const stored = await ctx.db.one("select token_hash, redeemed_at from invitations limit 1");
    expect(stored.token_hash).not.toBe(token);
    expect(stored.redeemed_at).not.toBeNull();
    const credential = await ctx.db.one("select password_hash from password_credentials where account_id=$1", [first.accountId]);
    expect(credential.password_hash).not.toContain("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", credential.password_hash as string)).toBe(true);
    expect(sessionCookieOptions("production")).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });

    expect(await authenticateSession(ctx.db, first.sessionToken)).toMatchObject({ accountId: first.accountId });
    const rotated = await rotateSession(ctx.db, first.sessionToken);
    await expect(authenticateSession(ctx.db, first.sessionToken)).rejects.toThrow("SESSION_INVALID");
    expect(await authenticateSession(ctx.db, rotated.token)).toMatchObject({ accountId: first.accountId });
    await revokeSession(ctx.db, rotated.token);
    await expect(authenticateSession(ctx.db, rotated.token)).rejects.toThrow("SESSION_INVALID");

    const expired = await seedInvitation(ctx.db, { expiresAt: new Date("2020-01-01T00:00:00Z") });
    await expect(redeemInvitation(ctx, expired, { displayName: "Expired", password: "correct horse battery staple" }))
      .rejects.toThrow("INVITATION_EXPIRED");
    const revoked = await seedInvitation(ctx.db, {
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await expect(redeemInvitation(ctx, revoked, { displayName: "Revoked", password: "correct horse battery staple" }))
      .rejects.toThrow("INVITATION_REVOKED");

    const issued = await issueInvitation(
      { db: ctx.db, operator: { id: "local-operator", role: "OPERATOR" } },
      { expiresAt: new Date("2030-01-01T00:00:00Z") },
    );
    const issuedRow = await ctx.db.one<{ token_hash: string }>(
      "select token_hash from invitations where id=$1",
      [issued.invitationId],
    );
    expect(issuedRow.token_hash).not.toBe(issued.token);
    expect(await ctx.db.one("select count(*)::int as count from events where type='invitation.issued'"))
      .toEqual({ count: 1 });

    expect(() => assertRequestOrigin(new Request("https://gustavo.lol/api/account/redeem", {
      method: "POST",
      headers: { origin: "https://gustavo.lol" },
    }), "production")).not.toThrow();
    expect(() => assertRequestOrigin(new Request("https://gustavo.lol/api/account/redeem", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }), "production")).toThrow("INVALID_ORIGIN");
  }, 30_000);
});
