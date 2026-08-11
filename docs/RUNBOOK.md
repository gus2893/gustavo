# Monitor Runbook

## 1. Service preflight

1. `GET http://127.0.0.1:4317/api/health`.
2. If the response is `{ "ok": true }`, reuse the existing service.
3. If unavailable, run `npm run ensure` exactly once from `C:\Users\gusta\Desktop\Projects\live-level-tracker` and retry health once.
4. If the retry fails, report the service failure and stop without ordering, syncing exports, or creating files.

Never run `npm run dev`, Vite, `tsx watch`, or start a second tracker while port 4317 is healthy.

## 2. Load complete state

Each run performs:

- one `GET /api/paper-trades`, accounting for every pending, open, closed, stopped, completed, and cancelled trade;
- one `GET /api/instruments`;
- one scanner request for each category: `crypto`, `stock`, `forex`, `index`, and `commodity`, each with `limit=8`.

The universe contains 95 local public-provider mappings. Do not claim it is the exact complete CFT catalog.

## 3. Filter and inspect

- Exclude stale/disconnected providers and `historyReady: false` rows.
- Respect session metadata.
- Select a diverse shortlist near confirmed structure.
- Load a full snapshot for every pending/open symbol and at most eight additional finalists.
- Recalculate 4H bias, confirmed 1H structure, completed 15m triggers, and the active unfinished candle.

## 4. Manage existing trades first

- Cancel an invalidated pending order with `PATCH /api/paper-trades/:id { "action": "cancel" }`.
- An open paper trade may be closed early only when structure invalidates before the stored stop; otherwise let the local tracker manage stop and targets.
- Report every placement, cancellation, opening, or closing with grade, entry, stop, targets, actual simulated risk, and estimated leverage.

## 5. Grade candidates

Apply `STANDARD`, `ELITE`, and `GREAT ELITE` exactly as defined in `GRADING_AND_RISK.md`. Unfinished candles cannot promote a setup.

## 6. Sync watchlist exactly once

After all finalists are evaluated, send one `POST /api/potential-setups/sync` with no more than eight current directional candidates. Include only `forming` or `confirmed` setups. Omit `NO TRADE` rows and symbols already pending/open. Send an empty list to expire stale cards.

Use a deterministic key:

```text
scan:<SYMBOL>:<original-completed-15m-trigger-time>:<long|short>:<slug>
```

Keep the key while the completed-candle thesis is unchanged. Create a new key only when the completed-candle thesis materially changes.

## 7. Consider a paper order

Only ELITE or GREAT ELITE may be submitted. Recheck all profile, daily-loss, portfolio-risk, leverage, duplicate, symbol, and correlation gates immediately before `POST /api/paper-trades`.

## 8. Consider a passive JSON export

Apply `EXPORTS_AND_SYMBOLS.md`. Never write to the active broker inbox.

## 9. Report

Lead with profile equity/target and `ready/95`, list pending/open trades first, then finalists with grade, price, countdown or `MARKET CLOSED`, status, and one reason. Summarize categories without candidates and report the number of synced cards.

Every update containing a setup or order must contain exactly:

> PAPER LAB ONLY — do not copy this trade to CFT.

