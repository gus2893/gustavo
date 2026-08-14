# Debug: T22 Stage B materializer cleanup statements
**Originated during:** mcax-execute T22 Stage B materializer positive proof
**Status:** fixed

## Symptom (one sentence)

The scoped fixture cleanup failed because node-postgres cannot execute multiple parameterized SQL commands as one prepared statement.

## Reproduction

Run the trusted one-worker focused Playwright story after the positive production materialization reaches its cleanup transaction.

Result: exit 1 in 18.0 seconds; PostgreSQL reported `cannot insert multiple commands into a prepared statement`. Ownership residue was zero.

## Root cause

The cleanup passed several semicolon-separated deletes and parameters to one `query` call, which selects PostgreSQL's extended protocol and permits only one command.

## Fix

Await the same scoped parameterized deletes individually, in the same dependency order and inside the same admin transaction with its transaction-local replica cleanup context.

## Regression test

Rerun the focused story and exact residue gate.
