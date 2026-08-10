create function chat_source_format_supported(source_name text,format_name text)
returns boolean language sql immutable strict as $$
  select (source_name='CHATGPT_EXPORT' and format_name='chatgpt-export-v1')
      or (source_name='CLAUDE_EXPORT' and format_name='claude-export-v1')
      or (source_name='OTHER_EXPORT' and format_name='canonical-chat-v1')
      or (source_name='CONNECTOR' and format_name='canonical-connector-v1');
$$;

create function chat_authority_key(fields text[])
returns text language sql immutable strict as $$
  select 'chat-authority-v1|'||string_agg(
    case when value is null then '-#' else octet_length(value)::text||'#'||value end,
    '|' order by ordinal
  ) from unnest(fields) with ordinality as item(value,ordinal);
$$;

create table chat_source_authorizations (
  id text primary key check (length(id) between 1 and 200),
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  source text not null check (source in (
    'CHATGPT_EXPORT','CLAUDE_EXPORT','OTHER_EXPORT','CONNECTOR'
  )),
  external_source_id text not null check (length(external_source_id) between 1 and 200),
  granted_by_account_id uuid not null references accounts(id),
  granted_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  unique (account_id,source,external_source_id),
  check (granted_by_account_id=account_id),
  check (revoked_at is null or revoked_at>=granted_at)
);

create function protect_chat_source_authorization() returns trigger
language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'IMMUTABLE_CHAT_SOURCE_AUTHORIZATION'; end if;
  if new.id=old.id and new.account_id=old.account_id and new.node_brain_id=old.node_brain_id
     and new.source=old.source and new.external_source_id=old.external_source_id
     and new.granted_by_account_id=old.granted_by_account_id and new.granted_at=old.granted_at
     and old.revoked_at is null and new.revoked_at is not null then return new; end if;
  raise exception 'IMMUTABLE_CHAT_SOURCE_AUTHORIZATION';
end;
$$;
create trigger chat_source_authorization_is_durable
before update or delete on chat_source_authorizations
for each row execute function protect_chat_source_authorization();

create function reject_immutable_chat_source_record() returns trigger
language plpgsql as $$ begin raise exception 'IMMUTABLE_CHAT_SOURCE_RECORD'; end; $$;

create table chat_sources (
  id uuid primary key,
  authorization_id text not null references chat_source_authorizations(id),
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  source text not null check (source in (
    'CHATGPT_EXPORT','CLAUDE_EXPORT','OTHER_EXPORT','CONNECTOR'
  )),
  external_source_id text not null check (length(external_source_id) between 1 and 200),
  identity_digest char(64) not null unique check (identity_digest ~ '^[a-f0-9]{64}$'),
  connected_event_id uuid not null unique references encrypted_event_bodies(event_id),
  connected_at timestamptz not null,
  foreign key (node_brain_id,account_id) references node_brains(id,account_id),
  unique (account_id,source,external_source_id),
  unique (id,account_id,node_brain_id)
);

create function enforce_chat_source_authorization() returns trigger language plpgsql as $$
begin
  perform 1 from chat_source_authorizations a
   where a.id=new.authorization_id and a.account_id=new.account_id
     and a.node_brain_id=new.node_brain_id and a.source=new.source
     and a.external_source_id=new.external_source_id
     and a.granted_at<=clock_timestamp() and a.revoked_at is null for share;
  if not found then raise exception 'CHAT_SOURCE_AUTHORIZATION_MISMATCH'; end if;
  if not exists (
    select 1 from events e where e.id=new.connected_event_id
      and e.aggregate_id=new.id::text and e.account_id=new.account_id::text
      and e.actor_type='SYSTEM' and e.actor_id='external-chat-importer'
      and e.type='chat.source.connected' and e.visibility='PRIVATE_ACCOUNT'
  ) then raise exception 'CHAT_SOURCE_EVENT_MISMATCH'; end if;
  return new;
end;
$$;
create trigger chat_source_requires_owner_authorization
before insert on chat_sources for each row execute function enforce_chat_source_authorization();
create trigger chat_sources_are_immutable before update or delete on chat_sources
for each row execute function reject_immutable_chat_source_record();

create table chat_source_imports (
  id uuid primary key,
  chat_source_id uuid not null,
  authorization_id text not null references chat_source_authorizations(id),
  account_id uuid not null,
  node_brain_id uuid not null,
  source_revision bigint not null check (source_revision>0),
  format_version text not null check (length(format_version) between 1 and 80),
  exported_at timestamptz not null,
  external_cursor_digest char(64) not null check (external_cursor_digest ~ '^[a-f0-9]{64}$'),
  manifest_digest char(64) not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  conversation_count integer not null check (conversation_count between 0 and 100),
  item_count integer not null check (item_count between 0 and 10000),
  quarantined_count integer not null check (quarantined_count between 0 and 10000),
  occurrence_manifest text not null check (octet_length(occurrence_manifest)<=8000000),
  occurrence_manifest_digest char(64) not null check (occurrence_manifest_digest ~ '^[a-f0-9]{64}$'),
  cursor_event_id uuid not null unique references encrypted_event_bodies(event_id),
  created_at timestamptz not null,
  foreign key (chat_source_id,account_id,node_brain_id)
    references chat_sources(id,account_id,node_brain_id),
  unique (chat_source_id,manifest_digest),
  unique (chat_source_id,external_cursor_digest),
  unique (chat_source_id,source_revision),
  unique (id,chat_source_id),
  unique (id,chat_source_id,account_id,node_brain_id)
);

create table imported_chat_conversations (
  id uuid primary key,
  chat_source_id uuid not null references chat_sources(id),
  account_id uuid not null,
  node_brain_id uuid not null,
  external_conversation_id text not null check (length(external_conversation_id) between 1 and 200),
  identity_digest char(64) not null unique check (identity_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  unique (chat_source_id,external_conversation_id),
  unique (id,chat_source_id,account_id,node_brain_id)
);

create table imported_chat_conversation_versions (
  id uuid primary key,
  imported_conversation_id uuid not null,
  chat_source_id uuid not null,
  account_id uuid not null,
  node_brain_id uuid not null,
  version integer not null check (version between 1 and 1000000),
  version_identity_digest char(64) not null unique check (version_identity_digest ~ '^[a-f0-9]{64}$'),
  participant_count integer not null check (participant_count between 1 and 50),
  participants_digest char(64) not null check (participants_digest ~ '^[a-f0-9]{64}$'),
  imported_event_id uuid not null unique references encrypted_event_bodies(event_id),
  import_id uuid not null,
  predecessor_version_id uuid references imported_chat_conversation_versions(id),
  created_at timestamptz not null,
  foreign key (imported_conversation_id,chat_source_id,account_id,node_brain_id)
    references imported_chat_conversations(id,chat_source_id,account_id,node_brain_id),
  foreign key (import_id,chat_source_id,account_id,node_brain_id)
    references chat_source_imports(id,chat_source_id,account_id,node_brain_id),
  unique (imported_conversation_id,version),
  unique (id,imported_conversation_id,chat_source_id),
  unique (id,imported_conversation_id,chat_source_id,account_id,node_brain_id),
  check ((version=1 and predecessor_version_id is null)
    or (version>1 and predecessor_version_id is not null))
);

create table imported_chat_message_versions (
  id uuid primary key,
  imported_conversation_id uuid not null,
  chat_source_id uuid not null,
  account_id uuid not null,
  node_brain_id uuid not null,
  external_message_id text not null check (length(external_message_id) between 1 and 200),
  participant_identity_digest char(64) not null check (participant_identity_digest ~ '^[a-f0-9]{64}$'),
  message_identity_digest char(64) not null check (message_identity_digest ~ '^[a-f0-9]{64}$'),
  version integer not null check (version between 1 and 1000000),
  version_identity_digest char(64) not null unique check (version_identity_digest ~ '^[a-f0-9]{64}$'),
  content_digest char(64) not null check (content_digest ~ '^[a-f0-9]{64}$'),
  source_record_digest char(64) not null check (source_record_digest ~ '^[a-f0-9]{64}$'),
  role text not null check (role in ('USER','ASSISTANT','SYSTEM','TOOL')),
  source_at timestamptz not null,
  event_id uuid not null unique references encrypted_event_bodies(event_id),
  import_id uuid not null,
  supersedes_message_version_id uuid references imported_chat_message_versions(id),
  created_at timestamptz not null,
  foreign key (imported_conversation_id,chat_source_id,account_id,node_brain_id)
    references imported_chat_conversations(id,chat_source_id,account_id,node_brain_id),
  foreign key (import_id,chat_source_id,account_id,node_brain_id)
    references chat_source_imports(id,chat_source_id,account_id,node_brain_id),
  unique (imported_conversation_id,external_message_id,version),
  unique (id,imported_conversation_id,external_message_id,chat_source_id,account_id,node_brain_id),
  check ((version=1 and supersedes_message_version_id is null)
    or (version>1 and supersedes_message_version_id is not null))
);
create index imported_chat_messages_latest_idx
  on imported_chat_message_versions (imported_conversation_id,external_message_id,version desc);
create index imported_chat_message_occurrence_idx on imported_chat_message_versions (id,chat_source_id);

create table chat_import_quarantine (
  id uuid primary key,
  chat_source_id uuid not null,
  account_id uuid not null,
  node_brain_id uuid not null,
  first_import_id uuid not null,
  item_scope text not null check (item_scope in ('CONVERSATION','MESSAGE')),
  conversation_ordinal integer not null check (conversation_ordinal between 0 and 99),
  external_conversation_id text,
  external_message_id text,
  first_item_ordinal integer not null,
  record_digest char(64) not null check (record_digest ~ '^[a-f0-9]{64}$'),
  reason text not null check (length(reason) between 1 and 120),
  event_id uuid not null unique references encrypted_event_bodies(event_id),
  created_at timestamptz not null,
  foreign key (chat_source_id,account_id,node_brain_id)
    references chat_sources(id,account_id,node_brain_id),
  foreign key (first_import_id,chat_source_id,account_id,node_brain_id)
    references chat_source_imports(id,chat_source_id,account_id,node_brain_id),
  unique (chat_source_id,record_digest,reason),
  constraint chat_quarantine_payload_ordinal_bound
    check (first_item_ordinal between 100 and 10099)
);

create table chat_source_cursors (
  chat_source_id uuid primary key references chat_sources(id),
  account_id uuid not null,
  node_brain_id uuid not null,
  last_import_id uuid not null,
  cursor_event_id uuid not null,
  external_cursor_digest char(64) not null check (external_cursor_digest ~ '^[a-f0-9]{64}$'),
  manifest_digest char(64) not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  revision bigint not null check (revision>0),
  advanced_at timestamptz not null,
  foreign key (chat_source_id,account_id,node_brain_id)
    references chat_sources(id,account_id,node_brain_id),
  foreign key (last_import_id,chat_source_id) references chat_source_imports(id,chat_source_id),
  foreign key (cursor_event_id) references encrypted_event_bodies(event_id)
);

create table chat_import_conversation_occurrences (
  import_id uuid not null,
  chat_source_id uuid not null,
  ordinal integer not null check (ordinal between 0 and 99),
  imported_conversation_id uuid not null,
  conversation_version_id uuid not null,
  created_at timestamptz not null,
  foreign key (import_id,chat_source_id) references chat_source_imports(id,chat_source_id),
  foreign key (conversation_version_id,imported_conversation_id,chat_source_id)
    references imported_chat_conversation_versions(id,imported_conversation_id,chat_source_id),
  primary key (import_id,ordinal),
  unique (import_id,imported_conversation_id)
);

create table chat_import_item_occurrences (
  import_id uuid not null,
  chat_source_id uuid not null,
  ordinal integer not null,
  kind text not null check (kind in ('MESSAGE_VERSION','QUARANTINE')),
  message_version_id uuid,
  quarantine_payload_id uuid,
  record_digest char(64) not null check (record_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (import_id,chat_source_id) references chat_source_imports(id,chat_source_id),
  foreign key (message_version_id) references imported_chat_message_versions(id),
  foreign key (quarantine_payload_id) references chat_import_quarantine(id),
  primary key (import_id,ordinal),
  check ((kind='MESSAGE_VERSION' and message_version_id is not null and quarantine_payload_id is null)
    or (kind='QUARANTINE' and message_version_id is null and quarantine_payload_id is not null)),
  constraint chat_import_item_occurrence_ordinal_bound check (ordinal between 100 and 10099)
);

create table chat_import_quarantine_occurrences (
  import_id uuid not null,
  chat_source_id uuid not null,
  item_ordinal integer not null,
  quarantine_payload_id uuid not null references chat_import_quarantine(id),
  item_scope text not null check (item_scope in ('CONVERSATION','MESSAGE')),
  conversation_ordinal integer not null check (conversation_ordinal between 0 and 99),
  created_at timestamptz not null,
  foreign key (import_id,chat_source_id) references chat_source_imports(id,chat_source_id),
  primary key (import_id,item_ordinal),
  constraint chat_quarantine_occurrence_ordinal_bound check (item_ordinal between 100 and 10099)
);

create table chat_source_event_manifests (
  event_id uuid primary key references encrypted_event_bodies(event_id),
  kind text not null check (kind in (
    'SOURCE_CONNECTED','CURSOR_ADVANCED','CONVERSATION_VERSION','MESSAGE_VERSION','QUARANTINE_PAYLOAD'
  )),
  chat_source_id uuid not null,
  account_id uuid not null,
  node_brain_id uuid not null,
  source text,
  authorization_id text,
  import_id uuid,
  source_revision bigint,
  imported_conversation_id uuid,
  conversation_version_id uuid,
  external_source_id text,
  identity_digest char(64),
  external_conversation_id text,
  external_message_id text,
  participant_identity_digest char(64),
  participant_count integer,
  participants_digest char(64),
  message_version_id uuid,
  message_version integer,
  message_identity_digest char(64),
  version_identity_digest char(64),
  content_digest char(64),
  role text,
  source_at timestamptz,
  predecessor_id uuid,
  quarantine_payload_id uuid,
  item_ordinal integer,
  record_digest char(64),
  reason text,
  format_version text,
  exported_at timestamptz,
  external_cursor_digest char(64),
  manifest_digest char(64),
  conversation_count integer,
  item_count integer,
  quarantined_count integer,
  occurrence_manifest_digest char(64),
  item_scope text,
  conversation_ordinal integer,
  authority_key text not null unique,
  event_request_hash char(64) not null check (event_request_hash ~ '^[a-f0-9]{64}$'),
  event_integrity_hash char(64) not null check (event_integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);
create index chat_source_event_manifest_replay_idx
  on chat_source_event_manifests (chat_source_id,account_id,event_id);

create function chat_manifest_authority_fields(m chat_source_event_manifests)
returns text[] language sql immutable strict as $$
  select array[
    m.kind,m.chat_source_id::text,m.account_id::text,m.node_brain_id::text,m.source,
    m.authorization_id,m.import_id::text,m.source_revision::text,m.imported_conversation_id::text,
    m.conversation_version_id::text,m.external_source_id,m.identity_digest,m.external_conversation_id,
    m.external_message_id,m.participant_identity_digest,m.participant_count::text,
    m.participants_digest,m.message_version_id::text,m.message_version::text,
    m.message_identity_digest,m.version_identity_digest,m.content_digest,m.role,
    case when m.source_at is null then null else to_char(m.source_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    m.predecessor_id::text,m.quarantine_payload_id::text,m.item_ordinal::text,
    m.record_digest,m.reason,m.format_version,
    case when m.exported_at is null then null else to_char(m.exported_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    m.external_cursor_digest,m.manifest_digest,m.conversation_count::text,
    m.item_count::text,m.quarantined_count::text,m.occurrence_manifest_digest,
    m.item_scope,m.conversation_ordinal::text
  ];
$$;

create function enforce_chat_event_manifest_authority() returns trigger language plpgsql as $$
declare expected_type text;
declare expected_aggregate text;
begin
  expected_type := case new.kind
    when 'SOURCE_CONNECTED' then 'chat.source.connected'
    when 'CURSOR_ADVANCED' then 'chat.source.cursor_advanced'
    when 'CONVERSATION_VERSION' then 'conversation.imported'
    when 'MESSAGE_VERSION' then 'knowledge.item.imported'
    when 'QUARANTINE_PAYLOAD' then 'knowledge.item.classified' end;
  expected_aggregate := case when new.kind in ('CONVERSATION_VERSION','MESSAGE_VERSION')
    then new.imported_conversation_id::text else new.chat_source_id::text end;
  if new.authority_key<>chat_authority_key(chat_manifest_authority_fields(new)) then
    raise exception 'CHAT_EVENT_AUTHORITY_MISMATCH';
  end if;
  if not exists (
    select 1 from events e where e.id=new.event_id and e.type=expected_type
      and e.aggregate_id=expected_aggregate and e.account_id=new.account_id::text
      and e.actor_type='SYSTEM' and e.actor_id='external-chat-importer'
      and e.policy_version='external-chat-import-v1'
      and e.visibility='PRIVATE_ACCOUNT' and e.idempotency_key=new.authority_key
      and e.request_hash=new.event_request_hash and e.integrity_hash=new.event_integrity_hash
  ) then raise exception 'CHAT_EVENT_AUTHORITY_MISMATCH'; end if;
  return new;
end;
$$;
create trigger chat_event_manifest_has_exact_authority
before insert on chat_source_event_manifests
for each row execute function enforce_chat_event_manifest_authority();
create trigger chat_source_event_manifests_are_immutable
before update or delete on chat_source_event_manifests
for each row execute function reject_immutable_chat_source_record();

create function enforce_chat_import_scope() returns trigger language plpgsql as $$
declare current_revision bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('chat-source:'||new.authorization_id,0));
  perform 1 from chat_sources s join chat_source_authorizations a on a.id=s.authorization_id
   where s.id=new.chat_source_id and s.authorization_id=new.authorization_id
     and s.account_id=new.account_id and s.node_brain_id=new.node_brain_id
     and a.revoked_at is null and a.granted_at<=clock_timestamp() for share of a;
  if not found then raise exception 'CHAT_IMPORT_SCOPE_MISMATCH'; end if;
  select coalesce(c.revision,0) into current_revision from chat_sources s
    left join chat_source_cursors c on c.chat_source_id=s.id where s.id=new.chat_source_id;
  if current_revision+1<>new.source_revision then raise exception 'CHAT_IMPORT_REVISION_MISMATCH'; end if;
  if not chat_source_format_supported((select source from chat_sources where id=new.chat_source_id),new.format_version)
     then raise exception 'UNSUPPORTED_CHAT_SOURCE_FORMAT'; end if;
  if not exists (
    select 1 from chat_source_event_manifests m
     where m.event_id=new.cursor_event_id and m.kind='CURSOR_ADVANCED'
       and m.chat_source_id=new.chat_source_id and m.account_id=new.account_id
       and m.node_brain_id=new.node_brain_id and m.authorization_id=new.authorization_id
       and m.import_id=new.id and m.source_revision=new.source_revision
       and m.source=(select s.source from chat_sources s where s.id=new.chat_source_id)
       and m.external_source_id=(select s.external_source_id from chat_sources s where s.id=new.chat_source_id)
       and m.format_version=new.format_version and m.exported_at=new.exported_at
       and m.external_cursor_digest=new.external_cursor_digest
       and m.manifest_digest=new.manifest_digest
       and m.conversation_count=new.conversation_count and m.item_count=new.item_count
       and m.quarantined_count=new.quarantined_count
       and m.occurrence_manifest_digest=new.occurrence_manifest_digest
       and m.created_at=new.created_at
   ) then raise exception 'CHAT_IMPORT_AUTHORITY_MISMATCH'; end if;
  if encode(sha256(convert_to(new.occurrence_manifest,'UTF8')),'hex')<>new.occurrence_manifest_digest
     or jsonb_typeof(new.occurrence_manifest::jsonb)<>'array'
     or jsonb_array_length(new.occurrence_manifest::jsonb)>10100
    then raise exception 'CHAT_IMPORT_OCCURRENCE_MANIFEST_MISMATCH'; end if;
  return new;
end;
$$;
create trigger chat_import_scope_is_consistent before insert on chat_source_imports
for each row execute function enforce_chat_import_scope();
create trigger chat_source_imports_are_immutable before update or delete on chat_source_imports
for each row execute function reject_immutable_chat_source_record();

create function enforce_conversation_scope() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from chat_sources s where s.id=new.chat_source_id
    and s.account_id=new.account_id and s.node_brain_id=new.node_brain_id)
    then raise exception 'CHAT_CONVERSATION_SCOPE_MISMATCH'; end if;
  return new;
end;
$$;
create trigger imported_chat_conversation_scope_is_consistent before insert on imported_chat_conversations
for each row execute function enforce_conversation_scope();

create function enforce_conversation_version_authority() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from chat_source_event_manifests m
      join chat_source_imports i on i.id=new.import_id
      join imported_chat_conversations c on c.id=new.imported_conversation_id
     where m.event_id=new.imported_event_id and m.kind='CONVERSATION_VERSION'
       and m.chat_source_id=new.chat_source_id and m.account_id=new.account_id
       and m.node_brain_id=new.node_brain_id and m.import_id=new.import_id
       and m.imported_conversation_id=new.imported_conversation_id
       and m.conversation_version_id=new.id and m.message_version=new.version
       and m.identity_digest=c.identity_digest
       and m.version_identity_digest=new.version_identity_digest
       and m.participant_count=new.participant_count and m.participants_digest=new.participants_digest
       and m.predecessor_id is not distinct from new.predecessor_version_id
       and m.source_revision=i.source_revision
       and m.external_conversation_id=c.external_conversation_id
       and m.created_at=new.created_at
  ) then raise exception 'CHAT_CONVERSATION_AUTHORITY_MISMATCH'; end if;
  return new;
end;
$$;
create trigger imported_chat_conversation_version_has_authority
before insert on imported_chat_conversation_versions
for each row execute function enforce_conversation_version_authority();

create function enforce_message_authority() returns trigger language plpgsql as $$
declare prior_version integer; declare prior_digest char(64);
begin
  if not exists (
    select 1 from chat_source_event_manifests m
      join chat_source_imports i on i.id=new.import_id
      join imported_chat_conversations c on c.id=new.imported_conversation_id
     where m.event_id=new.event_id and m.kind='MESSAGE_VERSION'
       and m.chat_source_id=new.chat_source_id and m.account_id=new.account_id
       and m.node_brain_id=new.node_brain_id and m.import_id=new.import_id
       and m.imported_conversation_id=new.imported_conversation_id
       and m.external_message_id=new.external_message_id
       and m.participant_identity_digest=new.participant_identity_digest
       and m.message_version_id=new.id and m.message_version=new.version
       and m.message_identity_digest=new.message_identity_digest
       and m.version_identity_digest=new.version_identity_digest
       and m.content_digest=new.content_digest and m.record_digest=new.source_record_digest
       and m.role=new.role and m.source_at=new.source_at
       and m.predecessor_id is not distinct from new.supersedes_message_version_id
       and m.source_revision=i.source_revision
       and m.external_conversation_id=c.external_conversation_id
  ) then raise exception 'CHAT_MESSAGE_AUTHORITY_MISMATCH'; end if;
  if new.supersedes_message_version_id is not null then
    select v.version,v.content_digest into prior_version,prior_digest
      from imported_chat_message_versions v where v.id=new.supersedes_message_version_id
       and v.imported_conversation_id=new.imported_conversation_id
       and v.external_message_id=new.external_message_id;
    if prior_version is null or prior_version+1<>new.version or prior_digest=new.content_digest
      then raise exception 'CHAT_MESSAGE_VERSION_MISMATCH'; end if;
  end if;
  return new;
end;
$$;
create trigger imported_chat_message_has_authority before insert on imported_chat_message_versions
for each row execute function enforce_message_authority();

create function validate_chat_version_correction() returns trigger language plpgsql as $$
begin
  if tg_table_name='imported_chat_conversation_versions' then
    if not exists (
      select 1 from chat_source_event_manifests m
      join chat_source_imports i on i.id=new.import_id
      join imported_chat_conversations c on c.id=new.imported_conversation_id
       where m.event_id=new.imported_event_id and m.kind='CONVERSATION_VERSION'
         and m.imported_conversation_id=new.imported_conversation_id
         and m.conversation_version_id=new.id and m.message_version=new.version
         and m.identity_digest=c.identity_digest
         and m.version_identity_digest=new.version_identity_digest
         and m.participant_count=new.participant_count
         and m.participants_digest=new.participants_digest
         and m.predecessor_id is not distinct from new.predecessor_version_id
         and m.source_revision=i.source_revision
    ) then raise exception 'CHAT_CONVERSATION_VERSION_MISMATCH'; end if;
    if new.version=1 and new.predecessor_version_id is not null
      then raise exception 'CHAT_CONVERSATION_VERSION_MISMATCH'; end if;
    if new.version>1 and not exists (
      select 1 from imported_chat_conversation_versions prior
       where prior.id=new.predecessor_version_id
         and prior.imported_conversation_id=new.imported_conversation_id
         and prior.chat_source_id=new.chat_source_id
         and prior.account_id=new.account_id and prior.node_brain_id=new.node_brain_id
         and prior.version=new.version-1
         and prior.participants_digest<>new.participants_digest
    ) then raise exception 'CHAT_CONVERSATION_VERSION_MISMATCH'; end if;
  else
    if not exists (
      select 1 from chat_source_event_manifests m
      join chat_source_imports i on i.id=new.import_id
       where m.event_id=new.event_id and m.kind='MESSAGE_VERSION'
         and m.imported_conversation_id=new.imported_conversation_id
         and m.message_version_id=new.id and m.message_version=new.version
         and m.message_identity_digest=new.message_identity_digest
         and m.version_identity_digest=new.version_identity_digest
         and m.content_digest=new.content_digest and m.record_digest=new.source_record_digest
         and m.role=new.role and m.source_at=new.source_at
         and m.predecessor_id is not distinct from new.supersedes_message_version_id
         and m.source_revision=i.source_revision
    ) then raise exception 'CHAT_MESSAGE_VERSION_MISMATCH'; end if;
    if new.version=1 and new.supersedes_message_version_id is not null
      then raise exception 'CHAT_MESSAGE_VERSION_MISMATCH'; end if;
    if new.version>1 and not exists (
      select 1 from imported_chat_message_versions prior
       where prior.id=new.supersedes_message_version_id
         and prior.imported_conversation_id=new.imported_conversation_id
         and prior.chat_source_id=new.chat_source_id
         and prior.account_id=new.account_id and prior.node_brain_id=new.node_brain_id
         and prior.external_message_id=new.external_message_id
         and prior.message_identity_digest=new.message_identity_digest
         and prior.version=new.version-1 and prior.content_digest<>new.content_digest
    ) then raise exception 'CHAT_MESSAGE_VERSION_MISMATCH'; end if;
  end if;
  return new;
end;
$$;
create constraint trigger chat_conversation_version_correction_is_exact
after insert on imported_chat_conversation_versions deferrable initially deferred
for each row execute function validate_chat_version_correction();
create constraint trigger chat_message_version_correction_is_exact
after insert on imported_chat_message_versions deferrable initially deferred
for each row execute function validate_chat_version_correction();

create function enforce_quarantine_authority() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from chat_source_event_manifests m
      join chat_source_imports i on i.id=new.first_import_id
     where m.event_id=new.event_id and m.kind='QUARANTINE_PAYLOAD'
       and m.chat_source_id=new.chat_source_id and m.account_id=new.account_id
       and m.node_brain_id=new.node_brain_id and m.import_id=new.first_import_id
       and m.quarantine_payload_id=new.id and m.item_ordinal=new.first_item_ordinal
       and m.item_scope=new.item_scope and m.conversation_ordinal=new.conversation_ordinal
       and m.external_conversation_id is not distinct from new.external_conversation_id
       and m.external_message_id is not distinct from new.external_message_id
       and m.record_digest=new.record_digest and m.reason=new.reason
       and m.source_revision=i.source_revision and m.created_at=new.created_at
  ) then raise exception 'CHAT_QUARANTINE_AUTHORITY_MISMATCH'; end if;
  return new;
end;
$$;
create trigger chat_quarantine_has_authority before insert on chat_import_quarantine
for each row execute function enforce_quarantine_authority();

create function enforce_chat_cursor_advance() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from chat_source_imports i where i.id=new.last_import_id
      and i.chat_source_id=new.chat_source_id and i.account_id=new.account_id
      and i.node_brain_id=new.node_brain_id and i.source_revision=new.revision
      and i.cursor_event_id=new.cursor_event_id
      and i.external_cursor_digest=new.external_cursor_digest
      and i.manifest_digest=new.manifest_digest
  ) then raise exception 'CHAT_CURSOR_IMPORT_MISMATCH'; end if;
  if tg_op='INSERT' and new.revision<>1 then raise exception 'CHAT_CURSOR_REVISION_MISMATCH'; end if;
  if tg_op='UPDATE' and (new.chat_source_id<>old.chat_source_id
    or new.account_id<>old.account_id or new.node_brain_id<>old.node_brain_id
    or new.revision<>old.revision+1 or new.advanced_at<old.advanced_at)
    then raise exception 'CHAT_CURSOR_REVISION_MISMATCH'; end if;
  return new;
end;
$$;
create trigger chat_source_cursor_advances_atomically before insert or update on chat_source_cursors
for each row execute function enforce_chat_cursor_advance();
create trigger chat_source_cursors_cannot_be_deleted before delete on chat_source_cursors
for each row execute function reject_immutable_chat_source_record();

create function enforce_chat_occurrence_scope() returns trigger language plpgsql as $$
begin
  if tg_table_name='chat_import_conversation_occurrences' then
    if not exists (
      select 1 from chat_source_imports i
      join imported_chat_conversation_versions v on v.id=new.conversation_version_id
       where i.id=new.import_id and i.chat_source_id=new.chat_source_id
          and v.chat_source_id=i.chat_source_id
          and v.imported_conversation_id=new.imported_conversation_id
          and not exists (
            select 1 from imported_chat_conversation_versions newer
             where newer.imported_conversation_id=v.imported_conversation_id
               and newer.version>v.version
          )
    ) then raise exception 'CHAT_CONVERSATION_OCCURRENCE_MISMATCH'; end if;
  elsif tg_table_name='chat_import_item_occurrences' then
    if new.kind='MESSAGE_VERSION' and not exists (
      select 1 from chat_source_imports i
      join imported_chat_message_versions v on v.id=new.message_version_id
       where i.id=new.import_id and i.chat_source_id=new.chat_source_id
          and v.chat_source_id=i.chat_source_id
          and not exists (
            select 1 from imported_chat_message_versions newer
             where newer.imported_conversation_id=v.imported_conversation_id
               and newer.external_message_id=v.external_message_id and newer.version>v.version
          )
    ) then raise exception 'CHAT_ITEM_OCCURRENCE_MISMATCH'; end if;
    if new.kind='QUARANTINE' and not exists (
      select 1 from chat_source_imports i
      join chat_import_quarantine q on q.id=new.quarantine_payload_id
       where i.id=new.import_id and i.chat_source_id=new.chat_source_id
          and q.chat_source_id=i.chat_source_id and q.record_digest=new.record_digest
    ) then raise exception 'CHAT_ITEM_OCCURRENCE_MISMATCH'; end if;
  else
    if not exists (
      select 1 from chat_source_imports i
      join chat_import_item_occurrences x on x.import_id=i.id
        and x.chat_source_id=i.chat_source_id and x.ordinal=new.item_ordinal
        and x.kind='QUARANTINE' and x.quarantine_payload_id=new.quarantine_payload_id
      join chat_import_quarantine q on q.id=x.quarantine_payload_id
       where i.id=new.import_id and i.chat_source_id=new.chat_source_id
          and q.chat_source_id=i.chat_source_id and new.item_scope=q.item_scope
          and new.conversation_ordinal=q.conversation_ordinal
    ) then raise exception 'CHAT_QUARANTINE_OCCURRENCE_MISMATCH'; end if;
  end if;
  if exists (
    select 1 from chat_source_imports i
      join chat_source_cursors c on c.chat_source_id=i.chat_source_id
     where i.id=new.import_id and c.revision>=i.source_revision
  ) then raise exception 'CHAT_IMPORT_BACKFILL_FORBIDDEN'; end if;
  return new;
end;
$$;
create trigger chat_conversation_occurrence_scope before insert on chat_import_conversation_occurrences
for each row execute function enforce_chat_occurrence_scope();
create trigger chat_item_occurrence_scope before insert on chat_import_item_occurrences
for each row execute function enforce_chat_occurrence_scope();
create trigger chat_quarantine_occurrence_scope before insert on chat_import_quarantine_occurrences
for each row execute function enforce_chat_occurrence_scope();

create trigger imported_chat_conversations_are_immutable before update or delete on imported_chat_conversations
for each row execute function reject_immutable_chat_source_record();
create trigger imported_chat_conversation_versions_are_immutable before update or delete on imported_chat_conversation_versions
for each row execute function reject_immutable_chat_source_record();
create trigger imported_chat_message_versions_are_immutable before update or delete on imported_chat_message_versions
for each row execute function reject_immutable_chat_source_record();
create trigger chat_import_quarantine_is_immutable before update or delete on chat_import_quarantine
for each row execute function reject_immutable_chat_source_record();
create trigger chat_import_conversation_occurrences_are_immutable before update or delete on chat_import_conversation_occurrences
for each row execute function reject_immutable_chat_source_record();
create trigger chat_import_item_occurrences_are_immutable before update or delete on chat_import_item_occurrences
for each row execute function reject_immutable_chat_source_record();
create trigger chat_import_quarantine_occurrences_are_immutable before update or delete on chat_import_quarantine_occurrences
for each row execute function reject_immutable_chat_source_record();

create index chat_conversation_version_occurrence_idx
  on chat_import_conversation_occurrences (conversation_version_id);
create index chat_message_version_occurrence_idx
  on chat_import_item_occurrences (message_version_id) where message_version_id is not null;
create index chat_quarantine_item_occurrence_idx
  on chat_import_item_occurrences (quarantine_payload_id) where quarantine_payload_id is not null;
create index chat_quarantine_occurrence_payload_idx
  on chat_import_quarantine_occurrences (quarantine_payload_id);

create function chat_import_occurrences_match(target_import uuid)
returns boolean language sql stable as $$
  with selected as (
    select i.*,i.occurrence_manifest::jsonb as manifest
      from chat_source_imports i where i.id=target_import
  ), entries as (
    select value as entry,ordinality::integer as position
      from selected s cross join lateral jsonb_array_elements(s.manifest) with ordinality
  ), ordered as (
    select e.*,lag((entry->>'ordinal')::integer) over (order by position) as prior_ordinal
      from entries e
  ), conversation_slots as (
    select (entry->>'ordinal')::integer as ordinal from entries where entry->>'kind'='CONVERSATION'
    union all
    select (entry->>'conversationOrdinal')::integer from entries
     where entry->>'kind'='QUARANTINE' and entry->>'itemScope'='CONVERSATION'
  ), item_slots as (
    select (entry->>'ordinal')::integer as ordinal from entries
     where entry->>'kind' in ('MESSAGE_VERSION','QUARANTINE')
  )
  select coalesce((
    select
      jsonb_array_length(s.manifest)=(select count(*) from entries)
      and not exists (select 1 from entries where entry->>'kind' not in
        ('CONVERSATION','MESSAGE_VERSION','QUARANTINE'))
      and not exists (select 1 from ordered where prior_ordinal is not null
        and (entry->>'ordinal')::integer<=prior_ordinal)
      and (select count(*) from conversation_slots)=s.conversation_count
      and (s.conversation_count=0 or (
        (select min(ordinal) from conversation_slots)=0
        and (select max(ordinal) from conversation_slots)=s.conversation_count-1
        and (select count(distinct ordinal) from conversation_slots)=s.conversation_count))
      and (select count(*) from item_slots)=s.item_count
      and (s.item_count=0 or (
        (select min(ordinal) from item_slots)=100
        and (select max(ordinal) from item_slots)=99+s.item_count
        and (select count(distinct ordinal) from item_slots)=s.item_count))
      and (select count(*) from entries where entry->>'kind'='QUARANTINE')=s.quarantined_count
      and (select count(*) from entries where entry->>'kind'='CONVERSATION')=
          (select count(*) from chat_import_conversation_occurrences x where x.import_id=s.id)
      and not exists (
        select 1 from entries e where e.entry->>'kind'='CONVERSATION' and not exists (
          select 1 from chat_import_conversation_occurrences x
          join imported_chat_conversations c on c.id=x.imported_conversation_id
          join imported_chat_conversation_versions v on v.id=x.conversation_version_id
           where x.import_id=s.id and x.ordinal=(e.entry->>'ordinal')::integer
             and x.imported_conversation_id=(e.entry->>'importedConversationId')::uuid
             and c.external_conversation_id=e.entry->>'externalConversationId'
             and v.participant_count=(e.entry->>'participantCount')::integer
             and v.participants_digest=e.entry->>'participantsDigest'
        )
      )
      and (select count(*) from entries where entry->>'kind' in ('MESSAGE_VERSION','QUARANTINE'))=
          (select count(*) from chat_import_item_occurrences x where x.import_id=s.id)
      and not exists (
        select 1 from entries e where e.entry->>'kind'='MESSAGE_VERSION' and not exists (
          select 1 from chat_import_item_occurrences x
          join imported_chat_message_versions v on v.id=x.message_version_id
           where x.import_id=s.id and x.kind='MESSAGE_VERSION'
             and x.ordinal=(e.entry->>'ordinal')::integer
             and v.imported_conversation_id=(e.entry->>'importedConversationId')::uuid
             and v.external_message_id=e.entry->>'externalMessageId'
             and v.message_identity_digest=e.entry->>'messageIdentityDigest'
             and v.content_digest=e.entry->>'contentDigest'
             and x.record_digest=e.entry->>'recordDigest'
        )
      )
      and not exists (
        select 1 from entries e where e.entry->>'kind'='QUARANTINE' and not exists (
          select 1 from chat_import_item_occurrences x
          join chat_import_quarantine_occurrences qx on qx.import_id=x.import_id
            and qx.item_ordinal=x.ordinal and qx.quarantine_payload_id=x.quarantine_payload_id
          join chat_import_quarantine q on q.id=x.quarantine_payload_id
           where x.import_id=s.id and x.kind='QUARANTINE'
             and x.ordinal=(e.entry->>'ordinal')::integer
             and q.id=(e.entry->>'quarantinePayloadId')::uuid
             and qx.item_scope=e.entry->>'itemScope'
             and qx.conversation_ordinal=(e.entry->>'conversationOrdinal')::integer
             and q.external_conversation_id is not distinct from nullif(e.entry->>'externalConversationId','')
             and q.external_message_id is not distinct from nullif(e.entry->>'externalMessageId','')
             and q.record_digest=e.entry->>'recordDigest' and q.reason=e.entry->>'reason'
             and x.record_digest=e.entry->>'recordDigest'
        )
      )
    from selected s
  ),false);
$$;

create function validate_chat_import_graph() returns trigger language plpgsql as $$
declare target_import uuid; declare valid boolean;
begin
  if tg_table_name='chat_source_imports' then
    target_import := new.id;
  elsif tg_table_name='chat_source_cursors' then
    target_import := new.last_import_id;
  else
    target_import := new.import_id;
  end if;
  select exists (
    select 1 from chat_source_imports i
    join chat_sources s on s.id=i.chat_source_id
    join chat_source_authorizations a on a.id=i.authorization_id
      and a.account_id=i.account_id and a.node_brain_id=i.node_brain_id
      and a.revoked_at is null and a.granted_at<=clock_timestamp()
    join chat_source_event_manifests sm on sm.event_id=s.connected_event_id and sm.kind='SOURCE_CONNECTED'
    join chat_source_event_manifests cm on cm.event_id=i.cursor_event_id and cm.kind='CURSOR_ADVANCED'
    join chat_source_cursors c on c.last_import_id=i.id and c.chat_source_id=i.chat_source_id
     and c.cursor_event_id=i.cursor_event_id and c.revision=i.source_revision
    where i.id=target_import
      and i.conversation_count=(
        (select count(*) from chat_import_conversation_occurrences x where x.import_id=i.id)
        +(select count(*) from chat_import_quarantine_occurrences x
           where x.import_id=i.id and x.item_scope='CONVERSATION'))
      and i.item_count=(select count(*) from chat_import_item_occurrences x where x.import_id=i.id)
      and i.quarantined_count=(select count(*) from chat_import_quarantine_occurrences x where x.import_id=i.id)
      and chat_import_occurrences_match(i.id)
      and not exists (
        select 1 from chat_import_conversation_occurrences x
        left join imported_chat_conversation_versions v on v.id=x.conversation_version_id
        left join chat_source_event_manifests m on m.event_id=v.imported_event_id
        where x.import_id=i.id and (v.id is null or m.kind<>'CONVERSATION_VERSION')
      )
      and not exists (
        select 1 from chat_import_item_occurrences x
        left join imported_chat_message_versions v on v.id=x.message_version_id
        left join chat_import_quarantine q on q.id=x.quarantine_payload_id
        where x.import_id=i.id and ((x.kind='MESSAGE_VERSION' and v.id is null)
          or (x.kind='QUARANTINE' and q.id is null))
      )
      and not exists (
        select 1 from chat_import_item_occurrences x
         where x.import_id=i.id and x.kind='QUARANTINE' and not exists (
           select 1 from chat_import_quarantine_occurrences qx
            where qx.import_id=x.import_id and qx.chat_source_id=x.chat_source_id
              and qx.item_ordinal=x.ordinal
              and qx.quarantine_payload_id=x.quarantine_payload_id
         )
      )
  ) into valid;
  if not valid then raise exception 'INCOMPLETE_CHAT_IMPORT_GRAPH'; end if;
  return new;
end;
$$;
create constraint trigger chat_import_graph_is_complete
after insert on chat_source_imports deferrable initially deferred
for each row execute function validate_chat_import_graph();
create constraint trigger chat_import_children_are_not_orphans
after insert or update on chat_source_cursors deferrable initially deferred
for each row execute function validate_chat_import_graph();

create function validate_chat_child_occurrence() returns trigger language plpgsql as $$
begin
  if tg_table_name='imported_chat_conversation_versions' and not exists (
    select 1 from chat_import_conversation_occurrences x where x.conversation_version_id=new.id
  ) then raise exception 'ORPHAN_CHAT_IMPORT_CHILD'; end if;
  if tg_table_name='imported_chat_message_versions' and not exists (
    select 1 from chat_import_item_occurrences x where x.message_version_id=new.id
  ) then raise exception 'ORPHAN_CHAT_IMPORT_CHILD'; end if;
  if tg_table_name='chat_import_quarantine' and not exists (
    select 1 from chat_import_quarantine_occurrences x where x.quarantine_payload_id=new.id
  ) then raise exception 'ORPHAN_CHAT_IMPORT_CHILD'; end if;
  return new;
end;
$$;
create constraint trigger chat_conversation_version_requires_occurrence
after insert on imported_chat_conversation_versions deferrable initially deferred
for each row execute function validate_chat_child_occurrence();
create constraint trigger chat_message_version_requires_occurrence
after insert on imported_chat_message_versions deferrable initially deferred
for each row execute function validate_chat_child_occurrence();
create constraint trigger chat_quarantine_payload_requires_occurrence
after insert on chat_import_quarantine deferrable initially deferred
for each row execute function validate_chat_child_occurrence();

create function validate_chat_stable_authority() returns trigger language plpgsql as $$
begin
  if tg_table_name='chat_sources' then
    if not exists (
      select 1 from chat_source_event_manifests m where m.event_id=new.connected_event_id
       and m.kind='SOURCE_CONNECTED' and m.chat_source_id=new.id
       and m.account_id=new.account_id and m.node_brain_id=new.node_brain_id
       and m.source=new.source and m.authorization_id=new.authorization_id
       and m.external_source_id=new.external_source_id and m.identity_digest=new.identity_digest
       and m.created_at=new.connected_at
    ) then raise exception 'ORPHAN_CHAT_SOURCE'; end if;
  else
    if not exists (
      select 1 from imported_chat_conversation_versions v
       where v.imported_conversation_id=new.id and v.chat_source_id=new.chat_source_id
    ) then raise exception 'ORPHAN_CHAT_IMPORT_CHILD'; end if;
  end if;
  return new;
end;
$$;
create constraint trigger chat_source_requires_canonical_event
after insert on chat_sources deferrable initially deferred
for each row execute function validate_chat_stable_authority();
create constraint trigger chat_conversation_requires_version
after insert on imported_chat_conversations deferrable initially deferred
for each row execute function validate_chat_stable_authority();

create function validate_chat_manifest_projection() returns trigger language plpgsql as $$
begin
  if new.kind='SOURCE_CONNECTED' and not exists (
    select 1 from chat_sources s where s.connected_event_id=new.event_id and s.id=new.chat_source_id
      and s.account_id=new.account_id and s.node_brain_id=new.node_brain_id
      and s.source=new.source and s.authorization_id=new.authorization_id
      and s.external_source_id=new.external_source_id and s.identity_digest=new.identity_digest
      and s.connected_at=new.created_at
  ) then raise exception 'ORPHAN_CHAT_EVENT_MANIFEST'; end if;
  if new.kind='CURSOR_ADVANCED' and not exists (
    select 1 from chat_source_imports i join chat_sources s on s.id=i.chat_source_id
     where i.cursor_event_id=new.event_id and i.id=new.import_id
       and i.chat_source_id=new.chat_source_id and i.account_id=new.account_id
       and i.node_brain_id=new.node_brain_id and i.authorization_id=new.authorization_id
       and i.source_revision=new.source_revision and s.source=new.source
       and s.external_source_id=new.external_source_id
       and i.format_version=new.format_version and i.exported_at=new.exported_at
       and i.external_cursor_digest=new.external_cursor_digest
       and i.manifest_digest=new.manifest_digest
       and i.conversation_count=new.conversation_count and i.item_count=new.item_count
       and i.quarantined_count=new.quarantined_count
       and i.occurrence_manifest_digest=new.occurrence_manifest_digest
       and i.created_at=new.created_at
  ) then raise exception 'ORPHAN_CHAT_EVENT_MANIFEST'; end if;
  if new.kind='CONVERSATION_VERSION' and not exists (
    select 1 from imported_chat_conversation_versions v
      join imported_chat_conversations c on c.id=v.imported_conversation_id
      join chat_source_imports i on i.id=v.import_id
     where v.imported_event_id=new.event_id and v.id=new.conversation_version_id
       and v.imported_conversation_id=new.imported_conversation_id
       and v.chat_source_id=new.chat_source_id and v.account_id=new.account_id
       and v.node_brain_id=new.node_brain_id and v.import_id=new.import_id
       and i.source_revision=new.source_revision
       and c.external_conversation_id=new.external_conversation_id
       and c.identity_digest=new.identity_digest and v.version=new.message_version
       and v.version_identity_digest=new.version_identity_digest
       and v.participant_count=new.participant_count and v.participants_digest=new.participants_digest
       and v.predecessor_version_id is not distinct from new.predecessor_id
       and v.created_at=new.created_at
  ) then raise exception 'ORPHAN_CHAT_EVENT_MANIFEST'; end if;
  if new.kind='MESSAGE_VERSION' and not exists (
    select 1 from imported_chat_message_versions v
      join imported_chat_conversations c on c.id=v.imported_conversation_id
      join chat_source_imports i on i.id=v.import_id
     where v.event_id=new.event_id and v.id=new.message_version_id
       and v.imported_conversation_id=new.imported_conversation_id
       and v.chat_source_id=new.chat_source_id and v.account_id=new.account_id
       and v.node_brain_id=new.node_brain_id and v.import_id=new.import_id
       and i.source_revision=new.source_revision
       and c.external_conversation_id=new.external_conversation_id
       and v.external_message_id=new.external_message_id
       and v.participant_identity_digest=new.participant_identity_digest
       and v.version=new.message_version and v.message_identity_digest=new.message_identity_digest
       and v.version_identity_digest=new.version_identity_digest
       and v.content_digest=new.content_digest and v.source_record_digest=new.record_digest
       and v.role=new.role and v.source_at=new.source_at
       and v.supersedes_message_version_id is not distinct from new.predecessor_id
  ) then raise exception 'ORPHAN_CHAT_EVENT_MANIFEST'; end if;
  if new.kind='QUARANTINE_PAYLOAD' and not exists (
    select 1 from chat_import_quarantine q join chat_source_imports i on i.id=q.first_import_id
     where q.event_id=new.event_id and q.id=new.quarantine_payload_id
       and q.chat_source_id=new.chat_source_id and q.account_id=new.account_id
       and q.node_brain_id=new.node_brain_id and q.first_import_id=new.import_id
       and i.source_revision=new.source_revision and q.item_scope=new.item_scope
       and q.conversation_ordinal=new.conversation_ordinal
       and q.external_conversation_id is not distinct from new.external_conversation_id
       and q.external_message_id is not distinct from new.external_message_id
       and q.first_item_ordinal=new.item_ordinal and q.record_digest=new.record_digest
       and q.reason=new.reason and q.created_at=new.created_at
  ) then raise exception 'ORPHAN_CHAT_EVENT_MANIFEST'; end if;
  return new;
end;
$$;
create constraint trigger chat_event_manifest_requires_projection
after insert on chat_source_event_manifests deferrable initially deferred
for each row execute function validate_chat_manifest_projection();

create function validate_t20_canonical_event_graph() returns trigger language plpgsql as $$
begin
  if new.type in ('chat.source.connected','chat.source.cursor_advanced',
       'conversation.imported','knowledge.item.imported','knowledge.item.classified')
     and (select count(*) from chat_source_event_manifests m where m.event_id=new.id)<>1
    then raise exception 'ORPHAN_T20_CANONICAL_EVENT'; end if;
  return new;
end;
$$;
create constraint trigger t20_canonical_event_requires_exact_graph
after insert on events deferrable initially deferred
for each row execute function validate_t20_canonical_event_graph();
