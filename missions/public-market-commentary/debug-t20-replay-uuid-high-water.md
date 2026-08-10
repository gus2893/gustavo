# Debug: T20 replay UUID high-water aggregate

**Originated during:** mcax-execute T20 Stage A correction
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/chats/incremental.test.ts` expected bounded event-ID replay paging to reconstruct chat state, but every replay case failed with PostgreSQL error `function max(uuid) does not exist`.

## Reproduction

1. Import any valid external chat source.
2. Call `replayChatSourceState` after the event-ID high-water paging change.
3. Observe the first manifest-page query.

Result: PostgreSQL rejected `max(event_id) over()` because UUID values are orderable but the runtime does not define a `max(uuid)` aggregate.

## Hypotheses

- H1: PostgreSQL cannot compare UUID values for keyset paging. Refuted because the existing `event_id > $cursor::uuid` predicate is valid.
- H2: PostgreSQL supports UUID comparison but not the UUID `max` aggregate. Confirmed by the exact database error at the window expression while the UUID keyset predicate parsed successfully.

## Root cause

The replay query used an unsupported UUID aggregate to capture its immutable high-water mark. Canonical lowercase UUID text preserves UUID byte ordering, so aggregating the text representation provides the same boundary while subsequent keyset comparisons remain explicitly UUID-typed.

## Fix attempts (counter)

1. Replace `max(event_id) over()` with `max(event_id::text) over()` and retain `event_id > $cursor::uuid` / `event_id <= $highWater::uuid`: fixed.

## Regression test

File: `tests/chats/incremental.test.ts`

Description: canonical replay, projection-free rebuild, and the multi-page maximum-manifest replay all traverse the captured UUID high-water boundary.

Pre-fix result: three replay cases failed with `function max(uuid) does not exist`.

Post-fix result: passing.

## Fix

`lib/server/chat-sources/import.ts` now derives the window high-water from canonical UUID text and continues to compare both cursor and high-water parameters as UUID values.

## Wider check

Commands run after the fix: `pnpm vitest run tests/chats/incremental.test.ts` and `pnpm exec tsc --noEmit`.

