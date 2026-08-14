# Debug: T22 recovered reply pagination
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

After restart recovery completed two Node jobs, the browser's initial history page contained only one identical fixture reply and exposed a `Load newer messages` cursor.

## Reproduction

1. Run the trusted focused Playwright spec through offline send and second-child recovery.
2. Wait until both Node jobs are `COMPLETED` and reload chat.
3. Count `Node private fixture reply` on the initial history page.

Result: one reply is visible and Playwright's snapshot exposes the production `Load newer messages` link.

## Hypotheses

- H1: the recovered reply is on the next user-visible history page, not missing. Follow the production cursor and assert the reply and its Node Brain attribution there.

## Evidence

- The database wait observed exactly two Node jobs and both were `COMPLETED` before reload.
- The snapshot shows the first user/reply, the offline user message, `0 queued`, and a `Load newer messages` link with a signed `after` cursor beginning after the offline event.
- Teardown left zero owned processes and zero ownership registries.

## Root cause

H1 confirmed from the production history cursor: the test assumed two identical replies would be rendered on one page.

## Fix attempts (counter)

1. Require and follow `Load newer messages`, then assert the recovered reply and its `Node Brain` attribution on the newer history page.

## Regression test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: restart recovery must expose the second reply through the production history pagination UI with exact attribution.
Pre-fix result: one reply on the initial page and an unconsumed newer cursor.
Post-fix result: the newer page displayed the recovered fixture reply with exact `Node Brain` attribution.

## Fix

The browser test follows the existing signed production cursor; product pagination is unchanged.

## Wider check

Full focused Playwright story passed and final residue audit is zero.
