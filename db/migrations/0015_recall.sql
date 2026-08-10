create function recall_text_array_is_set(candidate text[],maximum integer)
returns boolean language sql immutable strict parallel safe as $$
  select cardinality(candidate) between 1 and maximum
    and not exists (select 1 from unnest(candidate) item(value) where value is null)
    and cardinality(candidate)=(select count(distinct value) from unnest(candidate) item(value));
$$;

create table recall_actor_authorities (
  role text not null check (role in ('MAIN_BRAIN','SYSTEM','OPERATOR')),
  actor_id text not null check (length(trim(actor_id)) between 1 and 128),
  scopes text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  primary key (role,actor_id),
  check (cardinality(scopes) between 1 and 6),
  check (scopes <@ array[
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  ]::text[]),
  check (recall_text_array_is_set(scopes,6)),
  check (role<>'MAIN_BRAIN' or (
    actor_id='gustavo-main' and scopes=array['CHALLENGE_SHARED','MAIN_SHARED','PUBLIC']::text[]
  )),
  check (role not in ('SYSTEM','OPERATOR')
    or not scopes && array['PRIVATE_ACCOUNT','NODE_BRANCH']::text[])
);

insert into recall_actor_authorities (role,actor_id,scopes)
values ('MAIN_BRAIN','gustavo-main',array['CHALLENGE_SHARED','MAIN_SHARED','PUBLIC']::text[]);

create index recall_public_term_fts_idx on memory_index_terms
  using gin (to_tsvector('simple',term_text))
  where scope='PUBLIC' and kind='KEYWORD';
create index recall_protected_term_digest_idx on memory_index_terms
  (kind,term_digest,memory_id) where scope<>'PUBLIC';
create index recall_memory_recent_idx on memory_records (scope,created_at desc,id);
create index recall_memory_vector_preselect_idx
  on memory_records (scope,embedding_version,importance desc,created_at desc,id)
  where has_embedding and conflict_state<>'SUPERSEDED';
create index recall_memory_body_siblings_idx on memory_records (body_event_id,id);
create index memory_vector_backfill_scan_idx
  on memory_records (scope,embedding_version,id)
  where has_embedding and scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH');
create index memory_vector_private_backfill_scan_idx
  on memory_records (
    scope,account_id,node_brain_id,conversation_id,embedding_version,id
  ) where has_embedding and scope in ('PRIVATE_ACCOUNT','NODE_BRANCH');
create index recall_message_recent_idx on messages (conversation_id,occurred_at desc,event_id desc);
create index recall_node_route_recent_idx
  on events (aggregate_id,ingested_sequence desc,id) where type='node.reply.routed';
create index recall_challenge_current_idx
  on challenge_ledger_events (occurred_at desc,sequence desc,id);
create index recall_challenge_stage_current_idx
  on challenge_stages (ordinal desc,created_at desc,id);
create index recall_proposal_sources_gin_idx on proposals using gin (source_event_ids);

alter table encrypted_event_bodies add column body_digest char(64)
  check (body_digest is null or body_digest ~ '^[a-f0-9]{64}$');
create unique index encrypted_event_bodies_event_digest_idx
  on encrypted_event_bodies (event_id,body_digest);

create table memory_vector_buckets (
  memory_id uuid not null references memory_records(id),
  ordinal integer not null check (ordinal between 0 and 5),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  search_key_id uuid references aggregate_data_keys(id) on delete cascade,
  body_key_id uuid not null references aggregate_data_keys(id) on delete cascade,
  embedding_version text not null check (length(trim(embedding_version)) between 1 and 200),
  bucket_digest char(64) not null check (bucket_digest ~ '^[a-f0-9]{64}$'),
  primary key (memory_id,ordinal),
  unique (memory_id,bucket_digest),
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  check (
    (scope='PUBLIC' and search_key_id is null and account_id is null
      and node_brain_id is null and conversation_id is null)
    or (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and search_key_id is not null
      and account_id is not null and node_brain_id is not null and conversation_id is not null)
    or (scope in ('MAIN_SHARED','CHALLENGE_SHARED','AUDIT_ONLY') and search_key_id is not null
      and account_id is null and node_brain_id is null and conversation_id is null)
  )
);
create index memory_vector_buckets_lookup_idx
  on memory_vector_buckets (embedding_version,bucket_digest,scope,memory_id);

create table memory_vector_backfill_checkpoints (
  id bigint generated always as identity primary key,
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid references accounts(id),
  node_brain_id uuid,
  conversation_id uuid,
  embedding_version text not null check (length(trim(embedding_version)) between 1 and 200),
  last_memory_id uuid,
  scanned_count bigint not null default 0 check (scanned_count>=0),
  completed boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique nulls not distinct (
    scope,account_id,node_brain_id,conversation_id,embedding_version
  ),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);

create function validate_memory_vector_bucket() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_records memory
    join encrypted_event_bodies body on body.event_id=memory.body_event_id
      and body.data_key_id=new.body_key_id
    join aggregate_data_keys body_key on body_key.id=new.body_key_id
    left join aggregate_data_keys search_key on search_key.id=new.search_key_id
    where memory.id=new.memory_id and memory.has_embedding
      and memory.scope=new.scope and memory.account_id is not distinct from new.account_id
      and memory.node_brain_id is not distinct from new.node_brain_id
      and memory.conversation_id is not distinct from new.conversation_id
      and memory.search_key_id is not distinct from new.search_key_id
      and memory.embedding_version=new.embedding_version
      and (memory.scope='PUBLIC' or search_key.id is not null)
  ) then raise exception 'MEMORY_VECTOR_BUCKET_AUTHORITY_MISMATCH'; end if;
  return new;
end;
$$;
create trigger memory_vector_bucket_is_consistent before insert on memory_vector_buckets
for each row execute function validate_memory_vector_bucket();

create function reject_memory_vector_bucket_update() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_MEMORY_VECTOR_BUCKET';
end;
$$;
create trigger memory_vector_buckets_are_immutable before update on memory_vector_buckets
for each row execute function reject_memory_vector_bucket_update();

create function validate_memory_vector_bucket_run() returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from memory_records memory where memory.extraction_run_id=new.id
      and ((memory.has_embedding and (select count(*) from memory_vector_buckets bucket
        where bucket.memory_id=memory.id)<>6)
        or (not memory.has_embedding and exists (
          select 1 from memory_vector_buckets bucket where bucket.memory_id=memory.id)))
  ) then raise exception 'MEMORY_VECTOR_BUCKET_COMPLETENESS_MISMATCH'; end if;
  return new;
end;
$$;
create constraint trigger memory_vector_bucket_run_is_complete
after insert on memory_extraction_runs deferrable initially deferred
for each row execute function validate_memory_vector_bucket_run();

create table memory_graph_edges (
  id uuid primary key,
  source_memory_id uuid not null references memory_records(id),
  target_memory_id uuid not null references memory_records(id),
  type text not null check (type in (
    'MENTIONS','SUPPORTS','CONTRADICTS','SUPERSEDES','DERIVED_FROM','PROPOSED_BY',
    'ACCEPTED_INTO','AFFECTED','RESULTED_IN','SIMILAR_TO','PART_OF'
  )),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  valid_from timestamptz not null,
  valid_to timestamptz,
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique (source_memory_id,target_memory_id,type,valid_from),
  check (source_memory_id<>target_memory_id),
  check (valid_to is null or valid_to>valid_from),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);
create index memory_graph_edges_source_idx
  on memory_graph_edges (scope,account_id,node_brain_id,conversation_id,source_memory_id,type,valid_from desc)
  where valid_to is null;
create index memory_graph_edges_target_idx
  on memory_graph_edges (scope,account_id,node_brain_id,conversation_id,target_memory_id,type,valid_from desc)
  where valid_to is null;
create index recall_graph_source_adjacency_idx
  on memory_graph_edges (source_memory_id,target_memory_id,type,valid_from desc)
  where valid_to is null;
create index recall_graph_target_adjacency_idx
  on memory_graph_edges (target_memory_id,source_memory_id,type,valid_from desc)
  where valid_to is null;
create index recall_equivalence_reverse_idx
  on memory_equivalence_links (equivalent_memory_id,memory_id);

create function validate_memory_graph_edge() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_records source
    join memory_records target on target.id=new.target_memory_id
    where source.id=new.source_memory_id
      and source.scope=new.scope and target.scope=new.scope
      and source.account_id is not distinct from new.account_id
      and target.account_id is not distinct from new.account_id
      and source.node_brain_id is not distinct from new.node_brain_id
      and target.node_brain_id is not distinct from new.node_brain_id
      and source.conversation_id is not distinct from new.conversation_id
      and target.conversation_id is not distinct from new.conversation_id
  ) then raise exception 'MEMORY_GRAPH_EDGE_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_edge_is_consistent before insert on memory_graph_edges
for each row execute function validate_memory_graph_edge();

create table recall_traces (
  id uuid primary key,
  event_id uuid not null unique references encrypted_event_bodies(event_id),
  response_id uuid not null,
  actor_role text not null check (actor_role in ('MAIN_BRAIN','ACCOUNT','SYSTEM','OPERATOR')),
  actor_id text not null check (length(trim(actor_id)) between 1 and 128),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  purpose text check (purpose is null or length(trim(purpose)) between 1 and 256),
  authorized_scopes text[] not null,
  query_digest char(64) not null check (query_digest ~ '^[a-f0-9]{64}$'),
  query_plan jsonb not null check (jsonb_typeof(query_plan)='array'),
  authorized_candidate_ids jsonb not null check (jsonb_typeof(authorized_candidate_ids)='array'),
  exclusions jsonb not null check (jsonb_typeof(exclusions)='array'),
  selected_memory_ids jsonb not null check (jsonb_typeof(selected_memory_ids)='array'),
  selected_source_ids jsonb not null check (jsonb_typeof(selected_source_ids)='array'),
  cache_use text not null check (cache_use in ('BYPASS','HIT','MISS')),
  latency_ms numeric(12,3) not null check (latency_ms>=0),
  policy_version text not null check (length(trim(policy_version)) between 1 and 200),
  model_version text not null check (length(trim(model_version)) between 1 and 200),
  planner_version text not null check (length(trim(planner_version)) between 1 and 200),
  state_versions jsonb not null check (jsonb_typeof(state_versions)='object'),
  high_water_sequence bigint not null check (high_water_sequence>=0),
  idempotency_key text not null check (length(idempotency_key) between 1 and 240),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  body_authority_manifest jsonb not null check (jsonb_typeof(body_authority_manifest)='object'),
  body_authority_digest char(64) not null check (body_authority_digest ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  candidate_authority jsonb not null check (jsonb_typeof(candidate_authority)='array'),
  context_entries jsonb not null check (jsonb_typeof(context_entries)='array'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  outbox_payload_digest char(64) not null check (outbox_payload_digest ~ '^[a-f0-9]{64}$'),
  source_high_water_sequence bigint not null check (source_high_water_sequence>=0),
  created_at timestamptz not null,
  foreign key (event_id,body_digest) references encrypted_event_bodies(event_id,body_digest),
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique nulls not distinct (actor_role,actor_id,account_id,idempotency_key),
  check (cardinality(authorized_scopes) between 1 and 6),
  check (authorized_scopes <@ array[
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  ]::text[]),
  check (recall_text_array_is_set(authorized_scopes,6)),
  check (
    (actor_role='ACCOUNT' and actor_id=account_id::text and account_id is not null
      and node_brain_id is not null and conversation_id is not null and purpose is null
      and authorized_scopes=array[
        'CHALLENGE_SHARED','MAIN_SHARED','NODE_BRANCH','PRIVATE_ACCOUNT','PUBLIC'
      ]::text[])
    or (actor_role='MAIN_BRAIN' and actor_id='gustavo-main' and account_id is null
      and node_brain_id is null and conversation_id is null and purpose is null
      and authorized_scopes=array['CHALLENGE_SHARED','MAIN_SHARED','PUBLIC']::text[])
    or (actor_role in ('SYSTEM','OPERATOR') and account_id is null
      and node_brain_id is null and conversation_id is null and purpose is not null)
  )
);
create index recall_traces_actor_created_idx
  on recall_traces (actor_role,actor_id,account_id,created_at desc,id);
create index recall_traces_response_idx on recall_traces (response_id,created_at desc,id);

create function recall_state_versions_are_valid(value jsonb)
returns boolean language sql immutable strict parallel safe as $$
  select value ?& array['main','challenge','node']
    and (select count(*) from jsonb_object_keys(value))=3
    and not exists (
      select 1 from jsonb_each(value) item(key,candidate)
      where jsonb_typeof(candidate) not in ('string','null')
        or (jsonb_typeof(candidate)='string' and length(trim(candidate #>> '{}')) not between 1 and 200)
    );
$$;
alter table recall_traces add constraint recall_state_versions_valid
  check (recall_state_versions_are_valid(state_versions));

create table recall_trace_plan_steps (
  trace_id uuid not null references recall_traces(id),
  ordinal integer not null check (ordinal between 0 and 8),
  kind text not null check (kind in (
    'CURRENT_STATE','RECENT','ENTITY','TIME','FULL_TEXT','VECTOR','GRAPH','PROCEDURE','GOAL'
  )),
  result_limit integer not null check (result_limit between 1 and 20),
  graph_depth integer not null check (graph_depth between 0 and 2),
  primary key (trace_id,ordinal),
  unique (trace_id,kind),
  check ((kind='GRAPH')=(graph_depth>0))
);

create table recall_trace_candidates (
  trace_id uuid not null references recall_traces(id),
  memory_id uuid not null references memory_records(id),
  ordinal integer not null check (ordinal between 0 and 99),
  decision text not null check (decision in ('SELECTED','EXCLUDED')),
  selected_ordinal integer check (selected_ordinal between 0 and 23),
  channels text[] not null check (cardinality(channels) between 1 and 9),
  score numeric(10,9) not null check (score between 0 and 1),
  exclusion_reason text check (exclusion_reason in (
    'SCOPE_FORBIDDEN','SOURCE_EQUIVALENT','RESULT_LIMIT','TOKEN_LIMIT','SOURCE_ERASED'
  )),
  primary key (trace_id,memory_id),
  unique (trace_id,ordinal),
  unique (trace_id,selected_ordinal),
  check (
    (decision='SELECTED' and selected_ordinal is not null and exclusion_reason is null)
    or (decision='EXCLUDED' and selected_ordinal is null and exclusion_reason is not null)
  )
);
create index recall_trace_candidates_memory_idx on recall_trace_candidates (memory_id,trace_id);

create table recall_trace_sources (
  trace_id uuid not null,
  memory_id uuid not null,
  source_event_id uuid not null references events(id),
  ordinal integer not null check (ordinal between 0 and 499),
  primary key (trace_id,memory_id,source_event_id),
  unique (trace_id,memory_id,ordinal),
  foreign key (trace_id,memory_id) references recall_trace_candidates(trace_id,memory_id)
);
create index recall_trace_sources_event_idx on recall_trace_sources (source_event_id,trace_id);

create table recall_trace_context_entries (
  trace_id uuid not null references recall_traces(id),
  ordinal integer not null check (ordinal between 0 and 10),
  kind text not null check (kind in ('MAIN_STATE','NODE_STATE','CHALLENGE_STATE','RECENT_TURN')),
  source_id uuid not null,
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  version text check (version is null or length(trim(version)) between 1 and 200),
  content_kind text not null check (content_kind in ('ORIGINAL_EVENT','CANONICAL_STATE')),
  excerpt_digest char(64) not null check (excerpt_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  primary key (trace_id,ordinal),
  unique (trace_id,kind,source_id)
);
create index recall_trace_context_source_idx
  on recall_trace_context_entries (source_id,trace_id);

create function recall_uuid_json_array(value jsonb,maximum integer)
returns boolean language sql immutable strict parallel safe as $$
  select jsonb_typeof(value)='array' and jsonb_array_length(value) between 0 and maximum
    and not exists (
      select 1 from jsonb_array_elements_text(value) item(value)
      where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    and jsonb_array_length(value)=(select count(distinct item) from jsonb_array_elements_text(value) item);
$$;
alter table recall_traces add constraint recall_authorized_candidate_ids_valid
  check (recall_uuid_json_array(authorized_candidate_ids,100));
alter table recall_traces add constraint recall_selected_memory_ids_valid
  check (recall_uuid_json_array(selected_memory_ids,24));
alter table recall_traces add constraint recall_selected_source_ids_valid
  check (recall_uuid_json_array(selected_source_ids,12000));

create function recall_channels_are_valid(value text[])
returns boolean language sql immutable strict parallel safe as $$
  select recall_text_array_is_set(value,9) and value <@ array[
    'CURRENT_STATE','RECENT','ENTITY','TIME','FULL_TEXT','VECTOR','GRAPH','PROCEDURE','GOAL'
  ]::text[];
$$;
alter table recall_trace_candidates add constraint recall_trace_channels_valid
  check (recall_channels_are_valid(channels) and channels <@ array[
    'CURRENT_STATE','RECENT','ENTITY','TIME','FULL_TEXT','VECTOR','GRAPH','PROCEDURE','GOAL'
  ]::text[]);

create function recall_candidate_authority_is_valid(value jsonb)
returns boolean language sql immutable strict parallel safe as $$
  select jsonb_typeof(value)='array' and jsonb_array_length(value) between 0 and 100
    and not exists (
      select 1 from jsonb_array_elements(value) item
      where (select count(*) from jsonb_object_keys(item))<>4
        or jsonb_typeof(item->'id')<>'string'
        or (item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or jsonb_typeof(item->'scope')<>'string'
        or item->>'scope' not in (
          'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
        )
        or jsonb_typeof(item->'channels')<>'array'
        or not recall_channels_are_valid(array(
          select jsonb_array_elements_text(item->'channels') order by 1
        ))
        or jsonb_typeof(item->'score')<>'number'
        or (item->>'score')::numeric not between 0 and 1
    )
    and jsonb_array_length(value)=(select count(distinct item->>'id')
      from jsonb_array_elements(value) item);
$$;

create function recall_context_authority_is_valid(value jsonb)
returns boolean language sql immutable strict parallel safe as $$
  select jsonb_typeof(value)='array' and jsonb_array_length(value) between 0 and 11
    and not exists (
      select 1 from jsonb_array_elements(value) item
      where (select count(*) from jsonb_object_keys(item))<>8
        or item->>'kind' not in ('MAIN_STATE','NODE_STATE','CHALLENGE_STATE','RECENT_TURN')
        or (item->>'sourceId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or item->>'scope' not in (
          'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
        )
        or item->>'contentKind' not in ('ORIGINAL_EVENT','CANONICAL_STATE')
        or jsonb_typeof(item->'version') not in ('string','null')
        or (jsonb_typeof(item->'version')='string'
          and length(trim(item->>'version')) not between 1 and 200)
        or (item->>'excerptDigest') !~ '^[a-f0-9]{64}$'
        or jsonb_typeof(item->'createdAt')<>'string'
        or (item->>'ordinal')::integer not between 0 and 10
    );
$$;

alter table recall_traces add constraint recall_candidate_authority_valid
  check (recall_candidate_authority_is_valid(candidate_authority));
alter table recall_traces add constraint recall_context_authority_valid
  check (recall_context_authority_is_valid(context_entries));

create function recall_candidate_is_authorized(trace recall_traces,memory memory_records)
returns boolean language sql stable strict as $$
  select case trace.actor_role
    when 'ACCOUNT' then
      memory.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
      or (memory.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
        and memory.account_id=trace.account_id and memory.node_brain_id=trace.node_brain_id
        and memory.conversation_id=trace.conversation_id)
    when 'MAIN_BRAIN' then
      memory.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
      or (memory.scope='PRIVATE_ACCOUNT' and exists (
        select 1 from proposals proposal
        join proposal_status_transitions status on status.proposal_id=proposal.id
        left join proposal_disclosure_revocations revoked
          on revoked.authorization_id=proposal.disclosure_authorization_id
        left join proposal_disclosure_authorizations disclosure
          on disclosure.id=proposal.disclosure_authorization_id
        where status.ordinal=(select max(latest.ordinal) from proposal_status_transitions latest
            where latest.proposal_id=proposal.id)
          and status.to_status not in ('WITHDRAWN','REJECTED')
          and proposal.privacy_scope='PROPOSAL_RAW_TEXT'
          and revoked.authorization_id is null
          and disclosure.expires_at>trace.created_at
          and not exists (
            select 1 from memory_sources source where source.memory_id=memory.id
              and not (proposal.source_event_ids ? source.source_event_id::text)
          )
      ))
    else memory.scope=any(trace.authorized_scopes)
  end;
$$;

create function recall_trace_manifest_is_valid(trace recall_traces)
returns boolean language sql stable strict as $$
  select (select count(*) from jsonb_object_keys(trace.body_authority_manifest))=27
    and trace.body_authority_manifest->>'traceId'=trace.id::text
    and trace.body_authority_manifest->>'responseId'=trace.response_id::text
    and trace.body_authority_manifest->>'actorRole'=trace.actor_role
    and trace.body_authority_manifest->>'actorId'=trace.actor_id
    and (trace.body_authority_manifest->>'accountId') is not distinct from trace.account_id::text
    and (trace.body_authority_manifest->>'nodeBrainId') is not distinct from trace.node_brain_id::text
    and (trace.body_authority_manifest->>'conversationId') is not distinct from trace.conversation_id::text
    and (trace.body_authority_manifest->>'purpose') is not distinct from trace.purpose
    and trace.body_authority_manifest->'authorizedScopes'=to_jsonb(trace.authorized_scopes)
    and trace.body_authority_manifest->>'queryDigest'=trace.query_digest
    and trace.body_authority_manifest->'queryPlan'=trace.query_plan
    and trace.body_authority_manifest->'authorizedCandidateIds'=trace.authorized_candidate_ids
    and trace.body_authority_manifest->'authorizedCandidates'=trace.candidate_authority
    and trace.body_authority_manifest->'contextEntries'=trace.context_entries
    and trace.body_authority_manifest->'exclusions'=trace.exclusions
    and trace.body_authority_manifest->'selectedMemoryIds'=trace.selected_memory_ids
    and trace.body_authority_manifest->'selectedSourceIds'=trace.selected_source_ids
    and trace.body_authority_manifest->>'cacheUse'=trace.cache_use
    and (trace.body_authority_manifest->>'latencyMilliseconds')::numeric=trace.latency_ms
    and trace.body_authority_manifest->>'policyVersion'=trace.policy_version
    and trace.body_authority_manifest->>'modelVersion'=trace.model_version
    and trace.body_authority_manifest->>'plannerVersion'=trace.planner_version
    and trace.body_authority_manifest->'stateVersions'=trace.state_versions
    and (trace.body_authority_manifest->>'highWaterSequence')::bigint=trace.high_water_sequence
    and (trace.body_authority_manifest->>'sourceHighWaterSequence')::bigint=trace.source_high_water_sequence
    and trace.body_authority_manifest->>'requestDigest'=trace.request_digest
    and (trace.body_authority_manifest->>'createdAt')::timestamptz=trace.created_at;
$$;

create function recall_canonical_json(value jsonb)
returns text language plpgsql immutable strict parallel safe as $$
declare kind text := jsonb_typeof(value);
begin
  if kind='object' then
    return concat('{',coalesce((
      select string_agg(to_jsonb(item.key)::text||':'||recall_canonical_json(item.value),','
        order by item.key collate "C") from jsonb_each(value) item
    ),''),'}');
  end if;
  if kind='array' then
    return concat('[',coalesce((
      select string_agg(recall_canonical_json(item.value),',' order by item.ordinal)
      from jsonb_array_elements(value) with ordinality item(value,ordinal)
    ),''),']');
  end if;
  return value::text;
end;
$$;

create function recall_manifest_digest(value jsonb)
returns text language sql immutable strict parallel safe as $$
  select encode(sha256(convert_to(recall_canonical_json(value),'UTF8')),'hex');
$$;

create function recall_trace_graph_candidates(trace recall_traces)
returns jsonb language sql stable strict as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',candidate.memory_id::text,'scope',memory.scope,
    'channels',to_jsonb(candidate.channels),'score',to_jsonb(candidate.score::double precision)
  ) order by candidate.ordinal),'[]'::jsonb)
  from recall_trace_candidates candidate
  join memory_records memory on memory.id=candidate.memory_id
  where candidate.trace_id=trace.id;
$$;

create function recall_trace_graph_contexts(trace recall_traces)
returns jsonb language sql stable strict as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'ordinal',context.ordinal,'kind',context.kind,'sourceId',context.source_id::text,
    'scope',context.scope,'version',context.version,'contentKind',context.content_kind,
    'excerptDigest',context.excerpt_digest::text,
    'createdAt',to_char(context.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) order by context.ordinal),'[]'::jsonb)
  from recall_trace_context_entries context where context.trace_id=trace.id;
$$;

create function recall_trace_expected_manifest(trace recall_traces)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'traceId',trace.id::text,'responseId',trace.response_id::text,
    'actorRole',trace.actor_role,'actorId',trace.actor_id,
    'accountId',trace.account_id::text,'nodeBrainId',trace.node_brain_id::text,
    'conversationId',trace.conversation_id::text,'purpose',trace.purpose,
    'authorizedScopes',to_jsonb(trace.authorized_scopes),'queryDigest',trace.query_digest::text,
    'queryPlan',coalesce((select jsonb_agg(jsonb_build_object(
      'kind',step.kind,'limit',step.result_limit,'depth',step.graph_depth
    ) order by step.ordinal) from recall_trace_plan_steps step where step.trace_id=trace.id),'[]'::jsonb),
    'authorizedCandidateIds',coalesce((select jsonb_agg(candidate.memory_id::text
      order by candidate.memory_id::text) from recall_trace_candidates candidate
      where candidate.trace_id=trace.id),'[]'::jsonb),
    'authorizedCandidates',recall_trace_graph_candidates(trace),
    'contextEntries',recall_trace_graph_contexts(trace),
    'exclusions',coalesce((select jsonb_agg(jsonb_build_object(
      'id',candidate.memory_id::text,'reason',candidate.exclusion_reason
    ) order by candidate.ordinal) from recall_trace_candidates candidate
      where candidate.trace_id=trace.id and candidate.decision='EXCLUDED'),'[]'::jsonb),
    'selectedMemoryIds',coalesce((select jsonb_agg(candidate.memory_id::text
      order by candidate.selected_ordinal) from recall_trace_candidates candidate
      where candidate.trace_id=trace.id and candidate.decision='SELECTED'),'[]'::jsonb),
    'selectedSourceIds',coalesce((select jsonb_agg(distinct source.source_event_id::text
      order by source.source_event_id::text) from recall_trace_sources source
      where source.trace_id=trace.id),'[]'::jsonb),
    'cacheUse',trace.cache_use,'latencyMilliseconds',to_jsonb(trace.latency_ms::double precision),
    'policyVersion',trace.policy_version,'modelVersion',trace.model_version,
    'plannerVersion',trace.planner_version,'stateVersions',trace.state_versions,
    'highWaterSequence',trace.high_water_sequence::text,
    'sourceHighWaterSequence',trace.source_high_water_sequence::text,
    'requestDigest',trace.request_digest::text,
    'createdAt',to_char(trace.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$$;

create function recall_trace_expected_body(trace recall_traces)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'traceId',trace.id::text,'responseId',trace.response_id::text,
    'actor',case trace.actor_role
      when 'ACCOUNT' then jsonb_build_object(
        'role','ACCOUNT','accountId',trace.account_id::text,
        'nodeBrainId',trace.node_brain_id::text,'conversationId',trace.conversation_id::text)
      when 'MAIN_BRAIN' then jsonb_build_object('role','MAIN_BRAIN','actorId',trace.actor_id)
      else jsonb_build_object(
        'role',trace.actor_role,'actorId',trace.actor_id,'purpose',trace.purpose,
        'scopes',to_jsonb(trace.authorized_scopes)) end,
    'authorizedScopes',to_jsonb(trace.authorized_scopes),'queryDigest',trace.query_digest::text,
    'queryPlan',manifest.value->'queryPlan',
    'authorizedCandidates',manifest.value->'authorizedCandidates',
    'contextEntries',manifest.value->'contextEntries','exclusions',manifest.value->'exclusions',
    'selectedMemoryIds',manifest.value->'selectedMemoryIds',
    'selectedSourceIds',manifest.value->'selectedSourceIds','cacheUse',trace.cache_use,
    'measuredLatencyMilliseconds',manifest.value->'latencyMilliseconds',
    'policyVersion',trace.policy_version,'modelVersion',trace.model_version,
    'plannerVersion',trace.planner_version,'stateVersions',trace.state_versions,
    'highWaterSequence',trace.high_water_sequence::text,
    'sourceHighWaterSequence',trace.source_high_water_sequence::text,
    'requestDigest',trace.request_digest::text,'authorityManifest',manifest.value,
    'authorityDigest',recall_manifest_digest(manifest.value)
  ) from lateral (select recall_trace_expected_manifest(trace) value) manifest;
$$;

create function recall_trace_candidate_matches_authority(
  candidate_trace_id uuid,candidate_memory_id uuid,candidate_channels text[],candidate_score numeric
) returns boolean language sql stable strict as $$
  select exists (
    select 1 from recall_traces trace
    cross join lateral jsonb_array_elements(trace.candidate_authority) item
    join memory_records memory on memory.id=candidate_memory_id
    where trace.id=candidate_trace_id and item->>'id'=candidate_memory_id::text
      and item->>'scope'=memory.scope
      and item->'channels'=to_jsonb(candidate_channels)
      and (item->>'score')::numeric=candidate_score
  );
$$;

create function recall_trace_candidates_match_authority(candidate_trace_id uuid)
returns boolean language sql stable strict as $$
  select exists (
    select 1 from recall_traces trace where trace.id=candidate_trace_id
      and jsonb_array_length(trace.candidate_authority)=(
        select count(*) from recall_trace_candidates candidate
        where candidate.trace_id=trace.id
      )
      and not exists (
        select 1 from recall_trace_candidates candidate
        where candidate.trace_id=trace.id and not recall_trace_candidate_matches_authority(
          trace.id,candidate.memory_id,candidate.channels,candidate.score
        )
      )
  );
$$;

create function recall_trace_contexts_match_authority(candidate_trace_id uuid)
returns boolean language sql stable strict as $$
  select exists (
    select 1 from recall_traces trace where trace.id=candidate_trace_id
      and jsonb_array_length(trace.context_entries)=(
        select count(*) from recall_trace_context_entries context
        where context.trace_id=trace.id
      )
      and not exists (
        select 1 from recall_trace_context_entries context
        where context.trace_id=trace.id and not exists (
          select 1 from jsonb_array_elements(trace.context_entries) item
          where (item->>'ordinal')::integer=context.ordinal
            and item->>'kind'=context.kind and item->>'sourceId'=context.source_id::text
            and item->>'scope'=context.scope
            and (item->>'version') is not distinct from context.version
            and item->>'contentKind'=context.content_kind
            and item->>'excerptDigest'=context.excerpt_digest
            and (item->>'createdAt')::timestamptz=context.created_at
        )
      )
  );
$$;

create function recall_trace_body_binding_is_valid(trace recall_traces)
returns boolean language sql stable strict as $$
  select recall_trace_manifest_is_valid(trace)
    and trace.body_authority_manifest=recall_trace_expected_manifest(trace)
    and recall_manifest_digest(recall_trace_expected_manifest(trace))=trace.body_authority_digest
    and recall_manifest_digest(trace.body_authority_manifest)=trace.body_authority_digest
    and recall_manifest_digest(recall_trace_expected_body(trace))=trace.body_digest
    and recall_trace_candidates_match_authority(trace.id)
    and recall_trace_contexts_match_authority(trace.id)
    and exists (
      select 1 from events event
      join encrypted_event_bodies body on body.event_id=event.id
      where event.id=trace.event_id and body.data_key_id is not null
        and body.body_digest=trace.body_digest
        and event.request_hash=trace.event_request_hash
        and event.integrity_hash=trace.event_integrity_hash
        and right(event.idempotency_key,65)=concat(':',trace.body_digest)
    );
$$;

create function validate_recall_trace_authority() returns trigger language plpgsql as $$
declare event events%rowtype;
declare outbox transactional_outbox%rowtype;
begin
  select * into event from events where id=new.event_id;
  select * into outbox from transactional_outbox where event_id=new.event_id;
  if not found or event.type<>'memory.recall.traced'
    or event.occurred_at<>new.created_at
    or event.prompt_version<>new.planner_version
    or event.model_version<>new.model_version
    or event.policy_version<>new.policy_version
    or event.ingested_sequence<=new.high_water_sequence
    or outbox.topic<>'memory.recall.traced'
    or outbox.payload<>jsonb_build_object('eventId',event.id)
    or recall_manifest_digest(outbox.payload)<>new.outbox_payload_digest
    or event.request_hash<>new.event_request_hash
    or event.integrity_hash<>new.event_integrity_hash
    or right(event.idempotency_key,65)<>concat(':',new.body_digest)
    or not exists (select 1 from encrypted_event_bodies body
      where body.event_id=new.event_id and body.body_digest=new.body_digest)
    or not recall_trace_manifest_is_valid(new)
    or recall_manifest_digest(new.body_authority_manifest)<>new.body_authority_digest
    or new.source_high_water_sequence<>new.high_water_sequence
    or new.state_versions->>'main' is distinct from
      (select max(version)::text from main_state_versions)
    or new.state_versions->>'challenge' is distinct from
      (select concat(stage.id::text,':',checkpoint.high_water_sequence::text)
       from challenge_stages stage
       join challenge_projection_checkpoints checkpoint on checkpoint.stage_id=stage.id
       order by stage.ordinal desc,stage.created_at desc,stage.id desc limit 1)
    or new.state_versions->>'node' is distinct from
      (case when new.actor_role='ACCOUNT' then (
        select routed_event.ingested_sequence::text from events routed_event
        where routed_event.aggregate_id=new.conversation_id::text
          and routed_event.account_id=new.account_id::text
          and routed_event.type='node.reply.routed'
          and routed_event.visibility='PRIVATE_ACCOUNT'
          and routed_event.ingested_sequence<=new.high_water_sequence
        order by routed_event.ingested_sequence desc,routed_event.id desc limit 1
      ) else null end)
    or (case new.actor_role
      when 'ACCOUNT' then (event.actor_type<>'USER' or event.actor_id<>new.account_id::text
        or event.account_id<>new.account_id::text or event.aggregate_id<>new.conversation_id::text
        or event.visibility<>'PRIVATE_ACCOUNT')
      when 'MAIN_BRAIN' then (event.actor_type<>'MAIN_BRAIN' or event.actor_id<>'gustavo-main'
        or event.account_id is not null or event.aggregate_id<>'gustavo-main'
        or event.visibility<>'SHARED')
      when 'OPERATOR' then (event.actor_type<>'OPERATOR' or event.actor_id<>new.actor_id
        or event.account_id is not null or event.visibility<>'OPERATOR'
        or event.aggregate_id<>concat('recall:operator:',new.actor_id))
      when 'SYSTEM' then (event.actor_type<>'SYSTEM' or event.actor_id<>new.actor_id
        or event.account_id is not null or event.visibility<>'OPERATOR'
        or event.aggregate_id<>concat('recall:system:',new.actor_id))
      else true end)
  then
    if right(event.idempotency_key,65) is distinct from concat(':',new.body_digest)
      or not exists (select 1 from encrypted_event_bodies body
        where body.event_id=new.event_id and body.body_digest=new.body_digest) then
      raise exception 'RECALL_TRACE_BODY_BINDING_INVALID';
    end if;
    raise exception 'RECALL_TRACE_AUTHORITY_INVALID';
  end if;
  if new.actor_role='ACCOUNT' and not exists (
    select 1 from accounts account
    join entitlements entitlement on entitlement.account_id=account.id
      and entitlement.revoked_at is null and entitlement.active_from<=new.created_at
      and (entitlement.expires_at is null or entitlement.expires_at>new.created_at)
    join node_brains node on node.id=new.node_brain_id and node.account_id=account.id and node.status='ACTIVE'
    join conversations conversation on conversation.id=new.conversation_id
      and conversation.account_id=account.id and conversation.node_brain_id=node.id and conversation.status='OPEN'
    where account.id=new.account_id and account.status='ACTIVE'
  ) then raise exception 'RECALL_TRACE_ACCOUNT_INVALID'; end if;
  if new.actor_role<>'ACCOUNT' and not exists (
    select 1 from recall_actor_authorities authority
    where authority.role=new.actor_role and authority.actor_id=new.actor_id and authority.active
      and new.authorized_scopes<@authority.scopes
  ) then raise exception 'RECALL_TRACE_ACTOR_INVALID'; end if;
  return new;
end;
$$;
create trigger recall_trace_authority_is_consistent before insert on recall_traces
for each row execute function validate_recall_trace_authority();

create function validate_recall_trace_candidate() returns trigger language plpgsql as $$
declare trace recall_traces%rowtype;
declare memory memory_records%rowtype;
begin
  select * into trace from recall_traces where id=new.trace_id;
  select * into memory from memory_records where id=new.memory_id;
  if not found or not recall_candidate_is_authorized(trace,memory)
    or not (trace.authorized_candidate_ids ? new.memory_id::text)
    or not recall_trace_candidate_matches_authority(
      new.trace_id,new.memory_id,new.channels,new.score
    )
    or not exists (
      select 1 from encrypted_event_bodies body
      join aggregate_data_keys key on key.id=body.data_key_id
      where body.event_id=memory.body_event_id
    ) or exists (
      select 1 from memory_sources source
      left join encrypted_event_bodies body on body.event_id=source.source_event_id
      left join aggregate_data_keys key on key.id=body.data_key_id
      where source.memory_id=memory.id and key.id is null
    )
  then raise exception 'RECALL_TRACE_CANDIDATE_INVALID'; end if;
  if (new.decision='SELECTED') <> (trace.selected_memory_ids ? new.memory_id::text) then
    raise exception 'RECALL_TRACE_SELECTION_INVALID';
  end if;
  return new;
end;
$$;
create trigger recall_trace_candidate_is_consistent before insert on recall_trace_candidates
for each row execute function validate_recall_trace_candidate();

create function validate_recall_trace_source() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from recall_trace_candidates candidate
    join recall_traces trace on trace.id=candidate.trace_id
    join memory_sources source on source.memory_id=candidate.memory_id
      and source.source_event_id=new.source_event_id and source.ordinal=new.ordinal
    join events source_event on source_event.id=source.source_event_id
    join encrypted_event_bodies body on body.event_id=source.source_event_id
    join aggregate_data_keys key on key.id=body.data_key_id
    where candidate.trace_id=new.trace_id and candidate.memory_id=new.memory_id
      and candidate.decision='SELECTED'
      and source_event.ingested_sequence<=trace.source_high_water_sequence
  ) then raise exception 'RECALL_TRACE_SOURCE_INVALID'; end if;
  return new;
end;
$$;
create trigger recall_trace_source_is_consistent before insert on recall_trace_sources
for each row execute function validate_recall_trace_source();

create function validate_recall_trace_context_entry() returns trigger language plpgsql as $$
declare trace recall_traces%rowtype;
begin
  select * into trace from recall_traces where id=new.trace_id;
  if not found or not exists (
    select 1 from jsonb_array_elements(trace.context_entries) item
    where (item->>'ordinal')::integer=new.ordinal and item->>'kind'=new.kind
      and item->>'sourceId'=new.source_id::text and item->>'scope'=new.scope
      and (item->>'version') is not distinct from new.version
      and item->>'contentKind'=new.content_kind
      and item->>'excerptDigest'=new.excerpt_digest
      and (item->>'createdAt')::timestamptz=new.created_at
  ) then raise exception 'RECALL_TRACE_CONTEXT_INVALID'; end if;
  if (case new.kind
    when 'MAIN_STATE' then not (
      new.scope='MAIN_SHARED' and new.content_kind='CANONICAL_STATE'
      and new.version is not distinct from trace.state_versions->>'main'
      and exists (select 1 from broadcasts broadcast join events event
        on event.id=broadcast.commit_event_id where event.id=new.source_id
          and broadcast.main_state_version::text=new.version and event.occurred_at=new.created_at)
    )
    when 'NODE_STATE' then not (
      trace.actor_role='ACCOUNT' and new.scope='NODE_BRANCH'
      and new.content_kind='CANONICAL_STATE'
      and new.version is not distinct from trace.state_versions->>'node'
      and exists (select 1 from events event where event.id=new.source_id
        and event.aggregate_id=trace.conversation_id::text and event.account_id=trace.account_id::text
        and event.type='node.reply.routed' and event.ingested_sequence::text=new.version
        and event.occurred_at=new.created_at)
    )
    when 'CHALLENGE_STATE' then not (
      new.scope='CHALLENGE_SHARED' and new.content_kind='CANONICAL_STATE'
      and new.version is not distinct from trace.state_versions->>'challenge'
      and exists (select 1 from challenge_projection_checkpoints checkpoint
        join challenge_ledger_events event on event.id=checkpoint.high_water_event_id
        where event.id=new.source_id
          and concat(checkpoint.stage_id::text,':',checkpoint.high_water_sequence::text)=new.version
          and event.occurred_at=new.created_at)
    )
    when 'RECENT_TURN' then not (
      trace.actor_role='ACCOUNT' and new.scope='PRIVATE_ACCOUNT'
      and new.content_kind='ORIGINAL_EVENT' and new.version is null
      and exists (select 1 from messages message join events event on event.id=message.event_id
        where message.event_id=new.source_id and message.account_id=trace.account_id
          and message.conversation_id=trace.conversation_id and message.status='COMPLETED'
          and event.occurred_at=new.created_at)
    )
    else true end)
  then raise exception 'RECALL_TRACE_CONTEXT_INVALID'; end if;
  return new;
end;
$$;
create trigger recall_trace_context_is_consistent before insert on recall_trace_context_entries
for each row execute function validate_recall_trace_context_entry();

create function validate_recall_trace_complete() returns trigger language plpgsql as $$
begin
  if not recall_trace_body_binding_is_valid(new) then
    raise exception 'RECALL_TRACE_BODY_BINDING_INVALID';
  end if;
  if jsonb_array_length(new.query_plan)<>9
    or (select count(*) from recall_trace_plan_steps step where step.trace_id=new.id)<>9
    or (select jsonb_agg(jsonb_build_object(
          'kind',step.kind,'limit',step.result_limit,'depth',step.graph_depth
        ) order by step.ordinal) from recall_trace_plan_steps step where step.trace_id=new.id)<>new.query_plan
    or (select count(*) from recall_trace_candidates candidate where candidate.trace_id=new.id)
      <>jsonb_array_length(new.authorized_candidate_ids)
    or exists (
      select 1 from jsonb_array_elements_text(new.authorized_candidate_ids) item(value)
      where not exists (select 1 from recall_trace_candidates candidate
        where candidate.trace_id=new.id and candidate.memory_id::text=item.value)
    )
    or (select coalesce(jsonb_agg(candidate.memory_id::text order by candidate.selected_ordinal),'[]'::jsonb)
        from recall_trace_candidates candidate
        where candidate.trace_id=new.id and candidate.decision='SELECTED')<>new.selected_memory_ids
    or (select coalesce(jsonb_agg(jsonb_build_object(
          'id',candidate.memory_id::text,'reason',candidate.exclusion_reason
        ) order by candidate.ordinal),'[]'::jsonb)
        from recall_trace_candidates candidate
        where candidate.trace_id=new.id and candidate.decision='EXCLUDED')<>new.exclusions
    or exists (
      select 1 from recall_trace_candidates candidate
      where candidate.trace_id=new.id and candidate.decision='SELECTED'
        and (select count(*) from recall_trace_sources source
          where source.trace_id=new.id and source.memory_id=candidate.memory_id)
          <>(select count(*) from memory_sources source where source.memory_id=candidate.memory_id)
    )
    or (select coalesce(jsonb_agg(distinct source.source_event_id::text order by source.source_event_id::text),'[]'::jsonb)
        from recall_trace_sources source where source.trace_id=new.id)<>new.selected_source_ids
    or (select count(*) from recall_trace_context_entries context where context.trace_id=new.id)
      <>jsonb_array_length(new.context_entries)
  then raise exception 'RECALL_TRACE_INCOMPLETE'; end if;
  return new;
end;
$$;
create constraint trigger recall_trace_is_complete after insert on recall_traces
deferrable initially deferred for each row execute function validate_recall_trace_complete();

create function validate_recall_event_has_trace() returns trigger language plpgsql as $$
begin
  if new.type='memory.recall.traced' and not exists (
    select 1 from recall_traces trace where trace.event_id=new.id
  ) then raise exception 'RECALL_EVENT_TRACE_REQUIRED'; end if;
  return new;
end;
$$;
create constraint trigger recall_event_has_trace after insert on events
deferrable initially deferred for each row execute function validate_recall_event_has_trace();

create function reject_recall_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_RECALL_TRACE';
end;
$$;
create trigger memory_graph_edges_are_immutable before update or delete on memory_graph_edges
for each row execute function reject_recall_mutation();
create trigger recall_traces_are_immutable before update or delete on recall_traces
for each row execute function reject_recall_mutation();
create trigger recall_trace_plan_steps_are_immutable before update or delete on recall_trace_plan_steps
for each row execute function reject_recall_mutation();
create trigger recall_trace_candidates_are_immutable before update or delete on recall_trace_candidates
for each row execute function reject_recall_mutation();
create trigger recall_trace_sources_are_immutable before update or delete on recall_trace_sources
for each row execute function reject_recall_mutation();
create trigger recall_trace_context_entries_are_immutable
before update or delete on recall_trace_context_entries
for each row execute function reject_recall_mutation();

create function preserve_recall_outbox_authority() returns trigger language plpgsql as $$
begin
  if old.topic='memory.recall.traced' and (
    tg_op='DELETE' or new.event_id<>old.event_id or new.topic<>old.topic or new.payload<>old.payload
  ) then raise exception 'IMMUTABLE_RECALL_OUTBOX_AUTHORITY'; end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
create trigger recall_outbox_authority_is_immutable
before update or delete on transactional_outbox
for each row execute function preserve_recall_outbox_authority();
