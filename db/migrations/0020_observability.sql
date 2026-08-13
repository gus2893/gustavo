create table database_commit_metric_buckets (
  outcome text not null check (outcome in ('success','failure')),
  latency_bucket_ms integer not null check (
    latency_bucket_ms in (1,2,5,10,25,50,100,250,500,1000,2500,5000,10000,30000,60000)
  ),
  bucket_start timestamptz not null default date_trunc('minute',clock_timestamp()),
  sample_count bigint not null check (sample_count > 0),
  value_sum double precision not null check (value_sum >= 0),
  value_max double precision not null check (value_max >= 0 and value_sum >= value_max),
  observed_at timestamptz not null default clock_timestamp(),
  primary key (outcome,latency_bucket_ms,bucket_start),
  check (bucket_start=date_trunc('minute',bucket_start))
);

create index database_commit_metric_health_idx
  on database_commit_metric_buckets (bucket_start desc,outcome,latency_bucket_ms)
  include (sample_count,value_sum,value_max);

create index recall_traces_health_window_idx
  on recall_traces (created_at desc,id desc) include (latency_ms);

create index model_runs_health_window_idx
  on model_runs (started_at desc,id desc)
  include (
    role,completion_status,latency_ms,estimated_cost_microusd,
    provider_reported_cost_microusd
  );

create index transactional_outbox_active_age_idx
  on transactional_outbox (created_at,id)
  where status in ('PENDING','FAILED');

create index memory_projection_checkpoints_freshness_idx
  on memory_projection_checkpoints (updated_at desc,projection_key desc);

create index cache_rebuild_runs_verified_completed_idx
  on cache_rebuild_runs (completed_at desc,id desc)
  include (record_count,started_at)
  where status='VERIFIED' and completed_at is not null;
