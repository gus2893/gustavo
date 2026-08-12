import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProductionFixturesDisabled,
  resolveProductionWorkerOwner,
} from "../../instrumentation";
import {
  clearWorkerReadiness,
  markWorkerReady,
} from "../../worker/runtime";

const requiredSecrets = [
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
  "GUSTAVO_EVENT_ROOT_KEY_V1",
  "GUSTAVO_CURSOR_SIGNING_KEY",
  "GUSTAVO_CACHE_ENCRYPTION_KEY",
  "GUSTAVO_COUNCIL_PSEUDONYM_KEY",
  "GUSTAVO_EVALUATOR_PSEUDONYM_KEY",
] as const;

function serviceBlock(compose: string, name: string): string {
  const match = new RegExp(`^  ${name}:\\r?\\n(?<body>(?: {4}.*(?:\\r?\\n|$))*)`, "mu")
    .exec(compose);
  expect(match, `service ${name}`).not.toBeNull();
  return match?.groups?.body ?? "";
}

describe("working MVP local runtime", () => {
  it("defines a pinned, internal, durable, health-ordered Compose topology", async () => {
    const compose = await readFile("infra/compose.yaml", "utf8");
    const dockerfile = await readFile("Dockerfile", "utf8");
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly engines?: { readonly node?: string };
      readonly scripts: Record<string, string | undefined>;
    };

    for (const service of ["web", "worker", "postgres", "valkey"]) {
      expect(serviceBlock(compose, service)).toContain("healthcheck:");
    }
    expect(serviceBlock(compose, "postgres")).not.toMatch(/^ {4}ports:/mu);
    expect(serviceBlock(compose, "valkey")).not.toMatch(/^ {4}ports:/mu);
    expect(serviceBlock(compose, "web")).toContain('127.0.0.1:${GUSTAVO_PORT:-3000}:3000');
    expect(compose).toMatch(/^  postgres-data:\s*$/mu);
    expect(serviceBlock(compose, "postgres")).toContain("postgres-data:/var/lib/postgresql/data");
    expect(compose).toMatch(/^    internal: true\s*$/mu);
    expect(serviceBlock(compose, "postgres")).toContain("networks: [backend]");
    expect(serviceBlock(compose, "valkey")).toContain("networks: [backend]");
    expect(serviceBlock(compose, "postgres")).not.toContain("frontend");
    expect(serviceBlock(compose, "valkey")).not.toContain("frontend");
    expect(serviceBlock(compose, "web")).toContain("networks: [backend, frontend]");
    expect(serviceBlock(compose, "worker")).toContain("networks: [backend, frontend]");
    expect(compose).toMatch(/^  frontend:\s*$/mu);

    expect(serviceBlock(compose, "postgres")).toMatch(/image: postgres:17\.6-bookworm/u);
    expect(serviceBlock(compose, "valkey")).toMatch(/image: valkey\/valkey:8\.1\.3-bookworm/u);
    expect(compose).not.toMatch(/:latest\b/u);
    expect(serviceBlock(compose, "web")).toContain("target: web");
    expect(serviceBlock(compose, "worker")).toContain("target: worker");
    expect(dockerfile).toContain("FROM node:24.7.0-bookworm-slim");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile.match(/USER node/gu)).toHaveLength(2);
    expect(pkg.engines?.node).toMatch(/24/u);
    expect(pkg.scripts["mvp:start"]).toContain("infra/compose.yaml");
    expect(pkg.scripts["mvp:start"]).toContain("run --rm migrate");
  });

  it("runs migrations and every required continuous worker with bounded shutdown", async () => {
    const compose = await readFile("infra/compose.yaml", "utf8");
    const workerRuntime = await readFile("worker/runtime.ts", "utf8");
    const web = serviceBlock(compose, "web");
    const worker = serviceBlock(compose, "worker");
    const migrate = serviceBlock(compose, "migrate");

    expect(migrate).toContain("/migrations");
    expect(migrate).toContain("schema_migrations");
    expect(migrate).toContain("--single-transaction");
    for (const app of [web, worker]) {
      expect(app).toContain("condition: service_completed_successfully");
      expect(app).toContain("condition: service_healthy");
      expect(app).toContain("restart: on-failure:5");
      expect(app).toContain("stop_grace_period: 30s");
      expect(app).toContain("read_only: true");
      expect(app).toContain("init: true");
    }
    expect(worker).toContain("worker/runtime.ts");
    expect(worker).not.toMatch(/tail\s+-f|sleep\s+infinity/iu);
    expect(workerRuntime).toContain("startPostgresCacheWorker");
    expect(workerRuntime).toContain("startForgetPropagationWorker");
    expect(workerRuntime).toContain("startCommittedEventPublisher");
    const readyIndex = workerRuntime.indexOf("await markWorkerReady(");
    expect(readyIndex).toBeGreaterThan(workerRuntime.indexOf("await prewarmPostgresCache("));
    expect(readyIndex).toBeGreaterThan(workerRuntime.indexOf("startPostgresCacheWorker("));
    expect(readyIndex).toBeGreaterThan(workerRuntime.indexOf("startForgetPropagationWorker("));
    expect(readyIndex).toBeGreaterThan(workerRuntime.indexOf("startCommittedEventPublisher("));
    expect(workerRuntime.match(/clearWorkerReadiness/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(workerRuntime).toMatch(/SIGINT|SIGTERM/u);
    expect(worker).toContain("gustavo-worker-ready");
    expect(worker).toContain("kill -0 \"$$pid\"");
    expect(web).toMatch(/worker:\s*\r?\n {8}condition: service_healthy/mu);
  });

  it("publishes and clears the real worker readiness marker", async () => {
    const marker = join(tmpdir(), `gustavo-worker-ready-${randomUUID()}`);
    await clearWorkerReadiness(marker);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    await markWorkerReady(marker);
    expect(await readFile(marker, "utf8")).toBe(`${process.pid}\n`);

    await clearWorkerReadiness(marker);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supplies shared secret names externally and disables production fixtures", async () => {
    const compose = await readFile("infra/compose.yaml", "utf8");
    const example = await readFile("infra/env.example", "utf8");
    for (const name of requiredSecrets) {
      expect(compose).toContain(`\${${name}}`);
      expect(example).toMatch(new RegExp(`^${name}=$`, "mu"));
    }
    expect(compose).toContain('GUSTAVO_TEST_FIXTURES_ENABLED: "false"');
    expect(compose).toContain('GUSTAVO_BACKGROUND_WORKER_OWNER: "worker"');
    expect(compose).toContain('GUSTAVO_DEPLOYMENT_PROFILE: "local-mvp-v1"');
    expect(example).not.toMatch(/backup|s3|dns|tls/iu);
  });

  it("fails closed unless production worker ownership is singular and explicit", () => {
    expect(() => resolveProductionWorkerOwner({})).toThrow(
      "GUSTAVO_BACKGROUND_WORKER_OWNER_REQUIRED",
    );
    expect(() => resolveProductionWorkerOwner({
      GUSTAVO_BACKGROUND_WORKER_OWNER: "both",
    })).toThrow("GUSTAVO_BACKGROUND_WORKER_OWNER_INVALID");
    expect(resolveProductionWorkerOwner({ GUSTAVO_BACKGROUND_WORKER_OWNER: "web" }))
      .toBe("web");
    expect(resolveProductionWorkerOwner({ GUSTAVO_BACKGROUND_WORKER_OWNER: "worker" }))
      .toBe("worker");
    expect(() => assertProductionFixturesDisabled({
      GUSTAVO_TEST_FIXTURES_ENABLED: "true",
    })).toThrow("PRODUCTION_TEST_FIXTURES_FORBIDDEN");
    expect(() => assertProductionFixturesDisabled({
      GUSTAVO_TEST_FIXTURES_ENABLED: "false",
    })).not.toThrow();
  });

  it("documents configuration and the complete local operator lifecycle", async () => {
    const operations = await readFile("docs/OPERATIONS.md", "utf8");
    for (const phrase of [
      "infra/env.example", "pnpm mvp:start", "http://localhost:3000",
      "health", "logs", "shutdown", "PostgreSQL", "Valkey", "backup",
    ]) {
      expect(operations.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(operations).toContain("SIMULATION ONLY — NOT A REAL TRADE");
    expect(operations).toMatch(/no production model or market-data adapter/iu);
    expect(operations).not.toMatch(/provider API credentials.*infra\/.env/iu);
  });

  it.runIf(process.env.GUSTAVO_DOCKER_CONFIG_TEST === "1")(
    "passes Docker Compose's canonical config validation",
    () => {
      expect(() => execFileSync("docker", [
        "compose", "--env-file", "infra/env.example", "-f", "infra/compose.yaml",
        "config", "--quiet",
      ], { stdio: "pipe" })).not.toThrow();
    },
  );
});
