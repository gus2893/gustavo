# Passive JSON Exports and Symbol Verification

## Purpose and destination

An export is a passive local paper-tracking artifact. It is not an instruction to a broker and must never be consumed by an execution process.

Permitted directory:

```text
C:\Users\gusta\Desktop\Projects\Trade\paper-lab-exports
```

Forbidden directories include `Trade\New`, `processing`, `placed`, and `failed`. `Trade\New` is an active broker-execution inbox.

## Eligible setups

- STANDARD and NO TRADE never qualify.
- ELITE requires every ELITE action condition and a first structural target preserving at least 2R after likely costs.
- GREAT ELITE requires every GREAT ELITE condition and a first structural target preserving at least 2.5R after likely costs.
- The pending entry, structural stop, and first target must be predetermined from completed evidence.
- Never export a thesis that depends on the active unfinished candle.

## Minimal file

The file contains only:

```json
{
  "testOnly": true,
  "symbol": "VERIFIED_CONTRACT.cft",
  "tradeType": "pending",
  "price": 1,
  "side": "buy",
  "stopLoss": 0.9,
  "takeProfit": 1.2,
  "amounts": {
    "2500": 1,
    "5000": 2,
    "10000": 4
  }
}
```

Those numbers illustrate shape only. Real artifact values must come from a qualified local setup.

The deterministic filesystem-safe filename is derived from the unchanged `sourceKey` and ends with `-pending.json`. Check the exact path first and never create a duplicate.

## Export sizing

For each account size independently:

```text
riskPerUnit = abs(price - stopLoss)
desiredRisk = accountSize * 0.015 for ELITE
desiredRisk = accountSize * 0.02 for GREAT ELITE
leverageLimitedRisk = accountSize * categoryLeverageCap * riskPerUnit / price
actualRiskUsd = min(desiredRisk, leverageLimitedRisk)
amount = actualRiskUsd / riskPerUnit
```

Use the category leverage caps from `GRADING_AND_RISK.md`. “Worthy size” means full tier risk only when allowed; it never permits exceeding a tier, risk gate, leverage cap, or margin-headroom rule. Skip an ELITE export below 1% effective account risk and a GREAT ELITE export below 1.5%.

## Verified CFT contract mappings

| Local/provider symbol | Exact verified CFT contract | Evidence source |
| --- | --- | --- |
| `USOIL` | `USOUSD.cft` | Observed platform mapping reported in this chat context |
| `AVAX-USD` | `AVAXUSDT.cft` | Explicitly verified by the user in this chat |

Every other CFT contract name remains unverified. Do not export it until imported from the platform or explicitly verified by the user. Record new evidence with `templates/symbol-verification.md`.

No AVAX JSON was created in the documented chat sequence. The AVAX paper setup stopped before a safe eligible artifact was produced.

