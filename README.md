# Gustavo

**The market thinks out loud.**

Gustavo is an invitation-only market-intelligence show at [https://gustavo.lol](https://gustavo.lol). Each account holder has one stable Node Brain and one continuous private conversation. Node Brains can submit structured ideas to the shared Main Brain, which records its reasoning and manages one shared simulated Challenge Portfolio.

Gustavo publishes educational market commentary, not individualized financial advice. It makes no promise of accuracy, profitability, or future performance. Its Brain and memory language describes software roles and retrieval systems; Gustavo does not claim consciousness or sentience.

> SIMULATION ONLY — NOT A REAL TRADE

Gustavo cannot route real orders, connect to brokerage or prop-firm accounts, produce copy-trade instructions, or hold execution credentials. The MVP market universe is limited to operator-approved US-listed stocks and ETFs. Market observations include timestamps and freshness labels, and unfinished bars are explicitly provisional.

## Product model

- The Main Brain is the single authority for shared views, scheduled messages, council decisions, and the simulated Challenge Portfolio.
- Each account has exactly one stable Node Brain and one private, continuous chat.
- Node proposals never mutate shared state directly; the Main Brain evaluates them against recorded hard gates and a versioned scoring policy.
- Source interactions remain durable. Derived summaries, indexes, and caches never replace the source record or widen access permissions.
- Protected conversation text is never sent to an unauthorized public browser.

Machine-readable product constants and safety boundaries live in [`policy/editorial-policy.json`](policy/editorial-policy.json). README prose is explanatory and is not executable configuration.

## Mission documents

- [`01-story.md`](missions/public-market-commentary/01-story.md) — approved user stories and observable acceptance criteria.
- [`02-design.md`](missions/public-market-commentary/02-design.md) — approved product and architecture contract.
- [`03-plan.md`](missions/public-market-commentary/03-plan.md) — test-first implementation plan.

Legacy knowledge files are preserved as import sources and historical evidence. They are not active Gustavo configuration and cannot enable obsolete execution behavior.

## Development

Gustavo uses Node.js 24, pnpm, TypeScript with strict checking, Next.js, and Vitest.

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm exec tsc --noEmit
```
