# Debug: T17 queue-full finalization
**Originated during:** mcax-execute T17 review fixes
**Status:** fixed

## Symptom (one sentence)

The four-blocker focused slice passed revalidation, protected-load, and authentication tests, but the queue-full non-reader test timed out after the writer-wakeup implementation.

## Reproduction

1. Run the four reviewer-blocker tests with a five-second test timeout.
2. Observe the queue-full case reach its source load and then time out without an assertion location.

Result: one timed-out test, three passed.

## Hypotheses

- H1: The producer still never reaches queue-full or source finalization. Refuted: bounded `QUEUE_FULL` and `FINALIZED` phases both pass.
- H2: Source finalization succeeds, but explicit response cancellation waits on an already-running lifecycle-readable finalizer that cannot complete. Confirmed: only bounded `CANCELLED` returns `CANCEL_HUNG`.

## Root cause

The route can wake the queue-full writer and await the underlying subscription/iterator finalizer, but `openFeedStream` owns a separate active pull/generator finalizer behind its public readable/frames abstractions. After request abort, route wrappers around both the frames iterator and the readable reader leave response cancellation waiting indefinitely even though the body-free source has already finalized. The approved route-only boundary does not expose one cancellation-owned promise that covers active projection plus response shutdown.

## Fix attempts (counter)

1. Avoid awaiting the manual frames finalizer from the active pull's abort branch: `CANCEL_HUNG` remained.
2. Track and await the active frames `next()` before `AsyncIterator.return()`: `CANCEL_HUNG` remained.
3. Replace manual iterator concurrency with `ReadableStreamDefaultReader.cancel()` over `openFeedStream.readable()`: `CANCEL_HUNG` remained.

Design challenge: T17 likely needs an adjacent `lib/server/stream/events.ts` API that owns projection, active pull, abort, source close, iterator return, and response completion behind one idempotent shutdown promise. Is that cancellation-owned pump/finalizer the intended contract, replacing the route-only wrapper assumption?

## Regression test

File: `tests/stream/sse-authorization.test.ts`
Description: a non-reading consumer fills the 100-ID queue, abort wakes the writer, and response/source cleanup fully settles.
Pre-fix result: former code returned `HUNG` before source finalization; current correction advances further but times out at an unidentified phase.

## Fix

Escalated without another code attempt. The source producer/backpressure correction remains evidence-backed, but response cancellation cannot be accepted until the stream abstraction exposes an owned settle boundary.

## Wider check

Focused blocker slice before escalation: revalidation, protected-load, and lifecycle-before-auth pass; queue test passes `QUEUE_FULL` and `FINALIZED` but fails `CANCELLED` with `CANCEL_HUNG`.

## Post-prompt-update resolution

The approved prompt update moved response settlement into `openFeedStream().readable()` and gave it the same abort authority as the route lifecycle. A phase trace then identified the remaining first divergent state: abort woke the queue-full writer, but `durationBoundedEventIds.enqueue()` checked only `finished` and queue capacity, so it immediately parked again while the lifecycle was already aborted. The shared pump correctly waited for that admitted producer, which made response cancellation remain pending.

The queue admission loop now also stops waiting when the lifecycle signal is aborted. The shared stream pump owns one idempotent settlement promise, aborts admission, awaits its frames/projection iterator, idempotently closes and returns the event-ID source, runs the route lifecycle cleanup, and only then completes response cancellation.

Post-fix regression: `settles a queue-full producer and finalizes its source when a non-reader aborts` passed, including bounded `QUEUE_FULL`, `FINALIZED`, and `CANCELLED` phases. Wider check after Stage B race coverage: `pnpm vitest run tests/stream/sse-authorization.test.ts` -> 29 passed; `pnpm exec tsc --noEmit` -> exit 0.
