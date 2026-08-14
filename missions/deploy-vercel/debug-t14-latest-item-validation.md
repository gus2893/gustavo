# Debug: T14 latest-item validation
**Originated during:** mcax-execute T14
**Status:** fixed

## Symptom (one sentence)

The concrete T14 database success test expected one 95-result window to commit, but `storeLatestMarketWindow` rejected it with `MARKET_LATEST_INPUT_INVALID` after the orchestration-only mock accepted the same values.

## Reproduction

1. Run the three focused T14 database tests through the trusted Node 24/pnpm entrypoints.
2. Observe two tests pass and the durable 95-result case fail inside T13 latest validation.

Result: the window contained `status='UNAVAILABLE'` paired with `safeCode='PROVIDER_ERROR'`, which is outside the canonical T12/T13 matrix.

## Hypotheses

- H1: the window ID or 95-result bound was invalid. Refuted by a direct pure projection showing an aligned ID, 95 ordered symbols, and exact six-field item shapes.
- H2: T14's normalizer accepted a status/safe-code pair that T12 never emits and T13 rejects. Confirmed by `latest.ts`: UNAVAILABLE permits only MARKET_CLOSED, SYMBOL_UNAVAILABLE, or STALE_QUOTE, while PROVIDER_ERROR requires the matching status. Outcome: confirmed.

## Root cause

`lib/server/market-data/session.ts` validated only that unavailable items had some string safe code. That weakened the frozen T12 contract and allowed a semantically invalid pair to reach T13. The pre-update plan's orchestration sample also contained this inconsistent pair; the regenerated approved plan now uses the canonical provider-error pair.

## Fix attempts (counter)

1. Enforce T12/T13's exact status/safe-code, exact-field, price, and timestamp invariants in the pure T14 normalization boundary; use a canonical PROVIDER_ERROR pair in the database success fixture: fixed the contract mismatch.

## Regression test

File: `tests/market-data/finnhub-poller.test.ts`
Description: an explicit invalid-pair test must produce a failed RESULT_COUNT_INVALID summary with `mutateLatest=false`, while the canonical database fixture commits 95 rows.
Pre-fix result: invalid-pair test failed because the window was marked COMPLETED with latest mutation enabled.
Post-fix result: invalid-pair regression and concrete 95-row persistence both passed.

## Fix

`lib/server/market-data/session.ts` now creates explicit canonical copies only after exact semantic validation. The required sample-title test proves reserve/disconnect/provider/store ordering with the regenerated plan's canonical pair, and the database fixture uses the same provider-adapter contract.

## Wider check

The canonical regression/database slice passed 4/4, the full poller file passed 70/70, and strict typecheck passed.

## Stage B follow-up: canonical FAILED rows at the SQL authority

### Symptom and RED

The database accepted impossible terminal tuples such as `FAILED/CLOSED/MARKET_CLOSED`, even though the worker accepts FAILED only with `providerStatus=ERROR` and excludes `MARKET_CLOSED` from its five failure safe codes.

A direct-SQL matrix update demonstrated the gap: the first invalid tuple resolved successfully instead of raising `MARKET_POLL_WINDOW_TRANSITION_INVALID`.

### Root cause

The table CHECK required only a non-null safe code for FAILED, and the semantic trigger repeated only that weak predicate. Column bounds already enforce calls 0..96 and results 0..95, but neither SQL authority mirrored the worker's exact FAILED provider-status/safe-code matrix.

### Fix and regression test

Migration 0022 now requires FAILED rows to use `provider_status='ERROR'` and exactly one of `PROVIDER_ERROR`, `RATE_LIMITED`, `RESULT_COUNT_INVALID`, `CALL_LIMIT_EXCEEDED`, or `WINDOW_CONFLICT`, in both the table CHECK and transition trigger. Existing call/result bounds remain authoritative.

The direct-SQL regression rejects CLOSED/MARKET_CLOSED, OPEN/PROVIDER_ERROR, and ERROR/MARKET_CLOSED while preserving recovered, provider, rate-limit, call-limit, result-count, and window-conflict failures. Post-fix focused result: the full matrix passed. The complete Finnhub poller file passed 74/74, the migration lifecycle regression passed 1/1, and strict typecheck/diff hygiene exited 0.
