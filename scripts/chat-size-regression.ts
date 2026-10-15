import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Machine } from "../shared/machines.ts";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { PtySession } from "../server/pty/session.ts";
import { herdrRpc, herdrSocketPath, type WorkspaceCreateResult, paneRead, paneSendKeys, paneSendText, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

/** how long a resize that should not happen gets to show up */
const NO_RESIZE_WAIT_MS = 400;

type Frame = { dir: "in" | "out"; type: string; keep_size?: boolean; pane_id?: string; cols?: number; rows?: number };
const framesOf = (page: Page) => page.evaluate(() => (window as unknown as { frames_: Frame[] }).frames_);

/**
 * Installs the page clock and pauses it. The pause time is read from the page, plus a margin for the
 * round trip: the installed clock follows the page's real time, which can already be past a time
 * taken here, and pausing at a past time throws (#766).
 */
async function pauseClock(page: Page): Promise<void> {
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
}

async function stopHolder(holder: PtySession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("attach holder did not exit")), 10_000);
  });
  try {
    holder.kill();
    await Promise.race([holder.exited, deadline]);
  } finally { clearTimeout(timer); }
}

/**
 * The size the pane's own shell reports (`stty size`), not what a browser thinks. With `dir` the
 * answer goes to a file there instead of the screen: a resize that lands meanwhile reflows the
 * screen, and a read of it can lose the line.
 */
function shellSize(paneId: string, dir?: string): () => Promise<string> {
  let asked = 0;
  return async () => {
    const marker = `size-${++asked}`;
    const deadline = Date.now() + 10_000;
    if (dir !== undefined) {
      const file = join(dir, `${marker}.txt`);
      await paneSendText(paneId, `stty size > ${file}`);
      await paneSendKeys(paneId, ["Enter"]);
      while (Date.now() < deadline) {
        const answer = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
        if (/^\d+ \d+$/.test(answer)) return answer;
        await Bun.sleep(100);
      }
      throw new Error(`no ${marker} answer from the pane's shell`);
    }
    // the answer is bracketed and matched anywhere: a prompt and command that fill the row exactly
    // leave it on the same line of the read, and the command's own "$(stty size)" is no answer
    await paneSendText(paneId, `echo "<${marker}:$(stty size)>"`);
    await paneSendKeys(paneId, ["Enter"]);
    let text = "";
    while (Date.now() < deadline) {
      text = (await paneRead({ paneId, source: "recent", lines: 80, stripAnsi: true })).text;
      const found = [...text.matchAll(new RegExp(`<${marker}:(\\d+ \\d+)>`, "g"))].at(-1);
      if (found) return found[1]!;
      await Bun.sleep(100);
    }
    throw new Error(`no ${marker} answer from the pane; it reads:\n${text.slice(-1200)}`);
  };
}

/** A page on `paneId` that records every frame its socket sends and receives (`frames_`), its socket in `socket_`. */
async function openRecording(browser: Browser, contexts: BrowserContext[], origin: string, paneId: string, options: Parameters<Browser["newContext"]>[0], settings: object, away = false, setup?: (page: Page) => Promise<void>): Promise<Page> {
  const context = await browser.newContext({ locale: "en-US", ...options });
  contexts.push(context);
  await context.addInitScript((stored) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify(stored));
    // every frame this page's socket sends and receives, to wait on the server's answers
    const frames: { dir: "in" | "out"; type: string; keep_size?: boolean; pane_id?: string; cols?: number; rows?: number }[] = [];
    (window as unknown as { frames_: typeof frames }).frames_ = frames;
    const Native = window.WebSocket;
    class Recording extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as unknown as { socket_: WebSocket }).socket_ = this;
        frames.push({ dir: "in", type: "socket-opened" });
        this.addEventListener("message", (event) => { try { frames.push({ dir: "in", type: JSON.parse(String(event.data)).type }); } catch {} });
        // Navigation releases a pane with detach while the PC connection retains receipts.
        // Physical closes remain separate evidence for the explicit reconnect scenarios.
        this.addEventListener("close", () => frames.push({ dir: "in", type: "socket-closed" }));
      }
      override send(data: string): void { try { const frame = JSON.parse(data); frames.push({ dir: "out", type: frame.type, keep_size: frame.keep_size, ...(frame.type === "detach" ? { pane_id: frame.pane_id } : {}), ...(frame.type === "resize" ? { cols: frame.cols, rows: frame.rows } : {}) }); } catch {} super.send(data); }
    }
    Object.assign(window, { WebSocket: Recording });
  }, settings);
  if (away) await context.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
  });
  const page = await context.newPage();
  await setup?.(page);
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor();
  return page;
}

/**
 * The roster pages are handed names the pane's agent. A page opened before that takes the pane for
 * a shell: with chat as its lens for every pane it still opens the terminal there, and attaching in
 * the terminal lens fits the shared grid to that page, which is what these checks say does not happen.
 */
async function agentListed(origin: string, paneId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const roster = await (await fetch(`${origin}/api/machines`)).json() as { machines: Machine[] };
    if (roster.machines.some((machine) => machine.snapshot?.panes.some((pane) => pane.pane_id === paneId && pane.agent === "claude"))) return;
    await Bun.sleep(50);
  }
  throw new Error(`the roster never named the agent in ${paneId}`);
}

// the server answers an attach with input-ready, and resizes in the same step: once the
// `nth` one is in, that attach has done whatever it does to the grid
const attached = (page: Page, nth = 1) => page.waitForFunction((count) => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.filter((f) => f.dir === "in" && f.type === "input-ready").length >= count, nth, { timeout: 15_000 });

/**
 * The chat lens leaves the shared terminal's size alone (#361): a desktop tab drives a pane's grid
 * from its terminal lens, a phone opens the same pane in the chat lens, and the program in the pane
 * still sees the desktop's size. Switching the phone to its terminal lens must not reflow the
 * shared pane either: it adopts the existing desktop grid and scrolls history independently.
 * The size is the one the pane's own shell reports (`stty size`), not what either browser thinks.
 */
export async function checkChatKeepsTerminalSize(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-size-"));
  const cwd = join(root, "pane");
  mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-chat-size" });
  const paneId = created.root_pane.pane_id;
  const contexts: BrowserContext[] = [];
  try {
    // an agent pane opens in the chat lens on a phone; the shell under it answers `stty size`
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" });
    await agentListed(origin, paneId);
    // This scenario resizes the pty while probing it. Read each shell answer from a file:
    // reflow can erase a completed answer from pane.read's screen snapshot.
    const size = shellSize(paneId, cwd);
    const open = (options: Parameters<Browser["newContext"]>[0], settings: object) => openRecording(browser, contexts, origin, paneId, options, settings);
    const sent = (page: Page) => page.evaluate(() => (window as unknown as { frames_: { dir: string; type: string; keep_size?: boolean }[] }).frames_.filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize")));

    const desktop = await open({ viewport: { width: 1280, height: 800 } }, { language: "en", defaultView: "terminal" });
    await attached(desktop);
    const desktopSize = await size();

    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { language: "en", defaultView: "chat" });
    await phone.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await attached(phone);
    // the chat lens attaches without driving the grid, and sends no resize of its own
    assert.deepEqual(await sent(phone), [{ dir: "out", type: "attach", keep_size: true }]);
    assert.equal(await size(), desktopSize, "the phone's chat lens leaves the desktop's grid");
    if (process.env.UI_EVIDENCE_DIR) await desktop.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "chat-size-desktop.png") });
    console.log(`PASS a phone's chat lens leaves the shared grid at the desktop's ${desktopSize}`);

    // Terminal and chat lenses now both preserve the native grid on a touch device.
    // On a phone the lens switch shows no label: the button is known by its title.
    await phone.locator('button[title^="Live terminal"]').tap();
    await phone.locator(".terminal-stack:not(.is-chat)").waitFor({ state: "attached" });
    await phone.locator(".pane-terminal[data-adopted-grid]").waitFor({ state: "attached" });
    // fixed wait: reject a delayed native resize after the phone observer settles.
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual(await sent(phone), [{ dir: "out", type: "attach", keep_size: true }], "the phone's terminal lens does not send resize");
    assert.equal(await size(), desktopSize, "the phone's terminal lens preserves the desktop grid");
    console.log(`PASS both phone lenses leave the shared grid at ${desktopSize}`);

    // A visible but unfocused desktop must not release its native grid simply
    // because the phone was brought to the foreground.
    const blurMark = (await framesOf(desktop)).length;
    await phone.bringToFront();
    await desktop.evaluate(() => {
      if (document.visibilityState !== "visible") throw new Error("desktop must remain visible");
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new Event("blur"));
    });
    assert.equal((await framesOf(desktop)).slice(blurMark)
      .filter((frame) => frame.dir === "out" && frame.type === "release-size").length, 0,
      "a visible unfocused desktop does not release its native grid");

    // The desktop still owns its normal terminal grid; switching to chat must adopt the same
    // grid without resizing it. xterm's DOM renderer keeps one element per row.
    const hiddenRows = () => desktop.locator(".pane-terminal .xterm-rows > div").count();
    const desktopRows = Number(desktopSize.split(" ")[0]);
    assert.equal(await hiddenRows(), desktopRows, "the desktop's terminal grid remains intact");
    await desktop.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await desktop.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    const adopted = Date.now() + 10_000;
    while (await hiddenRows() !== desktopRows && Date.now() < adopted) await Bun.sleep(100);
    assert.equal(await hiddenRows(), desktopRows, "the desktop's chat lens keeps the shared row count");
    assert.equal(await size(), desktopSize, "entering the desktop chat lens resizes nothing");
    console.log(`PASS the desktop's chat lens preserves the native grid of ${desktopSize}`);
  } finally {
    for (const context of contexts) await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Picking a pane whose lens is chat, from a pane whose lens is the terminal, leaves the shared
 * terminal's size alone too: the lens is the picked pane's by the time its terminal attaches.
 * A desktop drives an agent pane's grid; a smaller window sits on a shell pane (terminal lens)
 * and picks the agent pane (chat lens there) from the sidebar.
 */
export async function checkPaneSwitchKeepsTerminalSize(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-switch-"));
  const contexts: BrowserContext[] = [];
  const workspaces: string[] = [];
  try {
    const panes: string[] = [];
    for (const name of ["agent", "shell"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-chat-switch-${name}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [agentPane, shellPane] = panes as [string, string];
    await herdrRpc("pane.report_agent", { pane_id: agentPane, source: "manual", agent: "claude", state: "idle" });
    await agentListed(origin, agentPane);
    const size = shellSize(agentPane);

    const desktop = await openRecording(browser, contexts, origin, agentPane, { viewport: { width: 1280, height: 800 } }, { language: "en", defaultView: "terminal" });
    await attached(desktop);
    const desktopSize = await size();

    // with chat as the lens for every pane, a shell still opens in the terminal: it has no conversation
    const other = await openRecording(browser, contexts, origin, shellPane, { viewport: { width: 900, height: 600 } }, { language: "en", defaultView: "chat" });
    await other.locator(".terminal-stack:not(.is-chat)").waitFor({ state: "attached" });
    await attached(other);
    const before = (await framesOf(other)).length;
    await other.locator(`.pane-select[title^="${agentPane} — "]`).click();
    await other.locator(".terminal-stack.is-chat").waitFor({ state: "attached" });
    await attached(other, 2);
    // a resize that should not happen gets this long to show up: the grid's ResizeObserver waits 120 ms
    // fixed wait: assert that no delayed reattachment changes the shared grid.
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    const sent = (await framesOf(other)).slice(before).filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize"));
    assert.deepEqual(sent, [{ dir: "out", type: "attach", keep_size: true }],
      "the picked pane attaches exactly once, adopting the shared grid without resizing it");
    assert.equal(await size(), desktopSize, "picking a chat-lens pane leaves the desktop's grid");
    console.log(`PASS picking a chat-lens pane from a terminal-lens pane leaves the shared grid at ${desktopSize}`);
  } finally {
    for (const context of contexts) await context.close();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Whether this bridge holds herdr's attach on the terminal: herdr gives a pane back to its own TUI only once none does. */
function attachRunning(terminalId: string): boolean {
  return Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString().split("\n").some((line) => line.includes(`terminal attach ${terminalId}`));
}

/**
 * A tab the user is not in leaves the shared terminal's size alone, and lets go of the pane. A
 * desktop window left open behind another app (herdr's own TUI in a terminal) turned visible when
 * the screen woke, or reconnected, reloaded or moved on to the next pane in the background, and
 * fitted the pane to itself. And for as long as the bridge's attach stayed, herdr held the pane at
 * that window's size: its TUI drew the pane cut off at its split's edge, the bottom rows out of
 * reach. Out of use, the window detaches, the attach ends with the pane's last client, and herdr
 * gives the pane back to its TUI. The window attaches again, at its own size, when it takes the
 * focus.
 */
export async function checkBackgroundTabKeepsTerminalSize(browser: Browser, origin: string): Promise<void> {
  await checkInactiveAttachLifecycle(browser, origin);
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-background-size-"));
  const contexts: BrowserContext[] = [];
  const workspaces: string[] = [];
  try {
    const cwd = join(root, "pane");
    mkdirSync(cwd);
    const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-background-size" });
    workspaces.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const terminalId = created.root_pane.terminal_id;
    // the pane the app moves on to once the first one closes: herdr's focused one
    const nextCwd = join(root, "next");
    mkdirSync(nextCwd);
    const next = await herdrRpc<WorkspaceCreateResult>("workspace.create", { cwd: nextCwd, label: "herdr-web-ui-test-background-size-next", focus: true });
    workspaces.push(next.workspace.workspace_id);
    const nextPane = next.root_pane.pane_id;
    const size = shellSize(paneId);
    const nextSize = shellSize(nextPane);
    // the pause in another window is a setting this check turns on; the first window below keeps the default
    const open = (options: Parameters<Browser["newContext"]>[0], settings: object = {}) => openRecording(browser, contexts, origin, paneId, options, { language: "en", defaultView: "terminal", releasePaneAway: true, ...settings });
    // what the page sent that sizes the grid: attaches and resizes
    const sizing = async (page: Page) => (await framesOf(page)).filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize"));
    // a window that let go of its pane still shows it, read-only, through the server's watch
    const viewOnly = (page: Page) => page.locator(".terminal-banner", { hasText: "View only while you use another window" });
    const watchFrames = async (page: Page) => (await framesOf(page)).filter((f) => f.dir === "in" && f.type === "watch-data").length;

    // by default a window out of use keeps its pane: no detach, no paused banner, and the pane's output still arrives
    const keeping = await openRecording(browser, contexts, origin, paneId, { viewport: { width: 1280, height: 800 } }, { language: "en", defaultView: "terminal" });
    await attached(keeping);
    // freeze timers after the real attach; only the release delay is advanced below
    await pauseClock(keeping);
    await keeping.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      window.dispatchEvent(new Event("blur"));
    });
    // past the moment a window that pauses lets go of its pane
    await keeping.clock.runFor(2_000);
    assert.ok(!(await framesOf(keeping)).some((f) => f.dir === "out" && f.type === "detach"), "a window out of use keeps its pane by default");
    assert.equal(await viewOnly(keeping).count(), 0, "a window out of use is not view only by default");
    await keeping.clock.resume();
    const outputCount = async () => (await framesOf(keeping)).filter((f) => f.dir === "in" && f.type === "pty-data").length;
    const output = await outputCount();
    await size();
    const arrives = Date.now() + 10_000;
    while (await outputCount() <= output && Date.now() < arrives) await Bun.sleep(100);
    assert.ok(await outputCount() > output, "a window out of use still gets the pane's output by default");
    await keeping.context().close();
    console.log("PASS by default a desktop window out of use keeps its pane and its output");

    // a phone put away lets go of the pane at once, with the default settings and no timer run:
    // its page can freeze before one does, and its attach would keep herdr's window at its size
    const pocket = await openRecording(browser, contexts, origin, paneId, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { language: "en", defaultView: "terminal" });
    await attached(pocket);
    await pauseClock(pocket);
    const pocketVisibility = (hidden: boolean) => pocket.evaluate((hide) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hide ? "hidden" : "visible" });
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => !hide });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
    await pocketVisibility(true);
    const pocketFrames = async () => (await framesOf(pocket)).filter((f) => f.dir === "out");
    assert.ok((await pocketFrames()).some((f) => f.type === "detach"), "a hidden phone detaches before any timer runs");
    assert.ok((await pocketFrames()).some((f) => f.type === "watch"), "a hidden phone watches the pane it let go of");
    const pocketAttaches = (await pocketFrames()).filter((f) => f.type === "attach").length;
    await pocketVisibility(false);
    await pocket.clock.resume();
    await pocket.waitForFunction((count) => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.filter((f) => f.dir === "out" && f.type === "attach").length > count, pocketAttaches, { timeout: 10_000 });
    await pocket.context().close();
    console.log("PASS a phone put away lets go of the pane at once and attaches again when it is back");

    // a font the user chose loads after every attach and refits the grid: one no device has falls
    // back to the built-in fonts, so the grid keeps its size
    const desktop = await open({ viewport: { width: 1280, height: 800 } }, { terminalFontFamily: "herdr-web-ui-test-no-such-font" });
    await attached(desktop);
    const desktopSize = await size();
    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await attached(phone);
    // The fork's mobile terminal is always a keep-size observer: the desktop
    // owns this Unix PTY, and phone viewport/font changes never resize it.
    const phoneSize = await size();
    assert.equal(phoneSize, desktopSize, "the phone's terminal lens adopts the existing grid without resizing");

    // the desktop's window turns visible behind another app: shown, without the focus
    const shown = (await sizing(desktop)).length;
    await desktop.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // fixed wait: absence of resize must survive the native 120 ms observer debounce.
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual((await sizing(desktop)).slice(shown), [], "a window shown without the focus sends no resize");
    assert.equal(await size(), phoneSize, "a window shown without the focus leaves the phone's grid");
    console.log(`PASS a desktop window shown without the focus leaves the shared grid at the phone's ${phoneSize}`);

    // a moment later it lets go of the pane and watches it instead, and says so; the phone keeps it
    await desktop.waitForFunction(() => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.some((f) => f.dir === "out" && f.type === "detach"), undefined, { timeout: 10_000 });
    await viewOnly(desktop).waitFor({ timeout: 10_000 });
    assert.ok((await framesOf(desktop)).some((f) => f.dir === "out" && f.type === "watch"), "the window watches the pane it let go of");
    assert.equal(await size(), phoneSize, "the window letting go leaves the phone's grid");
    console.log("PASS a desktop window out of use lets go of the pane, watches it, and says it is view only");

    // it reconnects in the background: a pane it let go of is not attached again
    const reconnecting = (await sizing(desktop)).length;
    const snapshots = (await framesOf(desktop)).filter((f) => f.dir === "in" && f.type === "snapshot").length;
    await desktop.evaluate(() => (window as unknown as { socket_: WebSocket }).socket_.close());
    await desktop.waitForFunction((count) => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.filter((f) => f.dir === "in" && f.type === "snapshot").length > count, snapshots, { timeout: 15_000 });
    // fixed wait: a background reconnect must remain non-sizing through its settle window.
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual((await sizing(desktop)).slice(reconnecting), [], "a background reconnect attaches nothing");
    assert.equal(await size(), phoneSize, "a background reconnect leaves the phone's grid");
    console.log("PASS a desktop window reconnecting in the background does not take the pane again");

    // Even a safe join is watched: the client cannot know whether the phone's attach still exists.
    await desktop.context().addInitScript(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }));
    await desktop.reload();
    await desktop.locator(".conn-live").waitFor();
    await viewOnly(desktop).waitFor({ timeout: 10_000 });
    assert.deepEqual(await sizing(desktop), [], "a background reload watches without attaching");
    assert.equal(await size(), phoneSize, "a background reload leaves the phone's grid");
    console.log("PASS a desktop window reloading in the background watches without joining the shared attach");

    // the phone leaves too: no tab uses the pane, and the bridge lets go of herdr's attach,
    // which is what gives the pane back to herdr's own TUI
    assert.ok(attachRunning(terminalId), "the phone still holds the attach");
    await phone.context().close();
    const gone = Date.now() + 10_000;
    while (attachRunning(terminalId) && Date.now() < gone) await Bun.sleep(100);
    assert.ok(!attachRunning(terminalId), "no tab in use holds herdr's attach on the pane");
    console.log("PASS with no tab in use, the bridge holds no attach on the pane");

    // the window it let go of still shows the pane: its output arrives through the watch, with no attach
    const watched = await watchFrames(desktop);
    await size();
    const shows = Date.now() + 10_000;
    while (await watchFrames(desktop) <= watched && Date.now() < shows) await Bun.sleep(100);
    assert.ok(await watchFrames(desktop) > watched, "the watched pane's output reaches the window");
    assert.ok(!attachRunning(terminalId), "watching holds no attach on the pane");
    console.log("PASS a window out of use keeps showing the pane's output with no attach on it");

    // the pane closes in herdr and the window moves on to the focused one in the background: having
    // let go, it attaches nothing until the user is back, and that pane keeps the size it has
    await paneSendText(nextPane, "stty cols 132 rows 38");
    await paneSendKeys(nextPane, ["Enter"]);
    const nextBefore = await nextSize();
    assert.equal(nextBefore, "38 132");
    assert.notEqual(nextBefore, desktopSize, "the next pane starts at a size the window would change");
    const switching = (await sizing(desktop)).length;
    const watchesBeforeSwitch = (await framesOf(desktop)).filter((frame) => frame.dir === "out" && frame.type === "watch").length;
    await workspaceClose(created.workspace.workspace_id);
    await desktop.locator(`.terminal-stack[data-pane-owner="${nextPane}"]`).waitFor({ state: "attached", timeout: 15_000 });
    // fixed wait: watch for a forbidden resize after the pane switch debounce.
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.deepEqual((await sizing(desktop)).slice(switching), [], "a background move to the next pane attaches nothing");
    assert.equal(await nextSize(), nextBefore, "a background move to the next pane leaves its grid");
    assert.equal(await viewOnly(desktop).count(), 1, "the window on the next pane is still view only");
    assert.ok((await framesOf(desktop)).filter((frame) => frame.dir === "out" && frame.type === "watch").length > watchesBeforeSwitch,
      "the replacement keyed terminal starts a watch without acquiring an attach");
    console.log(`PASS a desktop window moving on to the next pane in the background leaves its grid at ${nextBefore}`);

    // the user comes back to it: the window takes the focus, attaches, and takes the grid
    const returning = (await sizing(desktop)).length;
    await desktop.evaluate(() => {
      delete (document as unknown as { hasFocus?: unknown }).hasFocus;
      window.dispatchEvent(new Event("focus"));
    });
    await attached(desktop);
    assert.deepEqual((await sizing(desktop)).slice(returning).map((f) => ({ type: f.type, keep_size: f.keep_size ?? false })), [{ type: "attach", keep_size: false }], "the focused window attaches at its own size");
    const back = Date.now() + 10_000;
    let current = nextBefore;
    while (current !== desktopSize && Date.now() < back) current = await nextSize();
    assert.equal(current, desktopSize, "the focused window fits the grid to itself again");
    assert.equal(await viewOnly(desktop).count(), 0, "the window back in use is not view only");
    console.log(`PASS the desktop window attaches again at ${desktopSize} when it takes the focus`);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Drive the real component and assert the attach/resize frames, not the paused notice alone. */
export async function checkInactiveAttachLifecycle(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-inactive-"));
  const contexts: BrowserContext[] = [];
  const workspaces: string[] = [];
  const failures: string[] = [];
  try {
    const panes: string[] = [];
    const tabs = new Map<string, string>();
    const terminals = new Map<string, string>();
    let heldTerminal: string | null = null;
    for (const name of ["first", "next", "held"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `herdr-web-ui-test-inactive-${name}` });
      panes.push(created.root_pane.pane_id);
      terminals.set(created.root_pane.pane_id, created.root_pane.terminal_id);
      tabs.set(created.root_pane.pane_id, created.root_pane.tab_id);
      if (name === "held") heldTerminal = created.root_pane.terminal_id;
      workspaces.push(created.workspace.workspace_id);
    }
    const first = panes[0]!;
    const next = panes[1]!;
    const waitDetach = (page: Page, count = 1) => page.waitForFunction((n) =>
      (window as unknown as { frames_: Frame[] }).frames_.filter((f) => f.dir === "out" && f.type === "detach").length >= n,
    count, { timeout: 10_000 });
    const waitPaneDetach = (page: Page, paneId: string) => page.waitForFunction((pane) =>
      (window as unknown as { frames_: Frame[] }).frames_.some((frame) => frame.dir === "out" && frame.type === "detach" && frame.pane_id === pane),
    paneId, { timeout: 10_000 });
    const detachedPanes = (frames: Frame[]): Array<string | undefined> => frames.filter((frame) => frame.dir === "out" && frame.type === "detach").map((frame) => frame.pane_id);
    const assertSharedConnection = async (page: Page): Promise<void> => {
      const frames = await framesOf(page);
      assert.equal(frames.filter((frame) => frame.type === "socket-opened").length, 1, "pane navigation reuses the PC connection");
      assert.equal(frames.filter((frame) => frame.type === "socket-closed").length, 0, "the receipt-owning connection stays open");
      assert.equal(await page.evaluate(() => (window as unknown as { socket_: WebSocket }).socket_.readyState === WebSocket.OPEN), true);
    };
    const sent = async (page: Page, start = 0) => (await framesOf(page)).slice(start)
      .filter((f) => f.dir === "out" && (f.type === "attach" || f.type === "resize"));
    const scenarios = ["mount", "mount-optin", "hidden-mount", "legacy-mount", "mirrored-mount", "reconnect", "hidden-reconnect", "legacy-reconnect", "key-resume", "switch", "background-cache", "mirrored-cache", "resume", "toggles", "held", "queue-switch", "queue-inflight", "writes", "embedded"] as const;
    assert.ok(!process.env.CHAT_SIZE_CASE || scenarios.some((scenario) => scenario === process.env.CHAT_SIZE_CASE), "unknown CHAT_SIZE_CASE");
    for (const scenario of scenarios) {
      if (process.env.CHAT_SIZE_CASE && process.env.CHAT_SIZE_CASE !== scenario) continue;
      if (scenario === "embedded") continue;
      let holder: PtySession | undefined;
      let page: Page | undefined;
      const heldPane = panes[2]!;
      try {
        const queueScenario = scenario.startsWith("queue-");
        const fresh = ["mount", "mount-optin", "hidden-mount", "legacy-mount", "mirrored-mount", "key-resume"].includes(scenario);
        const reconnect = scenario.endsWith("reconnect");
        const legacy = scenario.startsWith("legacy-");
        const watchFirst = fresh && !legacy && scenario !== "mirrored-mount";
        const firstTerminal = terminals.get(first)!;
        if (watchFirst) {
          // A deliberately non-layout size exposes #902: a keep_size sidecar spawn would replace it.
          await paneSendText(first, "stty cols 140 rows 40");
          await paneSendKeys(first, ["Enter"]);
          assert.equal(await shellSize(first)(), "40 140");
        }
        if (queueScenario) {
          await herdrRpc("pane.report_agent", { pane_id: first, source: "manual", agent: "claude", state: "working" });
          await agentListed(origin, first);
        }
        let releaseSubmit: (() => void) | undefined;
        let acceptedQueue = false;
        let holdOutput = false;
        let injectOutput: (() => void) | undefined;
        const heldOutput: Array<() => void> = [];
        const wire: Frame[] = [];
        const listeners = new Set<() => void>();
        const record = (raw: string | Buffer, dir: "in" | "out"): void => {
          const frame = JSON.parse(String(raw));
          wire.push({ dir, type: frame.type, ...(dir === "out" ? { keep_size: frame.keep_size } : {}), ...(frame.type === "detach" ? { pane_id: frame.pane_id } : {}) });
          for (const listener of listeners) listener();
        };
        const waitWire = (dir: "in" | "out", type: string, count = 1): Promise<void> => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`no ${count} ${dir} ${type} frames`)); }, 15_000);
          const check = (): void => {
            if (wire.filter((frame) => frame.dir === dir && frame.type === type).length < count) return;
            clearTimeout(timeout); listeners.delete(check); resolve();
          };
          listeners.add(check); check();
        });
        const routed = queueScenario || scenario === "writes" || scenario === "background-cache" || scenario === "mirrored-cache" || legacy;
        const recorded = async (): Promise<Frame[]> => {
          if (routed) return [...wire];
          assert.ok(page);
          return framesOf(page);
        };
        const setup = async (recording: Page): Promise<void> => {
          if (scenario === "hidden-mount") await recording.route("**/api/machines", async (route) => {
            const response = await route.fetch();
            // App deliberately does not load while hidden. Hide after loading starts, but before
            // the roster response can mount a pane; hasFocus alone must not permit an attach.
            await recording.evaluate(() => {
              Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
            });
            await route.fulfill({ response });
          });
          if (scenario === "mirrored-mount") await recording.route("**/api/machines", async (route) => {
            const response = await route.fetch();
            const roster: { machines: Machine[] } = await response.json();
            for (const machine of roster.machines) if (machine.herdr) {
              machine.herdr.terminal_attach = false;
              machine.herdr.terminal_mirror = true;
            }
            await route.fulfill({ response, json: roster });
          });
          if (scenario === "mirrored-mount") await recording.route("**/api/health", async (route) => {
            const response = await route.fetch();
            const health = await response.json();
            health.herdr.terminal_attach = false;
            health.herdr.terminal_mirror = true;
            // The roster mounts the pane before health tells the client that it is mirrored.
            await recording.locator(`.terminal-stack[data-pane-owner="${first}"]`).waitFor();
            await route.fulfill({ response, json: health });
          });
          if (!routed) return;
          await recording.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
            injectOutput = () => {
              for (const data of ["\x1b[2J\x1b[H", "STALE-SUBSCRIPTION"]) {
                socket.send(JSON.stringify({ type: "pty-data", pane_id: first, data }));
              }
            };
            const upstream = socket.connectToServer();
            upstream.onMessage((raw) => {
              const frame = JSON.parse(String(raw));
              if (legacy && frame.type === "snapshot") {
                frame.features = frame.features.filter((feature: string) => feature !== "watch");
                raw = JSON.stringify(frame);
              }
              if (frame.type === "submit-result") acceptedQueue = Boolean(frame.ok && frame.pending);
              record(raw, "in");
              if (scenario === "mirrored-cache" && frame.type === "input-ready" && frame.pane_id === first) {
                const geometry = JSON.stringify({ type: "pane-geometry", pane_id: first, cols: 80, rows: 24, fixed: true });
                record(geometry, "in");
                socket.send(geometry);
              }
              if (holdOutput && frame.type === "pty-data") heldOutput.push(() => socket.send(raw));
              else socket.send(raw);
            });
            socket.onMessage((raw) => {
              const frame = JSON.parse(String(raw));
              record(raw, "out");
              if (queueScenario && frame.type === "submit" && frame.delivery === "queue") {
                if (scenario === "queue-switch") {
                  // The component receives the real pending protocol; backend queue behavior has contract tests.
                  const receipt = JSON.stringify({ type: "submit-result", id: frame.id, pane_id: first, ok: true,
                    pending: { id: "lifecycle-queue", request_id: frame.id, text: frame.text, state: "queued", created_at: new Date().toISOString() } });
                  record(receipt, "in"); socket.send(receipt);
                } else releaseSubmit = () => upstream.send(raw); // validation/acceptance still runs on the real server
              } else upstream.send(raw);
            });
          });
        };
        if (scenario === "held") {
          assert.ok(heldTerminal);
          const ready = Promise.withResolvers<void>();
          const deadline = setTimeout(() => ready.reject(new Error("holder produced no attach stream")), 15_000);
          holder = new PtySession({
            command: process.env.HERDR_WEB_HERDR_BIN ?? "herdr", args: ["terminal", "attach", heldTerminal],
            cols: 80, rows: 24, env: { HERDR_SOCKET_PATH: herdrSocketPath() },
            onData: () => ready.resolve(), onExit: () => ready.reject(new Error("holder ended before the test")),
          });
          try { await ready.promise; } finally { clearTimeout(deadline); }
        }
        page = await openRecording(browser, contexts, origin, scenario === "held" ? heldPane : first,
          { viewport: { width: 1000, height: 700 } }, { language: "en", defaultView: queueScenario ? "chat" : "terminal",
            releasePaneAway: scenario === "mount-optin" || (!fresh && !reconnect && scenario !== "switch") },
          fresh, setup);
        if (scenario === "held") {
          await page.getByText("Another app has this pane open.", { exact: false }).waitFor();
          await pauseClock(page);
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
            window.dispatchEvent(new Event("blur"));
          });
          await page.clock.runFor(1000);
          await waitDetach(page);
          await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
          assert.ok(holder);
          await stopHolder(holder);
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
            window.dispatchEvent(new Event("focus"));
          });
          await attached(page);
          assert.equal((await framesOf(page)).filter((f) => f.dir === "in" && f.type === "attach-resumed").length, 0,
            "the fresh attach succeeds without a held retry");
          assert.equal(await page.getByText("Another app has this pane open.", { exact: false }).count(), 0,
            "a fresh resume must clear the previous attach's held state");
          await page.clock.resume();
          await page.locator(".xterm-helper-textarea").focus();
          await page.keyboard.type("z");
          await page.waitForFunction(() => (window as unknown as { frames_: Frame[] }).frames_
            .some((f) => f.dir === "out" && f.type === "input"), undefined, { timeout: 10_000 });
          console.log("PASS inactive attach lifecycle: held");
          continue;
        }
        if (watchFirst) {
          await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
          await page.waitForFunction(() => (window as unknown as { frames_: Frame[] }).frames_.some((frame) => frame.type === "watch-data"));
          assert.deepEqual(await sent(page), [], "an out-of-use mount watches without ever acquiring an attach");
          assert.equal(attachRunning(firstTerminal), false, "watching must not start a sidecar");
          assert.equal(await shellSize(first)(), "40 140", "watching preserves the real size, not the layout rectangle");
          if (scenario === "key-resume") {
            await page.locator(".xterm-helper-textarea").dispatchEvent("keydown", { key: "Shift", code: "ShiftLeft", bubbles: true });
            await attached(page);
          } else {
            // Reload while still away, including when hidden but hasFocus() returns true.
            await page.reload();
            await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
            await page.waitForFunction(() => (window as unknown as { frames_: Frame[] }).frames_.some((frame) => frame.type === "watch-data"));
            assert.deepEqual(await sent(page), [], "a background reload never acquires an attach");
            assert.equal(await shellSize(first)(), "40 140");
            await page.evaluate(() => {
              Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
              window.dispatchEvent(new Event("focus"));
            });
            await attached(page);
          }
          assert.equal((await sent(page)).filter((frame) => frame.type === "attach").length, 1, "user activity acquires one attach");
          console.log(`PASS inactive attach lifecycle: ${scenario}`);
          continue;
        }
        await (routed ? waitWire("in", "input-ready") : attached(page));
        if (fresh) {
          assert.deepEqual(await sent(page), [{ dir: "out", type: "attach", keep_size: true }], "legacy and mirrored servers keep their initial attach");
          assert.equal((await recorded()).filter((frame) => frame.dir === "out" && frame.type === "watch").length, 0);
          console.log(`PASS inactive attach lifecycle: ${scenario}`);
          continue;
        }
        if (reconnect) {
          // Keep the ordinary attach with the setting off, then lose the connection while away.
          await page.evaluate((hidden) => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
            window.dispatchEvent(new Event("blur"));
          }, scenario === "hidden-reconnect");
          const before = (await recorded()).length;
          await page.evaluate(() => (window as unknown as { socket_: WebSocket }).socket_.close());
          if (legacy) {
            await waitWire("in", "input-ready", 2);
            assert.deepEqual((await recorded()).slice(before).filter((frame) => frame.dir === "out" && frame.type === "attach"),
              [{ dir: "out", type: "attach", keep_size: true }], "a legacy reconnect keeps today's attach behavior");
          } else {
            await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
            await page.waitForFunction(() => (window as unknown as { frames_: Frame[] }).frames_.some((frame) => frame.type === "watch-data"));
            assert.deepEqual(await sent(page, before), [], "a background reconnect watches before any attach replay");
          }
          console.log(`PASS inactive attach lifecycle: ${scenario}`);
          continue;
        }
        if (scenario === "mirrored-cache") {
          // Given a mounted fixed-grid pane (the mirror's geometry contract), keep its subscription.
          await waitWire("in", "pane-geometry");
          await pauseClock(page);
          const extra = await tabCreate({ workspaceId: workspaces[0]!, label: "Mirror cache" });
          const before = wire.length;
          // When it becomes cached, presentation effects must not release the mirror.
          await page.locator(`[role="tab"][data-tab-id="${extra.tab.tab_id}"]`).evaluate((button: HTMLElement) => button.click());
          await page.locator(`.pane-frame.is-hidden[data-layout-pane="${first}"]`).waitFor({ state: "attached" });
          await page.clock.runFor(0);
          await waitWire("in", "input-ready", 2);
          // Then the other pane is attached but no detach was sent for the cached mirror.
          assert.deepEqual(detachedPanes(wire.slice(before)), [], "caching a mirrored pane never releases it");
          console.log("PASS inactive attach lifecycle: mirrored-cache");
          continue;
        }
        if (queueScenario) {
          await page.locator('.composer-status[data-status="working"]').waitFor();
          await page.locator(".composer-text").fill("lifecycle follow-up");
          assert.equal(await page.locator(".composer-text").inputValue(), "lifecycle follow-up");
          await page.locator(".composer-text").press("Enter");
          await waitWire("out", "submit");
          if (scenario === "queue-switch") await page.locator('.pending-message[data-state="queued"]').waitFor();
        }
        {
          // Freeze timers after the real first attach; only the release delay is advanced below.
          await pauseClock(page);
          if (scenario === "writes") {
            await page.clock.runFor(50);
            holdOutput = true;
          }
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
            window.dispatchEvent(new Event("blur"));
          });
          if (queueScenario) {
            await page.clock.runFor(1000);
            assert.equal((await recorded()).filter((f) => f.dir === "out" && f.type === "detach").length, 0,
              "a queued or unacknowledged follow-up holds its originating attach");
            if (scenario === "queue-switch") {
              await page.locator(`.pane-select[title^="${next} — "]`).evaluate((button: HTMLElement) => button.click());
              await waitWire("out", "watch");
              await page.locator(`.terminal-stack[data-pane-owner="${next}"]`).waitFor({ state: "attached" });
              await page.clock.runFor(0);
              assert.deepEqual(detachedPanes(await recorded()), [],
                "navigation keeps pane A attached while its queued message waits");
              await assertSharedConnection(page);
              assert.equal(wire.filter((frame) => frame.dir === "out" && frame.type === "attach").length, 1,
                "pane B watches immediately; pane A's queue is not inherited");
              await page.evaluate(() => {
                Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
                window.dispatchEvent(new Event("focus"));
                Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
                window.dispatchEvent(new Event("blur"));
              });
              await waitWire("in", "input-ready", 2);
              await page.clock.runFor(100);
              assert.deepEqual(detachedPanes(await recorded()), [],
                "pane A's retained attach cannot shorten pane B's new delay");
              await page.clock.runFor(900);
              await waitWire("out", "detach", 1);
              assert.deepEqual(detachedPanes(await recorded()), [next], "pane B releases only after its full new delay; pane A stays for its queue");
              await assertSharedConnection(page);
            } else {
              assert.ok(releaseSubmit, "the explicit Send is waiting at the server boundary");
              releaseSubmit();
              await waitWire("in", "submit-result");
              if (acceptedQueue) {
                const queued = page.locator('.pending-message[data-state="queued"]');
                await queued.waitFor();
                // An accepted follow-up still owns its lease until the user discards it.
                await queued.getByRole("button", { name: "Discard", exact: true }).evaluate((button: HTMLElement) => button.click());
                await waitWire("out", "pending-action");
              }
              await waitWire("out", "detach");
            }
          } else if (scenario === "background-cache") {
            // Given an away-released pane, navigation must not change its release reason.
            await page.clock.runFor(1000);
            await waitWire("out", "watch");
            const viewOnly = page.locator(".pane-frame.is-current .terminal-banner", { hasText: "View only while you use another window" });
            await viewOnly.waitFor();
            const extra = await tabCreate({ workspaceId: workspaces[0]!, label: "Background cache" });
            tabs.set(extra.root_pane.pane_id, extra.tab.tab_id);
            const pick = async (pane: string): Promise<void> => {
              assert.ok(page);
              const tab = tabs.get(pane);
              assert.ok(tab);
              await page.locator(`[role="tab"][data-tab-id="${tab}"]`).evaluate((button: HTMLElement) => button.click());
              await page.locator(`.pane-frame.is-current[data-layout-pane="${pane}"]`).waitFor();
              await page.clock.runFor(0);
            };
            const before = (await recorded()).length;
            // When A -> B -> A happens without window focus, both panes remain observers.
            await pick(extra.root_pane.pane_id);
            await waitWire("out", "unwatch");
            await waitWire("out", "watch", 2);
            await pick(first);
            await waitWire("out", "unwatch", 2);
            assert.equal(await page.evaluate(() => document.hasFocus()), false);
            assert.deepEqual((await recorded()).slice(before).filter((frame) => frame.dir === "out" && (frame.type === "attach" || frame.type === "resize")), [],
              "an away-released pane returned from cache in the background stays watch-only");
            await waitWire("out", "watch", 3);
            await viewOnly.waitFor();
            // Then real focus resumes the presented pane, not its cached sibling.
            const returning = (await recorded()).length;
            await page.evaluate(() => {
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
              window.dispatchEvent(new Event("focus"));
            });
            await waitWire("in", "input-ready", 2);
            assert.equal((await recorded()).slice(returning).filter((frame) => frame.dir === "out" && frame.type === "attach").length, 1,
              "focus attaches only the presented pane");
            await viewOnly.waitFor({ state: "hidden" });
          } else if (scenario === "writes") {
            await page.clock.runFor(999);
            await page.evaluate(() => {
              const scheduled: Array<() => void> = [];
              const timers: Pick<Window, "setTimeout"> = window;
              const schedule = timers.setTimeout;
              timers.setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
                if (timeout === undefined && typeof handler === "function") {
                  scheduled.push(() => handler(...args));
                  return 0;
                }
                return schedule(handler, timeout, ...args);
              };
              Object.assign(window, { parseHeld_: scheduled, restoreParserTimer_: () => { timers.setTimeout = schedule; } });
            });
            assert.ok(injectOutput);
            injectOutput();
            await page.waitForFunction(() => (window as unknown as { parseHeld_: Array<() => void> }).parseHeld_.length > 0,
              undefined, { timeout: 10_000 });
            await page.evaluate(() => (window as unknown as { restoreParserTimer_: () => void }).restoreParserTimer_());
            await page.clock.runFor(1);
            await waitWire("out", "detach");
            await page.evaluate(() => {
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
              window.dispatchEvent(new Event("focus"));
              for (const parse of (window as unknown as { parseHeld_: Array<() => void> }).parseHeld_) parse();
            });
            await waitWire("in", "input-ready", 2);
            await page.clock.runFor(50);
            assert.equal((await page.locator(".xterm-rows").textContent() ?? "").includes("STALE-SUBSCRIPTION"), false,
              "resume resets after pending writes, before the new attachment stream");
            holdOutput = false;
            for (const deliver of heldOutput) deliver();
          } else if (scenario === "switch") {
            const before = (await framesOf(page)).length;
            // Programmatic click deliberately does not focus the window.
            await page.locator(`.pane-select[title^="${next} — "]`).evaluate((button: HTMLElement) => button.click());
            await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
            assert.deepEqual(await sent(page, before), []);
            await waitPaneDetach(page, first);
            assert.deepEqual(detachedPanes(await framesOf(page)), [first], "navigation releases only the old pane's lease");
            await assertSharedConnection(page);
            await page.clock.runFor(1000);
            assert.deepEqual(detachedPanes(await framesOf(page)), [first], "the new pane never acquired a lease to release");
            await assertSharedConnection(page);
          } else if (scenario === "resume") {
            await page.clock.runFor(1000);
            await waitDetach(page);
            await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
            const before = (await framesOf(page)).length;
            // Resume only the pane that was explicitly touched; a window-level event no
            // longer has a target once several independent terminals can be mounted.
            await page.locator(`.terminal-stack[data-pane-owner="${first}"]`).evaluate((stack) => {
              stack.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
            });
            await attached(page, 2);
            assert.deepEqual(await sent(page, before), [{ dir: "out", type: "attach", keep_size: true }],
              "an inactive pointer resume must not resize the shared grid");
            await page.clock.runFor(1000);
            await waitDetach(page, 2);
          } else {
            // Returning before the delay cancels release, including repeated interruptions.
            await page.evaluate(() => {
              for (let i = 0; i < 5; i++) {
                Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
                window.dispatchEvent(new Event("focus"));
                Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
                window.dispatchEvent(new Event("blur"));
              }
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
              window.dispatchEvent(new Event("focus"));
            });
            await page.clock.runFor(1000);
            let frames = await framesOf(page);
            assert.equal(frames.filter((f) => f.dir === "out" && f.type === "detach").length, 0);
            assert.equal(frames.filter((f) => f.dir === "out" && f.type === "attach").length, 1);
            await page.evaluate(() => {
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
              window.dispatchEvent(new Event("blur"));
            });
            await page.clock.runFor(1000);
            await waitDetach(page);
            await page.locator(".terminal-banner", { hasText: "View only while you use another window" }).waitFor();
            await page.evaluate(() => {
              Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
              window.dispatchEvent(new Event("focus"));
            });
            await attached(page, 2);
            await page.clock.runFor(1000);
            frames = await framesOf(page);
            assert.equal(frames.filter((f) => f.dir === "out" && f.type === "attach").length, 2);
            assert.equal(frames.filter((f) => f.dir === "out" && f.type === "detach").length, 1);
          }
        }
        console.log(`PASS inactive attach lifecycle: ${scenario}`);
      } catch (error) {
        failures.push(`${scenario}: ${String(error)}`);
        console.error(`FAIL inactive attach lifecycle: ${scenario}: ${String(error)}`);
        if (error instanceof Error) console.error(error.stack);
      } finally {
        if (holder) await stopHolder(holder);
        await page?.context().close();
      }
    }
    assert.deepEqual(failures, [], "inactive attach lifecycle scenarios");
    if (!process.env.CHAT_SIZE_CASE || process.env.CHAT_SIZE_CASE === "embedded") {
      // Exercise the demo's embedded client without weakening the real app's anti-framing CSP.
      const context = await browser.newContext();
      contexts.push(context);
      // An intercepted iframe document has no network address space until Chrome grants it.
      await context.grantPermissions(["local-network-access"], { origin });
      await context.addInitScript(() => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "terminal" }));
        Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
      });
      const page = await context.newPage();
      const wire: string[] = [];
      let attachedFrame: () => void = () => {};
      const inputReady = new Promise<void>((resolve) => { attachedFrame = resolve; });
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => wire.push(JSON.parse(String(payload)).type));
        socket.on("framereceived", ({ payload }) => {
          if (JSON.parse(String(payload)).type === "input-ready") attachedFrame();
        });
      });
      await page.route("**/embed-test", (route) => route.fulfill({ contentType: "text/html",
        body: `<iframe style="width:1000px;height:700px" src="/?pane=${encodeURIComponent(first)}"></iframe>` }));
      await page.route(`${origin}/?pane=${encodeURIComponent(first)}`, async (route) => {
        const response = await route.fetch();
        const headers = response.headers();
        const policy = headers["content-security-policy"];
        assert.ok(policy);
        await route.fulfill({ response, headers: { ...headers,
          "content-security-policy": policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'") } });
      });
      await page.goto(`${origin}/embed-test`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([inputReady, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("embedded pane never attached")), 15_000);
        })]);
        assert.equal(wire.filter((type) => type === "attach").length, 1);
        assert.equal(wire.includes("watch"), false, "the embedded page keeps its attach without document focus");
        console.log("PASS inactive attach lifecycle: embedded");
      } finally { clearTimeout(timer); await context.close(); }
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

// This file is also the focused manual-QA entry point; imports from ui-regression do not run it.
if (import.meta.main) {
  await import("./test-herdr.ts");
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-chat-size-run-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
    const origin = `http://127.0.0.1:${server.port}`;
    if (process.env.CHAT_SIZE_CASE === "reclaim") await checkFocusedWindowReclaimsTerminalSize(browser, origin);
    else if (process.env.CHAT_SIZE_CASE) await checkInactiveAttachLifecycle(browser, origin);
    else {
      await checkChatKeepsTerminalSize(browser, origin);
      await checkPaneSwitchKeepsTerminalSize(browser, origin);
      await checkBackgroundTabKeepsTerminalSize(browser, origin);
    }
  } finally {
    await browser?.close();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}


/**
 * A window that keeps its focus gets no focus event when another device sized the pane meanwhile
 * (another desktop used beside a PC left in front): a click or a key takes the pane back.
 * Touch clients retain the shared grid instead of becoming resize owners.
 */
export async function checkFocusedWindowReclaimsTerminalSize(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-reclaim-size-"));
  const contexts: BrowserContext[] = [];
  let workspace: string | null = null;
  try {
    const cwd = join(root, "pane");
    mkdirSync(cwd);
    const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-reclaim-size" });
    workspace = created.workspace.workspace_id;
    const paneId = created.root_pane.pane_id;
    // the pty is resized under the shell throughout: its answers go to files, not the screen
    const size = shellSize(paneId, cwd);
    const sizeBecomes = async (expected: string, what: string) => {
      const deadline = Date.now() + 10_000;
      let seen = "";
      while (Date.now() < deadline) { seen = await size(); if (seen === expected) return; await Bun.sleep(100); }
      throw new Error(`${what}: the pane is ${seen}, not ${expected}`);
    };
    // both windows are in use the whole time: neither gets a focus event
    const inFront = async (page: Page) => { await page.addInitScript(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true })); };
    const settings = { language: "en", defaultView: "terminal" };
    // input-ready comes before an attach's resize reaches the pty: each window's size is read
    // once the shell reports the grid that window asked for (its last resize frame out)
    const askedGrid = async (page: Page): Promise<string> => {
      await page.waitForFunction(() => (window as unknown as { frames_: { dir: string; type: string }[] }).frames_.some((f) => f.dir === "out" && f.type === "resize"), undefined, { timeout: 10_000 });
      const frame = (await framesOf(page)).filter((f) => f.dir === "out" && f.type === "resize").at(-1)!;
      return `${frame.rows} ${frame.cols}`;
    };
    const desktop = await openRecording(browser, contexts, origin, paneId, { viewport: { width: 1280, height: 800 } }, settings, false, inFront);
    await attached(desktop);
    const desktopSize = await askedGrid(desktop);
    await sizeBecomes(desktopSize, "the desktop took the pane at its own size");
    const phone = await openRecording(browser, contexts, origin, paneId, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { ...settings, terminalInputMode: "line" }, false, inFront);
    await attached(phone);
    await sizeBecomes(desktopSize, "the phone keeps the desktop's shared grid");
    assert.equal((await framesOf(phone)).filter((frame) => frame.dir === "out" && frame.type === "resize").length, 0, "the phone sends no resize");

    await desktop.locator(".xterm").click();
    await sizeBecomes(desktopSize, "a click in the desktop terminal");
    await phone.locator(".xterm").tap();
    await sizeBecomes(desktopSize, "a tap in the phone terminal preserves the shared grid");
    const other = await openRecording(browser, contexts, origin, paneId, { viewport: { width: 1000, height: 600 } }, settings, false, inFront);
    await attached(other);
    const otherSize = await askedGrid(other);
    await sizeBecomes(otherSize, "another desktop took the pane at its own size");
    // A right-click opens the menu without taking the pane back from that desktop.
    await desktop.locator(".xterm").click({ button: "right" });
    // fixed wait: the context menu must not cause a late PTY resize.
    await Bun.sleep(500);
    assert.equal(await size(), otherSize, "a right-click leaves the pane at the other desktop's size");
    // Escape closes the menu where one opened; in the terminal it is a key like any other
    await desktop.keyboard.press("Escape");
    await desktop.keyboard.press("Shift");
    await sizeBecomes(desktopSize, "a key in the desktop terminal");
    console.log("PASS a window that kept its focus takes the pane back on a click or a key in its terminal");

    // Upstream's input-ownership handoff is correct for a direct-attach phone,
    // but this fork's passive phone lens must keep the desktop's shared grid.
    // Text, Enter and key-bar controls must still reach the application.
    const outFrom = async (page: Page, from: number) => (await framesOf(page)).slice(from).filter((f) => f.dir === "out");
    const inputWithoutResize = async (what: string, from: number, sends: readonly string[]) => {
      const deadline = Date.now() + 10_000;
      let out: Frame[] = [];
      while (Date.now() < deadline) {
        out = await outFrom(phone, from);
        if (out.some((f) => sends.includes(f.type))) break;
        await Bun.sleep(50);
      }
      const sent = out.findIndex((f) => sends.includes(f.type));
      assert.ok(sent >= 0, `${what}: the phone sent none of ${sends.join("/")}: ${JSON.stringify(out)}`);
      // fixed wait: a delayed native resize is forbidden after this input.
      await Bun.sleep(NO_RESIZE_WAIT_MS);
      out = await outFrom(phone, from);
      assert.equal(out.filter((f) => f.type === "resize").length, 0,
        `${what}: phone controls never take over the desktop's grid: ${JSON.stringify(out)}`);
      await sizeBecomes(desktopSize, what);
    };
    // Tapping the line does not resize the shared grid before any input is sent.
    let mark = (await framesOf(phone)).length;
    await phone.locator(".terminal-input-text").tap();
    // fixed wait: focus-triggered native resize uses a delayed layout observer.
    await Bun.sleep(NO_RESIZE_WAIT_MS);
    assert.equal((await outFrom(phone, mark)).filter((f) => f.type === "resize").length, 0,
      "tapping the phone input line cannot resize the desktop's grid");
    await sizeBecomes(desktopSize, "a tap into the phone input line");
    // the line keeps its focus from here on: no focus event helps the steps below
    await desktop.keyboard.press("Shift");
    await sizeBecomes(desktopSize, "a key in the desktop terminal, the phone's line focused");
    await phone.keyboard.type("true");
    mark = (await framesOf(phone)).length;
    await phone.keyboard.press("Enter");
    // the line's Enter follows its text after the server's gap, without resizing.
    await phone.waitForFunction(() => (document.querySelector(".terminal-input-text") as HTMLTextAreaElement | null)?.value === "", undefined, { timeout: 10_000 });
    await inputWithoutResize("a line sent from the phone's input line", mark, ["submit", "input"]);
    await desktop.keyboard.press("Shift");
    await sizeBecomes(desktopSize, "a key in the desktop terminal, before the key bar");
    mark = (await framesOf(phone)).length;
    // Ctrl+C, not Esc: the shell would read Esc and the size command's first letter as one Meta key
    await phone.locator(".key-bar").getByRole("button", { name: "Control C" }).tap();
    await inputWithoutResize("a key-bar tap on the phone", mark, ["input", "keys"]);
    await desktop.keyboard.press("Shift");
    await sizeBecomes(desktopSize, "a key in the desktop terminal, before the empty line's Enter");
    mark = (await framesOf(phone)).length;
    await phone.locator(".terminal-input-send").tap();
    await inputWithoutResize("Enter from the phone's empty input line", mark, ["input", "keys"]);
    console.log("PASS phone input line, Enter and key bar send without taking the desktop's PTY grid");
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    if (workspace) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
