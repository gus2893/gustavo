# Debug: T35 cron day wildcard

**Originated during:** mcax-execute T35 Stage A remediation
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/broadcasts/scheduler.test.ts` expected the next `0 0 29 2 *` slot after March 2025 to be 2028-02-29, but returned 2026-02-01.

## Reproduction

1. Call `nextCronSlotAfter("0 0 29 2 *", "UTC", new Date("2025-03-01T00:00:00Z"))`.
2. Observe a non-leap February date.

Result: the day-of-month/day-of-week OR rule treated `*` day-of-week as restricted.

## Hypotheses

- H1: `Intl.DateTimeFormat` reported incorrect UTC day parts. Refuted by direct inspection showing February 1, 28, and 29 accurately.
- H2: wildcard detection compared normalized day-of-week values against the raw 0..7 range. Confirmed: Sunday normalization collapses 7 into 0, leaving 7 unique values rather than the raw range's 8.

## Root cause

`parseCronField` inferred wildcard status from normalized set cardinality. Day-of-week accepts both 0 and 7 for Sunday, so normalization made a real `*` fail that cardinality check and activated cron's restricted-day OR semantics.

## Fix attempts (counter)

1. Define wildcard syntax from the validated source form (`*` or `*/1`) rather than post-normalization cardinality: leap-day and stepped-wildcard regressions pass.

## Regression test

File: `tests/broadcasts/scheduler.test.ts`

Description: checks stepped day wildcard semantics plus leap-day and DST next-slot calculation.

Pre-fix result: wrong non-leap date. Post-fix result: passing.

## Fix

Cron wildcard status now follows its source syntax, preserving correct day-of-month/day-of-week semantics after Sunday normalization.

## Wider check

Commands run after the fix: focused scheduler verification, broadcast suite, TypeScript, and diff check -> all green.
