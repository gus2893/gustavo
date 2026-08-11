import { describe, expect, it } from "vitest";
import {
  assertBroadcastEditorialPolicy,
  BROADCAST_POLICY_ERROR,
} from "../../lib/server/main-brain/editorial-validator";

describe("Main broadcast editorial validator", () => {
  it.each([
    "Profit is not guaranteed.Outcome is certain.",
    "No outcome is certain.Profit guaranteed.",
    "There is no doubt profit is guaranteed.",
    "Not only is profit guaranteed.",
    "Trade volume increased. Buy AAPL.",
    "Short interest rose; sell AAPL.",
    "Open interest fell while price rose. Hold AAPL.",
    "buy aapl.",
    "sell aapl.",
    "hold aapl.",
    "short aapl.",
    "BuY AaPl.",
    "sElL aApL.",
    "HoLd Aapl.",
    "sHoRt aaPL.",
  ])("rejects independently actionable or certain claims: %s", (body) => {
    expect(() => assertBroadcastEditorialPolicy(body)).toThrow(BROADCAST_POLICY_ERROR);
  });

  it.each([
    "Profit is not guaranteed.",
    "No outcome is certain.",
    "Returns can rise or fall; no result is guaranteed.",
    "Certain stocks rise while others fall.",
    "Trade volume increased after the open.",
    "Short interest increased after earnings.",
    "Open interest rose while price remained range-bound.",
    "The symbols AΔ and ΩMEGA remained near completed support.",
  ])("accepts bounded educational commentary: %s", (body) => {
    expect(() => assertBroadcastEditorialPolicy(body)).not.toThrow();
  });
});
