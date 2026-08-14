# Debug: T15 trusted-process output
**Originated during:** mcax-execute T15 Stage B
**Status:** fixed

## Symptom (one sentence)

The Windows hostile-environment behavior probe launched the trusted-process helper through Windows PowerShell 5.1, returned process status 0, but emitted no captured child stdout, causing JSON parsing to fail.

## Reproduction

1. Extract the `ConvertTo-TrustedArguments` and `Invoke-TrustedProcess` functions from `scripts/start-hybrid-worker.ps1`.
2. Run them under Windows PowerShell 5.1 with a trusted absolute Node executable, cleared explicit environment, exact working directory, and a child expression that writes JSON to stdout.
3. Observe empty stdout even though the outer PowerShell command reports status 0.

## Hypotheses

- H1: asynchronous redirected output is not drained before process disposal. Refuted by an isolated invocation in the current shell: the same helper captures `hello` with exit 0 and length 5.
- H2: an API used before child launch is unavailable under PowerShell 5.1's .NET Framework. Confirmed: the isolated run reports that `[IO.Path]` has no `IsPathFullyQualified` method; that method exists in newer .NET but not Windows PowerShell 5.1's runtime.
- H3: `powershell.exe -Command -` executes a multiline function-definition stream like a script. Refuted by an isolated PS5.1 probe: a single-line command runs and prints, while a multiline function definition plus invocation exits 0 without output. The behavior harness therefore masked the helper fix until it used one encoded script command.

## Root cause

Two issues compounded: `Invoke-TrustedProcess` used `[IO.Path]::IsPathFullyQualified`, which is unavailable in Windows PowerShell 5.1, and the test fed a multiline function definition through the line-oriented `-Command -` mode. The first was a production compatibility defect; the second prevented the corrected helper from being exercised.

## Fix attempts (counter)

1. Replaced the unavailable API with `IsPathRooted` plus canonical full-path equality: isolated helper output succeeds, but the encoded behavior test remained empty because the multiline stdin harness was not executing.
2. Passed the exact behavior script as Windows PowerShell's UTF-16LE `-EncodedCommand`: fixed.

## Regression test

File: `tests/infra/hybrid-worker.test.ts`
Description: a Windows-only behavior probe supplies hostile `NODE_OPTIONS`, a forbidden parent secret, and a hostile parent CWD, then requires the helper-launched trusted Node process to return JSON with only its explicit environment and exact working directory.
Pre-fix result: outer status 0 with empty stdout; JSON parsing fails.

## Fix

Both scripts now validate absolute process paths using PowerShell-5.1-compatible APIs. The regression harness executes one encoded script and additionally requires empty PowerShell stderr, so host diagnostics cannot masquerade as a successful child probe.

## Verification

- Targeted hostile-environment behavior probe: passed (1 passed, 28 skipped).
- Focused hybrid-worker suite: passed (29/29).
- Default Codex/T7 suite: passed (80 passed, 3 controlled-live tests skipped).
- PowerShell 5.1 parser: both setup and start scripts passed.
- TypeScript compiler: passed with no diagnostics.
