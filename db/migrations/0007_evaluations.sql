create table decision_operation_idempotency (
  idempotency_key text primary key check (length(trim(idempotency_key)) between 1 and 200),
  operation text not null check (operation in (
    'WINDOW_OPEN', 'MAIN_COMMIT', 'CONTENDER_SUBMIT', 'EVALUATION_RECORD'
  )),
  aggregate_scope text not null check (length(trim(aggregate_scope)) between 1 and 300),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);

create table decision_windows (
  id uuid primary key,
  market_observation_ids jsonb not null,
  evidence_count integer not null check (evidence_count between 1 and 128),
  portfolio_snapshot_digest char(64) not null check (portfolio_snapshot_digest ~ '^[a-f0-9]{64}$'),
  cost_model_snapshot_digest char(64) not null check (cost_model_snapshot_digest ~ '^[a-f0-9]{64}$'),
  stage_profile_version text not null check (length(trim(stage_profile_version)) between 1 and 128),
  eligible_instruments jsonb not null,
  snapshot_digest char(64) not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  opened_event_id uuid not null unique references events(id),
  policy_version text not null check (length(trim(policy_version)) between 1 and 128),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null
);

alter table decision_windows add constraint decision_market_ids_canonical
  check (proposal_json_text_array_is_canonical(market_observation_ids, 128));
alter table decision_windows add constraint decision_instruments_canonical
  check (proposal_json_text_array_is_canonical(eligible_instruments, 128));

create table decision_candidates (
  window_id uuid not null references decision_windows(id),
  candidate_id text not null check (
    candidate_id='main' or candidate_id ~ '^candidate_[a-f0-9]{32}$'
  ),
  candidate_kind text not null check (candidate_kind in ('MAIN','CONTENDER')),
  account_id uuid references accounts(id),
  node_brain_id uuid,
  proposal_id uuid unique references proposals(id),
  disposition text not null check (disposition in ('THESIS','NO_PAPER_TRADE')),
  commitment_digest char(64) not null check (commitment_digest ~ '^[a-f0-9]{64}$'),
  candidate_event_id uuid not null unique references events(id),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  primary key (window_id, candidate_id),
  foreign key (node_brain_id, account_id) references node_brains(id, account_id),
  check (
    (candidate_kind='MAIN' and candidate_id='main' and account_id is null
      and node_brain_id is null and proposal_id is null)
    or
    (candidate_kind='CONTENDER' and candidate_id<>'main' and account_id is not null
      and node_brain_id is not null and proposal_id is not null and disposition='THESIS')
  )
);
create unique index decision_one_main_candidate_idx
  on decision_candidates(window_id) where candidate_kind='MAIN';

create table decision_evaluation_scores (
  window_id uuid not null,
  candidate_id text not null,
  evaluator_run_id uuid not null references model_runs(id),
  evidence_freshness integer not null check (evidence_freshness between 0 and 25),
  structural_clarity integer not null check (structural_clarity between 0 and 20),
  cost_adjusted_geometry integer not null check (cost_adjusted_geometry between 0 and 20),
  falsifiability integer not null check (falsifiability between 0 and 15),
  uncertainty integer not null check (uncertainty between 0 and 10),
  independence integer not null check (independence between 0 and 10),
  evidence_fresh boolean not null,
  session_valid boolean not null,
  geometry_complete boolean not null,
  non_duplicate boolean not null,
  authorized boolean not null,
  total_score integer not null check (total_score between 0 and 100),
  prompt_version text not null check (length(trim(prompt_version)) between 1 and 128),
  model_version text not null check (length(trim(model_version)) between 1 and 128),
  policy_version text not null check (length(trim(policy_version)) between 1 and 128),
  evaluation_event_id uuid not null references events(id),
  created_at timestamptz not null,
  primary key (window_id, candidate_id),
  foreign key (window_id, candidate_id) references decision_candidates(window_id, candidate_id),
  check (total_score = evidence_freshness + structural_clarity + cost_adjusted_geometry
    + falsifiability + uncertainty + independence)
);

create table decision_evaluation_batches (
  window_id uuid primary key references decision_windows(id),
  evaluator_run_id uuid not null references model_runs(id),
  evaluation_event_id uuid not null references events(id),
  prompt_version text not null check (length(trim(prompt_version)) between 1 and 128),
  model_version text not null check (length(trim(model_version)) between 1 and 128),
  policy_version text not null check (length(trim(policy_version)) between 1 and 128),
  created_at timestamptz not null
);

create table decision_selections (
  window_id uuid primary key references decision_windows(id),
  result text not null check (result in ('MAIN','CONTENDER','NO_PAPER_TRADE')),
  selected_candidate_id text,
  evaluator_run_id uuid not null references model_runs(id),
  rubric_version text not null check (rubric_version='rubric-v1'),
  action_threshold integer not null check (action_threshold=80),
  improvement_margin integer not null check (improvement_margin=5),
  selection_event_id uuid not null unique references events(id),
  idempotency_key text not null unique check (length(trim(idempotency_key)) between 1 and 200),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (window_id, selected_candidate_id)
    references decision_candidates(window_id, candidate_id),
  check (
    (result='NO_PAPER_TRADE' and selected_candidate_id is null)
    or (result='MAIN' and selected_candidate_id='main')
    or (result='CONTENDER' and selected_candidate_id is not null and selected_candidate_id<>'main')
  )
);

create function validate_decision_window_insert() returns trigger language plpgsql as $$
begin
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
create trigger decision_windows_validate_insert before insert on decision_windows
for each row execute function validate_decision_window_insert();

create function validate_decision_candidate_insert() returns trigger language plpgsql as $$
declare decision_window decision_windows%rowtype;
declare proposal proposals%rowtype;
declare proposal_status text;
begin
  select * into decision_window from decision_windows where id=new.window_id for update;
  if not found or exists (select 1 from decision_evaluation_batches where window_id=new.window_id)
     or exists (select 1 from decision_evaluation_scores where window_id=new.window_id)
     or exists (select 1 from decision_selections where window_id=new.window_id) then
    raise exception 'DECISION_WINDOW_CLOSED';
  end if;
  if new.candidate_kind='MAIN' then
    if exists (select 1 from decision_candidates where window_id=new.window_id)
       or not exists (
         select 1 from events event where event.id=new.candidate_event_id
           and event.aggregate_id=new.window_id::text and event.account_id is null
           and event.actor_type='MAIN_BRAIN' and event.actor_id='gustavo-main'
           and event.type='main.baseline.committed' and event.visibility='OPERATOR'
           and event.causation_id=decision_window.opened_event_id
           and event.policy_version=decision_window.policy_version
       ) then raise exception 'DECISION_MAIN_COMMITMENT_INVALID'; end if;
  else
    if not exists (
      select 1 from decision_candidates main
      where main.window_id=new.window_id and main.candidate_kind='MAIN'
    ) then raise exception 'DECISION_MAIN_COMMITMENT_REQUIRED'; end if;
    select * into proposal from proposals where id=new.proposal_id;
    select to_status into proposal_status from proposal_status_transitions
      where proposal_id=new.proposal_id order by ordinal desc limit 1;
    if not found or proposal.account_id<>new.account_id or proposal.node_brain_id<>new.node_brain_id
       or proposal_status<>'QUEUED_FOR_DECISION'
       or not exists (
         select 1 from events event where event.id=new.candidate_event_id
           and event.aggregate_id=new.window_id::text
           and event.account_id=new.account_id::text
           and event.actor_type='NODE_BRAIN' and event.actor_id=new.node_brain_id::text
           and event.type='contender.submitted' and event.visibility='PRIVATE_ACCOUNT'
           and event.causation_id=proposal.created_event_id
           and event.policy_version=decision_window.policy_version
       ) then raise exception 'DECISION_CONTENDER_INVALID'; end if;
  end if;
  return new;
end;
$$;
create trigger decision_candidates_validate_insert before insert on decision_candidates
for each row execute function validate_decision_candidate_insert();

create function validate_decision_evaluation_batch_insert() returns trigger language plpgsql as $$
declare main_event_id uuid;
begin
  perform 1 from decision_windows where id=new.window_id for update;
  if not found or exists (select 1 from decision_selections where window_id=new.window_id) then
    raise exception 'DECISION_WINDOW_CLOSED';
  end if;
  select candidate_event_id into main_event_id from decision_candidates
    where window_id=new.window_id and candidate_kind='MAIN';
  if main_event_id is null or not exists (
    select 1 from model_runs run where run.id=new.evaluator_run_id
      and run.role='EVALUATOR' and run.completion_status='COMPLETED'
      and run.causation_id=main_event_id
      and run.prompt_version=new.prompt_version
      and run.model=new.model_version
      and run.policy_version=new.policy_version
  ) or not exists (
    select 1 from events event where event.id=new.evaluation_event_id
      and event.aggregate_id=new.window_id::text and event.account_id is null
      and event.actor_type='EVALUATOR' and event.actor_id=new.evaluator_run_id::text
      and event.type='evaluation.scored' and event.visibility='OPERATOR'
      and event.causation_id=main_event_id
      and event.prompt_version=new.prompt_version
      and event.model_version=new.model_version
      and event.policy_version=new.policy_version
  ) then raise exception 'DECISION_EVALUATION_PROVENANCE_INVALID'; end if;
  return new;
end;
$$;
create trigger decision_evaluation_batches_validate_insert
before insert on decision_evaluation_batches
for each row execute function validate_decision_evaluation_batch_insert();

create function validate_decision_score_insert() returns trigger language plpgsql as $$
declare main_event_id uuid;
declare evaluation_batch decision_evaluation_batches%rowtype;
begin
  perform 1 from decision_windows where id=new.window_id for update;
  if not found or exists (select 1 from decision_selections where window_id=new.window_id) then
    raise exception 'DECISION_WINDOW_CLOSED';
  end if;
  if exists (
    select 1 from decision_evaluation_scores existing
      where existing.window_id=new.window_id
        and (
          existing.evaluator_run_id<>new.evaluator_run_id
          or existing.evaluation_event_id<>new.evaluation_event_id
        )
  ) then raise exception 'DECISION_EVALUATION_PROVENANCE_INVALID'; end if;
  select candidate_event_id into main_event_id from decision_candidates
    where window_id=new.window_id and candidate_kind='MAIN';
  if main_event_id is null or not exists (
    select 1 from model_runs run where run.id=new.evaluator_run_id
      and run.role='EVALUATOR' and run.completion_status='COMPLETED'
      and run.causation_id=main_event_id
      and run.prompt_version=new.prompt_version
      and run.model=new.model_version
      and run.policy_version=new.policy_version
  ) or not exists (
    select 1 from events event where event.id=new.evaluation_event_id
      and event.aggregate_id=new.window_id::text and event.account_id is null
      and event.actor_type='EVALUATOR' and event.actor_id=new.evaluator_run_id::text
      and event.type='evaluation.scored' and event.visibility='OPERATOR'
      and event.causation_id=main_event_id
      and event.prompt_version=new.prompt_version
      and event.model_version=new.model_version
      and event.policy_version=new.policy_version
  ) then raise exception 'DECISION_EVALUATION_PROVENANCE_INVALID'; end if;
  insert into decision_evaluation_batches (
    window_id, evaluator_run_id, evaluation_event_id,
    prompt_version, model_version, policy_version, created_at
  ) values (
    new.window_id, new.evaluator_run_id, new.evaluation_event_id,
    new.prompt_version, new.model_version, new.policy_version, new.created_at
  )
  on conflict (window_id) do update
    set evaluator_run_id=decision_evaluation_batches.evaluator_run_id
  returning * into evaluation_batch;
  if evaluation_batch.evaluator_run_id<>new.evaluator_run_id
     or evaluation_batch.evaluation_event_id<>new.evaluation_event_id
     or evaluation_batch.prompt_version<>new.prompt_version
     or evaluation_batch.model_version<>new.model_version
     or evaluation_batch.policy_version<>new.policy_version
  then raise exception 'DECISION_EVALUATION_PROVENANCE_INVALID'; end if;
  return new;
end;
$$;
create trigger decision_scores_validate_insert before insert on decision_evaluation_scores
for each row execute function validate_decision_score_insert();

create function validate_decision_selection_insert() returns trigger language plpgsql as $$
declare candidate_count integer;
declare score_count integer;
declare main_score decision_evaluation_scores%rowtype;
declare main_disposition text;
declare best_contender_id text;
declare expected_result text;
declare expected_candidate_id text;
begin
  perform 1 from decision_windows where id=new.window_id for update;
  if not found or exists (select 1 from decision_selections where window_id=new.window_id) then
    raise exception 'DECISION_WINDOW_CLOSED';
  end if;
  select count(*) into candidate_count from decision_candidates where window_id=new.window_id;
  select count(*) into score_count from decision_evaluation_scores where window_id=new.window_id;
  if candidate_count=0 or score_count<>candidate_count then
    raise exception 'DECISION_EVALUATION_INCOMPLETE';
  end if;
  select * into main_score from decision_evaluation_scores
    where window_id=new.window_id and candidate_id='main';
  select disposition into main_disposition from decision_candidates
    where window_id=new.window_id and candidate_id='main';
  select score.candidate_id into best_contender_id
    from decision_evaluation_scores score
    where score.window_id=new.window_id and score.candidate_id<>'main'
      and score.evidence_fresh and score.session_valid and score.geometry_complete
      and score.non_duplicate and score.authorized
      and score.total_score>=80 and score.total_score>=main_score.total_score+5
    order by score.total_score desc, score.candidate_id asc limit 1;
  if best_contender_id is not null then
    expected_result := 'CONTENDER'; expected_candidate_id := best_contender_id;
  elsif main_disposition='THESIS'
        and main_score.evidence_fresh and main_score.session_valid and main_score.geometry_complete
        and main_score.non_duplicate and main_score.authorized and main_score.total_score>=80 then
    expected_result := 'MAIN'; expected_candidate_id := 'main';
  else
    expected_result := 'NO_PAPER_TRADE'; expected_candidate_id := null;
  end if;
  if new.result<>expected_result or new.selected_candidate_id is distinct from expected_candidate_id
     or new.evaluator_run_id<>main_score.evaluator_run_id
     or not exists (
       select 1 from events event where event.id=new.selection_event_id
         and event.aggregate_id=new.window_id::text and event.account_id is null
         and event.actor_type='SYSTEM' and event.actor_id='gustavo-decision-orchestrator'
         and event.type='decision.selected' and event.visibility='OPERATOR'
         and event.causation_id=main_score.evaluation_event_id
         and event.policy_version='decision-window-policy-v1'
     ) then raise exception 'DECISION_SELECTION_INVALID'; end if;
  return new;
end;
$$;
create trigger decision_selections_validate_insert before insert on decision_selections
for each row execute function validate_decision_selection_insert();

create function reject_decision_window_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_DECISION_WINDOW'; end; $$;
create trigger decision_windows_immutable before update or delete on decision_windows
for each row execute function reject_decision_window_mutation();

create function reject_decision_candidate_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_DECISION_CANDIDATE'; end; $$;
create trigger decision_candidates_immutable before update or delete on decision_candidates
for each row execute function reject_decision_candidate_mutation();

create function reject_decision_score_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_DECISION_SCORE'; end; $$;
create trigger decision_scores_immutable before update or delete on decision_evaluation_scores
for each row execute function reject_decision_score_mutation();

create function reject_decision_batch_mutation() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or new is distinct from old then
    raise exception 'IMMUTABLE_DECISION_EVALUATION_BATCH';
  end if;
  return new;
end; $$;
create trigger decision_evaluation_batches_immutable
before update or delete on decision_evaluation_batches
for each row execute function reject_decision_batch_mutation();

create function reject_decision_selection_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_DECISION_SELECTION'; end; $$;
create trigger decision_selections_immutable before update or delete on decision_selections
for each row execute function reject_decision_selection_mutation();

create function reject_decision_idempotency_mutation() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE_DECISION_IDEMPOTENCY'; end; $$;
create trigger decision_operation_idempotency_immutable
before update or delete on decision_operation_idempotency
for each row execute function reject_decision_idempotency_mutation();
