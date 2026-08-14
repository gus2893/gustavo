# Prompt update: market materializer database role

**Date:** 2026-08-14
**Triggered by:** debug escalation (`debug-t13-latest-authority.md`)
**Approval status before:** approved
**Approval status after:** needs re-approval → approved (2026-08-14)

## Change description

T13 proved that the approved one-identity PostgreSQL design cannot make a latest-to-observation binding authoritative: PostgreSQL cannot decrypt the Node-side AES-GCM latest payload, and any binding function callable by the ordinary database identity is equally callable by a direct writer with forged values. The deployment therefore adds one local-only Neon login that inherits a narrowly privileged NOLOGIN `gustavo_market_materializer` role. Only that identity can create consumption bindings; it has no Vercel, Codex-container, migration-owner, or general application authority.

## Sections of `02-design.md` updated

- **R4 — market observations**
  - **Was:** the ordinary application database identity decrypted a latest row and inserted its binding/observation.
  - **Now:** only a separate local-only materializer login may author a consumption binding; ordinary writers are rejected even if they forge matching rows.
- **Assumptions / external dependencies**
  - **Was:** production required one fresh pooled `DATABASE_URL`.
  - **Now:** Neon also supplies one pooled materializer-role URL kept exclusively on the local worker.
- **System design / data model / market execution**
  - **Was:** caller-authored semantic digests were checked by triggers under one identity.
  - **Now:** database role separation is the unforgeable write boundary; replay still locks, reauthorizes, decrypts, and compares the exact latest version.

No user-visible acceptance criterion changes. Story 4 still shows the same 95 authenticated results and creates an append-only observation only when a decision consumes the exact quote.

## Impact

### Plan tasks invalidated

- **T13:** invalidated; add the permission role, ordinary-writer rejection, materializer-only binding, exact replay decryption, and full-precision timestamp authority.
- **T15:** partially stale; local worker setup/start must require and protect the separate materializer URL and verify the role without logging credentials.
- **T21:** partially stale; environment/runbook/checklist must document creating the Neon login, granting only the NOLOGIN permission role, rotation, degraded behavior, and no Vercel exposure.
- **T22:** partially stale; the production E2E fixture must use distinct ordinary/materializer test identities and prove ordinary-role forgery fails.
- **T23:** partially stale; cutover must provision the separate Neon login/grant, keep it local-only, and verify the deployed Vercel environment never receives that URL.

T14 polling/storage, T18 authenticated reads, and all Codex tasks remain valid because they use the ordinary database identity and never author consumption bindings.

### Tests that must change

- `tests/market-data/finnhub-poller.test.ts` — execute materialization as the permission role; prove an ordinary writer cannot insert a binding plus matching forged observation; replay decrypts the exact latest version; sub-millisecond ambiguity is rejected.
- `tests/infra/hybrid-worker.test.ts` — require a protected local-only materializer URL and fail closed on missing/wrong role.
- `tests/deployment/vercel-hybrid.test.ts` — prove Vercel configuration does not contain the materializer credential and docs/env templates keep it blank/local-only.
- `tests/e2e/fixtures.ts`, `tests/e2e/gustavo-hybrid-production.spec.ts` — exercise distinct identities and ordinary-role forgery rejection.

### Code files that must change

- `db/migrations/0022_hybrid_deployment.sql` — create the NOLOGIN permission role, restrict binding DML, enforce writer identity and exact millisecond timestamp authority.
- `lib/server/market-data/latest.ts` — require a separately authenticated materializer database for binding writes and re-decrypt/compare the exact latest version on replay.
- `scripts/setup-hybrid-worker.ps1`, `scripts/start-hybrid-worker.ps1` — validate/protect the local-only credential and exact role.
- `infra/env.example`, `docs/VERCEL_DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/SMOKE_TEST.md` — add blank secret name and least-privilege operating instructions.

### Verification status

- `05-verify.md`: not created yet; final verification must include the role-separated production path.

## Re-approval

- Presented to user: 2026-08-14
- Confirmed approved: 2026-08-14 under the user's standing instruction to “Proceed with all without needed input”

## Next skill

`mcax-plan` — regenerate T13, T15, T21, and T23 before execution resumes.
