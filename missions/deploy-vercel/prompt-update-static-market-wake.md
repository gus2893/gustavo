# Prompt update: static scheduled market wake

**Date:** 2026-08-14
**Triggered by:** T21 executable runbook review
**Approval status before:** approved
**Approval status after:** needs re-approval → approved (2026-08-14)

## Change description

The design required a recurring QStash schedule to deliver a signed canonical `{windowId:"YYYY-MM-DDTHH:mmZ"}` every five minutes. QStash schedules republish a fixed configured body and do not interpolate a current timestamp, so that schedule is not executable.

The corrected design keeps exactly two schedules and adds no hosted relay. The market schedule delivers one fixed exact signed `{kind:"MARKET_CURRENT"}` trigger. Existing T6 authority verifies the exact URL/body/JWT and commits signed-`jti` receipt plus daily quota before admission. The local worker then derives the current five-minute window from PostgreSQL time in a short database lifecycle, disconnects, and passes that exact window through the existing T14 reservation. If the database bucket advances between derivation and reservation, reservation skips with no provider call, historical poll, or quota mutation.

## Sections updated

- `02-design.md`: wake topology, decisions, modified files, and decision log.
- `03-plan.md`: new T20A implementation delta; T21/T22/T23 documentation and verification deltas.
- `01-story.md`: no update required; the observable five-minute current-window polling behavior is unchanged.

## Impact

### Tasks invalidated

- T6/T14/T15 code needs the focused T20A delta for the new exact static trigger and PostgreSQL window derivation.
- T21 must document the executable fixed schedule body.
- T22/T23 must prove the live/static body, database clock, and boundary skip.

### Preserved authority

- Exactly two schedules remain: bounded hosted maintenance and fixed market trigger.
- QStash signature, replay receipt, and 900/day application quota precede local admission.
- PostgreSQL remains the only current-window clock authority.
- Provider work remains outside the derivation/reservation database lifecycle.
- Dynamic `{windowId}` remains only an internal/adversarial one-shot path.
- No timer, hosted relay, third schedule, provider fallback, or historical re-poll is introduced.

## Source checked

- Upstash QStash schedule documentation: a schedule republishes the configured destination, headers, and body for each cron occurrence; the body is stored as a fixed string.

## Re-approval

- Confirmed approved on 2026-08-14 under the user's standing instruction to “Proceed with all without needed input.”

## Next skill

`mcax-plan` — execute T20A before resuming T21.
