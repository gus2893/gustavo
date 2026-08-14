# Debug: T22 Stage A direct wrapper exit proof
**Originated during:** mcax-execute T22 Stage A maintenance self-review
**Status:** fixed

## Symptom (one sentence)

After replacing the settlement-monitor indirection with the exact registered PowerShell wrapper Process, production `Invoke-WorkerStopProof` failed closed despite the child and its host/pool resources settling.

## Reproduction

Run the trusted Node 24/pnpm focused Playwright story with one worker.

Result: exit 1 in 38.0 seconds; direct worker identity, child absence, host cleanup, and pool cleanup were true, while runtime settlement was false.

## Hypotheses

- H1: the independently acquired wrapper Process exits with a nonzero safe class after the Node child settles.
- H2: independently acquiring the Process prevents production PowerShell from observing the wrapper's successful exit code; production PowerShell must launch and own it directly.
- H3: a directly owned Node Process does not inherit the Node-created parent pipe handles through `Process.Start`; explicit redirected forwarding is required.

## Evidence

- The prior one-variable RED proved the settlement monitor did not have the registered child PID while every other protocol phase passed.
- Removing the monitor proved `Worker.Id` equals the registered child PID and the child becomes absent, but the unchanged production stop proof rejected its exit result.

## Fix attempts (counter)

1. Pass the independently acquired exact wrapper Process to the unchanged production functions; the exit proof remained unproven.
2. Classify only the direct Process exit as zero, one, bounded nonzero, diagnostic, or still running.
3. Move the exact Node launch into the production-function owner PowerShell; direct PID ownership passed, but the bounded START command timed out because inherited stdio did not cross the PowerShell launch boundary. The exact orphaned marker/PID was revalidated, terminated, and proven absent.
4. Keep the direct Process and explicitly redirect/forward its standard input, output, and error through the owner.
5. Replace the nonfunctional PowerShell console-input bridge with a test-owned loopback control socket. The first socket attempt connected but START timed out because awaiting `server.close(callback)` also awaited the accepted socket; stop accepting without awaiting the live channel.
6. The control socket completed the first-child story through normal STOP; exact cleanup then rejected the JSON registry record as if it were the raw child value. Parse and validate the existing `{kind,value}` record before invoking the unchanged exact marker/PID cleanup.
7. The full story reached worker settlement, where the deliberately process-owned test socket reset as Node exited. Treat only `ECONNRESET` as expected settlement; fail pending commands on every other socket error.
8. Handle the expected reset on both the socket and its readline projection; the full focused story passed every phase with zero residue.

## Regression test

Run trusted Node 24/pnpm focused Playwright with one worker, then TypeScript and exact residue gates.

## Fix

The production-function owner PowerShell directly launches the exact registered Node Process. A bounded loopback socket carries only the test-control protocol, while the production maintenance pipe remains unchanged. Owned-child cleanup validates and stops the exact marker/PID even if the owner exits unexpectedly. Focused Playwright passed in 39.7 seconds with the story at 22.1 seconds.

## Wider check

All owner/SYSTEM pipe, task, runtime/container, Funnel, proof ordering, browser story, and residue phases rerun after the direct-owner correction.
