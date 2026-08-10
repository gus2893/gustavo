# Prompt update: one account, one Brain, one chat

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** approved on 2026-08-09; superseded by the subsequent durability/deployment prompt update

## Change description

The user clarified the core identity model: Tape gives each individual account exactly one stable Brain and one continuous private chat. The earlier sponsorship, public-pool allocation, donation, and purchaser/recipient alternatives were assistant interpretations and are removed from the active design.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** Seat purchase, ownership, and donation semantics were unresolved.
  - **Now:** One account is one seat, permanently paired with one Brain and one continuous private chat during its active lifetime.
- **A — Architecture**
  - **Was:** Separate seat allocation and sponsorship routes were planned.
  - **Now:** Account entitlement and stable Brain assignment replace sponsorship and allocation.
- **C — Content protection**
  - **Was:** Sponsor, purchaser, and participant visibility remained undecided.
  - **Now:** The account holder can access only that account’s conversation and entitled downstream events.
- **I/B — Interaction and Brain roles**
  - **Was:** Seat sponsorship/allocation events and a Seat Brain role.
  - **Now:** Account creation, entitlement activation, Brain assignment, and an Account Brain role.
- **Open assumptions**
  - **Was:** Three possible purchase/donation models.
  - **Now:** The identity invariant is decided; pricing and entitlement duration remain later commercial decisions.

## Sections of 01-story.md updated

- Replaced sponsor, public-pool, and allocation flows with account creation/access.
- Added explicit acceptance criteria for exactly one stable Brain and one continuous private chat per account.

## Impact

### Plan tasks invalidated

- Seat sponsorship and public-pool allocation task: removed entirely.
- Account domain task: must enforce one Brain assignment and one conversation aggregate per account.
- Authorization task: roles simplify to public, account holder, moderator, and operator.
- Payments task: decoupled from Brain/chat identity; any future commercial model must activate the same single entitlement.
- Orchestration task: terminology and foreign keys change from seat Brain to account Brain.

### Tests that must change

- Account-domain tests must reject a second Brain assignment for the same account.
- Conversation tests must reject creation of a second Brain chat for the same account.
- Authorization tests must prove an account cannot read another account’s chat.
- Lifecycle tests must prove reactivation resumes the same Brain/chat unless a separately approved retention policy says otherwise.
- Sponsorship, donation, waitlist, and allocation tests must be removed from the plan.

### Files that must change after approval

- `app/(account)/chat/page.tsx` — render the account’s one persistent Brain chat.
- `app/api/account/*` — manage entitlement and immutable Brain assignment.
- `app/api/conversations/*` — route all account messages to the single conversation aggregate.
- `lib/server/auth/*` — enforce account ownership.
- `lib/server/dal/*` — return account-scoped conversation and debate DTOs only.
- `lib/server/orchestration/*` — identify transmissions by account Brain and conversation.
- Database schema/migrations — unique constraints on account-to-Brain and account-to-conversation relationships.

### Verification status

- No implementation verification exists; design remains unapproved.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: 2026-08-09

## Next skill

`mcax-plan` after the user explicitly approves this revised design.
