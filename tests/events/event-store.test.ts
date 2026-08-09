import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openTestDb } from "../helpers/postgres";
import {
  appendEvent,
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
});
