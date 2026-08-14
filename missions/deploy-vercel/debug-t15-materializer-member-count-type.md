# Debug: T15 materializer member-count type
**Originated during:** mcax-execute T15 Stage A self-review
**Status:** fixed

## Symptom (one sentence)

Running the trusted `pnpm exec tsc --noEmit` after adding the materializer sole-member check returned `worker/hybrid/wake-server.ts(636,21): error TS2339: Property 'memberCount' does not exist on type ...`.

## Reproduction

1. Add the permission-role `memberCount === 1` validation and its database projection.
2. Run the trusted Node/pnpm `exec tsc --noEmit` command.

Result: TypeScript rejects the permission-role validator access.

## Hypotheses

- H1: The new readonly field was inserted into the adjacent login shape instead of the permission shape. Confirmed by direct inspection of `MaterializerRoleAuthority`: `login.memberCount` exists while `permission.memberCount` does not.
- H2: The SQL row projection omitted the field. Refuted because `permissionMemberCount` is present in both the selected row type and mapping.

## Root cause

The patch context matched the first adjacent `otherMemberships` field in `MaterializerRoleAuthority`, placing `memberCount` on `login` instead of `permission`.

## Fix attempts (counter)

1. Moved only the misplaced readonly field between the adjacent interface blocks: fixed.

## Regression test

File: `worker/hybrid/wake-server.ts`
Description: repository TypeScript compilation validates that the runtime validator and its authority type agree.
Pre-fix result: TS2339 at line 636.
Post-fix result: passing.

## Fix

`worker/hybrid/wake-server.ts` now declares `memberCount` on the permission-role authority shape used by the validator.

## Wider check

Trusted `tsc --noEmit`, focused hybrid-worker tests (14/14), both PowerShell AST parses, and `git diff --check` are green. The related T6/T7/T14 suite had already completed after the control-protocol production change with 160 passed and 3 skipped; the later edit only corrected this local type declaration.
