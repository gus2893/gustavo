# Debug: T22 Stage B infra shared start source
**Originated during:** mcax-execute T22 Stage B shared production assembly
**Status:** fixed

## Symptom (one sentence)

An existing infra source-order test failed because it searched for the old direct `startHybridWorkerHost({` literal after the entrypoint began delegating through `assembly.start()`.

## Reproduction

Run trusted Node 24/pnpm `vitest run tests/infra/hybrid-worker.test.ts` after the behavior-preserving assembly extraction.

Result: exit 1 in 20.2 seconds; 55 tests passed and the sole failure compared the SIGINT index with `-1` for the removed literal.

## Root cause

The production ordering remains signal authority before host startup, but the test encoded the former implementation spelling rather than the shared seam.

## Fix

Assert signals precede `const host = await assembly.start()`, and separately assert the factory selects `dependencies.startHost ?? startHybridWorkerHost` before invoking `startHost`.

## Regression test

Rerun the complete hybrid infra test file, TypeScript, and the focused story.
