# Debug: T2 event-store integration timeout

**Originated during:** mcax-execute T2  
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/events/event-store.test.ts` should complete one PostgreSQL integration test, but the test reproducibly times out after 30 seconds and its cleanup hook subsequently times out while a test connection remains busy.

## Reproduction

1. Prepend the approved bundled Node 24.14.0 and pnpm 11.16.0 directories to `PATH`.
2. Run `pnpm vitest run tests/events/event-store.test.ts`.

Result: the test and `afterAll` hook both time out; the temporary PostgreSQL 17 cluster starts and remains visible on loopback until stopped explicitly.

## Hypotheses

- H1: Temporary PostgreSQL startup or migration consumes the entire timeout. Confirmed at the startup boundary, then narrowed: PostgreSQL was accepting `psql` connections while the test had opened no database connection, proving `startTestPostgres` had not returned.
- H2: An event-store transaction waits on a lock it already holds. Refuted because `pg_stat_activity` showed no test client or transaction while the test was hung.
- H3: A later trigger/error assertion leaves a transaction or pool connection unresolved. Refuted because the test never reached the first pool connection before the fix.

## Root cause

On Windows, `execFile` captured `pg_ctl start` output with pipes. The persistent `postgres.exe` child inherited a captured pipe, so Node's promisified `execFile` never observed all streams closing even though `pg_ctl` had started PostgreSQL successfully. `startTestPostgres` therefore waited forever before constructing its admin pool. The first bad boundary was `tests/helpers/postgres.ts` at the `pg_ctl start` process invocation, not PostgreSQL startup or event-store SQL.

## Fix attempts (counter)

1. Replace only the `pg_ctl start` invocation with `spawn` using ignored stdio so the persistent server cannot inherit Node-owned pipes: passed. Increasing the test/hook timeout earlier was diagnostic only and is not counted as a behavioral fix.

## Regression test

File: `tests/events/event-store.test.ts`  
Description: the integration test exercises the complete append/read/replay/rollback path and must finish without a timeout.  
Pre-fix result: failing by timeout.  
Post-fix result: one integration test passed in 4.94 seconds.

## Fix

`tests/helpers/postgres.ts` now starts `pg_ctl` through a small process runner with ignored stdio. Initialization and shutdown remain captured commands because neither creates a persistent child.

## Wider check

Bundled Node 24.14.0 / pnpm 11.16.0 checks all passed: targeted integration test (1/1), full Vitest suite (3/3), `tsc --noEmit`, `next build`, frozen-lockfile install, and `git diff --check`.
