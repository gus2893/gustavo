# Prompt update: one Main Brain with user-facing Node Brains

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** needs re-approval

## Change description

The user clarified Gustavo's canonical hierarchy: there is one authoritative Main Brain, one shared simulated Challenge, and one user-facing Node Brain per User Account. Scheduled messages always originate from the Main Brain. Nodes conduct private dialogue, inherit the Main default, and may submit materially better user feedback upstream, but they cannot independently change shared state or the Challenge.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** Core/Account Brain authority and broadcast authorship were implicit.
  - **Now:** Main/Node terminology, one shared authority, Main-authored broadcasts, and three Node routing modes are explicit.
- **H — Main Brain and Node Brain hierarchy**
  - Added Main-state ownership, scheduled-message commitment/delivery, Node routing, upstream proposal contracts, and acceptance/rejection behavior.
- **I — Interaction events**
  - Added Main broadcast, Node routing, feedback proposal, and Main-state version events.
- **B/O/N — Roles, output, and non-goals**
  - Updated product vocabulary and prohibited Node-authored broadcasts, automatic agreement, false acceptance claims, and Main baseline rewriting.

## Sections of 01-story.md updated

- Recast the account relationship around a stable Node Brain and Main-authored scheduled messages.
- Added the Main/Node broadcast, dialogue, routing, proposal, and privacy acceptance criteria.

## Impact

### Plan tasks invalidated

- T1 Brain domain: replace peer-like Core/Account roles with authoritative Main and subordinate Node capabilities.
- T3 orchestration: add Main-state versions, broadcast cycles, Node reply routing, and proposal-review workflows.
- T4 messaging: distinguish canonical Main broadcast bodies from Node interactive replies and delivery metadata.
- T5 memory: give Nodes inherited Main memory plus private branch memory; give Main only scoped proposals, council events, and canonical history.
- T6 authorization/privacy: enforce that Nodes cannot access other branches and Main cannot retrieve raw private messages without an authorized scope.
- T7 challenge arbitration: rename Core/Account concepts and ensure only accepted Node proposals reach Main selection.
- T8 audit: record authorship, route mode, state version, proposal outcome, and source provenance.

### Tests that must change

- `tests/brains/main-authority.test.ts` — only Main can commit canonical responses, broadcasts, accepted state, and Challenge baselines.
- `tests/brains/node-isolation.test.ts` — each Node accesses only its assigned account conversation and inherited Main projection.
- `tests/broadcasts/authorship.test.ts` — every scheduled semantic body is Main-authored and immutable during delivery.
- `tests/broadcasts/projection.test.ts` — delivery personalization cannot alter the canonical semantic body.
- `tests/nodes/routing.test.ts` — exactly one of `MAIN_DEFAULT`, `NODE_EXPLORE`, or `PROPOSAL_UPSTREAM` is recorded per response.
- `tests/nodes/default.test.ts` — Main-default replies reference the correct Main-state version.
- `tests/nodes/explore.test.ts` — exploratory replies cannot claim Main acceptance.
- `tests/proposals/privacy.test.ts` — proposals exclude raw private text unless explicitly authorized.
- `tests/proposals/lifecycle.test.ts` — accepted proposals version Main state; rejected proposals leave it unchanged.

### Code files that must change after approval

- `db/schema/brains.sql` — Main singleton, Node assignments, Main-state versions, and capabilities.
- `db/schema/broadcasts.sql` — broadcast cycles, canonical bodies, projections, deliveries, and receipts.
- `db/schema/proposals.sql` — Node feedback proposals, source links, privacy scope, review, scoring, and outcomes.
- `lib/server/main-brain/*` — canonical responses, state, broadcasts, baselines, and accepted changes.
- `lib/server/node-brains/*` — inherited state, private context, reply routing, exploration, and proposals.
- `lib/server/broadcasts/*` — scheduling, commitment, policy validation, projection, and delivery.
- `lib/server/proposals/*` — normalization, privacy filtering, evaluation, clarification, and Main-state updates.
- `app/api/broadcasts/*` and `app/api/proposals/*` — authorized endpoints and stream projections.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

Continue planning after explicit approval of the Main/Node hierarchy, then finalize the scoring rubric and Challenge stage-rule template.
