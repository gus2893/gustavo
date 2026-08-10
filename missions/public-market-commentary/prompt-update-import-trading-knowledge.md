# Prompt update: import current trading knowledge

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** needs re-approval

## Change description

The user confirmed that all explicit information currently preserved in this task and repository that helps explain the trading mechanism should seed Gustavo's database-backed Main Brain memory. The design adds an idempotent, classified bootstrap import that preserves methodology and lessons without activating stale market states or obsolete CFT/execution behavior.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** New Gustavo thoughts and memories were durable, but legacy trading knowledge had no import contract.
  - **Now:** Explicit task/repository trading knowledge must enter through a provenance-preserving classified import.
- **K — Trading-knowledge bootstrap**
  - Added sources, lifecycle classes, known inventory, import keys, transaction behavior, freshness/activation gates, verification, and rollback.
- **I — Interaction events**
  - Added manifest, item import/classification/promotion/deactivation, and verification events.
- **N — Non-goals**
  - Prohibited activating stale/obsolete knowledge, fabricating unavailable context, or indexing prohibited execution behavior for normal retrieval.

## Sections of 01-story.md updated

- Added an operator story for seeding Main Brain memory from existing trading context.
- Added acceptance criteria for source scope, classification, historical freshness, CFT isolation, candidate review, idempotency, and verification.

## Impact

### Plan tasks invalidated

- T2 data model: add import manifests/items, lifecycle status, source provenance, review decisions, and deactivation links.
- T5 memory: enforce lifecycle/freshness filters and separate audit-only indexes from Main/Node retrieval.
- T7 migration: inventory and parse the current transcript export, docs, policy, schemas, state, templates, and paper-trade history.
- T8 verification: prove deterministic idempotency, complete provenance, stale-price isolation, and absence of prohibited active behavior.

### Tests that must change

- `tests/import/manifest.test.ts` — source counts, hashes, parser version, and high-water marks.
- `tests/import/idempotency.test.ts` — unchanged reruns are no-ops; changed sources create linked versions.
- `tests/import/classification.test.ts` — known structural, historical, deprecated, and prohibited fixtures receive the correct lifecycle.
- `tests/import/freshness.test.ts` — dated ETH/AVAX prices cannot become current state or satisfy an action gate.
- `tests/import/cft-isolation.test.ts` — CFT mappings/export/execution content is audit-only and absent from normal retrieval.
- `tests/import/promotion.test.ts` — candidate methodology needs an explicit reviewed event before canonical use.
- `tests/import/rollback.test.ts` — manifest deactivation removes active influence without deleting audit history.
- `tests/import/provenance.test.ts` — every imported memory points to a stable source locator and digest.

### Code files that must change after approval

- `db/schema/imports.sql` — manifests, items, classifications, reviews, and deactivation state.
- `lib/server/import/sources/*` — transcript, Markdown/JSON/schema, and historical-paper-trade adapters.
- `lib/server/import/classify/*` — lifecycle, freshness, sensitivity, and prohibited-behavior classification.
- `lib/server/import/write/*` — deterministic keys, transactions, provenance, and outbox work.
- `lib/server/import/verify/*` — manifests, hashes, totals, replay, and forbidden-active-memory checks.
- `lib/server/memory/read/*` — lifecycle/freshness filtering and audit-only index separation.
- `scripts/import-bootstrap.*` and `scripts/verify-import.*` — local operator commands with dry-run reports.
- `fixtures/import/*` — sanitized representative trading-methodology, ETH, AVAX, and prohibited-CFT fixtures.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

Continue planning after explicit approval of the classified trading-knowledge bootstrap, then finalize the scoring rubric and Challenge stage-rule template.
