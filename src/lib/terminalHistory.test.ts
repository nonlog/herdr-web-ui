import { describe, expect, it } from "bun:test";
import { TerminalHistoryCache, HISTORY_MAX_LINES, accumulateHistoryWheel, type HistorySnapshot } from "./terminalHistory.ts";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness() {
  const requests: Array<{ pane: string; lines: number; signal: AbortSignal; resolve: (read: HistorySnapshot) => void; reject: (error: Error) => void }> = [];
  const cache = new TerminalHistoryCache((pane, lines, signal) => new Promise<HistorySnapshot>((resolve, reject) => {
    requests.push({ pane, lines, signal, resolve, reject });
  }), () => {});
  return { cache, requests };
}
const read = (text: string, truncated = true): HistorySnapshot => ({ text, truncated });

describe("passive terminal history cache", () => {
  it("prefetches once and serves repeated cached scrolling without further reads", async () => {
    const { cache, requests } = harness();
    cache.reset("a"); cache.refresh(); await flush();
    for (let i = 0; i < 100; i++) cache.ensure(200);
    expect(requests).toHaveLength(1);
    const snapshot = read("\x1b[31mred\x1b[0m\r\n");
    requests[0]!.resolve(snapshot); await flush();
    for (let i = 0; i < 100; i++) cache.ensure(200);
    expect(requests).toHaveLength(1);
    expect(cache.snapshot).toBe(snapshot);
    expect(cache.loading).toBe(false);
    cache.reset(null);
  });

  it("coalesces a larger read behind the one already in flight", async () => {
    const { cache, requests } = harness();
    cache.reset("a"); cache.ensure(512); await flush();
    cache.ensure(900); cache.ensure(1500);
    expect(requests).toHaveLength(1);
    requests[0]!.resolve(read("first")); await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.lines).toBe(1500);
    requests[1]!.resolve(read("expanded")); await flush();
    expect(cache.loadedLines).toBe(1500);
    cache.reset(null);
  });

  it("aborts pane A and ignores its late response even after A is reopened", async () => {
    const { cache, requests } = harness();
    cache.reset("a"); cache.refresh(); await flush();
    cache.reset("b"); cache.refresh(); await flush();
    cache.reset("a"); cache.refresh(); await flush();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests[1]!.signal.aborted).toBe(true);
    requests[0]!.resolve(read("stale-a")); requests[1]!.resolve(read("stale-b")); await flush();
    expect(cache.snapshot).toBeNull();
    expect(cache.loading).toBe(true);
    requests[2]!.resolve(read("new-a")); await flush();
    expect(cache.snapshot?.text).toBe("new-a");
    cache.reset(null);
  });

  it("does not loop on failures and permits an explicit retry", async () => {
    const { cache, requests } = harness();
    cache.reset("a"); cache.refresh(); await flush();
    requests[0]!.reject(new Error("offline")); await flush();
    expect(cache.error).toBe(true); expect(requests).toHaveLength(1);
    cache.ensure(512); await flush();
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(read("recovered")); await flush();
    expect(cache.error).toBe(false);
    cache.reset(null);
  });

  it("does not forget output arriving during a passive read or refresh on every wheel", async () => {
    const { cache, requests } = harness();
    cache.reset("a"); cache.refresh(); await flush();
    cache.invalidate(); requests[0]!.resolve(read("cached")); await flush();
    expect(cache.stale).toBe(true);
    cache.ensure(100); await flush(); expect(requests).toHaveLength(1);
    cache.refresh(); await flush(); expect(requests).toHaveLength(2);
    requests[1]!.resolve(read("latest")); await flush(); expect(cache.stale).toBe(false);
    cache.reset(null);
  });

  it("bounds expansions and stops at the start of retained history", async () => {
    const { cache, requests } = harness();
    cache.reset("a"); cache.ensure(1_000_000); await flush();
    expect(requests[0]!.lines).toBe(HISTORY_MAX_LINES);
    requests[0]!.resolve(read("all history", false)); await flush();
    cache.ensure(1_000_000); await flush(); expect(requests).toHaveLength(1);
    cache.reset(null);
  });
});

it("accumulates small touch/trackpad movements instead of accelerating each event", () => {
  let remainder = 0; let lines = 0;
  for (let i = 0; i < 16; i++) {
    const next = accumulateHistoryWheel(remainder, -0.1, 1);
    lines += next.lines; remainder = next.remainder;
  }
  expect(lines).toBe(-1);
  expect(remainder).toBeCloseTo(-0.6);
  expect(accumulateHistoryWheel(remainder, NaN, 1)).toEqual({ lines: 0, remainder });
});
