/** What a native-Windows PC without direct terminal attach looks like in the browser:
 * the server answers as Windows herdr does (`terminalAttach: false`) and uses
 * `terminal session control` for a live ANSI stream. The browser owns the controller's
 * grid and wheel/touch scrolling goes back to herdr as semantic terminal.scroll events.
 * Run after `bun run build`; UI_EVIDENCE_DIR saves screenshots. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneScrollInfo, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-winlens-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let attachServer: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function until(done: () => Promise<boolean>, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await done()) return; await Bun.sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const screen = (page: Page) => page.locator(".xterm-rows").innerText();
const historyScreen = (page: Page) => page.locator(".pane-terminal-local-history .xterm-rows").innerText();
const historyVisible = (page: Page) => page.locator(".pane-terminal-local-history:not([hidden])").count();
/** Read the actual PTY's dimensions, not the size of either browser's DOM surface. */
async function ptyGrid(page: Page, suffix: string): Promise<string> {
  const marker = `pty-grid-${suffix}:`;
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(`printf '${marker}'; stty size`);
  await page.keyboard.press("Enter");
  const grid = new RegExp(`${marker}(\\d+)\\s+(\\d+)`);
  await until(async () => grid.test(await screen(page)), `PTY grid ${suffix}`);
  return (await screen(page)).match(grid)!.slice(1).join("x");
}

/** Where `text` sits against the terminal mount: each side's distance inside it, negative when cut off. */
const inset = (page: Page, text: string) => page.evaluate((needle) => {
  const host = document.querySelector(".pane-terminal");
  const rows = host?.querySelector(".xterm-rows");
  if (!host || !rows) return null;
  const box = host.getBoundingClientRect();
  const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.indexOf(needle);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const rect = range.getBoundingClientRect();
    return { left: rect.left - box.left, right: box.left + host.clientWidth - rect.right, top: rect.top - box.top, bottom: box.top + host.clientHeight - rect.bottom };
  }
  return null;
}, text);
const shown = (at: Awaited<ReturnType<typeof inset>>): boolean => at !== null && Math.min(at.left, at.right, at.top, at.bottom) > -1;
const scrollOf = (page: Page) => page.evaluate(() => {
  const host = document.querySelector(".pane-terminal")!;
  return { left: host.scrollLeft, top: host.scrollTop, width: host.scrollWidth - host.clientWidth, height: host.scrollHeight - host.clientHeight, adopted: host.hasAttribute("data-adopted-grid") };
});
/** One finger dragged across the terminal, as real touch events (CDP), from the middle of the mount. */
async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.locator(".pane-terminal").boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2 - dx / 2;
  const y = box.y + box.height / 2 - dy / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 10; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
/** Drags until `done`, a few times at most: one drag is shorter than a wide grid. */
async function dragUntil(page: Page, dx: number, dy: number, done: () => Promise<boolean>, label: string): Promise<void> {
  for (let tries = 0; tries < 8 && !(await done()); tries++) await drag(page, dx, dy);
  assert.equal(await done(), true, label);
}

try {
  const cwd = join(root, "pane"); mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-winlens" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const health = await (await fetch(`${origin}/api/health`)).json() as { herdr: { terminal_attach?: boolean; terminal_control?: boolean; terminal_mirror?: boolean } };
  assert.deepEqual([health.herdr.terminal_attach, health.herdr.terminal_control, health.herdr.terminal_mirror], [false, true, undefined]);
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  const terminal = page.getByRole("button", { name: /^Terminal/ });
  await terminal.waitFor();
  assert.equal(await terminal.getAttribute("aria-pressed"), "true", "a shell pane opens in the terminal lens");
  assert.equal(await terminal.locator(".pill-soon").count(), 0, "no soon pill: the lens works");
  assert.equal(await page.locator(".terminal-banner-soon").count(), 0);
  // typed in the page, run by the pane's shell, read back from herdr's screen
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo mirror-ok-$((40+2))");
  await page.keyboard.press("Enter");
  await until(async () => (await screen(page)).includes("mirror-ok-42"), "the command's output reaches the controlled terminal");
  // colour survives: herdr's read keeps the escape sequences
  await page.keyboard.type("printf '\\033[31mred-cell\\033[0m\\n'");
  await page.keyboard.press("Enter");
  await until(async () => await page.locator(".xterm-rows span[class*='xterm-fg-1']", { hasText: "red-cell" }).count() > 0, "a red cell is painted red");
  if (evidence) await page.screenshot({ path: join(evidence, "windows-control-desktop.png") });
  console.log("PASS the terminal lens of a PC without direct attach streams the controlled pane, typed input included");

  // the chat lens and back: the controller is still live
  await page.getByRole("button", { name: /^Chat/ }).click();
  await terminal.click();
  await until(async () => (await screen(page)).includes("mirror-ok-42"), "the screen is back after a lens switch");
  console.log("PASS the controlled terminal survives a lens switch");

  // a screen that fills the pane: a line that ends in the grid's last column, and the prompt on its last row
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("for i in $(seq 1 60); do echo hist-$i; done; printf '%*s\\n' $COLUMNS right-edge");
  await page.keyboard.press("Enter");
  const desktopGrid = await ptyGrid(page, "before");
  await page.keyboard.type("tail-marker");
  await until(async () => /right-edge[\s\S]*tail-marker/.test(await screen(page)), "the full screen reaches the controlled terminal");

  // A phone is a passive grid consumer: it must not resize the desktop-owned PTY or move
  // herdr's pane-global scroll offset, even while reading older, ANSI-coloured history.
  const nativeScroll = await paneScrollInfo(paneId);
  assert.equal(nativeScroll?.offset_from_bottom, 0, "the native pane starts at live bottom");
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const small = await phone.newPage();
  const phoneMessages: Array<{ type?: string; keep_size?: boolean }> = [];
  await small.routeWebSocket(/\/ws(\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message === "string") {
        try { phoneMessages.push(JSON.parse(message) as { type?: string; keep_size?: boolean }); } catch {}
      }
      upstream.send(message);
    });
  });
  small.on("pageerror", (error) => errors.push(error.message));
  small.setDefaultTimeout(10_000);
  await small.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await until(async () => (await screen(small)).includes("tail-marker"), "a phone-sized viewer gets the current controlled screen");
  const fittedControl = await scrollOf(small);
  assert.equal(fittedControl.adopted, true, "phone adopts the original pane grid");
  assert.equal(await small.locator(".pane-terminal").evaluate((host) => getComputedStyle(host).overflow), "auto");
  assert.ok(phoneMessages.some((message) => message.type === "attach" && message.keep_size === true), "phone attaches with keep_size");
  assert.equal(phoneMessages.filter((message) => message.type === "resize").length, 0, "phone never resizes the PTY");
  assert.equal((await paneScrollInfo(paneId))?.viewport_rows, nativeScroll?.viewport_rows, "phone join preserves the native row count");
  await small.locator(".pane-terminal").hover();
  await small.mouse.wheel(0, -1200);
  await until(async () => (await historyVisible(small)) > 0 && (await historyScreen(small)).includes("hist-"), "wheel up shows private ANSI history");
  assert.equal(await small.evaluate(() => {
    const pane = document.querySelector(".pane-terminal")!.getBoundingClientRect();
    const overlay = document.querySelector(".pane-terminal-local-history")!.getBoundingClientRect();
    return Math.abs(pane.top - overlay.top) <= 2 && Math.abs(pane.left - overlay.left) <= 2
      && Math.abs(pane.width - overlay.width) <= 2 && Math.abs(pane.height - overlay.height) <= 2;
  }), true, "private history remains pinned to the phone viewport even when the adopted grid scrolls");
  await small.mouse.wheel(0, -4000);
  await until(async () => await small.locator(".pane-terminal-local-history .xterm-rows span[class*='xterm-fg-1']", { hasText: "red-cell" }).count() > 0,
    "retained history preserves old ANSI red text");
  assert.equal((await paneScrollInfo(paneId))?.offset_from_bottom, 0, "phone history never moves native scrollback");
  assert.equal(phoneMessages.filter((message) => message.type === "scroll" || message.type === "resize").length, 0, "passive history sends no shared scroll or resize");
  assert.ok((await screen(page)).includes("tail-marker"), "desktop view stays at live bottom while phone scrolls");
  if (evidence) await small.screenshot({ path: join(evidence, "windows-control-phone-history.png") });
  await small.mouse.wheel(0, 1200);
  await until(async () => (await historyVisible(small)) === 0 && (await screen(small)).includes("tail-marker"), "wheel down returns to the live bottom");
  assert.equal((await paneScrollInfo(paneId))?.offset_from_bottom, 0);
  assert.equal(phoneMessages.filter((message) => message.type === "resize").length, 0);
  assert.equal((await scrollOf(small)).left, fittedControl.left, "local history does not pan the horizontal grid");
  assert.equal(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0), true, "the page itself never scrolls");
  await page.keyboard.press("Control+u"); // discard the unsubmitted tail-marker before the next shell command
  assert.equal(await ptyGrid(page, "after"), desktopGrid, "the desktop PTY geometry survives the phone session");
  const phoneLine = small.getByRole("textbox", { name: "Terminal input line", exact: true });
  await phoneLine.fill("echo phone-input-ok");
  await phoneLine.press("Enter");
  await until(async () => (await screen(page)).includes("phone-input-ok"), "phone can still send input at live bottom");

  // Mouse-aware TUIs keep their semantic wheel events; only ordinary host history is local.
  await page.keyboard.type("printf '\\033[?1000hmouse-mode-ready\\n'");
  await page.keyboard.press("Enter");
  await until(async () => (await screen(small)).includes("mouse-mode-ready"), "phone sees mouse reporting enabled");
  await small.mouse.wheel(0, -120);
  await until(async () => phoneMessages.some((message) => message.type === "scroll"), "TUI mouse reporting still sends semantic scroll");
  const tuiScrollCount = phoneMessages.filter((message) => message.type === "scroll").length;
  await page.keyboard.type("printf '\\033[?1000l\\033[?1049halt-mode-ready\\n'");
  await page.keyboard.press("Enter");
  await until(async () => (await screen(small)).includes("alt-mode-ready"), "phone sees alternate buffer");
  await small.mouse.wheel(0, -120);
  await until(async () => phoneMessages.filter((message) => message.type === "scroll").length > tuiScrollCount, "alternate screen keeps semantic scroll");
  assert.equal(await historyVisible(small), 0, "TUI scrolling never opens history overlay");
  assert.equal(phoneMessages.filter((message) => message.type === "resize").length, 0, "TUI operation does not resize shared pane");
  await page.keyboard.type("printf '\\033[?1049l'");
  await page.keyboard.press("Enter");
  console.log("PASS a Windows-style controller keeps its native geometry and scroll offset as a phone reads local history");
  await phone.close();

  // Direct attach also adopts the pane on touch; observers still pan an operator's full grid.
  const second = await workspaceCreate({ cwd, label: "herdr-web-ui-test-winlens-attach" });
  workspaces.push(second.workspace.workspace_id);
  const attached = second.root_pane.pane_id;
  attachServer = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-attach") });
  const attachOrigin = `http://127.0.0.1:${attachServer.port}`;
  const own = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mine = await own.newPage();
  mine.on("pageerror", (error) => errors.push(error.message));
  mine.setDefaultTimeout(10_000);
  await mine.goto(`${attachOrigin}/?pane=${encodeURIComponent(attached)}`);
  const line = mine.getByRole("textbox", { name: "Terminal input line", exact: true });
  await line.fill("for i in $(seq 1 200); do echo hist-$i; done");
  await line.press("Enter");
  await until(async () => (await screen(mine)).includes("hist-200"), "the attached pane's output");
  const fitted = await scrollOf(mine);
  assert.equal(fitted.adopted, true, "direct-attach phone adopts herdr's native grid");
  assert.equal(await mine.locator(".pane-terminal").evaluate((host) => getComputedStyle(host).overflow), "auto");
  const directScroll = await paneScrollInfo(attached);
  await dragUntil(mine, 0, 300, async () => (await historyVisible(mine)) > 0 && (await historyScreen(mine)).includes("hist-"), "a drag down browses local history");
  assert.equal((await paneScrollInfo(attached))?.offset_from_bottom, directScroll?.offset_from_bottom, "direct-attach phone does not move herdr scroll");
  assert.equal((await scrollOf(mine)).left, fitted.left, "vertical history swipes do not pan the mount");
  if (evidence) await mine.screenshot({ path: join(evidence, "attach-phone-history.png") });
  console.log("PASS direct-attach phone swipes use isolated history, not global pane scroll");
  await own.close();

  const operator = await context.newPage();
  operator.on("pageerror", (error) => errors.push(error.message));
  await operator.goto(`${attachOrigin}/?pane=${encodeURIComponent(attached)}`);
  // typed before the terminal is attached, it would be held as a draft
  await operator.locator(".conn-live").waitFor();
  await until(async () => (await screen(operator)).includes("hist-"), "the operator's terminal is attached");
  await operator.locator(".xterm-helper-textarea").focus();
  await operator.keyboard.type("clear; for i in $(seq 1 60); do echo hist-$i; done; printf '%*s\\n' $COLUMNS right-edge");
  await operator.keyboard.press("Enter");
  await until(async () => (await screen(operator)).includes("right-edge"), "the operator's screen");
  const watch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const observer = await watch.newPage();
  observer.on("pageerror", (error) => errors.push(error.message));
  observer.setDefaultTimeout(10_000);
  // the app has no control for the role: the role frame its socket opens with is sent as an observer's
  await observer.routeWebSocket(/\/ws(\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const role = typeof message === "string" && (JSON.parse(message) as { type?: string }).type === "role";
      upstream.send(role ? JSON.stringify({ type: "role", mode: "observe" }) : message);
    });
  });
  await observer.goto(`${attachOrigin}/?pane=${encodeURIComponent(attached)}`);
  await observer.locator(".terminal-banner-observe").waitFor();
  await until(async () => (await screen(observer)).includes("right-edge"), "the observer gets the operator's screen");
  await until(async () => (await scrollOf(observer)).adopted, "the observer's mount pans");
  if (evidence) await observer.screenshot({ path: join(evidence, "observe-phone.png") });
  // the cursor's row (the operator's prompt) is what the view opens on
  await until(() => observer.locator(".xterm-cursor").first().evaluate((cursor) => {
    const host = document.querySelector(".pane-terminal")!.getBoundingClientRect();
    const at = cursor.getBoundingClientRect();
    return at.top >= host.top - 1 && at.bottom <= host.bottom + 1;
  }), "an observer's view opens on the cursor's row");
  assert.equal(shown(await inset(observer, "right-edge")), false, "the operator's grid is wider than the phone");
  await dragUntil(observer, -300, 0, async () => shown(await inset(observer, "right-edge")), "an observer pans to the operator's last column");
  if (evidence) await observer.screenshot({ path: join(evidence, "observe-phone-panned-right.png") });
  await dragUntil(observer, 300, 300, async () => { const at = await scrollOf(observer); return at.left === 0 && at.top === 0; }, "and back to the first cell");
  console.log("PASS an observer on a phone pans the operator's grid");
  await watch.close();
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  attachServer?.stop();
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
