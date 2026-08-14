# Debug: T17 abort-listener typing
**Originated during:** mcax-execute T17
**Status:** fixed

## Symptom (one sentence)

`pnpm exec tsc --noEmit` failed at `app/api/feed/stream/route.ts:440` with TS2322, `Type 'void' is not assignable to type 'undefined'`.

## Reproduction

1. Run strict TypeScript compilation with trusted Node 24 and pnpm 11.
2. Observe assignment to `removeListener` in `waitForAbort`.

Result: exit 1 with TS2322 at line 440.

## Hypotheses

- H1: The initializer `() => undefined` inferred `removeListener` as `() => undefined`, which is narrower than the subsequently assigned DOM cleanup closure's `() => void`. Confirmed by the compiler location and by the working explicit `() => void` pattern in `lib/server/stream/events.ts:131`.
- H2: `AbortSignal.removeEventListener` has an incompatible listener parameter type. Refuted because the error names only the closure return type, not its parameter.

## Root cause

Type inference fixed the local variable's return type to `undefined`. The later closure returns the declared `void` result of `removeEventListener`, so strict TypeScript correctly rejects the assignment even though both closures are valid cleanup callbacks at runtime.

## Fix attempts (counter)

1. Explicitly typed the cleanup callback as `() => void`, matching the established stream helper: strict compilation passed.

## Regression test

Gate: `pnpm exec tsc --noEmit`
Description: compiles the abort helper under the repository's strict TypeScript configuration.
Pre-fix result: TS2322, exit 1.
Post-fix result: exit 0.

## Fix

`app/api/feed/stream/route.ts` gives the listener-cleanup closure the established `() => void` type; runtime control flow is unchanged.

## Wider check

`pnpm vitest run tests/stream/sse-authorization.test.ts` -> 22 passed; `pnpm exec tsc --noEmit` -> exit 0.
