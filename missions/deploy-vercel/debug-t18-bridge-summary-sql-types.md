# Debug: T18 bridge-summary SQL types
**Originated during:** mcax-execute T18
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/ui/account-surfaces.test.tsx` was expected to pass the full account-surface suite but failed while loading the new bridge summary with PostgreSQL `operator does not exist: text = uuid`.

## Reproduction

1. Run the full account-surface suite with the trusted Node 24/pnpm runtime.
2. Allow the production integration fixture to call `loadAccountConversation`.

Result: PostgreSQL rejects the new `source.account_id=$1::uuid` join before the conversation renders.

## Hypotheses

- H1: `events.account_id` is `text` while the explicit parameter cast is `uuid`. Confirmed by `db/migrations/0001_events.sql`, which declares `events.account_id text`, and the failure at the exact comparison.
- H2: `bridge_model_jobs.source_event_id` has an incompatible type. Refuted by `db/migrations/0022_hybrid_deployment.sql`, which declares it as `uuid references events(id)`.

## Root cause

The new bridge-summary query introduced a UUID cast for an account identifier compared against the legacy `events.account_id text` column. PostgreSQL does not define `text = uuid`, so the query fails before returning the safe bridge DTO.

## Fix attempts (counter)

1. Changed only the account-parameter cast from `uuid` to `text`, matching the authoritative event schema: fixed the focused and full-suite failure.

## Regression test

File: `tests/ui/account-surfaces.test.tsx`
Description: an authenticated account with queued Node jobs loads an account-scoped offline bridge summary through the real PostgreSQL schema.
Pre-fix result: failing with `operator does not exist: text = uuid`.
Post-fix result: one selected test passed and the full 15-test account-surface suite passed.

## Fix

`lib/server/dal/account-surfaces.ts` now compares `events.account_id` with `$1::text`; no schema or bridge-job authority changed.

## Wider check

- `pnpm vitest run tests/ui/account-surfaces.test.tsx` → 15 passed.
- `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "latest market projection"` → 38 passed, 36 skipped.
- `pnpm vitest run tests/privacy/forget-propagation.test.ts -t "exports only bounded authorized source and derived data, never trade payloads, keys, or ciphertext"` → 1 passed, 55 skipped.
- `pnpm vitest run tests/security/static-boundaries.test.ts -t "contains no real execution connectivity, public secret names, or unsafe claims"` → 1 passed, 10 skipped.
- `pnpm exec tsc --noEmit` and scoped `git diff --check` → exit 0.
