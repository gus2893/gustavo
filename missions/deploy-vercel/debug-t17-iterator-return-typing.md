# Debug: T17 iterator-return typing
**Originated during:** mcax-execute T17
**Status:** fixed

## Symptom (one sentence)

`pnpm exec tsc --noEmit` rejected the duration-bounded source at `app/api/feed/stream/route.ts:568` because its async iterator `return()` result was not assignable to `IteratorResult<string>`.

## Reproduction

1. Run strict TypeScript compilation after returning the lifecycle signal with the event-ID source.
2. Observe TS2322 on the frozen lifecycle object.

Result: `done: true` widened to `boolean`, making the inferred `return()` promise incompatible with `AsyncIterable<string>`.

## Hypotheses

- H1: The object literal lacks a contextual `AsyncIterator<string>` type at the nested method, so TypeScript widens the async return object's discriminant. Confirmed by the diagnostic's exact `boolean` versus `false`/`true` mismatch.
- H2: The lifecycle signal changes the event ID value type. Refuted because `next()` remains explicitly typed as `Promise<IteratorResult<string>>`; only `return()` appears in the incompatibility chain.

## Root cause

The nested frozen object is inferred before it is checked against the outer return type. Without an explicit method return type, the async function widens `{ done: true }`, losing the discriminated iterator-result shape.

## Fix attempts (counter)

1. Annotated only `return()` as `Promise<IteratorResult<string>>`: strict compilation passed.

## Regression test

Gate: `pnpm exec tsc --noEmit`
Description: proves the bounded source implements `EventIdSource` under strict TypeScript.
Pre-fix result: TS2322, exit 1.
Post-fix result: exit 0.

## Fix

`app/api/feed/stream/route.ts` explicitly preserves the iterator-result discriminant at the nested `return()` method; runtime control flow is unchanged.

## Wider check

`pnpm vitest run tests/stream/sse-authorization.test.ts` -> 22 passed; `pnpm exec tsc --noEmit` -> exit 0.
