# Debug: T22 recovery window parameter type
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

The focused browser story reached retained-window seeding and PostgreSQL rejected the test-owned insert with `inconsistent types deduced for parameter $2`.

## Reproduction

1. Run the trusted focused Playwright spec with one worker.
2. Complete the first hybrid drain, stop the worker, and send the offline canary.
3. Seed the retained and expired prior market windows.

Result: PostgreSQL rejects the VALUES expression before the second child starts.

## Hypotheses

- H1: each unknown timestamp parameter is used both as a `timestamptz` column value and as the left operand of overloaded `+ interval`, so PostgreSQL cannot infer one type. Confirm from the migration and add an explicit cast at each VALUES parameter occurrence.

## Evidence

- The failure names parameter `$2` at the recovery-window insert.
- Migration `0022_hybrid_deployment.sql` defines `window_started_at`, `created_at`, `updated_at`, and `prune_after` as `timestamptz`.
- The query uses `$2` and `$4` in those columns and in `$2 + interval '7 days'` / `$4 + interval '7 days'`.
- Teardown left zero owned processes and zero ownership registries.

## Root cause

H1 confirmed: the test-owned SQL left the overloaded timestamp-plus-interval operands as unknown parameters.

## Fix attempts (counter)

1. Cast only `$2` and `$4` to `timestamptz` in the VALUES expressions, preserving values and assertions.

## Regression test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: retained and expired recovery windows must seed successfully before restart recovery is asserted.
Pre-fix result: PostgreSQL parameter inference error.
Post-fix result: both windows seeded and the retained/expired recovery assertions passed.

## Fix

Only `$2` and `$4` are explicitly cast to `timestamptz`; data and assertions are unchanged.

## Wider check

Full focused Playwright story passed and trusted TypeScript exited 0.
