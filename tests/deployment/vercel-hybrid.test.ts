import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const EXPECTED_ACTIVE_ENV_KEYS = [
  "CODEX_HOME",
  "DATABASE_URL",
  "ENABLE_EXPERIMENTAL_COREPACK",
  "FINNHUB_API_KEY",
  "GUSTAVO_APP_ORIGIN",
  "GUSTAVO_BACKGROUND_WORKER_OWNER",
  "GUSTAVO_CACHE_ENCRYPTION_KEY",
  "GUSTAVO_COUNCIL_PSEUDONYM_KEY",
  "GUSTAVO_CURSOR_SIGNING_KEY",
  "GUSTAVO_DATABASE_SSL",
  "GUSTAVO_DEPLOYMENT_PROFILE",
  "GUSTAVO_EVALUATOR_PSEUDONYM_KEY",
  "GUSTAVO_EVENT_ROOT_KEY_V1",
  "GUSTAVO_EVENT_ROOT_KEY_VERSION",
  "GUSTAVO_HYBRID_BRIDGE_ENABLED",
  "GUSTAVO_MARKET_POLLER_ENABLED",
  "GUSTAVO_OPERATOR_HEALTH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "QSTASH_TOKEN",
  "VALKEY_URL",
] as const;

function activeAssignments(env: string): ReadonlyArray<readonly [string, string]> {
  return env.split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 0) throw new Error(`ENV_ASSIGNMENT_INVALID:${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
}

function assertExactActiveKeyMultiset(
  assignments: ReadonlyArray<readonly [string, string]>,
): void {
  const actual = assignments.map(([key]) => key).sort();
  const expected = [...EXPECTED_ACTIVE_ENV_KEYS].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw new Error("ENV_KEY_SET_INVALID");
  }
}

function activeValues(env: string, name: string): string[] {
  const active = activeAssignments(env);
  assertExactActiveKeyMultiset(active);
  return active
    .filter(([key]) => key === name)
    .map(([, value]) => value);
}

describe("Vercel hybrid deployment contract", () => {
  it("pins Node 24, pnpm 11, bounded functions, and explicit free-tier flags", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    const env = readFileSync("infra/vercel.env.example", "utf8");

    expect(pkg.packageManager).toBe("pnpm@11.16.0");
    expect(pkg.engines.node).toBe(">=24.7.0 <25");
    expect(pkg.dependencies).toMatchObject({
      "@upstash/qstash": expect.any(String),
      "@vercel/functions": expect.any(String),
    });
    expect(vercel.functions).toEqual({
      "app/api/feed/stream/route.ts": { maxDuration: 60 },
    });
    const bridgeFlag = "GUSTAVO_HYBRID_BRIDGE_ENABLED";
    const corepackFlag = "ENABLE_EXPERIMENTAL_COREPACK";
    expect(activeValues(env, corepackFlag)).toEqual(["1"]);
    expect(activeValues(env, "GUSTAVO_BACKGROUND_WORKER_OWNER")).toEqual(["worker"]);
    expect(activeValues(env, "GUSTAVO_DEPLOYMENT_PROFILE")).toEqual(["public-production-v1"]);
    expect(activeValues(env, "GUSTAVO_APP_ORIGIN")).toEqual(["https://gustavo.lol"]);
    expect(activeValues(env, "GUSTAVO_DATABASE_SSL")).toEqual(["require"]);
    expect(activeValues(env, "GUSTAVO_EVENT_ROOT_KEY_VERSION")).toEqual(["1"]);
    expect(activeValues(env, bridgeFlag)).toEqual(["false"]);
    expect(activeValues(env, "GUSTAVO_MARKET_POLLER_ENABLED")).toEqual(["false"]);
    expect(() => activeValues(
      env.replace("DATABASE_URL=", "DATABASE_URL"),
      "DATABASE_URL",
    )).toThrow("ENV_ASSIGNMENT_INVALID:DATABASE_URL");
    expect(() => activeValues(
      `${env}\nANTHROPIC_API_KEY=paid-secret`,
      "DATABASE_URL",
    )).toThrow("ENV_KEY_SET_INVALID");
    for (const secret of [
      "DATABASE_URL",
      "VALKEY_URL",
      "GUSTAVO_EVENT_ROOT_KEY_V1",
      "GUSTAVO_CURSOR_SIGNING_KEY",
      "GUSTAVO_CACHE_ENCRYPTION_KEY",
      "GUSTAVO_COUNCIL_PSEUDONYM_KEY",
      "GUSTAVO_EVALUATOR_PSEUDONYM_KEY",
      "GUSTAVO_OPERATOR_HEALTH_TOKEN",
      "QSTASH_TOKEN",
      "QSTASH_CURRENT_SIGNING_KEY",
      "QSTASH_NEXT_SIGNING_KEY",
      "FINNHUB_API_KEY",
      "CODEX_HOME",
    ]) {
      expect(activeValues(env, secret), secret).toEqual([""]);
    }
    expect(activeValues(`# ${bridgeFlag}=true\n${env}`, bridgeFlag)).toEqual(["false"]);
    expect(() => activeValues(`${env}\n${bridgeFlag}=false`, bridgeFlag))
      .toThrow("ENV_KEY_SET_INVALID");
    expect(() => activeValues(`${env}\n${bridgeFlag}=true`, bridgeFlag))
      .toThrow("ENV_KEY_SET_INVALID");
    const suffixed = env.replace(
      `${bridgeFlag}=false`,
      `${bridgeFlag}=false=true`,
    );
    expect(activeValues(suffixed, bridgeFlag)).toEqual(["false=true"]);
    expect(activeValues(
      env.replace(`${corepackFlag}=1`, `${corepackFlag}=1=0`),
      corepackFlag,
    )).toEqual(["1=0"]);
    expect(env).not.toMatch(
      /OPENAI_API_KEY|PAID_FALLBACK|OVERAGE_ENABLED|GUSTAVO_EVENT_ENCRYPTION_KEY|GUSTAVO_INVITATION_HMAC_KEY|GUSTAVO_MEMORY_ENCRYPTION_KEY|GUSTAVO_NODE_SEED_ENCRYPTION_KEY|GUSTAVO_PASSWORD_PEPPER|GUSTAVO_SESSION_HMAC_KEY|GUSTAVO_THOUGHT_ENCRYPTION_KEY/,
    );
  });
});
