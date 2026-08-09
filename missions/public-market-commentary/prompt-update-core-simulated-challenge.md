# Prompt update: Core simulated challenge progression

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** needs re-approval

## Change description

The user asked to stay in planning mode while restoring a simulated prop-challenge mechanism owned by the Core Brain. Gustavo must record all Core Brain paper trades, begin at $2,500, double the starting balance after each passed stage, cap the ladder at $1,000,000, and retain every trade and stage transition as immutable history. No real trading connectivity is introduced.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** All paper-order, sizing, leverage, and account-risk functionality was prohibited.
  - **Now:** Those concepts are permitted only inside the Core Brain's clearly labeled simulated Challenge Portfolio; real execution remains prohibited.
- **P — Core simulated challenge**
  - **Was:** No challenge domain existed.
  - **Now:** Defines the $2,500-to-$1,000,000 ladder, separate domain identity, versioned profiles, immutable events, deterministic accounting, paper-decision workflow, and simulation labeling.
- **S/N — Safety and non-goals**
  - **Was:** Generic prohibition on all account-challenge activity.
  - **Now:** Prohibits real execution, provider-specific claims, accounting mutations by models, and representation of simulation as real performance.

## Sections of 01-story.md updated

- Added an operator story for the Core Brain's simulated challenge progression.
- Extended the vertical slice through deterministic paper-order gating, fills, marks, P&L, and stage progression.
- Added acceptance criteria for the exact stage ladder, immutable accounting, explicit labeling, and no external connectivity.

## Impact

### Plan tasks invalidated

- T1 domain model: separate `UserAccount` from the Core `ChallengePortfolio`.
- T2 database: add stage profiles, intents, orders, fills, positions, marks, ledger entries, snapshots, and rule evaluations.
- T3 council orchestration: add a selected-idea-to-paper-intent boundary without giving models accounting authority.
- T4 rule engine: add deterministic sizing, exposure, loss-limit, profit-objective, pass/fail, and stage-advancement calculations.
- T5 simulation engine: add timestamped fills, costs, marks, cancellations, expiries, and position closure.
- T6 UI/API: add challenge dashboard, ledger, configuration, stage ladder, and simulation labeling.
- T7 memory: store challenge objectives, decisions, outcomes, and source-linked lessons without treating derived memory as accounting state.
- T8 verification: add ledger replay, rule-boundary, progression, and no-external-connectivity tests.

### Tests that must change

- `tests/challenge/profile.test.ts` — profile validation/versioning and derived target equity.
- `tests/challenge/progression.test.ts` — exact doubling sequence, $1,000,000 cap, and no advancement before pass.
- `tests/challenge/ledger.test.ts` — deterministic replay, balance/P&L invariants, and idempotency.
- `tests/challenge/rules.test.ts` — daily/overall loss, drawdown, exposure, sizing, target, pass/fail, and timezone boundaries.
- `tests/challenge/simulation.test.ts` — price freshness, spread, slippage, fees, fills, marks, and closure.
- `tests/challenge/lifecycle.test.ts` — active/paused/passed/failed/archive transitions and order blocking.
- `tests/security/no-execution.test.ts` — no broker SDKs, credentials, external order routes, execution payloads, or subprocess hooks.
- `tests/ui/simulation-labels.test.ts` — every challenge surface contains the required simulation-only label.

### Code files that must change after approval

- `db/schema/challenge.sql` — stage profiles, immutable ledger, orders, fills, positions, marks, evaluations, and snapshots.
- `lib/server/challenge/accounting/*` — deterministic balance, equity, P&L, and drawdown replay.
- `lib/server/challenge/rules/*` — versioned risk and lifecycle rule engine.
- `lib/server/challenge/progression/*` — fixed stage ladder, pass gate, capped advancement, and completion.
- `lib/server/challenge/simulation/*` — paper fill, cost, mark, expiry, and closure engine.
- `lib/server/challenge/projections/*` — progress, stage ladder, and dashboard read models.
- `lib/server/orchestration/*` — translate an approved council outcome into a proposed paper intent only.
- `app/(challenge)/challenge/page.tsx` and `app/api/challenge/*` — configuration, paper state, ledger, and operator actions.
- `worker/challenge/*` — price marking, simulation lifecycle, daily boundaries, and pass/fail checks.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

Continue planning after the user supplies or approves the per-stage profit and loss-rule template. No code execution begins while the user keeps the task in planning mode.
