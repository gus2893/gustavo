import {
  claimNextBridgeJob,
  failBridgeJob,
  type BridgeCallerFailureCode,
  type BridgeModelJobRow,
} from "../../lib/server/bridge/jobs";
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
import {
  NODE_ROUTING_POLICY_VERSION,
  routeNodeReply,
} from "../../lib/server/node-brains/router";

const NODE_PROMPT_VERSION = "hybrid-node-v1" as const;
const NODE_MAIN_STATE_VERSION = "bridge-node-v1" as const;

export interface RunOneHybridJobOptions {
  readonly db: EventDatabase;
  readonly workerId: string;
  readonly generate: (
    request: ModelGenerationRequest,
  ) => Promise<ModelGenerationResult>;
}

export type HybridJobRunResult =
  | {
      readonly role: "NODE";
      readonly status: "COMPLETED";
      readonly jobId: string;
      readonly outputEventId: string;
      readonly safeCode: null;
    }
  | {
      readonly role: "NODE";
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

type RuntimePhase =
  | "SOURCE"
  | "ROUTING"
  | "MODEL"
  | "OUTPUT";

function safeResult(job: BridgeModelJobRow): HybridJobRunResult {
  if (job.role !== "NODE") throw new Error("HYBRID_JOB_ROLE_UNSUPPORTED");
  if (job.status === "COMPLETED" && job.outputEventId) {
    return Object.freeze({
      role: "NODE",
      status: "COMPLETED",
      jobId: job.jobId,
      outputEventId: job.outputEventId,
      safeCode: null,
    });
  }
  if (job.status === "FAILED" && job.safeCode) {
    return Object.freeze({
      role: "NODE",
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
