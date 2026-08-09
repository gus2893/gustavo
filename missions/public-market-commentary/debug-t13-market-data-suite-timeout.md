# Debug: T13 full-suite market-data timeout

**Originated during:** mcax-execute T13 root verification
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run` under the required Node 24 runtime was expected to pass all 259 tests, but the T11 disposable-PostgreSQL persistence test reached its explicit 15,000 ms timeout by 29 ms while the other 258 tests passed.

## Reproduction

1. Prepend the bundled Node 24.14.0 and pnpm 11.16.0 directories to `PATH`.
2. Run `pnpm vitest run` after adding the T13 cost-model suite.

Result: exit 1; 258/259 assertions passed and `tests/market-data/observation-policy.test.ts:405` timed out at 15,000 ms.

## Hypotheses

- H1: parallel full-suite disposable-database contention pushed sound PostgreSQL startup and migration just beyond the old 15-second test bound. Confirmed: the unchanged test passed focused in 4,501 ms, and no product assertion failed in the full run.
- H2: T13 cost arithmetic changed market-data persistence behavior. Refuted: T13 imports no market-data persistence module, the focused market-data test passed unchanged, and the full failure was the test runner's exact timeout rather than an assertion.
- H3: a leaked test PostgreSQL server blocked cleanup. Refuted: the Gustavo temporary PostgreSQL process count returned to zero after the failed run.

## Root cause

The integration test starts a disposable PostgreSQL cluster and applies the complete migration chain. Under the expanded suite's parallel database load, that bounded setup exceeded its earlier 15-second allowance by 29 ms; focused execution remained well below the bound. This is test-harness contention, not product behavior.

## Fix attempts (counter)

1. Increased only this disposable-database test's bound from 15 seconds to the repository-standard 30 seconds: fixed.

## Regression test

File: `tests/market-data/observation-policy.test.ts`

Description: the unchanged canonical-observation and completed-bar assertions must finish under the full parallel suite with a bounded disposable-database allowance.

Pre-fix result: timed out at 15,000 ms in the full suite.

Post-fix result: the full suite passed 259/259 with exit 0.

## Fix

- `tests/market-data/observation-policy.test.ts`: changed only the database integration test timeout from `15_000` to `30_000`.
- `missions/public-market-commentary/03-plan.md`: recorded the authorized test-harness file and this debug artifact in T13's file list.

## Wider check

- `pnpm vitest run` -> 19 files and 259 tests passed, exit 0.
- The focused unchanged market-data case passed in 4,501 ms before the timeout-only fix.
- Product code was unchanged by this debug session.
