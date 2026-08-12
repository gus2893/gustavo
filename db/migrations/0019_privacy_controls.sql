create table privacy_projection_registry (
  projection_type text primary key check (projection_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ordinal integer not null unique check (ordinal between 1 and 500),
  relation_name text not null check (length(relation_name) between 1 and 128),
  forget_behavior text not null check (forget_behavior in ('FORGET','RETAIN','RETAIN_TOMBSTONE')),
  rebuild_behavior text not null check (rebuild_behavior in ('REBUILD','RETAIN','RETAIN_TOMBSTONE')),
  forget_executor text not null default 'DEACTIVATE_TYPED' check (forget_executor in (
    'DEACTIVATE_TYPED','RETAIN_METADATA','RETAIN_TOMBSTONE'
  )),
  rebuild_executor text not null default 'REBUILD_TYPED' check (rebuild_executor in (
    'REBUILD_TYPED','RETAIN_METADATA','RETAIN_TOMBSTONE'
  )),
  created_at timestamptz not null default clock_timestamp()
);

insert into privacy_projection_registry
  (projection_type,ordinal,relation_name,forget_behavior,rebuild_behavior) values
  ('CONSOLIDATION_RUN',1,'memory_extraction_runs','FORGET','REBUILD'),
  ('MEMORY_RECORD',2,'memory_records','FORGET','REBUILD'),
  ('MEMORY_SOURCE',3,'memory_sources','FORGET','REBUILD'),
  ('MEMORY_INDEX',4,'memory_index_terms','FORGET','REBUILD'),
  ('MEMORY_VECTOR',5,'memory_vector_buckets','FORGET','REBUILD'),
  ('MEMORY_EMBEDDING',6,'memory_embeddings','FORGET','REBUILD'),
  ('EPISODE_SUMMARY',7,'memory_episodes','FORGET','REBUILD'),
  ('DOSSIER_REFRESH',8,'memory_dossier_refreshes','FORGET','REBUILD'),
  ('MEMORY_CHECKPOINT',9,'memory_projection_checkpoints','FORGET','REBUILD'),
  ('MEMORY_EQUIVALENCE',10,'memory_equivalence_sets','FORGET','REBUILD'),
  ('RECALL_TRACE',11,'recall_traces','FORGET','REBUILD'),
  ('RECALL_TRACE_SOURCE',12,'recall_trace_sources','FORGET','REBUILD'),
  ('RECALL_CONTEXT',13,'recall_trace_context_entries','FORGET','REBUILD'),
  ('GRAPH_NODE',14,'memory_graph_nodes','FORGET','REBUILD'),
  ('GRAPH_NODE_SOURCE',15,'memory_graph_node_sources','FORGET','REBUILD'),
  ('GRAPH_EDGE',16,'memory_graph_edges','FORGET','REBUILD'),
  ('GRAPH_EDGE_SOURCE',17,'memory_graph_edge_sources','FORGET','REBUILD'),
  ('GRAPH_CURRENT_HEAD',18,'memory_graph_head_versions','FORGET','REBUILD'),
  ('GRAPH_CONFLICT',19,'memory_conflicts','FORGET','REBUILD'),
  ('GRAPH_JOB',20,'memory_graph_background_jobs','FORGET','REBUILD'),
  ('GRAPH_RECONCILIATION',21,'memory_graph_reconciliation_jobs','FORGET','REBUILD'),
  ('HANDOFF_PACKET',22,'handoff_packets','FORGET','REBUILD'),
  ('HANDOFF_CHECKPOINT',23,'handoff_refresh_checkpoints','FORGET','REBUILD'),
  ('HANDOFF_JOB',24,'handoff_refresh_jobs','FORGET','REBUILD'),
  ('CACHE_PROJECTION',25,'cache_projection_versions','FORGET','REBUILD'),
  ('CACHE_JOB',26,'cache_projection_jobs','FORGET','REBUILD'),
  ('CACHE_AUTHORITY',27,'cache_authority_changes','FORGET','REBUILD'),
  ('CHAT_IMPORT',28,'chat_source_imports','FORGET','REBUILD'),
  ('IMPORT_MEMORY',29,'import_memory_projections','FORGET','REBUILD'),
  ('IMPORT_LIFECYCLE',30,'import_item_lifecycle_events','FORGET','REBUILD'),
  ('FORGET_TOMBSTONE',31,'audit_events','RETAIN_TOMBSTONE','RETAIN_TOMBSTONE');

update privacy_projection_registry
set forget_executor='RETAIN_TOMBSTONE',rebuild_executor='RETAIN_TOMBSTONE'
where projection_type='FORGET_TOMBSTONE';

update privacy_projection_registry
set rebuild_behavior='RETAIN',rebuild_executor='RETAIN_METADATA'
where projection_type not in ('MEMORY_RECORD','GRAPH_EDGE','FORGET_TOMBSTONE');

-- The normalized projection inventory is intentionally duplicated here rather than
-- inferred from pg_catalog: adding a T18-T25 relation requires an explicit privacy
-- decision in the same migration that adds the relation.  Metadata-only child
-- relations retain immutable provenance; their protected bodies remain behind the
-- conversation key/barrier and their owning projections are deactivated above.
with inventory(relation_name,inventory_ordinal) as (
  select relation_name,inventory_ordinal::integer from unnest(array[
    'thought_records','thought_claims','thought_references',
    'recall_actor_authorities',
    'memory_extraction_runs','memory_records','memory_sources','memory_semantic_facts',
    'memory_episodes','memory_procedures','memory_goals','memory_embeddings',
    'memory_index_terms','memory_equivalence_sets','memory_equivalence_links',
    'memory_supersession_authorizations','memory_retrieval_stats',
    'memory_projection_checkpoints','memory_dossier_refreshes','memory_vector_buckets',
    'memory_vector_backfill_checkpoints','memory_graph_edges','recall_traces',
    'recall_trace_plan_steps','recall_trace_candidates','recall_trace_sources',
    'recall_trace_context_entries','chat_source_authorizations','chat_sources',
    'chat_source_imports','imported_chat_conversations',
    'imported_chat_conversation_versions','imported_chat_message_versions',
    'chat_import_quarantine','chat_source_cursors','chat_import_conversation_occurrences',
    'chat_import_item_occurrences','chat_import_quarantine_occurrences',
    'chat_source_event_manifests','memory_graph_reconciliation_runs',
    'memory_graph_idempotency_keys','memory_graph_entities','memory_graph_entity_versions',
    'memory_graph_run_entities','memory_graph_entity_aliases','memory_graph_run_aliases',
    'memory_graph_alias_sources','memory_graph_nodes','memory_graph_run_candidates',
    'memory_graph_node_sources','memory_graph_current_claims',
    'memory_graph_legacy_edge_backfills','memory_graph_run_edges',
    'memory_graph_edge_sources','memory_conflicts','memory_graph_run_conflicts',
    'memory_conflict_sources','memory_graph_background_jobs',
    'memory_graph_reconciliation_jobs','memory_graph_reconciliation_job_idempotency_keys',
    'memory_graph_reconciliation_job_entities','memory_graph_reconciliation_job_aliases',
    'memory_graph_reconciliation_job_sources','memory_graph_reconciliation_job_source_sets',
    'memory_graph_reconciliation_job_candidates','memory_graph_reconciliation_job_manifests',
    'memory_graph_reconciliation_job_transitions',
    'memory_graph_reconciliation_job_transition_manifests','memory_graph_event_manifests',
    'memory_graph_head_versions','memory_graph_background_job_transitions',
    'memory_graph_job_transition_manifests','memory_graph_worker_authorities',
    'handoff_packets','handoff_packet_keys',
    'handoff_packet_ideas','handoff_packet_manifests','handoff_refresh_checkpoints',
    'handoff_refresh_checkpoint_keys','handoff_refresh_checkpoint_manifests',
    'handoff_key_registry','handoff_refresh_jobs','handoff_refresh_job_keys',
    'handoff_refresh_job_transitions','handoff_refresh_job_manifests',
    'handoff_refresh_job_transition_manifests','cache_projection_jobs',
    'cache_outbox_staging','cache_outbox_backfill_state','cache_authority_changes',
    'cache_authority_staging','cache_main_state_sources','cache_projection_versions',
    'cache_rebuild_runs','cache_rebuild_category_checks','cache_metric_observations',
    'import_manifests','import_source_items','import_memory_projections',
    'import_review_queue_entries','import_lifecycle_commands',
    'import_lifecycle_idempotency_aliases','import_item_lifecycle_events',
    'import_verification_receipts','import_event_authorities',
    'proposal_disclosure_authorizations','proposal_disclosure_revocations',
    'proposal_operation_idempotency','proposals','proposal_evidence_links',
    'proposal_status_transitions','proposal_turns','proposal_turn_evidence_links'
  ]) with ordinality item(relation_name,inventory_ordinal)
)
insert into privacy_projection_registry
  (projection_type,ordinal,relation_name,forget_behavior,rebuild_behavior,
   forget_executor,rebuild_executor)
select 'CATALOG_'||lpad(inventory.inventory_ordinal::text,3,'0'),
       31+inventory.inventory_ordinal,inventory.relation_name,
       case when inventory.relation_name like 'thought_%'
           or inventory.relation_name in ('proposal_disclosure_authorizations','proposals',
             'proposal_evidence_links','proposal_status_transitions','proposal_turns',
             'proposal_turn_evidence_links') then 'FORGET'
         when inventory.relation_name in ('chat_source_authorizations','chat_sources',
           'recall_actor_authorities','memory_graph_worker_authorities',
           'proposal_disclosure_revocations','proposal_operation_idempotency')
           then 'RETAIN_TOMBSTONE'
         else 'RETAIN' end,
       case when inventory.relation_name in ('chat_source_authorizations','chat_sources',
           'recall_actor_authorities','memory_graph_worker_authorities',
           'proposal_disclosure_revocations','proposal_operation_idempotency')
           then 'RETAIN_TOMBSTONE'
         else 'RETAIN' end,
       case when inventory.relation_name like 'thought_%'
           or inventory.relation_name in ('proposal_disclosure_authorizations','proposals',
             'proposal_evidence_links','proposal_status_transitions','proposal_turns',
             'proposal_turn_evidence_links') then 'DEACTIVATE_TYPED'
         when inventory.relation_name in ('chat_source_authorizations','chat_sources',
           'recall_actor_authorities','memory_graph_worker_authorities',
           'proposal_disclosure_revocations','proposal_operation_idempotency')
           then 'RETAIN_TOMBSTONE'
         else 'RETAIN_METADATA' end,
       case when inventory.relation_name in ('chat_source_authorizations','chat_sources',
           'recall_actor_authorities','memory_graph_worker_authorities',
           'proposal_disclosure_revocations','proposal_operation_idempotency')
           then 'RETAIN_TOMBSTONE'
         else 'RETAIN_METADATA' end
from inventory
where not exists (
  select 1 from privacy_projection_registry registry
  where registry.relation_name=inventory.relation_name
)
order by inventory.inventory_ordinal;

create function reject_privacy_registry_mutation() returns trigger language plpgsql as $$
begin
  if tg_table_name='privacy_projection_registry' and tg_op='INSERT' then
    raise exception 'PRIVACY_PROJECTION_HANDLER_UNKNOWN';
  end if;
  raise exception 'IMMUTABLE_PRIVACY_PROJECTION_REGISTRY';
end;
$$;
create trigger privacy_projection_registry_is_immutable
before insert or update or delete on privacy_projection_registry
for each row execute function reject_privacy_registry_mutation();

create table privacy_legal_authorities (
  id text primary key check (length(id) between 1 and 240),
  account_id uuid not null references accounts(id),
  actor_id text not null check (length(actor_id) between 1 and 200),
  legal_role text not null check (legal_role='PRIVACY_OFFICER'),
  capability text not null check (capability in ('FORGET_CONVERSATION','EXPORT_DATA')),
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (id,account_id),
  unique (account_id,actor_id,capability,id)
);

create trigger privacy_legal_authorities_are_immutable
before update or delete on privacy_legal_authorities
for each row execute function reject_privacy_registry_mutation();

create table privacy_legal_authority_revocations (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  authority_id text not null,
  account_id uuid not null,
  revoker_authority_id text not null,
  revoked_by_actor_id text not null check (length(revoked_by_actor_id) between 1 and 200),
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  revoked_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  unique (authority_id),
  foreign key (authority_id,account_id)
    references privacy_legal_authorities(id,account_id),
  foreign key (revoker_authority_id,account_id)
    references privacy_legal_authorities(id,account_id),
  check (authority_id<>revoker_authority_id)
);

create table privacy_forget_worker_authorities (
  worker_id text primary key check (length(worker_id) between 1 and 128),
  active boolean not null default true,
  grant_kind text not null default 'SYSTEM_BOOTSTRAP' check (grant_kind='SYSTEM_BOOTSTRAP'),
  created_at timestamptz not null default clock_timestamp()
);
insert into privacy_forget_worker_authorities (worker_id) values
  ('privacy-forget-production'),
  ('privacy-worker-test');
create function reject_privacy_worker_authority_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'PRIVACY_FORGET_WORKER_GRANT_INVALID';
end;
$$;
create trigger privacy_forget_worker_authorities_are_immutable
before insert or update or delete on privacy_forget_worker_authorities
for each row execute function reject_privacy_worker_authority_mutation();

create table privacy_forget_worker_revocations (
  worker_id text primary key references privacy_forget_worker_authorities(worker_id),
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  revoked_at timestamptz not null default clock_timestamp()
);
create trigger privacy_forget_worker_revocations_are_immutable
before update or delete on privacy_forget_worker_revocations
for each row execute function reject_privacy_registry_mutation();

create table privacy_forget_requests (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  conversation_id uuid not null,
  event_id uuid not null unique references events(id),
  authority_kind text not null check (authority_kind in ('ACCOUNT_OWNER','LEGAL')),
  actor_id text not null check (length(actor_id) between 1 and 200),
  authority_reference text not null check (length(authority_reference) between 1 and 240),
  capability text not null check (capability='FORGET_CONVERSATION'),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 240),
  request_digest char(64) not null unique check (request_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'PENDING' check (status='PENDING'),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique (conversation_id),
  unique (id,account_id,node_brain_id,conversation_id)
);

create table privacy_forget_request_aliases (
  idempotency_key text primary key check (length(idempotency_key) between 1 and 240),
  request_id uuid not null references privacy_forget_requests(id),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id,idempotency_key)
);

create table privacy_forget_barriers (
  conversation_id uuid primary key,
  account_id uuid not null,
  node_brain_id uuid not null,
  request_id uuid not null unique,
  established_at timestamptz not null default clock_timestamp(),
  key_destroyed_at timestamptz not null,
  foreign key (request_id,account_id,node_brain_id,conversation_id)
    references privacy_forget_requests(id,account_id,node_brain_id,conversation_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id)
);

-- Conversation-derived aggregates (for example private proposal review threads)
-- have independent envelope keys.  This append-only ledger makes their erasure
-- durable and prevents a later writer from recreating those keys.
create table privacy_erased_aggregate_keys (
  aggregate_id text primary key check (length(aggregate_id) between 1 and 200),
  request_id uuid not null references privacy_forget_requests(id),
  account_id uuid not null references accounts(id),
  conversation_id uuid not null,
  aggregate_kind text not null check (aggregate_kind in ('PROPOSAL','PROPOSAL_DISCLOSURE')),
  erased_at timestamptz not null default transaction_timestamp(),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique (request_id,aggregate_id)
);

create table privacy_forget_steps (
  request_id uuid not null references privacy_forget_requests(id),
  projection_type text not null references privacy_projection_registry(projection_type),
  ordinal integer not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (request_id,projection_type),
  unique (request_id,ordinal)
);

create table privacy_projection_deactivations (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  projection_type text not null,
  record_id text not null check (length(record_id) between 1 and 512),
  retained_source_count integer not null default 0 check (retained_source_count between 0 and 500),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (request_id,projection_type)
    references privacy_forget_steps(request_id,projection_type),
  unique (request_id,projection_type,record_id)
);
create index privacy_projection_deactivations_record_idx
  on privacy_projection_deactivations (projection_type,record_id,request_id);

create table privacy_projection_rebuild_jobs (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  projection_type text not null,
  record_id text not null check (length(record_id) between 1 and 512),
  remaining_source_ids uuid[] not null check (cardinality(remaining_source_ids) between 1 and 500),
  status text not null default 'PENDING' check (status='PENDING'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (request_id,projection_type,record_id)
    references privacy_projection_deactivations(request_id,projection_type,record_id),
  unique (request_id,projection_type,record_id),
  check (projection_type in ('MEMORY_RECORD','GRAPH_EDGE'))
);

create table privacy_projection_rebuild_job_transitions (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  rebuild_job_id bigint not null references privacy_projection_rebuild_jobs(id),
  transition_ordinal integer not null check (transition_ordinal between 1 and 1000),
  to_status text not null check (to_status in (
    'CLAIMED','RETRY_SCHEDULED','COMPLETED','FAILED'
  )),
  worker_id text not null check (length(worker_id) between 1 and 128),
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  affected_count integer check (affected_count is null or affected_count between 0 and 1000),
  error_code text check (error_code is null or length(error_code) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  unique (rebuild_job_id,transition_ordinal),
  check ((to_status='CLAIMED')=(lease_token is not null and lease_until is not null)),
  check (to_status<>'CLAIMED' or lease_until>created_at),
  check ((to_status='RETRY_SCHEDULED')=(retry_at is not null)),
  check ((to_status='COMPLETED')=(affected_count is not null)),
  check ((to_status in ('RETRY_SCHEDULED','FAILED'))=(error_code is not null))
);
create index privacy_projection_rebuild_claim_idx
  on privacy_projection_rebuild_job_transitions (rebuild_job_id,transition_ordinal desc);

create table privacy_projection_rebuild_results (
  rebuild_job_id bigint primary key references privacy_projection_rebuild_jobs(id),
  replacement_record_id text not null check (length(replacement_record_id) between 1 and 512),
  source_manifest uuid[] not null check (cardinality(source_manifest) between 1 and 500),
  created_at timestamptz not null default clock_timestamp()
);

create table privacy_forget_step_transitions (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  request_id uuid not null,
  projection_type text not null,
  transition_ordinal integer not null check (transition_ordinal between 1 and 1000),
  to_status text not null check (to_status in (
    'CLAIMED','RETRY_SCHEDULED','COMPLETED','FAILED'
  )),
  worker_id text not null check (length(worker_id) between 1 and 128),
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz,
  affected_count integer check (affected_count is null or affected_count between 0 and 1000000),
  error_code text check (error_code is null or length(error_code) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (request_id,projection_type)
    references privacy_forget_steps(request_id,projection_type),
  unique (request_id,projection_type,transition_ordinal),
  check ((to_status='CLAIMED')=(lease_token is not null and lease_until is not null)),
  check (to_status<>'CLAIMED' or lease_until>created_at),
  check ((to_status='RETRY_SCHEDULED')=(retry_at is not null)),
  check ((to_status='COMPLETED')=(affected_count is not null)),
  check ((to_status in ('RETRY_SCHEDULED','FAILED'))=(error_code is not null))
);
create index privacy_forget_step_claim_idx
  on privacy_forget_step_transitions (request_id,projection_type,transition_ordinal desc);

create table audit_events (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  aggregate_id uuid not null,
  account_id uuid not null references accounts(id),
  type text not null check (type in (
    'content.forgotten','content.forget_propagated','conversation.archived',
    'conversation.restored','account.export.started'
  )),
  actor_kind text not null check (actor_kind in ('ACCOUNT_OWNER','LEGAL','SYSTEM')),
  actor_id text not null check (length(actor_id) between 1 and 200),
  metadata jsonb not null check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default clock_timestamp()
);
create index audit_events_aggregate_created_idx on audit_events (aggregate_id,created_at desc,id);

create table conversation_archive_commands (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  account_id uuid not null,
  conversation_id uuid not null,
  archived boolean not null,
  authority_kind text not null check (authority_kind='ACCOUNT_OWNER'),
  actor_id text not null check (length(actor_id) between 1 and 200),
  authority_reference text not null check (length(authority_reference) between 1 and 240),
  capability text not null check (capability='ARCHIVE_CONVERSATION'),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 240),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default transaction_timestamp(),
  foreign key (conversation_id,account_id) references conversations(id,account_id)
);

create table account_export_snapshots (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  account_id uuid not null references accounts(id),
  authority_kind text not null check (authority_kind in ('ACCOUNT_OWNER','LEGAL')),
  actor_id text not null check (length(actor_id) between 1 and 200),
  authority_reference text not null check (length(authority_reference) between 1 and 240),
  capability text not null check (capability='EXPORT_DATA'),
  record_count integer not null check (record_count between 0 and 100000),
  source_high_water char(64) not null check (source_high_water ~ '^[a-f0-9]{64}$'),
  membership_digest char(64) not null check (membership_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  check (expires_at>created_at)
);

create index account_export_snapshots_active_idx
  on account_export_snapshots (account_id,expires_at desc,created_at desc,id);

create table account_export_snapshot_retirements (
  snapshot_id uuid primary key references account_export_snapshots(id),
  account_id uuid not null references accounts(id),
  reason text not null check (reason in ('CONTENT_CHANGED','CONTENT_FORGOTTEN','EXPIRED')),
  retired_at timestamptz not null default transaction_timestamp()
);

create table account_export_snapshot_records (
  snapshot_id uuid not null references account_export_snapshots(id),
  ordinal integer not null check (ordinal between 1 and 100000),
  event_id uuid not null references events(id),
  source_sequence bigint not null check (source_sequence>0),
  tombstone boolean not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (snapshot_id,ordinal),
  unique (snapshot_id,event_id)
);

create function reject_privacy_append_only_mutation() returns trigger language plpgsql as $$
begin
  if tg_table_name='privacy_forget_requests' and tg_op='UPDATE' then
    raise exception 'PRIVACY_FORGET_COMPLETION_INVALID';
  end if;
  raise exception '%', case tg_table_name
    when 'privacy_forget_barriers' then 'IMMUTABLE_PRIVACY_FORGET_BARRIER'
    when 'privacy_forget_requests' then 'PRIVACY_FORGET_COMPLETION_INVALID'
    when 'privacy_legal_authority_revocations'
      then 'IMMUTABLE_PRIVACY_LEGAL_AUTHORITY_REVOCATION'
    else 'IMMUTABLE_PRIVACY_CONTROL_RECORD'
  end;
end;
$$;

create function validate_account_export_snapshot_record_insert() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from account_export_snapshots snapshot
    where snapshot.id=new.snapshot_id
      and snapshot.created_at=transaction_timestamp()
      and new.created_at=transaction_timestamp()
  ) then raise exception 'ACCOUNT_EXPORT_SNAPSHOT_MEMBERSHIP_INVALID'; end if;
  return new;
end;
$$;

create function validate_account_export_snapshot_retirement() returns trigger language plpgsql as $$
declare snapshot account_export_snapshots%rowtype;
begin
  select * into snapshot from account_export_snapshots where id=new.snapshot_id;
  if snapshot.id is null or snapshot.account_id<>new.account_id
     or new.retired_at<>transaction_timestamp()
     or (new.reason='EXPIRED' and snapshot.expires_at>clock_timestamp())
     or (new.reason='CONTENT_CHANGED' and not exists (
       select 1 from account_export_snapshots replacement
       where replacement.account_id=new.account_id and replacement.id<>new.snapshot_id
         and replacement.created_at=transaction_timestamp()
         and replacement.membership_digest<>snapshot.membership_digest
     ))
     or (new.reason='CONTENT_FORGOTTEN' and not exists (
       select 1 from privacy_forget_barriers barrier
       where barrier.account_id=new.account_id
         and barrier.established_at=transaction_timestamp()
     )) then raise exception 'ACCOUNT_EXPORT_SNAPSHOT_RETIREMENT_INVALID'; end if;
  return new;
end;
$$;

create function validate_account_export_snapshot_record_delete() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from account_export_snapshots snapshot
    where snapshot.id=old.snapshot_id and (
      snapshot.expires_at<=clock_timestamp() or exists (
        select 1 from account_export_snapshot_retirements retirement
        where retirement.snapshot_id=snapshot.id
      )
    )
  ) then raise exception 'IMMUTABLE_PRIVACY_CONTROL_RECORD'; end if;
  return old;
end;
$$;

create function prune_account_export_snapshot_memberships(
  target_account_id uuid, maximum_records integer
) returns integer language plpgsql as $$
declare removed integer;
begin
  if maximum_records<1 or maximum_records>100000 then
    raise exception 'ACCOUNT_EXPORT_PRUNE_BOUND_INVALID';
  end if;
  with removable as (
    select record.snapshot_id,record.ordinal
    from account_export_snapshot_records record
    join account_export_snapshots snapshot on snapshot.id=record.snapshot_id
    where snapshot.account_id=target_account_id and (
      snapshot.expires_at<=clock_timestamp() or exists (
        select 1 from account_export_snapshot_retirements retirement
        where retirement.snapshot_id=snapshot.id
      )
    ) order by snapshot.created_at,record.ordinal limit maximum_records
  )
  delete from account_export_snapshot_records record using removable
  where record.snapshot_id=removable.snapshot_id and record.ordinal=removable.ordinal;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

create function validate_privacy_erased_aggregate_key() returns trigger language plpgsql as $$
declare request privacy_forget_requests%rowtype;
declare authorized boolean := false;
begin
  select * into request from privacy_forget_requests where id=new.request_id;
  if request.id is null or request.account_id<>new.account_id
     or request.conversation_id<>new.conversation_id
     or new.erased_at<>transaction_timestamp() then
    raise exception 'PRIVACY_ERASED_AGGREGATE_KEY_INVALID';
  end if;
  if new.aggregate_kind='PROPOSAL' then
    select exists (
      select 1 from proposals proposal where proposal.id::text=new.aggregate_id
        and proposal.account_id=request.account_id and (
          proposal.conversation_id=request.conversation_id or exists (
            select 1 from events source_event
            where proposal.source_event_ids ? source_event.id::text
              and source_event.account_id=request.account_id::text
              and source_event.aggregate_id=request.conversation_id::text
          )
        )
    ) into authorized;
  elsif new.aggregate_kind='PROPOSAL_DISCLOSURE' then
    select exists (
      select 1 from proposal_disclosure_authorizations disclosure
      where disclosure.id::text=new.aggregate_id
        and disclosure.account_id=request.account_id and (
          disclosure.conversation_id=request.conversation_id or exists (
            select 1 from events source_event
            where disclosure.source_event_ids ? source_event.id::text
              and source_event.account_id=request.account_id::text
              and source_event.aggregate_id=request.conversation_id::text
          )
        )
    ) into authorized;
  end if;
  if not authorized or exists (
    select 1 from aggregate_data_keys key where key.aggregate_id=new.aggregate_id
  ) then raise exception 'PRIVACY_ERASED_AGGREGATE_KEY_INVALID'; end if;
  return new;
end;
$$;

create trigger privacy_forget_requests_are_immutable
before update or delete on privacy_forget_requests
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_forget_aliases_are_immutable
before update or delete on privacy_forget_request_aliases
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_forget_barriers_are_immutable
before update or delete on privacy_forget_barriers
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_erased_aggregate_keys_are_immutable
before update or delete on privacy_erased_aggregate_keys
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_forget_steps_are_immutable
before update or delete on privacy_forget_steps
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_projection_deactivations_are_immutable
before update or delete on privacy_projection_deactivations
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_projection_rebuild_jobs_are_immutable
before update or delete on privacy_projection_rebuild_jobs
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_projection_rebuild_transitions_are_immutable
before update or delete on privacy_projection_rebuild_job_transitions
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_projection_rebuild_results_are_immutable
before update or delete on privacy_projection_rebuild_results
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_forget_transitions_are_immutable
before update or delete on privacy_forget_step_transitions
for each row execute function reject_privacy_append_only_mutation();
create trigger privacy_audit_events_are_immutable
before update or delete on audit_events
for each row execute function reject_privacy_append_only_mutation();
create trigger conversation_archive_commands_are_immutable
before update or delete on conversation_archive_commands
for each row execute function reject_privacy_append_only_mutation();
create trigger account_export_snapshots_are_immutable
before update or delete on account_export_snapshots
for each row execute function reject_privacy_append_only_mutation();
create trigger account_export_snapshot_records_are_immutable
before update on account_export_snapshot_records
for each row execute function reject_privacy_append_only_mutation();
create trigger account_export_snapshot_record_delete_is_guarded
before delete on account_export_snapshot_records
for each row execute function validate_account_export_snapshot_record_delete();
create trigger account_export_snapshot_retirement_is_exact
before insert on account_export_snapshot_retirements
for each row execute function validate_account_export_snapshot_retirement();
create trigger account_export_snapshot_retirements_are_immutable
before update or delete on account_export_snapshot_retirements
for each row execute function reject_privacy_append_only_mutation();
create trigger account_export_snapshot_record_insert_is_scoped
before insert on account_export_snapshot_records
for each row execute function validate_account_export_snapshot_record_insert();
create constraint trigger privacy_erased_aggregate_key_is_complete
after insert on privacy_erased_aggregate_keys deferrable initially deferred
for each row execute function validate_privacy_erased_aggregate_key();

create function reject_conversation_derived_content_after_forget()
returns trigger language plpgsql as $$
declare target_conversation uuid;
declare source_ids jsonb;
begin
  if tg_table_name='proposals' then
    target_conversation := new.conversation_id;
    source_ids := new.source_event_ids;
  else
    target_conversation := new.conversation_id;
    source_ids := new.source_event_ids;
  end if;
  if exists (
      select 1 from privacy_forget_barriers barrier
      where barrier.conversation_id=target_conversation
    ) or exists (
      select 1 from events source_event join privacy_forget_barriers barrier
        on barrier.conversation_id::text=source_event.aggregate_id
      where source_ids ? source_event.id::text
    ) then raise exception 'FORGOTTEN_CONVERSATION_DERIVATION_FORBIDDEN'; end if;
  return new;
end;
$$;
create constraint trigger proposal_after_forget_is_forbidden
after insert on proposals deferrable initially deferred
for each row execute function reject_conversation_derived_content_after_forget();
create constraint trigger proposal_disclosure_after_forget_is_forbidden
after insert on proposal_disclosure_authorizations deferrable initially deferred
for each row execute function reject_conversation_derived_content_after_forget();
create trigger privacy_legal_authority_revocations_are_immutable
before update or delete on privacy_legal_authority_revocations
for each row execute function reject_privacy_append_only_mutation();

create function validate_privacy_projection_deactivation() returns trigger language plpgsql as $$
declare target_conversation uuid;
declare registered_behavior text;
declare registered_relation text;
declare record_is_authorized boolean := false;
begin
  select request.conversation_id into target_conversation
  from privacy_forget_requests request where request.id=new.request_id;
  if target_conversation is null then
    raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID';
  end if;
  select forget_behavior,relation_name into registered_behavior,registered_relation
  from privacy_projection_registry
  where projection_type=new.projection_type;
  if registered_behavior is null or registered_behavior in ('RETAIN','RETAIN_TOMBSTONE') then
    raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID';
  end if;
  if new.projection_type='MEMORY_RECORD' and not exists (
    select 1 from memory_records memory
    where memory.id::text=new.record_id and (
      memory.conversation_id=target_conversation or exists (
        select 1 from memory_sources source join events event on event.id=source.source_event_id
        where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
      )
    ) and new.retained_source_count=(
      select count(*)::int from memory_sources source
      join events event on event.id=source.source_event_id
      join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
      where source.memory_id=memory.id and event.aggregate_id<>target_conversation::text
    )
  ) then raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID'; end if;
  if new.projection_type='CATALOG_001' and not exists (
    select 1 from thought_records thought where thought.id::text=new.record_id and (
      thought.aggregate_id=target_conversation::text or exists (
        select 1 from thought_references reference join events event
          on reference.kind='EVENT' and reference.reference_id=event.id::text
        where reference.thought_id=thought.id and event.aggregate_id=target_conversation::text
      )
    )
  ) then raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID'; end if;
  if new.projection_type='CATALOG_002' and not exists (
    select 1 from thought_claims claim join thought_records thought on thought.id=claim.thought_id
    where claim.thought_id::text||':'||claim.ordinal::text=new.record_id and (
      thought.aggregate_id=target_conversation::text or exists (
        select 1 from thought_references reference join events event
          on reference.kind='EVENT' and reference.reference_id=event.id::text
        where reference.thought_id=thought.id and event.aggregate_id=target_conversation::text
      )
    )
  ) then raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID'; end if;
  if new.projection_type='CATALOG_003' and not exists (
    select 1 from thought_references reference join thought_records thought
      on thought.id=reference.thought_id
    where reference.thought_id::text||':'||reference.role||':'||reference.ordinal::text=new.record_id
      and (thought.aggregate_id=target_conversation::text or (
        reference.kind='EVENT' and exists (
          select 1 from events event where event.id::text=reference.reference_id
            and event.aggregate_id=target_conversation::text
        )
      ))
  ) then raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID'; end if;
  if registered_relation in ('proposal_disclosure_authorizations','proposals',
      'proposal_evidence_links','proposal_status_transitions','proposal_turns',
      'proposal_turn_evidence_links') then
    case registered_relation
      when 'proposal_disclosure_authorizations' then select exists (
        select 1 from proposal_disclosure_authorizations disclosure
        where disclosure.id::text=new.record_id and (
          disclosure.conversation_id=target_conversation or exists (
            select 1 from events source_event
            where disclosure.source_event_ids ? source_event.id::text
              and source_event.aggregate_id=target_conversation::text
          )
        )
      ) into record_is_authorized;
      when 'proposals' then select exists (
        select 1 from proposals proposal where proposal.id::text=new.record_id and (
          proposal.conversation_id=target_conversation or exists (
            select 1 from events source_event
            where proposal.source_event_ids ? source_event.id::text
              and source_event.aggregate_id=target_conversation::text
          )
        )
      ) into record_is_authorized;
      when 'proposal_evidence_links' then select exists (
        select 1 from proposal_evidence_links evidence join proposals proposal
          on proposal.id=evidence.proposal_id
        where evidence.proposal_id=split_part(new.record_id,':',1)::uuid
          and evidence.polarity=split_part(new.record_id,':',2)
          and evidence.ordinal=split_part(new.record_id,':',3)::integer and (
            proposal.conversation_id=target_conversation or exists (
              select 1 from events source_event
              where proposal.source_event_ids ? source_event.id::text
                and source_event.aggregate_id=target_conversation::text
            )
          )
      ) into record_is_authorized;
      when 'proposal_status_transitions' then select exists (
        select 1 from proposal_status_transitions transition join proposals proposal
          on proposal.id=transition.proposal_id
        where transition.id::text=new.record_id and (
          proposal.conversation_id=target_conversation or exists (
            select 1 from events source_event
            where proposal.source_event_ids ? source_event.id::text
              and source_event.aggregate_id=target_conversation::text
          )
        )
      ) into record_is_authorized;
      when 'proposal_turns' then select exists (
        select 1 from proposal_turns turn join proposals proposal on proposal.id=turn.proposal_id
        where turn.id::text=new.record_id and (
          proposal.conversation_id=target_conversation or exists (
            select 1 from events source_event
            where proposal.source_event_ids ? source_event.id::text
              and source_event.aggregate_id=target_conversation::text
          )
        )
      ) into record_is_authorized;
      when 'proposal_turn_evidence_links' then select exists (
        select 1 from proposal_turn_evidence_links evidence join proposal_turns turn
          on turn.id=evidence.turn_id join proposals proposal on proposal.id=turn.proposal_id
        where evidence.turn_id=split_part(new.record_id,':',1)::uuid
          and evidence.ordinal=split_part(new.record_id,':',2)::integer and (
            proposal.conversation_id=target_conversation or exists (
              select 1 from events source_event
              where proposal.source_event_ids ? source_event.id::text
                and source_event.aggregate_id=target_conversation::text
            )
          )
      ) into record_is_authorized;
    end case;
    if not record_is_authorized or new.retained_source_count<>0 then
      raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID';
    end if;
    return new;
  end if;
  if new.projection_type='MEMORY_INDEX' and not exists (
    select 1 from memory_index_terms term
    join memory_records memory on memory.id=term.memory_id
    where term.memory_id::text||':'||term.kind||':'||term.ordinal::text=new.record_id
      and (memory.conversation_id=target_conversation or exists (
        select 1 from memory_sources source join events event on event.id=source.source_event_id
        where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
      ))
  ) then raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID'; end if;
  if new.projection_type='MEMORY_EMBEDDING' and not exists (
    select 1 from memory_embeddings embedding
    join memory_records memory on memory.id=embedding.memory_id
    where embedding.memory_id::text=new.record_id and embedding.active
      and (memory.conversation_id=target_conversation or exists (
        select 1 from memory_sources source join events event on event.id=source.source_event_id
        where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
      ))
  ) then raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID'; end if;
  if new.projection_type='GRAPH_EDGE' and not exists (
    select 1 from memory_graph_edges edge where edge.id::text=new.record_id
      and (edge.conversation_id=target_conversation or exists (
        select 1 from memory_graph_edge_sources source join events event on event.id=source.source_event_id
        where source.edge_id=edge.id and event.aggregate_id=target_conversation::text
      )) and new.retained_source_count=(
        select count(*)::int from memory_graph_edge_sources source
        join events event on event.id=source.source_event_id
        join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
        where source.edge_id=edge.id and event.aggregate_id<>target_conversation::text
      )
  ) then raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID'; end if;
  if new.projection_type in (
    'MEMORY_RECORD','MEMORY_INDEX','MEMORY_EMBEDDING','GRAPH_EDGE',
    'CATALOG_001','CATALOG_002','CATALOG_003'
  ) then return new; end if;
  case new.projection_type
    when 'CONSOLIDATION_RUN' then select exists (
      select 1 from memory_extraction_runs run where run.id::text=new.record_id and (
        run.conversation_id=target_conversation or exists (
          select 1 from events event where event.id=run.source_event_id
            and event.aggregate_id=target_conversation::text
        )
      )
    ) into record_is_authorized;
    when 'MEMORY_SOURCE' then select exists (
      select 1 from memory_sources source join events event on event.id=source.source_event_id
      where source.memory_id=split_part(new.record_id,':',1)::uuid
        and source.ordinal=split_part(new.record_id,':',2)::integer
        and event.aggregate_id=target_conversation::text
    ) into record_is_authorized;
    when 'MEMORY_VECTOR' then select exists (
      select 1 from memory_vector_buckets bucket join memory_records memory on memory.id=bucket.memory_id
      where bucket.memory_id=split_part(new.record_id,':',1)::uuid
        and bucket.ordinal=split_part(new.record_id,':',2)::integer and (
          memory.conversation_id=target_conversation or exists (
            select 1 from memory_sources source join events event on event.id=source.source_event_id
            where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
          )
        )
    ) into record_is_authorized;
    when 'EPISODE_SUMMARY' then select exists (
      select 1 from memory_episodes episode join memory_records memory on memory.id=episode.memory_id
      where episode.memory_id::text=new.record_id and (
        memory.conversation_id=target_conversation or exists (
          select 1 from memory_sources source join events event on event.id=source.source_event_id
          where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
        )
      )
    ) into record_is_authorized;
    when 'DOSSIER_REFRESH' then select exists (
      select 1 from memory_dossier_refreshes dossier join memory_extraction_runs run
        on run.id=dossier.extraction_run_id
      where dossier.extraction_run_id::text=new.record_id and run.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'MEMORY_CHECKPOINT' then select exists (
      select 1 from memory_projection_checkpoints checkpoint
      where checkpoint.projection_key=new.record_id and checkpoint.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'MEMORY_EQUIVALENCE' then select exists (
      select 1 from memory_equivalence_sets equivalence join memory_records memory
        on memory.id=equivalence.canonical_memory_id
      where equivalence.id::text=new.record_id and (
        memory.conversation_id=target_conversation or exists (
          select 1 from memory_sources source join events event on event.id=source.source_event_id
          where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
        )
      )
    ) into record_is_authorized;
    when 'RECALL_TRACE' then select exists (
      select 1 from recall_traces trace where trace.id::text=new.record_id and (
        trace.conversation_id=target_conversation or exists (
          select 1 from recall_trace_sources source join events event on event.id=source.source_event_id
          where source.trace_id=trace.id and event.aggregate_id=target_conversation::text
        )
      )
    ) into record_is_authorized;
    when 'RECALL_TRACE_SOURCE' then select exists (
      select 1 from recall_trace_sources source join events event on event.id=source.source_event_id
      where source.trace_id=split_part(new.record_id,':',1)::uuid
        and source.memory_id=split_part(new.record_id,':',2)::uuid
        and source.ordinal=split_part(new.record_id,':',3)::integer
        and event.aggregate_id=target_conversation::text
    ) into record_is_authorized;
    when 'RECALL_CONTEXT' then select exists (
      select 1 from recall_trace_context_entries context join recall_traces trace on trace.id=context.trace_id
      where context.trace_id=split_part(new.record_id,':',1)::uuid
        and context.ordinal=split_part(new.record_id,':',2)::integer
        and trace.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'GRAPH_NODE' then select exists (
      select 1 from memory_graph_nodes node join memory_records memory on memory.id=node.memory_id
      where node.memory_id::text=new.record_id and (
        memory.conversation_id=target_conversation or exists (
          select 1 from memory_sources source join events event on event.id=source.source_event_id
          where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
        )
      )
    ) into record_is_authorized;
    when 'GRAPH_NODE_SOURCE' then select exists (
      select 1 from memory_graph_node_sources source join events event on event.id=source.source_event_id
      where source.memory_id=split_part(new.record_id,':',1)::uuid
        and source.ordinal=split_part(new.record_id,':',2)::integer
        and event.aggregate_id=target_conversation::text
    ) into record_is_authorized;
    when 'GRAPH_EDGE_SOURCE' then select exists (
      select 1 from memory_graph_edge_sources source join events event on event.id=source.source_event_id
      where source.edge_id=split_part(new.record_id,':',1)::uuid
        and source.ordinal=split_part(new.record_id,':',2)::integer
        and event.aggregate_id=target_conversation::text
    ) into record_is_authorized;
    when 'GRAPH_CURRENT_HEAD' then select exists (
      select 1 from memory_graph_head_versions head join memory_records memory on memory.id=head.memory_id
      where head.id::text=new.record_id and (
        memory.conversation_id=target_conversation or exists (
          select 1 from memory_sources source join events event on event.id=source.source_event_id
          where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
        )
      )
    ) into record_is_authorized;
    when 'GRAPH_CONFLICT' then select exists (
      select 1 from memory_conflicts conflict where conflict.id::text=new.record_id and (
        conflict.conversation_id=target_conversation or exists (
          select 1 from memory_conflict_sources source join events event on event.id=source.source_event_id
          where source.conflict_id=conflict.id and event.aggregate_id=target_conversation::text
        )
      )
    ) into record_is_authorized;
    when 'GRAPH_JOB' then select exists (
      select 1 from memory_graph_background_jobs job
      where job.id::text=new.record_id and job.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'GRAPH_RECONCILIATION' then select exists (
      select 1 from memory_graph_reconciliation_jobs job
      where job.id::text=new.record_id and job.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'HANDOFF_PACKET' then select exists (
      select 1 from handoff_packets packet
      where packet.id::text=new.record_id and packet.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'HANDOFF_CHECKPOINT' then select exists (
      select 1 from handoff_refresh_checkpoints checkpoint
      where checkpoint.id::text=new.record_id and checkpoint.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'HANDOFF_JOB' then select exists (
      select 1 from handoff_refresh_jobs job
      where job.id::text=new.record_id and job.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'CACHE_PROJECTION' then select exists (
      select 1 from cache_projection_versions projection where projection.id::text=new.record_id and (
        projection.entity_id=target_conversation::text or exists (
          select 1 from events event where event.id=projection.source_event_id
            and event.aggregate_id=target_conversation::text
        ) or exists (
          select 1 from cache_projection_jobs job
          left join cache_authority_changes authority on authority.event_id=job.event_id
          left join events event on event.id=job.event_id
          where job.id=projection.job_id and (
            authority.conversation_id=target_conversation
            or event.aggregate_id=target_conversation::text
          )
        )
      )
    ) into record_is_authorized;
    when 'CACHE_JOB' then select exists (
      select 1 from cache_projection_jobs job
      left join cache_authority_changes authority on authority.event_id=job.event_id
      left join events event on event.id=job.event_id
      where job.id::text=new.record_id and (
        authority.conversation_id=target_conversation or event.aggregate_id=target_conversation::text
      )
    ) into record_is_authorized;
    when 'CACHE_AUTHORITY' then select exists (
      select 1 from cache_authority_changes authority
      where authority.event_id::text=new.record_id and authority.conversation_id=target_conversation
    ) into record_is_authorized;
    when 'CHAT_IMPORT' then select exists (
      select 1 from chat_source_imports imported where imported.id::text=new.record_id and (
        exists (select 1 from imported_chat_conversation_versions version
          where version.import_id=imported.id
            and version.imported_conversation_id=target_conversation)
        or exists (select 1 from imported_chat_message_versions version
          where version.import_id=imported.id
            and version.imported_conversation_id=target_conversation)
      )
    ) into record_is_authorized;
    when 'IMPORT_MEMORY' then select exists (
      select 1 from import_memory_projections imported join memory_records memory
        on memory.id=imported.memory_id
      where imported.item_id::text=new.record_id and (
        memory.conversation_id=target_conversation or exists (
          select 1 from memory_sources source join events event on event.id=source.source_event_id
          where source.memory_id=memory.id and event.aggregate_id=target_conversation::text
        )
      )
    ) into record_is_authorized;
    when 'IMPORT_LIFECYCLE' then select exists (
      select 1 from import_item_lifecycle_events lifecycle join events event on event.id=lifecycle.event_id
      where lifecycle.id::text=new.record_id and event.aggregate_id=target_conversation::text
    ) into record_is_authorized;
    else record_is_authorized := false;
  end case;
  if not record_is_authorized then
    raise exception 'PRIVACY_PROJECTION_DEACTIVATION_INVALID';
  end if;
  return new;
end;
$$;
create trigger privacy_projection_deactivation_is_exact
before insert on privacy_projection_deactivations
for each row execute function validate_privacy_projection_deactivation();

create function validate_privacy_projection_rebuild_job() returns trigger language plpgsql as $$
declare target_conversation uuid;
declare expected_sources uuid[];
begin
  select request.conversation_id into target_conversation
  from privacy_forget_requests request where request.id=new.request_id;
  if not exists (
    select 1 from privacy_projection_registry registry
    where registry.projection_type=new.projection_type
      and registry.rebuild_behavior='REBUILD' and registry.rebuild_executor='REBUILD_TYPED'
  ) then raise exception 'PRIVACY_PROJECTION_REBUILD_INVALID'; end if;
  if new.projection_type='MEMORY_RECORD' then
    select coalesce(array_agg(source.source_event_id order by source.ordinal),'{}'::uuid[])
      into expected_sources
    from memory_sources source
    join events event on event.id=source.source_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    where source.memory_id=new.record_id::uuid
      and event.aggregate_id<>target_conversation::text;
  elsif new.projection_type='GRAPH_EDGE' then
    select coalesce(array_agg(source.source_event_id order by source.ordinal),'{}'::uuid[])
      into expected_sources
    from memory_graph_edge_sources source
    join events event on event.id=source.source_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    where source.edge_id=new.record_id::uuid
      and event.aggregate_id<>target_conversation::text;
  else raise exception 'PRIVACY_PROJECTION_REBUILD_INVALID';
  end if;
  if target_conversation is null or new.remaining_source_ids is distinct from expected_sources
     or cardinality(expected_sources)=0 then
    raise exception 'PRIVACY_PROJECTION_REBUILD_INVALID';
  end if;
  return new;
end;
$$;
create trigger privacy_projection_rebuild_job_is_exact
before insert on privacy_projection_rebuild_jobs
for each row execute function validate_privacy_projection_rebuild_job();

create function validate_privacy_projection_rebuild_result() returns trigger language plpgsql as $$
declare job privacy_projection_rebuild_jobs%rowtype;
declare actual_sources uuid[];
begin
  select * into job from privacy_projection_rebuild_jobs where id=new.rebuild_job_id;
  if job.id is null or new.source_manifest is distinct from job.remaining_source_ids then
    raise exception 'PRIVACY_PROJECTION_REBUILD_RESULT_INVALID';
  end if;
  if job.projection_type='MEMORY_RECORD' then
    select array_agg(source.source_event_id order by source.ordinal) into actual_sources
    from memory_records memory
    join memory_sources source on source.memory_id=memory.id
    join encrypted_event_bodies body on body.event_id=memory.body_event_id
      and body.data_key_id is not null
    where memory.id=new.replacement_record_id::uuid
      and memory.scope='PUBLIC' and memory.account_id is null
      and memory.node_brain_id is null and memory.conversation_id is null
      and memory.prompt_version='privacy-rebuild-v1' and memory.model_version='none'
      and memory.extractor_version='privacy-rebuild-v1'
      and memory.created_at>=job.created_at;
  elsif job.projection_type='GRAPH_EDGE' then
    select array_agg(source.source_event_id order by source.ordinal) into actual_sources
    from memory_graph_edges edge
    join memory_graph_run_edges member on member.edge_id=edge.id
    join memory_graph_reconciliation_runs run on run.id=member.reconciliation_run_id
    join memory_graph_edge_sources source on source.edge_id=edge.id
    where edge.id=new.replacement_record_id::uuid and edge.valid_to is null
      and run.reconciler_version='privacy-rebuild-v1' and run.created_at>=job.created_at;
  end if;
  if actual_sources is null
     or cardinality(actual_sources)<>cardinality(job.remaining_source_ids)
     or not (actual_sources<@job.remaining_source_ids and job.remaining_source_ids<@actual_sources) then
    raise exception 'PRIVACY_PROJECTION_REBUILD_RESULT_INVALID';
  end if;
  return new;
end;
$$;
create trigger privacy_projection_rebuild_result_is_exact
before insert on privacy_projection_rebuild_results
for each row execute function validate_privacy_projection_rebuild_result();

create function validate_privacy_projection_rebuild_transition() returns trigger language plpgsql as $$
declare prior privacy_projection_rebuild_job_transitions%rowtype;
declare expected_ordinal integer;
declare expected_type text;
declare target_request uuid;
declare target_account uuid;
begin
  if not exists (
    select 1 from privacy_forget_worker_authorities authority
    where authority.worker_id=new.worker_id and authority.active and not exists (
      select 1 from privacy_forget_worker_revocations revocation
      where revocation.worker_id=authority.worker_id
    )
  ) then raise exception 'PRIVACY_WORKER_FORBIDDEN'; end if;
  select job.request_id,request.account_id into target_request,target_account
  from privacy_projection_rebuild_jobs job
  join privacy_forget_requests request on request.id=job.request_id
  where job.id=new.rebuild_job_id;
  select coalesce(max(transition_ordinal),0)+1 into expected_ordinal
  from privacy_projection_rebuild_job_transitions where rebuild_job_id=new.rebuild_job_id;
  if target_request is null or new.transition_ordinal<>expected_ordinal then
    raise exception 'PRIVACY_PROJECTION_REBUILD_TRANSITION_INVALID';
  end if;
  select * into prior from privacy_projection_rebuild_job_transitions
  where rebuild_job_id=new.rebuild_job_id order by transition_ordinal desc limit 1;
  if new.to_status='CLAIMED' then
    if prior.id is not null and not (
      (prior.to_status='RETRY_SCHEDULED' and prior.retry_at<=clock_timestamp())
      or (prior.to_status='CLAIMED' and prior.lease_until<=clock_timestamp())
    ) then raise exception 'PRIVACY_PROJECTION_REBUILD_NOT_CLAIMABLE'; end if;
  elsif new.to_status in ('COMPLETED','RETRY_SCHEDULED','FAILED') then
    if prior.id is null or prior.to_status<>'CLAIMED' or prior.worker_id<>new.worker_id
       or prior.lease_token is distinct from new.lease_token
       or prior.lease_until<clock_timestamp() then
      raise exception 'PRIVACY_PROJECTION_REBUILD_LEASE_INVALID';
    end if;
  end if;
  if new.to_status='COMPLETED' and not exists (
    select 1 from privacy_projection_rebuild_results result
    where result.rebuild_job_id=new.rebuild_job_id
  ) then raise exception 'PRIVACY_PROJECTION_REBUILD_COMPLETION_INVALID'; end if;
  expected_type := case new.to_status
    when 'CLAIMED' then 'content.forget.rebuild.claimed'
    when 'COMPLETED' then 'content.forget.rebuild.completed'
    when 'RETRY_SCHEDULED' then 'content.forget.rebuild.retry_scheduled'
    else 'content.forget.rebuild.failed' end;
  if not exists (
    select 1 from events event join transactional_outbox outbox on outbox.event_id=event.id
    where event.id=new.event_id and event.aggregate_id='privacy-forget:'||target_request::text
      and event.account_id=target_account::text and event.type=expected_type
      and event.visibility='PRIVATE_ACCOUNT' and event.actor_type='SYSTEM'
      and event.actor_id=new.worker_id and outbox.topic=expected_type
  ) then raise exception 'PRIVACY_PROJECTION_REBUILD_EVENT_INVALID'; end if;
  return new;
end;
$$;
create trigger privacy_projection_rebuild_transition_is_valid
before insert on privacy_projection_rebuild_job_transitions
for each row execute function validate_privacy_projection_rebuild_transition();

create function validate_privacy_legal_authority_revocation() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
    from privacy_legal_authorities target
    join privacy_legal_authorities revoker
      on revoker.id=new.revoker_authority_id and revoker.account_id=target.account_id
    join events event on event.id=new.event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
    where target.id=new.authority_id and target.account_id=new.account_id
      and revoker.account_id=new.account_id and revoker.actor_id=new.revoked_by_actor_id
      and revoker.legal_role='PRIVACY_OFFICER' and revoker.capability=target.capability
      and revoker.active
      and (revoker.expires_at is null or revoker.expires_at>new.revoked_at)
      and not exists (select 1 from privacy_legal_authority_revocations prior
        where prior.authority_id=revoker.id)
      and event.aggregate_id='privacy-legal-authority:'||new.authority_id
      and event.account_id=new.account_id::text
      and event.actor_type='OPERATOR' and event.actor_id=new.revoked_by_actor_id
      and event.type='privacy.legal_authority.revoked'
      and event.visibility='PRIVATE_ACCOUNT' and event.occurred_at=new.revoked_at
      and event.idempotency_key='privacy-legal-revocation:'||new.authority_id
      and event.request_hash=recall_manifest_digest(jsonb_build_object(
        'accountId',new.account_id::text,
        'actor',jsonb_build_object('id',new.revoked_by_actor_id,'type','OPERATOR'),
        'aggregateId','privacy-legal-authority:'||new.authority_id,
        'body',jsonb_build_object('authorityId',new.authority_id,
          'reasonCode',new.reason_code,'revokerAuthorityId',new.revoker_authority_id),
        'causationId',null,'correlationId',null,
        'idempotencyKey','privacy-legal-revocation:'||new.authority_id,
        'modelVersion',null,'occurredAt',null,'policyVersion',null,'promptVersion',null,
        'type','privacy.legal_authority.revoked','visibility','PRIVATE_ACCOUNT'))
      and outbox.topic=event.type
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
  ) then raise exception 'PRIVACY_LEGAL_AUTHORITY_REVOCATION_INVALID'; end if;
  return new;
end;
$$;
create constraint trigger privacy_legal_authority_revocation_is_complete
after insert on privacy_legal_authority_revocations deferrable initially deferred
for each row execute function validate_privacy_legal_authority_revocation();

create function validate_privacy_forget_request_complete() returns trigger language plpgsql as $$
begin
  if new.authority_kind='LEGAL' and exists (
    select 1 from privacy_legal_authority_revocations revocation
    where revocation.authority_id=new.authority_reference
  ) then raise exception 'PRIVACY_FORGET_REQUEST_INVALID'; end if;
  if not exists (
      select 1 from privacy_forget_barriers barrier
      where barrier.request_id=new.id and barrier.account_id=new.account_id
        and barrier.node_brain_id=new.node_brain_id
        and barrier.conversation_id=new.conversation_id
    )
    or exists (select 1 from aggregate_data_keys where aggregate_id=new.conversation_id::text)
    or exists (
      select 1 from proposals proposal
      where proposal.account_id=new.account_id and (
        proposal.conversation_id=new.conversation_id or exists (
          select 1 from events source_event
          where proposal.source_event_ids ? source_event.id::text
            and source_event.account_id=new.account_id::text
            and source_event.aggregate_id=new.conversation_id::text
        )
      ) and not exists (
        select 1 from privacy_erased_aggregate_keys erased
        where erased.request_id=new.id and erased.aggregate_id=proposal.id::text
          and erased.aggregate_kind='PROPOSAL'
      )
    )
    or exists (
      select 1 from proposal_disclosure_authorizations disclosure
      where disclosure.account_id=new.account_id and (
        disclosure.conversation_id=new.conversation_id or exists (
          select 1 from events source_event
          where disclosure.source_event_ids ? source_event.id::text
            and source_event.account_id=new.account_id::text
            and source_event.aggregate_id=new.conversation_id::text
        )
      ) and not exists (
        select 1 from privacy_erased_aggregate_keys erased
        where erased.request_id=new.id and erased.aggregate_id=disclosure.id::text
          and erased.aggregate_kind='PROPOSAL_DISCLOSURE'
      )
    )
    or (select count(*) from privacy_forget_steps where request_id=new.id)
       <> (select count(*) from privacy_projection_registry)
    or exists (
      select 1 from privacy_projection_registry registry
      where not exists (select 1 from privacy_forget_steps step
        where step.request_id=new.id and step.projection_type=registry.projection_type
          and step.ordinal=registry.ordinal)
    )
    or not exists (
      select 1 from events event
      join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
      join transactional_outbox outbox on outbox.event_id=event.id and outbox.topic='content.forgotten'
      join audit_events audit on audit.event_id=event.id
      where event.id=new.event_id and event.aggregate_id='privacy-forget:'||new.id::text
        and event.account_id=new.account_id::text and event.type='content.forgotten'
        and event.visibility='PRIVATE_ACCOUNT' and event.actor_id=new.actor_id
        and event.actor_type=case new.authority_kind
          when 'ACCOUNT_OWNER' then 'USER' else 'OPERATOR' end
        and audit.aggregate_id=new.conversation_id
        and audit.account_id=new.account_id and audit.type='content.forgotten'
        and audit.actor_kind=new.authority_kind and audit.actor_id=new.actor_id
        and audit.metadata=jsonb_build_object('requestId',new.id::text,'status','PENDING')
    )
    or not (
      (new.authority_kind='ACCOUNT_OWNER' and new.actor_id=new.account_id::text and exists (
        select 1 from sessions session where session.id::text=new.authority_reference
          and session.account_id=new.account_id and session.revoked_at is null
          and session.expires_at>new.created_at
      ))
      or (new.authority_kind='LEGAL' and exists (
        select 1 from privacy_legal_authorities authority
        where authority.id=new.authority_reference and authority.account_id=new.account_id
          and authority.actor_id=new.actor_id and authority.legal_role='PRIVACY_OFFICER'
          and authority.capability='FORGET_CONVERSATION' and authority.active
          and (authority.expires_at is null or authority.expires_at>new.created_at)
          and not exists (select 1 from privacy_legal_authority_revocations revocation
            where revocation.authority_id=authority.id)
      ))
    ) then
    raise exception 'PRIVACY_FORGET_REQUEST_INCOMPLETE';
  end if;
  return new;
end;
$$;
create constraint trigger privacy_forget_request_is_complete
after insert on privacy_forget_requests deferrable initially deferred
for each row execute function validate_privacy_forget_request_complete();

create function validate_conversation_archive_command() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from events event
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id and outbox.topic=event.type
    join audit_events audit on audit.event_id=event.id
    where event.id=new.event_id and event.aggregate_id=new.conversation_id::text
      and event.account_id=new.account_id::text and event.visibility='PRIVATE_ACCOUNT'
      and event.actor_type='USER' and event.actor_id=new.account_id::text
      and event.type=case when new.archived then 'conversation.archived' else 'conversation.restored' end
      and audit.aggregate_id=new.conversation_id and audit.account_id=new.account_id
      and audit.type=event.type and audit.actor_kind='ACCOUNT_OWNER'
      and audit.actor_id=new.account_id::text
      and audit.metadata=jsonb_build_object('archived',new.archived)
      and new.authority_kind='ACCOUNT_OWNER' and new.actor_id=new.account_id::text
      and exists (select 1 from sessions session
        where session.id::text=new.authority_reference and session.account_id=new.account_id
          and session.revoked_at is null and session.expires_at>new.created_at)
  ) then raise exception 'CONVERSATION_ARCHIVE_COMMAND_INCOMPLETE'; end if;
  return new;
end;
$$;
create constraint trigger conversation_archive_command_is_complete
after insert on conversation_archive_commands deferrable initially deferred
for each row execute function validate_conversation_archive_command();

create function validate_account_export_snapshot() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from events event
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id and outbox.topic='account.export.started'
    join audit_events audit on audit.event_id=event.id
    where event.id=new.event_id and event.aggregate_id='account-export:'||new.id::text
      and event.account_id=new.account_id::text and event.type='account.export.started'
      and event.visibility='PRIVATE_ACCOUNT'
      and event.idempotency_key='account-export:'||new.id::text
      and event.request_hash=recall_manifest_digest(jsonb_build_object(
        'accountId',new.account_id::text,
        'actor',jsonb_build_object('id',new.actor_id,'type',case new.authority_kind
          when 'ACCOUNT_OWNER' then 'USER' else 'OPERATOR' end),
        'aggregateId','account-export:'||new.id::text,
        'body',jsonb_build_object('accountRecordCount',new.record_count,
          'expiresAt',to_char(new.expires_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'format','gustavo-account-data-export-v1',
          'membershipDigest',new.membership_digest,
          'snapshotId',new.id::text,'sourceHighWater',new.source_high_water),
        'causationId',null,'correlationId',null,
        'idempotencyKey','account-export:'||new.id::text,
        'modelVersion',null,'occurredAt',null,'policyVersion',null,'promptVersion',null,
        'type','account.export.started','visibility','PRIVATE_ACCOUNT'))
      and not exists (select 1 from account_export_snapshot_records record
        where record.snapshot_id=new.id and record.source_sequence>=event.ingested_sequence)
      and event.actor_id=audit.actor_id
      and audit.aggregate_id=new.id and audit.account_id=new.account_id
      and audit.type='account.export.started'
      and audit.actor_kind=case event.actor_type
        when 'USER' then 'ACCOUNT_OWNER' when 'OPERATOR' then 'LEGAL' else 'SYSTEM' end
      and audit.metadata=jsonb_build_object('snapshotId',new.id::text,
        'accountRecordCount',new.record_count,'sourceHighWater',new.source_high_water,
        'membershipDigest',new.membership_digest,
        'expiresAt',to_char(new.expires_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'format','gustavo-account-data-export-v1')
      and new.actor_id=event.actor_id and new.authority_kind=audit.actor_kind
      and (
        (new.authority_kind='ACCOUNT_OWNER' and new.actor_id=new.account_id::text and exists (
          select 1 from sessions session where session.id::text=new.authority_reference
            and session.account_id=new.account_id and session.revoked_at is null
            and session.expires_at>new.created_at
        ))
        or (new.authority_kind='LEGAL' and exists (
          select 1 from privacy_legal_authorities authority
          where authority.id=new.authority_reference and authority.account_id=new.account_id
            and authority.actor_id=new.actor_id and authority.legal_role='PRIVACY_OFFICER'
            and authority.capability='EXPORT_DATA' and authority.active
            and (authority.expires_at is null or authority.expires_at>new.created_at)
            and not exists (select 1 from privacy_legal_authority_revocations revocation
              where revocation.authority_id=authority.id)
        ))
      )
  ) then raise exception 'ACCOUNT_EXPORT_SNAPSHOT_INCOMPLETE'; end if;
  if (select count(*) from account_export_snapshot_records record
      where record.snapshot_id=new.id)<>new.record_count
    or exists (
      select 1 from account_export_snapshot_records record
      where record.snapshot_id=new.id
      group by record.snapshot_id
      having min(record.ordinal)<>1 or max(record.ordinal)<>new.record_count
    ) then raise exception 'ACCOUNT_EXPORT_SNAPSHOT_MEMBERSHIP_INVALID'; end if;
  if exists (
    with eligible as (
      select event.id event_id,event.ingested_sequence source_sequence,false tombstone
      from events event join transactional_outbox outbox on outbox.event_id=event.id
      where event.account_id=new.account_id::text and event.id<>new.event_id
        and event.visibility='PRIVATE_ACCOUNT'
        and event.type not in ('content.forgotten','account.export.started')
        and event.type !~* '(^|\.)(order|trade|fill|position|execution)(\.|$)'
        and not exists (select 1 from privacy_forget_barriers barrier
          where barrier.conversation_id::text=event.aggregate_id)
        and not exists (select 1 from privacy_erased_aggregate_keys erased
          where erased.aggregate_id=event.aggregate_id)
        and not exists (
          select 1 from thought_records thought
          join privacy_projection_deactivations deactivation
            on deactivation.projection_type='CATALOG_001'
           and deactivation.record_id=thought.id::text
          where thought.event_id=event.id
        )
        and not exists (
          select 1 from memory_records memory
          join privacy_projection_deactivations deactivation
            on deactivation.projection_type='MEMORY_RECORD'
           and deactivation.record_id=memory.id::text
          where memory.body_event_id=event.id
        )
        and not exists (
          select 1 from recall_traces trace
          join privacy_projection_deactivations deactivation
            on deactivation.projection_type='RECALL_TRACE'
           and deactivation.record_id=trace.id::text
          where trace.event_id=event.id
        )
      union all
      select event.id,event.ingested_sequence,true
      from audit_events audit join events event on event.id=audit.event_id
      where audit.account_id=new.account_id and audit.type='content.forgotten'
        and event.id<>new.event_id
    )
    select 1 from (
      (select eligible.event_id,eligible.source_sequence,eligible.tombstone
       from eligible
       except
       select record.event_id,record.source_sequence,record.tombstone
       from account_export_snapshot_records record where record.snapshot_id=new.id)
      union all
      (select record.event_id,record.source_sequence,record.tombstone
       from account_export_snapshot_records record where record.snapshot_id=new.id
       except
       select eligible.event_id,eligible.source_sequence,eligible.tombstone from eligible)
    ) difference
  ) then raise exception 'ACCOUNT_EXPORT_SNAPSHOT_MEMBERSHIP_INVALID'; end if;
  if new.expires_at<=new.created_at
    or new.source_high_water is distinct from (
      select recall_manifest_digest(coalesce((
        select jsonb_build_object('eventId',record.event_id::text,
          'sourceSequence',record.source_sequence::text)
        from account_export_snapshot_records record where record.snapshot_id=new.id
        order by record.source_sequence desc,record.event_id desc limit 1
      ),'{}'::jsonb))
    )
    or new.membership_digest is distinct from (
      select recall_manifest_digest(coalesce(jsonb_agg(jsonb_build_object(
        'eventId',record.event_id::text,'sourceSequence',record.source_sequence::text,
        'tombstone',record.tombstone
      ) order by record.source_sequence,record.event_id),'[]'::jsonb))
      from account_export_snapshot_records record where record.snapshot_id=new.id
    ) then raise exception 'ACCOUNT_EXPORT_SNAPSHOT_ROOT_INVALID'; end if;
  return new;
end;
$$;
create constraint trigger account_export_snapshot_is_complete
after insert on account_export_snapshots deferrable initially deferred
for each row execute function validate_account_export_snapshot();

create function validate_privacy_forget_transition() returns trigger language plpgsql as $$
declare prior privacy_forget_step_transitions%rowtype;
declare expected_ordinal integer;
declare actual_count integer;
declare expected_type text;
begin
  if not exists (
    select 1 from privacy_forget_worker_authorities authority
    where authority.worker_id=new.worker_id and authority.active and not exists (
      select 1 from privacy_forget_worker_revocations revocation
      where revocation.worker_id=authority.worker_id
    )
  ) then raise exception 'PRIVACY_WORKER_FORBIDDEN'; end if;
  select coalesce(max(transition_ordinal),0)+1 into expected_ordinal
  from privacy_forget_step_transitions
  where request_id=new.request_id and projection_type=new.projection_type;
  if new.transition_ordinal<>expected_ordinal then
    raise exception 'PRIVACY_FORGET_TRANSITION_ORDINAL_INVALID';
  end if;
  select * into prior from privacy_forget_step_transitions
  where request_id=new.request_id and projection_type=new.projection_type
  order by transition_ordinal desc limit 1;
  if new.to_status='CLAIMED' then
    if prior.id is not null and not (
      (prior.to_status='RETRY_SCHEDULED' and prior.retry_at<=clock_timestamp())
      or (prior.to_status='CLAIMED' and prior.lease_until<=clock_timestamp())
    ) then raise exception 'PRIVACY_FORGET_STEP_NOT_CLAIMABLE'; end if;
  elsif new.to_status in ('COMPLETED','RETRY_SCHEDULED','FAILED') then
    if prior.id is null or prior.to_status<>'CLAIMED' or prior.worker_id<>new.worker_id
       or prior.lease_token is distinct from new.lease_token
       or prior.lease_until<clock_timestamp() then
      raise exception 'PRIVACY_FORGET_STEP_LEASE_INVALID';
    end if;
  end if;
  if new.to_status='COMPLETED' then
    select count(*)::int into actual_count from privacy_projection_deactivations
    where request_id=new.request_id and projection_type=new.projection_type;
    if actual_count<>new.affected_count then
      raise exception 'PRIVACY_FORGET_STEP_COMPLETION_INVALID';
    end if;
  end if;
  expected_type := case new.to_status
    when 'CLAIMED' then 'content.forget.step.claimed'
    when 'COMPLETED' then 'content.forget.step.completed'
    when 'RETRY_SCHEDULED' then 'content.forget.step.retry_scheduled'
    else 'content.forget.step.failed' end;
  if not exists (
    select 1 from events event join transactional_outbox outbox on outbox.event_id=event.id
    join privacy_forget_requests request on request.id=new.request_id
    where event.id=new.event_id and event.aggregate_id='privacy-forget:'||new.request_id::text
      and event.account_id=request.account_id::text and event.type=expected_type
      and event.visibility='PRIVATE_ACCOUNT' and event.actor_type='SYSTEM'
      and event.actor_id=new.worker_id and outbox.topic=expected_type
  ) then raise exception 'PRIVACY_FORGET_TRANSITION_EVENT_INVALID'; end if;
  return new;
end;
$$;
create trigger privacy_forget_transition_is_valid
before insert on privacy_forget_step_transitions
for each row execute function validate_privacy_forget_transition();

create function prevent_forgotten_key_recreation() returns trigger language plpgsql as $$
begin
  if exists (select 1 from privacy_forget_barriers where conversation_id::text=new.aggregate_id)
     or exists (select 1 from privacy_erased_aggregate_keys
                where aggregate_id=new.aggregate_id) then
    raise exception 'FORGOTTEN_AGGREGATE_KEY_CANNOT_BE_RECREATED';
  end if;
  return new;
end;
$$;
create trigger forgotten_aggregate_key_cannot_be_recreated
before insert or update of aggregate_id on aggregate_data_keys
for each row execute function prevent_forgotten_key_recreation();

create function protect_conversation_privacy_lifecycle() returns trigger language plpgsql as $$
begin
  if old.status=new.status then return new; end if;
  if new.status='OPEN' and exists (
    select 1 from privacy_forget_barriers where conversation_id=old.id
  ) then raise exception 'FORGOTTEN_CONVERSATION_CANNOT_BE_RESTORED'; end if;
  return new;
end;
$$;
create trigger conversation_privacy_lifecycle_is_authorized
before update of status on conversations
for each row execute function protect_conversation_privacy_lifecycle();

create or replace function reject_memory_mutation() returns trigger
language plpgsql as $$
begin
  if tg_table_name='memory_index_terms' then
    if tg_op='DELETE' and exists (
      select 1 from privacy_projection_deactivations deactivation
      where deactivation.projection_type='MEMORY_INDEX'
        and deactivation.record_id=old.memory_id::text||':'||old.kind||':'||old.ordinal::text
    ) then return old; end if;
  end if;
  raise exception '%', case tg_table_name
    when 'memory_records' then 'IMMUTABLE_MEMORY_RECORD'
    when 'memory_sources' then 'IMMUTABLE_MEMORY_SOURCE'
    when 'memory_extraction_runs' then 'IMMUTABLE_MEMORY_EXTRACTION_RUN'
    else 'IMMUTABLE_MEMORY_PROJECTION'
  end;
end;
$$;

create or replace function reject_recall_mutation() returns trigger language plpgsql as $$
begin
  if tg_table_name='memory_graph_edges' then
    if tg_op='UPDATE' and old.valid_to is null and new.valid_to is not null
       and (to_jsonb(old)-'valid_to')=(to_jsonb(new)-'valid_to')
       and exists (
         select 1 from privacy_projection_deactivations deactivation
         where deactivation.projection_type='GRAPH_EDGE'
           and deactivation.record_id=old.id::text
       ) then return new; end if;
  end if;
  raise exception 'IMMUTABLE_RECALL_TRACE';
end;
$$;
