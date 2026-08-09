create table challenge_portfolios (
  id uuid primary key,
  owner_type text not null check (owner_type='MAIN_BRAIN'),
  initial_lifecycle_state text not null check (
    initial_lifecycle_state in ('ACTIVE','PAUSED','PASSED','FAILED','ARCHIVED')
  ),
  created_at timestamptz not null,
  created_by text not null check (length(trim(created_by)) between 1 and 200),
  creation_reason text not null check (length(trim(creation_reason)) between 1 and 500)
);

create unique index challenge_single_main_portfolio_idx
  on challenge_portfolios(owner_type);

create table challenge_profile_versions (
  id uuid primary key,
  challenge_portfolio_id uuid not null references challenge_portfolios(id),
  version integer not null check (version > 0),
  supersedes_profile_version_id uuid,
  base_currency char(3) not null check (base_currency='USD'),
  profit_objective_bps integer not null check (profit_objective_bps between 1 and 10000),
  overall_drawdown_type text not null check (overall_drawdown_type='STATIC'),
  overall_loss_limit_bps integer not null check (overall_loss_limit_bps between 1 and 10000),
  trailing_overall_drawdown boolean not null check (not trailing_overall_drawdown),
  daily_loss_type text not null check (daily_loss_type='DAY_START_EQUITY'),
  daily_loss_limit_bps integer not null check (daily_loss_limit_bps between 1 and 10000),
  reset_timezone text not null check (reset_timezone='UTC'),
  reset_boundary char(5) not null check (reset_boundary='00:00'),
  minimum_trading_days integer not null check (minimum_trading_days > 0),
  deadline_days integer check (deadline_days is null or deadline_days > 0),
  portfolio_risk_limit_bps integer not null check (portfolio_risk_limit_bps between 1 and 10000),
  position_risk_limit_bps integer not null check (position_risk_limit_bps between 1 and 10000),
  qualifying_risk_bps integer not null check (qualifying_risk_bps between 1 and 10000),
  max_gross_leverage_bps integer not null check (max_gross_leverage_bps between 1 and 10000),
  maximum_positions integer not null check (maximum_positions > 0),
  maximum_positions_per_symbol integer not null check (
    maximum_positions_per_symbol > 0
    and maximum_positions_per_symbol <= maximum_positions
  ),
  allowed_asset_classes text[] not null check (
    allowed_asset_classes=array['US_STOCK','US_ETF']::text[]
  ),
  cost_policy_version text not null check (
    length(trim(cost_policy_version)) between 1 and 128
  ),
  initial_lifecycle_state text not null check (
    initial_lifecycle_state in ('ACTIVE','PAUSED','PASSED','FAILED','ARCHIVED')
  ),
  effective_at timestamptz not null,
  created_by text not null check (length(trim(created_by)) between 1 and 200),
  change_reason text not null check (length(trim(change_reason)) between 1 and 500),
  unique (challenge_portfolio_id, version),
  unique (id, challenge_portfolio_id),
  unique (supersedes_profile_version_id),
  foreign key (supersedes_profile_version_id, challenge_portfolio_id)
    references challenge_profile_versions(id, challenge_portfolio_id),
  check (daily_loss_limit_bps <= overall_loss_limit_bps),
  check (position_risk_limit_bps <= portfolio_risk_limit_bps),
  check (qualifying_risk_bps <= position_risk_limit_bps)
);

create function validate_challenge_profile_version_insert() returns trigger
language plpgsql as $$
declare latest_id uuid;
declare latest_version integer;
declare latest_effective_at timestamptz;
begin
  perform 1 from challenge_portfolios
    where id=new.challenge_portfolio_id for update;
  if not found then
    raise exception 'CHALLENGE_PORTFOLIO_NOT_FOUND';
  end if;

  select id, version, effective_at
    into latest_id, latest_version, latest_effective_at
    from challenge_profile_versions
    where challenge_portfolio_id=new.challenge_portfolio_id
    order by version desc limit 1;

  if latest_id is null then
    if new.version<>1 or new.supersedes_profile_version_id is not null then
      raise exception 'CHALLENGE_PROFILE_VERSION_SEQUENCE_INVALID';
    end if;
  elsif new.version<>latest_version+1
      or new.supersedes_profile_version_id is distinct from latest_id
      or new.effective_at<=latest_effective_at then
    raise exception 'CHALLENGE_PROFILE_VERSION_SEQUENCE_INVALID';
  end if;
  return new;
end;
$$;

create trigger challenge_profile_versions_validate_insert
before insert on challenge_profile_versions
for each row execute function validate_challenge_profile_version_insert();

create table challenge_profile_publications (
  profile_version_id uuid primary key references challenge_profile_versions(id),
  published_at timestamptz not null,
  published_by text not null check (length(trim(published_by)) between 1 and 200),
  publication_reason text not null check (
    length(trim(publication_reason)) between 1 and 500
  )
);

create function challenge_stage_starting_balance(stage_ordinal integer) returns bigint
language sql immutable strict as $$
  select case stage_ordinal
    when 1 then 250000::bigint
    when 2 then 500000::bigint
    when 3 then 1000000::bigint
    when 4 then 2000000::bigint
    when 5 then 4000000::bigint
    when 6 then 8000000::bigint
    when 7 then 16000000::bigint
    when 8 then 32000000::bigint
    when 9 then 64000000::bigint
    when 10 then 100000000::bigint
  end
$$;

create table challenge_stage_profiles (
  id uuid primary key,
  profile_version_id uuid not null references challenge_profile_versions(id),
  ordinal integer not null check (ordinal between 1 and 10),
  starting_balance_cents bigint not null check (starting_balance_cents > 0),
  target_equity_cents bigint not null check (target_equity_cents > starting_balance_cents),
  overall_floor_cents bigint not null check (
    overall_floor_cents > 0 and overall_floor_cents < starting_balance_cents
  ),
  daily_loss_limit_cents bigint not null check (daily_loss_limit_cents > 0),
  portfolio_risk_limit_cents bigint not null check (portfolio_risk_limit_cents > 0),
  position_risk_limit_cents bigint not null check (position_risk_limit_cents > 0),
  qualifying_risk_cents bigint not null check (qualifying_risk_cents > 0),
  created_at timestamptz not null,
  unique (profile_version_id, ordinal),
  unique (profile_version_id, starting_balance_cents),
  check (starting_balance_cents=challenge_stage_starting_balance(ordinal)),
  check (position_risk_limit_cents <= portfolio_risk_limit_cents),
  check (qualifying_risk_cents <= position_risk_limit_cents)
);

create function validate_challenge_stage_profile_insert() returns trigger
language plpgsql as $$
declare profile challenge_profile_versions%rowtype;
declare objective_cents bigint;
declare overall_allowance_cents bigint;
declare expected_daily_loss_cents bigint;
declare expected_portfolio_risk_cents bigint;
declare expected_position_risk_cents bigint;
declare expected_qualifying_risk_cents bigint;
begin
  select * into profile from challenge_profile_versions
    where id=new.profile_version_id for update;
  if not found then
    raise exception 'CHALLENGE_PROFILE_VERSION_NOT_FOUND';
  end if;
  if exists (
    select 1 from challenge_profile_publications
      where profile_version_id=new.profile_version_id
  ) then
    raise exception 'CHALLENGE_PROFILE_ALREADY_PUBLISHED';
  end if;

  objective_cents := (
    new.starting_balance_cents*profile.profit_objective_bps+9999
  )/10000;
  overall_allowance_cents := (
    new.starting_balance_cents*profile.overall_loss_limit_bps
  )/10000;
  expected_daily_loss_cents := (
    new.starting_balance_cents*profile.daily_loss_limit_bps
  )/10000;
  expected_portfolio_risk_cents := (
    new.starting_balance_cents*profile.portfolio_risk_limit_bps
  )/10000;
  expected_position_risk_cents := (
    new.starting_balance_cents*profile.position_risk_limit_bps
  )/10000;
  expected_qualifying_risk_cents := (
    new.starting_balance_cents*profile.qualifying_risk_bps+9999
  )/10000;

  if new.target_equity_cents<>new.starting_balance_cents+objective_cents
     or new.overall_floor_cents<>new.starting_balance_cents-overall_allowance_cents
     or new.daily_loss_limit_cents<>expected_daily_loss_cents
     or new.portfolio_risk_limit_cents<>expected_portfolio_risk_cents
     or new.position_risk_limit_cents<>expected_position_risk_cents
     or new.qualifying_risk_cents<>expected_qualifying_risk_cents then
    raise exception 'CHALLENGE_STAGE_PROFILE_VALUES_INVALID';
  end if;
  return new;
end;
$$;

create trigger challenge_stage_profiles_validate_insert
before insert on challenge_stage_profiles
for each row execute function validate_challenge_stage_profile_insert();

create function validate_challenge_profile_publication_insert() returns trigger
language plpgsql as $$
declare stage_ordinals integer[];
begin
  perform 1 from challenge_profile_versions
    where id=new.profile_version_id for update;
  if not found then
    raise exception 'CHALLENGE_PROFILE_VERSION_NOT_FOUND';
  end if;
  select array_agg(ordinal order by ordinal) into stage_ordinals
    from challenge_stage_profiles
    where profile_version_id=new.profile_version_id;
  if stage_ordinals is distinct from array[1,2,3,4,5,6,7,8,9,10] then
    raise exception 'CHALLENGE_PROFILE_PUBLICATION_INCOMPLETE';
  end if;
  return new;
end;
$$;

create trigger challenge_profile_publications_validate_insert
before insert on challenge_profile_publications
for each row execute function validate_challenge_profile_publication_insert();

create function reject_challenge_portfolio_mutation() returns trigger
language plpgsql as $$
begin raise exception 'IMMUTABLE_CHALLENGE_PORTFOLIO'; end;
$$;
create trigger challenge_portfolios_immutable
before update or delete on challenge_portfolios
for each row execute function reject_challenge_portfolio_mutation();

create function reject_challenge_profile_version_mutation() returns trigger
language plpgsql as $$
begin raise exception 'IMMUTABLE_CHALLENGE_PROFILE_VERSION'; end;
$$;
create trigger challenge_profile_versions_immutable
before update or delete on challenge_profile_versions
for each row execute function reject_challenge_profile_version_mutation();

create function reject_challenge_stage_profile_mutation() returns trigger
language plpgsql as $$
begin raise exception 'IMMUTABLE_CHALLENGE_STAGE_PROFILE'; end;
$$;
create trigger challenge_stage_profiles_immutable
before update or delete on challenge_stage_profiles
for each row execute function reject_challenge_stage_profile_mutation();

create function reject_challenge_profile_publication_mutation() returns trigger
language plpgsql as $$
begin raise exception 'IMMUTABLE_CHALLENGE_PROFILE_PUBLICATION'; end;
$$;
create trigger challenge_profile_publications_immutable
before update or delete on challenge_profile_publications
for each row execute function reject_challenge_profile_publication_mutation();

insert into challenge_portfolios (
  id, owner_type, initial_lifecycle_state, created_at, created_by, creation_reason
) values (
  '00000000-0000-4000-8000-000000001200', 'MAIN_BRAIN', 'ACTIVE',
  '2026-08-09T00:00:00.000Z', 'gustavo-operator', 'Approved shared Challenge v1'
);

insert into challenge_profile_versions (
  id, challenge_portfolio_id, version, supersedes_profile_version_id,
  base_currency, profit_objective_bps, overall_drawdown_type,
  overall_loss_limit_bps, trailing_overall_drawdown,
  daily_loss_type, daily_loss_limit_bps, reset_timezone, reset_boundary,
  minimum_trading_days, deadline_days, portfolio_risk_limit_bps,
  position_risk_limit_bps, qualifying_risk_bps, max_gross_leverage_bps,
  maximum_positions, maximum_positions_per_symbol, allowed_asset_classes,
  cost_policy_version, initial_lifecycle_state, effective_at, created_by, change_reason
) values (
  '00000000-0000-4000-8000-000000001201',
  '00000000-0000-4000-8000-000000001200',
  1, null, 'USD', 1000, 'STATIC', 600, false,
  'DAY_START_EQUITY', 400, 'UTC', '00:00', 3, null,
  300, 100, 25, 10000, 3, 1, array['US_STOCK','US_ETF']::text[],
  'stock-etf-cost-v1', 'ACTIVE', '2026-08-09T00:00:00.000Z',
  'gustavo-operator', 'Approved initial Challenge profile'
);

insert into challenge_stage_profiles (
  id, profile_version_id, ordinal, starting_balance_cents,
  target_equity_cents, overall_floor_cents, daily_loss_limit_cents,
  portfolio_risk_limit_cents, position_risk_limit_cents,
  qualifying_risk_cents, created_at
) values
  ('00000000-0000-4000-8000-000000001211', '00000000-0000-4000-8000-000000001201', 1, 250000, 275000, 235000, 10000, 7500, 2500, 625, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001212', '00000000-0000-4000-8000-000000001201', 2, 500000, 550000, 470000, 20000, 15000, 5000, 1250, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001213', '00000000-0000-4000-8000-000000001201', 3, 1000000, 1100000, 940000, 40000, 30000, 10000, 2500, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001214', '00000000-0000-4000-8000-000000001201', 4, 2000000, 2200000, 1880000, 80000, 60000, 20000, 5000, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001215', '00000000-0000-4000-8000-000000001201', 5, 4000000, 4400000, 3760000, 160000, 120000, 40000, 10000, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001216', '00000000-0000-4000-8000-000000001201', 6, 8000000, 8800000, 7520000, 320000, 240000, 80000, 20000, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001217', '00000000-0000-4000-8000-000000001201', 7, 16000000, 17600000, 15040000, 640000, 480000, 160000, 40000, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001218', '00000000-0000-4000-8000-000000001201', 8, 32000000, 35200000, 30080000, 1280000, 960000, 320000, 80000, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001219', '00000000-0000-4000-8000-000000001201', 9, 64000000, 70400000, 60160000, 2560000, 1920000, 640000, 160000, '2026-08-09T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001220', '00000000-0000-4000-8000-000000001201', 10, 100000000, 110000000, 94000000, 4000000, 3000000, 1000000, 250000, '2026-08-09T00:00:00.000Z');

insert into challenge_profile_publications (
  profile_version_id, published_at, published_by, publication_reason
) values (
  '00000000-0000-4000-8000-000000001201', '2026-08-09T00:00:00.000Z',
  'gustavo-operator', 'Approved complete initial Challenge profile'
);

alter table decision_windows
  rename column stage_profile_version to legacy_stage_profile_label;

alter table decision_windows
  drop constraint decision_windows_stage_profile_version_check,
  alter column legacy_stage_profile_label drop not null,
  add constraint decision_windows_legacy_stage_profile_label_check check (
    legacy_stage_profile_label is null
    or length(trim(legacy_stage_profile_label)) between 1 and 128
  ),
  add column stage_profile_version uuid not null
    default '00000000-0000-4000-8000-000000001201'
    constraint decision_windows_stage_profile_version_fkey
      references challenge_profile_versions(id);

alter table decision_windows
  alter column stage_profile_version drop default;

create or replace function validate_decision_window_insert() returns trigger
language plpgsql as $$
begin
  if new.legacy_stage_profile_label is not null then
    raise exception 'DECISION_LEGACY_PROFILE_FORBIDDEN';
  end if;
  if not exists (
    select 1 from challenge_profile_versions where id=new.stage_profile_version
  ) then
    raise exception 'DECISION_PROFILE_VERSION_NOT_FOUND';
  end if;
  if not exists (
    select 1 from challenge_profile_publications
      where profile_version_id=new.stage_profile_version
  ) then
    raise exception 'DECISION_PROFILE_VERSION_NOT_PUBLISHED';
  end if;
  if not exists (
    select 1 from events event where event.id=new.opened_event_id
      and event.aggregate_id=new.id::text and event.account_id is null
      and event.actor_type='SYSTEM' and event.actor_id='gustavo-decision-orchestrator'
      and event.type='decision.window.opened' and event.visibility='OPERATOR'
      and event.policy_version=new.policy_version
  ) then raise exception 'DECISION_WINDOW_EVENT_INVALID'; end if;
  return new;
end;
$$;
