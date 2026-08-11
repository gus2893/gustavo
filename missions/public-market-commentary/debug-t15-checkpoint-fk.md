# Debug: T15 checkpoint foreign key
**Originated during:** mcax-execute T15
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/challenge/ledger-replay.test.ts` was expected to pass the first green implementation, but PostgreSQL rejected migration `0010_challenge_ledger.sql` with `there is no unique constraint matching given keys for referenced table "challenge_ledger_events"` before either database test could run.

## Reproduction

1. Use bundled Node.js 24.14.0 and pnpm 11.16.0.
2. Run `pnpm vitest run tests/challenge/ledger-replay.test.ts`.

Result: 16 pure replay assertions passed, while the two database tests failed as PostgreSQL applied the migration.

## Hypotheses

- H1: The checkpoint foreign key names `(id, stage_id, profile_version_id, sequence)`, but the ledger has no unique constraint on exactly that ordered column set. Confirmed by comparing the checkpoint foreign key to the ledger's declared unique keys; its only sequence-bearing five-column key also included `challenge_portfolio_id`.

## Root cause

`db/migrations/0010_challenge_ledger.sql` initially declared a four-column checkpoint foreign key without declaring the exact four-column candidate key on `challenge_ledger_events`. PostgreSQL foreign keys require a matching unique or primary key; a different five-column unique key cannot satisfy that requirement.

## Fix attempts (counter)

1. Add the exact immutable-ledger candidate key `(id, stage_id, profile_version_id, sequence)`: fixed the migration failure.

## Regression test

File: `tests/challenge/ledger-replay.test.ts`
Description: creates the migration-backed checkpoint, binds its stage/profile/high-water sequence to an immutable ledger event, then proves the checkpoint can be discarded without deleting source history.
Pre-fix result: migration fails before the database assertion.
Post-fix result: passing.

## Fix

`db/migrations/0010_challenge_ledger.sql` declares the exact unique candidate key referenced by the checkpoint foreign key.

## Wider check

Focused T15 suite → 32/32; full suite → 21 files and 325/325; TypeScript, Next production build, frozen install, and `git diff --check` → exit 0; active Gustavo PostgreSQL/`pg_ctl` process count → 0.
