# Debug: T14 late market-window recovery
**Originated during:** mcax-execute T14
**Status:** fixed

## Symptom (one sentence)

A durable PENDING poll window recovered after its five-minute interval must become FAILED without another provider call, but migration 0022 makes that terminal transition impossible once database time reaches the window end.

## Reproduction

1. Reserve an aligned window ten minutes before database-now, leaving its row PENDING as a crash would.
2. Run the T14 reconnect recovery path, which does not call the provider and attempts to store a FAILED summary.
3. Observe PostgreSQL reject the update because the trigger supplies a late `completed_at` that violates the table check.

Result: deterministic selected test fails rather than resolving to the required FAILED recovery summary.

## Hypotheses

- H1: T14 can supply an in-window recovery timestamp. Refuted: the trigger overwrites every non-PENDING `completed_at` with `clock_timestamp()` at `db/migrations/0022_hybrid_deployment.sql:597-603`.
- H2: the table permits late FAILED recovery. Refuted: `db/migrations/0022_hybrid_deployment.sql:550-554` requires every non-null `completed_at` to be earlier than `window_started_at + 5 minutes`.
- H3: a worker-only retry or alternate update can satisfy both authorities. Refuted: both constraints are database-owned and T14's allowed TypeScript files cannot change them.

## Root cause

Migration 0022 applies the completion-within-window bound to both successful and failed windows. That is correct for COMPLETED provider work, but it conflicts with the approved startup/reconnect recovery of a durable PENDING row after a local outage.

## Fix attempts (counter)

No production fix attempted. The conflicting database authorities make a worker-only change invalid; execution paused for prompt-update before patching around the design.

## Regression test

File: `tests/market-data/finnhub-poller.test.ts`
Description: reserve a window ten minutes in the past, recover it without calling the provider, and require one durable FAILED/PROVIDER_ERROR summary with no latest mutation.
Pre-fix result: failing at the database terminal-time check.
Post-fix result: passing after approved prompt update `802440d` and the bounded migration change.

## Recommended minimal semantics

- Keep COMPLETED windows bounded to `[window_started_at, window_started_at + 5 minutes)`.
- Permit a PENDING-to-FAILED recovery transition at database-now while `completed_at < prune_after`; retain the seven-day bound and immutable terminal state.
- Preserve monotonic calls/results, exact safe-code requirements, one reservation/quota charge, no second provider poll, and no latest-row mutation for recovered incomplete windows.
- A recovery after `prune_after` should not repoll the historical window; cleanup/skip it through the existing bounded-retention authority.

## Fix

`db/migrations/0022_hybrid_deployment.sql` retains the five-minute bound for COMPLETED, permits database-timed FAILED only before `prune_after`, and turns an exactly-at-boundary failed update into a no-op for cleanup. `worker/hybrid/market-poller.ts` deletes expired PENDING rows without re-polling or reserving quota and handles the reserve/store boundary race as SKIPPED.

## Wider check

Retained recovery, already-expired cleanup, and prune-expiry between transactions passed 3/3. A late COMPLETED transition still fails, recovered FAILED is immutable, the full poller file passed 70/70, the prior migration lifecycle regression passed 1/1, and strict typecheck passed.

## Stage A follow-up: database-clock reservation authority

### Symptom

A duplicate wake for the active database window treated its PENDING reservation as a crash and terminalized the row while the first provider poll was still running; independently, absent past or future caller-supplied windows could reserve quota and start provider work.

### Reproduction and RED

1. Hold the first current-window provider call on a promise after its short reservation transaction commits, then run a second wake for the same ID.
2. Observe the second wake return a FAILED recovery, invoke its store, and prevent the released first wake from completing.
3. Supply absent IDs for the database clock's immediately prior and next five-minute buckets.
4. Observe the prior ID reserve quota and reach persistence instead of returning SKIPPED.

Selected pre-fix result: 2 failed / 70 skipped. The concurrent result was FAILED rather than SKIPPED, and the prior absent bucket reached PostgreSQL's `market_poll_windows_check3` after invalid provider/store work.

### Hypotheses and root cause

- H1: advisory locking was missing. Refuted: each short reservation already held a per-window transaction advisory lock, but no authority survived across provider work.
- H2: reservation state did not distinguish an active current bucket from a recoverable prior bucket. Confirmed: every PENDING row returned RECOVER.
- H3: caller alignment was sufficient reservation authority. Refuted: alignment proves only five-minute syntax, not equality with the database's current bucket; absent aligned past/future IDs were accepted.

The root cause was missing database-clock classification inside `reserveMarketPollWindow`: PENDING was treated as recoverable regardless of age, and the absent-row path charged quota without comparing the requested bucket with database-now.

### Fix and regression tests

`worker/hybrid/market-poller.ts` now snapshots database-now and its exact five-minute bucket in SQL after acquiring the advisory lock. An existing unexpired PENDING row is RECOVER only when its window is strictly prior; current or future is SKIP. An absent row must equal the database bucket before quota or insertion.

`tests/market-data/finnhub-poller.test.ts` adds a promise-gated concurrent duplicate regression and an independent database-clock past/current/future matrix. Post-fix focused result: 3 passed / 69 skipped, including current PENDING active behavior. Wider checks are rerun below before handoff.

### Follow-up wider check

Retained recovery and the two prune paths passed 3/3, the prior migration terminal/quota regression passed 1/1, and the complete Finnhub poller file passed 72/72. Strict typecheck and diff hygiene both exited 0.

## Stage B follow-up: quota-lock bucket rollover

### Symptom and RED

Reservation classified the requested ID against database time before a potentially blocking quota upsert. A transaction barrier held the FINNHUB quota row while the DB-owned five-minute bucket advanced; after release, the old bucket still committed quota/window state and started provider/store work.

Pre-fix selected result: the boundary regression returned FAILED/RESULT_COUNT_INVALID instead of SKIPPED, and its provider and store were called. The same run committed 96 quota calls and a terminal old-window row.

### Hypotheses and root cause

- H1: the per-window advisory lock serialized the blocking resource. Refuted: it serializes competing reservations for the same window ID, not the daily quota row.
- H2: the initial database clock snapshot remained authoritative after the quota wait. Refuted: `clock_timestamp()` was read before the blocking upsert and never revalidated.
- H3: a post-quota recheck without rollback was sufficient. Refuted: a successful upsert already changes durable quota, and the quota trigger prohibits decrement compensation.

The root cause was a time-of-check/time-of-use gap across the last blocking reservation operation, combined with no rollback boundary around the provisional quota charge.

### Fix and regression test

Migration 0022 defines `market_poll_reservation_now()` as a DB-owned `clock_timestamp()` authority. The isolated test schema replaces only that owner-controlled function to deterministically advance the database clock across a real quota-row lock; runtime inputs cannot supply time.

`reserveMarketPollWindow` creates a savepoint before quota, re-snapshots the DB bucket after the upsert returns, and rolls back/releases that savepoint when the requested window is no longer current. The path returns SKIP with zero committed quota, window, provider, store, heartbeat, or latest mutation.

Post-fix focused result: boundary regression passed. The complete Finnhub poller file passed 74/74, the migration lifecycle regression passed 1/1, and strict typecheck/diff hygiene exited 0.
