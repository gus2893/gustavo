create table broadcast_schedules (
  id text not null check (
    id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
  ),
  version integer not null default 1 check (version > 0),
  cron text not null check (
    length(cron) between 9 and 128
    and cron = trim(cron)
  ),
  timezone text not null check (
    length(timezone) between 1 and 128
    and timezone = trim(timezone)
  ),
  enabled boolean not null default true,
  operator_id text not null default 'gustavo-operator' check (
    length(operator_id) between 1 and 128
    and operator_id = trim(operator_id)
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (id, version)
);

create index broadcast_schedules_current_idx
  on broadcast_schedules (id, version desc);

create table broadcast_schedule_runtime (
  schedule_id text primary key,
  schedule_version integer not null,
  next_run_at timestamptz,
  last_error_code text check (
    last_error_code is null
    or last_error_code in (
      'BROADCAST_SCHEDULE_CRON_INVALID',
      'BROADCAST_SCHEDULE_TIMEZONE_INVALID',
      'BROADCAST_SCHEDULE_NEXT_RUN_OUT_OF_RANGE'
    )
  ),
  last_checked_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (schedule_id, schedule_version)
    references broadcast_schedules(id, version)
);

create index broadcast_schedule_runtime_due_idx
  on broadcast_schedule_runtime (next_run_at, schedule_id);

create table broadcast_cycles (
  id uuid primary key,
  schedule_id text not null,
  schedule_version integer not null,
  slot_at timestamptz not null,
  author_type text not null default 'MAIN_BRAIN'
    check (author_type = 'MAIN_BRAIN'),
  author_id text not null default 'gustavo-main'
    check (author_id = 'gustavo-main'),
  main_state_version bigint references main_state_versions(version),
  policy_version text not null check (
    length(policy_version) between 1 and 128
    and policy_version = trim(policy_version)
  ),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  open_event_id uuid not null unique references events(id),
  opened_at timestamptz not null,
  foreign key (schedule_id, schedule_version)
    references broadcast_schedules(id, version),
  unique (schedule_id, slot_at)
);

create index broadcast_cycles_slot_idx
  on broadcast_cycles (slot_at desc, schedule_id);

create function reject_broadcast_schedule_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_BROADCAST_SCHEDULE';
end;
$$;

create trigger broadcast_schedules_are_immutable
before update or delete on broadcast_schedules
for each row execute function reject_broadcast_schedule_mutation();

create function reject_broadcast_cycle_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_BROADCAST_CYCLE';
end;
$$;

create trigger broadcast_cycles_are_immutable
before update or delete on broadcast_cycles
for each row execute function reject_broadcast_cycle_mutation();

create function validate_broadcast_cycle_insert() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1
      from events event
      join transactional_outbox outbox on outbox.event_id = event.id
     where event.id = new.open_event_id
       and event.aggregate_id = new.id::text
       and event.actor_type = 'MAIN_BRAIN'
       and event.actor_id = 'gustavo-main'
       and event.type = 'main.broadcast.generation.requested'
       and event.visibility = 'SHARED'
       and event.account_id is null
       and event.policy_version = new.policy_version
       and outbox.topic = 'main.broadcast.generation.requested'
       and outbox.payload = jsonb_build_object('eventId', event.id::text)
  ) then
    raise exception 'BROADCAST_CYCLE_EVENT_INVALID';
  end if;
  return new;
end;
$$;

create trigger broadcast_cycles_validate_insert
before insert on broadcast_cycles
for each row execute function validate_broadcast_cycle_insert();

create function protect_broadcast_generation_outbox() returns trigger
language plpgsql as $$
declare
  old_event_type text;
  new_event_type text;
  old_is_generation boolean := false;
  new_is_generation boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select event.type into old_event_type
      from events event where event.id = old.event_id;
    old_is_generation := old.topic = 'main.broadcast.generation.requested'
      or old_event_type = 'main.broadcast.generation.requested';
    if old_is_generation then
      if tg_op = 'DELETE' then
        raise exception 'IMMUTABLE_BROADCAST_GENERATION_OUTBOX';
      end if;
      if new.event_id is distinct from old.event_id
        or new.topic is distinct from old.topic
        or new.payload is distinct from old.payload
        or new.created_at is distinct from old.created_at
      then
        raise exception 'IMMUTABLE_BROADCAST_GENERATION_OUTBOX';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  select event.type into new_event_type
    from events event where event.id = new.event_id;
  new_is_generation := new.topic = 'main.broadcast.generation.requested'
    or new_event_type = 'main.broadcast.generation.requested';
  if tg_op = 'UPDATE' and not old_is_generation and new_is_generation then
    raise exception 'BROADCAST_GENERATION_OUTBOX_INVALID';
  end if;
  if new_is_generation and (
    new_event_type is null
    or new_event_type <> 'main.broadcast.generation.requested'
    or new.topic <> new_event_type
    or new.payload <> jsonb_build_object('eventId', new.event_id::text)
  ) then
    raise exception 'BROADCAST_GENERATION_OUTBOX_INVALID';
  end if;
  return new;
end;
$$;

create trigger broadcast_generation_outbox_is_authoritative
before insert or update or delete on transactional_outbox
for each row execute function protect_broadcast_generation_outbox();
