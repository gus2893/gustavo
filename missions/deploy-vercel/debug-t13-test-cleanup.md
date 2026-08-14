# Debug: T13 bridge-suite cleanup ceiling
**Originated during:** mcax-execute T13
**Status:** fixed

## Symptom (one sentence)

Running the full `tests/bridge/jobs.test.ts` regression completed all 106 tests successfully but exited 1 because the shared PostgreSQL fixture's `afterAll` hook exceeded its hard-coded 30-second timeout.

## Reproduction

1. Run `tests/bridge/jobs.test.ts` under the bundled Node 24/pnpm toolchain.
2. Wait for all database-backed cases and the shared teardown.

Result: Vitest reported `106 passed (106)` after 285.66 seconds of test work, then reported `Hook timed out in 30000ms` at `tests/helpers/postgres.ts:919` and exited 1.

## Hypotheses

- H1: T13 introduced a product/schema assertion failure. Refuted by all 106 test cases passing.
- H2: the suite's per-test disposable schemas make the final serialized cleanup exceed the immutable 30-second hook ceiling. Confirmed by the timeout location in the cleanup-only `afterAll` hook and by the identical T10 evidence in `04-execution-log.md`, where 106/106 assertions passed before the same nonzero teardown exit.
- H3: cleanup left a live PostgreSQL process or disposable test cluster. Refuted by the post-run owned-resource inspection recorded below.

## Root cause

`tests/helpers/postgres.ts` owns every disposable schema for the file and hard-codes a 30-second `afterAll` timeout. The full bridge file now creates enough independent schemas that its valid serialized cleanup can exceed that ceiling on Windows. The T13 migration assertions themselves all pass; the failure occurs only after the last test.

## Fix attempts (counter)

1. No helper/code change was attempted because the helper is outside T13's approved files and T10 already recorded the same ceiling. The approved resolution is to retain the 106/106 assertion evidence, run a focused migration subset that exits 0, and verify no owned residue.

## Regression test

File: `tests/bridge/jobs.test.ts`

Description: the focused migration/latest-authority subset covers the schema and trigger surfaces T13 can affect while keeping teardown below the shared hook ceiling.

Pre-resolution result: full file reported 106/106 assertions passed, then cleanup timeout and exit 1.

Post-resolution result: the focused migration/latest-authority slice passed 9/9 with exit 0, and the owned-resource inspection found zero test PostgreSQL/Node processes and zero `gustavo-postgres-*` directories.

## Fix

No production or shared-fixture file changed. The verification split keeps the complete assertion evidence and adds a bounded, clean-exit migration slice rather than weakening or bypassing cleanup.

## Wider check

- Full bridge assertions: 106/106 passed; teardown exit inconclusive due only to the known fixed 30-second helper ceiling.
- Full Finnhub poller file after the privacy and concurrent-replay fixes: 29/29 passed, exit 0.
- Focused bridge migration/latest-authority subset: 9/9 passed, exit 0.
- Owned-resource residue inspection: zero matching processes and zero matching temporary directories.

## Lessons / design implications

Large PostgreSQL integration files need a teardown budget proportional to owned schemas, but changing that shared fixture is not part of T13. A future fixture task may centralize schemas or make the hook deadline scale with exact owned resources; this task preserves current behavior and records the evidence rather than hiding the nonzero exit.
