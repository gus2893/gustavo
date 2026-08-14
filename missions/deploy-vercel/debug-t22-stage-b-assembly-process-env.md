# Debug: T22 Stage B assembly ProcessEnv
**Originated during:** mcax-execute T22 Stage B shared production assembly
**Status:** fixed

## Symptom (one sentence)

TypeScript rejected the T22 child assembly's minimal environment because this repository augments `NodeJS.ProcessEnv` with a required `NODE_ENV` field.

## Reproduction

Run trusted Node 24/pnpm `tsc --noEmit` after replacing the duplicated child composition with the shared factory.

Result: exit 1 in 2.2 seconds with TS2741 at the test-owned environment object.

## Root cause

The minimal environment contained every configured worker variable, but omitted the repository-required `NODE_ENV` property even though the shared factory does not read it.

## Fix

Add explicit test-only `NODE_ENV: "test"` to that environment. No production behavior changes.

## Regression test

Rerun trusted Node 24/pnpm `tsc --noEmit`, the relevant hybrid infra suite, and the focused story.
