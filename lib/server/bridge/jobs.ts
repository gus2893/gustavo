export const BRIDGE_JOB_ROLES = Object.freeze([
  "NODE",
  "EVALUATOR",
  "MAIN",
] as const);

export const BRIDGE_JOB_RETENTION_DAYS = 7 as const;

export const BRIDGE_JOB_KINDS = Object.freeze([
  "NODE_REPLY",
  "EVALUATOR_REVIEW",
  "MAIN_GENERATION",
] as const);

export const BRIDGE_JOB_STATUSES = Object.freeze([
  "PENDING",
  "CLAIMED",
  "COMPLETED",
  "FAILED",
] as const);

export const BRIDGE_SAFE_TERMINAL_CODES = Object.freeze([
  "SOURCE_AUTHORITY_REVOKED",
  "ROUTING_AUTHORITY_REVOKED",
  "CODEX_AUTH_UNAVAILABLE",
  "CODEX_DAILY_QUOTA_EXHAUSTED",
  "CODEX_MODEL_UNAVAILABLE",
  "CODEX_TIMEOUT",
  "CODEX_OUTPUT_INVALID",
  "CODEX_PROCESS_FAILED",
  "OUTPUT_AUTHORITY_INVALID",
  "ATTEMPT_LIMIT_EXHAUSTED",
  "MAIN_CANDIDATE_REJECTED",
  "EVALUATOR_REJECTED",
] as const);

export const BRIDGE_ROLE_PRIORITIES = Object.freeze({
  NODE: 0,
  EVALUATOR: 10,
  MAIN: 20,
} as const);

export const HYBRID_WORKER_COMPONENTS = Object.freeze([
  "CODEX",
  "MARKET",
  "TUNNEL",
] as const);

export const HYBRID_WORKER_STATUSES = Object.freeze([
  "HEALTHY",
  "DEGRADED",
  "OFFLINE",
] as const);

export const HYBRID_WORKER_SAFE_CODES = Object.freeze([
  "AUTH_REQUIRED",
  "QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "DATABASE_UNAVAILABLE",
  "TUNNEL_UNAVAILABLE",
  "WORKER_OFFLINE",
] as const);

export const MARKET_WINDOW_STATUSES = Object.freeze([
  "PENDING",
  "COMPLETED",
  "FAILED",
] as const);

export const MARKET_PROVIDER_STATUSES = Object.freeze([
  "UNKNOWN",
  "OPEN",
  "CLOSED",
  "ERROR",
] as const);

export const MARKET_WINDOW_SAFE_CODES = Object.freeze([
  "MARKET_CLOSED",
  "PROVIDER_ERROR",
  "RATE_LIMITED",
  "RESULT_COUNT_INVALID",
  "CALL_LIMIT_EXCEEDED",
  "WINDOW_CONFLICT",
] as const);

export const MARKET_QUOTE_STATUSES = Object.freeze([
  "SUCCESS",
  "UNAVAILABLE",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
] as const);

export const MARKET_QUOTE_SAFE_CODES = Object.freeze([
  "MARKET_CLOSED",
  "SYMBOL_UNAVAILABLE",
  "STALE_QUOTE",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
  "MALFORMED_RESPONSE",
] as const);

export const MARKET_SYMBOL_KINDS = Object.freeze([
  "STOCK",
  "ETF",
] as const);

export const DEPLOYMENT_QUOTA_NAMES = Object.freeze([
  "QSTASH_MESSAGES",
  "CODEX_JOBS",
  "FINNHUB_CALLS",
] as const);

export type BridgeJobRole = typeof BRIDGE_JOB_ROLES[number];
export type BridgeJobKind = typeof BRIDGE_JOB_KINDS[number];
export type BridgeJobStatus = typeof BRIDGE_JOB_STATUSES[number];
export type BridgeSafeTerminalCode = typeof BRIDGE_SAFE_TERMINAL_CODES[number];
export type HybridWorkerComponent = typeof HYBRID_WORKER_COMPONENTS[number];
export type HybridWorkerStatus = typeof HYBRID_WORKER_STATUSES[number];
export type HybridWorkerSafeCode = typeof HYBRID_WORKER_SAFE_CODES[number];
export type MarketWindowStatus = typeof MARKET_WINDOW_STATUSES[number];
export type MarketProviderStatus = typeof MARKET_PROVIDER_STATUSES[number];
export type MarketWindowSafeCode = typeof MARKET_WINDOW_SAFE_CODES[number];
export type MarketQuoteStatus = typeof MARKET_QUOTE_STATUSES[number];
export type MarketQuoteSafeCode = typeof MARKET_QUOTE_SAFE_CODES[number];
export type MarketSymbolKind = typeof MARKET_SYMBOL_KINDS[number];
export type DeploymentQuotaName = typeof DEPLOYMENT_QUOTA_NAMES[number];

export interface BridgeModelJobRow {
  readonly jobId: string;
  readonly sourceEventId: string;
  readonly role: BridgeJobRole;
  readonly kind: BridgeJobKind;
  readonly priority: 0 | 10 | 20;
  readonly requestDigest: string;
  readonly status: BridgeJobStatus;
  readonly attemptCount: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly outputEventId: string | null;
  readonly safeCode: BridgeSafeTerminalCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BridgeWakeReceiptRow {
  readonly messageId: string;
  readonly bodyDigest: string;
  readonly publishedAt: string;
  readonly receivedAt: string;
  readonly pruneAfter: string;
}

export interface HybridWorkerHeartbeatRow {
  readonly component: HybridWorkerComponent;
  readonly status: HybridWorkerStatus;
  readonly safeCode: HybridWorkerSafeCode | null;
  readonly observedAt: string;
  readonly updatedAt: string;
}

export interface MarketPollWindowRow {
  readonly windowId: string;
  readonly windowStartedAt: string;
  readonly provider: "FINNHUB";
  readonly status: MarketWindowStatus;
  readonly providerStatus: MarketProviderStatus;
  readonly callsUsed: number;
  readonly resultCount: number;
  readonly safeCode: MarketWindowSafeCode | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pruneAfter: string;
}

export interface MarketLatestQuoteRow {
  readonly accountId: string;
  readonly symbol: string;
  readonly windowId: string;
  readonly provider: "FINNHUB";
  readonly status: MarketQuoteStatus;
  readonly sourceObservedAt: string | null;
  readonly receivedAt: string;
  readonly dataKeyId: string | null;
  readonly ciphertext: Uint8Array | null;
  readonly envelopeIv: Uint8Array | null;
  readonly envelopeAuthTag: Uint8Array | null;
  readonly envelopeEncoding: "canonical-json-v1" | null;
  readonly contextDigest: string;
  readonly safeCode: MarketQuoteSafeCode | null;
  readonly updatedAt: string;
}

export interface MarketSymbolCatalogRow {
  readonly ordinal: number;
  readonly symbol: string;
  readonly kind: MarketSymbolKind;
}

export interface DeploymentQuotaCounterRow {
  readonly quotaName: DeploymentQuotaName;
  readonly bucketDate: string;
  readonly usedCount: number;
  readonly limitCount: number;
  readonly updatedAt: string;
}
