# Prompt update: MVP first, improvements second
**Date:** 2026-08-12
**Triggered by:** user request
**Approval status before:** approved
**Approval status after:** approved (2026-08-12)

## Change description

The user requested a working MVP from the already-built system before continuing the remaining mission work as improvements. No approved capability is removed. Delivery is split into an earlier local MVP gate and a later production-hardening/improvement gate.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** Local deployment and encrypted cloud recovery were part of one undifferentiated completion target.
  - **Now:** The working local MVP is delivered first; backup/restore, scale verification, scheduling automation, and full proof follow as improvements required before public production launch.
- **D — Local deployment, durability, and scale**
  - **Was:** Local runtime, backup, and scale work had no intermediate release gate.
  - **Now:** Adds explicit working-MVP and improvement milestones.
- **Open assumptions**
  - **Was:** Backup requirements had no delivery-stage qualifier.
  - **Now:** They remain mandatory before public production launch but do not block the first working local MVP.

## Sections of 01-story.md updated

- Added acceptance criteria 88–90 defining the working-MVP gate, the improvement gate, and separate verification reports.
- Added a dated history entry preserving the sequencing change.

## Impact

### Plan tasks invalidated

- **T26:** Scope remains valid; finish and review the in-flight privacy-controls work before the MVP tranche.
- **T27–T29:** Implementations remain valid and become MVP-critical.
- **T30:** Partially stale. Split one-command local runtime/operations documentation into MVP work; defer encrypted backup, isolated restore, and hardened exposure to improvements.
- **T31:** Reclassified as a post-MVP improvement.
- **T32:** Implementation remains valid but moves before the MVP acceptance gate as a mandatory safety check.
- **T33:** Reclassified as a post-MVP improvement; manual/current broadcast behavior remains available from the existing backend.
- **T34:** Partially stale. Split into an MVP browser smoke path and a later complete recovery/scale/full-suite acceptance proof.

### Tests that must change

- `tests/infra/compose-backup.test.ts` — split local startup assertions from backup/restore assertions.
- `tests/e2e/gustavo-vertical-slice.spec.ts` — define the smaller MVP smoke path first; retain the complete slice for the improvement gate.
- `tests/performance/recall-latency.test.ts` — unchanged technically, but no longer blocks the working-MVP gate.
- `tests/broadcasts/scheduler.test.ts` — unchanged technically, but no longer blocks the working-MVP gate.
- `tests/security/static-boundaries.test.ts` — unchanged and promoted to a mandatory MVP gate.

### Code files that must change

- `infra/compose.yaml`, `infra/env.example`, `docs/OPERATIONS.md` — deliver one-command local MVP startup first.
- `infra/backup/create.ps1`, `infra/backup/verify.ps1`, `infra/backup/restore-drill.ps1` — move to the improvement tranche.
- `lib/server/observability/metrics.ts`, `app/api/operator/health/route.ts`, `docs/PERFORMANCE.md` — move to the improvement tranche.
- `db/migrations/0020_broadcast_schedules.sql`, `lib/server/main-brain/schedules.ts`, `worker/broadcasts/scheduler.ts` — move to the improvement tranche.
- `playwright.config.ts`, `tests/e2e/fixtures.ts`, `docs/SMOKE_TEST.md` — split MVP smoke wiring from later full-system verification.
- T27–T29 and T32 file lists remain as already planned.

### Verification status

- `05-verify.md` does not exist yet; verification must produce separate MVP and improvement results after re-execution.

## Re-approval

- Presented to user: 2026-08-12
- Confirmed approved: 2026-08-12 (`proceed`)

## Next skill

`mcax-plan` to regenerate T30–T34 sequencing and verification gates, then resume `mcax-execute` at T26.
