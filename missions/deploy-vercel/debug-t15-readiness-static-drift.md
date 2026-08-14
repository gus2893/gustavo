# Debug: T15 readiness static assertion drift
**Originated during:** mcax-execute T15 final Stage A drift review
**Status:** fixed

## Symptom

The new signed-STARTING readiness and replay-retention tests passed, but the full hybrid suite failed because an older provenance assertion required the former literal 100ms readiness sleep.

## RED evidence

- Focused readiness/replay tests: 3/3 passed.
- Full hybrid-worker suite: 33 passed, 1 failed.
- Failure: the static expression `STARTING ... Start-Sleep -Milliseconds 100` no longer matched the derived, monotonic-budget-clamped 5-second readiness backoff.
- The first post-fix rerun reached a second assertion in the same legacy block that still required `ElapsedMilliseconds -lt 25000` instead of the derived readiness variable.

## Root cause

The old assertion encoded an implementation constant that the new bounded readiness contract intentionally replaced. Signed STARTING validation still occurs before sleep, but the sleep now uses `$ReadinessPollMilliseconds` and clamps to the remaining monotonic startup budget.

## Fix

Only the stale assertion was narrowed to require signed STARTING before `Start-Sleep -Milliseconds ([Math]::Min(`. The new arithmetic, bounded backoff, and production behavior are unchanged.

The companion loop assertion now requires `ElapsedMilliseconds -lt $ReadinessTimeoutMilliseconds`; the separate stop assertion still requires its original 25-second remaining-budget calculation.

## Verification

- Focused hybrid-worker suite: passed (34/34).
- Signed STOP replay after readiness retention: passed; the stop authority ran once.
- Default Codex/T7 suite: passed (80 passed, 3 controlled-live tests skipped).
- QStash suite: passed (7/7).
- Finnhub suite: passed (74/74).
- TypeScript compiler and PowerShell 5.1 parser: passed.
