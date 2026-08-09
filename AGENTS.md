# Repository Guidelines

## Project Structure & Module Organization

This is a documentation-first knowledge repository for a local paper-trade lab. Durable mechanism rules belong in `policy/lab-policy.json`; do not encode temporary prices or active theses there. Current account and risk-day facts live in `state/current-profile.json`, while replaceable scan observations live in `state/latest-market-context.json`. `docs/` explains the policy in human-readable form and records dated decisions. `schemas/` describes local API and passive-export payloads, and `templates/` provides append-only record formats.

The safety boundary in `README.md` outranks every other file. This repository must never become a broker adapter, signal copier, or execution path.

## Validation Commands

Run the complete repository check with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1
```

The script parses all JSON files, checks required documents, confirms that real-account connectivity is disabled, and rejects an export destination that points at the active `Trade\New` inbox. Also run `git diff --check` before committing documentation edits.

## Documentation & Data Conventions

Use ISO-8601 UTC timestamps for dated observations and epoch milliseconds only where the tracker API requires them. Write prices as JSON numbers, not formatted strings. Clearly label Coinbase as live public exchange data and Yahoo as potentially delayed public intraday data. Separate confirmed completed-candle evidence from unfinished-candle observations.

Keep deterministic setup keys in the form `scan:<SYMBOL>:<completed-15m-time>:<long|short>:<slug>`. A materially new completed-candle thesis gets a new key; ordinary price updates do not.

## Safety Rules for Changes

Never add credentials, account identifiers, confirmation tokens, broker URLs, or code that invokes `trade.cmd`. Never write or move artifacts into `Trade\New`, `processing`, `placed`, or `failed`. Add a CFT contract mapping only with explicit platform evidence, recording it through `templates/symbol-verification.md`. Paper setups and orders must retain the exact warning: “PAPER LAB ONLY — do not copy this trade to CFT.”

