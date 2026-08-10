# Debug: T20 JSON capture type
**Originated during:** mcax-execute T20
**Status:** fixed

## Symptom (one sentence)

`pnpm exec tsc --noEmit` expected a clean T20 typecheck, but `captureJson` returned a runtime-frozen array whose inferred readonly type was not assignable to the repository's mutable-array `JsonValue` alias.

## Reproduction

1. Run `pnpm exec tsc --noEmit` after the focused behavioral test passes.
2. Observe TS2322 at `lib/server/chat-sources/import.ts:113`.

Result: TypeScript rejects `readonly JsonValue[]` as `JsonValue`.

## Hypotheses

- H1: the captured values are not JSON-compatible. Refuted; every element recursively has type `JsonValue`.
- H2: returning the value of `Object.freeze` exposes a readonly-array type that conflicts with the existing alias. Confirmed by constructing the typed mutable array first and freezing it as a separate runtime operation.

## Root cause

`Object.freeze(array)` changes TypeScript's inferred return type to a readonly array, while `JsonValue` defines its array branch as mutable even though callers commonly freeze values at runtime.

## Fix attempts (counter)

1. Construct `JsonValue[]`, freeze it without returning the freeze expression, and return the runtime-frozen typed variable: fixed.

## Regression test

File: `lib/server/chat-sources/import.ts`
Description: the strict project typecheck validates the capture boundary while focused runtime tests retain immutable captured input.
Pre-fix result: TS2322.
Post-fix result: typecheck passes.

## Fix

The array branch now separates its compile-time JSON type from its runtime immutability operation.

## Wider check

`pnpm exec tsc --noEmit` and `pnpm vitest run tests/chats/incremental.test.ts` → all green.
