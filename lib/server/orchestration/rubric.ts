import { createHmac, timingSafeEqual } from "node:crypto";

export const RUBRIC_V1 = Object.freeze({
  version: "rubric-v1",
  weights: Object.freeze({
    evidenceFreshness: 25,
    structuralClarity: 20,
    costAdjustedGeometry: 20,
    falsifiability: 15,
    uncertainty: 10,
    independence: 10,
  }),
  actionThreshold: 80,
  improvementMargin: 5,
});

export type RubricComponent = keyof typeof RUBRIC_V1.weights;
export type RubricComponents = Readonly<Record<RubricComponent, number>>;

export interface HardGates {
  readonly evidenceFresh: boolean;
  readonly sessionValid: boolean;
  readonly geometryComplete: boolean;
  readonly nonDuplicate: boolean;
  readonly authorized: boolean;
}

export interface ScoredCandidate {
  readonly id: string;
  readonly score: number;
  readonly hardGatesPassed: boolean;
  readonly actionable?: boolean;
}

export interface CandidateScoreInput {
  readonly candidateId: string;
  readonly components: RubricComponents;
  readonly hardGates: HardGates;
}

const components = Object.keys(RUBRIC_V1.weights) as RubricComponent[];
const hardGateNames = [
  "evidenceFresh",
  "sessionValid",
  "geometryComplete",
  "nonDuplicate",
  "authorized",
] as const satisfies readonly (keyof HardGates)[];

function boundedIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(value)) {
    throw new Error(code);
  }
  return value;
}

export function scoreCandidate(input: CandidateScoreInput): ScoredCandidate {
  const id = boundedIdentifier(input?.candidateId, "EVALUATION_CANDIDATE_INVALID");
  if (!input.components || typeof input.components !== "object"
    || Object.keys(input.components).sort().join(",") !== [...components].sort().join(",")) {
    throw new Error("EVALUATION_COMPONENTS_INVALID");
  }
  let score = 0;
  for (const component of components) {
    const value = input.components[component];
    if (!Number.isSafeInteger(value) || value < 0 || value > RUBRIC_V1.weights[component]) {
      throw new Error("EVALUATION_COMPONENTS_INVALID");
    }
    score += value;
  }
  if (!input.hardGates || typeof input.hardGates !== "object"
    || Object.keys(input.hardGates).sort().join(",") !== [...hardGateNames].sort().join(",")
    || hardGateNames.some((gate) => typeof input.hardGates[gate] !== "boolean")) {
    throw new Error("EVALUATION_HARD_GATES_INVALID");
  }
  return Object.freeze({
    id,
    score,
    hardGatesPassed: hardGateNames.every((gate) => input.hardGates[gate]),
  });
}

function validScoredCandidate(value: ScoredCandidate): ScoredCandidate {
  const id = boundedIdentifier(value?.id, "EVALUATION_CANDIDATE_INVALID");
  if (!Number.isSafeInteger(value.score) || value.score < 0 || value.score > 100
    || typeof value.hardGatesPassed !== "boolean"
    || (value.actionable !== undefined && typeof value.actionable !== "boolean")) {
    throw new Error("EVALUATION_SCORE_INVALID");
  }
  return {
    id,
    score: value.score,
    hardGatesPassed: value.hardGatesPassed,
    actionable: value.actionable ?? true,
  };
}

export function selectWinner(input: {
  readonly main: ScoredCandidate;
  readonly contenders: readonly ScoredCandidate[];
}): string {
  const main = validScoredCandidate(input?.main);
  if (main.id !== "main" || !Array.isArray(input.contenders) || input.contenders.length > 64) {
    throw new Error("EVALUATION_SELECTION_INPUT_INVALID");
  }
  const contenderIds = new Set<string>();
  const contenders = input.contenders.map((candidate) => {
    const value = validScoredCandidate(candidate);
    if (value.id === "main" || contenderIds.has(value.id)) {
      throw new Error("EVALUATION_SELECTION_INPUT_INVALID");
    }
    contenderIds.add(value.id);
    return value;
  });
  const eligible = contenders
    .filter((candidate) => candidate.hardGatesPassed
      && candidate.score >= RUBRIC_V1.actionThreshold
      && candidate.score >= main.score + RUBRIC_V1.improvementMargin)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  if (eligible[0]) return eligible[0].id;
  if (main.actionable && main.hardGatesPassed && main.score >= RUBRIC_V1.actionThreshold) return "main";
  return "NO_PAPER_TRADE";
}

function pseudonymKey(): Buffer {
  const encoded = process.env.GUSTAVO_EVALUATOR_PSEUDONYM_KEY;
  if (!encoded) throw new Error("EVALUATOR_PSEUDONYM_KEY_REQUIRED");
  const key = Buffer.from(encoded, "base64");
  if (key.length < 32) throw new Error("EVALUATOR_PSEUDONYM_KEY_INVALID");
  return key;
}

export function anonymizeCandidate(input: {
  readonly nodeBrainId: string;
  readonly accountId: string;
  readonly thesis: string;
  readonly windowId?: string;
}): { readonly candidateId: string; readonly thesis: string } {
  const nodeBrainId = boundedIdentifier(input?.nodeBrainId, "EVALUATION_CANDIDATE_INVALID");
  const accountId = boundedIdentifier(input?.accountId, "EVALUATION_CANDIDATE_INVALID");
  const windowId = input.windowId === undefined
    ? "global" : boundedIdentifier(input.windowId, "EVALUATION_CANDIDATE_INVALID");
  if (typeof input.thesis !== "string" || input.thesis.length < 1 || input.thesis.length > 8_000
    || input.thesis !== input.thesis.trim() || input.thesis.includes("\u0000")) {
    throw new Error("EVALUATION_THESIS_INVALID");
  }
  const digest = createHmac("sha256", pseudonymKey())
    .update(`${windowId}\u0000${accountId}\u0000${nodeBrainId}`)
    .digest("hex")
    .slice(0, 32);
  return Object.freeze({ candidateId: `candidate_${digest}`, thesis: input.thesis });
}

export function candidateIdsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
