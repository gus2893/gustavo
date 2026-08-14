# Prompt update: SSE cancellation authority
**Date:** 2026-08-14
**Triggered by:** debug escalation (`debug-t17-queue-finalization.md`)
**Approval status before:** approved
**Approval status after:** needs re-approval → approved (2026-08-14)

## Change description

T17 proved that route-only wrappers can wake their own queue and finalize their Redis source, but cannot settle an active pull owned inside `openFeedStream`. After three evidence-led fixes, `ReadableStream.cancel()` still hung. The existing 54/55-second behavior therefore needs a shared stream-library cancellation boundary: it must stop admission, abort, and await every admitted authentication, authorization, protected-body load, replay/pubsub iteration, source close, iterator return, and response pull before completion. Ordered durable cursor replay, double authorization, private SSE output, and the duration limits do not change.

## Sections of 02-design.md updated

- ### R — Requirements / R5
  - **Was:** SSE closes within Vercel duration and reconnects through the existing ordered `Last-Event-ID` database cursor.
  - **Now:** lifecycle authority is installed before authentication, admission stops by 54 seconds, all admitted work settles, and the response closes by 55 seconds before reconnecting through the same durable cursor.
- ### Cloud maintenance and SSE
  - **Was:** a 55-second maximum with bounded heartbeats/cleanup and ordered database replay.
  - **Now:** one shared idempotent abort-and-settle pump owns active authentication, authorization, protected loading, replay/pubsub iteration, queue backpressure, source/iterator cleanup, and response completion; no database/decryption or Redis work may remain detached.
- ### Modified files / Testing strategy
  - **Was:** T17 touched only the route and its focused test.
  - **Now:** `lib/server/stream/events.ts` is an approved adjacent code file and the focused suite must prove queue-full and active-work settlement.

## Sections of 01-story.md updated

- None. The observable acceptance criteria already require bounded SSE closure and reconnect; this update corrects the internal authority needed to meet them.

## Impact

### Plan tasks invalidated

- T17: invalidated because its route-only file scope cannot own the active projection/pull finalizer; regenerate it with the shared stream library and the four deterministic cancellation regressions.
- T23: partially stale; the final gate must retain the focused SSE cancellation/reconnect suite after the shared pump change.

### Tests that must change

- `tests/stream/sse-authorization.test.ts` — prove queue-full abort, lifecycle-before-auth, hung revalidation, protected-load settlement, source/iterator cleanup, response cancellation, and unchanged ordered reconnect.
- `tests/deployment/vercel-hybrid.test.ts` — regression-only; retain the existing 60-second route manifest assertion.
- `tests/privacy/forget-propagation.test.ts` — regression-only; retain existing stream publication/privacy fences.

### Code files that must change

- `app/api/feed/stream/route.ts` — install lifecycle authority before authentication and compose the shared cancellation pump without weakening cursor/authorization rules.
- `lib/server/stream/events.ts` — expose one idempotent abort-and-settle stream authority that owns active load/revalidation, source close, iterator return, and readable completion.

### Verification status

- `05-verify.md`: not created; T23 must include the regenerated T17 focused gate.

## Re-approval

- Presented to user: 2026-08-14
- Confirmed approved: 2026-08-14 under the user's standing instruction to “Proceed with all without needed input”

## Next skill

`mcax-plan` — regenerate T17 and the T23 verification delta, then resume `mcax-execute`.
