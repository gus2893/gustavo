import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendMessage } from "../../lib/server/history/messages";
import { appendEvent, readEventBody } from "../../lib/server/events/store";
import { routeNodeReply } from "../../lib/server/node-brains/router";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";
import {
  createDisclosureAuthorization,
  createProposal,
  revokeDisclosureAuthorization,
  transitionProposal,
} from "../../lib/server/orchestration/proposals";
import {
  RUBRIC_V1,
  anonymizeCandidate,
  selectWinner,
} from "../../lib/server/orchestration/rubric";
import {
  DECISION_POLICY_VERSION,
  commitMainBaseline,
  evaluationPacket,
  getDecisionWindow,
  openDecisionWindow,
  recordEvaluation,
  submitContender,
} from "../../lib/server/orchestration/decision-window";
import { createConversationFixture } from "../helpers/postgres";

beforeEach(() => {
  vi.stubEnv("GUSTAVO_EVALUATOR_PSEUDONYM_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("GUSTAVO_COUNCIL_PSEUDONYM_KEY", randomBytes(32).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("approved evaluator rubric", () => {
  it("totals 100 and applies the 80 action threshold plus 5 point margin", () => {
    expect(Object.values(RUBRIC_V1.weights).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(RUBRIC_V1).toMatchObject({ actionThreshold: 80, improvementMargin: 5 });
    expect(Object.keys(RUBRIC_V1.weights)).toEqual([
      "evidenceFreshness",
      "structuralClarity",
      "costAdjustedGeometry",
      "falsifiability",
      "uncertainty",
      "independence",
    ]);
    expect(selectWinner({
      main: { id: "main", score: 82, hardGatesPassed: true },
      contenders: [{ id: "node", score: 86, hardGatesPassed: true }],
    })).toBe("main");
    expect(selectWinner({
      main: { id: "main", score: 82, hardGatesPassed: true },
      contenders: [{ id: "node", score: 87, hardGatesPassed: true }],
    })).toBe("node");
    expect(selectWinner({
      main: { id: "main", score: 70, hardGatesPassed: true },
      contenders: [{ id: "node", score: 79, hardGatesPassed: true }],
    })).toBe("NO_PAPER_TRADE");
    expect(selectWinner({
      main: { id: "main", score: 100, hardGatesPassed: true, actionable: false },
      contenders: [],
    })).toBe("NO_PAPER_TRADE");
    expect(anonymizeCandidate({
      nodeBrainId: "node-secret",
      accountId: "acct-secret",
      thesis: "completed rejection",
    })).toEqual({ candidateId: expect.any(String), thesis: "completed rejection" });
  });

  it("applies hard gates before scores and resolves contender ties deterministically", () => {
    expect(selectWinner({
      main: { id: "main", score: 82, hardGatesPassed: true },
      contenders: [{ id: "blocked", score: 100, hardGatesPassed: false }],
    })).toBe("main");
    expect(selectWinner({
      main: { id: "main", score: 70, hardGatesPassed: false },
      contenders: [{ id: "eligible", score: 80, hardGatesPassed: true }],
    })).toBe("eligible");
    expect(selectWinner({
      main: { id: "main", score: 70, hardGatesPassed: false },
      contenders: [{ id: "below-threshold", score: 79, hardGatesPassed: true }],
    })).toBe("NO_PAPER_TRADE");
    expect(selectWinner({
      main: { id: "main", score: 82, hardGatesPassed: true },
      contenders: [
        { id: "candidate_b", score: 87, hardGatesPassed: true },
        { id: "candidate_a", score: 87, hardGatesPassed: true },
      ],
    })).toBe("candidate_a");
  });

  it("binds every decision window to an authoritative Challenge profile UUID", async () => {
    const fixture = await createConversationFixture("decision-profile-binding");
    const input = {
      marketObservationIds: ["observation-profile-binding"],
      evidence: [{ kind: "SOURCE_EVENT" as const, referenceId: randomUUID() }],
      portfolioSnapshot: { cashCents: "250000", positions: [] },
      costModelSnapshot: { policyVersion: "stock-etf-cost-v1" },
      stageProfileVersion: INITIAL_PROFILE.profileVersionId,
      eligibleInstruments: ["AAPL"],
      idempotencyKey: "decision-profile-binding-valid",
    };

    const window = await openDecisionWindow({ db: fixture.db }, input);
    expect(window.stageProfileVersion).toBe(INITIAL_PROFILE.profileVersionId);
    expect(await fixture.db.one(
      "select stage_profile_version::text as profile_id from decision_windows where id=$1",
      [window.id],
    )).toEqual({ profile_id: INITIAL_PROFILE.profileVersionId });

    await expect(openDecisionWindow(
      { db: fixture.db },
      { ...input, stageProfileVersion: "challenge-profile-v1", idempotencyKey: "decision-profile-label" },
    )).rejects.toThrow("DECISION_PROFILE_VERSION_INVALID");

    const nonexistentProfileId = randomUUID();
    await expect(openDecisionWindow(
      { db: fixture.db },
      { ...input, stageProfileVersion: nonexistentProfileId, idempotencyKey: "decision-profile-missing" },
    )).rejects.toThrow("DECISION_PROFILE_VERSION_NOT_FOUND");
    expect(await fixture.db.one(
      "select count(*)::int as count from decision_windows",
    )).toEqual({ count: 1 });

    const directWindowId = randomUUID();
    await expect(fixture.db.transaction(async (transaction) => {
      const event = await appendEvent(transaction, {
        aggregateId: directWindowId,
        actor: { type: "SYSTEM", id: "gustavo-decision-orchestrator" },
        type: "decision.window.opened",
        visibility: "OPERATOR",
        body: {},
        idempotencyKey: "decision-profile-direct-event",
        policyVersion: DECISION_POLICY_VERSION,
      });
      await transaction.query(
        `insert into decision_windows (
           id, market_observation_ids, evidence_count, portfolio_snapshot_digest,
           cost_model_snapshot_digest, stage_profile_version, eligible_instruments,
           snapshot_digest, opened_event_id, policy_version,
           idempotency_key, request_digest, created_at
         ) values ($1,$2::jsonb,1,$3,$3,$4,$5::jsonb,$3,$6,$7,$8,$3,$9)`,
        [directWindowId, JSON.stringify(["observation-direct"]), "0".repeat(64),
          nonexistentProfileId, JSON.stringify(["AAPL"]), event.id,
          DECISION_POLICY_VERSION, "decision-profile-direct-window", event.occurredAt],
      );
    })).rejects.toThrow("DECISION_PROFILE_VERSION_NOT_FOUND");
  }, 30_000);

  it("freezes the snapshot and Main baseline before blind scoring an authorized contender", async () => {
    const fixture = await createConversationFixture("decision-window");
    const disclosedText = "A completed close rejected the prior level. ORCHID-7";
    const source = await appendMessage(fixture, {
      idempotencyKey: "decision-window-source",
      role: "USER",
      text: disclosedText,
    });
    const mainStateVersion = "700001";
    await fixture.db.query(
      "insert into main_state_versions(version, author_type, author_id, status) values ($1,'MAIN_BRAIN','gustavo-main','COMMITTED')",
      [mainStateVersion],
    );
    const routed = await routeNodeReply({
      db: fixture.db,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      userMessageEventId: source.eventId,
      coveredByMain: false,
      contradiction: true,
      materialEvidence: true,
      confidence: 0.94,
      mainStateVersion,
      sourceIds: [source.eventId],
    }, async () => undefined);
    const disclosure = await createDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        conversationId: fixture.conversationId,
        sourceEventIds: [source.eventId],
        disclosedText,
        privacyScope: "PROPOSAL_RAW_TEXT",
        purpose: "MAIN_PROPOSAL_REVIEW",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "decision-window-disclosure",
      },
    );
    const proposal = await createProposal(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId,
        sourceEventIds: [source.eventId],
        routeEventId: routed.routingEventId,
        affectedMainStateIds: [mainStateVersion],
        privacyScope: "PROPOSAL_RAW_TEXT",
        disclosureAuthorizationId: disclosure.id,
        rawPrivateText: disclosedText,
        proposedChange: disclosedText,
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        counterevidence: [],
        uncertainty: "Follow-through is not confirmed.",
        idempotencyKey: "decision-window-proposal",
      },
    );
    await transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "UNDER_REVIEW",
        reason: "Ready for evaluator intake.",
        idempotencyKey: "decision-window-proposal-review",
      },
    );
    const intakeRunId = randomUUID();
    await fixture.db.query(
      `insert into model_runs (
         id, role, provider, model, prompt_version, policy_version,
         correlation_id, causation_id, input_tokens, output_tokens,
         max_input_tokens, max_output_tokens, completion_status, completed_at
       ) values ($1,'EVALUATOR','fake','intake-model','proposal-intake-v1','proposal-intake-policy-v1',
                 $2,$3,1,1,1024,256,'COMPLETED',clock_timestamp())`,
      [intakeRunId, randomUUID(), proposal.createdEventId],
    );
    await transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "EVALUATOR", id: intakeRunId },
        toStatus: "QUEUED_FOR_DECISION",
        reason: "Proposal passed bounded intake.",
        idempotencyKey: "decision-window-proposal-queued",
      },
    );

    const mutablePortfolio = { cashCents: "250000", positions: [] as string[] };
    const window = await openDecisionWindow(
      { db: fixture.db },
      {
        marketObservationIds: ["observation-15m-1"],
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        portfolioSnapshot: mutablePortfolio,
        costModelSnapshot: { commissionMicrousdPerShare: "5000", slippageBps: 5 },
        stageProfileVersion: INITIAL_PROFILE.profileVersionId,
        eligibleInstruments: ["AAPL", "SPY"],
        idempotencyKey: "decision-window-open",
      },
    );
    mutablePortfolio.cashCents = "0";
    mutablePortfolio.positions.push("MUTATED");
    await expect(getDecisionWindow({ db: fixture.db }, window.id)).resolves.toMatchObject({
      portfolioSnapshot: { cashCents: "250000", positions: [] },
    });
    await expect(submitContender(
      { db: fixture.db },
      { windowId: window.id, proposalId: proposal.id, idempotencyKey: "contender-before-main" },
    )).rejects.toThrow("DECISION_MAIN_COMMITMENT_REQUIRED");

    await expect(commitMainBaseline(
      { db: fixture.db },
      {
        windowId: window.id,
        disposition: "THESIS",
        thesis: "This thesis cites evidence outside the frozen snapshot.",
        evidence: [{ kind: "SOURCE_EVENT", referenceId: randomUUID() }],
        counterevidence: [],
        uncertainty: "The evidence was not frozen.",
        idempotencyKey: "decision-main-unfrozen-evidence",
      },
    )).rejects.toThrow("DECISION_EVIDENCE_OUTSIDE_SNAPSHOT");

    const main = await commitMainBaseline(
      { db: fixture.db },
      {
        windowId: window.id,
        disposition: "THESIS",
        thesis: "The completed close may hold as rejection.",
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        counterevidence: [],
        uncertainty: "The next completed bar may reclaim the level.",
        idempotencyKey: "decision-main-baseline",
      },
    );
    await expect(commitMainBaseline(
      { db: fixture.db },
      {
        windowId: window.id,
        disposition: "THESIS",
        thesis: "The completed close may hold as rejection.",
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        counterevidence: [],
        uncertainty: "The next completed bar may reclaim the level.",
        idempotencyKey: "decision-main-baseline",
      },
    )).resolves.toEqual(main);
    await expect(commitMainBaseline(
      { db: fixture.db },
      {
        windowId: window.id,
        disposition: "NO_PAPER_TRADE",
        thesis: "A second Main commitment must not replace the baseline.",
        evidence: [],
        counterevidence: [],
        uncertainty: "Already committed.",
        idempotencyKey: "decision-main-second-commitment",
      },
    )).rejects.toThrow("DECISION_MAIN_ALREADY_COMMITTED");

    const contender = await submitContender(
      { db: fixture.db },
      { windowId: window.id, proposalId: proposal.id, idempotencyKey: "decision-contender" },
    );
    const contenderBody = await readEventBody(
      fixture.db, contender.eventId, { actor: { role: "SYSTEM" } },
    );
    expect(JSON.stringify(contenderBody)).not.toContain(disclosedText);
    expect(contenderBody).toMatchObject({
      thesis: "[AUTHORIZED PRIVATE TEXT]",
      privateTextUses: ["THESIS"],
    });
    const packet = await evaluationPacket({ db: fixture.db }, window.id);
    expect(packet).toEqual([
      expect.objectContaining({ candidateId: "main", thesis: main.thesis }),
      expect.objectContaining({ candidateId: contender.candidateId, thesis: proposal.proposedChange }),
    ]);
    expect(JSON.stringify(packet)).not.toContain(fixture.accountId);
    expect(JSON.stringify(packet)).not.toContain(fixture.nodeBrainId);
    expect(JSON.stringify(packet)).not.toContain(proposal.id);

    const scores = [
      {
        candidateId: "main",
        components: {
          evidenceFreshness: 21, structuralClarity: 16, costAdjustedGeometry: 17,
          falsifiability: 12, uncertainty: 8, independence: 8,
        },
        hardGates: {
          evidenceFresh: true, sessionValid: true, geometryComplete: true,
          nonDuplicate: true, authorized: true,
        },
      },
      {
        candidateId: contender.candidateId,
        components: {
          evidenceFreshness: 22, structuralClarity: 18, costAdjustedGeometry: 18,
          falsifiability: 13, uncertainty: 8, independence: 8,
        },
        hardGates: {
          evidenceFresh: true, sessionValid: true, geometryComplete: true,
          nonDuplicate: true, authorized: true,
        },
      },
    ] as const;
    const wrongEvaluatorRunId = randomUUID();
    await fixture.db.query(
      `insert into model_runs (
         id, role, provider, model, prompt_version, policy_version,
         correlation_id, causation_id, input_tokens, output_tokens,
         max_input_tokens, max_output_tokens, completion_status, completed_at
       ) values ($1,'EVALUATOR','fake-provider','blind-evaluator','rubric-prompt-v1','rubric-policy-v1',
                 $2,$3,10,5,1024,256,'COMPLETED',clock_timestamp())`,
      [wrongEvaluatorRunId, randomUUID(), randomUUID()],
    );
    await expect(recordEvaluation(
      { db: fixture.db },
      {
        windowId: window.id,
        evaluatorRunId: wrongEvaluatorRunId,
        scores,
        idempotencyKey: "decision-wrong-evaluator-causation",
      },
    )).rejects.toThrow("DECISION_EVALUATOR_RUN_FORBIDDEN");

    const evaluatorRunId = randomUUID();
    await fixture.db.query(
      `insert into model_runs (
         id, role, provider, model, prompt_version, policy_version,
         correlation_id, causation_id, input_tokens, output_tokens,
         max_input_tokens, max_output_tokens, completion_status, completed_at
       ) values ($1,'EVALUATOR','fake-provider','blind-evaluator','rubric-prompt-v1','rubric-policy-v1',
                 $2,$3,10,5,1024,256,'COMPLETED',clock_timestamp())`,
      [evaluatorRunId, randomUUID(), main.eventId],
    );
    const firstPassEvent = await appendEvent(fixture.db, {
      aggregateId: window.id,
      actor: { type: "EVALUATOR", id: evaluatorRunId },
      type: "evaluation.scored",
      visibility: "OPERATOR",
      body: { candidateCount: 2 },
      idempotencyKey: "decision-first-evaluator-event",
      causationId: main.eventId,
      promptVersion: "rubric-prompt-v1",
      modelVersion: "blind-evaluator",
      policyVersion: "rubric-policy-v1",
    });
    const mixedRunId = randomUUID();
    await fixture.db.query(
      `insert into model_runs (
         id, role, provider, model, prompt_version, policy_version,
         correlation_id, causation_id, input_tokens, output_tokens,
         max_input_tokens, max_output_tokens, completion_status, completed_at
       ) values ($1,'EVALUATOR','other-provider','other-evaluator','other-prompt-v1','other-policy-v1',
                 $2,$3,10,5,1024,256,'COMPLETED',clock_timestamp())`,
      [mixedRunId, randomUUID(), main.eventId],
    );
    const mixedEvent = await appendEvent(fixture.db, {
      aggregateId: window.id,
      actor: { type: "EVALUATOR", id: mixedRunId },
      type: "evaluation.scored",
      visibility: "OPERATOR",
      body: { candidateCount: 2 },
      idempotencyKey: "decision-mixed-evaluator-event",
      causationId: main.eventId,
      promptVersion: "other-prompt-v1",
      modelVersion: "other-evaluator",
      policyVersion: "other-policy-v1",
    });
    await expect(fixture.db.transaction(async (tx) => {
      await tx.query(
        `insert into decision_evaluation_scores (
           window_id, candidate_id, evaluator_run_id,
           evidence_freshness, structural_clarity, cost_adjusted_geometry,
           falsifiability, uncertainty, independence,
           evidence_fresh, session_valid, geometry_complete, non_duplicate, authorized,
           total_score, prompt_version, model_version, policy_version,
           evaluation_event_id, created_at
         ) values ($1,'main',$2,21,16,17,12,8,8,true,true,true,true,true,
                   82,'rubric-prompt-v1','blind-evaluator','rubric-policy-v1',$3,clock_timestamp())`,
        [window.id, evaluatorRunId, firstPassEvent.id],
      );
      await tx.query(
        `insert into decision_evaluation_scores (
           window_id, candidate_id, evaluator_run_id,
           evidence_freshness, structural_clarity, cost_adjusted_geometry,
           falsifiability, uncertainty, independence,
           evidence_fresh, session_valid, geometry_complete, non_duplicate, authorized,
           total_score, prompt_version, model_version, policy_version,
           evaluation_event_id, created_at
         ) values ($1,$2,$3,25,20,20,15,10,10,true,true,true,true,true,
                   100,'other-prompt-v1','other-evaluator','other-policy-v1',$4,clock_timestamp())`,
        [window.id, contender.candidateId, mixedRunId, mixedEvent.id],
      );
    })).rejects.toThrow("DECISION_EVALUATION_PROVENANCE_INVALID");
    expect(await fixture.db.one(
      "select count(*)::int as count from decision_evaluation_scores where window_id=$1",
      [window.id],
    )).toEqual({ count: 0 });
    const selection = await recordEvaluation(
      { db: fixture.db },
      {
        windowId: window.id,
        evaluatorRunId,
        scores,
        idempotencyKey: "decision-evaluation",
      },
    );
    expect(selection).toMatchObject({ selectedCandidateId: contender.candidateId, result: "CONTENDER" });
    await expect(recordEvaluation(
      { db: fixture.db },
      {
        windowId: window.id,
        evaluatorRunId,
        scores,
        idempotencyKey: "decision-evaluation",
      },
    )).resolves.toEqual(selection);
    await expect(recordEvaluation(
      { db: fixture.db },
      {
        windowId: window.id,
        evaluatorRunId,
        scores: scores.map((score, index) => index === 0 ? {
          ...score,
          components: { ...score.components, evidenceFreshness: 20 },
        } : score),
        idempotencyKey: "decision-evaluation",
      },
    )).rejects.toThrow("DECISION_IDEMPOTENCY_KEY_REUSED");
    await expect(recordEvaluation(
      { db: fixture.db },
      {
        windowId: window.id,
        evaluatorRunId,
        scores,
        idempotencyKey: "decision-evaluation-second-key",
      },
    )).rejects.toThrow("DECISION_WINDOW_CLOSED");
    expect(await fixture.db.one(
      `select count(*)::int as score_count,
              min(prompt_version) as prompt_version,
              min(model_version) as model_version,
              min(policy_version) as policy_version
       from decision_evaluation_scores where window_id=$1`,
      [window.id],
    )).toEqual({
      score_count: 2,
      prompt_version: "rubric-prompt-v1",
      model_version: "blind-evaluator",
      policy_version: "rubric-policy-v1",
    });
    await expect(fixture.db.query(
      "update decision_selections set result='NO_PAPER_TRADE' where window_id=$1",
      [window.id],
    )).rejects.toThrow("IMMUTABLE_DECISION_SELECTION");
    await expect(fixture.db.query(
      "update decision_windows set stage_profile_version=$2 where id=$1",
      [window.id, randomUUID()],
    )).rejects.toThrow("IMMUTABLE_DECISION_WINDOW");
    await expect(fixture.db.query(
      "update decision_candidates set disposition='NO_PAPER_TRADE' where window_id=$1 and candidate_id='main'",
      [window.id],
    )).rejects.toThrow("IMMUTABLE_DECISION_CANDIDATE");
    await expect(fixture.db.query(
      "update decision_evaluation_scores set total_score=0 where window_id=$1 and candidate_id='main'",
      [window.id],
    )).rejects.toThrow("IMMUTABLE_DECISION_SCORE");
    await expect(fixture.db.query(
      "update decision_evaluation_batches set model_version='changed' where window_id=$1",
      [window.id],
    )).rejects.toThrow("IMMUTABLE_DECISION_EVALUATION_BATCH");
    await expect(submitContender(
      { db: fixture.db },
      { windowId: window.id, proposalId: proposal.id, idempotencyKey: "contender-after-selection" },
    )).rejects.toThrow("DECISION_WINDOW_CLOSED");
    await revokeDisclosureAuthorization(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        authorizationId: disclosure.id,
        idempotencyKey: "decision-window-disclosure-revoked",
      },
    );
    await expect(evaluationPacket({ db: fixture.db }, window.id))
      .rejects.toThrow("DECISION_CONTENDER_DISCLOSURE_FORBIDDEN");

    const rollbackWindow = await openDecisionWindow(
      { db: fixture.db },
      {
        marketObservationIds: ["observation-rollback"],
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        portfolioSnapshot: { cashCents: "250000", positions: [] },
        costModelSnapshot: { commissionMicrousdPerShare: "5000", slippageBps: 5 },
        stageProfileVersion: INITIAL_PROFILE.profileVersionId,
        eligibleInstruments: ["AAPL"],
        idempotencyKey: "decision-rollback-window",
      },
    );
    const rollbackMain = await commitMainBaseline(
      { db: fixture.db },
      {
        windowId: rollbackWindow.id,
        disposition: "NO_PAPER_TRADE",
        thesis: "Rollback this selection if its outbox write fails.",
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        counterevidence: [],
        uncertainty: "This is an atomicity regression.",
        idempotencyKey: "decision-rollback-main",
      },
    );
    const rollbackRunId = randomUUID();
    await fixture.db.query(
      `insert into model_runs (
         id, role, provider, model, prompt_version, policy_version,
         correlation_id, causation_id, input_tokens, output_tokens,
         max_input_tokens, max_output_tokens, completion_status, completed_at
       ) values ($1,'EVALUATOR','fake-provider','blind-evaluator','rubric-prompt-v1','rubric-policy-v1',
                 $2,$3,10,5,1024,256,'COMPLETED',clock_timestamp())`,
      [rollbackRunId, randomUUID(), rollbackMain.eventId],
    );
    await fixture.db.query(`
      create function reject_decision_selection_outbox() returns trigger language plpgsql as $$
      begin
        if new.topic='decision.selected' then
          raise exception 'TEST_DECISION_SELECTION_OUTBOX_FAILURE';
        end if;
        return new;
      end;
      $$;
      create trigger reject_decision_selection_outbox
      before insert on transactional_outbox
      for each row execute function reject_decision_selection_outbox();
    `);
    await expect(recordEvaluation(
      { db: fixture.db },
      {
        windowId: rollbackWindow.id,
        evaluatorRunId: rollbackRunId,
        scores: [{ ...scores[0], candidateId: "main" }],
        idempotencyKey: "decision-rollback-evaluation",
      },
    )).rejects.toThrow("TEST_DECISION_SELECTION_OUTBOX_FAILURE");
    expect(await fixture.db.one(
      `select
         (select count(*)::int from decision_evaluation_scores where window_id=$1) as score_count,
         (select count(*)::int from decision_selections where window_id=$1) as selection_count,
         (select count(*)::int from events where aggregate_id=$1::text
            and type in ('evaluation.scored','decision.selected')) as event_count`,
      [rollbackWindow.id],
    )).toEqual({ score_count: 0, selection_count: 0, event_count: 0 });
    await fixture.db.query("drop trigger reject_decision_selection_outbox on transactional_outbox");
    await fixture.db.query("drop function reject_decision_selection_outbox()");
    await expect(recordEvaluation(
      { db: fixture.db },
      {
        windowId: rollbackWindow.id,
        evaluatorRunId: rollbackRunId,
        scores: [{ ...scores[0], candidateId: "main" }],
        idempotencyKey: "decision-rollback-evaluation",
      },
    )).resolves.toMatchObject({ result: "NO_PAPER_TRADE", selectedCandidateId: null });

    const invalidBatchWindow = await openDecisionWindow(
      { db: fixture.db },
      {
        marketObservationIds: ["observation-invalid-batch"],
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        portfolioSnapshot: { cashCents: "250000", positions: [] },
        costModelSnapshot: { commissionMicrousdPerShare: "5000", slippageBps: 5 },
        stageProfileVersion: INITIAL_PROFILE.profileVersionId,
        eligibleInstruments: ["AAPL"],
        idempotencyKey: "decision-invalid-batch-window",
      },
    );
    const invalidBatchMain = await commitMainBaseline(
      { db: fixture.db },
      {
        windowId: invalidBatchWindow.id,
        disposition: "THESIS",
        thesis: "Invalid batch provenance must never seal this window.",
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        counterevidence: [],
        uncertainty: "This is a direct SQL authority regression.",
        idempotencyKey: "decision-invalid-batch-main",
      },
    );
    const invalidBatchRunId = randomUUID();
    await fixture.db.query(
      `insert into model_runs (
         id, role, provider, model, prompt_version, policy_version,
         correlation_id, causation_id, input_tokens, output_tokens,
         max_input_tokens, max_output_tokens, completion_status, completed_at
       ) values ($1,'EVALUATOR','fake','blind-evaluator','rubric-prompt-v1','rubric-policy-v1',
                 $2,$3,10,5,1024,256,'COMPLETED',clock_timestamp())`,
      [invalidBatchRunId, randomUUID(), invalidBatchMain.eventId],
    );
    const invalidBatchEvent = await appendEvent(fixture.db, {
      aggregateId: invalidBatchWindow.id,
      actor: { type: "EVALUATOR", id: invalidBatchRunId },
      type: "evaluation.scored",
      visibility: "OPERATOR",
      body: { candidateCount: 1 },
      idempotencyKey: "decision-invalid-batch-event",
      causationId: invalidBatchWindow.openedEventId,
      promptVersion: "rubric-prompt-v1",
      modelVersion: "blind-evaluator",
      policyVersion: "rubric-policy-v1",
    });
    await expect(fixture.db.query(
      `insert into decision_evaluation_batches (
         window_id, evaluator_run_id, evaluation_event_id,
         prompt_version, model_version, policy_version, created_at
       ) values ($1,$2,$3,'rubric-prompt-v1','blind-evaluator','rubric-policy-v1',clock_timestamp())`,
      [invalidBatchWindow.id, invalidBatchRunId, invalidBatchEvent.id],
    )).rejects.toThrow("DECISION_EVALUATION_PROVENANCE_INVALID");
  }, 30_000);

  it("serializes concurrent evaluator-pass provenance for one decision window", async () => {
    const fixture = await createConversationFixture("decision-concurrency");
    const source = await appendMessage(fixture, {
      idempotencyKey: "decision-concurrency-source",
      role: "USER",
      text: "A completed candle tested the same frozen level.",
    });
    const mainStateVersion = "700002";
    await fixture.db.query(
      "insert into main_state_versions(version, author_type, author_id, status) values ($1,'MAIN_BRAIN','gustavo-main','COMMITTED')",
      [mainStateVersion],
    );
    const routed = await routeNodeReply({
      db: fixture.db,
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      nodeBrainId: fixture.nodeBrainId,
      userMessageEventId: source.eventId,
      coveredByMain: false,
      contradiction: true,
      materialEvidence: true,
      confidence: 0.91,
      mainStateVersion,
      sourceIds: [source.eventId],
    }, async () => undefined);
    const proposal = await createProposal(
      { db: fixture.db },
      {
        accountId: fixture.accountId,
        nodeBrainId: fixture.nodeBrainId,
        conversationId: fixture.conversationId,
        sourceEventIds: [source.eventId],
        routeEventId: routed.routingEventId,
        affectedMainStateIds: [mainStateVersion],
        privacyScope: "PROPOSAL_SUMMARY",
        proposedChange: "Compare the completed rejection with Main's baseline.",
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        counterevidence: [],
        uncertainty: "A later completed candle may invalidate the rejection.",
        idempotencyKey: "decision-concurrency-proposal",
      },
    );
    await transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
        toStatus: "UNDER_REVIEW",
        reason: "Ready for concurrent evaluator regression.",
        idempotencyKey: "decision-concurrency-review",
      },
    );
    const intakeRunId = randomUUID();
    await fixture.db.query(
      `insert into model_runs (
         id, role, provider, model, prompt_version, policy_version,
         correlation_id, causation_id, input_tokens, output_tokens,
         max_input_tokens, max_output_tokens, completion_status, completed_at
       ) values ($1,'EVALUATOR','fake','intake-model','proposal-intake-v1','proposal-intake-policy-v1',
                 $2,$3,1,1,1024,256,'COMPLETED',clock_timestamp())`,
      [intakeRunId, randomUUID(), proposal.createdEventId],
    );
    await transitionProposal(
      { db: fixture.db },
      {
        proposalId: proposal.id,
        actor: { type: "EVALUATOR", id: intakeRunId },
        toStatus: "QUEUED_FOR_DECISION",
        reason: "Proposal passed bounded intake.",
        idempotencyKey: "decision-concurrency-queued",
      },
    );
    const window = await openDecisionWindow(
      { db: fixture.db },
      {
        marketObservationIds: ["observation-concurrency"],
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        portfolioSnapshot: { cashCents: "250000", positions: [] },
        costModelSnapshot: { commissionMicrousdPerShare: "5000", slippageBps: 5 },
        stageProfileVersion: INITIAL_PROFILE.profileVersionId,
        eligibleInstruments: ["AAPL"],
        idempotencyKey: "decision-concurrency-window",
      },
    );
    const main = await commitMainBaseline(
      { db: fixture.db },
      {
        windowId: window.id,
        disposition: "THESIS",
        thesis: "The completed candle may preserve Main's rejection thesis.",
        evidence: [{ kind: "SOURCE_EVENT", referenceId: source.eventId }],
        counterevidence: [],
        uncertainty: "Follow-through remains unconfirmed.",
        idempotencyKey: "decision-concurrency-main",
      },
    );
    const contender = await submitContender(
      { db: fixture.db },
      { windowId: window.id, proposalId: proposal.id, idempotencyKey: "decision-concurrency-contender" },
    );

    const run = async (label: string, model: string, prompt: string, policy: string) => {
      const id = randomUUID();
      await fixture.db.query(
        `insert into model_runs (
           id, role, provider, model, prompt_version, policy_version,
           correlation_id, causation_id, input_tokens, output_tokens,
           max_input_tokens, max_output_tokens, completion_status, completed_at
         ) values ($1,'EVALUATOR','fake',$2,$3,$4,$5,$6,10,5,1024,256,'COMPLETED',clock_timestamp())`,
        [id, model, prompt, policy, randomUUID(), main.eventId],
      );
      const event = await appendEvent(fixture.db, {
        aggregateId: window.id,
        actor: { type: "EVALUATOR", id },
        type: "evaluation.scored",
        visibility: "OPERATOR",
        body: { candidateCount: 2 },
        idempotencyKey: `decision-concurrency-${label}-event`,
        causationId: main.eventId,
        promptVersion: prompt,
        modelVersion: model,
        policyVersion: policy,
      });
      return { id, eventId: event.id, model, prompt, policy };
    };
    const [first, second] = await Promise.all([
      run("first", "blind-evaluator-a", "rubric-prompt-a", "rubric-policy-a"),
      run("second", "blind-evaluator-b", "rubric-prompt-b", "rubric-policy-b"),
    ]);
    let arrivals = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => { release = resolve; });
    const insertScore = async (
      candidateId: string,
      evaluator: { readonly id: string; readonly eventId: string; readonly model: string; readonly prompt: string; readonly policy: string },
    ) => fixture.db.transaction(async (transaction) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothReady;
      await transaction.query(
        `with synchronized_start as (select pg_sleep(0.15))
         insert into decision_evaluation_scores (
           window_id, candidate_id, evaluator_run_id,
           evidence_freshness, structural_clarity, cost_adjusted_geometry,
           falsifiability, uncertainty, independence,
           evidence_fresh, session_valid, geometry_complete, non_duplicate, authorized,
           total_score, prompt_version, model_version, policy_version,
           evaluation_event_id, created_at
         ) select $1,$2,$3,21,16,17,12,8,8,true,true,true,true,true,
                  82,$4,$5,$6,$7,clock_timestamp()
           from synchronized_start`,
        [window.id, candidateId, evaluator.id, evaluator.prompt,
          evaluator.model, evaluator.policy, evaluator.eventId],
      );
    });
    const outcomes = await Promise.allSettled([
      insertScore("main", first),
      insertScore(contender.candidateId, second),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("DECISION_EVALUATION_PROVENANCE_INVALID") }),
    });
    expect(await fixture.db.one(
      `select count(*)::int as score_count,
              count(distinct evaluator_run_id)::int as run_count,
              count(distinct evaluation_event_id)::int as event_count
         from decision_evaluation_scores where window_id=$1`,
      [window.id],
    )).toEqual({ score_count: 1, run_count: 1, event_count: 1 });
    await expect(submitContender(
      { db: fixture.db },
      {
        windowId: window.id,
        proposalId: proposal.id,
        idempotencyKey: "decision-concurrency-contender-after-evaluation",
      },
    )).rejects.toThrow("DECISION_WINDOW_CLOSED");
  }, 30_000);
});
