# Prompt update: durable Brain history and local-first scale

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** approved
**Approval status after:** needs re-approval

## Change description

After approving one account, one stable Brain, and one continuous chat, the user required Tape to preserve everything discussed with every individual Brain, run primarily from the user’s computer, support cloud backup, and be designed for future scale. The design now separates immutable source history from rebuildable memory projections, specifies a local container topology, and adds encrypted backup and restore requirements.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** A durable interaction timeline existed but complete retention and deployment ownership were not explicit.
  - **Now:** Complete per-account/per-Brain source history is mandatory; local operation and encrypted cloud recovery are product requirements.
- **A — Architecture**
  - **Was:** Generic append-only event and encrypted-message stores behind a BFF and worker.
  - **Now:** PostgreSQL is the local source of truth, workers use a durable queue, application processes are stateless, and source events are account-keyed and cursor-paginated.
- **I — Interaction and event model**
  - **Was:** Canonical events and shared audit fields were defined.
  - **Now:** The exact retained evidence is defined, and summaries, embeddings, search indexes, and context checkpoints are explicitly rebuildable projections.
- **D — Local deployment, durability, and scale**
  - **Was:** No explicit local runtime, backup protocol, or scale path.
  - **Now:** Docker Compose local runtime, external durable volumes, encrypted S3-compatible backup, integrity verification, restore drills, and horizontal scaling boundaries are specified.

## Sections of 01-story.md updated

- Added operator stories for durable complete history and self-hosted recovery.
- Added acceptance criteria for full source retention, rebuildable derived memory, local deployment, encrypted cloud backup, restore verification, and scale-safe processing.

## Impact

### Plan tasks invalidated

- T1 repository/application scaffold: must include local Compose topology and durable volumes.
- T2 data model: must distinguish immutable source events, encrypted message bodies, and rebuildable projections.
- T3 orchestration: must use durable idempotent jobs and transactional event publication.
- T4 conversation UI/API: must support cursor pagination over the complete authorized transcript.
- T5 memory retrieval: must build summaries/search indexes without replacing source history.
- T6 security: must add key versioning, backup credential isolation, and deletion-by-key-destruction behavior.
- T7 operations: must add backup scheduling, manifests, integrity checks, retention, monitoring, and restore drills.
- T8 scalability: must add quotas, backpressure, stateless instances, and partition-ready database access.

### Tests that must change

- `tests/events/history.test.ts` — prove all canonical source events remain queryable in order and corrections append rather than overwrite.
- `tests/history/projections.test.ts` — prove summaries and indexes can be rebuilt solely from source events.
- `tests/conversations/pagination.test.ts` — prove a long account history is complete across stable cursors.
- `tests/jobs/idempotency.test.ts` — prove retries cannot duplicate Brain responses, transmissions, debates, or winner decisions.
- `tests/security/account-isolation.test.ts` — prove one account cannot read another account’s history.
- `tests/backup/manifest.test.ts` — validate checksums, schema version, high-water mark, and key version.
- `tests/backup/restore.test.ts` — restore an isolated database and compare event counts/hashes.
- `tests/deployment/compose.test.ts` — verify the local stack boots without a hosted runtime or database.

### Code files that must change after approval

- `infra/compose.yaml` — define local web, worker, PostgreSQL, queue, networks, health checks, and volumes.
- `infra/backup/*` — add consistent encrypted backup, verification, retention, and restore tooling.
- `db/schema/*` — add append-only event, encrypted body, projection checkpoint, outbox, and backup-audit structures.
- `lib/server/events/*` — enforce ordered idempotent appends and integrity metadata.
- `lib/server/history/*` — reconstruct and paginate full authorized history.
- `lib/server/crypto/*` — add per-conversation keys, key versions, and controlled crypto-shredding.
- `lib/server/orchestration/*` and `worker/*` — add durable jobs, leases, idempotency, and backpressure.
- `app/api/feed/stream/route.ts` — stream durable projected events without becoming the source of truth.
- Operator documentation — add local startup, backup configuration, monitoring, and restore-runbook instructions.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

`mcax-plan` after the user explicitly approves this revised durability, deployment, and scale design.
