# Debug: T30 local production authentication
**Originated during:** mcax-execute T30 Stage A
**Status:** fixed

## Symptom (one sentence)

The production Compose app at `http://localhost:3000` rejected invite, chat, and memory mutations with HTTP 403 and issued a Secure cookie that a loopback HTTP browser could not return.

## Reproduction

1. Set `NODE_ENV=production`, `GUSTAVO_DEPLOYMENT_PROFILE=local-mvp-v1`, and `GUSTAVO_APP_ORIGIN=http://localhost:3000`.
2. Submit authenticated invite, conversation, and memory mutation requests from that origin.
3. Inspect the response status and session cookie.

Result before the fix: all three mutations returned 403; production invitation cookies were always `__Host-gustavo-session; Secure`.

## Hypotheses

- H1: production routes ignored the configured loopback origin. Confirmed: each mutation passed no configured origin to `assertRequestOrigin`, which selected the canonical public origin.
- H2: production cookie policy was coupled only to `NODE_ENV`. Confirmed: session cookie name and Secure state did not distinguish local production from public production.
- H3: the Compose network prevented the request. Refuted for this symptom by direct route reproduction without Docker networking.

## Root cause

Production origin and cookie decisions had no explicit deployment profile. They therefore treated every optimized production build as the canonical public HTTPS deployment, even when Compose deliberately exposed only loopback HTTP.

## Fix attempts (counter)

1. Added one centralized, versioned local deployment profile with strict loopback-origin validation and profile-aware cookie policy; route regressions passed.

## Regression test

Files: `tests/auth/invitation-route.test.ts`, `tests/conversations/native-history.test.ts`, `tests/privacy/forget-propagation.test.ts`, and `tests/infra/local-runtime.test.ts`.

The tests cover local invite/cookie behavior, local chat and memory mutations, canonical public-production isolation, rejected non-loopback HTTP, and split internal/outbound Compose networks.

## Fix

- `lib/server/auth/sessions.ts` centralizes production origin and cookie selection.
- Memory and export safe-GET checks use the same resolved application origin.
- Compose explicitly selects `local-mvp-v1` and keeps data services solely on the internal backend network.

## Wider check

- Node 24.7 focused auth, conversation, privacy, and infrastructure suites: 73 assertions passed.
- Node 24.7 TypeScript and production Next build: passed.
- Docker Compose canonical config parsing and `git diff --check`: passed.
