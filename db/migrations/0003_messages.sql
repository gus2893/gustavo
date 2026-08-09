alter table conversations
  add constraint conversations_id_account_unique unique (id, account_id);

create table messages (
  event_id uuid primary key references encrypted_event_bodies(event_id),
  conversation_id uuid not null,
  account_id uuid not null,
  role text not null check (role in ('USER', 'NODE')),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  status text not null check (status in ('COMPLETED', 'ABORTED')),
  occurred_at timestamptz not null,
  completed_at timestamptz,
  aborted_at timestamptz,
  abort_reason text,
  foreign key (conversation_id, account_id)
    references conversations(id, account_id),
  unique (conversation_id, idempotency_key),
  check (
    (status = 'COMPLETED'
      and completed_at is not null
      and aborted_at is null
      and abort_reason is null)
    or
    (status = 'ABORTED'
      and completed_at is null
      and aborted_at is not null
      and abort_reason is not null
      and length(trim(abort_reason)) between 1 and 200)
  )
);

create index messages_conversation_cursor_idx
  on messages (conversation_id, event_id);

create function enforce_message_event_scope() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1
    from events e
    where e.id = new.event_id
      and e.aggregate_id = new.conversation_id::text
      and e.account_id = new.account_id::text
      and e.visibility = 'PRIVATE_ACCOUNT'
  ) then
    raise exception 'MESSAGE_EVENT_SCOPE_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger message_event_scope_is_consistent
before insert on messages
for each row execute function enforce_message_event_scope();

create function reject_message_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_MESSAGE';
end;
$$;

create trigger messages_are_immutable
before update or delete on messages
for each row execute function reject_message_mutation();
