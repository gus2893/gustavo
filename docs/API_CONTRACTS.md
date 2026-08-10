# Local Tracker API Contracts

Base URL: `http://127.0.0.1:4317`. These endpoints operate only on the local tracker.

## Read endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service preflight; healthy response is `{ "ok": true }`. |
| `GET /api/paper-trades` | Complete paper-trade ledger. |
| `GET /api/instruments` | Mapped universe, sessions, categories, providers, and CFT mapping status. |
| `GET /api/scanner?limit=8&category=<category>` | Compact category shortlist and readiness count. |
| `GET /api/snapshot/<SYMBOL>` | Full candles, bias, pivots, zones, events, and paper trades for one symbol. |
| `GET /api/potential-setups` | Current display-only watchlist. |

## Watchlist sync

`POST /api/potential-setups/sync` is called exactly once per monitor run.

```json
{
  "setups": [
    {
      "sourceKey": "scan:ADA-USD:1786231800:long:19931-breakout-retest-forming",
      "symbol": "ADA-USD",
      "direction": "long",
      "status": "forming",
      "quality": "standard",
      "observedPrice": 0.1994,
      "entryZone": { "lo": 0.1993, "hi": 0.19931 },
      "riskUsd": 75,
      "trigger": "Require a completed retest holding the broken zone.",
      "reason": "Completed breakout exists; the active retest is unfinished.",
      "expiresAt": 1786235680016
    }
  ]
}
```

Only include `entry`, `stop`, `estimatedLeverage`, and allocated `takeProfits` when geometry is structurally established. Allocations must total 100 when supplied.

## Paper order

`POST /api/paper-trades` accepts an idempotent local limit order. The same `sourceKey` must never be duplicated.

```json
{
  "sourceKey": "scan:SYMBOL:COMPLETED_CANDLE_TIME:long:trigger-slug",
  "symbol": "SYMBOL",
  "name": "SYMBOL ELITE structure description",
  "direction": "long",
  "entry": 100,
  "stop": 98,
  "takeProfits": [
    { "price": 104, "allocationPct": 100 }
  ],
  "riskUsd": 75,
  "reason": "Completed structural evidence, grade, and estimated leverage."
}
```

This is a shape example, not a market setup.

## Trade actions

```json
{ "action": "cancel" }
```

```json
{ "action": "close", "price": 100 }
```

Use `PATCH /api/paper-trades/:id`. Cancellation applies to pending trades. Early close applies only to an open paper trade with structural invalidation.

## Local reconciliation behavior

- Pending long entries trigger when price/candle low reaches entry; pending shorts trigger when price/candle high reaches entry.
- Stops are evaluated conservatively before targets when one OHLC candle could contain both.
- Partial targets reduce remaining exposure.
- Paper P&L is calculated from hit allocations plus the remaining quantity at stop, manual close, or current price.

