# Public Market Commentary Story

**Approval status:** approved

## Product story

As a Gustavo account holder, I want my account to open one continuous private chat with one stable Node Brain, receive scheduled messages authored by the shared Main Brain, and have my Node Brain transmit materially useful feedback upstream, so my private relationship stays coherent while contributing to one shared intelligence.

As the Gustavo operator, I want the complete history of every account, Node Brain, transmission, Main Brain debate, broadcast, and decision retained as durable source data, so conversations can resume with their provenance intact and derived memory can always be rebuilt.

As a self-hosting operator, I want Gustavo to run from my own computer at `gustavo.lol` while producing encrypted, restorable cloud backups, so local control does not create a single point of data loss.

As an account holder, I want my Brain to remember relevant facts, decisions, preferences, ideas, and unresolved questions from our entire history without waiting for that history to be replayed, so every response feels continuous and fast.

As the Main Brain, I want compact, current, source-linked proposals from every Node Brain, so I can improve the shared response and Challenge without exposing unrelated private conversation content or loading every historical message.

As the Gustavo operator, I want the Main Brain to manage the one shared simulated Challenge, starting at $2,500 and advancing through doubled balance stages until $1,000,000, so every paper trade and stage result demonstrates the shared Brain system's tracked performance against explicit objectives and loss rules.

As the Gustavo operator, I want every observable thought artifact and state transition stored durably in the database while hot, authorized projections are cached, so the complete system can be reconstructed without making conversations or scheduled responses slow.

As the Gustavo operator, I want the explicit trading knowledge currently preserved in this task and repository imported into the Main Brain with provenance, freshness, and lifecycle labels, so Gustavo begins with our actual methodology and lessons without treating obsolete instructions or dated prices as current truth.

As the Main Brain, I want every authorized conversation—past and future—to become searchable, source-linked memory across chats, so I can recall relevant people, ideas, methods, decisions, goals, and outcomes quickly without replaying complete transcripts.

As a public visitor without an account, I want to see that the live discussion feed is active without receiving protected response text, so I can understand Gustavo before creating an account.

## Vertical slice

The first public version supports one complete loop:

1. A person redeems one operator-issued invitation and creates one Gustavo beta account. Billing is outside the MVP.
2. Gustavo permanently assigns that account one stable named Node Brain for the account’s active lifetime.
3. The account holder uses one continuous private chat with that Node Brain; MVP does not expose additional Node chats or selectable Brain identities.
4. The Main Brain commits each canonical scheduled response and each timestamped Challenge baseline idea or `NO PAPER TRADE` decision.
5. Scheduled messages are delivered to every entitled user as Main Brain-authored content; Node Brains do not author or semantically alter those broadcasts.
6. During private dialogue, the Node Brain routes each turn either to the current Main Brain position or to an exploratory response that may produce a structured, source-linked feedback proposal.
7. The Main Brain and Node Brain exchange a bounded, recorded review, and a separate evaluator pass scores an anonymized proposal against the committed Main baseline.
8. The Node Brain’s proposal replaces or modifies the Main baseline only when it passes every hard gate and exceeds the baseline by the configured improvement margin; otherwise the Main response and Challenge decision remain unchanged.
9. If the selected idea has complete simulated trade geometry, the deterministic challenge-risk engine either rejects it or records an internal paper order in the shared Challenge Portfolio.
10. Simulated fills, costs, price marks, realized/unrealized P&L, drawdown, objective progress, and stage state are appended to the challenge ledger.
11. Every user message, Node response, Main broadcast, proposal, baseline commitment, review turn, score, selection, rule evaluation, paper trade, and stage transition is appended to the appropriate immutable timeline.
12. Authorized users stream only the fields they are entitled to see. Public visitors receive feed metadata and irreversible placeholder shapes, never hidden response text.

The loop may create internal simulated orders only. It never connects to, places, routes, exports, copies, or recommends a real-account order.

## Acceptance criteria

1. The public identity is **Gustavo**, the canonical production domain is **gustavo.lol**, and the working tagline is **“The market thinks out loud.”**
2. Each Gustavo account maps to exactly one stable Brain identity and exactly one continuous private chat for the account’s active lifetime.
3. An account holder cannot create additional Brain chats, switch Brains, or share the private conversation in MVP.
4. Every participant-to-Node-Brain idea that qualifies for upstream review is transmitted to the Main Brain in a structured record.
5. Every Brain-to-Brain debate and winner decision is recorded as an append-only event chain.
6. The winner rubric totals 100 points: evidence quality/freshness 25, structural clarity 20, cost-adjusted simulated geometry 20, falsifiability/invalidation 15, counterevidence/uncertainty 10, and portfolio independence/originality 10. It never scores expected profit, popularity, spending, or confidence language.
7. Public homepage HTML and public API responses contain no protected response text. The blurred feed is made from placeholders and safe metadata.
8. Authorized feed delivery uses an authenticated Next.js BFF, server-only authorization, least-data DTOs, TLS, no-store caching, and encrypted message bodies at rest.
9. Every market observation is timestamped and labels delayed data accurately.
10. Completed candles and unfinished candles are never conflated.
11. Commentary does not give personalized financial advice, guaranteed outcomes, or real-account execution instructions. Any simulated position size is labeled as internal challenge accounting.
12. All CFT, broker, prop-firm integration, external order, execution-inbox, credential, and real-account functionality is excluded. Internal challenge simulation is allowed.
13. Historical chat material that no longer fits is preserved only in prompt-update audit records.
14. Automated validation confirms role-based payload boundaries and absence of protected text from public page data.
15. Every user message, completed Node Brain response, structured proposal/transmission, Main-Node review turn, score, decision, prompt/model version, and correction is retained in an account-scoped append-only history.
16. Conversation summaries, embeddings, and search indexes are derived data; they may accelerate context retrieval but never replace or mutate the source interaction record.
17. The MVP runs locally through a documented container stack with no mandatory hosted database or hosted application runtime.
18. Scheduled cloud backups are encrypted before upload, exclude plaintext secrets, have retention rules, and are verified through automated integrity checks plus a documented restore drill.
19. Stateless web and worker processes, durable job IDs, idempotent writes, pagination, and account-keyed data access provide a path from one computer to multiple application instances without changing the product model.
20. An explicit owner/legal deletion operation may make protected content unrecoverable through key destruction while preserving a non-sensitive tombstone audit event; ordinary edits never rewrite history.
21. Memory is layered into immutable source events, recent working context, structured durable facts, episodic summaries, hybrid search indexes, and precomputed Brain handoff packets.
22. Every retrieved memory includes source event IDs, scope, confidence, creation time, and supersession state; a model-generated summary is never presented as the original message.
23. Raw account chat memory remains account-private. The Main Brain receives only explicitly transmitted material, council events, and public-safe projections unless a future permission model is separately approved.
24. Message writes complete after the source event is durably committed; memory extraction, embedding, summary refresh, and handoff-packet refresh run asynchronously through idempotent jobs.
25. A reference local benchmark with at least one million source events must achieve warm memory retrieval p95 at or below 250 ms and cached Brain handoff retrieval p95 at or below 100 ms, excluding model-generation time.
26. Memory recall uses bounded context: pinned account/Brain state, recent turns, top-ranked relevant episodes/facts, and source-linked excerpts. Complete history is accessible through pagination but is never injected wholesale into a model prompt.
27. Account holders can inspect, correct, forget, export, and identify the sources of durable memories within their authorization scope.
28. `UserAccount` and `ChallengePortfolio` are separate domain objects. The MVP has exactly one Main Brain-managed Challenge Portfolio; individual Node Brains contribute ideas but do not own separate balances.
29. The progression starts at $2,500. Passing a stage creates the next stage with exactly twice the prior stage's starting balance until the configured final $1,000,000 stage.
30. The default stage sequence is $2,500, $5,000, $10,000, $20,000, $40,000, $80,000, $160,000, $320,000, $640,000, and a capped final stage of $1,000,000.
31. Every stage stores starting balance, a 10% profit objective, target equity, a 4% daily-loss limit, a 6% static overall-loss limit, a 3% aggregate internal risk ceiling, a 1% per-position stop-risk limit, UTC reset rules, three minimum trading days, no deadline, the approved stock/ETF universe, the simulated cost model, and lifecycle state as versioned configuration.
32. Challenge balance, equity, realized/unrealized P&L, peak equity, drawdown, remaining target, and pass/fail state are derived deterministically from immutable paper-trade ledger events and timestamped price marks.
33. Every internal paper order must pass deterministic rule evaluation, data-freshness checks, duplicate/idempotency checks, and simulated risk limits before entering the ledger.
34. Passing requires target equity plus all enabled minimum-day or other stage conditions. Failure blocks new simulated orders. A stage is never silently reset or rewritten.
35. Every challenge interface and streamed challenge event is unmistakably labeled **SIMULATION ONLY — NOT A REAL TRADE**.
36. No challenge feature accepts broker credentials, connects to a prop firm/exchange, creates an external execution payload, or invokes an execution program.
37. All Node Brains contribute to the same shared Challenge Portfolio; none can directly mutate its balance, orders, positions, risk, or stage state.
38. Each decision window begins with an immutable Main baseline commitment containing either a complete paper thesis or `NO PAPER TRADE`, its evidence snapshot, and its timestamp.
39. Challenger ideas are anonymized for an evaluator pass and compared using the same published rubric, data snapshot, cost assumptions, and hard geometry/freshness gates as the Main baseline.
40. A challenger affects the shared Challenge Portfolio only when it beats the Main baseline by the configured minimum improvement margin and passes the deterministic challenge-risk engine. A tie or failed gate leaves the Main decision unchanged.
41. Main baselines, challengers, reviews, scores, evaluator versions, selections, and reasons are permanently source-linked so contribution quality can be audited without revealing the account holder’s private chat.
42. The initial improvement margin is 5 points on the approved 100-point rubric, and an actionable Main or Node paper thesis must score at least 80/100 after every hard gate passes.
43. Gustavo has exactly one authoritative Main Brain and many user-facing Node Brains. Node Brains are conversational branches of the Main Brain, not independent authorities or separate challenge owners.
44. Every scheduled user message is committed and attributed to the Main Brain. Delivery through a Node/account channel cannot change its semantic body or present the Node as its author.
45. Only a user's assigned Node Brain holds that user's continuous private dialogue. The Main Brain receives structured proposals and authorized source references rather than unrestricted raw-chat access.
46. Each interactive Node turn records one routing mode: `MAIN_DEFAULT`, `NODE_EXPLORE`, or `PROPOSAL_UPSTREAM`.
47. `MAIN_DEFAULT` answers from the current versioned Main position. `NODE_EXPLORE` may acknowledge, question, or test user feedback but cannot claim that the Main Brain has changed its view.
48. `PROPOSAL_UPSTREAM` requires material new evidence, a correction, a clearer falsifiable thesis, or a better cost-adjusted paper idea. Mere agreement, repetition, popularity, or payment status is insufficient.
49. The Main Brain alone commits canonical responses, scheduled broadcasts, shared Challenge baselines, accepted proposal changes, and final portfolio intents.
50. Every user is clearly informed that qualifying feedback may be summarized and transmitted by their Node Brain to the Main Brain; raw private-chat disclosure requires a separately authorized scope.
51. PostgreSQL is the authoritative store for every message, structured thought record, evidence item, uncertainty, proposal, evaluation, decision, Main-state version, Node-state version, broadcast, Challenge event, and audit event.
52. A structured `ThoughtRecord` stores observable rationale—not hidden chain-of-thought—with a type, actor, visibility scope, concise rationale, evidence/counterevidence links, uncertainty, source events, state version, timestamp, and supersession status.
53. Durable source events and required thought records commit in one transaction before an action is acknowledged; background memory extraction and cache refresh cannot be the only copy.
54. Caches contain only authorized, rebuildable projections such as current Main state, Node dossiers, recent context packs, handoff packets, broadcasts, Challenge snapshots, retrieval results, and rate-limit/session metadata.
55. Every cache key includes the relevant identity/scope and source version. Event-driven invalidation plus versioned keys prevents stale or cross-account responses.
56. Private raw chat text is not placed in a shared cross-account cache. Protected cached content is minimized, short-lived, access-scoped, and encrypted before storage when it must leave process memory.
57. Startup and disaster recovery can discard every cache and deterministically rebuild required projections from PostgreSQL without losing a thought, conversation, decision, or Challenge event.
58. Scheduled Main broadcasts and active Challenge/Brain state are precomputed and prewarmed; cache misses fall back to bounded database queries without scanning complete history.
59. Cache hit rate, miss latency, freshness lag, invalidation failures, queue lag, and database fallback latency are observable and included in performance verification.
60. A one-time, rerunnable bootstrap importer reads the available conversation export, repository knowledge documents, schemas, policy files, dated market context, and paper-trade decision history into source-linked database records.
61. Every imported trading record is classified as `CANONICAL`, `CANDIDATE`, `HISTORICAL`, `DEPRECATED`, or `PROHIBITED`, with source locator, content hash, import version, effective dates, freshness/expiry, and reviewer status.
62. Structural methodology—including 4H bias, confirmed 1H zones, completed 15m triggers, unfinished-candle treatment, data freshness, session rules, correlation controls, deterministic identity, and paper-risk lessons—is imported for Main Brain review.
63. Dated ETH, AVAX, and other market/trade episodes are historical evidence only. They retain observation time, provider, setup geometry, result, and lesson, and can never be presented as current market state without fresh data.
64. CFT names, contract mappings, execution inboxes, external endpoints, credential workflows, and real-order/export instructions are imported only into a restricted deprecated/prohibited audit archive, never active Main memory or executable configuration.
65. Previous grade names, risk percentages, leverage limits, and loss rules enter as `CANDIDATE` methodology until the new shared Challenge rubric/profile explicitly approves or supersedes them.
66. Import idempotency is guaranteed by a deterministic source/content digest. Rerunning the importer cannot duplicate events, thoughts, memories, trades, or decisions.
67. Import verification compares manifests, source counts, hashes, classification totals, rejected records, and projection high-water marks, then proves that active Main memory contains no prohibited execution behavior.
68. Gustavo can import only explicit information available in the task transcript/export and local files; inaccessible hidden platform memory or private chain-of-thought is neither claimed nor fabricated.
69. Every native Gustavo chat is captured automatically as durable conversation events. External ChatGPT, Claude, or other chat history is ingested only through an export or connector explicitly authorized by its owner.
70. Cross-chat memory uses typed layers: working, episodic, semantic, procedural, relational, goal/Challenge, and meta-memory about confidence, source, freshness, and conflicts.
71. Each memory belongs to one or more explicit scopes: `PRIVATE_ACCOUNT`, `NODE_BRANCH`, `MAIN_SHARED`, `CHALLENGE_SHARED`, `PUBLIC`, or `AUDIT_ONLY`. Authorization filtering occurs before retrieval, graph expansion, ranking, or caching.
72. The Main Brain can recall all `MAIN_SHARED`, `CHALLENGE_SHARED`, `PUBLIC`, and authorized proposal memory across every chat. Raw private Node conversations do not become globally retrievable merely because they are stored.
73. Conversation consolidation runs asynchronously after turns and idle periods to segment episodes, extract entities/facts/procedures/goals, detect contradictions, update source-linked summaries, and precompute likely recall paths without replacing original messages.
74. Recall searches recent context, exact entities, time ranges, lexical matches, vector similarity, knowledge-graph neighbors, procedures, open goals, and current Main/Challenge state in parallel, then fuses and reranks bounded results.
75. Every generated answer records a `RecallTrace` containing the memory IDs and source-event references that influenced it, enabling “why do you remember that?”, correction, forgetting, and audit.
76. A chat can be archived without erasing its authorized memories; deletion/forgetting propagates through memories, graph edges, embeddings, summaries, caches, and future retrieval according to the approved retention policy.
77. Incremental import cursors and deterministic content identities prevent duplicate memories when external chat exports are updated and re-imported.
78. Cross-chat recall stays within the existing warm p95 latency budget at the verified scale fixture; cache misses use bounded indexed/graph queries and never scan every conversation.
79. Conflicting memories remain source-linked and temporally versioned. Gustavo prefers current approved state while making older views inspectable rather than silently blending contradictions.
80. Gustavo describes this as brain-like memory behavior but never claims sentience, consciousness, perfect recall, or access to chats that were not stored or authorized.
81. The MVP is invitation-only. One-time operator-issued invitation tokens are stored only as hashes, expire, are single-use, and create exactly one account, one entitlement, one stable Node Brain, and one continuous conversation in one transaction.
82. The launch market scope is an operator-managed allowlist of US-listed stocks and ETFs. Public output never labels a feed real-time without explicit redistribution rights; delayed observations carry their delay/freshness label and timestamp through every decision and display.
83. The initial Challenge uses static balance-relative limits: target equity is 110% of stage starting balance, the overall floor is 94%, and the daily-loss threshold is 4% of stage starting balance measured from the UTC day-start equity. Aggregate portfolio risk includes realized UTC-day losses, open losses, and remaining stop risk and cannot exceed 3% of stage starting balance.
84. A position cannot begin with more than 1% of stage starting balance at its structural stop, gross simulated notional cannot exceed current equity, and no more than three paper positions or one paper position per symbol may be open or pending.
85. A trading day counts only when a newly opened paper position had at least 0.25% of stage starting balance in initial stop risk. Passing still requires target equity and three distinct qualifying UTC trading days.
86. The initial stock/ETF simulation charges $0.005 per share with a $1 minimum per order, applies 5 basis points of adverse slippage per fill, uses an observed bid/ask spread when licensed quote data provides one or otherwise applies a 10-basis-point synthetic round-trip spread, charges 5% annualized short borrow by UTC day, and permits no leveraged gross exposure.
87. The model layer is provider-neutral and requires separately configured Main, Node, and blind-evaluator model identities. Tests use a deterministic fake provider; production records provider, model, prompt, policy, token use, latency, and cost for every generation.
88. A working local MVP is accepted first when the completed backend supports authenticated streaming, the public shell, private chat/memory/Challenge views, one-command local startup, static safety checks, and a browser smoke path from invitation through public redaction.
89. Encrypted backup/restore hardening, million-event performance verification, automated scheduled broadcasts, hardened public exposure, and complete recovery/scale proof are improvement milestones after the working MVP and remain required before public production launch.
90. MVP verification and improvement verification are reported as separate gates so the usable product is not blocked by later operational hardening.

## History

- 2026-08-12 prompt-update: Re-sequenced delivery into a working local MVP first, followed by backup, scale, scheduling, and full-system hardening as improvements. Approval reset to `needs re-approval`.

- 2026-08-08 prompt-update: Replaced the CFT-specific local paper-trade lab story with public stock-price commentary at the user’s request. Approval reset to `needs re-approval`.
- 2026-08-08 prompt-update: Added sponsored public seats, stable Brain identities, Core Brain transmissions, recorded debates, winner selection, and a protected streaming feed. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Renamed the product from TapeThoughts to Tape and reopened the seat ownership/donation model because the prior sponsored-only interpretation was an assistant assumption. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Replaced sponsorship, donation, and allocation alternatives with the user-approved direction of one account, one stable Brain, and one continuous private chat. Approval remains `needs re-approval` pending confirmation of the complete revised design.
- 2026-08-09 prompt-update: Added complete per-Brain history, local-first deployment, a scale-out path, and encrypted cloud backup with restore verification. Approval reset to `needs re-approval` for the expanded architecture.
- 2026-08-09 prompt-update: Renamed the product from Tape to Gustavo and recorded `gustavo.lol` as the canonical domain, currently owned through Squarespace. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Added layered, source-linked, low-latency memory modeled on the documented behavior patterns of leading chat products, without claiming access to their proprietary internals. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Added the Core Brain's simulated $2,500-to-$1,000,000 doubling challenge with immutable paper-trade accounting and deterministic stage progression. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Confirmed one shared Core Challenge Portfolio and added a committed Core baseline that Account Brain ideas must outperform before influencing it. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Established one authoritative Main Brain, user-facing Node Brains, Main-authored scheduled broadcasts, and a three-mode Node feedback router. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Made PostgreSQL authoritative for all observable thought artifacts and specified versioned, scoped, fully rebuildable caches. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Added a classified, idempotent bootstrap import of the current trading conversation and repository knowledge into Main Brain memory. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Expanded memory into continuous, permission-scoped, associative recall across every native or explicitly imported chat. Approval remains `needs re-approval`.
- 2026-08-09 prompt-update: Finalized the user-approved MVP defaults for invitation access, US stock/ETF scope, the Challenge rulebook and cost model, the 100-point winner rubric, and provider-neutral Brain runtime. Approval confirmed by the user.
