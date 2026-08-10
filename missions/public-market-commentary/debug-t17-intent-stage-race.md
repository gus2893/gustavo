# T17 intent/stage race debug record

## Symptom

A deterministic two-connection regression held the selected stage advisory lock, let `submitPaperIntent` read that stage and wait, terminalized the stage on the lock-owning connection, then released it. Before the fix, submission resolved as `REJECTED` and appended intent/rule rows to the terminal predecessor instead of rejecting current-stage authority.

## Root cause

Submission selected `currentStage()` before acquiring the stage advisory and row locks, then trusted that stale row after the concurrent terminal transaction committed.

## Fix and evidence

After taking both locks, submission resolves the unique current stage again and requires the ID to match the original selection. The focused concurrent regression now rejects with `PAPER_INTENT_CURRENT_STAGE_INVALID` and the predecessor's intent count remains unchanged.
