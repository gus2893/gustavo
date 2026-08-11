# T17 stored-profile threshold debug record

## Symptom

The stored evaluator loaded immutable stage-profile thresholds but delegated its decision to the global initial-profile formula. That made future published profiles vulnerable to being evaluated under the wrong target and loss limits.

## Root cause

The pure initial-profile helper was reused at the persistence boundary even though the authoritative target, overall floor, daily limit, and minimum-day count were already available on the bound profile rows.

## Fix and evidence

Stored evaluation now compares equity and qualifying days directly with the bound immutable stage/profile values. A published v2 regression uses a 1% overall/daily limit and an exact $25 simulated fee: equality permanently fails at $2,475 and records the v2 target/floor/daily values, without changing T14's initial-profile risk authority.
