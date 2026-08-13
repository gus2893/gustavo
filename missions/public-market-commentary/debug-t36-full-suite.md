# Debug: T36 full-suite PostgreSQL failures
**Originated during:** mcax-execute T36
**Status:** fixed

## Symptom (one sentence)

With bundled Node 24, `pnpm test` ran for 270.9 seconds instead of exiting zero and reported widespread database-related failures, including 24 of 51 privacy tests and 34 of 44 memory-conflict tests, with PostgreSQL client/socket errors.

## Reproduction

1. Ran `pnpm vitest run tests/privacy/forget-propagation.test.ts --reporter=verbose` unchanged with bundled Node 24.
2. The first database fixture failed at `tests/helpers/postgres.ts:422` with PostgreSQL code `53100`: `could not extend file "base/5/16930": No space left on device`.
3. C: had 44,818,432 bytes (42.74 MiB) free. `%TEMP%` contained 34 exact direct children matching `gustavo-postgres-[A-Za-z0-9]{6}`, totaling about 4 GiB. None of their `postmaster.pid` values identified a live process; the three live PostgreSQL roots were service processes parented by `pg_ctl`, not these test directories.
4. Moved the 34 validated inactive directories recoverably to `D:\gustavo-test-fixture-cleanup-20260812-final`, reclaiming 4,092.33 MiB and leaving zero matching directories in `%TEMP%`.
5. Re-ran the identical unchanged privacy command.

Result: before cleanup, 45 failed and 6 passed in 8.99 seconds, all database-backed failures reporting disk exhaustion; after cleanup, all 51 passed in 124.86 seconds.

## Hypotheses

- H1: Accumulated stale disposable PostgreSQL clusters exhausted C: and prevented active fixtures from extending database files. Confirmed by exact PostgreSQL `53100`, 42.74 MiB free space, 34 inactive matching clusters, and the identical test becoming green only after their recoverable move. Outcome: confirmed.
- H2: A product migration or database behavior regression independently breaks the privacy operations. The identical file passed 51/51 after restoring disk space with no source change. Outcome: refuted.
- H3: The full-suite command used a different Node/PostgreSQL runtime or inherited connection configuration. The same bundled Node 24 command reproduced and then cleared the symptom solely with free-space recovery. Outcome: refuted.

## Root cause

The host volume was exhausted by 34 stale disposable test clusters under `%TEMP%`. The active fixture failed when PostgreSQL attempted to extend relation files, before the product behavior under test could execute. `tests/helpers/postgres.ts:919` normally stops and removes its cluster in `afterAll`, but abrupt or timed-out historical Vitest termination can bypass that in-process hook and leave its directory behind. This was host test-resource exhaustion, not a T36 product or migration regression.

## Fix attempts (counter)

None; no source fix was attempted.

## Regression test

File: `tests/privacy/forget-propagation.test.ts` (unchanged)
Description: exercises all 51 privacy cases against a disposable PostgreSQL cluster.
Pre-recovery result: 45 failed with PostgreSQL `53100`.
Post-recovery result: 51 passed.

## Fix

No code change. The exact validated inactive test directories were moved, not deleted, to `D:\gustavo-test-fixture-cleanup-20260812-final`.

## Wider check

`pnpm vitest run tests/privacy/forget-propagation.test.ts --reporter=verbose` with bundled Node 24 -> 51/51 green. Root owns the final full-suite rerun.

### Completed full-suite follow-up

Root's next full suite completed 41 files with 800 passing and 7 failures. The failures separated into three independent causes:

1. Five late `tests/recall/planner.test.ts` cases returned one `MEMORY_OBSERVED_BEFORE_SOURCE` and four `RECALL_TRACE_ACCOUNT_INVALID` errors. These are the previously documented module-level frozen-`NOW` fixtures from `debug-t24-related-recall-time.md`: after long load, their 60-second lead expires while fresh source and entitlement timestamps continue advancing. Running the exact five names together in a fresh process passed 5/5 in 17.53 seconds with no source change. No product or recall edit was made.
2. `tests/security/static-boundaries.test.ts` read stale build output. A fresh bundled-Node-24 `pnpm build` passed, and the unchanged validator then passed 11/11 in 39.51 seconds. No validator or production-boundary edit was required.
3. `tests/repository/product-policy.test.ts` exposed a real policy regression: `app/page.tsx` no longer rendered the exact mandatory `SIMULATION ONLY — NOT A REAL TRADE` label required by the approved design and public safety contract. The existing test was RED 1/2; adding only the visible exact label made it GREEN 2/2. TypeScript and the production build also passed.

The five exact recall cases were:

- `rechecks a proposal created and revoked after the initial authority scan`
- `persists typed zero-memory context influences and exact body/candidate authority`
- `separates every behavior-changing cache key and never reports an unused hit`
- `refuses a protected consolidation body unless one current proposal covers every sibling memory`
- `binds the Node state version to the routed reply despite newer conversation events`

## Lessons / design implications

The helper's normal `afterAll` cleanup cannot run after forced process termination. Durable ownership and next-run stale-resource recovery would prevent recurrence, but that is a separate test-infrastructure improvement rather than a T36 product fix.
