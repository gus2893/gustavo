# Debug: T16 QStash signature control fixture
**Originated during:** mcax-execute T16
**Status:** fixed

## Symptom (one sentence)

The focused T16 adversarial Vitest command expected the exactly signed maintenance control request to verify, but `Receiver.verify` rejected it and `verifyMaintenanceRequest` returned `MAINTENANCE_REQUEST_UNAUTHORIZED`.

## Reproduction

1. Run the focused maintenance verifier and overlap/count tests with the bundled Node 24 and pnpm 11 runtimes.
2. Observe the valid-control verifier assertion fail while the independent overlap/count assertion reaches the core and passes.

Result: one failed, one passed; the failure originates at the receiver verification boundary.

## Hypotheses

- H1: The fixed test JWT is expired relative to the real clock used internally by `@upstash/qstash` `Receiver`. Confirmed by comparing the fixture expiry (`2026-08-13T12:59:59Z`) with the observed runtime clock (`2026-08-14T12:01:41Z`).
- H2: The fixed body or URL differs between the JWT and request. Not tested after H1 was confirmed; both are sourced from the same constants/helper arguments.
- H3: The signing key format is rejected. Not tested after H1 was confirmed; the same HS256 helper/key shape is already proven by `tests/bridge/qstash.test.ts`.

## Root cause

The regression fixture used `2026-08-13T12:00:00Z` for JWT `iat`/`exp`, while `Receiver.verify` intentionally checks registered JWT time claims against the runtime clock rather than the route's separately injected application-age clock. The JWT had expired before the test ran.

## Fix attempts (counter)

1. Replaced only the verifier fixture clock with the current runtime instant while retaining exact signed URL/body and route-level age validation: focused regression passed.

## Regression test

File: `tests/privacy/forget-propagation.test.ts`
Description: accepts the exact signed production URL/body and rejects wrong request URL, request body, or signed body.
Pre-fix result: valid control rejected because the JWT itself was expired.
Post-fix result: passing.

## Fix

`tests/privacy/forget-propagation.test.ts` now creates a currently valid JWT. Production validation remains unchanged.

## Wider check

Focused adversarial verifier plus overlap/count cases: 2 passed, 52 skipped, exit 0.
