# Debug: T22 child drain hang
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

The trusted focused Playwright run reached signed wake acceptance and then timed out after 180 seconds while waiting for three bridge jobs to complete, with the browser still showing the private canary and `1 queued`.

## Reproduction

1. Run the T22 focused Playwright spec through trusted Node 24 with one worker.
2. Let the first child start, seed the Main job, create the operator account, send the private canary, and deliver its captured signed wake.
3. Observe that delivery returns HTTP 202 but the following completed-job wait never settles.

Result: Playwright exits 1 after 199.4 seconds; the trace's final successful assertion is the delivery status `202` at spec line 926, immediately before `waitForDatabase` at lines 927-932.

## Evidence

- Global setup reached disposable PostgreSQL, migrations, and healthy Next.
- Fresh-inventory, role-isolation, and exact-schedule preflights passed.
- Child `START` and `SEED_MAIN`, invitation acceptance, chat send, hosted publication capture, and signed production wake acceptance all passed.
- The browser error snapshot shows `Local processing available`, `1 queued`, and the private canary in the conversation.
- No hybrid child process remained after Playwright teardown; the disposable fixture teardown completed and its owned registry was removed.

## Hypotheses

- H1: the parent polling query is individually unbounded, hiding whether the database read or child drain/model transition is the actual wait. Test with a per-statement bound plus test-owned child phase/status observations, without changing production behavior.
- H2: if the parent query remains responsive, the child drain is blocked inside a particular production-interface transition. Identify the last bounded child phase before making a harness correction.

## Root cause

H2 confirmed. Production registers `docker wait` before calling start so termination authority cannot miss a fast exit. The test-owned fake's `wait()` incorrectly required the container to be `EXITED` at call time and rejected while it was correctly `CREATED`. Production therefore treated execution as unavailable, terminalized Node and Main as `CODEX_MODEL_UNAVAILABLE`, and left the fake's lifecycle proof incomplete.

## Fix attempts (counter)

1. Bound each parent-pool PostgreSQL statement to five seconds and each child protocol command to 30 seconds. A command timeout terminates the exact test-owned child before rejecting, so a failed diagnostic cannot leave detached work. This tests H1 without changing any production behavior or drain timing.
   Result: inconclusive. The outer shell's 184-second limit fired before the reporter returned. The second trace again ended after HTTP 202, but unlabelled test-owned awaits did not distinguish the database poll from failure cleanup. The owned registry directory was empty but remained because the shell terminated before global teardown; it was validated and removed. Exact process inspection confirmed zero remaining worker/test processes.
2. Process inspection also showed the `tsx` CLI introduced an intermediate process. Replace it with Node's supported direct `--import tsx` loading boundary, add bounded exact-child exit proof, add a seven-second client query timeout in addition to the server statement timeout, and label the first start/delivery/drain/stop phases with Playwright steps. No production code or semantics change.
   Result: H1 refuted. The focused run failed cleanly in 49.2 seconds at the named `observe first Node Main Evaluator drain` step with the harness's own 20-second `E2E_DATABASE_WAIT_TIMEOUT`. Neither PostgreSQL bound fired, proving parent polling stayed responsive. Teardown reported zero owned processes and zero ownership registries.
3. On only that bounded drain timeout, capture the child runtime/transport status and safe bridge-job lifecycle fields so H2 can identify the last production-interface transition. The diagnostic queries are bounded by the already-proven child and PostgreSQL limits.
   Result: H2 confirmed. Transport status showed one Node invocation, `maxActiveContainers=1`, and the fake container still present. The database showed Node and Main both `FAILED/CODEX_MODEL_UNAVAILABLE` with one attempt and released leases.
4. Make the fake's production-interface `wait()` behave like Docker: register while `CREATED`, settle only when start or kill produces the exit code, then allow the production runner to inspect/remove/prove absence. No production behavior changes.

## Regression test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: the first signed wake must return 202, drain the Node/Main/Evaluator work through the production interfaces, and make all three jobs observable as completed within a bounded wait.
Pre-fix result: exact 180-second test timeout after wake acceptance.
Post-fix result: the first wake completed Node/Main/Evaluator in priority order and the full focused story passed.

## Fix

Test-owned fake wait authority now spans the created-to-exited transition and reports the exact natural or killed exit code to the unchanged production runner.

## Wider check

Trusted TypeScript exited 0; focused Playwright passed 1 with the opt-in Docker proof skipped; final residue audit is zero.
