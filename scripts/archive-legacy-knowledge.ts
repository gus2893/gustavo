import { createHash, createHmac } from "node:crypto";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeDatabase, getDatabase } from "../lib/server/db/postgres";
import { canonicalJson } from "../lib/server/events/integrity";
import {
  executeWithBootstrapArchiveAuthority,
  verifyBootstrapArchiveAuthority,
  type ImportContext,
} from "../lib/server/import/run";
import {
  archiveLegacyBundle,
  LEGACY_ARCHIVE_LIMITS,
  verifyBootstrapArchiveTransportIntegrity,
  verifyLegacyBundle,
  type BootstrapArchiveReceipt,
  type LegacyArchive,
  type LegacyArchiveManifest,
  type LegacyArchiveSource,
} from "../lib/server/import/verify";

interface ArchiveArguments {
  readonly inputs: readonly string[];
  readonly output: string;
  readonly manifestOutput: string;
  readonly removeVerified: boolean;
  readonly confirmedManifestDigest?: string;
  readonly verificationReceiptPath?: string;
}

interface ArchiveLegacyFilesInputBase {
  readonly repositoryRoot: string;
  readonly inputs: readonly string[];
  readonly output: string;
  readonly manifestOutput: string;
  readonly key: Buffer;
  readonly confirmedManifestDigest?: string;
  /** Runs after durable artifacts and before the final source/DB revalidation. */
  readonly beforeRemovalVerification?: () => Promise<void>;
}

export type ArchiveLegacyFilesInput = ArchiveLegacyFilesInputBase & (
  | {
    readonly removeVerified: false;
    readonly verificationReceipt?: BootstrapArchiveReceipt;
    readonly authorityContext?: never;
  }
  | {
    readonly removeVerified: true;
    readonly verificationReceipt: BootstrapArchiveReceipt;
    readonly authorityContext: ImportContext;
  }
);

interface SerializedArchive {
  readonly format: LegacyArchive["format"];
  readonly manifest: LegacyArchiveManifest;
  readonly manifestDigest: string;
  readonly ciphertextBase64: string;
  readonly ivBase64: string;
  readonly authTagBase64: string;
  readonly archiveDigest: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface ResolvedLegacyInput {
  readonly path: string;
  readonly locator: string;
  readonly identity: FileIdentity;
}

interface ManualRemovalReceiptPayload {
  readonly format: "gustavo-manual-removal-receipt-v1";
  readonly manualRemovalRequired: true;
  readonly reason: "ATOMIC_OS_HANDLE_ADAPTER_UNAVAILABLE";
  readonly instruction: string;
  readonly archiveDigest: string;
  readonly archiveManifestDigest: string;
  readonly bootstrapManifestId: string;
  readonly bootstrapManifestDigest: string;
  readonly verificationReceiptId: string;
  readonly verificationDigest: string;
  readonly sourcePath: string;
  readonly locator: string;
  readonly sourceDigest: string;
  readonly lifecycleClass: "DEPRECATED" | "HISTORICAL";
  readonly archiveDecision: "ARCHIVE_AS_SUPERSEDED_RAW";
  readonly archiveDecisionEventId: string;
  readonly itemIds: readonly string[];
}

interface ManualRemovalReceipt extends ManualRemovalReceiptPayload {
  readonly receiptDigest: string;
  readonly authenticationDigest: string;
}

export class AtomicRemovalUnavailableError extends Error {
  readonly manualRemovalRequired = true;
  readonly manualRemovalReceiptPath: string;

  constructor(manualRemovalReceiptPath: string) {
    super("ARCHIVE_ATOMIC_REMOVAL_UNAVAILABLE");
    this.name = "AtomicRemovalUnavailableError";
    this.manualRemovalReceiptPath = manualRemovalReceiptPath;
  }
}

const FILE_READ_CHUNK_BYTES = 65_536;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(values: readonly string[]): ArchiveArguments {
  const inputs: string[] = [];
  let output: string | undefined;
  let manifestOutput: string | undefined;
  let removeVerified = false;
  let confirmedManifestDigest: string | undefined;
  let verificationReceiptPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--remove-verified") {
      removeVerified = true;
      continue;
    }
    const value = values[index + 1];
    if (!value) throw new Error(`ARCHIVE_ARGUMENT_VALUE_REQUIRED:${flag}`);
    index += 1;
    if (flag === "--input") inputs.push(value);
    else if (flag === "--output") output = value;
    else if (flag === "--manifest") manifestOutput = value;
    else if (flag === "--confirm-manifest-digest") confirmedManifestDigest = value;
    else if (flag === "--verification-receipt") verificationReceiptPath = value;
    else throw new Error(`ARCHIVE_ARGUMENT_UNSUPPORTED:${flag}`);
  }
  if (inputs.length === 0 || !output || !manifestOutput) {
    throw new Error(
      "USAGE: tsx scripts/archive-legacy-knowledge.ts --input <file> "
      + "--output <outside-repo.gustavo-archive> --manifest <digest-manifest.json>",
    );
  }
  return Object.freeze({
    inputs: Object.freeze(inputs),
    output,
    manifestOutput,
    removeVerified,
    confirmedManifestDigest,
    verificationReceiptPath,
  });
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function identityOf(value: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): FileIdentity {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameSnapshot(left: FileIdentity, right: FileIdentity): boolean {
  return sameIdentity(left, right)
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function assertNoReparseComponents(repositoryRoot: string, candidate: string): Promise<void> {
  const path = relative(repositoryRoot, candidate);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("ARCHIVE_INPUT_OUTSIDE_REPOSITORY");
  }
  let current = repositoryRoot;
  for (const component of path.split(sep)) {
    current = join(current, component);
    const componentStat = await lstat(current, { bigint: true });
    if (componentStat.isSymbolicLink()) throw new Error("ARCHIVE_INPUT_REPARSE_FORBIDDEN");
  }
}

async function inspectRegularFile(path: string): Promise<FileIdentity> {
  const value = await lstat(path, { bigint: true });
  if (value.isSymbolicLink()) throw new Error("ARCHIVE_INPUT_REPARSE_FORBIDDEN");
  if (!value.isFile()) throw new Error("ARCHIVE_INPUT_NOT_FILE");
  return identityOf(value);
}

async function resolveLegacyInputs(
  paths: readonly string[],
  repositoryRoot: string,
): Promise<readonly ResolvedLegacyInput[]> {
  if (!Array.isArray(paths) || paths.length < 1
    || paths.length > LEGACY_ARCHIVE_LIMITS.sources) {
    throw new Error("LEGACY_ARCHIVE_SOURCE_LIMIT");
  }
  const realRepositoryRoot = await realpath(repositoryRoot);
  const resolved: ResolvedLegacyInput[] = [];
  let totalBytes = 0n;
  for (const path of paths) {
    const requested = resolve(repositoryRoot, path);
    await assertNoReparseComponents(realRepositoryRoot, requested);
    const exact = await realpath(requested);
    if (!isWithin(realRepositoryRoot, exact)) throw new Error("ARCHIVE_INPUT_OUTSIDE_REPOSITORY");
    const identity = await inspectRegularFile(exact);
    if (identity.size > BigInt(LEGACY_ARCHIVE_LIMITS.sourceBytes)) {
      throw new Error("LEGACY_ARCHIVE_SOURCE_BYTES_LIMIT");
    }
    totalBytes += identity.size;
    if (totalBytes > BigInt(LEGACY_ARCHIVE_LIMITS.totalBytes)) {
      throw new Error("LEGACY_ARCHIVE_BYTES_LIMIT");
    }
    const locator = relative(realRepositoryRoot, exact).split(sep).join("/");
    if (Buffer.byteLength(locator, "utf8") > LEGACY_ARCHIVE_LIMITS.locatorBytes) {
      throw new Error("LEGACY_ARCHIVE_LOCATOR_INVALID");
    }
    resolved.push(Object.freeze({ path: exact, locator, identity }));
  }
  if (new Set(resolved.map(({ path }) => path)).size !== resolved.length) {
    throw new Error("ARCHIVE_INPUT_DUPLICATE");
  }
  return Object.freeze(resolved);
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  expectedIdentity?: FileIdentity,
): Promise<{ readonly bytes: Buffer; readonly identity: FileIdentity }> {
  const pathIdentity = await inspectRegularFile(path);
  if (pathIdentity.size > BigInt(maximumBytes)) {
    throw new Error("LEGACY_ARCHIVE_SOURCE_BYTES_LIMIT");
  }
  if (expectedIdentity && !sameIdentity(pathIdentity, expectedIdentity)) {
    throw new Error("ARCHIVE_SOURCE_CHANGED_BEFORE_REMOVAL");
  }
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let complete = false;
  try {
    const beforeStat = await handle.stat({ bigint: true });
    const before = identityOf(beforeStat);
    if (!beforeStat.isFile() || !sameSnapshot(before, pathIdentity)) {
      throw new Error("ARCHIVE_SOURCE_CHANGED_BEFORE_REMOVAL");
    }
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(
        FILE_READ_CHUNK_BYTES,
        maximumBytes + 1 - total,
      ));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        chunk.fill(0);
        break;
      }
      total += bytesRead;
      if (total > maximumBytes) {
        chunk.fill(0);
        throw new Error("LEGACY_ARCHIVE_SOURCE_BYTES_LIMIT");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = identityOf(await handle.stat({ bigint: true }));
    if (!sameSnapshot(before, after) || BigInt(total) !== after.size) {
      throw new Error("ARCHIVE_SOURCE_CHANGED_BEFORE_REMOVAL");
    }
    const bytes = Buffer.concat(chunks, total);
    for (const chunk of chunks) chunk.fill(0);
    complete = true;
    return Object.freeze({ bytes, identity: after });
  } finally {
    await handle.close();
    if (!complete) for (const chunk of chunks) chunk.fill(0);
  }
}

async function resolveOutsideOutput(path: string, repositoryRoot: string): Promise<string> {
  const output = resolve(path);
  const realRepositoryRoot = await realpath(repositoryRoot);
  const realParent = await realpath(dirname(output));
  if (isWithin(realRepositoryRoot, realParent) || realParent === realRepositoryRoot) {
    throw new Error("ARCHIVE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  }
  return output;
}

function archiveKey(): Buffer {
  const encoded = process.env.GUSTAVO_LEGACY_ARCHIVE_KEY;
  if (!encoded) throw new Error("GUSTAVO_LEGACY_ARCHIVE_KEY_REQUIRED");
  if (encoded.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) {
    throw new Error("GUSTAVO_LEGACY_ARCHIVE_KEY_INVALID");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("GUSTAVO_LEGACY_ARCHIVE_KEY_INVALID");
  }
  return key;
}

function serializeArchive(archive: LegacyArchive): SerializedArchive {
  return {
    format: archive.format,
    manifest: archive.manifest,
    manifestDigest: archive.manifestDigest,
    ciphertextBase64: archive.ciphertext.toString("base64"),
    ivBase64: archive.iv.toString("base64"),
    authTagBase64: archive.authTag.toString("base64"),
    archiveDigest: archive.archiveDigest,
  };
}

function deserializeArchive(value: SerializedArchive): LegacyArchive {
  if (value === null || typeof value !== "object"
    || Object.keys(value).sort().join(",")
      !== "archiveDigest,authTagBase64,ciphertextBase64,format,ivBase64,manifest,manifestDigest"
    || typeof value.ciphertextBase64 !== "string"
    || value.ciphertextBase64.length > Math.ceil(LEGACY_ARCHIVE_LIMITS.ciphertextBytes / 3) * 4
    || typeof value.ivBase64 !== "string" || typeof value.authTagBase64 !== "string") {
    throw new Error("ARCHIVE_SERIALIZED_DOCUMENT_INVALID");
  }
  for (const encoded of [value.ciphertextBase64, value.ivBase64, value.authTagBase64]) {
    if (encoded.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(encoded)) {
      throw new Error("ARCHIVE_SERIALIZED_DOCUMENT_INVALID");
    }
  }
  return {
    format: value.format,
    manifest: value.manifest,
    manifestDigest: value.manifestDigest,
    ciphertext: Buffer.from(value.ciphertextBase64, "base64"),
    iv: Buffer.from(value.ivBase64, "base64"),
    authTag: Buffer.from(value.authTagBase64, "base64"),
    archiveDigest: value.archiveDigest,
  };
}

function publicManifest(
  archive: LegacyArchive,
  verificationReceipt?: BootstrapArchiveReceipt,
): Record<string, unknown> {
  return {
    archiveDigest: archive.archiveDigest,
    manifestDigest: archive.manifestDigest,
    sourceCount: archive.manifest.sources.length,
    ...(verificationReceipt === undefined ? {} : {
      bootstrapVerification: {
        authenticationDigest: verificationReceipt.authenticationDigest,
        manifestId: verificationReceipt.manifestId,
        verificationDigest: verificationReceipt.verificationDigest,
        verificationReceiptId: verificationReceipt.verificationReceiptId,
      },
    }),
    ...archive.manifest,
  };
}

function digest(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function verifyRemovalReceipt(
  inputs: readonly ResolvedLegacyInput[],
  receipt: BootstrapArchiveReceipt | undefined,
  key: Buffer,
): void {
  if (!receipt || !verifyBootstrapArchiveTransportIntegrity(receipt, key)) {
    throw new Error("ARCHIVE_BOOTSTRAP_VERIFICATION_RECEIPT_REQUIRED");
  }
  const expected = new Map(receipt.sources.map((source) => [source.locator, source]));
  if (expected.size !== inputs.length) {
    throw new Error("ARCHIVE_SOURCE_NOT_VERIFIED_SUPERSEDED_RAW");
  }
  for (const input of inputs) {
    const source = expected.get(input.locator);
    if (!source || source.archiveDecision !== "ARCHIVE_AS_SUPERSEDED_RAW"
      || (source.lifecycleClass !== "DEPRECATED" && source.lifecycleClass !== "HISTORICAL")) {
      throw new Error("ARCHIVE_SOURCE_NOT_VERIFIED_SUPERSEDED_RAW");
    }
    expected.delete(input.locator);
  }
  if (expected.size !== 0) throw new Error("ARCHIVE_SOURCE_NOT_VERIFIED_SUPERSEDED_RAW");
}

function verifyArchiveMatchesReceipt(
  archive: LegacyArchive,
  receipt: BootstrapArchiveReceipt,
): void {
  const expected = new Map(receipt.sources.map((source) => [source.locator, source.digest]));
  if (expected.size !== archive.manifest.sources.length) {
    throw new Error("ARCHIVE_SOURCE_NOT_VERIFIED_SUPERSEDED_RAW");
  }
  for (const source of archive.manifest.sources) {
    if (expected.get(source.locator) !== source.digest) {
      throw new Error("ARCHIVE_SOURCE_NOT_VERIFIED_SUPERSEDED_RAW");
    }
    expected.delete(source.locator);
  }
  if (expected.size !== 0) throw new Error("ARCHIVE_SOURCE_NOT_VERIFIED_SUPERSEDED_RAW");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectoryMetadata(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableExclusive(
  path: string,
  value: string,
  mode: number,
): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryMetadata(dirname(path));
}

async function ensureDurableExact(
  path: string,
  value: string,
  mode: number,
  maximumBytes: number,
): Promise<void> {
  if (!(await pathExists(path))) {
    try {
      await writeDurableExclusive(path, value, mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const persisted = await readBoundedFile(path, maximumBytes);
  try {
    if (persisted.bytes.toString("utf8") !== value) {
      throw new Error("ARCHIVE_IMMUTABLE_PUBLICATION_CONFLICT");
    }
  } finally {
    persisted.bytes.fill(0);
  }
  await syncDirectoryMetadata(dirname(path));
}

async function loadAndVerifyPersistedArchive(
  output: string,
  manifestOutput: string,
  key: Buffer,
  receipt: BootstrapArchiveReceipt,
): Promise<LegacyArchive> {
  const persistedArchiveFile = await readBoundedFile(
    output, LEGACY_ARCHIVE_LIMITS.serializedBytes,
  );
  let persisted: LegacyArchive;
  try {
    persisted = deserializeArchive(
      JSON.parse(persistedArchiveFile.bytes.toString("utf8")) as SerializedArchive,
    );
  } finally {
    persistedArchiveFile.bytes.fill(0);
  }
  const actor = { role: "OPERATOR", purpose: "verify durable manual-removal archive" } as const;
  if (!verifyLegacyBundle(persisted, key, actor)) {
    throw new Error("ARCHIVE_VERIFICATION_FAILED");
  }
  verifyArchiveMatchesReceipt(persisted, receipt);
  const persistedManifestFile = await readBoundedFile(
    manifestOutput, LEGACY_ARCHIVE_LIMITS.publicManifestBytes,
  );
  let persistedPublicManifest: unknown;
  try {
    persistedPublicManifest = JSON.parse(persistedManifestFile.bytes.toString("utf8"));
  } finally {
    persistedManifestFile.bytes.fill(0);
  }
  if (canonicalJson(persistedPublicManifest)
    !== canonicalJson(publicManifest(persisted, receipt))) {
    throw new Error("ARCHIVE_PUBLIC_MANIFEST_VERIFICATION_FAILED");
  }
  return persisted;
}

function sealManualRemovalReceipt(
  payload: ManualRemovalReceiptPayload,
  key: Buffer,
): ManualRemovalReceipt {
  const receiptDigest = createHash("sha256")
    .update(canonicalJson(payload), "utf8").digest("hex");
  const authenticated = { ...payload, receiptDigest };
  return Object.freeze({
    ...authenticated,
    authenticationDigest: createHmac("sha256", key)
      .update(canonicalJson(authenticated), "utf8").digest("hex"),
  });
}

function manualRemovalReceipt(
  descriptor: ResolvedLegacyInput,
  archive: LegacyArchive,
  receipt: BootstrapArchiveReceipt,
  key: Buffer,
): ManualRemovalReceipt {
  const source = receipt.sources[0];
  if (!source || receipt.sources.length !== 1 || source.locator !== descriptor.locator) {
    throw new Error("ARCHIVE_SOURCE_NOT_VERIFIED_SUPERSEDED_RAW");
  }
  return sealManualRemovalReceipt(Object.freeze({
    format: "gustavo-manual-removal-receipt-v1",
    manualRemovalRequired: true,
    reason: "ATOMIC_OS_HANDLE_ADAPTER_UNAVAILABLE",
    instruction: "Verify the exact path and SHA-256 digest, then remove manually using an operator-controlled OS tool.",
    archiveDigest: archive.archiveDigest,
    archiveManifestDigest: archive.manifestDigest,
    bootstrapManifestId: receipt.manifestId,
    bootstrapManifestDigest: receipt.manifestDigest,
    verificationReceiptId: receipt.verificationReceiptId,
    verificationDigest: receipt.verificationDigest,
    sourcePath: descriptor.path,
    locator: descriptor.locator,
    sourceDigest: source.digest,
    lifecycleClass: source.lifecycleClass,
    archiveDecision: source.archiveDecision,
    archiveDecisionEventId: source.archiveDecisionEventId,
    itemIds: Object.freeze([...source.itemIds]),
  }), key);
}

async function revalidateExactSource(
  descriptor: ResolvedLegacyInput,
  expectedDigest: string,
): Promise<void> {
  const current = await readBoundedFile(
    descriptor.path, LEGACY_ARCHIVE_LIMITS.sourceBytes, descriptor.identity,
  );
  try {
    if (digest(current.bytes) !== expectedDigest) {
      throw new Error("ARCHIVE_SOURCE_CHANGED_BEFORE_REMOVAL");
    }
  } finally {
    current.bytes.fill(0);
  }
}

async function archiveVerifiedForManualRemoval(
  input: Extract<ArchiveLegacyFilesInput, { readonly removeVerified: true }>,
): Promise<never> {
  if (input.inputs.length !== 1) {
    throw new Error("ARCHIVE_REMOVAL_REQUIRES_EXACTLY_ONE_SOURCE");
  }
  const repositoryRoot = await realpath(resolve(input.repositoryRoot));
  const output = await resolveOutsideOutput(input.output, repositoryRoot);
  const manifestOutput = await resolveOutsideOutput(input.manifestOutput, repositoryRoot);
  const manualReceiptOutput = `${output}.manual-removal.json`;
  await resolveOutsideOutput(manualReceiptOutput, repositoryRoot);
  if (!verifyBootstrapArchiveTransportIntegrity(input.verificationReceipt, input.key)) {
    throw new Error("ARCHIVE_BOOTSTRAP_VERIFICATION_RECEIPT_REQUIRED");
  }
  const inputs = await resolveLegacyInputs(input.inputs, repositoryRoot);
  verifyRemovalReceipt(inputs, input.verificationReceipt, input.key);
  await verifyBootstrapArchiveAuthority(input.authorityContext, input.verificationReceipt);
  const descriptor = inputs[0]!;
  const [archiveExists, manifestExists] = await Promise.all([
    pathExists(output),
    pathExists(manifestOutput),
  ]);
  if (archiveExists !== manifestExists) {
    throw new Error("ARCHIVE_IMMUTABLE_PUBLICATION_CONFLICT");
  }
  let archive: LegacyArchive | undefined;
  try {
    if (archiveExists) {
      archive = await loadAndVerifyPersistedArchive(
        output, manifestOutput, input.key, input.verificationReceipt,
      );
    } else {
      const source = await readBoundedFile(
        descriptor.path, LEGACY_ARCHIVE_LIMITS.sourceBytes, descriptor.identity,
      );
      try {
        archive = archiveLegacyBundle([{
          locator: descriptor.locator,
          bytes: source.bytes,
        }], input.key);
      } finally {
        source.bytes.fill(0);
      }
      verifyArchiveMatchesReceipt(archive, input.verificationReceipt);
      if (input.confirmedManifestDigest !== undefined
        && input.confirmedManifestDigest !== archive.manifestDigest) {
        throw new Error("ARCHIVE_REMOVAL_DIGEST_CONFIRMATION_REQUIRED");
      }
      await ensureDurableExact(
        output,
        `${JSON.stringify(serializeArchive(archive))}\n`,
        0o600,
        LEGACY_ARCHIVE_LIMITS.serializedBytes,
      );
      await ensureDurableExact(
        manifestOutput,
        `${JSON.stringify(publicManifest(archive, input.verificationReceipt), null, 2)}\n`,
        0o644,
        LEGACY_ARCHIVE_LIMITS.publicManifestBytes,
      );
    }
    if (input.confirmedManifestDigest !== undefined
      && input.confirmedManifestDigest !== archive.manifestDigest) {
      throw new Error("ARCHIVE_REMOVAL_DIGEST_CONFIRMATION_REQUIRED");
    }
    await input.beforeRemovalVerification?.();
    await executeWithBootstrapArchiveAuthority(
      input.authorityContext,
      input.verificationReceipt,
      async () => {
        const expectedSource = input.verificationReceipt.sources[0];
        if (!expectedSource) throw new Error("ARCHIVE_SOURCE_NOT_VERIFIED_SUPERSEDED_RAW");
        await revalidateExactSource(descriptor, expectedSource.digest);
        const finalArchive = await loadAndVerifyPersistedArchive(
          output, manifestOutput, input.key, input.verificationReceipt,
        );
        try {
          const receipt = manualRemovalReceipt(
            descriptor, finalArchive, input.verificationReceipt, input.key,
          );
          await ensureDurableExact(
            manualReceiptOutput,
            `${JSON.stringify(receipt, null, 2)}\n`,
            0o600,
            LEGACY_ARCHIVE_LIMITS.publicManifestBytes,
          );
        } finally {
          finalArchive.ciphertext.fill(0);
          finalArchive.iv.fill(0);
          finalArchive.authTag.fill(0);
        }
      },
    );
    throw new AtomicRemovalUnavailableError(manualReceiptOutput);
  } finally {
    archive?.ciphertext.fill(0);
    archive?.iv.fill(0);
    archive?.authTag.fill(0);
  }
}

async function archiveWithoutRemoval(
  input: Extract<ArchiveLegacyFilesInput, { readonly removeVerified: false }>,
): Promise<{
  readonly archiveDigest: string;
  readonly manifestDigest: string;
  readonly removed: 0;
  readonly sources: number;
}> {
  const repositoryRoot = await realpath(resolve(input.repositoryRoot));
  const output = await resolveOutsideOutput(input.output, repositoryRoot);
  const manifestOutput = await resolveOutsideOutput(input.manifestOutput, repositoryRoot);
  const inputs = await resolveLegacyInputs(input.inputs, repositoryRoot);
  const sources: LegacyArchiveSource[] = [];
  try {
    for (const descriptor of inputs) {
      const source = await readBoundedFile(
        descriptor.path, LEGACY_ARCHIVE_LIMITS.sourceBytes, descriptor.identity,
      );
      sources.push({ locator: descriptor.locator, bytes: source.bytes });
    }
    const archive = archiveLegacyBundle(sources, input.key);
    await ensureDurableExact(
      output,
      `${JSON.stringify(serializeArchive(archive))}\n`,
      0o600,
      LEGACY_ARCHIVE_LIMITS.serializedBytes,
    );
    await ensureDurableExact(
      manifestOutput,
      `${JSON.stringify(publicManifest(archive, input.verificationReceipt), null, 2)}\n`,
      0o644,
      LEGACY_ARCHIVE_LIMITS.publicManifestBytes,
    );
    return Object.freeze({
      archiveDigest: archive.archiveDigest,
      manifestDigest: archive.manifestDigest,
      removed: 0,
      sources: inputs.length,
    });
  } finally {
    for (const source of sources) source.bytes.fill(0);
  }
}

export async function archiveLegacyFiles(input: ArchiveLegacyFilesInput): Promise<{
  readonly archiveDigest: string;
  readonly manifestDigest: string;
  readonly removed: 0;
  readonly sources: number;
}> {
  if (input.removeVerified) return archiveVerifiedForManualRemoval(input);
  return archiveWithoutRemoval(input);
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const key = archiveKey();
  let databaseOpened = false;
  try {
    let verificationReceipt: BootstrapArchiveReceipt | undefined;
    if (arguments_.verificationReceiptPath !== undefined) {
      const receiptFile = await readBoundedFile(
        arguments_.verificationReceiptPath, LEGACY_ARCHIVE_LIMITS.publicManifestBytes,
      );
      try {
        verificationReceipt = JSON.parse(
          receiptFile.bytes.toString("utf8"),
        ) as BootstrapArchiveReceipt;
      } finally {
        receiptFile.bytes.fill(0);
      }
    }
    const common = {
      repositoryRoot: REPOSITORY_ROOT,
      inputs: arguments_.inputs,
      output: arguments_.output,
      manifestOutput: arguments_.manifestOutput,
      key,
      confirmedManifestDigest: arguments_.confirmedManifestDigest,
    } as const;
    const result = arguments_.removeVerified
      ? await (async () => {
        if (!verificationReceipt) {
          throw new Error("ARCHIVE_BOOTSTRAP_VERIFICATION_RECEIPT_REQUIRED");
        }
        databaseOpened = true;
        return archiveLegacyFiles({
          ...common,
          removeVerified: true,
          verificationReceipt,
          authorityContext: { db: getDatabase() },
        });
      })()
      : await archiveLegacyFiles({
        ...common,
        removeVerified: false,
        verificationReceipt,
      });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    key.fill(0);
    if (databaseOpened) await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    if (error instanceof AtomicRemovalUnavailableError) {
      process.stderr.write(`${JSON.stringify({
        error: error.message,
        manualRemovalRequired: error.manualRemovalRequired,
        manualRemovalReceiptPath: error.manualRemovalReceiptPath,
      })}\n`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
