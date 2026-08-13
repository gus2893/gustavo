# Debug: T7 process isolation
**Originated during:** mcax-execute T7 Stage B
**Status:** escalated-to-prompt-update

## Symptom (one sentence)

The T7 runner can launch after an abort during asynchronous executable validation, cannot prove descendant termination when `taskkill` fails, and can accept or delete raced filesystem state at the schema boundary.

## Reproduction

### H1 — abort during executable validation

1. Delay trusted taskkill-path resolution.
2. Abort the request while resolution is pending.
3. Observe whether the configured child executable launches.

Result: RED. The fixture exited `0` and created its launch marker; the injected delayed resolver was never called by the broken boundary.

### H2 — descendant termination fallback

1. Launch a fixture parent that starts a grandchild scheduled to write a marker.
2. Inject taskkill exit code `1`.
3. Abort the parent and observe whether the grandchild marker appears.
4. Separately inject failure for both tree mechanisms and inspect the returned authority state.

Result: the real grandchild did not orphan under this host's surrounding process containment, so that observation alone was inconclusive. The dual-failure test was RED: the boundary returned a normal aborted result without `terminationFailed`, falsely leaving tree termination unproven.

## Hypotheses

- H1: `executeCodexProcess` checks `signal.aborted` before awaiting taskkill validation but does not recheck afterward. **Confirmed:** targeted test launched the fixture and returned exit code `0`.
- H2: Windows `child.kill()` cannot establish full descendant-tree termination after `taskkill` failure. **Confirmed by authority state:** when both tree mechanisms are injected to fail, the broken boundary reports no failure and cannot prove descendant termination. The host happened to contain the live fixture descendants, which does not satisfy the runner contract.
- H3: `lstat`/`realpath` followed by pathname `unlink` creates a cleanup TOCTOU window, and result acceptance lacks post-execute schema validation. **Confirmed:** an execute-time replacement was accepted before the fix.

## Root cause

Three independent authority gaps were present: abort was checked only before asynchronous OS-tool resolution; direct-child fallback could not prove descendant termination; and schema cleanup used an awaited pathname check followed by unlink while successful output lacked post-execute authority validation.

## Fix attempts (counter)

1. H1: inject trusted-path resolution, register abort authority before resolving it, and recheck immediately before spawn — fixed; targeted regression green.
2. H2: add a canonical fixed-script PowerShell descendant-first fallback and explicit dual-failure result.
   Result: targeted tests became green, but final review proved the one-time descendant snapshot can miss children created after the snapshot and helper termination itself was not proven.
3. H3: add post-execute authority validation and atomic private-claim cleanup.
   Result: targeted tests became green, but final review proved Windows mode `0700` is not a private DACL and the identity-check-to-unlink boundary remains replaceable.

Three fix attempts were exhausted. The design assumption that Node plus ad-hoc Windows helpers could supply process-tree and private-filesystem authority was rejected; `prompt-update-containerized-codex.md` replaces it with a container-runtime boundary.

### H3 — schema acceptance and cleanup races

1. Replace the runner schema from inside execute immediately before returning a valid result.
2. Replace it immediately before cleanup through a deterministic test hook.
3. Require fail-closed rejection and preservation of the unrelated replacement.

Result: RED. An execute-time replacement produced an accepted response. Post-fix, both replacements are rejected and preserved.

## Regression test

File: `tests/bridge/codex-cli.test.ts`

H1 pre-fix result: failing (`exitCode: 0` instead of `null`; child launched). Post-fix: passing.
H2 pre-fix result: dual failure returned no `terminationFailed`. Post-fix: fallback and dual-failure tests passing.
H3 pre-fix result: execute-time schema replacement accepted. Post-fix: execute/cleanup replacements rejected and preserved.

## Fix attempted before escalation

- `worker/hybrid/codex-runner.ts`: registered pre-spawn abort authority, added two bounded trusted Windows tree terminators, post-execute schema revalidation, and synchronous identity-bound claim cleanup.
- `tests/bridge/codex-cli.test.ts`: added deterministic H1-H3 regressions.

## Wider check

`pnpm vitest run tests/bridge/codex-cli.test.ts` -> 14 passed. `pnpm exec tsc --noEmit` -> exit 0. Both used the trusted Node 24 runtime.

## Lessons / design implications

Process isolation must treat abort registration, descendant termination, and temporary-file ownership as explicit authorities. Host process containment and best-effort deletion are not evidence that those authorities held.

### Design challenge

The approved direct-Windows-spawn design required guarantees unavailable from Node's child-process API, `taskkill`, and pathname cleanup. The revised approved design gives an ephemeral Docker container the process-tree/workspace boundary, adds an internal independent timeout, and disables further claims if exact container termination cannot be proven.
