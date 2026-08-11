# Debug: T24 combined related-suite timeout
**Originated during:** mcax-execute T24
**Status:** fixed

## Symptom (one sentence)

The combined T24 related command expected Vitest results for cache, events, broadcasts, Challenge, handoff, and recall coverage, but the outer shell terminated it after 244.1 seconds with exit 124 and no assertion or test-failure output.

## Reproduction

1. Run `pnpm.cmd vitest run tests/cache/isolation.test.ts tests/events/event-store.test.ts tests/broadcasts tests/challenge tests/handoffs/privacy.test.ts tests/recall/planner.test.ts` under a 240-second shell ceiling.
2. Allow the PostgreSQL integration files to run serially under the repository's Windows disposable-database configuration.

Result: the outer shell reaches its timeout before Vitest emits its buffered final report, leaving the killed command's Vitest worker and current disposable PostgreSQL process to be cleaned up by exact process identity.

## Hypotheses

- H1: The aggregate known-good PostgreSQL suite duration exceeds the outer command budget. Confirmed: the independently bounded splits all pass and total about 371 seconds (`81.8 + 14.1 + 139.0 + 52.0 + 82.4`), excluding process-start overlap.
- H2: T24 introduced a cache assertion failure. Refuted: the focused cache suite passes 18 tests, and cache plus broadcasts passes 100 tests with an explicit Vitest report.
- H3: One related PostgreSQL suite hangs. Refuted: events, Challenge, handoffs, and recall each complete independently with explicit green reports.

## Root cause

The diagnostic command grouped six independently substantial coverage areas beneath a 240-second outer shell ceiling. On Windows the disposable PostgreSQL ownership is intentionally serialized, so their aggregate runtime exceeds that ceiling even though every split completes successfully. The shell timeout, not Vitest or T24 behavior, caused exit 124.

## Fix attempts (counter)

1. Split the same coverage into independently bounded commands after stopping only the timed-out command's exact orphaned processes: fixed.

## Regression test

Files: existing T24 cache, event-store, broadcast, Challenge, handoff, and recall tests.

Description: execute the same related coverage in smaller groups with explicit outer ceilings.

Pre-fix result: combined command exit 124 after 244.1 seconds with no Vitest verdict.

Post-fix result:

- cache + broadcasts: 3 files / 100 tests pass in 81.8 seconds;
- event store: 1 file / 7 tests pass in 14.1 seconds;
- Challenge: 7 files / 164 tests pass in 139.0 seconds;
- handoffs: 1 file / 25 tests pass in 52.0 seconds;
- recall: 1 file / 50 tests pass in 82.4 seconds.

## Fix

No production or test behavior changed. Verification orchestration now keeps the PostgreSQL-heavy suites in independently bounded commands. The timed-out command's exact Vitest and disposable PostgreSQL processes were stopped before reproduction; unrelated long-running Node/PostgreSQL processes were not touched.

## Wider check

The five split commands above all exit 0. Focused cache and strict TypeScript checks remain green.
