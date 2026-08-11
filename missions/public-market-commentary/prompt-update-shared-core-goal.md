# Prompt update: one shared goal with Core baseline

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** needs re-approval

## Change description

The user clarified that Gustavo has one shared Core Challenge Portfolio rather than separate Brain portfolios. Account holders develop ideas with their assigned Account Brain, which transmits eligible ideas to the council. The Core Brain's independently committed baseline remains the default; a contender influences the portfolio only when blind evaluation shows it is materially better and deterministic challenge gates approve it.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** Account Brains contributed to the Core Portfolio, but replacement authority was not fully defined.
  - **Now:** All contributions target one shared goal, remain proposals, and must beat a committed Core baseline.
- **P — Core simulated challenge**
  - Added frozen snapshots, baseline commitment, normalized contender intake, bounded debate, blind scoring, improvement margin, selection, and deterministic challenge gating.
- **N — Non-goals**
  - Added prohibitions against direct contributor mutation, pay/vote influence, baseline rewriting, and unscored superiority decisions.

## Sections of 01-story.md updated

- Revised the vertical slice to commit the Core baseline before contender comparison.
- Added acceptance criteria for one shared portfolio, blind scoring, hard gates, improvement margins, and auditable provenance.

## Impact

### Plan tasks invalidated

- T3 council orchestration: add frozen decision windows and immutable Core commitments.
- T4 evaluator: add normalization, anonymization, structured component scoring, absolute thresholds, and improvement-margin logic.
- T5 challenge integration: preserve selection provenance when creating a proposed paper intent.
- T7 memory: maintain source-linked contributor history without exposing raw private chat.
- T8 audit/verification: prove non-winning contenders cannot change the portfolio and Core commitments cannot be rewritten.

### Tests that must change

- `tests/council/baseline-commitment.test.ts` — Core baseline closes before contender evaluation and remains immutable.
- `tests/council/anonymization.test.ts` — evaluator payloads exclude account identity and payment metadata.
- `tests/council/scoring.test.ts` — Core and contenders use identical rubric weights, snapshot, and gates.
- `tests/council/improvement-margin.test.ts` — ties/sub-margin contenders preserve the Core decision.
- `tests/council/no-trade.test.ts` — a contender must clear an absolute threshold to replace `NO PAPER TRADE`.
- `tests/challenge/selection-provenance.test.ts` — paper intent references the winning evaluation and sources.
- `tests/challenge/contributor-isolation.test.ts` — Account Brains cannot mutate portfolio state directly.

### Code files that must change after approval

- `db/schema/council.sql` — decision windows, frozen snapshots, Core commitments, contenders, scores, and selections.
- `lib/server/council/baseline/*` — independent Core proposal and commitment lifecycle.
- `lib/server/council/contenders/*` — normalized intake, hard gates, deduplication, and anonymization.
- `lib/server/council/evaluator/*` — versioned rubric, structured scoring, thresholds, and improvement comparison.
- `lib/server/orchestration/*` — bounded debate and selection-to-paper-intent provenance.
- `lib/server/challenge/*` — accept only selected, source-linked proposed intents.
- `app/api/council/*` — authorized submission, evaluation status, and result endpoints.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

Continue planning after the user approves the shared-goal arbitration model and selects or approves the scoring rubric and challenge-rule template.
