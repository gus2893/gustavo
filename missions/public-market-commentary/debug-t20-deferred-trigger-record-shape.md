# Debug: T20 deferred trigger record shape
**Originated during:** mcax-execute T20 Stage A correction
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/chats/incremental.test.ts` reached transaction commit but every valid import failed because the deferred graph trigger reported `record NEW has no field import_id`.

## Reproduction

1. Import any valid authorized manifest.
2. Let the transaction commit and fire deferred completeness constraints.

Result: the trigger fires on `chat_source_imports`, whose row has `id`, while a CASE expression still dereferences the alternate `NEW.import_id` field.

## Hypotheses

- H1: an application insert omitted `import_id`. Refuted because the exception originates at deferred commit after all inserts succeed.
- H2: PL/pgSQL resolves both record-field references in the CASE expression. Confirmed by the trigger's table-polymorphic `NEW` record and eliminated by table-specific IF branches.

## Root cause

`validate_chat_import_graph` used one CASE expression across trigger row types with different physical columns. PostgreSQL attempted to resolve a field that does not exist on the import row.

## Fix attempts (counter)

1. Branch on `TG_TABLE_NAME` before dereferencing the table-specific field: fixed.

## Regression test

File: `tests/chats/incremental.test.ts`
Description: every successful import reaches deferred complete-graph validation and commits.
Pre-fix result: `record NEW has no field import_id`.
Post-fix result: focused imports proceed to their behavioral assertions.

## Fix

The deferred trigger now uses an explicit IF branch, preserving the same fail-closed validation on both row shapes.

## Wider check

`pnpm vitest run tests/chats/incremental.test.ts` and `pnpm exec tsc --noEmit` → green after the Stage A correction.
