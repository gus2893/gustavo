# Debug: T16 observation decimal lookup
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

After the selected-decision query parsed successfully, `pnpm vitest run tests/challenge/order-lifecycle.test.ts` passed three intent tests but both worker tests rejected the valid `100.00` observation as `PAPER_ORDER_OBSERVATION_INVALID`.

## Reproduction

1. Seed the canonical licensed observation with text price `100.00`.
2. Submit the accepted paper intent.
3. Process it with reference `100.00` and the exact stored observation time.

Result: the worker normalized the validated input to `100`, compared it to `market_observations.price` using text equality, and resolved zero rows.

## Hypotheses

- H1: validated fixed decimals with equal numeric value but different trailing-zero scale fail a text comparison. Confirmed by the `100` versus `100.00` values at the lookup boundary.
- H2: the symbol or timestamp did not match. Refuted because both were copied exactly from the seeded immutable observation and remain unchanged by the fix.

## Root cause

`worker/challenge/process-order.ts` correctly validated the process reference as a decimal but normalized its scale before a text-equality SQL predicate. Fixed-decimal values are numerically canonical for arithmetic, not guaranteed to retain identical textual scale.

## Fix attempts (counter)

1. Compare the already validated reference and stored validated price as PostgreSQL exact numerics: fixed without introducing JavaScript floating-point arithmetic.

## Regression test

File: `tests/challenge/order-lifecycle.test.ts`

Description: both fill and target-close tests process `100.00`/`105.00` canonical observations through the worker lookup.

Pre-fix result: 3/5 passed; both worker paths failed observation resolution.

Post-fix result: the expanded T16 suite passes 9/9.

## Fix

The lookup uses `observation.price::numeric=$2::numeric`, then continues to use the stored observation's immutable price, timestamp, provider, license, and ID for every event and source row.

## Wider check

Commands run after the fix: T15+T16 focused 62/62; expanded T16 focused 9/9; full suite 359/359; type check, Next build, and frozen install all pass.
