# Debug: T15 control proof confusion
**Originated during:** mcax-execute T15 Stage A self-review
**Status:** fixed

## Symptom (one sentence)

The readiness client transmits its control nonce to whichever process owns the loopback port and accepts an unkeyed digest of that same value, so a hostile incumbent listener can synthesize the expected identity response and enable Funnel.

## Reproduction

1. Inspect the launcher's readiness request in `scripts/start-hybrid-worker.ps1`: the `x-gustavo-worker-control` header is the raw per-launch nonce.
2. Inspect the readiness response in `worker/hybrid/wake-server.ts`: `nonceDigest` is plain SHA-256 of the transmitted value.
3. An incumbent listener reads the header, hashes it, and returns the expected service/digest shape without the worker ever starting.

Result: the request itself contains everything an unrelated listener needs to forge the accepted response.

## Hypotheses

- H1: A bearer nonce plus its unkeyed digest proves only possession after disclosure, not worker identity. Confirmed because both the response algorithm and its complete input are visible to the incumbent listener.
- H2: Loopback binding alone prevents an incumbent from observing the nonce. Refuted because the readiness request is delivered to the incumbent process that already owns the exact loopback port.
- H3: A domain-separated challenge/HMAC exchange can prove shared launch authority without transmitting the secret. To be tested with reflection, replay, method, and path adversarial cases.

## Root cause

The original control protocol used the same raw secret as request authorization and then returned an unkeyed digest of that disclosed secret as server identity. It did not cryptographically distinguish a request authenticator from a response proof.

## Fix attempts (counter)

1. Added the challenge/HMAC protocol using modern static crypto helpers: protocol tests passed, but an explicit Windows PowerShell 5.1 probe proved `RandomNumberGenerator.Fill` and `CryptographicOperations` are unavailable in the scheduled task runtime. The protocol is retained; only those helper implementations require a portable replacement.
2. Replaced the unsupported helpers with `RandomNumberGenerator.Create().GetBytes()` and a manual fixed-time byte comparison: fixed; an explicit Windows PowerShell 5.1 HMAC probe matched Node's tag output.

## Regression test

File: `tests/infra/hybrid-worker.test.ts`
Description: prove the raw secret is absent from request headers, accepted proof is not a reflected request tag, and replay/wrong method/wrong path bindings are rejected.
Pre-fix result: three protocol tests failed with 401 under the old bearer protocol; the independent PowerShell 5.1 compatibility assertion then failed on the two unsupported crypto APIs.
Post-fix result: passing (14/14 focused tests).

## Fix

`worker/hybrid/wake-server.ts` authenticates a fresh bounded challenge with a request-domain HMAC bound to method and path, rejects replay, and returns a distinct response-domain HMAC. `scripts/start-hybrid-worker.ps1` generates each challenge, never transmits the shared secret, and verifies the response proof with Windows PowerShell 5.1-compatible crypto.

## Wider check

Trusted `tsc --noEmit`, focused hybrid-worker tests (14/14), both PowerShell AST parses, related T6/T7/T14 tests (160 passed, 3 skipped), an explicit Windows PowerShell 5.1/Node HMAC parity probe, and `git diff --check` are green.
