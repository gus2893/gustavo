import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EventDatabase, JsonValue } from "../../lib/server/events/types";
import { openTestDb } from "../helpers/postgres";
import {
  appendEvent,
  readEventBodies,
  readEventBody,
  rewrapAggregateDataKey,
} from "../../lib/server/events/store";

describe("appendEvent", () => {
  it("writes the event and its outbox job in one transaction", async () => {
    const db = await openTestDb();
    const event = await appendEvent(db, {
      aggregateId: "conversation-1",
      actor: { type: "USER", id: "account-1" },
      type: "participant.message.created",
      visibility: "PRIVATE_ACCOUNT",
      body: { text: "Remember this" },
      idempotencyKey: "message-1",
    });
    const rows = await db.query(
      "select e.id, o.event_id from events e join transactional_outbox o on o.event_id=e.id where e.id=$1",
      [event.id],
    );
    expect(rows).toEqual([{ id: event.id, event_id: event.id }]);
    const protectedRow = await db.one<{ ciphertext: Buffer; data_key_id: string }>(
      "select ciphertext, data_key_id from encrypted_event_bodies where event_id=$1",
      [event.id],
    );
    expect(JSON.stringify(protectedRow)).not.toContain("Remember this");
    const bodyColumns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema=current_schema() and table_name='encrypted_event_bodies'
       order by column_name`,
    );
    expect(bodyColumns.map(({ column_name }) => column_name)).not.toEqual(
      expect.arrayContaining([
        "wrapped_key",
        "root_key_version",
        "key_wrap_iv",
        "key_wrap_auth_tag",
      ]),
    );
    const bodyConstraints = await db.query<{ definition: string }>(
      `select pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_class t on t.oid=c.conrelid
       join pg_namespace n on n.oid=t.relnamespace
       where n.nspname=current_schema() and t.relname='encrypted_event_bodies'`,
    );
    expect(bodyConstraints.map(({ definition }) => definition).join("\n")).toContain(
      "FOREIGN KEY (event_id, aggregate_id) REFERENCES events(id, aggregate_id)",
    );
    expect(
      await readEventBody(db, event.id, {
        actor: { role: "ACCOUNT", accountId: "account-1" },
      }),
    ).toEqual({ text: "Remember this" });

    const replay = await appendEvent(db, {
      aggregateId: "conversation-1",
      actor: { type: "USER", id: "account-1" },
      type: "participant.message.created",
      visibility: "PRIVATE_ACCOUNT",
      body: { text: "Remember this" },
      idempotencyKey: "message-1",
    });
    expect(replay.id).toBe(event.id);
    expect(
      await db.one("select count(*)::int as count from events where idempotency_key=$1", [
        "message-1",
      ]),
    ).toEqual({ count: 1 });
    await expect(
      appendEvent(db, {
        aggregateId: "conversation-1",
        actor: { type: "USER", id: "account-1" },
        type: "participant.message.created",
        visibility: "PRIVATE_ACCOUNT",
        body: { text: "Different payload" },
        idempotencyKey: "message-1",
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");

    await expect(
      readEventBody(db, event.id, {
        actor: { role: "ACCOUNT", accountId: "account-2" },
      }),
    ).rejects.toThrow("FORBIDDEN");

    const caused = await appendEvent(db, {
      aggregateId: "conversation-1",
      actor: { type: "NODE_BRAIN", id: "node-1" },
      accountId: "account-1",
      type: "brain.response.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: { z: 1, nested: { y: 2, x: 3 } },
      idempotencyKey: "response-1",
      causationId: event.id,
      correlationId: event.correlationId,
    });
    expect(caused.id.localeCompare(event.id)).toBeGreaterThan(0);
    expect(caused).toMatchObject({
      causationId: event.id,
      correlationId: event.correlationId,
    });
    const canonicalReplay = await appendEvent(db, {
      aggregateId: "conversation-1",
      actor: { id: "node-1", type: "NODE_BRAIN" },
      accountId: "account-1",
      type: "brain.response.completed",
      visibility: "PRIVATE_ACCOUNT",
      body: { nested: { x: 3, y: 2 }, z: 1 },
      idempotencyKey: "response-1",
      causationId: event.id,
      correlationId: event.correlationId,
    });
    expect(canonicalReplay.id).toBe(caused.id);

    const persisted = await db.one<{
      causation_id: string;
      correlation_id: string;
      integrity_hash: string;
    }>(
      "select causation_id, correlation_id, integrity_hash from events where id=$1",
      [caused.id],
    );
    expect(persisted).toEqual({
      causation_id: event.id,
      correlation_id: event.correlationId,
      integrity_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const causedProtected = await db.one<{
      data_key_id: string;
    }>(
      "select data_key_id from encrypted_event_bodies where event_id=$1",
      [caused.id],
    );
    expect(causedProtected.data_key_id).toBe(protectedRow.data_key_id);
    const authoritativeKey = await db.one<{
      id: string;
      root_key_version: number;
      wrapped_key: Buffer;
    }>("select id, root_key_version, wrapped_key from aggregate_data_keys where id=$1", [
      protectedRow.data_key_id,
    ]);
    expect(authoritativeKey.root_key_version).toBe(1);
    expect(authoritativeKey.wrapped_key.toString("base64")).not.toBe(
      process.env.GUSTAVO_EVENT_ROOT_KEY_V1,
    );

    await expect(
      db.query("update events set type='tampered' where id=$1", [event.id]),
    ).rejects.toThrow("IMMUTABLE_EVENT");

    await db.query(`
      create function reject_test_outbox() returns trigger language plpgsql as $$
      begin
        if new.topic = 'force.rollback' then
          raise exception 'TEST_OUTBOX_FAILURE';
        end if;
        return new;
      end;
      $$;
      create trigger reject_test_outbox before insert on transactional_outbox
      for each row execute function reject_test_outbox();
    `);
    await expect(
      appendEvent(db, {
        aggregateId: "conversation-rollback",
        actor: { type: "USER", id: "account-1" },
        type: "force.rollback",
        visibility: "PRIVATE_ACCOUNT",
        body: { text: "must not survive" },
        idempotencyKey: "rollback-1",
      }),
    ).rejects.toThrow("TEST_OUTBOX_FAILURE");
    expect(
      await db.one("select count(*)::int as count from events where idempotency_key=$1", [
        "rollback-1",
      ]),
    ).toEqual({ count: 0 });

    process.env.GUSTAVO_EVENT_ROOT_KEY_V2 = randomBytes(32).toString("base64");
    try {
      await expect(
        db.query("update aggregate_data_keys set aggregate_id=$2 where id=$1", [
          protectedRow.data_key_id,
          "conversation-reassigned",
        ]),
      ).rejects.toThrow("IMMUTABLE_DATA_KEY_IDENTITY");
      await rewrapAggregateDataKey(db, "conversation-1", 2);
      expect(
        await db.one("select root_key_version from aggregate_data_keys where id=$1", [
          protectedRow.data_key_id,
        ]),
      ).toEqual({ root_key_version: 2 });
      expect(
        await readEventBody(db, event.id, {
          actor: { role: "ACCOUNT", accountId: "account-1" },
        }),
      ).toEqual({ text: "Remember this" });
    } finally {
      delete process.env.GUSTAVO_EVENT_ROOT_KEY_V2;
    }

    await db.query("delete from aggregate_data_keys where id=$1", [
      protectedRow.data_key_id,
    ]);
    expect(
      await db.one(
        `select e.id, b.data_key_id, octet_length(b.ciphertext)::int as ciphertext_bytes
         from events e join encrypted_event_bodies b on b.event_id=e.id where e.id=$1`,
        [event.id],
      ),
    ).toEqual({
      id: event.id,
      data_key_id: null,
      ciphertext_bytes: expect.any(Number),
    });
    await expect(
      readEventBody(db, event.id, {
        actor: { role: "ACCOUNT", accountId: "account-1" },
      }),
    ).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
  }, 30_000);

  it("batch-authorizes before ciphertext and decrypts ordered unique bodies in bounded queries", async () => {
    const db = await openTestDb();
    const first = await appendEvent(db, {
      aggregateId: "batch-conversation", accountId: "batch-account",
      actor: { type: "USER", id: "batch-account" }, type: "message.completed",
      visibility: "PRIVATE_ACCOUNT", body: { text: "first", nested: { value: 1 } },
      idempotencyKey: "batch-read:first",
    });
    const second = await appendEvent(db, {
      aggregateId: "batch-conversation", accountId: "batch-account",
      actor: { type: "NODE_BRAIN", id: "batch-node" }, type: "node.response.completed",
      visibility: "PRIVATE_ACCOUNT", body: { text: "second" },
      idempotencyKey: "batch-read:second",
    });
    const foreign = await appendEvent(db, {
      aggregateId: "batch-foreign", accountId: "foreign-account",
      actor: { type: "USER", id: "foreign-account" }, type: "message.completed",
      visibility: "PRIVATE_ACCOUNT", body: { text: "foreign" },
      idempotencyKey: "batch-read:foreign",
    });
    const queries: string[] = [];
    const counted: EventDatabase = {
      query: async (sql, parameters) => {
        queries.push(sql);
        return db.query(sql, parameters);
      },
      one: (sql, parameters) => db.one(sql, parameters),
      transaction: (work) => db.transaction(work),
    };
    const bodies = await readEventBodies(
      counted, [second.id, first.id, first.id],
      { actor: { role: "ACCOUNT", accountId: "batch-account" } },
    );
    expect(bodies.map(({ eventId, body }) => ({ eventId, body }))).toEqual([
      { eventId: second.id, body: { text: "second" } },
      { eventId: first.id, body: { text: "first", nested: { value: 1 } } },
      { eventId: first.id, body: { text: "first", nested: { value: 1 } } },
    ]);
    expect(bodies[1].body).toBe(bodies[2].body);
    expect(Object.isFrozen(bodies)).toBe(true);
    expect(Object.isFrozen(bodies[1].body)).toBe(true);
    expect(queries).toHaveLength(3);

    queries.length = 0;
    await expect(readEventBodies(
      counted, [first.id, foreign.id],
      { actor: { role: "ACCOUNT", accountId: "batch-account" } },
    )).rejects.toThrow("FORBIDDEN");
    expect(queries).toHaveLength(1);
    expect(queries.some((sql) => sql.includes("encrypted_event_bodies")
      || sql.includes("aggregate_data_keys"))).toBe(false);
    await expect(readEventBodies(
      counted, Array.from({ length: 101 }, () => first.id),
      { actor: { role: "ACCOUNT", accountId: "batch-account" } },
    )).rejects.toThrow("EVENT_BODY_BATCH_LIMIT");
  });

  it("overwrites caller-supplied ingestion sequences on direct inserts", async () => {
    const db = await openTestDb();
    const source = await appendEvent(db, {
      aggregateId: "ingestion-trigger", actor: { type: "SYSTEM", id: "test" },
      type: "ingestion.source", visibility: "OPERATOR", body: { test: true },
      idempotencyKey: "ingestion-trigger:source",
    });
    let storedSequence: string | undefined;
    await expect(db.transaction(async (transaction) => {
      const forgedId = randomUUID();
      await transaction.query(
        `insert into events (
           ingested_sequence,id,aggregate_id,account_id,actor_type,actor_id,type,visibility,
           occurred_at,causation_id,correlation_id,prompt_version,model_version,policy_version,
           idempotency_key,request_hash,integrity_hash
         ) select 9223372036854770000,$1,aggregate_id,account_id,actor_type,actor_id,type,
                  visibility,occurred_at,causation_id,correlation_id,prompt_version,model_version,
                  policy_version,$2,request_hash,integrity_hash from events where id=$3`,
        [forgedId, `ingestion-trigger:forged:${forgedId}`, source.id],
      );
      storedSequence = (await transaction.one<{ sequence: string }>(
        "select ingested_sequence::text sequence from events where id=$1", [forgedId],
      )).sequence;
      throw new Error("ROLLBACK_INGESTION_TRIGGER_FIXTURE");
    })).rejects.toThrow("ROLLBACK_INGESTION_TRIGGER_FIXTURE");
    expect(storedSequence).toBeDefined();
    expect(storedSequence).not.toBe("9223372036854770000");
  });

  it("round-trips an own __proto__ JSON key without prototype mutation", async () => {
    const db = await openTestDb();
    const body = Object.create(null) as Record<string, JsonValue>;
    Object.defineProperty(body, "__proto__", {
      value: { attackerInherited: true }, enumerable: true, configurable: true, writable: true,
    });
    body.safe = { nested: "value" };
    const event = await appendEvent(db, {
      aggregateId: "prototype-safe-body", actor: { type: "SYSTEM", id: "prototype-test" },
      type: "prototype.body.committed", visibility: "OPERATOR", body,
      idempotencyKey: "prototype-safe-body:event",
    });
    const [result] = await readEventBodies(
      db, [event.id], { actor: { role: "SYSTEM" } },
    );
    const read = result.body as Record<string, JsonValue>;
    expect(Object.hasOwn(read, "__proto__")).toBe(true);
    expect(read.__proto__).toEqual({ attackerInherited: true });
    expect(Object.getPrototypeOf(read) === null || Object.getPrototypeOf(read) === Object.prototype)
      .toBe(true);
    expect((read as Record<string, unknown>).attackerInherited).toBeUndefined();
    expect(read.safe).toEqual({ nested: "value" });
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.__proto__)).toBe(true);
  });
});
