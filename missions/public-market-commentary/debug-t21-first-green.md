# Debug: T21 first green
**Originated during:** mcax-execute T21
**Status:** fixed

## Symptom (one sentence)

`pnpm vitest run tests/recall/planner.test.ts` expected the expanded recall suite to pass, but 8 of 13 tests failed: PostgreSQL rejected the recall migration's subquery-based `CHECK` constraints, pure planning rejected a safely excludable private candidate with partial topology, and scoped memories with the same equivalence digest were incorrectly collapsed.

## Reproduction

1. Run `pnpm vitest run tests/recall/planner.test.ts`.
2. Observe the migration error and pure planner failures.

Result: 5 tests passed and 8 failed; the first database error was `cannot use subquery in check constraint`.

## Hypotheses

- H1: PostgreSQL forbids the `array(select distinct ...)` expressions used directly in table `CHECK` constraints. Confirmed by locating both subqueries in `0015_recall.sql` and reproducing the migration error before any database test body ran.
- H2: `captureCandidate` applies durable private-topology completeness before the authorization pass, so a Main request cannot record a metadata-only foreign candidate as `SCOPE_FORBIDDEN`. Confirmed by the focused Main scope test.
- H3: the equivalence identity omits scope, even though T19 equivalence sets are scope-bound, so private and Node projections collide. Confirmed by the account PRIVATE_ACCOUNT/NODE_BRANCH test using one equivalence digest.
- H4: the fixed trace timestamp predates the dynamically created test entitlement in UTC, so the SQL authority trigger correctly rejects the trace. Confirmed by comparing `NOW` with the fixture's `active_from` timestamp.
- H5: measured latency was included in the idempotency request digest, so two concurrent executions of the same request produced different digests. Confirmed by the deterministic conflict after the advisory lock serialized both writers.
- H6: a recall trace advanced the account aggregate's generic event high-water and durable state versions were treated as request identity, so a sequential replay conflicted with itself. Confirmed by a new sequential-replay regression test.
- H7: the account-isolation integration test exceeded Vitest's five-second default even though its recall behavior completed correctly. Confirmed by rerunning that exact test with a diagnostic twenty-second harness allowance; it passed in about seven seconds.
- H8: an idempotent replay after a memory-version change returned the original stored trace alongside the newly planned memory list. Confirmed by seeding a second authorized memory between identical calls and observing that the response IDs diverged from `trace.selectedMemoryIds`.
- H9: that replay regression first exposed that SQL `NULL` topology fields on a public memory were treated differently from omitted optional fields at the hostile-input boundary. Confirmed by the initial regression run failing while capturing the public candidate before reaching the intended replay assertion.

## Root cause

The first green implementation crossed three independent boundaries incorrectly: SQL table constraints used query forms PostgreSQL accepts only inside functions, pure candidate capture confused incomplete forbidden metadata with a durable authorized topology, and rank dedupe used a global equivalence namespace instead of T19's scope/identity namespace. Two later idempotency failures came from treating measured or mutable output (latency and state high-water) as caller request identity. The fixed UTC test constant separately predated the dynamically created entitlement and was corrected to represent the actual trace time.

## Fix attempts (counter)

1. Replaced subquery-bearing table constraints with immutable validation functions and parenthesized the trigger's CASE predicate: migration installed successfully.
2. Allowed account-only private metadata at the pure boundary while requiring exact account/Node/conversation equality for authorization: scope tests passed.
3. Bound equivalence identity to scope/account/Node/conversation/type and corrected the fixture's default identities: scoped dedupe tests passed.
4. Moved the fixture trace time after dynamic entitlement creation: SQL account authority passed.
5. Removed measured latency from the request digest: concurrent replay passed.
6. Excluded recall trace events from Node state high-water and kept state versions as recorded output rather than request identity: sequential replay passed.
7. Declared a fifteen-second harness timeout for the database-backed account-isolation test; this is not a product latency assertion, and the benchmark contract remains free from flaky wall-clock checks.
8. Reconstructed every response from the immutable stored trace's selected IDs, using only currently authorized and available hydrated candidates; missing replay material now fails closed.
9. Normalized explicit SQL `NULL` and omitted optional topology fields to the same null representation before scope validation.

## Regression test

File: `tests/recall/planner.test.ts`

Description: the existing migration-backed tests exercise successful schema installation, while the pure scope tests cover partial forbidden metadata and distinct private/Node projections.

Pre-fix result: failing.

Post-fix result: passing.

## Fix

- `db/migrations/0015_recall.sql`: installs legal validation functions plus immutable, authority-bound recall tables and graph indexes.
- `lib/server/recall/planner.ts`: separates hostile-input capture from scope authorization, resolves durable topology before retrieval, and records mutable measurements without using them as request identity.
- `lib/server/recall/rank.ts`: applies scope-aware equivalence dedupe.
- `lib/server/recall/trace.ts`: uses a stable caller-input digest for exact concurrent and sequential replay.
- `tests/recall/planner.test.ts`: provides the focused regression coverage, including sequential replay.

## Wider check

- `pnpm vitest run tests/recall/planner.test.ts` -> 15 tests passed.
- `pnpm vitest run tests/memory/consolidation.test.ts tests/chats/incremental.test.ts tests/events/event-store.test.ts tests/recall/planner.test.ts` -> 98 tests passed.
- `pnpm vitest run` -> 27 files and 497 tests passed.
- `pnpm exec tsc --noEmit` -> exit 0.
- `pnpm install --frozen-lockfile` -> exit 0.
- `pnpm build` -> exit 0.
- `git diff --check` -> exit 0 (line-ending warning only).
- Test PostgreSQL process check -> no orphan `gustavo-postgres-*` processes.

## Stage A correction pass

The spec-review correction began with one grouped RED run: 34 focused tests, 19 passing and
15 failing. The failures covered same-proposal all-source disclosure, entitlement/proposal/key
serialization, unconsolidated working context, fair bounded fusion/index shape, trace manifest
authority, complete idempotency inputs and exact replay, 500-source provenance/token accounting,
and false cache hits.

Root-cause fixes were applied one boundary at a time. Proposal authorization now proves that one
current unrevoked raw-text proposal covers every source; actor/proposal/key authority is locked
through commit; event-body reads authorize the full batch and take stable materialized KEY SHARE
locks before fetching ciphertext; native Main/Node/Challenge/recent context is pinned ahead of
derived memories; every channel preselects before source aggregation and graph scans are
directional; trace authority is manifest/digest/high-water bound; replay hydrates stored IDs
directly; source provenance supports 500 IDs; complete-pack serialization is budgeted; and unused
cache values are always reported as MISS.

The first post-wiring run passed 28 of 34 tests. The six remaining failures identified an obsolete
excerpt-only token expectation, duplicate protected-key derivation, a too-small working-context
fixture budget, an SQL test alias using a reserved word, and denial assertions that confused the
encrypted trace INSERT with a protected source ciphertext SELECT. After correcting those exact
boundaries, the focused matrix passed 34 of 34 tests. Self-review then tightened key-deletion
ordering and source-high-water filtering before the final verification pass.

### Full-suite harness timeout

The first Stage A full-suite command used a 300-second command ceiling and ended with exit 124 at
304 seconds without emitting a Vitest assertion failure. Process inspection tied the remaining
`gustavo-postgres-vuZkFh` cluster (PID 25872, start time 12:09:14, temp data directory and parent
time matching that run) to the killed harness. That exact cluster was stopped cleanly with
`pg_ctl -m fast`; unrelated PostgreSQL and Node processes were not touched. The diagnosis is a
harness ceiling below the repository's known roughly eight-minute full-suite baseline, so the
unchanged command is rerun with a ceiling above that baseline rather than changing product code.

The unchanged rerun completed successfully: 27 test files and 511 tests passed in 463.36 seconds.
The Stage A related slice also passed 112 tests, TypeScript and the production build passed, and
the frozen dependency install remained unchanged.

## Stage A spec-review correction

The correction RED was clean at 27 passing and 11 failing tests. The first production-backed
rerun failed while installing `0015_recall.sql` at character 31,737. Mapping that exact parser
position identified the new PL/pgSQL context-provenance `IF CASE` expression; parenthesizing the
SQL CASE expression fixed schema installation, and the unchanged trace integration test then
passed.

The next bounded slice exposed independent query-shape issues rather than another migration
failure: the exact proposal revalidation query ordered DISTINCT text projections by their UUID
source expressions, the FTS plan selected the broad generated unique index, and the zero-memory
fixture had no materialized Challenge checkpoint. The DISTINCT query now orders by its selected
aliases; FTS topology and the checkpoint fixture remain separate hypotheses to verify with their
own unchanged focused regressions.

The first complete post-correction run passed 37 of 39 tests. Both failures were legacy
zero-private-key assertions: Main's lexical digest preparation still included an authorized or
formerly authorized proposal conversation before the candidate-level all-source proof. The fix
does not disable protected hybrid recall. Main now derives term digests only for its shared and
Challenge retrieval domains; proposal-private lexical preselection uses the indexed active
proposal source-membership relation, and the exact term is confirmed from plaintext only after
the final proposal/disclosure revalidation and authorized body batch. The regression also places
an unrelated active raw proposal beside an older low-importance MAIN_SHARED exact target. The
mixed-source denial, expired-proposal denial, shared exact target, and proposal-private exact
target then passed together (4/4), while query observation confirmed that neither denial read the
proposal conversation key or any protected ciphertext.

Self-review then found that the trace digest was bound to the event idempotency suffix but not to
an immutable clear digest on the encrypted-body row itself. A focused RED failed with
`column body.body_digest does not exist`. Migration 0015 now adds a nullable-for-existing-rows,
immutable `encrypted_event_bodies.body_digest`, the event store writes the canonical plaintext
digest on every new encrypted body, and RecallTrace has a composite SQL foreign key plus trigger
checks requiring the event/body digest to equal the trace digest. The direct body-authority test
then passed, including arbitrary-body substitution rejection.

The next full suite completed with 521 passing tests and one failure in the Challenge legacy
profile-upgrade fixture: that fixture intentionally invokes the current event store against a
pre-0015 schema, so the unconditional seven-column encrypted-body insert could not find
`body_digest`. The digest column is required only for the new `memory.recall.traced` event type.
The event store therefore retains the legacy six-column batch insert for every ordinary event and
uses the seven-column digest-bound insert only for recall trace events, which cannot exist before
migration 0015. This keeps the upgrade path compatible without weakening RecallTrace binding.

The unchanged full rerun then passed all 27 files and 522 tests. Final process inspection found
one stale T21 fixture cluster at `C:\Users\gusta\AppData\Local\Temp\gustavo-postgres-nEQY7m`
(postgres PID 28560, wrapper PID 17136). Its directory and process start time were both 11:32:24;
the log contained this correction's RecallTrace rejection cases, then a forced client EOF at
11:33:12 and only idle checkpoints afterward. After verifying that exact ownership, the cluster
was stopped cleanly with `pg_ctl -m fast`; no other PostgreSQL process or temp directory was
touched.

Final correction verification: focused RecallTrace 39/39, recall plus event-store 45/45,
related memory/chat/event/recall slice 123/123, and full suite 27 files / 522 tests. TypeScript,
the production build, frozen dependency installation, and `git diff --check` all exited zero;
the final process recheck found no `gustavo-postgres-*` test cluster.

## Final Stage A P1 probes

The body-forgery RED showed that a caller could append arbitrary recall plaintext, accept the
append-computed body digest, and clone a separately self-consistent trace and child graph around
that digest. Both transactions committed because the former constraint compared copied clear
manifest fields instead of computing the only permitted body from the immutable provenance
graph. Migration 0015 now reconstructs the canonical authority manifest from ordered plan,
candidate, source, context, selection, and exclusion rows plus trace scalars. The deferred
constraint requires exact equality with that reconstruction, computes the expected canonical
body digest from it, and binds that digest to the immutable encrypted body and event. Candidate
channels and scores are reconstructed from the typed candidate row rather than trusted JSON.
The reader independently decrypts the body and verifies the same canonical digest. The exact
arbitrary-body and self-consistent cloned-body regression is green.

The vector scale RED placed each exact-nearest PUBLIC and MAIN_SHARED target behind 125
high-importance distractors; both targets disappeared because the old planner applied its
100-row importance cap before exact similarity. A companion consolidation RED failed because
the required index relation did not yet exist. The bounded replacement persists six
domain-separated deterministic bucket digests per embedded memory: public digests are SHA-256,
and protected digests are HMACed with the scope retrieval key. No raw protected embedding or
reversible fingerprint is persisted. The producer inserts the buckets while plaintext and key
authority are available; indexed version/bucket/scope lookup occurs before the candidate cap;
and exact vector scoring remains after final authorization and decryption. Both retrieval-key
and body-key foreign keys cascade bucket deletion, and the query also joins live keys, so erasure
cannot leave searchable protected buckets. The two >125-candidate retrieval regressions, index
shape checks, and producer authority/erasure regression are green.

Final P1 verification: exact body-forgery regression 1/1, focused RecallTrace 39/39, full
consolidation 39/39, related memory/chat/event/recall slice 124/124, and the unchanged full suite
27 files / 523 tests in 493.96 seconds. TypeScript, production build, frozen install, and
`git diff --check` all exited zero. Process inspection found no running PostgreSQL, `pg_ctl`, or
Node process owning any `gustavo-postgres-*` fixture directory; no cleanup was necessary.

## Stage B correction

The grouped Stage B RED was clean at four failing tests. A candidate whose own source was
disclosed caused its entire two-memory protected consolidation body to be decrypted even though
the sibling memory source was undisclosed. A route followed by newer user/import events failed
with `RECALL_TRACE_CONTEXT_INVALID` because the trace stored the conversation maximum instead of
the routed Node state sequence. A 500-source trace executed 500 source inserts, nine plan inserts,
and 545 observed queries, while a fake-clock overrun at the final stored-trace read still
committed. Finally, deleting the new vector buckets from historical PUBLIC and MAIN_SHARED rows
made both exact-nearest targets disappear.

Body hydration now requires metadata authorization for every memory sharing the body before any
body key or ciphertext read. For Main, one locked, current, unrevoked, unexpired raw-text proposal
must cover every source of every private sibling in the body; account and operational actors are
checked against their exact scope and identity domains, and every sibling source must still have
a live encrypted body and key. The partial-disclosure and erased-sibling regressions read neither
the consolidation body key nor ciphertext, while one proposal covering both live siblings permits
the disclosed target. Node state version and the NODE_STATE context entry now both derive from the
same latest `node.reply.routed` event; the separate global high-water still advances for newer
conversation events.

RecallTrace candidates, sources, plan steps, and context influences now use four set-wise JSON
recordset inserts while retaining every row trigger and deferred graph/body completeness check.
The 500-source trace stays within a constant 80-query contract. A post-persistence check runs
before the transaction callback returns, and the remaining time is installed as the transaction's
statement timeout so deferred commit work is bounded; the deterministic 5,001 ms regression rolls
back the event and trace graph.

Historical vector maintenance scans at most 100 missing rows in deterministic memory-id order
under a non-blocking transaction advisory lock. It authorizes every sibling in each consolidation
body first. PUBLIC rows use the already-public search embedding without ciphertext; protected
rows batch-read only authorized bodies, require exact body embedding version/digest/dimension,
batch-lock their live retrieval keys, persist only domain-separated HMAC buckets, and zero all
unwrapped/derived keys. Set-wise conflict-safe inserts make the path resumable, and missing body
or retrieval keys fail closed. Independent PUBLIC-only system and Main recalls restore and use
the historical PUBLIC and MAIN_SHARED targets without persisting a raw protected vector.

Final Stage B verification after the erased-sibling self-review tightening: focused RecallTrace
44/44, related memory/chat/event/recall slice 129/129, and the unchanged full suite 27 files /
528 tests in 537.55 seconds. TypeScript, the production build, frozen dependency installation, and
`git diff --check` all exited zero. The final process check found no PostgreSQL, `pg_ctl`, or Node
process owning a `gustavo-postgres-*` fixture directory; no cleanup was necessary.

## Final Stage B historical-vector probes

The final grouped RED isolated both requested historical-maintenance failures. With two protected
memories in one consolidation body, erasing one sibling source key still allowed the consolidation
ciphertext query to run. The scale regression also showed that maintenance had no durable cursor:
it selected missing rows from the beginning on every invocation and reached the recall statement
timeout before proving a resumable page or an indexed traversal.

Historical maintenance now persists one NULLS-NOT-DISTINCT checkpoint for each exact authorized
scope/account/Node/conversation/embedding-version domain. A non-blocking transaction advisory lock
and checkpoint row lock select one page. Shared/public domains use the partial
`(scope,embedding_version,id)` index; private/Node domains use the partial identity-specific index;
both scan strictly after `last_memory_id` and at most 100 rows. The checkpoint advance, protected
body read, and conflict-safe bucket insert remain in the recall transaction, so any decrypt,
validation, insertion, deadline, or commit failure rolls the cursor back. Empty authorized domains
are completed set-wise, allowing the same Main recall to reach its first non-empty shared domain.

Eligibility is evaluated only after the indexed page is fixed. It now requires every memory in a
consolidation body to remain inside the authorized domain set and every source of every sibling to
retain both an encrypted body and live aggregate key. An erased sibling therefore contributes no
protected body id, causes no body-key/ciphertext read, and inserts no vector bucket. The supporting
`(body_event_id,id)` index bounds this whole-body proof. Terminal key erasures advance as deliberate
fail-closed rows; any non-terminal failure rolls the checkpoint back, so an eligible preexisting
missing-bucket row cannot be permanently skipped.

The first full-focused integration pass exposed a separate domain-normalization defect: account
actors attached account/Node/conversation identity to their shared and public scopes, violating the
checkpoint table's canonical identity constraint. `vectorBackfillDomains` now carries identity only
for `PRIVATE_ACCOUNT` and `NODE_BRANCH`; all shared/public domains use null identity. The affected
account, trace-replay, lock-serialization, and whole-body cases passed together after that fix.

Final verification: the two new regressions passed 2/2; the focused recall file passed 46/46 in
74.34 seconds; the event-store/consolidation/recall slice passed 91/91 in 142.24 seconds; and the
unchanged full suite passed 27 files / 530 tests in 548.91 seconds. Pinned-runtime TypeScript,
production build, frozen dependency installation, and `git diff --check` all exited zero.
The final ownership check found no PostgreSQL, `pg_ctl`, or Node process attached to any
`gustavo-postgres-*` fixture directory; no process cleanup was necessary.

## Final Stage B source-erasure race

The final P0 RED paused the historical backfill immediately after its sibling-source availability
query returned. A second connection then committed `encrypted_event_bodies.data_key_id=NULL` for
one sibling source. When recall resumed, it still queried the consolidation ciphertext and rebuilt
the buckets from the now-unauthorized body. This proved the prior availability predicate was only a
point-in-time observation and did not serialize source erasure through hydration.

Normal candidate hydration and historical backfill now share one bounded event-store primitive.
After scope/proposal/domain authorization, it expands at most 100 consolidation bodies to at most
50,000 distinct sibling-source requirements set-wise. It snapshots the exact source,
consolidation, retrieval, and already-authorized Main/Node/recent context body keys; locks every live
key in stable key-ID order; locks and re-reads every body row in stable event-ID order with
`FOR SHARE`; and returns only consolidation bodies whose body, retrieval, and every sibling source
still match their locked live keys. `FOR SHARE` conflicts with the permitted non-key update that
sets `data_key_id` to null. Keys are acquired before body rows, matching aggregate-key deletion
order, and the complete context/candidate key set is locked together before ciphertext hydration.

Both deterministic interleavings are covered. When erasure commits after the requirements scan but
before locks, the locked recheck rejects the body and performs zero consolidation ciphertext reads
and zero bucket inserts. When recall acquires the event-ordered body locks first, the same nulling
update remains blocked until the authorized normal recall commits, after which erasure completes.
The regression also asserts requirements-to-key-to-body-to-ciphertext ordering, sorted lock
parameters, and one set-wise query per primitive phase. The normal bounded query contract now
allows three constant key-share groups: retrieval digest, source/body revalidation, and ciphertext
hydration.

Final race verification: both interleavings passed 2/2, focused recall passed 48/48 in 70.04
seconds, the event-store/consolidation/recall slice passed 93/93 in 141.38 seconds, and the unchanged
full suite passed 27 files / 532 tests in 502.07 seconds. Pinned-runtime TypeScript, production
build, frozen dependency installation, and `git diff --check` all exited zero.
The final ownership inspection found no PostgreSQL, `pg_ctl`, or Node process attached to a
`gustavo-postgres-*` fixture directory; no cleanup was necessary.

## Context-only source-erasure closure

The final P1 RED showed that the shared lock was skipped when recall had no authorized memory
candidates. A current Main-state context body was still passed directly to `readEventBodies`.
Pausing after its aggregate-key read allowed a second connection to commit
`encrypted_event_bodies.data_key_id=NULL`; recall then fetched the ciphertext before failing. In
the complementary ordering, the nulling update did not wait because no event-row lock existed.

`revalidateCandidateBodies` now invokes the same shared primitive when candidate bodies are empty
or all rejected but authorized Main/Node/recent context event IDs remain. The primitive accepts an
empty consolidation-body set only with a non-empty bounded context set, includes those context
bodies in the existing sorted key and event-ID lock sets, and requires every context body to retain
the exact locked live key. If erasure commits first it throws `EVENT_KEY_UNAVAILABLE` before any
ciphertext or context influence is persisted. If the context body lock wins, the nulling update
waits until the zero-memory recall and its context trace commit. No-body/no-context recalls skip the
primitive, and the combined event-body set remains capped at 100.

Final context-only verification: both interleavings passed 2/2, the high-risk context/query/erasure
slice passed 7/7, focused recall passed 50/50 in 70.75 seconds, the event-store/consolidation/recall
slice passed 95/95 in 128.52 seconds, and the unchanged full suite passed 27 files / 534 tests in
485.19 seconds. Pinned `pnpm.cmd` TypeScript, production build, frozen dependency installation,
and `git diff --check` all exited zero.
The final ownership inspection found no PostgreSQL, `pg_ctl`, or Node process attached to a
`gustavo-postgres-*` fixture directory; no cleanup was necessary.
