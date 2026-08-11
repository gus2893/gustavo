# Debug: T23 first PostgreSQL migration
**Originated during:** mcax-execute T23
**Status:** fixed

## Symptom (one sentence)

`pnpm.cmd vitest run tests/handoffs/privacy.test.ts` expected the durable handoff round trip to run, but exited 1 while applying `0017_handoffs.sql` with `syntax error at or near "authorization"`.

## Reproduction

1. Run `pnpm.cmd vitest run tests/handoffs/privacy.test.ts` from the repository root.
2. Let `openTestDb` apply all numbered migrations to a fresh PostgreSQL schema.

Result: PostgreSQL rejected `0017_handoffs.sql` before fixture creation at the token `authorization`.

## Hypotheses

- H1: The unquoted `authorization` relation alias is parsed as PostgreSQL's `AUTHORIZATION` keyword. Confirmed by the exact parser token and the single occurrence in `handoff_packet_idea_validate`; replacing only that alias lets the migration pass that parser boundary.
- H2: A nearby `proposal_disclosure_authorizations` table reference is missing punctuation. Refuted by inspecting the complete `SELECT` and its balanced join/where clauses.
- H3: PL/pgSQL parses the unparenthesized SQL `CASE` following `event.type<>` as a control-flow boundary. Confirmed by the second parser diagnostic at character 24,607 and eliminated by parenthesizing only the expression.

## Root cause

The `handoff_packet_idea_validate` trigger used the reserved keyword `authorization` as an unquoted alias for `proposal_disclosure_authorizations`. PostgreSQL rejected the migration during parse, before any T23 behavior or protected data path executed.

## Fix attempts (counter)

1. Rename only the alias from `authorization` to `disclosure`: fixed the first parser failure and revealed an independent parse error.
2. Parenthesize the SQL `CASE` expression at the exact second parser position: fixed the remaining migration parse failure.

## Regression test

File: `tests/handoffs/privacy.test.ts`
Description: creates a fresh migrated PostgreSQL schema before exercising the durable packet round trip.
Pre-fix result: failing during migration parse.
Post-fix result: migration completes and the test advances into fixture behavior.

## Fix

- `db/migrations/0017_handoffs.sql`: replaced the reserved relation alias without changing SQL semantics.

## Wider check

Commands run after the fix: `pnpm.cmd vitest run tests/handoffs/privacy.test.ts`.
