/** Real Herdr, two browsers: passive history must not mutate the shared pane. Run only after a CI build. */
import { TEST_SESSION } from "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, paneRead, paneScrollInfo, paneSendKeys, paneSendText, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { PtySession } from "../server/pty/session.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-winlens-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const pages: Page[] = [];
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let native: PtySession | undefined;
type Frame = { type?: string; pane_id?: string; keep_size?: boolean; data?: string; keys?: string[] };

async function until(done: () => Promise<boolean>, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await done()) return; await Bun.sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
const screen = (page: Page) => page.locator(".pane-terminal .xterm-rows").innerText();
const historyScreen = (page: Page) => page.locator(".pane-terminal-local-history .xterm-rows").innerText();
const historyVisible = (page: Page) => page.locator(".pane-terminal-local-history:not([hidden])").count();
const input = (page: Page) => page.locator(".pane-terminal .xterm-helper-textarea");
function record(page: Page) {
  pages.push(page);
  const sent: Frame[] = []; const received: Frame[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { try { sent.push(JSON.parse(String(payload)) as Frame); } catch {} });
    socket.on("framereceived", ({ payload }) => { try { received.push(JSON.parse(String(payload)) as Frame); } catch {} });
  });
  return { sent, received, ready: (pane: string) => until(async () => received.some((m) => m.type === "input-ready" && m.pane_id === pane), "this connection's input-ready") };
}
async function shell(page: Page, text: string): Promise<void> {
  await input(page).focus(); await page.keyboard.type(text); await page.keyboard.press("Enter");
}
let sizeSequence = 0;
async function size(paneId: string): Promise<string> {
  const marker = `fork-size-${++sizeSequence}:`;
  await paneSendText(paneId, `printf '${marker}'; stty size`); await paneSendKeys(paneId, ["Enter"]);
  const regex = new RegExp(`${marker}(\\d+)\\s+(\\d+)`);
  let result = "";
  await until(async () => {
    const text = (await paneRead({ paneId, source: "visible" })).text;
    const match = regex.exec(text); if (match) result = match.slice(1).join("x");
    return !!match;
  }, "native PTY size");
  return result;
}
const scrollOf = (page: Page) => page.locator(".pane-terminal").evaluate((host) => ({
  left: host.scrollLeft, top: host.scrollTop, width: host.scrollWidth - host.clientWidth,
  height: host.scrollHeight - host.clientHeight, adopted: host.hasAttribute("data-adopted-grid"),
}));
async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.locator(".pane-terminal").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2 - dx / 2, y = box.y + box.height / 2 - dy / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 10; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
}
async function wheel(page: Page, rows: number): Promise<void> {
  await page.locator(".pane-terminal > .xterm").evaluate((term, rows) => term.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaMode: 1, deltaY: rows })), rows);
}

try {
  const cwd = join(root, "pane"); mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-winlens" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  // A real native Herdr frontend in the isolated CI session, not another web
  // controller. Its window is deliberately smaller than the desktop browser.
  assert.ok(TEST_SESSION.includes("test") || process.env["CHECK_DIR"], "native frontend must use an isolated test session");
  let nativeOutput = "";
  native = new PtySession({ command: process.env["HERDR_WEB_HERDR_BIN"] || "herdr", args: ["--session", TEST_SESSION],
    cols: 110, rows: 34, env: { HERDR_SOCKET_PATH: process.env["HERDR_SOCKET"]!, TERM: "xterm-256color" },
    onData: data => { nativeOutput = (nativeOutput + data).slice(-262144); }, onExit: () => {} });
  await until(async () => nativeOutput.length > 0, "native frontend connected");
  await herdrRpc("workspace.focus", { workspace_id: created.workspace.workspace_id });
  const nativeRect = async () => (await sessionSnapshot()).layouts.flatMap(layout => layout.panes).find(p => p.pane_id === paneId)!.rect;
  await until(async () => { const rect = await nativeRect(); return rect.height > 0 && rect.height < 34 && rect.width <= 110; }, "native window lays out its pane");
  const beforeBrowser = await nativeRect();
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false }); servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const desktop = await desktopContext.newPage(); const desktopWire = record(desktop);
  await desktop.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`); await desktopWire.ready(paneId);
  assert.equal((await paneScrollInfo(paneId))?.viewport_rows, beforeBrowser.height, "desktop browser cannot enlarge the native PTY and clip its bottom");
  await desktop.setViewportSize({ width: 1500, height: 1000 });
  await desktop.locator(".pane-terminal[data-adopted-grid]").waitFor();
  await desktop.evaluate(() => window.dispatchEvent(new Event("focus")));
  await Bun.sleep(300);
  assert.equal((await paneScrollInfo(paneId))?.viewport_rows, beforeBrowser.height, "browser resize/focus keeps native geometry");
  native.resize(100, 28);
  await until(async () => (await nativeRect()).height < beforeBrowser.height, "native window becomes shorter");
  await until(async () => (await paneScrollInfo(paneId))?.viewport_rows === (await nativeRect()).height, "control follows native resize, without locking the previous size");
  await desktop.setViewportSize({ width: 1280, height: 800 });
  await shell(desktop, "echo mirror-ok-$((40+2))");
  await until(async () => (await screen(desktop)).includes("mirror-ok-42"), "typed input reaches Windows-style control transport");
  const desktopGrid = await size(paneId);
  await shell(desktop, "for i in $(seq 1 300); do printf '\\033[31mhistory-line-%04d\\033[0m\\r\\n' \"$i\"; done; echo isolation-live-$((200+42))");
  await until(async () => (await screen(desktop)).includes("isolation-live-242"), "live fixture output");
  const nativeScroll = await paneScrollInfo(paneId); assert.equal(nativeScroll?.offset_from_bottom, 0);

  // A native Herdr controller adopts the original desktop grid, even when the
  // web viewport is shorter. A Claude-style TUI can paint a footer *below* its
  // cursor. The old cursor follower kept snapping browser scrollTop back above
  // that footer, while Instant local history swallowed all downward wheels.
  await desktop.setViewportSize({ width: 1200, height: 345 });
  await until(async () => (await scrollOf(desktop)).height > 90, "native grid overflows the short desktop web viewport");
  await shell(desktop, `printf '\\033[2J\\033[Htop-of-screen\\033[${Math.max(8, beforeBrowser.height - 3)};1Hnative-footer-below-cursor\\033[2;1H'`);
  await until(async () => (await screen(desktop)).includes("native-footer-below-cursor"), "footer below the active input row");
  await desktop.getByRole("button", { name: "Application scroll", exact: true }).click();
  const beforePan = await scrollOf(desktop);
  await wheel(desktop, 14);
  await until(async () => (await scrollOf(desktop)).top > beforePan.top + 30, "downward wheel pans an oversized native grid in local-history mode");
  assert.equal(await historyVisible(desktop), 0, "panning the visible grid does not replace it with cached history");
  await desktop.locator(".pane-terminal").evaluate((host) => { host.scrollTop = host.scrollHeight - host.clientHeight; });
  await until(async () => (await scrollOf(desktop)).top >= (await scrollOf(desktop)).height - 2, "scrollbar reaches the terminal's actual bottom");
  await desktop.getByRole("button", { name: "Back to live", exact: true }).waitFor();
  const manual = await scrollOf(desktop);
  await paneSendText(paneId, "printf '\\033[2;1Hlive-update-above-footer'"); await paneSendKeys(paneId, ["Enter"]);
  await until(async () => (await screen(desktop)).includes("live-update-above-footer"), "fresh ANSI arrives while reading the lower rows");
  await Bun.sleep(150);
  assert.ok(Math.abs((await scrollOf(desktop)).top - manual.top) < 3, "incoming output preserves the user's scrollbar position instead of following a higher cursor");
  assert.equal(desktopWire.sent.filter((m) => m.type === "scroll" || m.type === "resize").length, 0, "local panning does not alter shared Herdr scroll or geometry");
  await desktop.getByRole("button", { name: "Back to live", exact: true }).click();
  await until(async () => !(await desktop.getByRole("button", { name: "Back to live", exact: true }).count()), "follow-live resumes explicitly");
  await desktop.getByRole("button", { name: "Instant local history", exact: true }).click();
  await desktop.setViewportSize({ width: 1280, height: 800 });
  console.log("PASS adopted native grid: down-wheel and scrollbar reach the footer, streaming keeps the manual viewport, Back to live resumes follow");

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  const phone = await phoneContext.newPage(); const phoneWire = record(phone);
  let delayed = false; let reads = 0;
  await phone.route("**/api/pane/read?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("source") === "recent" && url.searchParams.get("format") === "ansi") {
      reads++; if (delayed) await Bun.sleep(800);
    }
    await route.continue();
  });
  await phone.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`); await phoneWire.ready(paneId);
  await until(async () => (await screen(phone)).includes("isolation-live-242"), "phone joins existing live screen");
  await phone.locator('.pane-terminal[data-history-cache="ready"]').waitFor();
  assert.equal((await scrollOf(phone)).adopted, true);
  assert.ok(phoneWire.sent.some((m) => m.type === "attach" && m.keep_size === true));
  assert.equal(phoneWire.sent.filter((m) => m.type === "resize").length, 0);
  assert.equal((await paneScrollInfo(paneId))?.viewport_rows, nativeScroll?.viewport_rows);

  // Add 800 ms to every subsequent history read. A warm-cache gesture must still paint promptly.
  delayed = true;
  const readsBefore = reads;
  const elapsed = await phone.evaluate(async () => {
    const overlay = document.querySelector<HTMLElement>(".pane-terminal-local-history")!;
    const start = performance.now();
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error("warm-cache scroll waited for network")); }, 600);
      const observer = new MutationObserver(() => {
        if (Number(overlay.dataset.offset) > 0 && !overlay.hidden) { clearTimeout(timer); observer.disconnect(); resolve(performance.now() - start); }
      });
      observer.observe(overlay, { attributes: true });
      document.querySelector(".pane-terminal > .xterm")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, deltaMode: 1 }));
    });
  });
  assert.ok(elapsed < 600, `warm-cache gesture painted in ${elapsed.toFixed(1)} ms with 800 ms network delay`);
  assert.equal(reads, readsBefore, "cached scroll does not fetch before it can paint");
  await until(async () => (await historyScreen(phone)).includes("history-line-"), "private history contains real old output");
  assert.ok(await phone.locator('.pane-terminal-local-history .xterm-rows span[class*="xterm-fg-1"]').count() > 0, "history keeps ANSI red styling");
  const paints = await phone.locator(".pane-terminal-local-history").getAttribute("data-paints");
  for (let i = 0; i < 12; i++) await wheel(phone, -1);
  assert.equal(await phone.locator(".pane-terminal-local-history").getAttribute("data-paints"), paints, "wheel bursts scroll existing rows rather than resetting/reparsing ANSI");
  assert.equal((await paneScrollInfo(paneId))?.offset_from_bottom, 0);
  assert.equal(phoneWire.sent.filter((m) => m.type === "scroll" || m.type === "resize").length, 0);
  assert.ok((await screen(desktop)).includes("isolation-live-242"));
  // xterm's DOM renderer paints on animation frames; the final wheel's viewport update is
  // synchronous but its rows are not. Freeze only after that user gesture has been painted.
  await phone.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const frozen = await historyScreen(phone);
  await paneSendText(paneId, "echo still-live-$((600+7))"); await paneSendKeys(paneId, ["Enter"]);
  await until(async () => (await screen(desktop)).includes("still-live-607"), "desktop remains live while phone reads history");
  assert.equal(await historyScreen(phone), frozen, "incoming frames do not move a reading viewport");
  await drag(phone, 0, 120);
  assert.equal((await paneScrollInfo(paneId))?.offset_from_bottom, 0, "real touch does not move global history");
  assert.equal(await phone.evaluate(() => {
    const pane = document.querySelector(".pane-terminal")!.getBoundingClientRect();
    const overlay = document.querySelector(".pane-terminal-local-history")!.getBoundingClientRect();
    return Math.abs(pane.top - overlay.top) < 2 && Math.abs(pane.height - overlay.height) < 2;
  }), true, "history overlay is pinned to the viewport, not its scrolled content");
  if (evidence) { await phone.screenshot({ path: join(evidence, "phone-independent-history.png") }); await desktop.screenshot({ path: join(evidence, "desktop-still-live.png") }); }
  await wheel(phone, 10_000);
  await until(async () => (await historyVisible(phone)) === 0, "reverse scroll returns to live bottom");
  await wheel(phone, -12); await until(async () => (await historyVisible(phone)) === 1, "history reopens");
  const line = phone.getByRole("textbox", { name: "Terminal input line", exact: true });
  await line.fill("echo phone-input-$((70+2))"); await line.press("Enter");
  await until(async () => (await screen(desktop)).includes("phone-input-72"), "input from history reaches live program");
  assert.equal(await historyVisible(phone), 0);
  await phone.setViewportSize({ width: 390, height: 520 });
  await Bun.sleep(300);
  assert.equal(phoneWire.sent.filter((m) => m.type === "resize").length, 0, "keyboard-sized viewport changes send no PTY resize");
  assert.equal(await size(paneId), desktopGrid, "native PTY geometry is unchanged");
  await phone.setViewportSize({ width: 390, height: 844 });
  console.log(`PASS isolated touch history, ANSI, frozen viewport, input and geometry; cached gesture ${elapsed.toFixed(1)} ms with 800 ms artificial history latency`);

  // A Kitty-disambiguated TUI distinguishes the Escape key from a literal 0x1b.
  // This reproduces the Pi/Claude/Codex Stop failure with a harmless test process,
  // never an agent in the user's real session.
  const kitty = join(root, "kitty.py");
  writeFileSync(kitty, "import os,sys,termios,tty\nold=termios.tcgetattr(0)\ntty.setraw(0)\ntry:\n sys.stdout.write('\\x1b[>1uKITTY-READY\\r\\n');sys.stdout.flush()\n while True:\n  data=os.read(0,128)\n  sys.stdout.write('KITTY-BYTES:'+data.hex()+'\\r\\n');sys.stdout.flush()\n  if b'q' in data: break\nfinally:\n sys.stdout.write('\\x1b[<uKITTY-END\\r\\n');sys.stdout.flush();termios.tcsetattr(0,termios.TCSADRAIN,old)\n");
  await shell(desktop, `python3 -u '${kitty}'`);
  await until(async () => (await screen(desktop)).includes("KITTY-READY"), "Kitty keyboard mode is active in the isolated TUI");
  const escSentAt = desktopWire.sent.length;
  await input(desktop).press("Escape");
  await until(async () => desktopWire.sent.slice(escSentAt).some((m) => m.type === "keys" && m.keys?.[0] === "esc"), "physical Escape is a semantic key");
  await until(async () => (await screen(desktop)).includes("KITTY-BYTES:1b5b323775"), "Herdr encodes Escape according to Kitty protocol, rather than sending raw ESC");
  await paneSendText(paneId, "q");
  await until(async () => (await screen(desktop)).includes("KITTY-END"), "Kitty test process exits without interrupting an agent");
  console.log("PASS Windows-style control delivers a semantic Escape to a Kitty-disambiguated TUI");

  // Herdr's JSON ANSI bridge does not expose the application's mouse/alternate modes.
  // Explicit Application scroll preserves TUI operation without guessing those modes.
  const probe = join(root, "mouse.py");
  writeFileSync(probe, "import os,sys,termios,tty\nold=termios.tcgetattr(0)\ntty.setraw(0)\ntry:\n sys.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006hTUI-READY\\r\\n');sys.stdout.flush()\n while True:\n  data=os.read(0,128)\n  if b'q' in data: break\n  sys.stdout.write('TUI-INPUT:'+data.hex()+'\\r\\n');sys.stdout.flush()\nfinally:\n sys.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l');sys.stdout.flush();termios.tcsetattr(0,termios.TCSADRAIN,old)\n");
  await shell(desktop, `python3 -u '${probe}'`);
  await until(async () => (await screen(phone)).includes("TUI-READY"), "mouse-aware alternate-screen application starts");
  await phone.getByRole("button", { name: "Instant local history", exact: true }).click();
  const beforeTui = phoneWire.sent.length;
  await wheel(phone, -3);
  await until(async () => phoneWire.sent.slice(beforeTui).some((m) => m.type === "scroll"), "Application mode forwards semantic wheel");
  await until(async () => (await screen(desktop)).includes("TUI-INPUT:"), "running TUI receives mouse wheel input");
  assert.equal(await historyVisible(phone), 0);
  await paneSendText(paneId, "q");
  await phoneContext.close();
  console.log("PASS explicit application scrolling keeps mouse/alternate TUI interaction");
  native.kill(); await native.exited; native = undefined;

  // Direct attach uses a transport-owned alternate buffer even for a plain shell.
  // Local history must still work, and observer two-axis panning must stay intact.
  const second = await workspaceCreate({ cwd, label: "herdr-web-ui-test-direct-history" }); workspaces.push(second.workspace.workspace_id);
  const attached = second.root_pane.pane_id;
  const directServer = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "direct") }); servers.push(directServer);
  const directOrigin = `http://127.0.0.1:${directServer.port}`;
  const own = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  const mine = await own.newPage(); const mineWire = record(mine);
  await mine.goto(`${directOrigin}/?pane=${encodeURIComponent(attached)}`); await mineWire.ready(attached);
  const mineLine = mine.getByRole("textbox", { name: "Terminal input line", exact: true });
  await mineLine.fill("for i in $(seq 1 200); do echo direct-$i; done"); await mineLine.press("Enter");
  await until(async () => (await screen(mine)).includes("direct-200"), "direct attach receives input/output");
  // Initial prefetch can precede fixture output; returning to live refreshes it on the bounded timer.
  await Bun.sleep(1800); await mine.locator('.pane-terminal[data-history-cache="ready"]').waitFor();
  await drag(mine, 0, 160);
  await until(async () => (await historyVisible(mine)) === 1 && (await historyScreen(mine)).includes("direct-"), "direct transport also uses private history");
  assert.equal((await paneScrollInfo(attached))?.offset_from_bottom, 0);
  assert.equal(mineWire.sent.filter((m) => m.type === "resize").length, 0);
  await own.close();

  const operator = await desktopContext.newPage(); const operatorWire = record(operator);
  await operator.goto(`${directOrigin}/?pane=${encodeURIComponent(attached)}`); await operatorWire.ready(attached);
  await shell(operator, "for i in $(seq 1 80); do echo row-$i; done; printf '%*s\\r\\n' $COLUMNS right-edge");
  await until(async () => (await screen(operator)).includes("right-edge"), "wide operator screen");
  const watch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
  const observer = await watch.newPage(); const observerWire = record(observer);
  await observer.routeWebSocket(/\/ws(\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const role = typeof message === "string" && (JSON.parse(message) as Frame).type === "role";
      upstream.send(role ? JSON.stringify({ type: "role", mode: "observe" }) : message);
    });
  });
  await observer.goto(`${directOrigin}/?pane=${encodeURIComponent(attached)}`);
  await observer.locator(".terminal-banner-observe").waitFor();
  await until(async () => observerWire.received.some((m) => m.type === "pty-data" && m.pane_id === attached), "observer receives replay");
  const geometryIndex = observerWire.received.findIndex((m) => m.type === "pane-geometry" && m.pane_id === attached);
  const replayIndex = observerWire.received.findIndex((m) => m.type === "pty-data" && m.pane_id === attached);
  assert.ok(geometryIndex >= 0 && geometryIndex < replayIndex, "shared geometry must precede ANSI replay, or the observer permanently clips wide rows");
  await until(async () => (await screen(observer)).includes("right-edge"), "observer receives operator grid");
  assert.equal((await scrollOf(observer)).adopted, true);
  await drag(observer, -220, 0); assert.ok((await scrollOf(observer)).left > 0, "observer pans horizontally");
  await drag(observer, 220, 160);
  assert.equal(await historyVisible(observer), 0, "observer drag remains grid panning, not history control");
  assert.equal((await paneScrollInfo(attached))?.offset_from_bottom, 0);
  console.log("PASS direct-attach local history and observer panning");
  assert.deepEqual(errors, []);
} catch (error) {
  for (const page of pages.filter((p) => !p.isClosed())) {
    console.error("QA page", page.url(), "live:", (await screen(page).catch(() => "unavailable")).slice(-1200));
    console.error("QA history", await page.locator(".pane-terminal-local-history").evaluate((node) => ({ hidden: (node as HTMLElement).hidden, data: (node as HTMLElement).dataset })).catch(() => null));
  }
  console.error("QA pageerrors", errors);
  throw error;
} finally {
  await browser?.close();
  native?.kill();
  await native?.exited;
  for (const server of servers) server.stop();
  for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
