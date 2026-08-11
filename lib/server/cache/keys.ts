import { createHash } from "node:crypto";

export const CACHE_NAMESPACES = Object.freeze([
  "configuration",
  "policy",
  "public-metadata",
  "main-state",
  "broadcast",
  "node-dossier",
  "handoff",
  "context",
  "retrieval",
  "challenge-snapshot",
  "session",
  "rate-limit",
] as const);

export type CacheNamespace = typeof CACHE_NAMESPACES[number];
export type CacheScope = "PUBLIC" | "PRIVATE_ACCOUNT" | "SHARED" | "OPERATOR";

const CACHE_NAMESPACE_SET: ReadonlySet<string> = new Set(CACHE_NAMESPACES);
const CACHE_SCOPE_SET: ReadonlySet<string> = new Set([
  "PUBLIC",
  "PRIVATE_ACCOUNT",
  "SHARED",
  "OPERATOR",
]);
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_COMPONENT_LENGTH = 200;
const CACHE_PREFIX = "gustavo-cache:v1";

declare const versionKeyBrand: unique symbol;
declare const pointerKeyBrand: unique symbol;

export type CacheVersionKey = string & { readonly [versionKeyBrand]: "CacheVersionKey" };
export type CachePointerKey = string & { readonly [pointerKeyBrand]: "CachePointerKey" };
export type TypedCacheKey = CacheVersionKey | CachePointerKey;

export interface CacheVersionKeyInput {
  readonly namespace: CacheNamespace;
  readonly scope: CacheScope;
  readonly entityId: string;
  readonly identityId?: string;
  readonly topologyVersion?: string;
  readonly sourceHighWater: string;
  readonly stateVersion: string | number;
  readonly policyVersion: string;
  readonly schemaVersion: number;
}

export interface CachePointerKeyInput {
  readonly namespace: CacheNamespace;
  readonly scope: CacheScope;
  readonly entityId: string;
  readonly identityId?: string;
  readonly topologyVersion?: string;
  readonly policyVersion: string;
  readonly schemaVersion: number;
}

export interface CacheKeyDescriptor {
  readonly kind: "VERSION" | "POINTER";
  readonly namespace: CacheNamespace;
  readonly scope: CacheScope;
  readonly entityId: string;
  readonly identityId: string;
  readonly topologyVersion: string;
  readonly sourceHighWater: string;
  readonly stateVersion: string;
  readonly policyVersion: string;
  readonly schemaVersion: number;
}

function invalid(field: string): never {
  throw new Error(`CACHE_KEY_${field}_INVALID`);
}

function component(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_COMPONENT_LENGTH
    || value !== value.trim()
    || !SAFE_COMPONENT.test(value)
  ) {
    return invalid(field);
  }
  return value;
}

function stateVersion(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return invalid("STATE_VERSION");
    return String(value);
  }
  return component(value, "STATE_VERSION");
}

function schemaVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    return invalid("SCHEMA_VERSION");
  }
  return value;
}

function canonicalDescriptor(descriptor: CacheKeyDescriptor): string {
  return JSON.stringify([
    descriptor.kind,
    descriptor.namespace,
    descriptor.scope,
    descriptor.entityId,
    descriptor.identityId,
    descriptor.topologyVersion,
    descriptor.sourceHighWater,
    descriptor.stateVersion,
    descriptor.policyVersion,
    descriptor.schemaVersion,
  ]);
}

function serialize(descriptor: CacheKeyDescriptor): string {
  const canonical = canonicalDescriptor(descriptor);
  const encoded = Buffer.from(canonical, "utf8").toString("base64url");
  const digest = createHash("sha256").update(canonical).digest("hex");
  const kind = descriptor.kind === "VERSION" ? "v" : "p";
  return `${CACHE_PREFIX}:${kind}:${encoded}:${digest}`;
}

function baseDescriptor(
  input: CachePointerKeyInput,
  kind: CacheKeyDescriptor["kind"],
): Omit<CacheKeyDescriptor, "sourceHighWater" | "stateVersion"> {
  if (!CACHE_NAMESPACE_SET.has(input.namespace)) return invalid("NAMESPACE");
  if (!CACHE_SCOPE_SET.has(input.scope)) return invalid("SCOPE");
  const entityId = component(input.entityId, "ENTITY_ID");
  const identityId = component(input.identityId ?? entityId, "IDENTITY_ID");
  return Object.freeze({
    kind,
    namespace: input.namespace,
    scope: input.scope,
    entityId,
    identityId,
    topologyVersion: component(input.topologyVersion ?? "single-main-node-v1", "TOPOLOGY_VERSION"),
    policyVersion: component(input.policyVersion, "POLICY_VERSION"),
    schemaVersion: schemaVersion(input.schemaVersion),
  });
}

export function cacheKey(input: CacheVersionKeyInput): CacheVersionKey {
  const base = baseDescriptor(input, "VERSION");
  const descriptor: CacheKeyDescriptor = Object.freeze({
    ...base,
    sourceHighWater: component(input.sourceHighWater, "SOURCE_HIGH_WATER"),
    stateVersion: stateVersion(input.stateVersion),
  });
  return serialize(descriptor) as CacheVersionKey;
}

export function cachePointerKey(input: CachePointerKeyInput): CachePointerKey {
  const base = baseDescriptor(input, "POINTER");
  const descriptor: CacheKeyDescriptor = Object.freeze({
    ...base,
    // Pointer keys contain no projection value. These sentinels make their
    // deliberately-current role explicit while all data remains versioned.
    sourceHighWater: "CURRENT_POINTER",
    stateVersion: "CURRENT_POINTER",
  });
  return serialize(descriptor) as CachePointerKey;
}

export function inspectCacheKey(key: TypedCacheKey): CacheKeyDescriptor {
  if (typeof key !== "string") throw new Error("CACHE_KEY_INVALID");
  const parts = key.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== CACHE_PREFIX) {
    throw new Error("CACHE_KEY_INVALID");
  }
  const [, , kind, encoded, claimedDigest] = parts;
  if ((kind !== "v" && kind !== "p") || !encoded || !claimedDigest || !SHA256.test(claimedDigest)) {
    throw new Error("CACHE_KEY_INVALID");
  }
  let parsed: unknown;
  let canonical: string;
  try {
    canonical = Buffer.from(encoded, "base64url").toString("utf8");
    parsed = JSON.parse(canonical);
  } catch {
    throw new Error("CACHE_KEY_INVALID");
  }
  const digest = createHash("sha256").update(canonical).digest("hex");
  if (
    digest !== claimedDigest
    || Buffer.from(canonical, "utf8").toString("base64url") !== encoded
    || !Array.isArray(parsed)
    || parsed.length !== 10
  ) {
    throw new Error("CACHE_KEY_INVALID");
  }
  const [parsedKind, namespace, scope, entityId, identityId, topologyVersion,
    sourceHighWater, parsedStateVersion, policyVersion, parsedSchemaVersion] = parsed;
  if (parsedKind !== (kind === "v" ? "VERSION" : "POINTER")) {
    throw new Error("CACHE_KEY_INVALID");
  }
  const base = baseDescriptor({
    namespace: namespace as CacheNamespace,
    scope: scope as CacheScope,
    entityId: entityId as string,
    identityId: identityId as string,
    topologyVersion: topologyVersion as string,
    policyVersion: policyVersion as string,
    schemaVersion: parsedSchemaVersion as number,
  }, parsedKind);
  const descriptor: CacheKeyDescriptor = Object.freeze({
    ...base,
    sourceHighWater: component(sourceHighWater, "SOURCE_HIGH_WATER"),
    stateVersion: stateVersion(parsedStateVersion as string),
  });
  if (canonicalDescriptor(descriptor) !== canonical) throw new Error("CACHE_KEY_INVALID");
  if (descriptor.kind === "POINTER"
      && (descriptor.sourceHighWater !== "CURRENT_POINTER"
        || descriptor.stateVersion !== "CURRENT_POINTER")) {
    throw new Error("CACHE_KEY_INVALID");
  }
  return descriptor;
}

export function isCacheVersionKey(key: TypedCacheKey): key is CacheVersionKey {
  return inspectCacheKey(key).kind === "VERSION";
}

export function isCachePointerKey(key: TypedCacheKey): key is CachePointerKey {
  return inspectCacheKey(key).kind === "POINTER";
}
