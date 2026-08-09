export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type EventActorType =
  | "USER"
  | "NODE_BRAIN"
  | "MAIN_BRAIN"
  | "EVALUATOR"
  | "SYSTEM"
  | "OPERATOR";

export type EventVisibility = "PUBLIC" | "PRIVATE_ACCOUNT" | "SHARED" | "OPERATOR";

export interface EventActor {
  readonly type: EventActorType;
  readonly id: string;
}

export interface AppendEventInput {
  readonly aggregateId: string;
  readonly accountId?: string;
  readonly actor: EventActor;
  readonly type: string;
  readonly visibility: EventVisibility;
  readonly body: JsonValue;
  readonly idempotencyKey: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly occurredAt?: Date;
  readonly promptVersion?: string;
  readonly modelVersion?: string;
  readonly policyVersion?: string;
}

export interface StoredEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly accountId: string | null;
  readonly actor: EventActor;
  readonly type: string;
  readonly visibility: EventVisibility;
  readonly occurredAt: Date;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly promptVersion: string | null;
  readonly modelVersion: string | null;
  readonly policyVersion: string | null;
  readonly integrityHash: string;
}

export type EventReadActor =
  | { readonly role: "PUBLIC" }
  | { readonly role: "ACCOUNT"; readonly accountId: string }
  | { readonly role: "MODERATOR"; readonly purpose: string }
  | { readonly role: "OPERATOR"; readonly purpose: string }
  | { readonly role: "SYSTEM" };

export interface EventReadContext {
  readonly actor: EventReadActor;
}

export interface EventDatabase {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<Row[]>;
  one<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<Row>;
  transaction<Result>(work: (transaction: EventDatabase) => Promise<Result>): Promise<Result>;
}
