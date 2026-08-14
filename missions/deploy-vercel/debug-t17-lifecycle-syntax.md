# Debug: T17 lifecycle-return syntax
**Originated during:** mcax-execute T17
**Status:** fixed

## Symptom (one sentence)

The focused cancellation regression could not collect tests because `app/api/feed/stream/route.ts` failed to parse at line 367 after the lifecycle-return edit.

## Reproduction

1. Run the focused cancellation regression.
2. Observe Vite/OXC report `Identifier expected` at the `const abort` declaration.

Result: zero tests collected and a route parse error.

## Hypotheses

- H1: A context-light punctuation patch changed the first matching `};` instead of the intended async-iterator method delimiter. Confirmed: `wakeReader` ends with `},` at line 366, while the intended object method still ends with `};` at line 593.
- H2: The new frozen lifecycle return has mismatched object nesting beyond those two tokens. Refuted by matching the surrounding `eventIds` object and `Object.freeze` delimiters after locating the two edits.

## Root cause

The one-token patch did not include structural context, so `apply_patch` matched an earlier identical token. This corrupted a local function declaration and left the actual object-method delimiter unchanged.

## Fix attempts (counter)

1. Restored exactly `wakeReader` to `};` and the `[Symbol.asyncIterator]` method to `},` using structural context: test collection and the cancellation regression passed.

## Regression test

File: `tests/stream/sse-authorization.test.ts`
Description: cancellation during a protected body load closes without emitting the protected event.
Pre-fix result: the intended functional RED was observed before the lifecycle edit; after the edit, collection was blocked by the parse failure.
Post-fix result: one selected cancellation test passed, zero failed.

## Fix

`app/api/feed/stream/route.ts` has only the two intended delimiter corrections; no mechanical replacement was used.

## Wider check

`pnpm vitest run tests/stream/sse-authorization.test.ts` -> 22 passed; `pnpm exec tsc --noEmit` -> exit 0.
