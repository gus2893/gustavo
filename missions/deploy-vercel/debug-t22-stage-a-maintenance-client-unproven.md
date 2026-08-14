# Debug: T22 Stage A maintenance client unproven
**Originated during:** mcax-execute T22 Stage A maintenance correction
**Status:** fixed

## Symptom (one sentence)

The real owner/SYSTEM named-pipe path ran, but the unchanged production client returned `HYBRID_MAINTENANCE_STOP_UNPROVEN` before its exact-task non-running recheck.

## Reproduction

Run the trusted Node 24/pnpm focused Playwright story with one worker.

Result: the launcher file executed and cleaned up, while the client emitted only the safe fail-closed code.

## Hypotheses

- H1: an external phase before the client proof/task recheck is false; observe only bounded booleans around the unchanged protocol.
- H2: the test-owned Node wrapper exits nonzero after successful host/pool cleanup, so production `Invoke-WorkerStopProof` correctly rejects the otherwise-settled runtime.

## Evidence

- Owner/SYSTEM pipe ACL, initial exact-task Running observation, parsed stop request, and child settlement were true.
- Runtime/Funnel/worker-release/acknowledgement were false because the stop transaction rejected its runtime proof.
- The exact child was absent, host cleanup was true, and pool cleanup was true, but child exit-zero was false.
- The nonzero status was not one of the test-owned host/pool diagnostic codes, isolating the imported Playwright wrapper's natural exit semantics rather than runtime cleanup.

## Root cause

H2 confirmed and refined: an independently acquired test wrapper could not provide the exact directly owned zero-exit Process authority required by production `Invoke-WorkerStopProof`.

## Fix attempts (counter)

1. Add safe outer phase booleans for pipe, request, runtime, Funnel, worker, acknowledgement, task observations, child settlement, and child exit.
2. Split test-owned host and pool cleanup status from the child exit status.
3. Set the test-owned wrapper's exit status to zero only after its actual production host stop and pool cleanup both settle; preserve nonzero diagnostic codes for either failure.
4. Replace the interim settlement monitor with a production-function owner PowerShell that directly launches and owns the exact registered Node Process; keep test-control transport on a separate bounded loopback socket.

## Regression test

Command: trusted Node 24/pnpm focused Playwright story with `--workers=1`, followed by owned-residue verification.

Expected: unchanged `Invoke-WorkerStopProof` accepts the zero-settled child, then Funnel, proof acknowledgement, and exact-task Ready recheck become true.

## Fix

The PowerShell owner executing the unchanged production maintenance server functions directly launches and owns the exact registered Node Process, so the unchanged stop proof observes its real zero exit after host/pool settlement.

## Wider check

TypeScript, focused Playwright, exact launcher absence, registry, process, and path residue gates run after the correction.
