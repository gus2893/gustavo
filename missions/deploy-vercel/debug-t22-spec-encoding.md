# Debug: T22 spec literal encoding
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

After the first hybrid child stopped successfully, Playwright could not match the offline banner even though the error snapshot displayed it.

## Reproduction

1. Run the trusted focused Playwright spec with one worker.
2. Complete the first Node/Main/Evaluator drain and stop the first child.
3. Reload chat and match the exact offline banner.

Result: the locator times out after 10 seconds while the snapshot visibly contains `Message saved — local processing unavailable`.

## Hypotheses

- H1: the TypeScript test literal contains mojibake code points while the browser has the intended em dash. Confirm with a read-only UTF-8/code-point dump, then replace only the three affected status-banner literals with an ASCII `\u2014` escape.

## Evidence

- The two offline literals and one quota-limited literal in the spec contain `U+00E2 U+20AC U+201D` between `saved` and `local`.
- The Playwright error snapshot contains one exact `U+2014` em dash in that position.
- The first Node/Main/Evaluator drain, reply attribution, max-one-container proof, and clean child stop all passed before this text-only mismatch.
- Teardown left zero owned processes and zero ownership registries.

## Root cause

H1 confirmed: the test-source literals were encoding-corrupted, while product output was correct.

## Fix attempts (counter)

1. Replace only the two offline and one quota-limited status literals with `\u2014` escapes. This changes no production or expected text.

## Regression test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: the browser story must match the exact offline and quota-limited status banners after the relevant runtime transitions.
Pre-fix result: locator timeout despite the correct browser banner.
Post-fix result: both offline and quota-limited banner assertions passed.

## Fix

Only the three test literals use explicit `\u2014` escapes; product text is unchanged.

## Wider check

Full focused Playwright story passed and trusted TypeScript exited 0.
