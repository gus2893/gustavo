# Debug: T15 stop-budget test typing
**Originated during:** mcax-execute T15 Stage A final review
**Status:** fixed

## Symptom (one sentence)

After the admission/deadline behavior passed 19 focused tests, trusted `tsc --noEmit` returned `tests/infra/hybrid-worker.test.ts(443,53): error TS2493: Tuple type '[]' of length '0' has no element at index '0'.`

## Reproduction

1. Define the stop mock as `vi.fn(async () => ...)`.
2. Assert that its first call received the remaining deadline budget.
3. Run trusted `tsc --noEmit`.

Result: Vitest inferred a zero-argument call tuple, so TypeScript rejects index zero even though the runtime test receives the argument.

## Hypotheses

- H1: The mock's zero-parameter callback determines an empty call tuple. Confirmed by the TS2493 tuple type and the callback declaration.
- H2: The production control callback still invokes requestStop without a budget. Refuted because all 19 runtime tests pass and the implementation supplies `remainingMs`.

## Root cause

The test mock omitted the callback parameter that the assertion later inspects, producing an overly narrow zero-argument Vitest mock type.

## Fix attempts (counter)

1. Typed only the mock callback parameter as `remainingMs: number` while intentionally not using it in the callback body: fixed.

## Regression test

File: `tests/infra/hybrid-worker.test.ts`
Description: repository TypeScript compilation validates the stop-budget mock call tuple.
Pre-fix result: TS2493 at line 443.
Post-fix result: passing.

## Fix

`tests/infra/hybrid-worker.test.ts` now declares the mock's unused `_remainingMs: number` parameter, matching the production callback contract and making its call tuple inspectable.

## Wider check

Trusted `tsc --noEmit`, focused hybrid-worker tests (19/19), and related T6/T7/T14 tests (160 passed, 3 skipped) are green.
