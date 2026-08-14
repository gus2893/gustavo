# Prompt update: Docker-owned Codex singleton authority
**Date:** 2026-08-13
**Triggered by:** debug escalation (`debug-t7-container-authority.md`)
**Approval status before:** approved
**Approval status after:** needs re-approval → approved on 2026-08-13 under the user's standing instruction to proceed autonomously

## Change description
An interrupted `docker create` can finish in the daemon after the CLI process exits and after any finite series of absence checks. The runner therefore cannot safely clear a process-local lock using a wall-clock delay. The design now uses one fixed Docker container name as daemon-owned durable serialization, binds lifecycle operations to the immutable returned container ID, never auto-clears an ambiguous create, and gives run/reconcile one synchronous owner until actual lifecycle settlement.

## Sections of 02-design.md updated
- Decisions / Container-isolated unsupported Codex runner
  - **Was:** randomized per-job name plus process-local lockout and sampled absence recovery.
  - **Now:** fixed singleton name, exact ID authority, durable fail-closed ambiguity, shared run/reconcile mutex, and unsettled-promise ownership.

## Impact
### Plan tasks invalidated
- T7: lifecycle authority and concurrency tests must be regenerated.
- T15/T19/T21/T23: wording/assertions that describe startup reconciliation or operator recovery must use the fixed singleton authority; their core behavior is unchanged.

### Tests that must change
- `tests/bridge/codex-cli.test.ts` — assert fixed-name collision, immutable ID binding, cross-instance/restart serialization, no auto-unlock after ambiguous create, exclusive run/reconcile ownership, and unsettled execution ownership.

### Code files that must change
- `worker/hybrid/codex-runner.ts` — replace randomized naming/time-based ambiguity with fixed singleton name and exact ID lifecycle authority.

### Verification status
- No `05-verify.md` exists; full verification remains pending after execution.

## Re-approval
- Presented to user: 2026-08-13.
- Confirmed approved: 2026-08-13 via “Proceed with all without needed input.”

## Next skill
`mcax-plan` for the invalidated T7 delta, then resume `mcax-execute`.
