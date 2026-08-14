# Prompt update: proven local worker stop

**Date:** 2026-08-14
**Triggered by:** T21 Stage A execution review
**Approval status before:** approved
**Approval status after:** needs re-approval → approved on 2026-08-14 under the standing instruction to proceed with all without needed input

## Change description

T21 review proved that the design named a T15 worker stop/absence proof but exposed no operator-callable authority that could request and observe it. `Stop-ScheduledTask` can terminate the launcher without invoking the private authenticated `/_gustavo/stop` exchange, so documentation alone cannot safely close admission, settle admitted wake work, prove the Codex container absent, and remove Funnel before maintenance or rollback. The local launcher now needs one owner/SYSTEM-only, process-lifetime operator control pipe that asks the already-running launcher to use its process-only HMAC nonce and existing unified stop authority; forced task termination remains forbidden.

## Sections of 02-design.md updated

- R3/R5/R7 and System design decision 9
  - **Was:** maintenance and rollback required the exact task to be stopped and referenced the T15 stop/absence proof, but the only documented command was `Stop-ScheduledTask` followed by raw Funnel commands.
  - **Now:** the normal launcher owns a fixed owner/SYSTEM-only local maintenance-control pipe. A trusted `start-hybrid-worker.ps1 -StopForMaintenance` client requests stop through that pipe, while the running launcher alone uses its process-only HMAC nonce, closes wake admission, settles already-admitted verification/enqueue work under the existing bounded stop authority, proves runtime/container absence, performs bounded Funnel teardown, exits normally, and returns only a safe proof. Timeout or any missing proof leaves maintenance/rollback blocked; no forced scheduled-task stop or ambient Funnel command is authority.
- Rollback plan
  - **Was:** stop the scheduled task and run trusted `tailscale funnel reset`, then assert the T15 proof in prose.
  - **Now:** pause schedules and invoke only the reviewed operator-stop mode; proceed only after its proof and exact root-task non-running state.

## Sections of 01-story.md updated

- None. User-visible acceptance criteria are unchanged; this supplies the missing executable authority for the already-approved shutdown behavior.

## Impact

### Plan tasks invalidated

- T20D: new prerequisite delta implementing the proven local operator-stop channel.
- T21: replace the nonexistent forced-task/Funnel shutdown command, and correct the independently found source-proof, bootstrap-environment, and inventory-probe command defects.
- T22: the shutdown fixture must exercise the same admitted-work stop/absence authority.
- T23: live maintenance/rollback must use the reviewed operator-stop proof before T20C rebuild or cleanup.

### Tests that must change

- `tests/infra/hybrid-worker.test.ts` — owner/SYSTEM pipe authority, startup/ready stop ordering, bounded proof, no nonce disclosure, timeout failure, and exact task-state verification.
- `tests/deployment/vercel-hybrid.test.ts` — require the reviewed stop command and ban `Stop-ScheduledTask`/raw Funnel cleanup; execute the source/probe command shapes rather than checking only prose tokens.
- `tests/e2e/gustavo-hybrid-production.spec.ts` — shutdown helper must use the production stop authority and prove admitted work/container settlement.

### Code files that must change

- `scripts/start-hybrid-worker.ps1` — add the operator client mode and normal-launcher owner/SYSTEM-only control-pipe server around the existing authenticated stop/Funnel cleanup path.
- `docs/VERCEL_DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/SMOKE_TEST.md` — document only the proven stop command and its fail-closed result.

### Verification status

- `05-verify.md`: not yet created; T23/full verification must use the regenerated authority.

## Re-approval

- Presented to user: 2026-08-14
- Confirmed approved: 2026-08-14 under the standing instruction to proceed with all without needed input

## Next skill

`mcax-plan` — insert T20D and regenerate the affected T21/T22/T23 shutdown steps before resuming `mcax-execute`.
