import { describe, expect, it, vi } from "vitest";
import {
  MemoryCacheBackend,
  ValkeyCacheBackend,
  cacheKey,
  cachePointerKey,
  prewarmCriticalProjections,
  projectionManifestHash,
  projectionCategoryManifests,
  projectionValueHash,
  rebuildCriticalProjections,
  scopedCache,
  type CriticalProjectionRecord,
  type CriticalProjectionSource,
  type CacheBackend,
  type ValkeyTransport,
} from "../../lib/server/cache/store";
import {
  InMemoryCacheJobRepository,
  processNextCacheJob,
  type CacheChangeSource,
} from "../../worker/cache/invalidate";
import { runProjectionRebuild } from "../../scripts/rebuild-projections";

const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const TOPOLOGY_VERSION = "single-main-node-v1";

function key(overrides: Partial<Parameters<typeof cacheKey>[0]> = {}) {
  return cacheKey({
    namespace: "context",
    scope: "PRIVATE_ACCOUNT",
    entityId: "acct-a",
    identityId: "acct-a",
    topologyVersion: TOPOLOGY_VERSION,
    sourceHighWater: "e9",
    stateVersion: "2",
    policyVersion: "v1",
    schemaVersion: 1,
    ...overrides,
  });
}

function pointer(overrides: Partial<Parameters<typeof cachePointerKey>[0]> = {}) {
  return cachePointerKey({
    namespace: "context",
    scope: "PRIVATE_ACCOUNT",
    entityId: "acct-a",
    identityId: "acct-a",
    topologyVersion: TOPOLOGY_VERSION,
    policyVersion: "v1",
    schemaVersion: 1,
    ...overrides,
  });
}

function accountCache(backend = new MemoryCacheBackend()) {
  return scopedCache({
    backend,
    encryptionKey: ENCRYPTION_KEY,
    authorize: (descriptor) => descriptor.scope !== "PRIVATE_ACCOUNT"
      || descriptor.identityId === "acct-a",
    random: () => 0.5,
  });
}

function authorizedContextPack(text = "Private account excerpt") {
  return {
    kind: "AUTHORIZED_CONTEXT_PACK" as const,
    accountId: "acct-a",
    sourceEventIds: ["10000000-0000-4000-8000-000000000010"],
    sourceHighWater: "e9",
    generatedAt: "2026-08-11T00:00:00.000Z",
    excerpts: [{
      sourceEventId: "10000000-0000-4000-8000-000000000010",
      text,
    }],
  };
}

function record(
  id: string,
  namespace: CriticalProjectionRecord["key"]["namespace"],
  scope: CriticalProjectionRecord["key"]["scope"],
  entityId: string,
  value: CriticalProjectionRecord["value"],
  versionOrdinal: string,
): CriticalProjectionRecord {
  const sourceHighWater = `e${versionOrdinal}`;
  const sourceLinkedValue = Object.freeze({
    ...(value as Record<string, unknown>),
    sourceHighWater,
  }) as unknown as CriticalProjectionRecord["value"];
  const projectionKey = {
    namespace,
    scope,
    entityId,
    identityId: scope === "PRIVATE_ACCOUNT" ? entityId : "gustavo-main",
    topologyVersion: TOPOLOGY_VERSION,
    sourceHighWater,
    stateVersion: versionOrdinal,
    policyVersion: "v1",
    schemaVersion: 1,
  } as const;
  return Object.freeze({
    id,
    key: projectionKey,
    versionOrdinal,
    value: sourceLinkedValue,
    sourceRowCount: 1,
    contentHash: projectionValueHash(sourceLinkedValue),
  });
}

function nodeDossierRecord(id: string, accountId: string, versionOrdinal: string) {
  const sourceEventId = `10000000-0000-4000-8000-${versionOrdinal.padStart(12, "0")}`;
  return record(id, "node-dossier", "PRIVATE_ACCOUNT", accountId, {
    kind: "NODE_DOSSIER", accountId, nodeBrainId: `node-${accountId}`,
    conversationId: `conversation-${accountId}`, sourceEventIds: [sourceEventId],
    sourceHighWater: `e${versionOrdinal}`, mainStateVersion: "100", route: {
      classificationConfidence: 0.9, mode: "MAIN_DEFAULT", policyVersion: "node-routing-v1",
      reason: "MAIN_COVERED",
      response: { authority: "MAIN", canonical: true, label: "MAIN POSITION" },
      sourceIds: [sourceEventId],
    },
    occurredAt: "2026-08-11T00:00:00.000Z",
  }, versionOrdinal);
}

function projectionSource(records: readonly CriticalProjectionRecord[]): CriticalProjectionSource {
  const sorted = [...records].sort((left, right) => left.id.localeCompare(right.id));
  return {
    name: "POSTGRES",
    async readManifest(checkpoint) {
      return {
        checkpoint,
        sourceHighWater: checkpoint,
        recordCount: sorted.length,
        manifestHash: projectionManifestHash(sorted),
        categories: projectionCategoryManifests(sorted),
      };
    },
    async readPage({ afterId, limit }) {
      const remaining = sorted.filter((item) => afterId === null || item.id > afterId);
      return {
        records: remaining.slice(0, limit),
        nextCursor: remaining.length > limit ? remaining[limit - 1]!.id : null,
      };
    },
  };
}

describe("cache isolation", () => {
  it("binds version keys to namespace, scope, entity, identity, topology, and every source version", () => {
    const baseline = key();
    const variants = [
      key({ namespace: "handoff" }),
      key({ scope: "SHARED" }),
      key({ entityId: "acct-b" }),
      key({ identityId: "acct-b" }),
      key({ topologyVersion: "topology-v2" }),
      key({ sourceHighWater: "e10" }),
      key({ stateVersion: "3" }),
      key({ policyVersion: "v2" }),
      key({ schemaVersion: 2 }),
    ];
    expect(new Set([baseline, ...variants])).toHaveLength(variants.length + 1);
    expect(String(baseline)).not.toContain("acct-a");
    expect(() => key({ entityId: "../acct-a\n" })).toThrow("CACHE_KEY_ENTITY_ID_INVALID");
  });

  it("authorizes before a distributed read or fallback and never crosses accounts", async () => {
    const backend = new MemoryCacheBackend();
    const owner = accountCache(backend);
    const protectedKey = key();
    await owner.set(protectedKey, authorizedContextPack("private-a"), { ttlSeconds: 30, encrypted: true });

    const denied = scopedCache({
      backend,
      encryptionKey: ENCRYPTION_KEY,
      authorize: () => false,
    });
    const load = vi.fn(async () => ({ value: { text: "should-not-load" }, rowsRead: 1 }));
    const readsBefore = backend.stats().reads;
    await expect(denied.readThrough(protectedKey, {
      maxRows: 10,
      load,
      ttlSeconds: 30,
      encrypted: true,
    })).rejects.toThrow("CACHE_NOT_AUTHORIZED");
    expect(load).not.toHaveBeenCalled();
    expect(backend.stats().reads).toBe(readsBefore);
    expect(await owner.get(key({ identityId: "acct-b", entityId: "acct-b" }))).toBeNull();
  });

  it("encrypts minimized protected packs, limits their TTL, and rejects raw transcripts", async () => {
    const backend = new MemoryCacheBackend();
    const cache = accountCache(backend);
    const protectedKey = key();
    await cache.set(protectedKey, authorizedContextPack("private-a"), {
      ttlSeconds: 30,
      encrypted: true,
    });
    const stored = backend.peek(String(protectedKey));
    expect(stored).not.toContain("private-a");
    expect(await cache.get(protectedKey)).toMatchObject({
      kind: "AUTHORIZED_CONTEXT_PACK",
      excerpts: [{ text: "private-a" }],
    });
    await expect(cache.set(key({ sourceHighWater: "e10" }), { rawTranscript: "secret" }, {
      ttlSeconds: 30,
      encrypted: true,
    })).rejects.toThrow("CACHE_RAW_PRIVATE_TRANSCRIPT_PROHIBITED");
    await expect(cache.set(key({ sourceHighWater: "e11" }), {
      ...authorizedContextPack("secret"), sourceHighWater: "e11",
    }, {
      ttlSeconds: 301,
      encrypted: true,
    })).rejects.toThrow("CACHE_PROTECTED_TTL_INVALID");
    await expect(cache.set(key({ sourceHighWater: "e12" }), {
      ...authorizedContextPack("secret"), sourceHighWater: "e12",
    }, {
      ttlSeconds: 30,
      encrypted: false,
    })).rejects.toThrow("CACHE_PROTECTED_ENCRYPTION_REQUIRED");
  });

  it("authorizes protected writes and pointer publication before any backend access", async () => {
    const backend = new MemoryCacheBackend();
    const denied = scopedCache({
      backend,
      encryptionKey: ENCRYPTION_KEY,
      authorize: () => false,
    });
    const protectedKey = key();
    const current = pointer();
    const before = backend.stats();
    await expect(denied.set(protectedKey, authorizedContextPack(), {
      ttlSeconds: 30,
      encrypted: true,
    })).rejects.toThrow("CACHE_NOT_AUTHORIZED");
    await expect(denied.publish({
      pointerKey: current,
      versionKey: protectedKey,
      versionOrdinal: "9",
      value: authorizedContextPack(),
      options: { ttlSeconds: 30, encrypted: true },
    })).rejects.toThrow("CACHE_NOT_AUTHORIZED");
    expect(backend.stats()).toEqual(before);
  });

  it("accepts only typed source-linked protected DTOs and rejects disguised whole transcripts", async () => {
    const cache = accountCache();
    await cache.set(key(), authorizedContextPack(), { ttlSeconds: 30, encrypted: true });
    await expect(cache.set(key({ sourceHighWater: "e10", stateVersion: "10" }), {
      kind: "AUTHORIZED_CONTEXT_PACK",
      accountId: "acct-a",
      sourceEventIds: ["10000000-0000-4000-8000-000000000010"],
      sourceHighWater: "e10",
      generatedAt: "2026-08-11T00:00:00.000Z",
      excerpts: [],
      innocuousPayloadName: "complete private conversation copied under another field",
    }, { ttlSeconds: 30, encrypted: true })).rejects.toThrow(
      "CACHE_PROTECTED_PROJECTION_INVALID",
    );
    await expect(cache.set(key({ sourceHighWater: "e11", stateVersion: "11" }), {
      text: "complete private conversation without a transcript-named field",
      sourceIds: ["10000000-0000-4000-8000-000000000010"],
    }, { ttlSeconds: 30, encrypted: true })).rejects.toThrow(
      "CACHE_PROTECTED_PROJECTION_INVALID",
    );
  });

  it("keeps immutable version values and ignores late pointer publication or invalidation", async () => {
    const cache = accountCache();
    const current = pointer();
    const oldVersion = key({ sourceHighWater: "e9", stateVersion: "9" });
    const newVersion = key({ sourceHighWater: "e10", stateVersion: "10" });
    await cache.publish({
      pointerKey: current,
      versionKey: newVersion,
      versionOrdinal: "10",
      value: { ...authorizedContextPack("new"), sourceHighWater: "e10" },
      options: { ttlSeconds: 30, encrypted: true },
    });
    await cache.publish({
      pointerKey: current,
      versionKey: oldVersion,
      versionOrdinal: "9",
      value: { ...authorizedContextPack("old"), sourceHighWater: "e9" },
      options: { ttlSeconds: 30, encrypted: true },
    });
    expect(await cache.getCurrent(current)).toMatchObject({ excerpts: [{ text: "new" }] });
    expect(await cache.invalidate(current, { throughOrdinal: "9" })).toBe("STALE_IGNORED");
    expect(await cache.getCurrent(current)).toMatchObject({ excerpts: [{ text: "new" }] });
    expect(await cache.invalidate(current, { throughOrdinal: "10" })).toBe("INVALIDATED");
    expect(await cache.getCurrent(current)).toBeNull();
    await expect(cache.set(newVersion, { ...authorizedContextPack("mutated"), sourceHighWater: "e10" }, {
      ttlSeconds: 30,
      encrypted: true,
    })).rejects.toThrow("CACHE_IMMUTABLE_VERSION_CONFLICT");
  });

  it("single-flights bounded cache-aside fallbacks and gives negative results a short TTL", async () => {
    let now = 1_000;
    const backend = new MemoryCacheBackend({ now: () => now });
    const cache = scopedCache({ backend, now: () => now, random: () => 0.5 });
    const publicKey = key({
      namespace: "public-metadata",
      scope: "PUBLIC",
      entityId: "feed",
      identityId: "anonymous",
    });
    let calls = 0;
    const load = async () => {
      calls += 1;
      await Promise.resolve();
      return { value: { generatedAt: "2026-08-11T00:00:00.000Z" }, rowsRead: 4 };
    };
    const values = await Promise.all(Array.from({ length: 20 }, () => cache.readThrough(publicKey, {
      maxRows: 5,
      load,
      ttlSeconds: 60,
    })));
    expect(calls).toBe(1);
    expect(values.every((value) => value?.generatedAt === "2026-08-11T00:00:00.000Z")).toBe(true);

    const missingKey = key({
      namespace: "public-metadata",
      scope: "PUBLIC",
      entityId: "missing",
      identityId: "anonymous",
    });
    const missing = vi.fn(async () => ({ value: null, rowsRead: 0 }));
    expect(await cache.readThrough(missingKey, {
      maxRows: 5,
      load: missing,
      ttlSeconds: 60,
      negativeTtlSeconds: 3,
    })).toBeNull();
    expect(await cache.readThrough(missingKey, {
      maxRows: 5,
      load: missing,
      ttlSeconds: 60,
      negativeTtlSeconds: 3,
    })).toBeNull();
    expect(missing).toHaveBeenCalledTimes(1);
    now += 3_001;
    await cache.readThrough(missingKey, {
      maxRows: 5,
      load: missing,
      ttlSeconds: 60,
      negativeTtlSeconds: 3,
    });
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it("degrades Valkey read, lease, and write failures to an authorized bounded authority", async () => {
    class FaultBackend extends MemoryCacheBackend implements CacheBackend {
      constructor(readonly failure: "READ" | "LEASE" | "WRITE") { super(); }
      override async read(storageKey: string) {
        if (this.failure === "READ") throw new Error("VALKEY_READ_FAILED");
        return super.read(storageKey);
      }
      override async acquireLease(storageKey: string, owner: string, expiresAt: number) {
        if (this.failure === "LEASE") throw new Error("VALKEY_LEASE_FAILED");
        return super.acquireLease(storageKey, owner, expiresAt);
      }
      override async putImmutable(storageKey: string, value: string, expiresAt: number) {
        if (this.failure === "WRITE") throw new Error("VALKEY_WRITE_FAILED");
        return super.putImmutable(storageKey, value, expiresAt);
      }
    }
    const publicKey = key({
      namespace: "public-metadata", scope: "PUBLIC", entityId: "fallback", identityId: "anonymous",
    });
    for (const failure of ["READ", "LEASE", "WRITE"] as const) {
      const load = vi.fn(async () => ({ value: { authoritative: failure }, rowsRead: 1 }));
      const cache = scopedCache({ backend: new FaultBackend(failure) });
      await expect(cache.readThrough(publicKey, { maxRows: 1, load, ttlSeconds: 60 }))
        .resolves.toEqual({ authoritative: failure });
      expect(load).toHaveBeenCalledOnce();
      expect(cache.metrics().backendFailures).toBeGreaterThan(0);
    }
    const deniedLoad = vi.fn(async () => ({ value: { forbidden: true }, rowsRead: 1 }));
    const denied = scopedCache({ backend: new FaultBackend("READ"), authorize: () => false });
    await expect(denied.readThrough(publicKey, {
      maxRows: 1, load: deniedLoad, ttlSeconds: 60,
    })).rejects.toThrow("CACHE_NOT_AUTHORIZED");
    expect(deniedLoad).not.toHaveBeenCalled();
  });

  it("rejects unbounded fallbacks without caching their result", async () => {
    const backend = new MemoryCacheBackend();
    const cache = scopedCache({ backend });
    const publicKey = key({
      namespace: "public-metadata",
      scope: "PUBLIC",
      entityId: "feed",
      identityId: "anonymous",
    });
    await expect(cache.readThrough(publicKey, {
      maxRows: 100,
      load: async () => ({ value: { unsafe: true }, rowsRead: 101 }),
      ttlSeconds: 60,
    })).rejects.toThrow("CACHE_FALLBACK_BOUND_EXCEEDED");
    expect(await cache.get(publicKey)).toBeNull();
  });

  it("bounds the process LRU to eligible immutable or already-authorized values", async () => {
    const backend = new MemoryCacheBackend();
    const cache = scopedCache({ backend, processLruEntries: 2 });
    const configKeys = ["a", "b", "c"].map((entityId, index) => key({
      namespace: "configuration",
      scope: "SHARED",
      entityId,
      identityId: "gustavo-main",
      sourceHighWater: `e${index + 1}`,
      stateVersion: String(index + 1),
    }));
    for (const [index, item] of configKeys.entries()) {
      await cache.set(item!, { index }, { ttlSeconds: 60, encrypted: false });
    }
    expect(cache.localSize()).toBe(2);
    await backend.delete(String(configKeys[2]!));
    expect(await cache.get(configKeys[2]!)).toEqual({ index: 2 });
  });

  it("copies and freezes process-cached values instead of retaining caller-owned objects", async () => {
    const cache = scopedCache();
    const configKey = key({
      namespace: "configuration",
      scope: "SHARED",
      entityId: "runtime",
      identityId: "gustavo-main",
    });
    const callerOwned = { nested: { value: 1 } };
    await cache.set(configKey, callerOwned, { ttlSeconds: 60 });
    callerOwned.nested.value = 99;
    const cached = await cache.get<typeof callerOwned>(configKey);
    expect(cached).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached?.nested)).toBe(true);
  });

  it("always consults bounded authority for private or Challenge decisions", async () => {
    const cache = scopedCache();
    const challengeKey = key({
      namespace: "challenge-snapshot",
      scope: "SHARED",
      entityId: "challenge-1",
      identityId: "gustavo-main",
    });
    await cache.set(challengeKey, { riskGate: "STALE_ALLOW" }, { ttlSeconds: 60 });
    const load = vi.fn(async () => ({ value: { riskGate: "DENY" }, rowsRead: 1 }));
    expect(await cache.readThrough(challengeKey, {
      maxRows: 1,
      load,
      ttlSeconds: 60,
      decisionCritical: true,
    })).toEqual({ riskGate: "DENY" });
    expect(await cache.readThrough(challengeKey, {
      maxRows: 1,
      load,
      ttlSeconds: 60,
      decisionCritical: true,
    })).toEqual({ riskGate: "DENY" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("single-flights across process stores through the distributed lease", async () => {
    const backend = new MemoryCacheBackend();
    const left = scopedCache({ backend, encryptionKey: ENCRYPTION_KEY });
    const right = scopedCache({ backend, encryptionKey: ENCRYPTION_KEY });
    const publicKey = key({
      namespace: "public-metadata",
      scope: "PUBLIC",
      entityId: "scheduled-feed",
      identityId: "anonymous",
    });
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { value: { ready: true }, rowsRead: 1 } as const;
    };
    const [a, b] = await Promise.all([
      left.readThrough(publicKey, { maxRows: 1, load, ttlSeconds: 60 }),
      right.readThrough(publicKey, { maxRows: 1, load, ttlSeconds: 60 }),
    ]);
    expect(a).toEqual({ ready: true });
    expect(b).toEqual({ ready: true });
    expect(calls).toBe(1);
  });

  it("keeps all Valkey commands behind the bounded Gustavo adapter", async () => {
    const get = vi.fn(async () => null);
    const set = vi.fn(async () => "OK");
    const evalCommand = vi.fn(async () => 1);
    const scan = vi.fn(async () => ({
      cursor: "0",
      keys: [String(key({ sourceHighWater: "e77", stateVersion: "77" }))],
    }));
    const del = vi.fn(async (keys: readonly string[]) => keys.length);
    const transport = {
      get,
      set,
      eval: evalCommand,
      scan,
      del,
    } satisfies ValkeyTransport;
    const backend = new ValkeyCacheBackend(transport);
    const versionKey = key();
    expect(await backend.putImmutable(String(versionKey), "value", Date.now() + 10_000)).toBe("STORED");
    expect(set).toHaveBeenCalledWith(String(versionKey), "value", expect.objectContaining({ NX: true }));
    expect(await backend.extendExpiry(String(versionKey), Date.now() + 10_000)).toBe(true);
    expect(await backend.acquireLease(
      `gustavo-cache:v1:lease:${"0".repeat(64)}`,
      "worker-a",
      Date.now() + 10_000,
    )).toBe(true);
    await backend.releaseLease(`gustavo-cache:v1:lease:${"0".repeat(64)}`, "worker-a");
    await backend.flushAll();
    expect(scan).toHaveBeenCalledWith("0", {
      MATCH: "gustavo-cache:v1:*",
      COUNT: 250,
    });
    expect(del).toHaveBeenCalledTimes(1);
    await expect(backend.read("ad-hoc:acct-a")).rejects.toThrow("CACHE_STORAGE_KEY_INVALID");
  });
});

describe("cache recovery and workers", () => {
  const records = [
    record("01-main", "main-state", "SHARED", "gustavo-main", {
      kind: "MAIN_STATE", mainStateVersion: "100", sourceEventIds: ["10000000-0000-4000-8000-000000000001"],
    }, "100"),
    record("02-broadcast", "broadcast", "SHARED", "broadcast-1", {
      kind: "SCHEDULED_BROADCAST", bodyDigest: "abc", sourceEventIds: ["10000000-0000-4000-8000-000000000002"],
    }, "100"),
    record("03-node", "node-dossier", "PRIVATE_ACCOUNT", "acct-a", {
      kind: "NODE_DOSSIER", accountId: "acct-a", nodeBrainId: "node-a",
      conversationId: "conversation-a", sourceEventIds: ["10000000-0000-4000-8000-000000000003"],
      sourceHighWater: "e100", mainStateVersion: "100", route: {
        classificationConfidence: 0.9, mode: "MAIN_DEFAULT", policyVersion: "node-routing-v1",
        reason: "MAIN_COVERED",
        response: { authority: "MAIN", canonical: true, label: "MAIN POSITION" },
        sourceIds: ["10000000-0000-4000-8000-000000000003"],
      },
      occurredAt: "2026-08-11T00:00:00.000Z",
    }, "100"),
    record("04-challenge", "challenge-snapshot", "SHARED", "challenge-1", {
      kind: "CHALLENGE_SNAPSHOT", equity: "2500.00", sourceEventIds: ["10000000-0000-4000-8000-000000000004"],
    }, "100"),
    record("05-handoff", "handoff", "PRIVATE_ACCOUNT", "acct-a", {
      kind: "NODE_HANDOFF", accountId: "acct-a", nodeBrainId: "node-a",
      conversationId: "conversation-a", sourceEventIds: ["10000000-0000-4000-8000-000000000005"],
      sourceHighWater: "e100", mainStateVersion: "100", packetKind: "PACKET",
      packetVersion: "1", throughEventId: "10000000-0000-4000-8000-000000000005",
      ideaCount: 1, items: [{
        id: "20000000-0000-4000-8000-000000000001:thesis",
        proposalId: "20000000-0000-4000-8000-000000000001", kind: "THESIS",
        text: "Approved bounded thesis", sourceIds: ["10000000-0000-4000-8000-000000000005"],
        memoryVersions: [{
          memoryId: "30000000-0000-4000-8000-000000000001", version: "1:CURRENT",
        }],
      }], occurredAt: "2026-08-11T00:00:00.000Z",
    }, "100"),
  ] as const;

  it("orders e9/e10 numerically and verifies the complete per-entity high-water authority", async () => {
    const node9 = nodeDossierRecord("03-node:acct-nine", "acct-nine", "9");
    const node10 = nodeDossierRecord("03-node:acct-ten", "acct-ten", "10");
    const mixed = [records[0], records[1], node10, node9, records[3], records[4]];
    const forward = projectionCategoryManifests(mixed);
    const reverse = projectionCategoryManifests([...mixed].reverse());
    const nodes = forward.find(({ category }) => category === "NODE_DOSSIERS") as
      (typeof forward)[number] & { readonly highWaterCount: number; readonly highWaterHash: string };
    const reverseNodes = reverse.find(({ category }) => category === "NODE_DOSSIERS") as
      typeof nodes;
    expect(nodes.sourceHighWater).toBe("e10");
    expect(nodes.highWaterCount).toBe(2);
    expect(nodes.highWaterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reverseNodes).toEqual(nodes);

    const cache = scopedCache({
      backend: new MemoryCacheBackend(),
      encryptionKey: ENCRYPTION_KEY,
      authorize: () => true,
    });
    await expect(rebuildCriticalProjections({
      cache,
      source: projectionSource(mixed),
      checkpoint: "e100",
    })).resolves.toMatchObject({ source: "POSTGRES", checkpoint: "e100" });

    const mutatedNode = Object.freeze({
      ...node9,
      key: Object.freeze({ ...node9.key, sourceHighWater: "e8" }),
      value: Object.freeze({ ...node9.value, sourceHighWater: "e8" }),
      contentHash: projectionValueHash({ ...node9.value, sourceHighWater: "e8" }),
    });
    const mutated = mixed.map((item) => item.id === node9.id ? mutatedNode : item);
    const mutatedCategories = projectionCategoryManifests(mutated).map((category) => (
      category.category === "NODE_DOSSIERS"
        ? Object.freeze({
            ...category,
            highWaterCount: nodes.highWaterCount,
            highWaterHash: nodes.highWaterHash,
          })
        : category
    ));
    const mutatedSource = projectionSource(mutated);
    const divergent: CriticalProjectionSource = {
      ...mutatedSource,
      async readManifest(checkpoint) {
        return {
          ...await mutatedSource.readManifest(checkpoint),
          categories: mutatedCategories,
        };
      },
    };
    const deniedBackend = new MemoryCacheBackend();
    await expect(rebuildCriticalProjections({
      cache: scopedCache({
        backend: deniedBackend,
        encryptionKey: ENCRYPTION_KEY,
        authorize: () => true,
      }),
      source: divergent,
      checkpoint: "e100",
    })).rejects.toThrow("CACHE_REBUILD_CATEGORY_DIVERGED");
    expect(deniedBackend.stats().writes).toBe(0);

    const missing = mixed.filter((item) => item.id !== node9.id);
    const missingSource = projectionSource(missing);
    const missingActual = await missingSource.readManifest("e100");
    const missingDeclared: CriticalProjectionSource = {
      ...missingSource,
      async readManifest() {
        return {
          ...missingActual,
          categories: missingActual.categories.map((category) => (
            category.category === "NODE_DOSSIERS"
              ? Object.freeze({
                  ...category,
                  highWaterCount: nodes.highWaterCount,
                  highWaterHash: nodes.highWaterHash,
                })
              : category
          )),
        };
      },
    };
    const missingBackend = new MemoryCacheBackend();
    await expect(rebuildCriticalProjections({
      cache: scopedCache({
        backend: missingBackend,
        encryptionKey: ENCRYPTION_KEY,
        authorize: () => true,
      }),
      source: missingDeclared,
      checkpoint: "e100",
    })).rejects.toThrow(/CACHE_REBUILD_CATEGORY_(?:MANIFEST_INVALID|DIVERGED)/);
    expect(missingBackend.stats().writes).toBe(0);
  });

  it("deterministically verifies and rebuilds critical projections after total cache loss", async () => {
    const source = projectionSource(records);
    const cache = scopedCache({
      backend: new MemoryCacheBackend(),
      encryptionKey: ENCRYPTION_KEY,
      authoritativeSource: source,
      authorize: () => true,
      random: () => 0.5,
    });
    await cache.flushAll();
    const result = await rebuildCriticalProjections({ cache, source: "POSTGRES", checkpoint: "e100" });
    expect(result).toEqual({
      source: "POSTGRES",
      checkpoint: "e100",
      mainState: "rebuilt",
      challenge: "rebuilt",
      handoffs: "rebuilt",
    });
    expect(cache.metrics().rebuilds).toBe(1);
    expect(cache.metrics().prewarms).toBe(5);
    expect(cache.metrics().rebuildLatencyMs.count).toBe(1);
    expect(cache.metrics().prewarmLatencyMs.count).toBe(5);
    expect(await cache.getCurrent(cachePointerKey(records[0].key))).toMatchObject({ kind: "MAIN_STATE" });
    expect(await cache.getCurrent(cachePointerKey(records[2].key))).toMatchObject({
      route: { reason: "MAIN_COVERED" },
    });
    expect(await cache.getCurrent(cachePointerKey(records[3].key))).toMatchObject({ equity: "2500.00" });
    expect(await cache.getCurrent(cachePointerKey(records[4].key))).toMatchObject({ packetKind: "PACKET" });
  });

  it("uses the same verified path for bounded startup prewarming", async () => {
    const cache = scopedCache({
      backend: new MemoryCacheBackend(),
      encryptionKey: ENCRYPTION_KEY,
      authorize: () => true,
    });
    await prewarmCriticalProjections({
      cache,
      source: projectionSource(records),
      checkpoint: "e100",
    });
    expect(await cache.getCurrent(cachePointerKey(records[0].key))).toMatchObject({ kind: "MAIN_STATE" });
    expect(await cache.getCurrent(cachePointerKey(records[1].key))).toMatchObject({ bodyDigest: "abc" });
  });

  it("refuses to publish current pointers when row counts or hashes diverge", async () => {
    const good = projectionSource(records);
    const source: CriticalProjectionSource = {
      ...good,
      async readManifest(checkpoint) {
        const manifest = await good.readManifest(checkpoint);
        return { ...manifest, manifestHash: "0".repeat(64) };
      },
    };
    const cache = scopedCache({
      backend: new MemoryCacheBackend(),
      encryptionKey: ENCRYPTION_KEY,
      authoritativeSource: source,
      authorize: () => true,
    });
    await expect(rebuildCriticalProjections({
      cache,
      source: "POSTGRES",
      checkpoint: "e100",
    })).rejects.toThrow("CACHE_REBUILD_MANIFEST_DIVERGED");
    expect(await cache.getCurrent(cachePointerKey(records[0].key))).toBeNull();
  });

  it("requires every non-empty category manifest before publishing any pointer", async () => {
    const good = projectionSource(records);
    const source: CriticalProjectionSource = {
      ...good,
      async readManifest(checkpoint) {
        const manifest = await good.readManifest(checkpoint);
        return { ...manifest, categories: manifest.categories.filter(({ category }) => category !== "CHALLENGE") };
      },
    };
    const backend = new MemoryCacheBackend();
    await expect(rebuildCriticalProjections({
      cache: scopedCache({ backend, encryptionKey: ENCRYPTION_KEY, authorize: () => true }),
      source,
      checkpoint: "e100",
    })).rejects.toThrow("CACHE_REBUILD_MANIFEST_INVALID");
    expect(backend.stats().writes).toBe(0);
  });

  it("runs the operator rebuild command with verification output", async () => {
    const output: string[] = [];
    const result = await runProjectionRebuild({
      cache: scopedCache({
        backend: new MemoryCacheBackend(),
        encryptionKey: ENCRYPTION_KEY,
        authorize: () => true,
      }),
      source: projectionSource(records),
      checkpoint: "e100",
      writeLine: (line) => output.push(line),
    });
    expect(result).toMatchObject({ source: "POSTGRES", checkpoint: "e100" });
    expect(output).toEqual([
      "cache rebuild verified source=POSTGRES checkpoint=e100 records=5 highWater=e100",
    ]);
  });

  it("consumes outbox changes idempotently with atomic leases, retries, and prewarming", async () => {
    let now = Date.parse("2026-08-11T00:00:00.000Z");
    const clock = () => new Date(now);
    const repository = new InMemoryCacheJobRepository({ now: clock, retryDelayMs: 100 });
    const message = {
      outboxId: "10000000-0000-4000-8000-000000000001",
      eventId: "20000000-0000-4000-8000-000000000001",
      topic: "main.state.versioned",
      payload: { eventId: "20000000-0000-4000-8000-000000000001" },
      createdAt: "2026-08-11T00:00:00.000Z",
    } as const;
    expect(repository.enqueue(message)).toBe(repository.enqueue(message));
    const backend = new MemoryCacheBackend();
    const cache = scopedCache({ backend, encryptionKey: ENCRYPTION_KEY, authorize: () => true });
    let sourceCalls = 0;
    const source: CacheChangeSource = {
      async loadChange(eventId) {
        sourceCalls += 1;
        if (sourceCalls === 1) throw new Error("temporary");
        expect(eventId).toBe(message.eventId);
        return {
          action: "PREWARM",
          triggerEventId: eventId,
          recordSourceEventId: "10000000-0000-4000-8000-000000000001",
          sourceTopic: "main.state.versioned",
          record: records[0],
        };
      },
    };

    expect(await processNextCacheJob({
      repository,
      source,
      cache,
      workerId: "worker-a",
      leaseMs: 1_000,
      maxAttempts: 3,
    })).toBe("RETRY_SCHEDULED");
    expect(await processNextCacheJob({
      repository,
      source,
      cache,
      workerId: "worker-b",
      leaseMs: 1_000,
      maxAttempts: 3,
    })).toBe("IDLE");
    now += 101;
    const results = await Promise.all([
      processNextCacheJob({ repository, source, cache, workerId: "worker-a", leaseMs: 1_000, maxAttempts: 3 }),
      processNextCacheJob({ repository, source, cache, workerId: "worker-b", leaseMs: 1_000, maxAttempts: 3 }),
    ]);
    expect(results.sort()).toEqual(["COMPLETED", "IDLE"]);
    expect(repository.snapshot()).toMatchObject({ completed: 1, retryScheduled: 0 });
    expect(await cache.getCurrent(cachePointerKey(records[0].key))).toMatchObject({ kind: "MAIN_STATE" });
  });

  it("reclaims an expired worker lease but protects a live claim", async () => {
    let now = Date.parse("2026-08-11T00:00:00.000Z");
    const repository = new InMemoryCacheJobRepository({ now: () => new Date(now) });
    repository.enqueue({
      outboxId: "10000000-0000-4000-8000-000000000002",
      eventId: "20000000-0000-4000-8000-000000000002",
      topic: "main.state.versioned",
      payload: { eventId: "20000000-0000-4000-8000-000000000002" },
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const first = await repository.claim("worker-a", 50);
    expect(first?.workerId).toBe("worker-a");
    expect(await repository.claim("worker-b", 50)).toBeNull();
    now += 51;
    const reclaimed = await repository.claim("worker-b", 50);
    expect(reclaimed?.workerId).toBe("worker-b");
    await expect(repository.complete(first!)).rejects.toThrow("CACHE_JOB_CLAIM_STALE");
    await repository.complete(reclaimed!);
  });

  it("rejects forged outbox payloads before projection lookup", async () => {
    const repository = new InMemoryCacheJobRepository();
    repository.enqueue({
      outboxId: "10000000-0000-4000-8000-000000000003",
      eventId: "20000000-0000-4000-8000-000000000003",
      topic: "main.state.versioned",
      payload: { eventId: "20000000-0000-4000-8000-000000000004" },
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const source = { loadChange: vi.fn() } satisfies CacheChangeSource;
    expect(await processNextCacheJob({
      repository,
      source,
      cache: scopedCache(),
      workerId: "worker-a",
      leaseMs: 1_000,
      maxAttempts: 1,
    })).toBe("FAILED");
    expect(source.loadChange).not.toHaveBeenCalled();
  });

  it("applies outbox invalidation without deleting a newer pointer", async () => {
    const repository = new InMemoryCacheJobRepository();
    repository.enqueue({
      outboxId: "10000000-0000-4000-8000-000000000005",
      eventId: "20000000-0000-4000-8000-000000000005",
      topic: "main.state.versioned",
      payload: { eventId: "20000000-0000-4000-8000-000000000005" },
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const cache = scopedCache({ encryptionKey: ENCRYPTION_KEY, authorize: () => true });
    await cache.publish({
      pointerKey: cachePointerKey(records[0].key),
      versionKey: cacheKey(records[0].key),
      versionOrdinal: "100",
      value: records[0].value,
      options: { ttlSeconds: 60 },
    });
    expect(await processNextCacheJob({
      repository,
      source: {
        async loadChange(eventId, input) {
          return {
            action: "INVALIDATE",
            triggerEventId: eventId,
            sourceTopic: input.topic,
            pointer: records[0].key,
            throughOrdinal: "99",
          } as const;
        },
      },
      cache,
      workerId: "worker-a",
      leaseMs: 1_000,
      maxAttempts: 2,
    })).toBe("COMPLETED");
    expect(await cache.getCurrent(cachePointerKey(records[0].key))).toMatchObject({ kind: "MAIN_STATE" });
    expect(cache.metrics().staleVersionRejections).toBe(1);
    expect(cache.metrics().invalidationLatencyMs.count).toBe(1);
  });
});
