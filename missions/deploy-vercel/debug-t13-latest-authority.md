# Debug: T13 latest-market authority
**Originated during:** mcax-execute T13
**Status:** fixed

## Symptom (one sentence)

Running `vitest ... -t "permits cryptographic erasure"` should delete the account-scoped latest-market key after a reader releases its lock, but PostgreSQL rejected the key's `ON DELETE SET NULL` action with `MARKET_LATEST_WINDOW_CONFLICT`.

## Reproduction

1. Store one encrypted AAPL latest row.
2. Load it through the authorized latest-market reader.
3. Delete the `market-latest:<account-id>` aggregate data key.

Result: the generated foreign-key update that set `market_latest_quotes.data_key_id` to `NULL` entered the equal-window conflict branch in `validate_market_latest_quote()` and failed.

## Hypotheses

- H1: the foreign-key action changes only `data_key_id`, but the equal-window semantic guard treats every non-identical row as a conflicting provider replay. Confirmed by PostgreSQL's error context, which showed `UPDATE ONLY ... market_latest_quotes SET data_key_id = NULL`, and by the trigger's unconditional same-window conflict branch.
- H2: a live reader retained a key lock and caused the failure. Refuted because the load transaction had completed, and the failure was the trigger's explicit semantic error rather than a lock timeout.

## Root cause

`market_latest_quotes.data_key_id` intentionally uses `ON DELETE SET NULL`, matching the repository's cryptographic-erasure pattern for encrypted event bodies. The new equal-window replay guard correctly rejected semantic rewrites but did not distinguish the single permitted privacy transition: an FK-driven non-null-to-null key reference with every other column byte-for-byte unchanged.

## Fix attempts (counter)

1. Copy the proposed row, restore its old `data_key_id`, and permit the update only when that reconstructed row is identical to the old row: fixed the failure without allowing a price, status, timestamp, context, ciphertext, or identity rewrite.

## Regression test

File: `tests/market-data/finnhub-poller.test.ts`

Description: stores and reads an encrypted latest quote, deletes its aggregate key after the reader transaction ends, proves only the key reference is erased while ciphertext remains opaque, and proves later decryption fails closed.

Pre-fix result: failing with `MARKET_LATEST_WINDOW_CONFLICT`.

Post-fix result: one selected test passed, zero failed.

## Fix

- `db/migrations/0022_hybrid_deployment.sql`: allow only the exact FK key-erasure shape before evaluating equal-window replay conflicts.
- `tests/market-data/finnhub-poller.test.ts`: preserve the key-erasure regression.

## Wider check

Commands run after the fix:

- focused key-erasure test: pass.
- full Finnhub poller plus legacy observation-policy files: 52/52 passed, exit 0.
- focused bridge migration/latest-authority slice: 9/9 passed, exit 0.
- full bridge file: 106/106 assertions passed; its separate known fixed-30-second cleanup ceiling is recorded in `debug-t13-test-cleanup.md`.
- TypeScript no-emit check: pass.

### Secondary migration-authority regression

The first wider `observation-policy` run failed because T13 eagerly inserted all 95 catalog rows into the pre-existing `market_instrument_allowlist`; the existing policy fixture correctly owns its own AAPL authority setup and its plain insert then hit the primary-key constraint. The confirmed hypothesis was that catalog topology and licensed-observation authority are separate layers: T13 may validate the fixed catalog without globally claiming every legacy allowlist row at migration time. The failing existing test was the RED. The fix removed eager migration seeds and made `materializeMarketObservation` idempotently establish only the exact consumed symbol and fixed Finnhub personal-use source inside the same transaction, preserving disabled/conflicting authority because `ON CONFLICT` performs no update. The previously failing selected observation-policy test then passed 1/1 with exit 0.

### Concurrent replay regression

A timing-only concurrent replay initially passed, so the test was strengthened with a transaction barrier that held the first materializer immediately after its empty binding read while allowing the second materializer to commit. The deterministic RED then failed with `duplicate key value violates unique constraint "market_observation_consumptions_pkey"`: after the second transaction committed, the first acquired the latest-version row lock but did not re-read the now-durable binding before inserting. The minimum fix rechecks the exact command binding after the latest row lock and validates the bound observation through the same replay projection. The deterministic selected test then passed 1/1 with exit 0 and retained exactly one binding and one observation.

### Stage A authority-lifetime regressions

Stage A review found that the first account check locked only the account key and omitted account status and entitlement expiry. Deterministic transactions holding an uncommitted account suspension or entitlement revocation both crossed that weak check and returned decrypted price data; an entitlement expiring after the check also returned plaintext. The fix selects the one `ACTIVE` account joined to its exact active, unrevoked, unexpired entitlement using `clock_timestamp()`, orders both authority rows, and holds `FOR SHARE` locks on both. Database-clock rechecks run before protected key/body work and again immediately before unwrapping/decryption or observation materialization. The focused authority group passed 4/4, and neither rejected race reached a key or body query.

The reader also took an unlocked metadata snapshot and later locked a newer protected row without comparing versions. A deterministic newer-success writer produced an impossible RED DTO containing price `226.20` with the prior window, timestamps, and context digest. The fix compares every safe metadata/version field with the locked protected row before decryption and fails with `MARKET_LATEST_VERSION_CHANGED` on any skew. The selected regression passed 1/1.

Finally, the relaxed SUCCESS shape needed for FK-driven cryptographic erasure also permitted a direct SUCCESS insert with no key and an ordinary `UPDATE ... SET data_key_id=NULL`; both REDs resolved successfully instead of rejecting. The trigger now requires a scoped key for every SUCCESS insert and ordinary update. It permits NULL only when the FK `ON DELETE SET NULL` action invokes the trigger, the old key was non-null, and reconstructing that one field makes the proposed row byte-for-byte identical to the old row. Direct insert/update tests now reject with `MARKET_LATEST_KEY_REQUIRED`, while genuine key deletion still leaves opaque ciphertext, clears only the key reference, and makes later reads fail closed. The focused pair passed 2/2; the migration authority slice passed 9/9.

### Stage B binding and cleanup regressions

The first erasure fix used RI trigger nesting depth as part of its proof, but an unrelated nested trigger could imitate the exact key-null update while the parent aggregate key still existed. That RED committed and erased the reference. The gate now additionally proves the old parent key is absent in the current transaction, along with RI nesting and the exact unchanged-row reconstruction. The hostile nested trigger is rejected, and genuine FK erasure remains green.

Latest-market writers originally serialized first-key creation only with `market-latest-writer:<aggregate>`, while `appendEvent` uses the repository-wide `aggregate-key:<aggregate>` advisory. A deterministic barrier let event append create and commit the shared aggregate key while the latest writer still believed no key existed; one operation then lost the uniqueness race. The latest writer now takes the exact canonical aggregate-key advisory after account authority and its private writer serializer, before key lookup/body locking. Both operations pass and reference the single durable key.

An injected `aggregate_data_keys` insert rejection also proved that `createMarketKey` lost its newly generated plaintext buffer before the outer cleanup could own it. The insertion is now wrapped locally: any construction or database rejection zero-fills the generated data key before rethrowing. The captured-buffer regression verifies every byte is zero before the rejection reaches the caller.

Finally, a consumption binding named only observation identity and latest context. Five direct-SQL REDs committed observations with forged price, timestamps, license/raw reference, feed/delay/session, or redistribution, and replay accepted a deliberately corrupted stored price. The first attempted fix added a caller-supplied complete-observation digest; those focused tests passed 6/6, but the next adversarial pass proved the writer could forge the digest and row together. That digest approach was removed and superseded by the approved separate-role boundary below.

### Stage B role-boundary resolution

A follow-up adversarial review correctly showed that `observation_digest` was caller-authored. The independent RED used the ordinary database handle to compute a digest for price `999.99`, insert the matching binding and observation together, and commit successfully. A second RED showed that `.000001` and `.000002` timestamps collapsed to the same millisecond digest and also committed. A corrupted stored observation was rejected only by rehashing the stored row; query-order evidence showed replay never locked or decrypted the named latest version.

Repository inspection found no reusable database role, RLS, or `SECURITY DEFINER` authority that could distinguish legitimate Node materialization from an ordinary direct writer. PostgreSQL cannot derive the expected price from the AES-GCM latest body because unwrap/decryption remains application-side. The resulting one-identity boundary was therefore a design blocker, not a trigger bug.

The approved prompt update chose the separate-role option. Migration 0022 now creates the fixed `gustavo_market_materializer` role as `NOLOGIN NOINHERIT`, grants it only the schema/table access and row-lock columns required for this transaction, and rejects every binding insert unless the exact `current_user` is that role. It does not grant membership to the ordinary application/schema identity. The separately credentialed local login and transaction-scoped role switch are deployment/runtime responsibilities in the regenerated downstream tasks; the credential is never a Vercel setting and materialization never falls back to the ordinary handle.

The binding no longer contains a caller-supplied observation digest. Its trigger copies the command body digest, request digest, and exact database-owned latest window, data-key reference, source time, receipt time, and context authority while holding the latest row. `materializeMarketObservation` verifies the role before account or protected reads. On both first execution and replay it reauthorizes the account, locks the aggregate key and exact current latest row, decrypts the latest body, and compares price, timestamps, provider/license/raw reference, feed/delay/session/redistribution, asset class, account/symbol/context/command, and binding version before returning. If the mutable latest row has advanced, replay fails closed rather than accepting a different version.

T13 Finnhub latest and observation timestamps are constrained to exact milliseconds. The sub-millisecond direct insert now fails with `MARKET_OBSERVATION_TIMESTAMP_PRECISION_INVALID`; legacy non-Finnhub observations retain their existing precision behavior.

The corrected-boundary focused run passed 4/4: wrong/missing materializer identity failed, the role-scoped path succeeded, an ordinary matching binding-plus-observation forgery failed, sub-millisecond authority failed, and corrupted replay evidence included both latest-key and latest-body locks. Additional exact-version/semantic focused coverage passed 6/6.

### Corrected-boundary privacy and retention regressions

The first database-owned binding shape gave `latest_window_id` a foreign key to the seven-day poll-summary table. The existing bounded-authority truncate regression then failed before its immutability trigger with `cannot truncate a table referenced in a foreign key constraint`. That also exposed a retention bug: an append-only consumed observation could retain old poll summaries indefinitely. The binding only needs to copy the validated window identity, not own poll-summary lifetime, so the fix retains the bounded canonical window-text check and removes that FK. The focused existing regression passed 1/1, followed by the complete migration slice at 11/11.

The binding's copied data-key reference intentionally uses `ON DELETE SET NULL`, but its blanket immutability trigger initially rejected the FK action with `IMMUTABLE_MARKET_OBSERVATION_CONSUMPTION`. The new RED materialized one observation and then deleted the exact aggregate key. The trigger now permits only the nested non-null-to-null transition when the parent key is absent and reconstructing that single field makes the proposed row identical to the old row. A direct key-null update while the parent exists remains rejected. The selected privacy regression passed 1/1; the binding becomes nondecryptable while the append-only observation remains intact and replay fails closed.

### Final Stage B role and write-scope hardening

The first role migration normalized only `NOLOGIN NOINHERIT`. A hostile pre-existing role retained `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, and `BYPASSRLS`; a role made a member of an unrelated parent also passed migration. Independent REDs reproduced both. Migration now forces every dangerous attribute off, clears any password, sets connection limit zero, and rejects any outgoing membership with `MARKET_MATERIALIZER_ROLE_MEMBERSHIP_INVALID`. The membership query intentionally examines only rows where the materializer is the member: a local login granted the materializer role is an inbound membership and remains permitted. Tests prove hostile attributes normalize, outgoing membership rejects, and inbound login membership survives. Exact table/column ACL tests also prove the role has no schema create authority or PUBLIC table grants.

The role needed narrow `INSERT` access to the existing allowlist, source, and observation tables, but that ACL initially allowed arbitrary catalog symbols, arbitrary provider/license rows, and unbound non-Finnhub observations. Three direct role-scoped REDs committed those rows. A further self-review RED connected as an inbound member login without `SET ROLE` and proved that inherited table privileges retained the login as `current_user`, bypassing an exact-role-only auxiliary trigger. The shared scoped-writer predicate therefore covers the exact permission role plus any non-superuser role that is its member; PostgreSQL superusers are excluded so existing schema-owner fixtures retain their intended legacy behavior. Role-specific triggers now allow only a symbol and matching asset class from the frozen catalog, the exact licensed `finnhub` / `finnhub-free-personal` / `ACCOUNT_ONLY` source, and a Finnhub observation that reaches the existing exact consumption-binding guard. Ordinary legacy writers retain their pre-existing behavior. The focused arbitrary-write group passes, and the older observation-semantic fixtures establish their forged sources through the ordinary writer so the independent observation guard continues to reject timestamps, license/raw reference, feed/delay/session, and redistribution with its original safe code.

Finally, two distinct valid decision commands could race to consume the same account/symbol/context. The loser leaked the raw unique-constraint name. A deterministic barrier RED reproduced it. After acquiring the latest-row lock, materialization now queries by both command identity and exact latest-version identity; a binding owned by another command returns the stable `MARKET_LATEST_VERSION_ALREADY_CONSUMED` error before insert. The regression retains exactly one binding and one observation without PostgreSQL details.

Final corrected-boundary verification: focused final hardening passed 9/9; full market plus legacy observation policy passed 65/65; the focused migration authority slice passed 11/11; focused privacy inventory/erasure passed 2/2; TypeScript no-emit and `git diff --check` exited zero; owned process and temporary-directory residue were both zero.

## Lessons / design implications

T13's plan says an "existing decision command" must name the exact latest version, but the repository had no account-scoped command with that pre-observation relationship. The approved narrow interpretation is a pre-existing encrypted event with one fixed contract: aggregate `market-latest:<account-id>`, account ownership, `SYSTEM` actor `gustavo-decision-orchestrator`, type `market.observation.consumption.requested`, `PRIVATE_ACCOUNT` visibility, `decision-window-policy-v1`, and exact body `{ symbol, latestContextDigest }` with no extra fields. Materialization does not create this command. A body-free binding row records only command/version/observation identifiers and digests so SQL can reject observations without durable provenance without creating a parallel plaintext command store.
