import { describe, expect, it } from "bun:test";
import { semanticWheelDeltaLines } from "./terminalHistory.ts";

describe("semantic terminal wheel normalization", () => {
  it("maps a normal Windows pixel wheel notch to about three rows", () => {
    expect(semanticWheelDeltaLines(-120, 0, 40)).toBe(-3);
  });

  it("preserves line deltas and expands page deltas to the terminal height", () => {
    expect(semanticWheelDeltaLines(2, 1, 40)).toBe(2);
    expect(semanticWheelDeltaLines(-1, 2, 36)).toBe(-36);
  });

  it("lets small trackpad deltas accumulate fractionally", () => {
    expect(semanticWheelDeltaLines(8, 0, 40)).toBe(0.2);
  });

});
