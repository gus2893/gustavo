# Debug: T10 mixed evaluator provenance

**Originated during:** mcax-execute T10 spec review
**Status:** fixed

## Symptom (one sentence)

Direct SQL could combine candidate scores from separate completed evaluator passes, including when two connections started those inserts concurrently.

## Reproduction

1. Create one decision window with committed Main and contender candidates.
2. Create two completed evaluator runs caused by the Main commitment and one valid evaluation event for each run.
3. First reproduce the sequential mismatch inside one transaction.
4. Then start separate Main and contender score inserts together on two pooled PostgreSQL connections.

Pre-fix result: the sequential guard rejected a later mismatch, but both concurrent distinct candidate rows fulfilled because each statement observed an empty score set.

## Hypotheses

- H1: score validation checks each row independently but never compares it with existing scores for the same window. Confirmed by the trigger and selection queries.
- H2: selection recomputation implicitly constrains all rows to the Main run. Rejected because it only compared the selection row to the Main score's run.

## Root cause

`validate_decision_score_insert` verified that each individual score referenced a valid completed evaluator run/event, but did not require every score in the window to share one run and one event.

## Fix attempts (counter)

1. Add a sequential existing-score guard. The sequential test passed, but the two-connection test proved both concurrent inserts still committed.
2. Introduce a single immutable evaluation-batch row keyed by `window_id`. Score triggers now claim that row atomically through PostgreSQL's unique conflict path and compare the returned authoritative provenance. The sequential and concurrent regressions both passed.

## Regression test

File: `tests/orchestration/evaluator-rubric.test.ts`

The isolated PostgreSQL tests cover both a sequential mismatch with transactional rollback and two synchronized pooled connections. The concurrent case proves exactly one score commits, the other receives `DECISION_EVALUATION_PROVENANCE_INVALID`, and the stored window has one run/event provenance.

## Fix

One immutable `decision_evaluation_batches` row now owns evaluator run/event/prompt/model/policy provenance for the window. Every score insert atomically claims or reuses that row before acceptance. Event fields and the selection event's policy version are also bound at the SQL authority boundary.

## Wider check

Final focused 4/4 and full 212/212 tests passed; strict TypeScript, the production build, frozen install, diff check, and zero-process audit passed.
