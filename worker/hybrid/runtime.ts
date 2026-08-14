import {
  BROADCAST_EVALUATOR_RUBRIC,
  claimNextBridgeJob,
  commitAcceptedEvaluatorBridgeJob,
  failBridgeJob,
  stageMainCandidateAndEvaluator,
  validateMainCandidateAuthority,
  validateMainGenerationAuthority,
  type BridgeCallerFailureCode,
  type BridgeJobRole,
  type BridgeModelJobRow,
  type MainCandidateCycleAuthority,
  type MainGenerationCycleAuthority,
  type ValidatedMainGenerationAuthority,
} from "../../lib/server/bridge/jobs";
import { canonicalContentDigest, digestsEqual } from "../../lib/server/events/integrity";
import { readEventBody } from "../../lib/server/events/store";
import type { EventDatabase, JsonValue } from "../../lib/server/events/types";
import {
  appendMessage,
  type ConversationHistoryContext,
} from "../../lib/server/history/messages";
import type {
  ModelGenerationRequest,
  ModelGenerationResult,
} from "../../lib/server/models/types";
import { marketWindowStart } from "../../lib/server/market-data/session";
import {
  NODE_ROUTING_POLICY_VERSION,
  routeNodeReply,
} from "../../lib/server/node-brains/router";

const NODE_PROMPT_VERSION = "hybrid-node-v1" as const;
const NODE_MAIN_STATE_VERSION = "bridge-node-v1" as const;
const MAIN_PROMPT_VERSION = "hybrid-main-v1" as const;
const EVALUATOR_PROMPT_VERSION = "hybrid-evaluator-v1" as const;
const MAX_MAIN_CANDIDATE_LENGTH = 20_000;
const HYBRID_MODEL_JSON_MAX_BYTES = 100_000;
const HYBRID_MODEL_JSON_MAX_DEPTH = 64;
const SAFE_RATIONALE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

interface MainBridgeAuthority {
  readonly cycleId: string;
  readonly prompt: string;
  readonly sourceEventId?: string;
  readonly correlationId?: string;
  readonly policyVersion?: string;
}

interface EvaluatorBridgeAuthority extends MainBridgeAuthority {
  readonly candidateEventId: string;
  readonly rubricVersion: typeof BROADCAST_EVALUATOR_RUBRIC.version;
  readonly rubricDigest: string;
  readonly rubricCriteria: readonly string[];
}

export interface ExecuteMainBridgeJobOptions {
  readonly jobId: string;
  readonly loadAuthority: (jobId: string) => Promise<MainBridgeAuthority | null>;
  readonly generate: (authority: MainBridgeAuthority) => Promise<unknown>;
  readonly appendCandidate: (input: {
    readonly jobId: string;
    readonly cycleId: string;
    readonly candidate: string;
  }) => Promise<{ readonly candidateEventId: string }>;
  readonly stageEvaluator: (input: {
    readonly mainJobId: string;
    readonly cycleId: string;
    readonly candidateEventId: string;
  }) => Promise<{ readonly jobId: string }>;
}

export interface ExecuteEvaluatorBridgeJobOptions {
  readonly jobId: string;
  readonly loadAuthority: (jobId: string) => Promise<EvaluatorBridgeAuthority | null>;
  readonly generate: (authority: EvaluatorBridgeAuthority) => Promise<unknown>;
  readonly commitBroadcast: (input: {
    readonly jobId: string;
    readonly cycleId: string;
    readonly candidateEventId: string;
    readonly decision: "ACCEPT";
    readonly rationaleCode: string;
    readonly rubricVersion: typeof BROADCAST_EVALUATOR_RUBRIC.version;
    readonly rubricDigest: string;
    readonly rubricCriteria: readonly string[];
  }) => Promise<{ readonly broadcastId: string }>;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function hasExactEvaluatorRubric(
  value: Partial<EvaluatorBridgeAuthority>,
): value is EvaluatorBridgeAuthority {
  return value.rubricVersion === BROADCAST_EVALUATOR_RUBRIC.version
    && typeof value.rubricDigest === "string"
    && digestsEqual(value.rubricDigest, BROADCAST_EVALUATOR_RUBRIC.digest)
    && Array.isArray(value.rubricCriteria)
    && value.rubricCriteria.every((criterion) => typeof criterion === "string")
    && canonicalContentDigest(value.rubricCriteria)
      === canonicalContentDigest(BROADCAST_EVALUATOR_RUBRIC.criteria);
}

function sameAuthority(left: object, right: object): boolean {
  return digestsEqual(canonicalContentDigest(left), canonicalContentDigest(right));
}

export async function executeMainBridgeJob(
  options: ExecuteMainBridgeJobOptions,
): Promise<{ readonly candidateEventId: string; readonly evaluatorJobId: string }> {
  const authority = await options.loadAuthority(options.jobId);
  if (!authority) throw new Error("MAIN_AUTHORITY_REVOKED");
  const generated = await options.generate(Object.freeze({ ...authority }));
  if (
    !exactObject(generated, ["candidate"])
    || typeof generated.candidate !== "string"
    || generated.candidate.length < 1
    || generated.candidate.length > MAX_MAIN_CANDIDATE_LENGTH
    || generated.candidate !== generated.candidate.trim()
    || generated.candidate.includes("\u0000")
  ) throw new Error("MAIN_OUTPUT_INVALID");
  const current = await options.loadAuthority(options.jobId);
  if (!current || !sameAuthority(authority, current)) {
    throw new Error("MAIN_AUTHORITY_REVOKED");
  }
  const candidate = await options.appendCandidate({
    jobId: options.jobId,
    cycleId: authority.cycleId,
    candidate: generated.candidate,
  });
  const evaluator = await options.stageEvaluator({
    mainJobId: options.jobId,
    cycleId: authority.cycleId,
    candidateEventId: candidate.candidateEventId,
  });
  return Object.freeze({
    candidateEventId: candidate.candidateEventId,
    evaluatorJobId: evaluator.jobId,
  });
}

export async function executeEvaluatorBridgeJob(
  options: ExecuteEvaluatorBridgeJobOptions,
): Promise<
  | { readonly broadcastId: string; readonly decision: "ACCEPT" }
  | { readonly decision: "REJECT" | "MALFORMED" }
> {
  const authority = await options.loadAuthority(options.jobId);
  if (!authority) throw new Error("EVALUATOR_AUTHORITY_REVOKED");
  if (!hasExactEvaluatorRubric(authority)) {
    throw new Error("EVALUATOR_AUTHORITY_REVOKED");
  }
  const generated = await options.generate(Object.freeze({ ...authority }));
  if (
    !exactObject(generated, ["decision", "rationaleCode", "rubricVersion"])
    || (generated.decision !== "ACCEPT" && generated.decision !== "REJECT")
    || typeof generated.rationaleCode !== "string"
    || !SAFE_RATIONALE_CODE.test(generated.rationaleCode)
    || generated.rubricVersion !== authority.rubricVersion
  ) return Object.freeze({ decision: "MALFORMED" });
  if (generated.decision === "REJECT") {
    return Object.freeze({ decision: "REJECT" });
  }
  const current = await options.loadAuthority(options.jobId);
  if (!current || !sameAuthority(authority, current)) {
    throw new Error("EVALUATOR_AUTHORITY_REVOKED");
  }
  const committed = await options.commitBroadcast({
    jobId: options.jobId,
    cycleId: authority.cycleId,
    candidateEventId: authority.candidateEventId,
    decision: "ACCEPT",
    rationaleCode: generated.rationaleCode,
    rubricVersion: authority.rubricVersion,
    rubricDigest: authority.rubricDigest,
    rubricCriteria: authority.rubricCriteria,
  });
  return Object.freeze({ broadcastId: committed.broadcastId, decision: "ACCEPT" });
}

export interface RunOneHybridJobOptions {
  readonly db: EventDatabase;
  readonly workerId: string;
  readonly generate: (
    request: ModelGenerationRequest,
  ) => Promise<ModelGenerationResult>;
}

export type HybridJobRunResult =
  | {
      readonly role: BridgeJobRole;
      readonly status: "COMPLETED";
      readonly jobId: string;
      readonly outputEventId: string;
      readonly safeCode: null;
    }
  | {
      readonly role: BridgeJobRole;
      readonly status: "FAILED";
      readonly jobId: string;
      readonly outputEventId: null;
      readonly safeCode: BridgeCallerFailureCode;
    }
  | {
      readonly status: "IDLE";
    };

interface AuthorizedNodeSource extends Record<string, unknown> {
  readonly accountId: string;
  readonly conversationId: string;
  readonly nodeBrainId: string;
  readonly sourceEventId: string;
  readonly correlationId: string;
}

interface HydratedNodeSource extends AuthorizedNodeSource {
  readonly prompt: string;
}

interface SourceKeyRow extends Record<string, unknown> {
  readonly dataKeyId: string;
}

interface MainAuthorityRow extends Record<string, unknown> {
  readonly cycleId: string;
  readonly sourceEventId: string;
  readonly generationEventId: string;
  readonly correlationId: string;
  readonly policyVersion: string;
  readonly scheduleId: string;
  readonly scheduleVersion: number;
  readonly slotAt: Date | string;
  readonly snapshot: unknown;
  readonly currentMainStateVersion: number | string | null;
  readonly sourceRequestHash: string;
  readonly sourceIntegrityHash: string;
}

interface EvaluatorAuthorityRow extends MainAuthorityRow {
  readonly candidateEventId: string;
  readonly parentMainJobId: string;
}

interface LockedRuntimeCycleKeyRow extends Record<string, unknown> {
  readonly id: string;
}

interface LockedRuntimeCycleBodyRow extends Record<string, unknown> {
  readonly dataKeyId: string | null;
}

async function lockRuntimeCycleEventBody(
  database: EventDatabase,
  cycleId: string,
  eventId: string,
): Promise<boolean> {
  await database.query(
    `/* hybrid-cycle-aggregate-lock */
     select pg_advisory_xact_lock(hashtextextended($1,0))`,
    [`aggregate-key:${cycleId}`],
  );
  const keys = await database.query<LockedRuntimeCycleKeyRow>(
    `/* hybrid-cycle-key-lock */
     select id::text as id
       from aggregate_data_keys
      where aggregate_id=$1
      order by id
      for key share`,
    [cycleId],
  );
  if (keys.length !== 1) return false;
  const bodies = await database.query<LockedRuntimeCycleBodyRow>(
    `/* hybrid-cycle-body-lock */
     select data_key_id::text as "dataKeyId"
       from encrypted_event_bodies
      where aggregate_id=$1 and event_id=$2
      for share`,
    [cycleId, eventId],
  );
  return bodies.length === 1 && bodies[0].dataKeyId === keys[0].id;
}

type RuntimePhase =
  | "SOURCE"
  | "ROUTING"
  | "MODEL"
  | "OUTPUT";

function safeResult(job: BridgeModelJobRow): HybridJobRunResult {
  if (job.status === "COMPLETED" && job.outputEventId) {
    return Object.freeze({
      role: job.role,
      status: "COMPLETED",
      jobId: job.jobId,
      outputEventId: job.outputEventId,
      safeCode: null,
    });
  }
  if (job.status === "FAILED" && job.safeCode) {
    return Object.freeze({
      role: job.role,
      status: "FAILED",
      jobId: job.jobId,
      outputEventId: null,
      safeCode: job.safeCode as BridgeCallerFailureCode,
    });
  }
  throw new Error("HYBRID_JOB_RESULT_INVALID");
}

function completedResult(jobId: string, outputEventId: string): HybridJobRunResult {
  return Object.freeze({
    role: "NODE",
    status: "COMPLETED",
    jobId,
    outputEventId,
    safeCode: null,
  });
}

function completedRoleResult(
  role: BridgeJobRole,
  jobId: string,
  outputEventId: string,
): HybridJobRunResult {
  return Object.freeze({ role, status: "COMPLETED", jobId, outputEventId, safeCode: null });
}

function jsonPrompt(value: JsonValue): string {
  const prompt = JSON.stringify(value);
  if (prompt.length < 1 || prompt.length > 100_000) {
    throw new Error("HYBRID_SOURCE_BODY_INVALID");
  }
  return prompt;
}

function generationCycleAuthority(row: MainAuthorityRow): MainGenerationCycleAuthority {
  return {
    cycleId: row.cycleId,
    scheduleId: row.scheduleId,
    scheduleVersion: row.scheduleVersion,
    slotAt: row.slotAt,
    snapshot: row.snapshot,
    currentMainStateVersion: row.currentMainStateVersion,
    policyVersion: row.policyVersion,
    sourceEventId: row.generationEventId,
    sourceRequestHash: row.sourceRequestHash,
    sourceIntegrityHash: row.sourceIntegrityHash,
  };
}

function generationPrompt(
  body: JsonValue,
  authority: ValidatedMainGenerationAuthority,
): string {
  return jsonPrompt({
    generation: body,
    authority: {
      cycleId: authority.cycleId,
      currentMainStateVersion: authority.currentMainStateVersion,
      editorialPolicyVersion: authority.editorialPolicyVersion,
      nextMainStateVersion: authority.nextMainStateVersion,
      policyVersion: authority.policyVersion,
      snapshotDigest: authority.snapshotDigest,
      sourceEventId: authority.sourceEventId,
      sourceIds: [...authority.sourceIds],
      sourceIntegrityHash: authority.sourceIntegrityHash,
      sourceRequestHash: authority.sourceRequestHash,
    },
  });
}

async function loadMainAuthority(
  database: EventDatabase,
  job: BridgeModelJobRow,
  workerId: string,
): Promise<MainBridgeAuthority | null> {
  return database.transaction(async (transaction) => {
    if (
      job.cycleId === null
      || !await lockRuntimeCycleEventBody(transaction, job.cycleId, job.sourceEventId)
    ) return null;
    const rows = await transaction.query<MainAuthorityRow>(
      `select cycle.id::text as "cycleId",source.id::text as "sourceEventId",
              source.id::text as "generationEventId",
              source.correlation_id::text as "correlationId",
              cycle.policy_version as "policyVersion",
              cycle.schedule_id as "scheduleId",
              cycle.schedule_version as "scheduleVersion",
              cycle.slot_at as "slotAt",cycle.snapshot,
              cycle.main_state_version as "currentMainStateVersion",
              source.request_hash::text as "sourceRequestHash",
              source.integrity_hash::text as "sourceIntegrityHash"
       from bridge_model_jobs job
       join broadcast_cycles cycle on cycle.id=job.cycle_id
       join events source on source.id=cycle.open_event_id
       join encrypted_event_bodies body
         on body.event_id=source.id and body.aggregate_id=source.aggregate_id
        and body.data_key_id is not null
       join aggregate_data_keys data_key
         on data_key.id=body.data_key_id and data_key.aggregate_id=source.aggregate_id
       join transactional_outbox outbox
         on outbox.event_id=source.id
        and outbox.topic='main.broadcast.generation.requested'
        and outbox.payload=jsonb_build_object('eventId',source.id::text)
       where job.job_id=$1 and job.source_event_id=$2 and cycle.id=$3
         and job.role='MAIN' and job.kind='MAIN_GENERATION' and job.priority=20
         and job.candidate_event_id is null
         and job.status='CLAIMED' and job.lease_owner=$4
         and job.attempt_count=$5 and job.lease_expires_at>clock_timestamp()
         and job.request_digest=bridge_model_job_request_digest(
           job.source_event_id,job.role,job.kind
         )
         and source.aggregate_id=cycle.id::text
         and source.actor_type='MAIN_BRAIN' and source.actor_id='gustavo-main'
         and source.type='main.broadcast.generation.requested'
         and source.visibility='SHARED' and source.account_id is null
         and source.policy_version=cycle.policy_version
       for update of job
       for share of cycle,source,outbox`,
      [job.jobId, job.sourceEventId, job.cycleId, workerId, job.attemptCount],
    );
    if (rows.length !== 1) return null;
    const row = rows[0];
    const bodyValue = await readEventBody(
      transaction,
      row.sourceEventId,
      { actor: { role: "SYSTEM" } },
    );
    const authority = validateMainGenerationAuthority(
      bodyValue,
      generationCycleAuthority(row),
    );
    return Object.freeze({
      ...authority,
      correlationId: row.correlationId,
      prompt: generationPrompt(bodyValue, authority),
    });
  });
}

function candidatePrompt(body: JsonValue, row: EvaluatorAuthorityRow): string {
  const candidate = validateMainCandidateAuthority(body, {
    ...generationCycleAuthority(row),
    candidateEventId: row.candidateEventId,
  } satisfies MainCandidateCycleAuthority);
  return jsonPrompt({
    candidate: candidate.candidate,
    candidateEventId: row.candidateEventId,
    cycleId: candidate.cycleId,
    editorialPolicyVersion: candidate.editorialPolicyVersion,
    generationEventId: candidate.generationEventId,
    generationIntegrityHash: candidate.generationIntegrityHash,
    generationRequestHash: candidate.generationRequestHash,
    mainStateVersion: candidate.mainStateVersion,
    policyVersion: candidate.policyVersion,
    rubric: {
      version: BROADCAST_EVALUATOR_RUBRIC.version,
      digest: BROADCAST_EVALUATOR_RUBRIC.digest,
      criteria: [...BROADCAST_EVALUATOR_RUBRIC.criteria],
    },
    snapshotDigest: candidate.snapshotDigest,
    sourceIds: [...candidate.sourceIds],
  });
}

async function loadEvaluatorAuthority(
  database: EventDatabase,
  job: BridgeModelJobRow,
  workerId: string,
): Promise<EvaluatorBridgeAuthority | null> {
  return database.transaction(async (transaction) => {
    if (
      job.cycleId === null
      || job.candidateEventId === null
      || !await lockRuntimeCycleEventBody(transaction, job.cycleId, job.candidateEventId)
    ) return null;
    const rows = await transaction.query<EvaluatorAuthorityRow>(
      `select cycle.id::text as "cycleId",candidate.id::text as "sourceEventId",
              generation.id::text as "generationEventId",
              candidate.id::text as "candidateEventId",
              parent.job_id::text as "parentMainJobId",
              candidate.correlation_id::text as "correlationId",
              cycle.policy_version as "policyVersion",
              cycle.schedule_id as "scheduleId",
              cycle.schedule_version as "scheduleVersion",
              cycle.slot_at as "slotAt",cycle.snapshot,
              cycle.main_state_version as "currentMainStateVersion",
              generation.request_hash::text as "sourceRequestHash",
              generation.integrity_hash::text as "sourceIntegrityHash"
       from bridge_model_jobs job
       join bridge_model_jobs parent on parent.job_id=job.parent_main_job_id
       join broadcast_cycles cycle on cycle.id=job.cycle_id
       join events generation on generation.id=cycle.open_event_id
       join events candidate on candidate.id=job.candidate_event_id
       join encrypted_event_bodies body
         on body.event_id=candidate.id and body.aggregate_id=candidate.aggregate_id
        and body.data_key_id is not null
       join aggregate_data_keys data_key
         on data_key.id=body.data_key_id and data_key.aggregate_id=candidate.aggregate_id
       join transactional_outbox outbox
         on outbox.event_id=candidate.id
        and outbox.topic='main.broadcast.candidate.generated'
        and outbox.payload=jsonb_build_object('eventId',candidate.id::text)
       where job.job_id=$1 and job.source_event_id=$2 and cycle.id=$3
         and job.candidate_event_id=$2
         and job.role='EVALUATOR' and job.kind='EVALUATOR_REVIEW' and job.priority=10
         and job.status='CLAIMED' and job.lease_owner=$4
         and job.attempt_count=$5 and job.lease_expires_at>clock_timestamp()
         and job.request_digest=bridge_model_job_request_digest(
           job.source_event_id,job.role,job.kind
         )
         and parent.role='MAIN' and parent.kind='MAIN_GENERATION' and parent.priority=20
         and parent.status='COMPLETED' and parent.cycle_id=cycle.id
         and parent.candidate_event_id is null and parent.parent_main_job_id is null
         and parent.output_event_id=candidate.id
         and parent.source_event_id=generation.id
         and parent.request_digest=bridge_model_job_request_digest(
           parent.source_event_id,parent.role,parent.kind
         )
         and candidate.aggregate_id=cycle.id::text
         and candidate.actor_type='MAIN_BRAIN' and candidate.actor_id='gustavo-main'
         and candidate.type='main.broadcast.candidate.generated'
         and candidate.visibility='SHARED' and candidate.account_id is null
         and candidate.causation_id=generation.id
         and candidate.correlation_id=generation.correlation_id
         and candidate.policy_version=cycle.policy_version
         and generation.aggregate_id=cycle.id::text
         and generation.actor_type='MAIN_BRAIN' and generation.actor_id='gustavo-main'
         and generation.type='main.broadcast.generation.requested'
         and generation.visibility='SHARED' and generation.account_id is null
         and generation.policy_version=cycle.policy_version
       for update of job
       for share of parent,cycle,generation,candidate,outbox`,
      [job.jobId, job.sourceEventId, job.cycleId, workerId, job.attemptCount],
    );
    if (rows.length !== 1) return null;
    const row = rows[0];
    const body = await readEventBody(
      transaction,
      row.candidateEventId,
      { actor: { role: "SYSTEM" } },
    );
    return Object.freeze({
      cycleId: row.cycleId,
      candidateEventId: row.candidateEventId,
      sourceEventId: row.sourceEventId,
      correlationId: row.correlationId,
      policyVersion: row.policyVersion,
      prompt: candidatePrompt(body, row),
      rubricVersion: BROADCAST_EVALUATOR_RUBRIC.version,
      rubricDigest: BROADCAST_EVALUATOR_RUBRIC.digest,
      rubricCriteria: BROADCAST_EVALUATOR_RUBRIC.criteria,
    });
  });
}

function invalidHybridModelOutput(): never {
  throw new Error("HYBRID_MODEL_OUTPUT_INVALID");
}

function assertStrictHybridJson(value: string): void {
  const whitespace = (character: string | undefined): boolean =>
    character === " " || character === "\t" || character === "\n" || character === "\r";
  const skipWhitespace = (start: number): number => {
    let index = start;
    while (whitespace(value[index])) index += 1;
    return index;
  };
  const stringEnd = (start: number): number => {
    if (value[start] !== '"') return invalidHybridModelOutput();
    let index = start + 1;
    while (index < value.length) {
      const character = value[index];
      if (character === '"') return index + 1;
      if (character === "\\") {
        const escaped = value[index + 1];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(value.slice(index + 2, index + 6))) {
            return invalidHybridModelOutput();
          }
          index += 6;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) return invalidHybridModelOutput();
        index += 2;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) return invalidHybridModelOutput();
      index += 1;
    }
    return invalidHybridModelOutput();
  };
  const decodedKey = (start: number, end: number): string => {
    try {
      const key = JSON.parse(value.slice(start, end)) as unknown;
      if (typeof key !== "string") return invalidHybridModelOutput();
      return key;
    } catch {
      return invalidHybridModelOutput();
    }
  };
  const primitiveEnd = (start: number): number => {
    let index = start;
    while (
      index < value.length
      && !whitespace(value[index])
      && value[index] !== ","
      && value[index] !== "]"
      && value[index] !== "}"
    ) index += 1;
    if (index === start) return invalidHybridModelOutput();
    try {
      const primitive = JSON.parse(value.slice(start, index)) as unknown;
      if (
        primitive !== null
        && typeof primitive !== "boolean"
        && (typeof primitive !== "number" || !Number.isFinite(primitive))
      ) return invalidHybridModelOutput();
    } catch {
      return invalidHybridModelOutput();
    }
    return index;
  };
  const parseValue = (start: number, depth: number): number => {
    if (depth > HYBRID_MODEL_JSON_MAX_DEPTH) return invalidHybridModelOutput();
    let index = skipWhitespace(start);
    if (value[index] === '"') return stringEnd(index);
    if (value[index] === "{") {
      index = skipWhitespace(index + 1);
      const keys = new Set<string>();
      if (value[index] === "}") return index + 1;
      for (;;) {
        const keyStart = index;
        const keyEnd = stringEnd(keyStart);
        const key = decodedKey(keyStart, keyEnd);
        if (keys.has(key)) return invalidHybridModelOutput();
        keys.add(key);
        index = skipWhitespace(keyEnd);
        if (value[index] !== ":") return invalidHybridModelOutput();
        index = skipWhitespace(parseValue(index + 1, depth + 1));
        if (value[index] === "}") return index + 1;
        if (value[index] !== ",") return invalidHybridModelOutput();
        index = skipWhitespace(index + 1);
      }
    }
    if (value[index] === "[") {
      index = skipWhitespace(index + 1);
      if (value[index] === "]") return index + 1;
      for (;;) {
        index = skipWhitespace(parseValue(index, depth + 1));
        if (value[index] === "]") return index + 1;
        if (value[index] !== ",") return invalidHybridModelOutput();
        index = skipWhitespace(index + 1);
      }
    }
    return primitiveEnd(index);
  };

  const end = skipWhitespace(parseValue(0, 0));
  if (end !== value.length) return invalidHybridModelOutput();
}

export function parseHybridModelJsonOutput(result: ModelGenerationResult): unknown {
  if (
    typeof result.output !== "string"
    || Buffer.byteLength(result.output, "utf8") > HYBRID_MODEL_JSON_MAX_BYTES
  ) return invalidHybridModelOutput();
  try {
    assertStrictHybridJson(result.output);
    return JSON.parse(result.output) as unknown;
  } catch {
    return invalidHybridModelOutput();
  }
}

async function loadNodeSourceBinding(
  database: EventDatabase,
  job: BridgeModelJobRow,
  workerId: string,
): Promise<AuthorizedNodeSource | null> {
  const rows = await database.query<AuthorizedNodeSource>(
    `select account.id::text as "accountId",
            conversation.id::text as "conversationId",
            node.id::text as "nodeBrainId",
            source.id::text as "sourceEventId",
            source.correlation_id::text as "correlationId"
       from bridge_model_jobs job
       join messages message
         on message.event_id=job.source_event_id
        and message.role='USER' and message.status='COMPLETED'
        and message.completed_at is not null
       join conversations conversation
         on conversation.id=message.conversation_id
        and conversation.account_id=message.account_id
       join accounts account
         on account.id=conversation.account_id
       join node_brains node
         on node.id=conversation.node_brain_id
        and node.account_id=account.id
       join events source
         on source.id=message.event_id
        and source.aggregate_id=conversation.id::text
        and source.account_id=account.id::text
        and source.actor_type='USER' and source.actor_id=account.id::text
        and source.type='participant.message.created'
        and source.visibility='PRIVATE_ACCOUNT'
      where job.job_id=$1 and job.source_event_id=$2
        and job.role='NODE' and job.kind='NODE_REPLY' and job.priority=0
        and job.request_digest=bridge_model_job_request_digest(
          job.source_event_id,job.role,job.kind
        )
        and job.status='CLAIMED' and job.lease_owner=$3
        and job.attempt_count=$4 and job.lease_expires_at>clock_timestamp()`,
    [job.jobId, job.sourceEventId, workerId, job.attemptCount],
  );
  return rows.length === 1 ? rows[0] : null;
}

async function lockSourceBody(
  database: EventDatabase,
  sourceEventId: string,
): Promise<string> {
  const keys = await database.query<SourceKeyRow>(
    `/* hybrid-source-key-lock */
     select data_key.id::text as "dataKeyId"
       from events source
       join encrypted_event_bodies body
         on body.event_id=source.id
        and body.aggregate_id=source.aggregate_id
        and body.data_key_id is not null
       join aggregate_data_keys data_key
         on data_key.id=body.data_key_id
        and data_key.aggregate_id=source.aggregate_id
      where source.id=$1
      order by data_key.id
      for share of data_key`,
    [sourceEventId],
  );
  if (keys.length !== 1) throw new Error("HYBRID_SOURCE_AUTHORITY_REVOKED");
  const bodies = await database.query(
    `/* hybrid-source-body-lock */
     select body.event_id
       from encrypted_event_bodies body
      where body.event_id=$1 and body.data_key_id=$2
      for share of body`,
    [sourceEventId, keys[0].dataKeyId],
  );
  if (bodies.length !== 1) throw new Error("HYBRID_SOURCE_AUTHORITY_REVOKED");
  return keys[0].dataKeyId;
}

async function hydrateNodeSource(
  database: EventDatabase,
  job: BridgeModelJobRow,
  workerId: string,
  routingEventId: string,
): Promise<HydratedNodeSource | null> {
  return database.transaction(async (transaction) => {
    const rows = await transaction.query<AuthorizedNodeSource>(
      `/* hybrid-node-hydration-authority */
       select account.id::text as "accountId",
              conversation.id::text as "conversationId",
              node.id::text as "nodeBrainId",
              source.id::text as "sourceEventId",
              source.correlation_id::text as "correlationId"
         from bridge_model_jobs job
         join messages message
           on message.event_id=job.source_event_id
          and message.role='USER' and message.status='COMPLETED'
          and message.completed_at is not null
         join conversations conversation
           on conversation.id=message.conversation_id
          and conversation.account_id=message.account_id
          and conversation.status='OPEN'
         join accounts account
           on account.id=conversation.account_id and account.status='ACTIVE'
         join entitlements entitlement
           on entitlement.account_id=account.id
          and entitlement.revoked_at is null
          and entitlement.active_from<=clock_timestamp()
          and (entitlement.expires_at is null
               or entitlement.expires_at>clock_timestamp())
         join node_brains node
           on node.id=conversation.node_brain_id
          and node.account_id=account.id and node.status='ACTIVE'
         join events source
           on source.id=message.event_id
          and source.aggregate_id=conversation.id::text
          and source.account_id=account.id::text
          and source.actor_type='USER' and source.actor_id=account.id::text
          and source.type='participant.message.created'
          and source.visibility='PRIVATE_ACCOUNT'
         join transactional_outbox outbox
           on outbox.event_id=source.id
          and outbox.topic='participant.message.created'
          and outbox.payload=jsonb_build_object('eventId',source.id::text)
         join events route
           on route.id=$5
          and route.aggregate_id=conversation.id::text
          and route.account_id=account.id::text
          and route.actor_type='NODE_BRAIN' and route.actor_id=node.id::text
          and route.type='node.reply.routed'
          and route.visibility='PRIVATE_ACCOUNT'
          and route.causation_id=source.id
          and route.correlation_id=source.correlation_id
        where job.job_id=$1 and job.source_event_id=$2
          and job.role='NODE' and job.kind='NODE_REPLY' and job.priority=0
          and job.request_digest=bridge_model_job_request_digest(
            job.source_event_id,job.role,job.kind
          )
          and job.status='CLAIMED' and job.lease_owner=$3
          and job.attempt_count=$4 and job.lease_expires_at>clock_timestamp()
      for update of job
      for share of account,entitlement,node,conversation,message,source,outbox,route`,
      [job.jobId, job.sourceEventId, workerId, job.attemptCount, routingEventId],
    );
    if (rows.length !== 1) return null;
    const source = rows[0];
    const dataKeyId = await lockSourceBody(transaction, source.sourceEventId);
    const exact = await transaction.query(
      `/* hybrid-node-hydration-revalidate */
       select 1
         from bridge_model_jobs job
         join messages message
           on message.event_id=job.source_event_id
          and message.role='USER' and message.status='COMPLETED'
          and message.completed_at is not null
         join conversations conversation
           on conversation.id=message.conversation_id
          and conversation.account_id=message.account_id
          and conversation.status='OPEN'
         join accounts account
           on account.id=conversation.account_id and account.status='ACTIVE'
         join entitlements entitlement
           on entitlement.account_id=account.id
          and entitlement.revoked_at is null
          and entitlement.active_from<=clock_timestamp()
          and (entitlement.expires_at is null
               or entitlement.expires_at>clock_timestamp())
         join node_brains node
           on node.id=conversation.node_brain_id
          and node.account_id=account.id and node.status='ACTIVE'
         join events source_event
           on source_event.id=message.event_id
          and source_event.aggregate_id=conversation.id::text
          and source_event.account_id=account.id::text
          and source_event.actor_type='USER'
          and source_event.actor_id=account.id::text
          and source_event.type='participant.message.created'
          and source_event.visibility='PRIVATE_ACCOUNT'
         join encrypted_event_bodies body
           on body.event_id=source_event.id
          and body.aggregate_id=source_event.aggregate_id
          and body.data_key_id=$6
         join aggregate_data_keys data_key
           on data_key.id=$6 and data_key.id=body.data_key_id
          and data_key.aggregate_id=conversation.id::text
         join transactional_outbox outbox
           on outbox.event_id=source_event.id
          and outbox.topic='participant.message.created'
          and outbox.payload=jsonb_build_object('eventId',source_event.id::text)
         join events route
           on route.id=$5
          and route.aggregate_id=conversation.id::text
          and route.account_id=account.id::text
          and route.actor_type='NODE_BRAIN' and route.actor_id=node.id::text
          and route.type='node.reply.routed'
          and route.visibility='PRIVATE_ACCOUNT'
          and route.causation_id=source_event.id
          and route.correlation_id=source_event.correlation_id
        where job.job_id=$1 and job.source_event_id=$2
          and job.role='NODE' and job.kind='NODE_REPLY' and job.priority=0
          and job.request_digest=bridge_model_job_request_digest(
            job.source_event_id,job.role,job.kind
          )
          and job.status='CLAIMED' and job.lease_owner=$3
          and job.attempt_count=$4 and job.lease_expires_at>clock_timestamp()
          and account.id=$7 and conversation.id=$8 and node.id=$9
          and source_event.id=$2 and source_event.correlation_id=$10`,
      [
        job.jobId,
        source.sourceEventId,
        workerId,
        job.attemptCount,
        routingEventId,
        dataKeyId,
        source.accountId,
        source.conversationId,
        source.nodeBrainId,
        source.correlationId,
      ],
    );
    if (exact.length !== 1) return null;
    const prompt = nodeText(await readEventBody(transaction, source.sourceEventId, {
      actor: { role: "ACCOUNT", accountId: source.accountId },
    }));
    return Object.freeze({ ...source, prompt });
  });
}

function nodeText(body: JsonValue): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("HYBRID_SOURCE_BODY_INVALID");
  }
  const completion = body.completion;
  if (
    body.role !== "USER"
    || typeof body.text !== "string"
    || body.text.trim().length === 0
    || !completion
    || typeof completion !== "object"
    || Array.isArray(completion)
    || completion.status !== "COMPLETED"
  ) {
    throw new Error("HYBRID_SOURCE_BODY_INVALID");
  }
  return body.text;
}

function generatedText(result: ModelGenerationResult): string {
  const text = result.output;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 100_000) {
    throw new Error("HYBRID_NODE_OUTPUT_INVALID");
  }
  return text;
}

async function existingNodeOutput(
  database: EventDatabase,
  job: BridgeModelJobRow,
  source: AuthorizedNodeSource,
): Promise<string | null> {
  const idempotencyKey = `message:${source.conversationId}:bridge-node:${job.jobId}`;
  const bindings = await database.query<{
    readonly status: string;
    readonly outputEventId: string | null;
  }>(
    `select status,output_event_id::text as "outputEventId"
       from bridge_model_jobs
      where job_id=$1 and source_event_id=$2
        and role='NODE' and kind='NODE_REPLY' and priority=0
        and request_digest=bridge_model_job_request_digest(source_event_id,role,kind)`,
    [job.jobId, job.sourceEventId],
  );
  if (bindings.length !== 1) throw new Error("HYBRID_OUTPUT_AUTHORITY_INVALID");
  const binding = bindings[0];
  if (binding.status === "COMPLETED" && binding.outputEventId !== null) {
    const rows = await database.query<{ readonly eventId: string }>(
      `select output.id::text as "eventId"
         from bridge_model_jobs bound_job
         join events output on output.id=bound_job.output_event_id
         join encrypted_event_bodies output_body
           on output_body.event_id=output.id and output_body.data_key_id is not null
         join messages message
           on message.event_id=output.id
          and message.conversation_id=$3 and message.account_id=$4
          and message.role='NODE' and message.status='COMPLETED'
         join events route
           on route.id=output.causation_id
          and route.causation_id=$2
          and route.correlation_id=$5
          and route.aggregate_id=$3::text and route.account_id=$4::text
          and route.actor_type='NODE_BRAIN' and route.actor_id=$6::text
          and route.type='node.reply.routed' and route.visibility='PRIVATE_ACCOUNT'
        where bound_job.job_id=$1 and bound_job.source_event_id=$2
          and bound_job.status='COMPLETED'
          and output.id=$7
          and output.aggregate_id=$3::text and output.account_id=$4::text
          and output.actor_type='NODE_BRAIN' and output.actor_id=$6::text
          and output.type='brain.response.completed'
          and output.visibility='PRIVATE_ACCOUNT'
          and output.correlation_id=$5`,
      [
        job.jobId,
        source.sourceEventId,
        source.conversationId,
        source.accountId,
        source.correlationId,
        source.nodeBrainId,
        binding.outputEventId,
      ],
    );
    if (rows.length !== 1) throw new Error("HYBRID_OUTPUT_AUTHORITY_INVALID");
    return rows[0].eventId;
  }
  if (binding.status !== "CLAIMED" || binding.outputEventId !== null) {
    throw new Error("HYBRID_OUTPUT_AUTHORITY_INVALID");
  }
  const conflicting = await database.query(
    "select 1 from events where idempotency_key=$1 limit 1",
    [idempotencyKey],
  );
  if (conflicting.length > 0) throw new Error("HYBRID_OUTPUT_AUTHORITY_INVALID");
  return null;
}

function failureCode(phase: RuntimePhase, error: unknown): BridgeCallerFailureCode {
  const message = error instanceof Error ? error.message : "";
  if (phase === "SOURCE") return "SOURCE_AUTHORITY_REVOKED";
  if (phase === "ROUTING" && message === "NODE_ROUTE_SOURCE_FORBIDDEN") {
    return "SOURCE_AUTHORITY_REVOKED";
  }
  if (phase === "ROUTING") return "ROUTING_AUTHORITY_REVOKED";
  if (phase === "OUTPUT") return "OUTPUT_AUTHORITY_INVALID";
  if (/MODEL_UNAVAILABLE|UPSTREAM_UNAVAILABLE/iu.test(message)) {
    return "CODEX_MODEL_UNAVAILABLE";
  }
  if (/AUTH|AUTHENTICATION/iu.test(message)) return "CODEX_AUTH_UNAVAILABLE";
  if (/QUOTA|RATE_LIMIT/iu.test(message)) return "CODEX_DAILY_QUOTA_EXHAUSTED";
  if (/TIMEOUT|ABORT/iu.test(message)) return "CODEX_TIMEOUT";
  if (/OUTPUT|MALFORMED|INVALID/iu.test(message)) return "CODEX_OUTPUT_INVALID";
  return "CODEX_PROCESS_FAILED";
}

async function failClaim(
  options: RunOneHybridJobOptions,
  job: BridgeModelJobRow,
  code: BridgeCallerFailureCode,
): Promise<HybridJobRunResult> {
  return safeResult(await failBridgeJob(options.db, {
    jobId: job.jobId,
    workerId: options.workerId,
    attemptCount: job.attemptCount,
    safeCode: code,
  }));
}

async function runNodeBridgeJob(
  options: RunOneHybridJobOptions,
  job: BridgeModelJobRow,
): Promise<HybridJobRunResult> {
  if (job.role !== "NODE" || job.kind !== "NODE_REPLY") {
    throw new Error("HYBRID_JOB_ROLE_UNSUPPORTED");
  }

  let phase: RuntimePhase = "SOURCE";
  try {
    const binding = await loadNodeSourceBinding(options.db, job, options.workerId);
    if (!binding) return failClaim(options, job, "SOURCE_AUTHORITY_REVOKED");

    phase = "OUTPUT";
    const replayOutputEventId = await existingNodeOutput(options.db, job, binding);
    if (replayOutputEventId) {
      return completedResult(job.jobId, replayOutputEventId);
    }

    phase = "ROUTING";
    const routed = await routeNodeReply({
      db: options.db,
      accountId: binding.accountId,
      conversationId: binding.conversationId,
      nodeBrainId: binding.nodeBrainId,
      userMessageEventId: binding.sourceEventId,
      coveredByMain: false,
      contradiction: false,
      materialEvidence: false,
      confidence: 1,
      mainStateVersion: NODE_MAIN_STATE_VERSION,
      sourceIds: [binding.sourceEventId],
      policyVersion: NODE_ROUTING_POLICY_VERSION,
    }, async () => undefined);

    phase = "SOURCE";
    const source = await hydrateNodeSource(
      options.db,
      job,
      options.workerId,
      routed.routingEventId,
    );
    if (!source) return failClaim(options, job, "SOURCE_AUTHORITY_REVOKED");

    phase = "MODEL";
    const text = generatedText(await options.generate({
      role: "NODE",
      promptVersion: NODE_PROMPT_VERSION,
      policyVersion: NODE_ROUTING_POLICY_VERSION,
      input: source.prompt,
      correlationId: source.correlationId,
      causationId: source.sourceEventId,
    }));

    phase = "OUTPUT";
    const context: ConversationHistoryContext = {
      db: options.db,
      accountId: source.accountId,
      conversationId: source.conversationId,
    };
    const output = await appendMessage(context, {
      idempotencyKey: `bridge-node:${job.jobId}`,
      role: "NODE",
      text,
      routingEventId: routed.routingEventId,
      bridgeAuthority: {
        jobId: job.jobId,
        sourceEventId: source.sourceEventId,
        workerId: options.workerId,
        attemptCount: job.attemptCount,
      },
    });

    return completedResult(job.jobId, output.eventId);
  } catch (error) {
    return failClaim(options, job, failureCode(phase, error));
  }
}

async function runMainBridgeJob(
  options: RunOneHybridJobOptions,
  job: BridgeModelJobRow,
): Promise<HybridJobRunResult> {
  if (job.role !== "MAIN" || job.kind !== "MAIN_GENERATION" || !job.cycleId) {
    throw new Error("HYBRID_JOB_ROLE_UNSUPPORTED");
  }
  let phase: RuntimePhase = "SOURCE";
  let staged: Awaited<ReturnType<typeof stageMainCandidateAndEvaluator>> | undefined;
  try {
    const result = await executeMainBridgeJob({
      jobId: job.jobId,
      loadAuthority: async () => {
        phase = "SOURCE";
        return loadMainAuthority(options.db, job, options.workerId);
      },
      generate: async (authority) => {
        phase = "MODEL";
        if (!authority.sourceEventId || !authority.correlationId || !authority.policyVersion) {
          throw new Error("MAIN_AUTHORITY_REVOKED");
        }
        return parseHybridModelJsonOutput(await options.generate({
          role: "MAIN",
          promptVersion: MAIN_PROMPT_VERSION,
          policyVersion: authority.policyVersion,
          input: authority.prompt,
          correlationId: authority.correlationId,
          causationId: authority.sourceEventId,
        }));
      },
      appendCandidate: async ({ cycleId, candidate }) => {
        phase = "OUTPUT";
        staged = await stageMainCandidateAndEvaluator(options.db, {
          jobId: job.jobId,
          workerId: options.workerId,
          attemptCount: job.attemptCount,
          cycleId,
          candidate,
        });
        return { candidateEventId: staged.candidateEventId };
      },
      stageEvaluator: async ({ cycleId, candidateEventId }) => {
        if (
          !staged
          || staged.candidateEventId !== candidateEventId
          || cycleId !== job.cycleId
        ) throw new Error("OUTPUT_AUTHORITY_INVALID");
        return { jobId: staged.evaluatorJobId };
      },
    });
    return completedRoleResult("MAIN", job.jobId, result.candidateEventId);
  } catch (error) {
    return failClaim(options, job, failureCode(phase, error));
  }
}

async function runEvaluatorBridgeJob(
  options: RunOneHybridJobOptions,
  job: BridgeModelJobRow,
): Promise<HybridJobRunResult> {
  if (
    job.role !== "EVALUATOR"
    || job.kind !== "EVALUATOR_REVIEW"
    || !job.cycleId
    || !job.candidateEventId
    || !job.parentMainJobId
  ) throw new Error("HYBRID_JOB_ROLE_UNSUPPORTED");
  let phase: RuntimePhase = "SOURCE";
  let accepted: Awaited<ReturnType<typeof commitAcceptedEvaluatorBridgeJob>> | undefined;
  try {
    const result = await executeEvaluatorBridgeJob({
      jobId: job.jobId,
      loadAuthority: async () => {
        phase = "SOURCE";
        return loadEvaluatorAuthority(options.db, job, options.workerId);
      },
      generate: async (authority) => {
        phase = "MODEL";
        if (!authority.sourceEventId || !authority.correlationId || !authority.policyVersion) {
          throw new Error("EVALUATOR_AUTHORITY_REVOKED");
        }
        return parseHybridModelJsonOutput(await options.generate({
          role: "EVALUATOR",
          promptVersion: EVALUATOR_PROMPT_VERSION,
          policyVersion: authority.policyVersion,
          input: authority.prompt,
          correlationId: authority.correlationId,
          causationId: authority.sourceEventId,
        }));
      },
      commitBroadcast: async (input) => {
        phase = "OUTPUT";
        accepted = await commitAcceptedEvaluatorBridgeJob(options.db, {
          jobId: job.jobId,
          workerId: options.workerId,
          attemptCount: job.attemptCount,
          cycleId: input.cycleId,
          candidateEventId: input.candidateEventId,
          decision: input.decision,
          rubricVersion: input.rubricVersion,
          rubricDigest: input.rubricDigest,
          rubricCriteria: input.rubricCriteria,
          rationaleCode: input.rationaleCode,
        });
        return { broadcastId: accepted.broadcastId };
      },
    });
    if (result.decision === "REJECT") {
      return failClaim(options, job, "EVALUATOR_REJECTED");
    }
    if (result.decision === "MALFORMED") {
      return failClaim(options, job, "CODEX_OUTPUT_INVALID");
    }
    if (!accepted) throw new Error("OUTPUT_AUTHORITY_INVALID");
    return completedRoleResult("EVALUATOR", job.jobId, accepted.reviewEventId);
  } catch (error) {
    return failClaim(options, job, failureCode(phase, error));
  }
}

type HybridRoleHandler = (
  options: RunOneHybridJobOptions,
  job: BridgeModelJobRow,
) => Promise<HybridJobRunResult>;

const HYBRID_ROLE_HANDLERS = Object.freeze({
  NODE: runNodeBridgeJob,
  EVALUATOR: runEvaluatorBridgeJob,
  MAIN: runMainBridgeJob,
} satisfies Readonly<Record<BridgeJobRole, HybridRoleHandler>>);

export async function runOneHybridJob(
  options: RunOneHybridJobOptions,
): Promise<HybridJobRunResult> {
  if (typeof options.generate !== "function") {
    throw new Error("HYBRID_RUNTIME_OPTIONS_INVALID");
  }
  const job = await claimNextBridgeJob(options.db, {
    workerId: options.workerId,
    now: new Date(),
  });
  if (!job) return Object.freeze({ status: "IDLE" });
  return HYBRID_ROLE_HANDLERS[job.role](options, job);
}

const HYBRID_STOP_TIMEOUT_MS = 25_000 as const;

export interface HybridContainerController {
  /** Proves Docker, the recorded image digest, and the dedicated auth volume. */
  verifyReady(signal: AbortSignal): Promise<void>;
  /** Reconciles only the T7 fixed-name, exact-label singleton authority. */
  reconcile(signal: AbortSignal): Promise<void>;
  /** Kills/waits/removes only an exact owned singleton, if one is active. */
  stop(signal: AbortSignal): Promise<void>;
  /** Proves no exact-label singleton remains after reconciliation or stop. */
  proveAbsent(signal: AbortSignal): Promise<boolean>;
}

export type HybridRuntimeWake =
  | { readonly jobId: string }
  | { readonly windowId: string };

export interface HybridRuntimeControllerOptions {
  readonly container: HybridContainerController;
  /** Recovers retained prior windows and prunes expired ones without provider work. */
  readonly recoverMarket: (signal: AbortSignal) => Promise<void>;
  /** Drains durable model authority; T7 remains the container singleton boundary. */
  readonly drainModel: (signal: AbortSignal) => Promise<void>;
  readonly pollMarket: (windowId: string, signal: AbortSignal) => Promise<void>;
  /** Closes follow-up work, database pools, and the outer server/tunnel seam. */
  readonly closeResources: (signal: AbortSignal) => Promise<void>;
  /** Stops new HTTP acceptance synchronously before asynchronous teardown begins. */
  readonly stopAccepting?: () => void;
  /** A failed check disables only explicit latest-to-observation materialization. */
  readonly verifyMarketMaterializer?: (signal: AbortSignal) => Promise<boolean>;
  readonly heartbeat?: (
    heartbeat: HybridRuntimeHeartbeat,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly stopTimeoutMs?: number;
}

export interface HybridRuntimeHeartbeat {
  readonly component: "CODEX" | "MARKET";
  readonly status: "HEALTHY" | "DEGRADED" | "OFFLINE";
  readonly safeCode: null | "DATABASE_UNAVAILABLE" | "PROVIDER_UNAVAILABLE" | "WORKER_OFFLINE";
}

export interface HybridRuntimeStatus {
  readonly accepting: boolean;
  readonly codexAvailable: boolean;
  readonly marketMaterializationAvailable: boolean;
  readonly modelActive: boolean;
  readonly marketActive: boolean;
}

export interface HybridRuntimeController {
  start(): Promise<void>;
  enqueue(wake: HybridRuntimeWake): void;
  wake(wake: HybridRuntimeWake): Promise<void>;
  wakeModelDrain(): Promise<void>;
  wakeMarketWindow(windowId: string): Promise<void>;
  stop(timeoutMs?: number): Promise<void>;
  status(): HybridRuntimeStatus;
}

type HybridControllerState = "NEW" | "STARTING" | "READY" | "STOPPING" | "STOPPED";

function runtimeConfiguration(
  options: HybridRuntimeControllerOptions,
): { readonly stopTimeoutMs: number } {
  if (!options || typeof options !== "object"
    || !options.container || typeof options.container.verifyReady !== "function"
    || typeof options.container.reconcile !== "function"
    || typeof options.container.stop !== "function"
    || typeof options.container.proveAbsent !== "function"
    || typeof options.recoverMarket !== "function"
    || typeof options.drainModel !== "function"
    || typeof options.pollMarket !== "function"
    || typeof options.closeResources !== "function"
    || options.stopAccepting !== undefined && typeof options.stopAccepting !== "function"
    || options.verifyMarketMaterializer !== undefined
      && typeof options.verifyMarketMaterializer !== "function"
    || options.heartbeat !== undefined && typeof options.heartbeat !== "function") {
    throw new Error("HYBRID_RUNTIME_OPTIONS_INVALID");
  }
  const stopTimeoutMs = options.stopTimeoutMs ?? HYBRID_STOP_TIMEOUT_MS;
  if (!Number.isSafeInteger(stopTimeoutMs)
    || stopTimeoutMs < 1
    || stopTimeoutMs > HYBRID_STOP_TIMEOUT_MS) {
    throw new Error("HYBRID_RUNTIME_OPTIONS_INVALID");
  }
  return Object.freeze({ stopTimeoutMs });
}

function exactRuntimeWake(value: HybridRuntimeWake): HybridRuntimeWake {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HYBRID_WAKE_INVALID");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) throw new Error("HYBRID_WAKE_INVALID");
  if (keys[0] === "jobId"
    && "jobId" in value
    && typeof value.jobId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value.jobId)) {
    return Object.freeze({ jobId: value.jobId });
  }
  if (keys[0] === "windowId"
    && "windowId" in value
    && typeof value.windowId === "string") {
    marketWindowStart(value.windowId);
    return Object.freeze({ windowId: value.windowId });
  }
  throw new Error("HYBRID_WAKE_INVALID");
}

function boundedTeardown<Result>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error("HYBRID_STOP_TIMEOUT")));
    }, timeoutMs);
    timer.unref?.();
    void work(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * One-shot controller used by the signed server and by deterministic tests.
 * It owns no interval: durable wakes and startup recovery are the schedulers.
 */
export function createHybridRuntimeController(
  options: HybridRuntimeControllerOptions,
): HybridRuntimeController {
  const configuration = runtimeConfiguration(options);
  let state: HybridControllerState = "NEW";
  let codexAvailable = false;
  let marketMaterializationAvailable = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let modelPromise: Promise<void> | undefined;
  let modelWakePending = false;
  let marketPromise: Promise<void> | undefined;
  let activeMarketWindow: string | undefined;
  let pendingMarketWindow: string | undefined;
  const workController = new AbortController();

  const requireReady = () => {
    if (state === "STOPPING" || state === "STOPPED") {
      throw new Error("HYBRID_RUNTIME_STOPPED");
    }
    if (state !== "READY") throw new Error("HYBRID_RUNTIME_NOT_READY");
  };

  const assertStarting = () => {
    if (state !== "STARTING" || workController.signal.aborted) {
      throw new Error("HYBRID_RUNTIME_START_ABORTED");
    }
  };

  const start = (): Promise<void> => {
    if (state === "READY") return Promise.resolve();
    if (startPromise) return startPromise;
    if (state !== "NEW") return Promise.reject(new Error("HYBRID_RUNTIME_STOPPED"));
    state = "STARTING";
    startPromise = (async () => {
      try {
        await options.container.reconcile(workController.signal);
        assertStarting();
        // T7's named-pipe lease must reject a competing host before any
        // readiness probe can touch Docker.
        await options.container.verifyReady(workController.signal);
        assertStarting();
        if (!await options.container.proveAbsent(workController.signal)) {
          throw new Error("CODEX_CONTAINER_RECONCILIATION_FAILED");
        }
        assertStarting();
        codexAvailable = true;
        await options.heartbeat?.(Object.freeze({
          component: "CODEX",
          status: "HEALTHY",
          safeCode: null,
        }), workController.signal);
        assertStarting();
        if (options.verifyMarketMaterializer) {
          try {
            marketMaterializationAvailable = await options.verifyMarketMaterializer(
              workController.signal,
            );
          } catch {
            marketMaterializationAvailable = false;
          }
          assertStarting();
        }
        // No current-window wake is accepted until bounded no-repoll recovery settles.
        await options.recoverMarket(workController.signal);
        assertStarting();
        // Durable jobs survive a lost wake. Drain them once before opening the
        // socket, then coalesced wakes own all later drains.
        await options.drainModel(workController.signal);
        assertStarting();
        await options.heartbeat?.(Object.freeze({
          component: "MARKET",
          status: marketMaterializationAvailable ? "HEALTHY" : "DEGRADED",
          safeCode: marketMaterializationAvailable ? null : "DATABASE_UNAVAILABLE",
        }), workController.signal);
        assertStarting();
        state = "READY";
      } catch {
        await options.heartbeat?.(Object.freeze({
          component: "CODEX",
          status: "OFFLINE",
          safeCode: "PROVIDER_UNAVAILABLE",
        }), workController.signal).catch(() => undefined);
        const failedState = state as HybridControllerState;
        if (failedState !== "STOPPING") state = "STOPPED";
        codexAvailable = false;
        marketMaterializationAvailable = false;
        workController.abort();
        throw new Error("HYBRID_RUNTIME_START_FAILED");
      }
    })();
    return startPromise;
  };

  const wakeModelDrain = (): Promise<void> => {
    try {
      requireReady();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!codexAvailable) return Promise.reject(new Error("CODEX_COMPONENT_OFFLINE"));
    if (modelPromise) {
      modelWakePending = true;
      return modelPromise;
    }
    modelPromise = (async () => {
      do {
        modelWakePending = false;
        await options.drainModel(workController.signal);
      } while (modelWakePending && !workController.signal.aborted);
    })().finally(() => {
      modelWakePending = false;
      modelPromise = undefined;
    });
    return modelPromise;
  };

  const wakeMarketWindow = (windowId: string): Promise<void> => {
    try {
      requireReady();
      marketWindowStart(windowId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (marketPromise) {
      if (windowId !== activeMarketWindow) pendingMarketWindow = windowId;
      return marketPromise;
    }
    activeMarketWindow = windowId;
    marketPromise = (async () => {
      while (activeMarketWindow && !workController.signal.aborted) {
        const currentWindow = activeMarketWindow;
        await options.pollMarket(currentWindow, workController.signal);
        activeMarketWindow = pendingMarketWindow;
        pendingMarketWindow = undefined;
      }
    })().finally(() => {
      activeMarketWindow = undefined;
      pendingMarketWindow = undefined;
      marketPromise = undefined;
    });
    return marketPromise;
  };

  const stop = (timeoutMs = configuration.stopTimeoutMs): Promise<void> => {
    if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > configuration.stopTimeoutMs) {
      return Promise.reject(new Error("HYBRID_STOP_TIMEOUT_INVALID"));
    }
    if (stopPromise) return stopPromise;
    if (state === "STOPPED" && !startPromise) {
      return Promise.reject(new Error(
        codexAvailable ? "HYBRID_RUNTIME_STOPPED" : "CODEX_CONTAINER_TERMINATION_UNPROVEN",
      ));
    }
    state = "STOPPING";
    try {
      options.stopAccepting?.();
    } catch {
      // Acceptance is also blocked by state; teardown must continue.
    }
    workController.abort();
    stopPromise = boundedTeardown(timeoutMs, async (stopSignal) => {
      // A startup stage must observe the abort and settle before the same
      // bounded authority reconciles container state under T7's lease.
      await Promise.allSettled([startPromise ?? Promise.resolve()]);
      if (options.heartbeat) {
        await Promise.allSettled([
          options.heartbeat(Object.freeze({
            component: "CODEX", status: "OFFLINE", safeCode: "WORKER_OFFLINE",
          }), stopSignal),
          options.heartbeat(Object.freeze({
            component: "MARKET", status: "OFFLINE", safeCode: "WORKER_OFFLINE",
          }), stopSignal),
        ]);
      }
      await Promise.allSettled([
        modelPromise ?? Promise.resolve(),
        marketPromise ?? Promise.resolve(),
      ]);
      await options.container.stop(stopSignal);
      await options.closeResources(stopSignal);
      if (!await options.container.proveAbsent(stopSignal)) {
        throw new Error("CODEX_CONTAINER_TERMINATION_UNPROVEN");
      }
    }).then(() => {
      codexAvailable = false;
      marketMaterializationAvailable = false;
      state = "STOPPED";
    }, () => {
      codexAvailable = false;
      marketMaterializationAvailable = false;
      state = "STOPPED";
      throw new Error("CODEX_CONTAINER_TERMINATION_UNPROVEN");
    });
    return stopPromise;
  };

  return Object.freeze({
    start,
    enqueue(wake: HybridRuntimeWake): void {
      requireReady();
      const exact = exactRuntimeWake(wake);
      const work = "jobId" in exact
        ? wakeModelDrain()
        : wakeMarketWindow(exact.windowId);
      void work.catch(() => {
        // Durable job/window authority remains pending or terminalized by its
        // worker path. HTTP acknowledgement is intentionally decoupled.
      });
    },
    wake(wake: HybridRuntimeWake): Promise<void> {
      const exact = exactRuntimeWake(wake);
      return "jobId" in exact
        ? wakeModelDrain()
        : wakeMarketWindow(exact.windowId);
    },
    wakeModelDrain,
    wakeMarketWindow,
    stop,
    status(): HybridRuntimeStatus {
      return Object.freeze({
        accepting: state === "READY",
        codexAvailable,
        marketMaterializationAvailable,
        modelActive: modelPromise !== undefined,
        marketActive: marketPromise !== undefined,
      });
    },
  });
}
