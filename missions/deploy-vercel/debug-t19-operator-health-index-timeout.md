# Debug: T19 operator-health index-test timeout
**Originated during:** mcax-execute T19
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/performance/recall-latency.test.ts -t "operator health boundary"` passed five mocked operator-health tests but the existing real-PostgreSQL index test exceeded Vitest's fixed 5,000-millisecond per-test timeout during `testContext()` setup.

## Reproduction

1. Run only `has time-leading indexes for every bounded operator-health sample` with the default test timeout.
2. Observe the test stop at 5,015 milliseconds while awaiting `testContext()` at `tests/performance/recall-latency.test.ts:415`.

Result: the isolated test reproduces the same timeout; no T19 health collection or route call occurs in that test.

## Hypotheses

- H1: Creating a fresh schema and applying every migration now takes longer than the test's fixed five-second budget under the shared workspace load. Confirmed by rerunning the unchanged test with the process-only `--test-timeout=20000`: it passed, with the test body reporting 6.50 seconds.
- H2: A T19 query or projection hangs the index assertion. Refuted because the test only calls `testContext()` and queries `pg_indexes`; it never calls `collectHybridHealth`, `collectOperatorHealthResponse`, or the operator route.
- H3: T19 added migration work that made fixture setup slower. Refuted by the T19 diff: it adds no migration and does not modify `tests/helpers/postgres.ts`; the fixture still creates one isolated schema and applies the pre-existing migration set.

## Root cause

The legacy integration test's five-second per-test budget is below the current cold isolated-schema migration time in the concurrently used workspace. This is an environmental test-budget failure, not a T19 product defect. The helper's registered `afterAll` cleanup still closes and drops every owned schema and restores root-key environment state.

## Fix attempts (counter)

1. Rerun the unchanged isolated test with a process-only 20-second timeout: passed in 6.50 seconds. No source or test timeout was changed.

## Regression test

File: `tests/performance/recall-latency.test.ts`

Description: the existing index test asserts all five time-leading operator-health indexes exist after applying migrations to a fresh schema.

Default-budget result: timed out during fixture setup before the assertion.

Sufficient process-budget result: passed unchanged.

## Fix

No repository fix is warranted within T19. Relevant real-PostgreSQL verification is run with a process-only timeout sufficient for the existing migration fixture; the committed test budget and product code remain unchanged.

## Wider check

`pnpm vitest run tests/performance/recall-latency.test.ts -t "operator health boundary" --test-timeout=20000` â†’ 6 passed, 10 skipped. No test-owned process or schema residue was reported by the helper's cleanup gate.
