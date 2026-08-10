# Debug: T16 decision-window SQL alias
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/challenge/order-lifecycle.test.ts` was expected to exercise five newly implemented lifecycle tests, but all five stopped in `decisionRow` with PostgreSQL `syntax error at or near "."`.

## Reproduction

1. Use the bundled Node 24 runtime.
2. Run `pnpm vitest run tests/challenge/order-lifecycle.test.ts`.
3. Observe every test fail at the same `decisionRow` query before any lifecycle assertion.

Result: 0/5 tests passed; PostgreSQL rejected the query at the first `window.id` reference.

## Hypotheses

- H1: `window` is parsed as PostgreSQL's reserved window-clause keyword instead of the `decision_windows` alias. Confirmed by inspection of the exact parser boundary and by the successful focused rerun after only renaming that alias.
- H2: A selected-decision column or join is invalid. Refuted because the query parses and reaches later lifecycle behavior without changing any selected columns or joins.

## Root cause

Both application queries and the SQL-authoritative T16 provenance trigger must avoid aliasing `decision_windows` as `window`. PostgreSQL treats `WINDOW` as a keyword, so the migration parser stopped at the following join.

## Fix attempts (counter)

1. Rename only the SQL alias from `window` to `decision_window`: fixed the parser failure without changing query semantics.

## Regression test

File: `tests/challenge/order-lifecycle.test.ts`

Description: all five T16 integration paths load selected-decision provenance through this query.

Pre-fix result: 5 failures at the SQL parser boundary.

Post-fix result: query parsing succeeds; the expanded T16 suite passes 9/9.

## Fix

`lib/server/challenge/orders.ts` and migration `0011_order_lifecycle.sql` use the non-reserved alias `decision_window` for selected-decision queries.

## Wider check

Commands run after the fix: T15+T16 focused 62/62; expanded T16 focused 9/9; full suite 359/359; type check, Next build, and frozen install all pass.
