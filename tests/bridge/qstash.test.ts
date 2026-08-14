import { createHash, createHmac } from "node:crypto";
import { Receiver } from "@upstash/qstash";
import { describe, expect, it, vi } from "vitest";
import {
  acceptQStashWake,
  publishOpaqueWake,
  type OpaqueQStashWake,
} from "../../lib/server/bridge/qstash";
import { createConversationFixture } from "../helpers/postgres";

const EXPECTED_URL = "https://bridge.example.test/wake";
const CURRENT_SIGNING_KEY = "current-signing-key-with-at-least-32-bytes";
const NEXT_SIGNING_KEY = "next-signing-key-with-at-least-32-bytes";
const JOB_ID = "018f7b22-9f76-7b4d-a4e8-1a2b3c4d5e6f";
const WINDOW_ID = "2026-08-13T13:30Z";
const MARKET_CURRENT_BODY = JSON.stringify({ kind: "MARKET_CURRENT" });

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signature(input: {
  readonly key: string;
  readonly url: string;
  readonly body: string;
  readonly now: Date;
  readonly messageId: string;
  readonly issuedAtSeconds?: number;
}): string {
  const nowSeconds = Math.floor(input.now.getTime() / 1_000);
  const issuedAt = input.issuedAtSeconds ?? nowSeconds - 1;
  const unsigned = `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({
    iss: "Upstash",
    sub: input.url,
    body: createHash("sha256").update(input.body, "utf8").digest("base64url"),
    iat: issuedAt,
    nbf: issuedAt - 1,
    exp: nowSeconds + 3_600,
    jti: input.messageId,
  })}`;
  return `${unsigned}.${createHmac("sha256", input.key).update(unsigned).digest("base64url")}`;
}

function signedRequest(input: {
  readonly body: string;
  readonly messageId?: string;
  readonly now: Date;
  readonly key?: string;
  readonly signedUrl?: string;
  readonly signedBody?: string;
  readonly signedMessageId?: string;
  readonly requestUrl?: string;
  readonly issuedAtSeconds?: number;
  readonly method?: string;
}): Request {
  const signedUrl = input.signedUrl ?? EXPECTED_URL;
  const headers = new Headers({
    "content-type": "application/json",
    "upstash-signature": signature({
      key: input.key ?? CURRENT_SIGNING_KEY,
      url: signedUrl,
      body: input.signedBody ?? input.body,
      now: input.now,
      messageId: input.signedMessageId ?? input.messageId ?? "signed-message-without-header",
      issuedAtSeconds: input.issuedAtSeconds,
    }),
  });
  if (input.messageId !== undefined) headers.set("upstash-message-id", input.messageId);
  return new Request(input.requestUrl ?? EXPECTED_URL, {
    method: input.method ?? "POST",
    headers,
    body: input.method === "GET" ? undefined : input.body,
  });
}

function options(
  db: Awaited<ReturnType<typeof createConversationFixture>>["db"],
  now: Date,
  wake: (message: OpaqueQStashWake) => void | Promise<void>,
) {
  return {
    database: db,
    expectedUrl: EXPECTED_URL,
    now,
    currentSigningKey: CURRENT_SIGNING_KEY,
    nextSigningKey: NEXT_SIGNING_KEY,
    wake,
  } as const;
}

describe("QStash wake authority", () => {
  it("accepts only the exact signed MARKET_CURRENT body after receipt and quota commit", async () => {
    const fixture = await createConversationFixture("qstash-market-current");
    const now = new Date();
    const wake = vi.fn(async (message: OpaqueQStashWake) => {
      expect(message).toEqual({ kind: "MARKET_CURRENT" });
      await expect(fixture.db.one(
        "select count(*)::int count from bridge_wake_receipts",
      )).resolves.toEqual({ count: 1 });
      await expect(fixture.db.one(
        `select used_count
           from deployment_quota_counters
          where quota_name='QSTASH_MESSAGES'
            and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
      )).resolves.toEqual({ used_count: 1 });
    });

    await expect(acceptQStashWake(signedRequest({
      body: MARKET_CURRENT_BODY,
      messageId: "msg-market-current",
      now,
    }), options(fixture.db, now, wake))).resolves.toEqual({ accepted: true });
    expect(wake).toHaveBeenCalledOnce();

    const forbiddenBodies = [
      { kind: "market_current" },
      { kind: "MARKET-CURRENT" },
      { kind: "MARKET_CURRENT", version: 1 },
      { kind: "MARKET_CURRENT", windowId: WINDOW_ID },
      { kind: "MARKET_CURRENT", jobId: JOB_ID },
    ];
    for (const [index, body] of forbiddenBodies.entries()) {
      await expect(acceptQStashWake(signedRequest({
        body: JSON.stringify(body),
        messageId: `msg-market-current-invalid-${index}`,
        now,
      }), options(fixture.db, now, wake))).rejects.toThrow("QSTASH_WAKE_BODY_INVALID");
    }
    expect(wake).toHaveBeenCalledOnce();
  }, 30_000);

  it("rejects declared and streamed oversized bodies before verification or database work", async () => {
    const fixture = await createConversationFixture("qstash-body-bound");
    const now = new Date();
    const wake = vi.fn();
    const verify = vi.spyOn(Receiver.prototype, "verify");
    const validBody = JSON.stringify({ jobId: JOB_ID });
    const declaredOversize = new Request(EXPECTED_URL, {
      method: "POST",
      headers: {
        "content-length": "257",
        "content-type": "application/json",
        "upstash-message-id": "msg-declared-oversize",
        "upstash-signature": "must-not-be-verified",
      },
      body: validBody,
    });

    await expect(acceptQStashWake(
      declaredOversize,
      options(fixture.db, now, wake),
    )).rejects.toThrow("QSTASH_WAKE_BODY_INVALID");

    const cancel = vi.fn();
    let emittedChunks = 0;
    const streamedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emittedChunks === 0) controller.enqueue(new Uint8Array(200).fill(0x61));
        else if (emittedChunks === 1) controller.enqueue(new Uint8Array(100).fill(0x62));
        else controller.close();
        emittedChunks += 1;
      },
      cancel,
    });
    const streamedOversize = new Request(EXPECTED_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "upstash-message-id": "msg-streamed-oversize",
        "upstash-signature": "must-not-be-verified",
      },
      body: streamedBody,
      duplex: "half",
    } as RequestInit & { readonly duplex: "half" });
    expect(streamedOversize.headers.has("content-length")).toBe(false);

    await expect(acceptQStashWake(
      streamedOversize,
      options(fixture.db, now, wake),
    )).rejects.toThrow("QSTASH_WAKE_BODY_INVALID");
    expect(cancel).toHaveBeenCalledTimes(1);

    const consumed = signedRequest({
      body: validBody,
      messageId: "msg-consumed-body",
      now,
    });
    await consumed.text();
    await expect(acceptQStashWake(
      consumed,
      options(fixture.db, now, wake),
    )).rejects.toThrow("QSTASH_WAKE_BODY_INVALID");

    const erroredBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private stream failure"));
      },
    });
    const erroredRequest = new Request(EXPECTED_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "upstash-message-id": "msg-stream-error",
        "upstash-signature": "must-not-be-verified",
      },
      body: erroredBody,
      duplex: "half",
    } as RequestInit & { readonly duplex: "half" });
    await expect(acceptQStashWake(
      erroredRequest,
      options(fixture.db, now, wake),
    )).rejects.toThrow("QSTASH_WAKE_BODY_INVALID");

    expect(verify).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    await expect(fixture.db.one(
      "select count(*)::int as count from bridge_wake_receipts",
    )).resolves.toEqual({ count: 0 });
    verify.mockRestore();
  }, 30_000);

  it("verifies current and next keys and commits receipt plus quota before wake", async () => {
    const fixture = await createConversationFixture("qstash-key-rotation");
    const now = new Date();
    const observed: OpaqueQStashWake[] = [];
    const wake = vi.fn(async (message: OpaqueQStashWake) => {
      observed.push(message);
      await expect(fixture.db.one(
        "select count(*)::int as count from bridge_wake_receipts",
      )).resolves.toEqual({ count: observed.length });
      await expect(fixture.db.one(
        `select used_count
           from deployment_quota_counters
          where quota_name='QSTASH_MESSAGES'
            and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
      )).resolves.toEqual({ used_count: observed.length });
    });
    const jobBody = JSON.stringify({ jobId: JOB_ID });
    const windowBody = JSON.stringify({ windowId: WINDOW_ID });

    await expect(acceptQStashWake(signedRequest({
      body: jobBody,
      messageId: "msg-current",
      now,
    }), options(fixture.db, now, wake))).resolves.toEqual({ accepted: true });
    await expect(acceptQStashWake(signedRequest({
      body: windowBody,
      messageId: "msg-next",
      now,
      key: NEXT_SIGNING_KEY,
    }), options(fixture.db, now, wake))).resolves.toEqual({ accepted: true });

    expect(wake).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([{ jobId: JOB_ID }, { windowId: WINDOW_ID }]);
    const receipts = await fixture.db.query<{
      readonly message_id: string;
      readonly body_digest: string;
    }>("select message_id,body_digest from bridge_wake_receipts order by message_id");
    expect(receipts).toEqual([
      {
        message_id: "msg-current",
        body_digest: createHash("sha256").update(jobBody).digest("hex"),
      },
      {
        message_id: "msg-next",
        body_digest: createHash("sha256").update(windowBody).digest("hex"),
      },
    ]);
  }, 30_000);

  it("rejects replay despite an unsigned message-ID mutation and rejects job 901 transactionally", async () => {
    const fixture = await createConversationFixture("qstash-replay-quota");
    const now = new Date();
    const wake = vi.fn();
    const body = JSON.stringify({ jobId: JOB_ID });
    const accepted = signedRequest({ body, messageId: "msg-replay", now });

    await acceptQStashWake(accepted, options(fixture.db, now, wake));
    await expect(acceptQStashWake(
      signedRequest({
        body,
        messageId: "msg-replay-mutated-header",
        signedMessageId: "msg-replay",
        now,
      }),
      options(fixture.db, now, wake),
    )).rejects.toThrow("QSTASH_MESSAGE_REPLAYED");
    expect(wake).toHaveBeenCalledTimes(1);
    await expect(fixture.db.one(
      `select used_count
         from deployment_quota_counters
        where quota_name='QSTASH_MESSAGES'
          and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    )).resolves.toEqual({ used_count: 1 });

    await fixture.db.query(
      `update deployment_quota_counters
          set used_count=900,updated_at=clock_timestamp()
        where quota_name='QSTASH_MESSAGES'
          and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    );
    await expect(acceptQStashWake(
      signedRequest({ body, messageId: "msg-901", now }),
      options(fixture.db, now, wake),
    )).rejects.toThrow("QSTASH_DAILY_QUOTA_EXHAUSTED");
    expect(wake).toHaveBeenCalledTimes(1);
    await expect(fixture.db.one(
      "select count(*)::int as count from bridge_wake_receipts where message_id='msg-901'",
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("serializes concurrent deliveries by signed message ID", async () => {
    const fixture = await createConversationFixture("qstash-concurrent-replay");
    const now = new Date();
    const wake = vi.fn();
    const body = JSON.stringify({ jobId: JOB_ID });
    const deliveries = await Promise.allSettled([
      acceptQStashWake(signedRequest({
        body,
        messageId: "delivery-one",
        signedMessageId: "signed-concurrent-message",
        now,
      }), options(fixture.db, now, wake)),
      acceptQStashWake(signedRequest({
        body,
        messageId: "delivery-two",
        signedMessageId: "signed-concurrent-message",
        now,
      }), options(fixture.db, now, wake)),
    ]);

    expect(deliveries.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = deliveries.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toEqual(expect.objectContaining({
        message: "QSTASH_MESSAGE_REPLAYED",
      }));
    }
    expect(wake).toHaveBeenCalledTimes(1);
    await expect(fixture.db.one(
      "select count(*)::int as count from bridge_wake_receipts",
    )).resolves.toEqual({ count: 1 });
    await expect(fixture.db.one(
      `select used_count
         from deployment_quota_counters
        where quota_name='QSTASH_MESSAGES'
          and bucket_date=(clock_timestamp() at time zone 'UTC')::date`,
    )).resolves.toEqual({ used_count: 1 });
  }, 30_000);

  it("accepts a signed iat within tolerance while keeping receipt times database-coherent", async () => {
    const fixture = await createConversationFixture("qstash-future-iat");
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const wake = vi.fn();
    const body = JSON.stringify({ jobId: JOB_ID });

    await expect(acceptQStashWake(signedRequest({
      body,
      messageId: "msg-future-within-tolerance",
      now,
      issuedAtSeconds: nowSeconds + 3,
    }), options(fixture.db, now, wake))).resolves.toEqual({ accepted: true });
    const receipt = await fixture.db.one<{
      readonly published_at: Date;
      readonly received_at: Date;
    }>(
      `select published_at,received_at
         from bridge_wake_receipts
        where message_id='msg-future-within-tolerance'`,
    );
    expect(receipt.published_at.getTime()).toBeLessThanOrEqual(receipt.received_at.getTime());

    await expect(acceptQStashWake(signedRequest({
      body,
      messageId: "msg-future-beyond-tolerance",
      now,
      issuedAtSeconds: nowSeconds + 60,
    }), options(fixture.db, now, wake))).rejects.toThrow("QSTASH_SIGNATURE_INVALID");
    expect(wake).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("rejects invalid signature authority, age, message ID, URL, and body shape", async () => {
    const fixture = await createConversationFixture("qstash-invalid-authority");
    const now = new Date();
    const wake = vi.fn();
    const validBody = JSON.stringify({ jobId: JOB_ID });
    const missingSignature = signedRequest({
      body: validBody,
      messageId: "msg-no-signature",
      now,
    });
    missingSignature.headers.delete("upstash-signature");
    const cases: readonly [string, Request, string][] = [
      ["missing message ID", signedRequest({ body: validBody, now }), "QSTASH_MESSAGE_ID_REQUIRED"],
      ["missing signature", missingSignature, "QSTASH_SIGNATURE_REQUIRED"],
      ["wrong URL", signedRequest({
        body: validBody,
        messageId: "msg-url",
        now,
        signedUrl: "https://wrong.example.test/wake",
        requestUrl: "https://wrong.example.test/wake",
      }), "QSTASH_URL_INVALID"],
      ["signed subject mismatch", signedRequest({
        body: validBody,
        messageId: "msg-signed-url",
        now,
        signedUrl: "https://wrong.example.test/wake",
      }), "QSTASH_SIGNATURE_INVALID"],
      ["post-sign body tamper", signedRequest({
        body: JSON.stringify({ jobId: JOB_ID, text: "private" }),
        signedBody: validBody,
        messageId: "msg-body-tamper",
        now,
      }), "QSTASH_SIGNATURE_INVALID"],
      ["expired age", signedRequest({
        body: validBody,
        messageId: "msg-old",
        now,
        issuedAtSeconds: Math.floor(now.getTime() / 1_000) - 301,
      }), "QSTASH_MESSAGE_EXPIRED"],
      ["bad signature", signedRequest({
        body: validBody,
        messageId: "msg-signature",
        now,
        key: "not-an-authorized-signing-key-with-32-bytes",
      }), "QSTASH_SIGNATURE_INVALID"],
      ["extra key", signedRequest({
        body: JSON.stringify({ jobId: JOB_ID, text: "private" }),
        messageId: "msg-extra",
        now,
      }), "QSTASH_WAKE_BODY_INVALID"],
      ["both shapes", signedRequest({
        body: JSON.stringify({ jobId: JOB_ID, windowId: WINDOW_ID }),
        messageId: "msg-both",
        now,
      }), "QSTASH_WAKE_BODY_INVALID"],
      ["impossible market window", signedRequest({
        body: JSON.stringify({ windowId: "2026-02-30T13:30Z" }),
        messageId: "msg-impossible-window",
        now,
      }), "QSTASH_WAKE_BODY_INVALID"],
      ["noncanonical bytes", signedRequest({
        body: `{ "jobId": "${JOB_ID}" }`,
        messageId: "msg-spaces",
        now,
      }), "QSTASH_WAKE_BODY_NOT_CANONICAL"],
      ["wrong method", signedRequest({
        body: validBody,
        messageId: "msg-method",
        now,
        method: "GET",
      }), "QSTASH_METHOD_INVALID"],
    ];

    for (const [label, request, code] of cases) {
      await expect(
        acceptQStashWake(request, options(fixture.db, now, wake)),
        label,
      ).rejects.toThrow(code);
    }
    expect(wake).not.toHaveBeenCalled();
    await expect(fixture.db.one(
      "select count(*)::int as count from bridge_wake_receipts",
    )).resolves.toEqual({ count: 0 });
  }, 30_000);

  it("publishes only exact opaque job or market wake bodies", async () => {
    const publishJSON = vi.fn().mockResolvedValue({ messageId: "published-1" });
    const publisher = { publishJSON };

    await expect(publishOpaqueWake(publisher, EXPECTED_URL, { jobId: JOB_ID }))
      .resolves.toEqual({ messageId: "published-1" });
    await expect(publishOpaqueWake(publisher, EXPECTED_URL, { windowId: WINDOW_ID }))
      .resolves.toEqual({ messageId: "published-1" });
    expect(publishJSON).toHaveBeenNthCalledWith(1, {
      url: EXPECTED_URL,
      body: { jobId: JOB_ID },
    });
    expect(publishJSON).toHaveBeenNthCalledWith(2, {
      url: EXPECTED_URL,
      body: { windowId: WINDOW_ID },
    });

    for (const forbidden of ["prompt", "text", "quote", "token", "url", "URL", "ciphertext"]) {
      await expect(publishOpaqueWake(publisher, EXPECTED_URL, {
        jobId: JOB_ID,
        [forbidden]: "secret",
      })).rejects.toThrow("QSTASH_WAKE_BODY_INVALID");
    }
    expect(publishJSON).toHaveBeenCalledTimes(2);
  });
});
