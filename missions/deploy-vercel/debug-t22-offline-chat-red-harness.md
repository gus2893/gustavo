# Debug: T22 offline chat RED harness
**Originated during:** mcax-execute T22
**Status:** fixed

## Symptom (one sentence)

Trusted Node 24/pnpm Playwright ran `tests/e2e/gustavo-hybrid-production.spec.ts --workers=1`; the expected RED was a 30-second timeout waiting for `Node private fixture reply` with no controller running, but the test instead reached its 60-second timeout while `getByLabel("Message").fill(...)` repeatedly found the textarea disabled.

## Reproduction

1. Redeem a disposable invitation and click `Create account`.
2. Immediately call `page.goto("/chat")` without waiting for the account-creation navigation.
3. Try to fill the chat textarea.

Result: Playwright resolves the textarea but reports `element is not enabled` until the test timeout.

## Hypotheses

- H1: an OFFLINE bridge summary disables chat submission. Refuted by read-only inspection of `components/chat/Conversation.tsx`: the fieldset is disabled only when the client is not hydrated or `conversationId` is absent; bridge state changes status copy only.
- H2: the spec races account creation by navigating before its response/navigation installs the session and loads the continuous conversation. Confirmed: adding the same `/chat` navigation wait used by working repository E2E tests allowed submission and advanced the failure to the intended Node-reply assertion.
- H3: the account conversation projection fails for an independent database reason. Refuted: after the targeted navigation wait the private message was accepted and visible.

## Root cause

The new spec navigated away immediately after clicking `Create account`. That raced the account-creation response/navigation and could render `/chat` without an authorized continuous-conversation projection, leaving `conversationId` absent and the fieldset disabled. The bridge status was not the disabling authority.

## Fix attempts (counter)

1. Await the account-creation redirect to `/chat` before any explicit navigation: the premature disabled-fieldset failure disappeared and the run reached the exact intended 30-second missing-reply RED.

## Regression test

File: `tests/e2e/gustavo-hybrid-production.spec.ts`
Description: the RED harness must first submit and display the committed private message, then fail only because no local controller produces the Node fixture reply.
Pre-fix result: failing before submission because the account-creation navigation was not awaited.
Post-fix result: the private message is submitted and visible; the test fails only on the absent Node fixture reply after 30 seconds.

## Fix

`tests/e2e/gustavo-hybrid-production.spec.ts` now waits for the existing account-creation navigation authority before continuing.

## Wider check

Trusted Node 24/pnpm Playwright focused command: exact intended RED reached; one test failed only on missing `Node private fixture reply` after 30 seconds.
