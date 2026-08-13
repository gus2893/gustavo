# Debug: PostgreSQL snapshot token compatibility

**Originated during:** mcax-execute T36
**Status:** fixed

## Symptom (one sentence)

`pnpm playwright test tests/e2e/gustavo-production-readiness.spec.ts` expected a verified real database backup, but `infra/backup/create.ps1` rejected PostgreSQL 17's exported snapshot token as invalid.

## Reproduction

1. Start the T36 disposable PostgreSQL 17 cluster and create account history.
2. Run the production `infra/backup/create.ps1` against it.

Result: exit 1 with `Snapshot metadata query returned an invalid snapshot, schema version, or event high-water.`

## Hypotheses

- H1: The disposable database lacked production's `schema_migrations` table. Confirmed as an initial harness mismatch; adding the production migration ledger changed the error from missing metadata to invalid metadata.
- H2: The production snapshot-token validator modeled the old fake rather than PostgreSQL 17. Confirmed: PostgreSQL returned the documented three-field hex-capable token while the validator accepted only two decimal fields.

## Root cause

`infra/backup/create.ps1` accepted only `^[0-9]+-[0-9]+$`, while PostgreSQL 17 exports tokens shaped like `00000003-000000BC-1`. The T33 fake returned `00000003-1`, so the real incompatibility was not exercised.

## Fix attempts (counter)

1. Added the production migration ledger to the E2E database: exposed the token-format mismatch.
2. Added a PostgreSQL 17-shaped regression token and tightened the production validator to the exact three-part uppercase-hex/decimal shape: fixed.

## Regression test

File: `tests/infra/backup-restore.test.ts`

Description: the fake snapshot session emits `00000003-000000BC-1` and proves that exact value reaches `pg_dump --snapshot`.

Pre-fix result: 1 failed, 6 passed. Post-fix result: 7 passed.

## Fix

- `infra/backup/create.ps1`: accept the actual PostgreSQL 17 exported-snapshot format while remaining fail-closed.
- `tests/infra/backup-restore.test.ts`: cover a hex-containing, three-part token.
- `tests/e2e/fixtures.ts`: apply migrations through the same `schema_migrations` ledger used by Compose.

## Wider check

`pnpm vitest run tests/infra/backup-restore.test.ts` -> 7 passed.
`pnpm playwright test tests/e2e/gustavo-production-readiness.spec.ts` -> 1 passed with real backup and isolated restore.

## Lessons / design implications

Production infrastructure acceptance needs at least one test against the real database tool output; protocol fakes should use captured values, not simplified shapes.
