# Debug: T12 full-suite PostgreSQL timeout

**Originated during:** mcax-execute T12
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run` was expected to pass, but both database-backed tests in `tests/challenge/profile.test.ts` reached Vitest's default 5,000 ms test timeout while the other 224 tests passed.

## Reproduction

1. Use the bundled Node.js 24.14.0 and pnpm 11.16.0 runtime.
2. Run `pnpm vitest run` with the new T12 profile tests and the runner's default timeout.

Result: exit 1 after 55 seconds; 224 tests passed and the tests beginning at `tests/challenge/profile.test.ts:72` and `tests/challenge/profile.test.ts:134` each timed out at exactly 5,000 ms.

## Hypotheses

- H1: parallel full-suite load makes disposable PostgreSQL startup and migration exceed the runner's default timeout. Confirmed by rerunning the unchanged suite with `--testTimeout=30000 --reporter=verbose`: all 226 assertions passed, and the first T12 database test took 11,009 ms.
- H2: the profile migration deadlocks or a profile assertion fails. Refuted by the same isolated timeout-only run: it exited 0, the first profile database test completed, and the append/version test passed in 1,141 ms without changing application or SQL behavior.
- H3: a leaked disposable PostgreSQL server keeps the test blocked. Refuted after the run by querying Windows process command lines for `postgres` processes using a `gustavo-postgres-` temporary data directory; the count was zero.

## Root cause

`testContext()` creates a fresh schema and applies every migration through `openTestDb()` in `tests/helpers/postgres.ts:370`. Under the full suite's parallel database load, the first T12 schema setup took 11,009 ms, which is sound behavior but exceeds Vitest's 5,000 ms default. The repository's existing database-backed tests use explicit 30-second bounds for the same reason. The timeout did not indicate a product assertion, SQL constraint, or cleanup failure.

## Fix attempts (counter)

1. Added a 30,000 ms timeout to each database-backed T12 test, matching the established repository convention: fixed.

## Regression test

File: `tests/challenge/profile.test.ts`

Description: the unchanged persistence and append-only profile assertions run under the full parallel suite with an explicit bounded database-test timeout.

Pre-fix result: both tests timed out at 5,000 ms.

Post-fix result: `pnpm vitest run` passed all 226 tests with exit 0.

## Fix

- `tests/challenge/profile.test.ts`: gave only the two disposable-PostgreSQL tests the repository-standard 30-second bound; pure arithmetic tests retain the default timeout.
- `missions/public-market-commentary/03-plan.md`: recorded this authorized debug artifact in T12's file list.

## Wider check

Commands run after the fix:

- `pnpm vitest run tests/challenge/profile.test.ts` -> 1 file and 6 tests passed, exit 0.
- `pnpm vitest run` -> 18 files and 229 tests passed after the Stage A and Stage B profile-binding regressions were added, exit 0.
- `pnpm exec tsc --noEmit` -> exit 0.
- `pnpm build` -> optimized production build completed, exit 0.
- `pnpm install --frozen-lockfile` -> lockfile already up to date, exit 0.
- `git diff --check` -> no whitespace errors, exit 0.
- temporary Gustavo PostgreSQL process query -> count 0.

## Lessons / design implications

Database integration test timeouts must include bounded disposable-cluster/schema startup under full-suite contention; increasing that test-harness bound does not relax profile arithmetic or persistence rules.
