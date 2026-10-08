import { afterEach, describe, expect, it } from "bun:test";

import { fetchPaneConversation, conversationAnswerBytes } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("conversation polling", () => {
  it("asks with the last ETag and reuses the very same answer on a 304", async () => {
    const sent: (string | null)[] = [];
    let version = "\"v1\"";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const asked = new Headers(init?.headers).get("if-none-match");
      sent.push(asked);
      if (asked === version) return new Response(null, { status: 304, headers: { etag: version } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null, v: version }), { status: 200, headers: { etag: version } });
    }) as typeof fetch;
    const first = await fetchPaneConversation("w1:p1");
    const again = await fetchPaneConversation("w1:p1");
    expect(again).toBe(first);
    version = "\"v2\"";
    const changed = await fetchPaneConversation("w1:p1");
    expect(changed).not.toBe(first);
    expect((changed as unknown as { v: string }).v).toBe("\"v2\"");
    // an older page is asked for once: it never sends or keeps an ETag
    await fetchPaneConversation("w1:p1", "local", { before: "c:10" });
    await fetchPaneConversation("w1:p1", "local", { before: "c:10" });
    expect(sent).toEqual([null, "\"v1\"", "\"v1\"", null, null]);
  });

  it("keeps the polled answer however many older pages are read", async () => {
    const sent: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const asked = new Headers(init?.headers).get("if-none-match");
      sent.push(asked);
      if (asked === "\"v\"") return new Response(null, { status: 304, headers: { etag: "\"v\"" } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"v\"" } });
    }) as typeof fetch;
    const polled = await fetchPaneConversation("w9:p1");
    for (let page = 0; page < 40; page++) await fetchPaneConversation("w9:p1", "local", { before: `c:${page}` });
    // other panes polled in between: the one polled again stays the most recent
    for (let pane = 0; pane < 20; pane++) {
      await fetchPaneConversation(`w8:p${pane}`);
      expect(await fetchPaneConversation("w9:p1")).toBe(polled);
    }
    expect(sent.at(-1)).toBe("\"v\"");
  });

  it("gives up the oldest answers when they outgrow the byte budget, not only when there are too many", async () => {
    const asked = new Map<string, string | null>();
    // ~3 MiB of turns per pane: a third of the cache budget, so four of them do not fit
    const filler = "x".repeat(3 * 1024 * 1024);
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const etag = new Headers(init?.headers).get("if-none-match");
      asked.set(String(url), etag);
      if (etag !== null) return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [{ text: filler }], cursor: null, filler }), { status: 200, headers: { etag: `"${asked.size}"` } });
    }) as typeof fetch;
    for (let pane = 0; pane < 5; pane++) await fetchPaneConversation(`big:p${pane}`);
    asked.clear();
    // the newest panes are still cached, the ones the budget pushed out are not
    await fetchPaneConversation("big:p4");
    expect([...asked.values()]).toEqual([`"5"`]);
    asked.clear();
    await fetchPaneConversation("big:p0");
    expect([...asked.values()]).toEqual([null]);
  });
});

it("counts a compressed answer by its parsed body, not the bytes on the wire", () => {
  const body = { turns: [{ text: "x".repeat(5000) }] } as unknown as Parameters<typeof conversationAnswerBytes>[0];
  expect(conversationAnswerBytes(body, "300")).toBe(300);
  expect(conversationAnswerBytes(body, "300", "identity")).toBe(300);
  expect(conversationAnswerBytes(body, "300", "gzip")).toBe(JSON.stringify(body).length);
});
