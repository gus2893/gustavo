# Debug: T22 first green
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

`pnpm.cmd vitest run tests/memory/conflicts.test.ts` was expected to pass the first T22 implementation, but one alias test failed with `MEMORY_CONFLICT_INPUT_INVALID` and four PostgreSQL tests failed with `FOR KEY SHARE is not allowed with GROUP BY clause`.

## Reproduction

1. Prepend the pinned Node 24.14.0 and pnpm 11.16.0 runtime directories to `PATH`.
2. Run `pnpm.cmd vitest run tests/memory/conflicts.test.ts`.
3. Observe the pure padded-alias lookup and the first graph persistence authority query.

Result: 7 tests passed and 5 failed; the padded alias failed at `conflicts.ts` input validation, while every persistence path failed at the grouped locking query in `graph.ts`.

## Hypotheses

- H1 (alias): lookup normalization happens after the generic canonical-text guard, so a safely trimmable alias is rejected before normalization. Confirmed by the stack at `resolveMemoryEntityAlias` and the guard's trim-equality condition.
- H2 (alias): temporal alias matching or Unicode normalization is incorrect. Not tested further because H1 identifies the first divergence.
- H1 (SQL): PostgreSQL forbids row-locking clauses on aggregate/grouped queries. Confirmed by the exact server error at the `GROUP BY ... FOR KEY SHARE` authority statement.
- H2 (SQL): the disposable PostgreSQL version lacks row-level locking. Refuted because existing repository tests use `FOR KEY SHARE`; only its combination with grouping is rejected.

## Root cause

The alias entry point reused a canonical stored-text validator even though lookup references intentionally normalize surrounding whitespace. Separately, the memory-authority query attempted to combine deterministic row locking with source aggregation in one PostgreSQL statement, an unsupported query shape.

## Fix attempts (counter)

1. Normalized the alias lookup reference before bounded validation and split authority into an ordered bounded memory-row lock followed by a separate aggregate read: the original five failures cleared; 11/12 tests passed.
2. Corrected the cross-account regression fixture so its alias citations follow the deliberately substituted foreign claim source: this reached the intended database authority boundary; the same combined test then exposed an expectation typo for the established T21 edge-immutability error.
3. Aligned that regression assertion with the existing `IMMUTABLE_RECALL_TRACE` error emitted by the unchanged T21 edge trigger: focused T22 passed 12/12.

## Regression test

File: `tests/memory/conflicts.test.ts`

Description: the pure alias test passes a padded case variant, while all persistence tests exercise the authoritative locking path.

Pre-fix result: failing.

Post-fix result: passing, 12/12.

## Fix

- `lib/server/consolidation/conflicts.ts`: trims a bounded alias lookup reference before canonical alias normalization while retaining strict canonical validation for stored claims and aliases.
- `lib/server/consolidation/graph.ts`: locks the bounded, deterministically ordered memory-record set first, then performs the separate source/actor aggregate authority read.
- `tests/memory/conflicts.test.ts`: routes the cross-account fixture through the intended database boundary and expects the established immutable-edge trigger error.

## Wider check

- Focused T22: 12/12 tests passed.
- Consolidation/recall/T22 slice: 101/101 tests passed.
- Full serialized suite: 28 files and 546/546 tests passed.
- Strict TypeScript, production build, frozen dependency installation, tracked/untracked diff checks, and trailing-whitespace checks exited zero.
- Final process ownership inspection found zero PostgreSQL, `pg_ctl`, or Node processes attached to a `gustavo-postgres-*` fixture directory.
