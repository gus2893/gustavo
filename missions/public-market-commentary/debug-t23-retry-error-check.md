# Debug: T23 retry error-code constraint
**Originated during:** mcax-execute T23 Stage A
**Status:** fixed

## Symptom (one sentence)

The approved `retryHandoffRefreshJob` path failed before the early-retry claim regression because PostgreSQL rejected its `RETRY_SCHEDULED` transition with `handoff_refresh_job_transitions_check4`.

## Reproduction

1. Enqueue and claim a handoff refresh job.
2. Call `retryHandoffRefreshJob` with a valid delay and `TRANSIENT_TEST_FAILURE` error code.

Result: the worker emitted its canonical retry event, then the normalized transition insert failed its table check.

## Hypotheses

- H1: the retry worker writes an error code that the schema disallows. Confirmed: the worker deliberately binds `errorCode`, while the check equated `error_code is not null` exclusively with `to_status='FAILED'`.
- H2: the retry timestamp or lease is invalid. Refuted: the PostgreSQL diagnostic named check4 and showed a future `retry_at` with an otherwise valid claimed-owner transition.

## Root cause

The transition contract carries a bounded reason code for both retry scheduling and terminal failure, but the SQL check admitted it only for terminal failure.

## Fix attempts (counter)

1. Align the check with the canonical transition body: require `error_code` for `RETRY_SCHEDULED` and `FAILED`, and forbid it for all other states: fixed.

## Regression test

File: `tests/handoffs/privacy.test.ts`
Description: enqueue, claim, schedule a retry with an error code, then attempt a canonical early direct-SQL claim.
Pre-fix result: retry scheduling itself violated the table check.
Post-fix result: retry scheduling succeeds and the intended early-claim authority gate is exercised.

## Fix

- `db/migrations/0017_handoffs.sql`: aligned the transition `error_code` check with retry/failure semantics.
