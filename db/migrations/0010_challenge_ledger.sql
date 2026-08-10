create function challenge_ledger_decimal_is_valid(value text, allow_zero boolean)
returns boolean language sql immutable strict as $$
  select case
    when value ~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{1,8})?$'
      then value::numeric > 0 or (allow_zero and value::numeric = 0)
    else false
  end
$$;

create function challenge_ledger_payload_timestamp_matches(
  payload jsonb,
  key_name text,
  expected timestamptz
) returns boolean language plpgsql stable as $$
declare incoming text;
declare parsed timestamptz;
declare canonical text;
begin
  if jsonb_typeof(payload->key_name) is distinct from 'string' then
    return false;
  end if;
  incoming := payload->>key_name;
  if incoming !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' then
    return false;
  end if;
  parsed := incoming::timestamptz;
  canonical := to_char(
    parsed at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  return parsed=expected and (
    incoming=canonical
    or (canonical like '%.000Z' and incoming=replace(canonical,'.000Z','Z'))
  );
exception when others then
  return false;
end;
$$;

create table challenge_stages (
  id uuid primary key,
  challenge_portfolio_id uuid not null references challenge_portfolios(id),
  profile_version_id uuid not null references challenge_profile_versions(id),
  stage_profile_id uuid not null references challenge_stage_profiles(id),
  ordinal integer not null check (ordinal between 1 and 10),
  created_at timestamptz not null,
  unique (challenge_portfolio_id, ordinal),
  unique (id, challenge_portfolio_id, profile_version_id)
);

create function validate_challenge_stage_insert() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1
      from challenge_stage_profiles stage_profile
      join challenge_profile_versions profile
        on profile.id=stage_profile.profile_version_id
      join challenge_profile_publications publication
        on publication.profile_version_id=profile.id
     where stage_profile.id=new.stage_profile_id
       and stage_profile.profile_version_id=new.profile_version_id
       and stage_profile.ordinal=new.ordinal
       and profile.challenge_portfolio_id=new.challenge_portfolio_id
  ) then
    raise exception 'CHALLENGE_STAGE_PROFILE_BINDING_INVALID';
  end if;
  return new;
end;
$$;

create trigger challenge_stages_validate_insert
before insert on challenge_stages
for each row execute function validate_challenge_stage_insert();

create table challenge_ledger_events (
  id uuid primary key,
  challenge_portfolio_id uuid not null references challenge_portfolios(id),
  stage_id uuid not null,
  profile_version_id uuid not null,
  sequence bigint not null check (sequence > 0),
  type text not null check (type in (
    'challenge.created', 'challenge.profile.versioned', 'challenge.started',
    'challenge.paused', 'challenge.passed', 'challenge.failed', 'challenge.archived',
    'stage.created', 'stage.started', 'stage.passed', 'stage.failed', 'stage.advanced',
    'paper.intent.proposed', 'paper.intent.rejected', 'paper.order.created',
    'paper.order.cancelled', 'paper.fill.created', 'paper.position.closed',
    'decision.window.opened', 'main.baseline.committed',
    'contender.submitted', 'contender.rejected', 'review.turn.created',
    'evaluation.scored', 'decision.selected',
    'price.mark.recorded', 'fee.recorded', 'financing.recorded',
    'pnl.realized', 'pnl.unrealized.marked', 'rule.evaluated'
  )),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  occurred_at timestamptz not null,
  actor_type text not null check (actor_type in ('MAIN_BRAIN','SYSTEM')),
  actor_id text not null check (length(trim(actor_id)) between 1 and 200),
  causation_id uuid references challenge_ledger_events(id),
  correlation_id uuid,
  idempotency_key text not null check (
    length(idempotency_key) between 1 and 200 and idempotency_key=trim(idempotency_key)
  ),
  foreign key (stage_id, challenge_portfolio_id, profile_version_id)
    references challenge_stages(id, challenge_portfolio_id, profile_version_id),
  unique (stage_id, sequence),
  unique (challenge_portfolio_id, idempotency_key),
  unique (id, stage_id, profile_version_id),
  unique (id, stage_id, profile_version_id, sequence),
  unique (id, stage_id, challenge_portfolio_id, profile_version_id, sequence),
  constraint challenge_ledger_actor_identity_check check (
    (actor_type='MAIN_BRAIN' and actor_id='gustavo-main')
    or (actor_type='SYSTEM' and actor_id ~ '^[a-z0-9][a-z0-9._:-]{0,127}$')
  )
);

create index challenge_ledger_events_stage_order_idx
  on challenge_ledger_events(stage_id, sequence, id);

create function validate_challenge_ledger_event_insert() returns trigger
language plpgsql as $$
declare previous_event challenge_ledger_events%rowtype;
declare cause_event challenge_ledger_events%rowtype;
declare cause_stage challenge_stages%rowtype;
declare target_stage challenge_stages%rowtype;
declare expected_starting_balance_cents bigint;
declare stage_already_started boolean;
begin
  select exists (
    select 1 from challenge_ledger_events
     where stage_id=new.stage_id and type='stage.started'
  ) into stage_already_started;
  if new.causation_id=new.id then
    raise exception 'CHALLENGE_LEDGER_CAUSATION_INVALID';
  end if;
  if new.causation_id is not null then
    select * into cause_event from challenge_ledger_events
     where id=new.causation_id;
    if cause_event.id is null then
      raise exception 'CHALLENGE_LEDGER_CAUSATION_INVALID';
    end if;
    if cause_event.stage_id=new.stage_id then
      if cause_event.profile_version_id<>new.profile_version_id
         or cause_event.sequence>=new.sequence then
        raise exception 'CHALLENGE_LEDGER_CAUSATION_INVALID';
      end if;
    else
      select * into cause_stage from challenge_stages
       where id=cause_event.stage_id;
      select * into target_stage from challenge_stages
       where id=new.stage_id;
      if cause_event.type<>'stage.advanced'
         or new.type<>'stage.created'
         or cause_event.challenge_portfolio_id<>new.challenge_portfolio_id
         or cause_event.profile_version_id<>new.profile_version_id
         or cause_stage.ordinal+1<>target_stage.ordinal
         or cause_event.occurred_at>new.occurred_at then
        raise exception 'CHALLENGE_LEDGER_CAUSATION_INVALID';
      end if;
    end if;
  end if;
  if not stage_already_started
     and new.type<>'stage.started'
     and new.type not in (
       'challenge.created', 'challenge.profile.versioned',
       'challenge.started', 'stage.created'
     ) then
    raise exception 'CHALLENGE_LEDGER_STAGE_START_REQUIRED';
  end if;
  if new.type='stage.started' then
    if stage_already_started then
      raise exception 'CHALLENGE_LEDGER_STAGE_ALREADY_STARTED';
    end if;
    select stage_profile.starting_balance_cents
      into expected_starting_balance_cents
      from challenge_stages stage
      join challenge_stage_profiles stage_profile
        on stage_profile.id=stage.stage_profile_id
       and stage_profile.profile_version_id=stage.profile_version_id
     where stage.id=new.stage_id
       and stage.challenge_portfolio_id=new.challenge_portfolio_id
       and stage.profile_version_id=new.profile_version_id;
    if expected_starting_balance_cents is null
       or jsonb_typeof(new.payload->'amount')<>'string'
       or not challenge_ledger_decimal_is_valid(new.payload->>'amount', false)
       or (new.payload->>'amount')::numeric*100<>expected_starting_balance_cents then
      raise exception 'CHALLENGE_STAGE_START_AMOUNT_INVALID';
    end if;
  end if;
  if new.sequence > 1 then
    select * into previous_event
      from challenge_ledger_events
     where stage_id=new.stage_id and sequence=new.sequence-1;
    if not found then
      raise exception 'CHALLENGE_LEDGER_SEQUENCE_GAP';
    end if;
    if new.occurred_at < previous_event.occurred_at then
      raise exception 'CHALLENGE_LEDGER_TIME_REGRESSION';
    end if;
  elsif exists (
    select 1 from challenge_ledger_events where stage_id=new.stage_id
  ) then
    raise exception 'CHALLENGE_LEDGER_SEQUENCE_INVALID';
  end if;
  return new;
end;
$$;

create trigger challenge_ledger_events_validate_insert
before insert on challenge_ledger_events
for each row execute function validate_challenge_ledger_event_insert();

create table challenge_intents (
  id uuid primary key,
  stage_id uuid not null,
  profile_version_id uuid not null,
  ledger_event_id uuid not null,
  symbol text,
  direction text not null check (direction in ('PAPER_LONG','PAPER_SHORT','NO_SIMULATED_POSITION')),
  entry_price text,
  stop_price text,
  target_price text,
  desired_risk text,
  expires_at timestamptz,
  initial_status text not null check (initial_status in ('PROPOSED','REJECTED')),
  created_at timestamptz not null,
  foreign key (stage_id) references challenge_stages(id),
  foreign key (ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  unique (ledger_event_id),
  unique (id, stage_id, profile_version_id),
  check (symbol is null or symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  check (entry_price is null or challenge_ledger_decimal_is_valid(entry_price, false)),
  check (stop_price is null or challenge_ledger_decimal_is_valid(stop_price, false)),
  check (target_price is null or challenge_ledger_decimal_is_valid(target_price, false)),
  check (desired_risk is null or challenge_ledger_decimal_is_valid(desired_risk, false)),
  check (
    (direction='NO_SIMULATED_POSITION' and symbol is null and entry_price is null
      and stop_price is null and target_price is null and desired_risk is null)
    or (direction<>'NO_SIMULATED_POSITION' and symbol is not null)
  )
);

create table challenge_orders (
  id uuid primary key,
  intent_id uuid not null,
  stage_id uuid not null,
  profile_version_id uuid not null,
  ledger_event_id uuid not null,
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  side text not null check (side in ('BUY','SELL')),
  quantity text not null check (challenge_ledger_decimal_is_valid(quantity, false)),
  initial_status text not null check (initial_status='PENDING'),
  created_at timestamptz not null,
  foreign key (ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  foreign key (intent_id, stage_id, profile_version_id)
    references challenge_intents(id, stage_id, profile_version_id),
  unique (ledger_event_id),
  unique (id, stage_id, profile_version_id)
);

create table challenge_positions (
  id uuid primary key,
  stage_id uuid not null,
  profile_version_id uuid not null,
  opening_ledger_event_id uuid not null,
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  side text not null check (side in ('BUY','SELL')),
  opened_at timestamptz not null,
  foreign key (opening_ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  unique (opening_ledger_event_id),
  unique (id, stage_id, profile_version_id)
);

create table challenge_position_closures (
  id uuid primary key,
  position_id uuid not null,
  stage_id uuid not null,
  profile_version_id uuid not null,
  ledger_event_id uuid not null,
  quantity text check (
    quantity is null or challenge_ledger_decimal_is_valid(quantity, false)
  ),
  price text not null check (challenge_ledger_decimal_is_valid(price, false)),
  commission text not null check (challenge_ledger_decimal_is_valid(commission, true)),
  closed_at timestamptz not null,
  foreign key (ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  foreign key (position_id, stage_id, profile_version_id)
    references challenge_positions(id, stage_id, profile_version_id),
  unique (ledger_event_id)
);

create table challenge_fills (
  id uuid primary key,
  order_id uuid not null,
  position_id uuid not null,
  stage_id uuid not null,
  profile_version_id uuid not null,
  ledger_event_id uuid not null,
  side text not null check (side in ('BUY','SELL')),
  quantity text not null check (challenge_ledger_decimal_is_valid(quantity, false)),
  price text not null check (challenge_ledger_decimal_is_valid(price, false)),
  commission text not null check (challenge_ledger_decimal_is_valid(commission, true)),
  filled_at timestamptz not null,
  foreign key (ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  foreign key (order_id, stage_id, profile_version_id)
    references challenge_orders(id, stage_id, profile_version_id),
  foreign key (position_id, stage_id, profile_version_id)
    references challenge_positions(id, stage_id, profile_version_id),
  unique (ledger_event_id)
);

create table challenge_price_marks (
  id uuid primary key,
  position_id uuid not null,
  stage_id uuid not null,
  profile_version_id uuid not null,
  ledger_event_id uuid not null,
  market_observation_id uuid not null references market_observations(id),
  price text not null check (challenge_ledger_decimal_is_valid(price, false)),
  observed_at timestamptz not null,
  recorded_at timestamptz not null,
  foreign key (ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  foreign key (position_id, stage_id, profile_version_id)
    references challenge_positions(id, stage_id, profile_version_id),
  unique (ledger_event_id)
);

create table challenge_fees (
  id uuid primary key,
  stage_id uuid not null,
  profile_version_id uuid not null,
  ledger_event_id uuid not null,
  position_id uuid,
  order_id uuid,
  amount text not null check (challenge_ledger_decimal_is_valid(amount, false)),
  category text not null check (category in ('COMMISSION','EXCHANGE_FEE','OTHER_SIMULATED_FEE')),
  recorded_at timestamptz not null,
  foreign key (ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  foreign key (position_id, stage_id, profile_version_id)
    references challenge_positions(id, stage_id, profile_version_id),
  foreign key (order_id, stage_id, profile_version_id)
    references challenge_orders(id, stage_id, profile_version_id),
  unique (ledger_event_id)
);

create table challenge_financing (
  id uuid primary key,
  stage_id uuid not null,
  profile_version_id uuid not null,
  ledger_event_id uuid not null,
  position_id uuid not null,
  amount text not null check (challenge_ledger_decimal_is_valid(amount, false)),
  utc_days integer not null check (utc_days > 0),
  policy_version text not null check (length(trim(policy_version)) between 1 and 128),
  recorded_at timestamptz not null,
  foreign key (ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  foreign key (position_id, stage_id, profile_version_id)
    references challenge_positions(id, stage_id, profile_version_id),
  unique (ledger_event_id)
);

create table challenge_rule_evaluations (
  id uuid primary key,
  stage_id uuid not null,
  profile_version_id uuid not null,
  ledger_event_id uuid not null,
  intent_id uuid,
  evaluated_ledger_high_water_id uuid,
  accepted boolean not null,
  reasons jsonb not null check (jsonb_typeof(reasons)='array'),
  evaluated_at timestamptz not null,
  foreign key (ledger_event_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  foreign key (intent_id, stage_id, profile_version_id)
    references challenge_intents(id, stage_id, profile_version_id),
  foreign key (evaluated_ledger_high_water_id, stage_id, profile_version_id)
    references challenge_ledger_events(id, stage_id, profile_version_id),
  unique (ledger_event_id)
);

create function challenge_position_is_active_before(
  target_position_id uuid,
  target_stage_id uuid,
  target_profile_version_id uuid,
  before_sequence bigint
) returns boolean language sql stable as $$
  select
    not exists (
      select 1
        from challenge_position_closures terminal_close
        join challenge_ledger_events terminal_event
          on terminal_event.id=terminal_close.ledger_event_id
       where terminal_close.position_id=target_position_id
         and terminal_close.stage_id=target_stage_id
         and terminal_close.profile_version_id=target_profile_version_id
         and terminal_close.quantity is null
         and terminal_event.sequence<before_sequence
    )
    and not exists (
      select 1
        from challenge_position_closures terminal_close
        join challenge_ledger_events terminal_event
          on terminal_event.id=terminal_close.ledger_event_id
       where terminal_close.position_id=target_position_id
         and terminal_close.stage_id=target_stage_id
         and terminal_close.profile_version_id=target_profile_version_id
         and terminal_close.quantity is not null
         and terminal_event.sequence<before_sequence
         and (
           select coalesce(sum(prior_close.quantity::numeric),0)
             from challenge_position_closures prior_close
             join challenge_ledger_events prior_close_event
               on prior_close_event.id=prior_close.ledger_event_id
            where prior_close.position_id=target_position_id
              and prior_close.stage_id=target_stage_id
              and prior_close.profile_version_id=target_profile_version_id
              and prior_close.quantity is not null
              and prior_close_event.sequence<=terminal_event.sequence
         ) >= (
           select coalesce(sum(prior_fill.quantity::numeric),0)
             from challenge_fills prior_fill
             join challenge_ledger_events prior_fill_event
               on prior_fill_event.id=prior_fill.ledger_event_id
            where prior_fill.position_id=target_position_id
              and prior_fill.stage_id=target_stage_id
              and prior_fill.profile_version_id=target_profile_version_id
              and prior_fill_event.sequence<terminal_event.sequence
         )
    )
    and (
      select coalesce(sum(prior_fill.quantity::numeric),0)
        from challenge_fills prior_fill
        join challenge_ledger_events prior_fill_event
          on prior_fill_event.id=prior_fill.ledger_event_id
       where prior_fill.position_id=target_position_id
         and prior_fill.stage_id=target_stage_id
         and prior_fill.profile_version_id=target_profile_version_id
         and prior_fill_event.sequence<before_sequence
    ) - (
      select coalesce(sum(prior_close.quantity::numeric),0)
        from challenge_position_closures prior_close
        join challenge_ledger_events prior_close_event
          on prior_close_event.id=prior_close.ledger_event_id
       where prior_close.position_id=target_position_id
         and prior_close.stage_id=target_stage_id
         and prior_close.profile_version_id=target_profile_version_id
         and prior_close.quantity is not null
         and prior_close_event.sequence<before_sequence
    ) > 0
$$;

-- Canonical typed-event JSON includes every immutable source field. Fixed
-- decimals are JSON strings; nullable fields are present as explicit JSON null.
create function validate_challenge_source_event() returns trigger
language plpgsql as $$
declare source_event challenge_ledger_events%rowtype;
declare expected_event_type text;
declare related_intent challenge_intents%rowtype;
declare related_order challenge_orders%rowtype;
declare related_position challenge_positions%rowtype;
declare related_observation market_observations%rowtype;
declare related_source market_data_sources%rowtype;
declare filled_quantity numeric;
declare closed_quantity numeric;
declare remaining_quantity numeric;
begin
  if tg_table_name='challenge_intents' then
    expected_event_type := case new.initial_status
      when 'PROPOSED' then 'paper.intent.proposed' else 'paper.intent.rejected' end;
  elsif tg_table_name='challenge_orders' then
    expected_event_type := 'paper.order.created';
  elsif tg_table_name in ('challenge_positions','challenge_fills') then
    expected_event_type := 'paper.fill.created';
  elsif tg_table_name='challenge_position_closures' then
    expected_event_type := 'paper.position.closed';
  elsif tg_table_name='challenge_price_marks' then
    expected_event_type := 'price.mark.recorded';
  elsif tg_table_name='challenge_fees' then
    expected_event_type := 'fee.recorded';
  elsif tg_table_name='challenge_financing' then
    expected_event_type := 'financing.recorded';
  elsif tg_table_name='challenge_rule_evaluations' then
    expected_event_type := 'rule.evaluated';
  end if;
  if tg_table_name='challenge_positions' then
    select * into source_event from challenge_ledger_events
     where id=new.opening_ledger_event_id;
  else
    select * into source_event from challenge_ledger_events
     where id=new.ledger_event_id;
  end if;
  if source_event.type is distinct from expected_event_type then
    raise exception 'CHALLENGE_SOURCE_LEDGER_EVENT_INVALID';
  end if;
  if tg_table_name='challenge_intents' then
    if jsonb_typeof(source_event.payload->'intentId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'direction') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'initialStatus') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'symbol') is distinct from
         (case when new.symbol is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'entryPrice') is distinct from
         (case when new.entry_price is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'stopPrice') is distinct from
         (case when new.stop_price is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'targetPrice') is distinct from
         (case when new.target_price is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'desiredRisk') is distinct from
         (case when new.desired_risk is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'expiresAt') is distinct from
         (case when new.expires_at is null then 'null' else 'string' end)
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'createdAt', new.created_at
       )
       or source_event.payload->>'intentId' is distinct from new.id::text
       or source_event.payload->>'direction' is distinct from new.direction
       or source_event.payload->>'symbol' is distinct from new.symbol
       or source_event.payload->>'initialStatus' is distinct from new.initial_status
       or source_event.payload->>'entryPrice' is distinct from new.entry_price
       or source_event.payload->>'stopPrice' is distinct from new.stop_price
       or source_event.payload->>'targetPrice' is distinct from new.target_price
       or source_event.payload->>'desiredRisk' is distinct from new.desired_risk
       or (source_event.payload->>'expiresAt' is null)
          is distinct from (new.expires_at is null)
       or (
         source_event.payload->>'expiresAt' is not null
         and not challenge_ledger_payload_timestamp_matches(
           source_event.payload, 'expiresAt', new.expires_at
         )
       ) then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
  elsif tg_table_name='challenge_orders' then
    if jsonb_typeof(source_event.payload->'orderId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'intentId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'symbol') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'side') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'quantity') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'initialStatus') is distinct from 'string'
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'createdAt', new.created_at
       )
       or source_event.payload->>'orderId' is distinct from new.id::text
       or source_event.payload->>'intentId' is distinct from new.intent_id::text
       or source_event.payload->>'symbol' is distinct from new.symbol
       or source_event.payload->>'side' is distinct from new.side
       or source_event.payload->>'quantity' is distinct from new.quantity
       or source_event.payload->>'initialStatus' is distinct from new.initial_status then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
    select * into related_intent from challenge_intents
     where id=new.intent_id and stage_id=new.stage_id
       and profile_version_id=new.profile_version_id;
    if related_intent.id is null
       or related_intent.symbol is distinct from new.symbol
       or (related_intent.direction='PAPER_LONG') is distinct from (new.side='BUY') then
      raise exception 'CHALLENGE_ORDER_INTENT_INVALID';
    end if;
    if not exists (
      select 1 from challenge_ledger_events dependency_event
       where dependency_event.id=related_intent.ledger_event_id
         and dependency_event.stage_id=source_event.stage_id
         and dependency_event.profile_version_id=source_event.profile_version_id
         and dependency_event.sequence<source_event.sequence
    ) then
      raise exception 'CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID';
    end if;
  elsif tg_table_name='challenge_positions' then
    if jsonb_typeof(source_event.payload->'positionId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'symbol') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'side') is distinct from 'string'
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'openedAt', new.opened_at
       )
       or source_event.payload->>'positionId' is distinct from new.id::text
       or source_event.payload->>'symbol' is distinct from new.symbol
       or source_event.payload->>'side' is distinct from new.side then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
  elsif tg_table_name='challenge_position_closures' then
    if jsonb_typeof(source_event.payload->'closureId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'positionId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'quantity') is distinct from
         (case when new.quantity is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'price') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'commission') is distinct from 'string'
       or source_event.payload->>'closureId' is distinct from new.id::text
       or source_event.payload->>'positionId' is distinct from new.position_id::text
       or source_event.payload->>'quantity' is distinct from new.quantity
       or source_event.payload->>'price' is distinct from new.price
       or source_event.payload->>'commission' is distinct from new.commission
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'closedAt', new.closed_at
       ) then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
    select * into related_position from challenge_positions
     where id=new.position_id and stage_id=new.stage_id
       and profile_version_id=new.profile_version_id
     for update;
    if related_position.id is null then
      raise exception 'CHALLENGE_POSITION_NOT_FOUND';
    end if;
    if not exists (
      select 1 from challenge_ledger_events dependency_event
       where dependency_event.id=related_position.opening_ledger_event_id
         and dependency_event.stage_id=source_event.stage_id
         and dependency_event.profile_version_id=source_event.profile_version_id
         and dependency_event.sequence<source_event.sequence
    ) then
      raise exception 'CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID';
    end if;
    if exists (
      select 1
        from challenge_position_closures prior_close
        join challenge_ledger_events prior_event
          on prior_event.id=prior_close.ledger_event_id
       where prior_close.position_id=new.position_id
         and prior_close.quantity is null
         and prior_event.sequence<source_event.sequence
    ) then
      raise exception 'CHALLENGE_POSITION_ALREADY_CLOSED';
    end if;
    select coalesce(sum(quantity::numeric),0) into filled_quantity
      from challenge_fills prior_fill
      join challenge_ledger_events prior_event
        on prior_event.id=prior_fill.ledger_event_id
     where prior_fill.position_id=new.position_id
       and prior_event.sequence<source_event.sequence;
    select coalesce(sum(quantity::numeric),0) into closed_quantity
      from challenge_position_closures prior_close
      join challenge_ledger_events prior_event
        on prior_event.id=prior_close.ledger_event_id
     where prior_close.position_id=new.position_id
       and prior_event.sequence<source_event.sequence;
    remaining_quantity := filled_quantity-closed_quantity;
    if remaining_quantity<=0 then
      raise exception 'CHALLENGE_POSITION_ALREADY_CLOSED';
    end if;
    if coalesce(new.quantity::numeric, remaining_quantity)>remaining_quantity then
      raise exception 'CHALLENGE_CLOSE_QUANTITY_EXCEEDS_POSITION';
    end if;
  elsif tg_table_name='challenge_fills' then
    if jsonb_typeof(source_event.payload->'fillId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'orderId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'positionId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'symbol') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'side') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'quantity') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'price') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'commission') is distinct from 'string'
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'filledAt', new.filled_at
       )
       or source_event.payload->>'fillId' is distinct from new.id::text
       or source_event.payload->>'orderId' is distinct from new.order_id::text
       or source_event.payload->>'positionId' is distinct from new.position_id::text
       or source_event.payload->>'side' is distinct from new.side
       or source_event.payload->>'quantity' is distinct from new.quantity
       or source_event.payload->>'price' is distinct from new.price
       or source_event.payload->>'commission' is distinct from new.commission then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
    select * into related_order from challenge_orders
     where id=new.order_id and stage_id=new.stage_id
       and profile_version_id=new.profile_version_id
     for update;
    select * into related_position from challenge_positions
     where id=new.position_id and stage_id=new.stage_id
       and profile_version_id=new.profile_version_id
     for update;
    if related_order.id is null or related_position.id is null
       or new.side is distinct from related_order.side
       or new.side is distinct from related_position.side
       or source_event.payload->>'symbol' is distinct from related_order.symbol
       or source_event.payload->>'symbol' is distinct from related_position.symbol then
      raise exception 'CHALLENGE_FILL_STREAM_INVALID';
    end if;
    if not exists (
      select 1 from challenge_ledger_events dependency_event
       where dependency_event.id=related_order.ledger_event_id
         and dependency_event.stage_id=source_event.stage_id
         and dependency_event.profile_version_id=source_event.profile_version_id
         and dependency_event.sequence<source_event.sequence
    ) or not exists (
      select 1 from challenge_ledger_events dependency_event
       where dependency_event.id=related_position.opening_ledger_event_id
         and dependency_event.stage_id=source_event.stage_id
         and dependency_event.profile_version_id=source_event.profile_version_id
         and dependency_event.sequence<=source_event.sequence
    ) then
      raise exception 'CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID';
    end if;
    if tg_when='AFTER'
       and new.ledger_event_id<>related_position.opening_ledger_event_id
       and not challenge_position_is_active_before(
         new.position_id,
         new.stage_id,
         new.profile_version_id,
         source_event.sequence
       ) then
      raise exception 'CHALLENGE_POSITION_NOT_ACTIVE';
    end if;
    select coalesce(sum(quantity::numeric),0) into filled_quantity
      from challenge_fills where order_id=new.order_id and id<>new.id;
    if filled_quantity+new.quantity::numeric>related_order.quantity::numeric then
      raise exception 'CHALLENGE_FILL_QUANTITY_EXCEEDS_ORDER';
    end if;
  elsif tg_table_name='challenge_price_marks' then
    if jsonb_typeof(source_event.payload->'markId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'positionId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'marketObservationId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'price') is distinct from 'string'
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'observedAt', new.observed_at
       )
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'recordedAt', new.recorded_at
       )
       or source_event.payload->>'markId' is distinct from new.id::text
       or source_event.payload->>'positionId' is distinct from new.position_id::text
       or source_event.payload->>'marketObservationId'
         is distinct from new.market_observation_id::text
       or source_event.payload->>'price' is distinct from new.price then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
    select * into related_position from challenge_positions
     where id=new.position_id and stage_id=new.stage_id
       and profile_version_id=new.profile_version_id
     for update;
    select * into related_observation from market_observations
     where id=new.market_observation_id;
    if related_observation.id is not null then
      select * into related_source from market_data_sources
       where provider=related_observation.provider
         and license_id=related_observation.license_id;
    end if;
    if related_position.id is null or related_observation.id is null
       or related_source.provider is null or not related_source.licensed
       or related_source.redistribution='PROHIBITED'
       or related_observation.symbol is distinct from related_position.symbol
       or related_observation.price is distinct from new.price
       or related_observation.observed_at is distinct from new.observed_at then
      raise exception 'CHALLENGE_MARK_OBSERVATION_INVALID';
    end if;
    if not exists (
      select 1 from challenge_ledger_events dependency_event
       where dependency_event.id=related_position.opening_ledger_event_id
         and dependency_event.stage_id=source_event.stage_id
         and dependency_event.profile_version_id=source_event.profile_version_id
         and dependency_event.sequence<source_event.sequence
    ) then
      raise exception 'CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID';
    end if;
    if tg_when='AFTER' and not challenge_position_is_active_before(
      new.position_id,
      new.stage_id,
      new.profile_version_id,
      source_event.sequence
    ) then
      raise exception 'CHALLENGE_POSITION_NOT_ACTIVE';
    end if;
  elsif tg_table_name='challenge_fees' then
    if jsonb_typeof(source_event.payload->'feeId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'positionId') is distinct from
         (case when new.position_id is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'orderId') is distinct from
         (case when new.order_id is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'amount') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'category') is distinct from 'string'
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'recordedAt', new.recorded_at
       )
       or source_event.payload->>'feeId' is distinct from new.id::text
       or source_event.payload->>'positionId' is distinct from new.position_id::text
       or source_event.payload->>'orderId' is distinct from new.order_id::text
       or source_event.payload->>'amount' is distinct from new.amount
       or source_event.payload->>'category' is distinct from new.category then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
    if (
      new.position_id is not null and not exists (
        select 1
          from challenge_positions dependency
          join challenge_ledger_events dependency_event
            on dependency_event.id=dependency.opening_ledger_event_id
         where dependency.id=new.position_id
           and dependency.stage_id=new.stage_id
           and dependency.profile_version_id=new.profile_version_id
           and dependency_event.sequence<source_event.sequence
      )
    ) or (
      new.order_id is not null and not exists (
        select 1
          from challenge_orders dependency
          join challenge_ledger_events dependency_event
            on dependency_event.id=dependency.ledger_event_id
         where dependency.id=new.order_id
           and dependency.stage_id=new.stage_id
           and dependency.profile_version_id=new.profile_version_id
           and dependency_event.sequence<source_event.sequence
      )
    ) then
      raise exception 'CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID';
    end if;
  elsif tg_table_name='challenge_financing' then
    if jsonb_typeof(source_event.payload->'financingId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'positionId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'amount') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'utcDays') is distinct from 'number'
       or jsonb_typeof(source_event.payload->'policyVersion') is distinct from 'string'
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'recordedAt', new.recorded_at
       )
       or source_event.payload->>'financingId' is distinct from new.id::text
       or source_event.payload->>'positionId' is distinct from new.position_id::text
       or source_event.payload->>'amount' is distinct from new.amount
       or source_event.payload->'utcDays' is distinct from to_jsonb(new.utc_days)
       or source_event.payload->>'policyVersion' is distinct from new.policy_version then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
    select * into related_position from challenge_positions
     where id=new.position_id and stage_id=new.stage_id
       and profile_version_id=new.profile_version_id;
    if related_position.id is null or not exists (
      select 1 from challenge_ledger_events dependency_event
       where dependency_event.id=related_position.opening_ledger_event_id
         and dependency_event.stage_id=source_event.stage_id
         and dependency_event.profile_version_id=source_event.profile_version_id
         and dependency_event.sequence<source_event.sequence
    ) then
      raise exception 'CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID';
    end if;
  elsif tg_table_name='challenge_rule_evaluations' then
    if jsonb_typeof(source_event.payload->'evaluationId') is distinct from 'string'
       or jsonb_typeof(source_event.payload->'intentId') is distinct from
         (case when new.intent_id is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'evaluatedLedgerHighWaterId') is distinct from
         (case when new.evaluated_ledger_high_water_id is null then 'null' else 'string' end)
       or jsonb_typeof(source_event.payload->'accepted') is distinct from 'boolean'
       or jsonb_typeof(source_event.payload->'reasons') is distinct from 'array'
       or not challenge_ledger_payload_timestamp_matches(
         source_event.payload, 'evaluatedAt', new.evaluated_at
       )
       or source_event.payload->>'evaluationId' is distinct from new.id::text
       or source_event.payload->>'intentId' is distinct from new.intent_id::text
       or source_event.payload->>'evaluatedLedgerHighWaterId'
         is distinct from new.evaluated_ledger_high_water_id::text
       or source_event.payload->'accepted' is distinct from to_jsonb(new.accepted)
       or source_event.payload->'reasons' is distinct from new.reasons then
      raise exception 'CHALLENGE_SOURCE_PAYLOAD_MISMATCH';
    end if;
    if (
      new.intent_id is not null and not exists (
        select 1
          from challenge_intents dependency
          join challenge_ledger_events dependency_event
            on dependency_event.id=dependency.ledger_event_id
         where dependency.id=new.intent_id
           and dependency.stage_id=new.stage_id
           and dependency.profile_version_id=new.profile_version_id
           and dependency_event.sequence<source_event.sequence
      )
    ) or (
      new.evaluated_ledger_high_water_id is not null and not exists (
        select 1 from challenge_ledger_events dependency_event
         where dependency_event.id=new.evaluated_ledger_high_water_id
           and dependency_event.stage_id=new.stage_id
           and dependency_event.profile_version_id=new.profile_version_id
           and dependency_event.sequence<source_event.sequence
      )
    ) then
      raise exception 'CHALLENGE_SOURCE_DEPENDENCY_SEQUENCE_INVALID';
    end if;
  end if;
  return new;
end;
$$;

create trigger challenge_intents_validate_event before insert on challenge_intents
for each row execute function validate_challenge_source_event();
create trigger challenge_orders_validate_event before insert on challenge_orders
for each row execute function validate_challenge_source_event();
create trigger challenge_positions_validate_event before insert on challenge_positions
for each row execute function validate_challenge_source_event();
create trigger challenge_position_closures_validate_event before insert on challenge_position_closures
for each row execute function validate_challenge_source_event();
create trigger challenge_fills_validate_event before insert on challenge_fills
for each row execute function validate_challenge_source_event();
create trigger challenge_price_marks_validate_event before insert on challenge_price_marks
for each row execute function validate_challenge_source_event();
create trigger challenge_fees_validate_event before insert on challenge_fees
for each row execute function validate_challenge_source_event();
create trigger challenge_financing_validate_event before insert on challenge_financing
for each row execute function validate_challenge_source_event();
create trigger challenge_rule_evaluations_validate_event before insert on challenge_rule_evaluations
for each row execute function validate_challenge_source_event();

-- Re-run source and stream validation against the transaction's complete row
-- set so insertion order cannot hide a later dependency or capacity conflict.
create constraint trigger challenge_intents_validate_event_at_commit
after insert on challenge_intents deferrable initially deferred
for each row execute function validate_challenge_source_event();
create constraint trigger challenge_orders_validate_event_at_commit
after insert on challenge_orders deferrable initially deferred
for each row execute function validate_challenge_source_event();
create constraint trigger challenge_positions_validate_event_at_commit
after insert on challenge_positions deferrable initially deferred
for each row execute function validate_challenge_source_event();
create constraint trigger challenge_position_closures_validate_event_at_commit
after insert on challenge_position_closures deferrable initially deferred
for each row execute function validate_challenge_source_event();
create constraint trigger challenge_fills_validate_event_at_commit
after insert on challenge_fills deferrable initially deferred
for each row execute function validate_challenge_source_event();
create constraint trigger challenge_price_marks_validate_event_at_commit
after insert on challenge_price_marks deferrable initially deferred
for each row execute function validate_challenge_source_event();
create constraint trigger challenge_fees_validate_event_at_commit
after insert on challenge_fees deferrable initially deferred
for each row execute function validate_challenge_source_event();
create constraint trigger challenge_financing_validate_event_at_commit
after insert on challenge_financing deferrable initially deferred
for each row execute function validate_challenge_source_event();
create constraint trigger challenge_rule_evaluations_validate_event_at_commit
after insert on challenge_rule_evaluations deferrable initially deferred
for each row execute function validate_challenge_source_event();

create function require_challenge_typed_source() returns trigger
language plpgsql as $$
declare source_exists boolean;
begin
  source_exists := case new.type
    when 'paper.intent.proposed' then exists (
      select 1 from challenge_intents where ledger_event_id=new.id
    )
    when 'paper.intent.rejected' then exists (
      select 1 from challenge_intents where ledger_event_id=new.id
    )
    when 'paper.order.created' then exists (
      select 1 from challenge_orders where ledger_event_id=new.id
    )
    when 'paper.fill.created' then exists (
      select 1 from challenge_fills where ledger_event_id=new.id
    )
    when 'paper.position.closed' then exists (
      select 1 from challenge_position_closures where ledger_event_id=new.id
    )
    when 'price.mark.recorded' then exists (
      select 1 from challenge_price_marks where ledger_event_id=new.id
    )
    when 'fee.recorded' then exists (
      select 1 from challenge_fees where ledger_event_id=new.id
    )
    when 'financing.recorded' then exists (
      select 1 from challenge_financing where ledger_event_id=new.id
    )
    when 'rule.evaluated' then exists (
      select 1 from challenge_rule_evaluations where ledger_event_id=new.id
    )
    else true
  end;
  if not source_exists then
    raise exception 'CHALLENGE_LEDGER_TYPED_SOURCE_MISSING';
  end if;
  return null;
end;
$$;

create constraint trigger challenge_ledger_events_require_typed_source
after insert on challenge_ledger_events
deferrable initially deferred
for each row execute function require_challenge_typed_source();

create table challenge_projection_checkpoints (
  stage_id uuid primary key references challenge_stages(id),
  profile_version_id uuid not null references challenge_profile_versions(id),
  high_water_event_id uuid not null,
  high_water_sequence bigint not null check (high_water_sequence > 0),
  projection jsonb not null check (jsonb_typeof(projection)='object'),
  rebuilt_at timestamptz not null default clock_timestamp(),
  foreign key (
    high_water_event_id, stage_id, profile_version_id, high_water_sequence
  ) references challenge_ledger_events(
    id, stage_id, profile_version_id, sequence
  ),
  check (projection->>'highWaterId'=high_water_event_id::text),
  check (projection->>'profileVersionId'=profile_version_id::text)
);

create function reject_challenge_ledger_source_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '%', case tg_table_name
    when 'challenge_stages' then 'IMMUTABLE_CHALLENGE_STAGE'
    when 'challenge_ledger_events' then 'IMMUTABLE_CHALLENGE_LEDGER_EVENT'
    when 'challenge_intents' then 'IMMUTABLE_CHALLENGE_INTENT'
    when 'challenge_orders' then 'IMMUTABLE_CHALLENGE_ORDER'
    when 'challenge_positions' then 'IMMUTABLE_CHALLENGE_POSITION'
    when 'challenge_position_closures' then 'IMMUTABLE_CHALLENGE_POSITION_CLOSURE'
    when 'challenge_fills' then 'IMMUTABLE_CHALLENGE_FILL'
    when 'challenge_price_marks' then 'IMMUTABLE_CHALLENGE_PRICE_MARK'
    when 'challenge_fees' then 'IMMUTABLE_CHALLENGE_FEE'
    when 'challenge_financing' then 'IMMUTABLE_CHALLENGE_FINANCING'
    when 'challenge_rule_evaluations' then 'IMMUTABLE_CHALLENGE_RULE_EVALUATION'
    else 'IMMUTABLE_CHALLENGE_SOURCE'
  end;
end;
$$;

create trigger challenge_stages_immutable before update or delete on challenge_stages
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_ledger_events_immutable before update or delete on challenge_ledger_events
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_intents_immutable before update or delete on challenge_intents
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_orders_immutable before update or delete on challenge_orders
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_positions_immutable before update or delete on challenge_positions
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_position_closures_immutable before update or delete on challenge_position_closures
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_fills_immutable before update or delete on challenge_fills
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_price_marks_immutable before update or delete on challenge_price_marks
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_fees_immutable before update or delete on challenge_fees
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_financing_immutable before update or delete on challenge_financing
for each row execute function reject_challenge_ledger_source_mutation();
create trigger challenge_rule_evaluations_immutable before update or delete on challenge_rule_evaluations
for each row execute function reject_challenge_ledger_source_mutation();
