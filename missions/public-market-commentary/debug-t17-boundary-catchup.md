# T17 UTC-boundary catch-up debug record

## Symptom

A delayed UTC-boundary run with a committed event one minute after its scheduled timestamp threw `CHALLENGE_STAGE_EVALUATION_OUT_OF_ORDER`, which could stop the worker loop and lose the boundary run.

## Root cause

The worker passed its captured schedule timestamp into the evaluator before serializing with stage mutations. A later committed event therefore made the requested replay time stale.

## Fix and evidence

For each started nonterminal stage, the worker now acquires the stage advisory and row locks, reads the latest committed ledger timestamp under those locks, and evaluates at the later of the injected boundary or that timestamp on the same transaction. The focused delayed-boundary regression is green, and direct out-of-order calls to the lower-level evaluator still fail closed.
