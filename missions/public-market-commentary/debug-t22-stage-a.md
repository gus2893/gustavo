# Debug: T22 Stage A closure
**Originated during:** mcax-execute T22 Stage A review closure
**Status:** fixed

## Symptom

The targeted erasable/domain-separated digest test completed the graph write but its verification query failed with `EXPECTED_ONE_ROW:0`.

## Reproduction

1. Prepend the pinned Node 24.14.0 and pnpm 11.16.0 runtime directories to `PATH`.
2. Run `pnpm.cmd vitest run tests/memory/conflicts.test.ts -t "derives erasable"`.
3. Observe that PostgreSQL migration/application setup and the graph write complete, then the joined verification row is absent.

## Hypotheses

- H1: the verification query incorrectly assumes the entity canonical digest and its text-identical alias digest are equal. Confirmed: the Stage A contract intentionally derives them from distinct `entity:v1` and `alias:v1` domains, so equality is forbidden.
- H2: the graph failed to persist aliases or their authoritative sources. Refuted by inspecting the completed write and the query predicate: the row was excluded only by the cross-domain digest equality join.

## Root cause

The new regression fixture selected the canonical alias by equating two protected digests even though the same test requires all entity, alias, predicate, and value domains to produce distinct digests.

## Fix attempt

1. Selected the intended canonical alias version by its exact two-source authority count, leaving the subsequent assertions to prove both its expected alias-domain digest and its inequality from the entity digest.

## Regression test

File: `tests/memory/conflicts.test.ts`

The keyed manifest case now identifies the AAPL alias through its authoritative two-source set and independently compares each digest with its expected retrieval-key-derived, domain-separated value.

## Wider check

- Focused T22: 19/19 tests passed after final manifest-completeness hardening.
- Related consolidation/recall/T22 slice: 109/109 tests passed.
- Full serialized suite: 28 files and 554/554 tests passed.
- Strict TypeScript, production build, frozen dependency installation, scope/whitespace checks, and process ownership checks exited zero.

## Category 2 adjacent-producer finding

The first incremental/global-head targeted run reached the later source projection and failed with `MEMORY_PROJECTION_GAP`. The graph event is correctly encrypted under the private conversation aggregate so its protected body shares the conversation's erasable key; however, T19's eligible-source query excluded only `memory.consolidation.completed`, so it mistook the derived `memory.edge.versioned` event for a missing user/source event on the next consolidation. A separate graph aggregate would have avoided the gap only by breaking the required erasure coupling. Root authorized the minimum fix: exclude the derived graph event type at every existing derived-event source/eligibility boundary and add the focused high-water regression. The exact RED then passed.

## Entity-era historical-count finding

The first close/reopen targeted run produced the required one stable entity, three append-only entity versions, five append-only alias versions, two explicit closure versions, and complete supersession chains. Its raw `valid_to is null` assertion nevertheless counted three rows because the two original open historical versions cannot be updated after their closure successors are appended. Counting only unsuperseded null-ended alias versions gives the intended one logical open head while preserving append-only history; the test was corrected to express that temporal meaning.

## Candidate-bound fixture finding

The second Stage A grouped RED reached six intended contract failures, while its 100-claim capacity case stopped at `MEMORY_SOURCE_TEXT_MISMATCH`. The fixture's encrypted event body joined each generated sentence with its period, but its supplied extraction-event text reconstructed the fact labels without periods. Reusing the exact source-body string for the event input restores the authoritative source-text identity and allows the test to reach the intended durable graph-cap boundary.
## Second Stage A job-transition trigger namespace

- Observation: the first targeted owner-revalidation run failed during initial job creation with
  PostgreSQL `column reference "job.id" is ambiguous`.
- Hypothesis: the new `%rowtype` variable named `job` collides with the existing `job` relation
  alias inside the same PL/pgSQL trigger function.
- Minimal correction: rename only the record variable to `owner_job`; preserve all locking and
  authority predicates, then rerun the identical two-test target.

## Second Stage A adjacency planner collision

- Observation: the first full focused run was 25/26; PostgreSQL selected the new endpoint-leading
  index for the pre-existing private-topology EXPLAIN that proves use of the full temporal index.
- Hypothesis: the unrestricted endpoint-leading index dominates the more selective private
  topology index even though its intended consumer is shared-scope Main/System/Operator traversal.
- Minimal correction: make the new endpoint-leading indexes partial for non-private scopes, keeping
  private and shared production shapes independently indexable and provable.

## Second Stage A job operation-digest fixture

- Observation: after SQL began recomputing the canonical job action digest, the direct-write
  missing-manifest fixture failed earlier with `MEMORY_GRAPH_JOB_TRANSITION_INVALID`.
- Hypothesis: its intentionally arbitrary digest no longer reaches the manifest completeness gate.
- Minimal correction: derive the fixture's exact canonical FAIL digest from its action fields; keep
  the event and transition otherwise unchanged so only the missing manifest remains under test.

## Second Stage A erased-key replay ambiguity

- Observation: an exact replay could be returned after key destruction, but a changed private
  semantic string with the same structural request shape could no longer be distinguished safely.
- Root cause: the erasable retrieval-key-derived semantic digest cannot be recomputed after its key
  is destroyed; retaining an unkeyed semantic digest would create a dictionary-testable privacy leak.
- Correction: compare a non-semantic structural request digest first, validate exact semantics while
  keys are live, and fail closed with `MEMORY_GRAPH_REPLAY_UNAVAILABLE` when protected semantic
  equality cannot be revalidated after erasure.

## Second Stage A proposal relation aggregate boundary

- Observation: the first positive proposal relation fixture failed with
  `MEMORY_SOURCE_AGGREGATE_MISMATCH` when it tried to project `node.proposal.created` into a
  conversation-scoped memory run.
- Root cause: proposal-created events correctly live on the proposal aggregate; private memory
  projection correctly forbids mixing that event with conversation-aggregate sources.
- Correction: use the proposal row's unique, authorized conversation `route_event_id` as the graph
  memory bridge. The row still binds that route to the proposal-created event, cited sources,
  affected state, and append-only pending/accepted status transitions.
## Final-cap fixture diagnosis (2026-08-10)

- Symptom: the new 100-request-plus-prior application RED stopped at
  `MEMORY_GRAPH_SEMANTIC_NOT_SOURCE_GROUNDED` before exercising the graph cap.
- Hypothesis: the fixture paired `new-${index}` with projected memories by array position,
  but projection result ordering is not an authority contract.
- Evidence: every projected memory already carries its authoritative value in `keywords`;
  the test reconstructed a different value from its result-array index.
- Correction: select the `new-*` value from each memory's committed keywords. No
  production behavior changed for this diagnosis.

- Symptom: the every-transition arbitrary-body RED stopped while creating its final
  transition with `MEMORY_GRAPH_JOB_IDEMPOTENCY_KEY_REUSED`.
- Hypothesis/evidence: the fixture reused `job-body-forgery:failed` for the traversal
  job and terminal transition even though transition keys are globally unique.
- Correction: give the terminal transition its own `job-body-forgery:terminal` key.

## Final outbox related-slice timing diagnosis (2026-08-10)

- Symptom: the exact T22 event-body-digest integration test reached Vitest's default
  5-second timeout at 5.02 seconds during the four-file PostgreSQL related slice.
- Hypothesis: shared disposable-PostgreSQL load, rather than an outbox/body authority
  regression, pushed an already near-boundary integration fixture over its default timeout.
- Evidence: the same exact test passed in isolation with all assertions in 4.88 seconds;
  the related run's other 132 tests passed.
- Correction: give this database integration test an explicit 20-second timeout. No
  production behavior changed for this diagnosis.

## Final outbox reassignment fixture diagnosis (2026-08-10)

- Symptom: the full-tuple reassignment RED stopped with `inconsistent types deduced
  for parameter $1` before reaching the outbox trigger.
- Root cause: the direct `INSERT ... SELECT` and tuple `UPDATE` reused event-ID
  parameters in UUID and JSON-text positions, leaving PostgreSQL's prepared-statement
  inference ambiguous.
- Correction: cast the cloned, reassigned, and source identifiers explicitly to UUID. No
  production behavior changed for this diagnosis.

## Stage B database-clock precision diagnosis (2026-08-10)

- Symptom: the first database-clock targeted run rejected the legitimate queued transition with
  `MEMORY_GRAPH_JOB_CLOCK_INVALID`.
- Hypothesis/evidence: PostgreSQL `transaction_timestamp()` retained microseconds, while the Node
  `Date` passed through the encrypted event and transition parameters retained milliseconds; the
  exact SQL equality check therefore compared different precision representations of the same
  database timestamp.
- Correction: define the canonical transition timestamp as the database-assigned
  `date_trunc('milliseconds',transaction_timestamp())` consistently in the default, application
  read, and direct-write trigger comparison. Caller time remains excluded from authority.

- Symptom: after the clock precision correction, the retry fixture reached
  `MEMORY_GRAPH_JOB_IDEMPOTENCY_KEY_REUSED`.
- Root cause: the test used `job-database-clock:retry` both for the traversal job (and therefore its
  ordinal-zero transition) and for the later retry transition; transition idempotency keys are
  intentionally global.
- Correction: give the retry transition a distinct `:retry-transition` key. No production behavior
  changed for this fixture correction.

## Stage B reconciliation-queue body-digest diagnosis (2026-08-10)

- Symptom: the oversized reconciliation preflight reached the new queue path but the authoritative
  manifest insert failed with `MEMORY_GRAPH_RECONCILIATION_JOB_MANIFEST_INVALID`.
- Root cause: the new canonical `memory.graph.reconciliation.queued` event type was not yet in the
  event store's T22 exact-body-digest allowlist, so its encrypted body row carried no digest for the
  manifest to bind.
- Correction: add that canonical queue type to the same exact-body-digest set as graph runs and
  background job transitions.

- Symptom: the now-successful oversized queue path used 635 queries, above the provisional test
  ceiling of 30.
- Root cause/evidence: the count is the existing bounded, input-linear protected-digest and source
  authority hydration for 101 candidates; the relation-persistence path itself was skipped. The
  pre-fix path performed tens of thousands of edge/source writes.
- Correction: use a proven 700-query ceiling for this 101-candidate preflight and enforce set-wise
  relation persistence independently; use a 1,000-query ceiling for the exact 5,150-edge
  synchronous boundary so its input hydration is included without admitting edge-linear writes.

## Stage B full-suite harness timeout (2026-08-10)

- Symptom: the first refreshed full-suite command reached the 600-second shell timeout without
  emitting a Vitest assertion failure; the wrapper terminated while pnpm/Vitest child processes
  were still briefly present.
- Evidence: the immediately preceding focused run passed 40/40 and related run passed 87/87;
  process inspection identified only the timed-out `pnpm test`/`vitest run` tree, and that tree then
  exited with no target processes remaining.
- Next controlled check: rerun the unchanged full suite once with a 900-second harness window. No
  production or test behavior is changed for this infrastructure timeout.

## Stage B resumable-state fixture diagnosis (2026-08-10)

- Symptom: the first existing oversized-queue target reached the new append-only queue successfully,
  then its assertion query failed with `column job.status does not exist`.
- Root cause: the hardened design deliberately removed mutable/permanently-`PENDING` status and
  zero cursor columns from the immutable request row; current status and cursor now come from the
  latest append-only transition through `memory_graph_reconciliation_job_current`.
- Correction: update only the fixture query to read the current-state view while retaining request
  estimates from the immutable job row. No production rollback to mutable queue state is made.

## Stage B maximum-work fixture ordering diagnosis (2026-08-10)

- Symptom: the first zero-edge 552,550-row work-budget target failed source grounding before the
  preflight with `MEMORY_GRAPH_SEMANTIC_NOT_SOURCE_GROUNDED`.
- Root cause: consolidation returns immutable memories in canonical content order, not the input
  fact-array ordinal; the fixture incorrectly paired returned memory ordinal with `predicate-N`,
  `value-N`, and its entity.
- Correction: derive each claim's numeric fixture identity from its persisted `predicate-N` keyword
  and use that identity for predicate, value, and entity assignment. Production grounding remains
  unchanged.

- Symptom: after grounding was corrected, the maximum-work fixture queued but reported 9,800
  `MENTIONS` edges instead of the intended zero-edge isolation.
- Root cause: all 100 memories came from one extraction run and their generated non-null graph
  entity IDs differ across the 50 semantic entities, which correctly authorizes directed
  cross-entity mentions (all ordered pairs except the two memories assigned to each entity).
- Correction: keep one fully authoritative 500-source extraction for the expensive source/body
  setup, then assign deterministic distinct extraction-run identifiers per entity with immutable
  triggers disabled only inside the isolated disposable fixture transaction. This isolates the
  preflight's zero-edge axis without changing production relation policy.

- Symptom: the first split-run fixture attempt failed `MEMORY_SOURCE_TEXT_MISMATCH` on its lead
  event.
- Root cause: the fixture reconstructed every event text with the common-source template, while
  each per-entity lead event has its own exact encrypted `Entity lead N.` text.
- Correction attempted during diagnosis: pass the common source events and exact lead event
  separately. The producer correctly rejected later overlapping projections, so the final fixture
  uses the isolated topology normalization above instead; production overlap protection is unchanged.

## Stage B focused-command routing diagnosis (2026-08-10)

- Symptom: the first post-batching focused stress command produced no focused assertion output and
  exceeded the 184-second shell window.
- Root cause: `pnpm test -- <file> -t <name>` passed a literal `--` through the package script as a
  Vitest filter. Database activity showed unrelated recall tests executing, and the process command
  line was `vitest run "--" ...`; this was an unintended full-suite run, not a product timeout.
- Correction: terminate only that identified task process tree and invoke the pinned runner as
  `pnpm.cmd exec vitest run <file> -t <name>` for exact focused routing. No production or fixture
  behavior is changed for this harness diagnosis.

## Stage B capacity-contract fixture diagnosis (2026-08-10)

- Symptom: the first full focused run after total-work preflight passed 42/43 tests; the exact
  capacity-contract assertion reported one additional received field.
- Root cause: the new synchronous work envelope intentionally publishes
  `maximumSynchronousMaterializationRows: 100000`, but the pre-Stage-B frozen object assertion had
  not yet included that required public bound.
- Correction: add the exact proven bound to the contract expectation. Production behavior and the
  already-green overflow stress tests are unchanged.

- Symptom: the corrected contract object exposed a second stale check in that same test requiring
  a mutable `resume_cursor` on the immutable job request row.
- Root cause: the resumable design stores cursor advancement in append-only transition rows and
  derives the current cursor from `memory_graph_reconciliation_job_current`; retaining a mutable
  request cursor would contradict the approved replay/immutability boundary.
- Correction: assert the durable transition `edge_offset` and `edge_source_offset` authority
  instead. No schema relaxation or mutable state is introduced.

## Stage B normalized-envelope arithmetic diagnosis (2026-08-10)

- Symptom: self-review found that the normalized queue tables accepted only 1,000 unique source
  events and 1,100 source sets even though every individual request field passed validation.
- Root cause: the original queue bounds used the alias/candidate counts instead of the hydrated
  envelope maxima. Two hundred requested-plus-prior candidates can each carry 500 distinct sources
  (100,000 unique source events), and 1,000 aliases plus 200 candidates can require 1,200 distinct
  source sets.
- RED: the exact capacity-contract/schema test failed because neither proven maximum was published
  and SQL retained the smaller ordinals/cardinality.
- Correction: publish both maxima and widen only the bounded normalized job source/source-set
  arrays, ordinals, and foreign-key ordinal columns to 100,000 and 1,200 respectively. The 100,000
  synchronous materialization budget is unchanged; oversized requests still queue before graph
  topology persistence.

## Stage B account-null action-envelope diagnosis (2026-08-11)

- Symptom: after the initial PUBLIC queue transition became valid, its first CLAIM still failed the
  transition envelope check and diagnostic output showed the stored action visibility was
  `OPERATOR` rather than `PUBLIC`.
- Root cause: the first minimal text patch matched the earlier background-job event builder, whose
  visibility line had the same original expression, instead of the reconciliation-job event
  builder. The reconciliation action therefore retained the old account-null fallback.
- Correction: restore the unchanged background-job visibility expression and apply scope-derived
  `PUBLIC`/`SHARED`/`OPERATOR`/`PRIVATE_ACCOUNT` visibility only to reconciliation actions. The
  temporary diagnostic branch is removed after confirming the exact stored mismatch.

## Stage B alternate-member timestamp diagnosis (2026-08-11)

- Symptom: the first sealed-member validator rejected the already-approved alternate caller key
  even though operation, request shape, and server-recomputed request digest were all exact.
- Root cause: it required the member timestamp to be at or after the job's observed timestamp, but
  deterministic fixtures may legitimately use a future domain `observedAt`; the alternate member
  uses the current database transaction clock and can therefore be earlier in domain time.
- Correction: accept only the immutable job's original timestamp or the millisecond-truncated
  database transaction timestamp. Operation, request shape, and server-derived request digest must
  still match exactly; arbitrary/conflicting mappings remain rejected.

- Symptom: after valid alternate membership passed, the existing arbitrary-body clone regression
  rejected at the new member validator instead of its later transition validator.
- Root cause: that hostile fixture deliberately wrote `request_digest=operation_key`, which is no
  longer an admissible membership digest; the new earlier rejection is the intended stronger
  boundary.
- Correction: update only the expected rejection to `MEMORY_GRAPH_RECONCILIATION_MEMBER_INVALID`.
  The forged transaction still rolls back atomically.
