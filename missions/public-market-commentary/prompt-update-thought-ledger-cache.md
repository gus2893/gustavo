# Prompt update: database-backed thought ledger and cache hierarchy

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** needs re-approval

## Change description

The user required Gustavo to track everything through a database and cache everything needed for fast thought recall. The design now makes every observable thought artifact and state transition durable in PostgreSQL, defines a typed `ThoughtRecord`, and specifies fully rebuildable projection, distributed, and per-process caches. It explicitly stores concise auditable rationales rather than private hidden chain-of-thought.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** PostgreSQL source history and general memory caches were required.
  - **Now:** Every observable thought artifact must commit durably before influence or acknowledgement; caches are scope-bound, versioned, and disposable.
- **T — Thought ledger and cache architecture**
  - Added thought types, authoritative logical tables, transaction boundaries, three cache layers, typed keys, invalidation, consistency rules, prewarming, recovery, and observability.
- **I — Interaction events**
  - Added thought, projection-checkpoint, and cache-version events.
- **N — Non-goals**
  - Prohibited hidden chain-of-thought storage, cache authority, private cache reuse, and stale-cache decisions.

## Sections of 01-story.md updated

- Added an operator story for complete database reconstruction and fast cached access.
- Added acceptance criteria for `ThoughtRecord`, transaction durability, cache boundaries, privacy, rebuilding, prewarming, and metrics.

## Impact

### Plan tasks invalidated

- T2 data model: add thought records/sources, state versions, projection checkpoints, cache versions, and structured audit data.
- T3 write path: require event, thought, state reference, and outbox work in one transaction.
- T4 cache layer: define PostgreSQL projections, Valkey namespaces, process LRU, typed keys, TTLs, and single-flight behavior.
- T5 memory/context: source all cached packs from authorized versioned records and record recall provenance.
- T6 challenge: prohibit cached-only risk/accounting decisions and bind snapshots to ledger high-water marks.
- T7 operations: add cache rebuild, prewarm, invalidation monitoring, divergence checks, and fallback metrics.
- T8 security: add encrypted protected cache values and cross-scope cache-isolation verification.

### Tests that must change

- `tests/thoughts/transaction.test.ts` — required thought/event/outbox records commit atomically.
- `tests/thoughts/provenance.test.ts` — every rationale is concise, source-linked, scoped, and versioned.
- `tests/thoughts/no-chain-of-thought.test.ts` — schemas and prompts request decision summaries, not hidden reasoning traces.
- `tests/cache/keys.test.ts` — identity, scope, source version, policy version, and schema version are encoded.
- `tests/cache/isolation.test.ts` — private entries cannot cross accounts or visibility scopes.
- `tests/cache/invalidation.test.ts` — outbox-driven version advancement prevents stale reads.
- `tests/cache/rebuild.test.ts` — empty caches rebuild from PostgreSQL with matching high-water marks/hashes.
- `tests/cache/stampede.test.ts` — single-flight behavior bounds fallback load.
- `tests/cache/challenge-consistency.test.ts` — stale cache cannot alter paper orders, P&L, or pass/fail state.
- `tests/performance/cache-bench.test.ts` — hit rate, warm/cold p95, prewarm time, and fallback latency budgets.

### Code files that must change after approval

- `db/schema/thoughts.sql` — typed thought records, sources, visibility, state links, and supersession.
- `db/schema/projections.sql` — checkpoints, current-state projections, and cache-version pointers.
- `lib/server/thoughts/*` — validation, concise rationale persistence, provenance, correction, and supersession.
- `lib/server/cache/keys.ts` — typed scope/version-aware key construction.
- `lib/server/cache/read.ts` — authorization-first cache-aside reads and bounded fallback.
- `lib/server/cache/invalidate.ts` — outbox-driven version advancement and prewarm jobs.
- `lib/server/cache/crypto.ts` — protected value encryption and key-version handling.
- `worker/projections/*` and `worker/cache/*` — rebuild, refresh, invalidation, and prewarm processing.
- `scripts/rebuild-projections.*` and `scripts/prewarm-cache.*` — operator recovery tooling.
- Observability configuration — cache/database/outbox/freshness dashboards and alerts.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

Continue planning after explicit approval of the database-backed thought ledger and cache hierarchy, then finalize the scoring rubric and Challenge stage-rule template.
