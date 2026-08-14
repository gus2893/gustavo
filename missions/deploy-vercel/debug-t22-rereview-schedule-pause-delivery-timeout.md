# Debug: T22 re-review schedule pause delivery timeout
**Originated during:** mcax-execute T22 Stage A re-review
**Status:** fixed

## Symptom (one sentence)

The independent post-pause delivery RED attempted an unreachable reserved loopback target and timed out instead of returning the required safe paused-schedule rejection.

## Reproduction

Run the trusted Node 24/pnpm focused Playwright story with one worker after pausing the market schedule and requesting one more fixture-owned delivery to a reserved, released loopback port.

Result: exit 1 in 42.8 seconds; the story timed out at 24.6 seconds, and the subsequent ownership scan reported zero owned processes, files, and directories.

## Hypothesis

H1: the fixture does not check schedule state before signing and starting its outbound delivery, while its 20-second outbound timeout can outlive the browser test's remaining budget.

## Evidence

The delivery route read the target, created the signed `MARKET_CURRENT` request, and called the loopback `/wake` endpoint without consulting `marketSchedulePaused`. The only outbound bound was 20 seconds; the caller therefore did not receive a stable paused response.

## Fix

Reject a paused schedule with HTTP 409 before reading delivery control, signing, or making outbound I/O. Map that response to `E2E_MARKET_SCHEDULE_PAUSED`. Bound an admitted unpaused outbound delivery to two seconds and await its completion or cancellation through the existing route promise.

## Regression test

The browser story pauses the schedule, then requires a fixture-owned new delivery to reject with `E2E_MARKET_SCHEDULE_PAUSED` before maintenance continues.
