# Debug: T22 Stage B materializer context type
**Originated during:** mcax-execute T22 Stage B materializer positive proof
**Status:** fixed

## Symptom (one sentence)

TypeScript rejected the test-owned role-bound database wrapper because its inferred forwarding methods were not generic enough to implement `EventDatabase`.

## Reproduction

Run trusted Node 24/pnpm `tsc --noEmit` after adding the distinct-login materializer context.

Result: exit 1 in 2.4 seconds with TS2322 plus implicit-parameter TS7006 errors at the wrapper's `query` and `one` methods.

## Root cause

Contextual typing did not preserve `EventDatabase`'s generic row parameter through the frozen object literal, so both methods inferred `Record<string, unknown>` rather than the caller-selected row subtype.

## Fix

Spell the existing forwarding methods with the exact generic row constraint and explicit SQL/parameter types. No runtime behavior changes.

## Regression test

Rerun trusted Node 24/pnpm `tsc --noEmit` before continuing the focused story.
