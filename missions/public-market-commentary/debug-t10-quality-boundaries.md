# Debug: T10 privacy, disposition, retry, and phase boundaries

**Originated during:** mcax-execute T10 Stage B review
**Status:** fixed

## Symptom (one sentence)

Four independent Stage B probes showed that authorized private text outlived revocation, a Main `NO_PAPER_TRADE` could win as `MAIN`, alternate evaluation retry keys leaked a uniqueness error, and direct SQL could start or extend evaluation outside the intended phase authority.

## Reproduction

1. Submit a contender whose proposed change is separately authorized raw chat text; inspect its event, revoke authorization, and request the evaluator packet again.
2. Give a `NO_PAPER_TRADE` Main baseline a passing score with no contenders.
3. Replay a completed evaluation with identical content but a different idempotency key.
4. Insert an invalid evaluation batch directly and attempt contender intake after a score/batch exists.

Pre-fix results: raw text was copied into the contender event, Main won despite its no-action disposition, the retry reached a duplicate-score constraint, and the SQL phase boundary accepted invalid or late writes.

## Hypotheses

- H1: contender hydration no longer consulted T9 disclosure state after the first copy. Confirmed.
- H2: winner selection received only scores/gates and therefore could not distinguish a thesis from `NO_PAPER_TRADE`. Confirmed in both TypeScript and SQL.
- H3: evaluation replay looked up only the same idempotency key, not whether the window already had a selection. Confirmed.
- H4: insert triggers checked final selection but did not lock and enforce the evaluation-batch phase. Confirmed.

## Root causes

- Privacy state was materialized as plaintext instead of referenced through its revocable authority.
- Disposition was absent from numerical selection inputs and SQL fallback selection.
- Closed-window detection occurred indirectly through immutable/unique constraints.
- Candidate, batch, score, and selection writes lacked one shared row-lock phase boundary; batch inserts also lacked independent provenance validation.

## Fix attempts (counter)

1. Added the four focused regressions; privacy and disposition failed immediately, then later probes became visible after those were fixed.
2. Stored only `[AUTHORIZED PRIVATE TEXT]`, use metadata, and a digest commitment; evaluator reads now resolve through the live proposal authorization. Initial hydration failed because the parsed null digest was omitted from the recomputed commitment; preserving the canonical null field fixed integrity checks.
3. Added actionable disposition to pure selection and the SQL fallback, plus explicit closed-window replay semantics.
4. Added row-locked SQL phase validation and batch provenance validation. The invalid-causation fixture initially used a nonexistent event and hit the event foreign key; changing it to an existing but incorrect cause isolated the intended provenance boundary.

## Regression tests

File: `tests/orchestration/evaluator-rubric.test.ts`

Coverage now proves plaintext exclusion from the contender event, live evaluator resolution, post-revocation denial, `NO_PAPER_TRADE` preservation, exact replay, conflicting replay, stable alternate-key closure, invalid direct batch rejection, immutable candidates/scores/batches, and late contender rejection after concurrent evaluation begins.

## Fix

T10 now stores only revocable disclosure references/digests, carries disposition into selection, detects completed windows before writing, and serializes every SQL phase transition on the decision-window row with independently validated evaluation-batch provenance.

## Wider check

Final focused 4/4 and full 212/212 tests passed; strict TypeScript, the production build, frozen install, diff check, and zero-process audit passed. Independent spec and quality reviews both returned PASS.
