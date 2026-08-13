import { createHash } from "node:crypto";
import { Receiver } from "@upstash/qstash";
import type { EventDatabase } from "../events/types";

export const QSTASH_WAKE_MAX_AGE_SECONDS = 300 as const;
export const QSTASH_DAILY_MESSAGE_LIMIT = 900 as const;

const QSTASH_CLOCK_TOLERANCE_SECONDS = 5;
const MAX_WAKE_BODY_BYTES = 256;
const MAX_SIGNATURE_LENGTH = 8_192;
const JOB_WAKE_KEYS = Object.freeze(["jobId"] as const);
const WINDOW_WAKE_KEYS = Object.freeze(["windowId"] as const);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WINDOW_ID_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$/u;
const MESSAGE_ID_PATTERN = /^[\x21-\x7e]{1,200}$/u;

export type OpaqueQStashWake =
  | { readonly jobId: string }
  | { readonly windowId: string };

export interface AcceptQStashWakeOptions {
  readonly database: EventDatabase;
  readonly expectedUrl: string;
  readonly now: Date;
  readonly currentSigningKey: string;
  readonly nextSigningKey: string;
  readonly wake: (message: OpaqueQStashWake) => void | Promise<void>;
}

export interface OpaqueWakePublisher {
  publishJSON(input: {
    readonly url: string;
    readonly body: OpaqueQStashWake;
  }): Promise<unknown>;
}

interface VerifiedTokenPayload {
  readonly issuedAtSeconds: number;
  readonly messageId: string;
}

function exactObject(
  value: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== allowedKeys.length
    || keys.some((key, index) => key !== allowedKeys[index])
  ) {
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  }
  return record;
}

function parseJobWake(value: unknown): OpaqueQStashWake {
  const body = exactObject(value, JOB_WAKE_KEYS);
  if (typeof body.jobId !== "string" || !UUID_PATTERN.test(body.jobId)) {
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  }
  return Object.freeze({ jobId: body.jobId });
}

function parseWindowWake(value: unknown): OpaqueQStashWake {
  const body = exactObject(value, WINDOW_WAKE_KEYS);
  if (typeof body.windowId !== "string" || !WINDOW_ID_PATTERN.test(body.windowId)) {
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  }
  const instant = new Date(body.windowId.replace(/Z$/u, ":00Z"));
  const minute = Number(body.windowId.slice(14, 16));
  if (
    !Number.isFinite(instant.getTime())
    || `${instant.toISOString().slice(0, 16)}Z` !== body.windowId
    || minute % 5 !== 0
  ) {
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  }
  return Object.freeze({ windowId: body.windowId });
}

function parseOpaqueWake(value: unknown): OpaqueQStashWake {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === JOB_WAKE_KEYS[0]) return parseJobWake(value);
    if (keys.length === 1 && keys[0] === WINDOW_WAKE_KEYS[0]) return parseWindowWake(value);
  }
  throw new Error("QSTASH_WAKE_BODY_INVALID");
}

function parseCanonicalWake(rawBody: string): OpaqueQStashWake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  }
  const wake = parseOpaqueWake(parsed);
  if (JSON.stringify(wake) !== rawBody) {
    throw new Error("QSTASH_WAKE_BODY_NOT_CANONICAL");
  }
  return wake;
}

function requiredHeader(request: Request, name: string, code: string): string {
  const value = request.headers.get(name);
  if (!value || value !== value.trim()) throw new Error(code);
  return value;
}

function validHttpsUrl(value: string, code: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.href !== value
  ) {
    throw new Error(code);
  }
  return value;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("QSTASH_TIME_INVALID");
  }
  return value;
}

function signingKey(value: string): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096) {
    throw new Error("QSTASH_SIGNING_KEY_INVALID");
  }
  return value;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Rejection is already fail-closed; cancellation is best-effort cleanup.
  }
}

async function rawAsciiBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      await cancelBody(request.body);
      throw new Error("QSTASH_WAKE_BODY_INVALID");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > MAX_WAKE_BODY_BYTES) {
      await cancelBody(request.body);
      throw new Error("QSTASH_WAKE_BODY_INVALID");
    }
  }

  const body = request.body;
  if (!body || request.bodyUsed || body.locked) {
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel();
    } catch {
      // The body error is authoritative even when stream cleanup also fails.
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        value.byteLength > MAX_WAKE_BODY_BYTES - totalBytes
        || value.some((byte) => byte > 0x7f)
      ) {
        await cancel();
        throw new Error("QSTASH_WAKE_BODY_INVALID");
      }
      if (value.byteLength > 0) {
        chunks.push(value.slice());
        totalBytes += value.byteLength;
      }
    }
  } catch {
    await cancel();
    throw new Error("QSTASH_WAKE_BODY_INVALID");
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new Error("QSTASH_WAKE_BODY_INVALID");

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function verifiedTokenPayload(signature: string): VerifiedTokenPayload {
  const segments = signature.split(".");
  if (segments.length !== 3) throw new Error("QSTASH_SIGNATURE_INVALID");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("QSTASH_SIGNATURE_INVALID");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("QSTASH_SIGNATURE_INVALID");
  }
  const claims = payload as Record<string, unknown>;
  const issuedAtSeconds = claims.iat;
  if (!Number.isSafeInteger(issuedAtSeconds) || (issuedAtSeconds as number) <= 0) {
    throw new Error("QSTASH_SIGNATURE_INVALID");
  }
  if (typeof claims.jti !== "string" || !MESSAGE_ID_PATTERN.test(claims.jti)) {
    throw new Error("QSTASH_SIGNATURE_INVALID");
  }
  return {
    issuedAtSeconds: issuedAtSeconds as number,
    messageId: claims.jti,
  };
}

function assertMaximumAge(payload: VerifiedTokenPayload, now: Date): Date {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (payload.issuedAtSeconds > nowSeconds + QSTASH_CLOCK_TOLERANCE_SECONDS) {
    throw new Error("QSTASH_SIGNATURE_INVALID");
  }
  if (nowSeconds - payload.issuedAtSeconds > QSTASH_WAKE_MAX_AGE_SECONDS) {
    throw new Error("QSTASH_MESSAGE_EXPIRED");
  }
  return new Date(payload.issuedAtSeconds * 1_000);
}

async function recordReceiptAndQuota(
  database: EventDatabase,
  input: {
    readonly messageId: string;
    readonly bodyDigest: string;
    readonly publishedAt: Date;
  },
): Promise<void> {
  await database.transaction(async (transaction) => {
    const receipt = await transaction.query(
      `insert into bridge_wake_receipts (message_id,body_digest,published_at)
       values ($1,$2,least($3::timestamptz,statement_timestamp()))
       on conflict (message_id) do nothing
       returning message_id`,
      [input.messageId, input.bodyDigest, input.publishedAt],
    );
    if (receipt.length !== 1) throw new Error("QSTASH_MESSAGE_REPLAYED");

    const quota = await transaction.query(
      `insert into deployment_quota_counters (
         quota_name,bucket_date,used_count,limit_count,updated_at
       ) values (
         'QSTASH_MESSAGES',(clock_timestamp() at time zone 'UTC')::date,
         1,$1,clock_timestamp()
       )
       on conflict (quota_name,bucket_date) do update
         set used_count=deployment_quota_counters.used_count+1,
             updated_at=clock_timestamp()
       where deployment_quota_counters.used_count<deployment_quota_counters.limit_count
       returning used_count`,
      [QSTASH_DAILY_MESSAGE_LIMIT],
    );
    if (quota.length !== 1) throw new Error("QSTASH_DAILY_QUOTA_EXHAUSTED");
  });
}

export async function acceptQStashWake(
  request: Request,
  options: AcceptQStashWakeOptions,
): Promise<{ readonly accepted: true }> {
  if (request.method !== "POST") throw new Error("QSTASH_METHOD_INVALID");
  const expectedUrl = validHttpsUrl(options.expectedUrl, "QSTASH_URL_INVALID");
  if (request.url !== expectedUrl) throw new Error("QSTASH_URL_INVALID");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      !== "application/json") {
    throw new Error("QSTASH_CONTENT_TYPE_INVALID");
  }
  const now = validNow(options.now);
  // This delivery header is unsigned protocol metadata; signed JWT jti owns replay identity.
  const deliveryMessageId = requiredHeader(
    request, "upstash-message-id", "QSTASH_MESSAGE_ID_REQUIRED",
  );
  if (!MESSAGE_ID_PATTERN.test(deliveryMessageId)) {
    throw new Error("QSTASH_MESSAGE_ID_INVALID");
  }
  const signature = requiredHeader(
    request, "upstash-signature", "QSTASH_SIGNATURE_REQUIRED",
  );
  if (signature.length > MAX_SIGNATURE_LENGTH) throw new Error("QSTASH_SIGNATURE_INVALID");
  const rawBody = await rawAsciiBody(request);
  const receiver = new Receiver({
    currentSigningKey: signingKey(options.currentSigningKey),
    nextSigningKey: signingKey(options.nextSigningKey),
    devMode: false,
  });
  try {
    const verified = await receiver.verify({
      signature,
      body: rawBody,
      url: expectedUrl,
      clockTolerance: QSTASH_CLOCK_TOLERANCE_SECONDS,
      upstashRegion: request.headers.get("upstash-region") ?? undefined,
    });
    if (!verified) throw new Error("QSTASH_SIGNATURE_INVALID");
  } catch {
    throw new Error("QSTASH_SIGNATURE_INVALID");
  }
  const token = verifiedTokenPayload(signature);
  const publishedAt = assertMaximumAge(token, now);
  const wake = parseCanonicalWake(rawBody);
  await recordReceiptAndQuota(options.database, {
    messageId: token.messageId,
    bodyDigest: createHash("sha256").update(rawBody, "utf8").digest("hex"),
    publishedAt,
  });
  await options.wake(wake);
  return Object.freeze({ accepted: true });
}

export async function publishOpaqueWake(
  publisher: OpaqueWakePublisher,
  destinationUrl: string,
  body: unknown,
): Promise<unknown> {
  const url = validHttpsUrl(destinationUrl, "QSTASH_DESTINATION_URL_INVALID");
  const wake = parseOpaqueWake(body);
  return publisher.publishJSON({ url, body: wake });
}
