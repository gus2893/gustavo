# Debug: T19 full-suite PostgreSQL cleanup
**Originated during:** mcax-execute T19
**Status:** fixed

## Symptom (one sentence)

Two consecutive `pnpm vitest run` executions passed all 415 and then all 418 test assertions but exited 1 because one or more Windows after-all hooks received `EPERM` while removing an already-stopped, owned `gustavo-postgres-*` temporary cluster.

## Reproduction

1. Run the default full suite under Node.js 24 on Windows.
2. Let each Vitest worker start, stop, and remove its disposable PostgreSQL cluster.

Result: run one reported three cleanup-only suite failures after 415/415 assertions passed; run two reported one cleanup-only suite failure after 418/418 assertions passed. The affected suite names and temp paths differed between runs.

## Hypotheses

- H1: T19 introduced a functional test failure. Refuted because every assertion passed in both full runs and focused T19 remained green.
- H2: a PostgreSQL or `pg_ctl` process remained alive and owned the failed paths. Refuted by a process inspection immediately after the first run, which found no matching process.
- H3: Windows released a transient filesystem handle later than the helper's 500 ms native retry window. Refuted as the sole cause: expanding that boundary to 20 x 150 ms still left one random cleanup-only failure after 419/419 assertions passed.
- H4: concurrent Vitest workers starting, stopping, and deleting separate local PostgreSQL clusters create Windows-only handle pressure. Confirmed when an affected suite passed immediately alone, while the default pool and a reduced four-worker pool failed on different otherwise-passing suites.

## Root cause

The repository gives each Vitest worker its own disposable PostgreSQL cluster. On Windows, concurrent cluster teardown intermittently leaves one worker unable to remove its stopped, prefix-validated temp directory even after bounded native retries; the failing suite/path changes between runs and passes alone. This is test-runner resource concurrency, not a database or product assertion defect.

## Fix attempts (counter)

1. Re-ran the unchanged default suite to distinguish a stable product failure from cleanup timing: all assertions passed again, but one different worker exhausted the same short cleanup boundary.
2. Increased only the existing native removal boundary to 20 retries at 150 ms: targeted lifecycle regression passed, but a default full run still failed cleanup after 419/419 assertions passed, so the change was reverted.
3. Reduced the observation run to four workers: 419/419 assertions passed, but one random cleanup still failed; this confirmed that retry inflation and modest pool reduction were insufficient and triggered the approved Windows-only ownership boundary.

The third recorded item was a diagnostic concurrency observation rather than a second code fix. Only one code fix attempt failed; the approved final fix addresses the confirmed ownership boundary.

## Regression test

File: `vitest.config.ts` and the default `pnpm vitest run` command

Description: on Windows only, the default test runner owns one disposable PostgreSQL cluster at a time; non-Windows environments retain their existing parallel pool. The unchanged cleanup helper continues to surface removal errors after its original bounded retries.

Pre-fix result: all 419 assertions passed, but one random parallel worker cleanup produced exit 1.

Post-fix result: final-tree default `pnpm vitest run` passed 25/25 files and 419/419 tests with exit 0 in 351.18 seconds.

## Fix

- `vitest.config.ts`: sets `maxWorkers: 1` only on Windows, serializing ownership of disposable local PostgreSQL clusters while leaving non-Windows CI parallel.
- `tests/helpers/postgres.ts` and its lifecycle test remain at their pre-debug 5 x 100 ms bounded retry/error contract.
- `missions/public-market-commentary/03-plan.md`: recorded the approved debug scope expansion and this artifact.

## Wider check

- `pnpm vitest run tests/helpers/postgres-lifecycle.test.ts` -> original 4/4 contract passed after the failed retry experiment was reverted.
- Final Stage A re-review tree: `pnpm vitest run` -> 25/25 files and 429/429 tests passed, exit 0 in 323.53 seconds.
- Final focused, full-suite, typecheck, build, frozen-lockfile, diff, and process results are reported in the T19 handoff.
