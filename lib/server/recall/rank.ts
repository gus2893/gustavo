import type { MemoryConflictState, MemoryScope, MemoryType } from "../memory/types";

export const RECALL_EXCLUSION_REASONS = Object.freeze([
  "SCOPE_FORBIDDEN",
  "SOURCE_EQUIVALENT",
  "RESULT_LIMIT",
  "TOKEN_LIMIT",
  "SOURCE_ERASED",
] as const);

export type RecallExclusionReason = typeof RECALL_EXCLUSION_REASONS[number];

export interface RecallCandidate {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  readonly accountId: string | null;
  readonly nodeBrainId: string | null;
  readonly conversationId: string | null;
  readonly proposalAuthorized: boolean;
  readonly current: boolean;
  readonly score: number;
  readonly sourceIds: readonly string[];
  readonly confidence: number;
  readonly importance: number;
  readonly freshness: number;
  readonly createdAt: string;
  readonly conflictState: MemoryConflictState;
  readonly equivalenceDigest: string;
  readonly supersedesMemoryId: string | null;
  readonly text: string;
  readonly channels: readonly string[];
}

export interface RecallExcluded {
  readonly id: string;
  readonly reason: RecallExclusionReason;
}

export interface RankedRecall {
  readonly selected: readonly RecallCandidate[];
  readonly excluded: readonly RecallExcluded[];
  readonly estimatedTokens: number;
}

/** Fair, deterministic round-robin fusion before the global candidate cap. */
export function fuseBoundedRecallChannels<Candidate extends RecallCandidate>(
  channels: readonly (readonly Candidate[])[],
  maximum = 100,
): readonly Candidate[] {
  const byId = new Map<string, Candidate>();
  const positions = channels.map(() => 0);
  while (byId.size < maximum) {
    let progressed = false;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const channel = channels[channelIndex];
      while (positions[channelIndex] < channel.length) {
        const candidate = channel[positions[channelIndex]++];
        const current = byId.get(candidate.id);
        if (current) {
          byId.set(candidate.id, Object.freeze({
            ...current,
            score: Math.max(current.score, candidate.score),
            channels: Object.freeze([...new Set([...current.channels, ...candidate.channels])]),
          }));
          continue;
        }
        byId.set(candidate.id, candidate);
        progressed = true;
        break;
      }
      if (byId.size >= maximum) break;
    }
    if (!progressed) break;
  }
  return Object.freeze([...byId.values()]);
}

function pinClass(candidate: RecallCandidate): number {
  if (!candidate.current) return 2;
  if (candidate.scope === "MAIN_SHARED") return 0;
  if (candidate.scope === "CHALLENGE_SHARED") return 1;
  return 2;
}

function conflictPenalty(state: MemoryConflictState): number {
  switch (state) {
    case "CURRENT": return 0;
    case "CONFLICTED": return 0.08;
    case "CORRECTED": return 0.12;
    case "SUPERSEDED": return 0.3;
  }
}

function compositeScore(candidate: RecallCandidate): number {
  const base = candidate.score * 0.62
    + candidate.importance * 0.14
    + candidate.confidence * 0.14
    + candidate.freshness * 0.1;
  return base - conflictPenalty(candidate.conflictState) - (candidate.current ? 0 : 0.08);
}

function compareCandidates(left: RecallCandidate, right: RecallCandidate): number {
  const pin = pinClass(left) - pinClass(right);
  if (pin !== 0) return pin;
  const score = compositeScore(right) - compositeScore(left);
  if (Math.abs(score) > Number.EPSILON) return score;
  const created = right.createdAt.localeCompare(left.createdAt);
  return created || left.id.localeCompare(right.id);
}

function estimatedTokens(candidate: RecallCandidate): number {
  return Math.max(1, Math.ceil(candidate.text.length / 4) + 3);
}

/** Deterministic, bounded reranking over an already-authorized candidate set. */
export function fuseAndRankAuthorizedCandidates(
  candidates: readonly RecallCandidate[],
  options: { readonly maxMemories: number; readonly tokenBudget: number },
): RankedRecall {
  const ordered = [...candidates].sort(compareCandidates);
  const seenEquivalent = new Set<string>();
  const selected: RecallCandidate[] = [];
  const excluded: RecallExcluded[] = [];
  let tokenCount = 0;
  for (const candidate of ordered) {
    const identity = [
      candidate.scope,
      candidate.accountId ?? "",
      candidate.nodeBrainId ?? "",
      candidate.conversationId ?? "",
      candidate.type,
      candidate.equivalenceDigest,
    ].join(":");
    if (seenEquivalent.has(identity)) {
      excluded.push(Object.freeze({ id: candidate.id, reason: "SOURCE_EQUIVALENT" }));
      continue;
    }
    seenEquivalent.add(identity);
    if (selected.length >= options.maxMemories) {
      excluded.push(Object.freeze({ id: candidate.id, reason: "RESULT_LIMIT" }));
      continue;
    }
    const cost = estimatedTokens(candidate);
    if (tokenCount + cost > options.tokenBudget) {
      excluded.push(Object.freeze({ id: candidate.id, reason: "TOKEN_LIMIT" }));
      continue;
    }
    selected.push(candidate);
    tokenCount += cost;
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    excluded: Object.freeze(excluded),
    estimatedTokens: tokenCount,
  });
}
