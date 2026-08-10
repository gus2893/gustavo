# Grading, Sizing, and Risk

## Quality grades

### STANDARD

Interesting directional structure that is missing at least one action requirement. It may be shown as `SETUP FORMING` but must never become a paper order or JSON export.

### ELITE

All of the following are required:

- provider live/fresh and history ready;
- permitted session open;
- 4H bias aligned;
- confirmed 1H zone;
- completed 15m breakout-and-retest or strong rejection;
- passive limit at the retest rather than a chase;
- stop beyond structural invalidation; and
- at least 2R blended reward after likely spread and commission.

Desired paper risk is $75, or 1.5% of the modeled $5,000 account.

### GREAT ELITE

All ELITE requirements plus:

- at least two genuinely separated confirmed 1H touch episodes;
- both trigger and retest/rejection completed;
- no nearby opposing confirmed zone blocks the path;
- at least 2.5R blended reward after likely costs;
- price is not in the middle of a range; and
- the thesis does not merely duplicate a correlated finalist.

Desired paper risk is $100, or 2% of $5,000. Any debatable element forces a downgrade.

## Position sizing

```text
riskPerUnit = abs(entry - stop)
desiredRisk = 75 for ELITE, 100 for GREAT ELITE
leverageLimitedRisk = simulatedEquity * categoryLeverageCap * riskPerUnit / entry
actualRiskUsd = min(desiredRisk, leverageLimitedRisk)
quantity = actualRiskUsd / riskPerUnit
estimatedLeverage = entry * quantity / simulatedEquity
```

Category caps:

| Category | Effective leverage cap |
| --- | ---: |
| Crypto and stocks | 4x |
| Indices and ETFs | 16x |
| Forex and commodities | 24x |

Maintain 20% margin headroom and never maximize available margin. Skip an order if `actualRiskUsd` falls below $50 for ELITE or $75 for GREAT ELITE.

## $5,000 profile gates

- Start: $5,000
- Target: $5,500
- Hard daily loss: $200
- Hard overall floor: $4,700
- Internal no-new-order floor: equity at or below $4,730
- Internal portfolio-risk ceiling: $150
- Stop after two full stopped attempts in the UTC risk day, which begins at 12:05 AM UTC.

Before a new order:

```text
portfolioRiskUsd =
  realized losses since 00:05 UTC
  + current open losses
  + remaining stop-risk of every pending/open trade
```

Reject the order if `portfolioRiskUsd + proposedActualRiskUsd > 150`.

At equity $5,500 or higher, stop placing orders and wait for a new profile. Continue scans and watchlist discovery.

## Duplicate protection

- At most one pending/open order per symbol.
- At most one materially identical thesis per deterministic `sourceKey`.
- At most one substantially identical directional thesis per correlation cluster.

