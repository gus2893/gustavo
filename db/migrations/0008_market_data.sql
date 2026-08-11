create function market_fixed_decimal_is_valid(value text) returns boolean
language sql immutable strict as $$
  select case
    when value ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$'
      then replace(value, '.', '')::numeric > 0
    else false
  end
$$;

create table market_instrument_allowlist (
  symbol text primary key check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  asset_class text not null check (asset_class in ('US_STOCK', 'US_ETF')),
  enabled boolean not null default true,
  updated_at timestamptz not null default clock_timestamp()
);

create table market_data_sources (
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  license_id text not null check (license_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  licensed boolean not null,
  redistribution text not null check (
    redistribution in ('PUBLIC', 'ACCOUNT_ONLY', 'INTERNAL_ONLY', 'PROHIBITED')
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (provider, license_id)
);

create table market_observations (
  id uuid primary key,
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  asset_class text not null check (asset_class in ('US_STOCK', 'US_ETF')),
  price text not null check (market_fixed_decimal_is_valid(price)),
  observed_at timestamptz not null,
  received_at timestamptz not null,
  provider text not null,
  license_id text not null,
  raw_source_ref text not null check (
    length(raw_source_ref) between 1 and 512
    and raw_source_ref=trim(raw_source_ref)
  ),
  feed_status text not null check (feed_status in ('REALTIME', 'DELAYED')),
  delay_seconds integer not null check (
    delay_seconds between 0 and 86400
    and ((feed_status='REALTIME' and delay_seconds=0)
      or (feed_status='DELAYED' and delay_seconds>0))
  ),
  redistribution text not null check (
    redistribution in ('PUBLIC', 'ACCOUNT_ONLY', 'INTERNAL_ONLY', 'PROHIBITED')
  ),
  session_state text not null check (
    session_state in ('OPEN', 'CLOSED', 'PRE_MARKET', 'AFTER_HOURS', 'HALTED')
  ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (provider, license_id) references market_data_sources(provider, license_id),
  unique (provider, license_id, raw_source_ref),
  check (received_at >= observed_at)
);

create function validate_market_observation_insert() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from market_instrument_allowlist instrument
    where instrument.symbol=new.symbol and instrument.asset_class=new.asset_class
      and instrument.enabled
  ) then raise exception 'MARKET_NOT_ALLOWED'; end if;
  if not exists (
    select 1 from market_data_sources source
    where source.provider=new.provider and source.license_id=new.license_id
      and source.licensed and source.redistribution=new.redistribution
      and source.redistribution<>'PROHIBITED'
  ) then raise exception 'MARKET_SOURCE_UNLICENSED'; end if;
  return new;
end;
$$;
create trigger market_observations_validate_insert
before insert on market_observations
for each row execute function validate_market_observation_insert();

create function reject_market_observation_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_MARKET_OBSERVATION'; end;
$$;
create trigger market_observations_immutable
before update or delete on market_observations
for each row execute function reject_market_observation_mutation();

create table market_bars (
  id uuid primary key,
  source_observation_id uuid not null references market_observations(id),
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  asset_class text not null check (asset_class in ('US_STOCK', 'US_ETF')),
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  timeframe text not null check (timeframe ~ '^[1-9][0-9]{0,3}[mhdw]$'),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  open_price text not null check (market_fixed_decimal_is_valid(open_price)),
  high_price text not null check (market_fixed_decimal_is_valid(high_price)),
  low_price text not null check (market_fixed_decimal_is_valid(low_price)),
  close_price text not null check (market_fixed_decimal_is_valid(close_price)),
  completed boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (symbol, asset_class, provider, timeframe, started_at),
  check (ended_at > started_at),
  check (high_price::numeric >= greatest(open_price::numeric, low_price::numeric, close_price::numeric)),
  check (low_price::numeric <= least(open_price::numeric, high_price::numeric, close_price::numeric))
);

create unique index market_one_active_bar_idx
  on market_bars(symbol, asset_class, provider, timeframe)
  where not completed;

create function validate_market_bar_insert_or_update() returns trigger language plpgsql as $$
declare source_observation market_observations%rowtype;
begin
  select * into source_observation from market_observations observation
  where observation.id=new.source_observation_id
    and observation.symbol=new.symbol
    and observation.asset_class=new.asset_class
    and observation.provider=new.provider;
  if not found then raise exception 'MARKET_BAR_SOURCE_INVALID'; end if;
  if new.completed and source_observation.observed_at < new.ended_at then
    raise exception 'MARKET_COMPLETED_BAR_SOURCE_UNCONFIRMED';
  end if;
  return new;
end;
$$;
create trigger market_bars_validate_source
before insert or update on market_bars
for each row execute function validate_market_bar_insert_or_update();

create function protect_completed_market_bar() returns trigger language plpgsql as $$
begin
  if old.completed then raise exception 'IMMUTABLE_COMPLETED_MARKET_BAR'; end if;
  if tg_op='UPDATE' and (
    new.id<>old.id or new.symbol<>old.symbol or new.asset_class<>old.asset_class
    or new.provider<>old.provider or new.timeframe<>old.timeframe
    or new.started_at<>old.started_at
  ) then raise exception 'IMMUTABLE_MARKET_BAR_IDENTITY'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger market_bars_protect_completed
before update or delete on market_bars
for each row execute function protect_completed_market_bar();
