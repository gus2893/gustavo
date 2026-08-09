# Prompt update: approved MVP operating defaults

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** approved architecture with pending operating choices
**Approval status after:** approved on 2026-08-09

## Change description

The user explicitly approved the recommended MVP defaults for Challenge rules, the winner rubric, launch markets, Brain runtime, and beta access. The design now contains executable versioned policy rather than unresolved choices: invitation-only access; US-listed stocks/ETFs through a licensed server-side adapter; provider-neutral Main, Node, and evaluator identities; a deterministic Challenge profile and simulation cost model; and exact arbitration weights and thresholds.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** access, Challenge values, rubric thresholds, and initial market scope were configurable or pending.
  - **Now:** invitation access, US stock/ETF scope, profile values, and scoring thresholds are canonical MVP requirements.
- **E — Evidence model**
  - **Was:** rubric categories were named without exact weights.
  - **Now:** the categories total 100 using weights 25/20/20/15/10/10.
- **P — Main Brain's shared simulated challenge**
  - **Was:** stage profile fields existed without an approved initial rule set.
  - **Now:** target, loss gates, risk caps, qualifying days, exposure, pass/fail math, and costs are deterministic.
- **Open assumptions**
  - Items 3, 13, and 16 now record approved defaults rather than pending decisions.

## Sections of 01-story.md updated

- Vertical-slice account creation now redeems an invitation rather than implying billing.
- Acceptance criteria 6, 31, and 42 now contain the approved rubric and Challenge behavior.
- Acceptance criteria 81–87 cover invitation security, market scope, deterministic risk math, costs, and model-role records.

## Impact

### Plan tasks invalidated

- No prior `03-plan.md` exists. The initial plan must use these approved values throughout account, market-data, evaluator, Challenge, and model-gateway tasks.

### Tests that must be included

- `tests/auth/invitation-redemption.test.ts` — one invitation creates one account, entitlement, Node, and conversation and cannot be reused.
- `tests/market-data/observation-policy.test.ts` — stock/ETF allowlist, timestamps, freshness, and delay labels survive projection.
- `tests/orchestration/evaluator-rubric.test.ts` — exact weights total 100, action threshold is 80, and contender margin is 5.
- `tests/challenge/profile.test.ts` — approved stage values and derived target/floor amounts.
- `tests/challenge/risk-gates.test.ts` — daily, overall, aggregate, per-position, position-count, symbol, and 1x notional limits.
- `tests/challenge/trading-days.test.ts` — 0.25% qualifying-risk rule and three-day pass gate.
- `tests/challenge/cost-model.test.ts` — commission, slippage, spread fallback, and short-borrow calculations.
- `tests/models/gateway-audit.test.ts` — Main, Node, and evaluator calls record provider/model/prompt/policy/use metadata.

### Code files that must change

- `lib/server/auth/invitations.ts` — redeem hashed expiring single-use invitations transactionally.
- `lib/server/market-data/*` — enforce allowed asset classes, symbol allowlist, licensed-source metadata, and freshness labels.
- `lib/server/orchestration/rubric.ts` — encode versioned weights and thresholds.
- `lib/server/challenge/profile.ts` — define the approved profile.
- `lib/server/challenge/risk.ts` — enforce approved deterministic gates.
- `lib/server/challenge/costs.ts` — calculate the approved simulation costs.
- `lib/server/models/*` — provider-neutral roles and auditable usage records.

### Verification status

- No `05-verify.md` exists. Initial verification must cover the updated criteria.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: 2026-08-09

## Next skill

`mcax-plan` — generate the initial test-first task list from the approved design.
