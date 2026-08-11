# Debug: T16 completed retry after source-policy change
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

An exact retry of a completed paper-worker operation rejected with `PAPER_ORDER_MARKET_NOT_ALLOWED` after the source license and instrument allowlist were revoked, instead of returning its immutable stored result.

## Reproduction

1. Complete one paper-order opening operation and persist its job result.
2. Disable the source license and instrument allowlist.
3. Retry the exact same order, observation, and evaluation input.

Result: mutable source-policy validation ran before the completed job-result lookup.

## Hypotheses

- H1: the completed result was missing or mutable. Refuted by the persisted job-result row and unchanged lifecycle counts.
- H2: claim ordering required current source policy before discovering the immutable operation. Confirmed by the rejection stack at `observationRow` before `challenge_order_job_results` was queried.

## Root cause

`worker/challenge/process-order.ts` combined immutable observation identity lookup with current license, allowlist, session, freshness, and completed-evidence validation. That made historical result hydration depend on mutable policy state even though no new market action would occur.

## Fix attempts (counter)

1. Split immutable order/observation identity from current evidence validation, return an exact completed result first, and retain full validation for every absent or unfinished job: fixed.

## Regression test

File: `tests/challenge/order-lifecycle.test.ts`

Description: an exact completed retry returns the same immutable result after license and allowlist revocation with no new lifecycle rows; a new observation under the revoked policy still fails closed and creates no job or lifecycle effect.

Pre-fix result: 13/14 T16 tests passed; the exact retry rejected with `PAPER_ORDER_MARKET_NOT_ALLOWED`.

Post-fix result: T16 passes 14/14, including the historical-result and new-operation controls.

## Fix

The worker now derives operation identity only from immutable order and observation fields. It consults a matching completed job result before mutable policy validation, while new and unfinished jobs continue through the complete current evidence gate.

## Wider check

Commands run after the fix: T16 focused 14/14; T15+T16 focused 71/71; full suite 364/364; type-check, Next production build, and frozen install all pass.
