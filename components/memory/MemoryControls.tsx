"use client";

import { useState, type FormEvent } from "react";

interface MemoryItemDto {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly createdAt: string;
}

export interface MemoryControlsProps {
  readonly conversationId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function memoryPage(value: unknown): readonly MemoryItemDto[] {
  const page = record(value);
  if (!page || !Array.isArray(page.items)) return [];
  return page.items.flatMap((candidate): MemoryItemDto[] => {
    const item = record(candidate);
    if (!item || typeof item.id !== "string" || typeof item.type !== "string"
      || typeof item.text !== "string" || typeof item.createdAt !== "string"
      || !Array.isArray(item.sourceEventIds)
      || item.sourceEventIds.some((id) => typeof id !== "string")) return [];
    return [{
      id: item.id,
      type: item.type,
      text: item.text,
      createdAt: item.createdAt,
      sourceEventIds: item.sourceEventIds as string[],
    }];
  });
}

function idempotencyKey(kind: string): string {
  return `${kind}:${crypto.randomUUID()}`;
}

async function responseMessage(response: Response): Promise<string> {
  if (response.ok) return "Saved from the server response.";
  const body: unknown = await response.json().catch(() => null);
  const error = record(body)?.error;
  return typeof error === "string" ? `Request failed: ${error}.` : "Request failed.";
}

export function MemoryControls({ conversationId }: MemoryControlsProps) {
  const [memories, setMemories] = useState<readonly MemoryItemDto[]>([]);
  const [sourceDetail, setSourceDetail] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const available = typeof conversationId === "string" && conversationId.length > 0;

  async function inspect(): Promise<void> {
    if (!available) return;
    setStatus("Loading memories…");
    const response = await fetch(
      `/api/memory?conversationId=${encodeURIComponent(conversationId)}&limit=25`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (!response.ok) {
      setStatus(await responseMessage(response));
      return;
    }
    const items = memoryPage(await response.json());
    setMemories(items);
    setStatus(items.length === 0 ? "No memories yet." : "Memories loaded.");
  }

  async function correct(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!available) return;
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/memory", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "CORRECT",
        conversationId,
        memoryId: form.get("memoryId"),
        correctedText: form.get("correctedText"),
        reason: form.get("reason"),
        idempotencyKey: idempotencyKey("memory-correction"),
      }),
    });
    setStatus(await responseMessage(response));
    if (response.ok) await inspect();
  }

  async function inspectSource(memoryId: string, sourceEventId: string): Promise<void> {
    if (!available) return;
    setStatus("Loading memory sourceâ€¦");
    const response = await fetch(
      `/api/memory?conversationId=${encodeURIComponent(conversationId)}`
        + `&memoryId=${encodeURIComponent(memoryId)}`
        + `&sourceEventId=${encodeURIComponent(sourceEventId)}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    if (!response.ok) {
      setStatus(await responseMessage(response));
      return;
    }
    const body: unknown = await response.json();
    const source = record(body);
    const text = source?.text;
    setSourceDetail(typeof text === "string"
      ? text
      : JSON.stringify(source?.data ?? {}, null, 2));
    setStatus("Memory source loaded.");
  }

  async function exportData(): Promise<void> {
    setStatus("Preparing account exportâ€¦");
    const records: unknown[] = [];
    const cursors = new Set<string>();
    let manifest: unknown;
    let nextUrl: string | null = "/api/account/export?limit=50";
    while (nextUrl !== null) {
      const response = await fetch(nextUrl, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        setStatus(await responseMessage(response));
        return;
      }
      const body: unknown = await response.json();
      const page = record(body);
      if (!page || !Array.isArray(page.records)
          || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
        setStatus("Account export returned an invalid response.");
        return;
      }
      manifest ??= page.manifest;
      records.push(...page.records);
      if (typeof page.nextCursor === "string") {
        if (cursors.has(page.nextCursor) || cursors.size >= 2_000) {
          setStatus("Account export pagination could not be completed safely.");
          return;
        }
        cursors.add(page.nextCursor);
        nextUrl = `/api/account/export?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`;
      } else {
        nextUrl = null;
      }
    }
    const blob = new Blob([JSON.stringify({ manifest, records }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gustavo-account-export.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Account export downloaded.");
  }

  async function forget(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!available) return;
    const response = await fetch("/api/memory", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "FORGET",
        conversationId,
        idempotencyKey: idempotencyKey("conversation-forget"),
      }),
    });
    setStatus(response.ok
      ? "Forget request accepted. Server-side propagation is in progress."
      : await responseMessage(response));
  }

  return (
    <section aria-labelledby="memory-controls-heading">
      <h2 id="memory-controls-heading">Memory controls</h2>
      <p>Inspect source-linked software memories or request a correction.</p>

      <button type="button" disabled={!available} onClick={() => void inspect()}>
        Inspect memories
      </button>

      {memories.length > 0 && (
        <ol aria-label="Inspected memories">
          {memories.map((memory) => (
            <li key={memory.id}>
              <article>
                <h3>{memory.type}</h3>
                <p>{memory.text}</p>
                <time dateTime={memory.createdAt}>{memory.createdAt}</time>
                <ul aria-label="Memory sources">
                  {memory.sourceEventIds.map((sourceEventId) => (
                    <li key={sourceEventId}>
                      <button
                        type="button"
                        onClick={() => void inspectSource(memory.id, sourceEventId)}
                      >
                        Inspect source
                      </button>
                    </li>
                  ))}
                </ul>
              </article>
            </li>
          ))}
        </ol>
      )}
      {sourceDetail && <pre aria-label="Memory source detail">{sourceDetail}</pre>}

      <form aria-label="Correct a memory" onSubmit={(event) => void correct(event)}>
        <fieldset disabled={!available}>
          <legend>Correct a memory</legend>
          <label htmlFor="memory-id">Memory ID</label>
          <input id="memory-id" name="memoryId" required />
          <label htmlFor="corrected-memory">Corrected memory</label>
          <textarea id="corrected-memory" name="correctedText" required />
          <label htmlFor="correction-reason">Reason for correction</label>
          <input id="correction-reason" name="reason" required />
          <button type="submit">Submit correction</button>
        </fieldset>
      </form>

      <button type="button" onClick={() => void exportData()}>Export my data</button>

      <form aria-label="Forget this conversation" onSubmit={(event) => void forget(event)}>
        <fieldset disabled={!available}>
          <legend>Forget this conversation</legend>
          <p>This permanently makes the conversation content unavailable.</p>
          <label htmlFor="confirm-forget">
            <input id="confirm-forget" name="confirmForget" type="checkbox" required />
            I understand this action is permanent
          </label>
          <button type="submit">Forget this conversation</button>
        </fieldset>
      </form>

      {!available && <p role="status">Memory controls load after account authorization.</p>}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
