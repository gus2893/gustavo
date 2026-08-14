# Debug: T22 Stage B materializer setup statements
**Originated during:** mcax-execute T22 Stage B materializer positive proof
**Status:** fixed

## Symptom (one sentence)

After cleanup was corrected, the same node-postgres extended-protocol restriction rejected the probe's parameterized account-plus-entitlement setup query.

## Reproduction

Run the trusted one-worker focused Playwright story through the pre-browser materializer helper.

Result: exit 1 in 18.1 seconds; the helper stopped after 522 ms with `cannot insert multiple commands into a prepared statement`. Ownership residue was zero.

## Root cause

The fixture supplied two semicolon-separated setup inserts and parameters to one query call.

## Fix

Execute the unchanged account and entitlement inserts individually, in order, on one checked-out admin connection and one transaction.

## Regression test

Rerun the focused story and exact residue gate.
