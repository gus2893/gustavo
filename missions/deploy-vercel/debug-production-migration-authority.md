# Debug: production migration authority

**Originated during:** `mcax-execute` T3 Stage B
**Status:** fixed

## Symptom (one sentence)

The T3 quality review showed that the new migration command can lose its session advisory lock behind Neon transaction pooling, records schema state in a ledger the verified backup path does not read, and hashes checkout-dependent line endings even though the focused tests pass.

## Reproduction

1. Inspect `scripts/migrate-production.ts`: it takes `pg_advisory_lock`, commits each migration separately, and later calls `pg_advisory_unlock`.
2. Compare the approved pooled Neon `DATABASE_URL` in `missions/deploy-vercel/02-design.md` with PostgreSQL/PgBouncer transaction-pooling semantics: session state is not a cross-transaction correctness boundary.
3. Search backup/restore authority: `infra/backup/create.ps1` and `infra/backup/restore-drill.ps1` both derive schema version from `schema_migrations`, while T3 writes only `production_migration_ledger`.
4. Hash otherwise identical LF and CRLF migration strings with the current raw UTF-8 hash input; the digests differ.

Result: all three divergences are present before a production deployment, while the mocked T3 test cannot expose them.

## Hypotheses

- H1: the session lock becomes ineffective after the first COMMIT through transaction pooling. Confirmed by the use of `pg_advisory_lock` across multiple transactions and the pooled Neon target.
- H2: the new ledger breaks verified backup schema-version discovery. Confirmed because backup and restore query only `schema_migrations`.
- H3: raw-content hashing treats checkout EOL conversion as a migration mutation. Confirmed because SHA-256 inputs differ for LF and CRLF text.

## Root cause

T3 introduced a standalone migration protocol without reusing two existing deployment boundaries: transaction-pooled database lifetime and the canonical `schema_migrations` table consumed by backup/restore. The unit mock modeled neither database session ownership nor backup metadata. Hash input also lacked a repository-independent canonicalization rule.

## Fix attempts (counter)

1. Replaced the cross-transaction session lock with one transaction-scoped lock covering the complete pending batch; reused checksum-aware `schema_migrations`; normalized CRLF/CR to LF before hashing. Result: all targeted regressions passed.

## Regression test

File: `tests/deployment/vercel-hybrid.test.ts`

Description: assert one `BEGIN`/`pg_advisory_xact_lock`/`COMMIT` batch, canonical `schema_migrations` usage, rollback of the whole pending batch, concurrent lock authority at the SQL boundary, mandatory checksum, and LF/CRLF digest equivalence.

Pre-fix result: failing; the current code uses a session lock, a separate ledger, multiple commits, and different digests.

Post-fix result: passing.

## Fix

- `scripts/migrate-production.ts`: one transaction-scoped advisory lock, canonical checksum-aware `schema_migrations`, whole-batch rollback, and canonical SQL hashing/execution.
- `tests/deployment/vercel-hybrid.test.ts`: deterministic protocol, backup compatibility, EOL, rollback, and concurrent authority regressions.

## Wider check

Focused deployment suite 10/10, backup/restore suite 7/7, TypeScript, and diff hygiene all passed. Concurrency is exercised through a deterministic lock-aware injected client because T3's file boundary excludes the shared PostgreSQL test helper.

## Lessons / design implications

Deployment metadata must reuse the schema authority already consumed by recovery tooling. A pooled connection URL is compatible with migration locking only when the correctness lock and all protected statements share one transaction.
