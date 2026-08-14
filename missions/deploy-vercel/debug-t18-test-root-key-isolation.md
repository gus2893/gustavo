# Debug: T18 test root-key isolation
**Originated during:** mcax-execute T18
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/ui/account-surfaces.test.tsx` was expected to pass the full account-surface suite, but after the new separate-schema T18 fixtures ran, two existing encrypted-surface/export cases failed with AES-GCM authentication errors and HTTP 500.

## Reproduction

1. Run the full account-surface test file with the trusted Node 24/pnpm runtime.
2. Allow the new bridge-lease and coherent-market-snapshot cases to open their independent PostgreSQL schemas before later existing encrypted reads.

Result: 15 tests passed and 2 failed; `unwrapDataKey` raised `Unsupported state or unable to authenticate data`, and the account export returned 500 instead of 200.

## Hypotheses

- H1: each `openTestDb()` replaces the process-global test envelope key, so a later test attempts to decrypt the original suite fixture with the newest schema's key. Confirmed by `tests/helpers/postgres.ts`, which assigns a new random `GUSTAVO_EVENT_ROOT_KEY_V1` for every opened schema, and by the failures appearing only after the new separate-schema fixtures.
- H2: the repeatable-read market projection changed ciphertext or key rows. Refuted because the failing export path does not call the new market projection, while both failures share the same envelope authentication boundary.

## Root cause

`openTestDb()` intentionally creates an independent root key for each isolated schema but exposes it through the process environment. The T18 tests opened additional schemas inside a describe block whose original encrypted fixture remained in use afterward, leaving that fixture's ciphertext paired with a different schema's process-global key.

## Fix attempts (counter)

1. Capture the integration suite's root key/version after its fixture setup and restore them in `afterEach`: fixed the full-file failure without changing production code or weakening schema isolation.

## Regression test

File: `tests/ui/account-surfaces.test.tsx`
Description: the full file runs the new independent bridge/snapshot fixtures and then the pre-existing encrypted market/export cases under the original suite key.
Pre-fix result: 15 passed, 2 failed with AES-GCM authentication/HTTP 500.
Post-fix result: 17 passed.

## Fix

`tests/ui/account-surfaces.test.tsx` now restores the owning integration fixture's test root-key environment after each case. Production encryption, key storage, and DAL behavior are unchanged.

## Wider check

- `pnpm vitest run tests/ui/account-surfaces.test.tsx` -> 17 passed.
- Focused wake-heartbeat, DB-clock lease/quota, and coherent-snapshot T18 tests -> all passed.
- `pnpm vitest run tests/infra/hybrid-worker.test.ts` -> 35 passed.
- `pnpm vitest run tests/market-data/finnhub-poller.test.ts` -> 74 passed.
- Focused privacy export/static-boundary slice -> 2 passed, 65 skipped.
- `pnpm exec tsc --noEmit` and scoped `git diff --check` -> exit 0.
