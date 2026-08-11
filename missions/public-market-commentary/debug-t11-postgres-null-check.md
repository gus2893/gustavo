# Debug: PostgreSQL text null-character check
**Originated during:** mcax-execute T11
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/market-data/observation-policy.test.ts` was expected to pass the first licensed-observation insert, but PostgreSQL raised `null character not permitted` from the `raw_source_ref` check in migration `0008_market_data.sql`.

## Reproduction

1. Apply migrations through `0008_market_data.sql` in a disposable PostgreSQL test schema.
2. Insert a valid licensed `market_observations` row with `raw_source_ref = 'sequence:42'`.

Result: PostgreSQL evaluates `position(chr(0) in raw_source_ref)=0`; constructing `chr(0)` for the text expression raises `null character not permitted` before the valid row can be stored.

## Hypotheses

- H1: PostgreSQL rejects the `chr(0)` text value used by the check itself. Confirmed by the error occurring on the first valid observation insert and by the only repository `chr(0)` occurrence being that constraint.
- H2: The valid fixture contains an embedded null. Refuted by the literal fixture value `sequence:42`.
- H3: A prior migration or driver parameter introduces the null. Refuted because the failing value is a SQL literal and the migration applies successfully; failure begins when the check is evaluated.

## Root cause

PostgreSQL `text` cannot contain the zero byte, and PostgreSQL also refuses to construct `chr(0)` as a `text` value. The constraint attempted to validate a condition already guaranteed by the database representation, so evaluating the validator itself broke every observation insert.

## Fix attempts (counter)

1. Remove the impossible `chr(0)` expression while retaining the length and canonical-trim checks: fixed; the focused test passed 9/9 and the full suite passed 221/221.

## Regression test

File: `tests/market-data/observation-policy.test.ts`
Description: inserts a valid canonical licensed observation before exercising observation and completed-bar immutability.
Pre-fix result: failing with `null character not permitted`.
Post-fix result: passing.

## Fix

`db/migrations/0008_market_data.sql`: rely on PostgreSQL's native rejection of zero bytes in `text`; keep explicit bounded-length and no-surrounding-whitespace checks.

## Wider check

`pnpm vitest run tests/market-data/observation-policy.test.ts` -> 9/9 passed; `pnpm vitest run` -> 221/221 passed; `pnpm exec tsc --noEmit` and `pnpm build` -> exit 0.
