# Plan: deploy-vercel

**Plan status:** approved for execution after the self-review below
**Source contract:** `missions/deploy-vercel/02-design.md` approved 2026-08-13
**Execution rule:** each task begins with its Red section and reaches its stated Green verification before the next task starts.

## Requirement → task map

- R1 → T1, T2, T17, T21, T22, T23
- R2 → T3, T20, T21, T22, T23
- R3 → T4, T5, T7, T8, T9, T10, T15, T18, T19, T21, T23
- R4 → T11, T12, T13, T14, T18, T21, T23
- R5 → T6, T9, T14, T15, T16, T17, T19, T21, T23
- R6 → T1, T5, T6, T7, T11, T12, T13, T14, T19, T20, T22, T23
- R7 → T3, T15, T20, T21, T22, T23

## Task list

### T1 — Pin the Vercel build and free-tier deployment contract

**Maps to:** R1, R6
**Files touched:** `tests/deployment/vercel-hybrid.test.ts` (new), `vercel.json` (new), `package.json` (modify), `pnpm-lock.yaml` (modify), `infra/vercel.env.example` (new)

#### Red — failing test

File: `tests/deployment/vercel-hybrid.test.ts`

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(vercel.functions).toMatchObject({
      "app/api/feed/stream/route.ts": { maxDuration: 60 },
      "app/api/internal/maintenance/route.ts": { maxDuration: 60 },
    });
    expect(env).toContain("ENABLE_EXPERIMENTAL_COREPACK=1");
    expect(env).toContain("GUSTAVO_HYBRID_BRIDGE_ENABLED=false");
    expect(env).toContain("GUSTAVO_MARKET_POLLER_ENABLED=false");
    expect(env).not.toMatch(/OPENAI_API_KEY|PAID_FALLBACK|OVERAGE_ENABLED/);
  });
});
```

Expected initial state: importing the fixture reaches `readFileSync("vercel.json")` and fails with `ENOENT` because the deployment manifest does not exist.

#### Green — minimum implementation

- Add `vercel.json` with only the two 60-second route bounds and the canonical Next.js framework declaration.
- Add `@upstash/qstash` and `@vercel/functions` with `pnpm add`, preserving the existing Node and pnpm engine pins.
- Add `infra/vercel.env.example` containing names and inert feature flags only; every secret value is blank and no paid-provider variable exists.
- Preserve the existing scripts and application dependencies.

#### Refactor

- Sort the new environment names by hosted, dispatch, and local-bridge responsibility so later runbook tasks can copy the same grouping exactly.

#### Verify

Command: `pnpm vitest run tests/deployment/vercel-hybrid.test.ts -t "pins Node 24, pnpm 11, bounded functions, and explicit free-tier flags"`

Expected: one test passes, zero fail, exit code 0; `pnpm install --frozen-lockfile` exits 0.

#### Reviewable as a unit?

Yes. It changes only package/runtime declarations and an empty environment contract.

---

### T2 — Make PostgreSQL pooling serverless-aware without changing transaction authority

**Maps to:** R1, R5
**Files touched:** `lib/server/db/postgres.ts` (modify), `tests/deployment/vercel-hybrid.test.ts` (modify)

#### Red — failing test

File: `tests/deployment/vercel-hybrid.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { postgresPoolPolicy } from "../../lib/server/db/postgres";

describe("Vercel PostgreSQL policy", () => {
  it("uses a bounded Vercel pool and attaches exactly that pool", () => {
    const attach = vi.fn();
    const policy = postgresPoolPolicy(
      { VERCEL: "1", DATABASE_URL: "postgresql://example.invalid/db" },
      attach,
    );

    expect(policy.options).toMatchObject({
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
    });
    policy.attach({ marker: "pool" } as never);
    expect(attach).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledWith({ marker: "pool" });
  });
});
```

Expected initial state: TypeScript compilation fails because `postgresPoolPolicy` is not exported.

#### Green — minimum implementation

- Add `postgresPoolPolicy(env, attachDatabasePool)` as a pure policy constructor.
- Use `max: 5`, `connectionTimeoutMillis: 5_000`, and `idleTimeoutMillis: 5_000` when `VERCEL=1`; retain the verified local `max: 10` behavior otherwise.
- Call `attachDatabasePool` once for the shared Vercel `pg.Pool` immediately after construction.
- Leave `databaseFromPool`, real COMMIT measurement, SSL verification, and transaction behavior unchanged.

#### Refactor

- Keep environment parsing in the pure policy function and shared-pool lifetime in `configuredPool()` so tests do not need live database connections.

#### Verify

Command: `pnpm vitest run tests/deployment/vercel-hybrid.test.ts -t "uses a bounded Vercel pool and attaches exactly that pool"`

Expected: one selected test passes, zero fail, exit code 0; `pnpm tsc --noEmit` exits 0.

#### Reviewable as a unit?

Yes. The diff is one policy seam and one call at pool creation.

---

### T3 — Add an idempotent production migration command

**Maps to:** R2, R7
**Files touched:** `scripts/migrate-production.ts` (new), `package.json` (modify), `tests/deployment/vercel-hybrid.test.ts` (modify)

#### Red — failing test

File: `tests/deployment/vercel-hybrid.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { runProductionMigrations } from "../../scripts/migrate-production";

describe("production migrations", () => {
  it("takes one advisory lock and applies each ordered migration once", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ filename: "0001_events.sql" }] })
      .mockResolvedValue({ rows: [] });

    const result = await runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql", "0002_event_metadata.sql"],
      readMigration: (name) => `-- ${name}`,
      withClient: async (work) => work({ query } as never),
    });

    expect(query.mock.calls[0][0]).toContain("pg_advisory_lock");
    expect(result).toEqual({ applied: ["0002_event_metadata.sql"], skipped: ["0001_events.sql"] });
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../scripts/migrate-production'`.

#### Green — minimum implementation

- Export `runProductionMigrations` with the dependency seam shown in the test and a CLI wrapper that reads `DATABASE_URL` only from the environment.
- Validate exact `NNNN_name.sql` filenames, sort them lexically, take the fixed advisory lock `gustavo:production-migrations:v1`, and record a checksum before considering a migration complete.
- Reject a changed checksum for a recorded filename and always release the session lock in `finally`.
- Add `production:migrate` to `package.json`; never print the URL or SQL parameter values.

#### Refactor

- Share the filename/checksum loop between the injected test path and the real `pg.Client` path.

#### Verify

Command: `pnpm vitest run tests/deployment/vercel-hybrid.test.ts -t "takes one advisory lock and applies each ordered migration once"`

Expected: one selected test passes, zero fail, exit code 0; a second call in the test fixture reports every migration in `skipped`.

#### Reviewable as a unit?

Yes. It introduces one isolated operator command and no application request path.

---

### T4 — Add body-free bridge, market, heartbeat, receipt, and quota authority

**Maps to:** R3, R4, R5, R6
**Files touched:** `db/migrations/0022_hybrid_deployment.sql` (new), `lib/server/bridge/jobs.ts` (new), `tests/bridge/jobs.test.ts` (new)

#### Red — failing test

File: `tests/bridge/jobs.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { appendMessage } from "../../lib/server/history/messages";
import { createConversationFixture } from "../helpers/postgres";

describe("bridge job authority", () => {
  it("enqueues one body-free Node job for a completed USER message", async () => {
    const fixture = await createConversationFixture("bridge-node-authority");
    const message = await appendMessage(fixture, {
      idempotencyKey: "bridge-user-1",
      role: "USER",
      text: "private operator prompt",
    });
    const jobs = await fixture.db.query<Record<string, unknown>>(
      "select * from bridge_model_jobs where source_event_id=$1",
      [message.eventId],
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ role: "NODE", priority: 0, status: "PENDING" });
    expect(Object.keys(jobs[0])).not.toEqual(
      expect.arrayContaining(["prompt", "body", "output", "ciphertext"]),
    );
    await expect(fixture.db.query(
      "update bridge_model_jobs set source_event_id=gen_random_uuid() where source_event_id=$1",
      [message.eventId],
    )).rejects.toThrow(/BRIDGE_JOB_IMMUTABLE/);
  });
});
```

Expected initial state: the query fails with PostgreSQL `relation "bridge_model_jobs" does not exist`.

#### Green — minimum implementation

- Add the seven bounded tables named in the design: model jobs, wake receipts, worker heartbeats, poll windows, latest quotes, quota counters, and the exact catalog authority needed by the migration.
- Add indexes for claim order, lease recovery, receipt pruning, heartbeat lookup, five-minute poll lookup, and one-row-per-symbol latest lookup.
- Add a trigger from a completed USER message event to exactly one immutable Node job; trigger code derives the digest from protected authority and stores no body.
- Add semantic immutability triggers that allow only named lease/status/attempt/output/safe-code transitions.
- Export row types and safe status constants from `jobs.ts`; no claiming behavior is added until T5.

#### Refactor

- Put role, status, kind, component, and terminal-code domains in SQL check constraints and mirror them as frozen TypeScript tuples.

#### Verify

Command: `pnpm vitest run tests/bridge/jobs.test.ts -t "enqueues one body-free Node job for a completed USER message"`

Expected: one selected test passes, zero fail, exit code 0; `pnpm vitest run tests/conversations/native-history.test.ts` remains green.

#### Reviewable as a unit?

Yes. This task establishes schema authority and automatic Node staging only; worker behavior remains absent.

---

### T5 — Claim jobs with priority, leases, replay, and the 100-job daily cap

**Maps to:** R3, R6
**Files touched:** `lib/server/bridge/jobs.ts` (modify), `tests/bridge/jobs.test.ts` (modify)

#### Red — failing test

File: `tests/bridge/jobs.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { BRIDGE_ROLE_PRIORITIES, claimNextBridgeJob } from "../../lib/server/bridge/jobs";
import { appendMessage } from "../../lib/server/history/messages";
import { createConversationFixture } from "../helpers/postgres";

describe("bridge claiming", () => {
  it("serializes one active job, orders Node/Evaluator/Main, and rejects job 101", async () => {
    const fixture = await createConversationFixture("bridge-claim-order");
    await appendMessage(fixture, { idempotencyKey: "claim-1", role: "USER", text: "one" });
    await appendMessage(fixture, { idempotencyKey: "claim-2", role: "USER", text: "two" });

    expect(BRIDGE_ROLE_PRIORITIES).toEqual({ NODE: 0, EVALUATOR: 10, MAIN: 20 });
    const first = await claimNextBridgeJob(fixture.db, { workerId: "local-v1", now: new Date("2026-08-13T12:00:00Z") });
    const overlapping = await claimNextBridgeJob(fixture.db, { workerId: "local-v2", now: new Date("2026-08-13T12:00:00Z") });
    expect(first?.role).toBe("NODE");
    expect(overlapping).toBeNull();

    const capped = await createConversationFixture("bridge-claim-cap");
    await appendMessage(capped, { idempotencyKey: "cap-1", role: "USER", text: "capped" });
    await capped.db.query(
      `insert into deployment_quota_counters (quota_name,bucket_date,used_count,limit_count)
       values ('CODEX_JOBS',date '2026-08-13',100,100)
       on conflict (quota_name,bucket_date) do update set used_count=100,limit_count=100`,
    );
    await expect(claimNextBridgeJob(capped.db, {
      workerId: "local-v1",
      now: new Date("2026-08-13T12:01:00Z"),
    })).rejects.toThrow("CODEX_DAILY_QUOTA_EXHAUSTED");
  });
});
```

Expected initial state: TypeScript compilation fails because `claimNextBridgeJob` is not exported.

#### Green — minimum implementation

- Claim inside one transaction using the fixed advisory lock, `FOR UPDATE SKIP LOCKED`, and order `(priority, created_at, job_id)`.
- Permit one `CLAIMED` job globally; recover only expired leases with the same job ID and request digest.
- Increment the fixed UTC `CODEX_JOBS` daily counter atomically before claim; reject count 101 without changing a job.
- Add `completeBridgeJob` and `failBridgeJob` transitions with bounded attempts, exact output-event binding, and safe error-code allowlist.
- Make same-job completion replay return the durable result and conflicting output authority fail closed.

#### Refactor

- Centralize the claim/transition SQL column lists to avoid accidentally selecting protected event bodies.

#### Verify

Command: `pnpm vitest run tests/bridge/jobs.test.ts -t "serializes one active job, orders Node/Evaluator/Main, and rejects job 101"`

Expected: one selected test passes, zero fail, exit code 0; the full bridge job file passes.

#### Reviewable as a unit?

Yes. It adds only durable queue lifecycle behavior on top of T4 authority.

---

### T6 — Verify QStash wakes before recording or dispatching them

**Maps to:** R5, R6
**Files touched:** `lib/server/bridge/qstash.ts` (new), `tests/bridge/qstash.test.ts` (new)

#### Red — failing test

File: `tests/bridge/qstash.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { acceptQStashWake } from "../../lib/server/bridge/qstash";

describe("QStash wake authority", () => {
  it("binds signature, URL, body, age, replay receipt, and daily cap before wake", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const record = vi.fn().mockResolvedValue({ accepted: true, dailyCount: 900 });
    const wake = vi.fn();
    const request = new Request("https://bridge.example.test/wake", {
      method: "POST",
      headers: {
        "upstash-signature": "signed",
        "upstash-message-id": "msg-900",
      },
      body: JSON.stringify({ jobId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f" }),
    });
    const cappedRequest = request.clone();

    await expect(acceptQStashWake(cappedRequest, {
      expectedUrl: "https://bridge.example.test/wake",
      now: new Date("2026-08-13T12:00:00Z"),
      verify,
      recordReceipt: record,
      wake,
    })).resolves.toEqual({ accepted: true });
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(wake.mock.invocationCallOrder[0]);

    record.mockResolvedValueOnce({ accepted: false, reason: "DAILY_CAP", dailyCount: 900 });
    await expect(acceptQStashWake(request, {
      expectedUrl: "https://bridge.example.test/wake",
      now: new Date("2026-08-13T12:00:00Z"),
      verify,
      recordReceipt: record,
      wake,
    })).rejects.toThrow("QSTASH_DAILY_QUOTA_EXHAUSTED");
    expect(wake).toHaveBeenCalledTimes(1);
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../lib/server/bridge/qstash'`.

#### Green — minimum implementation

- Wrap `@upstash/qstash` Receiver verification and bind the exact production URL, exact canonical body bytes, current/next signing keys, maximum age, and message ID.
- Record the unique receipt and increment `QSTASH_MESSAGES` in one database transaction before calling the supplied wake callback.
- Reject replays, missing/extra JSON keys, expired signatures, URL mismatch, and use 901 while keeping the wake callback untouched.
- Add `publishOpaqueWake` that sends only `{ jobId }` or `{ windowId }`; reject any body key named prompt, text, quote, token, URL, or ciphertext.

#### Refactor

- Reuse one exact-object parser for hosted maintenance and local wake messages while keeping their allowed key sets separate.

#### Verify

Command: `pnpm vitest run tests/bridge/qstash.test.ts`

Expected: signature, replay, expiry, URL/body, receipt-order, opaque-body, and 900/day cases all pass; exit code 0.

#### Reviewable as a unit?

Yes. It is an isolated transport-authority module with injected side effects.

---

### T7 — Run Codex with a fixed isolated process contract

**Maps to:** R3, R6
**Files touched:** `worker/hybrid/codex-runner.ts` (new), `tests/bridge/codex-cli.test.ts` (new)

#### Red — failing test

File: `tests/bridge/codex-cli.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { runIsolatedCodex } from "../../worker/hybrid/codex-runner";

describe("isolated Codex runner", () => {
  it("uses only fixed noninteractive arguments, stdin, schema output, and a process-tree deadline", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '{"response":"bounded response"}\n',
      stderr: "",
    });
    const result = await runIsolatedCodex({
      role: "NODE",
      prompt: "private prompt",
      workspace: "C:\\gustavo-codex-empty\\run-1",
      codexHome: "C:\\gustavo-codex-home",
      timeoutMs: 30_000,
      execute,
    });

    const invocation = execute.mock.calls[0][0];
    expect(invocation.args).toEqual([
      "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
      "--sandbox", "read-only", "--ask-for-approval", "never", "--json",
      "--output-schema", expect.stringMatching(/node\.schema\.json$/),
      "-C", "C:\\gustavo-codex-empty\\run-1", "-",
    ]);
    expect(invocation.stdin).toBe("private prompt");
    expect(invocation.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).toEqual({ response: "bounded response" });
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../worker/hybrid/codex-runner'`.

#### Green — minimum implementation

- Implement the exact fixed argument vector shown in the test; user content is stdin only and cannot contribute argv, environment names, paths, model, or flags.
- Require a dedicated `CODEX_HOME`, a real empty workspace outside the repository, and an allowlisted role schema generated in that workspace.
- Remove model API keys, MCP/plugin/connector variables, repository paths, browser variables, and inherited `CODEX_HOME` from the child environment before adding the dedicated value.
- Bound stdin, stdout, stderr, JSON events, final response, and wall time; kill the full Windows process tree on abort/timeout and discard partial output.
- Reject malformed JSON, extra schema keys, nonzero exit, unsupported role, unavailable configured model, and any output after the bound with safe codes only.

#### Refactor

- Keep process spawning behind the injected `execute` contract so process-safety cases use a fake child and one later integration test uses a fixture executable.

#### Verify

Command: `pnpm vitest run tests/bridge/codex-cli.test.ts -t "uses only fixed noninteractive arguments, stdin, schema output, and a process-tree deadline"`

Expected: one selected test passes, zero fail, exit code 0; the same file's timeout and malformed-output cases pass.

#### Reviewable as a unit?

Yes. It is a standalone process boundary and does not yet read or write Gustavo data.

---

### T8 — Adapt isolated Codex output to the existing model gateway

**Maps to:** R3, R6
**Files touched:** `lib/server/models/codex-cli.ts` (new), `tests/bridge/codex-cli.test.ts` (modify)

#### Red — failing test

File: `tests/bridge/codex-cli.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { createCodexCliProvider } from "../../lib/server/models/codex-cli";

describe("Codex model provider", () => {
  it("maps one bounded role request and never exposes a paid fallback", async () => {
    const run = vi.fn().mockResolvedValue({ response: "Node answer" });
    const provider = createCodexCliProvider({
      model: "gpt-5.6-sol",
      run,
    });

    const response = await provider.generate({
      role: "NODE",
      prompt: "encrypted-source prompt after authorized load",
      maxOutputTokens: 800,
      correlationId: "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f",
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      role: "NODE",
      prompt: "encrypted-source prompt after authorized load",
      model: "gpt-5.6-sol",
    }));
    expect(response).toMatchObject({ text: "Node answer", provider: "codex-cli" });
    expect(provider).not.toHaveProperty("fallback");
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../lib/server/models/codex-cli'`.

#### Green — minimum implementation

- Implement the existing `ModelProviderAdapter` shape using an injected local runner and the single configured model `gpt-5.6-sol`.
- Map NODE, MAIN, and EVALUATOR to separate strict output schemas and existing gateway token/time limits.
- Return bounded usage metadata only when Codex reports it; otherwise return explicit unknown usage rather than estimated billable cost.
- Map CLI quota/auth/model-unavailable/timeout/malformed cases to safe provider errors; do not instantiate another provider.

#### Refactor

- Reuse existing gateway role/status constants instead of creating a parallel role model.

#### Verify

Command: `pnpm vitest run tests/bridge/codex-cli.test.ts -t "maps one bounded role request and never exposes a paid fallback"`

Expected: one selected test passes, zero fail, exit code 0; `pnpm vitest run tests/models/gateway-audit.test.ts` remains green.

#### Reviewable as a unit?

Yes. It is a thin provider adapter over T7 with no queue orchestration.

---

### T9 — Execute a Node job from durable message to routed reply

**Maps to:** R3, R5
**Files touched:** `worker/hybrid/runtime.ts` (new), `lib/server/history/messages.ts` (modify), `app/api/conversations/[conversationId]/messages/route.ts` (modify), `tests/bridge/jobs.test.ts` (modify)

#### Red — failing test

File: `tests/bridge/jobs.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { appendMessage, listMessages } from "../../lib/server/history/messages";
import { runOneHybridJob } from "../../worker/hybrid/runtime";
import { createConversationFixture } from "../helpers/postgres";

describe("Node bridge execution", () => {
  it("re-authorizes the source and commits one routed Node reply after the USER message", async () => {
    const fixture = await createConversationFixture("bridge-node-run");
    await appendMessage(fixture, {
      idempotencyKey: "node-source-1",
      role: "USER",
      text: "explain today's simulation",
    });
    const generate = vi.fn().mockResolvedValue({ text: "Node private reply", provider: "codex-cli" });

    await expect(runOneHybridJob({
      db: fixture.db,
      workerId: "local-worker-v1",
      generate,
      publishWake: vi.fn(),
    })).resolves.toMatchObject({ role: "NODE", status: "COMPLETED" });

    const history = await listMessages(fixture, { limit: 10 });
    expect(history.items.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "USER", text: "explain today's simulation" },
      { role: "NODE", text: "Node private reply" },
    ]);
    expect(generate).toHaveBeenCalledOnce();
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../worker/hybrid/runtime'`.

#### Green — minimum implementation

- Add a one-shot runtime that claims through T5, reloads and authorizes the exact account/conversation/node/source event, then calls existing `routeNodeReply`, model gateway, and routed NODE `appendMessage`.
- Extend the message result with immutable account/conversation/node/source IDs needed for job binding; do not return plaintext to queue code.
- After the POST route commits the USER message, publish an opaque `{ jobId }` QStash wake best-effort. Wake failure returns `202 queued` rather than rolling back the message.
- Complete the job only after the NODE response event commits; on replay, return the existing response without a second model run.
- Abort with safe status when account authority, conversation, source event, routing authority, or encryption key is revoked.

#### Refactor

- Separate `runOneHybridJob` from the long-lived controller so deterministic tests perform one claim without timers.

#### Verify

Command: `pnpm vitest run tests/bridge/jobs.test.ts -t "re-authorizes the source and commits one routed Node reply after the USER message"`

Expected: one selected test passes, zero fail, exit code 0; `pnpm vitest run tests/conversations/native-history.test.ts tests/node-brains/router.test.ts` remains green.

#### Reviewable as a unit?

Yes. It adds only the Node vertical slice and opaque wake-after-commit behavior.

---

### T10 — Gate Main publication on a durable Evaluator result

**Maps to:** R3, R6
**Files touched:** `lib/server/bridge/jobs.ts` (modify), `worker/hybrid/runtime.ts` (modify), `db/migrations/0022_hybrid_deployment.sql` (modify), `tests/bridge/jobs.test.ts` (modify)

#### Red — failing test

File: `tests/bridge/jobs.test.ts`

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  executeEvaluatorBridgeJob,
  executeMainBridgeJob,
} from "../../worker/hybrid/runtime";

describe("Main and Evaluator bridge execution", () => {
  it("creates Evaluator from Main and publishes only an accepted exact review", async () => {
    const appendCandidate = vi.fn().mockResolvedValue({ candidateEventId: "candidate-event" });
    const stageEvaluator = vi.fn().mockResolvedValue({ jobId: "evaluator-job" });
    const main = await executeMainBridgeJob({
      jobId: "main-job",
      loadAuthority: vi.fn().mockResolvedValue({ cycleId: "cycle-1", prompt: "authorized grounding" }),
      generate: vi.fn().mockResolvedValue({ candidate: "bounded candidate" }),
      appendCandidate,
      stageEvaluator,
    });
    const commitBroadcast = vi.fn().mockResolvedValue({ broadcastId: "broadcast-1" });
    const evaluation = await executeEvaluatorBridgeJob({
      jobId: "evaluator-job",
      loadAuthority: vi.fn().mockResolvedValue({ cycleId: "cycle-1", candidateEventId: "candidate-event", prompt: "authorized rubric" }),
      generate: vi.fn().mockResolvedValue({ decision: "ACCEPT", rationaleCode: "SUPPORTED" }),
      commitBroadcast,
    });

    expect(main).toEqual({ candidateEventId: "candidate-event", evaluatorJobId: "evaluator-job" });
    expect(stageEvaluator).toHaveBeenCalledWith(expect.objectContaining({ candidateEventId: "candidate-event" }));
    expect(evaluation).toEqual({ broadcastId: "broadcast-1", decision: "ACCEPT" });
    expect(commitBroadcast).toHaveBeenCalledWith(expect.objectContaining({ cycleId: "cycle-1", candidateEventId: "candidate-event" }));
    const migration = readFileSync("db/migrations/0022_hybrid_deployment.sql", "utf8");
    expect(migration).toMatch(/main\.broadcast\.generation\.requested[\s\S]+bridge_model_jobs/);
    expect(migration).toMatch(/candidate_event_id[\s\S]+EVALUATOR/);
  });
});
```

Expected initial state: TypeScript compilation fails because `executeMainBridgeJob` and `executeEvaluatorBridgeJob` are not exported from the T9 Node-only runtime.

#### Green — minimum implementation

- Stage one Main job per durable generation cycle through SQL authority.
- Main loads the authorized cycle/grounding, commits an encrypted candidate event, and atomically stages one priority-10 Evaluator job linked to that candidate.
- Evaluator loads the exact candidate/cycle/rubric, accepts strict JSON only, and calls existing `commitBroadcast` only for `ACCEPT` with matching provenance.
- `REJECT`, malformed, revoked, quota, and model errors publish no broadcast and write a safe terminal job result.
- Enforce the priority order NODE 0, EVALUATOR 10, MAIN 20 and same-cycle idempotency in SQL and runtime tests.

#### Refactor

- Route role-specific execution through a frozen handler map after claim; keep claim, completion, and failure transitions role-neutral.

#### Verify

Command: `pnpm vitest run tests/bridge/jobs.test.ts -t "creates Evaluator from Main and publishes only an accepted exact review"`

Expected: one selected test passes, zero fail, exit code 0; `pnpm vitest run tests/broadcasts` remains green.

#### Reviewable as a unit?

Yes. It extends the bridge with one explicit Main → Evaluator → broadcast state machine.

---

### T11 — Freeze the exact 95-symbol catalog and five-minute session budget

**Maps to:** R4, R6
**Files touched:** `config/market-universe.ts` (new), `lib/server/market-data/session.ts` (new), `tests/market-data/finnhub-poller.test.ts` (new)

#### Red — failing test

File: `tests/market-data/finnhub-poller.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { MARKET_UNIVERSE } from "../../config/market-universe";
import { createMarketWindowPlan } from "../../lib/server/market-data/session";

const EXPECTED_STOCKS = "AAPL, MSFT, NVDA, AMZN, GOOGL, GOOG, META, TSLA, BRK.B, AVGO, JPM, LLY, V, XOM, MA, UNH, COST, WMT, NFLX, ORCL, HD, PG, JNJ, BAC, ABBV, KO, CRM, CVX, MRK, AMD, PLTR, CSCO, ACN, MCD, IBM, GE, CAT, GS, MS, AXP, BX, TMO, ISRG, LIN, ABT, DIS, NOW, QCOM, TXN, AMGN, DHR, PEP, PM, INTU, BKNG, RTX, AMAT, SPGI, NEE, LOW, UPS, HON, PFE, C, MU, SBUX, COP, SCHW, GILD, ADP, DE, BLK, PANW, LRCX, KLAC".split(", ");
const EXPECTED_ETFS = "SPY, QQQ, DIA, IWM, VTI, VO, VB, VOO, IVV, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, ARKK".split(", ");

describe("Finnhub market window", () => {
  it("freezes the approved 75 stocks and 20 ETFs within 96 calls and 300 seconds", () => {
    const plan = createMarketWindowPlan(new Date("2026-08-13T13:30:00Z"));
    expect(MARKET_UNIVERSE).toHaveLength(95);
    expect(MARKET_UNIVERSE.filter((item) => item.kind === "STOCK")).toHaveLength(75);
    expect(MARKET_UNIVERSE.filter((item) => item.kind === "ETF")).toHaveLength(20);
    expect(MARKET_UNIVERSE.filter((item) => item.kind === "STOCK").map((item) => item.symbol)).toEqual(EXPECTED_STOCKS);
    expect(MARKET_UNIVERSE.filter((item) => item.kind === "ETF").map((item) => item.symbol)).toEqual(EXPECTED_ETFS);
    expect(new Set(MARKET_UNIVERSE.map((item) => item.symbol)).size).toBe(95);
    expect(MARKET_UNIVERSE[0].symbol).toBe("AAPL");
    expect(MARKET_UNIVERSE.at(-1)?.symbol).toBe("ARKK");
    expect(plan.totalCalls).toBe(96);
    expect(plan.quoteStarts.at(-1)?.getTime() - plan.quoteStarts[0].getTime()).toBeLessThanOrEqual(282_000);
    expect(plan.quoteStarts.every((time, index, all) => index === 0 || time.getTime() - all[index - 1].getTime() >= 3_000)).toBe(true);
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../config/market-universe'`.

#### Green — minimum implementation

- Export the exact 75-stock and 20-ETF catalog from the approved design as frozen literal objects with symbol and kind only.
- Reject duplicates, whitespace, lowercase, noncatalog additions, and mutation at module initialization.
- Implement a pure window plan containing one market-status request and 95 quote start instants separated by at least three seconds.
- Bound a window at five minutes, fixed call count 96, exact result count 95, and explicit closed-session no-quote plan.

#### Refactor

- Derive the combined catalog from separately frozen stock and ETF tuples while exporting one read-only `MARKET_UNIVERSE`.

#### Verify

Command: `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "freezes the approved 75 stocks and 20 ETFs within 96 calls and 300 seconds"`

Expected: one selected test passes, zero fail, exit code 0; TypeScript verifies the catalog as read-only.

#### Reviewable as a unit?

Yes. This task contains pure constants and scheduling arithmetic only.

---

### T12 — Map Finnhub responses with pacing, deadlines, and explicit unavailable states

**Maps to:** R4, R6
**Files touched:** `lib/server/market-data/finnhub.ts` (new), `tests/market-data/finnhub-poller.test.ts` (modify)

#### Red — failing test

File: `tests/market-data/finnhub-poller.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { pollFinnhubWindow } from "../../lib/server/market-data/finnhub";

describe("Finnhub adapter", () => {
  it("returns exactly 95 bounded results and never starts call 97", async () => {
    const starts: number[] = [];
    let now = 0;
    const fetchQuote = vi.fn(async (symbol: string) => {
      starts.push(now);
      return symbol === "BRK.B"
        ? { status: 429 as const }
        : { status: 200 as const, json: { c: 100.25, t: 1_776_089_600 } };
    });
    const result = await pollFinnhubWindow({
      marketOpen: true,
      fetchQuote,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      timeoutMs: 2_500,
    });

    expect(result.items).toHaveLength(95);
    expect(fetchQuote).toHaveBeenCalledTimes(95);
    expect(starts.every((value, index) => index === 0 || value - starts[index - 1] >= 3_000)).toBe(true);
    expect(result.items.find((item) => item.symbol === "BRK.B")?.status).toBe("RATE_LIMITED");
    expect(result.callsUsed).toBe(96);
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../lib/server/market-data/finnhub'`.

#### Green — minimum implementation

- Implement local-only Finnhub status/quote HTTP mapping; the API key enters the authorization/query construction from environment at call time and is never returned or logged.
- Start one quote request per plan instant, abort each below three seconds, and finalize every missing catalog symbol to `PROVIDER_ERROR` before returning.
- Map valid numbers/timestamps to `SUCCESS`; zero/missing/stale/unsupported to `UNAVAILABLE`; 429 to `RATE_LIMITED`; other bounded failures to `PROVIDER_ERROR`.
- If market status is closed, issue no quote requests and return 95 `UNAVAILABLE` items with safe code `MARKET_CLOSED`.
- Reject any attempt to exceed the fixed catalog, call count, deadline, or result count.

#### Refactor

- Keep response parsing pure and isolate fetch/deadline/pacing in the polling function.

#### Verify

Command: `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "returns exactly 95 bounded results and never starts call 97"`

Expected: one selected test passes, zero fail, exit code 0; closed, timeout, malformed, 429, and unsupported-symbol cases pass in the same file.

#### Reviewable as a unit?

Yes. It introduces only provider protocol and deterministic pacing.

---

### T13 — Store one encrypted latest quote per symbol and materialize only consumed observations

**Maps to:** R4, R6
**Files touched:** `lib/server/market-data/latest.ts` (new), `db/migrations/0022_hybrid_deployment.sql` (modify), `tests/market-data/finnhub-poller.test.ts` (modify)

#### Red — failing test

File: `tests/market-data/finnhub-poller.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { loadLatestMarket, storeLatestMarketWindow } from "../../lib/server/market-data/latest";
import { createConversationFixture } from "../helpers/postgres";

describe("latest market projection", () => {
  it("upserts exactly one encrypted row per symbol and creates no observation until consumption", async () => {
    const fixture = await createConversationFixture("latest-market");
    const item = {
      symbol: "AAPL",
      kind: "STOCK" as const,
      status: "SUCCESS" as const,
      price: "225.10",
      sourceObservedAt: "2026-08-13T13:30:00.000Z",
      safeCode: null,
    };
    await storeLatestMarketWindow(fixture, { windowId: "2026-08-13T13:30Z", items: [item] });
    await storeLatestMarketWindow(fixture, { windowId: "2026-08-13T13:35Z", items: [{ ...item, price: "226.20" }] });

    const raw = await fixture.db.query<Record<string, unknown>>(
      "select * from market_latest_quotes where account_id=$1 and symbol='AAPL'",
      [fixture.accountId],
    );
    const observations = await fixture.db.query("select id from market_observations");
    const latest = await loadLatestMarket(fixture, ["AAPL"]);

    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw[0])).not.toContain("226.20");
    expect(observations).toHaveLength(0);
    expect(latest[0]).toMatchObject({ symbol: "AAPL", price: "226.20" });
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../lib/server/market-data/latest'`.

#### Green — minimum implementation

- Encrypt each successful latest quote with the account aggregate key and authenticated context binding account, catalog symbol, poll window, and provider.
- Store one monotonic row per `(account_id, symbol)`; newer source time wins, equal-window exact replay is idempotent, and conflicting replay fails.
- Store unavailable states without a price body and keep seven days of bounded poll summaries.
- Implement `materializeMarketObservation` that re-authorizes/decrypts a latest row and appends canonical `market_observations` only when an existing decision command names that exact latest version.
- Add triggers that reject noncatalog symbols, plaintext columns, cross-account keys, stale overwrites, and observation creation without decision provenance.

#### Refactor

- Reuse the existing encryption envelope/key APIs and market provider DTO types; do not create a second cryptographic format.

#### Verify

Command: `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "upserts exactly one encrypted row per symbol and creates no observation until consumption"`

Expected: one selected test passes, zero fail, exit code 0; direct SQL plaintext/stale/cross-account adversarial cases pass.

#### Reviewable as a unit?

Yes. This task owns only encrypted projection authority and consumption materialization.

---

### T14 — Poll the complete market window while keeping Neon disconnected during network work

**Maps to:** R4, R5, R6
**Files touched:** `worker/hybrid/market-poller.ts` (new), `lib/server/market-data/session.ts` (modify), `tests/market-data/finnhub-poller.test.ts` (modify)

#### Red — failing test

File: `tests/market-data/finnhub-poller.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { MARKET_UNIVERSE } from "../../config/market-universe";
import { runMarketPollWindow } from "../../worker/hybrid/market-poller";

describe("local market poller", () => {
  it("opens Neon only after all provider calls and persists one complete bounded window", async () => {
    const order: string[] = [];
    const poll = vi.fn(async () => {
      order.push("provider:start", "provider:finish");
      return {
        windowId: "2026-08-13T13:30Z",
        callsUsed: 96,
        items: MARKET_UNIVERSE.map(({ symbol, kind }) => ({
          symbol,
          kind,
          status: "UNAVAILABLE" as const,
          price: null,
          sourceObservedAt: null,
          safeCode: "PROVIDER_ERROR" as const,
        })),
      };
    });
    const withDatabase = vi.fn(async (work) => {
      order.push("db:open");
      const value = await work({ marker: "db" } as never);
      order.push("db:close");
      return value;
    });
    const store = vi.fn(async () => { order.push("db:store"); });

    await runMarketPollWindow({ poll, withDatabase, store, heartbeat: vi.fn() });

    expect(order).toEqual(["provider:start", "provider:finish", "db:open", "db:store", "db:close"]);
    expect(store).toHaveBeenCalledWith({ marker: "db" }, expect.objectContaining({ callsUsed: 96 }));
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../worker/hybrid/market-poller'`.

#### Green — minimum implementation

- Reserve the fixed five-minute window/quota in a short transaction, close the connection, perform status/quote work, then open one short transaction to store all 95 results, summary, counter, and MARKET heartbeat.
- Recover incomplete windows by filling missing catalog items with a safe status; never begin a second poll for the same window.
- If calls would exceed 96 or results differ from 95, store a failed summary without latest-row mutation.
- Close and release the pool after each wake so the local process holds no idle Neon connection.
- Keep the next window pending after 429/provider failure; do not increase pacing or switch provider.

#### Refactor

- Keep the pure window planner and provider polling outside the database callback by construction.

#### Verify

Command: `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "opens Neon only after all provider calls and persists one complete bounded window"`

Expected: one selected test passes, zero fail, exit code 0; the full Finnhub poller file passes.

#### Reviewable as a unit?

Yes. It wires T11–T13 without adding HTTP or UI behavior.

---

### T15 — Expose a loopback-only signed wake server and recoverable local controller

**Maps to:** R3, R4, R5, R7
**Files touched:** `worker/hybrid/wake-server.ts` (new), `worker/hybrid/runtime.ts` (modify), `scripts/setup-hybrid-worker.ps1` (new), `scripts/start-hybrid-worker.ps1` (new), `tests/infra/hybrid-worker.test.ts` (new)

#### Red — failing test

File: `tests/infra/hybrid-worker.test.ts`

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { startHybridWakeServer } from "../../worker/hybrid/wake-server";

describe("hybrid worker host boundary", () => {
  it("binds loopback, verifies before wake, serializes work, and installs exact startup commands", async () => {
    const verify = vi.fn().mockResolvedValue({ accepted: true });
    const wake = vi.fn().mockResolvedValue(undefined);
    const server = await startHybridWakeServer({ host: "127.0.0.1", port: 0, verify, wake });

    expect(server.address.host).toBe("127.0.0.1");
    await server.inject({ method: "POST", path: "/wake", body: "{}", headers: {} });
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(wake.mock.invocationCallOrder[0]);
    await server.stop();

    const setup = readFileSync("scripts/setup-hybrid-worker.ps1", "utf8");
    const start = readFileSync("scripts/start-hybrid-worker.ps1", "utf8");
    expect(setup).toContain("Gustavo Hybrid Worker");
    expect(setup).toContain("DedicatedCodexHome");
    expect(setup).toContain("EmptyWorkspaceRoot");
    expect(start).toContain("tailscale funnel --bg");
    expect(start).not.toMatch(/0\.0\.0\.0|OPENAI_API_KEY|--dangerously-bypass-approvals-and-sandbox/);
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../worker/hybrid/wake-server'`.

#### Green — minimum implementation

- Bind only `127.0.0.1`; accept only `POST /wake`, bound body bytes, and T6 verification before calling a coalesced runtime wake.
- Runtime startup drains expired/pending work, permits one active Codex child, coalesces additional wakes, and can run one market window independently of model work.
- Runtime stop aborts wake acceptance, any active child/poll, pending follow-up, pool, and server inside a fixed 25-second bound.
- Setup script validates a dedicated Windows account, owner-only dedicated `CODEX_HOME`, randomized empty workspace root, no repository ACL, Node 24, pnpm 11, standalone Codex sign-in, and Tailscale sign-in before creating the exact task.
- Start script launches the loopback service first, then `tailscale funnel --bg http://127.0.0.1:<validated-port>`; logs contain safe codes/job IDs only.

#### Refactor

- Export one-shot `wakeModelDrain` and `wakeMarketWindow` methods so controller tests avoid timers and real network services.

#### Verify

Command: `pnpm vitest run tests/infra/hybrid-worker.test.ts`

Expected: loopback, signature order, one-active/coalescing, startup recovery, bounded stop, PowerShell security, heartbeat, and safe-log cases pass; exit code 0.

#### Reviewable as a unit?

Yes. It adds the local service boundary and installation scripts without changing hosted routes.

---

### T16 — Run hosted maintenance as one signed bounded Vercel invocation

**Maps to:** R5, R6
**Files touched:** `app/api/internal/maintenance/route.ts` (new), `tests/privacy/forget-propagation.test.ts` (modify), `tests/cache/postgres.test.ts` (modify)

#### Red — failing test

File: `tests/privacy/forget-propagation.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { runBoundedMaintenance } from "../../app/api/internal/maintenance/route";

describe("Vercel one-shot maintenance", () => {
  it("verifies first, holds one overlap lock, and stops all steps before 55 seconds", async () => {
    const order: string[] = [];
    const verify = vi.fn(async () => { order.push("verify"); });
    const withLock = vi.fn(async (work) => { order.push("lock"); return work(); });
    const step = (name: string) => vi.fn(async () => { order.push(name); return { processed: 1 }; });
    const result = await runBoundedMaintenance({
      deadline: new Date("2026-08-13T12:00:54.000Z"),
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      verify,
      withLock,
      cache: step("cache"),
      privacy: step("privacy"),
      stream: step("stream"),
      schedules: step("schedules"),
      bridgeLeases: step("bridgeLeases"),
    });

    expect(order).toEqual(["verify", "lock", "cache", "privacy", "stream", "schedules", "bridgeLeases"]);
    expect(result).toEqual({ processed: 5, deadlineReached: false });
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../app/api/internal/maintenance/route'`.

#### Green — minimum implementation

- Export the testable core and a `POST` handler that validates the exact QStash URL/body/signature before opening the database.
- Hold one fixed PostgreSQL advisory transaction lock and call existing one-shot cache invalidation, privacy propagation, stream publisher, due-schedule, and stale-bridge-lease functions with small batch limits.
- Check the shared deadline before and after each batch; stop below 55 seconds and return only aggregate counts/safe codes with `Cache-Control: no-store`.
- Return 204 for valid overlap/no work, 401 for invalid signature, 409 for lock conflict, and bounded 503 for database failure.
- Preserve every existing privacy barrier and cache publication fence; no long-running controller is started.

#### Refactor

- Represent the five steps as a frozen ordered tuple of name/function pairs after the initial explicit implementation is green.

#### Verify

Command: `pnpm vitest run tests/privacy/forget-propagation.test.ts -t "verifies first, holds one overlap lock, and stops all steps before 55 seconds" && pnpm vitest run tests/cache/postgres.test.ts -t "maintenance"`

Expected: selected maintenance/privacy/cache fence cases pass, zero fail, exit code 0.

#### Reviewable as a unit?

Yes. It introduces one authenticated hosted endpoint by composing existing bounded workers.

---

### T17 — Bound SSE to Vercel duration while preserving ordered database replay

**Maps to:** R1, R5
**Files touched:** `app/api/feed/stream/route.ts` (modify), `tests/stream/sse-authorization.test.ts` (modify)

#### Red — failing test

File: `tests/stream/sse-authorization.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { streamAuthorizedEvents } from "../../app/api/feed/stream/route";

describe("Vercel SSE lifecycle", () => {
  it("closes by 55 seconds and resumes after the last emitted durable cursor", async () => {
    let now = 0;
    const load = vi.fn().mockResolvedValue([])
      .mockResolvedValueOnce([{ cursor: "sse.v1:41:event-a", eventId: "event-a" }])
      .mockResolvedValueOnce([{ cursor: "sse.v1:42:event-b", eventId: "event-b" }]);
    const emitted: string[] = [];

    const result = await streamAuthorizedEvents({
      lastEventId: "sse.v1:40:event-z",
      now: () => now,
      sleep: async (ms) => { now += ms; },
      load,
      authorize: vi.fn().mockResolvedValue(true),
      emit: async (event) => { emitted.push(event.cursor); },
      maxDurationMs: 55_000,
    });

    expect(result.reason).toBe("DURATION_BOUND");
    expect(emitted).toEqual(["sse.v1:41:event-a", "sse.v1:42:event-b"]);
    expect(load.mock.calls[1][0]).toMatchObject({ after: "sse.v1:41:event-a" });
  });
});
```

Expected initial state: TypeScript compilation fails because the route does not export `streamAuthorizedEvents` with a duration bound.

#### Green — minimum implementation

- Extract the existing authorized replay/live loop into the injected core shown above without changing cursor format or database authority.
- Subscribe before replay, re-authorize before protected body load and before emit, page all allocated stream positions, and deduplicate live/replay overlap.
- Stop accepting new work by 54 seconds, emit no protected shutdown payload, close subscription/iterator, and let the browser reconnect with the last emitted cursor.
- Export `maxDuration = 60` and retain private no-store SSE headers, heartbeat bounds, queue bounds, cancellation cleanup, and fail-closed malformed cursor handling.

#### Refactor

- Use one finalizer for duration, abort, backpressure, authorization loss, and source close.

#### Verify

Command: `pnpm vitest run tests/stream/sse-authorization.test.ts`

Expected: all existing SSE tests plus duration/reconnect pass, zero fail, exit code 0.

#### Reviewable as a unit?

Yes. It is confined to one existing stream route and its focused suite.

---

### T18 — Render account-only bridge state and the complete market dashboard

**Maps to:** R3, R4, R5
**Files touched:** `lib/server/dal/account-surfaces.ts` (modify), `app/(account)/chat/page.tsx` (modify), `components/chat/Conversation.tsx` (modify), `app/(account)/market/page.tsx` (new), `components/market/MarketStatus.tsx` (new), `tests/ui/account-surfaces.test.tsx` (modify)

#### Red — failing test

File: `tests/ui/account-surfaces.test.tsx`

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Conversation } from "../../components/chat/Conversation";
import { MarketStatus } from "../../components/market/MarketStatus";
import { MARKET_UNIVERSE } from "../../config/market-universe";
import { loadMarketPageData } from "../../app/(account)/market/page";

describe("hybrid account surfaces", () => {
  it("shows queued/offline chat state and all 95 private market statuses without public serialization", async () => {
    const chat = renderToStaticMarkup(<Conversation
      conversationId="018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f"
      messages={[]}
      broadcasts={[]}
      nextCursor={null}
      bridge={{ status: "OFFLINE", pendingJobs: 1, safeCode: "LOCAL_BRIDGE_UNAVAILABLE" }}
    />);
    const market = renderToStaticMarkup(<MarketStatus items={MARKET_UNIVERSE.map((item) => ({
      ...item,
      status: "UNAVAILABLE" as const,
      price: null,
      sourceObservedAt: null,
      receivedAt: "2026-08-13T13:35:00.000Z",
      ageSeconds: null,
      freshness: "Unavailable" as const,
      safeCode: "LOCAL_BRIDGE_UNAVAILABLE" as const,
    }))} />);

    expect(chat).toContain("Message saved — local processing unavailable");
    expect(chat).toContain("1 queued");
    expect(market.match(/data-market-symbol=/g)).toHaveLength(95);
    expect(market).toContain("AAPL");
    expect(market).toContain("ARKK");
    expect(market).toMatch(/Fresh|Stale|Unavailable/);
    expect(market).not.toMatch(/ciphertext|providerKey|tunnelSecret|private operator prompt/i);

    const loadMarket = vi.fn();
    await expect(loadMarketPageData({
      getSession: vi.fn().mockResolvedValue(null),
      loadMarket,
    })).rejects.toThrow("AUTHENTICATION_REQUIRED");
    expect(loadMarket).not.toHaveBeenCalled();
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../components/market/MarketStatus'`.

#### Green — minimum implementation

- Extend the account DAL with auth-first `bridge` summary and `loadAccountMarket` that returns exactly the fixed 95 safe private DTOs after key/tenant checks.
- Add `/market` as a server-authenticated page; unauthenticated requests stop before market, heartbeat, or quote queries.
- Render symbol, kind, price only for success, provider observation time, receipt time, age/freshness, and safe unavailable state. Never serialize ciphertext, keys, raw provider responses, hostnames, tunnel URLs, or prompt data.
- Add a market link and bridge availability/queued status to `/chat`; keep committed USER messages visible when wake/model work is offline or quota-limited.
- Preserve the hydration POST guard and exact Main/Node attribution behavior.

#### Refactor

- Keep `MarketStatus` presentational over a read-only DTO and place all authentication/decryption in the server DAL.

#### Verify

Command: `pnpm vitest run tests/ui/account-surfaces.test.tsx -t "shows queued/offline chat state and all 95 private market statuses without public serialization"`

Expected: one selected test passes, zero fail, exit code 0; the full account-surface suite passes.

#### Reviewable as a unit?

Yes. This is one authenticated read/UI slice over already-built bridge and market data.

---

### T19 — Report hosted, local, and quota health without sensitive values

**Maps to:** R3, R5, R6
**Files touched:** `lib/server/bridge/health.ts` (new), `lib/server/observability/metrics.ts` (modify), `app/api/operator/health/route.ts` (modify), `tests/deployment/vercel-hybrid.test.ts` (modify)

#### Red — failing test

File: `tests/deployment/vercel-hybrid.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { projectHybridHealth } from "../../lib/server/bridge/health";

describe("hybrid operator health", () => {
  it("separates hosted and local components with durable bounded quota state", async () => {
    const dto = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "DEGRADED", stream: "HEALTHY" },
      heartbeats: [
        { component: "CODEX", observedAt: "2026-08-13T12:00:00.000Z", safeCode: null },
        { component: "MARKET", observedAt: "2026-08-13T11:55:00.000Z", safeCode: "RATE_LIMITED" },
        { component: "TUNNEL", observedAt: "2026-08-13T12:00:00.000Z", safeCode: null },
      ],
      quotas: [
        { name: "CODEX_JOBS", used: 4, limit: 100 },
        { name: "QSTASH_MESSAGES", used: 20, limit: 900 },
        { name: "FINNHUB_CALLS", used: 96, limit: 96 },
      ],
      pendingJobs: 2,
      now: new Date("2026-08-13T12:01:00.000Z"),
    });

    expect(dto).toMatchObject({
      hosted: { database: "HEALTHY", cache: "DEGRADED", stream: "HEALTHY" },
      local: { codex: "AVAILABLE", market: "DEGRADED", tunnel: "AVAILABLE" },
      bridge: { pendingJobs: 2 },
    });
    expect(JSON.stringify(dto)).not.toMatch(/hostname|url|prompt|price|token|ciphertext|providerKey/i);
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../lib/server/bridge/health'`.

#### Green — minimum implementation

- Project only fixed component names, `AVAILABLE|DEGRADED|OFFLINE|UNKNOWN`, safe codes, bounded ages, pending count, and used/limit integers.
- Read heartbeats and quota buckets from PostgreSQL so a Vercel process restart does not erase health state.
- Extend the existing bearer-auth-first operator route; unauthorized requests stop before health, heartbeat, quota, cache, or database status reads.
- Retain `Cache-Control: private, no-store`, response-size bounds, existing performance health, and generic failures.
- Never return hostnames, ports, Funnel URL, account/conversation/job IDs, model prompt/output, quote values, secrets, or raw provider errors.

#### Refactor

- Put status aging thresholds in one frozen safe policy and keep the route as authentication plus projection orchestration.

#### Verify

Command: `pnpm vitest run tests/deployment/vercel-hybrid.test.ts -t "separates hosted and local components with durable bounded quota state"`

Expected: one selected test passes, zero fail, exit code 0; existing operator-health authorization tests remain green.

#### Reviewable as a unit?

Yes. It adds one bounded DTO and extends an existing private health route.

---

### T20 — Bootstrap an empty production account with one opaque invitation

**Maps to:** R2, R7
**Files touched:** `scripts/bootstrap-production.ts` (new), `scripts/issue-invitation.ts` (modify), `package.json` (modify), `tests/deployment/vercel-hybrid.test.ts` (modify)

#### Red — failing test

File: `tests/deployment/vercel-hybrid.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { bootstrapProduction } from "../../scripts/bootstrap-production";

describe("fresh production bootstrap", () => {
  it("seeds authority only and prints one secret-free expiring redemption URL", async () => {
    const write = vi.fn();
    const issueInvitation = vi.fn().mockResolvedValue({
      redemptionUrl: "https://gustavo.lol/join?token=opaque-once",
      expiresAt: "2026-08-14T12:00:00.000Z",
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from accounts")) return [];
      if (sql.includes("from events")) return [];
      if (sql.includes("from conversations")) return [];
      if (sql.includes("from memory_records")) return [];
      if (sql.includes("from market_latest_quotes")) return [];
      return [];
    });

    await bootstrapProduction({
      databaseUrl: "postgresql://secret.invalid/gustavo",
      canonicalOrigin: "https://gustavo.lol",
      query,
      issueInvitation,
      write,
    });

    expect(issueInvitation).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toBe("https://gustavo.lol/join?token=opaque-once\n");
    expect(write.mock.calls[0][0]).not.toMatch(/postgresql|DATABASE_URL|encryption|opaque-once.*opaque-once/i);
  });
});
```

Expected initial state: module resolution fails with `Cannot find module '../../scripts/bootstrap-production'`.

#### Green — minimum implementation

- Export the injected bootstrap core and add a CLI that reads origin/database/key authority from environment only.
- Require a fully migrated schema, production deployment profile, empty accounts/conversations/events/memory/latest-market/bridge-job data, and exact seeded fixed authority before invitation issuance.
- Reject any nonempty private data or local-profile marker; do not delete or overwrite it.
- Extend `issue-invitation.ts` with canonical-origin URL output mode that prints exactly one redemption URL and sends diagnostics to safe stderr codes only.
- Add `production:bootstrap`; invitation remains expiring, single-use, opaque, and replay-rejected by the existing route.

#### Refactor

- Reuse existing invitation creation and production origin/session policy instead of duplicating token or URL rules.

#### Verify

Command: `pnpm vitest run tests/deployment/vercel-hybrid.test.ts -t "seeds authority only and prints one secret-free expiring redemption URL"`

Expected: one selected test passes, zero fail, exit code 0; invitation route/session tests remain green.

#### Reviewable as a unit?

Yes. It adds one fail-closed operator bootstrap command and a narrow output mode.

---

### T21 — Document exact free-tier setup, operation, degraded mode, and rollback

**Maps to:** R1, R2, R5, R6, R7
**Files touched:** `docs/VERCEL_DEPLOYMENT.md` (new), `docs/OPERATIONS.md` (modify), `docs/PRODUCTION_CHECKLIST.md` (modify), `docs/SMOKE_TEST.md` (modify), `infra/env.example` (modify), `tests/deployment/vercel-hybrid.test.ts` (modify)

#### Red — failing test

File: `tests/deployment/vercel-hybrid.test.ts`

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("hybrid deployment runbook", () => {
  it("names every free quota, secret channel, smoke gate, degraded state, and exact rollback action", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    const operations = readFileSync("docs/OPERATIONS.md", "utf8");
    const checklist = readFileSync("docs/PRODUCTION_CHECKLIST.md", "utf8");
    const smoke = readFileSync("docs/SMOKE_TEST.md", "utf8");
    const combined = [deploy, operations, checklist, smoke].join("\n");

    for (const required of [
      "Vercel Hobby", "Neon Free", "Upstash Redis Free", "QStash Free",
      "Tailscale Free", "Finnhub Free", "900 messages/day", "100 jobs/day",
      "96 calls/window", "95 results/window", "SIMULATION ONLY — NOT A REAL TRADE",
      "GUSTAVO_HYBRID_BRIDGE_ENABLED=false", "GUSTAVO_MARKET_POLLER_ENABLED=false",
      "tailscale funnel reset", "a0c90dc15390e5accbb42869965e5347f7576b3f",
    ]) expect(combined).toContain(required);
    expect(combined).toContain("local bridge unavailable");
    expect(combined).toContain("Preview");
    expect(combined).toContain("promote");
    expect(combined).not.toMatch(/OPENAI_API_KEY=.*\S|FINNHUB_API_KEY=.*\S|DATABASE_URL=.*\S/);
  });
});
```

Expected initial state: `readFileSync("docs/VERCEL_DEPLOYMENT.md")` fails with `ENOENT`.

#### Green — minimum implementation

- Write one command-ordered runbook: create Free resources, link the existing Vercel team/project, set Node 24/Corepack, set secrets through dashboards/CLI stdin, migrate, bootstrap, install local worker, start Funnel, configure two QStash schedules, deploy Preview, smoke, promote, and verify domains.
- Document daily/provider dashboard checks and application caps: QStash 900/day, Codex 100/day/one active, Finnhub 96/window/exactly 95 results, Redis TTL/key bounds, latest quote and seven-day poll bounds.
- Document PC-offline behavior: public/history hosted, messages durable/queued, market stale, local health offline; document reconnect recovery.
- Document backup-before-cutover, flags-first rollback, exact schedule/task/Funnel cleanup, previous Ready promotion or exact safe-shell commit, and additive migration retention.
- Add only blank secret names and deployment-profile examples to `infra/env.example`; state that standalone Codex uses interactive ChatGPT sign-in and is an unsupported application backend.

#### Refactor

- Link detailed deployment steps from existing operations/checklist/smoke documents rather than copying secret-handling instructions into four places.

#### Verify

Command: `pnpm vitest run tests/deployment/vercel-hybrid.test.ts -t "names every free quota, secret channel, smoke gate, degraded state, and exact rollback action"`

Expected: one selected test passes, zero fail, exit code 0; Markdown contains no populated secret assignments.

#### Reviewable as a unit?

Yes. It is an operations/documentation slice with one static contract test.

---

### T22 — Prove the fresh hybrid production story in one browser test

**Maps to:** R1, R2, R3, R4, R5, R6, R7
**Files touched:** `tests/e2e/gustavo-hybrid-production.spec.ts` (new)

#### Red — failing test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`

```ts
import { expect, test } from "@playwright/test";
import { e2eBaseURL, issueInvitation } from "./fixtures";

const PRIVATE_CANARY = "private-hybrid-canary-813";

test("fresh operator chat, 95-symbol market, offline recovery, and public redaction", async ({ page, request }) => {
  const invitation = await issueInvitation(request);
  await page.goto(`${e2eBaseURL()}/join?token=${encodeURIComponent(invitation)}`);
  await page.getByLabel("Display name").fill("Gustavo Operator");
  await page.getByLabel("Passphrase").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.goto(`${e2eBaseURL()}/chat`);
  await page.getByLabel("Message").fill(PRIVATE_CANARY);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(PRIVATE_CANARY)).toBeVisible();
  await expect(page.getByText("Node private fixture reply")).toBeVisible({ timeout: 30_000 });

  await page.goto(`${e2eBaseURL()}/market`);
  await expect(page.locator("[data-market-symbol]")).toHaveCount(95);
  await expect(page.locator('[data-market-symbol="AAPL"]')).toContainText(/Fresh|Unavailable/);
  await expect(page.locator('[data-market-symbol="ARKK"]')).toContainText(/Fresh|Unavailable/);

  await page.goto(e2eBaseURL());
  await expect(page.getByText("SIMULATION ONLY — NOT A REAL TRADE")).toBeVisible();
  expect(await page.content()).not.toContain(PRIVATE_CANARY);
  expect(await request.get(`${e2eBaseURL()}/api/public/feed`).then((r) => r.text())).not.toContain(PRIVATE_CANARY);
});
```

Expected initial state: the message remains queued because no local hybrid E2E controller is running, so the Node-reply assertion times out.

#### Green — minimum implementation

- In the spec's isolated test process, start the production hybrid runtime with an injected fake Codex executable that emits strict NODE/MAIN/EVALUATOR JSON and a fake Finnhub transport that returns 95 deterministic personal-use fixtures.
- Use the existing disposable PostgreSQL/Next fixture; do not add a production fixture endpoint, fake production provider, or test-mode bypass.
- Run one market wake, then verify 95 rows, timestamps/freshness, exact chat attribution, Main/Evaluator priority fixture, one active Codex child, and no local data copied at bootstrap.
- Stop the local controller to verify hosted public/history plus queued/offline status; restart it and verify exactly-once drain/recovery.
- Capture public request URLs, post bodies, HTML, RSC, and feed payloads and assert absence of the canary, live quote fixture, ciphertext markers, tokens, and tunnel data.
- Reuse the existing cross-process owned-resource registry for deterministic cleanup of every child/temp resource.

#### Refactor

- Keep fake executable/provider implementations inside the test file and inject them only through production interfaces.

#### Verify

Command: `pnpm playwright test tests/e2e/gustavo-hybrid-production.spec.ts --workers=1`

Expected: one browser story passes, zero fail, exit code 0; no owned test child, database, result directory, or port remains.

#### Reviewable as a unit?

Yes. This task adds only end-to-end proof and test-owned dependencies over the completed implementation.

---

### T23 — Provision Free resources, repair Preview, promote production, and run the final gate

**Maps to:** R1, R2, R3, R4, R5, R6, R7
**Files touched:** `tests/deployment/vercel-hybrid.test.ts` (modify), `docs/VERCEL_DEPLOYMENT.md` (modify with nonsecret resource/deployment identifiers and command results), external state in the named Vercel/Neon/Upstash/QStash/Tailscale/Finnhub accounts

#### Red — failing test

File: `tests/deployment/vercel-hybrid.test.ts`

```ts
import { describe, expect, it } from "vitest";

const live = process.env.GUSTAVO_RUN_LIVE_VERCEL_VERIFY === "1";

describe.runIf(live)("live Vercel cutover", () => {
  it("serves the Ready Node-24 deployment on the canonical domains without public leakage", async () => {
    const token = process.env.VERCEL_TOKEN!;
    const teamId = "team_2ZsWunVLuTIHx2h2zmWEAvAH";
    const projectId = "prj_HoIxQexO64tsgXrNI6m89g3P87TB";
    const headers = { authorization: `Bearer ${token}` };
    const project = await fetch(`https://api.vercel.com/v9/projects/${projectId}?teamId=${teamId}`, { headers }).then((r) => r.json());
    const deployments = await fetch(`https://api.vercel.com/v6/deployments?projectId=${projectId}&teamId=${teamId}&target=production&limit=1`, { headers }).then((r) => r.json());
    const apex = await fetch("https://gustavo.lol", { redirect: "manual" });
    const www = await fetch("https://www.gustavo.lol", { redirect: "manual" });
    const html = await apex.text();
    const publicFeed = await fetch("https://gustavo.lol/api/public/feed").then((r) => r.text());

    expect(project.nodeVersion).toBe("24.x");
    expect(deployments.deployments[0]).toMatchObject({ state: "READY", target: "production" });
    expect(apex.status).toBe(200);
    expect(www.status).toBeGreaterThanOrEqual(300);
    expect(www.status).toBeLessThan(400);
    expect(www.headers.get("location")).toMatch(/^https:\/\/gustavo\.lol\/?$/);
    expect(html).toContain("SIMULATION ONLY — NOT A REAL TRADE");
    expect(`${html}\n${publicFeed}`).not.toMatch(/private-hybrid-canary-813|ciphertext|providerKey|tunnelSecret/i);
  });
});
```

Expected initial state: with live verification enabled before cutover, the current latest deployment is `ERROR` and the Ready-state assertion fails.

#### Green — minimum implementation

- Confirm the selected plans are Vercel Hobby, Neon Free, Upstash Redis Free, QStash Free, Tailscale Free personal, and Finnhub Free personal; record plan names and nonsecret resource IDs in the runbook.
- Create a fresh Neon database in the selected US East region, create empty Upstash Redis/QStash resources, and set only secret-store environment values. Never upload local PostgreSQL, Valkey, backups, accounts, memories, or market data.
- Link the existing Vercel team/project, set Node 24.x and `ENABLE_EXPERIMENTAL_COREPACK=1`, push the reviewed mission branch, deploy Preview, run migrations/bootstrap, and redeem the single invitation.
- Install/sign in the isolated local worker account, Codex, Tailscale, and Finnhub key; start the exact loopback/Funnel controller; create only the 15-minute maintenance and five-minute market QStash schedules.
- Run Preview smoke, public artifact leakage scan, authenticated chat/market/health smoke, PC-offline/reconnect recovery, and quota boundary checks before production promotion.
- Promote that exact Ready deployment, verify apex TLS and `www` redirect, then rehearse flags-first local/schedule rollback while confirming the hosted public/history surfaces remain available; restore the verified production state afterward.
- Run the live test with the Vercel token supplied through the process environment; never write tokens or resource URLs containing credentials to disk or command arguments.

#### Refactor

- Record only repeatable commands, deployment ID, git SHA, region, plan names, schedule IDs, and dashboard paths; redact every secret and invitation token from the execution record.

#### Verify

Commands, in order:

1. `pnpm install --frozen-lockfile`
2. `pnpm test`
3. `pnpm tsc --noEmit`
4. `pnpm build`
5. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1`
6. `pnpm playwright test tests/e2e/gustavo-hybrid-production.spec.ts --workers=1`
7. `$env:GUSTAVO_RUN_LIVE_VERCEL_VERIFY='1'; pnpm vitest run tests/deployment/vercel-hybrid.test.ts -t "serves the Ready Node-24 deployment on the canonical domains without public leakage"`
8. `git diff --check`

Expected: every command exits 0; full unit/integration and focused Playwright suites have zero failures; validator reports a fresh build with no public leak; the live deployment test passes; only design-listed mission files and approved mission artifacts differ; `AGENTS.md` is byte-for-byte untouched by the mission.

#### Reviewable as a unit?

Yes. All code is already green before this task; this unit contains named external resource creation, Preview evidence, promotion, smoke evidence, and reversible cutover only.

## Plan self-review

- [x] Every requirement appears in the requirement→task map.
- [x] Every task has an exact Red test, expected initial failure, minimum Green implementation, and exact Verify command.
- [x] Every Red test imports its subject and contains concrete assertions.
- [x] No unresolved placeholders or vague implementation verbs remain.
- [x] Each task isolates one subsystem or one explicit integration boundary and is reviewable before the next task.
- [x] File paths match the approved design's expected new/modified/test files.
- [x] Repeated files are edited in ordered layers: schema before lifecycle, lifecycle before runtime, runtime before UI/E2E, and runbook before cutover.
- [x] Historical migrations 0001–0021, local Compose/Docker runtime, verified backup scripts, public feed route/component, static validator, and unrelated files remain off-limits.
- [x] `AGENTS.md` remains explicitly untouched.
- [x] Verify commands name exact files/tests and expected exit behavior.
- [x] Quota boundaries cover QStash 901, Codex job 101, one active child, Finnhub call 97 prevention, and exactly 95 results.
- [x] Security boundaries cover auth-before-read, signature/replay/age/URL binding, encrypted bodies, body-free queues, no secret argv/log/browser output, and public redaction.
- [x] Failure behavior covers offline local worker, lost wake, expired lease, malformed model output, provider 429, unsupported symbol, Redis loss, SSE reconnect, quota exhaustion, and rollback.
- [x] The final task verifies the full suite, typecheck, build, validator, browser story, live Preview/production state, diff hygiene, and resource cleanup.

Plan approved. Next: `mcax-execute`.
