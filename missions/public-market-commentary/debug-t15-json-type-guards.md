# Debug: T15 JSON type guards
**Originated during:** mcax-execute T15
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/challenge/ledger-replay.test.ts` was expected to exercise the new numeric-JSON regressions but instead failed database setup with `syntax error at end of input` while applying `0010_challenge_ledger.sql`.

## Reproduction

1. Add explicit `jsonb_typeof` guards for nullable typed-event fields using `IS DISTINCT FROM CASE ... END`.
2. Run `pnpm vitest run tests/challenge/ledger-replay.test.ts`.

Result: 15 database-backed tests fail during migration parsing; 17 non-database assertions pass.

## Hypotheses

- H1: The unparenthesized `CASE` expressions on the right side of `IS DISTINCT FROM` leave the PL/pgSQL condition syntactically ambiguous. Confirmed by inspection of every newly added nullable type guard at `db/migrations/0010_challenge_ledger.sql:349-360`, `:394-395`, `:428-431`, and `:450-453`.
- H2: A trigger function terminator was removed. Refuted by inspection: `validate_challenge_source_event()` still ends with `end; $$;` and its nested blocks are balanced.

## Root cause

The nullable type guards introduced `CASE` expressions directly after `IS DISTINCT FROM` without expression parentheses. PostgreSQL reaches the end of the function body without resolving that conditional expression. Non-nullable guards use string literals and do not have the ambiguity.

## Fix attempts (counter)

1. Parenthesize each `CASE ... END` RHS without changing any guard or comparison: fixed the migration parser failure.

## Regression test

File: `tests/challenge/ledger-replay.test.ts`
Description: the existing focused suite applies the migration before proving numeric JSON is rejected for every fixed-decimal accounting payload field.
Pre-fix result: migration parse failure.
Post-fix result: focused suite passes 32/32, including every numeric-JSON rejection and valid string load/replay case.

## Fix

`db/migrations/0010_challenge_ledger.sql`: parenthesize only the nullable `CASE` expressions used by `IS DISTINCT FROM` JSON type checks.

## Wider check

Focused T15 suite → 32/32; full suite → 21 files and 325/325; TypeScript, Next production build, frozen install, and `git diff --check` → exit 0; active Gustavo PostgreSQL/`pg_ctl` process count → 0.
