# Debug: T14 test-double type inference
**Originated during:** mcax-execute T14
**Status:** fixed

## Symptom (one sentence)

Running strict `tsc --noEmit` after the green T14 behavioral slice produced test-only errors because Vitest mocks erased a generic lifecycle return and inferred zero-argument store call tuples.

## Reproduction

1. Run `pnpm exec tsc --noEmit` through the trusted Node 24/pnpm entrypoints after the local-poller tests pass.
2. Observe `TS2322` for the mocked generic `withDatabase<Result>` and `TS2493`/`TS18048` for `store.mock.calls[0][1]`.

Result: typecheck exited 1 while runtime tests passed 7/7.

## Hypotheses

- H1: `vi.fn` cannot preserve the universally quantified `withDatabase<Result>` callback signature. Confirmed by the inferred `Promise<unknown>` in TS2322. Outcome: confirmed.
- H2: zero-argument store mock implementations make Vitest infer an empty argument tuple even though the orchestrator supplies two arguments. Confirmed by TS2493 identifying tuple `[]`. Outcome: confirmed.
- H3: production poller types are inconsistent. Refuted because every diagnostic points to test-double declarations or reads, while the production files emit no diagnostics. Outcome: refuted.

## Root cause

The test doubles were deliberately terse but strict TypeScript derives mock call tuples from their declared implementation signatures. Wrapping the generic database lifecycle in a mock also collapsed its generic result to `unknown`.

## Fix attempts (counter)

1. Keep `withDatabase` as a normal generic function with an explicit cycle counter, give store doubles the actual two-argument signature, and capture the typed persisted value directly: fixed every diagnostic without changing behavior.

## Regression test

File: `tests/market-data/finnhub-poller.test.ts`
Description: existing behavioral assertions still prove two lifecycle calls and exact stored arguments while `tsc --noEmit` verifies the test seam.
Pre-fix result: runtime green; typecheck failed with TS2322, TS2493, TS18048, and related tuple errors.
Post-fix result: strict typecheck passed.

## Fix

Only T14 test-double declarations changed; production behavior and assertions are unchanged.

## Wider check

The local-poller slice, full 70-test poller file, and `tsc --noEmit` all passed.

## Stage B recurrence

The direct-SQL canonical FAILED matrix used a union of readonly tuple literals as a spread into a fixed-arity test helper. Runtime tests passed, but strict TypeScript reported TS2556 at both spreads. The matrix loops now destructure their four typed values and pass them explicitly; no inputs, ordering, SQL, or assertions changed. The focused behavioral matrix remained green and the final strict typecheck exited 0.
