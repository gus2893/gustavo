# Debug: T22 Stage A operator-health array narrowing
**Originated during:** mcax-execute T22 Stage A operator-health correction
**Status:** fixed

## Symptom (one sentence)

After the independent missing-export RED was implemented, `tsc --noEmit` failed with TS1434 at both operator-health `Array.find` result assertions.

## Reproduction

Run trusted Node 24/pnpm `tsc --noEmit`.

Result: exit 1 in 2.1 seconds at `tests/e2e/fixtures.ts` lines 1477 and 1480.

## Hypothesis

- H1: a line break before `as Record<string, unknown> | undefined` makes the assertion parse as a new statement instead of applying to the `find` expression.

## Evidence

Read-only inspection showed each `find(...)` call ended before a newline-leading `as`, exactly matching both TS1434 locations.

## Root cause

H1 confirmed and refined: parenthesizing the result did not prevent newline-leading `as` from being parsed as a new statement; the assertion needs its own stable local declaration.

## Fix attempts (counter)

1. Parenthesize each unchanged `find(...)` expression; TS1434 remained at both newline-leading assertions.
2. Store each result as `unknown`, then narrow it in a separate declared local.

## Regression test

Run trusted Node 24/pnpm `tsc --noEmit`, then the focused Playwright story with one worker.

## Fix

The two test-only array results use stable local declarations before narrowing; response validation behavior is unchanged.

## Wider check

Focused operator-health browser evidence, full T22 story, residue, and diff gates run after the correction.
