# Debug: T23 cold-schema test timeout
**Originated during:** mcax-execute T23
**Status:** fixed

## Symptom (one sentence)

`pnpm.cmd vitest run tests/handoffs/privacy.test.ts` expected six passing tests, but the first PostgreSQL integration case exceeded Vitest's default 5,000 ms timeout at 5,019 ms while the other five cases completed successfully.

## Reproduction

1. Run the focused T23 test on a cold process.
2. Let its first integration case start PostgreSQL and apply all migrations before constructing the handoff fixture.

Result: the case times out at the harness boundary even though no assertion or application error is reported; the five later cases pass in the same run.

## Hypotheses

- H1: The first test owns one-time PostgreSQL startup and full-schema migration cost, putting it just over Vitest's 5-second default. Confirmed by the exact 5,019 ms duration and the subsequent five green cases.
- H2: The packet transaction deadlocks. Refuted because the same packet round trip previously passed and later packet/job concurrency cases completed in the failing run.

## Root cause

The focused test's cold PostgreSQL startup and migration cost is part of the integration harness, but the test inherited Vitest's 5-second unit-test default. The production operation was not stuck.

## Fix attempts (counter)

1. Set the T23 focused `describe` timeout to 20 seconds without changing behavior: fixed.

## Regression test

File: `tests/handoffs/privacy.test.ts`
Description: reruns the unchanged six-case privacy/job suite from a cold process.
Pre-fix result: 5 passed, 1 timed out at 5,019 ms.
Post-fix result: all six pass within the explicit 20-second integration budget.

## Fix

- `tests/handoffs/privacy.test.ts`: declares a 20-second timeout for the PostgreSQL-backed suite.

## Wider check

Commands run after the fix: `pnpm.cmd vitest run tests/handoffs/privacy.test.ts`.
