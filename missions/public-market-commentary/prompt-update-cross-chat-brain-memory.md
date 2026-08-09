# Prompt update: continuous brain-like cross-chat memory

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** approved

## Change description

The user required Gustavo to remember context from this chat and every other chat with fast, brain-like recall. The design now captures every native Gustavo conversation automatically and accepts outside histories only through authorized exports/connectors. It adds layered functional memory, scope-first associative retrieval, a temporal knowledge graph, incremental consolidation, conflict handling, and recall provenance without claiming hidden access or consciousness.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** This task/repository seeded Main memory, and future thought storage was durable.
  - **Now:** All native chats continuously feed memory; external chats use authorized incremental sources; scope filtering precedes every recall operation.
- **G — Continuous cross-chat memory graph**
  - Added capture boundaries, seven functional memory systems, visibility scopes, consolidation, graph structure, recall planning, speed strategy, and user controls.
- **T — Thought ledger**
  - Added chat source/cursor/conversation/message, memory graph, consolidation, goal/procedure, and recall-trace tables.
- **N — Non-goals**
  - Prohibited claims of arbitrary external-chat access, permissionless private recall, similarity-as-truth, and biological/sentience equivalence.

## Sections of 01-story.md updated

- Added a Main Brain story for fast memory across every authorized chat.
- Added acceptance criteria for native/external capture, layered memory, scopes, consolidation, multi-index retrieval, recall traces, forgetting, idempotency, conflict handling, and truthful product language.

## Impact

### Plan tasks invalidated

- T2 data model: add chat sources/cursors, conversations/messages, memory graph, entities/aliases, goals/procedures, consolidation runs, and recall traces.
- T3 ingestion: continuously capture native chats and incrementally import authorized external histories.
- T4 consolidation: add per-turn, episode-boundary, Main/Challenge-change, and periodic reconciliation jobs.
- T5 recall: add scope-first multi-index planning, graph expansion, fusion/reranking, conflict/temporal rules, and bounded context packs.
- T6 cache: prewarm Main/Node/Challenge capsules, hot entity neighborhoods, active goals, and recent episodes by source high-water mark.
- T7 privacy: propagate deletion/forgetting through derived memories, graph edges, indexes, summaries, and caches.
- T8 evaluation: add cross-chat known-answer, temporal, conflict, permission, provenance, and latency test suites.

### Tests that must change

- `tests/chats/native-capture.test.ts` — every committed native turn becomes durable source history.
- `tests/chats/external-import.test.ts` — only authorized exports/connectors create external chat sources.
- `tests/chats/incremental.test.ts` — cursor updates append new material without duplicates.
- `tests/memory/layers.test.ts` — working, episodic, semantic, procedural, relational, goal, and meta-memory remain typed/source-linked.
- `tests/memory/scopes.test.ts` — authorization filters precede vector, lexical, graph, and cache access.
- `tests/memory/consolidation.test.ts` — incremental jobs produce deterministic versioned projections without deleting source chats.
- `tests/memory/graph.test.ts` — typed temporal edges and bounded scope-aware traversal.
- `tests/memory/conflicts.test.ts` — current approved state outranks but does not erase superseded history.
- `tests/recall/planner.test.ts` — parallel multi-index candidates fuse into bounded source-linked context.
- `tests/recall/trace.test.ts` — every response records selected/excluded memories, sources, latency, and cache use.
- `tests/recall/latency.test.ts` — cross-chat warm/cold retrieval meets the approved scale budget.
- `tests/privacy/forget-propagation.test.ts` — authorized forgetting removes future influence from every projection and cache.

### Code files that must change after approval

- `db/schema/chats.sql` — sources, cursors, conversations, messages, participants, and source identities.
- `db/schema/memory_graph.sql` — nodes, typed temporal edges, entities, aliases, goals, procedures, and conflicts.
- `db/schema/recall.sql` — query plans, candidates, selected memories, exclusions, and recall traces.
- `lib/server/chat-sources/*` — native, export, and authorized connector adapters.
- `lib/server/consolidation/*` — episode segmentation, extraction, reconciliation, and prewarm jobs.
- `lib/server/recall/*` — authorization, planning, parallel indexes, graph traversal, fusion, reranking, and context assembly.
- `lib/server/memory/forget/*` — derived-data and cache propagation with audit events.
- `worker/consolidation/*` and `worker/recall/*` — asynchronous processing and deep-history jobs.
- `app/api/memory/sources/*` — connect/import/status/revoke source controls.
- `app/api/memory/recall/*` — inspect source-linked memories and recall traces.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

Continue planning after explicit approval of the continuous cross-chat memory architecture, then finalize the scoring rubric and Challenge stage-rule template.
