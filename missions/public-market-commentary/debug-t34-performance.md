# Debug: T34 performance calibration

**Originated during:** mcax-execute T34
**Status:** focused fixes verified; projected-million measurement partial

## Symptom (one sentence)

Under pinned Node 24, `pnpm vitest run tests/performance/recall-latency.test.ts --testTimeout=600000` expected four passing tests but returned two failures: authorized operator health returned 503, while the 10,000-row calibration reported false conflict and temporal correctness.

## Reproduction

1. Prepend the bundled Node 24 and fallback pnpm directories to `PATH`.
2. Run `pnpm vitest run tests/performance/recall-latency.test.ts --testTimeout=600000`.

Result: two primitive tests passed; the health assertion received 503 instead of 200, and recall returned `conflictResolvedToCurrent: false` plus `temporalWindowRespected: false`.

## Hypotheses

- H1: The health collector failed because the mock implemented `query` but not its `one` boundary. Confirmed when `machineProfile` called `db.one`; delegating the mock's `one` to the same SQL fixture made the health regression test pass.
- H2: Persisting a supersession link alone marks the prior fixture memory historical. Refuted: the approved recall behavior may return historical/superseded memory after the current answer; the fixture needed an explicit `validTo` and `SUPERSEDED` state.
- H3: Correctness should require all selected memories to be inside the requested time window and exclude every superseded memory. Refuted by the existing recall contract, which permits historical memory for explanation. Correct evidence is that the current answer ranks ahead of an explicitly superseded prior version and only the in-window answer carries the `TIME` channel.

## Root cause

The health test double did not model the full `EventDatabase` read API. Separately, the benchmark's correctness calculation was stricter than Gustavo's approved recall behavior: it treated permitted historical explanation as a conflict/temporal failure instead of inspecting current-before-superseded ordering and per-channel time-window membership.

## Fix attempts (counter)

1. Delegate the health mock's `one` method to its SQL fixture: health boundary test passed.
2. Give the old fixture memory an explicit end time and `SUPERSEDED` state: necessary fixture correction, but the over-strict assertion still failed.
3. Measure current/superseded ordering and `TIME` channel membership: performance calibration test passed.

## Regression test

File: `tests/performance/recall-latency.test.ts`

Description: asserts auth-before-DB health access and known-answer/conflict/temporal/permission correctness over real PostgreSQL recall.

Pre-fix result: two failing tests.

Post-fix result: targeted health and calibration tests passing.

## Fix

- `tests/performance/recall-latency.test.ts`: completed the database test double.
- `tests/performance/seed-million.ts`: encoded the old fact's actual temporal/superseded state.
- `lib/server/observability/metrics.ts`: aligned correctness evidence with the approved historical-recall contract.

## Wider check

- `pnpm vitest run tests/performance/recall-latency.test.ts --testTimeout=600000`: 4 passed.
- Full one-million-event opt-in run: 4 passed in 187.80 seconds.
- The six late failures from a 142-second combined recall/cache run all passed in 21.32 seconds in a fresh targeted process, confirming exhaustion of that older suite's module-level 60-second fixture horizon rather than a T34 regression.
- `pnpm exec tsc --noEmit`, `pnpm build`, and `scripts/validate.ps1`: pass.

## Stage A reopening

Stage A found that the initial query-plan evidence used forced synthetic queries and that most metric series had no production observation boundary. Separate REDs proved all four gaps: real transaction commits did not increment commit latency, cache hit/miss/fallback deltas had no persistence helper, completed model runs did not increment model latency/cost/divergence, and plan evidence did not identify captured recall SQL.

The approved adjacent fix instruments `databaseFromPool` at its actual PostgreSQL `commit`, persists bounded `ScopedCache.metrics()` deltas in the cache worker, records model metrics only after the finalization transaction commits, and explains exact captured `recall-channel` SQL with original parameters under normal planner settings. The focused test then passed 7/7.

## Million-row budget reopening

The first post-review million-row rerun preserved all correctness, authorization, cache,
source-count, and exact normal-planner query-plan evidence, but warm recall p95 regressed
to 325.49 ms against the fixed 250 ms budget. Attempt 1 tested whether a freshly bulk-loaded
schema's incomplete visibility/statistics state caused the variance by vacuuming the event
source and analyzing every captured-plan relation before timing. This improved the empty
embedding estimate from 20,400 rows to 3, but warm p95 worsened to 371.47 ms. The hypothesis
was refuted and the non-beneficial fixture change was removed.

Attempt 2 isolates the measurement harness itself. Query-plan evidence only needs an exact
representative production execution, so one cold recall remains wrapped for SQL/parameter
capture while all warmup and measured recalls use the original production database adapter.
This removes benchmark-only query recording, array copying, and object freezing from the
latency samples without changing recall behavior or the budget.

A temporary cold-query profile confirmed that the eight non-graph candidate queries are
concurrent (34.74--75.82 ms individually), followed by a 13.86 ms graph query and 13.68 ms
trace insert; no single unbounded query explained the full variance. The same 10,000-row
calibration in a fresh targeted process then reported warm p95 189.23 ms. The temporary
profiling hooks were removed; only cold evidence capture remains.

The isolated one-million-event, 200-iteration run confirmed attempt 2: warm recall p50
114.66 ms, p95 128.22 ms, and p99 144.62 ms; cached handoff p95 was 0.1845 ms. It counted
1,000,227 actual source events and retained nine bounded/indexed exact captured plans with
zero permission leaks and zero unbounded queries. The root cause was the measurement harness
copying and freezing every SQL parameter list during every warm sample, not production recall.

A final Stage A operator-health RED showed that fallback/invalidation series were absent from
the authenticated DTO. The first fix exposed the allowlisted process-local registry, and its
targeted calibration was green. Stage B superseded that approach with durable database
aggregates so web/worker separation and restarts do not lose operator-health evidence.

## Stage B observability and projected-scale reopening

Stage B captured independent REDs for seven roots before production edits:

- the health request executed a synthetic transaction and empty freshness/rebuild evidence
  was coerced to zero;
- the million fixture populated `events` but only three real `memory_records`;
- plan classification accepted a descendant `Limit`/unrelated index and ignored sequential
  candidate scans and root `Plan Rows`;
- fallback batches persisted an historical maximum instead of the exact batch maximum;
- registry eviction capped samples but left lifetime sum/max behind;
- 24-hour recall/model percentile sources were row-unbounded and lacked time-leading indexes;
- commit and worker observations were process-local across web/worker restarts.

The fixes persist fixed-bucket commit histograms in migration `0020_observability.sql`, use
bounded time-leading recall/model windows, return `null` for absent verified evidence, keep
cache fallback observations in an exact bounded sequenced window, and derive operator health
from durable database aggregates. Exact captured plans now require a root `Limit`, root
`Plan Rows <= 20`, candidate-relation index access, and no sequential candidate scan above
the fixed threshold. FULL_TEXT's protected digest parameter now matches its `char(64)` index,
and GRAPH has an explicit root limit.

The fully triggered default fixture creates 10,003 actual `memory_records` and 10,043 actual
`events`; all production authority/completeness triggers remain enabled. The focused suite is
14/14 green. A pre-revert run reported warm recall p95 237.80 ms and cached-handoff p95 1.1531 ms,
nine root-limited/indexed exact captured plans, zero unbounded candidate scans, correct known
answer/conflict/temporal results, and zero permission leaks. A final post-revert run reported
warm p95 207.23 ms and cached-handoff p95 0.9557 ms.

### Projected-million limit

Three hypotheses were tested, then fixture redesign stopped per the debug limit:

1. Per-row projection authority triggers dominate the bulk projection. Evidence: five
   projection triggers each perform database lookups for every generated memory; a normal
   fully triggered projected-million attempt exceeded the 603-second process gate before
   measurement. The 10k calibration remains the proof that the generator satisfies them.
2. Host capacity caused the next failure. Confirmed independently: the C:-backed isolated
   PostgreSQL cluster failed in source-event insertion with SQLSTATE 53100,
   `pg_wal/xlogtemp: No space left on device`, at about 1.49 GB free. The stopped disposable
   cluster was moved recoverably to D:, reclaiming about 4.16 GB; no service cluster was
   touched.
3. Incremental secondary-index maintenance dominated projection. Evidence captured from the
   still-isolated D:-backed cluster after timeout showed the active query inserting
   `memory_index_terms`. An isolated bulk-index rebuild experiment completed million source
   seeding but PostgreSQL correctly rejected index creation while deferred completeness
   trigger events were pending (SQLSTATE 55006). That unsuccessful optimization was fully
   removed; delivered fixture behavior retains normal production triggers and indexes.

No fully projected million benchmark reached the 200 measured iterations within the allowed
ten minutes, so its recall budget is unverified. The earlier 1,000,227-event result (warm p95
128.22 ms) is retained only as event-log-scale evidence because it had three projected
memories. Acceptance should remain partial until the unchanged opt-in target completes on a
larger/faster fixture host.
