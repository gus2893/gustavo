# Debug: T19 heartbeat lease precision
**Originated during:** mcax-execute T19
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/deployment/vercel-hybrid.test.ts -t "hybrid operator health"` expected a CODEX heartbeat observed 12 minutes and 1 millisecond ago to project `OFFLINE`, but it projected `AVAILABLE`.

## Reproduction

1. Project a healthy CODEX heartbeat at `2026-08-13T11:47:59.999Z` with database time `2026-08-13T12:00:00.000Z` and current quota `99/100`.
2. Run the focused hybrid operator-health tests.

Result: `tests/deployment/vercel-hybrid.test.ts:82` failed with `Expected: "OFFLINE"; Received: "AVAILABLE"` on every run.

## Hypotheses

- H1: The implementation floors the raw age to whole seconds before applying the exact 12-minute lease boundary. Confirmed by `lib/server/bridge/health.ts:153-160`: the 720.001-second delta becomes `720`, then `720 > 720` is false.
- H2: JavaScript date parsing discards the input millisecond. Refuted because `Date#getTime()` represents both timestamps with the expected 720,001-millisecond difference before the flooring step.
- H3: Quota precedence changes the result. Refuted because the reproducer supplies `CODEX_JOBS=99/100`, so the quota is not exhausted.
- H4 (Stage B extension): JavaScript millisecond timestamps can remain the production lease authority after fixing the whole-second comparison. Refuted because PostgreSQL `timestamptz` and `clock_timestamp()` retain microseconds, and separately reading the UTC quota bucket can cross midnight relative to the application clock.

## Root cause

`rawComponentProjection` uses the display-oriented, floored `ageSeconds` value as the lease authority. That loses sub-second precision before the comparison, extending the approved lease by almost one second. The source timestamp and database time retain millisecond precision; only the normalization order is wrong.

Stage B exposed the deeper production-boundary version: even raw JavaScript millisecond arithmetic cannot preserve PostgreSQL microseconds or make a separately read UTC quota bucket coherent with the lease clock. The durable collector therefore must compute the lease boolean, bounded age, and current UTC quota from one materialized PostgreSQL clock; JavaScript time remains only for deterministic pure projector inputs.

## Fix attempts (counter)

1. Compare the raw millisecond delta against `codexLeaseSeconds * 1_000`, while continuing to expose only the bounded whole-second display age: the original focused regression passed.
2. Move production lease/age/current-UTC quota authority into one PostgreSQL statement using one materialized database clock: the microsecond, UTC-rollover, and real-database regressions passed.

## Regression test

File: `tests/deployment/vercel-hybrid.test.ts`

Description: asserts exactly 12 minutes remains `AVAILABLE`, 12 minutes plus 1 millisecond is `OFFLINE`, and a future heartbeat is rejected.

Pre-fix result: failing (`12m+1ms` projected `AVAILABLE`).

Post-fix result: passing.

## Fix

`lib/server/bridge/health.ts` keeps raw millisecond authority only for deterministic standalone projector inputs. `collectHybridHealth` now uses one materialized PostgreSQL clock to compute the exact microsecond CODEX lease boolean, bounded display age, and current UTC quota in the same statement.

## Wider check

The focused microsecond/UTC/pending authority slice passed 3/3. The real migrated-PostgreSQL microsecond test passed 1/1. Final wider gate results are recorded in the T19 handoff.
