# Debug: T16 accepted-risk ledger fixtures
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

The combined T15+T16 run failed eight T15 persistence tests at commit with `CHALLENGE_ORDER_ACCEPTED_RISK_REQUIRED` after the T16 SQL causation gate was added.

## Reproduction

1. Apply migrations through `0011_order_lifecycle.sql`.
2. Run `pnpm vitest run tests/challenge/ledger-replay.test.ts tests/challenge/order-lifecycle.test.ts`.

Result: legacy T15 fixtures inserted otherwise-valid orders directly after intents without a causally prior accepted `rule.evaluated` event and source row.

## Hypotheses

- H1: the production trigger rejected valid T16-created orders. Refuted by the 13/13 green T16 suite and its explicit causation assertion.
- H2: T15 lower-level fixtures no longer represented the minimum valid order source chain. Confirmed: each failing direct order omitted the accepted evaluation and `acceptedRiskEvaluationId` payload binding required by migration 0011.

## Root cause

The T15 fixture topology predated the T16 invariant. It modeled intent to order directly, while every committed order now requires intent to accepted risk evaluation to caused order with matching stage, profile, intent, evaluation ID, and ledger order.

## Fix attempts (counter)

1. Add a reusable accepted-risk fixture source and thread it through only the valid direct-order fixture roots, preserving all intentional invalid dependency cases and leaving production enforcement unchanged: fixed fixture topology.

## Regression test

File: `tests/challenge/ledger-replay.test.ts`

Description: valid persistence fixtures commit only with a prior accepted risk source, while the T16 lifecycle suite separately asserts the committed order is caused by that exact accepted evaluation.

Pre-fix result: eight commits failed with `CHALLENGE_ORDER_ACCEPTED_RISK_REQUIRED`.

Post-fix result: the combined T15+T16 suite passes 70/70 and the full suite passes 363/363.

## Fix

The valid T15 order fixtures now include typed accepted rule-evaluation events and rows, exact order causation, and the evaluation ID in order payloads. Later source sequences were advanced deterministically where the new immutable event occupies the prior gap.

## Wider check

Commands run after the fix: T16 focused 13/13; T15+T16 focused 70/70; full suite 363/363; type-check, Next production build, and frozen install all pass.
