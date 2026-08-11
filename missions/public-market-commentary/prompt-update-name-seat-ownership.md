# Prompt update: Tape name and seat ownership

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** needs re-approval

## Change description

The user renamed the product from TapeThoughts to Tape and challenged the assistant’s assumption that a purchaser funds a seat exclusively for another public participant. The name is now fixed in the pending design. Seat purchase, ownership, donation, and purchaser visibility are reopened as explicit product decisions.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** “Public-facing product name: TapeThoughts.”
  - **Now:** “Public-facing product name: Tape.”
  - **Was:** Sponsors purchase seats donated into a public pool.
  - **Now:** No ownership model is approved yet.
- **A — Architecture**
  - Repository rename target changed from `tapethoughts` to `tape`.
- **C — Content protection**
  - Purchaser visibility cannot be finalized until ownership semantics are approved.
- **Open assumptions**
  - Replaced sponsored-only behavior with three concrete alternatives.

## Sections of 01-story.md updated

- Product name changed to Tape.
- Sponsored-only allocation is no longer an acceptance criterion.
- Seat ownership selection is now an explicit acceptance gate.

## Impact

### Plan tasks invalidated

- Branding task: all package, page, metadata, and repository names must use Tape.
- Seat lifecycle task: cannot be planned until ownership/donation behavior is selected.
- Authorization task: purchaser and recipient DTOs depend on the selected seat model.
- Payment task: checkout quantity and entitlement creation differ across all three models.

### Tests that must change

- Branding tests must assert Tape rather than TapeThoughts.
- Seat allocation tests remain unplannable until the ownership model is approved.
- Authorization tests for purchaser access remain unplannable until that decision.

### Files that must change after approval

- Public metadata, README, package name, page titles, and repository folder: rename to Tape / `tape`.
- Seat domain model, checkout handlers, allocation workflow, and authorization DTOs: implement the selected ownership model only.

### Verification status

- No implementation verification exists; design remains unapproved.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

`mcax-plan` after the user selects the seat ownership model and explicitly approves the updated design.

