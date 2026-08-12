import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import {
  assertOwnedChildAlive,
  assertLoopbackPortAvailable,
  e2eBaseURL,
  issueInvitation,
  seedLicensedObservation,
} from "./fixtures";

const PRIVATE_THESIS = "private completed-close thesis";

test("the E2E readiness guard immediately rejects a signal-terminated child", () => {
  const startedAt = performance.now();
  expect(() => assertOwnedChildAlive({ exitCode: null, signalCode: "SIGTERM" }, "terminated"))
    .toThrow("E2E_WEB_EXITED:code=null:signal=SIGTERM");
  expect(performance.now() - startedAt).toBeLessThan(250);
});

test("the E2E server refuses a preoccupied IPv4 loopback port", async () => {
  const occupied = createServer();
  await new Promise<void>((resolveListen, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("TEST_PORT_UNAVAILABLE");
    await expect(assertLoopbackPortAvailable(address.port)).rejects.toThrow(
      "E2E_WEB_PORT_PREOCCUPIED",
    );
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      occupied.close((error) => error ? reject(error) : resolveClose());
    });
  }
});

test("an invited user can use the local Gustavo MVP without leaking private text", async ({
  page,
  request,
}) => {
  const invitation = await issueInvitation(request);
  const baseURL = e2eBaseURL();
  await page.goto(`${baseURL}/join?token=${encodeURIComponent(invitation)}`);
  expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  await page.getByLabel("Display name").fill("Ada");
  await page.getByLabel("Passphrase").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/chat$/u);
  await expect(page.getByRole("heading", { name: "Your Node Brain" })).toBeVisible();

  const observation = await seedLicensedObservation(request, {
    symbol: "AAPL",
    price: "100.00",
    feedStatus: "DELAYED",
    delaySeconds: 900,
  });
  await page.getByLabel("Message", { exact: true }).fill(PRIVATE_THESIS);
  const messageAccepted = page.waitForResponse((response) => (
    response.request().method() === "POST"
      && /\/api\/conversations\/[^/]+\/messages$/u.test(new URL(response.url()).pathname)
  ));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await messageAccepted).status()).toBe(201);
  await expect(page).toHaveURL(/\/chat$/u);
  expect(page.url()).not.toContain(PRIVATE_THESIS);
  await expect(page.getByText(PRIVATE_THESIS)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your Node Brain" })).toBeVisible();
  await expect(page.getByText(/Main Brain review/u)).toBeVisible();

  await page.goto(`${baseURL}/challenge`);
  await expect(page.getByRole("heading", { name: "AAPL: paper long" })).toBeVisible();
  await expect(page.getByText("DELAYED \u2014 900 seconds", { exact: true })).toBeVisible();
  await expect(page.locator(`time[datetime="${observation.observedAt}"]`)).toBeVisible();
  await expect(page.getByText("SIMULATION ONLY — NOT A REAL TRADE")).toBeVisible();

  await page.goto(`${baseURL}/chat`);
  const inspectMemories = page.getByRole("button", { name: "Inspect memories" });
  await expect(inspectMemories).toBeVisible();

  const publicPayloads: Promise<string>[] = [];
  const publicRequests: { readonly url: string; readonly postData: string | null }[] = [];
  page.on("request", (browserRequest) => {
    publicRequests.push({
      url: browserRequest.url(),
      postData: browserRequest.postData(),
    });
  });
  page.on("response", (response) => {
    if (new URL(response.url()).origin !== new URL(page.url()).origin) return;
    const contentType = response.headers()["content-type"] ?? "";
    if (!/(?:text|json|javascript)/iu.test(contentType)) return;
    publicPayloads.push(response.text().catch(() => ""));
  });
  await page.context().clearCookies();
  await page.goto(baseURL);
  await expect(page.getByTestId("public-feed")).not.toContainText(PRIVATE_THESIS);
  expect(await page.locator("html").textContent()).not.toContain(PRIVATE_THESIS);
  expect((await Promise.all(publicPayloads)).join("\n")).not.toContain(PRIVATE_THESIS);
  expect(JSON.stringify(publicRequests)).not.toContain(PRIVATE_THESIS);
});
