# Prompt update: layered fast memory

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** needs re-approval

## Change description

The user asked Gustavo to use all information from every chat as long-term memory while keeping Account-Brain and Core-Brain conversations fast. Because the exact internal designs of ChatGPT and Claude are proprietary, the design adopts their documented product-level pattern: durable conversation state, selective durable memory, relevant-history search/RAG, and cached context. Gustavo adds explicit source provenance and privacy-scoped Brain handoffs.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** Full source history and rebuildable projections were required.
  - **Now:** Recall must be bounded, scoped, asynchronous to write, and independent of transcript size.
- **M — Layered memory and fast recall**
  - **Was:** No complete retrieval implementation contract.
  - **Now:** Seven memory layers, record metadata, write/read paths, handoff packets, local technology choice, and latency budgets are specified.
- **N — Non-goals**
  - Added prohibitions against full-history prompt injection, private-memory leakage to the Core Brain, projection-only storage, and claims of cloning proprietary systems.

## Sections of 01-story.md updated

- Added account-holder and Core-Brain stories for fast relevant recall.
- Added acceptance criteria for memory layering, provenance, scope isolation, asynchronous processing, bounded context, latency benchmarks, and user controls.

## Impact

### Plan tasks invalidated

- T2 data model: add versioned facts, episodes, source links, Brain state, handoff packets, embeddings, and supersession.
- T3 orchestration: add transactional outbox, asynchronous memory jobs, idempotent projection updates, and delta packet refresh.
- T4 conversation context: replace simple recent-history assembly with token-budgeted hybrid retrieval.
- T5 memory retrieval: define scoped full-text/vector fusion, ranking, deduplication, contradiction handling, and provenance capture.
- T6 authorization: enforce visibility filters before retrieval and prevent Core-Brain access to raw private chat.
- T8 scalability: benchmark retrieval and packet-cache latency against a million-event fixture.

### Tests that must change

- `tests/memory/extraction.test.ts` — source-linked typed-memory extraction and asynchronous retry behavior.
- `tests/memory/supersession.test.ts` — correction, contradiction, and version-history semantics.
- `tests/memory/retrieval.test.ts` — hybrid lexical/vector recall, scope filtering, ranking, and bounded results.
- `tests/memory/provenance.test.ts` — every recalled claim links to authorized source events.
- `tests/memory/rebuild.test.ts` — projections rebuild deterministically from immutable source events.
- `tests/memory/latency.test.ts` — p95 retrieval benchmark over at least one million events.
- `tests/handoffs/privacy.test.ts` — Core Brain receives transmitted/council memory but not raw account-private content.
- `tests/handoffs/cache.test.ts` — versioned cache invalidation and delta refresh.
- `tests/context/budget.test.ts` — prompts remain bounded as transcript length grows.

### Code files that must change after approval

- `db/schema/memory.sql` — typed/versioned memories, episodes, source links, embeddings, Brain state, and handoff packets.
- `lib/server/memory/write/*` — extraction, deduplication, contradiction, supersession, and projection jobs.
- `lib/server/memory/read/*` — authorization-first hybrid retrieval, fusion, ranking, and context packing.
- `lib/server/handoffs/*` — incremental source-linked Account-Brain packets for the Core Brain.
- `lib/server/context/*` — bounded recent/pinned/retrieved context assembly.
- `worker/memory/*` — idempotent background indexing and packet refresh.
- `app/api/memory/*` — authorized inspect, correct, forget, source, and export controls.
- `bench/memory/*` — million-event dataset generator and latency harness.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

`mcax-plan` after the user explicitly approves the combined Gustavo design, including layered memory and performance budgets.
