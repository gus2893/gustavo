# Debug: T16 short-financing notional precision
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

The focused T16 lifecycle suite expected one day of short financing but `processPaperOrder` threw `COST_SHORT_NOTIONAL_INVALID` before recording it.

## Reproduction

1. Create the canonical cost-adjusted AAPL short with a 99.90 entry fill and 8.51851851 shares.
2. Process a fresh completed observation on the following UTC day.

Result: the worker derived `850.999999149` as short notional and passed it to the T13 calculator, whose input contract permits at most eight fractional digits.

## Hypotheses

- H1: the persisted fill price or quantity was missing or negative. Refuted by the opening-fill path and the accepted positive cost-adjusted quantity.
- H2: multiplying two valid eight-decimal inputs created a value outside the T13 decimal boundary. Confirmed: `99.90 * 8.51851851 = 850.999999149`, which has nine fractional digits.

## Root cause

`worker/challenge/process-order.ts` derived the short notional but did not quantize the product before calling `calculateShortBorrow`. Each operand satisfied the source contract, while their product did not satisfy the downstream eight-decimal input contract.

## Fix attempts (counter)

1. Quantize the derived notional deterministically to eight decimal places with half-up rounding at the T13 call boundary: fixed the invalid-input failure.

## Regression test

File: `tests/challenge/order-lifecycle.test.ts`

Description: a cost-adjusted short rolls over exactly one UTC day, records one financing row, and an exact retry records no duplicate. The expected borrow is $0.12 for the cost-adjusted notional.

Pre-fix result: `COST_SHORT_NOTIONAL_INVALID`.

Post-fix result: the T16 suite records one $0.12 financing row and passes 13/13.

## Fix

The worker now rounds the derived short notional to the same eight-decimal boundary enforced by the immutable T13 cost contract before calculating borrow.

## Wider check

Commands run after the fix: T16 focused 13/13; T15+T16 focused 70/70; full suite 363/363; type-check, Next production build, and frozen install all pass.
