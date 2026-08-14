# Debug: T21 trusted Vercel bootstrap harness

**Originated during:** mcax-execute T21 Stage A trusted-Vercel remediation
**Status:** fixed

## Symptom

The Windows behavior test launched trusted Node through
`pnpm exec -- <absolute-node> --input-type=module --eval ...`, received exit 0
with empty stdout, and then failed while parsing the expected JSON proof.

## Reproduction

Run the focused test matching `effective inner Vercel PATH`. The static
trusted-boundary test passes, while the behavior test reports
`SyntaxError: Unexpected end of JSON input` after the child returns status 0
and empty stdout.

## Hypotheses

- H1: pnpm or Node drops the eval program/arguments when the executable is an
  absolute Windows path. Refuted by a direct minimal probe: the same trusted
  Node and pnpm entry point printed exact `process.argv` and exited 0.
- H2: the multiline eval program is truncated at the first newline by pnpm's
  Windows command boundary. Confirmed by single-variable program variants.
- H3: PATH reset prevents the local proof command from running. Refuted before
  reaching PATH reset: a two-line stdout program printed only its first line's
  marker, while a one-line program printed normally.

## Investigation log

1. Directly invoked trusted Node, trusted pnpm, `exec --`, the same absolute
   Node, `--input-type=module`, and `--eval` with a minimal argv printer.
   Result: stdout contained the expected Node path and two forwarded arguments;
   exit 0. This isolates pnpm/Node forwarding as working.
2. Held the executable and arguments fixed while varying only the eval program:
   a one-line stdout program printed normally; a two-line stdout program printed
   only the first line's marker; a multiline import/argv program whose first
   line produced no output exited 0 with empty stdout; and a multiline block
   whose first line was syntactically incomplete failed on that first line.
   This proves the Windows pnpm command boundary passes only the first physical
   line of the eval argument.

## Root cause

The documented bootstrap and the behavior harness supplied multiline source as
one `--eval` argument through pnpm's Windows execution boundary. That boundary
executed only the first physical line. The first bootstrap line was an import,
so the child exited successfully without resetting PATH or reaching the proof.
The security boundary must be a single physical JavaScript line.

## Fix attempts

1. Kept the same logic and invocation but encoded both the bootstrap and its
   test replacement as one physical JavaScript line. Result: the two-test
   trusted-boundary slice passed; 45 tests were skipped; exit 0.

## Fix

- `docs/VERCEL_DEPLOYMENT.md`: retain the trusted Node/Corepack/pnpm admission
  and all PATH-reset/import logic, but supply the eval bootstrap as one physical
  line.
- `tests/deployment/vercel-hybrid.test.ts`: keep the same behavioral assertions
  and encode only the replacement proof tail as one physical line.

The behavior test now proves the effective inner PATH equals the trusted child
PATH, contains no relative or absolute `node_modules/.bin`, and resolves bare
`git.exe` first to the exact trusted Git executable.
