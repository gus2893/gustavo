# Debug: T22 Stage A stale-health quota baseline
**Originated during:** mcax-execute T22 Stage A operator-health correction
**Status:** fixed

## Symptom (one sentence)

The authenticated stale-health response correctly reported CODEX offline, but the test expected zero quota use and received four.

## Reproduction

Run the trusted Node 24/pnpm focused Playwright story with one worker.

Result: exit 1 in 33.6 seconds at the stale operator-health quota equality; the response was `OFFLINE`, `WORKER_OFFLINE`, lease-stale, limit 100, used 4, and not exhausted.

## Hypothesis

- H1: the first Node/Main/Evaluator drain and recovered Node job legitimately consume CODEX quota before the stale-heartbeat checkpoint.

## Evidence

The story completes three initial roles and one recovered Node role before backdating the heartbeat, exactly accounting for the observed four uses. The authenticated health response independently projected the stale CODEX lease as offline.

## Root cause

H1 confirmed: zero was not a valid quota baseline at this story phase.

## Fix attempts (counter)

1. Assert the stale state exactly for CODEX status, safe code, lease freshness, quota limit, and non-exhaustion, while requiring actual use to remain below 100.

## Regression test

Run trusted Node 24/pnpm focused Playwright with one worker and the owned-residue gate.

## Fix

Only the stale-state assertion accepts legitimate prior use below the limit. The later fresh quota-limited projection remains exact at 100/100.

## Wider check

Recovery authority, market UI semantics, authenticated terminal health, TypeScript, and residue gates run after the correction.
