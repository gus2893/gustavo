create table cache_projection_jobs (
  id uuid primary key,
  source_kind text not null check (source_kind in (
    'TRANSACTIONAL_OUTBOX','CHALLENGE_CHECKPOINT','AUTHORITY_CHANGE'
  )),
  source_id uuid not null,
  source_outbox_id uuid references transactional_outbox(id),
  event_id uuid not null,
  topic text not null check (length(topic) between 3 and 160),
  category text not null check (category in (
    'MAIN_STATE','BROADCASTS','NODE_DOSSIERS','NODE_HANDOFFS','CHALLENGE'
  )),
  status text not null default 'PENDING' check (status in (
    'PENDING','CLAIMED','RETRY_SCHEDULED','COMPLETED','FAILED'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  worker_id text,
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz not null,
  completed_at timestamptz,
  unique (source_kind,source_id,category),
  check ((status='CLAIMED')=(worker_id is not null and lease_token is not null and lease_until is not null)),
  check ((status='COMPLETED')=(completed_at is not null))
);

create index cache_projection_jobs_claim_idx
  on cache_projection_jobs (available_at,created_at,id)
  where status in ('PENDING','RETRY_SCHEDULED','CLAIMED');
create index cache_projection_jobs_category_claim_idx
  on cache_projection_jobs (category,available_at,created_at,id)
  where status in ('PENDING','RETRY_SCHEDULED','CLAIMED');

create index cache_transactional_outbox_topic_created_idx
  on transactional_outbox (topic,created_at,id) include (event_id)
  where topic in (
    'main.broadcast.committed','node.reply.routed',
    'node.handoff.packet.refreshed','node.handoff.checkpoint.advanced',
    'proposal.disclosure.revoked'
  );
create index cache_outbox_event_ingestion_idx
  on transactional_outbox (event_id) include (id,topic,created_at)
  where topic in (
    'main.broadcast.committed','node.reply.routed',
    'node.handoff.packet.refreshed','node.handoff.checkpoint.advanced',
    'proposal.disclosure.revoked'
  );

create table cache_outbox_staging (
  outbox_id uuid primary key,
  event_id uuid not null unique references events(id),
  topic text not null check (topic in (
    'main.broadcast.committed','node.reply.routed',
    'node.handoff.packet.refreshed','node.handoff.checkpoint.advanced',
    'proposal.disclosure.revoked'
  )),
  event_ingested_sequence bigint not null check (event_ingested_sequence > 0),
  source_created_at timestamptz not null,
  staged_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz
);
create index cache_outbox_staging_pending_idx
  on cache_outbox_staging (event_ingested_sequence,outbox_id)
  include (event_id,topic,source_created_at)
  where processed_at is null;

create function stage_cache_outbox_insert() returns trigger language plpgsql as $$
begin
  if new.topic not in (
    'main.broadcast.committed','node.reply.routed',
    'node.handoff.packet.refreshed','node.handoff.checkpoint.advanced',
    'proposal.disclosure.revoked'
  ) then return new; end if;
  insert into cache_outbox_staging (
    outbox_id,event_id,topic,event_ingested_sequence,source_created_at
  )
  select new.id,new.event_id,new.topic,event.ingested_sequence,new.created_at
  from events event where event.id=new.event_id;
  if not found then raise exception 'CACHE_OUTBOX_EVENT_MISSING'; end if;
  return new;
end;
$$;
create trigger cache_outbox_insert_staged
after insert on transactional_outbox for each row execute function stage_cache_outbox_insert();

create table cache_outbox_backfill_state (
  singleton boolean primary key default true check (singleton),
  boundary_ingested_sequence bigint not null check (boundary_ingested_sequence >= 0),
  last_ingested_sequence bigint not null default 0 check (last_ingested_sequence >= 0),
  completed boolean not null,
  updated_at timestamptz not null default clock_timestamp(),
  check (last_ingested_sequence <= boundary_ingested_sequence)
);
insert into cache_outbox_backfill_state (
  boundary_ingested_sequence,last_ingested_sequence,completed
)
select coalesce(max(event.ingested_sequence),0),0,
       coalesce(max(event.ingested_sequence),0)=0
from transactional_outbox outbox join events event on event.id=outbox.event_id
where outbox.topic in (
  'main.broadcast.committed','node.reply.routed',
  'node.handoff.packet.refreshed','node.handoff.checkpoint.advanced',
  'proposal.disclosure.revoked'
);

create function create_cache_authority_event_id() returns uuid language sql volatile as $$
  select (
    substr(digest,1,8) || '-' || substr(digest,9,4) || '-4' || substr(digest,14,3)
    || '-a' || substr(digest,18,3) || '-' || substr(digest,21,12)
  )::uuid
  from (select md5(
    current_schema() || ':' || clock_timestamp()::text || ':' || random()::text
  ) digest) source;
$$;

create table cache_authority_changes (
  sequence bigint generated always as identity primary key,
  event_id uuid not null default create_cache_authority_event_id() unique,
  topic text not null check (topic in (
    'cache.authority.account.changed','cache.authority.entitlement.changed',
    'cache.authority.node.changed','cache.authority.conversation.changed'
  )),
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  conversation_id uuid not null,
  dossier_policy_version text,
  dossier_through_ordinal bigint check (dossier_through_ordinal is null or dossier_through_ordinal > 0),
  handoff_policy_version text,
  handoff_through_ordinal bigint check (handoff_through_ordinal is null or handoff_through_ordinal > 0),
  changed_at timestamptz not null default clock_timestamp(),
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  check ((dossier_policy_version is null)=(dossier_through_ordinal is null)),
  check ((handoff_policy_version is null)=(handoff_through_ordinal is null))
);
create index cache_authority_changes_sequence_idx
  on cache_authority_changes (sequence)
  include (event_id,topic,account_id,node_brain_id,conversation_id,dossier_policy_version,
    dossier_through_ordinal,handoff_policy_version,handoff_through_ordinal,changed_at);

create table cache_authority_staging (
  authority_event_id uuid primary key references cache_authority_changes(event_id),
  authority_sequence bigint not null unique check (authority_sequence > 0),
  staged_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz
);
create index cache_authority_staging_pending_idx
  on cache_authority_staging (authority_sequence,authority_event_id)
  where processed_at is null;

create function stage_cache_authority_insert() returns trigger language plpgsql as $$
begin
  insert into cache_authority_staging(authority_event_id,authority_sequence)
  values (new.event_id,new.sequence);
  return new;
end;
$$;
create trigger cache_authority_insert_staged
after insert on cache_authority_changes for each row execute function stage_cache_authority_insert();

create function append_cache_authority_change() returns trigger language plpgsql as $$
declare
  target_account_id uuid;
  target_node_brain_id uuid;
  target_conversation_id uuid;
  change_topic text;
begin
  if tg_table_name='accounts' then
    target_account_id := new.id;
    change_topic := 'cache.authority.account.changed';
  elsif tg_table_name='entitlements' then
    target_account_id := new.account_id;
    change_topic := 'cache.authority.entitlement.changed';
  elsif tg_table_name='node_brains' then
    target_account_id := new.account_id;
    target_node_brain_id := new.id;
    change_topic := 'cache.authority.node.changed';
  elsif tg_table_name='conversations' then
    target_account_id := new.account_id;
    target_node_brain_id := new.node_brain_id;
    target_conversation_id := new.id;
    change_topic := 'cache.authority.conversation.changed';
  else
    raise exception 'CACHE_AUTHORITY_CHANGE_SOURCE_INVALID';
  end if;

  insert into cache_authority_changes (
    topic,account_id,node_brain_id,conversation_id,
    dossier_policy_version,dossier_through_ordinal,
    handoff_policy_version,handoff_through_ordinal
  )
  select change_topic,conversation.account_id,conversation.node_brain_id,conversation.id,
         dossier.policy_version,dossier.ingested_sequence,
         handoff.policy_version,handoff.source_high_water_sequence
  from conversations conversation
  left join lateral (
    select coalesce(event.policy_version,'node-routing-v1') policy_version,
           event.ingested_sequence
    from events event
    where event.aggregate_id=conversation.id::text
      and event.account_id=conversation.account_id::text
      and event.actor_type='NODE_BRAIN'
      and event.actor_id=conversation.node_brain_id::text
      and event.type='node.reply.routed' and event.visibility='PRIVATE_ACCOUNT'
    order by event.ingested_sequence desc,event.id desc limit 1
  ) dossier on true
  left join lateral (
    select source.policy_version,source.source_high_water_sequence
    from (
      select packet.policy_version,packet.source_high_water_sequence,packet.id
      from handoff_packets packet
      where packet.account_id=conversation.account_id
        and packet.node_brain_id=conversation.node_brain_id
        and packet.conversation_id=conversation.id
      union all
      select checkpoint.policy_version,checkpoint.source_high_water_sequence,checkpoint.id
      from handoff_refresh_checkpoints checkpoint
      where checkpoint.account_id=conversation.account_id
        and checkpoint.node_brain_id=conversation.node_brain_id
        and checkpoint.conversation_id=conversation.id
    ) source
    order by source.source_high_water_sequence desc,source.id desc limit 1
  ) handoff on true
  where conversation.account_id=target_account_id
    and (target_node_brain_id is null or conversation.node_brain_id=target_node_brain_id)
    and (target_conversation_id is null or conversation.id=target_conversation_id);
  return new;
end;
$$;
create trigger cache_account_authority_changed
after update of status on accounts for each row
when (old.status is distinct from new.status)
execute function append_cache_authority_change();
create trigger cache_entitlement_authority_changed
after update of active_from,expires_at,revoked_at on entitlements for each row
when (old.active_from is distinct from new.active_from
  or old.expires_at is distinct from new.expires_at
  or old.revoked_at is distinct from new.revoked_at)
execute function append_cache_authority_change();
create trigger cache_node_authority_changed
after update of status on node_brains for each row
when (old.status is distinct from new.status)
execute function append_cache_authority_change();
create trigger cache_conversation_authority_changed
after update of status on conversations for each row
when (old.status is distinct from new.status)
execute function append_cache_authority_change();

create table cache_main_state_sources (
  main_state_version bigint primary key references main_state_versions(version),
  source_event_id uuid not null unique references events(id),
  source_ingestion_ordinal bigint not null unique check (source_ingestion_ordinal > 0),
  policy_version text not null check (length(trim(policy_version)) between 1 and 128),
  created_at timestamptz not null default clock_timestamp()
);
insert into cache_main_state_sources (
  main_state_version,source_event_id,source_ingestion_ordinal,policy_version,created_at
)
select distinct on (broadcast.main_state_version)
       broadcast.main_state_version,broadcast.commit_event_id,event.ingested_sequence,
       broadcast.policy_version,broadcast.committed_at
from broadcasts broadcast join events event on event.id=broadcast.commit_event_id
order by broadcast.main_state_version,event.ingested_sequence,broadcast.id;
create index cache_main_state_sources_current_idx
  on cache_main_state_sources (main_state_version desc)
  include (source_event_id,source_ingestion_ordinal,policy_version,created_at);
create index cache_handoff_packets_hottest_idx
  on handoff_packets (source_high_water_sequence desc,packet_version desc,id)
  include (account_id,node_brain_id,conversation_id,packet_event_id,through_event_id,
    main_state_version,node_state_version,idea_count,policy_version,created_at);
create index cache_handoff_packets_entity_latest_idx
  on handoff_packets (
    account_id,node_brain_id,conversation_id,
    source_high_water_sequence desc,packet_version desc,id
  ) include (packet_event_id,through_event_id,main_state_version,node_state_version,
    idea_count,policy_version,created_at);
create index cache_handoff_checkpoints_hottest_idx
  on handoff_refresh_checkpoints (
    source_high_water_sequence desc,checkpoint_version desc,id
  ) include (account_id,node_brain_id,conversation_id,checkpoint_event_id,through_event_id,
    main_state_version,node_state_version,policy_version,created_at);
create index cache_handoff_checkpoints_entity_latest_idx
  on handoff_refresh_checkpoints (
    account_id,node_brain_id,conversation_id,
    source_high_water_sequence desc,checkpoint_version desc,id
  ) include (checkpoint_event_id,through_event_id,main_state_version,node_state_version,
    policy_version,created_at);

create table cache_projection_versions (
  id bigint generated always as identity primary key,
  job_id uuid references cache_projection_jobs(id),
  category text not null check (category in (
    'MAIN_STATE','BROADCASTS','NODE_DOSSIERS','NODE_HANDOFFS','CHALLENGE'
  )),
  entity_id text not null check (length(entity_id) between 1 and 240),
  source_event_id uuid not null,
  source_high_water text not null check (length(source_high_water) between 1 and 200),
  version_ordinal numeric(40,0) not null check (version_ordinal >= 0),
  content_hash char(64) not null check (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (category,entity_id,source_high_water,version_ordinal)
);
create index cache_projection_versions_current_idx
  on cache_projection_versions (category,entity_id,version_ordinal desc,id desc);

create table cache_rebuild_runs (
  id uuid primary key,
  mode text not null check (mode in ('REBUILD','STARTUP_PREWARM')),
  checkpoint text not null check (length(checkpoint) between 1 and 200),
  status text not null check (status in ('RUNNING','VERIFIED','FAILED')),
  record_count integer,
  manifest_hash char(64),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  error_code text
);

create table cache_rebuild_category_checks (
  run_id uuid not null references cache_rebuild_runs(id),
  category text not null check (category in (
    'MAIN_STATE','BROADCASTS','NODE_DOSSIERS','NODE_HANDOFFS','CHALLENGE'
  )),
  source_high_water text not null check (length(source_high_water) between 1 and 200),
  record_count integer not null check (record_count >= 0),
  manifest_hash char(64) not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  high_water_count integer not null check (high_water_count=record_count),
  high_water_hash char(64) not null check (high_water_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status='VERIFIED'),
  verified_at timestamptz not null default clock_timestamp(),
  primary key (run_id,category)
);

create table cache_metric_observations (
  id bigint generated always as identity primary key,
  name text not null check (name in (
    'cache.hit','cache.miss','cache.fallback','cache.backend_failure',
    'cache.queue_lag_ms','cache.invalidation_latency_ms','cache.prewarm_latency_ms',
    'cache.startup_prewarm_latency_ms','cache.rebuild_latency_ms','cache.freshness_lag_ms'
  )),
  value double precision not null check (value >= 0),
  category text check (category is null or category in (
    'MAIN_STATE','BROADCASTS','NODE_DOSSIERS','NODE_HANDOFFS','CHALLENGE'
  )),
  topology_version text not null default 'single-main-node-v1'
    check (length(trim(topology_version)) between 1 and 128),
  bucket_start timestamptz not null default date_trunc('minute',clock_timestamp()),
  sample_count bigint not null check (sample_count > 0),
  value_sum double precision not null,
  value_max double precision not null,
  observed_at timestamptz not null default clock_timestamp(),
  unique nulls not distinct (name,category,topology_version,bucket_start),
  check (bucket_start=date_trunc('minute',bucket_start)),
  check (value_sum >= value_max),
  check (value_max >= value)
);
create index cache_metric_observations_latest_idx
  on cache_metric_observations (observed_at desc,id desc)
  include (name,value,category,topology_version,bucket_start,sample_count,value_sum,value_max);
create index cache_metric_observations_retention_idx
  on cache_metric_observations (
    name,topology_version,category,bucket_start desc,id desc
  );

create function reject_cache_authority_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_CACHE_AUTHORITY';
end;
$$;
create trigger cache_projection_versions_immutable before update or delete on cache_projection_versions
for each row execute function reject_cache_authority_mutation();
create trigger cache_rebuild_category_checks_immutable before update or delete on cache_rebuild_category_checks
for each row execute function reject_cache_authority_mutation();
create trigger cache_authority_changes_immutable before update or delete on cache_authority_changes
for each row execute function reject_cache_authority_mutation();
create trigger cache_main_state_sources_immutable before update or delete on cache_main_state_sources
for each row execute function reject_cache_authority_mutation();
