# Debug: durable result JSON decimal types

**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

An otherwise valid direct-SQL OPEN durable result committed when `fillPrice` and `commission` were JSON numbers instead of the canonical decimal strings required by strict hydration.

## Reproduction

1. Create a real accepted paper order and opening lifecycle.
2. Insert a matching completed job and result with numeric JSON decimal scalars.

Result before the fix: the transaction committed and the rejecting test failed with `promise resolved undefined instead of rejecting`.

## Hypotheses

- H1: SQL `->>` converts both JSON strings and numbers to text before value comparison. Confirmed because the numeric scalars matched the authoritative stored values and committed.

## Root cause

`validate_challenge_order_job_result()` compared decimal values only after `->>` extraction, losing the original JSON scalar type while the worker hydration contract requires strings.

## Fix attempts (counter)

1. Require `jsonb_typeof(...)='string'` for every non-null OPEN/CLOSED `fillPrice` and `commission` before exact text comparison: fixed.

## Regression test

File: `tests/challenge/order-lifecycle.test.ts`

Description: an otherwise valid OPEN result with numeric JSON decimal fields must reject with `CHALLENGE_ORDER_JOB_RESULT_INVALID`; canonical string results remain covered by the lifecycle suite.

## Fix

Migration 0011 now preserves strict durable-result type fidelity at the SQL authority boundary before comparing exact decimal text.
