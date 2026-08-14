# Debug: T22 Stage B materializer soft assertion mask
**Originated during:** mcax-execute T22 Stage B materializer positive proof
**Status:** fixed

## Symptom (one sentence)

Playwright's soft promise matcher threw an internal `suggestedRebaseline` TypeError instead of reporting the materializer helper's underlying rejection.

## Reproduction

Run the trusted one-worker focused Playwright story with `expect.soft(helperPromise).resolves.toEqual(...)` around the new positive proof.

Result: exit 1 in 17.7 seconds; the story stopped after 373 ms at the pre-browser helper with `Cannot read properties of undefined (reading 'suggestedRebaseline')`. Ownership residue was zero.

## Hypothesis

H1: the helper rejects, and Playwright's soft promise wrapper masks that rejection while constructing its soft failure metadata.

## Fix

Await the helper explicitly, then apply the same soft deep-equality assertion to its returned proof. This changes only test reporting.

## Regression test

Rerun the focused story to expose the helper's actual result or underlying safe failure.
