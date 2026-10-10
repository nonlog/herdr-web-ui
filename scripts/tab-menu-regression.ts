/**
 * The menu of a tab of two panes, which lists the panes, herdr's layout operations and the tab's
 * own actions: a dozen items under the layout map. On a 1280x800 screen the popover is as tall as
 * its items, every one of them on the screen with nothing to scroll (it was capped at 320px, which
 * cut Zoom pane off); a press on a cell of the map keeps the menu open, as RowMenu's own items do
 * for Safari, and the click opens that pane; on a phone the sheet's actions scroll between its
 * head and Cancel, which stay on the screen, so the last of them is reachable by touch on a
 * 320x640 screen. Review of #726.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { paneSplit, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const TAB = "Tab 1";
const MENU_TITLE = `Panes in ${TAB}`;
const evidence = process.env.UI_EVIDENCE_DIR;

async function rect(locator: Locator, label: string): Promise<{ top: number; bottom: number; left: number; right: number; height: number }> {
  const found = await locator.boundingBox();
  assert.ok(found, `${label} is on the page`);
  return { top: found.y, bottom: found.y + found.height, left: found.x, right: found.x + found.width, height: found.height };
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `tab-menu-${name}.png`), animations: "disabled" });
}

async function openApp(page: Page, origin: string, pane: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.getByRole("tab", { name: TAB, exact: true }).waitFor();
  return errors;
}

/** The popover on a desktop screen: every item in view, and the map's press and click. */
async function checkDesktopMenu(browser: Browser, origin: string, pane: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
  });
  try {
    const page = await context.newPage();
    const errors = await openApp(page, origin, pane);
    const tab = page.getByRole("tab", { name: TAB, exact: true });
    const menu = page.getByRole("menu", { name: MENU_TITLE, exact: true });
    const open = async (): Promise<void> => {
      await tab.click({ button: "right" });
      await menu.waitFor();
      await menu.locator('.layout-map-cell[aria-current="true"]').waitFor();
    };
    await open();
    const labels = await menu.locator('[role="menuitem"], [role="menuitemcheckbox"]').allTextContents();
    assert.ok(labels.includes("Zoom pane") && labels.at(-1) === "Close tab", `a two-pane tab's menu lists herdr's layout operations down to Close tab (${labels.join(", ")})`);
    const fit = await menu.evaluate((node) => ({
      clipped: [...node.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')]
        .filter((item) => { const box = item.getBoundingClientRect(); return box.top < 0 || box.bottom > window.innerHeight; })
        .map((item) => item.textContent),
      scrolls: node.scrollHeight > node.clientHeight + 1,
      height: Math.round(node.getBoundingClientRect().height),
    }));
    assert.deepEqual(fit.clipped, [], "on a 1280x800 screen every item of the menu is on the screen");
    assert.equal(fit.scrolls, false, `the menu is as tall as its items (${fit.height}px), with nothing to scroll`);
    await screenshot(page, "1280");

    // the map at the head: one cell per pane, the open pane marked
    const cells = menu.locator(".layout-map-cell");
    assert.equal(await cells.count(), 2, "the map has a cell per pane");
    const current = menu.locator('.layout-map-cell[aria-current="true"]');
    const other = menu.locator(".layout-map-cell:not([aria-current])");
    assert.equal(await current.count(), 1, "one cell is the open pane");
    const otherLeft = await other.evaluate((cell) => (cell as HTMLElement).style.left);
    assert.notEqual(otherLeft, await current.evaluate((cell) => (cell as HTMLElement).style.left), "the two cells stand side by side");
    // Safari on a Mac does not focus a pressed button, so a press that is let through blurs the
    // focused item with no relatedTarget and closes the menu before the click lands: the press is
    // cancelled, as RowMenu's own items cancel theirs
    const kept = await other.evaluate((cell) => !cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    assert.equal(kept, true, "a press on a map cell keeps the focus where it is");
    assert.equal(await menu.isVisible(), true, "the menu stays open through the press");
    await other.click();
    await menu.waitFor({ state: "detached" });
    await open();
    assert.equal(await menu.locator('.layout-map-cell[aria-current="true"]').evaluate((cell) => (cell as HTMLElement).style.left), otherLeft, "the pane pressed on the map is the open one");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

/** The sheet on a phone: held to the screen, its actions scrolling between the head and Cancel. */
async function checkPhoneSheet(browser: Browser, origin: string, pane: string, viewport: { width: number; height: number }, scrolls: boolean): Promise<void> {
  const label = `a ${viewport.width}x${viewport.height} phone`;
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, locale: "en-US" });
  await context.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
  });
  try {
    const page = await context.newPage();
    const errors = await openApp(page, origin, pane);
    await page.getByRole("button", { name: MENU_TITLE, exact: true }).tap();
    const sheet = page.getByRole("dialog", { name: MENU_TITLE, exact: true });
    await sheet.waitFor();
    const items = sheet.locator(".row-sheet-items");
    const cancel = sheet.getByRole("button", { name: "Cancel", exact: true });
    const last = sheet.locator(".row-sheet-item").last();
    assert.equal(await last.textContent(), "Close tab", `${label}: the sheet ends its actions with Close tab`);
    const sheetBox = await rect(sheet, "the sheet");
    assert.ok(sheetBox.top >= 0 && sheetBox.bottom <= viewport.height + 1, `${label}: the sheet is held to the screen (${sheetBox.top}..${sheetBox.bottom})`);
    const cancelBox = await rect(cancel, "Cancel");
    assert.ok(cancelBox.bottom <= viewport.height + 1, `${label}: Cancel stays on the screen (${cancelBox.bottom})`);
    const box = await items.evaluate((node) => ({
      overflow: getComputedStyle(node).overflowY,
      scrolls: node.scrollHeight > node.clientHeight + 1,
      bottom: node.getBoundingClientRect().bottom,
    }));
    assert.ok(box.overflow === "auto" || box.overflow === "scroll", `${label}: the actions are the sheet's scroll box (overflow-y ${box.overflow})`);
    assert.ok(box.bottom <= cancelBox.top + 1, `${label}: the actions end above Cancel (${box.bottom} vs ${cancelBox.top})`);
    if (scrolls) {
      assert.equal(box.scrolls, true, `${label}: a dozen actions are taller than the room between the head and Cancel, so they scroll`);
      assert.ok((await rect(last, "Close tab")).top >= box.bottom - 1, `${label}: Close tab starts below the fold`);
    }
    await screenshot(page, String(viewport.width));
    // the last actions are reachable by touch once scrolled to
    await items.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.waitForFunction(([itemsSelector, cancelSelector]) => {
      const box = document.querySelector(itemsSelector)?.getBoundingClientRect();
      const item = [...document.querySelectorAll(".row-sheet-item")].at(-1)?.getBoundingClientRect();
      const cancel = document.querySelector(cancelSelector)?.getBoundingClientRect();
      return !!box && !!item && !!cancel && item.bottom <= box.bottom + 1 && item.bottom <= cancel.top + 1;
    }, [".row-sheet-items", ".row-sheet-cancel"] as const);
    await sheet.locator(".row-sheet-item", { hasText: "Rename tab" }).tap();
    const name = page.getByRole("textbox", { name: "Tab name", exact: true });
    await name.waitFor();
    await page.keyboard.press("Escape");
    await name.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

/** The tab menu over a workspace of one tab split in two. */
export async function checkTabMenu(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-web-ui-tab-menu-")));
  let workspaceId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-tab-menu" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    await paneSplit(first, "right", false);
    await checkDesktopMenu(browser, origin, first);
    await checkPhoneSheet(browser, origin, first, { width: 390, height: 844 }, false);
    await checkPhoneSheet(browser, origin, first, { width: 320, height: 640 }, true);
    console.log("PASS a two-pane tab's menu shows every item on a 1280x800 screen, opens the pane pressed on its map, and scrolls its actions on a short phone");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "herdr-web-ui-tab-menu-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    await checkTabMenu(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
