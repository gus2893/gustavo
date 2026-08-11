# Debug: stage replay sequence prefix

**Originated during:** mcax-execute T17
**Status:** fixed

## Symptom (one sentence)

Stored-stage evaluation failed with `LEDGER_STORED_SEQUENCE_INVALID` after the stage accumulated ten or more immutable events.

## Reproduction

1. Complete two qualifying paper-trading days.
2. Evaluate the stored stage.

Result: the query returned event sequences `1,10,...,19,2,...,9`.

## Hypotheses

- H1: filtering by event time created sequence holes. Refuted when the full event query retained the failure.
- H2: the `sequence::text` output alias controlled `ORDER BY sequence`. Confirmed by the captured lexical order.

## Root cause

The stored-stage queries cast `sequence` to text for replay DTOs and then ordered by the ambiguous output alias, causing PostgreSQL to sort lexically rather than by the authoritative bigint column.

## Fix attempts (counter)

1. Replay all events after verifying the maximum event time and derive day-start from a contiguous prefix: exposed the remaining ordering defect.
2. Qualify both ordering clauses with `challenge_ledger_events.sequence`: fixed.

## Regression test

File: `tests/challenge/trading-days.test.ts`

The multi-day pass and final-completion cases now replay more than ten events in exact numeric sequence.

## Fix

Stage evaluation replays the complete authoritative sequence and derives UTC day-start equity by slicing at the first current-day event, never by creating a holey filtered event array.
