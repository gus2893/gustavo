import { createHmac } from "node:crypto";
import { canonicalContentDigest } from "../events/integrity";
import type { MemoryScope } from "./types";

export const MEMORY_VECTOR_BUCKET_LIMIT = 6;

function validatedVector(vector: readonly number[]): readonly number[] {
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > 8_192
      || vector.some((component) => typeof component !== "number"
        || !Number.isFinite(component) || Math.abs(component) > 3.4e38)) {
    throw new Error("INVALID_MEMORY_SEARCH_EMBEDDING");
  }
  const norm = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("INVALID_MEMORY_SEARCH_EMBEDDING");
  return vector;
}

function componentSign(value: number): "-" | "0" | "+" {
  return value < 0 ? "-" : value > 0 ? "+" : "0";
}

function projectionCoefficient(projection: number, ordinal: number): 1 | -1 {
  let value = Math.imul(projection + 1, 0x9e3779b1) ^ Math.imul(ordinal + 1, 0x85ebca6b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value & 1) === 0 ? 1 : -1;
}

function projectionBand(vector: readonly number[], band: number): string {
  return Array.from({ length: 4 }, (_, offset) => {
    const projection = band * 4 + offset;
    const value = vector.reduce((sum, component, ordinal) => (
      sum + component * projectionCoefficient(projection, ordinal)
    ), 0);
    return value >= 0 ? "1" : "0";
  }).join("");
}

function bucketDocuments(vector: readonly number[]): readonly string[] {
  validatedVector(vector);
  const ranked = vector.map((component, ordinal) => ({
    ordinal, magnitude: Math.abs(component), sign: componentSign(component),
  })).sort((left, right) => right.magnitude - left.magnitude || left.ordinal - right.ordinal);
  const dominant = ranked[0];
  const top = ranked.slice(0, Math.min(8, ranked.length));
  return Object.freeze([
    `dominant:${dominant.ordinal}:${dominant.sign}`,
    `top:${top.map(({ ordinal, sign }) => `${ordinal}${sign}`).join(",")}`,
    `sign:${vector.slice(0, 16).map(componentSign).join("")}`,
    ...Array.from({ length: 3 }, (_, band) => `projection:${band}:${projectionBand(vector, band)}`),
  ]);
}

export function memoryVectorBucketDigests(input: {
  readonly vector: readonly number[];
  readonly scope: MemoryScope;
  readonly embeddingVersion: string;
  readonly indexKey: Buffer | null;
}): readonly string[] {
  if (input.scope !== "PUBLIC" && input.indexKey === null) {
    throw new Error("MEMORY_RETRIEVAL_KEY_REQUIRED");
  }
  return Object.freeze(bucketDocuments(input.vector).map((bucket) => {
    const documentDigest = canonicalContentDigest({
      domain: "gustavo:memory-vector-bucket:v1",
      scope: input.scope,
      embeddingVersion: input.embeddingVersion,
      bucket,
    });
    return input.indexKey === null
      ? documentDigest
      : createHmac("sha256", input.indexKey).update(documentDigest).digest("hex");
  }));
}
