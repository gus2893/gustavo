import { describe, expect, it, vi } from "vitest";
import { redeemInvitation } from "../../lib/server/auth/invitations";
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from "../../lib/server/auth/sessions";
import { seedInvitation, testContext } from "../helpers/postgres";

const TEST_PASSWORD_HASH = "$argon2id$test-only-password-hash";

describe("invitation redemption boundaries", () => {
  it("rejects malformed, unknown, expired, revoked, and reused invitations before password hashing", async () => {
    const ctx = await testContext();
    const passwordHasher = vi.fn(async () => TEST_PASSWORD_HASH);
    const serviceContext = { db: ctx.db, passwordHasher };
    const profile = { displayName: "Ada", password: "correct horse battery staple" };

    await expect(redeemInvitation(serviceContext, "malformed", profile))
      .rejects.toThrow("INVALID_OPAQUE_TOKEN");
    await expect(redeemInvitation(serviceContext, generateOpaqueToken(), profile))
      .rejects.toThrow("INVITATION_INVALID");
    const expired = await seedInvitation(ctx.db, { expiresAt: new Date("2020-01-01T00:00:00Z") });
    await expect(redeemInvitation(serviceContext, expired, profile))
      .rejects.toThrow("INVITATION_EXPIRED");
    const revoked = await seedInvitation(ctx.db, {
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await expect(redeemInvitation(serviceContext, revoked, profile))
      .rejects.toThrow("INVITATION_REVOKED");
    expect(passwordHasher).not.toHaveBeenCalled();

    const eligible = await seedInvitation(ctx.db, { expiresAt: new Date("2030-01-01T00:00:00Z") });
    await redeemInvitation(serviceContext, eligible, profile);
    expect(passwordHasher).toHaveBeenCalledTimes(1);
    await expect(redeemInvitation(serviceContext, eligible, profile))
      .rejects.toThrow("INVITATION_ALREADY_REDEEMED");
    expect(passwordHasher).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("allows exactly one winner when the same invitation is redeemed concurrently", async () => {
    const ctx = await testContext();
    const token = await seedInvitation(ctx.db, { expiresAt: new Date("2030-01-01T00:00:00Z") });
    let releaseHashers = (): void => {};
    const bothHashersReady = new Promise<void>((resolve) => {
      releaseHashers = resolve;
    });
    let hasherCalls = 0;
    const passwordHasher = vi.fn(async () => {
      hasherCalls += 1;
      if (hasherCalls === 2) {
        releaseHashers();
      }
      await bothHashersReady;
      return TEST_PASSWORD_HASH;
    });
    const profile = { displayName: "Ada", password: "correct horse battery staple" };
    const results = await Promise.allSettled([
      redeemInvitation({ db: ctx.db, passwordHasher }, token, profile),
      redeemInvitation({ db: ctx.db, passwordHasher }, token, profile),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: "INVITATION_ALREADY_REDEEMED",
    });
    expect(passwordHasher).toHaveBeenCalledTimes(2);
    expect(await ctx.db.one("select count(*)::int as count from accounts")).toEqual({ count: 1 });
    expect(await ctx.db.one("select count(*)::int as count from node_brains")).toEqual({ count: 1 });
    expect(await ctx.db.one("select count(*)::int as count from conversations")).toEqual({ count: 1 });
    expect(await ctx.db.one("select count(*)::int as count from sessions")).toEqual({ count: 1 });
  }, 30_000);

  it("rejects an invitation that expires while password hashing is in progress", async () => {
    const ctx = await testContext();
    const token = await seedInvitation(ctx.db, { expiresAt: new Date("2030-01-01T00:00:00Z") });
    const passwordHasher = vi.fn(async () => {
      await ctx.db.query(
        "update invitations set expires_at=clock_timestamp() + interval '100 milliseconds' where token_hash=$1",
        [hashOpaqueToken(token)],
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      return TEST_PASSWORD_HASH;
    });

    await expect(redeemInvitation(
      {
        db: ctx.db,
        now: new Date("2026-08-08T00:00:00Z"),
        passwordHasher,
      },
      token,
      { displayName: "Ada", password: "correct horse battery staple" },
    )).rejects.toThrow("INVITATION_EXPIRED");
    expect(passwordHasher).toHaveBeenCalledTimes(1);
    expect(await ctx.db.one("select count(*)::int as count from accounts")).toEqual({ count: 0 });
  }, 30_000);
});
