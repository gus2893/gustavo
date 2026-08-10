# Debug: T20 concurrency regression timeout
**Originated during:** mcax-execute T20
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/chats/incremental.test.ts` expected the database-heavy concurrency and cursor-integrity regressions to finish, but fresh-schema setup could exceed Vitest's default five-second test timeout before their assertions.

## Reproduction

1. Start a fresh PostgreSQL test schema and apply every migration.
2. Run eight concurrent imports of one previously unseen external source, or two imports followed by a direct cursor-regression attempt.

Result: the cases could time out at five seconds; the unchanged concurrency case completed in 6.26 seconds under a 20-second ceiling, and the cursor case then exposed its intended product RED (the regression update incorrectly resolved).

## Hypotheses

- H1: a transaction deadlock prevents completion. Refuted because the unchanged test completes under a bounded longer ceiling.
- H2: fresh migration startup plus intentional per-source serialization exceeds the generic unit-test default. Confirmed by the unchanged case passing in 6.26 seconds.

## Root cause

These database-heavy regressions include fresh schema creation plus either eight intentionally serialized transactions or two durable imports and a direct SQL integrity probe. That workload can be longer than Vitest's generic five-second default on the Windows reference runtime.

## Fix attempts (counter)

1. Apply a bounded 20-second timeout only to the two database-heavy regressions: fixed.

## Regression test

File: `tests/chats/incremental.test.ts`
Description: eight concurrent exact imports produce one message version in total, and a direct SQL cursor cannot regress to an older import.
Pre-fix result: timed out at five seconds.
Post-fix result: passes without changing product behavior.

## Fix

The database-heavy test has an explicit 20-second ceiling. Import locking and timing semantics are unchanged.

## Wider check

`pnpm vitest run tests/chats/incremental.test.ts` → all green.
