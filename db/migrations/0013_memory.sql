create sequence events_ingested_sequence_seq as bigint;
alter table events
  add column ingested_sequence bigint
  default nextval('events_ingested_sequence_seq') not null;
alter sequence events_ingested_sequence_seq owned by events.ingested_sequence;
alter table events alter column ingested_sequence drop default;
alter table events
  add constraint events_ingested_sequence_key unique (ingested_sequence);

create function assign_event_ingested_sequence() returns trigger
language plpgsql as $$
begin
  new.ingested_sequence := nextval('events_ingested_sequence_seq');
  return new;
end;
$$;
create trigger event_ingested_sequence_is_database_assigned
before insert on events
for each row execute function assign_event_ingested_sequence();

create table memory_extraction_runs (
  id uuid primary key,
  source_event_id uuid not null references events(id),
  source_ingested_sequence bigint not null,
  consolidation_event_id uuid not null unique references encrypted_event_bodies(event_id),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid references accounts(id),
  node_brain_id uuid,
  conversation_id uuid,
  projection_key text not null check (length(projection_key) between 1 and 240),
  operation_key char(64) not null unique check (operation_key ~ '^[a-f0-9]{64}$'),
  source_from timestamptz not null,
  source_to timestamptz not null,
  prompt_version text not null check (length(trim(prompt_version)) between 1 and 200),
  model_version text not null check (length(trim(model_version)) between 1 and 200),
  extractor_version text not null check (length(trim(extractor_version)) between 1 and 200),
  embedding_version text not null check (length(trim(embedding_version)) between 1 and 200),
  idempotency_key text not null check (length(idempotency_key) between 1 and 240),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  memory_count integer not null check (memory_count between 1 and 400),
  status text not null default 'COMPLETED' check (status in ('COMPLETED')),
  completed_at timestamptz not null,
  foreign key (node_brain_id, account_id) references node_brains(id, account_id),
  foreign key (conversation_id, account_id) references conversations(id, account_id),
  unique nulls not distinct (
    scope, account_id, node_brain_id, conversation_id, projection_key, idempotency_key
  ),
  check (source_to >= source_from),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
      and account_id is not null and node_brain_id is not null and conversation_id is not null)
    or
    (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH')
      and account_id is null and node_brain_id is null and conversation_id is null)
  )
);

create index memory_extraction_runs_source_idx
  on memory_extraction_runs (source_event_id, completed_at);

create table memory_records (
  id uuid primary key,
  extraction_run_id uuid not null references memory_extraction_runs(id),
  body_event_id uuid not null references encrypted_event_bodies(event_id),
  ordinal integer not null check (ordinal between 0 and 399),
  source_count integer not null check (source_count between 1 and 500),
  type text not null check (type in ('SEMANTIC','EPISODIC','PROCEDURAL','GOAL')),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid references accounts(id),
  node_brain_id uuid,
  conversation_id uuid,
  search_key_id uuid,
  content_digest char(64) not null check (content_digest ~ '^[a-f0-9]{64}$'),
  equivalence_digest char(64) not null check (equivalence_digest ~ '^[a-f0-9]{64}$'),
  keywords_digest char(64) not null check (keywords_digest ~ '^[a-f0-9]{64}$'),
  entities_digest char(64) not null check (entities_digest ~ '^[a-f0-9]{64}$'),
  keyword_index_digests char(64)[] not null,
  entity_index_digests char(64)[] not null,
  public_keyword_terms text[],
  public_entity_terms text[],
  keyword_count integer not null check (keyword_count between 0 and 100),
  entity_count integer not null check (entity_count between 0 and 100),
  has_embedding boolean not null,
  embedding_digest char(64) check (embedding_digest is null or embedding_digest ~ '^[a-f0-9]{64}$'),
  embedding_dimension integer not null check (embedding_dimension between 0 and 8192),
  search_embedding_manifest real[],
  source_from timestamptz not null,
  source_to timestamptz not null,
  confidence numeric(7,6) not null check (confidence between 0 and 1),
  importance numeric(7,6) not null check (importance between 0 and 1),
  freshness numeric(7,6) not null check (freshness between 0 and 1),
  prompt_version text not null check (length(trim(prompt_version)) between 1 and 200),
  model_version text not null check (length(trim(model_version)) between 1 and 200),
  extractor_version text not null check (length(trim(extractor_version)) between 1 and 200),
  embedding_version text not null check (length(trim(embedding_version)) between 1 and 200),
  valid_from timestamptz not null,
  valid_to timestamptz,
  supersedes_memory_id uuid references memory_records(id),
  conflict_state text not null check (conflict_state in ('CURRENT','CONFLICTED','CORRECTED','SUPERSEDED')),
  correction_state text not null check (correction_state in ('NONE','USER_CORRECTED','OPERATOR_CORRECTED')),
  procedure_version text,
  goal_status text,
  created_at timestamptz not null,
  foreign key (node_brain_id, account_id) references node_brains(id, account_id),
  foreign key (conversation_id, account_id) references conversations(id, account_id),
  unique (extraction_run_id, ordinal),
  unique (extraction_run_id, content_digest, type),
  check (source_to >= source_from),
  check (valid_to is null or valid_to > valid_from),
  check (supersedes_memory_id is null or supersedes_memory_id <> id),
  check (correction_state='NONE' or supersedes_memory_id is not null),
  check ((has_embedding and embedding_digest is not null and embedding_dimension>0)
    or (not has_embedding and embedding_digest is null and embedding_dimension=0)),
  check (cardinality(keyword_index_digests)=keyword_count),
  check (cardinality(entity_index_digests)=entity_count),
  check (
    (scope='PUBLIC' and search_key_id is null
      and public_keyword_terms is not null and public_entity_terms is not null
      and cardinality(public_keyword_terms)=keyword_count
      and cardinality(public_entity_terms)=entity_count
      and ((has_embedding and search_embedding_manifest is not null
              and cardinality(search_embedding_manifest)=embedding_dimension)
        or (not has_embedding and search_embedding_manifest is null)))
    or (scope<>'PUBLIC' and search_key_id is not null
      and public_keyword_terms is null and public_entity_terms is null
      and search_embedding_manifest is null)
  ),
  check ((type='PROCEDURAL')=(procedure_version is not null)),
  check (procedure_version is null or length(trim(procedure_version)) between 1 and 200),
  check ((type='GOAL')=(goal_status is not null)),
  check (goal_status is null or goal_status in ('OPEN','BLOCKED','COMPLETED','CANCELLED')),
  check ((conflict_state='SUPERSEDED')=(valid_to is not null)),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
      and account_id is not null and node_brain_id is not null and conversation_id is not null)
    or
    (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH')
      and account_id is null and node_brain_id is null and conversation_id is null)
  )
);

create unique index memory_records_one_superseder_idx
  on memory_records (supersedes_memory_id)
  where supersedes_memory_id is not null;
create index memory_records_scoped_current_idx
  on memory_records (scope, account_id, node_brain_id, conversation_id, type, valid_from desc, id)
  where conflict_state <> 'SUPERSEDED';
create index memory_records_source_time_idx on memory_records (source_from, source_to, id);
create index memory_records_equivalence_lookup_idx
  on memory_records (
    scope,account_id,node_brain_id,conversation_id,type,equivalence_digest,created_at,id
  );

create table memory_sources (
  memory_id uuid not null references memory_records(id),
  ordinal integer not null check (ordinal between 0 and 499),
  source_event_id uuid not null references events(id),
  source_ingested_sequence bigint not null,
  source_at timestamptz not null,
  primary key (memory_id, source_event_id),
  unique (memory_id, ordinal)
);
create index memory_sources_event_idx on memory_sources (source_event_id, memory_id);

create table memory_semantic_facts (
  memory_id uuid primary key references memory_records(id),
  fact_digest char(64) not null check (fact_digest ~ '^[a-f0-9]{64}$')
);

create table memory_episodes (
  memory_id uuid primary key references memory_records(id),
  episode_from timestamptz not null,
  episode_to timestamptz not null,
  check (episode_to >= episode_from)
);

create table memory_procedures (
  memory_id uuid primary key references memory_records(id),
  procedure_version text not null check (length(trim(procedure_version)) between 1 and 200),
  procedure_digest char(64) not null check (procedure_digest ~ '^[a-f0-9]{64}$')
);

create table memory_goals (
  memory_id uuid primary key references memory_records(id),
  status text not null check (status in ('OPEN','BLOCKED','COMPLETED','CANCELLED')),
  goal_digest char(64) not null check (goal_digest ~ '^[a-f0-9]{64}$')
);

create table memory_embeddings (
  memory_id uuid primary key references memory_records(id),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  embedding_version text not null check (length(trim(embedding_version)) between 1 and 200),
  embedding_digest char(64) not null check (embedding_digest ~ '^[a-f0-9]{64}$'),
  dimension integer not null check (dimension between 1 and 8192),
  search_embedding real[] not null,
  active boolean not null default true,
  foreign key (node_brain_id, account_id) references node_brains(id, account_id),
  foreign key (conversation_id, account_id) references conversations(id, account_id),
  check (scope='PUBLIC' and account_id is null and node_brain_id is null
    and conversation_id is null and array_length(search_embedding,1)=dimension)
);
create index memory_embeddings_scope_idx
  on memory_embeddings (scope, account_id, conversation_id, active, memory_id)
  where active;

create function memory_cosine_similarity(left_vector real[], right_vector real[])
returns double precision
language plpgsql immutable strict as $$
declare dot_product double precision;
declare left_norm double precision;
declare right_norm double precision;
begin
  if cardinality(left_vector) between 1 and 8192
     and cardinality(left_vector)=cardinality(right_vector) then
    select sum(left_value::double precision*right_value::double precision),
           sqrt(sum(left_value::double precision*left_value::double precision)),
           sqrt(sum(right_value::double precision*right_value::double precision))
      into dot_product,left_norm,right_norm
    from unnest(left_vector) with ordinality left_item(left_value,ordinal)
    join unnest(right_vector) with ordinality right_item(right_value,ordinal)
      using (ordinal);
    if left_norm>0 and right_norm>0 then
      return dot_product/(left_norm*right_norm);
    end if;
  end if;
  raise exception 'INVALID_MEMORY_COSINE_VECTOR';
end;
$$;

create table memory_index_terms (
  memory_id uuid not null references memory_records(id),
  ordinal integer not null check (ordinal between 0 and 99),
  kind text not null check (kind in ('KEYWORD','ENTITY')),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  search_key_id uuid,
  term_text text,
  term_digest char(64) not null check (term_digest ~ '^[a-f0-9]{64}$'),
  set_digest char(64) not null check (set_digest ~ '^[a-f0-9]{64}$'),
  prompt_version text not null check (length(trim(prompt_version)) between 1 and 200),
  model_version text not null check (length(trim(model_version)) between 1 and 200),
  extractor_version text not null check (length(trim(extractor_version)) between 1 and 200),
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  primary key (memory_id,kind,ordinal),
  unique (memory_id,kind,term_digest),
  check (
    (scope='PUBLIC' and search_key_id is null and account_id is null and node_brain_id is null
      and conversation_id is null and length(trim(term_text)) between 1 and 120)
    or
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and search_key_id is not null and account_id is not null
      and node_brain_id is not null and conversation_id is not null and term_text is null)
    or
    (scope in ('MAIN_SHARED','CHALLENGE_SHARED','AUDIT_ONLY') and search_key_id is not null and account_id is null
      and node_brain_id is null and conversation_id is null and term_text is null)
  )
);
create index memory_index_terms_public_text_idx
  on memory_index_terms (kind,term_text,memory_id) where scope='PUBLIC';
create index memory_index_terms_scoped_digest_idx
  on memory_index_terms (scope,account_id,node_brain_id,conversation_id,kind,term_digest,memory_id);

create table memory_equivalence_sets (
  id uuid primary key,
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  type text not null check (type in ('SEMANTIC','EPISODIC','PROCEDURAL','GOAL')),
  equivalence_digest char(64) not null check (equivalence_digest ~ '^[a-f0-9]{64}$'),
  canonical_memory_id uuid not null unique references memory_records(id),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique nulls not distinct (
    scope,account_id,node_brain_id,conversation_id,type,equivalence_digest
  ),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);

create table memory_equivalence_links (
  memory_id uuid primary key references memory_records(id),
  equivalent_memory_id uuid not null references memory_records(id),
  link_type text not null default 'VERSION_EQUIVALENT' check (link_type='VERSION_EQUIVALENT'),
  created_at timestamptz not null,
  check (memory_id<>equivalent_memory_id)
);

create table memory_supersession_authorizations (
  memory_id uuid primary key references memory_records(id),
  source_event_id uuid not null references events(id),
  authority_kind text not null check (authority_kind in ('USER','OPERATOR','MAIN','CHALLENGE'))
);

create table memory_retrieval_stats (
  memory_id uuid primary key references memory_records(id),
  retrieval_use_count bigint not null default 0 check (retrieval_use_count >= 0),
  last_retrieved_at timestamptz
);

create table memory_projection_checkpoints (
  projection_key text primary key check (length(projection_key) between 1 and 240),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid references accounts(id),
  node_brain_id uuid,
  conversation_id uuid,
  source_event_id uuid not null references events(id),
  source_occurred_at timestamptz not null,
  source_ingested_sequence bigint not null,
  extraction_run_id uuid not null references memory_extraction_runs(id),
  memory_version bigint not null check (memory_version > 0),
  updated_at timestamptz not null,
  foreign key (node_brain_id, account_id) references node_brains(id, account_id),
  foreign key (conversation_id, account_id) references conversations(id, account_id),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
      and account_id is not null and node_brain_id is not null and conversation_id is not null)
    or
    (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH')
      and account_id is null and node_brain_id is null and conversation_id is null)
  )
);

create table memory_dossier_refreshes (
  extraction_run_id uuid primary key references memory_extraction_runs(id),
  target_kind text not null check (target_kind in ('NODE','MAIN','CHALLENGE','PUBLIC','AUDIT')),
  target_key text not null check (length(target_key) between 1 and 240),
  source_event_id uuid not null references events(id),
  status text not null default 'PENDING' check (status in ('PENDING','COMPLETED','FAILED')),
  created_at timestamptz not null
);

create function validate_memory_run_authority() returns trigger
language plpgsql as $$
declare source events%rowtype;
declare derived events%rowtype;
begin
  select * into source from events where id=new.source_event_id;
  select * into derived from events where id=new.consolidation_event_id;
  if source.id is null then raise exception 'MEMORY_SOURCE_EVENT_REQUIRED'; end if;
  if source.type='memory.consolidation.completed' then
    raise exception 'MEMORY_DERIVED_EVENT_NOT_SOURCE';
  end if;
  if derived.id is null
     or derived.type <> 'memory.consolidation.completed'
     or derived.actor_type <> 'SYSTEM'
     or derived.actor_id <> 'memory-consolidator'
     or derived.causation_id <> source.id
     or derived.aggregate_id <> source.aggregate_id
     or derived.occurred_at <> new.completed_at
     or derived.prompt_version is distinct from new.prompt_version
     or derived.model_version is distinct from new.model_version
     or derived.policy_version is distinct from new.extractor_version
     or source.ingested_sequence <> new.source_ingested_sequence
     or source.occurred_at not between new.source_from and new.source_to then
    raise exception 'MEMORY_CONSOLIDATION_EVENT_MISMATCH';
  end if;
  if new.projection_key <> (case
       when new.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
         then lower(new.scope) || ':conversation:' || new.conversation_id::text
       else lower(new.scope) || ':' || source.aggregate_id
     end) then
    raise exception 'MEMORY_PROJECTION_KEY_MISMATCH';
  end if;
  if new.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') then
    if source.visibility <> 'PRIVATE_ACCOUNT'
       or source.account_id <> new.account_id::text
       or source.aggregate_id <> new.conversation_id::text
       or derived.visibility <> 'PRIVATE_ACCOUNT'
       or derived.account_id <> new.account_id::text
       or derived.aggregate_id <> new.conversation_id::text then
      raise exception 'MEMORY_SOURCE_SCOPE_MISMATCH';
    end if;
  elsif new.scope in ('MAIN_SHARED','CHALLENGE_SHARED') then
    if source.visibility <> 'SHARED' or source.account_id is not null
       or derived.visibility <> 'SHARED' or derived.account_id is not null then
      raise exception 'MEMORY_SOURCE_SCOPE_MISMATCH';
    end if;
  elsif new.scope='PUBLIC' then
    if source.visibility <> 'PUBLIC' or source.account_id is not null
       or derived.visibility <> 'PUBLIC' or derived.account_id is not null then
      raise exception 'MEMORY_SOURCE_SCOPE_MISMATCH';
    end if;
  elsif new.scope='AUDIT_ONLY' then
    if source.visibility <> 'OPERATOR' or source.account_id is not null
       or derived.visibility <> 'OPERATOR' or derived.account_id is not null then
      raise exception 'MEMORY_SOURCE_SCOPE_MISMATCH';
    end if;
  end if;
  return new;
end;
$$;
create trigger memory_run_authority_is_consistent
before insert on memory_extraction_runs
for each row execute function validate_memory_run_authority();

create function validate_memory_record_authority() returns trigger
language plpgsql as $$
declare validated_search_key uuid;
begin
  if not exists (
    select 1 from memory_extraction_runs run
    where run.id=new.extraction_run_id
      and run.consolidation_event_id=new.body_event_id
      and run.scope=new.scope
      and run.account_id is not distinct from new.account_id
      and run.node_brain_id is not distinct from new.node_brain_id
      and run.conversation_id is not distinct from new.conversation_id
      and run.prompt_version=new.prompt_version
      and run.model_version=new.model_version
      and run.extractor_version=new.extractor_version
      and run.embedding_version=new.embedding_version
      and new.source_from>=run.source_from and new.source_to<=run.source_to
      and new.ordinal<run.memory_count
      and new.created_at=run.completed_at
  ) then
    raise exception 'MEMORY_RECORD_AUTHORITY_MISMATCH';
  end if;
  if new.scope<>'PUBLIC' then
    select key.id into validated_search_key
    from aggregate_data_keys key
    where key.id=new.search_key_id
      and key.aggregate_id=case
        when new.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') then new.conversation_id::text
        when new.scope='MAIN_SHARED' then 'memory-retrieval:main:v1'
        when new.scope='CHALLENGE_SHARED' then 'memory-retrieval:challenge:v1'
        else 'memory-retrieval:audit:v1'
      end
    for key share;
  end if;
  if (new.scope='PUBLIC' and new.search_key_id is not null)
     or (new.scope<>'PUBLIC' and validated_search_key is null) then
    raise exception 'MEMORY_SEARCH_KEY_AUTHORITY_MISMATCH';
  end if;
  if new.supersedes_memory_id is not null and not exists (
    select 1 from memory_records prior
    where prior.id=new.supersedes_memory_id
      and prior.type=new.type and prior.scope=new.scope
      and prior.account_id is not distinct from new.account_id
      and prior.node_brain_id is not distinct from new.node_brain_id
      and prior.conversation_id is not distinct from new.conversation_id
      and prior.valid_from<new.valid_from
  ) then
    raise exception 'MEMORY_SUPERSESSION_AUTHORITY_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger memory_record_authority_is_consistent
before insert on memory_records
for each row execute function validate_memory_record_authority();

create function validate_memory_source_authority() returns trigger
language plpgsql as $$
declare source_type text;
declare source_aggregate text;
declare lead_aggregate text;
begin
  select type,aggregate_id into source_type,source_aggregate
  from events where id=new.source_event_id;
  if source_type='memory.consolidation.completed' then
    raise exception 'MEMORY_DERIVED_EVENT_NOT_SOURCE';
  end if;
  select lead.aggregate_id into lead_aggregate
  from memory_records memory
  join memory_extraction_runs run on run.id=memory.extraction_run_id
  join events lead on lead.id=run.source_event_id
  where memory.id=new.memory_id;
  if source_aggregate is distinct from lead_aggregate then
    raise exception 'MEMORY_SOURCE_AGGREGATE_MISMATCH';
  end if;
  if not exists (
    select 1
    from memory_records memory
    join events source on source.id=new.source_event_id
    where memory.id=new.memory_id
      and new.ordinal<memory.source_count
      and source.occurred_at=new.source_at
      and source.ingested_sequence=new.source_ingested_sequence
      and new.source_at between memory.source_from and memory.source_to
      and (
        (memory.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
          and source.visibility='PRIVATE_ACCOUNT'
          and source.account_id=memory.account_id::text
          and source.aggregate_id=memory.conversation_id::text
          and not (source.actor_type='USER' and source.actor_id<>memory.account_id::text)
          and not (source.actor_type='NODE_BRAIN' and source.actor_id<>memory.node_brain_id::text))
        or (memory.scope in ('MAIN_SHARED','CHALLENGE_SHARED')
          and source.visibility='SHARED' and source.account_id is null)
        or (memory.scope='PUBLIC' and source.visibility='PUBLIC')
        or (memory.scope='AUDIT_ONLY' and source.visibility='OPERATOR')
      )
  ) then
    raise exception 'MEMORY_SOURCE_SCOPE_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger memory_source_authority_is_consistent
before insert on memory_sources
for each row execute function validate_memory_source_authority();

create function validate_typed_memory_projection() returns trigger
language plpgsql as $$
declare expected_type text;
declare projection jsonb;
begin
  projection := to_jsonb(new);
  expected_type := case tg_table_name
    when 'memory_semantic_facts' then 'SEMANTIC'
    when 'memory_episodes' then 'EPISODIC'
    when 'memory_procedures' then 'PROCEDURAL'
    when 'memory_goals' then 'GOAL'
    else null
  end;
  if expected_type is null or not exists (
    select 1 from memory_records memory
    where memory.id=new.memory_id and memory.type=expected_type
      and (expected_type<>'SEMANTIC'
        or projection->>'fact_digest'=memory.content_digest)
      and (expected_type<>'EPISODIC'
        or ((projection->>'episode_from')::timestamptz=memory.source_from
          and (projection->>'episode_to')::timestamptz=memory.source_to))
      and (expected_type<>'PROCEDURAL'
        or (projection->>'procedure_version'=memory.procedure_version
          and projection->>'procedure_digest'=memory.content_digest))
      and (expected_type<>'GOAL'
        or (projection->>'status'=memory.goal_status
          and projection->>'goal_digest'=memory.content_digest))
  ) then
    raise exception 'MEMORY_TYPED_PROJECTION_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger semantic_memory_type_is_consistent before insert on memory_semantic_facts
for each row execute function validate_typed_memory_projection();
create trigger episode_memory_type_is_consistent before insert on memory_episodes
for each row execute function validate_typed_memory_projection();
create trigger procedure_memory_type_is_consistent before insert on memory_procedures
for each row execute function validate_typed_memory_projection();
create trigger goal_memory_type_is_consistent before insert on memory_goals
for each row execute function validate_typed_memory_projection();

create function validate_memory_embedding_insert() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from memory_records memory
    where memory.id=new.memory_id
      and memory.scope='PUBLIC'
      and memory.has_embedding
      and memory.scope=new.scope
      and memory.account_id is not distinct from new.account_id
      and memory.node_brain_id is not distinct from new.node_brain_id
      and memory.conversation_id is not distinct from new.conversation_id
      and memory.embedding_version=new.embedding_version
      and memory.embedding_digest=new.embedding_digest
      and memory.embedding_dimension=new.dimension
      and array_length(new.search_embedding,1)=new.dimension
      and new.search_embedding=memory.search_embedding_manifest
  ) then
    raise exception 'MEMORY_EMBEDDING_TOPOLOGY_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger memory_embedding_is_consistent
before insert on memory_embeddings
for each row execute function validate_memory_embedding_insert();

create function protect_memory_embedding() returns trigger
language plpgsql as $$
begin
  if tg_op='UPDATE'
     and old.active and not new.active
     and new.memory_id=old.memory_id
     and new.account_id is not distinct from old.account_id
     and new.node_brain_id is not distinct from old.node_brain_id
     and new.conversation_id is not distinct from old.conversation_id
     and new.scope=old.scope
     and new.embedding_version=old.embedding_version
     and new.embedding_digest=old.embedding_digest
     and new.dimension=old.dimension
     and new.search_embedding is not distinct from old.search_embedding then
    return new;
  end if;
  raise exception 'IMMUTABLE_MEMORY_EMBEDDING';
end;
$$;
create trigger memory_embeddings_are_protected
before update or delete on memory_embeddings
for each row execute function protect_memory_embedding();

create function validate_memory_index_term() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from memory_records memory
    where memory.id=new.memory_id
      and memory.scope=new.scope
      and memory.account_id is not distinct from new.account_id
      and memory.node_brain_id is not distinct from new.node_brain_id
      and memory.conversation_id is not distinct from new.conversation_id
      and memory.search_key_id is not distinct from new.search_key_id
      and ((new.kind='KEYWORD' and new.ordinal<memory.keyword_count
            and new.set_digest=memory.keywords_digest
            and new.term_digest=memory.keyword_index_digests[new.ordinal+1])
        or (new.kind='ENTITY' and new.ordinal<memory.entity_count
            and new.set_digest=memory.entities_digest
            and new.term_digest=memory.entity_index_digests[new.ordinal+1]))
      and new.prompt_version=memory.prompt_version
      and new.model_version=memory.model_version
      and new.extractor_version=memory.extractor_version
      and ((memory.scope='PUBLIC' and new.term_text is not null)
        or (memory.scope<>'PUBLIC' and new.term_text is null))
      and (memory.scope<>'PUBLIC' or new.term_text=case new.kind
        when 'KEYWORD' then memory.public_keyword_terms[new.ordinal+1]
        else memory.public_entity_terms[new.ordinal+1]
      end)
  ) then
    raise exception 'MEMORY_INDEX_TOPOLOGY_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger memory_index_term_is_consistent
before insert on memory_index_terms
for each row execute function validate_memory_index_term();

create function validate_memory_equivalence_set() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from memory_records memory
    where memory.id=new.canonical_memory_id
      and memory.scope=new.scope
      and memory.account_id is not distinct from new.account_id
      and memory.node_brain_id is not distinct from new.node_brain_id
      and memory.conversation_id is not distinct from new.conversation_id
      and memory.type=new.type
      and memory.equivalence_digest=new.equivalence_digest
  ) then
    raise exception 'MEMORY_EQUIVALENCE_SET_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger memory_equivalence_set_is_consistent
before insert on memory_equivalence_sets
for each row execute function validate_memory_equivalence_set();

create function validate_memory_equivalence_link() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1
    from memory_records current_memory
    join memory_equivalence_sets set on set.scope=current_memory.scope
      and set.account_id is not distinct from current_memory.account_id
      and set.node_brain_id is not distinct from current_memory.node_brain_id
      and set.conversation_id is not distinct from current_memory.conversation_id
      and set.type=current_memory.type
      and set.equivalence_digest=current_memory.equivalence_digest
    where current_memory.id=new.memory_id
      and set.canonical_memory_id=new.equivalent_memory_id
      and current_memory.id<>set.canonical_memory_id
      and not exists (
        select 1 from memory_equivalence_links outgoing
        where outgoing.memory_id=current_memory.id
      )
      and not exists (
        select 1 from memory_equivalence_sets rooted
        where rooted.canonical_memory_id=current_memory.id
      )
  ) then
    raise exception 'MEMORY_EQUIVALENCE_FOREST_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger memory_equivalence_is_consistent
before insert on memory_equivalence_links
for each row execute function validate_memory_equivalence_link();

create function validate_memory_supersession_authorization() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1
    from memory_records memory
    join memory_sources cited on cited.memory_id=memory.id and cited.source_event_id=new.source_event_id
    join events source on source.id=cited.source_event_id
    where memory.id=new.memory_id and memory.supersedes_memory_id is not null
      and (
        (new.authority_kind='USER' and memory.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
          and memory.correction_state='USER_CORRECTED'
          and source.actor_type='USER' and source.actor_id=memory.account_id::text)
        or (new.authority_kind='OPERATOR' and memory.correction_state='OPERATOR_CORRECTED'
          and source.actor_type='OPERATOR')
        or (new.authority_kind='MAIN' and memory.scope in ('MAIN_SHARED','PUBLIC')
          and source.actor_type='MAIN_BRAIN' and source.actor_id='gustavo-main'
          and source.type in ('winner.selected','main.broadcast.committed','commentary.published'))
        or (new.authority_kind='CHALLENGE' and memory.scope='CHALLENGE_SHARED'
          and ((source.actor_type='MAIN_BRAIN' and source.actor_id='gustavo-main'
                and source.type='winner.selected')
            or (source.actor_type='SYSTEM' and source.actor_id='challenge-stage-lifecycle'
                and source.type in ('challenge.passed','challenge.failed'))))
      )
  ) then
    raise exception 'MEMORY_SUPERSESSION_AUTHORITY_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger memory_supersession_authority_is_consistent
before insert on memory_supersession_authorizations
for each row execute function validate_memory_supersession_authorization();

create function validate_memory_checkpoint() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from memory_extraction_runs run
    where run.id=new.extraction_run_id
      and run.source_event_id=new.source_event_id
      and run.source_ingested_sequence=new.source_ingested_sequence
      and run.projection_key=new.projection_key
      and run.scope=new.scope
      and run.account_id is not distinct from new.account_id
      and run.node_brain_id is not distinct from new.node_brain_id
      and run.conversation_id is not distinct from new.conversation_id
      and exists (
        select 1 from events event
        where event.id=new.source_event_id and event.occurred_at=new.source_occurred_at
          and event.ingested_sequence=new.source_ingested_sequence
      )
  ) then
    raise exception 'MEMORY_CHECKPOINT_AUTHORITY_MISMATCH';
  end if;
  if tg_op='UPDATE' and (
    new.projection_key<>old.projection_key
    or new.memory_version<>old.memory_version+1
    or new.source_ingested_sequence<=old.source_ingested_sequence
  ) then
    raise exception 'MEMORY_CHECKPOINT_REGRESSION';
  end if;
  return new;
end;
$$;
create trigger memory_checkpoint_is_consistent
before insert or update on memory_projection_checkpoints
for each row execute function validate_memory_checkpoint();

create function reject_memory_checkpoint_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_MEMORY_CHECKPOINT';
end;
$$;
create trigger memory_checkpoint_delete_is_rejected
before delete on memory_projection_checkpoints
for each row execute function reject_memory_checkpoint_delete();

create function validate_memory_dossier_refresh() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from memory_extraction_runs run
    where run.id=new.extraction_run_id
      and run.source_event_id=new.source_event_id
      and run.projection_key=new.target_key
      and new.target_kind=case
        when run.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') then 'NODE'
        when run.scope='MAIN_SHARED' then 'MAIN'
        when run.scope='CHALLENGE_SHARED' then 'CHALLENGE'
        when run.scope='PUBLIC' then 'PUBLIC'
        else 'AUDIT'
      end
  ) then
    raise exception 'MEMORY_DOSSIER_REFRESH_AUTHORITY_MISMATCH';
  end if;
  return new;
end;
$$;
create trigger memory_dossier_refresh_is_consistent
before insert on memory_dossier_refreshes
for each row execute function validate_memory_dossier_refresh();

create function reject_memory_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '%', case tg_table_name
    when 'memory_records' then 'IMMUTABLE_MEMORY_RECORD'
    when 'memory_sources' then 'IMMUTABLE_MEMORY_SOURCE'
    when 'memory_extraction_runs' then 'IMMUTABLE_MEMORY_EXTRACTION_RUN'
    else 'IMMUTABLE_MEMORY_PROJECTION'
  end;
end;
$$;
create trigger memory_records_are_immutable before update or delete on memory_records
for each row execute function reject_memory_mutation();
create trigger memory_sources_are_immutable before update or delete on memory_sources
for each row execute function reject_memory_mutation();
create trigger memory_extraction_runs_are_immutable before update or delete on memory_extraction_runs
for each row execute function reject_memory_mutation();
create trigger memory_semantic_facts_are_immutable before update or delete on memory_semantic_facts
for each row execute function reject_memory_mutation();
create trigger memory_episodes_are_immutable before update or delete on memory_episodes
for each row execute function reject_memory_mutation();
create trigger memory_procedures_are_immutable before update or delete on memory_procedures
for each row execute function reject_memory_mutation();
create trigger memory_goals_are_immutable before update or delete on memory_goals
for each row execute function reject_memory_mutation();
create trigger memory_index_terms_are_immutable before update or delete on memory_index_terms
for each row execute function reject_memory_mutation();
create trigger memory_equivalence_links_are_immutable before update or delete on memory_equivalence_links
for each row execute function reject_memory_mutation();
create trigger memory_equivalence_sets_are_immutable before update or delete on memory_equivalence_sets
for each row execute function reject_memory_mutation();
create trigger memory_supersession_authorizations_are_immutable
before update or delete on memory_supersession_authorizations
for each row execute function reject_memory_mutation();

create function validate_memory_run_completeness() returns trigger
language plpgsql as $$
begin
  if (select count(*) from memory_records where extraction_run_id=new.id) <> new.memory_count
     or exists (
       select 1 from memory_records memory
       where memory.extraction_run_id=new.id
         and (
           not exists (select 1 from memory_sources source where source.memory_id=memory.id)
           or (select count(*) from memory_sources source where source.memory_id=memory.id)
              <> memory.source_count
           or (memory.scope='PUBLIC' and memory.has_embedding) <> exists (
             select 1 from memory_embeddings embedding where embedding.memory_id=memory.id)
           or (select count(*) from memory_index_terms term
               where term.memory_id=memory.id and term.kind='KEYWORD') <> memory.keyword_count
           or (select count(*) from memory_index_terms term
               where term.memory_id=memory.id and term.kind='ENTITY') <> memory.entity_count
           or not exists (select 1 from memory_retrieval_stats stats where stats.memory_id=memory.id)
           or (memory.supersedes_memory_id is not null) <> exists (
             select 1 from memory_supersession_authorizations authority
             where authority.memory_id=memory.id)
           or not exists (
             select 1 from memory_equivalence_sets set
             where set.scope=memory.scope
               and set.account_id is not distinct from memory.account_id
               and set.node_brain_id is not distinct from memory.node_brain_id
               and set.conversation_id is not distinct from memory.conversation_id
               and set.type=memory.type
               and set.equivalence_digest=memory.equivalence_digest
               and (set.canonical_memory_id=memory.id or exists (
                 select 1 from memory_equivalence_links link
                 where link.memory_id=memory.id
                   and link.equivalent_memory_id=set.canonical_memory_id
               ))
           )
           or (memory.type='SEMANTIC') <> exists (
             select 1 from memory_semantic_facts typed where typed.memory_id=memory.id)
           or (memory.type='EPISODIC') <> exists (
             select 1 from memory_episodes typed where typed.memory_id=memory.id)
           or (memory.type='PROCEDURAL') <> exists (
             select 1 from memory_procedures typed where typed.memory_id=memory.id)
           or (memory.type='GOAL') <> exists (
             select 1 from memory_goals typed where typed.memory_id=memory.id)
         )
     )
     or not exists (
       select 1 from transactional_outbox outbox
       where outbox.event_id=new.consolidation_event_id
         and outbox.topic='memory.consolidation.completed'
     )
     or not exists (
       select 1 from memory_dossier_refreshes refresh where refresh.extraction_run_id=new.id
     )
  then
    raise exception 'INCOMPLETE_MEMORY_EXTRACTION_RUN';
  end if;
  return null;
end;
$$;
create constraint trigger memory_run_is_complete
after insert on memory_extraction_runs
deferrable initially deferred
for each row execute function validate_memory_run_completeness();

create function validate_memory_event_has_run() returns trigger
language plpgsql as $$
begin
  if new.type='memory.consolidation.completed' and not exists (
    select 1 from memory_extraction_runs run where run.consolidation_event_id=new.id
  ) then
    raise exception 'MEMORY_EXTRACTION_RUN_REQUIRED';
  end if;
  return null;
end;
$$;
create constraint trigger memory_event_has_extraction_run
after insert on events
deferrable initially deferred
for each row execute function validate_memory_event_has_run();
