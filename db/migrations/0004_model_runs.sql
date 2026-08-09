create table model_budget_usage (
  role text not null check (role in ('MAIN', 'NODE', 'EVALUATOR')),
  budget_month date not null,
  committed_cost_microusd bigint not null default 0
    check (committed_cost_microusd >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (role, budget_month),
  check (budget_month = date_trunc('month', budget_month)::date)
);

create table model_runs (
  id uuid primary key,
  role text not null check (role in ('MAIN', 'NODE', 'EVALUATOR')),
  provider text not null check (length(trim(provider)) between 1 and 128),
  model text not null check (length(trim(model)) between 1 and 128),
  prompt_version text not null check (length(trim(prompt_version)) between 1 and 128),
  policy_version text not null check (length(trim(policy_version)) between 1 and 128),
  correlation_id uuid not null,
  causation_id uuid,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  provider_reported_input_tokens numeric(100,0),
  provider_reported_output_tokens numeric(100,0),
  provider_reported_cost_microusd numeric(100,0),
  max_input_tokens integer not null check (max_input_tokens > 0),
  max_output_tokens integer not null check (max_output_tokens > 0),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  estimated_cost_microusd bigint not null default 0
    check (estimated_cost_microusd >= 0),
  budget_accounted_cost_microusd bigint not null default 0
    check (budget_accounted_cost_microusd >= 0),
  reserved_cost_microusd bigint not null default 0
    check (reserved_cost_microusd >= 0),
  completion_status text not null check (
    completion_status in (
      'IN_PROGRESS',
      'COMPLETED',
      'FAILED',
      'ABORTED',
      'BUDGET_REJECTED',
      'TOKEN_REJECTED'
    )
  ),
  error_code text check (
    error_code is null or length(trim(error_code)) between 1 and 128
  ),
  streamed boolean not null default false,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check (
    (completion_status = 'IN_PROGRESS' and completed_at is null and error_code is null)
    or
    (completion_status = 'COMPLETED' and completed_at is not null and error_code is null)
    or
    (completion_status not in ('IN_PROGRESS', 'COMPLETED')
      and completed_at is not null
      and error_code is not null)
  ),
  check (
    provider_reported_input_tokens is null
      or provider_reported_input_tokens >= 0
  ),
  check (
    provider_reported_output_tokens is null
      or provider_reported_output_tokens >= 0
  ),
  check (
    provider_reported_cost_microusd is null
      or provider_reported_cost_microusd >= 0
  )
);

create index model_runs_role_started_idx
  on model_runs (role, started_at desc, id);

create index model_runs_correlation_idx
  on model_runs (correlation_id, id);
