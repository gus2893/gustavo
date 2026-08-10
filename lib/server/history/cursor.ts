import { createHmac, timingSafeEqual } from "node:crypto";

export type OpaqueCursorValue =
  | boolean
  | number
  | string
  | null
  | readonly OpaqueCursorValue[]
  | { readonly [key: string]: OpaqueCursorValue };

function signingKey(): Buffer {
  const encoded = process.env.GUSTAVO_CURSOR_SIGNING_KEY;
  if (!encoded) {
    throw new Error("CURSOR_SIGNING_KEY_REQUIRED");
  }
  let key: Buffer;
  try {
    key = Buffer.from(encoded, "base64");
  } catch {
    throw new Error("INVALID_CURSOR_SIGNING_KEY");
  }
  if (key.length < 32 || key.toString("base64") !== encoded) {
    throw new Error("INVALID_CURSOR_SIGNING_KEY");
  }
  return key;
}

function signature(encodedPayload: string): Buffer {
  return createHmac("sha256", signingKey())
    .update(encodedPayload, "utf8")
    .digest();
}

export function encodeOpaqueCursor(payload: OpaqueCursorValue): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const encodedSignature = signature(encodedPayload).toString("base64url");
  return `${encodedPayload}.${encodedSignature}`;
}

export function decodeOpaqueCursor(cursor: string): unknown {
  if (cursor.length < 3 || cursor.length > 4_096) {
    throw new Error("INVALID_CURSOR");
  }
  const parts = cursor.split(".");
  if (parts.length !== 2) {
    throw new Error("INVALID_CURSOR");
  }
  const [encodedPayload, encodedSignature] = parts;
  if (
    !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
    || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)
  ) {
    throw new Error("INVALID_CURSOR");
  }

  const suppliedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = signature(encodedPayload);
  if (
    suppliedSignature.length !== expectedSignature.length
    || suppliedSignature.toString("base64url") !== encodedSignature
    || !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new Error("INVALID_CURSOR_SIGNATURE");
  }

  const payloadBytes = Buffer.from(encodedPayload, "base64url");
  if (payloadBytes.toString("base64url") !== encodedPayload) {
    throw new Error("INVALID_CURSOR");
  }
  try {
    return JSON.parse(payloadBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("INVALID_CURSOR");
  }
}
