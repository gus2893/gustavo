# Debug: T20 cursor upsert trigger order
**Originated during:** mcax-execute T20
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/chats/incremental.test.ts` expected an updated export to advance its cursor, but PostgreSQL raised `CHAT_CURSOR_REVISION_MISMATCH` on every second manifest.

## Reproduction

1. Import an authorized source manifest.
2. Import a changed manifest for the same source.

Result: the second import reached the cursor write and failed with `CHAT_CURSOR_REVISION_MISMATCH`.

## Hypotheses

- H1: the application computed the wrong revision. Refuted by the selected cursor revision and bound value being consecutive.
- H2: the cursor trigger evaluated the `INSERT` branch of an `INSERT ... ON CONFLICT DO UPDATE` before conflict resolution. Confirmed by PostgreSQL trigger ordering and by replacing the upsert with explicit insert/update statements.

## Root cause

The cursor's `BEFORE INSERT OR UPDATE` trigger correctly requires revision 1 for inserts. PostgreSQL invokes the `BEFORE INSERT` trigger before resolving `ON CONFLICT`, so an upsert carrying revision 2 never reaches its update arm.

## Fix attempts (counter)

1. Select the cursor under lock and issue an explicit `INSERT` for a missing cursor or `UPDATE` for an existing cursor: fixed.

## Regression test

File: `tests/chats/incremental.test.ts`
Description: updated exports advance the same cursor while importing only the new/corrected versions.
Pre-fix result: failing with `CHAT_CURSOR_REVISION_MISMATCH`.
Post-fix result: passing.

## Fix

`lib/server/chat-sources/import.ts` now chooses the cursor mutation statement from the already locked cursor state, allowing the SQL trigger to validate the real operation.

## Wider check

`pnpm vitest run tests/chats/incremental.test.ts` → all green.
