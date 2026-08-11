# Debug: stage adverse-mark source transaction

**Originated during:** mcax-execute T17
**Status:** fixed

## Symptom (one sentence)

The failure-lifecycle fixture rejected with `CHALLENGE_LEDGER_TYPED_SOURCE_MISSING` before stage evaluation.

## Reproduction

1. Append a `price.mark.recorded` source event.
2. Insert its typed `challenge_price_marks` row in a later transaction.

Result: the production deferred source-fidelity trigger rejected the first commit.

## Hypotheses

- H1: the fixture split one logical source mutation across transactions. Confirmed because the event committed before its required typed row.

## Root cause

The test helper did not preserve the production event-plus-derived-row atomicity contract.

## Fix attempts (counter)

1. Append the event and insert its typed mark row inside one database transaction: fixed.

## Regression test

File: `tests/challenge/trading-days.test.ts`

The permanent-failure case keeps all production triggers enabled and now reaches authoritative stage evaluation.

## Fix

Only the test fixture transaction boundary changed; no production trigger or source-fidelity rule was weakened.
