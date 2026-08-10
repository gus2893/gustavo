# T17 lifecycle wiring debug record

## Symptom

The first Stage A regression proved that a ledger-changing paper submission could return while a breached stage still had no permanent terminal event. The initial order-worker hook also ran only after its transaction committed.

## Root cause

The stored stage evaluator existed, but production mutation paths did not invoke it atomically. A process crash between commit and the post-commit callback could leave stage state stale until a later manual evaluation.

## Fix and evidence

Paper-intent and paper-lifecycle transactions now acquire the stage advisory lock before the stage row lock and invoke the idempotent evaluator on the same transaction before commit. The injected UTC worker evaluates every nonterminal stage at reset boundaries. The focused suite is green with automatic submit/order evaluation and retry idempotency.
