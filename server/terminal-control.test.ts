import { describe, expect, it } from "bun:test";
import { decodeTerminalControlLine } from "./terminal-control.ts";

describe("terminal session control frames", () => {
  it("accepts ANSI frames and close records", () => {
    expect(decodeTerminalControlLine(JSON.stringify({
      type: "terminal.frame",
      seq: 7,
      encoding: "ansi",
      width: 80,
      height: 24,
      full: true,
      bytes: Buffer.from("\x1b[2Jhello").toString("base64"),
    }))).toEqual({
      type: "terminal.frame",
      seq: 7,
      encoding: "ansi",
      width: 80,
      height: 24,
      full: true,
      bytes: Buffer.from("\x1b[2Jhello").toString("base64"),
    });
    expect(decodeTerminalControlLine('{"type":"terminal.closed","reason":"detached"}')).toEqual({
      type: "terminal.closed",
      reason: "detached",
    });
  });

  it("ignores malformed and unsupported records", () => {
    expect(decodeTerminalControlLine("not json")).toBeNull();
    expect(decodeTerminalControlLine('{"type":"terminal.frame","encoding":"cells","bytes":"eA=="}')).toBeNull();
    expect(decodeTerminalControlLine('{"type":"other"}')).toBeNull();
  });
});
