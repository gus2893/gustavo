# Debug: T22 Stage A PowerShell command length
**Originated during:** mcax-execute T22 Stage A maintenance correction
**Status:** fixed

## Symptom (one sentence)

The focused story reached the production-function maintenance launcher but Windows rejected the encoded script argv with `spawn ENAMETOOLONG` before creating the named pipe.

## Reproduction

Run the trusted Node 24/pnpm focused Playwright story with one worker.

Result: exit 1 after 31.6 seconds at the trusted Windows PowerShell spawn using `-EncodedCommand`.

## Hypotheses

- H1: extracting all unchanged production maintenance/client/control functions exceeds Windows' process command-line bound, independent of script validity.

## Evidence

- Node reported `spawn ENAMETOOLONG` before PowerShell executed.
- The same harness passed TypeScript and the failure preceded pipe, client, Task Scheduler stub, Funnel stub, and worker stop activity.
- Moving the script bytes off argv is the only changed variable.

## Root cause

H1 confirmed: the encoded script exceeded Windows' argv capacity.

## Fix attempts (counter)

1. Store the generated, nonce-free harness in one canonical `%TEMP%` direct-child `.ps1`, register it in the fixture ownership registry, apply owner-only handling, invoke trusted Windows PowerShell with `-File`, and remove/prove absence in `finally`.

## Regression test

Command: trusted Node 24/pnpm focused Playwright story with `--workers=1`, followed by the owned-residue gate.

Expected: unchanged production functions execute through the real named pipe, the exact launcher path is absent afterward, and the ownership registry is empty.

## Fix

Only the transport of test-owned script text changed. The control nonce is inherited through the launcher's minimal environment and never appears in file content or argv.

## Wider check

TypeScript, focused Playwright, diff, and process/path/registry residue checks run after the correction.
