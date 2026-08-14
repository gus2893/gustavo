# Debug: T22 Stage A maintenance quota immutability
**Originated during:** mcax-execute T22 Stage A maintenance correction
**Status:** fixed

## Symptom (one sentence)

The focused browser story failed before the real maintenance launcher when the ordinary test connection attempted to lower the terminal `CODEX_JOBS` counter from 100 to 99.

## Reproduction

Run the trusted Node 24/pnpm Playwright command for `tests/e2e/gustavo-hybrid-production.spec.ts` with `--workers=1`.

Result: exit 1 after 31.3 seconds with safe PostgreSQL code `DEPLOYMENT_QUOTA_COUNTER_IMMUTABLE` at the attempted update.

## Hypotheses

- H1: the quota trigger intentionally forbids lowering a reserved counter, so the in-flight job must be admitted before the terminal 100/100 boundary is seeded.

## Evidence

- The failure occurred on the single statement that changed `used_count=100` to `used_count=99`.
- The database returned the trigger-owned safe code `DEPLOYMENT_QUOTA_COUNTER_IMMUTABLE`; no worker, provider, or PowerShell operation had begun.
- The prior 100/100 row was created successfully and remained unchanged through teardown.
- The first reordered run exposed a race: runtime `modelActive` became true before the model transport gate was actually reached, allowing the terminal quota seed to win. A test-owned `modelGateReached` observation distinguishes admission from transport settlement.

## Root cause

H1 confirmed: the proposed test ordering contradicted the production append-only quota authority.

## Fix attempts (counter)

1. Reorder only the test story so the in-flight maintenance job is admitted before the terminal 100/100 quota assertion; never lower a counter or disable its trigger.
2. Wait for the test-owned model transport gate itself, not only the runtime active flag, before seeding terminal quota authority.

## Regression test

Command: trusted Node 24/pnpm Playwright focused story with `--workers=1`.

Expected: the job reaches the admitted in-flight snapshot before 100/100 is seeded, operator health separately proves terminal quota limitation, and maintenance completes without any quota decrement.

## Fix

The test-only story ordering preserves monotonic quota reservations and keeps the separate terminal 100/100 projection.

## Wider check

TypeScript, focused Playwright, diff, and owned-residue gates run after the correction.
