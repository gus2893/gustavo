import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { lstat, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { closeDatabase, getDatabase } from "../lib/server/db/postgres";
import {
  runBootstrapImport,
  type BootstrapSource,
} from "../lib/server/import/run";
import { IMPORT_LIMITS } from "../lib/server/import/classify";

const IMPORT_DESCRIPTOR_BYTES_LIMIT = 15_000_000;
const FILE_READ_CHUNK_BYTES = 65_536;

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  limitError: string,
): Promise<Buffer> {
  const pathStat = await lstat(path, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("IMPORT_SOURCE_FILE_INVALID");
  if (pathStat.size > BigInt(maximumBytes)) throw new Error(limitError);
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let complete = false;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino
      || before.size !== pathStat.size) {
      throw new Error("IMPORT_SOURCE_FILE_CHANGED");
    }
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(
        FILE_READ_CHUNK_BYTES,
        maximumBytes + 1 - total,
      ));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) {
        chunk.fill(0);
        throw new Error(limitError);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || BigInt(total) !== before.size) {
      throw new Error("IMPORT_SOURCE_FILE_CHANGED");
    }
    const result = Buffer.concat(chunks, total);
    for (const chunk of chunks) chunk.fill(0);
    complete = true;
    return result;
  } finally {
    await handle.close();
    if (!complete) {
      for (const chunk of chunks) chunk.fill(0);
    }
  }
}

function decodedBase64Bytes(value: string): number {
  if (value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("IMPORT_SOURCE_BASE64_INVALID");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4 * 3) - padding;
}

function inputPath(arguments_: readonly string[]): string {
  const index = arguments_.indexOf("--input");
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  if (!value) throw new Error("USAGE: tsx scripts/import-bootstrap.ts --input <export.json>");
  return value;
}

export async function sourceFromDocument(path: string): Promise<BootstrapSource> {
  const descriptorBytes = await readBoundedRegularFile(
    path,
    IMPORT_DESCRIPTOR_BYTES_LIMIT,
    "IMPORT_DESCRIPTOR_BYTES_LIMIT",
  );
  let value: unknown;
  try {
    value = JSON.parse(descriptorBytes.toString("utf8")) as unknown;
  } finally {
    descriptorBytes.fill(0);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IMPORT_DOCUMENT_INVALID");
  }
  const document = value as Record<string, unknown>;
  for (const [field, maximum] of [
    ["namespace", IMPORT_LIMITS.namespaceBytes],
    ["locator", IMPORT_LIMITS.locatorBytes],
    ["parserVersion", 128],
    ["sourceType", 64],
  ] as const) {
    const text = document[field];
    if (typeof text !== "string" || text.trim().length === 0
      || Buffer.byteLength(text, "utf8") > maximum) {
      throw new Error(`IMPORT_${field.toUpperCase()}_LIMIT`);
    }
  }
  const hasPath = typeof document.sourcePath === "string";
  const hasBase64 = typeof document.sourceBytesBase64 === "string";
  if (hasPath === hasBase64) throw new Error("IMPORT_EXACT_SOURCE_REQUIRED");
  if (hasPath && (!(document.sourcePath as string).trim()
    || Buffer.byteLength(document.sourcePath as string, "utf8")
      > IMPORT_LIMITS.locatorBytes)) {
    throw new Error("IMPORT_SOURCE_PATH_LIMIT");
  }
  for (const [field, maximum] of [["digest", 71], ["sourceTimestamp", 64]] as const) {
    const text = document[field];
    if (text !== undefined && (typeof text !== "string"
      || Buffer.byteLength(text, "utf8") > maximum)) {
      throw new Error(`IMPORT_${field.toUpperCase()}_LIMIT`);
    }
  }
  if (!Array.isArray(document.items) || document.items.length < 1
    || document.items.length > IMPORT_LIMITS.items) {
    throw new Error("IMPORT_ITEM_LIMIT");
  }
  for (const value of document.items) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("IMPORT_ITEM_BYTE_RANGE_INVALID");
    }
    const item = value as Record<string, unknown>;
    for (const [field, maximum] of [
      ["id", 256],
      ["excerptRef", IMPORT_LIMITS.locatorBytes],
      ["kind", 64],
      ["visibilityScope", 32],
    ] as const) {
      const text = item[field];
      if (typeof text !== "string" || text.trim().length === 0
        || Buffer.byteLength(text, "utf8") > maximum) {
        throw new Error(`IMPORT_${field.toUpperCase()}_LIMIT`);
      }
    }
    const range = item.byteRange;
    if (range === null || typeof range !== "object" || Array.isArray(range)) {
      throw new Error("IMPORT_ITEM_BYTE_RANGE_INVALID");
    }
    const { start, end } = range as { readonly start?: unknown; readonly end?: unknown };
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || (start as number) < 0 || (end as number) <= (start as number)
      || (end as number) > IMPORT_LIMITS.sourceBytes) {
      throw new Error("IMPORT_ITEM_BYTE_RANGE_INVALID");
    }
    if (item.text !== undefined && (typeof item.text !== "string"
      || Buffer.byteLength(item.text, "utf8") > IMPORT_LIMITS.itemTextBytes)) {
      throw new Error("IMPORT_ITEM_TEXT_LIMIT");
    }
    for (const [field, maximum] of [
      ["canonicalCatalogId", 128],
      ["reviewer", 256],
      ["reviewReason", 1_024],
      ["observedAt", 64],
      ["expiresAt", 64],
      ["effectiveFrom", 64],
      ["effectiveUntil", 64],
    ] as const) {
      const text = item[field];
      if (text !== undefined && (typeof text !== "string"
        || Buffer.byteLength(text, "utf8") > maximum)) {
        throw new Error(`IMPORT_${field.toUpperCase()}_LIMIT`);
      }
    }
    if (item.historicalMetadata !== undefined) {
      const encoded = Buffer.byteLength(JSON.stringify(item.historicalMetadata), "utf8");
      if (encoded > 4_096) throw new Error("IMPORT_HISTORICAL_METADATA_LIMIT");
    }
  }
  let base64Bytes = 0;
  if (hasBase64) {
    const encoded = document.sourceBytesBase64 as string;
    if (encoded.length > Math.ceil(IMPORT_LIMITS.sourceBytes / 3) * 4) {
      throw new Error("IMPORT_SOURCE_BYTES_LIMIT");
    }
    base64Bytes = decodedBase64Bytes(encoded);
    if (base64Bytes > IMPORT_LIMITS.sourceBytes) throw new Error("IMPORT_SOURCE_BYTES_LIMIT");
  }
  const sourceBytes = hasPath
    ? await readBoundedRegularFile(
      resolve(dirname(path), document.sourcePath as string),
      IMPORT_LIMITS.sourceBytes,
      "IMPORT_SOURCE_BYTES_LIMIT",
    )
    : Buffer.from(document.sourceBytesBase64 as string, "base64");
  if (!hasPath && (sourceBytes.length !== base64Bytes
    || sourceBytes.toString("base64") !== document.sourceBytesBase64)) {
    sourceBytes.fill(0);
    throw new Error("IMPORT_SOURCE_BASE64_INVALID");
  }
  const derivedDigest = `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`;
  if (document.digest !== undefined && document.digest !== derivedDigest) {
    sourceBytes.fill(0);
    throw new Error("IMPORT_SOURCE_DIGEST_MISMATCH");
  }
  try {
    const items = document.items.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("IMPORT_ITEM_BYTE_RANGE_INVALID");
      }
      const item = value as Record<string, unknown>;
      const range = item.byteRange;
      if (range === null || typeof range !== "object" || Array.isArray(range)) {
        throw new Error("IMPORT_ITEM_BYTE_RANGE_INVALID");
      }
      const { start, end } = range as { readonly start?: unknown; readonly end?: unknown };
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || (start as number) < 0 || (end as number) <= (start as number)
        || (end as number) > sourceBytes.length) {
        throw new Error("IMPORT_ITEM_BYTE_RANGE_INVALID");
      }
      const excerptBytes = sourceBytes.subarray(start as number, end as number);
      const text = excerptBytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(excerptBytes)) {
        throw new Error("IMPORT_ITEM_BYTE_RANGE_UTF8_INVALID");
      }
      if (item.text !== undefined && item.text !== text) {
        throw new Error("IMPORT_ITEM_TEXT_SOURCE_MISMATCH");
      }
      return { ...item, text };
    });
    return { ...document, digest: derivedDigest, items, sourceBytes } as unknown as BootstrapSource;
  } catch (error) {
    sourceBytes.fill(0);
    throw error;
  }
}

async function main(): Promise<void> {
  const path = inputPath(process.argv.slice(2));
  const document = await sourceFromDocument(resolve(path));
  try {
    const result = await runBootstrapImport({ db: getDatabase() }, document);
    process.stdout.write(`${JSON.stringify({
      classifications: result.classifications,
      duplicates: result.duplicates,
      eventHighWater: result.eventHighWater,
      inserted: result.inserted,
      manifestDigest: result.manifestDigest,
      manifestId: result.manifestId,
      priorManifestId: result.priorManifestId,
    })}\n`);
  } finally {
    document.sourceBytes.fill(0);
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
