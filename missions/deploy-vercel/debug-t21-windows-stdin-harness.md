# Debug: T21 Windows stdin behavior harness

**Originated during:** mcax-execute T21 Stage A remediation
**Status:** fixed

## Symptom (one sentence)

The focused deployment test invoked Windows PowerShell 5.1 with `-Command -`
and expected the documented async-IIFE probe harness to print
`MIGRATED_AUTHORITY_ONLY_EMPTY`, but the process exited 0 with empty stdout.

## Reproduction

1. Run the trusted Node/pnpm focused test matching
   `executes the documented inventory probe`.
2. The test sends a here-string program to `powershell.exe -Command -`; that
   program pipes the extracted, dependency-stubbed probe to `tsx -`.

Result: the assertion expected `MIGRATED_AUTHORITY_ONLY_EMPTY\n`, received an
empty string, and reported PowerShell exit code 0.

## Hypotheses

- H1: Windows PowerShell 5.1's `-Command -` command reader does not execute this
  multiline here-string/pipeline as one completed program. Confirmed by the
  exit-0/empty-stdout boundary and by the same harness passing when supplied as
  one explicit `-Command <program>` argument.
- H2: `tsx -` does not execute the async IIFE from stdin. Refuted when the
  explicit PowerShell command form produced the exact marker through the same
  `tsx -` pipeline.

## Root cause

The test harness used PowerShell's stdin command-reader mode for the outer test
process while also testing stdin for the inner `tsx` process. The outer
`-Command -` boundary consumed the multiline command without executing the
here-string pipeline as one program. The runbook's relevant boundary is the
inner pipeline into `tsx -`, so the harness must pass its outer PowerShell
program atomically while retaining stdin for `tsx`.

## Fix attempts (counter)

1. Replace only the harness's outer `-Command -` invocation with explicit
   `-Command <program>`; retain `$Probe | ... tsx -` unchanged. Result: pass.

## Regression test

File: `tests/deployment/vercel-hybrid.test.ts`

Description: extracts the documented inventory probe, stubs only its database
dependencies, runs the same probe through a Windows PowerShell 5.1 pipeline into
`tsx -`, and requires exact stdout plus empty stderr.

Pre-fix result: exit 0 with empty stdout, assertion failed.

Post-fix result: one selected test passed, 39 skipped, exit 0.

## Fix

- `tests/deployment/vercel-hybrid.test.ts`: pass the outer PowerShell harness as
  one explicit command argument; product and runbook behavior are unchanged.

## Wider check

The five-test Stage A remediation slice passed after the fix: five passed,
35 skipped, exit 0.

## Lessons / design implications

The debug artifact was explicitly approved and created after the first fix.
That ordering is a process deviation: the unexpected test failure was fixed
before the required adjacent debug artifact had separate file-scope authority.
No product or runbook change was made for this harness-only symptom.
