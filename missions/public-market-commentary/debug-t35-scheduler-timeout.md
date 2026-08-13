# Debug: T35 scheduler test timeout

**Originated during:** mcax-execute T35
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/broadcasts/scheduler.test.ts` was expected to pass but exited 1 after Vitest's default 5-second test timeout while exercising the disposable PostgreSQL fixture and concurrent scheduler retries.

## Reproduction

1. Run the focused T35 test under the pinned Node 24 runtime.
2. Observe the test reach Vitest's default timeout before returning assertions.

Result: one test failed with `Error: Test timed out in 5000ms`.

## Hypotheses

- H1: Scheduler transactions deadlock under concurrent retries. Refuted by the unchanged test completing successfully with a diagnostic 30-second ceiling.
- H2: Disposable PostgreSQL startup, migrations, and the concurrent retry exercise exceed the generic 5-second unit-test ceiling. Confirmed by all assertions passing in 5.98 seconds with no production change.

## Root cause

The integration test creates a disposable PostgreSQL schema, applies every migration, and then exercises three concurrent scheduler calls. That bounded integration work takes longer than Vitest's generic 5-second default on this machine.

## Fix attempts (counter)

1. Set a 30-second timeout on this integration test only: focused verification passes without changing scheduler behavior.

## Regression test

File: `tests/broadcasts/scheduler.test.ts`

Description: proves one durable Main-authored cycle per slot across concurrent retries, schedule versioning, timezone evaluation, snapshot authority, outbox generation, and next-run projection.

Pre-fix result: assertions did not complete before the generic test ceiling. Post-fix result: passing.

## Fix

The scheduler integration test now declares a bounded 30-second timeout appropriate for disposable database startup. Production code is unchanged.

## Wider check

Commands run after the fix: focused T35 verification and `pnpm exec tsc --noEmit` -> all green.
