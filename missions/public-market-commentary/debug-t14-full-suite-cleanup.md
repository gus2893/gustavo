# Debug: T14 full-suite PostgreSQL cleanup contention
**Originated during:** mcax-execute T14
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run` was expected to pass all tests and teardown steps, but exited 1 after 286 passing tests when `tests/helpers/postgres.ts:215` received `EPERM` deleting `C:\Users\gusta\AppData\Local\Temp\gustavo-postgres-xIx2Q2` during `profile-upgrade.test.ts` teardown.

## Reproduction

1. Run the complete suite under the bundled Node 24.14.0 and pnpm 11.16.0 binaries.
2. Observe 286 passing tests followed by the one teardown failure from `rmSync(server.dataDirectory, { recursive: true, force: true })`.
3. Run `pnpm vitest run tests/challenge/profile-upgrade.test.ts` unchanged in isolation.
4. Run `pnpm vitest run` unchanged again.

Result: the isolated test passed 1/1 and the unchanged full rerun passed 286/286, so the cleanup failure was not reproducible.

## Hypotheses

- H1: T14 risk code changed PostgreSQL fixture lifecycle behavior. Refuted because the new module is pure, the failing suite does not import it, and the isolated fixture test passed unchanged.
- H2: PostgreSQL had not stopped before directory removal. Refuted for the failed cluster by the absent `postmaster.pid` after failure; the helper also awaits `pg_ctl ... -w stop` before removal.
- H3: a short-lived Windows filesystem handle remained after the stopped server during parallel suite teardown. Supported by the one-time `EPERM`, absent server PID file, successful isolated cleanup, and unchanged full-suite pass; the specific external handle owner was not observable after release.
- H4: the repository has another working retry cleanup pattern to copy. Refuted by repository search: PostgreSQL cleanup uses this one centralized helper and no filesystem retry implementation exists.

## Root cause

The evidence supports transient Windows filesystem-handle contention after PostgreSQL had stopped: behavioral tests all passed, no `postmaster.pid` remained for the failed cluster, and both isolated and full-suite cleanup succeeded without a code change. Because the symptom could not be reproduced, no shared-helper change was justified.

## Fix attempts (counter)

No code fix was attempted. The isolated reproduction and unchanged full-suite rerun both passed after the transient handle released.

## Regression test

File: `tests/challenge/profile-upgrade.test.ts`
Description: the existing integration test starts and tears down its PostgreSQL fixture, exercising the failed lifecycle path.
Pre-fix result: behavioral assertion passed; first full-run teardown failed with `EPERM`.
Post-fix result: unchanged isolated run passed 1/1 and unchanged full rerun passed 286/286.

## Fix

No product or shared test-helper code changed. The existing stop-before-remove lifecycle was retained after the failure proved transient and non-reproducible.

## Wider check

Commands run after the failure: `pnpm vitest run tests/challenge/profile-upgrade.test.ts` -> 1/1 passed; unchanged full rerun -> 286/286; final T14 root verification -> 291/291.

## Lessons / design implications

A single Windows temp-directory `EPERM` after a confirmed server stop is not sufficient evidence to change the shared lifecycle helper. A reproducible regression must precede any retry-policy change.

## Post-verification hygiene

A process command-line scan found zero active `postgres.exe` or `pg_ctl.exe` processes associated with a `gustavo-postgres-*` data directory. Five inert test directories remained without `postmaster.pid` files. A validated native PowerShell removal was attempted with exact `-LiteralPath` targets, but the execution policy rejected the destructive command before it ran; the inert directories were therefore left untouched.
