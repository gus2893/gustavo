# Debug: T17 subscription admission order
**Originated during:** mcax-execute T17 Stage B fixes
**Status:** fixed

## Symptom (one sentence)

After the late-subscription cleanup fix, the full focused SSE suite expected the injected subscription to be admitted during the readable's eager pull, but `subscribe` still had zero calls at the pre-consumption assertion.

## Reproduction

1. Run `pnpm vitest run tests/stream/sse-authorization.test.ts` with trusted Node 24.
2. Observe `authenticates the route, forwards the resume cursor, and returns hardened SSE headers` fail at the exact `subscribe` call assertion.

Result: 28 tests passed and one failed because the new `Promise.resolve().then(...)` added an extra microtask before subscription invocation.

## Hypotheses

- H1: The added microtask deferred the dependency call past the established eager-pull assertion. Confirmed because the targeted legacy test passed when subscription was invoked synchronously while its returned promise remained recorded before the first `await`.
- H2: The shared readable no longer pulls eagerly. Refuted because the two new lifecycle tests entered and completed the same producer path.

## Root cause

The race fix correctly made late source assignment awaitable, but wrapped the dependency invocation itself in a microtask. Existing route behavior invokes the injected subscription synchronously during the readable's eager pull. External abort delivery cannot interleave between a synchronous dependency call returning its promise and assigning that promise to `sourceReady`, so deferring the call was unnecessary.

## Fix attempts (counter)

1. Invoke `dependencies.subscribe()` synchronously, immediately wrap and assign its returned value to `sourceReady`, and only then `await sourceReady`: the legacy ordering test and both Stage B race regressions passed.

## Regression test

File: `tests/stream/sse-authorization.test.ts`
Description: preserves synchronous subscription admission while proving an asynchronous source resolving after cancellation is still closed and returned exactly once.
Pre-fix result: the legacy eager-admission assertion observed zero subscription calls.
Post-fix result: the targeted three-test slice passed.

## Fix

`app/api/feed/stream/route.ts` now preserves synchronous subscription invocation and records the exact returned promise before any `await`; finalization awaits that authority before closing the late source and returning its iterator.

## Wider check

`pnpm vitest run tests/stream/sse-authorization.test.ts` -> 29 passed; deployment regressions -> 10 passed; privacy maintenance/stream regression -> 1 passed.
