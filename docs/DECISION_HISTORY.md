# Decision History

This file captures mechanism-changing decisions and notable paper outcomes from the chat. It is not a performance claim.

## Profile transition

- The user independently reported completing the $2,500 level.
- The modeled next level began at epoch `1786113002011` (`2026-08-07T14:30:02.011Z`) with $5,000 equity and a $5,500 target.
- Only paper trades created at or after that epoch affect the new profile. Older trades are still inspected for pending/open exposure.

## New-profile ledger through 2026-08-08T23:49:40Z

| Symbol | Result | Simulated P&L contribution |
| --- | --- | ---: |
| `V` | Stopped | -$52.0190 |
| `USDJPY` | Cancelled | $0.0000 |
| `USOIL` | Stopped | -$75.0000 |
| `RUSSELL2000` | Stopped | -$53.3769 |
| `AVAX-USD` | Stopped | -$75.0000 |

Modeled equity: **$4,744.6041**. This is only $14.6041 above the $4,730 internal no-new-order floor.

For the risk day beginning `2026-08-08T00:05:00Z`, AVAX was the only full stopped attempt: $75 realized loss, one stopped attempt, and no pending/open trades.

## AVAX decision

- Local paper order: ELITE long, entry `6.516`, stop `6.49`.
- Targets: `6.572` (40%), `6.596` (35%), `6.66` (25%).
- Simulated risk: $75.
- The setup stopped.
- The user explicitly verified `AVAX-USD -> AVAXUSDT.cft` afterward.
- Export policy was expanded to allow confirmed ELITE artifacts at 1.5% tier risk, using only the first target if it preserves at least 2R.
- Safety was later tightened: passive artifacts belong only in `Trade\paper-lab-exports`; `Trade\New` is forbidden because it is an execution inbox.

## ETH decision sequence

- Confirmed resistance `1918.39–1925.00` had five separated 1H pivot episodes.
- ETH completed a 15m close below resistance, retested it, and rejected.
- The short was not taken because 4H bias remained up and price entered the opposing confirmed `1911.30–1917.42` zone. Chasing lower would have violated alignment and reward-quality rules.
- At the latest recorded scan, ETH remained inside that lower zone without a confirmed breakout.

## Watchlist lessons

- A completed breakout is not enough; the later retest must also complete.
- A visually dramatic or low-priced instrument receives no quality upgrade.
- An immediate opposing zone can leave an otherwise attractive setup at STANDARD.
- A watchlist card can change `sourceKey` when a materially new completed trigger replaces the old thesis, as occurred when ADA progressed from support reclaim to confirmed resistance breakout.

