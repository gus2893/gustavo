# Debug: T23 incremental delta query
**Originated during:** mcax-execute T23
**Status:** fixed

## Symptom (one sentence)

`pnpm.cmd vitest run tests/handoffs/privacy.test.ts` expected eight passing tests, but the new small-delta scheduler failed with PostgreSQL error `for SELECT DISTINCT, ORDER BY expressions must appear in select list` while the other seven cases passed.

## Reproduction

1. Create the durable proposal/memory fixture.
2. Call `refreshHandoffIncrementally` before the first packet exists.

Result: the bounded delta query selects `relevant.ingested_sequence::text` but orders by `relevant.ingested_sequence`, which PostgreSQL treats as a different expression under `DISTINCT`.

## Hypotheses

- H1: The selected cast and numeric order expression are not identical under PostgreSQL's `DISTINCT` rule. Confirmed by the exact server diagnostic and query text.
- H2: A union branch returns a conflicting type. Refuted because every branch selects the same bigint `events.ingested_sequence` column.

## Root cause

The query cast the selected bigint to text but ordered by the uncast bigint expression. PostgreSQL requires an identical selected expression for `ORDER BY` under `SELECT DISTINCT`.

## Fix attempts (counter)

1. Select the bigint expression without a cast and retain its numeric order; node-postgres already decodes bigint as a string: fixed.

## Regression test

File: `tests/handoffs/privacy.test.ts`
Description: the durable packet test now enters through `refreshHandoffIncrementally` and exercises its ≤8-event synchronous path.
Pre-fix result: PostgreSQL query error.
Post-fix result: all eight focused tests pass.

## Fix

- `worker/handoffs/refresh.ts`: aligned the selected and ordered DISTINCT expression without changing bounds or semantics.

## Wider check

Command: `pnpm.cmd vitest run tests/handoffs/privacy.test.ts`.
