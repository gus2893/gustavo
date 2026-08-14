# Design: deploy-vercel
**Approval status:** approved
**Last reviewed:** 2026-08-14

## R — Requirements

1. **R1 — Repair and publish the existing Vercel project** → Story 1 / AC1–AC5.
   - Reuse project `prj_HoIxQexO64tsgXrNI6m89g3P87TB` in team `team_2ZsWunVLuTIHx2h2zmWEAvAH`.
   - Build with Node 24 and pnpm 11.16.0 through Corepack; verify Preview before promoting to `gustavo.lol`.
   - Redirect `www.gustavo.lol` to the apex, retain the exact simulation label, and exclude operator data, live quotes, secrets, and ciphertext from all public output.
   - Every committed `vercel.json` function pattern must match a route that exists in the same commit; route-specific duration configuration lands atomically with that route.

2. **R2 — Create a fresh, invitation-only production account** → Story 2 / AC1–AC5.
   - Provision an empty Neon Free database; never copy local accounts, conversations, memories, quotes, or backups.
   - Apply each migration once under an advisory lock, seed configuration/authority only, and issue one opaque, expiring invitation URL.
   - Preserve current single-use invitations, strict sessions/origins/cookies, and auth-before-read.

3. **R3 — Run Node, Main, and Evaluator through the local Codex CLI** → Story 3 / AC1–AC6.
   - Atomically enqueue Node for each completed operator message, Main for each durable generation cycle, and Evaluator for each Main candidate before a broadcast may commit.
   - Run one Codex subprocess at a time in priority order: Node, Evaluator, Main.
   - Use standalone `codex exec` authenticated by ChatGPT sign-in. Never use an OpenAI API key, paid fallback, Ollama, or provider substitution.
   - Run that CLI only inside a pinned, ephemeral Docker container with a read-only image, a fresh tmpfs workspace, a dedicated Codex-auth volume, no repository or application-secret mounts, and container-level process/resource deadlines.
   - Preserve bounded Codex-reported input/output token counts when the pinned CLI emits them. When it does not, return explicit `UNKNOWN` provider metering while separately retaining gateway-observed token counts; incremental billable cost is the known constant zero, never an inferred provider charge.
   - Persist prompt/output only through existing encrypted event bodies; queue rows contain identifiers, digests, leases, bounded status, and safe error codes.

4. **R4 — Check the fixed 95-symbol personal-use universe every five minutes** → Story 4 / AC1–AC5.
   - Finnhub Free only; start at most one request every three seconds and at most 96 calls/window (market status plus 95 quotes).
   - Stocks: `AAPL, MSFT, NVDA, AMZN, GOOGL, GOOG, META, TSLA, BRK.B, AVGO, JPM, LLY, V, XOM, MA, UNH, COST, WMT, NFLX, ORCL, HD, PG, JNJ, BAC, ABBV, KO, CRM, CVX, MRK, AMD, PLTR, CSCO, ACN, MCD, IBM, GE, CAT, GS, MS, AXP, BX, TMO, ISRG, LIN, ABT, DIS, NOW, QCOM, TXN, AMGN, DHR, PEP, PM, INTU, BKNG, RTX, AMAT, SPGI, NEE, LOW, UPS, HON, PFE, C, MU, SBUX, COP, SCHW, GILD, ADP, DE, BLK, PANW, LRCX, KLAC`.
   - ETFs: `SPY, QQQ, DIA, IWM, VTI, VO, VB, VOO, IVV, XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, ARKK`.
   - Keep one encrypted latest row per symbol plus bounded poll summaries. Create an append-only `market_observations` row only when a decision consumes a quote.
   - Ordinary application/database writers cannot author latest-to-observation consumption bindings. A separate local-only Neon login inherits only the `gustavo_market_materializer` NOLOGIN role and is the sole database identity permitted to create those bindings; its credential never enters Vercel.
   - Render prices/status only after operator authentication; public routes never load them.

5. **R5 — Use free-tier-compatible background dispatch** → Story 5 / AC1–AC5 and Story 6 / AC1–AC4.
   - Vercel web functions do not run `worker/runtime.ts` persistent loops.
   - QStash calls one authenticated bounded Vercel maintenance route every 15 minutes for cache, privacy, stream, and schedule steps.
   - QStash calls the local Tailscale Funnel market wake every five minutes; direct chat sends an extra signed opaque-job wake.
   - Neon is the correctness boundary: lost wake/pubsub messages leave durable work pending for startup/reconnect recovery.
   - SSE closes within Vercel duration and reconnects through the existing ordered `Last-Event-ID` database cursor.

6. **R6 — Fail closed at a hard $0 ceiling** → Story 6 / AC1–AC4.
   - Use Vercel Hobby, Neon Free, Upstash Redis Free, QStash Free, Tailscale Free personal, Finnhub Free personal, and existing ChatGPT/Codex entitlement only.
   - Enforce: 900 QStash messages/day, 100 Codex jobs/day, one active Codex job, 96 Finnhub calls/window, exactly 95 results/window, bounded Redis TTL/key topology, and bounded latest-market/database rows.
   - Quota exhaustion delays/rejects only the affected feature with a safe reason; it never upgrades or enables overage.

7. **R7 — Make cutover and recovery operable** → all stories.
   - Provide migration/bootstrap, Vercel env, Windows startup, Funnel, quota, degraded-mode, rollback, backup, and smoke instructions.
   - Preserve a repeatable command trail without printing secrets.

## E — Existing context

### Stack and tooling

- Next.js 16 App Router, React 19, TypeScript 7, Node `>=24.7.0 <25`, pnpm 11.16.0: `package.json`.
- PostgreSQL via `pg` and `EventDatabase`: `lib/server/db/postgres.ts`, `lib/server/events/types.ts`.
- Redis/Valkey via `redis`: `lib/server/cache/runtime.ts`, `app/api/feed/stream/route.ts`, `worker/stream/publish-events.ts`.
- Vitest 4, Playwright 1.57, and static leakage gate: `tests/**`, `playwright.config.ts`, `scripts/validate.ps1`.

### Relevant code

- Web/UI: `app/page.tsx`, `app/(account)/chat/page.tsx`, `app/(challenge)/challenge/page.tsx`, `components/chat/Conversation.tsx`.
- Auth/DAL: `lib/server/auth/{invitations,sessions}.ts`, `lib/server/dal/account-surfaces.ts`, `scripts/issue-invitation.ts`.
- Model/Node: `lib/server/models/{types,gateway}.ts`, `lib/server/node-brains/router.ts`, `lib/server/history/messages.ts`, `db/migrations/0004_model_runs.sql`.
- Main: `lib/server/main-brain/{schedules,broadcasts}.ts`, `db/migrations/0021_broadcast_schedules.sql`.
- Market: `lib/server/market-data/{types,provider,policy}.ts`, `db/migrations/0008_market_data.sql`.
- Runtime/stream/health: `instrumentation.ts`, `worker/runtime.ts`, `app/api/feed/stream/route.ts`, `app/api/operator/health/route.ts`, `lib/server/observability/metrics.ts`.
- Infra/docs: `infra/compose.yaml`, `infra/env.example`, `docs/{OPERATIONS,PRODUCTION_CHECKLIST,SMOKE_TEST}.md`.

### Existing commands and reusable assets

- Commands: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm invitation:issue`, `pnpm cache:rebuild`, `pnpm cache:prewarm`, `pnpm worker:runtime`, `pnpm mvp:start`, and `scripts/validate.ps1`.
- `appendMessage` atomically commits encrypted message/event/metadata/outbox.
- `routeNodeReply` authorizes the exact account/conversation/node/message and commits routing before generation.
- `createModelGateway` enforces role limits and durable run accounting.
- `openDueBroadcastCycles`, `commitBroadcast`, one-shot cache/privacy/stream helpers, and `resumeEventIds` already provide idempotent authorities this design reuses.

### Broken/in-flight facts

- Latest Vercel deployment `dpl_DAWi9qjbVHsegA68NjdwBSh3Ktqj` fails before install because Vercel chooses pnpm 9. Official remediation is `ENABLE_EXPERIMENTAL_COREPACK=1` with the existing `packageManager` pin.
- Project settings still show Node 18.x; build logs select Node 24 only because `engines` overrides it.
- Vercel deploys old Task-25 branches. Local `master` at `a0c90dc15390e5accbb42869965e5347f7576b3f` is not on the remote.
- No production code invokes `createModelGateway`; chat only persists USER messages.
- No Finnhub adapter, fixed 95-symbol catalog, operator market page, or poller exists.
- Persistent 250ms worker polling would keep Neon awake and is unsuitable for the 100-CU-hour Free allowance.
- The packaged desktop executable is not callable from a normal background process; evidence is in `missions/deploy-vercel/debug-packaged-codex-execution.md`.

## A — Assumptions

- Personal, non-commercial, single-operator use remains eligible for every selected free tier.
- The operator controls Vercel/domains/GitHub/Windows and can interactively create/sign into Neon, Upstash, Tailscale, Finnhub, and Codex.
- Marketplace resources start empty and remain explicitly Free with no automatic plan escalation.
- Windows 11 can run Node 24, Docker Desktop Personal, Tailscale, and Task Scheduler; Docker Desktop starts before the hybrid worker.
- Initial model is `gpt-5.6-sol` for all roles; startup fails if unavailable—there is no fallback.
- Finnhub continues personal-use US data at 60 calls/minute; unsupported symbols remain visible as unavailable.
- R4's exact catalog is the launch universe. Expansion requires a prompt/design update.
- QStash Free remains 1,000 messages/day and 10 schedules; the app reserves 100 messages/day headroom.
- Local-computer outage is expected degraded operation, not a hosted outage.
- Neon Free supports separate login roles and pooled connection strings per role. The operator creates one local-only materializer login, grants it only the migration-created `gustavo_market_materializer` role, and keeps its independently generated credential outside Vercel and the repository.

## S — System design

### Data flow

```text
Browser -> Vercel Next.js -> Neon (events + durable jobs)
                        \-> QStash signed opaque wake
QStash -> Tailscale Funnel -> local hybrid worker -> ephemeral Codex container / Finnhub
local worker -> Neon encrypted result/heartbeat -> DB replay/Upstash -> browser
QStash -> Vercel internal maintenance -> bounded cache/privacy/stream/schedule work
```

Neon is authoritative. QStash, Funnel, Redis pub/sub, and SSE accelerate delivery only; duplication or loss cannot duplicate or lose durable work.

### Decisions

1. **Outbound-first durable bridge.** Vercel commits a job and sends only its opaque ID. Direct prompt tunneling was rejected because it leaks protected content to another transport and loses work offline.
2. **QStash one-shot maintenance.** Bounded signed calls replace always-on cloud/home DB polling, preserving Neon auto-suspend. Vercel Hobby Cron is too infrequent.
3. **Signed wake, not signed execution.** Funnel verifies QStash signature, canonical URL/body, age, and unique message ID, records the receipt, then merely wakes a DB scan. Claims independently re-authorize source events.
4. **Bounded latest-market projection with separate materialization authority.** Ninety-five encrypted mutable latest rows avoid roughly 7,500 permanent quote events/trading day. Existing append-only observations remain authoritative when actually consumed. The schema owner creates a NOLOGIN `gustavo_market_materializer` permission role, but the ordinary application role is not a member. Only a separately authenticated local login with that membership may create a body-free consumption binding; triggers reject bindings from every other `current_user`. The binding copies database-owned latest identity/version authority, and application replay still reauthorizes, decrypts, and compares the exact latest version. This role boundary is required because PostgreSQL cannot validate Node-side AES-GCM plaintext and one shared database identity cannot distinguish legitimate materialization from forged direct SQL.
5. **Container-isolated unsupported Codex runner.** The Windows worker never spawns Codex directly. It invokes Docker with a fixed argument vector against a locally built, digest-recorded image whose Node and Codex CLI versions are pinned. Before any run or reconciliation Docker operation, the worker exclusively binds the fixed local named pipe `\\.\pipe\gustavo-codex-runner-v1` and holds that crash-releasing OS authority through actual lifecycle-promise settlement; another process fails safely without inspecting or mutating Docker state. Every job then claims the one fixed Docker name `gustavo-codex-singleton-v1`; Docker's daemon-owned name uniqueness is the durable residue and restart serializer. After `docker create` returns, every lifecycle operation uses the immutable returned container ID and verifies the fixed name, exact labels, and image before acting. There is no wall-clock or sampled-absence path that clears an ambiguous create: an interrupted or unsettled create leaves claims fail-closed until a new process first owns the named-pipe lease and exact-name reconciliation finds and removes the container, or an operator explicitly verifies the daemon helper is settled and performs the documented recovery. Each read-only container uses `--init`, `--cap-drop ALL`, `no-new-privileges`, fixed PID/memory/CPU limits, a fresh bounded tmpfs mounted at `/workspace`, fixed read-only role schemas baked into `/schemas`, and only the dedicated Codex-auth volume mounted at `/codex-home`. The repository, Windows workspace, database/Valkey/QStash/Finnhub/Tailscale secrets, Docker socket, and arbitrary host paths are never mounted or passed. All model-visible tools, including `tools.view_image`, shell, web search, apps, hooks, and multi-agent tools, are explicitly disabled. The container runs an internal wall-time supervisor and the exact noninteractive `codex exec --ephemeral --ignore-user-config --skip-git-repo-check --sandbox read-only --ask-for-approval never --json --output-schema /schemas/<role>.schema.json -C /workspace -` command with prompt bytes on stdin. One synchronous in-process owner token composes with the named-pipe lease for both run and reconcile paths; timed-out lifecycle promises retain both authorities until actual settlement. Host abort performs bounded `docker kill` plus `docker wait`; startup reconciles only while holding the named-pipe lease and only the fixed name/exact authority labels. Failure to prove container termination disables further Codex claims and reports a safe unavailable state. This limits host impact and gives the container runtime—not ad-hoc Windows process enumeration—process-tree authority; it does not turn Codex CLI into a supported application API.
6. **Two-phase release.** Preview, resources, migration, bootstrap, local bridge/market, health, leakage scan, and rollback rehearsal must pass before production promotion.

### Data model

`db/migrations/0022_hybrid_deployment.sql` adds:

- `bridge_model_jobs`: source event, role/kind/priority, immutable digest, bounded lease/attempt/status, output event, safe terminal code; never prompt/output text.
- Authority triggers: one Node job per completed USER message, one Main job per generation cycle, semantic immutability with lease/status transitions only.
- `bridge_wake_receipts`: unique QStash message IDs/times, pruned on a bound.
- `hybrid_worker_heartbeats`: fixed components `CODEX`, `MARKET`, `TUNNEL`; no hostname/URL/secret.
- `market_poll_windows`: five-minute counts/provider status/safe code, retained seven days.
- `market_latest_quotes`: exactly one encrypted monotonic latest row per catalog symbol.
- `market_observation_consumptions`: body-free exact decision/latest/observation binding, writable only while authenticated through the `gustavo_market_materializer` permission role; direct ordinary-writer binding and matching-row forgery are rejected.
- `deployment_quota_counters`: fixed daily QStash/Codex/Finnhub counters.

### Role execution

- **Node:** USER trigger → claim → authorized message/recall load → `routeNodeReply` → Codex-backed `createModelGateway` → routed `appendMessage`.
- **Main:** generation-cycle trigger → Codex → encrypted candidate event → Evaluator job.
- **Evaluator:** strict JSON review → accepted review commits existing broadcast with cycle/candidate/review provenance; rejected/malformed review publishes nothing and records a safe terminal event.
- One advisory lock plus process mutex. Ordering is `NODE=0`, `EVALUATOR=10`, `MAIN=20`, then creation time. Expired leases retry with the same digest/idempotency authority.

### Market execution

- QStash wakes the local endpoint every five minutes. The worker verifies signature/replay/quota, calls market status, and skips quotes when closed.
- When open, it schedules one quote start every three seconds with a sub-three-second timeout. Every catalog entry becomes `SUCCESS`, `UNAVAILABLE`, `RATE_LIMITED`, or `PROVIDER_ERROR`; finalization fills any missing result.
- One short Neon transaction encrypts/upserts all latest rows, writes summary/heartbeat, then closes. No DB connection remains open while polling.
- Latest polling and reads use the ordinary bounded `DATABASE_URL`. Explicit decision consumption uses a separate bounded `GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL`, verifies `current_user` membership inside the transaction, creates the exact binding/observation, and closes immediately. Failure or absence of that local-only credential leaves the quote unmaterialized with a safe unavailable state; it never falls back to the ordinary role.
- `/market` authenticates before reading/decrypting and renders source time, receipt time, age, freshness, and explicit unavailable state for all 95.

### Cloud maintenance and SSE

- `POST /api/internal/maintenance` accepts a valid QStash signature for the exact production URL/body only.
- An advisory lock prevents overlap; a deadline below 55 seconds bounds cache invalidation, forget propagation, stream publication, due cycles, and stale bridge leases.
- SSE has a 55-second maximum, bounded heartbeats/cleanup, and reconnects through existing ordered database replay.
- The initial deployment manifest may configure the existing SSE route. The maintenance duration entry is added only in the same task/commit that creates `app/api/internal/maintenance/route.ts`, preventing Vercel's unmatched-function-pattern deployment error.

### New files

- `vercel.json`: bounded Vercel runtime configuration.
- `db/migrations/0022_hybrid_deployment.sql`: bridge/market/quota authority.
- `config/market-universe.ts`: frozen catalog.
- `lib/server/bridge/{jobs,qstash,health}.ts`: durable queue, signed delivery, safe health.
- `lib/server/models/codex-cli.ts`: local-only provider adapter.
- `lib/server/market-data/{finnhub,latest,session}.ts`: mapping, encrypted projection, window policy.
- `worker/hybrid/{runtime,wake-server,codex-runner,market-poller}.ts`: serialized, idle-disconnected local runtime and fixed Docker invocation boundary.
- `worker/hybrid/codex-container/{Dockerfile,node.schema.json,main.schema.json,evaluator.schema.json}`: pinned read-only Codex image and exact role schemas.
- `app/api/internal/maintenance/route.ts`: signed maintenance.
- `app/(account)/market/page.tsx`, `components/market/MarketStatus.tsx`: account-only dashboard.
- `scripts/{migrate-production,bootstrap-production}.ts`: schema/bootstrap.
- `scripts/{setup-hybrid-worker,start-hybrid-worker}.ps1`: dedicated-user prerequisites, pinned Codex image build/auth-volume setup, Docker readiness, startup task, Funnel.
- `infra/vercel.env.example`, `docs/VERCEL_DEPLOYMENT.md`: env contract and runbook.

### Modified files

- `package.json`, `pnpm-lock.yaml`: add `@vercel/functions`, `@upstash/qstash`, and bounded deployment/container commands.
- `lib/server/db/postgres.ts`: bounded Vercel pool/Fluid Compute attachment and bounded local pool.
- `lib/server/history/messages.ts`: return exact job/source binding without weakening authority.
- `app/api/conversations/[conversationId]/messages/route.ts`: best-effort opaque wake after durable commit.
- `lib/server/dal/account-surfaces.ts`, `app/(account)/chat/page.tsx`, `components/chat/Conversation.tsx`: pending/failed/offline state and market link.
- `lib/server/observability/metrics.ts`, `app/api/operator/health/route.ts`: safe hybrid/quota health.
- `app/api/feed/stream/route.ts`: Vercel duration/reconnect hardening.
- `scripts/issue-invitation.ts`: canonical redemption URL mode.
- `infra/env.example`, `docs/{OPERATIONS,PRODUCTION_CHECKLIST,SMOKE_TEST}.md`: deployment mode/runbook links.
- `scripts/{setup-hybrid-worker,start-hybrid-worker}.ps1`, `infra/env.example`, and hybrid production tests: provision/validate the local-only materializer URL without printing or forwarding it to Vercel or the Codex container.

### Off-limits files

- `AGENTS.md`: unrelated user-owned changes; byte-for-byte untouched.
- `db/migrations/0001_events.sql` through `0021_broadcast_schedules.sql`: append-only history; use 0022.
- `infra/compose.yaml`, root `Dockerfile`, root `.dockerignore`, `worker/runtime.ts`: preserve verified local MVP; the new nested Codex image is hybrid-only.
- `infra/backup/*.ps1`: verified backup authority is not redesigned.
- `app/api/public/feed/route.ts`, `components/feed/PublicFeed.tsx`: public DTO never gains live quotes/bridge state.
- `scripts/validate.ps1`: no weakening/allowlisting; new files must pass it.
- Everything not listed as new/modified is implicitly off-limits unless `mcax-prompt-update` reopens the contract.

### External dependencies

- Vercel Hobby: existing project/domains, Node 24, `ENABLE_EXPERIMENTAL_COREPACK=1`.
- Neon Free: fresh pooled ordinary `DATABASE_URL` plus a separately credentialed pooled `GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL` for the local worker only; the materializer login receives only the migration-created NOLOGIN permission role, and no data is imported.
- Upstash Redis Free: TLS URL mapped to `VALKEY_URL`.
- QStash Free: two schedules plus direct wakes, verified with current/next signing keys, app cap 900/day.
- Tailscale Funnel: background HTTPS proxy to a loopback-only wake server.
- Finnhub Free: local-only personal-use key.
- Docker Desktop Personal: local container/process isolation; no remote registry or paid service is required.
- Standalone Codex CLI: pinned inside the local image, authenticated through a dedicated volume, explicitly unsupported as app backend.

### Errors and edges

- Duplicate QStash delivery uses a unique receipt; duplicate claims replay the same job/cycle/message.
- Wake-before-visibility triggers a scan; startup/reconnect recovery finds durable jobs.
- Offline/auth/quota/malformed output/timeouts/429/unsupported symbol/Neon pause/Redis loss become bounded safe states without deleting history.
- The in-container supervisor bounds Codex independently; host abort kills and waits for the exact labeled container. Unproven termination disables further claims, and partial output never commits.
- Redis loss recovers from PostgreSQL; SSE reconnects through DB replay.
- Secrets enter only environment/secret stores, never argv URLs, logs, browser artifacts, or repository files.
- Missing, misgranted, or ordinary-role materializer credentials fail before binding or plaintext observation creation. No code path retries through `DATABASE_URL`, and tests prove an ordinary direct writer cannot forge a matching binding plus observation.

## O — Outputs

### Expected file changes

- `missions/deploy-vercel/01-story.md` → record approval.
- `missions/deploy-vercel/02-design.md` → approved REASONS contract.
- `package.json`, `pnpm-lock.yaml`, `vercel.json` → pinned build/runtime/dependencies/commands.
- `db/migrations/0022_hybrid_deployment.sql` → durable bridge/market/quota schema.
- `config/market-universe.ts` → exact 95 catalog.
- `lib/server/db/postgres.ts` → bounded serverless pooling.
- `lib/server/bridge/{jobs,qstash,health}.ts` → queue/signature/health.
- `lib/server/models/codex-cli.ts` → strict Codex adapter.
- `lib/server/market-data/{finnhub,latest,session}.ts` → poll/provider/projection.
- `lib/server/history/messages.ts` → source-job binding.
- `lib/server/dal/account-surfaces.ts` → bridge status projection.
- `lib/server/observability/metrics.ts` → safe hybrid/quota health.
- `worker/hybrid/{runtime,wake-server,codex-runner,market-poller}.ts` → local hybrid runtime and Docker controller.
- `worker/hybrid/codex-container/{Dockerfile,node.schema.json,main.schema.json,evaluator.schema.json}` → pinned isolated Codex execution image.
- `app/api/internal/maintenance/route.ts` → signed bounded maintenance.
- `app/api/conversations/[conversationId]/messages/route.ts` → opaque wake.
- `app/api/operator/health/route.ts`, `app/api/feed/stream/route.ts` → health and bounded SSE.
- `app/(account)/chat/page.tsx`, `components/chat/Conversation.tsx` → queued/offline feedback.
- `app/(account)/market/page.tsx`, `components/market/MarketStatus.tsx` → market dashboard.
- `scripts/{migrate-production,bootstrap-production}.ts`, `scripts/issue-invitation.ts` → migration/bootstrap/redemption URL.
- `scripts/{setup-hybrid-worker,start-hybrid-worker}.ps1` → safe Windows startup.
- `infra/vercel.env.example`, `infra/env.example` → secret names/deployment profiles.
- `docs/VERCEL_DEPLOYMENT.md`, `docs/{OPERATIONS,PRODUCTION_CHECKLIST,SMOKE_TEST}.md` → deployment operations.

### Expected tests

- `tests/deployment/vercel-hybrid.test.ts`: Corepack/Node/env/free-quota/static-public boundaries.
- `tests/bridge/jobs.test.ts`: trigger authority, role ordering, leases, idempotency, offline replay, no bodies.
- `tests/bridge/codex-cli.test.ts`: safe args/stdin/schema/bounds/malformed output/no repo/tool integrations.
- `tests/bridge/qstash.test.ts`: signatures, exact URL/body, expiry/replay/receipt-before-wake/quota.
- `tests/market-data/finnhub-poller.test.ts`: exact 95, pacing/caps, 429/unavailable, closed session, encryption/public exclusion.
- `tests/infra/hybrid-worker.test.ts`: startup, one active job, priority, recovery, heartbeat, loopback binding, safe logs.
- `tests/ui/account-surfaces.test.tsx`: bridge state and auth-first 95 dashboard.
- `tests/stream/sse-authorization.test.ts`: bounded reconnect and ordered replay.
- `tests/privacy/forget-propagation.test.ts`, `tests/cache/postgres.test.ts`: one-shot maintenance preserves fences.
- `tests/e2e/gustavo-hybrid-production.spec.ts`: fresh invite, fake-Codex roles, fake-Finnhub 95, offline/recovery, public redaction, no copied data.

### User-visible behavior

- Canonical safe public site at `https://gustavo.lol`; `www` redirects.
- First operator redeems one URL and receives an empty private conversation.
- Chat shows committed/queued; later Node reply appears. Offline leaves the message and shows local processing unavailable.
- `/market` lists all 95 with price when successful, timestamps/freshness, and unavailable codes.
- Operator health separates hosted from local health without hostnames, URLs, prompts, prices, or secrets.

## N — Non-goals

- No local/private import; public registration; multi-operator bridge; public live quotes; brokerage; real trades.
- No OpenAI API, API billing, ChatGPT web/desktop automation, Ollama, or paid model fallback.
- No universe beyond the fixed 95 and no redistribution license.
- No historical-migration, local-Compose, backup-authority, or public-DTO redesign.
- No uptime/SLA claim for free tiers, home hardware, Funnel, Finnhub, QStash, or Codex CLI.

## S — Success criteria

- **SC1/R1:** Ready Node-24/pnpm-11 production, valid TLS/canonical redirect, public leakage checks pass.
- **SC2/R2:** Empty schema has bootstrap/config only; invitation succeeds once and rejects replay.
- **SC3/R3:** Real operator message creates one job/wake/isolated Codex run/routed Node reply; Main/Evaluator fixtures prove priority/authority.
- **SC4/R4:** Exactly 95 results complete within 300 seconds using at most 96 calls and render operator-only.
- **SC5/R5:** PC-offline preserves public/history and pending jobs; restart drains once; maintenance completes below 55 seconds.
- **SC6/R6:** Tests reject job 101, QStash 901, Finnhub call 97, second Codex process, and paid fallback.
- **SC7/R7:** `pnpm test`, typecheck, build, validator, focused Playwright, Preview smoke, production smoke, and rollback rehearsal pass without secret leakage.

## Rollback plan

1. Set `GUSTAVO_HYBRID_BRIDGE_ENABLED=false` and `GUSTAVO_MARKET_POLLER_ENABLED=false` first.
2. Pause/delete only the two mission-created QStash schedules, stop the exact `Gustavo Hybrid Worker` task, and run `tailscale funnel reset`.
3. Promote the last verified pre-mission Vercel deployment; if none is Ready, redeploy exact commit `a0c90dc15390e5accbb42869965e5347f7576b3f` as the safe hosted shell.
4. Revert mission implementation commits in reverse order and delete only additive files listed here. Do not edit historical migrations.
5. Migration 0022 is forward-only/additive. Leave its tables in place; resource deletion is a separate explicit decommission after backup/verification.

## Open questions

- **Blocking for cutover, not implementation:** operator must create/sign into resources and provide QStash keys, Finnhub key, Funnel hostname, and Codex ChatGPT sign-in.
- **Blocking for cutover, not implementation:** `gpt-5.6-sol` must be available in standalone Codex; no fallback.
- **Non-blocking:** choose matching US East Vercel/Neon regions during provisioning and record the exact pair.

## Change log

- 2026-08-13 initial draft grounded in repository code, Vercel project/build logs, official Vercel/OpenAI docs, and provider free-tier docs.
- 2026-08-13 approved by the user.
- 2026-08-13 prompt-update: require every committed Vercel function pattern to match an existing route after T1 Stage B found that unmatched patterns fail deployment.
  - Previous intent: `vercel.json`: bounded Vercel runtime configuration, with both the SSE and future maintenance route entries created in T1.
  - Revised intent: T1 configures only the already-existing SSE route; the maintenance entry is committed atomically with the new maintenance route in T16. Final production behavior and the 60-second bounds are unchanged.
- 2026-08-13 prompt-update approved by the user; execution may resume after T1/T16 plan regeneration.
- 2026-08-13 prompt-update: replace direct Windows Codex spawning with an ephemeral Docker isolation boundary after `debug-t7-process-isolation.md` exhausted three evidence-led fixes without proving process-tree termination or private cleanup.
  - Previous intent: “A dedicated Windows account owns an empty randomized workspace and dedicated `CODEX_HOME` ... runs `codex exec ... -C <empty-workspace> -` ... and kills the process tree on bounds.”
  - Revised intent: the worker invokes a pinned, resource-bounded, read-only container with a fresh tmpfs workspace, baked role schemas, and a dedicated auth volume; container-level timeout plus exact `docker kill`/`wait` owns process-tree termination, and unproven termination disables further claims.
  - Previous intent retained: prompt is stdin-only; exact noninteractive Codex flags, one active job, no API key/paid fallback, no repository/application-secret access, bounded output, and unsupported-backend disclosure remain unchanged.
- 2026-08-13 containerized-Codex prompt update approved by the user; affected-plan regeneration and execution may resume.
- 2026-08-13 prompt-update: replace randomized, process-local container lockout with Docker-owned singleton-name authority after `debug-t7-container-authority.md` proved that wall-time plus sampled absence cannot bound a delayed daemon create across worker restarts.
  - Previous intent: “Each job gets a uniquely named, labeled ... container” and an ambiguous create could be released after a process-local time window plus repeated absence inspections.
  - Revised intent: every job claims fixed name `gustavo-codex-singleton-v1`; daemon name uniqueness serializes across processes/restarts, lifecycle commands bind the returned immutable container ID, ambiguous create never auto-unlocks, run/reconcile share one synchronous owner, and timed-out execution remains active until settlement.
  - Previous isolation intent retained: pinned digest, bounded resources, tmpfs workspace, no application mounts/secrets, prompt on stdin, exact labels, kill/wait/absence proof, no API/paid fallback, and tool-free Codex execution.
- 2026-08-13 Docker-singleton prompt update approved under the user's standing instruction to “Proceed with all without needed input”; only T7 and its direct downstream runtime/operations assertions require regeneration.
- 2026-08-13 prompt-update: add a crash-releasing fixed named-pipe lease around run and reconciliation after review proved Docker name uniqueness alone does not stop a second live worker from reconciling the incumbent's running singleton.
  - Previous intent: the fixed Docker name serialized creates and process-local owner tokens serialized calls within one module instance.
  - Revised intent: exclusive `\\.\pipe\gustavo-codex-runner-v1` ownership is required before any run/reconcile Docker action and is held through actual settlement; the fixed Docker name remains durable residue authority after a crash.
  - Test-fixture cleanup is additionally exact-ID-only and may never remove a singleton it did not successfully create and validate.
- 2026-08-13 named-pipe authority update approved under the user's standing instruction to proceed autonomously; T7 plan delta regenerated before implementation.
- 2026-08-13 prompt-update: add explicit provider-metering provenance after T8 proved the existing concrete-only `ModelProviderUsage` type could not represent missing Codex usage without inventing billable estimates.
  - Previous intent: T8 would “return bounded usage metadata only when Codex reports it; otherwise return explicit unknown usage,” but the gateway required concrete token/cost values and T7 discarded validated CLI usage.
  - Revised intent: gateway-observed bounded input/output counts remain concrete for limit enforcement and the deployment's incremental cost remains known zero; a separate frozen metering discriminator is `REPORTED` with bounded CLI counts or `UNKNOWN`. T7 preserves optional reported counts. Legacy providers may omit the discriminator and retain existing behavior.
  - Fixed adapter deadlines are Node 90 seconds, Evaluator 180 seconds, and Main 300 seconds, all within T7's container ceiling; output-token limits remain request-scoped and are enforced before any delta/completion is exposed.
- 2026-08-13 Codex-metering contract update approved under the user's standing instruction to proceed autonomously; T8 and the minimum gateway/runner contract tests were regenerated before production edits.
- 2026-08-14 prompt-update: add a separate local-only PostgreSQL materializer role after `debug-t13-latest-authority.md` proved that one shared database identity cannot distinguish legitimate Node-decrypted materialization from a direct writer forging both the binding digest and observation.
  - Previous intent: T13 would reauthorize/decrypt the exact latest row in Node and insert a body-free binding plus observation through the same `DATABASE_URL` identity used by ordinary application SQL; triggers would validate a caller-supplied semantic digest.
  - Revised intent: the schema creates a NOLOGIN `gustavo_market_materializer` permission role; a separately authenticated local-only login is its sole member and sole binding writer. Ordinary application/Vercel identities cannot author bindings, while Node still decrypts and compares the exact latest version before materialization and replay.
  - Preserved intent: exactly 95 encrypted latest rows, no plaintext latest projection, observations only on explicit decision consumption, exact idempotent provenance, free Neon operation, privacy erasure, and no public quote redistribution remain unchanged.
- 2026-08-14 market-materializer role update approved under the user's standing instruction to “Proceed with all without needed input”; T13, T15, T21, T22, and T23 require regeneration before their affected execution resumes.

## Self-review checklist

- [x] Every requirement maps to ≥1 acceptance criterion in `01-story.md`.
- [x] Every expected file to change has a one-line change summary.
- [x] Off-limits files are listed with reasons.
- [x] No unresolved placeholders.
- [x] No contradictions between sections.
- [x] Rollback plan names specific commits/files/flags.
- [x] Open questions are tagged `blocking` or `non-blocking`.
