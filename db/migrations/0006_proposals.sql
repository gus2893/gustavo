create table proposal_disclosure_authorizations (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  conversation_id uuid not null,
  source_event_ids jsonb not null check (jsonb_typeof(source_event_ids) = 'array'),
  disclosed_text_digest char(64) not null check (disclosed_text_digest ~ '^[a-f0-9]{64}$'),
  privacy_scope text not null check (privacy_scope = 'PROPOSAL_RAW_TEXT'),
  purpose text not null check (purpose = 'MAIN_PROPOSAL_REVIEW'),
  expires_at timestamptz not null,
  created_event_id uuid not null unique references events(id),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (conversation_id, account_id) references conversations(id, account_id),
  check (expires_at > created_at)
);

create table proposal_disclosure_revocations (
  authorization_id uuid primary key references proposal_disclosure_authorizations(id),
  account_id uuid not null references accounts(id),
  revoked_event_id uuid not null unique references events(id),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  revoked_at timestamptz not null
);

create table proposal_operation_idempotency (
  idempotency_key text primary key check (length(trim(idempotency_key)) between 1 and 200),
  operation text not null check (operation in (
    'DISCLOSURE_AUTHORIZE', 'DISCLOSURE_REVOKE', 'PROPOSAL_CREATE',
    'PROPOSAL_TRANSITION', 'PROPOSAL_TURN'
  )),
  aggregate_scope text not null check (length(trim(aggregate_scope)) between 1 and 300),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);

create table proposals (
  id uuid primary key,
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  conversation_id uuid not null,
  council_member_id text not null check (council_member_id ~ '^member_[a-f0-9]{20}$'),
  source_event_ids jsonb not null check (jsonb_typeof(source_event_ids) = 'array'),
  route_event_id uuid not null unique references events(id),
  affected_main_state_ids jsonb not null check (jsonb_typeof(affected_main_state_ids) = 'array'),
  privacy_scope text not null check (privacy_scope in ('PROPOSAL_SUMMARY', 'PROPOSAL_RAW_TEXT')),
  raw_private_text_digest char(64) check (raw_private_text_digest ~ '^[a-f0-9]{64}$'),
  raw_private_text_event_id uuid unique references events(id),
  evidence_count integer not null check (evidence_count between 1 and 64),
  counterevidence_count integer not null check (counterevidence_count between 0 and 64),
  disclosure_authorization_id uuid references proposal_disclosure_authorizations(id),
  created_event_id uuid not null unique references events(id),
  policy_version text not null check (length(trim(policy_version)) between 1 and 128),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (node_brain_id, account_id) references node_brains(id, account_id),
  foreign key (conversation_id, account_id) references conversations(id, account_id),
  unique (id, account_id, node_brain_id)
);

create index proposals_account_created_idx on proposals (account_id, created_at desc, id);
create index proposals_council_created_idx on proposals (council_member_id, created_at desc, id);

create table proposal_evidence_links (
  proposal_id uuid not null references proposals(id),
  polarity text not null check (polarity in ('EVIDENCE', 'COUNTEREVIDENCE')),
  ordinal integer not null check (ordinal >= 0),
  reference_kind text not null check (
    reference_kind in ('SOURCE_EVENT', 'COMMENTARY', 'PROPOSAL')
  ),
  reference_id text not null check (length(trim(reference_id)) between 1 and 200),
  primary key (proposal_id, polarity, ordinal),
  unique (proposal_id, polarity, reference_kind, reference_id)
);

create table proposal_status_transitions (
  id uuid primary key,
  proposal_id uuid not null references proposals(id),
  ordinal integer not null check (ordinal >= 0),
  from_status text check (from_status in (
    'PENDING_REVIEW', 'CLARIFICATION_REQUESTED', 'UNDER_REVIEW',
    'QUEUED_FOR_DECISION', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'
  )),
  to_status text not null check (to_status in (
    'PENDING_REVIEW', 'CLARIFICATION_REQUESTED', 'UNDER_REVIEW',
    'QUEUED_FOR_DECISION', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'
  )),
  reason_digest char(64) not null check (reason_digest ~ '^[a-f0-9]{64}$'),
  actor_type text not null check (actor_type in ('NODE_BRAIN', 'MAIN_BRAIN', 'EVALUATOR')),
  actor_id text not null check (length(trim(actor_id)) between 1 and 200),
  transition_event_id uuid not null unique references events(id),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  unique (proposal_id, ordinal)
);

create table proposal_turns (
  id uuid primary key,
  proposal_id uuid not null,
  account_id uuid not null,
  node_brain_id uuid not null,
  actor_type text not null check (actor_type in ('NODE_BRAIN', 'MAIN_BRAIN', 'EVALUATOR')),
  actor_id text not null check (length(trim(actor_id)) between 1 and 200),
  kind text not null check (kind in ('CLARIFICATION', 'REVIEW')),
  ordinal integer not null check (ordinal >= 0),
  source_event_ids jsonb not null check (jsonb_typeof(source_event_ids) = 'array'),
  text_digest char(64) not null check (text_digest ~ '^[a-f0-9]{64}$'),
  evidence_count integer not null check (evidence_count between 0 and 64),
  turn_event_id uuid not null unique references events(id),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (proposal_id, account_id, node_brain_id)
    references proposals(id, account_id, node_brain_id),
  unique (proposal_id, kind, ordinal)
);

create table proposal_turn_evidence_links (
  turn_id uuid not null references proposal_turns(id),
  ordinal integer not null check (ordinal >= 0),
  reference_kind text not null check (
    reference_kind in ('SOURCE_EVENT', 'COMMENTARY', 'PROPOSAL')
  ),
  reference_id text not null check (length(trim(reference_id)) between 1 and 200),
  primary key (turn_id, ordinal),
  unique (turn_id, reference_kind, reference_id)
);

create function proposal_json_text_array_is_canonical(candidate jsonb, max_items integer)
returns boolean language sql immutable strict parallel safe as $$
  select jsonb_typeof(candidate) = 'array'
    and jsonb_array_length(candidate) between 1 and max_items
    and candidate = (
      select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
      from (select distinct value from jsonb_array_elements_text(candidate) source(value)) canonical
    )
    and not exists (
      select 1 from jsonb_array_elements_text(candidate) source(value)
      where length(trim(value)) not between 1 and 200
    );
$$;

alter table proposal_disclosure_authorizations add constraint disclosure_sources_canonical
  check (proposal_json_text_array_is_canonical(source_event_ids, 32));
alter table proposals add constraint proposal_sources_canonical
  check (proposal_json_text_array_is_canonical(source_event_ids, 32));
alter table proposal_turns add constraint proposal_turn_sources_canonical
  check (proposal_json_text_array_is_canonical(source_event_ids, 32));
create function proposal_main_state_array_is_canonical(candidate jsonb)
returns boolean language sql immutable strict parallel safe as $$
  select jsonb_typeof(candidate) = 'array'
    and jsonb_array_length(candidate) between 1 and 16
    and candidate = (
      select coalesce(jsonb_agg(value order by value::numeric), '[]'::jsonb)
      from (select distinct value from jsonb_array_elements_text(candidate) source(value)) canonical
    )
    and not exists (
      select 1 from jsonb_array_elements_text(candidate) state(value)
      where value !~ '^[1-9][0-9]{0,18}$' or length(value) > 200
    );
$$;
alter table proposals add constraint proposal_affected_main_states_canonical
  check (proposal_main_state_array_is_canonical(affected_main_state_ids));

create function proposal_evidence_reference_is_authorized(
  target_proposal_id uuid,
  authorized_source_event_ids jsonb,
  target_reference_kind text,
  target_reference_id text
) returns boolean language sql stable strict parallel safe as $$
  select exists (
    select 1 from proposals owner
    where owner.id=target_proposal_id
      and case target_reference_kind
        when 'SOURCE_EVENT' then authorized_source_event_ids ? target_reference_id
        when 'COMMENTARY' then
          target_reference_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and exists (select 1 from broadcasts commentary where commentary.id::text=target_reference_id)
        when 'PROPOSAL' then
          target_reference_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and exists (
            select 1 from proposals referenced
            where referenced.id::text=target_reference_id
              and referenced.id <> owner.id
              and referenced.account_id=owner.account_id
          )
        else false
      end
  );
$$;

create function validate_proposal_disclosure_insert() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from events event
    where event.id=new.created_event_id
      and event.aggregate_id=new.id::text
      and event.account_id=new.account_id::text
      and event.actor_type='USER'
      and event.actor_id=new.account_id::text
      and event.type='proposal.disclosure.authorized'
      and event.visibility='PRIVATE_ACCOUNT'
      and event.policy_version='node-proposal-policy-v1'
  ) then raise exception 'PROPOSAL_DISCLOSURE_EVENT_INVALID'; end if;
  if not exists (
    select 1
    from accounts account
    join entitlements entitlement on entitlement.account_id=account.id
      and entitlement.revoked_at is null
      and entitlement.active_from <= new.created_at
      and (entitlement.expires_at is null or entitlement.expires_at > new.created_at)
    join conversations conversation on conversation.account_id=account.id
      and conversation.id=new.conversation_id and conversation.status='OPEN'
    join node_brains node on node.id=conversation.node_brain_id
      and node.account_id=account.id and node.status='ACTIVE'
    where account.id=new.account_id and account.status='ACTIVE'
      and (select count(distinct source.id)
           from events source join messages message on message.event_id=source.id
           where source.id in (select value::uuid from jsonb_array_elements_text(new.source_event_ids))
             and source.aggregate_id=new.conversation_id::text
             and source.account_id=new.account_id::text
             and source.visibility='PRIVATE_ACCOUNT'
             and source.type='participant.message.created'
             and message.conversation_id=new.conversation_id
             and message.account_id=new.account_id) = jsonb_array_length(new.source_event_ids)
  ) then raise exception 'PROPOSAL_DISCLOSURE_SCOPE_INVALID'; end if;
  return new;
end;
$$;
create trigger proposal_disclosure_validate_insert before insert on proposal_disclosure_authorizations
for each row execute function validate_proposal_disclosure_insert();

create function validate_proposal_insert() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from events event
    where event.id=new.created_event_id
      and event.aggregate_id=new.id::text
      and event.account_id=new.account_id::text
      and event.actor_type='NODE_BRAIN'
      and event.actor_id=new.node_brain_id::text
      and event.type='node.proposal.created'
      and event.visibility='PRIVATE_ACCOUNT'
      and event.policy_version=new.policy_version
  ) then raise exception 'PROPOSAL_EVENT_INVALID'; end if;
  if not exists (
    select 1
    from accounts account
    join entitlements entitlement on entitlement.account_id=account.id
      and entitlement.revoked_at is null
      and entitlement.active_from <= new.created_at
      and (entitlement.expires_at is null or entitlement.expires_at > new.created_at)
    join conversations conversation on conversation.id=new.conversation_id
      and conversation.account_id=account.id and conversation.status='OPEN'
      and conversation.node_brain_id=new.node_brain_id
    join node_brains node on node.id=new.node_brain_id
      and node.account_id=account.id and node.status='ACTIVE'
    where account.id=new.account_id and account.status='ACTIVE'
      and (select count(distinct source.id)
           from events source join messages message on message.event_id=source.id
           where source.id in (select value::uuid from jsonb_array_elements_text(new.source_event_ids))
             and source.aggregate_id=new.conversation_id::text
             and source.account_id=new.account_id::text
             and source.visibility='PRIVATE_ACCOUNT'
             and source.type='participant.message.created'
             and message.conversation_id=new.conversation_id
             and message.account_id=new.account_id) = jsonb_array_length(new.source_event_ids)
  ) then raise exception 'PROPOSAL_SOURCE_SCOPE_INVALID'; end if;
  if not exists (
    select 1 from events route
    where route.id=new.route_event_id
      and route.aggregate_id=new.conversation_id::text
      and route.account_id=new.account_id::text
      and route.actor_type='NODE_BRAIN'
      and route.actor_id=new.node_brain_id::text
      and route.type='node.reply.routed'
      and route.visibility='PRIVATE_ACCOUNT'
      and route.policy_version='node-routing-v1'
  ) then raise exception 'PROPOSAL_ROUTE_EVENT_INVALID'; end if;
  if (select count(*) from main_state_versions state
      where state.version::text in (
        select value from jsonb_array_elements_text(new.affected_main_state_ids)
      )) <> jsonb_array_length(new.affected_main_state_ids) then
    raise exception 'PROPOSAL_MAIN_STATE_INVALID';
  end if;
  if new.privacy_scope='PROPOSAL_SUMMARY'
     and (new.disclosure_authorization_id is not null or new.raw_private_text_digest is not null
          or new.raw_private_text_event_id is not null) then
    raise exception 'PROPOSAL_PRIVACY_SCOPE_INVALID';
  end if;
  if new.privacy_scope='PROPOSAL_RAW_TEXT'
     and (new.disclosure_authorization_id is null or new.raw_private_text_digest is null
          or new.raw_private_text_event_id is null) then
    raise exception 'PROPOSAL_PRIVACY_SCOPE_INVALID';
  end if;
  if new.disclosure_authorization_id is not null and not exists (
    select 1 from proposal_disclosure_authorizations disclosure
    left join proposal_disclosure_revocations revocation
      on revocation.authorization_id=disclosure.id
    where disclosure.id=new.disclosure_authorization_id
      and disclosure.account_id=new.account_id
      and disclosure.conversation_id=new.conversation_id
      and disclosure.source_event_ids=new.source_event_ids
      and disclosure.disclosed_text_digest=new.raw_private_text_digest
      and disclosure.privacy_scope='PROPOSAL_RAW_TEXT'
      and disclosure.purpose='MAIN_PROPOSAL_REVIEW'
      and disclosure.expires_at > new.created_at
      and revocation.authorization_id is null
  ) then raise exception 'PROPOSAL_DISCLOSURE_FORBIDDEN'; end if;
  if new.raw_private_text_event_id is not null and not exists (
    select 1 from events private_event
    where private_event.id=new.raw_private_text_event_id
      and private_event.aggregate_id=new.id::text
      and private_event.account_id=new.account_id::text
      and private_event.actor_type='NODE_BRAIN'
      and private_event.actor_id=new.node_brain_id::text
      and private_event.type='feedback.proposal.private-text-attached'
      and private_event.visibility='PRIVATE_ACCOUNT'
      and private_event.causation_id=new.created_event_id
      and private_event.policy_version=new.policy_version
  ) then raise exception 'PROPOSAL_PRIVATE_TEXT_EVENT_INVALID'; end if;
  return new;
end;
$$;
create trigger proposals_validate_insert before insert on proposals
for each row execute function validate_proposal_insert();

create function validate_proposal_evidence_insert() returns trigger language plpgsql as $$
declare expected_count integer;
declare proposal proposals%rowtype;
begin
  select * into proposal from proposals where id=new.proposal_id;
  if not found or not proposal_evidence_reference_is_authorized(
    new.proposal_id, proposal.source_event_ids, new.reference_kind, new.reference_id
  ) then raise exception 'PROPOSAL_EVIDENCE_FORBIDDEN'; end if;
  expected_count := case when new.polarity='EVIDENCE'
    then proposal.evidence_count else proposal.counterevidence_count end;
  if expected_count is null or new.ordinal >= expected_count then
    raise exception 'PROPOSAL_EVIDENCE_OUT_OF_BOUNDS';
  end if;
  return new;
end;
$$;
create trigger proposal_evidence_validate_insert before insert on proposal_evidence_links
for each row execute function validate_proposal_evidence_insert();

create function require_complete_proposal_evidence() returns trigger language plpgsql as $$
begin
  if (select count(*) from proposal_evidence_links where proposal_id=new.id and polarity='EVIDENCE') <> new.evidence_count
     or (select count(*) from proposal_evidence_links where proposal_id=new.id and polarity='COUNTEREVIDENCE') <> new.counterevidence_count then
    raise exception 'PROPOSAL_EVIDENCE_INCOMPLETE';
  end if;
  return new;
end;
$$;
create constraint trigger proposal_evidence_complete after insert on proposals
deferrable initially deferred for each row execute function require_complete_proposal_evidence();

create function validate_proposal_transition_insert() returns trigger language plpgsql as $$
declare proposal proposals%rowtype;
declare previous_status text;
begin
  select * into proposal from proposals where id=new.proposal_id;
  if not found then raise exception 'PROPOSAL_TRANSITION_PROPOSAL_INVALID'; end if;
  if new.ordinal >= 5 then raise exception 'PROPOSAL_TRANSITION_LIMIT'; end if;
  if new.ordinal=0 then
    if new.from_status is not null or new.to_status <> 'PENDING_REVIEW'
       or new.transition_event_id <> proposal.created_event_id
       or new.actor_type <> 'NODE_BRAIN' or new.actor_id <> proposal.node_brain_id::text then
      raise exception 'PROPOSAL_INITIAL_TRANSITION_INVALID';
    end if;
  else
    select to_status into previous_status from proposal_status_transitions
      where proposal_id=new.proposal_id and ordinal=new.ordinal - 1;
    if previous_status is null or previous_status <> new.from_status then
      raise exception 'PROPOSAL_TRANSITION_SEQUENCE_INVALID';
    end if;
    if new.actor_type='NODE_BRAIN' then
      if new.actor_id <> proposal.node_brain_id::text or new.to_status <> 'WITHDRAWN' then
        raise exception 'PROPOSAL_TRANSITION_ACTOR_FORBIDDEN';
      end if;
    elsif new.actor_type='MAIN_BRAIN' then
      if new.actor_id <> 'gustavo-main' or not (
        (new.from_status='PENDING_REVIEW' and new.to_status in ('CLARIFICATION_REQUESTED','UNDER_REVIEW'))
        or (new.from_status='CLARIFICATION_REQUESTED' and new.to_status='UNDER_REVIEW')
        or (new.from_status='QUEUED_FOR_DECISION' and new.to_status in ('ACCEPTED','REJECTED'))
      ) then raise exception 'PROPOSAL_TRANSITION_ACTOR_FORBIDDEN'; end if;
    elsif new.actor_type='EVALUATOR' then
      if new.actor_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         or not exists (
           select 1 from model_runs run
           where run.id::text=new.actor_id and run.role='EVALUATOR'
             and run.completion_status='COMPLETED'
             and run.causation_id=proposal.created_event_id
         )
         or new.from_status <> 'UNDER_REVIEW' or new.to_status <> 'QUEUED_FOR_DECISION' then
        raise exception 'PROPOSAL_TRANSITION_ACTOR_FORBIDDEN';
      end if;
    else
      raise exception 'PROPOSAL_TRANSITION_ACTOR_FORBIDDEN';
    end if;
    if not (
      (new.from_status='PENDING_REVIEW' and new.to_status in ('CLARIFICATION_REQUESTED','UNDER_REVIEW','WITHDRAWN'))
      or (new.from_status='CLARIFICATION_REQUESTED' and new.to_status in ('UNDER_REVIEW','WITHDRAWN'))
      or (new.from_status='UNDER_REVIEW' and new.to_status in ('QUEUED_FOR_DECISION','WITHDRAWN'))
      or (new.from_status='QUEUED_FOR_DECISION' and new.to_status in ('ACCEPTED','REJECTED','WITHDRAWN'))
    ) then raise exception 'PROPOSAL_STATUS_TRANSITION_INVALID'; end if;
    if not exists (
      select 1 from events event
      where event.id=new.transition_event_id
        and event.aggregate_id=new.proposal_id::text
        and event.account_id=proposal.account_id::text
        and event.actor_type=new.actor_type
        and event.actor_id=new.actor_id
        and event.type='node.proposal.status-transitioned'
        and event.visibility='PRIVATE_ACCOUNT'
        and event.causation_id=proposal.created_event_id
        and event.policy_version=proposal.policy_version
    ) then raise exception 'PROPOSAL_TRANSITION_EVENT_INVALID'; end if;
  end if;
  return new;
end;
$$;
create trigger proposal_transitions_validate_insert before insert on proposal_status_transitions
for each row execute function validate_proposal_transition_insert();

create function validate_proposal_turn_insert() returns trigger language plpgsql as $$
declare proposal proposals%rowtype;
declare current_status text;
declare existing_count integer;
begin
  select * into proposal from proposals where id=new.proposal_id;
  if not found or proposal.account_id <> new.account_id or proposal.node_brain_id <> new.node_brain_id then
    raise exception 'PROPOSAL_TURN_SCOPE_INVALID';
  end if;
  select to_status into current_status from proposal_status_transitions
    where proposal_id=new.proposal_id order by ordinal desc limit 1;
  select count(*) into existing_count from proposal_turns
    where proposal_id=new.proposal_id and kind=new.kind;
  if new.ordinal <> existing_count then raise exception 'PROPOSAL_TURN_SEQUENCE_INVALID'; end if;
  if new.kind='CLARIFICATION' and existing_count >= 3 then
    raise exception 'PROPOSAL_CLARIFICATION_TURN_LIMIT';
  end if;
  if new.kind='REVIEW' and existing_count >= 6 then
    raise exception 'PROPOSAL_REVIEW_TURN_LIMIT';
  end if;
  if new.kind='REVIEW' and new.evidence_count < 1 then
    raise exception 'PROPOSAL_REVIEW_EVIDENCE_REQUIRED';
  end if;
  if new.kind='CLARIFICATION'
     and (current_status <> 'CLARIFICATION_REQUESTED'
          or new.actor_type <> 'NODE_BRAIN' or new.actor_id <> new.node_brain_id::text) then
    raise exception 'PROPOSAL_TURN_STATUS_ACTOR_INVALID';
  end if;
  if new.kind='REVIEW'
     and (current_status <> 'UNDER_REVIEW'
          or new.actor_type not in ('MAIN_BRAIN','EVALUATOR')
          or (new.actor_type='MAIN_BRAIN' and new.actor_id <> 'gustavo-main')
          or (new.actor_type='EVALUATOR' and (
            new.actor_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            or not exists (
              select 1 from model_runs run
              where run.id::text=new.actor_id and run.role='EVALUATOR'
                and run.completion_status='COMPLETED'
                and run.causation_id=proposal.created_event_id
            )
          ))) then
    raise exception 'PROPOSAL_TURN_STATUS_ACTOR_INVALID';
  end if;
  if (select count(distinct source.id)
      from events source join messages message on message.event_id=source.id
      where source.id in (select value::uuid from jsonb_array_elements_text(new.source_event_ids))
        and source.aggregate_id=proposal.conversation_id::text
        and source.account_id=proposal.account_id::text
        and source.visibility='PRIVATE_ACCOUNT'
        and source.type='participant.message.created'
        and message.conversation_id=proposal.conversation_id
        and message.account_id=proposal.account_id) <> jsonb_array_length(new.source_event_ids) then
    raise exception 'PROPOSAL_TURN_SOURCE_FORBIDDEN';
  end if;
  if not exists (
    select 1 from events event
    where event.id=new.turn_event_id
      and event.aggregate_id=new.proposal_id::text
      and event.account_id=new.account_id::text
      and event.actor_type=new.actor_type
      and event.actor_id=new.actor_id
      and event.type='debate.turn.created'
      and event.visibility='PRIVATE_ACCOUNT'
      and event.causation_id=proposal.created_event_id
      and event.policy_version=proposal.policy_version
  ) then raise exception 'PROPOSAL_TURN_EVENT_INVALID'; end if;
  return new;
end;
$$;
create trigger proposal_turns_validate_insert before insert on proposal_turns
for each row execute function validate_proposal_turn_insert();

create function validate_proposal_turn_evidence_insert() returns trigger language plpgsql as $$
declare expected_count integer;
declare turn proposal_turns%rowtype;
begin
  select * into turn from proposal_turns where id=new.turn_id;
  if not found or not proposal_evidence_reference_is_authorized(
    turn.proposal_id, turn.source_event_ids, new.reference_kind, new.reference_id
  ) then raise exception 'PROPOSAL_EVIDENCE_FORBIDDEN'; end if;
  expected_count := turn.evidence_count;
  if expected_count is null or new.ordinal >= expected_count then
    raise exception 'PROPOSAL_TURN_EVIDENCE_OUT_OF_BOUNDS';
  end if;
  return new;
end;
$$;
create trigger proposal_turn_evidence_validate_insert before insert on proposal_turn_evidence_links
for each row execute function validate_proposal_turn_evidence_insert();

create function require_complete_proposal_turn_evidence() returns trigger language plpgsql as $$
begin
  if (select count(*) from proposal_turn_evidence_links where turn_id=new.id) <> new.evidence_count then
    raise exception 'PROPOSAL_TURN_EVIDENCE_INCOMPLETE';
  end if;
  return new;
end;
$$;
create constraint trigger proposal_turn_evidence_complete after insert on proposal_turns
deferrable initially deferred for each row execute function require_complete_proposal_turn_evidence();

create function validate_proposal_disclosure_revocation_insert() returns trigger language plpgsql as $$
declare disclosure proposal_disclosure_authorizations%rowtype;
begin
  select * into disclosure from proposal_disclosure_authorizations where id=new.authorization_id;
  if not found or disclosure.account_id <> new.account_id then
    raise exception 'PROPOSAL_DISCLOSURE_REVOCATION_SCOPE_INVALID';
  end if;
  if not exists (
    select 1 from events event where event.id=new.revoked_event_id
      and event.aggregate_id=new.authorization_id::text
      and event.account_id=new.account_id::text
      and event.actor_type='USER' and event.actor_id=new.account_id::text
      and event.type='proposal.disclosure.revoked'
      and event.visibility='PRIVATE_ACCOUNT'
      and event.causation_id=disclosure.created_event_id
      and event.policy_version='node-proposal-policy-v1'
  ) then raise exception 'PROPOSAL_DISCLOSURE_REVOCATION_EVENT_INVALID'; end if;
  return new;
end;
$$;
create trigger proposal_disclosure_revocations_validate_insert before insert on proposal_disclosure_revocations
for each row execute function validate_proposal_disclosure_revocation_insert();

create function reject_proposal_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_PROPOSAL'; end; $$;
create trigger proposals_immutable before update or delete on proposals
for each row execute function reject_proposal_mutation();

create function reject_proposal_evidence_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_PROPOSAL_EVIDENCE'; end; $$;
create trigger proposal_evidence_immutable before update or delete on proposal_evidence_links
for each row execute function reject_proposal_evidence_mutation();
create trigger proposal_turn_evidence_immutable before update or delete on proposal_turn_evidence_links
for each row execute function reject_proposal_evidence_mutation();

create function reject_proposal_transition_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_PROPOSAL_TRANSITION'; end; $$;
create trigger proposal_transitions_immutable before update or delete on proposal_status_transitions
for each row execute function reject_proposal_transition_mutation();

create function reject_proposal_turn_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_PROPOSAL_TURN'; end; $$;
create trigger proposal_turns_immutable before update or delete on proposal_turns
for each row execute function reject_proposal_turn_mutation();

create function reject_proposal_disclosure_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_PROPOSAL_DISCLOSURE'; end; $$;
create trigger proposal_disclosures_immutable before update or delete on proposal_disclosure_authorizations
for each row execute function reject_proposal_disclosure_mutation();
create trigger proposal_disclosure_revocations_immutable before update or delete on proposal_disclosure_revocations
for each row execute function reject_proposal_disclosure_mutation();

create function reject_proposal_idempotency_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_PROPOSAL_IDEMPOTENCY'; end; $$;
create trigger proposal_operation_idempotency_immutable
before update or delete on proposal_operation_idempotency
for each row execute function reject_proposal_idempotency_mutation();
