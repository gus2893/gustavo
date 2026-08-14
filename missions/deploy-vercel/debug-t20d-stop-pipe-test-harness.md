# Debug: T20D stop-pipe test harness
**Originated during:** mcax-execute T20D
**Status:** fixed

## Symptom (one sentence)

Trusted Node 24 running `vitest run tests/infra/hybrid-worker.test.ts -t "operator stop|StopForMaintenance|maintenance stop"` was expected to pass the first GREEN implementation, but three of five selected tests failed: one static plan regex saw `LocalSystemSid` before `PipeAccessRule`, PS5.1 surfaced the contending client's bounded `Connect(100)` failure as an `IOException` rather than the harness's `TimeoutException`, and an injected closure failed with `HYBRID_MAINTENANCE_STOP_UNPROVEN`.

## Reproduction

1. Pre-fix focused run discovered 47 tests, selected five T20D regressions, and reported three failures/two passes.
2. The pipe test's exact CLIXML error named `IOException` with `The semaphore timeout period has expired` at `$Second.Connect(100)`.
3. A minimal Windows PowerShell 5.1 closure probe using `$script:Calls` inside `.GetNewClosure()` produced `You cannot call a method on a null-valued expression` and left the caller list count at zero.
4. After the three targeted corrections, the focused rerun passed four of five tests; the sole failure had exit code zero and only PS5.1's `Preparing modules for first use` progress CLIXML on stderr.
5. With progress suppressed, the same harness still passed its operations but prefixed stdout with `System.Threading.Tasks.VoidTaskResult` from the uncast connection task wait.
6. The first full hybrid-worker rerun passed 44 of 47 tests; the remaining three were pre-T20D source-shape assertions for a 300-character STARTING branch, Funnel-off before worker cleanup, and a literal unnamed `25000 - elapsed` expression.
7. After the full suite passed, self-review found the same `VoidTaskResult` behavior at the production connection wait inside `Receive-PendingMaintenanceRequest`, where an extra function output could make a malformed request result truthy.
8. A second self-review compared the launcher's pre-existing config ACL validator with T20C's reviewed setup validator and found that the launcher accepted two allowed duplicate identities, permitting owner-only or SYSTEM-only pairs.
9. The first parallel final-gate invocation lost quotes around the parser's path literals and failed at `@(scripts/setup-hybrid-worker.ps1,scripts/...)` before returning combined results.
10. A combined read-only inspection ended with exit 1 after `Select-Object -First 260` closed `git diff` early; it printed no `git diff --check` diagnostic.
11. Bound arithmetic found the 40,000ms client proof wait was shorter than a valid worst case: 5,000ms STARTING poll + 25,000ms runtime + two Funnel attempts of 5,000ms command timeout plus 2,000ms exact-process settle = 44,000ms before overhead.
12. Stage A review found the real PS5.1 client remains in byte read mode after connect, so requiring `IsMessageComplete` without first selecting message mode can reject a valid proof.
13. Stage A review found the client trusted any same-name pipe after task/config checks; a hostile pre-created pipe could return the static safe token without proving its owner/SYSTEM ACL.
14. Stage A review found failed maintenance cleanup disposed the worker handle, marked cleanup complete, released the control pipe, and exited even when runtime/container or Funnel settlement remained unproven.
15. The independent Stage A RED run selected three real-pipe tests and failed all three: the exact server/client proof path returned `False|Message`, the hostile-server harness returned empty stdout, and the retained-authority test found no cleanup-state helpers.
16. After switching only the hostile job's output transport to `Write-Output` and isolating it from the independently failing byte-mode defect, the actual hostile pipe was accepted and the semantic RED returned `False` instead of required rejection `True`.
17. Adding the exact production ACK prerequisite pushed the real client/server harness's UTF-16LE `-EncodedCommand` above Windows' command-line limit; Node reported `spawnSync ... ENAMETOOLONG` before PS5.1 started.
18. The final retained-authority regression exercised four actual clients on one server: runtime timeout with acknowledged `UNPROVEN`, settled stop with invalid ACK, settled proof with no ACK through the 2,000ms bound, and a valid proof-bound ACK retry.
19. The Stage B natural-exit RED initially executed launcher main code because the shared helper slicer treated the final `Invoke-LauncherCleanup` function as extending to end-of-file; injected paths were null at `Split-Path $NodeExecutable`.
20. With the final helper bounded correctly, all four semantic RED probes (STARTING/READY, exit 0/7) showed the same unsafe behavior: runtime-proof calls `0`, Funnel calls `1`, RuntimeSettled/ProofAcknowledged true, worker disposal `1`, and close/rebind allowed.

Result: every runtime/harness symptom reproduced deterministically without invoking a scheduled task, Docker, Funnel, or a provider; the two verification-command symptoms reproduced from their exact malformed invocations.

## Hypotheses

- H1: the static ordering failure is literal source order rather than missing ACL authority. Confirmed by the first GREEN failure output: `LocalSystemSid` appeared before the first `PipeAccessRule`, while both required rules and inheritance protection were present.
- H2: `NamedPipeClientStream.Connect(Int32)` wraps the no-free-instance timeout in `IOException` on Windows PowerShell 5.1. Confirmed by the exact CLIXML exception category and message from the isolated contending-client assertion.
- H3: `.GetNewClosure()` creates a dynamic module, so `$script:Calls` addresses that module's empty script scope rather than the harness caller's list. Confirmed by the minimal probe's null-method error and unchanged caller count.
- H4: first access to the scheduled-task/pipe security assemblies can emit a non-error progress record through PS5.1's CLIXML host stream. Confirmed by exit code zero, complete expected stdout, and a stderr payload whose only record is `S="progress"` with `Preparing modules for first use`.
- H5: PS5.1 writes the generic task's `VoidTaskResult` when `GetResult()` is used as a bare pipeline statement. Confirmed by the exact stdout prefix followed by the otherwise expected assertion payload.
- H6: the three full-suite failures encode superseded T15 implementation shapes rather than approved behavior. Confirmed by comparing each old assertion with T20D: signed STARTING backoff now includes a stop-admission check, the runtime/container proof must now precede Funnel cleanup, and the same 25,000ms deadline is intentionally named and passed as remaining budget.
- H7: the already-confirmed PS5.1 bare-`GetResult()` output rule also contaminates the production request reader. Confirmation target: an actual malformed named-pipe request returns two pipeline objects before the cast and exactly one Boolean `False` after it.
  Outcome: confirmed; the regression received `2|System.Threading.Tasks.VoidTaskResult` instead of `1|False`.
- H8: the launcher validates only rule count and allowed membership, not one exact rule per required identity. Confirmation target: injected duplicate owner and duplicate SYSTEM ACL pairs both pass before the fix and both reject afterward.
  Outcome: confirmed; the RED regression returned `False|False`, proving neither duplicate pair was rejected.
- H9: nested `-Command` quoting was consumed by the outer PowerShell command before Windows PowerShell parsed it. Confirmed by the exact missing-argument parser error showing both intended string literals without quotes.
- H10: the inspection exit belongs to the intentionally truncated producer pipeline, not diff whitespace. Confirmed by the absence of check diagnostics before the truncated diff and verified next by running `git diff --check` alone.
- H11: a valid fully settled maintenance stop can false-timeout at the client because its proof wait is below the sum of already-reviewed component bounds. Confirmation target: a source-derived bound regression fails at 40,000ms and passes at 50,000ms while remaining below 60,000ms; task-state recheck stays separately fixed at 5,000ms.
  Outcome: confirmed; RED reported `expected 40000 to be greater than or equal to 45000` while independently deriving the exact 44,000ms component sum.
- H12: `NamedPipeClientStream` defaults to byte read mode even when the server uses message transmission. Confirmation target: an actual client/server proof-read regression fails until the client sets `ReadMode=Message` before checking `IsMessageComplete`.
  Outcome: confirmed; RED returned `False|Message`, and GREEN returned `True|Message` after the production client selected message mode.
- H13: pipe-name possession is not authenticated by the task/config checks. Confirmation target: an actual owner-connectable pipe with a non-exact ACL and a prewritten static success token must reject before proof acceptance.
  Outcome: confirmed; isolated RED accepted the owner-only hostile pipe (`False` rejection result), and GREEN rejects it before accepting its static token.
- H14: cleanup authority is coupled to a `finally` disposal rather than proven settlement state. Confirmation target: an injected first failure writes only `UNPROVEN`, leaves worker disposal count zero and the exact pipe bound, then a second request safely completes runtime/Funnel once, writes `STOPPED`, releases once, and permits exact-name rebind.
  Outcome: confirmed at RED; the launcher had none of `New-LauncherCleanupState`, `Invoke-MaintenanceConnection`, or `Close-MaintenanceAuthority`. GREEN retains authority across failed stop, invalid ACK, and missing ACK, then releases after an exact proof-bound ACK.
- H15: job-side `[Console]::Out.Write(...)` is not serialized as success output by Windows PowerShell 5.1 `Start-Job`/`Receive-Job`. Confirmation target: preserve the same real hostile server/client flow but emit its Boolean through the job output pipeline.
  Outcome: confirmed; the corrected harness exposed the intended semantic RED (`False`), proving the owner-only server's static token was accepted.
- H16: broad production-helper extraction plus UTF-16LE/base64 expansion crossed Windows' process command-line limit after the ACK helper was added. Confirmation target: the same fileless PS5.1 harness runs as a compact raw command with only its exact named helper slices.
  Outcome: confirmed by the exact `ENAMETOOLONG` spawn error and encoded argument printed by Vitest; exact helper slices with a raw `-Command` argument remain fileless and pass.
- H17: the generic next-function slicer has no function delimiter after the launcher's final helper, so it includes executable main code. Confirmation target: bound only `Invoke-LauncherCleanup` at the exact `$StartInfo` main-code boundary, then recapture the four semantic RED probes.
  Outcome: confirmed; bounding the slice removed the injected-path failure and exposed the intended natural-exit semantic RED.
- H18: `Invoke-LauncherCleanup` treats `Worker.HasExited` as equivalent to authenticated runtime/container settlement and marks the client-proof ACK flag on a path with no client. Confirmation target: process exit alone retains the pipe and worker handle; a separate genuine injected runtime/container proof plus Funnel settlement enables a distinct natural-cleanup release condition without setting ProofAcknowledged.
  Outcome: confirmed by all four RED probes and corrected by removing the exit inference and separating `NaturalCleanupSettled` from `ProofAcknowledged`.

## Root cause

The initial failures combined literal/static ordering drift with PS5.1-specific harness behavior: contended pipe connects surface as `IOException`, dynamic-module closures do not share caller `$script:` state, progress records use CLIXML, and a bare generic-task `GetResult()` emits a pipeline object. Wider checks then exposed three superseded T15 static shapes plus two real production gaps: that same `VoidTaskResult` contaminated the request reader, and the pre-existing config ACL validator did not require one distinct owner and one distinct SYSTEM rule. Bound review also proved the client wait was shorter than the sum of approved component deadlines. The parser/diff inspection exits were command composition errors, not repository failures.

## Fix attempts (counter)

1. Reorder the SYSTEM SID construction between the owner and SYSTEM `PipeAccessRule` declarations so the plan's literal order and the same two-rule ACL both hold; focused assertion passed.
2. Treat any bounded second-client connection exception as rejection, while still requiring the first connection and exact two-rule ACL; focused assertion passed.
3. Capture a lexical `$Calls` list in the injected closures instead of `$script:Calls`; STARTING/READY transaction assertion passed.
4. Set `$ProgressPreference='SilentlyContinue'` only in the injected PS5.1 pipe harness while retaining exit-code and empty-error assertions; harness remained error-clean.
5. Cast only the injected harness's connection-task `GetResult()` call to `[void]`; exact stdout assertion passed.
6. Replace the three invalidated static shapes with stronger T20D assertions: signed STARTING proof then stop check then backoff; runtime/container proof then bounded Funnel settlement then safe response; exact named 25,000ms deadline with only its remaining budget reaching `WaitForExit`; full suite passed.
7. Add an actual PS5.1 malformed-pipe regression, observe RED (`2|System.Threading.Tasks.VoidTaskResult`), then cast the production connection wait to `[void]`; GREEN returned exactly `1|False`.
8. Add an independent PS5.1 duplicate-identity ACL regression, observe RED (`False|False`), then port the reviewed one-owner/one-SYSTEM FullControl-Allow equality logic from setup; GREEN returned `True|True`.
9. Replace only the verification invocation with a UTF-16LE encoded PS5.1 parser script and rerun each final gate independently; both scripts parsed with zero errors.
10. Run `git diff --check` as a standalone command and inspect bounded source slices without terminating a producer early; exit 0.
11. Add the full worst-case arithmetic regression, observe RED (`40000 < 45000`), then raise only the proof wait to 50,000ms; focused and full suites passed with the separate task-state wait still 5,000ms.
12. Add an actual message-mode client/server proof-read RED, then select message mode and authenticate the exact protected owner/SYSTEM ACL before request/proof processing; GREEN.
13. Add an actual hostile-ACL same-name pipe RED, then require protected ACL, exact owner, and exactly one owner plus one SYSTEM FullControl-Allow rule; GREEN.
14. Add an integrated launcher-lifecycle RED, then introduce explicit runtime/Funnel/worker/proof settlement state, same-server reset/re-arm, and safe retry without a second stop authority; GREEN.
15. Minimize the Stage A harnesses to exact production function blocks and use a raw fileless `-Command` argument, avoiding the `-EncodedCommand` expansion; GREEN.
16. Bind the bounded ACK to the exact proof, gate authority release on that ACK, and cover invalid and held-open missing ACK clients followed by proof-only retry; GREEN with runtime attempts `2`, Funnel attempts `1`, and worker disposal `1`.
17. Add real STARTING and READY loop probes with actual client/server traffic and gated runtime-before-Funnel callbacks; both withhold proof until the ordered callbacks settle.
18. Bound the Stage B `Invoke-LauncherCleanup` harness slice before `$StartInfo = ...`; corrected and semantic RED recaptured.
19. Add STARTING/READY × exit 0/7 regressions, remove `HasExited` runtime-settlement inference, and require a genuine runtime/container proof plus Funnel settlement before setting a distinct natural-cleanup release flag; GREEN for all four probes.

## Regression test

File: `tests/infra/hybrid-worker.test.ts`

Description: the T20D focused slice asserts exact owner/SYSTEM ACL and one active pipe instance, connected-pipe ACL authentication, message-mode proof reads, wrong/malformed request rejection, actual STARTING/READY runtime-before-Funnel proof ordering, failed-stop/invalid-ACK/missing-ACK retained authority and retry, bounded client disposal, exact task state, and nonce absence.

Pre-fix result: failing (three selected tests).

Post-fix result: focused T20D slice passed 14/14; full file passed 55/55.

## Fix

- `scripts/start-hybrid-worker.ps1`: authenticate the connected pipe ACL, use message reads, bind bounded ACKs to their exact proof, and retain a single pipe authority/state machine through unproven stop or proof-delivery retry until runtime, container, Funnel, worker handle, and proof delivery are settled.
- `tests/infra/hybrid-worker.test.ts`: use exact fileless PS5.1 helper slices and actual client/server flows for hostile ACL, message mode, STARTING/READY ordering, failed stop, invalid/missing ACK retry, exact release/rebind, task state, and nonce absence.
- Stage B: natural worker exit no longer implies runtime/container settlement or client acknowledgment; natural close requires its own flag set only after genuine runtime/container proof, Funnel settlement, and worker-handle release.

## Wider check

- Focused T20D slice: 14 passed, 41 skipped, exit 0.
- Full `tests/infra/hybrid-worker.test.ts`: 55 passed, exit 0.
- Windows PowerShell 5.1 parser: setup and start scripts parsed with zero errors.
- Trusted Node 24 `tsc --noEmit`: exit 0.
- `git diff --check`: exit 0 (line-ending warnings only for existing working-tree files).
- Test-owned Windows PowerShell residue: zero processes.
