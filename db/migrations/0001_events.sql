create table aggregate_data_keys (
  id uuid primary key,
  aggregate_id text not null unique,
  root_key_version integer not null check (root_key_version > 0),
  wrapped_key bytea not null,
  wrap_iv bytea not null check (octet_length(wrap_iv) = 12),
  wrap_auth_tag bytea not null check (octet_length(wrap_auth_tag) = 16),
  created_at timestamptz not null default clock_timestamp()
);

create table events (
  id uuid primary key,
  aggregate_id text not null,
  account_id text,
  actor_type text not null,
  actor_id text not null,
  type text not null,
  visibility text not null check (visibility in ('PUBLIC', 'PRIVATE_ACCOUNT', 'SHARED', 'OPERATOR')),
  occurred_at timestamptz not null,
  causation_id uuid references events(id),
  correlation_id uuid not null,
  prompt_version text,
  model_version text,
  policy_version text,
  idempotency_key text not null unique,
  request_hash char(64) not null check (request_hash ~ '^[a-f0-9]{64}$'),
  integrity_hash char(64) not null check (integrity_hash ~ '^[a-f0-9]{64}$'),
  unique (id, aggregate_id),
  constraint private_event_requires_account check (
    visibility <> 'PRIVATE_ACCOUNT' or account_id is not null
  )
);

create index events_account_cursor_idx on events (account_id, id);
create index events_aggregate_cursor_idx on events (aggregate_id, id);
create index events_correlation_idx on events (correlation_id, id);

create table encrypted_event_bodies (
  event_id uuid primary key,
  aggregate_id text not null,
  data_key_id uuid references aggregate_data_keys(id) on delete set null,
  ciphertext bytea not null,
  body_iv bytea not null check (octet_length(body_iv) = 12),
  body_auth_tag bytea not null check (octet_length(body_auth_tag) = 16),
  body_encoding text not null default 'canonical-json-v1',
  foreign key (event_id, aggregate_id) references events(id, aggregate_id)
);

create table transactional_outbox (
  id uuid primary key,
  event_id uuid not null unique references events(id),
  topic text not null,
  payload jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'LEASED', 'PUBLISHED', 'FAILED')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  leased_until timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create index transactional_outbox_pending_idx
  on transactional_outbox (status, available_at, id)
  where status in ('PENDING', 'FAILED');

create function reject_immutable_event_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_EVENT';
end;
$$;

create trigger events_are_immutable
before update or delete on events
for each row execute function reject_immutable_event_mutation();

create function reject_immutable_body_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.data_key_id is not null
     and new.data_key_id is null
     and new.event_id = old.event_id
     and new.aggregate_id = old.aggregate_id
     and new.ciphertext = old.ciphertext
     and new.body_iv = old.body_iv
     and new.body_auth_tag = old.body_auth_tag
     and new.body_encoding = old.body_encoding then
    return new;
  end if;
  raise exception 'IMMUTABLE_EVENT';
end;
$$;

create trigger encrypted_event_bodies_are_immutable
before update or delete on encrypted_event_bodies
for each row execute function reject_immutable_body_mutation();

create function enforce_body_key_aggregate() returns trigger
language plpgsql as $$
begin
  if new.data_key_id is not null and not exists (
    select 1 from aggregate_data_keys k
    where k.id = new.data_key_id and k.aggregate_id = new.aggregate_id
  ) then
    raise exception 'BODY_KEY_AGGREGATE_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger encrypted_body_key_matches_aggregate
before insert or update of data_key_id, aggregate_id on encrypted_event_bodies
for each row execute function enforce_body_key_aggregate();

create function protect_data_key_identity() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.aggregate_id is distinct from old.aggregate_id
     or new.created_at is distinct from old.created_at then
    raise exception 'IMMUTABLE_DATA_KEY_IDENTITY';
  end if;
  return new;
end;
$$;

create trigger aggregate_data_key_identity_is_immutable
before update on aggregate_data_keys
for each row execute function protect_data_key_identity();
