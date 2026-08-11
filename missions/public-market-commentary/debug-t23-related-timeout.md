# Debug: T23 combined related-suite timeout
**Originated during:** mcax-execute T23
**Status:** fixed

## Symptom (one sentence)

The combined five-file related command expected Vitest results, but the shell terminated it after 184 seconds with exit 124 and no assertion or test-failure output.

## Reproduction

1. Run `pnpm.cmd vitest run tests/events/event-store.test.ts tests/orchestration/proposal-contract.test.ts tests/memory/consolidation.test.ts tests/memory/conflicts.test.ts tests/recall/planner.test.ts` with a 180-second shell ceiling.
2. Allow all PostgreSQL-heavy recall and temporal-graph cases to share the run.

Result: the outer shell reaches its timeout before Vitest emits its buffered final report.

## Hypotheses

- H1: Combining the historically heavy T21 recall and T22 graph suites exceeds the outer 180-second command budget. Confirmed by absence of assertion output and by split suites completing under appropriately bounded ceilings.
- H2: T23 caused a test deadlock. Refuted if each split suite completes independently without a hung test.

## Root cause

The diagnostic command grouped multiple full PostgreSQL integration suites under a ceiling too short for their aggregate runtime. The shell, not Vitest, terminated the process.

## Fix attempts (counter)

1. Split the related checks into smaller commands with sufficient bounded timeouts: fixed.

## Regression test

Files: existing related event, proposal, consolidation, recall, and graph tests.
Description: execute the same coverage in independently bounded groups.
Pre-fix result: combined command exit 124 after 184 seconds.
Post-fix result: split commands complete with explicit Vitest pass/fail reports.

## Fix

No production or test behavior changed. Verification orchestration uses smaller commands and sufficient bounded ceilings.

## Wider check

Commands run after the fix are recorded in the T23 implementer handoff.
