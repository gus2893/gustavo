# Debug: T15 startup/stop narrowing
**Originated during:** mcax-execute T15 Stage B
**Status:** fixed

## Symptom (one sentence)

Running the trusted `pnpm exec tsc --noEmit` command after the startup-abort change reliably returned `worker/hybrid/runtime.ts(1481,13): error TS2367: This comparison appears to be unintentional because the types '"READY" | "STARTING"' and '"STOPPING"' have no overlap.`

## Reproduction

1. Prepend the trusted Node 24 runtime directory to `PATH`.
2. Run the trusted Node executable with the trusted pnpm JS entrypoint and `exec tsc --noEmit`.

Result: TypeScript rejects the startup catch guard that preserves a concurrently established `STOPPING` state.

## Hypotheses

- H1: TypeScript narrows the captured mutable state from the synchronous assignments visible in the startup closure and does not model mutation by `stop()` across awaited operations. Confirmed by the diagnostic's `READY | STARTING` inferred union even though `stop()` can set `STOPPING` while a startup await is pending.
- H2: `STOPPING` is absent from the declared controller state. Refuted because `HybridControllerState` explicitly includes `STOPPING`, and stop assigns it.

## Root cause

Control-flow analysis does not account for the asynchronous sibling `stop()` mutation when narrowing the closure-captured state inside startup's catch. The runtime behavior is intentional; only the compiler's local narrowed view is incomplete.

## Fix attempts (counter)

1. Snapshotted the asynchronously mutable controller state into one variable with its declared union before comparing it with `STOPPING`: fixed.

## Regression test

File: `worker/hybrid/runtime.ts`
Description: the repository TypeScript compilation is the exact regression gate; startup/stop promise-gated runtime tests protect the asynchronous behavior.
Pre-fix result: failing with TS2367 at line 1481.
Post-fix result: passing.

## Fix

The startup catch now reads the runtime value once as `HybridControllerState`; it preserves `STOPPING` established by concurrent shutdown and otherwise transitions the failed startup to `STOPPED`.

## Wider check

Trusted `tsc --noEmit`, focused hybrid-worker tests (27/27), and both PowerShell 5.1 AST parses are green.
