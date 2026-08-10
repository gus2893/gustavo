create table main_state_versions (
  version bigint primary key check (version > 0),
  author_type text not null default 'MAIN_BRAIN'
    check (author_type = 'MAIN_BRAIN'),
  author_id text not null default 'gustavo-main'
    check (author_id = 'gustavo-main'),
  status text not null default 'COMMITTED'
    check (status = 'COMMITTED'),
  created_at timestamptz not null default clock_timestamp()
);

create table broadcasts (
  id uuid primary key,
  main_state_version bigint not null references main_state_versions(version),
  author_type text not null default 'MAIN_BRAIN'
    check (author_type = 'MAIN_BRAIN'),
  author_id text not null default 'gustavo-main'
    check (author_id = 'gustavo-main'),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  source_ids jsonb not null check (jsonb_typeof(source_ids) = 'array'),
  policy_version text not null check (length(trim(policy_version)) between 1 and 128),
  commit_event_id uuid not null unique references events(id),
  idempotency_key text not null unique
    check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  committed_at timestamptz not null default clock_timestamp(),
  unique (id, body_digest, main_state_version, author_type)
);

create index broadcasts_main_state_committed_idx
  on broadcasts (main_state_version, committed_at desc, id);

-- Supported v1 BCP-47 subset, shared with canonicalBroadcastLocale:
-- lowercase 2-3 letter language, optional Titlecase script, and optional
-- uppercase alpha or three-digit region. Application input may be noncanonical,
-- but it is canonicalized before storage; direct SQL must already be canonical.
create function is_canonical_broadcast_locale(candidate text)
returns boolean
language sql
immutable
strict
parallel safe
as $$
  select char_length(candidate) between 2 and 35
    and candidate collate "C"
      ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$';
$$;

create table deliveries (
  id uuid primary key,
  broadcast_id uuid not null,
  account_id uuid not null references accounts(id),
  node_brain_id uuid not null,
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  author_type text not null default 'MAIN_BRAIN'
    check (author_type = 'MAIN_BRAIN'),
  main_state_version bigint not null check (main_state_version > 0),
  locale text not null check (is_canonical_broadcast_locale(locale)),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  delivery_event_id uuid not null unique references events(id),
  created_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  unique (broadcast_id, account_id),
  foreign key (node_brain_id, account_id) references node_brains(id, account_id),
  foreign key (broadcast_id, body_digest, main_state_version, author_type)
    references broadcasts(id, body_digest, main_state_version, author_type)
);

create index deliveries_account_created_idx
  on deliveries (account_id, created_at desc, id);

create function validate_broadcast_insert() returns trigger language plpgsql as $$
declare
  canonical_sources jsonb;
begin
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
    into canonical_sources
  from (
    select distinct value
    from jsonb_array_elements_text(new.source_ids) as source(value)
    where length(trim(value)) between 1 and 200
  ) canonical;

  if jsonb_array_length(new.source_ids) < 1
     or jsonb_array_length(new.source_ids) > 64
     or canonical_sources <> new.source_ids then
    raise exception 'BROADCAST_SOURCES_NOT_CANONICAL';
  end if;

  if not exists (
    select 1 from events
    where id=new.commit_event_id
      and aggregate_id=new.id::text
      and actor_type='MAIN_BRAIN'
      and actor_id='gustavo-main'
      and type='main.broadcast.committed'
      and visibility='SHARED'
      and account_id is null
      and policy_version=new.policy_version
  ) then
    raise exception 'BROADCAST_COMMIT_EVENT_INVALID';
  end if;
  return new;
end;
$$;

create trigger broadcasts_validate_insert
before insert on broadcasts
for each row execute function validate_broadcast_insert();

create function reject_main_state_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_MAIN_STATE_VERSION';
end;
$$;

create trigger main_state_versions_immutable
before update or delete on main_state_versions
for each row execute function reject_main_state_mutation();

create function reject_broadcast_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_BROADCAST';
end;
$$;

create trigger broadcasts_immutable
before update or delete on broadcasts
for each row execute function reject_broadcast_mutation();

create function protect_delivery_record() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_DELIVERY';
  end if;
  if new.broadcast_id is distinct from old.broadcast_id
     or new.account_id is distinct from old.account_id
     or new.node_brain_id is distinct from old.node_brain_id
     or new.body_digest is distinct from old.body_digest
     or new.author_type is distinct from old.author_type
     or new.main_state_version is distinct from old.main_state_version
     or new.locale is distinct from old.locale
     or new.request_digest is distinct from old.request_digest
     or new.delivery_event_id is distinct from old.delivery_event_id
     or new.created_at is distinct from old.created_at then
    raise exception 'IMMUTABLE_DELIVERY_SEMANTICS';
  end if;
  return new;
end;
$$;

create trigger deliveries_protect_record
before update or delete on deliveries
for each row execute function protect_delivery_record();

create function validate_delivery_insert() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
    from accounts a
    join entitlements entitlement
      on entitlement.account_id=a.id
     and entitlement.revoked_at is null
     and entitlement.active_from <= clock_timestamp()
     and (entitlement.expires_at is null or entitlement.expires_at > clock_timestamp())
    join node_brains node
      on node.account_id=a.id
     and node.id=new.node_brain_id
     and node.status='ACTIVE'
    where a.id=new.account_id and a.status='ACTIVE'
  ) then
    raise exception 'BROADCAST_DELIVERY_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from events event
    join broadcasts broadcast on broadcast.id=new.broadcast_id
    where event.id=new.delivery_event_id
      and event.aggregate_id=new.broadcast_id::text
      and event.account_id=new.account_id::text
      and event.actor_type='MAIN_BRAIN'
      and event.actor_id='gustavo-main'
      and event.type='main.broadcast.delivered'
      and event.visibility='PRIVATE_ACCOUNT'
      and event.causation_id=broadcast.commit_event_id
      and event.policy_version=broadcast.policy_version
  ) then
    raise exception 'BROADCAST_DELIVERY_EVENT_INVALID';
  end if;
  return new;
end;
$$;

create trigger deliveries_validate_insert
before insert on deliveries
for each row execute function validate_delivery_insert();
