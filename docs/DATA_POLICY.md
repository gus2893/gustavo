# Data policy

## Collection and scopes

Gustavo stores account, entitlement, conversation, observable rationale, proposal, market-observation, simulated Challenge, authorization, and audit events needed to operate the product. Visibility is assigned at write time as private account, Node branch, Main shared, Challenge shared, public, operator, or audit-only. Scope can broaden only through an explicit authorized event.

Native conversations enter the account's source history. An authorized external chat import requires an owner-approved export or supported connector with a manifest, stable source identifiers, timestamps, participants, conversation boundaries, and content digests. Gustavo does not claim automatic access to ChatGPT, Claude, email, messaging services, deleted conversations, private model state, or hidden chain-of-thought. Failed or prohibited imports are quarantined in audit-only scope and excluded from normal retrieval.

## Processing and providers

Model providers receive only the bounded data, prompts, and content required for the authorized task. Provider identity, model version, source references, and the applicable policy version are recorded. Provider use must be covered by configured data-handling terms; secrets and private source archives are never embedded in client code or public artifacts.

## Retention, export, and forgetting

Retention follows disclosed operational and legal periods for source events, derived projections, audit evidence, and encrypted backups. Authorized export returns only the requester's permitted data. A verified forgetting request deactivates source use, erases protected projections and keys where applicable, invalidates caches, and propagates through backup expiry or cryptographic erasure according to the documented schedule. Legal holds and minimum integrity records are purpose-limited and never used to recreate forgotten content.

Public output is a separate projection containing deliberately public metadata. Protected text, ciphertext, secret values, encryption keys, and account-private proposal sources are never shipped to an unauthorized browser.
