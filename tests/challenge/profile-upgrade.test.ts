import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";
import { appendEvent } from "../../lib/server/events/store";
import { canonicalContentDigest } from "../../lib/server/events/integrity";
import type { EventDatabase, JsonValue } from "../../lib/server/events/types";
import {
  DECISION_POLICY_VERSION,
  getDecisionWindow,
  openDecisionWindow,
} from "../../lib/server/orchestration/decision-window";
import { testContext } from "../helpers/postgres";

interface LegacyWindowFixture {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly snapshotDigest: string;
  readonly input: {
    readonly marketObservationIds: readonly string[];
    readonly evidence: readonly { readonly kind: "SOURCE_EVENT"; readonly referenceId: string }[];
    readonly portfolioSnapshot: JsonValue;
    readonly costModelSnapshot: JsonValue;
    readonly stageProfileVersion: string;
    readonly eligibleInstruments: readonly string[];
    readonly idempotencyKey: string;
  };
}

async function seedLegacyWindow(
  database: EventDatabase,
  label: string,
  key: string,
): Promise<LegacyWindowFixture> {
  const id = randomUUID();
  const evidence: { kind: "SOURCE_EVENT"; referenceId: string }[] = [
    { kind: "SOURCE_EVENT", referenceId: randomUUID() },
  ];
  const input = {
    marketObservationIds: [`observation-${key}`],
    evidence,
    portfolioSnapshot: { cashCents: "250000", positions: [] },
    costModelSnapshot: { policyVersion: "stock-etf-cost-v1" },
    stageProfileVersion: label,
    eligibleInstruments: ["AAPL"],
    idempotencyKey: key,
  };
  const body = {
    costModelSnapshot: input.costModelSnapshot,
    eligibleInstruments: input.eligibleInstruments,
    evidence: input.evidence,
    marketObservationIds: input.marketObservationIds,
    portfolioSnapshot: input.portfolioSnapshot,
    stageProfileVersion: input.stageProfileVersion,
  };
  const snapshotDigest = canonicalContentDigest(body);
  const requestDigest = canonicalContentDigest({ snapshotDigest });
  const event = await appendEvent(database, {
    aggregateId: id,
    actor: { type: "SYSTEM", id: "gustavo-decision-orchestrator" },
    type: "decision.window.opened",
    visibility: "OPERATOR",
    body,
    idempotencyKey: `decision-window:${key}`,
    policyVersion: DECISION_POLICY_VERSION,
  });
  await database.query(
    `insert into decision_operation_idempotency (
       idempotency_key, operation, aggregate_scope, request_digest
     ) values ($1,'WINDOW_OPEN','shared-challenge',$2)`,
    [key, requestDigest],
  );
  await database.query(
    `insert into decision_windows (
       id, market_observation_ids, evidence_count, portfolio_snapshot_digest,
       cost_model_snapshot_digest, stage_profile_version, eligible_instruments,
       snapshot_digest, opened_event_id, policy_version,
       idempotency_key, request_digest, created_at
     ) values ($1,$2::jsonb,1,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
    [id, JSON.stringify(input.marketObservationIds),
      canonicalContentDigest(input.portfolioSnapshot), canonicalContentDigest(input.costModelSnapshot),
      label, JSON.stringify(input.eligibleInstruments), snapshotDigest, event.id,
      DECISION_POLICY_VERSION, key, requestDigest, event.occurredAt],
  );
  return { id, key, label, snapshotDigest, input };
}

describe("Challenge profile migration upgrade", () => {
  it("preserves arbitrary legacy labels and exact idempotent replay while binding v1", async () => {
    const { db } = await testContext();
    const migrations = await Promise.all(
      Array.from({ length: 9 }, async (_, index) => readFile(
        join("db", "migrations", `${String(index + 1).padStart(4, "0")}_${[
          "events", "identity", "messages", "model_runs", "broadcasts",
          "proposals", "evaluations", "market_data", "challenge_profile",
        ][index]}.sql`),
        "utf8",
      )),
    );
    const schema = `upgrade_${randomUUID().replaceAll("-", "")}`;

    await db.transaction(async (transaction) => {
      await transaction.query(`create schema ${schema}`);
      await transaction.query(`set local search_path=${schema}`);
      for (const migration of migrations.slice(0, 8)) await transaction.query(migration);

      const known = await seedLegacyWindow(
        transaction, "challenge-profile-v1", "legacy-window-known",
      );
      const arbitrary = await seedLegacyWindow(
        transaction, "profile-production-blue", "legacy-window-arbitrary",
      );

      await transaction.query(migrations[8]!);
      expect(await transaction.query(
        `select id::text, legacy_stage_profile_label,
                stage_profile_version::text as profile_id
           from decision_windows order by legacy_stage_profile_label`,
      )).toEqual([
        {
          id: known.id,
          legacy_stage_profile_label: known.label,
          profile_id: INITIAL_PROFILE.profileVersionId,
        },
        {
          id: arbitrary.id,
          legacy_stage_profile_label: arbitrary.label,
          profile_id: INITIAL_PROFILE.profileVersionId,
        },
      ]);

      for (const legacy of [known, arbitrary]) {
        await expect(getDecisionWindow({ db: transaction }, legacy.id)).resolves.toMatchObject({
          id: legacy.id,
          stageProfileVersion: INITIAL_PROFILE.profileVersionId,
          snapshotDigest: legacy.snapshotDigest,
        });
        await expect(openDecisionWindow({ db: transaction }, legacy.input)).resolves.toMatchObject({
          id: legacy.id,
          stageProfileVersion: INITIAL_PROFILE.profileVersionId,
          snapshotDigest: legacy.snapshotDigest,
        });
      }

      await expect(openDecisionWindow(
        { db: transaction },
        { ...arbitrary.input, stageProfileVersion: INITIAL_PROFILE.profileVersionId },
      )).rejects.toThrow("DECISION_IDEMPOTENCY_KEY_REUSED");
      await expect(openDecisionWindow(
        { db: transaction },
        { ...arbitrary.input, idempotencyKey: "legacy-label-new-key" },
      )).rejects.toThrow("DECISION_PROFILE_VERSION_INVALID");
      expect(await transaction.query(
        "select idempotency_key from decision_windows order by idempotency_key",
      )).toEqual([
        { idempotency_key: arbitrary.key },
        { idempotency_key: known.key },
      ]);
      expect(await transaction.query(
        "select idempotency_key from decision_operation_idempotency order by idempotency_key",
      )).toEqual([
        { idempotency_key: arbitrary.key },
        { idempotency_key: known.key },
      ]);

      await transaction.query("set local search_path=public");
      await transaction.query(`drop schema ${schema} cascade`);
    });
  }, 30_000);
});
