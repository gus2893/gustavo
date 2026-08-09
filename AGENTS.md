# Gustavo Repository Instructions

## Source of truth

Gustavo is an invitation-only educational market-commentary application with canonical production origin [https://gustavo.lol](https://gustavo.lol), one Main Brain, one stable Node Brain per account, one continuous private chat per account, and one shared simulated Challenge Portfolio.

Read the mission contracts before changing product behavior:

1. [`missions/public-market-commentary/01-story.md`](missions/public-market-commentary/01-story.md)
2. [`missions/public-market-commentary/02-design.md`](missions/public-market-commentary/02-design.md)
3. [`missions/public-market-commentary/03-plan.md`](missions/public-market-commentary/03-plan.md)

The approved design is the behavioral source of truth. `policy/editorial-policy.json` is the machine-readable source for product identity and safety constants. Historical files under `docs/`, `policy/`, `schemas/`, `state/`, and `templates/` are preserved import evidence, not active application configuration.

## Non-negotiable boundaries

- Display the exact label `SIMULATION ONLY — NOT A REAL TRADE` wherever simulated Challenge actions or performance appear.
- Never add real order routing, execution adapters, copy-trade exports, account credentials, or brokerage/prop-firm connectivity.
- Use `paper long`, `paper short`, or `no simulated position`; do not present simulated actions as recommendations to buy or sell.
- Treat Gustavo's Brain and memory terms as software roles and retrieval systems. Do not claim consciousness, sentience, hidden chain-of-thought access, or perfect recall.
- Keep private Node Brain content scope-bound. Authorization must precede retrieval, ranking, graph expansion, cache access, and DTO projection.
- Do not ship protected text, ciphertext, secrets, or browser-usable decryption material to an unauthorized client.
- Label market observations with source time and freshness. Active unfinished bars are provisional.
- Limit active market coverage to the `US_STOCK` and `US_ETF` classes configured in `policy/editorial-policy.json`.

## Engineering conventions

- Use Node.js 24 and the pnpm version declared in `package.json`.
- Keep TypeScript strict. Avoid `any`; validate data at trust boundaries and use fixed decimal or integer-cent arithmetic for money.
- Use the Next.js App Router and keep secrets, authorization, data access, model calls, and market-data adapters server-only.
- PostgreSQL append-only events are authoritative. Queues, caches, summaries, embeddings, and projections must be disposable and rebuildable.
- Persist source events before derived state. Make mutations and worker jobs idempotent and record causation, correlation, policy version, and provenance.
- Write a failing test before production code. Implement the smallest behavior that satisfies the approved task, then run its exact verification command.
- Preserve unrelated legacy knowledge until its planned provenance-preserving import and archival task.

## Validation

Install and run the baseline checks from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm vitest run
pnpm exec tsc --noEmit
```

Run the narrower command specified by the active plan task during test-first implementation. Do not commit generated output, credentials, local databases, encrypted-key material, or dependency directories.
