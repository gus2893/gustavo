import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateRisk,
  type RiskEvaluationInput,
} from "../../lib/server/challenge/risk";
import { INITIAL_PROFILE } from "../../lib/server/challenge/profile";

const base = {
  actorType: "MAIN_BRAIN",
  startingBalance: "2500.00",
  currentEquity: "2500.00",
  dayStartEquity: "2500.00",
  realizedDayLoss: "0.00",
  openLoss: "0.00",
  existingStopRisk: "0.00",
  proposedStopRisk: "25.00",
  existingGrossNotional: "0.00",
  proposedNotional: "2000.00",
  pendingOpenCount: 0,
  symbolAlreadyActive: false,
} as const;

describe("Challenge risk gates v1", () => {
  it("accepts the exact limits and rejects every exceeded boundary", () => {
    expect(evaluateRisk(base)).toEqual({ accepted: true, reasons: [] });
    expect(evaluateRisk({ ...base, proposedStopRisk: "25.01" }).reasons)
      .toContain("POSITION_RISK_LIMIT");
    expect(evaluateRisk({
      ...base,
      existingStopRisk: "60.00",
      proposedStopRisk: "20.00",
      pendingOpenCount: 1,
    }).reasons)
      .toContain("PORTFOLIO_RISK_LIMIT");
    expect(evaluateRisk({ ...base, proposedNotional: "2500.01" }).reasons)
      .toContain("GROSS_NOTIONAL_LIMIT");
    expect(evaluateRisk({ ...base, pendingOpenCount: 3 }).reasons)
      .toContain("POSITION_COUNT_LIMIT");
    expect(evaluateRisk({ ...base, pendingOpenCount: 1, symbolAlreadyActive: true }).reasons)
      .toContain("SYMBOL_DUPLICATE");
    expect(evaluateRisk({ ...base, actorType: "NODE_BRAIN" }).reasons)
      .toContain("UNAUTHORIZED_CHALLENGE_ACTOR");
    expect(evaluateRisk({
      ...base,
      realizedDayLoss: "30.00",
      openLoss: "20.00",
      existingStopRisk: "15.00",
      proposedStopRisk: "15.00",
      pendingOpenCount: 1,
    }).reasons).toContain("PORTFOLIO_RISK_LIMIT");
  });

  it("fails at the daily and overall boundaries", () => {
    expect(evaluateRisk({
      ...base,
      dayStartEquity: "2500.00",
      currentEquity: "2400.00",
    }).reasons).toContain("DAILY_LOSS_LIMIT");
    expect(evaluateRisk({ ...base, currentEquity: "2350.00" }).reasons)
      .toContain("OVERALL_LOSS_LIMIT");
  });

  it("accepts exact position, portfolio, gross, and available-count limits", () => {
    expect(evaluateRisk({
      ...base,
      realizedDayLoss: "10.00",
      openLoss: "10.00",
      existingStopRisk: "30.00",
      proposedStopRisk: "25.00",
      existingGrossNotional: "500.00",
      proposedNotional: "2000.00",
      pendingOpenCount: 2,
    })).toEqual({ accepted: true, reasons: [] });

    expect(evaluateRisk({
      ...base,
      proposedStopRisk: "0",
      proposedNotional: "0",
    })).toEqual({ accepted: true, reasons: [] });
  });

  it("calculates the UTC-day loss from day-start equity and clamps gains at zero", () => {
    expect(evaluateRisk({
      ...base,
      dayStartEquity: "2600.00",
      currentEquity: "2500.00",
    }).reasons).toContain("DAILY_LOSS_LIMIT");
    expect(evaluateRisk({
      ...base,
      dayStartEquity: "2400.00",
      currentEquity: "2500.00",
    })).toEqual({ accepted: true, reasons: [] });
  });

  it("uses the static overall floor and current equity as the gross-notional cap", () => {
    expect(evaluateRisk({ ...base, currentEquity: "2350.01" }).reasons)
      .not.toContain("OVERALL_LOSS_LIMIT");
    expect(evaluateRisk({ ...base, currentEquity: "2350.00" }).reasons)
      .toContain("OVERALL_LOSS_LIMIT");
    expect(evaluateRisk({
      ...base,
      currentEquity: "2499.99",
      proposedNotional: "2499.99",
    }).reasons).not.toContain("GROSS_NOTIONAL_LIMIT");
    expect(evaluateRisk({
      ...base,
      currentEquity: "2499.99",
      proposedNotional: "2500.00",
    }).reasons).toContain("GROSS_NOTIONAL_LIMIT");
  });

  it.each([
    ["realized UTC-day loss", "realizedDayLoss", "10.01"],
    ["current open loss", "openLoss", "20.01"],
    ["existing remaining stop risk", "existingStopRisk", "30.01"],
    ["proposed stop risk", "proposedStopRisk", "15.01"],
  ] as const)("includes %s exactly once in aggregate risk", (_name, field, exceeded) => {
    const exact = {
      ...base,
      realizedDayLoss: "10.00",
      openLoss: "20.00",
      existingStopRisk: "30.00",
      proposedStopRisk: "15.00",
      pendingOpenCount: 1,
    };
    expect(evaluateRisk(exact).reasons).not.toContain("PORTFOLIO_RISK_LIMIT");
    expect(evaluateRisk({ ...exact, [field]: exceeded }).reasons)
      .toContain("PORTFOLIO_RISK_LIMIT");
  });

  it("returns every rejection in stable named-predicate order", () => {
    expect(evaluateRisk({
      ...base,
      actorType: "NODE_BRAIN",
      dayStartEquity: "2500.00",
      currentEquity: "2300.00",
      realizedDayLoss: "20.00",
      openLoss: "20.00",
      existingStopRisk: "20.00",
      proposedStopRisk: "30.00",
      existingGrossNotional: "2300.00",
      proposedNotional: "1.00",
      pendingOpenCount: 3,
      symbolAlreadyActive: true,
    }).reasons).toEqual([
      "UNAUTHORIZED_CHALLENGE_ACTOR",
      "DAILY_LOSS_LIMIT",
      "OVERALL_LOSS_LIMIT",
      "POSITION_RISK_LIMIT",
      "PORTFOLIO_RISK_LIMIT",
      "GROSS_NOTIONAL_LIMIT",
      "POSITION_COUNT_LIMIT",
      "SYMBOL_DUPLICATE",
    ]);
  });

  it("normalizes, preserves, and freezes supplied audit provenance", () => {
    const result = evaluateRisk({
      ...base,
      profileVersionId: ` ${INITIAL_PROFILE.profileVersionId.toUpperCase()} `,
      ledgerHighWaterId: " 01989ABC-DEF0-7000-8000-000000000001 ",
    });

    expect(result).toEqual({
      accepted: true,
      reasons: [],
      provenance: {
        profileVersionId: INITIAL_PROFILE.profileVersionId,
        ledgerHighWaterId: "01989abc-def0-7000-8000-000000000001",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
  });

  it("omits optional provenance only when both source IDs are omitted", () => {
    expect(evaluateRisk(base)).toEqual({ accepted: true, reasons: [] });
    expect(() => evaluateRisk({ ...base, profileVersionId: crypto.randomUUID() }))
      .toThrowError("RISK_PROVENANCE_INCOMPLETE");
    expect(() => evaluateRisk({ ...base, ledgerHighWaterId: crypto.randomUUID() }))
      .toThrowError("RISK_PROVENANCE_INCOMPLETE");
  });

  it("rejects a valid but non-v1 profile ID rather than mislabeling v1 limits", () => {
    expect(() => evaluateRisk({
      ...base,
      profileVersionId: "00000000-0000-4000-8000-000000001202",
      ledgerHighWaterId: "01989abc-def0-7000-8000-000000000001",
    })).toThrowError("RISK_PROFILE_VERSION_MISMATCH");
  });

  it.each([
    ["current open loss", { openLoss: "0.01" }],
    ["remaining stop risk", { existingStopRisk: "0.01" }],
    ["gross notional", { existingGrossNotional: "0.01" }],
    ["an active symbol", { symbolAlreadyActive: true }],
  ] as const)("rejects zero positions with %s", (_name, inconsistent) => {
    expect(() => evaluateRisk({ ...base, ...inconsistent }))
      .toThrowError("RISK_SNAPSHOT_INCONSISTENT");
  });

  it("does not permit score, model output, or an override flag to bypass actor policy", () => {
    const untrusted = {
      ...base,
      actorType: "NODE_BRAIN",
      modelScore: 100,
      modelApproved: true,
      overrideRiskGates: true,
    } as unknown as RiskEvaluationInput;

    expect(evaluateRisk(untrusted)).toEqual({
      accepted: false,
      reasons: ["UNAUTHORIZED_CHALLENGE_ACTOR"],
    });
  });

  it.each([
    ["startingBalance", "-1", "RISK_STARTING_BALANCE_INVALID"],
    ["startingBalance", "0", "RISK_STARTING_BALANCE_INVALID"],
    ["currentEquity", "NaN", "RISK_CURRENT_EQUITY_INVALID"],
    ["dayStartEquity", "1e3", "RISK_DAY_START_EQUITY_INVALID"],
    ["realizedDayLoss", "-0.01", "RISK_REALIZED_DAY_LOSS_INVALID"],
    ["openLoss", "", "RISK_OPEN_LOSS_INVALID"],
    ["existingStopRisk", "1.2.3", "RISK_EXISTING_STOP_RISK_INVALID"],
    ["proposedStopRisk", "0.000000001", "RISK_PROPOSED_STOP_RISK_INVALID"],
    ["existingGrossNotional", "Infinity", "RISK_EXISTING_GROSS_NOTIONAL_INVALID"],
    ["proposedNotional", "1".repeat(65), "RISK_PROPOSED_NOTIONAL_INVALID"],
  ] as const)("rejects invalid decimal snapshot field %s", (field, value, error) => {
    expect(() => evaluateRisk({ ...base, [field]: value })).toThrowError(error);
  });

  it("fails closed for invalid primitive types, counts, actor values, and provenance", () => {
    expect(() => evaluateRisk(null as unknown as RiskEvaluationInput))
      .toThrowError("RISK_INPUT_INVALID");
    expect(() => evaluateRisk({ ...base, currentEquity: 2500 } as unknown as RiskEvaluationInput))
      .toThrowError("RISK_CURRENT_EQUITY_INVALID");
    for (const pendingOpenCount of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => evaluateRisk({ ...base, pendingOpenCount })).toThrowError("RISK_POSITION_COUNT_INVALID");
    }
    expect(() => evaluateRisk({ ...base, symbolAlreadyActive: 0 } as unknown as RiskEvaluationInput))
      .toThrowError("RISK_SYMBOL_ACTIVE_INVALID");
    expect(() => evaluateRisk({ ...base, actorType: "MODEL" } as unknown as RiskEvaluationInput))
      .toThrowError("RISK_ACTOR_TYPE_INVALID");
    expect(() => evaluateRisk({
      ...base,
      profileVersionId: "not-a-uuid",
      ledgerHighWaterId: crypto.randomUUID(),
    })).toThrowError("RISK_PROFILE_VERSION_ID_INVALID");
    expect(() => evaluateRisk({
      ...base,
      profileVersionId: crypto.randomUUID(),
      ledgerHighWaterId: "not-a-uuid",
    })).toThrowError("RISK_LEDGER_HIGH_WATER_ID_INVALID");
  });

  it("snapshots every contract property exactly once before evaluating", () => {
    const reads = new Map<PropertyKey, number>();
    const source: Record<string, unknown> = {
      ...base,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      ledgerHighWaterId: "01989abc-def0-7000-8000-000000000001",
    };
    const input = new Proxy(source, {
      get(target, property) {
        const count = (reads.get(property) ?? 0) + 1;
        reads.set(property, count);
        if (count > 1) throw new Error(`PROPERTY_READ_TWICE:${String(property)}`);
        return Reflect.get(target, property);
      },
    }) as unknown as RiskEvaluationInput;

    expect(evaluateRisk(input)).toMatchObject({ accepted: true });
    expect([...reads.entries()]).toEqual([
      ["actorType", 1],
      ["startingBalance", 1],
      ["currentEquity", 1],
      ["dayStartEquity", 1],
      ["realizedDayLoss", 1],
      ["openLoss", 1],
      ["existingStopRisk", 1],
      ["proposedStopRisk", 1],
      ["existingGrossNotional", 1],
      ["proposedNotional", 1],
      ["pendingOpenCount", 1],
      ["symbolAlreadyActive", 1],
      ["profileVersionId", 1],
      ["ledgerHighWaterId", 1],
    ]);
  });

  it("returns immutable data detached from later input mutation", () => {
    const input: Record<string, unknown> = {
      ...base,
      profileVersionId: INITIAL_PROFILE.profileVersionId,
      ledgerHighWaterId: "01989abc-def0-7000-8000-000000000001",
    };
    const result = evaluateRisk(input as unknown as RiskEvaluationInput);
    input.actorType = "NODE_BRAIN";
    input.profileVersionId = crypto.randomUUID();

    expect(result).toMatchObject({
      accepted: true,
      provenance: { profileVersionId: INITIAL_PROFILE.profileVersionId },
    });
    expect(() => (result.reasons as string[]).push("SYMBOL_DUPLICATE")).toThrow();
  });

  it("is deterministic and makes no clock, random, network, or model calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dateSpy = vi.spyOn(Date, "now");
    const randomSpy = vi.spyOn(Math, "random");
    const first = evaluateRisk(base);
    const second = evaluateRisk(base);
    const source = await readFile("lib/server/challenge/risk.ts", "utf8");

    expect(second).toEqual(first);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dateSpy).not.toHaveBeenCalled();
    expect(randomSpy).not.toHaveBeenCalled();
    expect(source).not.toMatch(/\b(?:fetch|Date\.now|Math\.random)\s*\(/);
    expect(source).not.toMatch(
      /from\s+["'](?:node:(?:http|https|net)|[^"']*\/models(?:\/[^"']*)?)["']/i,
    );
    fetchSpy.mockRestore();
    dateSpy.mockRestore();
    randomSpy.mockRestore();
  });
});
