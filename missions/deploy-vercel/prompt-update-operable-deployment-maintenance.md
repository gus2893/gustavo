# Prompt update: operable deployment maintenance

**Date:** 2026-08-14
**Triggered by:** T21 Stage B execution review
**Approval status before:** approved
**Approval status after:** needs re-approval -> approved on 2026-08-14 under the standing instruction to proceed with all without needed input

## Change description

T21 review proved that the documentation described controls that do not exist or were unsafe to execute: ambient `pnpm` resolves to a corrupted wrapper on the deployment workstation, Vercel CLI was not pinned, manual secret-config and auth-volume rotation bypassed the T15 path/ACL/process boundary, `GUSTAVO_MARKET_POLLER_ENABLED` has no runtime consumer, the disabled-smoke queue requirements contradicted lost-wake recovery, backup preceded the schema required by the backup script, and source/domain authority was assumed rather than established. The design now requires executable authorities for each operation.

## Sections of 02-design.md updated

- R1
  - **Was:** Node/Corepack and a staged Vercel release were named, but commands could resolve ambient tools and source/domain provenance was not established.
  - **Now:** trusted absolute Node/Corepack/Git/PowerShell paths and repository-pinned Vercel CLI `58.4.0` own commands; deploys require a clean pushed reviewed commit and explicit apex/`www` redirect configuration.
- R2
  - **Was:** the fresh database backup could be read as preceding migration.
  - **Now:** migrate, verify the authority-only empty inventory, create/verify the migrated-empty backup, then bootstrap.
- R3/R7
  - **Was:** operators manually moved the secret worker config and removed the auth volume.
  - **Now:** a reviewed setup maintenance mode preserves T15 KnownFolder/reparse/ACL/trusted-process/absence authority and atomically replaces configuration without a plaintext backup file.
- R5/Rollback
  - **Was:** both bridge and market env flags were described as runtime disable authorities.
  - **Now:** only the hosted bridge flag is a deployed gate; exact schedule pause plus active-work settlement and T15 stop/absence proof owns market shutdown. Durable pending work remains recoverable.

## Sections of 01-story.md updated

- None. User-visible acceptance criteria are unchanged; this corrects operational authority.

## Impact

### Plan tasks invalidated

- T20B: new prerequisite delta for trusted deployment tooling and removal of the inert market flag from configuration authority.
- T20C: new prerequisite delta for the safe worker maintenance rebuild/auth/config mode.
- T21: regenerate runbook and static tests for executable command, source/domain, backup, hosted/local URL, queue, market-disable, maintenance, and rollback semantics.
- T22: update end-to-end fixtures to treat schedule pause/worker stop as market disable and exercise the hosted direct-chat publication path.
- T23: use the pinned trusted CLI, clean reviewed source, migrated-empty backup order, explicit domain redirect, real shutdown authorities, and reviewed maintenance command.

### Tests that must change

- `tests/infra/hybrid-worker.test.ts`: safe maintenance mode, exact path/ACL/process/volume/config replacement and failure recovery.
- `tests/deployment/vercel-hybrid.test.ts`: exact pinned command forms; ban ambient tools and mutable destructive paths; hosted/local wake variable placement; removal of inert market flag; backup order; clean commit/source metadata; explicit domain redirect; truthful queue/market shutdown.
- `tests/e2e/gustavo-hybrid-production.spec.ts`: schedule-owned market disable and actual hosted chat publication path.

### Code files that must change

- `scripts/setup-hybrid-worker.ps1`: add reviewed maintenance rebuild/auth/config rotation mode under existing T15 authority.
- `package.json`, `pnpm-lock.yaml`: pin Vercel CLI `58.4.0` exactly.
- `infra/env.example`, `infra/vercel.env.example`: distinguish local/hosted wake URLs and remove the inert market-poller variable as an asserted control.
- `docs/VERCEL_DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/SMOKE_TEST.md`: regenerate executable operations.

### Verification status

- `05-verify.md`: not yet created; T23/full verification must use the regenerated authority.

## Re-approval

- Presented to user: 2026-08-14
- Confirmed approved: 2026-08-14 under the standing instruction to proceed with all without needed input

## Next skill

`mcax-plan` — insert T20B and regenerate T21/T22/T23 before resuming `mcax-execute`.
