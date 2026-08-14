# Prompt update: cross-process Codex host lease
**Date:** 2026-08-13
**Triggered by:** T7 Stage B execution finding
**Approval status before:** approved
**Approval status after:** needs re-approval → approved on 2026-08-13 under the user's standing instruction to proceed autonomously

## Change description
Docker's fixed container name serializes `create`, but a second worker could still reconcile and kill the incumbent worker's legitimate running container. Both run and reconciliation now require exclusive ownership of a fixed local Windows named pipe. The OS releases it when the owner process crashes; the next process may then reconcile the fixed Docker residue by immutable ID.

## Impact
### Plan tasks invalidated
- T7: add cross-process lease acquisition/release and hostile concurrent-reconcile coverage.
- T19/T21/T23: runtime readiness and operations assertions must mention the named-pipe prerequisite; behavior otherwise remains unchanged.

### Tests that must change
- `tests/bridge/codex-cli.test.ts` — two-process/injected-lease contention, crash-release/reconcile, unsettled-promise lease retention, and exact-ID-only Docker fixture cleanup.

### Code files that must change
- `worker/hybrid/codex-runner.ts` — fixed named-pipe lease boundary around all run/reconcile Docker actions.

### Verification status
- Full verification remains pending.

## Re-approval
- Presented and approved: 2026-08-13 under the user's standing autonomous instruction.

## Next skill
`mcax-plan` for T7 delta, then `mcax-execute`.
