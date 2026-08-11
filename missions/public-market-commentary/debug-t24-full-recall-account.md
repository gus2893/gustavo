# Debug: T24 full-suite recall account-time fixture

**Originated during:** mcax-execute T24 Stage A re-verification
**Status:** confirmed pre-existing load-sensitive fixture; no production change

## Symptom

The first unchanged serialized Node 24 full suite passed 631 of 632 tests, while
`binds the Node state version to the routed reply despite newer conversation events`
failed with `RECALL_TRACE_ACCOUNT_INVALID`.

## Evidence and hypothesis

- The immediately preceding unchanged recall file passed 50/50.
- The exact failed case passed 1/1 in isolation under Node 24.14.0 in 7.15 seconds.
- `tests/recall/planner.test.ts` captures `NOW` once at module load as wall clock plus
  60 seconds and supplies that value as the later recall trace's `occurredAt`.
- `createConversationFixture` creates the account entitlement with a fresh wall-clock
  `active_from` when the late test begins.
- The authoritative recall trigger requires `entitlement.active_from <= trace.created_at`.
  Under sufficient file/full-suite load, the test can begin after the module-level
  60-second lead has elapsed, making the frozen trace time precede entitlement activation.

This fully explains the exact PostgreSQL rejection without any cache code participating
in the call path. The production trigger is correct and no T24 or recall production file
is changed.

## Controlled checks

1. Node 24 related recall file: 50/50 passed.
2. First Node 24 serialized full suite: 631/632 passed in 826.33 seconds; only the
   load-sensitive account-time fixture failed.
3. Exact failed case under Node 24: 1/1 passed, 49 skipped, in 7.15 seconds.
4. Per the Stage A reviewer direction, rerun the unchanged serialized full suite once
   after this isolated green: 31 files and 632/632 tests passed under Node 24.14.0
   in 824.20 seconds.

## Exact-final self-review run

After the final cache-only pagination, batching, protected-DTO, and freshness-metric
hardening, all non-recall suites completed without a reported failure. The same known
account-time case failed again, and a pre-existing concurrency fixture also observed
that its database erasure had not completed after a fixed 75 ms wall-clock wait. That
assertion aborted before invoking its local `release()` gate, after which the shared
PostgreSQL `afterAll` hook timed out and left one disposable test server running.

- The exact erasure-concurrency case passed 1/1 in isolation under Node 24.14.0 in
  7.14 seconds.
- The exact account-time case remained green 1/1 in isolation as recorded above.
- The complete recall file then passed 50/50 on the exact final code under Node 24.14.0
  in 84.57 seconds.
- The one identified orphan at
  `C:\Users\gusta\AppData\Local\Temp\gustavo-postgres-Kr6ttk` was stopped cleanly
  with that server's PostgreSQL 17 `pg_ctl`; no unrelated process was touched.
- Neither failing call path imports or executes a T24 cache module. No production or
  recall fixture change was made.

After the final migration-only crash-reclaim relaxation, the exact post-edit Node 24
full suite again passed all 30 non-recall files and 631 of 632 tests in 831.69 seconds;
the sole failure was the same account-time fixture. That exact case then passed 1/1
on the final schema in 7.13 seconds. No cleanup timeout or orphan process occurred.

## Stage A exact-loader correction recheck

The final Stage A exact-entity loader and continuous-worker correction again reproduced
only this documented fixture in the unchanged recall file under Node 24.14.0: 49/50
passed in 84.93 seconds, and the required unchanged rerun again passed 49/50 in 84.79
seconds with the same `RECALL_TRACE_ACCOUNT_INVALID` at the same test. The exact test
passed 1/1 in isolation in 6.98 seconds. The repeated file duration exceeds the frozen
60-second module-time lead, while the isolated run does not, further confirming the
existing fixture diagnosis. No cache, recall production, or recall test file was changed.

The exact-final Node 24.14.0 full run on the completed Stage A tree passed all 30
non-recall files and 635 of 636 tests in 827.81 seconds. Its sole failure was again
this same account-time case. The case then passed 1/1 on the exact final tree in
6.82 seconds (49 skipped). No cleanup failure or product red was observed.

After the per-record numeric rebuild high-water correction, the exact-final Node
24.14.0 full run passed all 30 non-recall files and 636 of 637 tests in 827.57
seconds. Its only failure was the same account-time fixture, which immediately
passed 1/1 in isolation on that final tree in 7.23 seconds (49 skipped). No cache
or recall product code participated in the failing path.
