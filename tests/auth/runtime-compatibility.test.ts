import { argon2 } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("authentication runtime", () => {
  it("declares a Node version that provides native Argon2id", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      engines: { node: string };
    };
    expect(packageJson.engines.node).toBe(">=24.7.0 <25");
    expect(typeof argon2).toBe("function");
    const [major, minor] = process.versions.node.split(".").map(Number);
    expect(major > 24 || (major === 24 && minor >= 7)).toBe(true);
  });
});
