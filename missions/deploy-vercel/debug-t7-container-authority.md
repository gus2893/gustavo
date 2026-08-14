# Debug: T7 container authority
**Originated during:** mcax-execute T7 Stage B
**Status:** fixed

## Symptom (one sentence)

The T7 Stage B review found that the fixed Codex invocation does not disable model tools, `docker run --rm` can erase lifecycle evidence before the controller proves ownership and termination, reconciliation does not require successful kill/remove helpers, and the Docker executable is derived from mutable ambient installation state.

A Stage B re-review additionally found that `tools.view_image` was not explicitly disabled, launch ownership began after asynchronous executable validation, reconciliation ignored the inspected lifecycle state, and an unsettled create helper could be mistaken for a proven never-created container after one absent inspection.

A final Stage A review found that a terminated create's boolean lock could be cleared by an immediate empty label list even though Docker could still materialize that exact named container later.

The approved Docker-singleton prompt update then invalidated the attempted time-window fix: no finite delay or absence sample can prove an interrupted daemon create will not materialize later.

The approved host-lease prompt update identified one remaining boundary: Docker's fixed name serializes create, but separate worker processes could still inspect or reconcile the singleton while another process owned an unsettled lifecycle promise.

## Reproduction

1. Run the focused tool-configuration regression in `tests/bridge/codex-cli.test.ts`.
2. Run the focused create/start lifecycle and helper-failure regressions in the same file.
3. Run the focused explicit-executable regression with hostile `PATH` and `ProgramFiles`.

Result before the fix: the exact argv lacked fixed tool-off configuration, used attached `docker run --rm`, had no explicit remove authority, cleared reconciliation after kill exit 1, and did not require a recorded executable input.

## Hypotheses

- H1: Codex tools remain available because `--ignore-user-config` is not followed by fixed feature, web, history, and feedback overrides. Outcome: confirmed by the missing exact argv and fixed; the pinned CLI accepted the overrides and reported every tool feature false.
- H2: `docker run --rm` makes exact post-exit ownership and deletion proof impossible because the runtime may remove evidence before inspect. Outcome: confirmed by the stale argv and fixed with create/inspect/wait/start/inspect/remove authority.
- H3: reconciliation can clear lockout after unsuccessful helpers because kill/remove exit codes are not both authoritative. Outcome: confirmed by kill exit 1 resolving `{ reconciled: true }`; fixed by requiring both helpers and absence proof.
- H4: Docker CLI authority is ambient because production derives it from `ProgramFiles` instead of requiring the owner-recorded absolute path. Outcome: confirmed by the missing required input; fixed with owner-recorded absolute path validation and PATH-free spawn.
- H5: `view_image` remains model-visible because it is a `tools` setting rather than a feature setting. Outcome: confirmed by the missing exact argv; fixed with `tools.view_image=false`, accepted by the pinned CLI without configuration errors.
- H6: two launches can concurrently validate the executable because `launchActive` is claimed after the resolver await. Outcome: confirmed when both delayed resolvers entered and the test timed out awaiting a busy result; fixed by synchronous claim plus pre-await abort listener/timer and post-resolver recheck.
- H7: reconciliation cannot safely apply one kill sequence to every state. Outcome: confirmed when stale created/exited containers were killed and dead/removing containers were touched; fixed with created/remove, exited/wait+exit comparison+remove, running/paused/restarting wait-before-kill, and dead/removing fail-locked branches.
- H8: one absent inspection does not prove an aborted create never settled later. Outcome: confirmed when an unsettled helper returned `CODEX_ABORTED` and left launches unlocked; fixed by requiring a settled numeric nonzero create result plus post-settlement absence for never-created proof.
- H9: a numeric create-helper exit does not distinguish a natural daemon rejection from a helper process killed by host abort while the daemon request may still complete. Outcome: confirmed when a terminated helper returned exit 1 plus one absent inspection and the runner returned ordinary abort unlocked; fixed with mandatory `NATURAL` versus `TERMINATED` completion provenance.
- H10: a boolean lock does not preserve enough authority to distinguish an ordinary stale lock from one specific terminated create still inside Docker's settlement race. Outcome: confirmed when immediate empty list/inspect results cleared the lock before the fake daemon exposed the late exact container; the initial bounded-delay mitigation was rejected by prompt update because delayed daemon completion is unbounded.
- H11: randomized names, sampled absence, and separate run/reconcile booleans cannot supply cross-process serialization or retain authority after a bounded promise is abandoned. Outcome: confirmed by five REDs covering fixed name/ID binding, independent module collision, process-restart cleanup, concurrent reconciliation, and unsettled execution; fixed with Docker's one singleton name, immutable-ID lifecycle calls, a synchronous owner token, and settlement-retained ownership. A live Docker 20.10 fixture additionally showed collision status varies (exit 1 here rather than 125), so exact existing singleton identity—not a client-specific code—is the authority.
- H12: the public `execute` callback lets a caller bypass Docker entirely and self-assert termination/removal flags. Outcome: confirmed by source and type REDs showing `execute` in the public input plus a runtime bypass; fixed by removing the type, option, and branch, rejecting an own `execute` property at runtime, and converting all tests to injected Docker lifecycle controllers.
- H13: the in-process owner token does not serialize separate worker processes, so a second process can enter Docker inspection/reconciliation while the first process still owns an unsettled lifecycle. Outcome: confirmed by four REDs for run contention, reconciliation contention, crash/release recovery, and timeout settlement; fixed by exclusively binding `\\.\pipe\gustavo-codex-runner-v1` before the first Docker action and holding it until every retained lifecycle promise settles. A direct Node 24 sanity check proved a second Windows bind fails with `EADDRINUSE`.

## Root cause

Four authority gaps were independently present in `worker/hybrid/codex-runner.ts`: the fixed CLI omitted tool-off overrides; attached `run --rm` combined execution and deletion so the host could not inspect and explicitly remove exact state; reconciliation ignored the kill result and had no remove helper; and executable selection was derived from mutable ambient state. Live Docker additionally showed that `docker wait` on a merely created container returns exit 0 immediately, so the pre-start registered wait operation must hold until exact state leaves `created` before invoking Docker wait.

The re-review showed the same boundary must own asynchronous setup and incomplete helper settlement: the claim/abort timer must exist before executable resolution, reconciliation must branch on exact state and compare exited codes, and only a settled nonzero create helper can combine with absence to prove no container was created.

The Docker-singleton prompt update identified the final root: a sampled-absence recovery protocol cannot close an interrupted daemon request. The durable authority must instead be Docker's fixed-name uniqueness, while the host binds all post-create actions to the returned immutable ID and keeps its synchronous owner until every abandoned lifecycle promise settles.

That daemon authority still needs a host-side cross-process exclusion boundary. The in-memory owner prevents overlap only inside one module instance; the fixed named-pipe listener supplies process-wide ownership and its release is coupled to the same retained-promise settlement authority.

## Fix attempts (counter)

1. H1 fixed argv overrides: focused unit and actual pinned-CLI feature proof passed.
2. H4 fixed recorded executable authority: hostile `PATH` and `ProgramFiles` regression passed.
3. H2 replaced attached run lifecycle: unit regressions passed; first live fixture exposed Docker wait-on-created returning 0, and the same H2 fix was completed by delaying the registered wait helper until state left `created`. Live proof then passed with wait exit 137 matching attached start.
4. H3 required successful kill/remove plus stopped/absence proof: focused regressions passed.
5. H5 added the separate `tools.view_image=false` setting: exact argv and pinned CLI parsing regressions passed.
6. H6 moved claim and abort authority before the resolver await: concurrent and abort-during-resolution regressions passed.
7. H7 made reconciliation state-aware and added exact exit-code authority: created/exited/running/dead/removing regressions passed.
8. H8 required settled numeric create-helper evidence and made polling exhaustion fail closed: delayed-create and rejection regressions passed.
9. H9 propagated whether raw helper termination was ever initiated: only natural completion can participate in never-created proof; terminated completion remains locked for exact-name reconciliation.
10. H10 persisted terminated-create identity and a bounded settlement delay: targeted tests passed, but design review proved the delay could never establish authority and escalated to prompt update.
11. H11 replaced the invalid delay model after prompt approval: fixed-name/ID/mutex REDs passed; default and live Docker suites passed, including real name collision and descendant teardown.
12. H12 removed the generic execution escape hatch: source/runtime/type regression passed, and every former shortcut test now proves results through create/inspect/wait/start/remove controller authority.
13. H13 added the exclusive fixed Windows named-pipe lease: run/reconcile contention performs zero Docker calls, a new process can reconcile after lease release, and timeout retains both the in-process owner and host lease until the underlying lifecycle settles. Live fixtures now preflight singleton absence, record identity only after successful create plus exact ID/name/image/label validation, and cleanup only that immutable ID, so a failed create can never delete an incumbent.

## Regression test

File: `tests/bridge/codex-cli.test.ts`

Description: exact tool-off argv, create-before-start lifecycle, fast-exit/abort cleanup, reconciliation helper authority, explicit Docker path, and real Docker descendant teardown.

Pre-fix result: four focused failures reproduced the missing config, ambient executable, attached run, and ignored helper status.

Post-fix result: all 40 default regressions and all three opt-in Docker cases pass.

## Fix

- `worker/hybrid/codex-runner.ts`: requires a canonical owner-recorded Docker executable; holds the fixed `\\.\pipe\gustavo-codex-runner-v1` host lease before Docker work and through actual promise settlement; uses the fixed `gustavo-codex-singleton-v1` daemon name; binds post-create lifecycle commands to the returned immutable ID; exposes no generic execution callback; uses fixed tool-off Codex configuration; splits create from prompt-bearing start; proves exact ID/name/image/labels/state, matching wait/start exit, explicit removal, and absence; and never absence-unlocks an interrupted create.
- `tests/bridge/codex-cli.test.ts`: covers hostile executable discovery, exact CLI configuration, fixed-name/ID authority, cross-process lease contention/release, cross-instance collision, restart cleanup, exclusive run/reconcile ownership, unsettled execution, fast exit, create/abort races, wait-before-kill, helper failures, incumbent preservation, and exact-ID-only live pinned-CLI/descendant/singleton behavior.

## Wider check

Node 24 default tests report 40 passed and 3 opt-in skipped; all 43 tests, including the three opt-in Docker cases, pass when enabled. TypeScript and whitespace checks are recorded in the task handoff.
