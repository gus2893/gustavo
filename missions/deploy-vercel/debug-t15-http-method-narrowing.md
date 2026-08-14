# Debug: T15 HTTP method narrowing
**Originated during:** mcax-execute T15
**Status:** fixed

## Symptom (one sentence)

Running the trusted `pnpm exec tsc --noEmit` command was expected to pass, but reliably returned `worker/hybrid/wake-server.ts(372,9): error TS2322: Type 'string | undefined' is not assignable to type 'string'.`

## Reproduction

1. Prepend the trusted Node 24 runtime directory to `PATH`.
2. Run the trusted Node executable with the trusted pnpm JS entrypoint and `exec tsc --noEmit`.

Result: TypeScript rejects `request.method` where the normalized wake request requires a `string`.

## Hypotheses

- H1: The compound route guard does not narrow Node's `request.method: string | undefined` across the asynchronous request handler. Confirmed by inspecting the rejected expression and the invalid-route branch, which already normalizes the same value with `?? ""`.
- H2: The control nonce remained optional after option validation. Refuted because the reported line is the wake request `method` field, not a nonce use.

## Root cause

`worker/hybrid/wake-server.ts` used `request.method` directly after a compound route/method guard. Although every accepted route logically requires a matching method, TypeScript does not derive a stable non-undefined string from that boolean expression.

## Fix attempts (counter)

1. Normalized `request.method` once before the route guard and reused that stable string for both validation and dispatch: fixed.

## Regression test

File: `worker/hybrid/wake-server.ts`
Description: the repository TypeScript compilation is the regression gate because the defect exists only in static narrowing and is reproduced exactly by `tsc --noEmit`.
Pre-fix result: failing with TS2322 at line 372.
Post-fix result: passing.

## Fix

`worker/hybrid/wake-server.ts` now derives `const method = request.method ?? ""` once and uses it for route checks and dispatch.

## Wider check

Trusted `tsc --noEmit`, focused hybrid-worker tests (14/14), both PowerShell AST parses, related T6/T7/T14 tests (160 passed, 3 skipped), and `git diff --check` are green.
