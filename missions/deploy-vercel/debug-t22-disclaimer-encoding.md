# Debug: T22 disclaimer literal encoding
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

The completed hybrid story reached the logged-out public page but the test could not match the exact simulation disclaimer.

## Reproduction

1. Run the trusted focused Playwright story through maintenance, child cleanup, and logout.
2. Open the public page.
3. Match the exact simulation disclaimer.

Result: the locator times out while the public snapshot visibly contains the contract disclaimer.

## Hypotheses

- H1: the remaining disclaimer test literal has the same mojibake sequence as the previously isolated banners, while product output has the intended em dash.

## Evidence

- A read-only UTF-8/code-point dump of the spec shows `U+00E2 U+20AC U+201D` between `ONLY` and `NOT`.
- The approved contract and product text use one `U+2014` em dash.
- Every prior story phase, including maintenance stop, child closure, and ownership release, passed.
- Teardown left zero owned processes and zero ownership registries.

## Root cause

H1 confirmed: the final test-source literal was encoding-corrupted; product behavior was correct.

## Fix attempts (counter)

1. Replace only the disclaimer literal with `SIMULATION ONLY \u2014 NOT A REAL TRADE`.

## Regression test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: the logged-out public page must expose the exact contractual simulation disclaimer.
Pre-fix result: locator mismatch from test-source mojibake.
Post-fix result: exact public disclaimer assertion passed in the full focused story.

## Fix

The test literal uses an ASCII `\u2014` escape and product text is unchanged.

## Wider check

Focused Playwright passed 1 with the opt-in Docker proof skipped; trusted TypeScript exited 0.
