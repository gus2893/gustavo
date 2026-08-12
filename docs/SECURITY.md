# Security

## Threat model

Gustavo protects private account conversations, Node Brain memories, proposal sources, model inputs and outputs, session and invitation tokens, encrypted event bodies, and the shared simulated Challenge ledger. Relevant attackers include an unauthenticated visitor, one account attempting to read another account, a compromised browser, a malicious imported archive, an exposed build artifact, and an operator credential or model-provider key leak.

Authorization is enforced before retrieval, ranking, graph expansion, cache access, decryption, streaming, or DTO projection. Public responses contain deliberate metadata and irreversible placeholders only. Ciphertext and browser-usable decryption material are not public previews. PostgreSQL is authoritative; caches are scope-bound, versioned, disposable projections.

## Request and abuse controls

The CSRF model combines an exact Origin check on every state-changing browser request with a host-only session cookie. Public production accepts only the exact origin `https://gustavo.lol`; local MVP origin exceptions are explicit loopback configuration. Before public exposure, the reverse proxy must add Fetch Metadata defense in depth: reject `Sec-Fetch-Site: cross-site` for authenticated or mutating routes, allow `same-origin` and explicitly supported non-browser traffic, and never treat a missing header as a substitute for the application's mandatory Origin check.

The public-production cookie is exactly `__Host-gustavo-session` with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`, with no `Domain` attribute. Tokens are opaque, stored server-side only as hashes, rotated by creating a replacement session, and rejected after expiry, revocation, account disablement, or entitlement loss.

Before public exposure, rate limits must apply per source IP to public and invitation endpoints and per account/session to authenticated reads, writes, imports, exports, and streaming connections. Durable queues require hard depth, age, concurrency, retry, and payload limits. When limits are reached, the system must apply backpressure with bounded `429` or `503` responses and retry guidance; it must not create unbounded in-memory work or bypass durable commits.

## Secrets and key rotation

Secrets remain in server-only environment or OS-backed secret storage and never use `NEXT_PUBLIC_` names. Repository validation rejects common credential shapes without printing matched values. Root encryption keys, cache keys, provider credentials, and signing keys are separated by purpose and environment.

Key rotation creates a new version, makes new writes use that version, and rewraps data keys in bounded, auditable batches. Old key versions remain available only as long as required to complete verified rewrapping and restore checks. Rotation records contain identifiers and results, never secret values. Emergency rotation also revokes affected sessions, invitations, provider tokens, and deployment credentials.

## Incident response

On suspected disclosure or unauthorized access, stop public exposure, preserve audit evidence, revoke sessions and affected credentials, rotate keys, and determine the accounts, scopes, providers, backups, and time range involved. Verify public HTML, RSC, API responses, source maps, logs, caches, and backups for protected material. Notify affected people and authorities when the applicable policy or law requires it. Restore service only after containment, corrected authorization tests, credential rotation, and a documented review.

Production must disable test, fixture, seed, and debug endpoints. Database and queue ports are never exposed publicly. Public hosting requires HTTPS, hardened origin and proxy settings, verified backups, restore drills, monitoring, and a qualified legal review before public launch.
