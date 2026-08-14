# Debug: T22 pending message pagination
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

The maintenance-pending canary was saved under quota-limited status but was not visible on the initial three-event history page after form navigation.

## Reproduction

1. Run the focused story through recovered reply pagination, market polling, stale-heartbeat recovery, and quota-limited status.
2. Send the maintenance-pending canary.
3. Assert it immediately on the initial `/chat` history page.

Result: the locator times out while the snapshot shows `1 queued` and a `Load newer messages` link.

## Hypotheses

- H1: the saved canary is on the production newer-message page because form navigation returns to the initial bounded page. Follow that cursor before asserting the canary.

## Evidence

- The snapshot shows the quota-limited banner and `1 queued`, proving the message persisted and remains durable pending work.
- The initial conversation page contains exactly the first three events and exposes a signed `Load newer messages` cursor.
- All prior restart, market, heartbeat, and quota assertions passed.
- Teardown left zero owned processes and zero ownership registries.

## Root cause

H1 confirmed: the browser assertion ignored the production history pagination boundary after form navigation.

## Fix attempts (counter)

1. Require and follow `Load newer messages` after the pending send, then assert the canary before maintenance.
   Result: the click raced the still-settling form navigation because the same cursor was already visible before send; the server-action navigation then restored `/chat`. The snapshot still proved `1 queued` and zero residue.
2. Synchronize on the user-visible count changing from `0 queued` to exact `1 queued` before following the already-present newer cursor. This preserves the same production UI path and adds no timing sleep.

## Regression test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: the durable pending canary must remain user-visible through the production history cursor before clean maintenance stop.
Pre-fix result: one queued message but no canary on the initial page.
Post-fix result: the count reached exact `1 queued`, the production cursor exposed the canary, and maintenance preserved it pending.

## Fix

The test synchronizes on user-visible queue state before following the existing cursor; product behavior is unchanged.

## Wider check

Full focused Playwright story passed and final residue audit is zero.
