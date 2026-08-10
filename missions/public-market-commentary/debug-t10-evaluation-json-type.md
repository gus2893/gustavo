# Debug: T10 evaluation event JSON type

**Originated during:** mcax-execute T10
**Status:** fixed

## Symptom (one sentence)

`pnpm exec tsc --noEmit` failed after the focused T10 behavior passed because `HardGates` and `RubricComponents` domain interfaces do not provide the string index signature required by the event ledger's `JsonValue` type.

## Reproduction

Run `pnpm exec tsc --noEmit` under bundled Node 24.14.0 after the first focused T10 green.

Result: TS2322 at the `evaluation.scored` event body in `decision-window.ts`.

## Hypotheses

- H1: the values are valid JSON at runtime but their readonly domain interfaces are not assignable to the ledger's indexed JSON object type. Confirmed by TS2322 naming the missing index signature on `HardGates`.

## Root cause

The event body was assembled directly from strongly typed domain interfaces rather than passed through the module's canonical JSON snapshot boundary, which returns a validated `JsonValue`.

## Fix attempts (counter)

1. Canonicalize and bound the complete evaluation body with `snapshotJson` before appending the event; strict TypeScript and focused tests then passed.

## Regression test

Command: `pnpm exec tsc --noEmit`

Pre-fix result: TS2322.

Post-fix result: `pnpm exec tsc --noEmit` passed and the focused T10 suite passed.

## Fix

`lib/server/orchestration/decision-window.ts` now uses one canonical JSON conversion for the evaluator event payload.

## Wider check

Final focused 4/4 and full 212/212 tests passed; strict TypeScript, the production build, frozen install, diff check, and zero-process audit passed.
