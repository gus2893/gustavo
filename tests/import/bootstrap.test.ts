import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalContentDigest, canonicalJson } from "../../lib/server/events/integrity";
import { readEventBody } from "../../lib/server/events/store";
import { classifyImportRecord } from "../../lib/server/import/classify";
import {
  deactivateBootstrapImport,
  deactivateImportItems,
  reactivateImportItems,
  readImportedItemContent,
  reviewImportItems,
  runBootstrapImport,
  verifyBootstrap,
} from "../../lib/server/import/run";
import { authorizeRecall, recallAuthorized } from "../../lib/server/recall/planner";
import {
  archiveLegacyBundle,
  openLegacyBundle,
  sealBootstrapArchiveTransportReceipt,
  verifyLegacyBundle,
} from "../../lib/server/import/verify";
import { testContext } from "../helpers/postgres";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function exactSource<const Item extends { readonly text: string }>(items: readonly Item[]): {
  readonly digest: string;
  readonly sourceBytes: Buffer;
  readonly items: readonly (Item & {
    readonly byteRange: { readonly start: number; readonly end: number };
  })[];
} {
  const chunks: Buffer[] = [];
  const ranged: Array<Item & {
    readonly byteRange: { readonly start: number; readonly end: number };
  }> = [];
  let offset = 0;
  for (const [index, item] of items.entries()) {
    if (index > 0) {
      chunks.push(Buffer.from("\n", "utf8"));
      offset += 1;
    }
    const bytes = Buffer.from(item.text, "utf8");
    chunks.push(bytes);
    ranged.push({ ...item, byteRange: { start: offset, end: offset + bytes.length } });
    offset += bytes.length;
  }
  const sourceBytes = Buffer.concat(chunks);
  return Object.freeze({
    digest: digest(sourceBytes.toString("utf8")),
    sourceBytes,
    items: Object.freeze(ranged),
  });
}

async function archiveRemovalFixture(label: string): Promise<{
  readonly ctx: Awaited<ReturnType<typeof testContext>>;
  readonly temporaryRoot: string;
  readonly repositoryRoot: string;
  readonly operatorRoot: string;
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly key: Buffer;
  readonly receipt: NonNullable<Awaited<ReturnType<typeof verifyBootstrap>>["archiveReceipt"]>;
}> {
  const ctx = await testContext();
  const temporaryRoot = await mkdtemp(join(tmpdir(), `gustavo-durable-${label}-`));
  const repositoryRoot = join(temporaryRoot, "repo");
  const operatorRoot = join(temporaryRoot, "operator");
  const sourcePath = join(repositoryRoot, "docs", "legacy-paper.md");
  const sourceText = `Superseded durable paper-lab fixture ${label}.`;
  const key = Buffer.alloc(32, label.length + 31);
  await mkdir(join(repositoryRoot, "docs"), { recursive: true });
  await mkdir(operatorRoot, { recursive: true });
  await writeFile(sourcePath, sourceText, "utf8");
  const bytes = Buffer.from(sourceText, "utf8");
  const imported = await runBootstrapImport(ctx, {
    namespace: "repo",
    sourceType: "HISTORICAL_PAPER_EXPORT",
    locator: "docs/legacy-paper.md",
    sourceTimestamp: "2026-08-08T23:49:40.000Z",
    digest: digest(sourceText),
    sourceBytes: bytes,
    parserVersion: "bootstrap-parser-v1",
    items: [{
      id: "raw-file",
      text: sourceText,
      byteRange: { start: 0, end: bytes.length },
      kind: "SUPERSEDED_WORKFLOW",
      visibilityScope: "OPERATOR",
      excerptRef: "docs/legacy-paper.md",
    }],
  });
  await verifyBootstrap(ctx, imported.manifestId);
  const item = await ctx.db.one<{ id: string }>(
    "select id::text from import_source_items where manifest_id=$1",
    [imported.manifestId],
  );
  await reviewImportItems(ctx, {
    manifestId: imported.manifestId,
    itemIds: [item.id],
    actor: {
      role: "OPERATOR",
      id: `operator:durability-${label}`,
      purpose: "review exact durable removal source",
    },
    decision: "ARCHIVE_AS_SUPERSEDED_RAW",
    reason: "Exact full-file superseded source approved for durable archive.",
    idempotencyKey: `durability-review:${label}:${imported.manifestId}`,
  });
  const verification = await verifyBootstrap(ctx, imported.manifestId, {
    archiveReceiptKey: key,
  });
  if (!verification.archiveReceipt) throw new Error("TEST_ARCHIVE_RECEIPT_MISSING");
  return Object.freeze({
    ctx,
    temporaryRoot,
    repositoryRoot,
    operatorRoot,
    sourcePath,
    sourceText,
    key,
    receipt: verification.archiveReceipt,
  });
}

describe("classified bootstrap import", () => {
  it("is atomic, append-only, idempotent, and isolates non-current authority", async () => {
    const ctx = await testContext();
    const avaxHistoricalMetadata = {
      provider: "UNKNOWN",
      setupGeometry: {
        symbol: "AVAX-USD",
        direction: "PAPER_LONG",
        entry: "UNKNOWN",
        stop: "UNKNOWN",
        target: "UNKNOWN",
      },
      result: { status: "STOPPED", realizedPnl: "-75.0000" },
      lesson: "A full stopped paper attempt remains dated evidence, not current state.",
    } as const;
    const exact = exactSource([
        {
          id: "boundary",
          text: "Private Node content requires authorization before retrieval.",
          kind: "CURRENT_GUSTAVO_BOUNDARY",
          canonicalCatalogId: "private-node-authorization-boundary-v1",
          visibilityScope: "MAIN_SHARED",
          excerptRef: "docs/MECHANISM.md#private-node-boundary",
          reviewer: "operator:bootstrap",
          reviewReason: "Approved design safety boundary.",
        },
        {
          id: "method",
          text: "Use completed 15m evidence after a confirmed 1H pivot.",
          kind: "STRUCTURAL_METHOD",
          visibilityScope: "OPERATOR",
          excerptRef: "docs/MECHANISM.md#structural-evidence",
        },
        {
          id: "avax",
          text: "AVAX stopped on 2026-08-08.",
          kind: "DATED_MARKET_EPISODE",
          visibilityScope: "MAIN_SHARED",
          observedAt: "2026-08-08T00:05:00.000Z",
          expiresAt: "2026-08-08T00:20:00.000Z",
          excerptRef: "docs/DECISION_HISTORY.md#avax-decision",
          historicalMetadata: avaxHistoricalMetadata,
        },
        {
          id: "legacy-export",
          text: "The superseded passive export workflow wrote broker-style JSON.",
          kind: "SUPERSEDED_WORKFLOW",
          visibilityScope: "OPERATOR",
          excerptRef: "docs/EXPORTS_AND_SYMBOLS.md#old-export",
        },
        {
          id: "broker",
          text: "external execution inbox and CFT routing",
          kind: "EXECUTION_WORKFLOW",
          visibilityScope: "OPERATOR",
          excerptRef: "docs/EXPORTS_AND_SYMBOLS.md#forbidden-directories",
        },
      ] as const);
    const sourceText = exact.sourceBytes.toString("utf8");
    const source = {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/MECHANISM.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      parserVersion: "bootstrap-parser-v1",
      ...exact,
    } as const;

    const concurrent = await Promise.all([
      runBootstrapImport(ctx, source),
      runBootstrapImport(ctx, source),
    ]);
    expect(concurrent.map(({ inserted }) => inserted).sort((left, right) => left - right))
      .toEqual([0, 5]);
    const first = concurrent.find(({ inserted }) => inserted === 5)!;
    const repeat = await runBootstrapImport(ctx, {
      ...source,
      items: [...source.items].reverse().reverse(),
    });
    expect(repeat).toMatchObject({ manifestId: first.manifestId, inserted: 0, duplicates: 5 });
    expect(first.classifications).toEqual({
      CANONICAL: 1,
      CANDIDATE: 1,
      HISTORICAL: 1,
      DEPRECATED: 1,
      PROHIBITED: 1,
    });

    const manifest = await ctx.db.one<{
      manifest_digest: string;
      source_count: number;
      source_bytes: string;
      parsed_count: number;
      rejected_count: number;
      duplicate_count: number;
      projection_status: string;
      prior_manifest_id: string | null;
    }>(
      `select manifest_digest,source_count,source_bytes::text,parsed_count,rejected_count,
              duplicate_count,projection_status,prior_manifest_id::text
         from import_manifests where id=$1`,
      [first.manifestId],
    );
    expect(manifest).toMatchObject({
      manifest_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      source_count: 1,
      source_bytes: String(Buffer.byteLength(sourceText)),
      parsed_count: 5,
      rejected_count: 0,
      duplicate_count: 0,
      projection_status: "VERIFIED",
      prior_manifest_id: null,
    });

    const items = await ctx.db.query<{
      id: string;
      event_id: string;
      lifecycle_class: string;
      retrieval_mode: string;
      freshness: string;
      source_locator: string;
      source_digest: string;
      item_digest: string;
      importer_version: string;
      record_type: string;
      visibility_scope: string;
      excerpt_ref: string;
      reviewer: string | null;
      review_reason: string | null;
      result_ids: unknown;
      body_digest: string;
      historical_metadata_digest: string | null;
      ciphertext: Buffer;
    }>(
      `select item.id::text,item.event_id::text,item.lifecycle_class,item.retrieval_mode,item.freshness,
              item.source_locator,item.source_digest,item.item_digest,item.importer_version,
              item.record_type,item.visibility_scope,item.excerpt_ref,item.reviewer,
              item.review_reason,item.result_ids,item.historical_metadata_digest,
              body.body_digest,body.ciphertext
         from import_source_items item
         join encrypted_event_bodies body on body.event_id=item.event_id
        where item.manifest_id=$1 order by item.stable_locator`,
      [first.manifestId],
    );
    expect(items).toHaveLength(5);
    expect(items.map(({ lifecycle_class, retrieval_mode }) => [lifecycle_class, retrieval_mode]))
      .toEqual(expect.arrayContaining([
        ["CANONICAL", "GENERAL"],
        ["CANDIDATE", "OPERATOR_REVIEW"],
        ["HISTORICAL", "SIMILARITY_ONLY"],
        ["DEPRECATED", "AUDIT_ONLY"],
        ["PROHIBITED", "AUDIT_ONLY"],
      ]));
    expect(items.map(({ lifecycle_class, freshness }) => [lifecycle_class, freshness]))
      .toEqual(expect.arrayContaining([
        ["CANONICAL", "CURRENT"],
        ["CANDIDATE", "NOT_APPLICABLE"],
        ["HISTORICAL", "HISTORICAL"],
        ["DEPRECATED", "NOT_APPLICABLE"],
        ["PROHIBITED", "NOT_APPLICABLE"],
      ]));
    for (const item of items) {
      expect(item.source_locator).toBe(source.locator);
      expect(item.source_digest).toBe(source.digest.slice("sha256:".length));
      expect(item.item_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(item.importer_version).toBe("bootstrap-importer-v1");
      expect(item.excerpt_ref).toContain("docs/");
      expect(item.result_ids).toMatchObject({ eventId: item.event_id });
      expect(item.ciphertext.toString("utf8")).not.toContain("execution inbox");
      const body = await readEventBody(ctx.db, item.event_id, {
        actor: { role: "OPERATOR", purpose: "bootstrap verification" },
      });
      expect(item.body_digest).toBe(canonicalContentDigest(body));
    }
    const historical = items.find(({ lifecycle_class }) => lifecycle_class === "HISTORICAL")!;
    const historicalBody = await readEventBody(ctx.db, historical.event_id, {
      actor: { role: "OPERATOR", purpose: "verify structured historical provenance" },
    });
    expect(historicalBody).toMatchObject({ historicalMetadata: avaxHistoricalMetadata });
    expect(historical.historical_metadata_digest)
      .toBe(canonicalContentDigest(avaxHistoricalMetadata));
    const canonical = items.find(({ lifecycle_class }) => lifecycle_class === "CANONICAL")!;
    await expect(readImportedItemContent(ctx, canonical.id, { role: "PUBLIC" }))
      .rejects.toThrow("FORBIDDEN");
    await expect(readImportedItemContent(ctx, canonical.id, {
      role: "OPERATOR",
      purpose: "review imported evidence",
    })).resolves.toContain("authorization");

    const authorityCounts = await ctx.db.one<{
      events: number;
      bodies: number;
      outbox: number;
      authorities: number;
    }>(
      `select
         (select count(*)::int from events where aggregate_id=$1) events,
         (select count(*)::int from encrypted_event_bodies body join events event on event.id=body.event_id where event.aggregate_id=$1) bodies,
         (select count(*)::int from transactional_outbox outbox join events event on event.id=outbox.event_id where event.aggregate_id=$1) outbox,
         (select count(*)::int from import_event_authorities authority join events event on event.id=authority.event_id where event.aggregate_id=$1) authorities`,
      [`import:${first.manifestId}`],
    );
    expect(authorityCounts.events).toBeGreaterThanOrEqual(11);
    expect(authorityCounts).toEqual({
      events: authorityCounts.events,
      bodies: authorityCounts.events,
      outbox: authorityCounts.events,
      authorities: authorityCounts.events,
    });

    const verification = await verifyBootstrap(ctx, first.manifestId);
    expect(verification).toMatchObject({
      valid: true,
      hashMismatches: 0,
      provenanceMissing: 0,
      orphanAuthorityRows: 0,
      prohibitedInActiveRetrieval: 0,
      deprecatedInActiveRetrieval: 0,
      historicalInFreshDecisionGates: 0,
      candidateInAcceptedRules: 0,
      deterministicReplay: true,
    });

    const changedExact = exactSource(source.items.map((item) => item.id === "method"
      ? { ...item, text: `${item.text} Operator correction.` }
      : item));
    const changed = await runBootstrapImport(ctx, { ...source, ...changedExact });
    expect(changed.inserted).toBe(5);
    expect(changed.priorManifestId).toBe(first.manifestId);
    expect(changed.manifestId).not.toBe(first.manifestId);

    const beforeRollback = await ctx.db.one<{ count: number }>(
      "select count(*)::int count from import_item_lifecycle_events where manifest_id=$1",
      [changed.manifestId],
    );
    const rollback = await deactivateBootstrapImport(ctx, {
      manifestId: changed.manifestId,
      actor: {
        role: "OPERATOR",
        id: "operator:rollback",
        purpose: "verified manifest rollback",
      },
      reason: "Verified rollback drill.",
      idempotencyKey: `manifest-rollback:${changed.manifestId}`,
    });
    expect(rollback.deactivated).toBe(5);
    const afterRollback = await ctx.db.one<{ count: number }>(
      "select count(*)::int count from import_item_lifecycle_events where manifest_id=$1",
      [changed.manifestId],
    );
    expect(afterRollback.count).toBe(beforeRollback.count + 5);
    expect(await verifyBootstrap(ctx, changed.manifestId)).toMatchObject({
      activeItems: 0,
      valid: true,
    });

    await expect(ctx.db.query(
      "update import_source_items set retrieval_mode='GENERAL' where manifest_id=$1",
      [first.manifestId],
    )).rejects.toThrow("IMMUTABLE_IMPORT_AUTHORITY");
    await expect(ctx.db.transaction(async (transaction) => {
      await transaction.query(
        `insert into events (
           id,aggregate_id,actor_type,actor_id,type,visibility,occurred_at,correlation_id,
           idempotency_key,request_hash,integrity_hash
         ) values ($1,$2,'OPERATOR','operator:test','import.manifest.committed','OPERATOR',
                   clock_timestamp(),$1,$3,$4,$4)`,
        [randomUUID(), `import:orphan:${randomUUID()}`, `orphan:${randomUUID()}`, "0".repeat(64)],
      );
    })).rejects.toThrow("INCOMPLETE_IMPORT_EVENT");

    await ctx.db.query("delete from aggregate_data_keys where aggregate_id=$1", [
      `import:${first.manifestId}`,
    ]);
    await expect(readImportedItemContent(ctx, canonical.id, {
      role: "OPERATOR",
      purpose: "prove cryptographic erasure fails closed",
    })).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
    await expect(deactivateBootstrapImport(ctx, {
      manifestId: first.manifestId,
      actor: {
        role: "OPERATOR",
        id: "operator:rollback",
        purpose: "prove cryptographic erasure fails closed",
      },
      reason: "Must not recreate an erased import key.",
      idempotencyKey: `manifest-erased:${first.manifestId}`,
    })).rejects.toThrow("EVENT_KEY_UNAVAILABLE");
  }, 30_000);

  it("binds exact source bytes and fails closed on mislabeled execution behavior", async () => {
    expect(classifyImportRecord(
      "CURRENT_GUSTAVO_BOUNDARY",
      "Connect the Alpaca API and send live stock orders.",
    )).toMatchObject({
      lifecycleClass: "PROHIBITED",
      retrievalMode: "AUDIT_ONLY",
      acceptedDecisionRule: false,
      freshDecisionEligible: false,
    });
    expect(classifyImportRecord(
      "STRUCTURAL_METHOD",
      "Broker API workflows expose credentialed trading endpoints.",
    )).toMatchObject({
      lifecycleClass: "PROHIBITED",
      retrievalMode: "AUDIT_ONLY",
    });
    for (const executionText of [
      "Export broker payloads.",
      "Use the broker to execute trades.",
      "Send trades to an external endpoint.",
      "Connect credentials to the brokerage.",
      "Broker-style export files.",
      "Route trades through Alpaca.",
      "Carefully route several paper trades through the Alpaca broker.",
    ]) {
      expect(classifyImportRecord("STRUCTURAL_METHOD", executionText), executionText)
        .toMatchObject({ lifecycleClass: "PROHIBITED", retrievalMode: "AUDIT_ONLY" });
    }

    const ctx = await testContext();
    const sourceBytes = Buffer.from(
      "Canonical-looking wrapper around an external execution inbox and CFT routing.",
      "utf8",
    );
    const base = {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/mislabeled-execution.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      parserVersion: "bootstrap-parser-v1",
      sourceBytes,
      items: [{
        id: "mislabeled",
        text: sourceBytes.toString("utf8"),
        byteRange: { start: 0, end: sourceBytes.length },
        kind: "CURRENT_GUSTAVO_BOUNDARY",
        visibilityScope: "MAIN_SHARED",
        excerptRef: "docs/mislabeled-execution.md#behavior",
        reviewer: "operator:bootstrap",
        reviewReason: "Adversarial mislabeled fixture.",
      }],
    } as const;

    await expect(runBootstrapImport(ctx, {
      ...base,
      digest: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow("IMPORT_SOURCE_DIGEST_MISMATCH");

    const imported = await runBootstrapImport(ctx, {
      ...base,
      digest: digest(sourceBytes.toString("utf8")),
    });
    expect(imported.classifications).toEqual({
      CANONICAL: 0,
      CANDIDATE: 0,
      HISTORICAL: 0,
      DEPRECATED: 0,
      PROHIBITED: 1,
    });

    const catalogMismatchBytes = Buffer.from(
      "Private Node content requires authorization before retrieval, but this text is altered.",
      "utf8",
    );
    const catalogMismatch = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/catalog-mismatch.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(catalogMismatchBytes.toString("utf8")),
      sourceBytes: catalogMismatchBytes,
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "catalog-mismatch",
        text: catalogMismatchBytes.toString("utf8"),
        byteRange: { start: 0, end: catalogMismatchBytes.length },
        kind: "CURRENT_GUSTAVO_BOUNDARY",
        canonicalCatalogId: "private-node-authorization-boundary-v1",
        visibilityScope: "MAIN_SHARED",
        excerptRef: "docs/catalog-mismatch.md#boundary",
        reviewer: "operator:bootstrap",
        reviewReason: "A catalog ID must not authorize changed prose.",
      }],
    });
    expect(catalogMismatch.classifications).toMatchObject({ CANONICAL: 0, CANDIDATE: 1 });
    expect(await verifyBootstrap(ctx, catalogMismatch.manifestId)).toMatchObject({ valid: true });
    const manifest = await ctx.db.one<{
      event_id: string;
      source_bytes: string;
      source_digest: string;
      parsed_count: number;
      rejected_count: number;
      duplicate_count: number;
      projection_status: string;
      event_high_water: string;
    }>(
      `select event_id::text,source_bytes::text,source_digest,parsed_count,rejected_count,
              duplicate_count,projection_status,event_high_water::text
         from import_manifests where id=$1`,
      [imported.manifestId],
    );
    expect(manifest).toMatchObject({
      source_bytes: String(sourceBytes.length),
      source_digest: digest(sourceBytes.toString("utf8")).slice("sha256:".length),
      parsed_count: 1,
      rejected_count: 0,
      duplicate_count: 0,
      projection_status: "VERIFIED",
    });
    const verification = await verifyBootstrap(ctx, imported.manifestId);
    expect(verification).toMatchObject({
      valid: true,
      sourceHashMismatches: 0,
      manifestMismatches: 0,
      outboxMismatches: 0,
      forbiddenBehaviorInActiveRetrieval: 0,
    });

    await expect(ctx.db.query(
      "update import_manifests set source_bytes=source_bytes+1 where id=$1",
      [imported.manifestId],
    )).rejects.toThrow("IMMUTABLE_IMPORT_AUTHORITY");
    await expect(ctx.db.query(
      "update transactional_outbox set payload='{}'::jsonb where event_id=$1",
      [manifest.event_id],
    )).rejects.toThrow("IMMUTABLE_IMPORT_OUTBOX_AUTHORITY");
    await expect(ctx.db.query(
      "delete from encrypted_event_bodies where event_id=$1",
      [manifest.event_id],
    )).rejects.toThrow("IMMUTABLE_EVENT");
  }, 30_000);

  it("rejects fabricated, overlapping, out-of-range, and split-UTF8 excerpts", async () => {
    const ctx = await testContext();
    const importExcerpt = (locator: string, sourceText: string, items: readonly unknown[]) => {
      const sourceBytes = Buffer.from(sourceText, "utf8");
      return runBootstrapImport(ctx, {
        namespace: "repo",
        sourceType: "REPOSITORY_FILE",
        locator,
        sourceTimestamp: "2026-08-08T23:49:40.000Z",
        digest: digest(sourceText),
        sourceBytes,
        parserVersion: "bootstrap-parser-v1",
        items,
      } as never);
    };

    await expect(importExcerpt("docs/fabricated.md", "Grounded source text.", [{
      id: "fabricated",
      text: "Fabricated canonical evidence.",
      byteRange: { start: 0, end: Buffer.byteLength("Grounded source text.") },
      kind: "CURRENT_GUSTAVO_BOUNDARY",
      canonicalCatalogId: "private-node-authorization-boundary-v1",
      visibilityScope: "MAIN_SHARED",
      excerptRef: "docs/fabricated.md",
      reviewer: "operator:bootstrap",
      reviewReason: "Must not authenticate caller-supplied prose.",
    }])).rejects.toThrow("IMPORT_ITEM_TEXT_SOURCE_MISMATCH");

    await expect(importExcerpt("docs/overlap.md", "abcdef", [{
      id: "left", text: "abcd", byteRange: { start: 0, end: 4 },
      kind: "STRUCTURAL_METHOD", visibilityScope: "OPERATOR", excerptRef: "left",
    }, {
      id: "right", text: "cdef", byteRange: { start: 2, end: 6 },
      kind: "STRUCTURAL_METHOD", visibilityScope: "OPERATOR", excerptRef: "right",
    }])).rejects.toThrow("IMPORT_ITEM_BYTE_RANGE_OVERLAP");

    await expect(importExcerpt("docs/out-of-range.md", "abcdef", [{
      id: "outside", text: "abcdef", byteRange: { start: 0, end: 7 },
      kind: "STRUCTURAL_METHOD", visibilityScope: "OPERATOR", excerptRef: "outside",
    }])).rejects.toThrow("IMPORT_ITEM_BYTE_RANGE_INVALID");

    await expect(importExcerpt("docs/utf8-split.md", "AðŸ™‚B", [{
      id: "split", text: "ðŸ™‚", byteRange: { start: 2, end: 5 },
      kind: "STRUCTURAL_METHOD", visibilityScope: "OPERATOR", excerptRef: "split",
    }])).rejects.toThrow("IMPORT_ITEM_BYTE_RANGE_UTF8_INVALID");

    const temporaryRoot = await mkdtemp(join(tmpdir(), "gustavo-import-source-"));
    try {
      const rawPath = join(temporaryRoot, "raw.md");
      const descriptorPath = join(temporaryRoot, "import.json");
      const rawText = "CLI-derived exact excerpt.";
      await writeFile(rawPath, rawText, "utf8");
      const descriptor = {
        namespace: "repo",
        sourceType: "REPOSITORY_FILE",
        locator: "docs/cli-derived.md",
        sourceTimestamp: "2026-08-08T23:49:40.000Z",
        sourcePath: "raw.md",
        parserVersion: "bootstrap-parser-v1",
        items: [{
          id: "full",
          byteRange: { start: 0, end: Buffer.byteLength(rawText) },
          kind: "STRUCTURAL_METHOD",
          visibilityScope: "OPERATOR",
          excerptRef: "docs/cli-derived.md",
        }],
      };
      await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
      const { sourceFromDocument } = await import("../../scripts/import-bootstrap");
      const derived = await sourceFromDocument(descriptorPath);
      expect(derived.items[0]?.text).toBe(rawText);
      derived.sourceBytes.fill(0);
      await writeFile(descriptorPath, JSON.stringify({
        ...descriptor,
        items: [{ ...descriptor.items[0], text: "Fabricated CLI text." }],
      }), "utf8");
      await expect(sourceFromDocument(descriptorPath))
        .rejects.toThrow("IMPORT_ITEM_TEXT_SOURCE_MISMATCH");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects oversized import/archive inputs and item arrays before unbounded reads", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "gustavo-import-bounds-"));
    const repositoryRoot = join(temporaryRoot, "repo");
    const operatorRoot = join(temporaryRoot, "operator");
    const descriptorPath = join(temporaryRoot, "descriptor.json");
    const oversizedSourcePath = join(repositoryRoot, "oversized.bin");
    const archiveOutput = join(operatorRoot, "oversized.gustavo-archive");
    const archiveManifest = join(operatorRoot, "oversized.manifest.json");
      const sourceLimit = 10_485_760;
    const key = Buffer.alloc(32, 41);
    try {
      await mkdir(repositoryRoot, { recursive: true });
      await mkdir(operatorRoot, { recursive: true });
      const descriptorHandle = await openFile(descriptorPath, "w");
      try {
        await descriptorHandle.truncate(16_000_000);
      } finally {
        await descriptorHandle.close();
      }
      const { sourceFromDocument } = await import("../../scripts/import-bootstrap");
      await expect(sourceFromDocument(descriptorPath))
        .rejects.toThrow("IMPORT_DESCRIPTOR_BYTES_LIMIT");

      await expect(runBootstrapImport({ db: null as never }, {
        namespace: "repo",
        sourceType: "REPOSITORY_FILE",
        locator: "docs/oversized-direct.md",
        digest: `sha256:${"0".repeat(64)}`,
        sourceBytes: new Uint8Array(sourceLimit + 1),
        parserVersion: "bootstrap-parser-v1",
        items: [{
          id: "oversized",
          byteRange: { start: 0, end: 1 },
          kind: "STRUCTURAL_METHOD",
          visibilityScope: "OPERATOR",
          excerptRef: "docs/oversized-direct.md",
        }],
      })).rejects.toThrow("IMPORT_SOURCE_BYTES_LIMIT");

      const sourceHandle = await openFile(oversizedSourcePath, "w");
      try {
        await sourceHandle.truncate(sourceLimit + 1);
      } finally {
        await sourceHandle.close();
      }
      const baseDescriptor = {
        namespace: "repo",
        sourceType: "REPOSITORY_FILE",
        locator: "docs/bounded-source.md",
        sourceTimestamp: "2026-08-08T23:49:40.000Z",
        parserVersion: "bootstrap-parser-v1",
        items: [{
          id: "bounded",
          byteRange: { start: 0, end: 1 },
          kind: "STRUCTURAL_METHOD",
          visibilityScope: "OPERATOR",
          excerptRef: "docs/bounded-source.md",
        }],
      };
      await writeFile(descriptorPath, JSON.stringify({
        ...baseDescriptor,
        sourcePath: "repo/oversized.bin",
      }), "utf8");
      await expect(sourceFromDocument(descriptorPath))
        .rejects.toThrow("IMPORT_SOURCE_BYTES_LIMIT");

      await writeFile(descriptorPath, JSON.stringify({
        ...baseDescriptor,
        sourceBytesBase64: "A".repeat(Math.ceil((sourceLimit + 1) * 4 / 3) + 4),
      }), "utf8");
      await expect(sourceFromDocument(descriptorPath))
        .rejects.toThrow("IMPORT_SOURCE_BYTES_LIMIT");

      await writeFile(descriptorPath, JSON.stringify({
        ...baseDescriptor,
        sourceBytesBase64: "QQ==",
        items: Array.from({ length: 101 }, (_, index) => ({
          ...baseDescriptor.items[0],
          id: `item-${index}`,
        })),
      }), "utf8");
      await expect(sourceFromDocument(descriptorPath)).rejects.toThrow("IMPORT_ITEM_LIMIT");

      const archiveScript = await import("../../scripts/archive-legacy-knowledge");
      await expect(archiveScript.archiveLegacyFiles({
        repositoryRoot,
        inputs: [oversizedSourcePath],
        output: archiveOutput,
        manifestOutput: archiveManifest,
        key,
        removeVerified: false,
      })).rejects.toThrow("LEGACY_ARCHIVE_SOURCE_BYTES_LIMIT");
      await expect(access(archiveOutput)).rejects.toThrow();
      await expect(access(archiveManifest)).rejects.toThrow();
    } finally {
      key.fill(0);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("persists exact excerpt range authority and rejects caller archive eligibility", async () => {
    const ctx = await testContext();
    const sourceText = "Exact historical paper record.";
    const sourceBytes = Buffer.from(sourceText, "utf8");
    await expect(runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "HISTORICAL_PAPER_EXPORT",
      locator: "docs/self-asserted-archive.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(sourceText),
      sourceBytes,
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "full-file",
        text: sourceText,
        byteRange: { start: 0, end: sourceBytes.length },
        kind: "SUPERSEDED_WORKFLOW",
        visibilityScope: "OPERATOR",
        excerptRef: "docs/self-asserted-archive.md",
        supersededRawPaperLab: true,
      }],
    } as never)).rejects.toThrow("IMPORT_CALLER_ARCHIVE_ELIGIBILITY_FORBIDDEN");

    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "HISTORICAL_PAPER_EXPORT",
      locator: "docs/range-authority.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(sourceText),
      sourceBytes,
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "full-file",
        text: sourceText,
        byteRange: { start: 0, end: sourceBytes.length },
        kind: "SUPERSEDED_WORKFLOW",
        visibilityScope: "OPERATOR",
        excerptRef: "docs/range-authority.md",
      }],
    });
    const item = await ctx.db.one<{
      id: string;
      event_id: string;
      source_byte_start: string;
      source_byte_end: string;
      excerpt_digest: string;
      annotation_digest: string;
      item_digest: string;
    }>(
      `select id::text,event_id::text,source_byte_start::text,source_byte_end::text,
              excerpt_digest,annotation_digest,item_digest
         from import_source_items where manifest_id=$1`,
      [imported.manifestId],
    );
    expect(item).toMatchObject({
      source_byte_start: "0",
      source_byte_end: String(sourceBytes.length),
      excerpt_digest: digest(sourceText).slice("sha256:".length),
      item_digest: digest(sourceText).slice("sha256:".length),
      annotation_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await readEventBody(ctx.db, item.event_id, {
      actor: { role: "OPERATOR", purpose: "verify exact excerpt authority" },
    })).toMatchObject({
      byteRange: { start: 0, end: sourceBytes.length },
      excerptDigest: item.excerpt_digest,
      annotationDigest: item.annotation_digest,
      rawContent: sourceText,
    });
    expect(await verifyBootstrap(ctx, imported.manifestId)).toMatchObject({ valid: true });
    await expect(ctx.db.query(
      "update import_source_items set source_byte_end=source_byte_end-1 where id=$1",
      [item.id],
    )).rejects.toThrow("IMMUTABLE_IMPORT_AUTHORITY");

    await ctx.db.query(
      "create temporary table direct_sql_import_item (like import_source_items including constraints)",
    );
    await ctx.db.query(
      "insert into direct_sql_import_item select * from import_source_items where id=$1",
      [item.id],
    );
    await expect(ctx.db.query(
      "update direct_sql_import_item set excerpt_digest=$2 where id=$1",
      [item.id, "0".repeat(64)],
    )).rejects.toThrow();
    const projectionGate = await ctx.db.one<{ definition: string }>(
      "select pg_get_functiondef('validate_import_projection_event()'::regprocedure) definition",
    );
    expect(projectionGate.definition.replace(/\s/gu, ""))
      .toContain("new.source_byte_end>owner_manifest.source_bytes");
  }, 30_000);

  it("authorizes archive removal only after a reviewed verified full-file audit item", async () => {
    const ctx = await testContext();
    const actor = {
      role: "OPERATOR",
      id: "operator:archive-boundary-reviewer",
      purpose: "review exact archive eligibility",
    } as const;
    const importItem = async (input: {
      readonly locator: string;
      readonly sourceText: string;
      readonly itemText: string;
      readonly kind: "STRUCTURAL_METHOD" | "EXECUTION_WORKFLOW" | "SUPERSEDED_WORKFLOW";
    }) => {
      const sourceBytes = Buffer.from(input.sourceText, "utf8");
      const itemBytes = Buffer.from(input.itemText, "utf8");
      const start = sourceBytes.indexOf(itemBytes);
      const imported = await runBootstrapImport(ctx, {
        namespace: "repo",
        sourceType: "HISTORICAL_PAPER_EXPORT",
        locator: input.locator,
        sourceTimestamp: "2026-08-08T23:49:40.000Z",
        digest: digest(input.sourceText),
        sourceBytes,
        parserVersion: "bootstrap-parser-v1",
        items: [{
          id: "record",
          text: input.itemText,
          byteRange: { start, end: start + itemBytes.length },
          kind: input.kind,
          visibilityScope: "OPERATOR",
          excerptRef: input.locator,
        }],
      });
      const item = await ctx.db.one<{ id: string }>(
        "select id::text from import_source_items where manifest_id=$1",
        [imported.manifestId],
      );
      return { imported, item };
    };
    const archiveReview = (manifestId: string, itemId: string, suffix: string) => reviewImportItems(
      ctx,
      {
        manifestId,
        itemIds: [itemId],
        actor,
        decision: "ARCHIVE_AS_SUPERSEDED_RAW",
        reason: `Archive boundary regression: ${suffix}.`,
        idempotencyKey: `archive-boundary:${suffix}`,
      },
    );

    const candidate = await importItem({
      locator: "docs/archive-candidate.md",
      sourceText: "Candidate method only.",
      itemText: "Candidate method only.",
      kind: "STRUCTURAL_METHOD",
    });
    await verifyBootstrap(ctx, candidate.imported.manifestId);
    await expect(archiveReview(candidate.imported.manifestId, candidate.item.id, "candidate"))
      .rejects.toThrow("IMPORT_ARCHIVE_REVIEW_ITEM_INVALID");

    const prohibited = await importItem({
      locator: "docs/archive-prohibited.md",
      sourceText: "Use the broker to execute trades.",
      itemText: "Use the broker to execute trades.",
      kind: "EXECUTION_WORKFLOW",
    });
    await verifyBootstrap(ctx, prohibited.imported.manifestId);
    await expect(archiveReview(prohibited.imported.manifestId, prohibited.item.id, "prohibited"))
      .rejects.toThrow("IMPORT_ARCHIVE_REVIEW_ITEM_INVALID");

    const partial = await importItem({
      locator: "docs/archive-partial.md",
      sourceText: "Header\nSuperseded workflow.",
      itemText: "Superseded workflow.",
      kind: "SUPERSEDED_WORKFLOW",
    });
    await verifyBootstrap(ctx, partial.imported.manifestId);
    await expect(archiveReview(partial.imported.manifestId, partial.item.id, "partial"))
      .rejects.toThrow("IMPORT_ARCHIVE_REVIEW_ITEM_INVALID");

    const exact = await importItem({
      locator: "docs/archive-exact.md",
      sourceText: "Exact superseded workflow.",
      itemText: "Exact superseded workflow.",
      kind: "SUPERSEDED_WORKFLOW",
    });
    await expect(archiveReview(exact.imported.manifestId, exact.item.id, "before-verification"))
      .rejects.toThrow("IMPORT_ARCHIVE_VERIFICATION_REQUIRED");
    await verifyBootstrap(ctx, exact.imported.manifestId);
    await expect(archiveReview(exact.imported.manifestId, exact.item.id, "after-verification"))
      .resolves.toMatchObject({ transitioned: 1, replayed: false });
    const key = Buffer.alloc(32, 31);
    try {
      expect((await verifyBootstrap(ctx, exact.imported.manifestId, {
        archiveReceiptKey: key,
      })).archiveReceipt?.sources).toEqual([expect.objectContaining({
        locator: "docs/archive-exact.md",
        archiveDecision: "ARCHIVE_AS_SUPERSEDED_RAW",
        itemIds: [exact.item.id],
      })]);
    } finally {
      key.fill(0);
    }
  }, 30_000);

  it("serializes concurrent changed digests into one linear source history", async () => {
    const ctx = await testContext();
    const sourceFor = (revision: string) => {
      const exact = exactSource([{
        id: "boundary",
        text: `Private retrieval authorization revision ${revision}.`,
        kind: "CURRENT_GUSTAVO_BOUNDARY",
        visibilityScope: "MAIN_SHARED",
        excerptRef: "docs/concurrent-source.md#boundary",
        reviewer: "operator:bootstrap",
        reviewReason: `Approved revision ${revision}.`,
      }] as const);
      return {
        namespace: "repo",
        sourceType: "REPOSITORY_FILE",
        locator: "docs/concurrent-source.md",
        sourceTimestamp: "2026-08-08T23:49:40.000Z",
        parserVersion: "bootstrap-parser-v1",
        ...exact,
      } as const;
    };
    const initial = await runBootstrapImport(ctx, sourceFor("base"));
    const changed = [sourceFor("alpha"), sourceFor("beta")] as const;
    const importKeys = changed.map((source) => canonicalContentDigest({
      contentDigest: source.digest.slice("sha256:".length),
      importerVersion: "bootstrap-importer-v1",
      sourceNamespace: source.namespace,
      stableLocator: source.locator,
    }));
    let releaseLocks!: () => void;
    const release = new Promise<void>((resolve) => { releaseLocks = resolve; });
    let readyCount = 0;
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const blockers = importKeys.map((key) => ctx.db.transaction(async (transaction) => {
      await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `bootstrap-import:${key}`,
      ]);
      readyCount += 1;
      if (readyCount === importKeys.length) readyResolve();
      await release;
    }));
    await ready;
    const racing = Promise.all(changed.map((source) => runBootstrapImport(ctx, source)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseLocks();
    await Promise.all(blockers);
    const results = await racing;

    const versions = await ctx.db.query<{
      id: string;
      prior_manifest_id: string | null;
      event_high_water: string;
    }>(
      `select id::text,prior_manifest_id::text,event_high_water::text
         from import_manifests
        where source_namespace='repo' and stable_locator='docs/concurrent-source.md'
        order by event_high_water,id`,
    );
    expect(versions).toHaveLength(3);
    expect(versions[0]).toMatchObject({ id: initial.manifestId, prior_manifest_id: null });
    expect(versions[1].prior_manifest_id).toBe(initial.manifestId);
    expect(versions[2].prior_manifest_id).toBe(versions[1].id);
    expect(new Set(results.map(({ manifestId }) => manifestId))).toEqual(
      new Set([versions[1].id, versions[2].id]),
    );
    expect(versions.at(-1)?.id).toBe(results.reduce((latest, result) =>
      result.eventHighWater > latest.eventHighWater ? result : latest).manifestId);
  }, 30_000);

  it("applies reviewed item-set lifecycle transitions atomically and idempotently", async () => {
    const ctx = await testContext();
    const sourceFor = (locator: string, label: string) => {
      const exact = exactSource([
        {
          id: "boundary-a",
          text: `Private retrieval authorization ${label} A.`,
          kind: "CURRENT_GUSTAVO_BOUNDARY",
          visibilityScope: "MAIN_SHARED",
          excerptRef: `${locator}#a`,
          reviewer: "operator:bootstrap",
          reviewReason: "Approved boundary A.",
        },
        {
          id: "boundary-b",
          text: `Private retrieval authorization ${label} B.`,
          kind: "CURRENT_GUSTAVO_BOUNDARY",
          visibilityScope: "MAIN_SHARED",
          excerptRef: `${locator}#b`,
          reviewer: "operator:bootstrap",
          reviewReason: "Approved boundary B.",
        },
        {
          id: "candidate",
          text: `Completed structural evidence heuristic ${label}.`,
          kind: "STRUCTURAL_METHOD",
          visibilityScope: "OPERATOR",
          excerptRef: `${locator}#candidate`,
        },
      ] as const);
      return {
        namespace: "repo",
        sourceType: "REPOSITORY_FILE",
        locator,
        sourceTimestamp: "2026-08-08T23:49:40.000Z",
        parserVersion: "bootstrap-parser-v1",
        ...exact,
      } as const;
    };
    const imported = await runBootstrapImport(
      ctx,
      sourceFor("docs/lifecycle-source.md", "primary"),
    );
    const other = await runBootstrapImport(
      ctx,
      sourceFor("docs/lifecycle-other.md", "other"),
    );
    const items = await ctx.db.query<{
      id: string;
      stable_locator: string;
      lifecycle_class: string;
    }>(
      `select id::text,stable_locator,lifecycle_class from import_source_items
        where manifest_id=$1 order by stable_locator`,
      [imported.manifestId],
    );
    const otherItem = await ctx.db.one<{ id: string }>(
      "select id::text from import_source_items where manifest_id=$1 order by stable_locator limit 1",
      [other.manifestId],
    );
    const lifecycle = await import("../../lib/server/import/run");
    const actor = {
      role: "OPERATOR",
      id: "operator:lifecycle-reviewer",
      purpose: "review bootstrap lifecycle",
    } as const;
    const subset = items.filter(({ stable_locator }) => !stable_locator.endsWith("#candidate"))
      .map(({ id }) => id);

    await expect(lifecycle.deactivateImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: subset,
      actor: { role: "PUBLIC" },
      reason: "Unauthorized attempt.",
      idempotencyKey: "lifecycle:unauthorized",
    })).rejects.toThrow("FORBIDDEN");

    const beforeInvalid = await ctx.db.one<{ count: number }>(
      "select count(*)::int count from import_item_lifecycle_events where manifest_id=$1",
      [imported.manifestId],
    );
    await expect(lifecycle.deactivateImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: [subset[0], otherItem.id],
      actor,
      reason: "Cross-manifest set must fail.",
      idempotencyKey: "lifecycle:cross-manifest",
    })).rejects.toThrow("IMPORT_ITEM_SET_MISMATCH");
    expect(await ctx.db.one<{ count: number }>(
      "select count(*)::int count from import_item_lifecycle_events where manifest_id=$1",
      [imported.manifestId],
    )).toEqual(beforeInvalid);

    const first = await lifecycle.deactivateImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: subset,
      actor,
      reason: "Scoped rollback review.",
      idempotencyKey: "lifecycle:subset-deactivate",
    });
    const replay = await lifecycle.deactivateImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: [...subset].reverse(),
      actor,
      reason: "Scoped rollback review.",
      idempotencyKey: "lifecycle:subset-deactivate",
    });
    const alternateReplay = await lifecycle.deactivateImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: subset,
      actor,
      reason: "Scoped rollback review.",
      idempotencyKey: "lifecycle:subset-deactivate-alternate",
    });
    expect(first).toMatchObject({ transitioned: 2, replayed: false });
    expect(replay).toMatchObject({ commandId: first.commandId, transitioned: 2, replayed: true });
    expect(alternateReplay)
      .toMatchObject({ commandId: first.commandId, transitioned: 2, replayed: true });

    const candidate = items.find(({ lifecycle_class }) => lifecycle_class === "CANDIDATE")!;
    const reviewed = await lifecycle.reviewImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: [candidate.id],
      actor,
      decision: "RETAIN_AS_CLASSIFIED",
      reason: "Candidate remains review-only; no Main-state promotion exists.",
      idempotencyKey: "lifecycle:candidate-review",
    });
    expect(reviewed).toMatchObject({ transitioned: 1, replayed: false });
    expect(await ctx.db.one(
      `select lifecycle_class,retrieval_mode,accepted_decision_rule
         from import_source_items where id=$1`,
      [candidate.id],
    )).toEqual({
      lifecycle_class: "CANDIDATE",
      retrieval_mode: "OPERATOR_REVIEW",
      accepted_decision_rule: false,
    });

    const reactivated = await lifecycle.reactivateImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: [subset[0]],
      actor,
      reason: "Reviewed partial reactivation.",
      idempotencyKey: "lifecycle:subset-reactivate",
    });
    expect(reactivated).toMatchObject({ transitioned: 1, replayed: false });
    const current = await ctx.db.query<{ item_id: string; active: boolean }>(
      `select item.id::text item_id,latest.active from import_source_items item
       join lateral (
         select active from import_item_lifecycle_events lifecycle where lifecycle.item_id=item.id
         order by authority_sequence desc,id desc limit 1
       ) latest on true where item.id=any($1::uuid[]) order by item.id`,
      [subset],
    );
    expect(new Map(current.map((row) => [row.item_id, row.active])))
      .toEqual(new Map([[subset[0], true], [subset[1], false]]));
    expect(await verifyBootstrap(ctx, imported.manifestId)).toMatchObject({
      activeItems: 2,
      valid: true,
    });

    await expect(lifecycle.reviewImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: [candidate.id],
      actor,
      decision: "RETAIN_AS_CLASSIFIED",
      reason: "Candidate remains review-only; no Main-state promotion exists.",
      idempotencyKey: "lifecycle:subset-reactivate",
    })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");

    const reviewLifecycle = await ctx.db.one<{ id: string }>(
      `select id::text from import_item_lifecycle_events
        where manifest_id=$1 and action='REVIEW_DECIDED' order by authority_sequence desc limit 1`,
      [imported.manifestId],
    );
    await expect(ctx.db.query(
      "update import_item_lifecycle_events set reason='tampered' where id=$1",
      [reviewLifecycle.id],
    )).rejects.toThrow("IMMUTABLE_IMPORT_AUTHORITY");
  }, 30_000);

  it("projects eligible imports into authorized Main recall and gates them by lifecycle", async () => {
    const ctx = await testContext();
    const canonicalText = "Private Node content requires authorization before retrieval.";
    const exact = exactSource([{
      id: "canonical-boundary",
      text: canonicalText,
      kind: "CURRENT_GUSTAVO_BOUNDARY",
      canonicalCatalogId: "private-node-authorization-boundary-v1",
      visibilityScope: "MAIN_SHARED",
      excerptRef: "docs/recall-bootstrap.md#canonical-boundary",
      reviewer: "operator:bootstrap",
      reviewReason: "Exact immutable canonical catalog match.",
    }, {
      id: "candidate-method",
      text: "Use a completed 15m close after a confirmed pivot.",
      kind: "STRUCTURAL_METHOD",
      visibilityScope: "OPERATOR",
      excerptRef: "docs/recall-bootstrap.md#candidate-method",
    }, {
      id: "historical-avax",
      text: "AVAX stopped on 2026-08-08; preserve the dated risk lesson.",
      kind: "DATED_MARKET_EPISODE",
      visibilityScope: "MAIN_SHARED",
      observedAt: "2026-08-08T00:05:00.000Z",
      expiresAt: "2026-08-08T00:20:00.000Z",
      excerptRef: "docs/recall-bootstrap.md#historical-avax",
      historicalMetadata: {
        provider: "UNKNOWN",
        setupGeometry: {
          symbol: "AVAX-USD", direction: "PAPER_LONG",
          entry: "UNKNOWN", stop: "UNKNOWN", target: "UNKNOWN",
        },
        result: { status: "STOPPED", realizedPnl: "UNKNOWN" },
        lesson: "Preserve the dated risk lesson without inferring missing geometry.",
      },
    }] as const);
    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/recall-bootstrap.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      parserVersion: "bootstrap-parser-v1",
      ...exact,
    });

    const projections = await ctx.db.query<{
      item_id: string;
      lifecycle_class: string;
      memory_id: string | null;
      review_queue_id: string | null;
      result_ids: Record<string, string>;
    }>(
      `select item.id::text item_id,item.lifecycle_class,
              memory.memory_id::text,review.id::text review_queue_id,item.result_ids
         from import_source_items item
         left join import_memory_projections memory on memory.item_id=item.id
         left join import_review_queue_entries review on review.item_id=item.id
        where item.manifest_id=$1 order by item.stable_locator`,
      [imported.manifestId],
    );
    const canonical = projections.find(({ lifecycle_class }) => lifecycle_class === "CANONICAL")!;
    const candidate = projections.find(({ lifecycle_class }) => lifecycle_class === "CANDIDATE")!;
    const historical = projections.find(({ lifecycle_class }) => lifecycle_class === "HISTORICAL")!;
    expect(canonical.memory_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(canonical.result_ids.memoryId).toBe(canonical.memory_id);
    expect(candidate.memory_id).toBeNull();
    expect(candidate.review_queue_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(candidate.result_ids.reviewQueueId).toBe(candidate.review_queue_id);
    expect(historical.memory_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(historical.result_ids.memoryId).toBe(historical.memory_id);
    expect(await ctx.db.one<{ current: boolean; type: string }>(
      `select valid_to is null and conflict_state='CURRENT' current,type
         from memory_records where id=$1`,
      [historical.memory_id],
    )).toEqual({ current: false, type: "EPISODIC" });

    const main = await authorizeRecall(ctx.db, { role: "MAIN_BRAIN", actorId: "gustavo-main" });
    const recall = async (query: string, range?: { from: string; to: string }) => recallAuthorized(main, {
      query,
      entities: [],
      maxMemories: 8,
      tokenBudget: 2_000,
      graphDepth: 1,
      responseId: randomUUID(),
      idempotencyKey: `bootstrap-recall:${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      policyVersion: "recall-policy-v1",
      modelVersion: "response-model-v1",
      plannerVersion: "recall-planner-v1",
      ...(range ?? {}),
    });
    const current = await recall("Private Node authorization boundary");
    expect(current.memories.map(({ id }) => id)).toContain(canonical.memory_id);
    expect(current.memories.map(({ id }) => id)).not.toContain(candidate.memory_id);
    expect(current.memories.map(({ id }) => id)).not.toContain(historical.memory_id);

    const historicalRecall = await recall("AVAX dated risk lesson", {
      from: "2026-08-08T00:00:00.000Z",
      to: "2026-08-08T01:00:00.000Z",
    });
    expect(historicalRecall.memories.map(({ id }) => id)).toContain(historical.memory_id);
    const historicalTrace = await ctx.db.one<{ channels: string[] }>(
      "select channels from recall_trace_candidates where trace_id=$1 and memory_id=$2",
      [historicalRecall.trace.id, historical.memory_id],
    );
    expect(historicalTrace.channels).toContain("TIME");
    expect(historicalTrace.channels).not.toContain("CURRENT_STATE");
    expect(historicalTrace.channels).not.toContain("RECENT");

    const actor = {
      role: "OPERATOR", id: "operator:recall-lifecycle",
      purpose: "verify reversible imported memory lifecycle",
    } as const;
    await deactivateImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: [canonical.item_id],
      actor,
      reason: "Reversible recall exclusion test.",
      idempotencyKey: `bootstrap-recall-deactivate:${canonical.item_id}`,
    });
    expect((await recall("Private Node authorization boundary")).memories.map(({ id }) => id))
      .not.toContain(canonical.memory_id);
    await reactivateImportItems(ctx, {
      manifestId: imported.manifestId,
      itemIds: [canonical.item_id],
      actor,
      reason: "Reversible recall restoration test.",
      idempotencyKey: `bootstrap-recall-reactivate:${canonical.item_id}`,
    });
    expect((await recall("Private Node authorization boundary")).memories.map(({ id }) => id))
      .toContain(canonical.memory_id);
  }, 30_000);

  it("reserves every lifecycle replay idempotency alias to its exact request", async () => {
    const ctx = await testContext();
    const text = "Completed structural evidence remains operator review material.";
    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "OPERATOR_CORRECTION",
      locator: "docs/lifecycle-alias.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(text),
      sourceBytes: Buffer.from(text, "utf8"),
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "candidate",
        text,
        byteRange: { start: 0, end: Buffer.byteLength(text) },
        kind: "STRUCTURAL_METHOD",
        visibilityScope: "OPERATOR",
        excerptRef: "docs/lifecycle-alias.md#candidate",
      }],
    });
    const item = await ctx.db.one<{ id: string }>(
      "select id::text from import_source_items where manifest_id=$1",
      [imported.manifestId],
    );
    const actor = {
      role: "OPERATOR",
      id: "operator:lifecycle-alias",
      purpose: "prove alternate replay keys remain reserved",
    } as const;
    const request = {
      manifestId: imported.manifestId,
      itemIds: [item.id],
      actor,
      decision: "RETAIN_AS_CLASSIFIED" as const,
      reason: "Keep this candidate review-only.",
    };
    const first = await reviewImportItems(ctx, {
      ...request,
      idempotencyKey: "lifecycle-alias:k1",
    });
    const alternateReplay = await reviewImportItems(ctx, {
      ...request,
      idempotencyKey: "lifecycle-alias:k2",
    });
    expect(alternateReplay).toMatchObject({ commandId: first.commandId, replayed: true });
    expect(await ctx.db.one<{ count: number }>(
      "select count(*)::integer count from import_lifecycle_idempotency_aliases where command_id=$1",
      [first.commandId],
    )).toEqual({ count: 2 });
    await expect(reviewImportItems(ctx, {
      ...request,
      decision: "REJECTED",
      reason: "A different reviewed decision cannot reuse the alternate alias.",
      idempotencyKey: "lifecycle-alias:k2",
    })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");

    const concurrentKey = "lifecycle-alias:concurrent-exact";
    const concurrent = await Promise.allSettled([
      reviewImportItems(ctx, {
        ...request,
        reason: "Concurrent exact request A.",
        idempotencyKey: concurrentKey,
      }),
      reviewImportItems(ctx, {
        ...request,
        decision: "REJECTED",
        reason: "Concurrent exact request B.",
        idempotencyKey: concurrentKey,
      }),
    ]);
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "IDEMPOTENCY_KEY_REUSED" }),
    });
    expect(await ctx.db.one<{ count: number }>(
      "select count(*)::integer count from import_lifecycle_idempotency_aliases where idempotency_key=$1",
      [concurrentKey],
    )).toEqual({ count: 1 });
  }, 30_000);

  it("binds catalog, schema, policy, review, effective interval, and visibility topology", async () => {
    const ctx = await testContext();
    const text = "Private Node content requires authorization before retrieval.";
    const bytes = Buffer.from(text, "utf8");
    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/versioned-canonical.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(text),
      sourceBytes: bytes,
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "boundary",
        text,
        byteRange: { start: 0, end: bytes.length },
        kind: "CURRENT_GUSTAVO_BOUNDARY",
        canonicalCatalogId: "private-node-authorization-boundary-v1",
        visibilityScope: "MAIN_SHARED",
        effectiveFrom: "2026-08-08T23:49:40.000Z",
        excerptRef: "docs/versioned-canonical.md#boundary",
        reviewer: "operator:bootstrap",
        reviewReason: "Approved immutable catalog entry.",
      }],
    });
    const item = await ctx.db.one<{
      event_id: string;
      schema_version: string;
      importer_version: string;
      ruleset_version: string;
      gustavo_policy_version: string;
      canonical_catalog_id: string;
      canonical_content_digest: string;
      effective_from: Date;
      effective_until: Date | null;
      current_review_status: string;
      current_review_decision: string;
      event_policy_version: string;
    }>(
      `select item.event_id::text,item.schema_version,item.importer_version,item.ruleset_version,
              item.gustavo_policy_version,item.canonical_catalog_id,item.canonical_content_digest,
              item.effective_from,item.effective_until,item.current_review_status,
              item.current_review_decision,event.policy_version event_policy_version
         from import_source_items item join events event on event.id=item.event_id
        where item.manifest_id=$1`,
      [imported.manifestId],
    );
    expect(item).toMatchObject({
      schema_version: "import-item-schema-v1",
      importer_version: "bootstrap-importer-v1",
      ruleset_version: "classification-rules-v1",
      gustavo_policy_version: "gustavo-policy-v1",
      canonical_catalog_id: "private-node-authorization-boundary-v1",
      canonical_content_digest: digest(text).slice("sha256:".length),
      effective_until: null,
      current_review_status: "REVIEWED",
      current_review_decision: "ACCEPTED_AS_CANONICAL",
      event_policy_version: "gustavo-policy-v1",
    });
    expect(item.effective_from.toISOString()).toBe("2026-08-08T23:49:40.000Z");
    const body = await readEventBody(ctx.db, item.event_id, {
      actor: { role: "OPERATOR", purpose: "verify reciprocal item metadata" },
    });
    expect(body).toMatchObject({
      schemaVersion: item.schema_version,
      importerVersion: item.importer_version,
      rulesetVersion: item.ruleset_version,
      gustavoPolicyVersion: item.gustavo_policy_version,
      canonicalCatalogId: item.canonical_catalog_id,
      canonicalContentDigest: item.canonical_content_digest,
      effectiveFrom: item.effective_from.toISOString(),
      effectiveUntil: null,
      currentReviewStatus: item.current_review_status,
      currentReviewDecision: item.current_review_decision,
    });

    await expect(runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "OPERATOR_CORRECTION",
      locator: "docs/private-without-owner.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest("private candidate"),
      sourceBytes: Buffer.from("private candidate", "utf8"),
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "private",
        text: "private candidate",
        byteRange: { start: 0, end: Buffer.byteLength("private candidate") },
        kind: "STRUCTURAL_METHOD",
        visibilityScope: "PRIVATE_ACCOUNT",
        excerptRef: "docs/private-without-owner.md#private",
      }],
    })).rejects.toThrow("IMPORT_PRIVATE_TOPOLOGY_UNSUPPORTED");
  }, 30_000);

  it("rejects OPERATOR historical evidence before any event or memory projection write", async () => {
    const ctx = await testContext();
    const before = await ctx.db.one<{
      events: number;
      bodies: number;
      memories: number;
      projections: number;
    }>(
      `select (select count(*)::integer from events) events,
              (select count(*)::integer from encrypted_event_bodies) bodies,
              (select count(*)::integer from memory_records) memories,
              (select count(*)::integer from import_memory_projections) projections`,
    );
    const text = "AVAX stopped on 2026-08-08; operator-only archived observation.";
    await expect(runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "HISTORICAL_PAPER_EXPORT",
      locator: "docs/operator-only-history.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(text),
      sourceBytes: Buffer.from(text, "utf8"),
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "operator-history",
        text,
        byteRange: { start: 0, end: Buffer.byteLength(text) },
        kind: "DATED_MARKET_EPISODE",
        visibilityScope: "OPERATOR",
        observedAt: "2026-08-08T00:05:00.000Z",
        expiresAt: "2026-08-08T00:20:00.000Z",
        excerptRef: "docs/operator-only-history.md#avax",
        historicalMetadata: {
          provider: "UNKNOWN",
          setupGeometry: {
            symbol: "AVAX-USD",
            direction: "NO_SIMULATED_POSITION",
            entry: "UNKNOWN",
            stop: "UNKNOWN",
            target: "UNKNOWN",
          },
          result: { status: "NO_TRADE", realizedPnl: "UNKNOWN" },
          lesson: "Operator-only history cannot be silently projected into Main memory.",
        },
      }],
    })).rejects.toThrow("IMPORT_PROJECTABLE_VISIBILITY_UNSUPPORTED");
    expect(await ctx.db.one(
      `select (select count(*)::integer from events) events,
              (select count(*)::integer from encrypted_event_bodies) bodies,
              (select count(*)::integer from memory_records) memories,
              (select count(*)::integer from import_memory_projections) projections`,
    )).toEqual(before);
  }, 30_000);

  it("database projection authority requires exact MAIN_SHARED item visibility", async () => {
    const ctx = await testContext();
    const definition = await ctx.db.one<{ sql: string }>(
      `select pg_get_functiondef('validate_import_memory_projection'::regproc) sql`,
    );
    expect(definition.sql).toMatch(/item\.visibility_scope\s*=\s*'MAIN_SHARED'/u);

    const exact = exactSource([{
      id: "canonical",
      text: "Private Node content requires authorization before retrieval.",
      kind: "CURRENT_GUSTAVO_BOUNDARY",
      canonicalCatalogId: "private-node-authorization-boundary-v1",
      visibilityScope: "MAIN_SHARED",
      excerptRef: "docs/direct-projection.md#canonical",
      reviewer: "operator:bootstrap",
      reviewReason: "Exact catalog authority for projection mismatch testing.",
    }, {
      id: "operator-candidate",
      text: "Use a completed 15m close after a confirmed pivot.",
      kind: "STRUCTURAL_METHOD",
      visibilityScope: "OPERATOR",
      excerptRef: "docs/direct-projection.md#operator-candidate",
    }] as const);
    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/direct-projection.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      parserVersion: "bootstrap-parser-v1",
      ...exact,
    });
    const rows = await ctx.db.query<{
      id: string;
      lifecycle_class: string;
      memory_id: string | null;
      extraction_run_id: string | null;
      consolidation_event_id: string | null;
      source_event_id: string | null;
    }>(
      `select item.id::text,item.lifecycle_class,memory.memory_id::text,
              memory.extraction_run_id::text,memory.consolidation_event_id::text,
              memory.source_event_id::text
         from import_source_items item
         left join import_memory_projections memory on memory.item_id=item.id
        where item.manifest_id=$1 order by item.id`,
      [imported.manifestId],
    );
    const canonical = rows.find(({ lifecycle_class }) => lifecycle_class === "CANONICAL")!;
    const candidate = rows.find(({ lifecycle_class }) => lifecycle_class === "CANDIDATE")!;
    await expect(ctx.db.query(
      `insert into import_memory_projections (
         item_id,manifest_id,memory_id,extraction_run_id,consolidation_event_id,
         source_event_id,lifecycle_class,retrieval_profile,created_at
       ) values ($1,$2,$3,$4,$5,$6,'CANONICAL','CURRENT_GENERAL',now())`,
      [candidate.id, imported.manifestId, canonical.memory_id, canonical.extraction_run_id,
        canonical.consolidation_event_id, canonical.source_event_id],
    )).rejects.toThrow("IMPORT_MEMORY_PROJECTION_INVALID");
  }, 30_000);

  it("rejects null, missing, substituted, wrong-type, and extra lifecycle JSON authority", async () => {
    const ctx = await testContext();
    const text = "Superseded JSON authority fixture.";
    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/json-authority.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(text),
      sourceBytes: Buffer.from(text, "utf8"),
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "audit",
        text,
        byteRange: { start: 0, end: Buffer.byteLength(text) },
        kind: "SUPERSEDED_WORKFLOW",
        visibilityScope: "OPERATOR",
        excerptRef: "docs/json-authority.md#audit",
      }],
    });
    const item = await ctx.db.one<{ id: string }>(
      "select id::text from import_source_items where manifest_id=$1",
      [imported.manifestId],
    );
    const validRequest = {
      action: "DEACTIVATED",
      actorId: "operator:json-authority",
      actorPurpose: "reject malformed direct SQL lifecycle authority",
      itemIds: [item.id],
      manifestId: imported.manifestId,
      reason: "Malformed JSON must fail closed.",
      reviewDecision: null,
    } as const;
    const cases: readonly Record<string, unknown>[] = [
      Object.fromEntries(Object.entries(validRequest).filter(([key]) => key !== "action")),
      { ...validRequest, action: null },
      { ...validRequest, action: "REACTIVATED" },
      { ...validRequest, actorId: { unexpected: "object" } },
      { ...validRequest, extra: "not-authority" },
    ];
    const before = await ctx.db.one<{ commands: number; events: number }>(
      `select (select count(*)::integer from import_lifecycle_commands) commands,
              (select count(*)::integer from events) events`,
    );
    for (const requestManifest of cases) {
      const commandId = randomUUID();
      await expect(ctx.db.transaction(async (transaction) => {
        await transaction.query(
          `insert into import_lifecycle_commands (
             id,manifest_id,action,item_ids,actor_id,actor_purpose,reason,review_decision,
             idempotency_key,request_manifest,request_digest,result_lifecycle_ids,
             result_event_ids,created_at
           ) values ($1,$2,'DEACTIVATED',$3,$4,$5,$6,null,$7,$8,$9,$10,$11,now())`,
          [commandId, imported.manifestId, [item.id], validRequest.actorId,
            validRequest.actorPurpose, validRequest.reason, `json-authority:${commandId}`,
            JSON.stringify(requestManifest), canonicalContentDigest(requestManifest as never),
            [randomUUID()], [randomUUID()]],
        );
        throw new Error("SQL_JSON_AUTHORITY_FAIL_OPEN");
      })).rejects.toThrow("IMPORT_LIFECYCLE_COMMAND_INVALID");
      expect(await ctx.db.one<{ count: number }>(
        "select count(*)::integer count from import_lifecycle_commands where id=$1",
        [commandId],
      )).toEqual({ count: 0 });
    }
    expect(await ctx.db.one(
      `select (select count(*)::integer from import_lifecycle_commands) commands,
              (select count(*)::integer from events) events`,
    )).toEqual(before);
  }, 30_000);

  it("rejects JSON numeric scalars that stringify to expected SQL text", async () => {
    const ctx = await testContext();
    const text = "Superseded numeric JSON type fixture.";
    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/json-numeric-type.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(text),
      sourceBytes: Buffer.from(text, "utf8"),
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "audit",
        text,
        byteRange: { start: 0, end: Buffer.byteLength(text) },
        kind: "SUPERSEDED_WORKFLOW",
        visibilityScope: "OPERATOR",
        excerptRef: "docs/json-numeric-type.md#audit",
      }],
    });
    const item = await ctx.db.one<{ id: string }>(
      "select id::text from import_source_items where manifest_id=$1",
      [imported.manifestId],
    );
    const commandId = randomUUID();
    const requestManifest = {
      action: "DEACTIVATED",
      actorId: 17,
      actorPurpose: "reject a numeric scalar that text extraction would accept",
      itemIds: [item.id],
      manifestId: imported.manifestId,
      reason: "JSON scalar types are exact authority.",
      reviewDecision: null,
    } as const;
    const before = await ctx.db.one<{ commands: number; events: number }>(
      `select (select count(*)::integer from import_lifecycle_commands) commands,
              (select count(*)::integer from events) events`,
    );
    await expect(ctx.db.transaction(async (transaction) => {
      await transaction.query(
        `insert into import_lifecycle_commands (
           id,manifest_id,action,item_ids,actor_id,actor_purpose,reason,review_decision,
           idempotency_key,request_manifest,request_digest,result_lifecycle_ids,
           result_event_ids,created_at
         ) values ($1,$2,'DEACTIVATED',$3,'17',$4,$5,null,$6,$7,$8,$9,$10,now())`,
        [commandId, imported.manifestId, [item.id], requestManifest.actorPurpose,
          requestManifest.reason, `json-numeric:${commandId}`,
          JSON.stringify(requestManifest), canonicalContentDigest(requestManifest as never),
          [randomUUID()], [randomUUID()]],
      );
      throw new Error("SQL_JSON_NUMERIC_TYPE_FAIL_OPEN");
    })).rejects.toThrow("IMPORT_LIFECYCLE_COMMAND_INVALID");
    expect(await ctx.db.one(
      `select (select count(*)::integer from import_lifecycle_commands) commands,
              (select count(*)::integer from events) events`,
    )).toEqual(before);
  }, 30_000);

  it("rejects null or substituted import event envelope authority with zero side effects", async () => {
    const ctx = await testContext();
    const text = "Superseded event envelope fixture.";
    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "REPOSITORY_FILE",
      locator: "docs/event-envelope-authority.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(text),
      sourceBytes: Buffer.from(text, "utf8"),
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "audit",
        text,
        byteRange: { start: 0, end: Buffer.byteLength(text) },
        kind: "SUPERSEDED_WORKFLOW",
        visibilityScope: "OPERATOR",
        excerptRef: "docs/event-envelope-authority.md#audit",
      }],
    });
    const original = await ctx.db.one<{ event_id: string }>(
      "select event_id::text from import_manifests where id=$1",
      [imported.manifestId],
    );
    const cases = [
      { promptVersion: null, modelVersion: null, policyVersion: "gustavo-policy-v1",
        correlation: "SELF", causation: null },
      { promptVersion: "bootstrap-importer-v1", modelVersion: null, policyVersion: null,
        correlation: "SELF", causation: null },
      { promptVersion: "bootstrap-importer-v1", modelVersion: "unexpected-model",
        policyVersion: "gustavo-policy-v1", correlation: "SELF", causation: null },
      { promptVersion: "bootstrap-importer-v1", modelVersion: null,
        policyVersion: "gustavo-policy-v1", correlation: randomUUID(), causation: null },
      { promptVersion: "bootstrap-importer-v1", modelVersion: null,
        policyVersion: "gustavo-policy-v1", correlation: "SELF", causation: original.event_id },
    ] as const;
    const before = await ctx.db.one<{ events: number; manifests: number }>(
      `select (select count(*)::integer from events) events,
              (select count(*)::integer from import_manifests) manifests`,
    );
    for (const malformed of cases) {
      const eventId = randomUUID();
      const manifestId = randomUUID();
      await expect(ctx.db.transaction(async (transaction) => {
        const event = await transaction.one<{ ingested_sequence: string; occurred_at: Date }>(
          `insert into events (
             id,aggregate_id,account_id,actor_type,actor_id,type,visibility,occurred_at,
             causation_id,correlation_id,prompt_version,model_version,policy_version,
             idempotency_key,request_hash,integrity_hash
           ) values ($1,$2,null,'OPERATOR','gustavo-importer','import.manifest.committed',
                     'OPERATOR',clock_timestamp(),$3,$4,$5,$6,$7,$8,$9,$9)
           returning ingested_sequence::text,occurred_at`,
          [eventId, `import:${manifestId}`, malformed.causation,
            malformed.correlation === "SELF" ? eventId : malformed.correlation,
            malformed.promptVersion, malformed.modelVersion, malformed.policyVersion,
            `event-envelope:${eventId}`, "7".repeat(64)],
        );
        const dataKeyId = randomUUID();
        await transaction.query(
          `insert into aggregate_data_keys (
             id,aggregate_id,root_key_version,wrapped_key,wrap_iv,wrap_auth_tag,created_at
           ) select $1,$2,key.root_key_version,key.wrapped_key,key.wrap_iv,key.wrap_auth_tag,
                    clock_timestamp()
               from encrypted_event_bodies body
               join aggregate_data_keys key on key.id=body.data_key_id
              where body.event_id=$3`,
          [dataKeyId, `import:${manifestId}`, original.event_id],
        );
        await transaction.query(
          `insert into encrypted_event_bodies (
             event_id,aggregate_id,data_key_id,ciphertext,body_iv,body_auth_tag,
             body_encoding,body_digest
           ) select $1,$2,$4,ciphertext,body_iv,body_auth_tag,body_encoding,body_digest
               from encrypted_event_bodies where event_id=$3`,
          [eventId, `import:${manifestId}`, original.event_id, dataKeyId],
        );
        await transaction.query(
          `insert into transactional_outbox (id,event_id,topic,payload,created_at)
           values ($1,$2,'import.manifest.committed',$3,$4)`,
          [randomUUID(), eventId, JSON.stringify({ eventId }), event.occurred_at],
        );
        await transaction.query(
          `insert into import_manifests (
             id,event_id,import_key,source_namespace,stable_locator,source_type,
             source_timestamp,source_digest,parser_version,importer_version,ruleset_version,
             schema_version,gustavo_policy_version,prior_manifest_id,source_count,
             source_bytes,parsed_count,rejected_count,duplicate_count,classification_counts,
             event_high_water,projection_status,authority_manifest,manifest_digest,
             body_digest,created_at
           ) select $1,$2,import_key,source_namespace,stable_locator,source_type,
                    source_timestamp,source_digest,parser_version,importer_version,ruleset_version,
                    schema_version,gustavo_policy_version,prior_manifest_id,source_count,
                    source_bytes,parsed_count,rejected_count,duplicate_count,classification_counts,
                    $3,projection_status,authority_manifest,manifest_digest,body_digest,$4
               from import_manifests where id=$5`,
          [manifestId, eventId, event.ingested_sequence, event.occurred_at, imported.manifestId],
        );
      })).rejects.toThrow("IMPORT_EVENT_AUTHORITY_INVALID");
      expect(await ctx.db.one<{ count: number }>(
        "select count(*)::integer count from events where id=$1",
        [eventId],
      )).toEqual({ count: 0 });
    }
    expect(await ctx.db.one(
      `select (select count(*)::integer from events) events,
              (select count(*)::integer from import_manifests) manifests`,
    )).toEqual(before);
  }, 30_000);

  it("persists an independently reconstructed verification receipt and database chain gates", async () => {
    const ctx = await testContext();
    const text = "Use completed evidence as an operator-reviewed candidate.";
    const imported = await runBootstrapImport(ctx, {
      namespace: "repo",
      sourceType: "OPERATOR_CORRECTION",
      locator: "docs/verification-receipt.md",
      sourceTimestamp: "2026-08-08T23:49:40.000Z",
      digest: digest(text),
      sourceBytes: Buffer.from(text, "utf8"),
      parserVersion: "bootstrap-parser-v1",
      items: [{
        id: "candidate",
        text,
        byteRange: { start: 0, end: Buffer.byteLength(text) },
        kind: "STRUCTURAL_METHOD",
        visibilityScope: "OPERATOR",
        excerptRef: "docs/verification-receipt.md#candidate",
      }],
    });
    const verification = await verifyBootstrap(ctx, imported.manifestId) as Awaited<
      ReturnType<typeof verifyBootstrap>
    > & { readonly receiptId: string; readonly receiptDigest: string };
    expect(verification).toMatchObject({
      valid: true,
      receiptId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const receipt = await ctx.db.one<{
      event_id: string;
      verification_digest: string;
      source_count: number;
      source_bytes: string;
      parsed_count: number;
      rejected_count: number;
      duplicate_count: number;
      projection_status: string;
      manifest_event_high_water: string;
      verified_event_high_water: string;
      provenance_count: number;
      body_count: number;
      outbox_count: number;
      valid: boolean;
      body_digest: string;
    }>(
      `select event_id::text,verification_digest,source_count,source_bytes::text,
              parsed_count,rejected_count,duplicate_count,projection_status,
              manifest_event_high_water::text,verified_event_high_water::text,
              provenance_count,body_count,outbox_count,valid,body_digest
         from import_verification_receipts where id=$1`,
      [verification.receiptId],
    );
    expect(receipt).toMatchObject({
      verification_digest: verification.receiptDigest,
      source_count: 1,
      source_bytes: String(Buffer.byteLength(text)),
      parsed_count: 1,
      rejected_count: 0,
      duplicate_count: 0,
      projection_status: "VERIFIED",
      provenance_count: 1,
      body_count: 3,
      outbox_count: 3,
      valid: true,
    });
    expect(BigInt(receipt.verified_event_high_water))
      .toBeGreaterThanOrEqual(BigInt(receipt.manifest_event_high_water));
    const receiptBody = await readEventBody(ctx.db, receipt.event_id, {
      actor: { role: "OPERATOR", purpose: "verify persisted verification receipt" },
    });
    expect(receipt.body_digest).toBe(canonicalContentDigest(receiptBody));
    expect(receiptBody).toMatchObject({
      manifestId: imported.manifestId,
      verificationDigest: verification.receiptDigest,
      valid: true,
      reconstructed: {
        sourceCount: 1,
        parsedCount: 1,
        rejectedCount: 0,
        duplicateCount: 0,
      },
    });

    const indexes = (await ctx.db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname=current_schema()
        and indexname in ('import_manifests_one_root_idx','import_manifests_one_successor_idx')
        order by indexname`,
    )).map(({ indexdef }) => indexdef).join("\n");
    expect(indexes).toContain("UNIQUE");
    expect(indexes).toContain("prior_manifest_id");
    expect(indexes).toContain("source_namespace");
    const itemConstraints = (await ctx.db.query<{ definition: string }>(
      `select pg_get_constraintdef(constraint_row.oid) definition
         from pg_constraint constraint_row
         join pg_class relation on relation.oid=constraint_row.conrelid
        where relation.relname='import_source_items' order by constraint_row.conname`,
    )).map(({ definition }) => definition).join("\n");
    expect(itemConstraints).toContain("private-node-authorization-boundary-v1");
    expect(itemConstraints).toContain("d9058b7bb63949ef3339b002c7067fdf1c1b7969df78e4d1726f0412f70d896f");
  }, 30_000);

  it("produces a verified encrypted operator archive with a digest-only public manifest", async () => {
    const raw = Buffer.from("dated ETH context", "utf8");
    const key = Buffer.alloc(32, 7);
    const archived = archiveLegacyBundle([
      { locator: "docs/ETH_CONTEXT.md", bytes: raw },
    ], key);

    expect(archived.ciphertext.toString("utf8")).not.toContain(raw.toString("utf8"));
    expect(archived.manifest).toEqual({
      sources: [{ locator: "docs/ETH_CONTEXT.md", digest: digest(raw.toString("utf8")) }],
    });
    expect(JSON.stringify(archived.manifest)).not.toContain(raw.toString("utf8"));
    const archiveActor = { role: "OPERATOR", purpose: "verified legacy archive recovery" } as const;
    expect(verifyLegacyBundle(archived, key, archiveActor)).toBe(true);
    expect(() => verifyLegacyBundle(archived, key, { role: "PUBLIC" })).toThrow("FORBIDDEN");
    expect(() => openLegacyBundle(archived, key, { role: "PUBLIC" })).toThrow("FORBIDDEN");
    expect(openLegacyBundle(archived, key, archiveActor))
      .toEqual([{ locator: "docs/ETH_CONTEXT.md", bytes: raw }]);
    const tampered = { ...archived, ciphertext: Buffer.from(archived.ciphertext) };
    tampered.ciphertext[0] ^= 1;
    expect(verifyLegacyBundle(tampered, key, archiveActor)).toBe(false);

    const twoSourceArchive = archiveLegacyBundle([{
      locator: "docs/first.md",
      bytes: Buffer.from("first decoded secret", "utf8"),
    }, {
      locator: "docs/second.md",
      bytes: Buffer.from("second decoded secret", "utf8"),
    }], key);
    const decipher = createDecipheriv("aes-256-gcm", key, twoSourceArchive.iv);
    decipher.setAAD(Buffer.from(canonicalJson({
      format: twoSourceArchive.format,
      manifestDigest: twoSourceArchive.manifestDigest,
    }), "utf8"));
    decipher.setAuthTag(twoSourceArchive.authTag);
    const plaintext = Buffer.concat([
      decipher.update(twoSourceArchive.ciphertext),
      decipher.final(),
    ]);
    const malformedDocument = JSON.parse(plaintext.toString("utf8")) as {
      format: string;
      sources: Array<{ locator: string; bytesBase64: string }>;
    };
    plaintext.fill(0);
    malformedDocument.sources[1]!.bytesBase64 = Buffer.from("wrong later entry", "utf8")
      .toString("base64");
    const malformedPlaintext = Buffer.from(canonicalJson(malformedDocument), "utf8");
    const malformedIv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, malformedIv);
    cipher.setAAD(Buffer.from(canonicalJson({
      format: twoSourceArchive.format,
      manifestDigest: twoSourceArchive.manifestDigest,
    }), "utf8"));
    const malformedCiphertext = Buffer.concat([
      cipher.update(malformedPlaintext),
      cipher.final(),
    ]);
    malformedPlaintext.fill(0);
    const malformedTag = cipher.getAuthTag();
    const malformedArchive = {
      ...twoSourceArchive,
      ciphertext: malformedCiphertext,
      iv: malformedIv,
      authTag: malformedTag,
      archiveDigest: `sha256:${createHash("sha256")
        .update(Buffer.concat([malformedIv, malformedTag, malformedCiphertext])).digest("hex")}`,
    };
    const observedPlaintext: Buffer[] = [];
    const openWithObserver = openLegacyBundle as unknown as (
      archive: typeof malformedArchive,
      archiveKey: Buffer,
      actor: typeof archiveActor,
      observeDecodedBuffer: (bytes: Buffer) => void,
    ) => readonly { readonly locator: string; readonly bytes: Buffer }[];
    expect(() => openWithObserver(
      malformedArchive,
      key,
      archiveActor,
      (bytes) => observedPlaintext.push(bytes),
    )).toThrow("LEGACY_ARCHIVE_MANIFEST_MISMATCH");
    expect(observedPlaintext).toHaveLength(2);
    expect(observedPlaintext.every((bytes) => bytes.every((value) => value === 0))).toBe(true);

    const archiveScript = await readFile("scripts/archive-legacy-knowledge.ts", "utf8");
    expect(archiveScript).toContain("--output");
    expect(archiveScript).toContain("--remove-verified");
    expect(archiveScript).toContain("ARCHIVE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
    expect(archiveScript).toContain("ARCHIVE_ATOMIC_REMOVAL_UNAVAILABLE");
    expect(archiveScript).toContain("gustavo-manual-removal-receipt-v1");
    expect(archiveScript).not.toContain("unlinkSync");
    expect(archiveScript).not.toContain("renameSync");
    expect(archiveScript).not.toContain("source.quarantine");
    expect(archiveScript).not.toContain("AtomicRemovalAdapter");
    expect(await readFile(".gitignore", "utf8")).toContain("*.gustavo-archive");
  });

  it("rejects a forged transport receipt before archive output or source removal", async () => {
    const ctx = await testContext();
    await ctx.db.one("select 1 as connected");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "gustavo-archive-regression-"));
    const repositoryRoot = join(temporaryRoot, "repo");
    const operatorRoot = join(temporaryRoot, "operator");
    const first = join(repositoryRoot, "docs", "first.md");
    const second = join(repositoryRoot, "docs", "second.md");
    const output = join(operatorRoot, "legacy.gustavo-archive");
    const manifestOutput = join(operatorRoot, "legacy.manifest.json");
    const key = Buffer.alloc(32, 19);
    const sources = [
      { locator: "docs/first.md", bytes: Buffer.from("first original", "utf8") },
      { locator: "docs/second.md", bytes: Buffer.from("second original", "utf8") },
    ] as const;
    try {
      await mkdir(join(repositoryRoot, "docs"), { recursive: true });
      await mkdir(operatorRoot, { recursive: true });
      await writeFile(first, sources[0].bytes);
      await writeFile(second, sources[1].bytes);
      const confirmedManifestDigest = archiveLegacyBundle([sources[0]], key).manifestDigest;
      const verificationReceipt = sealBootstrapArchiveTransportReceipt({
        format: "gustavo-bootstrap-archive-receipt-v1",
        manifestId: randomUUID(),
        manifestDigest: "1".repeat(64),
        verificationReceiptId: randomUUID(),
        verificationDigest: "2".repeat(64),
        sources: [sources[0]].map((source) => ({
          locator: source.locator,
          digest: digest(source.bytes.toString("utf8")),
          lifecycleClass: "DEPRECATED" as const,
          archiveDecision: "ARCHIVE_AS_SUPERSEDED_RAW" as const,
          archiveDecisionEventId: randomUUID(),
          itemIds: [randomUUID()],
        })),
      }, key);
      const archiveScript = await import("../../scripts/archive-legacy-knowledge");
      await expect(archiveScript.archiveLegacyFiles({
        repositoryRoot,
        inputs: [first, second],
        output: join(operatorRoot, "multi-remove.gustavo-archive"),
        manifestOutput: join(operatorRoot, "multi-remove.manifest.json"),
        key,
        removeVerified: true as const,
        confirmedManifestDigest,
        verificationReceipt,
        authorityContext: ctx,
      })).rejects.toThrow("ARCHIVE_REMOVAL_REQUIRES_EXACTLY_ONE_SOURCE");
      await expect(archiveScript.archiveLegacyFiles({
        repositoryRoot,
        inputs: [first],
        output,
        manifestOutput,
        key,
        removeVerified: true,
        confirmedManifestDigest,
        verificationReceipt,
        authorityContext: ctx,
      })).rejects.toThrow("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      await expect(access(first)).resolves.toBeUndefined();
      await expect(access(second)).resolves.toBeUndefined();
      await expect(access(output)).rejects.toThrow();
      await expect(access(manifestOutput)).rejects.toThrow();
      expect(await readFile(first, "utf8")).toBe("first original");
      expect(await readFile(second, "utf8")).toBe("second original");
    } finally {
      key.fill(0);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("requires manual removal after durable verified archive artifacts", async () => {
    const fixture = await archiveRemovalFixture("manual-removal-required");
    const archiveScript = await import("../../scripts/archive-legacy-knowledge");
    const output = join(fixture.operatorRoot, "manual.gustavo-archive");
    const manifestOutput = join(fixture.operatorRoot, "manual.manifest.json");
    const manualReceiptOutput = `${output}.manual-removal.json`;
    try {
      await expect(archiveScript.archiveLegacyFiles({
        repositoryRoot: fixture.repositoryRoot,
        inputs: [fixture.sourcePath],
        output,
        manifestOutput,
        key: fixture.key,
        removeVerified: true,
        verificationReceipt: fixture.receipt,
        authorityContext: fixture.ctx,
      })).rejects.toThrow("ARCHIVE_ATOMIC_REMOVAL_UNAVAILABLE");
      expect(await readFile(fixture.sourcePath, "utf8")).toBe(fixture.sourceText);
      const archiveText = await readFile(output, "utf8");
      expect(archiveText).not.toContain(fixture.sourceText);
      const publicManifest = JSON.parse(await readFile(manifestOutput, "utf8")) as {
        readonly sources: readonly { readonly locator: string; readonly digest: string }[];
      };
      expect(publicManifest.sources).toEqual([{
        locator: "docs/legacy-paper.md",
        digest: digest(fixture.sourceText),
      }]);
      const manualReceiptText = await readFile(manualReceiptOutput, "utf8");
      expect(manualReceiptText).not.toContain(fixture.sourceText);
      const manualReceipt = JSON.parse(manualReceiptText) as Record<string, unknown>;
      expect(manualReceipt).toMatchObject({
        format: "gustavo-manual-removal-receipt-v1",
        manualRemovalRequired: true,
        sourcePath: fixture.sourcePath,
        sourceDigest: digest(fixture.sourceText),
        locator: "docs/legacy-paper.md",
        archiveDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        archiveDecision: "ARCHIVE_AS_SUPERSEDED_RAW",
        authenticationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      const { authenticationDigest, ...authenticatedReceipt } = manualReceipt;
      expect(authenticationDigest).toBe(createHmac("sha256", fixture.key)
        .update(canonicalJson(authenticatedReceipt), "utf8").digest("hex"));
      await expect(archiveScript.archiveLegacyFiles({
        repositoryRoot: fixture.repositoryRoot,
        inputs: [fixture.sourcePath],
        output,
        manifestOutput,
        key: fixture.key,
        removeVerified: true,
        verificationReceipt: fixture.receipt,
        authorityContext: fixture.ctx,
      })).rejects.toThrow("ARCHIVE_ATOMIC_REMOVAL_UNAVAILABLE");
      expect(await readFile(manualReceiptOutput, "utf8")).toBe(manualReceiptText);
      expect(await readFile(fixture.sourcePath, "utf8")).toBe(fixture.sourceText);
      expect((await readdir(fixture.operatorRoot, { withFileTypes: true }))
        .some((entry) => entry.isDirectory()
          && entry.name.startsWith(".gustavo-archive-op-"))).toBe(false);
    } finally {
      fixture.key.fill(0);
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves a changed source after durable archive persistence", async () => {
    const fixture = await archiveRemovalFixture("manual-removal-mutation");
    const archiveScript = await import("../../scripts/archive-legacy-knowledge");
    const output = join(fixture.operatorRoot, "mutation.gustavo-archive");
    const manifestOutput = join(fixture.operatorRoot, "mutation.manifest.json");
    const changed = "Changed after encrypted archive persistence.";
    try {
      await expect(archiveScript.archiveLegacyFiles({
        repositoryRoot: fixture.repositoryRoot,
        inputs: [fixture.sourcePath],
        output,
        manifestOutput,
        key: fixture.key,
        removeVerified: true,
        verificationReceipt: fixture.receipt,
        authorityContext: fixture.ctx,
        beforeRemovalVerification: async () => {
          await writeFile(fixture.sourcePath, changed, "utf8");
        },
      })).rejects.toThrow("ARCHIVE_SOURCE_CHANGED_BEFORE_REMOVAL");
      expect(await readFile(fixture.sourcePath, "utf8")).toBe(changed);
      expect(await readFile(output, "utf8")).not.toContain(fixture.sourceText);
      expect(JSON.parse(await readFile(manifestOutput, "utf8"))).toMatchObject({
        sources: [{
          locator: "docs/legacy-paper.md",
          digest: digest(fixture.sourceText),
        }],
      });
      await expect(access(`${output}.manual-removal.json`)).rejects.toThrow();
    } finally {
      fixture.key.fill(0);
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects tampered durable artifacts without producing removal authority", async () => {
    const fixture = await archiveRemovalFixture("manual-removal-tamper");
    const archiveScript = await import("../../scripts/archive-legacy-knowledge");
    const output = join(fixture.operatorRoot, "tamper.gustavo-archive");
    const manifestOutput = join(fixture.operatorRoot, "tamper.manifest.json");
    try {
      await expect(archiveScript.archiveLegacyFiles({
        repositoryRoot: fixture.repositoryRoot,
        inputs: [fixture.sourcePath],
        output,
        manifestOutput,
        key: fixture.key,
        removeVerified: true,
        verificationReceipt: fixture.receipt,
        authorityContext: fixture.ctx,
        beforeRemovalVerification: async () => {
          await writeFile(manifestOutput, "{\"tampered\":true}\n", "utf8");
        },
      })).rejects.toThrow("ARCHIVE_PUBLIC_MANIFEST_VERIFICATION_FAILED");
      expect(await readFile(fixture.sourcePath, "utf8")).toBe(fixture.sourceText);
      expect(await readFile(output, "utf8")).not.toContain(fixture.sourceText);
      await expect(access(`${output}.manual-removal.json`)).rejects.toThrow();
    } finally {
      fixture.key.fill(0);
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rechecks database authority before issuing manual-removal instructions", async () => {
    const fixture = await archiveRemovalFixture("manual-removal-authority-race");
    const archiveScript = await import("../../scripts/archive-legacy-knowledge");
    const output = join(fixture.operatorRoot, "authority-race.gustavo-archive");
    const manifestOutput = join(fixture.operatorRoot, "authority-race.manifest.json");
    const item = await fixture.ctx.db.one<{ id: string; manifest_id: string }>(
      `select id::text, manifest_id::text
         from import_source_items where id=$1`,
      [fixture.receipt.sources[0]!.itemIds[0]],
    );
    try {
      await expect(archiveScript.archiveLegacyFiles({
        repositoryRoot: fixture.repositoryRoot,
        inputs: [fixture.sourcePath],
        output,
        manifestOutput,
        key: fixture.key,
        removeVerified: true,
        verificationReceipt: fixture.receipt,
        authorityContext: fixture.ctx,
        beforeRemovalVerification: async () => {
          await deactivateImportItems(fixture.ctx, {
            manifestId: item.manifest_id,
            itemIds: [item.id],
            actor: {
              role: "OPERATOR",
              id: "operator:manual-removal-authority-race",
              purpose: "revoke manual-removal authority before final receipt",
            },
            reason: "Fail closed before manual-removal instructions are issued.",
            idempotencyKey: `manual-removal-authority-race:${item.manifest_id}`,
          });
        },
      })).rejects.toThrow("ARCHIVE_DATABASE_AUTHORITY_INVALID");
      expect(await readFile(fixture.sourcePath, "utf8")).toBe(fixture.sourceText);
      expect(await access(output)).toBeUndefined();
      expect(await access(manifestOutput)).toBeUndefined();
      await expect(access(`${output}.manual-removal.json`)).rejects.toThrow();
    } finally {
      fixture.key.fill(0);
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
