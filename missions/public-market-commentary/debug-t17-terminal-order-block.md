# T17 terminal-order block debug record

## Symptom

The first permanent-failure regression showed that a previously open paper order could append a stop closure after its stage was already terminal. Adding the terminal guard then exposed a second boundary: a stage could pass while a qualifying position was still open, which would strand that position when later lifecycle work was correctly blocked.

## Root cause

New submissions were blocked by current-stage selection, but the existing-order worker had no terminal check. Separately, pass eligibility considered equity and qualifying days without requiring all pending/open simulated exposure to be resolved.

## Fix and evidence

The worker now preserves immutable completed-result retries, rejects unfinished work before job creation when the stage is terminal, and rechecks under the stage advisory/row lock before any lifecycle mutation. Failure still terminates immediately. Passing is deferred while a pending order or open position exists, so the closing mutation can commit and atomically append the terminal decision. The focused regression first resolved `CLOSED` instead of rejecting, then the suite exposed three stranded-open cases; the final focused suite passes 16/16.
