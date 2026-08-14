# Debug: T22 disposable PostgreSQL residue
**Originated during:** mcax-execute T22 final residue gate
**Status:** fixed

## Symptom (one sentence)

After the focused story passed, the final residue audit found an older disposable PostgreSQL process/data directory left by the earlier outer-shell timeout diagnostic.

## Reproduction

1. Inspect processes whose command line contains the exact `gustavo-e2e-postgres-` fixture prefix.
2. Inspect exact ownership-registry and result-directory residue.

Result: cmd PID 4456 and postgres PID 24896 still own `%TEMP%\gustavo-e2e-postgres-7w16K2` on port 63733; no ownership registry remains.

## Hypotheses

- H1: the 4:49pm outer-shell timeout interrupted global teardown after the registry had emptied but before this exact disposable database stopped. Validate the canonical path, postmaster PID, command line, and listening port before cleanup.

## Evidence

- Data directory creation time is 4:49:05pm, matching the interrupted diagnostic run rather than the final GREEN run.
- `postmaster.pid` names PID 24896, the exact canonical data directory, and port 63733.
- The live postgres command line names the same data directory and port; its recorded runner parent is absent.
- The final GREEN run itself passed its in-story ownership assertion and left zero hybrid children and zero ownership registries.

## Root cause

H1 confirmed: terminating the outer shell at its 184-second diagnostic bound prevented the fixture's last PostgreSQL teardown phase.

## Fix attempts (counter)

1. Revalidate the exact fixture identity, stop it with trusted PostgreSQL `pg_ctl -m fast -t 10 -w`, verify process and port absence, then remove only the validated disposable directory.

## Regression test

Command: exact process/path/port residue audit after cleanup.
Pre-fix result: two process entries and one disposable data directory.
Post-fix result: zero matching process, port, database directory, ownership registry, or backup directory residue.

## Fix

Trusted `pg_ctl` stopped the exact validated postmaster; after process and port absence were proven, only its disposable data directory was removed.

## Recoverability

This is a disposable migrated E2E database created by the interrupted test fixture. It contains no user data and is neither needed nor recoverable after cleanup.

## Wider check

Final residue audit reported zero owned processes, registries, PostgreSQL directories, and backup directories.
