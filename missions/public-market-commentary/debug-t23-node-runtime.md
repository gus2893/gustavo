# Debug: T23 full-suite Node runtime
**Originated during:** mcax-execute T23 Stage A re-verification
**Status:** fixed

## Symptom (one sentence)

The unchanged full suite passed 589 of 592 tests but failed three pre-existing authentication cases because the default shell resolved Node 22.14.0, which does not provide native `crypto.argon2`.

## Reproduction

1. Run `pnpm.cmd vitest run` with the default shell PATH.
2. Observe the package engine warning requiring Node `>=24.7.0 <25`.
3. Observe `tests/auth/runtime-compatibility.test.ts` report `crypto.argon2` as undefined and the two invitation flows fail downstream.

Result: 26 of 29 files and 589 of 592 tests passed; all failures shared the unsupported Node runtime root cause and were outside T23 behavior.

## Hypotheses

- H1: the shell selected an unsupported Node runtime without native Argon2id. Confirmed by the engine warning, `node --version` (`v22.14.0`), and the exact `crypto.argon2` assertion.
- H2: T23 changed authentication behavior. Refuted because T23 does not touch auth files and all failures were the direct consequence of the missing native API.

## Root cause

The default PATH selected system Node 22 instead of the approved cached Node 24 runtime required by the repository contract.

## Fix attempts (counter)

1. Prepend the approved cached Node runtime and fallback binaries to PATH: fixed. `node --version` reports `v24.14.0`; `pnpm.cmd --version` reports `11.16.0`.

## Regression test

Command: `pnpm.cmd vitest run tests/auth/invitation-redemption.test.ts tests/auth/invitation-route.test.ts tests/auth/runtime-compatibility.test.ts`
Post-fix result: 3 files and 7 tests pass under Node 24.14.0.

Command: `pnpm.cmd vitest run`
Post-fix result: 29 files and 592 tests pass under Node 24.14.0 in 752.77 seconds.

## Fix

- Verification environment only: prepend `C:\Users\gusta\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin` and `C:\Users\gusta\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback` to PATH.
- No production code changed.
