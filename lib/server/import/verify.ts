import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { canonicalContentDigest, canonicalJson } from "../events/integrity";

const ARCHIVE_FORMAT = "gustavo-legacy-archive-v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const LEGACY_ARCHIVE_LIMITS = Object.freeze({
  sources: 100,
  sourceBytes: 10_485_760,
  totalBytes: 52_428_800,
  locatorBytes: 1_024,
  ciphertextBytes: 70_010_000,
  serializedBytes: 95_000_000,
  publicManifestBytes: 1_048_576,
});
const BOOTSTRAP_ARCHIVE_RECEIPT_FORMAT = "gustavo-bootstrap-archive-receipt-v1";

export interface LegacyArchiveSource {
  readonly locator: string;
  readonly bytes: Buffer;
}

export interface LegacyArchiveManifest {
  readonly sources: readonly {
    readonly locator: string;
    readonly digest: string;
  }[];
}

export interface LegacyArchive {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly manifest: LegacyArchiveManifest;
  readonly manifestDigest: string;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly archiveDigest: string;
}

export interface BootstrapArchiveReceipt {
  readonly format: typeof BOOTSTRAP_ARCHIVE_RECEIPT_FORMAT;
  readonly manifestId: string;
  readonly manifestDigest: string;
  readonly verificationReceiptId: string;
  readonly verificationDigest: string;
  readonly sources: readonly {
    readonly locator: string;
    readonly digest: string;
    readonly lifecycleClass: "DEPRECATED" | "HISTORICAL";
    readonly archiveDecision: "ARCHIVE_AS_SUPERSEDED_RAW";
    readonly archiveDecisionEventId: string;
    readonly itemIds: readonly string[];
  }[];
  readonly authenticationDigest: string;
}

export type LegacyArchiveActor =
  | { readonly role: "PUBLIC" }
  | { readonly role: "ACCOUNT"; readonly accountId: string }
  | { readonly role: "OPERATOR"; readonly purpose: string }
  | { readonly role: "SYSTEM"; readonly purpose: string };

interface ArchiveDocument {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly sources: readonly {
    readonly locator: string;
    readonly bytesBase64: string;
  }[];
}

function sha256Prefixed(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function authorize(actor: LegacyArchiveActor): void {
  if ((actor.role !== "OPERATOR" && actor.role !== "SYSTEM") || !actor.purpose.trim()) {
    throw new Error("FORBIDDEN");
  }
}

function validateKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error("LEGACY_ARCHIVE_KEY_INVALID");
  }
}

function bootstrapReceiptAuthority(
  receipt: Omit<BootstrapArchiveReceipt, "authenticationDigest">,
): Omit<BootstrapArchiveReceipt, "authenticationDigest"> {
  if (receipt.format !== BOOTSTRAP_ARCHIVE_RECEIPT_FORMAT
    || !/^[a-f0-9-]{36}$/iu.test(receipt.manifestId)
    || !/^[a-f0-9]{64}$/u.test(receipt.manifestDigest)
    || !/^[a-f0-9-]{36}$/iu.test(receipt.verificationReceiptId)
    || !/^[a-f0-9]{64}$/u.test(receipt.verificationDigest)
    || Object.keys(receipt).sort().join(",")
      !== "format,manifestDigest,manifestId,sources,verificationDigest,verificationReceiptId"
    || !Array.isArray(receipt.sources) || receipt.sources.length > LEGACY_ARCHIVE_LIMITS.sources) {
    throw new Error("ARCHIVE_BOOTSTRAP_RECEIPT_INVALID");
  }
  const sources = receipt.sources.map((source) => {
    if (typeof source.locator !== "string" || !source.locator.trim()
      || Object.keys(source).sort().join(",")
        !== "archiveDecision,archiveDecisionEventId,digest,itemIds,lifecycleClass,locator"
      || Buffer.byteLength(source.locator, "utf8") > LEGACY_ARCHIVE_LIMITS.locatorBytes
      || !/^sha256:[a-f0-9]{64}$/u.test(source.digest)
      || !["DEPRECATED", "HISTORICAL"].includes(source.lifecycleClass)
      || source.archiveDecision !== "ARCHIVE_AS_SUPERSEDED_RAW"
      || !/^[a-f0-9-]{36}$/iu.test(source.archiveDecisionEventId)
      || !Array.isArray(source.itemIds) || source.itemIds.length < 1
      || source.itemIds.some((id: unknown) => typeof id !== "string"
        || !/^[a-f0-9-]{36}$/iu.test(id))) {
      throw new Error("ARCHIVE_BOOTSTRAP_RECEIPT_INVALID");
    }
    return Object.freeze({ ...source, itemIds: Object.freeze([...source.itemIds].sort()) });
  }).sort((left, right) => left.locator.localeCompare(right.locator, "en"));
  if (new Set(sources.map(({ locator }) => locator)).size !== sources.length) {
    throw new Error("ARCHIVE_BOOTSTRAP_RECEIPT_INVALID");
  }
  return Object.freeze({ ...receipt, sources: Object.freeze(sources) });
}

export function sealBootstrapArchiveTransportReceipt(
  authority: Omit<BootstrapArchiveReceipt, "authenticationDigest">,
  key: Buffer,
): BootstrapArchiveReceipt {
  validateKey(key);
  const normalized = bootstrapReceiptAuthority(authority);
  const authenticationDigest = createHmac("sha256", key)
    .update(canonicalJson(normalized)).digest("hex");
  return Object.freeze({ ...normalized, authenticationDigest });
}

export function verifyBootstrapArchiveTransportIntegrity(
  receipt: BootstrapArchiveReceipt,
  key: Buffer,
): boolean {
  validateKey(key);
  try {
    if (!/^[a-f0-9]{64}$/u.test(receipt.authenticationDigest)) return false;
    const { authenticationDigest, ...authority } = receipt;
    const normalized = bootstrapReceiptAuthority(authority);
    const expected = createHmac("sha256", key).update(canonicalJson(normalized)).digest();
    const actual = Buffer.from(authenticationDigest, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validateSources(sources: readonly LegacyArchiveSource[]): readonly LegacyArchiveSource[] {
  if (!Array.isArray(sources) || sources.length < 1
    || sources.length > LEGACY_ARCHIVE_LIMITS.sources) {
    throw new Error("LEGACY_ARCHIVE_SOURCE_LIMIT");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const normalized: LegacyArchiveSource[] = [];
  let complete = false;
  try {
    for (const source of sources) {
      if (typeof source.locator !== "string" || !source.locator.trim()
        || Buffer.byteLength(source.locator, "utf8") > LEGACY_ARCHIVE_LIMITS.locatorBytes) {
        throw new Error("LEGACY_ARCHIVE_LOCATOR_INVALID");
      }
      if (seen.has(source.locator)) throw new Error("LEGACY_ARCHIVE_LOCATOR_DUPLICATE");
      seen.add(source.locator);
      if (!Buffer.isBuffer(source.bytes)
        || source.bytes.length > LEGACY_ARCHIVE_LIMITS.sourceBytes) {
        throw new Error("LEGACY_ARCHIVE_SOURCE_BYTES_LIMIT");
      }
      totalBytes += source.bytes.length;
      if (totalBytes > LEGACY_ARCHIVE_LIMITS.totalBytes) {
        throw new Error("LEGACY_ARCHIVE_BYTES_LIMIT");
      }
      normalized.push({ locator: source.locator, bytes: Buffer.from(source.bytes) });
    }
    normalized.sort((left, right) => left.locator.localeCompare(right.locator, "en"));
    complete = true;
    return Object.freeze(normalized);
  } finally {
    if (!complete) {
      for (const source of normalized) source.bytes.fill(0);
    }
  }
}

function decryptArchive(archive: LegacyArchive, key: Buffer): ArchiveDocument {
  validateKey(key);
  if (archive.format !== ARCHIVE_FORMAT || archive.iv.length !== IV_BYTES
    || archive.authTag.length !== TAG_BYTES
    || archive.ciphertext.length > LEGACY_ARCHIVE_LIMITS.ciphertextBytes
    || canonicalContentDigest(archive.manifest) !== archive.manifestDigest
    || sha256Prefixed(Buffer.concat([archive.iv, archive.authTag, archive.ciphertext]))
      !== archive.archiveDigest) {
    throw new Error("LEGACY_ARCHIVE_INTEGRITY_INVALID");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, archive.iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(canonicalJson({
    format: archive.format,
    manifestDigest: archive.manifestDigest,
  }), "utf8"));
  decipher.setAuthTag(archive.authTag);
  const plaintextChunks: Buffer[] = [];
  let plaintext: Buffer | undefined;
  try {
    plaintextChunks.push(decipher.update(archive.ciphertext));
    plaintextChunks.push(decipher.final());
    plaintext = Buffer.concat(plaintextChunks);
    const value = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("LEGACY_ARCHIVE_DOCUMENT_INVALID");
    }
    const document = value as Partial<ArchiveDocument>;
    if (Object.keys(document).sort().join(",") !== "format,sources"
      || document.format !== ARCHIVE_FORMAT || !Array.isArray(document.sources)
      || document.sources.length < 1
      || document.sources.length > LEGACY_ARCHIVE_LIMITS.sources) {
      throw new Error("LEGACY_ARCHIVE_DOCUMENT_INVALID");
    }
    return document as ArchiveDocument;
  } finally {
    plaintext?.fill(0);
    for (const chunk of plaintextChunks) chunk.fill(0);
  }
}

function decodedSources(
  document: ArchiveDocument,
  manifest: LegacyArchiveManifest,
  observeDecodedBuffer?: (bytes: Buffer) => void,
): readonly LegacyArchiveSource[] {
  if (document.sources.length !== manifest.sources.length) {
    throw new Error("LEGACY_ARCHIVE_MANIFEST_MISMATCH");
  }
  const decoded: LegacyArchiveSource[] = [];
  let complete = false;
  let totalBytes = 0;
  try {
    for (const [index, source] of document.sources.entries()) {
      if (typeof source?.locator !== "string" || typeof source?.bytesBase64 !== "string") {
        throw new Error("LEGACY_ARCHIVE_DOCUMENT_INVALID");
      }
      if (Object.keys(source).sort().join(",") !== "bytesBase64,locator") {
        throw new Error("LEGACY_ARCHIVE_DOCUMENT_INVALID");
      }
      if (Buffer.byteLength(source.locator, "utf8") > LEGACY_ARCHIVE_LIMITS.locatorBytes
        || source.bytesBase64.length > Math.ceil(LEGACY_ARCHIVE_LIMITS.sourceBytes / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
          .test(source.bytesBase64)) {
        throw new Error("LEGACY_ARCHIVE_DOCUMENT_INVALID");
      }
      const bytes = Buffer.from(source.bytesBase64, "base64");
      decoded.push({ locator: source.locator, bytes });
      observeDecodedBuffer?.(bytes);
      totalBytes += bytes.length;
      if (bytes.length > LEGACY_ARCHIVE_LIMITS.sourceBytes
        || totalBytes > LEGACY_ARCHIVE_LIMITS.totalBytes) {
        throw new Error("LEGACY_ARCHIVE_SOURCE_BYTES_LIMIT");
      }
      if (bytes.toString("base64") !== source.bytesBase64) {
        throw new Error("LEGACY_ARCHIVE_DOCUMENT_INVALID");
      }
      const expected = manifest.sources[index];
      if (!expected || expected.locator !== source.locator
        || expected.digest !== sha256Prefixed(bytes)) {
        throw new Error("LEGACY_ARCHIVE_MANIFEST_MISMATCH");
      }
    }
    complete = true;
    return Object.freeze(decoded);
  } finally {
    if (!complete) {
      for (const source of decoded) source.bytes.fill(0);
    }
  }
}

export function archiveLegacyBundle(
  sources: readonly LegacyArchiveSource[],
  key: Buffer,
): LegacyArchive {
  validateKey(key);
  const normalized = validateSources(sources);
  let plaintext: Buffer | undefined;
  try {
    const manifest: LegacyArchiveManifest = Object.freeze({
      sources: Object.freeze(normalized.map((source) => Object.freeze({
        locator: source.locator,
        digest: sha256Prefixed(source.bytes),
      }))),
    });
    const manifestDigest = canonicalContentDigest(manifest);
    const document: ArchiveDocument = {
      format: ARCHIVE_FORMAT,
      sources: normalized.map((source) => ({
        locator: source.locator,
        bytesBase64: source.bytes.toString("base64"),
      })),
    };
    plaintext = Buffer.from(canonicalJson(document), "utf8");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(canonicalJson({ format: ARCHIVE_FORMAT, manifestDigest }), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Object.freeze({
      format: ARCHIVE_FORMAT,
      manifest,
      manifestDigest,
      ciphertext,
      iv,
      authTag,
      archiveDigest: sha256Prefixed(Buffer.concat([iv, authTag, ciphertext])),
    });
  } finally {
    plaintext?.fill(0);
    for (const source of normalized) source.bytes.fill(0);
  }
}

export function openLegacyBundle(
  archive: LegacyArchive,
  key: Buffer,
  actor: LegacyArchiveActor,
  observeDecodedBuffer?: (bytes: Buffer) => void,
): readonly LegacyArchiveSource[] {
  authorize(actor);
  return decodedSources(decryptArchive(archive, key), archive.manifest, observeDecodedBuffer);
}

export function verifyLegacyBundle(
  archive: LegacyArchive,
  key: Buffer,
  actor: LegacyArchiveActor,
): boolean {
  authorize(actor);
  let sources: readonly LegacyArchiveSource[] = [];
  try {
    sources = decodedSources(decryptArchive(archive, key), archive.manifest);
    return true;
  } catch {
    return false;
  } finally {
    for (const source of sources) source.bytes.fill(0);
  }
}
