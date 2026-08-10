# Debug: T14 source scan false positive
**Originated during:** mcax-execute T14
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/challenge/risk-gates.test.ts` was expected to pass after the risk evaluator was added, but exited 1 because the no-external-calls source assertion `/\b(?:fetch|Date|Math\.random|model|network)\b/i` matched the word `model` in a comment even though all runtime call spies recorded zero calls.

## Reproduction

1. Run `pnpm vitest run tests/challenge/risk-gates.test.ts` with the bundled Node 24 and pnpm 11 binaries.
2. Observe 26 passing tests and the sole failure in `is deterministic and makes no clock, random, network, or model calls`.
3. Inspect the received source excerpt and find `model-owned metadata` in the evaluator documentation comment.

Result: the broad word-search regex reported a forbidden dependency from non-executable prose.

## Hypotheses

- H1: the evaluator invoked a clock, random source, or network API. Refuted by the `fetch`, `Date.now`, and `Math.random` spies, each of which recorded zero calls.
- H2: the evaluator imported or invoked model/network code. Refuted by inspecting its imports and implementation; it imports only `decimal.js` and the local immutable Challenge profile.
- H3: the source assertion matched prose instead of executable syntax. Confirmed by the failure excerpt highlighting the documentation comment's word `model`.

## Root cause

The test used a general forbidden-word regex over the entire source file. That regex could not distinguish a safety comment explaining that model metadata is ignored from an executable model or network dependency.

## Fix attempts (counter)

1. Replace the general word regex with checks for executable `fetch(...)`, `Date.now(...)`, and `Math.random(...)` calls plus imports from Node network modules or the repository model layer: passing.

## Regression test

File: `tests/challenge/risk-gates.test.ts`
Description: runtime spies still prove the evaluator calls no clock, random, or fetch APIs, while source checks reject executable network/model imports without rejecting safety comments.
Pre-fix result: failing false positive.
Post-fix result: passing.

## Fix

- `tests/challenge/risk-gates.test.ts`: narrowed the static source scan to executable calls and imports.
- `missions/public-market-commentary/03-plan.md`: records the approved debug-artifact scope expansion for T14.

## Wider check

Commands run after the fix: final focused risk verification passed 32/32 and the full suite passed 291/291 under Node 24.14.0.
