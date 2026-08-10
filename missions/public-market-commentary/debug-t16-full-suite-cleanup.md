# T16 debug — full-suite PostgreSQL cleanup

## Symptom

The full suite completed all 370 assertions successfully but Vitest exited 1 because Windows returned `EPERM` while deleting one test-owned PostgreSQL directory during teardown.

## Evidence

The exact directory was under the bounded `gustavo-postgres-` prefix in the system temporary directory. After teardown it contained no `postmaster.pid`, establishing that the cluster had stopped; the failure was a transient filesystem-handle race during directory removal rather than a running database or test assertion failure.

## Response

Cleanup semantics and timeouts were not changed. The helper continues to use the existing native recursive removal with five bounded retries and a 100 ms retry delay. Verification reruns the unchanged full-suite command after gathering process and directory evidence.
