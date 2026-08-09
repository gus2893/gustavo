import { randomUUID } from "node:crypto";
import { appendEvent, readEventBody } from "../events/store";
import {
  canonicalContentDigest,
  canonicalJson,
  digestsEqual,
} from "../events/integrity";
import type { EventDatabase, JsonValue } from "../events/types";
import { getProposal } from "./proposals";
import {
  canonicalEvidenceReferences,
  type EvidenceReference,
} from "./evidence";
import {
  RUBRIC_V1,
  anonymizeCandidate,
  scoreCandidate,
  selectWinner,
  type CandidateScoreInput,
  type HardGates,
  type RubricComponents,
} from "./rubric";

export const DECISION_POLICY_VERSION = "decision-window-policy-v1";
const MAX_SNAPSHOT_JSON_BYTES = 64 * 1024;
const MAX_CANDIDATES = 65;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:./_-]{0,199}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const INSTRUMENT_PATTERN = /^[A-Z][A-Z0-9.-]{0,19}$/;

export interface DecisionContext { readonly db: EventDatabase }

export interface OpenDecisionWindowInput {
  readonly marketObservationIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
  readonly portfolioSnapshot: JsonValue;
  readonly costModelSnapshot: JsonValue;
  readonly stageProfileVersion: string;
  readonly eligibleInstruments: readonly string[];
  readonly idempotencyKey: string;
}

export interface DecisionWindowProjection {
  readonly id: string;
  readonly marketObservationIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
  readonly portfolioSnapshot: JsonValue;
  readonly costModelSnapshot: JsonValue;
  readonly stageProfileVersion: string;
  readonly eligibleInstruments: readonly string[];
  readonly snapshotDigest: string;
  readonly openedEventId: string;
  readonly createdAt: string;
}

export type CandidateDisposition = "THESIS" | "NO_PAPER_TRADE";

export interface MainBaselineInput {
  readonly windowId: string;
  readonly disposition: CandidateDisposition;
  readonly thesis: string;
  readonly evidence: readonly EvidenceReference[];
  readonly counterevidence: readonly EvidenceReference[];
  readonly uncertainty: string;
  readonly idempotencyKey: string;
}

export interface CandidateProjection {
  readonly candidateId: string;
  readonly disposition: CandidateDisposition;
  readonly thesis: string;
  readonly evidence: readonly EvidenceReference[];
  readonly counterevidence: readonly EvidenceReference[];
  readonly uncertainty: string;
  readonly commitmentDigest: string;
  readonly eventId: string;
  readonly createdAt: string;
}

export interface EvaluationCandidatePacket {
  readonly candidateId: string;
  readonly disposition: CandidateDisposition;
  readonly thesis: string;
  readonly evidence: readonly EvidenceReference[];
  readonly counterevidence: readonly EvidenceReference[];
  readonly uncertainty: string;
}

type CandidatePrivateTextUse = "THESIS" | "UNCERTAINTY";

interface HydratedCandidate extends CandidateProjection {
  readonly privateTextUses: readonly CandidatePrivateTextUse[];
  readonly privateTextDigest: string | null;
}

export interface RecordEvaluationInput {
  readonly windowId: string;
  readonly evaluatorRunId: string;
  readonly scores: readonly CandidateScoreInput[];
  readonly idempotencyKey: string;
}

export interface DecisionSelection {
  readonly windowId: string;
  readonly result: "MAIN" | "CONTENDER" | "NO_PAPER_TRADE";
  readonly selectedCandidateId: string | null;
  readonly evaluatorRunId: string;
  readonly selectionEventId: string;
  readonly createdAt: string;
}

interface WindowRow extends Record<string, unknown> {
  readonly id: string;
  readonly snapshot_digest: string;
  readonly opened_event_id: string;
  readonly policy_version: string;
  readonly request_digest: string;
  readonly created_at: Date;
}

interface CandidateRow extends Record<string, unknown> {
  readonly window_id: string;
  readonly candidate_id: string;
  readonly candidate_kind: "MAIN" | "CONTENDER";
  readonly account_id: string | null;
  readonly node_brain_id: string | null;
  readonly proposal_id: string | null;
  readonly disposition: CandidateDisposition;
  readonly commitment_digest: string;
  readonly candidate_event_id: string;
  readonly request_digest: string;
  readonly created_at: Date;
}

interface SelectionRow extends Record<string, unknown> {
  readonly window_id: string;
  readonly result: DecisionSelection["result"];
  readonly selected_candidate_id: string | null;
  readonly evaluator_run_id: string;
  readonly selection_event_id: string;
  readonly request_digest: string;
  readonly created_at: Date;
}

type DecisionOperation = "WINDOW_OPEN" | "MAIN_COMMIT" | "CONTENDER_SUBMIT" | "EVALUATION_RECORD";

function databaseFrom(context: DecisionContext): EventDatabase {
  if (!context || typeof context !== "object" || !context.db) throw new Error("DECISION_CONTEXT_INVALID");
  return context.db;
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new Error("DECISION_IDEMPOTENCY_KEY_INVALID");
  }
  return value;
}

function boundedText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value !== value.trim() || value.includes("\u0000")) throw new Error(code);
  return value;
}

function canonicalStrings(
  value: unknown,
  maximum: number,
  pattern: RegExp,
  code: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new Error(code);
  const strings = value.map((item) => {
    if (typeof item !== "string" || !pattern.test(item)) throw new Error(code);
    return item;
  });
  return Object.freeze([...new Set(strings)].sort());
}

function snapshotJson(value: unknown, code: string): JsonValue {
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch {
    throw new Error(code);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_SNAPSHOT_JSON_BYTES) throw new Error(code);
  return deepFreeze(JSON.parse(encoded) as JsonValue);
}

function deepFreeze<Value extends JsonValue>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

async function claimOperation(
  database: EventDatabase,
  input: {
    readonly key: string;
    readonly operation: DecisionOperation;
    readonly scope: string;
    readonly requestDigest: string;
  },
): Promise<void> {
  await database.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `decision-operation:${input.key}`,
  ]);
  const rows = await database.query<{
    readonly operation: string;
    readonly aggregate_scope: string;
    readonly request_digest: string;
  }>(
    `select operation, aggregate_scope, request_digest
     from decision_operation_idempotency where idempotency_key=$1`,
    [input.key],
  );
  if (rows[0]) {
    if (rows[0].operation !== input.operation || rows[0].aggregate_scope !== input.scope
      || !digestsEqual(rows[0].request_digest, input.requestDigest)) {
      throw new Error("DECISION_IDEMPOTENCY_KEY_REUSED");
    }
    return;
  }
  await database.query(
    `insert into decision_operation_idempotency
       (idempotency_key, operation, aggregate_scope, request_digest)
     values ($1,$2,$3,$4)`,
    [input.key, input.operation, input.scope, input.requestDigest],
  );
}

function parseWindowBody(body: JsonValue): Omit<DecisionWindowProjection, "id" | "openedEventId" | "createdAt"> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("DECISION_WINDOW_INTEGRITY_FAILURE");
  }
  const record = body as Record<string, JsonValue>;
  const marketObservationIds = canonicalStrings(
    record.marketObservationIds, 128, REFERENCE_PATTERN, "DECISION_WINDOW_INTEGRITY_FAILURE",
  );
  const eligibleInstruments = canonicalStrings(
    record.eligibleInstruments, 128, INSTRUMENT_PATTERN, "DECISION_WINDOW_INTEGRITY_FAILURE",
  );
  const evidence = canonicalEvidenceReferences(record.evidence, { max: 128, allowEmpty: false });
  const stageProfileVersion = boundedText(
    record.stageProfileVersion, 128, "DECISION_WINDOW_INTEGRITY_FAILURE",
  );
  if (!PROFILE_PATTERN.test(stageProfileVersion)) throw new Error("DECISION_WINDOW_INTEGRITY_FAILURE");
  const portfolioSnapshot = snapshotJson(record.portfolioSnapshot, "DECISION_WINDOW_INTEGRITY_FAILURE");
  const costModelSnapshot = snapshotJson(record.costModelSnapshot, "DECISION_WINDOW_INTEGRITY_FAILURE");
  const snapshotDigest = canonicalContentDigest({
    costModelSnapshot, eligibleInstruments, evidence, marketObservationIds,
    portfolioSnapshot, stageProfileVersion,
  });
  return Object.freeze({
    marketObservationIds, evidence, portfolioSnapshot, costModelSnapshot,
    stageProfileVersion, eligibleInstruments, snapshotDigest,
  });
}

async function hydrateWindow(database: EventDatabase, row: WindowRow): Promise<DecisionWindowProjection> {
  if (row.policy_version !== DECISION_POLICY_VERSION) throw new Error("DECISION_WINDOW_INTEGRITY_FAILURE");
  const body = parseWindowBody(await readEventBody(database, row.opened_event_id, {
    actor: { role: "SYSTEM" },
  }));
  if (!digestsEqual(body.snapshotDigest, row.snapshot_digest)) {
    throw new Error("DECISION_WINDOW_INTEGRITY_FAILURE");
  }
  return Object.freeze({
    id: row.id,
    ...body,
    openedEventId: row.opened_event_id,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export async function openDecisionWindow(
  context: DecisionContext,
  input: OpenDecisionWindowInput,
): Promise<DecisionWindowProjection> {
  const database = databaseFrom(context);
  const marketObservationIds = canonicalStrings(
    input?.marketObservationIds, 128, REFERENCE_PATTERN, "DECISION_MARKET_SNAPSHOT_INVALID",
  );
  const evidence = canonicalEvidenceReferences(input?.evidence, { max: 128, allowEmpty: false });
  const portfolioSnapshot = snapshotJson(input?.portfolioSnapshot, "DECISION_PORTFOLIO_SNAPSHOT_INVALID");
  const costModelSnapshot = snapshotJson(input?.costModelSnapshot, "DECISION_COST_SNAPSHOT_INVALID");
  const stageProfileVersion = boundedText(
    input?.stageProfileVersion, 128, "DECISION_PROFILE_VERSION_INVALID",
  );
  if (!PROFILE_PATTERN.test(stageProfileVersion)) throw new Error("DECISION_PROFILE_VERSION_INVALID");
  const eligibleInstruments = canonicalStrings(
    input?.eligibleInstruments, 128, INSTRUMENT_PATTERN, "DECISION_INSTRUMENTS_INVALID",
  );
  const key = idempotencyKey(input?.idempotencyKey);
  const body = snapshotJson({
    costModelSnapshot, eligibleInstruments, evidence, marketObservationIds,
    portfolioSnapshot, stageProfileVersion,
  }, "DECISION_WINDOW_SNAPSHOT_INVALID") as Record<string, JsonValue>;
  const snapshotDigest = canonicalContentDigest(body);
  const requestDigest = canonicalContentDigest({ snapshotDigest });
  return database.transaction(async (transaction) => {
    await claimOperation(transaction, {
      key, operation: "WINDOW_OPEN", scope: "shared-challenge", requestDigest,
    });
    const existing = await transaction.query<WindowRow>(
      `select id::text, snapshot_digest, opened_event_id::text, policy_version,
              request_digest, created_at from decision_windows where idempotency_key=$1`,
      [key],
    );
    if (existing[0]) {
      if (!digestsEqual(existing[0].request_digest, requestDigest)) throw new Error("DECISION_IDEMPOTENCY_KEY_REUSED");
      return hydrateWindow(transaction, existing[0]);
    }
    const id = randomUUID();
    const event = await appendEvent(transaction, {
      aggregateId: id,
      actor: { type: "SYSTEM", id: "gustavo-decision-orchestrator" },
      type: "decision.window.opened",
      visibility: "OPERATOR",
      body,
      idempotencyKey: `decision-window:${key}`,
      policyVersion: DECISION_POLICY_VERSION,
    });
    const rows = await transaction.query<WindowRow>(
      `insert into decision_windows (
         id, market_observation_ids, evidence_count, portfolio_snapshot_digest,
         cost_model_snapshot_digest, stage_profile_version, eligible_instruments,
         snapshot_digest, opened_event_id, policy_version,
         idempotency_key, request_digest, created_at
       ) values ($1,$2::jsonb,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
       returning id::text, snapshot_digest, opened_event_id::text, policy_version,
                 request_digest, created_at`,
      [id, JSON.stringify(marketObservationIds), evidence.length,
        canonicalContentDigest(portfolioSnapshot), canonicalContentDigest(costModelSnapshot),
        stageProfileVersion, JSON.stringify(eligibleInstruments), snapshotDigest,
        event.id, DECISION_POLICY_VERSION, key, requestDigest, event.occurredAt],
    );
    return hydrateWindow(transaction, rows[0]);
  });
}

export async function getDecisionWindow(
  context: DecisionContext,
  windowId: string,
): Promise<DecisionWindowProjection> {
  const database = databaseFrom(context);
  const id = uuid(windowId, "DECISION_WINDOW_ID_INVALID");
  const rows = await database.query<WindowRow>(
    `select id::text, snapshot_digest, opened_event_id::text, policy_version,
            request_digest, created_at from decision_windows where id=$1`,
    [id],
  );
  if (!rows[0]) throw new Error("DECISION_WINDOW_NOT_FOUND");
  return hydrateWindow(database, rows[0]);
}

function canonicalCandidateBody(input: {
  readonly candidateId: string;
  readonly disposition: CandidateDisposition;
  readonly thesis: string;
  readonly evidence: readonly EvidenceReference[];
  readonly counterevidence: readonly EvidenceReference[];
  readonly uncertainty: string;
  readonly privateTextUses?: readonly CandidatePrivateTextUse[];
  readonly privateTextDigest?: string;
}): Record<string, JsonValue> {
  if (input.disposition !== "THESIS" && input.disposition !== "NO_PAPER_TRADE") {
    throw new Error("DECISION_CANDIDATE_DISPOSITION_INVALID");
  }
  const thesis = boundedText(input.thesis, 8_000, "DECISION_THESIS_INVALID");
  const uncertainty = boundedText(input.uncertainty, 2_000, "DECISION_UNCERTAINTY_INVALID");
  const evidence = canonicalEvidenceReferences(input.evidence, { max: 64, allowEmpty: input.disposition === "NO_PAPER_TRADE" });
  const counterevidence = canonicalEvidenceReferences(input.counterevidence, { max: 64, allowEmpty: true });
  const privateTextUses = [...new Set(input.privateTextUses ?? [])].sort();
  if (privateTextUses.some((use) => use !== "THESIS" && use !== "UNCERTAINTY")
    || (privateTextUses.length > 0) !== (input.privateTextDigest !== undefined)
    || (input.privateTextDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.privateTextDigest))
    || (privateTextUses.includes("THESIS") && thesis !== "[AUTHORIZED PRIVATE TEXT]")
    || (privateTextUses.includes("UNCERTAINTY") && uncertainty !== "[AUTHORIZED PRIVATE TEXT]")) {
    throw new Error("DECISION_CANDIDATE_PRIVATE_TEXT_INVALID");
  }
  if (input.disposition === "THESIS" && evidence.length === 0) throw new Error("DECISION_EVIDENCE_REQUIRED");
  return snapshotJson({
    candidateId: input.candidateId,
    disposition: input.disposition,
    thesis,
    evidence,
    counterevidence,
    uncertainty,
    privateTextUses,
    privateTextDigest: input.privateTextDigest ?? null,
  }, "DECISION_CANDIDATE_INVALID") as Record<string, JsonValue>;
}

function parseCandidateBody(body: JsonValue): EvaluationCandidatePacket & {
  readonly privateTextUses: readonly CandidatePrivateTextUse[];
  readonly privateTextDigest: string | null;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.candidateId !== "string"
    || (body.disposition !== "THESIS" && body.disposition !== "NO_PAPER_TRADE")
    || typeof body.thesis !== "string" || typeof body.uncertainty !== "string") {
    throw new Error("DECISION_CANDIDATE_INTEGRITY_FAILURE");
  }
  const canonical = canonicalCandidateBody({
    candidateId: body.candidateId,
    disposition: body.disposition,
    thesis: body.thesis,
    evidence: body.evidence as unknown as readonly EvidenceReference[],
    counterevidence: body.counterevidence as unknown as readonly EvidenceReference[],
    uncertainty: body.uncertainty,
    privateTextUses: body.privateTextUses as unknown as readonly CandidatePrivateTextUse[],
    privateTextDigest: body.privateTextDigest === null ? undefined : body.privateTextDigest as string,
  });
  return Object.freeze({
    candidateId: canonical.candidateId as string,
    disposition: canonical.disposition as CandidateDisposition,
    thesis: canonical.thesis as string,
    evidence: canonical.evidence as unknown as readonly EvidenceReference[],
    counterevidence: canonical.counterevidence as unknown as readonly EvidenceReference[],
    uncertainty: canonical.uncertainty as string,
    privateTextUses: canonical.privateTextUses as unknown as readonly CandidatePrivateTextUse[],
    privateTextDigest: canonical.privateTextDigest as string | null,
  });
}

function assertEvidenceWithinSnapshot(
  body: Record<string, JsonValue>,
  snapshotEvidence: readonly EvidenceReference[],
): void {
  const allowed = new Set(snapshotEvidence.map((reference) => `${reference.kind}:${reference.referenceId}`));
  const used = [
    ...canonicalEvidenceReferences(body.evidence, { max: 64, allowEmpty: true }),
    ...canonicalEvidenceReferences(body.counterevidence, { max: 64, allowEmpty: true }),
  ];
  if (used.some((reference) => !allowed.has(`${reference.kind}:${reference.referenceId}`))) {
    throw new Error("DECISION_EVIDENCE_OUTSIDE_SNAPSHOT");
  }
}

async function hydrateCandidate(database: EventDatabase, row: CandidateRow): Promise<HydratedCandidate> {
  const body = parseCandidateBody(await readEventBody(database, row.candidate_event_id, {
    actor: { role: "SYSTEM" },
  }));
  const digest = canonicalContentDigest(body);
  if (body.candidateId !== row.candidate_id || body.disposition !== row.disposition
    || !digestsEqual(digest, row.commitment_digest)) {
    throw new Error("DECISION_CANDIDATE_INTEGRITY_FAILURE");
  }
  return Object.freeze({
    ...body,
    commitmentDigest: row.commitment_digest,
    eventId: row.candidate_event_id,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

async function windowRow(database: EventDatabase, windowId: string): Promise<WindowRow> {
  const rows = await database.query<WindowRow>(
    `select id::text, snapshot_digest, opened_event_id::text, policy_version,
            request_digest, created_at from decision_windows where id=$1`,
    [windowId],
  );
  if (!rows[0]) throw new Error("DECISION_WINDOW_NOT_FOUND");
  return rows[0];
}

export async function commitMainBaseline(
  context: DecisionContext,
  input: MainBaselineInput,
): Promise<CandidateProjection> {
  const database = databaseFrom(context);
  const windowId = uuid(input?.windowId, "DECISION_WINDOW_ID_INVALID");
  const key = idempotencyKey(input?.idempotencyKey);
  const body = canonicalCandidateBody({
    candidateId: "main",
    disposition: input.disposition,
    thesis: input.thesis,
    evidence: input.evidence,
    counterevidence: input.counterevidence,
    uncertainty: input.uncertainty,
  });
  const commitmentDigest = canonicalContentDigest(body);
  const requestDigest = canonicalContentDigest({ commitmentDigest, windowId });
  return database.transaction(async (transaction) => {
    await claimOperation(transaction, {
      key, operation: "MAIN_COMMIT", scope: windowId, requestDigest,
    });
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`decision-window:${windowId}`]);
    const window = await windowRow(transaction, windowId);
    const existing = await transaction.query<CandidateRow>(
      `select window_id::text, candidate_id, candidate_kind, account_id::text,
              node_brain_id::text, proposal_id::text, disposition, commitment_digest,
              candidate_event_id::text, request_digest, created_at
       from decision_candidates where idempotency_key=$1`, [key],
    );
    if (existing[0]) {
      if (!digestsEqual(existing[0].request_digest, requestDigest)) throw new Error("DECISION_IDEMPOTENCY_KEY_REUSED");
      return hydrateCandidate(transaction, existing[0]);
    }
    const committed = await transaction.query<{ readonly count: number }>(
      "select count(*)::int as count from decision_candidates where window_id=$1 and candidate_kind='MAIN'",
      [windowId],
    );
    if (committed[0]?.count !== 0) throw new Error("DECISION_MAIN_ALREADY_COMMITTED");
    assertEvidenceWithinSnapshot(body, (await hydrateWindow(transaction, window)).evidence);
    const event = await appendEvent(transaction, {
      aggregateId: windowId,
      actor: { type: "MAIN_BRAIN", id: "gustavo-main" },
      type: "main.baseline.committed",
      visibility: "OPERATOR",
      body,
      idempotencyKey: `decision-main:${key}`,
      causationId: window.opened_event_id,
      policyVersion: DECISION_POLICY_VERSION,
    });
    const rows = await transaction.query<CandidateRow>(
      `insert into decision_candidates (
         window_id, candidate_id, candidate_kind, disposition, commitment_digest,
         candidate_event_id, idempotency_key, request_digest, created_at
       ) values ($1,'main','MAIN',$2,$3,$4,$5,$6,$7)
       returning window_id::text, candidate_id, candidate_kind, account_id::text,
                 node_brain_id::text, proposal_id::text, disposition, commitment_digest,
                 candidate_event_id::text, request_digest, created_at`,
      [windowId, input.disposition, commitmentDigest, event.id, key, requestDigest, event.occurredAt],
    );
    return hydrateCandidate(transaction, rows[0]);
  });
}

export async function submitContender(
  context: DecisionContext,
  input: { readonly windowId: string; readonly proposalId: string; readonly idempotencyKey: string },
): Promise<CandidateProjection> {
  const database = databaseFrom(context);
  const windowId = uuid(input?.windowId, "DECISION_WINDOW_ID_INVALID");
  const proposalId = uuid(input?.proposalId, "DECISION_PROPOSAL_ID_INVALID");
  const key = idempotencyKey(input?.idempotencyKey);
  const requestDigest = canonicalContentDigest({ proposalId, windowId });
  return database.transaction(async (transaction) => {
    await claimOperation(transaction, {
      key, operation: "CONTENDER_SUBMIT", scope: windowId, requestDigest,
    });
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`decision-window:${windowId}`]);
    const window = await windowRow(transaction, windowId);
    const existing = await transaction.query<CandidateRow>(
      `select window_id::text, candidate_id, candidate_kind, account_id::text,
              node_brain_id::text, proposal_id::text, disposition, commitment_digest,
              candidate_event_id::text, request_digest, created_at
       from decision_candidates where idempotency_key=$1`, [key],
    );
    if (existing[0]) {
      if (!digestsEqual(existing[0].request_digest, requestDigest)) throw new Error("DECISION_IDEMPOTENCY_KEY_REUSED");
      return hydrateCandidate(transaction, existing[0]);
    }
    const main = await transaction.query<{ readonly count: number }>(
      "select count(*)::int as count from decision_candidates where window_id=$1 and candidate_kind='MAIN'",
      [windowId],
    );
    if (main[0]?.count !== 1) throw new Error("DECISION_MAIN_COMMITMENT_REQUIRED");
    const proposalRows = await transaction.query<{
      readonly account_id: string;
      readonly node_brain_id: string;
      readonly created_event_id: string;
      readonly raw_private_text_digest: string | null;
      readonly status: string;
    }>(
      `select proposal.account_id::text, proposal.node_brain_id::text,
              proposal.created_event_id::text, proposal.raw_private_text_digest,
              (select transition.to_status from proposal_status_transitions transition
               where transition.proposal_id=proposal.id order by transition.ordinal desc limit 1) as status
       from proposals proposal where proposal.id=$1`,
      [proposalId],
    );
    const proposalRow = proposalRows[0];
    if (!proposalRow || proposalRow.status !== "QUEUED_FOR_DECISION") {
      throw new Error("DECISION_CONTENDER_FORBIDDEN");
    }
    const proposal = await getProposal(
      { db: transaction }, { accountId: proposalRow.account_id, proposalId },
    );
    if (proposalRow.raw_private_text_digest && !proposal.rawPrivateText) {
      throw new Error("DECISION_CONTENDER_DISCLOSURE_FORBIDDEN");
    }
    if (!proposalRow.raw_private_text_digest && proposal.rawPrivateText) {
      throw new Error("DECISION_CONTENDER_INTEGRITY_FAILURE");
    }
    const privateTextUses: CandidatePrivateTextUse[] = [];
    if (proposal.rawPrivateText !== undefined) {
      if (proposal.proposedChange === proposal.rawPrivateText) privateTextUses.push("THESIS");
      if (proposal.uncertainty === proposal.rawPrivateText) privateTextUses.push("UNCERTAINTY");
      if (privateTextUses.length === 0) throw new Error("DECISION_CONTENDER_INTEGRITY_FAILURE");
    }
    const anonymous = anonymizeCandidate({
      accountId: proposalRow.account_id,
      nodeBrainId: proposalRow.node_brain_id,
      windowId,
      thesis: proposal.proposedChange,
    });
    const body = canonicalCandidateBody({
      candidateId: anonymous.candidateId,
      disposition: "THESIS",
      thesis: privateTextUses.includes("THESIS") ? "[AUTHORIZED PRIVATE TEXT]" : anonymous.thesis,
      evidence: proposal.evidence,
      counterevidence: proposal.counterevidence,
      uncertainty: privateTextUses.includes("UNCERTAINTY") ? "[AUTHORIZED PRIVATE TEXT]" : proposal.uncertainty,
      privateTextUses,
      ...(proposalRow.raw_private_text_digest
        ? { privateTextDigest: proposalRow.raw_private_text_digest } : {}),
    });
    assertEvidenceWithinSnapshot(body, (await hydrateWindow(transaction, window)).evidence);
    const commitmentDigest = canonicalContentDigest(body);
    const event = await appendEvent(transaction, {
      aggregateId: windowId,
      accountId: proposalRow.account_id,
      actor: { type: "NODE_BRAIN", id: proposalRow.node_brain_id },
      type: "contender.submitted",
      visibility: "PRIVATE_ACCOUNT",
      body,
      idempotencyKey: `decision-contender:${key}`,
      causationId: proposalRow.created_event_id,
      policyVersion: DECISION_POLICY_VERSION,
    });
    const rows = await transaction.query<CandidateRow>(
      `insert into decision_candidates (
         window_id, candidate_id, candidate_kind, account_id, node_brain_id,
         proposal_id, disposition, commitment_digest, candidate_event_id,
         idempotency_key, request_digest, created_at
       ) values ($1,$2,'CONTENDER',$3,$4,$5,'THESIS',$6,$7,$8,$9,$10)
       returning window_id::text, candidate_id, candidate_kind, account_id::text,
                 node_brain_id::text, proposal_id::text, disposition, commitment_digest,
                 candidate_event_id::text, request_digest, created_at`,
      [windowId, anonymous.candidateId, proposalRow.account_id, proposalRow.node_brain_id,
        proposalId, commitmentDigest, event.id, key, requestDigest, event.occurredAt],
    );
    return hydrateCandidate(transaction, rows[0]);
  });
}

export async function evaluationPacket(
  context: DecisionContext,
  windowIdValue: string,
): Promise<readonly EvaluationCandidatePacket[]> {
  const database = databaseFrom(context);
  const windowId = uuid(windowIdValue, "DECISION_WINDOW_ID_INVALID");
  await windowRow(database, windowId);
  const rows = await database.query<CandidateRow>(
    `select window_id::text, candidate_id, candidate_kind, account_id::text,
            node_brain_id::text, proposal_id::text, disposition, commitment_digest,
            candidate_event_id::text, request_digest, created_at
     from decision_candidates where window_id=$1
     order by case when candidate_kind='MAIN' then 0 else 1 end, candidate_id`,
    [windowId],
  );
  if (!rows.some((row) => row.candidate_kind === "MAIN")) {
    throw new Error("DECISION_MAIN_COMMITMENT_REQUIRED");
  }
  const packet = await Promise.all(rows.map(async (row) => {
    const candidate = await hydrateCandidate(database, row);
    let thesis = candidate.thesis;
    let uncertainty = candidate.uncertainty;
    if (candidate.privateTextUses.length > 0) {
      if (row.candidate_kind !== "CONTENDER" || !row.account_id || !row.proposal_id
        || !candidate.privateTextDigest) throw new Error("DECISION_CANDIDATE_INTEGRITY_FAILURE");
      const proposalDigest = await database.query<{ readonly raw_private_text_digest: string | null }>(
        "select raw_private_text_digest from proposals where id=$1 and account_id=$2",
        [row.proposal_id, row.account_id],
      );
      if (!proposalDigest[0]?.raw_private_text_digest
        || !digestsEqual(proposalDigest[0].raw_private_text_digest, candidate.privateTextDigest)) {
        throw new Error("DECISION_CANDIDATE_INTEGRITY_FAILURE");
      }
      const proposal = await getProposal(
        { db: database }, { accountId: row.account_id, proposalId: row.proposal_id },
      );
      if (!proposal.rawPrivateText) throw new Error("DECISION_CONTENDER_DISCLOSURE_FORBIDDEN");
      if (candidate.privateTextUses.includes("THESIS")) thesis = proposal.rawPrivateText;
      if (candidate.privateTextUses.includes("UNCERTAINTY")) uncertainty = proposal.rawPrivateText;
    }
    return Object.freeze({
      candidateId: candidate.candidateId,
      disposition: candidate.disposition,
      thesis,
      evidence: candidate.evidence,
      counterevidence: candidate.counterevidence,
      uncertainty,
    });
  }));
  return Object.freeze(packet);
}

function selectionFrom(row: SelectionRow): DecisionSelection {
  return Object.freeze({
    windowId: row.window_id,
    result: row.result,
    selectedCandidateId: row.selected_candidate_id,
    evaluatorRunId: row.evaluator_run_id,
    selectionEventId: row.selection_event_id,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function canonicalScores(value: unknown): readonly CandidateScoreInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CANDIDATES) {
    throw new Error("DECISION_SCORES_INVALID");
  }
  const seen = new Set<string>();
  const scores = value.map((item) => {
    const scored = scoreCandidate(item as CandidateScoreInput);
    if (seen.has(scored.id)) throw new Error("DECISION_SCORES_INVALID");
    seen.add(scored.id);
    const original = item as CandidateScoreInput;
    return Object.freeze({
      candidateId: scored.id,
      components: Object.freeze({ ...original.components }) as RubricComponents,
      hardGates: Object.freeze({ ...original.hardGates }) as HardGates,
    });
  });
  return Object.freeze(scores.sort((left, right) => left.candidateId.localeCompare(right.candidateId)));
}

export async function recordEvaluation(
  context: DecisionContext,
  input: RecordEvaluationInput,
): Promise<DecisionSelection> {
  const database = databaseFrom(context);
  const windowId = uuid(input?.windowId, "DECISION_WINDOW_ID_INVALID");
  const evaluatorRunId = uuid(input?.evaluatorRunId, "DECISION_EVALUATOR_RUN_INVALID");
  const scores = canonicalScores(input?.scores);
  const key = idempotencyKey(input?.idempotencyKey);
  const requestDigest = canonicalContentDigest({ evaluatorRunId, scores, windowId });
  return database.transaction(async (transaction) => {
    await claimOperation(transaction, {
      key, operation: "EVALUATION_RECORD", scope: windowId, requestDigest,
    });
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`decision-window:${windowId}`]);
    const window = await windowRow(transaction, windowId);
    const duplicate = await transaction.query<SelectionRow>(
      `select window_id::text, result, selected_candidate_id, evaluator_run_id::text,
              selection_event_id::text, request_digest, created_at
       from decision_selections where idempotency_key=$1`, [key],
    );
    if (duplicate[0]) {
      if (!digestsEqual(duplicate[0].request_digest, requestDigest)) throw new Error("DECISION_IDEMPOTENCY_KEY_REUSED");
      return selectionFrom(duplicate[0]);
    }
    const closed = await transaction.query<{ readonly exists: boolean }>(
      "select exists(select 1 from decision_selections where window_id=$1) as exists",
      [windowId],
    );
    if (closed[0]?.exists) throw new Error("DECISION_WINDOW_CLOSED");
    const candidates = await transaction.query<CandidateRow>(
      `select window_id::text, candidate_id, candidate_kind, account_id::text,
              node_brain_id::text, proposal_id::text, disposition, commitment_digest,
              candidate_event_id::text, request_digest, created_at
       from decision_candidates where window_id=$1 order by candidate_id`,
      [windowId],
    );
    if (candidates.length < 1 || candidates.length !== scores.length
      || candidates.some((candidate, index) => candidate.candidate_id !== scores[index]?.candidateId)) {
      throw new Error("DECISION_EVALUATION_INCOMPLETE");
    }
    const main = candidates.find((candidate) => candidate.candidate_kind === "MAIN");
    if (!main) throw new Error("DECISION_MAIN_COMMITMENT_REQUIRED");
    const runs = await transaction.query<{
      readonly prompt_version: string;
      readonly model: string;
      readonly policy_version: string;
    }>(
      `select prompt_version, model, policy_version from model_runs
       where id=$1 and role='EVALUATOR' and completion_status='COMPLETED'
         and causation_id=$2`,
      [evaluatorRunId, main.candidate_event_id],
    );
    const run = runs[0];
    if (!run) throw new Error("DECISION_EVALUATOR_RUN_FORBIDDEN");
    const scored = scores.map((score) => ({ input: score, result: scoreCandidate(score) }));
    const mainScore = scored.find(({ result }) => result.id === "main")?.result;
    if (!mainScore) throw new Error("DECISION_EVALUATION_INCOMPLETE");
    const selected = selectWinner({
      main: { ...mainScore, actionable: main.disposition === "THESIS" },
      contenders: scored.filter(({ result }) => result.id !== "main").map(({ result }) => result),
    });
    const result: DecisionSelection["result"] = selected === "NO_PAPER_TRADE"
      ? "NO_PAPER_TRADE" : selected === "main" ? "MAIN" : "CONTENDER";
    const selectedCandidateId = selected === "NO_PAPER_TRADE" ? null : selected;
    const evaluationBody = snapshotJson({
      rubricVersion: RUBRIC_V1.version,
      scores: scores.map((score) => ({
        candidateId: score.candidateId,
        components: score.components,
        hardGates: score.hardGates,
      })),
    }, "DECISION_EVALUATION_BODY_INVALID");
    const evaluationEvent = await appendEvent(transaction, {
      aggregateId: windowId,
      actor: { type: "EVALUATOR", id: evaluatorRunId },
      type: "evaluation.scored",
      visibility: "OPERATOR",
      body: evaluationBody,
      idempotencyKey: `decision-evaluation:${key}`,
      causationId: main.candidate_event_id,
      promptVersion: run.prompt_version,
      modelVersion: run.model,
      policyVersion: run.policy_version,
    });
    for (const { input: score, result: total } of scored) {
      await transaction.query(
        `insert into decision_evaluation_scores (
           window_id, candidate_id, evaluator_run_id,
           evidence_freshness, structural_clarity, cost_adjusted_geometry,
           falsifiability, uncertainty, independence,
           evidence_fresh, session_valid, geometry_complete, non_duplicate, authorized,
           total_score, prompt_version, model_version, policy_version,
           evaluation_event_id, created_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [windowId, score.candidateId, evaluatorRunId,
          score.components.evidenceFreshness, score.components.structuralClarity,
          score.components.costAdjustedGeometry, score.components.falsifiability,
          score.components.uncertainty, score.components.independence,
          score.hardGates.evidenceFresh, score.hardGates.sessionValid,
          score.hardGates.geometryComplete, score.hardGates.nonDuplicate,
          score.hardGates.authorized, total.score, run.prompt_version, run.model,
          run.policy_version, evaluationEvent.id, evaluationEvent.occurredAt],
      );
    }
    const selectionEvent = await appendEvent(transaction, {
      aggregateId: windowId,
      actor: { type: "SYSTEM", id: "gustavo-decision-orchestrator" },
      type: "decision.selected",
      visibility: "OPERATOR",
      body: {
        actionThreshold: RUBRIC_V1.actionThreshold,
        improvementMargin: RUBRIC_V1.improvementMargin,
        result,
        rubricVersion: RUBRIC_V1.version,
        selectedCandidateId,
      },
      idempotencyKey: `decision-selection:${key}`,
      causationId: evaluationEvent.id,
      correlationId: undefined,
      policyVersion: DECISION_POLICY_VERSION,
    });
    const rows = await transaction.query<SelectionRow>(
      `insert into decision_selections (
         window_id, result, selected_candidate_id, evaluator_run_id,
         rubric_version, action_threshold, improvement_margin,
         selection_event_id, idempotency_key, request_digest, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning window_id::text, result, selected_candidate_id,
                 evaluator_run_id::text, selection_event_id::text,
                 request_digest, created_at`,
      [windowId, result, selectedCandidateId, evaluatorRunId, RUBRIC_V1.version,
        RUBRIC_V1.actionThreshold, RUBRIC_V1.improvementMargin,
        selectionEvent.id, key, requestDigest, selectionEvent.occurredAt],
    );
    void window;
    return selectionFrom(rows[0]);
  });
}
