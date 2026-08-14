# Prompt update: staged production promotion

**Date:** 2026-08-14
**Triggered by:** T21 deployment-runbook verification against current official provider documentation
**Approval status before:** approved
**Approval status after:** needs re-approval → approved (2026-08-14)

## Change description

The approved design said to smoke a Vercel Preview and promote that exact Ready deployment. Current Vercel documentation distinguishes two workflows: promoting a Preview performs a new production rebuild with production environment variables, while promoting a staged production deployment created with `vercel --prod --skip-domain` assigns domains without rebuilding it. The corrected cutover keeps Preview as an early hosted gate, then creates and fully smokes a staged production deployment and promotes that exact artifact.

Current Upstash pricing also names 1,000 QStash Free messages/day. Gustavo's existing 900/day database limit remains intentionally stricter application headroom. Operations documentation must state both values rather than describing 900 as the provider ceiling.

## Sections updated

- `02-design.md`: R1 release authority, two-phase release decision, QStash dependency limit, SC7, and decisions log.
- `03-plan.md` T21: runbook test and command order now require Preview followed by staged production and exact no-rebuild promotion; provider and application QStash limits are distinct.
- `03-plan.md` T23: final provisioning/smoke/promotion steps target the staged production URL before domain assignment.
- `01-story.md`: no update required; the observable safe deployment and rollback outcome is unchanged.

## Impact

### Tasks invalidated

- T21: deployment documentation and static assertions must use the staged-production sequence.
- T23: live execution must record both Preview evidence and staged-production evidence before exact promotion.

### Preserved authority

- No production domain changes occur before all production-environment smoke gates pass.
- Preview remains a required early hosted gate.
- Migrations stay additive; backup, rollback, local flags, schedules, task, and Funnel cleanup are unchanged.
- No token, credential, provider URL, or secret value is added to source or command arguments.

## Sources checked

- Vercel, “Promoting Deployments” and “Deploying Projects from Vercel CLI” (current staged-production `--skip-domain` workflow).
- Vercel, “Promoting a preview deployment to production” (Preview promotion rebuild behavior).
- Upstash, “QStash Pricing” (current Free provider ceiling of 1,000 messages/day).

## Re-approval

- Confirmed approved on 2026-08-14 under the user's standing instruction to “Proceed with all without needed input.”

## Next skill

`mcax-plan` — regenerate T21 and T23 before resuming `mcax-execute`.
