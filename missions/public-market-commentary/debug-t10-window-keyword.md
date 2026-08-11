# Debug: T10 migration `window` keyword

**Originated during:** mcax-execute T10
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/orchestration/evaluator-rubric.test.ts` was expected to create an isolated PostgreSQL schema and run two tests, but migration `0007_evaluations.sql` failed reproducibly with `syntax error at or near "window"`.

## Reproduction

1. Use the required bundled Node 24.14.0 and pnpm 11.16.0.
2. Run `pnpm vitest run tests/orchestration/evaluator-rubric.test.ts`.

Result: the integration test fails while `openTestDb` applies migrations, before the decision-window behavior executes.

## Hypotheses

- H1: the PL/pgSQL variable named `window` conflicts with PostgreSQL's `WINDOW` keyword. Confirmed by the parser error and the only declaration/reference sites returned by `rg -n "\\bwindow\\b" db/migrations/0007_evaluations.sql`.
- H2: a preceding SQL statement is unterminated. Not tested because H1 is cheaper and directly names the parser token.

## Root cause

`validate_decision_candidate_insert` declared a row variable named `window`; PostgreSQL parses `WINDOW` as a keyword in this position rather than the intended identifier.

## Fix attempts (counter)

1. Rename only the PL/pgSQL variable from `window` to `decision_window`; the migration then applied and the test advanced into proposal setup.

## Regression test

File: `tests/orchestration/evaluator-rubric.test.ts`

Description: the real isolated-PostgreSQL integration test applies every migration before exercising window persistence, so it fails on the broken migration and can run only after the parser issue is fixed.

Pre-fix result: failing with `syntax error at or near "window"`.

Post-fix result: the migration applies successfully; the next failure was an unrelated missing test-fixture environment key.

## Fix

`db/migrations/0007_evaluations.sql` renames the reserved-word variable and its references without changing behavior.

## Wider check

Final focused 4/4 and full 212/212 tests passed; strict TypeScript, the production build, frozen install, diff check, and zero-process audit passed.
