# Debug: T16 exit-fee result join
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

After a target close committed successfully, the concurrent retry loaded two closure-result rows and failed with `PAPER_ORDER_EXIT_STREAM_INVALID` instead of returning the original result.

## Reproduction

1. Fill an order, creating its ENTRY commission.
2. Close it at target, creating its EXIT commission.
3. Let the serialized concurrent retry hydrate the terminal result.

Result: the closure query returned one row joined to ENTRY and another joined to EXIT.

## Hypotheses

- H1: two immutable closure rows were appended. Refuted by the source constraints and the focused assertion; only one closure exists.
- H2: the fee join admitted both phase rows because the EXIT predicate was placed only on a later left join. Confirmed by query inspection and the one-row result after moving the predicate to the fee join itself.

## Root cause

`worker/challenge/process-order.ts` first left-joined every position fee, then left-joined fee events with an EXIT predicate. A non-EXIT fee remained in the result with a null event, multiplying the one closure row.

## Fix attempts (counter)

1. Constrain `challenge_fees` itself with an exact immutable EXIT event `exists` predicate: fixed result hydration.

## Regression test

File: `tests/challenge/order-lifecycle.test.ts`

Description: the target test creates both ENTRY and EXIT fees and processes the target concurrently twice; the retry must equal the first terminal result and one closure must exist.

Pre-fix result: concurrent retry failed with `PAPER_ORDER_EXIT_STREAM_INVALID`.

Post-fix result: both concurrent target calls return the same terminal result; the expanded T16 suite passes 9/9.

## Fix

The result query now joins only the fee whose immutable source event has `phase='EXIT'`.

## Wider check

Commands run after the fix: T15+T16 focused 62/62; expanded T16 focused 9/9; full suite 359/359; type check, Next build, and frozen install all pass.
