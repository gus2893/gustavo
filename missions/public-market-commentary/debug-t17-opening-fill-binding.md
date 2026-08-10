# T17 opening-fill qualification debug record

## Symptom

Qualifying-day discovery inferred an opening fill from chronological ordering. Additive fills with equal timestamps and unrelated UUID ordering could therefore be misclassified.

## Root cause

The query did not use the authoritative position-to-opening-event relation already persisted by the ledger schema.

## Fix and evidence

The query now joins `challenge_positions` and requires `position.opening_ledger_event_id = fill.ledger_event_id`. A source regression also excludes the former earlier-fill heuristic, so only the immutable opening fill can qualify a UTC day.
