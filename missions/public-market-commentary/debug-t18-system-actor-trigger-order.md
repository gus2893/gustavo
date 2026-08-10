# T18 SYSTEM-authority SQL regression fixture

## Symptom

After the application regression turned green, the new direct-SQL SYSTEM-as-Main regression received `THOUGHT_EVENT_AUTHORITY_INVALID` rather than the named `thought_type_actor_authority_check` rejection.

## Evidence

The fixture reused an ordinary source event as `thought_records.event_id`. PostgreSQL executes the row's `BEFORE INSERT` authority trigger before evaluating table check constraints, so the unrelated event failed first.

## Root cause

The production constraint was correct; the test fixture did not satisfy the earlier event-authority boundary needed to isolate actor/type authority.

## Fix

Create a real SYSTEM-authored `thought.recorded` event, encrypted body, and outbox inside the same outer transaction, then attempt the direct ThoughtRecord insert. The event authority trigger passes, the named actor/type constraint rejects, and the transaction rolls the temporary event back.
