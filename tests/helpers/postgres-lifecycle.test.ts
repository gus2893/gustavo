import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCleanupSteps,
  startTestPostgresWithOverridesForTest,
} from "./postgres";

describe("test PostgreSQL lifecycle cleanup", () => {
  it("attempts every cleanup and restoration step after an earlier failure", async () => {
    const calls: string[] = [];
    await expect(
      runCleanupSteps([
        {
          name: "close pool",
          run: async () => {
            calls.push("close pool");
            throw new Error("POOL_CLOSE_FAILED");
          },
        },
        {
          name: "stop postgres",
          run: async () => {
            calls.push("stop postgres");
          },
        },
        {
          name: "remove temp directory",
          run: () => {
            calls.push("remove temp directory");
          },
        },
        {
          name: "restore environment",
          run: () => {
            calls.push("restore environment");
          },
        },
      ]),
    ).rejects.toThrow("TEST_RESOURCE_CLEANUP_FAILED:close pool");
    expect(calls).toEqual([
      "close pool",
      "stop postgres",
      "remove temp directory",
      "restore environment",
    ]);
  });

  it("removes a registered directory and restores keys when port reservation fails", async () => {
    const originalKey = process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
    const originalVersion = process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION;
    let dataDirectory: string | undefined;
    process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = "mutated-test-value";
    process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION = "999";
    try {
      await expect(
        startTestPostgresWithOverridesForTest({
          createDataDirectory: () => {
            dataDirectory = mkdtempSync(join(tmpdir(), "gustavo-postgres-preport-"));
            return dataDirectory;
          },
          reservePort: async () => {
            throw new Error("INJECTED_PORT_FAILURE");
          },
        }),
      ).rejects.toThrow("INJECTED_PORT_FAILURE");
      expect(dataDirectory).toBeDefined();
      expect(existsSync(dataDirectory!)).toBe(false);
      expect(process.env.GUSTAVO_EVENT_ROOT_KEY_V1).toBe(originalKey);
      expect(process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION).toBe(originalVersion);
    } finally {
      if (dataDirectory && existsSync(dataDirectory)) {
        rmSync(dataDirectory, { recursive: true, force: true });
      }
      if (originalKey === undefined) {
        delete process.env.GUSTAVO_EVENT_ROOT_KEY_V1;
      } else {
        process.env.GUSTAVO_EVENT_ROOT_KEY_V1 = originalKey;
      }
      if (originalVersion === undefined) {
        delete process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION;
      } else {
        process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION = originalVersion;
      }
    }
  });
});
