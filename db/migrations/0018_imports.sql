create table import_manifests (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  import_key char(64) not null unique check (import_key ~ '^[a-f0-9]{64}$'),
  source_namespace text not null check (length(source_namespace) between 1 and 128),
  stable_locator text not null check (length(stable_locator) between 1 and 1024),
  source_type text not null check (source_type in (
    'CONVERSATION_EXPORT','PRESERVED_TRANSCRIPT','REPOSITORY_FILE',
    'HISTORICAL_PAPER_EXPORT','OPERATOR_CORRECTION'
  )),
  source_timestamp timestamptz,
  source_digest char(64) not null check (source_digest ~ '^[a-f0-9]{64}$'),
  parser_version text not null check (length(parser_version) between 1 and 128),
  importer_version text not null check (length(importer_version) between 1 and 128),
  ruleset_version text not null check (length(ruleset_version) between 1 and 128),
  schema_version text not null check (schema_version='import-item-schema-v1'),
  gustavo_policy_version text not null check (gustavo_policy_version='gustavo-policy-v1'),
  prior_manifest_id uuid references import_manifests(id),
  source_count integer not null check (source_count=1),
  source_bytes bigint not null check (source_bytes between 0 and 10485760),
  parsed_count integer not null check (parsed_count between 1 and 100),
  rejected_count integer not null check (rejected_count between 0 and 100),
  duplicate_count integer not null check (duplicate_count between 0 and 100),
  classification_counts jsonb not null
    check (jsonb_typeof(classification_counts) is not distinct from 'object'),
  event_high_water bigint not null unique check (event_high_water > 0),
  projection_status text not null check (projection_status in ('VERIFIED','FAILED')),
  authority_manifest jsonb not null
    check (jsonb_typeof(authority_manifest) is not distinct from 'object'),
  manifest_digest char(64) not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (event_id,body_digest) references encrypted_event_bodies(event_id,body_digest),
  check (prior_manifest_id is null or prior_manifest_id<>id),
  check (parsed_count+rejected_count between 1 and 100)
);

create index import_manifests_source_versions_idx
  on import_manifests (source_namespace,stable_locator,event_high_water desc,id);
create unique index import_manifests_one_root_idx
  on import_manifests (source_namespace,stable_locator) where prior_manifest_id is null;
create unique index import_manifests_one_successor_idx
  on import_manifests (prior_manifest_id) where prior_manifest_id is not null;

create table import_source_items (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  manifest_id uuid not null references import_manifests(id),
  prior_item_id uuid references import_source_items(id),
  import_key char(64) not null unique check (import_key ~ '^[a-f0-9]{64}$'),
  source_type text not null check (source_type in (
    'CONVERSATION_EXPORT','PRESERVED_TRANSCRIPT','REPOSITORY_FILE',
    'HISTORICAL_PAPER_EXPORT','OPERATOR_CORRECTION'
  )),
  source_namespace text not null check (length(source_namespace) between 1 and 128),
  source_locator text not null check (length(source_locator) between 1 and 1024),
  stable_locator text not null check (length(stable_locator) between 1 and 1024),
  source_timestamp timestamptz,
  source_digest char(64) not null check (source_digest ~ '^[a-f0-9]{64}$'),
  item_digest char(64) not null check (item_digest ~ '^[a-f0-9]{64}$'),
  source_byte_start bigint not null check (source_byte_start>=0),
  source_byte_end bigint not null check (source_byte_end>source_byte_start),
  excerpt_digest char(64) not null check (excerpt_digest ~ '^[a-f0-9]{64}$'),
  annotation_digest char(64) not null check (annotation_digest ~ '^[a-f0-9]{64}$'),
  historical_metadata_digest char(64) check (
    historical_metadata_digest is null or historical_metadata_digest ~ '^[a-f0-9]{64}$'
  ),
  parser_version text not null check (length(parser_version) between 1 and 128),
  importer_version text not null check (length(importer_version) between 1 and 128),
  schema_version text not null check (length(schema_version) between 1 and 128),
  gustavo_policy_version text not null check (length(gustavo_policy_version) between 1 and 128),
  record_type text not null check (length(record_type) between 1 and 128),
  lifecycle_class text not null check (lifecycle_class in (
    'CANONICAL','CANDIDATE','HISTORICAL','DEPRECATED','PROHIBITED'
  )),
  visibility_scope text not null check (visibility_scope in (
    'PUBLIC','PRIVATE_ACCOUNT','MAIN_SHARED','CHALLENGE_SHARED','OPERATOR'
  )),
  observed_at timestamptz,
  expires_at timestamptz,
  effective_from timestamptz not null,
  effective_until timestamptz,
  freshness text not null check (freshness in ('CURRENT','HISTORICAL','NOT_APPLICABLE')),
  excerpt_ref text not null check (length(excerpt_ref) between 1 and 1024),
  reviewer text not null check (length(reviewer) between 1 and 256),
  review_reason text not null check (length(review_reason) between 1 and 1024),
  classification_rule_id text not null check (length(classification_rule_id) between 1 and 128),
  ruleset_version text not null check (length(ruleset_version) between 1 and 128),
  canonical_catalog_id text check (
    canonical_catalog_id is null or length(canonical_catalog_id) between 1 and 128
  ),
  canonical_content_digest char(64) check (
    canonical_content_digest is null or canonical_content_digest ~ '^[a-f0-9]{64}$'
  ),
  current_review_status text not null check (
    current_review_status in ('REVIEWED','PENDING','CLASSIFIED')
  ),
  current_review_decision text not null check (current_review_decision in (
    'ACCEPTED_AS_CANONICAL','PENDING','RETAIN_AS_HISTORICAL',
    'RETAIN_AS_AUDIT','EXCLUDED_PROHIBITED'
  )),
  retrieval_mode text not null check (retrieval_mode in (
    'GENERAL','OPERATOR_REVIEW','SIMILARITY_ONLY','AUDIT_ONLY'
  )),
  accepted_decision_rule boolean not null,
  fresh_decision_eligible boolean not null,
  result_ids jsonb not null check (jsonb_typeof(result_ids) is not distinct from 'object'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  authority_sequence bigint not null unique check (authority_sequence > 0),
  created_at timestamptz not null,
  foreign key (event_id,body_digest) references encrypted_event_bodies(event_id,body_digest),
  unique (manifest_id,stable_locator),
  check (prior_item_id is null or prior_item_id<>id),
  check (expires_at is null or observed_at is not null),
  check (expires_at is null or expires_at>=observed_at),
  check (effective_until is null or effective_until>effective_from),
  check (visibility_scope<>'PRIVATE_ACCOUNT'),
  check (schema_version='import-item-schema-v1'),
  check (gustavo_policy_version='gustavo-policy-v1'),
  check (excerpt_digest=item_digest),
  check ((lifecycle_class='HISTORICAL')=(historical_metadata_digest is not null)),
  check ((lifecycle_class='CANONICAL')=(canonical_catalog_id is not null)),
  check ((lifecycle_class='CANONICAL')=(canonical_content_digest is not null)),
  check (lifecycle_class<>'CANONICAL' or (
    canonical_catalog_id='private-node-authorization-boundary-v1'
    and canonical_content_digest='d9058b7bb63949ef3339b002c7067fdf1c1b7969df78e4d1726f0412f70d896f'
    and canonical_content_digest=item_digest
    and current_review_status='REVIEWED'
    and current_review_decision='ACCEPTED_AS_CANONICAL'
  )),
  check (lifecycle_class<>'CANDIDATE' or (
    current_review_status='PENDING' and current_review_decision='PENDING'
  )),
  check (lifecycle_class<>'HISTORICAL' or (
    current_review_status='CLASSIFIED' and current_review_decision='RETAIN_AS_HISTORICAL'
  )),
  check (lifecycle_class<>'DEPRECATED' or (
    current_review_status='CLASSIFIED' and current_review_decision='RETAIN_AS_AUDIT'
  )),
  check (lifecycle_class<>'PROHIBITED' or (
    current_review_status='CLASSIFIED' and current_review_decision='EXCLUDED_PROHIBITED'
  )),
  check (
    (lifecycle_class='CANONICAL' and retrieval_mode='GENERAL' and freshness='CURRENT'
      and accepted_decision_rule and fresh_decision_eligible
      and reviewer is not null and review_reason is not null)
    or (lifecycle_class='CANDIDATE' and retrieval_mode='OPERATOR_REVIEW'
      and freshness='NOT_APPLICABLE'
      and not accepted_decision_rule and not fresh_decision_eligible)
    or (lifecycle_class='HISTORICAL' and retrieval_mode='SIMILARITY_ONLY'
      and freshness='HISTORICAL'
      and not accepted_decision_rule and not fresh_decision_eligible and observed_at is not null)
    or (lifecycle_class in ('DEPRECATED','PROHIBITED') and retrieval_mode='AUDIT_ONLY'
      and freshness='NOT_APPLICABLE'
      and not accepted_decision_rule and not fresh_decision_eligible)
  )
);

create index import_source_items_manifest_idx
  on import_source_items (manifest_id,stable_locator,id);
create index import_source_items_retrieval_idx
  on import_source_items (retrieval_mode,lifecycle_class,authority_sequence desc,id);

create table import_memory_projections (
  item_id uuid primary key references import_source_items(id),
  manifest_id uuid not null references import_manifests(id),
  memory_id uuid not null unique references memory_records(id),
  extraction_run_id uuid not null references memory_extraction_runs(id),
  consolidation_event_id uuid not null references events(id),
  source_event_id uuid not null unique references events(id),
  lifecycle_class text not null check (lifecycle_class in ('CANONICAL','HISTORICAL')),
  retrieval_profile text not null check (retrieval_profile in (
    'CURRENT_GENERAL','HISTORICAL_SIMILARITY'
  )),
  created_at timestamptz not null,
  check ((lifecycle_class='CANONICAL')=(retrieval_profile='CURRENT_GENERAL'))
);

create index import_memory_projections_manifest_idx
  on import_memory_projections (manifest_id,lifecycle_class,memory_id);

create table import_review_queue_entries (
  id uuid primary key,
  item_id uuid not null unique references import_source_items(id),
  manifest_id uuid not null references import_manifests(id),
  status text not null check (status='PENDING'),
  created_at timestamptz not null
);

create index import_review_queue_manifest_idx
  on import_review_queue_entries (manifest_id,status,id);

create table import_lifecycle_commands (
  id uuid primary key,
  manifest_id uuid not null references import_manifests(id),
  action text not null check (action in ('DEACTIVATED','REACTIVATED','REVIEW_DECIDED')),
  item_ids uuid[] not null check (cardinality(item_ids) between 1 and 100),
  actor_id text not null check (length(actor_id) between 1 and 256),
  actor_purpose text not null check (length(actor_purpose) between 1 and 512),
  reason text not null check (length(reason) between 1 and 1024),
  review_decision text check (review_decision in (
    'RETAIN_AS_CLASSIFIED','REJECTED','ARCHIVE_AS_SUPERSEDED_RAW'
  )),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 256),
  request_manifest jsonb not null
    check (jsonb_typeof(request_manifest) is not distinct from 'object'),
  request_digest char(64) not null unique check (request_digest ~ '^[a-f0-9]{64}$'),
  result_lifecycle_ids uuid[] not null,
  result_event_ids uuid[] not null,
  created_at timestamptz not null,
  check (cardinality(result_lifecycle_ids)=cardinality(item_ids)),
  check (cardinality(result_event_ids)=cardinality(item_ids)),
  check ((action='REVIEW_DECIDED')=(review_decision is not null))
);

create table import_lifecycle_idempotency_aliases (
  idempotency_key text primary key check (length(idempotency_key) between 1 and 256),
  command_id uuid not null references import_lifecycle_commands(id),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  unique (command_id,idempotency_key)
);

create table import_item_lifecycle_events (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  manifest_id uuid not null references import_manifests(id),
  item_id uuid not null references import_source_items(id),
  command_id uuid references import_lifecycle_commands(id),
  action text not null check (action in (
    'ACTIVATED','DEACTIVATED','REACTIVATED','REVIEW_DECIDED'
  )),
  active boolean not null,
  retrieval_mode text not null check (retrieval_mode in (
    'GENERAL','OPERATOR_REVIEW','SIMILARITY_ONLY','AUDIT_ONLY'
  )),
  reviewer text not null check (length(reviewer) between 1 and 256),
  reason text not null check (length(reason) between 1 and 1024),
  review_decision text check (review_decision in (
    'RETAIN_AS_CLASSIFIED','REJECTED','ARCHIVE_AS_SUPERSEDED_RAW'
  )),
  importer_version text not null check (length(importer_version) between 1 and 128),
  ruleset_version text not null check (length(ruleset_version) between 1 and 128),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  authority_sequence bigint not null unique check (authority_sequence > 0),
  created_at timestamptz not null,
  foreign key (event_id,body_digest) references encrypted_event_bodies(event_id,body_digest),
  check ((action='ACTIVATED' and active and command_id is null and review_decision is null)
    or (action='DEACTIVATED' and not active and command_id is not null
      and review_decision is null)
    or (action='REACTIVATED' and active and command_id is not null
      and review_decision is null)
    or (action='REVIEW_DECIDED' and command_id is not null
      and review_decision is not null))
);

create index import_item_lifecycle_latest_idx
  on import_item_lifecycle_events (item_id,authority_sequence desc,id desc);

create view import_item_current_states as
select item.id item_id,item.manifest_id,item.lifecycle_class,
       latest.active,latest.retrieval_mode,
       case when review.review_decision='REJECTED' then 'REJECTED'
            when review.review_decision='RETAIN_AS_CLASSIFIED' then 'REVIEWED'
            else item.current_review_status end current_review_status,
       coalesce(review.review_decision,item.current_review_decision) current_review_decision,
       (item.lifecycle_class='CANDIDATE' and review.review_decision is null) review_pending
from import_source_items item
join lateral (
  select lifecycle.active,lifecycle.retrieval_mode
    from import_item_lifecycle_events lifecycle where lifecycle.item_id=item.id
   order by lifecycle.authority_sequence desc,lifecycle.id desc limit 1
) latest on true
left join lateral (
  select lifecycle.review_decision
    from import_item_lifecycle_events lifecycle
   where lifecycle.item_id=item.id and lifecycle.action='REVIEW_DECIDED'
   order by lifecycle.authority_sequence desc,lifecycle.id desc limit 1
) review on true;

create table import_verification_receipts (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  manifest_id uuid not null references import_manifests(id),
  verification_digest char(64) not null check (verification_digest ~ '^[a-f0-9]{64}$'),
  authority_manifest jsonb not null
    check (jsonb_typeof(authority_manifest) is not distinct from 'object'),
  source_count integer not null check (source_count=1),
  source_bytes bigint not null check (source_bytes between 0 and 10485760),
  parsed_count integer not null check (parsed_count between 1 and 100),
  rejected_count integer not null check (rejected_count between 0 and 100),
  duplicate_count integer not null check (duplicate_count between 0 and 100),
  classification_counts jsonb not null
    check (jsonb_typeof(classification_counts) is not distinct from 'object'),
  projection_status text not null check (projection_status in ('VERIFIED','FAILED')),
  manifest_event_high_water bigint not null check (manifest_event_high_water>0),
  verified_event_high_water bigint not null unique check (verified_event_high_water>0),
  provenance_count integer not null check (provenance_count between 0 and 100),
  body_count integer not null check (body_count between 0 and 512),
  outbox_count integer not null check (outbox_count between 0 and 512),
  valid boolean not null,
  importer_version text not null check (length(importer_version) between 1 and 128),
  ruleset_version text not null check (length(ruleset_version) between 1 and 128),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (event_id,body_digest) references encrypted_event_bodies(event_id,body_digest),
  unique (manifest_id,verification_digest)
);

create table import_event_authorities (
  event_id uuid primary key references events(id),
  authority_kind text not null check (authority_kind in (
    'MANIFEST','ITEM','LIFECYCLE','VERIFICATION'
  )),
  authority_id uuid not null,
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  outbox_payload_digest char(64) not null check (outbox_payload_digest ~ '^[a-f0-9]{64}$'),
  authority_sequence bigint not null unique check (authority_sequence > 0),
  created_at timestamptz not null,
  unique (authority_kind,authority_id)
);

create function validate_import_projection_event() returns trigger language plpgsql as $$
declare event_row events%rowtype;
declare body_row encrypted_event_bodies%rowtype;
declare outbox_row transactional_outbox%rowtype;
declare expected_type text;
declare expected_manifest uuid;
declare expected_sequence bigint;
declare expected_body_digest text;
declare owner_manifest import_manifests%rowtype;
declare owner_item import_source_items%rowtype;
declare owner_command import_lifecycle_commands%rowtype;
declare latest_lifecycle import_item_lifecycle_events%rowtype;
begin
  if tg_table_name='import_manifests' then
    expected_type:='import.manifest.committed';
    expected_manifest:=new.id; expected_sequence:=new.event_high_water;
  elsif tg_table_name='import_source_items' then
    expected_type:='import.item.classified';
    expected_manifest:=new.manifest_id; expected_sequence:=new.authority_sequence;
  else
    expected_type:='import.item.lifecycle_recorded';
    expected_manifest:=new.manifest_id; expected_sequence:=new.authority_sequence;
  end if;
  expected_body_digest:=new.body_digest;
  select * into event_row from events where id=new.event_id;
  select * into body_row from encrypted_event_bodies where event_id=new.event_id;
  select * into outbox_row from transactional_outbox where event_id=new.event_id;
  if event_row.id is null or body_row.event_id is null or outbox_row.event_id is null
    or event_row.aggregate_id is distinct from concat('import:',expected_manifest::text)
    or event_row.account_id is not null
    or event_row.actor_type is distinct from 'OPERATOR'
    or event_row.actor_id is distinct from 'gustavo-importer'
    or event_row.type is distinct from expected_type
    or event_row.visibility is distinct from 'OPERATOR'
    or event_row.occurred_at is distinct from new.created_at
    or event_row.prompt_version is distinct from new.importer_version
    or event_row.model_version is not null
    or event_row.policy_version is distinct from 'gustavo-policy-v1'
    or event_row.correlation_id is distinct from event_row.id
    or event_row.ingested_sequence is distinct from expected_sequence
    or body_row.aggregate_id is distinct from event_row.aggregate_id
    or body_row.data_key_id is null
    or body_row.body_digest is distinct from expected_body_digest
    or right(event_row.idempotency_key,65) is distinct from concat(':',expected_body_digest)
    or outbox_row.topic is distinct from expected_type
    or outbox_row.created_at is distinct from event_row.occurred_at
    or outbox_row.payload is distinct from jsonb_build_object('eventId',event_row.id)
  then raise exception 'IMPORT_EVENT_AUTHORITY_INVALID'; end if;
  if tg_table_name='import_manifests' then
    if event_row.causation_id is not null
      or new.import_key is distinct from recall_manifest_digest(jsonb_build_object(
        'contentDigest',new.source_digest::text,'importerVersion',new.importer_version,
        'sourceNamespace',new.source_namespace,'stableLocator',new.stable_locator))
      or recall_manifest_digest(new.authority_manifest) is distinct from new.manifest_digest
      or (new.prior_manifest_id is not null and not exists (
        select 1 from import_manifests prior where prior.id=new.prior_manifest_id
          and prior.source_namespace=new.source_namespace
          and prior.stable_locator=new.stable_locator
          and prior.event_high_water<new.event_high_water
      ))
    then raise exception 'IMPORT_MANIFEST_AUTHORITY_INVALID'; end if;
  elsif tg_table_name='import_source_items' then
    select * into owner_manifest from import_manifests where id=new.manifest_id;
    if event_row.causation_id is not null
      or owner_manifest.id is null
      or new.source_type is distinct from owner_manifest.source_type
      or new.source_namespace is distinct from owner_manifest.source_namespace
      or new.source_locator is distinct from owner_manifest.stable_locator
      or new.source_timestamp is distinct from owner_manifest.source_timestamp
      or new.source_digest is distinct from owner_manifest.source_digest
      or new.source_byte_end>owner_manifest.source_bytes
      or new.excerpt_digest is distinct from new.item_digest
      or new.parser_version is distinct from owner_manifest.parser_version
      or new.importer_version is distinct from owner_manifest.importer_version
      or new.ruleset_version is distinct from owner_manifest.ruleset_version
      or exists (select 1 from import_event_authorities authority
        where authority.authority_kind='MANIFEST' and authority.authority_id=new.manifest_id)
      or new.import_key is distinct from recall_manifest_digest(jsonb_build_object(
        'contentDigest',new.source_digest::text,'importerVersion',new.importer_version,
        'sourceNamespace',new.source_namespace,'stableLocator',new.stable_locator))
      or jsonb_typeof(new.result_ids) is distinct from 'object'
      or (select array_agg(key order by key) from jsonb_object_keys(new.result_ids) key)
        is distinct from (case
          when new.lifecycle_class in ('CANONICAL','HISTORICAL') then
            array['consolidationEventId','eventId','extractionRunId','memoryId','sourceEventId']::text[]
          when new.lifecycle_class='CANDIDATE' then array['eventId','reviewQueueId']::text[]
          else array['eventId']::text[] end)
      or jsonb_typeof(new.result_ids->'eventId') is distinct from 'string'
      or new.result_ids->'eventId' is distinct from to_jsonb(new.event_id::text)
      or (exists (
        select 1 from import_source_items prior
         where prior.manifest_id=owner_manifest.prior_manifest_id
           and prior.stable_locator=new.stable_locator
      )) is distinct from (new.prior_item_id is not null)
      or (new.prior_item_id is not null and not exists (
        select 1 from import_source_items prior
         where prior.id=new.prior_item_id and prior.stable_locator=new.stable_locator
           and prior.manifest_id=owner_manifest.prior_manifest_id
      ))
    then raise exception 'IMPORT_ITEM_PROVENANCE_INVALID'; end if;
  else
    select * into owner_item from import_source_items where id=new.item_id for update;
    select * into owner_manifest from import_manifests where id=new.manifest_id;
    if new.command_id is not null then
      select * into owner_command from import_lifecycle_commands where id=new.command_id;
    end if;
    select * into latest_lifecycle from import_item_lifecycle_events
      where item_id=new.item_id order by authority_sequence desc,id desc limit 1;
    if owner_item.id is null or owner_item.manifest_id is distinct from new.manifest_id
      or owner_item.retrieval_mode is distinct from new.retrieval_mode
      or event_row.causation_id is distinct from owner_item.event_id
      or (new.action is distinct from 'ACTIVATED' and (
        owner_command.id is null or owner_command.manifest_id is distinct from new.manifest_id
        or owner_command.action is distinct from new.action
        or not new.item_id=any(owner_command.item_ids)
        or owner_command.actor_id is distinct from new.reviewer
        or owner_command.reason is distinct from new.reason
        or owner_command.review_decision is distinct from new.review_decision))
      or (new.action='ACTIVATED' and latest_lifecycle.id is not null)
      or (new.action='DEACTIVATED' and (latest_lifecycle.id is null or not latest_lifecycle.active))
      or (new.action='REACTIVATED' and (latest_lifecycle.id is null or latest_lifecycle.active))
      or (new.action='REVIEW_DECIDED' and (
        latest_lifecycle.id is null or new.active is distinct from latest_lifecycle.active
        or (new.review_decision='ARCHIVE_AS_SUPERSEDED_RAW' and (
          owner_item.lifecycle_class not in ('DEPRECATED','HISTORICAL')
          or owner_item.source_locator is distinct from owner_manifest.stable_locator
          or owner_item.source_digest is distinct from owner_manifest.source_digest
          or owner_item.source_byte_start is distinct from 0
          or owner_item.source_byte_end is distinct from owner_manifest.source_bytes
          or not exists (
            select 1 from import_verification_receipts receipt
             where receipt.manifest_id=new.manifest_id and receipt.valid
               and receipt.verified_event_high_water<new.authority_sequence
          )
        ))
        or (new.review_decision is distinct from 'ARCHIVE_AS_SUPERSEDED_RAW'
          and owner_item.lifecycle_class is distinct from 'CANDIDATE')))
    then raise exception 'IMPORT_LIFECYCLE_TRANSITION_INVALID'; end if;
  end if;
  return new;
end;
$$;

create trigger import_manifests_validate_event before insert on import_manifests
for each row execute function validate_import_projection_event();
create trigger import_source_items_validate_event before insert on import_source_items
for each row execute function validate_import_projection_event();
create trigger import_lifecycle_validate_event before insert on import_item_lifecycle_events
for each row execute function validate_import_projection_event();

create function validate_import_event_authority_row() returns trigger language plpgsql as $$
declare event_row events%rowtype;
declare body_row encrypted_event_bodies%rowtype;
declare outbox_row transactional_outbox%rowtype;
declare matching_projection integer;
begin
  select * into event_row from events where id=new.event_id;
  select * into body_row from encrypted_event_bodies where event_id=new.event_id;
  select * into outbox_row from transactional_outbox where event_id=new.event_id;
  if new.authority_kind='MANIFEST' then
    select count(*) into matching_projection from import_manifests
      where id=new.authority_id and event_id=new.event_id and body_digest=new.body_digest
        and event_high_water=new.authority_sequence;
  elsif new.authority_kind='ITEM' then
    select count(*) into matching_projection from import_source_items
      where id=new.authority_id and event_id=new.event_id and body_digest=new.body_digest
        and authority_sequence=new.authority_sequence;
  elsif new.authority_kind='LIFECYCLE' then
    select count(*) into matching_projection from import_item_lifecycle_events
      where id=new.authority_id and event_id=new.event_id and body_digest=new.body_digest
        and authority_sequence=new.authority_sequence;
  else
    select count(*) into matching_projection from import_verification_receipts
      where id=new.authority_id and event_id=new.event_id and body_digest=new.body_digest
        and verified_event_high_water=new.authority_sequence;
  end if;
  if matching_projection is distinct from 1 or event_row.id is null or body_row.event_id is null
    or outbox_row.event_id is null
    or event_row.ingested_sequence is distinct from new.authority_sequence
    or event_row.request_hash is distinct from new.event_request_hash
    or event_row.integrity_hash is distinct from new.event_integrity_hash
    or event_row.prompt_version is distinct from 'bootstrap-importer-v1'
    or event_row.model_version is not null
    or event_row.policy_version is distinct from 'gustavo-policy-v1'
    or event_row.correlation_id is distinct from event_row.id
    or event_row.occurred_at is distinct from new.created_at
    or body_row.aggregate_id is distinct from event_row.aggregate_id
    or body_row.body_digest is distinct from new.body_digest
    or outbox_row.topic is distinct from event_row.type
    or outbox_row.created_at is distinct from event_row.occurred_at
    or outbox_row.payload is distinct from jsonb_build_object('eventId',new.event_id)
    or recall_manifest_digest(outbox_row.payload) is distinct from new.outbox_payload_digest
  then raise exception 'IMPORT_EVENT_AUTHORITY_INVALID'; end if;
  return new;
end;
$$;

create trigger import_event_authorities_validate before insert on import_event_authorities
for each row execute function validate_import_event_authority_row();

create function validate_import_verification_receipt() returns trigger language plpgsql as $$
declare event_row events%rowtype;
declare body_row encrypted_event_bodies%rowtype;
declare outbox_row transactional_outbox%rowtype;
declare manifest_row import_manifests%rowtype;
begin
  select * into event_row from events where id=new.event_id;
  select * into body_row from encrypted_event_bodies where event_id=new.event_id;
  select * into outbox_row from transactional_outbox where event_id=new.event_id;
  select * into manifest_row from import_manifests where id=new.manifest_id;
  if manifest_row.id is null or event_row.id is null or body_row.event_id is null
    or outbox_row.event_id is null
    or event_row.aggregate_id is distinct from concat('import:',new.manifest_id::text)
    or event_row.account_id is not null
    or event_row.actor_type is distinct from 'OPERATOR'
    or event_row.actor_id is distinct from 'gustavo-importer'
    or event_row.type is distinct from 'import.verification.completed'
    or event_row.visibility is distinct from 'OPERATOR'
    or event_row.occurred_at is distinct from new.created_at
    or event_row.prompt_version is distinct from new.importer_version
    or event_row.model_version is not null
    or event_row.policy_version is distinct from 'gustavo-policy-v1'
    or event_row.correlation_id is distinct from event_row.id
    or event_row.causation_id is distinct from manifest_row.event_id
    or event_row.ingested_sequence is distinct from new.verified_event_high_water
    or body_row.aggregate_id is distinct from event_row.aggregate_id
    or body_row.data_key_id is null
    or body_row.body_digest is distinct from new.body_digest
    or right(event_row.idempotency_key,65) is distinct from concat(':',new.body_digest)
    or outbox_row.topic is distinct from event_row.type
    or outbox_row.created_at is distinct from event_row.occurred_at
    or outbox_row.payload is distinct from jsonb_build_object('eventId',event_row.id)
    or jsonb_typeof(new.authority_manifest) is distinct from 'object'
    or (select array_agg(key order by key) from jsonb_object_keys(new.authority_manifest) key)
      is distinct from array['classificationCounts','counts','deterministicReplay',
        'gustavoPolicyVersion','importerVersion','manifestDigest','manifestEventHighWater',
        'manifestId','projectionStatus','rulesetVersion','safety','schemaVersion','valid']::text[]
    or jsonb_typeof(new.authority_manifest->'classificationCounts') is distinct from 'object'
    or (select array_agg(key order by key)
          from jsonb_object_keys(new.authority_manifest->'classificationCounts') key)
      is distinct from array['CANDIDATE','CANONICAL','DEPRECATED','HISTORICAL','PROHIBITED']::text[]
    or exists (
      select 1 from jsonb_each(new.authority_manifest->'classificationCounts') entry
       where jsonb_typeof(entry.value) is distinct from 'number'
    )
    or new.authority_manifest->'classificationCounts'
      is distinct from new.classification_counts
    or jsonb_typeof(new.authority_manifest->'counts') is distinct from 'object'
    or (select array_agg(key order by key)
          from jsonb_object_keys(new.authority_manifest->'counts') key)
      is distinct from array['body','bytes','duplicates','outbox','parsed','provenance',
        'rejected','sources']::text[]
    or new.authority_manifest#>'{counts,body}' is distinct from to_jsonb(new.body_count)
    or new.authority_manifest#>'{counts,bytes}' is distinct from to_jsonb(new.source_bytes)
    or new.authority_manifest#>'{counts,duplicates}' is distinct from to_jsonb(new.duplicate_count)
    or new.authority_manifest#>'{counts,outbox}' is distinct from to_jsonb(new.outbox_count)
    or new.authority_manifest#>'{counts,parsed}' is distinct from to_jsonb(new.parsed_count)
    or new.authority_manifest#>'{counts,provenance}' is distinct from to_jsonb(new.provenance_count)
    or new.authority_manifest#>'{counts,rejected}' is distinct from to_jsonb(new.rejected_count)
    or new.authority_manifest#>'{counts,sources}' is distinct from to_jsonb(new.source_count)
    or jsonb_typeof(new.authority_manifest->'safety') is distinct from 'object'
    or (select array_agg(key order by key)
          from jsonb_object_keys(new.authority_manifest->'safety') key)
      is distinct from array['candidateInAcceptedRules','deprecatedInActiveRetrieval',
        'forbiddenBehaviorInActiveRetrieval','historicalInFreshDecisionGates',
        'prohibitedInActiveRetrieval']::text[]
    or jsonb_typeof(new.authority_manifest->'deterministicReplay') is distinct from 'boolean'
    or jsonb_typeof(new.authority_manifest->'valid') is distinct from 'boolean'
    or jsonb_typeof(new.authority_manifest#>'{safety,candidateInAcceptedRules}')
      is distinct from 'number'
    or jsonb_typeof(new.authority_manifest#>'{safety,deprecatedInActiveRetrieval}')
      is distinct from 'number'
    or jsonb_typeof(new.authority_manifest#>'{safety,forbiddenBehaviorInActiveRetrieval}')
      is distinct from 'number'
    or jsonb_typeof(new.authority_manifest#>'{safety,historicalInFreshDecisionGates}')
      is distinct from 'number'
    or jsonb_typeof(new.authority_manifest#>'{safety,prohibitedInActiveRetrieval}')
      is distinct from 'number'
    or (new.valid and (
      new.authority_manifest->'deterministicReplay' is distinct from 'true'::jsonb
      or new.authority_manifest#>'{safety,candidateInAcceptedRules}' is distinct from '0'::jsonb
      or new.authority_manifest#>'{safety,deprecatedInActiveRetrieval}' is distinct from '0'::jsonb
      or new.authority_manifest#>'{safety,forbiddenBehaviorInActiveRetrieval}'
        is distinct from '0'::jsonb
      or new.authority_manifest#>'{safety,historicalInFreshDecisionGates}'
        is distinct from '0'::jsonb
      or new.authority_manifest#>'{safety,prohibitedInActiveRetrieval}' is distinct from '0'::jsonb
    ))
    or new.authority_manifest->'manifestDigest' is distinct from to_jsonb(manifest_row.manifest_digest::text)
    or new.authority_manifest->'manifestId' is distinct from to_jsonb(new.manifest_id::text)
    or new.authority_manifest->'manifestEventHighWater'
      is distinct from to_jsonb(new.manifest_event_high_water)
    or new.authority_manifest->'projectionStatus' is distinct from to_jsonb(new.projection_status)
    or new.authority_manifest->'importerVersion' is distinct from to_jsonb(new.importer_version)
    or new.authority_manifest->'rulesetVersion' is distinct from to_jsonb(new.ruleset_version)
    or new.authority_manifest->'schemaVersion' is distinct from '"import-item-schema-v1"'::jsonb
    or new.authority_manifest->'gustavoPolicyVersion' is distinct from '"gustavo-policy-v1"'::jsonb
    or new.authority_manifest->'valid' is distinct from to_jsonb(new.valid)
    or recall_manifest_digest(new.authority_manifest) is distinct from new.verification_digest
    or new.manifest_event_high_water is distinct from manifest_row.event_high_water
    or new.source_count is distinct from manifest_row.source_count
    or new.source_bytes is distinct from manifest_row.source_bytes
    or new.parsed_count is distinct from manifest_row.parsed_count
    or new.rejected_count is distinct from manifest_row.rejected_count
    or new.duplicate_count is distinct from manifest_row.duplicate_count
    or new.classification_counts is distinct from manifest_row.classification_counts
    or new.projection_status is distinct from manifest_row.projection_status
  then raise exception 'IMPORT_VERIFICATION_RECEIPT_INVALID'; end if;
  return new;
end;
$$;

create trigger import_verification_receipt_validate before insert on import_verification_receipts
for each row execute function validate_import_verification_receipt();

create function validate_import_memory_projection() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
      from import_source_items item
      join memory_records memory on memory.id=new.memory_id
      join memory_extraction_runs run on run.id=new.extraction_run_id
      join memory_sources source on source.memory_id=memory.id
     where item.id=new.item_id and item.manifest_id=new.manifest_id
       and item.lifecycle_class=new.lifecycle_class
       and item.lifecycle_class in ('CANONICAL','HISTORICAL')
       and item.visibility_scope='MAIN_SHARED'
       and memory.extraction_run_id=run.id
       and run.consolidation_event_id=new.consolidation_event_id
       and memory.body_event_id=new.consolidation_event_id
       and source.source_event_id=new.source_event_id
       and memory.scope='MAIN_SHARED'
       and ((item.lifecycle_class='CANONICAL' and memory.type in ('SEMANTIC','PROCEDURAL')
             and memory.valid_to is null and new.retrieval_profile='CURRENT_GENERAL')
         or (item.lifecycle_class='HISTORICAL' and memory.type='EPISODIC'
             and memory.valid_to is not null
             and new.retrieval_profile='HISTORICAL_SIMILARITY'))
  ) then raise exception 'IMPORT_MEMORY_PROJECTION_INVALID'; end if;
  return new;
end;
$$;

create trigger import_memory_projection_validate before insert on import_memory_projections
for each row execute function validate_import_memory_projection();

create function validate_import_review_queue_entry() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from import_source_items item
     where item.id=new.item_id and item.manifest_id=new.manifest_id
       and item.lifecycle_class='CANDIDATE' and item.retrieval_mode='OPERATOR_REVIEW'
  ) then raise exception 'IMPORT_REVIEW_QUEUE_INVALID'; end if;
  return new;
end;
$$;

create trigger import_review_queue_validate before insert on import_review_queue_entries
for each row execute function validate_import_review_queue_entry();

create function validate_import_item_projection_complete() returns trigger language plpgsql as $$
declare memory_row import_memory_projections%rowtype;
declare review_row import_review_queue_entries%rowtype;
begin
  select * into memory_row from import_memory_projections where item_id=new.id;
  select * into review_row from import_review_queue_entries where item_id=new.id;
  if new.lifecycle_class in ('CANONICAL','HISTORICAL') then
    if new.visibility_scope is distinct from 'MAIN_SHARED'
      or memory_row.item_id is null or review_row.id is not null
      or new.result_ids is distinct from jsonb_build_object(
        'eventId',new.event_id,
        'sourceEventId',memory_row.source_event_id,
        'memoryId',memory_row.memory_id,
        'extractionRunId',memory_row.extraction_run_id,
        'consolidationEventId',memory_row.consolidation_event_id
      )
    then raise exception 'INCOMPLETE_IMPORT_ITEM_PROJECTION'; end if;
  elsif new.lifecycle_class='CANDIDATE' then
    if memory_row.item_id is not null or review_row.id is null
      or new.result_ids is distinct from
        jsonb_build_object('eventId',new.event_id,'reviewQueueId',review_row.id)
    then raise exception 'INCOMPLETE_IMPORT_ITEM_PROJECTION'; end if;
  elsif memory_row.item_id is not null or review_row.id is not null
    or new.result_ids is distinct from jsonb_build_object('eventId',new.event_id)
  then raise exception 'INCOMPLETE_IMPORT_ITEM_PROJECTION'; end if;
  return null;
end;
$$;

create constraint trigger import_item_projection_is_complete
after insert on import_source_items deferrable initially deferred
for each row execute function validate_import_item_projection_complete();

create function require_import_event_authority() returns trigger language plpgsql as $$
begin
  if new.type in (
    'import.manifest.committed','import.item.classified','import.item.lifecycle_recorded',
    'import.verification.completed'
  ) and (select count(*) from import_event_authorities where event_id=new.id) is distinct from 1
  then raise exception 'INCOMPLETE_IMPORT_EVENT'; end if;
  return new;
end;
$$;

create constraint trigger import_event_requires_authority after insert on events
deferrable initially deferred for each row execute function require_import_event_authority();

create function require_import_projection_authority() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from import_event_authorities authority
     where authority.event_id=new.event_id and authority.authority_id=new.id
       and authority.authority_kind=case tg_table_name
         when 'import_manifests' then 'MANIFEST'
         when 'import_source_items' then 'ITEM'
         when 'import_verification_receipts' then 'VERIFICATION'
         else 'LIFECYCLE' end
  ) then raise exception 'INCOMPLETE_IMPORT_PROJECTION'; end if;
  return new;
end;
$$;

create constraint trigger import_manifest_requires_authority after insert on import_manifests
deferrable initially deferred for each row execute function require_import_projection_authority();
create constraint trigger import_item_requires_authority after insert on import_source_items
deferrable initially deferred for each row execute function require_import_projection_authority();
create constraint trigger import_lifecycle_requires_authority after insert on import_item_lifecycle_events
deferrable initially deferred for each row execute function require_import_projection_authority();
create constraint trigger import_verification_requires_authority after insert on import_verification_receipts
deferrable initially deferred for each row execute function require_import_projection_authority();

create function validate_import_manifest_complete() returns trigger language plpgsql as $$
declare expected_classifications jsonb;
begin
  select jsonb_build_object(
    'CANONICAL',count(*) filter (where lifecycle_class='CANONICAL'),
    'CANDIDATE',count(*) filter (where lifecycle_class='CANDIDATE'),
    'HISTORICAL',count(*) filter (where lifecycle_class='HISTORICAL'),
    'DEPRECATED',count(*) filter (where lifecycle_class='DEPRECATED'),
    'PROHIBITED',count(*) filter (where lifecycle_class='PROHIBITED')
  ) into expected_classifications from import_source_items where manifest_id=new.id;
  if (select count(*) from import_source_items where manifest_id=new.id)
      is distinct from new.parsed_count
    or expected_classifications is distinct from new.classification_counts
    or jsonb_typeof(new.classification_counts) is distinct from 'object'
    or (select array_agg(key order by key) from jsonb_object_keys(new.classification_counts) key)
      is distinct from array['CANDIDATE','CANONICAL','DEPRECATED','HISTORICAL','PROHIBITED']::text[]
    or exists (
      select 1 from jsonb_each(new.classification_counts) entry
       where jsonb_typeof(entry.value) is distinct from 'number'
    )
    or jsonb_typeof(new.authority_manifest) is distinct from 'object'
    or (select array_agg(key order by key) from jsonb_object_keys(new.authority_manifest) key)
      is distinct from array['classifications','counts','gustavoPolicyVersion','importerVersion',
        'items','parserVersion','projectionStatus','rulesetVersion','schemaVersion','source']::text[]
    or jsonb_typeof(new.authority_manifest->'classifications') is distinct from 'object'
    or new.authority_manifest->'classifications' is distinct from new.classification_counts
    or jsonb_typeof(new.authority_manifest->'counts') is distinct from 'object'
    or (select array_agg(key order by key)
          from jsonb_object_keys(new.authority_manifest->'counts') key)
      is distinct from array['bytes','duplicates','parsed','rejected','sources']::text[]
    or new.authority_manifest#>'{counts,bytes}' is distinct from to_jsonb(new.source_bytes)
    or new.authority_manifest#>'{counts,duplicates}' is distinct from to_jsonb(new.duplicate_count)
    or new.authority_manifest#>'{counts,parsed}' is distinct from to_jsonb(new.parsed_count)
    or new.authority_manifest#>'{counts,rejected}' is distinct from to_jsonb(new.rejected_count)
    or new.authority_manifest#>'{counts,sources}' is distinct from to_jsonb(new.source_count)
    or new.authority_manifest->'importerVersion' is distinct from to_jsonb(new.importer_version)
    or new.authority_manifest->'parserVersion' is distinct from to_jsonb(new.parser_version)
    or new.authority_manifest->'rulesetVersion' is distinct from to_jsonb(new.ruleset_version)
    or new.authority_manifest->'schemaVersion' is distinct from to_jsonb(new.schema_version)
    or new.authority_manifest->'gustavoPolicyVersion'
      is distinct from to_jsonb(new.gustavo_policy_version)
    or new.authority_manifest->'projectionStatus' is distinct from to_jsonb(new.projection_status)
    or jsonb_typeof(new.authority_manifest->'source') is distinct from 'object'
    or (select array_agg(key order by key)
          from jsonb_object_keys(new.authority_manifest->'source') key)
      is distinct from array['digest','locator','namespace','sourceTimestamp','type']::text[]
    or new.authority_manifest#>'{source,digest}' is distinct from to_jsonb(new.source_digest::text)
    or new.authority_manifest#>'{source,locator}' is distinct from to_jsonb(new.stable_locator)
    or new.authority_manifest#>'{source,namespace}' is distinct from to_jsonb(new.source_namespace)
    or new.authority_manifest#>'{source,type}' is distinct from to_jsonb(new.source_type)
    or (case when new.source_timestamp is null then
         new.authority_manifest#>'{source,sourceTimestamp}' is distinct from 'null'::jsonb
       else jsonb_typeof(new.authority_manifest#>'{source,sourceTimestamp}')
              is distinct from 'string'
         or (new.authority_manifest#>>'{source,sourceTimestamp}')::timestamptz
              is distinct from new.source_timestamp
       end)
    or jsonb_typeof(new.authority_manifest->'items') is distinct from 'array'
    or jsonb_array_length(new.authority_manifest->'items') is distinct from new.parsed_count
    or exists (
      select 1 from import_source_items item where item.manifest_id=new.id and not exists (
        select 1 from jsonb_array_elements(new.authority_manifest->'items') entry
         where jsonb_typeof(entry) is not distinct from 'object'
           and (select array_agg(key order by key) from jsonb_object_keys(entry) key)
             is not distinct from array['annotationDigest','byteRange','digest','excerptDigest','freshness',
               'historicalMetadataDigest','lifecycleClass','locator','recordType','retrievalMode']::text[]
           and jsonb_typeof(entry->'byteRange') is not distinct from 'object'
           and (select array_agg(key order by key) from jsonb_object_keys(entry->'byteRange') key)
             is not distinct from array['end','start']::text[]
           and entry->'annotationDigest' is not distinct from to_jsonb(item.annotation_digest::text)
           and entry#>'{byteRange,start}' is not distinct from to_jsonb(item.source_byte_start)
           and entry#>'{byteRange,end}' is not distinct from to_jsonb(item.source_byte_end)
           and entry->'digest' is not distinct from to_jsonb(item.item_digest::text)
           and entry->'excerptDigest' is not distinct from to_jsonb(item.excerpt_digest::text)
           and entry->'freshness' is not distinct from to_jsonb(item.freshness)
           and entry->'historicalMetadataDigest' is not distinct from
             coalesce(to_jsonb(item.historical_metadata_digest::text),'null'::jsonb)
           and entry->'lifecycleClass' is not distinct from to_jsonb(item.lifecycle_class)
           and entry->'locator' is not distinct from to_jsonb(item.stable_locator)
           and entry->'recordType' is not distinct from to_jsonb(item.record_type)
           and entry->'retrievalMode' is not distinct from to_jsonb(item.retrieval_mode)
      )
    )
    or exists (
      select 1 from import_source_items left_item
      join import_source_items right_item on right_item.manifest_id=left_item.manifest_id
        and right_item.id>left_item.id
        and left_item.source_byte_start<right_item.source_byte_end
        and right_item.source_byte_start<left_item.source_byte_end
      where left_item.manifest_id=new.id
    )
    or exists (
      select 1 from import_source_items item where item.manifest_id=new.id and not exists (
        select 1 from import_item_lifecycle_events lifecycle where lifecycle.item_id=item.id
      )
    )
  then raise exception 'INCOMPLETE_IMPORT_MANIFEST'; end if;
  return new;
end;
$$;

create constraint trigger import_manifest_is_complete after insert on import_manifests
deferrable initially deferred for each row execute function validate_import_manifest_complete();

create function validate_import_lifecycle_command() returns trigger language plpgsql as $$
begin
  if jsonb_typeof(new.request_manifest) is distinct from 'object'
    or (select array_agg(key order by key) from jsonb_object_keys(new.request_manifest) key)
      is distinct from array['action','actorId','actorPurpose','itemIds','manifestId',
        'reason','reviewDecision']::text[]
    or (select count(distinct item_id) from unnest(new.item_ids) item_id)
      is distinct from cardinality(new.item_ids)
    or (select count(*) from import_source_items item
         where item.manifest_id=new.manifest_id and item.id=any(new.item_ids))
      is distinct from cardinality(new.item_ids)
    or (select count(distinct lifecycle_id) from unnest(new.result_lifecycle_ids) lifecycle_id)
      is distinct from cardinality(new.result_lifecycle_ids)
    or (select count(distinct event_id) from unnest(new.result_event_ids) event_id)
      is distinct from cardinality(new.result_event_ids)
    or recall_manifest_digest(new.request_manifest) is distinct from new.request_digest
    or new.request_manifest->'action' is distinct from to_jsonb(new.action)
    or new.request_manifest->'actorId' is distinct from to_jsonb(new.actor_id)
    or new.request_manifest->'actorPurpose' is distinct from to_jsonb(new.actor_purpose)
    or new.request_manifest->'manifestId' is distinct from to_jsonb(new.manifest_id::text)
    or new.request_manifest->'reason' is distinct from to_jsonb(new.reason)
    or jsonb_typeof(new.request_manifest->'itemIds') is distinct from 'array'
    or new.request_manifest->'itemIds' is distinct from to_jsonb(new.item_ids)
    or new.request_manifest->'reviewDecision' is distinct from
      coalesce(to_jsonb(new.review_decision),'null'::jsonb)
  then raise exception 'IMPORT_LIFECYCLE_COMMAND_INVALID'; end if;
  return new;
end;
$$;

create trigger import_lifecycle_commands_validate before insert on import_lifecycle_commands
for each row execute function validate_import_lifecycle_command();

create function validate_import_lifecycle_idempotency_alias() returns trigger language plpgsql as $$
declare command_row import_lifecycle_commands%rowtype;
begin
  select * into command_row from import_lifecycle_commands where id=new.command_id;
  if command_row.id is null
    or new.request_digest is distinct from command_row.request_digest
    or new.created_at<command_row.created_at
  then raise exception 'IMPORT_LIFECYCLE_IDEMPOTENCY_ALIAS_INVALID'; end if;
  return new;
end;
$$;

create trigger import_lifecycle_idempotency_aliases_validate
before insert on import_lifecycle_idempotency_aliases
for each row execute function validate_import_lifecycle_idempotency_alias();

create function validate_import_lifecycle_command_complete() returns trigger language plpgsql as $$
declare lifecycle_ids uuid[];
declare event_ids uuid[];
begin
  select array_agg(lifecycle.id order by lifecycle.item_id),
         array_agg(lifecycle.event_id order by lifecycle.item_id)
    into lifecycle_ids,event_ids
    from import_item_lifecycle_events lifecycle
    join import_event_authorities authority on authority.event_id=lifecycle.event_id
   where lifecycle.command_id=new.id and lifecycle.manifest_id=new.manifest_id
     and lifecycle.action=new.action and lifecycle.reviewer=new.actor_id
     and lifecycle.reason=new.reason
     and lifecycle.created_at=new.created_at
     and lifecycle.review_decision is not distinct from new.review_decision;
  if lifecycle_ids is distinct from new.result_lifecycle_ids
    or event_ids is distinct from new.result_event_ids
    or not exists (
      select 1 from import_lifecycle_idempotency_aliases alias
       where alias.idempotency_key=new.idempotency_key and alias.command_id=new.id
         and alias.request_digest=new.request_digest
    )
  then raise exception 'INCOMPLETE_IMPORT_LIFECYCLE_COMMAND'; end if;
  return new;
end;
$$;

create constraint trigger import_lifecycle_command_is_complete
after insert on import_lifecycle_commands deferrable initially deferred
for each row execute function validate_import_lifecycle_command_complete();

create function reject_import_authority_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_IMPORT_AUTHORITY';
end;
$$;

create trigger import_manifests_are_immutable before update or delete on import_manifests
for each row execute function reject_import_authority_mutation();
create trigger import_source_items_are_immutable before update or delete on import_source_items
for each row execute function reject_import_authority_mutation();
create trigger import_lifecycle_is_immutable before update or delete on import_item_lifecycle_events
for each row execute function reject_import_authority_mutation();
create trigger import_event_authorities_are_immutable before update or delete on import_event_authorities
for each row execute function reject_import_authority_mutation();
create trigger import_lifecycle_commands_are_immutable before update or delete on import_lifecycle_commands
for each row execute function reject_import_authority_mutation();
create trigger import_lifecycle_idempotency_aliases_are_immutable
before update or delete on import_lifecycle_idempotency_aliases
for each row execute function reject_import_authority_mutation();
create trigger import_memory_projections_are_immutable before update or delete on import_memory_projections
for each row execute function reject_import_authority_mutation();
create trigger import_review_queue_entries_are_immutable before update or delete on import_review_queue_entries
for each row execute function reject_import_authority_mutation();
create trigger import_verification_receipts_are_immutable before update or delete on import_verification_receipts
for each row execute function reject_import_authority_mutation();

create function preserve_import_outbox_authority() returns trigger language plpgsql as $$
begin
  if old.topic in (
    'import.manifest.committed','import.item.classified','import.item.lifecycle_recorded',
    'import.verification.completed'
  ) and (tg_op='DELETE' or new.event_id is distinct from old.event_id
    or new.topic is distinct from old.topic
    or new.payload is distinct from old.payload
    or new.created_at is distinct from old.created_at)
  then raise exception 'IMMUTABLE_IMPORT_OUTBOX_AUTHORITY'; end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

create trigger import_outbox_authority_is_immutable before update or delete on transactional_outbox
for each row execute function preserve_import_outbox_authority();
