import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    ...(process.platform === "win32" ? { maxWorkers: 1 } : {}),
  },
});
