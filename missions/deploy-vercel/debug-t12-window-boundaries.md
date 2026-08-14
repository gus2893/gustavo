# Debug: T12 Finnhub window and value boundaries
**Originated during:** mcax-execute T12
**Status:** fixed

## Symptom 1 — late request start

Running `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "does not start a quote after the fixed five-minute window deadline"` was expected to make zero quote calls after an injected scheduler oversleep, but the new regression failed because `fetchQuote` was called 95 times.

## Reproduction 1

1. Configure an open window with `now()` initially returning `0`.
2. Inject `sleep(ms)` that advances the clock by `ms + 300_000`.
3. Run the focused test above.

Result: Vitest reported `expected "vi.fn()" to not be called at all, but actually been called 95 times`.

## Hypotheses 1

- H1: The loop checked only whether the planned start had been reached, not whether the actual start was still inside the five-minute window. Confirmed by inspecting the pre-fix pacing branch: any clock value later than the planned start passed its only comparison. Outcome: confirmed.
- H2: The existing absolute three-second plan would stop naturally after an oversleep. Refuted by the reproduction, where every subsequent target was already in the past and all 95 calls started. Outcome: refuted.
- H3: The 96-call cap was itself being exceeded. Refuted by the call trace: there were 95 quote calls plus the reserved status call, exactly 96. Outcome: refuted.

## Root cause 1

The pre-fix pacing branch in `lib/server/market-data/finnhub.ts` treated `actualStart >= plannedStart` as sufficient authority to begin a request. It had no upper comparison against `windowStartedAt + MARKET_WINDOW_DURATION_MS`, and its next target did not shift from a delayed actual start. Scheduler oversleep therefore converted all remaining targets into immediately eligible calls instead of failing closed.

## Fix attempts 1 (counter)

1. Track the prior actual start, shift every next target to at least three seconds after it, and reject any actual start at or after the fixed window end: passed the focused regression on the first attempt.

## Regression test 1

File: `tests/market-data/finnhub-poller.test.ts`

Description: `does not start a quote after the fixed five-minute window deadline` injects a deterministic five-minute oversleep and asserts zero quote calls, one used status call, and 95 finalized safe provider-error results.

Pre-fix result: failing, with 95 unexpected quote calls.

Post-fix result: passing.

## Symptom 2 — rounded zero price

Running `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "maps unavailable, stale, rate-limited, malformed, and network results without dropping symbols"` was expected to reject a positive provider price below the supported eight-decimal precision, but the result was incorrectly `SUCCESS` with `safeCode: null`.

## Reproduction 2

1. Return `{ c: 0.000000001, t: 200 }` for one catalog quote.
2. Run the focused mapping test above.

Result: Vitest showed expected `PROVIDER_ERROR/MALFORMED_RESPONSE` but received `SUCCESS` with a null safe code.

## Hypotheses 2

- H1: Eight-decimal normalization rounded the positive input to the string `"0"`, and the local decimal regex permitted that string. Confirmed by the pre-fix `toFixed(8)` result and the regex's explicit zero branch. Outcome: confirmed.
- H2: The raw zero/unavailable branch was handling the value before normalization. Refuted because the raw input was positive and bypassed the exact `current === 0` check. Outcome: refuted.
- H3: The source timestamp was invalid and caused a different mapping. Refuted because `t: 200` normalized to a valid ISO timestamp. Outcome: refuted.

## Root cause 2

`canonicalPrice` in `lib/server/market-data/finnhub.ts` bounded the raw number and formatted it to eight decimal places, but accepted the rounded string whenever it matched the syntactic price regex. The regex intentionally recognized `"0"`, so a positive value below representable precision became a successful zero price even though canonical market prices must be nonzero.

## Fix attempts 2 (counter)

1. Reject the canonical formatted value when it is exactly `"0"` before returning it: passed the focused mapping regression on the first attempt.

## Regression test 2

File: `tests/market-data/finnhub-poller.test.ts`

Description: the mapping matrix supplies `0.000000001` and requires the bounded `PROVIDER_ERROR/MALFORMED_RESPONSE` outcome rather than a successful zero price.

Pre-fix result: failing with `SUCCESS`.

Post-fix result: passing.

## Fix

- `lib/server/market-data/finnhub.ts`: shifted paced starts from actual execution time, enforced the absolute five-minute start deadline, and rejected prices that normalize to zero.
- `tests/market-data/finnhub-poller.test.ts`: retained deterministic regressions for scheduler oversleep and sub-precision price normalization.

## Wider check

- `pnpm vitest run tests/market-data/finnhub-poller.test.ts -t "returns exactly 95 bounded results and never starts call 97"` → 1 passed, 13 skipped, exit 0.
- `pnpm vitest run tests/market-data/finnhub-poller.test.ts` → 14 passed, exit 0.
- `pnpm exec tsc --noEmit` → exit 0.

## Lessons / design implications

Pacing requires both a lower bound between actual request starts and an absolute window-end bound; a nominal schedule alone does not fail closed after timer oversleep. Numeric validation must also be applied after precision normalization, because a valid positive raw number can become an invalid canonical zero.

## Stage B follow-up — future source time

### Symptom

The Stage B regression `accepts only bounded future skew within the active window` expected a quote timestamp six seconds beyond its receipt clock to fail closed, but it was returned as `SUCCESS`.

### Reproduction and hypotheses

1. Inject the monotonic and wall clocks at zero, return `t: 8` for the first request received at second 3, and `t: 12` for the second request received at second 6.
2. Run the three-test Stage B focus.

Result: the first value passed as expected, while the second incorrectly returned `SUCCESS` with source time `1970-01-01T00:00:12.000Z`.

- H1: quote parsing enforced only a lower freshness floor and had no source-time upper bound. Confirmed by the pre-fix `mapQuote` parameters and successful future result. Outcome: confirmed.
- H2: the request-window deadline also bounded source timestamps. Refuted because it bounded request starts only. Outcome: refuted.

### Root cause and fix

The adapter had no receipt-clock authority in quote mapping. It now separates monotonic pacing from an injected/default wall clock, permits at most five seconds of provider clock skew, caps that allowance below the active five-minute wall window, and maps later timestamps to `PROVIDER_ERROR/MALFORMED_RESPONSE`.

Fix attempts: 1. An upper bound derived directly from the pacing clock passed the new focus but made two established past-timestamp fixtures fail because that clock is monotonic, not epoch time. 2. Separating `now` from `wallNow` preserved the exact plan fixture and made the receipt boundary correct. The focused just-inside/just-outside regression and full file pass.

## Stage B follow-up — hostile fulfilled values

### Symptom

The Stage B regression `contains hostile fulfilled provider values as safe malformed results` expected null, primitive, accessor, and proxy fulfillments to become safe malformed items, but null escaped as `TypeError: Cannot read properties of null (reading 'status')`.

### Reproduction and hypotheses

1. Fulfill successive quote requests with `null`, a number, objects with throwing `status`/`json` accessors, and a throwing proxy.
2. Run the focused hostile-value test.

Result: the first null value rejected the entire poll instead of finalizing its symbol.

- H1: the deadline wrapper treated every fulfilled value as a trusted `FinnhubRawResponse` and parsing dereferenced it directly. Confirmed at the first `response.status` access. Outcome: confirmed.
- H2: promise rejection handling also covered invalid fulfillments. Refuted because the promise fulfilled normally. Outcome: refuted.

### Root cause and fix

The injected provider seam was typed and consumed as a trusted structure despite being a runtime trust boundary. It now fulfills `unknown`, accepts only plain records with own data descriptors, catches proxy/descriptor traps, and maps invalid structures to `MALFORMED_RESPONSE` without retaining exception details. A self-review regression then showed a nested JSON proxy could still escape through its property-descriptor trap; guarded descriptor results were extended through nested `c`, `t`, and `isOpen` reads.

Fix attempts: 1. Top-level unknown normalization fixed the reported null/accessor/proxy cases. 2. Structured own-data reads fixed the independently reproduced nested-proxy escape. Both focused regressions and the full file pass.

## Stage B follow-up — unbounded HTTP JSON

### Symptom

The Stage B regression `bounds streamed HTTP JSON and cancels every rejected body exactly once` expected a small fixed-length JSON stream to parse without invoking `response.json`, but the prior client accessed that guarded method and returned `{ status: 0 }`.

### Reproduction and hypotheses

1. Supply Response-shaped objects whose `json` getter throws and whose body exposes an instrumented streaming reader.
2. Exercise valid, missing-length, chunked, declared-oversized, actual-oversized, invalid-UTF-8, invalid-JSON, and HTTP-429 cases.

Result: the valid bounded body failed immediately because the old implementation required and called `response.json()`; no explicit byte authority existed.

- H1: `response.json()` buffered provider input without an application byte cap. Confirmed by inspection and the guarded-getter failure. Outcome: confirmed.
- H2: `Content-Length` alone already enforced a body bound. Refuted because the previous implementation never read it, and it would not detect a mismatched actual stream by itself. Outcome: refuted.

### Root cause and fix

The default HTTP transport delegated buffering and parsing to `Response.json()` and parsed bodies even when status alone determined the result. It now cancels and skips every non-200 body, rejects missing length and transfer encoding, treats `Content-Length` only as an additional declared bound, independently counts at most 4,096 streamed bytes, requires actual/declaration equality, uses fatal UTF-8 decoding plus `JSON.parse`, and performs one best-effort cancellation on every rejected body. Requests ask for identity encoding so the fixed-length comparison remains meaningful.

Fix attempts: 1. The bounded streaming reader passed the full eight-case matrix on its first focused run.

## Stage B wider check

- Exact plan focus: 1 passed, 16 skipped, exit 0.
- Stage B focus: 3 passed, 14 skipped, exit 0.
- Full `tests/market-data/finnhub-poller.test.ts`: 17 passed, exit 0.
- `pnpm exec tsc --noEmit`: exit 0.

## Final Stage B follow-up — default stale floor

### Symptom

The regression `defaults the stale floor to the source window while preserving an explicit override` expected a quote from one second before the wall-clock window start to be `UNAVAILABLE/STALE_QUOTE`, but the adapter returned it as `SUCCESS`.

### Reproduction and hypotheses

1. Start the source wall window at epoch second 100.
2. Return `t: 99` for AAPL and `t: 100` for MSFT without supplying `minimumSourceTimestampSeconds`.
3. Run the focused default-floor test.

Result: AAPL was accepted with source time `1970-01-01T00:01:39.000Z`.

- H1: the clock-separation fix defaulted the lower source bound to zero, so only callers providing an override received stale protection. Confirmed by the `?? 0` initialization and the successful old quote. Outcome: confirmed.
- H2: the future-time upper bound also rejects observations before the window. Refuted because it is intentionally one-sided. Outcome: refuted.

### Root cause and fix

While separating monotonic pacing from wall receipt time, the default lower bound was changed from a window-derived value to zero to preserve historical test fixtures. That weakened production behavior by making stale rejection opt-in. The default is now `Math.floor(sourceWindowStartedAt / 1_000)`; a supplied, validated `minimumSourceTimestampSeconds` still overrides it exactly. The historical pacing-failure fixture now injects the wall time corresponding to its fixed provider timestamp instead of relying on the real current clock.

Fix attempts: 1. Restoring the source-window default made the focused regression pass. The wider file then exposed one test fixture whose historical provider time lacked a matching injected wall clock; correcting that fixture restored its intended pacing assertion without changing production behavior.

### Regression and wider check

- Default-floor/override focus: 1 passed, 17 skipped, exit 0 after the fix.
- The regression proves `t: 99` is stale at a second-100 window, `t: 100` succeeds, and an explicit floor of 99 permits the older value.
