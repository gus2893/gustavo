import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: join(tmpdir(), `gustavo-playwright-results-${process.pid}`),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  metadata: { reuseExistingServer: false },
  globalSetup: "./tests/e2e/fixtures.ts",
  use: {
    trace: "retain-on-failure",
  },
});
