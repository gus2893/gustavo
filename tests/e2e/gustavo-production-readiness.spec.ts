import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  cleanupVerifiedBackup,
  cleanupFixtureOwnershipRegistry,
  createVerifiedBackup,
  createFixtureOwnershipRegistry,
  e2eBaseURL,
  assertFixtureRuntimeAllowed,
  issueInvitation,
  operatorHealthToken,
  restartCache,
  restoreFixture,
  registerFixtureOwnership,
  readFixtureOwnership,
  fixtureOwnershipRegistryProtected,
  fixtureOwnerOnlyPath,
  removeOwnedValkeyForTest,
  runOwnedValkeyContainerForTest,
  seedLicensedObservation,
  waitForScheduledBroadcast,
} from "./fixtures";

const PRIVATE_TEXT = "protected recovery thesis must stay private";
const execFileAsync = promisify(execFile);

test("owned-resource cleanup survives worker separation and retries failed removal", async () => {
  const registry = await createFixtureOwnershipRegistry();
  try {
    expect(await fixtureOwnershipRegistryProtected(registry)).toBe(true);
    await expect(registerFixtureOwnership(
      `${registry}-sibling`,
      { kind: "VALKEY", value: `gustavo-e2e-valkey-${"c".repeat(32)}` },
    )).rejects.toThrow("UNSAFE_E2E_OWNERSHIP_REGISTRY");
    await expect(registerFixtureOwnership(registry, {
      kind: "BACKUP",
      value: join(registry, "gustavo-e2e-backup-injected"),
    })).rejects.toThrow("UNSAFE_E2E_BACKUP_DIRECTORY");
    const owned = `gustavo-e2e-valkey-${"a".repeat(32)}`;
    const unrelated = `unrelated-${"b".repeat(32)}`;
    const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const registrationProgram = [
      'import { registerFixtureOwnership } from "./tests/e2e/fixtures.ts";',
      '(async () => {',
      'const registry = process.env.E2E_REGISTRY;',
      'const owned = process.env.E2E_OWNED;',
      'if (!registry || !owned) throw new Error("CHILD_OWNERSHIP_INPUT_REQUIRED");',
      'await registerFixtureOwnership(registry, { kind: "VALKEY", value: owned });',
      '})().catch((error) => { console.error(error); process.exitCode = 1; });',
    ].join("\n");
    await execFileAsync(process.execPath, [tsxCli, "--eval", registrationProgram], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, E2E_REGISTRY: registry, E2E_OWNED: owned },
    });
    const attempted: string[] = [];
    await expect(cleanupFixtureOwnershipRegistry(registry, {
      removeValkey: async (name) => {
        attempted.push(name);
        throw new Error("EXPECTED_DOCKER_RM_FAILURE");
      },
    })).rejects.toThrow("EXPECTED_DOCKER_RM_FAILURE");
    expect(await readFixtureOwnership(registry)).toEqual([{ kind: "VALKEY", value: owned }]);

    await cleanupFixtureOwnershipRegistry(registry, {
      removeValkey: async (name) => { attempted.push(name); },
    });
    expect(attempted).toEqual([owned, owned]);
    expect(attempted).not.toContain(unrelated);
  } finally {
    await cleanupFixtureOwnershipRegistry(registry).catch(() => undefined);
  }
});

test("Valkey cleanup distinguishes daemon failure from an absent owned container", async () => {
  const owned = `gustavo-e2e-valkey-${"d".repeat(32)}`;
  const unrelatedCalls: string[][] = [];
  await expect(removeOwnedValkeyForTest(owned, "registry", async (arguments_) => {
    unrelatedCalls.push([...arguments_]);
    return "another-registry";
  })).rejects.toThrow("E2E_VALKEY_OWNERSHIP_LABEL_INVALID");
  expect(unrelatedCalls).toHaveLength(1);
  expect(unrelatedCalls[0]?.[0]).toBe("container");
  await expect(removeOwnedValkeyForTest(owned, "registry", async () => {
    throw Object.assign(new Error("daemon unavailable"), {
      stderr: "error during connect: daemon unavailable",
    });
  })).rejects.toThrow("daemon unavailable");
  await expect(removeOwnedValkeyForTest(owned, "registry", async () => {
    throw Object.assign(new Error("missing"), {
      stderr: `Error: No such container: ${owned}\n`,
    });
  })).resolves.toBe("ABSENT");
});

test("Valkey ownership is durable before Docker launch", async () => {
  const registry = await createFixtureOwnershipRegistry();
  let reservedName = "";
  try {
    await expect(runOwnedValkeyContainerForTest(registry, 63_799, async (arguments_) => {
      const command = arguments_[0];
      if (command === "run") {
        const nameIndex = arguments_.indexOf("--name");
        reservedName = arguments_[nameIndex + 1] ?? "";
        expect(await readFixtureOwnership(registry)).toEqual([
          { kind: "VALKEY", value: reservedName },
        ]);
        throw new Error("EXPECTED_DOCKER_RUN_FAILURE");
      }
      if (command === "container") {
        throw Object.assign(new Error("missing"), {
          stderr: `Error: No such container: ${reservedName}\n`,
        });
      }
      throw new Error(`UNEXPECTED_DOCKER_COMMAND:${command ?? ""}`);
    })).rejects.toThrow("EXPECTED_DOCKER_RUN_FAILURE");
    expect(await readFixtureOwnership(registry)).toEqual([]);
  } finally {
    await cleanupFixtureOwnershipRegistry(registry).catch(() => undefined);
  }
});

test("the hardened system recovers and resumes without leaking protected data", async ({
  page,
  request,
}) => {
  expect(await readFile("docs/PRODUCTION_CHECKLIST.md", "utf8"))
    .toContain("SIMULATION ONLY — NOT A REAL TRADE");
  expect(() => assertFixtureRuntimeAllowed("production"))
    .toThrow("E2E_FIXTURES_PRODUCTION_FORBIDDEN");
  const baseURL = e2eBaseURL();
  const invitation = await issueInvitation(request);
  await page.goto(`${baseURL}/join?token=${encodeURIComponent(invitation)}`);
  await page.getByLabel("Display name").fill("Recovery Ada");
  await page.getByLabel("Passphrase").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/chat$/u);
  await seedLicensedObservation(request, {
    symbol: "AAPL",
    price: "100.00",
    feedStatus: "DELAYED",
    delaySeconds: 900,
  });
  await page.getByLabel("Message", { exact: true }).fill(PRIVATE_TEXT);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(PRIVATE_TEXT)).toBeVisible();

  const backup = await createVerifiedBackup();
  try {
    expect(backup.verified).toBe(true);
    expect(await fixtureOwnerOnlyPath(backup.rootDirectory, "DIRECTORY")).toBe(true);
    expect(await fixtureOwnerOnlyPath(backup.keyPath, "FILE")).toBe(true);
    const restored = await restoreFixture(backup);
    expect(restored.eventHighWater).toBe(backup.eventHighWater);
    expect(restored.schemaVersion).toBe(backup.schemaVersion);
  } finally {
    await cleanupVerifiedBackup(backup);
  }

  const cache = await restartCache();
  expect(cache.rebuilt).toBe(true);
  expect(cache.prewarmed).toBe(true);
  expect(cache.source).toBe("POSTGRES");
  expect(cache.backend).toBe("VALKEY");
  expect(cache.keysBeforeLoss).toBeGreaterThan(0);
  expect(cache.keysAfterLoss).toBe(0);
  expect(cache.keysAfterPrewarm).toBeGreaterThan(0);

  const broadcast = await waitForScheduledBroadcast();
  expect(broadcast.authorType).toBe("MAIN_BRAIN");
  expect(broadcast.protectedText).toBeUndefined();

  const unauthenticatedHealth = await request.get(`${baseURL}/api/operator/health`);
  expect(unauthenticatedHealth.status()).toBe(401);
  const health = await request.get(`${baseURL}/api/operator/health`, {
    headers: { authorization: `Bearer ${operatorHealthToken()}` },
  });
  expect(health.status()).toBe(200);
  expect(health.headers()["cache-control"]).toContain("private, no-store");
  const healthText = await health.text();
  expect(healthText).not.toContain(PRIVATE_TEXT);
  expect(healthText).not.toMatch(/accountId|conversationId|symbol|protectedText/u);

  await page.context().clearCookies();
  await page.goto(baseURL);
  await expect(page.getByTestId("public-feed")).toBeVisible();
  await expect(page.getByText("Freshness: static sample (not live).", { exact: false })).toBeVisible();
  const publicHtml = await page.locator("html").textContent();
  expect(publicHtml).not.toContain(PRIVATE_TEXT);
  expect(publicHtml).not.toMatch(/buy now|sell now|copy[- ]?trade|real order/iu);
  const publicApiResponse = await request.get(`${baseURL}/api/public/feed`);
  expect(publicApiResponse.status()).toBe(200);
  const publicPayload = await publicApiResponse.text();
  expect(publicPayload).not.toContain(PRIVATE_TEXT);
  expect(publicPayload).not.toMatch(/protectedText|ciphertext|wrapped_key/iu);
});
