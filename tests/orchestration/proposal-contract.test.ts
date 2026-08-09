import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDatabase } from "../../lib/server/events/types";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import { appendMessage } from "../../lib/server/history/messages";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import {
  MAX_CLARIFICATION_TURNS,
  MAX_REVIEW_TURNS,
  MAX_PROPOSAL_STATUS_TRANSITIONS,
  addProposalTurn,
  createDisclosureAuthorization,
  createProposal,
  getProposal,
  revokeDisclosureAuthorization,
  transitionProposal,
} from "../../lib/server/orchestration/proposals";
import {
  createConversationFixture,
  type ConversationFixture,
} from "../helpers/postgres";

const routeState = vi.hoisted(() => ({
  db: undefined as EventDatabase | undefined,
}));

vi.mock("../../lib/server/db/postgres", () => ({
  getDatabase(): EventDatabase {
    if (!routeState.db) throw new Error("TEST_DATABASE_NOT_READY");
    return routeState.db;
  },
}));

import { POST } from "../../app/api/proposals/route";

interface ProposalFixture extends ConversationFixture {
  readonly sourceEventId: string;
  readonly routeEventId: string;
  readonly mainStateId: string;
}

let nextMainStateVersion = 10_000;

async function proposalFixture(
  label: string,
  database?: ConversationFixture["db"],
): Promise<ProposalFixture> {
  const fixture = await createConversationFixture(label, database);
  const source = await appendMessage(fixture, {
    idempotencyKey: `${label}-source`,
    role: "USER",
    text: `Private source for ${label}: must never persist without scoped authorization. Private code LYNX7 Q7; user name Ada Lovelace; SSN 123-45-6789.`,
  });
  const mainStateId = String(nextMainStateVersion++);
  await fixture.db.query(
    "insert into main_state_versions(version, author_type, author_id, status) values ($1, 'MAIN_BRAIN', 'gustavo-main', 'COMMITTED')",
    [mainStateId],
  );
  const routed = await routeNodeReply(
    {
      db: fixture.db,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      userMessageEventId: source.eventId,
      coveredByMain: false,
      contradiction: true,
      materialEvidence: true,
      confidence: 0.95,
      mainStateVersion: mainStateId,
      sourceIds: [source.eventId],
    },
    async () => undefined,
  );
  return {
    ...fixture,
    sourceEventId: source.eventId,
    routeEventId: routed.routingEventId,
    mainStateId,
  };
}

function proposalInput(
  fixture: ProposalFixture,
  overrides: Partial<Parameters<typeof createProposal>[1]> = {},
): Parameters<typeof createProposal>[1] {
  return {
    accountId: fixture.accountId,
    nodeBrainId: fixture.nodeBrainId,
    conversationId: fixture.conversationId,
    sourceEventIds: [fixture.sourceEventId],
    routeEventId: fixture.routeEventId,
    affectedMainStateIds: [fixture.mainStateId],
    privacyScope: "PROPOSAL_SUMMARY",
    proposedChange: "Treat the completed close as rejection.",
    evidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
    counterevidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
    uncertainty: "Volume confirmation is weak.",
    rawPrivateText: "must never persist without scoped authorization",
    idempotencyKey: `${fixture.accountId}-proposal-1`,
    ...overrides,
  } as Parameters<typeof createProposal>[1];
}

async function completedEvaluatorRun(
  fixture: ProposalFixture,
  label: string,
  causationId: string,
): Promise<string> {
  const id = randomUUID();
  await fixture.db.query(
    `insert into model_runs (
       id, role, provider, model, prompt_version, policy_version,
       correlation_id, causation_id, input_tokens, output_tokens, max_input_tokens,
       max_output_tokens, completion_status, completed_at
     ) values ($1,'EVALUATOR','test-provider','test-evaluator','proposal-review-v1',
               $2,$3,$4,1,1,1024,256,'COMPLETED',clock_timestamp())`,
    [id, `evaluator-${label}`, randomUUID(), causationId],
  );
  return id;
}

function proposalRequest(
  fixture: ProposalFixture,
  body: unknown,
  origin = "https://gustavo.lol",
): Request {
  return new Request("https://gustavo.lol/api/proposals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `__Host-gustavo-session=${fixture.sessionToken}`,
      origin,
    },
    body: JSON.stringify(body),
  });
}

function guardedDatabase(database: EventDatabase): EventDatabase {
  const assertNoAuthorityWrite = (sql: string): void => {
    if (/\b(insert\s+into|update|delete\s+from)\s+(main_state_versions|broadcasts|challenge\w*)\b/i.test(sql)) {
      throw new Error("PROPOSAL_AUTHORITY_WRITE_FORBIDDEN");
    }
  };
  const wrap = (db: EventDatabase): EventDatabase => ({
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> {
      assertNoAuthorityWrite(sql);
      return db.query<Row>(sql, parameters);
    },
    async one<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row> {
      assertNoAuthorityWrite(sql);
      return db.one<Row>(sql, parameters);
    },
    transaction<Result>(work: (transaction: EventDatabase) => Promise<Result>): Promise<Result> {
      return db.transaction((transaction) => work(wrap(transaction)));
    },
  });
  return wrap(database);
}

function rejectCiphertextReadFor(database: EventDatabase, eventId?: string): EventDatabase {
  const wrap = (db: EventDatabase): EventDatabase => ({
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row[]> {
      if (/from\s+encrypted_event_bodies\s+where\s+event_id=\$1/i.test(sql)
        && (eventId === undefined || parameters?.[0] === eventId)) {
        throw new Error("PRIVATE_TEXT_READ_BEFORE_AUTHORIZATION");
      }
      return db.query<Row>(sql, parameters);
    },
    one<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<Row> {
      if (/from\s+encrypted_event_bodies\s+where\s+event_id=\$1/i.test(sql)
        && (eventId === undefined || parameters?.[0] === eventId)) {
        throw new Error("PRIVATE_TEXT_READ_BEFORE_AUTHORIZATION");
      }
      return db.one<Row>(sql, parameters);
    },
    transaction<Result>(work: (transaction: EventDatabase) => Promise<Result>): Promise<Result> {
      return db.transaction((transaction) => work(wrap(transaction)));
    },
  });
  return wrap(database);
}

beforeEach(() => {
  vi.stubEnv("GUSTAVO_COUNCIL_PSEUDONYM_KEY", randomBytes(32).toString("base64"));
});

afterEach(() => {
  routeState.db = undefined;
  vi.unstubAllEnvs();
});

describe("Node proposal contract", () => {
  it("stores canonical source-linked evidence without copying unauthorized private text", async () => {
    const fixture = await proposalFixture("proposal-private");
    const proposal = await createProposal(
      { db: guardedDatabase(fixture.db) },
      proposalInput(fixture, {
        evidence: [
          { kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId },
          { kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId },
        ],
      }),
    );

    expect(proposal).toMatchObject({
      nodeBrainId: fixture.nodeBrainId,
      sourceEventIds: [fixture.sourceEventId],
      routeEventId: fixture.routeEventId,
      affectedMainStateIds: [fixture.mainStateId],
      privacyScope: "PROPOSAL_SUMMARY",
      status: "PENDING_REVIEW",
      evidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
    });
    expect(proposal.rawPrivateText).toBeUndefined();
    expect(proposal.councilMemberId).toMatch(/^member_[a-f0-9]{20}$/);
    expect(proposal.councilMemberId).not.toContain(fixture.accountId);
    expect(proposal).not.toHaveProperty("accountId");

    expect(
      await fixture.db.one(
        `select
           count(distinct proposal.id)::int as proposal_count,
           count(distinct event.id)::int as event_count,
           count(distinct outbox.id)::int as outbox_count
         from proposals proposal
         join events event on event.id=proposal.created_event_id
         join transactional_outbox outbox on outbox.event_id=event.id
         where proposal.id=$1`,
        [proposal.id],
      ),
    ).toEqual({ proposal_count: 1, event_count: 1, outbox_count: 1 });
    expect(
      await fixture.db.one(
        `select
           count(*) filter (where position(convert_to($1, 'UTF8') in body.ciphertext) > 0)::int as plaintext_hits,
           count(*) filter (where column_name in ('proposed_change', 'uncertainty', 'raw_private_text', 'body'))::int as plaintext_columns
         from encrypted_event_bodies body
         cross join information_schema.columns columns
         where body.event_id=$2
           and columns.table_schema=current_schema()
           and columns.table_name in ('proposals', 'proposal_turns', 'proposal_evidence_links')`,
        ["must never persist without scoped authorization", proposal.createdEventId],
      ),
    ).toEqual({ plaintext_hits: 0, plaintext_columns: 0 });
  }, 30_000);

  it("requires an active account/Node/conversation graph and native private source events", async () => {
    const owner = await proposalFixture("proposal-owner");
    const other = await proposalFixture("proposal-other", owner.db);

    for (const override of [
      { accountId: other.accountId },
      { nodeBrainId: other.nodeBrainId },
      { conversationId: other.conversationId },
      { sourceEventIds: [other.sourceEventId] },
    ]) {
      await expect(
        createProposal({ db: owner.db }, proposalInput(owner, {
          ...override,
          idempotencyKey: randomUUID(),
        })),
      ).rejects.toThrow("PROPOSAL_SOURCE_FORBIDDEN");
    }

    await owner.db.query("update node_brains set status='PAUSED' where id=$1", [owner.nodeBrainId]);
    await expect(
      createProposal({ db: owner.db }, proposalInput(owner, { idempotencyKey: randomUUID() })),
    ).rejects.toThrow("PROPOSAL_SOURCE_FORBIDDEN");
    expect(await owner.db.one("select count(*)::int as count from proposals")).toEqual({ count: 0 });
  }, 30_000);

  it("authorizes the current account graph before reading any private proposal ciphertext", async () => {
    const fixture = await proposalFixture("proposal-read-authorization");
    const proposal = await createProposal(
      { db: fixture.db }, proposalInput(fixture, { rawPrivateText: undefined }),
    );
    const guarded = rejectCiphertextReadFor(fixture.db);

    await fixture.db.query(
      "update entitlements set revoked_at=clock_timestamp() where account_id=$1",
      [fixture.accountId],
    );
    await expect(getProposal(
      { db: guarded }, { accountId: fixture.accountId, proposalId: proposal.id },
    )).rejects.toThrow("PROPOSAL_SOURCE_FORBIDDEN");
    await fixture.db.query("update entitlements set revoked_at=null where account_id=$1", [fixture.accountId]);

    await fixture.db.query("update accounts set status='SUSPENDED' where id=$1", [fixture.accountId]);
    await expect(getProposal(
      { db: guarded }, { accountId: fixture.accountId, proposalId: proposal.id },
    )).rejects.toThrow("PROPOSAL_SOURCE_FORBIDDEN");
    await fixture.db.query("update accounts set status='ACTIVE' where id=$1", [fixture.accountId]);

    await fixture.db.query("update node_brains set status='PAUSED' where id=$1", [fixture.nodeBrainId]);
    await expect(getProposal(
      { db: guarded }, { accountId: fixture.accountId, proposalId: proposal.id },
    )).rejects.toThrow("PROPOSAL_SOURCE_FORBIDDEN");
    await fixture.db.query("update node_brains set status='ACTIVE' where id=$1", [fixture.nodeBrainId]);

    await fixture.db.query("update conversations set status='ARCHIVED' where id=$1", [fixture.conversationId]);
    await expect(getProposal(
      { db: guarded }, { accountId: fixture.accountId, proposalId: proposal.id },
    )).rejects.toThrow("PROPOSAL_SOURCE_FORBIDDEN");
    await fixture.db.query("update conversations set status='OPEN' where id=$1", [fixture.conversationId]);

    const other = await proposalFixture("proposal-read-other-account", fixture.db);
    await expect(getProposal(
      { db: guarded }, { accountId: other.accountId, proposalId: proposal.id },
    )).rejects.toThrow("PROPOSAL_NOT_FOUND");
  }, 30_000);

  it("rejects private-source copying unless exact text, scope, purpose, and source set are authorized", async () => {
    const fixture = await proposalFixture("proposal-copy-boundary");
    const sourceText = "Private source for proposal-copy-boundary";
    for (const [index, [field, value]] of [
      ["proposedChange", "Use LYNX7 in Main context."],
      ["uncertainty", "Q7"],
      ["uncertainty", "Ada"],
      ["uncertainty", "Lovelace"],
      ["uncertainty", "123-45-6789"],
    ].entries()) {
      await expect(
        createProposal(
          { db: fixture.db },
          proposalInput(fixture, {
            [field]: value,
            rawPrivateText: undefined,
            idempotencyKey: `proposal-short-private-copy-${index}`,
          }),
        ),
      ).rejects.toThrow("PROPOSAL_PRIVATE_TEXT_DISCLOSURE_REQUIRED");
    }
    await expect(createDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId],
        disclosedText: `Private source for proposal-copy-boundary: must never persist without scoped authorization. Appended text not in the source.`,
        privacyScope: "PROPOSAL_RAW_TEXT",
        purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "copy-appended-text-auth",
      },
    )).rejects.toThrow("PROPOSAL_DISCLOSURE_TEXT_FORBIDDEN");
    await expect(
      createProposal(
        { db: fixture.db },
        proposalInput(fixture, {
          proposedChange: sourceText,
          rawPrivateText: undefined,
          idempotencyKey: "proposal-copy-without-disclosure",
        }),
      ),
    ).rejects.toThrow("PROPOSAL_PRIVATE_TEXT_DISCLOSURE_REQUIRED");

    const wrongDigest = await createDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId],
        disclosedText: "must never persist without scoped authorization",
        privacyScope: "PROPOSAL_RAW_TEXT",
        purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "copy-wrong-digest-auth",
      } as Parameters<typeof createDisclosureAuthorization>[1],
    );
    await expect(
      createProposal(
        { db: fixture.db },
        proposalInput(fixture, {
          proposedChange: sourceText,
          rawPrivateText: sourceText,
          privacyScope: "PROPOSAL_RAW_TEXT",
          disclosureAuthorizationId: wrongDigest.id,
          idempotencyKey: "proposal-copy-wrong-digest",
        } as Partial<Parameters<typeof createProposal>[1]>),
      ),
    ).rejects.toThrow("PROPOSAL_DISCLOSURE_FORBIDDEN");

    const exact = await createDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId],
        disclosedText: sourceText,
        privacyScope: "PROPOSAL_RAW_TEXT",
        purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "copy-exact-auth",
      } as Parameters<typeof createDisclosureAuthorization>[1],
    );
    const disclosedProposal = await createProposal(
      { db: fixture.db },
      proposalInput(fixture, {
        proposedChange: sourceText,
        rawPrivateText: sourceText,
        privacyScope: "PROPOSAL_RAW_TEXT",
        disclosureAuthorizationId: exact.id,
        idempotencyKey: "proposal-copy-exact",
      } as Partial<Parameters<typeof createProposal>[1]>),
    );
    expect(disclosedProposal).toMatchObject({ proposedChange: sourceText, rawPrivateText: sourceText });
    const privateTextEvent = await fixture.db.one<{ readonly event_id: string }>(
      "select raw_private_text_event_id::text as event_id from proposals where id=$1",
      [disclosedProposal.id],
    );
    await revokeDisclosureAuthorization(
      { db: fixture.db },
      { accountId: fixture.accountId, authorizationId: exact.id, idempotencyKey: "revoke-copy-exact" },
    );
    await expect(getProposal(
      { db: rejectCiphertextReadFor(fixture.db, privateTextEvent.event_id) },
      { accountId: fixture.accountId, proposalId: disclosedProposal.id },
    )).resolves.toMatchObject({ proposedChange: "[REDACTED PRIVATE TEXT]" });
  }, 30_000);

  it("allows an exact short private value only after a scoped disclosure authorization", async () => {
    const fixture = await proposalFixture("proposal-short-disclosure");
    const authorization = await createDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId],
        disclosedText: "Q7",
        privacyScope: "PROPOSAL_RAW_TEXT",
        purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "short-private-disclosure-auth",
      },
    );
    await expect(createProposal(
      { db: fixture.db },
      proposalInput(fixture, {
        proposedChange: "Q7",
        rawPrivateText: "Q7",
        privacyScope: "PROPOSAL_RAW_TEXT",
        disclosureAuthorizationId: authorization.id,
        idempotencyKey: "short-private-disclosure-proposal",
      }),
    )).resolves.toMatchObject({ proposedChange: "Q7", rawPrivateText: "Q7" });
  }, 30_000);

  it("allows an exact multi-token private value only after scoped disclosure", async () => {
    const fixture = await proposalFixture("proposal-multi-token-disclosure");
    for (const [index, disclosedText] of ["Ada Lovelace", "LYNX7 Q7"].entries()) {
      const authorization = await createDisclosureAuthorization(
        { db: fixture.db },
        {
          accountId: fixture.accountId,
          conversationId: fixture.conversationId,
          sourceEventIds: [fixture.sourceEventId],
          disclosedText,
          privacyScope: "PROPOSAL_RAW_TEXT",
          purpose: "MAIN_PROPOSAL_REVIEW",
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: `multi-token-private-disclosure-${index}`,
        },
      );
      expect(authorization.disclosedTextDigest).toMatch(/^[a-f0-9]{64}$/);
      if (index === 0) {
        await expect(createProposal(
          { db: fixture.db },
          proposalInput(fixture, {
            proposedChange: disclosedText,
            rawPrivateText: disclosedText,
            privacyScope: "PROPOSAL_RAW_TEXT",
            disclosureAuthorizationId: authorization.id,
            idempotencyKey: "multi-token-private-disclosure-proposal",
          }),
        )).resolves.toMatchObject({ proposedChange: disclosedText, rawPrivateText: disclosedText });
      }
    }
  }, 30_000);

  it("resolves every evidence kind and forbids cross-account or unresolved source references", async () => {
    const owner = await proposalFixture("proposal-evidence-owner");
    const other = await proposalFixture("proposal-evidence-other", owner.db);
    for (const evidence of [
      [{ kind: "SOURCE_EVENT", referenceId: other.sourceEventId }],
      [{ kind: "SOURCE_EVENT", referenceId: randomUUID() }],
      [{ kind: "COMMENTARY", referenceId: randomUUID() }],
      [{ kind: "PROPOSAL", referenceId: randomUUID() }],
    ] as const) {
      await expect(
        createProposal(
          { db: owner.db },
          proposalInput(owner, {
            evidence,
            rawPrivateText: undefined,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toThrow("PROPOSAL_EVIDENCE_FORBIDDEN");
    }
    for (const referenceId of ["arbitrary-market-text", "sk_live_super_secret_token_123"]) {
      await expect(
        createProposal(
          { db: owner.db },
          proposalInput(owner, {
            evidence: [{ kind: "MARKET_EVENT", referenceId }],
            rawPrivateText: undefined,
            idempotencyKey: `unavailable-market-reference-${referenceId}`,
          }),
        ),
      ).rejects.toThrow("PROPOSAL_EVIDENCE_KIND_UNAVAILABLE");
    }
    expect(await owner.db.one("select count(*)::int as count from proposals")).toEqual({ count: 0 });
  }, 30_000);

  it("requires an existing affected Main state and the exact durable PROPOSAL_UPSTREAM route", async () => {
    const fixture = await proposalFixture("proposal-route-gate");
    await expect(
      createProposal(
        { db: fixture.db },
        proposalInput(fixture, {
          affectedMainStateIds: ["99999999"],
          rawPrivateText: undefined,
          idempotencyKey: "proposal-missing-main-state",
        } as Partial<Parameters<typeof createProposal>[1]>),
      ),
    ).rejects.toThrow("PROPOSAL_MAIN_STATE_FORBIDDEN");

    const exploring = await appendMessage(fixture, {
      idempotencyKey: "proposal-route-gate-explore-source",
      role: "USER",
      text: "Explore only",
    });
    const exploreRoute = await routeNodeReply(
      {
        db: fixture.db,
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        nodeBrainId: fixture.nodeBrainId,
        userMessageEventId: exploring.eventId,
        coveredByMain: false,
        contradiction: true,
        materialEvidence: false,
        confidence: 0.95,
        mainStateVersion: fixture.mainStateId,
        sourceIds: [exploring.eventId],
      },
      async () => undefined,
    );
    await expect(
      createProposal(
        { db: fixture.db },
        proposalInput(fixture, {
          sourceEventIds: [exploring.eventId],
          routeEventId: exploreRoute.routingEventId,
          rawPrivateText: undefined,
          idempotencyKey: "proposal-from-explore-route",
        } as Partial<Parameters<typeof createProposal>[1]>),
      ),
    ).rejects.toThrow("PROPOSAL_ROUTE_FORBIDDEN");
  }, 30_000);

  it("uses one numeric canonical order for affected Main states in the app and database", async () => {
    const fixture = await proposalFixture("proposal-main-state-order");
    await fixture.db.query(
      `insert into main_state_versions(version, author_type, author_id, status)
       values (99999, 'MAIN_BRAIN', 'gustavo-main', 'COMMITTED'),
              (100000, 'MAIN_BRAIN', 'gustavo-main', 'COMMITTED')`,
    );

    await expect(
      createProposal(
        { db: fixture.db },
        proposalInput(fixture, {
          affectedMainStateIds: ["100000", fixture.mainStateId, "99999"],
          rawPrivateText: undefined,
          idempotencyKey: "proposal-numeric-main-state-order",
        }),
      ),
    ).resolves.toMatchObject({
      affectedMainStateIds: [fixture.mainStateId, "99999", "100000"],
    });
    await expect(
      fixture.db.one<{ readonly canonical: boolean }>(
        "select proposal_main_state_array_is_canonical($1::jsonb) as canonical",
        [JSON.stringify(["99999", "100000"])],
      ),
    ).resolves.toEqual({ canonical: true });
    await expect(
      fixture.db.one<{ readonly canonical: boolean }>(
        "select proposal_main_state_array_is_canonical($1::jsonb) as canonical",
        [JSON.stringify(["100000", "99999"])],
      ),
    ).resolves.toEqual({ canonical: false });
  }, 30_000);

  it("includes private text only under a scoped, live, separately persisted authorization", async () => {
    const fixture = await proposalFixture("proposal-disclosure");
    const authorization = await createDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId],
        disclosedText: "must never persist without scoped authorization",
        privacyScope: "PROPOSAL_RAW_TEXT",
        purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "disclosure-live",
      },
    );
    const proposal = await createProposal(
      { db: fixture.db },
      proposalInput(fixture, {
        disclosureAuthorizationId: authorization.id,
        privacyScope: "PROPOSAL_RAW_TEXT",
        idempotencyKey: "proposal-with-disclosure",
      }),
    );
    expect(proposal.rawPrivateText).toBe("must never persist without scoped authorization");
    const createdBody = await readEventBody(
      fixture.db, proposal.createdEventId, { actor: { role: "SYSTEM" } },
    );
    expect(createdBody).toMatchObject({ disclosureAuthorizationId: authorization.id });
    expect(createdBody).not.toHaveProperty("rawPrivateText");
    const privateTextEvent = await fixture.db.one<{ readonly raw_private_text_event_id: string }>(
      "select raw_private_text_event_id::text from proposals where id=$1",
      [proposal.id],
    );
    expect(
      await readEventBody(fixture.db, privateTextEvent.raw_private_text_event_id, { actor: { role: "SYSTEM" } }),
    ).toEqual({ rawPrivateText: "must never persist without scoped authorization" });
    expect(
      await fixture.db.one(
        "select position(convert_to($1, 'UTF8') in ciphertext)::int as plaintext_position from encrypted_event_bodies where event_id=$2",
        ["must never persist without scoped authorization", privateTextEvent.raw_private_text_event_id],
      ),
    ).toEqual({ plaintext_position: 0 });

    const wrongSource = await appendMessage(fixture, {
      idempotencyKey: "disclosure-wrong-source",
      role: "USER",
      text: "Different private source",
    });
    const wrongSourceRoute = await routeNodeReply(
      {
        db: fixture.db,
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        nodeBrainId: fixture.nodeBrainId,
        userMessageEventId: wrongSource.eventId,
        coveredByMain: false,
        contradiction: true,
        materialEvidence: true,
        confidence: 0.95,
        mainStateVersion: fixture.mainStateId,
        sourceIds: [wrongSource.eventId],
      },
      async () => undefined,
    );
    await expect(
      createProposal({ db: fixture.db }, proposalInput(fixture, {
        sourceEventIds: [wrongSource.eventId],
        routeEventId: wrongSourceRoute.routingEventId,
        evidence: [{ kind: "SOURCE_EVENT", referenceId: wrongSource.eventId }],
        counterevidence: [{ kind: "SOURCE_EVENT", referenceId: wrongSource.eventId }],
        disclosureAuthorizationId: authorization.id,
        privacyScope: "PROPOSAL_RAW_TEXT",
        idempotencyKey: "proposal-wrong-disclosure-scope",
      })),
    ).rejects.toThrow("PROPOSAL_DISCLOSURE_FORBIDDEN");

    await revokeDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        authorizationId: authorization.id,
        idempotencyKey: "revoke-disclosure-live",
      },
    );
    expect(
      await getProposal({ db: rejectCiphertextReadFor(
        fixture.db, privateTextEvent.raw_private_text_event_id,
      ) }, {
        accountId: fixture.accountId,
        proposalId: proposal.id,
      }),
    ).not.toHaveProperty("rawPrivateText");
    await expect(
      createProposal({ db: fixture.db }, proposalInput(fixture, {
        disclosureAuthorizationId: authorization.id,
        privacyScope: "PROPOSAL_RAW_TEXT",
        idempotencyKey: "proposal-revoked-disclosure",
      })),
    ).rejects.toThrow("PROPOSAL_DISCLOSURE_FORBIDDEN");
  }, 30_000);

  it("redacts authorized private text after its disclosure expires", async () => {
    const fixture = await proposalFixture("proposal-disclosure-expiry");
    const authorization = await createDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId],
        disclosedText: "must never persist without scoped authorization",
        privacyScope: "PROPOSAL_RAW_TEXT",
        purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 750),
        idempotencyKey: "disclosure-short-lived",
      },
    );
    const proposal = await createProposal(
      { db: fixture.db },
      proposalInput(fixture, {
        privacyScope: "PROPOSAL_RAW_TEXT",
        disclosureAuthorizationId: authorization.id,
        idempotencyKey: "proposal-short-lived-disclosure",
      }),
    );
    expect(proposal.rawPrivateText).toBe("must never persist without scoped authorization");
    await fixture.db.query("select pg_sleep(0.8)");
    expect(
      await getProposal({ db: fixture.db }, { accountId: fixture.accountId, proposalId: proposal.id }),
    ).not.toHaveProperty("rawPrivateText");
  }, 30_000);

  it("serializes retries, rejects idempotency conflicts, and derives one stable pseudonym", async () => {
    const fixture = await proposalFixture("proposal-idempotency");
    const input = proposalInput(fixture, { rawPrivateText: undefined });
    const proposals = await Promise.all(
      Array.from({ length: 6 }, () => createProposal({ db: fixture.db }, input)),
    );
    expect(new Set(proposals.map(({ id }) => id)).size).toBe(1);
    expect(new Set(proposals.map(({ councilMemberId }) => councilMemberId)).size).toBe(1);
    await expect(
      createProposal({ db: fixture.db }, { ...input, uncertainty: "Different uncertainty." }),
    ).rejects.toThrow("PROPOSAL_IDEMPOTENCY_KEY_REUSED");
    expect(await fixture.db.one("select count(*)::int as count from proposals")).toEqual({ count: 1 });
    expect(
      await fixture.db.one("select count(*)::int as count from events where type='node.proposal.created'"),
    ).toEqual({ count: 1 });
  }, 30_000);

  it("uses one global idempotency namespace across aggregates and operation kinds", async () => {
    const owner = await proposalFixture("proposal-global-idem-owner");
    const other = await proposalFixture("proposal-global-idem-other", owner.db);
    const sharedKey = "global-proposal-operation-key";
    const attempts = await Promise.allSettled([
      createProposal(
        { db: owner.db },
        proposalInput(owner, { rawPrivateText: undefined, idempotencyKey: sharedKey }),
      ),
      createDisclosureAuthorization(
        { db: owner.db },
        {
          accountId: other.accountId,
          conversationId: other.conversationId,
          sourceEventIds: [other.sourceEventId],
          disclosedText: "must never persist without scoped authorization",
          privacyScope: "PROPOSAL_RAW_TEXT",
          purpose: "MAIN_PROPOSAL_REVIEW",
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: sharedKey,
        } as Parameters<typeof createDisclosureAuthorization>[1],
      ),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "PROPOSAL_IDEMPOTENCY_KEY_REUSED" }),
    });

    const crossAggregate = await Promise.allSettled([
      createProposal(
        { db: owner.db },
        proposalInput(owner, { rawPrivateText: undefined, idempotencyKey: "cross-aggregate-proposal-key" }),
      ),
      createProposal(
        { db: owner.db },
        proposalInput(other, { rawPrivateText: undefined, idempotencyKey: "cross-aggregate-proposal-key" }),
      ),
    ]);
    expect(crossAggregate.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(crossAggregate.filter(({ status }) => status === "rejected")).toHaveLength(1);
  }, 30_000);

  it("enforces explicit legal status transitions and bounded clarification/review turns", async () => {
    const fixture = await proposalFixture("proposal-turns");
    const proposal = await createProposal(
      { db: fixture.db },
      proposalInput(fixture, { rawPrivateText: undefined }),
    );
    await expect(transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
        toStatus: "UNDER_REVIEW",
        reason: "A Node cannot review its own proposal.",
        idempotencyKey: "node-cannot-start-review",
      },
    )).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");
    await expect(transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "REJECTED",
        reason: "Main cannot reject before independent evaluation.",
        idempotencyKey: "main-cannot-reject-pending",
      },
    )).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");
    await expect(transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "SYSTEM", id: "arbitrary-system" },
        toStatus: "UNDER_REVIEW",
        reason: "An arbitrary system actor cannot claim review authority.",
        idempotencyKey: "system-cannot-start-review",
      } as unknown as Parameters<typeof transitionProposal>[1],
    )).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_INVALID");
    await expect(transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "EVALUATOR", id: randomUUID() },
        toStatus: "UNDER_REVIEW",
        reason: "An unaudited evaluator cannot claim review authority.",
        idempotencyKey: "unaudited-evaluator-cannot-review",
      },
    )).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");
    const clarification = await transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "CLARIFICATION_REQUESTED",
        reason: "Clarify the completed-candle timestamp.",
        idempotencyKey: "proposal-clarify",
      },
    );
    expect(clarification.status).toBe("CLARIFICATION_REQUESTED");

    await expect(
      addProposalTurn(
        { db: fixture.db },
        {
          proposalId: proposal.id,
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
          kind: "CLARIFICATION",
          text: "LYNX7",
          sourceEventIds: [fixture.sourceEventId],
          evidence: [],
          idempotencyKey: "clarification-short-private-copy",
        },
      ),
    ).rejects.toThrow("PROPOSAL_PRIVATE_TEXT_DISCLOSURE_REQUIRED");

    await expect(
      addProposalTurn(
        { db: fixture.db },
        {
          proposalId: proposal.id,
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
          kind: "CLARIFICATION",
          text: "Private source for proposal-turns: must never persist without scoped authorization",
          sourceEventIds: [fixture.sourceEventId],
          evidence: [],
          idempotencyKey: "clarification-private-copy",
        },
      ),
    ).rejects.toThrow("PROPOSAL_PRIVATE_TEXT_DISCLOSURE_REQUIRED");

    for (let index = 0; index < MAX_CLARIFICATION_TURNS; index += 1) {
      await addProposalTurn(
        { db: fixture.db },
        {
          proposalId: proposal.id,
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
          kind: "CLARIFICATION",
          text: `Clarification ${index}`,
          sourceEventIds: [fixture.sourceEventId],
          evidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
          idempotencyKey: `clarification-${index}`,
        },
      );
    }
    await expect(
      addProposalTurn(
        { db: fixture.db },
        {
          proposalId: proposal.id,
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
          kind: "CLARIFICATION",
          text: "One too many",
          sourceEventIds: [fixture.sourceEventId],
          evidence: [],
          idempotencyKey: "clarification-overflow",
        },
      ),
    ).rejects.toThrow("PROPOSAL_CLARIFICATION_TURN_LIMIT");
    const overflowTurnEvent = await appendEvent(fixture.db, {
      aggregateId: proposal.id,
      accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
      type: "debate.turn.created",
      visibility: "PRIVATE_ACCOUNT",
      body: { evidence: [], kind: "CLARIFICATION", text: "SQL overflow" },
      idempotencyKey: "sql-clarification-overflow-event",
      causationId: proposal.createdEventId,
      policyVersion: "node-proposal-policy-v1",
    });
    await expect(
      fixture.db.query(
        `insert into proposal_turns (
           id, proposal_id, account_id, node_brain_id, actor_type, actor_id,
           kind, ordinal, source_event_ids, text_digest, evidence_count,
           turn_event_id, idempotency_key, request_digest, created_at
         ) values ($1,$2,$3,$4,'NODE_BRAIN',(select id::text from node_brains where id=$4),
                   'CLARIFICATION',$5,$6::jsonb,$7,0,$8,$9,$7,clock_timestamp())`,
        [randomUUID(), proposal.id, fixture.accountId, fixture.nodeBrainId,
          MAX_CLARIFICATION_TURNS, JSON.stringify([fixture.sourceEventId]),
          "0".repeat(64), overflowTurnEvent.id, "sql-clarification-overflow"],
      ),
    ).rejects.toThrow("PROPOSAL_CLARIFICATION_TURN_LIMIT");

    await transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "UNDER_REVIEW",
        reason: "Clarification is sufficient.",
        idempotencyKey: "proposal-under-review",
      },
    );
    for (const [toStatus, idempotencyKey] of [
      ["QUEUED_FOR_DECISION", "main-cannot-bypass-evaluator-queue"],
      ["ACCEPTED", "main-cannot-accept-before-evaluator-queue"],
      ["REJECTED", "main-cannot-reject-before-evaluator-queue"],
    ] as const) {
      await expect(transitionProposal(
        { db: fixture.db },
        {
          proposalId: proposal.id,
          actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
          toStatus,
          reason: "Main cannot bypass the independent evaluator gate.",
          idempotencyKey,
        },
      )).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");
    }
    for (let index = 0; index < MAX_REVIEW_TURNS; index += 1) {
      await addProposalTurn(
        { db: fixture.db },
        {
          proposalId: proposal.id,
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
          kind: "REVIEW",
          text: `Review argument ${index}`,
          sourceEventIds: [fixture.sourceEventId],
          evidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
          idempotencyKey: `review-${index}`,
        },
      );
    }
    await expect(
      addProposalTurn(
        { db: fixture.db },
        {
          proposalId: proposal.id,
          accountId: fixture.accountId,
          nodeBrainId: fixture.nodeBrainId,
          actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
          kind: "REVIEW",
          text: "One too many",
          sourceEventIds: [fixture.sourceEventId],
          evidence: [],
          idempotencyKey: "review-overflow",
        },
      ),
    ).rejects.toThrow("PROPOSAL_REVIEW_TURN_LIMIT");

    const unrelatedEvaluatorRunId = await completedEvaluatorRun(
      fixture, "proposal-turns-unrelated", randomUUID(),
    );
    await expect(transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "EVALUATOR", id: unrelatedEvaluatorRunId },
        toStatus: "QUEUED_FOR_DECISION",
        reason: "An unrelated evaluator run cannot act on this proposal.",
        idempotencyKey: "proposal-unrelated-evaluator-queued",
      },
    )).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");
    const evaluatorRunId = await completedEvaluatorRun(
      fixture, "proposal-turns", proposal.createdEventId,
    );
    const queued = await transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "EVALUATOR", id: evaluatorRunId },
        toStatus: "QUEUED_FOR_DECISION",
        reason: "The audited evaluator recommends Main decision review.",
        idempotencyKey: "proposal-evaluator-queued",
      },
    );
    expect(queued.status).toBe("QUEUED_FOR_DECISION");
    const accepted = await transitionProposal(
      { db: guardedDatabase(fixture.db) },
      {
        proposalId: proposal.id,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "ACCEPTED",
        reason: "Passed later blind evaluation.",
        idempotencyKey: "proposal-accepted",
      },
    );
    expect(accepted.status).toBe("ACCEPTED");
    await expect(
      transitionProposal(
        { db: fixture.db },
        {
          proposalId: proposal.id,
          actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
          toStatus: "REJECTED",
          reason: "Cannot leave a terminal status.",
          idempotencyKey: "proposal-invalid-terminal-transition",
        },
      ),
    ).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");
  }, 30_000);

  it("keeps authorized private turn text behind the proposal disclosure gate", async () => {
    const fixture = await proposalFixture("proposal-private-turn");
    const sourceText = "Private source for proposal-private-turn";
    const authorization = await createDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        sourceEventIds: [fixture.sourceEventId],
        disclosedText: sourceText,
        privacyScope: "PROPOSAL_RAW_TEXT",
        purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "private-turn-authorization",
      },
    );
    const proposal = await createProposal(
      { db: fixture.db },
      proposalInput(fixture, {
        proposedChange: sourceText,
        rawPrivateText: sourceText,
        privacyScope: "PROPOSAL_RAW_TEXT",
        disclosureAuthorizationId: authorization.id,
        idempotencyKey: "private-turn-proposal",
      }),
    );
    await transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "CLARIFICATION_REQUESTED",
        reason: "Clarify the exact source statement.",
        idempotencyKey: "private-turn-clarification-status",
      },
    );
    const turn = await addProposalTurn(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
        kind: "CLARIFICATION",
        text: sourceText,
        sourceEventIds: [fixture.sourceEventId],
        evidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
        idempotencyKey: "private-turn-created",
      },
    );
    expect(turn.text).toBe(sourceText);
    expect(
      await readEventBody(fixture.db, turn.eventId, { actor: { role: "SYSTEM" } }),
    ).toMatchObject({ text: "[AUTHORIZED PRIVATE TEXT]", usesProposalPrivateText: true });
  }, 30_000);

  it("protects proposal semantics and provenance from direct SQL mutation", async () => {
    const fixture = await proposalFixture("proposal-immutable");
    const proposal = await createProposal(
      { db: fixture.db },
      proposalInput(fixture, { rawPrivateText: undefined }),
    );
    await expect(
      fixture.db.query("update proposals set council_member_id='member_changed' where id=$1", [proposal.id]),
    ).rejects.toThrow("IMMUTABLE_PROPOSAL");
    await expect(
      fixture.db.query("delete from proposal_evidence_links where proposal_id=$1", [proposal.id]),
    ).rejects.toThrow("IMMUTABLE_PROPOSAL_EVIDENCE");
    await expect(
      fixture.db.query("update proposal_status_transitions set reason_digest=$2 where proposal_id=$1", [proposal.id, "0".repeat(64)]),
    ).rejects.toThrow("IMMUTABLE_PROPOSAL_TRANSITION");
  }, 30_000);

  it("rejects unresolved and cross-account evidence references in direct SQL", async () => {
    const owner = await proposalFixture("proposal-sql-evidence-owner");
    const other = await proposalFixture("proposal-sql-evidence-other", owner.db);
    const ownerProposal = await createProposal(
      { db: owner.db }, proposalInput(owner, { rawPrivateText: undefined }),
    );
    const otherProposal = await createProposal(
      { db: owner.db }, proposalInput(other, {
        rawPrivateText: undefined,
        idempotencyKey: "proposal-sql-evidence-other-proposal",
      }),
    );
    for (const [kind, referenceId] of [
      ["SOURCE_EVENT", other.sourceEventId],
      ["COMMENTARY", randomUUID()],
      ["PROPOSAL", otherProposal.id],
    ] as const) {
      await expect(owner.db.query(
        `insert into proposal_evidence_links
           (proposal_id, polarity, ordinal, reference_kind, reference_id)
         values ($1,'EVIDENCE',99,$2,$3)`,
        [ownerProposal.id, kind, referenceId],
      )).rejects.toThrow("PROPOSAL_EVIDENCE_FORBIDDEN");
    }
    await expect(owner.db.query(
      `insert into proposal_evidence_links
         (proposal_id, polarity, ordinal, reference_kind, reference_id)
       values ($1,'EVIDENCE',99,'SOURCE_EVENT',$2)`,
      [ownerProposal.id, owner.sourceEventId],
    )).rejects.toThrow("PROPOSAL_EVIDENCE_OUT_OF_BOUNDS");

    await transitionProposal(
      { db: owner.db },
      {
        proposalId: ownerProposal.id,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "UNDER_REVIEW",
        reason: "Begin evidence integrity review.",
        idempotencyKey: "proposal-sql-evidence-under-review",
      },
    );
    const turn = await addProposalTurn(
      { db: owner.db },
      {
        proposalId: ownerProposal.id,
        accountId: owner.accountId,
        nodeBrainId: owner.nodeBrainId,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        kind: "REVIEW",
        text: "Review the authorized source evidence.",
        sourceEventIds: [owner.sourceEventId],
        evidence: [{ kind: "SOURCE_EVENT", referenceId: owner.sourceEventId }],
        idempotencyKey: "proposal-sql-evidence-review-turn",
      },
    );
    await expect(owner.db.query(
      `insert into proposal_turn_evidence_links
         (turn_id, ordinal, reference_kind, reference_id)
       values ($1,99,'PROPOSAL',$2)`,
      [turn.id, otherProposal.id],
    )).rejects.toThrow("PROPOSAL_EVIDENCE_FORBIDDEN");
  }, 30_000);

  it("enforces acyclic status and hard transition/turn bounds in PostgreSQL", async () => {
    const fixture = await proposalFixture("proposal-sql-bounds");
    const proposal = await createProposal(
      { db: fixture.db },
      proposalInput(fixture, { rawPrivateText: undefined }),
    );
    const nodeAcceptanceEvent = await appendEvent(fixture.db, {
      aggregateId: proposal.id,
      accountId: fixture.accountId,
      actor: { type: "NODE_BRAIN", id: fixture.nodeBrainId },
      type: "node.proposal.status-transitioned",
      visibility: "PRIVATE_ACCOUNT",
      body: { fromStatus: "PENDING_REVIEW", reason: "Node cannot accept", toStatus: "ACCEPTED" },
      idempotencyKey: "sql-node-acceptance-event",
      causationId: proposal.createdEventId,
      policyVersion: "node-proposal-policy-v1",
    });
    await expect(
      fixture.db.query(
        `insert into proposal_status_transitions (
           id, proposal_id, ordinal, from_status, to_status, reason_digest,
           actor_type, actor_id, transition_event_id, idempotency_key, request_digest, created_at
         ) values ($1,$2,1,'PENDING_REVIEW','ACCEPTED',$3,'NODE_BRAIN',$4,$5,$6,$3,clock_timestamp())`,
        [randomUUID(), proposal.id, "0".repeat(64), fixture.nodeBrainId,
          nodeAcceptanceEvent.id, "sql-node-acceptance"],
      ),
    ).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");

    const systemEvent = await appendEvent(fixture.db, {
      aggregateId: proposal.id,
      accountId: fixture.accountId,
      actor: { type: "SYSTEM", id: "arbitrary-system" },
      type: "node.proposal.status-transitioned",
      visibility: "PRIVATE_ACCOUNT",
      body: { fromStatus: "PENDING_REVIEW", reason: "arbitrary system", toStatus: "UNDER_REVIEW" },
      idempotencyKey: "sql-system-transition-event",
      causationId: proposal.createdEventId,
      policyVersion: "node-proposal-policy-v1",
    });
    await expect(
      fixture.db.query(
        `insert into proposal_status_transitions (
           id, proposal_id, ordinal, from_status, to_status, reason_digest,
           actor_type, actor_id, transition_event_id, idempotency_key, request_digest, created_at
         ) values ($1,$2,1,'PENDING_REVIEW','UNDER_REVIEW',$3,'SYSTEM','arbitrary-system',$4,$5,$3,clock_timestamp())`,
        [randomUUID(), proposal.id, "0".repeat(64), systemEvent.id, "sql-system-transition"],
      ),
    ).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");

    const arbitraryEvaluatorId = randomUUID();
    const evaluatorEvent = await appendEvent(fixture.db, {
      aggregateId: proposal.id,
      accountId: fixture.accountId,
      actor: { type: "EVALUATOR", id: arbitraryEvaluatorId },
      type: "node.proposal.status-transitioned",
      visibility: "PRIVATE_ACCOUNT",
      body: { fromStatus: "PENDING_REVIEW", reason: "unaudited evaluator", toStatus: "UNDER_REVIEW" },
      idempotencyKey: "sql-evaluator-transition-event",
      causationId: proposal.createdEventId,
      policyVersion: "node-proposal-policy-v1",
    });
    await expect(
      fixture.db.query(
        `insert into proposal_status_transitions (
           id, proposal_id, ordinal, from_status, to_status, reason_digest,
           actor_type, actor_id, transition_event_id, idempotency_key, request_digest, created_at
         ) values ($1,$2,1,'PENDING_REVIEW','UNDER_REVIEW',$3,'EVALUATOR',$4,$5,$6,$3,clock_timestamp())`,
        [randomUUID(), proposal.id, "0".repeat(64), arbitraryEvaluatorId,
          evaluatorEvent.id, "sql-evaluator-transition"],
      ),
    ).rejects.toThrow("PROPOSAL_TRANSITION_ACTOR_FORBIDDEN");

    const mainEvent = await appendEvent(fixture.db, {
      aggregateId: proposal.id,
      accountId: fixture.accountId,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "node.proposal.status-transitioned",
      visibility: "PRIVATE_ACCOUNT",
      body: { fromStatus: "PENDING_REVIEW", reason: "overflow", toStatus: "UNDER_REVIEW" },
      idempotencyKey: "sql-transition-overflow-event",
      causationId: proposal.createdEventId,
      policyVersion: "node-proposal-policy-v1",
    });
    await expect(
      fixture.db.query(
        `insert into proposal_status_transitions (
           id, proposal_id, ordinal, from_status, to_status, reason_digest,
           actor_type, actor_id, transition_event_id, idempotency_key, request_digest, created_at
         ) values ($1,$2,$3,'PENDING_REVIEW','UNDER_REVIEW',$4,'MAIN_BRAIN','gustavo-main',$5,$6,$4,clock_timestamp())`,
        [randomUUID(), proposal.id, MAX_PROPOSAL_STATUS_TRANSITIONS, "0".repeat(64), mainEvent.id, "sql-transition-overflow"],
      ),
    ).rejects.toThrow("PROPOSAL_TRANSITION_LIMIT");
  }, 30_000);

  it("rolls back the projection and event when durable outbox persistence fails", async () => {
    const fixture = await proposalFixture("proposal-outbox");
    await fixture.db.query(`
      create function reject_proposal_outbox() returns trigger language plpgsql as $$
      begin
        if new.topic = 'node.proposal.created' then
          raise exception 'TEST_PROPOSAL_OUTBOX_FAILURE';
        end if;
        return new;
      end;
      $$;
      create trigger reject_proposal_outbox before insert on transactional_outbox
      for each row execute function reject_proposal_outbox();
    `);
    await expect(
      createProposal({ db: fixture.db }, proposalInput(fixture)),
    ).rejects.toThrow("TEST_PROPOSAL_OUTBOX_FAILURE");
    expect(await fixture.db.one("select count(*)::int as count from proposals")).toEqual({ count: 0 });
    expect(
      await fixture.db.one("select count(*)::int as count from events where type='node.proposal.created'"),
    ).toEqual({ count: 0 });
  }, 30_000);

  it("enforces strict bounded route input, origin/session, private no-store, and generic errors", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fixture = await proposalFixture("proposal-route");
    routeState.db = guardedDatabase(fixture.db);
    const body = {
      nodeBrainId: fixture.nodeBrainId,
      conversationId: fixture.conversationId,
      sourceEventIds: [fixture.sourceEventId],
      routeEventId: fixture.routeEventId,
      affectedMainStateIds: [fixture.mainStateId],
      privacyScope: "PROPOSAL_SUMMARY",
      proposedChange: "Treat the completed close as rejection.",
      evidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
      counterevidence: [{ kind: "SOURCE_EVENT", referenceId: fixture.sourceEventId }],
      uncertainty: "Volume confirmation is weak.",
      idempotencyKey: "route-proposal-1",
    };

    expect((await POST(proposalRequest(fixture, body, "https://evil.example"))).status).toBe(403);
    const unknownField = await POST(proposalRequest(fixture, { ...body, accountId: fixture.accountId }));
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toEqual({ error: "INVALID_PROPOSAL_BODY" });

    const wrongContentType = new Request("https://gustavo.lol/api/proposals", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        cookie: `__Host-gustavo-session=${fixture.sessionToken}`,
        origin: "https://gustavo.lol",
      },
      body: JSON.stringify(body),
    });
    expect((await POST(wrongContentType)).status).toBe(415);

    const accepted = await POST(proposalRequest(fixture, body));
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    expect(await accepted.json()).toMatchObject({ status: "PENDING_REVIEW" });

    const missingSession = new Request("https://gustavo.lol/api/proposals", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://gustavo.lol" },
      body: JSON.stringify({ ...body, idempotencyKey: "route-no-session" }),
    });
    expect((await POST(missingSession)).status).toBe(401);

    const oversize = new Request("https://gustavo.lol/api/proposals", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://gustavo.lol" },
      body: JSON.stringify({ ...body, proposedChange: "x".repeat(20_000) }),
    });
    expect((await POST(oversize)).status).toBe(413);

    routeState.db = {
      async query() { throw new Error("SECRET_DATABASE_FAILURE"); },
      async one() { throw new Error("SECRET_DATABASE_FAILURE"); },
      async transaction() { throw new Error("SECRET_DATABASE_FAILURE"); },
    };
    const failed = await POST(proposalRequest(fixture, { ...body, idempotencyKey: "route-failure" }));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "PROPOSAL_CREATE_FAILED" });
  }, 30_000);

  it("does not make model, broker, or external calls", async () => {
    const fixture = await proposalFixture("proposal-offline");
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => { throw new Error("PROPOSAL_MUST_NOT_FETCH"); });
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      await createProposal({ db: fixture.db }, proposalInput(fixture));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);
});
