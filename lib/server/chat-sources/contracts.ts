import type { EventDatabase, JsonValue } from "../events/types";

export const CHAT_SOURCE_KINDS = [
  "CHATGPT_EXPORT",
  "CLAUDE_EXPORT",
  "OTHER_EXPORT",
  "CONNECTOR",
] as const;

export const CHAT_MESSAGE_ROLES = ["USER", "ASSISTANT", "SYSTEM", "TOOL"] as const;

export const CHAT_SOURCE_FORMATS = Object.freeze({
  CHATGPT_EXPORT: Object.freeze(["chatgpt-export-v1"]),
  CLAUDE_EXPORT: Object.freeze(["claude-export-v1"]),
  OTHER_EXPORT: Object.freeze(["canonical-chat-v1"]),
  CONNECTOR: Object.freeze(["canonical-connector-v1"]),
} as const);

export type ChatSourceKind = typeof CHAT_SOURCE_KINDS[number];
export type ChatMessageRole = typeof CHAT_MESSAGE_ROLES[number];
export type ChatFormatVersion = typeof CHAT_SOURCE_FORMATS[ChatSourceKind][number];

export interface ChatManifestParticipant {
  readonly id: string;
  readonly role: ChatMessageRole;
}

export interface ChatManifestMessage {
  readonly id: string;
  readonly at: string;
  readonly role: ChatMessageRole;
  readonly participantId: string;
  readonly text: string;
  readonly contentDigest?: string;
}

export interface ChatManifestConversation {
  readonly id: string;
  readonly participants: readonly ChatManifestParticipant[];
  readonly messages: readonly ChatManifestMessage[];
}

export interface ChatManifest {
  readonly source: ChatSourceKind;
  readonly ownerAuthorizationId: string;
  readonly sourceId: string;
  readonly conversations: readonly ChatManifestConversation[];
  readonly formatVersion: ChatFormatVersion;
  readonly exportedAt: string;
  readonly cursor: string;
  readonly conversationCount: number;
  readonly messageCount: number;
}

export interface ChatImportContext {
  readonly db: EventDatabase;
  readonly requesterAccountId: string;
}

export interface ChatImportResult {
  readonly chatSourceId: string;
  readonly importId: string;
  readonly insertedMessages: number;
  readonly correctedMessages: number;
  readonly quarantinedMessages: number;
  readonly messageVersionIds: readonly string[];
  readonly cursorRevision: number;
}

export const CHAT_IMPORT_LIMITS = Object.freeze({
  maximumConversations: 100,
  maximumMessages: 10_000,
  maximumParticipantsPerConversation: 50,
  maximumTextBytes: 100_000,
  maximumTotalTextBytes: 2_000_000,
  maximumManifestBytes: 2_200_000,
  maximumIdentifierLength: 200,
  maximumCursorBytes: 1_000,
});

export interface ReplayedChatSourceState {
  readonly source: {
    readonly chatSourceId: string;
    readonly accountId: string;
    readonly nodeBrainId: string;
    readonly source: ChatSourceKind;
    readonly externalSourceId: string;
    readonly authorizationId: string;
    readonly identityDigest: string;
    readonly formatVersion: ChatFormatVersion;
    readonly connectedEventId: string;
    readonly connectedAt: string;
  };
  readonly imports: readonly {
    readonly importId: string;
    readonly revision: number;
    readonly externalCursor: string;
    readonly externalCursorDigest: string;
    readonly manifestDigest: string;
    readonly formatVersion: ChatFormatVersion;
    readonly exportedAt: string;
    readonly conversationCount: number;
    readonly itemCount: number;
    readonly quarantinedCount: number;
    readonly cursorEventId: string;
    readonly createdAt: string;
    readonly conversationOccurrences: readonly ReplayedConversationOccurrence[];
    readonly itemOccurrences: readonly ReplayedItemOccurrence[];
  }[];
  readonly conversations: readonly {
    readonly importedConversationId: string;
    readonly externalConversationId: string;
    readonly identityDigest: string;
    readonly conversationVersionId: string;
    readonly version: number;
    readonly versionIdentityDigest: string;
    readonly participants: readonly ChatManifestParticipant[];
    readonly participantCount: number;
    readonly participantsDigest: string;
    readonly importedEventId: string;
    readonly importId: string;
    readonly predecessorVersionId: string | null;
    readonly createdAt: string;
    readonly versions: readonly {
      readonly conversationVersionId: string;
      readonly version: number;
      readonly versionIdentityDigest: string;
      readonly participants: readonly ChatManifestParticipant[];
      readonly participantCount: number;
      readonly participantsDigest: string;
      readonly importedEventId: string;
      readonly importId: string;
      readonly predecessorVersionId: string | null;
      readonly createdAt: string;
    }[];
  }[];
  readonly messageVersions: readonly ReplayedMessageVersion[];
  readonly quarantinePayloads: readonly ReplayedQuarantinePayload[];
  readonly cursor: {
    readonly importId: string;
    readonly revision: number;
    readonly externalCursor: string;
    readonly externalCursorDigest: string;
    readonly manifestDigest: string;
    readonly cursorEventId: string;
    readonly advancedAt: string;
  };
}

export interface ReplayedConversationOccurrence {
  readonly kind: "CONVERSATION";
  readonly ordinal: number;
  readonly importedConversationId: string;
  readonly externalConversationId: string;
  readonly participantCount: number;
  readonly participantsDigest: string;
}

export interface ReplayedMessageOccurrence {
  readonly kind: "MESSAGE_VERSION";
  readonly ordinal: number;
  readonly importedConversationId: string;
  readonly externalMessageId: string;
  readonly messageIdentityDigest: string;
  readonly contentDigest: string;
  readonly recordDigest: string;
}

export interface ReplayedQuarantineOccurrence {
  readonly kind: "QUARANTINE";
  readonly ordinal: number;
  readonly itemScope: "CONVERSATION" | "MESSAGE";
  readonly conversationOrdinal: number;
  readonly quarantinePayloadId: string;
  readonly externalConversationId: string | null;
  readonly externalMessageId: string | null;
  readonly recordDigest: string;
  readonly reason: string;
}

export type ReplayedItemOccurrence = ReplayedMessageOccurrence | ReplayedQuarantineOccurrence;

export interface ReplayedMessageVersion {
  readonly messageVersionId: string;
  readonly importedConversationId: string;
  readonly externalConversationId: string;
  readonly externalMessageId: string;
  readonly participantId: string;
  readonly participantIdentityDigest: string;
  readonly messageIdentityDigest: string;
  readonly version: number;
  readonly versionIdentityDigest: string;
  readonly contentDigest: string;
  readonly sourceRecordDigest: string;
  readonly role: ChatMessageRole;
  readonly sourceAt: string;
  readonly eventId: string;
  readonly importId: string;
  readonly predecessorMessageVersionId: string | null;
}

export interface ReplayedQuarantinePayload {
  readonly quarantinePayloadId: string;
  readonly firstImportId: string;
  readonly itemScope: "CONVERSATION" | "MESSAGE";
  readonly conversationOrdinal: number;
  readonly externalConversationId: string | null;
  readonly externalMessageId: string | null;
  readonly firstItemOrdinal: number;
  readonly recordDigest: string;
  readonly reason: string;
  readonly rawItem: JsonValue;
  readonly eventId: string;
}
