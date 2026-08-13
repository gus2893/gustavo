# Prompt update: containerized Codex isolation
**Date:** 2026-08-13
**Triggered by:** debug escalation (`debug-t7-process-isolation.md`)
**Approval status before:** approved
**Approval status after:** approved (2026-08-13)

## Change description

T7 proved that a Node process plus `taskkill`/PowerShell fallbacks cannot guarantee both full Windows descendant termination and race-free private workspace cleanup. After three evidence-led fix attempts, the direct-spawn assumption is replaced with an ephemeral Docker container boundary. The user-visible unsupported Codex bridge, zero-dollar constraint, exact noninteractive command, one-active-job rule, stdin-only prompt, and no-repository/no-application-secret requirements remain unchanged.

## Sections of 02-design.md updated

- **R3 — local Codex CLI**
  - **Was:** standalone Codex ran directly under the local Windows worker.
  - **Now:** standalone Codex runs only inside a pinned, ephemeral, resource-bounded container with a fresh tmpfs workspace and dedicated auth volume.
- **E — assumptions**
  - **Was:** Windows required Node, standalone Codex, Tailscale, and Task Scheduler.
  - **Now:** Windows requires Node, Docker Desktop Personal, Tailscale, and Task Scheduler; Docker readiness gates the hybrid worker.
- **S — Decision 5**
  - **Was:** the Node worker created an empty host workspace, generated a schema there, spawned Codex directly, and attempted to kill the Windows process tree.
  - **Now:** a pinned local image bakes read-only schemas, creates a fresh tmpfs workspace per job, runs an internal wall-time supervisor, and gives the container runtime process-tree authority. Host abort uses exact labeled-container kill/wait, and unproven termination disables further claims.
- **S/O — files, dependencies, and errors**
  - Adds the nested Codex container image/schema files and updates setup/runtime/docs responsibilities.
  - Keeps the root application Dockerfile/Compose authority off-limits.

## Sections of 01-story.md updated

- None. Acceptance behavior is unchanged: local Codex responses remain isolated, serialized, free of API billing, and unavailable rather than unsafe when the local boundary is down.

## Impact

### Plan tasks invalidated

- **T7:** fully stale; direct process spawning, host workspaces, Taskkill tests, and exact host-path argv must be replaced by fixed Docker run/kill/wait authority and image/schema tests.
- **T8:** partially stale; retain the provider contract but revalidate its runner injection and termination-failure mapping against the container controller.
- **T15:** partially stale; runtime must gate claims on Docker/image health and reconcile only exact labeled containers.
- **T19:** partially stale; health must expose bounded container/runtime unavailable codes without container names, paths, or daemon details.
- **T21:** partially stale; setup/start scripts and operations docs must build the pinned image, initialize the dedicated auth volume, verify Docker readiness, and avoid a host Codex workspace.
- **T22:** partially stale; the E2E fake executable becomes an injected fake container transport or locally built fixture image, and cleanup must prove no labeled containers remain.
- **T23:** partially stale; cutover verification now includes Docker Desktop, image digest, auth-volume sign-in, and container termination rehearsal.

### Tests that must change

- `tests/bridge/codex-cli.test.ts` — replace host spawn/taskkill/workspace assertions with exact Docker args, image digest, tmpfs/read-only/resource limits, stdin, output bounds, internal timeout, host kill/wait, reconciliation, and no-mount/no-env leakage assertions.
- `tests/infra/hybrid-worker.test.ts` — cover Docker readiness, one active labeled container, startup reconciliation, and fail-closed unproven termination.
- `tests/e2e/gustavo-hybrid-production.spec.ts` — use a controlled fixture image/transport and assert teardown leaves no exact labeled container.
- `tests/deployment/vercel-hybrid.test.ts` — revalidate zero-dollar/local-only Docker documentation and ensure no container secret enters Vercel configuration.

### Code files that must change

- `worker/hybrid/codex-runner.ts` — replace direct child-process/workspace logic with a fixed Docker controller and bounded output parser.
- `worker/hybrid/codex-container/Dockerfile` — new pinned, read-only local Codex image with internal timeout entrypoint.
- `worker/hybrid/codex-container/{node.schema.json,main.schema.json,evaluator.schema.json}` — new exact baked role schemas.
- `worker/hybrid/runtime.ts` — gate claims on container authority and stop after unproven termination.
- `lib/server/models/codex-cli.ts` — preserve provider semantics while mapping container safe failures.
- `lib/server/bridge/health.ts` and `lib/server/observability/metrics.ts` — project safe Docker/Codex availability only.
- `scripts/{setup-hybrid-worker,start-hybrid-worker}.ps1` — build/record the image, create/sign into the dedicated auth volume, and verify Docker before startup.
- `docs/{VERCEL_DEPLOYMENT,OPERATIONS,PRODUCTION_CHECKLIST,SMOKE_TEST}.md` — document local image/auth/kill rehearsal and unsupported-backend limitations.

### Verification status

- No `05-verify.md` exists yet.
- T1–T6 remain valid and committed.
- T7 is uncommitted and stale; execution is paused until re-approval and T7/T8/T15/T19/T21/T22/T23 plan regeneration.

## Re-approval

- Presented to user: 2026-08-13
- Confirmed approved: 2026-08-13 — user instructed “Proceed with all without needed input.”

## Next skill

`mcax-plan` for the invalidated tasks, then resume `mcax-execute` at T7.
