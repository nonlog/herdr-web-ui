import { describe, expect, it } from "bun:test";

/** A browser's history, as far as this module uses it: a stack, a cursor, and popstate after `go`. */
function fakeWindow() {
  const stack: unknown[] = [null];
  let index = 0;
  const listeners: Array<(event: { state: unknown }) => void> = [];
  const history = {
    get state() { return stack[index]; },
    pushState(state: unknown) { stack.splice(index + 1); stack.push(state); index += 1; },
    replaceState(state: unknown) { stack[index] = state; },
    go(by: number) { index = Math.max(0, Math.min(stack.length - 1, index + by)); queueMicrotask(() => { for (const listener of listeners) listener({ state: stack[index] }); }); },
  };
  const window = { history, addEventListener(type: string, listener: (event: { state: unknown }) => void) { if (type === "popstate") listeners.push(listener); } };
  /** the Settings entries up to the current one, as the module wrote them */
  const held = () => stack.slice(0, index + 1).map((state) => (state as Record<string, unknown> | null)?.["herdr-web-ui:settings"] ?? null);
  return { window, held };
}
const fake = fakeWindow();
(globalThis as unknown as { window: unknown }).window = fake.window;
// after the window: the module listens to it as it loads
const { recordSettings, settingsEntry, settingsLevels } = await import("./settingsHistory.ts");
const settled = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined))); };

describe("settingsLevels", () => {
  it("makes a phone's list a step of its own, under the page and the key bar editor", () => {
    expect(settingsLevels(true, null, false)).toEqual([{ page: null, keyBar: false }]);
    expect(settingsLevels(true, "chat", false)).toEqual([{ page: null, keyBar: false }, { page: "chat", keyBar: false }]);
    expect(settingsLevels(true, "terminal", true)).toEqual([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
  });

  it("opens a wider dialog on its page: one step, and the key bar editor a second", () => {
    expect(settingsLevels(false, "appearance", false)).toEqual([{ page: "appearance", keyBar: false }]);
    expect(settingsLevels(false, "terminal", true)).toEqual([{ page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
  });

  it("has no key bar step without a page under it", () => {
    expect(settingsLevels(true, null, true)).toEqual([{ page: null, keyBar: false }]);
  });
});

describe("settingsEntry", () => {
  const state = (entry: unknown) => ({ "herdr-web-ui:settings": entry });

  it("reads the entry beside whatever else the state holds", () => {
    expect(settingsEntry({ ...state({ page: "chat", keyBar: false, depth: 2 }), "herdr-web-ui:file-preview": { path: "a" } })).toEqual({ page: "chat", keyBar: false, depth: 2 });
    expect(settingsEntry(state({ page: null, keyBar: false, depth: 1 }))).toEqual({ page: null, keyBar: false, depth: 1 });
  });

  it("is null for a state without one, or one it did not write", () => {
    for (const other of [null, undefined, "settings", 1, {}, state(null), state("chat"), state({ page: 3, keyBar: false, depth: 1 }), state({ page: "chat", keyBar: "no", depth: 1 }),
      state({ page: "chat", keyBar: false }), state({ page: "chat", keyBar: false, depth: 0 }), state({ page: "chat", keyBar: false, depth: 1.5 }), state({ page: "chat", keyBar: false, depth: 9 })]) {
      expect(settingsEntry(other)).toBeNull();
    }
  });
});

describe("recordSettings", () => {
  it("rebuilds the earlier steps when the width changes: the list goes under a page a wider dialog opened, and away again", async () => {
    // a wider dialog opened on Terminal: one step
    recordSettings([{ page: "terminal", keyBar: false }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: "terminal", keyBar: false, depth: 1 }]);
    // the window narrows: a phone's list belongs under the page, not a second Terminal over it
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: null, keyBar: false, depth: 1 }, { page: "terminal", keyBar: false, depth: 2 }]);
    // the key bar editor opens on the phone, then the window widens: the list under them goes
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    recordSettings([{ page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: "terminal", keyBar: false, depth: 1 }, { page: "terminal", keyBar: true, depth: 2 }]);
    // closing takes every step off
    recordSettings([]);
    await settled();
    expect(fake.held()).toEqual([null]);
  });

  it("does not take a step it cannot see on trust: entries of an earlier opening a Forward landed on are rebuilt", async () => {
    // entries an earlier opening left (a wider dialog's Terminal and its editor), landed on by Forward
    const key = "herdr-web-ui:settings";
    fake.window.history.pushState({ [key]: { page: "terminal", keyBar: false, depth: 1 } });
    fake.window.history.pushState({ [key]: { page: "terminal", keyBar: true, depth: 2 } });
    // the dialog opens on a phone showing the editor: the list, the page, the editor
    recordSettings([{ page: null, keyBar: false }, { page: "terminal", keyBar: false }, { page: "terminal", keyBar: true }]);
    await settled();
    expect(fake.held()).toEqual([null, { page: null, keyBar: false, depth: 1 }, { page: "terminal", keyBar: false, depth: 2 }, { page: "terminal", keyBar: true, depth: 3 }]);
    recordSettings([]);
    await settled();
    expect(fake.held()).toEqual([null]);
  });
});
