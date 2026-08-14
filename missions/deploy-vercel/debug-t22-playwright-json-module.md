# Debug: T22 Playwright JSON module loading
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

Trusted Node 24/pnpm Playwright exited 1 before global setup or the focused test with `TypeError: Module .../policy/editorial-policy.json needs an import attribute of type: json` after the new E2E module graph imported hybrid worker code.

## Reproduction

1. Keep the T22 global fixture import of `validateMaterializerRoleAuthority` from `worker/hybrid/wake-server.ts` and the spec's production runtime imports.
2. Run the focused Playwright command.

Result: native ESM rejects the existing attribute-free JSON import before any test output.

## Hypotheses

- H1: the unnecessary fixture-level wake-server import alone pulls the JSON-importing production graph into Playwright's global-setup loader. Confirm/refute by replacing only that imported pure validator with an exact local test DTO check and rerunning.
- H2: even without the global-fixture import, the spec's required production worker imports pull the same graph into Playwright's test loader. Confirmed if H1's one-variable change preserves the exact error.
- H3: the worker graph must run behind a test-owned loader/process boundary already compatible with the repository's production TypeScript/JSON conventions. Test only if H2 is confirmed; production JSON/import semantics remain off-limits.

## Root cause

H1 moved the failure past global setup but did not eliminate it; H2 confirmed the spec's static worker imports still entered the native Playwright loader. H3 confirmed the repository `tsx` loader accepts the unchanged production graph and JSON semantics.

## Fix attempts (counter)

1. Remove the unnecessary fixture-level worker import and perform the exact role DTO validation locally. Result: global setup completed, then test collection failed with the same JSON attribute error; H2 confirmed.
2. Probe the unchanged runtime through repository `tsx`. Result: import succeeded under trusted Node 24.
3. Keep Playwright-parent production imports type-only and run the runtime graph in a registry-owned test child loaded with direct `node --import tsx`. Production modules, JSON, and interfaces remain unchanged.

## Regression test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: the trusted focused Playwright command must reach global setup and the browser story while still executing production worker interfaces.
Pre-fix result: loader exits before setup.
Post-fix result: Playwright collected two tests, ran the full browser story, and passed it.

## Fix

The parent uses type-only worker imports; the owned child dynamically imports and exercises production runtime interfaces through repository `tsx`.

## Wider check

Trusted TypeScript exited 0; focused Playwright passed 1 with the opt-in Docker test skipped; zero child/registry residue.
