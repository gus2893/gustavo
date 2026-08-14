create table market_symbol_catalog (
  ordinal smallint not null unique check (ordinal between 1 and 95),
  symbol text primary key check (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  kind text not null check (kind in ('STOCK', 'ETF'))
);

insert into market_symbol_catalog (ordinal, symbol, kind) values
  (1,'AAPL','STOCK'),(2,'MSFT','STOCK'),(3,'NVDA','STOCK'),
  (4,'AMZN','STOCK'),(5,'GOOGL','STOCK'),(6,'GOOG','STOCK'),
  (7,'META','STOCK'),(8,'TSLA','STOCK'),(9,'BRK.B','STOCK'),
  (10,'AVGO','STOCK'),(11,'JPM','STOCK'),(12,'LLY','STOCK'),
  (13,'V','STOCK'),(14,'XOM','STOCK'),(15,'MA','STOCK'),
  (16,'UNH','STOCK'),(17,'COST','STOCK'),(18,'WMT','STOCK'),
  (19,'NFLX','STOCK'),(20,'ORCL','STOCK'),(21,'HD','STOCK'),
  (22,'PG','STOCK'),(23,'JNJ','STOCK'),(24,'BAC','STOCK'),
  (25,'ABBV','STOCK'),(26,'KO','STOCK'),(27,'CRM','STOCK'),
  (28,'CVX','STOCK'),(29,'MRK','STOCK'),(30,'AMD','STOCK'),
  (31,'PLTR','STOCK'),(32,'CSCO','STOCK'),(33,'ACN','STOCK'),
  (34,'MCD','STOCK'),(35,'IBM','STOCK'),(36,'GE','STOCK'),
  (37,'CAT','STOCK'),(38,'GS','STOCK'),(39,'MS','STOCK'),
  (40,'AXP','STOCK'),(41,'BX','STOCK'),(42,'TMO','STOCK'),
  (43,'ISRG','STOCK'),(44,'LIN','STOCK'),(45,'ABT','STOCK'),
  (46,'DIS','STOCK'),(47,'NOW','STOCK'),(48,'QCOM','STOCK'),
  (49,'TXN','STOCK'),(50,'AMGN','STOCK'),(51,'DHR','STOCK'),
  (52,'PEP','STOCK'),(53,'PM','STOCK'),(54,'INTU','STOCK'),
  (55,'BKNG','STOCK'),(56,'RTX','STOCK'),(57,'AMAT','STOCK'),
  (58,'SPGI','STOCK'),(59,'NEE','STOCK'),(60,'LOW','STOCK'),
  (61,'UPS','STOCK'),(62,'HON','STOCK'),(63,'PFE','STOCK'),
  (64,'C','STOCK'),(65,'MU','STOCK'),(66,'SBUX','STOCK'),
  (67,'COP','STOCK'),(68,'SCHW','STOCK'),(69,'GILD','STOCK'),
  (70,'ADP','STOCK'),(71,'DE','STOCK'),(72,'BLK','STOCK'),
  (73,'PANW','STOCK'),(74,'LRCX','STOCK'),(75,'KLAC','STOCK'),
  (76,'SPY','ETF'),(77,'QQQ','ETF'),(78,'DIA','ETF'),
  (79,'IWM','ETF'),(80,'VTI','ETF'),(81,'VO','ETF'),
  (82,'VB','ETF'),(83,'VOO','ETF'),(84,'IVV','ETF'),
  (85,'XLK','ETF'),(86,'XLF','ETF'),(87,'XLE','ETF'),
  (88,'XLV','ETF'),(89,'XLI','ETF'),(90,'XLY','ETF'),
  (91,'XLP','ETF'),(92,'XLU','ETF'),(93,'XLB','ETF'),
  (94,'XLRE','ETF'),(95,'ARKK','ETF');

create function reject_market_symbol_catalog_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_MARKET_SYMBOL_CATALOG';
end;
$$;

create trigger market_symbol_catalog_is_immutable
before insert or update or delete on market_symbol_catalog
for each row execute function reject_market_symbol_catalog_mutation();

create trigger market_symbol_catalog_truncate_is_immutable
before truncate on market_symbol_catalog
for each statement execute function reject_market_symbol_catalog_mutation();

create function reject_deployment_authority_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_DEPLOYMENT_AUTHORITY';
end;
$$;

create table bridge_model_jobs (
  job_id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null unique references events(id),
  cycle_id uuid references broadcast_cycles(id),
  candidate_event_id uuid references events(id),
  parent_main_job_id uuid references bridge_model_jobs(job_id),
  role text not null check (role in ('NODE', 'EVALUATOR', 'MAIN')),
  kind text not null check (
    kind in ('NODE_REPLY', 'EVALUATOR_REVIEW', 'MAIN_GENERATION')
  ),
  priority smallint not null check (priority in (0, 10, 20)),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'PENDING' check (
    status in ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED')
  ),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 3),
  lease_owner text check (
    lease_owner is null
    or (length(lease_owner) between 1 and 128 and lease_owner=trim(lease_owner))
  ),
  lease_expires_at timestamptz,
  output_event_id uuid unique references events(id),
  safe_code text check (
    safe_code is null or safe_code in (
      'SOURCE_AUTHORITY_REVOKED',
      'ROUTING_AUTHORITY_REVOKED',
      'CODEX_AUTH_UNAVAILABLE',
      'CODEX_DAILY_QUOTA_EXHAUSTED',
      'CODEX_MODEL_UNAVAILABLE',
      'CODEX_TIMEOUT',
      'CODEX_OUTPUT_INVALID',
      'CODEX_PROCESS_FAILED',
      'OUTPUT_AUTHORITY_INVALID',
      'ATTEMPT_LIMIT_EXHAUSTED',
      'MAIN_CANDIDATE_REJECTED',
      'EVALUATOR_REJECTED'
    )
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (role='NODE' and kind='NODE_REPLY' and priority=0)
    or (role='EVALUATOR' and kind='EVALUATOR_REVIEW' and priority=10)
    or (role='MAIN' and kind='MAIN_GENERATION' and priority=20)
  ),
  check (
    (role='EVALUATOR' and parent_main_job_id is not null)
    or (role<>'EVALUATOR' and parent_main_job_id is null)
  ),
  check ((lease_owner is null)=(lease_expires_at is null)),
  check (
    (status='PENDING' and attempt_count=0 and lease_owner is null
      and output_event_id is null and safe_code is null)
    or (status='CLAIMED' and attempt_count between 1 and 3
      and lease_owner is not null
      and lease_expires_at>updated_at
      and lease_expires_at<=updated_at+interval '15 minutes'
      and output_event_id is null and safe_code is null)
    or (status='COMPLETED' and attempt_count between 1 and 3
      and lease_owner is null and output_event_id is not null and safe_code is null)
    or (status='FAILED' and attempt_count between 1 and 3
      and lease_owner is null and output_event_id is null and safe_code is not null)
  ),
  check (updated_at>=created_at)
);

create index bridge_model_jobs_claim_order_idx
  on bridge_model_jobs (priority, created_at, job_id)
  where status='PENDING';

create index bridge_model_jobs_lease_recovery_idx
  on bridge_model_jobs (lease_expires_at, priority, created_at, job_id)
  where status='CLAIMED';

create index bridge_model_jobs_terminal_retention_idx
  on bridge_model_jobs (updated_at, job_id)
  where status in ('COMPLETED', 'FAILED');

create unique index bridge_model_jobs_main_cycle_idx
  on bridge_model_jobs (cycle_id) where role='MAIN';

create unique index bridge_model_jobs_evaluator_candidate_idx
  on bridge_model_jobs (candidate_event_id) where role='EVALUATOR';

create function bridge_model_job_is_prunable(
  target_status text,
  target_updated_at timestamptz,
  target_now timestamptz
) returns boolean
language sql immutable strict as $$
  select target_status in ('COMPLETED', 'FAILED')
    and target_updated_at<=target_now-interval '7 days';
$$;

create function bridge_model_job_request_digest(
  target_source_event_id uuid,
  target_role text,
  target_kind text
) returns char(64)
language sql stable strict as $$
  select recall_manifest_digest(jsonb_build_object(
    'kind', target_kind,
    'role', target_role,
    'sourceEventId', source.id::text,
    'sourceIntegrityHash', source.integrity_hash,
    'sourceRequestHash', source.request_hash
  ))::char(64)
  from events source
  where source.id=target_source_event_id;
$$;

create function validate_bridge_model_job_insert() returns trigger
language plpgsql as $$
begin
  if new.request_digest is distinct from bridge_model_job_request_digest(
      new.source_event_id, new.role, new.kind
    ) then
    raise exception 'BRIDGE_JOB_SOURCE_AUTHORITY_INVALID';
  end if;

  if new.role='NODE' and new.kind='NODE_REPLY' and new.priority=0
    and new.cycle_id is null and new.candidate_event_id is null
    and new.parent_main_job_id is null
    and exists (
      select 1
      from messages message
      join conversations conversation
        on conversation.id=message.conversation_id
       and conversation.account_id=message.account_id
      join node_brains node
        on node.id=conversation.node_brain_id
       and node.account_id=conversation.account_id
      join events source
        on source.id=message.event_id
       and source.aggregate_id=conversation.id::text
       and source.account_id=conversation.account_id::text
       and source.actor_type='USER'
       and source.actor_id=conversation.account_id::text
       and source.type='participant.message.created'
       and source.visibility='PRIVATE_ACCOUNT'
      join encrypted_event_bodies body
        on body.event_id=source.id
       and body.aggregate_id=source.aggregate_id
       and body.data_key_id is not null
      join transactional_outbox outbox
        on outbox.event_id=source.id
       and outbox.topic='participant.message.created'
       and outbox.payload=jsonb_build_object('eventId',source.id::text)
      where message.event_id=new.source_event_id
        and message.role='USER'
        and message.status='COMPLETED'
        and message.completed_at is not null
        and new.created_at>=message.completed_at
    )
  then return new;
  end if;

  if new.role='MAIN' and new.kind='MAIN_GENERATION' and new.priority=20
    and new.cycle_id is not null and new.candidate_event_id is null
    and new.parent_main_job_id is null
    and exists (
      select 1
      from broadcast_cycles cycle
      join events source on source.id=cycle.open_event_id
      join encrypted_event_bodies body
        on body.event_id=source.id and body.aggregate_id=source.aggregate_id
       and body.data_key_id is not null
      join transactional_outbox outbox
        on outbox.event_id=source.id
       and outbox.topic='main.broadcast.generation.requested'
       and outbox.payload=jsonb_build_object('eventId',source.id::text)
      where cycle.id=new.cycle_id and source.id=new.source_event_id
        and source.aggregate_id=cycle.id::text
        and source.actor_type='MAIN_BRAIN' and source.actor_id='gustavo-main'
        and source.type='main.broadcast.generation.requested'
        and source.visibility='SHARED' and source.account_id is null
        and source.policy_version=cycle.policy_version
    )
  then return new;
  end if;

  if new.role='EVALUATOR' and new.kind='EVALUATOR_REVIEW' and new.priority=10
    and new.cycle_id is not null and new.candidate_event_id=new.source_event_id
    and new.parent_main_job_id is not null
    and exists (
      select 1
      from broadcast_cycles cycle
      join bridge_model_jobs parent on parent.job_id=new.parent_main_job_id
      join events candidate on candidate.id=new.candidate_event_id
      join encrypted_event_bodies body
        on body.event_id=candidate.id and body.aggregate_id=candidate.aggregate_id
       and body.data_key_id is not null
      join transactional_outbox outbox
        on outbox.event_id=candidate.id
       and outbox.topic='main.broadcast.candidate.generated'
       and outbox.payload=jsonb_build_object('eventId',candidate.id::text)
      where cycle.id=new.cycle_id
        and parent.role='MAIN' and parent.kind='MAIN_GENERATION' and parent.priority=20
        and parent.cycle_id=cycle.id and parent.candidate_event_id is null
        and parent.status='COMPLETED' and parent.output_event_id=candidate.id
        and parent.source_event_id=cycle.open_event_id
        and parent.request_digest=bridge_model_job_request_digest(
          parent.source_event_id,parent.role,parent.kind
        )
        and candidate.aggregate_id=cycle.id::text
        and candidate.actor_type='MAIN_BRAIN' and candidate.actor_id='gustavo-main'
        and candidate.type='main.broadcast.candidate.generated'
        and candidate.visibility='SHARED' and candidate.account_id is null
        and candidate.causation_id=cycle.open_event_id
        and candidate.correlation_id=(
          select source.correlation_id from events source where source.id=cycle.open_event_id
        )
        and candidate.policy_version=cycle.policy_version
    )
  then return new;
  end if;

  raise exception 'BRIDGE_JOB_SOURCE_AUTHORITY_INVALID';
end;
$$;

create trigger bridge_model_jobs_validate_insert
before insert on bridge_model_jobs
for each row execute function validate_bridge_model_job_insert();

create function protect_bridge_model_job_semantics() returns trigger
language plpgsql as $$
declare
  transitioned_at timestamptz;
begin
  if tg_op='DELETE' then
    if bridge_model_job_is_prunable(
      old.status,old.updated_at,clock_timestamp()
    ) then
      return old;
    end if;
    raise exception 'BRIDGE_JOB_IMMUTABLE';
  end if;
  if new.job_id is distinct from old.job_id
    or new.source_event_id is distinct from old.source_event_id
    or new.cycle_id is distinct from old.cycle_id
    or new.candidate_event_id is distinct from old.candidate_event_id
    or new.parent_main_job_id is distinct from old.parent_main_job_id
    or new.role is distinct from old.role
    or new.kind is distinct from old.kind
    or new.priority is distinct from old.priority
    or new.request_digest is distinct from old.request_digest
    or new.created_at is distinct from old.created_at
  then
    raise exception 'BRIDGE_JOB_IMMUTABLE';
  end if;
  if new is not distinct from old then
    return new;
  end if;

  transitioned_at:=clock_timestamp();
  if not (
    (old.status='PENDING' and new.status='CLAIMED'
      and new.attempt_count=old.attempt_count+1)
    or (old.status='CLAIMED' and new.status='CLAIMED'
      and old.lease_expires_at<=transitioned_at
      and new.attempt_count=old.attempt_count+1)
    or (old.status='CLAIMED' and new.status in ('COMPLETED','FAILED')
      and new.attempt_count=old.attempt_count)
  ) then
    raise exception 'BRIDGE_JOB_TRANSITION_INVALID';
  end if;

  new.updated_at:=transitioned_at;
  if new.status='CLAIMED' and (
    new.lease_expires_at is null
    or new.lease_expires_at<=transitioned_at
    or new.lease_expires_at>transitioned_at+interval '15 minutes'
  ) then
    raise exception 'BRIDGE_JOB_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;

create trigger bridge_model_jobs_are_semantically_immutable
before update or delete on bridge_model_jobs
for each row execute function protect_bridge_model_job_semantics();

create trigger bridge_model_jobs_truncate_is_immutable
before truncate on bridge_model_jobs
for each statement execute function reject_deployment_authority_truncate();

create function enqueue_node_bridge_job() returns trigger
language plpgsql as $$
begin
  if new.role='USER' and new.status='COMPLETED' then
    insert into bridge_model_jobs (
      source_event_id, role, kind, priority, request_digest, created_at, updated_at
    ) values (
      new.event_id,
      'NODE',
      'NODE_REPLY',
      0,
      bridge_model_job_request_digest(new.event_id,'NODE','NODE_REPLY'),
      new.completed_at,
      new.completed_at
    ) on conflict (source_event_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger completed_user_message_enqueues_node_bridge_job
after insert on messages
for each row execute function enqueue_node_bridge_job();

create function enqueue_main_bridge_job() returns trigger
language plpgsql as $$
begin
  -- The cycle's main.broadcast.generation.requested event is the sole source authority.
  insert into bridge_model_jobs (
    source_event_id,cycle_id,candidate_event_id,role,kind,priority,
    request_digest,created_at,updated_at
  ) values (
    new.open_event_id,new.id,null,'MAIN','MAIN_GENERATION',20,
    bridge_model_job_request_digest(new.open_event_id,'MAIN','MAIN_GENERATION'),
    new.opened_at,new.opened_at
  ) on conflict (source_event_id) do nothing;
  return new;
end;
$$;

create trigger broadcast_cycle_enqueues_main_bridge_job
after insert on broadcast_cycles
for each row execute function enqueue_main_bridge_job();

create table bridge_wake_receipts (
  message_id text primary key check (
    length(message_id) between 1 and 200 and message_id=trim(message_id)
  ),
  body_digest char(64) not null check (body_digest ~ '^[a-f0-9]{64}$'),
  published_at timestamptz not null,
  received_at timestamptz not null default statement_timestamp(),
  prune_after timestamptz not null default statement_timestamp()+interval '7 days',
  check (received_at>=published_at),
  check (prune_after>received_at and prune_after<=received_at+interval '7 days')
);

create index bridge_wake_receipts_prune_idx
  on bridge_wake_receipts (prune_after, message_id);

create function protect_bridge_wake_receipt() returns trigger
language plpgsql as $$
begin
  if tg_op='DELETE' and old.prune_after<=clock_timestamp() then
    return old;
  end if;
  raise exception 'IMMUTABLE_BRIDGE_WAKE_RECEIPT';
end;
$$;

create trigger bridge_wake_receipts_are_immutable
before update or delete on bridge_wake_receipts
for each row execute function protect_bridge_wake_receipt();

create trigger bridge_wake_receipts_truncate_is_immutable
before truncate on bridge_wake_receipts
for each statement execute function reject_deployment_authority_truncate();

create table hybrid_worker_heartbeats (
  component text primary key check (component in ('CODEX', 'MARKET', 'TUNNEL')),
  status text not null check (status in ('HEALTHY', 'DEGRADED', 'OFFLINE')),
  safe_code text check (
    safe_code is null or safe_code in (
      'AUTH_REQUIRED',
      'QUOTA_EXHAUSTED',
      'PROVIDER_UNAVAILABLE',
      'RATE_LIMITED',
      'DATABASE_UNAVAILABLE',
      'TUNNEL_UNAVAILABLE',
      'WORKER_OFFLINE'
    )
  ),
  observed_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (status='HEALTHY' and safe_code is null)
    or (status in ('DEGRADED','OFFLINE') and safe_code is not null)
  )
);

create index hybrid_worker_heartbeats_lookup_idx
  on hybrid_worker_heartbeats (observed_at desc, component);

create function protect_hybrid_worker_heartbeat() returns trigger
language plpgsql as $$
declare
  heartbeat_at timestamptz;
begin
  if tg_op='DELETE' then
    raise exception 'HYBRID_WORKER_HEARTBEAT_INVALID';
  end if;
  if tg_op='UPDATE' and new.component is distinct from old.component then
    raise exception 'HYBRID_WORKER_HEARTBEAT_INVALID';
  end if;
  heartbeat_at:=clock_timestamp();
  if tg_op='UPDATE' and (
    heartbeat_at<old.observed_at or heartbeat_at<old.updated_at
  ) then
    raise exception 'HYBRID_WORKER_HEARTBEAT_TIME_INVALID';
  end if;
  new.observed_at:=heartbeat_at;
  new.updated_at:=heartbeat_at;
  return new;
end;
$$;

create trigger hybrid_worker_heartbeats_are_bounded
before insert or update or delete on hybrid_worker_heartbeats
for each row execute function protect_hybrid_worker_heartbeat();

create trigger hybrid_worker_heartbeats_truncate_is_immutable
before truncate on hybrid_worker_heartbeats
for each statement execute function reject_deployment_authority_truncate();

create table market_poll_windows (
  window_id text primary key check (
    window_id ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$'
  ),
  window_started_at timestamptz not null unique,
  provider text not null default 'FINNHUB' check (provider='FINNHUB'),
  status text not null default 'PENDING' check (
    status in ('PENDING', 'COMPLETED', 'FAILED')
  ),
  provider_status text not null default 'UNKNOWN' check (
    provider_status in ('UNKNOWN', 'OPEN', 'CLOSED', 'ERROR')
  ),
  calls_used smallint not null default 0 check (calls_used between 0 and 96),
  result_count smallint not null default 0 check (result_count between 0 and 95),
  safe_code text check (
    safe_code is null or safe_code in (
      'MARKET_CLOSED',
      'PROVIDER_ERROR',
      'RATE_LIMITED',
      'RESULT_COUNT_INVALID',
      'CALL_LIMIT_EXCEEDED',
      'WINDOW_CONFLICT'
    )
  ),
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  prune_after timestamptz not null default statement_timestamp()+interval '7 days',
  check (
    extract(second from window_started_at)=0
    and mod(extract(minute from window_started_at)::integer,5)=0
  ),
  check (window_id=to_char(window_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI"Z"')),
  check (prune_after>created_at and prune_after<=created_at+interval '7 days'),
  check (
    (status='PENDING' and safe_code is null and completed_at is null)
    or (status='COMPLETED' and result_count=95 and completed_at is not null and (
      (provider_status='CLOSED' and calls_used=1 and safe_code='MARKET_CLOSED')
      or (provider_status='OPEN' and calls_used=96 and safe_code is null)
    ))
    or (status='FAILED' and safe_code is not null and completed_at is not null)
  ),
  check (
    completed_at is null
    or (completed_at>=window_started_at
      and completed_at<window_started_at+interval '5 minutes')
  ),
  check (updated_at>=created_at)
);

create index market_poll_windows_five_minute_idx
  on market_poll_windows (window_started_at desc, window_id);

create index market_poll_windows_prune_idx
  on market_poll_windows (prune_after, window_id);

create function protect_market_poll_window_semantics() returns trigger
language plpgsql as $$
declare
  transitioned_at timestamptz;
begin
  if tg_op='DELETE' then
    if old.prune_after<=clock_timestamp() then return old; end if;
    raise exception 'MARKET_POLL_WINDOW_IMMUTABLE';
  end if;
  if new.window_id is distinct from old.window_id
    or new.window_started_at is distinct from old.window_started_at
    or new.provider is distinct from old.provider
    or new.created_at is distinct from old.created_at
    or new.prune_after is distinct from old.prune_after
  then
    raise exception 'MARKET_POLL_WINDOW_IMMUTABLE';
  end if;

  if new is not distinct from old then
    return new;
  end if;
  if old.status in ('COMPLETED','FAILED')
    or new.calls_used<old.calls_used
    or new.result_count<old.result_count
    or not (
      (old.status='PENDING' and new.status in (
        'PENDING','COMPLETED','FAILED'
      ))
    )
  then
    raise exception 'MARKET_POLL_WINDOW_TRANSITION_INVALID';
  end if;

  transitioned_at:=clock_timestamp();
  new.updated_at:=transitioned_at;
  if new.status='PENDING' then
    new.completed_at:=null;
  else
    new.completed_at:=transitioned_at;
  end if;
  if (new.status='COMPLETED' and not (
      new.result_count=95 and (
        (new.provider_status='CLOSED' and new.calls_used=1
          and new.safe_code='MARKET_CLOSED')
        or (new.provider_status='OPEN' and new.calls_used=96
          and new.safe_code is null)
      )
    )) or (new.status='FAILED' and new.safe_code is null)
  then
    raise exception 'MARKET_POLL_WINDOW_TRANSITION_INVALID';
  end if;
  return new;
end;
$$;

create trigger market_poll_windows_are_semantically_immutable
before update or delete on market_poll_windows
for each row execute function protect_market_poll_window_semantics();

create trigger market_poll_windows_truncate_is_immutable
before truncate on market_poll_windows
for each statement execute function reject_deployment_authority_truncate();

create function market_latest_context_digest(
  target_account_id uuid,
  target_symbol text,
  target_window_id text,
  target_provider text
) returns char(64)
language sql immutable strict as $$
  select recall_manifest_digest(jsonb_build_object(
    'accountId',target_account_id::text,
    'provider',target_provider,
    'symbol',target_symbol,
    'windowId',target_window_id
  ))::char(64);
$$;

create table market_latest_quotes (
  account_id uuid not null references accounts(id),
  symbol text not null references market_symbol_catalog(symbol),
  window_id text not null references market_poll_windows(window_id),
  provider text not null check (provider='FINNHUB'),
  status text not null check (
    status in ('SUCCESS', 'UNAVAILABLE', 'RATE_LIMITED', 'PROVIDER_ERROR')
  ),
  source_observed_at timestamptz,
  received_at timestamptz not null,
  data_key_id uuid references aggregate_data_keys(id),
  ciphertext bytea check (
    ciphertext is null or octet_length(ciphertext) between 1 and 65536
  ),
  envelope_iv bytea check (envelope_iv is null or octet_length(envelope_iv)=12),
  envelope_auth_tag bytea check (
    envelope_auth_tag is null or octet_length(envelope_auth_tag)=16
  ),
  envelope_encoding text check (
    envelope_encoding is null or envelope_encoding='canonical-json-v1'
  ),
  context_digest char(64) not null check (context_digest ~ '^[a-f0-9]{64}$'),
  safe_code text check (
    safe_code is null or safe_code in (
      'MARKET_CLOSED',
      'SYMBOL_UNAVAILABLE',
      'STALE_QUOTE',
      'RATE_LIMITED',
      'PROVIDER_ERROR',
      'MALFORMED_RESPONSE'
    )
  ),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (account_id, symbol),
  check (source_observed_at is null or received_at>=source_observed_at),
  check (
    (status='SUCCESS' and source_observed_at is not null and data_key_id is not null
      and ciphertext is not null and octet_length(ciphertext)>0
      and envelope_iv is not null and envelope_auth_tag is not null
      and envelope_encoding='canonical-json-v1'
      and safe_code is null)
    or (status<>'SUCCESS' and source_observed_at is null and data_key_id is null
      and ciphertext is null and envelope_iv is null and envelope_auth_tag is null
      and envelope_encoding is null and safe_code is not null)
  )
);

create function validate_market_latest_quote() returns trigger
language plpgsql as $$
declare
  prior_window_started_at timestamptz;
  next_window_started_at timestamptz;
begin
  if tg_op='DELETE' then
    raise exception 'MARKET_LATEST_QUOTE_IMMUTABLE';
  end if;
  if tg_op='UPDATE' and (
    new.account_id is distinct from old.account_id
    or new.symbol is distinct from old.symbol
  ) then
    raise exception 'MARKET_LATEST_QUOTE_IMMUTABLE';
  end if;
  if not exists (
    select 1 from market_symbol_catalog catalog where catalog.symbol=new.symbol
  ) then
    raise exception 'MARKET_LATEST_SYMBOL_INVALID';
  end if;
  select poll_window.window_started_at into next_window_started_at
  from market_poll_windows poll_window
  where poll_window.window_id=new.window_id and poll_window.provider=new.provider;
  if next_window_started_at is null
    or new.received_at<next_window_started_at
    or new.received_at>=next_window_started_at+interval '5 minutes'
  then
    raise exception 'MARKET_LATEST_WINDOW_INVALID';
  end if;
  if new.context_digest is distinct from market_latest_context_digest(
    new.account_id,new.symbol,new.window_id,new.provider
  ) then
    raise exception 'MARKET_LATEST_CONTEXT_INVALID';
  end if;
  if new.data_key_id is not null and not exists (
    select 1 from aggregate_data_keys data_key
    where data_key.id=new.data_key_id
      and data_key.aggregate_id='market-latest:'||new.account_id::text
  ) then
    raise exception 'MARKET_LATEST_KEY_SCOPE_INVALID';
  end if;
  if tg_op='UPDATE' and new.window_id is distinct from old.window_id then
    select poll_window.window_started_at into prior_window_started_at
    from market_poll_windows poll_window where poll_window.window_id=old.window_id;
    if next_window_started_at<=prior_window_started_at then
      raise exception 'MARKET_LATEST_STALE';
    end if;
  end if;
  return new;
end;
$$;

create trigger market_latest_quotes_validate
before insert or update or delete on market_latest_quotes
for each row execute function validate_market_latest_quote();

create trigger market_latest_quotes_truncate_is_immutable
before truncate on market_latest_quotes
for each statement execute function reject_deployment_authority_truncate();

create table deployment_quota_counters (
  quota_name text not null check (
    quota_name in ('QSTASH_MESSAGES', 'CODEX_JOBS', 'FINNHUB_CALLS')
  ),
  bucket_date date not null,
  used_count integer not null default 0 check (used_count>=0),
  limit_count integer not null check (limit_count>0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (quota_name, bucket_date),
  check (used_count<=limit_count),
  check (
    (quota_name='QSTASH_MESSAGES' and limit_count=900)
    or (quota_name='CODEX_JOBS' and limit_count=100)
    or (quota_name='FINNHUB_CALLS' and limit_count=27648)
  )
);

create index deployment_quota_counters_bucket_idx
  on deployment_quota_counters (bucket_date desc, quota_name);

create function protect_deployment_quota_counter() returns trigger
language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.bucket_date<(clock_timestamp() at time zone 'UTC')::date-7 then return old; end if;
    raise exception 'DEPLOYMENT_QUOTA_COUNTER_IMMUTABLE';
  end if;
  if new.quota_name is distinct from old.quota_name
    or new.bucket_date is distinct from old.bucket_date
    or new.limit_count is distinct from old.limit_count
    or new.used_count<old.used_count
    or new.updated_at<old.updated_at
  then
    raise exception 'DEPLOYMENT_QUOTA_COUNTER_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger deployment_quota_counters_are_bounded
before update or delete on deployment_quota_counters
for each row execute function protect_deployment_quota_counter();

create trigger deployment_quota_counters_truncate_is_immutable
before truncate on deployment_quota_counters
for each statement execute function reject_deployment_authority_truncate();
