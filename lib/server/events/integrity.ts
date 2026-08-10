import { createHash, timingSafeEqual } from "node:crypto";

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("INVALID_JSON_NUMBER");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("INVALID_JSON_VALUE");
  }
  if (ancestors.has(value)) {
    throw new Error("CYCLIC_JSON_VALUE");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("INVALID_JSON_OBJECT");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Produces the one canonical JSON representation used by integrity checks. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

/** Hashes UTF-8 text with the repository-wide SHA-256 representation. */
export function sha256Digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Hashes semantic content after canonicalization. */
export function canonicalContentDigest(value: unknown): string {
  return sha256Digest(canonicalJson(value));
}

/** Compares hex digests without an early-exit timing signal. */
export function digestsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
