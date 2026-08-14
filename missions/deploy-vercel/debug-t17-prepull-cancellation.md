# Debug: T17 pre-pull cancellation timing
**Originated during:** mcax-execute T17
**Status:** fixed

## Symptom (one sentence)

The focused pre-pull cancellation regression still observed one subscription after adding a guard that stops an already-aborted lifecycle before startup.

## Reproduction

1. Construct the route response with a live request signal.
2. Abort the signal after `await handler(...)` but before explicitly reading `response.text()`.
3. Assert that the subscription was never created.

Result: the subscription was called once and received an already-aborted lifecycle signal.

## Hypotheses

- H1: WHATWG `ReadableStream` eagerly invoked `pull()` during response-body construction, so the event source started before the test's post-handler abort. Confirmed because the subscription call preceded the assertion yet received the signal in its later aborted state.
- H2: The request abort listener failed to propagate to the lifecycle controller. Refuted because the captured subscription input's signal was `aborted: true`.

## Root cause

The fixture treated explicit `response.text()` consumption as the first pull, but a newly constructed readable stream may pull eagerly while its desired size is positive. Aborting only after the handler returns does not prove cancellation occurred before source startup.

## Fix attempts (counter)

1. Added valid production guards before core subscription and bounded-source startup: did not fix the test because source startup had already occurred before the fixture aborted.
2. Corrected only the fixture timing by aborting before handler invocation: the focused regression passed.

## Regression test

File: `tests/stream/sse-authorization.test.ts`
Description: an already-cancelled request closes with no subscription or output.
Pre-fix result: fixture aborted too late and observed one legitimate eager subscription.
Post-fix result: one selected test passed, zero failed, with no subscription.

## Fix

`tests/stream/sse-authorization.test.ts` now supplies an already-aborted request to exercise the valid production guards without assuming lazy stream pull timing.

## Wider check

`pnpm vitest run tests/stream/sse-authorization.test.ts` -> 23 passed; `pnpm exec tsc --noEmit` -> exit 0; `git diff --check` -> exit 0.
