"use client";

import { useEffect, useState, type FormEvent } from "react";
import type {
  AccountConversationBroadcastDto,
  AccountConversationMessageDto,
} from "../../lib/server/dal/account-surfaces";
import type { NodeReplyMode } from "../../lib/server/node-brains/contracts";
import type { ProposalStatus } from "../../lib/server/orchestration/proposals";
import { MemoryControls } from "../memory/MemoryControls";

export type ConversationAuthor = AccountConversationMessageDto["author"];

export interface ConversationMessageDto {
  readonly id: string;
  readonly author: ConversationAuthor;
  readonly routingMode?: NodeReplyMode;
  readonly proposalStatus?: ProposalStatus;
  readonly text: string;
  readonly occurredAt?: string;
}

export type ConversationBroadcastDto = AccountConversationBroadcastDto;

interface ConversationSubmitDependencies {
  readonly fetch: typeof fetch;
  readonly formData: (form: HTMLFormElement) => FormData;
  readonly randomUUID: () => string;
  readonly reload: () => void;
}

const DEFAULT_SUBMIT_DEPENDENCIES: ConversationSubmitDependencies = {
  fetch: (...arguments_) => fetch(...arguments_),
  formData: (form) => new FormData(form),
  randomUUID: () => crypto.randomUUID(),
  reload: () => window.location.reload(),
};

export async function submitConversationMessage(
  event: FormEvent<HTMLFormElement>,
  conversationId: string | undefined,
  setStatus: (status: string) => void,
  dependencies: ConversationSubmitDependencies = DEFAULT_SUBMIT_DEPENDENCIES,
): Promise<void> {
  event.preventDefault();
  if (!conversationId) return;
  const formElement = event.currentTarget;
  const form = dependencies.formData(formElement);
  const response = await dependencies.fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: form.get("text"),
        idempotencyKey: `participant-message:${dependencies.randomUUID()}`,
      }),
    },
  );
  if (!response.ok) {
    setStatus("Message was not accepted by the server.");
    return;
  }
  formElement.reset();
  setStatus("Message accepted by the server.");
  dependencies.reload();
}

export interface ConversationProps {
  readonly conversationId?: string;
  readonly messages: readonly ConversationMessageDto[];
  readonly broadcasts?: readonly ConversationBroadcastDto[];
  readonly nextCursor?: string | null;
  readonly status?: "ready" | "loading" | "error";
  readonly proposalDisclosure?: boolean;
}

const AUTHOR_LABELS: Readonly<Record<ConversationAuthor, string>> = Object.freeze({
  USER: "You",
  NODE_BRAIN: "Node Brain",
  MAIN_BRAIN: "Main Brain",
});

export function Conversation({
  conversationId,
  messages,
  broadcasts = [],
  nextCursor = null,
  status = "ready",
  proposalDisclosure = false,
}: ConversationProps) {
  const [hydrated, setHydrated] = useState(false);
  const [mutationStatus, setMutationStatus] = useState("");
  useEffect(() => setHydrated(true), []);
  const historyHref = nextCursor === null
    ? null
    : `/chat?after=${encodeURIComponent(nextCursor)}`;

  return (
    <main>
      <header>
        <h1>Your Node Brain</h1>
        <p>One continuous private chat with your stable Node Brain.</p>
      </header>

      {proposalDisclosure && (
        <p>
          Qualifying feedback may be summarized into a source-linked proposal for
          Main Brain review. A proposal is not an accepted Main position.
        </p>
      )}

      {broadcasts.length > 0 && (
        <section aria-labelledby="main-broadcasts-heading">
          <h2 id="main-broadcasts-heading">Main Brain broadcasts</h2>
          <ol>
            {broadcasts.map((broadcast) => (
              <li key={broadcast.id}>
                <article>
                  <header>
                    <strong>{AUTHOR_LABELS[broadcast.author]}</strong>
                    {broadcast.occurredAt && (
                      <time dateTime={broadcast.occurredAt}>{broadcast.occurredAt}</time>
                    )}
                  </header>
                  <p>{broadcast.text}</p>
                </article>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-busy={status === "loading"} aria-labelledby="conversation-heading">
        <h2 id="conversation-heading">Conversation</h2>
        {status === "loading" ? (
          <p role="status">Loading conversation history…</p>
        ) : status === "error" ? (
          <p role="alert">Conversation history is unavailable.</p>
        ) : messages.length === 0 ? (
          <p role="status">No messages yet.</p>
        ) : (
          <ol aria-label="Conversation history">
            {messages.map((message) => (
              <li key={message.id}>
                <article>
                  <header>
                    <strong>{AUTHOR_LABELS[message.author]}</strong>
                    {message.routingMode && <span>{message.routingMode}</span>}
                    {message.proposalStatus && <span>{message.proposalStatus}</span>}
                    {message.occurredAt && (
                      <time dateTime={message.occurredAt}>{message.occurredAt}</time>
                    )}
                  </header>
                  <p>{message.text}</p>
                </article>
              </li>
            ))}
          </ol>
        )}
        {historyHref && <a href={historyHref}>Load newer messages</a>}
      </section>

      <form
        aria-label="Send a message"
        method="post"
        onSubmit={(event) => void submitConversationMessage(
          event,
          conversationId,
          setMutationStatus,
        )}
      >
        <fieldset disabled={!hydrated || !conversationId}>
          <legend>Send a message</legend>
          <label htmlFor="chat-message">Message</label>
          <textarea id="chat-message" name="text" required />
          <button type="submit">Send</button>
        </fieldset>
      </form>
      {mutationStatus && <p role="status">{mutationStatus}</p>}

      <MemoryControls conversationId={conversationId} />
    </main>
  );
}
