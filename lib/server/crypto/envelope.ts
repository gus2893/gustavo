import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const AES_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export interface WrappedDataKey {
  readonly rootKeyVersion: number;
  readonly wrappedKey: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

export interface EncryptedBody {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

function assertServerOnly(): void {
  if (typeof window !== "undefined") {
    throw new Error("SERVER_ONLY_CRYPTO");
  }
}

function parseRootKeyVersion(): number {
  const rawVersion = process.env.GUSTAVO_EVENT_ROOT_KEY_VERSION ?? "1";
  if (!/^\d+$/.test(rawVersion)) {
    throw new Error("INVALID_EVENT_ROOT_KEY_VERSION");
  }
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("INVALID_EVENT_ROOT_KEY_VERSION");
  }
  return version;
}

function loadRootKey(version: number): Buffer {
  assertServerOnly();
  const environmentName = `GUSTAVO_EVENT_ROOT_KEY_V${version}`;
  if (environmentName.startsWith("NEXT_PUBLIC_")) {
    throw new Error("PUBLIC_ROOT_KEY_FORBIDDEN");
  }
  const encoded = process.env[environmentName];
  if (!encoded) {
    throw new Error(`MISSING_EVENT_ROOT_KEY:${version}`);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== AES_KEY_BYTES || key.toString("base64") !== encoded) {
    throw new Error(`INVALID_EVENT_ROOT_KEY:${version}`);
  }
  return key;
}

function encryptAesGcm(plaintext: Buffer, key: Buffer, aad: Buffer): EncryptedBody {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: AES_GCM_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decryptAesGcm(encrypted: EncryptedBody, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv, {
    authTagLength: AES_GCM_TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

export function createAndWrapDataKey(aggregateId: string): {
  readonly dataKey: Buffer;
  readonly wrapped: WrappedDataKey;
} {
  const dataKey = randomBytes(AES_KEY_BYTES);
  return {
    dataKey,
    wrapped: wrapDataKey(aggregateId, dataKey),
  };
}

export function wrapDataKey(
  aggregateId: string,
  dataKey: Buffer,
  rootKeyVersion = parseRootKeyVersion(),
): WrappedDataKey {
  if (dataKey.length !== AES_KEY_BYTES) {
    throw new Error("INVALID_EVENT_DATA_KEY");
  }
  const aad = Buffer.from(`gustavo:aggregate-key:${aggregateId}:v${rootKeyVersion}`, "utf8");
  const encrypted = encryptAesGcm(dataKey, loadRootKey(rootKeyVersion), aad);
  return {
    rootKeyVersion,
    wrappedKey: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
  };
}

export function unwrapDataKey(aggregateId: string, wrapped: WrappedDataKey): Buffer {
  const aad = Buffer.from(
    `gustavo:aggregate-key:${aggregateId}:v${wrapped.rootKeyVersion}`,
    "utf8",
  );
  return decryptAesGcm(
    {
      ciphertext: wrapped.wrappedKey,
      iv: wrapped.iv,
      authTag: wrapped.authTag,
    },
    loadRootKey(wrapped.rootKeyVersion),
    aad,
  );
}

export function encryptEventBody(
  eventId: string,
  integrityHash: string,
  plaintext: Buffer,
  dataKey: Buffer,
): EncryptedBody {
  assertServerOnly();
  return encryptAesGcm(
    plaintext,
    dataKey,
    Buffer.from(`gustavo:event-body:${eventId}:${integrityHash}`, "utf8"),
  );
}

export function decryptEventBody(
  eventId: string,
  integrityHash: string,
  encrypted: EncryptedBody,
  dataKey: Buffer,
): Buffer {
  assertServerOnly();
  return decryptAesGcm(
    encrypted,
    dataKey,
    Buffer.from(`gustavo:event-body:${eventId}:${integrityHash}`, "utf8"),
  );
}
