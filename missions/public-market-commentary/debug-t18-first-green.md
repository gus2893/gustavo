# T18 first-green boundary

## Symptom

The first Node 24 focused run passed seven database behavior tests but failed the source-purity assertion, and `tsc --noEmit` rejected the event body as `JsonValue`.

## Evidence

- The purity regular expression matched only the stable error identifier `HIDDEN_REASONING_FORBIDDEN`; no hidden reasoning field, storage path, or disclosure existed.
- TypeScript identified readonly claim/reference arrays as incompatible with the existing mutable `JsonValue[]` event-store contract.

## Root cause

The source guard was broad enough to flag its own defensive error taxonomy. Separately, the validated frozen input snapshot was passed directly across a mutable JSON type boundary.

## Fix

- Rename the stable rejection to `THOUGHT_REASONING_DISCLOSURE_FORBIDDEN` so the source guard continues to prohibit hidden-trace storage identifiers without rejecting a disclosure-prevention error.
- Build a fresh JSON body with copied mutable arrays and objects at the event boundary, preserving the frozen validated input and atomic encrypted-event behavior.

## Verification

Rerun the focused ThoughtRecord suite and strict TypeScript check under the bundled Node 24 runtime.

## Self-review integrity correction

The first green also showed that immutable child rows did not prevent a later direct-SQL insert from extending an already committed thought graph. A focused regression resolved instead of rejecting. The record now declares exact claim/source/evidence/counterevidence counts; immediate ordinal bounds and deferred exact-count checks seal the complete graph while retaining transaction-local insert ordering.

The Stage A atomicity review then proved the reverse orphan case: a bare `thought.recorded` event could commit first and be projected later. A deferred constraint on the event side now requires the matching complete graph in the same transaction, while the existing thought-side constraint continues to reject a projection without its authoritative encrypted event/body/outbox.

The Stage B security review identified three further boundaries. Private writes now resolve an active account/Node/open-conversation ownership graph in both app and SQL, and use the conversation as the encryption aggregate. State references now resolve against durable Main, Node-event, Challenge-ledger, or Conversation-message versions; unsupported import state fails closed. Finally, private rationale/claim/request digests are omitted from immutable plaintext rows. The encrypted body carries the idempotency digest and a random erasure nonce, so exact retries work while key destruction removes the comparison material and salts the event integrity document against offline text guessing.

The final quality pass pinned MAIN_BRAIN authorship to the repository's canonical `gustavo-main` identity in app and SQL. It also replaced global caller-key idempotency with an aggregate/account/actor/key scope used consistently by the PostgreSQL uniqueness constraint, advisory lock, duplicate lookup, and encrypted event idempotency key. An authorized second account can now use the same human-readable key without selecting or decrypting the first account's body.

The final spec audit distinguished canonical authorship from mechanical system work: `MAIN_POSITION`, `MAIN_BROADCAST`, `DECISION`, and `PAPER_INTENT_RATIONALE` now require the canonical Main actor in app and SQL. SYSTEM remains available only for mechanical thought types such as risk-gate, stage, and outcome records.
