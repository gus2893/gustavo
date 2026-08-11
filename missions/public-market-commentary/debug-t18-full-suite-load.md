# T18 full-suite load and Windows cleanup

## Symptom

The first full-suite run executed 394 assertions successfully but two new PostgreSQL-backed T18 cases crossed Vitest's default five-second per-test limit under parallel load. Three unrelated suites also reported Windows `EPERM` while removing already-stopped disposable PostgreSQL directories.

## Evidence

- The focused T18 suite completed all cases in about ten seconds.
- Under full parallel load, only the first two T18 integration cases timed out at exactly 5,000ms.
- The unrelated cleanup errors occurred after their assertions and pointed to the shared test helper's bounded recursive removal boundary.

## Root cause

Disposable PostgreSQL startup and migration time consumed the default per-test budget under parallel suite contention. The directory failures are the known transient Windows handle-release race; no product assertion or PostgreSQL shutdown failed.

## Fix

Give the PostgreSQL-backed T18 suite the repository-standard bounded 30-second integration-test timeout. Do not weaken assertions, alter product code, extend helper cleanup, or swallow cleanup exhaustion. Rerun the unchanged full suite after the T18 product tree is final.
