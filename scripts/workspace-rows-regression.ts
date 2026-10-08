/** Owned, real-browser regression of the sidebar's workspace rows. Run after `bun run build`. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { HerdrError, herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";

type State = {
  readonly selector: string;
  readonly count?: number;
  readonly attribute?: readonly [string, string];
  readonly text?: string;
};

declare global {
  interface Window {
    workspaceRowsState?: Promise<boolean>;
  }
}

/** Register before the action; only DOM mutations, never intervals, drive the wait. */
async function armState(page: Page, states: readonly State[]): Promise<void> {
  await page.evaluate((conditions) => {
    window.workspaceRowsState = new Promise<boolean>((resolve) => {
      const matches = (): boolean => conditions.every(({ selector, count, attribute, text }) => {
        const nodes = document.querySelectorAll(selector);
        if (count !== undefined && nodes.length !== count) return false;
        if (attribute && nodes[0]?.getAttribute(attribute[0]) !== attribute[1]) return false;
        if (text !== undefined && nodes[0]?.textContent !== text) return false;
        return count !== undefined || nodes.length > 0;
      });
      const finish = (matched: boolean): void => {
        observer.disconnect();
        document.removeEventListener("focusin", check);
        clearTimeout(timeout);
        resolve(matched);
      };
      const check = (): void => { if (matches()) finish(true); };
      const observer = new MutationObserver(check);
      const timeout = window.setTimeout(() => finish(false), 15_000);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      document.addEventListener("focusin", check);
      if (matches()) finish(true);
    });
  }, states);
}

async function stateReceived(page: Page, label: string): Promise<void> {
  assert.equal(await page.evaluate(() => window.workspaceRowsState), true, `Timed out: ${label}`);
}

async function changeState(page: Page, states: readonly State[], action: () => Promise<unknown>, label: string): Promise<void> {
  await armState(page, states);
  await action();
  await stateReceived(page, label);
}

const paneSelector = (paneId: string): string => `.pane-select[title^=${JSON.stringify(`${paneId} —`)}]`;
const itemSelector = (paneId: string): string => `.pane-item:has(${paneSelector(paneId)})`;
const workspaceSelector = (workspaceId: string): string => `.workspace-group[data-workspace=${JSON.stringify(workspaceId)}]`;
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-workspace-rows-regression-")));
// These accumulators contain only IDs created by this invocation.
const ownedWorkspaces: string[] = [];
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;

try {
  // test-herdr has live/unit escape hatches and a no-binary fallback. Never let
  // any of those silently target the user's current socket.
  assert.notEqual(process.env.HERDR_TEST_LIVE, "1", "Live-session mode is forbidden");
  assert.notEqual(process.env.HERDR_TEST_MODE, "unit", "This regression requires isolated herdr");
  process.env.HERDR_TEST_SESSION = "herdr-web-ui-test";
  const { testSocketPath } = await import("./test-herdr.ts");
  assert.equal(process.env.HERDR_SOCKET, testSocketPath(), "test-herdr must select its isolated socket");

  // Given two independent workspaces at one full cwd, a third whose folder has the same
  // basename, and a fourth alone in its folder. No agent or shell input is started.
  const sharedCwd = join(root, "left", "project");
  const otherCwd = join(root, "right", "project");
  const loneCwd = join(root, "lone");
  for (const cwd of [sharedCwd, otherCwd, loneCwd]) mkdirSync(cwd, { recursive: true });
  const fixtures = [];
  for (const [cwd, label] of [
    [sharedCwd, "workspace-rows-alpha"],
    [sharedCwd, "workspace-rows-beta"],
    [otherCwd, "workspace-rows-other-parent"],
    [loneCwd, "workspace-rows-lone"],
  ] as const) {
    const created = await workspaceCreate({ cwd, label });
    ownedWorkspaces.push(created.workspace.workspace_id);
    fixtures.push({ cwd, label, workspaceId: created.workspace.workspace_id, paneId: created.root_pane.pane_id });
  }
  const [alpha, beta, other, lone] = fixtures;
  assert.ok(alpha && beta && other && lone);
  assert.notEqual(alpha.workspaceId, beta.workspaceId, "same cwd must still own independent workspaces");
  const split = await herdrRpc<{ pane: { pane_id: string } }>("pane.split", {
    target_pane_id: other.paneId, direction: "down", focus: false, cwd: otherCwd,
  });
  const workspaceFoldKey = `herdr-web-ui:workspace-collapsed:local:${other.workspaceId}`;
  server = createServer({
    port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null,
    stateDir: join(root, "state"), codexHome: join(root, "codex"),
    usage: new UsageService(undefined, []),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/opt/google/chrome/chrome"),
    headless: true, args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript(({ ids, legacyFoldKey }) => {
    // Browser locale alone does not override the app's remembered language.
    // Preserve a language changed through Settings across subsequent reloads.
    if (!localStorage.getItem("herdr-web-ui:settings")) {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertsOn: false }));
      localStorage.setItem(legacyFoldKey, "1");
    }
    for (const id of ids) localStorage.setItem(`herdr-web-ui:view:${id}`, "chat");
  }, { ids: [...fixtures.map(({ paneId }) => paneId), split.pane.pane_id], legacyFoldKey: workspaceFoldKey });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));

  const navigate = async (action: () => Promise<unknown>, paneId: string): Promise<void> => {
    // Register the exact network signal before replacing the document. DOM
    // readiness then comes from Playwright's attached-state signal.
    const snapshot = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/machines" && response.ok());
    await action();
    await snapshot;
    await page.locator(`${paneSelector(paneId)}[aria-current="true"]`).waitFor({ state: "attached" });
  };
  const evidence = process.env.UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const screenshot = async (name: string): Promise<void> => {
    if (evidence) await page.screenshot({ path: join(evidence, `workspace-rows-${name}.png`), animations: "disabled" });
  };
  // the workspace with two panes in one tab: one row, whose strip and pane picker reach the second
  const otherWorkspace = workspaceSelector(other.workspaceId);

  await navigate(() => page.goto(`${origin}/?pane=${encodeURIComponent(lone.paneId)}`), lone.paneId);
  await page.locator(paneSelector(other.paneId)).waitFor({ state: "attached" });
  // one row per workspace, as herdr's Spaces sidebar: the split pane has no row of its own, the
  // workspace's selector follows its current pane while its visible name stays fixed.
  assert.equal(await page.locator(otherWorkspace).count(), 1, "a workspace with two panes is one row");
  assert.equal(await page.locator(paneSelector(split.pane.pane_id)).count(), 0);
  assert.equal(await page.locator(".workspace-toggle").count(), 0, "a legacy workspace fold has nothing to fold");
  assert.equal(await page.locator(".workspace-contents, .sidebar-tab-heading, .sidebar-pane-item").count(), 0,
    "tabs and panes are navigated above the terminal rather than as workspace children");
  assert.equal(await page.locator(".tab-strip").count(), 0, "no strip over a lone pane's workspace");
  for (const fixture of [alpha, beta]) {
    const workspace = workspaceSelector(fixture.workspaceId);
    assert.equal(await page.locator(`${workspace} > .workspace-header`).count(), 1);
    assert.equal(await page.locator(`${workspace} .workspace-name`).textContent(), fixture.label,
      "workspaces sharing a folder retain independent workspace names");
    assert.equal(await page.locator(`${workspace} .workspace-toggle`).count(), 0);
    assert.equal(await page.locator(`${itemSelector(fixture.paneId)} .sidebar-drag-handle`).count(), 0,
      "workspace rows have no separate reorder grip column");
    assert.equal(await page.locator(paneSelector(fixture.paneId)).getAttribute("draggable"), "true",
      "the workspace row itself supports dragging");
  }
  // A fold stored while a single pane had a heading (0.3.44) must not hide a row that has no toggle.
  const singleFoldKey = `herdr-web-ui:workspace-collapsed:local:${alpha.workspaceId}`;
  await page.evaluate((key) => localStorage.setItem(key, "1"), singleFoldKey);
  await navigate(() => page.reload(), lone.paneId);
  await page.locator(paneSelector(alpha.paneId)).waitFor({ state: "visible" });
  assert.equal(await page.locator(`.workspace:has(${paneSelector(alpha.paneId)}) .workspace-toggle`).count(), 0);
  await page.evaluate((key) => localStorage.removeItem(key), singleFoldKey);
  // the second pane of a split tab is reached from the strip over the pane: its tab carries a
  // picker, which lists both panes and opens the other one; the row then shows that pane
  await changeState(page, [{ selector: paneSelector(other.paneId), attribute: ["aria-current", "true"] }, { selector: '.tab-strip [role="tab"]', count: 1 }],
    () => page.locator(paneSelector(other.paneId)).click(), "selecting the split workspace shows its strip");
  assert.equal(await page.locator('.tab-strip [role="tab"]').textContent(), "Tab 1", "a tab herdr named by its number reads as Tab 1");
  // at this width the header over the pane is the pane's surface, and the strip under it is
  // the same one, not a band of the panel's colour between header and pane
  const surfaces = await page.evaluate(() => {
    const header = document.querySelector(".app-header")!;
    const column = document.querySelector(".pane-column")!;
    return {
      headerChat: header.classList.contains("is-chat"), columnChat: column.classList.contains("is-chat"),
      header: getComputedStyle(header).backgroundColor, strip: getComputedStyle(document.querySelector(".tab-strip")!).backgroundColor,
      chat: document.querySelector(".chat-view") ? getComputedStyle(document.querySelector(".chat-view")!).backgroundColor : null,
    };
  });
  assert.equal(surfaces.columnChat, surfaces.headerChat, "the header and the pane column agree on the lens");
  assert.equal(surfaces.strip, surfaces.header, "the strip is the header's surface");
  if (surfaces.headerChat) assert.equal(surfaces.chat, surfaces.header, "which under the chat lens is the transcript's");
  await page.locator(".tab-strip-panes").click();
  const picker = page.getByRole("menu", { name: "Panes in Tab 1", exact: true });
  await picker.waitFor();
  // both panes, then the tab's own Rename tab and Close tab
  assert.deepEqual((await picker.getByRole("menuitem").allTextContents()).slice(2), ["Rename tab", "Close tab"]);
  assert.equal(await picker.getByRole("menuitem").count(), 4);
  assert.equal(await picker.locator('[role="menuitem"][aria-current="true"]').count(), 1, "the picker marks the open pane");
  await changeState(page, [{ selector: `${paneSelector(split.pane.pane_id)}[aria-current="true"]` }, { selector: paneSelector(other.paneId), count: 0 }],
    () => picker.getByRole("menuitem").nth(1).click(), "the picker opens the split pane, and the row follows it");
  assert.equal(await page.locator(otherWorkspace).count(), 1);
  assert.equal(await page.locator(`${otherWorkspace} .workspace-name`).textContent(), other.label,
    "selecting a split pane keeps the workspace label in Spaces");
  await page.locator(`${otherWorkspace} .row-menu-toggle`).click();
  assert.deepEqual(await page.getByRole("menu").getByRole("menuitem").allTextContents(),
    ["Rename workspace", "Rename pane", "New tab", "New worktree", "Open worktree…", "Close workspace"],
    "a workspace row exposes both explicit rename scopes and workspace operations");
  await changeState(page, [{ selector: ".pane-rename-input:focus" }],
    () => page.getByRole("menuitem", { name: "Rename pane", exact: true }).click(), "rename targets the representative pane");
  const renamedSplit = "workspace-rows-split-task";
  await page.locator(".pane-rename-input").fill(renamedSplit);
  const splitRenameResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/pane/rename")
    && response.request().postDataJSON().pane_id === split.pane.pane_id);
  await changeState(page, [{ selector: ".pane-rename-input", count: 0 }],
    () => page.locator(".pane-rename-input").press("Enter"), "the representative pane is renamed");
  assert.equal((await splitRenameResponse).status(), 200);
  assert.equal((await sessionSnapshot()).panes.find((pane) => pane.pane_id === split.pane.pane_id)?.label, renamedSplit);
  assert.equal(await page.locator(`${otherWorkspace} .workspace-name`).textContent(), other.label,
    "renaming a pane leaves the workspace's displayed name unchanged");
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    if (await page.locator(".drawer-toggle").isVisible()
      && await page.locator(".drawer-toggle").getAttribute("aria-expanded") !== "true") {
      await changeState(page, [{ selector: "#workspace-drawer.is-open" }],
        () => page.locator(".drawer-toggle").click(), `workspace drawer opens at ${width}`);
    }
    assert.equal(await page.locator(paneSelector(split.pane.pane_id)).isVisible(), true);
    await screenshot(`workspace-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  if (await page.locator(".drawer-toggle").isVisible() && await page.locator(".drawer-toggle").getAttribute("aria-expanded") === "true") await page.locator(".drawer-toggle").click();
  assert.deepEqual(errors, [], "no browser page errors");
  console.log("PASS one row per workspace, its split pane reached from the tab strip, and rename scopes kept apart");
} finally {
  // Attempt every cleanup even if an earlier teardown fails; never close an
  // unowned resident workspace from test-herdr or any other invocation.
  const cleanupErrors: unknown[] = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  try { server?.stop(); } catch (error) { cleanupErrors.push(error); }
  for (const id of ownedWorkspaces) {
    try { await workspaceClose(id); } catch (error) {
      // Closing the last pane can already have removed its workspace.
      if (!(error instanceof HerdrError && error.code === "workspace_not_found")) cleanupErrors.push(error);
    }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    console.error(new AggregateError(cleanupErrors, "Workspace rows regression cleanup failed"));
    process.exitCode = 1;
  }
}
