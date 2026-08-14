# Debug: T11 invalid market-window clock
**Originated during:** mcax-execute T11
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/market-data/finnhub-poller.test.ts` expected an invalid `Date` to fail with `MARKET_WINDOW_START_INVALID`, but the test failed because `createMarketWindowPlan` instead threw the native `Invalid time value` error.

## Reproduction

1. Call `createMarketWindowPlan(new Date(Number.NaN))` in the T11 focused test.
2. Run the complete `tests/market-data/finnhub-poller.test.ts` file.

Result: the invalid-clock regression test fails consistently with `Invalid time value`.

## Hypotheses

- H1: the default `marketOpen` expression formats the date before the function body validates it. Confirmed by the parameter initializer calling `regularSessionIsOpen(windowStartsAt)` and the failure originating before the guarded body can run.
- H2: the body's date validation accepts `NaN`. Refuted by `Number.isFinite(new Date(Number.NaN).getTime())` returning false.
- H3: quote arithmetic formats the invalid date after validation. Refuted because quote arithmetic is after the validation guard and is never reached.

## Root cause

The `marketOpen` default parameter is evaluated before `createMarketWindowPlan` enters its body. That initializer passes the invalid date to `Intl.DateTimeFormat.formatToParts`, so the native formatter error preempts the intended trust-boundary error.

## Fix attempts (counter)

1. Made the session override optional and resolved the default regular-session state inside the function body after date validation: regression and wider checks pass.

## Regression test

File: `tests/market-data/finnhub-poller.test.ts`

Description: passes an invalid `Date` and requires the stable safe error `MARKET_WINDOW_START_INVALID`.

Pre-fix result: failing. Post-fix result: passing.

## Fix

`lib/server/market-data/session.ts` now validates the input date before invoking the New York session formatter.

## Wider check

`pnpm vitest run tests/market-data/finnhub-poller.test.ts` and `pnpm exec tsc --noEmit` both pass.
