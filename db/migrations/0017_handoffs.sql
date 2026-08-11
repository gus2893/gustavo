create table handoff_packets (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  conversation_id uuid not null,
  scope text not null check (scope='NODE_BRANCH'),
  policy_version text not null check (policy_version='node-main-handoff-v1'),
  node_state_version text not null check (node_state_version ~ '^[1-9][0-9]*$'),
  main_state_version bigint not null references main_state_versions(version),
  packet_version bigint not null check (packet_version > 0),
  previous_packet_id uuid references handoff_packets(id),
  source_high_water_sequence bigint not null check (source_high_water_sequence > 0),
  through_event_id uuid not null references events(id),
  operation_key char(64) not null unique check (operation_key ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 240),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  packet_event_id uuid not null unique references encrypted_event_bodies(event_id),
  idea_count integer not null check (idea_count between 1 and 24),
  source_count integer not null check (source_count between 1 and 768),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique (account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,main_state_version,packet_version),
  unique (account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,main_state_version,source_high_water_sequence),
  check (previous_packet_id is null or previous_packet_id<>id)
);

create index handoff_packets_identity_current_idx on handoff_packets (
  account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,main_state_version,
  source_high_water_sequence desc,packet_version desc,id
);

create table handoff_packet_keys (
  idempotency_key text primary key check (length(trim(idempotency_key)) between 1 and 240),
  packet_id uuid not null references handoff_packets(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  source_high_water_sequence bigint not null check (source_high_water_sequence > 0),
  key_digest char(64) not null check (key_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create table handoff_packet_ideas (
  packet_id uuid not null references handoff_packets(id),
  ordinal integer not null check (ordinal between 0 and 23),
  proposal_id uuid not null references proposals(id),
  proposal_event_id uuid not null references events(id),
  proposal_status_event_id uuid not null references events(id),
  proposal_status_ordinal integer not null check (proposal_status_ordinal >= 0),
  disclosure_authorization_id uuid references proposal_disclosure_authorizations(id),
  disclosure_revocation_event_id uuid references events(id),
  source_event_ids uuid[] not null check (cardinality(source_event_ids) between 1 and 32),
  memory_ids uuid[] not null check (cardinality(memory_ids) between 1 and 60),
  memory_versions text[] not null check (cardinality(memory_versions)=cardinality(memory_ids)),
  content_digest char(64) not null check (content_digest ~ '^[a-f0-9]{64}$'),
  primary key (packet_id,ordinal),
  unique (packet_id,proposal_id),
  check ((disclosure_authorization_id is null)=(disclosure_revocation_event_id is null)
    or disclosure_authorization_id is not null)
);

create index handoff_packet_ideas_proposal_idx
  on handoff_packet_ideas (proposal_id,packet_id);

create table handoff_packet_manifests (
  packet_id uuid primary key references handoff_packets(id),
  packet_event_id uuid not null unique references events(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create table handoff_refresh_checkpoints (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  conversation_id uuid not null,
  scope text not null check (scope='NODE_BRANCH'),
  policy_version text not null check (policy_version='node-main-handoff-v1'),
  node_state_version text not null check (node_state_version ~ '^[1-9][0-9]*$'),
  main_state_version bigint not null references main_state_versions(version),
  checkpoint_version bigint not null check (checkpoint_version > 0),
  previous_checkpoint_id uuid references handoff_refresh_checkpoints(id),
  source_high_water_sequence bigint not null check (source_high_water_sequence > 0),
  through_event_id uuid not null references events(id),
  operation_key char(64) not null unique check (operation_key ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 240),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  checkpoint_event_id uuid not null unique references encrypted_event_bodies(event_id),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique (account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
    main_state_version,checkpoint_version),
  unique (account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
    main_state_version,source_high_water_sequence),
  check (previous_checkpoint_id is null or previous_checkpoint_id<>id)
);

create index handoff_refresh_checkpoints_identity_current_idx on handoff_refresh_checkpoints (
  account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,
  main_state_version,source_high_water_sequence desc,checkpoint_version desc,id
);

create table handoff_refresh_checkpoint_keys (
  idempotency_key text primary key check (length(trim(idempotency_key)) between 1 and 240),
  checkpoint_id uuid not null references handoff_refresh_checkpoints(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  source_high_water_sequence bigint not null check (source_high_water_sequence > 0),
  key_digest char(64) not null check (key_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create table handoff_refresh_checkpoint_manifests (
  checkpoint_id uuid primary key references handoff_refresh_checkpoints(id),
  checkpoint_event_id uuid not null unique references events(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create table handoff_key_registry (
  idempotency_key text primary key check (length(trim(idempotency_key)) between 1 and 240),
  target_kind text not null check (target_kind in ('PACKET','CHECKPOINT')),
  target_id uuid not null,
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  source_high_water_sequence bigint not null check (source_high_water_sequence > 0),
  key_digest char(64) not null check (key_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

alter table handoff_packet_keys add constraint handoff_packet_key_registry_fk
  foreign key (idempotency_key) references handoff_key_registry(idempotency_key);
alter table handoff_refresh_checkpoint_keys add constraint handoff_checkpoint_key_registry_fk
  foreign key (idempotency_key) references handoff_key_registry(idempotency_key);

create table handoff_refresh_jobs (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  conversation_id uuid not null,
  scope text not null check (scope='NODE_BRANCH'),
  policy_version text not null check (policy_version='node-main-handoff-v1'),
  node_state_version text not null check (node_state_version ~ '^[1-9][0-9]*$'),
  main_state_version bigint not null references main_state_versions(version),
  requested_high_water_sequence bigint not null check (requested_high_water_sequence > 0),
  through_event_id uuid not null references events(id),
  operation_key char(64) not null unique check (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  request_event_id uuid not null unique references encrypted_event_bodies(event_id),
  estimated_delta_count integer not null check (estimated_delta_count between 9 and 1000000),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique (account_id,node_brain_id,conversation_id,scope,policy_version,node_state_version,main_state_version,requested_high_water_sequence)
);

create table handoff_refresh_job_keys (
  idempotency_key text primary key check (length(trim(idempotency_key)) between 1 and 240),
  job_id uuid not null references handoff_refresh_jobs(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create table handoff_refresh_job_transitions (
  id uuid primary key,
  job_id uuid not null references handoff_refresh_jobs(id),
  ordinal integer not null check (ordinal >= 0),
  action text not null check (action in ('QUEUE','CLAIM','RETRY','COMPLETE','FAIL')),
  from_status text check (from_status in ('PENDING','CLAIMED','RETRY_SCHEDULED')),
  to_status text not null check (to_status in ('PENDING','CLAIMED','RETRY_SCHEDULED','COMPLETED','FAILED')),
  worker_id text check (worker_id is null or length(trim(worker_id)) between 1 and 200),
  lease_until timestamptz,
  retry_at timestamptz,
  packet_id uuid references handoff_packets(id),
  checkpoint_id uuid references handoff_refresh_checkpoints(id),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  transition_event_id uuid not null unique references encrypted_event_bodies(event_id),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 240),
  operation_digest char(64) not null check (operation_digest ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  unique (job_id,ordinal),
  check ((to_status='CLAIMED')=(worker_id is not null and lease_until is not null)),
  check (to_status<>'CLAIMED' or lease_until>created_at),
  check ((to_status='RETRY_SCHEDULED')=(retry_at is not null)),
  check ((to_status='COMPLETED')=((packet_id is not null)<>(checkpoint_id is not null))),
  check (to_status='COMPLETED' or (packet_id is null and checkpoint_id is null)),
  check ((to_status in ('RETRY_SCHEDULED','FAILED'))=(error_code is not null))
);

create table handoff_refresh_job_manifests (
  job_id uuid primary key references handoff_refresh_jobs(id),
  request_event_id uuid not null unique references events(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create table handoff_refresh_job_transition_manifests (
  transition_id uuid primary key references handoff_refresh_job_transitions(id),
  job_id uuid not null references handoff_refresh_jobs(id),
  transition_event_id uuid not null unique references events(id),
  operation_digest char(64) not null check (operation_digest ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create view handoff_refresh_job_current as
select job.*,transition.id transition_id,transition.ordinal,transition.to_status status,
       transition.worker_id,transition.lease_until,transition.retry_at,transition.packet_id,
       transition.checkpoint_id,
       transition.error_code,transition.created_at transitioned_at
from handoff_refresh_jobs job
join lateral (
  select item.* from handoff_refresh_job_transitions item
  where item.job_id=job.id order by item.ordinal desc limit 1
) transition on true;

create function handoff_packet_ideas_body(target_packet_id uuid)
returns jsonb language sql stable strict as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'ordinal',idea.ordinal,
    'proposalId',idea.proposal_id::text,
    'proposalEventId',idea.proposal_event_id::text,
    'proposalStatusEventId',idea.proposal_status_event_id::text,
    'proposalStatusOrdinal',idea.proposal_status_ordinal,
    'disclosureAuthorizationId',case when idea.disclosure_authorization_id is null
      then null else to_jsonb(idea.disclosure_authorization_id::text) end,
    'disclosureRevocationEventId',case when idea.disclosure_revocation_event_id is null
      then null else to_jsonb(idea.disclosure_revocation_event_id::text) end,
    'sourceEventIds',to_jsonb(idea.source_event_ids::text[]),
    'memoryIds',to_jsonb(idea.memory_ids::text[]),
    'memoryVersions',to_jsonb(idea.memory_versions),
    'contentDigest',idea.content_digest
  ) order by idea.ordinal),'[]'::jsonb)
  from handoff_packet_ideas idea where idea.packet_id=target_packet_id;
$$;

create function handoff_packet_event_body(target_packet_id uuid)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'packetId',packet.id::text,
    'accountId',packet.account_id::text,
    'nodeBrainId',packet.node_brain_id::text,
    'conversationId',packet.conversation_id::text,
    'scope',packet.scope,
    'policyVersion',packet.policy_version,
    'nodeStateVersion',packet.node_state_version,
    'mainStateVersion',packet.main_state_version::text,
    'packetVersion',packet.packet_version::text,
    'previousPacketId',case when packet.previous_packet_id is null
      then null else to_jsonb(packet.previous_packet_id::text) end,
    'highWaterSequence',packet.source_high_water_sequence::text,
    'throughEventId',packet.through_event_id::text,
    'operationKey',packet.operation_key,
    'requestDigest',packet.request_digest,
    'ideas',handoff_packet_ideas_body(packet.id),
    'createdAt',to_char(packet.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) from handoff_packets packet where packet.id=target_packet_id;
$$;

create function handoff_packet_key_digest(
  target_idempotency_key text,
  target_packet_id uuid
) returns text language sql stable strict as $$
  select recall_manifest_digest(jsonb_build_object(
    'idempotencyKey',target_idempotency_key,
    'packetId',packet.id::text,
    'accountId',packet.account_id::text,
    'nodeBrainId',packet.node_brain_id::text,
    'conversationId',packet.conversation_id::text,
    'scope',packet.scope,
    'policyVersion',packet.policy_version,
    'nodeStateVersion',packet.node_state_version,
    'mainStateVersion',packet.main_state_version::text,
    'highWaterSequence',packet.source_high_water_sequence::text,
    'operationKey',packet.operation_key,
    'requestDigest',packet.request_digest
  )) from handoff_packets packet where packet.id=target_packet_id;
$$;

create function handoff_refresh_checkpoint_event_body(target_checkpoint_id uuid)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'checkpointId',checkpoint.id::text,
    'accountId',checkpoint.account_id::text,
    'nodeBrainId',checkpoint.node_brain_id::text,
    'conversationId',checkpoint.conversation_id::text,
    'scope',checkpoint.scope,
    'policyVersion',checkpoint.policy_version,
    'nodeStateVersion',checkpoint.node_state_version,
    'mainStateVersion',checkpoint.main_state_version::text,
    'checkpointVersion',checkpoint.checkpoint_version::text,
    'previousCheckpointId',case when checkpoint.previous_checkpoint_id is null
      then null else to_jsonb(checkpoint.previous_checkpoint_id::text) end,
    'highWaterSequence',checkpoint.source_high_water_sequence::text,
    'throughEventId',checkpoint.through_event_id::text,
    'operationKey',checkpoint.operation_key,
    'requestDigest',checkpoint.request_digest,
    'result','EMPTY',
    'createdAt',to_char(checkpoint.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) from handoff_refresh_checkpoints checkpoint where checkpoint.id=target_checkpoint_id;
$$;

create function handoff_refresh_checkpoint_key_digest(
  target_idempotency_key text,
  target_checkpoint_id uuid
) returns text language sql stable strict as $$
  select recall_manifest_digest(jsonb_build_object(
    'idempotencyKey',target_idempotency_key,
    'checkpointId',checkpoint.id::text,
    'accountId',checkpoint.account_id::text,
    'nodeBrainId',checkpoint.node_brain_id::text,
    'conversationId',checkpoint.conversation_id::text,
    'scope',checkpoint.scope,
    'policyVersion',checkpoint.policy_version,
    'nodeStateVersion',checkpoint.node_state_version,
    'mainStateVersion',checkpoint.main_state_version::text,
    'highWaterSequence',checkpoint.source_high_water_sequence::text,
    'operationKey',checkpoint.operation_key,
    'requestDigest',checkpoint.request_digest
  )) from handoff_refresh_checkpoints checkpoint where checkpoint.id=target_checkpoint_id;
$$;

create function handoff_refresh_job_event_body(target_job_id uuid)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'jobId',job.id::text,'accountId',job.account_id::text,
    'nodeBrainId',job.node_brain_id::text,'conversationId',job.conversation_id::text,
    'scope',job.scope,'policyVersion',job.policy_version,
    'nodeStateVersion',job.node_state_version,
    'mainStateVersion',job.main_state_version::text,
    'requestedHighWaterSequence',job.requested_high_water_sequence::text,
    'throughEventId',job.through_event_id::text,'operationKey',job.operation_key,
    'requestDigest',job.request_digest,'estimatedDeltaCount',job.estimated_delta_count,
    'createdAt',to_char(job.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) from handoff_refresh_jobs job where job.id=target_job_id;
$$;

create function handoff_refresh_transition_body(target_transition_id uuid)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'transitionId',transition.id::text,'jobId',transition.job_id::text,
    'ordinal',transition.ordinal,'action',transition.action,
    'fromStatus',transition.from_status,'toStatus',transition.to_status,
    'workerId',transition.worker_id,
    'leaseUntil',case when transition.lease_until is null then null
      else to_jsonb(to_char(transition.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
    'retryAt',case when transition.retry_at is null then null
      else to_jsonb(to_char(transition.retry_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
    'packetId',case when transition.packet_id is null then null
      else to_jsonb(transition.packet_id::text) end,
    'checkpointId',case when transition.checkpoint_id is null then null
      else to_jsonb(transition.checkpoint_id::text) end,
    'errorCode',transition.error_code,
    'operationDigest',transition.operation_digest,
    'createdAt',to_char(transition.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) from handoff_refresh_job_transitions transition where transition.id=target_transition_id;
$$;

create function handoff_refresh_transition_operation_digest(target_transition_id uuid)
returns text language sql stable strict as $$
  select recall_manifest_digest(jsonb_build_object(
    'jobId',transition.job_id::text,'ordinal',transition.ordinal,
    'action',transition.action,'fromStatus',transition.from_status,
    'toStatus',transition.to_status,'workerId',transition.worker_id,
    'leaseUntil',case when transition.lease_until is null then null
      else to_jsonb(to_char(transition.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
    'retryAt',case when transition.retry_at is null then null
      else to_jsonb(to_char(transition.retry_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
    'packetId',case when transition.packet_id is null then null
      else to_jsonb(transition.packet_id::text) end,
    'checkpointId',case when transition.checkpoint_id is null then null
      else to_jsonb(transition.checkpoint_id::text) end,
    'errorCode',transition.error_code
  )) from handoff_refresh_job_transitions transition where transition.id=target_transition_id;
$$;

create function handoff_packet_validate() returns trigger language plpgsql as $$
declare previous handoff_packets; event_row events; body_row encrypted_event_bodies;
begin
  if new.policy_version<>'node-main-handoff-v1'
  then raise exception 'HANDOFF_POLICY_UNSUPPORTED'; end if;
  if new.created_at<clock_timestamp()-interval '1 minute'
    or new.created_at>clock_timestamp()+interval '1 second'
  then raise exception 'HANDOFF_PACKET_TIME_INVALID'; end if;
  if not exists (select 1 from events source where source.id=new.through_event_id
    and source.account_id=new.account_id::text
    and source.ingested_sequence=new.source_high_water_sequence)
  then raise exception 'HANDOFF_PACKET_HIGH_WATER_INVALID'; end if;
  if new.main_state_version is distinct from (select max(version) from main_state_versions)
    or new.node_state_version is distinct from (
      select routed.ingested_sequence::text from events routed
      where routed.aggregate_id=new.conversation_id::text
        and routed.account_id=new.account_id::text
        and routed.actor_type='NODE_BRAIN' and routed.actor_id=new.node_brain_id::text
        and routed.type='node.reply.routed' and routed.visibility='PRIVATE_ACCOUNT'
        and routed.ingested_sequence<=new.source_high_water_sequence
      order by routed.ingested_sequence desc,routed.id desc limit 1)
  then raise exception 'HANDOFF_STATE_STALE'; end if;
  if new.operation_key<>recall_manifest_digest(jsonb_build_object(
      'accountId',new.account_id::text,'conversationId',new.conversation_id::text,
      'highWaterSequence',new.source_high_water_sequence::text,'nodeBrainId',new.node_brain_id::text,
      'nodeStateVersion',new.node_state_version,'mainStateVersion',new.main_state_version::text,
      'policyVersion',new.policy_version,'scope',new.scope))
    or new.request_digest<>recall_manifest_digest(jsonb_build_object(
      'accountId',new.account_id::text,'conversationId',new.conversation_id::text,
      'nodeBrainId',new.node_brain_id::text,'nodeStateVersion',new.node_state_version,
      'mainStateVersion',new.main_state_version::text,
      'policyVersion',new.policy_version,'scope',new.scope,
      'throughEventId',new.through_event_id::text,
      'highWaterSequence',new.source_high_water_sequence::text))
    or exists (select 1 from handoff_refresh_checkpoints checkpoint
      where checkpoint.operation_key=new.operation_key)
  then raise exception 'HANDOFF_PACKET_OPERATION_INVALID'; end if;
  if new.previous_packet_id is null then
    if new.packet_version<>1 then raise exception 'HANDOFF_PACKET_VERSION_INVALID'; end if;
  else
    select * into previous from handoff_packets where id=new.previous_packet_id;
    if not found or previous.account_id<>new.account_id or previous.node_brain_id<>new.node_brain_id
      or previous.conversation_id<>new.conversation_id or previous.scope<>new.scope
      or previous.policy_version<>new.policy_version or previous.node_state_version<>new.node_state_version
      or previous.main_state_version<>new.main_state_version
      or previous.packet_version+1<>new.packet_version
      or previous.source_high_water_sequence>=new.source_high_water_sequence
    then raise exception 'HANDOFF_PACKET_PREVIOUS_INVALID'; end if;
  end if;
  if not exists (
    select 1 from accounts account
    join entitlements entitlement on entitlement.account_id=account.id
      and entitlement.revoked_at is null and entitlement.active_from<=new.created_at
      and (entitlement.expires_at is null or entitlement.expires_at>new.created_at)
    join node_brains node on node.id=new.node_brain_id and node.account_id=account.id
      and node.status='ACTIVE'
    join conversations conversation on conversation.id=new.conversation_id
      and conversation.account_id=account.id and conversation.node_brain_id=node.id
      and conversation.status='OPEN'
    where account.id=new.account_id and account.status='ACTIVE'
  ) then raise exception 'HANDOFF_PACKET_AUTHORITY_INVALID'; end if;
  select * into event_row from events where id=new.packet_event_id;
  select * into body_row from encrypted_event_bodies where event_id=new.packet_event_id;
  if event_row.id is null or body_row.data_key_id is null
    or event_row.aggregate_id<>'node-handoff:'||new.node_brain_id::text
    or event_row.account_id is distinct from new.account_id::text
    or event_row.actor_type<>'SYSTEM' or event_row.actor_id<>'handoff-refresher'
    or event_row.type<>'node.handoff.packet.refreshed'
    or event_row.visibility<>'PRIVATE_ACCOUNT' or event_row.policy_version<>new.policy_version
    or event_row.idempotency_key<>'node-handoff-packet:'||new.operation_key
    or event_row.causation_id<>new.through_event_id or event_row.correlation_id<>new.id
    or event_row.occurred_at<>new.created_at
    or body_row.body_digest<>new.body_digest
  then raise exception 'HANDOFF_PACKET_EVENT_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_packet_is_consistent before insert on handoff_packets
for each row execute function handoff_packet_validate();

create function handoff_key_registry_validate() returns trigger language plpgsql as $$
begin
  if new.target_kind='PACKET' then
    if not exists (
      select 1 from handoff_packets packet
      join handoff_packet_manifests manifest on manifest.packet_id=packet.id
      where packet.id=new.target_id and packet.operation_key=new.operation_key
        and packet.request_digest=new.request_digest
        and packet.source_high_water_sequence=new.source_high_water_sequence
        and packet.created_at=new.created_at and manifest.operation_key=packet.operation_key
        and new.key_digest=handoff_packet_key_digest(new.idempotency_key,packet.id)
    ) then raise exception 'HANDOFF_KEY_REGISTRY_INVALID'; end if;
  elsif new.target_kind='CHECKPOINT' then
    if not exists (
      select 1 from handoff_refresh_checkpoints checkpoint
      join handoff_refresh_checkpoint_manifests manifest
        on manifest.checkpoint_id=checkpoint.id
      where checkpoint.id=new.target_id and checkpoint.operation_key=new.operation_key
        and checkpoint.request_digest=new.request_digest
        and checkpoint.source_high_water_sequence=new.source_high_water_sequence
        and checkpoint.created_at=new.created_at
        and manifest.operation_key=checkpoint.operation_key
        and new.key_digest=handoff_refresh_checkpoint_key_digest(
          new.idempotency_key,checkpoint.id)
    ) then raise exception 'HANDOFF_KEY_REGISTRY_INVALID'; end if;
  else
    raise exception 'HANDOFF_KEY_REGISTRY_INVALID';
  end if;
  return new;
end;
$$;
create trigger handoff_key_registry_is_consistent before insert on handoff_key_registry
for each row execute function handoff_key_registry_validate();

create function bind_handoff_key_registry(
  target_idempotency_key text,
  target_kind_value text,
  target_id_value uuid,
  target_operation_key text,
  target_request_digest text,
  target_high_water_sequence bigint,
  target_key_digest text,
  target_created_at timestamptz
) returns void language plpgsql as $$
declare authority handoff_key_registry;
begin
  insert into handoff_key_registry (
    idempotency_key,target_kind,target_id,operation_key,request_digest,
    source_high_water_sequence,key_digest,created_at
  ) values (
    target_idempotency_key,target_kind_value,target_id_value,target_operation_key,
    target_request_digest,target_high_water_sequence,target_key_digest,target_created_at
  ) on conflict (idempotency_key) do nothing;
  select * into authority from handoff_key_registry
    where idempotency_key=target_idempotency_key for key share;
  if authority.idempotency_key is null
    or authority.target_kind<>target_kind_value
    or authority.target_id<>target_id_value
    or authority.operation_key<>target_operation_key
    or authority.request_digest<>target_request_digest
    or authority.source_high_water_sequence<>target_high_water_sequence
    or authority.key_digest<>target_key_digest
    or authority.created_at<>target_created_at
  then raise exception 'HANDOFF_KEY_REGISTRY_CONFLICT'; end if;
end;
$$;

create function handoff_packet_key_validate() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from handoff_packets packet
    join handoff_packet_manifests manifest on manifest.packet_id=packet.id
    where packet.id=new.packet_id
      and packet.operation_key=new.operation_key
      and packet.request_digest=new.request_digest
      and packet.source_high_water_sequence=new.source_high_water_sequence
      and packet.created_at=new.created_at
      and manifest.operation_key=packet.operation_key
      and new.key_digest=handoff_packet_key_digest(new.idempotency_key,packet.id)
  ) then raise exception 'HANDOFF_PACKET_KEY_INVALID'; end if;
  perform bind_handoff_key_registry(
    new.idempotency_key,'PACKET',new.packet_id,new.operation_key,new.request_digest,
    new.source_high_water_sequence,new.key_digest,new.created_at);
  return new;
end;
$$;
create trigger handoff_packet_key_is_consistent before insert on handoff_packet_keys
for each row execute function handoff_packet_key_validate();

create function handoff_packet_idea_validate() returns trigger language plpgsql as $$
declare packet handoff_packets; proposal proposals; status proposal_status_transitions;
begin
  select * into packet from handoff_packets where id=new.packet_id for update;
  if exists (select 1 from handoff_packet_manifests manifest where manifest.packet_id=new.packet_id)
  then raise exception 'HANDOFF_PACKET_IDEAS_SEALED'; end if;
  select * into proposal from proposals where id=new.proposal_id;
  select * into status from proposal_status_transitions where proposal_id=new.proposal_id
    order by ordinal desc limit 1;
  if exists (select 1 from events event
      where event.id in (new.proposal_event_id,new.proposal_status_event_id)
        and event.ingested_sequence>packet.source_high_water_sequence)
    or exists (select 1 from events raw_private_event
      where raw_private_event.id=proposal.raw_private_text_event_id
        and raw_private_event.ingested_sequence>packet.source_high_water_sequence)
    or exists (select 1 from unnest(new.source_event_ids) source_id
      join events source on source.id=source_id
      where source.ingested_sequence>packet.source_high_water_sequence)
    or exists (select 1 from unnest(new.memory_ids) memory_id
      join memory_records memory on memory.id=memory_id
      join events memory_event on memory_event.id=memory.body_event_id
      where memory_event.ingested_sequence>packet.source_high_water_sequence)
    or exists (select 1 from proposal_disclosure_authorizations disclosure
      join events created on created.id=disclosure.created_event_id
      where disclosure.id=new.disclosure_authorization_id
        and created.ingested_sequence>packet.source_high_water_sequence)
    or exists (select 1 from proposal_disclosure_revocations revocation
      join events revoked on revoked.id=revocation.revoked_event_id
      where revocation.authorization_id=new.disclosure_authorization_id
        and revoked.ingested_sequence>packet.source_high_water_sequence)
  then raise exception 'HANDOFF_PACKET_IDEA_HIGH_WATER_INVALID'; end if;
  if proposal.id is null or proposal.account_id<>packet.account_id
    or proposal.node_brain_id<>packet.node_brain_id or proposal.conversation_id<>packet.conversation_id
    or proposal.created_event_id<>new.proposal_event_id
    or not (proposal.affected_main_state_ids ? packet.main_state_version::text)
    or status.transition_event_id<>new.proposal_status_event_id
    or status.ordinal<>new.proposal_status_ordinal
    or status.to_status in ('WITHDRAWN','REJECTED')
    or new.source_event_ids<>array(
      select value::uuid from jsonb_array_elements_text(proposal.source_event_ids) value order by value::uuid)
    or exists (select 1 from unnest(new.source_event_ids) source_id
      join events source on source.id=source_id
      where source.account_id is distinct from packet.account_id::text
        or source.aggregate_id<>packet.conversation_id::text
        or source.ingested_sequence>packet.source_high_water_sequence)
    or exists (select 1 from unnest(new.memory_ids,new.memory_versions) item(memory_id,memory_version)
      left join memory_records memory on memory.id=item.memory_id
      left join events memory_event on memory_event.id=memory.body_event_id
      where memory.id is null or memory.scope<>'NODE_BRANCH'
        or memory.account_id<>packet.account_id or memory.node_brain_id<>packet.node_brain_id
        or memory.conversation_id<>packet.conversation_id
        or memory.valid_to is not null or memory.conflict_state='SUPERSEDED'
        or item.memory_version<>memory.body_event_id::text||':'||memory.conflict_state
        or memory_event.ingested_sequence>packet.source_high_water_sequence
        or not exists (select 1 from memory_sources source
          where source.memory_id=memory.id and source.source_event_id=any(new.source_event_ids))
        or exists (select 1 from memory_sources source
          where source.memory_id=memory.id and not source.source_event_id=any(new.source_event_ids)))
  then raise exception 'HANDOFF_PACKET_IDEA_INVALID'; end if;
  if proposal.privacy_scope='PROPOSAL_SUMMARY' then
    if new.disclosure_authorization_id is not null or new.disclosure_revocation_event_id is not null
    then raise exception 'HANDOFF_PACKET_DISCLOSURE_INVALID'; end if;
  else
    if new.disclosure_authorization_id is distinct from proposal.disclosure_authorization_id
      or not exists (select 1 from proposal_disclosure_authorizations disclosure
        left join proposal_disclosure_revocations revoked on revoked.authorization_id=disclosure.id
        where disclosure.id=new.disclosure_authorization_id
          and disclosure.account_id=packet.account_id
          and disclosure.conversation_id=packet.conversation_id
          and disclosure.expires_at>packet.created_at
          and revoked.authorization_id is null)
      or new.disclosure_revocation_event_id is not null
    then raise exception 'HANDOFF_PACKET_DISCLOSURE_INVALID'; end if;
  end if;
  return new;
end;
$$;
create trigger handoff_packet_idea_is_consistent before insert on handoff_packet_ideas
for each row execute function handoff_packet_idea_validate();

create function handoff_packet_manifest_validate() returns trigger language plpgsql as $$
begin
  perform 1 from handoff_packets packet where packet.id=new.packet_id for update;
  if not exists (
    select 1 from handoff_packets packet
    join events event on event.id=packet.packet_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
    where packet.id=new.packet_id and packet.packet_event_id=new.packet_event_id
      and packet.operation_key=new.operation_key and packet.body_digest=new.body_digest
      and body.body_digest=recall_manifest_digest(handoff_packet_event_body(packet.id))
      and body.body_digest=new.body_digest
      and event.request_hash=new.event_request_hash
      and event.integrity_hash=new.event_integrity_hash
      and packet.created_at=new.created_at
      and outbox.topic=event.type and outbox.payload=jsonb_build_object('eventId',event.id::text)
      and (select count(*) from handoff_packet_ideas idea where idea.packet_id=packet.id)=packet.idea_count
      and (select count(distinct source_id) from handoff_packet_ideas idea,
        unnest(idea.source_event_ids) source_id where idea.packet_id=packet.id)=packet.source_count
  ) then raise exception 'HANDOFF_PACKET_MANIFEST_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_packet_manifest_is_consistent before insert on handoff_packet_manifests
for each row execute function handoff_packet_manifest_validate();

create function handoff_refresh_has_eligible_proposal(
  target_account_id uuid,
  target_node_brain_id uuid,
  target_conversation_id uuid,
  target_main_state_version bigint,
  target_high_water_sequence bigint,
  authority_at timestamptz
) returns boolean language sql stable as $$
  select exists (
    select 1 from proposals proposal
    join events proposal_event on proposal_event.id=proposal.created_event_id
      and proposal_event.ingested_sequence<=target_high_water_sequence
    left join events raw_private_event on raw_private_event.id=proposal.raw_private_text_event_id
      and raw_private_event.ingested_sequence<=target_high_water_sequence
    join lateral (select transition.* from proposal_status_transitions transition
      join events transition_event on transition_event.id=transition.transition_event_id
      where transition.proposal_id=proposal.id
      order by transition.ordinal desc limit 1) status
      on status.to_status not in ('WITHDRAWN','REJECTED')
    join events status_event on status_event.id=status.transition_event_id
      and status_event.ingested_sequence<=target_high_water_sequence
    left join proposal_disclosure_authorizations disclosure
      on disclosure.id=proposal.disclosure_authorization_id
      and disclosure.expires_at>authority_at
    left join proposal_disclosure_revocations revoked
      on revoked.authorization_id=disclosure.id
    where proposal.account_id=target_account_id
      and proposal.node_brain_id=target_node_brain_id
      and proposal.conversation_id=target_conversation_id
      and proposal.affected_main_state_ids ? target_main_state_version::text
      and (proposal.privacy_scope<>'PROPOSAL_RAW_TEXT' or raw_private_event.id is not null)
      and ((proposal.privacy_scope='PROPOSAL_SUMMARY'
          and proposal.disclosure_authorization_id is null)
        or (proposal.privacy_scope='PROPOSAL_RAW_TEXT' and disclosure.id is not null
          and revoked.authorization_id is null))
      and exists (
        select 1 from memory_records memory
        join events memory_event on memory_event.id=memory.body_event_id
        where memory.scope='NODE_BRANCH' and memory.account_id=proposal.account_id
          and memory.node_brain_id=proposal.node_brain_id
          and memory.conversation_id=proposal.conversation_id
          and memory.valid_to is null and memory.conflict_state<>'SUPERSEDED'
          and memory_event.ingested_sequence<=target_high_water_sequence
          and exists (select 1 from memory_sources source where source.memory_id=memory.id)
          and not exists (select 1 from memory_sources source where source.memory_id=memory.id
            and not (proposal.source_event_ids ? source.source_event_id::text)))
  );
$$;

create function handoff_refresh_checkpoint_validate() returns trigger language plpgsql as $$
declare previous handoff_refresh_checkpoints; event_row events; body_row encrypted_event_bodies;
begin
  if new.policy_version<>'node-main-handoff-v1'
  then raise exception 'HANDOFF_POLICY_UNSUPPORTED'; end if;
  if new.created_at<clock_timestamp()-interval '1 minute'
    or new.created_at>clock_timestamp()+interval '1 second'
  then raise exception 'HANDOFF_CHECKPOINT_TIME_INVALID'; end if;
  if not exists (select 1 from events source where source.id=new.through_event_id
      and source.account_id=new.account_id::text
      and source.ingested_sequence=new.source_high_water_sequence)
  then raise exception 'HANDOFF_CHECKPOINT_HIGH_WATER_INVALID'; end if;
  if new.main_state_version is distinct from (select max(version) from main_state_versions)
    or new.node_state_version is distinct from (
      select routed.ingested_sequence::text from events routed
      where routed.aggregate_id=new.conversation_id::text
        and routed.account_id=new.account_id::text
        and routed.actor_type='NODE_BRAIN' and routed.actor_id=new.node_brain_id::text
        and routed.type='node.reply.routed' and routed.visibility='PRIVATE_ACCOUNT'
        and routed.ingested_sequence<=new.source_high_water_sequence
      order by routed.ingested_sequence desc,routed.id desc limit 1)
  then raise exception 'HANDOFF_STATE_STALE'; end if;
  if new.operation_key<>recall_manifest_digest(jsonb_build_object(
      'accountId',new.account_id::text,'conversationId',new.conversation_id::text,
      'highWaterSequence',new.source_high_water_sequence::text,'nodeBrainId',new.node_brain_id::text,
      'nodeStateVersion',new.node_state_version,'mainStateVersion',new.main_state_version::text,
      'policyVersion',new.policy_version,'scope',new.scope))
    or new.request_digest<>recall_manifest_digest(jsonb_build_object(
      'accountId',new.account_id::text,'conversationId',new.conversation_id::text,
      'nodeBrainId',new.node_brain_id::text,'nodeStateVersion',new.node_state_version,
      'mainStateVersion',new.main_state_version::text,
      'policyVersion',new.policy_version,'scope',new.scope,
      'throughEventId',new.through_event_id::text,
      'highWaterSequence',new.source_high_water_sequence::text))
    or exists (select 1 from handoff_packets packet where packet.operation_key=new.operation_key)
  then raise exception 'HANDOFF_CHECKPOINT_OPERATION_INVALID'; end if;
  select * into previous from handoff_refresh_checkpoints checkpoint
    where checkpoint.account_id=new.account_id and checkpoint.node_brain_id=new.node_brain_id
      and checkpoint.conversation_id=new.conversation_id and checkpoint.scope=new.scope
      and checkpoint.policy_version=new.policy_version
      and checkpoint.node_state_version=new.node_state_version
      and checkpoint.main_state_version=new.main_state_version
    order by checkpoint.source_high_water_sequence desc,checkpoint.checkpoint_version desc limit 1;
  if previous.id is null then
    if new.previous_checkpoint_id is not null or new.checkpoint_version<>1
    then raise exception 'HANDOFF_CHECKPOINT_VERSION_INVALID'; end if;
  elsif new.previous_checkpoint_id is distinct from previous.id
    or new.checkpoint_version<>previous.checkpoint_version+1
    or new.source_high_water_sequence<=previous.source_high_water_sequence
  then raise exception 'HANDOFF_CHECKPOINT_PREVIOUS_INVALID'; end if;
  if not exists (
    select 1 from accounts account
    join entitlements entitlement on entitlement.account_id=account.id
      and entitlement.revoked_at is null and entitlement.active_from<=new.created_at
      and (entitlement.expires_at is null or entitlement.expires_at>new.created_at)
    join node_brains node on node.id=new.node_brain_id and node.account_id=account.id
      and node.status='ACTIVE'
    join conversations conversation on conversation.id=new.conversation_id
      and conversation.account_id=account.id and conversation.node_brain_id=node.id
      and conversation.status='OPEN'
    where account.id=new.account_id and account.status='ACTIVE'
  ) then raise exception 'HANDOFF_CHECKPOINT_AUTHORITY_INVALID'; end if;
  if handoff_refresh_has_eligible_proposal(
    new.account_id,new.node_brain_id,new.conversation_id,new.main_state_version,
    new.source_high_water_sequence,new.created_at)
  then raise exception 'HANDOFF_CHECKPOINT_NOT_EMPTY'; end if;
  select * into event_row from events where id=new.checkpoint_event_id;
  select * into body_row from encrypted_event_bodies where event_id=new.checkpoint_event_id;
  if event_row.id is null or body_row.data_key_id is null
    or event_row.aggregate_id<>'node-handoff-checkpoint:'||new.node_brain_id::text
    or event_row.account_id is distinct from new.account_id::text
    or event_row.actor_type<>'SYSTEM' or event_row.actor_id<>'handoff-refresher'
    or event_row.type<>'node.handoff.checkpoint.advanced'
    or event_row.visibility<>'PRIVATE_ACCOUNT' or event_row.policy_version<>new.policy_version
    or event_row.idempotency_key<>'node-handoff-checkpoint:'||new.operation_key
    or event_row.causation_id<>new.through_event_id or event_row.correlation_id<>new.id
    or event_row.occurred_at<>new.created_at or body_row.body_digest<>new.body_digest
  then raise exception 'HANDOFF_CHECKPOINT_EVENT_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_refresh_checkpoint_is_consistent before insert on handoff_refresh_checkpoints
for each row execute function handoff_refresh_checkpoint_validate();

create function handoff_refresh_checkpoint_key_validate() returns trigger language plpgsql as $$
begin
  if not exists (
      select 1 from handoff_refresh_checkpoints checkpoint
      join handoff_refresh_checkpoint_manifests manifest
        on manifest.checkpoint_id=checkpoint.id
      where checkpoint.id=new.checkpoint_id
        and checkpoint.operation_key=new.operation_key
        and checkpoint.request_digest=new.request_digest
        and checkpoint.source_high_water_sequence=new.source_high_water_sequence
        and checkpoint.created_at=new.created_at
        and manifest.operation_key=checkpoint.operation_key
        and new.key_digest=handoff_refresh_checkpoint_key_digest(
          new.idempotency_key,checkpoint.id)
  )
  then raise exception 'HANDOFF_CHECKPOINT_KEY_INVALID'; end if;
  perform bind_handoff_key_registry(
    new.idempotency_key,'CHECKPOINT',new.checkpoint_id,new.operation_key,new.request_digest,
    new.source_high_water_sequence,new.key_digest,new.created_at);
  return new;
end;
$$;
create trigger handoff_refresh_checkpoint_key_is_consistent
before insert on handoff_refresh_checkpoint_keys
for each row execute function handoff_refresh_checkpoint_key_validate();

create function handoff_refresh_checkpoint_manifest_validate() returns trigger language plpgsql as $$
begin
  perform 1 from handoff_refresh_checkpoints checkpoint where checkpoint.id=new.checkpoint_id
    for update;
  if not exists (
    select 1 from handoff_refresh_checkpoints checkpoint
    join events event on event.id=checkpoint.checkpoint_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
    where checkpoint.id=new.checkpoint_id
      and checkpoint.checkpoint_event_id=new.checkpoint_event_id
      and checkpoint.operation_key=new.operation_key and checkpoint.body_digest=new.body_digest
      and body.body_digest=recall_manifest_digest(
        handoff_refresh_checkpoint_event_body(checkpoint.id))
      and body.body_digest=new.body_digest
      and event.request_hash=new.event_request_hash
      and event.integrity_hash=new.event_integrity_hash
      and checkpoint.created_at=new.created_at
      and outbox.topic=event.type
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
  ) then raise exception 'HANDOFF_CHECKPOINT_MANIFEST_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_refresh_checkpoint_manifest_is_consistent
before insert on handoff_refresh_checkpoint_manifests
for each row execute function handoff_refresh_checkpoint_manifest_validate();

create function handoff_refresh_job_validate() returns trigger language plpgsql as $$
declare source events; request events; body encrypted_event_bodies; authority_clock timestamptz;
begin
  authority_clock:=clock_timestamp();
  if new.policy_version<>'node-main-handoff-v1'
  then raise exception 'HANDOFF_POLICY_UNSUPPORTED'; end if;
  if new.created_at<authority_clock-interval '1 minute'
    or new.created_at>authority_clock+interval '1 second'
  then raise exception 'HANDOFF_REFRESH_JOB_TIME_INVALID'; end if;
  perform 1 from accounts account
    join entitlements entitlement on entitlement.account_id=account.id
      and entitlement.revoked_at is null and entitlement.active_from<=authority_clock
      and (entitlement.expires_at is null or entitlement.expires_at>authority_clock)
    join node_brains node on node.id=new.node_brain_id and node.account_id=account.id
      and node.status='ACTIVE'
    join conversations conversation on conversation.id=new.conversation_id
      and conversation.account_id=account.id and conversation.node_brain_id=node.id
      and conversation.status='OPEN'
    where account.id=new.account_id and account.status='ACTIVE'
    for share of account,entitlement,node,conversation;
  if not found then raise exception 'HANDOFF_REFRESH_JOB_AUTHORITY_INVALID'; end if;
  select * into source from events where id=new.through_event_id;
  if source.id is null or source.account_id is distinct from new.account_id::text
    or source.ingested_sequence<>new.requested_high_water_sequence
  then raise exception 'HANDOFF_REFRESH_JOB_HIGH_WATER_INVALID'; end if;
  if new.main_state_version is distinct from (select max(version) from main_state_versions)
    or new.node_state_version is distinct from (
      select routed.ingested_sequence::text from events routed
      where routed.aggregate_id=new.conversation_id::text
        and routed.account_id=new.account_id::text
        and routed.actor_type='NODE_BRAIN' and routed.actor_id=new.node_brain_id::text
        and routed.type='node.reply.routed' and routed.visibility='PRIVATE_ACCOUNT'
        and routed.ingested_sequence<=new.requested_high_water_sequence
      order by routed.ingested_sequence desc,routed.id desc limit 1)
  then raise exception 'HANDOFF_STATE_STALE'; end if;
  if new.operation_key<>recall_manifest_digest(jsonb_build_object(
      'accountId',new.account_id::text,'conversationId',new.conversation_id::text,
      'highWaterSequence',new.requested_high_water_sequence::text,
      'nodeBrainId',new.node_brain_id::text,'nodeStateVersion',new.node_state_version,
      'mainStateVersion',new.main_state_version::text,
      'policyVersion',new.policy_version,'scope',new.scope))
    or new.request_digest<>recall_manifest_digest(jsonb_build_object(
      'accountId',new.account_id::text,'conversationId',new.conversation_id::text,
      'estimatedDeltaCount',new.estimated_delta_count,
      'highWaterSequence',new.requested_high_water_sequence::text,
      'nodeBrainId',new.node_brain_id::text,'nodeStateVersion',new.node_state_version,
      'mainStateVersion',new.main_state_version::text,
      'policyVersion',new.policy_version,'scope',new.scope,
      'throughEventId',new.through_event_id::text))
  then raise exception 'HANDOFF_REFRESH_JOB_OPERATION_INVALID'; end if;
  select * into request from events where id=new.request_event_id;
  select * into body from encrypted_event_bodies where event_id=new.request_event_id;
  if request.id is null or body.data_key_id is null
    or request.aggregate_id<>'node-handoff-job:'||new.id::text
    or request.account_id is distinct from new.account_id::text
    or request.actor_type<>'SYSTEM' or request.actor_id<>'handoff-refresher'
    or request.type<>'node.handoff.refresh.queued' or request.visibility<>'PRIVATE_ACCOUNT'
    or request.policy_version<>new.policy_version
    or request.idempotency_key<>'node-handoff-job:'||new.operation_key
    or request.causation_id<>new.through_event_id or request.correlation_id<>new.id
    or request.occurred_at<>new.created_at or body.body_digest<>new.body_digest
  then raise exception 'HANDOFF_REFRESH_JOB_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_refresh_job_is_consistent before insert on handoff_refresh_jobs
for each row execute function handoff_refresh_job_validate();

create function handoff_refresh_job_key_validate() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from handoff_refresh_jobs job where job.id=new.job_id
    and job.operation_key=new.operation_key and job.request_digest=new.request_digest)
  then raise exception 'HANDOFF_REFRESH_JOB_KEY_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_refresh_job_key_is_consistent before insert on handoff_refresh_job_keys
for each row execute function handoff_refresh_job_key_validate();

create function handoff_refresh_job_manifest_validate() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from handoff_refresh_jobs job
    join events event on event.id=job.request_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
    where job.id=new.job_id and job.request_event_id=new.request_event_id
      and job.operation_key=new.operation_key and job.body_digest=new.body_digest
      and body.body_digest=recall_manifest_digest(handoff_refresh_job_event_body(job.id))
      and body.body_digest=new.body_digest and event.request_hash=new.event_request_hash
      and event.integrity_hash=new.event_integrity_hash and job.created_at=new.created_at
      and outbox.topic=event.type and outbox.payload=jsonb_build_object('eventId',event.id::text)
  ) then raise exception 'HANDOFF_REFRESH_JOB_MANIFEST_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_refresh_job_manifest_is_consistent before insert on handoff_refresh_job_manifests
for each row execute function handoff_refresh_job_manifest_validate();

create function handoff_refresh_transition_validate() returns trigger language plpgsql as $$
declare job handoff_refresh_jobs; prior handoff_refresh_job_transitions; event events;
  body encrypted_event_bodies; authority_clock timestamptz;
begin
  authority_clock:=clock_timestamp();
  select * into job from handoff_refresh_jobs where id=new.job_id;
  if new.created_at<authority_clock-interval '1 minute'
    or new.created_at>authority_clock+interval '1 second'
    or (new.to_status='CLAIMED' and new.lease_until<=authority_clock)
    or (new.to_status='RETRY_SCHEDULED' and new.retry_at<=authority_clock)
  then raise exception 'HANDOFF_REFRESH_TRANSITION_TIME_INVALID'; end if;
  if new.ordinal=0 then
    if new.action<>'QUEUE' or new.from_status is not null or new.to_status<>'PENDING'
    then raise exception 'HANDOFF_REFRESH_TRANSITION_INVALID'; end if;
  else
    select * into prior from handoff_refresh_job_transitions where job_id=new.job_id
      and ordinal=new.ordinal-1;
    if prior.id is null or new.from_status is distinct from prior.to_status
    then raise exception 'HANDOFF_REFRESH_TRANSITION_INVALID'; end if;
    if new.action='CLAIM' and prior.to_status='RETRY_SCHEDULED'
      and prior.retry_at>authority_clock
    then raise exception 'HANDOFF_REFRESH_RETRY_NOT_DUE'; end if;
    if new.action='CLAIM' and prior.to_status='CLAIMED'
      and prior.lease_until>authority_clock
    then raise exception 'HANDOFF_REFRESH_LEASE_ACTIVE'; end if;
    if new.action in ('RETRY','COMPLETE','FAIL') and prior.to_status='CLAIMED'
      and prior.lease_until<=authority_clock
    then raise exception 'HANDOFF_REFRESH_LEASE_EXPIRED'; end if;
    if not ((new.action='CLAIM' and new.to_status='CLAIMED'
          and (prior.to_status='PENDING'
            or (prior.to_status='RETRY_SCHEDULED' and prior.retry_at<=authority_clock)
            or (prior.to_status='CLAIMED' and prior.lease_until<=authority_clock)))
      or (new.action='RETRY' and prior.to_status='CLAIMED' and new.to_status='RETRY_SCHEDULED'
          and prior.worker_id=new.worker_id and prior.lease_until>authority_clock)
      or (new.action='COMPLETE' and prior.to_status='CLAIMED' and new.to_status='COMPLETED'
          and prior.worker_id=new.worker_id and prior.lease_until>authority_clock)
      or (new.action='FAIL' and prior.to_status='CLAIMED' and new.to_status='FAILED'
          and prior.worker_id=new.worker_id and prior.lease_until>authority_clock))
    then raise exception 'HANDOFF_REFRESH_TRANSITION_INVALID'; end if;
  end if;
  if new.action='COMPLETE' and new.checkpoint_id is not null then
    perform 1 from handoff_refresh_checkpoints checkpoint
    join encrypted_event_bodies checkpoint_body
      on checkpoint_body.event_id=checkpoint.checkpoint_event_id
      and checkpoint_body.data_key_id is not null
    join aggregate_data_keys checkpoint_key on checkpoint_key.id=checkpoint_body.data_key_id
    where checkpoint.id=new.checkpoint_id for share of checkpoint_key;
    if not found then raise exception 'HANDOFF_CHECKPOINT_UNAVAILABLE'; end if;
  end if;
  select * into event from events where id=new.transition_event_id;
  select * into body from encrypted_event_bodies where event_id=new.transition_event_id;
  if event.id is null or body.data_key_id is null
    or event.aggregate_id<>'node-handoff-job:'||new.job_id::text
    or event.account_id is distinct from job.account_id::text
    or event.actor_type<>'SYSTEM' or event.actor_id<>'handoff-refresher'
    or event.type<>(case new.action when 'QUEUE' then 'node.handoff.refresh.queued'
      when 'CLAIM' then 'node.handoff.refresh.claimed'
      when 'RETRY' then 'node.handoff.refresh.retry_scheduled'
      when 'COMPLETE' then 'node.handoff.refresh.completed' else 'node.handoff.refresh.failed' end)
    or event.visibility<>'PRIVATE_ACCOUNT' or event.policy_version<>job.policy_version
    or event.correlation_id<>job.id
    or event.idempotency_key<>(case when new.ordinal=0 then 'node-handoff-job:'||job.operation_key
      else 'node-handoff-transition:'||new.operation_digest end)
    or (new.ordinal=0 and event.causation_id<>job.through_event_id)
    or (new.ordinal>0 and event.causation_id<>prior.transition_event_id)
    or (new.action='COMPLETE' and not (
      (new.packet_id is not null and exists (
        select 1 from handoff_packets packet where packet.id=new.packet_id
          and packet.account_id=job.account_id and packet.node_brain_id=job.node_brain_id
          and packet.conversation_id=job.conversation_id and packet.scope=job.scope
          and packet.policy_version=job.policy_version
          and packet.node_state_version=job.node_state_version
          and packet.main_state_version=job.main_state_version
          and packet.source_high_water_sequence=job.requested_high_water_sequence))
      or (new.checkpoint_id is not null and exists (
        select 1 from handoff_refresh_checkpoints checkpoint
        join handoff_refresh_checkpoint_manifests manifest
          on manifest.checkpoint_id=checkpoint.id
        join encrypted_event_bodies checkpoint_body
          on checkpoint_body.event_id=checkpoint.checkpoint_event_id
          and checkpoint_body.data_key_id is not null
          and checkpoint_body.body_digest=checkpoint.body_digest
          and checkpoint_body.body_digest=recall_manifest_digest(
            handoff_refresh_checkpoint_event_body(checkpoint.id))
        where checkpoint.id=new.checkpoint_id
          and checkpoint.account_id=job.account_id
          and checkpoint.node_brain_id=job.node_brain_id
          and checkpoint.conversation_id=job.conversation_id and checkpoint.scope=job.scope
          and checkpoint.policy_version=job.policy_version
          and checkpoint.node_state_version=job.node_state_version
          and checkpoint.main_state_version=job.main_state_version
          and checkpoint.source_high_water_sequence=job.requested_high_water_sequence))))
    or event.occurred_at<>new.created_at or body.body_digest<>new.body_digest
    or (new.operation_digest<>
      recall_manifest_digest(jsonb_build_object(
        'jobId',new.job_id::text,'ordinal',new.ordinal,'action',new.action,
        'fromStatus',new.from_status,'toStatus',new.to_status,'workerId',new.worker_id,
        'leaseUntil',case when new.lease_until is null then null
          else to_jsonb(to_char(new.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
        'retryAt',case when new.retry_at is null then null
          else to_jsonb(to_char(new.retry_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
        'packetId',case when new.packet_id is null then null else to_jsonb(new.packet_id::text) end,
        'checkpointId',case when new.checkpoint_id is null then null
          else to_jsonb(new.checkpoint_id::text) end,
        'errorCode',new.error_code)))
  then raise exception 'HANDOFF_REFRESH_TRANSITION_EVENT_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_refresh_transition_is_consistent before insert on handoff_refresh_job_transitions
for each row execute function handoff_refresh_transition_validate();

create function handoff_refresh_transition_manifest_validate() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from handoff_refresh_job_transitions transition
    join events event on event.id=transition.transition_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
    where transition.id=new.transition_id and transition.job_id=new.job_id
      and transition.transition_event_id=new.transition_event_id
      and transition.operation_digest=new.operation_digest
      and body.body_digest=recall_manifest_digest(case when transition.ordinal=0
        then handoff_refresh_job_event_body(transition.job_id)
        else handoff_refresh_transition_body(transition.id) end)
      and body.body_digest=new.body_digest and event.request_hash=new.event_request_hash
      and event.integrity_hash=new.event_integrity_hash and transition.created_at=new.created_at
      and outbox.topic=event.type and outbox.payload=jsonb_build_object('eventId',event.id::text)
  ) then raise exception 'HANDOFF_REFRESH_TRANSITION_MANIFEST_INVALID'; end if;
  return new;
end;
$$;
create trigger handoff_refresh_transition_manifest_is_consistent
before insert on handoff_refresh_job_transition_manifests
for each row execute function handoff_refresh_transition_manifest_validate();

create function require_handoff_event_authority() returns trigger language plpgsql as $$
begin
  if new.type='node.handoff.packet.refreshed' then
    if not exists (select 1 from handoff_packets packet
      join handoff_packet_manifests manifest on manifest.packet_id=packet.id
      join handoff_packet_keys key on key.packet_id=packet.id
        and key.idempotency_key=packet.idempotency_key
      where packet.packet_event_id=new.id and manifest.packet_event_id=new.id)
    then raise exception 'INCOMPLETE_HANDOFF_EVENT'; end if;
  elsif new.type='node.handoff.checkpoint.advanced' then
    if not exists (select 1 from handoff_refresh_checkpoints checkpoint
      join handoff_refresh_checkpoint_manifests manifest
        on manifest.checkpoint_id=checkpoint.id
      join handoff_refresh_checkpoint_keys key on key.checkpoint_id=checkpoint.id
        and key.idempotency_key=checkpoint.idempotency_key
      where checkpoint.checkpoint_event_id=new.id and manifest.checkpoint_event_id=new.id)
    then raise exception 'INCOMPLETE_HANDOFF_EVENT'; end if;
  elsif new.type='node.handoff.refresh.queued' then
    if not exists (select 1 from handoff_refresh_jobs job
      join handoff_refresh_job_manifests manifest on manifest.job_id=job.id
      join handoff_refresh_job_transitions transition on transition.job_id=job.id
        and transition.ordinal=0 and transition.transition_event_id=new.id
      join handoff_refresh_job_transition_manifests transition_manifest
        on transition_manifest.transition_id=transition.id
      where job.request_event_id=new.id and manifest.request_event_id=new.id)
    then raise exception 'INCOMPLETE_HANDOFF_EVENT'; end if;
  else
    if not exists (select 1 from handoff_refresh_job_transitions transition
      join handoff_refresh_job_transition_manifests manifest
        on manifest.transition_id=transition.id
      where transition.transition_event_id=new.id)
    then raise exception 'INCOMPLETE_HANDOFF_EVENT'; end if;
  end if;
  return null;
end;
$$;
create constraint trigger handoff_event_requires_authority
after insert on events deferrable initially deferred
for each row when (new.type in (
  'node.handoff.packet.refreshed','node.handoff.checkpoint.advanced',
  'node.handoff.refresh.queued','node.handoff.refresh.claimed',
  'node.handoff.refresh.retry_scheduled','node.handoff.refresh.completed','node.handoff.refresh.failed'
)) execute function require_handoff_event_authority();

create function protect_handoff_outbox() returns trigger language plpgsql as $$
declare old_event_type text;
  new_event_type text;
  old_is_canonical boolean := false;
  new_is_canonical boolean := false;
  canonical_topics text[] := array[
    'node.handoff.packet.refreshed','node.handoff.checkpoint.advanced',
    'node.handoff.refresh.queued','node.handoff.refresh.claimed',
    'node.handoff.refresh.retry_scheduled','node.handoff.refresh.completed',
    'node.handoff.refresh.failed'
  ]::text[];
begin
  if tg_op in ('UPDATE','DELETE') then
    select event.type into old_event_type from events event where event.id=old.event_id;
    old_is_canonical := old.topic=any(canonical_topics) or old_event_type=any(canonical_topics);
    if old_is_canonical then
      if tg_op='DELETE' then raise exception 'IMMUTABLE_HANDOFF_OUTBOX'; end if;
      if new.event_id is distinct from old.event_id
        or new.topic is distinct from old.topic
        or new.payload is distinct from old.payload
      then raise exception 'IMMUTABLE_HANDOFF_OUTBOX'; end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  select event.type into new_event_type from events event where event.id=new.event_id;
  new_is_canonical := new.topic=any(canonical_topics) or new_event_type=any(canonical_topics);
  if tg_op='UPDATE' and not old_is_canonical and new_is_canonical
  then raise exception 'HANDOFF_OUTBOX_INVALID'; end if;
  if new_is_canonical then
    if new_event_type is null or new.topic<>new_event_type
      or new.payload<>jsonb_build_object('eventId',new.event_id::text)
    then raise exception 'HANDOFF_OUTBOX_INVALID'; end if;
  end if;
  return new;
end;
$$;
create trigger handoff_outbox_is_authoritative before insert or update or delete on transactional_outbox
for each row execute function protect_handoff_outbox();

create function reject_handoff_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_HANDOFF'; end; $$;
create trigger handoff_packets_are_immutable before update or delete on handoff_packets
for each row execute function reject_handoff_mutation();
create trigger handoff_packet_keys_are_immutable before update or delete on handoff_packet_keys
for each row execute function reject_handoff_mutation();
create trigger handoff_packet_ideas_are_immutable before update or delete on handoff_packet_ideas
for each row execute function reject_handoff_mutation();
create trigger handoff_packet_manifests_are_immutable before update or delete on handoff_packet_manifests
for each row execute function reject_handoff_mutation();
create trigger handoff_key_registry_is_immutable before update or delete on handoff_key_registry
for each row execute function reject_handoff_mutation();
create trigger handoff_refresh_checkpoints_are_immutable before update or delete on handoff_refresh_checkpoints
for each row execute function reject_handoff_mutation();
create trigger handoff_refresh_checkpoint_keys_are_immutable before update or delete on handoff_refresh_checkpoint_keys
for each row execute function reject_handoff_mutation();
create trigger handoff_refresh_checkpoint_manifests_are_immutable before update or delete on handoff_refresh_checkpoint_manifests
for each row execute function reject_handoff_mutation();
create trigger handoff_refresh_jobs_are_immutable before update or delete on handoff_refresh_jobs
for each row execute function reject_handoff_mutation();
create trigger handoff_refresh_job_keys_are_immutable before update or delete on handoff_refresh_job_keys
for each row execute function reject_handoff_mutation();
create trigger handoff_refresh_job_transitions_are_immutable before update or delete on handoff_refresh_job_transitions
for each row execute function reject_handoff_mutation();
create trigger handoff_refresh_job_manifests_are_immutable before update or delete on handoff_refresh_job_manifests
for each row execute function reject_handoff_mutation();
create trigger handoff_refresh_job_transition_manifests_are_immutable before update or delete on handoff_refresh_job_transition_manifests
for each row execute function reject_handoff_mutation();
