# Debug: T9 authority races
**Originated during:** mcax-execute T9
**Status:** fixed

## Symptom (one sentence)

Final Stage B review found that T9's worker locked a conversation aggregate key/body before conversation authority while production forget locked conversation authority before that key, creating a real PostgreSQL deadlock cycle during both hydration and output.

## Reproduction

1. Pause the production worker immediately after its hydration or output body lock.
2. Start the production `forgetConversation` path and signal immediately before `privacy-forget-key-lock`.
3. Release the worker with every wait bounded, then observe whether forget had already reached the key or was blocked on conversation authority.

Result: before the fix, both races reported `forget-reached-key`, proving forget held conversation authority while waiting for the worker's key; the marker trace was key, body, authority. The three focused regressions failed deterministically in 14.37 seconds.

## Hypotheses

- H1: Multi-relation `FOR SHARE` leaves key/body acquisition order to the query plan. Confirmed by the current combined authority queries.
- H2: `appendMessage` and `completeBridgeJob` create a durable output-without-job-binding gap. Confirmed by their separate transactions.
- H3: Runtime replay starts from a guessable idempotency key instead of `bridge_model_jobs.output_event_id`. Confirmed by `existingNodeOutput`.
- H4: USER replay is treated as a new staged message because append results do not report whether the message row was inserted. Confirmed by unconditional job lookup and route publication.
- H5: Matching key-before-body order is insufficient when privacy forget first locks conversation authority. Confirmed by the production forget trace reaching its key while the worker was paused holding the same key/body before requesting conversation authority.

## Root cause

T9 correctly made key acquisition precede body acquisition but placed both before the broader source/output authority lock. Production forget establishes its authorization topology with a conversation row lock before requesting the aggregate key, so the two paths formed the cycle `worker key -> conversation` and `forget conversation -> key`.

## Fix attempts (counter)

1. Added ordered key/body locks, atomic output completion, bound replay, USER disposition, and explicit model mapping: focused regressions passed.
2. A global fake-timer route test stalled live PostgreSQL work: replaced it with an exact 2,000ms timer spy; passed.
3. A hidden insert discriminator broke the public append result contract: replaced it with explicit `appendMessageWithDisposition`; passed native-history and route regressions.
4. Reordered both worker transactions to acquire the existing claim advisory lock where applicable, then exact job/conversation/source authority, aggregate key, body, and final exact revalidation: both production-forget races passed.

## Regression test

File: `tests/bridge/jobs.test.ts`
Description: deterministic lock ordering/concurrency, real forget-vs-hydration and forget-vs-output races, atomic output binding, forged output rejection, exact-bound retry, and pruned USER replay coverage.
Pre-fix result: the final three lock regressions failed; both real forget races reached their key before the worker released its body lock.
Post-fix result: the final three regressions passed in 12.95 seconds; forget blocks on conversation authority, post-forget output is rejected without a Node event, and an in-flight atomic output binds its job before forget proceeds.

## Fix

- `worker/hybrid/runtime.ts`: locks exact hydration authority before aggregate key/body, then revalidates exact current identity and lease immediately before decrypting.
- `lib/server/history/messages.ts`: takes the bridge claim advisory lock and exact output authority before aggregate key/body, then revalidates immediately before the atomic Node append/job completion.
- `app/api/conversations/[conversationId]/messages/route.ts`: publish only newly inserted USER jobs and bound QStash await to 2,000ms.
- `tests/bridge/jobs.test.ts`: deterministic lock, provenance, pruning, timeout, canonical-result, and concurrency regressions.

## Wider check

- Focused final lock regressions: 3 passed.
- `tests/bridge/jobs.test.ts`: 68 passed. The first full attempt reached 60 passes before PostgreSQL exhausted C: space; after one exact stale, non-live test cluster was moved (not deleted) to the approved D: quarantine, the single rerun passed.
- `tests/conversations/native-history.test.ts tests/node-brains/router.test.ts tests/deployment/vercel-hybrid.test.ts`: 56 passed.
- `tsc --noEmit`: passed.
- Whitespace validation: passed.

## Lessons / design implications

Key-before-body is only a local invariant. Every privacy-sensitive transaction must first follow the topology authority order used by forget (conversation before aggregate key), and bridge output must take the claim advisory lock before the job row so it remains compatible with claim/recovery.
