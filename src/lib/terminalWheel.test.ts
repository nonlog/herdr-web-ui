import { describe, expect, it } from "bun:test";
import { semanticWheelDeltaLines, semanticWheelIntent } from "./terminalWheel.ts";

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

  it("applies the user speed once, rounds to whole rows and caps protocol input", () => {
    expect(semanticWheelIntent(-2.5, 1)).toEqual({ direction: "up", lines: 3 });
    expect(semanticWheelIntent(2.5, 3)).toEqual({ direction: "down", lines: 8 });
    expect(semanticWheelIntent(500, 10)).toEqual({ direction: "down", lines: 1000 });
  });
});
