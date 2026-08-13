# Prompt update: Vercel function configuration order

**Date:** 2026-08-13
**Triggered by:** execution finding in T1 Stage B
**Approval status before:** approved
**Approval status after:** needs re-approval → approved on 2026-08-13

## Change description

T1 originally created `vercel.json` entries for both the existing SSE route and the future maintenance route. Stage B found, and current Vercel documentation confirms, that every `functions` glob must match a function source file in the deployed commit. Because the maintenance route is not created until T16, the intermediate T1 commit would be undeployable. The corrected ordering keeps the final behavior unchanged: T1 configures only existing SSE, and T16 creates the maintenance route and its 60-second entry atomically. The same review also found that safety-flag tests must parse unique active assignments instead of accepting substrings.

## Sections of `02-design.md` updated

- `R — Requirements`, R1
  - **Was:** repair the Vercel project with Node 24/pnpm 11 and bounded functions, without an intermediate-commit validity rule.
  - **Now:** every committed function pattern must match a route present in the same commit.
- `S — System design`, Cloud maintenance and SSE
  - **Was:** `vercel.json` was described as bounded runtime configuration, and the plan placed both route entries in T1.
  - **Now:** T1 configures only existing SSE; T16 adds the maintenance route and matching duration entry together.
- `Change log`
  - Preserves the previous two-entry T1 intent and records why task ordering changed.

## Sections of `01-story.md` updated

- None. Public behavior, acceptance criteria, and final deployment bounds are unchanged.

## Impact

### Plan tasks invalidated

- T1: replace the nonexistent maintenance-route assertion with the existing SSE route only; parse environment assignments and require one exact active value for each safety flag.
- T16: add `vercel.json` to allowed files and assert the new maintenance function entry is created atomically with the route.

### Tests that must change

- `tests/deployment/vercel-hybrid.test.ts`: T1 must reject commented, duplicated, or conflicting safety-flag assignments and must not require a nonexistent maintenance route.
- `tests/privacy/forget-propagation.test.ts`: T16 must assert the maintenance route exists and `vercel.json` contains its exact 60-second function entry.

### Code files that must change

- `vercel.json`: T1 adds only the existing SSE function bound; T16 adds the maintenance function bound.
- `app/api/internal/maintenance/route.ts`: still created in T16, in the same commit as its Vercel configuration.

### Verification status

- `05-verify.md` does not exist; no verification artifact is stale.
- The invalid T1 working-tree implementation was removed before this update. Only the unrelated user-owned `AGENTS.md` remains modified.

## Re-approval

- Presented to user: 2026-08-13
- Confirmed approved: 2026-08-13

## Next skill

`mcax-plan` for T1 and T16, then resume `mcax-execute` at T1.
