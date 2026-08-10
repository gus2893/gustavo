# Debug: T15 full-suite PostgreSQL cleanup
**Originated during:** mcax-execute T15
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run` completed every product assertion but intermittently exited 1 because PostgreSQL `afterAll` cleanup either exceeded 30 seconds or received Windows `EPERM` while removing a stopped temp-cluster directory.

## Reproduction

1. Use bundled Node.js 24.14.0 and pnpm 11.16.0.
2. Run `pnpm vitest run`.

Result: all assertions passed, while `tests/broadcasts/main-authorship.test.ts` reproducibly timed out in the helper hook and a later full run failed only on stopped-directory `EPERM`.

## Hypotheses

- H1: Bulk temp-directory deletion consumes the hook window. Refuted when deferring that deletion did not change the reproducible authorship timeout.
- H2: T15 migration or tests leave a database connection/process open. Refuted because focused T15 cleanup left zero active owned clusters and the failure reproduced in the unchanged authorship suite.
- H3: Serial per-schema drops consume the hook window before PostgreSQL shutdown starts. Confirmed by gated step timestamps: 59 pool closes were immediate, while 59 redundant `DROP SCHEMA ... CASCADE` calls took about 29 seconds and `stop postgres` began only as the 30-second deadline fired.
- H4: Windows can retain a stopped-cluster directory handle briefly. Confirmed by a full run that passed all assertions but received `EPERM` from recursive removal after the serial-drop fix.

## Root cause

Each Vitest file owns a disposable PostgreSQL cluster, but cleanup still issued one serial schema drop per fixture before discarding that cluster. The 59-schema authorship suite therefore exhausted the hook budget before shutdown. Once that redundant work was removed, Windows exposed a separate transient directory-lock race; Node's native bounded retry mechanism is the appropriate non-swallowing boundary for that race.

## Fix attempts (counter)

1. Defer stopped-directory deletion: refuted as the timeout cause and removed completely.
2. Plan only pool closes for schemas inside an owned running cluster that will be discarded, retaining individual drops for a non-discarded server: fixed the reproducible hook timeout.
3. Add bounded native recursive-removal retries (`maxRetries: 5`, `retryDelay: 100`): fixed transient Windows `EPERM` while preserving failure after exhaustion.

## Regression test

File: `tests/helpers/postgres-lifecycle.test.ts`.
Description: 59 schemas in a disposable owned cluster plan 59 pool closes and zero redundant drops; the non-discard path retains close/drop pairs; stopped-directory removal supplies bounded retry options; cleanup still attempts later restoration after an earlier failure.
Pre-fix result: missing cleanup planner/removal boundary functions, plus real-suite hook timeout and `EPERM`.
Post-fix result: lifecycle 4/4, affected authorship 59/59, and full suite 325/325.

## Fix

`tests/helpers/postgres.ts` now plans schema cleanup according to cluster ownership and supplies bounded native retry options for safe temp-directory removal. It does not raise the hook timeout, swallow exhausted cleanup failures, or change product code.

## Wider check

Lifecycle regression → 4/4; affected Main authorship → 59/59; focused T15 → 32/32; final `pnpm vitest run` → 21 files and 325/325; TypeScript, Next production build, frozen install, and `git diff --check` → exit 0; active owned Gustavo PostgreSQL/`pg_ctl` process count → 0.
