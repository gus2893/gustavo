# Debug: T24 related recall frozen-time fixtures

**Originated during:** mcax-execute T24 Stage B re-verification
**Status:** confirmed pre-existing load-sensitive fixtures; no production or recall change

## Symptom

The Node 24 related suite can fail late tests in `tests/recall/planner.test.ts` after
the file's module-level `NOW` fixture has aged beyond its fixed 60-second lead. The
latest exact-final related run passed 47 of 50 tests in 93.75 seconds and reproduced:

- `separates every behavior-changing cache key and never reports an unused hit`
  failed with `RECALL_TRACE_ACCOUNT_INVALID`;
- `refuses a protected consolidation body unless one current proposal covers every sibling memory`
  failed with `MEMORY_OBSERVED_BEFORE_SOURCE`;
- `binds the Node state version to the routed reply despite newer conversation events`
  failed with `RECALL_TRACE_ACCOUNT_INVALID`.

## Root cause evidence

`tests/recall/planner.test.ts` captures `NOW` once at module import as
`new Date(Date.now() + 60_000).toISOString()`. The first failing test later creates
source messages with fresh wall-clock timestamps but passes frozen `NOW` as the
consolidation `observedAt`; after 60 seconds, the authoritative consolidation guard
correctly rejects observation before source. The second creates a fresh account and
entitlement but persists a trace at frozen `NOW`; the authoritative trace guard
correctly rejects a trace time before entitlement activation.

None of the failing call paths imports or executes a T24 cache module. The database
guards are behaving correctly; the module-time test fixture is load-sensitive.

## Commands and exact evidence

1. Related suite under Node 24.14.0:

   `pnpm.cmd vitest run tests/events/event-store.test.ts tests/broadcasts tests/challenge tests/handoffs/privacy.test.ts tests/recall/planner.test.ts --reporter=dot`

   Result: 12 files, 327 passed and 2 failed in 412.30 seconds. The two failures were
   exactly the errors listed above.

2. Exact consolidation case:

   `pnpm.cmd vitest run tests/recall/planner.test.ts -t "refuses a protected consolidation body unless one current proposal covers every sibling memory" --reporter=verbose`

   Result: 1 passed, 49 skipped, in 7.75 seconds.

3. Exact account/Node-state case:

   `pnpm.cmd vitest run tests/recall/planner.test.ts -t "binds the Node state version to the routed reply despite newer conversation events" --reporter=dot`

   Result: 1 passed, 49 skipped, in 7.57 seconds.

4. Unchanged recall file:

   `pnpm.cmd vitest run tests/recall/planner.test.ts --reporter=dot`

   Result: 48 passed and the same 2 frozen-time cases failed in 89.20 seconds. The
   file duration exceeds the fixed 60-second lead and reproduces both guards exactly.

5. Exact-final Stage B unchanged recall file under Node 24.14.0:

   `pnpm.cmd vitest run tests/recall/planner.test.ts --reporter=dot`

   Result: 47 passed and the three late cases listed above failed in 93.75 seconds.
   The additional cache-key test persisted a trace with the same frozen `NOW` and
   failed the same entitlement activation guard.

6. All three exact cases together on the same tree:

   `pnpm.cmd vitest run tests/recall/planner.test.ts -t "separates every behavior-changing cache key|refuses a protected consolidation body unless one current proposal covers every sibling memory|binds the Node state version to the routed reply despite newer conversation events" --reporter=verbose`

   Result: 3 passed, 47 skipped, in 12.32 seconds. Fresh module time keeps every
   fixture ahead of its authoritative source and entitlement timestamps.

## Resolution

No production, recall, consolidation, or test fixture was changed. T24 verification
records these as pre-existing time-fixture failures and requires exact isolated greens
plus the final full-suite result before handoff.

## Exact-final full-suite evidence

The exact-final Node 24.14.0 full run on the completed Stage B tree passed all 30
non-recall files and 640 of 641 tests in 891.52 seconds. Its sole failure was the
already documented `binds the Node state version to the routed reply despite newer
conversation events` case with `RECALL_TRACE_ACCOUNT_INVALID`; the sibling
consolidation case passed in this run. The exact failed account/Node-state case then
passed 1/1 on the same final tree in 7.47 seconds (49 skipped). No cache module or T24
production path participated in the failure.

After the commit-order staging and stable-provenance corrections, the correctly
pinned Node 24.14.0 full run passed all 30 non-recall files and 642 of 644 tests in
915.28 seconds. Its only failures were the documented consolidation and
account/Node-state cases. Both exact cases then passed together 2/2 on the same final
tree in 9.90 seconds (48 skipped). No T24 cache path participated in either failure.

After the canonical-topic filter and metric-rollup corrections, the first unchanged
full run reached its 20-minute outer ceiling only after the disposable recall server
started around minute 19; PostgreSQL showed no blocked client or product query. The
authorized correctly pinned Node 24.14.0 rerun under a 30-minute ceiling completed all
30 non-recall files and passed 637 of 646 tests in 1,319.97 seconds. All nine failures
were late recall cases using the same frozen module-level `NOW`: five entitlement-time
guards returned `RECALL_TRACE_ACCOUNT_INVALID`, and four consolidation guards returned
`MEMORY_OBSERVED_BEFORE_SOURCE`. All nine exact cases then passed together 9/9 on the
same final tree in 24.47 seconds (41 skipped). No T24 cache path participated.
