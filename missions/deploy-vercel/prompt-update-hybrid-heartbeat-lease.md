# Prompt update: hybrid heartbeat lease
**Date:** 2026-08-14
**Triggered by:** T18 Stage A/Stage B execution review
**Approval status before:** approved
**Approval status after:** needs re-approval → approved (2026-08-14)

## Change description

T18 review proved that the existing startup/clean-stop-only CODEX heartbeat cannot distinguish a live idle local host from an abrupt PC or process loss: the last `HEALTHY` row remains healthy forever. It also cannot represent actual daily job exhaustion because that authority lives in `deployment_quota_counters`, not the runtime heartbeat. The corrected design reuses existing signed wakes as the free-tier-safe liveness cadence: each accepted wake coalesces at most one database-clock CODEX heartbeat refresh, with no new timer, poller, or QStash delivery. Account and operator projections age the lease at 12 minutes and let the current UTC durable `CODEX_JOBS` limit override heartbeat state as quota-limited.

## Sections of 02-design.md updated

- ### R — Requirements / R5
  - **Was:** five-minute market wakes and direct opaque-job wakes dispatched local work, while heartbeat freshness was unspecified.
  - **Now:** every accepted signed wake coalesces a CODEX heartbeat refresh; a row older than 12 minutes is offline and durable current-day quota exhaustion is quota-limited.
- ### Decisions
  - **Was:** heartbeats were safe durable status rows written at startup/stop.
  - **Now:** one wake-refreshed database-clock lease supplies abrupt-loss authority without an additional background loop or QStash message.
- ### Data model / Modified files / Testing strategy / User-visible behavior
  - **Was:** heartbeat rows had fixed components and safe fields; chat rendered generic offline/queued state.
  - **Now:** `worker/hybrid/runtime.ts` coalesces refreshes through the existing heartbeat callback, infrastructure tests prove acknowledgment remains decoupled, and chat/health apply the same 12-minute lease plus current UTC quota precedence.

## Sections of 01-story.md updated

- None. Story 3 and Story 5 already require accurate offline/queued health; this update defines the missing durable liveness authority.

## Impact

### Plan tasks invalidated

- T15: partially stale; reopen only runtime heartbeat behavior and its focused infrastructure test while retaining all completed host/container/control authority.
- T18: invalidated bridge summary query; it must age CODEX by database time, consult the durable current UTC quota counter, and read market latest/poll/heartbeat under one coherent snapshot.
- T19: partially stale; its health projection must reuse the exact 12-minute lease and quota precedence.
- T21: partially stale; operations documentation must explain wake-refreshed lease/offline delay without implying an always-on poller.
- T22: partially stale; E2E restart/offline proof must cover abrupt heartbeat aging and quota-limited projection.
- T23: partially stale; final cutover must verify the refreshed lease, missed-wake offline transition, and no extra schedule/timer.

### Tests that must change

- `tests/infra/hybrid-worker.test.ts` — accepted wakes coalesce heartbeat refreshes, do not delay 202, do not create a timer loop, and stop safely.
- `tests/ui/account-surfaces.test.tsx` — database-clock stale heartbeat => offline, current UTC count 100 => quota-limited, and coherent market snapshot cannot label an older window fresh.
- `tests/deployment/vercel-hybrid.test.ts` — T19 uses the same frozen lease/quota policy.
- `tests/e2e/gustavo-hybrid-production.spec.ts` — later E2E proves abrupt-loss aging and quota state without sensitive output.

### Code files that must change

- `worker/hybrid/runtime.ts` — coalesce a best-effort CODEX heartbeat refresh for accepted wakes without blocking HTTP acknowledgment or adding a timer.
- `lib/server/dal/account-surfaces.ts` — apply DB-clock lease/quota precedence and one coherent market snapshot.
- `lib/server/bridge/health.ts` — later T19 shares the exact frozen lease/quota policy.
- `docs/OPERATIONS.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/SMOKE_TEST.md`, `docs/VERCEL_DEPLOYMENT.md` — later tasks document and verify the lease.

### Verification status

- `05-verify.md`: not created; T23 must verify the regenerated T15/T18/T19 gates.

## Re-approval

- Presented to user: 2026-08-14
- Confirmed approved: 2026-08-14 under the user's standing instruction to “Proceed with all without needed input”

## Next skill

`mcax-plan` — regenerate the T15 delta, T18, and downstream T19/T21/T22/T23 checks before resuming `mcax-execute`.
