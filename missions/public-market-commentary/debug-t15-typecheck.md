# Debug: T15 type check
**Originated during:** mcax-execute T15
**Status:** fixed

## Symptom (one sentence)

After the focused T15 suite passed 18/18, `pnpm exec tsc --noEmit` was expected to pass but reported three generic-constraint errors for database row interfaces and one invalid `any`-to-`never` exhaustiveness assignment.

## Reproduction

1. Use bundled Node.js 24.14.0 and pnpm 11.16.0.
2. Run `pnpm exec tsc --noEmit` after the first focused green.

Result: TypeScript exited 1 at `ledger.ts:230`, `ledger.ts:248`, `ledger.ts:317`, and `projection.ts:290`.

## Hypotheses

- H1: The local row shapes do not explicitly satisfy `EventDatabase.query<Row extends Record<string, unknown>>`. Confirmed by the three TS2344 diagnostics naming that exact missing index signature.
- H2: The reducer's runtime fail-closed default receives an `any` value after the discriminated-union switch and therefore cannot be assigned to `never`. Confirmed by TS2322 on the exhaustiveness-only local binding.
- H3: The active profile variable inferred T12's v1 identifier as a string-literal type even though replay intentionally supports later published profile UUIDs. Confirmed by TS2322 after adding the version-chain replay assertion.
- H4: The cleanup planner's drop closure no longer retained the outer optional-server narrowing. Confirmed by TS18048 after the authorized helper cleanup fix.

## Root cause

The database row interfaces described named fields but did not extend the generic repository's required record shape. Separately, the switch default tried to add compile-time exhaustiveness through a local `never` assignment even though the runtime trust-boundary value can be outside the declared union.

## Fix attempts (counter)

1. Extend only the database row interfaces with `Record<string, unknown>` and keep the default throw while removing the invalid `never` assignment: fixed the original four diagnostics.
2. Explicitly type the active profile variable as `string` so later profile UUIDs remain valid: fixed the follow-up literal-inference diagnostic.
3. Bind the optional schema admin once before planning cleanup actions and use that explicit precondition in the drop closure: fixed the cleanup-planner diagnostic.

## Regression test

File: `tests/challenge/ledger-replay.test.ts`
Description: compiles the typed repository calls and exercises the reducer's fail-closed behavior through the focused suite.
Pre-fix result: focused runtime tests green, TypeScript red.
Post-fix result: focused suite and TypeScript green.

## Fix

- `lib/server/challenge/ledger.ts`: make query row interfaces satisfy the established repository generic.
- `lib/server/challenge/projection.ts`: preserve the unsupported-event exception without an invalid exhaustiveness assignment.

## Wider check

Focused T15 suite → 32/32; full suite → 21 files and 325/325; TypeScript, Next production build, frozen install, and `git diff --check` → exit 0; active Gustavo PostgreSQL/`pg_ctl` process count → 0.
