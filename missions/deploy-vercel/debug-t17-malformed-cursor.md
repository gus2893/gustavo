# Debug: T17 malformed cursor fixture
**Originated during:** mcax-execute T17
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/stream/sse-authorization.test.ts` expected the new malformed-cursor adversarial test to return HTTP 400, but it returned HTTP 500.

## Reproduction

1. Run the focused SSE test file with trusted Node 24 and pnpm 11.
2. Observe `exports the Vercel route duration and rejects malformed cursors before auth`.

Result: `expected 500 to be 400` at `tests/stream/sse-authorization.test.ts:149`.

## Hypotheses

- H1: The injected test fixture omitted the production cursor validator, so the syntactically safe but semantically invalid cursor reached an undefined authentication fixture. Confirmed by comparing the optional dependency at `app/api/feed/stream/route.ts:52`, the production validator at line 609, and the fixture at `tests/stream/sse-authorization.test.ts:137`.
- H2: The route maps `INVALID_LAST_EVENT_ID` to a generic 500. Refuted by `app/api/feed/stream/route.ts:621`, which returns 400 for that exact code.

## Root cause

The handler deliberately permits an injected `validateLastEventId` so legacy unit fixtures can use body-free opaque IDs, while production supplies `parseStreamCursor`. The adversarial fixture did not inject that production validator. Its `authenticate` mock also had no return value, so the invalid cursor passed the absent validator and later dereferencing `authentication.actor` raised a `TypeError`, correctly mapped to the generic 500 boundary.

## Fix attempts (counter)

1. Made the malformed-cursor fixture inject `parseStreamCursor`, matching the production dependency: focused regression passed.

## Regression test

File: `tests/stream/sse-authorization.test.ts`
Description: asserts a semantically malformed `Last-Event-ID` is rejected with private no-store HTTP 400 before authentication or subscription.
Pre-fix result: failing because the fixture omitted the production validator.
Post-fix result: one selected test passed, zero failed.

## Fix

`tests/stream/sse-authorization.test.ts` now injects the same cursor parser as `productionDependencies`; no route behavior changed for this fix.

## Wider check

`pnpm vitest run tests/stream/sse-authorization.test.ts` -> 22 passed; `pnpm exec tsc --noEmit` -> exit 0.
