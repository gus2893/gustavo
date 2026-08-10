create table thought_records (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  aggregate_id text not null check (length(aggregate_id) between 1 and 256),
  account_id uuid,
  type text not null check (type in (
    'MAIN_POSITION','MAIN_BROADCAST','NODE_REPLY_SUMMARY','NODE_PROPOSAL',
    'HYPOTHESIS','EVIDENCE','COUNTEREVIDENCE','UNCERTAINTY','OPEN_QUESTION',
    'EVALUATION','DECISION','REJECTION_REASON','CORRECTION','LESSON',
    'PAPER_INTENT_RATIONALE','RISK_GATE_RESULT','STAGE_REVIEW','OUTCOME_REVIEW'
  )),
  actor_type text not null check (actor_type in (
    'USER','NODE_BRAIN','MAIN_BRAIN','EVALUATOR','SYSTEM','OPERATOR'
  )),
  actor_id text not null check (length(actor_id) between 1 and 128),
  scope text not null check (scope in (
    'PUBLIC','PRIVATE_ACCOUNT','MAIN_SHARED','CHALLENGE_SHARED','OPERATOR'
  )),
  rationale_digest char(64) check (
    rationale_digest is null or rationale_digest ~ '^[a-f0-9]{64}$'
  ),
  claim_count integer not null check (claim_count between 0 and 32),
  source_count integer not null check (source_count between 1 and 64),
  evidence_count integer not null check (evidence_count between 0 and 64),
  counterevidence_count integer not null check (counterevidence_count between 0 and 64),
  uncertainty text not null check (uncertainty in ('LOW','MEDIUM','HIGH','UNKNOWN')),
  state_kind text not null check (state_kind in (
    'MAIN_STATE','NODE_STATE','CHALLENGE_STATE','CONVERSATION_STATE','IMPORT_STATE'
  )),
  state_id text not null check (length(state_id) between 1 and 256),
  state_version text not null check (length(state_version) between 1 and 128),
  prompt_version text not null check (length(prompt_version) between 1 and 128),
  model_version text not null check (length(model_version) between 1 and 128),
  policy_version text not null check (length(policy_version) between 1 and 128),
  valid_from timestamptz not null,
  valid_until timestamptz,
  supersedes_thought_id uuid unique references thought_records(id),
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  request_digest char(64) check (
    request_digest is null or request_digest ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz not null,
  unique (id, aggregate_id, account_id, scope),
  unique nulls not distinct (
    aggregate_id, account_id, actor_type, actor_id, idempotency_key
  ),
  check (valid_until is null or valid_until > valid_from),
  check ((scope='PRIVATE_ACCOUNT') = (account_id is not null)),
  check ((scope='PRIVATE_ACCOUNT') = (rationale_digest is null)),
  check ((scope='PRIVATE_ACCOUNT') = (request_digest is null)),
  check (
    (actor_type in ('USER','NODE_BRAIN') and scope='PRIVATE_ACCOUNT')
    or (actor_type='MAIN_BRAIN' and actor_id='gustavo-main'
      and scope in ('PUBLIC','MAIN_SHARED','CHALLENGE_SHARED'))
    or (actor_type='EVALUATOR' and scope in ('MAIN_SHARED','CHALLENGE_SHARED'))
    or (actor_type='OPERATOR' and scope='OPERATOR')
    or actor_type='SYSTEM'
  ),
  constraint thought_type_actor_authority_check check (
    (type not in ('MAIN_POSITION','MAIN_BROADCAST','DECISION','PAPER_INTENT_RATIONALE')
      or actor_type='MAIN_BRAIN')
    and (type not in ('NODE_REPLY_SUMMARY','NODE_PROPOSAL') or actor_type='NODE_BRAIN')
    and (type<>'EVALUATION' or actor_type in ('EVALUATOR','SYSTEM'))
    and (type not in ('RISK_GATE_RESULT','STAGE_REVIEW','OUTCOME_REVIEW')
      or actor_type in ('MAIN_BRAIN','SYSTEM'))
  )
);

create index thought_records_scope_created_idx
  on thought_records (scope, account_id, created_at desc, id);
create index thought_records_state_idx
  on thought_records (state_kind, state_id, state_version, created_at desc, id);

create table thought_claims (
  id uuid primary key,
  thought_id uuid not null references thought_records(id),
  ordinal integer not null check (ordinal between 0 and 31),
  claim_digest char(64) check (
    claim_digest is null or claim_digest ~ '^[a-f0-9]{64}$'
  ),
  confidence text check (
    confidence is null or confidence ~ '^(0(?:\.[0-9]{1,8})?|1(?:\.0{1,8})?)$'
  ),
  unique (thought_id, ordinal)
);

create table thought_references (
  thought_id uuid not null references thought_records(id),
  role text not null check (role in ('SOURCE','EVIDENCE','COUNTEREVIDENCE')),
  kind text not null check (kind in ('EVENT','MARKET_OBSERVATION','THOUGHT')),
  reference_id text not null check (length(reference_id) between 1 and 256),
  ordinal integer not null check (ordinal between 0 and 63),
  primary key (thought_id, role, ordinal),
  unique (thought_id, role, kind, reference_id)
);

create function validate_thought_claim_count() returns trigger
language plpgsql as $$
declare
  expected_count integer;
begin
  select claim_count into expected_count from thought_records where id=new.thought_id;
  if not found then raise exception 'THOUGHT_NOT_FOUND'; end if;
  if new.ordinal>=expected_count then raise exception 'THOUGHT_CLAIM_COUNT_INVALID'; end if;
  if exists (
    select 1 from thought_records owner where owner.id=new.thought_id
      and ((owner.scope='PRIVATE_ACCOUNT') is distinct from (new.claim_digest is null))
  ) then
    raise exception 'THOUGHT_CLAIM_DIGEST_INVALID';
  end if;
  return new;
end;
$$;

create trigger thought_claims_validate_count
before insert on thought_claims
for each row execute function validate_thought_claim_count();

create function thought_visibility_for_scope(value text) returns text
language sql immutable strict as $$
  select case value
    when 'PUBLIC' then 'PUBLIC'
    when 'PRIVATE_ACCOUNT' then 'PRIVATE_ACCOUNT'
    when 'OPERATOR' then 'OPERATOR'
    else 'SHARED'
  end
$$;

create function validate_private_thought_owner_values(
  account_id_value uuid,
  aggregate_id_value text,
  actor_type_value text,
  actor_id_value text
) returns void language plpgsql stable as $$
begin
  if not exists (
    select 1
      from accounts account
      join conversations conversation on conversation.account_id=account.id
      join node_brains node
        on node.id=conversation.node_brain_id and node.account_id=account.id
     where account.id=account_id_value
       and account.status='ACTIVE'
       and conversation.id::text=aggregate_id_value
       and conversation.status='OPEN'
       and node.status='ACTIVE'
       and (
         actor_type_value='SYSTEM'
         or (actor_type_value='USER' and actor_id_value=account.id::text)
         or (actor_type_value='NODE_BRAIN' and actor_id_value=node.id::text)
       )
  ) then
    raise exception 'THOUGHT_PRIVATE_OWNER_INVALID';
  end if;
end;
$$;

create function validate_thought_state_reference_values(
  state_kind_value text,
  state_id_value text,
  state_version_value text,
  scope_value text,
  account_id_value uuid,
  aggregate_id_value text
) returns void language plpgsql stable as $$
begin
  if state_kind_value='MAIN_STATE' then
    if state_id_value<>'gustavo-main' or not exists (
      select 1 from main_state_versions state where state.version::text=state_version_value
    ) then
      raise exception 'THOUGHT_STATE_REFERENCE_INVALID';
    end if;
  elsif state_kind_value='NODE_STATE' then
    if scope_value<>'PRIVATE_ACCOUNT' or not exists (
      select 1
        from node_brains node
        join conversations conversation
          on conversation.node_brain_id=node.id and conversation.account_id=node.account_id
        join events state_event
          on state_event.id::text=state_version_value
         and state_event.aggregate_id=conversation.id::text
         and state_event.account_id=conversation.account_id::text
         and state_event.visibility='PRIVATE_ACCOUNT'
       where node.id::text=state_id_value
         and node.account_id=account_id_value
         and conversation.id::text=aggregate_id_value
    ) then
      raise exception 'THOUGHT_STATE_REFERENCE_INVALID';
    end if;
  elsif state_kind_value='CHALLENGE_STATE' then
    if not exists (
      select 1
        from challenge_stages stage
        join challenge_ledger_events state_event
          on state_event.stage_id=stage.id
         and state_event.profile_version_id=stage.profile_version_id
       where stage.id::text=state_id_value
         and state_event.sequence::text=state_version_value
    ) then
      raise exception 'THOUGHT_STATE_REFERENCE_INVALID';
    end if;
  elsif state_kind_value='CONVERSATION_STATE' then
    if scope_value<>'PRIVATE_ACCOUNT' or state_id_value<>aggregate_id_value or not exists (
      select 1 from messages message
       where message.conversation_id::text=state_id_value
         and message.account_id=account_id_value
         and message.event_id::text=state_version_value
    ) then
      raise exception 'THOUGHT_STATE_REFERENCE_INVALID';
    end if;
  else
    raise exception 'THOUGHT_STATE_REFERENCE_INVALID';
  end if;
end;
$$;

create function validate_thought_event_authority() returns trigger
language plpgsql as $$
begin
  if new.scope='PRIVATE_ACCOUNT' then
    perform validate_private_thought_owner_values(
      new.account_id,new.aggregate_id,new.actor_type,new.actor_id
    );
  end if;
  perform validate_thought_state_reference_values(
    new.state_kind,new.state_id,new.state_version,new.scope,new.account_id,new.aggregate_id
  );
  if not exists (
    select 1
      from events event
      join encrypted_event_bodies body on body.event_id=event.id
      join transactional_outbox outbox on outbox.event_id=event.id
     where event.id=new.event_id
       and event.aggregate_id=new.aggregate_id
       and event.account_id is not distinct from new.account_id::text
       and event.actor_type=new.actor_type
       and event.actor_id=new.actor_id
       and event.type='thought.recorded'
       and event.visibility=thought_visibility_for_scope(new.scope)
       and event.prompt_version=new.prompt_version
       and event.model_version=new.model_version
       and event.policy_version=new.policy_version
       and event.occurred_at=new.created_at
       and outbox.topic='thought.recorded'
  ) then
    raise exception 'THOUGHT_EVENT_AUTHORITY_INVALID';
  end if;
  if new.supersedes_thought_id is not null and not exists (
    select 1 from thought_records prior
     where prior.id=new.supersedes_thought_id
       and prior.aggregate_id=new.aggregate_id
       and prior.account_id is not distinct from new.account_id
       and prior.scope=new.scope
       and prior.created_at<=new.created_at
  ) then
    raise exception 'THOUGHT_SUPERSESSION_INVALID';
  end if;
  return new;
end;
$$;

create trigger thought_records_validate_event
before insert on thought_records
for each row execute function validate_thought_event_authority();

create function validate_thought_reference() returns trigger
language plpgsql as $$
declare
  owner thought_records%rowtype;
  expected_count integer;
begin
  select * into owner from thought_records where id=new.thought_id;
  if not found then raise exception 'THOUGHT_NOT_FOUND'; end if;
  expected_count := case new.role
    when 'SOURCE' then owner.source_count
    when 'EVIDENCE' then owner.evidence_count
    else owner.counterevidence_count
  end;
  if new.ordinal>=expected_count then
    raise exception 'THOUGHT_REFERENCE_COUNT_INVALID';
  end if;
  if new.role='SOURCE' and new.kind<>'EVENT' then
    raise exception 'THOUGHT_SOURCE_KIND_INVALID';
  end if;
  if new.kind='EVENT' then
    if not exists (select 1 from events where id::text=new.reference_id) then
      raise exception 'THOUGHT_SOURCE_NOT_FOUND';
    end if;
    if owner.scope<>'OPERATOR' and exists (
      select 1 from events source
       where source.id::text=new.reference_id
         and (
           source.visibility='OPERATOR'
           or (source.visibility='PRIVATE_ACCOUNT' and (
             owner.scope<>'PRIVATE_ACCOUNT'
             or source.account_id is distinct from owner.account_id::text
           ))
         )
    ) then
      raise exception 'THOUGHT_SOURCE_SCOPE_FORBIDDEN';
    end if;
  elsif new.kind='MARKET_OBSERVATION' then
    if not exists (select 1 from market_observations where id::text=new.reference_id) then
      raise exception 'THOUGHT_SOURCE_NOT_FOUND';
    end if;
  elsif new.kind='THOUGHT' then
    if not exists (select 1 from thought_records where id::text=new.reference_id) then
      raise exception 'THOUGHT_SOURCE_NOT_FOUND';
    end if;
    if owner.scope<>'OPERATOR' and exists (
      select 1 from thought_records source
       where source.id::text=new.reference_id
         and (
           source.scope='OPERATOR'
           or (source.scope='PRIVATE_ACCOUNT' and (
             owner.scope<>'PRIVATE_ACCOUNT'
             or source.account_id is distinct from owner.account_id
           ))
         )
    ) then
      raise exception 'THOUGHT_SOURCE_SCOPE_FORBIDDEN';
    end if;
  end if;
  return new;
end;
$$;

create trigger thought_references_validate
before insert on thought_references
for each row execute function validate_thought_reference();

create function validate_thought_event_authority_from_id(thought_id_value uuid) returns void
language plpgsql as $$
declare
  thought thought_records%rowtype;
begin
  select * into thought from thought_records where id=thought_id_value;
  if not found then raise exception 'THOUGHT_NOT_FOUND'; end if;
  if not exists (
    select 1
      from events event
      join encrypted_event_bodies body on body.event_id=event.id
      join transactional_outbox outbox on outbox.event_id=event.id
     where event.id=thought.event_id
       and event.aggregate_id=thought.aggregate_id
       and event.account_id is not distinct from thought.account_id::text
       and event.actor_type=thought.actor_type
       and event.actor_id=thought.actor_id
       and event.type='thought.recorded'
       and event.visibility=thought_visibility_for_scope(thought.scope)
       and event.prompt_version=thought.prompt_version
       and event.model_version=thought.model_version
       and event.policy_version=thought.policy_version
       and event.occurred_at=thought.created_at
       and outbox.topic='thought.recorded'
  ) then
    raise exception 'THOUGHT_EVENT_AUTHORITY_INVALID';
  end if;
end;
$$;

create function validate_thought_graph_from_id(thought_id_value uuid) returns void
language plpgsql as $$
declare
  thought thought_records%rowtype;
begin
  select * into thought from thought_records where id=thought_id_value;
  if not found then raise exception 'THOUGHT_NOT_FOUND'; end if;
  if (select count(*) from thought_claims where thought_id=thought.id)<>thought.claim_count then
    raise exception 'THOUGHT_CLAIM_COUNT_INVALID';
  end if;
  if (select count(*) from thought_references where thought_id=thought.id and role='SOURCE')
       <>thought.source_count
     or (select count(*) from thought_references where thought_id=thought.id and role='EVIDENCE')
       <>thought.evidence_count
     or (select count(*) from thought_references where thought_id=thought.id and role='COUNTEREVIDENCE')
       <>thought.counterevidence_count then
    raise exception 'THOUGHT_REFERENCE_COUNT_INVALID';
  end if;
  if thought.state_kind in ('NODE_STATE','CONVERSATION_STATE') and not exists (
    select 1 from thought_references reference
     where reference.thought_id=thought.id
       and reference.role='SOURCE'
       and reference.kind='EVENT'
       and reference.reference_id=thought.state_version
  ) then
    raise exception 'THOUGHT_STATE_SOURCE_REQUIRED';
  end if;
  perform validate_thought_event_authority_from_id(thought.id);
end;
$$;

create function validate_thought_completeness() returns trigger
language plpgsql as $$
begin
  perform validate_thought_graph_from_id(new.id);
  return null;
end;
$$;

create constraint trigger thought_records_complete_at_commit
after insert on thought_records deferrable initially deferred
for each row execute function validate_thought_completeness();

create function validate_thought_event_completeness() returns trigger
language plpgsql as $$
declare
  thought_id_value uuid;
begin
  select id into thought_id_value from thought_records where event_id=new.id;
  if not found then raise exception 'THOUGHT_RECORD_REQUIRED'; end if;
  perform validate_thought_graph_from_id(thought_id_value);
  return null;
end;
$$;

create constraint trigger thought_events_complete_at_commit
after insert on events deferrable initially deferred
for each row when (new.type='thought.recorded')
execute function validate_thought_event_completeness();

create function reject_thought_mutation() returns trigger
language plpgsql as $$
declare
  error_code text;
begin
  error_code := case tg_table_name
    when 'thought_records' then 'IMMUTABLE_THOUGHT_RECORD'
    when 'thought_claims' then 'IMMUTABLE_THOUGHT_CLAIM'
    else 'IMMUTABLE_THOUGHT_REFERENCE'
  end;
  raise exception '%', error_code;
end;
$$;

create trigger thought_records_immutable
before update or delete on thought_records
for each row execute function reject_thought_mutation();
create trigger thought_claims_immutable
before update or delete on thought_claims
for each row execute function reject_thought_mutation();
create trigger thought_references_immutable
before update or delete on thought_references
for each row execute function reject_thought_mutation();
