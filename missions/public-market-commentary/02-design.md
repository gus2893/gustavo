# Gustavo Design

**Approval status:** approved

## R — Requirements

- Public-facing product name: **Gustavo**.
- Canonical production origin: **https://gustavo.lol**.
- Domain registrar and current DNS control point: **Squarespace**. Domain credentials are never stored in or requested by the application.
- Working tagline: **The market thinks out loud.**
- Product scope: a public market-intelligence show where each account holder converses with one stable Brain through one continuous private chat and watches ideas enter a recorded Brain-to-Brain selection process.
- Canonical terminology is **Main Brain** for the single shared authority and **Node Brain** for each user's conversational branch. Earlier “Core Brain” and “Account Brain” references map to Main Brain and Node Brain respectively.
- Content is educational market commentary, not individualized financial advice.
- One account is one seat. Each account is associated with one account holder, one stable Brain identity, one continuous private chat, an entitlement window, and an immutable interaction timeline.
- The MVP is invitation-only with operator-issued, expiring, single-use invitations. Billing, self-service subscriptions, and payment-provider integration are deferred.
- An account cannot create multiple Brain chats, select a different Brain, or switch Brain identity in MVP.
- Every Node Brain transmits structured idea briefs to the Main Brain. The Main Brain and Node Brain hold bounded, persisted reviews and record winner decisions.
- Gustavo retains the complete source interaction history for every account and Brain relationship. Derived summaries, embeddings, and indexes never replace source events.
- The initial deployment runs on the operator’s computer and remains functional without a hosted application runtime or hosted database.
- Encrypted cloud backup and verified restore remain required before public production launch, but they follow the first working local MVP as an improvement milestone and are never part of the live request path.
- Delivery is staged: first ship a working local MVP from the completed backend, authenticated streaming, public/private UI, a one-command local runtime, static safety gates, and an MVP smoke path; then continue with backup hardening, scale/performance verification, automated broadcast scheduling, and full-system acceptance proof as improvements.
- The architecture must scale by adding stateless web/worker instances and database capacity, without changing the one-account/one-Brain/one-chat invariant.
- Gustavo must preserve all authorized source history while retrieving only the smallest relevant context needed for a response or Brain-to-Brain discussion.
- Memory lookup cannot require a model call or full transcript scan on the synchronous response path.
- Private account memory, transmitted council memory, operator audit data, and public memory are separate visibility scopes enforced before retrieval and ranking.
- The Main Brain maintains one internal simulated Challenge Portfolio. It begins at $2,500 and advances through doubled starting-balance stages until a capped final $1,000,000 stage.
- The initial Challenge profile uses a 10% profit objective, 4% daily-loss limit, 6% static overall-loss limit, 3% aggregate internal risk ceiling, 1% per-position stop-risk limit, UTC reset, three qualifying trading days, and no deadline.
- Every paper trade, cost, mark, rule evaluation, P&L change, and stage transition is stored as immutable, replayable challenge history.
- All Node Brains compete to improve one shared Challenge Portfolio. Their transmissions are proposals, never portfolio mutations.
- The Main Brain commits a baseline paper thesis or `NO PAPER TRADE` before contender evaluation; a Node Brain idea changes the decision only when it clears identical hard gates and a configured improvement margin.
- All canonical scheduled messages originate from the Main Brain. Node Brains deliver those broadcasts unchanged, conduct their own private user conversations, and may submit structured feedback proposals upstream.
- The Main Brain controls shared positions, scheduled content, accepted beliefs, council decisions, and the single Challenge. A Node Brain cannot change shared state by answering a user.
- Every Node response is routed as `MAIN_DEFAULT`, `NODE_EXPLORE`, or `PROPOSAL_UPSTREAM`, with the chosen mode, Main-state version, sources, and proposal outcome recorded.
- Every observable thought artifact is stored as durable, source-linked database data before it can influence Main state, a Node response, a broadcast, or the Challenge.
- Hidden model chain-of-thought is neither requested nor stored. Gustavo records concise decision rationales, evidence, counterevidence, uncertainty, scores, and outcomes sufficient for audit and memory.
- Caches accelerate authorized reads only; all cached state is versioned, scope-bound, disposable, and rebuildable from PostgreSQL.
- The Main Brain is bootstrapped from explicit trading knowledge available in this task and repository through a classified, provenance-preserving, idempotent import. Obsolete execution behavior never becomes active memory.
- Every native Gustavo conversation continuously feeds permission-scoped memory. External chat histories participate only after explicit export/connector authorization and idempotent ingestion.
- Cross-chat recall is associative and layered but never permissionless: scope filtering precedes lexical/vector search, graph traversal, ranking, context assembly, and caching.
- “Winner” means strongest reasoning under the approved 100-point rubric; it never means a guaranteed or recommended trade. Action requires at least 80/100, and a Node contender must also beat the committed Main baseline by at least 5 points.
- The public homepage shows an active feed using safe metadata and irreversible placeholder shapes. Protected response words are never shipped to an unauthorized browser.
- Authorized feed consumers receive only entitlement-specific event DTOs through a server-authorized BFF stream.
- No broker, exchange, prop-firm, CFT, external order, order-export, execution-program, or credential functionality.
- Internal paper orders, positions, stops, targets, simulated sizing, and challenge-risk calculations are allowed only inside the prominently labeled shared Challenge Portfolio.
- No “buy now,” “sell now,” copy-trade, or real-account execution language. Challenge actions use “paper long,” “paper short,” or “no simulated position” terminology.
- Data freshness must be visible. Delayed data is labeled delayed.
- The MVP market universe is an operator-managed allowlist of US-listed stocks and ETFs backed by a server-only licensed market-data adapter. Redistribution status, observation time, session state, and delay/freshness metadata are first-class data.
- Completed price bars provide evidence; active unfinished bars are explicitly provisional.
- Commentary records uncertainty, competing interpretations, and what would change the view.

## E — Evidence model

Each commentary entry may use:

1. current observed price and timestamp;
2. higher-timeframe trend context;
3. confirmed support/resistance derived from completed bars;
4. recent completed-candle behavior;
5. active-candle behavior labeled unfinished; and
6. an explicit confidence level and invalidation condition.

The public commentary product does not convert observations into real orders, real-account risk amounts, or broker symbols. A selected council idea may become a separately labeled internal paper intent after deterministic challenge-rule evaluation.

Each participant idea transmission additionally contains:

- source participant and seat identifiers;
- stable seat Brain identifier and prompt version;
- original conversation event references;
- ticker, observed price, timestamp, and freshness label;
- thesis stated as an observation;
- supporting evidence and counterevidence;
- what would falsify or weaken the idea; and
- an idempotency key preventing duplicate debate entries.

Winner scoring totals 100 points: evidence quality/freshness 25, structural clarity 20, cost-adjusted simulated geometry 20, falsifiability/invalidation 15, counterevidence/uncertainty 10, and portfolio independence/originality 10. Market outcome is recorded later as an observation but never retroactively rewrites the original decision.

## A — Architecture

The product uses a Next.js App Router frontend and Backend-for-Frontend layer with a local-first service topology:

```text
Public browser / Seat browser
          |
        HTTPS
          |
Next.js pages + authenticated Route Handlers (stateless BFF)
          |
server-only DAL + entitlement DTO projection
          |
durable job queue ---- orchestration worker ---- model/Brain runtime
          |
PostgreSQL append-only event store + encrypted message bodies
          |
scheduled encrypted cloud backup
```

The repository becomes public product knowledge plus an implementation plan:

- `README.md`: brand promise, audience, disclaimer, and navigation.
- `docs/EDITORIAL_MODEL.md`: how commentary is formed.
- `docs/VOICE_AND_STYLE.md`: public writing voice and prohibited claims.
- `docs/DATA_FRESHNESS.md`: source and timestamp labeling.
- `templates/stock-commentary.md`: reusable publication format.
- `state/latest-commentary.json`: replaceable example/current commentary state.
- `policy/editorial-policy.json`: machine-readable boundaries.
- `scripts/validate.ps1`: JSON, required-file, and forbidden-legacy-term checks.

Planned application modules after approval:

- `app/(marketing)/page.tsx` — public feed shell containing no protected text.
- `app/(account)/chat/page.tsx` — the authenticated account’s single Brain conversation.
- `app/api/public/feed/route.ts` — safe metadata and placeholder geometry only.
- `app/api/feed/stream/route.ts` — authenticated streaming endpoint with server-side entitlement checks.
- `app/api/account/*` — account entitlement and stable Brain-assignment endpoints.
- `app/api/conversations/*` — participant message mutation endpoints.
- `app/api/broadcasts/*` — Main Brain scheduled-response commitment, entitlement projection, and delivery endpoints.
- `app/api/proposals/*` — Node feedback-proposal submission, review, scoring, and outcome endpoints.
- `app/(challenge)/challenge/page.tsx` — shared Challenge progress, paper positions, ledger, and stage history.
- `app/api/challenge/*` — challenge profile, paper intent/order, position, mark, ledger, and stage-lifecycle endpoints.
- `lib/server/auth` — session and secure authorization.
- `lib/server/dal` — server-only data access and minimum DTO projection.
- `lib/server/orchestration` — Node Brain transmission, Main Brain review, scoring, and decision workflow.
- `lib/server/crypto` — envelope encryption and key-version handling for stored message bodies.
- `lib/server/events` — append-only event write/read model and idempotency.
- `lib/server/history` — paginated transcript reconstruction and derived-memory checkpoints.
- `lib/server/memory` — scoped fact/episode extraction, hybrid retrieval, ranking, provenance, and forgetting.
- `lib/server/handoffs` — incrementally refreshed Node-Brain-to-Main-Brain dossiers.
- `lib/server/main-brain` — canonical Main state, responses, broadcasts, baselines, and accepted changes.
- `lib/server/node-brains` — private conversation routing, Main-default projection, exploration, and proposal creation.
- `lib/server/thoughts` — structured observable rationale, evidence links, state transitions, and provenance.
- `lib/server/cache` — typed versioned keys, authorization scopes, invalidation, prewarming, and fallback behavior.
- `lib/server/import` — source manifests, parsing, classification, deduplication, provenance, review, and projection bootstrap.
- `lib/server/consolidation` — episode segmentation, fact/procedure/goal extraction, conflict detection, and memory graph updates.
- `lib/server/recall` — authorization-first multi-index search, graph expansion, fusion/reranking, context packs, and recall traces.
- `lib/server/challenge` — deterministic simulation accounting, risk rules, fills, marks, and stage progression.
- `worker/` — idempotent Brain generation, transmission, debate, and indexing jobs.
- `infra/compose.yaml` — local web, worker, PostgreSQL, and durable queue services.
- `infra/backup/` — database-consistent encrypted backup, integrity check, retention, and restore scripts.

The Next.js BFF is an API boundary, not the sole durable backend. Long-lived generation and debate jobs run in workers so request timeouts cannot truncate them. A durable queue carries idempotent jobs; a stream channel fans authorized event IDs to the BFF, which reloads and projects each event after authorization. Web and worker processes hold no authoritative conversation state in memory.

PostgreSQL is the local source of truth. Event rows use globally sortable IDs, account and conversation keys, causation/correlation IDs, visibility classes, integrity hashes, and encrypted body references. Reads are cursor-paginated and indexed by account plus event ID. If volume later requires it, event tables can be time- or account-hash-partitioned without changing event contracts.

The repository directory should be renamed from `paper-trade-lab-knowledge` to `gustavo` after approval.

## H — Main Brain and Node Brain hierarchy

### One shared authority

Gustavo has exactly one Main Brain. It owns the canonical market view, scheduled-response stream, shared council memory, accepted proposal state, and single simulated Challenge Portfolio. Main state is versioned and append-only: a new accepted view supersedes an older view without deleting it.

Each `UserAccount` has exactly one stable Node Brain and one continuous private conversation. A Node Brain is a branch of the Main Brain: it inherits the current Main state and policies, adds the user's authorized conversation context, and has no independent authority over broadcasts or the Challenge.

### Main-authored scheduled messages

1. A scheduler opens a broadcast cycle and freezes the relevant Main-state version.
2. The Main Brain creates one canonical semantic message body with sources, timestamp, freshness labels, and visibility classification.
3. Policy/privacy validation commits `main.broadcast.committed` before delivery begins.
4. The delivery service projects the same authorized body to each entitled account and records per-account delivery state.
5. A Node Brain may provide a separate clearly labeled conversational follow-up only after delivery; it cannot edit the committed broadcast or claim authorship.

Personalized transport metadata such as recipient name, locale, accessibility formatting, or delivery time may be applied outside the canonical body. Semantic personalization by a Node Brain is not part of the MVP scheduled-message path.

### Interactive Node routing

Every user turn is durably appended, then routed through exactly one mode:

- `MAIN_DEFAULT`: answer from the current Main response/state when the user's request is covered and no material contradiction exists.
- `NODE_EXPLORE`: privately acknowledge, question, clarify, or test feedback. The Node must distinguish exploration from the Main Brain's accepted position.
- `PROPOSAL_UPSTREAM`: create a structured proposal when feedback contains material new evidence, a factual correction, a more falsifiable interpretation, a better cost-adjusted simulated idea, or another rubric-relevant improvement.

The router uses a versioned policy and records its classification, confidence, Main-state version, and sources. Low-confidence routing defaults to `NODE_EXPLORE`; it never silently updates Main state.

### Upstream proposal contract

A proposal contains the Node ID, pseudonymous account reference, source-event references, proposed change, supporting evidence, counterevidence, uncertainty, affected Main-state IDs, privacy scope, and idempotency key. Raw private chat text is excluded unless the user has explicitly authorized that disclosure scope.

The Main Brain may reject, request clarification, queue for the next decision window, or accept a proposal after the same baseline/evaluator process used by Challenge contenders. Acceptance appends a new Main-state version and records why the proposal was better. Rejection leaves Main state unchanged but remains visible to the originating user through the Node.

Agreement is not a routing criterion. A Node may be empathetic and collaborative, but popularity, repetition, user confidence, account spending, or pressure never makes an idea better.

## P — Main Brain's shared simulated challenge

### Domain boundary

`UserAccount` means a person's login, entitlement, Node Brain identity, and private chat. `ChallengePortfolio` means the Main Brain's isolated simulated financial ledger. They never share an identifier or balance.

The MVP has exactly one active shared Challenge Portfolio. Node Brains contribute structured ideas to that shared goal; individual Node Brains never receive separate balances and cannot mutate the portfolio. The Main Brain remains the default decision-maker unless a contender demonstrably outperforms its committed baseline.

### Main baseline and contender arbitration

Each scheduled or event-triggered decision window has these immutable phases:

1. **Snapshot:** freeze the market-data IDs, timestamps, cost model, open portfolio state, stage profile, and eligible instrument universe used for comparison.
2. **Main commitment:** the Main Brain independently writes a complete baseline thesis or `NO PAPER TRADE`. The commitment is hashed and closed before contender evaluation.
3. **Contender intake:** Node Brain transmissions are normalized to the same schema. Missing evidence, stale data, incomplete geometry, duplicates, and authorization failures are rejected before scoring.
4. **Bounded review:** the Main Brain may ask source-linked clarification questions, but post-commitment answers cannot rewrite the original Main baseline.
5. **Blind evaluator pass:** contenders are pseudonymized and scored beside the Main baseline using the same rubric and frozen snapshot. The evaluator prompt/model/version and every component score are recorded.
6. **Selection:** a contender replaces or modifies the Main decision only if it passes every hard gate and exceeds the Main baseline by the configured improvement margin. Ties, sub-margin improvements, or failed gates preserve the Main decision.
7. **Challenge gate:** the selected idea becomes only a proposed paper intent; deterministic risk/accounting code may still reject it.

The initial improvement margin is 5 points on the approved 100-point rubric. The component weights are evidence quality/freshness 25, structural clarity 20, cost-adjusted paper geometry 20, falsifiability/invalidation 15, counterevidence/uncertainty 10, and portfolio independence/originality 10. It does not score popularity, account spending, confidence language, or guaranteed profit. An actionable paper thesis must score at least 80/100 after passing every freshness, session, geometry, duplication, and authorization hard gate.

If the Main baseline is `NO PAPER TRADE`, a contender must clear both the improvement margin and an absolute action-quality threshold. If the Main baseline itself fails an action hard gate, it also produces no paper order.

### Doubling progression

The progression starts at $2,500. Each passed stage creates the next stage with double the prior starting balance until the cap of $1,000,000:

`$2,500 -> $5,000 -> $10,000 -> $20,000 -> $40,000 -> $80,000 -> $160,000 -> $320,000 -> $640,000 -> $1,000,000`

The last transition is capped at $1,000,000 rather than doubling $640,000 to $1,280,000. Every stage is a separate immutable ledger aggregate linked to its predecessor. Balance and trades never carry into the next stage unless a future rule explicitly introduces carryover; the default is a fresh stage at its configured starting balance.

### Versioned challenge profile

Each stage profile contains:

- base currency, starting balance, profit objective, and derived target equity;
- overall drawdown type/value and optional trailing behavior;
- daily-loss type/value, reset timezone, and reset boundary;
- minimum trading days, optional deadline, and enabled market categories;
- simulated leverage/notional caps and per-position/portfolio risk limits;
- spread, commission, slippage, financing, and price-mark assumptions;
- active, paused, passed, failed, or archived lifecycle state; and
- effective time, version, creator, and reason for every rule change.

No prop provider's rules are inferred. Profit objectives and loss rules are explicit configuration. Rule changes create a new version and never rewrite historical evaluations.

The approved initial profile is deterministic:

- target equity is `startingBalance * 1.10`;
- the static overall floor is `startingBalance * 0.94`;
- the daily-loss allowance is `startingBalance * 0.04`, measured as the fall from the first valid equity snapshot at `00:00 UTC` to current equity during that UTC day;
- aggregate internal risk is realized losses in the current UTC day plus current open losses plus remaining loss-to-stop for all pending/open positions, capped at `startingBalance * 0.03`;
- initial stop risk per position is capped at `startingBalance * 0.01`;
- gross paper notional is capped at current equity, with at most three pending/open positions and at most one per symbol;
- a qualifying trading day requires a newly opened paper position whose initial stop risk was at least `startingBalance * 0.0025`;
- a stage passes only after reaching target equity on at least the third distinct qualifying UTC trading day, and has no deadline; and
- stage failure is permanent when either the daily or overall loss boundary is reached or crossed.

The approved initial US-stock/ETF cost model charges `$0.005 * shares` with a `$1.00` minimum for each simulated order, applies 5 basis points of adverse slippage to every fill, uses the licensed observed bid/ask when present or a 10-basis-point synthetic round-trip spread otherwise, and accrues 5% annualized short-borrow cost at each UTC day boundary. Long exposure is cash-equivalent and total gross notional cannot exceed current equity.

### Immutable ledger and derived state

Canonical challenge events include:

- `challenge.created`, `challenge.profile.versioned`, `challenge.started`, `challenge.paused`, `challenge.passed`, `challenge.failed`, and `challenge.archived`;
- `stage.created`, `stage.started`, `stage.passed`, `stage.failed`, and `stage.advanced`;
- `paper.intent.proposed`, `paper.intent.rejected`, `paper.order.created`, `paper.order.cancelled`, `paper.fill.created`, and `paper.position.closed`;
- `decision.window.opened`, `main.baseline.committed`, `contender.submitted`, `contender.rejected`, `review.turn.created`, `evaluation.scored`, and `decision.selected`;
- `price.mark.recorded`, `fee.recorded`, `financing.recorded`, `pnl.realized`, `pnl.unrealized.marked`, and `rule.evaluated`; and
- `daily.snapshot.created` and `challenge.progress.updated` as rebuildable projections.

Balance, equity, exposure, realized/unrealized P&L, peak equity, drawdown, risk-day state, stopped attempts, and objective progress are calculated from ledger events. Cached snapshots include a ledger high-water mark and are never authoritative.

### Paper-decision path

1. Open a decision window, freeze its evidence/portfolio snapshot, and commit the Main baseline.
2. Accept Node Brain transmissions, run schema/hard-gate validation, and conduct bounded source-linked review.
3. Blind-score eligible contenders and the Main baseline; select a contender only when it clears the configured improvement margin.
4. Require the selected paper intent to contain a deterministic instrument identity, direction, entry rule, structural invalidation/stop, target or exit rule, expiry, and desired simulated risk.
5. Load a consistent ledger snapshot and current stage profile, reject stale data or incomplete geometry, then calculate size, worst-case loss, exposure, correlation, and every enabled challenge constraint.
6. In one database transaction, append the selection provenance, rule evaluation, idempotency key, and paper order or rejection.
7. Apply timestamped public-provider prices plus configured spread, slippage, fees, and financing in a simulation worker to generate paper fills and marks.
8. Run pass/fail checks after every ledger-changing event and at every configured daily boundary.
9. Passing the current stage creates the next doubled stage automatically until $1,000,000. Passing the $1,000,000 stage completes the progression and blocks new paper orders pending an explicit new objective.

The model proposes and explains. Deterministic code owns arithmetic, rule enforcement, order state, fills, P&L, stage advancement, and duplicate prevention.

### Visibility and labeling

- Challenge details are operator-visible by default. Public scorecards require an explicit publication decision and receive read-only projections, not private chats.
- Every challenge surface states **SIMULATION ONLY — NOT A REAL TRADE**.
- Paper positions cannot be exported into an execution inbox or converted into broker-native payloads.
- Every paper position and result includes price source, observation time, freshness status, and simulated cost assumptions.

## S — Safety and public claims

- No promise of accuracy, profitability, or future performance.
- No personalized suitability judgments.
- No representation that commentary is real-time unless the source is verified real-time.
- No use of an exact price without an observation timestamp.
- No real order routing, broker payloads, passive execution-ticket exports, or account credentials. Internal paper-ledger events are permitted only inside the shared Challenge.
- Public examples use stocks, not crypto, until the product scope is explicitly expanded.

## C — Content protection and streaming

### Public homepage

- Initial HTML contains only public branding, aggregate counts, Brain display names approved for public use, event timestamps, topic labels, and server-generated placeholder geometry.
- CSS blur is visual decoration only. It never receives the original protected words.
- Public endpoints return irreversible previews, not encrypted blobs that a public client can decrypt.
- Responses use `Cache-Control: public` only for deliberately public metadata. Protected endpoints use `Cache-Control: private, no-store`.

### Authorized feed

- Route Handlers are treated as public endpoints and perform secure database-backed authorization on every request and stream connection.
- The server-only DAL returns role-specific DTOs: public, account holder, moderator, and operator.
- Account holders can view their own single conversation, transmissions derived from it, entitled debate events, and final decision records.
- An account holder never receives another account’s private chat content.
- Moderator/operator access is audited and purpose-limited.
- The preferred MVP transport is Server-Sent Events over HTTPS for one-way response streaming. If the deployment cannot sustain long-lived handlers, use a managed stream service while keeping authorization and DTO projection in the BFF.

### Encryption and limits

- TLS protects data in transit.
- Message bodies are envelope-encrypted at rest with per-conversation data keys and a managed root key. Metadata is minimized.
- Decryption occurs only in the server-only DAL after authorization.
- Optional application-layer ciphertext can reduce accidental intermediary logging, but it cannot prevent an authorized browser from copying text once displayed. The threat model must not promise otherwise.
- Secrets never use `NEXT_PUBLIC_` variables, never enter Client Components, and are accessed only through server-only modules.

## I — Interaction and event model

Canonical append-only event types:

- `account.created`
- `account.entitlement.activated`
- `brain.assigned`
- `conversation.started`
- `participant.message.created`
- `brain.response.delta`
- `brain.response.completed`
- `node.reply.routed`
- `main.broadcast.committed`
- `main.broadcast.delivered`
- `feedback.proposal.created`
- `feedback.proposal.clarification_requested`
- `feedback.proposal.accepted`
- `feedback.proposal.rejected`
- `main.state.versioned`
- `thought.recorded`
- `thought.corrected`
- `thought.superseded`
- `projection.checkpointed`
- `cache.version.advanced`
- `import.manifest.created`
- `knowledge.item.imported`
- `knowledge.item.classified`
- `knowledge.item.promoted`
- `knowledge.item.deactivated`
- `import.verified`
- `chat.source.connected`
- `chat.source.cursor_advanced`
- `conversation.imported`
- `memory.consolidation.completed`
- `memory.edge.versioned`
- `memory.conflict.detected`
- `memory.recall.traced`
- `idea.transmission.created`
- `debate.turn.created`
- `idea.score.recorded`
- `winner.selected`
- `commentary.published`
- `access.revoked`

Every event has a globally unique ID, aggregate ID, actor type/ID, timestamp, prompt/model version when applicable, causation ID, correlation ID, visibility class, and integrity hash. Corrections append a new event; they never rewrite history.

The source history retains:

- every account-holder message and completed Node Brain response;
- message streaming completion/abort metadata without requiring every transient token delta to be permanent source data;
- every prompt, model, Brain, and policy version needed to explain a response;
- Main broadcasts, Node routing decisions, structured proposals/transmissions, Main-Node review turns, scores, winner decisions, publication events, and corrections;
- tool/data-source references and price-observation timestamps used by a Brain; and
- access, export, deletion, backup, and restore audit events that do not expose protected message bodies.

Summaries, embeddings, topic labels, search indexes, and context-window checkpoints are versioned projections. They can be deleted and rebuilt from source history. Context assembly retrieves the most relevant prior events plus recent conversation, but the UI always permits paginated access to the complete authorized transcript.

## M — Layered memory and fast recall

Gustavo reproduces the observable memory pattern of leading chat products, not their undisclosed internal implementations. Durable chat state, selectively maintained memories, relevant-history retrieval, RAG, and cached prompt/context are treated as separate concerns.

### Memory layers

1. **Source history:** immutable messages, responses, transmissions, debates, decisions, corrections, and provenance. This is the only authoritative record.
2. **Working context:** a bounded window of recent conversation events plus the current request and active job state.
3. **Durable semantic facts:** compact typed memories such as preferences, stable identity details, commitments, decisions, hypotheses, constraints, and unresolved questions.
4. **Episodic summaries:** source-linked summaries of coherent conversation spans, topics, or council sessions.
5. **Retrieval indexes:** PostgreSQL full-text indexes and vector embeddings used together for hybrid lexical/semantic recall.
6. **Brain state:** a small versioned dossier describing the Brain’s active relationship, current projects, important decisions, and unresolved threads.
7. **Handoff packets:** precomputed, visibility-filtered dossiers that let a Node Brain transmit current ideas and relevant history to the Main Brain without sharing its raw private transcript.

### Memory records

Every derived memory stores:

- account, Brain, conversation, and visibility-scope identifiers;
- typed content and normalized keywords/entities;
- source event IDs and exact source time range;
- confidence, importance, freshness, and retrieval-use counters;
- extraction prompt/model/version and embedding version;
- `valid_from`, optional `valid_to`, and a `supersedes` relationship;
- contradiction and user-correction state; and
- cryptographic body/key references for protected content.

Memories are updated by appending a new version. Conflicting memories coexist with explicit status until a deterministic rule or authorized correction supersedes one; silent destructive merging is prohibited.

### Write path

1. The request transaction appends the source event and transactional-outbox job, then acknowledges the message.
2. Background workers classify the event, extract candidate facts/episodes, embed source-linked chunks, detect contradictions, and update projections.
3. A deterministic merge stage deduplicates exact/near-exact memories and appends supersession links.
4. Brain state and affected handoff packets refresh incrementally.
5. Cache keys include the relevant memory-version high-water mark, so stale packets invalidate without scanning history.

Extraction and indexing failures never lose the source message. Jobs retry idempotently and projections can be rebuilt from event zero.

### Read path

1. Authorize the actor and resolve permitted visibility scopes before search.
2. Load the small pinned Brain-state dossier and recent-turn window.
3. Run full-text and vector searches in parallel, restricted by account/Brain/scope and filtered by validity.
4. Fuse rankings, boost unresolved/current items, down-rank stale or superseded facts, deduplicate, and cap excerpts.
5. Assemble a token-budgeted context pack containing claims plus source event references.
6. Record which memories influenced the response so the user can inspect or correct them.

No query performs an unbounded transcript scan. Full history uses stable cursor pagination. Model prompts receive a bounded context pack, never every stored message.

### Brain-to-Brain fast path

- Each Node Brain maintains one compact handoff packet per active idea/topic and one overall relationship dossier.
- The Main Brain reads transmitted packets and council-visible memory only; it does not search raw account-private chats.
- Packets include current thesis, evidence, counterevidence, unresolved questions, recent changes, source references, and memory-version IDs.
- Packet refresh is asynchronous and incremental. A synchronous debate request may apply only the small delta since the packet’s high-water mark.
- Frequently used, authorization-safe packets are cached locally with versioned keys; PostgreSQL remains authoritative.

### Local technology choice and scale boundary

- PostgreSQL stores events, memory records, full-text search, outbox jobs, and vector embeddings for the local MVP.
- A PostgreSQL vector extension is preferred initially so backup, restore, authorization filtering, and transactional consistency remain in one system.
- The durable queue handles extraction and packet refresh; a short-lived cache accelerates hot dossiers but contains no sole copy of memory.
- Memory tables are partition-ready by account hash and/or time. Embedding and retrieval services can move behind an internal interface later without changing memory IDs or provenance contracts.

### Performance budgets

- Source-event commit is independent of extraction/indexing latency.
- Under normal load, new memory projections should become searchable within five seconds.
- On a documented reference local machine with at least one million source events, warm scoped hybrid retrieval must meet p95 ≤ 250 ms.
- A current cached Brain handoff packet must load at p95 ≤ 100 ms.
- Cold retrieval, rebuild throughput, queue lag, cache hit rate, and memory freshness are measured and exposed to the operator.

## G — Continuous cross-chat memory graph

### Capture boundaries

Native Gustavo conversations are stored turn by turn through the normal transactional event path. External conversations are never assumed accessible: ChatGPT, Claude, or another product requires an owner-authorized export or connector that produces a manifest, stable source IDs, timestamps, participants, conversation boundaries, and content digests.

Each chat source maintains an incremental cursor. Updated exports append new or corrected source versions; deterministic content identities prevent duplicates. Failed parsing quarantines the item for review rather than inventing missing context.

### Functional memory systems

- **Working memory:** current request, recent authorized turns, active Main state, active Node route, and current Challenge snapshot.
- **Episodic memory:** source-linked conversation segments, market-analysis sessions, proposal reviews, scheduled cycles, and paper-trade episodes.
- **Semantic memory:** stable facts, definitions, entities, relationships, approved methods, and current beliefs.
- **Procedural memory:** versioned workflows and rules such as market analysis, evaluation, challenge gating, broadcasting, and privacy handling.
- **Relational memory:** authorized knowledge about accounts, Nodes, the Main Brain, topics, instruments, sources, and how they relate.
- **Goal memory:** open questions, commitments, tasks, Main objectives, proposal states, and the $2,500-to-$1,000,000 Challenge progression.
- **Meta-memory:** confidence, importance, freshness, provenance, validity, contradiction, lifecycle class, retrieval use, and supersession.

These are typed projections over source events, not separate truths. Every memory node points back to one or more source records.

### Memory scopes

- `PRIVATE_ACCOUNT`: raw user/Node conversation and private memories visible only to the entitled account and authorized operational roles.
- `NODE_BRANCH`: Node-specific state and derived context used by that Node's conversation.
- `MAIN_SHARED`: accepted Main positions, broadcasts, approved methodology, and accepted Node proposals.
- `CHALLENGE_SHARED`: challenge objectives, baselines, contenders, decisions, paper trades, results, and lessons.
- `PUBLIC`: deliberately published content and safe metadata.
- `AUDIT_ONLY`: encrypted imports, deprecated/prohibited material, security events, and restricted provenance.

Scope is attached at write time and can only broaden through an explicit authorized event. Retrieval enforces scope in database predicates before semantic search or graph expansion. A high vector-similarity score never bypasses authorization.

### Consolidation loop

1. **Per turn:** append source events immediately; enqueue entity, topic, fact, question, goal, and procedure candidates.
2. **At idle/episode boundary:** segment coherent episodes, write source-linked summaries, resolve aliases, and update conversation/Node dossiers.
3. **After accepted Main or Challenge changes:** refresh canonical semantic/procedural/goal memory and supersession links.
4. **Periodic reconciliation:** detect duplicates, temporal conflicts, stale facts, unresolved questions, orphaned edges, and memories whose source was forgotten or deactivated.
5. **Prewarm:** update hot entity neighborhoods, Main/Node capsules, active-goal packs, and likely scheduled-cycle retrievals.

Consolidation is idempotent, incremental, and asynchronous. It never blocks source-event durability and never deletes the original chat.

### Memory graph

Memory nodes represent people/accounts, Nodes, the Main Brain, instruments, market zones, methods, hypotheses, evidence, decisions, goals, challenges, trades, episodes, and source documents. Typed temporal edges include `MENTIONS`, `SUPPORTS`, `CONTRADICTS`, `SUPERSEDES`, `DERIVED_FROM`, `PROPOSED_BY`, `ACCEPTED_INTO`, `AFFECTED`, `RESULTED_IN`, `SIMILAR_TO`, and `PART_OF`.

The local MVP stores graph nodes/edges in PostgreSQL adjacency tables with indexes by scope, node type, entity ID, and time. A dedicated graph service is deferred until profiling proves PostgreSQL traversal insufficient.

### Recall planner

1. Authorize the caller and determine allowed memory scopes.
2. Parse the request into intent, exact entities, topic, time window, desired memory types, and current Main/Node/Challenge versions.
3. In parallel, retrieve recent turns, pinned working/goal state, exact entity/time matches, full-text matches, vector candidates, graph neighbors, and relevant procedures/episodes.
4. Fuse results with reciprocal-rank or equivalent deterministic ranking, then rerank by scope, relevance, recency, importance, confidence, freshness, contradiction state, and diversity.
5. Deduplicate source-equivalent results and construct a bounded context pack with explicit memory/source IDs.
6. Store a `RecallTrace` containing query plan, candidates, selected memories, exclusions, latency, cache use, and the resulting response ID.

Current accepted Main state and current Challenge facts are pinned ahead of similarity results. Superseded or historical memories can explain prior decisions but cannot override current approved state.

### Fast recall

- Cache current Main/Node/Challenge capsules, hot entity adjacency lists, active goals, recent episodes, and safe retrieval results with source-version keys.
- Use PostgreSQL full-text, vector, entity, temporal, graph-adjacency, and scope indexes; never run an unbounded all-chat scan.
- Limit graph depth and candidate counts before reranking. Deep historical research becomes a background job with progress events rather than blocking an interactive reply.
- Maintain incremental projection checkpoints and source high-water marks so consolidation and prewarming touch only changed chats.
- Measure recall quality as well as latency through known-answer, conflict, temporal, permission, provenance, and stale-memory evaluation sets.

### User controls and truthfulness

Users can inspect memories and their sources, correct or supersede them, request forgetting, export authorized data, and see whether a response used Main, Node, Challenge, historical, or imported memory. Gustavo says it does not know when no authorized source supports recall.

“Brain-like” describes persistent associative memory behavior. It is not a claim of biological equivalence, sentience, perfect recollection, or autonomous access to unstored chats.

## T — Thought ledger and cache architecture

### What Gustavo records as a thought

Gustavo records observable, product-relevant thought artifacts—not private hidden chain-of-thought. A `ThoughtRecord` is a concise, auditable unit with one of these types:

- `MAIN_POSITION`, `MAIN_BROADCAST`, `NODE_REPLY_SUMMARY`, or `NODE_PROPOSAL`;
- `HYPOTHESIS`, `EVIDENCE`, `COUNTEREVIDENCE`, `UNCERTAINTY`, or `OPEN_QUESTION`;
- `EVALUATION`, `DECISION`, `REJECTION_REASON`, `CORRECTION`, or `LESSON`; and
- `PAPER_INTENT_RATIONALE`, `RISK_GATE_RESULT`, `STAGE_REVIEW`, or `OUTCOME_REVIEW`.

Each record stores actor/Brain ID, account/conversation when applicable, visibility scope, concise rationale, structured claims, source-event and market-data references, evidence/counterevidence, uncertainty, state version, prompt/model/policy versions, creation time, validity interval, and supersession links.

The system never asks a model to reveal hidden internal reasoning. When an auditable explanation is required, it requests a concise decision rationale grounded in cited inputs and stores that explicit artifact.

### Authoritative database model

PostgreSQL is the only authoritative store. The planned logical tables are:

- `events` and `encrypted_event_bodies` for immutable source activity;
- `chat_sources`, `source_cursors`, `conversations`, and `messages` for native and imported chat boundaries;
- `thought_records` and `thought_sources` for structured observable rationales and provenance;
- `main_state_versions` and `node_state_versions` for accepted/shared and branch-specific state;
- `memory_facts`, `memory_episodes`, `memory_embeddings`, and `memory_supersessions` for derived recall;
- `memory_nodes`, `memory_edges`, `entities`, `entity_aliases`, `goals`, `procedures`, `consolidation_runs`, and `recall_traces` for associative cross-chat memory;
- `broadcasts`, `deliveries`, `feedback_proposals`, `evaluations`, and `decisions` for Main/Node coordination;
- Challenge profile, stage, order, fill, position, mark, ledger, rule-evaluation, and snapshot tables;
- `projection_checkpoints`, `transactional_outbox`, `cache_versions`, and `audit_events` for processing correctness.

One database transaction appends the source event, required `ThoughtRecord`, state-version reference, and outbox work. An API never reports success before this durable commit. Workers may fail or caches may disappear without losing the underlying thought.

### Cache hierarchy

1. **Durable PostgreSQL projections:** rebuildable read tables for current Main state, Node dossiers, broadcast delivery, Challenge progress, and memory indexes.
2. **Distributed Valkey cache:** short-lived hot Main state, committed broadcasts, scoped Node dossiers, handoff packets, retrieval results, session/rate-limit data, and public feed projections.
3. **Per-process bounded LRU:** very short-lived immutable configuration, policy versions, public metadata, and already-authorized context packs.

No cache contains the sole copy of information. Raw private transcripts are not placed in shared cache. If a protected context pack must be cached, the application encrypts it, binds it to account/scope/policy versions, uses a short TTL, and prevents cross-account reuse.

### Keys, invalidation, and consistency

- Typed cache keys use `namespace`, visibility scope, entity ID, source high-water mark, state version, policy version, and schema version.
- The transactional outbox publishes invalidation/prewarm jobs only after the database commit succeeds.
- Versioned immutable keys make late invalidations harmless; a small pointer key identifies the current version.
- Cache-aside reads authorize first, fetch the current version, and fall back to bounded indexed database queries.
- Single-flight locks and jittered TTLs prevent cache stampedes. Negative results use short TTLs.
- Public metadata may use bounded stale-while-revalidate with a visible timestamp. Private dialogue, proposal acceptance, Challenge risk, order state, and accounting never make decisions from stale cache alone.
- Challenge mutations use a consistent database transaction and ledger high-water mark even when a cached dashboard exists.

### Precomputation and prewarming

- Main scheduled broadcasts are committed and cached before fan-out begins.
- The current Main-state capsule and shared Challenge snapshot refresh after each accepted state or ledger event.
- Each Node's compact dossier and active-topic handoff packets refresh asynchronously after relevant private events.
- Likely retrieval context for scheduled cycles is precomputed from current topics and active proposals.
- Startup loads only current version pointers and hottest public/shared projections; the remaining cache warms on demand.

### Recovery and observability

Deleting Valkey data and restarting every process must not lose information. A rebuild command replays source events and projection checkpoints, compares row counts/hashes/high-water marks, and warms critical current state.

Metrics include database commit latency, outbox age, projection freshness, cache hit/miss ratio by namespace, authorization-filtered miss rate, stale-version rejection, eviction rate, single-flight contention, fallback-query p95, rebuild throughput, and divergence checks between cached projections and PostgreSQL.

## K — Trading-knowledge bootstrap

### Available sources

The initial import is limited to explicit, reviewable sources available to the operator:

- a conversation export or preserved transcript for this Gustavo/trading task;
- the current repository's `docs/`, `policy/`, `schemas/`, `state/`, `templates/`, and mission audit artifacts;
- a read-only export of historical local paper trades and potential setups when available; and
- operator-supplied corrections or classification overrides.

Gustavo does not claim access to hidden ChatGPT/Claude memory, internal model state, deleted content, or private chain-of-thought. If a source cannot be exported or read, it is absent rather than reconstructed from guesses.

### Knowledge lifecycle classes

- `CANONICAL`: approved current Gustavo mechanism, safety boundary, Main/Node hierarchy, shared Challenge behavior, or accepted market-analysis rule.
- `CANDIDATE`: useful prior heuristic or parameter awaiting explicit Main/operator review, including old grades, risk percentages, leverage caps, and loss rules.
- `HISTORICAL`: timestamped market observations, paper setups/trades, outcomes, user corrections, and lessons that remain evidence but are not current state.
- `DEPRECATED`: superseded product names, endpoints, workflows, provider-specific assumptions, and old configuration retained only for audit/migration context.
- `PROHIBITED`: broker/prop credentials, real-order routing, execution inbox behavior, external execution payloads, or instructions that must never become callable Gustavo behavior.

Lifecycle is explicit database state. Promotion from `CANDIDATE` to `CANONICAL` creates a reviewed decision event and a new Main-state version. Historical or deprecated records cannot silently influence an active paper decision.

### Initial trading inventory

The importer recognizes these known categories from the existing repository:

- multi-timeframe structure: 4H directional bias, confirmed 1H pivots/zones, completed 15m triggers, and unfinished-candle caution;
- structural evidence quality: separated touch episodes, breakout/retest or rejection completion, opposing zones, range position, correlation, and cost-adjusted reward geometry;
- market-data semantics: provider identity, observation timestamps, live versus potentially delayed labels, history readiness, staleness, and session-open rules;
- decision quality: forming versus confirmed ideas, no-chase entries, structural invalidation, deterministic source identity, duplicate prevention, and recorded counterevidence;
- simulation/risk lessons: desired versus actual risk, exposure caps, portfolio risk, daily/overall loss concepts, pass/fail gates, and immutable paper accounting;
- historical episodes: dated ETH resistance/retest analysis, the AVAX stopped paper attempt, and other stored candidates/outcomes with their original timestamps; and
- deprecated/prohibited material: CFT contract mappings, CFT warnings/terms, broker-style export files, execution directories, and old external endpoint procedures.

This inventory is a migration map, not automatic approval. The new Main Brain and Challenge policies determine which candidate concepts become canonical.

### Import record and idempotency

Every imported item records source type, absolute/local source locator, source timestamp when known, byte/content digest, parser/import version, extracted record type, lifecycle class, visibility scope, freshness/expiry, source excerpt reference, reviewer, review reason, and resulting event/thought/memory IDs.

An `import_key = hash(source_namespace, stable_locator, content_digest, importer_version)` uniquely identifies an import unit. One transaction writes the source manifest row, classified event/thought records, provenance links, and outbox jobs. A repeated run becomes a no-op unless the source digest or importer version changes; changed sources create new versions linked to the prior import.

### Freshness and activation gates

- Exact prices and market states always retain their original observation time and expire from current-state retrieval.
- Historical records may inform lessons and similarity search but cannot satisfy a current freshness, session, candle-completion, or challenge-order gate.
- Candidate methodology can appear in an operator review queue but not in Main broadcasts or Challenge decisions as an accepted rule.
- Deprecated/prohibited records are excluded from embeddings and general Main retrieval by default and require an explicit audit-only scope.
- Canonical imports are still validated against the current schema and policy version before activation.

### Verification and rollback

The importer produces a signed/hashed manifest with source file/message counts, byte counts, parsed/rejected totals, classification totals, duplicate/no-op totals, resulting event high-water mark, and projection status. Verification checks source hashes, provenance completeness, forbidden active-memory terms/behaviors, stale-price isolation, and deterministic replay.

Imports are append-only and individually reversible by appending deactivation events for a manifest or item set. Rollback never deletes the audit trail and never mutates historical challenge accounting.

## D — Local deployment, durability, and scale

### Delivery milestones

- **Working MVP gate:** finish privacy controls already in progress, authenticated SSE, the public shell, authenticated chat/memory/Challenge views, one-command local startup, repository/public-payload safety validation, and a browser smoke path covering invitation, chat, Main/Node attribution, memory controls, simulated Challenge state, and public redaction.
- **Improvement gate:** add encrypted verified backups and isolated restore drills, million-event performance budgets and operator health views, automated scheduled broadcast cycles, hardened public exposure, and the complete recovery/scale acceptance suite.
- Passing the working MVP gate does not waive or delete improvement requirements. It creates an earlier usable checkpoint before production/public-launch hardening.

### Local runtime

- Docker Compose is the supported initial deployment path on the operator’s computer.
- The minimum services are Next.js web/BFF, an orchestration worker, PostgreSQL, and a durable queue/stream service.
- Data lives in explicit local volumes outside disposable containers.
- Public exposure, if enabled later, terminates TLS at a reverse proxy and does not expose PostgreSQL or the queue to the internet.
- Configuration and encryption keys come from local secret files or an OS-backed secret store, never the repository.

### Cloud backup

- The backup target is provider-neutral S3-compatible object storage so the operator can choose a cloud vendor later.
- Backups are database-consistent, encrypted locally before upload, versioned, and protected by separate credentials with write-only or least-privilege scope where supported.
- The initial policy is daily full/logical snapshots plus more frequent incremental or write-ahead-log capture once conversation volume justifies point-in-time recovery.
- Retention uses daily, weekly, and monthly generations. Exact durations remain an operational configuration rather than product logic.
- Every backup records a manifest, checksum, schema version, event high-water mark, and encryption-key version.
- A backup is not considered healthy until integrity verification succeeds. A scheduled restore drill into an isolated local database proves recoverability.
- Backups never contain `.env` files, root encryption keys, access tokens, or plaintext provider credentials.

### Scale path

- Scale web and worker processes horizontally; use job leases, idempotency keys, and transactional outbox writes to prevent duplicate Brain turns.
- Keep account/conversation affinity in durable data, not process memory.
- Partition large event tables and move derived search/vector workloads to separate projections when needed.
- Replace local PostgreSQL, queue, or object storage with managed equivalents independently; public API and event contracts remain stable.
- Apply per-account quotas, request rate limits, queue backpressure, and bounded debate turns before accepting public traffic.

## B — Brain roles

- **Node Brain:** stable named conversational branch assigned to exactly one User Account; maintains one continuous private conversation, inherits versioned Main state, routes interactive replies, and structures qualifying feedback without silently changing its meaning.
- **Main Brain:** the one authoritative shared Brain; commits canonical responses and scheduled broadcasts, receives Node proposals, requests challenges or clarification, applies the winner rubric, versions accepted shared state, and publishes final rationales.
- **Main Challenge role:** after winner selection, the Main Brain may propose a fully specified internal paper intent for the one shared Challenge. It cannot bypass the deterministic challenge-risk engine or directly mutate orders, fills, balances, P&L, or stage state.
- **Moderator Brain (optional, later):** checks policy and privacy before public publication. It does not vote on idea quality in MVP.

“Brains” are product agent identities, not claims of consciousness. Each recorded event includes the agent identity, prompt version, model identifier, and source event references needed for auditability.

## O — Observable output

A Gustavo post answers:

- What is the stock trading at, and when was that observed?
- Is the data live or delayed?
- What does the completed price structure suggest?
- What is the unfinished candle doing right now?
- What levels or completed closes would strengthen or weaken the view?
- What uncertainty should the reader keep in mind?
- Which Node Brain produced the proposal, using a public-safe pseudonymous identity?
- What did the Node Brain transmit to the Main Brain?
- What objections were raised in the recorded debate?
- Which idea won under the reasoning rubric, and why?
- Which portions are public, visible to the originating account holder, moderator-visible, or operator-only?
- Was the delivered scheduled message committed by the Main Brain, and which Main-state version produced it?
- Did the Node reply use `MAIN_DEFAULT`, `NODE_EXPLORE`, or `PROPOSAL_UPSTREAM`, and what happened to any proposal?

## N — Non-goals

- Real-account trade alerts, signals, copy trading, brokerage portfolios, or execution.
- Brokerage or prop-firm integration.
- Provider-specific prop-firm claims or rules not explicitly represented in a versioned simulation profile.
- Financial planning, tax advice, or personalized recommendations.
- Claims that the commentary predicts the market.
- Treating CSS blur, client-side encryption keys, or obscured HTML as authorization.
- Allowing an account to open multiple Brain chats or silently switch its assigned Brain.
- Sharing one account’s private conversation with another account.
- Allowing one Brain to impersonate another or lose its stable identity without a recorded version change.
- Discarding original conversation events after summarization or context-window compaction.
- Treating a cloud backup as a live database, synchronization bus, or substitute for tested restoration.
- Exposing local database, queue, backup credentials, or encryption keys to browsers or the public internet.
- Treating every historical message as prompt context or making Brain conversations wait for a full-history scan.
- Allowing the Main Brain to retrieve raw account-private memory merely because it participates in a council discussion.
- Storing summaries, embeddings, or cached handoff packets as the only copy of user information.
- Claiming Gustavo uses the exact proprietary memory implementation of ChatGPT, Claude, or another vendor.
- Presenting simulated challenge results as real performance, a customer account, or evidence of likely future profit.
- Allowing a model response to change accounting or bypass deterministic rule evaluation.
- Allowing a Node Brain, account holder, vote count, or payment status to mutate the shared Challenge Portfolio directly.
- Letting the Main Brain rewrite its committed baseline after seeing contenders or declaring a contender superior without recorded component scores and provenance.
- Allowing a Node Brain to author, semantically edit, or claim authorship of a scheduled Main Brain broadcast.
- Treating Node agreement with a user as evidence that Main state should change.
- Letting a Node represent an exploratory reply or pending proposal as an accepted Main Brain position.
- Requesting, exposing, or storing private hidden model chain-of-thought instead of concise source-grounded decision rationales.
- Treating Valkey, an in-process cache, a vector index, a summary, or a materialized projection as authoritative source data.
- Reusing a private cached context pack across accounts, scopes, policy versions, or revoked entitlements.
- Letting stale cache state authorize access, accept a proposal, size a paper position, mutate the Challenge ledger, or determine pass/fail state.
- Treating a dated market observation, historical setup, old risk parameter, CFT mapping, or deprecated workflow as current canonical knowledge merely because it was imported.
- Fabricating unavailable chat history, hidden platform memory, deleted content, or chain-of-thought to make an import appear complete.
- Embedding prohibited execution material into the normal Main/Node retrieval index or allowing imported text to become executable configuration without review.
- Claiming automatic access to arbitrary ChatGPT, Claude, email, messaging, or other external conversations without an authorized export/connector.
- Giving the Main Brain permissionless access to raw private Node chats merely to create the appearance of universal memory.
- Using vector similarity alone as truth, ignoring temporal validity/conflicts, or allowing old memories to override current approved state.
- Calling associative software memory an actual biological brain, consciousness, sentience, or perfect recall.

## Open assumptions requiring approval

1. One account receives exactly one stable Brain and one continuous private chat.
2. An account holder may view their own full interaction chain and the debate derived from it; the general public sees only approved outcomes and safe metadata.
3. MVP access is invitation-only through expiring, single-use operator-issued tokens. Paid access remains a later commercial decision and does not alter the one-account/one-Brain/one-chat invariant.
4. **Gustavo** is the product name, `https://gustavo.lol` is the canonical production origin, and “The market thinks out loud” remains the working tagline.
5. The first deployment uses Docker Compose, PostgreSQL, and a durable local queue on the operator’s computer.
6. The cloud-backup vendor and retention durations remain configurable; before public production launch the design requires an S3-compatible target, local encryption, integrity checks, and restore drills. These are post-working-MVP improvements.
7. Squarespace remains the registrar/DNS control point for initial deployment. DNS changes are a documented operator step performed only after local security and recovery verification pass.
8. Public access from the self-hosted computer must use authenticated HTTPS through a hardened reverse proxy or outbound tunnel; the database and queue are never exposed directly, and router port-forwarding is not the default design.
9. Hybrid memory retrieval initially uses PostgreSQL full-text search plus a vector extension; a separate vector database is deferred until measured scale requires it.
10. The Main Brain’s shared memory is composed from explicit Node proposals/transmissions, council events, canonical broadcasts, and public outputs—not unrestricted access to every private account transcript.
11. The Main Brain owns the MVP's single Challenge Portfolio; Node Brains contribute ideas but do not own separate simulated balances.
12. The stage ladder is fixed at $2,500, $5,000, $10,000, $20,000, $40,000, $80,000, $160,000, $320,000, $640,000, and a capped $1,000,000 final stage.
13. The approved initial stage profile is 10% target, 4% daily loss, 6% static overall loss, 3% aggregate internal risk, 1% per-position stop risk, UTC reset, three qualifying days, no deadline, 1x gross exposure, US-listed stocks/ETFs, and the versioned cost assumptions stated above.
14. All challenge activity is internal simulation and remains disconnected from every broker, exchange, prop firm, credential, execution inbox, and external order mechanism.
15. The Main baseline is the default decision. A Node Brain contender changes it only after blind comparison, identical hard gates, a 5/100 recommended improvement margin, and deterministic challenge approval.
16. The approved rubric weights are 25/20/20/15/10/10 as stated above, with an 80/100 absolute action threshold and 5-point contender improvement margin. Changing them later creates a new evaluator-policy version and never rewrites past scores.
17. Scheduled messages use one Main-authored semantic body for all entitled recipients in MVP. Nodes may continue the conversation afterward but cannot personalize or alter the committed broadcast body.
18. Qualifying user feedback may be summarized into a source-linked Node proposal under the product's disclosed privacy scope; raw private text is excluded by default.
19. PostgreSQL is authoritative for all observable thought artifacts and state. Valkey is the initial distributed cache, with a small bounded in-process LRU for immutable hot data.
20. “Everything” means every observable input, output, rationale summary, proposal, evidence link, evaluation, decision, state version, Challenge event, and audit event—not private hidden chain-of-thought.
21. Cache loss is an expected recoverable event. Critical current Main state, scheduled broadcasts, Node handoffs, and Challenge projections must rebuild from database source records and checkpoints.
22. Exact cache TTLs and size limits are operational tuning values established by benchmarks; authorization scope and source-version keys are mandatory regardless of tuning.
23. The initial bootstrap imports the available Gustavo/trading transcript plus the current repository's knowledge files and a read-only historical paper-trade export if one is available at implementation time.
24. Existing structural-analysis methodology enters as `CANDIDATE` until the final Gustavo scoring rubric approves it; current Main/Node/database/simulation safety boundaries enter as `CANONICAL` after design approval.
25. Dated ETH/AVAX and other market records enter as `HISTORICAL`; all CFT/execution/export behavior enters as restricted `DEPRECATED` or `PROHIBITED` audit material.
26. The raw import corpus is encrypted and audit-restricted. Main/Node retrieval uses classified records and source-linked excerpts, not an unfiltered dump of the old conversation.
27. All future native Gustavo chats participate automatically in memory under their account/Node scope. External chats require an explicit supported export or authorized connector.
28. The Main Brain has fast cross-chat access to shared/canonical/proposal/Challenge memory, while raw private Node chat remains permission-scoped; universal storage does not imply universal visibility.
29. PostgreSQL adjacency tables implement the initial memory graph. A separate graph database is deferred until traversal benchmarks require it.
30. “Brain-like” means layered persistence, consolidation, associative retrieval, conflicts, goals, provenance, and forgetting controls—not sentience or hidden access.

## Change log

### 2026-08-12 prompt-update: working MVP before improvement tranche

Reason: During execution, the user requested a usable MVP from the completed backend before continuing the remaining work as improvements.

Previous relevant intent preserved verbatim:

> “The initial deployment runs on the operator’s computer and remains functional without a hosted application runtime or hosted database.”

> “Encrypted cloud backup is required for recovery but is not part of the live request path.”

> “Docker Compose is the supported initial deployment path on the operator’s computer.”

The requirements remain committed, but delivery is now milestone-based. The first gate is a working local MVP using the completed T1–T26 backend plus T27–T29, the local-runtime portion of T30, T32, and an MVP slice of T34. Backup/restore hardening, T31 scale verification, T33 automated scheduling, and the remaining T34 proof follow as improvements before public production launch.

### 2026-08-08 prompt-update: public stock-commentary pivot

Reason: The user requested a marketable public identity and explicitly removed all CFT-specific scope, redefining the project as the assistant sharing thoughts on current stock prices.

Previous intent preserved verbatim from the original README:

> “This repository preserves the trading mechanism, operating rules, safety constraints, and dated decisions developed in the `eth-trade-setup-monitor` chat.”

> “It documents a local simulation only. It is not a signal service, brokerage integration, or authorization to trade a real account.”

> “The only permitted JSON-export location is `C:\Users\gusta\Desktop\Projects\Trade\paper-lab-exports`, and an export remains a passive local paper-tracking artifact.”

Those requirements are now superseded for the public product. Their only retained value is audit history; they must not remain in the public-facing repo after the approved migration.

### 2026-08-08 prompt-update: sponsored seats and Brain council

Reason: The user added the core commercial and interaction model: sponsored seats donated to public participants, stable Seat Brains that always transmit to the Core Brain, recorded Brain-to-Brain debate, winner selection, and a protected response stream behind a Next.js BFF.

Previous relevant intent preserved verbatim:

> “Product scope: timestamped thoughts about current stock prices and visible price structure.”

> “The first public version publishes a stock commentary entry...”

That single-author publishing model is superseded by an interactive multi-Brain council. Timestamped stock-price commentary remains the subject matter, but the product’s distinctive value is now participation, transmission, debate, selection, and provenance.

### 2026-08-09 prompt-update: rename to Tape and reopen seat ownership

Reason: The user selected the shorter product name “Tape” and questioned the statement that sponsors fund seats only for other people. That statement was an assistant inference, not an approved requirement.

Previous relevant intent preserved verbatim:

> “Public-facing product name: **TapeThoughts**.”

> “Sponsors purchase seats that are donated into a public allocation pool.”

The name is now Tape. The sponsored-only model is removed from requirements and converted into one of three explicit alternatives awaiting the user’s decision.

### 2026-08-09 prompt-update: one account, one Brain, one chat

Reason: The user clarified that Tape does not use a sponsored-seat pool or donation relationship. Each individual account talks to one Brain in one persistent chat.

Previous relevant intent preserved verbatim:

> “Seat purchase, ownership, and donation semantics are not yet approved. No sponsor or recipient entitlement model may be implemented until the user selects the intended model.”

> “Seat purchase/donation model must be selected before sponsor or purchaser permissions are designed.”

Those alternatives are superseded. The product invariant is now one account, one stable Account Brain, and one continuous private chat. Commercial pricing and access duration remain separate decisions.

### 2026-08-09 prompt-update: durable Brain memory and local-first scale

Reason: After approving the one-account/one-Brain/one-chat direction, the user required Tape to retain everything discussed with every individual Brain, run from the user’s own computer, scale beyond one machine, and maintain cloud backups.

Previous relevant intent preserved verbatim:

> “Every event has a globally unique ID, aggregate ID, actor type/ID, timestamp, prompt/model version when applicable, causation ID, correlation ID, visibility class, and integrity hash. Corrections append a new event; they never rewrite history.”

> “The Next.js BFF is an API boundary, not the sole durable backend.”

Those requirements remain valid but were insufficiently specific about full-fidelity retention, local deployment, cloud recovery, and scale. The active design now makes PostgreSQL source history durable, makes summaries/indexes rebuildable projections, defines a containerized local topology, and requires encrypted provider-neutral backups with tested restoration.

### 2026-08-09 prompt-update: Gustavo brand and domain

Reason: The user renamed the product from Tape to Gustavo and identified the already-owned `gustavo.lol` domain, managed through Squarespace.

Previous relevant intent preserved verbatim:

> “Public-facing product name: **Tape**.”

> “The repository directory should be renamed from `paper-trade-lab-knowledge` to `tape` after approval.”

The active design now uses Gustavo, targets `https://gustavo.lol`, and treats Squarespace as the current registrar/DNS control point. Domain ownership is separate from the local application runtime and cloud-backup provider.

### 2026-08-09 prompt-update: layered fast memory

Reason: The user asked Gustavo to retain information from every chat in a memory system comparable in behavior to ChatGPT and Claude, while ensuring conversations between Brains do not become slow as history grows.

Previous relevant intent preserved verbatim:

> “Summaries, embeddings, topic labels, search indexes, and context-window checkpoints are versioned projections. They can be deleted and rebuilt from source history.”

> “Context assembly retrieves the most relevant prior events plus recent conversation, but the UI always permits paginated access to the complete authorized transcript.”

Those principles remain, but the active design now specifies a seven-layer memory model, scoped hybrid retrieval, asynchronous extraction, versioned Brain dossiers, precomputed handoff packets, provenance, correction semantics, and measurable latency budgets. It explicitly does not claim access to ChatGPT’s or Claude’s proprietary internal architecture.

### 2026-08-09 prompt-update: Core $2,500-to-$1,000,000 simulated challenge

Reason: The user requested that the Core Brain track all of its paper trades in a prop-style progression that starts at $2,500, doubles after each passed stage, and ends after passing the $1,000,000 stage, while remaining in planning mode.

Previous relevant intent preserved verbatim:

> “No broker, exchange, prop-firm, CFT, paper-order, order-export, account-risk, position-sizing, leverage, or credential functionality.”

> “The product does not convert observations into orders, risk amounts, leverage, or broker symbols.”

The active design now permits internal simulated paper intents, orders, positions, sizing, and challenge accounting. It preserves the prohibition on real execution, broker/prop integration, credentials, external payloads, and copy-trade language. `UserAccount` and `ChallengePortfolio` are separate domains, and only the Core Brain owns a portfolio in MVP.

### 2026-08-09 prompt-update: one shared goal with Core baseline

Reason: The user clarified that every Account Brain contributes to the same Core Challenge Portfolio. Account holders may develop ideas with their individual Brain, but an idea must be better than the Core Brain's own baseline before it can influence the shared goal.

Previous relevant intent preserved verbatim:

> “The MVP has exactly one active Core Challenge Portfolio. Account Brains contribute structured ideas; the Core Brain council debates them and may propose a paper intent.”

> “Individual Account Brains do not receive separate challenge balances in MVP.”

Those statements remain valid but are now stronger: the Core commits its baseline first, contenders are normalized and blind-scored against it, and only a hard-gate-passing contender above the improvement margin can replace or modify the Core decision. All other contributions are recorded without changing the Challenge Portfolio.

### 2026-08-09 prompt-update: one Main Brain with user-facing Node Brains

Reason: The user clarified that Gustavo is fundamentally one shared Brain and one shared Challenge. User-assigned Node Brains conduct the only private user conversations, while scheduled messages always originate from the Main Brain. A Node either answers from the Main default, explores feedback privately, or submits an evidence-backed suggestion to the Main Brain.

Previous relevant intent preserved verbatim:

> “Each `UserAccount` has exactly one stable Brain identity and one continuous private chat.”

> “The Core Brain remains the default decision-maker unless a contender demonstrably outperforms its committed baseline.”

Those principles remain, but canonical terminology is now Main Brain and Node Brain. The Main Brain owns all shared/canonical thought, broadcasts, accepted positions, and the Challenge. Nodes inherit Main state, own only their private dialogue branch, and cannot represent exploration or a pending proposal as an accepted Main position.

### 2026-08-09 prompt-update: database-backed thought ledger and cache hierarchy

Reason: The user required Gustavo to keep track of everything in a database and cache everything needed to make thought retrieval and coordination fast.

Previous relevant intent preserved verbatim:

> “PostgreSQL is the local source of truth.”

> “A short-lived cache accelerates hot dossiers but contains no sole copy of memory.”

Those principles remain and are now explicit across all observable thought artifacts. The active design defines `ThoughtRecord`, authoritative tables, transactional writes, PostgreSQL projections, distributed Valkey and process-local cache layers, versioned scope-bound keys, event-driven invalidation, prewarming, rebuilds, and cache correctness metrics. Hidden model chain-of-thought is outside the product record; concise source-grounded rationales are stored instead.

### 2026-08-09 prompt-update: import current trading knowledge

Reason: The user confirmed that anything explicitly preserved in the current task or repository that helps Gustavo understand the trading mechanism should become database-backed Main Brain memory.

Previous relevant intent preserved verbatim:

> “Historical chat material that no longer fits is preserved only in prompt-update audit records.”

> “Everything means every observable input, output, rationale summary, proposal, evidence link, evaluation, decision, state version, Challenge event, and audit event—not private hidden chain-of-thought.”

The active design now adds a classified bootstrap importer. Current Gustavo rules can become canonical after approval; prior trading methodology enters reviewable candidate memory; dated market/trade episodes remain historical; and CFT/execution/export behavior remains deprecated or prohibited. Every import is source-linked, hashed, versioned, idempotent, reviewable, and reversible by append-only deactivation.

### 2026-08-09 prompt-update: continuous brain-like cross-chat memory

Reason: The user expanded memory from this trading task to every authorized native or imported chat and required fast access that behaves like a persistent associative brain.

Previous relevant intent preserved verbatim:

> “The Main Brain is bootstrapped from explicit trading knowledge available in this task and repository through a classified, provenance-preserving, idempotent import.”

> “Memory is layered into immutable source events, recent working context, structured durable facts, episodic summaries, hybrid search indexes, and precomputed Brain handoff packets.”

Those principles remain and now operate continuously across chats. The active design adds native capture, authorized external chat sources, working/episodic/semantic/procedural/relational/goal/meta-memory, explicit scopes, incremental consolidation, a temporal knowledge graph, multi-index recall planning, `RecallTrace` provenance, conflict-aware ranking, and cross-chat user controls. It does not claim access to unstored chats or biological consciousness.

### 2026-08-09 prompt-update: approved MVP operating defaults

Reason: After approving the architecture, the user explicitly approved the recommended MVP defaults for Challenge rules, evaluator scoring, initial markets, Brain runtime, and beta access.

Previous relevant intent preserved verbatim:

> “The initial profit objective, daily-loss rule, overall drawdown rule, timezone, minimum days, market universe, and simulated cost model for each stage still require explicit configuration before tracking starts.”

> “The exact 100-point rubric weights and absolute action-quality threshold remain pending approval.”

> “Whether account access is a subscription, one-time purchase, invitation, or free entitlement remains a later commercial decision.”

Those choices are now canonical and versioned: invitation-only beta access; an operator-managed US stock/ETF allowlist with licensed timestamped data; provider-neutral Main, Node, and evaluator model roles; a 10%/4%/6% Challenge with 3% aggregate and 1% per-position risk limits, UTC reset, three qualifying days, no deadline, and 1x gross exposure; the stated conservative simulation costs; and the 25/20/20/15/10/10 rubric with an 80/100 action threshold and 5-point improvement margin.
