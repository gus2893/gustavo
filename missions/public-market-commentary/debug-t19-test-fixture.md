# Debug: T19 memory consolidation test fixture
**Originated during:** mcax-execute T19
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/memory/consolidation.test.ts` was expected to exercise the new persistence contract but exited 1 with seven failures led by PostgreSQL's `cannot insert multiple commands into a prepared statement`, an idle-boundary assertion receiving `MEMORY_OBSERVED_BEFORE_SOURCE`, and worker fixtures receiving `MEMORY_SOURCE_NOT_IN_BATCH`.

## Reproduction

1. Run `pnpm vitest run tests/memory/consolidation.test.ts` under Node.js 24 after the first implementation draft.
2. Observe the prepared-statement error at `tests/memory/consolidation.test.ts:44`, the time-order error at line 123, and source-membership errors from `lib/server/consolidation/consolidate.ts:154`.

Result: seven of nine tests failed before the intended database assertions could complete.

## Hypotheses

- H1: the test database uses PostgreSQL's parameterized extended protocol, which cannot execute the fixture's three semicolon-separated inserts. Confirmed by the `pg-pool` error at the first parameterized fixture query; splitting the inserts removed this failure.
- H2: the idle-boundary fixture moved the second event to 11:00 but left `observedAt` at 10:02. Confirmed by comparing the fixture timestamps; moving only that case's observation to 11:01 exposed the intended `EPISODE_SPANS_IDLE_BOUNDARY` result.
- H3: the worker fixture copied sketch source IDs `e1`/`e2` instead of the UUIDs returned by `appendEvent`. Confirmed by comparing `events[].id` with `extracted.*.sourceIds`; remapping every extracted candidate to the stored UUIDs removed `MEMORY_SOURCE_NOT_IN_BATCH`.
- H4: the first disposable PostgreSQL startup plus migrations can exceed Vitest's five-second default on this machine. Confirmed when all later database tests passed while only the first stopped at exactly 5,007 ms; a test-local 20-second allowance removed the infrastructure-only timeout.

## Root cause

The initial T19 test fixture violated three existing harness contracts: parameterized queries contain one statement, extraction references use persisted source IDs, and observation time cannot precede a source. The remaining timeout was the known one-time cost of booting and migrating a disposable local PostgreSQL cluster, not a consolidation deadlock.

## Fix attempts (counter)

1. Split the topology seed into three parameterized queries: prepared-statement symptom fixed.
2. Advance `observedAt` only in the idle-gap case: intended validation assertion fixed.
3. Map extracted source references to persisted UUIDs: worker persistence cases reached their intended assertions.
4. Add a 20-second timeout only to the first database-backed case: startup-sensitive test became stable.

No failed product-code fix attempt occurred, so the three-failed-attempt design escalation threshold was not reached.

## Regression test

File: `tests/memory/consolidation.test.ts`

Description: exercises the same parameterized topology fixture, exact persisted source references, idle-boundary time ordering, and disposable PostgreSQL startup before checking atomic memory persistence.

Pre-fix result: 2 passed / 7 failed, exit 1.

Post-fix result: 9 passed / 0 failed, exit 0.

## Fix

- `tests/memory/consolidation.test.ts`: corrected topology seeding, source-ID mapping, idle-case observation time, and first-database-test timeout.
- `missions/public-market-commentary/03-plan.md`: listed this required MCAX debug artifact in T19's allowed files.

## Wider check

- `pnpm vitest run tests/memory/consolidation.test.ts` -> 9/9 passed, exit 0.
- `pnpm exec tsc --noEmit` -> exit 0.

## Stage A searchable-index fixture follow-up

The first grouped RED for the Stage A follow-up reported four intended contract failures. One assertion also counted both semantic and episodic keyword rows, producing four rows where the test meant to compare the two versioned semantic rows. The query was narrowed to `memory.type='SEMANTIC'`; no product behavior was changed for that fixture correction. The same batch then remained responsible for the intended union-bound, scoped-search-digest, projection-overlap, and pinned-authority regressions.

The later equivalence-link sealing pass initially added the digest to the deterministic identity document but omitted it from the returned `ConsolidatedMemory`. TypeScript reported the missing required property before tests ran. Adding the already-computed field to the returned immutable object fixed the wiring error; the next typecheck and all 26 focused tests passed.

The protected-vector/run-authority pass exposed two further concrete integration boundaries. PostgreSQL located a migration parse error at the unparenthesized `CASE` expression inside a PL/pgSQL `IF`; wrapping the expression fixed migration startup. A proposed cross-native-conversation equivalence fixture then collided with the approved one-account/one-Node/one-continuous-conversation invariant from AC81 and T3. The temporary idea of relaxing those uniqueness constraints was rejected and fully reverted before the full run. T19 proves exact equality across later source events in the continuous native conversation; imported cross-chat fusion remains the separate T20/T21 source-model responsibility and near-exact reconciliation remains later background policy.

## Stage B ingestion/search integration follow-up

The first Stage B implementation run reached 32/35 green cases. Its three failures were stale assertions rather than product defects: the original private persistence count still expected one retained vector row, the older malformed-link assertion still expected the superseded topology error name, and PostgreSQL rejected direct mutation of a generated-always identity before the general immutable-event trigger could run. Updating those assertions to the approved zero-protected-vector, forest-specific, and generated-identity contracts produced 35/35 green.

An early typecheck also reported that a `PUBLIC` comparison was unreachable after `MemoryVectorRankingInput.scope` had already excluded `PUBLIC`. Removing only that redundant runtime branch made the branded helper and its static contract agree; the next typecheck passed.

After the final focused test run, TypeScript exposed a mechanical patch collision: while reverting a premature ranking-interface edit, the identically named `embeddingVersion` line had been removed from `MemoryExtractionVersions` instead. Restoring that established provenance field (while retaining it on the new ranking input) fixed all six downstream type errors without changing behavior.

Final self-review added targeted RED cases for mixed embedding spaces and forged retrieval-key identity. They failed for the intended reasons (vectors from two embedding versions were ranked together and a forged Main key reached deferred completeness). Binding the declared embedding version in SQL and encrypted-body validation, plus validating every protected record against the current canonical retrieval-domain key at insertion, made both targeted cases green. Destruction of a shared retrieval-domain key intentionally starts a new key epoch for future data: old rows retain the erased key UUID/digests, while new rows receive a different UUID/material and cannot collide with the old term tokens.

A final replay-specific RED showed that an exact retry of an old extraction could create or adopt the replacement shared key and return newly keyed, non-persisted memory identities. Existing-run replay now decrypts the already-authorized immutable consolidation body, verifies its count, IDs, topology, digests, versions, and source IDs against durable run records, and returns those exact historical results without using any retrieval key. Only a genuinely new extraction may create the next key epoch.

## Stage B final-review fixture follow-up

The final four-boundary pass produced the intended five-case grouped RED. Its first implementation typecheck exposed only a test-wrapper generic mismatch: the transaction gate erased `EventDatabase.query`'s caller-selected row type. Making that wrapper method explicitly generic preserved the database contract and restored a clean typecheck.

The first focused GREEN attempt then reached 39/41. Both failures were stale assertions: the 100-candidate path correctly used six constant query groups (two topology-authorization queries, one candidate query, and three batched body/key queries), and sequence mutation now reached the established `IMMUTABLE_EVENT` trigger after identity removal. Updating those expectations produced 41/41 focused tests with no product-code retry.
