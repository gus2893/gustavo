# Debug: T17 Redis lifecycle client typing
**Originated during:** mcax-execute T17 review fixes
**Status:** fixed

## Symptom (one sentence)

`pnpm exec tsc --noEmit` rejected assignment of the concrete RESP3 client to `ReturnType<typeof createClient>` at `app/api/feed/stream/route.ts:510`.

## Reproduction

1. Compile the cancellation-owned production subscription under strict TypeScript.
2. Observe TS2322 at the `activeClient = client` assignment.

Result: the generic factory return type permits RESP2 or RESP3, while this call returns a concrete RESP3 client, producing incompatible generic method `this` types.

## Hypotheses

- H1: `ReturnType<typeof createClient>` captures unresolved factory generics rather than this call's concrete type. Confirmed by the diagnostic's `RespVersions` versus literal `3` chain.
- H2: The route needs the full Redis client surface outside the iterator. Refuted because lifecycle cancellation uses only `isOpen` and `destroy()`.

## Root cause

The outer cancellation handle was typed from a generic overloaded factory instead of by the two lifecycle capabilities it owns.

## Fix attempts (counter)

1. Typed the outer handle as `{ readonly isOpen: boolean; destroy(): void }` only: strict compilation passed.

## Regression test

Gate: `pnpm exec tsc --noEmit`
Description: the concrete Redis client satisfies the narrow cancellation handle without generic widening.
Pre-fix result: TS2322, exit 1.
Post-fix result: exit 0.

## Fix

`app/api/feed/stream/route.ts` now types the active Redis lifecycle handle only by `isOpen` and `destroy()`, avoiding factory-generic widening without expanding its authority.

## Wider check

`pnpm vitest run tests/stream/sse-authorization.test.ts` -> 29 passed; `pnpm exec tsc --noEmit` -> exit 0.
