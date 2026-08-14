# Debug: T20A static-trigger test clock
**Originated during:** mcax-execute T20A
**Status:** fixed

## Symptom (one sentence)

The focused T20A GREEN command expected three passing static-trigger tests, but the runtime test treated an async function's returned pending Promise as completed and the market test advanced only the reservation clock beyond the real completion clock, causing two failures.

## Reproduction

1. Run the focused T20A Vitest command with the trusted Node 24/pnpm runtime.
2. Observe `toHaveReturned()` fail immediately after `deriveCurrentMarketWindow` returns its pending Promise.
3. Observe `market_poll_windows_check3` reject successful finalization for a synthetic window six minutes ahead of `clock_timestamp()`.

Result: QStash passes; runtime and market boundary tests fail for test-harness reasons.

## Hypotheses

- H1: Vitest records an async mock as returned when it returns the pending Promise, not when that Promise settles. Confirmed by the matcher failing while the derivation gate remains unresolved.
- H2: Overriding only `market_poll_reservation_now()` into a future bucket makes reservation accept a window that the schema's real `clock_timestamp()` correctly refuses to finalize before its interval. Confirmed by the failing row's future window and earlier real completion timestamp.

## Root cause

The runtime assertion used the wrong matcher for synchronous admission, while the market fixture made two database clock authorities disagree during a successful poll. Production runtime and reservation behavior remained consistent with the approved design.

## Fix attempts (counter)

1. Replaced the async completion matcher and attempted to define a parameterized SQL clock function: runtime test passed; PostgreSQL rejected the bind because parameters inside the dollar-quoted function body are not prepared-statement parameters.
2. Used the repository's working table-backed test-clock pattern, then restored the normal database clock before reservation: focused market regression passed.

## Regression test

Files: `tests/infra/hybrid-worker.test.ts`, `tests/market-data/finnhub-poller.test.ts`

Description: synchronous static-trigger admission stays non-awaited and duplicate triggers coalesce; a database-owned bucket transition skips the old window with no side effects and lets the next database-current trigger poll.

Pre-fix result: failing.

Post-fix result: passing.

## Fix

- `tests/infra/hybrid-worker.test.ts`: assert two HTTP injections return 202 while one derivation remains gated and provider polling remains blocked, which proves synchronous non-awaited admission without misreading Promise settlement.
- `tests/market-data/finnhub-poller.test.ts`: derive a prior bucket from a table-backed PostgreSQL test clock, restore normal PostgreSQL time before reservation, and prove the old bucket skips before the next current bucket polls.

## Wider check

- Focused T20A tests: 4 passed, 116 skipped.
- Full QStash/hybrid-worker/Finnhub suites: 120 passed.
- `pnpm tsc --noEmit`: exit 0.
- Task-scoped `git diff --check`: exit 0.
