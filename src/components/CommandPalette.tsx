import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Bell, Columns2, FolderOpen, LoaderCircle, LockKeyhole, Maximize2, MessageSquarePlus, Minimize2, Monitor, PanelLeft, Plus, Puzzle, RefreshCw, Rows2, Settings, SunMoon, SwitchCamera, X } from "lucide-react";

import "./CommandPalette.css";

import type { HerdrPane, PluginActions, SessionSnapshot } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { paneStatus, STATUS_WORD } from "../lib/status.ts";
import { zoomMode } from "../lib/layoutMap.ts";
import type { AppActions, PaneView } from "../lib/actions.ts";
import { FILTER_KEYS, filterPanesByStatus, groupByWorkspace, offeredPluginActions, parseQuery, rankPanes, recentPanes, STATUS_FILTERS, statusCounts, type OfferedPluginAction, type PaletteStatusFilter } from "../lib/paletteSearch.ts";
import { Ownership, runPluginActionToEnd } from "../lib/pluginRun.ts";
import { shortcutDisplayKeys, formatKeys, type ShortcutId } from "../lib/shortcuts.ts";
import { useSettings } from "../lib/settings.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import { folderName, placeLine } from "../lib/paneName.ts";
import { agentTabName } from "../lib/sidebarAgents.ts";
import { tabLabel } from "../lib/tabName.ts";
import { useT } from "../lib/i18n.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useWorktreeBranches } from "../lib/useWorktreeBranches.ts";
import { worktreeLabel } from "../lib/worktreeName.ts";

const RECENT_KEY = "herdr-web-ui:recent-panes";
const RECENT_LIMIT = 8;
const RECENT_SHOWN = 3;

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  snapshot: SessionSnapshot | null;
  online: boolean;
  selectedPaneId: string | null;
  view: PaneView;
  actions: AppActions;
}

interface PaletteAction {
  id: string;
  label: string;
  icon: ComponentType;
  shortcut?: ShortcutId;
  run: () => void;
}

interface PaneRow { kind: "pane"; pane: HerdrPane }
interface ActionRow { kind: "action"; action: PaletteAction }
interface PluginRow { kind: "plugin"; offered: OfferedPluginAction }
type PaletteRow = PaneRow | ActionRow | PluginRow;

interface PaletteSectionView {
  id: string;
  heading: string;
  branch: string | null;
  placeNamesWorkspace: boolean;
  rows: PaletteRow[];
}

/**
 * The picked row, by what it is (its section and its pane or action) and by where it stood. A
 * roster change that moves the row (a pane before it left the filter) carries the pick with it
 * and tells its place again; one that takes the row away leaves the pick on the row now at its
 * place, among the rows that stayed, so the keyboard loses nothing.
 */
interface PaletteSelection {
  key: string | null;
  index: number;
}

const NO_SELECTION: PaletteSelection = { key: null, index: 0 };

/** `<plugin_id>.<action_id>`: the row's identity, and the name of the run under way. */
function pluginActionKey({ plugin, action }: OfferedPluginAction): string {
  return `${plugin.plugin_id}.${action.action_id}`;
}

function rowKey(sectionId: string, row: PaletteRow): string {
  return `${sectionId}:${row.kind === "pane" ? row.pane.pane_id : row.kind === "action" ? row.action.id : pluginActionKey(row.offered)}`;
}

function loadRecentPanes(machineId: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(machineId === "local" ? RECENT_KEY : `${RECENT_KEY}:${machineId}`) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberPane(paneId: string, current: readonly string[], machineId: string): string[] {
  const recent = [paneId, ...current.filter((id) => id !== paneId)].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(machineId === "local" ? RECENT_KEY : `${RECENT_KEY}:${machineId}`, JSON.stringify(recent));
  } catch {
    /* private mode: recent ordering remains available for this page */
  }
  return recent;
}

function panePath(pane: HerdrPane): string {
  return pane.foreground_cwd ?? pane.cwd ?? "";
}

/** A linked worktree's branch, when the workspace's name does not already say it (as the sidebar shows it). */
function branchBeside(label: string, branch: string | null | undefined): string | null {
  if (!branch || branch === label || worktreeLabel(branch) === label) return null;
  return branch;
}

function ShortcutHint({ shortcutId }: { shortcutId?: ShortcutId }) {
  const { settings } = useSettings();
  if (!shortcutId) return null;
  const keys = formatKeys(shortcutDisplayKeys(shortcutId, settings.shortcutOverrides));
  if (keys.length === 0) return null;
  return <span className="palette-shortcut" aria-label={keys.join(" + ")}>{keys.map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</span>;
}

export function CommandPalette({ open, onClose, snapshot, online, selectedPaneId, view, actions }: CommandPaletteProps) {
  const t = useT();
  const machineId = useMachineId();
  const api = useMachineApi();
  const touch = useMediaQuery("(pointer: coarse)");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PaletteStatusFilter>("all");
  const [selection, setSelection] = useState<PaletteSelection>(NO_SELECTION);
  const [plugins, setPlugins] = useState<PluginActions[]>([]);
  /** `<plugin_id>.<action_id>` of the plugin action under way; the palette stays open until it answers */
  const [running, setRunning] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  /** one claim per opening: an answer that arrives after the palette closed, or left for another PC, belongs to no one */
  const owner = useRef<Ownership | null>(null);
  owner.current ??= new Ownership();
  const [recentPaneIds, setRecentPaneIds] = useState<string[]>(() => loadRecentPanes(machineId));
  const inputRef = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLElement>(open, { initialFocus: inputRef });
  const resultsRef = useRef<HTMLDivElement>(null);
  // a filter letter pressed over the list keeps the keyboard in the list: the first row takes the
  // focus once the filter is drawn, also when the letter named the filter already shown
  const [rowFocusRequest, setRowFocusRequest] = useState(0);
  // the row the focus is on, told from one the focus left, for a roster change that takes it out of the list
  const focusedRow = useRef<HTMLElement | null>(null);
  // the rows as the last roster listed them: where a row that left stood among the rows that stayed
  const previousRowKeys = useRef<readonly string[]>([]);
  // the branch inventory is read only while the palette is open: the sidebar keeps its own
  const { branches } = useWorktreeBranches(snapshot, open && online);

  // Terminal attachment can move focus after the palette opens. Escape belongs to
  // this modal even then, and must not leak through to the underlying terminal.
  useLayoutEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open, onClose]);

  // In the opening commit: a passive effect leaves a render of the last search's results until a later
  // task, where a quick Tab focuses a row at an index the full list then gives to another row (#608).
  useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("all");
    setSelection(NO_SELECTION);
    focusedRow.current = null;
    setRecentPaneIds(loadRecentPanes(machineId));
  }, [open]);

  // The PC's plugin actions, read on each opening. A herdr with no plugins, an older bridge
  // without the route and an unreachable herdr all leave the group out. A layout effect: the
  // rows of the last opening are drawn again at once, and a tap on one must find this opening's
  // state, not a run left over from the last one nor a claim this effect is about to end.
  useLayoutEffect(() => {
    const claims = owner.current!;
    claims.end();
    setRunning(null);
    setPluginError(null);
    if (!open) return;
    const alive = claims.claim();
    void api.fetchPluginActions().then(
      (list) => { if (alive()) setPlugins(list); },
      () => { if (alive()) setPlugins([]); },
    );
    // also on unmount: App keys the palette by PC, and the answer of the PC left behind must
    // not select its pane ID on the PC now shown, nor close that PC's palette
    return () => claims.end();
  }, [open, api]);

  useEffect(() => {
    if (selectedPaneId === null) return;
    setRecentPaneIds((current) => rememberPane(selectedPaneId, current, machineId));
  }, [selectedPaneId]);

  // the selected pane's tab, for herdr's layout actions: a zoom means something only among several panes
  const selectedTab = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId)?.tab_id ?? null;
  const tabPanes = selectedTab === null ? 0 : (snapshot?.panes.filter((pane) => pane.tab_id === selectedTab).length ?? 0);
  const tabLayout = selectedTab === null ? undefined : snapshot?.layouts?.find((layout) => layout.tab_id === selectedTab);
  // the mode the zoom item names, never a toggle (lib/layoutMap.ts): herdr focuses the pane and
  // then sets the tab's flag, so a toggle on a pane other than the one shown alone would unzoom the tab
  const zoom = tabLayout !== undefined && selectedPaneId !== null ? zoomMode(tabLayout, selectedPaneId) : null;
  const { splitPane, zoomPane } = actions;

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: "new", label: t("New workspace"), icon: MessageSquarePlus, shortcut: "new-session", run: actions.openNewSession },
    // in the selected pane's workspace: nothing to add a tab to without one
    ...(selectedPaneId !== null ? [{ id: "new-tab", label: t("New tab"), icon: Plus, run: () => actions.openNewTab() }] : []),
    // herdr's prefix+v and prefix+-: the new pane is opened here only when asked, as herdr's --focus
    ...(splitPane ? [
      { id: "split-right", label: t("Split pane right"), icon: Columns2, run: () => splitPane("right") },
      { id: "split-down", label: t("Split pane down"), icon: Rows2, run: () => splitPane("down") },
      { id: "split-right-open", label: t("Split pane right and open it"), icon: Columns2, run: () => splitPane("right", true) },
      { id: "split-down-open", label: t("Split pane down and open it"), icon: Rows2, run: () => splitPane("down", true) },
    ] : []),
    ...(zoomPane && zoom && tabPanes > 1 ? [{ id: "zoom", label: t(zoom === "off" ? "Unzoom pane" : "Zoom pane"), icon: zoom === "off" ? Minimize2 : Maximize2, run: () => zoomPane(zoom) }] : []),
    { id: "view", label: t(view === "chat" ? "Switch to terminal" : "Switch to chat"), icon: SwitchCamera, shortcut: "toggle-view", run: actions.toggleView },
    { id: "sidebar", label: t("Toggle sidebar"), icon: PanelLeft, shortcut: "toggle-sidebar", run: actions.toggleSidebar },
    { id: "theme", label: t("Toggle theme"), icon: SunMoon, run: actions.toggleTheme },
    { id: "settings", label: t("Settings"), icon: Settings, shortcut: "settings", run: actions.openSettings },
    { id: "add-pc", label: t("Add PC"), icon: Monitor, run: actions.openAddPc },
    ...(actions.enableNotifications ? [{ id: "notifications", label: t("Enable notifications"), icon: Bell, run: actions.enableNotifications }] : []),
    ...(actions.lock ? [{ id: "lock", label: t("Sign out"), icon: LockKeyhole, run: actions.lock }] : []),
    ...(actions.openFiles ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: actions.openFiles }] : []),
    { id: "refresh", label: t("Refresh"), icon: RefreshCw, run: actions.refresh },
  ], [actions, splitPane, zoomPane, tabPanes, zoom, view, t, selectedPaneId]);

  const allPanes: readonly HerdrPane[] = snapshot?.panes ?? [];
  const workspaces = snapshot?.workspaces ?? [];
  const tabs = snapshot?.tabs ?? [];
  const counts = useMemo(() => statusCounts(allPanes), [allPanes]);
  const { actionsOnly, text } = parseQuery(query);

  // herdr's Goto picker: a row per pane under its workspace; `>` keeps the actions alone (T3 Code's
  // palette); a status filter is about panes, so it leaves the actions out, the plugins' with them;
  // the panes went to last lead an unsearched, unfiltered list
  const sections = useMemo<PaletteSectionView[]>(() => {
    const list: PaletteSectionView[] = [];
    if (!actionsOnly) {
      const panes = rankPanes(text, filterPanesByStatus(allPanes, filter), workspaces, { tabs, branches, t });
      if (text === "" && filter === "all") {
        const recent = recentPanes(panes, recentPaneIds, selectedPaneId, RECENT_SHOWN);
        if (recent.length > 0) list.push({ id: "recent", heading: t("Recent"), branch: null, placeNamesWorkspace: true, rows: recent.map((pane) => ({ kind: "pane", pane })) });
      }
      for (const group of groupByWorkspace(panes, workspaces, text !== "")) {
        const heading = group.workspace?.label ?? t("Unknown workspace");
        list.push({ id: group.workspaceId, heading, branch: branchBeside(heading, branches.get(group.workspaceId)?.branch), placeNamesWorkspace: false, rows: group.panes.map((pane) => ({ kind: "pane", pane })) });
      }
    }
    if (actionsOnly || filter === "all") {
      const needle = text.toLocaleLowerCase();
      const visible = needle ? paletteActions.filter((action) => action.label.toLocaleLowerCase().includes(needle)) : paletteActions;
      if (visible.length > 0) list.push({ id: "actions", heading: t("Actions"), branch: null, placeNamesWorkspace: false, rows: visible.map((action) => ({ kind: "action", action })) });
      const offered = offeredPluginActions(plugins, selectedPaneId !== null, text);
      if (offered.length > 0) list.push({ id: "plugins", heading: t("Plugin actions"), branch: null, placeNamesWorkspace: false, rows: offered.map((item) => ({ kind: "plugin", offered: item })) });
    }
    return list;
  }, [actionsOnly, text, filter, allPanes, workspaces, tabs, branches, recentPaneIds, selectedPaneId, paletteActions, plugins, t]);

  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const rowKeys = useMemo(() => sections.flatMap((section) => section.rows.map((row) => rowKey(section.id, row))), [sections]);
  const sectionStarts = useMemo(() => {
    const starts: number[] = [];
    let index = 0;
    for (const section of sections) { starts.push(index); index += section.rows.length; }
    return starts;
  }, [sections]);
  const itemCount = rows.length;
  // the picked row where it stands now, else the row at the pick's place (the last one when the list shrank under it)
  const pickedAt = selection.key === null ? -1 : rowKeys.indexOf(selection.key);
  const activeIndex = pickedAt >= 0 ? pickedAt : Math.min(selection.index, Math.max(0, itemCount - 1));

  // Arrow navigation keeps focus in the search field: aria-activedescendant alone does not
  // scroll its option into view, including when an arrow wraps to the other end of the list.
  // Rows take hover from mousemove, not mouseenter: a scroll under a resting pointer sends the
  // row now under it a mouseenter, which would replace the option the arrow picked.
  useLayoutEffect(() => {
    if (!open) return;
    resultsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, query, itemCount]);

  // The first row's focus event tells the pick only when the focus moves: a letter pressed on the
  // first row itself fires none, and a pick left on no row would go by its place to a pane that
  // enters before that row while the keyboard stays on it. So the pick is told here.
  useLayoutEffect(() => {
    if (!open || rowFocusRequest === 0) return;
    const first = document.getElementById("palette-item-0");
    if (!first) {
      inputRef.current?.focus();
      return;
    }
    const key = rowKeys[0] ?? null;
    setSelection((current) => (current.key === key && current.index === 0 ? current : { key, index: 0 }));
    first.focus();
  }, [rowFocusRequest]);

  // The roster changed under the pick. A picked row that stayed tells its place again; one that
  // left hands the pick to the row now at its place, counted over the rows before it that stayed
  // (its old place would be one row too low once a row before it had left earlier, or left with
  // it). A row that leaves the list while the focus is on it (its pane's status changed under a
  // filter) would leave the focus on the page body, where no palette key reaches: the row at the
  // pick's place takes it, the search when none is left. A row that stays keeps its element, and
  // with it the focus, by its key.
  useLayoutEffect(() => {
    const before = previousRowKeys.current;
    previousRowKeys.current = rowKeys;
    if (!open) return;
    let index = activeIndex;
    if (selection.key !== null) {
      const wasAt = pickedAt < 0 ? before.indexOf(selection.key) : -1;
      if (wasAt >= 0) {
        const stayed = new Set(rowKeys);
        index = Math.min(before.slice(0, wasAt).filter((key) => stayed.has(key)).length, Math.max(0, itemCount - 1));
      }
      const key = rowKeys[index] ?? null;
      if (key !== selection.key || index !== selection.index) setSelection({ key, index });
    }
    const row = focusedRow.current;
    if (!row || row.isConnected) return;
    focusedRow.current = null;
    (document.getElementById(`palette-item-${index}`) ?? inputRef.current)?.focus();
  }, [rowKeys]);

  if (!open) return null;

  const select = (index: number): void => {
    const key = rowKeys[index] ?? null;
    setSelection((current) => (current.key === key && current.index === index ? current : { key, index }));
  };
  const runPane = (pane: HerdrPane): void => {
    setRecentPaneIds((current) => rememberPane(pane.pane_id, current, machineId));
    actions.selectPane(pane.pane_id);
    onClose();
  };
  const runAction = (action: PaletteAction): void => {
    action.run();
    onClose();
  };
  const runPluginAction = async ({ plugin, action }: OfferedPluginAction): Promise<void> => {
    if (running !== null) return;
    const alive = owner.current!.claim();
    setRunning(pluginActionKey({ plugin, action }));
    setPluginError(null);
    try {
      // stays Running… past the server's own wait: a command that fails late is still said
      const result = await runPluginActionToEnd(api, { plugin_id: plugin.plugin_id, action_id: action.action_id, ...(selectedPaneId === null ? {} : { pane_id: selectedPaneId }) }, alive);
      if (result === null) return;
      if (result.status === "failed") {
        setPluginError(result.output !== null
          ? t("{action} failed: {detail}", { action: action.title, detail: result.output })
          : t("{action} failed (exit code {code})", { action: action.title, code: result.exit_code ?? "?" }));
        return;
      }
      if (result.opened_pane_id !== null) {
        // the pane may be newer than the snapshot on screen
        actions.refresh();
        actions.selectPane(result.opened_pane_id);
      }
      onClose();
    } catch (error) {
      if (!alive()) return;
      setPluginError(t("{action} failed: {detail}", { action: action.title, detail: error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error) }));
    } finally {
      if (alive()) setRunning(null);
    }
  };
  const activate = (index: number): void => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "pane") runPane(row.pane);
    else if (row.kind === "action") runAction(row.action);
    else void runPluginAction(row.offered);
  };
  const adjacentSectionStart = (index: number, direction: -1 | 1): number => {
    let current = 0;
    for (let section = 0; section < sectionStarts.length; section += 1) if (sectionStarts[section]! <= index) current = section;
    return sectionStarts[(current + direction + sectionStarts.length) % sectionStarts.length] ?? 0;
  };
  const applyFilter = (next: PaletteStatusFilter): void => {
    setFilter(next);
    setSelection(NO_SELECTION);
  };
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    // Candidate navigation and the committing Enter belong to the IME. WebKit can report
    // the latter after compositionend with isComposing false and key code 229.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown" && itemCount > 0) {
      event.preventDefault();
      select((activeIndex + 1) % itemCount);
    } else if (event.key === "ArrowUp" && itemCount > 0) {
      event.preventDefault();
      select((activeIndex - 1 + itemCount) % itemCount);
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && sectionStarts.length > 1) {
      // a caret inside the text keeps its own Left and Right; at the text's edge they walk the sections
      const input = event.currentTarget;
      const collapsed = input.selectionStart === input.selectionEnd;
      const atEdge = event.key === "ArrowLeft" ? input.selectionStart === 0 : input.selectionEnd === input.value.length;
      if (!collapsed || !atEdge) return;
      event.preventDefault();
      select(adjacentSectionStart(activeIndex, event.key === "ArrowLeft" ? -1 : 1));
    } else if (event.key === "Enter" && itemCount > 0) {
      event.preventDefault();
      activate(activeIndex);
    }
  };
  // herdr's picker keys, over the list and the chips but never in the search field: b, w, i, d and a
  // set the filter, `/` goes back to the search; arrows walk the rows and the sections by focus
  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || target === inputRef.current || event.ctrlKey || event.metaKey || event.altKey) return;
    const filterKey = FILTER_KEYS[event.key];
    if (filterKey) {
      event.preventDefault();
      applyFilter(filterKey);
      setRowFocusRequest((count) => count + 1);
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    const row = target.closest<HTMLElement>("[role=\"option\"]");
    if (!row || itemCount === 0) return;
    const index = Number(row.id.slice("palette-item-".length));
    const next = event.key === "ArrowDown" ? (index + 1) % itemCount
      : event.key === "ArrowUp" ? (index - 1 + itemCount) % itemCount
      : event.key === "ArrowRight" ? adjacentSectionStart(index, 1)
      : event.key === "ArrowLeft" ? adjacentSectionStart(index, -1)
      : null;
    if (next === null) return;
    event.preventDefault();
    document.getElementById(`palette-item-${next}`)?.focus();
  };
  const onChipsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = STATUS_FILTERS.indexOf(filter);
    const next = STATUS_FILTERS[(at + (event.key === "ArrowRight" ? 1 : -1) + STATUS_FILTERS.length) % STATUS_FILTERS.length]!;
    applyFilter(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-status="${next}"]`)?.focus();
  };
  const onChipClick = (event: ReactMouseEvent<HTMLButtonElement>, next: PaletteStatusFilter): void => {
    applyFilter(next);
    // a mouse goes back to typing; a finger would open the keyboard
    if (event.detail > 0 && !touch) inputRef.current?.focus();
  };

  // a tab is named as the tab strip names it: by its given name, else "Tab n" by its place. A row's
  // subtitle says it only where it tells panes apart (as the sidebar's agent rows do); the footer's
  // location always says it
  const tabOf = (pane: HerdrPane): { tab: (typeof tabs)[number] | undefined; place: number; all: typeof tabs } => {
    const all = tabs.filter((tab) => tab.workspace_id === pane.workspace_id);
    const tab = all.find((item) => item.tab_id === pane.tab_id);
    return { tab, place: tab ? all.indexOf(tab) + 1 : 0, all };
  };
  const tabName = (pane: HerdrPane): string | null => {
    const { tab, all } = tabOf(pane);
    return agentTabName(tab, all, t);
  };
  const activeRow = rows[activeIndex];
  const activeWorkspace = activeRow?.kind === "pane" ? workspaces.find((workspace) => workspace.workspace_id === activeRow.pane.workspace_id) : undefined;
  const activeTab = activeRow?.kind === "pane" ? tabOf(activeRow.pane) : undefined;
  const footerPlace = activeRow?.kind === "pane"
    ? [activeWorkspace?.label ?? t("Unknown workspace"), activeTab?.tab ? tabLabel(activeTab.tab, t, activeTab.place) : null].filter(Boolean).join(" › ")
    : activeRow?.kind === "action" ? activeRow.action.label
    : activeRow?.offered.action.title ?? "";
  const footerPath = activeRow?.kind === "pane" ? panePath(activeRow.pane) : "";

  const onSurfaceFocus = (event: ReactFocusEvent<HTMLElement>): void => {
    focusedRow.current = (event.target as HTMLElement).closest<HTMLElement>("[role=\"option\"]");
  };

  let rowIndex = 0;
  return (
    <div className="modal-scrim palette-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={surface} className="menu command-palette" role="dialog" aria-modal="true" aria-label={t("Command palette")} onKeyDown={onSurfaceKeyDown} onFocus={onSurfaceFocus}>
        <div className="palette-search">
          <input ref={inputRef} className="input" type="search" value={query} placeholder={t("Search panes and actions…")} aria-label={t("Search panes and actions")} aria-controls="palette-results" aria-activedescendant={itemCount ? `palette-item-${activeIndex}` : undefined} onKeyDown={onInputKeyDown} onChange={(event) => { setQuery(event.target.value); setSelection(NO_SELECTION); }} />
          <button type="button" className="icon-button" aria-label={t("Close command palette")} onClick={onClose}><X /></button>
        </div>
        {!actionsOnly && (
          <div className="palette-filters" role="radiogroup" aria-label={t("Filter panes by status")} onKeyDown={onChipsKeyDown}>
            {STATUS_FILTERS.map((status) => (
              <button key={status} type="button" role="radio" className="palette-filter" data-status={status} aria-checked={filter === status} tabIndex={filter === status ? 0 : -1} data-empty={counts[status] === 0 || undefined} onClick={(event) => onChipClick(event, status)}>
                <span className="palette-filter-word">{status === "all" ? t("All") : t(STATUS_WORD[status])}</span>
                <span className="palette-filter-count">{counts[status]}</span>
              </button>
            ))}
          </div>
        )}
        {pluginError !== null && <p className="palette-error" role="alert">{pluginError}</p>}
        <div ref={resultsRef} className="palette-results" id="palette-results" role="listbox">
          {sections.map((section) => (
            <div key={section.id} className="palette-section" data-section={section.id}>
              <div className="menu-heading palette-section-heading">
                <span className="palette-section-name">{section.heading}</span>
                {section.branch && <span className="palette-section-branch">{section.branch}</span>}
                <span className="palette-section-count">{section.rows.length}</span>
              </div>
              {section.rows.map((row) => {
                const index = rowIndex;
                rowIndex += 1;
                if (row.kind === "plugin") {
                  const { offered } = row;
                  const key = pluginActionKey(offered);
                  const busy = running === key;
                  return (
                    <button key={key} id={`palette-item-${index}`} type="button" role="option" className={busy ? "menu-item palette-plugin-action is-running" : "menu-item palette-plugin-action"} title={offered.action.description ?? undefined} aria-selected={activeIndex === index} aria-busy={busy} aria-disabled={running !== null} onFocus={() => select(index)} onMouseMove={() => select(index)} onClick={() => void runPluginAction(offered)}>
                      {busy ? <LoaderCircle aria-hidden="true" /> : <Puzzle aria-hidden="true" />}
                      <span className="menu-item-main"><span className="palette-row-title">{offered.action.title}</span><span className="palette-row-subtitle">{busy ? t("Running…") : offered.plugin.name}</span></span>
                    </button>
                  );
                }
                if (row.kind === "action") {
                  const Icon = row.action.icon;
                  return <button key={row.action.id} id={`palette-item-${index}`} type="button" role="option" className="menu-item" aria-selected={activeIndex === index} onFocus={() => select(index)} onMouseMove={() => select(index)} onClick={() => runAction(row.action)}><Icon /><span className="menu-item-main">{row.action.label}</span><ShortcutHint shortcutId={row.action.shortcut} /></button>;
                }
                const { pane } = row;
                const workspace = workspaces.find((item) => item.workspace_id === pane.workspace_id);
                const folder = folderName(panePath(pane));
                const place = section.placeNamesWorkspace
                  ? placeLine(workspace?.label ?? t("Unknown workspace"), folder)
                  : placeLine(tabName(pane) ?? "", folder);
                const selected = pane.pane_id === selectedPaneId;
                return (
                  <button key={pane.pane_id} id={`palette-item-${index}`} type="button" role="option" className="menu-item palette-pane" aria-selected={activeIndex === index} aria-current={selected ? "true" : undefined} onFocus={() => select(index)} onMouseMove={() => select(index)} onClick={() => runPane(pane)}>
                    <span className="palette-mark"><AgentMark agent={pane.agent ?? "shell"} /></span>
                    <span className="menu-item-main"><span className="palette-row-title">{displayPaneTitle(pane)}{selected && <span className="palette-selected">{t("Selected")}</span>}</span><span className="palette-row-subtitle">{place}</span></span>
                    <StatusBadge status={paneStatus(pane)} />
                  </button>
                );
              })}
            </div>
          ))}
          {itemCount === 0 && <p className="palette-empty" role="status">{t("No matching panes or actions")}</p>}
        </div>
        <footer className="palette-footer">
          <div className="palette-footer-where" aria-live="polite">
            {footerPlace && <span className="palette-footer-place">{footerPlace}</span>}
            {footerPath && <span className="palette-footer-path" title={footerPath}>{footerPath}</span>}
          </div>
          <div className="palette-footer-keys" aria-hidden="true">
            <span className="palette-footer-key"><kbd className="kbd">←</kbd><kbd className="kbd">→</kbd>{t("Workspace")}</span>
            <span className="palette-footer-key"><kbd className="kbd">&gt;</kbd>{t("Actions")}</span>
          </div>
        </footer>
      </section>
    </div>
  );
}
