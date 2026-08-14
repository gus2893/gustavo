# Debug: T14 Vitest asymmetric length matcher
**Originated during:** mcax-execute T14
**Status:** fixed

## Symptom (one sentence)

Running the focused T14 test expected the newly implemented poller assertion to pass, but Vitest 4.1.10 stopped at `TypeError: expect.toHaveLength is not a function` before comparing the stored window.

## Reproduction

1. Run `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "opens Neon only after all provider calls and persists one complete bounded window"` through the trusted Node 24/pnpm entrypoints.
2. Observe the assertion at `tests/market-data/finnhub-poller.test.ts` fail while constructing `expect.objectContaining`.

Result: one selected test failed because `expect.toHaveLength` is not an asymmetric matcher.

## Hypotheses

- H1: Vitest supports `toHaveLength` only as a normal matcher, not as `expect.toHaveLength`. Confirmed by the exact TypeError and by repository examples that use only `expect(value).toHaveLength(95)`. Outcome: confirmed.
- H2: The stored window had the wrong number of items. Refuted because the exception occurred while constructing the matcher, before `store` arguments were compared. Outcome: refuted.

## Root cause

The new test used a Jest-style asymmetric shape that is not part of the installed Vitest API. The repository's working pattern is a separate ordinary `expect(value).toHaveLength(...)` assertion.

## Fix attempts (counter)

1. Remove only the unsupported asymmetric matcher and assert the captured stored `items` array length separately: fixed the focused failure.

## Regression test

File: `tests/market-data/finnhub-poller.test.ts`
Description: the exact T14 selected test still asserts 95 stored items while using Vitest's supported ordinary matcher form.
Pre-fix result: failing with `TypeError: expect.toHaveLength is not a function`.
Post-fix result: passing 1/1.

## Fix

`tests/market-data/finnhub-poller.test.ts` keeps the object-shape assertion and moves the two array-length checks to ordinary `expect(array).toHaveLength(95)` calls.

## Wider check

The exact T14 test passed 1/1 and the full poller file passed 70/70; strict typecheck also passed.
