import { TextEncoder } from "node:util";
import { canonicalContentDigest, canonicalJson, sha256Digest } from "../events/integrity";
import { appendEvents, readEventBodies } from "../events/store";
import type { EventDatabase, JsonValue } from "../events/types";
import {
  CHAT_IMPORT_LIMITS,
  CHAT_MESSAGE_ROLES,
  CHAT_SOURCE_FORMATS,
  CHAT_SOURCE_KINDS,
  type ChatFormatVersion,
  type ChatImportContext,
  type ChatImportResult,
  type ChatManifestParticipant,
  type ChatMessageRole,
  type ReplayedConversationOccurrence,
  type ReplayedItemOccurrence,
  type ReplayedMessageVersion,
  type ReplayedQuarantinePayload,
  type ChatSourceKind,
  type ReplayedChatSourceState,
} from "./contracts";

export type { ChatImportContext, ChatImportResult } from "./contracts";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const EXACT_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const TOP_LEVEL_KEYS = new Set([
  "conversationCount", "conversations", "cursor", "exportedAt", "formatVersion",
  "messageCount", "ownerAuthorizationId", "source", "sourceId",
]);
const CONVERSATION_KEYS = new Set(["id", "messages", "participants"]);
const PARTICIPANT_KEYS = new Set(["id", "role"]);
const MESSAGE_KEYS = new Set([
  "at", "contentDigest", "id", "participantId", "role", "text",
]);
const SOURCE_ADAPTERS: Readonly<Record<string, (document: JsonValue) => JsonValue>> = Object.freeze({
  "CHATGPT_EXPORT:chatgpt-export-v1": (document) => document,
  "CLAUDE_EXPORT:claude-export-v1": (document) => document,
  "OTHER_EXPORT:canonical-chat-v1": (document) => document,
  "CONNECTOR:canonical-connector-v1": (document) => document,
});
const encoder = new TextEncoder();
const WORKER_BRAND = Symbol("trusted-chat-import-worker");

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface TrustedChatImportWorkerContext {
  readonly db: EventDatabase;
  readonly [WORKER_BRAND]: true;
}

interface AuthorizationRow extends Record<string, unknown> {
  id: string; account_id: string; node_brain_id: string;
  source: ChatSourceKind; external_source_id: string;
}

interface SourceRow extends Record<string, unknown> {
  id: string; authorization_id: string; account_id: string; node_brain_id: string;
  source: ChatSourceKind; external_source_id: string; connected_event_id: string;
}

interface CursorRow extends Record<string, unknown> {
  last_import_id: string; manifest_digest: string; revision: string | number;
}

interface EventHashesRow extends Record<string, unknown> {
  request_hash: string; integrity_hash: string;
}

interface EventHashesWithIdRow extends EventHashesRow {
  id: string;
}

interface MessageVersionRow extends Record<string, unknown> {
  id: string; imported_conversation_id: string; external_message_id: string;
  version: number; content_digest: string;
}

interface ConversationVersionRow extends Record<string, unknown> {
  id: string; imported_conversation_id: string; version: number;
  participants_digest: string;
}

interface QuarantineRow extends Record<string, unknown> {
  id: string; record_digest: string; reason: string;
}

interface CapturedManifest {
  readonly source: ChatSourceKind;
  readonly formatVersion: ChatFormatVersion;
  readonly exportedAt: string;
  readonly cursor: string;
  readonly conversationCount: number;
  readonly messageCount: number;
  readonly ownerAuthorizationId: string;
  readonly sourceId: string;
  readonly conversations: readonly unknown[];
  readonly document: JsonValue;
}

interface ParsedMessage {
  readonly externalConversationId: string;
  readonly externalMessageId: string;
  readonly participantId: string;
  readonly participantIdentityDigest: string;
  readonly at: string;
  readonly role: ChatMessageRole;
  readonly text: string;
  readonly contentDigest: string;
  readonly recordDigest: string;
  readonly itemOrdinal: number;
}

interface ParsedConversation {
  readonly externalConversationId: string;
  readonly participants: readonly ChatManifestParticipant[];
  readonly participantsDigest: string;
  readonly messages: readonly ParsedMessage[];
  readonly ordinal: number;
}

interface QuarantinedItem {
  readonly externalConversationId: string | null;
  readonly externalMessageId: string | null;
  readonly itemOrdinal: number;
  readonly itemScope: "CONVERSATION" | "MESSAGE";
  readonly conversationOrdinal: number;
  readonly recordDigest: string;
  readonly reason: string;
  readonly raw: JsonValue;
}

interface AuthorityHeader {
  readonly kind: "SOURCE_CONNECTED" | "CURSOR_ADVANCED" | "CONVERSATION_VERSION"
    | "MESSAGE_VERSION" | "QUARANTINE_PAYLOAD";
  readonly chatSourceId: string;
  readonly accountId: string;
  readonly nodeBrainId: string;
  readonly source?: string | null;
  readonly authorizationId?: string | null;
  readonly importId?: string | null;
  readonly sourceRevision?: number | null;
  readonly importedConversationId?: string | null;
  readonly conversationVersionId?: string | null;
  readonly externalSourceId?: string | null;
  readonly identityDigest?: string | null;
  readonly externalConversationId?: string | null;
  readonly externalMessageId?: string | null;
  readonly participantIdentityDigest?: string | null;
  readonly participantCount?: number | null;
  readonly participantsDigest?: string | null;
  readonly messageVersionId?: string | null;
  readonly messageVersion?: number | null;
  readonly messageIdentityDigest?: string | null;
  readonly versionIdentityDigest?: string | null;
  readonly contentDigest?: string | null;
  readonly role?: string | null;
  readonly sourceAt?: string | null;
  readonly predecessorId?: string | null;
  readonly quarantinePayloadId?: string | null;
  readonly itemOrdinal?: number | null;
  readonly recordDigest?: string | null;
  readonly reason?: string | null;
  readonly formatVersion?: string | null;
  readonly exportedAt?: string | null;
  readonly externalCursorDigest?: string | null;
  readonly manifestDigest?: string | null;
  readonly conversationCount?: number | null;
  readonly itemCount?: number | null;
  readonly quarantinedCount?: number | null;
  readonly occurrenceManifestDigest?: string | null;
  readonly itemScope?: string | null;
  readonly conversationOrdinal?: number | null;
}

interface CaptureBudget { nodes: number; bytes: number }

function uuidFromDigest(digest: string): string {
  const hexadecimal = digest.slice(0, 32).split("");
  hexadecimal[12] = "5";
  hexadecimal[16] = ((Number.parseInt(hexadecimal[16], 16) & 0x3) | 0x8).toString(16);
  const value = hexadecimal.join("");
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16),
    value.slice(16, 20), value.slice(20)].join("-");
}

function chargeBytes(budget: CaptureBudget, value: string): void {
  budget.bytes += encoder.encode(value).byteLength;
  if (budget.bytes > CHAT_IMPORT_LIMITS.maximumManifestBytes) {
    throw new Error("CHAT_MANIFEST_TOO_LARGE");
  }
}

function captureJson(
  value: unknown,
  depth = 0,
  budget: CaptureBudget = { nodes: 0, bytes: 0 },
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { chargeBytes(budget, value); return value; }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("INVALID_CHAT_MANIFEST");
    return value;
  }
  if (typeof value !== "object" || depth > 10 || budget.nodes++ > 20_000) {
    throw new Error("INVALID_CHAT_MANIFEST");
  }
  if (Array.isArray(value)) {
    if (value.length > CHAT_IMPORT_LIMITS.maximumMessages + CHAT_IMPORT_LIMITS.maximumConversations) {
      throw new Error("CHAT_MANIFEST_TOO_LARGE");
    }
    const captured: JsonValue[] = value.map((item) => captureJson(item, depth + 1, budget));
    Object.freeze(captured);
    return captured;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("INVALID_CHAT_MANIFEST");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 20_000) throw new Error("CHAT_MANIFEST_TOO_LARGE");
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("INVALID_CHAT_MANIFEST");
    chargeBytes(budget, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new Error("INVALID_CHAT_MANIFEST");
    result[key] = captureJson(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function stableIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1
      || value.length > CHAT_IMPORT_LIMITS.maximumIdentifierLength
      || !IDENTIFIER_PATTERN.test(value)) throw new Error(code);
  return value;
}

function boundedOpaqueCursor(value: unknown): string {
  if (typeof value !== "string" || value.length === 0
      || encoder.encode(value).byteLength > CHAT_IMPORT_LIMITS.maximumCursorBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("INVALID_CHAT_CURSOR");
  return value;
}

function exactTime(value: unknown, code: string): string {
  if (typeof value !== "string" || !EXACT_TIME_PATTERN.test(value)) throw new Error(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(code);
  const canonical = parsed.toISOString();
  if (canonical !== (value.includes(".") ? value : `${value.slice(0, -1)}.000Z`)) throw new Error(code);
  return canonical;
}

function exactCount(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error("INVALID_CHAT_MANIFEST_COUNT");
  }
  return value as number;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function sourceFormat(source: ChatSourceKind, value: unknown): ChatFormatVersion {
  if (typeof value !== "string"
      || !(CHAT_SOURCE_FORMATS[source] as readonly string[]).includes(value)) {
    throw new Error("UNSUPPORTED_CHAT_SOURCE_FORMAT");
  }
  return value as ChatFormatVersion;
}

function captureManifest(input: unknown): CapturedManifest {
  const document = captureJson(input);
  const record = objectRecord(document);
  if (!record || Object.keys(record).some((key) => !TOP_LEVEL_KEYS.has(key))) {
    throw new Error("INVALID_CHAT_MANIFEST");
  }
  if (typeof record.source !== "string" || !CHAT_SOURCE_KINDS.includes(record.source as ChatSourceKind)) {
    throw new Error("INVALID_CHAT_SOURCE");
  }
  const source = record.source as ChatSourceKind;
  const formatVersion = sourceFormat(source, record.formatVersion);
  // This dispatch is the data-only adapter boundary. Acquisition/network I/O is forbidden here.
  const adapterKey = `${source}:${formatVersion}`;
  const adapter = SOURCE_ADAPTERS[adapterKey];
  if (!adapter) throw new Error("UNSUPPORTED_CHAT_SOURCE_FORMAT");
  const canonicalDocument = adapter(document);
  const canonicalRecord = objectRecord(canonicalDocument)!;
  if (!Array.isArray(canonicalRecord.conversations)
      || canonicalRecord.conversations.length > CHAT_IMPORT_LIMITS.maximumConversations) {
    throw new Error("CHAT_MANIFEST_TOO_LARGE");
  }
  return Object.freeze({
    source,
    formatVersion,
    exportedAt: exactTime(canonicalRecord.exportedAt, "INVALID_CHAT_EXPORTED_AT"),
    cursor: boundedOpaqueCursor(canonicalRecord.cursor),
    conversationCount: exactCount(canonicalRecord.conversationCount, CHAT_IMPORT_LIMITS.maximumConversations),
    messageCount: exactCount(canonicalRecord.messageCount, CHAT_IMPORT_LIMITS.maximumMessages),
    ownerAuthorizationId: stableIdentifier(canonicalRecord.ownerAuthorizationId, "INVALID_CHAT_AUTHORIZATION_ID"),
    sourceId: stableIdentifier(canonicalRecord.sourceId, "INVALID_CHAT_SOURCE_ID"),
    conversations: canonicalRecord.conversations,
    document: canonicalDocument,
  });
}

function quarantineItem(
  raw: JsonValue,
  reason: string,
  itemOrdinal: number,
  externalConversationId: string | null,
  externalMessageId: string | null,
  itemScope: "CONVERSATION" | "MESSAGE",
  conversationOrdinal: number,
): QuarantinedItem {
  return Object.freeze({
    externalConversationId, externalMessageId, itemOrdinal, itemScope, conversationOrdinal, reason, raw,
    recordDigest: canonicalContentDigest({
      externalConversationId, externalMessageId, itemScope, raw,
    }),
  });
}

function parseParticipants(value: unknown): readonly ChatManifestParticipant[] {
  if (!Array.isArray(value) || value.length < 1
      || value.length > CHAT_IMPORT_LIMITS.maximumParticipantsPerConversation) {
    throw new Error("INVALID_CHAT_PARTICIPANTS");
  }
  const participants = value.map((raw) => {
    const record = objectRecord(raw);
    if (!record || Object.keys(record).some((key) => !PARTICIPANT_KEYS.has(key))) {
      throw new Error("INVALID_CHAT_PARTICIPANT");
    }
    const id = stableIdentifier(record.id, "INVALID_CHAT_PARTICIPANT_ID");
    if (typeof record.role !== "string" || !CHAT_MESSAGE_ROLES.includes(record.role as ChatMessageRole)) {
      throw new Error("INVALID_CHAT_PARTICIPANT_ROLE");
    }
    return Object.freeze({ id, role: record.role as ChatMessageRole });
  });
  if (new Set(participants.map(({ id }) => id)).size !== participants.length) {
    throw new Error("DUPLICATE_CHAT_PARTICIPANT_ID");
  }
  return Object.freeze([...participants].sort((left, right) => compareCodeUnits(left.id, right.id)));
}

function invalidMessageReason(
  record: Record<string, unknown> | null,
  participants: ReadonlyMap<string, ChatMessageRole>,
): string | null {
  if (!record || Object.keys(record).some((key) => !MESSAGE_KEYS.has(key))) return "INVALID_CHAT_MESSAGE_SHAPE";
  try { stableIdentifier(record.id, "INVALID_CHAT_MESSAGE_ID"); }
  catch (error) { return error instanceof Error ? error.message : "INVALID_CHAT_MESSAGE_ID"; }
  try { exactTime(record.at, "INVALID_CHAT_MESSAGE_AT"); }
  catch (error) { return error instanceof Error ? error.message : "INVALID_CHAT_MESSAGE_AT"; }
  if (typeof record.role !== "string" || !CHAT_MESSAGE_ROLES.includes(record.role as ChatMessageRole)) {
    return "INVALID_CHAT_MESSAGE_ROLE";
  }
  if (typeof record.participantId !== "string" || !participants.has(record.participantId)) {
    return "INVALID_CHAT_MESSAGE_PARTICIPANT";
  }
  if (participants.get(record.participantId) !== record.role) return "CHAT_PARTICIPANT_ROLE_MISMATCH";
  if (typeof record.text !== "string" || hasUnpairedSurrogate(record.text)
      || encoder.encode(record.text).byteLength > CHAT_IMPORT_LIMITS.maximumTextBytes) {
    return "INVALID_CHAT_MESSAGE_TEXT";
  }
  if (record.contentDigest !== undefined
      && (typeof record.contentDigest !== "string" || !DIGEST_PATTERN.test(record.contentDigest))) {
    return "INVALID_CHAT_CONTENT_DIGEST";
  }
  return null;
}

function parseItems(manifest: CapturedManifest): {
  readonly conversations: readonly ParsedConversation[];
  readonly quarantined: readonly QuarantinedItem[];
  readonly itemCount: number;
} {
  if (manifest.conversationCount !== manifest.conversations.length) {
    throw new Error("CHAT_MANIFEST_COUNT_MISMATCH");
  }
  const conversations: ParsedConversation[] = [];
  const quarantined: QuarantinedItem[] = [];
  const seenConversations = new Set<string>();
  let totalTextBytes = 0;
  let itemCount = 0;
  let itemOrdinal = 100;
  for (let conversationOrdinal = 0; conversationOrdinal < manifest.conversations.length; conversationOrdinal += 1) {
    const rawConversation = manifest.conversations[conversationOrdinal];
    const record = objectRecord(rawConversation);
    let externalConversationId: string | null = null;
    let conversationFailure: string | null = null;
    if (!record || Object.keys(record).some((key) => !CONVERSATION_KEYS.has(key))
        || !Array.isArray(record.messages)) {
      conversationFailure = "INVALID_CHAT_CONVERSATION_SHAPE";
    } else {
      try { externalConversationId = stableIdentifier(record.id, "INVALID_CHAT_CONVERSATION_ID"); }
      catch (error) {
        conversationFailure = error instanceof Error ? error.message : "INVALID_CHAT_CONVERSATION_ID";
      }
      if (!conversationFailure && seenConversations.has(externalConversationId!)) {
        conversationFailure = "DUPLICATE_CHAT_CONVERSATION_ID";
      }
    }
    let participants: readonly ChatManifestParticipant[] | null = null;
    if (!conversationFailure) {
      try { participants = parseParticipants(record!.participants); }
      catch (error) {
        conversationFailure = error instanceof Error ? error.message : "INVALID_CHAT_PARTICIPANTS";
      }
    }
    if (conversationFailure) {
      itemCount += 1;
      if (itemCount > CHAT_IMPORT_LIMITS.maximumMessages) throw new Error("CHAT_MANIFEST_TOO_LARGE");
      quarantined.push(quarantineItem(
        rawConversation as JsonValue, conversationFailure, itemOrdinal++, externalConversationId,
        null, "CONVERSATION", conversationOrdinal,
      ));
      continue;
    }
    if (!record || !participants || externalConversationId === null) {
      throw new Error("INVALID_CHAT_CONVERSATION_SHAPE");
    }
    seenConversations.add(externalConversationId!);
    const participantsById = new Map(participants.map(({ id, role }) => [id, role]));
    const messages: ParsedMessage[] = [];
    const seenMessages = new Set<string>();
    for (const rawMessage of record.messages as readonly JsonValue[]) {
      itemCount += 1;
      if (itemCount > CHAT_IMPORT_LIMITS.maximumMessages) throw new Error("CHAT_MANIFEST_TOO_LARGE");
      const messageRecord = objectRecord(rawMessage);
      let externalMessageId: string | null = null;
      if (typeof messageRecord?.id === "string" && IDENTIFIER_PATTERN.test(messageRecord.id)
          && messageRecord.id.length <= CHAT_IMPORT_LIMITS.maximumIdentifierLength) {
        externalMessageId = messageRecord.id;
      }
      const invalidReason = invalidMessageReason(messageRecord, participantsById);
      if (invalidReason) {
        quarantined.push(quarantineItem(
          rawMessage, invalidReason, itemOrdinal++, externalConversationId, externalMessageId,
          "MESSAGE", conversationOrdinal,
        ));
        continue;
      }
      externalMessageId = messageRecord!.id as string;
      if (seenMessages.has(externalMessageId)) {
        quarantined.push(quarantineItem(
          rawMessage, "DUPLICATE_CHAT_MESSAGE_ID", itemOrdinal++, externalConversationId, externalMessageId,
          "MESSAGE", conversationOrdinal,
        ));
        continue;
      }
      seenMessages.add(externalMessageId);
      const at = exactTime(messageRecord!.at, "INVALID_CHAT_MESSAGE_AT");
      const role = messageRecord!.role as ChatMessageRole;
      const participantId = messageRecord!.participantId as string;
      const text = messageRecord!.text as string;
      totalTextBytes += encoder.encode(text).byteLength;
      if (totalTextBytes > CHAT_IMPORT_LIMITS.maximumTotalTextBytes) throw new Error("CHAT_MANIFEST_TOO_LARGE");
      const contentDigest = canonicalContentDigest({ at, participantId, role, text });
      if (messageRecord!.contentDigest !== undefined && messageRecord!.contentDigest !== contentDigest) {
        quarantined.push(quarantineItem(
          rawMessage, "CHAT_CONTENT_DIGEST_MISMATCH", itemOrdinal++, externalConversationId, externalMessageId,
          "MESSAGE", conversationOrdinal,
        ));
        continue;
      }
      messages.push(Object.freeze({
        externalConversationId: externalConversationId!, externalMessageId, participantId,
        participantIdentityDigest: canonicalContentDigest({ externalConversationId, participantId }),
        at, role, text, contentDigest,
        recordDigest: canonicalContentDigest({ externalConversationId, externalMessageId, raw: rawMessage }),
        itemOrdinal: itemOrdinal++,
      }));
    }
    conversations.push(Object.freeze({
      externalConversationId: externalConversationId!, participants,
      participantsDigest: canonicalContentDigest({ participants }),
      messages: Object.freeze(messages), ordinal: conversationOrdinal,
    }));
  }
  if (manifest.messageCount !== itemCount) throw new Error("CHAT_MANIFEST_COUNT_MISMATCH");
  return Object.freeze({
    conversations: Object.freeze(conversations),
    quarantined: Object.freeze(quarantined), itemCount,
  });
}

function authorityFields(header: AuthorityHeader): readonly (string | null)[] {
  const text = (value: string | number | null | undefined): string | null => value == null ? null : String(value);
  return [
    header.kind, header.chatSourceId, header.accountId, header.nodeBrainId,
    text(header.source), text(header.authorizationId), text(header.importId), text(header.sourceRevision),
    text(header.importedConversationId), text(header.conversationVersionId), text(header.externalSourceId),
    text(header.identityDigest),
    text(header.externalConversationId), text(header.externalMessageId), text(header.participantIdentityDigest),
    text(header.participantCount), text(header.participantsDigest), text(header.messageVersionId),
    text(header.messageVersion), text(header.messageIdentityDigest), text(header.versionIdentityDigest),
    text(header.contentDigest), text(header.role), text(header.sourceAt), text(header.predecessorId),
    text(header.quarantinePayloadId), text(header.itemOrdinal), text(header.recordDigest), text(header.reason),
    text(header.formatVersion), text(header.exportedAt), text(header.externalCursorDigest),
    text(header.manifestDigest), text(header.conversationCount), text(header.itemCount),
    text(header.quarantinedCount), text(header.occurrenceManifestDigest),
    text(header.itemScope), text(header.conversationOrdinal),
  ];
}

function authorityKey(header: AuthorityHeader): string {
  return `chat-authority-v1|${authorityFields(header).map((value) => (
    value === null ? "-#" : `${Buffer.byteLength(value, "utf8")}#${value}`
  )).join("|")}`;
}

function authorityRow(
  header: AuthorityHeader,
  eventId: string,
  key: string,
  hashes: EventHashesRow,
  createdAt: Date,
): Record<string, unknown> {
  return {
    event_id: eventId, kind: header.kind, chat_source_id: header.chatSourceId,
    account_id: header.accountId, node_brain_id: header.nodeBrainId,
    source: header.source ?? null, authorization_id: header.authorizationId ?? null,
    import_id: header.importId ?? null, source_revision: header.sourceRevision ?? null,
    imported_conversation_id: header.importedConversationId ?? null,
    conversation_version_id: header.conversationVersionId ?? null,
    external_source_id: header.externalSourceId ?? null,
    identity_digest: header.identityDigest ?? null,
    external_conversation_id: header.externalConversationId ?? null,
    external_message_id: header.externalMessageId ?? null,
    participant_identity_digest: header.participantIdentityDigest ?? null,
    participant_count: header.participantCount ?? null,
    participants_digest: header.participantsDigest ?? null,
    message_version_id: header.messageVersionId ?? null,
    message_version: header.messageVersion ?? null,
    message_identity_digest: header.messageIdentityDigest ?? null,
    version_identity_digest: header.versionIdentityDigest ?? null,
    content_digest: header.contentDigest ?? null, role: header.role ?? null,
    source_at: header.sourceAt ?? null, predecessor_id: header.predecessorId ?? null,
    quarantine_payload_id: header.quarantinePayloadId ?? null,
    item_ordinal: header.itemOrdinal ?? null, record_digest: header.recordDigest ?? null,
    reason: header.reason ?? null, format_version: header.formatVersion ?? null,
    exported_at: header.exportedAt ?? null,
    external_cursor_digest: header.externalCursorDigest ?? null,
    manifest_digest: header.manifestDigest ?? null,
    conversation_count: header.conversationCount ?? null,
    item_count: header.itemCount ?? null, quarantined_count: header.quarantinedCount ?? null,
    occurrence_manifest_digest: header.occurrenceManifestDigest ?? null,
    item_scope: header.itemScope ?? null,
    conversation_ordinal: header.conversationOrdinal ?? null,
    authority_key: key, event_request_hash: hashes.request_hash,
    event_integrity_hash: hashes.integrity_hash, created_at: createdAt.toISOString(),
  };
}

function quarantinePayloadId(chatSourceId: string, item: QuarantinedItem): string {
  return uuidFromDigest(canonicalContentDigest({
    chatSourceId, itemScope: item.itemScope, reason: item.reason, recordDigest: item.recordDigest,
  }));
}

function occurrenceManifestFor(
  chatSourceId: string,
  parsed: ReturnType<typeof parseItems>,
): {
  readonly entries: readonly (ReplayedConversationOccurrence | ReplayedItemOccurrence)[];
  readonly text: string;
  readonly digest: string;
} {
  const conversations: ReplayedConversationOccurrence[] = parsed.conversations.map((conversation) => ({
    kind: "CONVERSATION",
    ordinal: conversation.ordinal,
    importedConversationId: uuidFromDigest(canonicalContentDigest({
      chatSourceId, externalConversationId: conversation.externalConversationId,
    })),
    externalConversationId: conversation.externalConversationId,
    participantCount: conversation.participants.length,
    participantsDigest: conversation.participantsDigest,
  }));
  const messages: ReplayedItemOccurrence[] = parsed.conversations.flatMap((conversation) => {
    const importedConversationId = uuidFromDigest(canonicalContentDigest({
      chatSourceId, externalConversationId: conversation.externalConversationId,
    }));
    return conversation.messages.map((message) => ({
      kind: "MESSAGE_VERSION" as const,
      ordinal: message.itemOrdinal,
      importedConversationId,
      externalMessageId: message.externalMessageId,
      messageIdentityDigest: canonicalContentDigest({
        chatSourceId, externalConversationId: message.externalConversationId,
        externalMessageId: message.externalMessageId,
      }),
      contentDigest: message.contentDigest,
      recordDigest: message.recordDigest,
    }));
  });
  const quarantines: ReplayedItemOccurrence[] = parsed.quarantined.map((item) => ({
    kind: "QUARANTINE",
    ordinal: item.itemOrdinal,
    itemScope: item.itemScope,
    conversationOrdinal: item.conversationOrdinal,
    quarantinePayloadId: quarantinePayloadId(chatSourceId, item),
    externalConversationId: item.externalConversationId,
    externalMessageId: item.externalMessageId,
    recordDigest: item.recordDigest,
    reason: item.reason,
  }));
  const entries = Object.freeze([...conversations, ...messages, ...quarantines]
    .sort((left, right) => left.ordinal - right.ordinal));
  const canonical = canonicalJson(entries);
  return Object.freeze({ entries, text: canonical, digest: sha256Digest(canonical) });
}

function eventType(kind: AuthorityHeader["kind"]): string {
  switch (kind) {
    case "SOURCE_CONNECTED": return "chat.source.connected";
    case "CURSOR_ADVANCED": return "chat.source.cursor_advanced";
    case "CONVERSATION_VERSION": return "conversation.imported";
    case "MESSAGE_VERSION": return "knowledge.item.imported";
    case "QUARANTINE_PAYLOAD": return "knowledge.item.classified";
  }
}

async function appendAuthorityEvent(
  database: EventDatabase,
  header: AuthorityHeader,
  body: Record<string, JsonValue>,
  occurredAt: Date,
): Promise<string> {
  return (await appendAuthorityEvents(database, [{ header, body, occurredAt }]))[0];
}

interface AuthorityEventSpec {
  readonly header: AuthorityHeader;
  readonly body: Readonly<Record<string, JsonValue>>;
  readonly occurredAt: Date;
}

async function appendAuthorityEvents(
  database: EventDatabase,
  specifications: readonly AuthorityEventSpec[],
): Promise<readonly string[]> {
  const eventIds: string[] = [];
  for (let offset = 0; offset < specifications.length; offset += 100) {
    const chunk = specifications.slice(offset, offset + 100);
    const keyed = chunk.map((specification) => ({
      ...specification, key: authorityKey(specification.header),
    }));
    const events = await appendEvents(database, keyed.map(({ header, body, occurredAt, key }) => ({
      aggregateId: header.kind === "CONVERSATION_VERSION" || header.kind === "MESSAGE_VERSION"
        ? header.importedConversationId! : header.chatSourceId,
      accountId: header.accountId,
      actor: { type: "SYSTEM" as const, id: "external-chat-importer" },
      type: eventType(header.kind), visibility: "PRIVATE_ACCOUNT" as const, occurredAt,
      idempotencyKey: key, policyVersion: "external-chat-import-v1",
      body: Object.freeze({ ...body, authorityKey: key }),
    })));
    const hashes = await database.query<EventHashesWithIdRow>(
      "select id::text,request_hash,integrity_hash from events where id=any($1::uuid[])",
      [events.map(({ id }) => id)],
    );
    const hashesById = new Map(hashes.map((row) => [row.id, row]));
    const rows = events.map((event, index) => {
      const hashesForEvent = hashesById.get(event.id);
      if (!hashesForEvent) throw new Error("CHAT_EVENT_AUTHORITY_MISMATCH");
      const specification = keyed[index];
      return authorityRow(
        specification.header, event.id, specification.key,
        hashesForEvent, specification.occurredAt,
      );
    });
    await database.query(
      `insert into chat_source_event_manifests
       select * from jsonb_populate_recordset(null::chat_source_event_manifests,$1::jsonb)`,
      [JSON.stringify(rows)],
    );
    eventIds.push(...events.map(({ id }) => id));
  }
  return Object.freeze(eventIds);
}

type ChatBatchTable = "imported_chat_conversations"
  | "imported_chat_conversation_versions" | "chat_import_conversation_occurrences"
  | "imported_chat_message_versions" | "chat_import_item_occurrences"
  | "chat_import_quarantine" | "chat_import_quarantine_occurrences";

async function insertChatRows(
  database: EventDatabase,
  table: ChatBatchTable,
  rows: readonly Readonly<Record<string, unknown>>[],
  onConflictDoNothing = false,
): Promise<void> {
  const tableName: string = ({
    imported_chat_conversations: "imported_chat_conversations",
    imported_chat_conversation_versions: "imported_chat_conversation_versions",
    chat_import_conversation_occurrences: "chat_import_conversation_occurrences",
    imported_chat_message_versions: "imported_chat_message_versions",
    chat_import_item_occurrences: "chat_import_item_occurrences",
    chat_import_quarantine: "chat_import_quarantine",
    chat_import_quarantine_occurrences: "chat_import_quarantine_occurrences",
  } as const)[table];
  for (let offset = 0; offset < rows.length; offset += 100) {
    await database.query(
      `insert into ${tableName}
       select * from jsonb_populate_recordset(null::${tableName},$1::jsonb)
       ${onConflictDoNothing ? "on conflict do nothing" : ""}`,
      [JSON.stringify(rows.slice(offset, offset + 100))],
    );
  }
}

function sameSource(source: SourceRow, authorization: AuthorizationRow): boolean {
  return source.authorization_id === authorization.id && source.account_id === authorization.account_id
    && source.node_brain_id === authorization.node_brain_id && source.source === authorization.source
    && source.external_source_id === authorization.external_source_id;
}

function requireRequesterAccount(value: unknown): string {
  return stableIdentifier(value, "CHAT_IMPORT_ACCOUNT_REQUIRED");
}

async function importCaptured(
  context: { readonly db: EventDatabase; readonly requesterAccountId: string | null },
  input: unknown,
): Promise<ChatImportResult> {
  const manifest = captureManifest(input);
  const parsed = parseItems(manifest);
  const manifestDigest = canonicalContentDigest(manifest.document);
  const externalCursorDigest = canonicalContentDigest({ cursor: manifest.cursor });
  return context.db.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `chat-source:${manifest.ownerAuthorizationId}`,
    ]);
    const authorizationRows = await transaction.query<AuthorizationRow>(
      `select id,account_id::text,node_brain_id::text,source,external_source_id
       from chat_source_authorizations
       where id=$1 and source=$2 and external_source_id=$3
         and granted_at<=clock_timestamp() and revoked_at is null for update`,
      [manifest.ownerAuthorizationId, manifest.source, manifest.sourceId],
    );
    const authorization = authorizationRows[0];
    if (!authorization || (context.requesterAccountId !== null
        && authorization.account_id !== context.requesterAccountId)) {
      throw new Error("SOURCE_NOT_AUTHORIZED");
    }
    const sourceIdentityDigest = canonicalContentDigest({
      accountId: authorization.account_id, externalSourceId: manifest.sourceId, source: manifest.source,
    });
    const chatSourceId = uuidFromDigest(sourceIdentityDigest);
    const now = new Date();
    let sourceRows = await transaction.query<SourceRow>(
      `select id::text,authorization_id,account_id::text,node_brain_id::text,source,
              external_source_id,connected_event_id::text
       from chat_sources where id=$1 for update`, [chatSourceId],
    );
    if (sourceRows.length === 0) {
      const header: AuthorityHeader = {
        kind: "SOURCE_CONNECTED", chatSourceId, accountId: authorization.account_id,
        nodeBrainId: authorization.node_brain_id, source: manifest.source,
        authorizationId: authorization.id, externalSourceId: manifest.sourceId,
        identityDigest: sourceIdentityDigest, formatVersion: manifest.formatVersion,
      };
      const connectedEventId = await appendAuthorityEvent(transaction, header, {
        accountId: authorization.account_id, authorizationId: authorization.id,
        chatSourceId, externalSourceId: manifest.sourceId, formatVersion: manifest.formatVersion,
        identityDigest: sourceIdentityDigest, nodeBrainId: authorization.node_brain_id,
        source: manifest.source,
      }, now);
      await transaction.query(
        `insert into chat_sources (
           id,authorization_id,account_id,node_brain_id,source,external_source_id,
           identity_digest,connected_event_id,connected_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [chatSourceId, authorization.id, authorization.account_id, authorization.node_brain_id,
          manifest.source, manifest.sourceId, sourceIdentityDigest, connectedEventId, now],
      );
      sourceRows = await transaction.query<SourceRow>(
        `select id::text,authorization_id,account_id::text,node_brain_id::text,source,
                external_source_id,connected_event_id::text from chat_sources where id=$1`,
        [chatSourceId],
      );
    }
    const source = sourceRows[0];
    if (!sameSource(source, authorization)) throw new Error("SOURCE_NOT_AUTHORIZED");
    const cursorRows = await transaction.query<CursorRow>(
      `select last_import_id::text,manifest_digest,revision
       from chat_source_cursors where chat_source_id=$1 for update`, [chatSourceId],
    );
    const cursor = cursorRows[0];
    const existingImports = await transaction.query<{ id: string }>(
      "select id::text from chat_source_imports where chat_source_id=$1 and manifest_digest=$2",
      [chatSourceId, manifestDigest],
    );
    if (existingImports[0]) {
      return Object.freeze({
        chatSourceId, importId: existingImports[0].id, insertedMessages: 0,
        correctedMessages: 0, quarantinedMessages: 0,
        messageVersionIds: Object.freeze([]), cursorRevision: Number(cursor?.revision ?? 0),
      });
    }
    const cursorConflicts = await transaction.query<{ manifest_digest: string }>(
      `select manifest_digest from chat_source_imports
       where chat_source_id=$1 and external_cursor_digest=$2`,
      [chatSourceId, externalCursorDigest],
    );
    if (cursorConflicts[0]) throw new Error("CHAT_CURSOR_CONTENT_CONFLICT");
    const cursorRevision = Number(cursor?.revision ?? 0) + 1;
    const importId = uuidFromDigest(canonicalContentDigest({ chatSourceId, manifestDigest }));
    const occurrenceManifest = occurrenceManifestFor(chatSourceId, parsed);
    const cursorHeader: AuthorityHeader = {
      kind: "CURSOR_ADVANCED", chatSourceId, accountId: authorization.account_id,
      nodeBrainId: authorization.node_brain_id, source: manifest.source,
      authorizationId: authorization.id, importId, sourceRevision: cursorRevision,
      externalSourceId: manifest.sourceId, formatVersion: manifest.formatVersion,
      exportedAt: manifest.exportedAt, externalCursorDigest, manifestDigest,
      conversationCount: manifest.conversationCount, itemCount: manifest.messageCount,
      quarantinedCount: parsed.quarantined.length,
      occurrenceManifestDigest: occurrenceManifest.digest,
    };
    const cursorEventId = await appendAuthorityEvent(transaction, cursorHeader, {
      accountId: authorization.account_id, authorizationId: authorization.id,
      chatSourceId, conversationCount: manifest.conversationCount,
      externalCursor: manifest.cursor, externalCursorDigest, externalSourceId: manifest.sourceId,
      exportedAt: manifest.exportedAt, formatVersion: manifest.formatVersion,
      importId, itemCount: manifest.messageCount, manifestDigest,
      nodeBrainId: authorization.node_brain_id, quarantinedCount: parsed.quarantined.length,
      occurrenceManifest: occurrenceManifest.entries as unknown as JsonValue,
      occurrenceManifestDigest: occurrenceManifest.digest,
      source: manifest.source, sourceRevision: cursorRevision,
    }, now);
    await transaction.query(
      `insert into chat_source_imports (
         id,chat_source_id,authorization_id,account_id,node_brain_id,source_revision,
         format_version,exported_at,external_cursor_digest,manifest_digest,
         conversation_count,item_count,quarantined_count,occurrence_manifest,
         occurrence_manifest_digest,cursor_event_id,created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [importId, chatSourceId, authorization.id, authorization.account_id,
        authorization.node_brain_id, cursorRevision, manifest.formatVersion,
        new Date(manifest.exportedAt), externalCursorDigest, manifestDigest,
        manifest.conversationCount, manifest.messageCount, parsed.quarantined.length,
        occurrenceManifest.text, occurrenceManifest.digest, cursorEventId, now],
    );

    const prepared: {
      conversation: ParsedConversation; importedConversationId: string; identityDigest: string;
    }[] = parsed.conversations.map((conversation) => {
      const identityDigest = canonicalContentDigest({
        chatSourceId, externalConversationId: conversation.externalConversationId,
      });
      const importedConversationId = uuidFromDigest(identityDigest);
      return { conversation, importedConversationId, identityDigest };
    });
    await insertChatRows(transaction, "imported_chat_conversations", prepared.map((item) => ({
      id: item.importedConversationId, chat_source_id: chatSourceId,
      account_id: authorization.account_id, node_brain_id: authorization.node_brain_id,
      external_conversation_id: item.conversation.externalConversationId,
      identity_digest: item.identityDigest, created_at: now.toISOString(),
    })), true);
    const conversationLatestRows = prepared.length === 0 ? []
      : await transaction.query<ConversationVersionRow>(
        `with requested as (
           select imported_conversation_id from jsonb_to_recordset($1::jsonb)
             as item(imported_conversation_id uuid)
         ) select distinct on (v.imported_conversation_id)
           v.id::text,v.imported_conversation_id::text,v.version,v.participants_digest
         from imported_chat_conversation_versions v join requested r using (imported_conversation_id)
         order by v.imported_conversation_id,v.version desc`,
        [JSON.stringify(prepared.map(({ importedConversationId }) => ({
          imported_conversation_id: importedConversationId,
        })))],
      );
    const conversationLatest = new Map(conversationLatestRows.map((row) => [row.imported_conversation_id, row]));
    const newConversationVersions: Array<{
      readonly event: AuthorityEventSpec;
      readonly row: Readonly<Record<string, unknown>>;
    }> = [];
    const conversationOccurrences: Readonly<Record<string, unknown>>[] = [];
    for (const { conversation, importedConversationId, identityDigest } of prepared) {
      let versionRow = conversationLatest.get(importedConversationId);
      if (!versionRow || versionRow.participants_digest !== conversation.participantsDigest) {
        const version = (versionRow?.version ?? 0) + 1;
        const versionIdentityDigest = canonicalContentDigest({
          importedConversationId, participantsDigest: conversation.participantsDigest,
          predecessorVersionId: versionRow?.id ?? null, version,
        });
        const conversationVersionId = uuidFromDigest(versionIdentityDigest);
        const header: AuthorityHeader = {
          kind: "CONVERSATION_VERSION", chatSourceId, accountId: authorization.account_id,
          nodeBrainId: authorization.node_brain_id, importId, sourceRevision: cursorRevision,
          importedConversationId, conversationVersionId,
          externalConversationId: conversation.externalConversationId,
          identityDigest,
          participantCount: conversation.participants.length,
          participantsDigest: conversation.participantsDigest,
          messageVersion: version, versionIdentityDigest,
          predecessorId: versionRow?.id ?? null,
        };
        newConversationVersions.push({
          event: {
            header,
            body: {
              accountId: authorization.account_id, chatSourceId,
              conversationVersionId, externalConversationId: conversation.externalConversationId,
              identityDigest,
              importId, importedConversationId, nodeBrainId: authorization.node_brain_id,
              participantCount: conversation.participants.length,
              participants: conversation.participants as unknown as JsonValue,
              participantsDigest: conversation.participantsDigest,
              predecessorVersionId: versionRow?.id ?? null,
              sourceRevision: cursorRevision, version, versionIdentityDigest,
            },
            occurredAt: now,
          },
          row: {
            id: conversationVersionId, imported_conversation_id: importedConversationId,
            chat_source_id: chatSourceId, account_id: authorization.account_id,
            node_brain_id: authorization.node_brain_id, version,
            version_identity_digest: versionIdentityDigest,
            participant_count: conversation.participants.length,
            participants_digest: conversation.participantsDigest,
            import_id: importId, predecessor_version_id: versionRow?.id ?? null,
            created_at: now.toISOString(),
          },
        });
        versionRow = { id: conversationVersionId, imported_conversation_id: importedConversationId,
          version, participants_digest: conversation.participantsDigest };
      }
      conversationOccurrences.push({
        import_id: importId, chat_source_id: chatSourceId, ordinal: conversation.ordinal,
        imported_conversation_id: importedConversationId, conversation_version_id: versionRow.id,
        created_at: now.toISOString(),
      });
    }
    const conversationEventIds = await appendAuthorityEvents(
      transaction, newConversationVersions.map(({ event }) => event),
    );
    await insertChatRows(transaction, "imported_chat_conversation_versions",
      newConversationVersions.map(({ row }, index) => ({
        ...row, imported_event_id: conversationEventIds[index],
      })));
    await insertChatRows(transaction, "chat_import_conversation_occurrences", conversationOccurrences);

    const preparedMessages = prepared.flatMap(({ conversation, importedConversationId }) => (
      conversation.messages.map((message) => ({ importedConversationId, message }))
    ));
    const latestRows = preparedMessages.length === 0 ? []
      : await transaction.query<MessageVersionRow>(
        `with requested as (
           select imported_conversation_id,external_message_id from jsonb_to_recordset($1::jsonb)
             as item(imported_conversation_id uuid,external_message_id text)
         ) select distinct on (v.imported_conversation_id,v.external_message_id)
           v.id::text,v.imported_conversation_id::text,v.external_message_id,v.version,v.content_digest
         from imported_chat_message_versions v join requested r
           on r.imported_conversation_id=v.imported_conversation_id
          and r.external_message_id=v.external_message_id
         order by v.imported_conversation_id,v.external_message_id,v.version desc`,
        [JSON.stringify(preparedMessages.map(({ importedConversationId, message }) => ({
          imported_conversation_id: importedConversationId,
          external_message_id: message.externalMessageId,
        })))],
      );
    const latestByMessage = new Map(latestRows.map((row) => [
      `${row.imported_conversation_id}\0${row.external_message_id}`, row,
    ]));
    const messageVersionIds: string[] = [];
    const newMessageVersions: Array<{
      readonly event: AuthorityEventSpec;
      readonly row: Readonly<Record<string, unknown>>;
    }> = [];
    const itemOccurrences: Readonly<Record<string, unknown>>[] = [];
    let correctedMessages = 0;
    for (const { importedConversationId, message } of preparedMessages) {
      const latest = latestByMessage.get(`${importedConversationId}\0${message.externalMessageId}`);
      let messageVersionId = latest?.id;
      if (!latest || latest.content_digest !== message.contentDigest) {
        const messageIdentityDigest = canonicalContentDigest({
          chatSourceId, externalConversationId: message.externalConversationId,
          externalMessageId: message.externalMessageId,
        });
        const version = (latest?.version ?? 0) + 1;
        const versionIdentityDigest = canonicalContentDigest({
          contentDigest: message.contentDigest, messageIdentityDigest,
          predecessorMessageVersionId: latest?.id ?? null, version,
        });
        messageVersionId = uuidFromDigest(versionIdentityDigest);
        const header: AuthorityHeader = {
          kind: "MESSAGE_VERSION", chatSourceId, accountId: authorization.account_id,
          nodeBrainId: authorization.node_brain_id, importId, sourceRevision: cursorRevision,
          importedConversationId, externalConversationId: message.externalConversationId,
          externalMessageId: message.externalMessageId,
          participantIdentityDigest: message.participantIdentityDigest,
          messageVersionId, messageVersion: version, messageIdentityDigest,
          versionIdentityDigest, contentDigest: message.contentDigest, role: message.role,
          sourceAt: message.at, predecessorId: latest?.id ?? null,
          recordDigest: message.recordDigest,
        };
        newMessageVersions.push({
          event: {
            header,
            body: {
              accountId: authorization.account_id, chatSourceId,
              contentDigest: message.contentDigest,
              externalConversationId: message.externalConversationId,
              externalMessageId: message.externalMessageId, importId,
              importedConversationId, messageIdentityDigest, messageVersionId,
              nodeBrainId: authorization.node_brain_id,
              participantId: message.participantId,
              participantIdentityDigest: message.participantIdentityDigest,
              predecessorMessageVersionId: latest?.id ?? null,
              role: message.role, sourceAt: message.at, sourceRevision: cursorRevision,
              sourceRecordDigest: message.recordDigest, text: message.text, version, versionIdentityDigest,
            },
            occurredAt: new Date(message.at),
          },
          row: {
            id: messageVersionId, imported_conversation_id: importedConversationId,
            chat_source_id: chatSourceId, account_id: authorization.account_id,
            node_brain_id: authorization.node_brain_id,
            external_message_id: message.externalMessageId,
            participant_identity_digest: message.participantIdentityDigest,
            message_identity_digest: messageIdentityDigest, version,
            version_identity_digest: versionIdentityDigest, content_digest: message.contentDigest,
            source_record_digest: message.recordDigest, role: message.role, source_at: message.at,
            import_id: importId, supersedes_message_version_id: latest?.id ?? null,
            created_at: now.toISOString(),
          },
        });
        messageVersionIds.push(messageVersionId);
        if (latest) correctedMessages += 1;
      }
      itemOccurrences.push({
        import_id: importId, chat_source_id: chatSourceId, ordinal: message.itemOrdinal,
        kind: "MESSAGE_VERSION", message_version_id: messageVersionId,
        quarantine_payload_id: null, record_digest: message.recordDigest,
        created_at: now.toISOString(),
      });
    }
    const messageEventIds = await appendAuthorityEvents(
      transaction, newMessageVersions.map(({ event }) => event),
    );
    await insertChatRows(transaction, "imported_chat_message_versions",
      newMessageVersions.map(({ row }, index) => ({ ...row, event_id: messageEventIds[index] })));

    const quarantineDigests = [...new Set(parsed.quarantined.map((item) => item.recordDigest))];
    const quarantineRows = quarantineDigests.length === 0 ? []
      : await transaction.query<QuarantineRow>(
        `select id::text,record_digest,reason from chat_import_quarantine
         where chat_source_id=$1 and record_digest=any($2::char(64)[])`,
        [chatSourceId, quarantineDigests],
      );
    const quarantinesByKey = new Map(quarantineRows.map((row) => [
      `${row.record_digest}:${row.reason}`, row.id,
    ]));
    const newQuarantinePayloads: Array<{
      readonly event: AuthorityEventSpec;
      readonly row: Readonly<Record<string, unknown>>;
    }> = [];
    const quarantineOccurrences: Readonly<Record<string, unknown>>[] = [];
    for (const item of parsed.quarantined) {
      const quarantineKey = `${item.recordDigest}:${item.reason}`;
      let payloadId = quarantinesByKey.get(quarantineKey);
      if (!payloadId) {
        payloadId = quarantinePayloadId(chatSourceId, item);
        const header: AuthorityHeader = {
          kind: "QUARANTINE_PAYLOAD", chatSourceId, accountId: authorization.account_id,
          nodeBrainId: authorization.node_brain_id, importId, sourceRevision: cursorRevision,
          externalConversationId: item.externalConversationId,
          externalMessageId: item.externalMessageId, quarantinePayloadId: payloadId,
          itemOrdinal: item.itemOrdinal, recordDigest: item.recordDigest, reason: item.reason,
          itemScope: item.itemScope, conversationOrdinal: item.conversationOrdinal,
        };
        newQuarantinePayloads.push({
          event: {
            header,
            body: {
              accountId: authorization.account_id, chatSourceId,
              externalConversationId: item.externalConversationId,
              externalMessageId: item.externalMessageId, firstImportId: importId,
              firstItemOrdinal: item.itemOrdinal, nodeBrainId: authorization.node_brain_id,
              quarantinePayloadId: payloadId, rawItem: item.raw,
              reason: item.reason, recordDigest: item.recordDigest,
              sourceRevision: cursorRevision, itemScope: item.itemScope,
              conversationOrdinal: item.conversationOrdinal,
            },
            occurredAt: now,
          },
          row: {
            id: payloadId, chat_source_id: chatSourceId, account_id: authorization.account_id,
            node_brain_id: authorization.node_brain_id, first_import_id: importId,
            item_scope: item.itemScope, conversation_ordinal: item.conversationOrdinal,
            external_conversation_id: item.externalConversationId,
            external_message_id: item.externalMessageId, first_item_ordinal: item.itemOrdinal,
            record_digest: item.recordDigest, reason: item.reason, created_at: now.toISOString(),
          },
        });
        quarantinesByKey.set(quarantineKey, payloadId);
      }
      itemOccurrences.push({
        import_id: importId, chat_source_id: chatSourceId, ordinal: item.itemOrdinal,
        kind: "QUARANTINE", message_version_id: null, quarantine_payload_id: payloadId,
        record_digest: item.recordDigest, created_at: now.toISOString(),
      });
      quarantineOccurrences.push({
        import_id: importId, chat_source_id: chatSourceId, item_ordinal: item.itemOrdinal,
        quarantine_payload_id: payloadId, item_scope: item.itemScope,
        conversation_ordinal: item.conversationOrdinal, created_at: now.toISOString(),
      });
    }
    const quarantineEventIds = await appendAuthorityEvents(
      transaction, newQuarantinePayloads.map(({ event }) => event),
    );
    await insertChatRows(transaction, "chat_import_quarantine",
      newQuarantinePayloads.map(({ row }, index) => ({
        ...row, event_id: quarantineEventIds[index],
      })));
    await insertChatRows(transaction, "chat_import_item_occurrences", itemOccurrences);
    await insertChatRows(transaction, "chat_import_quarantine_occurrences", quarantineOccurrences);

    const cursorParameters = [chatSourceId, authorization.account_id,
      authorization.node_brain_id, importId, cursorEventId, externalCursorDigest,
      manifestDigest, cursorRevision, now] as const;
    if (cursor) {
      await transaction.query(
        `update chat_source_cursors set last_import_id=$4,cursor_event_id=$5,
           external_cursor_digest=$6,manifest_digest=$7,revision=$8,advanced_at=$9
         where chat_source_id=$1 and account_id=$2 and node_brain_id=$3`,
        cursorParameters,
      );
    } else {
      await transaction.query(
        `insert into chat_source_cursors (
           chat_source_id,account_id,node_brain_id,last_import_id,cursor_event_id,
           external_cursor_digest,manifest_digest,revision,advanced_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        cursorParameters,
      );
    }
    return Object.freeze({
      chatSourceId, importId, insertedMessages: messageVersionIds.length,
      correctedMessages, quarantinedMessages: parsed.quarantined.length,
      messageVersionIds: Object.freeze(messageVersionIds), cursorRevision,
    });
  });
}

export async function importChatManifest(
  context: ChatImportContext,
  input: unknown,
): Promise<ChatImportResult> {
  return importCaptured({
    db: context.db,
    requesterAccountId: requireRequesterAccount(context.requesterAccountId),
  }, input);
}

export function createTrustedChatImportWorkerContext(
  db: EventDatabase,
): TrustedChatImportWorkerContext {
  return Object.freeze({ db, [WORKER_BRAND]: true as const });
}

export async function importChatManifestAsWorker(
  context: TrustedChatImportWorkerContext,
  input: unknown,
): Promise<ChatImportResult> {
  if (context[WORKER_BRAND] !== true) throw new Error("CHAT_IMPORT_WORKER_CAPABILITY_REQUIRED");
  return importCaptured({ db: context.db, requesterAccountId: null }, input);
}

function replayRecord(value: JsonValue): Record<string, JsonValue> {
  const record = objectRecord(value);
  if (!record) throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  return record as Record<string, JsonValue>;
}

interface ReplayManifestRow extends Record<string, unknown> {
  event_id: string;
  kind: AuthorityHeader["kind"];
  chat_source_id: string;
  account_id: string;
  node_brain_id: string;
  source: string | null;
  authorization_id: string | null;
  import_id: string | null;
  source_revision: string | null;
  imported_conversation_id: string | null;
  conversation_version_id: string | null;
  external_source_id: string | null;
  identity_digest: string | null;
  external_conversation_id: string | null;
  external_message_id: string | null;
  participant_identity_digest: string | null;
  participant_count: number | null;
  participants_digest: string | null;
  message_version_id: string | null;
  message_version: number | null;
  message_identity_digest: string | null;
  version_identity_digest: string | null;
  content_digest: string | null;
  role: string | null;
  source_at: Date | null;
  predecessor_id: string | null;
  quarantine_payload_id: string | null;
  item_ordinal: number | null;
  record_digest: string | null;
  reason: string | null;
  format_version: string | null;
  exported_at: Date | null;
  external_cursor_digest: string | null;
  manifest_digest: string | null;
  conversation_count: number | null;
  item_count: number | null;
  quarantined_count: number | null;
  authority_key: string;
  occurrence_manifest_digest: string | null;
  item_scope: string | null;
  conversation_ordinal: number | null;
  event_request_hash: string;
  event_integrity_hash: string;
  created_at: Date;
  ingested_sequence: string;
  high_water: string;
  event_aggregate_id: string;
  event_account_id: string | null;
  event_actor_type: string;
  event_actor_id: string;
  event_type: string;
  event_visibility: string;
  event_policy_version: string | null;
  event_idempotency_key: string;
  canonical_request_hash: string;
  canonical_integrity_hash: string;
  event_occurred_at: Date;
}

function replayString(record: Record<string, JsonValue>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  return value;
}

function replayNumber(record: Record<string, JsonValue>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  return value as number;
}

function replayNullableString(record: Record<string, JsonValue>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  return value;
}

function replayAuthorityHeader(
  kind: AuthorityHeader["kind"],
  body: Record<string, JsonValue>,
): AuthorityHeader {
  const common = {
    kind,
    chatSourceId: replayString(body, "chatSourceId"),
    accountId: replayString(body, "accountId"),
    nodeBrainId: replayString(body, "nodeBrainId"),
  } as const;
  switch (kind) {
    case "SOURCE_CONNECTED": return Object.freeze({
      ...common, source: replayString(body, "source"),
      authorizationId: replayString(body, "authorizationId"),
      externalSourceId: replayString(body, "externalSourceId"),
      identityDigest: replayString(body, "identityDigest"),
      formatVersion: replayString(body, "formatVersion"),
    });
    case "CURSOR_ADVANCED": return Object.freeze({
      ...common, source: replayString(body, "source"),
      authorizationId: replayString(body, "authorizationId"),
      importId: replayString(body, "importId"), sourceRevision: replayNumber(body, "sourceRevision"),
      externalSourceId: replayString(body, "externalSourceId"),
      formatVersion: replayString(body, "formatVersion"),
      exportedAt: exactTime(body.exportedAt, "CHAT_REPLAY_INTEGRITY_FAILURE"),
      externalCursorDigest: replayString(body, "externalCursorDigest"),
      manifestDigest: replayString(body, "manifestDigest"),
      conversationCount: replayNumber(body, "conversationCount"),
      itemCount: replayNumber(body, "itemCount"),
      quarantinedCount: replayNumber(body, "quarantinedCount"),
      occurrenceManifestDigest: replayString(body, "occurrenceManifestDigest"),
    });
    case "CONVERSATION_VERSION": return Object.freeze({
      ...common, importId: replayString(body, "importId"),
      sourceRevision: replayNumber(body, "sourceRevision"),
      importedConversationId: replayString(body, "importedConversationId"),
      conversationVersionId: replayString(body, "conversationVersionId"),
      externalConversationId: replayString(body, "externalConversationId"),
      identityDigest: replayString(body, "identityDigest"),
      participantCount: replayNumber(body, "participantCount"),
      participantsDigest: replayString(body, "participantsDigest"),
      messageVersion: replayNumber(body, "version"),
      versionIdentityDigest: replayString(body, "versionIdentityDigest"),
      predecessorId: replayNullableString(body, "predecessorVersionId"),
    });
    case "MESSAGE_VERSION": return Object.freeze({
      ...common, importId: replayString(body, "importId"),
      sourceRevision: replayNumber(body, "sourceRevision"),
      importedConversationId: replayString(body, "importedConversationId"),
      externalConversationId: replayString(body, "externalConversationId"),
      externalMessageId: replayString(body, "externalMessageId"),
      participantIdentityDigest: replayString(body, "participantIdentityDigest"),
      messageVersionId: replayString(body, "messageVersionId"),
      messageVersion: replayNumber(body, "version"),
      messageIdentityDigest: replayString(body, "messageIdentityDigest"),
      versionIdentityDigest: replayString(body, "versionIdentityDigest"),
      contentDigest: replayString(body, "contentDigest"), role: replayString(body, "role"),
      sourceAt: exactTime(body.sourceAt, "CHAT_REPLAY_INTEGRITY_FAILURE"),
      predecessorId: replayNullableString(body, "predecessorMessageVersionId"),
      recordDigest: replayString(body, "sourceRecordDigest"),
    });
    case "QUARANTINE_PAYLOAD": return Object.freeze({
      ...common, importId: replayString(body, "firstImportId"),
      sourceRevision: replayNumber(body, "sourceRevision"),
      externalConversationId: replayNullableString(body, "externalConversationId"),
      externalMessageId: replayNullableString(body, "externalMessageId"),
      quarantinePayloadId: replayString(body, "quarantinePayloadId"),
      itemOrdinal: replayNumber(body, "firstItemOrdinal"),
      recordDigest: replayString(body, "recordDigest"), reason: replayString(body, "reason"),
      itemScope: replayString(body, "itemScope"),
      conversationOrdinal: replayNumber(body, "conversationOrdinal"),
    });
  }
}

function manifestAuthorityFields(row: ReplayManifestRow): readonly (string | null)[] {
  const value = (item: string | number | Date | null): string | null => (
    item === null ? null : item instanceof Date ? item.toISOString() : String(item)
  );
  return [
    row.kind, row.chat_source_id, row.account_id, row.node_brain_id,
    value(row.source), value(row.authorization_id), value(row.import_id), value(row.source_revision),
    value(row.imported_conversation_id), value(row.conversation_version_id),
    value(row.external_source_id), value(row.identity_digest), value(row.external_conversation_id),
    value(row.external_message_id), value(row.participant_identity_digest),
    value(row.participant_count), value(row.participants_digest), value(row.message_version_id),
    value(row.message_version), value(row.message_identity_digest), value(row.version_identity_digest),
    value(row.content_digest), value(row.role), value(row.source_at), value(row.predecessor_id),
    value(row.quarantine_payload_id), value(row.item_ordinal), value(row.record_digest), value(row.reason),
    value(row.format_version), value(row.exported_at), value(row.external_cursor_digest),
    value(row.manifest_digest), value(row.conversation_count), value(row.item_count),
    value(row.quarantined_count), value(row.occurrence_manifest_digest),
    value(row.item_scope), value(row.conversation_ordinal),
  ];
}

function validateReplayManifestAuthority(
  manifest: ReplayManifestRow,
  body: Record<string, JsonValue>,
): void {
  const header = replayAuthorityHeader(manifest.kind, body);
  const expectedKey = authorityKey(header);
  const expectedAggregate = header.kind === "CONVERSATION_VERSION" || header.kind === "MESSAGE_VERSION"
    ? header.importedConversationId! : header.chatSourceId;
  if (body.authorityKey !== expectedKey || manifest.authority_key !== expectedKey
      || canonicalJson(authorityFields(header)) !== canonicalJson(manifestAuthorityFields(manifest))
      || manifest.event_aggregate_id !== expectedAggregate
      || manifest.event_account_id !== header.accountId
      || manifest.event_actor_type !== "SYSTEM" || manifest.event_actor_id !== "external-chat-importer"
      || manifest.event_type !== eventType(header.kind)
      || manifest.event_visibility !== "PRIVATE_ACCOUNT"
      || manifest.event_policy_version !== "external-chat-import-v1"
      || manifest.event_idempotency_key !== expectedKey
      || manifest.event_request_hash !== manifest.canonical_request_hash
      || manifest.event_integrity_hash !== manifest.canonical_integrity_hash
      || manifest.event_occurred_at.getTime() !== manifest.created_at.getTime()) {
    throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  }
}

function replayOccurrenceEntries(value: JsonValue): readonly (
  ReplayedConversationOccurrence | ReplayedItemOccurrence
)[] {
  if (!Array.isArray(value) || value.length > 10_100) {
    throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  }
  const entries = value.map((raw) => {
    const entry = replayRecord(raw);
    const kind = replayString(entry, "kind");
    const ordinal = replayNumber(entry, "ordinal");
    if (kind === "CONVERSATION") {
      return Object.freeze({
        kind, ordinal,
        importedConversationId: replayString(entry, "importedConversationId"),
        externalConversationId: replayString(entry, "externalConversationId"),
        participantCount: replayNumber(entry, "participantCount"),
        participantsDigest: replayString(entry, "participantsDigest"),
      }) satisfies ReplayedConversationOccurrence;
    }
    if (kind === "MESSAGE_VERSION") {
      return Object.freeze({
        kind, ordinal,
        importedConversationId: replayString(entry, "importedConversationId"),
        externalMessageId: replayString(entry, "externalMessageId"),
        messageIdentityDigest: replayString(entry, "messageIdentityDigest"),
        contentDigest: replayString(entry, "contentDigest"),
        recordDigest: replayString(entry, "recordDigest"),
      }) satisfies ReplayedItemOccurrence;
    }
    if (kind === "QUARANTINE") {
      const itemScope = replayString(entry, "itemScope");
      if (itemScope !== "CONVERSATION" && itemScope !== "MESSAGE") {
        throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
      }
      return Object.freeze({
        kind, ordinal, itemScope,
        conversationOrdinal: replayNumber(entry, "conversationOrdinal"),
        quarantinePayloadId: replayString(entry, "quarantinePayloadId"),
        externalConversationId: replayNullableString(entry, "externalConversationId"),
        externalMessageId: replayNullableString(entry, "externalMessageId"),
        recordDigest: replayString(entry, "recordDigest"),
        reason: replayString(entry, "reason"),
      }) satisfies ReplayedItemOccurrence;
    }
    throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  });
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0 && entries[index - 1].ordinal >= entries[index].ordinal) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
  }
  return Object.freeze(entries);
}

export async function replayChatSourceState(
  context: ChatImportContext,
  chatSourceId: string,
): Promise<ReplayedChatSourceState> {
  const accountId = requireRequesterAccount(context.requesterAccountId);
  stableIdentifier(chatSourceId, "INVALID_CHAT_SOURCE_ID");
  const manifests: ReplayManifestRow[] = [];
  const bodies = new Map<string, JsonValue>();
  let replayCursor: string | null = null;
  let replayHighWater: string | null = null;
  while (true) {
    const page: ReplayManifestRow[] = await context.db.query<ReplayManifestRow>(
      `select m.*,e.ingested_sequence::text as ingested_sequence,
              max(e.ingested_sequence) over ()::text as high_water,
              e.aggregate_id as event_aggregate_id,e.account_id as event_account_id,
              e.actor_type as event_actor_type,e.actor_id as event_actor_id,e.type as event_type,
              e.visibility as event_visibility,e.policy_version as event_policy_version,
              e.idempotency_key as event_idempotency_key,e.request_hash as canonical_request_hash,
              e.integrity_hash as canonical_integrity_hash,e.occurred_at as event_occurred_at
         from chat_source_event_manifests m join events e on e.id=m.event_id
        where m.chat_source_id=$1 and m.account_id=$2
          and ($3::bigint is null or e.ingested_sequence>$3::bigint)
          and ($4::bigint is null or e.ingested_sequence<=$4::bigint)
        order by e.ingested_sequence limit 100`,
      [chatSourceId, accountId, replayCursor, replayHighWater],
    );
    if (page.length === 0) break;
    const ids = page.map(({ event_id }) => event_id);
    for (const result of await readEventBodies(context.db, ids, {
      actor: { role: "ACCOUNT", accountId },
    })) bodies.set(result.eventId, result.body);
    manifests.push(...page);
    const last: ReplayManifestRow = page.at(-1)!;
    replayHighWater ??= page[0].high_water;
    replayCursor = last.ingested_sequence;
    if (page.length < 100) break;
  }
  if (manifests.length === 0) throw new Error("SOURCE_NOT_AUTHORIZED");
  const sourceManifest = manifests.find(({ kind }) => kind === "SOURCE_CONNECTED");
  if (!sourceManifest) throw new Error("SOURCE_NOT_AUTHORIZED");
  for (const manifest of manifests) {
    validateReplayManifestAuthority(manifest, replayRecord(bodies.get(manifest.event_id)!));
  }
  const sourceBody = replayRecord(bodies.get(sourceManifest.event_id)!);
  if (sourceBody.authorityKey !== sourceManifest.authority_key) {
    throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  }
  const imports = manifests.filter(({ kind }) => kind === "CURSOR_ADVANCED")
    .map((manifest) => {
      const body = replayRecord(bodies.get(manifest.event_id)!);
      if (body.authorityKey !== manifest.authority_key
          || typeof body.importId !== "string" || typeof body.sourceRevision !== "number"
          || typeof body.externalCursor !== "string" || typeof body.externalCursorDigest !== "string"
          || typeof body.manifestDigest !== "string" || typeof body.formatVersion !== "string"
          || typeof body.exportedAt !== "string" || typeof body.conversationCount !== "number"
          || typeof body.itemCount !== "number" || typeof body.quarantinedCount !== "number"
          || typeof body.occurrenceManifestDigest !== "string") {
        throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
      }
      const occurrences = replayOccurrenceEntries(body.occurrenceManifest);
      if (canonicalContentDigest(occurrences) !== body.occurrenceManifestDigest
          || manifest.occurrence_manifest_digest !== body.occurrenceManifestDigest
          || canonicalContentDigest({ cursor: body.externalCursor }) !== body.externalCursorDigest) {
        throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
      }
      const conversationOccurrences = occurrences.filter(
        (entry): entry is ReplayedConversationOccurrence => entry.kind === "CONVERSATION",
      );
      const itemOccurrences = occurrences.filter(
        (entry): entry is ReplayedItemOccurrence => entry.kind !== "CONVERSATION",
      );
      const conversationSlots = [
        ...conversationOccurrences.map(({ ordinal }) => ordinal),
        ...itemOccurrences.flatMap((entry) => entry.kind === "QUARANTINE"
          && entry.itemScope === "CONVERSATION" ? [entry.conversationOrdinal] : []),
      ].sort((left, right) => left - right);
      const itemSlots = itemOccurrences.map(({ ordinal }) => ordinal).sort((left, right) => left - right);
      if (conversationSlots.length !== body.conversationCount
          || conversationSlots.some((ordinal, index) => ordinal !== index)
          || itemSlots.length !== body.itemCount
          || itemSlots.some((ordinal, index) => ordinal !== index + 100)
          || itemOccurrences.filter(({ kind }) => kind === "QUARANTINE").length
            !== body.quarantinedCount) {
        throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
      }
      return Object.freeze({ importId: body.importId, revision: body.sourceRevision,
        externalCursor: body.externalCursor, externalCursorDigest: body.externalCursorDigest,
        manifestDigest: body.manifestDigest,
        formatVersion: body.formatVersion as ChatFormatVersion, exportedAt: body.exportedAt,
        conversationCount: body.conversationCount, itemCount: body.itemCount,
        quarantinedCount: body.quarantinedCount, cursorEventId: manifest.event_id,
        createdAt: manifest.created_at.toISOString(),
        conversationOccurrences: Object.freeze(conversationOccurrences),
        itemOccurrences: Object.freeze(itemOccurrences) });
    }).sort((left, right) => left.revision - right.revision);
  if (imports.some((entry, index) => entry.revision !== index + 1)) {
    throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  }
  const conversationVersions = new Map<string, Array<{
    importedConversationId: string; externalConversationId: string; identityDigest: string;
    conversationVersionId: string; version: number; versionIdentityDigest: string;
    participants: readonly ChatManifestParticipant[]; participantCount: number;
    participantsDigest: string; importedEventId: string; importId: string;
    predecessorVersionId: string | null; createdAt: string;
  }>>();
  for (const manifest of manifests.filter(({ kind }) => kind === "CONVERSATION_VERSION")) {
    const body = replayRecord(bodies.get(manifest.event_id)!);
    if (body.authorityKey !== manifest.authority_key
        || typeof body.importedConversationId !== "string"
        || typeof body.externalConversationId !== "string" || typeof body.version !== "number"
        || typeof body.identityDigest !== "string" || typeof body.conversationVersionId !== "string"
        || typeof body.versionIdentityDigest !== "string" || typeof body.participantCount !== "number"
        || typeof body.participantsDigest !== "string" || typeof body.importId !== "string"
        || (body.predecessorVersionId !== null && typeof body.predecessorVersionId !== "string")) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
    const participants = parseParticipants(body.participants);
    const expectedIdentity = canonicalContentDigest({
      chatSourceId, externalConversationId: body.externalConversationId,
    });
    const expectedVersionIdentity = canonicalContentDigest({
      importedConversationId: body.importedConversationId,
      participantsDigest: body.participantsDigest,
      predecessorVersionId: body.predecessorVersionId, version: body.version,
    });
    if (canonicalContentDigest({ participants }) !== body.participantsDigest
        || body.identityDigest !== expectedIdentity
        || body.importedConversationId !== uuidFromDigest(expectedIdentity)
        || body.versionIdentityDigest !== expectedVersionIdentity
        || body.conversationVersionId !== uuidFromDigest(expectedVersionIdentity)) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
    const version = {
      importedConversationId: body.importedConversationId,
      externalConversationId: body.externalConversationId,
      identityDigest: body.identityDigest, conversationVersionId: body.conversationVersionId,
      version: body.version, versionIdentityDigest: body.versionIdentityDigest,
      participants, participantCount: body.participantCount,
      participantsDigest: body.participantsDigest, importedEventId: manifest.event_id,
      importId: body.importId, predecessorVersionId: body.predecessorVersionId,
      createdAt: manifest.created_at.toISOString(),
    };
    const versions = conversationVersions.get(body.importedConversationId) ?? [];
    versions.push(version);
    conversationVersions.set(body.importedConversationId, versions);
  }
  const messageVersions: ReplayedMessageVersion[] = [];
  for (const manifest of manifests.filter(({ kind }) => kind === "MESSAGE_VERSION")) {
    const body = replayRecord(bodies.get(manifest.event_id)!);
    const role = replayString(body, "role");
    if (!CHAT_MESSAGE_ROLES.includes(role as ChatMessageRole)
        || body.authorityKey !== manifest.authority_key) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
    const externalConversationId = replayString(body, "externalConversationId");
    const externalMessageId = replayString(body, "externalMessageId");
    const participantId = replayString(body, "participantId");
    const sourceAt = exactTime(body.sourceAt, "CHAT_REPLAY_INTEGRITY_FAILURE");
    const textValue = replayString(body, "text");
    const importedConversationId = replayString(body, "importedConversationId");
    const messageIdentityDigest = replayString(body, "messageIdentityDigest");
    const contentDigest = replayString(body, "contentDigest");
    const versionIdentityDigest = replayString(body, "versionIdentityDigest");
    const predecessorMessageVersionId = replayNullableString(body, "predecessorMessageVersionId");
    const version = replayNumber(body, "version");
    const expectedMessageIdentity = canonicalContentDigest({
      chatSourceId, externalConversationId, externalMessageId,
    });
    const expectedContent = canonicalContentDigest({ at: sourceAt, participantId, role, text: textValue });
    const expectedVersionIdentity = canonicalContentDigest({
      contentDigest, messageIdentityDigest,
      predecessorMessageVersionId, version,
    });
    const participantIdentityDigest = replayString(body, "participantIdentityDigest");
    if (importedConversationId !== uuidFromDigest(canonicalContentDigest({ chatSourceId, externalConversationId }))
        || messageIdentityDigest !== expectedMessageIdentity || contentDigest !== expectedContent
        || participantIdentityDigest !== canonicalContentDigest({ externalConversationId, participantId })
        || versionIdentityDigest !== expectedVersionIdentity
        || replayString(body, "messageVersionId") !== uuidFromDigest(expectedVersionIdentity)) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
    messageVersions.push(Object.freeze({
      messageVersionId: replayString(body, "messageVersionId"), importedConversationId,
      externalConversationId, externalMessageId, participantId, participantIdentityDigest,
      messageIdentityDigest, version, versionIdentityDigest, contentDigest,
      sourceRecordDigest: replayString(body, "sourceRecordDigest"), role: role as ChatMessageRole,
      sourceAt, eventId: manifest.event_id, importId: replayString(body, "importId"),
      predecessorMessageVersionId,
    }));
  }
  const quarantinePayloads: ReplayedQuarantinePayload[] = [];
  for (const manifest of manifests.filter(({ kind }) => kind === "QUARANTINE_PAYLOAD")) {
    const body = replayRecord(bodies.get(manifest.event_id)!);
    const itemScope = replayString(body, "itemScope");
    if ((itemScope !== "CONVERSATION" && itemScope !== "MESSAGE")
        || body.authorityKey !== manifest.authority_key) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
    const externalConversationId = replayNullableString(body, "externalConversationId");
    const externalMessageId = replayNullableString(body, "externalMessageId");
    const recordDigest = replayString(body, "recordDigest");
    const reason = replayString(body, "reason");
    const expectedRecordDigest = canonicalContentDigest({
      externalConversationId, externalMessageId, itemScope, raw: body.rawItem,
    });
    const expectedPayloadId = uuidFromDigest(canonicalContentDigest({
      chatSourceId, itemScope, reason, recordDigest,
    }));
    if (recordDigest !== expectedRecordDigest
        || replayString(body, "quarantinePayloadId") !== expectedPayloadId) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
    quarantinePayloads.push(Object.freeze({
      quarantinePayloadId: expectedPayloadId, firstImportId: replayString(body, "firstImportId"),
      itemScope, conversationOrdinal: replayNumber(body, "conversationOrdinal"),
      externalConversationId, externalMessageId,
      firstItemOrdinal: replayNumber(body, "firstItemOrdinal"), recordDigest, reason,
      rawItem: body.rawItem, eventId: manifest.event_id,
    }));
  }
  for (const versions of conversationVersions.values()) {
    versions.sort((left, right) => left.version - right.version);
    if (versions.some((version, index) => version.version !== index + 1
        || version.predecessorVersionId !== (index === 0 ? null : versions[index - 1].conversationVersionId)
        || (index > 0 && version.participantsDigest === versions[index - 1].participantsDigest))) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
  }
  const messageChains = new Map<string, ReplayedMessageVersion[]>();
  for (const version of messageVersions) {
    const chain = messageChains.get(version.messageIdentityDigest) ?? [];
    chain.push(version);
    messageChains.set(version.messageIdentityDigest, chain);
  }
  for (const chain of messageChains.values()) {
    chain.sort((left, right) => left.version - right.version);
    if (chain.some((version, index) => version.version !== index + 1
        || version.predecessorMessageVersionId !== (index === 0 ? null : chain[index - 1].messageVersionId)
        || (index > 0 && version.contentDigest === chain[index - 1].contentDigest))) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
  }
  const conversations = [...conversationVersions.values()].map((versions) => {
    const latestVersion = versions.at(-1)!;
    return Object.freeze({ ...latestVersion, versions: Object.freeze(versions.map((version) => Object.freeze({
      conversationVersionId: version.conversationVersionId, version: version.version,
      versionIdentityDigest: version.versionIdentityDigest, participants: version.participants,
      participantCount: version.participantCount, participantsDigest: version.participantsDigest,
      importedEventId: version.importedEventId, importId: version.importId,
      predecessorVersionId: version.predecessorVersionId, createdAt: version.createdAt,
    }))) });
  });
  const latest = imports.at(-1);
  if (!latest || typeof sourceBody.accountId !== "string" || typeof sourceBody.nodeBrainId !== "string"
      || typeof sourceBody.source !== "string" || typeof sourceBody.externalSourceId !== "string"
      || typeof sourceBody.authorizationId !== "string" || typeof sourceBody.identityDigest !== "string"
      || typeof sourceBody.formatVersion !== "string") {
    throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  }
  if (!CHAT_SOURCE_KINDS.includes(sourceBody.source as ChatSourceKind)) {
    throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  }
  const replayFormat = sourceFormat(sourceBody.source as ChatSourceKind, sourceBody.formatVersion);
  const expectedSourceIdentity = canonicalContentDigest({
    accountId: sourceBody.accountId, externalSourceId: sourceBody.externalSourceId,
    source: sourceBody.source,
  });
  if (sourceBody.accountId !== accountId || sourceBody.chatSourceId !== chatSourceId
      || sourceBody.identityDigest !== expectedSourceIdentity
      || chatSourceId !== uuidFromDigest(expectedSourceIdentity)) {
    throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
  }
  const conversationVersionsByDigest = new Map<string, string>();
  for (const versions of conversationVersions.values()) {
    for (const version of versions) conversationVersionsByDigest.set(
      `${version.importedConversationId}\0${version.participantsDigest}`, version.conversationVersionId,
    );
  }
  const messageVersionByContent = new Set(messageVersions.map((version) => (
    `${version.importedConversationId}\0${version.externalMessageId}\0${version.contentDigest}`
  )));
  const quarantineById = new Map(quarantinePayloads.map((payload) => [payload.quarantinePayloadId, payload]));
  for (const imported of imports) {
    if (imported.conversationOccurrences.some((occurrence) => !conversationVersionsByDigest.has(
      `${occurrence.importedConversationId}\0${occurrence.participantsDigest}`,
    )) || imported.itemOccurrences.some((occurrence) => occurrence.kind === "MESSAGE_VERSION"
      ? !messageVersionByContent.has(
        `${occurrence.importedConversationId}\0${occurrence.externalMessageId}\0${occurrence.contentDigest}`,
      ) : (() => {
        const payload = quarantineById.get(occurrence.quarantinePayloadId);
        return !payload || payload.itemScope !== occurrence.itemScope
          || payload.conversationOrdinal !== occurrence.conversationOrdinal
          || payload.externalConversationId !== occurrence.externalConversationId
          || payload.externalMessageId !== occurrence.externalMessageId
          || payload.recordDigest !== occurrence.recordDigest || payload.reason !== occurrence.reason;
      })())) {
      throw new Error("CHAT_REPLAY_INTEGRITY_FAILURE");
    }
  }
  return Object.freeze({
    source: Object.freeze({ chatSourceId, accountId: sourceBody.accountId,
      nodeBrainId: sourceBody.nodeBrainId, source: sourceBody.source as ChatSourceKind,
      externalSourceId: sourceBody.externalSourceId,
      authorizationId: sourceBody.authorizationId, identityDigest: sourceBody.identityDigest,
      formatVersion: replayFormat, connectedEventId: sourceManifest.event_id,
      connectedAt: sourceManifest.created_at.toISOString() }),
    imports: Object.freeze(imports),
    conversations: Object.freeze(conversations.sort(
      (left, right) => compareCodeUnits(left.importedConversationId, right.importedConversationId),
    )),
    messageVersions: Object.freeze(messageVersions.sort((left, right) => (
      compareCodeUnits(left.messageIdentityDigest, right.messageIdentityDigest) || left.version - right.version
    ))),
    quarantinePayloads: Object.freeze(quarantinePayloads.sort(
      (left, right) => compareCodeUnits(left.quarantinePayloadId, right.quarantinePayloadId),
    )),
    cursor: Object.freeze({ importId: latest.importId, revision: latest.revision,
      externalCursor: latest.externalCursor, externalCursorDigest: latest.externalCursorDigest,
      manifestDigest: latest.manifestDigest, cursorEventId: latest.cursorEventId,
      advancedAt: latest.createdAt }),
  });
}
