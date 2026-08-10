# T16 debug — SQL risk recomputation

## Red

A direct SQL order with real decision, evaluator, and evidence provenance could commit while supplying a fabricated favorable risk snapshot and a mismatched quantity.

## Root cause

The order trigger authenticated provenance identifiers but still trusted material numeric risk fields and the submitted quantity. That left the database unable to prove that the accepted evaluation represented the immutable ledger state and selected geometry.

## Fix

Migration 0011 now replays the stage ledger at the accepted high-water event, reconstructs UTC-day equity and active-order exposure, recomputes cost-adjusted quantity, stop risk, notional, commission, and post-entry equity from trusted geometry and the deterministic `challenge-risk-v1` policy, then requires exact agreement with the stored snapshot and order. Decimal comparisons use the same bounded truncation as the application.

## Regression

The focused test first demonstrated that forged snapshot values and quantity committed. It now rejects with `CHALLENGE_ORDER_RISK_SNAPSHOT_INVALID`, while the complete T16 and combined T15/T16 suites retain valid lifecycle behavior.
