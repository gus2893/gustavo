# Trading Mechanism

## Decision ownership

The local tracker supplies prices, candles, pivots, zones, and paper-trade state. It does not decide whether a trade exists. The monitor recalculates the evidence on every run and makes the final local paper-lab decision.

The watchlist is display-only. A card is not an order, and an order is never authorization to act in a real account.

## Timeframe hierarchy

1. **4H bias** establishes direction. Up requires both the most recent confirmed high and low to rise; down requires both to fall. Mixed structure is neutral.
2. **Confirmed 1H pivots and zones** define support, resistance, entry context, and structural invalidation. A default pivot needs five completed candles on each side. Touches from one congestion episode are not treated as separate evidence; the tracker uses a six-bar minimum episode gap.
3. **Completed 15m candles** supply the trigger. A wick or active candle never confirms a break. The complete candle must close through the whole zone.
4. **The active 15m candle** is observed only as an unfinished possibility. It may shape the next condition but cannot satisfy it.

## Valid trigger families

- Breakout followed by a completed retest that holds the broken zone.
- Strong completed rejection from a confirmed zone.
- False break followed by a completed reclaim and a completed hold/retest.

Entries are passive limits at the retest or rejection area. The mechanism does not chase price after an extended candle.

## Structural geometry

- Entry comes from the confirmed retest area, not from a desired position size.
- Stop sits beyond structural invalidation.
- A stop is never tightened to manufacture leverage or quantity.
- Targets come from established opposing structure.
- Nearby confirmed opposing zones can invalidate reward quality even when direction and trigger look attractive.
- Emerging 15m zones are context, not substitutes for confirmed 1H structure.

## Session and data validity

- Coinbase crypto is live public exchange data and trades around the clock.
- Yahoo stocks, forex, indices, ETFs, and commodities are public intraday data and must always be labeled **potentially delayed**.
- Ignore stale or disconnected providers and rows whose history is not ready.
- Do not open stocks, ETFs, or US indices outside their regular session.

## Correlation discipline

Only one pending/open trade may express substantially the same directional thesis within a correlated cluster. Clusters include crypto, US equities/US indices, energy, precious metals, grains, and overlapping FX crosses. Uncorrelated setups may coexist only within the portfolio-risk buffer.

