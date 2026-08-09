# Plan: public-market-commentary

**Design status:** approved
**Plan status:** approved
**Execution status:** not started

## Fixed implementation conventions

- Final repository directory: `C:\Users\gusta\Desktop\Projects\gustavo`.
- Runtime: Node.js 24 LTS, TypeScript, Next.js App Router, pnpm, PostgreSQL with vector extension, Valkey, and a PostgreSQL transactional outbox.
- Tests: Vitest for unit/integration tests and Playwright for browser acceptance tests.
- Database access: SQL migrations plus a server-only typed repository layer; PostgreSQL remains authoritative.
- All money and prices use integer minor units or fixed decimal strings at boundaries; JavaScript floating-point values never drive Challenge accounting.
- Model and market-data integrations sit behind typed interfaces. Test suites use deterministic fakes and production configuration supplies server-only adapters.

## Requirement → task map

- R1 → T1, T28
- R2 → T3, T5
- R3 → T3
- R4 → T7, T9
- R5 → T9, T10
- R6 → T10
- R7 → T4, T28
- R8 → T4, T27
- R9 → T11
- R10 → T11
- R11 → T1, T28
- R12 → T1, T32
- R13 → T25
- R14 → T4, T32
- R15 → T2, T5, T6, T7, T8, T9, T10, T33
- R16 → T19, T21
- R17 → T30
- R18 → T30
- R19 → T2, T30, T31
- R20 → T26
- R21 → T19
- R22 → T19, T21
- R23 → T21, T23
- R24 → T2, T19
- R25 → T31
- R26 → T21
- R27 → T26, T29
- R28 → T12
- R29 → T12, T17
- R30 → T12
- R31 → T12, T13, T14
- R32 → T15
- R33 → T14, T16
- R34 → T17
- R35 → T18, T29
- R36 → T32
- R37 → T9, T14
- R38 → T10
- R39 → T10
- R40 → T10, T14
- R41 → T9, T10
- R42 → T10
- R43 → T3, T7, T8
- R44 → T8, T27, T33
- R45 → T21, T23
- R46 → T7
- R47 → T7
- R48 → T7, T9
- R49 → T8, T10, T14
- R50 → T29
- R51 → T2, T15, T18
- R52 → T18
- R53 → T2, T18
- R54 → T24
- R55 → T24
- R56 → T24
- R57 → T24, T30
- R58 → T23, T24
- R59 → T31
- R60 → T25
- R61 → T25
- R62 → T25
- R63 → T25
- R64 → T25, T32
- R65 → T25
- R66 → T25
- R67 → T25, T32
- R68 → T25
- R69 → T5, T20
- R70 → T19, T22
- R71 → T21
- R72 → T21, T23
- R73 → T19, T22
- R74 → T21, T22
- R75 → T21
- R76 → T26
- R77 → T20
- R78 → T21, T31
- R79 → T22
- R80 → T1, T28
- R81 → T3
- R82 → T11
- R83 → T12, T14, T15, T17
- R84 → T14
- R85 → T17
- R86 → T13, T16
- R87 → T6
- R1–R87 integrated acceptance path → T34

## Task list

### T1 — Migrate the repository into the Gustavo application scaffold

**Maps to:** R1, R11, R12, R80
**Files touched:** `.gitignore` (modify), `package.json` (new), `pnpm-lock.yaml` (new), `tsconfig.json` (new), `vitest.config.ts` (new), `next.config.ts` (new), `next-env.d.ts` (generated), `app/layout.tsx` (new), `app/page.tsx` (new), `README.md` (replace), `AGENTS.md` (replace), `policy/editorial-policy.json` (new), `tests/repository/product-policy.test.ts` (new), repository directory rename after the green tree

#### Red — failing test

File: `tests/repository/product-policy.test.ts`

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Gustavo repository policy", () => {
  it("publishes the approved identity and simulation boundary", async () => {
    const readme = await readFile("README.md", "utf8");
    const policy = JSON.parse(await readFile("policy/editorial-policy.json", "utf8"));
    expect(readme).toContain("Gustavo");
    expect(readme).toContain("https://gustavo.lol");
    expect(readme).toContain("SIMULATION ONLY — NOT A REAL TRADE");
    expect(policy.realExecutionEnabled).toBe(false);
    expect(policy.claimsSentience).toBe(false);
    expect(policy.marketScope).toEqual(["US_STOCK", "US_ETF"]);
  });
});
```

Expected initial state: the test exits 1 because `policy/editorial-policy.json` does not exist and the current README describes the superseded paper lab.

#### Green — minimum implementation

- Create the pnpm/TypeScript/Next.js/Vitest scaffold with locked dependencies and strict type checking.
- Replace the old public README and repository instructions with the approved Gustavo identity, simulation-only boundary, and links to the mission documents.
- Add `policy/editorial-policy.json` with `realExecutionEnabled: false`, `claimsSentience: false`, and the two approved asset classes.
- After the test is green, rename the repository directory to `C:\Users\gusta\Desktop\Projects\gustavo` and update absolute operator documentation links.

#### Refactor

- Keep product constants in `policy/editorial-policy.json`; README prose must not become executable configuration.

#### Verify

Command: `pnpm vitest run tests/repository/product-policy.test.ts && pnpm exec tsc --noEmit`

Expected: 2 passing tests, TypeScript exits 0, and the command exits 0.

#### Reviewable as a unit?

Yes. It establishes only the runnable project and non-negotiable product boundary.

---

### T2 — Commit append-only events and outbox work atomically

**Maps to:** R15, R19, R24, R51, R53
**Files touched:** `db/migrations/0001_events.sql` (new), `lib/server/crypto/envelope.ts` (new), `lib/server/events/types.ts` (new), `lib/server/events/store.ts` (new), `tests/events/event-store.test.ts` (new), `tests/helpers/postgres.ts` (new)

#### Red — failing test

File: `tests/events/event-store.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { openTestDb } from "../helpers/postgres";
import { appendEvent, readEventBody } from "../../lib/server/events/store";

describe("appendEvent", () => {
  it("writes the event and its outbox job in one transaction", async () => {
    const db = await openTestDb();
    const event = await appendEvent(db, {
      aggregateId: "conversation-1",
      actor: { type: "USER", id: "account-1" },
      type: "participant.message.created",
      visibility: "PRIVATE_ACCOUNT",
      body: { text: "Remember this" },
      idempotencyKey: "message-1",
    });
    const rows = await db.query(
      "select e.id, o.event_id from events e join transactional_outbox o on o.event_id=e.id where e.id=$1",
      [event.id],
    );
    expect(rows).toEqual([{ id: event.id, event_id: event.id }]);
    const protectedRow = await db.one("select ciphertext, wrapped_key from encrypted_event_bodies where event_id=$1", [event.id]);
    expect(JSON.stringify(protectedRow)).not.toContain("Remember this");
    expect(await readEventBody(db, event.id, { actor: { role: "ACCOUNT", accountId: "account-1" } })).toEqual({ text: "Remember this" });
  });
});
```

Expected initial state: the test exits 1 because the migration and `appendEvent` module do not exist.

#### Green — minimum implementation

- Add immutable `events`, envelope-encrypted body, idempotency, integrity-hash, and `transactional_outbox` tables.
- Implement per-conversation data keys wrapped by a versioned server-only root key; authorize before unwrap/decrypt and never persist root keys in PostgreSQL.
- Implement `appendEvent` with a single PostgreSQL transaction, globally sortable ID, duplicate-key replay, causation/correlation fields, encrypted body, and outbox row.
- Add a test database helper that migrates an isolated PostgreSQL schema and rolls it back after each test file.

#### Refactor

- Centralize event hashing and canonical JSON encoding inside `lib/server/events` so callers cannot vary integrity behavior.

#### Verify

Command: `pnpm vitest run tests/events/event-store.test.ts`

Expected: 1 passing test and exit code 0 against the test PostgreSQL service.

#### Reviewable as a unit?

Yes. It introduces the durable write primitive without domain-specific behavior.

---

### T3 — Redeem invitations into one account, Node Brain, and conversation

**Maps to:** R2, R3, R43, R81
**Files touched:** `db/migrations/0002_identity.sql` (new), `lib/server/auth/invitations.ts` (new), `lib/server/auth/sessions.ts` (new), `app/api/account/redeem/route.ts` (new), `scripts/issue-invitation.ts` (new), `tests/helpers/postgres.ts` (modify), `tests/auth/invitation-redemption.test.ts` (new)

#### Red — failing test

File: `tests/auth/invitation-redemption.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { seedInvitation, testContext } from "../helpers/postgres";
import { redeemInvitation } from "../../lib/server/auth/invitations";
import { sessionCookieOptions } from "../../lib/server/auth/sessions";

describe("redeemInvitation", () => {
  it("creates exactly one identity graph and rejects reuse", async () => {
    const ctx = await testContext();
    const token = await seedInvitation(ctx.db, { expiresAt: new Date("2030-01-01T00:00:00Z") });
    const first = await redeemInvitation(ctx, token, { displayName: "Ada", password: "correct horse battery staple" });
    expect(first).toMatchObject({ accountId: expect.any(String), nodeBrainId: expect.any(String), conversationId: expect.any(String) });
    await expect(redeemInvitation(ctx, token, { displayName: "Other", password: "correct horse battery staple" }))
      .rejects.toThrow("INVITATION_ALREADY_REDEEMED");
    expect(await ctx.db.one("select count(*)::int as count from node_brains where account_id=$1", [first.accountId]))
      .toEqual({ count: 1 });
    const stored = await ctx.db.one("select token_hash, redeemed_at from invitations limit 1");
    expect(stored.token_hash).not.toBe(token);
    expect(stored.redeemed_at).not.toBeNull();
    const credential = await ctx.db.one("select password_hash from password_credentials where account_id=$1", [first.accountId]);
    expect(credential.password_hash).not.toContain("correct horse battery staple");
    expect(sessionCookieOptions("production")).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
  });
});
```

Expected initial state: the test exits 1 because invitation, account, entitlement, Node Brain, conversation, and session persistence do not exist.

#### Green — minimum implementation

- Add invitation hashes, accounts, Argon2id password credentials, opaque hashed sessions, entitlements, Node Brains, and conversations with uniqueness constraints enforcing one account/one Node/one conversation.
- Redeem an unexpired unused invitation in one transaction and create the session cookie through the Route Handler.
- Add an operator-only CLI that prints the raw invitation once, stores only its SHA-256 hash and expiry, and records the issuing audit event.
- Enforce `HttpOnly`, `Secure` in production, `SameSite=Strict`, origin checks, expiry, revocation, and session rotation.

#### Refactor

- Isolate token generation/hashing so the redemption Route Handler and operator CLI share one audited implementation.

#### Verify

Command: `pnpm vitest run tests/auth/invitation-redemption.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It is the complete identity invariant and does not include chat behavior.

---

### T4 — Enforce public and account DTO boundaries before projection

**Maps to:** R7, R8, R14
**Files touched:** `lib/server/auth/authorize.ts` (new), `lib/server/dal/feed.ts` (new), `app/api/public/feed/route.ts` (new), `tests/security/feed-boundaries.test.ts` (new)

#### Red — failing test

File: `tests/security/feed-boundaries.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { feedHeaders, projectFeedEvent } from "../../lib/server/dal/feed";

const event = {
  id: "evt-1",
  accountId: "acct-a",
  type: "brain.response.completed",
  createdAt: "2026-08-09T12:00:00.000Z",
  protectedText: "private thesis text",
  topic: "AAPL",
};

describe("feed DTO projection", () => {
  it("never returns protected text to a public visitor", () => {
    const dto = projectFeedEvent({ role: "PUBLIC" }, event);
    expect(JSON.stringify(dto)).not.toContain("private thesis text");
    expect(dto).toEqual({ id: "evt-1", type: "brain.response.completed", createdAt: event.createdAt, topic: "AAPL", placeholder: true });
    expect(feedHeaders("PUBLIC").get("Cache-Control")).toBe("public, max-age=30");
  });

  it("rejects an account requesting another account's event", () => {
    expect(() => projectFeedEvent({ role: "ACCOUNT", accountId: "acct-b" }, event)).toThrow("FORBIDDEN");
    expect(feedHeaders("ACCOUNT").get("Cache-Control")).toBe("private, no-store");
  });
});
```

Expected initial state: the test exits 1 because the authorization and DTO projector modules do not exist.

#### Green — minimum implementation

- Implement role/scope authorization as database-filter inputs, not post-query filtering.
- Project irreversible public placeholders and minimum account/moderator/operator DTOs.
- Return `Cache-Control: public` only for safe public metadata and `private, no-store` for protected responses.

#### Refactor

- Export an exhaustive `ActorContext` union so adding a role fails compilation until every projector handles it.

#### Verify

Command: `pnpm vitest run tests/security/feed-boundaries.test.ts`

Expected: 2 passing tests and exit code 0.

#### Reviewable as a unit?

Yes. It proves the principal content-protection boundary independently of UI rendering.

---

### T5 — Persist native conversation turns and reconstruct paginated history

**Maps to:** R2, R15, R69
**Files touched:** `db/migrations/0003_messages.sql` (new), `lib/server/history/messages.ts` (new), `app/api/conversations/[conversationId]/messages/route.ts` (new), `tests/helpers/postgres.ts` (modify), `tests/conversations/native-history.test.ts` (new)

#### Red — failing test

File: `tests/conversations/native-history.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { createConversationFixture } from "../helpers/postgres";
import { appendMessage, listMessages } from "../../lib/server/history/messages";

describe("native conversation history", () => {
  it("commits messages before acknowledgement and paginates by stable cursor", async () => {
    const ctx = await createConversationFixture("acct-a");
    await appendMessage(ctx, { idempotencyKey: "m1", role: "USER", text: "first" });
    await appendMessage(ctx, { idempotencyKey: "m2", role: "NODE", text: "second" });
    const page1 = await listMessages(ctx, { limit: 1 });
    const page2 = await listMessages(ctx, { limit: 1, after: page1.nextCursor });
    expect(page1.items.map((item) => item.text)).toEqual(["first"]);
    expect(page2.items.map((item) => item.text)).toEqual(["second"]);
    expect(page2.nextCursor).toBeNull();
  });
});
```

Expected initial state: the test exits 1 because message persistence and cursor pagination are absent.

#### Green — minimum implementation

- Add encrypted message-body rows linked to append-only events, completion/abort metadata, and unique conversation/idempotency keys.
- Implement bounded cursor pagination ordered by globally sortable event ID and authorize by account/conversation before querying.
- Make the mutation Route Handler return only after the source event and outbox job commit.

#### Refactor

- Share cursor encoding/decoding through a small signed opaque-cursor utility.

#### Verify

Command: `pnpm vitest run tests/conversations/native-history.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It covers durable native chat history without invoking a model.

---

### T6 — Add an auditable provider-neutral model gateway

**Maps to:** R15, R87
**Files touched:** `db/migrations/0004_model_runs.sql` (new), `lib/server/models/types.ts` (new), `lib/server/models/gateway.ts` (new), `lib/server/models/fake.ts` (new), `tests/models/gateway-audit.test.ts` (new)

#### Red — failing test

File: `tests/models/gateway-audit.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { createModelGateway } from "../../lib/server/models/gateway";
import { fakeModelProvider } from "../../lib/server/models/fake";
import { testContext } from "../helpers/postgres";

describe("model gateway audit", () => {
  it.each(["MAIN", "NODE", "EVALUATOR"] as const)("records every %s generation", async (role) => {
    const ctx = await testContext();
    const gateway = createModelGateway(ctx.db, fakeModelProvider("fixed response"));
    const result = await gateway.generate({ role, promptVersion: "p1", policyVersion: "v1", input: "test" });
    const run = await ctx.db.one("select role, provider, model, prompt_version, policy_version, input_tokens, output_tokens from model_runs where id=$1", [result.runId]);
    expect(run).toEqual({ role, provider: "fake", model: "deterministic-v1", prompt_version: "p1", policy_version: "v1", input_tokens: 1, output_tokens: 2 });
  });

  it("rejects generation before calling a provider when the configured budget is exhausted", async () => {
    const ctx = await testContext();
    const gateway = createModelGateway(ctx.db, fakeModelProvider("unused"), { monthlyBudgetUsd: "0.00", maxInputTokens: 4096, maxOutputTokens: 1024 });
    await expect(gateway.generate({ role: "NODE", promptVersion: "p1", policyVersion: "v1", input: "test" })).rejects.toThrow("MODEL_BUDGET_EXHAUSTED");
  });
});
```

Expected initial state: the test exits 1 because model roles, the gateway, fake provider, and audit table do not exist.

#### Green — minimum implementation

- Define separate `MAIN`, `NODE`, and `EVALUATOR` model configurations behind one streaming-capable interface.
- Require production provider/model IDs through server-only validated configuration and include prompt/policy version in every request.
- Persist provider, model, latency, token use, estimated cost, completion status, and correlation IDs without storing hidden reasoning.
- Enforce configured per-call token ceilings and monthly role budgets before provider invocation; record rejected budget checks.

#### Refactor

- Keep provider SDK conversion inside adapters; orchestration consumes only the gateway contract.

#### Verify

Command: `pnpm vitest run tests/models/gateway-audit.test.ts`

Expected: 3 passing role cases plus 1 passing budget case and exit code 0.

#### Reviewable as a unit?

Yes. It establishes model execution and audit metadata without Brain policy.

---

### T7 — Route Node replies through exactly one approved mode

**Maps to:** R4, R15, R43, R46, R47, R48
**Files touched:** `lib/server/node-brains/router.ts` (new), `lib/server/node-brains/contracts.ts` (new), `tests/node-brains/router.test.ts` (new)

#### Red — failing test

File: `tests/node-brains/router.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { routeNodeTurn } from "../../lib/server/node-brains/router";

describe("routeNodeTurn", () => {
  it("uses Main by default, explores ambiguity, and proposes only material improvements", () => {
    expect(routeNodeTurn({ coveredByMain: true, contradiction: false, materialEvidence: false, confidence: 0.9 }).mode).toBe("MAIN_DEFAULT");
    expect(routeNodeTurn({ coveredByMain: false, contradiction: true, materialEvidence: false, confidence: 0.4 }).mode).toBe("NODE_EXPLORE");
    expect(routeNodeTurn({ coveredByMain: false, contradiction: true, materialEvidence: true, confidence: 0.9 }).mode).toBe("PROPOSAL_UPSTREAM");
  });

  it("does not treat agreement, repetition, or payment as material evidence", () => {
    expect(routeNodeTurn({ coveredByMain: false, contradiction: false, materialEvidence: false, confidence: 0.99, agreementCount: 50, paid: true }).mode).not.toBe("PROPOSAL_UPSTREAM");
  });
});
```

Expected initial state: the test exits 1 because the Node routing contract and deterministic policy wrapper do not exist.

#### Green — minimum implementation

- Define the three-mode result with classification confidence, Main-state version, source IDs, and policy version.
- Implement low-confidence fallback to `NODE_EXPLORE` and exclude agreement, popularity, repetition, and payment from proposal eligibility.
- Append `node.reply.routed` before generation continues and label exploration as non-canonical in the response contract.

#### Refactor

- Separate deterministic hard exclusions from model-supplied semantic classification.

#### Verify

Command: `pnpm vitest run tests/node-brains/router.test.ts`

Expected: 2 passing tests and exit code 0.

#### Reviewable as a unit?

Yes. It contains only routing policy and its audit shape.

---

### T8 — Commit one Main-authored broadcast before fan-out

**Maps to:** R15, R43, R44, R49
**Files touched:** `db/migrations/0005_broadcasts.sql` (new), `lib/server/main-brain/broadcasts.ts` (new), `app/api/broadcasts/route.ts` (new), `tests/broadcasts/main-authorship.test.ts` (new)

#### Red — failing test

File: `tests/broadcasts/main-authorship.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { testContext } from "../helpers/postgres";
import { commitBroadcast, projectDelivery } from "../../lib/server/main-brain/broadcasts";

describe("Main broadcasts", () => {
  it("fans out one immutable semantic body without Node authorship", async () => {
    const ctx = await testContext();
    const broadcast = await commitBroadcast(ctx, { mainStateVersion: 7, body: "AAPL is testing completed support.", sourceIds: ["price-1"] });
    const a = await projectDelivery(ctx, broadcast.id, { accountId: "a", nodeBrainId: "node-a", locale: "en-US" });
    const b = await projectDelivery(ctx, broadcast.id, { accountId: "b", nodeBrainId: "node-b", locale: "en-US" });
    expect(a.body).toBe(b.body);
    expect(a.author).toEqual({ type: "MAIN_BRAIN", stateVersion: 7 });
    expect(a).not.toHaveProperty("nodeAuthoredBody");
  });
});
```

Expected initial state: the test exits 1 because Main-state, broadcast, and delivery persistence do not exist.

#### Green — minimum implementation

- Add Main-state versions, committed broadcasts, and per-account delivery records.
- Commit one policy-validated semantic body and source set before creating deliveries; permit only non-semantic transport metadata afterward.
- Reject delivery writes that alter the body digest or change author identity.

#### Refactor

- Reuse content digests from the event integrity utility.

#### Verify

Command: `pnpm vitest run tests/broadcasts/main-authorship.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It isolates broadcast authorship and immutability.

---

### T9 — Persist privacy-safe Node proposals and bounded debate turns

**Maps to:** R4, R5, R9, R37, R41, R48
**Files touched:** `db/migrations/0006_proposals.sql` (new), `lib/server/orchestration/proposals.ts` (new), `app/api/proposals/route.ts` (new), `tests/orchestration/proposal-contract.test.ts` (new)

#### Red — failing test

File: `tests/orchestration/proposal-contract.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { createProposal } from "../../lib/server/orchestration/proposals";
import { testContext } from "../helpers/postgres";

describe("Node proposal contract", () => {
  it("stores source-linked evidence without copying raw private text", async () => {
    const ctx = await testContext();
    const proposal = await createProposal(ctx, {
      nodeBrainId: "node-1",
      pseudonymousAccountId: "member-7",
      sourceEventIds: ["evt-private-1"],
      proposedChange: "Treat the completed close as rejection.",
      evidence: ["bar-15m-1"],
      counterevidence: ["zone-1"],
      uncertainty: "volume confirmation is weak",
      rawPrivateText: "must never persist",
      disclosureAuthorized: false,
      idempotencyKey: "proposal-1",
    });
    expect(proposal.rawPrivateText).toBeUndefined();
    expect(proposal.sourceEventIds).toEqual(["evt-private-1"]);
    expect(proposal.status).toBe("PENDING_REVIEW");
  });
});
```

Expected initial state: the test exits 1 because proposal persistence, privacy projection, and review-state contracts do not exist.

#### Green — minimum implementation

- Add proposals, source links, clarification turns, bounded review turns, statuses, idempotency, and pseudonymous council identity.
- Exclude raw private text unless a separately recorded disclosure authorization exists.
- Ensure proposal and debate endpoints cannot mutate Main state or Challenge tables.

#### Refactor

- Use a shared evidence-reference type across commentary, proposals, and evaluations.

#### Verify

Command: `pnpm vitest run tests/orchestration/proposal-contract.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It creates the proposal/review record without selecting a winner.

---

### T10 — Blind-score Main and Node theses with the approved rubric

**Maps to:** R5, R6, R10, R38, R39, R40, R41, R42, R49
**Files touched:** `db/migrations/0007_evaluations.sql` (new), `lib/server/orchestration/rubric.ts` (new), `lib/server/orchestration/decision-window.ts` (new), `tests/orchestration/evaluator-rubric.test.ts` (new)

#### Red — failing test

File: `tests/orchestration/evaluator-rubric.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { RUBRIC_V1, anonymizeCandidate, selectWinner } from "../../lib/server/orchestration/rubric";

describe("approved evaluator rubric", () => {
  it("totals 100 and applies the 80 action threshold plus 5 point margin", () => {
    expect(Object.values(RUBRIC_V1.weights).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(RUBRIC_V1).toMatchObject({ actionThreshold: 80, improvementMargin: 5 });
    expect(Object.keys(RUBRIC_V1.weights)).toEqual(["evidenceFreshness", "structuralClarity", "costAdjustedGeometry", "falsifiability", "uncertainty", "independence"]);
    expect(selectWinner({ main: { id: "main", score: 82, hardGatesPassed: true }, contenders: [{ id: "node", score: 86, hardGatesPassed: true }] })).toBe("main");
    expect(selectWinner({ main: { id: "main", score: 82, hardGatesPassed: true }, contenders: [{ id: "node", score: 87, hardGatesPassed: true }] })).toBe("node");
    expect(selectWinner({ main: { id: "main", score: 70, hardGatesPassed: true }, contenders: [{ id: "node", score: 79, hardGatesPassed: true }] })).toBe("NO_PAPER_TRADE");
    expect(anonymizeCandidate({ nodeBrainId: "node-secret", accountId: "acct-secret", thesis: "completed rejection" })).toEqual({ candidateId: expect.any(String), thesis: "completed rejection" });
  });
});
```

Expected initial state: the test exits 1 because no versioned rubric or immutable decision-window implementation exists.

#### Green — minimum implementation

- Encode weights `25/20/20/15/10/10`, action threshold 80, improvement margin 5, and explicit hard-gate precedence.
- Freeze evidence/portfolio/cost snapshots, hash the Main baseline before contender intake, pseudonymize contenders, and persist evaluator prompt/model/policy/component scores.
- Select Main on ties or sub-margin improvements and return `NO_PAPER_TRADE` when no hard-gate-passing thesis reaches 80.

#### Refactor

- Keep numerical selection pure and store persistence/orchestration in the decision-window module.

#### Verify

Command: `pnpm vitest run tests/orchestration/evaluator-rubric.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. The rubric and commitment protocol form one auditable arbitration subsystem.

---

### T11 — Normalize licensed stock observations and completed-bar evidence

**Maps to:** R9, R10, R82
**Files touched:** `db/migrations/0008_market_data.sql` (new), `lib/server/market-data/types.ts` (new), `lib/server/market-data/policy.ts` (new), `lib/server/market-data/provider.ts` (new), `tests/market-data/observation-policy.test.ts` (new)

#### Red — failing test

File: `tests/market-data/observation-policy.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { normalizeObservation, splitBars } from "../../lib/server/market-data/policy";

describe("market observation policy", () => {
  it("accepts allowlisted US stocks and preserves delay and rights metadata", () => {
    const value = normalizeObservation({
      symbol: "AAPL", assetClass: "US_STOCK", price: "225.10",
      observedAt: "2026-08-09T14:30:00.000Z", provider: "licensed-feed",
      feedStatus: "DELAYED", delaySeconds: 900, redistribution: "ACCOUNT_ONLY",
      sessionState: "OPEN",
    }, new Set(["AAPL", "SPY"]));
    expect(value).toMatchObject({ symbol: "AAPL", feedStatus: "DELAYED", delaySeconds: 900, redistribution: "ACCOUNT_ONLY" });
    expect(() => normalizeObservation({ ...value, symbol: "BTC-USD", assetClass: "CRYPTO" }, new Set(["AAPL"]))).toThrow("MARKET_NOT_ALLOWED");
  });

  it("keeps the active bar out of completed evidence", () => {
    const bars = splitBars([{ id: "b1", completed: true }, { id: "b2", completed: false }]);
    expect(bars).toEqual({ completed: [{ id: "b1", completed: true }], active: { id: "b2", completed: false } });
  });
});
```

Expected initial state: the test exits 1 because the market-data contract and evidence policy do not exist.

#### Green — minimum implementation

- Define licensed-source observations with fixed decimal price, timestamp, asset class, session state, redistribution class, freshness, and delay metadata.
- Reject symbols outside the operator allowlist and asset classes outside `US_STOCK`/`US_ETF`.
- Split completed bars from at most one active provisional bar; hard gates reject stale, closed-session, or unlicensed Challenge observations.

#### Refactor

- Keep provider-specific fields inside adapters and persist only the canonical observation contract plus raw-source reference.

#### Verify

Command: `pnpm vitest run tests/market-data/observation-policy.test.ts`

Expected: 2 passing tests and exit code 0.

#### Reviewable as a unit?

Yes. It defines evidence truth and rights metadata without analysis logic.

---

### T12 — Encode the approved Challenge profile and doubling ladder

**Maps to:** R28, R29, R30, R31, R83
**Files touched:** `db/migrations/0009_challenge_profile.sql` (new), `lib/server/challenge/profile.ts` (new), `tests/challenge/profile.test.ts` (new)

#### Red — failing test

File: `tests/challenge/profile.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { INITIAL_PROFILE, stageLadder, stageValues } from "../../lib/server/challenge/profile";

describe("Challenge profile v1", () => {
  it("derives the approved target, floor, and risk limits", () => {
    expect(stageValues(250_000n)).toEqual({
      targetEquityCents: 275_000n,
      overallFloorCents: 235_000n,
      dailyLossLimitCents: 10_000n,
      portfolioRiskLimitCents: 7_500n,
      positionRiskLimitCents: 2_500n,
      qualifyingRiskCents: 625n,
    });
    expect(INITIAL_PROFILE).toMatchObject({ resetTimezone: "UTC", minimumTradingDays: 3, deadline: null, maxGrossLeverage: "1.0" });
  });

  it("caps the last stage at one million dollars", () => {
    expect(stageLadder()).toEqual([2500, 5000, 10000, 20000, 40000, 80000, 160000, 320000, 640000, 1000000]);
  });
});
```

Expected initial state: the test exits 1 because Challenge profile persistence and pure derivation functions do not exist.

#### Green — minimum implementation

- Add versioned Challenge and stage-profile tables separate from accounts.
- Encode the approved percentages, UTC reset, three days, no deadline, 1x gross exposure, allowed asset classes, maximum positions, and stage ladder using integer basis points and cents.
- Make rule changes append a new profile version and preserve the profile ID on every later evaluation.

#### Refactor

- Centralize basis-point multiplication with explicit rounding toward the safer lower exposure/higher cost result.

#### Verify

Command: `pnpm vitest run tests/challenge/profile.test.ts`

Expected: 2 passing tests and exit code 0.

#### Reviewable as a unit?

Yes. It adds configuration and pure arithmetic only.

---

### T13 — Calculate the approved stock/ETF simulation costs

**Maps to:** R31, R86
**Files touched:** `lib/server/challenge/costs.ts` (new), `tests/challenge/cost-model.test.ts` (new)

#### Red — failing test

File: `tests/challenge/cost-model.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { commission, priceFill, shortBorrow } from "../../lib/server/challenge/costs";

describe("stock simulation costs v1", () => {
  it("charges per-share commission with a one dollar minimum", () => {
    expect(commission("10")).toBe("1.00");
    expect(commission("1000")).toBe("5.00");
  });

  it("applies observed ask or fallback half-spread plus adverse slippage", () => {
    expect(priceFill({ side: "BUY", reference: "100.00", ask: "100.02" })).toBe("100.07");
    expect(priceFill({ side: "BUY", reference: "100.00" })).toBe("100.10");
    expect(priceFill({ side: "SELL", reference: "100.00" })).toBe("99.90");
  });

  it("accrues five percent annualized short borrow by UTC day", () => {
    expect(shortBorrow({ shortNotional: "10000.00", utcDays: 1 })).toBe("1.37");
  });
});
```

Expected initial state: the test exits 1 because the fixed-decimal cost functions do not exist.

#### Green — minimum implementation

- Use `decimal.js` with `ROUND_HALF_UP`, explicit price precision, and final monetary rounding to cents.
- Calculate `$0.005/share` with `$1/order` minimum, 5 bps adverse fill slippage, observed bid/ask or 5 bps half-spread fallback, and 5%/365 short borrow.
- Return a componentized cost record so the ledger stores commission, spread, slippage, and borrow separately.

#### Refactor

- Expose cost-policy version and calculation inputs beside every result.

#### Verify

Command: `pnpm vitest run tests/challenge/cost-model.test.ts`

Expected: 3 passing tests and exit code 0.

#### Reviewable as a unit?

Yes. The functions are pure and independent of order state.

---

### T14 — Enforce deterministic Challenge risk gates

**Maps to:** R31, R33, R37, R40, R49, R83, R84
**Files touched:** `lib/server/challenge/risk.ts` (new), `tests/challenge/risk-gates.test.ts` (new)

#### Red — failing test

File: `tests/challenge/risk-gates.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { evaluateRisk } from "../../lib/server/challenge/risk";

const base = {
  actorType: "MAIN_BRAIN",
  startingBalance: "2500.00", currentEquity: "2500.00", dayStartEquity: "2500.00",
  realizedDayLoss: "0.00", openLoss: "0.00", existingStopRisk: "0.00",
  proposedStopRisk: "25.00", existingGrossNotional: "0.00", proposedNotional: "2000.00",
  pendingOpenCount: 0, symbolAlreadyActive: false,
};

describe("Challenge risk gates v1", () => {
  it("accepts the exact limits and rejects every exceeded boundary", () => {
    expect(evaluateRisk(base)).toEqual({ accepted: true, reasons: [] });
    expect(evaluateRisk({ ...base, proposedStopRisk: "25.01" }).reasons).toContain("POSITION_RISK_LIMIT");
    expect(evaluateRisk({ ...base, existingStopRisk: "60.00", proposedStopRisk: "20.00" }).reasons).toContain("PORTFOLIO_RISK_LIMIT");
    expect(evaluateRisk({ ...base, proposedNotional: "2500.01" }).reasons).toContain("GROSS_NOTIONAL_LIMIT");
    expect(evaluateRisk({ ...base, pendingOpenCount: 3 }).reasons).toContain("POSITION_COUNT_LIMIT");
    expect(evaluateRisk({ ...base, symbolAlreadyActive: true }).reasons).toContain("SYMBOL_DUPLICATE");
    expect(evaluateRisk({ ...base, actorType: "NODE_BRAIN" }).reasons).toContain("UNAUTHORIZED_CHALLENGE_ACTOR");
    expect(evaluateRisk({ ...base, realizedDayLoss: "30.00", openLoss: "20.00", existingStopRisk: "15.00", proposedStopRisk: "15.00" }).reasons).toContain("PORTFOLIO_RISK_LIMIT");
  });

  it("fails at the daily and overall boundaries", () => {
    expect(evaluateRisk({ ...base, dayStartEquity: "2500.00", currentEquity: "2400.00" }).reasons).toContain("DAILY_LOSS_LIMIT");
    expect(evaluateRisk({ ...base, currentEquity: "2350.00" }).reasons).toContain("OVERALL_LOSS_LIMIT");
  });
});
```

Expected initial state: the test exits 1 because no deterministic risk evaluator exists.

#### Green — minimum implementation

- Compute daily, static overall, position, aggregate stop-risk, gross-notional, count, and duplicate-symbol gates from one consistent ledger snapshot.
- Treat reaching a hard loss boundary as failure and include realized UTC-day loss, open loss, and remaining stop risk in aggregate risk.
- Return all rejection reasons plus profile/ledger high-water IDs; no model can override the result.

#### Refactor

- Implement each gate as a named pure predicate and compose them in stable order for audit output.

#### Verify

Command: `pnpm vitest run tests/challenge/risk-gates.test.ts`

Expected: 2 passing tests and exit code 0.

#### Reviewable as a unit?

Yes. It is pure policy evaluation with no persistence side effects.

---

### T15 — Derive Challenge accounting from an immutable ledger

**Maps to:** R32, R51, R83
**Files touched:** `db/migrations/0010_challenge_ledger.sql` (new), `lib/server/challenge/ledger.ts` (new), `lib/server/challenge/projection.ts` (new), `tests/challenge/ledger-replay.test.ts` (new)

#### Red — failing test

File: `tests/challenge/ledger-replay.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { replayLedger } from "../../lib/server/challenge/projection";

describe("Challenge ledger replay", () => {
  it("derives the same state from the same ordered events", () => {
    const events = [
      { id: "1", type: "stage.started", amount: "2500.00" },
      { id: "2", type: "paper.fill.created", positionId: "p1", side: "BUY", quantity: "10", price: "100.00", commission: "1.00" },
      { id: "3", type: "price.mark.recorded", positionId: "p1", price: "105.00" },
      { id: "4", type: "paper.position.closed", positionId: "p1", price: "105.00", commission: "1.00" },
    ] as const;
    const first = replayLedger(events);
    const second = replayLedger(events);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ balance: "2548.00", equity: "2548.00", realizedPnl: "48.00", openPositions: 0, highWaterId: "4" });
  });
});
```

Expected initial state: the test exits 1 because ledger tables and deterministic projection logic do not exist.

#### Green — minimum implementation

- Add Challenge, stage, intent, order, fill, position, mark, fee, financing, rule-evaluation, and ledger-event tables with append-only constraints.
- Implement fixed-decimal replay for balance, equity, realized/unrealized P&L, peak equity, exposure, drawdown, and high-water mark.
- Store projections as rebuildable checkpoints and reject mutation APIs that bypass ledger events.

#### Refactor

- Keep the replay reducer free of database calls; persistence loads ordered typed events and writes checkpoints.

#### Verify

Command: `pnpm vitest run tests/challenge/ledger-replay.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It proves authoritative replay before adding order lifecycle behavior.

---

### T16 — Simulate idempotent orders, fills, marks, and exits

**Maps to:** R33, R86
**Files touched:** `lib/server/challenge/orders.ts` (new), `worker/challenge/process-order.ts` (new), `tests/helpers/postgres.ts` (modify), `tests/challenge/order-lifecycle.test.ts` (new)

#### Red — failing test

File: `tests/challenge/order-lifecycle.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { testChallengeContext } from "../helpers/postgres";
import { submitPaperIntent, processPaperOrder } from "../../lib/server/challenge/orders";

describe("paper order lifecycle", () => {
  it("creates one costed fill for repeated processing of one intent", async () => {
    const ctx = await testChallengeContext();
    const intent = await submitPaperIntent(ctx, {
      sourceDecisionId: "decision-1", symbol: "AAPL", direction: "LONG",
      entry: "100.00", stop: "97.50", exitRule: { type: "TARGET", price: "105.00" },
      desiredRisk: "25.00", expiresAt: "2026-08-09T20:00:00.000Z",
      idempotencyKey: "intent-1",
    });
    await processPaperOrder(ctx, intent.orderId, { reference: "100.00", observedAt: "2026-08-09T15:00:00.000Z" });
    await processPaperOrder(ctx, intent.orderId, { reference: "100.00", observedAt: "2026-08-09T15:00:00.000Z" });
    expect(await ctx.db.one("select count(*)::int as count from paper_fills where order_id=$1", [intent.orderId])).toEqual({ count: 1 });
  });
});
```

Expected initial state: the test exits 1 because intent persistence and the idempotent simulation worker do not exist.

#### Green — minimum implementation

- Validate complete geometry, observation freshness/session, allowed symbol, evaluator selection, risk decision, and idempotency before appending an order or rejection.
- Let the worker apply the cost model to timestamped observations and append fills, marks, targets/stops, expiry, fees, financing, and close events.
- Use job leases plus unique lifecycle keys so retries cannot duplicate orders, fills, or exits.

#### Refactor

- Keep lifecycle transitions in a pure state machine and database effects in one transactional command handler.

#### Verify

Command: `pnpm vitest run tests/challenge/order-lifecycle.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It wires previously tested risk, costs, and ledger primitives into one lifecycle.

---

### T17 — Enforce qualifying days, permanent failure, and stage advancement

**Maps to:** R29, R34, R83, R85
**Files touched:** `lib/server/challenge/stages.ts` (new), `tests/challenge/trading-days.test.ts` (new)

#### Red — failing test

File: `tests/challenge/trading-days.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { evaluateStage, nextStartingBalance, qualifiesTradingDay } from "../../lib/server/challenge/stages";

describe("Challenge stage lifecycle", () => {
  it("requires three distinct qualifying UTC days at target equity", () => {
    expect(evaluateStage({ startingBalance: "2500.00", equity: "2750.00", qualifyingDays: ["2026-08-07", "2026-08-08"] }).status).toBe("ACTIVE");
    expect(evaluateStage({ startingBalance: "2500.00", equity: "2750.00", qualifyingDays: ["2026-08-07", "2026-08-08", "2026-08-09"] }).status).toBe("PASSED");
  });

  it("counts only new positions carrying at least 0.25 percent initial risk", () => {
    expect(qualifiesTradingDay({ startingBalance: "2500.00", initialStopRisk: "6.24" })).toBe(false);
    expect(qualifiesTradingDay({ startingBalance: "2500.00", initialStopRisk: "6.25" })).toBe(true);
  });

  it("fails permanently at a hard boundary and caps final advancement", () => {
    expect(evaluateStage({ startingBalance: "2500.00", equity: "2350.00", qualifyingDays: [] }).status).toBe("FAILED");
    expect(nextStartingBalance("640000.00")).toBe("1000000.00");
    expect(nextStartingBalance("1000000.00")).toBeNull();
  });
});
```

Expected initial state: the test exits 1 because trading-day qualification and stage lifecycle functions do not exist.

#### Green — minimum implementation

- Count unique UTC dates only from opening fills with at least the stage's 0.25% qualifying risk.
- Run pass/fail evaluation after every ledger event and at the UTC boundary; append immutable passed/failed/advanced events.
- Create a fresh next-stage ledger on pass, block orders after failure/completion, and cap advancement at $1,000,000.

#### Refactor

- Use the same profile derivation functions from T12 for every stage amount.

#### Verify

Command: `pnpm vitest run tests/challenge/trading-days.test.ts`

Expected: all stage lifecycle tests pass and exit code 0.

#### Reviewable as a unit?

Yes. It completes stage progression without changing order accounting.

---

### T18 — Store observable ThoughtRecords in the source transaction

**Maps to:** R35, R51, R52, R53
**Files touched:** `db/migrations/0011_thoughts.sql` (new), `lib/server/thoughts/types.ts` (new), `lib/server/thoughts/store.ts` (new), `tests/thoughts/atomic-thought.test.ts` (new)

#### Red — failing test

File: `tests/thoughts/atomic-thought.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { testContext } from "../helpers/postgres";
import { recordDecisionThought } from "../../lib/server/thoughts/store";

describe("ThoughtRecord durability", () => {
  it("commits rationale, sources, state version, event, and outbox together", async () => {
    const ctx = await testContext();
    const thought = await recordDecisionThought(ctx, {
      type: "DECISION", actor: { type: "MAIN_BRAIN", id: "main" }, scope: "MAIN_SHARED",
      rationale: "Completed support held while the active bar remains provisional.",
      evidenceIds: ["bar-completed-1"], counterevidenceIds: ["zone-opposing-1"],
      uncertainty: "medium", sourceEventIds: ["evt-1"], stateVersion: 3,
      promptVersion: "p1", modelVersion: "m1", policyVersion: "v1",
    });
    const row = await ctx.db.one("select t.id, e.id as event_id, o.event_id as outbox_event_id from thought_records t join events e on e.id=t.event_id join transactional_outbox o on o.event_id=e.id where t.id=$1", [thought.id]);
    expect(row.event_id).toBe(row.outbox_event_id);
    expect(row.id).toBe(thought.id);
  });
});
```

Expected initial state: the test exits 1 because the ThoughtRecord schema and atomic command do not exist.

#### Green — minimum implementation

- Add typed thought records, claims, evidence/counterevidence links, source links, validity, uncertainty, state/prompt/model/policy versions, and supersession.
- Store the concise rationale, source event, required state reference, and outbox work in one transaction.
- Reject fields requesting hidden chain-of-thought and accept only explicit source-grounded rationale artifacts.

#### Refactor

- Reuse visibility and provenance types from events and memory.

#### Verify

Command: `pnpm vitest run tests/thoughts/atomic-thought.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It adds the auditable rationale primitive separately from memory extraction.

---

### T19 — Consolidate source events into typed memory projections

**Maps to:** R16, R21, R22, R24, R70, R73
**Files touched:** `db/migrations/0012_memory.sql` (new), `lib/server/memory/types.ts` (new), `lib/server/consolidation/consolidate.ts` (new), `worker/consolidation/process-event.ts` (new), `tests/memory/consolidation.test.ts` (new)

#### Red — failing test

File: `tests/memory/consolidation.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { consolidateEvents } from "../../lib/server/consolidation/consolidate";

describe("memory consolidation", () => {
  it("creates source-linked typed projections without replacing messages", async () => {
    const result = await consolidateEvents({
      scope: "PRIVATE_ACCOUNT", accountId: "acct-1", nodeBrainId: "node-1",
      events: [
        { id: "e1", at: "2026-08-09T10:00:00Z", text: "My preferred ticker is AAPL." },
        { id: "e2", at: "2026-08-09T10:01:00Z", text: "We still need to compare the completed close." },
      ],
      extracted: {
        facts: [{ text: "Preferred ticker is AAPL", sourceIds: ["e1"], confidence: 0.98 }],
        goals: [{ text: "Compare the completed close", sourceIds: ["e2"], status: "OPEN" }],
        episode: { text: "Preference and open market question", sourceIds: ["e1", "e2"] },
      },
    });
    expect(result.memories.map((memory) => memory.type)).toEqual(["SEMANTIC", "GOAL", "EPISODIC"]);
    expect(result.memories.every((memory) => memory.sourceIds.length > 0)).toBe(true);
    expect(result.deletedSourceEventIds).toEqual([]);
  });
});
```

Expected initial state: the test exits 1 because memory types, consolidation, and projection tables do not exist.

#### Green — minimum implementation

- Add semantic facts, episodes, procedures, goals, embeddings, supersessions, extraction runs, and projection checkpoints.
- Process outbox events asynchronously and idempotently; create only source-linked typed projections and update high-water marks.
- Segment episodes at idle boundaries and refresh Node/Main dossiers after relevant accepted events without deleting source data.

#### Refactor

- Keep extraction-provider output validation separate from deterministic deduplication and persistence.

#### Verify

Command: `pnpm vitest run tests/memory/consolidation.test.ts`

Expected: all memory-layer and consolidation tests pass with exit code 0.

#### Reviewable as a unit?

Yes. It introduces derived memory generation but not retrieval ranking.

---

### T20 — Import authorized external chats incrementally and idempotently

**Maps to:** R69, R77
**Files touched:** `db/migrations/0013_chat_sources.sql` (new), `lib/server/chat-sources/contracts.ts` (new), `lib/server/chat-sources/import.ts` (new), `app/api/memory/sources/import/route.ts` (new), `tests/chats/incremental.test.ts` (new)

#### Red — failing test

File: `tests/chats/incremental.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { importChatManifest } from "../../lib/server/chat-sources/import";
import { testContext } from "../helpers/postgres";

describe("external chat source cursors", () => {
  it("imports only authorized new content and makes a repeat a no-op", async () => {
    const ctx = await testContext();
    const manifest = {
      source: "CHATGPT_EXPORT", ownerAuthorizationId: "auth-1", sourceId: "export-1",
      conversations: [{ id: "c1", messages: [{ id: "m1", at: "2026-08-01T00:00:00Z", role: "USER", text: "Remember AAPL" }] }],
    } as const;
    expect((await importChatManifest(ctx, manifest)).insertedMessages).toBe(1);
    expect((await importChatManifest(ctx, manifest)).insertedMessages).toBe(0);
    await expect(importChatManifest(ctx, { ...manifest, ownerAuthorizationId: "missing" })).rejects.toThrow("SOURCE_NOT_AUTHORIZED");
    const updated = { ...manifest, conversations: [{ id: "c1", messages: [...manifest.conversations[0].messages, { id: "m2", at: "2026-08-02T00:00:00Z", role: "ASSISTANT" as const, text: "Stored" }] }] };
    expect((await importChatManifest(ctx, updated)).insertedMessages).toBe(1);
  });
});
```

Expected initial state: the test exits 1 because authorized source manifests, cursors, quarantine, and external import logic do not exist.

#### Green — minimum implementation

- Add chat sources, owner authorization, manifests, incremental cursors, imported conversations/messages, digests, corrections, and quarantine records.
- Validate stable IDs, timestamps, roles, boundaries, and content digests; reject sources without recorded authorization.
- Advance cursors only after durable commit and use deterministic source/content identities to make repeat imports no-ops.

#### Refactor

- Implement import format adapters behind one canonical manifest validator.

#### Verify

Command: `pnpm vitest run tests/chats/incremental.test.ts`

Expected: all external and incremental import tests pass with exit code 0.

#### Reviewable as a unit?

Yes. It handles source ingestion without sharing imported content into Main memory.

---

### T21 — Retrieve bounded authorized memory and store RecallTrace provenance

**Maps to:** R16, R22, R23, R26, R45, R71, R72, R74, R75, R78
**Files touched:** `db/migrations/0014_recall.sql` (new), `lib/server/recall/planner.ts` (new), `lib/server/recall/rank.ts` (new), `lib/server/recall/trace.ts` (new), `tests/recall/planner.test.ts` (new)

#### Red — failing test

File: `tests/recall/planner.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { planRecall } from "../../lib/server/recall/planner";

describe("authorization-first recall", () => {
  it("pins current shared state, excludes foreign private memory, and bounds output", async () => {
    const result = await planRecall({
      actor: { role: "MAIN_BRAIN" }, query: "What did we decide about AAPL?", maxMemories: 3,
      candidates: [
        { id: "current", scope: "MAIN_SHARED", type: "DECISION", current: true, score: 0.4, sourceIds: ["e1"] },
        { id: "private-a", scope: "PRIVATE_ACCOUNT", accountId: "a", type: "EPISODIC", current: true, score: 0.99, sourceIds: ["e2"] },
        { id: "old", scope: "MAIN_SHARED", type: "DECISION", current: false, score: 0.95, sourceIds: ["e3"] },
        { id: "challenge", scope: "CHALLENGE_SHARED", type: "GOAL", current: true, score: 0.8, sourceIds: ["e4"] },
      ],
    });
    expect(result.memories.map((memory) => memory.id)).toEqual(["current", "challenge", "old"]);
    expect(result.excluded).toContainEqual({ id: "private-a", reason: "SCOPE_FORBIDDEN" });
    expect(result.trace.selectedMemoryIds).toEqual(["current", "challenge", "old"]);
  });

  it("lets an account recall its own private memory but never another account's", async () => {
    const result = await planRecall({
      actor: { role: "ACCOUNT", accountId: "a" }, query: "my preference", maxMemories: 2,
      candidates: [
        { id: "mine", scope: "PRIVATE_ACCOUNT", accountId: "a", type: "SEMANTIC", current: true, score: 0.9, sourceIds: ["e5"] },
        { id: "theirs", scope: "PRIVATE_ACCOUNT", accountId: "b", type: "SEMANTIC", current: true, score: 0.99, sourceIds: ["e6"] },
      ],
    });
    expect(result.memories.map((memory) => memory.id)).toEqual(["mine"]);
    expect(result.excluded).toContainEqual({ id: "theirs", reason: "SCOPE_FORBIDDEN" });
  });
});
```

Expected initial state: the test exits 1 because scope-first planning, fusion ranking, bounded context packs, and recall traces do not exist.

#### Green — minimum implementation

- Resolve actor scopes before database predicates, full-text/vector queries, graph expansion, ranking, or cache lookup.
- Run bounded recent/entity/time/full-text/vector/procedure/goal/current-state queries, fuse deterministically, pin current Main/Challenge state, and down-rank historical/superseded records.
- Persist query plan, candidates, exclusions, selected memory/source IDs, cache use, latency, and response ID in `recall_traces`.

#### Refactor

- Keep authorization, candidate retrieval, fusion, and token-budget assembly as separately testable functions.

#### Verify

Command: `pnpm vitest run tests/recall/planner.test.ts`

Expected: all scope, planner, and trace tests pass with exit code 0.

#### Reviewable as a unit?

Yes. It is the complete interactive recall boundary over already-built memory projections.

---

### T22 — Version temporal memory graph edges and explicit conflicts

**Maps to:** R70, R73, R74, R79
**Files touched:** `db/migrations/0015_memory_graph.sql` (new), `lib/server/consolidation/graph.ts` (new), `lib/server/consolidation/conflicts.ts` (new), `tests/memory/conflicts.test.ts` (new)

#### Red — failing test

File: `tests/memory/conflicts.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { reconcileMemories } from "../../lib/server/consolidation/conflicts";

describe("temporal memory conflicts", () => {
  it("keeps both sourced claims and prefers the current approved version", () => {
    const result = reconcileMemories([
      { id: "old", entityId: "e-aapl", predicate: "BIAS", value: "BULLISH", validFrom: "2026-08-01T00:00:00Z", approved: true, sourceIds: ["s1"] },
      { id: "new", entityId: "e-aapl", predicate: "BIAS", value: "NEUTRAL", validFrom: "2026-08-09T00:00:00Z", approved: true, sourceIds: ["s2"] },
    ]);
    expect(result.current.id).toBe("new");
    expect(result.edges).toContainEqual({ from: "new", type: "SUPERSEDES", to: "old" });
    expect(result.preserved.map((memory) => memory.id)).toEqual(["old", "new"]);
  });
});
```

Expected initial state: the test exits 1 because graph nodes/edges, aliases, temporal reconciliation, and conflict records do not exist.

#### Green — minimum implementation

- Add typed memory nodes/edges, entities, aliases, validity intervals, source links, and indexes by scope/type/entity/time.
- Limit synchronous graph traversal depth and candidate count; enqueue deeper historical graph research as a background job.
- Detect contradicting current claims, append `CONTRADICTS`/`SUPERSEDES` edges, preserve both sources, and prefer current approved state.

#### Refactor

- Keep alias resolution and contradiction policy independent from storage traversal.

#### Verify

Command: `pnpm vitest run tests/memory/conflicts.test.ts`

Expected: all graph and conflict tests pass with exit code 0.

#### Reviewable as a unit?

Yes. It adds associative structure without changing recall authorization.

---

### T23 — Build privacy-filtered Node-to-Main handoff packets

**Maps to:** R23, R45, R58, R72
**Files touched:** `db/migrations/0016_handoffs.sql` (new), `lib/server/handoffs/build.ts` (new), `worker/handoffs/refresh.ts` (new), `tests/handoffs/privacy.test.ts` (new)

#### Red — failing test

File: `tests/handoffs/privacy.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildHandoff } from "../../lib/server/handoffs/build";

describe("Node-to-Main handoff", () => {
  it("includes authorized proposal facts and excludes unrelated raw chat", () => {
    const packet = buildHandoff({
      nodeBrainId: "node-1", highWaterMark: "e9",
      memories: [
        { id: "m1", scope: "NODE_BRANCH", transmitted: true, kind: "EVIDENCE", text: "Completed close rejected resistance", sourceIds: ["e8"] },
        { id: "m2", scope: "PRIVATE_ACCOUNT", transmitted: false, kind: "MESSAGE", text: "unrelated private detail", sourceIds: ["e7"] },
      ],
    });
    expect(packet.items.map((item) => item.id)).toEqual(["m1"]);
    expect(JSON.stringify(packet)).not.toContain("unrelated private detail");
    expect(packet.highWaterMark).toBe("e9");
  });
});
```

Expected initial state: the test exits 1 because handoff packet projection and incremental refresh do not exist.

#### Green — minimum implementation

- Build compact packets containing thesis, evidence, counterevidence, open questions, recent changes, source IDs, and memory versions only from transmitted/council-visible records.
- Refresh incrementally after relevant events and persist a high-water mark; synchronous reviews apply only the small later delta.
- Never include unrelated private chat or use a packet across Node/scope/policy versions.

#### Refactor

- Share bounded-context serialization with recall packs while keeping different authorization policies.

#### Verify

Command: `pnpm vitest run tests/handoffs/privacy.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It is the explicit privacy bridge between Node and Main memory.

---

### T24 — Add versioned cache keys, invalidation, prewarming, and rebuild

**Maps to:** R54, R55, R56, R57, R58
**Files touched:** `lib/server/cache/keys.ts` (new), `lib/server/cache/store.ts` (new), `worker/cache/invalidate.ts` (new), `scripts/rebuild-projections.ts` (new), `tests/cache/isolation.test.ts` (new)

#### Red — failing test

File: `tests/cache/isolation.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { cacheKey, rebuildCriticalProjections, scopedCache } from "../../lib/server/cache/store";

describe("cache isolation", () => {
  it("binds protected values to identity, scope, and source versions", async () => {
    const cache = scopedCache();
    const a = cacheKey({ namespace: "context", scope: "PRIVATE_ACCOUNT", entityId: "acct-a", sourceHighWater: "e9", stateVersion: 2, policyVersion: "v1", schemaVersion: 1 });
    const b = cacheKey({ namespace: "context", scope: "PRIVATE_ACCOUNT", entityId: "acct-b", sourceHighWater: "e9", stateVersion: 2, policyVersion: "v1", schemaVersion: 1 });
    expect(a).not.toBe(b);
    await cache.set(a, { text: "private-a" }, { ttlSeconds: 30, encrypted: true });
    expect(await cache.get(b)).toBeNull();
  });

  it("rebuilds current state after the disposable cache is erased", async () => {
    const cache = scopedCache();
    await cache.flushAll();
    const result = await rebuildCriticalProjections({ cache, source: "POSTGRES", checkpoint: "e100" });
    expect(result).toEqual({ source: "POSTGRES", checkpoint: "e100", mainState: "rebuilt", challenge: "rebuilt", handoffs: "rebuilt" });
  });
});
```

Expected initial state: the test exits 1 because typed scoped keys, protected-value policy, invalidation workers, and rebuild command do not exist.

#### Green — minimum implementation

- Add Valkey cache-aside storage plus a bounded process LRU for immutable configuration and already-authorized context packs.
- Build typed keys containing namespace, scope, entity, source high-water, state, policy, and schema versions; minimize/encrypt protected packs with short TTLs.
- Consume outbox invalidation/prewarm jobs, use immutable versions plus pointer keys and single-flight locks, and rebuild every projection/cache from PostgreSQL checkpoints.

#### Refactor

- Hide Valkey commands behind a typed store so domain modules cannot construct ad hoc keys.

#### Verify

Command: `pnpm vitest run tests/cache/isolation.test.ts`

Expected: all cache isolation and rebuild tests pass with exit code 0 after Valkey deletion during the rebuild case.

#### Reviewable as a unit?

Yes. It accelerates existing projections without changing their authority.

---

### T25 — Bootstrap classified trading knowledge with provenance and rollback

**Maps to:** R13, R60, R61, R62, R63, R64, R65, R66, R67, R68
**Files touched:** `db/migrations/0017_imports.sql` (new), `lib/server/import/classify.ts` (new), `lib/server/import/run.ts` (new), `lib/server/import/verify.ts` (new), `scripts/import-bootstrap.ts` (new), `scripts/archive-legacy-knowledge.ts` (new), `.gitignore` (modify), `tests/import/bootstrap.test.ts` (new)

#### Red — failing test

File: `tests/import/bootstrap.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { runBootstrapImport, verifyBootstrap } from "../../lib/server/import/run";
import { archiveLegacyBundle } from "../../lib/server/import/verify";
import { testContext } from "../helpers/postgres";

describe("classified bootstrap import", () => {
  it("is idempotent and isolates historical, deprecated, and prohibited material", async () => {
    const ctx = await testContext();
    const source = {
      namespace: "repo", locator: "docs/MECHANISM.md", digest: "sha256:abc",
      items: [
        { id: "method", text: "Use completed 15m evidence", kind: "STRUCTURAL_METHOD" },
        { id: "avax", text: "AVAX stopped on 2026-08-08", kind: "DATED_MARKET_EPISODE" },
        { id: "broker", text: "external execution inbox", kind: "EXECUTION_WORKFLOW" },
      ],
    } as const;
    const first = await runBootstrapImport(ctx, source);
    const second = await runBootstrapImport(ctx, source);
    expect(first.classifications).toEqual({ CANDIDATE: 1, HISTORICAL: 1, PROHIBITED: 1 });
    expect(second.inserted).toBe(0);
    expect((await verifyBootstrap(ctx, first.manifestId)).prohibitedInActiveRetrieval).toBe(0);
  });

  it("produces an encrypted operator archive with only digests in its public manifest", () => {
    const archived = archiveLegacyBundle([{ locator: "docs/ETH_CONTEXT.md", bytes: Buffer.from("dated ETH context") }], Buffer.alloc(32, 7));
    expect(archived.ciphertext.toString("utf8")).not.toContain("dated ETH context");
    expect(archived.manifest).toEqual({ sources: [{ locator: "docs/ETH_CONTEXT.md", digest: expect.stringMatching(/^sha256:/) }] });
  });
});
```

Expected initial state: the test exits 1 because manifests, lifecycle classification, idempotent import, verification, and deactivation do not exist.

#### Green — minimum implementation

- Add manifests, source items, digests, parser versions, lifecycle classes, review state, provenance, activation/deactivation, and import high-water marks.
- Classify approved Gustavo boundaries as canonical, structural methods as candidate, dated ETH/AVAX episodes as historical, superseded workflows as deprecated, and execution/CFT material as prohibited audit-only data.
- Make deterministic import keys no-op on repeat, generate count/hash manifests, verify active retrieval exclusion, and roll back through append-only deactivation events.
- After manifest verification, archive superseded raw paper-lab files into an operator-owned encrypted bundle outside the public repository, keep only its digest/manifest, and remove those raw files from the public application tree.

#### Refactor

- Put classification rules in versioned data with a deterministic rule engine; never execute imported prose.

#### Verify

Command: `pnpm vitest run tests/import/bootstrap.test.ts`

Expected: 2 passing tests and exit code 0.

#### Reviewable as a unit?

Yes. It imports explicit local knowledge without altering current market state or Challenge accounting.

---

### T26 — Support memory inspection, correction, export, and cryptographic forgetting

**Maps to:** R20, R27, R76
**Files touched:** `db/migrations/0018_privacy_controls.sql` (new), `lib/server/memory/controls.ts` (new), `lib/server/memory/forget.ts` (new), `app/api/memory/route.ts` (new), `app/api/account/export/route.ts` (new), `tests/helpers/postgres.ts` (modify), `tests/privacy/forget-propagation.test.ts` (new)

#### Red — failing test

File: `tests/privacy/forget-propagation.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { forgetConversation } from "../../lib/server/memory/forget";
import { seedProtectedConversation } from "../helpers/postgres";

describe("cryptographic forgetting", () => {
  it("destroys content access and removes every derived retrieval path", async () => {
    const ctx = await seedProtectedConversation("acct-a", "secret preference");
    await forgetConversation(ctx, { accountId: "acct-a", conversationId: ctx.conversationId, requestedBy: "acct-a" });
    expect(await ctx.keys.exists(ctx.dataKeyId)).toBe(false);
    expect(await ctx.db.one("select count(*)::int as count from memory_embeddings where conversation_id=$1 and active", [ctx.conversationId])).toEqual({ count: 0 });
    expect(await ctx.cache.find("secret preference")).toEqual([]);
    expect(await ctx.db.one("select type from audit_events where aggregate_id=$1 order by created_at desc limit 1", [ctx.conversationId])).toEqual({ type: "content.forgotten" });
  });
});
```

Expected initial state: the test exits 1 because account memory controls, key destruction, projection deactivation, cache purge, export, and tombstones do not exist.

#### Green — minimum implementation

- Add authorized list/source inspection, correction/supersession, archive, export, and forget commands.
- On forgetting, destroy the conversation data key and deactivate source-derived memories, graph edges, embeddings, summaries, dossiers, handoffs, and caches while retaining only a non-sensitive tombstone.
- Queue idempotent propagation and expose completion state; exports include only the actor's authorized source and derived records.

#### Refactor

- Use a propagation registry so every new projection type must declare forget and rebuild behavior.

#### Verify

Command: `pnpm vitest run tests/privacy/forget-propagation.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It closes the privacy lifecycle over the established memory projections.

---

### T27 — Stream committed event DTOs through authenticated SSE

**Maps to:** R8, R44
**Files touched:** `lib/server/stream/events.ts` (new), `app/api/feed/stream/route.ts` (new), `tests/stream/sse-authorization.test.ts` (new)

#### Red — failing test

File: `tests/stream/sse-authorization.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { openFeedStream } from "../../lib/server/stream/events";

const fixtures: Record<string, { id: string; visibility: string; accountId?: string; text?: string }> = {
  "public-1": { id: "public-1", visibility: "PUBLIC" },
  "private-a": { id: "private-a", visibility: "PRIVATE_ACCOUNT", accountId: "acct-a", text: "private-a text" },
  "private-b": { id: "private-b", visibility: "PRIVATE_ACCOUNT", accountId: "acct-b", text: "private-b text" },
};

describe("authorized SSE feed", () => {
  it("reloads and projects event IDs instead of trusting fan-out payloads", async () => {
    const loaded: string[] = [];
    const stream = openFeedStream({
      actor: { role: "ACCOUNT", accountId: "acct-a" },
      eventIds: ["public-1", "private-a", "private-b"],
      load: async (id) => { loaded.push(id); return fixtures[id]; },
    });
    const items = await stream.collect();
    expect(loaded).toEqual(["public-1", "private-a", "private-b"]);
    expect(items.map((item) => item.id)).toEqual(["public-1", "private-a"]);
    expect(JSON.stringify(items)).not.toContain("private-b text");
    expect(stream.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
```

Expected initial state: the test exits 1 because event-ID fan-out, per-event reload/authorization, resume cursor, and SSE headers do not exist.

#### Green — minimum implementation

- Subscribe to event IDs only, reload each event through the server DAL, authorize, project the minimum DTO, and emit SSE frames.
- Authenticate every connection, revalidate entitlement, support `Last-Event-ID`, send bounded heartbeats, and close revoked/expired sessions.
- Never put protected event bodies on the Valkey pub/sub channel.

#### Refactor

- Reuse the T4 projector and keep transport framing independent from authorization.

#### Verify

Command: `pnpm vitest run tests/stream/sse-authorization.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It adds delivery transport over an already-tested DTO boundary.

---

### T28 — Build a public shell that never ships protected words

**Maps to:** R1, R7, R11, R80
**Files touched:** `app/layout.tsx` (new), `app/(marketing)/page.tsx` (new), `components/feed/PublicFeed.tsx` (new), `tests/ui/public-home.test.tsx` (new)

#### Red — failing test

File: `tests/ui/public-home.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PublicHome from "../../app/(marketing)/page";

describe("public homepage", () => {
  it("shows Gustavo and activity placeholders without protected words", async () => {
    render(await PublicHome());
    expect(screen.getByRole("heading", { name: "Gustavo" })).toBeVisible();
    expect(screen.getByText("The market thinks out loud.")).toBeVisible();
    expect(screen.getAllByTestId("feed-placeholder").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("private thesis text");
  });
});
```

Expected initial state: the test exits 1 because the application routes and components do not exist.

#### Green — minimum implementation

- Build an accessible public shell using safe metadata/placeholder geometry only, with no hidden protected text in HTML, RSC payload, attributes, or scripts.
- Show Gustavo, the canonical domain, working tagline, timestamped safe activity metadata, educational-market-commentary boundary, and software-memory/non-sentience disclosure.
- Consume only the public DTO from T4; the page never receives ciphertext or plaintext protected bodies.

#### Refactor

- Keep all server data in role-specific DTOs and make Client Components receive only presentation-ready fields.

#### Verify

Command: `pnpm vitest run tests/ui/public-home.test.tsx`

Expected: the public component test passes with exit code 0.

#### Reviewable as a unit?

Yes. It contains only the unauthenticated product surface.

---

### T29 — Build the private chat, memory controls, and Challenge views

**Maps to:** R27, R35, R50
**Files touched:** `app/(account)/chat/page.tsx` (new), `app/(challenge)/challenge/page.tsx` (new), `components/chat/Conversation.tsx` (new), `components/memory/MemoryControls.tsx` (new), `components/challenge/ChallengeSummary.tsx` (new), `tests/ui/account-surfaces.test.tsx` (new)

#### Red — failing test

File: `tests/ui/account-surfaces.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Conversation } from "../../components/chat/Conversation";
import { ChallengeSummary } from "../../components/challenge/ChallengeSummary";

describe("authenticated account surfaces", () => {
  it("labels Node routing, Main authorship, memory controls, and simulation", () => {
    render(<>
      <Conversation messages={[{ id: "m1", author: "MAIN_BRAIN", routingMode: "MAIN_DEFAULT", text: "Completed support remains intact." }]} proposalDisclosure />
      <ChallengeSummary stage={{ startingBalance: "2500.00", targetEquity: "2750.00", equity: "2500.00", status: "ACTIVE" }} />
    </>);
    expect(screen.getByText("Main Brain")).toBeVisible();
    expect(screen.getByText("MAIN_DEFAULT")).toBeVisible();
    expect(screen.getByText(/qualifying feedback may be summarized/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Inspect memories" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export my data" })).toBeVisible();
    expect(screen.getByText("SIMULATION ONLY — NOT A REAL TRADE")).toBeVisible();
    expect(screen.getByText("$2,500.00 → $2,750.00")).toBeVisible();
  });
});
```

Expected initial state: the test exits 1 because the authenticated chat, memory-control, and Challenge components do not exist.

#### Green — minimum implementation

- Build the one-chat account surface with routing-mode/proposal status, Main-authored broadcast attribution, paginated history, and the qualifying-feedback disclosure.
- Add memory source inspection, correction, forget, and export controls wired to T26 authorizations.
- Add the shared Challenge stage/equity/target, paper positions, ledger history, timestamps, costs, and exact simulation-only label using account-safe DTOs.

#### Refactor

- Keep mutation forms isolated from read-only projections and invalidate them from server responses rather than client assumptions.

#### Verify

Command: `pnpm vitest run tests/ui/account-surfaces.test.tsx`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It contains only authenticated presentation over already-reviewed APIs.

---

### T30 — Run locally with encrypted verified backup and isolated restore

**Maps to:** R17, R18, R19, R57
**Files touched:** `infra/compose.yaml` (new), `infra/env.example` (new), `infra/backup/create.ps1` (new), `infra/backup/verify.ps1` (new), `infra/backup/restore-drill.ps1` (new), `docs/OPERATIONS.md` (new), `tests/infra/compose-backup.test.ts` (new)

#### Red — failing test

File: `tests/infra/compose-backup.test.ts`

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("local runtime and backup contract", () => {
  it("keeps state durable and public exposure away from database services", async () => {
    const compose = parse(await readFile("infra/compose.yaml", "utf8"));
    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining(["web", "worker", "postgres", "valkey"]));
    expect(compose.services.postgres.ports).toBeUndefined();
    expect(compose.services.valkey.ports).toBeUndefined();
    expect(Object.keys(compose.volumes)).toContain("postgres-data");
  });

  it("provides create, verify, and isolated restore commands", async () => {
    for (const file of ["infra/backup/create.ps1", "infra/backup/verify.ps1", "infra/backup/restore-drill.ps1"]) {
      expect((await readFile(file, "utf8")).length).toBeGreaterThan(100);
    }
  });
});
```

Expected initial state: the test exits 1 because Compose, durable volumes, backup scripts, and the operations runbook do not exist.

#### Green — minimum implementation

- Define web, worker, PostgreSQL with vector extension, and Valkey services with health checks, restart policy, local durable volumes, internal networking, and no direct database/queue publication.
- Create database-consistent encrypted S3-compatible backups with manifest, checksum, schema version, event high-water, key version, and least-privilege credentials outside the archive.
- Verify every backup and restore into a separately named isolated database; document HTTPS reverse-proxy/outbound-tunnel setup while leaving Squarespace DNS changes as an operator step.

#### Refactor

- Share manifest validation between backup verification and restore drill.

#### Verify

Command: `pnpm vitest run tests/infra/compose-backup.test.ts && docker compose -f infra/compose.yaml config --quiet && powershell -NoProfile -File infra/backup/restore-drill.ps1 -UseFixture`

Expected: 2 passing tests, valid Compose configuration, successful fixture restore with matching checksum/high-water mark, and exit code 0.

#### Reviewable as a unit?

Yes. It packages established services and proves recoverability without publishing them.

---

### T31 — Measure durability, cache, recall, queue, and model health budgets

**Maps to:** R19, R25, R59, R78
**Files touched:** `lib/server/observability/metrics.ts` (new), `app/api/operator/health/route.ts` (new), `tests/performance/seed-million.ts` (new), `tests/performance/recall-latency.test.ts` (new), `docs/PERFORMANCE.md` (new)

#### Red — failing test

File: `tests/performance/recall-latency.test.ts`

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { seedMillionMemoryFixture } from "./seed-million";
import { benchmarkRecall } from "../../lib/server/observability/metrics";

describe("reference recall budgets", () => {
  beforeAll(async () => seedMillionMemoryFixture(), 600_000);

  it("keeps warm scoped recall and cached handoffs within budget", async () => {
    const result = await benchmarkRecall({ iterations: 200, warmup: 20, excludeModelGeneration: true });
    expect(result.sourceEventCount).toBeGreaterThanOrEqual(1_000_000);
    expect(result.warmRecallP95Ms).toBeLessThanOrEqual(250);
    expect(result.cachedHandoffP95Ms).toBeLessThanOrEqual(100);
    expect(result.unboundedQueries).toBe(0);
  }, 600_000);
});
```

Expected initial state: the test exits 1 because reference fixture generation, latency instrumentation, and operator metrics do not exist.

#### Green — minimum implementation

- Instrument event commit, outbox/queue age, projection freshness, cache hit/miss/stale rejection, fallback-query latency, rebuild throughput, model latency/cost, and divergence.
- Add a reproducible one-million-event fixture with known-answer, conflict, temporal, permission, provenance, and stale-memory query cases.
- Publish authenticated operator health metrics and benchmark p50/p95/p99, cache state, machine profile, and query plans.

#### Refactor

- Keep metric names and labels bounded to avoid per-account or per-symbol cardinality explosions.

#### Verify

Command: `pnpm vitest run tests/performance/recall-latency.test.ts --testTimeout=600000`

Expected: the one-million-event fixture reports warm recall p95 at or below 250 ms, cached handoff p95 at or below 100 ms, zero unbounded queries, and exit code 0.

#### Reviewable as a unit?

Yes. It observes and benchmarks existing paths without changing their semantics.

---

### T32 — Block execution behavior, secrets, unsafe claims, and protected public payloads

**Maps to:** R12, R14, R36, R64, R67
**Files touched:** `scripts/validate.ps1` (replace), `tests/security/static-boundaries.test.ts` (new), `docs/SECURITY.md` (new), `docs/PRIVACY.md` (new), `docs/TERMS.md` (new), `docs/DATA_POLICY.md` (new)

#### Red — failing test

File: `tests/security/static-boundaries.test.ts`

```ts
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { describe, expect, it } from "vitest";
import { projectFeedEvent } from "../../lib/server/dal/feed";

describe("Gustavo static safety boundaries", () => {
  it("contains no execution adapter, public secret, or active prohibited import", async () => {
    const files = await glob(["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "worker/**/*.ts", "policy/**/*.json"], { nodir: true });
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    for (const forbidden of ["trade.cmd", "brokerOrder", "placeRealOrder", "NEXT_PUBLIC_MODEL_KEY", "NEXT_PUBLIC_MARKET_DATA_KEY"]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/PROHIBITED[\s\S]{0,120}active\s*:\s*true/);
  });

  it("keeps protected words out of a serialized public payload", () => {
    const dto = projectFeedEvent({ role: "PUBLIC" }, {
      id: "e1", accountId: "acct-a", type: "brain.response.completed",
      createdAt: "2026-08-09T12:00:00.000Z", protectedText: "secret thesis", topic: "AAPL",
    });
    expect(JSON.stringify(dto)).not.toContain("secret thesis");
  });

  it("ships the public privacy, terms, and data-control disclosures", async () => {
    const privacy = await readFile("docs/PRIVACY.md", "utf8");
    const terms = await readFile("docs/TERMS.md", "utf8");
    const data = await readFile("docs/DATA_POLICY.md", "utf8");
    expect(privacy).toContain("private Node Brain conversation");
    expect(privacy).toContain("export and forgetting");
    expect(terms).toContain("SIMULATION ONLY — NOT A REAL TRADE");
    expect(terms).toContain("not individualized financial advice");
    expect(data).toContain("authorized external chat import");
  });
});
```

Expected initial state: the test exits 1 because the old validation script and repository still describe superseded export/CFT structures and no public payload snapshot test exists.

#### Green — minimum implementation

- Replace legacy validation with JSON/schema checks, forbidden execution/connectivity/credential terms in active code, secret-name scans, lifecycle isolation checks, and required disclaimer checks.
- Snapshot public HTML/RSC/API payloads and prove protected body fixtures never appear.
- Document threat model, operator access audit, key rotation, incident response, rate limits, origin/CSRF protections, and the fact that authorized displayed text can be copied.
- Add public privacy, terms, and data-policy drafts that disclose private Node scope, authorized proposal summaries, external imports, model providers, retention, export/forgetting, delayed data, educational commentary, and simulation-only performance; obtain qualified legal review before public launch.

#### Refactor

- Keep audit-only migration documents excluded through an explicit path allowlist rather than weakening active-code scans.

#### Verify

Command: `pnpm vitest run tests/security/static-boundaries.test.ts && powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1 && git diff --check`

Expected: all security tests pass, repository validation exits 0, and `git diff --check` reports no whitespace errors.

#### Reviewable as a unit?

Yes. It is an independent safety gate over the completed tree.

---

### T33 — Open scheduled Main broadcast cycles idempotently

**Maps to:** R15, R44
**Files touched:** `db/migrations/0019_broadcast_schedules.sql` (new), `lib/server/main-brain/schedules.ts` (new), `worker/broadcasts/scheduler.ts` (new), `tests/broadcasts/scheduler.test.ts` (new)

#### Red — failing test

File: `tests/broadcasts/scheduler.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { openDueBroadcastCycles } from "../../lib/server/main-brain/schedules";
import { testContext } from "../helpers/postgres";

describe("Main broadcast scheduler", () => {
  it("opens one durable cycle for one due schedule slot across retries", async () => {
    const ctx = await testContext();
    await ctx.db.query("insert into broadcast_schedules(id, cron, timezone, enabled) values ($1,$2,$3,true)", ["market-cycle", "*/15 * * * 1-5", "UTC"]);
    await openDueBroadcastCycles(ctx, new Date("2026-08-10T14:30:00.000Z"));
    await openDueBroadcastCycles(ctx, new Date("2026-08-10T14:30:00.000Z"));
    expect(await ctx.db.one("select count(*)::int as count from broadcast_cycles where schedule_id=$1 and slot_at=$2", ["market-cycle", "2026-08-10T14:30:00.000Z"]))
      .toEqual({ count: 1 });
    expect(await ctx.db.one("select author_type from broadcast_cycles where schedule_id=$1", ["market-cycle"]))
      .toEqual({ author_type: "MAIN_BRAIN" });
  });
});
```

Expected initial state: the test exits 1 because persisted schedules, unique schedule slots, and the scheduler worker do not exist.

#### Green — minimum implementation

- Add operator-managed versioned cron schedules, timezone, enabled state, next-run projection, cycle slots, and uniqueness on schedule/slot.
- Let the worker open a cycle and snapshot current Main/policy/market-data versions; retries replay the same cycle ID.
- Queue Main generation through T6 and commit through T8; no Node may become scheduled-message author.

#### Refactor

- Keep cron calculation pure and clock-injected so daylight/time-boundary cases remain deterministic.

#### Verify

Command: `pnpm vitest run tests/broadcasts/scheduler.test.ts`

Expected: 1 passing test and exit code 0.

#### Reviewable as a unit?

Yes. It adds only schedule-to-cycle orchestration over existing broadcast behavior.

---

### T34 — Prove the complete Main/Node/memory/Challenge vertical slice

**Maps to:** R1–R87
**Files touched:** `playwright.config.ts` (new), `tests/e2e/gustavo-vertical-slice.spec.ts` (new), `tests/e2e/fixtures.ts` (new), `docs/SMOKE_TEST.md` (new)

#### Red — failing test

File: `tests/e2e/gustavo-vertical-slice.spec.ts`

```ts
import { expect, test } from "@playwright/test";
import { issueInvitation, seedLicensedObservation, waitForEvent } from "./fixtures";

test("one account contributes a better idea to the shared simulated Challenge", async ({ page, request }) => {
  const invitation = await issueInvitation(request);
  await page.goto(`/join?token=${invitation}`);
  await page.getByLabel("Display name").fill("Ada");
  await page.getByLabel("Passphrase").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Your Node Brain" })).toBeVisible();

  await seedLicensedObservation(request, { symbol: "AAPL", price: "100.00", feedStatus: "DELAYED", delaySeconds: 900 });
  await page.getByLabel("Message").fill("The completed close rejects resistance; compare that with the Main view.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Proposal sent to the Main Brain")).toBeVisible();

  const selected = await waitForEvent(request, "decision.selected");
  expect(selected).toMatchObject({ winnerType: "NODE", mainScore: 82, winnerScore: 87, rubricVersion: "v1" });
  await page.goto("/challenge");
  await expect(page.getByText("SIMULATION ONLY — NOT A REAL TRADE")).toBeVisible();
  await expect(page.getByText("$2,500.00 → $2,750.00")).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/");
  await expect(page.getByTestId("public-feed")).not.toContainText("The completed close rejects resistance");
});
```

Expected initial state: the test exits 1 because no integrated Gustavo application or browser fixture exists.

#### Green — minimum implementation

- Wire the approved routes, workers, database, Valkey, deterministic model and market-data fixtures, evaluator, Challenge engine, memory jobs, SSE, and pages into one isolated E2E stack.
- Seed a committed Main score of 82 and a hard-gate-passing Node score of 87 so the exact 5-point rule produces one internal paper intent while keeping all real execution absent.
- Document the corresponding human smoke path: invitation, one chat, Main/Node labeling, proposal provenance, Challenge simulation, memory inspection, public redaction, cache restart, and backup restore.

#### Refactor

- Keep E2E fixture endpoints compiled only under the test environment and fail production startup if they are enabled.

#### Verify

Command: `pnpm playwright test tests/e2e/gustavo-vertical-slice.spec.ts && pnpm test && pnpm exec tsc --noEmit && pnpm build`

Expected: the vertical slice passes, all unit/integration tests pass, TypeScript exits 0, the production build succeeds, and the combined command exits 0.

#### Reviewable as a unit?

Yes. It adds only integration wiring and acceptance proof over previously reviewed subsystems.

---

## Plan self-review

- [x] Every requirement appears in the requirement-to-task map.
- [x] Every task has red, green, refactor, and verify sections with exact paths and expected outcomes.
- [x] Every listed test file has complete failing assertions in its task or has been removed from that task.
- [x] No placeholders or vague implementation verbs remain.
- [x] Each task is independently reviewable and isolates one subsystem.
- [x] File paths match the approved architecture and final repository name.
- [x] Shared-file edits have an explicit dependency order.
- [x] Verify commands are exact and name their expected exit state.
- [x] Failing-test descriptions identify the absent contract or expected assertion.
- [x] Challenge arithmetic uses fixed decimals or integer cents and the approved versioned policy.
- [x] Authorization precedes retrieval, graph expansion, cache access, and DTO projection.
- [x] No task introduces real execution, broker/prop integration, credentials, or protected public text.

Audit result: 87 unique requirement mappings, 34 sequential tasks, 34 red/green/refactor/verify sets, 34 listed test files with 34 complete test snippets, no forbidden placeholder phrases, and a clean `git diff --check`.

## Exit gate

Plan approved. Next: `mcax-execute`. Execution is intentionally not started while the user remains in planning mode.
