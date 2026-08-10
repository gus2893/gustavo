# T17 full-suite cleanup debug record

## Symptom

The first final-tree full-suite run executed all 387 assertions successfully but exited 1 because Windows returned `EPERM` while removing two disposable PostgreSQL directories.

## Evidence and diagnosis

Both exact paths were under the owned `gustavo-postgres-*` temporary prefix. Neither contained `postmaster.pid`, and the process audit found no `postgres.exe`, `pg_ctl.exe`, or `node.exe` command line tied to either directory. This isolated the failure to a released-cluster filesystem-handle race rather than product behavior or a running database.

## Verification

No helper or product code was changed. The unchanged full-suite rerun passed 23 files and 387/387 tests with exit 0.
