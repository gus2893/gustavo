create table stream_outbox_deliveries (
  outbox_id uuid primary key references transactional_outbox(id) on delete cascade,
  event_id uuid not null unique references events(id),
  stream_position bigint unique check (stream_position is null or stream_position > 0),
  status text not null default 'PENDING' check (status in (
    'PENDING','CLAIMED','RETRY_SCHEDULED','COMPLETED','FAILED'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  worker_id text,
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check ((status='CLAIMED')=(worker_id is not null and lease_token is not null and lease_until is not null)),
  check ((status='COMPLETED')=(completed_at is not null))
);

create index stream_outbox_deliveries_claim_idx
  on stream_outbox_deliveries (available_at,created_at,outbox_id)
  where status in ('PENDING','RETRY_SCHEDULED','CLAIMED');

create function stage_stream_outbox_insert() returns trigger language plpgsql as $$
begin
  insert into stream_outbox_deliveries(outbox_id,event_id,created_at)
  values (new.id,new.event_id,new.created_at);
  return new;
end;
$$;

create trigger stream_outbox_insert_staged
after insert on transactional_outbox for each row execute function stage_stream_outbox_insert();

-- Historical rows are served by Last-Event-ID replay. Marking the migration
-- baseline complete prevents an initial deploy from flooding live subscribers.
insert into stream_outbox_deliveries (
  outbox_id,event_id,stream_position,status,created_at,completed_at
)
select ordered.id,ordered.event_id,ordered.stream_position,
       'COMPLETED',ordered.created_at,clock_timestamp()
from (
  select outbox.id,outbox.event_id,outbox.created_at,
         row_number() over (order by event.ingested_sequence,outbox.id) stream_position
  from transactional_outbox outbox join events event on event.id=outbox.event_id
) ordered
on conflict (outbox_id) do nothing;

create table stream_publish_state (
  singleton boolean primary key default true check (singleton),
  next_position bigint not null check (next_position > 0),
  active_outbox_id uuid unique references stream_outbox_deliveries(outbox_id) on delete set null,
  updated_at timestamptz not null default clock_timestamp()
);

insert into stream_publish_state(singleton,next_position)
select true,coalesce(max(stream_position),0)+1 from stream_outbox_deliveries;

create function protect_allocated_stream_position() returns trigger language plpgsql as $$
begin
  if old.stream_position is not null
    and new.stream_position is distinct from old.stream_position then
    raise exception 'IMMUTABLE_STREAM_POSITION';
  end if;
  return new;
end;
$$;

create trigger allocated_stream_position_immutable
before update of stream_position on stream_outbox_deliveries
for each row execute function protect_allocated_stream_position();
