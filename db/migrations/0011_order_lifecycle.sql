alter table challenge_orders
  add constraint challenge_orders_one_order_per_intent unique (intent_id);

create function challenge_order_cost_fill(target_side text, reference_price numeric)
returns numeric language sql immutable strict as $$
  select round(case target_side
    when 'BUY' then reference_price*1.00100025
    when 'SELL' then reference_price*0.99900025
  end, 2)
$$;

create function challenge_order_commission(target_quantity numeric)
returns numeric language sql immutable strict as $$
  select greatest(1.00, round(target_quantity*0.005, 2))
$$;

create function challenge_order_expected_quantity(
  target_direction text,
  target_entry numeric,
  target_stop numeric,
  target_risk numeric
) returns numeric language plpgsql immutable strict as $$
declare entry_fill numeric;
declare stop_fill numeric;
declare loss_per_unit numeric;
declare low_quantity numeric := 0;
declare high_quantity numeric;
declare midpoint numeric;
begin
  entry_fill := challenge_order_cost_fill(
    case target_direction when 'PAPER_LONG' then 'BUY' else 'SELL' end,
    target_entry
  );
  stop_fill := challenge_order_cost_fill(
    case target_direction when 'PAPER_LONG' then 'SELL' else 'BUY' end,
    target_stop
  );
  loss_per_unit := case target_direction
    when 'PAPER_LONG' then entry_fill-stop_fill else stop_fill-entry_fill end;
  if loss_per_unit<=0 then return null; end if;
  high_quantity := target_risk/loss_per_unit;
  for iteration in 1..128 loop
    midpoint := (low_quantity+high_quantity)/2;
    if loss_per_unit*trunc(midpoint,8)
         +2*challenge_order_commission(trunc(midpoint,8))<=target_risk
      then low_quantity := midpoint;
      else high_quantity := midpoint;
    end if;
  end loop;
  return trunc(low_quantity,8);
end;
$$;

create function challenge_order_replay_projection(
  target_stage_id uuid,
  target_high_water_sequence bigint,
  target_before timestamptz default null
) returns jsonb language plpgsql stable as $$
declare ledger_event challenge_ledger_events%rowtype;
declare positions jsonb := '{}'::jsonb;
declare position_state jsonb;
declare position_key text;
declare event_quantity numeric;
declare event_price numeric;
declare prior_quantity numeric;
declare prior_average numeric;
declare close_quantity numeric;
declare balance numeric := 0;
declare starting_balance numeric := 0;
declare unrealized numeric := 0;
declare state_entry record;
begin
  for ledger_event in
    select * from challenge_ledger_events
     where stage_id=target_stage_id and sequence<=target_high_water_sequence
       and (target_before is null or occurred_at<target_before)
     order by sequence
  loop
    case ledger_event.type
      when 'stage.started' then
        starting_balance := (ledger_event.payload->>'amount')::numeric;
        balance := starting_balance;
      when 'paper.fill.created' then
        position_key := ledger_event.payload->>'positionId';
        event_quantity := (ledger_event.payload->>'quantity')::numeric;
        event_price := (ledger_event.payload->>'price')::numeric;
        position_state := positions->position_key;
        if position_state is null then
          position_state := jsonb_build_object(
            'side',ledger_event.payload->>'side','quantity',event_quantity,
            'average',event_price,'mark',event_price
          );
        else
          prior_quantity := (position_state->>'quantity')::numeric;
          prior_average := (position_state->>'average')::numeric;
          position_state := jsonb_set(position_state,'{quantity}',to_jsonb(prior_quantity+event_quantity));
          position_state := jsonb_set(position_state,'{average}',
            to_jsonb((prior_average*prior_quantity+event_price*event_quantity)
              /(prior_quantity+event_quantity)));
          position_state := jsonb_set(position_state,'{mark}',to_jsonb(event_price));
        end if;
        positions := jsonb_set(positions,array[position_key],position_state,true);
        balance := balance-coalesce((ledger_event.payload->>'commission')::numeric,0);
      when 'price.mark.recorded' then
        position_key := ledger_event.payload->>'positionId';
        position_state := positions->position_key;
        if position_state is not null then
          positions := jsonb_set(positions,array[position_key,'mark'],
            to_jsonb((ledger_event.payload->>'price')::numeric),true);
        end if;
      when 'paper.position.closed' then
        position_key := ledger_event.payload->>'positionId';
        position_state := positions->position_key;
        if position_state is not null then
          prior_quantity := (position_state->>'quantity')::numeric;
          prior_average := (position_state->>'average')::numeric;
          event_price := (ledger_event.payload->>'price')::numeric;
          close_quantity := case when jsonb_typeof(ledger_event.payload->'quantity')='number'
            or jsonb_typeof(ledger_event.payload->'quantity')='string'
            then (ledger_event.payload->>'quantity')::numeric else prior_quantity end;
          balance := balance + (case position_state->>'side'
            when 'BUY' then (event_price-prior_average)*close_quantity
            else (prior_average-event_price)*close_quantity end)
            -coalesce((ledger_event.payload->>'commission')::numeric,0);
          if close_quantity>=prior_quantity then
            positions := positions-position_key;
          else
            position_state := jsonb_set(position_state,'{quantity}',
              to_jsonb(prior_quantity-close_quantity));
            position_state := jsonb_set(position_state,'{mark}',to_jsonb(event_price));
            positions := jsonb_set(positions,array[position_key],position_state,true);
          end if;
        end if;
      when 'fee.recorded' then
        balance := balance-(ledger_event.payload->>'amount')::numeric;
      when 'financing.recorded' then
        balance := balance-(ledger_event.payload->>'amount')::numeric;
      else null;
    end case;
  end loop;
  for state_entry in select value from jsonb_each(positions) loop
    position_state := state_entry.value;
    unrealized := unrealized + case position_state->>'side'
      when 'BUY' then ((position_state->>'mark')::numeric-(position_state->>'average')::numeric)
        *(position_state->>'quantity')::numeric
      else ((position_state->>'average')::numeric-(position_state->>'mark')::numeric)
        *(position_state->>'quantity')::numeric end;
  end loop;
  return jsonb_build_object(
    'startingBalance',round(starting_balance,2),
    'balance',round(balance,2),
    'equity',round(balance+unrealized,2)
  );
end;
$$;

create function validate_challenge_order_accepted_risk() returns trigger
language plpgsql as $$
declare order_event challenge_ledger_events%rowtype;
declare accepted_evaluation challenge_rule_evaluations%rowtype;
declare evaluation_event challenge_ledger_events%rowtype;
declare intent_row challenge_intents%rowtype;
declare high_water challenge_ledger_events%rowtype;
declare provenance jsonb;
declare geometry jsonb;
declare risk_snapshot jsonb;
declare current_projection jsonb;
declare day_projection jsonb;
declare current_balance numeric;
declare current_equity numeric;
declare day_start_balance numeric;
declare day_start_equity numeric;
declare realized_day_loss numeric;
declare existing_stop_risk numeric := 0;
declare existing_open_loss numeric := 0;
declare existing_gross_notional numeric := 0;
declare proposed_stop_risk numeric;
declare proposed_notional numeric;
declare entry_commission numeric;
declare post_entry_equity numeric;
declare expected_quantity numeric;
declare entry_fill numeric;
declare stop_fill numeric;
declare loss_per_unit numeric;
declare pending_open_count integer := 0;
declare symbol_already_active boolean := false;
declare day_start_at timestamptz;
declare active_order record;
declare remaining_quantity numeric;
declare remaining_move numeric;
begin
  select * into order_event from challenge_ledger_events where id=new.ledger_event_id;
  select evaluation.* into accepted_evaluation
    from challenge_rule_evaluations evaluation
   where evaluation.ledger_event_id=order_event.causation_id
     and evaluation.intent_id=new.intent_id
     and evaluation.stage_id=new.stage_id
     and evaluation.profile_version_id=new.profile_version_id
     and evaluation.accepted;
  select * into evaluation_event from challenge_ledger_events
   where id=accepted_evaluation.ledger_event_id;
  select * into intent_row from challenge_intents where id=new.intent_id;
  select * into high_water from challenge_ledger_events
   where id=accepted_evaluation.evaluated_ledger_high_water_id;
  provenance := evaluation_event.payload->'decisionProvenance';
  geometry := provenance->'selectedGeometry';
  risk_snapshot := evaluation_event.payload->'riskSnapshot';
  if jsonb_typeof(provenance) is distinct from 'object'
     or jsonb_typeof(geometry) is distinct from 'object' then
    raise exception 'CHALLENGE_ORDER_DECISION_PROVENANCE_REQUIRED';
  end if;
  if not exists (
       select 1
         from decision_windows decision_window
         join decision_selections selection on selection.window_id=decision_window.id
         join decision_candidates candidate
           on candidate.window_id=decision_window.id
          and candidate.candidate_id=selection.selected_candidate_id
         join decision_evaluation_scores score
           on score.window_id=decision_window.id
          and score.candidate_id=selection.selected_candidate_id
        where cast(decision_window.id as text) is not distinct from provenance->>'decisionWindowId'
          and cast(decision_window.stage_profile_version as text)
              is not distinct from cast(new.profile_version_id as text)
          and selection.result<>'NO_PAPER_TRADE'
          and cast(selection.selection_event_id as text)
              is not distinct from provenance->>'selectionEventId'
          and selection.selected_candidate_id is not distinct from provenance->>'selectedCandidateId'
          and cast(selection.evaluator_run_id as text)
              is not distinct from provenance->>'evaluatorRunId'
          and cast(candidate.candidate_event_id as text)
              is not distinct from provenance->>'selectedCandidateEventId'
          and candidate.commitment_digest is not distinct from
              provenance->>'selectedCandidateCommitmentDigest'
          and score.evaluator_run_id=selection.evaluator_run_id
          and score.total_score>=selection.action_threshold
          and score.evidence_fresh and score.session_valid and score.geometry_complete
          and score.non_duplicate and score.authorized
          and decision_window.market_observation_ids is not distinct from
              provenance->'marketObservationIds'
          and jsonb_exists(decision_window.market_observation_ids,
              provenance->>'marketObservationId')
     )
     or geometry->>'symbol' is distinct from intent_row.symbol
     or geometry->>'direction' is distinct from
        (case intent_row.direction when 'PAPER_LONG' then 'LONG' else 'SHORT' end)
     or geometry->>'entry' is distinct from intent_row.entry_price
     or geometry->>'stop' is distinct from intent_row.stop_price
     or geometry->>'target' is distinct from intent_row.target_price
     or geometry->>'desiredRisk' is distinct from intent_row.desired_risk
     or (geometry->>'expiresAt')::timestamptz is distinct from intent_row.expires_at then
    raise exception 'CHALLENGE_ORDER_DECISION_PROVENANCE_REQUIRED';
  end if;

  if jsonb_typeof(risk_snapshot) is distinct from 'object'
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'startingBalance',false)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'currentEquity',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'dayStartEquity',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'realizedDayLoss',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'openLoss',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'existingStopRisk',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'proposedStopRisk',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'existingGrossNotional',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'proposedNotional',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'entryCommission',true)
     or not challenge_ledger_decimal_is_valid(risk_snapshot->>'postEntryEquity',true)
     or jsonb_typeof(risk_snapshot->'pendingOpenCount') is distinct from 'number'
     or jsonb_typeof(risk_snapshot->'symbolAlreadyActive') is distinct from 'boolean' then
    raise exception 'CHALLENGE_ORDER_RISK_SNAPSHOT_INVALID';
  end if;

  current_projection := challenge_order_replay_projection(
    new.stage_id, high_water.sequence, null
  );
  current_balance := (current_projection->>'balance')::numeric;
  current_equity := (current_projection->>'equity')::numeric;
  day_start_at := date_trunc('day',accepted_evaluation.evaluated_at at time zone 'UTC')
    at time zone 'UTC';
  day_projection := challenge_order_replay_projection(
    new.stage_id, high_water.sequence, day_start_at
  );
  if (day_projection->>'startingBalance')::numeric=0 then
    day_start_balance := (current_projection->>'startingBalance')::numeric;
    day_start_equity := day_start_balance;
  else
    day_start_balance := (day_projection->>'balance')::numeric;
    day_start_equity := (day_projection->>'equity')::numeric;
  end if;
  realized_day_loss := greatest(day_start_balance-current_balance,0);

  for active_order in
    select paper_order.id, paper_order.symbol, paper_order.quantity::numeric as quantity,
           paper_order.side, intent.entry_price::numeric as entry_price,
           intent.stop_price::numeric as stop_price,
           coalesce(fill.total_quantity,0) as filled_quantity,
           coalesce(closure.total_quantity,0) as closed_quantity,
           fill.average_price, fill.position_id, mark.price as mark_price,
           exists (
             select 1 from challenge_ledger_events cancelled
              where cancelled.stage_id=paper_order.stage_id
                and cancelled.sequence<=high_water.sequence
                and cancelled.type='paper.order.cancelled'
                and cancelled.payload->>'orderId'=paper_order.id::text
           ) as cancelled
      from challenge_orders paper_order
      join challenge_intents intent on intent.id=paper_order.intent_id
      join challenge_ledger_events paper_order_event on paper_order_event.id=paper_order.ledger_event_id
      left join lateral (
        select sum(fill_row.quantity::numeric) as total_quantity,
               sum(fill_row.quantity::numeric*fill_row.price::numeric)
                 /sum(fill_row.quantity::numeric) as average_price,
               min(fill_row.position_id::text)::uuid as position_id
          from challenge_fills fill_row
          join challenge_ledger_events fill_event on fill_event.id=fill_row.ledger_event_id
         where fill_row.order_id=paper_order.id and fill_event.sequence<=high_water.sequence
      ) fill on true
      left join lateral (
        select mark_row.price::numeric as price
          from challenge_price_marks mark_row
          join challenge_ledger_events mark_event on mark_event.id=mark_row.ledger_event_id
         where mark_row.position_id=fill.position_id and mark_event.sequence<=high_water.sequence
         order by mark_row.observed_at desc, mark_row.id desc limit 1
      ) mark on true
      left join lateral (
        select sum(coalesce(closure_row.quantity::numeric,filled.position_quantity))
                 as total_quantity
          from challenge_position_closures closure_row
          join challenge_ledger_events closure_event on closure_event.id=closure_row.ledger_event_id
          join (
            select fill_row.position_id,sum(fill_row.quantity::numeric) as position_quantity
              from challenge_fills fill_row
              join challenge_ledger_events fill_event on fill_event.id=fill_row.ledger_event_id
             where fill_row.order_id=paper_order.id and fill_event.sequence<=high_water.sequence
             group by fill_row.position_id
          ) filled on filled.position_id=closure_row.position_id
         where closure_event.sequence<=high_water.sequence
      ) closure on true
     where paper_order.stage_id=new.stage_id and paper_order_event.sequence<=high_water.sequence
  loop
    if active_order.filled_quantity=0 and not active_order.cancelled then
      pending_open_count := pending_open_count+1;
      symbol_already_active := symbol_already_active or active_order.symbol=intent_row.symbol;
      entry_fill := challenge_order_cost_fill(active_order.side,active_order.entry_price);
      stop_fill := challenge_order_cost_fill(
        case active_order.side when 'BUY' then 'SELL' else 'BUY' end,
        active_order.stop_price
      );
      loss_per_unit := case active_order.side when 'BUY' then entry_fill-stop_fill
        else stop_fill-entry_fill end;
      existing_stop_risk := existing_stop_risk
        +loss_per_unit*active_order.quantity
        +2*challenge_order_commission(active_order.quantity);
      existing_gross_notional := existing_gross_notional+entry_fill*active_order.quantity;
    elsif active_order.filled_quantity>active_order.closed_quantity then
      if active_order.mark_price is null then
        raise exception 'CHALLENGE_ORDER_RISK_SNAPSHOT_INVALID';
      end if;
      pending_open_count := pending_open_count+1;
      symbol_already_active := symbol_already_active or active_order.symbol=intent_row.symbol;
      remaining_quantity := active_order.filled_quantity-active_order.closed_quantity;
      stop_fill := challenge_order_cost_fill(
        case active_order.side when 'BUY' then 'SELL' else 'BUY' end,
        active_order.stop_price
      );
      remaining_move := greatest(case active_order.side when 'BUY'
        then active_order.mark_price-stop_fill else stop_fill-active_order.mark_price end,0);
      existing_stop_risk := existing_stop_risk+remaining_move*remaining_quantity
        +challenge_order_commission(remaining_quantity);
      existing_open_loss := existing_open_loss+greatest(case active_order.side when 'BUY'
        then (active_order.average_price-active_order.mark_price)*remaining_quantity
        else (active_order.mark_price-active_order.average_price)*remaining_quantity end,0);
      existing_gross_notional := existing_gross_notional
        +active_order.mark_price*remaining_quantity;
    end if;
  end loop;

  expected_quantity := challenge_order_expected_quantity(
    intent_row.direction,intent_row.entry_price::numeric,intent_row.stop_price::numeric,
    intent_row.desired_risk::numeric
  );
  entry_fill := challenge_order_cost_fill(new.side,intent_row.entry_price::numeric);
  stop_fill := challenge_order_cost_fill(case new.side when 'BUY' then 'SELL' else 'BUY' end,
    intent_row.stop_price::numeric);
  loss_per_unit := case new.side when 'BUY' then entry_fill-stop_fill
    else stop_fill-entry_fill end;
  entry_commission := challenge_order_commission(expected_quantity);
  proposed_stop_risk := trunc(loss_per_unit*expected_quantity+2*entry_commission,8);
  proposed_notional := trunc(entry_fill*expected_quantity,8);
  post_entry_equity := trunc(current_equity-entry_commission,8);

  if expected_quantity is null or expected_quantity<=0 or new.quantity::numeric<>expected_quantity
     or (risk_snapshot->>'startingBalance')::numeric
        <>(current_projection->>'startingBalance')::numeric
     or (risk_snapshot->>'currentEquity')::numeric<>current_equity
     or (risk_snapshot->>'dayStartEquity')::numeric<>day_start_equity
     or (risk_snapshot->>'realizedDayLoss')::numeric<>trunc(realized_day_loss,8)
     or (risk_snapshot->>'openLoss')::numeric<>trunc(existing_open_loss,8)
     or (risk_snapshot->>'existingStopRisk')::numeric<>trunc(existing_stop_risk,8)
     or (risk_snapshot->>'proposedStopRisk')::numeric<>proposed_stop_risk
     or (risk_snapshot->>'existingGrossNotional')::numeric<>trunc(existing_gross_notional,8)
     or (risk_snapshot->>'proposedNotional')::numeric<>proposed_notional
     or (risk_snapshot->>'entryCommission')::numeric<>entry_commission
     or (risk_snapshot->>'postEntryEquity')::numeric<>post_entry_equity
     or (risk_snapshot->>'pendingOpenCount')::integer<>pending_open_count
     or (risk_snapshot->>'symbolAlreadyActive')::boolean<>symbol_already_active
     or greatest(day_start_equity-current_equity,0)
        >=(current_projection->>'startingBalance')::numeric*0.04
     or current_equity<=(current_projection->>'startingBalance')::numeric*0.94
     or proposed_stop_risk>(current_projection->>'startingBalance')::numeric*0.01
     or realized_day_loss+existing_open_loss+existing_stop_risk+proposed_stop_risk
        >(current_projection->>'startingBalance')::numeric*0.03
     or existing_gross_notional+proposed_notional>post_entry_equity
     or pending_open_count>=3 or symbol_already_active then
    raise exception 'CHALLENGE_ORDER_RISK_SNAPSHOT_INVALID';
  end if;
  if accepted_evaluation.id is null
     or order_event.type<>'paper.order.created'
     or order_event.sequence <= (
       select sequence from challenge_ledger_events where id=accepted_evaluation.ledger_event_id
     )
     or order_event.payload->>'acceptedRiskEvaluationId'
        is distinct from accepted_evaluation.id::text
     or evaluation_event.type<>'rule.evaluated'
     or evaluation_event.actor_type<>'SYSTEM'
     or evaluation_event.actor_id<>'challenge-risk-v1'
     or evaluation_event.causation_id is distinct from intent_row.ledger_event_id
     or evaluation_event.correlation_id is distinct from intent_row.ledger_event_id
     or evaluation_event.payload->>'riskPolicyVersion'<>'challenge-risk-v1'
     or evaluation_event.payload->>'evaluationId' is distinct from accepted_evaluation.id::text
     or evaluation_event.payload->>'intentId' is distinct from intent_row.id::text
     or evaluation_event.payload->>'evaluatedLedgerHighWaterId'
        is distinct from high_water.id::text
     or high_water.stage_id is distinct from new.stage_id
     or high_water.profile_version_id is distinct from new.profile_version_id
     or high_water.sequence >= (select sequence from challenge_ledger_events where id=intent_row.ledger_event_id)
     or evaluation_event.payload->'riskSnapshot'->>'actorType'<>'MAIN_BRAIN'
     or evaluation_event.payload->'riskSnapshot'->>'profileVersionId'
        is distinct from new.profile_version_id::text
     or evaluation_event.payload->'riskSnapshot'->>'ledgerHighWaterId'
        is distinct from high_water.id::text
     or jsonb_typeof(provenance)<>'object'
     or jsonb_typeof(geometry)<>'object'
     or not exists (
       select 1
         from decision_windows decision_window
         join decision_selections selection on selection.window_id=decision_window.id
         join decision_candidates candidate
           on candidate.window_id=decision_window.id
          and candidate.candidate_id=selection.selected_candidate_id
         join decision_evaluation_scores score
           on score.window_id=decision_window.id
          and score.candidate_id=selection.selected_candidate_id
        where provenance->>'decisionWindowId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and cast(decision_window.id as text)=cast(provenance->>'decisionWindowId' as text)
          and cast(decision_window.stage_profile_version as text)=cast(new.profile_version_id as text)
          and selection.result<>'NO_PAPER_TRADE'
          and provenance->>'selectionEventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and cast(selection.selection_event_id as text)=cast(provenance->>'selectionEventId' as text)
          and selection.selected_candidate_id=provenance->>'selectedCandidateId'
          and provenance->>'evaluatorRunId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and cast(selection.evaluator_run_id as text)=cast(provenance->>'evaluatorRunId' as text)
          and provenance->>'selectedCandidateEventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and cast(candidate.candidate_event_id as text)=cast(provenance->>'selectedCandidateEventId' as text)
          and candidate.commitment_digest=provenance->>'selectedCandidateCommitmentDigest'
          and score.evaluator_run_id=selection.evaluator_run_id
          and score.total_score>=selection.action_threshold
          and score.evidence_fresh and score.session_valid and score.geometry_complete
          and score.non_duplicate and score.authorized
          and decision_window.market_observation_ids=provenance->'marketObservationIds'
          and jsonb_exists(
            decision_window.market_observation_ids,
            provenance->>'marketObservationId'
          )
     )
     or intent_row.ledger_event_id is null
     or (select payload->>'sourceDecisionId' from challenge_ledger_events
          where id=intent_row.ledger_event_id) is distinct from provenance->>'decisionWindowId'
     or (select payload->>'selectionEventId' from challenge_ledger_events
          where id=intent_row.ledger_event_id) is distinct from provenance->>'selectionEventId'
     or (select payload->>'marketObservationId' from challenge_ledger_events
          where id=intent_row.ledger_event_id) is distinct from provenance->>'marketObservationId'
     or geometry->>'symbol' is distinct from intent_row.symbol
     or geometry->>'direction' is distinct from
        (case intent_row.direction when 'PAPER_LONG' then 'LONG' else 'SHORT' end)
     or geometry->>'entry' is distinct from intent_row.entry_price
     or geometry->>'stop' is distinct from intent_row.stop_price
     or geometry->>'target' is distinct from intent_row.target_price
     or geometry->>'desiredRisk' is distinct from intent_row.desired_risk
     or (geometry->>'expiresAt')::timestamptz is distinct from intent_row.expires_at then
    raise exception 'CHALLENGE_ORDER_ACCEPTED_RISK_REQUIRED';
  end if;
  return null;
end;
$$;

create constraint trigger challenge_orders_require_accepted_risk
after insert on challenge_orders deferrable initially deferred
for each row execute function validate_challenge_order_accepted_risk();

create table challenge_order_jobs (
  id uuid primary key,
  order_id uuid not null references challenge_orders(id),
  market_observation_id uuid not null references market_observations(id),
  operation_key char(64) not null unique check (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) not null check (request_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('LEASED','COMPLETED')),
  lease_owner text not null check (length(trim(lease_owner)) between 1 and 128),
  leased_until timestamptz not null,
  attempts integer not null check (attempts > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (order_id, market_observation_id)
);

create index challenge_order_jobs_reclaim_idx
  on challenge_order_jobs(status, leased_until) where status='LEASED';

create table challenge_order_job_results (
  job_id uuid primary key references challenge_order_jobs(id),
  order_id uuid not null references challenge_orders(id),
  market_observation_id uuid not null references market_observations(id),
  result jsonb not null check (jsonb_typeof(result)='object'),
  completed_high_water_event_id uuid not null references challenge_ledger_events(id),
  completed_at timestamptz not null,
  unique (order_id, market_observation_id)
);

create function validate_challenge_order_job_result() returns trigger
language plpgsql as $$
declare job challenge_order_jobs%rowtype;
declare opening challenge_fills%rowtype;
declare closing challenge_position_closures%rowtype;
declare close_reason text;
declare result_status text;
declare entry_commission text;
declare exit_commission text;
begin
  select * into job from challenge_order_jobs where id=new.job_id;
  result_status := new.result->>'status';
  if job.id is null
     or job.order_id is distinct from new.order_id
     or job.market_observation_id is distinct from new.market_observation_id
     or jsonb_typeof(new.result)<>'object'
     or (select count(*) from jsonb_object_keys(new.result))<>6
     or not (new.result ?& array['status','orderId','positionId','fillPrice','commission','exitReason'])
     or new.result->>'orderId' is distinct from new.order_id::text
     or result_status not in ('PENDING','OPEN','CLOSED','CANCELLED')
     or not exists (
       select 1 from challenge_ledger_events high_water
       join challenge_orders paper_order on paper_order.id=new.order_id
       join challenge_ledger_events order_event on order_event.id=paper_order.ledger_event_id
        where high_water.id=new.completed_high_water_event_id
          and high_water.stage_id=paper_order.stage_id
          and high_water.profile_version_id=paper_order.profile_version_id
          and high_water.sequence>=order_event.sequence
     ) then
    raise exception 'CHALLENGE_ORDER_JOB_RESULT_INVALID';
  end if;

  select * into opening from challenge_fills where order_id=new.order_id;
  if opening.id is not null then
    select fee.amount into entry_commission
      from challenge_fees fee
      join challenge_ledger_events event on event.id=fee.ledger_event_id
     where fee.order_id=new.order_id and fee.position_id=opening.position_id
       and fee.category='COMMISSION' and event.payload->>'phase'='ENTRY';
    select closure.* into closing
      from challenge_position_closures closure
     where closure.position_id=opening.position_id;
    if closing.id is not null then
      select payload->>'exitReason' into close_reason
        from challenge_ledger_events where id=closing.ledger_event_id;
      select fee.amount into exit_commission
        from challenge_fees fee
        join challenge_ledger_events event on event.id=fee.ledger_event_id
       where fee.order_id=new.order_id and fee.position_id=opening.position_id
         and fee.category='COMMISSION' and event.payload->>'phase'='EXIT';
    end if;
  end if;

  if result_status in ('PENDING','CANCELLED') then
    if new.result->'positionId'<>'null'::jsonb
       or new.result->'fillPrice'<>'null'::jsonb
       or new.result->'commission'<>'null'::jsonb
       or new.result->'exitReason'<>'null'::jsonb
       or opening.id is not null
       or (result_status='PENDING' and exists (
         select 1 from challenge_ledger_events event
          where event.stage_id=(select stage_id from challenge_orders where id=new.order_id)
            and event.type='paper.order.cancelled'
            and event.payload->>'orderId'=new.order_id::text
       ))
       or (result_status='CANCELLED' and not exists (
         select 1 from challenge_ledger_events event
          where event.stage_id=(select stage_id from challenge_orders where id=new.order_id)
            and event.type='paper.order.cancelled'
            and event.payload->>'orderId'=new.order_id::text
       )) then
      raise exception 'CHALLENGE_ORDER_JOB_RESULT_INVALID';
    end if;
  elsif result_status='OPEN' then
    if opening.id is null or closing.id is not null
       or jsonb_typeof(new.result->'positionId')<>'string'
       or new.result->>'positionId' is distinct from opening.position_id::text
       or jsonb_typeof(new.result->'fillPrice')<>'string'
       or new.result->>'fillPrice' is distinct from opening.price
       or jsonb_typeof(new.result->'commission')<>'string'
       or new.result->>'commission' is distinct from entry_commission
       or new.result->'exitReason'<>'null'::jsonb then
      raise exception 'CHALLENGE_ORDER_JOB_RESULT_INVALID';
    end if;
  else
    if opening.id is null or closing.id is null
       or new.result->>'positionId' is distinct from opening.position_id::text
       or jsonb_typeof(new.result->'fillPrice')<>'string'
       or new.result->>'fillPrice' is distinct from closing.price
       or jsonb_typeof(new.result->'commission')<>'string'
       or new.result->>'commission' is distinct from exit_commission
       or new.result->>'exitReason' is distinct from close_reason
       or close_reason not in ('TARGET','STOP','EXPIRED') then
      raise exception 'CHALLENGE_ORDER_JOB_RESULT_INVALID';
    end if;
  end if;
  return new;
end;
$$;

create trigger challenge_order_job_results_validate
before insert on challenge_order_job_results
for each row execute function validate_challenge_order_job_result();

create function validate_challenge_order_job_update() returns trigger
language plpgsql as $$
begin
  if old.id<>new.id or old.order_id<>new.order_id
     or old.market_observation_id<>new.market_observation_id
     or old.operation_key<>new.operation_key
     or old.request_digest<>new.request_digest
     or old.created_at<>new.created_at
     or old.status='COMPLETED' then
    raise exception 'CHALLENGE_ORDER_JOB_IDENTITY_IMMUTABLE';
  end if;
  if old.status='LEASED' and new.status='COMPLETED'
     and not exists (select 1 from challenge_order_job_results where job_id=new.id) then
    raise exception 'CHALLENGE_ORDER_JOB_RESULT_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger challenge_order_jobs_guard_update
before update on challenge_order_jobs
for each row execute function validate_challenge_order_job_update();

create function validate_challenge_completed_job_result() returns trigger
language plpgsql as $$
begin
  if new.status='COMPLETED' and (
    select count(*) from challenge_order_job_results result
     where result.job_id=new.id
       and result.order_id=new.order_id
       and result.market_observation_id=new.market_observation_id
  )<>1 then
    raise exception 'CHALLENGE_ORDER_JOB_RESULT_REQUIRED';
  end if;
  return null;
end;
$$;

create constraint trigger challenge_completed_jobs_require_result
after insert or update on challenge_order_jobs deferrable initially deferred
for each row execute function validate_challenge_completed_job_result();

create function reject_challenge_order_job_result_mutation() returns trigger
language plpgsql as $$
begin raise exception 'IMMUTABLE_CHALLENGE_ORDER_JOB_RESULT'; end;
$$;

create trigger challenge_order_job_results_immutable
before update or delete on challenge_order_job_results
for each row execute function reject_challenge_order_job_result_mutation();
