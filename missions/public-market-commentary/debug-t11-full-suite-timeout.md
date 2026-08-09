# Debug: T11 database test full-suite timeout
**Originated during:** mcax-execute T11
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run` was expected to pass all 221 tests, but the T11 PostgreSQL integration test exceeded Vitest's 5-second default by 21 milliseconds while every completed assertion and all other 220 tests passed.

## Reproduction

1. Run the T11 test alone: it passes in 4.59 seconds of test time.
2. Run all 16 test files concurrently: the same integration test reaches 5.021 seconds and Vitest cancels it at the default timeout.

Result: the full suite reports 220 passed and one timeout in the database-backed T11 case.

## Hypotheses

- H1: Parallel disposable PostgreSQL startup/migration load pushes a valid integration test just beyond the unit-test timeout. Confirmed by the focused 4.59-second pass, the full-suite 5.021-second timeout, and the absence of a failed assertion.
- H2: A market-data SQL operation deadlocks. Refuted by the deterministic focused pass and the timeout occurring at the outer test boundary rather than a database error.
- H3: The earlier null-check fix regressed. Refuted because the focused regression is green and the full run progressed past the valid observation insert without that error.

## Root cause

The test uses the repository's real disposable PostgreSQL lifecycle and applies every migration. Concurrent full-suite database fixtures introduce enough startup contention to cross Vitest's 5-second unit default, which is too narrow for this integration boundary.

## Fix attempts (counter)

1. Give only the database integration case a bounded 15-second timeout: fixed; two subsequent full-suite runs passed 221/221.

## Regression test

File: `tests/market-data/observation-policy.test.ts`
Description: the existing database contract case must complete under the full concurrent suite, not only in isolation.
Pre-fix result: focused pass; full suite timeout at 5.021 seconds.
Post-fix result: passing in the full concurrent suite.

## Fix

`tests/market-data/observation-policy.test.ts`: use a 15-second timeout for the one real-PostgreSQL integration test; pure tests keep the default timeout.

## Wider check

`pnpm vitest run` -> 221/221 passed twice after the change; the focused T11 test remained 9/9 green.
