# Production launch checklist

This is the final operator gate for exposing Gustavo at `https://gustavo.lol`.
Check every item with dated evidence from the deployed revision. A green local
MVP or production-readiness E2E does not by itself authorize public launch.

## Application and local health

- [ ] Node 24, pnpm 11, PostgreSQL, Valkey, web, and worker use the reviewed
  locked versions; `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm build` pass.
- [ ] `pnpm mvp:start` reports healthy `web`, `worker`, `postgres`, and `valkey`
  services; PostgreSQL and Valkey have no public host ports.
- [ ] An authenticated `GET /api/operator/health` returns `200`,
  `private, no-store`, bounded aggregate metrics, and no identifiers, symbols,
  source text, ciphertext, or secrets. An unauthenticated request returns `401`.
- [ ] The browser smokes in `docs/SMOKE_TEST.md` pass. Test fixtures remain
  disabled in Compose and fail closed under `NODE_ENV=production`.

## Recovery and cache loss

- [ ] A fresh encrypted backup passes `infra/backup/verify.ps1`; record its
  immutable generation, schema version, event high-water, and key version.
- [ ] A restore into a new isolated database matches the authenticated schema
  version and event high-water, then the drill database and plaintext temporary
  files are removed.
- [ ] Backup and restore identities are separate and least-privilege; object
  generations are immutable and the backup encryption key is stored outside the
  database, object store, repository, and application environment.
- [ ] After Valkey loss/restart, PostgreSQL-backed rebuild and startup prewarm
  complete and source history, Challenge state, handoffs, and scheduled work
  remain intact.

## Performance and metrics

- [ ] Queue age, projection freshness, database commit latency, cache
  hit/miss/fallback/divergence, verified rebuilds, recall, and model latency/cost
  have alert thresholds and a named responder.
- [ ] The opt-in benchmark in `docs/PERFORMANCE.md` passes with actual counts of
  at least 1,000,000 `events` and 1,000,000 `memory_records`, 200 measured runs,
  warm recall p95 at most 250 ms, cached handoff p95 at most 100 ms, and zero
  unbounded candidate scans on the intended host.

As of August 12, 2026, the million-projected-row item is **not verified**. The
10,003-memory calibration passed, but three full projected-million attempts did
not reach measurement within the gate. Do not mark performance ready from the
smaller calibration or the earlier event-only million run.

## Public exposure, DNS, and TLS

- [ ] A hardened reverse proxy or outbound tunnel terminates authenticated TLS;
  direct router port-forwarding is not the default design.
- [ ] Squarespace DNS points only to the reviewed HTTPS entry point. PostgreSQL,
  Valkey, worker, operator-health, backup, test, seed, and debug interfaces are
  not publicly exposed.
- [ ] `https://gustavo.lol` uses a valid renewing certificate, redirects HTTP to
  HTTPS, sets the production Secure `__Host-` session cookie, and serves the
  canonical origin without mixed content.
- [ ] Rate limits, per-account quotas, queue backpressure, request-size bounds,
  and an emergency public-ingress disable procedure are tested.

## Safety, privacy, and legal

- [ ] Public HTML, scripts, API bodies, streams, logs, and metrics contain no
  protected account text or browser-usable key material; authorization occurs
  before retrieval, ranking, graph traversal, cache access, and DTO projection.
- [ ] Challenge surfaces show the exact label
  `SIMULATION ONLY — NOT A REAL TRADE`; public language contains no real-order,
  broker, copy-trade, `buy now`, or `sell now` behavior.
- [ ] Market-data licensing and redistribution terms are approved; observation
  time, session state, source, and delayed/provisional freshness are visible.
- [ ] Privacy policy, terms, educational-not-advice language, retention/deletion
  process, and incident notices receive current legal review.

## Secrets and incident response

- [ ] Database, event-root, cursor, cache, operator-health, provider, tunnel, and
  backup credentials are unique, external to Git, access-controlled, and tested
  for rotation. Old decryption keys remain available only for their retention
  window.
- [ ] Document the on-call owner, severity levels, evidence-preservation rules,
  credential-revocation order, user-notification decision, recovery target, and
  post-incident review owner.
- [ ] Drill: disable ingress, revoke sessions/provider tokens, preserve
  append-only audit evidence, restore from the latest verified generation,
  rebuild disposable projections/caches, validate public redaction, and record
  the new event high-water before reopening.
