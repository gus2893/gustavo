# Debug: T22 Green type inference
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

Trusted Node 24 `pnpm exec tsc --noEmit` exited 1 after the T22 Green harness was added: the scrubbed web environment inferred as `{ NODE_ENV: string }`, `runtime.web` lost narrowing after assignment, and four fake runtime-container `signal` parameters were implicit `any`.

## Reproduction

1. Run the trusted bundled Node/pnpm TypeScript no-emit command.
2. Observe TS2339/TS2769/TS18048 in `tests/e2e/fixtures.ts` and TS7006 in `tests/e2e/gustavo-hybrid-production.spec.ts`.

Result: typecheck exits 1 before browser execution.

## Hypotheses

- H1: spreading `process.env` without an explicit target type narrows the object to its explicitly assigned `NODE_ENV` property, so test-only key deletion and `spawn`'s `ProcessEnv` overload fail. Confirmed by the errors naming the inferred `{ NODE_ENV: string }` type.
- H2: assigning `spawn(...)` directly to an optional aggregate field does not preserve narrowing across the later listener and readiness calls. Confirmed by the three `runtime.web` possibly-undefined errors.
- H3: contextual typing is lost across the frozen object implementation of `HybridContainerController`. Confirmed by TS7006 on each method parameter even though the object is assigned to the interface.

## Root cause

The harness relied on contextual inference across spread/delete, an optional aggregate property, and a frozen interface implementation. Strict TypeScript intentionally does not retain the required narrowings across those boundaries.

## Fix attempts (counter)

1. Annotate the scrubbed child environment as `NodeJS.ProcessEnv`, bind the spawned child to a required local before storing it on the partial cleanup aggregate, and annotate the four abort signals: typecheck exits 0.

## Regression test

File: `tests/e2e/fixtures.ts`, `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: the exact project TypeScript no-emit command accepts the test harness without casts that weaken runtime validation.
Pre-fix result: 10 compiler errors, exit 1.
Post-fix result: trusted TypeScript no-emit exits 0.

## Fix

`tests/e2e/fixtures.ts` now preserves `ProcessEnv` and child-process narrowing explicitly. `tests/e2e/gustavo-hybrid-production.spec.ts` explicitly types the production-interface abort signals. No runtime behavior changed.

## Wider check

Trusted Node 24 `pnpm exec tsc --noEmit` â†’ exit 0.
