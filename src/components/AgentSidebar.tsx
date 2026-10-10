import { useCallback, useEffect, useId, useMemo, useState, type MouseEvent } from "react";
import { AtSign, ChevronDown, ChevronRight, Ellipsis, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { agentContext, agentTabName, paneMark, sidebarAgents } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { activityOrder } from "../lib/sidebarOrder.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentNameDialog } from "./AgentNameDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { BackgroundBadge, displayPaneTitle, onRowContextMenu, StatusBadge } from "./Sidebar.tsx";
import "./AgentSidebar.css";

interface AgentRowBodyProps {
  /** the agent's kind or name; null draws a terminal, for a shell */
  mark: string | null;
  title: string;
  /** the live name other tools address the agent by, when it has one */
  name: string | null;
  context: string;
  backgroundTasks?: number;
  status?: AgentStatus;
}

/**
 * One agent in a list: the coding agent's mark, what it is working on, who and where it is, and
 * how it is doing.
 */
function AgentRowBody({ mark, title, name, context, backgroundTasks, status }: AgentRowBodyProps) {
  return <>
    <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
    <span className="agent-copy">
      <span className="agent-title">{title}</span>
      {(name || context) && <span className="agent-context">
        {name && <span className="agent-name">{name}</span>}
        {name && context && " · "}
        {context}
      </span>}
    </span>
    <span className="agent-row-status"><BackgroundBadge count={backgroundTasks} /><StatusBadge status={status} compact /></span>
  </>;
}

export interface AgentSidebarProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  /** a PC's state in words, for the tooltip of a row whose PC is not connected */
  stateWord(machine: Machine): string;
  onSelect(machineId: string, paneId: string): void;
}

/** The row whose ⋯ menu is open, and what the dialog it opens needs to know. */
interface MenuState { anchor: HTMLElement; machineId: string; paneId: string; title: string; place: string; name: string | null }
interface NameDialogState { machineId: string; paneId: string; title: string; current: string | null }

/** the width under which the sidebar is a drawer (src/styles.css) */
const DRAWER_QUERY = "(max-width: 768px)";

/**
 * All PCs' live agents form a second list; workspace and PC folds do not hide these rows.
 * In the phone's drawer the list starts folded, leaving the room to the workspaces.
 */
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, onSelect }: AgentSidebarProps) {
  const t = useT();
  const listId = useId();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.(DRAWER_QUERY).matches === true);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const { settings } = useSettings();
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes)
  const byActivity = settings.agentOrder === "activity";
  const rows = useMemo(() => machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (byActivity ? activityOrder(agents, (entry) => entry.pane, activity.seqs(machine.id)) : agents).map((entry) => ({ machine, entry }));
  }), [machines, byActivity, activity]);

  // the roster moves under an open menu: a row that left takes its menu with it
  useEffect(() => {
    if (menu && !rows.some(({ machine, entry }) => machine.id === menu.machineId && entry.pane.pane_id === menu.paneId)) setMenu(null);
  }, [menu, rows]);

  // the one thing herdr lets another tool do to an agent by name: give it that name
  const menuItems = (state: MenuState): RowMenuItem[] => [
    { id: "agent-name", label: t("Agent name…"), icon: AtSign, run: () => {
      // read the current name at click time: another client may have renamed the agent since the menu opened
      const row = rows.find(({ machine, entry }) => machine.id === state.machineId && entry.pane.pane_id === state.paneId);
      setNameDialog({ machineId: state.machineId, paneId: state.paneId, title: state.title, current: row?.entry.agent?.name?.trim() || null });
    }},
  ];
  const closeMenu = useCallback(() => setMenu(null), []);

  return <section className={`agents-sidebar${collapsed ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {collapsed && rows.length > 0 && <span className="agent-section-count">{rows.length}</span>}
    </button>
    <div className="agent-list-contents" id={listId} hidden={collapsed}>
      {rows.length === 0 ? <p className="agent-empty" role="status">{t("No agents running")}</p> : <ul className="agent-list">
        {rows.map(({ machine, entry }) => {
          const { pane, workspace, tab, agent, agentLabel } = entry;
          const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
          const online = machine.state === "connected";
          const title = pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
          const name = agent?.name?.trim() || null;
          // the name has its own place on the line: the label beside it says the kind instead
          const kindLabel = name !== null && agentLabel === name ? entry.canonicalAgent ?? agent?.title?.trim() ?? null : agentLabel;
          const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
          const tabName = agentTabName(tab, tabs, t);
          const context = agentContext({ agentLabel: kindLabel, title, machineName: machines.length > 1 ? machine.name : null, workspaceLabel: workspace.label, tabName }).join(" · ");
          const tooltip = [...new Set([pane.pane_id, title, context, name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
          const menuOpen = menu?.machineId === machine.id && menu.paneId === pane.pane_id;
          const toggleMenu = (anchor: HTMLElement): void => setMenu(menuOpen ? null : { anchor, machineId: machine.id, paneId: pane.pane_id, title, place: context, name });
          const onContextMenu = (event: MouseEvent<HTMLElement>): void => { if (agent && online) onRowContextMenu(event, toggleMenu); };
          return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id} onContextMenu={onContextMenu}>
            <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)}>
              {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
              <AgentRowBody mark={paneMark(entry)} title={title} name={name} context={context} backgroundTasks={online ? pane.background_tasks : 0} status={online ? activity.status(machine.id, pane) : undefined} />
            </button>
            {/* only an agent herdr lists can be named: the bridge's own OmO recognition is not one yet */}
            {agent && <span className="agent-actions">
              <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title })} aria-haspopup="menu" aria-expanded={menuOpen} disabled={!online} onClick={(event) => toggleMenu(event.currentTarget)}>
                <Ellipsis aria-hidden="true" />
              </button>
            </span>}
          </li>;
        })}
      </ul>}
    </div>
    {menu && <RowMenu anchor={menu.anchor} title={menu.title} subtitle={menu.place} items={menuItems(menu)} onClose={closeMenu} />}
    {/* the dialog acts on the row's PC, which this list, spanning every PC, is not inside of */}
    {nameDialog && <MachineContext.Provider value={nameDialog.machineId}>
      <AgentNameDialog paneId={nameDialog.paneId} title={nameDialog.title} current={nameDialog.current} onClose={() => setNameDialog(null)} />
    </MachineContext.Provider>}
  </section>;
}
