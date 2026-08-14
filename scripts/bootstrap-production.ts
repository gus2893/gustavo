import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MARKET_UNIVERSE } from "../config/market-universe";
import { resolveApplicationOrigin } from "../lib/server/auth/sessions";
import { closeDatabase, getDatabase } from "../lib/server/db/postgres";
import { issueInvitationRedemptionUrl } from "./issue-invitation";

const CANONICAL_PRODUCTION_ORIGIN = "https://gustavo.lol";
const PRODUCTION_DEPLOYMENT_PROFILE = "public-production-v1";
const OPERATOR_ACTOR_ID = "gustavo-operator";
const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const EXPECTED_MIGRATIONS = Object.freeze([
  "0001_events.sql",
  "0002_identity.sql",
  "0003_messages.sql",
  "0004_model_runs.sql",
  "0005_broadcasts.sql",
  "0006_proposals.sql",
  "0007_evaluations.sql",
  "0008_market_data.sql",
  "0009_challenge_profile.sql",
  "0010_challenge_ledger.sql",
  "0011_order_lifecycle.sql",
  "0012_thoughts.sql",
  "0013_memory.sql",
  "0014_chat_sources.sql",
  "0015_recall.sql",
  "0016_memory_graph.sql",
  "0017_handoffs.sql",
  "0017_zz_cache.sql",
  "0018_imports.sql",
  "0019_privacy_controls.sql",
  "0019_zz_stream.sql",
  "0020_observability.sql",
  "0021_broadcast_schedules.sql",
  "0022_hybrid_deployment.sql",
] as const);

const EXPECTED_MIGRATION_LEDGER = Object.freeze(EXPECTED_MIGRATIONS.map((filename) => {
  const sql = readFileSync(new URL(`../db/migrations/${filename}`, import.meta.url), "utf8")
    .replace(/\r\n?/gu, "\n");
  const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
  return `${filename}:${checksum}`;
}));

const ALL_APPLICATION_TABLES = Object.freeze([
  "account_export_snapshot_records", "account_export_snapshot_retirements",
  "account_export_snapshots", "accounts", "aggregate_data_keys", "audit_events",
  "bridge_model_jobs", "bridge_wake_receipts", "broadcast_cycles",
  "broadcast_schedule_runtime", "broadcast_schedules", "broadcasts",
  "cache_authority_changes", "cache_authority_staging", "cache_main_state_sources",
  "cache_metric_observations", "cache_outbox_backfill_state", "cache_outbox_staging",
  "cache_projection_jobs", "cache_projection_versions", "cache_rebuild_category_checks",
  "cache_rebuild_runs", "challenge_fees", "challenge_fills", "challenge_financing",
  "challenge_intents", "challenge_ledger_events", "challenge_order_job_results",
  "challenge_order_jobs", "challenge_orders", "challenge_portfolios",
  "challenge_position_closures", "challenge_positions", "challenge_price_marks",
  "challenge_profile_publications", "challenge_profile_versions",
  "challenge_projection_checkpoints", "challenge_rule_evaluations",
  "challenge_stage_profiles", "challenge_stages", "chat_import_conversation_occurrences",
  "chat_import_item_occurrences", "chat_import_quarantine",
  "chat_import_quarantine_occurrences", "chat_source_authorizations", "chat_source_cursors",
  "chat_source_event_manifests", "chat_source_imports", "chat_sources",
  "conversation_archive_commands", "conversations", "database_commit_metric_buckets",
  "decision_candidates", "decision_evaluation_batches", "decision_evaluation_scores",
  "decision_operation_idempotency", "decision_selections", "decision_windows", "deliveries",
  "deployment_quota_counters", "encrypted_event_bodies", "entitlements", "events",
  "handoff_key_registry", "handoff_packet_ideas", "handoff_packet_keys",
  "handoff_packet_manifests", "handoff_packets", "handoff_refresh_checkpoint_keys",
  "handoff_refresh_checkpoint_manifests", "handoff_refresh_checkpoints",
  "handoff_refresh_job_keys", "handoff_refresh_job_manifests",
  "handoff_refresh_job_transition_manifests", "handoff_refresh_job_transitions",
  "handoff_refresh_jobs", "hybrid_worker_heartbeats", "import_event_authorities",
  "import_item_lifecycle_events", "import_lifecycle_commands",
  "import_lifecycle_idempotency_aliases", "import_manifests", "import_memory_projections",
  "import_review_queue_entries", "import_source_items", "import_verification_receipts",
  "imported_chat_conversation_versions", "imported_chat_conversations",
  "imported_chat_message_versions", "invitations", "main_state_versions", "market_bars",
  "market_data_sources", "market_instrument_allowlist", "market_latest_quotes",
  "market_observation_consumptions", "market_observations", "market_poll_windows",
  "market_symbol_catalog", "memory_conflict_sources", "memory_conflicts",
  "memory_dossier_refreshes", "memory_embeddings", "memory_episodes",
  "memory_equivalence_links", "memory_equivalence_sets", "memory_extraction_runs",
  "memory_goals", "memory_graph_alias_sources", "memory_graph_background_job_transitions",
  "memory_graph_background_jobs", "memory_graph_current_claims", "memory_graph_edge_sources",
  "memory_graph_edges", "memory_graph_entities", "memory_graph_entity_aliases",
  "memory_graph_entity_versions", "memory_graph_event_manifests", "memory_graph_head_versions",
  "memory_graph_idempotency_keys", "memory_graph_job_transition_manifests",
  "memory_graph_legacy_edge_backfills", "memory_graph_node_sources", "memory_graph_nodes",
  "memory_graph_reconciliation_job_aliases", "memory_graph_reconciliation_job_candidates",
  "memory_graph_reconciliation_job_entities",
  "memory_graph_reconciliation_job_idempotency_keys",
  "memory_graph_reconciliation_job_manifests",
  "memory_graph_reconciliation_job_source_sets", "memory_graph_reconciliation_job_sources",
  "memory_graph_reconciliation_job_transition_manifests",
  "memory_graph_reconciliation_job_transitions", "memory_graph_reconciliation_jobs",
  "memory_graph_reconciliation_runs", "memory_graph_run_aliases",
  "memory_graph_run_candidates", "memory_graph_run_conflicts", "memory_graph_run_edges",
  "memory_graph_run_entities", "memory_graph_worker_authorities", "memory_index_terms",
  "memory_procedures", "memory_projection_checkpoints", "memory_records",
  "memory_retrieval_stats", "memory_semantic_facts", "memory_sources",
  "memory_supersession_authorizations", "memory_vector_backfill_checkpoints",
  "memory_vector_buckets", "messages", "model_budget_usage", "model_runs", "node_brains",
  "password_credentials", "privacy_erased_aggregate_keys", "privacy_forget_barriers",
  "privacy_forget_request_aliases", "privacy_forget_requests",
  "privacy_forget_step_transitions", "privacy_forget_steps",
  "privacy_forget_worker_authorities", "privacy_forget_worker_revocations",
  "privacy_legal_authorities", "privacy_legal_authority_revocations",
  "privacy_projection_deactivations", "privacy_projection_rebuild_job_transitions",
  "privacy_projection_rebuild_jobs", "privacy_projection_rebuild_results",
  "privacy_projection_registry", "proposal_disclosure_authorizations",
  "proposal_disclosure_revocations", "proposal_evidence_links",
  "proposal_operation_idempotency", "proposal_status_transitions",
  "proposal_turn_evidence_links", "proposal_turns", "proposals", "recall_actor_authorities",
  "recall_trace_candidates", "recall_trace_context_entries", "recall_trace_plan_steps",
  "recall_trace_sources", "recall_traces", "sessions", "stream_outbox_deliveries",
  "stream_publish_state", "thought_claims", "thought_records", "thought_references",
  "transactional_outbox",
] as const);

const SEEDED_APPLICATION_TABLES = new Set<string>([
  "cache_outbox_backfill_state",
  "challenge_portfolios",
  "challenge_profile_publications",
  "challenge_profile_versions",
  "challenge_stage_profiles",
  "market_symbol_catalog",
  "memory_graph_worker_authorities",
  "privacy_forget_worker_authorities",
  "privacy_projection_registry",
  "recall_actor_authorities",
  "stream_publish_state",
]);

const EMPTY_APPLICATION_TABLES = Object.freeze(
  ALL_APPLICATION_TABLES.filter((table) => !SEEDED_APPLICATION_TABLES.has(table)),
);
const FROZEN_PRIVACY_REGISTRY_DIGEST =
  "4d9149750a281db78a84426c190559b791248a707945cd0b4cce27a151250ade";

const ACQUIRE_BOOTSTRAP_LOCK_SQL = `select pg_advisory_xact_lock(
  hashtextextended('gustavo:production-bootstrap:v1',0)
) as locked`;
const LOCK_BOOTSTRAP_TABLES_SQL = `lock table ${ALL_APPLICATION_TABLES.join(",")}
in share mode`;
const EMPTY_TABLE_STATE_SQL = EMPTY_APPLICATION_TABLES.map((table) =>
  `select '${table}' relation_name,exists(select 1 from ${table} limit 1) nonempty`,
).join(" union all ");

const PREFLIGHT_SQL = `/* production-bootstrap-preflight */
with migration_state as (
  select coalesce(
        array_agg(name||':'||checksum_sha256 order by name),array[]::text[]
      )=$1::text[]
      and count(*)=cardinality($1::text[])
      and bool_and(checksum_sha256 ~ '^[a-f0-9]{64}$') as valid
  from schema_migrations
), schema_state as (
  select coalesce(array_agg(tablename::text order by tablename),array[]::text[])=$4::text[] valid
  from pg_tables where schemaname=current_schema() and tablename<>'schema_migrations'
), private_state as (
  select coalesce(bool_or(nonempty),false) nonempty from (
    ${EMPTY_TABLE_STATE_SQL}
  ) state
), authority_state as (
  select
    (select count(*)=1 and bool_and(
       id='00000000-0000-4000-8000-000000001200'
       and owner_type='MAIN_BRAIN' and initial_lifecycle_state='ACTIVE'
       and created_at='2026-08-09T00:00:00.000Z'::timestamptz
       and created_by='gustavo-operator'
       and creation_reason='Approved shared Challenge v1'
     ) from challenge_portfolios)
    and (select count(*)=1 and bool_and(
       id='00000000-0000-4000-8000-000000001201'
       and challenge_portfolio_id='00000000-0000-4000-8000-000000001200'
       and version=1 and supersedes_profile_version_id is null
       and base_currency='USD' and profit_objective_bps=1000
       and overall_drawdown_type='STATIC' and overall_loss_limit_bps=600
       and not trailing_overall_drawdown and daily_loss_type='DAY_START_EQUITY'
       and daily_loss_limit_bps=400 and reset_timezone='UTC' and reset_boundary='00:00'
       and minimum_trading_days=3 and deadline_days is null
       and portfolio_risk_limit_bps=300 and position_risk_limit_bps=100
       and qualifying_risk_bps=25 and max_gross_leverage_bps=10000
       and maximum_positions=3 and maximum_positions_per_symbol=1
       and allowed_asset_classes=array['US_STOCK','US_ETF']::text[]
       and cost_policy_version='stock-etf-cost-v1'
       and initial_lifecycle_state='ACTIVE'
       and effective_at='2026-08-09T00:00:00.000Z'::timestamptz
       and created_by='gustavo-operator'
       and change_reason='Approved initial Challenge profile'
     ) from challenge_profile_versions)
    and (select count(*)=10
       and array_agg(ordinal order by ordinal)=array[1,2,3,4,5,6,7,8,9,10]
       and array_agg(id order by ordinal)=array[
         '00000000-0000-4000-8000-000000001211'::uuid,
         '00000000-0000-4000-8000-000000001212'::uuid,
         '00000000-0000-4000-8000-000000001213'::uuid,
         '00000000-0000-4000-8000-000000001214'::uuid,
         '00000000-0000-4000-8000-000000001215'::uuid,
         '00000000-0000-4000-8000-000000001216'::uuid,
         '00000000-0000-4000-8000-000000001217'::uuid,
         '00000000-0000-4000-8000-000000001218'::uuid,
         '00000000-0000-4000-8000-000000001219'::uuid,
         '00000000-0000-4000-8000-000000001220'::uuid
       ]
       and bool_and(profile_version_id='00000000-0000-4000-8000-000000001201')
       and array_agg(starting_balance_cents order by ordinal)
         =array[250000,500000,1000000,2000000,4000000,8000000,16000000,32000000,64000000,100000000]::bigint[]
       and array_agg(target_equity_cents order by ordinal)
         =array[275000,550000,1100000,2200000,4400000,8800000,17600000,35200000,70400000,110000000]::bigint[]
       and array_agg(overall_floor_cents order by ordinal)
         =array[235000,470000,940000,1880000,3760000,7520000,15040000,30080000,60160000,94000000]::bigint[]
       and array_agg(daily_loss_limit_cents order by ordinal)
         =array[10000,20000,40000,80000,160000,320000,640000,1280000,2560000,4000000]::bigint[]
       and array_agg(portfolio_risk_limit_cents order by ordinal)
         =array[7500,15000,30000,60000,120000,240000,480000,960000,1920000,3000000]::bigint[]
       and array_agg(position_risk_limit_cents order by ordinal)
         =array[2500,5000,10000,20000,40000,80000,160000,320000,640000,1000000]::bigint[]
       and array_agg(qualifying_risk_cents order by ordinal)
         =array[625,1250,2500,5000,10000,20000,40000,80000,160000,250000]::bigint[]
       and bool_and(created_at='2026-08-09T00:00:00.000Z'::timestamptz)
     from challenge_stage_profiles)
    and (select count(*)=1 and bool_and(
       profile_version_id='00000000-0000-4000-8000-000000001201'
       and published_at='2026-08-09T00:00:00.000Z'::timestamptz
       and published_by='gustavo-operator'
       and publication_reason='Approved complete initial Challenge profile'
     ) from challenge_profile_publications)
    and (select count(*)=1 and bool_and(
       role='MAIN_BRAIN' and actor_id='gustavo-main'
       and scopes=array['CHALLENGE_SHARED','MAIN_SHARED','PUBLIC']::text[] and active
     ) from recall_actor_authorities)
    and (select count(*)=1 and bool_and(
       actor_id='memory-graph-worker'
       and purposes=array['DEEP_RESEARCH','RECONCILIATION']::text[] and active
     ) from memory_graph_worker_authorities)
    and (select count(*)=2
       and array_agg(worker_id order by worker_id)
         =array['privacy-forget-production','privacy-worker-test']::text[]
       and bool_and(active and grant_kind='SYSTEM_BOOTSTRAP')
     from privacy_forget_worker_authorities)
    and (select count(*)=1 and bool_and(
       singleton and boundary_ingested_sequence=0 and last_ingested_sequence=0 and completed
     ) from cache_outbox_backfill_state)
    and (select count(*)=1 and bool_and(
       singleton and next_position=1 and active_outbox_id is null
     ) from stream_publish_state)
    and (select recall_manifest_digest(coalesce(jsonb_agg(jsonb_build_object(
       'projectionType',projection_type,'ordinal',ordinal,'relationName',relation_name,
       'forgetBehavior',forget_behavior,'rebuildBehavior',rebuild_behavior,
       'forgetExecutor',forget_executor,'rebuildExecutor',rebuild_executor
     ) order by ordinal),'[]'::jsonb))=$5::text from privacy_projection_registry)
    and (select count(*)=95
       and array_agg(symbol order by ordinal)=$2::text[]
       and array_agg(kind order by ordinal)=$3::text[]
     from market_symbol_catalog)
    and (select count(*)=1 and bool_and(
       not rolcanlogin and not rolinherit and not rolsuper
       and not rolcreatedb and not rolcreaterole
       and not rolreplication and not rolbypassrls and rolconnlimit=0
     ) from pg_roles where rolname='gustavo_market_materializer')
    and not exists (
      select 1 from pg_auth_members membership
      join pg_roles granted_role on granted_role.oid=membership.roleid
      where granted_role.rolname='gustavo_market_materializer'
    )
    and not exists (
      select 1 from pg_auth_members membership
      join pg_roles member_role on member_role.oid=membership.member
      where member_role.rolname='gustavo_market_materializer'
    ) as valid
)
select case
  when not coalesce((select valid from migration_state),false)
    then 'SCHEMA_NOT_FULLY_MIGRATED'
  when not coalesce((select valid from schema_state),false)
    then 'SCHEMA_NOT_FULLY_MIGRATED'
  when (select nonempty from private_state)
    then 'PRODUCTION_DATABASE_NOT_EMPTY'
  when not coalesce((select valid from authority_state),false)
    then 'PRODUCTION_AUTHORITY_INVALID'
  else null
end as safe_code`;

type BootstrapRow = Readonly<Record<string, unknown>>;

export interface ProductionBootstrapEnvironment {
  readonly databaseUrl: string;
  readonly canonicalOrigin: string;
  readonly deploymentProfile: string;
}

export interface BootstrapProductionOptions {
  readonly databaseUrl: string;
  readonly canonicalOrigin: string;
  readonly deploymentProfile?: string;
  readonly query: (
    sql: string,
    parameters?: readonly unknown[],
  ) => Promise<readonly BootstrapRow[]>;
  readonly issueInvitation: () => Promise<{
    readonly redemptionUrl: string;
    readonly expiresAt: string | Date;
  }>;
  readonly write: (value: string) => void;
}

function databaseUrlIsPostgres(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "postgresql:" || url.protocol === "postgres:")
      && url.hostname !== "" && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function eventRootKeyEnvironmentIsValid(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (environment.GUSTAVO_EVENT_ROOT_KEY_VERSION !== "1") return false;
  const encoded = environment.GUSTAVO_EVENT_ROOT_KEY_V1;
  if (!encoded) return false;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 32 && decoded.toString("base64") === encoded;
}

export function readProductionBootstrapEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionBootstrapEnvironment {
  const databaseUrl = environment.DATABASE_URL?.trim() ?? "";
  if (!databaseUrlIsPostgres(databaseUrl)
      || environment.GUSTAVO_APP_ORIGIN !== CANONICAL_PRODUCTION_ORIGIN
      || environment.GUSTAVO_DEPLOYMENT_PROFILE !== PRODUCTION_DEPLOYMENT_PROFILE
      || !eventRootKeyEnvironmentIsValid(environment)
      || resolveApplicationOrigin("production", environment)
        !== CANONICAL_PRODUCTION_ORIGIN) {
    throw new Error("PRODUCTION_BOOTSTRAP_ENV_INVALID");
  }
  return {
    databaseUrl,
    canonicalOrigin: CANONICAL_PRODUCTION_ORIGIN,
    deploymentProfile: PRODUCTION_DEPLOYMENT_PROFILE,
  };
}

function assertBootstrapAuthority(options: BootstrapProductionOptions): void {
  const deploymentProfile = options.deploymentProfile ?? PRODUCTION_DEPLOYMENT_PROFILE;
  if (!databaseUrlIsPostgres(options.databaseUrl)
      || options.canonicalOrigin !== CANONICAL_PRODUCTION_ORIGIN
      || deploymentProfile !== PRODUCTION_DEPLOYMENT_PROFILE
      || resolveApplicationOrigin("production", {
        GUSTAVO_DEPLOYMENT_PROFILE: deploymentProfile,
      }) !== options.canonicalOrigin) {
    throw new Error("PRODUCTION_BOOTSTRAP_AUTHORITY_INVALID");
  }
}

function validateRedemptionResult(
  result: Awaited<ReturnType<BootstrapProductionOptions["issueInvitation"]>>,
  canonicalOrigin: string,
): string {
  const expiresAt = new Date(result.expiresAt);
  let url: URL;
  try {
    url = new URL(result.redemptionUrl);
  } catch {
    throw new Error("PRODUCTION_INVITATION_OUTPUT_INVALID");
  }
  const tokens = url.searchParams.getAll("token");
  if (!Number.isFinite(expiresAt.getTime())
      || url.origin !== canonicalOrigin
      || url.pathname !== "/join"
      || url.username !== "" || url.password !== "" || url.hash !== ""
      || [...url.searchParams.keys()].length !== 1
      || tokens.length !== 1 || !/^[A-Za-z0-9_-]{1,256}$/.test(tokens[0]!)) {
    throw new Error("PRODUCTION_INVITATION_OUTPUT_INVALID");
  }
  return url.toString();
}

export async function bootstrapProduction(
  options: BootstrapProductionOptions,
): Promise<void> {
  assertBootstrapAuthority(options);
  await options.query(ACQUIRE_BOOTSTRAP_LOCK_SQL);
  await options.query(LOCK_BOOTSTRAP_TABLES_SQL);
  const rows = await options.query(PREFLIGHT_SQL, [
    EXPECTED_MIGRATION_LEDGER,
    MARKET_UNIVERSE.map(({ symbol }) => symbol),
    MARKET_UNIVERSE.map(({ kind }) => kind),
    ALL_APPLICATION_TABLES,
    FROZEN_PRIVACY_REGISTRY_DIGEST,
  ]);
  if (rows.length !== 1) throw new Error("PRODUCTION_BOOTSTRAP_PREFLIGHT_INVALID");
  const safeCode = rows[0]?.safe_code;
  if (safeCode !== null) {
    if (safeCode === "SCHEMA_NOT_FULLY_MIGRATED"
        || safeCode === "PRODUCTION_DATABASE_NOT_EMPTY"
        || safeCode === "PRODUCTION_AUTHORITY_INVALID") {
      throw new Error(safeCode);
    }
    throw new Error("PRODUCTION_BOOTSTRAP_PREFLIGHT_INVALID");
  }

  const invitation = await options.issueInvitation();
  const redemptionUrl = validateRedemptionResult(invitation, options.canonicalOrigin);
  options.write(`${redemptionUrl}\n`);
}

async function main(): Promise<void> {
  const authority = readProductionBootstrapEnvironment(process.env);
  const database = getDatabase();
  let output: string | undefined;
  try {
    await database.transaction((transaction) => bootstrapProduction({
      ...authority,
      query: (sql, parameters) => transaction.query(sql, parameters),
      issueInvitation: () => issueInvitationRedemptionUrl(
        {
          db: transaction,
          operator: { id: OPERATOR_ACTOR_ID, role: "OPERATOR" },
        },
        { expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS) },
        authority.canonicalOrigin,
      ),
      write: (value) => {
        if (output !== undefined) throw new Error("PRODUCTION_BOOTSTRAP_OUTPUT_DUPLICATE");
        output = value;
      },
    }));
    if (output === undefined) throw new Error("PRODUCTION_BOOTSTRAP_OUTPUT_MISSING");
    process.stdout.write(output);
  } finally {
    await closeDatabase();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined
    && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch(() => {
    process.stderr.write("PRODUCTION_BOOTSTRAP_FAILED\n");
    process.exitCode = 1;
  });
}
