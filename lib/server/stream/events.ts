import type { ActorContext } from "../auth/authorize";
import {
  projectFeedEvent,
  type FeedDto,
  type FeedEvent,
} from "../dal/feed";

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_HEARTBEATS = 4;
const DEFAULT_MAX_EVENTS = 1_000;
const MAX_EVENT_ID_LENGTH = 256;

export const STREAM_EVENT_CHANNEL = "gustavo:events:committed";
const UUID_EVENT_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const STREAM_CURSOR = new RegExp(`^sse\\.v1:([1-9][0-9]*):(${UUID_EVENT_ID})$`, "iu");
const UUID_EVENT_ID_PATTERN = new RegExp(`^${UUID_EVENT_ID}$`, "iu");
const MAX_STREAM_POSITION = 9_223_372_036_854_775_807n;

export interface StreamCursor {
  readonly position: string;
  readonly eventId: string;
}

export function formatStreamCursor(position: string | bigint, eventId: string): string {
  const normalizedPosition = typeof position === "bigint" ? position.toString() : position;
  if (!/^[1-9][0-9]*$/u.test(normalizedPosition)
      || BigInt(normalizedPosition) < 1n
      || BigInt(normalizedPosition) > MAX_STREAM_POSITION
      || !UUID_EVENT_ID_PATTERN.test(eventId)) {
    throw new Error("INVALID_STREAM_CURSOR");
  }
  return `sse.v1:${normalizedPosition}:${eventId.toLowerCase()}`;
}

export function parseStreamCursor(value: string): StreamCursor {
  const match = STREAM_CURSOR.exec(value);
  if (!match) throw new Error("INVALID_LAST_EVENT_ID");
  const position = match[1]!;
  if (BigInt(position) < 1n || BigInt(position) > MAX_STREAM_POSITION) {
    throw new Error("INVALID_LAST_EVENT_ID");
  }
  return Object.freeze({ position, eventId: match[2]!.toLowerCase() });
}

export interface StreamSourceEvent {
  readonly id: string;
  readonly cursorId?: string;
  readonly visibility: string;
  readonly accountId?: string | null;
  readonly type?: string;
  readonly createdAt?: string;
  readonly topic?: string;
  readonly text?: string;
  readonly protectedText?: string;
  readonly [key: string]: unknown;
}

export interface ClosableEventIdSource {
  close?: () => void | Promise<void>;
}

export type EventIdSource = (
  Iterable<string> | AsyncIterable<string>
) & ClosableEventIdSource;

export interface OpenFeedStreamInput {
  readonly actor: ActorContext;
  readonly eventIds: EventIdSource;
  readonly load: (eventId: string) => Promise<StreamSourceEvent | undefined>;
  readonly revalidate?: () => boolean | Promise<boolean>;
  readonly abort?: () => void;
  readonly onResponseSettled?: () => void | Promise<void>;
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
  readonly heartbeatMs?: number;
  readonly maxConsecutiveHeartbeats?: number;
  readonly maxEvents?: number;
}

export interface FeedStream {
  readonly headers: Headers;
  collect(): Promise<readonly FeedDto[]>;
  collectFrames(): Promise<readonly string[]>;
  frames(): AsyncIterable<string>;
  readable(): ReadableStream<Uint8Array>;
}

type StreamEmission =
  | { readonly kind: "EVENT"; readonly cursorId: string; readonly dto: FeedDto }
  | { readonly kind: "HEARTBEAT" };

type WaitResult =
  | { readonly kind: "NEXT"; readonly result: IteratorResult<string> }
  | { readonly kind: "HEARTBEAT" }
  | { readonly kind: "ABORT" };

export function isFeedEventId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_EVENT_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function positiveInteger(value: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(code);
  }
  return value;
}

function asyncIterator(source: EventIdSource): AsyncIterator<string> {
  if (Symbol.asyncIterator in source) {
    return source[Symbol.asyncIterator]();
  }
  const iterator = source[Symbol.iterator]();
  return {
    async next() {
      return iterator.next();
    },
    async return() {
      return iterator.return?.() ?? { done: true, value: undefined };
    },
  };
}

interface EventIdSourceAuthority {
  readonly iterator: AsyncIterator<string>;
  settle(): Promise<void>;
}

function eventIdSourceAuthority(source: EventIdSource): EventIdSourceAuthority {
  const iterator = asyncIterator(source);
  let settlement: Promise<void> | undefined;
  return Object.freeze({
    iterator,
    settle() {
      settlement ??= Promise.resolve().then(async () => {
        try {
          await source.close?.();
        } finally {
          await iterator.return?.();
        }
      });
      return settlement;
    },
  });
}

async function waitForNext(
  pending: Promise<IteratorResult<string>>,
  heartbeatMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitResult> {
  if (signal?.aborted) return { kind: "ABORT" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: () => void = () => undefined;
  const heartbeat = new Promise<WaitResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "HEARTBEAT" }), heartbeatMs);
    timer.unref?.();
  });
  const aborted = new Promise<WaitResult>((resolve) => {
    if (!signal) return;
    const listener = () => resolve({ kind: "ABORT" });
    signal.addEventListener("abort", listener, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", listener);
  });
  try {
    return await Promise.race([
      pending.then((result): WaitResult => ({ kind: "NEXT", result })),
      heartbeat,
      aborted,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener();
  }
}

function feedEvent(event: StreamSourceEvent): FeedEvent {
  const type = typeof event.type === "string" && event.type.length > 0
    ? event.type : "event.committed";
  const parsedCreatedAt = event.createdAt === undefined
    ? undefined : new Date(event.createdAt);
  return {
    id: event.id,
    accountId: event.accountId ?? null,
    type,
    createdAt: parsedCreatedAt && Number.isFinite(parsedCreatedAt.getTime())
      ? parsedCreatedAt.toISOString() : "1970-01-01T00:00:00.000Z",
    topic: typeof event.topic === "string" && event.topic.length > 0
      ? event.topic : type,
    protectedText: typeof event.protectedText === "string"
      ? event.protectedText
      : typeof event.text === "string" ? event.text : undefined,
  };
}

function authorizedProjection(
  actor: ActorContext,
  source: StreamSourceEvent,
): FeedDto | undefined {
  const event = feedEvent(source);
  if (source.visibility === "PUBLIC") {
    return projectFeedEvent({ role: "PUBLIC" }, event);
  }
  if (source.visibility === "PRIVATE_ACCOUNT" || source.visibility === "SHARED") {
    if (actor.role === "ACCOUNT" && source.accountId !== actor.accountId) return undefined;
    if (actor.role === "PUBLIC") return undefined;
    try {
      switch (actor.role) {
        case "ACCOUNT":
          return projectFeedEvent(actor, event);
        case "MODERATOR":
        case "OPERATOR":
          return projectFeedEvent(actor, event);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "FORBIDDEN") return undefined;
      throw error;
    }
  }
  if (source.visibility === "OPERATOR" && actor.role === "OPERATOR") {
    return projectFeedEvent(actor, event);
  }
  return undefined;
}

async function authorized(revalidate: OpenFeedStreamInput["revalidate"]): Promise<boolean> {
  if (!revalidate) return true;
  try {
    return await revalidate();
  } catch {
    return false;
  }
}

async function* emissions(
  input: OpenFeedStreamInput,
  sourceAuthority = eventIdSourceAuthority(input.eventIds),
): AsyncGenerator<StreamEmission> {
  const heartbeatMs = positiveInteger(
    input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    60_000,
    "INVALID_SSE_HEARTBEAT_MS",
  );
  const maxHeartbeats = positiveInteger(
    input.maxConsecutiveHeartbeats ?? DEFAULT_MAX_HEARTBEATS,
    100,
    "INVALID_SSE_HEARTBEAT_LIMIT",
  );
  const maxEvents = positiveInteger(
    input.maxEvents ?? DEFAULT_MAX_EVENTS,
    10_000,
    "INVALID_SSE_EVENT_LIMIT",
  );
  if (input.lastEventId !== undefined && !isFeedEventId(input.lastEventId)) {
    throw new Error("INVALID_LAST_EVENT_ID");
  }

  const iterator = sourceAuthority.iterator;
  let pending: Promise<IteratorResult<string>> | undefined;
  let consecutiveHeartbeats = 0;
  let eventCount = 0;
  let examinedCount = 0;
  const seen = new Set<string>(input.lastEventId ? [input.lastEventId] : []);
  try {
    while (eventCount < maxEvents
        && examinedCount < maxEvents * 10
        && !input.signal?.aborted) {
      pending ??= Promise.resolve(iterator.next());
      const next = await waitForNext(pending, heartbeatMs, input.signal);
      if (next.kind === "ABORT") return;
      if (next.kind === "HEARTBEAT") {
        if (!await authorized(input.revalidate)) return;
        consecutiveHeartbeats += 1;
        yield { kind: "HEARTBEAT" };
        if (consecutiveHeartbeats >= maxHeartbeats) return;
        continue;
      }

      pending = undefined;
      if (next.result.done) return;
      consecutiveHeartbeats = 0;
      examinedCount += 1;
      const eventId = next.result.value;
      if (!isFeedEventId(eventId) || seen.has(eventId)) continue;
      seen.add(eventId);
      if (!await authorized(input.revalidate)) return;

      let source: StreamSourceEvent | undefined;
      try {
        source = await input.load(eventId);
      } catch {
        return;
      }
      const cursorId = source?.cursorId ?? source?.id;
      if (!source || cursorId !== eventId) continue;
      if (!await authorized(input.revalidate)) return;
      const dto = authorizedProjection(input.actor, source);
      if (!dto) continue;
      eventCount += 1;
      yield { kind: "EVENT", cursorId, dto };
    }
  } finally {
    await sourceAuthority.settle();
  }
}

export function formatSseEvent(dto: FeedDto, cursorId = dto.id): string {
  if (!isFeedEventId(cursorId)) throw new Error("INVALID_SSE_EVENT_ID");
  return `id: ${cursorId}\nevent: feed\ndata: ${JSON.stringify(dto)}\n\n`;
}

export function openFeedStream(input: OpenFeedStreamInput): FeedStream {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  const createFrames = async function* (
    sourceAuthority = eventIdSourceAuthority(input.eventIds),
  ): AsyncGenerator<string> {
    for await (const emission of emissions(input, sourceAuthority)) {
      yield emission.kind === "HEARTBEAT"
        ? ": heartbeat\n\n"
        : formatSseEvent(emission.dto, emission.cursorId);
    }
  };
  return Object.freeze({
    headers,
    async collect() {
      const result: FeedDto[] = [];
      for await (const emission of emissions(input)) {
        if (emission.kind === "EVENT") result.push(emission.dto);
      }
      return Object.freeze(result);
    },
    async collectFrames() {
      const result: string[] = [];
      for await (const frame of createFrames()) result.push(frame);
      return Object.freeze(result);
    },
    frames: createFrames,
    readable() {
      const encoder = new TextEncoder();
      const sourceAuthority = eventIdSourceAuthority(input.eventIds);
      const iterator = createFrames(sourceAuthority)[Symbol.asyncIterator]();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let settlement: Promise<void> | undefined;
      let cancelled = false;
      let terminal = false;

      const settle = (): Promise<void> => {
        settlement ??= Promise.resolve().then(async () => {
          input.abort?.();
          try {
            await iterator.return?.(undefined);
          } finally {
            try {
              await sourceAuthority.settle();
            } finally {
              input.signal?.removeEventListener("abort", abortAndSettle);
              await input.onResponseSettled?.();
              if (!cancelled && !terminal) {
                terminal = true;
                controller?.close();
              }
            }
          }
        });
        return settlement;
      };
      const abortAndSettle = () => {
        void settle().catch((error: unknown) => {
          if (!cancelled && !terminal) {
            terminal = true;
            controller?.error(error);
          }
        });
      };

      return new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
          input.signal?.addEventListener("abort", abortAndSettle, { once: true });
          if (input.signal?.aborted) abortAndSettle();
        },
        async pull(controller) {
          if (settlement || input.signal?.aborted) {
            await settle();
            return;
          }
          try {
            const next = await iterator.next();
            if (input.signal?.aborted || next.done) {
              await settle();
              return;
            }
            controller.enqueue(encoder.encode(next.value));
          } catch (error) {
            if (!cancelled && !terminal) {
              terminal = true;
              controller.error(error);
            }
            await settle();
          }
        },
        async cancel() {
          cancelled = true;
          await settle();
        },
      });
    },
  });
}
