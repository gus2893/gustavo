# Prompt update: explicit Codex metering provenance
**Date:** 2026-08-13
**Triggered by:** T8 implementation contract mismatch
**Approval status before:** approved
**Approval status after:** needs re-approval → approved on 2026-08-13 under the user's standing autonomous instruction

## Change description
The isolated runner validated but discarded Codex usage, while the generic gateway required concrete usage and had no representation for provider usage being absent. The contract now separates gateway-observed counts used for limits from optional provider-reported metering. Missing CLI usage is explicitly `UNKNOWN`; it never becomes an estimated billable charge. Incremental Codex bridge cost is the fixed known value zero and there is no fallback.

## Impact
### Plan tasks invalidated
- T8: expand the two-file adapter task to the minimum runner/gateway metering contract and tests.
- T9/T18/T19: consume the new adapter result/status; their durable authority and UI behavior remain unchanged.

### Tests that must change
- `tests/bridge/codex-cli.test.ts` — preserve reported counts, explicit unknown status, role deadlines, output limit, safe errors.
- `tests/models/gateway-audit.test.ts` — snapshot/freeze and validate optional metering provenance without changing legacy provider behavior.

### Code files that must change
- `worker/hybrid/codex-runner.ts` — return optional validated Codex usage.
- `lib/server/models/types.ts` — add optional frozen metering provenance.
- `lib/server/models/gateway.ts` — snapshot and validate provenance while accounting with existing bounded observed counts.
- `lib/server/models/codex-cli.ts` — new zero-incremental-cost adapter.

### Verification status
- Full verification remains pending.

## Re-approval
- Presented and approved: 2026-08-13 under the user's standing autonomous instruction.

## Next skill
`mcax-plan` for T8, then `mcax-execute`.
