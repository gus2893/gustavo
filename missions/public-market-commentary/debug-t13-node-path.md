# Debug: T13 bundled Node PATH boundary
**Originated during:** mcax-execute T13
**Status:** fixed

## Symptom (one sentence)

Running the full suite through the bundled `pnpm.cmd` without first prepending the bundled Node directory to `PATH` was expected to pass under Node 24, but exited 1 with three authentication failures, led by `TypeError: argon2 is not a function` and `expected 'undefined' to be 'function'`.

## Reproduction

1. From the repository root, run `& 'C:\Users\gusta\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' vitest run tests/auth/runtime-compatibility.test.ts` while `C:\Program Files\nodejs` precedes the bundled Node directory in `PATH`.
2. Observe that the bundled wrapper starts pnpm, but the Vitest child resolves `node` from the unchanged `PATH`.

Result: the focused test reports 1 failed test because `typeof argon2` is `undefined`; the initial full suite reported 3 failed / 244 passed tests because the same runtime mismatch also broke invitation hashing and its route test.

## Hypotheses

- H1: Node 24.14.0 in the bundled runtime lacks native Argon2. Refuted by invoking that executable directly: it reports `{"version":"v24.14.0","argon2":"function"}`.
- H2: The bundled pnpm wrapper selects Node 24 for pnpm itself but leaves child-command Node resolution to the existing `PATH`. Confirmed by the wrapper contents, the system executable reporting `{"version":"v22.14.0","argon2":"undefined"}`, and the focused test changing from red to green when only the bundled directories are prepended to `PATH`.

## Root cause

The fallback `pnpm.cmd` launches pnpm with its adjacent bundled Node executable but does not modify `PATH` for commands spawned by pnpm. The machine's pre-existing `PATH` resolves child `node` commands to `C:\Program Files\nodejs\node.exe` v22.14.0, which has no native `node:crypto.argon2`. The Gustavo package contract requires Node `>=24.7.0 <25`, and the bundled Node v24.14.0 satisfies that contract.

## Fix attempts (counter)

1. Prepend `dependencies\node\bin` and `dependencies\bin\fallback` to `PATH` before invoking pnpm: the runtime-compatibility test changed from 1 failed to 1 passed, and the full suite changed from 3 failed / 244 passed to 247 passed.

## Regression test

File: `tests/auth/runtime-compatibility.test.ts`

Description: asserts both the declared Node engine range and native Argon2 availability. With the system Node path it fails; with the bundled Node path it passes.

## Fix

No product code changed. Verification commands now explicitly prepend the bundled Node and fallback pnpm directories to `PATH` so pnpm and every spawned process use the required runtime.

## Wider check

Commands run after the environment correction: `pnpm vitest run tests/auth/runtime-compatibility.test.ts` (1 passed), the initial corrected `pnpm vitest run` (19 files, 247 tests passed), and the final T13 `pnpm vitest run` (19 files, 259 tests passed) under Node v24.14.0 / pnpm v11.16.0.

## Lessons / design implications

Selecting a Node executable for a package-manager wrapper does not guarantee that child tools inherit that executable. Runtime verification must set the toolchain `PATH` boundary, not only call the bundled wrapper by absolute path.
