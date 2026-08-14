# Prompt update: bounded late market recovery
**Date:** 2026-08-14
**Triggered by:** debug escalation (`debug-t14-late-window-recovery.md`)
**Approval status before:** approved
**Approval status after:** needs re-approval → approved (2026-08-14 under the user's standing instruction to “Proceed with all without needed input”)

## Change description

T14 proved that the approved startup/reconnect behavior could not be represented by the current database authority: every terminal transition receives `clock_timestamp()`, but every `completed_at` was required to remain inside the original five-minute window. A retained incomplete row therefore could not become a durable failed summary after the window elapsed. The corrected contract keeps successful completion inside five minutes and permits only a bounded database-timed `PENDING`→`FAILED` recovery before the row's seven-day `prune_after`; recovery performs no provider work, latest mutation, quota re-reservation, or second poll.

## Sections of 02-design.md updated

- ### R4 — Check the fixed 95-symbol personal-use universe every five minutes
  - **Was:** incomplete durable work was recoverable, but no terminal-time rule distinguished successful completion from late failure recovery.
  - **Now:** `COMPLETED` remains inside the original interval; retained incomplete windows may become `FAILED` once before `prune_after`, and expired rows are cleanup-only.
- ### Market execution
  - **Was:** reserve, disconnect, poll, and store one complete current window; startup/reconnect recovery was stated only generally.
  - **Now:** reserve/inspect the exact window first; terminalize a retained prior window without polling or latest mutation; only a newly reserved current window may call Finnhub.
- ### Errors and edges
  - **Was:** startup/reconnect recovery found durable work.
  - **Now:** recovery has explicit time, quota, immutability, and no-repoll authority.
- ### Change log
  - Preserves the prior five-minute successful-poll bound and records why late failed finalization is now separately bounded by retention.

## Sections of 01-story.md updated

- Story 5 now explicitly requires reconnect recovery to avoid re-polling an expired market window, materialize no latest data from it, and skip already pruned work.

## Impact

### Plan tasks invalidated

- T14: expand scope to migration 0022 and assert late retained recovery plus post-retention cleanup behavior.
- T15: startup controller recovery must invoke the bounded no-repoll path.
- T18: market status must render a recovered failed summary as unavailable rather than fresh.
- T21: bootstrap/runbook must document recovery and pruning behavior.
- T22: end-to-end offline/reconnect coverage must prove no prior-window provider replay.
- T23: final acceptance must rehearse retained-window recovery and post-retention cleanup.

### Tests that must change

- `tests/market-data/finnhub-poller.test.ts` — add deterministic retained prior-window and at/after-prune boundary cases; preserve the no-database-during-provider proof.
- `tests/infra/hybrid-worker.test.ts` — startup recovery must distinguish retained from pruned market windows.
- `tests/e2e/gustavo-hybrid-production.spec.ts` — reconnect must not re-poll an expired window or mutate latest state.

### Code files that must change

- `db/migrations/0022_hybrid_deployment.sql` — keep the five-minute bound for `COMPLETED`, allow database-owned late `FAILED` only before `prune_after`, and preserve terminal immutability.
- `worker/hybrid/market-poller.ts` — terminalize retained incomplete windows without provider work and skip cleanup-only expired rows.
- `lib/server/market-data/session.ts` — expose the exact bounded reserve/store/recovery semantics.
- `worker/hybrid/runtime.ts` / controller wiring in T15 — invoke recovery before a current poll.
- Operator market UI/runbook/E2E files in T18/T21/T22/T23 — disclose and verify recovered failure state.

### Verification status

- `05-verify.md`: not created; final verification must include both recovery boundaries.

## Re-approval

- Presented to user: 2026-08-14 through the autonomous execution update.
- Confirmed approved: 2026-08-14 under the explicit standing instruction to proceed with all work without further input.

## Next skill

`mcax-plan` — regenerate T14 and the affected downstream recovery assertions before resuming `mcax-execute`.
