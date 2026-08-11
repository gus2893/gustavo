create table memory_graph_reconciliation_runs (
  id uuid primary key,
  operation_key char(64) not null unique check (operation_key ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 240),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid references accounts(id),
  node_brain_id uuid,
  conversation_id uuid,
  reconciler_version text not null check (length(trim(reconciler_version)) between 1 and 200),
  observed_at timestamptz not null,
  candidate_count integer not null check (candidate_count between 1 and 200),
  entity_count integer not null check (entity_count between 1 and 50),
  alias_count integer not null check (alias_count between 0 and 1000),
  edge_count integer not null check (edge_count between 0 and 358400),
  conflict_count integer not null check (conflict_count between 0 and 5050),
  current_count integer not null default 0 check (current_count between 0 and 100),
  graph_event_id uuid unique references events(id),
  graph_event_request_hash char(64) check (
    graph_event_request_hash is null or graph_event_request_hash ~ '^[a-f0-9]{64}$'
  ),
  graph_event_integrity_hash char(64) check (
    graph_event_integrity_hash is null or graph_event_integrity_hash ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  check (created_at=observed_at),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);
create index memory_graph_runs_scope_time_idx
  on memory_graph_reconciliation_runs (
    scope,account_id,node_brain_id,conversation_id,observed_at desc,id
  );

create table memory_graph_idempotency_keys (
  idempotency_key text primary key check (length(idempotency_key) between 1 and 240),
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  request_shape_digest char(64) not null check (request_shape_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);
create index memory_graph_idempotency_run_idx
  on memory_graph_idempotency_keys (reconciliation_run_id,idempotency_key);

create table memory_graph_entities (
  id uuid primary key,
  first_reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  type text not null check (type in (
    'PERSON','ACCOUNT','NODE_BRAIN','MAIN_BRAIN','INSTRUMENT','MARKET_ZONE','METHOD',
    'HYPOTHESIS','EVIDENCE','DECISION','GOAL','CHALLENGE','TRADE','EPISODE','SOURCE_DOCUMENT'
  )),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  canonical_digest char(64) not null check (canonical_digest ~ '^[a-f0-9]{64}$'),
  public_label text,
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique nulls not distinct (
    scope,account_id,node_brain_id,conversation_id,canonical_digest
  ),
  check ((scope='PUBLIC' and length(trim(public_label)) between 1 and 240)
    or (scope<>'PUBLIC' and public_label is null)),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);
create index memory_graph_entities_scope_type_time_idx
  on memory_graph_entities (
    scope,account_id,node_brain_id,conversation_id,type,created_at desc,id
  );

create table memory_graph_entity_versions (
  id uuid primary key,
  entity_id uuid not null references memory_graph_entities(id),
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  append_ordinal bigint not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  supersedes_entity_version_id uuid references memory_graph_entity_versions(id),
  created_at timestamptz not null,
  unique (reconciliation_run_id,entity_id),
  unique (entity_id,append_ordinal),
  check (valid_to is null or valid_to>valid_from)
);
create index memory_graph_entity_versions_history_idx
  on memory_graph_entity_versions (entity_id,append_ordinal desc);

create table memory_graph_run_entities (
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  entity_id uuid not null references memory_graph_entities(id),
  entity_version_id uuid not null references memory_graph_entity_versions(id),
  ordinal integer not null check (ordinal between 0 and 49),
  primary key (reconciliation_run_id,entity_id),
  unique (reconciliation_run_id,ordinal)
);

create table memory_graph_entity_aliases (
  id uuid primary key,
  first_reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  entity_id uuid not null references memory_graph_entities(id),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  alias_digest char(64) not null check (alias_digest ~ '^[a-f0-9]{64}$'),
  append_ordinal bigint not null,
  source_digest char(64) not null check (source_digest ~ '^[a-f0-9]{64}$'),
  public_alias text,
  valid_from timestamptz not null,
  valid_to timestamptz,
  source_count integer not null check (source_count between 1 and 500),
  supersedes_alias_id uuid references memory_graph_entity_aliases(id),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique (first_reconciliation_run_id,entity_id,alias_digest,valid_from,source_digest),
  unique (entity_id,alias_digest,append_ordinal),
  check (valid_to is null or valid_to>valid_from),
  check ((scope='PUBLIC' and length(trim(public_alias)) between 1 and 240)
    or (scope<>'PUBLIC' and public_alias is null)),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);
create index memory_graph_aliases_lookup_idx
  on memory_graph_entity_aliases (
    scope,account_id,node_brain_id,conversation_id,alias_digest,append_ordinal desc
  );

create table memory_graph_run_aliases (
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  alias_id uuid not null references memory_graph_entity_aliases(id),
  ordinal integer not null check (ordinal between 0 and 999),
  primary key (reconciliation_run_id,alias_id),
  unique (reconciliation_run_id,ordinal)
);

create table memory_graph_alias_sources (
  alias_id uuid not null references memory_graph_entity_aliases(id),
  ordinal integer not null check (ordinal between 0 and 499),
  source_event_id uuid not null references events(id),
  primary key (alias_id,source_event_id),
  unique (alias_id,ordinal)
);
create index memory_graph_alias_sources_event_idx
  on memory_graph_alias_sources (source_event_id,alias_id);

create table memory_graph_nodes (
  memory_id uuid primary key references memory_records(id),
  first_reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  entity_id uuid not null references memory_graph_entities(id),
  node_type text not null check (node_type in (
    'BELIEF','FACT','PROCEDURE','GOAL','EPISODE','HYPOTHESIS','EVIDENCE','DECISION',
    'TRADE','SOURCE_DOCUMENT'
  )),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  predicate_digest char(64) not null check (predicate_digest ~ '^[a-f0-9]{64}$'),
  value_digest char(64) not null check (value_digest ~ '^[a-f0-9]{64}$'),
  public_predicate text,
  public_value text,
  approved boolean not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  source_count integer not null check (source_count between 1 and 500),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  check (valid_to is null or valid_to>valid_from),
  check ((scope='PUBLIC' and length(trim(public_predicate)) between 1 and 240
      and length(trim(public_value)) between 1 and 240)
    or (scope<>'PUBLIC' and public_predicate is null and public_value is null)),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);
create index memory_graph_nodes_scope_type_entity_time_idx
  on memory_graph_nodes (
    scope,account_id,node_brain_id,conversation_id,node_type,entity_id,
    predicate_digest,valid_from desc,memory_id
  );
create index memory_graph_nodes_entity_current_idx
  on memory_graph_nodes (entity_id,predicate_digest,valid_from desc,memory_id)
  where valid_to is null;

create table memory_graph_run_candidates (
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  memory_id uuid not null references memory_graph_nodes(memory_id),
  ordinal integer not null check (ordinal between 0 and 199),
  primary key (reconciliation_run_id,memory_id),
  unique (reconciliation_run_id,ordinal)
);

create table memory_graph_node_sources (
  memory_id uuid not null references memory_graph_nodes(memory_id),
  ordinal integer not null check (ordinal between 0 and 499),
  source_event_id uuid not null references events(id),
  primary key (memory_id,source_event_id),
  unique (memory_id,ordinal)
);
create index memory_graph_node_sources_event_idx
  on memory_graph_node_sources (source_event_id,memory_id);

create table memory_graph_current_claims (
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  memory_id uuid not null references memory_graph_nodes(memory_id),
  entity_id uuid not null references memory_graph_entities(id),
  predicate_digest char(64) not null check (predicate_digest ~ '^[a-f0-9]{64}$'),
  primary key (reconciliation_run_id,memory_id),
  unique (reconciliation_run_id,entity_id,predicate_digest)
);

alter table memory_graph_edges
  add column provenance_kind text not null default 'LEGACY_0015'
    check (provenance_kind in ('LEGACY_0015','RECONCILED')),
  add column first_reconciliation_run_id uuid
    references memory_graph_reconciliation_runs(id),
  add column source_count integer not null default 0 check (source_count between 0 and 1000),
  add check (
    (provenance_kind='LEGACY_0015' and first_reconciliation_run_id is null and source_count=0)
    or (provenance_kind='RECONCILED' and first_reconciliation_run_id is not null and source_count>=1)
  );

create table memory_graph_legacy_edge_backfills (
  edge_id uuid primary key references memory_graph_edges(id),
  provenance_kind text not null check (provenance_kind='LEGACY_0015'),
  migrated_at timestamptz not null
);
insert into memory_graph_legacy_edge_backfills (edge_id,provenance_kind,migrated_at)
select id,'LEGACY_0015',clock_timestamp() from memory_graph_edges;
alter table memory_graph_edges alter column provenance_kind set default 'RECONCILED';
create index memory_graph_edges_source_temporal_idx
  on memory_graph_edges (
    scope,account_id,node_brain_id,conversation_id,source_memory_id,valid_from desc,valid_to,
    target_memory_id,type
  );
create index memory_graph_edges_target_temporal_idx
  on memory_graph_edges (
    scope,account_id,node_brain_id,conversation_id,target_memory_id,valid_from desc,valid_to,
    source_memory_id,type
  );
create index memory_graph_edges_source_leading_idx
  on memory_graph_edges (source_memory_id,scope,valid_from desc,valid_to,id)
  where scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH');
create index memory_graph_edges_target_leading_idx
  on memory_graph_edges (target_memory_id,scope,valid_from desc,valid_to,id)
  where scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH');

create table memory_graph_run_edges (
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  edge_id uuid not null references memory_graph_edges(id),
  primary key (reconciliation_run_id,edge_id)
);

create table memory_graph_edge_sources (
  edge_id uuid not null references memory_graph_edges(id),
  ordinal integer not null check (ordinal between 0 and 999),
  source_event_id uuid not null references events(id),
  primary key (edge_id,source_event_id),
  unique (edge_id,ordinal)
);
create index memory_graph_edge_sources_event_idx
  on memory_graph_edge_sources (source_event_id,edge_id);

create table memory_conflicts (
  id uuid primary key,
  first_reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  newer_memory_id uuid not null references memory_graph_nodes(memory_id),
  older_memory_id uuid not null references memory_graph_nodes(memory_id),
  preferred_memory_id uuid not null references memory_graph_nodes(memory_id),
  entity_id uuid not null references memory_graph_entities(id),
  predicate_digest char(64) not null check (predicate_digest ~ '^[a-f0-9]{64}$'),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  source_count integer not null check (source_count between 1 and 1000),
  detected_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  unique (newer_memory_id,older_memory_id,predicate_digest),
  check (newer_memory_id<>older_memory_id),
  check (preferred_memory_id in (newer_memory_id,older_memory_id)),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);
create index memory_conflicts_scope_entity_time_idx
  on memory_conflicts (
    scope,account_id,node_brain_id,conversation_id,entity_id,predicate_digest,detected_at desc,id
  );

create table memory_graph_run_conflicts (
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  conflict_id uuid not null references memory_conflicts(id),
  primary key (reconciliation_run_id,conflict_id)
);

create table memory_conflict_sources (
  conflict_id uuid not null references memory_conflicts(id),
  ordinal integer not null check (ordinal between 0 and 999),
  source_event_id uuid not null references events(id),
  primary key (conflict_id,source_event_id),
  unique (conflict_id,ordinal)
);
create index memory_conflict_sources_event_idx
  on memory_conflict_sources (source_event_id,conflict_id);

create table memory_graph_background_jobs (
  id uuid primary key,
  operation_key char(64) not null unique check (operation_key ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 240),
  actor_role text not null check (actor_role in ('MAIN_BRAIN','ACCOUNT','SYSTEM','OPERATOR')),
  actor_id text not null check (length(trim(actor_id)) between 1 and 128),
  authorized_scopes text[] not null,
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  seed_memory_ids uuid[] not null,
  requested_depth integer not null check (requested_depth between 1 and 32),
  candidate_limit integer not null check (candidate_limit between 1 and 100),
  as_of timestamptz not null,
  reason text not null check (reason in ('DEPTH_LIMIT','CANDIDATE_LIMIT','BOTH')),
  status text not null check (status='PENDING'),
  queued_event_id uuid not null unique references events(id),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  check (cardinality(authorized_scopes) between 1 and 6),
  check (authorized_scopes <@ array[
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  ]::text[]),
  check (cardinality(seed_memory_ids) between 1 and 20),
  check (
    (actor_role='ACCOUNT' and account_id is not null and actor_id=account_id::text
      and node_brain_id is not null and conversation_id is not null)
    or (actor_role<>'ACCOUNT' and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);
create index memory_graph_background_pending_idx
  on memory_graph_background_jobs (status,created_at,id);

create table memory_graph_reconciliation_jobs (
  id uuid primary key,
  operation_key char(64) not null unique check (operation_key ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 240),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  request_shape_digest char(64) not null check (request_shape_digest ~ '^[a-f0-9]{64}$'),
  reconciler_version text not null check (length(reconciler_version) between 1 and 200),
  scope text not null check (scope in (
    'PRIVATE_ACCOUNT','NODE_BRANCH','MAIN_SHARED','CHALLENGE_SHARED','PUBLIC','AUDIT_ONLY'
  )),
  account_id uuid,
  node_brain_id uuid,
  conversation_id uuid,
  candidate_memory_ids uuid[] not null check (cardinality(candidate_memory_ids) between 1 and 200),
  source_event_ids uuid[] not null check (cardinality(source_event_ids) between 1 and 100000),
  candidate_count integer not null check (candidate_count between 1 and 200),
  estimated_edge_count integer not null check (estimated_edge_count between 0 and 358400),
  estimated_edge_source_count integer not null check (
    estimated_edge_source_count between 0 and 358400000
  ),
  estimated_materialization_rows integer not null check (
    estimated_materialization_rows between 1 and 700000
  ),
  check (estimated_edge_count>5150 or estimated_edge_source_count>10300
    or estimated_materialization_rows>100000),
  request_event_id uuid not null unique references events(id),
  created_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  foreign key (conversation_id,account_id) references conversations(id,account_id),
  check (
    (scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is not null
      and node_brain_id is not null and conversation_id is not null)
    or (scope not in ('PRIVATE_ACCOUNT','NODE_BRANCH') and account_id is null
      and node_brain_id is null and conversation_id is null)
  )
);
create index memory_graph_reconciliation_jobs_pending_idx
  on memory_graph_reconciliation_jobs (created_at,id);

create table memory_graph_reconciliation_job_idempotency_keys (
  idempotency_key text primary key check (length(idempotency_key) between 1 and 240),
  job_id uuid not null references memory_graph_reconciliation_jobs(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  request_shape_digest char(64) not null check (request_shape_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create table memory_graph_reconciliation_job_entities (
  job_id uuid not null references memory_graph_reconciliation_jobs(id),
  ordinal integer not null check (ordinal between 0 and 49),
  entity_id uuid not null,
  type text not null,
  canonical_digest char(64) not null check (canonical_digest ~ '^[a-f0-9]{64}$'),
  public_label text,
  valid_from timestamptz not null,
  valid_to timestamptz,
  primary key (job_id,ordinal),
  unique (job_id,entity_id),
  check (valid_to is null or valid_to>valid_from)
);

create table memory_graph_reconciliation_job_aliases (
  job_id uuid not null references memory_graph_reconciliation_jobs(id),
  ordinal integer not null check (ordinal between 0 and 999),
  entity_id uuid not null,
  alias_digest char(64) not null check (alias_digest ~ '^[a-f0-9]{64}$'),
  public_alias text,
  valid_from timestamptz not null,
  valid_to timestamptz,
  source_set_ordinal integer not null check (source_set_ordinal between 0 and 1199),
  source_count integer not null check (source_count between 1 and 500),
  primary key (job_id,ordinal),
  foreign key (job_id,entity_id)
    references memory_graph_reconciliation_job_entities(job_id,entity_id),
  check (valid_to is null or valid_to>valid_from)
);

create table memory_graph_reconciliation_job_sources (
  job_id uuid not null references memory_graph_reconciliation_jobs(id),
  ordinal integer not null check (ordinal between 0 and 99999),
  source_event_id uuid not null references events(id),
  primary key (job_id,ordinal),
  unique (job_id,source_event_id)
);

create table memory_graph_reconciliation_job_source_sets (
  job_id uuid not null references memory_graph_reconciliation_jobs(id),
  ordinal integer not null check (ordinal between 0 and 1199),
  source_ordinals integer[] not null,
  source_count integer not null check (source_count between 1 and 500),
  source_digest char(64) not null check (source_digest ~ '^[a-f0-9]{64}$'),
  primary key (job_id,ordinal),
  unique (job_id,source_digest),
  check (cardinality(source_ordinals)=source_count)
);
alter table memory_graph_reconciliation_job_aliases
  add foreign key (job_id,source_set_ordinal)
  references memory_graph_reconciliation_job_source_sets(job_id,ordinal);

create table memory_graph_reconciliation_job_candidates (
  job_id uuid not null references memory_graph_reconciliation_jobs(id),
  ordinal integer not null check (ordinal between 0 and 199),
  memory_id uuid not null references memory_records(id),
  entity_id uuid not null,
  node_type text not null,
  predicate_digest char(64) not null check (predicate_digest ~ '^[a-f0-9]{64}$'),
  value_digest char(64) not null check (value_digest ~ '^[a-f0-9]{64}$'),
  public_predicate text,
  public_value text,
  approved boolean not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  source_set_ordinal integer not null check (source_set_ordinal between 0 and 1199),
  source_count integer not null check (source_count between 1 and 500),
  primary key (job_id,ordinal),
  unique (job_id,memory_id),
  foreign key (job_id,entity_id)
    references memory_graph_reconciliation_job_entities(job_id,entity_id),
  foreign key (job_id,source_set_ordinal)
    references memory_graph_reconciliation_job_source_sets(job_id,ordinal),
  check (valid_to is null or valid_to>valid_from)
);

create table memory_graph_reconciliation_job_manifests (
  job_id uuid primary key references memory_graph_reconciliation_jobs(id),
  request_event_id uuid not null unique references events(id),
  operation_key char(64) not null check (operation_key ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create table memory_graph_reconciliation_job_transitions (
  id uuid primary key,
  job_id uuid not null references memory_graph_reconciliation_jobs(id),
  ordinal integer not null check (ordinal between 0 and 100000),
  action text not null check (action in ('QUEUE','CLAIM','PROGRESS','COMPLETE','FAIL')),
  from_status text,
  to_status text not null check (to_status in (
    'PENDING','CLAIMED','RETRY_SCHEDULED','COMPLETED','FAILED'
  )),
  worker_id text,
  lease_until timestamptz,
  retry_at timestamptz,
  error_code text,
  edge_offset integer not null check (edge_offset between 0 and 358400),
  edge_source_offset integer not null check (edge_source_offset between 0 and 358400000),
  transition_event_id uuid not null unique references events(id),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 240),
  operation_digest char(64) not null check (operation_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default date_trunc('milliseconds',transaction_timestamp()),
  unique (job_id,ordinal)
);
create index memory_graph_reconciliation_job_transition_latest_idx
  on memory_graph_reconciliation_job_transitions(job_id,ordinal desc,id);

create table memory_graph_reconciliation_job_transition_manifests (
  transition_id uuid primary key references memory_graph_reconciliation_job_transitions(id),
  job_id uuid not null references memory_graph_reconciliation_jobs(id),
  transition_event_id uuid not null unique references events(id),
  operation_digest char(64) not null check (operation_digest ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

create view memory_graph_reconciliation_job_current as
select distinct on (job.id) job.id job_id,transition.to_status status,
  transition.worker_id,transition.lease_until,transition.retry_at,transition.error_code,
  transition.edge_offset,transition.edge_source_offset,transition.ordinal,
  transition.created_at transitioned_at
from memory_graph_reconciliation_jobs job
join memory_graph_reconciliation_job_transitions transition on transition.job_id=job.id
order by job.id,transition.ordinal desc;

create table memory_graph_event_manifests (
  graph_event_id uuid primary key references events(id),
  reconciliation_run_id uuid not null unique references memory_graph_reconciliation_runs(id),
  memory_ids uuid[] not null,
  source_event_ids uuid[] not null,
  semantic_digest char(64) not null check (semantic_digest ~ '^[a-f0-9]{64}$'),
  relation_count integer not null check (relation_count between 0 and 358400),
  relation_digest char(64) not null check (relation_digest ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  check (cardinality(memory_ids) between 1 and 200),
  check (cardinality(source_event_ids) between 1 and 1000)
);

create function memory_graph_relation_digest(target_run_id uuid)
returns text language sql stable strict as $$
  select recall_manifest_digest(coalesce(jsonb_agg(jsonb_build_object(
    'from',edge.source_memory_id::text,
    'type',edge.type,
    'to',edge.target_memory_id::text,
    'validFrom',to_char(edge.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'validTo',case when edge.valid_to is null then null else
      to_char(edge.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'sourceIds',coalesce((select jsonb_agg(source.source_event_id::text order by source.ordinal)
      from memory_graph_edge_sources source where source.edge_id=edge.id),'[]'::jsonb)
  ) order by edge.source_memory_id,edge.type,edge.target_memory_id,edge.valid_from),'[]'::jsonb))
  from memory_graph_run_edges member
  join memory_graph_edges edge on edge.id=member.edge_id
  where member.reconciliation_run_id=target_run_id;
$$;

create function memory_graph_expected_event_body(target_run_id uuid)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'run',jsonb_build_object(
      'id',run.id::text,'operationKey',run.operation_key,'scope',run.scope,
      'accountId',run.account_id::text,'nodeBrainId',run.node_brain_id::text,
      'conversationId',run.conversation_id::text,'reconcilerVersion',run.reconciler_version,
      'observedAt',to_char(run.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'entities',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',entity.id::text,'type',entity.type,'canonicalDigest',entity.canonical_digest,
        'publicLabel',entity.public_label,
        'validFrom',to_char(version.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validTo',case when version.valid_to is null then null else
          to_char(version.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'aliases',coalesce((
          select jsonb_agg(jsonb_build_object(
            'aliasDigest',alias.alias_digest,'publicAlias',alias.public_alias,
            'validFrom',to_char(alias.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'validTo',case when alias.valid_to is null then null else
              to_char(alias.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
            'sourceIds',coalesce((select jsonb_agg(source.source_event_id::text order by source.ordinal)
              from memory_graph_alias_sources source where source.alias_id=alias.id),'[]'::jsonb)
          ) order by alias_member.ordinal)
          from memory_graph_run_aliases alias_member
          join memory_graph_entity_aliases alias on alias.id=alias_member.alias_id
          where alias_member.reconciliation_run_id=run.id and alias.entity_id=entity.id
        ),'[]'::jsonb)
      ) order by member.ordinal)
      from memory_graph_run_entities member
      join memory_graph_entities entity on entity.id=member.entity_id
      join memory_graph_entity_versions version on version.id=member.entity_version_id
      where member.reconciliation_run_id=run.id
    ),'[]'::jsonb),
    'claims',coalesce((
      select jsonb_agg(jsonb_build_object(
        'memoryId',node.memory_id::text,'entityId',node.entity_id::text,'nodeType',node.node_type,
        'predicateDigest',node.predicate_digest,'valueDigest',node.value_digest,
        'publicPredicate',node.public_predicate,'publicValue',node.public_value,
        'approved',node.approved,
        'validFrom',to_char(node.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validTo',case when node.valid_to is null then null else
          to_char(node.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'sourceIds',coalesce((select jsonb_agg(source.source_event_id::text order by source.ordinal)
          from memory_graph_node_sources source where source.memory_id=node.memory_id),'[]'::jsonb)
      ) order by candidate.ordinal)
      from memory_graph_run_candidates candidate
      join memory_graph_nodes node on node.memory_id=candidate.memory_id
      where candidate.reconciliation_run_id=run.id
    ),'[]'::jsonb),
    'currentMemoryIds',coalesce((
      select jsonb_agg(current.memory_id::text order by candidate.ordinal)
      from memory_graph_current_claims current
      join memory_graph_run_candidates candidate
        on candidate.reconciliation_run_id=current.reconciliation_run_id
        and candidate.memory_id=current.memory_id
      where current.reconciliation_run_id=run.id
    ),'[]'::jsonb),
    'relationships',coalesce((
      select jsonb_agg(jsonb_build_object(
        'from',edge.source_memory_id::text,'type',edge.type,'to',edge.target_memory_id::text,
        'validFrom',to_char(edge.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validTo',case when edge.valid_to is null then null else
          to_char(edge.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'sourceIds',coalesce((select jsonb_agg(source.source_event_id::text order by source.ordinal)
          from memory_graph_edge_sources source where source.edge_id=edge.id),'[]'::jsonb)
      ) order by edge.source_memory_id,edge.type,edge.target_memory_id,edge.valid_from)
      from memory_graph_run_edges member
      join memory_graph_edges edge on edge.id=member.edge_id
      where member.reconciliation_run_id=run.id
    ),'[]'::jsonb),
    'conflicts',coalesce((
      select jsonb_agg(jsonb_build_object(
        'newer',conflict.newer_memory_id::text,'older',conflict.older_memory_id::text,
        'preferred',conflict.preferred_memory_id::text,'entityId',conflict.entity_id::text,
        'predicateDigest',conflict.predicate_digest,
        'sourceIds',coalesce((select jsonb_agg(source.source_event_id::text order by source.ordinal)
          from memory_conflict_sources source where source.conflict_id=conflict.id),'[]'::jsonb)
      ) order by conflict.newer_memory_id,conflict.older_memory_id,conflict.predicate_digest)
      from memory_graph_run_conflicts member
      join memory_conflicts conflict on conflict.id=member.conflict_id
      where member.reconciliation_run_id=run.id
    ),'[]'::jsonb)
  ) from memory_graph_reconciliation_runs run where run.id=target_run_id;
$$;

create or replace function memory_graph_expected_event_body(target_run_id uuid)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'run',jsonb_build_object(
      'id',run.id::text,'operationKey',run.operation_key,'scope',run.scope,
      'accountId',run.account_id::text,'nodeBrainId',run.node_brain_id::text,
      'conversationId',run.conversation_id::text,'reconcilerVersion',run.reconciler_version,
      'observedAt',to_char(run.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'counts',jsonb_build_object(
      'candidates',run.candidate_count,'entities',run.entity_count,'aliases',run.alias_count,
      'relationships',run.edge_count,'conflicts',run.conflict_count,'current',run.current_count
    ),
    'digests',jsonb_build_object(
      'candidates',recall_manifest_digest(coalesce((
        select jsonb_agg(candidate.memory_id::text order by candidate.ordinal)
        from memory_graph_run_candidates candidate where candidate.reconciliation_run_id=run.id
      ),'[]'::jsonb)),
      'sources',recall_manifest_digest(coalesce((
        select jsonb_agg(source_id order by source_id) from (
          select distinct source.source_event_id::text source_id
          from memory_graph_run_candidates candidate
          join memory_graph_node_sources source on source.memory_id=candidate.memory_id
          where candidate.reconciliation_run_id=run.id
        ) sources
      ),'[]'::jsonb)),
      'current',recall_manifest_digest(coalesce((
        select jsonb_agg(current.memory_id::text order by candidate.ordinal)
        from memory_graph_current_claims current
        join memory_graph_run_candidates candidate
          on candidate.reconciliation_run_id=current.reconciliation_run_id
          and candidate.memory_id=current.memory_id
        where current.reconciliation_run_id=run.id
      ),'[]'::jsonb)),
      'relationships',memory_graph_relation_digest(run.id),
      'conflicts',recall_manifest_digest(coalesce((
        select jsonb_agg(jsonb_build_object(
          'newer',conflict.newer_memory_id::text,'older',conflict.older_memory_id::text,
          'preferred',conflict.preferred_memory_id::text,'entityId',conflict.entity_id::text,
          'predicateDigest',conflict.predicate_digest,
          'sourceIds',coalesce((select jsonb_agg(source.source_event_id::text order by source.ordinal)
            from memory_conflict_sources source where source.conflict_id=conflict.id),'[]'::jsonb)
        ) order by conflict.newer_memory_id,conflict.older_memory_id,conflict.predicate_digest)
        from memory_graph_run_conflicts member
        join memory_conflicts conflict on conflict.id=member.conflict_id
        where member.reconciliation_run_id=run.id
      ),'[]'::jsonb))
    )
  ) from memory_graph_reconciliation_runs run where run.id=target_run_id;
$$;

create function memory_graph_expected_event_body_digest(target_run_id uuid)
returns text language sql stable strict as $$
  select recall_manifest_digest(memory_graph_expected_event_body(target_run_id));
$$;

create function memory_graph_reconciliation_job_body(target_job_id uuid)
returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'jobId',job.id::text,'operationKey',job.operation_key,
    'requestDigest',job.request_digest,'requestShapeDigest',job.request_shape_digest,
    'scope',job.scope,'accountId',job.account_id::text,'nodeBrainId',job.node_brain_id::text,
    'conversationId',job.conversation_id::text,'reconcilerVersion',job.reconciler_version,
    'observedAt',to_char(job.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'counts',jsonb_build_object(
      'entities',(select count(*) from memory_graph_reconciliation_job_entities
        where job_id=job.id),
      'aliases',(select count(*) from memory_graph_reconciliation_job_aliases
        where job_id=job.id),
      'candidates',job.candidate_count,
      'sources',(select count(*) from memory_graph_reconciliation_job_sources
        where job_id=job.id),
      'sourceSets',(select count(*) from memory_graph_reconciliation_job_source_sets
        where job_id=job.id)
    ),
    'estimates',jsonb_build_object(
      'edges',job.estimated_edge_count,'edgeSources',job.estimated_edge_source_count,
      'materializationRows',job.estimated_materialization_rows
    ),
    'cursor',jsonb_build_object('edgeOffset',0,'edgeSourceOffset',0),
    'digests',jsonb_build_object(
      'entities',recall_manifest_digest(coalesce((select jsonb_agg(jsonb_build_object(
        'ordinal',entity.ordinal,'entityId',entity.entity_id::text,'type',entity.type,
        'canonicalDigest',entity.canonical_digest,'publicLabel',entity.public_label,
        'validFrom',to_char(entity.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validTo',case when entity.valid_to is null then null else
          to_char(entity.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
      ) order by entity.ordinal) from memory_graph_reconciliation_job_entities entity
        where entity.job_id=job.id),'[]'::jsonb)),
      'aliases',recall_manifest_digest(coalesce((select jsonb_agg(jsonb_build_object(
        'ordinal',alias.ordinal,'entityId',alias.entity_id::text,
        'aliasDigest',alias.alias_digest,'publicAlias',alias.public_alias,
        'validFrom',to_char(alias.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validTo',case when alias.valid_to is null then null else
          to_char(alias.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'sourceSetOrdinal',alias.source_set_ordinal,'sourceCount',alias.source_count
      ) order by alias.ordinal) from memory_graph_reconciliation_job_aliases alias
        where alias.job_id=job.id),'[]'::jsonb)),
      'candidates',recall_manifest_digest(coalesce((select jsonb_agg(jsonb_build_object(
        'ordinal',candidate.ordinal,'memoryId',candidate.memory_id::text,
        'entityId',candidate.entity_id::text,'nodeType',candidate.node_type,
        'predicateDigest',candidate.predicate_digest,'valueDigest',candidate.value_digest,
        'publicPredicate',candidate.public_predicate,'publicValue',candidate.public_value,
        'approved',candidate.approved,
        'validFrom',to_char(candidate.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'validTo',case when candidate.valid_to is null then null else
          to_char(candidate.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'sourceSetOrdinal',candidate.source_set_ordinal,'sourceCount',candidate.source_count
      ) order by candidate.ordinal) from memory_graph_reconciliation_job_candidates candidate
        where candidate.job_id=job.id),'[]'::jsonb)),
      'sources',recall_manifest_digest(coalesce((select jsonb_agg(source.source_event_id::text
        order by source.ordinal) from memory_graph_reconciliation_job_sources source
        where source.job_id=job.id),'[]'::jsonb)),
      'sourceSets',recall_manifest_digest(coalesce((select jsonb_agg(jsonb_build_object(
        'ordinal',source_set.ordinal,'sourceOrdinals',to_jsonb(source_set.source_ordinals),
        'sourceCount',source_set.source_count,'sourceDigest',source_set.source_digest
      ) order by source_set.ordinal) from memory_graph_reconciliation_job_source_sets source_set
        where source_set.job_id=job.id),'[]'::jsonb))
    )
  ) from memory_graph_reconciliation_jobs job where job.id=target_job_id;
$$;

create function memory_graph_expected_reconciliation_job_body_digest(target_job_id uuid)
returns text language sql stable strict as $$
  select recall_manifest_digest(memory_graph_reconciliation_job_body(target_job_id));
$$;

create function memory_graph_reconciliation_job_transition_operation_digest(
  transition memory_graph_reconciliation_job_transitions
) returns text language sql stable strict as $$
  select case transition.action
    when 'QUEUE' then (select job.operation_key from memory_graph_reconciliation_jobs job
      where job.id=transition.job_id)
    when 'CLAIM' then recall_manifest_digest(jsonb_build_object(
      'action','CLAIM','jobId',transition.job_id::text,'workerId',transition.worker_id,
      'leaseUntil',to_char(transition.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ))
    when 'PROGRESS' then recall_manifest_digest(jsonb_build_object(
      'action','PROGRESS','jobId',transition.job_id::text,'workerId',transition.worker_id,
      'edgeOffset',transition.edge_offset,'edgeSourceOffset',transition.edge_source_offset
    ))
    when 'COMPLETE' then recall_manifest_digest(jsonb_build_object(
      'action','COMPLETE','jobId',transition.job_id::text,'workerId',transition.worker_id,
      'edgeOffset',transition.edge_offset,'edgeSourceOffset',transition.edge_source_offset
    ))
    else recall_manifest_digest(jsonb_build_object(
      'action','FAIL','jobId',transition.job_id::text,'workerId',transition.worker_id,
      'errorCode',transition.error_code,
      'retryAt',case when transition.retry_at is null then null else
        to_jsonb(to_char(transition.retry_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end
    )) end;
$$;

create function memory_graph_reconciliation_job_transition_body(
  transition memory_graph_reconciliation_job_transitions
) returns jsonb language sql stable strict as $$
  select case transition.action
    when 'QUEUE' then memory_graph_reconciliation_job_body(transition.job_id)
    when 'CLAIM' then jsonb_build_object(
      'jobId',transition.job_id::text,'fromStatus',transition.from_status,
      'toStatus',transition.to_status,'workerId',transition.worker_id,
      'leaseUntil',to_char(transition.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'cursor',jsonb_build_object('edgeOffset',transition.edge_offset,
        'edgeSourceOffset',transition.edge_source_offset)
    )
    when 'PROGRESS' then jsonb_build_object(
      'jobId',transition.job_id::text,'fromStatus',transition.from_status,
      'toStatus',transition.to_status,'workerId',transition.worker_id,
      'cursor',jsonb_build_object('edgeOffset',transition.edge_offset,
        'edgeSourceOffset',transition.edge_source_offset)
    )
    when 'COMPLETE' then jsonb_build_object(
      'jobId',transition.job_id::text,'fromStatus',transition.from_status,
      'toStatus',transition.to_status,'workerId',transition.worker_id,
      'cursor',jsonb_build_object('edgeOffset',transition.edge_offset,
        'edgeSourceOffset',transition.edge_source_offset)
    )
    else jsonb_build_object(
      'jobId',transition.job_id::text,'fromStatus',transition.from_status,
      'toStatus',transition.to_status,'workerId',transition.worker_id,
      'errorCode',transition.error_code,
      'retryAt',case when transition.retry_at is null then null else
        to_jsonb(to_char(transition.retry_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
      'cursor',jsonb_build_object('edgeOffset',transition.edge_offset,
        'edgeSourceOffset',transition.edge_source_offset)
    ) end;
$$;

create function memory_graph_expected_reconciliation_job_transition_body_digest(
  target_transition_id uuid
) returns text language sql stable strict as $$
  select recall_manifest_digest(memory_graph_reconciliation_job_transition_body(transition))
  from memory_graph_reconciliation_job_transitions transition
  where transition.id=target_transition_id;
$$;

create function memory_graph_reconciliation_job_envelope_is_valid(target_job_id uuid)
returns boolean language sql stable strict as $$
  select exists (
    select 1 from memory_graph_reconciliation_jobs job
    join events event on event.id=job.request_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
      and outbox.topic='memory.graph.reconciliation.queued'
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
    join memory_graph_reconciliation_job_manifests manifest on manifest.job_id=job.id
      and manifest.request_event_id=event.id and manifest.operation_key=job.operation_key
    join memory_graph_reconciliation_job_transitions queued on queued.job_id=job.id
      and queued.ordinal=0 and queued.action='QUEUE' and queued.from_status is null
      and queued.to_status='PENDING' and queued.transition_event_id=event.id
      and queued.operation_digest=job.operation_key and queued.edge_offset=0
      and queued.edge_source_offset=0
    join memory_graph_reconciliation_job_transition_manifests transition_manifest
      on transition_manifest.transition_id=queued.id
      and transition_manifest.transition_event_id=event.id
      and transition_manifest.operation_digest=queued.operation_digest
    where job.id=target_job_id
      and event.aggregate_id=case when job.conversation_id is not null
        then job.conversation_id::text else 'memory-graph:'||job.scope end
      and event.account_id is not distinct from job.account_id::text
      and event.actor_type='SYSTEM' and event.actor_id='memory-graph-reconciler'
      and event.type='memory.graph.reconciliation.queued'
      and event.visibility=case
        when job.scope='PUBLIC' then 'PUBLIC'
        when job.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') then 'PRIVATE_ACCOUNT'
        when job.scope='AUDIT_ONLY' then 'OPERATOR' else 'SHARED' end
      and event.policy_version='memory-graph-v1'
      and event.idempotency_key='memory-graph-reconciliation-job:'||job.operation_key
      and event.occurred_at=job.created_at and queued.created_at=job.created_at
      and body.body_digest=memory_graph_expected_reconciliation_job_body_digest(job.id)
      and manifest.body_digest=body.body_digest
      and manifest.event_request_hash=event.request_hash
      and manifest.event_integrity_hash=event.integrity_hash
      and transition_manifest.body_digest=body.body_digest
      and transition_manifest.event_request_hash=event.request_hash
      and transition_manifest.event_integrity_hash=event.integrity_hash
  );
$$;

create function memory_graph_event_envelope_is_valid(target_run_id uuid,target_event_id uuid)
returns boolean language sql stable strict as $$
  select exists (
    select 1 from memory_graph_reconciliation_runs run
    join events event on event.id=target_event_id
    where run.id=target_run_id
      and event.aggregate_id=case when run.conversation_id is not null
        then run.conversation_id::text else 'memory-graph:'||run.scope end
      and event.account_id is not distinct from run.account_id::text
      and event.actor_type='SYSTEM' and event.actor_id='memory-graph-reconciler'
      and event.type='memory.edge.versioned'
      and event.visibility=case
        when run.scope='PUBLIC' then 'PUBLIC'
        when run.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') then 'PRIVATE_ACCOUNT'
        when run.scope='AUDIT_ONLY' then 'OPERATOR'
        else 'SHARED' end
      and event.occurred_at=run.observed_at
      and run.created_at=run.observed_at
      and event.policy_version='memory-graph-v1'
      and event.idempotency_key='memory-graph-event:'||run.operation_key
  );
$$;

create table memory_graph_head_versions (
  id uuid primary key,
  reconciliation_run_id uuid not null references memory_graph_reconciliation_runs(id),
  entity_id uuid not null references memory_graph_entities(id),
  predicate_digest char(64) not null check (predicate_digest ~ '^[a-f0-9]{64}$'),
  memory_id uuid not null references memory_graph_nodes(memory_id),
  append_ordinal bigint not null,
  supersedes_head_version_id uuid references memory_graph_head_versions(id),
  created_at timestamptz not null,
  unique (reconciliation_run_id,entity_id,predicate_digest),
  unique (entity_id,predicate_digest,append_ordinal)
);
create index memory_graph_head_versions_current_idx
  on memory_graph_head_versions (entity_id,predicate_digest,append_ordinal desc);
create view memory_graph_current_heads as
select distinct on (entity_id,predicate_digest)
  id,reconciliation_run_id,entity_id,predicate_digest,memory_id,
  append_ordinal,supersedes_head_version_id,created_at
from memory_graph_head_versions
order by entity_id,predicate_digest,append_ordinal desc;

create table memory_graph_worker_authorities (
  actor_id text primary key check (length(trim(actor_id)) between 1 and 128),
  purposes text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);
insert into memory_graph_worker_authorities(actor_id,purposes)
values ('memory-graph-worker',array['DEEP_RESEARCH','RECONCILIATION']::text[]);

create table memory_graph_background_job_transitions (
  id uuid primary key,
  job_id uuid not null references memory_graph_background_jobs(id),
  ordinal integer not null check (ordinal between 0 and 100),
  from_status text,
  to_status text not null check (to_status in (
    'PENDING','CLAIMED','RETRY_SCHEDULED','COMPLETED','FAILED'
  )),
  worker_id text,
  lease_until timestamptz,
  retry_at timestamptz,
  error_code text,
  result_memory_ids uuid[],
  transition_event_id uuid not null unique references events(id),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 240),
  operation_digest char(64) not null check (operation_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default date_trunc('milliseconds',transaction_timestamp()),
  unique (job_id,ordinal),
  check (result_memory_ids is null or cardinality(result_memory_ids) between 0 and 100)
);
create index memory_graph_background_job_transition_latest_idx
  on memory_graph_background_job_transitions (job_id,ordinal desc,id);

create function memory_graph_job_operation_digest(
  transition memory_graph_background_job_transitions
) returns text language sql stable strict as $$
  select case transition.to_status
    when 'PENDING' then (select job.operation_key from memory_graph_background_jobs job
      where job.id=transition.job_id)
    when 'CLAIMED' then recall_manifest_digest(jsonb_build_object(
      'action','CLAIM','jobId',transition.job_id::text,'workerId',transition.worker_id,
      'leaseUntil',to_char(transition.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ))
    when 'COMPLETED' then recall_manifest_digest(jsonb_build_object(
      'action','COMPLETE','jobId',transition.job_id::text,'workerId',transition.worker_id,
      'resultMemoryIds',to_jsonb(transition.result_memory_ids::text[])
    ))
    else recall_manifest_digest(jsonb_build_object(
      'action','FAIL','jobId',transition.job_id::text,'workerId',transition.worker_id,
      'errorCode',transition.error_code,
      'retryAt',case when transition.retry_at is null then null else
        to_jsonb(to_char(transition.retry_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end
    )) end;
$$;

create function memory_graph_job_transition_body(
  transition memory_graph_background_job_transitions
) returns jsonb language sql stable strict as $$
  select case transition.to_status
    when 'PENDING' then (select jsonb_build_object(
      'jobId',job.id::text,'operationKey',job.operation_key,'actorRole',job.actor_role,
      'actorId',job.actor_id,'scopes',to_jsonb(job.authorized_scopes),
      'seedMemoryIds',to_jsonb(job.seed_memory_ids::text[]),
      'requestedDepth',job.requested_depth,'candidateLimit',job.candidate_limit,
      'asOf',to_char(job.as_of at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) from memory_graph_background_jobs job where job.id=transition.job_id)
    when 'CLAIMED' then jsonb_build_object(
      'jobId',transition.job_id::text,'fromStatus',transition.from_status,
      'toStatus',transition.to_status,'workerId',transition.worker_id,
      'leaseUntil',to_char(transition.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    when 'COMPLETED' then jsonb_build_object(
      'jobId',transition.job_id::text,'fromStatus',transition.from_status,
      'toStatus',transition.to_status,'workerId',transition.worker_id,
      'resultMemoryIds',to_jsonb(transition.result_memory_ids::text[])
    )
    when 'RETRY_SCHEDULED' then jsonb_build_object(
      'jobId',transition.job_id::text,'fromStatus',transition.from_status,
      'toStatus',transition.to_status,'workerId',transition.worker_id,
      'errorCode',transition.error_code,
      'retryAt',to_char(transition.retry_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    else jsonb_build_object(
      'jobId',transition.job_id::text,'fromStatus',transition.from_status,
      'toStatus',transition.to_status,'workerId',transition.worker_id,
      'errorCode',transition.error_code
    ) end;
$$;

create function memory_graph_expected_job_transition_body_digest(target_transition_id uuid)
returns text language sql stable strict as $$
  select recall_manifest_digest(memory_graph_job_transition_body(transition))
  from memory_graph_background_job_transitions transition where transition.id=target_transition_id;
$$;

create table memory_graph_job_transition_manifests (
  transition_id uuid primary key references memory_graph_background_job_transitions(id),
  job_id uuid not null references memory_graph_background_jobs(id),
  transition_event_id uuid not null unique references events(id),
  operation_digest char(64) not null check (operation_digest ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);
create index memory_graph_job_transition_manifests_job_idx
  on memory_graph_job_transition_manifests (job_id,created_at,transition_id);

create function validate_memory_graph_entity() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_reconciliation_runs run
    where run.id=new.first_reconciliation_run_id and run.scope=new.scope
      and run.account_id is not distinct from new.account_id
      and run.node_brain_id is not distinct from new.node_brain_id
      and run.conversation_id is not distinct from new.conversation_id
  ) then raise exception 'MEMORY_GRAPH_ENTITY_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_entity_is_consistent before insert on memory_graph_entities
for each row execute function validate_memory_graph_entity();

create function validate_memory_graph_idempotency_key() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_reconciliation_runs run
    where run.id=new.reconciliation_run_id and run.operation_key=new.operation_key
      and run.created_at<=new.created_at
  ) then raise exception 'MEMORY_GRAPH_IDEMPOTENCY_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_idempotency_key_is_consistent
before insert on memory_graph_idempotency_keys
for each row execute function validate_memory_graph_idempotency_key();

create function validate_memory_graph_alias() returns trigger language plpgsql as $$
declare prior_id uuid; prior_ordinal bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('memory-graph-entity:'||new.entity_id::text,0));
  select prior.id,prior.append_ordinal into prior_id,prior_ordinal
  from memory_graph_entity_aliases prior
  where prior.entity_id=new.entity_id and prior.alias_digest=new.alias_digest
  order by prior.append_ordinal desc limit 1;
  new.append_ordinal := coalesce(prior_ordinal,0)+1;
  if not exists (
    select 1 from memory_graph_entities entity
    join memory_graph_reconciliation_runs run on run.id=new.first_reconciliation_run_id
    where entity.id=new.entity_id and entity.scope=new.scope
      and entity.account_id is not distinct from new.account_id
      and entity.node_brain_id is not distinct from new.node_brain_id
      and entity.conversation_id is not distinct from new.conversation_id
      and run.scope=new.scope and run.account_id is not distinct from new.account_id
      and run.node_brain_id is not distinct from new.node_brain_id
      and run.conversation_id is not distinct from new.conversation_id
      and new.valid_from<=run.observed_at
      and (
        (new.supersedes_alias_id is null and prior_id is null)
        or new.supersedes_alias_id=prior_id
      )
  ) then raise exception 'MEMORY_GRAPH_ALIAS_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_alias_is_consistent before insert on memory_graph_entity_aliases
for each row execute function validate_memory_graph_alias();

create function validate_memory_graph_node() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_records memory
    join memory_graph_entities entity on entity.id=new.entity_id
    join memory_graph_reconciliation_runs run on run.id=new.first_reconciliation_run_id
    where memory.id=new.memory_id and memory.scope=new.scope and entity.scope=new.scope
      and run.scope=new.scope
      and memory.account_id is not distinct from new.account_id
      and entity.account_id is not distinct from new.account_id
      and run.account_id is not distinct from new.account_id
      and memory.node_brain_id is not distinct from new.node_brain_id
      and entity.node_brain_id is not distinct from new.node_brain_id
      and run.node_brain_id is not distinct from new.node_brain_id
      and memory.conversation_id is not distinct from new.conversation_id
      and entity.conversation_id is not distinct from new.conversation_id
      and run.conversation_id is not distinct from new.conversation_id
      and memory.valid_from=new.valid_from and memory.valid_to is not distinct from new.valid_to
      and memory.source_count=new.source_count
      and (not new.approved or exists (
        select 1 from memory_sources source
        join events event on event.id=source.source_event_id
        where source.memory_id=memory.id and (
          (new.scope='PRIVATE_ACCOUNT' and event.actor_type='USER'
            and event.actor_id=new.account_id::text)
          or (new.scope='NODE_BRANCH' and event.actor_type='NODE_BRAIN'
            and event.actor_id=new.node_brain_id::text)
          or (new.scope in ('MAIN_SHARED','PUBLIC') and event.actor_type='MAIN_BRAIN'
            and event.actor_id='gustavo-main')
          or (new.scope='CHALLENGE_SHARED' and (
            (event.actor_type='MAIN_BRAIN' and event.actor_id='gustavo-main')
            or (event.actor_type='SYSTEM' and event.actor_id='challenge-stage-lifecycle')))
          or (new.scope='AUDIT_ONLY' and event.actor_type='OPERATOR')
        )
      ))
  ) then raise exception 'MEMORY_GRAPH_NODE_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_node_is_consistent before insert on memory_graph_nodes
for each row execute function validate_memory_graph_node();

create function validate_memory_graph_node_source() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_nodes node
    join memory_sources source on source.memory_id=node.memory_id
    where node.memory_id=new.memory_id and source.source_event_id=new.source_event_id
      and source.ordinal=new.ordinal
  ) then raise exception 'MEMORY_GRAPH_NODE_SOURCE_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_node_source_is_consistent before insert on memory_graph_node_sources
for each row execute function validate_memory_graph_node_source();

create function validate_memory_graph_alias_source() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_entity_aliases alias
    join memory_graph_nodes node on node.entity_id=alias.entity_id
    join memory_graph_node_sources source on source.memory_id=node.memory_id
      and source.source_event_id=new.source_event_id
    where alias.id=new.alias_id
  ) then raise exception 'MEMORY_GRAPH_ALIAS_SOURCE_INVALID'; end if;
  return null;
end;
$$;
create constraint trigger memory_graph_alias_source_is_consistent
after insert on memory_graph_alias_sources deferrable initially deferred
for each row execute function validate_memory_graph_alias_source();

create or replace function validate_memory_graph_edge() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_nodes source
    join memory_graph_nodes target on target.memory_id=new.target_memory_id
    join memory_graph_reconciliation_runs run on run.id=new.first_reconciliation_run_id
    where source.memory_id=new.source_memory_id and source.scope=new.scope
      and target.scope=new.scope and run.scope=new.scope
      and source.account_id is not distinct from new.account_id
      and target.account_id is not distinct from new.account_id
      and run.account_id is not distinct from new.account_id
      and source.node_brain_id is not distinct from new.node_brain_id
      and target.node_brain_id is not distinct from new.node_brain_id
      and run.node_brain_id is not distinct from new.node_brain_id
      and source.conversation_id is not distinct from new.conversation_id
      and target.conversation_id is not distinct from new.conversation_id
      and run.conversation_id is not distinct from new.conversation_id
      and new.provenance_kind='RECONCILED'
      and new.source_count=(
        select count(distinct source_event_id)
        from memory_graph_node_sources
        where memory_id in (source.memory_id,target.memory_id)
      )
      and (
        (new.type='CONTRADICTS'
          and source.entity_id=target.entity_id
          and source.predicate_digest=target.predicate_digest
          and source.value_digest<>target.value_digest
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
        or (new.type='SUPERSEDES' and source.approved
          and source.entity_id=target.entity_id
          and source.predicate_digest=target.predicate_digest
          and source.value_digest<>target.value_digest
          and source.valid_from>=target.valid_from
          and new.valid_from=source.valid_from
          and new.valid_to is not distinct from source.valid_to)
        or (new.type='MENTIONS' and source.entity_id<>target.entity_id
          and exists (
            select 1 from memory_records source_memory
            join memory_records target_memory
              on target_memory.extraction_run_id=source_memory.extraction_run_id
            where source_memory.id=source.memory_id and target_memory.id=target.memory_id
          )
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
        or (new.type='SUPPORTS' and source.approved and target.approved
          and source.entity_id=target.entity_id
          and source.predicate_digest=target.predicate_digest
          and source.value_digest=target.value_digest
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
        or (new.type='DERIVED_FROM'
          and exists (select 1 from memory_records derived
            where derived.id=source.memory_id and derived.supersedes_memory_id=target.memory_id)
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
        or (new.type in ('PROPOSED_BY','ACCEPTED_INTO') and exists (
            select 1 from proposals proposal
            join memory_sources proposed on proposed.memory_id=source.memory_id
              and proposed.source_event_id=proposal.route_event_id
            join memory_sources cited on cited.memory_id=target.memory_id
              and proposal.source_event_ids ? cited.source_event_id::text
            where new.type='PROPOSED_BY' or (select transition.to_status
              from proposal_status_transitions transition
              where transition.proposal_id=proposal.id
              order by transition.ordinal desc limit 1)='ACCEPTED'
          )
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
        or (new.type='AFFECTED' and exists (
            select 1 from proposals proposal
            join memory_sources proposed on proposed.memory_id=source.memory_id
              and proposed.source_event_id=proposal.route_event_id
            join memory_sources affected_source on affected_source.memory_id=target.memory_id
              and proposal.source_event_ids ? affected_source.source_event_id::text
            where jsonb_array_length(proposal.affected_main_state_ids)>0
          )
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
        or (new.type='RESULTED_IN' and exists (
            select 1 from memory_sources result_source
            join events result_event on result_event.id=result_source.source_event_id
            join memory_sources cause_source on cause_source.memory_id=target.memory_id
              and cause_source.source_event_id=result_event.causation_id
            where result_source.memory_id=source.memory_id
          )
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
        or (new.type='SIMILAR_TO' and exists (
            select 1 from memory_equivalence_links equivalent
            where (equivalent.memory_id=source.memory_id
                and equivalent.equivalent_memory_id=target.memory_id)
              or (equivalent.memory_id=target.memory_id
                and equivalent.equivalent_memory_id=source.memory_id)
          )
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
        or (new.type='PART_OF' and exists (
            select 1 from memory_records part
            join memory_records episode on episode.extraction_run_id=part.extraction_run_id
              and episode.type='EPISODIC'
            where part.id=source.memory_id and episode.id=target.memory_id
          )
          and source.valid_from<coalesce(target.valid_to,'infinity'::timestamptz)
          and target.valid_from<coalesce(source.valid_to,'infinity'::timestamptz)
          and new.valid_from=greatest(source.valid_from,target.valid_from)
          and new.valid_to is not distinct from nullif(least(
            coalesce(source.valid_to,'infinity'::timestamptz),
            coalesce(target.valid_to,'infinity'::timestamptz)
          ),'infinity'::timestamptz))
      )
  ) then raise exception 'MEMORY_GRAPH_EDGE_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;

create function validate_memory_graph_edge_source() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_edges edge
    join memory_graph_node_sources source on source.memory_id in (
      edge.source_memory_id,edge.target_memory_id
    ) and source.source_event_id=new.source_event_id
    where edge.id=new.edge_id
  ) then raise exception 'MEMORY_GRAPH_EDGE_SOURCE_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_edge_source_is_consistent before insert on memory_graph_edge_sources
for each row execute function validate_memory_graph_edge_source();

create function validate_memory_conflict() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_nodes newer
    join memory_graph_nodes older on older.memory_id=new.older_memory_id
    join memory_graph_nodes preferred on preferred.memory_id=new.preferred_memory_id
    join memory_graph_reconciliation_runs run on run.id=new.first_reconciliation_run_id
    join memory_graph_edges edge on edge.source_memory_id=new.newer_memory_id
      and edge.target_memory_id=new.older_memory_id and edge.type='CONTRADICTS'
    where newer.memory_id=new.newer_memory_id and newer.entity_id=new.entity_id
      and older.entity_id=new.entity_id and preferred.entity_id=new.entity_id
      and newer.predicate_digest=new.predicate_digest
      and older.predicate_digest=new.predicate_digest
      and preferred.predicate_digest=new.predicate_digest
      and newer.scope=new.scope and older.scope=new.scope and preferred.scope=new.scope
      and run.scope=new.scope
      and newer.account_id is not distinct from new.account_id
      and older.account_id is not distinct from new.account_id
      and preferred.account_id is not distinct from new.account_id
      and run.account_id is not distinct from new.account_id
      and newer.node_brain_id is not distinct from new.node_brain_id
      and older.node_brain_id is not distinct from new.node_brain_id
      and preferred.node_brain_id is not distinct from new.node_brain_id
      and run.node_brain_id is not distinct from new.node_brain_id
      and newer.conversation_id is not distinct from new.conversation_id
      and older.conversation_id is not distinct from new.conversation_id
      and preferred.conversation_id is not distinct from new.conversation_id
      and run.conversation_id is not distinct from new.conversation_id
      and newer.valid_from>=older.valid_from
      and new.source_count=(
        select count(distinct source_event_id)
        from memory_graph_node_sources
        where memory_id in (newer.memory_id,older.memory_id)
      )
  ) then raise exception 'MEMORY_CONFLICT_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_conflict_is_consistent before insert on memory_conflicts
for each row execute function validate_memory_conflict();

create function validate_memory_conflict_source() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_conflicts conflict
    join memory_graph_node_sources source on source.memory_id in (
      conflict.newer_memory_id,conflict.older_memory_id
    ) and source.source_event_id=new.source_event_id
    where conflict.id=new.conflict_id
  ) then raise exception 'MEMORY_CONFLICT_SOURCE_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_conflict_source_is_consistent before insert on memory_conflict_sources
for each row execute function validate_memory_conflict_source();

create function validate_memory_graph_run_member() returns trigger language plpgsql as $$
declare member jsonb;
begin
  member := to_jsonb(new);
  if tg_table_name='memory_graph_run_entities' and not exists (
    select 1 from memory_graph_reconciliation_runs run
    join memory_graph_entities entity on entity.id=(member->>'entity_id')::uuid
    where run.id=(member->>'reconciliation_run_id')::uuid and run.scope=entity.scope
      and run.account_id is not distinct from entity.account_id
      and run.node_brain_id is not distinct from entity.node_brain_id
      and run.conversation_id is not distinct from entity.conversation_id
  ) then raise exception 'MEMORY_GRAPH_RUN_MEMBER_INVALID';
  elsif tg_table_name='memory_graph_run_aliases' and not exists (
    select 1 from memory_graph_reconciliation_runs run
    join memory_graph_entity_aliases alias on alias.id=(member->>'alias_id')::uuid
    where run.id=(member->>'reconciliation_run_id')::uuid and run.scope=alias.scope
      and run.account_id is not distinct from alias.account_id
      and run.node_brain_id is not distinct from alias.node_brain_id
      and run.conversation_id is not distinct from alias.conversation_id
  ) then raise exception 'MEMORY_GRAPH_RUN_MEMBER_INVALID';
  elsif tg_table_name='memory_graph_run_candidates' and not exists (
    select 1 from memory_graph_reconciliation_runs run
    join memory_graph_nodes node on node.memory_id=(member->>'memory_id')::uuid
    where run.id=(member->>'reconciliation_run_id')::uuid and run.scope=node.scope
      and run.account_id is not distinct from node.account_id
      and run.node_brain_id is not distinct from node.node_brain_id
      and run.conversation_id is not distinct from node.conversation_id
  ) then raise exception 'MEMORY_GRAPH_RUN_MEMBER_INVALID';
  elsif tg_table_name='memory_graph_run_edges' and not exists (
    select 1 from memory_graph_reconciliation_runs run
    join memory_graph_edges edge on edge.id=(member->>'edge_id')::uuid
    where run.id=(member->>'reconciliation_run_id')::uuid and run.scope=edge.scope
      and run.account_id is not distinct from edge.account_id
      and run.node_brain_id is not distinct from edge.node_brain_id
      and run.conversation_id is not distinct from edge.conversation_id
  ) then raise exception 'MEMORY_GRAPH_RUN_MEMBER_INVALID';
  elsif tg_table_name='memory_graph_run_conflicts' and not exists (
    select 1 from memory_graph_reconciliation_runs run
    join memory_conflicts conflict on conflict.id=(member->>'conflict_id')::uuid
    where run.id=(member->>'reconciliation_run_id')::uuid and run.scope=conflict.scope
      and run.account_id is not distinct from conflict.account_id
      and run.node_brain_id is not distinct from conflict.node_brain_id
      and run.conversation_id is not distinct from conflict.conversation_id
  ) then raise exception 'MEMORY_GRAPH_RUN_MEMBER_INVALID';
  end if;
  return new;
end;
$$;
create trigger memory_graph_run_entity_is_consistent before insert on memory_graph_run_entities
for each row execute function validate_memory_graph_run_member();
create trigger memory_graph_run_alias_is_consistent before insert on memory_graph_run_aliases
for each row execute function validate_memory_graph_run_member();
create trigger memory_graph_run_candidate_is_consistent before insert on memory_graph_run_candidates
for each row execute function validate_memory_graph_run_member();
create trigger memory_graph_run_edge_is_consistent before insert on memory_graph_run_edges
for each row execute function validate_memory_graph_run_member();
create trigger memory_graph_run_conflict_is_consistent before insert on memory_graph_run_conflicts
for each row execute function validate_memory_graph_run_member();

create function validate_memory_graph_current_claim() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_run_candidates candidate
    join memory_graph_nodes node on node.memory_id=candidate.memory_id
    where candidate.reconciliation_run_id=new.reconciliation_run_id
      and candidate.memory_id=new.memory_id and node.entity_id=new.entity_id
      and node.predicate_digest=new.predicate_digest
  ) then raise exception 'MEMORY_GRAPH_CURRENT_CLAIM_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_current_claim_is_consistent
before insert on memory_graph_current_claims
for each row execute function validate_memory_graph_current_claim();

create function validate_memory_graph_background_job() returns trigger language plpgsql as $$
begin
  if new.actor_role='ACCOUNT' then
    if new.authorized_scopes<>array[
      'CHALLENGE_SHARED','MAIN_SHARED','NODE_BRANCH','PRIVATE_ACCOUNT','PUBLIC'
    ]::text[] then raise exception 'MEMORY_GRAPH_BACKGROUND_AUTHORITY_INVALID'; end if;
    perform 1 from accounts account
      join entitlements entitlement on entitlement.account_id=account.id
        and entitlement.revoked_at is null and entitlement.active_from<=new.created_at
        and (entitlement.expires_at is null or entitlement.expires_at>new.created_at)
      join node_brains node on node.id=new.node_brain_id and node.account_id=account.id
        and node.status='ACTIVE'
      join conversations conversation on conversation.id=new.conversation_id
        and conversation.account_id=account.id and conversation.node_brain_id=node.id
        and conversation.status='OPEN'
      where account.id=new.account_id and account.status='ACTIVE'
      for update of account,entitlement,node,conversation;
    if not found then raise exception 'MEMORY_GRAPH_BACKGROUND_AUTHORITY_INVALID'; end if;
  else
    perform 1 from recall_actor_authorities authority
    where authority.role=new.actor_role and authority.actor_id=new.actor_id and authority.active
      and new.authorized_scopes<@authority.scopes
      and not new.authorized_scopes && array['PRIVATE_ACCOUNT','NODE_BRANCH']::text[]
    for update;
    if not found then raise exception 'MEMORY_GRAPH_BACKGROUND_AUTHORITY_INVALID'; end if;
  end if;
  if not exists (
    select 1 from events event
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
      and outbox.topic='memory.graph.background.queued'
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
    where event.id=new.queued_event_id
      and event.aggregate_id='memory-graph-job:'||new.id::text
      and event.type='memory.graph.background.queued'
      and event.actor_type='SYSTEM' and event.actor_id='memory-graph-scheduler'
      and body.body_digest=recall_manifest_digest(jsonb_build_object(
        'jobId',new.id::text,'operationKey',new.operation_key,'actorRole',new.actor_role,
        'actorId',new.actor_id,'scopes',to_jsonb(new.authorized_scopes),
        'seedMemoryIds',to_jsonb(new.seed_memory_ids::text[]),
        'requestedDepth',new.requested_depth,'candidateLimit',new.candidate_limit,
        'asOf',to_char(new.as_of at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ))
  ) then raise exception 'MEMORY_GRAPH_BACKGROUND_EVENT_INVALID'; end if;
  if exists (
    select 1 from unnest(new.seed_memory_ids) seed(id)
    left join memory_records memory on memory.id=seed.id
      and (
        (new.actor_role='ACCOUNT' and (
          memory.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
          or (memory.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
            and memory.account_id=new.account_id and memory.node_brain_id=new.node_brain_id
            and memory.conversation_id=new.conversation_id)))
        or (new.actor_role<>'ACCOUNT' and memory.scope=any(new.authorized_scopes))
      )
    where memory.id is null
  ) then raise exception 'MEMORY_GRAPH_BACKGROUND_SEED_FORBIDDEN'; end if;
  return new;
end;
$$;
create trigger memory_graph_background_job_is_consistent
before insert on memory_graph_background_jobs
for each row execute function validate_memory_graph_background_job();

create function validate_memory_graph_reconciliation_job()
returns trigger language plpgsql as $$
begin
  if new.candidate_count<>cardinality(new.candidate_memory_ids)
    or not exists (
      select 1 from events event
      join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
      join transactional_outbox outbox on outbox.event_id=event.id
        and outbox.topic='memory.graph.reconciliation.queued'
        and outbox.payload=jsonb_build_object('eventId',event.id::text)
      where event.id=new.request_event_id
        and event.aggregate_id=case when new.conversation_id is not null
          then new.conversation_id::text else 'memory-graph:'||new.scope end
        and event.account_id is not distinct from new.account_id::text
        and event.actor_type='SYSTEM' and event.actor_id='memory-graph-reconciler'
        and event.type='memory.graph.reconciliation.queued'
        and event.visibility=case
          when new.scope='PUBLIC' then 'PUBLIC'
          when new.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') then 'PRIVATE_ACCOUNT'
          when new.scope='AUDIT_ONLY' then 'OPERATOR' else 'SHARED' end
        and event.policy_version='memory-graph-v1'
        and event.idempotency_key='memory-graph-reconciliation-job:'||new.operation_key
        and event.occurred_at=new.created_at
    ) or exists (
      select 1 from unnest(new.candidate_memory_ids) candidate(memory_id)
      left join memory_records memory on memory.id=candidate.memory_id and (
        (new.account_id is not null and memory.account_id=new.account_id
          and memory.node_brain_id=new.node_brain_id and memory.conversation_id=new.conversation_id
          and memory.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH'))
        or (new.account_id is null and memory.scope=new.scope)
      ) where memory.id is null
    ) or exists (
      select 1 from unnest(new.source_event_ids) source(event_id)
      left join events event on event.id=source.event_id
      where event.id is null
    )
  then raise exception 'MEMORY_GRAPH_RECONCILIATION_JOB_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_reconciliation_job_is_consistent
before insert on memory_graph_reconciliation_jobs
for each row execute function validate_memory_graph_reconciliation_job();

create function validate_memory_graph_reconciliation_job_manifest()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_reconciliation_jobs job
    join events event on event.id=job.request_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
      and outbox.topic=event.type and outbox.payload=jsonb_build_object('eventId',event.id::text)
    where job.id=new.job_id and job.request_event_id=new.request_event_id
      and job.operation_key=new.operation_key and body.body_digest=new.body_digest
      and body.body_digest=memory_graph_expected_reconciliation_job_body_digest(job.id)
      and event.request_hash=new.event_request_hash
      and event.integrity_hash=new.event_integrity_hash and job.created_at=new.created_at
  ) then raise exception 'MEMORY_GRAPH_RECONCILIATION_JOB_MANIFEST_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_reconciliation_job_manifest_is_consistent
before insert on memory_graph_reconciliation_job_manifests
for each row execute function validate_memory_graph_reconciliation_job_manifest();

create function require_memory_graph_reconciliation_job_manifest()
returns trigger language plpgsql as $$
begin
  if (select count(*) from memory_graph_reconciliation_job_entities where job_id=new.id)=0
    or (select count(*) from memory_graph_reconciliation_job_candidates where job_id=new.id)
      <>new.candidate_count
    or (select array_agg(candidate.memory_id order by candidate.ordinal)
        from memory_graph_reconciliation_job_candidates candidate where candidate.job_id=new.id)
      <>new.candidate_memory_ids
    or (select array_agg(source.source_event_id order by source.source_event_id)
        from memory_graph_reconciliation_job_sources source where source.job_id=new.id)
      <>new.source_event_ids
    or exists (
      select 1 from memory_graph_reconciliation_job_source_sets source_set
      where source_set.job_id=new.id and (
        cardinality(source_set.source_ordinals)<>cardinality(
          array(select distinct ordinal from unnest(source_set.source_ordinals) ordinal)
        ) or exists (select 1 from unnest(source_set.source_ordinals) source_ordinal
          where not exists (select 1 from memory_graph_reconciliation_job_sources source
            where source.job_id=source_set.job_id and source.ordinal=source_ordinal))
        or source_set.source_digest<>recall_manifest_digest(jsonb_build_object(
          'sourceIds',coalesce((select jsonb_agg(source.source_event_id::text order by mapping.position)
            from unnest(source_set.source_ordinals) with ordinality mapping(source_ordinal,position)
            join memory_graph_reconciliation_job_sources source
              on source.job_id=source_set.job_id and source.ordinal=mapping.source_ordinal
          ),'[]'::jsonb)
        ))
      )
    )
    or exists (
      select 1 from memory_graph_reconciliation_job_candidates candidate
      join memory_records memory on memory.id=candidate.memory_id
      where candidate.job_id=new.id and (
        memory.scope<>new.scope or memory.account_id is distinct from new.account_id
        or memory.node_brain_id is distinct from new.node_brain_id
        or memory.conversation_id is distinct from new.conversation_id
        or memory.valid_from<>candidate.valid_from
        or memory.valid_to is distinct from candidate.valid_to
        or candidate.source_count<>(select source_set.source_count
          from memory_graph_reconciliation_job_source_sets source_set
          where source_set.job_id=candidate.job_id
            and source_set.ordinal=candidate.source_set_ordinal)
        or (select array_agg(source.source_event_id order by mapping.position)
          from memory_graph_reconciliation_job_source_sets source_set
          cross join lateral unnest(source_set.source_ordinals) with ordinality
            mapping(source_ordinal,position)
          join memory_graph_reconciliation_job_sources source
            on source.job_id=source_set.job_id and source.ordinal=mapping.source_ordinal
          where source_set.job_id=candidate.job_id
            and source_set.ordinal=candidate.source_set_ordinal
        )<>(select array_agg(authority.source_event_id order by authority.ordinal)
          from memory_sources authority where authority.memory_id=candidate.memory_id)
      )
    ) or exists (
      select 1 from memory_graph_reconciliation_job_aliases alias
      join memory_graph_reconciliation_job_source_sets source_set
        on source_set.job_id=alias.job_id and source_set.ordinal=alias.source_set_ordinal
      where alias.job_id=new.id and (
        alias.source_count<>source_set.source_count
        or not source_set.source_ordinals<@coalesce((
          select array_agg(distinct candidate_mapping.source_ordinal)
          from memory_graph_reconciliation_job_candidates candidate
          join memory_graph_reconciliation_job_source_sets candidate_set
            on candidate_set.job_id=candidate.job_id
            and candidate_set.ordinal=candidate.source_set_ordinal
          cross join lateral unnest(candidate_set.source_ordinals)
            candidate_mapping(source_ordinal)
          where candidate.job_id=alias.job_id and candidate.entity_id=alias.entity_id
        ),array[]::integer[])
      )
    ) or not exists (
      select 1 from memory_graph_reconciliation_job_manifests manifest
      where manifest.job_id=new.id and manifest.request_event_id=new.request_event_id
      and manifest.operation_key=new.operation_key and manifest.created_at=new.created_at
    ) or not exists (
      select 1 from memory_graph_reconciliation_job_transitions transition
      join memory_graph_reconciliation_job_transition_manifests manifest
        on manifest.transition_id=transition.id and manifest.transition_event_id=new.request_event_id
      where transition.job_id=new.id and transition.ordinal=0 and transition.action='QUEUE'
        and transition.from_status is null and transition.to_status='PENDING'
        and transition.edge_offset=0 and transition.edge_source_offset=0
        and transition.operation_digest=new.operation_key
    ) then raise exception 'INCOMPLETE_MEMORY_GRAPH_RECONCILIATION_JOB'; end if;
  return null;
end;
$$;
create constraint trigger memory_graph_reconciliation_job_is_complete
after insert on memory_graph_reconciliation_jobs deferrable initially deferred
for each row execute function require_memory_graph_reconciliation_job_manifest();

create function validate_memory_graph_reconciliation_job_transition()
returns trigger language plpgsql as $$
declare prior memory_graph_reconciliation_job_transitions%rowtype;
  owner_job memory_graph_reconciliation_jobs%rowtype;
  event_type text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'memory-graph-reconciliation-job:'||new.job_id::text,0));
  if new.created_at<>date_trunc('milliseconds',transaction_timestamp()) and new.action<>'QUEUE'
  then raise exception 'MEMORY_GRAPH_RECONCILIATION_JOB_CLOCK_INVALID'; end if;
  select * into owner_job from memory_graph_reconciliation_jobs where id=new.job_id for update;
  if owner_job.id is null then raise exception 'MEMORY_GRAPH_RECONCILIATION_TRANSITION_INVALID'; end if;
  if new.action<>'QUEUE' and not memory_graph_reconciliation_job_envelope_is_valid(new.job_id)
  then raise exception 'MEMORY_GRAPH_RECONCILIATION_EVENT_BODY_INVALID'; end if;
  if owner_job.account_id is not null then
    perform 1 from accounts account
    join entitlements entitlement on entitlement.account_id=account.id
      and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
      and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
    join node_brains node on node.id=owner_job.node_brain_id and node.account_id=account.id
      and node.status='ACTIVE'
    join conversations conversation on conversation.id=owner_job.conversation_id
      and conversation.account_id=account.id and conversation.node_brain_id=node.id
      and conversation.status='OPEN'
    where account.id=owner_job.account_id and account.status='ACTIVE'
    for update of account,entitlement,node,conversation;
    if not found then raise exception 'MEMORY_GRAPH_RECONCILIATION_OWNER_FORBIDDEN'; end if;
  end if;
  select * into prior from memory_graph_reconciliation_job_transitions
  where job_id=new.job_id order by ordinal desc limit 1;
  event_type:=case new.action when 'QUEUE' then 'memory.graph.reconciliation.queued'
    when 'CLAIM' then 'memory.graph.reconciliation.claimed'
    when 'PROGRESS' then 'memory.graph.reconciliation.progressed'
    when 'COMPLETE' then 'memory.graph.reconciliation.completed'
    else case when new.to_status='RETRY_SCHEDULED'
      then 'memory.graph.reconciliation.retry_scheduled'
      else 'memory.graph.reconciliation.failed' end end;
  if not exists (
    select 1 from events event
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id and outbox.topic=event.type
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
    where event.id=new.transition_event_id
      and event.aggregate_id=case when owner_job.conversation_id is not null
        then owner_job.conversation_id::text else 'memory-graph:'||owner_job.scope end
      and event.account_id is not distinct from owner_job.account_id::text
      and event.actor_type='SYSTEM'
      and event.actor_id=case when new.action='QUEUE' then 'memory-graph-reconciler'
        else 'memory-graph-worker' end
      and event.type=event_type
      and event.visibility=case
        when owner_job.scope='PUBLIC' then 'PUBLIC'
        when owner_job.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH') then 'PRIVATE_ACCOUNT'
        when owner_job.scope='AUDIT_ONLY' then 'OPERATOR' else 'SHARED' end
      and event.occurred_at=new.created_at
      and event.idempotency_key=case when new.action='QUEUE'
        then 'memory-graph-reconciliation-job:'||owner_job.operation_key
        else 'memory-graph-reconciliation-transition:'||new.idempotency_key||':'||new.operation_digest end
      and body.body_digest=recall_manifest_digest(
        memory_graph_reconciliation_job_transition_body(new))
  ) or new.operation_digest<>memory_graph_reconciliation_job_transition_operation_digest(new)
    or new.edge_offset>owner_job.estimated_edge_count
    or new.edge_source_offset>owner_job.estimated_edge_source_count
    or not (
      (new.action='QUEUE' and new.to_status='PENDING' and new.worker_id is null
        and new.lease_until is null and new.retry_at is null and new.error_code is null
        and new.edge_offset=0 and new.edge_source_offset=0)
      or (new.action='CLAIM' and new.to_status='CLAIMED' and new.worker_id is not null
        and new.lease_until>clock_timestamp() and new.retry_at is null and new.error_code is null)
      or (new.action='PROGRESS' and new.to_status='CLAIMED' and new.worker_id is not null
        and new.lease_until>clock_timestamp() and new.retry_at is null and new.error_code is null)
      or (new.action='COMPLETE' and new.to_status='COMPLETED' and new.worker_id is not null
        and new.lease_until is null and new.retry_at is null and new.error_code is null
        and new.edge_offset=owner_job.estimated_edge_count
        and new.edge_source_offset=owner_job.estimated_edge_source_count)
      or (new.action='FAIL' and new.to_status in ('RETRY_SCHEDULED','FAILED')
        and new.worker_id is not null and new.lease_until is null
        and length(trim(new.error_code)) between 1 and 128
        and ((new.to_status='RETRY_SCHEDULED' and new.retry_at>clock_timestamp())
          or (new.to_status='FAILED' and new.retry_at is null)))
    ) or (prior.id is null and not (
      new.ordinal=0 and new.action='QUEUE' and new.from_status is null
        and new.transition_event_id=owner_job.request_event_id and new.created_at=owner_job.created_at
    )) or (prior.id is not null and not (
      new.ordinal=prior.ordinal+1 and new.from_status=prior.to_status
      and new.edge_offset>=prior.edge_offset and new.edge_source_offset>=prior.edge_source_offset
      and (
        (new.action='CLAIM' and (
          prior.to_status='PENDING'
          or (prior.to_status='RETRY_SCHEDULED' and prior.retry_at<=clock_timestamp())
          or (prior.to_status='CLAIMED' and prior.lease_until<=clock_timestamp())
        ))
        or (prior.to_status='CLAIMED' and new.action in ('PROGRESS','COMPLETE','FAIL')
          and prior.worker_id=new.worker_id and prior.lease_until>clock_timestamp()
          and (new.action<>'PROGRESS' or new.lease_until=prior.lease_until)
          and (new.action<>'PROGRESS' or new.edge_offset>prior.edge_offset
            or new.edge_source_offset>prior.edge_source_offset))
      )
    )) then raise exception 'MEMORY_GRAPH_RECONCILIATION_TRANSITION_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_reconciliation_job_transition_is_consistent
before insert on memory_graph_reconciliation_job_transitions
for each row execute function validate_memory_graph_reconciliation_job_transition();

create function validate_memory_graph_reconciliation_job_transition_manifest()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_reconciliation_job_transitions transition
    join events event on event.id=transition.transition_event_id
    join encrypted_event_bodies body on body.event_id=event.id
    where transition.id=new.transition_id and transition.job_id=new.job_id
      and transition.transition_event_id=new.transition_event_id
      and transition.operation_digest=new.operation_digest
      and body.body_digest=new.body_digest
      and body.body_digest=memory_graph_expected_reconciliation_job_transition_body_digest(transition.id)
      and event.request_hash=new.event_request_hash
      and event.integrity_hash=new.event_integrity_hash
      and transition.created_at=new.created_at
  ) then raise exception 'MEMORY_GRAPH_RECONCILIATION_TRANSITION_MANIFEST_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_reconciliation_job_transition_manifest_is_consistent
before insert on memory_graph_reconciliation_job_transition_manifests
for each row execute function validate_memory_graph_reconciliation_job_transition_manifest();

create function require_memory_graph_reconciliation_job_transition_manifest()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_reconciliation_job_transition_manifests manifest
    where manifest.transition_id=new.id and manifest.job_id=new.job_id
      and manifest.transition_event_id=new.transition_event_id
      and manifest.operation_digest=new.operation_digest and manifest.created_at=new.created_at
  ) then raise exception 'INCOMPLETE_MEMORY_GRAPH_RECONCILIATION_TRANSITION'; end if;
  return null;
end;
$$;
create constraint trigger memory_graph_reconciliation_job_transition_is_complete
after insert on memory_graph_reconciliation_job_transitions deferrable initially deferred
for each row execute function require_memory_graph_reconciliation_job_transition_manifest();

create function validate_memory_graph_reconciliation_complete() returns trigger language plpgsql as $$
begin
  if (select count(*) from memory_graph_run_candidates where reconciliation_run_id=new.id)
       <>new.candidate_count
    or new.graph_event_id is null
    or new.graph_event_request_hash is null
    or new.graph_event_integrity_hash is null
    or not exists (
      select 1 from events event
      join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
      join transactional_outbox outbox on outbox.event_id=event.id
        and outbox.topic='memory.edge.versioned'
        and outbox.payload=jsonb_build_object('eventId',event.id::text)
      join memory_graph_event_manifests manifest on manifest.graph_event_id=event.id
        and manifest.reconciliation_run_id=new.id
      where event.id=new.graph_event_id and event.type='memory.edge.versioned'
        and event.actor_type='SYSTEM' and event.actor_id='memory-graph-reconciler'
        and event.request_hash=new.graph_event_request_hash
        and event.integrity_hash=new.graph_event_integrity_hash
        and manifest.event_request_hash=event.request_hash
        and manifest.event_integrity_hash=event.integrity_hash
        and manifest.semantic_digest=new.operation_key
        and manifest.relation_count=new.edge_count
        and manifest.relation_digest=memory_graph_relation_digest(new.id)
        and body.body_digest=memory_graph_expected_event_body_digest(new.id)
        and manifest.body_digest=body.body_digest
        and memory_graph_event_envelope_is_valid(new.id,event.id)
        and cardinality(manifest.memory_ids)=new.candidate_count
        and cardinality(manifest.source_event_ids)=(
          select count(distinct source.source_event_id)
          from memory_graph_run_candidates candidate
          join memory_graph_node_sources source on source.memory_id=candidate.memory_id
          where candidate.reconciliation_run_id=new.id
        )
        and not exists (
          select 1 from unnest(manifest.memory_ids) listed(memory_id)
          where not exists (
            select 1 from memory_graph_run_candidates candidate
            where candidate.reconciliation_run_id=new.id and candidate.memory_id=listed.memory_id
          )
        )
        and not exists (
          select 1 from memory_graph_run_candidates candidate
          where candidate.reconciliation_run_id=new.id
            and candidate.memory_id<>all(manifest.memory_ids)
        )
        and not exists (
          select 1 from unnest(manifest.source_event_ids) listed(source_event_id)
          where not exists (
            select 1 from memory_graph_run_candidates candidate
            join memory_graph_node_sources source on source.memory_id=candidate.memory_id
            where candidate.reconciliation_run_id=new.id
              and source.source_event_id=listed.source_event_id
          )
        )
        and not exists (
          select 1 from memory_graph_run_candidates candidate
          join memory_graph_node_sources source on source.memory_id=candidate.memory_id
          where candidate.reconciliation_run_id=new.id
            and source.source_event_id<>all(manifest.source_event_ids)
        )
    )
    or not exists (
      select 1 from memory_graph_idempotency_keys key
      where key.reconciliation_run_id=new.id and key.idempotency_key=new.idempotency_key
        and key.operation_key=new.operation_key and key.request_digest=new.request_digest
    )
    or (select count(*) from memory_graph_run_entities where reconciliation_run_id=new.id)
       <>new.entity_count
    or (select count(*) from memory_graph_entity_versions where reconciliation_run_id=new.id)
       <>new.entity_count
    or exists (
      select 1 from memory_graph_run_entities entity_member
      where entity_member.reconciliation_run_id=new.id and not exists (
        select 1 from memory_graph_run_candidates candidate
        join memory_graph_nodes node on node.memory_id=candidate.memory_id
        where candidate.reconciliation_run_id=new.id
          and node.entity_id=entity_member.entity_id
      )
    )
    or exists (
      select 1 from memory_graph_run_candidates candidate
      join memory_graph_nodes node on node.memory_id=candidate.memory_id
      where candidate.reconciliation_run_id=new.id and not exists (
        select 1 from memory_graph_run_entities entity_member
        where entity_member.reconciliation_run_id=new.id
          and entity_member.entity_id=node.entity_id
      )
    )
    or (select count(*) from memory_graph_run_aliases where reconciliation_run_id=new.id)
       <>new.alias_count
    or (select count(*) from memory_graph_run_edges where reconciliation_run_id=new.id)
       <>new.edge_count
    or (select count(*) from memory_graph_run_conflicts where reconciliation_run_id=new.id)
       <>new.conflict_count
    or (select count(*) from memory_graph_current_claims where reconciliation_run_id=new.id)
       <>new.current_count
    or (select count(*) from (
         select node.entity_id,node.predicate_digest
         from memory_graph_run_candidates candidate
         join memory_graph_nodes node on node.memory_id=candidate.memory_id
         where candidate.reconciliation_run_id=new.id
         group by node.entity_id,node.predicate_digest
       ) grouped)<>new.current_count
    or exists (
      select 1 from memory_graph_current_claims current
      where current.reconciliation_run_id=new.id and current.memory_id<>(
        select candidate_node.memory_id
        from memory_graph_run_candidates candidate
        join memory_graph_nodes candidate_node on candidate_node.memory_id=candidate.memory_id
        where candidate.reconciliation_run_id=new.id
          and candidate_node.entity_id=current.entity_id
          and candidate_node.predicate_digest=current.predicate_digest
        order by case
          when candidate_node.valid_to is null and candidate_node.approved then 0
          when candidate_node.valid_to is null then 1
          when candidate_node.approved then 2
          else 3 end,
          candidate_node.valid_from desc,candidate_node.memory_id desc
        limit 1
      )
    )
    or exists (
      select 1
      from memory_graph_run_candidates newer_member
      join memory_graph_nodes newer on newer.memory_id=newer_member.memory_id
      join memory_graph_run_candidates older_member
        on older_member.reconciliation_run_id=newer_member.reconciliation_run_id
      join memory_graph_nodes older on older.memory_id=older_member.memory_id
      where newer_member.reconciliation_run_id=new.id
        and (newer.valid_from,newer.memory_id)>(older.valid_from,older.memory_id)
        and newer.entity_id=older.entity_id
        and newer.predicate_digest=older.predicate_digest
        and newer.value_digest<>older.value_digest
        and newer.valid_from<coalesce(older.valid_to,'infinity'::timestamptz)
        and older.valid_from<coalesce(newer.valid_to,'infinity'::timestamptz)
        and not exists (
          select 1 from memory_graph_run_edges mapped
          join memory_graph_edges edge on edge.id=mapped.edge_id
          where mapped.reconciliation_run_id=new.id and edge.type='CONTRADICTS'
            and edge.source_memory_id=newer.memory_id
            and edge.target_memory_id=older.memory_id
        )
    )
    or exists (
      select 1
      from memory_graph_current_claims current
      join memory_graph_nodes current_node on current_node.memory_id=current.memory_id
      join memory_graph_run_candidates older_member
        on older_member.reconciliation_run_id=current.reconciliation_run_id
      join memory_graph_nodes older on older.memory_id=older_member.memory_id
      where current.reconciliation_run_id=new.id and current_node.approved
        and (current_node.valid_from,current_node.memory_id)>(older.valid_from,older.memory_id)
        and current_node.entity_id=older.entity_id
        and current_node.predicate_digest=older.predicate_digest
        and current_node.value_digest<>older.value_digest
        and not exists (
          select 1 from memory_graph_run_edges mapped
          join memory_graph_edges edge on edge.id=mapped.edge_id
          where mapped.reconciliation_run_id=new.id and edge.type='SUPERSEDES'
            and edge.source_memory_id=current.memory_id
            and edge.target_memory_id=older.memory_id
        )
    )
    or exists (
      select 1 from memory_graph_run_edges mapped
      join memory_graph_edges edge on edge.id=mapped.edge_id
      where mapped.reconciliation_run_id=new.id and (
        not exists (
          select 1 from memory_graph_run_candidates candidate
          where candidate.reconciliation_run_id=new.id
            and candidate.memory_id=edge.source_memory_id
        )
        or not exists (
          select 1 from memory_graph_run_candidates candidate
          where candidate.reconciliation_run_id=new.id
            and candidate.memory_id=edge.target_memory_id
        )
        or (edge.type='SUPERSEDES' and not exists (
          select 1 from memory_graph_current_claims current
          where current.reconciliation_run_id=new.id
            and current.memory_id=edge.source_memory_id
        ))
      )
    )
    or exists (
      select 1
      from memory_graph_run_edges edge_member
      join memory_graph_edges edge on edge.id=edge_member.edge_id and edge.type='CONTRADICTS'
      where edge_member.reconciliation_run_id=new.id and not exists (
        select 1 from memory_graph_run_conflicts conflict_member
        join memory_conflicts conflict on conflict.id=conflict_member.conflict_id
        where conflict_member.reconciliation_run_id=new.id
          and conflict.newer_memory_id=edge.source_memory_id
          and conflict.older_memory_id=edge.target_memory_id
          and conflict.predicate_digest=(
            select node.predicate_digest from memory_graph_nodes node
            where node.memory_id=edge.source_memory_id
          )
      )
    )
    or exists (
      select 1 from memory_graph_run_conflicts member
      join memory_conflicts conflict on conflict.id=member.conflict_id
      where member.reconciliation_run_id=new.id and (
        not exists (
          select 1 from memory_graph_run_edges edge_member
          join memory_graph_edges edge on edge.id=edge_member.edge_id
          where edge_member.reconciliation_run_id=new.id and edge.type='CONTRADICTS'
            and edge.source_memory_id=conflict.newer_memory_id
            and edge.target_memory_id=conflict.older_memory_id
        )
        or conflict.preferred_memory_id<>(
          select candidate_node.memory_id
          from memory_graph_nodes candidate_node
          where candidate_node.memory_id in (
            conflict.newer_memory_id,conflict.older_memory_id
          )
          order by case
            when candidate_node.valid_to is null and candidate_node.approved then 0
            when candidate_node.valid_to is null then 1
            when candidate_node.approved then 2
            else 3 end,
            candidate_node.valid_from desc,candidate_node.memory_id desc
          limit 1
        )
      )
    )
    or (select count(*) from memory_graph_head_versions where reconciliation_run_id=new.id)
       <>new.current_count
    or exists (
      select 1 from memory_graph_current_claims current
      where current.reconciliation_run_id=new.id and not exists (
        select 1 from memory_graph_head_versions head
        where head.reconciliation_run_id=new.id and head.memory_id=current.memory_id
          and head.entity_id=current.entity_id
          and head.predicate_digest=current.predicate_digest
      )
    )
    or exists (
      select 1 from memory_graph_run_candidates candidate
      join memory_graph_nodes node on node.memory_id=candidate.memory_id
      where candidate.reconciliation_run_id=new.id and (
        select count(*) from memory_graph_node_sources source
        where source.memory_id=node.memory_id
      )<>node.source_count
    )
    or exists (
      select 1 from memory_graph_run_aliases member
      join memory_graph_entity_aliases alias on alias.id=member.alias_id
      where member.reconciliation_run_id=new.id and (
        select count(*) from memory_graph_alias_sources source where source.alias_id=alias.id
      )<>alias.source_count
    )
    or exists (
      select 1 from memory_graph_run_aliases member
      join memory_graph_entity_aliases alias on alias.id=member.alias_id
      join memory_graph_alias_sources alias_source on alias_source.alias_id=alias.id
      where member.reconciliation_run_id=new.id and not exists (
        select 1 from memory_graph_run_candidates candidate
        join memory_graph_nodes node on node.memory_id=candidate.memory_id
        join memory_graph_node_sources node_source on node_source.memory_id=node.memory_id
          and node_source.source_event_id=alias_source.source_event_id
        where candidate.reconciliation_run_id=new.id and node.entity_id=alias.entity_id
      )
    )
    or exists (
      select 1 from memory_graph_run_edges member
      join memory_graph_edges edge on edge.id=member.edge_id
      where member.reconciliation_run_id=new.id and (
        (select count(*) from memory_graph_edge_sources source where source.edge_id=edge.id)
          <>edge.source_count
        or exists (
          select 1 from memory_graph_node_sources expected
          where expected.memory_id in (edge.source_memory_id,edge.target_memory_id)
            and not exists (
              select 1 from memory_graph_edge_sources actual
              where actual.edge_id=edge.id and actual.source_event_id=expected.source_event_id
            )
        )
      )
    )
    or exists (
      select 1 from memory_graph_run_conflicts member
      join memory_conflicts conflict on conflict.id=member.conflict_id
      where member.reconciliation_run_id=new.id and (
        (select count(*) from memory_conflict_sources source
         where source.conflict_id=conflict.id)<>conflict.source_count
        or exists (
          select 1 from memory_graph_node_sources expected
          where expected.memory_id in (conflict.newer_memory_id,conflict.older_memory_id)
            and not exists (
              select 1 from memory_conflict_sources actual
              where actual.conflict_id=conflict.id
                and actual.source_event_id=expected.source_event_id
            )
        )
      )
    )
  then raise exception 'INCOMPLETE_MEMORY_GRAPH_RECONCILIATION'; end if;
  return null;
end;
$$;
create constraint trigger memory_graph_reconciliation_is_complete
after insert on memory_graph_reconciliation_runs deferrable initially deferred
for each row execute function validate_memory_graph_reconciliation_complete();

create function validate_memory_graph_entity_version() returns trigger language plpgsql as $$
declare prior_id uuid; prior_ordinal bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('memory-graph-entity:'||new.entity_id::text,0));
  select prior.id,prior.append_ordinal into prior_id,prior_ordinal
  from memory_graph_entity_versions prior where prior.entity_id=new.entity_id
  order by prior.append_ordinal desc limit 1;
  new.append_ordinal := coalesce(prior_ordinal,0)+1;
  if not exists (
    select 1 from memory_graph_entities entity
    join memory_graph_reconciliation_runs run on run.id=new.reconciliation_run_id
    where entity.id=new.entity_id and run.scope=entity.scope
      and run.account_id is not distinct from entity.account_id
      and run.node_brain_id is not distinct from entity.node_brain_id
      and run.conversation_id is not distinct from entity.conversation_id
      and new.valid_from<=run.observed_at
      and (
        (new.supersedes_entity_version_id is null and prior_id is null)
        or new.supersedes_entity_version_id=prior_id
      )
  ) then raise exception 'MEMORY_GRAPH_ENTITY_VERSION_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_entity_version_is_consistent
before insert on memory_graph_entity_versions
for each row execute function validate_memory_graph_entity_version();

create function validate_memory_graph_head_version() returns trigger language plpgsql as $$
declare prior_id uuid; prior_ordinal bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'memory-graph-head:'||new.entity_id::text||':'||new.predicate_digest,0
  ));
  select head.id,head.append_ordinal into prior_id,prior_ordinal
  from memory_graph_head_versions head
  where head.entity_id=new.entity_id and head.predicate_digest=new.predicate_digest
  order by head.append_ordinal desc limit 1;
  new.append_ordinal := coalesce(prior_ordinal,0)+1;
  if new.supersedes_head_version_id is distinct from prior_id or not exists (
    select 1 from memory_graph_reconciliation_runs run
    join memory_graph_current_claims current on current.reconciliation_run_id=run.id
    join memory_graph_nodes node on node.memory_id=current.memory_id
    where run.id=new.reconciliation_run_id and run.observed_at=new.created_at
      and current.memory_id=new.memory_id and current.entity_id=new.entity_id
      and current.predicate_digest=new.predicate_digest
      and node.entity_id=new.entity_id and node.predicate_digest=new.predicate_digest
  ) then raise exception 'MEMORY_GRAPH_HEAD_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_head_version_is_consistent
before insert on memory_graph_head_versions
for each row execute function validate_memory_graph_head_version();

create function validate_memory_graph_event_manifest() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from encrypted_event_bodies body
    where body.event_id=new.graph_event_id
      and body.body_digest=memory_graph_expected_event_body_digest(new.reconciliation_run_id)
  ) then raise exception 'MEMORY_GRAPH_EVENT_BODY_INVALID'; end if;
  if not memory_graph_event_envelope_is_valid(new.reconciliation_run_id,new.graph_event_id)
  then raise exception 'MEMORY_GRAPH_EVENT_ENVELOPE_INVALID'; end if;
  if not exists (
    select 1 from memory_graph_reconciliation_runs run
    join events event on event.id=new.graph_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id
      and outbox.topic='memory.edge.versioned'
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
    where run.id=new.reconciliation_run_id and run.graph_event_id=event.id
      and event.type='memory.edge.versioned'
      and event.actor_type='SYSTEM' and event.actor_id='memory-graph-reconciler'
      and event.request_hash=new.event_request_hash
      and event.integrity_hash=new.event_integrity_hash
      and new.semantic_digest=run.operation_key
      and new.relation_count=run.edge_count
      and new.relation_digest=memory_graph_relation_digest(run.id)
      and new.body_digest=body.body_digest
      and run.graph_event_request_hash=event.request_hash
      and run.graph_event_integrity_hash=event.integrity_hash
  ) then raise exception 'MEMORY_GRAPH_EVENT_MANIFEST_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_event_manifest_is_consistent
before insert on memory_graph_event_manifests
for each row execute function validate_memory_graph_event_manifest();

create function validate_memory_graph_job_transition() returns trigger language plpgsql as $$
declare prior memory_graph_background_job_transitions%rowtype;
  owner_job memory_graph_background_jobs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('memory-graph-job:'||new.job_id::text,0));
  if new.created_at<>date_trunc('milliseconds',transaction_timestamp()) then
    raise exception 'MEMORY_GRAPH_JOB_CLOCK_INVALID';
  end if;
  select * into owner_job from memory_graph_background_jobs where id=new.job_id for update;
  if owner_job.id is null then raise exception 'MEMORY_GRAPH_JOB_TRANSITION_INVALID'; end if;
  if owner_job.actor_role='ACCOUNT' then
    perform 1 from accounts account
    join entitlements entitlement on entitlement.account_id=account.id
      and entitlement.revoked_at is null and entitlement.active_from<=clock_timestamp()
      and (entitlement.expires_at is null or entitlement.expires_at>clock_timestamp())
    join node_brains node on node.id=owner_job.node_brain_id and node.account_id=account.id
      and node.status='ACTIVE'
    join conversations conversation on conversation.id=owner_job.conversation_id
      and conversation.account_id=account.id and conversation.node_brain_id=node.id
      and conversation.status='OPEN'
    where account.id=owner_job.account_id and account.status='ACTIVE'
    for update of account,entitlement,node,conversation;
  else
    perform 1 from recall_actor_authorities authority
    where authority.role=owner_job.actor_role and authority.actor_id=owner_job.actor_id
      and authority.active and owner_job.authorized_scopes<@authority.scopes for update;
  end if;
  if not found then raise exception 'MEMORY_GRAPH_JOB_OWNER_FORBIDDEN'; end if;
  select * into prior from memory_graph_background_job_transitions
  where job_id=new.job_id order by ordinal desc limit 1;
  if not exists (
    select 1 from memory_graph_background_jobs job
    join events event on event.id=new.transition_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id and outbox.topic=event.type
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
    where job.id=new.job_id and event.aggregate_id='memory-graph-job:'||job.id::text
      and event.account_id is not distinct from job.account_id::text
      and event.visibility=case when job.account_id is null then 'OPERATOR' else 'PRIVATE_ACCOUNT' end
      and event.occurred_at=new.created_at
      and event.idempotency_key='memory-graph-job-event:'||new.idempotency_key||':'||new.operation_digest
      and body.body_digest=recall_manifest_digest(memory_graph_job_transition_body(new))
      and (
        (new.ordinal=0 and event.id=job.queued_event_id
          and event.type='memory.graph.background.queued'
          and event.actor_type='SYSTEM' and event.actor_id='memory-graph-scheduler'
          and new.operation_digest=job.operation_key)
        or (new.ordinal>0 and event.actor_type='SYSTEM'
          and event.type='memory.graph.background.'||lower(new.to_status)
          and exists (
            select 1 from memory_graph_worker_authorities authority
            where authority.actor_id=event.actor_id and authority.active
          ))
      )
  ) or new.operation_digest<>memory_graph_job_operation_digest(new) or not (
    (new.to_status='PENDING' and new.worker_id is null and new.lease_until is null
      and new.retry_at is null and new.error_code is null and new.result_memory_ids is null)
    or (new.to_status='CLAIMED' and new.worker_id is not null
      and length(trim(new.worker_id)) between 1 and 128 and new.lease_until>clock_timestamp()
      and new.retry_at is null and new.error_code is null and new.result_memory_ids is null)
    or (new.to_status='RETRY_SCHEDULED' and new.worker_id is not null
      and length(trim(new.worker_id)) between 1 and 128 and new.lease_until is null
      and new.retry_at>new.created_at and length(trim(new.error_code)) between 1 and 128
      and new.result_memory_ids is null)
    or (new.to_status='COMPLETED' and new.worker_id is not null
      and length(trim(new.worker_id)) between 1 and 128 and new.lease_until is null
      and new.retry_at is null and new.error_code is null and new.result_memory_ids is not null)
    or (new.to_status='FAILED' and new.worker_id is not null
      and length(trim(new.worker_id)) between 1 and 128 and new.lease_until is null
      and new.retry_at is null and length(trim(new.error_code)) between 1 and 128
      and new.result_memory_ids is null)
  ) or (new.to_status='COMPLETED' and exists (
    select 1 from unnest(new.result_memory_ids) result(memory_id)
    left join memory_records memory on memory.id=result.memory_id and (
      (owner_job.account_id is not null and (
        memory.scope in ('MAIN_SHARED','CHALLENGE_SHARED','PUBLIC')
        or (memory.scope in ('PRIVATE_ACCOUNT','NODE_BRANCH')
          and memory.account_id=owner_job.account_id
          and memory.node_brain_id=owner_job.node_brain_id
          and memory.conversation_id=owner_job.conversation_id)))
      or (owner_job.account_id is null and memory.scope=any(owner_job.authorized_scopes))
    ) where memory.id is null
  )) or (prior.id is null and not (
    new.ordinal=0 and new.from_status is null and new.to_status='PENDING'
    and new.transition_event_id=(select queued_event_id from memory_graph_background_jobs where id=new.job_id)
  )) or (prior.id is not null and not (
    new.ordinal=prior.ordinal+1 and new.from_status=prior.to_status and (
      (prior.to_status='PENDING' and new.to_status='CLAIMED')
      or (prior.to_status='RETRY_SCHEDULED' and new.to_status='CLAIMED'
        and prior.retry_at<=clock_timestamp())
      or (prior.to_status='CLAIMED' and new.to_status='CLAIMED'
        and prior.lease_until<=clock_timestamp())
      or (prior.to_status='CLAIMED' and new.to_status in ('COMPLETED','FAILED','RETRY_SCHEDULED')
        and prior.worker_id=new.worker_id and prior.lease_until>clock_timestamp())
    )
  )) then raise exception 'MEMORY_GRAPH_JOB_TRANSITION_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_job_transition_is_consistent
before insert on memory_graph_background_job_transitions
for each row execute function validate_memory_graph_job_transition();

create function validate_memory_graph_job_transition_manifest()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from encrypted_event_bodies body
    join memory_graph_background_job_transitions transition on transition.id=new.transition_id
    where body.event_id=new.transition_event_id
      and body.body_digest=recall_manifest_digest(memory_graph_job_transition_body(transition))
  ) then raise exception 'MEMORY_GRAPH_JOB_EVENT_BODY_INVALID'; end if;
  if not exists (
    select 1 from memory_graph_background_job_transitions transition
    join memory_graph_background_jobs job on job.id=transition.job_id
    join events event on event.id=transition.transition_event_id
    join encrypted_event_bodies body on body.event_id=event.id and body.data_key_id is not null
    join transactional_outbox outbox on outbox.event_id=event.id and outbox.topic=event.type
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
    where transition.id=new.transition_id and transition.job_id=new.job_id
      and transition.transition_event_id=new.transition_event_id
      and transition.operation_digest=new.operation_digest
      and transition.created_at=new.created_at
      and new.body_digest=body.body_digest
      and event.aggregate_id='memory-graph-job:'||job.id::text
      and event.request_hash=new.event_request_hash
      and event.integrity_hash=new.event_integrity_hash
  ) then raise exception 'MEMORY_GRAPH_JOB_MANIFEST_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_job_transition_manifest_is_consistent
before insert on memory_graph_job_transition_manifests
for each row execute function validate_memory_graph_job_transition_manifest();

create function require_memory_graph_job_transition_manifest()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_job_transition_manifests manifest
    join events event on event.id=manifest.transition_event_id
    join transactional_outbox outbox on outbox.event_id=event.id
      and outbox.topic=event.type
      and outbox.payload=jsonb_build_object('eventId',event.id::text)
    where manifest.transition_id=new.id and manifest.job_id=new.job_id
      and manifest.transition_event_id=new.transition_event_id
      and manifest.operation_digest=new.operation_digest
      and manifest.created_at=new.created_at
  ) then raise exception 'INCOMPLETE_MEMORY_GRAPH_JOB_TRANSITION'; end if;
  return null;
end;
$$;
create constraint trigger memory_graph_job_transition_is_complete
after insert on memory_graph_background_job_transitions deferrable initially deferred
for each row execute function require_memory_graph_job_transition_manifest();

create function require_memory_graph_event_authority()
returns trigger language plpgsql as $$
declare authority_count integer;
begin
  if new.type='memory.edge.versioned' then
    select count(*) into authority_count
    from memory_graph_reconciliation_runs run
    join memory_graph_event_manifests manifest
      on manifest.reconciliation_run_id=run.id and manifest.graph_event_id=new.id
    where run.graph_event_id=new.id;
  elsif new.type='memory.graph.reconciliation.queued' then
    select count(*) into authority_count
    from memory_graph_reconciliation_jobs job
    join memory_graph_reconciliation_job_manifests manifest
      on manifest.job_id=job.id and manifest.request_event_id=new.id
    join memory_graph_reconciliation_job_transitions transition
      on transition.job_id=job.id and transition.transition_event_id=new.id
      and transition.action='QUEUE'
    join memory_graph_reconciliation_job_transition_manifests transition_manifest
      on transition_manifest.transition_id=transition.id
      and transition_manifest.transition_event_id=new.id
    where job.request_event_id=new.id;
  elsif new.type=any(array[
    'memory.graph.reconciliation.claimed','memory.graph.reconciliation.progressed',
    'memory.graph.reconciliation.retry_scheduled','memory.graph.reconciliation.completed',
    'memory.graph.reconciliation.failed'
  ]::text[]) then
    select count(*) into authority_count
    from memory_graph_reconciliation_job_transitions transition
    join memory_graph_reconciliation_job_transition_manifests manifest
      on manifest.transition_id=transition.id and manifest.transition_event_id=new.id
    where transition.transition_event_id=new.id;
  elsif new.type=any(array[
    'memory.graph.background.queued','memory.graph.background.claimed',
    'memory.graph.background.retry_scheduled','memory.graph.background.completed',
    'memory.graph.background.failed'
  ]::text[]) then
    select count(*) into authority_count
    from memory_graph_background_job_transitions transition
    join memory_graph_job_transition_manifests manifest
      on manifest.transition_id=transition.id and manifest.transition_event_id=new.id
    where transition.transition_event_id=new.id;
  else
    return null;
  end if;
  if authority_count<>1 then raise exception 'INCOMPLETE_MEMORY_GRAPH_EVENT'; end if;
  return null;
end;
$$;
create constraint trigger memory_graph_event_is_complete
after insert on events deferrable initially deferred
for each row execute function require_memory_graph_event_authority();

create function validate_memory_graph_outbox() returns trigger language plpgsql as $$
declare old_event_type text;
  new_event_type text;
  old_is_canonical boolean := false;
  new_is_canonical boolean := false;
  canonical_topics text[] := array[
    'memory.edge.versioned','memory.graph.reconciliation.queued',
    'memory.graph.reconciliation.claimed','memory.graph.reconciliation.progressed',
    'memory.graph.reconciliation.retry_scheduled','memory.graph.reconciliation.completed',
    'memory.graph.reconciliation.failed',
    'memory.graph.background.queued',
    'memory.graph.background.claimed','memory.graph.background.retry_scheduled',
    'memory.graph.background.completed','memory.graph.background.failed'
  ]::text[];
begin
  if tg_op in ('UPDATE','DELETE') then
    select event.type into old_event_type from events event where event.id=old.event_id;
    old_is_canonical := old.topic=any(canonical_topics) or old_event_type=any(canonical_topics);
    if old_is_canonical then
      if tg_op='DELETE' then raise exception 'IMMUTABLE_MEMORY_GRAPH_OUTBOX'; end if;
      if new.event_id is distinct from old.event_id
        or new.topic is distinct from old.topic
        or new.payload is distinct from old.payload
      then raise exception 'IMMUTABLE_MEMORY_GRAPH_OUTBOX'; end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  select event.type into new_event_type from events event where event.id=new.event_id;
  new_is_canonical := new.topic=any(canonical_topics) or new_event_type=any(canonical_topics);
  if tg_op='UPDATE' and not old_is_canonical and new_is_canonical
  then raise exception 'MEMORY_GRAPH_OUTBOX_INVALID'; end if;
  if new_is_canonical then
    if new_event_type is null or new.topic<>new_event_type
      or new.payload<>jsonb_build_object('eventId',new.event_id::text)
    then raise exception 'MEMORY_GRAPH_OUTBOX_INVALID'; end if;
  end if;
  return new;
end;
$$;
create trigger memory_graph_outbox_is_authoritative
before insert or update or delete on transactional_outbox
for each row execute function validate_memory_graph_outbox();

create function reject_memory_graph_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_MEMORY_GRAPH';
end;
$$;
create trigger memory_graph_runs_are_immutable before update or delete
on memory_graph_reconciliation_runs for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_idempotency_keys_are_immutable before update or delete
on memory_graph_idempotency_keys for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_entities_are_immutable before update or delete
on memory_graph_entities for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_entity_versions_are_immutable before update or delete
on memory_graph_entity_versions for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_run_entities_are_immutable before update or delete
on memory_graph_run_entities for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_aliases_are_immutable before update or delete
on memory_graph_entity_aliases for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_run_aliases_are_immutable before update or delete
on memory_graph_run_aliases for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_alias_sources_are_immutable before update or delete
on memory_graph_alias_sources for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_nodes_are_immutable before update or delete
on memory_graph_nodes for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_run_candidates_are_immutable before update or delete
on memory_graph_run_candidates for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_node_sources_are_immutable before update or delete
on memory_graph_node_sources for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_current_claims_are_immutable before update or delete
on memory_graph_current_claims for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_run_edges_are_immutable before update or delete
on memory_graph_run_edges for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_edge_sources_are_immutable before update or delete
on memory_graph_edge_sources for each row execute function reject_memory_graph_mutation();
create trigger memory_conflicts_are_immutable before update or delete
on memory_conflicts for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_run_conflicts_are_immutable before update or delete
on memory_graph_run_conflicts for each row execute function reject_memory_graph_mutation();
create trigger memory_conflict_sources_are_immutable before update or delete
on memory_conflict_sources for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_background_jobs_are_immutable before update or delete
on memory_graph_background_jobs for each row execute function reject_memory_graph_mutation();

create function reject_sealed_memory_graph_reconciliation_child_insert()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from memory_graph_reconciliation_job_manifests manifest
    where manifest.job_id=new.job_id
  ) then raise exception 'MEMORY_GRAPH_RECONCILIATION_JOB_SEALED'; end if;
  return new;
end;
$$;
create trigger memory_graph_reconciliation_job_entities_seal_insert
before insert on memory_graph_reconciliation_job_entities for each row
execute function reject_sealed_memory_graph_reconciliation_child_insert();
create trigger memory_graph_reconciliation_job_aliases_seal_insert
before insert on memory_graph_reconciliation_job_aliases for each row
execute function reject_sealed_memory_graph_reconciliation_child_insert();
create trigger memory_graph_reconciliation_job_sources_seal_insert
before insert on memory_graph_reconciliation_job_sources for each row
execute function reject_sealed_memory_graph_reconciliation_child_insert();
create trigger memory_graph_reconciliation_job_source_sets_seal_insert
before insert on memory_graph_reconciliation_job_source_sets for each row
execute function reject_sealed_memory_graph_reconciliation_child_insert();
create trigger memory_graph_reconciliation_job_candidates_seal_insert
before insert on memory_graph_reconciliation_job_candidates for each row
execute function reject_sealed_memory_graph_reconciliation_child_insert();

create function validate_memory_graph_reconciliation_job_member()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from memory_graph_reconciliation_jobs job where job.id=new.job_id
      and new.operation_key=job.operation_key
      and new.request_shape_digest=job.request_shape_digest
      and new.request_digest=recall_manifest_digest(jsonb_build_object(
        'operationKey',job.operation_key::text,'idempotencyKey',new.idempotency_key
      ))
      and (new.created_at=job.created_at
        or new.created_at=date_trunc('milliseconds',transaction_timestamp()))
  ) then raise exception 'MEMORY_GRAPH_RECONCILIATION_MEMBER_INVALID'; end if;
  return new;
end;
$$;
create trigger memory_graph_reconciliation_job_member_is_consistent
before insert on memory_graph_reconciliation_job_idempotency_keys for each row
execute function validate_memory_graph_reconciliation_job_member();

create trigger memory_graph_reconciliation_jobs_are_immutable before update or delete
on memory_graph_reconciliation_jobs for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_keys_are_immutable before update or delete
on memory_graph_reconciliation_job_idempotency_keys
for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_entities_are_immutable before update or delete
on memory_graph_reconciliation_job_entities for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_aliases_are_immutable before update or delete
on memory_graph_reconciliation_job_aliases for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_sources_are_immutable before update or delete
on memory_graph_reconciliation_job_sources
for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_source_sets_are_immutable before update or delete
on memory_graph_reconciliation_job_source_sets
for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_candidates_are_immutable before update or delete
on memory_graph_reconciliation_job_candidates
for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_manifests_are_immutable before update or delete
on memory_graph_reconciliation_job_manifests
for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_transitions_are_immutable before update or delete
on memory_graph_reconciliation_job_transitions
for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_reconciliation_job_transition_manifests_are_immutable
before update or delete on memory_graph_reconciliation_job_transition_manifests
for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_event_manifests_are_immutable before update or delete
on memory_graph_event_manifests for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_head_versions_are_immutable before update or delete
on memory_graph_head_versions for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_job_transitions_are_immutable before update or delete
on memory_graph_background_job_transitions for each row execute function reject_memory_graph_mutation();
create trigger memory_graph_job_transition_manifests_are_immutable before update or delete
on memory_graph_job_transition_manifests for each row execute function reject_memory_graph_mutation();
