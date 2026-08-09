# Local Paper-Trade Lab Knowledge Base

This repository preserves the trading mechanism, operating rules, safety constraints, and dated decisions developed in the `eth-trade-setup-monitor` chat. It documents a **local simulation only**. It is not a signal service, brokerage integration, or authorization to trade a real account.

> PAPER LAB ONLY — do not copy this trade to CFT.

## Non-negotiable boundary

- Never connect this repository or its workflows to Crypto Fund Trader, Match-Trader, MT5, Bybit, a broker, or an exchange.
- Never store account numbers, credentials, confirmation tokens, or broker session data.
- Never run `trade.cmd` or write a paper artifact into `C:\Users\gusta\Desktop\Projects\Trade\New`, `processing`, `placed`, or `failed`.
- The only permitted JSON-export location is `C:\Users\gusta\Desktop\Projects\Trade\paper-lab-exports`, and an export remains a passive local paper-tracking artifact.
- CFT-style contract names are used only when their exact mapping has been verified. Never guess a `.cft` symbol.

## Repository map

- [`docs/MECHANISM.md`](docs/MECHANISM.md) — structure hierarchy and decision process.
- [`docs/GRADING_AND_RISK.md`](docs/GRADING_AND_RISK.md) — quality tiers, sizing, leverage, and risk gates.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — exact ten-minute monitor workflow.
- [`docs/API_CONTRACTS.md`](docs/API_CONTRACTS.md) — local tracker endpoints and payload rules.
- [`docs/EXPORTS_AND_SYMBOLS.md`](docs/EXPORTS_AND_SYMBOLS.md) — passive export policy and verified mappings.
- [`docs/DECISION_HISTORY.md`](docs/DECISION_HISTORY.md) — dated decisions and lessons from this chat.
- [`docs/ETH_CONTEXT.md`](docs/ETH_CONTEXT.md) — timestamped ETH-specific context, not permanent policy.
- [`policy/lab-policy.json`](policy/lab-policy.json) — machine-readable source of truth for durable rules.
- [`state/current-profile.json`](state/current-profile.json) — current $5,000 profile ledger and risk-day state.
- [`state/latest-market-context.json`](state/latest-market-context.json) — replaceable market snapshot context.
- [`templates`](templates) — records for new decisions and symbol verification.
- [`schemas`](schemas) — local payload validation shapes.

## Source-of-truth order

When documents disagree, use this order:

1. Safety boundary in this README.
2. `policy/lab-policy.json` for durable mechanism rules.
3. Dated records in `state/` for current profile and market facts.
4. Explanatory material in `docs/`.

Market context expires quickly. Update `state/latest-market-context.json` rather than rewriting durable rules after every scan.

## Validate

Run from this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1
```

The validator parses every JSON file, checks required documents, and verifies the most important local-only safety settings.

