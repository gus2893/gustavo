# T16 debug — completed job result completeness

## Red

A caller could directly insert a durable order job already marked `COMPLETED` without inserting its canonical result.

## Root cause

The lifecycle guard covered the normal leased-to-completed update but not an initially completed insert, allowing durable job status to claim success without a hydratable result.

## Fix

Migration 0011 adds a deferrable constraint trigger on insert and update. At transaction commit, every completed job must have exactly one validated result bound to the same job, order, and observation. Deferral preserves either valid statement order inside a transaction while rejecting incomplete commits.

## Regression

The focused test first demonstrated that an initially completed job without a result committed. It now rejects with `CHALLENGE_ORDER_JOB_RESULT_REQUIRED`; completed retries continue to hydrate only a canonical matching result.
