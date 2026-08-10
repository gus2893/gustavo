import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Gustavo repository policy", () => {
  it("publishes the approved identity and simulation boundary", async () => {
    const readme = await readFile("README.md", "utf8");
    const repositoryInstructions = await readFile("AGENTS.md", "utf8");
    const policy = JSON.parse(await readFile("policy/editorial-policy.json", "utf8"));
    expect(readme).toContain("Gustavo");
    expect(readme).toContain("https://gustavo.lol");
    expect(readme).toContain("SIMULATION ONLY — NOT A REAL TRADE");
    expect(repositoryInstructions).toContain("Gustavo");
    expect(repositoryInstructions).toContain("https://gustavo.lol");
    expect(policy.realExecutionEnabled).toBe(false);
    expect(policy.claimsSentience).toBe(false);
    expect(policy.marketScope).toEqual(["US_STOCK", "US_ETF"]);
  });

  it("includes a runnable Next App Router shell", async () => {
    const [layout, page] = await Promise.all([
      readFile("app/layout.tsx", "utf8"),
      readFile("app/page.tsx", "utf8"),
    ]);
    expect(layout).toContain("<html");
    expect(layout).toContain("{children}");
    expect(page).toContain("Gustavo");
    expect(page).toContain("SIMULATION ONLY — NOT A REAL TRADE");
  });
});
