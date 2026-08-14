# Debug: T16 full-file suite isolation
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

Running the full cache and privacy test files together passed all privacy cases but failed five unrelated cache cases with AES-GCM authentication errors and missing downstream metrics, despite every focused T16 case being green.

## Reproduction

1. Run `tests/cache/postgres.test.ts` and `tests/privacy/forget-propagation.test.ts` in one Vitest invocation with the bundled Node 24/pnpm 11 toolchain.
2. Wait for both disposable PostgreSQL-backed files to complete.

Result: 68 passed and 5 cache cases failed; four failures originate in `unwrapDataKey`, while one downstream metrics assertion lacks work prevented by the decrypt failures.

## Hypotheses

- H1: The two full files interfere through process/global event-root-key or disposable database fixture authority when Vitest runs them together. Refuted as the primary cause: the full cache file failed identically when run alone.
- H2: The T16 maintenance fixture rotates process-wide event-root-key authority by calling `openTestDb()` and does not restore the original file fixture's key. Confirmed: this call precedes every failing pre-existing cache test, and restoring the retained key in `finally` made the full cache file pass.
- H3: T16 route imports change module initialization or environment handling in the cache file. Refuted by H2's targeted intervention; no production change was needed.

## Root cause

`openTestDb()` installs the disposable database's root key in `process.env.GUSTAVO_EVENT_ROOT_KEY_V1`. The new maintenance test created a second database before the established global cache tests but failed to restore the original key, so those tests tried to unwrap their existing event data keys with the second database's root key.

## Fix attempts (counter)

1. Retain the original root key before the maintenance database is opened and restore it in `finally`: full isolated cache file passed 18/18.

## Regression test

File: `tests/cache/postgres.test.ts`
Description: the full file now exercises the new disposable maintenance database before all established cache projections and still decrypts the original fixture successfully.
Pre-fix result: 5 failed, 13 passed.
Post-fix result: 18 passed.

## Fix

The test fixture restores `GUSTAVO_EVENT_ROOT_KEY_V1` on both success and failure. Production code is unchanged.

## Wider check

- Focused privacy maintenance: 4 passed, exit 0.
- Focused cache maintenance: 2 passed, exit 0.
- Combined full files: 68 passed, 5 failed, exit 1.
- Isolated full cache file before fix: 5 failed, 13 passed, exit 1.
- Isolated full cache file after fix: 18 passed, exit 0.
- Isolated full privacy file after fix: 55 passed, exit 0.

## Later independent isolation incident (Stage B)

After the bounded post-commit observer change, one combined cache/privacy run passed all 12
maintenance cases but failed the pre-existing metric-retention assertion: the newest
`cache.queue_lag_ms` bucket contained 81 rather than all 1,005 samples. The same exact cache
file then passed 28/28 alone and the privacy file passed 56/56 alone, so no production change
was made.

The failing test writes 1,005 samples using a production minute bucket based on
`date_trunc('minute', clock_timestamp())` and assumes the newest single bucket contains every
sample. The observed 81 is consistent with that loop crossing a wall-clock minute boundary;
the preceding 924 samples remain correctly aggregated in the immediately previous bucket.
This is an unrelated wall-clock test assumption, not a transaction-budget or shared-pool
failure. A fresh combined-process rerun is the wider-gate check for this T16 handoff.
