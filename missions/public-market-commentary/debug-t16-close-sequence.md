# Debug: T16 close checkpoint sequence ordering
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

The target-close path appended ten contiguous ledger events, but checkpoint replay rejected them as `LEDGER_STORED_SEQUENCE_INVALID`.

## Reproduction

1. Submit and fill the accepted AAPL paper intent.
2. Process the licensed `105.00` target observation concurrently twice.
3. Inspect the event sequence immediately before checkpoint replay.

Result: the persisted list was contiguous, but the selected text alias was sorted lexically as `1,10,2,3,4,5,6,7,8,9`.

## Hypotheses

- H1: the two concurrent workers allocated a duplicate or skipped ledger sequence. Refuted by the diagnostic list, which contained every integer from 1 through 10 exactly once.
- H2: `ORDER BY sequence` resolved to the selected `sequence::text` output alias and sorted lexically. Confirmed by the exact `1,10,2...` order and by the qualified numeric-column fix.
- H3: a transaction rollback removed an intermediate event. Refuted because no sequence was absent from the diagnostic list.

## Root cause

Both T16 checkpoint queries and T15's public load/checkpoint queries selected `sequence::text` using the inherited `sequence` name and then used an unqualified `ORDER BY sequence`. PostgreSQL resolves an unqualified `ORDER BY` name to the output alias in this shape, so it ordered by the text output expression once the lifecycle crossed sequence 9.

## Fix attempts (counter)

1. Qualify the authoritative bigint input column and ID in both T16 checkpoint queries: fixed their numeric ordering without changing stored data.
2. After the worker passed, the fresh replay assertion exposed the same latent query shape in T15's public loader. With explicit authorization, qualify both T15 ledger query orderings as the same regression fix.

## Regression test

File: `tests/challenge/order-lifecycle.test.ts`

Description: the target-close test intentionally creates ten events, concurrently retries the exit, then compares the persisted checkpoint to a fresh authoritative replay.

Pre-fix result: sequence order `1,10,2,3,4,5,6,7,8,9` failed replay.

Post-fix result: numeric event ordering and fresh replay pass beyond sequence 9; the expanded T16 suite passes 9/9.

## Fix

The submit/worker checkpoint queries and the T15 public load/checkpoint queries now order by `challenge_ledger_events.sequence` (bigint) and the qualified event ID.

## Wider check

Commands run after the fix: T15+T16 focused 62/62; expanded T16 focused 9/9; full suite 359/359; type check, Next build, and frozen install all pass.
